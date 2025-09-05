/**
 * Centralized Feature Flag Mapping for Tools
 * Maps tool names to their required feature flags for consistent filtering across all providers
 */

import { log } from "../misc/logger";

/**
 * Feature flag requirements for built-in tools
 * Key: tool name, Value: required feature flag
 */
export const BUILTIN_TOOL_FEATURE_FLAGS: Record<string, string> = {
	// Sticker tools
	select_sticker_for_response: "sticker_usage",

	// Memory/learning tools
	remember_this_fact: "self_teaching",

	// Brave Search tools (HTTP-based)
	brave_web_search: "web_search",
	brave_image_search: "web_search",
	brave_video_search: "web_search",
	brave_news_search: "web_search",
};

/**
 * Feature flag requirements for MCP tools
 * Key: MCP function name, Value: required feature flag
 */
export const MCP_TOOL_FEATURE_FLAGS: Record<string, string> = {
	// DuckDuckGo search functions
	"web-search": "web_search",
	"felo-search": "web_search",
	"fetch-url": "web_search", // Related to web search functionality
	"url-metadata": "web_search", // Related to web search functionality

	// Brave Search MCP functions (if any)
	brave_web_search: "web_search",
	brave_image_search: "web_search",
	brave_video_search: "web_search",
	brave_news_search: "web_search",
	brave_local_search: "web_search",
	brave_summarizer: "web_search",
};

/**
 * All feature flag mappings combined
 * Used for comprehensive tool filtering
 */
export const ALL_TOOL_FEATURE_FLAGS = {
	...BUILTIN_TOOL_FEATURE_FLAGS,
	...MCP_TOOL_FEATURE_FLAGS,
};

/**
 * Get the required feature flag for a tool
 * @param toolName - Name of the tool to check
 * @returns Required feature flag or undefined if no flag required
 */
export function getRequiredFeatureFlag(toolName: string): string | undefined {
	return ALL_TOOL_FEATURE_FLAGS[toolName];
}

/**
 * Check if a tool requires a specific feature flag
 * @param toolName - Name of the tool to check
 * @param featureFlag - Feature flag to check against
 * @returns True if the tool requires this feature flag
 */
export function toolRequiresFeatureFlag(
	toolName: string,
	featureFlag: string,
): boolean {
	return ALL_TOOL_FEATURE_FLAGS[toolName] === featureFlag;
}

/**
 * Get all tools that require a specific feature flag
 * @param featureFlag - Feature flag to check
 * @returns Array of tool names that require this feature flag
 */
export function getToolsRequiringFeatureFlag(featureFlag: string): string[] {
	return Object.entries(ALL_TOOL_FEATURE_FLAGS)
		.filter(([_, requiredFlag]) => requiredFlag === featureFlag)
		.map(([toolName]) => toolName);
}

/**
 * Check if a tool should be filtered out based on feature flag state
 * @param toolName - Name of the tool to check
 * @param featureFlags - Object mapping feature flag names to their enabled state
 * @returns True if the tool should be filtered out (disabled)
 */
export function shouldFilterTool(
	toolName: string,
	featureFlags: Record<string, boolean>,
): boolean {
	const requiredFlag = getRequiredFeatureFlag(toolName);
	
	// If no feature flag is required, don't filter
	if (!requiredFlag) {
		return false;
	}

	// Filter out if the required feature flag is disabled
	const isEnabled = featureFlags[requiredFlag] ?? false;
	if (!isEnabled) {
		log.info(`Filtering out tool '${toolName}' (feature flag '${requiredFlag}' disabled)`);
		return true;
	}

	return false;
}

/**
 * Filter an array of tool names based on feature flag state
 * @param toolNames - Array of tool names to filter
 * @param featureFlags - Object mapping feature flag names to their enabled state
 * @returns Array of tool names that should be available (not filtered)
 */
export function filterToolsByFeatureFlags(
	toolNames: string[],
	featureFlags: Record<string, boolean>,
): string[] {
	return toolNames.filter((toolName) => !shouldFilterTool(toolName, featureFlags));
}

/**
 * Convert Tomori config to feature flags object
 * @param config - Tomori configuration object
 * @returns Feature flags object with consistent naming
 */
export function configToFeatureFlags(config: {
	sticker_usage_enabled: boolean;
	web_search_enabled: boolean;
	self_teaching_enabled: boolean;
}): Record<string, boolean> {
	return {
		sticker_usage: config.sticker_usage_enabled,
		web_search: config.web_search_enabled,
		self_teaching: config.self_teaching_enabled,
	};
}