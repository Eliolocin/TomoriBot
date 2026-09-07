import type { FallbackEntry, LlmRow, TomoriState } from "@/types/db/schema";
import { ContextItemTag, type StructuredContextItem } from "@/types/misc/context";
import type { LLMProvider, ProviderConfig, StreamResult } from "@/types/provider/interfaces";
import type { ProviderError } from "@/types/stream/interfaces";
import type { DeliveredStreamMessage, ToolContext } from "@/types/tool/interfaces";
import { getCachedChannelLlm } from "@/utils/cache/channelLlmCache";
import { getGeminiTokenLimits } from "@/utils/cache/geminiCapabilityCache";
import { getNovelAITokenLimits } from "@/utils/cache/novelaiCapabilityCache";
import { getCachedContextTokens, refreshNovelAISubscription } from "@/utils/cache/novelaiSubscriptionCache";
import { getOpenRouterTokenLimits, isOpenRouterCapabilityCacheReady } from "@/utils/cache/openrouterCapabilityCache";
import { llmProviderRepo } from "@/utils/db/repositories";
import { type FallbackNoticeAttempt, sendFallbackModelUsageNotice } from "@/utils/discord/fallbackModelNotice";
import { StreamOrchestrator } from "@/utils/discord/streamOrchestrator";
import { deleteSupersededStreamMessages } from "@/utils/discord/stream/supersededMessageCleanup";
import { log } from "@/utils/misc/logger";
import { buildServerCustomProviderName, buildUserCustomProviderName } from "@/utils/provider/customProviderUtils";
import { getProviderForTomori, ProviderFactory } from "@/utils/provider/providerFactory";
import { getProviderErrorDetail } from "@/utils/provider/providerErrorClassification";
import { DEFAULT_MAX_OUTPUT_TOKENS, resolveMaxOutputTokens } from "@/utils/provider/maxOutputTokens";
import { applyPersonalProviderSelectionsToTomoriState } from "@/utils/provider/personalProviderRuntime";
import { decryptApiKey } from "@/utils/security/crypto";
import { resolveMediaForModel } from "@/utils/text/context/mediaResolver";
import {
  hasAvailableRotationKey,
  MAX_KEY_ATTEMPTS,
  recordKeyError,
  recordKeySuccess,
  selectApiKey,
} from "@/utils/security/keyRotation";
import { truncateDialogueHistory } from "@/utils/text/contextTruncator";
import type { ChatResponseSink, ChatTurnContext, GenerationTurnResult } from "@/utils/chat/types";
import { providerIsApiFamily, runToolLoop } from "@/utils/chat/toolLoop";
import { VERBATIM_TOOL_CALLING_NUDGE, shouldInjectVerbatimToolCallingNudge } from "@/utils/tools/verbatimToolCalling";

interface GenerationAttempt {
  label: string;
  tomoriState: TomoriState;
  provider: LLMProvider;
  providerConfig: ProviderConfig;
  successModel: LlmRow;
  /** Rotation key ID used for this attempt; null when rotation pool is inactive. */
  rotationKeyId: number | null;
}

const OPENROUTER_LENGTH_EMPTY_RETRY_DROP_PAIRS = parseIntegerEnvFlag(
  process.env.OPENROUTER_LENGTH_EMPTY_RETRY_DROP_PAIRS,
  2,
  1,
);

export async function runGenerationTurn(
  context: ChatTurnContext,
  responseSink: ChatResponseSink,
): Promise<GenerationTurnResult> {
  try {
    // Inside the try because prepare() is what creates the temporary webhook: a throw in the
    // channel-lock bookkeeping that follows creation would otherwise strand it with no cleanup.
    const responseTarget = await responseSink.prepare?.(context);
    if (responseTarget) {
      context.responseTarget = responseTarget;
    }

    return await runGenerationAttempts(context, responseSink);
  } finally {
    // emitGenerationError rethrows for user impersonation, so the error handler in
    // runGenerationAttempts can itself throw and never reach finalize. Without this the
    // turn's temporary webhook would survive in the channel.
    await responseSink.cleanup?.();
  }
}

