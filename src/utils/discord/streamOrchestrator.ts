/**
 * Universal Discord streaming orchestrator
 *
 * This class contains all the universal Discord integration logic extracted from
 * the original streamGeminiToDiscord function. It works with any StreamProvider
 * implementation to handle streaming responses to Discord channels.
 *
 * Key responsibilities:
 * - Message sending and chunking
 * - Stream buffer management and code block detection
 * - Function call routing to ToolRegistry
 * - Discord error handling and user notifications
 * - Stream timeout management
 * - Typing simulation and humanization
 */

import { MessageFlags, type Message, type Client } from "discord.js";
import { HumanizerDegree } from "../../types/db/schema";
import { sendStandardEmbed, createSummaryEmbed } from "./embedHelper";
import { ColorCode, log } from "../misc/logger";
import {
	chunkMessage,
	cleanLLMOutput,
	humanizeString,
} from "../text/stringHelper";

import type { StreamResult } from "../../types/provider/interfaces";
import type {
	StreamOrchestrator as IStreamOrchestrator,
	ProcessedChunk,
	StreamConfig,
	StreamContext,
	StreamProvider,
} from "../../types/stream/interfaces";
import {
	type ChunkProcessingResult,
	DISCORD_STREAMING_CONSTANTS,
	SENTENCE_BOUNDARY_REGEX,
	type StreamMetrics,
	type StreamState,
	type TextProcessingConfig,
	type TypingSimulationConfig,
	createDefaultStreamMetrics,
	createDefaultStreamState,
	createTypingSimulationConfig,
} from "../../types/stream/types";

// Retry configuration constants for empty response handling
const MAX_EMPTY_RESPONSE_RETRIES = 2; // Maximum number of retry attempts for empty responses
const RETRY_DELAY_MS = 1000; // Delay between retries in milliseconds (1 second)

/**
 * Universal Discord streaming orchestrator implementation
 * Handles all Discord-specific logic while delegating LLM API calls to providers
 */
export class StreamOrchestrator implements IStreamOrchestrator {
	// Static stop request management system
	private static activeStopRequests = new Map<string, {
		channelId: string;
		timestamp: number;
		requesterId: string;
		stopContext?: {
			originalStopMessage: Message;
			client: Client;
		};
	}>();

	/**
	 * Request a graceful stop of the current stream in a channel
	 * @param channelId - The Discord channel ID where streaming should stop
	 * @param requesterId - The ID of the user requesting the stop (optional)
	 * @param stopContext - Context for creating the stop response (optional)
	 * @returns True if the stop request was registered
	 */
	public static requestStop(
		channelId: string, 
		requesterId?: string,
		stopContext?: { originalStopMessage: Message; client: Client }
	): boolean {
		log.info(`Stop request received for channel ${channelId} by user ${requesterId || 'system'}`);
		
		StreamOrchestrator.activeStopRequests.set(channelId, {
			channelId,
			timestamp: Date.now(),
			requesterId: requesterId || 'system',
			stopContext,
		});
		
		return true;
	}

	/**
	 * Check if there's an active stop request for a channel
	 * @param channelId - The Discord channel ID to check
	 * @returns True if there's an active stop request
	 */
	public static hasStopRequest(channelId: string): boolean {
		return StreamOrchestrator.activeStopRequests.has(channelId);
	}

	/**
	 * Clear stop request for a channel (called when stream completes or fails)
	 * @param channelId - The Discord channel ID to clear
	 */
	public static clearStopRequest(channelId: string): void {
		const removed = StreamOrchestrator.activeStopRequests.delete(channelId);
		if (removed) {
			log.info(`Cleared stop request for channel ${channelId}`);
		}
	}

	/**
	 * Get and clear stop context for a channel (when stream stops)
	 * @param channelId - The Discord channel ID to get context for
	 * @returns Stop context if it exists, null otherwise
	 */
	public static getAndClearStopContext(channelId: string): { originalStopMessage: Message; client: Client } | null {
		const stopRequest = StreamOrchestrator.activeStopRequests.get(channelId);
		if (stopRequest?.stopContext) {
			const context = stopRequest.stopContext;
			StreamOrchestrator.activeStopRequests.delete(channelId);
			log.info(`Retrieved and cleared stop context for channel ${channelId}`);
			return context;
		}
		return null;
	}

