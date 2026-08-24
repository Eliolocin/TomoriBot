---
title: Local Grafana Monitoring
sidebar:
  order: 7
---

You can monitor your local TomoriBot instance with Grafana dashboards using a provided Docker Compose profile.

To start both TomoriBot and Grafana together on your machine:

```sh
docker compose -f docker-compose.yaml -f docker/compose.monitor.yaml up -d
```

This will:
- Launch TomoriBot with PostgreSQL (on port 15432 for DB)
- Launch Grafana on port 3000 with an auto-configured PostgreSQL datasource
- Provision the **TomoriBot Overview** dashboard
- Connect both services on the same Docker network

Access Grafana at [http://localhost:3000](http://localhost:3000):
- **Username**: `admin`
- **Password**: Set via `GRAFANA_PASSWORD` in `.env` (defaults to `admin` if unset)

## The provisioned dashboard

**TomoriBot Overview** appears automatically and needs no setup. Its panels cover process memory,
cache entry counts, errors per hour, token usage by model, activity by hour, top commands, user
locales, an emotion cloud, and which presets and models are in use.

Every panel reads only tables that exist in any install, so the same dashboard works self-hosted
and in a cloud deployment.

Some panels stay empty until their source is switched on:

| Panel | Needs |
|---|---|
| Process Memory, Cache Entries | `metric_samples` rows, written every `CACHE_METRICS_INTERVAL_MS`. The collector only runs when `RUN_ENV=production`, so a development instance shows nothing here. |
| Errors per Hour by Type | `ERROR_DB_LOGGING_ENABLED` (on by default). A flat line during a suspected incident can also mean the repository's circuit breaker is open, not that errors stopped. |
| Host Memory and Swap Tiers, Host Pressure (PSI) and Swap-In Rate | A Linux host. These read `/proc/meminfo`, `/proc/pressure/*`, `/proc/swaps` and `/sys/block/zram0`, so they stay empty on macOS and Windows. The zram series also needs a zram swap device; a host without one still reports memory and PSI. |

## Editing and keeping changes

Dashboards stay editable in the UI, which matters during an incident. Edits live only in the
container and are replaced from disk on the next restart, so export a dashboard's JSON and commit
it to `docker/grafana/dashboards/` to keep a change.

Adding your own dashboard means dropping a JSON file into that same directory. Reference the
datasource by its fixed uid `tomoribot-postgres`: Grafana assigns a random uid when a datasource
declares none, and a dashboard pointing at a random uid renders empty panels rather than an error.