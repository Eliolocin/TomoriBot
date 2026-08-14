/**
 * Custom provider implementation for self-hosted OpenAI-compatible endpoints
 *
 * This provider allows self-hosted TomoriBot users to connect to any OpenAI-compatible
 * endpoint such as Ollama, KoboldCPP, vLLM, LocalAI, or OpenRouter proxies.
 *
 * Available in all environments. In production, endpoint URLs are validated via
 * validateRemoteUrl() which blocks localhost, private IPs, and non-HTTPS URLs.
 *
 * Key differences from OpenRouter:
 * - Uses the server model config custom endpoint URL
 * - Model capabilities are user-declared (stored in llms table row)
 * - API key field may contain endpoint URL or actual auth token
 * - validateApiKey() performs health check rather than strict key validation
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
import type { ZodType } from "zod";
import {
  generateConversationSummaryCustom,
  generateRoleplaySummaryCustom,
} from "@/providers/custom/customCompactGenerator";
import { generatePresetFromPromptCustom } from "@/providers/custom/customPresetGenerator";
import { callCustomStructuredJSON } from "@/providers/custom/customStructuredOutput";
import { isBraveSearchAvailable } from "@/tools/restAPIs/brave/braveSearchService";
import { getMCPManager } from "@/utils/mcp/mcpManager";
import { getEffectiveLlmModelName } from "@/utils/provider/modelDisplay";
import { buildActiveSamplingParams, getActiveTemperature } from "@/utils/provider/samplingControl";
import { fetchUserRemoteUrl } from "@/utils/security/userRemoteFetch";
import { StreamOrchestrator } from "../../utils/discord/streamOrchestrator";
import { buildStreamContext } from "@/utils/provider/streamContext";
import { CustomStreamAdapter, type CustomStreamConfig } from "./customStreamAdapter";
import type { ProviderError, StreamContext } from "../../types/stream/interfaces";
import { DISCORD_STREAMING_CONSTANTS } from "../../types/stream/types";
import { type ToolStateForContext, getAvailableToolsWithMCP } from "../../tools/toolRegistry";
import { applyStreamContextAvailability } from "@/tools/availability";
import type { StreamingContext, ToolContext } from "../../types/tool/interfaces";
import type { TomoriState } from "../../types/db/schema";
import type { StructuredContextItem } from "../../types/misc/context";
import { log } from "../../utils/misc/logger";
import type {
  CompactConversationResult,
  CompactRoleplayResult,
  EmbeddingRequest,
  ProviderNativeImageGenerationRequest,
  ProviderNativeImageGenerationResult,
  ProviderNativeVideoGenerationRequest,
  ProviderNativeVideoGenerationResult,
  PresetGenerationResult,
  ProviderCompactSummaryRequest,
  ProviderPresetGenerationRequest,
  ProviderStructuredJsonRequest,
  StructuredOutputResult,
  SupportsEmbeddings,
  SupportsConversationCompaction,
  SupportsNativeImageGeneration,
  SupportsNativeVideoGeneration,
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
  type FunctionResponseImageMetadata,
  type ApiKeyValidationResult,
} from "../../types/provider/interfaces";
import { getCustomToolAdapter } from "./customToolAdapter";
import { customProviderInfo } from "./providerInfo";
import { resolveCustomEndpointForProvider } from "@/utils/provider/customEndpointService";
import { buildCustomHeaders } from "@/providers/custom/customOpenAICompatibleUtils";
import { applyDeliberateToolAllowlist } from "@/utils/tools/deliberateToolMode";

/**
 * Default model name placeholder for custom provider
 * Fallback codename when server-specific model isn't configured
 */
const DEFAULT_CUSTOM_MODEL = "custom/default";

/**
 * Custom provider configuration extending the base ProviderConfig
 */
export interface CustomProviderConfig extends ProviderConfig {
  /** Custom endpoint URL (e.g., http://localhost:11434/v1) */
  endpointUrl: string;
  /** Whether the model supports image inputs (user-declared) */
  seesImages?: boolean;
  /** Whether the model supports video inputs (user-declared) */
  seesVideos?: boolean;
  /** Sampling parameters */
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  repetitionPenalty?: number;
  /** Optional context window override sent as options.num_ctx (Ollama extension) */
  numCtx?: number | null;
}

