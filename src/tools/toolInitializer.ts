/**
 * Tool Initialization System
 * Registers all available tools with the central registry
 */

import { log } from "../utils/misc/logger";
import { ToolRegistry } from "./toolRegistry";
import { StickerTool, SearchTool, MemoryTool } from "./functionCalls";

/**
 * Initialize all tools by registering them with the central registry
 * This should be called once during application startup
 */
export function initializeTools(): void {
	try {
		log.info("Initializing tool registry...");

		// Clear any existing tools (useful for testing/reloading)
		ToolRegistry.clearRegistry();

		// Register function call tools
		const tools = [
			new StickerTool(),
			new SearchTool(),
			new MemoryTool(),
		];

		for (const tool of tools) {
			try {
				ToolRegistry.registerTool(tool);
				log.info(`Registered tool: ${tool.name} (${tool.category})`);
			} catch (error) {
				log.error(`Failed to register tool: ${tool.name} (${tool.category})`, error as Error);
			}
		}

		// Future: Register MCP server tools
		// const mcpTools = await loadMCPTools();
		// for (const mcpTool of mcpTools) {
		//     ToolRegistry.registerTool(mcpTool);
		// }

		const stats = ToolRegistry.getStats();
		log.success(`Tool registry initialized successfully with ${stats.totalTools} tools`);

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
		availableTools: allTools.map(tool => tool.name),
	};
}

/**
 * Reinitialize tools (useful for development/testing)
 */
export function reinitializeTools(): void {
	log.info("Reinitializing tool registry...");
	initializeTools();
}