/**
 * MCP (Model Context Protocol) Type Definitions
 * Comprehensive TypeScript interfaces for MCP server integration
 * Replaces 'any' declarations with proper type safety
 */

import type { ToolResult, ToolContext } from "./interfaces";

/**
 * Base MCP server response structure
 * Common interface for all MCP server responses
 */
export interface MCPServerResponse {
  text?: string;
  isError?: boolean;
  functionResponse?: {
    response?: {
      text?: string;
      content?: MCPContentItem[];
      /** Error envelope used by the Gemini SDK when an MCP tool call fails */
      error?: {
        content?: MCPContentItem[];
        isError?: boolean;
      };
    };
  };
  content?: MCPContentItem[];
  response?: {
    content?: MCPContentItem[];
    text?: string;
  };
  data?: MCPContentItem[];
}

/**
 * MCP content item structure
 * Represents individual content items in MCP responses
 */
interface MCPContentItem {
  type: "text" | "image" | "audio" | "video";
  text?: string;
  image_url?: string;
  url?: string;
  source_url?: string;
  original_url?: string;
  src?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Brave Search specific result interfaces
 */
interface BraveSearchWebResult {
  title: string;
  url: string;
  snippet: string;
  thumbnail?: string;
  age?: string;
  language?: string;
}

interface BraveSearchImageData {
  image_url: string;
  title?: string;
  source?: string;
  thumbnail_url?: string;
  width?: number;
  height?: number;
}

interface BraveSearchVideoData {
  video_url: string;
  title?: string;
  thumbnail_url?: string;
  duration?: string;
  source?: string;
}

/**
 * Brave Search API response structures
 */
export interface BraveWebSearchResponse extends MCPServerResponse {
  web_results?: BraveSearchWebResult[];
  query?: string;
  safesearch?: string;
  count?: number;
}

export interface BraveImageSearchResponse extends MCPServerResponse {
  image_results?: BraveSearchImageData[];
  query?: string;
  safesearch?: string;
  count?: number;
}

export interface BraveVideoSearchResponse extends MCPServerResponse {
  video_results?: BraveSearchVideoData[];
  query?: string;
  safesearch?: string;
  count?: number;
}

/**
 * DuckDuckGo & IAsk AI Search response structures
 * Response structures for the bundled @oevortex/ddg_search package
 */

/**
 * DuckDuckGo Web Search response structure (web-search tool)
 */
export interface DuckDuckGoWebSearchResponse extends MCPServerResponse {
  results?: Array<{
    title: string;
    url: string;
    snippet: string;
    rank?: number;
  }>;
  query?: string;
  page?: number;
  numResults?: number;
}

/**
 * MCP function execution context
 * Extended context specifically for MCP function execution
 */
export interface MCPExecutionContext extends ToolContext {
  serverName?: string;
  functionName: string;
  originalArgs: Record<string, unknown>;
  modifiedArgs: Record<string, unknown>;

  executionStartTime: number;
  overridesApplied?: string[];
}

/**
 * MCP server behavior handler interface
 * Defines how each MCP server should handle responses
 */
export interface MCPServerBehaviorHandler {
  /**
   * Server name this handler supports
   */
  serverName: string;

  /**
   * Process MCP function result before returning to LLM
   * @param mcpResult - Raw result from MCP server
   * @param context - Execution context with Discord channel access
   */
  processResult(
    functionName: string,
    mcpResult: MCPServerResponse,
    context: MCPExecutionContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult>;

  /**
   * @param functionName - Function name to check
   * @returns True if this handler supports the function
   */
  supportsFunction(functionName: string): boolean;
}

/**
 * MCP server configuration with enhanced typing
 * Extends the basic configuration with typed properties
 */
export interface EnhancedMCPServerConfig {
  name: string;
  displayName: string;
  npmPackage?: string;
  command?: string;
  args?: string[];
  description: string;
  requiredEnvVars: string[];
  optionalEnvVars: string[];
  enabled: boolean;
  category: "search" | "utility" | "media" | "ai" | "data";
  priority: number;
  transport: "stdio" | "http" | "websocket";
  timeout?: number;

  behaviorHandler?: string; // Class name of the behavior handler

