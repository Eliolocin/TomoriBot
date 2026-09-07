import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Client, Message } from "discord.js";
import type { CustomEndpointRow, LlmRow, TomoriState } from "@/types/db/schema";
import type { ProviderConfig, StreamResult } from "@/types/provider/interfaces";
import type { FallbackNoticeAttempt } from "@/utils/discord/fallbackModelNotice";
import type { ChatResponseSink, ChatTurnContext, GenerationTurnResult } from "@/utils/chat/types";
import type { ToolLoopParams } from "@/utils/chat/toolLoop";
// Capture the REAL repository barrel before the mock below replaces it. Importing
// it is side-effect-free (the DB client connects lazily, not at import), and
// `mock.module` runs in source order (not hoisted), so this static import resolves
// to the real module. Spreading it into the mock keeps every repository export
// present, so command modules pulled into the SUT's dynamic-import graph can
// satisfy their static `import { ... }` bindings. Without this, running this file
// in its own process (per-file isolation in runTests.ts) fails to link exports
// like `serverScheduleRepository` that the graph imports but the stub omitted.
import * as realRepositories from "@/utils/db/repositories";
// Same link-time capture for every other module mocked below, for the same
// reason: a partial factory leaks for the rest of the run and breaks files
// loaded later. Spreading the real namespace keeps each mock full-surface.
import * as realChannelLlmCache from "@/utils/cache/channelLlmCache";
import * as realGeminiCapabilityCache from "@/utils/cache/geminiCapabilityCache";
import * as realNovelaiCapabilityCache from "@/utils/cache/novelaiCapabilityCache";
import * as realNovelaiSubscriptionCache from "@/utils/cache/novelaiSubscriptionCache";
import * as realOpenrouterCapabilityCache from "@/utils/cache/openrouterCapabilityCache";
import * as realToolLoop from "@/utils/chat/toolLoop";
import * as realFallbackModelNotice from "@/utils/discord/fallbackModelNotice";
import * as realStreamOrchestrator from "@/utils/discord/streamOrchestrator";
import * as realPersonalProviderRuntime from "@/utils/provider/personalProviderRuntime";
import * as realProviderFactory from "@/utils/provider/providerFactory";
import * as realCrypto from "@/utils/security/crypto";
import * as realKeyRotation from "@/utils/security/keyRotation";
import { createScopedModuleMocker, overrideMembers, stubLogMembers } from "../../helpers/mockSurface";

const queuedResults: GenerationTurnResult[] = [];
// Parallel to queuedResults: the delivered-message refs each runToolLoop call should push into the
// shared sink before returning its queued result, simulating messages the stream committed to
// Discord during that attempt. Undefined entries push nothing.
const queuedDeliveries: Array<Array<{ messageId: string; channelId: string; isWebhook: boolean }> | undefined> = [];
const toolLoopCalls: Array<{ model: string; suppressUserErrors: boolean | undefined }> = [];
const providerConfigCalls: Array<{ model: string; apiKey: string }> = [];
const fallbackNoticeCalls: Array<{ failures: FallbackNoticeAttempt[]; successModel: LlmRow }> = [];
const personalSavedConfigLoads: Array<{ userId: number; provider: string }> = [];
const testStopRequests = new Map<string, { type: "stop" | "follow_up"; stopContext?: TestStopContext }>();
let personalOverlayState: TomoriState | null = null;

type TestStopContext = {
  originalStopMessage: Message;
  client: Client;
};

// The real `ColorCode` enum passes through the spread, so its values stay the
// hex STRINGS modules call string methods on at load time (e.g. contextEmbeds.ts
// does ColorCode.ERROR.replace("#", "")). Only `log` is silenced.
const scopedMock = createScopedModuleMocker(mock, {
  "@/utils/cache/channelLlmCache": realChannelLlmCache,
  "@/utils/cache/geminiCapabilityCache": realGeminiCapabilityCache,
  "@/utils/cache/novelaiCapabilityCache": realNovelaiCapabilityCache,
  "@/utils/cache/novelaiSubscriptionCache": realNovelaiSubscriptionCache,
  "@/utils/cache/openrouterCapabilityCache": realOpenrouterCapabilityCache,
  "@/utils/db/repositories": realRepositories,
  "@/utils/discord/fallbackModelNotice": realFallbackModelNotice,
  "@/utils/discord/streamOrchestrator": realStreamOrchestrator,
  "@/utils/provider/personalProviderRuntime": realPersonalProviderRuntime,
  "@/utils/provider/providerFactory": realProviderFactory,
  "@/utils/security/crypto": realCrypto,
  "@/utils/security/keyRotation": realKeyRotation,
  "@/utils/chat/toolLoop": realToolLoop,
});

