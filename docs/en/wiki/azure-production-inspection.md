---
title: "Azure Production Data Inspection"
sidebar:
  label: "Production Data Inspection"
  hidden: true
aiGenerated: false
---

:::caution[Operator runbook]
This page targets the single TomoriBot production VM and its mounted secret file. The resource names
and container name below are literal, not placeholders, because this is a runbook rather than a
guide. Self-hosters should read
[Azure Production Deployment](/architecture/cloud/azure-production-deployment/) instead.
:::

Host lockdown removes every inbound NSG allow rule, so `ssh` cannot reach the VM and the PostgreSQL
firewall does not admit an operator workstation. Ad-hoc production queries therefore run **inside the
bot container, driven through VM Run Command**. This is the supported path for incident triage; do
not reopen SSH or widen the database firewall for it.

Credentials are not in the container environment: Compose mounts them as a JSON secret file at
`SECRET_FILE=/run/secrets/tomoribot.json`, so `docker exec … env` shows empty `POSTGRES_*`. Read them
from that file. The container root filesystem is read-only, so `docker cp` fails; pass the script on
stdin instead. Write the query as a local file, base64 it to survive Run Command's shell quoting, and
decode it into the host's `/tmp`:

```bash
# probe.js uses Bun.SQL directly: the app's own client.ts is not importable via `bun -e`
cat > probe.js <<'EOF'
const s = await Bun.file(process.env.SECRET_FILE).json();
const sql = new Bun.SQL({
  hostname: s.POSTGRES_HOST, port: Number(s.POSTGRES_PORT || 5432),
  username: s.POSTGRES_USER, password: s.POSTGRES_PASSWORD,
  database: s.POSTGRES_DB, tls: { rejectUnauthorized: true },
});
console.log(JSON.stringify(await sql`SELECT ...`, null, 2));
await sql.end();
EOF

B64=$(base64 -w0 probe.js)
printf 'echo %s | base64 -d > /tmp/probe.js\ndocker exec -i tomoribot-azure-tomoribot-1 bun -e "$(cat /tmp/probe.js)"\n' "$B64" > run.sh

az vm run-command invoke -g tomoribot-rg -n tomoribot-vm \
  --command-id RunShellScript --scripts @run.sh \
  --query "value[0].message" -o tsv
```

Notes that save a round trip:

- `tls: { rejectUnauthorized: true }` is required; a bare `tls: true` fails with
  `ERR_POSTGRES_CONNECTION_CLOSED`.
- `az` lives at `C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin` and may need adding to `PATH`
  inside a tool shell.
- The same wrapper reaches the Discord REST API using `s.DISCORD_TOKEN`, which is how a
  `channel_disc_id` or bot-authored message is resolved to a real channel or user during triage.
- Keep these scripts read-only. Route writes through a migration or an explicitly confirmed
  one-off, never through casual triage.

## Memory and cache telemetry: query `metric_samples`

The Azure Monitor Agent was removed once the bot began writing its own telemetry to PostgreSQL, so
`TomoriBotCacheMetrics_CL` and `TomoriBotLogs_CL` stopped receiving new rows. Triage now reads
`metric_samples` through the same `probe.js` wrapper above. Rows are pruned on the write path after
`METRIC_SAMPLE_RETENTION_DAYS` (30 by default).

`metric_name` is the leading column of `idx_metric_samples_name_time`, so every query must filter on
it or lose the index. There are two producers, both emitted every `CACHE_METRICS_INTERVAL_MS`
(5 min): `cache_sizes` for this process's caches and memory, and `host_memory` for the host's.

**Memory growth. Aggregate with `min()`, never `avg()`.** `external_mb` sawtooths roughly 250 MB
between GC cycles against daily growth under 100 MB, so an hourly mean reports which GC phase each
sample landed in rather than accumulation. The post-GC floor is the baseline that survives
collection:

```sql
SELECT date_trunc('hour', created_at) AS hr, count(*) AS n,
       min((fields->>'heap_used_mb')::float)     AS heap_floor,
       min((fields->>'external_mb')::float)      AS ext_floor,
       min((fields->>'array_buffers_mb')::float) AS ab_floor
  FROM metric_samples
 WHERE metric_name = 'cache_sizes' AND created_at > now() - interval '24 hours'
 GROUP BY 1 ORDER BY 1;
```

