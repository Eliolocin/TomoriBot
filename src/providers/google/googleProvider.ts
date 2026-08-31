/**
 * Google Gemini provider implementation
 * Implements the LLMProvider interface for Google's Gemini AI models
 *
 * Now uses the modular streaming architecture with StreamOrchestrator
 * and GoogleStreamAdapter for better code organization and maintainability.
 */

import { GoogleGenAI, type HarmBlockThreshold, type HarmCategory } from "@google/genai";
import type {
  BaseGuildTextChannel,
  BaseGuildVoiceChannel,
  Client,
  CommandInteraction,
  Message,
  DMChannel,
  AnyThreadChannel,
} from "discord.js";
import type { ZodType } from "zod";
import { StreamOrchestrator } from "../../utils/discord/streamOrchestrator";
import { GoogleStreamAdapter, type GoogleStreamConfig } from "./googleStreamAdapter";
import { validateGoogleModelsEndpoint } from "./googleCredentialValidation";
import { generateConversationSummaryGoogle, generateRoleplaySummaryGoogle } from "./compactGenerator";
import { generatePresetFromPrompt } from "./presetGenerator";
import type { ProviderError, StreamContext } from "../../types/stream/interfaces";
import { DISCORD_STREAMING_CONSTANTS } from "../../types/stream/types";
import { type ToolStateForContext, getAvailableToolsWithMCP } from "../../tools/toolRegistry";
import { applyStreamContextAvailability } from "@/tools/availability";
import type { StreamingContext } from "../../types/tool/interfaces";
import type { TomoriState } from "../../types/db/schema";
import type { StructuredContextItem } from "../../types/misc/context";
import { log } from "../../utils/misc/logger";
import { buildGoogleThinkingConfig } from "@/utils/provider/thinkingControl";
import type {
  CompactConversationResult,
  CompactRoleplayResult,
  EmbeddingRequest,
  PresetGenerationResult,
  ProviderCompactSummaryRequest,
  ProviderPresetGenerationRequest,
  ProviderStructuredJsonRequest,
  StructuredOutputResult,
  SupportsConversationCompaction,
  SupportsEmbeddings,
  SupportsPresetGeneration,
  SupportsStructuredOutput,
} from "../../types/provider/featureInterfaces";
import {
  BaseLLMProvider,
  type FunctionCall,
  type LLMProvider,
  type ProviderConfig,
  type ProviderInfo,
  type StreamResult,
  type ApiKeyValidationResult,
} from "../../types/provider/interfaces";
import { getGoogleToolAdapter } from "./googleToolAdapter";
import { callGoogleStructuredJSON } from "./googleStructuredOutput";
import { getCachedDefaultLLM, isLLMCacheReady } from "../../utils/cache/llmCache";
import { llmModelRepo } from "@/utils/db/repositories";
import { googleProviderInfo } from "./providerInfo";
import { getActiveTemperature, isParamDisabled } from "@/utils/provider/samplingControl";
import { DEFAULT_MAX_OUTPUT_TOKENS, resolveMaxOutputTokens } from "@/utils/provider/maxOutputTokens";
import { applyDeliberateToolAllowlist } from "@/utils/tools/deliberateToolMode";
import { buildStreamContext } from "@/utils/provider/streamContext";

/**
 * Gets the default Google Gemini model with a robust fallback chain:
 * 1. First checks the cached is_default LLM from the database
 * 2. Falls back to database query for is_default model if cache is not ready
 * 3. Falls back to first non-deprecated model from database
 * 4. Throws error if no models are available
 * @returns Promise<string> - The default model codename
 */
async function getDefaultGoogleModel(): Promise<string> {
  const providerName = "google";

  if (isLLMCacheReady()) {
    const cachedDefault = getCachedDefaultLLM(providerName);
    if (cachedDefault) {
      log.info(`Using cached default ${providerName} model: ${cachedDefault.llm_codename}`);
      return cachedDefault.llm_codename;
    }
  }

  try {
    const dbDefault = await llmModelRepo.loadDefaultModel(providerName);
    if (dbDefault) {
      log.info(`Using database default ${providerName} model: ${dbDefault.llm_codename}`);
      return dbDefault.llm_codename;
    }
  } catch (error) {
    log.warn(`Failed to load default model from database for ${providerName}`, {
      error: error as Error,
    });
  }

  try {
    const availableModels = await llmModelRepo.loadAvailableModelsForProvider(providerName);
    if (availableModels && availableModels.length > 0) {
      const firstModel = availableModels[0].llm_codename;
      log.warn(`No default model found, using first available ${providerName} model: ${firstModel}`);
      return firstModel;
    }
  } catch (error) {
    log.error(`Failed to load available models for ${providerName}`, error as Error);
  }

  throw new Error(`No default model found for provider: ${providerName}. Please configure models in the database.`);
}

