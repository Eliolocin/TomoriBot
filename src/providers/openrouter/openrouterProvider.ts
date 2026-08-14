/**
 * OpenRouter provider implementation
 * Implements the LLMProvider interface for OpenRouter's multi-provider API
 *
 * Uses the modular streaming architecture with StreamOrchestrator
 * and OpenrouterStreamAdapter for better code organization and maintainability.
 */

import { OpenRouter } from "@openrouter/sdk";
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
import { buildStreamContext } from "@/utils/provider/streamContext";
import { DEFAULT_MAX_OUTPUT_TOKENS, resolveMaxOutputTokens } from "@/utils/provider/maxOutputTokens";
import { OpenrouterStreamAdapter, type OpenrouterStreamConfig } from "./openrouterStreamAdapter";
import { generateConversationSummaryOpenrouter, generateRoleplaySummaryOpenrouter } from "./compactGenerator";
import { generatePresetFromPromptOpenrouter } from "./presetGenerator";
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
  type FunctionResponseImageMetadata,
  type ApiKeyValidationResult,
} from "../../types/provider/interfaces";
import { getOpenrouterToolAdapter } from "./openrouterToolAdapter";
import { callOpenrouterStructuredJSON } from "./openrouterStructuredOutput";
import { getCachedDefaultLLM, isLLMCacheReady } from "../../utils/cache/llmCache";
import {
  getOpenRouterCapabilities,
  getOrFetchOpenRouterCapabilities,
  getOpenRouterTokenLimits,
  isOpenRouterCapabilityCacheReady,
} from "../../utils/cache/openrouterCapabilityCache";
import { configRepository, llmModelRepo } from "@/utils/db/repositories";
import { getMCPManager } from "../../utils/mcp/mcpManager";
import { isBraveSearchAvailable } from "../../tools/restAPIs/brave/braveSearchService";
import { openrouterProviderInfo } from "./providerInfo";
import { buildRuntimeLogitBiasMapForLlm } from "@/utils/provider/logitBiasResolver";
import { resolveEffectiveOpenRouterSeesYouTube } from "@/utils/provider/openrouterModelCapabilities";
import { buildOpenRouterAttributionHeaders } from "@/utils/provider/openrouterAttribution";
import { buildActiveSamplingParams, getActiveTemperature } from "@/utils/provider/samplingControl";
import { applyDeliberateToolAllowlist } from "@/utils/tools/deliberateToolMode";

/**
 * Gets the default OpenRouter model with a robust fallback chain:
 * 1. First checks the cached is_default LLM from the database
 * 2. Falls back to database query for is_default model if cache is not ready
 * 3. Falls back to first non-deprecated model from database
 * 4. Throws error if no models are available
 * @returns Promise<string> - The default model codename
 */