Fit only **full 12-sample hours**: a `min()` over a partial hour is biased high and tilts the slope
at whichever end it sits. Prefer `array_buffers_mb`, whose residual scatter is about 1.6 MB, over
`external_mb`, whose 95% confidence interval on a 10 h window spans zero. Splitting a window into
first and second halves distinguishes a bounded working set from a leak faster than any fit does: a
plateau is not a leak.

**Did the emitter stall?** Use gaps, not counts. A restart *adds* a sample rather than costing one,
because `cacheMetricsLogger.ts:214` emits before arming the interval, so a count cannot separate a
stall from a busy day:

```sql
SELECT created_at, created_at - lag(created_at) OVER (ORDER BY created_at) AS gap
  FROM metric_samples WHERE metric_name = 'cache_sizes'
 ORDER BY gap DESC NULLS LAST LIMIT 5;
```

Anything beyond ~5 min is a stall. Steady state runs 12.09 samples/hour.

**Cache entry counts**, which is the series that named the four lazy-expiry caches:

```sql
SELECT created_at,
       (fields->>'shortTermMemory')::int  AS "shortTermMemory",
       (fields->>'tomoriState')::int      AS "tomoriState",
       (fields->>'userCache')::int        AS "userCache",
       (fields->>'channelWhitelist')::int AS "channelWhitelist"
  FROM metric_samples
 WHERE metric_name = 'cache_sizes' AND created_at > now() - interval '6 hours'
 ORDER BY created_at;
```

Double-quote the camelCase aliases: Postgres folds unquoted identifiers to lowercase, and the output
would then disagree with the JSONB key names everything else refers to.

### Host memory and pressure: `host_memory`

The bot reads the host's own `/proc/meminfo`, `/proc/pressure/*`, `/proc/swaps`, `/proc/vmstat`, and
`/sys/block/zram0/mm_stat`. Docker does not virtualize those, so the container sees real host values
without a host-side agent, which is what makes this possible after the agent was removed.

Field names match the observer log's where they overlap, so a recipe written against one transfers.
The observer remains the finer record at 15 s and the only one that keeps writing when the bot
cannot reach Postgres; this series is the one that can be graphed and joined.

**Is the host paging to disk, or merely compressing?** The single most useful query here, because
zram and `/swapfile` differ by roughly 100x in fault cost and the aggregate hides which is which:

```sql
SELECT date_trunc('hour', created_at) AS hr,
       round(avg((fields->>'swapfile_used_mb')::float)::numeric, 1) AS swapfile_mb,
       round(avg((fields->>'zram_used_mb')::float)::numeric, 1)     AS zram_mb,
       round(avg((fields->>'zram_ratio')::float)::numeric, 2)       AS ratio,
       round(avg((fields->>'io_full_avg60')::float)::numeric, 2)    AS io_full60,
       round(avg((fields->>'host_avail_mb')::float)::numeric, 0)    AS avail_mb
  FROM metric_samples
 WHERE metric_name = 'host_memory' AND created_at > now() - interval '24 hours'
 GROUP BY 1 ORDER BY 1;
```

A rising `swapfile_used_mb` is the expensive case. A high `zram_used_mb` at a healthy `zram_ratio`
is the cheap one, and `swapon --show` cannot tell them apart because it reports uncompressed size.

**Swap-in rate, which levels cannot answer.** `swap_in_per_s`, `swap_out_per_s`, and
`major_faults_per_s` are already differenced from `/proc/vmstat`'s cumulative counters, so they are
read directly rather than with `lag()`. A large swap *used* with a near-zero swap-in rate is cold
pages evicted once and never needed again, which is harmless; sustained nonzero swap-in means the
working set is genuinely oversubscribed:

```sql
SELECT created_at,
       (fields->>'swap_in_per_s')::float      AS swap_in,
       (fields->>'major_faults_per_s')::float AS majflt,
       (fields->>'mem_full_avg60')::float     AS mem_full60
  FROM metric_samples
 WHERE metric_name = 'host_memory' AND created_at > now() - interval '6 hours'
 ORDER BY created_at;
```

The first sample after a container start carries no rate fields, because a rate needs a predecessor.
Rates are also dropped rather than reported negative when the counters restart at a host reboot.

