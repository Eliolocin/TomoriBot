/**
 * Google-specific streaming adapter for Gemini API
 *
 * This adapter implements the StreamProvider interface for Google's Gemini API,
 * containing all the Google-specific logic extracted from the original
 * streamGeminiToDiscord function.
 *
 * Key responsibilities:
 * - Initialize Google AI client and configure streaming
 * - Convert context items to Google's Part format
 * - Handle Google-specific API responses and errors
 * - Extract function calls from Google's response format
 * - Convert Google chunks to normalized ProcessedChunk format
 */

import {
	BlockedReason,
	type Content,
	FinishReason,
	type GenerateContentConfig,
	type FunctionCall as GoogleFunctionCall,
	GoogleGenAI,
	type Part,
	type ThinkingConfig,
} from "@google/genai";
import type { FunctionCall } from "../../types/provider/interfaces";
import {
	ContextItemTag,
	type StructuredContextItem,
} from "../../types/misc/context";
import { log } from "../../utils/misc/logger";
import { localizer } from "../../utils/text/localizer";
import type {
	ProcessedChunk,
	ProviderError,
	RawStreamChunk,
	StreamConfig,
	StreamContext,
	StreamProvider,
} from "../../types/stream/interfaces";

/**
 * Google-specific stream configuration extending the base StreamConfig
 */
export interface GoogleStreamConfig extends StreamConfig {
	safetySettings?: Array<Record<string, unknown>>;
	generationConfig?: Record<string, unknown>;
	systemInstruction?: string;
	thinkingConfig?: ThinkingConfig;
}

/**
 * Raw chunk from Google's streaming API
 */
interface GoogleStreamChunk {
	text?: string;
	functionCalls?: GoogleFunctionCall[];
	promptFeedback?: {
		blockReason?: BlockedReason;
	};
	candidates?: Array<{
		finishReason?: FinishReason;
	}>;
	thoughtSignature?: Uint8Array;
	thoughtSummary?: string;
}

/**
 * Google Gemini streaming adapter implementation
 *
 * Supports thought signatures for enhanced multi-turn conversations:
 * - Configure via GoogleStreamConfig.thinkingConfig
 * - Thought signatures and summaries are included in ProcessedChunk.metadata
 * - Enables the model to maintain reasoning context across function calls
 */
export class GoogleStreamAdapter implements StreamProvider {
	private static readonly DEFAULT_MODEL =
		process.env.DEFAULT_GEMINI_MODEL || "gemini-2.5-flash-preview-05-20";

	private static readonly SYSTEM_INSTRUCTION_TAGS: ContextItemTag[] = [
		ContextItemTag.KNOWLEDGE_SERVER_INFO,
		ContextItemTag.KNOWLEDGE_SERVER_EMOJIS,
		ContextItemTag.KNOWLEDGE_SERVER_STICKERS,
		ContextItemTag.KNOWLEDGE_SERVER_MEMORIES,
		ContextItemTag.KNOWLEDGE_USER_MEMORIES,
		ContextItemTag.KNOWLEDGE_CURRENT_CONTEXT,
	];

