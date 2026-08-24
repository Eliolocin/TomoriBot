---
title: Azure Application Logs
sidebar:
  order: 1
---

If you host TomoriBot on an Azure VM, you can ship the bot's structured error logs into an
Azure Log Analytics workspace and build Grafana error panels on top of them. This page covers
the whole pipeline: the bot-side JSONL file output, the Azure Monitor Agent ingestion, and the
operational rules that keep ingestion reliable and cheap.

For monitoring a local instance with Grafana instead, see
[Local Grafana Monitoring](/self-hosting/local-monitoring/).

:::note[TomoriBot's own deployment no longer runs this pipeline]
Everything below still works and is still supported. It is simply no longer what the reference
deployment does: the Azure Monitor Agent was removed once the bot began writing its cache and
process-memory samples straight into PostgreSQL, where Grafana already had a datasource. The reason
was memory rather than cost. The agent held roughly 179 MB of resident set on a host with 842 MB of
usable RAM, which is a fifth of the machine spent shipping telemetry.

Choose this pipeline if you want log *search* over structured error records, which a table of
counters cannot give you. Choose the database sink if your host is small, you already run Grafana
against your bot's database, and per-cache and per-memory series are what you actually graph. See
[Caching](/architecture/subsystems/caching/) for that design, and
[Azure Production Deployment](/architecture/cloud/azure-production-deployment/) for the removal.

The bot-side JSONL output in Step 1 is independent of the agent and is worth enabling either way: it
survives container recreate and VM reboot, and it keeps recording during the incidents that stop a
database write from landing.
:::

## Pipeline overview

```text
Pino structured logs (level >= 50 in production)
  -> /app/logs/tomoribot.jsonl in the container   (TOMORI_LOG_FILE)
  -> /var/log/tomoribot/tomoribot.jsonl on the VM (bind mount)
  -> Azure Monitor Agent "Custom Text Logs" data source
  -> Data collection rule (DCR) parses each RawData line with parse_json()
  -> Log Analytics custom table (e.g. TomoriBotLogs_CL)
  -> Grafana error panels
```

The DCR uses **Custom Text Logs**, not Custom JSON Logs. The file is UTF-8 JSONL, but
production error records contain nested `err` and `context` objects; collecting each line as a
single `RawData` string and parsing it inside the DCR transform is the reliable
Azure-supported route for nested JSON.

## Step 1: Enable the JSONL file output

Set `TOMORI_LOG_FILE` to a writable path inside the container:

```sh
TOMORI_LOG_FILE=/app/logs/tomoribot.jsonl
```

Behavior:

- Only active in JSON output mode (production, or any run without the `pino-pretty` dev
  transport). Development pretty-printing is unchanged and ignores the variable.
- Every emitted record is written to **both** stdout (so `docker logs` diagnostics keep
  working) and the file, as identical newline-delimited JSON, via an append-only synchronous
  stream.
- Production logs at level `error` (50) and above, which includes the custom levels
  `metric` (52) and `rateLimit` (55). An empty file on a healthy instance is normal.

### Container wiring

`deploy/azure/docker-compose.yml` sets the variable and bind-mounts the host directory over
the image's `/app/logs`:

```yaml
environment:
  TOMORI_LOG_FILE: /app/logs/tomoribot.jsonl
volumes:
  - /var/log/tomoribot:/app/logs
```

The container runs as the non-root user `tomori` (UID/GID 1001), so the host directory must
be owned by that ID. The Azure deploy workflow creates it before Compose starts:

```sh
sudo install -d -o 1001 -g 1001 -m 0750 /var/log/tomoribot
```

### Verifying the host file

After a deploy, on the VM:

```sh
sudo ls -la /var/log/tomoribot
sudo tail -n 3 /var/log/tomoribot/tomoribot.jsonl
```

Every nonempty line must be one valid JSON object. The file may legitimately be empty until
the first production error occurs.

## Step 2: Create the custom table

Create a custom table (this guide uses `TomoriBotLogs_CL`; the `_CL` suffix is required) in
your Log Analytics workspace with the Log Analytics Tables REST API
(`2021-12-01-preview`), using this schema:

| Column | Type | Purpose |
|---|---|---|
| `TimeGenerated` | DateTime | Original Pino event time, with ingestion time as fallback |
| `Computer` | String | Populated by Azure Monitor Agent |
| `FilePath` | String | Populated by Azure Monitor Agent |
| `level` | Int | Pino numeric level |
| `msg` | String | Pino log message |
| `code` | String | Top-level or nested error code |
| `errorType` | String | Error type/name (`type` is a reserved column name and is rejected) |
| `commandName` | String | Command context when available |
| `message` | String | Error message with `msg` fallback |
| `RawData` | String | Original JSON line for access-controlled troubleshooting |

Wait until the table appears in the workspace before creating the DCR.

## Step 3: Create and associate the DCR

Custom text log collection requires a **data collection endpoint** (DCE) in the same region;
create one first and reference it from the DCR. Then create the DCR (platform **Linux**),
associate it with the VM (installing Azure Monitor Agent if needed), and add a
**Custom Text Logs** data source:

- File pattern: `/var/log/tomoribot/tomoribot.jsonl`
- Table: `TomoriBotLogs_CL`
- Record delimiter: end-of-line (correct for JSONL)
- Destination: Azure Monitor Logs -> your workspace

Apply this ingestion-time transformation. Its projected columns must exactly match the table
schema. The trailing `where` clauses drop known-noisy records (periodic cache metrics and
provider availability retries) to control ingestion cost:

```kusto
source
| extend p = parse_json(RawData)
| extend EventTime = datetime(1970-01-01) + tolong(p["time"]) * 1ms
| extend TimeGenerated = iff(isnull(EventTime), TimeGenerated, EventTime)
| extend level = toint(p.level)
| extend msg = tostring(p.msg)
| extend code = iff(isempty(tostring(p.code)), tostring(p.err.code), tostring(p.code))
| extend errorType = iff(isempty(tostring(p.type)), tostring(p.err.name), tostring(p.type))
| extend message = iff(isempty(tostring(p.message)), iff(isempty(tostring(p.err.message)), tostring(p.msg), tostring(p.err.message)), tostring(p.message))
| extend commandName = iff(isempty(tostring(p.commandName)), tostring(p.context.commandName), tostring(p.commandName))
| where level >= 50
| where isempty(tostring(p.metric))
| where RawData !contains "UNAVAILABLE"
| where RawData !contains "RESOURCE_EXHAUSTED"
| project TimeGenerated, Computer, FilePath, level, msg, code, errorType, message, commandName, RawData
```

`isempty(tostring(p.metric))` excludes **every** `log.metric()` record, not just `cache_sizes`,
which keeps error-rate panels counting only genuine errors. Every metric therefore needs a
dataflow of its own or it is discarded at ingestion with no trace: Steps 5 and 6 below claim
`cache_sizes` and the remainder respectively, so all three filters stay disjoint.

DCR transformations compile against a restricted KQL subset, which shapes the query above:
`coalesce()` and `unixtime_milliseconds_todatetime()` are not available (hence the nested
`iff(isempty(...))` fallbacks and the epoch arithmetic), and `time` is a reserved keyword in
the transform parser, so the Pino timestamp field must be accessed as `p["time"]`.

### Terraform ownership of VM attachments

The existing workspace, DCE, DCR definitions, and custom tables remain external to Terraform, but
the production VM's `AzureMonitorLinuxAgent` extension and its VM Insights/application-log DCR
associations are Terraform-managed. Their complete, non-sensitive existing resource IDs are set in
`terraform/azure/terraform.ci.tfvars` and must be updated if either DCR is deliberately replaced.

This boundary is intentional: replacing the VM deletes its extensions and associations, while the
workspace and DCRs survive. The next Terraform apply therefore restores collection without
rewriting the existing streams, table schemas, or ingestion transforms. Do not re-create the
workspace or DCR definitions merely because a replacement VM has no incoming data.

## Step 4: Test ingestion end to end

Append a harmless synthetic level-50 record to the host file (do not manufacture a real bot
failure), wait roughly 5-10 minutes for initial ingestion, then query the workspace:

```kusto
TomoriBotLogs_CL
| where TimeGenerated > ago(30m)
| order by TimeGenerated desc
```

If nothing arrives, check: DCR-to-VM association, Azure Monitor Agent status on the VM, exact
file path and directory permissions, that each line is valid one-line UTF-8 JSON, DCR error
metrics, and that the transform's projected columns match the table schema exactly.

## Step 5: Cache-size metrics (second dataflow)

The logger emits a periodic `cache_sizes` sample (custom level 52, one line every
`CACHE_METRICS_INTERVAL_MS`, default 5 min) carrying every in-memory cache count plus process
RSS. The error dataflow above deliberately drops these (`msg != "metric:cache_sizes"`) so the
error table stays clean. To chart them, the same DCR carries a **second dataflow** that reads
the same file stream but keeps only cache samples and projects their numeric fields into a
dedicated table, `TomoriBotCacheMetrics_CL` (typed `int`/`real` columns for each cache plus
`rss_mb`/`rss_pct`). Two dataflows over one input stream is the supported pattern; their
`where` filters are disjoint, so no record is double-counted.

Second dataflow transform (abridged — one `toint(p.<field>)` per cache column):

```kusto
source
| where RawData contains "metric:cache_sizes"
| extend p = parse_json(RawData)
| extend TimeGenerated = datetime(1970-01-01) + tolong(p["time"]) * 1ms
| extend rss_mb = toreal(p.rss_mb), rss_pct = toreal(p.rss_pct)
| extend heap_used_mb = toreal(p.heap_used_mb), external_mb = toreal(p.external_mb) // ...
| extend shortTermMemory = toint(p.shortTermMemory), tomoriState = toint(p.tomoriState) // ...
| extend discord_users = toint(p.discord_users), discord_members = toint(p.discord_members) // ...
| project TimeGenerated, Computer, rss_mb, rss_pct, /* memory partition */, /* app caches */, /* discord.js caches */
```

Cost note: this reverses the original "drop cache_sizes to save ingestion" decision, but the
volume is tiny (~288 samples/day at ~900 bytes, so ~260 KB/day), well within the free tier.

`heap_used_mb`, `heap_total_mb`, `external_mb`, and `array_buffers_mb` partition the footprint
that the cache counts cannot explain. Native allocations, chiefly decoded bitmaps held by
libvips, live in `external`/`arrayBuffers` rather than in any counted cache, and `rss_mb`
understates the total whenever the kernel has swapped part of the heap out (`heap_used_mb`
exceeding `rss_mb` is the tell). Chart these before concluding that a cache is responsible for
a memory trend.

### Emitted fields are not the same as table columns

The transform projects a fixed column list, so a field the application emits is silently absent from
the table unless it was added to both the transform and the table schema. `discord_messages` is the
known case: `collectCacheMetricsSnapshot()` emits it, but it is **not** a column, and projecting it
fails the query with `SEM0100: 'project' operator: Failed to resolve scalar expression`.

Confirm the real column list before writing a panel query rather than inferring it from the emitter:

```powershell
az monitor log-analytics workspace table show -g <resource-group> --workspace-name <workspace-name> `
  -n TomoriBotCacheMetrics_CL --query "schema.columns[].name" -o tsv
```

`rss_limit_mb` **is** a column, which makes it the cheapest way to confirm a deployed memory-limit
change actually took effect. `rss_pct` works as a cross-check without any DCR change, since it is
RSS divided by that limit: the same resident set reads about 16% against a 1536 limit and about 48%
against 512.

## Step 6: Every other metric (third dataflow)

Dataflow 1 drops all `log.metric()` records and dataflow 2 keeps only `cache_sizes`, so any other
metric matches neither filter and is discarded at ingestion without warning. `emergency_cache_clear`,
`memory_forced_gc`, and `memory_emergency_entered` were lost this way: the memory guard was visibly
firing in `TomoriBotLogs_CL` while the records describing what the response actually reclaimed never
arrived.

A third dataflow claims the remainder into `TomoriBotMetrics_CL` (`TimeGenerated`, `Computer`,
`metric`, `RawData`). The filter is written against the `metric` field rather than a list of names,
so a metric added later is captured without a pipeline change:

```kusto
source
| extend p = parse_json(RawData)
| extend metric = tostring(p.metric)
| where isnotempty(metric) and metric != "cache_sizes"
| extend TimeGenerated = datetime(1970-01-01) + tolong(p["time"]) * 1ms
| project TimeGenerated, Computer, metric, RawData
```

Keeping `RawData` instead of typed columns is deliberate: these metrics carry different field sets
(`emergency_cache_clear` alone emits one `cleared_*` field per cache), and a fixed projection would
silently drop new ones exactly as before. Parse at query time with `parse_json(RawData)`.

Records dropped by a transform leave no trace in the workspace, but the agent reads a host file that
outlives the container, so history can still be recovered after fixing a filter:

```bash
grep -a "metric:emergency_cache_clear" /var/log/tomoribot/tomoribot.jsonl | tail -5
```

Ad-hoc queries can go through the REST API. The `log-analytics` az CLI extension currently has no
installable stable version, so `az monitor log-analytics query` may be unavailable:

```powershell
$wsid = az monitor log-analytics workspace show -g <resource-group> -n <workspace-name> --query customerId -o tsv
$uri = "https://api.loganalytics.io/v1/workspaces/$wsid/query?query=" + [uri]::EscapeDataString($q)
az rest --method get --url $uri --resource "https://api.loganalytics.io" -o json
```

Host-level memory forensics are **not** available here. Azure Monitor collects neither
`/proc/pressure/*` nor `vmstat` swap-in/swap-out rates, and the agent's `Available Memory Bytes` is
only a coarse proxy. Diagnosing swap thrash requires Run Command against the VM; see
[Azure Production Deployment](./azure-production-deployment/).

## Grafana

Point panels at an Azure Monitor data source whose identity has `Reader` on the resource group
and `Log Analytics Reader` on the workspace. That identity needs **read access only** —
ingestion permissions belong to the DCR/agent path, never to Grafana. Current panels:

- **Error count** (`Time series`) — `TomoriBotLogs_CL` counted per minute. `make-series`
  returns packed arrays, so append
  `| mv-expand TimeGenerated to typeof(datetime), Errors to typeof(long)` or the series will
  not render.
- **Error log** (`Logs`) — `TomoriBotLogs_CL` showing `TimeGenerated`, a title from
  `code`/`errorType` + `message`, `commandName`, and `RawData`.
- **Cache sizes** (`Time series`, stacked) — `TomoriBotCacheMetrics_CL`, one series per cache
  column, for spotting growth/leaks. Include `rss_mb`, `rss_pct`, and the `discord_*` columns.
  A panel projecting only the app-cache columns hides both the process memory the growth is being
  correlated against and the discord.js caches that usually hold most of it:

  ```kusto
  TomoriBotCacheMetrics_CL
  | where $__timeFilter(TimeGenerated)
  | project TimeGenerated, rss_mb, rss_pct, rss_limit_mb,
            discord_members, discord_users, discord_presences, discord_channels, discord_emojis,
            userCache, channelWhitelist, personalSpotlight, shortTermMemory
  | order by TimeGenerated asc
  ```

- **Memory guard events** (`Logs`) — `TomoriBotLogs_CL` filtered to the memory guard. An empty
  result does not prove health: it also matches a guard whose threshold sits above physical RAM and
  therefore can never fire. Correlate with `rss_limit_mb` before concluding anything.

  ```kusto
  TomoriBotLogs_CL
  | where TimeGenerated > ago(24h)
  | where RawData has_any ("Memory warning", "CRITICAL MEMORY", "memory_emergency_entered")
  | order by TimeGenerated desc
  ```
- **SearXNG sidecar availability** (`Logs`) — `TomoriBotLogs_CL` filtered to the availability
  transitions emitted by `searxngService.ts`.

  ```kusto
  TomoriBotLogs_CL
  | where TimeGenerated > ago(24h)
  | where errorType in ("SearxngUnavailable", "SearxngRecovered")
  | project TimeGenerated, errorType, message
  | order by TimeGenerated desc
  ```

  These exist because a sidecar that is merely *gone* is otherwise invisible here. The health probe
  logs at `warn`, which is below the level-50 threshold on the JSONL sink this table tails, and the
  dispatcher skips an unavailable engine silently on its way down the `Brave → SearXNG → DDG → IAsk`
  chain. Only the up-but-broken case (`searxng request failed with status …`) reaches the table on
  its own. The records are emitted on transition rather than per probe, so a 60s health cache cannot
  flood the table; the consequence is that a row means a *change*, and steady state produces nothing.

  Container restarts are **not** in this table at all under any query: SearXNG writes to Docker's
  `json-file` driver, while this table only tails the bot's own `TOMORI_LOG_FILE`. Read
  `RestartCount` through Run Command instead, as in
  [Azure Production Data Inspection](/wiki/azure-production-inspection/).

- **Token consumption** (`Time series`, stacked bars) — Postgres `stat_counters`,
  `SUM(count)` of `tokens_in`+`tokens_out` grouped by `bucket` (day) and `metric_key` (model).
  Daily grain only; the table stores no finer bucket.

The token panel uses Grafana's separate read-only PostgreSQL login over TLS `verify-full`; it must
not use the application runtime or administrator credential. Keep the Azure Monitor VM/error/cache
panels alongside the direct PostgreSQL statistics panels. The retired
`Custom-TomoriBotTokenMetrics_CL` DCR flow must not be recreated: PostgreSQL remains authoritative
for token, cost, and usage statistics.

Beware GCP-carryover panel state: legend-click "hide series" overrides and series-name color
rules reference the *old* query's series names and silently misfire on Azure queries (e.g. a
`byNames: ["tomoribot"]` exclude override blanks an Azure series named `value`).

## Operational rules

- **`RawData` is privileged troubleshooting data.** Access is limited to identities with Log
  Analytics read access, currently the designated operator/Grafana identity. It can contain error
  context after structured redaction, so do not publish it in GitHub Actions output or widen
  workspace roles. Retain it while nested context is needed; reconsider removing it only after
  parsed columns have proven sufficient.
- **Retention is 30 days.** Keep the workspace at the production 30-day retention baseline unless
  an explicit incident-response or cost decision changes it.

- **Keep the file append-only from the agent's point of view.** Do not add log rotation that
  renames files into a pattern the DCR's file glob still matches: Azure Monitor Agent treats a
  renamed file as new content and duplicates ingestion. Design retention so rotated files fall
  outside the collected pattern, and only after the pipeline is verified.

  Rotation now exists (`/etc/logrotate.d/tomoribot-jsonl`) and satisfies this two ways over. The
  DCR's file pattern is the literal path `/var/log/tomoribot/tomoribot.jsonl`, not a glob, so
  `tomoribot.jsonl.1` and `tomoribot.jsonl.2.gz` cannot match it. And the config uses
  `copytruncate`, which never renames the live file at all: it copies the contents aside and
  truncates the original in place, so the inode the agent is tailing survives. `copytruncate` is
  there for a different reason anyway, and that reason is not optional: pino holds the file open
  through `pino.destination({ append: true, sync: true })` and does not reopen on a signal, so a
  rename-based rotation would leave the bot writing into an unlinked inode until its next restart.
- **Cost control lives in the DCR transform.** Prefer adding `where` clauses there over
  widening what the bot writes; everything that passes the transform is billed ingestion.
- **stdout is unaffected.** `docker logs` keeps working regardless of `TOMORI_LOG_FILE`, so
  the file can be wiped or the variable removed without losing container diagnostics.
