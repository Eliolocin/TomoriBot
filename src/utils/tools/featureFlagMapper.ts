/**
 * Centralized Feature Flag Mapping for Tools
 * Maps tool names to their required feature flags for consistent filtering across all providers
 */

import { log } from "../misc/logger";

/**
 * Feature flag requirements for built-in tools
 * Key: tool name, Value: required feature flag
 */
const BUILTIN_TOOL_FEATURE_FLAGS: Record<string, string> = {
  select_sticker_for_response: "sticker_usage",

  create_long_term_memory: "self_teaching",
  remember_this_fact: "self_teaching",
  update_long_term_memory: "self_teaching",
  update_user_info: "user_info_updates",

  manage_message: "manage_message",
  create_thread: "thread_creation",
  block_user: "user_blocking",
  unblock_user: "user_blocking",

  generate_image: "image_gen",

  generate_video: "video_gen",

  // Unified web search tool (replaces the four LLM-visible Brave entries).
  // Engine routing (Brave → DDG → IAsk) is handled inside the tool's dispatcher.
  web_search: "web_search",

  // Unified URL fetch tool. Phase 1 routes only through the internal MCP fetch engine.
  fetch_url: "web_search",
};

/**
 * Feature flag requirements for MCP tools
 * Key: MCP function name, Value: required feature flag
 */
const MCP_TOOL_FEATURE_FLAGS: Record<string, string> = {
  "web-search": "web_search",
  fetch: "web_search",
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
const ALL_TOOL_FEATURE_FLAGS = {
  ...BUILTIN_TOOL_FEATURE_FLAGS,
  ...MCP_TOOL_FEATURE_FLAGS,
};

function getRequiredFeatureFlag(toolName: string): string | undefined {
  return ALL_TOOL_FEATURE_FLAGS[toolName];
}

/**
 * Check if a tool should be filtered out based on feature flag state
 * @param featureFlags - Object mapping feature flag names to their enabled state
 */
function shouldFilterTool(toolName: string, featureFlags: Record<string, boolean>): boolean {
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
 * @param featureFlags - Object mapping feature flag names to their enabled state
 */
export function filterToolsByFeatureFlags(toolNames: string[], featureFlags: Record<string, boolean>): string[] {
  return toolNames.filter((toolName) => !shouldFilterTool(toolName, featureFlags));
}

/**
 * Convert Tomori config to feature flags object
 */
export function configToFeatureFlags(config: {
  sticker_usage_enabled: boolean;
  web_search_enabled: boolean;
  self_teaching_enabled: boolean;
  manage_message_enabled: boolean;
  imagegen_enabled: boolean;
  videogen_enabled: boolean;
  voice_message_enabled: boolean;
  user_blocking_enabled: boolean;
  user_info_updates_enabled: boolean;
  thread_creation_enabled: boolean;
}): Record<string, boolean> {
  return {
    sticker_usage: config.sticker_usage_enabled,
    web_search: config.web_search_enabled,
    self_teaching: config.self_teaching_enabled,
    manage_message: config.manage_message_enabled,
    image_gen: config.imagegen_enabled,
    video_gen: config.videogen_enabled,
    voice_message: config.voice_message_enabled,
    user_blocking: config.user_blocking_enabled,
    user_info_updates: config.user_info_updates_enabled,
    thread_creation: config.thread_creation_enabled,
  };
}
