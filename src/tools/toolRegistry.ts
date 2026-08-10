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
  MCPCapableToolAdapter,
} from "../types/tool/interfaces";
import { getGuildMcpManager } from "../utils/mcp/guildMcpManager";
import { MessageIdMap } from "@/utils/text/messageIdMap";
import { redactToolParametersForStorage } from "@/utils/tools/toolParameterRedaction";
import {
  getAvailableToolsForContext as getAvailableToolsForContextFromRegistry,
  getAvailableToolsForProvider,
  getAvailableToolsWithMCP as getAvailableToolsWithMCPFromRegistry,
  type AvailableToolsWithMCP,
  type ToolStateForContext,
} from "@/tools/availability";

const BUILTIN_TOOL_ALIASES: Record<string, string> = {
  remember_this_fact: "create_long_term_memory",
};

function resolveBuiltInToolAlias(toolName: string): string {
  return BUILTIN_TOOL_ALIASES[toolName] ?? toolName;
}

function resolveOpaqueIds(args: Record<string, unknown>, messageIdMap?: MessageIdMap): Record<string, unknown> {
  if (!messageIdMap) {
    return args;
  }

  let resolvedArgs: Record<string, unknown> | undefined;

  for (const key of ["media_id", "message_id", "end_message_id"] as const) {
    const value = args[key];
    if (typeof value !== "string" || !MessageIdMap.isOpaqueKey(value)) {
      continue;
    }

    const resolvedValue = messageIdMap.resolve(value);
    if (!resolvedValue) {
      log.warn(`Failed to resolve opaque ${key} "${value}" before tool execution`);
      continue;
    }

    resolvedArgs ??= { ...args };
    resolvedArgs[key] = resolvedValue;
    resolvedArgs[`__original_${key}`] = value;
  }

  return resolvedArgs ?? args;
}

export type { ToolContext } from "../types/tool/interfaces";
export type { ToolStateForContext } from "@/tools/availability";

/**
 * Central registry for all tools
 * Implements singleton pattern to ensure single source of truth
 * Now includes seamless MCP tool support alongside built-in tools
 */
class ToolRegistryImpl implements ToolRegistryInterface {
  private tools = new Map<string, Tool>();
  private executionHistory: ToolExecutionEvent[] = [];
  private readonly maxHistorySize = 1000;
  private mcpAdapters = new Map<string, MCPCapableToolAdapter>();

