/**
 * MCP Configuration Utilities
 * Unified configuration loading and management for MCP servers
 * Bridges the gap between JSON config files and mcpManager implementation
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { log } from "../misc/logger";
import type {
	EnhancedMCPServerConfig,
} from "../../types/tool/mcpTypes";
import { DEFAULT_MCP_PARAMETER_OVERRIDES } from "../../types/tool/mcpTypes";

/**
 * MCP Configuration Manager
 * Handles loading, validation, and management of MCP server configurations
 */
export class MCPConfigManager {
	private static instance: MCPConfigManager;
	private configCache: Map<string, EnhancedMCPServerConfig> = new Map();
	private readonly MCP_SERVERS_DIR = join(
		process.cwd(),
		"src",
		"tools",
		"mcpServers",
	);

	/**
	 * Get singleton instance
	 */
	static getInstance(): MCPConfigManager {
		if (!MCPConfigManager.instance) {
			MCPConfigManager.instance = new MCPConfigManager();
		}
		return MCPConfigManager.instance;
	}

	/**
	 * Private constructor
	 */
	private constructor() {
		this.loadAllConfigurations();
	}

	/**
	 * Load all MCP server configurations from the file system
	 */
	private loadAllConfigurations(): void {
		try {
			if (!existsSync(this.MCP_SERVERS_DIR)) {
				log.warn("MCP servers directory not found:", this.MCP_SERVERS_DIR);
				return;
			}

			const serverDirs = readdirSync(this.MCP_SERVERS_DIR).filter((item) => {
				const fullPath = join(this.MCP_SERVERS_DIR, item);
				return statSync(fullPath).isDirectory();
			});

			let loadedCount = 0;
			for (const serverDir of serverDirs) {
				try {
					const config = this.loadServerConfiguration(serverDir);
					if (config) {
						this.configCache.set(serverDir, config);
						loadedCount++;
					}
				} catch (error) {
					log.warn(
						`Failed to load configuration for MCP server '${serverDir}':`,
						error as Error,
					);
				}
			}

			log.info(
				`MCP Config Manager loaded ${loadedCount}/${serverDirs.length} server configurations`,
			);
		} catch (error) {
			log.error("Failed to load MCP configurations:", error as Error);
		}
	}

	/**
	 * Load configuration for a specific MCP server
	 * @param serverName - Name of the server directory
	 * @returns Enhanced server configuration or null if not found/invalid
	 */
	private loadServerConfiguration(
		serverName: string,
	): EnhancedMCPServerConfig | null {
		try {
			const configPath = join(this.MCP_SERVERS_DIR, serverName, "config.json");

			if (!existsSync(configPath)) {
				log.info(`No config.json found for MCP server: ${serverName}`);
				return null;
			}

			const rawConfig = JSON.parse(readFileSync(configPath, "utf-8"));
			const enhancedConfig = this.validateAndEnhanceConfig(
				rawConfig,
				serverName,
			);

			log.info(`Loaded configuration for MCP server: ${serverName}`);
			return enhancedConfig;
		} catch (error) {
			log.error(`Failed to load config for ${serverName}:`, error as Error);
			return null;
		}
	}

