/**
 * Brave Search REST API Service
 * Direct HTTP implementation for Brave Search API endpoints
 * Supports Web, Image, Video, and News search with server-specific API keys
 */

import { AttachmentBuilder, type BaseGuildTextChannel } from "discord.js";
import { log } from "../../../utils/misc/logger";
import { getOptApiKey } from "../../../utils/security/crypto";
import type {
	WebSearchParams,
	ImageSearchParams,
	VideoSearchParams,
	NewsSearchParams,
	WebSearchApiResponse,
	ImageSearchApiResponse,
	VideoSearchApiResponse,
	NewsSearchApiResponse,
	BraveSearchResponse,
	WebResult,
	ImageResult,
	VideoResult,
	NewsResult,
} from "../../../types/tool/braveTypes";

// =============================================
// Constants
// =============================================

const BRAVE_API_BASE_URL = "https://api.search.brave.com/res/v1";
const SERVICE_NAME = "brave-search";
const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT = 15000; // 15 seconds

// =============================================
// Types for Internal Use
// =============================================

interface ApiRequestConfig {
	serverId?: number;
	apiKey?: string;
	timeout?: number;
}

interface ApiResult<T> {
	success: boolean;
	data?: T;
	error?: string;
	statusCode?: number;
}

// =============================================
// Discord Integration Utilities
// =============================================

/**
 * Extract image URLs from Brave Image Search API response
 * @param response - Image search API response
 * @returns Array of image URLs
 */
export function extractImageUrls(response: ImageSearchApiResponse): string[] {
	const imageUrls: string[] = [];

	if (!response.results || response.results.length === 0) {
		return imageUrls;
	}

	for (const result of response.results) {
		// Try to get the actual image URL from properties first
		if (result.properties?.url) {
			imageUrls.push(result.properties.url);
		}
		// Fallback to thumbnail URL if available
		else if (result.thumbnail?.src) {
			imageUrls.push(result.thumbnail.src);
		}
	}

	log.info(
		`Extracted ${imageUrls.length} image URLs from Brave Search response`,
	);
	return imageUrls;
}

/**
 * Send images as Discord attachments
 * @param imageUrls - Array of image URLs to send
 * @param channel - Discord channel to send images to
 * @param query - Search query for context
 * @returns Result of the Discord send operation
 */
