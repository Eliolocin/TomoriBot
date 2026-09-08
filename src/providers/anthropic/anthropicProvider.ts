/**
 * Anthropic LLM provider implementation.
 *
 * Provides direct access to Claude models (claude-sonnet-4-6, claude-haiku-4-5,
 * claude-opus-4-6, claude-opus-4-7) via the Anthropic Messages API.
 *
 * Key differences from OpenAI-compatible providers:
 * - System prompt is a top-level parameter, not a message
 * - Messages use content blocks (text, image, tool_use, tool_result)
 * - Tool results are sent as user-role messages with tool_result content blocks
 * - Strict user/assistant alternation is enforced
 * - Extended thinking supported for reasoning models (Opus)
 * - API key sent via `x-api-key` header with `anthropic-version` header
 */

import type {
  AnyThreadChannel,
  BaseGuildTextChannel,
  BaseGuildVoiceChannel,
  Client,
  CommandInteraction,
  DMChannel,
  Message,
} from "discord.js";
import { StreamOrchestrator } from "@/utils/discord/streamOrchestrator";
import { buildStreamContext } from "@/utils/provider/streamContext";
import { anthropicProviderInfo } from "@/providers/anthropic/providerInfo";
import { AnthropicStreamAdapter, type AnthropicStreamConfig } from "@/providers/anthropic/anthropicStreamAdapter";
import { getAnthropicToolAdapter } from "@/providers/anthropic/anthropicToolAdapter";
import { callAnthropicStructuredJSON } from "@/providers/anthropic/anthropicStructuredOutput";
import {
  generateConversationSummaryAnthropic,
  generateRoleplaySummaryAnthropic,
} from "@/providers/anthropic/compactGenerator";
import { generatePresetFromPromptAnthropic } from "@/providers/anthropic/presetGenerator";
import { isBraveSearchAvailable } from "@/tools/restAPIs/brave/braveSearchService";
import { getMCPManager } from "@/utils/mcp/mcpManager";
import type { TomoriState } from "@/types/db/schema";
import type { StructuredContextItem } from "@/types/misc/context";
import type {
  CompactConversationResult,
  CompactRoleplayResult,
  PresetGenerationResult,
  ProviderCompactSummaryRequest,
  ProviderPresetGenerationRequest,
  ProviderStructuredJsonRequest,
  StructuredOutputResult,
  SupportsConversationCompaction,
  SupportsPresetGeneration,
  SupportsStructuredOutput,
} from "@/types/provider/featureInterfaces";
import type { ZodType } from "zod";
import type {
  ApiKeyValidationResult,
  FunctionCall,
  FunctionResponseImageMetadata,
  LLMProvider,
  ProviderConfig,
  ProviderInfo,
  StreamResult,
} from "@/types/provider/interfaces";
import { BaseLLMProvider } from "@/types/provider/interfaces";
import type { ProviderError, StreamContext } from "@/types/stream/interfaces";
import { DISCORD_STREAMING_CONSTANTS } from "@/types/stream/types";
import type { StreamingContext } from "@/types/tool/interfaces";
import { type ToolStateForContext, getAvailableToolsWithMCP } from "@/tools/toolRegistry";
import { applyStreamContextAvailability } from "@/tools/availability";
import { log } from "@/utils/misc/logger";
import { buildActiveSamplingParams, getActiveTemperature } from "@/utils/provider/samplingControl";
import { applyDeliberateToolAllowlist } from "@/utils/tools/deliberateToolMode";
import { resolveToolsEnabled } from "@/utils/tools/toolUseGate";

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";
const ANTHROPIC_MAX_OUTPUT_TOKENS = parseInt(process.env.ANTHROPIC_MAX_OUTPUT_TOKENS ?? "8192", 10);

/**
 * Configuration for Anthropic provider requests
 */
export interface AnthropicProviderConfig extends ProviderConfig {
  seesImages?: boolean;
  topP?: number;
  topK?: number;
}