	/**
	 * Validate and enhance a raw configuration object
	 * @param rawConfig - Raw configuration from JSON file
	 * @param serverName - Name of the server (for validation)
	 * @returns Enhanced and validated configuration
	 */
	private validateAndEnhanceConfig(
		rawConfig: Record<string, unknown>,
		serverName: string,
	): EnhancedMCPServerConfig {
		// Validate required fields
		const requiredFields = ["name", "displayName", "description", "enabled"];
		for (const field of requiredFields) {
			if (!(field in rawConfig)) {
				throw new Error(
					`Missing required field '${field}' in config for ${serverName}`,
				);
			}
		}

		// Ensure arrays exist
		const requiredEnvVars = Array.isArray(rawConfig.requiredEnvVars)
			? rawConfig.requiredEnvVars
			: [];
		const optionalEnvVars = Array.isArray(rawConfig.optionalEnvVars)
			? rawConfig.optionalEnvVars
			: [];

		// Create enhanced configuration with defaults and proper type casting
		const enhancedConfig: EnhancedMCPServerConfig = {
			name: typeof rawConfig.name === "string" ? rawConfig.name : serverName,
			displayName: typeof rawConfig.displayName === "string" ? rawConfig.displayName : serverName,
			description: typeof rawConfig.description === "string" ? rawConfig.description : "",
			requiredEnvVars,
			optionalEnvVars,
			enabled: Boolean(rawConfig.enabled),
			category: typeof rawConfig.category === "string" && 
				["search", "utility", "media", "ai", "data"].includes(rawConfig.category) 
				? rawConfig.category as "search" | "utility" | "media" | "ai" | "data"
				: "utility",
			priority: typeof rawConfig.priority === "number" ? rawConfig.priority : 5,
			transport: typeof rawConfig.transport === "string" &&
				["stdio", "http", "websocket"].includes(rawConfig.transport)
				? rawConfig.transport as "stdio" | "http" | "websocket"
				: "stdio",

			// Optional fields
			npmPackage: typeof rawConfig.npmPackage === "string" ? rawConfig.npmPackage : undefined,
			command: typeof rawConfig.command === "string" ? rawConfig.command : undefined,
			args: Array.isArray(rawConfig.args) ? rawConfig.args : [],
			timeout:
				typeof rawConfig.timeout === "number" ? rawConfig.timeout : 30000,

			// Handler configuration
			behaviorHandler: this.determineBehaviorHandler(serverName),
			parameterOverrides: this.loadParameterOverrides(serverName),

			// Capabilities (will be determined at runtime)
			supportedFunctions: Array.isArray(rawConfig.supportedFunctions) ? rawConfig.supportedFunctions : [],
			requiresAuth: requiredEnvVars.length > 0,
			rateLimited: typeof rawConfig.rateLimited === "boolean" ? rawConfig.rateLimited : false,
		};

		// Validate the configuration
		this.validateConfiguration(enhancedConfig);

		return enhancedConfig;
	}

	/**
	 * Determine the behavior handler class name for a server
	 * @param serverName - Name of the server
	 * @returns Handler class name or undefined
	 */
	private determineBehaviorHandler(serverName: string): string | undefined {
		const handlerMap: Record<string, string> = {
			"brave-search": "BraveSearchHandler",
			fetch: "FetchHandler",
			"duckduckgo-search": "DuckDuckGoHandler",
		};

		return handlerMap[serverName];
	}

	/**
	 * Load parameter overrides for a specific server
	 * @param serverName - Name of the server
	 * @returns Parameter overrides configuration
	 */
	private loadParameterOverrides(
		serverName: string,
	): Record<string, Record<string, unknown>> | undefined {
		// Check if there are default overrides for this server's functions
		const serverFunctionPrefix = serverName.replace("-", "_");
		const matchingOverrides: Record<string, Record<string, unknown>> = {};

		for (const [functionName, overrides] of Object.entries(
			DEFAULT_MCP_PARAMETER_OVERRIDES,
		)) {
			if (functionName.startsWith(serverFunctionPrefix)) {
				matchingOverrides[functionName] = overrides as Record<string, unknown>;
			}
		}

		return Object.keys(matchingOverrides).length > 0
			? matchingOverrides
			: undefined;
	}

	/**
	 * Validate a server configuration
	 * @param config - Configuration to validate
	 * @throws Error if configuration is invalid
	 */
	private validateConfiguration(config: EnhancedMCPServerConfig): void {
		// Validate transport type
		const validTransports = ["stdio", "http", "websocket"];
		if (!validTransports.includes(config.transport)) {
			throw new Error(
				`Invalid transport '${config.transport}' for ${config.name}`,
			);
		}

		// Validate category
		const validCategories = ["search", "utility", "media", "ai", "data"];
		if (!validCategories.includes(config.category)) {
			throw new Error(
				`Invalid category '${config.category}' for ${config.name}`,
			);
		}

		// Validate priority
		if (config.priority < 1 || config.priority > 10) {
			throw new Error(`Priority must be between 1-10 for ${config.name}`);
		}

		// Validate command setup
		if (!config.npmPackage && !config.command) {
			throw new Error(
				`Either npmPackage or command must be specified for ${config.name}`,
			);
		}
	}

	/**
	 * Get all available server configurations
	 * @param enabledOnly - Whether to return only enabled servers
	 * @returns Array of server configurations
	 */
	public getAllConfigurations(
		enabledOnly = false,
	): EnhancedMCPServerConfig[] {
		const configs = Array.from(this.configCache.values());
		return enabledOnly ? configs.filter((config) => config.enabled) : configs;
	}

	/**
	 * Get configuration for a specific server
	 * @param serverName - Name of the server
	 * @returns Server configuration or null if not found
	 */
	public getConfiguration(serverName: string): EnhancedMCPServerConfig | null {
		return this.configCache.get(serverName) || null;
	}

