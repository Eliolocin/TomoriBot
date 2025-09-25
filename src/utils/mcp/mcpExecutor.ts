/**
 * MCP Execution Utilities
 * Provider-agnostic utilities for executing MCP functions
 * Extracted from googleToolAdapter.ts for universal use across all providers
 */

import { log } from "../misc/logger";
import { getMCPManager } from "./mcpManager";
import type {
	MCPExecutionContext,
	MCPServerBehaviorHandler,
	MCPServerResponse,
	TypedMCPToolResult,
} from "../../types/tool/mcpTypes";
import {
	MCPExecutionError,
	MCPFunctionNotFoundError,
	MCPServerNotFoundError,
} from "../../types/tool/mcpTypes";
import type { ToolContext } from "../../types/tool/interfaces";
import { getBraveSearchHandler } from "../../tools/mcpServers/brave-search/braveSearchHandler";
import { getFetchHandler } from "../../tools/mcpServers/fetch/fetchHandler";
import { getDuckDuckGoHandler } from "../../tools/mcpServers/duckduckgo-search/duckduckgoHandler";

/**
 * Registry of MCP server behavior handlers
 * Maps server names to their behavior handlers
 */
class MCPHandlerRegistry {
	private static instance: MCPHandlerRegistry;
	private handlers: Map<string, MCPServerBehaviorHandler> = new Map();

	/**
	 * Get singleton instance
	 */
	static getInstance(): MCPHandlerRegistry {
		if (!MCPHandlerRegistry.instance) {
			MCPHandlerRegistry.instance = new MCPHandlerRegistry();
		}
		return MCPHandlerRegistry.instance;
	}

	/**
	 * Private constructor - initialize with default handlers
	 */
	private constructor() {
		this.initializeDefaultHandlers();
	}

	/**
	 * Initialize the default MCP server handlers
	 */
	private initializeDefaultHandlers(): void {
		// Register built-in handlers
		this.registerHandler(getBraveSearchHandler());
		this.registerHandler(getFetchHandler());
		this.registerHandler(getDuckDuckGoHandler());

		log.info(
			`MCP Handler Registry initialized with ${this.handlers.size} handlers: ${Array.from(this.handlers.keys()).join(", ")}`,
		);
	}

	/**
	 * Register a new MCP server behavior handler
	 * @param handler - The handler to register
	 */
	public registerHandler(handler: MCPServerBehaviorHandler): void {
		this.handlers.set(handler.serverName, handler);
		log.info(`Registered MCP handler for server: ${handler.serverName}`);
	}

	/**
	 * Get handler for a specific server
	 * @param serverName - Name of the MCP server
	 * @returns The handler or null if not found
	 */
	public getHandler(serverName: string): MCPServerBehaviorHandler | null {
		return this.handlers.get(serverName) || null;
	}

	/**
	 * Find handler that supports a specific function
	 * @param functionName - Name of the function to find handler for
	 * @returns The handler that supports the function or null
	 */
	public findHandlerForFunction(
		functionName: string,
	): MCPServerBehaviorHandler | null {
		for (const handler of this.handlers.values()) {
			if (handler.supportsFunction(functionName)) {
				return handler;
			}
		}
		return null;
	}

	/**
	 * Get all registered handler names
	 * @returns Array of server names that have handlers
	 */
	public getRegisteredHandlers(): string[] {
		return Array.from(this.handlers.keys());
	}
}

/**
 * MCP Executor Class
 * Provider-agnostic MCP function execution with proper error handling and result processing
 */
export class MCPExecutor {
	private static instance: MCPExecutor;
	private handlerRegistry: MCPHandlerRegistry;

	/**
	 * Get singleton instance
	 */
	static getInstance(): MCPExecutor {
		if (!MCPExecutor.instance) {
			MCPExecutor.instance = new MCPExecutor();
		}
		return MCPExecutor.instance;
	}

	/**
	 * Private constructor
	 */
	private constructor() {
		this.handlerRegistry = MCPHandlerRegistry.getInstance();
	}

