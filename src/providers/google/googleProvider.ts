/**
 * Google Gemini provider implementation
 * Implements the LLMProvider interface for Google's Gemini AI models
 */

import {
	GoogleGenAI,
	type FunctionCall as GoogleFunctionCall,
	type Part,
	type HarmCategory,
	type HarmBlockThreshold,
} from "@google/genai";
import {
	type LLMProvider,
	type ProviderInfo,
	type ProviderConfig,
	type StreamResult,
	type FunctionCall,
	BaseLLMProvider,
} from "../providerInterface";
import type {
	BaseGuildTextChannel,
	Client,
	CommandInteraction,
	Message,
} from "discord.js";
import { log } from "../../utils/misc/logger";
import type { TomoriState } from "../../types/db/schema";
import type { StructuredContextItem } from "../../types/misc/context";
import { getAvailableTools, type ToolContext } from "../../tools/toolRegistry";
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
			
			// Create tool context for filtering (we need a minimal context for tool discovery)
			// Note: Some properties will be undefined at this stage, but that's okay for tool filtering
			const toolContext: Partial<ToolContext> = {
				tomoriState,
				locale: "en-US", // Default locale for tool discovery
				provider: "google",
			};

			// Get available tools from the registry
			const availableTools = getAvailableTools("google", toolContext as ToolContext);

			if (availableTools.length === 0) {
				log.info(`No tools available for model: ${modelNameLower}`);
				return [];
			}

			// Convert tools to Google format using the adapter
			const googleAdapter = getGoogleToolAdapter();
			const toolsConfig = googleAdapter.convertToolsArray(availableTools);

			// Log enabled tools
			const enabledToolNames = availableTools.map(tool => tool.name);
			log.info(
				`Enabled ${availableTools.length} tools for model: ${modelNameLower} (${enabledToolNames.join(", ")})`
			);

			return toolsConfig;

		} catch (error) {
			log.error(`Failed to get tools for Google provider: ${tomoriState.llm.llm_codename}`, error as Error);
			
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
	 * This is a wrapper around the existing streamGeminiToDiscord function
	 * to maintain compatibility while implementing the provider interface
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
		// Convert the generic config to Google-specific config
		const googleConfig = config as GoogleProviderConfig;

		// Convert function interaction history to Google format if provided
		let googleFunctionHistory:
			| Array<{
					functionCall: GoogleFunctionCall;
					functionResponse: Part;
			  }>
			| undefined;

		if (functionInteractionHistory) {
			googleFunctionHistory = functionInteractionHistory.map((item) => ({
				functionCall: item.functionCall as GoogleFunctionCall,
				functionResponse: item.functionResponse as Part,
			}));
		}

		// Convert currentTurnModelParts to Google Parts format
		const googleModelParts: Part[] = currentTurnModelParts.map(
			(part) => part as Part,
		);

		// Import the existing streamGeminiToDiscord function
		const { streamGeminiToDiscord } = require("./gemini");

		try {
			// Call the existing streaming function with Google-specific types
			const result = await streamGeminiToDiscord(
				channel,
				client,
				tomoriState,
				{
					model: googleConfig.model,
					apiKey: googleConfig.apiKey,
					generationConfig: googleConfig.generationConfig,
					safetySettings: googleConfig.safetySettings.map((setting) => ({
						category: setting.category as HarmCategory,
						threshold: setting.threshold as HarmBlockThreshold,
					})),
					tools: googleConfig.tools,
				},
				contextItems,
				googleModelParts,
				emojiStrings,
				googleFunctionHistory,
				initialInteraction,
				replyToMessage,
			);

			// Convert the result to the provider-agnostic format
			return {
				status: result.status,
				data: result.data,
			};
		} catch (error) {
			log.error(`GoogleProvider streamToDiscord error for server ${tomoriState.server_id}, model ${googleConfig.model}, channel ${channel.id}`, error as Error);

			return {
				status: "error",
				data: error as Error,
			};
		}
	}
}