	/**
	 * Start streaming from Google's Gemini API
	 */
	async *startStream(
		config: StreamConfig,
		context: StreamContext,
	): AsyncGenerator<RawStreamChunk, void, unknown> {
		log.info("GoogleStreamAdapter: Initializing Gemini streaming");

		// Initialize Google AI client
		const genAI = new GoogleGenAI({ apiKey: config.apiKey });
		const googleConfig = config as GoogleStreamConfig;

		// Prepare the request configuration
		const requestConfig: GenerateContentConfig = {
			...googleConfig.generationConfig,
			safetySettings: googleConfig.safetySettings,
		};

		// Add thinking configuration if provided
		if (googleConfig.thinkingConfig) {
			requestConfig.thinkingConfig = googleConfig.thinkingConfig;
			log.info("GoogleStreamAdapter: Thinking mode enabled");
		}

		// Assemble context for Google format
		const { systemInstruction, dialogueContents } =
			await this.assembleGoogleContext(
				context.contextItems,
				context.currentTurnModelParts,
				context.functionInteractionHistory,
			);

		if (systemInstruction) {
			requestConfig.systemInstruction = systemInstruction;
			log.info(
				`Assembled system instruction. Length: ${systemInstruction.length}`,
			);
		}

		// Add tools if available
		if (config.tools && config.tools.length > 0) {
			requestConfig.tools = config.tools;
		}

		// Add current turn model parts if any
		const finalContents = [...dialogueContents];
		if (context.currentTurnModelParts.length > 0) {
			finalContents.push({
				role: "model",
				parts: context.currentTurnModelParts as Part[],
			});
			log.info(
				`Added ${context.currentTurnModelParts.length} accumulated model parts to API history.`,
			);
		}

		// Add function interaction history
		if (
			context.functionInteractionHistory &&
			context.functionInteractionHistory.length > 0
		) {
			for (const item of context.functionInteractionHistory) {
				finalContents.push({
					role: "model",
					parts: [{ functionCall: item.functionCall as GoogleFunctionCall }],
				});
				finalContents.push({
					role: "user",
					parts: [item.functionResponse as Part],
				});
			}
		}

		log.info(
			`Generating content with model ${config.model || GoogleStreamAdapter.DEFAULT_MODEL}`,
		);

		// Log sanitized request for debugging
		this.logSanitizedRequest(requestConfig, finalContents);

		try {
			// Start the streaming
			const stream = await genAI.models.generateContentStream({
				model: config.model || GoogleStreamAdapter.DEFAULT_MODEL,
				contents: finalContents,
				config: requestConfig,
			});

			// Yield each chunk
			for await (const chunkResponse of stream) {
				yield {
					data: chunkResponse,
					provider: "google",
					metadata: {
						timestamp: Date.now(),
						model: config.model || GoogleStreamAdapter.DEFAULT_MODEL,
					},
				};
			}
		} catch (error) {
			// Convert Google API errors to our format
			const providerError = this.handleProviderError(error);
			yield {
				data: { error: providerError },
				provider: "google",
				metadata: {
					timestamp: Date.now(),
					error: true,
				},
			};
		}
	}

	/**
	 * Process a raw Google chunk into normalized format
	 */
	processChunk(chunk: RawStreamChunk): ProcessedChunk {
		const googleChunk = chunk.data as GoogleStreamChunk;

		// Handle errors first
		if ("error" in googleChunk) {
			return {
				type: "error",
				error: googleChunk.error as ProviderError,
			};
		}

		// Check for content blocks from prompt feedback
		if (
			googleChunk.promptFeedback?.blockReason &&
			googleChunk.promptFeedback.blockReason !==
				BlockedReason.BLOCKED_REASON_UNSPECIFIED
		) {
			const error: ProviderError = {
				type: "content_blocked",
				message: `Prompt blocked by API. Reason: ${googleChunk.promptFeedback.blockReason}`,
				code: googleChunk.promptFeedback.blockReason,
				retryable: false,
				originalError: googleChunk.promptFeedback,
			};

			return {
				type: "error",
				error,
			};
		}

		// Check for finish reason blocks
		const candidate = googleChunk.candidates?.[0];
		if (
			candidate?.finishReason &&
			this.isBlockingFinishReason(candidate.finishReason)
		) {
			const error: ProviderError = {
				type: "content_blocked",
				message: `Response stopped/blocked. Reason: ${candidate.finishReason}`,
				code: candidate.finishReason,
				retryable: false,
				originalError: candidate,
			};

			return {
				type: "error",
				error,
			};
		}

		// Check for thought signatures and thought summaries
		const metadata: Record<string, unknown> = {};
		if (googleChunk.thoughtSignature) {
			metadata.thoughtSignature = googleChunk.thoughtSignature;
			log.info("GoogleStreamAdapter: Received thought signature");
		}
		if (googleChunk.thoughtSummary) {
			metadata.thoughtSummary = googleChunk.thoughtSummary;
			log.info("GoogleStreamAdapter: Received thought summary");
		}

		// Check for function calls
		if (googleChunk.functionCalls && googleChunk.functionCalls.length > 0) {
			const functionCall = this.convertGoogleFunctionCall(
				googleChunk.functionCalls[0],
			);
			return {
				type: "function_call",
				functionCall,
				metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
			};
		}

		// Check for text content
		if (googleChunk.text) {
			return {
				type: "text",
				content: googleChunk.text,
				metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
			};
		}

		// Handle finish reason indicating completion
		if (candidate?.finishReason === FinishReason.STOP) {
			return {
				type: "done",
				metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
			};
		}

		// Default: empty chunk (shouldn't happen but handle gracefully)
		return {
			type: "text",
			content: "",
			metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
		};
	}