	/**
	 * Apply business rules for MCP function parameters
	 * @param functionName - Name of the MCP function
	 * @param args - Original arguments
	 * @returns Modified arguments with business rules applied
	 */
	private applyBusinessRules(
		functionName: string,
		args: Record<string, unknown>,
	): Record<string, unknown> {
		const modifiedArgs = { ...args };

		// Apply business rules based on function name
		switch (functionName) {
			case "brave_web_search":
				modifiedArgs.count = 20; // Always 20 for optimal performance
				modifiedArgs.summary = true; // Always enabled for better results
				modifiedArgs.safesearch = "off"; // Always off (business requirement)
				break;

			case "brave_local_search":
				modifiedArgs.safesearch = "off"; // Always off (business requirement)
				break;

			case "brave_image_search":
				// Allow AI to override count, but limit to max 10 and default to 3
				modifiedArgs.count = Math.min(Number(modifiedArgs.count) || 3, 10);
				modifiedArgs.safesearch = "off"; // Always off (business requirement)
				break;

			case "brave_video_search":
				// Allow AI to override count, but limit to max 10 and default to 5
				modifiedArgs.count = Math.min(Number(modifiedArgs.count) || 5, 10);
				modifiedArgs.safesearch = "off"; // Always off (business requirement)
				break;

			case "brave_news_search":
				modifiedArgs.safesearch = "off"; // Always off (business requirement)
				break;

			// DuckDuckGo Search functions
			case "web-search":
				modifiedArgs.numResults = Math.min(Number(modifiedArgs.numResults) || 12, 20); // Default 12, max 20
				modifiedArgs.page = 1; // Always start from first page
				break;

			case "felo-search":
				modifiedArgs.stream = false; // Disable streaming for Discord compatibility
				break;

			case "fetch-url":
				modifiedArgs.maxLength = Math.min(Number(modifiedArgs.maxLength) || 15000, 50000); // Default 15k, max 50k
				modifiedArgs.extractMainContent = modifiedArgs.extractMainContent !== false; // Default true
				modifiedArgs.includeLinks = modifiedArgs.includeLinks !== false; // Default true
				modifiedArgs.includeImages = modifiedArgs.includeImages !== false; // Default true
				break;

			// Add more function-specific rules as needed
			default:
				// No modifications for other functions
				break;
		}

		return modifiedArgs;
	}

	/**
	 * Check if a function name belongs to an MCP tool
	 * @param functionName - Name of the function to check
	 * @returns Promise<boolean> - True if this is an MCP tool function
	 */
	public async isMCPFunction(functionName: string): Promise<boolean> {
		try {
			const mcpManager = getMCPManager();
			if (!mcpManager.isReady()) {
				return false;
			}

			const mcpTools = mcpManager.getMCPTools();
			for (const mcpTool of mcpTools) {
				try {
					const geminiTool = await mcpTool.tool();
					const mcpFunctionNames =
						geminiTool.functionDeclarations?.map((f) => f.name) || [];
					if (mcpFunctionNames.includes(functionName)) {
						return true;
					}
				} catch (error) {
					log.warn("Error checking MCP tool functions:", error as Error);
				}
			}

			return false;
		} catch (error) {
			log.error("Error checking if function is MCP:", error as Error);
			return false;
		}
	}

