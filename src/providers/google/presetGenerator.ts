/**
 * AI-Powered Preset Generation for TomoriBot
 * Uses a dual-agent approach: the provider's configured default handles Google
 * Search Grounding when web search is requested, then the user's configured model
 * generates the structured persona JSON.
 */

import { GoogleGenAI, type Content, type GenerateContentConfig } from "@google/genai";
import type { GeneratePresetParams, PresetGenerationResult } from "@/types/provider/featureInterfaces";
import { PRESET_MAX_STRING_LENGTH, type PresetExportData } from "../../types/preset/presetExport";
import { log } from "../../utils/misc/logger";
import { localizer } from "../../utils/text/localizer";
export type {
  GeneratePresetParams,
  PresetGenerationResult,
} from "@/types/provider/featureInterfaces";

/**
 * Additional context for character search
 */
interface CharacterSearchContext {
  description?: string; // Character description from user
  speechExamples?: string; // How the character should speak
  additionalInstructions?: string; // Extra instructions
}

/**
 * Result of character information search
 */
interface CharacterSearchResult {
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
 * Helper function to safely extract error message from unknown error types
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

function isGoogleModelUnavailableError(errorMessage: string): boolean {
  const normalizedMessage = errorMessage.toLowerCase();
  return (
    normalizedMessage.includes("model not found") ||
    normalizedMessage.includes("model_not_found") ||
    normalizedMessage.includes("no longer available")
  );
}

/**
 * Create localized error message based on error type and Google error code
 * Similar to GoogleStreamAdapter.createErrorDescription
 * @param errorCode - The Google API error code (e.g., "400", "429")
 * @param rawMessage - Raw error message from Google API
 * @param locale - User's locale for localization
 */
function createGoogleErrorMessage(
  errorType: string,
  errorCode: string | number | undefined,
  rawMessage: string,
  locale: string,
): string {
  let googleMessage: string | undefined;

  try {
    if (rawMessage.includes('{"error":')) {
      const jsonMatch = rawMessage.match(/\{.*\}/s);
      if (jsonMatch) {
        const parsedError = JSON.parse(jsonMatch[0]);
        const errorObj = parsedError.error || parsedError;

        if (errorObj?.message && typeof errorObj.message === "string") {
          try {
            const nestedError = JSON.parse(errorObj.message);
            if (nestedError.error?.message) {
              googleMessage = nestedError.error.message;
            }
          } catch {
            // Not nested JSON, use direct message
            googleMessage = errorObj.message;
          }
        }
      }
    }
  } catch {}

  // If we couldn't extract a Google message, use locale-based defaults
  if (!googleMessage) {
    let messageKey: string;

    switch (errorType) {
      case "CONTENT_BLOCKED":
        messageKey = "content_blocked_default_message";
        break;
      case "RATE_LIMIT":
        messageKey = "429_default_message";
        break;
      case "TIMEOUT":
        messageKey = "504_default_message";
        break;
      case "API_KEY":
        messageKey = "403_default_message";
        break;
      case "MODEL_ERROR":
        messageKey = "404_default_message";
        break;
      case "CONNECTION":
        messageKey = "503_default_message";
        break;
      case "EMPTY_RESPONSE":
      case "INVALID_JSON":
      case "VALIDATION_ERROR":
        messageKey = "unknown_default_message";
        break;
      default:
        if (errorCode === 400 || errorCode === "400") {
          if (rawMessage.includes("billing")) {
            messageKey = "400_billing_default_message";
          } else {
            messageKey = "400_default_message";
          }
        } else if (errorCode) {
          messageKey = `${errorCode}_default_message`;
        } else {
          messageKey = "unknown_default_message";
        }
        break;
    }

    try {
      googleMessage = localizer(locale, `genai.google.${messageKey}`);
    } catch {
      // If locale key doesn't exist, use generic fallback
      googleMessage = localizer(locale, "genai.google.unknown_default_message");
    }
  }

  const displayCode = errorCode || "unknown";
  return `Error Code ${displayCode}: ${googleMessage}`;
}

/**
 * Sanitize sample dialogue by removing speaker prefixes
 * Removes patterns like "User:", "Character:", "{{char}}:", etc.
 *
 */
export function sanitizeSampleDialogueText(dialogue: string): string {
  if (!dialogue) return "";

  // Remove speaker prefixes like "User:", "Character:", "{{char}}:", etc.
  const cleaned = dialogue
    .replace(/^{{char}}:\s*/i, "") // Remove {{char}}: prefix
    .replace(/^{{character}}:\s*/i, "") // Remove {{character}}: prefix
    .replace(/^{user}:\s*/i, "") // Remove {user}: prefix
    .replace(/^User:\s*/i, "") // Remove User: prefix
    .replace(/^Character:\s*/i, "") // Remove Character: prefix
    .replace(/^[^:]+:\s*/, ""); // Remove any "Name:" style prefix

  return cleaned.trim();
}

/**
 * Search for character information using Google Search
 * Uses configured Gemini model with Google Search tool enabled
 *
 * @param locale - User's locale for error messages
 * @param context - Optional additional context for search
 */
async function searchCharacterInfo(
  apiKey: string,
  characterName: string,
  locale: string,
  modelName: string,
  context?: CharacterSearchContext,
  client?: GoogleGenAI,
): Promise<CharacterSearchResult> {
  if (!client && (!apiKey || apiKey.trim().length < 10)) {
    return {
      error: createGoogleErrorMessage("API_KEY", 403, "Invalid API key", locale),
      errorType: "API_KEY",
    };
  }

  try {
    const genAI = client ?? new GoogleGenAI({ apiKey });

    const MODEL_NAME = modelName;

    // Configure generation with Google Search tool
    const generationConfig: GenerateContentConfig = {
      temperature: 1.0,
      topP: 0.9,
      maxOutputTokens: 4096,
      tools: [{ googleSearch: {} }], // Enable Google Search
    };

    let prompt = `You are a character information researcher. Search for detailed information about the character "${characterName}".

Search Instructions:
- Use Google Search to find comprehensive information about this character and their franchise
- Look for personality traits, background story, appearance, relationships, and speaking style
- Include sample dialogue lines from actual scenes if available, incorporating their speech quirks and catchphrases if applicable
- If you find the character, provide a detailed biography with sample dialogue examples from actual scenes of the character
- If this character doesn't exist or you can't find reliable information, respond with exactly "None found, this is an original character from the user"

Character Name: ${characterName}`;

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

IMPORTANT: In any dialogue examples, use "{user}" ONLY where you would write the conversation partner's name (not for the pronoun "you"), and "{bot}" ONLY where you would write the character's own name (not for "I"/"me"). Keep ordinary pronouns like "you", "I", and "me" exactly as-is.`;

    const userPromptContent: Content = {
      role: "user",
      parts: [{ text: prompt }],
    };

    log.info(`Searching for character: ${characterName} using model: ${MODEL_NAME}`);

    try {
      // Create timeout promise (60 seconds for search)
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Character search timed out after 60 seconds")), 60000);
      });

      const result = await Promise.race([
        genAI.models.generateContent({
          model: MODEL_NAME,
          contents: [userPromptContent],
          config: generationConfig,
        }),
        timeoutPromise,
      ]);

      log.info(`Character search completed with model: ${MODEL_NAME}`);

      if (result.promptFeedback?.blockReason) {
        return {
          error: createGoogleErrorMessage(
            "BLOCKED_CONTENT",
            "BLOCKED",
            `Character search was blocked: ${result.promptFeedback.blockReason}`,
            locale,
          ),
          errorType: "BLOCKED_CONTENT",
        };
      }

      const responseText = result.text;

      if (!responseText || responseText.trim() === "") {
        return {
          error: createGoogleErrorMessage(
            "EMPTY_RESPONSE",
            undefined,
            "Character search returned an empty response",
            locale,
          ),
          errorType: "EMPTY_RESPONSE",
        };
      }

      log.success(`✨ Character search successful with model: ${MODEL_NAME}`);
      return { characterInfo: responseText.trim() };
    } catch (apiError: unknown) {
      const errorMessage = getErrorMessage(apiError);

      let errorCode: number | undefined;
      try {
        if (errorMessage.includes('{"error":')) {
          const jsonMatch = errorMessage.match(/\{.*\}/s);
          if (jsonMatch) {
            const parsedError = JSON.parse(jsonMatch[0]);
            errorCode = parsedError.error?.code || parsedError.code;
          }
        }
      } catch {}

      if (errorMessage.includes("timed out")) {
        return {
          error: createGoogleErrorMessage("TIMEOUT", 504, errorMessage, locale),
          errorType: "TIMEOUT",
        };
      }

      if (errorMessage.includes("RESOURCE_EXHAUSTED") || errorMessage.includes("rate limit")) {
        return {
          error: createGoogleErrorMessage("RATE_LIMIT", errorCode || 429, errorMessage, locale),
          errorType: "RATE_LIMIT",
        };
      }

      if (errorMessage.includes("INVALID_ARGUMENT") || errorMessage.includes("blocked")) {
        return {
          error: createGoogleErrorMessage("BLOCKED_CONTENT", errorCode || 400, errorMessage, locale),
          errorType: "BLOCKED_CONTENT",
        };
      }

      if (errorMessage.includes("PERMISSION_DENIED") || errorMessage.includes("API key")) {
        return {
          error: createGoogleErrorMessage("API_KEY", errorCode || 403, errorMessage, locale),
          errorType: "API_KEY",
        };
      }

      if (isGoogleModelUnavailableError(errorMessage)) {
        return {
          error: createGoogleErrorMessage("MODEL_ERROR", errorCode || 404, errorMessage, locale),
          errorType: "MODEL_ERROR",
        };
      }

      throw apiError;
    }
  } catch (error) {
    log.error("Character search error:", error);
    const errorMessage = getErrorMessage(error);

    if (error instanceof TypeError && errorMessage.includes("network")) {
      return {
        error: createGoogleErrorMessage("CONNECTION", 503, errorMessage, locale),
        errorType: "CONNECTION",
      };
    }

    return {
      error: createGoogleErrorMessage("UNKNOWN", undefined, errorMessage, locale),
      errorType: "UNKNOWN",
    };
  }
}

/**
 * Generate preset data from user prompts using Gemini with structured output
 * Uses single-agent approach for Gemini 3 models (with web search tools)
 * Uses dual-agent approach for other models (separate search + generation)
 *
 * @param locale - User's locale for error messages
 * @returns Promise<PresetGenerationResult> - Generated preset or error
 */
export async function generatePresetFromPrompt(
  apiKey: string,
  params: GeneratePresetParams,
  locale: string,
  client?: GoogleGenAI,
  defaultSearchModelName?: string,
): Promise<PresetGenerationResult> {
  if (!client && (!apiKey || apiKey.trim().length < 10)) {
    return {
      error: createGoogleErrorMessage("API_KEY", 403, "Invalid API key", locale),
      errorType: "API_KEY",
    };
  }

  try {
    const genAI = client ?? new GoogleGenAI({ apiKey });

    const configuredModel = params.modelName || defaultSearchModelName;
    if (!configuredModel) {
      return {
        error: createGoogleErrorMessage("MODEL_ERROR", 404, "No preset generation model is configured", locale),
        errorType: "MODEL_ERROR",
      };
    }

    const searchAgentModel = defaultSearchModelName || configuredModel;

    let searchInfo: string | undefined;
    if (params.useWebSearch) {
      log.info(`Running search sub-agent (${searchAgentModel}) for "${params.characterName}"`);

      const searchResult = await searchCharacterInfo(
        apiKey,
        params.characterName,
        locale,
        searchAgentModel,
        {
          description: params.characterDescription,
          speechExamples: params.speechExamples,
          additionalInstructions: params.additionalInstructions,
        },
        client,
      );

      // Propagate hard errors (API key, rate limit, etc.)
      if (searchResult.error) {
        return {
          error: searchResult.error,
          errorType: searchResult.errorType,
        };
      }

      searchInfo = searchResult.characterInfo;
      log.info("Search sub-agent completed, proceeding to generation");
    }

    // Set up generation model; always uses the user's configured model so
    //    free-tier users aren't silently upgraded to a paid model.
    let MODEL_NAME = configuredModel;
    const FALLBACK_MODEL = undefined;

    const maxPresetStringLength = PRESET_MAX_STRING_LENGTH;
    const responseJsonSchema = {
      type: "object" as const,
      properties: {
        attribute_list: {
          type: "array" as const,
          description: `Array containing exactly 6 items describing different facets of the character, in this exact order: 1) {bot}'s Description (core identity and essence), 2) {bot}'s Appearance (physical traits and style), 3) {bot}'s Personality (personality traits, comma-separated), 4) {bot}'s Likes (interests and preferences), 5) {bot}'s Dislikes (aversions and pet peeves), 6) {bot}'s Behavioral Quirks (unique mannerisms and patterns). Each item maximum ${maxPresetStringLength} characters, in this specific format per array item: "{bot}'s Description: "`,
          items: {
            type: "string" as const,
            maxLength: maxPresetStringLength,
          },
          minItems: 6,
          maxItems: 6,
        },
        sample_dialogues_in: {
          type: "array" as const,
          description: `Array of exactly 5 example user messages. MUST include these 3 guided scenarios in order: 1) Self-introduction request, 2) Emotional/personal scenario, 3) Practical/functional scenario. Then add 2 free dialogue scenarios that showcase unique character traits. Do NOT prepend with speaker names. Each message maximum ${maxPresetStringLength} characters.`,
          items: {
            type: "string" as const,
            maxLength: maxPresetStringLength,
          },
          minItems: 5,
          maxItems: 5,
        },
        sample_dialogues_out: {
          type: "array" as const,
          description: `Array of exactly 5 character responses paired with sample_dialogues_in. Should reflect the character's speaking style, personality, and demonstrate their full range across the 3 guided scenarios and 2 free scenarios. Do NOT prepend with speaker names. Each response maximum ${maxPresetStringLength} characters.`,
          items: {
            type: "string" as const,
            maxLength: maxPresetStringLength,
          },
          minItems: 5,
          maxItems: 5,
        },
      },
      required: ["attribute_list", "sample_dialogues_in", "sample_dialogues_out"],
    };

    const generationConfig: GenerateContentConfig = {
      temperature: 1.5, // Creative but controlled
      topP: 0.9,
      maxOutputTokens: 8192, // Increased for longer descriptions
      responseMimeType: "application/json",
      responseJsonSchema: responseJsonSchema,
    };

    let prompt = `You are an expert character creator for a Discord chatbot. Create a detailed character profile based on the following information.

Character Name: ${params.characterName}

Character Description:
${params.characterDescription}

How the Character Speaks:
${params.speechExamples}

Instructions:
- Create a rich, detailed character profile in the structured JSON format
- The character should be interesting and engaging for conversation
- Do NOT prepend the sample dialogues with character names or "User:"/"Character:" prefixes - the chat application will handle that
- Use "{user}" ONLY where you would write the conversation partner's name (NOT for the pronoun "you") — keep "you" as "you"
- Use "{bot}" ONLY where you would write the character's own name (NOT for the pronouns "I"/"me") — keep "I" as "I" and "I'm" as "I'm"
- Ensure exactly 5 sample dialogue pairs (sample_dialogues_in paired with sample_dialogues_out)

The attribute_list MUST contain exactly 6 items in this exact order:

1. {bot}'s Description: A comprehensive 2-4 sentence description capturing the character's core identity, essence, and overall vibe. What makes them unique? What's their deal?

2. {bot}'s Appearance: Physical description including hair, eyes, clothing, accessories, and any distinctive features. Be specific and vivid.

3. {bot}'s Personality: A comma-separated list of personality traits that define how they think, act, and interact. Focus on specific, actionable traits (e.g., "selective passion, authentic advisor, music obsessive, practical pessimist").

4. {bot}'s Likes: Things, activities, topics, or concepts the character genuinely enjoys or gravitates toward. Can include brief explanations in parentheses.

5. {bot}'s Dislikes: Things, activities, topics, or concepts the character dislikes, avoids, or finds irritating. Can include brief explanations in parentheses or quotes.

6. {bot}'s Behavioral Quirks: Specific mannerisms, speech patterns, habits, or behaviors that make the character distinctive. How do they express themselves? What are their tells?

The sample_dialogues_in and sample_dialogues_out MUST follow this structure (exactly 5 dialogue pairs):

**3 GUIDED SCENARIOS (Required, in this exact order):**

1. **Self-Introduction Request**: User asks {bot} to introduce themselves (e.g., "Can you introduce yourself, {bot}?" or "Who are you?" or "Tell me about yourself")
   - Response should establish identity, tone, core personality, and set expectations
   - This is the character's "first impression" - make it memorable and authentic

2. **Emotional/Personal Scenario**: User shares feelings, asks for advice, or engages emotionally (e.g., "I'm feeling really down today..." or "I'm having relationship problems..." or "Thanks for helping me, {bot}!")
   - Response should demonstrate empathy, emotional intelligence, and how they handle vulnerability
   - Show their relational depth and caring capacity (or lack thereof, if fitting)

3. **Practical/Functional Scenario**: User asks for help, explanation, or practical advice (e.g., "Can you help me understand taxes?" or "How do I fix this problem?" or "What should I do about...")
   - Response should demonstrate competence, knowledge, and helpfulness
   - Show they can actually be useful beyond just personality

**2 FREE SCENARIOS (Your creative choice):**

4. **Free Dialogue #1**: Choose a scenario that showcases a unique character trait, interest, or quirk
   - Examples: Questions about their specific interests/hobbies, unexpected situations, character-specific topics
   - Make it distinctive and memorable - something that reveals depth

5. **Free Dialogue #2**: Choose another scenario that demonstrates different aspects of the character
   - Avoid repeating patterns from previous dialogues
   - Could be humor, vulnerability, expertise, philosophical musings, or anything that adds dimension`;

    if (searchInfo) {
      if (!searchInfo.includes("None found")) {
        prompt += `\n\nWeb Search Results (use this information to create an authentic character profile):
${searchInfo}

Use the web search information to accurately represent the character's personality, background, and speaking style from their source material.`;
      } else {
        prompt += `\n\nNote: This is an original character. Create a unique profile based on the provided description and image (if any).`;
      }
    }

    if (params.existingPresetContext?.trim()) {
      prompt += `\n\nExisting Character Data (from uploaded card/preset):
Use this as reference material to transform, refine, or expand upon according to the user's description and instructions. Preserve the core character identity while incorporating requested changes.

${params.existingPresetContext.trim()}`;
    }

    if (params.additionalInstructions?.trim()) {
      prompt += `\n\nAdditional Instructions: ${params.additionalInstructions.trim()}`;
    }

    prompt += `\n\nIMPORTANT:
- Respond with COMPLETE valid JSON only
- Follow the exact schema provided with strict length limits
- Exactly 6 items in attribute_list in the exact order specified above (each MAX ${maxPresetStringLength} characters)
- Exactly 5 dialogue pairs following the 3 GUIDED + 2 FREE structure in the exact order specified
- sample_dialogues_in: Keep user messages concise (1-3 sentences, MAX ${maxPresetStringLength} characters each)
- sample_dialogues_out: Character responses can be longer and more detailed to showcase personality (MAX ${maxPresetStringLength} characters each)
- No speaker name prefixes in any dialogue (no "User:", "Character:", "{user}:", "{bot}:", etc.)
- "{user}" and "{bot}" are NAME placeholders, never pronoun replacements: use "{user}" only in place of the conversation partner's name and "{bot}" only in place of the character's own name
- NEVER replace pronouns — write "you", "I", "me", "I'm" literally (e.g. write "I'm {bot}", never "{bot}'m {bot}")
- All string lengths must not exceed ${maxPresetStringLength} characters per item`;

    const promptParts: Array<{
      text?: string;
      inlineData?: { data: string; mimeType: string };
    }> = [{ text: prompt }];

    if (params.imageBase64 && params.imageMimeType) {
      promptParts.push({
        inlineData: {
          data: params.imageBase64,
          mimeType: params.imageMimeType,
        },
      });
      log.info("Image included in generation");
    }

    const userPromptContent: Content = {
      role: "user",
      parts: promptParts,
    };

    log.info(`Generating preset for: ${params.characterName}`);

    // Retry logic with fallback model (only for Gemini 3)
    let lastError: PresetGenerationResult | null = null;
    const modelsToTry = FALLBACK_MODEL ? [MODEL_NAME, FALLBACK_MODEL] : [MODEL_NAME];

    for (const currentModel of modelsToTry) {
      MODEL_NAME = currentModel;
      log.info(`Attempting preset generation with model: ${MODEL_NAME}`);

      try {
        // Create timeout promise (90 seconds for generation)
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("Request timed out after 60 seconds")), 90000);
        });

        const result = await Promise.race([
          genAI.models.generateContent({
            model: MODEL_NAME,
            contents: [userPromptContent],
            config: generationConfig,
          }),
          timeoutPromise,
        ]);

        log.info(`Preset generation completed with model: ${MODEL_NAME}`);

        if (result.promptFeedback?.blockReason) {
          lastError = {
            error: createGoogleErrorMessage(
              "BLOCKED_CONTENT",
              "BLOCKED",
              `Content was blocked by Gemini API safety filters: ${result.promptFeedback.blockReason}`,
              locale,
            ),
            errorType: "BLOCKED_CONTENT",
          };
          continue; // Try fallback model if available
        }

        const responseText = result.text;

        if (!responseText || responseText.trim() === "") {
          lastError = {
            error: createGoogleErrorMessage(
              "EMPTY_RESPONSE",
              undefined,
              "Gemini API returned an empty response. Try using different inputs or a different image.",
              locale,
            ),
            errorType: "EMPTY_RESPONSE",
          };
          continue; // Try fallback model if available
        }

        let parsedResponse: {
          attribute_list?: string[];
          sample_dialogues_in?: string[];
          sample_dialogues_out?: string[];
        };

        try {
          parsedResponse = JSON.parse(responseText);
        } catch (parseError) {
          log.error("Failed to parse generation JSON:", parseError);
          const parseErrorMsg = `Failed to parse character data: ${parseError instanceof Error ? parseError.message : "Invalid JSON format"}`;
          lastError = {
            error: createGoogleErrorMessage("INVALID_JSON", undefined, parseErrorMsg, locale),
            errorType: "INVALID_JSON",
          };
          continue; // Try fallback model if available
        }

        if (
          !parsedResponse.attribute_list ||
          !parsedResponse.sample_dialogues_in ||
          !parsedResponse.sample_dialogues_out
        ) {
          lastError = {
            error: createGoogleErrorMessage(
              "INVALID_JSON",
              undefined,
              "Generated character data is incomplete. Please try again with different inputs.",
              locale,
            ),
            errorType: "INVALID_JSON",
          };
          continue; // Try fallback model if available
        }

        if (!Array.isArray(parsedResponse.attribute_list) || parsedResponse.attribute_list.length !== 6) {
          lastError = {
            error: createGoogleErrorMessage(
              "VALIDATION_ERROR",
              undefined,
              `Generated attribute list must contain exactly 6 items (Description, Appearance, Personality, Likes, Dislikes, Behavioral Quirks). Received ${parsedResponse.attribute_list?.length || 0} items. Please try again.`,
              locale,
            ),
            errorType: "VALIDATION_ERROR",
          };
          continue; // Try fallback model if available
        }

        if (!Array.isArray(parsedResponse.sample_dialogues_in) || parsedResponse.sample_dialogues_in.length !== 5) {
          lastError = {
            error: createGoogleErrorMessage(
              "VALIDATION_ERROR",
              undefined,
              "Generated sample dialogues must contain exactly 5 user inputs. Please try again.",
              locale,
            ),
            errorType: "VALIDATION_ERROR",
          };
          continue; // Try fallback model if available
        }

        if (!Array.isArray(parsedResponse.sample_dialogues_out) || parsedResponse.sample_dialogues_out.length !== 5) {
          lastError = {
            error: createGoogleErrorMessage(
              "VALIDATION_ERROR",
              undefined,
              "Generated sample dialogues must contain exactly 5 character responses. Please try again.",
              locale,
            ),
            errorType: "VALIDATION_ERROR",
          };
          continue; // Try fallback model if available
        }

        const sanitizedDialoguesIn = parsedResponse.sample_dialogues_in.map(sanitizeSampleDialogueText);
        const sanitizedDialoguesOut = parsedResponse.sample_dialogues_out.map(sanitizeSampleDialogueText);

        const preset: PresetExportData = {
          tomori_nickname: params.characterName,
          trigger_words: [params.characterName],
          attribute_list: parsedResponse.attribute_list,
          sample_dialogues_in: sanitizedDialoguesIn,
          sample_dialogues_out: sanitizedDialoguesOut,
        };

        log.success(`Preset generation successful with model: ${MODEL_NAME}`);
        return { preset };
      } catch (apiError: unknown) {
        const errorMessage = getErrorMessage(apiError);

        let errorCode: number | undefined;
        try {
          if (errorMessage.includes('{"error":')) {
            const jsonMatch = errorMessage.match(/\{.*\}/s);
            if (jsonMatch) {
              const parsedError = JSON.parse(jsonMatch[0]);
              errorCode = parsedError.error?.code || parsedError.code;
            }
          }
        } catch {}

        if (errorMessage.includes("timed out")) {
          lastError = {
            error: createGoogleErrorMessage("TIMEOUT", 504, errorMessage, locale),
            errorType: "TIMEOUT",
          };
          continue; // Try fallback model if available
        }

        if (errorMessage.includes("RESOURCE_EXHAUSTED") || errorMessage.includes("rate limit")) {
          lastError = {
            error: createGoogleErrorMessage("RATE_LIMIT", errorCode || 429, errorMessage, locale),
            errorType: "RATE_LIMIT",
          };
          // Don't retry on rate limit
          return lastError;
        }

        if (errorMessage.includes("INVALID_ARGUMENT") || errorMessage.includes("blocked")) {
          lastError = {
            error: createGoogleErrorMessage("BLOCKED_CONTENT", errorCode || 400, errorMessage, locale),
            errorType: "BLOCKED_CONTENT",
          };
          continue; // Try fallback model if available
        }

        if (errorMessage.includes("PERMISSION_DENIED") || errorMessage.includes("API key")) {
          lastError = {
            error: createGoogleErrorMessage("API_KEY", errorCode || 403, errorMessage, locale),
            errorType: "API_KEY",
          };
          // Don't retry on auth error
          return lastError;
        }

        if (isGoogleModelUnavailableError(errorMessage)) {
          lastError = {
            error: createGoogleErrorMessage("MODEL_ERROR", errorCode || 404, errorMessage, locale),
            errorType: "MODEL_ERROR",
          };
          log.warn(`Model ${MODEL_NAME} not found, trying fallback...`);
          continue; // Try fallback model if available
        }

        throw apiError;
      }
    }

    if (lastError) {
      return lastError;
    }

    // Fallback error if no lastError was set (should never happen)
    return {
      error: createGoogleErrorMessage("UNKNOWN", undefined, "Preset generation failed with no error details", locale),
      errorType: "UNKNOWN",
    };
  } catch (error) {
    log.error("Preset generation error:", error);
    const errorMessage = getErrorMessage(error);

    if (error instanceof TypeError && errorMessage.includes("network")) {
      return {
        error: createGoogleErrorMessage("CONNECTION", 503, errorMessage, locale),
        errorType: "CONNECTION",
      };
    }

    return {
      error: createGoogleErrorMessage("UNKNOWN", undefined, errorMessage, locale),
      errorType: "UNKNOWN",
    };
  }
}
