import { beforeEach, describe, expect, it, mock } from "bun:test";
// Captured BEFORE the `mock.module` calls below run. Static imports are
// evaluated at link time, ahead of any top-level statement, so this binds the
// REAL deliberateToolMode module; we re-register it in afterAll to undo the
// simplified stub for files loaded later in the monolithic run.
import * as realDeliberateToolMode from "@/utils/tools/deliberateToolMode";
// Same link-time capture for every other module mocked below. Spreading these
// namespaces makes each factory full-surface, so a partial mock can never break
// the module linking of a file loaded later in the monolithic `bun test`.
import * as realToolRegistry from "@/tools/toolRegistry";
import * as realChannelQueue from "@/utils/chat/channelQueue";
import * as realContextAnnotations from "@/utils/chat/contextAnnotations";
import * as realEmbedHelper from "@/utils/discord/embedHelper";
import * as realStreamOrchestrator from "@/utils/discord/streamOrchestrator";
import * as realToolProgressNotice from "@/utils/discord/toolProgressNotice";
import * as realProviderInfoRegistry from "@/utils/provider/providerInfoRegistry";
import { createScopedModuleMocker, overrideMembers, stubLogMembers } from "../../helpers/mockSurface";
import type { LLMProvider, ProviderConfig, StreamResult } from "@/types/provider/interfaces";
import type { ChatTurnContext } from "@/utils/chat/types";
import type { TomoriState } from "@/types/db/schema";
import type { ToolResult } from "@/types/tool/interfaces";
import type { ToolLoopParams } from "@/utils/chat/toolLoop";

// Set env vars before any lazy import so module-level constants pick them up.
process.env.BOT_MAX_FUNCTION_CALL_ITERATIONS = "100";
process.env.BOT_MAX_CONSECUTIVE_TOOL_ERRORS = "5";
process.env.NAI_TOOL_FAILURE_RETRY_THRESHOLD = "3";

let toolExecuteCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let toolExecuteQueue: ToolResult[] = [];
let requiresFollowUp = false;
let requiresFollowUpCalls: Array<{ name: string; provider: string; serverId?: number }> = [];
let hasStopRequest = false;
let isFollowUpRequest = false;
let clearStopRequestCalls = 0;
let standardEmbedCalls: Array<{ titleKey?: string; descriptionKey?: string }> = [];
let hiddenToolNotices: string[] = [];

// Module mocks: all must appear before the first lazy import of toolLoop.ts

// The real `ColorCode` enum comes through the spread, so its values stay the hex
// STRINGS other modules rely on at load time (e.g. contextEmbeds.ts calls
// ColorCode.ERROR.replace("#", "")). Only `log` is silenced.
const scopedMock = createScopedModuleMocker(mock, {
  "@/utils/discord/embedHelper": realEmbedHelper,
  "@/utils/discord/toolProgressNotice": realToolProgressNotice,
  "@/utils/discord/streamOrchestrator": realStreamOrchestrator,
  "@/utils/provider/providerInfoRegistry": realProviderInfoRegistry,
  "@/utils/tools/deliberateToolMode": realDeliberateToolMode,
  "@/utils/chat/channelQueue": realChannelQueue,
  "@/utils/chat/contextAnnotations": realContextAnnotations,
  "@/tools/toolRegistry": realToolRegistry,
});

stubLogMembers({
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  success: () => undefined,
  section: () => undefined,
});

scopedMock.module("@/utils/discord/embedHelper", () => ({
  ...realEmbedHelper,
  sendStandardEmbed: async (
    _channel: unknown,
    _locale: string,
    options: { titleKey?: string; descriptionKey?: string },
  ) => {
    standardEmbedCalls.push(options);
  },
}));

scopedMock.module("@/utils/discord/toolProgressNotice", () => ({
  ...realToolProgressNotice,
  routeHiddenToolNotice: async (_context: unknown, embed: { description?: string }) => {
    hiddenToolNotices.push(embed.description ?? "");
  },
}));

scopedMock.module("@/utils/discord/streamOrchestrator", () => ({
  ...realStreamOrchestrator,
  // Statics are non-enumerable, so a spread would drop the whole class surface.
  StreamOrchestrator: overrideMembers(realStreamOrchestrator.StreamOrchestrator, {
    hasStopRequest: (_channelId: string) => hasStopRequest,
    isFollowUpRequest: (_channelId: string) => isFollowUpRequest,
    clearStopRequest: (_channelId: string) => {
      clearStopRequestCalls += 1;
      hasStopRequest = false;
    },
    getAndClearStopContext: (_channelId: string) => null,
  }),
}));

scopedMock.module("@/utils/provider/providerInfoRegistry", () => ({
  ...realProviderInfoRegistry,
  providerUsesApiFamily: (providerName: string, apiFamily: string) => {
    const families: Record<string, string> = {
      google: "google-genai",
      novelai: "novelai",
      openrouter: "openai-compatible",
    };
    return families[providerName.toLowerCase()] === apiFamily;
  },
}));

