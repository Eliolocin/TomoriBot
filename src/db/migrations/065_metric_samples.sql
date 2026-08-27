-- Migration 065: metric_samples, the Postgres sink that replaces TomoriBotCacheMetrics_CL.
--
-- The AzureMonitorLinuxAgent stack holds 179 MB of RSS plus swap on an 842 MB host whose
-- 1 GB zram device saturates, so every further page costs a disk fault instead of a
-- decompression. Removing the agent is the only single lever that puts the host's swap
-- demand back under the device, but it also removes the shipping layer for the cache
-- metrics series that identified the leak in the first place. This table takes that role
-- over: the bot already holds a Postgres connection, and Grafana already reads Postgres
-- through an authorised firewall rule, so no new agent and no new network path is needed.
--
-- Design notes:
--   * `fields` is JSONB rather than wide columns because collectCacheMetricsSnapshot()
--     returns ~50 keys and the set changes whenever a cache is added or removed. Wide
--     columns would need a migration per cache. Grafana reads
--     (fields->>'heap_used_mb')::float.
--   * `metric_name` is separate from `fields` so the index can be selective: today the
--     only writer emits 'cache_sizes', but heap_snapshot and any future series land here
--     too and must not force a scan over each other's rows.
--   * DESC on created_at matches how every dashboard panel and triage query reads this
--     table, which is "the recent window for one series", never the distant past.
--   * Global, with no server_id: these are process-level measurements of one bot.
--
-- Retention is enforced by the application on the write path, NOT by pg_cron. pg_cron is
-- available on the server but not installed, and src/init/database.ts returns before any
-- pg_cron setup when DATABASE_SCHEMA_MANAGEMENT_ENABLED is false, which is what production
-- sets. A scheduled job here would be a silent no-op and the table would grow unbounded.
-- See MetricSampleRepository.pruneIfDue().

CREATE TABLE IF NOT EXISTS metric_samples (
  metric_sample_id BIGSERIAL   PRIMARY KEY,
  metric_name      TEXT        NOT NULL,
  fields           JSONB       NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_metric_samples_name_time
  ON metric_samples (metric_name, created_at DESC);
