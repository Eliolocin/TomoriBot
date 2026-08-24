/**
 * OpenRouter-specific streaming adapter
 *
 * This adapter implements the StreamProvider interface for OpenRouter's API,
 * which uses OpenAI-compatible streaming format with Server-Sent Events (SSE).
 *
 * Key responsibilities:
 * - Initialize OpenRouter client and configure streaming
 * - Convert context items to OpenAI message format
 * - Handle OpenRouter-specific API responses and errors
 * - Extract function calls from OpenRouter's response format
 * - Convert OpenRouter chunks to normalized ProcessedChunk format
 * - Handle ": OPENROUTER PROCESSING" SSE comments (keepalive)
 * - Handle mid-stream errors with unified error format
 */

import type { FunctionCall, FunctionResponseImageMetadata, ThoughtLogEntry } from "../../types/provider/interfaces";
import { ContextItemTag, type StructuredContextItem } from "../../types/misc/context";
import { log } from "../../utils/misc/logger";
import { localizer } from "../../utils/text/localizer";
import { truncateBeforeGenericSpeakerLine } from "@/utils/text/processors/llmOutputProcessor";
import { escapeRegExp } from "@/utils/text/processors/regexUtils";
import {
  collectRenderModifierSourceNames,
  isAllowedRenderModifierSpeakerLabel,
} from "@/utils/discord/renderModifierParser";
import { collectPersonaNameAliases } from "@/utils/discord/stream/textConfig";
import {
  getOpenRouterCapabilities,
  getOpenRouterSupportedParameters,
  getOpenRouterTokenLimits,
  isOpenRouterCapabilityCacheReady,
} from "../../utils/cache/openrouterCapabilityCache";
import { buildProviderStopStrings } from "../utils/stopStrings";
import { fetchAndOptimizeImage } from "../../utils/image/imageProcessor";
import { inlineToolResponseImage } from "@/providers/utils/toolImageContent";
import { buildOpenrouterProviderRouting } from "./providerRouting";
import { buildOpenRouterReasoningRequest } from "@/utils/provider/thinkingControl";
import { buildOpenRouterAttributionHeaders } from "@/utils/provider/openrouterAttribution";
import { logRawProviderError } from "@/utils/provider/providerErrorLogging";
import { BaseStreamAdapter } from "../../types/stream/interfaces";
import { ReasoningContentSpillGuard } from "@/providers/utils/reasoningContentSpillGuard";
import { assistantMediaRelocationNotice, relocateAssistantMediaContextItems } from "@/providers/utils/strictChatCompat";
import { ThinkBlockContentStripper } from "@/providers/utils/thinkBlockContentStripper";
import {
  buildDegradationAttempts,
  buildImageStripAttempt,
  buildTargetedAttempt,
  classifyDegradableError,
  describeDegradationTrigger,
  extractRejectedParams,
  isMultimodalRejectionError,
  MAX_TARGETED_DEGRADATION_ATTEMPTS,
  stripImageBlocksWithNotice,
  type DegradableErrorInput,
} from "@/providers/utils/paramDegradation";
import type {
  ProcessedChunk,
  ProviderError,
  RawStreamChunk,
  StreamConfig,
  StreamContext,
} from "../../types/stream/interfaces";

/**
 * OpenRouter-specific stream configuration extending the base StreamConfig
 */
export interface OpenrouterStreamConfig extends StreamConfig {
  // OpenRouter uses OpenAI-compatible config, simple structure
  seesImages?: boolean; // Whether the model supports image inputs
  seesVideos?: boolean; // Whether the model supports video inputs
  // Sampling parameters to control output quality
  topP?: number; // Nucleus sampling (0.0-1.0)
  topK?: number; // Top-k sampling
  frequencyPenalty?: number; // Penalize frequent tokens (-2.0 to 2.0)
  presencePenalty?: number; // Penalize repeated topics (-2.0 to 2.0)
  repetitionPenalty?: number; // Penalize token repetition (0.0-2.0)
  minP?: number; // Minimum probability threshold (0.0=disabled)
  logitBias?: Record<string, number>; // OpenAI-style token-ID bias map
}

/**
 * Raw chunk from OpenRouter's streaming API (OpenAI-compatible format)
 */
interface OpenrouterStreamChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  provider?: string;
  choices?: Array<{
    index: number;
    delta?: {
      role?: string;
      content?: string | null;
      reasoning?: string | null;
      // OpenRouter SDK uses camelCase, not snake_case!
      toolCalls?: Array<{
        index?: number; // Index of the tool call (for tracking across chunks)
        id?: string;
        type?: string;
        thought_signature?: string; // Gemini-specific: signature for reasoning continuity
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
      // OpenAI-style snake_case tool calls (raw OpenRouter API)
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        thought_signature?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
      // Reasoning details for preserving reasoning continuity (required for Gemini models)
      // biome-ignore lint/suspicious/noExplicitAny: reasoning_details has complex nested structure that varies by provider
      reasoning_details?: any[];
      // Some providers may send camelCase reasoningDetails
      // biome-ignore lint/suspicious/noExplicitAny: reasoningDetails has complex nested structure that varies by provider
      reasoningDetails?: any[];
    };
    finishReason?: string | null;
    finish_reason?: string | null;
    logprobs?: unknown | null;
  }>;
  usage?: {
    promptTokens?: number;
    prompt_tokens?: number;
    completionTokens?: number;
    completion_tokens?: number;
    totalTokens?: number;
    total_tokens?: number;
    completionTokensDetails?: unknown;
    completion_tokens_details?: unknown;
  };
  error?:
    | {
        code?: string | number;
        message?: string;
      }
    | ProviderError;
}

/**
 * Accumulated tool call data across streaming chunks
 */
interface AccumulatedToolCall {
  id?: string;
  type?: string;
  thought_signature?: string; // Gemini-specific: signature for reasoning continuity
  functionName: string;
  functionArguments: string;
}

// Defaults off because Bun's `verbose` prints every request header, including the
// `Authorization: Bearer` line, and it prints below application code so nothing here can
// redact it. Enabling this writes the OpenRouter API key in clear text to container logs
// and to anything shipping them onward.
const OPENROUTER_VERBOSE_FETCH = (process.env.OPENROUTER_VERBOSE_FETCH ?? "false").trim().toLowerCase() === "true";

/**
 * OpenRouter streaming adapter implementation
 */
export class OpenrouterStreamAdapter extends BaseStreamAdapter {
  private static readonly TEMPERATURE_OMIT_MODELS = new Set<string>([
    // Models that don't support temperature parameter
    // (empty - pony-alpha removed as deprecated)
  ]);

  private static readonly SPEAKER_GUARD_HOLDBACK_CHARS = 32;
  private static readonly STREAM_TEXT_TAIL_CHARS = 4096;
  private static readonly STREAM_TEXT_MIN_DEDUP_CHARS = 8;

  private static readonly SYSTEM_INSTRUCTION_TAGS: ContextItemTag[] = [
    ContextItemTag.SYSTEM_HUMANIZER_RULES,
    ContextItemTag.SYSTEM_PERSONA_PROMPT,
    ContextItemTag.SYSTEM_PERSONALITY,
    ContextItemTag.KNOWLEDGE_SERVER_INFO,
    ContextItemTag.KNOWLEDGE_SERVER_EMOJIS, // Text-based with semantic metadata (deterministic ordering)
    ContextItemTag.KNOWLEDGE_SERVER_STICKERS, // Text-based with semantic metadata (deterministic ordering)
    ContextItemTag.KNOWLEDGE_SERVER_MEMORIES,
  ];

  private toolCallAccumulator: Map<number, AccumulatedToolCall> = new Map();

  // Accumulator for reasoning_details across streaming chunks (required for Gemini models)
  // biome-ignore lint/suspicious/noExplicitAny: reasoning_details has complex nested structure that varies by provider
  private reasoningDetailsAccumulator: any[] = [];
  private readonly thinkBlockStripper = new ThinkBlockContentStripper({ loggerName: "OpenRouter" });
  private readonly reasoningContentSpillGuard = new ReasoningContentSpillGuard("OpenRouter");
  private speakerGuardPendingTail = "";
  private streamedTextTail = "";
  // Upstream backend OpenRouter routed to (e.g. "minimax-cn"); surfaced in thought logs.
  private servingProvider?: string;
  private speakerGuardEnabled = false;
  private speakerGuardAllowedSourceNames: string[] = [];

  constructor() {
    super({
      name: "openrouter",
      version: "1.0.0",
      supportsFunctionCalling: true,
    });
  }

  /**
   * Build OpenRouter chat messages from structured context.
   * Exposed so non-streaming callers (for example, token probes) can reuse
   * the exact same payload conversion path as runtime streaming.
   */
  public async buildProbeMessages(
    contextItems: StructuredContextItem[],
    seesImages = true,
    seesVideos = false,
  ): Promise<Array<Record<string, unknown>>> {
    return this.assembleOpenrouterContext(contextItems, [], undefined, seesImages, "Assistant", seesVideos);
  }

  private isOpenRouterParamSupported(
    supportedParameters: ReadonlySet<string> | null,
    param: string,
    aliases: string[] = [],
  ): boolean {
    if (!supportedParameters) return true;
    return supportedParameters.has(param) || aliases.some((alias) => supportedParameters.has(alias));
  }

  /**
   * Strips image content from messages for fallback requests
   * Used when auto-routers select models that don't support vision
   *
   * Delegates to the shared notice-injecting helper: each affected message
   * keeps a text notice in place of its removed image blocks so the model
   * stays aware an image was attached instead of silently losing it.
   */
  private stripImagesFromMessages(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return stripImageBlocksWithNotice(messages);
  }

  /**
   * Estimate input tokens for context-window safety capping.
   *
   * This intentionally ignores inline base64 data-URI payloads (for image_url
   * parts) because their serialized character length does not map to text token
   * usage in multimodal models.
   */
  private estimateInputTokensForSafetyCap(messages: Array<Record<string, unknown>>): number {
    const estimatedChars = messages.reduce((total, message) => total + this.estimateValueCharsForSafetyCap(message), 0);
    return Math.ceil(estimatedChars / 4);
  }

  private estimateValueCharsForSafetyCap(value: unknown, parentKey?: string): number {
    if (typeof value === "string") {
      if (parentKey === "url" && value.startsWith("data:") && value.includes(";base64,")) {
        return 0;
      }
      return value.length;
    }

    if (Array.isArray(value)) {
      return value.reduce((total, item) => total + this.estimateValueCharsForSafetyCap(item, parentKey), 0);
    }

    if (!value || typeof value !== "object") {
      return 0;
    }

    const record = value as Record<string, unknown>;
    if (parentKey === "image_url" || parentKey === "imageUrl") {
      const urlValue = record.url;
      if (typeof urlValue !== "string") {
        return 0;
      }
      if (urlValue.startsWith("data:") && urlValue.includes(";base64,")) {
        return 0;
      }
      return urlValue.length;
    }

    let totalChars = 0;
    for (const [key, childValue] of Object.entries(record)) {
      if (key === "image_url" || key === "imageUrl") {
        totalChars += this.estimateValueCharsForSafetyCap(childValue, key);
        continue;
      }
      totalChars += key.length;
      totalChars += this.estimateValueCharsForSafetyCap(childValue, key);
    }

    return totalChars;
  }

  /** Reset every mutable field that can be touched before an SSE attempt commits. */
  private resetPerAttemptState(personaSpeakerLabelRegex: RegExp | null): void {
    this.toolCallAccumulator.clear();
    this.reasoningDetailsAccumulator = [];
    this.speakerGuardPendingTail = "";
    this.streamedTextTail = "";
    this.servingProvider = undefined;
    this.reasoningContentSpillGuard.reset();
    this.thinkBlockStripper.reset(personaSpeakerLabelRegex);
  }

  private getMidStreamError(chunk: OpenrouterStreamChunk): DegradableErrorInput | null {
    if (!chunk.error) return null;
    const code = chunk.error.code;
    const numericCode = typeof code === "number" ? code : Number(code);
    return {
      statusCode: Number.isFinite(numericCode) ? numericCode : null,
      message: chunk.error.message ?? "OpenRouter API error",
    };
  }