	/**
	 * Clean up old stop requests (called periodically to prevent memory leaks)
	 * @param maxAgeMs - Maximum age of stop requests in milliseconds (default: 5 minutes)
	 */
	public static cleanupOldStopRequests(maxAgeMs: number = 5 * 60 * 1000): void {
		const now = Date.now();
		for (const [channelId, stopRequest] of StreamOrchestrator.activeStopRequests.entries()) {
			if (now - stopRequest.timestamp > maxAgeMs) {
				StreamOrchestrator.activeStopRequests.delete(channelId);
				log.info(`Cleaned up old stop request for channel ${channelId}`);
			}
		}
	}
	/**
	 * Stream an LLM response to Discord using a provider-specific adapter
	 * This replaces the massive streamGeminiToDiscord function with modular architecture
	 * Now includes automatic retry mechanism for empty responses
	 */
	async streamToDiscord(
		provider: StreamProvider,
		config: StreamConfig,
		context: StreamContext,
	): Promise<StreamResult> {
		log.section("Universal Stream Orchestrator Started");
		
		// Retry loop for empty responses
		for (let retryAttempt = 0; retryAttempt <= MAX_EMPTY_RESPONSE_RETRIES; retryAttempt++) {
			log.info(
				`Starting stream to channel ${context.channel.id} (server: ${context.channel.guild.id}) using provider: ${provider.getProviderInfo().name}${retryAttempt > 0 ? ` (retry ${retryAttempt}/${MAX_EMPTY_RESPONSE_RETRIES})` : ''}`,
			);

			const result = await this.executeStream(provider, config, context);
			
			// Check if we got an empty response that should be retried
			if (result.status === "completed" && this.wasEmptyResponse(result)) {
				if (retryAttempt < MAX_EMPTY_RESPONSE_RETRIES) {
					log.info(
						`Empty response detected (attempt ${retryAttempt + 1}/${MAX_EMPTY_RESPONSE_RETRIES + 1}). Retrying in ${RETRY_DELAY_MS}ms...`,
					);
					await this.delay(RETRY_DELAY_MS);
					continue; // Retry
				} else {
					// Max retries reached, show error embed
					log.warn(
						`Empty response after ${MAX_EMPTY_RESPONSE_RETRIES} retries. Showing error embed.`,
					);
					await this.handleEmptyResponse(context);
					return { status: "completed" }; // Return completed since we handled it with embed
				}
			}
			
			// Return result for non-empty responses or non-completed statuses
			return result;
		}

		// This should never be reached due to the loop structure, but TypeScript requires it
		return { status: "error", data: new Error("Unexpected end of retry loop") };
	}

	/**
	 * Execute a single stream attempt without retry logic
	 * Contains the core streaming logic extracted from the original streamToDiscord method
	 */
	private async executeStream(
		provider: StreamProvider,
		config: StreamConfig,
		context: StreamContext,
	): Promise<StreamResult & { messageSentCount?: number }> {
		// Initialize logging and metrics
		const metrics = createDefaultStreamMetrics();
		const state = createDefaultStreamState();

		// Create processing configurations
		const textConfig = this.createTextProcessingConfig(config, context);
		const typingConfig = createTypingSimulationConfig(config.humanizerDegree);

		let lastError: Error | undefined;

		try {
			// Initialize timeout management
			this.setupInactivityTimer(state, config, context);

			// Start initial typing indicator
			await context.channel
				.sendTyping()
				.catch((e) => log.warn("Stream: Initial sendTyping failed", e));

			// Begin provider streaming
			const streamGenerator = provider.startStream(config, context);

			// Process the stream
			for await (const rawChunk of streamGenerator) {
				// Check for stop request first (highest priority)
				if (StreamOrchestrator.hasStopRequest(context.channel.id)) {
					log.info(
						`Stream loop breaking due to stop request for channel ${context.channel.id}.`,
					);
					StreamOrchestrator.clearStopRequest(context.channel.id);
					
					// Flush any pending buffer before stopping
					if (state.buffer.length > 0) {
						await this.flushPendingBuffer(
							state,
							this.createTextProcessingConfig(config, context),
							createTypingSimulationConfig(config.humanizerDegree),
							context,
						);
					}
					
					return { status: "stopped_by_user" };
				}

				// Check for timeout
				if (this.isStreamTimedOut(state)) {
					log.warn(
						`Stream loop breaking due to timeout for channel ${context.channel.id}.`,
					);
					break;
				}

				// Reset inactivity timer on each chunk
				this.resetInactivityTimer(state, config, context);
				metrics.totalChunks++;

				// Convert raw chunk to normalized format
				const processedChunk = provider.processChunk(rawChunk);

				// Handle different chunk types
				const result = await this.handleProcessedChunk(
					processedChunk,
					provider,
					config,
					context,
					textConfig,
					typingConfig,
					state,
					metrics,
				);

				// If function call or error, return immediately
				if (result.status !== "continue") {
					this.clearInactivityTimer(state);
					return result;
				}
			}

			// Clear timeout timer
			this.clearInactivityTimer(state);

			// Check if stream timed out
			if (this.isStreamTimedOut(state)) {
				return {
					status: "timeout",
					data: new Error("Stream timed out due to inactivity."),
				};
			}

			// Final buffer flush
			await this.flushFinalBuffer(state, textConfig, typingConfig, context);

			// Complete metrics and return success with message count for empty response detection
			metrics.endTime = Date.now();
			
			// Don't clear stop request here - let the finally block handle it after lock release
			
			log.success(
				`Stream to channel ${context.channel.id} completed. Messages sent: ${state.messageSentCount}, Duration: ${metrics.endTime - metrics.startTime}ms`,
			);

			return { status: "completed", messageSentCount: state.messageSentCount };
		} catch (error) {
			this.clearInactivityTimer(state);
			lastError = error as Error;

			// Clean up stop request on error
			StreamOrchestrator.clearStopRequest(context.channel.id);

			// Log error with context
			const errorContext = {
				serverId: context.tomoriState.server_id,
				errorType: "StreamOrchestrator",
				metadata: {
					channelId: context.channel.id,
					provider: provider.getProviderInfo().name,
				},
			};

			log.error(
				`Stream orchestrator failed: ${lastError.message}`,
				lastError,
				errorContext,
			);

			// Send error to Discord
			await this.handleStreamError(lastError, context);

			return { status: "error", data: lastError };
		}
	}

