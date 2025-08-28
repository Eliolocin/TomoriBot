/**
 * DuckDuckGo Search MCP Server Behavior Handler
 * Provider-agnostic logic for handling DuckDuckGo Search MCP server responses
 * Future implementation for free web search functionality
 */

import { log } from "../../../utils/misc/logger";
import { sendStandardEmbed } from "../../../utils/discord/embedHelper";
import type {
	MCPServerBehaviorHandler,
	MCPExecutionContext,
	MCPServerResponse,
	TypedMCPToolResult,
} from "../../../types/tool/mcpTypes";

/**
 * DuckDuckGo Search MCP Server Behavior Handler
 * Handles free web search functionality as an alternative to Brave Search
 * Future implementation - structure prepared for when DuckDuckGo MCP server is integrated
 */
export class DuckDuckGoHandler implements MCPServerBehaviorHandler {
	public readonly serverName = "duckduckgo-search";

	/**
	 * Supported DuckDuckGo & Felo AI Search functions
	 */
	private readonly SUPPORTED_FUNCTIONS = [
		"web-search",        // DuckDuckGo web search with HTML scraping
		"felo-search",       // Felo AI-powered search and responses
		"fetch-url",         // URL content extraction with smart filtering
		"url-metadata",      // URL metadata extraction (title, description, images)
	];

	/**
	 * Parameter overrides for DuckDuckGo & Felo AI Search functions
	 * Optimized defaults for better performance and comprehensive results
	 */
	private readonly PARAMETER_OVERRIDES: Record<string, Record<string, unknown>> = {
		"web-search": {
			numResults: 12,          // Optimal balance of results vs performance
			page: 1,                 // Always start from first page
		},
		"felo-search": {
			stream: false,           // Disable streaming for Discord compatibility
		},
		"fetch-url": {
			maxLength: 15000,        // Increased for more comprehensive content
			extractMainContent: true, // Extract main content by default
			includeLinks: true,      // Include link text for context
			includeImages: true,     // Include alt text for better understanding
		},
		"url-metadata": {
			// No overrides needed - URL is the only required parameter
		},
	};

	/**
	 * Check if this handler supports a specific function
	 * @param functionName - Function name to check
	 * @returns True if this handler supports the function
	 */
	public supportsFunction(functionName: string): boolean {
		return this.SUPPORTED_FUNCTIONS.includes(functionName);
	}

	/**
	 * Apply parameter overrides for DuckDuckGo Search functions
	 * @param functionName - Name of the function
	 * @param originalArgs - Original arguments from the AI
	 * @returns Modified arguments with overrides applied
	 */
	public applyParameterOverrides(
		functionName: string,
		originalArgs: Record<string, unknown>
	): {
		modifiedArgs: Record<string, unknown>;
		overridesApplied: string[];
	} {
		// Clone the original args to avoid mutation
		const modifiedArgs = { ...originalArgs };
		const overridesApplied: string[] = [];

		// Apply overrides if function has them configured
		const overrides = this.PARAMETER_OVERRIDES[functionName];
		if (overrides) {
			for (const [paramName, forcedValue] of Object.entries(overrides)) {
				const originalValue = modifiedArgs[paramName];
				modifiedArgs[paramName] = forcedValue;

				// Log when we override a parameter
				if (originalValue !== forcedValue) {
					overridesApplied.push(
						`${paramName}: ${originalValue} → ${forcedValue}`
					);
				}
			}

			if (overridesApplied.length > 0) {
				log.info(
					`Applied DuckDuckGo Search parameter overrides for ${functionName}: ${overridesApplied.join(", ")}`
				);
			}
		}

		return { modifiedArgs, overridesApplied };
	}