  /** Text, reasoning, tool-call deltas, and usage are the stream commitment point. */
  private isMeaningfulCommitmentChunk(chunk: OpenrouterStreamChunk): boolean {
    if (chunk.usage) return true;
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return false;
    return Boolean(
      (typeof delta.content === "string" && delta.content.length > 0) ||
        (typeof delta.reasoning === "string" && delta.reasoning.length > 0) ||
        (delta.toolCalls && delta.toolCalls.length > 0) ||
        (delta.tool_calls && delta.tool_calls.length > 0) ||
        (delta.reasoning_details && delta.reasoning_details.length > 0) ||
        (delta.reasoningDetails && delta.reasoningDetails.length > 0),
    );
  }

  private parseHttpErrorFromResponse(
    responseStatus: number,
    responseStatusText: string,
    errorText: string,
    requestBody: Record<string, unknown>,
    model: string | undefined,
    attemptLabel: string,
  ): { error: Error; errorMessage: string; statusCode: number } {
    let errorMessage = errorText || responseStatusText;
    let errorCode: string | undefined;
    let rawErrorBodyFromMetadata: string | undefined;

    try {
      const errorData = JSON.parse(errorText) as {
        error?: {
          message?: string;
          code?: string | number;
          metadata?: { raw?: string };
        };
        message?: string;
      };
      errorCode = errorData?.error?.code !== undefined ? String(errorData.error.code) : undefined;
      rawErrorBodyFromMetadata = errorData?.error?.metadata?.raw;
      errorMessage =
        errorData?.error?.metadata?.raw ||
        errorData?.error?.message ||
        errorData?.message ||
        errorText ||
        responseStatusText;
    } catch {
      errorMessage = errorText || responseStatusText;
    }

    const statusLabel = errorCode ? `HTTP ${responseStatus} (${errorCode})` : `HTTP ${responseStatus}`;
    const requestParamKeys = Object.keys(requestBody).sort().join(", ");
    const rawErrorBody = rawErrorBodyFromMetadata || errorText;
    const rawErrorBodySnippet = rawErrorBody.length > 3000 ? `${rawErrorBody.substring(0, 3000)}...` : rawErrorBody;
    const shouldAppendRawBody =
      classifyDegradableError({ statusCode: 400, message: errorMessage }) === "generic_400" &&
      Boolean(rawErrorBodySnippet);

    return {
      error: new Error(
        `${statusLabel}: ${errorMessage}${shouldAppendRawBody ? ` | raw_response: ${rawErrorBodySnippet}` : ""} | model: ${model ?? "other-model"} | request_params: ${requestParamKeys} | request_attempt: ${attemptLabel}`,
      ),
      errorMessage,
      statusCode: responseStatus,
    };
  }