stubLogMembers({
  error: () => undefined,
  info: () => undefined,
  section: () => undefined,
  success: () => undefined,
  warn: () => undefined,
});

scopedMock.module("@/utils/cache/channelLlmCache", () => ({
  ...realChannelLlmCache,
  getCachedChannelLlm: async () => null,
}));

scopedMock.module("@/utils/cache/geminiCapabilityCache", () => ({
  ...realGeminiCapabilityCache,
  getGeminiTokenLimits: () => undefined,
}));

scopedMock.module("@/utils/cache/novelaiCapabilityCache", () => ({
  ...realNovelaiCapabilityCache,
  getNovelAITokenLimits: () => undefined,
}));

scopedMock.module("@/utils/cache/novelaiSubscriptionCache", () => ({
  ...realNovelaiSubscriptionCache,
  getCachedContextTokens: () => undefined,
  refreshNovelAISubscription: async () => undefined,
}));

scopedMock.module("@/utils/cache/openrouterCapabilityCache", () => ({
  ...realOpenrouterCapabilityCache,
  clearOpenRouterOnDemandCapabilityCache: () => undefined,
  getOpenRouterCapabilities: () => undefined,
  getOpenRouterCapabilityCacheSize: () => 0,
  getOpenRouterOnDemandCapabilityCacheSize: () => 0,
  getOpenRouterPricing: () => undefined,
  getOpenRouterSupportedParameters: () => undefined,
  getOpenRouterTokenizer: () => undefined,
  getOpenRouterTokenLimits: () => undefined,
  getOrFetchOpenRouterCapabilities: async () => undefined,
  initializeOpenRouterCapabilityCache: async () => undefined,
  isOpenRouterCapabilityCacheReady: () => false,
  testAccountSettingModel: async () => ({ valid: false }),
}));

scopedMock.module("@/utils/db/repositories", () => ({
  // Spread the real barrel first so every export the SUT graph imports is present,
  // then override only the repository methods this test's code path actually drives.
  ...realRepositories,
  // Each repository is a class INSTANCE: its methods live on the prototype and
  // a spread would drop them, so delegate and shadow only what this file drives.
  llmProviderRepo: overrideMembers(realRepositories.llmProviderRepo, {
    loadSavedProviderConfig: async () => null,
    loadUserSavedProviderConfig: async (userId: number, provider: string) => {
      personalSavedConfigLoads.push({ userId, provider });
      return { api_key: Buffer.from("encrypted-key"), key_version: 1 };
    },
  }),
  configRepository: overrideMembers(realRepositories.configRepository, {
    updateNsfwConfig: async () => true,
  }),
  personaRepository: overrideMembers(realRepositories.personaRepository, {
    loadAllForServer: async () => [],
  }),
  userRepository: overrideMembers(realRepositories.userRepository, {
    loadOrCreateUser: async () => null,
    updateLastSeen: async () => undefined,
  }),
  serverRepository: overrideMembers(realRepositories.serverRepository, {
    loadServerState: async () => null,
  }),
}));

scopedMock.module("@/utils/discord/fallbackModelNotice", () => ({
  ...realFallbackModelNotice,
  sendFallbackModelUsageNotice: async (args: { failures: FallbackNoticeAttempt[]; successModel: LlmRow }) => {
    fallbackNoticeCalls.push({ failures: args.failures, successModel: args.successModel });
  },
}));

