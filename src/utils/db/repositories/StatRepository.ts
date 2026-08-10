/**
 * StatRepository: write path + flush buffer for the `stat_counters` telemetry
 * table.
 *
 * Increments do NOT hit the DB directly. `recordStat` accumulates deltas into an
 * in-memory buffer keyed by the same tuple as the table PK, so a buffer entry
 * maps 1:1 to one additive bulk UPSERT row. The buffer is drained by `flush()`, triggered
 * on an interval, when it grows past a size cap, and on graceful shutdown.
 *
 * Crash window (documented tradeoff, plan §4): anything still buffered at a hard
 * crash is lost. For aggregate usage telemetry this is acceptable; graceful
 * shutdown covers the normal restart case.
 *
 * Export contract: stat_counters is high-frequency runtime telemetry and is not
 * exportable (it is on the drift-checker export-exemption list). toExportShape
 * returns null; IRepository is implemented as a no-op stub.
 *
 * Read/aggregation methods (§6) live on this same class, below the write path,
 * and read straight from the DB (no read cache in Phase 1).
 */
import type { StatMetric } from "@/constants/statMetrics";
import { PERSONA_AGNOSTIC_METRICS } from "@/constants/statMetrics";
import { sql } from "@/utils/db/client";
import { log } from "@/utils/misc/logger";
import type { SQL } from "bun";
import type { IRepository } from "./IRepository";

/**
 * Reads a non-negative integer env var, falling back to a default when unset or
 * malformed. Mirrors the readIntEnv pattern used by the preset avatar reconciler.
 */
function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Master kill switch: set false to disable all stat recording (write side). */
const STAT_TRACKING_ENABLED = (process.env.STAT_TRACKING_ENABLED?.trim().toLowerCase() ?? "true") !== "false";
/** Interval between automatic buffer flushes. */
const FLUSH_INTERVAL_MS = readIntEnv("STAT_FLUSH_INTERVAL_MS", 5000);
/** Buffer entry count that forces an immediate flush before the next interval. */
const FLUSH_MAX_BUFFER = readIntEnv("STAT_FLUSH_MAX_BUFFER", 1000);

/** Delimiter for buffer keys: unit separator, never present in metric data. */
const KEY_DELIMITER = "\x1f";

/** Input accepted by recordStat. lineageId/metricKey/delta have sensible defaults. */
export interface RecordStatInput {
  /** Internal servers FK (never the Discord snowflake). */
  serverId: number;
  /** Internal users FK (never the Discord snowflake). */
  userId: number;
  /** Persona lineage anchor. Omit (or 0) for persona-agnostic metrics. */
  lineageId?: number;
  /** Metric name from the catalog. */
  metric: StatMetric;
  /** Sub-key (command name, model id, hour, …). Defaults to "" for scalar metrics. */
  metricKey?: string;
  /** Amount to add. Defaults to 1 (event count); pass token delta for token metrics. */
  delta?: number;
}

/** One accumulated buffer entry: maps 1:1 to a single additive UPSERT. */
interface StatBufferEntry {
  serverId: number;
  userId: number;
  lineageId: number;
  metric: StatMetric;
  metricKey: string;
  bucket: string; // YYYY-MM-DD
  delta: number;
  firstAt: Date;
  lastAt: Date;
}

/** One bulk-upsert row using the physical stat_counters column names. */
type StatUpsertRow = Record<PropertyKey, unknown> & {
  server_id: number;
  user_id: number;
  persona_lineage_id: number;
  metric: StatMetric;
  metric_key: string;
  bucket: string;
  count: number;
  first_at: Date;
  last_at: Date;
};

/** UTC YYYY-MM-DD for the current day: the daily bucket grain. */
function currentBucketDate(): string {
  return new Date().toISOString().split("T")[0];
}

/** All-time floor for windowed `bucket >= from` queries (avoids branching SQL). */
const ALL_TIME_FLOOR = "0001-01-01";

/** Normalizes a window `from` (Date | YYYY-MM-DD | undefined) to a date string. */
function windowFloor(from?: Date | string): string {
  if (!from) return ALL_TIME_FLOOR;
  if (from instanceof Date) return from.toISOString().split("T")[0];
  return from;
}

/** Optional time window: rows with `bucket >= from` (omit for all-time). */
interface StatWindow {
  from?: Date | string;
}

/** One persona's message share for a user, ordered by count desc. */
export interface PersonaAffinityEntry {
  lineageId: number;
  count: number;
}

/** Favorite persona plus loyalty (top persona share of all messages). */
interface FavoritePersona {
  lineageId: number;
  count: number;
  totalCount: number;
  /** count / totalCount as a 0-100 percentage (0 when no data). */
  loyaltyPct: number;
}

/** One command's usage count. */
interface CommandUsageEntry {
  command: string;
  count: number;
}

/** One model's usage count (model_used): favorite/diversity reads. */
interface ModelUsageEntry {
  model: string;
  count: number;
}

/** One metric_key's summed count (emoji/sticker/sprite/tool/command breakdowns). */
interface MetricKeyEntry {
  key: string;
  count: number;
}

/** Per-model estimated token + cost rollup (tokens_in/tokens_out joined to llms pricing). */
export interface ModelCostEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

/** Per-persona estimated token + cost rollup for a single user's ranked card. */
interface PersonaTokenCostEntry {
  lineageId: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

/** One emotion category's summed expression count (emoji + sticker, by emotion_key). */
export interface EmotionEntry {
  emotion: string;
  count: number;
}

/** One user's summed count for a metric, with the Discord id for name resolution. */
export interface TopUserEntry {
  userId: number;
  userDiscId: string;
  count: number;
}

/** Estimated input/output token totals for a scope (see tokens_in / tokens_out). */
interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
}

/** Hour-of-day (0-23) and weekday (0=Sun-6=Sat) activity histograms. */
interface ActivityHistogram {
  byHour: Record<number, number>;
  byWeekday: Record<number, number>;
}

/**
 * 2-D joint weekday×hour activity grid (the heatmap). Keyed `dow → hour → count`
 * (dow 0=Sun-6=Sat, hour 0-23) and always fully populated (every cell present,
 * 0 when no activity) so consumers can index any cell without a presence check.
 * Unlike {@link ActivityHistogram}'s two independent 1-D marginals, this is the
 * joint distribution, so a timezone shift must rotate the (weekday, hour) pair
 * together (see getActivityHeatmap).
 */
type ActivityHeatmap = Record<number, Record<number, number>>;

/** Streak info derived from distinct active bucket dates. */
interface StreakInfo {
  currentStreak: number;
  longestStreak: number;
  /** Most recent active day (YYYY-MM-DD) or null when never active. */
  lastActiveDate: string | null;
}

/** Previous-day activity plus whether today's one-shot reunion was consumed. */
interface UserPersonaReunionInfo {
  lastPreviousDayAt: Date | null;
  seenToday: boolean;
}

/**
 * Metrics that advance a user's "this persona has seen me" clock. `presence_seen`
 * is the current, authoritative source (recorded for every human present in the
 * turn's context window, DMs included). `message_sent` is read alongside it so
 * relationships that predate the presence metric keep their history instead of
 * every existing user reading as a first-timer on the deploy that ships it.
 */
const REUNION_ACTIVITY_METRICS = ["presence_seen", "message_sent"] as const satisfies readonly StatMetric[];

/** Generation totals from the canonical stat_counters telemetry table. */
export interface GenerationTotals {
  textGenerations: number;
  imageGenerations: number;
  videoGenerations: number;
}

/** Read-existing reward/punishment totals (conditioning_history). */
interface ConditioningTotals {
  rewards: number;
  punishments: number;
}

/** Per-persona reward/punishment totals (conditioning_history), one row per lineage. */
export interface ConditioningPersonaEntry {
  lineageId: number;
  rewards: number;
  punishments: number;
}

class StatRepository implements IRepository<null> {
  /** Accumulated, not-yet-flushed deltas keyed by the table PK tuple. */
  private buffer = new Map<string, StatBufferEntry>();
  /** Interval handle for the periodic flush (unref'd so it never blocks exit). */
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  /** In-flight flush, shared by interval, threshold, read, and shutdown callers. */
  private flushPromise: Promise<boolean> | null = null;

