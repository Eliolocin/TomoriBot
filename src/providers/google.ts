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
import {
	ContextItemTag,
	type StructuredContextItem,
} from "@/types/misc/context";

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
 * @param contextItems - An array of structured context items (system, user, model turns with text/image parts).
 * @param functionInteractionHistory - Optional. For subsequent turns in a function calling sequence,
 *                                   this provides the history of previous function calls and their results.
 * @returns A Promise resolving to a GeminiResponseOutput object.
 * @throws Error if API call fails after retries, response is blocked, or response is invalid.
 */
export async function generateGeminiResponse(
	config: GeminiConfig,
	contextItems: StructuredContextItem[],
	functionInteractionHistory?: {
		functionCall: FunctionCall;
		functionResponse: Part;
	}[],
): Promise<GeminiResponseOutput> {
	// Rule 18
	log.section("Gemini API Request Preparation");

	// 1. Validate the incoming configuration (Rule 3)
	const validatedConfig = GeminiConfigSchema.parse(config);
	log.info("Configuration validated successfully");

	let lastError: Error | undefined;

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			log.info(`Attempt ${attempt}/${MAX_RETRIES} to generate Gemini content.`);
			const genAI = new GoogleGenAI({ apiKey: validatedConfig.apiKey });

			// 2. Prepare the request configuration for Gemini
			const requestConfig: GenerateContentConfig = {
				...validatedConfig.generationConfig,
				safetySettings: validatedConfig.safetySettings,
				// systemInstruction will be built and set below
			};

			// 3. Initialize arrays for building system instruction and dialogue contents
			const systemInstructionParts: string[] = [];
			const dialogueContents: Content[] = []; // This will become the 'contents' for Gemini

			// 4. Define which metadataTags (for role 'user') should be part of system instruction
			const systemInstructionTags: ContextItemTag[] = [
				ContextItemTag.KNOWLEDGE_SERVER_INFO,
				ContextItemTag.KNOWLEDGE_SERVER_EMOJIS,
				ContextItemTag.KNOWLEDGE_SERVER_STICKERS,
				ContextItemTag.KNOWLEDGE_SERVER_MEMORIES,
				ContextItemTag.KNOWLEDGE_USER_MEMORIES, // Includes user status as per buildContext
				ContextItemTag.KNOWLEDGE_CURRENT_CONTEXT,
			];

			// 5. Process StructuredContextItems:
			//    - Consolidate system-related and knowledge-base items into systemInstruction.
			//    - Convert dialogue items (history, samples) into Gemini's 'contents' format.
			for (const item of contextItems) {
				let itemTextContent = ""; // To store text from text parts

				// 5.a. Extract text content if the item has text parts
				if (item.parts.some((p) => p.type === "text")) {
					itemTextContent = item.parts
						.filter((p) => p.type === "text")
						.map((p) => (p as { type: "text"; text: string }).text) // Type assertion
						.join("\n"); // Join multiple text parts if any
				}

				// 5.b. Check if item should be part of the system instruction
				if (
					item.role === "system" ||
					(item.role === "user" &&
						item.metadataTag &&
						systemInstructionTags.includes(item.metadataTag))
				) {
					if (itemTextContent) {
						systemInstructionParts.push(itemTextContent);
					}
					// If a system/knowledge item also had images, they are currently ignored for systemInstruction.
					// Gemini's systemInstruction is primarily text-based.
					if (item.parts.some((p) => p.type === "image")) {
						log.warn(
							`Image parts found in an item designated for system instruction (tag: ${item.metadataTag}, role: ${item.role}). Images in system instructions are not typically supported by Gemini. Image content will be ignored for this item.`,
						);
					}
				}
				// 5.c. Else, if it's a dialogue item (user/model role for history or samples)
				else if (
					(item.role === "user" || item.role === "model") &&
					item.metadataTag &&
					(item.metadataTag === ContextItemTag.DIALOGUE_HISTORY ||
						item.metadataTag === ContextItemTag.DIALOGUE_SAMPLE)
				) {
					const geminiParts: Part[] = [];
					for (const part of item.parts) {
						if (part.type === "text") {
							geminiParts.push({ text: part.text });
						} else if (part.type === "image") {
							try {
								log.info(
									`Fetching image from URI: ${part.uri} for dialogue content.`,
								);
								const imageResponse = await fetch(part.uri); // Rule 2: Bun.fetch is native
								if (!imageResponse.ok) {
									throw new Error(
										`Failed to fetch image: ${imageResponse.status} ${imageResponse.statusText}`,
									);
								}
								const imageArrayBuffer = await imageResponse.arrayBuffer();
								const base64ImageData =
									Buffer.from(imageArrayBuffer).toString("base64");

								if (part.mimeType) {
									geminiParts.push({
										inlineData: {
											mimeType: part.mimeType,
											data: base64ImageData,
										},
									});
									log.info(
										`Successfully processed and added image to dialogue: ${part.mimeType}`,
									);
								} else {
									log.warn(
										`Skipping image part in dialogue due to missing mimeType. URI: ${part.uri}`,
									);
								}
							} catch (imageError) {
								log.error(
									// Rule 22
									`Failed to process image part for dialogue (URI: ${part.uri}): ${imageError instanceof Error ? imageError.message : String(imageError)}. Skipping image.`,
									imageError instanceof Error
										? imageError
										: new Error(String(imageError)),
									{ metadata: { imageUri: part.uri, contextType: "dialogue" } },
								);
							}
						}
					}
					if (geminiParts.length > 0) {
						dialogueContents.push({ role: item.role, parts: geminiParts });
					}
				} else {
					// This case handles items that don't fit the above criteria,
					// e.g., a 'user' role item without a recognized systemInstructionTag or dialogue tag.
					// Depending on desired behavior, these could be ignored, logged, or added to dialogueContents.
					// For now, let's log and ignore them to keep the prompt clean.
					log.warn(
						`Skipping StructuredContextItem with role '${item.role}' and tag '${item.metadataTag}' as it doesn't fit system instruction or dialogue criteria.`,
						{
							itemDetails: {
								role: item.role,
								metadataTag: item.metadataTag,
								hasText: !!itemTextContent,
								imageCount: item.parts.filter((p) => p.type === "image").length,
							},
						},
					);
				}
			}

			if (systemInstructionParts.length > 0) {
				const fullSystemInstructionText =
					systemInstructionParts.join("\n\n---\n\n"); // Use a clear separator

				// Change: Assign the string directly
				requestConfig.systemInstruction = fullSystemInstructionText;

				log.info(
					`Assembled system instruction. Length: ${fullSystemInstructionText.length}`,
				);
			} else {
				log.warn(
					"No system instruction parts were assembled. Ensure this is intended.",
				);
			}

			// 6. Append function call/response history if provided
			const finalContents = [...dialogueContents]; // Start with processed dialogue items
			if (functionInteractionHistory && functionInteractionHistory.length > 0) {
				for (const interaction of functionInteractionHistory) {
					finalContents.push({
						role: "model",
						parts: [{ functionCall: interaction.functionCall }],
					});
					finalContents.push({
						role: "user", // Gemini uses "user" role for function responses
						parts: [interaction.functionResponse],
					});
				}
				log.info(
					`Appended ${functionInteractionHistory.length} function interaction(s) to the history. Total content items: ${finalContents.length}`,
				);
			}

			// 7. Add tools (function declarations) to the request config
			if (validatedConfig.tools && validatedConfig.tools.length > 0) {
				requestConfig.tools = validatedConfig.tools;
				log.info(
					`Using tools: ${JSON.stringify(validatedConfig.tools, null, 2)}`,
				);
			}

			// 8. Log the final request details
			log.info(
				`Generating content with model ${validatedConfig.model || DEFAULT_MODEL}.`,
			);
			log.section("Full Gemini Request Details"); // Rule 18
			log.info(
				`Request Config (systemInstruction might be long): ${JSON.stringify(
					{
						...requestConfig,
						// Change: Simplified logging for system instruction
						systemInstruction: requestConfig.systemInstruction
							? `${requestConfig.systemInstruction}...`
							: undefined,
					},
					null,
					2,
				)}`,
			);

			// Create a sanitized version of finalContents that hides image data
			const sanitizedContents = finalContents.map((content) => ({
				...content,
				parts: content.parts?.map((part) => {
					if (part.inlineData) {
						// Replace base64 image data with a placeholder
						return {
							inlineData: {
								mimeType: part.inlineData.mimeType,
								data: "[BASE64_IMAGE_DATA_HIDDEN]",
							},
						};
					}
					return part;
				}),
			}));

			log.info(
				`Contents being sent (${finalContents.length} items): ${JSON.stringify(sanitizedContents, null, 2)}`,
			);

			// 9. Make the API call
			const response = await genAI.models.generateContent({
				model: validatedConfig.model || DEFAULT_MODEL,
				contents: finalContents, // Use the assembled dialogue contents
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

			// 10. Check for Function Calls from Gemini
			const functionCalls = response.functionCalls;
			if (functionCalls && functionCalls.length > 0) {
				const firstFunctionCall = functionCalls[0];
				log.success(
					`Gemini requested function call: ${firstFunctionCall.name}`,
				);
				log.info(`Arguments: ${JSON.stringify(firstFunctionCall.args)}`);
				return {
					type: "function_call",
					call: firstFunctionCall,
				};
			}

			// 11. If no function call, proceed as a regular Text Response
			const responseText = response.text;
			if (responseText === undefined || responseText === null) {
				log.warn(
					"Empty response text from Gemini API without explicit block or function call.",
				);
				throw new Error(
					"Empty or invalid response from Gemini API (no text or function call)",
				);
			}

			log.success("Successfully generated text response from Gemini.");
			return { type: "text_response", text: responseText };
		} catch (error) {
			lastError = error as Error;
			log.warn(
				`Attempt ${attempt}/${MAX_RETRIES} failed: ${lastError.message}`,
			);

			if (
				lastError.message.includes("API key not valid") ||
				lastError.message.includes("PERMISSION_DENIED") ||
				lastError.message.includes("INVALID_ARGUMENT") ||
				lastError.message.toLowerCase().includes("billing account")
			) {
				log.error(
					"Non-retryable error encountered with Gemini API, failing fast.",
					lastError,
				);
				throw lastError; // Rule 22: log.error should be used for tracked errors
			}

			if (attempt === MAX_RETRIES) {
				log.error(
					// Rule 22
					`Failed to generate Gemini response after ${MAX_RETRIES} attempts. Last error: ${lastError.message}`,
					lastError,
					{
						errorType: "APIAttemptsFailed",
						metadata: { attempts: MAX_RETRIES },
					},
				);
				throw lastError;
			}
			log.info(
				`Waiting ${RETRY_DELAY_MS / 1000} seconds before next Gemini API retry...`,
			);
			await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
		}
	}

	// This line should ideally not be reached if retry logic is correct
	// Log error before throwing (Rule 22)
	const finalError =
		lastError ||
		new Error("Unknown error in Gemini provider after all retries.");
	await log.error(
		"Exhausted retries for Gemini provider or encountered unknown error.",
		finalError,
		{ errorType: "APIProviderFailure", metadata: { attempts: MAX_RETRIES } },
	);
	throw finalError;
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

	// 3. Add Google Search for capable Flash models (existing logic)
	if (
		modelNameLower.includes("flash") &&
		(modelNameLower.includes("2.5") || modelNameLower.includes("2.0"))
	) {
		toolsConfig.push({ googleSearch: {} }); // googleSearch is a distinct tool type
		log.info(`Enabled Google Search tool for model: ${modelNameLower}`);
	}

	/*

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
	}*/

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
