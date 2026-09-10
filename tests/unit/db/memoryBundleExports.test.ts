import { beforeEach, describe, expect, it } from "bun:test";
import type { sql } from "@/utils/db/client";
import {
  personalMemoriesV2ExportSchema,
  workspaceMemoriesExportSchema,
  type ExportResult,
} from "@/types/db/dataExport";
import { ExportRepository } from "@/utils/db/repositories/ExportRepository";

type DatabaseId = number | string | bigint;

interface MemoryFixtureRow {
  content: string;
  tags: string[];
  persona_lineage_id?: DatabaseId;
}

interface PersonaFixtureRow {
  persona_id: number;
  persona_lineage_id: DatabaseId;
  persona_nickname: string | null;
}

const queryLog: string[] = [];

let missingPersona = false;
let serverMemoryRows: MemoryFixtureRow[];
let personalMemoryRows: MemoryFixtureRow[];
let personaLabels: PersonaFixtureRow[];

function resetFixtures(): void {
  missingPersona = false;
  serverMemoryRows = [
    { persona_lineage_id: "1", content: "server one\u0000\u0001", tags: ["one"] },
    { persona_lineage_id: 2n, content: "server two", tags: ["two"] },
    { persona_lineage_id: 3, content: "server three", tags: ["three"] },
  ];
  personalMemoryRows = [
    { persona_lineage_id: 2, content: "personal two", tags: ["two"] },
    { persona_lineage_id: 0, content: "global memory", tags: ["global"] },
    { persona_lineage_id: "1", content: "personal one", tags: ["one"] },
  ];
  personaLabels = [
    { persona_id: 101, persona_lineage_id: 1, persona_nickname: "Shared Name" },
    { persona_id: 102, persona_lineage_id: 2, persona_nickname: "Shared Name" },
    { persona_id: 103, persona_lineage_id: 3, persona_nickname: null },
  ];
}

const fakeSql = ((strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> => {
  const query = strings.join(" ? ").replace(/\s+/g, " ").trim();
  queryLog.push(query);

  if (query.includes("FROM servers")) return Promise.resolve([{ server_id: 42 }]);
  if (query.includes("FROM users")) return Promise.resolve([{ user_id: 7 }]);
  if (query.includes("FROM server_memories")) {
    if (query.includes("persona_lineage_id =")) {
      return Promise.resolve([{ content: "selected server\u0002 memory", tags: ["selected"] }]);
    }
    return Promise.resolve(serverMemoryRows);
  }
  if (query.includes("FROM personal_memories")) {
    if (query.includes("persona_lineage_id =")) {
      return Promise.resolve([{ content: "selected personal", tags: ["selected"] }]);
    }
    return Promise.resolve(personalMemoryRows);
  }
  if (query.includes("FROM personas")) {
    if (query.includes("is_alter = false")) {
      return Promise.resolve([{ persona_id: 101, persona_lineage_id: "1", persona_nickname: "Main Persona" }]);
    }
    if (query.includes("persona_id =")) {
      return missingPersona
        ? Promise.resolve([])
        : Promise.resolve([{ persona_id: 102, persona_lineage_id: 2n, persona_nickname: "Selected Persona" }]);
    }
    return Promise.resolve(personaLabels);
  }
  return Promise.resolve([]);
}) as unknown as typeof sql;

function freshRepository(): ExportRepository {
  queryLog.length = 0;
  return new ExportRepository(fakeSql);
}

function objectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) objectKeys(item, keys);
    return keys;
  }
  if (typeof value !== "object" || value === null) return keys;

  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    objectKeys(child, keys);
  }
  return keys;
}

function expectSuccess(result: ExportResult): NonNullable<ExportResult["data"]> {
  expect(result.success).toBe(true);
  if (!result.success || !result.data) throw new Error("Expected export success");
  return result.data;
}

beforeEach(resetFixtures);

