import { SQL } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "@/utils/misc/logger";
import { recordPoolEvent, recordPoolRetryExhausted, recordPoolRetryRecovered } from "@/utils/db/poolEvents";

/**
 * Parse an integer environment flag with a default and enforced minimum.
 * Mirrors the local helper used across the chat modules for consistency.
 *
 */
function parseIntegerEnvFlag(value: string | undefined, defaultValue: number, minimum: number): number {
  if (typeof value !== "string") return defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return defaultValue;
  return Math.max(minimum, parsed);
}

export interface PostgresPoolOptions {
  idleTimeout: number;
  maxLifetime: number;
  connectionTimeout: number;
  max: number;
}

/**
 * Connection-pool hygiene for remote/managed PostgreSQL (in seconds).
 *
 * Any networked PostgreSQL fronted by a gateway, proxy, or load-balancer: managed
 * cloud endpoints, RDS Proxy, PgBouncer, a NAT/LB in the path; may silently reap
 * idle TCP connections without sending a RST. A pooled connection reaped this way
 * becomes a black hole: the next query hangs into it until an app timeout fires,
 * which surfaces most on longer, less frequent work (e.g. chat turns) rather than
 * on lightweight, frequent queries that keep the pool warm.
 *
 * The client is responsible for connection liveness rather than trusting the network
 * path to hold idle sockets open. `idleTimeout` recycles idle connections before any
 * intermediary can reap them, `maxLifetime` caps total connection age as a backstop,
 * and `connectionTimeout` turns a dead-path hang into a fast, retryable failure.
 * Defaults are safe for all managed providers; overridable via env for incident-time
 * tuning without a rebuild. (Azure Flexible Server's public endpoint, whose gateway
 * reaps at ~4 minutes, is one such path.)
 *
 * Every firing of `idleTimeout` or `maxLifetime` is also a chance to hit oven-sh/bun#30646,
 * which rejects in-flight queries instead of draining them (see
 * {@link RETIRED_CONNECTION_ERROR_CODES}). The timeouts are therefore set as far from the
 * constraint that motivates them as that constraint allows: the gateway reap is the binding
 * limit, not the 30s that was originally chosen, and idle retirements were the larger share of
 * a production cascade that took the bot down in front of users.
 *
 */
function resolveProductionPoolOptions(): PostgresPoolOptions {
  return {
    // Well inside the ~4 minute gateway reap while giving Bun's buggy timer far fewer chances
    // to fire than the 30s this previously used.
    idleTimeout: parseIntegerEnvFlag(process.env.POSTGRES_IDLE_TIMEOUT_SECONDS, 180, 5),
    // Hard age cap so no connection lingers indefinitely even under steady load.
    maxLifetime: parseIntegerEnvFlag(process.env.POSTGRES_MAX_LIFETIME_SECONDS, 1800, 30),
    connectionTimeout: parseIntegerEnvFlag(process.env.POSTGRES_CONNECTION_TIMEOUT_SECONDS, 10, 1),
    // Stated rather than inherited so the pool width is auditable from this file and tunable
    // during an incident without a rebuild. Matches Bun's own default, so this is not a
    // behaviour change on its own.
    max: parseIntegerEnvFlag(process.env.POSTGRES_POOL_MAX, 10, 1),
  };
}

/**
 * Creates and configures a PostgreSQL client using Bun's SQL constructor.
 *
 * SSL behaviour:
 * - Development (`RUN_ENV !== 'production'`): SSL disabled for localhost
 * - Production (`RUN_ENV === 'production'`): full TLS with CA certificate verification
 *
 * Azure and other public-CA providers use the operating-system trust store.
 * AWS RDS retains its maintained provider bundle for compatibility.
 *
 */
