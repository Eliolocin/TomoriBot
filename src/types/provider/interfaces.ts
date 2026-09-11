/**
 * Base provider interface for LLM services
 * This interface defines the contract that all LLM providers must implement
 * to work with TomoriBot's modular architecture.
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
import type { SupportedParamValue } from "@/constants/supportedParams";
import type { TomoriState } from "../db/schema";
import type { StructuredContextItem } from "../misc/context";
import type { StreamingContext } from "../tool/interfaces";
import type { ProviderError } from "../stream/interfaces";
import type { SpriteShownEntry } from "../stream/types";
import type { TokenUsage } from "@/utils/text/tokenEstimate";

export type ProviderApiFamily = "google-genai" | "openrouter" | "novelai" | "openai-compatible" | "anthropic";

/** LLM generation parameters that providers may support via DB config. */
export type SupportedParam = SupportedParamValue;

type ImageGenerationStyle = "chat-completion" | "nai-pipeline" | "none";

type VideoGenerationStyle = "chat-completion" | "none";

interface ProviderFeatureSupport {
  imageGeneration: ImageGenerationStyle;
  videoGeneration: VideoGenerationStyle;
  embeddings: boolean;
  structuredOutput: boolean;
  presetGeneration: boolean;
  expressionInitialization: boolean;
  liveTokenCounting: boolean;
  conversationCompaction: boolean;
  historyExtraction: boolean;
}

export type ProviderFeatureName = keyof ProviderFeatureSupport;

/**
 * Provider-owned implementation key for shared optional features.
 * Values are declared in each provider's providerInfo.ts so core code does not
 * maintain a central provider-name union.
 */
export type ProviderFeatureImplementation = string;

/**
 * Result of API key validation with structured error information
 */
export interface ApiKeyValidationResult {
  valid: boolean;
  error?: ProviderError; // Detailed error info if validation failed
}

export type StreamStopReason =
  | "user_request"
  | "system_request"
  | "speaker_guard"
  | "send_message_limit"
  | "flush_limit"
  | "unknown";

type ThoughtLogKind = "summary" | "raw";

export interface ThoughtLogEntry {
  kind: ThoughtLogKind;
  content: string;
}

export interface ThoughtLogPayload {
  summary?: string;
  raw?: string;
  /** Formatted text content fetched via the fetch MCP tool, rendered as code blocks in thought-log embeds. */
  fetchedContent?: string;
  firstReplyUrl?: string;
  /** Total provider streaming time represented by this thought log, in milliseconds. */
  generationDurationMs?: number;
  /** OpenRouter-only: upstream serving backend (e.g. "minimax-cn"), shown in the footer. */
  servingProvider?: string;
}

/**
 * Generic stream response result
 */
export interface StreamResult {
  status:
    | "completed"
    | "function_call"
    | "error"
    | "timeout"
    | "stopped_by_user"
    | "empty_response"
    | "follow_up_interrupt";
  data?: unknown | Error; // Function call data or error details
  accumulatedText?: string; // Text sent to Discord (for short-term memory storage)
  /** Extracted <details> block body text (with <summary> stripped), for routing to STM. */
  detailsContent?: string;
  stopReason?: StreamStopReason; // Specific stop source for debugging/logging
  thoughtLog?: ThoughtLogPayload; // Reasoning/thought text captured separately from visible output
  /** NAI GLM-4.6: incomplete trailing sentence dropped by sentenceTrailingBuffer, available for prompt continuation on retry */
  naiContinuationPrefill?: string;
  /**
   * Sprite labels delivered during this stream segment, in render order (one entry
   * per delivered sprite message, so repeats are kept). Surfaced from StreamState so
   * the post-turn stat recorder can attribute `sprite_shown` / `sprite_emotion` to the
   * triggerer's user scope (the stream layer itself has no internal user id). Each
   * entry carries `isIdentity` so identity sprites are excluded from `sprite_emotion`.
   * Omitted when empty.
   */
  spritesShown?: SpriteShownEntry[];
  /**
   * Real, provider-reported token usage for this stream segment, normalized by
   * the orchestrator from the adapter's native usage shape. Present only when
   * the provider surfaced usage (OpenRouter, OpenAI-compatible, Anthropic,
   * Gemini); absent for providers that report no usage, in which case the
   * post-turn recorder falls back to the character estimate. One segment per
   * tool-loop request, so a turn's true usage is the sum across segments.
   */
  usage?: TokenUsage;
}

/**
 * Generic provider configuration
 * Each provider can extend this with their specific configuration
 */
export interface ProviderConfig {
  model: string;
  apiKey: string;
  temperature: number;
  disabledParams?: SupportedParam[];
  maxOutputTokens?: number;
  tools?: Array<Record<string, unknown>>;
  logitBias?: Record<string, number>;
}

/**
 * Provider information and metadata
 */
export interface ProviderInfo {
  name: string;
  displayName: string;
  aliases?: string[]; // Optional aliases for provider name (e.g., ["gemini"] for "google")
  supportedModels: string[];
  requiresApiKey: boolean;
  supportsStreaming: boolean;
  supportsFunctionCalling: boolean;
  supportsImages: boolean;
  supportsVideos: boolean;
  apiFamily: ProviderApiFamily;
  featureSupport: ProviderFeatureSupport;
  featureImplementations?: Partial<Record<ProviderFeatureName, ProviderFeatureImplementation>>;
  usageCostMode?: "metered" | "none" | "unknown";
  /** Generation parameters this provider reads from DB config and sends to its API. */
  supportedParams: readonly SupportedParam[];
}

