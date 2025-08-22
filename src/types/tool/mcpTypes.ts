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
export interface MCPContentItem {
	type: "text" | "image" | "audio" | "video";
	text?: string;
	// Image-specific properties
	image_url?: string;
	url?: string;
	source_url?: string;
	original_url?: string;
	src?: string;
	// Metadata
	metadata?: Record<string, unknown>;
}

/**
 * Brave Search specific result interfaces
 */
export interface BraveSearchWebResult {
	title: string;
	url: string;
	snippet: string;
	thumbnail?: string;
	age?: string;
	language?: string;
}

export interface BraveSearchImageData {
	image_url: string;
	title?: string;
	source?: string;
	thumbnail_url?: string;
	width?: number;
	height?: number;
}

export interface BraveSearchVideoData {
	video_url: string;
	title?: string;
	thumbnail_url?: string;
	duration?: string;
	source?: string;
}

export interface BraveSearchNewsData {
	title: string;
	url: string;
	snippet: string;
	published_date?: string;
	source?: string;
	thumbnail_url?: string;
}

export interface BraveSearchLocalData {
	name: string;
	address?: string;
	phone?: string;
	website?: string;
	rating?: number;
	reviews?: number;
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

export interface BraveNewsSearchResponse extends MCPServerResponse {
	news_results?: BraveSearchNewsData[];
	query?: string;
	safesearch?: string;
	count?: number;
}

export interface BraveLocalSearchResponse extends MCPServerResponse {
	local_results?: BraveSearchLocalData[];
	query?: string;
	location?: string;
}

export interface BraveSummarizerResponse extends MCPServerResponse {
	summary?: string;
	source_url?: string;
	title?: string;
}

/**
 * Fetch MCP server response structure
 */
export interface FetchMCPResponse extends MCPServerResponse {
	url?: string;
	title?: string;
	markdown?: string;
	status_code?: number;
	headers?: Record<string, string>;
	error?: string;
}

/**
 * DuckDuckGo Search response structure (for future implementation)
 */
export interface DuckDuckGoSearchResponse extends MCPServerResponse {
	results?: Array<{
		title: string;
		url: string;
		snippet: string;
	}>;
	query?: string;
}

/**
 * MCP parameter override configuration
 * Defines how to override parameters for specific MCP functions
 */
export interface MCPParameterOverrides {
	[functionName: string]: Record<string, unknown>;
}

/**
 * Default parameter overrides for common MCP functions
 */
export const DEFAULT_MCP_PARAMETER_OVERRIDES: MCPParameterOverrides = {
	// Brave Search overrides
	brave_web_search: {
		count: 20,
		summary: true,
		safesearch: "off",
	},
	brave_local_search: {
		safesearch: "off",
	},
	brave_image_search: {
		count: 6,
		safesearch: "off",
	},
	brave_video_search: {
		count: 5,
		safesearch: "off",
	},
	brave_news_search: {
		safesearch: "off",
	},
	// Add more function overrides as needed
};

/**
 * MCP function execution context
 * Extended context specifically for MCP function execution
 */
export interface MCPExecutionContext extends ToolContext {
	// MCP-specific properties
	serverName?: string;
	functionName: string;
	originalArgs: Record<string, unknown>;
	modifiedArgs: Record<string, unknown>;
	
	// Execution metadata
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
	 * @param functionName - Name of the executed function
	 * @param mcpResult - Raw result from MCP server
	 * @param context - Execution context with Discord channel access
	 * @param args - Function arguments used
	 * @returns Processed tool result
	 */
	processResult(
		functionName: string,
		mcpResult: MCPServerResponse,
		context: MCPExecutionContext,
		args: Record<string, unknown>
	): Promise<ToolResult>;

	/**
	 * Apply parameter overrides for this server's functions
	 * @param functionName - Name of the function
	 * @param originalArgs - Original arguments from LLM
	 * @returns Modified arguments with overrides applied
	 */
	applyParameterOverrides(
		functionName: string,
		originalArgs: Record<string, unknown>
	): {
		modifiedArgs: Record<string, unknown>;
		overridesApplied: string[];
	};

	/**
	 * Check if this handler supports a specific function
	 * @param functionName - Function name to check
	 * @returns True if this handler supports the function
	 */
	supportsFunction(functionName: string): boolean;
}

/**
 * MCP execution statistics for monitoring
 */
export interface MCPExecutionStats {
	functionName: string;
	serverName: string;
	executionTime: number;
	success: boolean;
	overridesApplied: number;
	timestamp: Date;
	userId?: string;
	guildId?: string;
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
	
	// Handler configuration
	behaviorHandler?: string; // Class name of the behavior handler
	parameterOverrides?: Record<string, Record<string, unknown>>;
	
	// Capabilities
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
		
		// Function-specific data
		imagesSent?: number;
		urlsFound?: number;
		fetchCapabilityReminder?: boolean;
		agentInstructions?: string;
		
		// Status information
		status: "completed" | "completed_and_sent" | "failed" | "partial";
		completionMessage?: string;
		
		// Handler-specific extensions
		error?: string;          // For error scenarios
		searchProvider?: string; // For search-specific information
		contentLength?: number;  // For fetch-specific information
		
		// Allow additional properties for future extensibility
		[key: string]: unknown;
	};
}

/**
 * Type guard functions for MCP response type checking
 */
export const MCPTypeGuards = {
	isBraveWebSearchResponse: (response: MCPServerResponse): response is BraveWebSearchResponse => {
		return 'web_results' in response || (response.text?.includes('web search') ?? false);
	},

	isBraveImageSearchResponse: (response: MCPServerResponse): response is BraveImageSearchResponse => {
		return 'image_results' in response || 
		       (Array.isArray(response.content) && response.content.some(item => item.type === 'image'));
	},

	isBraveVideoSearchResponse: (response: MCPServerResponse): response is BraveVideoSearchResponse => {
		return 'video_results' in response || (response.text?.includes('video search') ?? false);
	},

	isFetchResponse: (response: MCPServerResponse): response is FetchMCPResponse => {
		return 'url' in response || 'markdown' in response || 'status_code' in response;
	},

	hasImageContent: (response: MCPServerResponse): boolean => {
		if (Array.isArray(response.content)) {
			return response.content.some(item => item.type === 'image' || item.image_url);
		}
		if (Array.isArray(response.functionResponse?.response?.content)) {
			return response.functionResponse.response.content.some(item => item.type === 'image' || item.image_url);
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
					} catch {
						// Skip malformed JSON
					}
				} else if (item?.type === "image") {
					const possibleUrls = [
						item.image_url,
						item.url,
						item.source_url,
						item.original_url,
						item.src,
					].filter((url): url is string => typeof url === "string");
					imageUrls.push(...possibleUrls);
				}
			}
		}

		return imageUrls;
	}
};

/**
 * MCP error types for better error handling
 */
export class MCPExecutionError extends Error {
	constructor(
		message: string,
		public functionName: string,
		public serverName: string,
		public originalError?: Error
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