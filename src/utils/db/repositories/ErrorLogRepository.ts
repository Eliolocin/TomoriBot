import type { ErrorContext } from "@/types/db/schema";
import { sql } from "@/utils/db/client";

/**
 * Pre-built row payload for `error_logs` insertion.
 * Assembled by the logger before calling `insertErrorLog()`.
 */
export interface ErrorLogPayload {
  persona_id: number | null;
  user_id: number | null;
  server_id: number | null;
  error_type: string;
  error_message: string;
  stack_trace: string | null;
  /**
   * Bound to JSONB as an object, never as a `JSON.stringify` result. Under Bun's driver a
   * stringified value binds as text and `::jsonb` then parses it into a JSONB *scalar string*
   * whose content is the JSON source, so `->`, `->>` and containment all stop working.
   * Migration 064 exists to repair columns written that way.
   */
  error_metadata: Record<string, unknown> | null;
}

/**
 * Assembles an `ErrorLogPayload` from a raw message, error, and optional context.
 * Kept here so `logger.ts` never needs to import `sql` directly.
 *
 * @param msg     - Primary log message
 * @param err     - Raw error value from the catch block
 * @param context - Optional caller-supplied context IDs and metadata
 */
export function buildErrorLogPayload(msg: string, err: unknown, context?: ErrorContext): ErrorLogPayload {
  const errorMessage = toErrorMessage(err);
  const stackTrace = toErrorStack(err);

  return {
    persona_id: context?.personaId ?? null,
    user_id: context?.userId ?? null,
    server_id: context?.serverId ?? null,
    error_type: context?.errorType ?? "GenericError",
    error_message: `${msg} - ${errorMessage}`,
    stack_trace: stackTrace,
    error_metadata: context?.metadata ?? null,
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (isRecord(err)) {
    if (typeof err.message === "string") return err.message;
    try {
      return JSON.stringify(err);
    } catch {
      return "[unserializable object]";
    }
  }
  return String(err);
}

function toErrorStack(err: unknown): string | null {
  if (err instanceof Error) return err.stack ?? null;
  if (isRecord(err) && typeof err.stack === "string") return err.stack;
  return null;
}

const DEFAULT_BREAKER_THRESHOLD = 5;
const DEFAULT_BREAKER_COOLDOWN_MS = 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Outcome of an insert attempt, so the caller can stay silent when silence is correct. */
export type ErrorLogWriteResult = "written" | "skipped_breaker_open" | "failed";

function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Thin repository for the `error_logs` table.
 *
 * Intentionally does NOT statically import `logger.ts`: this file sits between the
 * logger and the DB client, breaking the circular dependency.
 */
export class ErrorLogRepository {
  private consecutiveFailures = 0;
  private breakerOpenUntil = 0;
  private lastPruneAt = 0;

  /**
   * The executor is injected rather than module-mocked in tests. `mock.module` is registered
   * process-wide for the whole run and is not undone by `mock.restore()`, so a mocked `sql`
   * leaks into every later test file and quietly answers its queries too.
   *
   * It must stay optional and resolve in {@link executor}, never as a `= sql` default. This
   * module sits on a cycle (`client` imports `logger`, which imports this file, which imports
   * `client`), and the singleton below is constructed during module evaluation, so a default
   * parameter reads `sql` while it is still in its temporal dead zone and throws at startup.
   */
  constructor(private readonly db?: typeof sql) {}

  /** Resolved per call so the cycle above is closed by the time anything queries. */
  private get executor(): typeof sql {
    return this.db ?? sql;
  }

  /**
   * Inserts a structured error record into the `error_logs` table. Never throws.
   *
   * A circuit breaker guards the one failure mode that matters here. When the database is
   * itself the outage, every downstream handler raises an error at once (one incident produced
   * 947 pool timeouts in two bursts), and each of those would otherwise attempt an insert into
   * the pool that is already retiring queries. Error logging would hammer the database hardest
   * exactly when it is least able to answer. After a few consecutive failures the breaker opens
   * and inserts are skipped outright until a cooldown elapses. Nothing is lost that matters: the
   * host JSONL keeps receiving every one of these records regardless.
   */
  async insertErrorLog(payload: ErrorLogPayload): Promise<ErrorLogWriteResult> {
    if (Date.now() < this.breakerOpenUntil) {
      return "skipped_breaker_open";
    }

    // Called through a local so `this` stays undefined at the call site, matching a bare `sql`.
    const run = this.executor;
    try {
      await run`
        INSERT INTO error_logs (
          persona_id, user_id, server_id,
          error_type, error_message, stack_trace, error_metadata
        ) VALUES (
          ${payload.persona_id}, ${payload.user_id}, ${payload.server_id},
          ${payload.error_type}, ${payload.error_message}, ${payload.stack_trace},
          ${payload.error_metadata}
        )
      `;
      this.consecutiveFailures = 0;
      await this.pruneIfDue();
      return "written";
    } catch {
      this.consecutiveFailures += 1;
      const threshold = positiveIntFromEnv("ERROR_DB_LOGGING_BREAKER_THRESHOLD", DEFAULT_BREAKER_THRESHOLD);
      if (this.consecutiveFailures >= threshold) {
        const cooldownMs = positiveIntFromEnv("ERROR_DB_LOGGING_BREAKER_COOLDOWN_MS", DEFAULT_BREAKER_COOLDOWN_MS);
        this.breakerOpenUntil = Date.now() + cooldownMs;
        this.consecutiveFailures = 0;
      }
      return "failed";
    }
  }

  /**
   * Deletes records past the retention window, at most once per prune interval.
   *
   * Retention rides the write path because pg_cron is not installed on the production server
   * and `src/init/database.ts` skips all pg_cron setup while schema management is disabled, so
   * a scheduled job would silently never run. The interval gate means an error storm triggers
   * at most one DELETE, not one per error.
   */
  private async pruneIfDue(): Promise<void> {
    const intervalMs = positiveIntFromEnv("ERROR_LOG_PRUNE_INTERVAL_MS", DEFAULT_PRUNE_INTERVAL_MS);
    const now = Date.now();
    if (now - this.lastPruneAt < intervalMs) {
      return;
    }

    // Claim the slot before awaiting, so two overlapping errors cannot both prune.
    this.lastPruneAt = now;

    const retentionDays = positiveIntFromEnv("ERROR_LOG_RETENTION_DAYS", DEFAULT_RETENTION_DAYS);
    const run = this.executor;
    try {
      await run`
        DELETE FROM error_logs
        WHERE created_at < CURRENT_TIMESTAMP - MAKE_INTERVAL(days => ${retentionDays})
      `;
    } catch {
      // A failed prune is not worth reporting from inside error handling: the next
      // interval retries, and surfacing it here risks amplifying the storm it rode in on.
    }
  }
}

/** Singleton: import this in callers. */
export const errorLogRepository = new ErrorLogRepository();
