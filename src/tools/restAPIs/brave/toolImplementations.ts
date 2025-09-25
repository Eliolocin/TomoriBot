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
			titleKey: "general.errors.brave_api.missing_key.title",
			descriptionKey: "general.errors.brave_api.missing_key.description",
			descriptionVars: { searchType },
			color: ColorCode.ERROR,
			footerKey: "general.errors.brave_api.missing_key.footer",
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

		// Build search parameters - let service layer handle defaults
		// Validate parameter types to prevent runtime errors
		const searchParams = {
			q: args.query as string, // Already validated above
			country: typeof args.country === "string" ? args.country : undefined,
			search_lang:
				typeof args.search_lang === "string" ? args.search_lang : undefined,
			ui_lang: typeof args.ui_lang === "string" ? args.ui_lang : undefined,
			count: typeof args.count === "number" ? args.count : undefined,
			offset: typeof args.offset === "number" ? args.offset : undefined,
			safesearch:
				args.safesearch === "off" ||
				args.safesearch === "moderate" ||
				args.safesearch === "strict"
					? (args.safesearch as "off" | "moderate" | "strict")
					: undefined,
			freshness:
				typeof args.freshness === "string" ? args.freshness : undefined,
			spellcheck:
				typeof args.spellcheck === "boolean" ? args.spellcheck : undefined,
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
			fetchCapabilityReminder: true,
			agentInstructions: enhancedResults.fetchReminder,
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

		// Build search parameters - let service layer handle defaults
		// Validate parameter types to prevent runtime errors
		const searchParams = {
			q: args.query as string, // Already validated above
			country: typeof args.country === "string" ? args.country : undefined,
			search_lang:
				typeof args.search_lang === "string" ? args.search_lang : undefined,
			count: typeof args.count === "number" ? args.count : undefined,
			safesearch:
				args.safesearch === "off" || args.safesearch === "strict"
					? (args.safesearch as "off" | "strict")
					: undefined,
			spellcheck:
				typeof args.spellcheck === "boolean" ? args.spellcheck : undefined,
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
			// Pre-validate URLs and create Discord attachments only for accessible images
			const attachments = [];
			const failedUrls: string[] = [];
			const validatedUrls: string[] = [];

			/**
			 * Fast URL validation function with aggressive timeout
			 * @param imageUrl - URL to validate
			 * @returns Promise resolving to validation result
			 */
			const validateImageUrl = async (
				imageUrl: string,
			): Promise<{ url: string; valid: boolean; reason?: string }> => {
				try {
					// 1. Quick pattern filtering for known problematic domains
					const badPatterns = [
						/xxx\./i,
						/\.onion\//i,
						/localhost/i,
						/127\.0\.0\.1/i,
						/192\.168\./i,
						/10\./i,
					];

					if (badPatterns.some((pattern) => pattern.test(imageUrl))) {
						return { url: imageUrl, valid: false, reason: "blocked_domain" };
					}

					// 2. Aggressive 2-second timeout for network validation
					const controller = new AbortController();
					const timeoutId = setTimeout(() => controller.abort(), 2000);

					const response = await fetch(imageUrl, {
						method: "HEAD",
						signal: controller.signal,
						headers: {
							"User-Agent":
								"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
						},
					});

					clearTimeout(timeoutId);

					// Check if URL is accessible and is actually an image
					if (
						response.ok &&
						response.headers.get("content-type")?.startsWith("image/")
					) {
						return { url: imageUrl, valid: true };
					} else {
						return {
							url: imageUrl,
							valid: false,
							reason: `status_${response.status}`,
						};
					}
				} catch (error) {
					return {
						url: imageUrl,
						valid: false,
						reason: error instanceof Error ? error.name : "unknown_error",
					};
				}
			};

			// 1. Validate all URLs in parallel with overall timeout guarantee
			log.info(
				`Starting parallel validation of ${imageUrls.length} image URLs (2s total timeout)`,
			);

			// Create a shared results array to collect partial results during timeout
			const partialResults = new Map<
				string,
				{ url: string; valid: boolean; reason?: string }
			>();

			// Wrap each validation promise to store results immediately when they complete
			const wrappedPromises = imageUrls.map(async (url) => {
				try {
					const result = await validateImageUrl(url);
					partialResults.set(url, result);
					return result;
				} catch (error) {
					const failResult = {
						url,
						valid: false,
						reason: error instanceof Error ? error.name : "unknown_error",
					};
					partialResults.set(url, failResult);
					return failResult;
				}
			});

			// Overall timeout that preserves any completed validations
			const timeoutPromise = new Promise<
				{ url: string; valid: boolean; reason?: string }[]
			>((resolve) => {
				setTimeout(() => {
					log.warn(
						`Overall validation timeout reached (3s), proceeding with ${partialResults.size}/${imageUrls.length} completed results`,
					);

					// Return completed results + mark incomplete ones as timed out
					const results = imageUrls.map((url) => {
						if (partialResults.has(url)) {
							return partialResults.get(url)!;
						} else {
							return { url, valid: false, reason: "overall_timeout" };
						}
					});

					resolve(results);
				}, 3000);
			});

			let validationResults: { url: string; valid: boolean; reason?: string }[];

			try {
				// Use Promise.race to ensure we never wait more than 3 seconds total
				// But preserve any partial results that completed within the timeout
				validationResults = await Promise.race([
					Promise.allSettled(wrappedPromises).then((settledResults) =>
						settledResults.map((result, index) => {
							if (result.status === "fulfilled") {
								return result.value;
							} else {
								return {
									url: imageUrls[index],
									valid: false,
									reason: "promise_rejected",
								};
							}
						}),
					),
					timeoutPromise,
				]);
			} catch (error) {
				log.error("Validation process failed completely:", error as Error);
				validationResults = imageUrls.map((url) => ({
					url,
					valid: false,
					reason: "validation_error",
				}));
			}

			// 2. Process validation results
			for (const result of validationResults) {
				if (result.valid) {
					validatedUrls.push(result.url);
					log.info(`✓ Validated: ${result.url}`);
				} else {
					failedUrls.push(result.url);
					log.warn(`✗ Failed: ${result.url} (${result.reason})`);
				}
			}

			log.info(
				`Parallel validation complete: ${validatedUrls.length} valid, ${failedUrls.length} invalid`,
			);

			// 3. Create Discord attachments only for validated URLs
			for (let i = 0; i < validatedUrls.length; i++) {
				try {
					const imageUrl = validatedUrls[i];
					const attachment = new (await import("discord.js")).AttachmentBuilder(
						imageUrl,
						{
							name: `image_${i + 1}.jpg`,
						},
					);
					attachments.push(attachment);
					log.info(
						`Prepared Discord attachment for validated image: ${imageUrl}`,
					);
				} catch (attachmentError) {
					// This should rarely happen now since URLs are pre-validated
					failedUrls.push(validatedUrls[i]);
					log.warn(
						`Failed to create attachment for validated URL: ${validatedUrls[i]}`,
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
						`Sent ${attachments.length} validated image attachments to Discord`,
					);

					// Return simplified response to LLM - no URLs or image data to prevent duplicate processing
					const queryTerm = args.query || "images";
					let completionMessage = `Found and sent ${attachments.length} ${queryTerm} images directly to Discord. The images are now displayed for the user.`;

					// Add information about failed URLs if any
					if (failedUrls.length > 0) {
						completionMessage += ` (Note: ${failedUrls.length} image URLs were inaccessible and were filtered out.)`;
					}

					return createToolResult(true, completionMessage, {
						results: completionMessage,
						imagesSent: attachments.length,
						imagesValidated: validatedUrls.length,
						imagesFiltered: failedUrls.length,
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
						`Found ${validatedUrls.length} accessible images, but failed to send them to Discord due to a technical error. ${formattedResults}`,
					);
				}
			} else {
				// No valid images after validation
				const queryTerm = args.query || "images";
				return createToolResult(
					false,
					`Found ${imageUrls.length} ${queryTerm} image URLs, but none were accessible or valid. All image links appear to be broken or inaccessible.`,
					{
						results: `No accessible ${queryTerm} images found`,
						imagesFound: imageUrls.length,
						imagesFiltered: failedUrls.length,
						status: "all_images_inaccessible",
					},
				);
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

		// Build search parameters - let service layer handle defaults
		// Validate parameter types to prevent runtime errors
		const searchParams = {
			q: args.query as string, // Already validated above
			country: typeof args.country === "string" ? args.country : undefined,
			search_lang:
				typeof args.search_lang === "string" ? args.search_lang : undefined,
			ui_lang: typeof args.ui_lang === "string" ? args.ui_lang : undefined,
			count: typeof args.count === "number" ? args.count : undefined,
			offset: typeof args.offset === "number" ? args.offset : undefined,
			safesearch:
				args.safesearch === "off" ||
				args.safesearch === "moderate" ||
				args.safesearch === "strict"
					? (args.safesearch as "off" | "moderate" | "strict")
					: undefined,
			freshness:
				typeof args.freshness === "string" ? args.freshness : undefined,
			spellcheck:
				typeof args.spellcheck === "boolean" ? args.spellcheck : undefined,
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

		// Build search parameters - let service layer handle defaults
		// Validate parameter types to prevent runtime errors
		const searchParams = {
			q: args.query as string, // Already validated above
			country: typeof args.country === "string" ? args.country : undefined,
			search_lang:
				typeof args.search_lang === "string" ? args.search_lang : undefined,
			ui_lang: typeof args.ui_lang === "string" ? args.ui_lang : undefined,
			count: typeof args.count === "number" ? args.count : undefined,
			offset: typeof args.offset === "number" ? args.offset : undefined,
			safesearch:
				args.safesearch === "off" ||
				args.safesearch === "moderate" ||
				args.safesearch === "strict"
					? (args.safesearch as "off" | "moderate" | "strict")
					: undefined,
			freshness:
				typeof args.freshness === "string" ? args.freshness : undefined,
			spellcheck:
				typeof args.spellcheck === "boolean" ? args.spellcheck : undefined,
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