// Pass through to the REAL deliberateToolMode (captured at link time above).
// toolLoop.ts never calls these functions: it reads deliberate-mode data from
// `context` so the loop tests don't need a behavioral stub here; the mock
// exists only to satisfy transitive linking. Returning the real exports keeps
// the mock harmless if it leaks into a later file in the monolithic `bun test`
// (e.g. deliberateToolMode.test.ts, which asserts the real behavior). Spreading
// a statically-captured namespace is safe; unlike `await import()` inside a
// factory, it was evaluated before any mock.module call took effect.
scopedMock.module("@/utils/tools/deliberateToolMode", () => ({ ...realDeliberateToolMode }));

scopedMock.module("@/utils/chat/channelQueue", () => ({
  ...realChannelQueue,
  channelLocks: new Map(),
  setChannelStreamKill: () => undefined,
  setChannelToolCallChainActive: () => undefined,
  getChannelTurnAbortSignal: () => undefined,
  incrementChannelFollowUpCount: () => undefined,
  resetChannelFollowUpCount: () => undefined,
  queueStopResponseAtFront: () => undefined,
}));

// Only the annotation entry point needs an inert stub for the loop tests; every
// other export passes through to the real module so this mock stays harmless
// when it leaks into a later file (e.g. contextMedia -> formatInlineSystemContent).
scopedMock.module("@/utils/chat/contextAnnotations", () => ({
  ...realContextAnnotations,
  annotateRecentMessageMetadataInContext: () => ({ annotatedCount: 0, patchedReplyReferenceCount: 0 }),
}));

// The ToolRegistry singleton: executeTool drains toolExecuteQueue.
scopedMock.module("@/tools/toolRegistry", () => ({
  ...realToolRegistry,
  // A class instance: its methods live on the prototype, so delegate rather
  // than spread or the remaining registry methods vanish for later files.
  ToolRegistry: overrideMembers(realToolRegistry.ToolRegistry, {
    executeTool: async (name: string, args: Record<string, unknown>) => {
      toolExecuteCalls.push({ name, args });
      const next = toolExecuteQueue.shift();
      return next ?? { success: true, data: { result: "ok" } };
    },
    requiresFollowUp: async (name: string, provider: string, serverId?: number) => {
      requiresFollowUpCalls.push({ name, provider, serverId });
      return requiresFollowUp;
    },
  }),
}));

function makeTomoriState(): TomoriState {
  return {
    server_id: 1,
    persona_id: 42,
    persona_lineage_id: 420,
    persona_nickname: "TestBot",
    is_alter: false,
    llm: {
      llm_codename: "test-model",
      has_tools: true,
      sees_images: false,
      sees_videos: false,
      sees_youtube: false,
      supports_structoutput: false,
    },
    config: {
      api_key: "test-key",
      key_version: 1,
      llm_temperature: 0.7,
      private_channel_ids: [],
      tool_notice_hidden_keys: [],
    },
  } as unknown as TomoriState;
}

function makeContext(): ChatTurnContext {
  const channel = { id: "ch_test" };
  const tomoriState = makeTomoriState();
  return {
    channel,
    client: {},
    guild: null,
    locale: "en-US",
    message: { id: "msg_1", channel },
    contextItems: [],
    simplifiedMessages: [],
    messageIdMap: new Map(),
    emojiStrings: [],
    loadedEmojis: null,
    loadedStickers: null,
    channelName: "test-channel",
    channelDescription: null,
    serverDiscId: "server_1",
    serverName: "Test Server",
    serverDescription: null,
    userDiscId: "user_1",
    triggererName: "TestUser",
    textCredentialSource: "server",
    personalRoutingUserId: null,
    personalTextProvider: null,
    shouldApplyTextQuota: false,
    textQuotaTriggerKey: "turn_1",
    textQuotaState: null,
    // Disable user-facing embeds so sendStandardEmbed is never called for routing issues.
    shouldSurfaceUserErrors: false,
    isDMChannel: false,
    isFromQueue: true,
    isStopResponse: false,
    isPersonaJob: false,
    isSelfMessage: false,
    isUserImpersonation: false,
    allPersonas: [],
    currentPersona: tomoriState,
    tomoriState,
    requestSnapshot: {},
    streamingContext: { disableYouTubeProcessing: false },
    deliberateToolModeActive: false,
    deliberateToolContextTurns: 0,
    deliberateToolTriggerMatchByToolName: new Map(),
    responseTarget: undefined,
    turn: {
      lockedTurn: {
        channelId: "ch_test",
        admission: { incoming: { retryCount: 0 } },
        lockedAt: Date.now(),
        queueDepth: 0,
        skipLock: false,
      },
    },
  } as unknown as ChatTurnContext;
}

function makeProviderConfig(): ProviderConfig {
  return { model: "test-model", apiKey: "test-key", temperature: 0.7 };
}

/** Function-call stream result: simulates the provider requesting a tool. */
function makeFunctionCallResult(
  name: string,
  args: Record<string, unknown> = {},
  accumulatedText?: string,
): StreamResult {
  return { status: "function_call", data: { name, args }, accumulatedText };
}

/**
 * Creates a fake LLMProvider whose streamToDiscord pops from a result queue.
 * Returns the provider and an array that accumulates every functionInteractionHistory
 * array passed to each call, so tests can verify what the provider sees.
 */
