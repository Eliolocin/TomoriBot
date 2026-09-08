import { beforeEach, describe, expect, it, mock } from "bun:test";
import * as realClient from "@/utils/db/client";
import {
  clearPersonaSpriteCache,
  getPersonaSpriteCacheEntry,
  setPersonaSpriteCache,
} from "@/utils/cache/personaSpriteCacheStore";
import { createScopedModuleMocker } from "../../helpers/mockSurface";

// Captured query text + queued row results for the mocked `sql` tag. Each query
// method issues exactly one `sql` call, so the queue stays in lockstep with the
// method under test.
interface SqlCall {
  text: string;
  values: unknown[];
}
const sqlCalls: SqlCall[] = [];
let rowQueue: Array<unknown[] | Error> = [];

function sqlTag(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  sqlCalls.push({ text: strings.join(" ? "), values });
  const response = rowQueue.shift() ?? [];
  return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
}
// `sql.array(...)` is used by the sprite query; return a marker so it can appear
// as an interpolated value without a real driver.
(sqlTag as unknown as { array: (a: unknown[], t: string) => unknown }).array = (a, t) => ({ __array: a, type: t });

// Stub the FULL runtime export surface of db/client. Bun's mock.module is
// process-wide for the test run, so a partial mock would break the module
// linking of any later test file that imports one of these names.
const scopedMock = createScopedModuleMocker(mock, {
  "@/utils/db/client": realClient,
});

scopedMock.module("@/utils/db/client", () => ({
  ...realClient,
  sql: sqlTag,
  resetDatabaseConnection: () => undefined,
  resolveProductionPostgresTls: () => undefined,
  withTransientDbRetry: async (queryFn: () => Promise<unknown>) => queryFn(),
}));

const { serverMemoryRepository } = await import("@/utils/db/repositories/ServerMemoryRepository");
const { personalMemoryRepository } = await import("@/utils/db/repositories/PersonalMemoryRepository");
const { personaSpriteRepository } = await import("@/utils/db/repositories/PersonaSpriteRepository");

beforeEach(() => {
  sqlCalls.length = 0;
  rowQueue = [];
  clearPersonaSpriteCache();
});

describe("ServerMemoryRepository batched eligibility queries", () => {
  it("personaIdsWithDocuments maps rows to a numeric set and excludes serverwide rows", async () => {
    rowQueue = [[{ persona_id: 10 }, { persona_id: "20" }]];
    const result = await serverMemoryRepository.personaIdsWithDocuments(3);
    expect([...result].sort()).toEqual([10, 20]);
    // Persona scope only: serverwide (persona_id IS NULL) rows are excluded.
    expect(sqlCalls[0]?.text).toContain("persona_id IS NOT NULL");
    // No source_type filter: history documents count here, matching loadDocuments.
    expect(sqlCalls[0]?.text).not.toContain("source_type");
  });

  it("personaIdsWithHistoryDocuments reproduces the history source filter", async () => {
    rowQueue = [[{ persona_id: 5 }]];
    const result = await serverMemoryRepository.personaIdsWithHistoryDocuments(3);
    expect([...result]).toEqual([5]);
    expect(sqlCalls[0]?.text).toContain("source_type = 'history'");
  });

  it("lineageIdsWithServerMemories applies the owner filter only when userId is supplied", async () => {
    rowQueue = [[{ persona_lineage_id: 7 }]];
    await serverMemoryRepository.lineageIdsWithServerMemories(3);
    expect(sqlCalls[0]?.text).not.toContain("user_id");

    sqlCalls.length = 0;
    rowQueue = [[{ persona_lineage_id: 7 }, { persona_lineage_id: 8 }]];
    const scoped = await serverMemoryRepository.lineageIdsWithServerMemories(3, 42);
    expect(sqlCalls[0]?.text).toContain("user_id");
    expect([...scoped].sort()).toEqual([7, 8]);
  });
});

describe("PersonalMemoryRepository batched eligibility query", () => {
  it("lineageIdsWithMemories excludes lineage 0 and maps to a numeric set", async () => {
    rowQueue = [[{ persona_lineage_id: 11 }, { persona_lineage_id: "12" }]];
    const result = await personalMemoryRepository.lineageIdsWithMemories(9);
    expect([...result].sort()).toEqual([11, 12]);
    expect(sqlCalls[0]?.text).toContain("persona_lineage_id <> 0");
  });
});

describe("PersonaSpriteRepository batched eligibility query", () => {
  it("personaIdsWithSprites short-circuits on an empty input without querying", async () => {
    const result = await personaSpriteRepository.personaIdsWithSprites([]);
    expect(result.size).toBe(0);
    expect(sqlCalls).toHaveLength(0);
  });

  it("personaIdsWithSprites resolves preset pointers in bulk rather than a bare GROUP BY", async () => {
    rowQueue = [[{ persona_id: 1 }, { persona_id: "2" }]];
    const result = await personaSpriteRepository.personaIdsWithSprites([1, 2, 3]);
    expect([...result].sort()).toEqual([1, 2]);
    // Both the own-rows branch and the preset-pointer branch must be present.
    expect(sqlCalls[0]?.text).toContain("persona_sprites");
    expect(sqlCalls[0]?.text).toContain("preset_sprites");
    expect(sqlCalls[0]?.text).toContain("is_pointer");
  });

  it("propagates a sprite snapshot read failure instead of returning an empty set", async () => {
    const readError = new Error("sprite snapshot unavailable");
    rowQueue = [readError];

    await expect(personaSpriteRepository.listForPersona(5)).rejects.toBe(readError);
  });

  it("propagates a sprite row deletion failure instead of reporting a no-op", async () => {
    const deleteError = new Error("sprite delete unavailable");
    rowQueue = [deleteError];
    setPersonaSpriteCache(5, []);

    await expect(personaSpriteRepository.deleteAllForPersona(5)).rejects.toBe(deleteError);
    expect(getPersonaSpriteCacheEntry(5)).toEqual([]);
  });
});
