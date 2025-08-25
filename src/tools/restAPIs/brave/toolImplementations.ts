/**
 * Brave Search Tool Implementations
 * Function call implementations that match MCP function signatures
 * Provides seamless replacement for MCP-based Brave Search functions
 */

import { log } from "../../../utils/misc/logger";
import type { ToolContext } from "../../../types/tool/interfaces";
import { sendStandardEmbed } from "../../../utils/discord/embedHelper";
import { ColorCode } from "../../../utils/misc/logger";
import {
	braveWebSearch,
	braveImageSearch,
	braveVideoSearch,
	braveNewsSearch,
	formatBraveSearchResults,
	isBraveApiKeyError,
	isBraveRateLimitError,
	// Enhanced MCP handler features
	extractImageUrls,
	addFetchCapabilityReminder,
} from "./braveSearchService";

// =============================================
// Helper Functions
// =============================================

/**
 * Extract server ID from tool context
 * @param context - Tool execution context
 * @returns Server ID or undefined
 */
function getServerIdFromContext(context?: ToolContext): number | undefined {
	// If context has serverId, use it directly
	if (context && "serverId" in context) {
		return (context as ToolContext & { serverId?: number }).serverId;
	}

	// Otherwise try to get from Tomori state
	if (context?.tomoriState?.server_id) {
		return context.tomoriState.server_id;
	}

	return undefined;
}

/**
 * Send API key missing error embed to Discord channel
 * @param context - Tool execution context with channel access
 * @param searchType - Type of search that was attempted
 */
async function sendApiKeyErrorEmbed(
	context?: ToolContext,
	searchType = "search",
) {
	if (!context?.channel) return;

	try {
		await sendStandardEmbed(context.channel, context.locale || "en-US", {
			titleKey: "errors.brave_api.missing_key.title",
			descriptionKey: "errors.brave_api.missing_key.description",
			descriptionVars: { searchType },
			color: ColorCode.ERROR,
			footerKey: "errors.brave_api.missing_key.footer",
		});
	} catch (embedError) {
		log.warn(`Failed to send Brave API key error embed: ${embedError}`);
	}
}

/**
 * Create standardized tool result
 * @param success - Whether the operation was successful
 * @param message - Result message for humans
 * @param dataOrError - Either structured data for LLM processing, or error string
 * @param error - Error message (if any, when first param is data)
 * @returns Standardized tool result
 */
function createToolResult(
	success: boolean,
	message: string,
	dataOrError?: Record<string, unknown> | string,
	error?: string,
) {
	// If dataOrError is a string, treat it as an error
	if (typeof dataOrError === "string") {
		return {
			success,
			message,
			error: dataOrError,
		};
	}

	// Otherwise, treat it as data
	return {
		success,
		message,
		...(dataOrError && { data: dataOrError }),
		...(error && { error }),
	};
}

// =============================================
// Tool Function Implementations
// =============================================

/**
 * Brave Web Search function call implementation
 * @param args - Function arguments
 * @param context - Tool execution context
 * @returns Search results
 */
export async function brave_web_search(
	args: Record<string, unknown>,
	context?: ToolContext,
): Promise<{
	success: boolean;
	message: string;
	data?: unknown;
	error?: string;
}> {
	const startTime = Date.now();
	try {
		// Validate required parameters
		if (!args.query || typeof args.query !== "string") {
			return createToolResult(
				false,
				"Invalid or missing query parameter",
				"Query is required and must be a string",
			);
		}

		const serverId = getServerIdFromContext(context);

		// Build search parameters
		const searchParams = {
			q: args.query as string,
			country: (args.country as string) || "US",
			search_lang: (args.search_lang as string) || "en",
			ui_lang: (args.ui_lang as string) || "en-US",
			count: typeof args.count === "number" ? args.count : 10,
			offset: typeof args.offset === "number" ? args.offset : 0,
			safesearch:
				(args.safesearch as "off" | "moderate" | "strict") || "moderate",
			freshness: args.freshness as string,
			spellcheck: args.spellcheck !== false,
		};

		log.info(`Executing brave_web_search for query: "${searchParams.q}"`);

		// Execute search
		const result = await braveWebSearch(searchParams, { serverId });

		if (!result.success || !result.data) {
			// Check for specific error types
			if (
				result.statusCode &&
				isBraveApiKeyError(result.error || "", result.statusCode)
			) {
				await sendApiKeyErrorEmbed(context, "web");
				return createToolResult(
					false,
					"Brave Search API key is invalid or missing",
					result.error,
				);
			}
			if (
				result.statusCode &&
				isBraveRateLimitError(result.error || "", result.statusCode)
			) {
				return createToolResult(
					false,
					"Brave Search API rate limit exceeded",
					result.error,
				);
			}

			return createToolResult(false, "Web search failed", result.error);
		}

		// Format results for display
		const formattedResults = formatBraveSearchResults(result.data, "web");

		// Add fetch capability reminder for agentic AI behavior
		const enhancedResults = addFetchCapabilityReminder(formattedResults);

		log.info(
			`Enhanced web search response with fetch capability reminder - Found ${enhancedResults.urlsFound} URLs`,
		);

		return createToolResult(true, "Web search completed successfully", {
			source: "http",
			functionName: "brave_web_search",
			serverName: "http-brave-search",
			rawResult: {
				functionResponse: {
					name: "brave_web_search",
					response: {
						content: [
							{
								type: "text",
								text: enhancedResults.enhancedMessage,
							},
						],
						isError: false,
					},
				},
			},
			executionTime: Date.now() - startTime,
			urlsFound: enhancedResults.urlsFound,
			status: "completed",
		});
	} catch (error) {
		log.error("Error in brave_web_search:", error as Error);
		return createToolResult(
			false,
			"An unexpected error occurred during web search",
			(error as Error).message,
		);
	}
}