function createDatabaseClient(): SQL {
  const runEnv = process.env.RUN_ENV || "development";
  const isProduction = runEnv === "production" && process.env.TEST_PRODUCTION !== "true";

  const host = process.env.POSTGRES_HOST || "localhost";
  const port = Number.parseInt(process.env.POSTGRES_PORT || "5432", 10);
  const user = process.env.POSTGRES_USER || "postgres";
  const password = process.env.POSTGRES_PASSWORD;
  const database = process.env.POSTGRES_DB || "tomodb";

  // Allow initialization without password for scripts that don't use the database
  // (e.g., localization checks, linting). Database operations will fail if attempted.
  if (!password) {
    return new SQL({
      hostname: host,
      port: port,
      username: user,
      password: "dummy", // Will fail on actual connection attempt
      database: database,
    });
  }

  // Production: verified TLS for TCP connections; no TLS for unix sockets (Cloud SQL Auth Proxy)
  if (isProduction) {
    // Connection-pool hygiene applied to every production connection so a stale
    // pooled socket can't black-hole a subsequent query (see helper docs).
    const poolOptions = resolveProductionPoolOptions();

    // Unix socket path (e.g. /cloudsql/<connection-name>): Cloud SQL Auth Proxy handles TLS
    // internally; the client connects via a local socket and must not add a second TLS layer.
    if (host.startsWith("/")) {
      return new SQL({
        path: host, // Use path for Unix socket connections
        port: port,
        username: user,
        password: password,
        database: database,
        ...poolOptions,
        // biome-ignore lint/suspicious/noExplicitAny: `path` is a valid Bun SQL unix socket option not yet reflected in the type definitions
      } as any);
    }

    const tls = resolveProductionPostgresTls(host);

    return new SQL({
      hostname: host,
      port: port,
      username: user,
      password: password,
      database: database,
      tls,
      ...poolOptions,
    });
  }

  // Development: No SSL for localhost PostgreSQL
  log.info("Database SSL mode: disabled (development)");
  return new SQL({
    hostname: host,
    port: port,
    username: user,
    password: password,
    database: database,
  });
}

export interface ProductionPostgresTlsOptions {
  ca?: string;
  rejectUnauthorized: true;
}

/**
 * Select verified TLS trust without coupling Azure PostgreSQL to an AWS CA.
 *
 * Azure PostgreSQL certificates chain to public roots (including DigiCert Global
 * Root G2 and Microsoft RSA Root CA 2017), which are maintained by the Alpine
 * `ca-certificates` package in the production image. AWS RDS keeps its provider
 * bundle fallback, while an explicit POSTGRES_CA_CERT_PATH always takes priority.
 */
