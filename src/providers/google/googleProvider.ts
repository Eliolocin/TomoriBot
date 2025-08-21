/**
 * Google Gemini provider implementation
 * Implements the LLMProvider interface for Google's Gemini AI models
 *
 * Now uses the modular streaming architecture with StreamOrchestrator
 * and GoogleStreamAdapter for better code organization and maintainability.
 */

import {
	GoogleGenAI,
	type HarmBlockThreshold,
	type HarmCategory,
	mcpToTool,
} from "@google/genai";
import { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
	BaseGuildTextChannel,
	Client,
	CommandInteraction,
	Message,
} from "discord.js";
import { StreamOrchestrator } from "../../utils/discord/streamOrchestrator";
import {
	GoogleStreamAdapter,
	type GoogleStreamConfig,
} from "./googleStreamAdapter";
import type { StreamContext } from "../../types/stream/interfaces";
import { DISCORD_STREAMING_CONSTANTS } from "../../types/stream/types";
import {
	type ToolStateForContext,
	getAvailableToolsForContext,
} from "../../tools/toolRegistry";
import type { TomoriState } from "../../types/db/schema";
import type { StructuredContextItem } from "../../types/misc/context";
import { log } from "../../utils/misc/logger";
import { loadMcpConfigs } from "../../utils/mcp/mcpConfigLoader";
import { getAllMcpApiKeysForServer } from "../../utils/security/crypto";
import {
	BaseLLMProvider,
	type FunctionCall,
	type LLMProvider,
	type ProviderConfig,
	type ProviderInfo,
	type StreamResult,
} from "../../types/provider/interfaces";
import { getGoogleToolAdapter } from "./googleToolAdapter";

// Default values for Gemini API
const DEFAULT_MODEL =
	process.env.DEFAULT_GEMINI_MODEL || "gemini-2.5-flash-preview-05-20";

// Google-specific configuration extending the base ProviderConfig
export interface GoogleProviderConfig extends ProviderConfig {
	safetySettings: Array<{
		category: string;
		threshold: string;
	}>;
	generationConfig: {
		temperature: number;
		topK?: number;
		topP?: number;
		maxOutputTokens?: number;
		stopSequences?: string[];
	};
}

/**
 * Google Gemini provider implementation
 */
export class GoogleProvider extends BaseLLMProvider implements LLMProvider {
	/**
	 * Get provider information and capabilities
	 */
	getInfo(): ProviderInfo {
		return {
			name: "google",
			displayName: "Google Gemini",
			supportedModels: [
				"gemini-2.5-flash-preview-05-20",
				"gemini-2.5-pro-preview-05-06",
				"gemini-2.0-flash-thinking-exp-01-21",
			],
			requiresApiKey: true,
			supportsStreaming: true,
			supportsFunctionCalling: true,
			supportsImages: true,
			supportsVideos: true,
		};
	}