async function runGenerationAttempts(
  context: ChatTurnContext,
  responseSink: ChatResponseSink,
): Promise<GenerationTurnResult> {
  try {
    const attempts = await buildGenerationAttempts(context);
    const failures: FallbackNoticeAttempt[] = [];
    const baseContextItems = context.contextItems;

    // Sink the streaming layer appends every committed message to. Initialized here (once per turn)
    // so a superseded attempt's partial output can be deleted when a later attempt supersedes it.
    context.streamingContext.deliveredMessageRefs ??= [];
    const deliveredMessageRefs = context.streamingContext.deliveredMessageRefs;

    for (const [index, attempt] of attempts.entries()) {
      const hasPendingModelFallback = index < attempts.length - 1;
      context.tomoriState = attempt.tomoriState;
      context.contextItems = await prepareProviderContextItems({
        contextItems: baseContextItems,
        tomoriState: attempt.tomoriState,
        serverDiscId: context.serverDiscId,
        emptyResponseFinishReason: context.turn.lockedTurn.admission.incoming.emptyResponseFinishReason,
        retryCount: context.turn.lockedTurn.admission.incoming.retryCount,
      });

      // Key rotation inner loop: try multiple keys for this attempt before giving up.
      let rotationKeyId = attempt.rotationKeyId;
      const excludedKeyIds = new Set<number>();
      let result!: GenerationTurnResult;
      let keyAttemptCount = 0;
      context.streamingContext.rotationKeyRetriesUsed = false;
      // Index into deliveredMessageRefs marking where the current runToolLoop invocation's
      // committed messages begin, so a superseded invocation's partials can be sliced out.
      let invocationStart = deliveredMessageRefs.length;

      while (true) {
        keyAttemptCount++;
        if (keyAttemptCount > MAX_KEY_ATTEMPTS) {
          log.warn(`Exceeded MAX_KEY_ATTEMPTS (${MAX_KEY_ATTEMPTS}) for ${attempt.label}.`);
          break;
        }

        const retryExcludedKeyIds = getRetryExcludedKeyIds(excludedKeyIds, rotationKeyId);
        const hasFallbackKey = await hasAvailableRotationKey(attempt.tomoriState, retryExcludedKeyIds);
        setStreamUserErrorSuppression(context, hasFallbackKey || hasPendingModelFallback);
        context.streamingContext.forceModelFallback = hasPendingModelFallback;

        invocationStart = deliveredMessageRefs.length;
        result = await runToolLoop({
          context,
          provider: attempt.provider,
          providerConfig: attempt.providerConfig,
          tomoriState: attempt.tomoriState,
        });

        if (result.status !== "error") {
          // Don't credit a timed-out key as successful : a timeout is not a clean completion.
          if (result.status !== "timeout" && rotationKeyId != null) await recordKeySuccess(rotationKeyId);
          break;
        }

        if (!hasFallbackKey) break;

        context.streamingContext.rotationKeyRetriesUsed = true;
        if (rotationKeyId != null) {
          const errorCode = extractErrorCode(result.streamResults.at(-1));
          const errorType = errorCode.includes("rate_limit") || errorCode.includes("429") ? "rate_limit" : "api_error";
          await recordKeyError(rotationKeyId, errorType, errorCode);
          excludedKeyIds.add(rotationKeyId);
        }

        const nextKey = await selectApiKey(attempt.tomoriState, [...Array.from(excludedKeyIds)]);
        if (!nextKey) break;

        // A key-rotation retry supersedes this invocation: delete its partial output before the
        // retry so the eventual response is not stacked on top of a truncated first attempt.
        await purgeSupersededDeliveries(context, deliveredMessageRefs, invocationStart);
        attempt.providerConfig.apiKey = nextKey.apiKey;
        rotationKeyId = nextKey.rotationKeyId;
        log.warn(
          `Key rotation: retrying ${attempt.label} with key ${rotationKeyId ?? "main"} (attempt ${keyAttemptCount + 1}).`,
        );
      }

      const isRetryableStatus = result.status === "error" || result.status === "timeout";
      if (!isRetryableStatus || index === attempts.length - 1) {
        if (index > 0 && shouldSendFallbackNotice(context, result)) {
          log.info(`Fallback generation succeeded with ${attempt.label} after ${failures.length} failed attempt(s).`);
          await sendFallbackNoticeIfNeeded(context, attempt, failures);
        }
        setStreamUserErrorSuppression(context, false);
        context.streamingContext.forceModelFallback = false;

        if (result.status === "error") {
          await emitStreamErrors(responseSink, result.streamResults);
        }
        await responseSink.finalize(result);
        return result;
      }

      // A model fallback supersedes this attempt: delete the partial output it committed (e.g. text
      // flushed before an SDK-call timeout) so only the fallback model's response remains visible.
      await purgeSupersededDeliveries(context, deliveredMessageRefs, invocationStart);

      failures.push({
        modelCodename: attempt.tomoriState.llm.llm_codename,
        errorDetail: extractErrorDetail(result.streamResults.at(-1)),
      });
    }

    const skipped: GenerationTurnResult = {
      status: "skipped",
      streamResults: [],
      personaResponses: [],
    };
    setStreamUserErrorSuppression(context, false);
    context.streamingContext.forceModelFallback = false;
    await responseSink.finalize(skipped);
    return skipped;
  } catch (error) {
    setStreamUserErrorSuppression(context, false);
    context.streamingContext.forceModelFallback = false;
    await responseSink.emitError(error);
    const result: GenerationTurnResult = {
      status: "error",
      streamResults: [{ status: "error", data: error }],
      personaResponses: [],
    };
    await responseSink.finalize(result);
    return result;
  }
}

