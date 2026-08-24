---
title: "Azure Production Deployment"
sidebar:
  label: "Production Deployment"
  order: 1
---

TomoriBot's production deployment is a singleton Azure VM managed by Terraform. GitHub Actions
authenticates to Azure with an environment-scoped OpenID Connect (OIDC) token and deploys through
Azure VM Run Command. The VM exposes no public inbound service; its static public IP exists only as
a low-cost outbound SNAT path.

## Trust boundary

The protected `production` GitHub environment accepts only the `release` branch. The Azure
workflow has `contents: read` by default, grants `id-token: write` only to
`deploy-with-terraform`, and grants `contents: write` only to the release-creation job. The Azure
federated credential subject must be exactly:

```text
repo:Bredrumb/TomoriBot:environment:production
```

The GitHub deployment principal needs `Contributor` only on the deployment resource group and
`Storage Blob Data Contributor` only on the `tfstate` container. It must not retain subscription
`Contributor`, `Owner`, `User Access Administrator`, or unrelated resource-group roles after the
replacement workflow is proven.

Store these Azure-only values in the `production` environment, not as repository secrets:

- `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID`
- `AZURE_POSTGRES_ADMIN_PASSWORD`
- `AZURE_VM_SSH_PUBLIC_KEY` (a provisioning-only public key; CI has no private key)
- `TOMORI_SECRETS_JSON`
- `GRAFANA_EGRESS_IP` as an environment variable

If the first cutover finds that the existing `TOMORI_SECRETS_JSON` still contains the PostgreSQL
administrator login, create a temporary `AZURE_POSTGRES_RUNTIME_PASSWORD` environment secret with
a new random value of at least 32 characters. The payload step overlays only `POSTGRES_USER` and
`POSTGRES_PASSWORD`, persists the complete corrected JSON back to `TOMORI_SECRETS_JSON`, and uses
that same bundle for bootstrap and deployment. Delete `AZURE_POSTGRES_RUNTIME_PASSWORD` after the
successful cutover. This recovery path preserves every unrelated application credential without
making the write-only GitHub secret visible. A preflight checks the source bundle and migration
credential before Terraform planning or apply, so configuration errors cannot mutate Azure first.

The first merge to `release` starts the deployment workflow immediately, before a manual dispatch
can use the newly merged workflow. For that one cutover only, set the `production` environment
variable `RUN_DATABASE_BOOTSTRAP=true` before merging. The merge-triggered job then performs the
idempotent database bootstrap before installing the non-administrator runtime bundle. Delete the
variable immediately after that run succeeds so ordinary release pushes cannot bootstrap schema or
roles. Do not use this flag for recurring deployments.

Docker Hub and release-notification credentials may remain repository-scoped because the retained
AWS/GCP workflows also use them. Delete `PAT_TOKEN` and `AZURE_VM_SSH_PRIVATE_KEY` only after the
environment-scoped Run Command deployment succeeds.

## Deployment lifecycle

The workflow deliberately separates recurring releases from one-time lifecycle operations.

### Progress watchdog

Docker restarts a container that *exits* and leaves a merely `unhealthy` one alone, so neither
covers the case where the process is alive and reporting healthy while making no progress. That gap
is not theoretical: a long synchronous main-thread job once pinned the event loop for over fifteen
hours while the gateway stayed connected and `/healthz` kept answering 200.

A host timer (`tomoribot-watchdog.timer`, every minute) probes `/healthz` and reads the
`eventLoop.stalenessMs` field the bot publishes. Two shapes count as no progress, and they look
different on the wire: a *starved* loop still answers with an inflated staleness, while a *fully
blocked* one cannot answer at all, because the health server shares that loop, so the probe times
out. Both increment the same counter.

It runs on the host rather than inside the bot deliberately. An in-process detector stops running
during exactly the starvation it exists to detect.

Four rules keep it from becoming a restart loop, and all of them are configured in
`/etc/tomoribot/watchdog.conf`:

- **Consecutive failures**, not one. Five checks at a one-minute cadence, so roughly five minutes of
  continuous failure. Acting on a single sample is how a naive threshold has already taken this host
  down once.
- **A startup grace period**, so a cold start is not read as a stall.
- **A minimum interval between recycles.** A repeat inside that interval means the previous recycle
  did not fix it, which is a worse problem than a single stall, so it is logged as an alert instead
  of retried.
- **Co-tenants first**, matching the daily recycle order. Recycling them alone was measured cutting
  host IO pressure 43%, so the cheap rung sits below the expensive one.

**It ships disarmed** (`WATCHDOG_ARMED=false`) and logs what it would have done. The staleness
threshold has no calibration behind it yet, and arming a watchdog on an uncalibrated threshold is
how you manufacture the outage you were trying to prevent. Arm it only after the observation period
shows it would not have fired spuriously.

Behaviour is covered by `bun run test-watchdog`, which extracts the script from `cloud-init.yaml` on
every run rather than testing a copy, so the harness cannot drift from what ships.

**Installing it on a host that already exists is a separate step, and it is the easy thing to miss.**
`cloud-init` is consumed once at provision time and never re-runs, and `vm.tf` carries
`ignore_changes = [custom_data]` so Terraform will not push an edited `cloud-init.yaml` to a running
VM either (that guard is what stops a comment change from planning a VM replacement). A deploy
therefore does **not** deliver the watchdog to an existing host. Extract the four files from
`cloud-init.yaml`, write them through the Run Command path, then `systemctl daemon-reload` and
`systemctl enable --now tomoribot-watchdog.timer`. Extract rather than retype: the cloud-init copy
is the one the test harness exercises. The entry in `cloud-init.yaml` is what makes a future
rebuild come up with the watchdog already present.