### Pool retirement cascades: the `pool_*` fields

Connection-pool retirements ride the same `host_memory` sample, so a cascade can be read against
swap and PSI without joining anything. This is the first query to run when the bot is green on
Discord and answering nothing:

```sql
SELECT date_trunc('hour', created_at) AS hr,
       sum((fields->>'pool_errors_5m')::int)             AS errors,
       sum((fields->>'pool_lifetime_5m')::int)           AS lifetime,
       sum((fields->>'pool_idle_5m')::int)               AS idle,
       sum((fields->>'pool_retries_recovered_5m')::int)  AS recovered,
       sum((fields->>'pool_retries_exhausted_5m')::int)  AS exhausted,
       round(avg((fields->>'swap_in_per_s')::float)::numeric, 0) AS swap_in
  FROM metric_samples
 WHERE metric_name = 'host_memory' AND created_at > now() - interval '24 hours'
 GROUP BY 1 ORDER BY 1;
```

Read `recovered` against `exhausted`, not `errors` alone. Retirements are expected at some rate and
are harmless when retries absorb them; only the exhausted ones reach a user. A rising `exhausted`
with a flat `recovered` means the retry budget is too small for the episode length, which is a
`POSTGRES_TRANSIENT_RETRY_ATTEMPTS` decision rather than a pool-timeout one.

`pool_last_lifetime_phase_s` answers whether connections share a birthday. Bun exposes no
per-connection age, so this folds process uptime into `POSTGRES_MAX_LIFETIME_SECONDS`. Values
clustering near one phase across many episodes confirm a synchronised cohort and make raising the
lifetime worthwhile; a scattered distribution means age is not the driver and the effort belongs
elsewhere. `-1` means no lifetime retirement occurred in that interval, which is distinct from a
retirement that happened to land on phase zero.

The JSONL carries one `metric:pool_event` line per episode with the code, operation name, attempt
number, and the same phase. Grep it to date an episode precisely:

```sh
grep '"metric":"pool_event"' /var/log/tomoribot/tomoribot.jsonl | tail -20
```

**The JSONL is rotated now, so a single-file grep only sees today.** `/etc/logrotate.d/tomoribot-jsonl`
keeps 14 daily rotations, and `delaycompress` leaves yesterday uncompressed. Any incident older than
this midnight needs the rotations too:

```sh
zgrep -h '"metric":"pool_event"' /var/log/tomoribot/tomoribot.jsonl* | tail -40
```

`zgrep -h` reads plain and gzipped files alike, so the same line works whichever side of the
compression boundary the episode fell on. The same applies to `/var/log/oom-observer.log*`, which the
detector replay reads.

A `metric:metric_sink_failure` line means the sample writer itself could not reach the database.
Treat a gap in `metric_samples` with no such line as unexplained rather than assumed.

### Reading it as a graph instead

`docker/grafana/dashboards/tomoribot-overview.json` carries three panels for this, on the row
directly under the host memory and pressure panels so they share a time axis: **Pool Retirements by
Code**, **Pool Retry Outcome**, and **Lifetime Retirement Phase**. Grafana runs on the operator
workstation (`docker compose -f docker-compose.yaml -f docker/compose.monitor.yaml up`), not on the
VM, so the dashboard is provisioned from that file and new panels appear on a local Grafana restart
rather than through a deploy.

Reaching the production database from there depends on the `allow-grafana-operator` firewall rule,
whose address comes from the `GRAFANA_EGRESS_IP` environment secret via `postgres.tf`. When Grafana
reports it cannot connect, the cause is almost always an ISP address rotation: update the secret,
not just the Azure rule, because the next `terraform apply` reverts a direct edit.

**Errors** are in `error_logs`, but never size an incident from it. Insert failures are swallowed by
design (`logger.ts:323-325`), so it under-records during exactly the pool-timeout incidents it exists
to capture: one incident produced 2,775 level-50 lines in the host JSONL and about 21 rows here. The
JSONL is the witness; the table is useful for the error-type *mix*, not the volume.

### The Log Analytics path is historical

`api.loganalytics.io` still answers for data already ingested, up to the workspace retention window,
so the recipe below stays useful for looking backwards. It will not show anything newer than the
agent removal.

