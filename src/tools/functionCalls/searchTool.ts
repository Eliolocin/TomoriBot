/**
 * Web Search Tool
 * Allows the AI to search the web for real-time information
 */

import { log } from "../../utils/misc/logger";
import { decryptApiKey } from "../../utils/security/crypto";
import { sendStandardEmbed } from "../../utils/discord/embedHelper";
import { ColorCode } from "../../utils/misc/logger";
import {
	BaseTool,
	type ToolContext,
	type ToolResult,
	type ToolParameterSchema,
} from "../../types/tool/interfaces";

/**
 * Tool for querying Google search to find real-time information
 */
export class SearchTool extends BaseTool {
	name = "query_google_search";
	description =
		"Queries the Google search engine with a given search term and returns a concise summary of the findings. Use this to find real-time information, facts, or details not present in your existing knowledge. You will be informed of the search result and will then generate the final text message for the user. Do NOT use on YouTube links or video content.";
	category = "search" as const;
	requiresFeatureFlag = "google_search";

	parameters: ToolParameterSchema = {
		type: "object",
		properties: {
			search_query: {
				type: "string",
				description:
					"The specific search query string to use for the Google search. Be concise and clear.",
			},
		},
		required: ["search_query"],
	};

	/**
	 * Check if search tool is available for the given provider
	 * @param _provider - LLM provider name (unused)
	 * @returns True if provider supports web search
	 */
	isAvailableFor(_provider: string): boolean {
		// Search functionality works with all providers
		return true;
	}

	/**
	 * Check if Google search functionality is enabled in Tomori config
	 * @param context - Tool execution context
	 * @returns True if Google search is enabled
	 */
	protected isEnabled(context: ToolContext): boolean {
		return context.tomoriState.config.google_search_enabled;
	}

	/**
	 * Execute web search query
	 * @param args - Arguments containing search_query
	 * @param context - Tool execution context
	 * @returns Promise resolving to tool result
	 */
	async execute(
		args: Record<string, unknown>,
		context: ToolContext,
	): Promise<ToolResult> {
		// Validate parameters
		const validation = this.validateParameters(args);
		if (!validation.isValid) {
			return {
				success: false,
				error: `Invalid parameters: ${validation.errors?.join(", ") || `Missing required parameters: ${validation.missingParams?.join(", ")}`}`,
			};
		}

		// Check if tool is enabled
		if (!this.isEnabled(context)) {
			return {
				success: false,
				error: "Google search is disabled for this server",
			};
		}

		const searchQuery = args.search_query as string;

		// Basic query validation
		if (searchQuery.trim().length === 0) {
			return {
				success: false,
				error: "Search query cannot be empty",
			};
		}

		// Check for inappropriate queries (YouTube, video content, etc.)
		const prohibitedTerms = ["youtube", "video", "watch?v=", "youtu.be"];
		const queryLower = searchQuery.toLowerCase();

		for (const term of prohibitedTerms) {
			if (queryLower.includes(term)) {
				return {
					success: false,
					error: "Video content searches are not supported",
					message:
						"I cannot search for YouTube videos or video content. Please try a different search query.",
				};
			}
		}

		try {
			log.info(`Executing Google search: "${searchQuery}"`);

			// Import the Google search sub-agent (correct function name from tomoriChat.ts:1024)
			const { executeSearchSubAgent } = await import(
				"../../providers/google/subAgents"
			);

			// 1. Send search disclaimer embed BEFORE executing the search
			// This informs the user while the search is happening
			await sendStandardEmbed(context.channel, context.locale, {
				color: ColorCode.INFO,
				titleKey: "genai.search.disclaimer_title",
				descriptionKey: "genai.search.disclaimer_description",
				descriptionVars: { query: searchQuery },
			});
			
			// 2. Send typing indicator as search might take a moment
			await context.channel.sendTyping();
			
			// 3. Execute the search using the existing Google search implementation
			// Parameters match tomoriChat.ts:1024-1031 call pattern
			const conversationHistoryString = ""; // Could be enhanced to build context
			
			// Decrypt the API key from the database
			const encryptedApiKey = context.tomoriState.config.api_key;
			if (!encryptedApiKey) {
				return {
					success: false,
					error: "No API key configured for search functionality",
				};
			}
			
			const decryptedApiKey = await decryptApiKey(encryptedApiKey);
			const searchResult = await executeSearchSubAgent(
				searchQuery,
				conversationHistoryString,
				context.tomoriState,
				decryptedApiKey,
			);

			if (!searchResult || typeof searchResult !== "object") {
				return {
					success: false,
					error: "Search returned invalid result",
					message:
						"The search query didn't return useful results. Please try a different search term.",
				};
			}

			// Extract meaningful information from search result
			let searchSummary = "";
			let searchData: unknown = null;

			if (typeof searchResult === "string") {
				searchSummary = searchResult;
			} else if (searchResult && typeof searchResult === "object") {
				// Handle structured search results
				const result = searchResult as Record<string, unknown>;

				if (result.summary && typeof result.summary === "string") {
					searchSummary = result.summary;
				} else if (result.content && typeof result.content === "string") {
					searchSummary = result.content;
				} else if (result.text && typeof result.text === "string") {
					searchSummary = result.text;
				} else {
					searchSummary = JSON.stringify(searchResult);
				}

				searchData = result;
			}

			if (searchSummary.trim().length === 0) {
				return {
					success: false,
					error: "Search returned empty results",
					message:
						"The search didn't return any useful information. Please try a more specific search query.",
				};
			}

			log.success(
				`Google search completed successfully for: "${searchQuery}" (${searchSummary.length} chars)`,
			);

			return {
				success: true,
				message: `Search completed for: "${searchQuery}"`,
				data: {
					query: searchQuery,
					summary: searchSummary,
					fullResult: searchData,
					resultLength: searchSummary.length,
					timestamp: new Date().toISOString(),
				},
			};
		} catch (error) {
			log.error(
				`Google search failed for query: "${searchQuery}"`,
				error as Error,
			);

			// Provide helpful error messages based on error type
			let errorMessage = "Search failed due to an unknown error";

			if (error instanceof Error) {
				if (error.message.includes("rate limit")) {
					errorMessage =
						"Search temporarily unavailable due to rate limiting. Please try again later.";
				} else if (error.message.includes("API")) {
					errorMessage =
						"Search service is currently unavailable. Please try again later.";
				} else if (error.message.includes("network")) {
					errorMessage =
						"Network error occurred during search. Please try again.";
				} else {
					errorMessage = error.message;
				}
			}

			return {
				success: false,
				error: errorMessage,
				message:
					"I couldn't complete the search request. Please try again with a different query or try again later.",
			};
		}
	}
}
