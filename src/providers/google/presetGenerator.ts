/**
 * AI-Powered Preset Generation for TomoriBot
 * Uses Google Gemini for structured personality generation with optional web search
 *
 * Two-stage approach:
 * 1. Search stage (optional): Gemini 2.5 Flash with Google Search tool
 * 2. Generation stage: Gemini 2.5 Pro with structured output
 */

import { GoogleGenAI, type Content, type GenerateContentConfig } from "@google/genai";
import type { PresetExportData } from "../../types/preset/presetExport";
import { log } from "../../utils/misc/logger";

/**
 * Parameters for preset generation
 */
export interface GeneratePresetParams {
	characterName: string; // Used for nickname and trigger words
	characterDescription: string; // Core personality description
	speechExamples: string; // How the character speaks
	additionalInstructions?: string; // Extra generation instructions
	imageBase64?: string; // Optional image for visual context
	imageMimeType?: string; // MIME type of the image (e.g., "image/png")
	searchInfo?: string; // Optional web search results to incorporate
}

/**
 * Result of character information search
 */
export interface CharacterSearchResult {
	characterInfo?: string; // Found character information
	error?: string; // Error message if search failed
	errorType?:
		| "RATE_LIMIT"
		| "BLOCKED_CONTENT"
		| "API_KEY"
		| "CONNECTION"
		| "MODEL_ERROR"
		| "TIMEOUT"
		| "EMPTY_RESPONSE"
		| "UNKNOWN";
}

/**
 * Result of preset generation
 */
export interface PresetGenerationResult {
	preset?: PresetExportData; // Generated preset data
	error?: string; // Error message if generation failed
	errorType?:
		| "RATE_LIMIT"
		| "BLOCKED_CONTENT"
		| "API_KEY"
		| "CONNECTION"
		| "MODEL_ERROR"
		| "TIMEOUT"
		| "EMPTY_RESPONSE"
		| "INVALID_JSON"
		| "VALIDATION_ERROR"
		| "UNKNOWN";
}

/**
 * Helper function to safely extract error message from unknown error types
 * @param error - The error to extract a message from
 * @returns Error message string
 */
function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	return "Unknown error";
}

/**
 * Additional context for character search
 */
export interface CharacterSearchContext {
	description?: string; // Character description from user
	speechExamples?: string; // How the character should speak
	additionalInstructions?: string; // Extra instructions
}

/**
 * Search for character information using Google Search
 * Uses Gemini 2.5 Flash with Google Search tool enabled
 *
 * @param apiKey - Decrypted Google API key
 * @param characterName - Name of the character to search for
 * @param context - Optional additional context for search
 * @returns Promise<CharacterSearchResult> - Search results or error
 */
