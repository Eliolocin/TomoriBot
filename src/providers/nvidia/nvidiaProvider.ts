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
import { nvidiaProviderInfo } from "@/providers/nvidia/providerInfo";
import { NvidiaStreamAdapter, type NvidiaStreamConfig } from "@/providers/nvidia/nvidiaStreamAdapter";
import { getNvidiaToolAdapter } from "@/providers/nvidia/nvidiaToolAdapter";
import {
  NVIDIA_CHAT_COMPLETIONS_URL,
  NVIDIA_DEFAULT_EMBEDDING_MODEL,
  NVIDIA_DEFAULT_TEXT_MODEL,
  NVIDIA_EMBEDDINGS_URL,
  NVIDIA_MIN_P_UNSUPPORTED_MODELS,
  NVIDIA_MODELS_URL,
} from "@/providers/nvidia/nvidiaConstants";
import {
  createOpenAICompatibleHttpError,
  normalizeOpenAICompatibleProviderError,
} from "@/providers/openaiCompatible/openaiCompatibleErrorFormatter";
import { callNvidiaStructuredJSON } from "@/providers/nvidia/nvidiaStructuredOutput";
import { generateNvidiaNativeImage } from "@/providers/nvidia/nvidiaImageGeneration";
import { generateConversationSummaryNvidia, generateRoleplaySummaryNvidia } from "@/providers/nvidia/compactGenerator";
import { generatePresetFromPromptNvidia } from "@/providers/nvidia/presetGenerator";
import { isBraveSearchAvailable } from "@/tools/restAPIs/brave/braveSearchService";
import { getMCPManager } from "@/utils/mcp/mcpManager";
import { buildActiveSamplingParams, getActiveTemperature } from "@/utils/provider/samplingControl";
import type { TomoriState } from "@/types/db/schema";
import type { StructuredContextItem } from "@/types/misc/context";
import type {
  CompactConversationResult,
  CompactRoleplayResult,
  EmbeddingRequest,
  PresetGenerationResult,
  ProviderCompactSummaryRequest,
  ProviderNativeImageGenerationRequest,
  ProviderNativeImageGenerationResult,
  ProviderPresetGenerationRequest,
  ProviderStructuredJsonRequest,
  StructuredOutputResult,
  SupportsConversationCompaction,
  SupportsEmbeddings,
  SupportsNativeImageGeneration,
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
import { getCachedDefaultLLM, isLLMCacheReady } from "@/utils/cache/llmCache";
import { llmModelRepo } from "@/utils/db/repositories";
import { log } from "@/utils/misc/logger";
import { buildRuntimeLogitBiasMapForLlm } from "@/utils/provider/logitBiasResolver";
import { applyDeliberateToolAllowlist } from "@/utils/tools/deliberateToolMode";
import { resolveToolsEnabled } from "@/utils/tools/toolUseGate";

async function getDefaultNvidiaModel(): Promise<string> {
  const providerName = "nvidia";

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

  return NVIDIA_DEFAULT_TEXT_MODEL;
}

function extractNvidiaEmbeddings(response: unknown): number[][] {
  const raw = response as {
    data?: Array<{ embedding?: number[] }>;
    embeddings?: Array<{ embedding?: number[]; values?: number[] } | number[]>;
    embedding?: { values?: number[] } | number[];
  };

  if (Array.isArray(raw?.data)) {
    return raw.data
      .map((entry) => (Array.isArray(entry.embedding) ? entry.embedding : []))
      .filter((values) => values.length > 0);
  }

  if (Array.isArray(raw?.embeddings)) {
    return raw.embeddings
      .map((entry) => {
        if (Array.isArray(entry)) {
          return entry;
        }
        if (entry && Array.isArray(entry.embedding)) {
          return entry.embedding;
        }
        if (entry && Array.isArray(entry.values)) {
          return entry.values;
        }
        return [];
      })
      .filter((values) => values.length > 0);
  }

  if (Array.isArray(raw?.embedding)) {
    return [raw.embedding];
  }

  if (raw?.embedding && Array.isArray(raw.embedding.values)) {
    return [raw.embedding.values];
  }

  return [];
}

export interface NvidiaProviderConfig extends ProviderConfig {
  endpointUrl: string;
  seesImages?: boolean;
  seesVideos?: boolean;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  minP?: number;
}

export class NvidiaProvider
  extends BaseLLMProvider
  implements
    LLMProvider,
    SupportsEmbeddings,
    SupportsStructuredOutput,
    SupportsNativeImageGeneration,
    SupportsConversationCompaction,
    SupportsPresetGeneration
{
  getInfo(): ProviderInfo {
    return nvidiaProviderInfo;
  }

  async validateApiKey(apiKey: string): Promise<ApiKeyValidationResult> {
    try {
      // Use the models list endpoint: no model needed, no tokens consumed
      const response = await fetch(NVIDIA_MODELS_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      if (!response.ok) {
        throw createOpenAICompatibleHttpError(response.status, response.statusText, await response.text());
      }

      return { valid: true };
    } catch (error) {
      log.error("NVIDIA API key validation failed", error as Error);
      return {
        valid: false,
        error: normalizeOpenAICompatibleProviderError(error, {
          errorMessagePrefix: "NVIDIA API error",
        }),
      };
    }
  }

  formatErrorDescription(error: ProviderError, locale: string): string | null {
    const adapter = new NvidiaStreamAdapter();
    return adapter.createErrorDescription(error, locale);
  }

  supportsEmbeddingTaskType(): boolean {
    return false;
  }

  async generateEmbeddings(request: EmbeddingRequest): Promise<number[][]> {
    if (request.inputs.length === 0) {
      return [];
    }

    const response = await fetch(NVIDIA_EMBEDDINGS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: request.model || NVIDIA_DEFAULT_EMBEDDING_MODEL,
        input: request.inputs,
      }),
    });

    if (!response.ok) {
      throw createOpenAICompatibleHttpError(response.status, response.statusText, await response.text());
    }

    return extractNvidiaEmbeddings(await response.json());
  }

  async callStructuredJSON<T>(
    request: ProviderStructuredJsonRequest,
    responseSchema: Record<string, unknown>,
    zodSchema: ZodType<T>,
  ): Promise<StructuredOutputResult<T>> {
    return await callNvidiaStructuredJSON(request, responseSchema, zodSchema);
  }

  async generateNativeImage(
    request: ProviderNativeImageGenerationRequest,
  ): Promise<ProviderNativeImageGenerationResult> {
    return await generateNvidiaNativeImage(request);
  }

  async getTools(
    tomoriState: TomoriState,
    streamingContext?: StreamingContext,
  ): Promise<Array<Record<string, unknown>>> {
    if (!resolveToolsEnabled(tomoriState, tomoriState.llm.has_tools)) {
      log.info(
        `NVIDIA provider: Tools unavailable (tool_use_enabled=${tomoriState.config.tool_use_enabled}, has_tools=${tomoriState.llm.has_tools})`,
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
      } = await getAvailableToolsWithMCP("nvidia", toolStateForContext);

      let finalBuiltInTools = applyStreamContextAvailability({
        providerLabel: "NVIDIA provider",
        provider: "nvidia",
        builtInTools: availableBuiltInTools,
        streamContext: streamingContext,
        tomoriState,
      });
      let finalMcpFunctionNames = availableMcpFunctionNames;

      ({ builtInTools: finalBuiltInTools, mcpFunctionNames: finalMcpFunctionNames } = applyDeliberateToolAllowlist({
        providerLabel: "NVIDIA provider",
        builtInTools: finalBuiltInTools,
        mcpFunctionNames: finalMcpFunctionNames,
        allowedToolNames: streamingContext?.deliberateToolAllowedNames,
      }));

      const adapter = getNvidiaToolAdapter();
      const allToolsConfig = await adapter.getAllToolsInOpenAICompatibleFormat(
        finalBuiltInTools,
        tomoriState.server_id,
        finalMcpFunctionNames,
      );

      log.info(
        `NVIDIA provider tools loaded: ${finalBuiltInTools.length} built-in + ${finalMcpFunctionNames.length} MCP = ${totalCount} total tools`,
      );

      return allToolsConfig;
    } catch (error) {
      log.error(`Failed to get tools for NVIDIA provider: ${tomoriState.llm.llm_codename}`, error as Error);
      return [];
    }
  }

  async getDefaultModel(): Promise<string> {
    return await getDefaultNvidiaModel();
  }

  async createConfig(tomoriState: TomoriState, apiKey: string): Promise<NvidiaProviderConfig> {
    const samplingParams = buildActiveSamplingParams(tomoriState.config);
    if (NVIDIA_MIN_P_UNSUPPORTED_MODELS.has(tomoriState.llm.llm_codename)) {
      delete samplingParams.minP;
    }

    const config: NvidiaProviderConfig = {
      model: tomoriState.llm.llm_codename,
      apiKey,
      temperature: tomoriState.config.llm_temperature,
      disabledParams: tomoriState.config.llm_disabled_params ?? [],
      maxOutputTokens: tomoriState.config.llm_max_output_tokens ?? 4096,
      endpointUrl: NVIDIA_CHAT_COMPLETIONS_URL,
      seesImages: tomoriState.llm.sees_images,
      seesVideos: tomoriState.llm.sees_videos,
      ...samplingParams,
    };

    const runtimeLogitBias = buildRuntimeLogitBiasMapForLlm(tomoriState.config.llm_logit_biases ?? [], tomoriState.llm);
    if (Object.keys(runtimeLogitBias).length > 0) {
      config.logitBias = runtimeLogitBias;
    }

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
    log.info(`NvidiaProvider: Starting streaming for server ${tomoriState.server_id}, model ${config.model}`);

    try {
      const nvidiaConfig = config as NvidiaProviderConfig;
      const streamConfig: NvidiaStreamConfig = {
        ...nvidiaConfig,
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
        log.info("NvidiaProvider: Reloading tools with streaming context for context-aware availability");
        streamConfig.tools = await this.getTools(tomoriState, streamingContext);
      }

      const streamContext: StreamContext = buildStreamContext({
        provider: "nvidia",
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
      const adapter = new NvidiaStreamAdapter();
      const result = await orchestrator.streamToDiscord(adapter, streamConfig, streamContext);

      log.info(`NvidiaProvider: Streaming completed with status: ${result.status}`);
      return result;
    } catch (error) {
      log.error(
        `NvidiaProvider streaming error for server ${tomoriState.server_id}, model ${config.model}, channel ${channel.id}`,
        error as Error,
      );

      return {
        status: "error",
        data: error as Error,
      };
    }
  }

  /** Resolve web-search tools for preset generation, or undefined if not needed. */
  private async getPresetGenerationTools(
    request: ProviderPresetGenerationRequest,
  ): Promise<Array<Record<string, unknown>> | undefined> {
    if (!request.params.useWebSearch) {
      return undefined;
    }

    if (!request.toolContext) {
      log.warn("NVIDIA preset generation skipped search tools: no tool context available.");
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

    const { builtInTools, mcpFunctionNames } = await getAvailableToolsWithMCP("nvidia", toolStateForContext);

    const searchTools = builtInTools.filter(
      (tool) => tool.category === "search" || tool.requiresFeatureFlag === "web_search",
    );

    const adapter = getNvidiaToolAdapter();
    return await adapter.getAllToolsInOpenAICompatibleFormat(
      searchTools,
      request.tomoriState.server_id,
      mcpFunctionNames,
    );
  }

  async generatePreset(request: ProviderPresetGenerationRequest): Promise<PresetGenerationResult> {
    const tools = await this.getPresetGenerationTools(request);

    return await generatePresetFromPromptNvidia(request.apiKey, request.params, request.locale, {
      model: request.tomoriState.llm.llm_codename,
      temperature: getActiveTemperature(request.tomoriState.config),
      tools,
      toolContext: request.toolContext,
      maxToolRounds: request.maxToolRounds,
    });
  }

  async generateConversationSummary(request: ProviderCompactSummaryRequest): Promise<CompactConversationResult> {
    return await generateConversationSummaryNvidia(request);
  }

  async generateRoleplaySummary(request: ProviderCompactSummaryRequest): Promise<CompactRoleplayResult> {
    return await generateRoleplaySummaryNvidia(request);
  }
}