	/**
	 * Extract function call from raw Google chunk
	 */
	extractFunctionCall(chunk: RawStreamChunk): FunctionCall | null {
		const googleChunk = chunk.data as GoogleStreamChunk;

		if (googleChunk.functionCalls && googleChunk.functionCalls.length > 0) {
			return this.convertGoogleFunctionCall(googleChunk.functionCalls[0]);
		}

		return null;
	}

	/**
	 * Handle Google-specific errors using official error codes and localized messages
	 */
	handleProviderError(error: unknown): ProviderError {
		const errorMessage = error instanceof Error ? error.message : String(error);

		// Try to parse Google API error structure to extract error code
		let googleApiError: {
			code?: number;
			message?: string;
			status?: string;
		} | null = null;
		let extractedMessage: string | undefined;

		try {
			// Google API errors sometimes have nested JSON in the message
			if (errorMessage.includes('{"error":')) {
				// Extract the JSON part from the error message
				const jsonMatch = errorMessage.match(/\{.*\}/s);
				if (jsonMatch) {
					const parsedError = JSON.parse(jsonMatch[0]);
					googleApiError = parsedError.error || parsedError;

					// Extract the actual Google error message
					if (
						googleApiError?.message &&
						typeof googleApiError.message === "string"
					) {
						try {
							// Some Google errors have double-nested JSON
							const nestedError = JSON.parse(googleApiError.message);
							if (nestedError.error?.message) {
								extractedMessage = nestedError.error.message;
								// Update the error code from nested structure if available
								if (nestedError.error?.code) {
									googleApiError.code = nestedError.error.code;
								}
							}
						} catch {
							// If not nested JSON, use the direct message
							extractedMessage = googleApiError.message;
						}
					}
				}
			}
		} catch (parseError) {
			log.warn(
				"GoogleStreamAdapter: Failed to parse Google API error structure",
				parseError,
			);
		}

		// Determine error type and create localized error based on Google API error codes
		const errorCode = googleApiError?.code;
		let errorType: ProviderError["type"];
		let retryable: boolean;

		// Map Google API error codes to our error types
		switch (errorCode) {
			case 400:
				// Check if this is a billing-related 400 error
				if (
					errorMessage.includes("billing") ||
					errorMessage.includes("free tier")
				) {
					errorType = "api_error";
					retryable = false;
				} else {
					errorType = "api_error";
					retryable = false;
				}
				break;
			case 403:
				errorType = "api_error";
				retryable = false;
				break;
			case 404:
				errorType = "api_error";
				retryable = false;
				break;
			case 429:
				errorType = "rate_limit";
				retryable = true;
				break;
			case 500:
				errorType = "api_error";
				retryable = true;
				break;
			case 503:
				errorType = "api_error";
				retryable = true;
				break;
			case 504:
				errorType = "timeout";
				retryable = true;
				break;
			default:
				// Fallback for unknown error codes or when code is not available
				// Try to categorize based on error message content
				if (
					errorMessage.includes("API key") ||
					errorMessage.includes("PERMISSION_DENIED")
				) {
					errorType = "api_error";
					retryable = false;
				} else if (
					errorMessage.includes("rate") ||
					errorMessage.includes("quota") ||
					errorMessage.includes("RESOURCE_EXHAUSTED")
				) {
					errorType = "rate_limit";
					retryable = true;
				} else if (
					errorMessage.includes("timeout") ||
					errorMessage.includes("DEADLINE_EXCEEDED")
				) {
					errorType = "timeout";
					retryable = true;
				} else if (
					errorMessage.includes("overloaded") ||
					errorMessage.includes("UNAVAILABLE")
				) {
					errorType = "api_error";
					retryable = true;
				} else if (
					errorMessage.includes("safety") ||
					errorMessage.includes("blocked") ||
					errorMessage.includes("prohibited")
				) {
					errorType = "content_blocked";
					retryable = false;
				} else {
					errorType = "api_error";
					retryable = false;
				}
				break;
		}

		// Store the Google error code for use in createErrorEmbed
		const providerError: ProviderError = {
			type: errorType,
			message: `Google API error (${errorCode || "unknown"}): ${errorMessage}`,
			code: errorCode?.toString() || googleApiError?.status || "unknown",
			retryable,
			originalError: error,
			// Store extracted message for createErrorDescription to use
			userMessage: extractedMessage, // Original Google message if available
		};

		return providerError;
	}

