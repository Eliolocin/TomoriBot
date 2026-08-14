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
# probe.js — uses Bun.SQL directly; the app's own client.ts is not importable via `bun -e`
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

- **`/healthz` returns 200 throughout.** `healthTracker` only asserts that the Discord client is
  ready, so a healthy 200 and a completely unresponsive bot are compatible states. It is on host port
  **8081**, not 3000 or 8080; a `code=000` returned in under a millisecond is connection-refused, not
  a hang.
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

### Capturing a heap snapshot

`cache_sizes` counts cache *entries*, so it can name a cache that grows without telling you how many
bytes it holds, and it does not decompose `external`/`array_buffers` at all. A heap snapshot is the
only way to attribute those. `HEAP_SNAPSHOT_DIR` is set in the Azure compose file, so the handler is
already armed; nothing is written until you signal it.

**Taking one is not free.** The snapshot serializes to roughly a fifth to a half of the live heap as
a single string, which on this host is a real allocation spike. Take one at moderate uptime rather
than at maximum depth, prefer the quiet hour, and restart the container afterwards.

Signal the bot process directly from the host. The container's PID 1 is `docker-init`, so signalling
the container would rely on forwarding; the host sees the real process:

```sh
for p in /proc/[0-9]*; do [ "$(cat $p/comm 2>/dev/null)" = "bun" ] && kill -USR2 "${p#/proc/}"; done
ls -la /var/log/tomoribot/*.heapsnapshot
```

Completion is recorded as a `heap_snapshot` metric carrying the byte count and duration, so it lands
in `TomoriBotLogs_CL` as well as the host JSONL.

**Analyse it off-host.** The file is far too large for Run Command's output cap, and parsing it in
place would reproduce the exact memory pressure under investigation. Push it to blob storage with a
SAS URL and open it locally in Chrome DevTools, which has a Comparison view built for diffing two
snapshots:

```sh
curl -X PUT -H "x-ms-blob-type: BlockBlob" \
  --data-binary @/var/log/tomoribot/<file>.heapsnapshot "<sas-url>"
rm /var/log/tomoribot/<file>.heapsnapshot
```

Two snapshots taken hours apart and diffed by retained size are what identify the growing retainer;
a single snapshot shows what is large, which is not the same question as what is growing.

### Scheduled restarts are routine

`tomoribot-restart.timer` recycles the container daily to bound that growth, so **a container whose
uptime resets on a daily boundary is the timer working, not an incident**. Check what it did with
`journalctl -u tomoribot-restart.service`; it logs swap depth before and after each run, and it skips
containers younger than six hours.

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
