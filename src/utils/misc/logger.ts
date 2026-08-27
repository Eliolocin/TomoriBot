import type { ErrorContext } from "@/types/db/schema";
import { buildErrorLogPayload, errorLogRepository } from "@/utils/db/repositories/ErrorLogRepository";
import { resolveErrorContext } from "@/utils/misc/errorContextStore";
import pino from "pino";

/**
 * Whether `log.error` also persists a structured row to the `error_logs` table.
 *
 * Read per call rather than captured at module load so tests and a running process can flip it
 * without a restart. Defaults on: the structured table is what makes errors queryable from
 * Grafana, and the write is cheap (roughly 1.6 kB per row, a few hundred rows on a normal day).
 * The storm case is handled by the repository's circuit breaker, not by this flag.
 */
function isErrorDbLoggingEnabled(): boolean {
  const raw = process.env.ERROR_DB_LOGGING_ENABLED;
  if (raw === undefined) return true;
  return ["true", "1", "yes", "on"].includes(raw.trim().toLowerCase());
}

/**
 * Standard color scheme for both console logs and Discord embeds
 */
export enum ColorCode {
  INFO = "#3498DB", // Cyan color
  SUCCESS = "#2ECC71", // Green color
  MEMORY_UPDATE = "#25d4da", // Aqua color
  WARN = "#F1C40F", // Yellow color
  ERROR = "#E74C3C", // Red color
  SECTION = "#E066FF", // Purple color
  AFFECTION = "#ff10cb", // Pink color
  RATE_LIMIT = "#FFA500", // Orange color
}

/**
 * Determines if non-essential logs should be shown based on environment
 * TEST_PRODUCTION mode: Show all logs even when RUN_ENV=production
 */
const isProduction = process.env.RUN_ENV === "production";
const isTestProduction = process.env.TEST_PRODUCTION === "true";
const shouldHideLogs = isProduction && !isTestProduction;

/**
 * Check if pino-pretty is available (it's a devDependency, absent in production Docker builds).
 * Wrapping in try/catch avoids crashing when the package isn't installed.
 */
const hasPinoPretty = (() => {
  try {
    require.resolve("pino-pretty/package.json");
    return true;
  } catch {
    return false;
  }
})();

/**
 * Whether the development pino-pretty transport is active.
 * Production (or a build without pino-pretty) falls back to raw JSON output.
 */
const usePrettyTransport = !shouldHideLogs && hasPinoPretty;

/**
 * Optional JSONL log file for host-side ingestion (e.g. Azure Monitor Agent
 * tailing a bind-mounted file). Only used in JSON output mode: the
 * development pino-pretty transport ignores it. See `.env.optional.example`.
 */
const logFilePath = process.env.TOMORI_LOG_FILE?.trim() || undefined;

const REDACTED = "[REDACTED]";
const SENSITIVE_LOG_KEYS = [
  "authorization",
  "proxyAuthorization",
  "cookie",
  "setCookie",
  "password",
  "passwd",
  "token",
  "accessToken",
  "refreshToken",
  "apiKey",
  "clientSecret",
  "databaseUrl",
  "postgresUrl",
  "webhookUrl",
  "signedUrl",
] as const;

/** Defense-in-depth redaction for direct structured Pino fields. */
export const LOG_REDACTION_PATHS = SENSITIVE_LOG_KEYS.flatMap((key) => [
  key,
  `*.${key}`,
  `*.*.${key}`,
  `*.*.*.${key}`,
  `*.*.*.*.${key}`,
]);

/**
 * Builds pino multistream entries that duplicate every JSON record to stdout
 * (preserved for Docker diagnostics) and an append-only JSONL file.
 *
 * Exported for tests: injecting in-memory streams lets tests verify that both
 * sinks receive identical newline-delimited JSON without touching the filesystem.
 *
 * @param filePath - Destination JSONL file path; `undefined` disables file output.
 * @param stdoutStream - Stream receiving the primary output (default `process.stdout`).
 * @param createFileStream - Factory for the file sink (default `pino.destination` in synchronous append mode so no lines are lost on a crash).
 * @returns Stream entries for `pino.multistream()`, or `undefined` when no file is configured.
 */