export async function sendImagesToDiscord(
	imageUrls: string[],
	channel: BaseGuildTextChannel,
	query: string,
): Promise<{
	success: boolean;
	sentCount: number;
	failedUrls: string[];
	error?: string;
}> {
	if (imageUrls.length === 0) {
		return {
			success: false,
			sentCount: 0,
			failedUrls: [],
			error: "No image URLs provided",
		};
	}

	try {
		const attachments: AttachmentBuilder[] = [];
		const failedUrls: string[] = [];

		// Create Discord attachments from image URLs
		for (let i = 0; i < imageUrls.length; i++) {
			try {
				const imageUrl = imageUrls[i];
				const attachment = new AttachmentBuilder(imageUrl, {
					name: `${query.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_image_${i + 1}.jpg`,
				});
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
			await channel.send({
				files: attachments,
			});

			log.success(`Sent ${attachments.length} image attachments to Discord`);
			return {
				success: true,
				sentCount: attachments.length,
				failedUrls,
			};
		} else {
			return {
				success: false,
				sentCount: 0,
				failedUrls,
				error: "No valid attachments could be created",
			};
		}
	} catch (error) {
		log.error("Failed to send image attachments to Discord:", error as Error);
		return {
			success: false,
			sentCount: 0,
			failedUrls: imageUrls,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Clean image search result by removing image data to reduce token usage
 * @param response - Original image search response
 * @returns Cleaned response without image URLs
 */
export function cleanImageSearchResult(
	response: ImageSearchApiResponse,
): Partial<ImageSearchApiResponse> {
	try {
		return {
			type: response.type,
			query: response.query,
			results: response.results.map((result) => ({
				...result,
				// Remove image URLs to prevent duplicate processing
				properties: result.properties
					? {
							...result.properties,
							url: undefined,
							placeholder: undefined,
						}
					: undefined,
				thumbnail: result.thumbnail
					? {
							...result.thumbnail,
							src: "[Image sent to Discord]",
							original: undefined,
						}
					: undefined,
			})),
			extra: {
				...response.extra,
				summary:
					"Image search completed - images have been sent to Discord channel",
			},
		};
	} catch (error) {
		log.warn("Failed to clean image search result:", error as Error);
		return {
			type: "images",
			query: response.query,
			results: [],
			extra: {
				summary:
					"Image search completed - images have been sent to Discord channel",
				imageDataRemoved: true,
			},
		};
	}
}

/**
 * Add fetch capability reminder to web search results
 * @param originalResult - Original web search result text
 * @returns Enhanced result with fetch capability reminder
 */
export function addFetchCapabilityReminder(originalResult: string): {
	enhancedMessage: string;
	urlsFound: number;
	fetchReminder: string;
} {
	try {
		// Extract URLs from the search results to count them
		const urlPattern = /https?:\/\/[^\s)]+/g;
		const foundUrls = originalResult.match(urlPattern) || [];
		const urlCount = foundUrls.length;

		// Create an enhanced response that includes fetch capability reminder
		const fetchReminder =
			urlCount > 0
				? `\n\n[AGENT REMINDER] You have access to the "fetch" function call to retrieve and analyze the full content of any of these ${urlCount} web URLs. If any given information snippet is not enough, use the function to retrieve more details about a specific webpage, use fetch(url="[URL]") to get the complete page content for deeper analysis.`
				: `\n\n[AGENT REMINDER] You have access to the "fetch" function call to retrieve and analyze the full content of any web URL the user needs. Use fetch(url="[URL]") when more detailed webpage content is needed.`;

		const enhancedMessage = originalResult;

		log.info(
			`Enhanced web search response - Found ${urlCount} URLs, added fetch capability reminder`,
		);

		return {
			enhancedMessage,
			urlsFound: urlCount,
			fetchReminder: fetchReminder.trim(),
		};
	} catch (error) {
		log.warn("Failed to add fetch capability reminder:", error as Error);
		return {
			enhancedMessage: originalResult,
			urlsFound: 0,
			fetchReminder: "",
		};
	}
}

// =============================================
// Core API Functionality
// =============================================

/**
 * Get Brave API key for the given server, with fallback to environment variable
 * @param serverId - Discord server ID (optional)
 * @returns API key or null if not available
 */
async function getBraveApiKey(serverId?: number): Promise<string | null> {
	// Try to get server-specific API key first
	if (serverId) {
		try {
			const serverApiKey = await getOptApiKey(serverId, SERVICE_NAME);
			if (serverApiKey) {
				log.info(`Using server-specific Brave API key for server ${serverId}`);
				return serverApiKey;
			}
		} catch (error) {
			log.warn(
				`Failed to retrieve server API key for ${serverId}:`,
				error as Error,
			);
		}
	}

	// Fallback to environment variable
	const envApiKey = process.env.BRAVE_API_KEY;
	if (envApiKey) {
		log.info("Using environment variable Brave API key");
		return envApiKey;
	}

	log.warn(
		"No Brave API key available (neither server-specific nor environment variable)",
	);
	return null;
}

/**
 * Make a request to the Brave Search API
 * @param endpoint - API endpoint path
 * @param params - Query parameters
 * @param config - Request configuration
 * @returns API response
 */
async function makeBraveApiRequest<T>(
	endpoint: string,
	params: Record<string, string | number | boolean | undefined>,
	config: ApiRequestConfig = {},
): Promise<ApiResult<T>> {
	const { serverId, timeout = REQUEST_TIMEOUT } = config;

	try {
		// Get API key
		const apiKey = config.apiKey || (await getBraveApiKey(serverId));
		if (!apiKey) {
			return {
				success: false,
				error: "No Brave API key available",
				statusCode: 401,
			};
		}

		// Build URL with query parameters
		const url = new URL(`${BRAVE_API_BASE_URL}${endpoint}`);
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined && value !== null) {
				url.searchParams.append(key, String(value));
			}
		}

		log.info(
			`Making Brave API request to: ${endpoint} with ${Object.keys(params).length} parameters`,
		);

		// Create fetch request with timeout
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeout);

		const response = await fetch(url.toString(), {
			method: "GET",
			headers: {
				Accept: "application/json",
				"Accept-Encoding": "gzip",
				"X-Subscription-Token": apiKey,
				"User-Agent": USER_AGENT,
			},
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		// Check if request was successful
		if (!response.ok) {
			const errorText = await response.text().catch(() => "Unknown error");
			log.error(
				`Brave API request failed with status ${response.status}: ${errorText}`,
			);

			return {
				success: false,
				error: `API request failed: ${response.statusText}`,
				statusCode: response.status,
			};
		}

		// Parse JSON response
		const data = (await response.json()) as T;
		log.success(`Brave API request to ${endpoint} completed successfully`);

		return {
			success: true,
			data,
			statusCode: response.status,
		};
	} catch (error) {
		if (error instanceof Error) {
			if (error.name === "AbortError") {
				log.error(
					`Brave API request to ${endpoint} timed out after ${timeout}ms`,
				);
				return {
					success: false,
					error: "Request timed out",
					statusCode: 408,
				};
			}

			log.error(`Brave API request to ${endpoint} failed:`, error);
			return {
				success: false,
				error: error.message,
			};
		}

		return {
			success: false,
			error: "Unknown error occurred",
		};
	}
}

// =============================================
// Public API Functions
// =============================================

/**
 * Perform a web search using Brave Search API
 * @param params - Web search parameters
 * @param config - Request configuration
 * @returns Web search results
 */
export async function braveWebSearch(
	params: WebSearchParams,
	config: ApiRequestConfig = {},
): Promise<ApiResult<WebSearchApiResponse>> {
	// Direct parameter assignment with business rules
	const searchParams = {
		q: params.q,
		country: params.country || "US",
		search_lang: params.search_lang || "en",
		ui_lang: params.ui_lang || "en-US",
		count: 20, // Always 20 for optimal performance
		offset: Math.min(Number(params.offset) || 0, 9),
		safesearch: "off", // Always off (intentional requirement)
		spellcheck: params.spellcheck !== false,
		text_decorations: params.text_decorations !== false,
		summary: true, // Always enabled for better results
		// Only include optional parameters if specified
		...(params.freshness ? { freshness: params.freshness } : {}),
		...(params.result_filter ? { result_filter: params.result_filter } : {}),
		...(params.units ? { units: params.units } : {}),
	};

	return makeBraveApiRequest<WebSearchApiResponse>(
		"/web/search",
		searchParams,
		config,
	);
}

/**
 * Perform an image search using Brave Search API
 * @param params - Image search parameters
 * @param config - Request configuration
 * @returns Image search results
 */
export async function braveImageSearch(
	params: ImageSearchParams,
	config: ApiRequestConfig = {},
): Promise<ApiResult<ImageSearchApiResponse>> {
	// Direct parameter assignment with business rules
	const searchParams = {
		q: params.q,
		country: params.country || "US",
		search_lang: params.search_lang || "en",
		count: Math.min(Number(params.count) || 3, 10), // Max 10 for images, default 3
		safesearch: "off", // Always off (intentional requirement)
		spellcheck: params.spellcheck !== false,
	};
	return makeBraveApiRequest<ImageSearchApiResponse>(
		"/images/search",
		searchParams,
		config,
	);
}

/**
 * Perform a video search using Brave Search API
 * @param params - Video search parameters
 * @param config - Request configuration
 * @returns Video search results
 */
export async function braveVideoSearch(
	params: VideoSearchParams,
	config: ApiRequestConfig = {},
): Promise<ApiResult<VideoSearchApiResponse>> {
	// Direct parameter assignment with business rules
	const searchParams = {
		q: params.q,
		country: params.country || "US",
		search_lang: params.search_lang || "en",
		ui_lang: params.ui_lang || "en-US",
		count: Math.min(Number(params.count) || 5, 10), // Max 10 for videos, default 5
		offset: Math.min(Number(params.offset) || 0, 9),
		safesearch: "off", // Always off (intentional requirement)
		spellcheck: params.spellcheck !== false,
		// Only include freshness if specified
		...(params.freshness ? { freshness: params.freshness } : {}),
	};

	return makeBraveApiRequest<VideoSearchApiResponse>(
		"/videos/search",
		searchParams,
		config,
	);
}

/**
 * Perform a news search using Brave Search API
 * @param params - News search parameters
 * @param config - Request configuration
 * @returns News search results
 */
export async function braveNewsSearch(
	params: NewsSearchParams,
	config: ApiRequestConfig = {},
): Promise<ApiResult<NewsSearchApiResponse>> {
	// Direct parameter assignment with business rules
	const searchParams = {
		q: params.q,
		country: params.country || "US",
		search_lang: params.search_lang || "en",
		ui_lang: params.ui_lang || "en-US",
		count: Math.min(Number(params.count) || 10, 20), // Max 20 for news, default 10
		offset: Math.min(Number(params.offset) || 0, 9),
		safesearch: "off", // Always off (intentional requirement)
		spellcheck: params.spellcheck !== false,
		// Only include freshness if specified
		...(params.freshness ? { freshness: params.freshness } : {}),
	};

	return makeBraveApiRequest<NewsSearchApiResponse>(
		"/news/search",
		searchParams,
		config,
	);
}

// =============================================
// Utility Functions
// =============================================

/**
 * Check if Brave Search is available for a given server
 * @param serverId - Discord server ID (optional)
 * @returns True if API key is available
 */
export async function isBraveSearchAvailable(
	serverId?: number,
): Promise<boolean> {
	const apiKey = await getBraveApiKey(serverId);
	return apiKey !== null;
}

/**
 * Test Brave API connectivity
 * @param serverId - Discord server ID (optional)
 * @returns Test result
 */
export async function testBraveApiConnection(
	serverId?: number,
): Promise<{ success: boolean; error?: string }> {
	try {
		const result = await braveWebSearch(
			{ q: "test" },
			{ serverId, timeout: 5000 },
		);

		if (result.success) {
			return { success: true };
		} else {
			return { success: false, error: result.error };
		}
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}

/**
 * Format search results for consistent output with current MCP implementation
 * @param response - Brave API response
 * @param searchType - Type of search performed
 * @returns Formatted result string
 */
export function formatBraveSearchResults(
	response: BraveSearchResponse,
	searchType: "web" | "image" | "video" | "news",
): string {
	try {
		let results: unknown[] = [];
		let queryOriginal = "your search";

		// Extract results based on search type and response structure
		if (searchType === "web" && "web" in response && response.web) {
			results = response.web.results || [];
			queryOriginal = response.query?.original || "your search";
		} else if (searchType === "image" && "results" in response) {
			results = response.results || [];
			queryOriginal = response.query?.original || "your search";
		} else if (searchType === "video" && "results" in response) {
			results = response.results || [];
			queryOriginal = response.query?.original || "your search";
		} else if (searchType === "news" && "results" in response) {
			results = response.results || [];
			queryOriginal = response.query?.original || "your search";
		}

		if (results.length === 0) {
			return `No ${searchType} results found for "${queryOriginal}"`;
		}

		let formatted = `**${searchType.charAt(0).toUpperCase() + searchType.slice(1)} Search Results for "${queryOriginal}"**\n\n`;

		// Handle different result types
		for (let i = 0; i < Math.min(results.length, 10); i++) {
			const result = results[i];

			switch (searchType) {
				case "web": {
					const webResult = result as WebResult;
					formatted += `**${i + 1}. ${webResult.title}**\n`;
					formatted += `${webResult.url}\n`;
					if (webResult.description) {
						formatted += `${webResult.description}\n`;
					}
					formatted += "\n";
					break;
				}

				case "image": {
					const imageResult = result as ImageResult;
					formatted += `**${i + 1}. ${imageResult.title || "Image"}**\n`;
					if (imageResult.url) {
						formatted += `Source: ${imageResult.url}\n`;
					}
					if (imageResult.properties?.url) {
						formatted += `Image URL: ${imageResult.properties.url}\n`;
					}
					formatted += "\n";
					break;
				}

				case "video": {
					const videoResult = result as VideoResult;
					formatted += `**${i + 1}. ${videoResult.title}**\n`;
					formatted += `${videoResult.url}\n`;
					if (videoResult.description) {
						formatted += `${videoResult.description}\n`;
					}
					if (videoResult.video?.duration) {
						formatted += `Duration: ${videoResult.video.duration}\n`;
					}
					formatted += "\n";
					break;
				}

				case "news": {
					const newsResult = result as NewsResult;
					formatted += `**${i + 1}. ${newsResult.title}**\n`;
					formatted += `${newsResult.url}\n`;
					if (newsResult.description) {
						formatted += `${newsResult.description}\n`;
					}
					if (newsResult.age) {
						formatted += `Age: ${newsResult.age}\n`;
					}
					formatted += "\n";
					break;
				}
			}
		}

		// Add query alteration info if available
		if (
			response.query?.altered &&
			response.query.altered !== response.query.original
		) {
			formatted += `\n*Search query was corrected to: "${response.query.altered}"*`;
		}

		return formatted;
	} catch (error) {
		log.error("Error formatting Brave search results:", error as Error);
		return `Error formatting ${searchType} search results`;
	}
}

// =============================================
// Error Handling Utilities
// =============================================

/**
 * Check if an error is related to API key issues
 * @param error - Error to check
 * @param statusCode - HTTP status code
 * @returns True if error is API key related
 */
export function isBraveApiKeyError(
	error: string,
	statusCode?: number,
): boolean {
	const keywordErrors = [
		"unauthorized",
		"invalid api key",
		"subscription",
		"authentication",
	];

	return (
		statusCode === 401 ||
		statusCode === 403 ||
		keywordErrors.some((keyword) => error.toLowerCase().includes(keyword))
	);
}

/**
 * Check if an error is related to rate limiting
 * @param error - Error to check
 * @param statusCode - HTTP status code
 * @returns True if error is rate limit related
 */
export function isBraveRateLimitError(
	error: string,
	statusCode?: number,
): boolean {
	const rateLimitKeywords = [
		"rate limit",
		"too many requests",
		"quota exceeded",
	];

	return (
		statusCode === 429 ||
		rateLimitKeywords.some((keyword) => error.toLowerCase().includes(keyword))
	);
}
