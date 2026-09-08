/**
 * NovelAI provider implementation
 * Implements the LLMProvider interface for NovelAI's text generation models
 *
 * NovelAI is a roleplay-focused provider that:
 * - Uses flat text prompts (no structured messages)
 * - Supports prompt-based tool calling for GLM-4.6 via manual parsing
 * - Does not support images or videos
 * - Specializes in creative storytelling and roleplay
 */

import type {
  BaseGuildTextChannel,
  BaseGuildVoiceChannel,
  Client,
  CommandInteraction,
  Message,
  DMChannel,
  AnyThreadChannel,
} from "discord.js";
import { StreamOrchestrator } from "@/utils/discord/streamOrchestrator";
import { buildStreamContext } from "@/utils/provider/streamContext";
import { NovelaiStreamAdapter, type NovelaiStreamConfig } from "./novelaiStreamAdapter";
import type { ProviderError, StreamContext } from "@/types/stream/interfaces";
import { DISCORD_STREAMING_CONSTANTS } from "@/types/stream/types";
import type { StreamingContext } from "@/types/tool/interfaces";
import type { TomoriState } from "@/types/db/schema";
import type { StructuredContextItem } from "@/types/misc/context";
import { log } from "@/utils/misc/logger";
import { getAvailableToolsWithMCP, type ToolStateForContext } from "@/tools/toolRegistry";
import { applyStreamContextAvailability } from "@/tools/availability";
import {
  BaseLLMProvider,
  type FunctionCall,
  type LLMProvider,
  type ProviderConfig,
  type ProviderInfo,
  type StreamResult,
  type ApiKeyValidationResult,
} from "@/types/provider/interfaces";
import { getCachedDefaultLLM, isLLMCacheReady } from "@/utils/cache/llmCache";
import { llmModelRepo } from "@/utils/db/repositories";
import { getNovelaiToolAdapter } from "./novelaiToolAdapter";
import { usesOpenAIEndpoint, validateNovelAIApiKey } from "./novelaiService";
import { novelaiProviderInfo } from "./providerInfo";
import { getActiveTemperature } from "@/utils/provider/samplingControl";
import { applyDeliberateToolAllowlist } from "@/utils/tools/deliberateToolMode";
import { resolveToolsEnabled } from "@/utils/tools/toolUseGate";

/**
 * Gets the default NovelAI model with a robust fallback chain:
 * 1. First checks the cached is_default LLM from the database
 * 2. Falls back to database query for is_default model if cache is not ready
 * 3. Falls back to first non-deprecated model from database
 * 4. Throws error if no models are available
 * @returns Promise<string> - The default model codename
 */