/**
 * Custom provider implementation for self-hosted OpenAI-compatible endpoints
 */
export class CustomProvider
  extends BaseLLMProvider
  implements
    LLMProvider,
    SupportsStructuredOutput,
    SupportsConversationCompaction,
    SupportsPresetGeneration,
    SupportsEmbeddings,
    SupportsNativeImageGeneration,
    SupportsNativeVideoGeneration
{
  /**
   * Get provider information and capabilities
   */
  getInfo(): ProviderInfo {
    return customProviderInfo;
  }

  /**
   * Validate the custom endpoint by performing a health check
   *
   * Unlike other providers, we don't strictly validate an API key.
   * Instead, we attempt a basic health check on the endpoint.
   * We warn on failure but allow usage since some endpoints may not
   * have a standard health check endpoint.
   *
   * @param apiKey - May contain endpoint URL or actual auth token
   */
  async validateApiKey(_apiKey: string): Promise<ApiKeyValidationResult> {
    // For custom provider, we're lenient - always return valid
    // The actual validation happens when we try to use the endpoint
    log.info("Custom provider: Skipping strict API key validation (endpoint health checked on first use)");
    return { valid: true };
  }

  formatErrorDescription(error: ProviderError, locale: string): string | null {
    const customAdapter = new CustomStreamAdapter();
    return customAdapter.createErrorDescription(error, locale);
  }

  supportsEmbeddingTaskType(): boolean {
    return false;
  }

  async generateEmbeddings(request: EmbeddingRequest): Promise<number[][]> {
    const customEndpoint = await resolveCustomEndpointForProvider(request.provider, "embedding", request.modelId);
    const endpointUrl = customEndpoint?.endpoint_url ?? null;
    const modelName = customEndpoint?.model_name ?? request.model;

    if (!endpointUrl) {
      throw new Error("Custom embedding endpoint is not configured.");
    }

    const response = await fetchUserRemoteUrl(`${endpointUrl.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: buildCustomHeaders(request.apiKey),
      body: JSON.stringify({
        model: modelName,
        input: request.inputs,
      }),
    });

    if (!response.ok) {
      throw new Error(`Custom embedding request failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };

    return payload.data?.map((row) => row.embedding ?? []) ?? [];
  }

  async generateNativeImage(
    _request: ProviderNativeImageGenerationRequest,
  ): Promise<ProviderNativeImageGenerationResult> {
    throw new Error("Custom native image generation is routed through the custom endpoint dispatcher.");
  }

  async generateNativeVideo(
    _request: ProviderNativeVideoGenerationRequest,
  ): Promise<ProviderNativeVideoGenerationResult> {
    throw new Error("Custom native video generation is routed through the custom endpoint dispatcher.");
  }

  /**
   * Get available tools/functions based on Tomori's configuration
   * Uses the tool adapter that handles both built-in and MCP tools
   *
   * @param streamingContext - Optional streaming context for context-aware tool availability
   */
  async getTools(
    tomoriState: TomoriState,
    streamingContext?: StreamingContext,
  ): Promise<Array<Record<string, unknown>>> {
    // Only return tools if the model supports them (user-declared capability)
    if (!tomoriState.llm.has_tools) {
      log.info("Custom provider: Model does not support tools (user-declared capability)");
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
      } = await getAvailableToolsWithMCP("custom", toolStateForContext);

      let finalBuiltInTools = applyStreamContextAvailability({
        providerLabel: "Custom provider",
        provider: "custom",
        builtInTools: availableBuiltInTools,
        streamContext: streamingContext,
        tomoriState,
      });
      let finalMcpFunctionNames = availableMcpFunctionNames;

      ({ builtInTools: finalBuiltInTools, mcpFunctionNames: finalMcpFunctionNames } = applyDeliberateToolAllowlist({
        providerLabel: "Custom provider",
        builtInTools: finalBuiltInTools,
        mcpFunctionNames: finalMcpFunctionNames,
        allowedToolNames: streamingContext?.deliberateToolAllowedNames,
      }));

      const customAdapter = getCustomToolAdapter();
      const allToolsConfig = await customAdapter.getAllToolsInOpenAIFormat(
        finalBuiltInTools,
        tomoriState.server_id,
        finalMcpFunctionNames,
      );

      log.info(
        `Custom provider tools loaded: ${finalBuiltInTools.length} built-in + ${finalMcpFunctionNames.length} MCP = ${totalCount} total tools`,
      );

      return allToolsConfig;
    } catch (error) {
      log.error(`Failed to get tools for custom provider: ${tomoriState.llm.llm_codename}`, error as Error);
      return [];
    }
  }

  /**
   * Returns the placeholder since custom models are user-defined
   *
   * @returns Promise<string> - The default model placeholder
   */
  async getDefaultModel(): Promise<string> {
    return DEFAULT_CUSTOM_MODEL;
  }

  getExpressionInitializationBatchSize(): number {
    const parsed = Number.parseInt(process.env.CUSTOM_EXPRESSION_BATCH_SIZE || "20", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
  }

  async callStructuredJSON<T>(
    request: ProviderStructuredJsonRequest,
    responseSchema: Record<string, unknown>,
    zodSchema: ZodType<T>,
  ): Promise<StructuredOutputResult<T>> {
    return await callCustomStructuredJSON(request, responseSchema, zodSchema);
  }

  async generateConversationSummary(request: ProviderCompactSummaryRequest): Promise<CompactConversationResult> {
    return await generateConversationSummaryCustom(request);
  }

  async generateRoleplaySummary(request: ProviderCompactSummaryRequest): Promise<CompactRoleplayResult> {
    return await generateRoleplaySummaryCustom(request);
  }

  private async getPresetGenerationTools(
    request: ProviderPresetGenerationRequest,
  ): Promise<Array<Record<string, unknown>> | undefined> {
    if (!request.params.useWebSearch) {
      return undefined;
    }

    if (!request.toolContext) {
      log.warn("Custom preset generation skipped search tools: no tool context available.");
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

    const { builtInTools, mcpFunctionNames } = await getAvailableToolsWithMCP("custom", toolStateForContext);

    const searchTools = builtInTools.filter(
      (tool) => tool.category === "search" || tool.requiresFeatureFlag === "web_search",
    );

    const customAdapter = getCustomToolAdapter();
    return await customAdapter.getAllToolsInOpenAIFormat(searchTools, request.tomoriState.server_id, mcpFunctionNames);
  }

  async generatePreset(request: ProviderPresetGenerationRequest): Promise<PresetGenerationResult> {
    const endpointUrl = request.tomoriState.config.custom_endpoint_url;
    if (!endpointUrl) {
      return {
        error: "Custom endpoint URL is not configured. Please register the custom endpoint again.",
        errorType: "MODEL_ERROR",
      };
    }

    const tools = await this.getPresetGenerationTools(request);
    const modelName = getEffectiveLlmModelName(request.tomoriState.llm, request.tomoriState.config.custom_model_name);

    return await generatePresetFromPromptCustom(request.apiKey, request.params, request.locale, {
      endpointUrl,
      model: modelName,
      temperature: getActiveTemperature(request.tomoriState.config),
      tools,
      toolContext: request.toolContext as ToolContext | undefined,
      maxToolRounds: request.maxToolRounds,
    });
  }

  /**
   * Convert provider-specific configuration from TomoriState
   *
   * @param apiKey - The decrypted API key (may be endpoint URL or auth token)
   */
  async createConfig(tomoriState: TomoriState, apiKey: string): Promise<CustomProviderConfig> {
    // Get endpoint URL: prefer the server model config mirror (populated when the active text model
    // is a custom one). The mirror can be NULL when a persona override points at a custom LLM while
    // the global text model is non-custom. In that case fall back to the custom_endpoints table.
    let endpointUrl = tomoriState.config.custom_endpoint_url ?? null;
    let endpointModelNameHint: string | null = null;
    let endpointNumCtxHint: number | null = null;
    if (!endpointUrl) {
      // Pass the active model id so the correct endpoint is chosen when the label hosts several
      // text models; falls back to the label default when unset (legacy rows / single model).
      const textEndpoint = await resolveCustomEndpointForProvider(
        tomoriState.llm.llm_provider.toLowerCase(),
        "text",
        tomoriState.llm.llm_id,
      );
      endpointUrl = textEndpoint?.endpoint_url ?? null;
      endpointModelNameHint = textEndpoint?.model_name ?? null;
      endpointNumCtxHint = textEndpoint?.num_ctx ?? null;
    }

    if (!endpointUrl) {
      throw new Error(
        "Custom endpoint URL not configured. Register it with /provider custom-endpoint add or /personal custom-endpoint add, then select it again.",
      );
    }

    // Determine which model name to use:
    // If custom_model_name is set, use it (for Ollama, etc. that require exact model names)
    // Fall back to the endpoint's registered model_name hint (set during /provider custom-endpoint add)
    // Last resort: llm_codename (for KoboldCpp, etc. that don't care about model selection)
    const modelName = tomoriState.config.custom_model_name || endpointModelNameHint || tomoriState.llm.llm_codename;

    log.info(`Custom provider: Using endpoint URL: ${endpointUrl}`);
    log.info(
      `Custom provider: Model name: ${modelName}${tomoriState.config.custom_model_name ? " (custom)" : " (default)"}`,
    );
    log.info(`Custom provider: has_tools: ${tomoriState.llm.has_tools}`);
    log.info(`Custom provider: sees_images: ${tomoriState.llm.sees_images}`);
    log.info(`Custom provider: sees_videos: ${tomoriState.llm.sees_videos}`);
    log.info(`Custom provider: supports_structoutput: ${tomoriState.llm.supports_structoutput}`);

    const samplingParams = buildActiveSamplingParams(tomoriState.config);
    const config: CustomProviderConfig = {
      model: modelName, // Use custom_model_name if set, otherwise llm_codename
      apiKey: apiKey, // May be used for Bearer auth if endpoint requires it
      temperature: tomoriState.config.llm_temperature,
      disabledParams: tomoriState.config.llm_disabled_params ?? [],
      maxOutputTokens: tomoriState.config.llm_max_output_tokens ?? 4096,
      endpointUrl: endpointUrl,
      seesImages: tomoriState.llm.sees_images,
      seesVideos: tomoriState.llm.sees_videos,
      ...samplingParams,
      repetitionPenalty: 1.1,
      numCtx: tomoriState.config.custom_num_ctx ?? endpointNumCtxHint ?? null,
    };

    if (tomoriState.llm.has_tools) {
      config.tools = await this.getTools(tomoriState);
    }

    return config;
  }

  /**
   * Stream LLM response directly to a Discord channel
   * Uses the modular streaming architecture with StreamOrchestrator and CustomStreamAdapter
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
      imageMetadata?: FunctionResponseImageMetadata;
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
    log.info(`CustomProvider: Starting streaming for server ${tomoriState.server_id}, model ${config.model}`);

    try {
      const customConfig = config as CustomProviderConfig;

      const streamConfig: CustomStreamConfig = {
        ...customConfig,
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

      if (streamingContext && tomoriState.llm.has_tools) {
        log.info("CustomProvider: Reloading tools with streaming context for context-aware availability");
        const contextAwareTools = await this.getTools(tomoriState, streamingContext);
        streamConfig.tools = contextAwareTools;
        log.info(`Context-aware tools loaded: ${contextAwareTools.length} tools`);
      } else if (streamingContext && !tomoriState.llm.has_tools) {
        log.info("Skipping context-aware tool reload - model doesn't support tools");
      }

      const streamContext: StreamContext = buildStreamContext({
        provider: "custom",
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
      const customAdapter = new CustomStreamAdapter();

      log.info("CustomProvider: Delegating to StreamOrchestrator with CustomStreamAdapter");
      const result = await orchestrator.streamToDiscord(customAdapter, streamConfig, streamContext);

      log.info(`CustomProvider: Streaming completed with status: ${result.status}`);
      return result;
    } catch (error) {
      log.error(
        `CustomProvider streaming error for server ${tomoriState.server_id}, model ${config.model}, channel ${channel.id}`,
        error as Error,
      );

      return {
        status: "error",
        data: error as Error,
      };
    }
  }
}