export async function searchCharacterInfo(
	apiKey: string,
	characterName: string,
	context?: CharacterSearchContext,
): Promise<CharacterSearchResult> {
	// 1. Validate API key
	if (!apiKey || apiKey.trim().length < 10) {
		return {
			error: "Invalid API key",
			errorType: "API_KEY",
		};
	}

	try {
		// 2. Initialize Gemini client
		const genAI = new GoogleGenAI({ apiKey });

		// 3. Use Gemini 2.5 Flash for fast and cost-effective search
		const MODEL_NAME = "gemini-2.5-flash";

		// 4. Configure generation with Google Search tool
		const generationConfig: GenerateContentConfig = {
			temperature: 1.0,
			topP: 0.9,
			maxOutputTokens: 4096,
			tools: [{ googleSearch: {} }], // Enable Google Search
		};

		// 5. Build search prompt with all available context
		let prompt = `You are a character information researcher. Search for detailed information about the character "${characterName}".

Search Instructions:
- Use Google Search to find comprehensive information about this character and their franchise
- Look for personality traits, background story, appearance, relationships, and speaking style
- Include sample dialogue lines from actual scenes if available, incorporating their speech quirks and catchphrases if applicable
- If you find the character, provide a detailed biography with sample dialogue examples from actual scenes of the character
- If this character doesn't exist or you can't find reliable information, respond with exactly "None found, this is an original character from the user"

Character Name: ${characterName}`;

		// 6. Add user-provided context to help with search
		if (context?.description?.trim()) {
			prompt += `\n\nUser's Description: ${context.description.trim()}`;
		}

		if (context?.speechExamples?.trim()) {
			prompt += `\n\nUser's Speech Examples: ${context.speechExamples.trim()}`;
		}

		if (context?.additionalInstructions?.trim()) {
			prompt += `\n\nAdditional Context: ${context.additionalInstructions.trim()}`;
		}

		prompt += `\n\nProvide either:
1. A detailed character biography with sample dialogue lines (if character exists)
2. "None found, this is an original character from the user" (if character doesn't exist)

Focus on gathering authentic information that would help create an accurate character representation.

IMPORTANT: In any dialogue examples, use "{user}" as a placeholder when referring to other people or the conversation partner.`;

		// 7. Prepare user prompt content
		const userPromptContent: Content = {
			role: "user",
			parts: [{ text: prompt }],
		};

		log.info(`🔍 Searching for character: ${characterName}`);

		try {
			// 8. Create timeout promise (45 seconds for search)
			const timeoutPromise = new Promise<never>((_, reject) => {
				setTimeout(
					() =>
						reject(new Error("Character search timed out after 45 seconds")),
					45000,
				);
			});

			// 9. Make API call with timeout
			const result = await Promise.race([
				genAI.models.generateContent({
					model: MODEL_NAME,
					contents: [userPromptContent],
					config: generationConfig,
				}),
				timeoutPromise,
			]);

			log.info("✅ Character search completed");

			// 10. Check for blocked content
			if (result.promptFeedback?.blockReason) {
				return {
					error: `Character search was blocked: ${result.promptFeedback.blockReason}`,
					errorType: "BLOCKED_CONTENT",
				};
			}

			const responseText = result.text;

			// 11. Check if response is empty
			if (!responseText || responseText.trim() === "") {
				return {
					error: "Character search returned an empty response",
					errorType: "EMPTY_RESPONSE",
				};
			}

			log.success("Character search successful");
			return { characterInfo: responseText.trim() };
		} catch (apiError: unknown) {
			const errorMessage = getErrorMessage(apiError);

			// 12. Handle specific API errors
			if (errorMessage.includes("timed out")) {
				return {
					error: "Character search timed out",
					errorType: "TIMEOUT",
				};
			}

			if (
				errorMessage.includes("RESOURCE_EXHAUSTED") ||
				errorMessage.includes("rate limit")
			) {
				return {
					error: "Rate limit exceeded for character search",
					errorType: "RATE_LIMIT",
				};
			}

			if (
				errorMessage.includes("INVALID_ARGUMENT") ||
				errorMessage.includes("blocked")
			) {
				return {
					error: "Character search content was blocked",
					errorType: "BLOCKED_CONTENT",
				};
			}

			if (
				errorMessage.includes("PERMISSION_DENIED") ||
				errorMessage.includes("API key")
			) {
				return {
					error: "Invalid API key for character search",
					errorType: "API_KEY",
				};
			}

			if (
				errorMessage.includes("model not found") ||
				errorMessage.includes("MODEL_NOT_FOUND")
			) {
				return {
					error: `Character search model "${MODEL_NAME}" not available`,
					errorType: "MODEL_ERROR",
				};
			}

			// Re-throw for outer catch
			throw apiError;
		}
	} catch (error) {
		log.error("Character search error:", error);
		const errorMessage = getErrorMessage(error);

		// 13. Check for network errors
		if (error instanceof TypeError && errorMessage.includes("network")) {
			return {
				error: "Network error during character search",
				errorType: "CONNECTION",
			};
		}

		return {
			error: `Character search failed: ${errorMessage}`,
			errorType: "UNKNOWN",
		};
	}
}

/**
 * Sanitize sample dialogue by removing speaker prefixes
 * Removes patterns like "User:", "Character:", "{{char}}:", etc.
 *
 * @param dialogue - The dialogue text to sanitize
 * @returns Sanitized dialogue text
 */