function setStreamUserErrorSuppression(context: ChatTurnContext, temporarySuppressed: boolean): void {
  context.streamingContext.suppressUserErrors = temporarySuppressed || !context.shouldSurfaceUserErrors;
}

/**
 * Deletes and forgets the messages a superseded generation invocation committed to Discord.
 *
 * Slices off every delivered-message ref from `fromIndex` onward (this invocation's output plus any
 * stragglers an abandoned timeout stream flushed after it), removing them from the shared sink so
 * later attempts start clean, then best-effort deletes them from the channel. Called at each point
 * `runGenerationTurn` decides not to keep an invocation's result (key-rotation retry, model
 * fallback), so only the surviving attempt's messages remain visible.
 *
 * @param context - Active chat turn context (supplies the channel and persona webhook).
 * @param deliveredMessageRefs - The shared delivered-message sink for this turn.
 * @param fromIndex - First index belonging to the superseded invocation.
 */
async function purgeSupersededDeliveries(
  context: ChatTurnContext,
  deliveredMessageRefs: DeliveredStreamMessage[],
  fromIndex: number,
): Promise<void> {
  if (deliveredMessageRefs.length <= fromIndex) {
    return;
  }
  const superseded = deliveredMessageRefs.splice(fromIndex);
  log.info(`Deleting ${superseded.length} superseded partial message(s) from a failed generation attempt.`);
  await deleteSupersededStreamMessages(superseded, {
    channel: context.channel,
    webhook: context.responseTarget?.webhook,
  });
}

async function buildGenerationAttempts(context: ChatTurnContext): Promise<GenerationAttempt[]> {
  const disableAllTools = !!context.streamingContext.disableAllTools;
  const primaryState = await resolvePrimaryTomoriState(context);
  const personalFallbackEntries =
    primaryState.fallback_chain ?? primaryState.fallback_llms?.map((model) => ({ kind: "llm" as const, model })) ?? [];

  const pool: FallbackEntry[] = [{ kind: "llm", model: primaryState.llm }, ...personalFallbackEntries];

  // Model randomizer: when enabled, splice a random pool member to the front so a different model
  //    leads each turn. The remainder keeps its relative order as the failover tail. This is a pure
  //    reordering , so every model (including the original primary) stays in the chain, so failover
  //    semantics are preserved. When disabled, the pool order is unchanged from the legacy behavior.
  if (primaryState.config.model_randomizer_enabled && pool.length > 1) {
    const leadIdx = Math.floor(Math.random() * pool.length);
    pool.unshift(...pool.splice(leadIdx, 1));
  }

  // Materialize attempts from the (possibly reordered) pool. Reusing createFallbackAttempt for the
  //    primary's own llm entry yields a state equivalent to primaryState (provider matches, no config
  //    swap), so index 0 stays semantically identical to the old dedicated "primary" attempt.
  const attempts: GenerationAttempt[] = [];
  for (const [index, entry] of pool.entries()) {
    try {
      const attempt = await createFallbackAttempt(primaryState, entry, index, disableAllTools);
      if (!attempt) {
        // Only an unusable custom-endpoint lead resolves to null; the primary llm entry never does,
        // so at least one valid attempt always remains in the chain.
        continue;
      }
      // Keep logs readable: the lead is always labelled "primary" regardless of the random draw.
      //    The true model still surfaces via successModel for log verification.
      if (index === 0) {
        attempt.label = "primary";
      }
      attempts.push(attempt);
    } catch (error) {
      log.warn(`Skipping pool entry ${index}: failed to prepare provider config.`, error as Error);
    }
  }

  // A personal text route owns its primary and explicitly configured fallbacks, but a failed
  // personal provider must not make an otherwise configured server model unreachable. Build the
  // server attempts from the unmodified server state so they use the server's credentials even
  // when the personal and server models belong to the same provider.
  if (context.textCredentialSource === "personal" && !context.isUserImpersonation) {
    const serverState = await resolveServerTomoriState(context);
    const serverFallbackEntries =
      serverState.fallback_chain ?? serverState.fallback_llms?.map((model) => ({ kind: "llm" as const, model })) ?? [];
    const serverPool: FallbackEntry[] = [{ kind: "llm", model: serverState.llm }, ...serverFallbackEntries];

    for (const entry of serverPool) {
      try {
        const attempt = await createFallbackAttempt(serverState, entry, attempts.length, disableAllTools);
        if (attempt) {
          attempts.push(attempt);
        }
      } catch (error) {
        log.warn(`Skipping server fallback pool entry ${attempts.length}: failed to prepare provider config.`, error as Error);
      }
    }
  }

  return attempts;
}

