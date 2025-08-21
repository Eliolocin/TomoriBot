/**
 * MCP Server Configuration Loader
 * Handles loading and validation of MCP server configurations from JSON files
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { log } from "../misc/logger";

/**
 * Schema for MCP server configuration JSON files
 */
export const mcpServerConfigSchema = z.object({
	name: z.string().min(1),
	displayName: z.string().min(1),
	npmPackage: z.string().min(1),
	description: z.string().min(1),
	requiredEnvVars: z.array(z.string()).default([]),
	optionalEnvVars: z.array(z.string()).default([]),
	enabled: z.boolean().default(true),
	category: z.enum(["search", "utility", "data", "ai"]).default("utility"),
	priority: z.number().min(1).default(10),
	transport: z.enum(["stdio", "http", "websocket"]).default("stdio"),
});

export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

/**
 * Load all MCP server configurations from the mcpServers directory
 * @returns Promise<McpServerConfig[]> - Array of validated MCP server configurations
 */
export async function loadMcpConfigs(): Promise<McpServerConfig[]> {
	try {
		// Get the path to the mcpServers directory
		const mcpServersPath = path.join(
			process.cwd(),
			"src",
			"tools",
			"mcpServers",
		);

		log.info(`Loading MCP server configurations from: ${mcpServersPath}`);

		// Read all subdirectories in mcpServers
		const subdirectories = await readdir(mcpServersPath, {
			withFileTypes: true,
		});

		const configs: McpServerConfig[] = [];

		for (const dirent of subdirectories) {
			if (!dirent.isDirectory()) {
				continue;
			}

			const configPath = path.join(
				mcpServersPath,
				dirent.name,
				"config.json",
			);

			try {
				// Read and parse the configuration file
				const configContent = await readFile(configPath, "utf-8");
				const parsedConfig = JSON.parse(configContent);

				// Validate with Zod schema
				const validatedConfig = mcpServerConfigSchema.parse(parsedConfig);

				// Only include enabled configurations
				if (validatedConfig.enabled) {
					configs.push(validatedConfig);
					log.info(
						`Loaded MCP server config: ${validatedConfig.name} (${validatedConfig.displayName})`,
					);
				} else {
					log.info(
						`Skipped disabled MCP server: ${validatedConfig.name}`,
					);
				}
			} catch (error) {
				log.error(
					`Failed to load MCP config from ${configPath}`,
					error as Error,
				);
			}
		}

		// Sort configs by priority (lower numbers = higher priority)
		configs.sort((a, b) => a.priority - b.priority);

		log.success(
			`Successfully loaded ${configs.length} MCP server configurations`,
		);
		return configs;
	} catch (error) {
		log.error("Failed to load MCP server configurations", error as Error);
		return [];
	}
}

/**
 * Get MCP server configuration by name
 * @param name - MCP server name
 * @returns Promise<McpServerConfig | undefined> - Configuration if found
 */
export async function getMcpConfigByName(
	name: string,
): Promise<McpServerConfig | undefined> {
	const configs = await loadMcpConfigs();
	return configs.find((config) => config.name === name);
}

/**
 * Get enabled MCP server configurations filtered by category
 * @param category - Category to filter by
 * @returns Promise<McpServerConfig[]> - Filtered configurations
 */
export async function getMcpConfigsByCategory(
	category: string,
): Promise<McpServerConfig[]> {
	const configs = await loadMcpConfigs();
	return configs.filter((config) => config.category === category);
}

/**
 * Validate that all required dependencies for enabled MCP servers are available
 * @returns Promise<{ valid: boolean; errors: string[] }> - Validation result
 */
export async function validateMcpDependencies(): Promise<{
	valid: boolean;
	errors: string[];
}> {
	const configs = await loadMcpConfigs();
	const errors: string[] = [];

	for (const config of configs) {
		// Note: We can't easily check if npm packages are installed without running npm
		// This validation could be enhanced to check package availability if needed
		
		// Validate required environment variables structure
		if (!Array.isArray(config.requiredEnvVars)) {
			errors.push(
				`Invalid requiredEnvVars for ${config.name}: must be array`,
			);
		}

		if (!Array.isArray(config.optionalEnvVars)) {
			errors.push(
				`Invalid optionalEnvVars for ${config.name}: must be array`,
			);
		}

		// Validate transport type
		if (!["stdio", "http", "websocket"].includes(config.transport)) {
			errors.push(
				`Invalid transport for ${config.name}: ${config.transport}`,
			);
		}
	}

	const valid = errors.length === 0;
	if (valid) {
		log.success("All MCP server configurations are valid");
	} else {
		log.warn(`Found ${errors.length} MCP configuration validation errors`);
	}

	return { valid, errors };
}