	/**
	 * Process MCP function result before returning to LLM
	 * @param functionName - Name of the executed function
	 * @param mcpResult - Raw result from MCP server
	 * @param context - Execution context with Discord channel access
	 * @param args - Function arguments used
	 * @returns Processed tool result
	 */
	public async processResult(
		functionName: string,
		mcpResult: MCPServerResponse,
		context: MCPExecutionContext,
		args: Record<string, unknown>
	): Promise<TypedMCPToolResult> {
		try {
			// Handle DuckDuckGo web search with fetch capability reminder
			if (functionName === "web-search") {
				return await this.processWebSearch(mcpResult, args, context);
			}

			// Handle Felo AI search with enhanced AI response processing
			if (functionName === "felo-search") {
				return await this.processFeloSearch(mcpResult, args, context);
			}

			// Handle URL content fetch with content optimization
			if (functionName === "fetch-url") {
				return await this.processFetchUrl(mcpResult, args);
			}

			// Handle URL metadata extraction
			if (functionName === "url-metadata") {
				return await this.processUrlMetadata(mcpResult, args);
			}

			// Fallback for any unhandled functions
			return this.processStandardDuckDuckGoResult(functionName, mcpResult, context, args);
		} catch (error) {
			log.error(
				`Failed to process ${functionName} result:`,
				error as Error
			);
			return {
				success: false,
				message: "Failed to process DuckDuckGo & Felo AI Search result",
				error: error instanceof Error ? error.message : String(error),
				data: {
					source: "mcp",
					functionName,
					serverName: this.serverName,
					rawResult: mcpResult,
					executionTime: Date.now() - context.executionStartTime,
					status: "failed",
				},
			};
		}
	}