export function sanitizeSampleDialogueText(dialogue: string): string {
	if (!dialogue) return "";

	// Remove speaker prefixes like "User:", "Character:", "{{char}}:", etc.
	const cleaned = dialogue
		.replace(/^{{char}}:\s*/i, "") // Remove {{char}}: prefix
		.replace(/^{{character}}:\s*/i, "") // Remove {{character}}: prefix
		.replace(/^{{user}}:\s*/i, "") // Remove {{user}}: prefix
		.replace(/^User:\s*/i, "") // Remove User: prefix
		.replace(/^Character:\s*/i, "") // Remove Character: prefix
		.replace(/^[^:]+:\s*/, ""); // Remove any "Name:" style prefix

	return cleaned.trim();
}

/**
 * Generate preset data from user prompts using Gemini 2.5 Pro with structured output
 *
 * @param apiKey - Decrypted Google API key
 * @param params - Generation parameters
 * @returns Promise<PresetGenerationResult> - Generated preset or error
 */
export async function generatePresetFromPrompt(
	apiKey: string,
	params: GeneratePresetParams,
): Promise<PresetGenerationResult> {
	// 1. Validate API key
	if (!apiKey || apiKey.trim().length < 10) {
		return {
			error: "Invalid API key",
			errorType: "API_KEY",
		};
	}

	try {
		// 2. Initialize Gemini client
		const genAI = new GoogleGenAI({ apiKey });

		// 3. Use Gemini 2.5 Pro for best quality structured output
		const MODEL_NAME = "gemini-2.5-pro";

		// 4. Define JSON schema for structured output with length constraints
		const responseSchema = {
			type: "object" as const,
			properties: {
				attribute_list: {
					type: "array" as const,
					description:
						"Array containing a single item: a 2-3 paragraph detailed description of the character's personality, appearance, background, and distinctive traits. Maximum 2000 characters.",
					items: {
						type: "string" as const,
						maxLength: 2000, // Match validation schema MAX_STRING_LENGTH
					},
					minItems: 1,
					maxItems: 1,
				},
				sample_dialogues_in: {
					type: "array" as const,
					description:
						"Array of exactly 5 example user messages/actions. Each should be realistic and showcase different conversation scenarios. Enclose actions in asterisks. Do NOT prepend with speaker names. Each message maximum 2000 characters.",
					items: {
						type: "string" as const,
						maxLength: 2000, // Match validation schema MAX_STRING_LENGTH
					},
					minItems: 5,
					maxItems: 5,
				},
				sample_dialogues_out: {
					type: "array" as const,
					description:
						"Array of exactly 5 character responses paired with sample_dialogues_in. Should reflect the character's speaking style and personality. Enclose actions in asterisks. Do NOT prepend with speaker names. Each response maximum 2000 characters.",
					items: {
						type: "string" as const,
						maxLength: 2000, // Match validation schema MAX_STRING_LENGTH
					},
					minItems: 5,
					maxItems: 5,
				},
			},
			required: ["attribute_list", "sample_dialogues_in", "sample_dialogues_out"],
		};

		// 5. Configure generation with structured output (no search tool here)
		const generationConfig: GenerateContentConfig = {
			temperature: 1.5, // Creative but controlled
			topP: 0.9,
			maxOutputTokens: 8192, // Increased for longer descriptions
			responseMimeType: "application/json",
			responseSchema: responseSchema,
			// No Google Search tool - search is done separately
		};

		// 6. Build generation prompt
		let prompt = `You are an expert character creator for a Discord chatbot. Create a detailed character profile based on the following information.

Character Name: ${params.characterName}

Character Description:
${params.characterDescription}

How the Character Speaks:
${params.speechExamples}

Instructions:
- Create a rich, detailed character profile in the structured JSON format
- The character should be interesting and engaging for conversation
- Include personality traits, background, physical appearance, and distinctive quirks/characteristics
- Make the sample dialogues natural and reflect the character's personality
- Do NOT prepend the sample dialogues with character names or "User:"/"Character:" prefixes - the chat application will handle that
- Use "{user}" as a placeholder when referring to other people or the conversation partner in dialogues
- Ensure exactly 5 sample dialogue pairs (sample_dialogues_in paired with sample_dialogues_out)
- The attribute_list should contain exactly 1 item: a comprehensive 2-3 paragraph description of the character`;

		// 7. Add web search information if available
		if (params.searchInfo && !params.searchInfo.includes("None found")) {
			prompt += `\n\nWeb Search Results (use this information to create an authentic character profile):
${params.searchInfo}

Use the web search information to accurately represent the character's personality, background, and speaking style from their source material.`;
		} else if (params.searchInfo?.includes("None found")) {
			prompt += `\n\nNote: This is an original character. Create a unique profile based on the provided description and image (if any).`;
		}

		// 8. Add additional instructions if provided
		if (params.additionalInstructions?.trim()) {
			prompt += `\n\nAdditional Instructions: ${params.additionalInstructions.trim()}`;
		}

		prompt += `\n\nIMPORTANT:
- Respond with COMPLETE valid JSON only
- Follow the exact schema provided with strict length limits
- Exactly 1 item in attribute_list (a 2-3 paragraph description, MAX 2000 characters)
- Exactly 5 items in sample_dialogues_in (each MAX 2000 characters, but keep concise 1-3 sentences)
- Exactly 5 items in sample_dialogues_out (each MAX 2000 characters, but keep concise 1-3 sentences)
- No speaker name prefixes in any dialogue (no "User:", "Character:", etc.)
- Use "{user}" as a placeholder when referring to other people in dialogues
- All string lengths must not exceed 2000 characters`;

		// 9. Prepare prompt parts (text + optional image)
		const promptParts: Array<{ text?: string; inlineData?: { data: string; mimeType: string } }> = [
			{ text: prompt },
		];

		// 10. Add image if provided
		if (params.imageBase64 && params.imageMimeType) {
			promptParts.push({
				inlineData: {
					data: params.imageBase64,
					mimeType: params.imageMimeType,
				},
			});
			log.info("📷 Image included in generation");
		}

		// 11. Prepare user prompt content
		const userPromptContent: Content = {
			role: "user",
			parts: promptParts,
		};

		log.info(`🤖 Generating preset for: ${params.characterName}`);

		try {
			// 12. Create timeout promise (60 seconds for generation)
			const timeoutPromise = new Promise<never>((_, reject) => {
				setTimeout(
					() => reject(new Error("Request timed out after 60 seconds")),
					60000,
				);
			});

			// 13. Make API call with timeout
			const result = await Promise.race([
				genAI.models.generateContent({
					model: MODEL_NAME,
					contents: [userPromptContent],
					config: generationConfig,
				}),
				timeoutPromise,
			]);

			log.info("✅ Preset generation completed");

			// 14. Check for blocked content
			if (result.promptFeedback?.blockReason) {
				return {
					error: `Content was blocked by Gemini API safety filters: ${result.promptFeedback.blockReason}`,
					errorType: "BLOCKED_CONTENT",
				};
			}

			const responseText = result.text;

			// 15. Check if response is empty
			if (!responseText || responseText.trim() === "") {
				return {
					error:
						"Gemini API returned an empty response. Try using different inputs or a different image.",
					errorType: "EMPTY_RESPONSE",
				};
			}

			// 16. Parse JSON response
			let parsedResponse: {
				attribute_list?: string[];
				sample_dialogues_in?: string[];
				sample_dialogues_out?: string[];
			};

			try {
				parsedResponse = JSON.parse(responseText);
			} catch (parseError) {
				log.error("Failed to parse generation JSON:", parseError);
				return {
					error: `Failed to parse character data: ${parseError instanceof Error ? parseError.message : "Invalid JSON format"}`,
					errorType: "INVALID_JSON",
				};
			}

			// 17. Validate response structure
			if (
				!parsedResponse.attribute_list ||
				!parsedResponse.sample_dialogues_in ||
				!parsedResponse.sample_dialogues_out
			) {
				return {
					error:
						"Generated character data is incomplete. Please try again with different inputs.",
					errorType: "INVALID_JSON",
				};
			}

			// 18. Validate arrays have correct lengths
			if (
				!Array.isArray(parsedResponse.attribute_list) ||
				parsedResponse.attribute_list.length !== 1
			) {
				return {
					error:
						"Generated attribute list must contain exactly 1 item. Please try again.",
					errorType: "VALIDATION_ERROR",
				};
			}

			if (
				!Array.isArray(parsedResponse.sample_dialogues_in) ||
				parsedResponse.sample_dialogues_in.length !== 5
			) {
				return {
					error:
						"Generated sample dialogues must contain exactly 5 user inputs. Please try again.",
					errorType: "VALIDATION_ERROR",
				};
			}

			if (
				!Array.isArray(parsedResponse.sample_dialogues_out) ||
				parsedResponse.sample_dialogues_out.length !== 5
			) {
				return {
					error:
						"Generated sample dialogues must contain exactly 5 character responses. Please try again.",
					errorType: "VALIDATION_ERROR",
				};
			}

			// 19. Sanitize sample dialogues (remove any speaker prefixes)
			const sanitizedDialoguesIn = parsedResponse.sample_dialogues_in.map(
				sanitizeSampleDialogueText,
			);
			const sanitizedDialoguesOut = parsedResponse.sample_dialogues_out.map(
				sanitizeSampleDialogueText,
			);

			// 20. Build final PresetExportData with hardcoded nickname and trigger words
			const preset: PresetExportData = {
				tomori_nickname: params.characterName,
				trigger_words: [params.characterName],
				attribute_list: parsedResponse.attribute_list,
				sample_dialogues_in: sanitizedDialoguesIn,
				sample_dialogues_out: sanitizedDialoguesOut,
			};

			log.success("✨ Preset generation successful");
			return { preset };
		} catch (apiError: unknown) {
			const errorMessage = getErrorMessage(apiError);

			// 21. Handle specific API errors
			if (errorMessage.includes("timed out")) {
				return {
					error:
						"Request timed out after 60 seconds. Character generation requires more time. Please try again.",
					errorType: "TIMEOUT",
				};
			}

			if (
				errorMessage.includes("RESOURCE_EXHAUSTED") ||
				errorMessage.includes("rate limit")
			) {
				return {
					error: `Rate limit exceeded. Please wait a moment before generating another character. API Error: ${errorMessage}`,
					errorType: "RATE_LIMIT",
				};
			}

			if (
				errorMessage.includes("INVALID_ARGUMENT") ||
				errorMessage.includes("blocked")
			) {
				return {
					error: `Content was blocked by Gemini API safety filters. Try using different inputs or adjusting your descriptions. API Error: ${errorMessage}`,
					errorType: "BLOCKED_CONTENT",
				};
			}

			if (
				errorMessage.includes("PERMISSION_DENIED") ||
				errorMessage.includes("API key")
			) {
				return {
					error: `Invalid or expired API key. Please check your API key configuration. API Error: ${errorMessage}`,
					errorType: "API_KEY",
				};
			}

			if (
				errorMessage.includes("model not found") ||
				errorMessage.includes("MODEL_NOT_FOUND")
			) {
				return {
					error: `Model "${MODEL_NAME}" is not available. Please check your API access. API Error: ${errorMessage}`,
					errorType: "MODEL_ERROR",
				};
			}

			// Re-throw for outer catch
			throw apiError;
		}
	} catch (error) {
		log.error("Preset generation error:", error);
		const errorMessage = getErrorMessage(error);

		// 22. Check for network errors
		if (error instanceof TypeError && errorMessage.includes("network")) {
			return {
				error: `Network error during preset generation. Please check your internet connection. Error: ${errorMessage}`,
				errorType: "CONNECTION",
			};
		}

		return {
			error: `Preset generation failed: ${errorMessage}`,
			errorType: "UNKNOWN",
		};
	}
}