	/**
	 * Execute an MCP function with provider-agnostic result processing
	 * @param functionName - Name of the MCP function to execute
	 * @param args - Arguments for the function
	 * @param context - Tool execution context for Discord operations
	 * @returns Promise<TypedMCPToolResult> - Standardized tool result
	 */
	public async executeMCPFunction(
		functionName: string,
		args: Record<string, unknown>,
		context?: ToolContext,
	): Promise<TypedMCPToolResult> {
		const executionStartTime = Date.now();

		try {
			const mcpManager = getMCPManager();
			if (!mcpManager.isReady()) {
				throw new MCPExecutionError(
					"MCP manager not ready",
					functionName,
					"unknown",
				);
			}

			// Find the appropriate behavior handler for this function
			const handler = this.handlerRegistry.findHandlerForFunction(functionName);
			if (!handler) {
				log.warn(
					`No behavior handler found for function '${functionName}', using default processing`,
				);
			}

			// Create MCP execution context
			const mcpContext: MCPExecutionContext = context ? {
				...context, // Spread the tool context if it exists
				functionName,
				originalArgs: { ...args },
				modifiedArgs: { ...args },
				executionStartTime,
				serverName: handler?.serverName || "unknown",
			} : {
				// Create minimal context if none provided
				functionName,
				originalArgs: { ...args },
				modifiedArgs: { ...args },
				executionStartTime,
				serverName: handler?.serverName || "unknown",
			} as unknown as MCPExecutionContext;

			// Apply business rules for parameters before sending to MCP server
			mcpContext.modifiedArgs = this.applyBusinessRules(functionName, args);

			// Find and execute the MCP function
			const mcpTools = mcpManager.getMCPTools();
			for (const mcpTool of mcpTools) {
				try {
					const geminiTool = await mcpTool.tool();
					const mcpFunctionNames =
						geminiTool.functionDeclarations?.map((f) => f.name) || [];

					if (mcpFunctionNames.includes(functionName)) {
						// Execute the MCP function
						log.info(`Executing MCP function: ${functionName}`);

						const mcpResult = await mcpTool.callTool([
							{ name: functionName, args: mcpContext.modifiedArgs },
						]);

						// Process the result
						if (mcpResult && mcpResult.length > 0) {
							const firstResult = mcpResult[0];

							// Use behavior handler for processing if available
							if (handler) {
								const processedResult = await handler.processResult(
									functionName,
									firstResult,
									mcpContext,
									mcpContext.modifiedArgs,
								);

								// Cast to TypedMCPToolResult and ensure execution time is set correctly
								const typedResult = processedResult as TypedMCPToolResult;
								if (typedResult.data) {
									typedResult.data.executionTime = Date.now() - executionStartTime;
								}
								return typedResult;
							}

							// Default processing if no handler
							return this.processDefaultMCPResult(
								functionName,
								firstResult,
								mcpContext,
							);
						} else {
							throw new MCPExecutionError(
								"MCP function returned no results",
								functionName,
								handler?.serverName || "unknown",
							);
						}
					}
				} catch (error) {
					if (error instanceof MCPExecutionError) {
						throw error;
					}
					log.warn(
						`Error executing MCP function '${functionName}':`,
						error as Error,
					);
				}
			}

			// Function not found in any server
			throw new MCPFunctionNotFoundError(functionName);
		} catch (error) {
			const executionTime = Date.now() - executionStartTime;

			if (
				error instanceof MCPExecutionError ||
				error instanceof MCPFunctionNotFoundError ||
				error instanceof MCPServerNotFoundError
			) {
				// Re-throw custom MCP errors as typed results
				return {
					success: false,
					message: error.message,
					error: error.message,
					data: {
						source: "mcp",
						functionName,
						serverName: "unknown",
						rawResult: {},
						executionTime,
						status: "failed",
					},
				};
			}

			log.error(
				`Failed to execute MCP function '${functionName}':`,
				error as Error,
			);
			return {
				success: false,
				message: "MCP function execution failed",
				error: error instanceof Error ? error.message : String(error),
				data: {
					source: "mcp",
					functionName,
					serverName: "unknown",
					rawResult: {},
					executionTime,
					status: "failed",
				},
			};
		}
	}

