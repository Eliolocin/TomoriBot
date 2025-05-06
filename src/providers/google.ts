import {
	GoogleGenAI,
	type GenerateContentConfig,
	//DynamicRetrievalConfigMode,
	BlockedReason, // Corrected import
	FinishReason, // Added import for finish reason check
} from "@google/genai";
import { type GeminiConfig, GeminiConfigSchema } from "../types/api/gemini";
import { log } from "../utils/misc/logger";
import type { TomoriState } from "@/types/db/schema";

// Default values for Gemini API
const DEFAULT_MODEL = "gemini-2.5-flash-preview-04-17";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000; // 3 seconds between retries
// const DYNAMIC_SEARCH_THRESHOLD = 0.5;

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
 * Generates a response using Google's Gemini LLM API with retry logic
 * @param config - Configuration for the Gemini API
 * @param prompt - The context/prompt to send to the LLM
 * @param systemInstruction - Optional system-level instructions
 * @returns The generated response text
 * @throws Error if API call fails after retries, response is blocked, or response is invalid
 */
export async function generateGeminiResponse(
	config: GeminiConfig,
	prompt: string,
	systemInstruction?: string,
): Promise<string> {
	log.section("Gemini API Request");

	// Validate config
	const validatedConfig = GeminiConfigSchema.parse(config);
	log.info("Configuration validated successfully");

	let lastError: Error | undefined;

	// Retry loop
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
				requestConfig.systemInstruction = {
					role: "system",
					parts: [{ text: systemInstruction }],
				}; // Format system instruction correctly
			}

			// Add tools configuration if provided
			if (validatedConfig.tools && validatedConfig.tools.length > 0) {
				requestConfig.tools = validatedConfig.tools;
				log.info("Using Google Search/Retrieval tools.");
			}

			// Log the request details
			log.info(
				`Generating content with model ${validatedConfig.model || DEFAULT_MODEL} and config: ${JSON.stringify(requestConfig, null, 2)}`,
			);
			log.section("Full Prompt");
			log.info(`${prompt}`); // Log prompt separately for clarity

			// const response = await model.generateContent(prompt, requestConfig);
			const response = await genAI.models.generateContent({
				model: validatedConfig.model || DEFAULT_MODEL,
				contents: [prompt],
				config: requestConfig,
			});

			// --- Check for Blocks ---
			// 1. Check prompt feedback for blocks
			if (
				response.promptFeedback?.blockReason &&
				response.promptFeedback.blockReason !==
					BlockedReason.BLOCKED_REASON_UNSPECIFIED
			) {
				const reason = response.promptFeedback.blockReason;
				const message =
					response.promptFeedback.blockReasonMessage || "No specific message.";
				log.warn(
					`Prompt blocked by API. Reason: ${reason}. Message: ${message}`,
				);
				// Throw a specific error for prompt blocks
				throw new Error(
					`SafetyBlock: Prompt blocked due to ${reason}. ${message}`,
				);
			}

			// 2. Check candidate finish reason for blocks
			const candidate = response.candidates?.[0];
			if (candidate?.finishReason) {
				const reason = candidate.finishReason;
				// Check for various block/safety related finish reasons
				if (
					[
						FinishReason.SAFETY,
						FinishReason.RECITATION,
						FinishReason.BLOCKLIST,
						FinishReason.PROHIBITED_CONTENT,
						FinishReason.SPII,
						FinishReason.IMAGE_SAFETY, // Though less likely for text-only
						FinishReason.OTHER, // Sometimes used for policy violations
					].includes(reason)
				) {
					const message = candidate.finishMessage || "No specific message.";
					log.warn(
						`Response blocked or stopped by API. Reason: ${reason}. Message: ${message}`,
					);
					// Throw a specific error for response blocks
					throw new Error(
						`SafetyBlock: Response blocked due to ${reason}. ${message}`,
					);
				}
				// Also handle MAX_TOKENS explicitly if needed, though it's not strictly an error/block
				if (reason === FinishReason.MAX_TOKENS) {
					log.warn("Response stopped due to reaching max output tokens.");
					// Continue processing the partial response
				}
			}

			// 3. Check safety ratings directly (optional, more granular)
			if (candidate?.safetyRatings) {
				for (const rating of candidate.safetyRatings) {
					if (rating.blocked) {
						log.warn(
							`Response content blocked by safety rating. Category: ${rating.category}, Probability: ${rating.probability}`,
						);
						// Throw a specific error if any rating blocks the content
						throw new Error(
							`SafetyBlock: Response content blocked by safety filter for category ${rating.category}.`,
						);
					}
				}
			}
			// --- End Block Checks ---

			// Ensure we have a valid response text
			const responseText = response.text; // Use the text getter
			if (!responseText) {
				// If no text and no block reason identified above, it's an unexpected empty response
				log.warn(
					"Empty response from Gemini API without explicit block reason.",
				);
				throw new Error("Empty or invalid response from Gemini API");
			}

			log.success("Successfully generated response");
			return responseText;
		} catch (error) {
			lastError = error as Error;
			log.warn(
				`Attempt ${attempt}/${MAX_RETRIES} failed: ${lastError.message}`,
			);

			// Check for specific non-retryable errors (like invalid API key)
			if (
				lastError.message.includes("API key not valid") ||
				lastError.message.includes("PERMISSION_DENIED") ||
				lastError.message.includes("INVALID_ARGUMENT") // Malformed requests shouldn't be retried
			) {
				log.error("Non-retryable error encountered, failing fast.", lastError);
				throw lastError; // Re-throw immediately
			}

			// If this was our last attempt, throw the error
			if (attempt === MAX_RETRIES) {
				log.error(
					`Failed to generate response after ${MAX_RETRIES} attempts. Last error: ${lastError.message}`,
				);
				throw lastError; // Throw the last encountered error
			}

			// Wait before retrying for potentially transient errors (rate limits, server issues)
			log.info(`Waiting ${RETRY_DELAY_MS / 1000} seconds before retry...`);
			await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
		}
	}

	// This should technically be unreachable if the loop always throws on the last attempt
	throw (
		lastError || new Error("Unknown error in Gemini provider after retries")
	);
}