// Must run before provider.createConfig : providers eagerly attach the full tool
// list and the streaming path won't strip them if has_tools flips later.
function applyDeliberateToolKillSwitch(state: TomoriState, disableAllTools: boolean): TomoriState {
  if (disableAllTools && state.llm.has_tools) {
    return { ...state, llm: { ...state.llm, has_tools: false } };
  }
  return state;
}

function getRetryExcludedKeyIds(excludedKeyIds: Set<number>, rotationKeyId: number | null): number[] {
  const ids = new Set(excludedKeyIds);
  if (rotationKeyId != null) {
    ids.add(rotationKeyId);
  }
  return [...ids];
}

async function emitStreamErrors(responseSink: ChatResponseSink, streamResults: StreamResult[]): Promise<void> {
  for (const streamResult of streamResults) {
    if (streamResult.status === "error") {
      await responseSink.emitStreamResult(streamResult);
    }
  }
}

async function sendFallbackNoticeIfNeeded(
  context: ChatTurnContext,
  attempt: GenerationAttempt,
  failures: FallbackNoticeAttempt[],
): Promise<void> {
  if (context.isUserImpersonation || failures.length === 0 || !context.shouldSurfaceUserErrors) {
    return;
  }

  await sendFallbackModelUsageNotice({
    context: {
      channel: context.channel as ToolContext["channel"],
      client: context.client,
      message: context.message,
      tomoriState: context.tomoriState,
      locale: context.locale,
      provider: attempt.provider.getInfo().name,
      webhook: context.responseTarget?.webhook,
      personaUsername: context.responseTarget?.personaUsername,
      personaAvatarUrl: context.responseTarget?.personaAvatarUrl,
    },
    failures,
    successModel: attempt.successModel,
  });
}

function shouldSendFallbackNotice(context: ChatTurnContext, result: GenerationTurnResult): boolean {
  if (result.status !== "completed") {
    return false;
  }

  if (!StreamOrchestrator.hasStopRequest(context.channel.id)) {
    return true;
  }

  log.info(
    `Skipping fallback model notice for channel ${context.channel.id} because a stop or follow-up interrupt is pending.`,
  );
  StreamOrchestrator.clearStopRequest(context.channel.id);
  return false;
}

async function resolvePrimaryTomoriState(context: ChatTurnContext): Promise<TomoriState> {
  const incoming = context.turn.lockedTurn.admission.incoming;
  const personalBase =
    context.textCredentialSource === "personal"
      ? (await applyPersonalProviderSelectionsToTomoriState(context.currentPersona, context.personalRoutingUserId))
          .tomoriState
      : context.currentPersona;
  const channelLlmOverride =
    context.isUserImpersonation || context.textCredentialSource === "personal"
      ? null
      : await getCachedChannelLlm(context.currentPersona.server_id, context.channel.id);
  const effectiveLlm =
    context.textCredentialSource === "personal" || context.isUserImpersonation
      ? personalBase.llm
      : (personalBase.persona_llm ?? channelLlmOverride ?? personalBase.llm);
  const overriddenLlm = incoming.llmOverrideCodename
    ? { ...effectiveLlm, llm_codename: incoming.llmOverrideCodename }
    : effectiveLlm;
  let state: TomoriState = { ...personalBase, llm: overriddenLlm };

  if (overriddenLlm.llm_provider.toLowerCase() !== personalBase.llm.llm_provider.toLowerCase()) {
    state = await applySavedProviderConfig(state, overriddenLlm.llm_provider);
  }

  return state;
}