```bash
TOKEN=$(az account get-access-token --resource https://api.loganalytics.io --query accessToken -o tsv)
curl -s -X POST "https://api.loganalytics.io/v1/workspaces/c29999d0-e1bf-47c7-bfe2-dbfddc476b53/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"TomoriBotCacheMetrics_CL | where TimeGenerated > ago(24h) | summarize n=count()"}'
```

The `log-analytics` CLI extension has no stable version and will not install, so
`az monitor log-analytics query` fails outright. REST is the only route.

## Host memory and swap forensics

Azure Monitor collects neither `/proc/pressure/*` nor `vmstat` swap rates, and
`process.memoryUsage().rss` counts only resident pages, so it understates commitment on a swapping
host. Diagnosing memory pressure therefore needs the same Run Command path. Write `mem-triage.sh`:

```sh
echo "=== HOST MEMORY ==="; free -m
echo "=== SWAP ACTIVITY (si/so nonzero = active thrash) ==="; vmstat 2 5
echo "=== PSI MEMORY ==="; cat /proc/pressure/memory
echo "=== PER-PROCESS SWAP (top 5) ==="
for p in /proc/[0-9]*; do s=$(awk '/VmSwap/{print $2}' $p/status 2>/dev/null); n=$(cat $p/comm 2>/dev/null); [ -n "$s" ] && [ "$s" != "0" ] && echo "$s $n"; done | sort -rn | head -5
echo "=== CONTAINERS ==="; docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}'
echo "=== EFFECTIVE LIMIT ==="; docker inspect $(docker ps -q --filter name=tomoribot) --format 'mem_limit={{.HostConfig.Memory}}'
```

```bash
az vm run-command invoke -g tomoribot-rg -n tomoribot-vm \
  --command-id RunShellScript --scripts @mem-triage.sh \
  --query "value[0].message" -o tsv
```

Read `si`/`so` rather than swap *used*: a large `swpd` with zero `si`/`so` is cold pages evicted once
and never needed again, which is harmless. Sustained nonzero `si` means the working set is genuinely
oversubscribed. `/proc/pressure/memory` confirms it independently by measuring stall time, where
`full` is the share of wall time every task was blocked.

Three narrower probes answer questions the above cannot. **zram's real compression ratio**, since
`swapon --show` reports the uncompressed size and hides how much RAM the device actually holds:

```sh
cat /sys/block/zram0/mm_stat   # orig_data_size compr_data_size mem_used_total ...
```

**The bot process's own split between resident and swapped pages.** Select on `comm`, because
`pgrep -f bun` matches `docker-init` instead:

```sh
for p in /proc/[0-9]*; do [ "$(cat $p/comm 2>/dev/null)" = "bun" ] && \
  grep -E "VmRSS|RssAnon|VmSwap" $p/status; done
```

**True cgroup commitment, which RSS hides.** `memory.events` is the authority on whether anything was
actually killed, so it settles "was this an OOM" in one reading:

```sh
C=$(docker inspect -f "{{.Id}}" tomoribot-azure-tomoribot-1); B=/sys/fs/cgroup/system.slice/docker-$C.scope
echo "current=$(cat $B/memory.current) swap=$(cat $B/memory.swap.current) swapmax=$(cat $B/memory.swap.max)"
cat $B/memory.events
```

**A working-set number is meaningless without container uptime beside it.** The same host reads
roughly half as much swap right after a restart as it does days later, so always pair these with
`docker inspect -f '{{.State.StartedAt}}'`.

### The observer is the during-incident record, and it is the only one

`tomoribot-oom-observer.service` samples the host every 15 s to `/var/log/oom-observer.log`. It
records only; it never kills anything. **It is the primary source for any incident that has already
happened**, because every other pipeline fails exactly when it is needed: the bot's own metrics stop
when the bot stalls, and a shipping agent stops when the host starves. The `host_memory` producer
above now carries the same host counters into SQL at 5 min resolution, but it stops with the bot, so
the observer stays the during-incident record and the only one with 15 s granularity.

```sh
tail -5 /var/log/oom-observer.log
systemctl is-active tomoribot-oom-observer     # the unit name has the tomoribot- prefix
```

Each line is flat `key=value`:

