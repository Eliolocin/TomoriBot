import type { ZodType } from "zod";
import type { GoogleGenAI, HarmBlockThreshold, HarmCategory } from "@google/genai";
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
import { type ToolStateForContext, getAvailableToolsWithMCP } from "@/tools/toolRegistry";
import { applyStreamContextAvailability } from "@/tools/availability";
import type { StreamingContext } from "@/types/tool/interfaces";
import type { TomoriState } from "@/types/db/schema";
import type { StructuredContextItem } from "@/types/misc/context";
import { log } from "@/utils/misc/logger";
import { buildGoogleThinkingConfig } from "@/utils/provider/thinkingControl";
import {
  BaseLLMProvider,
  type ApiKeyValidationResult,
  type FunctionCall,
  type LLMProvider,
  type ProviderConfig,
  type StreamResult,
} from "@/types/provider/interfaces";
import type { ProviderError, StreamContext } from "@/types/stream/interfaces";
import { DISCORD_STREAMING_CONSTANTS } from "@/types/stream/types";
import type {
  CompactConversationResult,
  CompactRoleplayResult,
  PresetGenerationResult,
  ProviderCompactSummaryRequest,
  ProviderNativeImageGenerationRequest,
  ProviderNativeImageGenerationResult,
  ProviderPresetGenerationRequest,
  ProviderStructuredJsonRequest,
  StructuredOutputResult,
  SupportsConversationCompaction,
  SupportsNativeImageGeneration,
  SupportsPresetGeneration,
  SupportsStructuredOutput,
} from "@/types/provider/featureInterfaces";
import { getCachedDefaultLLM, isLLMCacheReady } from "@/utils/cache/llmCache";
import { llmModelRepo } from "@/utils/db/repositories";
import { callGoogleStructuredJSON } from "@/providers/google/googleStructuredOutput";
import { generateConversationSummaryGoogle, generateRoleplaySummaryGoogle } from "@/providers/google/compactGenerator";
import { generatePresetFromPrompt } from "@/providers/google/presetGenerator";
import { validateGoogleModelsEndpoint } from "@/providers/google/googleCredentialValidation";
import { getActiveTemperature, isParamDisabled } from "@/utils/provider/samplingControl";
import type { VertexStreamConfig } from "@/providers/vertex/vertexStreamAdapter";
import { createVertexexpressClient } from "@/providers/vertexexpress/vertexexpressClient";
import { vertexexpressProviderInfo } from "@/providers/vertexexpress/providerInfo";
import { VertexexpressStreamAdapter } from "@/providers/vertexexpress/vertexexpressStreamAdapter";
import { getVertexexpressToolAdapter } from "@/providers/vertexexpress/vertexexpressToolAdapter";
import { applyDeliberateToolAllowlist } from "@/utils/tools/deliberateToolMode";
import { resolveToolsEnabled } from "@/utils/tools/toolUseGate";

async function getDefaultVertexexpressModel(): Promise<string> {
  const providerName = "vertexexpress";

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

export interface VertexexpressProviderConfig extends ProviderConfig {
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
  };
}