/** Resolves the server's normal text route without applying a personal-provider overlay. */
async function resolveServerTomoriState(context: ChatTurnContext): Promise<TomoriState> {
  const incoming = context.turn.lockedTurn.admission.incoming;
  const channelLlmOverride = context.isUserImpersonation
    ? null
    : await getCachedChannelLlm(context.currentPersona.server_id, context.channel.id);
  const effectiveLlm = context.isUserImpersonation
    ? context.currentPersona.llm
    : (context.currentPersona.persona_llm ?? channelLlmOverride ?? context.currentPersona.llm);
  const overriddenLlm = incoming.llmOverrideCodename
    ? { ...effectiveLlm, llm_codename: incoming.llmOverrideCodename }
    : effectiveLlm;
  let state: TomoriState = { ...context.currentPersona, llm: overriddenLlm };

  if (overriddenLlm.llm_provider.toLowerCase() !== context.currentPersona.llm.llm_provider.toLowerCase()) {
    state = await applySavedProviderConfig(state, overriddenLlm.llm_provider);
  }

  return state;
}

async function createFallbackAttempt(
  primaryState: TomoriState,
  entry: FallbackEntry,
  fallbackIndex: number,
  disableAllTools: boolean,
): Promise<GenerationAttempt | null> {
  if (entry.kind === "custom_endpoint") {
    const endpointUserId = entry.endpoint.user_id ?? null;
    const endpointServerId = entry.endpoint.server_id ?? null;
    const customProviderName = endpointUserId
      ? buildUserCustomProviderName(endpointUserId, entry.endpoint.label)
      : endpointServerId === primaryState.server_id
        ? buildServerCustomProviderName(endpointServerId, entry.endpoint.label)
        : null;
    if (!customProviderName) {
      log.warn(`Skipping custom endpoint fallback ${entry.endpoint.label}: invalid owner scope.`);
      return null;
    }

    const savedConfig = endpointUserId
      ? await llmProviderRepo.loadUserSavedProviderConfig(endpointUserId, customProviderName)
      : await llmProviderRepo.loadSavedProviderConfig(primaryState.server_id, customProviderName);
    if (!savedConfig?.api_key) {
      log.warn(`Skipping custom endpoint fallback ${entry.endpoint.label}: no saved key.`);
      return null;
    }

    const state: TomoriState = {
      ...primaryState,
      config: {
        ...primaryState.config,
        api_key: savedConfig.api_key,
        key_version: savedConfig.key_version ?? 1,
        custom_endpoint_url: entry.endpoint.endpoint_url,
        custom_model_name: entry.endpoint.model_name ?? null,
      },
      llm: {
        ...primaryState.llm,
        llm_id: entry.endpoint.model_ref_id ?? primaryState.llm.llm_id,
        llm_codename: entry.endpoint.model_name ?? entry.endpoint.label,
        llm_provider: customProviderName,
        has_tools: entry.endpoint.has_tools,
        sees_images: entry.endpoint.sees_images,
        sees_videos: entry.endpoint.sees_videos,
        supports_structoutput: entry.endpoint.supports_structoutput,
        strict_role_alternation: entry.endpoint.strict_role_alternation,
        supports_prefix_completion: entry.endpoint.supports_prefix_completion,
      },
    };
    return await createAttempt(`fallback ${fallbackIndex}: ${entry.endpoint.label}`, state, "custom", disableAllTools);
  }

  let state: TomoriState = { ...primaryState, llm: entry.model };
  if (entry.model.llm_provider.toLowerCase() !== primaryState.llm.llm_provider.toLowerCase()) {
    state = await applySavedProviderConfig(state, entry.model.llm_provider);
  }
  return await createAttempt(
    `fallback ${fallbackIndex}: ${entry.model.llm_codename}`,
    state,
    undefined,
    disableAllTools,
  );
}

async function createAttempt(
  label: string,
  tomoriState: TomoriState,
  forcedProviderName?: string,
  disableAllTools = false,
): Promise<GenerationAttempt> {
  const effectiveState = applyDeliberateToolKillSwitch(tomoriState, disableAllTools);

  const provider = forcedProviderName
    ? await ProviderFactory.getProviderByName(forcedProviderName)
    : await getProviderForTomori(effectiveState);

  const rotationSelection = await selectApiKey(effectiveState);
  const apiKey = rotationSelection ? rotationSelection.apiKey : await resolveApiKey(effectiveState);
  const rotationKeyId = rotationSelection?.rotationKeyId ?? null;

  const providerConfig = await provider.createConfig(effectiveState, apiKey);

  return {
    label,
    tomoriState: effectiveState,
    provider,
    providerConfig,
    successModel: effectiveState.llm,
    rotationKeyId,
  };
}