/**
 * Determines which tools to use based on the model name.
 *
 * @param modelName - The LLM model codename from tomoriState
 * @returns The tools configuration array for Gemini
 */
export function getGeminiTools(
	tomoriState: TomoriState,
): Array<Record<string, unknown>> {
	const tools: Array<Record<string, unknown>> = [];
	// Convert to lowercase for case-insensitive comparison
	const modelNameLower = tomoriState.llm.llm_codename.toLowerCase();

	// Check if the model supports function calling/tools (most recent models do)
	// Gemini 1.5 Flash/Pro and newer generally support search/retrieval
	// Let's enable Google Search Retrieval for 1.5 Pro and Google Search for 1.5 Flash as a starting point
	// Note: Specific tool availability might change based on API updates.

	if (
		modelNameLower.includes("flash") &&
		(modelNameLower.includes("2.5") || modelNameLower.includes("2.0"))
	) {
		tools.push({ googleSearch: {} });
	}

	if (tomoriState.config.sticker_usage_enabled)
		if (tools.length <= 0)
			// Default: no tools for older or unrecognized models
			log.info(`No specific tools enabled for model: ${modelNameLower}`);
	return tools;
}

// 2. Pro models with advanced retrieval
/*
	if (modelNameLower.includes("pro") && modelNameLower.includes("2.5")) {
		tools.push(
			{
				googleSearchRetrieval: {
					dynamicRetrievalConfig: {
						dynamicThreshold: DYNAMIC_SEARCH_THRESHOLD,
						mode: DynamicRetrievalConfigMode.MODE_DYNAMIC,
					},
				},
			},
		);
	}*/