function extractGoogleEmbeddings(response: unknown): number[][] {
  const raw = response as {
    embeddings?: Array<{ values?: number[] } | number[]>;
    embedding?: { values?: number[] } | number[];
  };

  const embeddingsList = Array.isArray(raw?.embeddings) ? raw.embeddings : raw?.embedding ? [raw.embedding] : [];

  const extracted = embeddingsList
    .map((entry) => {
      if (Array.isArray(entry)) {
        return entry;
      }
      if (entry && Array.isArray(entry.values)) {
        return entry.values;
      }
      return [];
    })
    .filter((values) => values.length > 0);

  // Dropping unreadable entries silently would make a malformed response look like a short
  // batch, so record it: the caller only sees a count, not the shape that produced it.
  if (extracted.length !== embeddingsList.length) {
    log.warn(
      `Google embedding response contained ${embeddingsList.length} entries but only ` +
        `${extracted.length} had usable values.`,
    );
  }

  return extracted;
}

export interface GoogleProviderConfig extends ProviderConfig {
  safetySettings: Array<{
    category: string;
    threshold: string;
  }>;
  generationConfig: {
    temperature?: number;
    topK?: number;
    topP?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
    frequencyPenalty?: number;
    presencePenalty?: number;
    seed?: number;
  };
}

const GOOGLE_PENALTY_MIN = -2.0;
const GOOGLE_PENALTY_MAX = 1.99;
const loggedGooglePenaltyNormalizations = new Set<string>();
const loggedGooglePenaltySkips = new Set<string>();

function isGemini3Model(model: string): boolean {
  return model.trim().toLowerCase().startsWith("gemini-3");
}

function isGooglePenaltyParamsEnabled(): boolean {
  return process.env.GOOGLE_ENABLE_PENALTY_PARAMS?.toLowerCase() === "true";
}

function sanitizeGooglePenalty(
  value: number,
  field: "frequencyPenalty" | "presencePenalty",
  serverId?: number | null,
): number {
  const sanitizedValue = Math.max(GOOGLE_PENALTY_MIN, Math.min(GOOGLE_PENALTY_MAX, value));
  if (sanitizedValue !== value) {
    const warningKey = `${serverId ?? "unknown"}:${field}:${value}:${sanitizedValue}`;
    if (!loggedGooglePenaltyNormalizations.has(warningKey)) {
      loggedGooglePenaltyNormalizations.add(warningKey);
      log.warn(
        `Normalized Google ${field} from ${value} to ${sanitizedValue} because Gemini requires penalties in [-2.0, 2.0).`,
        {
          serverId: serverId ?? null,
          field,
          originalValue: value,
          sanitizedValue,
        },
      );
    }
  }

  return sanitizedValue;
}

function logSkippedGooglePenaltyParams(
  model: string,
  serverId: number,
  reason: string,
  frequencyPenalty?: number,
  presencePenalty?: number,
): void {
  const warningKey = `${serverId}:${model}:${reason}`;
  if (loggedGooglePenaltySkips.has(warningKey)) {
    return;
  }

  loggedGooglePenaltySkips.add(warningKey);
  log.warn(`Skipping Google penalty params for model ${model}: ${reason}.`, {
    serverId,
    model,
    reason,
    frequencyPenalty: frequencyPenalty ?? null,
    presencePenalty: presencePenalty ?? null,
  });
}

/**
 * Google Gemini provider implementation
 */
