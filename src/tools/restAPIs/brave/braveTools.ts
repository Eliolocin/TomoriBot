/**
 * HTTP-based Brave Search Tools
 * Implements BaseTool interface for seamless integration with existing tool system
 * Provides direct HTTP replacements for MCP-based Brave Search functions
 */

import {
	BaseTool,
	type ToolContext,
	type ToolResult,
} from "../../../types/tool/interfaces";
import { log } from "../../../utils/misc/logger";
import { sendStandardEmbed } from "../../../utils/discord/embedHelper";
import {
	brave_web_search,
	brave_image_search,
	brave_video_search,
	brave_news_search,
} from "./toolImplementations";

// =============================================
// Base Brave Search Tool Class
// =============================================

/**
 * Abstract base class for Brave Search tools
 * Provides common functionality and error handling
 */
abstract class BaseBraveSearchTool extends BaseTool {
	category = "search" as const;
	requiresFeatureFlag = "web_search";

	// All Brave Search tools are available for all providers
	isAvailableFor(_provider: string): boolean {
		return true;
	}

	/**
	 * Check if web search functionality is enabled in Tomori config
	 * @param context - Tool execution context
	 * @returns True if web search is enabled
	 */
	protected isEnabled(context: ToolContext): boolean {
		return context.tomoriState.config.web_search_enabled;
	}

	/**
	 * Helper method to extract server ID from tool context
	 * @param context - Tool execution context
	 * @returns Server ID from Tomori state
	 */
	protected getServerId(context: ToolContext): number | undefined {
		return context.tomoriState?.server_id;
	}

	/**
	 * Convert function implementation result to ToolResult
	 * @param result - Result from function implementation
	 * @returns Standardized ToolResult
	 */
	protected convertToToolResult(result: {
		success: boolean;
		message: string;
		data?: unknown; // ← Added data field!
		error?: string;
	}): ToolResult {
		const toolResult: ToolResult = {
			success: result.success,
			message: result.message,
		};

		if (result.data) {
			toolResult.data = result.data;
		}

		if (result.error) {
			toolResult.error = result.error;
		}

		return toolResult;
	}
}

// =============================================
// Brave Web Search Tool
// =============================================

/**
 * Brave Web Search Tool
 * HTTP-based implementation for web search functionality
 */
export class BraveWebSearchTool extends BaseBraveSearchTool {
	name = "brave_web_search";
	description =
		"Search the web using Brave Search API. Returns relevant web pages, articles, and information from across the internet.";

	parameters = {
		type: "object" as const,
		properties: {
			query: {
				type: "string" as const,
				description: "The search query to execute",
			},
			country: {
				type: "string" as const,
				description: "Country code for localized results (e.g., US, GB, JP)",
			},
			search_lang: {
				type: "string" as const,
				description: "Search language preference (e.g., en, es, jp)",
			},
			count: {
				type: "number" as const,
				description: "Number of results to return (max 20)",
			},
			offset: {
				type: "number" as const,
				description: "Offset for pagination (0-9)",
			},
			safesearch: {
				type: "string" as const,
				description: "Safe search level",
				enum: ["off", "moderate", "strict"],
			},
			freshness: {
				type: "string" as const,
				description:
					"Filter by content freshness (pd=day, pw=week, pm=month, py=year)",
			},
		},
		required: ["query"],
	};

	async execute(
		args: Record<string, unknown>,
		context: ToolContext,
	): Promise<ToolResult> {
		try {
			// Check if web search is enabled for this server
			if (!this.isEnabled(context)) {
				return {
					success: false,
					error: "Web search is disabled for this server",
					message: "Web search functionality is not enabled for this server.",
				};
			}

			log.info(`Executing ${this.name} with query: ${args.query}`);

			// Send search status embed to Discord
			await sendStandardEmbed(context.channel, context.locale, {
				titleKey: "genai.search.web_search_title",
				titleVars: { query: args.query as string },
				descriptionKey: "genai.search.disclaimer_description",
			});

			// Add server ID from context
			const enhancedContext = {
				...context,
				serverId: this.getServerId(context),
			};

			const result = await brave_web_search(args, enhancedContext);
			return this.convertToToolResult(result);
		} catch (error) {
			log.error(`Error in ${this.name}:`, error as Error);
			return {
				success: false,
				error: `Failed to execute web search: ${(error as Error).message}`,
			};
		}
	}
}

// =============================================
// Brave Image Search Tool
// =============================================

/**
 * Brave Image Search Tool
 * HTTP-based implementation for image search functionality
 */
export class BraveImageSearchTool extends BaseBraveSearchTool {
	name = "brave_image_search";
	description =
		'Search for images using Brave Search API. Returns relevant images with metadata and source information. No need to add keywords such as "images" or "pictures" to your query because this tool is already specifically for image searches.';

	parameters = {
		type: "object" as const,
		properties: {
			query: {
				type: "string" as const,
				description: "The image search query to execute",
			},
			country: {
				type: "string" as const,
				description: "Country code for localized results (e.g., US, GB, JP)",
			},
			search_lang: {
				type: "string" as const,
				description: "Search language preference (e.g., en, es, jp)",
			},
			count: {
				type: "number" as const,
				description: "Number of image results to return (max 200)",
			},
			safesearch: {
				type: "string" as const,
				description: "Safe search level for images",
				enum: ["off", "strict"],
			},
		},
		required: ["query"],
	};

