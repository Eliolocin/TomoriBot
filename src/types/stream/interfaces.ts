/**
 * Streaming interfaces for modular LLM provider architecture
 *
 * This module defines the core interfaces that enable separation of concerns between:
 * - Universal Discord integration logic (StreamOrchestrator)
 * - Provider-specific streaming logic (StreamProvider implementations)
 */

import type {
	BaseGuildTextChannel,
	Client,
	CommandInteraction,
	Message,
} from "discord.js";
import type {
	FunctionCall,
	ProviderConfig,
	StreamResult,
} from "../provider/interfaces";
import type { TomoriState } from "../db/schema";
import type { StructuredContextItem } from "../misc/context";

/**
 * Normalized chunk format that all providers convert their raw chunks to
 * This provides a consistent interface for the StreamOrchestrator
 */
export interface ProcessedChunk {
	type: "text" | "function_call" | "error" | "done";
	content?: string;
	functionCall?: FunctionCall;
	error?: ProviderError;
	metadata?: Record<string, unknown>;
}

/**
 * Provider-specific error with normalized format
 */
export interface ProviderError {
	type: "api_error" | "rate_limit" | "content_blocked" | "timeout" | "unknown";
	message: string;
	code?: string;
	retryable: boolean;
	originalError?: unknown;
}

/**
 * Configuration for streaming operations
 * Extends the base ProviderConfig with streaming-specific options
 */
export interface StreamConfig extends ProviderConfig {
	// Discord-specific settings
	maxMessageLength: number;
	flushBufferSize: number;
	flushBufferSizeCodeBlock: number;

	// Timing settings
	inactivityTimeoutMs: number;
	baseTypeSpeedMsPerChar: number;
	maxTypingTimeMs: number;
	minVisibleTypingDurationMs: number;

	// Humanization settings
	humanizerDegree: number;
	emojiUsageEnabled: boolean;
}

/**
 * Context passed to streaming operations
 * Contains all the Discord and application context needed for streaming
 */
export interface StreamContext {
	// Discord context
	channel: BaseGuildTextChannel;
	client: Client;
	initialInteraction?: CommandInteraction;
	replyToMessage?: Message;

	// Application context
	tomoriState: TomoriState;
	contextItems: StructuredContextItem[];
	currentTurnModelParts: Array<Record<string, unknown>>;
	emojiStrings?: string[];
	functionInteractionHistory?: Array<{
		functionCall: FunctionCall;
		functionResponse: Record<string, unknown>;
	}>;

	// Provider context
	provider: string;
	locale: string;

	// Tool availability flags
	disableYouTubeProcessing?: boolean; // Temporarily disable YouTube function during enhanced context restart
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
 * Configuration for stream buffer management
 */
export interface BufferConfig {
	maxSize: number;
	flushOnPunctuation: boolean;
	codeBlockHandling: boolean;
	punctuationPattern?: RegExp;
}

/**
 * Interface that provider-specific stream adapters must implement
 * This separates provider API logic from universal Discord logic
 */
export interface StreamProvider {
	/**
	 * Initialize and start the streaming process with the provider's API
	 * @param config - Provider-specific configuration
	 * @param context - Streaming context with Discord and app state
	 * @returns AsyncGenerator that yields raw chunks from the provider
	 */
	startStream(
		config: StreamConfig,
		context: StreamContext,
	): AsyncGenerator<RawStreamChunk, void, unknown>;

	/**
	 * Convert a raw provider chunk into normalized ProcessedChunk format
	 * @param chunk - Raw chunk from the provider's streaming API
	 * @returns Normalized chunk that StreamOrchestrator can handle
	 */
	processChunk(chunk: RawStreamChunk): ProcessedChunk;

	/**
	 * Extract function call information from a raw chunk if present
	 * @param chunk - Raw chunk from the provider's streaming API
	 * @returns Function call data or null if no function call
	 */
	extractFunctionCall(chunk: RawStreamChunk): FunctionCall | null;

	/**
	 * Convert provider-specific errors into normalized ProviderError format
	 * @param error - Raw error from the provider's API
	 * @returns Normalized error with consistent structure
	 */
	handleProviderError(error: unknown): ProviderError;

	/**
	 * Get provider-specific information for logging and debugging
	 * @returns Provider identification and capabilities
	 */
	getProviderInfo(): {
		name: string;
		version: string;
		supportsStreaming: boolean;
		supportsFunctionCalling: boolean;
	};
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
	 * @param context - Discord and application context
	 * @returns Promise<StreamResult> - Outcome of the streaming operation
	 */
	streamToDiscord(
		provider: StreamProvider,
		config: StreamConfig,
		context: StreamContext,
	): Promise<StreamResult>;
}

/**
 * Interface for creating provider-specific configurations
 * This allows each provider to convert TomoriState into their specific config format
 */
export interface StreamConfigFactory {
	/**
	 * Create a streaming configuration for a specific provider
	 * @param tomoriState - Current Tomori state with settings
	 * @param apiKey - Decrypted API key for the provider
	 * @param provider - Provider name for configuration customization
	 * @returns Provider-specific streaming configuration
	 */
	createStreamConfig(
		tomoriState: TomoriState,
		apiKey: string,
		provider: string,
	): StreamConfig;
}
