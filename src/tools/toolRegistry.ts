/**
 * Central tool registry for managing all available tools
 * Provides registration, discovery, and execution of tools
 */

import { log } from "../utils/misc/logger";
import type {
	Tool,
	ToolContext,
	ToolResult,
	ToolRegistryInterface,
	ToolExecutionEvent,
} from "../types/tool/interfaces";

/**
 * Minimal state interface for context building operations
 * Contains only what's needed for feature flag checking without full Discord context
 */
export interface ToolStateForContext {
	server_id: string;
	config: {
		sticker_usage_enabled: boolean;
		google_search_enabled: boolean;
		self_teaching_enabled: boolean;
	};
}

// Re-export ToolContext for external use
export type { ToolContext } from "./toolInterfaces";

/**
 * Central registry for all tools
 * Implements singleton pattern to ensure single source of truth
 */
class ToolRegistryImpl implements ToolRegistryInterface {
	private tools = new Map<string, Tool>();
	private executionHistory: ToolExecutionEvent[] = [];
	private readonly maxHistorySize = 1000;

	/**
	 * Register a new tool in the registry
	 * @param tool - The tool to register
	 * @throws Error if tool with same name already exists
	 */
	registerTool(tool: Tool): void {
		if (this.tools.has(tool.name)) {
			throw new Error(`Tool with name '${tool.name}' is already registered`);
		}

		// Validate tool structure
		this.validateTool(tool);

		this.tools.set(tool.name, tool);
		log.info(`Registered tool: ${tool.name} (category: ${tool.category})`);
	}

	/**
	 * Get a tool by its name
	 * @param name - Tool name to lookup
	 * @returns Tool instance or undefined if not found
	 */
	getTool(name: string): Tool | undefined {
		return this.tools.get(name);
	}

	/**
	 * Get all tools available for a specific provider and context
	 * @param provider - Provider name (e.g., "google", "openai")
	 * @param context - Tool context for checking feature flags and permissions
	 * @returns Array of available tools
	 */
	getAvailableTools(provider: string, context: ToolContext): Tool[] {
		const availableTools: Tool[] = [];

		for (const tool of this.tools.values()) {
			try {
				// Check if tool supports this provider
				if (!tool.isAvailableFor(provider)) {
					continue;
				}

				// Check feature flag requirements
				if (tool.requiresFeatureFlag) {
					const isFeatureEnabled = this.checkFeatureFlag(
						tool.requiresFeatureFlag,
						context,
					);
					if (!isFeatureEnabled) {
						continue;
					}
				}

				// Check permission requirements
				if (tool.requiresPermissions && tool.requiresPermissions.length > 0) {
					const hasPermissions = this.checkPermissions(
						tool.requiresPermissions,
						context,
					);
					if (!hasPermissions) {
						continue;
					}
				}

				availableTools.push(tool);
			} catch (error) {
				log.warn(
					`Error checking availability for tool ${tool.name}: ${(error as Error).message}`,
				);
			}
		}

		log.info(
			`Found ${availableTools.length} available tools for provider: ${provider} (${availableTools.map((t) => t.name).join(", ")})`,
		);

		return availableTools;
	}

	/**
	 * Get tools available for context building (only checks feature flags, no Discord permissions)
	 * Used when building context instructions where we don't have full Discord context
	 * @param provider - Provider name (e.g., "google", "openai")
	 * @param stateForContext - Minimal state with server_id and config for feature flag checking
	 * @returns Array of tools available for this provider and configuration
	 */
	getAvailableToolsForContext(
		provider: string,
		stateForContext: ToolStateForContext,
	): Tool[] {
		const availableTools: Tool[] = [];

		for (const tool of this.tools.values()) {
			try {
				// Check if tool supports this provider
				if (!tool.isAvailableFor(provider)) {
					continue;
				}

				// Check feature flag requirements (only feature flags, no Discord permissions)
				if (tool.requiresFeatureFlag) {
					const isFeatureEnabled = this.checkFeatureFlagOnly(
						tool.requiresFeatureFlag,
						stateForContext,
					);
					if (!isFeatureEnabled) {
						continue;
					}
				}

				// Skip Discord permission checks for context building
				// Permissions will be checked during actual tool execution

				availableTools.push(tool);
			} catch (error) {
				log.warn(
					`Error checking availability for tool ${tool.name}: ${(error as Error).message}`,
				);
			}
		}

		log.info(
			`Found ${availableTools.length} available tools for context building with provider: ${provider} (${availableTools.map((t) => t.name).join(", ")})`,
		);

		return availableTools;
	}

