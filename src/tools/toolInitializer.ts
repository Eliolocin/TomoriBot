/**
 * Tool Initialization System
 * Registers all available tools with the central registry
 */

import { log } from "../utils/misc/logger";
import { ToolRegistry } from "./toolRegistry";
import {
	StickerTool,
	MemoryTool,
	YouTubeVideoTool,
	PeekProfilePictureTool,
	PinMessageTool,
} from "./functionCalls";
import {
	BraveWebSearchTool,
	BraveImageSearchTool,
	BraveVideoSearchTool,
	BraveNewsSearchTool,
} from "./restAPIs/brave/braveTools";

/**
 * Initialize all tools by registering them with the central registry
 * This should be called once during application startup
 *
 * MCP tools are now handled by Google's official mcpToTool() - no manual registration needed
 */
export function initializeTools(): void {
	try {
		log.info("Initializing tool registry...");

		// Clear any existing tools (useful for testing/reloading)
		ToolRegistry.clearRegistry();

		// Register built-in tools and HTTP-based search tools
		const tools = [
			new StickerTool(),
			new MemoryTool(),
			new YouTubeVideoTool(),
			new PeekProfilePictureTool(),
			new PinMessageTool(),
			// HTTP-based Brave Search tools (replaces MCP implementation)
			new BraveWebSearchTool(),
			new BraveImageSearchTool(),
			new BraveVideoSearchTool(),
			new BraveNewsSearchTool(),
		];

		for (const tool of tools) {
			try {
				ToolRegistry.registerTool(tool);
				log.info(`Registered tool: ${tool.name} (${tool.category})`);
			} catch (error) {
				log.error(
					`Failed to register tool: ${tool.name} (${tool.category})`,
					error as Error,
				);
			}
		}

		// HTTP-based Brave Search tools provide optimized search functionality with server-specific API keys
		// Other MCP tools (fetch, etc.) are automatically handled by Google's mcpToTool()

		const stats = ToolRegistry.getStats();
		log.success(
			`Tool registry initialized successfully with ${stats.totalTools} tools`,
		);
	} catch (error) {
		log.error("Failed to initialize tool registry", error as Error);
		throw error;
	}
}

/**
 * Get initialization status
 * @returns Information about registered tools
 */
export function getInitializationStatus(): {
	isInitialized: boolean;
	toolCount: number;
	toolsByCategory: Record<string, number>;
	availableTools: string[];
} {
	const stats = ToolRegistry.getStats();
	const allTools = ToolRegistry.getAllTools();

	return {
		isInitialized: stats.totalTools > 0,
		toolCount: stats.totalTools,
		toolsByCategory: stats.toolsByCategory,
		availableTools: allTools.map((tool) => tool.name),
	};
}

/**
 * Reinitialize tools (useful for development/testing)
 */
export function reinitializeTools(): void {
	log.info("Reinitializing tool registry...");
	initializeTools();
}