scopedMock.module("@/utils/discord/streamOrchestrator", () => ({
  ...realStreamOrchestrator,
  StreamOrchestrator: overrideMembers(realStreamOrchestrator.StreamOrchestrator, {
    requestStop(channelId: string, requesterId?: string, stopContext?: TestStopContext): boolean {
      void requesterId;
      testStopRequests.set(channelId, { type: "stop", stopContext });
      return true;
    },

    requestFollowUp(channelId: string, requesterId: string): boolean {
      void requesterId;
      testStopRequests.set(channelId, { type: "follow_up" });
      return true;
    },

    hasStopRequest(channelId: string): boolean {
      return testStopRequests.has(channelId);
    },

    clearStopRequest(channelId: string): void {
      const request = testStopRequests.get(channelId);
      if (!request?.stopContext) {
        testStopRequests.delete(channelId);
      }
    },

    getAndClearStopContext(channelId: string): TestStopContext | null {
      const request = testStopRequests.get(channelId);
      if (!request?.stopContext) {
        return null;
      }
      testStopRequests.delete(channelId);
      return request.stopContext;
    },
  }),
}));

scopedMock.module("@/utils/provider/personalProviderRuntime", () => ({
  ...realPersonalProviderRuntime,
  applyPersonalProviderSelectionsToTomoriState: async (tomoriState: TomoriState) => ({
    tomoriState: personalOverlayState ?? tomoriState,
    activeConfigs: {},
  }),
}));

scopedMock.module("@/utils/provider/providerFactory", () => ({
  ...realProviderFactory,
  getProviderForTomori: async () => fakeProvider,
  ProviderFactory: overrideMembers(realProviderFactory.ProviderFactory, {
    getProviderByName: async () => fakeProvider,
  }),
}));

// The spread keeps the full real export surface intact. `mock.module` is
// process-wide and never restored, so a partial stub would leave later test
// files unable to link against any omitted export.
scopedMock.module("@/utils/security/crypto", () => ({
  ...realCrypto,
  decryptApiKey: async (key: string) => (key === "personal-encrypted-key" ? "personal-key" : "server-key"),
  encryptApiKey: async () => ({ encrypted: Buffer.from(""), version: 1 }),
  reencryptApiKey: async () => ({ encrypted: Buffer.from(""), version: 1 }),
  storeOptApiKey: async () => true,
  getOptApiKey: async () => null,
  getAllOptApiKeysForServer: async () => ({}),
  deleteOptApiKey: async () => true,
  hasOptApiKey: async () => false,
}));

scopedMock.module("@/utils/security/keyRotation", () => ({
  ...realKeyRotation,
  MAX_KEY_ATTEMPTS: 3,
  hasAvailableRotationKey: async () => false,
  recordKeyError: async () => undefined,
  recordKeySuccess: async () => undefined,
  selectApiKey: async () => null,
}));

scopedMock.module("@/utils/chat/toolLoop", () => ({
  ...realToolLoop,
  providerIsApiFamily: (providerName: string, apiFamily: string) => {
    const families: Record<string, string> = {
      google: "google-genai",
      novelai: "novelai",
      openrouter: "openrouter",
    };
    return families[providerName.toLowerCase()] === apiFamily;
  },
  runToolLoop: runToolLoopMock,
}));

type ToolExecutionResult = {
  success: boolean;
  data?: unknown;
  error?: string;
  message?: string;
};

type FunctionHistoryEntry = {
  functionCall: {
    name: string;
    args: Record<string, unknown>;
  };
  functionResponse: {
    functionResponse: {
      name: string;
      response: {
        result: unknown;
      };
    };
  };
};

async function runToolLoopMock(params: ToolLoopParams): Promise<GenerationTurnResult> {
  if (queuedResults.length > 0) {
    toolLoopCalls.push({
      model: params.tomoriState.llm.llm_codename,
      suppressUserErrors: params.context.streamingContext.suppressUserErrors,
    });
    // Simulate this attempt committing messages to the channel before it resolves, so the
    // supersede-cleanup path in runGenerationTurn has refs to act on.
    const deliveries = queuedDeliveries.shift();
    if (deliveries) {
      if (!params.context.streamingContext.deliveredMessageRefs) {
        params.context.streamingContext.deliveredMessageRefs = [];
      }
      params.context.streamingContext.deliveredMessageRefs.push(...deliveries);
    }
    const next = queuedResults.shift();
    if (!next) {
      throw new Error("No queued generation result for test");
    }
    return next;
  }

  return runToolLoopContractShim(params);
}