| Field | Meaning |
|---|---|
| `avail_mb`, `cache_mb` | host available memory and page cache. **Both collapsing together is the reclaim-livelock signature** |
| `mem_some`, `mem_full`, `io_full` | PSI, as `avg10/avg60/avg300`. `io_full` is the one that tracked every incident |
| `majflt`, `allocstall` | cumulative counters, so read them as differences between lines, never as levels |
| `zram_ram_mb`, `zram_orig_mb` | real RAM held against uncompressed bytes stored, so their ratio is the live compression ratio |
| `cg_mb`, `cg_swap_mb` | container memory and swap. **`cg_swap_mb` is the number that predicts the swap-depth freeze**, not `cg_mb` |
| `restarts`, `health`, `hz`, `hz_ms` | container restart count, Docker health, and `/healthz` status with latency |

Read `hz_ms` rather than a one-off `curl`: a single fast probe says nothing, while a rising `hz_ms`
across many samples is the earliest warning this host gives.

### Confirm zram survived, after every reboot

An unattended kernel upgrade takes zram with it whenever the running kernel has no matching
`linux-modules-extra`. Nothing reports this: swap still works because `/swapfile` is mounted as the
overflow tier, containers stay healthy, and free memory looks *better* than usual because the
compressed pool is no longer holding RAM. Check it explicitly rather than waiting for it to surface:

```sh
swapon --show                             # /dev/zram0 missing is the finding
uname -r; dpkg -l | grep linux-modules-extra
systemctl status systemd-zram-setup@zram0.service --no-pager | head -6
```

A version mismatch between `uname -r` and the installed `linux-modules-extra-<version>-azure`, plus
`Dependency failed` retrying on a timer, is the confirmed signature.

**The repair below is a write, not triage.** It installs a package and loads a kernel module on the
production host, so it is an explicitly confirmed one-off under the read-only rule above: get
agreement first, then run it through `az vm run-command` like everything else, since no SSH exists.
No reboot is required once the module matches the running kernel.

```sh
apt-get install -y linux-modules-extra-azure || apt-get install -y "linux-modules-extra-$(uname -r)"
modprobe zram && systemctl start systemd-zram-setup@zram0.service
swapon --show   # expect /dev/zram0 back at priority 100, above /swapfile
```

The versioned fallback matters when a newer kernel has reached the archive but the host has not
rebooted into it: the meta-package then resolves modules-extra ahead of the running kernel and
`modprobe` still fails.

`terraform/azure/cloud-init.yaml` installs the meta-package so a rebuilt VM does not regress, but a
host provisioned before that change stays broken until repaired by hand.

## Triaging a frozen bot (unresponsive, or fully offline)

### Slow, not frozen? Ask which path is slow

**If messages answer slowly but slash commands stay snappy, stop and read this before the freeze
triage below.** That asymmetry is diagnostic and it rules out most of what follows.

Both paths share the database, so a database or pool fault degrades them *together*. What they do
not share is size: a slash command runs a few reads and replies, while a chat turn walks context
build, history, the provider call and streaming, touching a far larger working set. When every touch
risks a major fault, the heavy path stretches to tens of seconds while the light one hides its extra
few hundred milliseconds inside Discord's "thinking" indicator.

So message-only slowness points at **per-fault cost**, not at the database. The usual cause is zram
saturation:

```sh
swapon --show   # /dev/zram0 USED at or near SIZE means every further page goes to disk
```

Once the compressed device is full, overflow lands on `/swapfile` and each fault costs milliseconds
instead of microseconds. The fault *rate* need not have changed at all, which is why counters like
`majflt/s` can look unremarkable while latency triples. Confirm with `/healthz` latency over time
rather than a single probe, and check that the database is genuinely idle before suspecting it:

```sh
grep -c "Idle timeout reached" /var/log/tomoribot/tomoribot.jsonl
```

Few or no recent entries alongside slow messages means this class, not the swap-depth freeze.

### Separate the two causes first

**Two unrelated failures both present as "green in Discord, ignoring everything", and they need
different fixes.** Available memory separates them in a single reading, so take it before anything
else:

| Signal | Swap-depth freeze | Reclaim livelock |
|---|---|---|
| Available memory | **oscillating** across a wide band | **pinned flat** in a narrow band |
| Disk queue depth | single digits | sustained in the hundreds |
| Run Command / guest agent | responsive | hangs, agent `Not Ready` |
| Dominant log line | `Idle timeout reached after 30s` | nothing at all |
| Fix | `docker restart -t 30` | `az vm restart` |