  /**
   * @throws Error if tool with same name already exists
   */
  registerTool(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool with name '${tool.name}' is already registered`);
    }

    this.validateTool(tool);

    this.tools.set(tool.name, tool);
    log.info(`Registered tool: ${tool.name} (category: ${tool.category})`);
  }

  /**
   * @param name - Tool name to lookup
   * @returns Tool instance or undefined if not found
   */
  getTool(name: string): Tool | undefined {
    const resolvedName = resolveBuiltInToolAlias(name);
    return this.tools.get(resolvedName);
  }

  /**
   * @param provider - Provider name (e.g., "google", "openai")
   * @param context - Tool context for checking feature flags and permissions
   */
  getAvailableTools(provider: string, context: ToolContext): Tool[] {
    return getAvailableToolsForProvider(this.tools.values(), provider, context);
  }

  /**
   * Get tools available for context building (only checks feature flags, no Discord permissions)
   * Used when building context instructions where we don't have full Discord context
   * @param provider - Provider name (e.g., "google", "openai")
   */
  getAvailableToolsForContext(provider: string, stateForContext: ToolStateForContext): Tool[] {
    return getAvailableToolsForContextFromRegistry(this.tools.values(), provider, stateForContext);
  }

  /**
   * Get all available tools (built-in + MCP) with feature flag filtering
   * This is the new centralized method that replaces provider-specific filtering
   * @param provider - Provider name (e.g., "google", "openai")
   */
  async getAvailableToolsWithMCP(
    provider: string,
    stateForContext: ToolStateForContext,
  ): Promise<AvailableToolsWithMCP> {
    return getAvailableToolsWithMCPFromRegistry(this.tools.values(), provider, stateForContext);
  }

  /**
   * Get all registered tools
   */
  getAllTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Register an MCP-capable tool adapter for a provider
   * @param adapter - The MCP-capable tool adapter to register
   */
  registerMCPAdapter(adapter: MCPCapableToolAdapter): void {
    const provider = adapter.getProviderName();
    this.mcpAdapters.set(provider, adapter);
    log.info(`Registered MCP adapter for provider: ${provider}`);
  }

  /**
   * Check if a function name is an MCP function for the given provider
   * @returns Promise<boolean> - True if this is an MCP function
   */
  async isMCPFunction(functionName: string, provider: string): Promise<boolean> {
    const adapter = this.mcpAdapters.get(provider);
    if (!adapter) {
      return false;
    }

    try {
      return await adapter.isMCPFunction(functionName);
    } catch (error) {
      log.warn(`Error checking if function '${functionName}' is MCP for provider '${provider}':`, error as Error);
      return false;
    }
  }

  /**
   * Check if a tool requires a follow-up generation after execution
   * Built-in tools check the `requiresFollowUp` property; MCP tools (global + guild) always return true
   * (all MCP tools are search/fetch and need the model to present results)
   * @param provider - Provider name for MCP adapter lookup
   * @param serverId - Optional internal server_id for guild MCP check
   * @returns Promise<boolean> - True if the tool needs a follow-up generation
   */
  async requiresFollowUp(functionName: string, provider: string, serverId?: number): Promise<boolean> {
    const resolvedFunctionName = resolveBuiltInToolAlias(functionName);

    // Check if it's a global MCP function : all MCP tools require follow-up
    const isMcp = await this.isMCPFunction(resolvedFunctionName, provider);
    if (isMcp) {
      return true;
    }

    // Check if it's a guild MCP function : also requires follow-up
    if (serverId) {
      try {
        const isGuildMcp = await getGuildMcpManager().isGuildMCPFunction(serverId, resolvedFunctionName);
        if (isGuildMcp) return true;
      } catch {}
    }

    const tool = this.getTool(resolvedFunctionName);
    return tool?.requiresFollowUp ?? false;
  }

  /**
   * Execute a tool by name with given arguments and context
   * Now supports built-in tools, global MCP, and guild MCP functions seamlessly
   */
  async executeTool(toolName: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const startTime = Date.now();
    const resolvedToolName = resolveBuiltInToolAlias(toolName);
    const resolvedArgs = resolveOpaqueIds(args, context.messageIdMap);

    const isMcp = await this.isMCPFunction(resolvedToolName, context.provider);
    if (isMcp) {
      return this.executeMCPFunction(resolvedToolName, resolvedArgs, context, startTime);
    }

    const serverId = context.tomoriState?.server_id;
    if (serverId) {
      try {
        const guildMcpManager = getGuildMcpManager();
        const isGuildMcp = await guildMcpManager.isGuildMCPFunction(serverId, resolvedToolName);
        if (isGuildMcp) {
          log.info(`Executing guild MCP function: ${resolvedToolName} for server ${serverId}`);
          const result = await guildMcpManager.executeGuildMCPFunction(
            serverId,
            resolvedToolName,
            resolvedArgs,
            context,
          );
          const executionTime = Date.now() - startTime;

          this.recordExecution({
            toolName: resolvedToolName,
            provider: context.provider,
            serverId: serverId.toString(),
            userId: context.userId,
            parameters: resolvedArgs,
            result,
            executionTime,
            timestamp: new Date(),
          });

          if (result.success) {
            log.success(`Guild MCP function executed successfully: ${resolvedToolName} (${executionTime}ms)`);
          } else {
            log.warn(
              `Guild MCP function execution completed with error: ${resolvedToolName} - ${result.error} (${executionTime}ms)`,
            );
          }

          return result;
        }
      } catch (error) {
        log.warn(`Error checking/executing guild MCP function '${resolvedToolName}':`, error as Error);
      }
    }

    return this.executeBuiltInTool(resolvedToolName, resolvedArgs, context, startTime);
  }

  /**
   * Execute an MCP function
   * @param startTime - Execution start time for metrics
   */
  private async executeMCPFunction(
    functionName: string,
    args: Record<string, unknown>,
    context: ToolContext,
    startTime: number,
  ): Promise<ToolResult> {
    const adapter = this.mcpAdapters.get(context.provider);

    if (!adapter) {
      const errorResult: ToolResult = {
        success: false,
        error: `No MCP adapter registered for provider '${context.provider}'`,
      };

      log.error(`MCP function execution failed - no adapter: ${functionName} for provider ${context.provider}`);

      return errorResult;
    }

    try {
      log.info(`Executing MCP function: ${functionName} for provider ${context.provider}`);

      // Execute the MCP function through the adapter
      const result = await adapter.executeMCPFunction(functionName, args, context);
      const executionTime = Date.now() - startTime;

      const executionEvent: ToolExecutionEvent = {
        toolName: functionName,
        provider: context.provider,
        serverId: context.tomoriState.server_id?.toString() || "unknown",
        userId: context.userId,
        parameters: redactToolParametersForStorage(functionName, args),
        result,
        executionTime,
        timestamp: new Date(),
      };

      this.recordExecution(executionEvent);

      if (result.success) {
        log.success(`MCP function executed successfully: ${functionName} (${executionTime}ms)`);
      } else {
        log.warn(`MCP function execution completed with error: ${functionName} - ${result.error} (${executionTime}ms)`);
      }

      return result;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      const errorResult: ToolResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };

      const executionEvent: ToolExecutionEvent = {
        toolName: functionName,
        provider: context.provider,
        serverId: context.tomoriState.server_id?.toString() || "unknown",
        userId: context.userId,
        parameters: redactToolParametersForStorage(functionName, args),
        result: errorResult,
        executionTime,
        timestamp: new Date(),
      };

      this.recordExecution(executionEvent);

      log.error(
        `MCP function execution threw error: ${functionName} for provider ${context.provider} (${executionTime}ms)`,
        error as Error,
      );

      return errorResult;
    }
  }

  /**
   * @param args - Tool arguments
   * @param startTime - Execution start time for metrics
   */
  private async executeBuiltInTool(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
    startTime: number,
  ): Promise<ToolResult> {
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

    // Static provider support and live turn availability must stay separate:
    // `error` is fed back to the model, and reporting a per-turn rejection
    // ("already ran this turn") as a provider capability gap teaches the persona
    // it cannot do something it can.
    if (!tool.isAvailableFor(context.provider)) {
      const errorResult: ToolResult = {
        success: false,
        error: `Tool '${toolName}' is not available for provider '${context.provider}'`,
      };

      log.error(`Tool execution failed - provider not supported: ${toolName} for provider ${context.provider}`);

      return errorResult;
    }

    if (tool.isAvailableForContext?.(context.provider, context) === false) {
      const errorResult: ToolResult = {
        success: false,
        error:
          `Tool '${toolName}' is not available for the current turn. It has either already run this turn, or the active model or server configuration does not support it. ` +
          "Do not call it again for the rest of this turn; work with the context you already have.",
      };

      log.warn(
        `Tool execution rejected - unavailable in current turn context: ${toolName} for provider ${context.provider}`,
      );

      return errorResult;
    }

    try {
      log.info(`Executing built-in tool: ${toolName} (${tool.category}) for provider ${context.provider}`);

      const result = await tool.execute(args, context);
      const executionTime = Date.now() - startTime;

      const executionEvent: ToolExecutionEvent = {
        toolName,
        provider: context.provider,
        serverId: context.tomoriState.server_id?.toString() || "unknown",
        userId: context.userId,
        parameters: redactToolParametersForStorage(toolName, args),
        result,
        executionTime,
        timestamp: new Date(),
      };

      this.recordExecution(executionEvent);

      if (result.success) {
        log.success(`Tool executed successfully: ${toolName} (${executionTime}ms)`);
      } else {
        log.warn(`Tool execution completed with error: ${toolName} - ${result.error} (${executionTime}ms)`);
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
        parameters: redactToolParametersForStorage(toolName, args),
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
   */
  getStats(): {
    totalTools: number;
    toolsByCategory: Record<string, number>;
    recentExecutions: number;
    totalExecutions: number;
  } {
    const toolsByCategory: Record<string, number> = {};

    for (const tool of this.tools.values()) {
      toolsByCategory[tool.category] = (toolsByCategory[tool.category] || 0) + 1;
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

    if (!tool.parameters?.properties || !Array.isArray(tool.parameters.required)) {
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
   * Record a tool execution event in history
   * @param event - Execution event to record
   */
  private recordExecution(event: ToolExecutionEvent): void {
    this.executionHistory.push(event);

    if (this.executionHistory.length > this.maxHistorySize) {
      this.executionHistory = this.executionHistory.slice(-this.maxHistorySize + 100);
    }
  }
}

export const ToolRegistry = new ToolRegistryImpl();

export function registerTool(tool: Tool): void {
  ToolRegistry.registerTool(tool);
}

export function getTool(name: string): Tool | undefined {
  return ToolRegistry.getTool(name);
}

export function getAvailableTools(provider: string, context: ToolContext): Tool[] {
  return ToolRegistry.getAvailableTools(provider, context);
}

export function getAvailableToolsForContext(provider: string, stateForContext: ToolStateForContext): Tool[] {
  return ToolRegistry.getAvailableToolsForContext(provider, stateForContext);
}

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  return ToolRegistry.executeTool(toolName, args, context);
}

export function registerMCPAdapter(adapter: MCPCapableToolAdapter): void {
  ToolRegistry.registerMCPAdapter(adapter);
}

export async function isMCPFunction(functionName: string, provider: string): Promise<boolean> {
  return ToolRegistry.isMCPFunction(functionName, provider);
}

export async function requiresFollowUp(functionName: string, provider: string, serverId?: number): Promise<boolean> {
  return ToolRegistry.requiresFollowUp(functionName, provider, serverId);
}

export async function getAvailableToolsWithMCP(
  provider: string,
  stateForContext: ToolStateForContext,
): Promise<{
  builtInTools: Tool[];
  mcpFunctionNames: string[];
  totalCount: number;
}> {
  return ToolRegistry.getAvailableToolsWithMCP(provider, stateForContext);
}