async function runToolLoopContractShim(params: ToolLoopParams): Promise<GenerationTurnResult> {
  const maxIterations = Number.parseInt(process.env.BOT_MAX_FUNCTION_CALL_ITERATIONS ?? "10", 10);
  const maxConsecutiveToolErrors = Number.parseInt(process.env.BOT_MAX_CONSECUTIVE_TOOL_ERRORS ?? "3", 10);
  const streamResults: StreamResult[] = [];
  const functionHistory: FunctionHistoryEntry[] = [];
  let consecutiveToolErrors = 0;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const streamResult = await callProviderStream(params, functionHistory);
    streamResults.push(streamResult);

    if (streamResult.status === "completed") {
      return {
        status: "completed",
        streamResults,
        personaResponses: streamResult.accumulatedText
          ? [
              {
                personaName: params.tomoriState.persona_nickname,
                text: streamResult.accumulatedText,
                personaId: params.tomoriState.persona_id,
                personaLineageId: params.tomoriState.persona_lineage_id,
              },
            ]
          : [],
      };
    }

    if (streamResult.status !== "function_call") {
      return {
        status: streamResult.status === "timeout" ? "timeout" : "error",
        streamResults,
        personaResponses: [],
      };
    }

    const functionCall = parseFunctionCall(streamResult);
    if (!functionCall) {
      return { status: "error", streamResults, personaResponses: [] };
    }

    const toolResult = await executeToolForShim(params, functionCall);
    if (toolResult.success && handleContextRestartForShim(params, toolResult.data)) {
      continue;
    }

    if (!toolResult.success) {
      consecutiveToolErrors++;
    } else {
      consecutiveToolErrors = 0;
    }

    functionHistory.push({
      functionCall,
      functionResponse: {
        functionResponse: {
          name: functionCall.name,
          response: {
            result: toolResult.success
              ? (toolResult.data ?? { status: "completed" })
              : {
                  status: "tool_execution_failed",
                  reason: toolResult.message || toolResult.error || "Tool execution failed without specific error",
                  tool_name: functionCall.name,
                },
          },
        },
      },
    });

    if (consecutiveToolErrors >= maxConsecutiveToolErrors) {
      return { status: "error", streamResults, personaResponses: [] };
    }
  }

  return { status: "timeout", streamResults, personaResponses: [] };
}

async function callProviderStream(
  params: ToolLoopParams,
  functionHistory: FunctionHistoryEntry[],
): Promise<StreamResult> {
  const provider = params.provider as unknown as {
    streamToDiscord: (...args: unknown[]) => Promise<StreamResult>;
  };

  return provider.streamToDiscord(
    params.context.channel,
    params.context.client,
    params.tomoriState,
    params.providerConfig,
    params.context,
    [],
    params.context.emojiStrings,
    functionHistory,
  );
}

function parseFunctionCall(streamResult: StreamResult): { name: string; args: Record<string, unknown> } | null {
  const data = streamResult.data;
  if (!data || typeof data !== "object") return null;
  const candidate = data as { name?: unknown; args?: unknown };
  if (typeof candidate.name !== "string" || candidate.name.length === 0) return null;
  return {
    name: candidate.name,
    args:
      candidate.args && typeof candidate.args === "object" && !Array.isArray(candidate.args)
        ? (candidate.args as Record<string, unknown>)
        : {},
  };
}

async function executeToolForShim(
  params: ToolLoopParams,
  functionCall: { name: string; args: Record<string, unknown> },
): Promise<ToolExecutionResult> {
  const allowedToolNames = params.context.streamingContext.deliberateToolAllowedNames;
  if (
    params.context.deliberateToolModeActive &&
    Array.isArray(allowedToolNames) &&
    !allowedToolNames.includes(functionCall.name)
  ) {
    return {
      success: false,
      error: `Tool "${functionCall.name}" was not exposed for this deliberate tool mode turn.`,
    };
  }

  const { ToolRegistry } = (await import("@/tools/toolRegistry")) as {
    ToolRegistry: {
      executeTool: (name: string, args: Record<string, unknown>, context?: unknown) => Promise<ToolExecutionResult>;
    };
  };

  return ToolRegistry.executeTool(functionCall.name, functionCall.args, params.context);
}