	/**
	 * Handle a processed chunk from the provider
	 */
	private async handleProcessedChunk(
		chunk: ProcessedChunk,
		_provider: StreamProvider,
		config: StreamConfig,
		context: StreamContext,
		textConfig: TextProcessingConfig,
		typingConfig: TypingSimulationConfig,
		state: StreamState,
		metrics: StreamMetrics,
	): Promise<StreamResult | { status: "continue" }> {
		switch (chunk.type) {
			case "error":
				if (chunk.error) {
					await this.handleProviderError(chunk.error, context);
					return { status: "error", data: new Error(chunk.error.message) };
				}
				break;

			case "function_call":
				if (chunk.functionCall) {
					// Flush any pending buffer before function call
					if (state.buffer.length > 0) {
						await this.flushPendingBuffer(
							state,
							textConfig,
							typingConfig,
							context,
						);
					}
					return { status: "function_call", data: chunk.functionCall };
				}
				break;

			case "text":
				if (chunk.content) {
					await this.processTextChunk(
						chunk.content,
						config,
						context,
						textConfig,
						typingConfig,
						state,
						metrics,
					);
				}
				break;

			case "done":
				// Stream finished, break out of loop
				return { status: "completed" };
		}

		return { status: "continue" };
	}

	/**
	 * Process a text chunk and manage the stream buffer
	 */
	private async processTextChunk(
		textContent: string,
		config: StreamConfig,
		context: StreamContext,
		textConfig: TextProcessingConfig,
		typingConfig: TypingSimulationConfig,
		state: StreamState,
		metrics: StreamMetrics,
	): Promise<void> {
		log.info(`Stream API: Raw chunk received: "${textContent}"`);

		// Add to current turn model parts for API continuity
		if (textContent.trim() && context.currentTurnModelParts) {
			context.currentTurnModelParts.push({ text: textContent });
		}

		// Add to buffer
		state.buffer += textContent;
		metrics.totalCharacters += textContent.length;

		// Process buffer iteratively
		let processedSomething: boolean;
		do {
			processedSomething = false;
			const processingResult = this.processBufferContent(state, config);

			if (processingResult.shouldFlush && processingResult.segmentToFlush) {
				await this.sendBufferSegment(
					processingResult.segmentToFlush,
					textConfig,
					typingConfig,
					context,
					state,
				);

				state.buffer = processingResult.updatedBuffer;
				processedSomething = true;
			}
			
			// Update code block state regardless of whether we flushed or not
			// This ensures we properly track when we enter/exit code blocks
			if (processingResult.newCodeBlockState !== undefined) {
				state.isInsideCodeBlock = processingResult.newCodeBlockState;
			}
			
		} while (
			processedSomething &&
			state.buffer.length > 0 &&
			!state.isInsideCodeBlock &&
			!state.hasSemanticMarkers
		);

		// Handle oversized regular buffer (not in code block and no semantic markers)
		if (
			!state.isInsideCodeBlock &&
			!state.hasSemanticMarkers &&
			state.buffer.length >=
				DISCORD_STREAMING_CONSTANTS.FLUSH_BUFFER_SIZE_REGULAR
		) {
			log.info(
				`Stream Seg: Flushing oversized regular buffer: ${state.buffer.length} chars`,
			);
			await this.sendBufferSegment(
				state.buffer,
				textConfig,
				typingConfig,
				context,
				state,
			);
			state.buffer = "";
		}
	}