	/**
	 * Create Google-specific error description for embedding
	 * Formats errors as "Error Code {code}: {Google message}"
	 */
	createErrorDescription(error: ProviderError, locale: string): string | null {

		// Get Google-specific message based on error code and type
		let googleMessage = error.userMessage;

		if (!googleMessage) {
			// Fallback to locale-based default messages
			const errorCode = error.code;
			let messageKey: string;

			// Map error types to Google-specific locale keys
			switch (error.type) {
				case "content_blocked":
					messageKey = "content_blocked_default_message";
					break;
				case "rate_limit":
					messageKey = "429_default_message";
					break;
				case "timeout":
					messageKey = "504_default_message";
					break;
				case "api_error":
					// Check for specific API error codes
					if (errorCode === "400" && error.message.includes("billing")) {
						messageKey = "400_billing_default_message";
					} else {
						messageKey = `${errorCode}_default_message`;
					}
					break;
				default:
					messageKey = "unknown_default_message";
					break;
			}

			try {
				googleMessage = localizer(locale, `genai.google.${messageKey}`);
			} catch {
				// If locale key doesn't exist, use a generic fallback
				googleMessage = localizer(locale, "genai.google.unknown_default_message");
			}
		}

		// Format as "Error Code {code}: {Google message}"
		const errorCode = error.code || "unknown";
		return `Error Code ${errorCode}: ${googleMessage}`;
	}

	/**
	 * Get provider information
	 */
	getProviderInfo() {
		return {
			name: "google",
			version: "2.5",
			supportsStreaming: true,
			supportsFunctionCalling: true,
		};
	}


	/**
	 * Assemble context items into Google's expected format
	 * Extracted from the original streamGeminiToDiscord function (lines 218-390)
	 */
	private async assembleGoogleContext(
		contextItems: StructuredContextItem[],
		_currentTurnModelParts: Array<Record<string, unknown>>,
		_functionInteractionHistory?: Array<{
			functionCall: FunctionCall;
			functionResponse: Record<string, unknown>;
		}>,
	): Promise<{ systemInstruction?: string; dialogueContents: Content[] }> {
		const systemInstructionParts: string[] = [];
		const dialogueContents: Content[] = [];

		for (const item of contextItems) {
			let itemTextContent = "";
			if (item.parts.some((p) => p.type === "text")) {
				itemTextContent = item.parts
					.filter((p) => p.type === "text")
					.map((p) => (p as { type: "text"; text: string }).text)
					.join("\n");
			}

			// Check if this should be system instruction
			if (
				item.role === "system" ||
				(item.role === "user" &&
					item.metadataTag &&
					GoogleStreamAdapter.SYSTEM_INSTRUCTION_TAGS.includes(
						item.metadataTag,
					))
			) {
				if (itemTextContent) systemInstructionParts.push(itemTextContent);
			} else if (
				(item.role === "user" || item.role === "model") &&
				item.metadataTag &&
				(item.metadataTag === ContextItemTag.DIALOGUE_HISTORY ||
					item.metadataTag === ContextItemTag.DIALOGUE_SAMPLE)
			) {
				// Convert to Google Parts format
				const geminiParts: Part[] = [];
				for (const part of item.parts) {
					if (part.type === "text") {
						geminiParts.push({ text: part.text });
					} else if (part.type === "image" && part.uri && part.mimeType) {
						// Handle images with URI - fetch and convert to base64
						try {
							const imageResponse = await fetch(part.uri);
							if (!imageResponse.ok) {
								throw new Error(`Image fetch failed: ${imageResponse.status}`);
							}
							const imageArrayBuffer = await imageResponse.arrayBuffer();
							const base64ImageData =
								Buffer.from(imageArrayBuffer).toString("base64");

							geminiParts.push({
								inlineData: {
									mimeType: part.mimeType,
									data: base64ImageData,
								},
							});
						} catch (imgErr) {
							log.warn(
								`GoogleStreamAdapter: Image processing error ${part.uri}`,
								{
									error:
										imgErr instanceof Error ? imgErr.message : String(imgErr),
								},
							);
						}
					} else if (
						part.type === "image" &&
						"inlineData" in part &&
						part.inlineData
					) {
						// Handle images that already have base64 data (e.g., from profile picture tool)
						const inlineData = part.inlineData as {
							mimeType: string;
							data: string;
						};
						if (
							typeof inlineData === "object" &&
							inlineData.mimeType &&
							inlineData.data
						) {
							geminiParts.push({
								inlineData: {
									mimeType: inlineData.mimeType,
									data: inlineData.data,
								},
							});
							log.info(
								"GoogleStreamAdapter: Processed image with existing inlineData",
							);
						} else {
							log.warn(
								"GoogleStreamAdapter: Invalid inlineData structure for image part",
							);
						}
					} else if (part.type === "video" && part.uri && part.mimeType) {
						// Handle videos
						try {
							if ((part as { isYouTubeLink?: boolean }).isYouTubeLink) {
								// Check if this is an enhanced context video part (should be processed)
								const isEnhancedContext = (
									part as { enhancedContext?: boolean }
								).enhancedContext;

								if (isEnhancedContext) {
									// Process enhanced context YouTube videos (from function call restart)
									log.info(
										`GoogleStreamAdapter: Processing enhanced context YouTube video: ${part.uri}`,
									);
									geminiParts.push({
										fileData: {
											fileUri: part.uri,
										},
									});
								} else {
									// Skip original YouTube processing - now handled via process_youtube_video tool
									// This prevents timeouts from processing long YouTube videos automatically
									log.info(
										`GoogleStreamAdapter: Skipping original YouTube video auto-processing: ${part.uri} - Available via process_youtube_video tool`,
									);
								}
							} else {
								// Direct video uploads (handle size limits)
								const videoResponse = await fetch(part.uri);
								if (!videoResponse.ok) {
									throw new Error(
										`Video fetch failed: ${videoResponse.status}`,
									);
								}

								const contentLength =
									videoResponse.headers.get("content-length");
								const fileSizeBytes = contentLength
									? Number.parseInt(contentLength, 10)
									: 0;
								const maxInlineSize = 20 * 1024 * 1024; // 20MB limit

								if (fileSizeBytes > 0 && fileSizeBytes < maxInlineSize) {
									const videoArrayBuffer = await videoResponse.arrayBuffer();
									const base64VideoData =
										Buffer.from(videoArrayBuffer).toString("base64");

									geminiParts.push({
										inlineData: {
											mimeType: part.mimeType,
											data: base64VideoData,
										},
									});
									log.info(
										`GoogleStreamAdapter: Added inline video: ${part.uri} (${fileSizeBytes} bytes)`,
									);
								} else {
									log.warn(
										`GoogleStreamAdapter: Video too large for inline processing: ${part.uri} (${fileSizeBytes} bytes). Consider implementing File API upload for videos >20MB.`,
									);
								}
							}
						} catch (videoErr) {
							log.warn(
								`GoogleStreamAdapter: Video processing error ${part.uri}`,
								{
									error:
										videoErr instanceof Error
											? videoErr.message
											: String(videoErr),
								},
							);
						}
					}
				}

				if (geminiParts.length > 0) {
					dialogueContents.push({ role: item.role, parts: geminiParts });
				}
			}
		}

		const systemInstruction =
			systemInstructionParts.length > 0
				? systemInstructionParts.join("\n\n---\n\n")
				: undefined;

		return { systemInstruction, dialogueContents };
	}