The **swap-depth freeze** is the common one. The working set sinks into swap as uptime grows until
major-fault stalls hold handlers long enough for Bun's SQL pool to retire their queries on its idle
timeout; every database-touching handler then fails at once. Two readings look like exonerating
evidence and are not:

- **`/healthz` returns 200 throughout**, and its `eventLoop.stalenessMs` stays normal during this
  class, which is what separates it from CPU starvation further down. `healthTracker` only asserts
  that the Discord client is ready, so a healthy 200 and a completely unresponsive bot are compatible
  states. It is on host port **8081**, not 3000 or 8080; a `code=000` returned in under a millisecond
  is connection-refused, not a hang.
- **The gateway stays green,** because its heartbeat is independent of handlers. Expect
  `connected: true` with a normal ping during the freeze.

Confirm it with the error mix rather than the symptom:

```sh
grep -c "Idle timeout reached" /var/log/tomoribot/tomoribot.jsonl
```

A large count arriving inside one or two minutes is a pool-wide retirement, which means host
pressure. Check the database itself before suspecting it: during one of these the server sat at
single-digit connections and near-zero IOPS, so the fault is entirely client-side.

Then check swap depth against uptime, which is what actually predicts this failure:

```sh
docker inspect -f '{{.State.StartedAt}}' tomoribot-azure-tomoribot-1
C=$(docker inspect -f "{{.Id}}" tomoribot-azure-tomoribot-1)
echo $(( $(cat /sys/fs/cgroup/system.slice/docker-$C.scope/memory.swap.current) / 1048576 ))MB
```

**A working-set number is meaningless without the uptime beside it.** The same host reads roughly
half as much swap immediately after a restart as it does days later.

### Capturing a heap snapshot: RETIRED, do not do this

> **The method is retired. Do not take a heap snapshot on a memory-constrained host, on a larger
> one, or on any other.** It was attempted twice and caused an outage both times. What follows is
> the reasoning, so it is not rediscovered, rather than a procedure to follow.

`cache_sizes` counts cache *entries*, so it can name a cache that grows without telling you how many
bytes it holds, and it does not decompose `external`/`array_buffers` at all. A heap snapshot is the
only way to attribute those directly, which is why it keeps looking worth the risk. It is not.

**On a constrained host it does not finish.** The snapshot serializes a large fraction of the live
heap as a single string, so peak allocation roughly doubles at the worst possible moment. It can
collapse page cache, starve the guest agent to `Not Ready` so Run Command stops responding, and leave
`az vm restart` as the only remaining lever, all without writing a file.

**Giving it more memory does not make it safe, and that is the finding that retires the method.** On
a host with ample headroom the snapshot completes and writes its files, and **still leaves the main
thread spinning at 100% of a core indefinitely.** The container stays `healthy` and `/healthz` keeps
returning 200 while nothing is served, so it fails silently until someone looks. There is therefore
no host size on which this is acceptable.

**That failure is also its own diagnostic class, and it is the one nothing else explains.** If the
bot is unresponsive with **no memory pressure at all**, do not work through the swap table above:

| Signal | Swap-depth freeze | Reclaim livelock | **CPU starvation** |
|---|---|---|---|
| Memory pressure | high | extreme | **none** |
| CPU | normal | low, all iowait | **one core pinned at 100%** |
| `/healthz` | 200 | times out | **200, fast** |
| `eventLoop.stalenessMs` | normal | n/a, no response | **far above the sample interval** |
| Cause | uptime in swap | file-backed reclaim | **a heap snapshot, or any long synchronous main-thread job** |

`eventLoop` is the field that makes this class visible at all, and it is the reason to read the
`/healthz` body rather than just its status code:

```sh
curl -s http://127.0.0.1:8081/healthz | jq .eventLoop
```

`stalenessMs` is milliseconds since a timer callback last ran, so healthy readings sit between zero
and one `sampleIntervalMs`. A large value means callbacks are not being scheduled while the endpoint
still answers, which is precisely the starvation signature: a loop that yields between chunks of work
serves a short probe in milliseconds while multi-step handlers behind it make no progress. A loop
blocked outright returns nothing at all, so that case appears as a probe timeout instead.