	/**
	 * Simple helper to check if buffer contains semantic markers
	 * Much simpler than complex boundary detection - just prevents flushing when markers are present
	 * Now includes markdown formatting markers for natural flow
	 */
	private hasSemanticMarkers(buffer: string): boolean {
		// Original semantic markers
		const hasQuotes = buffer.includes('"') || buffer.includes('「') || buffer.includes('」');
		const hasParens = buffer.includes('(') || buffer.includes(')');
		
		// Markdown formatting markers (should flow naturally with text)
		const hasBold = buffer.includes('**') || buffer.includes('__');
		const hasItalic = buffer.includes('*') || buffer.includes('_');
		const hasStrike = buffer.includes('~~');
		const hasInlineCode = buffer.includes('`') && !buffer.includes('```'); // Exclude code blocks
		const hasLinks = buffer.includes('[') && buffer.includes('](');
		
		return hasQuotes || hasParens || hasBold || hasItalic || hasStrike || hasInlineCode || hasLinks;
	}

	/**
	 * Process buffer content to determine if flushing is needed
	 * This is the core logic extracted from the original streamGeminiToDiscord
	 */
	private processBufferContent(
		state: StreamState,
		config: StreamConfig,
	): ChunkProcessingResult {
		if (state.isInsideCodeBlock) {
			// Look for closing code block
			const closingBackticksIndex = state.buffer.indexOf("```", 3);

			if (closingBackticksIndex !== -1) {
				// Found closing backticks
				const segmentToFlush = state.buffer.substring(
					0,
					closingBackticksIndex + 3,
				);
				const updatedBuffer = state.buffer.substring(closingBackticksIndex + 3);

				return {
					shouldFlush: true,
					segmentToFlush,
					updatedBuffer,
					newCodeBlockState: false,
					breakType: "code_close",
				};
			} else if (
				state.buffer.length >=
				DISCORD_STREAMING_CONSTANTS.FLUSH_BUFFER_SIZE_CODE_BLOCK
			) {
				// Safety flush for oversized code block
				return {
					shouldFlush: true,
					segmentToFlush: state.buffer,
					updatedBuffer: "",
					newCodeBlockState: false,
					breakType: "overflow",
				};
			}

			// Continue accumulating code block
			return {
				shouldFlush: false,
				updatedBuffer: state.buffer,
				newCodeBlockState: true,
			};
		} else {
			// Not in code block - look for break points
			const openingBackticksIndex = state.buffer.indexOf("```");
			const newlineIndex = state.buffer.indexOf("\n");
			
			// Update semantic marker tracking (simple detection)
			state.hasSemanticMarkers = this.hasSemanticMarkers(state.buffer);

			// Check for period flush only if humanizer is HEAVY
			let periodEndIndex = -1;
			if (config.humanizerDegree === HumanizerDegree.HEAVY) {
				const periodMatch = SENTENCE_BOUNDARY_REGEX.exec(state.buffer);
				if (periodMatch) {
					periodEndIndex = periodMatch.index + periodMatch[0].length;
				}
			}

			// Determine earliest break point
			let earliestBreakIndex = -1;
			let breakType: ChunkProcessingResult["breakType"] = undefined;

			if (openingBackticksIndex !== -1) {
				earliestBreakIndex = openingBackticksIndex;
				breakType = "code_open";
			}
			if (
				newlineIndex !== -1 &&
				(earliestBreakIndex === -1 || newlineIndex < earliestBreakIndex)
			) {
				earliestBreakIndex = newlineIndex;
				breakType = "newline";
			}
			if (
				periodEndIndex !== -1 &&
				(earliestBreakIndex === -1 || periodEndIndex < earliestBreakIndex)
			) {
				earliestBreakIndex = periodEndIndex;
				breakType = "period";
			}

			if (earliestBreakIndex !== -1) {
				if (breakType === "code_open") {
					// Code blocks always flush regardless of semantic markers (higher priority)
					if (earliestBreakIndex > 0) {
						// Text before code block
						return {
							shouldFlush: true,
							segmentToFlush: state.buffer.substring(0, earliestBreakIndex),
							updatedBuffer: state.buffer.substring(earliestBreakIndex),
							newCodeBlockState: false,
							breakType,
						};
					} else {
						// Check if complete code block exists
						const closingInSegment = state.buffer.indexOf("```", 3);
						if (closingInSegment !== -1) {
							// Complete code block
							return {
								shouldFlush: true,
								segmentToFlush: state.buffer.substring(0, closingInSegment + 3),
								updatedBuffer: state.buffer.substring(closingInSegment + 3),
								newCodeBlockState: false,
								breakType: "code_close",
							};
						} else {
							// Start of code block
							return {
								shouldFlush: false,
								updatedBuffer: state.buffer,
								newCodeBlockState: true,
							};
						}
					}
				} else if (breakType === "newline" && !state.hasSemanticMarkers) {
					// Only flush on newlines if no semantic markers are present
					return {
						shouldFlush: true,
						segmentToFlush: state.buffer.substring(0, earliestBreakIndex + 1),
						updatedBuffer: state.buffer.substring(earliestBreakIndex + 1),
						newCodeBlockState: false,
						breakType,
					};
				} else if (breakType === "period" && !state.hasSemanticMarkers) {
					// Only flush on periods if no semantic markers are present  
					return {
						shouldFlush: true,
						segmentToFlush: state.buffer.substring(0, periodEndIndex),
						updatedBuffer: state.buffer.substring(periodEndIndex),
						newCodeBlockState: false,
						breakType,
					};
				}
			}

			// No break points found
			return {
				shouldFlush: false,
				updatedBuffer: state.buffer,
				newCodeBlockState: undefined,
			};
		}
	}