/**
 * Brave Image Search function call implementation
 * @param args - Function arguments
 * @param context - Tool execution context
 * @returns Search results
 */
export async function brave_image_search(
	args: Record<string, unknown>,
	context?: ToolContext,
): Promise<{
	success: boolean;
	message: string;
	data?: unknown;
	error?: string;
}> {
	try {
		// Validate required parameters
		if (!args.query || typeof args.query !== "string") {
			return createToolResult(
				false,
				"Invalid or missing query parameter",
				"Query is required and must be a string",
			);
		}

		const serverId = getServerIdFromContext(context);

		// Build search parameters
		const searchParams = {
			q: args.query as string,
			country: (args.country as string) || "US",
			search_lang: (args.search_lang as string) || "en",
			count: typeof args.count === "number" ? args.count : 20,
			safesearch: (args.safesearch as "off" | "strict") || "strict",
			spellcheck: args.spellcheck !== false,
		};

		log.info(`Executing brave_image_search for query: "${searchParams.q}"`);

		// Execute search
		const result = await braveImageSearch(searchParams, { serverId });

		if (!result.success || !result.data) {
			// Check for specific error types
			if (
				result.statusCode &&
				isBraveApiKeyError(result.error || "", result.statusCode)
			) {
				await sendApiKeyErrorEmbed(context, "image");
				return createToolResult(
					false,
					"Brave Search API key is invalid or missing",
					result.error,
				);
			}
			if (
				result.statusCode &&
				isBraveRateLimitError(result.error || "", result.statusCode)
			) {
				return createToolResult(
					false,
					"Brave Search API rate limit exceeded",
					result.error,
				);
			}

			return createToolResult(false, "Image search failed", result.error);
		}

		// Extract image URLs and process for Discord
		const imageUrls = extractImageUrls(result.data);

		log.info(`Total image URLs extracted: ${imageUrls.length}`);

		if (imageUrls.length > 0 && context?.channel) {
			// Create Discord attachments from image URLs
			const attachments = [];
			const failedUrls = [];

			for (let i = 0; i < imageUrls.length; i++) {
				try {
					const imageUrl = imageUrls[i];
					const attachment = new (await import("discord.js")).AttachmentBuilder(
						imageUrl,
						{
							name: `image_${i + 1}.jpg`,
						},
					);
					attachments.push(attachment);
					log.info(`Prepared Discord attachment for image: ${imageUrl}`);
				} catch (attachmentError) {
					failedUrls.push(imageUrls[i]);
					log.warn(
						`Failed to create attachment for URL: ${imageUrls[i]}`,
						attachmentError as Error,
					);
				}
			}

			// Send attachments to Discord channel
			if (attachments.length > 0) {
				try {
					await context.channel.send({
						files: attachments,
					});
					log.success(
						`Sent ${attachments.length} image attachments to Discord`,
					);

					// Return simplified response to LLM - no URLs or image data to prevent duplicate processing
					const queryTerm = args.query || "images";
					const completionMessage = `Found and sent ${attachments.length} ${queryTerm} images directly to Discord. The images are now displayed for the user.`;

					return createToolResult(true, completionMessage, {
						results: completionMessage,
						imagesSent: attachments.length,
						status: "completed_and_sent",
					});
				} catch (sendError) {
					log.error(
						"Failed to send image attachments to Discord:",
						sendError as Error,
					);

					// Fall back to formatted results if Discord sending fails
					const formattedResults = formatBraveSearchResults(
						result.data,
						"image",
					);
					return createToolResult(
						false,
						`Found ${imageUrls.length} images, but failed to send them to Discord due to a technical error. ${formattedResults}`,
					);
				}
			}
		}

		// Fallback: no Discord channel available or no images found - return formatted results
		if (imageUrls.length === 0) {
			const queryTerm = args.query || "images";
			return createToolResult(
				false,
				`Sorry, I couldn't find any ${queryTerm} images to show you.`,
				{ results: `No ${queryTerm} images found`, status: "no_results" },
			);
		}

		// No Discord channel available - return formatted results
		const formattedResults = formatBraveSearchResults(result.data, "image");
		return createToolResult(true, "Image search completed", {
			results: formattedResults,
			status: "completed",
		});
	} catch (error) {
		log.error("Error in brave_image_search:", error as Error);
		return createToolResult(
			false,
			"An unexpected error occurred during image search",
			(error as Error).message,
		);
	}
}

