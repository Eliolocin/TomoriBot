import {
	GoogleGenAI,
	type GenerateContentConfig,
	//DynamicRetrievalConfigMode,
	BlockedReason, // Corrected import
	FinishReason,
	type FunctionCall,
	type Part,
	type Content, // Added import for finish reason check
} from "@google/genai";
import { type GeminiConfig, GeminiConfigSchema } from "../types/api/gemini";
import { log } from "../utils/misc/logger";
import type { TomoriState } from "@/types/db/schema";
import { selectStickerFunctionDeclaration } from "@/functions/sendSticker";

// Default values for Gemini API
const DEFAULT_MODEL =
	process.env.DEFAULT_GEMINI_MODEL || "gemini-2.5-flash-preview-04-17";
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

// 1. Define the possible output structures from Gemini generation (Rule 13)
export type GeminiResponseOutput =
	| { type: "text_response"; text: string }
	| {
			type: "function_call";
			call: FunctionCall; // Changed to hold the full FunctionCall object
	  };

/**
 * Generates a response using Google's Gemini LLM API with retry logic.
 * Can return either a text response or a function call request.
 * This function handles a single turn; multi-turn function calling loops are managed by the caller.
 * @param config - Configuration for the Gemini API.
 * @param prompt - The primary context/prompt string to send to the LLM. For the first turn, this contains all context.
 * @param functionInteractionHistory - Optional. For subsequent turns in a function calling sequence,
 *                                   this provides the history of previous function calls and their results.
 * @returns A Promise resolving to a GeminiResponseOutput object.
 * @throws Error if API call fails after retries, response is blocked, or response is invalid.
 */
export async function generateGeminiResponse(
	config: GeminiConfig,
	prompt: string, // This is the comprehensive prompt for the first turn
	systemInstruction?: string,
	functionInteractionHistory?: {
		functionCall: FunctionCall;
		functionResponse: Part;
	}[], // For subsequent turns
): Promise<GeminiResponseOutput> {
	// Rule 1
	log.section("Gemini API Request");

	const validatedConfig = GeminiConfigSchema.parse(config); // Rule 3
	log.info("Configuration validated successfully");

	let lastError: Error | undefined;

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			log.info(`Attempt ${attempt}/${MAX_RETRIES}`);
			const genAI = new GoogleGenAI({ apiKey: validatedConfig.apiKey });
			const requestConfig: GenerateContentConfig = {
				...validatedConfig.generationConfig,
				safetySettings: validatedConfig.safetySettings,
			};

			// 1. Prepare contents array (always Content[])
			const contents: Content[] = [];

			// Add system instruction if provided
			if (systemInstruction) {
				requestConfig.systemInstruction = {
					role: "system",
					parts: [{ text: systemInstruction }],
				}; // Format system instruction correctly
			}

			// 2. The main prompt string is always the first 'user' part.
			// For multi-turn, this 'prompt' might be just the latest user message if history is handled separately,
			// but per your design, 'prompt' is the comprehensive context for the *start* of an interaction.
			// For subsequent calls in a function-calling loop, this initial 'prompt' part ensures
			// the original context is always present.
			contents.push({ role: "user", parts: [{ text: prompt }] });

			// 3. Append function call/response history if provided (for multi-turn function calling)
			if (functionInteractionHistory && functionInteractionHistory.length > 0) {
				for (const interaction of functionInteractionHistory) {
					// Add the model's previous function call request
					contents.push({
						role: "model", // The model's turn
						parts: [{ functionCall: interaction.functionCall }],
					});
					// Add our (the user/tool's) response to that function call
					contents.push({
						role: "user", // Per Google's docs, function responses are sent as 'user' role.
						// It can also be role: "function" with specific SDK versions/models.
						// Sticking to 'user' as per the common JS examples for genai SDK.
						parts: [interaction.functionResponse], // functionResponse should be a Part object
					});
				}
				log.info(
					`Appended ${functionInteractionHistory.length} function interaction(s) to the history.`,
				);
			}

			// 4. Add tools (function declarations) to the request config
			if (validatedConfig.tools && validatedConfig.tools.length > 0) {
				requestConfig.tools = validatedConfig.tools;
				log.info(
					`Using tools: ${JSON.stringify(validatedConfig.tools, null, 2)}`,
				);
			}

			log.info(
				`Generating content with model ${validatedConfig.model || DEFAULT_MODEL} and config: ${JSON.stringify(requestConfig, null, 2)}`,
			);
			// Log the content being sent for debugging
			// log.info(`Full 'contents' being sent: ${JSON.stringify(contents, null, 2)}`);

			log.section("Full Prompt");
			log.info(prompt);

			const response = await genAI.models.generateContent({
				model: validatedConfig.model || DEFAULT_MODEL,
				contents: contents, // Use the constructed contents array
				config: requestConfig,
			});

			// --- Block Checks (existing logic remains crucial) ---
			// ... (block checking logic remains the same as in your provided code)
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
				throw new Error(
					`SafetyBlock: Prompt blocked due to ${reason}. ${message}`,
				);
			}
			const candidate = response.candidates?.[0];
			if (candidate?.finishReason) {
				const reason = candidate.finishReason;
				if (
					[
						FinishReason.SAFETY,
						FinishReason.RECITATION,
						FinishReason.BLOCKLIST,
						FinishReason.PROHIBITED_CONTENT,
						FinishReason.SPII,
						FinishReason.IMAGE_SAFETY,
						FinishReason.OTHER,
					].includes(reason)
				) {
					const message = candidate.finishMessage || "No specific message.";
					log.warn(
						`Response blocked or stopped by API. Reason: ${reason}. Message: ${message}`,
					);
					throw new Error(
						`SafetyBlock: Response blocked due to ${reason}. ${message}`,
					);
				}
				if (reason === FinishReason.MAX_TOKENS) {
					log.warn("Response stopped due to reaching max output tokens.");
				}
			}
			if (candidate?.safetyRatings) {
				for (const rating of candidate.safetyRatings) {
					if (rating.blocked) {
						log.warn(
							`Response content blocked by safety rating. Category: ${rating.category}, Probability: ${rating.probability}`,
						);
						throw new Error(
							`SafetyBlock: Response content blocked by safety filter for category ${rating.category}.`,
						);
					}
				}
			}
			// --- End Block Checks ---

			// 5. Check for Function Calls from Gemini
			const functionCalls = response.functionCalls;
			if (functionCalls && functionCalls.length > 0) {
				const firstFunctionCall = functionCalls[0]; // SDK parses args
				log.success(
					`Gemini requested function call: ${firstFunctionCall.name}`,
				);
				log.info(`Arguments: ${JSON.stringify(firstFunctionCall.args)}`);
				// Return an object indicating a function call is requested, with the full FunctionCall object
				return {
					type: "function_call",
					call: firstFunctionCall, // Return the entire FunctionCall object
				};
			}

			// 6. If no function call, proceed as a regular Text Response
			const responseText = response.text;
			if (responseText === undefined || responseText === null) {
				log.warn(
					"Empty response text from Gemini API without explicit block or function call.",
				);
				throw new Error(
					"Empty or invalid response from Gemini API (no text or function call)",
				);
			}

			log.success("Successfully generated text response");
			return { type: "text_response", text: responseText };
		} catch (error) {
			lastError = error as Error;
			log.warn(
				`Attempt ${attempt}/${MAX_RETRIES} failed: ${lastError.message}`,
			);

			// ... (existing non-retryable error check and retry delay logic) ...
			if (
				lastError.message.includes("API key not valid") ||
				lastError.message.includes("PERMISSION_DENIED") ||
				lastError.message.includes("INVALID_ARGUMENT")
			) {
				log.error("Non-retryable error encountered, failing fast.", lastError);
				throw lastError;
			}

			if (attempt === MAX_RETRIES) {
				log.error(
					`Failed to generate response after ${MAX_RETRIES} attempts. Last error: ${lastError.message}`,
				);
				throw lastError;
			}
			log.info(`Waiting ${RETRY_DELAY_MS / 1000} seconds before retry...`);
			await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
		}
	}

	throw (
		lastError || new Error("Unknown error in Gemini provider after retries")
	);
}