	/**
	 * Send a buffer segment to Discord with proper message handling
	 * This is the extracted and enhanced sendSegment function
	 */
	private async sendBufferSegment(
		segment: string,
		textConfig: TextProcessingConfig,
		typingConfig: TypingSimulationConfig,
		context: StreamContext,
		state: StreamState,
	): Promise<void> {
		if (!segment.trim()) return;

		await context.channel
			.sendTyping()
			.catch((e) => log.warn("Stream Seg: sendTyping failed", e));

		// Clean the segment
		const cleanedSegment = cleanLLMOutput(
			segment,
			textConfig.botName,
			textConfig.emojiStrings,
			textConfig.emojiUsageEnabled,
		);

		// Send the processed segment
		await this.sendSegment(
			cleanedSegment,
			textConfig,
			typingConfig,
			context,
			state,
		);
	}

	/**
	 * Core message sending logic with chunking and humanization
	 * Extracted from the original sendSegment function
	 */
	private async sendSegment(
		segment: string,
		textConfig: TextProcessingConfig,
		typingConfig: TypingSimulationConfig,
		context: StreamContext,
		state: StreamState,
	): Promise<void> {
		if (!segment.trim()) return;

		// Chunk the message
		const rawMessageChunks = chunkMessage(
			segment,
			textConfig.humanizerDegree,
			textConfig.maxMessageLength,
		);
		if (!rawMessageChunks.length) return;

		// Process chunks with humanization
		const finalMessageChunks: string[] = [];
		for (let chunk of rawMessageChunks) {
			const originalChunk = chunk;
			if (textConfig.humanizerDegree === HumanizerDegree.HEAVY) {
				chunk = humanizeString(chunk);
				if (chunk !== originalChunk) {
					log.info(
						`Stream Send: Humanized (D3) from "${originalChunk}" to "${chunk}"`,
					);
				}
			}
			if (chunk.trim()) {
				finalMessageChunks.push(chunk);
			}
		}
		if (!finalMessageChunks.length) return;

		// Send chunks with appropriate timing
		if (typingConfig.enabled) {
			await this.sendChunksWithTyping(
				finalMessageChunks,
				typingConfig,
				context,
				state,
			);
		} else {
			await this.sendChunksImmediate(finalMessageChunks, context, state);
		}
	}

	/**
	 * Send message chunks with typing simulation
	 */
	private async sendChunksWithTyping(
		chunks: string[],
		typingConfig: TypingSimulationConfig,
		context: StreamContext,
		state: StreamState,
	): Promise<void> {
		// Check for stop before starting
		if (StreamOrchestrator.hasStopRequest(context.channel.id)) {
			log.info("Stream Send: Stop request detected before sending chunks with typing");
			return;
		}

		// Send first chunk immediately
		const firstChunk = chunks[0];
		await this.sendSingleMessage(firstChunk, context, state);

		// Send remaining chunks with typing simulation
		for (let i = 1; i < chunks.length; i++) {
			// Check for stop before each message
			if (StreamOrchestrator.hasStopRequest(context.channel.id)) {
				log.info(`Stream Send: Stop request detected before sending chunk ${i + 1}/${chunks.length}`);
				return;
			}

			const chunkToSend = chunks[i];

			await context.channel
				.sendTyping()
				.catch((e) =>
					log.warn("Stream Send: sendTyping failed (typing mode)", e),
				);

			// Calculate typing time
			let typingTime = Math.min(
				chunkToSend.length * typingConfig.baseSpeedMsPerChar,
				typingConfig.maxTypingTimeMs,
			);
			typingTime = Math.max(typingTime, typingConfig.minVisibleDurationMs);

			// Extra time for code blocks
			if (chunkToSend.includes("```")) {
				typingTime = Math.max(
					typingTime,
					typingConfig.minVisibleDurationMs * 1.25,
				);
			}

			log.info(`Stream Sim: Typing for ${Math.round(typingTime)}ms`);
			
			// Use interruptible typing delay
			const cancelled = await this.interruptibleDelay(typingTime, context.channel.id);
			if (cancelled) {
				log.info("Stream Send: Stop request detected during typing simulation");
				return;
			}

			await this.sendSingleMessage(chunkToSend, context, state);

			// Add thinking pause between chunks
			if (i < chunks.length - 1 && typingConfig.randomPauseEnabled) {
				const pauseCancelled = await this.addThinkingPauseInterruptible(typingConfig, context);
				if (pauseCancelled) {
					log.info("Stream Send: Stop request detected during thinking pause");
					return;
				}
			}
		}
	}