Verify the install by what the timer does, not by whether the files exist. On a healthy bot the
script prints nothing at all and exits 0, so `journalctl -u tomoribot-watchdog.service` should show
only `Starting` and `Finished` pairs at a one-minute cadence, and `/run/tomoribot-watchdog.state`
should read `FAILURES=0`. Note the unit name: the script logs with plain `echo`, so its output
belongs to the unit and `journalctl -t tomoribot-watchdog` finds nothing.

### Production data protection

The database is guarded in three independent places, because each one covers a path the others
cannot see.

**Terraform `prevent_destroy`** on the resource group, the PostgreSQL flexible server, and the
database itself. This fails at `plan` time rather than at `apply`, so it also stops a `terraform
destroy` run from a workstation, which no CI gate observes. Deliberate teardown means editing the
`lifecycle` block first, and that friction is the point. The resource group is included because
deleting one deletes everything inside it, including the server's backups.

Firewall rules are deliberately **not** given `prevent_destroy`: the Grafana operator address
rotates with the maintainer's ISP, and a rule that legitimately needs replacing must not require a
code change. The destruction gate below still catches them.

**The destruction gate** in the deploy workflow, described below, which additionally protects the
firewall rules, networking, and alerts.

**The destructive-migration gate**, which blocks a deploy introducing `DROP TABLE`, `DROP COLUMN`,
`DROP CONSTRAINT`, `ALTER COLUMN ... TYPE`, `TRUNCATE`, or an unfiltered `DELETE` unless the
deployer opted into a pre-deploy backup, either with `(Checkpoint)` in the commit message or
`create_db_backup=true` on manual dispatch.

That gate compares migration files against **the last successful deploy**, not the previous push.
The distinction is the whole correctness of it: the gate is git-delta-scoped while the migration
runner is database-state-scoped, so they desync on any failed run. If a deploy stops at the gate,
the destructive migrations stay pending in the database, but a push-scoped diff on the next attempt
finds no new migration files, passes, and the `DROP` statements then run at startup with no backup.
Anchoring on the last green deploy keeps the window open until one actually succeeds. The base is
read from this workflow's own run history, which is why the job requests `actions: read` and checks
out with `fetch-depth: 0`. If no successful run is reachable it falls back to the push delta and
emits a warning annotation rather than failing an otherwise valid deploy.

### Destruction protection

Three guards run between `terraform plan` and `terraform apply -auto-approve`. The first two select
on a single resource type each (the PostgreSQL server, the VM), so a third, type-agnostic guard
covers everything else.

It always prints an inventory of every planned destroy, which is the part that matters most: a plan
that legitimately removes a component still shows exactly what it removes, in the deploy log, before
it happens. On top of that it fails the deploy when either condition holds:

- **A protected resource would be destroyed or replaced.** The resource group, the database, the
  PostgreSQL firewall rule, the NSG, the network interface, the virtual network, the subnet, the
  public IP, or a metric alert. Losing any of these breaks production in a way the deploy still
  reports as successful, and the list is kept to types that exist in `terraform/azure` so it can be
  audited against the repo rather than drifting into aspiration.
- **More than `MAX_UNAPPROVED_DESTROYS` resources would be destroyed** (3 by default). Retiring one
  small component legitimately removes a handful at once, such as an extension plus its rule
  associations. Beyond that a plan is more likely wrong than intended.

A replacement counts: Terraform reports it as `delete,create`, and the guard matches on the presence
of `delete` rather than on a pure destroy, so an in-place rebuild of the public IP is caught the same
way an outright deletion is.

Either failure is cleared the same way as the VM guard: review the saved plan, then dispatch manually
with `allow_infrastructure_destruction=true`. Release-branch pushes cannot bypass it.

### VM replacement protection

Terraform plans that delete or replace the production VM stop before apply. After reviewing the
saved plan, an operator may approve the replacement only through a manual dispatch with
`allow_vm_replacement=true`; release-branch pushes cannot bypass this guard.

The VM carries `lifecycle { ignore_changes = [custom_data] }` so that editing `cloud-init.yaml` is
not one of the ways a plan reaches that guard. Azure hands cloud-init to the guest agent once, at
provision time, which is why the provider treats `custom_data` as replace-only: rebuilding is the
sole way it can honour the diff. A host setting is therefore routinely applied to the running VM
first and backported to `cloud-init.yaml` afterwards, and without the exemption that backport would
plan a destructive replacement whose only effect is to reconstruct state the host already has.

The YAML stays authoritative for the next provision, so keep it accurate. Reaching that provision is
a deliberate act, though: removing the VM from state or destroying it, never a pushed YAML edit.
Verify a backport against the live host rather than trusting a clean plan, because Terraform no
longer reports drift on this field.

A replacement no longer has monitoring children to recover. The Azure Monitor Linux Agent and its
two data collection rule associations were Terraform-managed children of the VM until the bot began
writing its own telemetry to PostgreSQL, at which point they were removed: this stack installs no
monitoring agent, and `terraform.ci.tfvars` carries no data collection rule IDs.

**The driver was memory, not cost.** On a host with 842 MB of usable RAM, the agent held roughly
179 MB of resident set, a fifth of the machine spent shipping metrics that a table in a database the
bot already holds a connection to can store instead. The bot now writes a row to `metric_samples`
every `CACHE_METRICS_INTERVAL_MS`, and Grafana reads that table through the operator firewall rule
it already needs. See [Caching](/architecture/subsystems/caching/) for the dual-sink design.