export class GoogleProvider
  extends BaseLLMProvider
  implements
    LLMProvider,
    SupportsEmbeddings,
    SupportsStructuredOutput,
    SupportsPresetGeneration,
    SupportsConversationCompaction
{
  /**
   * Get provider information and capabilities
   */
  getInfo(): ProviderInfo {
    return googleProviderInfo;
  }

  /**
   * Validate a Google API key through the authenticated models endpoint
   * @returns Promise<ApiKeyValidationResult> - Validation result with detailed error info if failed
   */
  async validateApiKey(apiKey: string): Promise<ApiKeyValidationResult> {
    if (!apiKey || apiKey.trim().length < 10) {
      log.warn("API key is too short or empty");
      const googleAdapter = new GoogleStreamAdapter();
      const error = new Error("API key is too short or empty");
      const providerError = googleAdapter.handleProviderError(error);
      return { valid: false, error: providerError };
    }

    try {
      log.info("Validating Google API key...");

      const genAI = new GoogleGenAI({ apiKey });

      await validateGoogleModelsEndpoint(genAI);

      log.success("Google API key validation successful via models endpoint");
      return { valid: true };
    } catch (error) {
      const googleAdapter = new GoogleStreamAdapter();
      const providerError = googleAdapter.handleProviderError(error);

      const isUserError = providerError.type === "api_error";

      if (!isUserError) {
        await log.error("API key validation failed", error, {
          errorType: "APIKeyValidationError",
          metadata: {
            provider: "google",
            errorCode: providerError.code,
            errorType: providerError.type,
          },
        });
      } else {
        log.warn(`Google API key validation failed (user input error): ${providerError.message}`);
      }
      return { valid: false, error: providerError };
    }
  }

  formatErrorDescription(error: ProviderError, locale: string): string | null {
    const googleAdapter = new GoogleStreamAdapter();
    return googleAdapter.createErrorDescription(error, locale);
  }

  supportsEmbeddingTaskType(): boolean {
    return true;
  }

  async generateEmbeddings(request: EmbeddingRequest): Promise<number[][]> {
    if (request.inputs.length === 0) {
      return [];
    }

    const genAI = new GoogleGenAI({ apiKey: request.apiKey });
    const response = await genAI.models.embedContent({
      model: request.model,
      contents: request.inputs,
      config: request.taskType ? { taskType: request.taskType } : undefined,
    });

    return extractGoogleEmbeddings(response);
  }

  getExpressionInitializationBatchSize(): number {
    return 30;
  }

  async callStructuredJSON<T>(
    request: ProviderStructuredJsonRequest,
    responseSchema: Record<string, unknown>,
    zodSchema: ZodType<T>,
  ): Promise<StructuredOutputResult<T>> {
    return await callGoogleStructuredJSON(request, responseSchema, zodSchema);
  }

  async generatePreset(request: ProviderPresetGenerationRequest): Promise<PresetGenerationResult> {
    const defaultSearchModelName = request.params.useWebSearch ? await this.getDefaultModel() : undefined;

    return await generatePresetFromPrompt(
      request.apiKey,
      {
        ...request.params,
        modelName: request.tomoriState.llm.llm_codename,
      },
      request.locale,
      undefined,
      defaultSearchModelName,
    );
  }

  async generateConversationSummary(request: ProviderCompactSummaryRequest): Promise<CompactConversationResult> {
    return await generateConversationSummaryGoogle(request);
  }

  async generateRoleplaySummary(request: ProviderCompactSummaryRequest): Promise<CompactRoleplayResult> {
    return await generateRoleplaySummaryGoogle(request);
  }

  /**
   * Get available tools/functions based on Tomori's configuration
   * Uses the enhanced tool adapter that handles both built-in and MCP tools
   * @param streamingContext - Optional streaming context for context-aware tool availability
   */
  async getTools(
    tomoriState: TomoriState,
    streamingContext?: StreamingContext,
  ): Promise<Array<Record<string, unknown>>> {
    try {
      const toolStateForContext: ToolStateForContext = {
        server_id: tomoriState.server_id.toString(),
        activePersonaHasElevenlabsVoice: Boolean(
          tomoriState.speech_voice_sample_id ||
            tomoriState.speech_voice_design_prompt?.trim() ||
            tomoriState.speech_voice_id?.trim(),
        ),
        activePersonaVoiceDesignPrompt: tomoriState.speech_voice_design_prompt?.trim() || null,
        activePersonaVoiceName: tomoriState.speech_voice_name,
        diffusion_model_id: tomoriState.config.diffusion_model_id,
        nai_diffusion_model_id: tomoriState.config.nai_diffusion_model_id,
        video_model_id: tomoriState.config.video_model_id,
        llm: {
          llm_codename: tomoriState.llm.llm_codename,
          has_tools: tomoriState.llm.has_tools,
          sees_images: tomoriState.llm.sees_images,
          sees_videos: tomoriState.llm.sees_videos,
          sees_youtube: tomoriState.llm.sees_youtube,
          supports_structoutput: tomoriState.llm.supports_structoutput,
        },
        config: {
          sticker_usage_enabled: tomoriState.config.sticker_usage_enabled,
          web_search_enabled: tomoriState.config.web_search_enabled,
          self_teaching_enabled: tomoriState.config.self_teaching_enabled,
          manage_message_enabled: tomoriState.config.manage_message_enabled,
          imagegen_enabled: tomoriState.config.imagegen_enabled,
          videogen_enabled: tomoriState.config.videogen_enabled,
          voice_message_enabled: tomoriState.config.voice_message_enabled,
          user_blocking_enabled: tomoriState.config.user_blocking_enabled,
          user_info_updates_enabled: tomoriState.config.user_info_updates_enabled,
          thread_creation_enabled: tomoriState.config.thread_creation_enabled,
        },
      };

      const {
        builtInTools: availableBuiltInTools,
        mcpFunctionNames: availableMcpFunctionNames,
        totalCount,
      } = await getAvailableToolsWithMCP("google", toolStateForContext);

      let finalBuiltInTools = applyStreamContextAvailability({
        providerLabel: "Google provider",
        provider: "google",
        builtInTools: availableBuiltInTools,
        streamContext: streamingContext,
        tomoriState,
      });
      let finalMcpFunctionNames = availableMcpFunctionNames;

      ({ builtInTools: finalBuiltInTools, mcpFunctionNames: finalMcpFunctionNames } = applyDeliberateToolAllowlist({
        providerLabel: "Google provider",
        builtInTools: finalBuiltInTools,
        mcpFunctionNames: finalMcpFunctionNames,
        allowedToolNames: streamingContext?.deliberateToolAllowedNames,
      }));

      // Use the enhanced tool adapter to get all tools (built-in + MCP)
      // Pass the pre-filtered MCP function names to ensure centralized filtering
      const googleAdapter = getGoogleToolAdapter();
      const allToolsConfig = await googleAdapter.getAllToolsInGoogleFormat(
        finalBuiltInTools,
        tomoriState.server_id,
        finalMcpFunctionNames, // Pass filtered MCP functions from centralized filtering
      );

      log.info(
        `Google provider tools loaded: ${finalBuiltInTools.length} built-in + ${finalMcpFunctionNames.length} MCP = ${totalCount} total tools (centralized filtering applied)`,
      );

      return allToolsConfig;
    } catch (error) {
      log.error(`Failed to get tools for Google provider: ${tomoriState.llm.llm_codename}`, error as Error);
      return [];
    }
  }

  /**
   * Uses the cached database default with database and available-model fallbacks.
   * @returns Promise<string> - The default model codename
   */
  async getDefaultModel(): Promise<string> {
    return await getDefaultGoogleModel();
  }

  /**
   * Convert provider-specific configuration from TomoriState
   * @returns Promise<GoogleProviderConfig> - Provider-specific configuration object
   */
  async createConfig(tomoriState: TomoriState, apiKey: string): Promise<GoogleProviderConfig> {
    // Resolve max output tokens: user config takes priority, then env var, then hardcoded default.
    // Shared with the context truncator (see resolveMaxOutputTokens) so the reserve and the request
    // never drift. Google does not clamp to a model-reported ceiling here (no providerReportedMax).
    const maxOutputTokens = resolveMaxOutputTokens({
      configured: tomoriState.config.llm_max_output_tokens,
      envRaw: process.env.GOOGLE_MAX_OUTPUT_TOKENS,
      fallback: DEFAULT_MAX_OUTPUT_TOKENS,
    });
    const modelCodename = tomoriState.llm.llm_codename;
    const disabledParams = tomoriState.config.llm_disabled_params ?? [];
    const temperature = getActiveTemperature(tomoriState.config);
    const topKDisabled = isParamDisabled(disabledParams, "topK");
    const topPDisabled = isParamDisabled(disabledParams, "topP");
    const frequencyPenaltyDisabled = isParamDisabled(disabledParams, "frequencyPenalty");
    const presencePenaltyDisabled = isParamDisabled(disabledParams, "presencePenalty");
    const googlePenaltyParamsEnabled = isGooglePenaltyParamsEnabled();
    const supportsPenaltyParams = googlePenaltyParamsEnabled && isGemini3Model(modelCodename);
    const hasConfiguredPenaltyParams =
      (!frequencyPenaltyDisabled && tomoriState.config.llm_frequency_penalty !== 0) ||
      (!presencePenaltyDisabled && tomoriState.config.llm_presence_penalty !== 0);
    if (!supportsPenaltyParams && hasConfiguredPenaltyParams) {
      const skipReason = !googlePenaltyParamsEnabled
        ? "GOOGLE_ENABLE_PENALTY_PARAMS is disabled"
        : "only Gemini 3 models receive frequency/presence penalties";
      logSkippedGooglePenaltyParams(
        modelCodename,
        tomoriState.server_id,
        skipReason,
        !frequencyPenaltyDisabled && tomoriState.config.llm_frequency_penalty !== 0
          ? tomoriState.config.llm_frequency_penalty
          : undefined,
        !presencePenaltyDisabled && tomoriState.config.llm_presence_penalty !== 0
          ? tomoriState.config.llm_presence_penalty
          : undefined,
      );
    }
    const frequencyPenalty =
      supportsPenaltyParams && !frequencyPenaltyDisabled && tomoriState.config.llm_frequency_penalty !== 0
        ? sanitizeGooglePenalty(tomoriState.config.llm_frequency_penalty, "frequencyPenalty", tomoriState.server_id)
        : undefined;
    const presencePenalty =
      supportsPenaltyParams && !presencePenaltyDisabled && tomoriState.config.llm_presence_penalty !== 0
        ? sanitizeGooglePenalty(tomoriState.config.llm_presence_penalty, "presencePenalty", tomoriState.server_id)
        : undefined;

    const config: GoogleProviderConfig = {
      model: modelCodename,
      apiKey: apiKey,
      temperature: tomoriState.config.llm_temperature,
      disabledParams,
      maxOutputTokens,
      safetySettings: [
        {
          category: "HARM_CATEGORY_HARASSMENT",
          threshold: "BLOCK_NONE",
        },
        {
          category: "HARM_CATEGORY_HATE_SPEECH",
          threshold: "BLOCK_NONE",
        },
        {
          category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
          threshold: "BLOCK_NONE",
        },
        {
          category: "HARM_CATEGORY_DANGEROUS_CONTENT",
          threshold: "BLOCK_NONE",
        },
      ],
      generationConfig: {
        ...(temperature !== undefined && {
          temperature,
        }),
        // Only include topK/topP if user has configured non-neutral values
        // Neutral: topK=0 (disabled) and topP=1.0 (full probability distribution)
        ...(!topKDisabled &&
          tomoriState.config.llm_top_k > 0 && {
            topK: tomoriState.config.llm_top_k,
          }),
        ...(!topPDisabled &&
          tomoriState.config.llm_top_p < 1.0 && {
            topP: tomoriState.config.llm_top_p,
          }),
        // Only include penalty params if user has configured non-neutral values
        // Neutral: frequencyPenalty=0.0, presencePenalty=0.0
        ...(frequencyPenalty !== undefined && {
          frequencyPenalty,
        }),
        ...(presencePenalty !== undefined && {
          presencePenalty,
        }),
        maxOutputTokens,
        stopSequences: [],
      },
    };

    // Only attach tools for models that explicitly support function calling.
    // This prevents Google API 400 errors on models like gemma-3-27b-it.
    if (tomoriState.llm.has_tools) {
      config.tools = await this.getTools(tomoriState);
    }

    return config;
  }

  /**
   * Stream LLM response directly to a Discord channel
   * Now uses the modular streaming architecture with StreamOrchestrator and GoogleStreamAdapter
   * This maintains the exact same interface for full backward compatibility
   */
  async streamToDiscord(
    channel: BaseGuildTextChannel | BaseGuildVoiceChannel | DMChannel | AnyThreadChannel,
    client: Client,
    tomoriState: TomoriState,
    config: ProviderConfig,
    contextItems: StructuredContextItem[],
    currentTurnModelParts: Array<Record<string, unknown>>,
    emojiStrings?: string[],
    functionInteractionHistory?: Array<{
      functionCall: FunctionCall;
      functionResponse: Record<string, unknown>;
    }>,
    initialInteraction?: CommandInteraction,
    replyToMessage?: Message,
    streamingContext?: StreamingContext,
    userLocale?: string,
    webhook?: import("discord.js").Webhook,
    personaAvatarUrl?: string,
    personaUsername?: string,
    prefixStrippingName?: string,
  ): Promise<StreamResult> {
    log.info(`GoogleProvider: Starting modular streaming for server ${tomoriState.server_id}, model ${config.model}`);

    try {
      const googleConfig = config as GoogleProviderConfig;

      const safetySettings = googleConfig.safetySettings || [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        {
          category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
          threshold: "BLOCK_NONE",
        },
        {
          category: "HARM_CATEGORY_DANGEROUS_CONTENT",
          threshold: "BLOCK_NONE",
        },
      ];

      const streamConfig: GoogleStreamConfig = {
        ...googleConfig,
        maxMessageLength: DISCORD_STREAMING_CONSTANTS.MAX_SINGLE_MESSAGE_LENGTH,
        flushBufferSize: DISCORD_STREAMING_CONSTANTS.FLUSH_BUFFER_SIZE_REGULAR,
        flushBufferSizeCodeBlock: DISCORD_STREAMING_CONSTANTS.FLUSH_BUFFER_SIZE_CODE_BLOCK,
        inactivityTimeoutMs: DISCORD_STREAMING_CONSTANTS.INACTIVITY_TIMEOUT_MS,
        baseTypeSpeedMsPerChar: DISCORD_STREAMING_CONSTANTS.BASE_TYPE_SPEED_MS_PER_CHAR,
        maxTypingTimeMs: DISCORD_STREAMING_CONSTANTS.MAX_TYPING_TIME_MS,
        minVisibleTypingDurationMs: DISCORD_STREAMING_CONSTANTS.MIN_VISIBLE_TYPING_DURATION_MS,
        humanizerDegree: tomoriState.config.humanizer_degree,
        emojiUsageEnabled: tomoriState.config.emoji_usage_enabled,
        safetySettings: safetySettings.map((setting) => ({
          category: setting.category as HarmCategory,
          threshold: setting.threshold as HarmBlockThreshold,
        })),
        forceReason: streamingContext?.forceReason,
        isManuallyTriggered: streamingContext?.isManuallyTriggered,
      };

      const thinkingConfig = buildGoogleThinkingConfig(
        config.model ?? "",
        tomoriState.config.thinking_level,
        streamingContext?.forceReason,
      );
      if (thinkingConfig) {
        streamConfig.thinkingConfig = thinkingConfig;
        log.info(`GoogleProvider: Applied thinking config for model ${config.model}`);
      }

      if (streamingContext && tomoriState.llm.has_tools) {
        log.info("GoogleProvider: Reloading tools with streaming context for context-aware availability");
        const contextAwareTools = await this.getTools(tomoriState, streamingContext);
        streamConfig.tools = contextAwareTools;
      } else if (streamingContext && !tomoriState.llm.has_tools) {
        log.info("GoogleProvider: Skipping context-aware tool reload - model doesn't support tools");
      }

      const streamContext: StreamContext = buildStreamContext({
        provider: "google",
        channel,
        client,
        initialInteraction,
        replyToMessage,
        tomoriState,
        contextItems,
        currentTurnModelParts,
        emojiStrings,
        functionInteractionHistory,
        userLocale,
        streamingContext,
        webhook,
        personaAvatarUrl,
        personaUsername,
        prefixStrippingName,
      });

      const orchestrator = new StreamOrchestrator();
      const googleAdapter = new GoogleStreamAdapter();

      log.info("GoogleProvider: Delegating to StreamOrchestrator with GoogleStreamAdapter");
      const result = await orchestrator.streamToDiscord(googleAdapter, streamConfig, streamContext);

      log.info(
        `GoogleProvider: Modular streaming completed with status: ${result.status}${result.status === "stopped_by_user" && result.stopReason ? ` (reason: ${result.stopReason})` : ""}`,
      );
      return result;
    } catch (error) {
      log.error(
        `GoogleProvider modular streaming error for server ${tomoriState.server_id}, model ${config.model}, channel ${channel.id}`,
        error as Error,
      );

      return {
        status: "error",
        data: error as Error,
      };
    }
  }
}