async function getDefaultNovelAIModel(): Promise<string> {
  const providerName = "novelai";

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

/**
 * NovelAI-specific configuration extending the base ProviderConfig
 * NovelAI has minimal configuration compared to other providers
 */
export interface NovelaiProviderConfig extends ProviderConfig {
  // NovelAI uses flat parameters in the service layer
  // No provider-specific config needed here
}

/**
 * NovelAI provider implementation
 */
export class NovelaiProvider extends BaseLLMProvider implements LLMProvider {
  /**
   * Get provider information and capabilities
   */
  getInfo(): ProviderInfo {
    return novelaiProviderInfo;
  }

  /**
   * Validate a NovelAI API key by making a test request
   * @returns Promise<ApiKeyValidationResult> - Validation result with detailed error info if failed
   */
  async validateApiKey(apiKey: string): Promise<ApiKeyValidationResult> {
    if (!apiKey || apiKey.trim().length < 10) {
      log.warn("NovelAI API key is too short or empty");
      const novelaiAdapter = new NovelaiStreamAdapter();
      const error = new Error("API key is too short or empty");
      const providerError = novelaiAdapter.handleProviderError(error);
      return { valid: false, error: providerError };
    }

    try {
      log.info("Validating NovelAI API key...");
      await validateNovelAIApiKey(apiKey);

      log.success("NovelAI API key validation successful");
      return { valid: true };
    } catch (error) {
      const novelaiAdapter = new NovelaiStreamAdapter();
      const providerError = novelaiAdapter.handleProviderError(error);

      const isUserError = providerError.type === "api_error";

      if (!isUserError) {
        await log.error("API key validation failed", error, {
          errorType: "APIKeyValidationError",
          metadata: {
            provider: "novelai",
            errorCode: providerError.code,
            errorType: providerError.type,
          },
        });
      } else {
        log.warn(`NovelAI API key validation failed (user input error): ${providerError.message}`);
      }
      return { valid: false, error: providerError };
    }
  }

  formatErrorDescription(error: ProviderError, locale: string): string | null {
    const novelaiAdapter = new NovelaiStreamAdapter();
    return novelaiAdapter.createErrorDescription(error, locale);
  }

  /**
   * Get available tools/functions based on Tomori's configuration
   * Prompt-based tool calling is supported for GLM-4.6 via manual parsing.
   * Returns empty array when tools are disabled or the model doesn't support them.
   * @param streamingContext - Optional streaming context for context-aware tool availability
   */
  async getTools(
    tomoriState: TomoriState,
    streamingContext?: StreamingContext,
  ): Promise<Array<Record<string, unknown>>> {
    if (streamingContext?.disableAllTools) {
      log.info("NovelAI provider: Tools disabled via streaming context (disableAllTools)");
      return [];
    }

    if (!resolveToolsEnabled(tomoriState, tomoriState.llm.has_tools)) {
      log.info(
        `NovelAI provider: Tools unavailable (tool_use_enabled=${tomoriState.config.tool_use_enabled}, has_tools=${tomoriState.llm.has_tools})`,
      );
      return [];
    }

    if (!usesOpenAIEndpoint(tomoriState.llm.llm_codename)) {
      log.info("NovelAI provider: Tool calling is only supported on GLM-4.6 (OpenAI endpoint models)");
      return [];
    }

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
      } = await getAvailableToolsWithMCP("novelai", toolStateForContext);

      let finalBuiltInTools = applyStreamContextAvailability({
        providerLabel: "NovelAI provider",
        provider: "novelai",
        builtInTools: availableBuiltInTools,
        streamContext: streamingContext,
        tomoriState,
      });
      let finalMcpFunctionNames = availableMcpFunctionNames;

      ({ builtInTools: finalBuiltInTools, mcpFunctionNames: finalMcpFunctionNames } = applyDeliberateToolAllowlist({
        providerLabel: "NovelAI provider",
        builtInTools: finalBuiltInTools,
        mcpFunctionNames: finalMcpFunctionNames,
        allowedToolNames: streamingContext?.deliberateToolAllowedNames,
      }));

      const novelaiAdapter = getNovelaiToolAdapter();
      const allToolsConfig = await novelaiAdapter.getAllToolsInProviderFormat(
        finalBuiltInTools,
        tomoriState.server_id,
        finalMcpFunctionNames,
      );

      log.info(
        `NovelAI provider tools loaded: ${finalBuiltInTools.length} built-in + ${finalMcpFunctionNames.length} MCP = ${totalCount} total tools`,
      );

      return allToolsConfig;
    } catch (error) {
      log.error(`Failed to get tools for NovelAI provider: ${tomoriState.llm.llm_codename}`, error as Error);
      return [];
    }
  }

  /**
   * Uses the robust fallback chain: cache > database
   * @returns Promise<string> - The default model codename
   */
  async getDefaultModel(): Promise<string> {
    return await getDefaultNovelAIModel();
  }

  /**
   * Convert provider-specific configuration from TomoriState
   */
  async createConfig(tomoriState: TomoriState, apiKey: string): Promise<NovelaiProviderConfig> {
    const tools = await this.getTools(tomoriState);

    return {
      model: tomoriState.llm.llm_codename,
      apiKey: apiKey,
      temperature: getActiveTemperature(tomoriState.config) ?? tomoriState.config.llm_temperature,
      disabledParams: tomoriState.config.llm_disabled_params ?? [],
      maxOutputTokens: tomoriState.config.llm_max_output_tokens ?? 2048,
      tools: tools,
    };
  }

  /**
   * Stream LLM response directly to a Discord channel
   * Uses the modular streaming architecture with StreamOrchestrator and NovelAIStreamAdapter
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
    log.info(`NovelAIProvider: Starting streaming for server ${tomoriState.server_id}, model ${config.model}`);

    try {
      const streamConfig: NovelaiStreamConfig = {
        ...config,
        maxMessageLength: DISCORD_STREAMING_CONSTANTS.MAX_SINGLE_MESSAGE_LENGTH,
        flushBufferSize: DISCORD_STREAMING_CONSTANTS.FLUSH_BUFFER_SIZE_REGULAR,
        flushBufferSizeCodeBlock: DISCORD_STREAMING_CONSTANTS.FLUSH_BUFFER_SIZE_CODE_BLOCK,
        inactivityTimeoutMs: DISCORD_STREAMING_CONSTANTS.INACTIVITY_TIMEOUT_MS,
        baseTypeSpeedMsPerChar: DISCORD_STREAMING_CONSTANTS.BASE_TYPE_SPEED_MS_PER_CHAR,
        maxTypingTimeMs: DISCORD_STREAMING_CONSTANTS.MAX_TYPING_TIME_MS,
        minVisibleTypingDurationMs: DISCORD_STREAMING_CONSTANTS.MIN_VISIBLE_TYPING_DURATION_MS,
        humanizerDegree: tomoriState.config.humanizer_degree,
        emojiUsageEnabled: tomoriState.config.emoji_usage_enabled,
      };

      if (streamingContext) {
        log.info("NovelAIProvider: Reloading tools with streaming context for context-aware availability");
        const contextAwareTools = await this.getTools(tomoriState, streamingContext);
        streamConfig.tools = contextAwareTools;
      }

      const streamContext: StreamContext = buildStreamContext({
        provider: "novelai",
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
      const novelaiAdapter = new NovelaiStreamAdapter();

      log.info("NovelAIProvider: Delegating to StreamOrchestrator with NovelAIStreamAdapter");
      const result = await orchestrator.streamToDiscord(novelaiAdapter, streamConfig, streamContext);

      log.info(`NovelAIProvider: Streaming completed with status: ${result.status}`);

      // For GLM-4.6 empty responses: attach the incomplete trailing sentence so
      // tomoriChat can use it as a prompt continuation on the retry, instead of
      // starting a fresh generation that produces the same truncated output.
      const pendingPrefill = novelaiAdapter.getPendingContinuationPrefill();
      if (result.status === "empty_response" && pendingPrefill) {
        log.info(`NovelAIProvider: Attaching continuation prefill to StreamResult (${pendingPrefill.length} chars)`);
        return { ...result, naiContinuationPrefill: pendingPrefill };
      }
      return result;
    } catch (error) {
      log.error(
        `NovelAIProvider streaming error for server ${tomoriState.server_id}, model ${config.model}, channel ${channel.id}`,
        error as Error,
      );

      return {
        status: "error",
        data: error as Error,
      };
    }
  }
}
