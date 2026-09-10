import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import * as realDbClient from "@/utils/db/client";
import * as realTomoriStateCacheStore from "@/utils/cache/tomoriStateCacheStore";
import * as realUserCache from "@/utils/cache/userCache";
import { adaptV1WorkspaceConfig } from "@/types/db/dataExport";
import { createScopedModuleMocker } from "../../helpers/mockSurface";

type SqlCall = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<readonly Record<string, unknown>[]>;
type UnsafeCall = (query: string, values?: readonly unknown[]) => Promise<readonly Record<string, unknown>[]>;
type Transaction = SqlCall & { unsafe: UnsafeCall };

const workspaceInvalidations: string[] = [];
const userInvalidations: string[] = [];
const committedWrites: string[] = [];
let pendingWrites: string[] = [];
let transactionOpen = false;
let beginCalls = 0;
let unsafeWriteCalls = 0;
let failAtWrite: number | null = null;
let invalidatedDuringWrite = false;

const cacheMocker = createScopedModuleMocker(mock, {
  "@/utils/cache/tomoriStateCacheStore": realTomoriStateCacheStore,
  "@/utils/cache/userCache": realUserCache,
  "@/utils/db/client": realDbClient,
});

const fakeSqlTag: SqlCall = async (strings) => {
  const query = strings.join(" ");
  if (query.includes("FROM users")) return [{ user_id: 11 }];
  if (query.includes("FROM servers")) return [{ server_id: 7 }];
  return [];
};

const fakeUnsafe: UnsafeCall = async (query) => {
  if (query.startsWith("SELECT")) {
    if (query.includes("FROM users")) return [{ user_id: 11 }];
    return [{ server_id: 7 }];
  }

  unsafeWriteCalls += 1;
  invalidatedDuringWrite ||= workspaceInvalidations.length > 0 || userInvalidations.length > 0;
  if (failAtWrite === unsafeWriteCalls) throw new Error("simulated later section failure");
  if (transactionOpen) pendingWrites.push(query);
  else committedWrites.push(query);
  return [{ server_id: 7 }];
};

const fakeBegin = async (callback: (tx: Transaction) => Promise<unknown>): Promise<unknown> => {
  beginCalls += 1;
  pendingWrites = [];
  transactionOpen = true;
  const transaction = Object.assign(fakeSqlTag, { unsafe: fakeUnsafe });
  try {
    const result = await callback(transaction);
    transactionOpen = false;
    committedWrites.push(...pendingWrites);
    return result;
  } catch (error) {
    transactionOpen = false;
    pendingWrites = [];
    throw error;
  }
};

const fakeSql = Object.assign(fakeSqlTag, { begin: fakeBegin, unsafe: fakeUnsafe });

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

beforeAll(async () => {
  ({ importRepository } = await import("@/utils/db/repositories/ImportRepository"));
});

beforeEach(() => {
  workspaceInvalidations.length = 0;
  userInvalidations.length = 0;
  committedWrites.length = 0;
  pendingWrites = [];
  transactionOpen = false;
  beginCalls = 0;
  unsafeWriteCalls = 0;
  failAtWrite = null;
  invalidatedDuringWrite = false;
});

const chatConfig = { llm_temperature: 0.4, llm_logit_biases: [], humanizer_degree: 1, timezone_offset: 8 };

describe("section config imports", () => {
  it("does not open a write transaction for an absent section", async () => {
    const result = await importRepository.importWorkspaceConfig("guild-7", { capabilities: {} }, ["chat"]);

    expect(result.success).toBe(true);
    expect(beginCalls).toBe(0);
    expect(unsafeWriteCalls).toBe(0);
    expect(workspaceInvalidations).toEqual([]);
  });

  it("does not write a present section that the caller did not select", async () => {
    const result = await importRepository.importWorkspaceConfig("guild-7", { chat: chatConfig }, ["access"]);

    expect(result.success).toBe(true);
    expect(beginCalls).toBe(0);
    expect(unsafeWriteCalls).toBe(0);
    expect(workspaceInvalidations).toEqual([]);
  });

  it("rolls back an earlier section when a later section fails", async () => {
    failAtWrite = 2;

    const result = await importRepository.importWorkspaceConfig(
      "guild-7",
      { chat: chatConfig, access: { user_byok_mode: true } },
      ["chat", "access"],
    );

    expect(result.success).toBe(false);
    expect(committedWrites).toEqual([]);
    expect(beginCalls).toBe(1);
    expect(unsafeWriteCalls).toBe(2);
    expect(workspaceInvalidations).toEqual([]);
  });

  it("invalidates the workspace cache only after the transaction commits", async () => {
    const result = await importRepository.importWorkspaceConfig("guild-7", { access: { user_byok_mode: true } }, [
      "access",
    ]);

    expect(result.success).toBe(true);
    expect(invalidatedDuringWrite).toBe(false);
    expect(committedWrites).toHaveLength(1);
    expect(workspaceInvalidations).toEqual(["guild-7"]);
  });

  it("keeps a newer optional column unchanged when importing an adapted v1 section", async () => {
    const adapted = adaptV1WorkspaceConfig({
      llm_temperature: 0.4,
      llm_logit_biases: [],
      humanizer_degree: 1,
      timezone_offset: 8,
      server_memteaching_enabled: true,
    });
    expect(adapted.success).toBe(true);
    if (!adapted.success) return;

    const newerColumn = "prompt_snapshot_enabled";
    let promptSnapshotEnabled = true;
    const originalUnsafe = fakeUnsafe;
    fakeSql.unsafe = async (query, values) => {
      const result = await originalUnsafe(query, values);
      if (query.includes(newerColumn)) promptSnapshotEnabled = false;
      return result;
    };

    const result = await importRepository.importWorkspaceConfig("guild-7", adapted.payload, ["memory"]);

    expect(result.success).toBe(true);
    expect(promptSnapshotEnabled).toBe(true);
    expect(committedWrites.some((query) => query.includes(newerColumn))).toBe(false);
  });

  it("uses the same transaction and post-commit cache ordering for personal sections", async () => {
    const result = await importRepository.importPersonalConfig(
      "user-11",
      { profile: { user_nickname: "Ada", language_pref: "en-US" } },
      ["profile"],
    );

    expect(result.success).toBe(true);
    expect(beginCalls).toBe(1);
    expect(invalidatedDuringWrite).toBe(false);
    expect(userInvalidations).toEqual(["user-11"]);
  });
});
