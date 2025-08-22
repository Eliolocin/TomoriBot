/**
 * MCP (Model Context Protocol) Servers Export
 * Provider-agnostic MCP server behavior handlers and utilities
 */

// Import handlers for internal use
import {
	BraveSearchHandler,
	getBraveSearchHandler,
} from "./brave-search/braveSearchHandler";

import {
	FetchHandler,
	getFetchHandler,
} from "./fetch/fetchHandler";

import {
	DuckDuckGoHandler,
	getDuckDuckGoHandler,
} from "./duckduckgo-search/duckduckgoHandler";

import type { MCPServerBehaviorHandler } from "../../types/tool/mcpTypes";

// Re-export handlers for external use
export {
	BraveSearchHandler,
	getBraveSearchHandler,
};

export {
	FetchHandler,
	getFetchHandler,
};

export {
	DuckDuckGoHandler,
	getDuckDuckGoHandler,
};

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
