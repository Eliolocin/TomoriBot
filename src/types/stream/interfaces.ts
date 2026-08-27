/**
 * Streaming interfaces for modular LLM provider architecture
 *
 * This module defines the core interfaces that enable separation of concerns between:
 * - Universal Discord integration logic (StreamOrchestrator)
 * - Provider-specific streaming logic (StreamProvider implementations)
 */

import type {
  BaseGuildTextChannel,
  BaseGuildVoiceChannel,
  Client,
  CommandInteraction,
  Message,
  DMChannel,
  NewsChannel,
  TextChannel,
  AnyThreadChannel,
} from "discord.js";
import type {
  FunctionCall,
  FunctionResponseImageMetadata,
  ProviderConfig,
  StreamResult,
  ThoughtLogEntry,
} from "../provider/interfaces";
import type { TomoriState } from "../db/schema";
import type { StructuredContextItem } from "../misc/context";
import type { DeliveredStreamMessage } from "../tool/interfaces";
import type { MessageIdMap } from "@/utils/text/messageIdMap";
import { recordProviderErrorStat } from "@/utils/provider/providerErrorMetrics";

/**
 * Normalized chunk format that all providers convert their raw chunks to
 * This provides a consistent interface for the StreamOrchestrator
 */
export interface ProcessedChunk {
  type: "text" | "function_call" | "error" | "done";
  content?: string;
  functionCall?: FunctionCall;
  error?: ProviderError;
  thoughts?: ThoughtLogEntry[];
  /** OpenRouter-only: the upstream backend that served this chunk (e.g. "minimax-cn"). */
  servingProvider?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Provider-specific error with normalized format
 */
export interface ProviderError {
  type: "api_error" | "rate_limit" | "content_blocked" | "timeout" | "provider_overloaded" | "model_error" | "unknown";
  message: string;
  code?: string;
  retryable: boolean;
  originalError?: unknown;

  userMessage?: string; // User-friendly error message from provider
}

/**
 * Configuration for streaming operations
 * Extends the base ProviderConfig with streaming-specific options
 */
export interface StreamConfig extends ProviderConfig {
  maxMessageLength: number;
  flushBufferSize: number;
  flushBufferSizeCodeBlock: number;

  inactivityTimeoutMs: number;
  baseTypeSpeedMsPerChar: number;
  maxTypingTimeMs: number;
  minVisibleTypingDurationMs: number;

  humanizerDegree: number;
  emojiUsageEnabled: boolean;

  modelOverride?: string;
  forceReason?: boolean;
  isManuallyTriggered?: boolean;
}

/**
 * Context passed to streaming operations
 * Contains all the Discord and application context needed for streaming
 */
export interface StreamContext {
  channel: BaseGuildTextChannel | BaseGuildVoiceChannel | DMChannel | NewsChannel | TextChannel | AnyThreadChannel;
  client: Client;
  initialInteraction?: CommandInteraction;
  replyToMessage?: Message;

  tomoriState: TomoriState;
  contextItems: StructuredContextItem[];
  currentTurnModelParts: Array<Record<string, unknown>>;
  emojiStrings?: string[];
  functionInteractionHistory?: Array<{
    functionCall: FunctionCall;
    functionResponse: Record<string, unknown>;
    imageMetadata?: FunctionResponseImageMetadata;
    /** Text parts the model generated before the function call (prevents repetition on continuation) */
    preToolCallTextParts?: Array<Record<string, unknown>>;
  }>;

  provider: string;
  locale: string;
  suppressUserErrors?: boolean; // Suppress user-facing error embeds during retries or non-deliberate chat turns
  /** Whose credentials answered this turn; selects server- or personal-scoped provider error tips. */
  textCredentialSource?: "server" | "personal";
  rotationKeyRetriesUsed?: boolean; // True if one or more rotation-key retries were attempted
  replyNoticeState?: { attempted: boolean; sent: boolean }; // Tracks the standalone alter reply notice across tool-call stream retries

  disableYouTubeProcessing?: boolean; // Temporarily disable YouTube function during enhanced context restart

  webhook?: import("discord.js").Webhook; // Webhook for alter persona responses
  personaAvatarUrl?: string; // Avatar URL or data URI for current persona
  personaUsername?: string; // Username override for current persona (shown in Discord UI)
  prefixStrippingName?: string; // Name used for prefix stripping (may differ from personaUsername for user impersonation)

  forcedMentions?: Array<{
    handle: string;
    userId: string;
  }>;

  outputPrefill?: string;
  outputPrefillState?: { sent: boolean };

  suppressTextOutput?: boolean;

  // NAI GLM-4.6 prompt continuation: incomplete trailing fragment from previous stream, appended to the
  // assembled prompt so the model continues mid-sentence rather than starting a new response
  naiContinuationPrefill?: string;

  abortSignal?: AbortSignal;

  // Empty-response retry count of the current chat turn , so lets the opening-label leak guard
  // discard-and-retry while budget remains, then strip-and-deliver on the final attempt
  emptyResponseRetryCount?: number;

  onStreamProgress?: () => void;

  messageIdMap?: MessageIdMap;

  /** Internal `users` FK of the turn's triggerer; scopes provider-failure telemetry. */
  triggererUserId?: number;