  async *startStream(config: StreamConfig, context: StreamContext): AsyncGenerator<RawStreamChunk, void, unknown> {
    log.info("OpenrouterStreamAdapter: Initializing OpenRouter streaming");

    this.toolCallAccumulator.clear();
    this.reasoningDetailsAccumulator = [];
    this.speakerGuardPendingTail = "";
    this.streamedTextTail = "";
    this.servingProvider = undefined;
    const botName = context.prefixStrippingName ?? context.personaUsername ?? context.tomoriState.persona_nickname;
    this.speakerGuardAllowedSourceNames = collectRenderModifierSourceNames(
      botName,
      collectPersonaNameAliases(context.tomoriState, botName),
    );
    this.speakerGuardEnabled = false;
    this.reasoningContentSpillGuard.reset();
    // Persona-label fallback closer for unclosed leaked think blocks.
    const personaNickname = context.tomoriState.persona_nickname?.trim();
    const personaSpeakerLabelRegex = personaNickname
      ? new RegExp(`(?:^|\\n)\\s*${escapeRegExp(personaNickname)}\\s*[:：]`, "i")
      : null;
    this.thinkBlockStripper.reset(personaSpeakerLabelRegex);

    // Cast config to OpenrouterStreamConfig to access provider-specific fields
    const openrouterConfig = config as OpenrouterStreamConfig;

    const messages = await this.assembleOpenrouterContext(
      context.contextItems,
      context.currentTurnModelParts,
      context.functionInteractionHistory,
      openrouterConfig.seesImages ?? true, // Default to true for backward compatibility
      context.tomoriState.persona_nickname ?? "Assistant",
      openrouterConfig.seesVideos ?? false, // Default false: videos are strictly opt-in per model
      context.messageIdMap,
    );

    // Ensure model is provided
    if (!config.model) {
      throw new Error("Model must be specified in config. Use OpenrouterProvider.getDefaultModel() if needed.");
    }

    log.info(`Generating content with model ${config.model}`);

    if (config.tools && Array.isArray(config.tools) && config.tools.length > 0) {
      log.info(`Tools:\n${JSON.stringify(config.tools, null, 2)}`);
    }

    // Log sanitized request for debugging
    this.logSanitizedRequest(messages);

    let controller: AbortController | null = null;

    try {
      const supportedParameters =
        config.model && isOpenRouterCapabilityCacheReady()
          ? (getOpenRouterSupportedParameters(config.model) ?? null)
          : null;
      const skippedUnsupportedParams: string[] = [];
      const normalizedModel = (config.model ?? "").toLowerCase();
      const omitTemperatureByModelOverride = OpenrouterStreamAdapter.TEMPERATURE_OMIT_MODELS.has(normalizedModel);
      const speakerStopPatternEnabled = context.tomoriState.config.llm_stop_speaker_pattern_enabled ?? false;
      const stopStrings = buildProviderStopStrings({
        providerName: "openrouter",
        model: config.model,
        personaName: context.tomoriState.persona_nickname,
        configuredStops: context.tomoriState.config.llm_stop_strings,
        includePersonaSpeakerStop: speakerStopPatternEnabled,
      });
      let stopParamSupported = false;

      const requestBody: Record<string, unknown> = {
        model: config.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      };
      const reasoningRequest = buildOpenRouterReasoningRequest(
        context.tomoriState.config.thinking_level,
        config.forceReason,
      );
      if (reasoningRequest.reasoning) {
        requestBody.reasoning = reasoningRequest.reasoning;
      }

      if (
        config.temperature !== undefined &&
        !omitTemperatureByModelOverride &&
        this.isOpenRouterParamSupported(supportedParameters, "temperature")
      ) {
        requestBody.temperature = config.temperature;
      } else if (config.temperature !== undefined) {
        skippedUnsupportedParams.push("temperature");
      }

      // OpenRouter follows OpenAI's snake_case for max_tokens.
      // Apply a context-window safety cap so long conversations don't crowd out
      // the output budget.
      //   rawSafeOutputBudget = floor((contextLength - estimatedInputTokens) * OPENROUTER_OUTPUT_SAFETY_FACTOR)
      // Input is estimated from message text fields (chars / 4). Inline base64
      // image payloads are intentionally excluded from this estimate.
      // To keep replies usable in tight windows, we also apply a best-effort
      // minimum output floor (OPENROUTER_MIN_OUTPUT_TOKENS) when the remaining
      // context can still fit that floor.
      // If maxOutputTokens is undefined (unknown model), we skip max_tokens entirely
      // and let OpenRouter use the model's natural limit.
      let effectiveMaxOutputTokens = config.maxOutputTokens;
      if (effectiveMaxOutputTokens !== undefined && config.model && isOpenRouterCapabilityCacheReady()) {
        const tokenLimits = getOpenRouterTokenLimits(config.model);
        if (tokenLimits && tokenLimits.contextLength > 0) {
          const outputSafetyFactorRaw = Number.parseFloat(process.env.OPENROUTER_OUTPUT_SAFETY_FACTOR || "0.9");
          const outputSafetyFactor =
            Number.isFinite(outputSafetyFactorRaw) && outputSafetyFactorRaw > 0 && outputSafetyFactorRaw < 1
              ? outputSafetyFactorRaw
              : 0.9;
          const minOutputTokensRaw = Number.parseInt(process.env.OPENROUTER_MIN_OUTPUT_TOKENS || "256", 10);
          const configuredMinOutputTokens =
            Number.isFinite(minOutputTokensRaw) && minOutputTokensRaw > 0 ? minOutputTokensRaw : 256;
          const minOutputTokensFloor = Math.min(configuredMinOutputTokens, effectiveMaxOutputTokens);
          // Rough input token estimate from textual message content
          const estimatedInputTokens = this.estimateInputTokensForSafetyCap(messages);
          const remainingContextTokens = tokenLimits.contextLength - estimatedInputTokens;
          const rawSafeOutputBudget = Math.floor(remainingContextTokens * outputSafetyFactor);
          let safeOutputBudget = Math.max(1, rawSafeOutputBudget);
          let minOutputFloorApplied = false;

          if (safeOutputBudget < minOutputTokensFloor && remainingContextTokens >= minOutputTokensFloor) {
            safeOutputBudget = minOutputTokensFloor;
            minOutputFloorApplied = true;
          }

          if (safeOutputBudget < effectiveMaxOutputTokens) {
            log.warn(
              `Context-window safety cap applied for ${config.model}: ` +
                `maxOutputTokens ${effectiveMaxOutputTokens} → ${safeOutputBudget} ` +
                `(contextLength=${tokenLimits.contextLength}, estimatedInput≈${estimatedInputTokens}, remaining=${remainingContextTokens}, rawBudget=${rawSafeOutputBudget}, safetyFactor=${outputSafetyFactor}, minFloor=${minOutputTokensFloor}, minFloorApplied=${minOutputFloorApplied})`,
            );
            effectiveMaxOutputTokens = safeOutputBudget;
          } else if (minOutputFloorApplied) {
            log.info(
              `Context-window minimum output floor preserved for ${config.model}: ` +
                `maxOutputTokens remains ${effectiveMaxOutputTokens} ` +
                `(contextLength=${tokenLimits.contextLength}, estimatedInput≈${estimatedInputTokens}, remaining=${remainingContextTokens}, rawBudget=${rawSafeOutputBudget}, safetyFactor=${outputSafetyFactor}, minFloor=${minOutputTokensFloor})`,
            );
          }
        }
      }
      if (effectiveMaxOutputTokens !== undefined) {
        if (this.isOpenRouterParamSupported(supportedParameters, "max_tokens", ["max_completion_tokens"])) {
          requestBody.max_tokens = effectiveMaxOutputTokens;
        } else {
          skippedUnsupportedParams.push("max_tokens");
        }
      }

      // Only include tools if defined and has items.
      // Keep the request payload aligned with the effective capability decision:
      // some OpenRouter model entries are missing `tools` in supported_parameters
      // even though the capability cache treats them as tool-capable.
      if (config.tools && config.tools.length > 0) {
        const capabilityAllowsTools =
          config.model !== "other-model" ? (getOpenRouterCapabilities(config.model)?.hasTools ?? false) : false;
        if (this.isOpenRouterParamSupported(supportedParameters, "tools") || capabilityAllowsTools) {
          requestBody.tools = config.tools;
          const providerRouting = buildOpenrouterProviderRouting({ hasTools: true });
          if (providerRouting) {
            requestBody.provider = providerRouting;
          }
        } else {
          skippedUnsupportedParams.push("tools");
        }
      }

      if (openrouterConfig.topP !== undefined) {
        if (this.isOpenRouterParamSupported(supportedParameters, "top_p")) {
          requestBody.top_p = openrouterConfig.topP;
        } else {
          skippedUnsupportedParams.push("top_p");
        }
      }
      if (openrouterConfig.topK !== undefined) {
        if (this.isOpenRouterParamSupported(supportedParameters, "top_k")) {
          requestBody.top_k = openrouterConfig.topK;
        } else {
          skippedUnsupportedParams.push("top_k");
        }
      }
      if (openrouterConfig.frequencyPenalty !== undefined) {
        if (this.isOpenRouterParamSupported(supportedParameters, "frequency_penalty")) {
          requestBody.frequency_penalty = openrouterConfig.frequencyPenalty;
        } else {
          skippedUnsupportedParams.push("frequency_penalty");
        }
      }
      if (openrouterConfig.presencePenalty !== undefined) {
        if (this.isOpenRouterParamSupported(supportedParameters, "presence_penalty")) {
          requestBody.presence_penalty = openrouterConfig.presencePenalty;
        } else {
          skippedUnsupportedParams.push("presence_penalty");
        }
      }
      if (openrouterConfig.repetitionPenalty !== undefined) {
        if (this.isOpenRouterParamSupported(supportedParameters, "repetition_penalty")) {
          requestBody.repetition_penalty = openrouterConfig.repetitionPenalty;
        } else {
          skippedUnsupportedParams.push("repetition_penalty");
        }
      }
      if (openrouterConfig.minP !== undefined) {
        if (this.isOpenRouterParamSupported(supportedParameters, "min_p")) {
          requestBody.min_p = openrouterConfig.minP;
        } else {
          skippedUnsupportedParams.push("min_p");
        }
      }
      if (openrouterConfig.logitBias !== undefined) {
        if (this.isOpenRouterParamSupported(supportedParameters, "logit_bias")) {
          requestBody.logit_bias = openrouterConfig.logitBias;
        } else {
          skippedUnsupportedParams.push("logit_bias");
        }
      }

      if (stopStrings) {
        stopParamSupported = this.isOpenRouterParamSupported(supportedParameters, "stop");
        if (stopParamSupported) {
          requestBody.stop = stopStrings;
        } else {
          skippedUnsupportedParams.push("stop");
        }
      }

      this.speakerGuardEnabled = speakerStopPatternEnabled;
      if (this.speakerGuardEnabled) {
        log.info("OpenRouter: Speaker-boundary fallback guard enabled");
      }

      if (supportedParameters && skippedUnsupportedParams.length > 0) {
        log.info(`OpenRouter: Skipping unsupported params for ${config.model}: ${skippedUnsupportedParams.join(", ")}`);
      }
      if (omitTemperatureByModelOverride) {
        log.info(`OpenRouter: Temperature omitted due to model override for ${config.model}`);
      }

      const effectiveTemperatureLabel = "temperature" in requestBody ? String(config.temperature) : "omitted";

      log.info(
        `Sampling params - temp: ${effectiveTemperatureLabel}, top_p: ${openrouterConfig.topP ?? "default"}, top_k: ${openrouterConfig.topK ?? "default"}, freq_penalty: ${openrouterConfig.frequencyPenalty ?? "default"}, pres_penalty: ${openrouterConfig.presencePenalty ?? "default"}, rep_penalty: ${openrouterConfig.repetitionPenalty ?? "default"}, min_p: ${openrouterConfig.minP ?? "default"}, logit_bias: ${Object.keys(openrouterConfig.logitBias ?? {}).length}`,
      );

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...buildOpenRouterAttributionHeaders(),
      };

      if (config.apiKey && config.apiKey.trim() !== "") {
        headers.Authorization = `Bearer ${config.apiKey}`;
      }

      const inactivityTimeoutMs = config.inactivityTimeoutMs ?? 120000;
      const mandatoryKeys = new Set(["model", "messages", "stream"]);
      const attempts = buildDegradationAttempts(requestBody, {
        mandatoryKeys,
        stripImages: (attemptMessages) =>
          Array.isArray(attemptMessages)
            ? this.stripImagesFromMessages(attemptMessages as Array<Record<string, unknown>>)
            : attemptMessages,
      });
      const probeCandidates = attempts
        .filter((attempt) => attempt.label.startsWith("probe_drop_"))
        .map((attempt) => attempt.label.replace("probe_drop_", ""));
      if (probeCandidates.length > 0) {
        log.info(`OpenRouter probe candidates (${config.model}): ${probeCandidates.join(", ")}`);
      }

      const attemptedSerializedBodies = new Set<string>();
      let targetedAttemptCount = 0;
      const queueTargetedAttempt = (
        currentIndex: number,
        currentBody: Record<string, unknown>,
        errorMessage: string,
      ): boolean => {
        if (targetedAttemptCount >= MAX_TARGETED_DEGRADATION_ATTEMPTS) {
          return false;
        }

        const rejectedParams = extractRejectedParams(errorMessage, currentBody);
        if (rejectedParams.length === 0) return false;

        const targetedAttempt = buildTargetedAttempt(currentBody, rejectedParams);
        const serialized = JSON.stringify(targetedAttempt.body);
        if (attemptedSerializedBodies.has(serialized)) return false;

        const duplicateIndex = attempts.findIndex(
          (queuedAttempt, index) => index > currentIndex && JSON.stringify(queuedAttempt.body) === serialized,
        );
        if (duplicateIndex !== -1) {
          attempts.splice(duplicateIndex, 1);
        }
        attempts.splice(currentIndex + 1, 0, targetedAttempt);
        targetedAttemptCount += 1;
        return true;
      };
      // A multimodal rejection means every payload still carrying image blocks
      // fails identically (e.g. the router landed on a text-only backend), so
      // jump straight to the image-strip attempt instead of walking the
      // sampler-probe rungs first.
      let imageStripAttemptQueued = false;
      const queueImageStripAttempt = (
        currentIndex: number,
        currentBody: Record<string, unknown>,
        errorMessage: string,
      ): boolean => {
        if (imageStripAttemptQueued || !isMultimodalRejectionError(errorMessage)) {
          return false;
        }

        const imageStripAttempt = buildImageStripAttempt(currentBody);
        if (!imageStripAttempt) return false;

        const serialized = JSON.stringify(imageStripAttempt.body);
        if (attemptedSerializedBodies.has(serialized)) return false;

        const duplicateIndex = attempts.findIndex(
          (queuedAttempt, index) => index > currentIndex && JSON.stringify(queuedAttempt.body) === serialized,
        );
        if (duplicateIndex !== -1) {
          attempts.splice(duplicateIndex, 1);
        }
        attempts.splice(currentIndex + 1, 0, imageStripAttempt);
        imageStripAttemptQueued = true;
        return true;
      };

      let completedAttempt = false;
      attemptLoop: for (let i = 0; i < attempts.length; i++) {
        const attempt = attempts[i];
        const isRetry = i > 0;
        attemptedSerializedBodies.add(JSON.stringify(attempt.body));

        if (isRetry) {
          log.warn(`OpenRouter request retry with degraded payload: ${attempt.label} (${config.model})`);
        }

        controller = new AbortController();
        const currentController = controller;
        const externalAbortListener = () => currentController.abort();
        if (context.abortSignal?.aborted) {
          currentController.abort();
        } else {
          context.abortSignal?.addEventListener("abort", externalAbortListener, { once: true });
        }

        const requestInit: RequestInit & { verbose?: boolean } = {
          method: "POST",
          headers,
          body: JSON.stringify(attempt.body),
          signal: currentController.signal,
        };

        if (OPENROUTER_VERBOSE_FETCH) {
          requestInit.verbose = true;
        }

        try {
          const response = await fetch("https://openrouter.ai/api/v1/chat/completions", requestInit);

          if (!response.ok) {
            const errorText = await response.text();
            const parsedError = this.parseHttpErrorFromResponse(
              response.status,
              response.statusText,
              errorText,
              attempt.body,
              config.model,
              attempt.label,
            );

            // A message that names a droppable request param is sufficient evidence on
            // its own, so retry even when the generic status/wording classifier misses.
            const queuedTargeted = queueTargetedAttempt(i, attempt.body, parsedError.errorMessage);
            const queuedImageStrip = queueImageStripAttempt(i, attempt.body, parsedError.errorMessage);
            const degradationKind = classifyDegradableError({
              statusCode: parsedError.statusCode,
              message: parsedError.errorMessage,
              degradeOn502: true,
            });
            if ((degradationKind || queuedTargeted || queuedImageStrip) && i < attempts.length - 1) {
              log.warn(
                `OpenRouter returned ${describeDegradationTrigger(degradationKind, queuedImageStrip)} on attempt '${attempt.label}', trying fallback payload`,
                { model: config.model, errorMessage: parsedError.errorMessage },
              );
              continue;
            }

            throw parsedError.error;
          }

          if (!response.body) {
            throw new Error("Response body is null");
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let lastMeaningfulAt = Date.now();
          let committedToAttempt = false;
          let recoveryLogged = false;
          // True once the body no longer needs cancelling: either the stream ended on its own,
          // or a retry path already cancelled it.
          let readerSettled = false;

          const logRecovery = () => {
            if (!isRetry || recoveryLogged) return;
            recoveryLogged = true;
            log.warn(`OpenRouter request recovered after retry: ${attempt.label} (${config.model})`);
            if (attempt.label.startsWith("probe_drop_") || attempt.label.startsWith("targeted_drop_")) {
              const droppedParams = attempt.label.replace(/^(?:probe|targeted)_drop_/, "");
              log.warn(
                `OpenRouter probe indicates likely incompatible parameter for ${config.model}: ${droppedParams}`,
              );
            }
          };

          const readWithTimeout = async () => {
            let timeoutId: NodeJS.Timeout | null = null;
            const timeoutPromise = new Promise<never>((_, reject) => {
              timeoutId = setTimeout(() => {
                reject(new Error("OpenRouter stream timed out while waiting for data"));
              }, inactivityTimeoutMs);
            });

            try {
              return await Promise.race([reader.read(), timeoutPromise]);
            } finally {
              if (timeoutId) clearTimeout(timeoutId);
            }
          };

          try {
            while (true) {
              const readResult = (await readWithTimeout()) as {
                done: boolean;
                value?: Uint8Array;
              };

              if (readResult.done) {
                readerSettled = true;
                break;
              }
              if (!readResult.value) continue;

              buffer += decoder.decode(readResult.value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                const trimmedLine = line.trim();
                if (!trimmedLine || trimmedLine.startsWith(":") || !trimmedLine.startsWith("data:")) continue;

                const data = trimmedLine.slice(5).trim();
                if (!data) continue;
                if (data === "[DONE]") {
                  log.info("OpenrouterStreamAdapter: Stream completed [DONE]");
                  continue;
                }

                let parsed: unknown;
                try {
                  parsed = JSON.parse(data);
                } catch (parseError) {
                  log.warn(`OpenrouterStreamAdapter: Failed to parse SSE data: ${data}`, {
                    error: parseError instanceof Error ? parseError.message : String(parseError),
                  });
                  continue;
                }

                const normalizedChunk = this.normalizeOpenrouterChunk(parsed);
                if (!normalizedChunk) continue;

                const midStreamError = this.getMidStreamError(normalizedChunk);
                if (midStreamError && !committedToAttempt) {
                  // Same rule as the fetch path: a message naming droppable params
                  // justifies a retry even without a generic classifier match.
                  const queuedTargeted = queueTargetedAttempt(i, attempt.body, midStreamError.message);
                  const queuedImageStrip = queueImageStripAttempt(i, attempt.body, midStreamError.message);
                  const degradationKind = classifyDegradableError({ ...midStreamError, degradeOn502: true });
                  if ((degradationKind || queuedTargeted || queuedImageStrip) && i < attempts.length - 1) {
                    log.warn(
                      `OpenRouter received ${describeDegradationTrigger(degradationKind, queuedImageStrip)} before stream commitment on attempt '${attempt.label}', trying fallback payload`,
                      { model: config.model, errorMessage: midStreamError.message },
                    );
                    // Cancelled before aborting so the teardown is graceful rather than a
                    // rejected read, which is why this path cancels here instead of leaving it
                    // to the `finally` below.
                    const cancelPromise = reader.cancel().catch(() => undefined);
                    readerSettled = true;
                    currentController.abort();
                    await cancelPromise;
                    this.resetPerAttemptState(personaSpeakerLabelRegex);
                    continue attemptLoop;
                  }
                }

                const chunksToEmit = this.splitChunkWithTextAndToolSignals(normalizedChunk);
                for (const chunkToEmit of chunksToEmit) {
                  const strippedChunk = this.stripThinkBlocksFromChunkContent(chunkToEmit);
                  const spillGuardedChunk = this.applyReasoningContentSpillGuard(strippedChunk);
                  const deduplicatedChunk = this.deduplicateChunkTextAgainstRecentStream(spillGuardedChunk);
                  const guardResult = this.applySpeakerBoundaryFallbackGuard(deduplicatedChunk);
                  const commitsStream = this.isMeaningfulCommitmentChunk(guardResult.chunk);
                  if (commitsStream && !committedToAttempt) {
                    committedToAttempt = true;
                    logRecovery();
                  }

                  if (this.shouldFlushSpeakerGuardTailBeforeNonTextChunk(guardResult.chunk)) {
                    yield {
                      data: {
                        choices: [{ index: 0, delta: { content: this.speakerGuardPendingTail } }],
                      } satisfies OpenrouterStreamChunk,
                      provider: "openrouter",
                      metadata: { timestamp: Date.now(), model: config.model },
                    };
                    this.speakerGuardPendingTail = "";
                  }

                  const hasMeaningfulData = Boolean(
                    guardResult.chunk.error ||
                      guardResult.chunk.usage ||
                      (guardResult.chunk.choices && guardResult.chunk.choices.length > 0),
                  );
                  if (!hasMeaningfulData) {
                    if (guardResult.stopTriggered) {
                      log.warn(
                        `OpenRouter speaker guard: generation stopped at detected speaker label "${guardResult.matchedSpeaker ?? "unknown"}"`,
                      );
                      return;
                    }
                    continue;
                  }

                  lastMeaningfulAt = Date.now();
                  yield {
                    data: guardResult.chunk,
                    provider: "openrouter",
                    metadata: { timestamp: Date.now(), model: config.model },
                  };

                  if (guardResult.stopTriggered) {
                    log.warn(
                      `OpenRouter speaker guard: generation stopped at detected speaker label "${guardResult.matchedSpeaker ?? "unknown"}"`,
                    );
                    return;
                  }
                }
              }

              if (Date.now() - lastMeaningfulAt > inactivityTimeoutMs) {
                currentController.abort();
                throw new Error("OpenRouter stream timed out due to inactivity");
              }
            }
          } finally {
            // Every exit other than a completed stream (retry, early return, inactivity
            // timeout, or a consumer abandoning this generator) leaves the response body open,
            // holding its buffers and connection until it is cancelled explicitly.
            if (!readerSettled) {
              await reader.cancel().catch(() => undefined);
            }
          }

          logRecovery();
          completedAttempt = true;
          break;
        } finally {
          context.abortSignal?.removeEventListener("abort", externalAbortListener);
        }
      }

      if (!completedAttempt) {
        throw new Error("OpenRouter request failed before completing a response stream");
      }

      const flushedSpillChunk = this.flushReasoningContentSpillGuardToChunk();
      if (flushedSpillChunk) {
        yield {
          data: flushedSpillChunk,
          provider: "openrouter",
          metadata: {
            timestamp: Date.now(),
            model: config.model,
          },
        };
      }

      const flushedThinkChunk = this.flushThinkStripperToChunk();
      if (flushedThinkChunk) {
        yield {
          data: flushedThinkChunk,
          provider: "openrouter",
          metadata: {
            timestamp: Date.now(),
            model: config.model,
          },
        };
      }

      if (this.speakerGuardEnabled && this.speakerGuardPendingTail.length > 0) {
        yield {
          data: {
            choices: [
              {
                index: 0,
                delta: {
                  content: this.speakerGuardPendingTail,
                },
              },
            ],
          } satisfies OpenrouterStreamChunk,
          provider: "openrouter",
          metadata: {
            timestamp: Date.now(),
            model: config.model,
          },
        };
        this.speakerGuardPendingTail = "";
      }
    } catch (error) {
      if (controller) {
        controller.abort();
      }
      const flushedSpillChunk = this.flushReasoningContentSpillGuardToChunk();
      if (flushedSpillChunk) {
        yield {
          data: flushedSpillChunk,
          provider: "openrouter",
          metadata: {
            timestamp: Date.now(),
            model: config.model,
          },
        };
      }
      if (this.speakerGuardEnabled && this.speakerGuardPendingTail.length > 0) {
        yield {
          data: {
            choices: [
              {
                index: 0,
                delta: {
                  content: this.speakerGuardPendingTail,
                },
              },
            ],
          } satisfies OpenrouterStreamChunk,
          provider: "openrouter",
          metadata: {
            timestamp: Date.now(),
            model: config.model,
          },
        };
        this.speakerGuardPendingTail = "";
      }
      const flushedThinkChunk = this.flushThinkStripperToChunk();
      if (flushedThinkChunk) {
        yield {
          data: flushedThinkChunk,
          provider: "openrouter",
          metadata: {
            timestamp: Date.now(),
            model: config.model,
          },
        };
      }
      yield this.createProviderErrorChunk(error, context);
    }
  }

