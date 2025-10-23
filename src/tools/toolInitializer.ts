/**
 * Tool Initialization System
 * Automatically discovers and registers all available tools with the central registry
 */

import path from "node:path";
import { log } from "../utils/misc/logger";
import { ToolRegistry } from "./toolRegistry";
import getAllFiles from "../utils/misc/ioHelper";
import { BaseTool } from "../types/tool/interfaces";
import type { ErrorContext } from "../types/db/schema";

/**
 * Initialize all tools by auto-discovering and registering them with the central registry
 * This should be called once during application startup
 *
 * Auto-discovers tools from:
 * - src/tools/functionCalls/ - Built-in function call tools
 * - src/tools/restAPIs/brave/ - HTTP-based Brave Search tools
 *
 * MCP tools are now handled by Google's official mcpToTool() - no manual registration needed
 */
export async function initializeTools(): Promise<void> {
	try {
		log.info("Initializing tool registry with auto-discovery...");

		// 1. Clear any existing tools (useful for testing/reloading)
		ToolRegistry.clearRegistry();

		let totalDiscovered = 0;

		// 2. Auto-discover built-in function call tools
		const functionCallsPath = path.join(
			process.cwd(),
			"src",
			"tools",
			"functionCalls",
		);
		const functionCallFiles = getAllFiles(functionCallsPath).filter(
			(file) => !file.endsWith("index.ts"), // Skip index.ts
		);

		log.info(
			`Scanning ${functionCallFiles.length} files in functionCalls directory...`,
		);

		for (const toolFile of functionCallFiles) {
			const discovered = await discoverAndRegisterTools(
				toolFile,
				"functionCalls",
			);
			totalDiscovered += discovered;
		}

		// 3. Auto-discover Brave Search tools
		const braveToolsPath = path.join(
			process.cwd(),
			"src",
			"tools",
			"restAPIs",
			"brave",
		);
		const braveToolFiles = getAllFiles(braveToolsPath).filter((file) =>
			file.endsWith("braveTools.ts"),
		);

		log.info(`Scanning ${braveToolFiles.length} files in Brave tools directory...`);

		for (const braveFile of braveToolFiles) {
			const discovered = await discoverAndRegisterTools(braveFile, "brave");
			totalDiscovered += discovered;
		}

		// 4. Log final statistics
		const stats = ToolRegistry.getStats();
		log.success(
			`Auto-discovery complete: Found and registered ${totalDiscovered} tools (${stats.totalTools} total in registry)`,
		);
		log.info(
			`Tools by category: ${Object.entries(stats.toolsByCategory)
				.map(([cat, count]) => `${cat}=${count}`)
				.join(", ")}`,
		);
	} catch (error) {
		log.error("Failed to initialize tool registry", error as Error);
		throw error;
	}
}

/**
 * Discover and register tools from a specific file
 * @param filePath - Absolute path to the tool file
 * @param source - Source identifier for logging (e.g., "functionCalls", "brave")
 * @returns Number of tools discovered and registered from this file
 */
async function discoverAndRegisterTools(
	filePath: string,
	source: string,
): Promise<number> {
	let discoveredCount = 0;

	try {
		// 1. Import the tool module
		const toolModule = await import(filePath);

		// 2. Find all exported classes that extend BaseTool
		for (const [exportName, exportedItem] of Object.entries(toolModule)) {
			try {
				// Check if this export is a class constructor that extends BaseTool
				if (
					typeof exportedItem === "function" &&
					exportedItem.prototype instanceof BaseTool
				) {
					// 3. Instantiate the tool class
					const toolInstance = new (exportedItem as new () => BaseTool)();

					// 4. Register with the tool registry
					ToolRegistry.registerTool(toolInstance);

					log.info(
						`Auto-registered [${source}]: ${toolInstance.name} (${toolInstance.category}) from ${exportName}`,
					);

					discoveredCount++;
				}
			} catch (error) {
				const context: ErrorContext = {
					errorType: "ToolRegistrationError",
					metadata: {
						filePath,
						exportName,
						source,
					},
				};
				await log.error(
					`Failed to register tool export '${exportName}' from ${filePath}:`,
					error as Error,
					context,
				);
			}
		}
	} catch (error) {
		const context: ErrorContext = {
			errorType: "ToolDiscoveryError",
			metadata: {
				filePath,
				source,
			},
		};
		await log.error(
			`Failed to import tool file: ${filePath}`,
			error as Error,
			context,
		);
	}

	return discoveredCount;
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
export async function reinitializeTools(): Promise<void> {
	log.info("Reinitializing tool registry...");
	await initializeTools();
}