describe("v2 memory bundle exports", () => {
  it("emits all six scopes that parse against their real schemas", async () => {
    const workspaceScopes = [
      { scope: { mode: "main" } as const, names: ["main"] },
      { scope: { mode: "persona", personaId: 102 } as const, names: ["persona"] },
      { scope: { mode: "all" } as const, names: ["persona-1", "persona-2", "persona-3"] },
    ];
    for (const { scope, names } of workspaceScopes) {
      const result = await freshRepository().exportWorkspaceMemories("workspace-disc-id", scope);
      const data = expectSuccess(result);
      const parsed = workspaceMemoriesExportSchema.safeParse(data);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.data.buckets.map((bucket) => bucket.name)).toEqual(names);
    }

    const personalScopes = [
      { scope: { mode: "global" } as const, names: ["global"] },
      { scope: { mode: "persona", personaLineageId: 2 } as const, names: ["persona"] },
      { scope: { mode: "all" } as const, names: ["global", "persona-1", "persona-2"] },
    ];
    for (const { scope, names } of personalScopes) {
      const result = await freshRepository().exportPersonalMemories("user-disc-id", scope);
      const data = expectSuccess(result);
      const parsed = personalMemoriesV2ExportSchema.safeParse(data);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.data.buckets.map((bucket) => bucket.name)).toEqual(names);
    }
  });

  it("keeps grouped reads at three queries as lineage count grows", async () => {
    const first = await freshRepository().exportWorkspaceMemories("workspace-disc-id", { mode: "all" });
    expectSuccess(first);
    expect(queryLog).toHaveLength(3);

    serverMemoryRows.push({ persona_lineage_id: 4, content: "server four", tags: ["four"] });
    personaLabels.push({ persona_id: 104, persona_lineage_id: 4, persona_nickname: "Fourth" });
    queryLog.length = 0;

    const second = await freshRepository().exportWorkspaceMemories("workspace-disc-id", { mode: "all" });
    expectSuccess(second);
    expect(queryLog).toHaveLength(3);
  });

  it("does not expose database identifiers in buckets or memories", async () => {
    const results = [
      await freshRepository().exportWorkspaceMemories("workspace-disc-id", { mode: "main" }),
      await freshRepository().exportWorkspaceMemories("workspace-disc-id", { mode: "persona", personaId: 102 }),
      await freshRepository().exportWorkspaceMemories("workspace-disc-id", { mode: "all" }),
      await freshRepository().exportPersonalMemories("user-disc-id", { mode: "global" }),
      await freshRepository().exportPersonalMemories("user-disc-id", { mode: "persona", personaLineageId: 2 }),
      await freshRepository().exportPersonalMemories("user-disc-id", { mode: "all" }),
    ];
    const forbiddenKeys = new Set([
      "persona_lineage_id",
      "persona_id",
      "user_id",
      "server_id",
      "id",
      "created_at",
      "embedding",
    ]);

    for (const result of results) {
      const keys = objectKeys(expectSuccess(result));
      for (const key of forbiddenKeys) expect(keys.has(key)).toBe(false);
    }
  });

  it("sanitizes control characters in stored memory content", async () => {
    const result = await freshRepository().exportWorkspaceMemories("workspace-disc-id", { mode: "main" });
    const data = expectSuccess(result);
    const parsed = workspaceMemoriesExportSchema.parse(data);

    expect(parsed.data.buckets[0]?.memories[0]).toEqual({ content: "selected server memory", tags: ["selected"] });
  });

  it("returns the owner error without a file when all memories are empty", async () => {
    serverMemoryRows = [];
    const workspaceResult = await freshRepository().exportWorkspaceMemories("workspace-disc-id", { mode: "all" });
    expect(workspaceResult).toEqual({ success: false, error: "commands.data.export.error_no_server_data" });

    personalMemoryRows = [];
    const personalResult = await freshRepository().exportPersonalMemories("user-disc-id", { mode: "all" });
    expect(personalResult).toEqual({ success: false, error: "commands.data.export.error_no_user_data" });
  });

  it("rejects a persona from another server before reading memories", async () => {
    missingPersona = true;
    const result = await freshRepository().exportWorkspaceMemories("workspace-disc-id", {
      mode: "persona",
      personaId: 999,
    });

    expect(result).toEqual({ success: false, error: "commands.data.export.error_no_server_data" });
    expect(queryLog.some((query) => query.includes("FROM server_memories"))).toBe(false);
  });

  it("numbers a nameless grouped bucket by its persona ordinal, not its bucket position", async () => {
    personalMemoryRows.push({ persona_lineage_id: 3, content: "personal three", tags: ["three"] });

    const result = await freshRepository().exportPersonalMemories("user-disc-id", { mode: "all" });
    const parsed = personalMemoriesV2ExportSchema.parse(expectSuccess(result));

    expect(parsed.data.buckets.map(({ name, label }) => [name, label])).toEqual([
      ["global", "Global"],
      ["persona-1", "Shared Name"],
      ["persona-2", "Shared Name"],
      ["persona-3", "Persona 3"],
    ]);
  });

  it("keeps grouped bucket names and labels deterministic", async () => {
    const first = await freshRepository().exportPersonalMemories("user-disc-id", { mode: "all" });
    const firstData = personalMemoriesV2ExportSchema.parse(expectSuccess(first));
    const firstBuckets = firstData.data.buckets.map(({ name, label }) => ({ name, label }));

    const second = await freshRepository().exportPersonalMemories("user-disc-id", { mode: "all" });
    const secondData = personalMemoriesV2ExportSchema.parse(expectSuccess(second));
    const secondBuckets = secondData.data.buckets.map(({ name, label }) => ({ name, label }));

    expect(secondBuckets).toEqual(firstBuckets);
  });
});
