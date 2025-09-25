/**
 * Fetch MCP Server Behavior Handler
 * Provider-agnostic logic for handling Fetch MCP server responses
 * Handles URL content retrieval and markdown conversion
 */

import { log } from "../../../utils/misc/logger";
import type {
	MCPServerBehaviorHandler,
	MCPExecutionContext,
	MCPServerResponse,
	FetchMCPResponse,
	TypedMCPToolResult,
} from "../../../types/tool/mcpTypes";
import { MCPTypeGuards } from "../../../types/tool/mcpTypes";

/**
 * Fetch MCP Server Behavior Handler
 * Handles URL content fetching and processing
 */
export class FetchHandler implements MCPServerBehaviorHandler {
	public readonly serverName = "fetch";

	/**
	 * Supported Fetch functions
	 */
	private readonly SUPPORTED_FUNCTIONS = [
		"fetch"
	];


	/**
	 * Check if this handler supports a specific function
	 * @param functionName - Function name to check
	 * @returns True if this handler supports the function
	 */
	public supportsFunction(functionName: string): boolean {
		return this.SUPPORTED_FUNCTIONS.includes(functionName);
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
			if (functionName === "fetch") {
				return await this.processFetchResult(mcpResult, context, args);
			}

			// Fallback for unknown functions (shouldn't happen)
			return this.processStandardResult(functionName, mcpResult, context, args);
		} catch (error) {
			log.error(
				`Failed to process ${functionName} result:`,
				error as Error
			);
			return {
				success: false,
				message: "Failed to process Fetch result",
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
	 * Process Fetch MCP server results
	 * @param mcpResult - The raw MCP result from fetch
	 * @param context - Execution context
	 * @param args - The arguments used for the fetch (contains URL)
	 * @returns Promise<TypedMCPToolResult> - Processed result for the LLM
	 */
	private async processFetchResult(
		mcpResult: MCPServerResponse,
		context: MCPExecutionContext,
		args: Record<string, unknown>
	): Promise<TypedMCPToolResult> {
		try {
			// Type guard to check if this is a fetch response
			const isFetchResponse = MCPTypeGuards.isFetchResponse(mcpResult);
			const fetchResult = mcpResult as FetchMCPResponse;

			// Extract result text from various possible locations
			let resultText = "";
			let url = "";
			let title = "";
			let statusCode = 200;

			if (isFetchResponse) {
				// Handle structured fetch response
				resultText = fetchResult.markdown || fetchResult.text || "";
				url = fetchResult.url || args.url as string || "";
				title = fetchResult.title || "";
				statusCode = fetchResult.status_code || 200;

				// Check for fetch errors
				if (fetchResult.error || statusCode >= 400) {
					return {
						success: false,
						message: `Failed to fetch content from ${url}: ${fetchResult.error || `HTTP ${statusCode}`}`,
						error: fetchResult.error || `HTTP error ${statusCode}`,
						data: {
							source: "mcp",
							functionName: "fetch",
							serverName: this.serverName,
							rawResult: mcpResult,
							executionTime: Date.now() - context.executionStartTime,
							status: "failed",
						},
					};
				}
			} else {
				// Handle generic response format
				if (mcpResult.text) {
					resultText = mcpResult.text;
				} else if (mcpResult.functionResponse?.response?.text) {
					resultText = mcpResult.functionResponse.response.text;
				} else {
					// Fallback: try to stringify the result
					resultText = JSON.stringify(mcpResult, null, 2);
				}
				url = args.url as string || "";
			}

			// Check for error responses
			if (mcpResult.isError) {
				return {
					success: false,
					message: `Failed to fetch content from ${url}: ${resultText}`,
					error: resultText || "Unknown fetch error",
					data: {
						source: "mcp",
						functionName: "fetch",
						serverName: this.serverName,
						rawResult: mcpResult,
						executionTime: Date.now() - context.executionStartTime,
						status: "failed",
					},
				};
			}

			// Successful fetch - format the response for the LLM
			let formattedMessage = "";
			if (title) {
				formattedMessage = `# ${title}\n\n`;
			}
			if (url) {
				formattedMessage += `**URL:** ${url}\n\n`;
			}
			formattedMessage += resultText;

			// Truncate if the content is extremely long (to avoid token limits)
			const MAX_CONTENT_LENGTH = 8000; // Reasonable limit for LLM context
			if (formattedMessage.length > MAX_CONTENT_LENGTH) {
				formattedMessage = `${formattedMessage.substring(0, MAX_CONTENT_LENGTH)}\n\n[Content truncated due to length - this represents a portion of the full page content]`;
			}

			log.info(
				`Fetch completed successfully for ${url} - Content length: ${resultText.length} characters`
			);

			return {
				success: true,
				message: formattedMessage,
				data: {
					source: "mcp",
					functionName: "fetch",
					serverName: this.serverName,
					rawResult: mcpResult,
					executionTime: Date.now() - context.executionStartTime,
					status: "completed",
					// Additional fetch-specific metadata
					contentLength: resultText.length,
					url: url,
					title: title,
					statusCode: statusCode,
				},
			};
		} catch (error) {
			log.error("Error processing fetch result:", error as Error);
			return {
				success: false,
				message: "Failed to process fetch result",
				error: error instanceof Error ? error.message : String(error),
				data: {
					source: "mcp",
					functionName: "fetch",
					serverName: this.serverName,
					rawResult: mcpResult,
					executionTime: Date.now() - context.executionStartTime,
					status: "failed",
				},
			};
		}
	}

	/**
	 * Process standard results for unknown functions
	 * @param functionName - Name of the executed function
	 * @param mcpResult - Raw result from MCP server
	 * @param context - Execution context
	 * @param args - Function arguments used
	 * @returns TypedMCPToolResult - Standard processed result
	 */
	private processStandardResult(
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

			// Successful execution
			return {
				success: true,
				message: resultText || `${functionName} executed successfully`,
				data: {
					source: "mcp",
					functionName,
					serverName: this.serverName,
					rawResult: mcpResult,
					executionTime: Date.now() - context.executionStartTime,
					status: "completed",
				},
			};
		} catch (error) {
			log.error(
				`Error processing standard Fetch result for ${functionName}:`,
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
export function getFetchHandler(): FetchHandler {
	return new FetchHandler();
}