function handleContextRestartForShim(params: ToolLoopParams, data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const result = data as { type?: unknown; enhanced_context_item?: unknown };
  if (typeof result.type !== "string" || !result.type.startsWith("context_restart")) return false;

  if (result.enhanced_context_item) {
    params.context.contextItems.push(result.enhanced_context_item as never);
  }
  if (result.type.includes("youtube")) {
    params.context.streamingContext.disableYouTubeProcessing = true;
  }
  return true;
}

const fakeProvider = {
  createConfig: async (tomoriState: TomoriState, apiKey: string): Promise<ProviderConfig> => {
    providerConfigCalls.push({ model: tomoriState.llm.llm_codename, apiKey });
    return {
      apiKey,
      model: tomoriState.llm.llm_codename,
      temperature: tomoriState.config.llm_temperature ?? 0.7,
    };
  },
  getInfo: () => ({ name: "google" }),
};

function makeLlm(id: number, codename: string): LlmRow {
  return {
    llm_id: id,
    llm_codename: codename,
    llm_provider: "google",
    has_tools: false,
    sees_images: false,
    sees_videos: false,
    supports_structoutput: false,
  } as unknown as LlmRow;
}

function makeContext(primaryModel: LlmRow, fallbackModel: LlmRow): ChatTurnContext {
  const channel = {
    id: "channel_1",
    isThread: () => false,
  };
  const state = {
    server_id: 1,
    persona_id: 10,
    persona_lineage_id: 100,
    persona_nickname: "Tomori",
    is_alter: false,
    llm: primaryModel,
    fallback_chain: [{ kind: "llm", model: fallbackModel }],
    config: {
      api_key: "encrypted-key",
      key_version: 1,
      llm_temperature: 0.7,
      private_channel_ids: [],
      tool_notice_hidden_keys: [],
    },
  } as unknown as TomoriState;

  return {
    channel,
    client: {},
    contextItems: [],
    currentPersona: state,
    emojiStrings: [],
    guild: null,
    isDMChannel: false,
    isFromQueue: true,
    isPersonaJob: false,
    isSelfMessage: false,
    isStopResponse: false,
    isUserImpersonation: false,
    loadedEmojis: null,
    loadedStickers: null,
    locale: "en-US",
    message: { id: "message_1", channel },
    messageIdMap: new Map(),
    personalRoutingUserId: null,
    personalTextProvider: null,
    requestSnapshot: {},
    serverDiscId: "server_1",
    shouldApplyTextQuota: false,
    shouldSurfaceUserErrors: true,
    simplifiedMessages: [],
    streamingContext: {
      disableYouTubeProcessing: false,
    },
    textCredentialSource: "server",
    textQuotaState: null,
    textQuotaTriggerKey: "trigger_1",
    tomoriState: state,
    turn: {
      lockedTurn: {
        admission: {
          incoming: {
            retryCount: 0,
          },
        },
        channelId: "channel_1",
        lockedAt: Date.now(),
        queueDepth: 0,
        skipLock: false,
      },
    },
    userDiscId: "user_1",
  } as unknown as ChatTurnContext;
}