The three metric alerts are unaffected, because they read `Microsoft.Compute/virtualMachines`
platform metrics served by the Azure guest agent rather than by the monitoring agent. That is
measured rather than assumed: during a ten-hour window when the monitoring agent was dead, Available
Memory Bytes and OS Disk Queue Depth both kept reporting.

Reinstating the pipeline is a rollback, not a rebuild. The Log Analytics workspace, its custom
tables, the data collection endpoint, and the rule definitions were always externally managed, so
they survive untouched and only the extension and the two associations need re-adding to
`monitoring.tf`. [Azure Application Logs](/architecture/cloud/azure-application-logs/) covers that
pipeline for a deployment that wants it.

### Database bootstrap

For the first non-administrator cutover, set the one-time environment flag described above before
merging. Later operator-requested reruns can be manually dispatched from `release` with
`run_database_bootstrap=true`. The idempotent
[`bootstrap-database.sh`](../../../deploy/azure/bootstrap-database.sh) operation:

1. creates or updates `tomoribot_runtime` as `NOINHERIT`, `NOSUPERUSER`, `NOCREATEDB`,
   `NOCREATEROLE`, `NOREPLICATION`, and `NOBYPASSRLS`;
2. runs schema initialization and migrations with the database-only administrator bundle only
   when the workflow detected that the PostgreSQL server did not exist before Terraform apply;
3. grants only database `CONNECT`, schema `USAGE`, table DML, sequence access, and function
   execution, plus matching default privileges; and
4. verifies the runtime role cannot create databases or objects in `public`.

The administrator bundle contains only PostgreSQL connection fields, is staged for the one-shot
container, and is deleted when Run Command exits. It is never installed as `/etc/tomoribot/secrets.json`.
For an existing PostgreSQL server, bootstrap skips all schema and seed operations and changes only
the runtime role and its privileges: schema and migrations are instead applied on every deploy by the
separate always-on step below. Schema-container failures are retained in the access-controlled
Azure Run Command record without exposing that output in the public Actions log.

### Schema and migration application

Because the runtime role has no DDL privilege, the running bot cannot apply schema changes
(`DATABASE_SCHEMA_MANAGEMENT_ENABLED=false`). To preserve the pre-hardening guarantee that idempotent
schema and migrations always apply on deploy, **every** deploy runs
[`migrate-database.sh`](../../../deploy/azure/migrate-database.sh) as a dedicated step before the bot
is (re)started. It:

1. runs the same `initializeCli` entrypoint the local boot path uses (idempotent `schema.sql` plus the
   tracked `NNN_*.sql` migration runner), in a one-shot container using the database-only administrator
   bundle (the only identity permitted to create tables or apply migrations in production);
2. touches no roles or grants: new tables inherit runtime and Grafana privileges automatically from the
   `ALTER DEFAULT PRIVILEGES` rules `bootstrap-database.sh` installs for the administrator role; and
3. fails the deploy (before the bot restarts) if migration does not report success.

Destructive migrations (`DROP`, `ALTER COLUMN ... TYPE`, `TRUNCATE`, unfiltered `DELETE`, etc.) are still
blocked upstream by the **Destructive migration gate**. Routine pushes genuinely apply migrations, so the
gate is what catches an unguarded destructive change before it reaches the database.

:::caution[`(Checkpoint)` does not produce a backup on this deployment]
A `(Checkpoint)` commit message, or `create_db_backup=true` on manual dispatch, skips the gate and then
runs `az postgres flexible-server backup create`. **Azure rejects customer on-demand backups on the
Burstable tier**, which is what this server runs (`Standard_B1ms`), so that step fails and takes the
deploy down with it. The outcome is safe, because nothing deploys and the migration never reaches the
database, but it is not a backup and the gate has been spent for nothing.

The real recovery point on Burstable is **point-in-time restore from the automated backups**
(`backup_retention_days`, 7 by default). Before shipping a destructive migration, record the current UTC
timestamp as your restore target, or take an explicit logical dump. Re-enable the on-demand path only if
this server moves to General Purpose or Memory Optimized, where Azure permits it.
:::

### Recurring deployment

Every deploy runs [`run-command-deploy.sh`](../../../deploy/azure/run-command-deploy.sh), which has
only these responsibilities:

- validate and atomically install the runtime JSON, Vertex WIF configuration, and Compose file;
- reject administrator runtime users and non-digest image references;
- authenticate to Docker Hub only long enough to pull the immutable image digests, then log out;
- start the TomoriBot Compose service without an implicit pull; and
- verify UID/GID `1001:1001`, a database query over verified TLS to the public Azure PostgreSQL
  FQDN, root-owned configuration modes, and `http://localhost:8081/healthz`.