export class AnthropicProvider
  extends BaseLLMProvider
  implements LLMProvider, SupportsStructuredOutput, SupportsConversationCompaction, SupportsPresetGeneration
{
  getInfo(): ProviderInfo {
    return anthropicProviderInfo;
  }

  /**
   * Validate an Anthropic API key by making a minimal Messages API request.
   */
  async validateApiKey(apiKey: string): Promise<ApiKeyValidationResult> {
    try {
      const response = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_API_VERSION,
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
          stream: false,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();

        // 401 = invalid key, 403 = permission denied
        if (response.status === 401 || response.status === 403) {
          log.info("Anthropic API key validation failed: invalid credentials");
          return {
            valid: false,
            error: {
              type: "api_error",
              message: `Authentication failed (${response.status}): ${errorText}`,
              retryable: false,
            },
          };
        }

        // Other errors (400, 429, etc.) mean the key is valid but something else went wrong
        log.info(`Anthropic API key validation: key accepted but got status ${response.status}`);
      }

      return { valid: true };
    } catch (error) {
      log.error("Anthropic API key validation failed", error as Error);
      return {
        valid: false,
        error: {
          type: "api_error",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        },
      };
    }
  }

  /**
   * Format a provider error for display in embeds.
   */
  formatErrorDescription(error: ProviderError, locale: string): string | null {
    const adapter = new AnthropicStreamAdapter();
    return adapter.createErrorDescription(error, locale);
  }

  /**
   * Call Anthropic with structured JSON output via forced tool use.
   */
  async callStructuredJSON<T>(
    request: ProviderStructuredJsonRequest,
    responseSchema: Record<string, unknown>,
    zodSchema: ZodType<T>,
  ): Promise<StructuredOutputResult<T>> {
    return await callAnthropicStructuredJSON(request, responseSchema, zodSchema);
  }

  getExpressionInitializationBatchSize(): number | null {
    return 50;
  }

  /**
   * Get available tools for the Anthropic provider in Anthropic format.
   */
  async getTools(
    tomoriState: TomoriState,
    streamingContext?: StreamingContext,
  ): Promise<Array<Record<string, unknown>>> {
    if (!resolveToolsEnabled(tomoriState, tomoriState.llm.has_tools)) {
      log.info(
        `Anthropic provider: Tools unavailable (tool_use_enabled=${tomoriState.config.tool_use_enabled}, has_tools=${tomoriState.llm.has_tools})`,
      );
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
      } = await getAvailableToolsWithMCP("anthropic", toolStateForContext);

      let finalBuiltInTools = applyStreamContextAvailability({
        providerLabel: "Anthropic provider",
        provider: "anthropic",
        builtInTools: availableBuiltInTools,
        streamContext: streamingContext,
        tomoriState,
      });
      let finalMcpFunctionNames = availableMcpFunctionNames;

      ({ builtInTools: finalBuiltInTools, mcpFunctionNames: finalMcpFunctionNames } = applyDeliberateToolAllowlist({
        providerLabel: "Anthropic provider",
        builtInTools: finalBuiltInTools,
        mcpFunctionNames: finalMcpFunctionNames,
        allowedToolNames: streamingContext?.deliberateToolAllowedNames,
      }));

      const adapter = getAnthropicToolAdapter();
      const allToolsConfig = await adapter.getAllToolsInProviderFormat(
        finalBuiltInTools,
        tomoriState.server_id,
        finalMcpFunctionNames,
      );

      log.info(
        `Anthropic provider tools loaded: ${finalBuiltInTools.length} built-in + ${finalMcpFunctionNames.length} MCP = ${totalCount} total tools`,
      );

      return allToolsConfig;
    } catch (error) {
      log.error(`Failed to get tools for Anthropic provider: ${tomoriState.llm.llm_codename}`, error as Error);
      return [];
    }
  }

  async getDefaultModel(): Promise<string> {
    return DEFAULT_ANTHROPIC_MODEL;
  }

  /**
   * Create provider-specific configuration from TomoriState.
   */
  async createConfig(tomoriState: TomoriState, apiKey: string): Promise<AnthropicProviderConfig> {
    const samplingParams = buildActiveSamplingParams(tomoriState.config);
    const config: AnthropicProviderConfig = {
      model: tomoriState.llm.llm_codename,
      apiKey,
      maxOutputTokens: tomoriState.config.llm_max_output_tokens ?? ANTHROPIC_MAX_OUTPUT_TOKENS,
      seesImages: tomoriState.llm.sees_images,
      temperature: tomoriState.config.llm_temperature,
      disabledParams: tomoriState.config.llm_disabled_params ?? [],
      ...samplingParams,
    };

    if (resolveToolsEnabled(tomoriState, tomoriState.llm.has_tools)) {
      config.tools = await this.getTools(tomoriState);
    }

    return config;
  }

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
      imageMetadata?: FunctionResponseImageMetadata;
      preToolCallTextParts?: Array<Record<string, unknown>>;
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
    log.info(`AnthropicProvider: Starting streaming for server ${tomoriState.server_id}, model ${config.model}`);

    try {
      const anthropicConfig = config as AnthropicProviderConfig;
      const streamConfig: AnthropicStreamConfig = {
        ...anthropicConfig,
        maxMessageLength: DISCORD_STREAMING_CONSTANTS.MAX_SINGLE_MESSAGE_LENGTH,
        flushBufferSize: DISCORD_STREAMING_CONSTANTS.FLUSH_BUFFER_SIZE_REGULAR,
        flushBufferSizeCodeBlock: DISCORD_STREAMING_CONSTANTS.FLUSH_BUFFER_SIZE_CODE_BLOCK,
        inactivityTimeoutMs: DISCORD_STREAMING_CONSTANTS.INACTIVITY_TIMEOUT_MS,
        baseTypeSpeedMsPerChar: DISCORD_STREAMING_CONSTANTS.BASE_TYPE_SPEED_MS_PER_CHAR,
        maxTypingTimeMs: DISCORD_STREAMING_CONSTANTS.MAX_TYPING_TIME_MS,
        minVisibleTypingDurationMs: DISCORD_STREAMING_CONSTANTS.MIN_VISIBLE_TYPING_DURATION_MS,
        humanizerDegree: tomoriState.config.humanizer_degree,
        emojiUsageEnabled: tomoriState.config.emoji_usage_enabled,
        seesImages: tomoriState.llm.sees_images,
        forceReason: streamingContext?.forceReason,
        isManuallyTriggered: streamingContext?.isManuallyTriggered,
      };

      if (streamingContext && resolveToolsEnabled(tomoriState, tomoriState.llm.has_tools)) {
        log.info("AnthropicProvider: Reloading tools with streaming context for context-aware availability");
        streamConfig.tools = await this.getTools(tomoriState, streamingContext);
      }

      const streamContext: StreamContext = buildStreamContext({
        provider: "anthropic",
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
      const adapter = new AnthropicStreamAdapter();
      const result = await orchestrator.streamToDiscord(adapter, streamConfig, streamContext);

      log.info(`AnthropicProvider: Streaming completed with status: ${result.status}`);
      return result;
    } catch (error) {
      log.error(
        `AnthropicProvider streaming error for server ${tomoriState.server_id}, model ${config.model}, channel ${channel.id}`,
        error as Error,
      );

      return {
        status: "error",
        data: error as Error,
      };
    }
  }

  /**
   * Resolve web-search tools for preset generation, or undefined if not needed.
   */
  private async getPresetGenerationTools(
    request: ProviderPresetGenerationRequest,
  ): Promise<Array<Record<string, unknown>> | undefined> {
    if (!request.params.useWebSearch) {
      return undefined;
    }

    if (!request.toolContext) {
      log.warn("Anthropic preset generation skipped search tools: no tool context available.");
      return undefined;
    }

    const hasBraveApiKey = await isBraveSearchAvailable(request.tomoriState.server_id);

    if (!hasBraveApiKey) {
      const mcpManager = getMCPManager();
      if (!mcpManager.isReady()) {
        await mcpManager.initializeMCPServers();
      }
    }

    const toolStateForContext: ToolStateForContext = {
      server_id: request.tomoriState.server_id.toString(),
      activePersonaHasElevenlabsVoice: Boolean(
        request.tomoriState.speech_voice_sample_id ||
          request.tomoriState.speech_voice_design_prompt?.trim() ||
          request.tomoriState.speech_voice_id?.trim(),
      ),
      activePersonaVoiceDesignPrompt: request.tomoriState.speech_voice_design_prompt?.trim() || null,
      activePersonaVoiceName: request.tomoriState.speech_voice_name,
      diffusion_model_id: request.tomoriState.config.diffusion_model_id,
      nai_diffusion_model_id: request.tomoriState.config.nai_diffusion_model_id,
      video_model_id: request.tomoriState.config.video_model_id,
      llm: {
        llm_codename: request.tomoriState.llm.llm_codename,
        has_tools: request.tomoriState.llm.has_tools,
        sees_images: request.tomoriState.llm.sees_images,
        sees_videos: request.tomoriState.llm.sees_videos,
        sees_youtube: request.tomoriState.llm.sees_youtube,
        supports_structoutput: request.tomoriState.llm.supports_structoutput,
      },
      config: {
        sticker_usage_enabled: false,
        web_search_enabled: true,
        self_teaching_enabled: false,
        manage_message_enabled: false,
        imagegen_enabled: false,
        videogen_enabled: false,
        voice_message_enabled: false,
        user_blocking_enabled: false,
        user_info_updates_enabled: false,
        thread_creation_enabled: false,
      },
    };

    const { builtInTools, mcpFunctionNames } = await getAvailableToolsWithMCP("anthropic", toolStateForContext);

    const searchTools = builtInTools.filter(
      (tool) => tool.category === "search" || tool.requiresFeatureFlag === "web_search",
    );

    const adapter = getAnthropicToolAdapter();
    return await adapter.getAllToolsInProviderFormat(searchTools, request.tomoriState.server_id, mcpFunctionNames);
  }

  /**
   * Generate a character preset using the Anthropic API.
   */
  async generatePreset(request: ProviderPresetGenerationRequest): Promise<PresetGenerationResult> {
    const tools = await this.getPresetGenerationTools(request);

    return await generatePresetFromPromptAnthropic(request.apiKey, request.params, request.locale, {
      model: request.tomoriState.llm.llm_codename,
      temperature: getActiveTemperature(request.tomoriState.config),
      tools,
      toolContext: request.toolContext,
      maxToolRounds: request.maxToolRounds,
    });
  }

  /**
   * Generate a plain-text conversation summary using the Anthropic API.
   */
  async generateConversationSummary(request: ProviderCompactSummaryRequest): Promise<CompactConversationResult> {
    return await generateConversationSummaryAnthropic(request);
  }

  /**
   * Generate a structured roleplay summary using the Anthropic API.
   */
  async generateRoleplaySummary(request: ProviderCompactSummaryRequest): Promise<CompactRoleplayResult> {
    return await generateRoleplaySummaryAnthropic(request);
  }
}