	/**
	 * Process DuckDuckGo web search results with fetch capability reminder
	 * Enhanced HTML scraping provides comprehensive search results
	 * @param mcpResult - The raw MCP result from DuckDuckGo web search
	 * @param args - The modified arguments used for the search (contains query)
	 * @returns Promise<TypedMCPToolResult> - Enhanced result with fetch capability reminder
	 */
	private async processWebSearch(
		mcpResult: MCPServerResponse,
		args: Record<string, unknown>,
		context: MCPExecutionContext
	): Promise<TypedMCPToolResult> {
		try {
			// Send search status embed to Discord (consistent with Brave Search UX)
			await sendStandardEmbed(context.channel, context.locale, {
				titleKey: "genai.search.web_search_title",
				titleVars: { query: String(args.query || args.q || "your search") },
				descriptionKey: "genai.search.disclaimer_description",
			});

			// Check for errors or rate limits before processing
			if (mcpResult.isError || this.isRateLimitError(mcpResult)) {
				await sendStandardEmbed(context.channel, context.locale, {
					titleKey: "general.errors.duckduckgo_rate_limit.title",
					descriptionKey: "general.errors.duckduckgo_rate_limit.description",
					footerKey: "general.errors.duckduckgo_rate_limit.footer",
				});
				return {
					success: false,
					message: "DuckDuckGo search failed due to rate limiting. Consider using Brave Search for more reliable results.",
					error: mcpResult.text || "Rate limit error",
					data: {
						source: "mcp",
						functionName: "web-search",
						serverName: this.serverName,
						rawResult: mcpResult,
						executionTime: Date.now() - context.executionStartTime,
						status: "failed",
						errorType: "duckduckgo_rate_limit",
					},
				};
			}
			// Extract the original search result text
			let originalText = "";
			if (mcpResult.text) {
				originalText = mcpResult.text;
			} else if (mcpResult.functionResponse?.response?.text) {
				originalText = mcpResult.functionResponse.response.text;
			} else {
				// Fallback: try to stringify the result
				originalText = JSON.stringify(mcpResult, null, 2);
			}

			// Extract URLs from the search results to count them
			const urlPattern = /https?:\/\/[^\s\)]+/g;
			const foundUrls = originalText.match(urlPattern) || [];
			const urlCount = foundUrls.length;

			// Create an enhanced response that includes fetch capability reminder
			const fetchReminder =
				urlCount > 0
					? `\n\n[AGENT REMINDER] You have access to the "fetch-url" function to retrieve and analyze the full content of any of these ${urlCount} web URLs from the DuckDuckGo search. Use fetch-url(url="[URL]") when more detailed webpage content is needed for analysis.`
					: `\n\n[AGENT REMINDER] You have access to the "fetch-url" function to retrieve and analyze the full content of any web URL the user needs. Use fetch-url(url="[URL]") when more detailed webpage content is needed.`;

			const enhancedMessage = originalText + fetchReminder;

			// Add a note that this is from the enhanced DuckDuckGo search
			const prefixMessage = `[DuckDuckGo Web Search Results]\n\n${enhancedMessage}`;

			// Log the enhanced message
			log.info(
				`Enhanced DuckDuckGo search response: ${prefixMessage.substring(0, 200)}...`
			);
			log.info(`DuckDuckGo search - Found ${urlCount} URLs`);

			return {
				success: true,
				message: prefixMessage,
				data: {
					source: "mcp",
					functionName: "web-search",
					serverName: this.serverName,
					rawResult: mcpResult,
					executionTime: 0, // Will be set by caller
					urlsFound: urlCount,
					fetchCapabilityReminder: true,
					agentInstructions: fetchReminder.trim(),
					status: "completed",
					// DuckDuckGo specific metadata
					searchProvider: "DuckDuckGo (Enhanced HTML Scraping)",
				},
			};
		} catch (error) {
			log.error("Error processing DuckDuckGo web search result:", error as Error);
			// Fall back to original behavior
			return {
				success: true,
				message: mcpResult.text || "DuckDuckGo web search completed successfully",
				data: {
					source: "mcp",
					functionName: "web-search",
					serverName: this.serverName,
					rawResult: mcpResult,
					executionTime: 0, // Will be set by caller
					status: "completed",
					searchProvider: "DuckDuckGo (Enhanced HTML Scraping)",
				},
			};
		}
	}

	/**
	 * Process Felo AI search results with enhanced AI response processing
	 * Felo AI provides intelligent, contextual answers to user queries
	 * @param mcpResult - The raw MCP result from Felo AI search
	 * @param args - The modified arguments used for the search (contains query)
	 * @returns Promise<TypedMCPToolResult> - Enhanced AI response result
	 */
	private async processFeloSearch(
		mcpResult: MCPServerResponse,
		args: Record<string, unknown>,
		context: MCPExecutionContext
	): Promise<TypedMCPToolResult> {
		try {
			// Send search status embed to Discord (consistent with Brave Search UX)
			// Use web_search_title for AI-powered search abstraction
			await sendStandardEmbed(context.channel, context.locale, {
				titleKey: "genai.search.web_search_title",
				titleVars: { query: String(args.query || args.q || "your search") },
				descriptionKey: "genai.search.disclaimer_description",
			});

			// Check for errors or rate limits before processing
			if (mcpResult.isError || this.isRateLimitError(mcpResult)) {
				await sendStandardEmbed(context.channel, context.locale, {
					titleKey: "general.errors.duckduckgo_rate_limit.title",
					descriptionKey: "general.errors.duckduckgo_rate_limit.description",
					footerKey: "general.errors.duckduckgo_rate_limit.footer",
				});
				return {
					success: false,
					message: "Felo AI search failed due to rate limiting. Consider using Brave Search for more reliable results.",
					error: mcpResult.text || "Rate limit error",
					data: {
						source: "mcp",
						functionName: "felo-search",
						serverName: this.serverName,
						rawResult: mcpResult,
						executionTime: Date.now() - context.executionStartTime,
						status: "failed",
						errorType: "duckduckgo_rate_limit",
					},
				};
			}
			// Extract the AI response text
			let aiResponse = "";
			if (mcpResult.text) {
				aiResponse = mcpResult.text;
			} else if (mcpResult.functionResponse?.response?.text) {
				aiResponse = mcpResult.functionResponse.response.text;
			} else {
				aiResponse = JSON.stringify(mcpResult, null, 2);
			}

			// Add AI-powered branding
			const prefixMessage = `[Felo AI Search Results]\n\n${aiResponse}`;

			// Log the AI response
			log.info(`Felo AI search response: ${prefixMessage.substring(0, 200)}...`);

			return {
				success: true,
				message: prefixMessage,
				data: {
					source: "mcp",
					functionName: "felo-search",
					serverName: this.serverName,
					rawResult: mcpResult,
					executionTime: 0, // Will be set by caller
					status: "completed",
					searchProvider: "Felo AI (AI-Powered Responses)",
				},
			};
		} catch (error) {
			log.error("Error processing Felo AI search result:", error as Error);
			return {
				success: true,
				message: mcpResult.text || "Felo AI search completed successfully",
				data: {
					source: "mcp",
					functionName: "felo-search",
					serverName: this.serverName,
					rawResult: mcpResult,
					executionTime: 0, // Will be set by caller
					status: "completed",
					searchProvider: "Felo AI (AI-Powered Responses)",
				},
			};
		}
	}

	/**
	 * Process URL content fetch results with content optimization
	 * Extracts and filters web page content for analysis
	 * @param mcpResult - The raw MCP result from URL fetch
	 * @param args - The modified arguments used (contains url and settings)
	 * @returns Promise<TypedMCPToolResult> - Enhanced URL content result
	 */
	private async processFetchUrl(
		mcpResult: MCPServerResponse,
		args: Record<string, unknown>
	): Promise<TypedMCPToolResult> {
		try {
			// Extract the fetched content
			let fetchedContent = "";
			if (mcpResult.text) {
				fetchedContent = mcpResult.text;
			} else if (mcpResult.functionResponse?.response?.text) {
				fetchedContent = mcpResult.functionResponse.response.text;
			} else {
				fetchedContent = JSON.stringify(mcpResult, null, 2);
			}

			const url = args.url as string || "unknown URL";
			const maxLength = args.maxLength as number || 15000;

			// Truncate if content is too long and add note
			let processedContent = fetchedContent;
			let truncated = false;
			if (fetchedContent.length > maxLength) {
				processedContent = `${fetchedContent.substring(0, maxLength)}...\n\n[CONTENT TRUNCATED - Use url-metadata for summary or adjust maxLength parameter]`;
				truncated = true;
			}

			// Add URL fetch branding with metadata suggestion
			const metadataReminder = `\n\n[AGENT REMINDER] You can use "url-metadata" function to get structured metadata (title, description, images) for this URL: ${url}`;
			const prefixMessage = `[URL Content Fetch Results for: ${url}]\n\n${processedContent}${metadataReminder}`;

			// Log the fetch result
			log.info(`URL fetch result for ${url}: ${processedContent.substring(0, 150)}... (truncated: ${truncated})`);

			return {
				success: true,
				message: prefixMessage,
				data: {
					source: "mcp",
					functionName: "fetch-url",
					serverName: this.serverName,
					rawResult: mcpResult,
					executionTime: 0, // Will be set by caller
					status: "completed",
					url: url,
					contentLength: fetchedContent.length,
					truncated: truncated,
					maxLengthUsed: maxLength,
					metadataCapabilityReminder: true,
					searchProvider: "DuckDuckGo MCP (URL Content Extraction)",
				},
			};
		} catch (error) {
			log.error("Error processing fetch URL result:", error as Error);
			return {
				success: true,
				message: mcpResult.text || "URL fetch completed successfully",
				data: {
					source: "mcp",
					functionName: "fetch-url",
					serverName: this.serverName,
					rawResult: mcpResult,
					executionTime: 0, // Will be set by caller
					status: "completed",
					searchProvider: "DuckDuckGo MCP (URL Content Extraction)",
				},
			};
		}
	}

	/**
	 * Process URL metadata extraction results
	 * Provides structured metadata including title, description, and images
	 * @param mcpResult - The raw MCP result from URL metadata extraction
	 * @param args - The modified arguments used (contains url)
	 * @returns Promise<TypedMCPToolResult> - Structured metadata result
	 */
	private async processUrlMetadata(
		mcpResult: MCPServerResponse,
		args: Record<string, unknown>
	): Promise<TypedMCPToolResult> {
		try {
			// Extract the metadata
			let metadataContent = "";
			if (mcpResult.text) {
				metadataContent = mcpResult.text;
			} else if (mcpResult.functionResponse?.response?.text) {
				metadataContent = mcpResult.functionResponse.response.text;
			} else {
				metadataContent = JSON.stringify(mcpResult, null, 2);
			}

			const url = args.url as string || "unknown URL";

			// Add fetch content suggestion
			const fetchReminder = `\n\n[AGENT REMINDER] You can use "fetch-url" function to retrieve the full webpage content for detailed analysis: fetch-url(url="${url}")`;
			const prefixMessage = `[URL Metadata for: ${url}]\n\n${metadataContent}${fetchReminder}`;

			// Log the metadata result
			log.info(`URL metadata for ${url}: ${metadataContent.substring(0, 150)}...`);

			return {
				success: true,
				message: prefixMessage,
				data: {
					source: "mcp",
					functionName: "url-metadata",
					serverName: this.serverName,
					rawResult: mcpResult,
					executionTime: 0, // Will be set by caller
					status: "completed",
					url: url,
					fetchCapabilityReminder: true,
					searchProvider: "DuckDuckGo MCP (URL Metadata Extraction)",
				},
			};
		} catch (error) {
			log.error("Error processing URL metadata result:", error as Error);
			return {
				success: true,
				message: mcpResult.text || "URL metadata extraction completed successfully",
				data: {
					source: "mcp",
					functionName: "url-metadata",
					serverName: this.serverName,
					rawResult: mcpResult,
					executionTime: 0, // Will be set by caller
					status: "completed",
					searchProvider: "DuckDuckGo MCP (URL Metadata Extraction)",
				},
			};
		}
	}

	/**
	 * Process standard DuckDuckGo Search results for other functions
	 * @param functionName - Name of the executed function
	 * @param mcpResult - Raw result from MCP server
	 * @param context - Execution context
	 * @param args - Function arguments used
	 * @returns TypedMCPToolResult - Standard processed result
	 */
	private processStandardDuckDuckGoResult(
		functionName: string,
		mcpResult: MCPServerResponse,
		context: MCPExecutionContext,
		_args: Record<string, unknown>
	): TypedMCPToolResult {
		try {
			// Extract result text from various possible locations in MCP response
			let resultText = "";
			if (mcpResult.text) {
				resultText = mcpResult.text;
			} else if (mcpResult.functionResponse?.response?.text) {
				resultText = mcpResult.functionResponse.response.text;
			} else {
				// Fallback: try to stringify the result
				resultText = JSON.stringify(mcpResult, null, 2);
			}

			// Check if this is an error result
			if (mcpResult.isError) {
				return {
					success: false,
					message: resultText || `${functionName} execution failed`,
					error: resultText || "Unknown MCP error",
					data: {
						source: "mcp",
						functionName,
						serverName: this.serverName,
						rawResult: mcpResult,
						executionTime: Date.now() - context.executionStartTime,
						status: "failed",
					},
				};
			}

			// Successful execution - add DuckDuckGo & Felo AI branding
			const enhancedMessage = `[DuckDuckGo & Felo AI Search Results]\n\n${resultText}`;

			return {
				success: true,
				message: enhancedMessage,
				data: {
					source: "mcp",
					functionName,
					serverName: this.serverName,
					rawResult: mcpResult,
					executionTime: Date.now() - context.executionStartTime,
					status: "completed",
					searchProvider: "DuckDuckGo & Felo AI Search MCP",
				},
			};
		} catch (error) {
			log.error(
				`Error processing standard DuckDuckGo result for ${functionName}:`,
				error as Error
			);
			return {
				success: false,
				message: `Failed to process ${functionName} result`,
				error: error instanceof Error ? error.message : String(error),
				data: {
					source: "mcp",
					functionName,
					serverName: this.serverName,
					rawResult: mcpResult,
					executionTime: Date.now() - context.executionStartTime,
					status: "failed",
				},
			};
		}
	}

	/**
	 * Detect if an MCP result indicates a rate limit error
	 * @param mcpResult - The MCP server response to check
	 * @returns True if the result indicates rate limiting
	 */
	private isRateLimitError(mcpResult: MCPServerResponse): boolean {
		const errorIndicators = ["rate limit", "too many requests", "429", "throttled", "rate limited"];
		const resultText = mcpResult.text || JSON.stringify(mcpResult);
		return errorIndicators.some(indicator => 
			resultText.toLowerCase().includes(indicator)
		);
	}
}

/**
 * Export convenience function for getting the handler instance
 */
export function getDuckDuckGoHandler(): DuckDuckGoHandler {
	return new DuckDuckGoHandler();
}