export function resolveProductionPostgresTls(
  host: string,
  configuredCaPath = process.env.POSTGRES_CA_CERT_PATH?.trim(),
): ProductionPostgresTlsOptions {
  const isAwsRds = host.toLowerCase().endsWith(".rds.amazonaws.com");
  const candidatePaths = [
    configuredCaPath,
    ...(isAwsRds
      ? [join(process.cwd(), "docker", "certs", "rds-ca-bundle.pem"), join(process.cwd(), "certs", "rds-ca-bundle.pem")]
      : []),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const certPath = candidatePaths.find((candidate) => existsSync(candidate));

  if (configuredCaPath && !certPath) {
    throw new Error(`Configured PostgreSQL CA bundle was not found: ${configuredCaPath}`);
  }

  if (isAwsRds && !certPath) {
    throw new Error(
      "AWS RDS requires its maintained CA bundle. " +
        `Searched paths: ${candidatePaths.join(", ")}. ` +
        "Set POSTGRES_CA_CERT_PATH to the correct file if needed.",
    );
  }

  if (certPath) {
    try {
      return {
        ca: readFileSync(certPath, "utf8"),
        rejectUnauthorized: true,
      };
    } catch (error) {
      void log.error("Failed to load the configured PostgreSQL CA bundle", error);
      throw new Error(`Unable to read PostgreSQL CA bundle: ${certPath}`);
    }
  }

  // Omitting `ca` delegates root maintenance to the operating-system trust
  // store while `rejectUnauthorized` preserves chain and hostname validation.
  return { rejectUnauthorized: true };
}

// Lazily create the client so secrets/env vars are set first (avoids premature
// initialization when modules import sql before dotenv/Secrets Manager runs).
let cachedClient: SQL | null = null;

/**
 * Gets the singleton database client, creating it on first access.
 *
 */
function getClient(): SQL {
  if (!cachedClient) {
    cachedClient = createDatabaseClient();
  }
  return cachedClient;
}

/**
 * Resets the database connection by clearing the cached client.
 * This forces a new connection on the next query, which clears PostgreSQL
 * prepared statement cache and resolves "cached plan must not change result type" errors.
 *
 * Use this when schema changes (migrations, extension installations) cause
 * prepared statement cache invalidation.
 */
export function resetDatabaseConnection(): void {
  if (cachedClient) {
    cachedClient = null;
    log.warn("Database connection reset (prepared statement cache cleared)");
  }
}

// Proxy keeps the same sql API (tagged template + helper methods) while
// deferring the real client creation until first use.
export const sql = new Proxy(
  function sqlTag(strings: TemplateStringsArray, ...values: unknown[]) {
    return getClient()(strings, ...values);
  } as unknown as SQL,
  {
    apply(_target, thisArg, argArray) {
      const client = getClient() as unknown as (...args: unknown[]) => unknown;
      return Reflect.apply(client, thisArg, argArray);
    },
    get(_target, prop, receiver) {
      const client = getClient() as object;
      const value = Reflect.get(client, prop, receiver);
      return typeof value === "function" ? value.bind(client) : value;
    },
  },
) as SQL;

/**
 * Codes Bun raises when the pool retires a connection out from under a live query.
 *
 * Bun's pool (through 1.4.0) fires its `idleTimeout`/`maxLifetime` timers without
 * draining first: it marks the connection failed and rejects every queued and in-flight
 * query on it, even though the query and the server are both healthy
 * (oven-sh/bun#30646, still open). Re-issuing succeeds because the pool has already
 * discarded the dead socket, so `resetDatabaseConnection` must NOT run on this path;
 * that would throw away the rest of a healthy pool to fix a connection already gone.
 */
const RETIRED_CONNECTION_ERROR_CODES = new Set([
  "ERR_POSTGRES_LIFETIME_TIMEOUT",
  "ERR_POSTGRES_IDLE_TIMEOUT",
  "ERR_POSTGRES_CONNECTION_CLOSED",
  // The next two reach us from the wire-protocol reader rather than the socket: when a
  // connection dies mid-message, Bun rejects the pending queries from `#onClose` carrying
  // whatever state its parser stopped in, so the code marks where the byte stream was
  // truncated. Prod logs on 2026-08-06 carried 82 of these across unrelated servers in two
  // bursts, every stack ending at `#onClose`, none retried because of this gap.
  // Neither code is exclusive to that path (Bun can also raise them from encoding faults),
  // so read the stack before the code when triaging: a replay costs one query, but a real
  // encoding bug retried here will look like ordinary connection churn in the logs.
  "ERR_POSTGRES_INVALID_MESSAGE",
  "ERR_POSTGRES_UNSUPPORTED_INTEGER_SIZE",
]);

function isRetiredConnectionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const { code } = error as { code?: unknown };
  return typeof code === "string" && RETIRED_CONNECTION_ERROR_CODES.has(code);
}

interface TransientRetryOptions {
  /** Total attempts including the first, so 1 disables retrying. */
  attempts: number;
  delayMs: number;
}

function resolveTransientRetryOptions(): TransientRetryOptions {
  return {
    // Three rather than two because a cascade retires successive cohorts: production logged
    // `Exhausted 2 attempt(s)` 1,905 times in one episode and 103 times in eight minutes of
    // another, so the second attempt frequently lands inside the same cascade as the first.
    attempts: parseIntegerEnvFlag(process.env.POSTGRES_TRANSIENT_RETRY_ATTEMPTS, 3, 1),
    // A retired socket is replaced on the pool's next tick; retrying in the same tick
    // can land on the still-closing connection.
    delayMs: parseIntegerEnvFlag(process.env.POSTGRES_TRANSIENT_RETRY_DELAY_MS, 100, 0),
  };
}

