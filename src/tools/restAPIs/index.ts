/**
 * Brave Search REST API - Main Export
 * Provides direct HTTP access to Brave Search API endpoints
 */

// Export all types
export * from "../../types/tool/braveTypes";

// Export all service functions
export {
	braveWebSearch,
	braveImageSearch,
	braveVideoSearch,
	braveNewsSearch,
	isBraveSearchAvailable,
	testBraveApiConnection,
	formatBraveSearchResults,
	isBraveApiKeyError,
	isBraveRateLimitError,
	// Discord integration utilities
	extractImageUrls,
	sendImagesToDiscord,
	cleanImageSearchResult,
	addFetchCapabilityReminder,
} from "./brave/braveSearchService";

// Export function call implementations that match MCP function signatures
export {
	brave_web_search,
	brave_image_search,
	brave_video_search,
	brave_news_search,
} from "./brave/toolImplementations";

// Export BaseTool-based implementations for tool registry
export {
	BraveWebSearchTool,
	BraveImageSearchTool,
	BraveVideoSearchTool,
	BraveNewsSearchTool,
} from "./brave/braveTools";
