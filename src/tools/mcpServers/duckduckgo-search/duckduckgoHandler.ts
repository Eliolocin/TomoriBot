/**
 * DuckDuckGo Search MCP Server Behavior Handler
 * Provider-agnostic logic for handling DuckDuckGo Search MCP server responses
 * Future implementation for free web search functionality
 */

import { log } from "../../../utils/misc/logger";
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
	 * Supported DuckDuckGo Search functions (future implementation)
	 */
	private readonly SUPPORTED_FUNCTIONS = [
		"duckduckgo_search",
		"duckduckgo_web_search",
		// Future functions may include:
		// "duckduckgo_image_search",
		// "duckduckgo_video_search",
		// "duckduckgo_news_search",
	];

	/**
	 * Parameter overrides for DuckDuckGo Search functions
	 * DuckDuckGo doesn't require API keys and has different parameters than Brave
	 */
	private readonly PARAMETER_OVERRIDES: Record<string, Record<string, unknown>> = {
		duckduckgo_search: {
			// DuckDuckGo specific parameters
			max_results: 15, // Reasonable default for web search
			region: "us-en", // Default to US English
			// No safesearch override - DuckDuckGo handles this differently
		},
		duckduckgo_web_search: {
			max_results: 15,
			region: "us-en",
		},
		// Future: Add overrides for other DuckDuckGo functions
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
			if (functionName === "duckduckgo_search" || functionName === "duckduckgo_web_search") {
				return await this.processDuckDuckGoWebSearch(mcpResult, args);
			}

			// Handle other DuckDuckGo functions with standard processing
			return this.processStandardDuckDuckGoResult(functionName, mcpResult, context, args);
		} catch (error) {
			log.error(
				`Failed to process ${functionName} result:`,
				error as Error
			);
			return {
				success: false,
				message: "Failed to process DuckDuckGo Search result",
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
	 * Similar to Brave Search but adapted for DuckDuckGo's response format
	 * @param mcpResult - The raw MCP result from DuckDuckGo search
	 * @param args - The modified arguments used for the search (contains query)
	 * @returns Promise<TypedMCPToolResult> - Enhanced result with fetch capability reminder
	 */
	private async processDuckDuckGoWebSearch(
		mcpResult: MCPServerResponse,
		_args: Record<string, unknown>
	): Promise<TypedMCPToolResult> {
		try {
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
					? `\n\n[AGENT REMINDER] You have access to the "fetch" function call to retrieve and analyze the full content of any of these ${urlCount} web URLs from the free DuckDuckGo search. Use fetch(url="[URL]") when more detailed webpage content is needed for analysis.`
					: `\n\n[AGENT REMINDER] You have access to the "fetch" function call to retrieve and analyze the full content of any web URL the user needs. Use fetch(url="[URL]") when more detailed webpage content is needed.`;

			const enhancedMessage = originalText + fetchReminder;

			// Add a note that this is from the free DuckDuckGo search
			const prefixMessage = `[Free DuckDuckGo Search Results]\n\n${enhancedMessage}`;

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
					functionName: "duckduckgo_search",
					serverName: this.serverName,
					rawResult: mcpResult,
					executionTime: 0, // Will be set by caller
					urlsFound: urlCount,
					fetchCapabilityReminder: true,
					agentInstructions: fetchReminder.trim(),
					status: "completed",
					// DuckDuckGo specific metadata
					searchProvider: "DuckDuckGo (Free)",
				},
			};
		} catch (error) {
			log.error("Error processing DuckDuckGo search result:", error as Error);
			// Fall back to original behavior
			return {
				success: true,
				message: mcpResult.text || "DuckDuckGo search completed successfully",
				data: {
					source: "mcp",
					functionName: "duckduckgo_search",
					serverName: this.serverName,
					rawResult: mcpResult,
					executionTime: 0, // Will be set by caller
					status: "completed",
					searchProvider: "DuckDuckGo (Free)",
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

			// Successful execution - add DuckDuckGo branding
			const enhancedMessage = `[DuckDuckGo Search Results]\n\n${resultText}`;

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
					searchProvider: "DuckDuckGo (Free)",
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
}

/**
 * Export convenience function for getting the handler instance
 */
export function getDuckDuckGoHandler(): DuckDuckGoHandler {
	return new DuckDuckGoHandler();
}