function makeProvider(
  results: StreamResult[],
  providerName = "test-provider",
  simulateBufferedTextParts = false,
): {
  provider: LLMProvider;
  capturedHistories: Array<unknown[]>;
  capturedModelParts: Array<Array<Record<string, unknown>>>;
} {
  const capturedHistories: Array<unknown[]> = [];
  const capturedModelParts: Array<Array<Record<string, unknown>>> = [];
  const queue = [...results];

  const provider = {
    getInfo: () => ({
      name: providerName,
      displayName: "Test Provider",
      supportedModels: ["test-model"],
      requiresApiKey: false,
      supportsStreaming: true,
      supportsFunctionCalling: true,
      supportsImages: false,
      supportsVideos: false,
      apiFamily: "openai-compatible",
      supportedParams: [],
      featureSupport: {
        imageGeneration: "none",
        videoGeneration: "none",
        embeddings: false,
        structuredOutput: false,
        presetGeneration: false,
        expressionInitialization: false,
        liveTokenCounting: false,
        conversationCompaction: false,
        historyExtraction: false,
      },
    }),
    streamToDiscord: async (
      _ch: unknown,
      _cl: unknown,
      _ts: unknown,
      _cfg: unknown,
      _ctx: unknown,
      modelPartsInput: unknown,
      _emoji: unknown,
      functionHistory: unknown[] | undefined,
    ) => {
      capturedHistories.push(functionHistory ? [...functionHistory] : []);
      const modelParts = modelPartsInput as Array<Record<string, unknown>>;
      capturedModelParts.push([...modelParts]);
      const next = queue.shift();
      if (!next) throw new Error("Fake provider: no more queued stream results");
      if (simulateBufferedTextParts && next.accumulatedText?.trim()) {
        modelParts.push({ text: next.accumulatedText });
      }
      return next;
    },
    validateApiKey: async () => ({ valid: true }),
    formatErrorDescription: () => null,
    getTools: async () => [],
    getDefaultModel: async () => "test-model",
    createConfig: async () => makeProviderConfig(),
  } as unknown as LLMProvider;

  return { provider, capturedHistories, capturedModelParts };
}

/** Convenience: build ToolLoopParams from a context and provider. */
function makeParams(context: ChatTurnContext, provider: LLMProvider): ToolLoopParams {
  return { context, provider, providerConfig: makeProviderConfig(), tomoriState: context.tomoriState };
}