async function resolveApiKey(tomoriState: TomoriState): Promise<string> {
  const encryptedKey = tomoriState.config.api_key;
  if (!encryptedKey) {
    throw new Error("API key is not configured for the selected text provider.");
  }

  return await decryptApiKey(encryptedKey, tomoriState.config.key_version || 1);
}

async function applySavedProviderConfig(tomoriState: TomoriState, providerName: string): Promise<TomoriState> {
  const savedConfig = await llmProviderRepo.loadSavedProviderConfig(tomoriState.server_id, providerName.toLowerCase());
  if (!savedConfig?.api_key) {
    throw new Error(`No saved credentials found for provider ${providerName}.`);
  }

  return {
    ...tomoriState,
    config: {
      ...tomoriState.config,
      api_key: savedConfig.api_key,
      key_version: savedConfig.key_version ?? 1,
      llm_temperature: savedConfig.llm_temperature ?? tomoriState.config.llm_temperature,
      llm_top_p: savedConfig.llm_top_p ?? tomoriState.config.llm_top_p,
      llm_top_k: savedConfig.llm_top_k ?? tomoriState.config.llm_top_k,
      llm_frequency_penalty: savedConfig.llm_frequency_penalty ?? tomoriState.config.llm_frequency_penalty,
      llm_presence_penalty: savedConfig.llm_presence_penalty ?? tomoriState.config.llm_presence_penalty,
      llm_min_p: savedConfig.llm_min_p ?? tomoriState.config.llm_min_p,
      thinking_level: savedConfig.thinking_level ?? tomoriState.config.thinking_level,
      llm_disabled_params: savedConfig.llm_disabled_params ?? tomoriState.config.llm_disabled_params,
      llm_logit_biases: savedConfig.llm_logit_biases ?? tomoriState.config.llm_logit_biases,
    },
  };
}

function extractErrorCode(streamResult: StreamResult | undefined): string {
  const data = streamResult?.data;
  if (!data || typeof data !== "object") {
    return streamResult?.status ?? "unknown";
  }
  if (data instanceof Error) {
    return data.message || "error";
  }
  const record = data as Record<string, unknown>;
  return String(record.code ?? record.type ?? record.message ?? streamResult?.status ?? "unknown");
}

// Per-line readability cap for a single failure detail in the fallback notice summary. This keeps
// one verbose provider message from crowding out the others; the authoritative Discord embed
// description limit is enforced on the joined list in `buildFailureList` (fallbackModelNotice.ts).
const MAX_FALLBACK_DETAIL_LENGTH = 600;

/**
 * Resolves a human-readable failure detail for the "Fallback Model Used" notice. Unlike
 * {@link extractErrorCode} (which prefers terse codes for key-rotation bookkeeping), this prefers
 * the provider's verbose message: e.g. "Unsupported model X. Supported IDs: ...", so users see
 * the actionable reason instead of an opaque error code.
 * @param streamResult - The last stream result recorded for the failed attempt.
 */
function extractErrorDetail(streamResult: StreamResult | undefined): string {
  const data = streamResult?.data;
  if (!data || typeof data !== "object") {
    return streamResult?.status ?? "unknown";
  }
  if (data instanceof Error) {
    return truncateFallbackDetail(data.message || "error");
  }

  const providerDetail = getProviderErrorDetail(data as ProviderError);
  if (providerDetail) {
    return truncateFallbackDetail(providerDetail);
  }

  const record = data as Record<string, unknown>;
  return truncateFallbackDetail(
    String(record.message ?? record.code ?? record.type ?? streamResult?.status ?? "unknown"),
  );
}

function truncateFallbackDetail(detail: string): string {
  const normalized = detail.replace(/\s+/g, " ").trim();
  return normalized.length > MAX_FALLBACK_DETAIL_LENGTH
    ? `${normalized.substring(0, MAX_FALLBACK_DETAIL_LENGTH)}...`
    : normalized;
}