The runtime container sets `DATABASE_SCHEMA_MANAGEMENT_ENABLED=false`, so startup verifies database
connectivity but cannot execute migrations or `pg_cron` administration. Migrations are applied
out-of-band on every deploy by the privileged step in [Schema and migration application](#schema-and-migration-application),
which runs before this deploy step.

### Host lockdown

After a successful deployment, manually dispatch once with `run_host_lockdown=true`. The idempotent
[`host-lockdown.sh`](../../../deploy/azure/host-lockdown.sh) operation installs an SSH hardening
drop-in, removes the provisioning user from the `docker` group, enables UFW with deny-by-default
inbound policy, and disables guest SSH. The workflow then fails unless the Azure NSG contains zero
inbound allow rules. Continue using VM Run Command for administration and health checks.

## Database and Grafana boundary

PostgreSQL uses its public Azure FQDN, but its firewall permits only two exact source addresses: the
VM's Terraform-managed static public IP and `GRAFANA_EGRESS_IP`. The application and Grafana both
connect with TLS certificate and hostname verification. Do not add `0.0.0.0`, enable access from all
Azure services, or widen either firewall rule.

Grafana must use its dedicated `grafana` login, never `tomoribot_runtime` or the PostgreSQL
administrator. Configure the PostgreSQL datasource with TLS mode `verify-full`, the Azure server
hostname (not an IP address), and the operating-system CA trust store. The login is whole-database
read-only: `CONNECT`, schema `USAGE`, current/future table `SELECT`, and
`default_transaction_read_only=on`.

Before declaring the datasource cutover complete, inspect the saved datasource configuration and
run a read query such as the daily `stat_counters` aggregation. Confirm a write fails and that a
connection from outside `GRAFANA_EGRESS_IP/32` is rejected before password authentication.

### Connection-pool hygiene on the public endpoint

Because the application now reaches PostgreSQL over the public Azure gateway rather than a private
endpoint, the runtime client sets pool-recycling options (`src/utils/db/client.ts`). Azure's public
gateway silently reaps idle TCP connections after roughly four minutes without sending a RST; a
pooled connection reaped this way becomes a black hole, so the next query hangs until an application
timeout fires (~3 minutes). Chat turns exhibited this, but lightweight slash commands, which touch
the pool more opportunistically, largely did not. `POSTGRES_IDLE_TIMEOUT_SECONDS` (default 180)
recycles idle connections before the gateway can reap them, `POSTGRES_MAX_LIFETIME_SECONDS`
(default 1800) caps total connection age, `POSTGRES_CONNECTION_TIMEOUT_SECONDS` (default 10)
turns a dead-path hang into a fast, retryable failure, and `POSTGRES_POOL_MAX` (default 10) states
the pool width explicitly instead of inheriting Bun's. Defaults are production-safe; tune only during
an incident. This was fixed at the client layer deliberately, so the private endpoint stays removed
and the free-tier cost target holds.

Both timeouts sit as far from their motivating constraint as that constraint allows, because every
firing is also a chance to hit the Bun defect described below. The gateway reap at roughly four
minutes is the binding limit on the idle timer, not the much lower value it is tempting to pick;
idle retirements were the larger share of a production cascade that left the bot unresponsive while
every health signal stayed green.

When tuning, keep `POSTGRES_IDLE_TIMEOUT_SECONDS` comfortably above the slowest single statement the
bot issues. Bun measures that timer as wall-clock silence on the socket, and a statement the server
is still executing sends no bytes, so the pool counts the connection as idle and closes it under the
in-flight query. The timer resets on every completed query, which makes the setting a cap on one
statement's duration rather than a limit on how long a connection may live. Lowering it therefore
starts killing healthy long queries well before it buys any extra reaping headroom.

#### Retrying queries killed by pool recycling

Bun's pool fires those recycling timers without draining first: it marks the connection failed and
rejects every queued and in-flight query on it, even when the query and the server are both healthy
([oven-sh/bun#30646](https://github.com/oven-sh/bun/issues/30646), open as of Bun 1.3.14). In
production this surfaced as `PostgresError: Max lifetime timeout reached after 10m`
(`ERR_POSTGRES_LIFETIME_TIMEOUT`) aborting a slash command and a guild emoji sync.

`withTransientDbRetry` in `src/utils/db/client.ts` re-issues those operations. It also covers the
stale prepared-statement plans it originally handled, but the two paths differ: a cached-plan error
calls `resetDatabaseConnection()` first, while a retired connection must not, because the pool has
already discarded the dead socket and a reset would throw away the rest of a healthy pool.
`POSTGRES_TRANSIENT_RETRY_ATTEMPTS` (default 3 total attempts) and
`POSTGRES_TRANSIENT_RETRY_DELAY_MS` (default 100) tune it.

Three attempts rather than two because a cascade retires successive cohorts, so the second attempt
frequently lands inside the same episode as the first. The delay is applied with full jitter,
uniform over zero to the configured value: a mass retirement fails every in-flight caller within the
same few milliseconds, and a fixed delay would re-synchronise exactly the callers that most need
spreading out, landing them together on the replacement cohort.

One retirement reaches the application under several codes, so the classifier matches a set rather
than a single value. Alongside `ERR_POSTGRES_LIFETIME_TIMEOUT`, `ERR_POSTGRES_IDLE_TIMEOUT`, and
`ERR_POSTGRES_CONNECTION_CLOSED`, a connection that dies part-way through a wire message surfaces as
`ERR_POSTGRES_INVALID_MESSAGE` or `ERR_POSTGRES_UNSUPPORTED_INTEGER_SIZE`: Bun rejects the pending
queries from `#onClose` carrying whatever state its protocol reader stopped in, so the code describes
where the byte stream was truncated rather than any fault in the data. Production logged 82 of these
across unrelated servers in two bursts, every stack ending at `#onClose` and none
retried, because the last two codes were missing from the set. When triaging a new Postgres code,
read the stack before the code: a frame in `#onClose` means retirement regardless of the label.

The helper replays `queryFn`, so only reads, idempotent writes, and transactions may use it. A
transaction is safe because a socket that dies mid-transaction makes the server roll back; the
emoji and sticker reconciles qualify additionally because they are upsert-only. A non-idempotent
write must not use it: if the socket dies between `COMMIT` being sent and its acknowledgement
arriving, the replay double-applies.

#### Reads that must not answer from a `catch`

Retrying narrows the window; it does not close it. When every attempt is consumed inside one
episode, the error reaches a repository, and what the repository does with it decides whether users
see a brief pause or a bot that appears broken.

A `catch` that returns a plausible default cannot distinguish an unreadable database from a real
reading, so any question whose answer changes a decision must fail **closed** instead. These four
paths now throw `DatabaseUnavailableError` rather than answering:

| Read | Old answer on error | Why it mattered |
|---|---|---|
| `UserRepository.getPrivacyLevel` | `MINIMAL` (full personalization) | A user who chose `FULL` (completely invisible) was treated as fully personalizable for the length of every cascade |
| `UserRepository.isBlacklisted` | `false` | A moderation control that lifts itself on a database hiccup is not a control |
| `PersonaUserBlockRepository.loadActiveBlocksForUser` | `[]` | An empty list reads downstream as "no blocks apply", lifting every persona-level block |
| `LlmProviderRepository.loadSavedProviderConfig` | `null` | Indistinguishable from "no row", so it rendered an "API Key Missing" embed telling an admin to run `/config setup` during a transient blip |

The genuine-absence branches above each `catch` are deliberately kept separate: a user with no row
really is new, and `MINIMAL` remains correct for them. Only the failure path changed.

Callers that cannot propagate pick the restrictive side rather than inventing a value. Participant
hydration fails closed per participant so one unreadable record does not abort a whole turn, while
the user cache returns the restrictive pair **without storing it**, so a blip measured in seconds
cannot pin a degraded answer for the full cache TTL. Chat turns and slash commands both surface a
"Database Unreachable" notice that says the attempt is worth repeating, instead of setup
instructions for a server that is already configured.

#### Pool telemetry

A single cascade once produced 8,276 error lines from repositories each blaming their own subsystem,
which buried the one fact that mattered and made the log a load source during the incident. Only the
first retirement in an episode is now logged, as a `pool_event` record; the rest are counted into the
periodic `host_memory` metric sample as `pool_errors_5m`, `pool_lifetime_5m`, `pool_idle_5m`,
`pool_other_5m`, `pool_retries_recovered_5m`, and `pool_retries_exhausted_5m`. `POOL_EVENT_EPISODE_QUIET_MS`
(default 60000) sets how much silence starts a new episode.

Two of those fields exist because they were previously unrecoverable. `pool_retries_recovered_5m`
counts retirements a retry absorbed: the per-retry log line is `log.warn`, and the production logger
is pinned at `error`, so only *exhausted* retries were ever visible and the masked-to-visible ratio
could not be measured at all. And `pool_last_lifetime_phase_s` folds process uptime into the
configured lifetime window, because Bun exposes no per-connection age. A pool whose connections were
created in one burst retires them together, which shows up as lifetime failures clustering at a
consistent phase; a flat distribution instead means age is not what drives retirement, and raising
`POSTGRES_MAX_LIFETIME_SECONDS` would not help.

These ride the existing `host_memory` sample rather than a series of their own so a cascade can be
read against swap, PSI, and event-loop lag on one time axis.

For the same reason, a failed metric write reports through `log.metric` rather than `log.warn`.
Production pins pino at level `error`, so the previous warning was dropped before either sink and a
telemetry blackout during a live outage left no trace anywhere. `log.error` is the wrong alternative
here: it would attempt an `error_logs` insert down the same pool that just failed.

### Read-only production data inspection

Host lockdown removes every inbound NSG allow rule, so `ssh` cannot reach the VM and the PostgreSQL
firewall does not admit an operator workstation. Ad-hoc production queries therefore run **inside the
bot container, driven through VM Run Command**, reading credentials from the mounted JSON secret file
rather than the container environment. This is the supported path for incident triage; do not reopen
SSH or widen the database firewall for it, and keep triage read-only.

The step-by-step recipe is an operator runbook against this specific deployment, so it lives in
[Azure Production Data Inspection](/wiki/azure-production-inspection/).

## Container and host operations

The Compose service runs as `1001:1001` with a read-only root filesystem, all Linux capabilities
dropped, `no-new-privileges`, PID/memory limits, explicit writable bind mounts, and size-limited
`tmpfs` mounts. The health port is bound only to `127.0.0.1`. Optional SearXNG is profile-gated,
unpublished, and digest-pinned.

### Enabling the SearXNG sidecar

Setting the `SEARXNG_SECRET` repository secret is the entire switch. The deploy passes it to
`run-command-deploy.sh`, which on a non-empty value adds `searxng` to the services named on
`docker compose up` (naming a profile-gated service activates its profile) and sets
`SEARXNG_BASE_URL=http://searxng:8080/` for the bot. Leaving the secret unset keeps the sidecar off
and the bot on its `Brave → DDG → Felo` chain.

One value drives both because the alternatives are failure modes: SearXNG will not start without a
secret, so a profile enabled separately would crash-loop, and a secret set without the profile would
do nothing. The deploy rejects a secret shorter than 32 characters. `SEARXNG_UWSGI_WORKERS` defaults
to `1` rather than uWSGI's one-per-CPU, since this VM is memory-constrained rather than CPU-bound.

The secret does **not** belong in `TOMORI_SECRETS_JSON`. That bundle is the application's runtime
secrets, forwarded field by field to `process.env` by `src/init/secrets.ts`, which does not forward
this key: the bot never reads it. It is a Compose-level value for a sidecar, so it is a separate
secret, and keeping it separate also avoids a read-modify-write on a bundle GitHub cannot read back.

This is a singleton: automatic platform patching or an operator reboot causes a short, expected bot
outage while the VM and `restart: unless-stopped` container return. Schedule disruptive maintenance
when a brief Discord disconnect is acceptable, then verify `/healthz`, Discord connectivity,
public-FQDN database access over verified TLS, and Vertex WIF after the reboot.

Docker uses `json-file` rotation with three 10 MiB files, live restore, and daemon-level
`no-new-privileges`. Application error JSONL remains on `/var/log/tomoribot`, which is the
durable copy: it survives container recreate and VM reboot, and it is what incident triage greps.
Cache and process-memory samples land in the `metric_samples` table, pruned on the write path after
`METRIC_SAMPLE_RETENTION_DAYS` (30 by default). Backup and application-data mounts remain under
`/var/lib/tomoribot` and require explicit operator retention decisions.

Each deploy pulls a new image digest and leaves the previous one untagged, so
`run-command-deploy.sh` runs `docker image prune -f` after the health check and file-permission
assertions pass. Pruning after the health check keeps the prior image available for rollback, and it
is dangling-only so tagged images and anything a running container references survive. The step is
never fatal: the deploy has already succeeded by that point, and reclaiming disk must not fail it.

### Memory limits must track physical RAM

`TOMORIBOT_MEMORY_LIMIT_MB` (default 512) sets both the Compose `mem_limit` and the
`CONTAINER_MEMORY_LIMIT_MB` the application reads. **These two must stay equal.** The application
sheds media load at 75% of that value and enters emergency cache clearing at 85%; if the cgroup
ceiling were lower than what the app believes it has, the container would be OOM-killed before it
ever shed load.

The value is sized against the `Standard_B2ats_v2`'s roughly 842 MB of usable RAM, not rounded up to
a convenient number. A limit above physical memory is unreachable: RSS cannot climb to it, the guard
never fires, and the kernel silently swaps the heap instead.

`TOMORIBOT_MEMORY_SWAP_LIMIT_MB` (default 2048) sets Compose's `memswap_limit`, which is **total**
memory plus swap, so the swap allowance is that figure minus `mem_limit`. It is declared explicitly
rather than left to Docker's implicit 2x default for the reason given under
[The container's swap ceiling](#the-containers-swap-ceiling-decides-whether-the-host-has-an-escape-route):
the derived 512 MB ceiling saturated within minutes of boot and cut the container off from the host's
disk swapfile entirely. Raise both values together, since either one alone moves the other's meaning.

Two related traps:

- `src/init/secrets.ts` also reads `CONTAINER_MEMORY_LIMIT_MB` from the mounted secret bundle, but
  only when the environment does not already define it. Compose therefore wins on Azure, while
  AWS/GCP deployments that set no environment variable still fall back to the bundle. A stale copy
  of this key in the secret bundle is inert but misleading, so prefer removing it there.
- The guard measures `process.memoryUsage().rss`, which counts only resident pages. On a host with
  swap enabled the kernel suppresses RSS precisely when memory pressure is worst, so RSS alone can
  understate commitment. Confirm real state with per-process `VmSwap` from `/proc/*/status` rather
  than trusting RSS. See [Azure Production Data Inspection](/wiki/azure-production-inspection/)
  for the Run Command pattern.

`SEARXNG_MEMORY_LIMIT_MB` (default 256) is sized so the optional sidecar and the bot together stay
inside physical RAM. Enable the sidecar only after confirming the host has real headroom; the
`web_search` chain degrades to `Brave -> DuckDuckGo -> IAsk` without it.

### Compressed swap needs an OOM safety net

zram makes an oversubscribed host survivable, but it changes the failure mode in a way that needs a
deliberate counterweight. Without swap, a container that outgrows `mem_limit` is OOM-killed by its
cgroup and Docker's `unless-stopped` policy restarts it inside a minute. With zram the kernel always
has somewhere to put another page, so reclaim keeps succeeding and the OOM killer never fires. The
host settles into a thrashing equilibrium instead: available memory flat, CPU near idle, disk queue
depth an order of magnitude above baseline, and every process blocked on major faults. A bot in this
state usually stays Online, because the gateway socket survives at the OS level while nothing in the
runtime advances. It is not guaranteed to: a long or deep enough episode starves the heartbeat too,
and the bot then disappears from Discord entirely without any process having died. Treat "offline"
and "online but inert" as the same diagnosis until the evidence says otherwise.

The distinguishing signature is a read-only disk storm. Reads climb while writes *fall*, because the
kernel is evicting clean file-backed pages (the Bun binary's own text, which needs no write to
discard) and faulting them straight back in. Anonymous pages would appear as swap writes instead, so
falling writes are what separate this from ordinary swapping.

#### The container's swap ceiling decides whether the host has an escape route

Compose's `mem_limit` implies a swap ceiling even when none is written down. Docker sets
memory-swap to **twice** memory whenever `memswap_limit` is unset, so a 512 MB limit silently yields
`memory.max=512Mi` **plus** `memory.swap.max=512Mi`. Nothing in the repository states this, so it
survives code review unnoticed.

That derived ceiling matters more than it looks, because **a cgroup that reaches
`memory.swap.max` cannot swap anywhere at all**, no matter which swap device still has room. Where a
host pairs a small high-priority zram device with a large low-priority disk swapfile, the container
exhausts its budget inside zram and is then cut off from the overflow tier entirely. The disk
swapfile reads `0B` used while the container suffocates beside it. From that point the kernel's only
remaining reclaim target is global file-backed memory, which is precisely the read-storm livelock
above.

Check for this directly rather than inferring it from free memory:

```sh
swapon --show   # a large low-priority tier stuck at 0B used is the tell
C=$(docker inspect -f "{{.Id}}" <container-name>)
cat /sys/fs/cgroup/system.slice/docker-$C.scope/memory.swap.current
cat /sys/fs/cgroup/system.slice/docker-$C.scope/memory.swap.max
```

`memory.swap.peak` equal to `memory.swap.max` within minutes of a clean boot means the deployment
does not drift into the dangerous state, it **starts** there. Declaring `memswap_limit` explicitly,
above the size of the compressed tier, restores access to the disk swapfile and converts an
unrecoverable hang into merely slow operation. Set it alongside `mem_limit`: changing either one
moves the other's derived value.

#### zram disappears on a kernel upgrade unless the meta-package is installed

Cloud kernels ship a minimal module set and `zram.ko` lives in `linux-modules-extra`. That package
comes in two forms, and the difference decides whether compressed swap survives the host's next
reboot. `linux-modules-extra-<version>-<flavour>` is pinned to one kernel build, while the flavour
meta-package (`linux-modules-extra-azure` and its equivalents) tracks the kernel meta-package. Install
only the pinned name at provisioning time and unattended upgrades will eventually pull a newer kernel
whose modules-extra was never fetched. The host then boots with no zram device, and because a disk
swapfile is still mounted as the overflow tier, swap keeps working and nothing reports an error.

The failure is silent from every angle that usually gets checked: memory limits are unchanged,
containers are healthy, and free memory typically looks *better*, because the compressed pool is no
longer holding RAM. The tells are specific:

```sh
swapon --show                                      # the zram device is simply absent
ls /sys/block | grep zram                          # no output
systemctl status systemd-zram-setup@zram0.service  # "Dependency failed", retried on a timer
uname -r                                           # compare against:
dpkg -l | grep linux-modules-extra                 # a version mismatch here is the root cause
```

Install both names, and mind which one is allowed to fail. The **versioned** install is the
load-bearing one at provisioning time, because a `modprobe` immediately afterwards can only load a
module built for the kernel currently booted. Cloud-init applies its package upgrade *before* running
user scripts, so the archive frequently already offers a newer kernel by then, and the meta-package
would resolve modules-extra against that newer kernel rather than the running one. The
**meta-package** is the future-proofing, and belongs on a best-effort install: it is what carries
`zram.ko` across the next unattended kernel upgrade.

Recovery on a live host needs no reboot once the module matches the running kernel:

```sh
apt-get install -y linux-modules-extra-azure || apt-get install -y "linux-modules-extra-$(uname -r)"
modprobe zram && systemctl start systemd-zram-setup@zram0.service
```

Reach for the versioned fallback when the meta-package resolves ahead of the running kernel, which
happens whenever a newer kernel has landed in the archive but the host has not rebooted into it.

### A free-memory threshold is the wrong trigger for it

The obvious remedy is a userspace OOM daemon such as `earlyoom`, which kills the largest consumer
when available memory crosses a threshold. **This was tried on this deployment and had to be
reverted.** It is recorded here because the failure is instructive and easy to repeat.

`earlyoom` polls `MemAvailable` and acts on the instantaneous reading. Configured to fire at 120 MiB
on an 843 MiB host, sized to sit between the measured healthy floor (~148 MiB) and the measured
thrash plateau (~95 MiB), it killed the bot **21 times in 19 minutes**:

```
mem avail: 119 of 842 MiB (14.19%)
low memory! at or below SIGTERM limits
sending SIGTERM to process 56123 uid 1001 "bun": badness 1034, VmRSS 321 MiB
```

A cold-starting bot warming its caches crosses that threshold *transiently and harmlessly*, so each
kill produced a restart that produced the next kill. The bot was less available than it had been with
no protection at all. Two details make this trap easy to walk into:

- `MemAvailable` counts reclaimable page cache, so it drops sharply during ordinary allocation bursts
  and recovers on its own seconds later. The same 119 MiB reading means "warming up" and "livelocked"
  at different moments.
- The healthy floor and the failure plateau are only ~50 MiB apart on a host this small, so no
  instantaneous threshold cleanly separates them.

What actually distinguishes the two states is **duration, not depth**: a startup burst shows memory
pressure for seconds, while the livelock held it for 80 minutes. The trigger therefore has to be a
sustained-pressure signal (`/proc/pressure/memory`, as `systemd-oomd` uses, with a dwell window)
rather than a single free-memory sample. An in-process event-loop lag watchdog that exits when its
own timers are starved is a reasonable complement, since it measures the symptom users actually see.

A later recurrence measured this directly rather than inferring it. Available memory touched the same
120 MiB threshold and **recovered unaided within four minutes**, fourteen minutes before the genuine
event began; the real livelock then held below that level continuously for the better part of an
hour. Sustained memory pressure separated them by two orders of magnitude (`full` avg60 of 0.27 while
healthy against 27.96 during the event) where free memory did not separate them at all.

#### A detector that has to be scheduled cannot act while nothing is being scheduled

This is the constraint that eliminates most homegrown answers, and it was learned the expensive way.
A collector was deployed to gather exactly the data above, deliberately deprioritised with `Nice=10`
and `IOSchedulingClass=idle` so it could never add to the load it was measuring. During the next
livelock it recorded **nothing for 54 minutes**. The process was never killed: the service manager
later stopped it cleanly and reported over a minute of consumed CPU. It simply never got scheduled.

`IOSchedulingClass=idle` means "receive IO only when nothing else wants it", which during a
disk-thrash livelock means never, so its own major page faults went unserviced. Deprioritising a
watchdog guarantees it is silent exactly when it is needed.

Two rules follow:

- **The daemon must be memory-resident and IO-prioritised.** `earlyoom` and `systemd-oomd` both call
  `mlockall`, which is why `earlyoom` remained able to act even while misjudging *when* to. A shell
  script or a sidecar that pages in on demand does not have this property. Give any such unit a
  negative `Nice`, a real-time IO class, and `OOMScoreAdjust=-1000`, and do not cap its memory so
  tightly that it reclaims against its own ceiling while sampling.
- **Compute dwell from timestamps, never from a count of samples.** A collector's cadence stretches
  during the very event it is measuring, so "twelve consecutive samples" stops meaning "three
  minutes". Analysis that assumes a fixed interval will conclude a rule never fired when in truth it
  had no data. A gap in a collector's own output is itself a measurement of severity.

Whatever the mechanism, **run it in observe-only mode first** and log what it would have killed for
at least a full day across a restart and a traffic peak. A kill loop is a worse outage than the hang
it was meant to prevent, and only a dry period of real traffic distinguishes the two.

Two kernel knobs pair with any such daemon. `vm.watermark_scale_factor` at its default of 10 leaves
kswapd well under 1 MiB of runway on a host this size, so allocations enter synchronous direct
reclaim instead of letting kswapd work ahead; `allocstall_*` in `/proc/vmstat` counts how often that
happens. And `vm.swappiness` must stay high: with zram measuring near 4:1, pages migrated back out of
compressed swap expand at that ratio, so lowering it to "preserve swap headroom" costs more RAM than
it frees.

### Recycling on a timer when the working set grows with uptime

A long-lived bot process on a memory-constrained host can accumulate anonymous memory that never
plateaus. Resident memory stays flat because the cgroup limit holds it there, so the growth is
invisible to `docker stats` and to RSS: it goes to swap instead. The failure that eventually produces
is indirect and easy to misattribute, because **the database is usually blamed for it**. Deep swap
means handlers stall on major faults, a stalled handler's query sends no bytes, and Bun's SQL pool
counts an in-flight query as idle and retires it at `idleTimeout`. Past a certain depth every
database-touching handler fails at once while the database itself sits idle.

Diagnose it by pairing swap depth with container uptime, never by reading either alone:

```sh
docker inspect -f '{{.State.StartedAt}}' <container>
C=$(docker inspect -f '{{.Id}}' <container>)
cat /sys/fs/cgroup/system.slice/docker-$C.scope/memory.swap.current
```

If that value climbs monotonically across days while resident memory stays flat, and the *daily
minimum* climbs too, the growth is accumulation rather than load. A scheduled restart bounds it.
`cloud-init.yaml` installs `tomoribot-restart.timer` for that, and three details matter more than the
schedule itself:

- **Resolve the container by its compose label, not its generated name,** so renaming the compose
  project cannot silently turn the timer into a no-op.
- **Skip a container that is already young.** A deploy recreates it and resets the same depth, so
  restarting one that started recently spends an outage for nothing.
- **Use `Persistent=false`.** Catching up a missed run at boot would restart a container that booting
  had just created.

Pick the hour from your own traffic histogram rather than copying one. Note also that `docker
restart` does not increment `RestartCount`, so adopting a restart schedule does not blunt the
"something is killing it" signal that a rising `RestartCount` gives during triage.

### Recycle the co-tenants, not just the application

**The application is rarely the only thing on the host that grows, and it is easily the only thing
anything restarts.** On this deployment the search backend and the monitoring agent each roughly
quadrupled between a fresh boot and thirteen hours of uptime, and together they were comparable in
size to the headroom that separated a healthy host from a saturated one. The monitoring agent was
later removed outright, which is the stronger version of the same move: recycling bounds a
co-tenant's growth, while deleting it reclaims the whole floor.

Two properties make co-tenants worth recycling on the same timer:

- **They are not subject to the application's age gate.** Their growth tracks host uptime, not
  container age, so a run that skips a freshly deployed container should still recycle them.
- **A runtime that returns freed memory to its own arenas rather than to the OS sets a permanent
  floor.** Peak concurrency, not steady-state load, decides that floor, so bounding concurrency is
  the durable fix and recycling is what reclaims what has already been committed.

Beware of self-limiting guards that key on RSS. A worker configured to respawn above an RSS ceiling
cannot fire once it has been swapped out, because its RSS then reads near zero exactly when its
true footprint is largest. **On a swap-backed host, any RSS-triggered guard is anti-correlated with
the pressure it exists to catch.**

Order the recycles so the heaviest cold start runs last, with the reclaimed memory already
available. Let a co-tenant failure fail the unit for visibility, but never let it skip the
application's own restart: a monitoring agent that quietly stops shipping is a failure mode worth
surfacing loudly, and an unattended job is exactly where it would otherwise hide.

**This is symptom management.** It bounds the depth without addressing the accumulation, and it is
worth adopting only alongside the hunt for what is growing. Its one genuine diagnostic benefit is
that a sawtooth measures a growth rate that a permanently saturated flat line hides.

## Release proof and rollback

A production hardening rollout is proven only after the protected `validate` check passes, the PR
is merged without bypass, and the environment-scoped workflow succeeds through OIDC and Run
Command. Smoke-test `/healthz`, Discord connectivity, public-FQDN PostgreSQL/TLS, Vertex WIF, URL-fetch
IMDS blocking, `/stats generate`, and one representative slash command.

Application rollback means redeploying a previously reviewed immutable image digest with the same
runtime configuration. Do not restore an administrator credential to the runtime file. Database or
Terraform-state recovery follows its own runbook; see
[Azure Terraform State Recovery](/wiki/azure-terraform-state-recovery/).
