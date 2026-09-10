import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import * as realDbClient from "@/utils/db/client";
import * as realTomoriStateCacheStore from "@/utils/cache/tomoriStateCacheStore";
import * as realUserCache from "@/utils/cache/userCache";
import { createScopedModuleMocker } from "../../helpers/mockSurface";

type SqlCall = <T extends readonly Record<string, unknown>[]>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T>;
type UnsafeCall = (query: string, values?: readonly unknown[]) => Promise<readonly Record<string, unknown>[]>;
type Transaction = SqlCall & { unsafe: UnsafeCall; array: (values: unknown[], type?: string) => unknown[] };
type MemoryRow = { content: string; tags: string[] };
type TransactionId = number | "outside";
type RecordedWrite = { query: string; transactionId: TransactionId };
type PersonaRow = { persona_id: number; persona_lineage_id: number; server_id: number };
type MemoryInsert = {
  table: "server_memories" | "personal_memories";
  transactionId: TransactionId;
  userId: number;
  personaId?: number;
  personaLineageId: number;
  content: string;
  tags: string[];
};

const workspaceInvalidations: string[] = [];
const userInvalidations: string[] = [];
const committedWrites: RecordedWrite[] = [];
const pendingWrites: RecordedWrite[] = [];
const committedInserts: MemoryInsert[] = [];
const pendingInserts: MemoryInsert[] = [];
const serverRows = new Map<number, MemoryRow[]>();
const personalRows = new Map<number, MemoryRow[]>();
const personas = new Map<number, PersonaRow>();

let serverExists = true;
let transactionOpen = false;
let currentTransactionId: TransactionId = "outside";
let nextTransactionId = 1;
let failAtInsert: number | null = null;
let insertCalls = 0;
let invalidatedDuringWrite = false;
const importerUserId = 22;
const earlierUserId = 3;

const cacheMocker = createScopedModuleMocker(mock, {
  "@/utils/cache/tomoriStateCacheStore": realTomoriStateCacheStore,
  "@/utils/cache/userCache": realUserCache,
  "@/utils/db/client": realDbClient,
});

function queryText(strings: TemplateStringsArray): string {
  return strings.join(" ").replace(/\s+/gu, " ").trim();
}

function rowsForDelete(table: "server_memories" | "personal_memories", lineageId: number): Record<string, number>[] {
  const rows = table === "server_memories" ? (serverRows.get(lineageId) ?? []) : (personalRows.get(lineageId) ?? []);
  const idColumn = table === "server_memories" ? "server_memory_id" : "personal_memory_id";
  return rows.map((_, index) => ({ [idColumn]: index + 1 }));
}

function recordMemoryWrite(query: string, values: unknown[]): void {
  invalidatedDuringWrite ||= workspaceInvalidations.length > 0 || userInvalidations.length > 0;
  const transactionId = transactionOpen ? currentTransactionId : "outside";
  if (query.startsWith("INSERT INTO server_memories")) {
    insertCalls += 1;
    if (failAtInsert === insertCalls) throw new Error("simulated insert failure");
    const [serverId, personaId, personaLineageId, userId, content, tags] = values;
    if (serverId !== 7) throw new Error("unexpected server id");
    const insert: MemoryInsert = {
      table: "server_memories",
      transactionId,
      userId: Number(userId),
      personaId: Number(personaId),
      personaLineageId: Number(personaLineageId),
      content: String(content),
      tags: tags as string[],
    };
    if (transactionOpen) pendingInserts.push(insert);
    else committedInserts.push(insert);
  } else if (query.startsWith("INSERT INTO personal_memories")) {
    insertCalls += 1;
    if (failAtInsert === insertCalls) throw new Error("simulated insert failure");
    const [userId, personaLineageId, content, tags] = values;
    const insert: MemoryInsert = {
      table: "personal_memories",
      transactionId,
      userId: Number(userId),
      personaLineageId: Number(personaLineageId),
      content: String(content),
      tags: tags as string[],
    };
    if (transactionOpen) pendingInserts.push(insert);
    else committedInserts.push(insert);
  }

  const write = { query, transactionId };
  if (transactionOpen) pendingWrites.push(write);
  else committedWrites.push(write);
}