async function prepareProviderContextItems(args: {
  contextItems: StructuredContextItem[];
  tomoriState: TomoriState;
  serverDiscId: string;
  emptyResponseFinishReason: string | null | undefined;
  retryCount: number;
}): Promise<StructuredContextItem[]> {
  let contextItems = await resolveMediaForModel(args.contextItems, args.tomoriState);

  // The verbatim tool-calling nudge is baked into the base context from the PRIMARY
  // model. On a fallback to an attempt that will not run the verbatim parser (any
  // non-custom provider, or a custom endpoint without tools), strip it: the nudge is
  // useless noise there and can steer native tool-callers toward unparseable
  // text-form calls. `filter` produces a new array, leaving the shared base intact.
  if (!shouldInjectVerbatimToolCallingNudge(args.tomoriState.config, args.tomoriState)) {
    contextItems = stripVerbatimNudgeItems(contextItems);
  }

  contextItems = await applyProviderContextTruncation(contextItems, args.tomoriState, args.serverDiscId);
  if (
    shouldApplyLengthEmptyRetryTrim(args.tomoriState.llm.llm_provider, args.emptyResponseFinishReason, args.retryCount)
  ) {
    const requestedPairDrops = OPENROUTER_LENGTH_EMPTY_RETRY_DROP_PAIRS * args.retryCount;
    const { truncated, historyPairsDropped } = dropOldestHistoryExchangePairs(contextItems, requestedPairDrops);
    if (historyPairsDropped > 0) {
      log.warn(
        `OpenRouter length-empty retry trimming: dropped ${historyPairsDropped}/${requestedPairDrops} oldest history exchange pair(s) on retry ${args.retryCount}.`,
      );
      contextItems = truncated;
    }
  }
  return contextItems;
}

/**
 * The exact text the verbatim nudge is rendered as inside a context-note item
 * (see `appendDialogueHistoryContext`). Matching on the text rather than the tag
 * is required because the user's global context note shares
 * `ContextItemTag.CONTEXT_NOTE_INJECTION`.
 */
const VERBATIM_NUDGE_CONTEXT_TEXT = `[System: ${VERBATIM_TOOL_CALLING_NUDGE}]`;

/** Returns a new array with the verbatim tool-calling nudge note removed, if present. */
function stripVerbatimNudgeItems(items: StructuredContextItem[]): StructuredContextItem[] {
  return items.filter((item) => {
    if (item.metadataTag !== ContextItemTag.CONTEXT_NOTE_INJECTION) {
      return true;
    }
    const text = item.parts.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
    return text !== VERBATIM_NUDGE_CONTEXT_TEXT;
  });
}

function dropOldestHistoryExchangePairs(
  contextItems: StructuredContextItem[],
  pairsToDrop: number,
): { truncated: StructuredContextItem[]; historyPairsDropped: number } {
  if (pairsToDrop <= 0) {
    return { truncated: contextItems, historyPairsDropped: 0 };
  }

  const items = [...contextItems];
  let historyPairsDropped = 0;
  while (historyPairsDropped < pairsToDrop) {
    const oldestHistoryIndex = items.findIndex((item) => item.metadataTag === ContextItemTag.DIALOGUE_HISTORY);
    if (oldestHistoryIndex < 0) {
      break;
    }
    const followingModelIndex = items.findIndex(
      (item, index) =>
        index > oldestHistoryIndex && item.metadataTag === ContextItemTag.DIALOGUE_HISTORY && item.role === "model",
    );
    if (followingModelIndex > oldestHistoryIndex) {
      items.splice(oldestHistoryIndex, followingModelIndex - oldestHistoryIndex + 1);
    } else {
      items.splice(oldestHistoryIndex, 1);
    }
    historyPairsDropped++;
  }

  return { truncated: items, historyPairsDropped };
}