	/**
	 * Send message chunks immediately without typing simulation
	 */
	private async sendChunksImmediate(
		chunks: string[],
		context: StreamContext,
		state: StreamState,
	): Promise<void> {
		for (const chunk of chunks) {
			await this.sendSingleMessage(chunk, context, state);
		}
	}

	/**
	 * Send a single message to Discord with proper error handling
	 * @param content - The message content to send
	 * @param context - The stream context containing Discord channel and reply information
	 * @param state - The current stream state to track message count
	 * @throws Error if Discord API call fails
	 */
	private async sendSingleMessage(
		content: string,
		context: StreamContext,
		state: StreamState,
	): Promise<void> {
		// Check for stop request before Discord API call
		if (StreamOrchestrator.hasStopRequest(context.channel.id)) {
			log.info("Stream Send: Stop request detected before Discord API call, skipping message send");
			return;
		}

		try {
			// Check if we need to reply or send normally
			if (!state.hasRepliedToOriginalMessage && context.replyToMessage) {
				await context.replyToMessage.reply({
					content,
					allowedMentions: { repliedUser: false },
				});
				state.hasRepliedToOriginalMessage = true;
			} else {
				await context.channel.send({ content });
			}

			state.messageSentCount++;
			log.info(
				`Stream Send: Sent message (${state.messageSentCount}): "${content.length > 100 ? `${content.substring(0, 100)}...` : content}"`,
			);
		} catch (discordError) {
			log.error(
				"Stream Send: Discord API error when sending message",
				discordError,
				{
					serverId: context.tomoriState?.server_id,
					errorType: "StreamOrchestrator",
					metadata: {
						channelId: context.channel.id,
						contentLength: content.length,
						contentPreview: content.substring(0, 200),
					},
				}
			);
			
			// Re-throw to let the overall error handling deal with it
			throw new Error(`Discord send failed: ${discordError instanceof Error ? discordError.message : String(discordError)}`);
		}
	}


	/**
	 * Interruptible thinking pause that can be cancelled by stop requests
	 * @param typingConfig - Typing simulation configuration
	 * @param context - Stream context
	 * @returns True if cancelled by stop request, false if completed normally
	 */
	private async addThinkingPauseInterruptible(
		typingConfig: TypingSimulationConfig,
		context: StreamContext,
	): Promise<boolean> {
		const isThinkingPause = Math.random() < typingConfig.thinkingPauseChance;
		let pauseTime = Math.floor(
			DISCORD_STREAMING_CONSTANTS.MIN_RANDOM_PAUSE_MS +
				Math.random() *
					(DISCORD_STREAMING_CONSTANTS.MAX_RANDOM_PAUSE_MS -
						DISCORD_STREAMING_CONSTANTS.MIN_RANDOM_PAUSE_MS),
		);

		if (isThinkingPause) {
			pauseTime = Math.max(pauseTime * 1.5, typingConfig.minVisibleDurationMs);
			setTimeout(() => {
				context.channel
					.sendTyping()
					.catch((e) =>
						log.warn("Stream Sim: sendTyping during pause failed", e),
					);
			}, pauseTime / 3);
		}

		log.info(
			`Stream Sim: Pausing for ${Math.round(pauseTime)}ms${isThinkingPause ? " (thinking pause)" : ""}`,
		);

		return await this.interruptibleDelay(pauseTime, context.channel.id);
	}

	/**
	 * Create an interruptible delay that can be cancelled by stop requests
	 * @param delayMs - Delay time in milliseconds
	 * @param channelId - Channel ID to check for stop requests
	 * @returns True if cancelled by stop request, false if completed normally
	 */
	private async interruptibleDelay(delayMs: number, channelId: string): Promise<boolean> {
		const checkInterval = Math.min(250, delayMs / 4); // Check every 250ms or 1/4 of delay, whichever is smaller
		const endTime = Date.now() + delayMs;

		while (Date.now() < endTime) {
			// Check for stop request
			if (StreamOrchestrator.hasStopRequest(channelId)) {
				return true; // Cancelled
			}

			// Wait for the check interval or remaining time, whichever is smaller
			const timeLeft = endTime - Date.now();
			const waitTime = Math.min(checkInterval, timeLeft);
			
			if (waitTime > 0) {
				await new Promise((resolve) => setTimeout(resolve, waitTime));
			}
		}

		return false; // Completed normally
	}

