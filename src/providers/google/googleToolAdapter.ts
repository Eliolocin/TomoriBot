/**
 * Google Tool Adapter
 * Converts generic tools to Google's function declaration format and back
 */

import { Type } from "@google/genai";
import { log } from "../../utils/misc/logger";
import type {
	Tool,
	MCPCapableToolAdapter,
	ToolContext,
	ToolResult,
} from "../../types/tool/interfaces";
import type { TypedMCPToolResult } from "../../types/tool/mcpTypes";
import { getMCPManager } from "../../utils/mcp/mcpManager";
import { getMCPExecutor } from "../../utils/mcp/mcpExecutor";
import { isBraveSearchAvailable } from "../../tools/restAPIs/brave/braveSearchService";

/**
 * Google-specific function declaration format
 */
interface GoogleFunctionDeclaration extends Record<string, unknown> {
	name: string;
	description: string;
	parameters: {
		type: typeof Type.OBJECT;
		properties: Record<
			string,
			{
				type:
					| typeof Type.STRING
					| typeof Type.NUMBER
					| typeof Type.BOOLEAN
					| typeof Type.ARRAY
					| typeof Type.OBJECT;
				description: string;
				enum?: string[];
				items?: {
					type:
						| typeof Type.STRING
						| typeof Type.NUMBER
						| typeof Type.BOOLEAN
						| typeof Type.OBJECT;
				};
			}
		>;
		required: string[];
	};
}

/**
 * Google tool adapter implementation with MCP capabilities
 */
export class GoogleToolAdapter implements MCPCapableToolAdapter {
	private static instance: GoogleToolAdapter;

	/**
	 * Get singleton instance
	 */
	static getInstance(): GoogleToolAdapter {
		if (!GoogleToolAdapter.instance) {
			GoogleToolAdapter.instance = new GoogleToolAdapter();
		}
		return GoogleToolAdapter.instance;
	}

	/**
	 * Get the provider name this adapter supports
	 * @returns Provider identifier
	 */
	getProviderName(): string {
		return "google";
	}

	/**
	 * Convert a generic tool to Google's function declaration format
	 * @param tool - The generic tool to convert
	 * @returns Google-specific function declaration
	 */
	convertTool(tool: Tool): Record<string, unknown> {
		try {
			// Convert parameter schema to Google format
			const googleProperties: Record<
				string,
				{
					type:
						| typeof Type.STRING
						| typeof Type.NUMBER
						| typeof Type.BOOLEAN
						| typeof Type.ARRAY
						| typeof Type.OBJECT;
					description: string;
					enum?: string[];
					items?: {
						type:
							| typeof Type.STRING
							| typeof Type.NUMBER
							| typeof Type.BOOLEAN
							| typeof Type.OBJECT;
					};
				}
			> = {};

			for (const [paramName, paramSchema] of Object.entries(
				tool.parameters.properties,
			)) {
				googleProperties[paramName] = {
					type: this.convertParameterType(
						paramSchema.type as
							| "string"
							| "number"
							| "boolean"
							| "array"
							| "object",
					),
					description: paramSchema.description,
				};

				// Add enum if specified
				if (paramSchema.enum) {
					googleProperties[paramName].enum = paramSchema.enum;
				}

				// Add items for array type
				if (paramSchema.type === "array" && paramSchema.items) {
					const itemType = this.convertParameterType(
						paramSchema.items.type as
							| "string"
							| "number"
							| "boolean"
							| "object",
					);
					googleProperties[paramName].items = {
						type: itemType as
							| typeof Type.STRING
							| typeof Type.NUMBER
							| typeof Type.BOOLEAN
							| typeof Type.OBJECT,
					};
				}
			}

			const googleFunction: GoogleFunctionDeclaration = {
				name: tool.name,
				description: tool.description,
				parameters: {
					type: Type.OBJECT,
					properties: googleProperties,
					required: tool.parameters.required,
				},
			};

			log.info(
				`Converted tool '${tool.name}' (${tool.category}) to Google format with ${Object.keys(googleProperties).length} parameters`,
			);

			return googleFunction;
		} catch (error) {
			log.error(
				`Failed to convert tool '${tool.name}' (${tool.category}) to Google format`,
				error as Error,
			);
			throw error;
		}
	}

	/**
	 * Convert tool result back to Google-specific format
	 * This is used when the tool execution result needs to be fed back to Gemini
	 * @param result - The generic tool result
	 * @returns Google-specific result format (Part object)
	 */
	convertResult(result: ToolResult): Record<string, unknown> {
		try {
			// Google expects a Part object with text content
			if (result.success) {
				// Successful execution - provide meaningful result text
				let resultText = result.message || "Tool executed successfully";

				if (result.data && typeof result.data === "object") {
					const data = result.data as Record<string, unknown>;

					// Format the result based on the data structure
					if (data.summary && typeof data.summary === "string") {
						resultText = data.summary;
					} else if (data.message && typeof data.message === "string") {
						resultText = data.message;
					} else if (
						data.selectionReason &&
						typeof data.selectionReason === "string"
					) {
						resultText = data.selectionReason;
					} else {
						// Include relevant data in the result text
						const relevantData = this.extractRelevantData(data);
						if (relevantData) {
							resultText = `${resultText}\n\nResult: ${relevantData}`;
						}
					}
				}

				return {
					text: resultText,
				};
			}

			// Failed execution - provide error information
			const errorText =
				result.message || result.error || "Tool execution failed";

			return {
				text: `Error: ${errorText}`,
			};
		} catch (error) {
			log.error(
				`Failed to convert tool result to Google format (success: ${result.success}, hasData: ${!!result.data})`,
				error as Error,
			);

			return {
				text: "Error: Failed to process tool result",
			};
		}
	}