/**
 * Determines which tools to use based on the model name and Tomori's configuration.
 *
 * @param tomoriState - The Tomori state containing LLM and configuration details.
 * @returns The tools configuration array for Gemini.
 */
export function getGeminiTools(
	tomoriState: TomoriState,
): Array<Record<string, unknown>> {
	// 1. Initialize an array to hold all tool configurations (e.g., search, function calling)
	const toolsConfig: Array<Record<string, unknown>> = [];
	// 2. Initialize an array specifically for function declarations
	const functionDeclarations: Array<Record<string, unknown>> = [];

	const modelNameLower = tomoriState.llm.llm_codename.toLowerCase();

	/*
	// 3. Add Google Search for capable Flash models (existing logic)
	if (
		modelNameLower.includes("flash") &&
		(modelNameLower.includes("2.5") || modelNameLower.includes("2.0"))
	) {
		toolsConfig.push({ googleSearch: {} }); // googleSearch is a distinct tool type
		log.info(`Enabled Google Search tool for model: ${modelNameLower}`);
	}*/

	// 4. Add Sticker Function Calling if enabled in Tomori's config (Rule 20: Using config)
	if (tomoriState.config.sticker_usage_enabled) {
		functionDeclarations.push(selectStickerFunctionDeclaration);
		log.info(
			`Enabled '${selectStickerFunctionDeclaration.name}' function calling for model: ${modelNameLower}`, // Use the actual function name
		);
	}

	// 5. If there are any function declarations, package them correctly for the tools array
	if (functionDeclarations.length > 0) {
		toolsConfig.push({ functionDeclarations }); // Gemini expects function declarations under this key
	}

	// 6. Log if no tools are enabled
	if (toolsConfig.length === 0) {
		log.info(`No specific tools enabled for model: ${modelNameLower}`);
	}

	return toolsConfig;
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