/**
 * Full jitter over the configured delay.
 *
 * A mass retirement fails every in-flight caller within the same few milliseconds, so a fixed
 * delay re-synchronises exactly the callers that most need spreading out and lands them
 * together on the replacement cohort.
 */
function jitteredDelayMs(delayMs: number): number {
  return delayMs <= 0 ? 0 : Math.floor(Math.random() * delayMs);
}

/**
 * Executes a database operation, retrying the transient failures that are the client's
 * own doing rather than a real query fault: a stale prepared-statement plan after a
 * schema change, and a connection the pool retired mid-query.
 *
 * `queryFn` may run more than once, so it must be safe to replay. Reads always qualify.
 * A write qualifies only if it is idempotent (an `ON CONFLICT DO UPDATE` reconcile) or
 * runs inside a transaction, since a socket that dies mid-transaction makes the server
 * roll back. A non-idempotent write must not use this helper: if the socket dies in the
 * window between `COMMIT` being sent and its acknowledgement arriving, the replay
 * double-applies.
 *
 * Rethrows once retries are exhausted rather than returning a sentinel, so a caller whose
 * next line assumes the write landed (a "sync completed" log, a cache invalidation) cannot
 * run on a failed operation.
 *
 * @param operationName - Descriptive name for logging (e.g., "load user", "load reminders")
 *
 * @example
 * ```typescript
 * const reminders = await withTransientDbRetry(
 *   async () => await sql`SELECT * FROM reminders WHERE due_at <= NOW()`,
 *   "load due reminders"
 * );
 * ```
 */
export async function withTransientDbRetry<T>(queryFn: () => Promise<T>, operationName: string): Promise<T> {
  const { attempts, delayMs } = resolveTransientRetryOptions();
  let sawRetiredConnection = false;

  for (let attempt = 1; ; attempt++) {
    try {
      const result = await queryFn();
      if (sawRetiredConnection) {
        recordPoolRetryRecovered();
      }
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isCachedPlanError = errorMessage.includes("cached plan must not change result type");
      const isRetiredConnection = isRetiredConnectionError(error);

      if (!isCachedPlanError && !isRetiredConnection) {
        throw error;
      }

      if (isRetiredConnection) {
        sawRetiredConnection = true;
        reportPoolEvent(error, operationName, attempt, attempts);
      }

      if (attempt >= attempts) {
        if (isRetiredConnection) {
          recordPoolRetryExhausted();
        }
        await log.error(`Exhausted ${attempt} attempt(s) for "${operationName}"`, error);
        throw error;
      }

      if (isCachedPlanError) {
        log.warn(`Cached plan error during "${operationName}", resetting connection and retrying`);
        resetDatabaseConnection();
        continue;
      }

      log.warn(
        `Pool retired the connection during "${operationName}" (attempt ${attempt}/${attempts}), retrying on a fresh connection`,
      );
      const backoff = jitteredDelayMs(delayMs);
      if (backoff > 0) {
        await Bun.sleep(backoff);
      }
    }
  }
}

/**
 * Counts one retirement and logs only the event that opens an episode.
 *
 * The rest go to the counters alone. A single production cascade produced 8,276 error lines
 * from repositories each blaming their own subsystem, which buried the one fact that mattered
 * and made the log itself a load source during the incident.
 */
function reportPoolEvent(error: unknown, operationName: string, attempt: number, attempts: number): void {
  const code = (error as { code?: string }).code ?? "unknown";
  const { maxLifetime } = resolveProductionPoolOptions();
  const { isFirstOfEpisode, uptimeS, lifetimePhaseS } = recordPoolEvent(code, maxLifetime);

  if (!isFirstOfEpisode) {
    return;
  }

  // `log.metric` rather than `log.error`: production pins pino at level `error`, so this is the
  // only route besides an error that reaches the host JSONL, and an episode marker is a
  // measurement rather than a fault the operator must act on line by line.
  log.metric("pool_event", {
    code,
    operation: operationName,
    attempt,
    attempts,
    uptime_s: uptimeS,
    lifetime_phase_s: lifetimePhaseS,
    max_lifetime_s: maxLifetime,
  });
}