export const buildLogStreams = (
  filePath: string | undefined,
  stdoutStream: pino.DestinationStream = process.stdout,
  createFileStream: (dest: string) => pino.DestinationStream = (dest) =>
    pino.destination({ dest, append: true, mkdir: true, sync: true }),
): pino.StreamEntry[] | undefined => {
  if (!filePath) return undefined;

  // "trace" lets every record through each sink; level filtering stays on the
  //    logger itself so both outputs always carry identical lines
  return [
    { stream: stdoutStream, level: "trace" },
    { stream: createFileStream(filePath), level: "trace" },
  ];
};

/**
 * Multistream entries for JSON mode. `undefined` when pretty-printing is active
 * or no log file is configured (pino then defaults to stdout only). Pino forbids
 * combining `transport` with an explicit stream, so the pretty transport and the
 * multistream are mutually exclusive by construction.
 */
const jsonStreams = usePrettyTransport ? undefined : buildLogStreams(logFilePath);

/**
 * Pino logger instance with custom levels and formatting
 */
const pinoLogger = pino(
  {
    level: shouldHideLogs ? "error" : "info",
    customLevels: {
      success: 35, // Between info (30) and warn (40)
      section: 31, // Just above info (30)
      metric: 52, // Above error (50) so periodic metrics reach CloudWatch in production
      rateLimit: 55, // Between error (50) and fatal (60)
    },
    redact: {
      paths: LOG_REDACTION_PATHS,
      censor: REDACTED,
    },
    transport: usePrettyTransport
      ? {
          target: "pino-pretty",
          options: {
            colorize: false,
            translateTime: "HH:MM:ss",
            ignore: "pid,hostname",
            customLevels:
              "trace:10,debug:20,info:30,section:31,success:35,warn:40,error:50,metric:52,rateLimit:55,fatal:60",
          },
        }
      : undefined,
  },
  jsonStreams ? pino.multistream(jsonStreams) : undefined,
);

/**
 * ANSI color codes for terminal output
 */
const colors = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  brightYellow: "\x1b[93m",
};

const isCloneSafeLogValue = (value: unknown): boolean =>
  value === null || ["string", "number", "boolean", "undefined"].includes(typeof value);

function normalizeSensitiveKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

const SENSITIVE_NORMALIZED_KEYS = new Set(SENSITIVE_LOG_KEYS.map(normalizeSensitiveKey));

function sanitizeLogString(value: string): string {
  return value
    .replace(/((?:https?|postgres(?:ql)?):\/\/[^:\s/@]+:)[^@\s/]+@/gi, `$1${REDACTED}@`)
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, `$1 ${REDACTED}`)
    .replace(
      /([?&](?:access_token|refresh_token|token|api[_-]?key|key|signature|sig|x-amz-signature)=)[^&#\s]+/gi,
      `$1${REDACTED}`,
    )
    .replace(/(https:\/\/(?:canary\.)?discord(?:app)?\.com\/api\/webhooks\/[^/\s]+\/)[^/?\s]+/gi, `$1${REDACTED}`);
}

/**
 * Recursively removes structured credentials and common credential-bearing URL
 * forms before a value reaches either stdout or the JSONL sink.
 */
export function sanitizeLogPayload(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return sanitizeLogString(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeLogPayload(entry, depth + 1));

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = SENSITIVE_NORMALIZED_KEYS.has(normalizeSensitiveKey(key))
      ? REDACTED
      : sanitizeLogPayload(entry, depth + 1);
  }
  return output;
}

const toLoggableError = (err: unknown): Record<string, unknown> => {
  if (err instanceof Error) {
    const safeExtraFields = Object.fromEntries(Object.entries(err).filter(([, value]) => isCloneSafeLogValue(value)));

    return sanitizeLogPayload({
      ...safeExtraFields,
      name: err.name,
      message: err.message,
      stack: err.stack,
    }) as Record<string, unknown>;
  }
  if (typeof err === "object" && err !== null) return sanitizeLogPayload(err) as Record<string, unknown>;
  return { message: sanitizeLogString(String(err)) };
};

/**
 * Logging utility for formatted info, success, error, warning, and section messages.
 * Uses Pino for structured logging with custom levels and pretty printing in development.
 */