describe("runToolLoop — contract tests", () => {
  beforeEach(() => {
    toolExecuteCalls = [];
    toolExecuteQueue = [];
    requiresFollowUp = false;
    requiresFollowUpCalls = [];
    hasStopRequest = false;
    isFollowUpRequest = false;
    clearStopRequestCalls = 0;
    standardEmbedCalls = [];
    hiddenToolNotices = [];
  });

  it("executes tool with correct args and delivers result to next provider call", async () => {
    const { runToolLoop } = await import("@/utils/chat/toolLoop");

    const { provider, capturedHistories } = makeProvider([
      makeFunctionCallResult("echo_tool", { text: "hello" }),
      { status: "completed", accumulatedText: "I echoed: hello" },
    ]);
    toolExecuteQueue.push({ success: true, data: { echoed: "hello" } });

    const context = makeContext();
    const result = await runToolLoop(makeParams(context, provider));

    expect(result.status).toBe("completed");
    expect(result.personaResponses).toHaveLength(1);
    expect(result.personaResponses[0]?.text).toBe("I echoed: hello");

    expect(toolExecuteCalls).toHaveLength(1);
    expect(toolExecuteCalls[0]?.name).toBe("echo_tool");
    expect(toolExecuteCalls[0]?.args).toEqual({ text: "hello" });

    expect(capturedHistories).toHaveLength(2);

    expect(capturedHistories[0]).toHaveLength(0);

    const secondHistory = capturedHistories[1] as Array<{
      functionCall: { name: string };
      functionResponse: { functionResponse: { name: string; response: { result: unknown } } };
    }>;
    expect(secondHistory).toHaveLength(1);
    expect(secondHistory[0]?.functionCall?.name).toBe("echo_tool");
    expect(secondHistory[0]?.functionResponse?.functionResponse?.name).toBe("echo_tool");

    const resultData = secondHistory[0]?.functionResponse?.functionResponse?.response?.result as {
      echoed: string;
    };
    expect(resultData?.echoed).toBe("hello");

    expect(result.streamResults).toHaveLength(2);
  });

  it("preserves direct tool delivery when the tool ends without streamed text", async () => {
    const { runToolLoop } = await import("@/utils/chat/toolLoop");
    const { provider } = makeProvider([makeFunctionCallResult("voice_tool")]);
    toolExecuteQueue.push({ success: true, responseDelivered: true, endTurn: true });

    const result = await runToolLoop(makeParams(makeContext(), provider));

    expect(result.status).toBe("completed");
    expect(result.personaResponses).toHaveLength(0);
    expect(result.toolResponseDelivered).toBe(true);
  });

  it("tool failure: error is represented in the history entry and the loop continues", async () => {
    const { runToolLoop } = await import("@/utils/chat/toolLoop");

    const { provider, capturedHistories } = makeProvider([
      makeFunctionCallResult("bad_tool", {}),
      { status: "completed", accumulatedText: "sorry about that" },
    ]);
    // One failure: below the consecutive-error cap (3).
    toolExecuteQueue.push({ success: false, error: "something broke" });

    const context = makeContext();
    const result = await runToolLoop(makeParams(context, provider));

    expect(result.status).toBe("completed");
    expect(result.personaResponses[0]?.text).toBe("sorry about that");

    expect(toolExecuteCalls).toHaveLength(1);

    // History entry for the failed call uses the standardized failure shape.
    const secondHistory = capturedHistories[1] as Array<{
      functionCall: { name: string };
      functionResponse: { functionResponse: { response: { result: { status: string; tool_name: string } } } };
    }>;
    expect(secondHistory).toHaveLength(1);
    const failResult = secondHistory[0]?.functionResponse?.functionResponse?.response?.result;
    expect(failResult?.status).toBe("tool_execution_failed");
    expect(failResult?.tool_name).toBe("bad_tool");

    // The raw internal error string is not surfaced as the final response text.
    expect(result.personaResponses[0]?.text).not.toContain("something broke");
  });

  it("consecutive tool errors: loop exits with 'error' after MAX_CONSECUTIVE_TOOL_ERRORS failures", async () => {
    const { runToolLoop } = await import("@/utils/chat/toolLoop");

    const { provider } = makeProvider(Array.from({ length: 20 }, () => makeFunctionCallResult("fail_tool", {})));
    for (let i = 0; i < 20; i++) {
      toolExecuteQueue.push({ success: false, error: "always broken" });
    }

    const context = makeContext();
    const result = await runToolLoop(makeParams(context, provider));

    // Cap is BOT_MAX_CONSECUTIVE_TOOL_ERRORS = 5 (set at the top of this file).
    expect(result.status).toBe("error");
    expect(toolExecuteCalls).toHaveLength(5);

    expect(result.personaResponses).toHaveLength(0);
  });

  it("deliberate tool mode: blocked tool is NOT dispatched and gets synthetic failure in history", async () => {
    const { runToolLoop } = await import("@/utils/chat/toolLoop");

    const { provider, capturedHistories } = makeProvider([
      makeFunctionCallResult("blocked_tool", { q: "test" }),
      { status: "completed", accumulatedText: "ok got it" },
    ]);

    const context = makeContext();
    // Deliberate mode is on; only "allowed_tool" is exposed.
    context.deliberateToolModeActive = true;
    context.streamingContext.deliberateToolAllowedNames = ["allowed_tool"];

    const result = await runToolLoop(makeParams(context, provider));

    expect(result.status).toBe("completed");

    // ToolRegistry.executeTool must NOT have been called for the blocked tool.
    expect(toolExecuteCalls).toHaveLength(0);

    // The history entry given to the provider must carry the standardized failure shape.
    // Note: toolResult.data has `blocked_by_deliberate_tool_mode` but since success===false,
    // executeToolCall routes through the generic failure path → status="tool_execution_failed".
    const secondHistory = capturedHistories[1] as Array<{
      functionCall: { name: string };
      functionResponse: {
        functionResponse: {
          response: { result: { status: string; tool_name: string; reason: string } };
        };
      };
    }>;
    expect(secondHistory).toHaveLength(1);
    expect(secondHistory[0]?.functionCall?.name).toBe("blocked_tool");
    const syntheticResult = secondHistory[0]?.functionResponse?.functionResponse?.response?.result;
    expect(syntheticResult?.status).toBe("tool_execution_failed");
    expect(syntheticResult?.tool_name).toBe("blocked_tool");
    // Reason must mention that the tool was not exposed (not a generic failure).
    expect(syntheticResult?.reason).toContain("not exposed");
  });

  it("loop bound: exits with 'timeout' after MAX_FUNCTION_CALL_ITERATIONS with no final answer", async () => {
    const { runToolLoop } = await import("@/utils/chat/toolLoop");

    // Provider never produces a terminal result, always requests another tool.
    const limit = 100; // matches the production default and the test override above
    const { provider } = makeProvider(
      Array.from({ length: limit + 5 }, () => makeFunctionCallResult("infinite_tool", {})),
    );
    for (let i = 0; i < limit + 5; i++) {
      toolExecuteQueue.push({ success: true, data: { ok: true } });
    }

    const context = makeContext();
    const result = await runToolLoop(makeParams(context, provider));

    expect(result.status).toBe("timeout");
    // Exactly limit iterations ran (one tool call per iteration).
    expect(toolExecuteCalls).toHaveLength(limit);
    expect(result.streamResults).toHaveLength(limit);
  });

  it("malformed function-call (missing name) aborts with 'error' without dispatching any tool", async () => {
    const { runToolLoop } = await import("@/utils/chat/toolLoop");

    // data has no `name` field, so should trigger the validation abort path.
    const { provider } = makeProvider([{ status: "function_call", data: {} }]);

    const context = makeContext();
    const result = await runToolLoop(makeParams(context, provider));

    expect(result.status).toBe("error");
    expect(toolExecuteCalls).toHaveLength(0);
  });

  it("context-restart response: enriched item injected into contextItems, no history entry for that tool call", async () => {
    const { runToolLoop } = await import("@/utils/chat/toolLoop");

    const { provider, capturedHistories } = makeProvider([
      makeFunctionCallResult("reveal_tool", {}),
      { status: "completed", accumulatedText: "here you go" },
    ]);

    // Tool returns a context_restart_youtube signal with an enhanced_context_item.
    const fakeContextItem = { role: "user", parts: [{ text: "YouTube transcript: ..." }] };
    toolExecuteQueue.push({
      success: true,
      data: {
        type: "context_restart_youtube",
        enhanced_context_item: fakeContextItem,
      },
    });

    const context = makeContext();
    const result = await runToolLoop(makeParams(context, provider));

    expect(result.status).toBe("completed");
    expect(result.personaResponses[0]?.text).toBe("here you go");

    // The enriched item must be appended to contextItems.
    expect(context.contextItems).toContain(fakeContextItem);

    // The streaming-context disable flag must have been set.
    expect(context.streamingContext.disableYouTubeProcessing).toBe(true);

    // The context-restart call must NOT appear in the function history
    // passed to the second provider call (restart replaces it with enriched context).
    expect(capturedHistories).toHaveLength(2);
    expect(capturedHistories[1]).toHaveLength(0); // no history entry for the restart call
  });

  it("context-restart response: stashed item injected when the tool returns only a pending_context_key", async () => {
    const { runToolLoop } = await import("@/utils/chat/toolLoop");
    const { stashEnhancedContextItem } = await import("@/utils/chat/pendingEnhancedContext");

    const { provider } = makeProvider([
      makeFunctionCallResult("peek_profile_picture", {}),
      { status: "completed", accumulatedText: "cute pfp" },
    ]);

    // peek_profile_picture keeps its base64 payload out of ToolResult.data (the registry
    // retains results), so the loop must drain the stash to see the image at all.
    const stashedItem = {
      role: "user",
      parts: [{ type: "image", uri: "data:image/png;base64,AAAA" }],
    } as unknown as Parameters<typeof stashEnhancedContextItem>[0];
    const pendingContextKey = stashEnhancedContextItem(stashedItem);

    toolExecuteQueue.push({
      success: true,
      data: {
        type: "context_restart_with_image",
        pending_context_key: pendingContextKey,
      },
    });

    const context = makeContext();
    const result = await runToolLoop(makeParams(context, provider));

    expect(result.status).toBe("completed");
    expect(context.contextItems).toContain(stashedItem);
    expect(context.streamingContext.disableProfilePictureProcessing).toBe(true);
  });

  it("context-restart response: a stashed item is consumed once, so a replayed key injects nothing", async () => {
    const { runToolLoop } = await import("@/utils/chat/toolLoop");
    const { stashEnhancedContextItem } = await import("@/utils/chat/pendingEnhancedContext");

    const { provider } = makeProvider([
      makeFunctionCallResult("peek_profile_picture", {}),
      makeFunctionCallResult("peek_profile_picture", {}),
      { status: "completed", accumulatedText: "done" },
    ]);

    const stashedItem = { role: "user", parts: [{ type: "text", text: "avatar" }] } as unknown as Parameters<
      typeof stashEnhancedContextItem
    >[0];
    const pendingContextKey = stashEnhancedContextItem(stashedItem);

    const restartResult = {
      success: true,
      data: { type: "context_restart_with_image", pending_context_key: pendingContextKey },
    };
    toolExecuteQueue.push(restartResult, restartResult);

    const context = makeContext();
    const initialItemCount = context.contextItems.length;
    await runToolLoop(makeParams(context, provider));

    expect(context.contextItems.length).toBe(initialItemCount + 1);
  });

  // Pre-tool text preservation (post-tool-call amnesia regression)

  it("pre-tool text is preserved in the history entry passed to the follow-up provider call", async () => {
    const { runToolLoop } = await import("@/utils/chat/toolLoop");

    const { provider, capturedHistories } = makeProvider([
      makeFunctionCallResult("create_long_term_memory", { content: "likes cats" }, "Yeah, let me remember that."),
      { status: "completed", accumulatedText: "Saved! Anything else?" },
    ]);
    toolExecuteQueue.push({ success: true, data: { saved: true } });

    const context = makeContext();
    const result = await runToolLoop(makeParams(context, provider));

    // The loop continued to a follow-up provider call, so long-term memory
    // must NOT behave as an end-turn tool.
    expect(result.status).toBe("completed");
    expect(capturedHistories).toHaveLength(2);
    expect(result.personaResponses[0]?.text).toBe("Saved! Anything else?");

    // The follow-up call's history entry carries the already-sent text so the
    // model knows not to repeat it (the amnesia fix contract).
    const secondHistory = capturedHistories[1] as Array<{
      functionCall: { name: string };
      preToolCallTextParts?: Array<Record<string, unknown>>;
    }>;
    expect(secondHistory).toHaveLength(1);
    expect(secondHistory[0]?.preToolCallTextParts).toEqual([{ type: "text", text: "Yeah, let me remember that." }]);
  });

  it("removes pre-tool text from trailing model prefill after moving it into tool history", async () => {
    const { runToolLoop } = await import("@/utils/chat/toolLoop");
    const { provider, capturedModelParts } = makeProvider(
      [
        makeFunctionCallResult("echo_tool", {}, "Let me check that."),
        { status: "completed", accumulatedText: "Here is the result." },
      ],
      "openrouter",
      true,
    );
    toolExecuteQueue.push({ success: true, data: { summary: "Tool result" } });

    const result = await runToolLoop(makeParams(makeContext(), provider));

    expect(result.status).toBe("completed");
    expect(capturedModelParts).toEqual([[], []]);
  });

  it("no pre-tool text: history entry omits preToolCallTextParts", async () => {
    const { runToolLoop } = await import("@/utils/chat/toolLoop");

    const { provider, capturedHistories } = makeProvider([
      makeFunctionCallResult("echo_tool", {}, "   "),
      { status: "completed", accumulatedText: "done" },
    ]);
    toolExecuteQueue.push({ success: true, data: { ok: true } });

    const context = makeContext();
    const result = await runToolLoop(makeParams(context, provider));

    expect(result.status).toBe("completed");
    const secondHistory = capturedHistories[1] as Array<{
      preToolCallTextParts?: Array<Record<string, unknown>>;
    }>;
    expect(secondHistory).toHaveLength(1);
    expect(secondHistory[0]?.preToolCallTextParts).toBeUndefined();
  });

  it("multi-tool chain: each history entry carries only its own iteration's pre-tool text", async () => {
    const { runToolLoop } = await import("@/utils/chat/toolLoop");

    const { provider, capturedHistories } = makeProvider([
      makeFunctionCallResult("tool_one", {}, "First, let me check something."),
      makeFunctionCallResult("tool_two", {}, "Now one more thing."),
      { status: "completed", accumulatedText: "All done!" },
    ]);
    toolExecuteQueue.push({ success: true, data: { ok: 1 } });
    toolExecuteQueue.push({ success: true, data: { ok: 2 } });

    const context = makeContext();
    const result = await runToolLoop(makeParams(context, provider));

    expect(result.status).toBe("completed");
    expect(capturedHistories).toHaveLength(3);

    // The third provider call sees both entries, each with its own text:
    // no duplication across iterations (fresh stream state per streamOnce).
    const thirdHistory = capturedHistories[2] as Array<{
      functionCall: { name: string };
      preToolCallTextParts?: Array<Record<string, unknown>>;
    }>;
    expect(thirdHistory).toHaveLength(2);
    expect(thirdHistory[0]?.preToolCallTextParts).toEqual([{ type: "text", text: "First, let me check something." }]);
    expect(thirdHistory[1]?.preToolCallTextParts).toEqual([{ type: "text", text: "Now one more thing." }]);
  });

  it("update_short_term_memory with pre-tool text still ends the turn without a follow-up call", async () => {
    const { runToolLoop } = await import("@/utils/chat/toolLoop");

    const { provider, capturedHistories } = makeProvider([
      makeFunctionCallResult("update_short_term_memory", { content: "note" }, "Got it, noting that down."),
    ]);
    toolExecuteQueue.push({ success: true, data: { saved: true } });

    const context = makeContext();
    const result = await runToolLoop(makeParams(context, provider));

    // Suppress-set tool ends the turn after pre-tool text; the visible text is the response.
    expect(result.status).toBe("completed");
    expect(capturedHistories).toHaveLength(1);
    expect(result.personaResponses[0]?.text).toBe("Got it, noting that down.");
    expect(requiresFollowUpCalls).toHaveLength(0);
  });

  it("successful sticker selection is carried on the completed result", async () => {
    const { runToolLoop } = await import("@/utils/chat/toolLoop");
    const sticker = { id: "sticker_1", name: "Wave", url: "https://cdn.example/sticker.png" };
    const { provider } = makeProvider([
      makeFunctionCallResult("select_sticker_for_response", { sticker_name: "Wave" }),
      { status: "completed", accumulatedText: "Hello!" },
    ]);
    toolExecuteQueue.push({
      success: true,
      data: { status: "sticker_selected_successfully", sticker_id: sticker.id, sticker_name: sticker.name },
    });

    const context = makeContext();
    context.guild = { stickers: { cache: new Map([[sticker.id, sticker]]) } } as unknown as ChatTurnContext["guild"];
    const result = await runToolLoop(makeParams(context, provider));

    expect(result.status).toBe("completed");
    expect(result.selectedSticker).toBe(sticker);
  });

  it("a later failed sticker selection clears an earlier selection", async () => {
    const { runToolLoop } = await import("@/utils/chat/toolLoop");
    const sticker = { id: "sticker_1", name: "Wave", url: "https://cdn.example/sticker.png" };
    const { provider } = makeProvider([
      makeFunctionCallResult("select_sticker_for_response", { sticker_name: "Wave" }),
      makeFunctionCallResult("select_sticker_for_response", { sticker_name: "Missing" }),
      { status: "completed", accumulatedText: "No sticker this time." },
    ]);
    toolExecuteQueue.push({
      success: true,
      data: { status: "sticker_selected_successfully", sticker_id: sticker.id, sticker_name: sticker.name },
    });
    toolExecuteQueue.push({ success: false, data: { status: "sticker_not_found" }, error: "not found" });

    const context = makeContext();
    context.guild = { stickers: { cache: new Map([[sticker.id, sticker]]) } } as unknown as ChatTurnContext["guild"];
    const result = await runToolLoop(makeParams(context, provider));

    expect(result.status).toBe("completed");
    expect(result.selectedSticker).toBeUndefined();
  });

  it("max-iterations timeout clears a selected sticker", async () => {
    const { runToolLoop } = await import("@/utils/chat/toolLoop");
    const sticker = { id: "sticker_1", name: "Wave", url: "https://cdn.example/sticker.png" };
    const { provider } = makeProvider([
      makeFunctionCallResult("select_sticker_for_response", { sticker_name: "Wave" }),
      ...Array.from({ length: 99 }, () => makeFunctionCallResult("infinite_tool")),
    ]);
    toolExecuteQueue.push({
      success: true,
      data: { status: "sticker_selected_successfully", sticker_id: sticker.id, sticker_name: sticker.name },
    });
    for (let i = 0; i < 99; i++) {
      toolExecuteQueue.push({ success: true, data: { ok: true } });
    }

    const context = makeContext();
    context.guild = { stickers: { cache: new Map([[sticker.id, sticker]]) } } as unknown as ChatTurnContext["guild"];
    const result = await runToolLoop(makeParams(context, provider));

    expect(result.status).toBe("timeout");
    expect(result.selectedSticker).toBeUndefined();
  });

  it("NovelAI continues after pre-tool text when the successful tool requires follow-up", async () => {
    const { runToolLoop } = await import("@/utils/chat/toolLoop");
    requiresFollowUp = true;
    const { provider, capturedHistories } = makeProvider(
      [
        makeFunctionCallResult("web_search", { query: "news" }, "Let me check."),
        { status: "completed", accumulatedText: "Here is what I found." },
      ],
      "novelai",
    );
    toolExecuteQueue.push({ success: true, data: { results: ["result"] } });

    const context = makeContext();
    context.streamingContext.suppressTextOutput = true;
    const result = await runToolLoop(makeParams(context, provider));

    expect(result.status).toBe("completed");
    expect(capturedHistories).toHaveLength(2);
    expect(result.personaResponses[0]?.text).toBe("Here is what I found.");
    expect(context.streamingContext.suppressTextOutput).toBe(false);
    expect(requiresFollowUpCalls).toEqual([{ name: "web_search", provider: "novelai", serverId: 1 }]);
  });

  it("NovelAI ends after pre-tool text when the successful tool does not require follow-up", async () => {
    const { runToolLoop } = await import("@/utils/chat/toolLoop");
    const { provider, capturedHistories } = makeProvider(
      [makeFunctionCallResult("non_follow_up_tool", {}, "That is done.")],
      "novelai",
    );
    toolExecuteQueue.push({ success: true, data: { ok: true } });

    const result = await runToolLoop(makeParams(makeContext(), provider));

    expect(result.status).toBe("completed");
    expect(capturedHistories).toHaveLength(1);
    expect(result.personaResponses[0]?.text).toBe("That is done.");
    expect(requiresFollowUpCalls).toEqual([{ name: "non_follow_up_tool", provider: "novelai", serverId: 1 }]);
  });

  it("NovelAI suppresses repeated text and retries a tool failure after pre-tool text", async () => {
    const { runToolLoop } = await import("@/utils/chat/toolLoop");
    const { provider, capturedHistories } = makeProvider(
      [
        makeFunctionCallResult("web_search", {}, "Let me try that."),
        { status: "completed", accumulatedText: "Recovered." },
      ],
      "novelai",
    );
    toolExecuteQueue.push({ success: false, error: "temporary failure" });

    const context = makeContext();
    const result = await runToolLoop(makeParams(context, provider));

    expect(result.status).toBe("completed");
    expect(capturedHistories).toHaveLength(2);
    expect(context.streamingContext.suppressTextOutput).toBe(true);
    expect(standardEmbedCalls).toHaveLength(0);
  });

  it("NovelAI ends with the localized retry-exhausted embed at the configured threshold", async () => {
    const { runToolLoop } = await import("@/utils/chat/toolLoop");
    const { provider, capturedHistories } = makeProvider(
      Array.from({ length: 4 }, () => makeFunctionCallResult("web_search", {}, "Still trying.")),
      "novelai",
    );
    for (let i = 0; i < 4; i++) {
      toolExecuteQueue.push({ success: false, error: "always fails" });
    }

    const result = await runToolLoop(makeParams(makeContext(), provider));

    expect(result.status).toBe("completed");
    expect(capturedHistories).toHaveLength(3);
    expect(toolExecuteCalls).toHaveLength(3);
    expect(standardEmbedCalls).toContainEqual({
      titleKey: "genai.nai_tool_retry_exhausted_title",
      descriptionKey: "genai.nai_tool_retry_exhausted_description",
      color: "#E74C3C",
    });
  });

  it("successful STM update without pre-tool text disables further STM calls and continues", async () => {
    const { runToolLoop } = await import("@/utils/chat/toolLoop");
    const { provider, capturedHistories } = makeProvider([
      makeFunctionCallResult("update_short_term_memory", { content: "note" }),
      { status: "completed", accumulatedText: "Done." },
    ]);
    toolExecuteQueue.push({ success: true, data: { saved: true } });

    const context = makeContext();
    const result = await runToolLoop(makeParams(context, provider));

    expect(result.status).toBe("completed");
    expect(capturedHistories).toHaveLength(2);
    expect(context.streamingContext.disableShortTermMemoryUpdate).toBe(true);
  });

  it("clears a stale follow-up interrupt and lets the tool chain continue", async () => {
    const { runToolLoop } = await import("@/utils/chat/toolLoop");
    hasStopRequest = true;
    isFollowUpRequest = true;
    const { provider, capturedHistories } = makeProvider([
      makeFunctionCallResult("echo_tool"),
      { status: "completed", accumulatedText: "Done." },
    ]);
    toolExecuteQueue.push({ success: true, data: { ok: true } });

    const result = await runToolLoop(makeParams(makeContext(), provider));

    expect(result.status).toBe("completed");
    expect(toolExecuteCalls).toHaveLength(1);
    expect(capturedHistories).toHaveLength(2);
    expect(clearStopRequestCalls).toBe(1);
  });

  it("a plain stop request still aborts before tool execution", async () => {
    const { runToolLoop } = await import("@/utils/chat/toolLoop");
    hasStopRequest = true;
    isFollowUpRequest = false;
    const { provider } = makeProvider([makeFunctionCallResult("echo_tool")]);

    const result = await runToolLoop(makeParams(makeContext(), provider));

    expect(result.status).toBe("stopped_by_user");
    expect(toolExecuteCalls).toHaveLength(0);
    expect(clearStopRequestCalls).toBe(0);
  });

  it("does not dispatch a tool whose arguments the provider truncated", async () => {
    const { runToolLoop } = await import("@/utils/chat/toolLoop");

    // A tool whose arguments replace stored state would write only the recovered keys and
    // silently drop the rest, so the call is refused outright.
    const truncatedCall: StreamResult = {
      status: "function_call",
      data: { name: "update_short_term_memory", args: { scene_state: "bedroom" }, argumentsTruncated: true },
    };
    const { provider, capturedHistories } = makeProvider([
      truncatedCall,
      { status: "completed", accumulatedText: "retried" },
    ]);
    toolExecuteQueue.push({ success: true, data: { saved: true } });

    const context = makeContext();
    const result = await runToolLoop(makeParams(context, provider));

    expect(toolExecuteCalls).toHaveLength(0);
    expect(result.status).toBe("completed");

    const history = capturedHistories[1] as Array<{
      functionCall: { name: string; args?: Record<string, unknown> };
      functionResponse: {
        functionResponse: { response: { result: { status: string; tool_name: string; reason: string } } };
      };
    }>;
    expect(history).toHaveLength(1);
    expect(history[0]?.functionCall?.name).toBe("update_short_term_memory");
    // The recovered subset is dropped, so the model is not shown a call it did not make.
    expect(history[0]?.functionCall?.args).toBeUndefined();
    const synthetic = history[0]?.functionResponse?.functionResponse?.response?.result;
    expect(synthetic?.status).toBe("tool_execution_failed");
    expect(synthetic?.tool_name).toBe("update_short_term_memory");
    expect(synthetic?.reason).toContain("truncated");

    // The ordinary failure path emits a thought-log notice, so the refusal has to as well or
    // the truncation leaves no trace a user can see.
    expect(hiddenToolNotices).toHaveLength(1);
    expect(hiddenToolNotices[0]).toContain("truncated");
  });

  it("refuses a truncated call before the deliberate-mode allowlist can report it", async () => {
    const { runToolLoop } = await import("@/utils/chat/toolLoop");

    // Both gates would fire here. The refusal runs first, so the model is told the payload was
    // cut short rather than that deliberate mode hid the tool, which is the actionable cause.
    const truncatedCall: StreamResult = {
      status: "function_call",
      data: { name: "hidden_tool", args: {}, argumentsTruncated: true },
    };
    const { provider, capturedHistories } = makeProvider([
      truncatedCall,
      { status: "completed", accumulatedText: "retried" },
    ]);

    const context = makeContext();
    context.deliberateToolModeActive = true;
    context.streamingContext.deliberateToolAllowedNames = ["allowed_tool"];
    await runToolLoop(makeParams(context, provider));

    const history = capturedHistories[1] as Array<{
      functionResponse: { functionResponse: { response: { result: { reason: string } } } };
    }>;
    const reason = history[0]?.functionResponse?.functionResponse?.response?.result?.reason ?? "";
    expect(reason).toContain("truncated");
    expect(reason).not.toContain("not exposed");
  });

  it("counts a refused truncated call toward the consecutive tool error cap", async () => {
    const { runToolLoop } = await import("@/utils/chat/toolLoop");

    // A model that keeps reissuing a truncated call must not loop forever.
    const truncatedCall: StreamResult = {
      status: "function_call",
      data: { name: "update_short_term_memory", args: {}, argumentsTruncated: true },
    };
    const { provider } = makeProvider(Array.from({ length: 10 }, () => truncatedCall));

    const result = await runToolLoop(makeParams(makeContext(), provider));

    expect(result.status).toBe("error");
    expect(toolExecuteCalls).toHaveLength(0);
  });
});
