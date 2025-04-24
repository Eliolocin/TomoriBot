import {
	GoogleGenAI,
	type GenerateContentConfig,
	DynamicRetrievalConfigMode,
} from "@google/genai";
import { type GeminiConfig, GeminiConfigSchema } from "../types/api/gemini";
import { cleanLLMOutput } from "../utils/text/stringHelper";
import { log } from "../utils/misc/logger";

// Default values for Gemini API
const DEFAULT_MODEL = "gemini-2.5-flash-preview-04-17";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000; // 3 seconds between retries

/**
 * Validates a Google API key by making a small request to check its validity
 * @param apiKey - The API key to validate
 * @returns Promise<boolean> - True if the key is valid, false otherwise
 */
export async function validateApiKey(apiKey: string): Promise<boolean> {
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
				{ text: 'This is a test message for verifying API keys. Say "VALID"' },
			],
		});

		// Make a minimal request just to validate the key
		// We use a simple, low-token prompt that just verifies connectivity
		const responseText = response.text;
		if (!responseText?.toLowerCase().includes("valid")) return false;
		// If we get here without errors, the key is valid

		log.success("API key validation successful");
		return true;
	} catch (error) {
		log.error("API key validation failed", error);
		return false;
	}
}

/**
 * Generates a response using Google's Gemini LLM API with retry logic
 * @param config - Configuration for the Gemini API
 * @param prompt - The context/prompt to send to the LLM
 * @param systemInstruction - Optional system-level instructions
 * @returns The generated response text
 * @throws Error if API call fails after retries or response is invalid
 */
export async function generateGeminiResponse(
	config: GeminiConfig,
	prompt: string,
	systemInstruction?: string,
): Promise<string> {
	log.section("Gemini API Request");

	// Validate config
	try {
		const validatedConfig = GeminiConfigSchema.parse(config);
		log.info("Configuration validated successfully");

		let lastError: Error | undefined;

		// Retry loop
		// Adjust retry delay to respect Google's rate limits

		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			try {
				log.info(`Attempt ${attempt}/${MAX_RETRIES}`);

				// Initialize the Google AI client with provided API key
				const genAI = new GoogleGenAI({ apiKey: validatedConfig.apiKey });

				// Build request configuration
				const requestConfig: GenerateContentConfig = {
					...validatedConfig.generationConfig,
					safetySettings: validatedConfig.safetySettings,
				};

				// Add system instruction if provided
				if (systemInstruction) {
					requestConfig.systemInstruction = systemInstruction;
				}

				// Add tools configuration if provided
				if (validatedConfig.tools && validatedConfig.tools.length > 0) {
					requestConfig.tools = validatedConfig.tools;
					log.info("Using Google Search.");
				}

				// Generate content with properly formatted config for logging
				log.info(
					`Generating content with the following context and config...\n${JSON.stringify(requestConfig, null, 2)}\n${prompt}`,
				);

				// const response = await model.generateContent(prompt, requestConfig);
				const response = await genAI.models.generateContent({
					model: validatedConfig.model || DEFAULT_MODEL,
					contents: [prompt],
					config: requestConfig,
				});

				// Ensure we have a valid response
				if (!response?.text) {
					throw new Error("Empty or invalid response from Gemini API");
				}

				// Return cleaned response
				const result = cleanLLMOutput(response.text);
				console.log(result);

				log.success("Successfully generated response");
				return result;
			} catch (error) {
				lastError = error as Error;
				log.warn(`Attempt ${attempt}/${MAX_RETRIES} failed`, error);

				// If this was our last attempt, throw the error
				if (attempt === MAX_RETRIES) {
					throw new Error(
						`Failed to generate response after ${MAX_RETRIES} attempts`,
					);
				}

				// Wait 3 seconds before retrying to respect rate limits
				log.info(`Waiting ${RETRY_DELAY_MS / 1000} seconds before retry...`);
				await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
			}
		}

		// This should never be reached due to the throw above, but TypeScript wants it
		throw lastError || new Error("Unknown error in Gemini provider");
	} catch (error) {
		log.error("Failed to complete Gemini API request", error);
		throw error;
	}
}

/**
 * Determines which tools to use based on the model name.
 *
 * @param modelName - The LLM model codename from tomoriState
 * @returns The tools configuration array for Gemini
 */
export function getGeminiTools(
	modelName: string,
): Array<Record<string, unknown>> {
	// Convert to lowercase for case-insensitive comparison
	const modelNameLower = modelName.toLowerCase();

	// 1. Flash models with search capability
	if (
		modelNameLower.includes("flash") &&
		(modelNameLower.includes("2.5") || modelNameLower.includes("2.0"))
	) {
		return [{ googleSearch: {} }];
	}

	// 2. Pro models with advanced retrieval
	if (modelNameLower.includes("pro") && modelNameLower.includes("2.5")) {
		return [
			{
				googleSearchRetrieval: {
					dynamicRetrievalConfig: {
						dynamicThreshold: 0.5,
						mode: DynamicRetrievalConfigMode.MODE_DYNAMIC,
					},
				},
			},
		];
	}

	// 3. Default: no tools
	return [];
}