describe("runGenerationTurn fallback behavior", () => {
  beforeEach(async () => {
    queuedResults.length = 0;
    queuedDeliveries.length = 0;
    toolLoopCalls.length = 0;
    providerConfigCalls.length = 0;
    fallbackNoticeCalls.length = 0;
    personalSavedConfigLoads.length = 0;
    personalOverlayState = null;

    const { StreamOrchestrator } = await import("@/utils/discord/streamOrchestrator");
    StreamOrchestrator.clearStopRequest("channel_1");
    StreamOrchestrator.getAndClearStopContext("channel_1");
  });

  it("suppresses primary errors and posts compact fallback notice when a fallback succeeds", async () => {
    const primaryModel = makeLlm(1, "primary-model");
    const fallbackModel = makeLlm(2, "fallback-model");
    const context = makeContext(primaryModel, fallbackModel);
    const emittedErrors: unknown[] = [];
    const finalizedResults: GenerationTurnResult[] = [];
    const sink: ChatResponseSink = {
      emitStreamResult: async (result) => {
        emittedErrors.push(result);
      },
      emitError: async (error) => {
        emittedErrors.push(error);
      },
      finalize: async (result) => {
        finalizedResults.push(result);
      },
    };

    const fallbackSuccess: GenerationTurnResult = {
      status: "completed",
      streamResults: [{ status: "completed", accumulatedText: "ok" }],
      personaResponses: [
        {
          personaName: "Tomori",
          text: "ok",
          personaId: 10,
          personaLineageId: 100,
        },
      ],
    };
    queuedResults.push(
      {
        status: "error",
        streamResults: [{ status: "error", data: { type: "rate_limit", code: "429", message: "rate limited" } }],
        personaResponses: [],
      },
      fallbackSuccess,
    );

    const { runGenerationTurn } = await import("@/utils/chat/generationTurn");
    const result = await runGenerationTurn(context, sink);

    expect(result).toBe(fallbackSuccess);
    expect(toolLoopCalls).toEqual([
      { model: "primary-model", suppressUserErrors: true },
      { model: "fallback-model", suppressUserErrors: false },
    ]);
    expect(emittedErrors).toHaveLength(0);
    expect(finalizedResults).toEqual([fallbackSuccess]);
    expect(fallbackNoticeCalls).toHaveLength(1);
    expect(fallbackNoticeCalls[0]?.failures).toEqual([{ modelCodename: "primary-model", errorDetail: "rate limited" }]);
    expect(fallbackNoticeCalls[0]?.successModel.llm_codename).toBe("fallback-model");
    expect(context.streamingContext.suppressUserErrors).toBe(false);
    expect(context.streamingContext.forceModelFallback).toBe(false);
  });

  it("uses personal saved credentials for a user-scoped custom endpoint fallback", async () => {
    const primaryModel = makeLlm(1, "primary-model");
    const context = makeContext(primaryModel, makeLlm(2, "unused-fallback"));
    const endpoint = {
      custom_endpoint_id: 5,
      server_id: null,
      user_id: 4,
      label: "local",
      capability: "text",
      endpoint_url: "https://example.invalid/v1",
      model_name: "personal-fallback",
      model_ref_id: 9,
      has_tools: false,
      sees_images: false,
      sees_videos: false,
      supports_structoutput: false,
      strict_role_alternation: false,
      supports_prefix_completion: false,
    } as CustomEndpointRow;
    context.currentPersona.fallback_chain = [{ kind: "custom_endpoint", endpoint }];
    queuedResults.push(
      {
        status: "error",
        streamResults: [{ status: "error", data: { type: "rate_limit", code: "429", message: "rate limited" } }],
        personaResponses: [],
      },
      {
        status: "completed",
        streamResults: [{ status: "completed", accumulatedText: "ok" }],
        personaResponses: [{ personaName: "Tomori", text: "ok", personaId: 10, personaLineageId: 100 }],
      },
    );
    const sink: ChatResponseSink = {
      emitStreamResult: async () => undefined,
      emitError: async () => undefined,
      finalize: async () => undefined,
    };

    const { runGenerationTurn } = await import("@/utils/chat/generationTurn");
    await runGenerationTurn(context, sink);

    expect(toolLoopCalls.map((call) => call.model)).toEqual(["primary-model", "personal-fallback"]);
    expect(personalSavedConfigLoads).toEqual([{ userId: 4, provider: "custom:u4:local" }]);
  });

  it("falls back from a failed personal text model to the configured server model", async () => {
    const serverPrimary = makeLlm(1, "server-primary");
    const serverFallback = makeLlm(2, "server-fallback");
    const personalPrimary = makeLlm(3, "personal-primary");
    const context = makeContext(serverPrimary, serverFallback);
    context.textCredentialSource = "personal";
    context.personalRoutingUserId = 4;
    context.personalTextProvider = "openrouter";
    personalOverlayState = {
      ...context.currentPersona,
      llm: personalPrimary,
      fallback_chain: undefined,
      fallback_llms: undefined,
      config: { ...context.currentPersona.config, api_key: "personal-encrypted-key" },
    } as TomoriState;
    queuedResults.push(
      {
        status: "error",
        streamResults: [{ status: "error", data: { type: "rate_limit", code: "429", message: "rate limited" } }],
        personaResponses: [],
      },
      {
        status: "completed",
        streamResults: [{ status: "completed", accumulatedText: "ok" }],
        personaResponses: [{ personaName: "Tomori", text: "ok", personaId: 10, personaLineageId: 100 }],
      },
    );
    const sink: ChatResponseSink = {
      emitStreamResult: async () => undefined,
      emitError: async () => undefined,
      finalize: async () => undefined,
    };

    const { runGenerationTurn } = await import("@/utils/chat/generationTurn");
    await runGenerationTurn(context, sink);

    expect(toolLoopCalls.map((call) => call.model)).toEqual(["personal-primary", "server-primary"]);
    expect(providerConfigCalls).toEqual([
      { model: "personal-primary", apiKey: "personal-key" },
      { model: "server-primary", apiKey: "server-key" },
      { model: "server-fallback", apiKey: "server-key" },
    ]);
  });

  it("deletes the timed-out primary's partial message when a fallback succeeds", async () => {
    const primaryModel = makeLlm(1, "primary-model");
    const fallbackModel = makeLlm(2, "fallback-model");
    const context = makeContext(primaryModel, fallbackModel);

    const deletedWebhookMessageIds: string[] = [];
    (context as unknown as { responseTarget?: unknown }).responseTarget = {
      webhook: {
        deleteMessage: async (messageId: string) => {
          deletedWebhookMessageIds.push(messageId);
        },
      },
    };

    const finalizedResults: GenerationTurnResult[] = [];
    const sink: ChatResponseSink = {
      emitStreamResult: async () => undefined,
      emitError: async () => undefined,
      finalize: async (result) => {
        finalizedResults.push(result);
      },
    };

    const fallbackSuccess: GenerationTurnResult = {
      status: "completed",
      streamResults: [{ status: "completed", accumulatedText: "ok" }],
      personaResponses: [
        {
          personaName: "Tomori",
          text: "ok",
          personaId: 10,
          personaLineageId: 100,
        },
      ],
    };
    // Primary times out after flushing one partial webhook message; the fallback completes with its
    // own message. Only the fallback's message should remain in the channel (and the sink).
    queuedResults.push(
      {
        status: "timeout",
        streamResults: [
          { status: "timeout", data: new Error("SDK_CALL_TIMEOUT: provider streamToDiscord call timed out.") },
        ],
        personaResponses: [],
      },
      fallbackSuccess,
    );
    queuedDeliveries.push(
      [{ messageId: "partial_1", channelId: "channel_1", isWebhook: true }],
      [{ messageId: "fallback_1", channelId: "channel_1", isWebhook: true }],
    );

    const { runGenerationTurn } = await import("@/utils/chat/generationTurn");
    const result = await runGenerationTurn(context, sink);

    expect(result).toBe(fallbackSuccess);
    expect(finalizedResults).toEqual([fallbackSuccess]);
    expect(deletedWebhookMessageIds).toEqual(["partial_1"]);
    expect(context.streamingContext.deliveredMessageRefs?.map((ref) => ref.messageId)).toEqual(["fallback_1"]);
  });

  it("does not post fallback notice when fallback is interrupted by a follow-up", async () => {
    const primaryModel = makeLlm(1, "primary-model");
    const fallbackModel = makeLlm(2, "fallback-model");
    const context = makeContext(primaryModel, fallbackModel);
    const finalizedResults: GenerationTurnResult[] = [];
    const sink: ChatResponseSink = {
      emitStreamResult: async () => undefined,
      emitError: async () => undefined,
      finalize: async (result) => {
        finalizedResults.push(result);
      },
    };

    const interruptedResult: GenerationTurnResult = {
      status: "follow_up_interrupt",
      streamResults: [{ status: "follow_up_interrupt" }],
      personaResponses: [],
    };
    queuedResults.push(
      {
        status: "error",
        streamResults: [{ status: "error", data: { type: "rate_limit", code: "429", message: "rate limited" } }],
        personaResponses: [],
      },
      interruptedResult,
    );

    const { runGenerationTurn } = await import("@/utils/chat/generationTurn");
    const result = await runGenerationTurn(context, sink);

    expect(result).toBe(interruptedResult);
    expect(finalizedResults).toEqual([interruptedResult]);
    expect(fallbackNoticeCalls).toHaveLength(0);
  });

  it("does not post fallback notice when fallback is stopped by a natural stop", async () => {
    const primaryModel = makeLlm(1, "primary-model");
    const fallbackModel = makeLlm(2, "fallback-model");
    const context = makeContext(primaryModel, fallbackModel);
    const finalizedResults: GenerationTurnResult[] = [];
    const sink: ChatResponseSink = {
      emitStreamResult: async () => undefined,
      emitError: async () => undefined,
      finalize: async (result) => {
        finalizedResults.push(result);
      },
    };

    const stoppedResult: GenerationTurnResult = {
      status: "stopped_by_user",
      streamResults: [{ status: "stopped_by_user", stopReason: "user_request" }],
      personaResponses: [],
    };
    queuedResults.push(
      {
        status: "error",
        streamResults: [{ status: "error", data: { type: "rate_limit", code: "429", message: "rate limited" } }],
        personaResponses: [],
      },
      stoppedResult,
    );

    const { runGenerationTurn } = await import("@/utils/chat/generationTurn");
    const result = await runGenerationTurn(context, sink);

    expect(result).toBe(stoppedResult);
    expect(finalizedResults).toEqual([stoppedResult]);
    expect(fallbackNoticeCalls).toHaveLength(0);
  });

  it("suppresses completed fallback notice when a follow-up request is already pending", async () => {
    const primaryModel = makeLlm(1, "primary-model");
    const fallbackModel = makeLlm(2, "fallback-model");
    const context = makeContext(primaryModel, fallbackModel);
    const finalizedResults: GenerationTurnResult[] = [];
    const sink: ChatResponseSink = {
      emitStreamResult: async () => undefined,
      emitError: async () => undefined,
      finalize: async (result) => {
        finalizedResults.push(result);
      },
    };

    const fallbackSuccess: GenerationTurnResult = {
      status: "completed",
      streamResults: [{ status: "completed", accumulatedText: "ok" }],
      personaResponses: [
        {
          personaName: "Tomori",
          text: "ok",
          personaId: 10,
          personaLineageId: 100,
        },
      ],
    };
    queuedResults.push(
      {
        status: "error",
        streamResults: [{ status: "error", data: { type: "rate_limit", code: "429", message: "rate limited" } }],
        personaResponses: [],
      },
      fallbackSuccess,
    );

    const { StreamOrchestrator } = await import("@/utils/discord/streamOrchestrator");
    StreamOrchestrator.requestFollowUp(context.channel.id, context.userDiscId);

    const { runGenerationTurn } = await import("@/utils/chat/generationTurn");
    const result = await runGenerationTurn(context, sink);

    expect(result).toBe(fallbackSuccess);
    expect(finalizedResults).toEqual([fallbackSuccess]);
    expect(fallbackNoticeCalls).toHaveLength(0);
    expect(StreamOrchestrator.hasStopRequest(context.channel.id)).toBe(false);
  });

  it("suppresses completed fallback notice while preserving a pending stop response context", async () => {
    const primaryModel = makeLlm(1, "primary-model");
    const fallbackModel = makeLlm(2, "fallback-model");
    const context = makeContext(primaryModel, fallbackModel);
    const finalizedResults: GenerationTurnResult[] = [];
    const sink: ChatResponseSink = {
      emitStreamResult: async () => undefined,
      emitError: async () => undefined,
      finalize: async (result) => {
        finalizedResults.push(result);
      },
    };

    const fallbackSuccess: GenerationTurnResult = {
      status: "completed",
      streamResults: [{ status: "completed", accumulatedText: "ok" }],
      personaResponses: [
        {
          personaName: "Tomori",
          text: "ok",
          personaId: 10,
          personaLineageId: 100,
        },
      ],
    };
    queuedResults.push(
      {
        status: "error",
        streamResults: [{ status: "error", data: { type: "rate_limit", code: "429", message: "rate limited" } }],
        personaResponses: [],
      },
      fallbackSuccess,
    );

    const { StreamOrchestrator } = await import("@/utils/discord/streamOrchestrator");
    StreamOrchestrator.requestStop(context.channel.id, context.userDiscId, {
      originalStopMessage: context.message as unknown as Message,
      client: context.client as unknown as Client,
    });

    const { runGenerationTurn } = await import("@/utils/chat/generationTurn");
    const result = await runGenerationTurn(context, sink);

    expect(result).toBe(fallbackSuccess);
    expect(finalizedResults).toEqual([fallbackSuccess]);
    expect(fallbackNoticeCalls).toHaveLength(0);
    expect(StreamOrchestrator.getAndClearStopContext(context.channel.id)).not.toBeNull();
  });
});