  /**
   * Strip `<think>...</think>` blocks that leak into `delta.content` (some OpenRouter
   * backends emit reasoning here instead of `delta.reasoning`). Captured thought text
   * is appended to the chunk's `delta.reasoning` so `processChunk` surfaces it as a
   * ThoughtLogEntry rather than visible prose.
   *
   * Includes the same two safeguards as the OpenAI-compatible adapter:
   *   - Stray `</think>` with no opener routes preceding text to thoughts (not content).
   *   - Persona speaker label (e.g. "Nerine:") at a line boundary acts as an implicit
   *      `</think>` when the model fails to close cleanly.
   */
  private stripThinkBlocksFromChunkContent(chunk: OpenrouterStreamChunk): OpenrouterStreamChunk {
    const firstChoice = chunk.choices?.[0];
    const content = firstChoice?.delta?.content;
    if (!firstChoice?.delta || typeof content !== "string" || content.length === 0) {
      return chunk;
    }

    const stripped = this.thinkBlockStripper.strip(content);
    if (!stripped.changed) {
      return chunk;
    }

    const existingReasoning = typeof firstChoice.delta.reasoning === "string" ? firstChoice.delta.reasoning : "";
    const mergedReasoning =
      stripped.thoughtText.length > 0
        ? existingReasoning.length > 0
          ? `${existingReasoning}${stripped.thoughtText}`
          : stripped.thoughtText
        : (firstChoice.delta.reasoning ?? undefined);

    return {
      ...chunk,
      choices: [
        {
          ...firstChoice,
          delta: {
            ...firstChoice.delta,
            content: stripped.visibleText,
            reasoning: mergedReasoning,
          },
        },
        ...(chunk.choices?.slice(1) ?? []),
      ],
    };
  }

  private applyReasoningContentSpillGuard(chunk: OpenrouterStreamChunk): OpenrouterStreamChunk {
    const firstChoice = chunk.choices?.[0];
    if (!firstChoice?.delta) {
      return chunk;
    }

    this.reasoningContentSpillGuard.observeReasoning(firstChoice.delta.reasoning);

    const content = firstChoice.delta.content;
    if (typeof content !== "string" || content.length === 0) {
      return chunk;
    }

    const guardResult = this.reasoningContentSpillGuard.filterContent(content);
    if (!guardResult.changed) {
      return chunk;
    }

    const existingReasoning = typeof firstChoice.delta.reasoning === "string" ? firstChoice.delta.reasoning : "";
    const mergedReasoning = guardResult.spilledThought
      ? existingReasoning
        ? `${existingReasoning}${guardResult.spilledThought}`
        : guardResult.spilledThought
      : (firstChoice.delta.reasoning ?? undefined);

    return {
      ...chunk,
      choices: [
        {
          ...firstChoice,
          delta: {
            ...firstChoice.delta,
            content: guardResult.content,
            reasoning: mergedReasoning,
          },
        },
        ...(chunk.choices?.slice(1) ?? []),
      ],
    };
  }

  private flushReasoningContentSpillGuardToChunk(): OpenrouterStreamChunk | null {
    const guardResult = this.reasoningContentSpillGuard.flush();
    if (!guardResult.changed || !guardResult.content) {
      return null;
    }

    return {
      choices: [
        {
          index: 0,
          delta: {
            content: guardResult.content,
          },
        },
      ],
    };
  }

  private flushThinkStripperToChunk(): OpenrouterStreamChunk | null {
    const stripped = this.thinkBlockStripper.flush();
    if (!stripped.changed || (!stripped.visibleText && !stripped.thoughtText)) {
      return null;
    }

    return {
      choices: [
        {
          index: 0,
          delta: {
            content: stripped.visibleText,
            reasoning: stripped.thoughtText || undefined,
          },
        },
      ],
    };
  }

  private deduplicateChunkTextAgainstRecentStream(chunk: OpenrouterStreamChunk): OpenrouterStreamChunk {
    const firstChoice = chunk.choices?.[0];
    const content = firstChoice?.delta?.content;
    if (!firstChoice?.delta || typeof content !== "string" || content.length === 0) {
      return chunk;
    }

    const deduplicatedText = this.getTextDelta(content);
    if (deduplicatedText !== content) {
      log.info(`OpenRouter: Trimmed overlapping streamed text (${content.length} -> ${deduplicatedText.length})`);
    }

    if (deduplicatedText.length > 0) {
      this.appendToStreamedTextTail(deduplicatedText);
    }

    if (deduplicatedText === content) {
      return chunk;
    }

    const remainingChoices = chunk.choices?.slice(1) ?? [];
    return {
      ...chunk,
      choices: [
        {
          ...firstChoice,
          delta: {
            ...firstChoice.delta,
            content: deduplicatedText,
          },
        },
        ...remainingChoices,
      ],
    };
  }

  private getTextDelta(chunkText: string): string {
    if (
      !chunkText ||
      chunkText.length < OpenrouterStreamAdapter.STREAM_TEXT_MIN_DEDUP_CHARS ||
      !this.streamedTextTail
    ) {
      return chunkText;
    }

    const seenTail = this.streamedTextTail;
    if (seenTail.endsWith(chunkText)) {
      return "";
    }

    const maxOverlap = Math.min(seenTail.length, chunkText.length);
    for (let overlap = maxOverlap; overlap >= OpenrouterStreamAdapter.STREAM_TEXT_MIN_DEDUP_CHARS; overlap--) {
      if (seenTail.slice(seenTail.length - overlap) === chunkText.slice(0, overlap)) {
        return chunkText.slice(overlap);
      }
    }

    return chunkText;
  }

  private appendToStreamedTextTail(text: string): void {
    if (!text) {
      return;
    }

    this.streamedTextTail += text;
    if (this.streamedTextTail.length > OpenrouterStreamAdapter.STREAM_TEXT_TAIL_CHARS) {
      this.streamedTextTail = this.streamedTextTail.slice(-OpenrouterStreamAdapter.STREAM_TEXT_TAIL_CHARS);
    }
  }

  private applySpeakerBoundaryFallbackGuard(chunk: OpenrouterStreamChunk): {
    chunk: OpenrouterStreamChunk;
    stopTriggered: boolean;
    matchedSpeaker?: string;
  } {
    if (!this.speakerGuardEnabled) {
      return { chunk, stopTriggered: false };
    }

    const firstChoice = chunk.choices?.[0];
    const content = firstChoice?.delta?.content;
    if (!firstChoice?.delta || !content) {
      return { chunk, stopTriggered: false };
    }

    const chunkText = String(content);
    const combined = `${this.speakerGuardPendingTail}${chunkText}`;
    const speakerGuardResult = truncateBeforeGenericSpeakerLine(combined, {
      isAllowedSpeakerLabel: (label) => isAllowedRenderModifierSpeakerLabel(label, this.speakerGuardAllowedSourceNames),
    });
    const transitionIndex = speakerGuardResult.stopTriggered ? speakerGuardResult.text.length : -1;

    if (transitionIndex === -1) {
      const holdback = OpenrouterStreamAdapter.SPEAKER_GUARD_HOLDBACK_CHARS;
      if (combined.length <= holdback) {
        this.speakerGuardPendingTail = combined;
        firstChoice.delta.content = "";
        return { chunk, stopTriggered: false };
      }

      const emitEnd = combined.length - holdback;
      firstChoice.delta.content = combined.slice(0, emitEnd);
      this.speakerGuardPendingTail = combined.slice(emitEnd);
      return { chunk, stopTriggered: false };
    }

    const safeText = combined.slice(0, transitionIndex);
    firstChoice.delta.content = safeText;
    this.speakerGuardPendingTail = "";
    return {
      chunk,
      stopTriggered: true,
      matchedSpeaker: speakerGuardResult.matchedSpeaker,
    };
  }