export class VertexexpressProvider
  extends BaseLLMProvider
  implements
    LLMProvider,
    SupportsStructuredOutput,
    SupportsPresetGeneration,
    SupportsConversationCompaction,
    SupportsNativeImageGeneration
{
  getInfo() {
    return vertexexpressProviderInfo;
  }

  private buildClient(apiKey: string): GoogleGenAI {
    return createVertexexpressClient(apiKey);
  }

  async validateApiKey(apiKey: string): Promise<ApiKeyValidationResult> {
    if (!apiKey || apiKey.trim().length < 10) {
      log.warn("Vertex AI Express API key is too short or empty");
      const adapter = new VertexexpressStreamAdapter();
      const error = new Error("API key is too short or empty");
      const providerError = adapter.handleProviderError(error);
      return { valid: false, error: providerError };
    }

    try {
      log.info("Validating Vertex AI Express API key...");

      const genAI = this.buildClient(apiKey);
      await validateGoogleModelsEndpoint(genAI);

      log.success("Vertex AI Express API key validation successful via models endpoint");
      return { valid: true };
    } catch (error) {
      const adapter = new VertexexpressStreamAdapter();
      const providerError = adapter.handleProviderError(error);

      await log.error("Vertex AI Express configuration validation failed", error, {
        errorType: "APIKeyValidationError",
        metadata: {
          provider: "vertexexpress",
          errorCode: providerError.code,
          errorType: providerError.type,
        },
      });
      return { valid: false, error: providerError };
    }
  }

  formatErrorDescription(error: ProviderError, locale: string): string | null {
    const adapter = new VertexexpressStreamAdapter();
    return adapter.createErrorDescription(error, locale);
  }

  getExpressionInitializationBatchSize(): number {
    return 30;
  }

  async callStructuredJSON<T>(
    request: ProviderStructuredJsonRequest,
    responseSchema: Record<string, unknown>,
    zodSchema: ZodType<T>,
  ): Promise<StructuredOutputResult<T>> {
    const client = this.buildClient(request.apiKey);
    return await callGoogleStructuredJSON(request, responseSchema, zodSchema, client);
  }

  async generatePreset(request: ProviderPresetGenerationRequest): Promise<PresetGenerationResult> {
    const client = this.buildClient(request.apiKey);
    const defaultSearchModelName = request.params.useWebSearch ? await this.getDefaultModel() : undefined;
    return await generatePresetFromPrompt(
      request.apiKey,
      {
        ...request.params,
        modelName: request.tomoriState.llm.llm_codename,
      },
      request.locale,
      client,
      defaultSearchModelName,
    );
  }

  async generateConversationSummary(request: ProviderCompactSummaryRequest): Promise<CompactConversationResult> {
    const client = this.buildClient(request.apiKey);
    return await generateConversationSummaryGoogle(request, client);
  }

  async generateRoleplaySummary(request: ProviderCompactSummaryRequest): Promise<CompactRoleplayResult> {
    const client = this.buildClient(request.apiKey);
    return await generateRoleplaySummaryGoogle(request, client);
  }

  async generateNativeImage(
    request: ProviderNativeImageGenerationRequest,
  ): Promise<ProviderNativeImageGenerationResult> {
    const genAI = this.buildClient(request.apiKey);
    const chat = genAI.chats.create({
      model: request.model,
    });

    // Build parts: reference images (as inlineData) followed by the text prompt.
    // SendMessageParameters.message is PartListUnion: inline images must be
    // passed as inlineData parts, not via a non-existent "media" field.
    const messageParts: Array<{ inlineData: { mimeType: string; data: string } } | string> = [
      ...(request.referenceImages ?? []).map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data } })),
      request.prompt,
    ];

    const response = await chat.sendMessage({
      message: messageParts,
      config: {
        responseModalities: ["IMAGE"],
        imageConfig: {
          aspectRatio: request.aspectRatio,
        },
      },
    });
    if (response?.candidates && response.candidates.length > 0 && response.candidates[0]?.content?.parts) {
      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData?.data) {
          return {
            imageData: part.inlineData.data,
            mimeType: part.inlineData.mimeType ?? null,
          };
        }
      }
    }

    return {
      imageData: null,
      mimeType: null,
    };
  }

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
      } = await getAvailableToolsWithMCP("vertexexpress", toolStateForContext);

      let finalBuiltInTools = applyStreamContextAvailability({
        providerLabel: "Vertex AI Express provider",
        provider: "vertexexpress",
        builtInTools: availableBuiltInTools,
        streamContext: streamingContext,
        tomoriState,
      });
      let finalMcpFunctionNames = availableMcpFunctionNames;

      ({ builtInTools: finalBuiltInTools, mcpFunctionNames: finalMcpFunctionNames } = applyDeliberateToolAllowlist({
        providerLabel: "Vertex AI Express provider",
        builtInTools: finalBuiltInTools,
        mcpFunctionNames: finalMcpFunctionNames,
        allowedToolNames: streamingContext?.deliberateToolAllowedNames,
      }));

      const adapter = getVertexexpressToolAdapter();
      const allToolsConfig = await adapter.getAllToolsInProviderFormat(
        finalBuiltInTools,
        tomoriState.server_id,
        finalMcpFunctionNames,
      );

      log.info(
        `Vertex AI Express provider tools loaded: ${finalBuiltInTools.length} built-in + ${finalMcpFunctionNames.length} MCP = ${totalCount} total tools`,
      );

      return allToolsConfig;
    } catch (error) {
      log.error(`Failed to get tools for Vertex AI Express provider: ${tomoriState.llm.llm_codename}`, error as Error);
      return [];
    }
  }

  async getDefaultModel(): Promise<string> {
    return await getDefaultVertexexpressModel();
  }

  async createConfig(tomoriState: TomoriState, apiKey: string): Promise<VertexexpressProviderConfig> {
    const maxOutputTokens =
      tomoriState.config.llm_max_output_tokens ?? Number.parseInt(process.env.GOOGLE_MAX_OUTPUT_TOKENS || "8192", 10);
    const disabledParams = tomoriState.config.llm_disabled_params ?? [];
    const temperature = getActiveTemperature(tomoriState.config);
    const topKDisabled = isParamDisabled(disabledParams, "topK");
    const topPDisabled = isParamDisabled(disabledParams, "topP");

    const config: VertexexpressProviderConfig = {
      model: tomoriState.llm.llm_codename,
      apiKey,
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
        ...(!topKDisabled &&
          tomoriState.config.llm_top_k > 0 && {
            topK: tomoriState.config.llm_top_k,
          }),
        ...(!topPDisabled &&
          tomoriState.config.llm_top_p < 1.0 && {
            topP: tomoriState.config.llm_top_p,
          }),
        maxOutputTokens,
        stopSequences: [],
      },
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
    log.info(
      `VertexexpressProvider: Starting modular streaming for server ${tomoriState.server_id}, model ${config.model}`,
    );

    try {
      const vertexexpressConfig = config as VertexexpressProviderConfig;

      const safetySettings = vertexexpressConfig.safetySettings || [
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
      ];

      const streamConfig: VertexStreamConfig = {
        ...vertexexpressConfig,
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
        log.info(`VertexexpressProvider: Applied thinking config for model ${config.model}`);
      }

      if (streamingContext && resolveToolsEnabled(tomoriState, tomoriState.llm.has_tools)) {
        log.info("VertexexpressProvider: Reloading tools with streaming context for context-aware availability");
        const contextAwareTools = await this.getTools(tomoriState, streamingContext);
        streamConfig.tools = contextAwareTools;
      } else if (streamingContext && !resolveToolsEnabled(tomoriState, tomoriState.llm.has_tools)) {
        log.info("VertexexpressProvider: Skipping context-aware tool reload - model doesn't support tools");
      }

      const streamContext: StreamContext = buildStreamContext({
        provider: "vertexexpress",
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
      const adapter = new VertexexpressStreamAdapter();

      log.info("VertexexpressProvider: Delegating to StreamOrchestrator with VertexexpressStreamAdapter");
      const result = await orchestrator.streamToDiscord(adapter, streamConfig, streamContext);

      log.info(
        `VertexexpressProvider: Modular streaming completed with status: ${result.status}${result.status === "stopped_by_user" && result.stopReason ? ` (reason: ${result.stopReason})` : ""}`,
      );
      return result;
    } catch (error) {
      log.error(
        `VertexexpressProvider modular streaming error for server ${tomoriState.server_id}, model ${config.model}, channel ${channel.id}`,
        error as Error,
      );

      return {
        status: "error",
        data: error as Error,
      };
    }
  }
}
