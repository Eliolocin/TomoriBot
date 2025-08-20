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
} from "@google/genai";
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
	 * Get available tools/functions based on Tomori's configuration
	 * Uses the modular tool system and Google tool adapter
	 * @param tomoriState - The current Tomori state with configuration
	 * @returns Array of tool configurations specific to this provider
	 */
	getTools(tomoriState: TomoriState): Array<Record<string, unknown>> {
		try {
			const modelNameLower = tomoriState.llm.llm_codename.toLowerCase();

			// Create minimal state for tool filtering during provider config creation
			const toolStateForContext: ToolStateForContext = {
				server_id: tomoriState.server_id.toString(),
				config: {
					sticker_usage_enabled: tomoriState.config.sticker_usage_enabled,
					google_search_enabled: tomoriState.config.google_search_enabled,
					self_teaching_enabled: tomoriState.config.self_teaching_enabled,
				},
			};

			// Get available tools from the registry with proper context
			const availableTools = getAvailableToolsForContext(
				"google",
				toolStateForContext,
			);

			if (availableTools.length === 0) {
				log.info(`No tools available for model: ${modelNameLower}`);
				return [];
			}

			// Convert tools to Google format using the adapter
			const googleAdapter = getGoogleToolAdapter();
			const toolsConfig = googleAdapter.convertToolsArray(availableTools);

			// Log enabled tools
			const enabledToolNames = availableTools.map((tool) => tool.name);
			log.info(
				`Enabled ${availableTools.length} tools for model: ${modelNameLower} (${enabledToolNames.join(", ")})`,
			);

			return toolsConfig;
		} catch (error) {
			log.error(
				`Failed to get tools for Google provider: ${tomoriState.llm.llm_codename}`,
				error as Error,
			);

			// Return empty tools on error to prevent breaking the provider
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
	 * @returns Provider-specific configuration object
	 */
	createConfig(tomoriState: TomoriState, apiKey: string): GoogleProviderConfig {
		return {
			model: tomoriState.llm.llm_codename,
			apiKey: apiKey,
			temperature: tomoriState.config.llm_temperature,
			maxOutputTokens: 8192,
			tools: this.getTools(tomoriState),
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
				safetySettings: googleConfig.safetySettings.map((setting) => ({
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
