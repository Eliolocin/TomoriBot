/**
 * Generic tool interface for provider-agnostic function calling
 * This abstracts tools away from specific LLM provider formats
 */

import type { TomoriState } from "../db/schema";
import type { BaseGuildTextChannel, Client, Message } from "discord.js";
import type { 
	MCPServerResponse, 
	EnhancedMCPServerConfig, 
	TypedMCPToolResult,
	MCPExecutionContext 
} from "./mcpTypes";

/**
 * Tool parameter schema definition
 * Provider-agnostic parameter specification
 */
export interface ToolParameterSchema {
	type: "object";
	properties: Record<
		string,
		{
			type: "string" | "number" | "boolean" | "array" | "object";
			description: string;
			enum?: string[];
			items?: { type: string };
		}
	>;
	required: string[];
}

/**
 * Streaming context for enhanced functionality during streaming
 */
export interface StreamingContext {
	disableYouTubeProcessing: boolean; // Flag to temporarily disable YouTube function during enhanced context restart
	forceReason?: boolean; // Flag to indicate reasoning mode for enhanced AI responses
	isFromCommand?: boolean; // Flag to indicate this stream was triggered by a manual command
}

/**
 * Context passed to tool execution
 * Contains all necessary Discord and Tomori state information
 */
export interface ToolContext {
	// Discord context
	channel: BaseGuildTextChannel;
	client: Client;
	message?: Message;

	// Tomori context
	tomoriState: TomoriState;
	locale: string;

	// Provider context
	provider: string;

	// Optional additional context
	emojiStrings?: string[];
	userId?: string;
	guildId?: string;
	streamContext?: StreamingContext; // Optional streaming context for enhanced functionality
}

/**
 * Result returned by tool execution
 */
export interface ToolResult {
	success: boolean;
	data?: unknown;
	error?: string;
	message?: string;
}

/**
 * Tool category classification
 */
export type ToolCategory = "discord" | "search" | "memory" | "utility" | "mcp";

/**
 * Generic tool interface
 * All tools must implement this interface regardless of provider
 */
export interface Tool {
	// Metadata
	name: string;
	description: string;
	category: ToolCategory;

	// Provider-agnostic parameter schema
	parameters: ToolParameterSchema;

	// Execution method
	execute(
		args: Record<string, unknown>,
		context: ToolContext,
	): Promise<ToolResult>;

	// Provider compatibility check
	isAvailableFor(provider: string): boolean;

	// Optional tool configuration
	requiresPermissions?: string[];
	requiresFeatureFlag?: string;
}

/**
 * Abstract base tool class with common functionality
 */
export abstract class BaseTool implements Tool {
	abstract name: string;
	abstract description: string;
	abstract category: ToolCategory;
	abstract parameters: ToolParameterSchema;

	// Default implementation - available for all providers
	isAvailableFor(_provider: string): boolean {
		return true;
	}

	// Abstract execution method to be implemented by each tool
	abstract execute(
		args: Record<string, unknown>,
		context: ToolContext,
	): Promise<ToolResult>;

	/**
	 * Helper method to validate required parameters
	 * @param args - Arguments provided to the tool
	 * @returns ValidationResult indicating if parameters are valid
	 */
	protected validateParameters(args: Record<string, unknown>): {
		isValid: boolean;
		missingParams?: string[];
		errors?: string[];
	} {
		const missingParams: string[] = [];
		const errors: string[] = [];

		// Check required parameters
		for (const requiredParam of this.parameters.required) {
			if (
				!(requiredParam in args) ||
				args[requiredParam] === undefined ||
				args[requiredParam] === null
			) {
				missingParams.push(requiredParam);
			}
		}

		// Check parameter types
		for (const [paramName, paramValue] of Object.entries(args)) {
			if (paramValue === undefined || paramValue === null) continue;

			const paramSchema = this.parameters.properties[paramName];
			if (paramSchema) {
				const expectedType = paramSchema.type;
				const actualType = Array.isArray(paramValue)
					? "array"
					: typeof paramValue;

				if (expectedType !== actualType) {
					errors.push(
						`Parameter '${paramName}' expected type '${expectedType}' but got '${actualType}'`,
					);
				}

				// Check enum constraints
				if (paramSchema.enum && typeof paramValue === "string") {
					if (!paramSchema.enum.includes(paramValue)) {
						errors.push(
							`Parameter '${paramName}' must be one of: ${paramSchema.enum.join(", ")}`,
						);
					}
				}
			}
		}

		return {
			isValid: missingParams.length === 0 && errors.length === 0,
			missingParams: missingParams.length > 0 ? missingParams : undefined,
			errors: errors.length > 0 ? errors : undefined,
		};
	}