	/**
	 * Default MCP result processing when no specific handler is available
	 * @param functionName - Name of the executed function
	 * @param mcpResult - Raw result from MCP server
	 * @param context - Execution context
	 * @returns TypedMCPToolResult - Default processed result
	 */
	private processDefaultMCPResult(
		functionName: string,
		mcpResult: MCPServerResponse,
		context: MCPExecutionContext,
	): TypedMCPToolResult {
		try {
			// Handle different MCP result formats
			if (mcpResult.text) {
				return {
					success: true,
					message: mcpResult.text,
					data: {
						source: "mcp",
						functionName,
						serverName: context.serverName || "unknown",
						rawResult: mcpResult,
						executionTime: Date.now() - context.executionStartTime,
						status: "completed",
						overridesApplied: context.overridesApplied,
					},
				};
			} else if (mcpResult.isError) {
				return {
					success: false,
					message: mcpResult.text || "MCP function execution failed",
					error: mcpResult.text || "Unknown MCP error",
					data: {
						source: "mcp",
						functionName,
						serverName: context.serverName || "unknown",
						rawResult: mcpResult,
						executionTime: Date.now() - context.executionStartTime,
						status: "failed",
					},
				};
			} else {
				// Fallback for unknown result formats
				return {
					success: true,
					message: "MCP function executed successfully",
					data: {
						source: "mcp",
						functionName,
						serverName: context.serverName || "unknown",
						rawResult: mcpResult,
						executionTime: Date.now() - context.executionStartTime,
						status: "completed",
						overridesApplied: context.overridesApplied,
					},
				};
			}
		} catch (error) {
			log.error(
				`Error in default MCP result processing for ${functionName}:`,
				error as Error,
			);
			return {
				success: false,
				message: `Failed to process ${functionName} result`,
				error: error instanceof Error ? error.message : String(error),
				data: {
					source: "mcp",
					functionName,
					serverName: context.serverName || "unknown",
					rawResult: mcpResult,
					executionTime: Date.now() - context.executionStartTime,
					status: "failed",
				},
			};
		}
	}

	/**
	 * Get all available MCP functions across all connected servers
	 * @returns Promise<string[]> - Array of available function names
	 */
	public async getAvailableMCPFunctions(): Promise<string[]> {
		try {
			const mcpManager = getMCPManager();
			if (!mcpManager.isReady()) {
				return [];
			}

			const functionNames: string[] = [];
			const mcpTools = mcpManager.getMCPTools();

			for (const mcpTool of mcpTools) {
				try {
					const geminiTool = await mcpTool.tool();
					const toolFunctionNames =
						geminiTool.functionDeclarations?.map((f) => f.name).filter((name): name is string => typeof name === "string") || [];
					functionNames.push(...toolFunctionNames);
				} catch (error) {
					log.warn("Error getting MCP tool functions:", error as Error);
				}
			}

			return functionNames;
		} catch (error) {
			log.error("Error getting available MCP functions:", error as Error);
			return [];
		}
	}

	/**
	 * Get execution statistics for monitoring
	 * @returns Basic MCP system status
	 */
	public getMCPStatus(): {
		isReady: boolean;
		connectedServers: number;
		registeredHandlers: number;
		availableHandlers: string[];
	} {
		const mcpManager = getMCPManager();
		return {
			isReady: mcpManager.isReady(),
			connectedServers: mcpManager.getConnectedServerCount(),
			registeredHandlers: this.handlerRegistry.getRegisteredHandlers().length,
			availableHandlers: this.handlerRegistry.getRegisteredHandlers(),
		};
	}
}

/**
 * Export convenience functions for getting instances
 */
export function getMCPExecutor(): MCPExecutor {
	return MCPExecutor.getInstance();
}

export function getMCPHandlerRegistry(): MCPHandlerRegistry {
	return MCPHandlerRegistry.getInstance();
}

/**
 * Export convenience functions for common MCP operations
 */
export async function isMCPFunction(functionName: string): Promise<boolean> {
	return getMCPExecutor().isMCPFunction(functionName);
}

export async function executeMCPFunction(
	functionName: string,
	args: Record<string, unknown>,
	context?: ToolContext,
): Promise<TypedMCPToolResult> {
	return getMCPExecutor().executeMCPFunction(functionName, args, context);
}

export async function getAvailableMCPFunctions(): Promise<string[]> {
	return getMCPExecutor().getAvailableMCPFunctions();
}