	/**
	 * Validate a Google API key by making a test request
	 * @param apiKey - The API key to validate
	 * @returns Promise<boolean> - True if the key is valid, false otherwise
	 */
	async validateApiKey(apiKey: string): Promise<boolean> {
		if (!apiKey || apiKey.trim().length < 10) {
			log.warn("API key is too short or empty");
			return false;
		}

		try {
			log.info("Validating Google API key...");

			// Initialize the Google AI client with the provided API key
			const genAI = new GoogleGenAI({ apiKey });

			// Use the default model or the simplest available model
			const response = await genAI.models.generateContent({
				model: DEFAULT_MODEL,
				contents: [
					{
						text: 'This is a test message for verifying API keys. Say "VALID"',
					},
				],
			});

			const responseText = response.text; // Use the text getter

			if (!responseText?.toLowerCase().includes("valid")) {
				log.warn("API key validation response did not contain 'VALID'");
				return false;
			}

			log.success("API key validation successful");
			return true;
		} catch (error) {
			// Log the specific error during validation failure
			log.error(
				`API key validation failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}

	/**
	 * Spawn MCP clients for enabled servers
	 * @param tomoriState - The current Tomori state with configuration
	 * @returns Promise<MCPClient[]> - Array of connected MCP clients
	 */
	private async getMcpClients(tomoriState: TomoriState): Promise<MCPClient[]> {
		try {
			log.info(`Loading MCP clients for server ${tomoriState.server_id}`);

			// Only enable if search is enabled
			if (!tomoriState.config.google_search_enabled) {
				log.info("Search disabled - no MCP clients will be spawned");
				return [];
			}

			const clients: MCPClient[] = [];

			// DuckDuckGo Search (Python-based, no API key needed)
			try {
				const client = new MCPClient({
					name: "tomoribot",
					version: "1.0.0",
				});

				const transport = new StdioClientTransport({
					command: "uvx",
					args: ["duckduckgo-mcp-server"],
					env: Object.fromEntries(
						Object.entries(process.env).filter(([, value]) => value !== undefined)
					) as Record<string, string>,
				});

				await client.connect(transport);
				clients.push(client);
				log.success("Connected to DuckDuckGo MCP server");
			} catch (error) {
				log.warn("Failed to connect to DuckDuckGo MCP server:", error as Error);
			}

			// Add more MCP servers here (Brave, fetch, etc.)

			log.info(`Successfully connected to ${clients.length} MCP servers`);
			return clients;
		} catch (error) {
			log.error("Failed to spawn MCP clients", error as Error);
			return [];
		}
	}

	/**
	 * Get available tools/functions based on Tomori's configuration
	 * Uses modular tool system + Google's official mcpToTool() for MCP integration
	 * @param tomoriState - The current Tomori state with configuration
	 * @returns Promise<Array<Record<string, unknown>>> - Array of tool configurations
	 */
	async getTools(tomoriState: TomoriState): Promise<Array<Record<string, unknown>>> {
		try {
			const modelNameLower = tomoriState.llm.llm_codename.toLowerCase();
			const allTools: Array<Record<string, unknown>> = [];

			// 1. Get built-in tools from the registry
			const toolStateForContext: ToolStateForContext = {
				server_id: tomoriState.server_id.toString(),
				config: {
					sticker_usage_enabled: tomoriState.config.sticker_usage_enabled,
					google_search_enabled: tomoriState.config.google_search_enabled,
					self_teaching_enabled: tomoriState.config.self_teaching_enabled,
				},
			};

			// Get available built-in tools (excluding MCP wrappers)
			const availableBuiltInTools = getAvailableToolsForContext(
				"google",
				toolStateForContext,
			).filter(tool => !tool.name.includes("duckduckgo") && !tool.name.includes("fetch_url"));

			if (availableBuiltInTools.length > 0) {
				const googleAdapter = getGoogleToolAdapter();
				const builtInToolsConfig = googleAdapter.convertToolsArray(availableBuiltInTools);
				allTools.push(...builtInToolsConfig);

				const enabledToolNames = availableBuiltInTools.map((tool) => tool.name);
				log.info(`Added ${availableBuiltInTools.length} built-in tools: ${enabledToolNames.join(", ")}`);
			}

			// 2. Add MCP tools using Google's official mcpToTool()
			try {
				const mcpClients = await this.getMcpClients(tomoriState);
				
				for (const client of mcpClients) {
					try {
						const mcpTool = mcpToTool(client);
						allTools.push(mcpTool as Record<string, unknown>);
						log.info("Added MCP tools via official mcpToTool()");
					} catch (error) {
						log.error("Failed to convert MCP client via mcpToTool()", error as Error);
					}
				}

				if (mcpClients.length > 0) {
					log.success(`Successfully integrated ${mcpClients.length} MCP clients using Google's mcpToTool()`);
				}
			} catch (error) {
				log.error("Failed to load MCP tools, continuing with built-in tools only", error as Error);
			}

			log.info(`Total tools available for Google provider: ${allTools.length}`);
			return allTools;
		} catch (error) {
			log.error(`Failed to get tools for Google provider: ${tomoriState.llm.llm_codename}`, error as Error);
			return [];
		}
	}

	/**
	 * Get the default model for this provider
	 * @returns The default model codename
	 */
	getDefaultModel(): string {
		return DEFAULT_MODEL;
	}

	/**
	 * Convert provider-specific configuration from TomoriState
	 * @param tomoriState - The current Tomori state
	 * @param apiKey - The decrypted API key
	 * @returns Promise<GoogleProviderConfig> - Provider-specific configuration object
	 */
	async createConfig(tomoriState: TomoriState, apiKey: string): Promise<GoogleProviderConfig> {
		const tools = await this.getTools(tomoriState);
		
		return {
			model: tomoriState.llm.llm_codename,
			apiKey: apiKey,
			temperature: tomoriState.config.llm_temperature,
			maxOutputTokens: 8192,
			tools: tools,
			safetySettings: [
				{
					category: "HARM_CATEGORY_HARASSMENT",
					threshold: "BLOCK_NONE",
				},
				{
					category: "HARM_CATEGORY_HATE_SPEECH",
					threshold: "BLOCK_NONE",
				},
				{
					category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
					threshold: "BLOCK_NONE",
				},
				{
					category: "HARM_CATEGORY_DANGEROUS_CONTENT",
					threshold: "BLOCK_NONE",
				},
			],
			generationConfig: {
				temperature: tomoriState.config.llm_temperature,
				topK: 1,
				topP: 0.95,
				maxOutputTokens: 8192,
				stopSequences: [],
			},
		};
	}

	/**
	 * Stream LLM response directly to a Discord channel
	 * Now uses the modular streaming architecture with StreamOrchestrator and GoogleStreamAdapter
	 * This maintains the exact same interface for full backward compatibility
	 */
	async streamToDiscord(
		channel: BaseGuildTextChannel,
		client: Client,
		tomoriState: TomoriState,
		config: ProviderConfig,
		contextItems: StructuredContextItem[],
		currentTurnModelParts: Array<Record<string, unknown>>,
		emojiStrings?: string[],
		functionInteractionHistory?: Array<{
			functionCall: FunctionCall;
			functionResponse: Record<string, unknown>;
		}>,
		initialInteraction?: CommandInteraction,
		replyToMessage?: Message,
	): Promise<StreamResult> {
		log.info(
			`GoogleProvider: Starting modular streaming for server ${tomoriState.server_id}, model ${config.model}`,
		);

		try {
			// Convert the generic config to Google-specific streaming config
			const googleConfig = config as GoogleProviderConfig;
			
			// Ensure safetySettings exists, provide default if not
			const safetySettings = googleConfig.safetySettings || [
				{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
				{ category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
				{ category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
				{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
			];
			
			const streamConfig: GoogleStreamConfig = {
				...googleConfig,
				// Add Discord streaming constants
				maxMessageLength: DISCORD_STREAMING_CONSTANTS.MAX_SINGLE_MESSAGE_LENGTH,
				flushBufferSize: DISCORD_STREAMING_CONSTANTS.FLUSH_BUFFER_SIZE_REGULAR,
				flushBufferSizeCodeBlock:
					DISCORD_STREAMING_CONSTANTS.FLUSH_BUFFER_SIZE_CODE_BLOCK,
				inactivityTimeoutMs: DISCORD_STREAMING_CONSTANTS.INACTIVITY_TIMEOUT_MS,
				baseTypeSpeedMsPerChar:
					DISCORD_STREAMING_CONSTANTS.BASE_TYPE_SPEED_MS_PER_CHAR,
				maxTypingTimeMs: DISCORD_STREAMING_CONSTANTS.MAX_TYPING_TIME_MS,
				minVisibleTypingDurationMs:
					DISCORD_STREAMING_CONSTANTS.MIN_VISIBLE_TYPING_DURATION_MS,
				humanizerDegree: tomoriState.config.humanizer_degree,
				emojiUsageEnabled: tomoriState.config.emoji_usage_enabled,
				// Convert safety settings to Google format
				safetySettings: safetySettings.map((setting) => ({
					category: setting.category as HarmCategory,
					threshold: setting.threshold as HarmBlockThreshold,
				})),
			};

			// Create streaming context
			const streamContext: StreamContext = {
				// Discord context
				channel,
				client,
				initialInteraction,
				replyToMessage,

				// Application context
				tomoriState,
				contextItems,
				currentTurnModelParts,
				emojiStrings,
				functionInteractionHistory,

				// Provider context
				provider: "google",
				locale: channel.guild.preferredLocale,
			};

			// Create the modular streaming components
			const orchestrator = new StreamOrchestrator();
			const googleAdapter = new GoogleStreamAdapter();

			// Execute streaming with the modular architecture
			log.info(
				"GoogleProvider: Delegating to StreamOrchestrator with GoogleStreamAdapter",
			);
			const result = await orchestrator.streamToDiscord(
				googleAdapter,
				streamConfig,
				streamContext,
			);

			log.info(
				`GoogleProvider: Modular streaming completed with status: ${result.status}`,
			);
			return result;
		} catch (error) {
			log.error(
				`GoogleProvider modular streaming error for server ${tomoriState.server_id}, model ${config.model}, channel ${channel.id}`,
				error as Error,
			);

			return {
				status: "error",
				data: error as Error,
			};
		}
	}
}