	/**
	 * Get all registered tools
	 * @returns Array of all tools in the registry
	 */
	getAllTools(): Tool[] {
		return Array.from(this.tools.values());
	}

	/**
	 * Execute a tool by name with given arguments and context
	 * @param toolName - Name of the tool to execute
	 * @param args - Arguments to pass to the tool
	 * @param context - Execution context
	 * @returns Promise resolving to tool execution result
	 */
	async executeTool(
		toolName: string,
		args: Record<string, unknown>,
		context: ToolContext,
	): Promise<ToolResult> {
		const startTime = Date.now();
		const tool = this.getTool(toolName);

		if (!tool) {
			const errorResult: ToolResult = {
				success: false,
				error: `Tool '${toolName}' not found in registry`,
			};

			log.error(
				`Tool execution failed - tool not found: ${toolName}. Available: ${Array.from(this.tools.keys()).join(", ")}`,
			);

			return errorResult;
		}

		// Check if tool is available for this provider
		if (!tool.isAvailableFor(context.provider)) {
			const errorResult: ToolResult = {
				success: false,
				error: `Tool '${toolName}' is not available for provider '${context.provider}'`,
			};

			log.error(
				`Tool execution failed - provider not supported: ${toolName} for provider ${context.provider}`,
			);

			return errorResult;
		}

		try {
			log.info(
				`Executing tool: ${toolName} (${tool.category}) for provider ${context.provider}`,
			);

			// Execute the tool
			const result = await tool.execute(args, context);
			const executionTime = Date.now() - startTime;

			// Record execution event
			const executionEvent: ToolExecutionEvent = {
				toolName,
				provider: context.provider,
				serverId: context.tomoriState.server_id?.toString() || "unknown",
				userId: context.userId,
				parameters: args,
				result,
				executionTime,
				timestamp: new Date(),
			};

			this.recordExecution(executionEvent);

			if (result.success) {
				log.success(
					`Tool executed successfully: ${toolName} (${executionTime}ms)`,
				);
			} else {
				log.warn(
					`Tool execution completed with error: ${toolName} - ${result.error} (${executionTime}ms)`,
				);
			}

			return result;
		} catch (error) {
			const executionTime = Date.now() - startTime;
			const errorResult: ToolResult = {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};

			const executionEvent: ToolExecutionEvent = {
				toolName,
				provider: context.provider,
				serverId: context.tomoriState.server_id?.toString() || "unknown",
				userId: context.userId,
				parameters: args,
				result: errorResult,
				executionTime,
				timestamp: new Date(),
			};

			this.recordExecution(executionEvent);

			log.error(
				`Tool execution threw error: ${toolName} for provider ${context.provider} (${executionTime}ms)`,
				error as Error,
			);

			return errorResult;
		}
	}

	/**
	 * Get execution history for debugging and monitoring
	 * @param limit - Maximum number of entries to return
	 * @returns Array of recent tool execution events
	 */
	getExecutionHistory(limit = 100): ToolExecutionEvent[] {
		return this.executionHistory.slice(-limit).reverse(); // Most recent first
	}

	/**
	 * Clear the tool registry (useful for testing)
	 */
	clearRegistry(): void {
		this.tools.clear();
		this.executionHistory = [];
		log.info("Tool registry cleared");
	}

	/**
	 * Get registry statistics
	 * @returns Statistics about registered tools and executions
	 */
	getStats(): {
		totalTools: number;
		toolsByCategory: Record<string, number>;
		recentExecutions: number;
		totalExecutions: number;
	} {
		const toolsByCategory: Record<string, number> = {};

		for (const tool of this.tools.values()) {
			toolsByCategory[tool.category] =
				(toolsByCategory[tool.category] || 0) + 1;
		}

		const recentExecutions = this.executionHistory.filter(
			(event) => Date.now() - event.timestamp.getTime() < 24 * 60 * 60 * 1000, // Last 24 hours
		).length;

		return {
			totalTools: this.tools.size,
			toolsByCategory,
			recentExecutions,
			totalExecutions: this.executionHistory.length,
		};
	}

	// Private helper methods

