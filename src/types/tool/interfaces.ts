/**
 * Generic tool interface for provider-agnostic function calling
 * This abstracts tools away from specific LLM provider formats
 */

import type { TomoriState } from "../db/schema";
import type { BaseGuildTextChannel, Client, Message } from "discord.js";

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
