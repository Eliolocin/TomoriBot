/**
 * MCP Manager - Global management of Model Context Protocol server connections
 *
 * Handles startup initialization of MCP servers and provides provider-agnostic
 * access to MCP tools throughout the application lifecycle.
 */

import { type CallableTool, mcpToTool } from "@google/genai";
import { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { log } from "../misc/logger";
import { getMCPConfigManager } from "./mcpConfig";
import type { EnhancedMCPServerConfig } from "../../types/tool/mcpTypes";

/**
 * MCP server configuration interface
 */
interface MCPServerConfig {
	name: string;
	displayName: string;
	command: string;
	args: string[];
	env?: Record<string, string>;
	requiresApiKey?: boolean;
	apiKeyEnvVar?: string;
	timeout?: number;
}

/**
 * Global MCP manager singleton for handling all MCP server connections
 */
export class MCPManager {
	private static instance: MCPManager;
	private mcpClients: Map<string, MCPClient> = new Map();
	private mcpTools: Map<string, CallableTool> = new Map();
	private isInitialized = false;
	private initializationPromise: Promise<void> | null = null;

	/**
	 * Get the singleton instance of MCPManager
	 */
	static getInstance(): MCPManager {
		if (!MCPManager.instance) {
			MCPManager.instance = new MCPManager();
		}
		return MCPManager.instance;
	}

	/**
	 * Private constructor to enforce singleton pattern
	 */
	private constructor() {
		// Private constructor
	}

	/**
	 * Initialize all available MCP servers during application startup
	 * This method is idempotent and can be called multiple times safely
	 */
	async initializeMCPServers(): Promise<void> {
		if (this.initializationPromise) {
			return this.initializationPromise;
		}

		this.initializationPromise = this.performInitialization();
		return this.initializationPromise;
	}

	/**
	 * Perform the actual MCP server initialization
	 */
	private async performInitialization(): Promise<void> {
		if (this.isInitialized) {
			log.info("MCP servers already initialized");
			return;
		}

		log.info("Starting MCP server initialization...");
		const startTime = Date.now();
		
		// Log initialization summary
		const configManager = getMCPConfigManager();
		const summary = configManager.getInitializationSummary();
		log.info(
			`MCP Configuration Summary: ${summary.readyToInitialize}/${summary.totalServers} servers ready to initialize${summary.missingApiKeys.length > 0 ? ` (missing API keys: ${summary.missingApiKeys.join(", ")})` : ""}${summary.disabledServers.length > 0 ? ` (disabled: ${summary.disabledServers.join(", ")})` : ""}`
		);

		// Define available MCP server configurations
		const serverConfigs = this.getServerConfigurations();

		// Initialize each server concurrently with individual error handling
		const initPromises = serverConfigs.map((config) =>
			this.initializeServer(config).catch((error) => {
				log.warn(
					`Failed to initialize MCP server '${config.displayName}':`,
					error as Error,
				);
				return null; // Continue with other servers even if one fails
			}),
		);

		await Promise.all(initPromises);

		const duration = Date.now() - startTime;
		const successCount = this.mcpClients.size;
		const totalCount = serverConfigs.length;

		this.isInitialized = true;
		log.success(
			`MCP initialization completed in ${duration}ms: ${successCount}/${totalCount} servers connected`,
		);

		// Log available tools
		if (this.mcpTools.size > 0) {
			const toolNames = Array.from(this.mcpTools.keys());
			log.info(`Available MCP tools: ${toolNames.join(", ")}`);
		}
	}

	/**
	 * Get MCP server configurations from the configuration manager
	 */
	private getServerConfigurations(): MCPServerConfig[] {
		const configManager = getMCPConfigManager();
		const enhancedConfigs = configManager.getConfigurationsByPriority(false); // Get all configs
		
		// Filter configs that should be initialized
		const readyConfigs = enhancedConfigs.filter(config => 
			configManager.shouldInitializeServer(config)
		);
		
		// Convert enhanced configs to manager format
		return readyConfigs.map(config => configManager.toManagerConfiguration(config));
	}

	/**
	 * Initialize a single MCP server
	 */
	private async initializeServer(config: MCPServerConfig): Promise<void> {
		const { name, displayName, command, args, env, timeout = 30000 } = config;

		log.info(`Initializing ${displayName} MCP server...`);

		try {
			// Create MCP client
			const client = new MCPClient({
				name: `tomoribot-${name}`,
				version: "1.0.0",
			});

			// Create transport with environment variables
			const transport = new StdioClientTransport({
				command,
				args,
				env: Object.fromEntries(
					Object.entries({
						...process.env,
						...env,
					}).filter(([, value]) => value !== undefined),
				) as Record<string, string>,
			});

			// Connect with timeout
			const connectPromise = client.connect(transport);
			const timeoutPromise = new Promise<never>((_, reject) =>
				setTimeout(
					() =>
						reject(
							new Error(`${displayName} connection timed out (${timeout}ms)`),
						),
					timeout,
				),
			);

			await Promise.race([connectPromise, timeoutPromise]);

			// Convert to CallableTool using Google's mcpToTool()
			const callableTool = mcpToTool(client);

			// Store both client and tool
			this.mcpClients.set(name, client);
			this.mcpTools.set(name, callableTool);

			log.success(`${displayName} MCP server connected successfully`);

			// Log available functions for this server
			try {
				const tool = await callableTool.tool();
				if (tool.functionDeclarations) {
					const functionNames = tool.functionDeclarations.map(
						(f) => f.name,
					);
					log.info(
						`${displayName} provides functions: ${functionNames.join(", ")}`,
					);
				}
			} catch (toolError) {
				log.warn(
					`Could not enumerate functions for ${displayName}:`,
					toolError as Error,
				);
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);

			if (errorMessage.includes("timed out")) {
				log.warn(
					`${displayName} connection timed out - this is normal on first install`,
				);
				if (command === "npx") {
					log.info(
						"Try restarting TomoriBot after npm finishes installing the package",
					);
				}
			} else if (
				errorMessage.includes("not recognized") ||
				errorMessage.includes("not found")
			) {
				log.info(
					`${displayName} requires ${command} to be installed - functionality will not be available`,
				);
			} else {
				log.warn(`${displayName} connection failed:`, error as Error);
			}

			throw error; // Re-throw to be caught by caller
		}
	}

	/**
	 * Get all connected MCP tools
	 */
	getMCPTools(): CallableTool[] {
		return Array.from(this.mcpTools.values());
	}

	/**
	 * Get MCP tools filtered by function names they provide
	 */
	async getToolsByFunctionNames(
		functionNames: string[],
	): Promise<CallableTool[]> {
		const matchingTools: CallableTool[] = [];

		for (const [serverName, callableTool] of this.mcpTools) {
			try {
				const tool = await callableTool.tool();
				const availableFunctions =
					tool.functionDeclarations?.map((f) => f.name) || [];

				// Check if this tool provides any of the requested functions
				const hasMatchingFunction = functionNames.some((name) =>
					availableFunctions.includes(name),
				);

				if (hasMatchingFunction) {
					matchingTools.push(callableTool);
				}
			} catch (error) {
				log.warn(
					`Error checking functions for MCP server '${serverName}':`,
					error as Error,
				);
			}
		}

		return matchingTools;
	}

	/**
	 * Get specific MCP tool by server name
	 */
	getMCPTool(serverName: string): CallableTool | null {
		return this.mcpTools.get(serverName) || null;
	}

	/**
	 * Check if MCP manager is ready (initialization completed)
	 */
	isReady(): boolean {
		return this.isInitialized;
	}

	/**
	 * Get connection status for all MCP servers
	 */
	getConnectionStatus(): Record<string, boolean> {
		const status: Record<string, boolean> = {};

		for (const [name] of this.mcpTools) {
			status[name] = true; // If it's in the map, it's connected
		}

		return status;
	}

	/**
	 * Get count of connected MCP servers
	 */
	getConnectedServerCount(): number {
		return this.mcpClients.size;
	}

	/**
	 * Get enhanced server configurations
	 * @returns Array of enhanced server configurations
	 */
	getEnhancedServerConfigurations(): EnhancedMCPServerConfig[] {
		const configManager = getMCPConfigManager();
		return configManager.getConfigurationsByPriority(true); // Get only enabled configs
	}

	/**
	 * Get initialization summary for logging and monitoring
	 */
	getInitializationSummary() {
		const configManager = getMCPConfigManager();
		return configManager.getInitializationSummary();
	}

	/**
	 * Cleanup all MCP connections (for graceful shutdown)
	 */
	async cleanup(): Promise<void> {
		log.info("Cleaning up MCP connections...");

		const cleanupPromises = Array.from(this.mcpClients.values()).map(
			async (client) => {
				try {
					await client.close();
				} catch (error) {
					log.warn("Error closing MCP client:", error as Error);
				}
			},
		);

		await Promise.all(cleanupPromises);

		this.mcpClients.clear();
		this.mcpTools.clear();
		this.isInitialized = false;
		this.initializationPromise = null;

		log.info("MCP cleanup completed");
	}
}

// Export convenience function for getting the manager instance
export function getMCPManager(): MCPManager {
	return MCPManager.getInstance();
}