  supportedFunctions?: string[];
  requiresAuth?: boolean;
  rateLimited?: boolean;
}

/**
 * MCP tool result with enhanced typing
 * Specific result format for MCP function executions
 */
export interface TypedMCPToolResult extends ToolResult {
  data?: {
    source: "mcp";
    functionName: string;
    serverName: string;
    rawResult: MCPServerResponse;
    executionTime: number;
    overridesApplied?: string[];

    imagesSent?: number;
    urlsFound?: number;
    fetchCapabilityReminder?: boolean;
    agentInstructions?: string;

    status: "completed" | "completed_and_sent" | "failed" | "partial";
    completionMessage?: string;

    error?: string; // For error scenarios
    searchProvider?: string; // For search-specific information
    contentLength?: number; // For fetch-specific information

    [key: string]: unknown;
  };
}

/**
 * Type guard functions for MCP response type checking
 */
export const MCPTypeGuards = {
  isBraveWebSearchResponse: (response: MCPServerResponse): response is BraveWebSearchResponse => {
    return "web_results" in response || (response.text?.includes("web search") ?? false);
  },

  isBraveImageSearchResponse: (response: MCPServerResponse): response is BraveImageSearchResponse => {
    return (
      "image_results" in response ||
      (Array.isArray(response.content) && response.content.some((item) => item.type === "image"))
    );
  },

  isBraveVideoSearchResponse: (response: MCPServerResponse): response is BraveVideoSearchResponse => {
    return "video_results" in response || (response.text?.includes("video search") ?? false);
  },

  hasImageContent: (response: MCPServerResponse): boolean => {
    if (Array.isArray(response.content)) {
      return response.content.some((item) => item.type === "image" || item.image_url);
    }
    if (Array.isArray(response.functionResponse?.response?.content)) {
      return response.functionResponse.response.content.some((item) => item.type === "image" || item.image_url);
    }
    return false;
  },

  extractImageUrls: (response: MCPServerResponse): string[] => {
    const imageUrls: string[] = [];
    const contentArrays = [
      response.functionResponse?.response?.content,
      response.content,
      response.response?.content,
      response.data,
    ].filter(Array.isArray);

    for (const contentArray of contentArrays) {
      for (const item of contentArray as MCPContentItem[]) {
        if (item?.type === "text" && item.text) {
          try {
            const imageData = JSON.parse(item.text);
            if (imageData.image_url && typeof imageData.image_url === "string") {
              imageUrls.push(imageData.image_url);
            }
          } catch {}
        } else if (item?.type === "image") {
          const possibleUrls = [item.image_url, item.url, item.source_url, item.original_url, item.src].filter(
            (url): url is string => typeof url === "string",
          );
          imageUrls.push(...possibleUrls);
        }
      }
    }

    return imageUrls;
  },
};

/**
 * Guild MCP connection state : represents an active remote MCP connection
 * for a specific guild. Managed by GuildMcpManager's connection pool.
 *
 * @property guildMcpId - Database row PK (guild_mcp_servers.guild_mcp_id)
 * @property serverId - TomoriBot internal server_id (FK to servers table)
 * @property name - Human-readable server name (unique per guild)
 * @property client - MCP SDK Client instance for this connection
 * @property callableTool - Google GenAI CallableTool from mcpToTool()
 * @property functionNames - Discovered tool names after listTools()
 * @property connectedAt - Epoch ms when the connection was established
 * @property lastUsedAt - Epoch ms of last tool execution (for TTL eviction)
 */
export interface GuildMCPConnection {
  guildMcpId: number;
  serverId: number;
  name: string;
  client: unknown; // MCP Client : typed as unknown to avoid coupling mcpTypes to SDK imports
  callableTool: unknown; // CallableTool from @google/genai : same reason
  functionNames: string[];
  connectedAt: number;
  lastUsedAt: number;
}

/**
 * Result from GuildMcpManager.testConnection() : used by MCP registration surfaces
 * to validate a remote MCP server before persisting the registration.
 */
export interface GuildMCPTestResult {
  success: boolean;
  toolCount: number;
  functionNames: string[];
  error?: string;
}

/**
 * MCP error types for better error handling
 */
export class MCPExecutionError extends Error {
  constructor(
    message: string,
    public functionName: string,
    public serverName: string,
    public originalError?: Error,
  ) {
    super(message);
    this.name = "MCPExecutionError";
  }
}

export class MCPServerNotFoundError extends Error {
  constructor(public serverName: string) {
    super(`MCP server '${serverName}' not found or not connected`);
    this.name = "MCPServerNotFoundError";
  }
}

export class MCPFunctionNotFoundError extends Error {
  constructor(public functionName: string) {
    super(`MCP function '${functionName}' not found in any connected server`);
    this.name = "MCPFunctionNotFoundError";
  }
}