	/**
	 * Helper method to check if tool is enabled based on Tomori configuration
	 * @param _context - Tool context containing Tomori state
	 * @returns True if the tool should be available
	 */
	protected isEnabled(_context: ToolContext): boolean {
		// Subclasses should override this method to check specific feature flags
		return true;
	}
}

/**
 * Tool adapter interface for converting between generic tools and provider-specific formats
 */
export interface ToolAdapter {
	/**
	 * Convert a generic tool to provider-specific format
	 * @param tool - The generic tool to convert
	 * @returns Provider-specific tool definition
	 */
	convertTool(tool: Tool): Record<string, unknown>;

	/**
	 * Convert tool result back to provider-specific format
	 * @param result - The generic tool result
	 * @returns Provider-specific result format
	 */
	convertResult(result: ToolResult): Record<string, unknown>;

	/**
	 * Get the provider name this adapter supports
	 * @returns Provider identifier
	 */
	getProviderName(): string;
}

/**
 * Enhanced tool adapter interface that includes MCP capabilities
 * Provides provider-agnostic access to both built-in and MCP tools
 */
export interface MCPCapableToolAdapter extends ToolAdapter {
	/**
	 * Get all available tools (built-in + MCP) in provider-specific format
	 * @param builtInTools - Array of built-in tools
	 * @returns Combined provider-specific tool configuration
	 */
	getAllToolsInProviderFormat(builtInTools: Tool[]): Promise<Array<Record<string, unknown>>>;

	/**
	 * Check if a function name belongs to an MCP tool
	 * @param functionName - Name of the function to check
	 * @returns Promise<boolean> - True if this is an MCP tool function
	 */
	isMCPFunction(functionName: string): Promise<boolean>;

	/**
	 * Execute an MCP tool function
	 * @param functionName - Name of the MCP function to execute
	 * @param args - Arguments for the function
	 * @param context - Tool execution context for Discord operations
	 * @returns Promise<TypedMCPToolResult> - Enhanced typed tool result
	 */
	executeMCPFunction(functionName: string, args: Record<string, unknown>, context?: ToolContext): Promise<TypedMCPToolResult>;
}

/**
 * MCP tool execution context
 * Additional context specific to MCP tool execution
 */
export interface MCPToolContext extends ToolContext {
	// MCP-specific context
	mcpServerName?: string;
	mcpFunctionName: string;
	
	// Provider-specific MCP data
	providerMcpData?: Record<string, unknown>;
}

/**
 * MCP tool result with additional metadata
 * Extends ToolResult with MCP-specific information
 * @deprecated Use TypedMCPToolResult from mcpTypes.ts for better type safety
 */
export interface MCPToolResult extends ToolResult {
	// MCP source information
	source: "mcp";
	functionName: string;
	serverName?: string;
	
	// Raw MCP result for debugging/logging
	rawResult?: MCPServerResponse;
	
	// Execution metadata
	executionTime?: number;
	providerFormat?: Record<string, unknown>;
}

/**
 * MCP server configuration interface
 * Provider-agnostic configuration for MCP servers
 * @deprecated Use EnhancedMCPServerConfig from mcpTypes.ts for better type safety
 */