/**
 * Brave Video Search function call implementation
 * @param args - Function arguments
 * @param context - Tool execution context
 * @returns Search results
 */
export async function brave_video_search(
	args: Record<string, unknown>,
	context?: ToolContext,
): Promise<{
	success: boolean;
	message: string;
	data?: unknown;
	error?: string;
}> {
	try {
		// Validate required parameters
		if (!args.query || typeof args.query !== "string") {
			return createToolResult(
				false,
				"Invalid or missing query parameter",
				"Query is required and must be a string",
			);
		}

		const serverId = getServerIdFromContext(context);

		// Build search parameters
		const searchParams = {
			q: args.query as string,
			country: (args.country as string) || "US",
			search_lang: (args.search_lang as string) || "en",
			ui_lang: (args.ui_lang as string) || "en-US",
			count: typeof args.count === "number" ? args.count : 10,
			offset: typeof args.offset === "number" ? args.offset : 0,
			safesearch:
				(args.safesearch as "off" | "moderate" | "strict") || "moderate",
			freshness: args.freshness as string,
			spellcheck: args.spellcheck !== false,
		};

		log.info(`Executing brave_video_search for query: "${searchParams.q}"`);

		// Execute search
		const result = await braveVideoSearch(searchParams, { serverId });

		if (!result.success || !result.data) {
			// Check for specific error types
			if (
				result.statusCode &&
				isBraveApiKeyError(result.error || "", result.statusCode)
			) {
				await sendApiKeyErrorEmbed(context, "video");
				return createToolResult(
					false,
					"Brave Search API key is invalid or missing",
					result.error,
				);
			}
			if (
				result.statusCode &&
				isBraveRateLimitError(result.error || "", result.statusCode)
			) {
				return createToolResult(
					false,
					"Brave Search API rate limit exceeded",
					result.error,
				);
			}

			return createToolResult(false, "Video search failed", result.error);
		}

		// Format results for display
		const formattedResults = formatBraveSearchResults(result.data, "video");

		return createToolResult(true, "Video search completed successfully", {
			results: formattedResults,
			status: "completed",
		});
	} catch (error) {
		log.error("Error in brave_video_search:", error as Error);
		return createToolResult(
			false,
			"An unexpected error occurred during video search",
			(error as Error).message,
		);
	}
}

/**
 * Brave News Search function call implementation
 * @param args - Function arguments
 * @param context - Tool execution context
 * @returns Search results
 */
export async function brave_news_search(
	args: Record<string, unknown>,
	context?: ToolContext,
): Promise<{
	success: boolean;
	message: string;
	data?: unknown;
	error?: string;
}> {
	try {
		// Validate required parameters
		if (!args.query || typeof args.query !== "string") {
			return createToolResult(
				false,
				"Invalid or missing query parameter",
				"Query is required and must be a string",
			);
		}

		const serverId = getServerIdFromContext(context);

		// Build search parameters
		const searchParams = {
			q: args.query as string,
			country: (args.country as string) || "US",
			search_lang: (args.search_lang as string) || "en",
			ui_lang: (args.ui_lang as string) || "en-US",
			count: typeof args.count === "number" ? args.count : 10,
			offset: typeof args.offset === "number" ? args.offset : 0,
			safesearch:
				(args.safesearch as "off" | "moderate" | "strict") || "moderate",
			freshness: args.freshness as string,
			spellcheck: args.spellcheck !== false,
		};

		log.info(`Executing brave_news_search for query: "${searchParams.q}"`);

		// Execute search
		const result = await braveNewsSearch(searchParams, { serverId });

		if (!result.success || !result.data) {
			// Check for specific error types
			if (
				result.statusCode &&
				isBraveApiKeyError(result.error || "", result.statusCode)
			) {
				return createToolResult(
					false,
					"Brave Search API key is invalid or missing",
					result.error,
				);
			}
			if (
				result.statusCode &&
				isBraveRateLimitError(result.error || "", result.statusCode)
			) {
				return createToolResult(
					false,
					"Brave Search API rate limit exceeded",
					result.error,
				);
			}

			return createToolResult(false, "News search failed", result.error);
		}

		// Format results for display
		const formattedResults = formatBraveSearchResults(result.data, "news");

		return createToolResult(true, "News search completed successfully", {
			results: formattedResults,
			status: "completed",
		});
	} catch (error) {
		log.error("Error in brave_news_search:", error as Error);
		return createToolResult(
			false,
			"An unexpected error occurred during news search",
			(error as Error).message,
		);
	}
}