/**
 * Function call representation (provider-agnostic)
 */
export interface FunctionCall {
  name: string;
  args?: Record<string, unknown>;
  /**
   * True when the provider's argument payload was truncated and the arguments here were
   * recovered from an incomplete stream. They hold only the keys that arrived whole, so a
   * dispatcher must not treat them as the call the model intended to make.
   */
  argumentsTruncated?: boolean;
  /**
   * Optional thought signature for providers that require it (e.g., Gemini).
   * Encoded as base64 when present.
   */
  thoughtSignature?: string;
  /**
   * Optional reasoning details for OpenRouter reasoning models (Gemini, Claude, etc.).
   * Must be preserved when passing tool results back to maintain reasoning continuity.
   * See: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#preserving-reasoning-blocks
   */
  // biome-ignore lint/suspicious/noExplicitAny: reasoning_details has complex nested structure that varies by provider
  reasoning_details?: any[];
  /**
   * DeepSeek thinking-mode continuation payload.
   * When a DeepSeek thinking response issues a tool call, the assistant message must
   * be replayed with its reasoning_content so the same turn can continue.
   */
  deepseekReasoningContent?: string;
}

/**
 * Metadata about images sent to Discord by tool execution
 * Used to make LLM aware of images it sent via tools
 */
export interface FunctionResponseImageMetadata {
  imageUrls: Array<{
    url: string;
    mimeType?: string;
    wasCompressed?: boolean;
    originalUrl?: string;
  }>;
  totalSent: number;
  totalValidated: number;
  /**
   * Discord message IDs where these images were sent (if applicable)
   * Allows follow-up tools to reference the original attachments via message_id
   */
  messageIds?: string[];
}

/**
 * Base interface that all LLM providers must implement
 */
export interface LLMProvider {
  /**
   * Get provider information and capabilities
   */
  getInfo(): ProviderInfo;

  /**
   * Validate an API key by making a test request
   * @param apiKey - The API key to validate
   * @returns Promise<ApiKeyValidationResult> - Validation result with detailed error info if failed
   */
  validateApiKey(apiKey: string): Promise<ApiKeyValidationResult>;

  /**
   * Create a localized provider-specific error description for user-facing embeds.
   * This keeps formatting logic inside the provider abstraction instead of command switches.
   */
  formatErrorDescription(error: ProviderError, locale: string): string | null;

  /**
   * Get available tools/functions based on Tomori's configuration
   * @param tomoriState - The current Tomori state with configuration
   */
  getTools(tomoriState: TomoriState): Promise<Array<Record<string, unknown>>>;

  /**
   * Stream LLM response directly to a Discord channel
   * @param channel - The Discord text channel or thread to send messages to
   * @param config - Provider-specific configuration
   * @param currentTurnModelParts - Accumulated model parts for the current turn
   * @param emojiStrings - Optional array of emoji strings for cleaning
   * @param functionInteractionHistory - Optional function calling history
   * @param initialInteraction - Optional initial interaction for error reporting
   * @param replyToMessage - Optional message to reply to
   * @param streamingContext - Optional streaming context for context-aware tool availability
   * @param userLocale - User's preferred locale for error messages (defaults to en-US)
   * @param webhook - Optional webhook for alter persona responses with custom avatars
   * @param personaAvatarUrl - Optional avatar URL for current persona (used with webhook)
   * @param personaUsername - Optional username override for current persona (used with webhook)
   * @param prefixStrippingName - Optional name used for prefix stripping (may differ from personaUsername for user impersonation)
   */
  streamToDiscord(
    channel: BaseGuildTextChannel | BaseGuildVoiceChannel | DMChannel | AnyThreadChannel,
    client: Client,
    tomoriState: TomoriState,
    config: ProviderConfig,
    contextItems: StructuredContextItem[],
    currentTurnModelParts: Array<Record<string, unknown>>, // Provider-specific parts
    emojiStrings?: string[],
    functionInteractionHistory?: Array<{
      functionCall: FunctionCall;
      functionResponse: Record<string, unknown>;
      imageMetadata?: FunctionResponseImageMetadata;
      /** Text parts the model generated before the function call (prevents repetition on continuation) */
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
  ): Promise<StreamResult>;

  /**
   * @returns Promise<string> - The default model codename
   */
  getDefaultModel(): Promise<string>;

  /**
   * Convert provider-specific configuration from TomoriState
   * @param apiKey - The decrypted API key
   */
  createConfig(tomoriState: TomoriState, apiKey: string): Promise<ProviderConfig>;
}

/**
 * Abstract base class that provides common functionality for all providers
 */
export abstract class BaseLLMProvider implements LLMProvider {
  abstract getInfo(): ProviderInfo;
  abstract validateApiKey(apiKey: string): Promise<ApiKeyValidationResult>;
  abstract formatErrorDescription(error: ProviderError, locale: string): string | null;
  abstract getTools(tomoriState: TomoriState): Promise<Array<Record<string, unknown>>>;
  abstract streamToDiscord(
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
      /** Text parts the model generated before the function call (prevents repetition on continuation) */
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
  ): Promise<StreamResult>;
  abstract getDefaultModel(): Promise<string>;
  abstract createConfig(tomoriState: TomoriState, apiKey: string): Promise<ProviderConfig>;

  /**
   * Common helper method to check if a provider supports a given model
   * @param modelCodename - The model codename to check
   * @returns True if the model is supported by this provider
   */
  protected supportsModel(modelCodename: string): boolean {
    return this.getInfo().supportedModels.includes(modelCodename);
  }
}