	/**
	 * Convert multiple tools to Google's tools array format
	 * @param tools - Array of generic tools
	 * @returns Google tools configuration
	 */
	convertToolsArray(tools: Tool[]): Array<Record<string, unknown>> {
		if (tools.length === 0) {
			return [];
		}

		try {
			// Convert each tool to Google function declaration
			const functionDeclarations = tools.map((tool) => this.convertTool(tool));

			// Google expects tools in this specific format
			return [
				{
					functionDeclarations: functionDeclarations,
				},
			];
		} catch (error) {
			log.error(
				`Failed to convert tools array to Google format (${tools.length} tools: ${tools.map((t) => t.name).join(", ")})`,
				error as Error,
			);
			return [];
		}
	}

	/**
	 * Get all available tools (built-in + MCP) in provider-specific format
	 * Implementation of MCPCapableToolAdapter interface
	 * @param builtInTools - Array of built-in tools
	 * @param serverId - Optional Discord server ID for server-specific tool selection
	 * @returns Combined provider-specific tools configuration
	 */
	async getAllToolsInProviderFormat(
		builtInTools: Tool[],
		serverId?: number,
	): Promise<Array<Record<string, unknown>>> {
		return this.getAllToolsInGoogleFormat(builtInTools, serverId);
	}

	/**
	 * Get all available tools (built-in + MCP) in Google tools format
	 * This provides a unified interface for the provider to get all tools
	 * @param builtInTools - Array of built-in tools
	 * @param serverId - Optional Discord server ID for server-specific tool selection
	 * @returns Combined Google tools configuration with conditional search tool filtering
	 */
	async getAllToolsInGoogleFormat(
		builtInTools: Tool[],
		serverId?: number,
	): Promise<Array<Record<string, unknown>>> {
		try {
			// Start with built-in tools
			const allFunctionDeclarations: Record<string, unknown>[] = [];

			// Check if Brave Search is available for conditional tool selection
			const hasBraveApiKey = await isBraveSearchAvailable(serverId);
			log.info(
				`Brave Search ${hasBraveApiKey ? "available" : "not available"} for server ${serverId || "global"} - implementing conditional search tool selection`,
			);

			// Brave search tool names for filtering
			const braveSearchToolNames = [
				"brave_web_search",
				"brave_image_search", 
				"brave_video_search",
				"brave_news_search",
			];

			// Filter built-in tools based on Brave API key availability
			let filteredBuiltInTools = builtInTools;
			if (!hasBraveApiKey) {
				// No Brave API key - exclude Brave search tools
				filteredBuiltInTools = builtInTools.filter(
					(tool) => !braveSearchToolNames.includes(tool.name),
				);
				const excludedCount = builtInTools.length - filteredBuiltInTools.length;
				if (excludedCount > 0) {
					log.info(
						`Excluded ${excludedCount} Brave search tools (no API key available)`,
					);
				}
			}

			// Convert filtered built-in tools
			if (filteredBuiltInTools.length > 0) {
				const builtInDeclarations = filteredBuiltInTools.map((tool) =>
					this.convertTool(tool),
				);
				allFunctionDeclarations.push(...builtInDeclarations);
				log.info(
					`Converted ${filteredBuiltInTools.length} built-in tools to Google format`,
				);
			}

			// Add MCP tools if available (with conditional filtering)
			const mcpManager = getMCPManager();
			if (mcpManager.isReady()) {
				const mcpTools = mcpManager.getMCPTools();

				// DuckDuckGo search function names for filtering
				const duckduckgoSearchFunctions = [
					"web-search",
					"felo-search",
					"fetch-url",
					"url-metadata",
				];

				let addedMCPToolsCount = 0;
				let excludedDDGFunctionsCount = 0;

				for (const mcpTool of mcpTools) {
					try {
						const geminiTool = await mcpTool.tool();
						if (geminiTool.functionDeclarations) {
							// Cast FunctionDeclaration to Record<string, unknown> for type compatibility
							let declarations = geminiTool.functionDeclarations as Record<string, unknown>[];

							// Filter out DuckDuckGo search functions if Brave API key is available
							if (hasBraveApiKey) {
								const originalCount = declarations.length;
								declarations = declarations.filter((declaration: Record<string, unknown>) => {
									const functionName = declaration.name as string;
									return !duckduckgoSearchFunctions.includes(functionName);
								});
								excludedDDGFunctionsCount += originalCount - declarations.length;
							}

							// Add remaining declarations
							if (declarations.length > 0) {
								allFunctionDeclarations.push(...declarations);
								addedMCPToolsCount++;
							}
						}
					} catch (error) {
						log.warn(
							"Failed to extract functions from MCP tool:",
							error as Error,
						);
					}
				}

				if (addedMCPToolsCount > 0) {
					log.info(`Added ${addedMCPToolsCount} MCP tools to Google format`);
				}
				if (excludedDDGFunctionsCount > 0) {
					log.info(
						`Excluded ${excludedDDGFunctionsCount} DuckDuckGo search functions (Brave API key available)`,
					);
				}
			}

			// Return in Google's expected format
			if (allFunctionDeclarations.length === 0) {
				return [];
			}

			return [
				{
					functionDeclarations: allFunctionDeclarations,
				},
			];
		} catch (error) {
			log.error("Failed to get all tools in Google format:", error as Error);
			// Return just built-in tools as fallback
			return this.convertToolsArray(builtInTools);
		}
	}

