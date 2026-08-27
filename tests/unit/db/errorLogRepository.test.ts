import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { sql } from "@/utils/db/client";

const queries: string[] = [];
let insertRejection: Error | null = null;

/**
 * Injected in place of the real `sql`, recording the normalized statement text so a test can
 * assert which statements ran. Injection rather than `mock.module`: Bun registers module mocks
 * process-wide for the whole run and never undoes them, so a mocked `sql` would answer queries
 * in every later test file too.
 */
function fakeSql(strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> {
  const text = strings.join(" ? ").replace(/\s+/g, " ").trim();
  queries.push(text);
  if (insertRejection && text.startsWith("INSERT")) {
    return Promise.reject(insertRejection);
  }
  return Promise.resolve([]);
}

const injectedSql = fakeSql as unknown as typeof sql;

let buildErrorLogPayload: typeof import("@/utils/db/repositories/ErrorLogRepository").buildErrorLogPayload;
let ErrorLogRepository: typeof import("@/utils/db/repositories/ErrorLogRepository").ErrorLogRepository;

beforeAll(async () => {
  ({ buildErrorLogPayload, ErrorLogRepository } = await import("@/utils/db/repositories/ErrorLogRepository"));
});

const originalEnv = { ...process.env };

beforeEach(() => {
  queries.length = 0;
  insertRejection = null;
  process.env.ERROR_DB_LOGGING_BREAKER_THRESHOLD = "3";
  process.env.ERROR_DB_LOGGING_BREAKER_COOLDOWN_MS = "10000";
});

afterEach(() => {
  process.env.ERROR_DB_LOGGING_BREAKER_THRESHOLD = originalEnv.ERROR_DB_LOGGING_BREAKER_THRESHOLD;
  process.env.ERROR_DB_LOGGING_BREAKER_COOLDOWN_MS = originalEnv.ERROR_DB_LOGGING_BREAKER_COOLDOWN_MS;
  process.env.ERROR_LOG_PRUNE_INTERVAL_MS = originalEnv.ERROR_LOG_PRUNE_INTERVAL_MS;
});

const payload = () => buildErrorLogPayload("boom", new Error("kaboom"));
// A fresh instance per test: the breaker is per-instance state, and the exported singleton
// would carry an open breaker from one test into the next.
const freshRepo = () => new ErrorLogRepository(injectedSql);
const inserts = () => queries.filter((q) => q.startsWith("INSERT"));

describe("ErrorLogRepository.insertErrorLog", () => {
  it("writes a row and reports success", async () => {
    const repository = freshRepo();
    expect(await repository.insertErrorLog(payload())).toBe("written");
    expect(inserts()).toHaveLength(1);
  });

  it("reports failure without throwing", async () => {
    const repository = freshRepo();
    insertRejection = new Error("Idle timeout reached after 30s");
    expect(await repository.insertErrorLog(payload())).toBe("failed");
  });

  // The failure this guards is a database outage raising errors in every handler at once, where
  // each error would otherwise insert into the pool that is already retiring queries.
  it("opens the breaker after the threshold and then stops touching the database", async () => {
    const repository = freshRepo();
    insertRejection = new Error("Idle timeout reached after 30s");

    expect(await repository.insertErrorLog(payload())).toBe("failed");
    expect(await repository.insertErrorLog(payload())).toBe("failed");
    expect(await repository.insertErrorLog(payload())).toBe("failed");
    expect(inserts()).toHaveLength(3);

    // Further calls must not reach the database at all, even once it recovers.
    insertRejection = null;
    expect(await repository.insertErrorLog(payload())).toBe("skipped_breaker_open");
    expect(await repository.insertErrorLog(payload())).toBe("skipped_breaker_open");
    expect(inserts()).toHaveLength(3);
  });

  it("closes the breaker once the cooldown has elapsed", async () => {
    const repository = freshRepo();
    process.env.ERROR_DB_LOGGING_BREAKER_COOLDOWN_MS = "1";
    insertRejection = new Error("Idle timeout reached after 30s");

    for (let i = 0; i < 3; i += 1) await repository.insertErrorLog(payload());
    insertRejection = null;
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(await repository.insertErrorLog(payload())).toBe("written");
  });

  it("prunes at most once per interval, so a storm cannot trigger a DELETE per error", async () => {
    const repository = freshRepo();
    process.env.ERROR_LOG_PRUNE_INTERVAL_MS = String(60 * 60 * 1000);

    await repository.insertErrorLog(payload());
    await repository.insertErrorLog(payload());
    await repository.insertErrorLog(payload());

    expect(inserts()).toHaveLength(3);
    expect(queries.filter((q) => q.startsWith("DELETE")).length).toBeLessThanOrEqual(1);
  });
});
