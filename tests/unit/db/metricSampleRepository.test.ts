import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { sql } from "@/utils/db/client";
import { stubLogMembers } from "../../helpers/mockSurface";

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

stubLogMembers({ warn: () => {} });

let MetricSampleRepository: typeof import("@/utils/db/repositories/MetricSampleRepository").MetricSampleRepository;

beforeAll(async () => {
  ({ MetricSampleRepository } = await import("@/utils/db/repositories/MetricSampleRepository"));
});

const originalEnv = { ...process.env };

beforeEach(() => {
  queries.length = 0;
  insertRejection = null;
});

afterEach(() => {
  process.env.METRIC_SAMPLE_PRUNE_INTERVAL_MS = originalEnv.METRIC_SAMPLE_PRUNE_INTERVAL_MS;
  process.env.METRIC_SAMPLE_RETENTION_DAYS = originalEnv.METRIC_SAMPLE_RETENTION_DAYS;
});

const inserts = () => queries.filter((q) => q.startsWith("INSERT"));
const deletes = () => queries.filter((q) => q.startsWith("DELETE"));

describe("MetricSampleRepository", () => {
  it("records a sample and prunes on the first write", async () => {
    const repository = new MetricSampleRepository(injectedSql);
    await repository.recordSample("cache_sizes", { heap_used_mb: 312 });

    expect(inserts()).toHaveLength(1);
    expect(inserts()[0]).toContain("INSERT INTO metric_samples");
    expect(deletes()).toHaveLength(1);
  });

  // Retention is enforced here rather than by pg_cron, which is not installed in production and
  // would be skipped anyway while schema management is off. If this gate ever stops firing the
  // table grows unbounded with nothing to report it, which is the failure this test exists for.
  it("prunes again once the interval has elapsed", async () => {
    process.env.METRIC_SAMPLE_PRUNE_INTERVAL_MS = "1";
    const repository = new MetricSampleRepository(injectedSql);

    await repository.recordSample("cache_sizes", { heap_used_mb: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await repository.recordSample("cache_sizes", { heap_used_mb: 2 });

    expect(deletes()).toHaveLength(2);
  });

  it("does not prune twice inside the interval", async () => {
    process.env.METRIC_SAMPLE_PRUNE_INTERVAL_MS = String(60 * 60 * 1000);
    const repository = new MetricSampleRepository(injectedSql);

    await repository.recordSample("cache_sizes", { heap_used_mb: 1 });
    await repository.recordSample("cache_sizes", { heap_used_mb: 2 });
    await repository.recordSample("cache_sizes", { heap_used_mb: 3 });

    expect(inserts()).toHaveLength(3);
    expect(deletes()).toHaveLength(1);
  });

  it("falls back to the default retention when the env value is not a positive integer", async () => {
    process.env.METRIC_SAMPLE_RETENTION_DAYS = "not-a-number";
    const repository = new MetricSampleRepository(injectedSql);

    await expect(repository.recordSample("cache_sizes", { heap_used_mb: 1 })).resolves.toBeUndefined();
    expect(deletes()).toHaveLength(1);
  });

  // A telemetry sink must never be able to break the interval that feeds it, and must not retry
  // into a pool that is already retiring queries.
  it("swallows an insert failure without rejecting or pruning", async () => {
    insertRejection = new Error("Idle timeout reached after 30s");
    const repository = new MetricSampleRepository(injectedSql);

    await expect(repository.recordSample("cache_sizes", { heap_used_mb: 1 })).resolves.toBeUndefined();
    expect(inserts()).toHaveLength(1);
    expect(deletes()).toHaveLength(0);
  });
});
