/**
 * Common types and constants for the modular streaming system
 *
 * This module contains shared types, constants, and utilities used across
 * the StreamOrchestrator and all StreamProvider implementations.
 */

import { HumanizerDegree } from "../db/schema";

/**
 * Discord streaming constants extracted from the original implementation
 * These control message length limits, buffer sizes, and timing behavior
 */
export const DISCORD_STREAMING_CONSTANTS = {
	// Message length limits
	MAX_SINGLE_MESSAGE_LENGTH: 1950,

	// Buffer flush sizes
	FLUSH_BUFFER_SIZE_REGULAR: 500, // For normal text
	FLUSH_BUFFER_SIZE_CODE_BLOCK: 15000, // For code blocks (much larger)

	// Typing simulation timing
	BASE_TYPE_SPEED_MS_PER_CHAR: 10,
	MAX_TYPING_TIME_MS: 4000,
	MIN_VISIBLE_TYPING_DURATION_MS: 750,

	// Random pause timing for natural feel
	MIN_RANDOM_PAUSE_MS: 250,
	MAX_RANDOM_PAUSE_MS: 1500,
	THINKING_PAUSE_CHANCE: 0.25,

	// Stream timeout
	INACTIVITY_TIMEOUT_MS: 120000, // 2 minutes
} as const;

/**
 * Regular expression for detecting sentence boundaries
 * Supports both English periods and Japanese periods with proper lookahead/lookbehind
 */
export const SENTENCE_BOUNDARY_REGEX =
	/(?<!(?:\b(?:vs|mr|mrs|dr|prof|inc|ltd|co|etc|e\.g|i\.e)|\d))(?:(\.|\?)(?=\s|$)|(。))/i;

/**
 * Stream state tracking for buffer management and code block detection
 */
export interface StreamState {
	buffer: string;
	isInsideCodeBlock: boolean;
	messageSentCount: number;
	hasRepliedToOriginalMessage: boolean;
	lastChunkTime: number;
	inactivityTimer: NodeJS.Timeout | null;
}

/**
 * Result of processing a text segment for Discord sending
 */
export interface ProcessedSegment {
	chunks: string[];
	wasHumanized: boolean;
	originalLength: number;
	processedLength: number;
}

/**
 * Configuration for text processing and humanization
 */
export interface TextProcessingConfig {
	humanizerDegree: HumanizerDegree;
	emojiUsageEnabled: boolean;
	emojiStrings: string[];
	botName: string;
	maxMessageLength: number;
}

/**
 * Configuration for typing simulation behavior
 */
export interface TypingSimulationConfig {
	enabled: boolean;
	baseSpeedMsPerChar: number;
	maxTypingTimeMs: number;
	minVisibleDurationMs: number;
	randomPauseEnabled: boolean;
	thinkingPauseChance: number;
}

/**
 * Stream timing metrics for monitoring and debugging
 */
export interface StreamMetrics {
	startTime: number;
	endTime?: number;
	totalChunks: number;
	totalCharacters: number;
	messagesSent: number;
	functionCalls: number;
	errors: number;
	timeouts: number;
}

/**
 * Buffer management configuration
 */
export interface BufferManagementConfig {
	regularFlushSize: number;
	codeBlockFlushSize: number;
	enablePunctuationFlush: boolean;
	enableCodeBlockDetection: boolean;
	sentenceBoundaryRegex: RegExp;
}

/**
 * Stream chunk processing result
 */
export interface ChunkProcessingResult {
	shouldFlush: boolean;
	segmentToFlush?: string;
	updatedBuffer: string;
	newCodeBlockState: boolean;
	breakType?: "newline" | "period" | "code_open" | "code_close" | "overflow";
}

/**
 * Function call execution context
 */
export interface FunctionCallContext {
	functionName: string;
	arguments: Record<string, unknown>;
	executionStartTime: number;
	toolResult?: unknown;
	error?: Error;
}

/**
 * Stream error categorization
 */
export enum StreamErrorType {
	PROVIDER_API_ERROR = "provider_api_error",
	DISCORD_API_ERROR = "discord_api_error",
	TIMEOUT_ERROR = "timeout_error",
	FUNCTION_CALL_ERROR = "function_call_error",
	BUFFER_OVERFLOW = "buffer_overflow",
	CONTENT_BLOCKED = "content_blocked",
	RATE_LIMITED = "rate_limited",
	UNKNOWN_ERROR = "unknown_error",
}

/**
 * Comprehensive stream error information
 */
export interface StreamError {
	type: StreamErrorType;
	message: string;
	code?: string;
	retryable: boolean;
	context?: {
		provider?: string;
		channelId?: string;
		serverId?: string;
		functionName?: string;
		chunkIndex?: number;
	};
	originalError?: unknown;
	timestamp: number;
}

/**
 * Stream status tracking
 */
export enum StreamStatus {
	INITIALIZING = "initializing",
	STREAMING = "streaming",
	FUNCTION_CALLING = "function_calling",
	COMPLETED = "completed",
	ERROR = "error",
	TIMEOUT = "timeout",
	CANCELLED = "cancelled",
}

/**
 * Comprehensive stream result with detailed information
 */
export interface DetailedStreamResult {
	status: StreamStatus;
	data?: unknown;
	error?: StreamError;
	metrics: StreamMetrics;
	functionCalls: FunctionCallContext[];
	warnings: string[];
}

/**
 * Helper function to create default stream state
 */
export function createDefaultStreamState(): StreamState {
	return {
		buffer: "",
		isInsideCodeBlock: false,
		messageSentCount: 0,
		hasRepliedToOriginalMessage: false,
		lastChunkTime: Date.now(),
		inactivityTimer: null,
	};
}

/**
 * Helper function to create default stream metrics
 */
export function createDefaultStreamMetrics(): StreamMetrics {
	return {
		startTime: Date.now(),
		totalChunks: 0,
		totalCharacters: 0,
		messagesSent: 0,
		functionCalls: 0,
		errors: 0,
		timeouts: 0,
	};
}

/**
 * Helper function to create buffer management configuration
 */
export function createBufferManagementConfig(
	customConfig?: Partial<BufferManagementConfig>,
): BufferManagementConfig {
	return {
		regularFlushSize: DISCORD_STREAMING_CONSTANTS.FLUSH_BUFFER_SIZE_REGULAR,
		codeBlockFlushSize:
			DISCORD_STREAMING_CONSTANTS.FLUSH_BUFFER_SIZE_CODE_BLOCK,
		enablePunctuationFlush: true,
		enableCodeBlockDetection: true,
		sentenceBoundaryRegex: SENTENCE_BOUNDARY_REGEX,
		...customConfig,
	};
}

/**
 * Helper function to create typing simulation configuration
 */
export function createTypingSimulationConfig(
	humanizerDegree: HumanizerDegree,
	customConfig?: Partial<TypingSimulationConfig>,
): TypingSimulationConfig {
	return {
		enabled: humanizerDegree >= HumanizerDegree.MEDIUM,
		baseSpeedMsPerChar: DISCORD_STREAMING_CONSTANTS.BASE_TYPE_SPEED_MS_PER_CHAR,
		maxTypingTimeMs: DISCORD_STREAMING_CONSTANTS.MAX_TYPING_TIME_MS,
		minVisibleDurationMs:
			DISCORD_STREAMING_CONSTANTS.MIN_VISIBLE_TYPING_DURATION_MS,
		randomPauseEnabled: humanizerDegree >= HumanizerDegree.MEDIUM,
		thinkingPauseChance: DISCORD_STREAMING_CONSTANTS.THINKING_PAUSE_CHANCE,
		...customConfig,
	};
}