	/**
	 * Check if a function name belongs to an MCP tool
	 * Delegates to the provider-agnostic MCP executor
	 * @param functionName - Name of the function to check
	 * @returns Promise<boolean> - True if this is an MCP tool function
	 */
	async isMCPFunction(functionName: string): Promise<boolean> {
		const mcpExecutor = getMCPExecutor();
		return mcpExecutor.isMCPFunction(functionName);
	}

	/**
	 * Execute an MCP tool function
	 * Delegates to the provider-agnostic MCP executor for all processing
	 * @param functionName - Name of the MCP function to execute
	 * @param args - Arguments for the function
	 * @param context - Tool execution context for Discord operations
	 * @returns Promise<TypedMCPToolResult> - Enhanced typed tool result
	 */
	async executeMCPFunction(
		functionName: string,
		args: Record<string, unknown>,
		context?: ToolContext,
	): Promise<TypedMCPToolResult> {
		const mcpExecutor = getMCPExecutor();
		return mcpExecutor.executeMCPFunction(functionName, args, context);
	}

	// Private helper methods

	/**
	 * Convert generic parameter type to Google Type enum
	 * @param genericType - Generic parameter type
	 * @returns Google Type enum value
	 */
	private convertParameterType(
		genericType: "string" | "number" | "boolean" | "array" | "object",
	):
		| typeof Type.STRING
		| typeof Type.NUMBER
		| typeof Type.BOOLEAN
		| typeof Type.ARRAY
		| typeof Type.OBJECT {
		switch (genericType) {
			case "string":
				return Type.STRING;
			case "number":
				return Type.NUMBER;
			case "boolean":
				return Type.BOOLEAN;
			case "array":
				return Type.ARRAY;
			case "object":
				return Type.OBJECT;
			default:
				// Default to string for unknown types
				log.warn(
					`Unknown parameter type: ${genericType}, defaulting to STRING`,
				);
				return Type.STRING;
		}
	}

	/**
	 * Extract relevant data from tool result for Google response
	 * @param data - Tool result data object
	 * @returns Formatted string with relevant information
	 */
	private extractRelevantData(data: Record<string, unknown>): string | null {
		try {
			const relevantFields = [
				"summary",
				"preview",
				"selectionReason",
				"query",
				"resultLength",
			];
			const extractedData: Record<string, unknown> = {};

			for (const field of relevantFields) {
				if (data[field] !== undefined && data[field] !== null) {
					extractedData[field] = data[field];
				}
			}

			if (Object.keys(extractedData).length === 0) {
				return null;
			}

			// Format as readable text
			const entries = Object.entries(extractedData)
				.map(([key, value]) => `${key}: ${String(value)}`)
				.join(", ");

			return entries.length > 200 ? `${entries.substring(0, 200)}...` : entries;
		} catch (error) {
			log.warn(
				"Failed to extract relevant data from tool result",
				error as Error,
			);
			return null;
		}
	}

	/**
	 * Validate that a tool can be converted to Google format
	 * @param tool - Tool to validate
	 * @returns True if tool is compatible with Google format
	 */
	validateToolCompatibility(tool: Tool): boolean {
		try {
			// Check required properties
			if (!tool.name || !tool.description || !tool.parameters) {
				return false;
			}

			// Check parameter schema structure
			if (
				!tool.parameters.properties ||
				!Array.isArray(tool.parameters.required)
			) {
				return false;
			}

			// Check parameter types are supported
			for (const paramSchema of Object.values(tool.parameters.properties)) {
				const supportedTypes = [
					"string",
					"number",
					"boolean",
					"array",
					"object",
				];
				if (!supportedTypes.includes(paramSchema.type)) {
					return false;
				}
			}

			return true;
		} catch (error) {
			log.warn(
				`Tool compatibility validation failed for '${tool.name}'`,
				error as Error,
			);
			return false;
		}
	}
}

// Export convenience function for getting the adapter instance
export function getGoogleToolAdapter(): GoogleToolAdapter {
	return GoogleToolAdapter.getInstance();
}