	/**
	 * Flush any remaining buffer content at the end of streaming
	 */
	private async flushFinalBuffer(
		state: StreamState,
		textConfig: TextProcessingConfig,
		typingConfig: TypingSimulationConfig,
		context: StreamContext,
	): Promise<void> {
		if (state.buffer.length > 0) {
			const blockStatus = state.isInsideCodeBlock 
				? "still in code block" 
				: state.hasSemanticMarkers 
				? "contains semantic markers" 
				: "regular";
				
			log.info(
				`Stream Seg: Flushing final buffer content (${blockStatus}): "${state.buffer}"`,
			);

			if (state.isInsideCodeBlock) {
				log.warn(
					"Stream Seg: Final flush occurred while still inside a code block. The block might be incomplete.",
				);
			}
			
			if (state.hasSemanticMarkers) {
				log.warn(
					"Stream Seg: Final flush occurred with semantic markers present. Some semantic blocks might be incomplete.",
				);
			}

			await this.sendBufferSegment(
				state.buffer,
				textConfig,
				typingConfig,
				context,
				state,
			);
			state.buffer = "";
			state.isInsideCodeBlock = false;
			state.hasSemanticMarkers = false;
		}
	}

	/**
	 * Flush pending buffer before function calls
	 */
	private async flushPendingBuffer(
		state: StreamState,
		textConfig: TextProcessingConfig,
		typingConfig: TypingSimulationConfig,
		context: StreamContext,
	): Promise<void> {
		if (state.isInsideCodeBlock) {
			log.warn(
				"Stream Seg: Function call received while inside a code block. Flushing incomplete block.",
			);
			state.isInsideCodeBlock = false;
		}
		
		if (state.hasSemanticMarkers) {
			log.warn(
				"Stream Seg: Function call received with semantic markers present. Flushing incomplete semantic blocks.",
			);
			state.hasSemanticMarkers = false;
		}

		const segmentToProcess = state.buffer;
		log.info(
			`Stream Seg: Flushing buffer for function call: "${segmentToProcess}"`,
		);

		await this.sendBufferSegment(
			segmentToProcess,
			textConfig,
			typingConfig,
			context,
			state,
		);
		state.buffer = "";
	}

	/**
	 * Handle empty response case
	 */
	private async handleEmptyResponse(context: StreamContext): Promise<void> {
		log.warn("Stream completed without sending any messages.", {
			channelId: context.channel.id,
		});

		await sendStandardEmbed(
			context.channel,
			context.channel.guild.preferredLocale,
			{
				titleKey: "genai.empty_response_title",
				descriptionKey: "genai.empty_response_description",
				color: ColorCode.WARN,
			},
		).catch((e) =>
			log.warn("Stream: Failed to send empty response embed to channel", e),
		);
	}

	/**
	 * Handle provider-specific errors
	 */
	private async handleProviderError(
		error: unknown,
		context: StreamContext,
	): Promise<void> {
		const providerError = error as { type?: string; code?: string };
		const errorMessage = `Stream response blocked/stopped. Reason: ${providerError.type || "unknown"}.`;
		log.warn(errorMessage, error);

		// Check for PROHIBITED_CONTENT specific error
		const isProhibitedContent = providerError.code === "PROHIBITED_CONTENT";

		if (context.initialInteraction) {
			if (
				!context.initialInteraction.replied &&
				!context.initialInteraction.deferred
			) {
				await context.initialInteraction
					.reply({ content: errorMessage, flags: MessageFlags.Ephemeral })
					.catch((e) =>
						log.warn(
							"Stream: Failed to reply to initial interaction with error",
							e,
						),
					);
			} else {
				await context.initialInteraction
					.followUp({ content: errorMessage, flags: MessageFlags.Ephemeral })
					.catch((e) =>
						log.warn(
							"Stream: Failed to followUp initial interaction with error",
							e,
						),
					);
			}
		} else {
			// Use special handling for PROHIBITED_CONTENT
			if (isProhibitedContent) {
				const summaryEmbed = this.createProhibitedContentEmbed(
					context.channel.guild.preferredLocale,
				);
				await context.channel
					.send({ embeds: [summaryEmbed] })
					.catch((e) =>
						log.warn("Stream: Failed to send prohibited content error embed to channel", e),
					);
			} else {
				// Use default error handling for other error types
				await sendStandardEmbed(
					context.channel,
					context.channel.guild.preferredLocale,
					{
						titleKey: "genai.stream.response_stopped_title",
						descriptionKey: "genai.stream.response_stopped_description",
						descriptionVars: {
							reason: providerError.type || "unknown",
						},
						color: ColorCode.ERROR,
					},
				).catch((e) =>
					log.warn("Stream: Failed to send error embed to channel", e),
				);
			}
		}
	}