async function getDefaultOpenrouterModel(): Promise<string> {
  const providerName = "openrouter";

  // Try to get default from cache (fastest, no DB query)
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

function extractOpenRouterEmbeddings(response: unknown): number[][] {
  const raw = response as { data?: Array<{ embedding?: number[] }> };
  const data = Array.isArray(raw?.data) ? raw.data : [];
  return data
    .map((entry) => (Array.isArray(entry.embedding) ? entry.embedding : []))
    .filter((values) => values.length > 0);
}

// OpenRouter-specific configuration extending the base ProviderConfig
export interface OpenrouterProviderConfig extends ProviderConfig {
  // OpenRouter uses OpenAI-compatible API, simple configuration
  seesImages?: boolean; // Whether the model supports image inputs
  seesVideos?: boolean; // Whether the model supports video inputs
  topP?: number; // Nucleus sampling (0.0-1.0)
  topK?: number; // Top-k sampling
  frequencyPenalty?: number; // Penalize frequent tokens (-2.0 to 2.0)
  presencePenalty?: number; // Penalize repeated topics (-2.0 to 2.0)
  repetitionPenalty?: number; // Penalize token repetition (0.0-2.0)
  minP?: number; // Minimum probability threshold (0.0=disabled)
}

/**
 * OpenRouter provider implementation
 */
export class OpenrouterProvider
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
    return openrouterProviderInfo;
  }

  /**
   * Validate an OpenRouter API key using the dedicated auth endpoint
   * This method doesn't require a specific model and is more reliable than making a test chat request
   * @returns Promise<ApiKeyValidationResult> - Validation result with detailed error info if failed
   */
  async validateApiKey(apiKey: string): Promise<ApiKeyValidationResult> {
    if (!apiKey || apiKey.trim().length < 10) {
      log.warn("API key is too short or empty");
      const openrouterAdapter = new OpenrouterStreamAdapter();
      const error = new Error("API key is too short or empty");
      const providerError = openrouterAdapter.handleProviderError(error);
      return { valid: false, error: providerError };
    }

    try {
      log.info("Validating OpenRouter API key...");

      // Use OpenRouter's dedicated auth endpoint to validate the key
      // This is more reliable than making a test chat request because:
      // It doesn't depend on a specific model being available
      // It doesn't consume credits
      // It's faster and more accurate
      const response = await fetch("https://openrouter.ai/api/v1/auth/key", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...buildOpenRouterAttributionHeaders(),
        },
      });

      if (!response.ok) {
        log.warn(`API key validation failed with status ${response.status}: ${response.statusText}`);

        let errorMessage = response.statusText;
        try {
          const errorData = await response.json();
          if (errorData.error?.message) {
            errorMessage = errorData.error.message;
          }
        } catch {
          errorMessage = response.statusText;
        }

        let errorType: "api_error" | "rate_limit" | "timeout" = "api_error";
        let retryable = false;

        switch (response.status) {
          case 401:
          case 403:
            errorType = "api_error";
            retryable = false;
            break;
          case 429:
            errorType = "rate_limit";
            retryable = true;
            break;
          case 500:
          case 502:
          case 503:
            errorType = "api_error";
            retryable = true;
            break;
          case 504:
            errorType = "timeout";
            retryable = true;
            break;
          default:
            errorType = "api_error";
            retryable = false;
        }

        const providerError: import("../../types/stream/interfaces").ProviderError = {
          type: errorType,
          message: `OpenRouter auth error (${response.status}): ${errorMessage}`,
          code: response.status.toString(),
          retryable,
          originalError: new Error(errorMessage),
        };

        return { valid: false, error: providerError };
      }

      const data = await response.json();

      if (!data || typeof data !== "object") {
        log.warn("API key validation received invalid response structure");
        const providerError: import("../../types/stream/interfaces").ProviderError = {
          type: "api_error",
          message: "OpenRouter auth endpoint returned invalid data structure",
          code: "unknown",
          retryable: false,
          originalError: new Error("Invalid response structure"),
        };
        return { valid: false, error: providerError };
      }

      log.success("API key validation successful");
      return { valid: true };
    } catch (error) {
      // Network errors or other exceptions - use stream adapter for these
      // since they're not API-specific
      const openrouterAdapter = new OpenrouterStreamAdapter();
      const providerError = openrouterAdapter.handleProviderError(error);

      const isUserError = providerError.type === "api_error";

      if (!isUserError) {
        await log.error("API key validation failed", error, {
          errorType: "APIKeyValidationError",
          metadata: {
            provider: "openrouter",
            errorCode: providerError.code,
            errorType: providerError.type,
          },
        });
      } else {
        log.warn(`OpenRouter API key validation failed (user input error): ${providerError.message}`);
      }
      return { valid: false, error: providerError };
    }
  }

  formatErrorDescription(error: ProviderError, locale: string): string | null {
    const openrouterAdapter = new OpenrouterStreamAdapter();
    return openrouterAdapter.createErrorDescription(error, locale);
  }

  supportsEmbeddingTaskType(): boolean {
    return false;
  }

  async generateEmbeddings(request: EmbeddingRequest): Promise<number[][]> {
    if (request.inputs.length === 0) {
      return [];
    }

    try {
      const openRouter = new OpenRouter({ apiKey: request.apiKey });
      const response = await openRouter.embeddings.generate(
        {
          model: request.model,
          input: request.inputs,
        },
        {
          headers: buildOpenRouterAttributionHeaders(),
        },
      );

      return extractOpenRouterEmbeddings(response);
    } catch (error: unknown) {
      // OpenRouter sometimes returns 200 OK with an error body, which trips up the SDK's validation.
      // If this happens, the SDK throws a ResponseValidationError with the raw body in rawValue.
      // biome-ignore lint/suspicious/noExplicitAny: SDK-specific error structure (ResponseValidationError) contains rawValue
      const err = error as any;

      if (err.name === "ResponseValidationError" && err.rawValue?.error) {
        const orError = err.rawValue.error;
        const message = orError.message || "Unknown OpenRouter error";
        const code = orError.code || "unknown";
        throw new Error(`OpenRouter Embedding Error (HTTP 200/${code}): ${message}`);
      }

      if (err.message?.includes("Response validation failed")) {
        const rawBody = err.rawValue ? JSON.stringify(err.rawValue) : "no raw value";
        log.error(`OpenRouter embedding validation failed. Raw response: ${rawBody}`);
      }

      throw error;
    }
  }

  getExpressionInitializationBatchSize(): number {
    return 50;
  }

  async callStructuredJSON<T>(
    request: ProviderStructuredJsonRequest,
    responseSchema: Record<string, unknown>,
    zodSchema: ZodType<T>,
  ): Promise<StructuredOutputResult<T>> {
    return await callOpenrouterStructuredJSON(
      request,
      responseSchema,
      zodSchema,
      request.schemaName ?? "structured_output_result",
    );
  }

  private async getPresetGenerationTools(
    request: ProviderPresetGenerationRequest,
  ): Promise<Array<Record<string, unknown>> | undefined> {
    if (!request.params.useWebSearch) {
      return undefined;
    }

    if (!request.toolContext) {
      log.warn("OpenRouter preset generation skipped search tools: no tool context available.");
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
        sees_youtube: resolveEffectiveOpenRouterSeesYouTube(request.tomoriState),
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

    const { builtInTools, mcpFunctionNames } = await getAvailableToolsWithMCP("openrouter", toolStateForContext);

    const searchTools = builtInTools.filter(
      (tool) => tool.category === "search" || tool.requiresFeatureFlag === "web_search",
    );

    const openrouterAdapter = getOpenrouterToolAdapter();
    return await openrouterAdapter.getAllToolsInOpenrouterFormat(
      searchTools,
      request.tomoriState.server_id,
      mcpFunctionNames,
    );
  }

  async generatePreset(request: ProviderPresetGenerationRequest): Promise<PresetGenerationResult> {
    const tools = await this.getPresetGenerationTools(request);

    return await generatePresetFromPromptOpenrouter(request.apiKey, request.params, request.locale, {
      model: request.tomoriState.llm.llm_codename,
      temperature: getActiveTemperature(request.tomoriState.config),
      tools,
      toolContext: request.toolContext as ToolContext | undefined,
      maxToolRounds: request.maxToolRounds,
    });
  }

  async generateConversationSummary(request: ProviderCompactSummaryRequest): Promise<CompactConversationResult> {
    return await generateConversationSummaryOpenrouter(request);
  }

  async generateRoleplaySummary(request: ProviderCompactSummaryRequest): Promise<CompactRoleplayResult> {
    return await generateRoleplaySummaryOpenrouter(request);
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
          sees_youtube: resolveEffectiveOpenRouterSeesYouTube(tomoriState),
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
      } = await getAvailableToolsWithMCP("openrouter", toolStateForContext);

      let finalBuiltInTools = applyStreamContextAvailability({
        providerLabel: "OpenRouter provider",
        provider: "openrouter",
        builtInTools: availableBuiltInTools,
        streamContext: streamingContext,
        tomoriState,
      });
      let finalMcpFunctionNames = availableMcpFunctionNames;

      ({ builtInTools: finalBuiltInTools, mcpFunctionNames: finalMcpFunctionNames } = applyDeliberateToolAllowlist({
        providerLabel: "OpenRouter provider",
        builtInTools: finalBuiltInTools,
        mcpFunctionNames: finalMcpFunctionNames,
        allowedToolNames: streamingContext?.deliberateToolAllowedNames,
      }));

      const openrouterAdapter = getOpenrouterToolAdapter();
      const allToolsConfig = await openrouterAdapter.getAllToolsInOpenrouterFormat(
        finalBuiltInTools,
        tomoriState.server_id,
        finalMcpFunctionNames,
      );

      log.info(
        `OpenRouter provider tools loaded: ${finalBuiltInTools.length} built-in + ${finalMcpFunctionNames.length} MCP = ${totalCount} total tools (centralized filtering applied)`,
      );

      return allToolsConfig;
    } catch (error) {
      log.error(`Failed to get tools for OpenRouter provider: ${tomoriState.llm.llm_codename}`, error as Error);
      return [];
    }
  }

  /**
   * Uses the robust fallback chain: cache > database > first available
   * @returns Promise<string> - The default model codename
   */
  async getDefaultModel(): Promise<string> {
    return await getDefaultOpenrouterModel();
  }

  /**
   * Convert provider-specific configuration from TomoriState
   */
  async createConfig(tomoriState: TomoriState, apiKey: string): Promise<OpenrouterProviderConfig> {
    // Override capabilities with OpenRouter API data
    // This prevents routing errors caused by incorrect database flags
    let effectiveHasTools = tomoriState.llm.has_tools;
    let effectiveSeesImages = tomoriState.llm.sees_images;
    let effectiveSeesVideos = tomoriState.llm.sees_videos;

    // Special case: other-model uses a user-configured OpenRouter model codename
    // stored in other_model_codename, with real capabilities in other_model_capabilities.
    if (tomoriState.llm.llm_codename === "other-model") {
      const storedCapabilities = tomoriState.config.other_model_capabilities;
      const fetchedAt = tomoriState.config.other_model_capabilities_fetched_at;
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      const isCacheFresh = fetchedAt && Date.now() - fetchedAt.getTime() < sevenDaysMs && storedCapabilities;

      if (isCacheFresh && storedCapabilities) {
        log.info(
          `[OTHER-MODEL] Using cached capabilities for ${tomoriState.config.other_model_codename} (${Math.round((Date.now() - (fetchedAt?.getTime() ?? 0)) / (24 * 60 * 60 * 1000))} days old)`,
        );
        effectiveHasTools = storedCapabilities.hasTools;
        effectiveSeesImages = storedCapabilities.seesImages;
        effectiveSeesVideos = storedCapabilities.seesVideos;
      } else {
        // Cache is missing or stale, so re-fetch using stored model name
        const otherModelCodename = tomoriState.config.other_model_codename;

        if (!otherModelCodename) {
          log.warn(
            "[OTHER-MODEL] No model configured — use /model text to set your OpenRouter model. Using conservative defaults.",
          );
          effectiveHasTools = false;
          effectiveSeesImages = false;
          effectiveSeesVideos = false;
        } else {
          try {
            const capabilities = await getOrFetchOpenRouterCapabilities(otherModelCodename);

            if (capabilities) {
              log.info(
                `[OTHER-MODEL] Refreshed capabilities for ${otherModelCodename}: ` +
                  `tools=${capabilities.hasTools}, images=${capabilities.seesImages}, videos=${capabilities.seesVideos}`,
              );

              // Store refreshed capabilities in database
              const now = new Date();
              await configRepository.updateModelConfig(tomoriState.server_id, {
                other_model_capabilities: capabilities,
                other_model_capabilities_fetched_at: now,
              });

              effectiveHasTools = capabilities.hasTools;
              effectiveSeesImages = capabilities.seesImages;
              effectiveSeesVideos = capabilities.seesVideos;
            } else {
              log.warn(
                `[OTHER-MODEL] Could not fetch capabilities for ${otherModelCodename} — using conservative defaults`,
              );
              effectiveHasTools = false;
              effectiveSeesImages = false;
              effectiveSeesVideos = false;
            }
          } catch (error) {
            log.warn(
              `[OTHER-MODEL] Error refreshing capabilities: ${error instanceof Error ? error.message : String(error)} — using conservative defaults`,
            );
            effectiveHasTools = false;
            effectiveSeesImages = false;
            effectiveSeesVideos = false;
          }
        }
      }
    } else if (isOpenRouterCapabilityCacheReady()) {
      const apiCapabilities = getOpenRouterCapabilities(tomoriState.llm.llm_codename);

      if (apiCapabilities) {
        if (apiCapabilities.hasTools !== effectiveHasTools) {
          log.info(
            `[API OVERRIDE] has_tools: ${effectiveHasTools} (DB) → ` + `${apiCapabilities.hasTools} (OpenRouter API)`,
          );
          effectiveHasTools = apiCapabilities.hasTools;
        }

        if (apiCapabilities.seesImages !== effectiveSeesImages) {
          log.info(
            `[API OVERRIDE] sees_images: ${effectiveSeesImages} (DB) → ` +
              `${apiCapabilities.seesImages} (OpenRouter API)`,
          );
          effectiveSeesImages = apiCapabilities.seesImages;
        }

        if (apiCapabilities.seesVideos !== effectiveSeesVideos) {
          log.info(
            `[API OVERRIDE] sees_videos: ${effectiveSeesVideos} (DB) → ` +
              `${apiCapabilities.seesVideos} (OpenRouter API)`,
          );
          effectiveSeesVideos = apiCapabilities.seesVideos;
        }
      } else {
        log.info(
          `[DB FALLBACK] Model ${tomoriState.llm.llm_codename} not found in ` +
            `OpenRouter API cache - using database flags`,
        );
      }
    } else {
      log.info("[DB FALLBACK] OpenRouter capability cache not ready - using database flags");
    }

    // Resolve max output tokens from the OpenRouter capability cache.
    // If the model reports a max_completion_tokens value, use it, but cap it
    // at OPENROUTER_MAX_OUTPUT_TOKENS (default: 8192) to avoid 402 errors on
    // accounts with low daily credit limits.
    // Shared with the context truncator (see resolveMaxOutputTokens) so the reserved output
    // budget and the requested max_tokens never drift: `/model parameters` override →
    // OPENROUTER_MAX_OUTPUT_TOKENS → flat 8192, clamped to the model's reported ceiling.
    let resolvedMaxOutputTokens: number | undefined;
    if (tomoriState.llm.llm_codename !== "other-model" && isOpenRouterCapabilityCacheReady()) {
      const tokenLimits = getOpenRouterTokenLimits(tomoriState.llm.llm_codename);
      if (tokenLimits?.maxCompletionTokens !== undefined) {
        resolvedMaxOutputTokens = resolveMaxOutputTokens({
          configured: tomoriState.config.llm_max_output_tokens,
          envRaw: process.env.OPENROUTER_MAX_OUTPUT_TOKENS,
          fallback: DEFAULT_MAX_OUTPUT_TOKENS,
          providerReportedMax: tokenLimits.maxCompletionTokens,
        });
      }
    }
    // For custom/unknown models (`other-model`, or a cache miss) we have no reported ceiling to
    // clamp against, so we normally omit max_tokens and let the model self-manage. But an EXPLICIT
    // `/model parameters` output-token override is a deliberate user choice, so honor it so the
    // "lower output tokens" tip shown on 402/400 errors actually reduces the request for these users.
    if (resolvedMaxOutputTokens === undefined) {
      const explicitOverride = tomoriState.config.llm_max_output_tokens;
      if (typeof explicitOverride === "number" && explicitOverride > 0) {
        resolvedMaxOutputTokens = explicitOverride;
      }
    }
    const config: OpenrouterProviderConfig = {
      // For other-model, use the user-configured model codename (e.g., "openrouter/free")
      // rather than the placeholder codename "other-model" which OpenRouter rejects
      model:
        tomoriState.llm.llm_codename === "other-model" && tomoriState.config.other_model_codename
          ? tomoriState.config.other_model_codename
          : tomoriState.llm.llm_codename,
      apiKey: apiKey,
      temperature: tomoriState.config.llm_temperature,
      disabledParams: tomoriState.config.llm_disabled_params ?? [],
      maxOutputTokens: resolvedMaxOutputTokens,
      seesImages: effectiveSeesImages, // Use effective value (may be overridden)
      seesVideos: effectiveSeesVideos, // Wire through video capability flag
      // repetitionPenalty is hardcoded as a general token repetition dampener
      repetitionPenalty: 1.1,
      ...buildActiveSamplingParams(tomoriState.config),
    };
    const runtimeLogitBias = buildRuntimeLogitBiasMapForLlm(tomoriState.config.llm_logit_biases ?? [], tomoriState.llm);
    if (Object.keys(runtimeLogitBias).length > 0) {
      config.logitBias = runtimeLogitBias;
    }

    if (effectiveHasTools) config.tools = await this.getTools(tomoriState);

    return config;
  }

  /**
   * Stream LLM response directly to a Discord channel
   * Uses the modular streaming architecture with StreamOrchestrator and OpenrouterStreamAdapter
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
    log.info(
      `OpenrouterProvider: Starting modular streaming for server ${tomoriState.server_id}, model ${config.model}`,
    );

    try {
      const openrouterConfig = config as OpenrouterProviderConfig;

      const streamConfig: OpenrouterStreamConfig = {
        ...openrouterConfig,
        maxMessageLength: DISCORD_STREAMING_CONSTANTS.MAX_SINGLE_MESSAGE_LENGTH,
        flushBufferSize: DISCORD_STREAMING_CONSTANTS.FLUSH_BUFFER_SIZE_REGULAR,
        flushBufferSizeCodeBlock: DISCORD_STREAMING_CONSTANTS.FLUSH_BUFFER_SIZE_CODE_BLOCK,
        inactivityTimeoutMs: DISCORD_STREAMING_CONSTANTS.INACTIVITY_TIMEOUT_MS,
        baseTypeSpeedMsPerChar: DISCORD_STREAMING_CONSTANTS.BASE_TYPE_SPEED_MS_PER_CHAR,
        maxTypingTimeMs: DISCORD_STREAMING_CONSTANTS.MAX_TYPING_TIME_MS,
        minVisibleTypingDurationMs: DISCORD_STREAMING_CONSTANTS.MIN_VISIBLE_TYPING_DURATION_MS,
        humanizerDegree: tomoriState.config.humanizer_degree,
        emojiUsageEnabled: tomoriState.config.emoji_usage_enabled,
        // Preserve createConfig capability overrides (don't revert to DB flags here)
        seesImages: openrouterConfig.seesImages,
        forceReason: streamingContext?.forceReason,
        isManuallyTriggered: streamingContext?.isManuallyTriggered,
      };

      // Override tools with context-aware tools when streaming context is provided
      // BUT only if tools were enabled in createConfig (after API capability overrides)
      const modelSupportsToolsAfterOverride = Array.isArray(openrouterConfig.tools);
      if (streamingContext && modelSupportsToolsAfterOverride) {
        log.info("OpenrouterProvider: Reloading tools with streaming context for context-aware availability");
        const contextAwareTools = await this.getTools(tomoriState, streamingContext);
        streamConfig.tools = contextAwareTools;
        log.info(`Context-aware tools loaded: ${contextAwareTools.length} tools`);
      }

      const streamContext: StreamContext = buildStreamContext({
        provider: "openrouter",
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
      const openrouterAdapter = new OpenrouterStreamAdapter();

      log.info("OpenrouterProvider: Delegating to StreamOrchestrator with OpenrouterStreamAdapter");
      const result = await orchestrator.streamToDiscord(openrouterAdapter, streamConfig, streamContext);

      log.info(
        `OpenrouterProvider: Modular streaming completed with status: ${result.status}${result.status === "stopped_by_user" && result.stopReason ? ` (reason: ${result.stopReason})` : ""}`,
      );
      return result;
    } catch (error) {
      log.error(
        `OpenrouterProvider modular streaming error for server ${tomoriState.server_id}, model ${config.model}, channel ${channel.id}`,
        error as Error,
      );

      return {
        status: "error",
        data: error as Error,
      };
    }
  }
}
