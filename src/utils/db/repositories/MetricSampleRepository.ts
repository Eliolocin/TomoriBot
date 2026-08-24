import { sql } from "@/utils/db/client";

/** Flat numeric snapshot as produced by `collectCacheMetricsSnapshot()`. */
export type MetricFields = Record<string, number | string>;

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Reads a positive integer from the environment, falling back when unset or unparseable.
 * Kept local so this file stays importable without pulling in config machinery.
 */
function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Sink for periodic process and cache measurements, read by Grafana over the existing
 * Postgres datasource.
 *
 * Replaces the `TomoriBotCacheMetrics_CL` Log Analytics table so the AzureMonitorLinuxAgent
 * can be removed from a host where it holds 179 MB against a saturated 1 GB zram device.
 */
export class MetricSampleRepository {
  private lastPruneAt = 0;

  /**
   * The executor is injected rather than module-mocked in tests. `mock.module` is registered
   * process-wide for the whole run and is not undone by `mock.restore()`, so a mocked `sql`
   * leaks into every later test file and quietly answers its queries too.
   *
   * It stays optional and resolves in {@link executor} rather than as a `= sql` default, for the
   * same reason as ErrorLogRepository: a default parameter is evaluated while constructing the
   * singleton below, which can read `sql` before its module has finished initializing.
   */
  constructor(private readonly db?: typeof sql) {}

  /** Resolved per call so module initialization order cannot matter. */
  private get executor(): typeof sql {
    return this.db ?? sql;
  }

  /** Suppresses repeat warnings so a pool-wide failure logs once, not once per sample. */
  private hasWarnedSinceSuccess = false;

  /**
   * Records one sample and prunes expired rows when due. Never throws and never rejects:
   * telemetry must not be able to break the caller that produced it.
   *
   * Deliberately NOT wrapped in `withTransientDbRetry`. A retry is right for work a user is
   * waiting on, but for a 5-minute telemetry sample it converts a pool retirement into extra
   * load at exactly the moment the pool is already failing. A missing sample is the cheaper
   * outcome, and `log.metric()` still writes the durable copy to the host JSONL regardless.
   */
  async recordSample(metricName: string, fields: MetricFields): Promise<void> {
    // `fields` is bound as an object, not a `JSON.stringify` result: under Bun's driver a
    // stringified value binds as text and `::jsonb` parses it into a JSONB scalar string, which
    // makes every `fields->>'...'` read in the Grafana panels return null. See migration 064.
    // Called through a local so `this` stays undefined at the call site, matching a bare `sql`.
    const run = this.executor;
    try {
      await run`
        INSERT INTO metric_samples (metric_name, fields)
        VALUES (${metricName}, ${fields})
      `;
      this.hasWarnedSinceSuccess = false;
      await this.pruneIfDue();
    } catch (error) {
      await this.warnOnce("Failed to record metric sample", error);
    }
  }

  /**
   * Deletes samples past the retention window, at most once per prune interval.
   *
   * Pruning rides the write path rather than a pg_cron job because production runs with
   * `DATABASE_SCHEMA_MANAGEMENT_ENABLED=false`, and `src/init/database.ts` returns before
   * scheduling any job in that mode. pg_cron is not installed on the server at all, so a
   * scheduled job would never run and nothing would report that it hadn't. This mirrors the
   * sweep-on-write approach in `personaSpriteMessageCache.ts`.
   */
  private async pruneIfDue(): Promise<void> {
    const intervalMs = positiveIntFromEnv("METRIC_SAMPLE_PRUNE_INTERVAL_MS", DEFAULT_PRUNE_INTERVAL_MS);
    const now = Date.now();
    if (now - this.lastPruneAt < intervalMs) {
      return;
    }

    // Claim the slot before awaiting, so two overlapping samples cannot both prune.
    this.lastPruneAt = now;

    const retentionDays = positiveIntFromEnv("METRIC_SAMPLE_RETENTION_DAYS", DEFAULT_RETENTION_DAYS);
    const run = this.executor;
    try {
      await run`
        DELETE FROM metric_samples
        WHERE created_at < CURRENT_TIMESTAMP - MAKE_INTERVAL(days => ${retentionDays})
      `;
    } catch (error) {
      await this.warnOnce("Failed to prune metric samples", error);
    }
  }

  /**
   * Logs a failure only when the previous write succeeded, so a pool-wide retirement does not
   * add its own log storm to the incident that caused it. The logger import is deferred to
   * keep this repository out of `logger.ts`'s import cycle, matching `ErrorLogRepository`.
   *
   * Emitted through `log.metric` for two reasons that both rule out the obvious alternatives.
   * Production pins pino at level `error`, so the `log.warn` this used to call was dropped
   * before either sink: a 26-minute gap in `metric_samples` during a live outage left no trace
   * anywhere, which is the one artifact that would have named the cause. And `log.error` would
   * attempt an `error_logs` insert down the same pool that just failed, adding load to the
   * incident it is reporting.
   */
  private async warnOnce(message: string, error: unknown): Promise<void> {
    if (this.hasWarnedSinceSuccess) return;
    this.hasWarnedSinceSuccess = true;

    try {
      const { log } = await import("@/utils/misc/logger");
      log.metric("metric_sink_failure", {
        reason: message,
        error: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // Reporting a telemetry failure must not itself become one, so the "never rejects"
      // contract of recordSample() holds even if the logger module fails to resolve.
    }
  }
}

/** Singleton: import this in callers. */
export const metricSampleRepository = new MetricSampleRepository();
