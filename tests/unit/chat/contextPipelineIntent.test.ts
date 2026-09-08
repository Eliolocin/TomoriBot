import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { TomoriState, UserRow } from "@/types/db/schema";
import type { ChatTurn, ChatTurnContext } from "@/utils/chat/types";
import * as realContextPipeline from "@/utils/chat/contextPipeline";
import * as realShortTermMemoryCache from "@/utils/cache/shortTermMemoryCache";
import * as realShortTermMemoryRepository from "@/utils/db/repositories/ShortTermMemoryRepository";
import { createScopedModuleMocker, overrideMembers, stubLogMembers } from "../../helpers/mockSurface";

type FailureSite = "config" | "preWarm" | null;

const baseContext = { streamingContext: {} } as unknown as ChatTurnContext;
const buildBaseChatTurnContextMock = mock(async (_turn: ChatTurn): Promise<ChatTurnContext> => baseContext);
const getStmConfigMock = mock(async () => null);
const preWarmStmEntryMock = mock(async () => undefined);
const getShortTermMemoryForServerChannelMock = mock(() => undefined);
const logErrors: Array<{ message: string; error: unknown; context: unknown }> = [];
let failureSite: FailureSite = null;

const scopedMock = createScopedModuleMocker(mock, {
  "@/utils/chat/contextPipeline": realContextPipeline,
  "@/utils/cache/shortTermMemoryCache": realShortTermMemoryCache,
  "@/utils/db/repositories/ShortTermMemoryRepository": realShortTermMemoryRepository,
});

scopedMock.module("@/utils/chat/contextPipeline", () => ({
  ...realContextPipeline,
  buildChatTurnContext: buildBaseChatTurnContextMock,
}));

scopedMock.module("@/utils/cache/shortTermMemoryCache", () => ({
  ...realShortTermMemoryCache,
  preWarmStmEntry: preWarmStmEntryMock,
  getShortTermMemoryForServerChannel: getShortTermMemoryForServerChannelMock,
}));

scopedMock.module("@/utils/db/repositories/ShortTermMemoryRepository", () => ({
  ...realShortTermMemoryRepository,
  shortTermMemoryRepository: overrideMembers(realShortTermMemoryRepository.shortTermMemoryRepository, {
    getStmConfig: getStmConfigMock,
  }),
}));

stubLogMembers({
  error: async (message: string, error: unknown, context?: unknown) => {
    logErrors.push({ message, error, context });
  },
});

const { buildChatTurnContext } = await import("@/utils/chat/contextPipelineIntent");

function makeTurn(): ChatTurn {
  return {
    persona: {
      server_id: 7,
      persona_id: 42,
      llm: { has_tools: true, llm_provider: "google" },
      config: { deliberate_tool_mode: true, short_term_memory_enabled: true },
    } as TomoriState,
    userRow: { personal_deliberate_tool_mode: "on" } as UserRow,
    userDiscId: "user-1",
    isDMChannel: false,
    isUserImpersonation: false,
    lockedTurn: {
      channelId: "channel-1",
      admission: { incoming: { message: { content: "hello" } } },
    },
  } as unknown as ChatTurn;
}

beforeEach(() => {
  failureSite = null;
  buildBaseChatTurnContextMock.mockClear();
  getStmConfigMock.mockClear();
  preWarmStmEntryMock.mockClear();
  logErrors.length = 0;
});

describe("context pipeline STM maintenance preflight", () => {
  it.each([
    ["getStmConfig", "config"],
    ["preWarmStmEntry", "preWarm"],
  ] as const)("continues with base context when %s fails", async (_name, site) => {
    failureSite = site;
    getStmConfigMock.mockImplementation(async () => {
      if (failureSite === "config") throw new Error("config unavailable");
      return null;
    });
    preWarmStmEntryMock.mockImplementation(async () => {
      if (failureSite === "preWarm") throw new Error("cache unavailable");
    });

    await expect(buildChatTurnContext(makeTurn())).resolves.toBe(baseContext);
    expect(buildBaseChatTurnContextMock).toHaveBeenCalledTimes(1);
    expect(logErrors).toHaveLength(1);
    expect(logErrors[0]?.context).toEqual({
      errorType: "SHORT_TERM_MEMORY_CONTEXT_ERROR",
      metadata: { userDiscId: "user-1", currentChannelId: "channel-1" },
    });
  });
});