	/**
	 * Get configurations sorted by priority
	 * @param enabledOnly - Whether to return only enabled servers
	 * @returns Array of configurations sorted by priority (1 = highest priority)
	 */
	public getConfigurationsByPriority(
		enabledOnly = false,
	): EnhancedMCPServerConfig[] {
		const configs = this.getAllConfigurations(enabledOnly);
		return configs.sort((a, b) => a.priority - b.priority);
	}

	/**
	 * Get configurations for servers that require API keys
	 * @returns Array of configurations that require authentication
	 */
	public getAuthRequiredConfigurations(): EnhancedMCPServerConfig[] {
		return this.getAllConfigurations(true).filter(
			(config) => config.requiresAuth,
		);
	}

	/**
	 * Convert enhanced configuration to the format expected by mcpManager
	 * @param config - Enhanced configuration
	 * @returns Configuration in mcpManager format
	 */
	public toManagerConfiguration(config: EnhancedMCPServerConfig): {
		name: string;
		displayName: string;
		command: string;
		args: string[];
		env?: Record<string, string>;
		requiresApiKey?: boolean;
		apiKeyEnvVar?: string;
		timeout?: number;
	} {
		// Determine command and args based on configuration
		let command: string;
		let args: string[];

		if (config.npmPackage) {
			// Use npx for npm packages
			command = "npx";
			args = ["-y", config.npmPackage];
		} else if (config.command) {
			// Use specified command
			command = config.command;
			args = config.args || [];
		} else {
			throw new Error(`No command configuration for server: ${config.name}`);
		}

		// Build environment variables
		const env: Record<string, string> = {};

		// Add required environment variables if they exist in process.env
		for (const envVar of config.requiredEnvVars) {
			const value = process.env[envVar];
			if (value) {
				env[envVar] = value;
			}
		}

		// Add optional environment variables if they exist
		for (const envVar of config.optionalEnvVars) {
			const value = process.env[envVar];
			if (value) {
				env[envVar] = value;
			}
		}

		// Special handling for Brave Search transport mode
		if (config.name === "brave-search") {
			env.BRAVE_MCP_TRANSPORT = "stdio"; // Force STDIO mode for consistency
		}

		return {
			name: config.name,
			displayName: config.displayName,
			command,
			args,
			env: Object.keys(env).length > 0 ? env : undefined,
			requiresApiKey: config.requiresAuth,
			apiKeyEnvVar: config.requiredEnvVars[0], // First required env var is typically the API key
			timeout: config.timeout,
		};
	}

	/**
	 * Check if a server should be initialized based on environment
	 * @param config - Server configuration
	 * @returns True if server should be initialized
	 */
	public shouldInitializeServer(config: EnhancedMCPServerConfig): boolean {
		if (!config.enabled) {
			return false;
		}

		// Check if required environment variables are present
		for (const envVar of config.requiredEnvVars) {
			if (!process.env[envVar]) {
				log.info(
					`Skipping ${config.displayName}: missing required environment variable ${envVar}`,
				);
				return false;
			}
		}

		return true;
	}

	/**
	 * Get initialization summary for logging
	 * @returns Summary of server initialization status
	 */
	public getInitializationSummary(): {
		totalServers: number;
		enabledServers: number;
		readyToInitialize: number;
		missingApiKeys: string[];
		disabledServers: string[];
	} {
		const allConfigs = this.getAllConfigurations();
		const enabledConfigs = allConfigs.filter((c) => c.enabled);
		const readyConfigs = enabledConfigs.filter((c) =>
			this.shouldInitializeServer(c),
		);

		const missingApiKeys = enabledConfigs
			.filter((c) => !this.shouldInitializeServer(c))
			.filter((c) => c.requiresAuth)
			.map((c) => c.name);

		const disabledServers = allConfigs
			.filter((c) => !c.enabled)
			.map((c) => c.name);

		return {
			totalServers: allConfigs.length,
			enabledServers: enabledConfigs.length,
			readyToInitialize: readyConfigs.length,
			missingApiKeys,
			disabledServers,
		};
	}

	/**
	 * Reload configurations from disk
	 * @returns Number of configurations reloaded
	 */
	public reloadConfigurations(): number {
		this.configCache.clear();
		this.loadAllConfigurations();
		return this.configCache.size;
	}
}

/**
 * Export convenience function for getting the manager instance
 */
export function getMCPConfigManager(): MCPConfigManager {
	return MCPConfigManager.getInstance();
}