	async execute(
		args: Record<string, unknown>,
		context: ToolContext,
	): Promise<ToolResult> {
		try {
			// Check if web search is enabled for this server
			if (!this.isEnabled(context)) {
				return {
					success: false,
					error: "Web search is disabled for this server",
					message: "Web search functionality is not enabled for this server.",
				};
			}

			log.info(`Executing ${this.name} with query: ${args.query}`);

			// Send search status embed to Discord
			await sendStandardEmbed(context.channel, context.locale, {
				titleKey: "genai.search.image_search_title",
				titleVars: { query: args.query as string },
				descriptionKey: "genai.search.disclaimer_description",
			});

			// Add server ID from context
			const enhancedContext = {
				...context,
				serverId: this.getServerId(context),
			};

			const result = await brave_image_search(args, enhancedContext);
			return this.convertToToolResult(result);
		} catch (error) {
			log.error(`Error in ${this.name}:`, error as Error);
			return {
				success: false,
				error: `Failed to execute image search: ${(error as Error).message}`,
			};
		}
	}
}

// =============================================
// Brave Video Search Tool
// =============================================

/**
 * Brave Video Search Tool
 * HTTP-based implementation for video search functionality
 */
export class BraveVideoSearchTool extends BaseBraveSearchTool {
	name = "brave_video_search";
	description =
		"Search for videos using Brave Search API. Returns relevant videos with metadata, duration, and source information.";

	parameters = {
		type: "object" as const,
		properties: {
			query: {
				type: "string" as const,
				description: "The video search query to execute",
			},
			country: {
				type: "string" as const,
				description: "Country code for localized results (e.g., US, GB, JP)",
			},
			search_lang: {
				type: "string" as const,
				description: "Search language preference (e.g., en, es, jp)",
			},
			count: {
				type: "number" as const,
				description: "Number of video results to return (max 50)",
			},
			offset: {
				type: "number" as const,
				description: "Offset for pagination (0-9)",
			},
			safesearch: {
				type: "string" as const,
				description: "Safe search level for videos",
				enum: ["off", "moderate", "strict"],
			},
			freshness: {
				type: "string" as const,
				description:
					"Filter by content freshness (pd=day, pw=week, pm=month, py=year)",
			},
		},
		required: ["query"],
	};

	async execute(
		args: Record<string, unknown>,
		context: ToolContext,
	): Promise<ToolResult> {
		try {
			// Check if web search is enabled for this server
			if (!this.isEnabled(context)) {
				return {
					success: false,
					error: "Web search is disabled for this server",
					message: "Web search functionality is not enabled for this server.",
				};
			}

			log.info(`Executing ${this.name} with query: ${args.query}`);

			// Send search status embed to Discord
			await sendStandardEmbed(context.channel, context.locale, {
				titleKey: "genai.search.video_search_title",
				titleVars: { query: args.query as string },
				descriptionKey: "genai.search.disclaimer_description",
			});

			// Add server ID from context
			const enhancedContext = {
				...context,
				serverId: this.getServerId(context),
			};

			const result = await brave_video_search(args, enhancedContext);
			return this.convertToToolResult(result);
		} catch (error) {
			log.error(`Error in ${this.name}:`, error as Error);
			return {
				success: false,
				error: `Failed to execute video search: ${(error as Error).message}`,
			};
		}
	}
}

// =============================================
// Brave News Search Tool
// =============================================

/**
 * Brave News Search Tool
 * HTTP-based implementation for news search functionality
 */
export class BraveNewsSearchTool extends BaseBraveSearchTool {
	name = "brave_news_search";
	description =
		"Search for news articles using Brave Search API. Returns relevant news articles with metadata and publication information.";

	parameters = {
		type: "object" as const,
		properties: {
			query: {
				type: "string" as const,
				description: "The news search query to execute",
			},
			country: {
				type: "string" as const,
				description: "Country code for localized results (e.g., US, GB, JP)",
			},
			search_lang: {
				type: "string" as const,
				description: "Search language preference (e.g., en, es, jp)",
			},
			count: {
				type: "number" as const,
				description: "Number of news results to return (max 50)",
			},
			offset: {
				type: "number" as const,
				description: "Offset for pagination (0-9)",
			},
			safesearch: {
				type: "string" as const,
				description: "Safe search level for news",
				enum: ["off", "moderate", "strict"],
			},
			freshness: {
				type: "string" as const,
				description:
					"Filter by content freshness (pd=day, pw=week, pm=month, py=year)",
			},
		},
		required: ["query"],
	};

	async execute(
		args: Record<string, unknown>,
		context: ToolContext,
	): Promise<ToolResult> {
		try {
			// Check if web search is enabled for this server
			if (!this.isEnabled(context)) {
				return {
					success: false,
					error: "Web search is disabled for this server",
					message: "Web search functionality is not enabled for this server.",
				};
			}

			log.info(`Executing ${this.name} with query: ${args.query}`);

			// Send search status embed to Discord
			await sendStandardEmbed(context.channel, context.locale, {
				titleKey: "genai.search.news_search_title",
				titleVars: { query: args.query as string },
				descriptionKey: "genai.search.disclaimer_description",
			});

			// Add server ID from context
			const enhancedContext = {
				...context,
				serverId: this.getServerId(context),
			};

			const result = await brave_news_search(args, enhancedContext);
			return this.convertToToolResult(result);
		} catch (error) {
			log.error(`Error in ${this.name}:`, error as Error);
			return {
				success: false,
				error: `Failed to execute news search: ${(error as Error).message}`,
			};
		}
	}
}