  /**
   * Builds the buffer key from the PK tuple so a buffer entry collapses to one
   * UPSERT. Persona-agnostic metrics are normalized to lineage 0 here so callers
   * cannot accidentally split a persona-agnostic metric across lineages.
   */
  private bufferKey(entry: {
    serverId: number;
    userId: number;
    lineageId: number;
    metric: StatMetric;
    metricKey: string;
    bucket: string;
  }): string {
    return [entry.serverId, entry.userId, entry.lineageId, entry.metric, entry.metricKey, entry.bucket].join(
      KEY_DELIMITER,
    );
  }

  /**
   * Buffers a usage increment. Never throws and never awaits the DB: it only
   * mutates the in-memory buffer and (re)arms the flush timer / size-cap flush.
   * Safe to call from any hot path. No-ops when stat tracking is disabled or the
   * required ids are missing (e.g. a command run outside a guild has no server).
   *
   * @param input - Scope, metric, optional metric key, and delta (default 1).
   */
  recordStat(input: RecordStatInput): void {
    if (!STAT_TRACKING_ENABLED) return;

    const { serverId, userId, metric } = input;
    // Guard required scope: server + user are NOT NULL FKs. A missing id
    //    (e.g. a DM command with no server) is silently skipped, not an error.
    if (!Number.isInteger(serverId) || !Number.isInteger(userId)) return;

    const delta = input.delta ?? 1;
    if (delta === 0) return;

    // Persona-agnostic metrics always key on the lineage-0 sentinel.
    const lineageId = PERSONA_AGNOSTIC_METRICS.has(metric) ? 0 : (input.lineageId ?? 0);
    const metricKey = input.metricKey ?? "";
    const bucket = currentBucketDate();
    const now = new Date();

    // Accumulate into the existing buffer entry, or create a new one.
    const key = this.bufferKey({ serverId, userId, lineageId, metric, metricKey, bucket });
    const existing = this.buffer.get(key);
    if (existing) {
      existing.delta += delta;
      existing.lastAt = now;
    } else {
      this.buffer.set(key, {
        serverId,
        userId,
        lineageId,
        metric,
        metricKey,
        bucket,
        delta,
        firstAt: now,
        lastAt: now,
      });
    }

    // Flush triggers: size cap (fire-and-forget) or arm the interval timer.
    if (this.buffer.size >= FLUSH_MAX_BUFFER) {
      void this.flush();
    } else {
      this.ensureFlushTimer();
    }
  }

  /**
   * Arms the periodic flush timer if it is not already running. The timer is
   * unref'd so a pending flush never keeps the process (or a test runner) alive.
   */
  private ensureFlushTimer(): void {
    if (this.flushTimer || FLUSH_INTERVAL_MS <= 0) return;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    // Bun/Node: don't let the flush interval hold the event loop open.
    this.flushTimer.unref?.();
  }

  /** Stops the periodic flush timer (used on shutdown / when buffer drains). */
  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Drains the buffer to the DB as one additive bulk UPSERT. Concurrent callers
   * share the same promise, so shutdown and stats reads both wait for an active
   * interval flush instead of racing it. New recordStat calls accumulate in a
   * fresh Map while the snapshot is being written.
   *
   * @returns true when the snapshot persisted, false when it was re-buffered.
   */
  flush(): Promise<boolean> {
    if (this.flushPromise) return this.flushPromise;
    if (this.buffer.size === 0) return Promise.resolve(true);

    // Defer work one microtask so flushPromise is assigned before the drain can
    // settle, including when the SQL client rejects synchronously.
    let promise: Promise<boolean>;
    promise = Promise.resolve()
      .then(() => this.flushSnapshot())
      .finally(() => {
        if (this.flushPromise === promise) this.flushPromise = null;
        // A size-cap flush can start before an interval exists. If new entries
        // arrived while it ran, make sure they still receive a periodic flush.
        if (this.buffer.size === 0) this.clearFlushTimer();
        else this.ensureFlushTimer();
      });
    this.flushPromise = promise;
    return promise;
  }

  /** Persists one atomically-swapped buffer snapshot. Called only by flush(). */
  private async flushSnapshot(): Promise<boolean> {
    // Atomically take ownership of the current buffer contents.
    const draining = this.buffer;
    this.buffer = new Map();
    const entries = Array.from(draining.values());

    try {
      // One transaction and one multi-row additive UPSERT. The buffer already
      // collapsed same-tuple increments, so this is the minimum round-trip count.
      const rows: StatUpsertRow[] = entries.map((entry) => ({
        server_id: entry.serverId,
        user_id: entry.userId,
        persona_lineage_id: entry.lineageId,
        metric: entry.metric,
        metric_key: entry.metricKey,
        bucket: entry.bucket,
        count: entry.delta,
        first_at: entry.firstAt,
        last_at: entry.lastAt,
      }));
      await sql.begin(async (tx: SQL) => {
        await tx`
          INSERT INTO stat_counters ${tx(
            rows,
            "server_id",
            "user_id",
            "persona_lineage_id",
            "metric",
            "metric_key",
            "bucket",
            "count",
            "first_at",
            "last_at",
          )}
          ON CONFLICT (server_id, user_id, persona_lineage_id, metric, metric_key, bucket)
          DO UPDATE SET
            count    = stat_counters.count + EXCLUDED.count,
            first_at = LEAST(stat_counters.first_at, EXCLUDED.first_at),
            last_at  = GREATEST(stat_counters.last_at, EXCLUDED.last_at)
        `;
      });
      return true;
    } catch (error) {
      const pgError = error as Record<string, unknown>;
      let badServerId: number | null = null;
      let badUserId: number | null = null;
      let badLineageId: number | null = null;

      // A nuked server drops the servers row before this flush can execute.
      // Dropping the resulting foreign key violation prevents the entire batch from retry-looping.
      if (
        pgError &&
        typeof pgError === "object" &&
        pgError.code === "ERR_POSTGRES_SERVER_ERROR" &&
        String(pgError.errno) === "23503" &&
        typeof pgError.detail === "string"
      ) {
        const match = pgError.detail.match(/Key \(([^)]+)\)=\(([^)]+)\) is not present/);
        if (match) {
          const col = match[1];
          const val = Number(match[2]);
          if (col === "server_id" && !Number.isNaN(val)) badServerId = val;
          else if (col === "user_id" && !Number.isNaN(val)) badUserId = val;
          else if (col === "persona_lineage_id" && !Number.isNaN(val)) badLineageId = val;
        }
      }

      // Unparseable constraint violations require a full batch drop to break the retry loop.
      const isUnparseableConstraint =
        badServerId === null &&
        badUserId === null &&
        badLineageId === null &&
        pgError &&
        typeof pgError === "object" &&
        pgError.code === "ERR_POSTGRES_SERVER_ERROR" &&
        String(pgError.errno).startsWith("23");

      if (isUnparseableConstraint) {
        log.error(
          `StatRepository.flush: dropping entire batch of ${entries.length} entries due to unparseable constraint violation`,
          error,
        );
        return false;
      }

      let droppedCount = 0;
      // Exclude permanently failed entries before returning the batch to the live buffer.
      for (const e of entries) {
        if (
          (badServerId !== null && e.serverId === badServerId) ||
          (badUserId !== null && e.userId === badUserId) ||
          (badLineageId !== null && e.lineageId === badLineageId)
        ) {
          droppedCount++;
          continue;
        }

        const key = this.bufferKey(e);
        const existing = this.buffer.get(key);
        if (existing) {
          existing.delta += e.delta;
          existing.firstAt = e.firstAt < existing.firstAt ? e.firstAt : existing.firstAt;
          existing.lastAt = e.lastAt > existing.lastAt ? e.lastAt : existing.lastAt;
        } else {
          this.buffer.set(key, e);
        }
      }

