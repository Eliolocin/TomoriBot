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
import {
	queryGoogleSearchFunctionDeclaration,
	rememberThisFactFunctionDeclaration,
	selectStickerFunctionDeclaration,
} from "./functionCalls";

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
	 * @param tomoriState - The current Tomori state with configuration
	 * @returns Array of tool configurations specific to this provider
	 */
	getTools(tomoriState: TomoriState): Array<Record<string, unknown>> {
		// Initialize an array to hold all tool configurations
		const toolsConfig: Array<Record<string, unknown>> = [];
		// Initialize an array specifically for function declarations
		const functionDeclarations: Array<Record<string, unknown>> = [];

		const modelNameLower = tomoriState.llm.llm_codename.toLowerCase();

		// Add Sticker Function Calling if enabled in Tomori's config
		if (tomoriState.config.sticker_usage_enabled) {
			functionDeclarations.push(selectStickerFunctionDeclaration);
			log.info(
				`Enabled '${selectStickerFunctionDeclaration.name}' function calling for model: ${modelNameLower}`,
			);
		}

		// Add Query Google Search Function Calling if enabled in Tomori's config
		if (tomoriState.config.google_search_enabled) {
			functionDeclarations.push(queryGoogleSearchFunctionDeclaration);
			log.info(
				`Enabled '${queryGoogleSearchFunctionDeclaration.name}' function calling for model: ${modelNameLower}`,
			);
		}

		// Add Self-Teach Function Calling if enabled
		if (tomoriState.config.self_teaching_enabled) {
			functionDeclarations.push(rememberThisFactFunctionDeclaration);
			log.info(
				`Enabled '${rememberThisFactFunctionDeclaration.name}' function calling for model: ${modelNameLower}`,
			);
		}

		// If there are any function declarations, package them correctly for the tools array
		if (functionDeclarations.length > 0) {
			toolsConfig.push({ functionDeclarations }); // Gemini expects function declarations under this key
		}

		// Log if no tools are enabled
		if (toolsConfig.length === 0) {
			log.info(`No specific tools enabled for model: ${modelNameLower}`);
		}

		return toolsConfig;
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
			log.error("GoogleProvider streamToDiscord error:", error as Error, {
				serverId: tomoriState.server_id,
				errorType: "ProviderStreamError",
				metadata: {
					provider: "google",
					model: googleConfig.model,
					channelId: channel.id,
				},
			});

			return {
				status: "error",
				data: error as Error,
			};
		}
	}
}
