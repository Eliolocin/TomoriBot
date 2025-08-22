/**
 * MCP (Model Context Protocol) Servers Export
 * Provider-agnostic MCP server behavior handlers and utilities
 */

// Export MCP server behavior handlers
export {
	BraveSearchHandler,
	getBraveSearchHandler,
} from "./brave-search/braveSearchHandler";

export {
	FetchHandler,
	getFetchHandler,
} from "./fetch/fetchHandler";

export {
	DuckDuckGoHandler,
	getDuckDuckGoHandler,
} from "./duckduckgo-search/duckduckgoHandler";

// Re-export common types for convenience
export type { Tool, ToolContext, ToolResult } from "../../types/tool/interfaces";

// Re-export MCP-specific types
export type {
	MCPServerBehaviorHandler,
	MCPExecutionContext,
	TypedMCPToolResult,
	EnhancedMCPServerConfig,
	MCPServerResponse,
	BraveSearchWebResult,
	BraveImageSearchResponse,
	FetchMCPResponse,
	DuckDuckGoSearchResponse,
} from "../../types/tool/mcpTypes";

// Re-export MCP utilities for convenience
export {
	getMCPExecutor,
	getMCPHandlerRegistry,
	isMCPFunction,
	executeMCPFunction,
	getAvailableMCPFunctions,
} from "../../utils/mcp/mcpExecutor";

export {
	getMCPConfigManager,
} from "../../utils/mcp/mcpConfig";

export {
	getMCPManager,
} from "../../utils/mcp/mcpManager";

/**
 * Get all available MCP server behavior handlers
 * @returns Array of handler instances
 */
export function getAllMCPHandlers(): MCPServerBehaviorHandler[] {
	return [
		getBraveSearchHandler(),
		getFetchHandler(),
		getDuckDuckGoHandler(),
	];
}

/**
 * Get MCP handler by server name
 * @param serverName - Name of the MCP server
 * @returns Handler instance or null if not found
 */
export function getMCPHandlerByName(serverName: string): MCPServerBehaviorHandler | null {
	const handlers = getAllMCPHandlers();
	return handlers.find(handler => handler.serverName === serverName) || null;
}