      if (droppedCount > 0) {
        log.warn(`StatRepository.flush: dropped ${droppedCount} invalid stat entries to resolve foreign key violation`);
      } else {
        log.error(
          `StatRepository.flush: failed to persist ${entries.length} buffered stat entries (will retry)`,
          error,
        );
      }
      return false;
    }
  }

  /**
   * Graceful-shutdown drain: stop the timer, await an in-flight flush, and drain
   * any entries accumulated while it ran. A failed DB flush is logged and left
   * buffered rather than retrying forever during process termination.
   */
  async shutdown(): Promise<void> {
    this.clearFlushTimer();
    while (this.flushPromise || this.buffer.size > 0) {
      const persisted = await this.flush();
      if (!persisted) return;
    }
  }

  /** Current buffered entry count: used by tests and diagnostics. */
  get bufferedEntryCount(): number {
    return this.buffer.size;
  }

  /**
   * Whether the write side is live. Behavioral features that derive state from
   * counters (e.g. reunion notes) must check this: with tracking off, every read
   * returns "no history", which would otherwise read as "we have never met".
   */
  get isTrackingEnabled(): boolean {
    return STAT_TRACKING_ENABLED;
  }

  /**
   * Persists the behavioral presence clock immediately so a context being built
   * in another channel observes the successful turn. Buffered telemetry cannot
   * provide that read-after-write guarantee.
   */
  async recordPresenceSeen(args: { serverId: number; userId: number; lineageId: number }): Promise<boolean> {
    if (
      !STAT_TRACKING_ENABLED ||
      !Number.isInteger(args.serverId) ||
      !Number.isInteger(args.userId) ||
      !Number.isInteger(args.lineageId)
    ) {
      return false;
    }

    try {
      await sql`
        INSERT INTO stat_counters
          (server_id, user_id, persona_lineage_id, metric, metric_key, bucket, count, first_at, last_at)
        VALUES
          (${args.serverId}, ${args.userId}, ${args.lineageId}, 'presence_seen', '', CURRENT_DATE, 1, NOW(), NOW())
        ON CONFLICT (server_id, user_id, persona_lineage_id, metric, metric_key, bucket)
        DO UPDATE SET
          count = stat_counters.count + 1,
          last_at = GREATEST(stat_counters.last_at, EXCLUDED.last_at)
      `;
      return true;
    } catch (error) {
      log.error(`StatRepository.recordPresenceSeen: failed for user ${args.userId}, lineage ${args.lineageId}`, error);
      return false;
    }
  }

  // NOTE: reads hit the DB directly (no read cache in Phase 1). Dashboard and
  // infographic entry points await flush() before these reads, so user-facing
  // snapshots include every successfully buffered increment. All windowing is
  // `bucket >= from` + SUM, never finer.

  /**
   * Reads the triggerer's last prior-day activity and whether this persona has
   * already completed a direct turn with them today. Prior-day activity spans
   * the legacy message metric so existing relationships retain their history.
   *
   * Today's rows stay out of the gap timestamp, preserving the absence that
   * opened the current reunion episode until its successful one-shot delivery.
   * The daily consumed flag follows the UTC database bucket, while the displayed
   * gap follows the user's timezone; their midnight boundaries can differ.
   *
   * @returns Null on read failure, which callers treat as "inject nothing".
   */
  async getUserPersonaReunionInfo(userId: number, lineageId: number): Promise<UserPersonaReunionInfo | null> {
    try {
      const [row] = await sql<
        Array<{
          last_previous_day_at: Date | string | null;
          seen_today: boolean;
        }>
      >`
        SELECT
          MAX(last_at) FILTER (WHERE bucket < CURRENT_DATE) AS last_previous_day_at,
          COALESCE(SUM(count) FILTER (
            WHERE bucket = CURRENT_DATE AND metric = 'presence_seen'
          ), 0) > 0 AS seen_today
        FROM stat_counters
        WHERE user_id = ${userId}
          AND persona_lineage_id = ${lineageId}
          AND metric = ANY(${sql.array([...REUNION_ACTIVITY_METRICS], "TEXT")})
      `;
      return {
        lastPreviousDayAt: row?.last_previous_day_at ? new Date(row.last_previous_day_at) : null,
        seenToday: row?.seen_today ?? false,
      };
    } catch (error) {
      log.error(`StatRepository.getUserPersonaReunionInfo: failed for user ${userId}, lineage ${lineageId}`, error);
      return null;
    }
  }

  /**
   * Per-persona message share for a user, highest first. Powers favorite-persona
   * and loyalty reads.
   *
   * @param args - userId, optional serverId filter, optional time window.
   */
  async getPersonaAffinity(args: { userId: number; serverId?: number } & StatWindow): Promise<PersonaAffinityEntry[]> {
    try {
      const from = windowFloor(args.from);
      const rows = await sql<{ persona_lineage_id: number | string; total: number | string }[]>`
        SELECT persona_lineage_id, SUM(count) AS total
        FROM stat_counters
        WHERE metric = 'message_sent'
          AND user_id = ${args.userId}
          AND (${args.serverId ?? null}::int IS NULL OR server_id = ${args.serverId ?? null})
          AND bucket >= ${from}::date
        GROUP BY persona_lineage_id
        ORDER BY total DESC
      `;
      return rows.map((r) => ({ lineageId: Number(r.persona_lineage_id), count: Number(r.total) }));
    } catch (error) {
      log.error(`StatRepository.getPersonaAffinity: failed for user ${args.userId}`, error);
      return [];
    }
  }

  /**
   * Favorite persona for a user plus loyalty % (top persona's share of all the
   * user's messages). Returns null when the user has no message stats.
   */
  async getFavoritePersona(args: { userId: number; serverId?: number } & StatWindow): Promise<FavoritePersona | null> {
    const affinity = await this.getPersonaAffinity(args);
    if (affinity.length === 0) return null;
    const totalCount = affinity.reduce((sum, a) => sum + a.count, 0);
    const top = affinity[0];
    return {
      lineageId: top.lineageId,
      count: top.count,
      totalCount,
      loyaltyPct: totalCount > 0 ? (top.count / totalCount) * 100 : 0,
    };
  }

  /**
   * "First met" timestamp for a user + persona lineage (earliest first_at across
   * all metrics). Returns null when there is no data.
   */
  async getPersonaAnniversary(args: { userId: number; lineageId: number }): Promise<Date | null> {
    try {
      const [row] = await sql`
        SELECT MIN(first_at) AS first_at
        FROM stat_counters
        WHERE user_id = ${args.userId} AND persona_lineage_id = ${args.lineageId}
      `;
      return row?.first_at ? new Date(row.first_at as string) : null;
    } catch (error) {
      log.error(`StatRepository.getPersonaAnniversary: failed for user ${args.userId}`, error);
      return null;
    }
  }

  /**
   * Most-used commands on a server, highest first. command_used is persona-
   * agnostic so this aggregates across the lineage-0 sentinel rows.
   *
   * @param args - serverId, optional time window, optional result limit.
   */
  async getTopCommands(args: { serverId: number; limit?: number } & StatWindow): Promise<CommandUsageEntry[]> {
    try {
      const from = windowFloor(args.from);
      const limit = args.limit ?? 25;
      const rows = await sql<{ metric_key: string; total: number | string }[]>`
        SELECT metric_key, SUM(count) AS total
        FROM stat_counters
        WHERE metric = 'command_used'
          AND server_id = ${args.serverId}
          AND bucket >= ${from}::date
        GROUP BY metric_key
        ORDER BY total DESC
        LIMIT ${limit}
      `;
      return rows.map((r) => ({ command: String(r.metric_key), count: Number(r.total) }));
    } catch (error) {
      log.error(`StatRepository.getTopCommands: failed for server ${args.serverId}`, error);
      return [];
    }
  }

  /**
   * Returns the subset of `allCommands` that have NO usage rows on the server:
   * the underused/never-used set. Zero-count commands have no row, so they must
   * come from the command registry (passed in by the caller), not the table.
   *
   * @param allCommands - Full command-name list from the command registry.
   * @param args        - serverId and optional time window.
   */
  async getUnusedCommands(allCommands: string[], args: { serverId: number } & StatWindow): Promise<string[]> {
    try {
      const from = windowFloor(args.from);
      const rows = await sql<{ metric_key: string }[]>`
        SELECT DISTINCT metric_key
        FROM stat_counters
        WHERE metric = 'command_used'
          AND server_id = ${args.serverId}
          AND bucket >= ${from}::date
      `;
      const used = new Set(rows.map((r) => String(r.metric_key)));
      return allCommands.filter((cmd) => !used.has(cmd));
    } catch (error) {
      log.error(`StatRepository.getUnusedCommands: failed for server ${args.serverId}`, error);
      return [];
    }
  }

  /**
   * Reconciles the `command_catalog` dimension table with the current set of
   * registered commands. Called once at startup (04_syncCommandCatalog handler)
   * with the paths from {@link getCommandCatalogEntries}.
   *
   * The catalog is the DIMENSION that lets Grafana surface never-used commands:
   * `command_used` in stat_counters is a fact table with no row for an unused
   * command, so a LEFT JOIN from this catalog is the only way to report every
   * command with COALESCE(count, 0). `command_name` is stored in the same
   * space-joined format as `stat_counters.metric_key`, so the JOIN is direct.
   *
   * Reconciliation is upsert-then-prune inside one transaction:
   *   1. Upsert every current command (refreshing category + last_synced_at,
   *      preserving first_seen_at on existing rows).
   *   2. Delete rows whose command_name is no longer registered, so renamed or
   *      removed commands drop out automatically.
   *
   * An empty input list is treated as a failed/no-op load and skips the prune,
   * so a transient loader failure can never wipe the catalog.
   *
   * @param entries - Current command paths + categories (see getCommandCatalogEntries).
   */
  async syncCommandCatalog(entries: { commandName: string; category: string }[]): Promise<void> {
    // Never prune against an empty set, so a failed load must not empty the catalog.
    if (entries.length === 0) {
      log.warn("StatRepository.syncCommandCatalog: received no commands, leaving catalog untouched");
      return;
    }

    try {
      const rows = entries.map((entry) => ({ command_name: entry.commandName, category: entry.category }));
      const names = rows.map((row) => row.command_name);

      await sql.begin(async (tx: SQL) => {
        // Upsert current commands. first_seen_at is set on insert only; ON
        //    CONFLICT refreshes the mutable columns without touching it.
        await tx`
          INSERT INTO command_catalog ${tx(rows, "command_name", "category")}
          ON CONFLICT (command_name) DO UPDATE SET
            category       = EXCLUDED.category,
            last_synced_at = now()
        `;
        // Prune commands that no longer exist in the codebase.
        await tx`
          DELETE FROM command_catalog
          WHERE NOT (command_name = ANY(${sql.array(names, "text")}))
        `;
      });

      log.success(`StatRepository.syncCommandCatalog: catalog reconciled to ${rows.length} commands`);
    } catch (error) {
      log.error("StatRepository.syncCommandCatalog: failed", error);
    }
  }

  /**
   * Model usage breakdown (model_used) for a user or server, highest first.
   * Powers favorite model/provider and model-diversity reads. Provide at least
   * one of userId / serverId.
   */
  async getModelBreakdown(args: { userId?: number; serverId?: number } & StatWindow): Promise<ModelUsageEntry[]> {
    try {
      const from = windowFloor(args.from);
      const rows = await sql<{ metric_key: string; total: number | string }[]>`
        SELECT metric_key, SUM(count) AS total
        FROM stat_counters
        WHERE metric = 'model_used'
          AND (${args.userId ?? null}::int IS NULL OR user_id = ${args.userId ?? null})
          AND (${args.serverId ?? null}::int IS NULL OR server_id = ${args.serverId ?? null})
          AND bucket >= ${from}::date
        GROUP BY metric_key
        ORDER BY total DESC
      `;
      return rows.map((r) => ({ model: String(r.metric_key), count: Number(r.total) }));
    } catch (error) {
      log.error("StatRepository.getModelBreakdown: failed", error);
      return [];
    }
  }

  /**
   * Estimated lifetime cost (USD) from token counts, joined to llms pricing.
   *
   * Input and output tokens are tracked as separate metrics (`tokens_in` /
   * `tokens_out`), so cost applies the correct per-direction rate exactly:
   * input tokens × input price + output tokens × output price: rather than a
   * blended average. Models with no pricing row (e.g. free / OpenRouter-dynamic)
   * contribute 0. Narrow by any combination of userId / serverId / lineageId.
   */
  async getEstimatedCost(
    args: { userId?: number; serverId?: number; lineageId?: number } & StatWindow,
  ): Promise<number> {
    try {
      const from = windowFloor(args.from);
      const [row] = await sql`
        SELECT COALESCE(
          SUM(
            sc.count
            * CASE sc.metric
                WHEN 'tokens_in'  THEN COALESCE(l.input_price_per_million, 0)
                WHEN 'tokens_out' THEN COALESCE(l.output_price_per_million, 0)
                ELSE 0
              END
            / 1000000.0
          ), 0
        ) AS cost
        FROM stat_counters sc
        -- A codename can exist once per provider. stat_counters stores only the
        -- codename, so collapse pricing to one conservative row before joining;
        -- otherwise every matching provider duplicates the token counter row.
        LEFT JOIN (
          SELECT llm_codename,
            MAX(input_price_per_million) AS input_price_per_million,
            MAX(output_price_per_million) AS output_price_per_million
          FROM llms
          GROUP BY llm_codename
        ) l ON l.llm_codename = sc.metric_key
        WHERE sc.metric IN ('tokens_in', 'tokens_out')
          AND (${args.userId ?? null}::int IS NULL OR sc.user_id = ${args.userId ?? null})
          AND (${args.serverId ?? null}::int IS NULL OR sc.server_id = ${args.serverId ?? null})
          AND (${args.lineageId ?? null}::bigint IS NULL OR sc.persona_lineage_id = ${args.lineageId ?? null})
          AND sc.bucket >= ${from}::date
      `;
      return Number(row?.cost ?? 0);
    } catch (error) {
      log.error("StatRepository.getEstimatedCost: failed", error);
      return 0;
    }
  }

  /**
   * Hour-of-day and weekday activity histograms for a user, from the active_hour
   * metric (hour rides metric_key; weekday is derived from the bucket DATE).
   */
  async getActivityHistogram(args: { userId: number; serverId?: number } & StatWindow): Promise<ActivityHistogram> {
    const byHour: Record<number, number> = {};
    const byWeekday: Record<number, number> = {};
    try {
      const from = windowFloor(args.from);
      const serverId = args.serverId ?? null;
      const hourRows = await sql`
        SELECT metric_key, SUM(count) AS total
        FROM stat_counters
        WHERE metric = 'active_hour' AND user_id = ${args.userId}
          AND (${serverId}::int IS NULL OR server_id = ${serverId})
          AND bucket >= ${from}::date
        GROUP BY metric_key
      `;
      for (const r of hourRows) {
        const hour = Number.parseInt(String(r.metric_key), 10);
        if (Number.isInteger(hour)) byHour[hour] = Number(r.total);
      }

      const dowRows = await sql`
        SELECT EXTRACT(DOW FROM bucket)::int AS dow, SUM(count) AS total
        FROM stat_counters
        WHERE metric = 'active_hour' AND user_id = ${args.userId}
          AND (${serverId}::int IS NULL OR server_id = ${serverId})
          AND bucket >= ${from}::date
        GROUP BY dow
      `;
      for (const r of dowRows) {
        byWeekday[Number(r.dow)] = Number(r.total);
      }
    } catch (error) {
      log.error(`StatRepository.getActivityHistogram: failed for user ${args.userId}`, error);
    }
    return { byHour, byWeekday };
  }

  /**
   * 2-D joint weekday×hour activity heatmap for a user, from the active_hour metric
   * (hour rides metric_key; weekday derives from the bucket DATE). This is the
   * JOINT distribution (count per weekday×hour cell), distinct from
   * getActivityHistogram's two independent 1-D marginals, which is why a heatmap
   * needs its own read.
   *
   * Timezone correctness (the trap): for the personal scope a per-user hour offset
   * can roll past midnight and CHANGE the weekday, so the two axes CANNOT be shifted
   * independently. Each cell is collapsed to a single week-hour index
   * `wh = dow*24 + hour` (0-167), the offset (in hours) is added, taken mod 168, then
   * re-split into (dow, hour). Pass offsetHours for the personal scope (sourced from
   * `user_personalization_configs.timezone_offset`, the same source the histogram's peak-hour read uses);
   * omit it for server/persona scope, which use server wall-clock like the rest of
   * the dashboard.
   *
   * Returns RAW joint counts: per-weekday-occurrence normalization is a presentation
   * concern handled by the card layer, not here.
   *
   * @param args - userId (required), optional serverId filter, optional personal
   *   timezone offsetHours, and optional time window.
   */
  async getActivityHeatmap(
    args: { userId: number; serverId?: number; offsetHours?: number | null } & StatWindow,
  ): Promise<ActivityHeatmap> {
    // Pre-populate a full 7×24 grid of zeros so every cell is always present.
    const grid: ActivityHeatmap = {};
    for (let dow = 0; dow < 7; dow++) {
      grid[dow] = {};
      for (let hour = 0; hour < 24; hour++) grid[dow][hour] = 0;
    }

    try {
      const from = windowFloor(args.from);
      const serverId = args.serverId ?? null;
      // Raw joint aggregate in server wall-clock: weekday from the bucket date,
      //    hour from metric_key, summed per (weekday, hour) cell.
      const rows = await sql<{ dow: number | string; hour: string; total: number | string }[]>`
        SELECT EXTRACT(DOW FROM bucket)::int AS dow, metric_key AS hour, SUM(count) AS total
        FROM stat_counters
        WHERE metric = 'active_hour' AND user_id = ${args.userId}
          AND (${serverId}::int IS NULL OR server_id = ${serverId})
          AND bucket >= ${from}::date
        GROUP BY dow, hour
      `;

      // Normalize the offset into whole hours (0 when unset / server scope).
      const offset = Math.trunc(args.offsetHours ?? 0);

      for (const r of rows) {
        const dow = Number(r.dow);
        const hour = Number.parseInt(String(r.hour), 10);
        // Skip malformed hour keys (active_hour is always 0-23, but be safe).
        if (!Number.isInteger(dow) || !Number.isInteger(hour) || hour < 0 || hour > 23) continue;
        const total = Number(r.total);

        // Rotate the (weekday, hour) pair TOGETHER via the week-hour index so a
        //    midnight-crossing offset moves the weekday correctly. The rotation is a
        //    bijection on 0-167, so no two raw cells collide into one shifted cell.
        const wh = dow * 24 + hour;
        const shifted = (((wh + offset) % 168) + 168) % 168;
        const newDow = Math.floor(shifted / 24);
        const newHour = shifted % 24;
        grid[newDow][newHour] += total;
      }
    } catch (error) {
      log.error(`StatRepository.getActivityHeatmap: failed for user ${args.userId}`, error);
    }
    return grid;
  }

  /**
   * Current and longest activity streaks (in days) for a user, derived from the
   * set of distinct active bucket dates. "Current" counts back from today or
   * yesterday (so the streak is not considered broken before the day ends).
   */
  async getStreak(args: { userId: number; serverId?: number }): Promise<StreakInfo> {
    try {
      const serverId = args.serverId ?? null;
      const rows = await sql<{ bucket: string | Date }[]>`
        SELECT DISTINCT bucket
        FROM stat_counters
        WHERE user_id = ${args.userId}
          AND (${serverId}::int IS NULL OR server_id = ${serverId})
        ORDER BY bucket DESC
      `;
      const days = rows.map((r) =>
        new Date(
          `${(r.bucket instanceof Date ? r.bucket.toISOString() : String(r.bucket)).split("T")[0]}T00:00:00Z`,
        ).getTime(),
      );
      if (days.length === 0) return { currentStreak: 0, longestStreak: 0, lastActiveDate: null };

      const DAY_MS = 86_400_000;
      const lastActiveDate = new Date(days[0]).toISOString().split("T")[0];

      // Longest streak: walk descending dates, counting consecutive days.
      let longest = 1;
      let run = 1;
      for (let i = 1; i < days.length; i++) {
        const gap = days[i - 1] - days[i];
        if (gap === DAY_MS) {
          run++;
          longest = Math.max(longest, run);
        } else if (gap > DAY_MS) {
          run = 1;
        }
      }

      // Current streak: only counts if the most recent day is today/yesterday.
      const todayMs = new Date(`${currentBucketDate()}T00:00:00Z`).getTime();
      let current = 0;
      if (todayMs - days[0] <= DAY_MS) {
        current = 1;
        for (let i = 1; i < days.length; i++) {
          if (days[i - 1] - days[i] === DAY_MS) current++;
          else break;
        }
      }

      return { currentStreak: current, longestStreak: longest, lastActiveDate };
    } catch (error) {
      log.error(`StatRepository.getStreak: failed for user ${args.userId}`, error);
      return { currentStreak: 0, longestStreak: 0, lastActiveDate: null };
    }
  }

  /**
   * Generic metric_key breakdown (highest first) for any keyed metric: emoji_used,
   * sticker_used, sprite_shown, tool_used, command_used, model_used. Scope narrows by
   * any combination of userId / serverId / lineageId; omit a filter to aggregate over it.
   *
   * @param args - metric (required), optional scope filters, window, and limit.
   */
  async getMetricKeyBreakdown(
    args: { metric: StatMetric; userId?: number; serverId?: number; lineageId?: number; limit?: number } & StatWindow,
  ): Promise<MetricKeyEntry[]> {
    try {
      const from = windowFloor(args.from);
      const limit = args.limit ?? 10;
      const rows = await sql<{ metric_key: string; total: number | string }[]>`
        SELECT metric_key, SUM(count) AS total
        FROM stat_counters
        WHERE metric = ${args.metric}
          AND (${args.userId ?? null}::int IS NULL OR user_id = ${args.userId ?? null})
          AND (${args.serverId ?? null}::int IS NULL OR server_id = ${args.serverId ?? null})
          AND (${args.lineageId ?? null}::bigint IS NULL OR persona_lineage_id = ${args.lineageId ?? null})
          AND bucket >= ${from}::date
        GROUP BY metric_key
        ORDER BY total DESC
        LIMIT ${limit}
      `;
      return rows.map((r) => ({ key: String(r.metric_key), count: Number(r.total) }));
    } catch (error) {
      log.error(`StatRepository.getMetricKeyBreakdown: failed for ${args.metric}`, error);
      return [];
    }
  }

  /**
   * Summed total of one metric across a scope (e.g. all message_sent for a user).
   * Scope narrows by any combination of userId / serverId / lineageId.
   *
   * @param args - metric (required), optional scope filters, and window.
   */
  async getMetricTotal(
    args: { metric: StatMetric; userId?: number; serverId?: number; lineageId?: number } & StatWindow,
  ): Promise<number> {
    try {
      const from = windowFloor(args.from);
      const [row] = await sql`
        SELECT COALESCE(SUM(count), 0) AS total
        FROM stat_counters
        WHERE metric = ${args.metric}
          AND (${args.userId ?? null}::int IS NULL OR user_id = ${args.userId ?? null})
          AND (${args.serverId ?? null}::int IS NULL OR server_id = ${args.serverId ?? null})
          AND (${args.lineageId ?? null}::bigint IS NULL OR persona_lineage_id = ${args.lineageId ?? null})
          AND bucket >= ${from}::date
      `;
      return Number(row?.total ?? 0);
    } catch (error) {
      log.error(`StatRepository.getMetricTotal: failed for ${args.metric}`, error);
      return 0;
    }
  }

  /**
   * Earliest bucket containing a metric in a scope. This lets visual summaries
   * normalize all-time weekday activity into a representative week.
   */
  async getFirstMetricBucket(
    args: { metric: StatMetric; userId?: number; serverId?: number; lineageId?: number } & StatWindow,
  ): Promise<string | null> {
    try {
      const from = windowFloor(args.from);
      const [row] = await sql<{ first_bucket: string | Date | null }[]>`
        SELECT MIN(bucket) AS first_bucket
        FROM stat_counters
        WHERE metric = ${args.metric}
          AND (${args.userId ?? null}::int IS NULL OR user_id = ${args.userId ?? null})
          AND (${args.serverId ?? null}::int IS NULL OR server_id = ${args.serverId ?? null})
          AND (${args.lineageId ?? null}::bigint IS NULL OR persona_lineage_id = ${args.lineageId ?? null})
          AND bucket >= ${from}::date
      `;
      if (!row?.first_bucket) return null;
      return row.first_bucket instanceof Date ? row.first_bucket.toISOString().split("T")[0] : String(row.first_bucket);
    } catch (error) {
      log.error(`StatRepository.getFirstMetricBucket: failed for ${args.metric}`, error);
      return null;
    }
  }

  /**
   * Estimated input/output token totals for a scope (the character-estimated
   * tokens_in / tokens_out metrics). Pairs with getEstimatedCost for the cost row.
   *
   * @param args - optional scope filters and window.
   */
  async getTokenTotals(
    args: { userId?: number; serverId?: number; lineageId?: number } & StatWindow,
  ): Promise<TokenTotals> {
    const [inputTokens, outputTokens] = await Promise.all([
      this.getMetricTotal({ ...args, metric: "tokens_in" }),
      this.getMetricTotal({ ...args, metric: "tokens_out" }),
    ]);
    return { inputTokens, outputTokens };
  }

  /**
   * Per-persona token and estimated-cost totals, ranked by total tokens (highest
   * first). With a `userId` this is the Personal Wrapped per-user "Favorite
   * Personas" ranking (ordered by tokens to match the card's Tokens/Spent
   * columns); with only a `serverId` it is the server-wide persona token
   * leaderboard (Server Leaderboard card). Provide an optional `limit` to cap the
   * ranked rows; omit it to return every persona.
   *
   * @param args - at least one of userId / serverId, optional limit, and window.
   */
  async getPersonaTokenCostBreakdown(
    args: { userId?: number; serverId?: number; limit?: number } & StatWindow,
  ): Promise<PersonaTokenCostEntry[]> {
    try {
      const from = windowFloor(args.from);
      const rows = await sql<
        {
          persona_lineage_id: number | string;
          in_tokens: number | string;
          out_tokens: number | string;
          cost: number | string;
        }[]
      >`
        SELECT sc.persona_lineage_id,
          COALESCE(SUM(CASE WHEN sc.metric = 'tokens_in' THEN sc.count ELSE 0 END), 0) AS in_tokens,
          COALESCE(SUM(CASE WHEN sc.metric = 'tokens_out' THEN sc.count ELSE 0 END), 0) AS out_tokens,
          COALESCE(SUM(
            sc.count
            * CASE sc.metric
                WHEN 'tokens_in' THEN COALESCE(l.input_price_per_million, 0)
                WHEN 'tokens_out' THEN COALESCE(l.output_price_per_million, 0)
                ELSE 0
              END
            / 1000000.0
          ), 0) AS cost
        FROM stat_counters sc
        LEFT JOIN (
          SELECT llm_codename,
            MAX(input_price_per_million) AS input_price_per_million,
            MAX(output_price_per_million) AS output_price_per_million
          FROM llms
          GROUP BY llm_codename
        ) l ON l.llm_codename = sc.metric_key
        WHERE sc.metric IN ('tokens_in', 'tokens_out')
          AND (${args.userId ?? null}::int IS NULL OR sc.user_id = ${args.userId ?? null})
          AND (${args.serverId ?? null}::int IS NULL OR sc.server_id = ${args.serverId ?? null})
          AND sc.bucket >= ${from}::date
        GROUP BY sc.persona_lineage_id
        ORDER BY (
          COALESCE(SUM(CASE WHEN sc.metric = 'tokens_in' THEN sc.count ELSE 0 END), 0)
          + COALESCE(SUM(CASE WHEN sc.metric = 'tokens_out' THEN sc.count ELSE 0 END), 0)
        ) DESC
        ${args.limit ? sql`LIMIT ${args.limit}` : sql``}
      `;
      return rows.map((row) => ({
        lineageId: Number(row.persona_lineage_id),
        inputTokens: Number(row.in_tokens),
        outputTokens: Number(row.out_tokens),
        cost: Number(row.cost),
      }));
    } catch (error) {
      log.error("StatRepository.getPersonaTokenCostBreakdown: failed", error);
      return [];
    }
  }

  /**
   * Top users on a server by a metric (default message_sent), highest first, joined to
   * `users` for the Discord id so the caller can resolve display names. With a lineageId
   * this is "the persona's top people" (the /stats persona "favorite person" read); without
   * it, the server leaderboard.
   *
   * @param args - serverId (required), optional lineageId / metric / limit, and window.
   */
  async getTopUsers(
    args: { serverId: number; lineageId?: number; metric?: StatMetric; limit?: number } & StatWindow,
  ): Promise<TopUserEntry[]> {
    try {
      const from = windowFloor(args.from);
      const metric = args.metric ?? "message_sent";
      const limit = args.limit ?? 5;
      const rows = await sql<{ user_id: number | string; user_disc_id: string; total: number | string }[]>`
        SELECT sc.user_id, u.user_disc_id, SUM(sc.count) AS total
        FROM stat_counters sc
        JOIN users u ON u.user_id = sc.user_id
        WHERE sc.metric = ${metric}
          AND sc.server_id = ${args.serverId}
          AND (${args.lineageId ?? null}::bigint IS NULL OR sc.persona_lineage_id = ${args.lineageId ?? null})
          AND sc.bucket >= ${from}::date
        GROUP BY sc.user_id, u.user_disc_id
        ORDER BY total DESC
        LIMIT ${limit}
      `;
      return rows.map((r) => ({
        userId: Number(r.user_id),
        userDiscId: String(r.user_disc_id),
        count: Number(r.total),
      }));
    } catch (error) {
      log.error(`StatRepository.getTopUsers: failed for server ${args.serverId}`, error);
      return [];
    }
  }

  /**
   * Generation totals from canonical telemetry. Quotas enforce limits and are
   * deliberately not read here: they omit personal-provider generations and may
   * be disabled or retained for less time than statistics.
   *
   * @param args - optional server/user/persona scope and optional bucket floor.
   */
  async getGenerationTotals(
    args: { serverId?: number; userId?: number; lineageId?: number } & StatWindow,
  ): Promise<GenerationTotals> {
    try {
      const [textGenerations, imageGenerations, videoGenerations] = await Promise.all([
        this.getMetricTotal({ ...args, metric: "text_generated" }),
        this.getMetricTotal({ ...args, metric: "image_generated" }),
        this.getMetricTotal({ ...args, metric: "video_generated" }),
      ]);
      return {
        textGenerations,
        imageGenerations,
        videoGenerations,
      };
    } catch (error) {
      log.error("StatRepository.getGenerationTotals: failed", error);
      return { textGenerations: 0, imageGenerations: 0, videoGenerations: 0 };
    }
  }

  /**
   * Reward/punishment totals from conditioning_history (keyed on the internal
   * user_id). Any combination of serverId / lineageId / userId narrows the scope.
   */
  async getConditioningTotals(args: {
    serverId?: number;
    lineageId?: number;
    userId?: number;
  }): Promise<ConditioningTotals> {
    try {
      const rows = await sql`
        SELECT conditioning_type, COALESCE(SUM(count), 0) AS total
        FROM conditioning_history
        WHERE (${args.serverId ?? null}::int IS NULL OR server_id = ${args.serverId ?? null})
          AND (${args.lineageId ?? null}::bigint IS NULL OR persona_lineage_id = ${args.lineageId ?? null})
          AND (${args.userId ?? null}::int IS NULL OR user_id = ${args.userId ?? null})
        GROUP BY conditioning_type
      `;
      const totals: ConditioningTotals = { rewards: 0, punishments: 0 };
      for (const r of rows) {
        if (r.conditioning_type === "reward") totals.rewards = Number(r.total);
        else if (r.conditioning_type === "punish") totals.punishments = Number(r.total);
      }
      return totals;
    } catch (error) {
      log.error("StatRepository.getConditioningTotals: failed", error);
      return { rewards: 0, punishments: 0 };
    }
  }

  /**
   * Per-persona reward/punishment totals (conditioning_history), for "Most Rewarded /
   * Most Punished Personas". NOTE: conditioning_history counts are lifetime per
   * (action, reason, user, persona) tuple (not daily-bucketed), so this is all-time
   * and intentionally not windowed. Narrow by serverId / userId / lineageId.
   */
  async getConditioningPersonaBreakdown(args: {
    serverId?: number;
    userId?: number;
    lineageId?: number;
  }): Promise<ConditioningPersonaEntry[]> {
    try {
      const rows = await sql<
        { persona_lineage_id: number | string; conditioning_type: string; total: number | string }[]
      >`
        SELECT persona_lineage_id, conditioning_type, COALESCE(SUM(count), 0) AS total
        FROM conditioning_history
        WHERE (${args.serverId ?? null}::int IS NULL OR server_id = ${args.serverId ?? null})
          AND (${args.userId ?? null}::int IS NULL OR user_id = ${args.userId ?? null})
          AND (${args.lineageId ?? null}::bigint IS NULL OR persona_lineage_id = ${args.lineageId ?? null})
        GROUP BY persona_lineage_id, conditioning_type
      `;
      const byLineage = new Map<number, ConditioningPersonaEntry>();
      for (const r of rows) {
        const lineageId = Number(r.persona_lineage_id);
        const entry = byLineage.get(lineageId) ?? { lineageId, rewards: 0, punishments: 0 };
        if (r.conditioning_type === "reward") entry.rewards = Number(r.total);
        else if (r.conditioning_type === "punish") entry.punishments = Number(r.total);
        byLineage.set(lineageId, entry);
      }
      return [...byLineage.values()];
    } catch (error) {
      log.error("StatRepository.getConditioningPersonaBreakdown: failed", error);
      return [];
    }
  }

  /**
   * Count of long-term personal memories a user has saved, optionally narrowed to
   * one persona lineage. personal_memories has no server_id, so this is always
   * global for the selected user/persona scope. Read-existing (not a stat metric).
   */
  async getPersonalMemoryCount(args: { userId: number; lineageId?: number }): Promise<number> {
    try {
      const [row] = await sql`
        SELECT COUNT(*) AS total
        FROM personal_memories
        WHERE user_id = ${args.userId}
          AND (${args.lineageId ?? null}::bigint IS NULL OR persona_lineage_id = ${args.lineageId ?? null})
      `;
      return Number(row?.total ?? 0);
    } catch (error) {
      log.error(`StatRepository.getPersonalMemoryCount: failed for user ${args.userId}`, error);
      return 0;
    }
  }

  /**
   * Top personas on a server by messages received (message_sent grouped by lineage),
   * highest first. message_sent is persona-scoped and daily-bucketed, so this is
   * windowable, so it powers the server "Most Popular Personas" leaderboard row.
   *
   * @param args - serverId (required), optional time window and result limit.
   */
  async getServerPersonaMessages(
    args: { serverId: number; limit?: number } & StatWindow,
  ): Promise<PersonaAffinityEntry[]> {
    try {
      const from = windowFloor(args.from);
      const limit = args.limit ?? 5;
      const rows = await sql<{ persona_lineage_id: number | string; total: number | string }[]>`
        SELECT persona_lineage_id, SUM(count) AS total
        FROM stat_counters
        WHERE metric = 'message_sent'
          AND server_id = ${args.serverId}
          AND bucket >= ${from}::date
        GROUP BY persona_lineage_id
        ORDER BY total DESC
        LIMIT ${limit}
      `;
      return rows.map((r) => ({ lineageId: Number(r.persona_lineage_id), count: Number(r.total) }));
    } catch (error) {
      log.error(`StatRepository.getServerPersonaMessages: failed for server ${args.serverId}`, error);
      return [];
    }
  }

  /**
   * Per-persona personal-memory counts for one user (personal_memories grouped by
   * lineage), highest first. personal_memories is not daily-bucketed (it has no
   * created-date stat grain here), so this is intentionally all-time only; it
   * powers the personal "Memories by Persona" list.
   *
   * @param args - userId (required) and optional result limit.
   */
  async getPersonalMemoryByPersona(args: { userId: number; limit?: number }): Promise<PersonaAffinityEntry[]> {
    try {
      const limit = args.limit ?? 5;
      const rows = await sql<{ persona_lineage_id: number | string; total: number | string }[]>`
        SELECT persona_lineage_id, COUNT(*) AS total
        FROM personal_memories
        WHERE user_id = ${args.userId}
        GROUP BY persona_lineage_id
        ORDER BY total DESC
        LIMIT ${limit}
      `;
      return rows.map((r) => ({ lineageId: Number(r.persona_lineage_id), count: Number(r.total) }));
    } catch (error) {
      log.error(`StatRepository.getPersonalMemoryByPersona: failed for user ${args.userId}`, error);
      return [];
    }
  }

  /**
   * Count of personal memories held under a persona lineage (across all users).
   * personal_memories has no server_id, so this is global per lineage, so consistent
   * with lineage being the cross-server identity anchor. Powers the persona
   * "Memories Saved" overview field. All-time only (not bucketed).
   */
  async getPersonaMemoryCount(args: { lineageId: number }): Promise<number> {
    try {
      const [row] = await sql`
        SELECT COUNT(*) AS total FROM personal_memories WHERE persona_lineage_id = ${args.lineageId}
      `;
      return Number(row?.total ?? 0);
    } catch (error) {
      log.error(`StatRepository.getPersonaMemoryCount: failed for lineage ${args.lineageId}`, error);
      return 0;
    }
  }

  /**
   * Top users by personal-memory count ("most remembered people"), joined to users
   * for the Discord id. With a lineageId this is "people this persona remembers
   * most"; a serverId restricts the result to users active on that server (via
   * stat_counters), since personal_memories itself is not server-scoped. All-time
   * only (personal_memories is not bucketed).
   *
   * @param args - optional serverId / lineageId filters and result limit.
   */
  async getTopUsersByMemory(args: { serverId?: number; lineageId?: number; limit?: number }): Promise<TopUserEntry[]> {
    try {
      const limit = args.limit ?? 5;
      const rows = await sql<{ user_id: number | string; user_disc_id: string; total: number | string }[]>`
        SELECT pm.user_id, u.user_disc_id, COUNT(*) AS total
        FROM personal_memories pm
        JOIN users u ON u.user_id = pm.user_id
        WHERE (${args.lineageId ?? null}::bigint IS NULL OR pm.persona_lineage_id = ${args.lineageId ?? null})
          AND (${args.serverId ?? null}::int IS NULL OR pm.user_id IN (
            SELECT DISTINCT user_id FROM stat_counters WHERE server_id = ${args.serverId ?? null}
          ))
        GROUP BY pm.user_id, u.user_disc_id
        ORDER BY total DESC
        LIMIT ${limit}
      `;
      return rows.map((r) => ({
        userId: Number(r.user_id),
        userDiscId: String(r.user_disc_id),
        count: Number(r.total),
      }));
    } catch (error) {
      log.error("StatRepository.getTopUsersByMemory: failed", error);
      return [];
    }
  }

  /**
   * Top users by reward/punishment count for a scope ("most rewarded/punished by"),
   * from conditioning_history joined to users. Narrow by serverId / lineageId. All-
   * time only: conditioning_history is a lifetime counter, not daily-bucketed.
   *
   * @param args - conditioning type (required), optional serverId / lineageId, limit.
   */
  async getConditioningTopUsers(args: {
    serverId?: number;
    lineageId?: number;
    type: "reward" | "punish";
    limit?: number;
  }): Promise<TopUserEntry[]> {
    try {
      const limit = args.limit ?? 5;
      const rows = await sql<{ user_id: number | string; user_disc_id: string; total: number | string }[]>`
        SELECT ch.user_id, u.user_disc_id, COALESCE(SUM(ch.count), 0) AS total
        FROM conditioning_history ch
        JOIN users u ON u.user_id = ch.user_id
        WHERE ch.conditioning_type = ${args.type}
          AND (${args.serverId ?? null}::int IS NULL OR ch.server_id = ${args.serverId ?? null})
          AND (${args.lineageId ?? null}::bigint IS NULL OR ch.persona_lineage_id = ${args.lineageId ?? null})
        GROUP BY ch.user_id, u.user_disc_id
        ORDER BY total DESC
        LIMIT ${limit}
      `;
      return rows.map((r) => ({
        userId: Number(r.user_id),
        userDiscId: String(r.user_disc_id),
        count: Number(r.total),
      }));
    } catch (error) {
      log.error("StatRepository.getConditioningTopUsers: failed", error);
      return [];
    }
  }

  /**
   * Per-model estimated token usage + cost, highest total-tokens first. Aggregates the
   * tokens_in / tokens_out metrics (both keyed by model id) and joins llms pricing so
   * each row carries input tokens, output tokens, and the per-direction cost: the
   * richer "31,386 in / 155 out / $0.0000" model rows. Models with no pricing row
   * (free / OpenRouter-dynamic) contribute 0 cost. Narrow by userId / serverId /
   * lineageId; omit a filter to aggregate over it.
   *
   * @param args - optional scope filters, window, and result limit.
   */
  async getModelCostBreakdown(
    args: { userId?: number; serverId?: number; lineageId?: number; limit?: number } & StatWindow,
  ): Promise<ModelCostEntry[]> {
    try {
      const from = windowFloor(args.from);
      const limit = args.limit ?? 5;
      const rows = await sql<
        { model: string; in_tokens: number | string; out_tokens: number | string; cost: number | string }[]
      >`
        SELECT sc.metric_key AS model,
          COALESCE(SUM(CASE WHEN sc.metric = 'tokens_in'  THEN sc.count ELSE 0 END), 0) AS in_tokens,
          COALESCE(SUM(CASE WHEN sc.metric = 'tokens_out' THEN sc.count ELSE 0 END), 0) AS out_tokens,
          COALESCE(SUM(
            sc.count
            * CASE sc.metric
                WHEN 'tokens_in'  THEN COALESCE(l.input_price_per_million, 0)
                WHEN 'tokens_out' THEN COALESCE(l.output_price_per_million, 0)
                ELSE 0
              END
            / 1000000.0
          ), 0) AS cost
        FROM stat_counters sc
        LEFT JOIN (
          SELECT llm_codename,
            MAX(input_price_per_million) AS input_price_per_million,
            MAX(output_price_per_million) AS output_price_per_million
          FROM llms
          GROUP BY llm_codename
        ) l ON l.llm_codename = sc.metric_key
        WHERE sc.metric IN ('tokens_in', 'tokens_out')
          AND (${args.userId ?? null}::int IS NULL OR sc.user_id = ${args.userId ?? null})
          AND (${args.serverId ?? null}::int IS NULL OR sc.server_id = ${args.serverId ?? null})
          AND (${args.lineageId ?? null}::bigint IS NULL OR sc.persona_lineage_id = ${args.lineageId ?? null})
          AND sc.bucket >= ${from}::date
        GROUP BY sc.metric_key
        ORDER BY (
          COALESCE(SUM(CASE WHEN sc.metric = 'tokens_in'  THEN sc.count ELSE 0 END), 0)
          + COALESCE(SUM(CASE WHEN sc.metric = 'tokens_out' THEN sc.count ELSE 0 END), 0)
        ) DESC
        LIMIT ${limit}
      `;
      return rows.map((r) => ({
        model: String(r.model),
        inputTokens: Number(r.in_tokens),
        outputTokens: Number(r.out_tokens),
        cost: Number(r.cost),
      }));
    } catch (error) {
      log.error("StatRepository.getModelCostBreakdown: failed", error);
      return [];
    }
  }

  /**
   * Top emotion categories expressed, highest first. Sums three streams by emotion:
   *   - emoji_used  : joined to the per-server emotion_key on server_emojis
   *   - sticker_used: joined to the per-server emotion_key on server_stickers
   *   - sprite_emotion: the sprite's user-given tag IS the emotion key (no join;
   *      identity sprites were already excluded upstream when this metric was recorded)
   * Emojis/stickers not yet classified (NULL emotion_key) are excluded; sprite tags are
   * lower-cased so casing variants collapse and align with the lower-case emoji/sticker
   * taxonomy (the dashboard title-cases for display). Narrow by userId / serverId /
   * lineageId; each join keys on the row's own server_id so the personal "global" scope
   * correctly resolves emotions across every server.
   *
   * @param args - optional scope filters, window, and result limit.
   */
  async getEmotionBreakdown(
    args: { userId?: number; serverId?: number; lineageId?: number; limit?: number } & StatWindow,
  ): Promise<EmotionEntry[]> {
    try {
      const from = windowFloor(args.from);
      const limit = args.limit ?? 5;
      const userId = args.userId ?? null;
      const serverId = args.serverId ?? null;
      const lineageId = args.lineageId ?? null;
      const rows = await sql<{ emotion_key: string; total: number | string }[]>`
        SELECT emotion_key, SUM(cnt) AS total FROM (
          SELECT se.emotion_key AS emotion_key, sc.count AS cnt
          FROM stat_counters sc
          JOIN server_emojis se ON se.server_id = sc.server_id AND se.emoji_name = sc.metric_key
          WHERE sc.metric = 'emoji_used' AND se.emotion_key IS NOT NULL
            AND (${userId}::int IS NULL OR sc.user_id = ${userId})
            AND (${serverId}::int IS NULL OR sc.server_id = ${serverId})
            AND (${lineageId}::bigint IS NULL OR sc.persona_lineage_id = ${lineageId})
            AND sc.bucket >= ${from}::date
          UNION ALL
          SELECT ss.emotion_key AS emotion_key, sc.count AS cnt
          FROM stat_counters sc
          JOIN server_stickers ss ON ss.server_id = sc.server_id AND ss.sticker_name = sc.metric_key
          WHERE sc.metric = 'sticker_used' AND ss.emotion_key IS NOT NULL
            AND (${userId}::int IS NULL OR sc.user_id = ${userId})
            AND (${serverId}::int IS NULL OR sc.server_id = ${serverId})
            AND (${lineageId}::bigint IS NULL OR sc.persona_lineage_id = ${lineageId})
            AND sc.bucket >= ${from}::date
          UNION ALL
          SELECT LOWER(sc.metric_key) AS emotion_key, sc.count AS cnt
          FROM stat_counters sc
          WHERE sc.metric = 'sprite_emotion'
            AND (${userId}::int IS NULL OR sc.user_id = ${userId})
            AND (${serverId}::int IS NULL OR sc.server_id = ${serverId})
            AND (${lineageId}::bigint IS NULL OR sc.persona_lineage_id = ${lineageId})
            AND sc.bucket >= ${from}::date
        ) sub
        GROUP BY emotion_key
        ORDER BY total DESC
        LIMIT ${limit}
      `;
      return rows.map((r) => ({ emotion: String(r.emotion_key), count: Number(r.total) }));
    } catch (error) {
      log.error("StatRepository.getEmotionBreakdown: failed", error);
      return [];
    }
  }

  /**
   * Count of server-scoped shared memories (`server_memories`) for a server, optionally
   * narrowed to one persona lineage. Exact and genuinely server-scoped; unlike
   * `personal_memories`, which has no `server_id`. Powers the "Server Memories" row on
   * both the server and persona Overviews. All-time only (memory tables are not bucketed).
   *
   * @param args - serverId (required) and optional lineageId filter.
   */
  async getServerMemoryCount(args: { serverId: number; lineageId?: number }): Promise<number> {
    try {
      const [row] = await sql`
        SELECT COUNT(*) AS total FROM server_memories
        WHERE server_id = ${args.serverId}
          AND (${args.lineageId ?? null}::bigint IS NULL OR persona_lineage_id = ${args.lineageId ?? null})
      `;
      return Number(row?.total ?? 0);
    } catch (error) {
      log.error(`StatRepository.getServerMemoryCount: failed for server ${args.serverId}`, error);
      return 0;
    }
  }

  /**
   * Approximate count of members' personal memories: the `personal_memories` of users
   * active on the server (joined via stat_counters, since personal_memories has no
   * server_id). APPROXIMATE by nature because a member's personal memory bank spans every
   * server they share with the bot, so this is "memories about this server's members",
   * not "memories created here". Powers the server Overview "Member Memories" row.
   * All-time only.
   */
  async getMemberMemoryCount(args: { serverId: number }): Promise<number> {
    try {
      const [row] = await sql`
        SELECT COUNT(*) AS total FROM personal_memories
        WHERE user_id IN (SELECT DISTINCT user_id FROM stat_counters WHERE server_id = ${args.serverId})
      `;
      return Number(row?.total ?? 0);
    } catch (error) {
      log.error(`StatRepository.getMemberMemoryCount: failed for server ${args.serverId}`, error);
      return 0;
    }
  }

  async toExportShape(_ownerId: string | number): Promise<null> {
    return null;
  }

  async fromExportShape(_ownerId: string | number, _data: null): Promise<boolean> {
    return true;
  }
}

/** Singleton instance: import this in callers and chokepoints. */
export const statRepository = new StatRepository();