  // Shared sink (reference threaded from StreamingContext) that the orchestrator appends to on
  // every successful send, so runGenerationTurn can delete a superseded attempt's partial output.
  deliveredMessageRefs?: DeliveredStreamMessage[];
}

/**
 * Raw chunk from provider's streaming API
 * This is the provider-specific format that gets converted to ProcessedChunk
 */
export interface RawStreamChunk {
  data: unknown;
  provider: string;
  metadata?: Record<string, unknown>;
}

/**
 * Interface that provider-specific stream adapters must implement
 * This separates provider API logic from universal Discord logic
 */
export interface StreamProvider {
  /**
   * Initialize and start the streaming process with the provider's API
   * @param config - Provider-specific configuration
   */
  startStream(config: StreamConfig, context: StreamContext): AsyncGenerator<RawStreamChunk, void, unknown>;

  /**
   * Convert a raw provider chunk into normalized ProcessedChunk format
   * @param chunk - Raw chunk from the provider's streaming API
   */
  processChunk(chunk: RawStreamChunk): ProcessedChunk;

  /**
   * Convert provider-specific errors into normalized ProviderError format
   * @param error - Raw error from the provider's API
   * @returns Normalized error with consistent structure
   */
  handleProviderError(error: unknown): ProviderError;

  /**
   * Create provider-specific error description for display in embeds
   * @param error - The normalized provider error
   * @returns Provider-specific error description string or null for fallback
   */
  createErrorDescription(error: ProviderError, locale: string): string | null;

  /**
   * Get provider-specific information for logging and debugging
   */
  getProviderInfo(): {
    name: string;
    version: string;
    supportsStreaming: boolean;
    supportsFunctionCalling: boolean;
  };
}

/**
 * Static identity and capability metadata shared by all stream adapters.
 */
export interface StreamAdapterInfo {
  name: string;
  version: string;
  supportsStreaming?: boolean;
  supportsFunctionCalling: boolean;
}

/**
 * Base class for provider stream adapters.
 *
 * Provider subclasses still own request construction, provider-native parsing,
 * and error normalization. The base class centralizes adapter lifecycle identity
 * and small lifecycle hooks/wrappers used when handing work to StreamOrchestrator.
 */
export abstract class BaseStreamAdapter implements StreamProvider {
  protected constructor(private readonly adapterInfo: StreamAdapterInfo) {}

  abstract startStream(config: StreamConfig, context: StreamContext): AsyncGenerator<RawStreamChunk, void, unknown>;

  abstract processChunk(chunk: RawStreamChunk): ProcessedChunk;

  abstract handleProviderError(error: unknown): ProviderError;

  abstract createErrorDescription(error: ProviderError, locale: string): string | null;

  protected onRawChunk(_chunk: RawStreamChunk): void {}

  /**
   * Fired once per terminal provider failure, before the error chunk is yielded.
   *
   * The base implementation records the `provider_error` counter, which is the only aggregate
   * record of provider failures that exists: `error_logs` is dead by decision, so a subclass that
   * overrides this must call `super.onProviderError(...)` or that provider goes dark.
   */
  protected onProviderError(_error: unknown, providerError: ProviderError, context?: StreamContext): void {
    recordProviderErrorStat(this.adapterInfo.name, providerError, context);
  }

  getProviderInfo(): {
    name: string;
    version: string;
    supportsStreaming: boolean;
    supportsFunctionCalling: boolean;
  } {
    return {
      name: this.adapterInfo.name,
      version: this.adapterInfo.version,
      supportsStreaming: this.adapterInfo.supportsStreaming ?? true,
      supportsFunctionCalling: this.adapterInfo.supportsFunctionCalling,
    };
  }

  protected createRawChunk(
    data: unknown,
    metadata?: Record<string, unknown>,
    providerName = this.adapterInfo.name,
  ): RawStreamChunk {
    const chunk = {
      data,
      provider: providerName,
      metadata: {
        timestamp: Date.now(),
        ...metadata,
      },
    };
    this.onRawChunk(chunk);
    return chunk;
  }

  /**
   * @param context - The failing stream's context; omit only where none is in scope. Without it
   *                  the failure cannot be scoped to a server and goes unrecorded.
   */
  protected createProviderErrorChunk(
    error: unknown,
    context?: StreamContext,
    metadata?: Record<string, unknown>,
    providerName = this.adapterInfo.name,
  ): RawStreamChunk {
    const providerError = this.handleProviderError(error);
    this.onProviderError(error, providerError, context);
    return this.createRawChunk(
      {
        error: providerError,
      },
      {
        error: true,
        ...metadata,
      },
      providerName,
    );
  }
}

/**
 * Interface for the universal Discord streaming orchestrator
 * This handles all Discord-specific logic that's common across providers
 */
export interface StreamOrchestrator {
  /**
   * Stream an LLM response to Discord using a provider-specific adapter
   * This is the main entry point that replaces the massive streamGeminiToDiscord function
   *
   * @param provider - Provider-specific streaming adapter
   * @param config - Streaming configuration
   */
  streamToDiscord(provider: StreamProvider, config: StreamConfig, context: StreamContext): Promise<StreamResult>;
}