export interface MCPServerConfig {
	name: string;
	displayName: string;
	command: string;
	args: string[];
	env?: Record<string, string>;
	requiresApiKey?: boolean;
	apiKeyEnvVar?: string;
	timeout?: number;
}

/**
 * MCP manager interface for provider-agnostic MCP management
 * Defines the contract for managing MCP servers regardless of LLM provider
 */
export interface MCPManagerInterface {
	/**
	 * Initialize all available MCP servers during application startup
	 * @returns Promise<void>
	 */
	initializeMCPServers(): Promise<void>;

	/**
	 * Check if MCP manager is ready (initialization completed)
	 * @returns boolean
	 */
	isReady(): boolean;

	/**
	 * Get count of connected MCP servers
	 * @returns number
	 */
	getConnectedServerCount(): number;

	/**
	 * Get connection status for all MCP servers
	 * @returns Record<string, boolean>
	 */
	getConnectionStatus(): Record<string, boolean>;

	/**
	 * Get MCP tools available for a specific provider
	 * @param provider - Provider name (google, openai, anthropic, etc.)
	 * @returns Promise<unknown[]> - Provider-specific MCP tools
	 */
	getMCPToolsForProvider(provider: string): Promise<unknown[]>;

	/**
	 * Execute an MCP function with provider-agnostic result
	 * @param functionName - Name of the function to execute
	 * @param args - Function arguments
	 * @param context - Optional execution context for Discord operations
	 * @returns Promise<TypedMCPToolResult> - Enhanced typed result
	 */
	executeMCPFunction(
		functionName: string, 
		args: Record<string, unknown>,
		context?: MCPExecutionContext
	): Promise<TypedMCPToolResult>;

	/**
	 * Get available MCP function names across all connected servers
	 * @returns Promise<string[]>
	 */
	getAvailableMCPFunctions(): Promise<string[]>;

	/**
	 * Get MCP server configurations
	 * @returns Promise<EnhancedMCPServerConfig[]>
	 */
	getServerConfigurations(): Promise<EnhancedMCPServerConfig[]>;

	/**
	 * Check if a specific MCP function is available
	 * @param functionName - Name of the function to check
	 * @returns Promise<boolean>
	 */
	isFunctionAvailable(functionName: string): Promise<boolean>;

	/**
	 * Get the server name that provides a specific function
	 * @param functionName - Name of the function
	 * @returns Promise<string | null>
	 */
	getServerForFunction(functionName: string): Promise<string | null>;

	/**
	 * Cleanup all MCP connections (for graceful shutdown)
	 * @returns Promise<void>
	 */
	cleanup(): Promise<void>;
}

/**
 * Tool execution event for monitoring and debugging
 */
export interface ToolExecutionEvent {
	toolName: string;
	provider: string;
	serverId: string;
	userId?: string;
	parameters: Record<string, unknown>;
	result: ToolResult;
	executionTime: number;
	timestamp: Date;
}

/**
 * Tool registry interface for managing all available tools
 */
export interface ToolRegistryInterface {
	/**
	 * Register a new tool
	 * @param tool - The tool to register
	 */
	registerTool(tool: Tool): void;

	/**
	 * Get a tool by name
	 * @param name - Tool name
	 * @returns The tool instance or undefined if not found
	 */
	getTool(name: string): Tool | undefined;

	/**
	 * Get all tools available for a specific provider
	 * @param provider - Provider name
	 * @param context - Tool context for feature flag checking
	 * @returns Array of available tools
	 */
	getAvailableTools(provider: string, context: ToolContext): Tool[];

	/**
	 * Get all registered tools
	 * @returns Array of all tools
	 */
	getAllTools(): Tool[];

	/**
	 * Execute a tool by name
	 * @param toolName - Name of the tool to execute
	 * @param args - Arguments for the tool
	 * @param context - Execution context
	 * @returns Tool execution result
	 */
	executeTool(
		toolName: string,
		args: Record<string, unknown>,
		context: ToolContext,
	): Promise<ToolResult>;
}