**It is reported, never enforced.** Staleness deliberately does not affect the 200/503 verdict,
because the Compose healthcheck runs `curl -f` and a threshold nobody has calibrated would start
marking the container unhealthy. For the longer history, `event_loop_peak_lag_ms` in `metric_samples`
carries the worst lag per five-minute interval rather than an instantaneous reading, so a stall
lasting seconds cannot fall between samples.

Reach for the cheaper attributions instead, all of which answer most of what a snapshot would without
touching the main thread: cache entry counts, the `metric_samples` memory series described above, and
the observer's `cg_swap` curve across a restart.

**Taking one is not free**, and on a memory-constrained host it is closer to unusable than to
expensive. The snapshot serializes a large fraction of the live heap as a single string, so peak
allocation roughly doubles at the worst possible moment, and with headroom the *serialization itself*
is what never gives the thread back.

`HEAP_SNAPSHOT_DIR` is still set in the Azure compose file and the `SIGUSR2` handler is still armed,
so the capability has not been removed from the code. Treat that as a loaded footgun rather than as
permission: **the signal is deliberately not documented here.** If a future change genuinely needs
heap attribution, move the serialization off the main thread first and prove it on a throwaway host,
because that is the defect, not the host size.

One recovery note worth keeping, since it applies to any guest-agent starvation: if
`instanceView.vmAgent.statuses[0]` reads `Not Ready`, Run Command is gone and `az vm restart` is the
only lever left. Note the `instanceView.` prefix, because querying `vmAgent` at the object root
silently returns `null`, which looks identical to a dead agent.

### Scheduled restarts are routine

`tomoribot-restart.timer` recycles the container daily to bound that growth, so **a container whose
uptime resets on a daily boundary is the timer working, not an incident**. Check what it did with
`journalctl -u tomoribot-restart.service`; it logs swap depth before and after each run, and it skips
containers younger than six hours.

**It also recycles searxng and the Azure Monitor agent, and those are not subject to the six-hour
gate.** They grow with host uptime rather than container age, so a run that logs
`skipping bot restart` has still done useful work. Expect `recycled searxng` and
`recycled azuremonitoragent` on every firing, with `host_swap_before` / `host_swap_after` bracketing
the whole unit.

The bot is deliberately restarted last, so its cold start (the most allocation-heavy moment in the
cycle) runs with the co-tenants' memory already reclaimed.

**A co-tenant failure fails the unit but does not skip the bot.** `WARNING: failed to recycle ...` in
the journal with a non-zero unit result means the bot was still recycled and something else needs
attention. That distinction matters because a monitoring agent that silently stopped shipping has
happened here before, and an unattended job must not hide it.

This does **not** blunt the kill-loop discriminator in step 1: `docker restart` does not increment
`RestartCount`, since only restart-*policy* restarts do. `RestartCount` climbing therefore still
means something is killing the process. Use `.State.StartedAt` to spot scheduled restarts.

### If it is the livelock

That failure has presented two ways, so do not let the symptom narrow the diagnosis:

| Presentation | Meaning |
|---|---|
| Online in Discord, ignoring every command | Starved but still servicing the gateway heartbeat |
| **Completely offline in Discord** | Starved deeper and longer, so the heartbeat missed and Discord dropped the connection |

Offline therefore does **not** imply the process died. Confirm with step 1 rather than assuming.

Run these in order. Each one invalidates the next if it fails, and the first two are cheap.

**0. Can you still reach the guest at all?** Deep enough starvation takes out the Azure guest agent,
which is the only in-guest access path. If `az vm run-command invoke` hangs past a couple of minutes:

```bash
az vm get-instance-view -g tomoribot-rg -n tomoribot-vm \
  --query "{power:instanceView.statuses[?starts_with(code,'PowerState')].displayStatus|[0], \
            agent:instanceView.vmAgent.statuses[0].displayStatus}" -o json
```

`agent: "Not Ready"` with `power: "VM running"` means Run Command cannot be delivered, so
`docker restart` is unavailable and the only lever left is a control-plane reboot, which does not
need the guest agent:

```bash
az vm restart -g tomoribot-rg -n tomoribot-vm
```

This loses no forensics: the observer log, `tomoribot.jsonl`, and journald are all on persistent disk.
Prefer `docker restart tomoribot-azure-tomoribot-1` whenever the guest still answers, since it is far
faster and avoids the `swapoff` OOM that zram teardown causes on shutdown.