  private splitChunkWithTextAndToolSignals(chunk: OpenrouterStreamChunk): OpenrouterStreamChunk[] {
    const firstChoice = chunk.choices?.[0];
    if (!firstChoice?.delta) {
      return [chunk];
    }

    const content = firstChoice.delta.content;
    const hasTextContent = typeof content === "string" && content.length > 0;
    if (!hasTextContent) {
      return [chunk];
    }

    const toolCalls = firstChoice.delta.toolCalls ?? firstChoice.delta.tool_calls;
    const finishReason = firstChoice.finishReason ?? firstChoice.finish_reason;
    const hasToolSignal = Boolean(toolCalls && toolCalls.length > 0) || finishReason === "tool_calls";

    if (!hasToolSignal) {
      return [chunk];
    }

    const textOnlyChunk: OpenrouterStreamChunk = {
      ...chunk,
      usage: undefined,
      choices: [
        {
          ...firstChoice,
          delta: {
            role: firstChoice.delta.role,
            content,
            reasoning: firstChoice.delta.reasoning,
          },
          finishReason: null,
          finish_reason: null,
        },
      ],
    };

    const toolSignalChunk: OpenrouterStreamChunk = {
      ...chunk,
      choices: [
        {
          ...firstChoice,
          delta: {
            ...firstChoice.delta,
            content: undefined,
          },
        },
      ],
    };

    return [textOnlyChunk, toolSignalChunk];
  }

  private shouldFlushSpeakerGuardTailBeforeNonTextChunk(chunk: OpenrouterStreamChunk): boolean {
    if (!this.speakerGuardEnabled || this.speakerGuardPendingTail.length === 0) {
      return false;
    }

    const firstChoice = chunk.choices?.[0];
    const content = firstChoice?.delta?.content;
    if (typeof content === "string" && content.length > 0) {
      return false;
    }

    if (chunk.error || chunk.usage) {
      return true;
    }

    const toolCalls = firstChoice?.delta?.toolCalls ?? firstChoice?.delta?.tool_calls;
    if (toolCalls && toolCalls.length > 0) {
      return true;
    }

    const finishReason = firstChoice?.finishReason ?? firstChoice?.finish_reason;
    return Boolean(finishReason);
  }

  /**
   * Normalize raw OpenRouter streaming data into the expected chunk format
   * Handles both SDK-style camelCase and raw OpenAI-style snake_case fields.
   */
  private normalizeOpenrouterChunk(raw: unknown): OpenrouterStreamChunk | null {
    if (!raw || typeof raw !== "object") return null;

    const rawObj = raw as Record<string, unknown>;

    if ("data" in rawObj) {
      const dataValue = rawObj.data;
      if (typeof dataValue === "string") {
        try {
          return this.normalizeOpenrouterChunk(JSON.parse(dataValue));
        } catch {
          return null;
        }
      }
      if (typeof dataValue === "object" && dataValue !== null) {
        return this.normalizeOpenrouterChunk(dataValue);
      }
    }

    if (rawObj.error && typeof rawObj.error === "object") {
      const errorObj = rawObj.error as Record<string, unknown>;

      // If it's already a ProviderError, pass through
      if (this.isProviderError(rawObj.error)) {
        return { error: rawObj.error };
      }

      const metadata =
        errorObj.metadata && typeof errorObj.metadata === "object"
          ? (errorObj.metadata as Record<string, unknown>)
          : null;
      const message =
        (typeof metadata?.raw === "string" && metadata.raw) ||
        (typeof errorObj.message === "string" && errorObj.message) ||
        "OpenRouter API error";
      const codeValue = errorObj.code;
      return {
        error: {
          code: typeof codeValue === "string" || typeof codeValue === "number" ? codeValue : "unknown",
          message,
        },
      };
    }

    if (typeof rawObj.message === "string" && ("code" in rawObj || "type" in rawObj)) {
      const codeValue = rawObj.code as string | number | undefined;
      return {
        error: {
          code: typeof codeValue === "string" || typeof codeValue === "number" ? codeValue : "unknown",
          message: rawObj.message,
        },
      };
    }

    const rawChoices = Array.isArray(rawObj.choices) ? rawObj.choices : undefined;
    const normalizedChoices = rawChoices?.map((choice, index) => {
      const choiceObj = choice as Record<string, unknown>;
      const deltaObj =
        choiceObj.delta && typeof choiceObj.delta === "object"
          ? (choiceObj.delta as Record<string, unknown>)
          : undefined;

      const rawToolCalls = deltaObj?.toolCalls ?? (deltaObj?.tool_calls as unknown);

      const normalizedToolCalls = Array.isArray(rawToolCalls)
        ? rawToolCalls.map((toolCall) => {
            const toolObj = toolCall as Record<string, unknown>;
            const functionObj =
              toolObj.function && typeof toolObj.function === "object"
                ? (toolObj.function as Record<string, unknown>)
                : undefined;

            return {
              index: typeof toolObj.index === "number" ? toolObj.index : undefined,
              id: typeof toolObj.id === "string" ? toolObj.id : undefined,
              type: typeof toolObj.type === "string" ? toolObj.type : undefined,
              thought_signature: typeof toolObj.thought_signature === "string" ? toolObj.thought_signature : undefined,
              function: functionObj
                ? {
                    name: typeof functionObj.name === "string" ? functionObj.name : undefined,
                    arguments: typeof functionObj.arguments === "string" ? functionObj.arguments : undefined,
                  }
                : undefined,
            };
          })
        : undefined;

      const reasoningDetails = Array.isArray(deltaObj?.reasoning_details)
        ? deltaObj?.reasoning_details
        : Array.isArray(deltaObj?.reasoningDetails)
          ? deltaObj?.reasoningDetails
          : undefined;

      const finishReason =
        (typeof choiceObj.finishReason === "string" || choiceObj.finishReason === null
          ? choiceObj.finishReason
          : undefined) ??
        (typeof choiceObj.finish_reason === "string" || choiceObj.finish_reason === null
          ? choiceObj.finish_reason
          : undefined);

      return {
        index: typeof choiceObj.index === "number" ? choiceObj.index : index,
        delta: deltaObj
          ? {
              role: typeof deltaObj.role === "string" ? deltaObj.role : undefined,
              content:
                typeof deltaObj.content === "string" || deltaObj.content === null
                  ? (deltaObj.content as string | null)
                  : undefined,
              reasoning:
                typeof deltaObj.reasoning === "string" || deltaObj.reasoning === null
                  ? (deltaObj.reasoning as string | null)
                  : undefined,
              toolCalls: normalizedToolCalls,
              reasoning_details: reasoningDetails,
            }
          : undefined,
        finishReason,
        logprobs: (choiceObj.logprobs ?? null) as unknown,
      };
    });

    const rawUsage =
      rawObj.usage && typeof rawObj.usage === "object" ? (rawObj.usage as Record<string, unknown>) : undefined;

    const normalizedUsage = rawUsage
      ? {
          promptTokens:
            typeof rawUsage.promptTokens === "number"
              ? rawUsage.promptTokens
              : typeof rawUsage.prompt_tokens === "number"
                ? rawUsage.prompt_tokens
                : undefined,
          completionTokens:
            typeof rawUsage.completionTokens === "number"
              ? rawUsage.completionTokens
              : typeof rawUsage.completion_tokens === "number"
                ? rawUsage.completion_tokens
                : undefined,
          totalTokens:
            typeof rawUsage.totalTokens === "number"
              ? rawUsage.totalTokens
              : typeof rawUsage.total_tokens === "number"
                ? rawUsage.total_tokens
                : undefined,
          completionTokensDetails: rawUsage.completionTokensDetails ?? rawUsage.completion_tokens_details,
        }
      : undefined;

    const hasUsage = normalizedUsage && Object.values(normalizedUsage).some((value) => value !== undefined);

    if (!normalizedChoices && !hasUsage) return null;

    const normalizedChunk: OpenrouterStreamChunk = {};

    if (typeof rawObj.id === "string") normalizedChunk.id = rawObj.id;
    if (typeof rawObj.object === "string") normalizedChunk.object = rawObj.object;
    if (typeof rawObj.created === "number") normalizedChunk.created = rawObj.created;
    if (typeof rawObj.model === "string") normalizedChunk.model = rawObj.model;
    if (typeof rawObj.provider === "string") normalizedChunk.provider = rawObj.provider;
    if (normalizedChoices) normalizedChunk.choices = normalizedChoices;
    if (hasUsage && normalizedUsage) normalizedChunk.usage = normalizedUsage;

    return normalizedChunk;
  }

