import { getMCPManager } from "../../utils/mcp/mcpManager";
import { log } from "../../utils/misc/logger";
import type { ErrorContext } from "../../types/db/schema";
import { registerMCPAdapter } from "../../tools/toolRegistry";
import { getGoogleToolAdapter } from "../../providers/google/googleToolAdapter";

/**
 * Event handler for initializing MCP servers when the bot is ready
 * This runs during startup to establish connections to external MCP servers
 * and make their tools available for AI function calling
 */
export default async (): Promise<void> => {
	try {
		log.section("Initializing MCP servers");

		// Register MCP-capable tool adapters with the ToolRegistry
		const googleAdapter = getGoogleToolAdapter();
		registerMCPAdapter(googleAdapter);
		log.info("Registered Google tool adapter with MCP capabilities");

		// Get the MCP manager singleton instance
		const mcpManager = getMCPManager();

		// Initialize all configured MCP servers
		// This will attempt to connect to Brave Search (if API key available) and Fetch servers
		await mcpManager.initializeMCPServers();

		// Log initialization results
		const connectedCount = mcpManager.getConnectedServerCount();
		const connectionStatus = mcpManager.getConnectionStatus();

		if (connectedCount > 0) {
			const connectedServers = Object.keys(connectionStatus).join(", ");
			log.success(
				`MCP initialization completed - ${connectedCount} server(s) connected: ${connectedServers}`,
			);

			// Log available tools for visibility
			const availableTools = mcpManager.getMCPTools();
			if (availableTools.length > 0) {
				log.info(
					`MCP tools are now available for function calling (${availableTools.length} tools loaded)`,
				);
			}
		} else {
			log.info(
				"No MCP servers connected - this is normal if API keys are not configured",
			);
		}
	} catch (error) {
		// Use structured error context for consistent error handling
		const context: ErrorContext = {
			errorType: "MCPInitializationError",
			metadata: { stage: "startup" },
		};

		await log.error(
			"Error during MCP server initialization:",
			error,
			context,
		);

		// Don't throw the error - MCP failures shouldn't prevent bot startup
		// The bot can still function with built-in tools even if MCP servers fail
		log.info("Bot will continue startup despite MCP initialization failure");
	}
};