	/**
	 * Validate tool structure and required properties
	 * @param tool - Tool to validate
	 * @throws Error if tool is invalid
	 */
	private validateTool(tool: Tool): void {
		if (!tool.name || tool.name.trim().length === 0) {
			throw new Error("Tool must have a non-empty name");
		}

		if (!tool.description || tool.description.trim().length === 0) {
			throw new Error(`Tool '${tool.name}' must have a description`);
		}

		if (!tool.category) {
			throw new Error(`Tool '${tool.name}' must have a category`);
		}

		if (
			!tool.parameters ||
			!tool.parameters.properties ||
			!Array.isArray(tool.parameters.required)
		) {
			throw new Error(`Tool '${tool.name}' must have valid parameter schema`);
		}

		if (typeof tool.execute !== "function") {
			throw new Error(`Tool '${tool.name}' must have an execute method`);
		}

		if (typeof tool.isAvailableFor !== "function") {
			throw new Error(`Tool '${tool.name}' must have an isAvailableFor method`);
		}
	}

	/**
	 * Check if a feature flag is enabled for the given context
	 * @param featureFlag - Feature flag to check
	 * @param context - Tool context
	 * @returns True if feature is enabled
	 */
	private checkFeatureFlag(featureFlag: string, context: ToolContext): boolean {
		// Map feature flags to Tomori configuration properties
		const featureFlagMap: Record<string, boolean> = {
			sticker_usage: context.tomoriState.config.sticker_usage_enabled,
			google_search: context.tomoriState.config.google_search_enabled,
			self_teaching: context.tomoriState.config.self_teaching_enabled,
		};

		return featureFlagMap[featureFlag] ?? false;
	}

	/**
	 * Check if a feature flag is enabled (for context building without full ToolContext)
	 * @param featureFlag - Feature flag to check
	 * @param stateForContext - Minimal state with configuration
	 * @returns True if feature is enabled
	 */
	private checkFeatureFlagOnly(
		featureFlag: string,
		stateForContext: ToolStateForContext,
	): boolean {
		// Map feature flags to Tomori configuration properties
		const featureFlagMap: Record<string, boolean> = {
			sticker_usage: stateForContext.config?.sticker_usage_enabled ?? false,
			google_search: stateForContext.config?.google_search_enabled ?? false,
			self_teaching: stateForContext.config?.self_teaching_enabled ?? false,
		};

		return featureFlagMap[featureFlag] ?? false;
	}

	/**
	 * Check if the context has required permissions
	 * @param requiredPermissions - Array of required permission strings
	 * @param context - Tool context
	 * @returns True if all permissions are available
	 */
	private checkPermissions(
		requiredPermissions: string[],
		context: ToolContext,
	): boolean {
		// For now, just check basic Discord permissions
		// This could be expanded to check bot permissions, user roles, etc.

		if (requiredPermissions.includes("SEND_MESSAGES")) {
			const clientUser = context.client.user;
			if (
				!clientUser ||
				!context.channel.permissionsFor(clientUser)?.has("SendMessages")
			) {
				return false;
			}
		}

		if (requiredPermissions.includes("USE_EXTERNAL_STICKERS")) {
			const clientUser = context.client.user;
			if (
				!clientUser ||
				!context.channel.permissionsFor(clientUser)?.has("UseExternalStickers")
			) {
				return false;
			}
		}

		return true;
	}

	/**
	 * Record a tool execution event in history
	 * @param event - Execution event to record
	 */
	private recordExecution(event: ToolExecutionEvent): void {
		this.executionHistory.push(event);

		// Keep history size manageable
		if (this.executionHistory.length > this.maxHistorySize) {
			this.executionHistory = this.executionHistory.slice(
				-this.maxHistorySize + 100,
			);
		}
	}
}

// Export singleton instance
export const ToolRegistry = new ToolRegistryImpl();

// Export convenience functions
export function registerTool(tool: Tool): void {
	ToolRegistry.registerTool(tool);
}

export function getTool(name: string): Tool | undefined {
	return ToolRegistry.getTool(name);
}

export function getAvailableTools(
	provider: string,
	context: ToolContext,
): Tool[] {
	return ToolRegistry.getAvailableTools(provider, context);
}

export function getAvailableToolsForContext(
	provider: string,
	stateForContext: ToolStateForContext,
): Tool[] {
	return ToolRegistry.getAvailableToolsForContext(provider, stateForContext);
}

export async function executeTool(
	toolName: string,
	args: Record<string, unknown>,
	context: ToolContext,
): Promise<ToolResult> {
	return ToolRegistry.executeTool(toolName, args, context);
}