async function applyProviderContextTruncation(
  contextItems: StructuredContextItem[],
  tomoriState: TomoriState,
  serverDiscId: string,
): Promise<StructuredContextItem[]> {
  if (
    providerIsApiFamily(tomoriState.llm.llm_provider, "openrouter") &&
    tomoriState.llm.llm_codename !== "other-model" &&
    isOpenRouterCapabilityCacheReady()
  ) {
    const tokenLimits = getOpenRouterTokenLimits(tomoriState.llm.llm_codename);
    if (tokenLimits && tokenLimits.contextLength > 0 && tokenLimits.maxCompletionTokens) {
      // Reserve the SAME output budget the request builder sends: the server's
      // `/model parameters` override first, then OPENROUTER_MAX_OUTPUT_TOKENS, then a
      // flat 8192 , so clamped to the model's reported completion ceiling. Previously this
      // ignored the server override, over-reserving output and dropping fitting history.
      const truncationMaxCompletionTokens = resolveMaxOutputTokens({
        configured: tomoriState.config.llm_max_output_tokens,
        envRaw: process.env.OPENROUTER_MAX_OUTPUT_TOKENS,
        fallback: DEFAULT_MAX_OUTPUT_TOKENS,
        providerReportedMax: tokenLimits.maxCompletionTokens,
      });
      const { truncated, historyPairsDropped, sampleItemsDropped, totalDropped } = truncateDialogueHistory(
        contextItems,
        tokenLimits.contextLength,
        truncationMaxCompletionTokens,
      );
      if (totalDropped > 0) {
        log.warn(
          `History truncation: dropped ${historyPairsDropped} history exchange pair(s) and ${sampleItemsDropped} sample dialogue item(s) for ${tomoriState.llm.llm_codename} to preserve output budget`,
        );
        return truncated;
      }
    }
    return contextItems;
  }

  if (providerIsApiFamily(tomoriState.llm.llm_provider, "google-genai")) {
    const tokenLimits = getGeminiTokenLimits(tomoriState.llm.llm_codename);
    if (tokenLimits && tokenLimits.contextLength > 0 && tokenLimits.maxCompletionTokens) {
      // Use the SAME fallback chain as the Google request builder (config override →
      // GOOGLE_MAX_OUTPUT_TOKENS → flat 8192), so big-ceiling Gemini models (e.g. 65536
      // reported) no longer over-reserve output and drop history that would otherwise fit.
      // The extra clamp to the model-reported ceiling (which the request builder omits) only
      // bites when the resolved value is ABOVE what the model can emit; reserving the real
      // ceiling there is correct , so the model cannot output more than that regardless of the
      // requested max, so this never under-reserves relative to actual output.
      const truncationMaxCompletionTokens = resolveMaxOutputTokens({
        configured: tomoriState.config.llm_max_output_tokens,
        envRaw: process.env.GOOGLE_MAX_OUTPUT_TOKENS,
        fallback: DEFAULT_MAX_OUTPUT_TOKENS,
        providerReportedMax: tokenLimits.maxCompletionTokens,
      });
      const { truncated, historyPairsDropped, sampleItemsDropped, totalDropped } = truncateDialogueHistory(
        contextItems,
        tokenLimits.contextLength,
        truncationMaxCompletionTokens,
      );
      if (totalDropped > 0) {
        log.warn(
          `History truncation: dropped ${historyPairsDropped} history exchange pair(s) and ${sampleItemsDropped} sample dialogue item(s) for ${tomoriState.llm.llm_codename} to preserve output budget`,
        );
        return truncated;
      }
    }
    return contextItems;
  }

  if (providerIsApiFamily(tomoriState.llm.llm_provider, "novelai")) {
    let naiSubscriptionTokens = getCachedContextTokens(serverDiscId);
    if (naiSubscriptionTokens === undefined && tomoriState.config.api_key) {
      try {
        const tempKey = await decryptApiKey(tomoriState.config.api_key, tomoriState.config.key_version || 1);
        naiSubscriptionTokens = await refreshNovelAISubscription(serverDiscId, tempKey);
      } catch (error) {
        log.warn("Failed to refresh NovelAI subscription for context truncation; using default token limits.", error);
      }
    }
    const tokenLimits = getNovelAITokenLimits(tomoriState.llm.llm_codename, naiSubscriptionTokens);
    if (tokenLimits && tokenLimits.contextLength > 0 && tokenLimits.maxCompletionTokens) {
      // NovelAI has no dedicated output-token env cap, so the reserve falls back to the
      // subscription-tier ceiling unless the server set a `/model parameters` override.
      const truncationMaxCompletionTokens = resolveMaxOutputTokens({
        configured: tomoriState.config.llm_max_output_tokens,
        envRaw: undefined,
        fallback: tokenLimits.maxCompletionTokens,
        providerReportedMax: tokenLimits.maxCompletionTokens,
      });
      const { truncated, historyPairsDropped, sampleItemsDropped, totalDropped } = truncateDialogueHistory(
        contextItems,
        tokenLimits.contextLength,
        truncationMaxCompletionTokens,
      );
      if (totalDropped > 0) {
        log.warn(
          `History truncation: dropped ${historyPairsDropped} history exchange pair(s) and ${sampleItemsDropped} sample dialogue item(s) for ${tomoriState.llm.llm_codename} to preserve output budget`,
        );
        return truncated;
      }
    }
  }

  return contextItems;
}

function shouldApplyLengthEmptyRetryTrim(
  providerName: string,
  emptyResponseFinishReason: string | null | undefined,
  retryCount: number,
): boolean {
  return emptyResponseFinishReason === "length" && retryCount > 0 && providerIsApiFamily(providerName, "openrouter");
}

function parseIntegerEnvFlag(value: string | undefined, defaultValue: number, minimum: number): number {
  if (typeof value !== "string") return defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return defaultValue;
  return Math.max(minimum, parsed);
}