	/**
	 * Handle general streaming errors
	 */
	private async handleStreamError(
		error: Error,
		context: StreamContext,
	): Promise<void> {
		const errorMessage = `An error occurred while streaming: ${error.message}`;

		if (context.initialInteraction) {
			if (
				!context.initialInteraction.replied &&
				!context.initialInteraction.deferred
			) {
				await context.initialInteraction
					.reply({ content: errorMessage, flags: MessageFlags.Ephemeral })
					.catch((e) =>
						log.warn(
							"Stream: Failed to reply to initial interaction with error",
							e,
						),
					);
			} else {
				await context.initialInteraction
					.followUp({ content: errorMessage, flags: MessageFlags.Ephemeral })
					.catch((e) =>
						log.warn(
							"Stream: Failed to followUp initial interaction with error",
							e,
						),
					);
			}
		} else {
			await sendStandardEmbed(
				context.channel,
				context.channel.guild.preferredLocale,
				{
					titleKey: "genai.generic_error_title",
					descriptionKey: "genai.generic_error_description",
					descriptionVars: { error_message: error.message },
					color: ColorCode.ERROR,
				},
			).catch((e) =>
				log.warn("Stream: Failed to send generic error embed to channel", e),
			);
		}
	}

	/**
	 * Setup inactivity timer for stream timeout detection
	 */
	private setupInactivityTimer(
		state: StreamState,
		config: StreamConfig,
		context: StreamContext,
	): void {
		this.resetInactivityTimer(state, config, context);
	}

	/**
	 * Reset the inactivity timer
	 */
	private resetInactivityTimer(
		state: StreamState,
		config: StreamConfig,
		context: StreamContext,
	): void {
		state.lastChunkTime = Date.now();
		if (state.inactivityTimer) clearTimeout(state.inactivityTimer);

		state.inactivityTimer = setTimeout(() => {
			log.warn(`Stream to ${context.channel.id} timed out due to inactivity.`);
			// Set a flag or handle timeout - the main loop will check this
		}, config.inactivityTimeoutMs);
	}

	/**
	 * Clear the inactivity timer
	 */
	private clearInactivityTimer(state: StreamState): void {
		if (state.inactivityTimer) {
			clearTimeout(state.inactivityTimer);
			state.inactivityTimer = null;
		}
	}

	/**
	 * Check if stream has timed out
	 */
	private isStreamTimedOut(state: StreamState): boolean {
		// Simple timeout check - could be enhanced with more sophisticated logic
		return (
			state.inactivityTimer === null &&
			Date.now() - state.lastChunkTime >
				DISCORD_STREAMING_CONSTANTS.INACTIVITY_TIMEOUT_MS
		);
	}

	/**
	 * Create text processing configuration from stream config and context
	 */
	private createTextProcessingConfig(
		config: StreamConfig,
		context: StreamContext,
	): TextProcessingConfig {
		return {
			humanizerDegree: config.humanizerDegree,
			emojiUsageEnabled: config.emojiUsageEnabled,
			emojiStrings: context.emojiStrings || [],
			botName: context.tomoriState.tomori_nickname,
			maxMessageLength: config.maxMessageLength,
		};
	}

	/**
	 * Check if a completed stream result represents an empty response
	 * @param result - The stream result to check
	 * @returns True if the result indicates no messages were sent
	 */
	private wasEmptyResponse(result: StreamResult & { messageSentCount?: number }): boolean {
		// If the result has a messageSentCount property and it's 0, it's empty
		if ('messageSentCount' in result && typeof result.messageSentCount === 'number') {
			return result.messageSentCount === 0;
		}
		
		// Fallback: assume non-empty if we can't determine
		return false;
	}

	/**
	 * Create a delay promise for retry logic
	 * @param ms - Milliseconds to delay
	 * @returns Promise that resolves after the specified delay
	 */
	private delay(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	/**
	 * Create a special embed for PROHIBITED_CONTENT errors with admin guidance
	 * @param locale - The locale to use for localization
	 * @returns EmbedBuilder instance for the prohibited content error
	 */
	private createProhibitedContentEmbed(locale: string) {
		return createSummaryEmbed(locale, {
			titleKey: "genai.stream.prohibited_content_title",
			descriptionKey: "genai.stream.prohibited_content_description",
			color: ColorCode.ERROR,
			fields: [
				{
					nameKey: "genai.stream.prohibited_content_admin_notice_title",
					value: "genai.stream.prohibited_content_admin_notice_description",
					inline: false,
				},
			],
		});
	}
}