export const log = {
  /**
   * Logs informational messages (hidden in production).
   */
  info: (msg: string) => {
    pinoLogger.info(shouldHideLogs ? msg : `${colors.cyan}${msg}${colors.reset}`);
  },

  /**
   * Logs success messages (hidden in production).
   */
  success: (msg: string) => {
    // Pino adds custom level methods at runtime, but TypeScript doesn't know about them
    // biome-ignore lint/suspicious/noExplicitAny: Custom Pino level added at runtime
    (pinoLogger as any).success(shouldHideLogs ? `✓ ${msg}` : `${colors.green}✓ ${msg}${colors.reset}`);
  },

  /**
   * Logs warning messages with optional error details (hidden in production).
   * @param err - Optional error object to include.
   */
  warn: (msg: string, err?: unknown, context?: ErrorContext) => {
    const coloredMsg = shouldHideLogs ? msg : `${colors.yellow}${msg}${colors.reset}`;
    const resolvedContext = resolveErrorContext(context);
    if (err) {
      pinoLogger.warn({ err: toLoggableError(err), context: sanitizeLogPayload(resolvedContext) }, coloredMsg);
    } else {
      pinoLogger.warn({ context: sanitizeLogPayload(resolvedContext) }, coloredMsg);
    }
  },

  /**
   * Logs Discord API rate limit events.
   * Always shown in production for monitoring purposes.
   * @param metadata - Optional metadata object with rate limit details.
   */
  rateLimit: (msg: string, metadata?: Record<string, unknown>) => {
    const coloredMsg = shouldHideLogs ? msg : `${colors.brightYellow}${msg}${colors.reset}`;
    // Pino adds custom level methods at runtime, but TypeScript doesn't know about them
    // biome-ignore lint/suspicious/noExplicitAny: Custom Pino level added at runtime
    const logger = pinoLogger as any;
    if (metadata) {
      logger.rateLimit({ metadata: sanitizeLogPayload(metadata) }, coloredMsg);
    } else {
      logger.rateLimit(coloredMsg);
    }
  },

  /**
   * Logs a periodic metric sample as structured JSON.
   * Always emitted regardless of environment (uses custom level 52, above `error`).
   * Intended for CloudWatch Logs Insights queries: pass flat numeric fields
   * so each metric becomes queryable at the top level of the log record.
   *
   * @param name - Short metric name (used as the `metric` field for filtering).
   */
  metric: (name: string, fields: Record<string, number | string>) => {
    const payload = { metric: name, ...fields };
    // Pino adds custom level methods at runtime; TS doesn't know about them
    // biome-ignore lint/suspicious/noExplicitAny: Custom Pino level added at runtime
    (pinoLogger as any).metric(payload, `metric:${name}`);
  },

  /**
   * Logs an error message to the console and attempts to insert it into the database.
   * Always shown in production.
   * @param err - The actual Error object or unknown error data (optional).
   * @param context - Optional context containing IDs and metadata for DB logging.
   */
  error: async (msg: string, err?: unknown, context?: ErrorContext): Promise<void> => {
    const coloredMsg = shouldHideLogs ? msg : `${colors.red}${msg}${colors.reset}`;
    const resolvedContext = resolveErrorContext(context);

    if (err) {
      pinoLogger.error(
        { err: toLoggableError(err), context: sanitizeLogPayload(resolvedContext) },
        sanitizeLogString(coloredMsg),
      );
    } else {
      pinoLogger.error({ context: sanitizeLogPayload(resolvedContext) }, sanitizeLogString(coloredMsg));
    }

    if (!isErrorDbLoggingEnabled()) {
      return;
    }

    const dbPayload = buildErrorLogPayload(msg, err, resolvedContext);

    // insertErrorLog never throws and reports a skip separately from a failure. Neither is
    // logged here: the record above already reached the durable host file, and emitting a
    // second error line per failed insert is what turns a database outage into a log storm.
    try {
      await errorLogRepository.insertErrorLog(dbPayload);
    } catch (dbError) {
      pinoLogger.error({ err: toLoggableError(dbError) }, "Failed to persist the sanitized error record");
    }
  },

  /**
   * Logs section dividers for grouping related logs (hidden in production).
   */
  section: (msg: string) => {
    const coloredMsg = shouldHideLogs ? `\n=== ${msg} ===` : `${colors.magenta}\n=== ${msg} ===${colors.reset}`;
    // Pino adds custom level methods at runtime, but TypeScript doesn't know about them
    // biome-ignore lint/suspicious/noExplicitAny: Custom Pino level added at runtime
    (pinoLogger as any).section(coloredMsg);
  },
};