const fakeSqlTag = (async <T extends readonly Record<string, unknown>[] = Record<string, unknown>[]>(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<T> => {
  const query = queryText(strings);
  if (query.startsWith("DELETE FROM server_memories")) {
    recordMemoryWrite(query, values);
    return rowsForDelete("server_memories", Number(values[1])) as T;
  }
  if (query.startsWith("DELETE FROM personal_memories")) {
    recordMemoryWrite(query, values);
    return rowsForDelete("personal_memories", Number(values[1])) as T;
  }
  if (query.includes("FROM servers")) return (serverExists ? [{ server_id: 7 }] : []) as T;
  if (query.includes("FROM personas")) {
    const persona = personas.get(Number(values[0]));
    return persona?.server_id === Number(values[1]) ? ([persona] as T) : ([] as Record<string, unknown>[] as T);
  }
  if (query.includes("FROM server_memories")) return (serverRows.get(Number(values[1])) ?? []) as T;
  if (query.includes("FROM personal_memories")) return (personalRows.get(Number(values[1])) ?? []) as T;
  if (query.includes("FROM users")) return [{ user_id: earlierUserId }] as T;
  if (query.startsWith("INSERT INTO users")) return [{ user_id: importerUserId }] as T;
  if (query.startsWith("INSERT INTO server_memories") || query.startsWith("INSERT INTO personal_memories")) {
    recordMemoryWrite(query, values);
    return [] as T;
  }
  return [] as T;
}) as SqlCall;

const fakeUnsafe: UnsafeCall = async () => [];
const fakeBegin = async <T>(callback: (tx: Transaction) => Promise<T>): Promise<T> => {
  const transactionId = nextTransactionId;
  nextTransactionId += 1;
  pendingWrites.length = 0;
  pendingInserts.length = 0;
  transactionOpen = true;
  currentTransactionId = transactionId;
  const transaction = Object.assign(fakeSqlTag, { unsafe: fakeUnsafe, array: (values: unknown[]) => values });
  try {
    const result = await callback(transaction);
    transactionOpen = false;
    currentTransactionId = "outside";
    committedWrites.push(...pendingWrites);
    committedInserts.push(...pendingInserts);
    pendingWrites.length = 0;
    pendingInserts.length = 0;
    return result;
  } catch (error) {
    transactionOpen = false;
    currentTransactionId = "outside";
    pendingWrites.length = 0;
    pendingInserts.length = 0;
    throw error;
  }
};

const fakeSql = Object.assign(fakeSqlTag, {
  begin: fakeBegin,
  unsafe: fakeUnsafe,
  array: (values: unknown[]) => values,
});

cacheMocker.module("@/utils/db/client", () => ({ ...realDbClient, sql: fakeSql }));
cacheMocker.module("@/utils/cache/tomoriStateCacheStore", () => ({
  ...realTomoriStateCacheStore,
  invalidateTomoriStateCache: (serverDiscId: string) => workspaceInvalidations.push(serverDiscId),
}));
cacheMocker.module("@/utils/cache/userCache", () => ({
  ...realUserCache,
  invalidateUserCache: (userDiscId: string) => userInvalidations.push(userDiscId),
}));

let importRepository: typeof import("@/utils/db/repositories/ImportRepository").importRepository;
let originalServerLimit: string | undefined;
let originalPersonalLimit: string | undefined;

function memory(content: string, tags: string[] = []): { content: string; tags: string[] } {
  return { content, tags };
}

function setLimit(name: "MAX_SERVER_MEMORIES" | "MAX_PERSONAL_MEMORIES", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(async () => {
  originalServerLimit = process.env.MAX_SERVER_MEMORIES;
  originalPersonalLimit = process.env.MAX_PERSONAL_MEMORIES;
  ({ importRepository } = await import("@/utils/db/repositories/ImportRepository"));
});

afterAll(() => {
  setLimit("MAX_SERVER_MEMORIES", originalServerLimit);
  setLimit("MAX_PERSONAL_MEMORIES", originalPersonalLimit);
});

beforeEach(() => {
  workspaceInvalidations.length = 0;
  userInvalidations.length = 0;
  committedWrites.length = 0;
  pendingWrites.length = 0;
  committedInserts.length = 0;
  pendingInserts.length = 0;
  serverRows.clear();
  personalRows.clear();
  personas.clear();
  personas.set(1, { persona_id: 1, persona_lineage_id: 10, server_id: 7 });
  personas.set(2, { persona_id: 2, persona_lineage_id: 20, server_id: 7 });
  personas.set(3, { persona_id: 3, persona_lineage_id: 10, server_id: 7 });
  personas.set(99, { persona_id: 99, persona_lineage_id: 99, server_id: 8 });
  serverExists = true;
  transactionOpen = false;
  currentTransactionId = "outside";
  nextTransactionId = 1;
  failAtInsert = null;
  insertCalls = 0;
  invalidatedDuringWrite = false;
  setLimit("MAX_SERVER_MEMORIES", originalServerLimit);
  setLimit("MAX_PERSONAL_MEMORIES", originalPersonalLimit);
});

function memoryWrites(): RecordedWrite[] {
  return [...committedWrites, ...pendingWrites];
}

function expectMemoryWritesInOneTransaction(): void {
  const writes = memoryWrites();
  expect(writes.length).toBeGreaterThan(0);
  const transactionId = writes[0]?.transactionId;
  expect(writes.every((write) => write.transactionId === transactionId)).toBe(true);
  expect(transactionId).not.toBe("outside");
}

describe("memory bundle imports", () => {
  it("merges normalized existing and incoming duplicates", async () => {
    serverRows.set(10, [memory(" existing memory ", ["tag-b", "tag-a"])]);
    const result = await importRepository.importWorkspaceMemoryBundle(
      "server-7",
      "importer-22",
      [
        {
          bucketName: "bucket-10",
          personaId: 1,
          memories: [
            memory("existing   memory", ["tag-a", "tag-b"]),
            memory("new memory", ["new"]),
            memory(" new   memory ", ["new"]),
          ],
        },
      ],
      "merge",
    );

    expect(result).toEqual({
      success: true,
      itemsImported: { memoriesInserted: 1, memoriesSkipped: 2, memoriesDeleted: 0, memoriesCount: 1 },
    });
    expect(memoryWrites().some(({ query }) => query.startsWith("DELETE FROM"))).toBe(false);
    expect(committedInserts).toHaveLength(1);
    expect(committedInserts[0]?.content).toBe("new memory");
  });

  it("replaces only mapped scopes and clears an empty mapped scope", async () => {
    serverRows.set(10, [memory("old-10")]);
    serverRows.set(20, [memory("old-20")]);
    serverRows.set(99, [memory("unmapped")]);
    const result = await importRepository.importWorkspaceMemoryBundle(
      "server-7",
      "importer-22",
      [
        { bucketName: "bucket-10", personaId: 1, memories: [memory("new-10")] },
        { bucketName: "bucket-20", personaId: 2, memories: [] },
      ],
      "replace",
    );

    expect(result.success).toBe(true);
    expect(result.itemsImported).toMatchObject({
      memoriesInserted: 1,
      memoriesSkipped: 0,
      memoriesDeleted: 2,
      memoriesCount: 1,
    });
    const deletes = memoryWrites().filter((write) => write.query.startsWith("DELETE FROM server_memories"));
    expect(deletes).toHaveLength(2);
    expect(deletes.every(({ query }) => !query.includes("99"))).toBe(true);
    expect(committedInserts).toHaveLength(1);
  });

  it("attributes every workspace insert to the importer", async () => {
    const result = await importRepository.importWorkspaceMemoryBundle(
      "server-7",
      "importer-22",
      [{ bucketName: "bucket-10", personaId: 1, memories: [memory("attributed")] }],
      "replace",
    );

    expect(result.success).toBe(true);
    expect(committedInserts[0]).toMatchObject({ table: "server_memories", userId: importerUserId });
  });

  it("invalidates workspace cache after the transaction commits", async () => {
    await importRepository.importWorkspaceMemoryBundle(
      "server-7",
      "importer-22",
      [{ bucketName: "bucket-10", personaId: 1, memories: [memory("workspace")] }],
      "merge",
    );

    expect(invalidatedDuringWrite).toBe(false);
    expect(workspaceInvalidations).toEqual(["server-7"]);
  });

  it("invalidates personal cache after the transaction commits", async () => {
    const result = await importRepository.importPersonalMemoryBundle(
      "user-22",
      [{ bucketName: "bucket-10", personaLineageId: 10, memories: [memory("personal")] }],
      "merge",
    );

    expect(result.success).toBe(true);
    expect(invalidatedDuringWrite).toBe(false);
    expect(userInvalidations).toEqual(["user-22"]);
  });

  it("rolls back deletes when a later insert fails", async () => {
    failAtInsert = 2;
    const result = await importRepository.importWorkspaceMemoryBundle(
      "server-7",
      "importer-22",
      [
        { bucketName: "bucket-10", personaId: 1, memories: [memory("one")] },
        { bucketName: "bucket-20", personaId: 2, memories: [memory("two")] },
      ],
      "replace",
    );

    expect(result).toEqual({ success: false, error: "commands.data.import.error_import_failed" });
    expect(memoryWrites().some(({ query }) => query.startsWith("DELETE FROM"))).toBe(false);
    expect(memoryWrites().some(({ query }) => query.startsWith("INSERT INTO server_memories"))).toBe(false);
  });

  it("rejects duplicate destinations without touching memory rows", async () => {
    const result = await importRepository.importWorkspaceMemoryBundle(
      "server-7",
      "importer-22",
      [
        { bucketName: "first", personaId: 1, memories: [] },
        { bucketName: "second", personaId: 3, memories: [] },
      ],
      "replace",
    );

    expect(result.success).toBe(false);
    expect(memoryWrites()).toHaveLength(0);
  });

  it("rejects a persona belonging to another server without touching memory rows", async () => {
    const result = await importRepository.importWorkspaceMemoryBundle(
      "server-7",
      "importer-22",
      [{ bucketName: "foreign", personaId: 99, memories: [] }],
      "replace",
    );

    expect(result.success).toBe(false);
    expect(memoryWrites()).toHaveLength(0);
  });

  it("refuses empty mapping bundles without touching memory rows", async () => {
    const workspaceResult = await importRepository.importWorkspaceMemoryBundle(
      "server-7",
      "importer-22",
      [],
      "replace",
    );
    const personalResult = await importRepository.importPersonalMemoryBundle("user-22", [], "replace");

    expect(workspaceResult).toEqual({
      success: false,
      error: "commands.data.import.error_update_failed",
    });
    expect(personalResult).toEqual({
      success: false,
      error: "commands.data.import.error_update_failed",
    });
    expect(memoryWrites()).toHaveLength(0);
  });

  it("enforces the workspace lineage limit and accepts an exact landing", async () => {
    setLimit("MAX_SERVER_MEMORIES", "2");
    serverRows.set(10, [memory("existing")]);
    const refused = await importRepository.importWorkspaceMemoryBundle(
      "server-7",
      "importer-22",
      [{ bucketName: "overflow", personaId: 1, memories: [memory("one"), memory("two")] }],
      "merge",
    );
    expect(refused.success).toBe(false);
    expect(memoryWrites()).toHaveLength(0);

    serverRows.set(10, [memory("existing")]);
    const exact = await importRepository.importWorkspaceMemoryBundle(
      "server-7",
      "importer-22",
      [{ bucketName: "exact", personaId: 1, memories: [memory("one")] }],
      "merge",
    );
    expect(exact.success).toBe(true);
    expectMemoryWritesInOneTransaction();
  });

  it("enforces the personal lineage limit", async () => {
    setLimit("MAX_PERSONAL_MEMORIES", "1");
    personalRows.set(10, [memory("existing")]);
    const refused = await importRepository.importPersonalMemoryBundle(
      "user-22",
      [{ bucketName: "overflow", personaLineageId: 10, memories: [memory("new")] }],
      "merge",
    );
    expect(refused.success).toBe(false);
    expect(memoryWrites()).toHaveLength(0);

    personalRows.set(10, []);
    const exact = await importRepository.importPersonalMemoryBundle(
      "user-22",
      [{ bucketName: "exact", personaLineageId: 10, memories: [memory("new")] }],
      "merge",
    );
    expect(exact.success).toBe(true);
    expectMemoryWritesInOneTransaction();
  });

  it("writes every mapped destination in one transaction", async () => {
    const result = await importRepository.importWorkspaceMemoryBundle(
      "server-7",
      "importer-22",
      [
        { bucketName: "bucket-10", personaId: 1, memories: [memory("one")] },
        { bucketName: "bucket-20", personaId: 2, memories: [memory("two")] },
      ],
      "merge",
    );

    expect(result.success).toBe(true);
    expectMemoryWritesInOneTransaction();
    expect(committedInserts).toHaveLength(2);
  });
});