  /**
   * Process a raw OpenRouter chunk into normalized format
   */
  processChunk(chunk: RawStreamChunk): ProcessedChunk {
    const openrouterChunk = chunk.data as OpenrouterStreamChunk;

    // Capture the upstream serving backend (OpenRouter routes the request to an endpoint
    // such as "minimax-cn" / "DeepInfra"). It rides on the top-level `provider` field and
    // can appear on any chunk; persist the first non-empty value so the thought log can
    // attribute reasoning leaks to the specific backend that produced them.
    if (typeof openrouterChunk.provider === "string" && openrouterChunk.provider.trim().length > 0) {
      this.servingProvider ??= openrouterChunk.provider.trim();
    }

    if ("error" in openrouterChunk && openrouterChunk.error) {
      const providerErrorCandidate = openrouterChunk.error as ProviderError;
      if (typeof providerErrorCandidate.type === "string" && typeof providerErrorCandidate.retryable === "boolean") {
        return {
          type: "error",
          error: providerErrorCandidate,
        };
      }

      const errorCode = (openrouterChunk.error as { code?: string | number }).code;
      const errorMessage = (openrouterChunk.error as { message?: string }).message || "OpenRouter API error";
      const normalizedCode =
        typeof errorCode === "string" || typeof errorCode === "number" ? String(errorCode) : "unknown";

      // Check for malformed tool call errors (model produced invalid tool call structure)
      // These occur when the model generates null/invalid values where strings are expected
      // Common with some models (e.g., GLM 4.7) that don't format tool calls correctly
      const isMalformedToolCallError =
        errorCode === "invalid_type" &&
        (errorMessage.includes("expected string, received null") ||
          errorMessage.includes("expected string") ||
          errorMessage.includes("invalid_type"));

      const hasPartialToolCall = this.toolCallAccumulator.size > 0;

      if (isMalformedToolCallError && hasPartialToolCall) {
        // Log the malformed tool call for debugging
        const accumulatedData = this.toolCallAccumulator.get(0);
        log.warn(
          `OpenRouter: Malformed tool call detected from model. ` +
            `Accumulated name: "${accumulatedData?.functionName || "none"}", ` +
            `args: "${accumulatedData?.functionArguments?.substring(0, 100) || "none"}". ` +
            `Error: ${errorMessage}`,
        );

        this.toolCallAccumulator.clear();
        this.reasoningDetailsAccumulator = [];

        // This preserves any text the model generated before the malformed tool call
        // and avoids showing a scary error message to the user
        return {
          type: "done",
          metadata: {
            malformedToolCall: true,
            originalError: errorMessage,
          },
        };
      }

      // Use the shared code→type mapper so SSE-injected errors get the same
      // type/retryable treatment as HTTP-level errors (e.g. 503 → provider_overloaded).
      const { type: errorType, retryable } = this.mapErrorCodeToType(normalizedCode, errorMessage);

      return {
        type: "error",
        error: {
          type: errorType,
          message: errorMessage,
          code: normalizedCode,
          retryable,
          originalError: openrouterChunk.error,
        } as ProviderError,
      };
    }

    const choice = openrouterChunk.choices?.[0];
    if (!choice) {
      return {
        type: "text",
        content: "",
      };
    }

    const finishReason = choice.finishReason ?? choice.finish_reason ?? null;
    const deltaToolCalls = choice.delta?.toolCalls ?? choice.delta?.tool_calls;
    const thoughts: ThoughtLogEntry[] = [];

    if (typeof choice.delta?.reasoning === "string" && choice.delta.reasoning.length > 0) {
      thoughts.push({
        kind: "raw",
        content: choice.delta.reasoning,
      });
    }

    // Log full chunk when we have tool calls to debug thought_signature location
    if (deltaToolCalls || finishReason === "tool_calls") {
      log.info(`OpenRouter: FULL CHUNK with tool calls: ${JSON.stringify(openrouterChunk, null, 2)}`);
    }

    if (finishReason !== null && finishReason !== undefined)
      log.info(
        `Choice - finishReason: ${finishReason}, has delta: ${!!choice.delta}, delta.content: ${!!choice.delta?.content}, delta.toolCalls: ${!!deltaToolCalls}`,
      );

    if (finishReason === "error") {
      return {
        type: "error",
        error: {
          type: "api_error",
          message: "Stream terminated due to error",
          retryable: false,
          originalError: openrouterChunk,
        } as ProviderError,
      };
    }

    const metadata: Record<string, unknown> = {};
    if (openrouterChunk.usage) {
      const usage = openrouterChunk.usage;
      const normalizedUsage = {
        promptTokens: usage.promptTokens ?? usage.prompt_tokens,
        completionTokens: usage.completionTokens ?? usage.completion_tokens,
        totalTokens: usage.totalTokens ?? usage.total_tokens,
        completionTokensDetails: usage.completionTokensDetails ?? usage.completion_tokens_details,
      };

      metadata.usage = normalizedUsage;
      log.info(`OpenRouter usage: ${normalizedUsage.totalTokens ?? "unknown"} total tokens`);
    }

    // Handle finish reasons FIRST (before delta processing)
    // This ensures that when a chunk has BOTH finishReason and delta (common in OpenRouter),
    // we prioritize the finishReason to return the correct chunk type
    // OpenRouter normalizes finishReason to: tool_calls, stop, length, content_filter, error
    if (finishReason === "tool_calls") {
      // Handle finishReason "tool_calls" (model wants to use a tool)
      // This signals the end of tool call streaming - parse accumulated data
      // BUT FIRST, if this chunk also has delta.toolCalls, accumulate it before parsing
      if (deltaToolCalls && deltaToolCalls.length > 0) {
        for (const deltaToolCall of deltaToolCalls) {
          const index = deltaToolCall.index ?? 0;

          let accumulated = this.toolCallAccumulator.get(index);
          if (!accumulated) {
            accumulated = {
              functionName: "",
              functionArguments: "",
            };
            this.toolCallAccumulator.set(index, accumulated);
          }

          // Log raw deltaToolCall for debugging
          log.info(`OpenRouter: Raw deltaToolCall [${index}]: ${JSON.stringify(deltaToolCall)}`);

          if (deltaToolCall.id) {
            accumulated.id = deltaToolCall.id;
            log.info(`OpenRouter: Captured tool call id: ${deltaToolCall.id}`);
          }
          if (deltaToolCall.type) {
            accumulated.type = deltaToolCall.type;
            log.info(`OpenRouter: Captured tool call type: ${deltaToolCall.type}`);
          }
          if (deltaToolCall.thought_signature) {
            accumulated.thought_signature = deltaToolCall.thought_signature;
            log.info(`OpenRouter: ✓ CAPTURED thought_signature from deltaToolCall: ${deltaToolCall.thought_signature}`);
          } else {
            log.info(`OpenRouter: ✗ No thought_signature in deltaToolCall [${index}]`);
          }

          if (deltaToolCall.function) {
            if (deltaToolCall.function.name) {
              accumulated.functionName += deltaToolCall.function.name;
            }
            if (deltaToolCall.function.arguments) {
              accumulated.functionArguments += deltaToolCall.function.arguments;
            }
          }

          log.info(
            `OpenRouter: Accumulated tool call [${index}] - name: "${accumulated.functionName}", args so far: "${accumulated.functionArguments.substring(0, 100)}${accumulated.functionArguments.length > 100 ? "..." : ""}"`,
          );
        }
      }

      // Accumulate reasoning_details if present in this final chunk
      // This is critical for Gemini models which require reasoning_details preservation
      const finalReasoningDetails = choice.delta?.reasoning_details ?? choice.delta?.reasoningDetails;
      if (finalReasoningDetails && finalReasoningDetails.length > 0) {
        this.reasoningDetailsAccumulator.push(...finalReasoningDetails);
        log.info(
          `OpenRouter: Accumulated ${finalReasoningDetails.length} reasoning_details (total: ${this.reasoningDetailsAccumulator.length})`,
        );
      }

      log.info("OpenRouter: finish_reason is 'tool_calls' - parsing accumulated tool calls");

      const accumulated = this.toolCallAccumulator.get(0);

      if (!accumulated?.functionName) {
        log.warn("OpenRouter: finish_reason is 'tool_calls' but no tool call was accumulated!");
        return {
          type: "done",
          thoughts: thoughts.length > 0 ? thoughts : undefined,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        };
      }

      // Log accumulated state for debugging
      log.info(
        `OpenRouter: Accumulated state - id: ${accumulated.id}, type: ${accumulated.type}, thought_signature: ${accumulated.thought_signature || "NONE"}, name: ${accumulated.functionName}`,
      );

      let parsedArgs: Record<string, unknown> = {};
      if (accumulated.functionArguments) {
        try {
          parsedArgs = JSON.parse(accumulated.functionArguments);
          log.info(`OpenRouter: Successfully parsed tool call arguments: ${JSON.stringify(parsedArgs)}`);
        } catch (parseError) {
          log.error(
            `OpenRouter: Failed to parse accumulated arguments as JSON: "${accumulated.functionArguments}"`,
            parseError,
          );
        }
      }

      const functionCall: FunctionCall = {
        name: accumulated.functionName,
        args: parsedArgs,
      };

      // Include thought_signature if present (required for Gemini models)
      if (accumulated.thought_signature) {
        functionCall.thoughtSignature = accumulated.thought_signature;
        log.info(`OpenRouter: ✓ INCLUDED thought_signature in FunctionCall object: ${accumulated.thought_signature}`);
      } else {
        log.warn(`OpenRouter: ✗ MISSING thought_signature - functionCall will not have thoughtSignature field!`);
      }

      // Include reasoning_details if any were accumulated (required for Gemini models)
      if (this.reasoningDetailsAccumulator.length > 0) {
        functionCall.reasoning_details = this.reasoningDetailsAccumulator;
        log.info(
          `OpenRouter: Including ${this.reasoningDetailsAccumulator.length} reasoning_details with function call`,
        );
      }

      log.info(
        `OpenRouter: Returning function_call - name: "${functionCall.name}", args: ${JSON.stringify(functionCall.args)}`,
      );

      this.toolCallAccumulator.clear();
      this.reasoningDetailsAccumulator = [];

      return {
        type: "function_call",
        functionCall,
        thoughts: thoughts.length > 0 ? thoughts : undefined,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      };
    }

    if (finishReason === "stop") {
      // Google models via OpenRouter commonly bundle the last text fragment with
      // the stop signal in a single chunk. Flush that content as a text chunk first;
      // the stream's natural close will signal done to the orchestrator.
      if (choice.delta?.content) {
        return {
          type: "text",
          content: choice.delta.content,
          thoughts: thoughts.length > 0 ? thoughts : undefined,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        };
      }
      return {
        type: "done",
        thoughts: thoughts.length > 0 ? thoughts : undefined,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      };
    }

    // Handle finishReason "length" (output token cap reached)
    // Make this explicit for diagnostics: this is a common failure mode when
    // long multimodal context leaves too little output budget.
    if (finishReason === "length") {
      log.warn(
        `OpenRouter: finish_reason is 'length' (max output tokens reached). ` +
          `delta.content present: ${!!choice.delta?.content}`,
      );

      const lengthMetadata: Record<string, unknown> = {
        ...metadata,
        finishReason: "length",
        outputTruncated: true,
      };

      // If the provider bundled final text with the terminal length chunk,
      // emit it so orchestrator can flush it before stream end.
      if (choice.delta?.content) {
        return {
          type: "text",
          content: choice.delta.content,
          thoughts: thoughts.length > 0 ? thoughts : undefined,
          metadata: lengthMetadata,
        };
      }

      // No final text payload in the terminal length chunk.
      // End the stream cleanly and let upstream empty-response handling decide retry.
      return {
        type: "done",
        thoughts: thoughts.length > 0 ? thoughts : undefined,
        metadata: {
          ...lengthMetadata,
          emptyTerminalChunk: true,
        },
      };
    }

    // Now handle delta fields for chunks that don't have a finishReason yet
    // Accumulate tool/function calls from delta (streaming tool calls arrive incrementally)
    // In OpenAI/OpenRouter streaming format, tool calls come in multiple chunks:
    // - First chunk: { index: 0, id: "call_123", type: "function", function: { name: "search" } }
    // - Later chunks: { index: 0, function: { arguments: '{"query' } }
    // - More chunks: { index: 0, function: { arguments: '":"test"}' } }
    // We need to accumulate all chunks before parsing the complete JSON arguments
    if (deltaToolCalls && deltaToolCalls.length > 0) {
      for (const deltaToolCall of deltaToolCalls) {
        const index = deltaToolCall.index ?? 0;

        let accumulated = this.toolCallAccumulator.get(index);
        if (!accumulated) {
          accumulated = {
            functionName: "",
            functionArguments: "",
          };
          this.toolCallAccumulator.set(index, accumulated);
        }

        // Log raw deltaToolCall for debugging (intermediate chunks)
        log.info(`OpenRouter: [INTERMEDIATE] Raw deltaToolCall [${index}]: ${JSON.stringify(deltaToolCall)}`);

        if (deltaToolCall.id) {
          accumulated.id = deltaToolCall.id;
          log.info(`OpenRouter: [INTERMEDIATE] Captured id: ${deltaToolCall.id}`);
        }
        if (deltaToolCall.type) {
          accumulated.type = deltaToolCall.type;
          log.info(`OpenRouter: [INTERMEDIATE] Captured type: ${deltaToolCall.type}`);
        }
        if (deltaToolCall.thought_signature) {
          accumulated.thought_signature = deltaToolCall.thought_signature;
          log.info(`OpenRouter: [INTERMEDIATE] ✓ CAPTURED thought_signature: ${deltaToolCall.thought_signature}`);
        } else {
          log.info(`OpenRouter: [INTERMEDIATE] ✗ No thought_signature in this chunk`);
        }

        if (deltaToolCall.function) {
          if (deltaToolCall.function.name) {
            accumulated.functionName += deltaToolCall.function.name;
          }
          if (deltaToolCall.function.arguments) {
            accumulated.functionArguments += deltaToolCall.function.arguments;
          }
        }

        log.info(
          `OpenRouter: Accumulated tool call [${index}] - name: "${accumulated.functionName}", args so far: "${accumulated.functionArguments.substring(0, 100)}${accumulated.functionArguments.length > 100 ? "..." : ""}"`,
        );
      }

      // Don't return yet - continue accumulating until finish_reason
      return {
        type: "text",
        content: "",
        thoughts: thoughts.length > 0 ? thoughts : undefined,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      };
    }

    // Accumulate reasoning_details from delta (required for Gemini models)
    // These can arrive in any chunk, not just the final one
    const reasoningDetails = choice.delta?.reasoning_details ?? choice.delta?.reasoningDetails;
    if (reasoningDetails && reasoningDetails.length > 0) {
      this.reasoningDetailsAccumulator.push(...reasoningDetails);
      return {
        type: "text",
        content: "",
        thoughts: thoughts.length > 0 ? thoughts : undefined,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      };
    }

    if (choice.delta?.content) {
      return {
        type: "text",
        content: choice.delta.content,
        thoughts: thoughts.length > 0 ? thoughts : undefined,
        servingProvider: this.servingProvider,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      };
    }

    return {
      type: "text",
      content: "",
      thoughts: thoughts.length > 0 ? thoughts : undefined,
      servingProvider: this.servingProvider,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  }

  private isProviderError(value: unknown): value is ProviderError {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Record<string, unknown>;
    return (
      typeof candidate.type === "string" &&
      typeof candidate.message === "string" &&
      typeof candidate.retryable === "boolean"
    );
  }

  /**
   * Map a resolved error code and message to a ProviderError type and retryable flag.
   * Used by both handleProviderError (thrown exceptions) and processChunk (SSE-injected errors)
   * so both paths stay in sync.
   */
  private mapErrorCodeToType(
    finalCode: string,
    finalMessage: string,
  ): { type: ProviderError["type"]; retryable: boolean } {
    if (finalCode.includes("400") || finalMessage.includes("400")) {
      return { type: "api_error", retryable: false };
    } else if (finalCode.includes("401") || finalMessage.includes("401")) {
      return { type: "api_error", retryable: false };
    } else if (finalCode.includes("402") || finalMessage.includes("402")) {
      // Insufficient credits is a billing issue, not a transient rate limit, so classify as
      // api_error so it reads "402_default_message" and gets the generic API-error title/tip
      // instead of the misleading "rate limit exceeded, wait and retry" copy.
      return { type: "api_error", retryable: false };
    } else if (finalCode.includes("413") || finalMessage.includes("413")) {
      return { type: "api_error", retryable: false }; // Payload too large
    } else if (finalCode.includes("404") || finalMessage.includes("404")) {
      return { type: "api_error", retryable: false };
    } else if (finalCode.includes("408") || finalMessage.includes("408")) {
      return { type: "timeout", retryable: true };
    } else if (finalCode.includes("429") || finalMessage.includes("429")) {
      return { type: "rate_limit", retryable: true };
    } else if (
      finalCode.includes("502") ||
      finalCode.includes("503") ||
      finalMessage.includes("502") ||
      finalMessage.includes("503")
    ) {
      return { type: "provider_overloaded", retryable: true };
    } else if (finalMessage.toLowerCase().includes("timeout")) {
      return { type: "timeout", retryable: true };
    } else if (finalMessage.toLowerCase().includes("content")) {
      return { type: "content_blocked", retryable: false };
    }
    return { type: "unknown", retryable: false };
  }

  /**
   * Handle OpenRouter-specific errors using official error codes
   */
  handleProviderError(error: unknown): ProviderError {
    // Pino's error serializer handles non-enumerable Error properties, so the full object is logged.
    logRawProviderError("OpenRouter", error);

    const errorMessage = error instanceof Error ? error.message : String(error);

    let errorCode: string | undefined;
    let extractedMessage: string | undefined;

    // First, try to extract from the error object directly (OpenRouter SDK format)
    if (error && typeof error === "object") {
      const errorObj = error as Record<string, unknown>;

      // Check for statusCode (OpenRouter SDK)
      if (errorObj.statusCode) {
        errorCode = String(errorObj.statusCode);
      }

      if (!errorCode && errorObj.error && typeof errorObj.error === "object") {
        const errorField = errorObj.error as Record<string, unknown>;
        if (errorField.code) {
          errorCode = String(errorField.code);
        }
      }

      if (!errorCode && errorObj.data$ && typeof errorObj.data$ === "object") {
        const data = errorObj.data$ as Record<string, unknown>;
        if (data.error && typeof data.error === "object") {
          const dataError = data.error as Record<string, unknown>;
          if (dataError.code) {
            errorCode = String(dataError.code);
          }
          if (dataError.message && typeof dataError.message === "string") {
            extractedMessage = dataError.message;
          }
        }
      }

      if (errorObj.body && typeof errorObj.body === "string") {
        try {
          const bodyParsed = JSON.parse(errorObj.body) as {
            error?: {
              code?: string | number;
              message?: string;
              metadata?: { raw?: string };
            };
            message?: string;
          };
          if (!errorCode && bodyParsed.error?.code !== undefined) {
            errorCode = String(bodyParsed.error.code);
          }
          if (!extractedMessage && bodyParsed.error?.metadata?.raw) {
            extractedMessage = bodyParsed.error.metadata.raw;
          }
          if (!extractedMessage && bodyParsed.error?.message) {
            extractedMessage = bodyParsed.error.message;
          }
          if (!extractedMessage && bodyParsed.message) {
            extractedMessage = bodyParsed.message;
          }
        } catch {}
      }
    }

    if (!errorCode) {
      const httpMatch = errorMessage.match(/HTTP\s+(\d{3})/i);
      if (httpMatch) {
        errorCode = httpMatch[1];
      }
    }

    // Fallback: try to parse from error message string
    if (!errorCode || !extractedMessage) {
      try {
        if (errorMessage.includes("{")) {
          const jsonMatch = errorMessage.match(/\{.*\}/s);
          if (jsonMatch) {
            const parsedError = JSON.parse(jsonMatch[0]);
            if (!errorCode) {
              errorCode = parsedError.error?.code || parsedError.code;
            }
            if (!extractedMessage) {
              extractedMessage = parsedError.error?.message || parsedError.message;
            }
          }
        }
      } catch {}
    }

    const finalMessage = String(extractedMessage || errorMessage || "Unknown error");
    const finalCode = errorCode || "unknown";

    // Special case: Privacy policy / data policy error
    if (
      finalMessage.includes("data policy") ||
      finalMessage.includes("Paid model training") ||
      finalMessage.includes("openrouter.ai/settings/privacy")
    ) {
      return {
        type: "api_error",
        message: `OpenRouter Privacy Policy Error: The selected model requires allowing data for paid model training, but your account privacy settings block this.\n\nOriginal error: ${finalMessage}`,
        code: finalCode,
        retryable: false,
        originalError: error,
        userMessage: extractedMessage,
      };
    }

    const { type: errorType, retryable } = this.mapErrorCodeToType(finalCode, finalMessage);

    return {
      type: errorType,
      message: `OpenRouter API error (${finalCode}): ${finalMessage}`,
      code: finalCode,
      retryable,
      originalError: error,
      userMessage: extractedMessage,
    };
  }

  /**
   * Create a user-friendly error description from a ProviderError
   */
  createErrorDescription(error: ProviderError, locale: string): string | null {
    // Special case: Privacy policy error - use localized message
    if (
      error.message?.includes("Privacy Policy Error") ||
      error.message?.includes("data policy") ||
      error.message?.includes("Paid model training")
    ) {
      return localizer(locale, "genai.openrouter.404_privacy_policy_error");
    }

    if (
      error.message?.includes("free-models-per-day") ||
      error.message?.includes("unlock 1000 free model requests per day")
    ) {
      return localizer(locale, "genai.openrouter.429_free_models_message");
    }

    let openrouterMessage = error.userMessage;

    if (!openrouterMessage) {
      // Fallback to locale-based default messages
      const errorCode = error.code;
      let messageKey: string;

      // Map error types to OpenRouter-specific locale keys
      switch (error.type) {
        case "content_blocked":
          messageKey = "403_default_message";
          break;
        case "rate_limit":
          messageKey = "429_default_message";
          break;
        case "timeout":
          messageKey = "408_default_message";
          break;
        case "provider_overloaded":
          messageKey = errorCode === "502" ? "502_default_message" : "503_default_message";
          break;
        case "api_error":
          messageKey = `${errorCode}_default_message`;
          break;
        default:
          messageKey = "unknown_default_message";
          break;
      }

      const localeKey = `genai.openrouter.${messageKey}`;
      openrouterMessage = localizer(locale, localeKey);

      // If localizer returns the key itself, it means the key doesn't exist
      // (localizer returns the key when it can't find a translation)
      if (openrouterMessage === localeKey) {
        // Fallback to generic unknown message
        openrouterMessage = localizer(locale, "genai.openrouter.unknown_default_message");
        // Append actual API error for unknown errors
        const maxErrorLength = 1000;
        const apiErrorSnippet =
          error.message.length > maxErrorLength ? `${error.message.substring(0, maxErrorLength)}...` : error.message;
        openrouterMessage += `\n\n**API Response:**\n${apiErrorSnippet}`;
      } else if (messageKey === "unknown_default_message") {
        // Even if we found the key, if it's the unknown message, append API error
        const maxErrorLength = 1000;
        const apiErrorSnippet =
          error.message.length > maxErrorLength ? `${error.message.substring(0, maxErrorLength)}...` : error.message;
        openrouterMessage += `\n\n**API Response:**\n${apiErrorSnippet}`;
      }
    }

    // Format as "Error Code {code}: {OpenRouter message}"
    const errorCode = error.code || "unknown";
    return `Error Code ${errorCode}: ${openrouterMessage}`;
  }

  /**
   * Assemble context items into OpenAI message format
   */
  private async assembleOpenrouterContext(
    contextItems: StructuredContextItem[],
    currentTurnModelParts: Array<Record<string, unknown>>,
    functionInteractionHistory?: Array<{
      functionCall: FunctionCall;
      functionResponse: Record<string, unknown>;
      imageMetadata?: FunctionResponseImageMetadata;
      preToolCallTextParts?: Array<Record<string, unknown>>;
    }>,
    seesImages: boolean = true,
    // Media wording is provider-agnostic and now comes from per-item sender metadata. Kept
    // positionally to avoid churning every caller's argument order.
    _botName: string = "Assistant",
    seesVideos: boolean = false,
    messageIdMap?: StreamContext["messageIdMap"],
  ): Promise<Array<Record<string, unknown>>> {
    const messages: Array<Record<string, unknown>> = [];
    const relocatedContextItems = relocateAssistantMediaContextItems(contextItems);
    const systemInstructionParts: string[] = [];

    for (const item of relocatedContextItems) {
      let itemTextContent = "";
      if (item.parts.some((p) => p.type === "text")) {
        itemTextContent = item.parts
          .filter((p) => p.type === "text")
          .map((p) => (p as { type: "text"; text: string }).text)
          .join("\n");
      }

      if (
        item.role === "system" ||
        (item.role === "user" &&
          item.metadataTag &&
          OpenrouterStreamAdapter.SYSTEM_INSTRUCTION_TAGS.includes(item.metadataTag))
      ) {
        if (itemTextContent) systemInstructionParts.push(itemTextContent);
      } else if (item.role === "user" || item.role === "model") {
        // CRITICAL: ALL user/model items go to dialogue (unless in SYSTEM_INSTRUCTION_TAGS)
        // This handles DIALOGUE_HISTORY, DIALOGUE_SAMPLE, and new tags like KNOWLEDGE_USERS_IN_CONVERSATION

        const role = item.role === "user" ? "user" : "assistant";
        // Collects resolved image parts from assistant turns for injection into a synthetic
        // user turn, since OpenRouter only permits image content on user-role messages.
        const pendingBotImageParts: Array<Record<string, unknown>> = [];
        const contentParts: Array<Record<string, unknown>> = [];

        for (const part of item.parts) {
          if (part.type === "text") {
            contentParts.push({
              type: "text",
              text: part.text,
            });
          } else if (part.type === "image") {
            // OpenRouter only permits image parts on user-role messages. For assistant
            // turns, images are resolved normally but staged in pendingBotImageParts,
            // then emitted as a synthetic user turn right after the assistant message.
            const imageTargetParts = role === "assistant" ? pendingBotImageParts : contentParts;

            // Only process images if the model supports them
            if (!seesImages) {
              log.info(`Skipping image (model doesn't support images): ${part.uri || "[inlineData]"}`);
              contentParts.push({
                type: "text",
                text: "[System: An image is attached to this message that this model cannot process.]",
              });
              continue;
            }

            if ("inlineData" in part && part.inlineData) {
              try {
                const inlineData = part.inlineData as {
                  mimeType: string;
                  data: string;
                };

                if (typeof inlineData === "object" && inlineData.mimeType && inlineData.data) {
                  if (inlineData.mimeType === "image/gif") {
                    const isProduction = process.env.RUN_ENV === "production";

                    if (isProduction) {
                      contentParts.push({
                        type: "text",
                        text: "[System: This context contains inline GIF data. GIF processing disabled in production.]",
                      });

                      log.info(
                        "OpenrouterStreamAdapter: Inline GIF detected in production mode, replaced with placeholder",
                      );
                    } else {
                      // Development: Replace with message ID hint for process_gif tool
                      // Note: URL intentionally omitted to prevent hallucinations - AI should use the tool
                      const mediaMessageId = item.messageId
                        ? (messageIdMap?.register(item.messageId, "media") ?? item.messageId)
                        : "unknown";
                      contentParts.push({
                        type: "text",
                        text: `[System: This message (ID: ${mediaMessageId}) contains inline GIF data. Use process_gif tool with this message ID to process it if needed for context.]`,
                      });

                      log.info(
                        `OpenrouterStreamAdapter: Inline GIF detected in dev mode, added process_gif hint for message: ${item.messageId}`,
                      );
                    }
                  } else {
                    imageTargetParts.push({
                      type: "image_url",
                      image_url: {
                        url: `data:${inlineData.mimeType};base64,${inlineData.data}`,
                      },
                    });

                    log.info("OpenrouterStreamAdapter: Processed image with existing inlineData");
                  }
                } else {
                  log.warn("OpenrouterStreamAdapter: Invalid inlineData structure for image part");
                }
              } catch (inlineErr) {
                log.warn("OpenrouterStreamAdapter: Error processing inlineData", {
                  error: inlineErr instanceof Error ? inlineErr.message : String(inlineErr),
                });
              }
              continue; // Skip to next part after handling inlineData
            }

            if (part.uri && part.mimeType) {
              try {
                let base64ImageData: string;
                let finalMimeType = part.mimeType;

                if (part.uri.startsWith("data:")) {
                  const dataUriMatch = part.uri.match(/^data:([^;]+);base64,(.+)$/);
                  if (dataUriMatch) {
                    finalMimeType = dataUriMatch[1];
                    base64ImageData = dataUriMatch[2];

                    log.info(`OpenrouterStreamAdapter: Parsed data URI (${finalMimeType})`);
                  } else {
                    log.warn(`OpenrouterStreamAdapter: Invalid data URI format: ${part.uri.substring(0, 50)}...`);
                    continue;
                  }
                } else {
                  if (part.mimeType === "image/gif") {
                    const isProduction = process.env.RUN_ENV === "production";

                    if (isProduction) {
                      // Production: Replace with text placeholder
                      // Check if this is a Tenor link (has descriptive slug)
                      if (part.uri.includes("tenor.com")) {
                        contentParts.push({
                          type: "text",
                          text: `[System: This message contains a GIF from Tenor: ${part.uri}. GIF processing disabled in production.]`,
                        });
                      } else {
                        // Discord attachment GIF: Just note its presence
                        contentParts.push({
                          type: "text",
                          text: "[System: This message contains a GIF. GIF processing disabled in production.]",
                        });
                      }

                      log.info(
                        `OpenrouterStreamAdapter: GIF detected in production mode, replaced with placeholder: ${part.uri}`,
                      );
                    } else {
                      // Development: Replace with message ID hint for process_gif tool
                      // Note: URL intentionally omitted to prevent hallucinations - AI should use the tool
                      const mediaMessageId = item.messageId
                        ? (messageIdMap?.register(item.messageId, "media") ?? item.messageId)
                        : "unknown";
                      contentParts.push({
                        type: "text",
                        text: `[System: This message (ID: ${mediaMessageId}) contains a GIF. Use process_gif tool with this message ID to process it if needed for context.]`,
                      });

                      log.info(
                        `OpenrouterStreamAdapter: GIF detected in dev mode, added process_gif hint for message: ${item.messageId}`,
                      );
                    }
                    continue; // Skip adding the GIF as an image
                  }

                  const optimized = await fetchAndOptimizeImage(part.uri, part.mimeType);
                  base64ImageData = optimized.data;
                  finalMimeType = optimized.mimeType;

                  log.success(`Successfully fetched image: ${part.uri}`);
                }

                imageTargetParts.push({
                  type: "image_url",
                  image_url: {
                    url: `data:${finalMimeType};base64,${base64ImageData}`,
                  },
                });

                log.success(`Successfully added image to message`);
              } catch (imgErr) {
                const fallback = (part as { fallbackUri?: string }).fallbackUri;
                if (fallback && fallback !== part.uri) {
                  try {
                    const optimized = await fetchAndOptimizeImage(fallback, part.mimeType);
                    imageTargetParts.push({
                      type: "image_url",
                      image_url: { url: `data:${optimized.mimeType};base64,${optimized.data}` },
                    });
                    log.info(`OpenrouterStreamAdapter: Image loaded via fallback CDN URL ${fallback}`);
                  } catch (fallbackErr) {
                    log.warn(`OpenrouterStreamAdapter: Image processing error (proxy + CDN both failed) ${part.uri}`, {
                      error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
                    });
                  }
                } else {
                  log.warn(`Error processing image: ${part.uri}`, {
                    error: imgErr instanceof Error ? imgErr.message : String(imgErr),
                  });
                }
              }
            }
          } else if (part.type === "video") {
            // Videos follow the same role restriction as images - only user-role messages.
            // For assistant turns, stage in pendingBotImageParts for a synthetic user turn.
            const videoTargetParts = role === "assistant" ? pendingBotImageParts : contentParts;

            if (!seesVideos) {
              log.info(`Skipping video (model doesn't support videos): ${part.uri}`);
              videoTargetParts.push({
                type: "text",
                text: "[System: A video is attached to this message that this model cannot process.]",
              });
              continue;
            }

            try {
              const isHttpUrl = part.uri.startsWith("http://") || part.uri.startsWith("https://");
              const isDataUrl = part.uri.startsWith("data:");
              if (!isHttpUrl && !isDataUrl) {
                log.warn(`Skipping unsupported video URI format for OpenRouter: ${part.uri}`);
                continue;
              }

              // OpenRouter accepts direct public URLs and data URLs for video_url.
              // Prefer direct URLs to avoid unnecessary fetch/encode overhead.
              videoTargetParts.push({
                type: "video_url",
                video_url: { url: part.uri },
              });

              if (part.isYouTubeLink) {
                log.success(`Added YouTube video to message: ${part.uri}`);
              } else if (isHttpUrl) {
                log.success(`Added direct video URL to message: ${part.uri}`);
              } else {
                log.success(`Added video data URL to message`);
              }
            } catch (videoErr) {
              log.warn(`Error processing video: ${part.uri}`, {
                error: videoErr instanceof Error ? videoErr.message : String(videoErr),
              });
            }
          }
        }

        if (contentParts.length > 0 || pendingBotImageParts.length > 0) {
          // OpenRouter only accepts plain-text content on assistant turns. Extract text
          // parts; images were already staged in pendingBotImageParts above.
          if (role === "assistant") {
            const assistantText = contentParts
              .filter((part) => part.type === "text")
              .map((part) => (part as { type: "text"; text: string }).text)
              .join("\n");

            if (!assistantText && pendingBotImageParts.length === 0) {
              continue;
            }

            if (assistantText) {
              messages.push({
                role,
                content: assistantText,
              });
            }

            // Inject a synthetic user turn to carry the bot's images. OpenRouter only
            // permits image parts on user-role messages, so we bridge the gap here.
            if (pendingBotImageParts.length > 0) {
              messages.push({
                role: "user",
                content: [
                  {
                    type: "text",
                    text: assistantMediaRelocationNotice(pendingBotImageParts.length, item.sender?.name),
                  },
                  ...pendingBotImageParts,
                ],
              });
            }

            continue;
          }

          // Flatten to a plain string whenever all parts are text-only.
          // Array format is only needed when the message genuinely mixes text + image parts.
          // Sending an array to strict text-only models (e.g. aion-2.0) causes a 400 error.
          const allTextOnly = contentParts.every((p) => p.type === "text");
          const content = allTextOnly
            ? contentParts.map((p) => (p as { type: "text"; text: string }).text).join("\n")
            : contentParts;

          messages.push({
            role,
            content,
          });
        }
      }
    }

    if (systemInstructionParts.length > 0) {
      const systemContent = systemInstructionParts.join("\n\n");
      messages.unshift({
        role: "system",
        content: systemContent,
      });
      log.info(`Assembled system message. Length: ${systemContent.length} characters`);
    }

    if (functionInteractionHistory && functionInteractionHistory.length > 0) {
      for (const interaction of functionInteractionHistory) {
        // Generate a tool call ID since our generic FunctionCall doesn't have one
        const toolCallId = `call_${Date.now()}_${Math.random().toString(36).substring(7)}`;

        // CRITICAL: Must include thought_signature and reasoning_details if present (required for Gemini models)
        const toolCallObject: Record<string, unknown> = {
          id: toolCallId,
          type: "function",
          function: {
            name: interaction.functionCall.name,
            arguments: JSON.stringify(interaction.functionCall.args || {}),
          },
        };

        // Include thought_signature if present (required for Gemini models)
        const hasThoughtSignature = Boolean(interaction.functionCall.thoughtSignature);
        if (interaction.functionCall.thoughtSignature) {
          toolCallObject.thought_signature = interaction.functionCall.thoughtSignature;
          log.info(
            `OpenRouter: ✓ PRESERVING thought_signature in assistant message for tool '${interaction.functionCall.name}': ${interaction.functionCall.thoughtSignature}`,
          );
        } else {
          log.warn(
            `OpenRouter: ✗ NO thought_signature to preserve for tool '${interaction.functionCall.name}' - this will cause Gemini error!`,
          );
        }

        // Join pre-tool-call text parts into content string (prevents model from repeating itself)
        let preToolCallContent: string | null = null;
        if (interaction.preToolCallTextParts && interaction.preToolCallTextParts.length > 0) {
          preToolCallContent = interaction.preToolCallTextParts
            .map((part) => (part as { text?: string }).text)
            .filter((text): text is string => typeof text === "string" && text.length > 0)
            .join("");
          if (preToolCallContent.length > 0) {
            log.info(
              `OpenRouter: Including ${preToolCallContent.length} chars of pre-tool-call text in assistant message`,
            );
          } else {
            preToolCallContent = null;
          }
        }

        const assistantMessage: Record<string, unknown> = {
          role: "assistant",
          content: preToolCallContent,
          tool_calls: [toolCallObject],
        };

        // Preserve reasoning_details if present (critical for Gemini models)
        // See: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#preserving-reasoning-blocks
        if (
          hasThoughtSignature &&
          interaction.functionCall.reasoning_details &&
          interaction.functionCall.reasoning_details.length > 0
        ) {
          assistantMessage.reasoning_details = interaction.functionCall.reasoning_details;
          log.info(
            `OpenRouter: Preserving ${interaction.functionCall.reasoning_details.length} reasoning_details in assistant message for tool '${interaction.functionCall.name}'`,
          );
        } else if (
          !hasThoughtSignature &&
          interaction.functionCall.reasoning_details &&
          interaction.functionCall.reasoning_details.length > 0
        ) {
          log.info(
            `OpenRouter: Skipping ${interaction.functionCall.reasoning_details.length} reasoning_details for tool '${interaction.functionCall.name}' because thought_signature is missing`,
          );
        }

        messages.push(assistantMessage);

        messages.push({
          role: "tool",
          tool_call_id: toolCallId,
          content: JSON.stringify(interaction.functionResponse),
        });

        // Build a follow-up user message only for image metadata. The function
        // response is already present in the role=tool message above; repeating
        // it as user text doubles large results such as fetched webpages.
        const responseParts: Array<Record<string, unknown>> = [];

        // If the tool returned images, surface them to the model as image_url parts (only if model supports images)
        if (interaction.imageMetadata?.imageUrls && interaction.imageMetadata.imageUrls.length > 0) {
          if (!seesImages) {
            log.info("OpenrouterStreamAdapter: Skipping tool images (model does not support images)");
          }

          for (const img of interaction.imageMetadata.imageUrls) {
            if (!seesImages) {
              continue;
            }
            responseParts.push(await inlineToolResponseImage(img, "OpenrouterStreamAdapter"));
          }
        }

        if (interaction.imageMetadata?.messageIds && interaction.imageMetadata.messageIds.length > 0) {
          responseParts.push({
            type: "text",
            text: `[System: Images were sent to Discord in message ID(s): ${interaction.imageMetadata.messageIds.map((id) => messageIdMap?.register(id, "media") ?? id).join(", ")}]`,
          });
        }

        if (responseParts.length > 0) {
          messages.push({
            role: "user",
            content: responseParts,
          });
        }
      }
    }

    if (currentTurnModelParts.length > 0) {
      const prefillText = currentTurnModelParts
        .map((part) => (part as { text?: string }).text)
        .filter((text): text is string => typeof text === "string" && text.length > 0)
        .join("");
      if (prefillText) {
        messages.push({
          role: "assistant",
          content: prefillText,
        });
        log.info(`OpenrouterStreamAdapter: Appended prefill assistant message (${prefillText.length} chars)`);
      }
    }

    log.info(`Assembled ${messages.length} messages for OpenRouter API`);
    return messages;
  }

  /**
   * Log full request for debugging (hides base64 image data)
   */
  private logSanitizedRequest(messages: Array<Record<string, unknown>>): void {
    // Deep clone and sanitize image data
    const sanitized = messages.map((msg) => {
      if (Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map((part: Record<string, unknown>) => {
            if (part.type === "image_url") {
              const imageUrlField =
                (part as { image_url?: { url?: string } }).image_url ||
                (part as { imageUrl?: { url?: string } }).imageUrl;
              if (imageUrlField?.url?.startsWith("data:")) {
                return {
                  type: "image_url",
                  image_url: {
                    ...imageUrlField,
                    url: "[BASE64_HIDDEN]",
                  },
                };
              }
            }
            return part;
          }),
        };
      }
      return msg;
    });

    log.info(`Full request structure:\n${JSON.stringify(sanitized, null, 2)}`);
  }
}