**1. Was anything actually killed?** A restarted process and a hung process need opposite fixes.

```sh
docker inspect $(docker ps -q) --format '{{.Name}} restarts={{.RestartCount}} oom={{.State.OOMKilled}}'
journalctl -b -1 -k --no-pager | grep -iE "out of memory|killed process|oom-kill"
```

`restarts=0` with `oom=false` and no kernel OOM line means the process never died. Note that a
`swapoff` victim dated to the moment of a reboot is an artifact of that reboot tearing down zram, not
evidence about the incident. If the host was rebooted, `-b -1` is the boot that matters.

**2. Find the gap in a heartbeat metric.** `cache_sizes` emits every 5 minutes at level 52, so a
missing run of samples bounds the freeze far more precisely than any error log. The host file
outlives containers, and `hostname` is the container ID, which separates process generations across a
restart:

```sh
awk '/metric:cache_sizes/{
  if (match($0, /"time":[0-9]+/)) { t=int(substr($0, RSTART+7, RLENGTH-7)/1000) } else next;
  sod = t % 86400;
  m="?"; if (match($0, /"hostname":"[a-z0-9]+"/)) m=substr($0,RSTART+12,RLENGTH-13);
  printf "%02d:%02d ctr=%s\n", int(sod/3600), int((sod%3600)/60), m;
}' /var/log/tomoribot/tomoribot.jsonl | tail -40
```

Same container ID on both sides of a gap means one process stopped running its timers rather than
dying. `mawk` has no `strftime`, hence the manual UTC arithmetic.

**3. Ask the platform what stalled.** Guest metrics are gone once the VM reboots, but Azure keeps
these. Query the freeze window at `PT15M`:

```bash
for M in "Percentage CPU" "CPU Credits Remaining" "OS Disk Queue Depth" "OS Disk Latency" \
         "OS Disk Read Operations/Sec" "OS Disk Write Operations/Sec" "Available Memory Bytes"; do
  az monitor metrics list --resource tomoribot-vm --resource-group tomoribot-rg \
    --resource-type Microsoft.Compute/virtualMachines --metrics "$M" \
    --start-time <start>Z --end-time <end>Z --interval PT15M --aggregation Average -o table
done
```

`az monitor metrics list` rejects a full resource ID in the installed extension; pass the
name/group/type triple instead. Interpretation:

| Pattern | Meaning |
|---|---|
| Queue depth and latency spike, CPU flat, credits untouched | Storage stall, not compute. Not a burstable throttle. |
| Reads climb while writes fall | Clean file-backed reclaim thrash, so the binary's own text is being evicted and re-faulted. |
| Available memory pinned flat for the whole window | Reclaim equilibrium. The OOM killer will not fire, because reclaim keeps succeeding. |
| Burst IO credits at 0% | Rules out disk throttling as the cause. |
| The series simply **ends** mid-incident | The guest agent starved too. Read it as evidence of severity, not as an absence of events. |

Use `PT1M` rather than `PT15M` once the window is known. A transient dip that recovers unaided can
precede the real decline by only a few minutes, and a 15-minute average blurs the two into a single
slope, erasing exactly the distinction a dwell-based trigger depends on. Note also that a 5-minute
series can lag its final buckets by longer than a 1-minute series, so an apparent cutoff at `PT5M`
may just be an unclosed bucket rather than a stalled agent.

A flat memory plateau with a storage stall and no kill is the zram livelock described in
[Azure Production Deployment](/architecture/cloud/azure-production-deployment/). **There is currently
no automatic recovery from it**, so clearing one means restarting the container or the VM by hand.

Before concluding a freeze is that livelock, rule out the opposite failure. A restart *loop* also
presents as an unresponsive bot, and the two need opposite responses:

```sh
docker inspect tomoribot-azure-tomoribot-1 --format 'restarts={{.RestartCount}} health={{.State.Health.Status}}'
systemctl is-active earlyoom systemd-oomd
```

A climbing `RestartCount` means something is killing the process, not that it is hung. An OOM daemon
configured against instantaneous `MemAvailable` will do exactly this on a host this small, because a
warming cache dips into the same range a livelock sits in; see the deployment page for why that
approach was reverted.