	/**
	 * Convert Google function call to our generic format
	 */
	private convertGoogleFunctionCall(
		googleFunctionCall: GoogleFunctionCall,
	): FunctionCall {
		return {
			name: googleFunctionCall.name ?? "",
			args: googleFunctionCall.args || {},
		};
	}

	/**
	 * Check if a finish reason indicates blocking/stopping
	 */
	private isBlockingFinishReason(finishReason: FinishReason): boolean {
		return [
			FinishReason.SAFETY,
			FinishReason.OTHER,
			FinishReason.RECITATION,
			FinishReason.BLOCKLIST,
			FinishReason.PROHIBITED_CONTENT,
			FinishReason.SPII,
			FinishReason.IMAGE_SAFETY,
		].includes(finishReason);
	}

	/**
	 * Log sanitized request configuration for debugging
	 */
	private logSanitizedRequest(
		requestConfig: GenerateContentConfig,
		contents: Content[],
	): void {
		log.section("GoogleStreamAdapter: Request Details");

		const sanitizedRequestConfig = {
			...requestConfig,
			apiKey: undefined, // Remove API key for logging
		};
		log.info(
			`Request Config: ${JSON.stringify(sanitizedRequestConfig, null, 2)}`,
		);

		const sanitizedContents = contents.map((content) => ({
			...content,
			parts: content.parts?.map((part) =>
				"inlineData" in part
					? {
							inlineData: {
								mimeType: part.inlineData?.mimeType,
								data: "[BASE64_HIDDEN]",
							},
						}
					: part,
			),
		}));
		log.info(
			`Contents (${contents.length} items): ${JSON.stringify(sanitizedContents, null, 2)}`,
		);
	}
}
