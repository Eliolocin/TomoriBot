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
import { type GeminiConfig, GeminiConfigSchema } from "../../types/api/gemini";
import { ColorCode, log } from "../../utils/misc/logger";
import { HumanizerDegree, type TomoriState } from "@/types/db/schema";
// import { selectStickerFunctionDeclaration } from "@/functions/sendSticker";
import {
	ContextItemTag,
	type StructuredContextItem,
} from "@/types/misc/context";
import {
	type BaseGuildTextChannel,
	type Client,
	type CommandInteraction,
	type Message,
	MessageFlags,
} from "discord.js";
import {
	chunkMessage,
	cleanLLMOutput,
	humanizeString,
} from "@/utils/text/stringHelper";
import {
	queryGoogleSearchFunctionDeclaration,
	rememberThisFactFunctionDeclaration,
	selectStickerFunctionDeclaration,
} from "./functionCalls";
import { sendStandardEmbed } from "@/utils/discord/embedHelper";

// Default values for Gemini API
const DEFAULT_MODEL =
	process.env.DEFAULT_GEMINI_MODEL || "gemini-2.5-flash-preview-04-17";

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
	/*
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

	// New: 4b. Add Query Google Search Function Calling if enabled in Tomori's config
	if (tomoriState.config.google_search_enabled) {
		functionDeclarations.push(queryGoogleSearchFunctionDeclaration);
		log.info(
			`Enabled '${queryGoogleSearchFunctionDeclaration.name}' function calling for model: ${modelNameLower}`,
		);
	}

	// 5. Add Self-Teach Function Calling if enabled
	if (tomoriState.config.self_teaching_enabled) {
		// Assumes self_teach_enabled is added to TomoriConfigRow
		functionDeclarations.push(rememberThisFactFunctionDeclaration);
		log.info(
			`Enabled '${rememberThisFactFunctionDeclaration.name}' function calling for model: ${modelNameLower}`,
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

// Constants for streaming to Discord
const DISCORD_STREAM_MAX_SINGLE_MESSAGE_LENGTH = 1950;
// Renamed and new constant for code blocks
const DISCORD_STREAM_FLUSH_BUFFER_SIZE_REGULAR = 500; // For normal text
const DISCORD_STREAM_FLUSH_BUFFER_SIZE_CODE_BLOCK = 15000; // Increased significantly for code blocks
// MODIFIED: Regex to handle English periods with lookahead and Japanese periods more broadly.
// 1. Negative lookbehind: Prevents matching periods in English abbreviations (e.g., "Mr.", "vs.") or numbers.
// 2. Non-capturing group for OR condition:
//    a. Captures English period `.` only if followed by whitespace `\s` or end-of-string `$`.
//    b. OR captures Japanese period `。` without the strict whitespace/EOL lookahead.
// const DISCORD_STREAM_PUNCTUATION_FLUSH =
//	/(?<!(?:\b(?:vs|mr|mrs|dr|prof|inc|ltd|co|etc|e\.g|i\.e)|\d))(?:(\.)(?=\s|$)|(。))/i;

// Constants for typing simulation in sendSegment
const BASE_TYPE_SPEED_MS_PER_CHAR = 10;
const MAX_TYPING_TIME_MS = 4000;
const MIN_RANDOM_PAUSE_MS = 250;
const MAX_RANDOM_PAUSE_MS = 1500;
const THINKING_PAUSE_CHANCE = 0.25;
const MIN_VISIBLE_TYPING_DURATION_MS = 750;
const STREAM_INACTIVITY_TIMEOUT_MS = 30000; // 30 seconds
/**
 * Streams a response from Google's Gemini LLM API directly to a Discord channel,
 * sending new messages for segments of the stream.
 *
 * @param channel - The Discord TextChannel to send messages to.
 * @param client - The Discord client instance.
 * @param tomoriState - The current Tomori state.
 * @param geminiConfig - Configuration for the Gemini API.
 * @param contextItems - An array of structured context items for the LLM.
 * @param emojiStrings - Optional array of emoji strings for cleaning.
 * @param functionInteractionHistory - Optional. For subsequent turns in a function calling sequence.
 * @param initialInteraction - Optional. If the stream is triggered by an interaction, pass it for initial error reporting.
 * @returns A Promise resolving to an object indicating the outcome.
 */
export async function streamGeminiToDiscord(
	channel: BaseGuildTextChannel, // Changed from interaction to TextChannel
	_client: Client,
	tomoriState: TomoriState,
	geminiConfig: GeminiConfig,
	contextItems: StructuredContextItem[],
	currentTurnModelParts: Part[], // MODIFIED: Added to accept and update model's streamed parts
	emojiStrings?: string[], // Made optional as it was in the provided snippet
	functionInteractionHistory?: {
		functionCall: FunctionCall;
		functionResponse: Part;
	}[],
	initialInteraction?: CommandInteraction, // Optional: for initial error reporting if applicable
	replyToMessage?: Message, // New parameter: The message to reply to
): Promise<{
	status: "completed" | "function_call" | "error" | "timeout";
	data?: FunctionCall | Error;
}> {
	// 1. Log and Validate Inputs
	log.section("Gemini API Stream to Discord Channel Started");
	const validatedConfig = GeminiConfigSchema.parse(geminiConfig);
	log.info("Config validated for streaming to Discord channel.");

	// Correctly access properties from tomoriState as per schema.ts
	// tomori_nickname is directly on TomoriRow, which is part of TomoriState
	const botName = tomoriState.tomori_nickname;
	const humanizerDegree = tomoriState.config.humanizer_degree;
	const emojiUsageEnabled = tomoriState.config.emoji_usage_enabled;
	// emojiStrings are passed as a parameter, if not, default to empty or fetch from tomoriState if available
	const finalEmojiStrings = emojiStrings || [];

	let lastError: Error | undefined;
	// MODIFIED: Flag to track if we've sent the initial reply for a queued message
	let hasRepliedToOriginalMessage = false;

	// MODIFIED: For stream timeout
	//let lastChunkTime = Date.now();
	let inactivityTimer: NodeJS.Timeout | null = null;
	let streamTimedOut = false;

	const resetInactivityTimer = () => {
		//lastChunkTime = Date.now();
		if (inactivityTimer) clearTimeout(inactivityTimer);
		inactivityTimer = setTimeout(() => {
			log.warn(`Gemini stream to ${channel.id} timed out due to inactivity.`);
			streamTimedOut = true;
			// We can't directly abort streamResultFromSDK.stream,
			// so we'll rely on the loop checking streamTimedOut.
			// If the SDK call itself hangs, this won't help that initial hang.
			// This primarily handles hangs *during* streaming of chunks.
			if (inactivityTimer) clearTimeout(inactivityTimer); // Clear again just in case
		}, STREAM_INACTIVITY_TIMEOUT_MS);
	};

	try {
		const genAI = new GoogleGenAI({ apiKey: validatedConfig.apiKey });

		// 2. Prepare Gemini request
		const requestConfig: GenerateContentConfig = {
			// generationConfig and safetySettings from validatedConfig
			...validatedConfig.generationConfig,
			safetySettings: validatedConfig.safetySettings,
		};
		// Start: Context Assembly
		const systemInstructionParts: string[] = [];
		const dialogueContents: Content[] = [];
		const systemInstructionTags: ContextItemTag[] = [
			ContextItemTag.KNOWLEDGE_SERVER_INFO,
			ContextItemTag.KNOWLEDGE_SERVER_EMOJIS,
			ContextItemTag.KNOWLEDGE_SERVER_STICKERS,
			ContextItemTag.KNOWLEDGE_SERVER_MEMORIES,
			ContextItemTag.KNOWLEDGE_USER_MEMORIES,
			ContextItemTag.KNOWLEDGE_CURRENT_CONTEXT,
		];
		for (const item of contextItems) {
			let itemTextContent = "";
			if (item.parts.some((p) => p.type === "text")) {
				itemTextContent = item.parts
					.filter((p) => p.type === "text")
					.map((p) => (p as { type: "text"; text: string }).text)
					.join("\n");
			}
			if (
				item.role === "system" ||
				(item.role === "user" &&
					item.metadataTag &&
					systemInstructionTags.includes(item.metadataTag))
			) {
				if (itemTextContent) systemInstructionParts.push(itemTextContent);
			} else if (
				(item.role === "user" || item.role === "model") &&
				item.metadataTag &&
				(item.metadataTag === ContextItemTag.DIALOGUE_HISTORY ||
					item.metadataTag === ContextItemTag.DIALOGUE_SAMPLE)
			) {
				const geminiParts: Part[] = [];
				for (const part of item.parts) {
					if (part.type === "text") geminiParts.push({ text: part.text });
					else if (part.type === "image" && part.uri && part.mimeType) {
						// Added null checks for uri and mimeType
						try {
							const imageResponse = await fetch(part.uri);
							if (!imageResponse.ok)
								throw new Error(`Img fetch fail: ${imageResponse.status}`);
							const imageArrayBuffer = await imageResponse.arrayBuffer();
							const base64ImageData =
								Buffer.from(imageArrayBuffer).toString("base64");
							if (part.mimeType)
								geminiParts.push({
									inlineData: {
										mimeType: part.mimeType,
										data: base64ImageData,
									},
								});
						} catch (imgErr) {
							log.warn(`Stream: Img proc. error ${part.uri}`, {
								error:
									imgErr instanceof Error ? imgErr.message : String(imgErr),
							});
						}
					}
				}
				if (geminiParts.length > 0)
					dialogueContents.push({ role: item.role, parts: geminiParts });
			}
		}
		if (systemInstructionParts.length > 0) {
			requestConfig.systemInstruction =
				systemInstructionParts.join("\n\n---\n\n");
			log.info(
				`Assembled system instruction. Length: ${requestConfig.systemInstruction.length}`,
			);
			// log.info(`System Instruction: ${requestConfig.systemInstruction}`); // Potentially very long
		}
		const finalContents = [...dialogueContents];

		// Add parts that the model has already streamed in the current turn (Rule 26)
		if (currentTurnModelParts.length > 0) {
			finalContents.push({ role: "model", parts: [...currentTurnModelParts] });
			log.info(
				`Added ${currentTurnModelParts.length} accumulated model text parts to current turn API history.`,
			);
		}
		if (functionInteractionHistory && functionInteractionHistory.length > 0) {
			for (const item of functionInteractionHistory) {
				finalContents.push({
					role: "model",
					parts: [{ functionCall: item.functionCall }],
				});
				finalContents.push({ role: "user", parts: [item.functionResponse] });
			}
		}
		if (validatedConfig.tools && validatedConfig.tools.length > 0) {
			requestConfig.tools = validatedConfig.tools;
		}
		log.info(
			`Generating content with model ${validatedConfig.model || DEFAULT_MODEL}.`,
		);
		log.section("Full Gemini Request Details for Streaming");
		const sanitizedRequestConfigForLog = {
			...requestConfig,
			apiKey: undefined,
		}; // Remove API key for logging
		log.info(
			`Request Config: ${JSON.stringify(sanitizedRequestConfigForLog, null, 2)}`,
		);
		const sanitizedContentsForLog = finalContents.map((content) => ({
			...content,
			parts: content.parts?.map((part) =>
				part.inlineData
					? {
							inlineData: {
								mimeType: part.inlineData.mimeType,
								data: "[BASE64_HIDDEN]",
							},
						}
					: part,
			),
		}));
		log.info(
			`Contents (${finalContents.length} items): ${JSON.stringify(sanitizedContentsForLog, null, 2)}`,
		);
		// End: Context Assembly & Logging

		// 3. Initialize stream state
		let streamBuffer = "";
		let messageSentCount = 0;
		let isInsideCodeBlock = false; // New: State to track if we are inside a code block

		const sendSegment = async (
			segment: string, // This is the output of cleanLLMOutput
			currentHumanizerDegree: number,
		) => {
			if (!segment.trim()) return;

			const rawMessageChunks = chunkMessage(
				segment,
				currentHumanizerDegree,
				DISCORD_STREAM_MAX_SINGLE_MESSAGE_LENGTH,
			);
			if (!rawMessageChunks.length) return;

			const finalMessageChunks: string[] = [];
			for (let chunk of rawMessageChunks) {
				const originalChunkForProcessing = chunk;
				if (currentHumanizerDegree === HumanizerDegree.HEAVY) {
					chunk = humanizeString(chunk);
					if (chunk !== originalChunkForProcessing) {
						log.info(
							`Stream Send: Humanized (D3) from "${originalChunkForProcessing}" to "${chunk}"`, // No substring
						);
					}
				}
				if (chunk.trim()) {
					finalMessageChunks.push(chunk);
				}
			}
			if (!finalMessageChunks.length) return;

			if (currentHumanizerDegree < HumanizerDegree.MEDIUM) {
				for (let i = 0; i < finalMessageChunks.length; i++) {
					const chunkToSend = finalMessageChunks[i];
					await channel
						.sendTyping()
						.catch((e) =>
							log.warn("Stream Send: sendTyping failed (D1 inner)", e),
						);

					// MODIFIED: Check if we need to reply or send
					if (!hasRepliedToOriginalMessage && replyToMessage) {
						await replyToMessage.reply({
							content: chunkToSend,
							allowedMentions: { repliedUser: false },
						});
						hasRepliedToOriginalMessage = true;
					} else {
						await channel.send({ content: chunkToSend });
					}
					messageSentCount++;
					log.info(
						`Stream Send: Sent (D1, C${i + 1}/${finalMessageChunks.length}): "${chunkToSend}"`, // No substring
					);
				}
			} else if (currentHumanizerDegree >= HumanizerDegree.MEDIUM) {
				const firstChunk = finalMessageChunks[0];
				// MODIFIED: Check if we need to reply or send for the first chunk
				if (!hasRepliedToOriginalMessage && replyToMessage) {
					await replyToMessage.reply({
						content: firstChunk,
						allowedMentions: { repliedUser: false },
					});
					hasRepliedToOriginalMessage = true;
				} else {
					await channel.send({ content: firstChunk });
				}
				messageSentCount++;
				log.info(
					`Stream Send: Sent (D${currentHumanizerDegree}, C1/${finalMessageChunks.length}): "${firstChunk}"`, // No substring
				);

				for (let i = 1; i < finalMessageChunks.length; i++) {
					const chunkToSend = finalMessageChunks[i];
					await channel
						.sendTyping()
						.catch((e) =>
							log.warn("Stream Send: sendTyping failed (D>=2 inner)", e),
						);

					let typingTime = Math.min(
						chunkToSend.length * BASE_TYPE_SPEED_MS_PER_CHAR,
						MAX_TYPING_TIME_MS,
					);
					typingTime = Math.max(typingTime, MIN_VISIBLE_TYPING_DURATION_MS);
					if (chunkToSend.includes("```")) {
						typingTime = Math.max(
							typingTime,
							MIN_VISIBLE_TYPING_DURATION_MS * 1.25,
						);
					}

					log.info(
						`Stream Sim: Typing for ${Math.round(typingTime)}ms (D${currentHumanizerDegree})`,
					);
					await new Promise((resolve) => setTimeout(resolve, typingTime));

					await channel.send({ content: chunkToSend });
					messageSentCount++;
					log.info(
						`Stream Send: Sent (D${currentHumanizerDegree}, C${i + 1}/${finalMessageChunks.length}): "${chunkToSend}"`, // No substring
					);

					if (i < finalMessageChunks.length - 1) {
						// ... (thinking pause logic - no changes)
						const isThinkingPause = Math.random() < THINKING_PAUSE_CHANCE;
						let pauseTime = Math.floor(
							MIN_RANDOM_PAUSE_MS +
								Math.random() * (MAX_RANDOM_PAUSE_MS - MIN_RANDOM_PAUSE_MS),
						);
						if (isThinkingPause) {
							pauseTime = Math.max(
								pauseTime * 1.5,
								MIN_VISIBLE_TYPING_DURATION_MS,
							);
							setTimeout(() => {
								channel
									.sendTyping()
									.catch((e) =>
										log.warn("Stream Sim: sendTyping during pause failed", e),
									);
							}, pauseTime / 3);
						}
						log.info(
							`Stream Sim: Pausing for ${Math.round(pauseTime)}ms${isThinkingPause ? " (thinking pause)" : ""}`,
						);
						await new Promise((resolve) => setTimeout(resolve, pauseTime));
					}
				}
			} else {
				for (let i = 0; i < finalMessageChunks.length; i++) {
					const chunkToSend = finalMessageChunks[i];
					await channel.send({ content: chunkToSend });
					messageSentCount++;
					log.info(
						`Stream Send: Sent (D0, C${i + 1}/${finalMessageChunks.length}): "${chunkToSend}"`, // No substring
					);
				}
			}
		};

		// 4. Start the stream
		log.info(
			`Starting Gemini stream to channel ${channel.id} (server: ${channel.guild.id})`,
		);
		await channel
			.sendTyping()
			.catch((e) => log.warn("Stream: Initial sendTyping failed", e));

		resetInactivityTimer(); // Start timer before the first chunk is expected
		const stream = await genAI.models.generateContentStream({
			model: validatedConfig.model || DEFAULT_MODEL,
			contents: finalContents,
			config: requestConfig,
		});

		// 5. Process the stream
		for await (const chunkResponse of stream) {
			if (streamTimedOut) {
				// Check timeout flag
				log.warn(
					`Stream loop breaking due to timeout for channel ${channel.id}.`,
				);
				break;
			}
			resetInactivityTimer();
			if (
				chunkResponse.promptFeedback?.blockReason &&
				chunkResponse.promptFeedback.blockReason !==
					BlockedReason.BLOCKED_REASON_UNSPECIFIED
			) {
				// Reset timer on new chunk
				// 5a. Handle blocks and critical errors
				const reason = chunkResponse.promptFeedback.blockReason;
				const msg = `Stream prompt blocked by API. Reason: ${reason}.`;
				log.warn(msg, chunkResponse.promptFeedback);
				// If an initial interaction was provided, use it for ephemeral error reply
				if (
					initialInteraction &&
					!initialInteraction.replied &&
					!initialInteraction.deferred
				) {
					await initialInteraction
						.reply({ content: msg, flags: MessageFlags.Ephemeral })
						.catch((e) =>
							log.warn(
								"Stream: Failed to reply to initial interaction with error",
								e,
							),
						);
				} else if (initialInteraction) {
					await initialInteraction
						.followUp({ content: msg, flags: MessageFlags.Ephemeral })
						.catch((e) =>
							log.warn(
								"Stream: Failed to followUp initial interaction with error",
								e,
							),
						);
				} else {
					// Otherwise, send to channel (less ideal for blocks, but provides feedback)
					await sendStandardEmbed(channel, channel.guild.preferredLocale, {
						titleKey: "genai.stream.prompt_blocked_title",
						descriptionKey: "genai.stream.prompt_blocked_description",
						descriptionVars: { reason: reason.toString() }, // 'reason' is from chunkResponse.promptFeedback.blockReason
						color: ColorCode.ERROR,
					}).catch((e) =>
						log.warn("Stream: Failed to send block error embed to channel", e),
					);
				}
				return { status: "error", data: new Error(msg) };
			}
			const candidate = chunkResponse.candidates?.[0];
			if (
				candidate?.finishReason &&
				[
					FinishReason.SAFETY,
					FinishReason.OTHER,
					FinishReason.RECITATION, // Added more blocking reasons
					FinishReason.BLOCKLIST,
					FinishReason.PROHIBITED_CONTENT,
					FinishReason.SPII,
					FinishReason.IMAGE_SAFETY,
				].includes(candidate.finishReason)
			) {
				const msg = `Stream response stopped/blocked. Reason: ${candidate.finishReason}.`;
				log.warn(msg, candidate);
				if (
					initialInteraction &&
					!initialInteraction.replied &&
					!initialInteraction.deferred
				) {
					await initialInteraction
						.reply({ content: msg, flags: MessageFlags.Ephemeral })
						.catch((e) =>
							log.warn(
								"Stream: Failed to reply to initial interaction with error",
								e,
							),
						);
				} else if (initialInteraction) {
					await initialInteraction
						.followUp({ content: msg, flags: MessageFlags.Ephemeral })
						.catch((e) =>
							log.warn(
								"Stream: Failed to followUp initial interaction with error",
								e,
							),
						);
				} else {
					await sendStandardEmbed(channel, channel.guild.preferredLocale, {
						titleKey: "genai.stream.response_stopped_title",
						descriptionKey: "genai.stream.response_stopped_description",
						// Corrected: Use candidate.finishReason as 'reason' is not defined here
						descriptionVars: { reason: candidate.finishReason.toString() },
						color: ColorCode.ERROR,
					}).catch((e) =>
						log.warn("Stream: Failed to send stop error embed to channel", e),
					);
				}
				return { status: "error", data: new Error(msg) };
			}

			// 5b. Handle function calls
			const functionCallsInChunk = chunkResponse.functionCalls;
			if (functionCallsInChunk && functionCallsInChunk.length > 0) {
				log.success(
					`Stream API: Function call detected: ${functionCallsInChunk[0].name}`,
				);
				if (streamBuffer.length > 0) {
					// If a function call arrives, flush any pending buffer, even if in a code block.
					if (isInsideCodeBlock) {
						log.warn(
							"Stream Seg: Function call received while inside a code block. Flushing incomplete block.",
						);
						isInsideCodeBlock = false; // Exiting code block mode due to function call
					}

					await channel
						.sendTyping()
						.catch((e) =>
							log.warn("Stream Seg: sendTyping before FC flush failed", e),
						);

					const segmentToProcessBeforeFC = streamBuffer;
					log.info(
						`Stream Seg: Flushing buffer for FC: "${segmentToProcessBeforeFC}"`,
					); // No substring
					const cleanedBuffer = cleanLLMOutput(
						segmentToProcessBeforeFC,
						botName,
						finalEmojiStrings,
						emojiUsageEnabled,
					);
					if (cleanedBuffer !== segmentToProcessBeforeFC) {
						log.info(`Stream Seg: Cleaned for FC to: "${cleanedBuffer}"`); // No substring
					}
					await sendSegment(cleanedBuffer, humanizerDegree);
					streamBuffer = "";
				}

				if (inactivityTimer) clearTimeout(inactivityTimer); // Clear timer before returning
				return { status: "function_call", data: functionCallsInChunk[0] };
			}

			// 5c. Process text parts
			const textPart = chunkResponse.text;
			if (textPart) {
				log.info(`Stream API: Raw chunk received: "${textPart}"`);

				// Add the raw textPart to currentTurnModelParts immediately
				if (textPart.trim()) {
					currentTurnModelParts.push({ text: textPart });
				}

				streamBuffer += textPart;
				// MODIFIED: Add debug logging for code block state
				log.info(
					`Stream Debug: Buffer now "${streamBuffer.length > 100 ? `${streamBuffer.substring(0, 100)}...` : streamBuffer}", isInsideCodeBlock: ${isInsideCodeBlock}`,
				);

				let processedSomethingInIteration: boolean;
				do {
					processedSomethingInIteration = false;
					let segmentToFlush = "";

					if (isInsideCodeBlock) {
						// 1. We are inside a code block, look for the closing triple backticks
						// MODIFIED: Search for closing backticks starting from position 3 (after opening ```)
						const closingBackticksIndex = streamBuffer.indexOf("```", 3);
						log.info(
							`Stream Debug: Looking for closing backticks (starting from pos 3), found at index: ${closingBackticksIndex}`,
						);

						if (closingBackticksIndex !== -1) {
							segmentToFlush = streamBuffer.substring(
								0,
								closingBackticksIndex + 3,
							);
							streamBuffer = streamBuffer.substring(closingBackticksIndex + 3);
							isInsideCodeBlock = false;
							log.info(
								`Stream Seg: Code block closed. Flushing: "${segmentToFlush.length > 100 ? `${segmentToFlush.substring(0, 100)}...` : segmentToFlush}"`,
							);
						} else if (
							streamBuffer.length >= DISCORD_STREAM_FLUSH_BUFFER_SIZE_CODE_BLOCK
						) {
							// Safety flush for excessively long code block without a closing marker
							log.warn(
								`Stream Seg: Flushing oversized code block (no closing found): "${streamBuffer.length} chars"`,
							);
							segmentToFlush = streamBuffer;
							streamBuffer = "";
							isInsideCodeBlock = false;
						}
						// If still in code block, no closing found, and not oversized: continue accumulating
						else {
							log.info(
								`Stream Debug: Still in code block, continuing to accumulate. Buffer length: ${streamBuffer.length}`,
							);
							break; // Break do...while to accumulate more for the code block
						}
					} else {
						// Not currently inside a code block
						// 2. Look for the start of a new code block or natural break points
						const openingBackticksIndex = streamBuffer.indexOf("```");
						const newlineIndex = streamBuffer.indexOf("\n");

						// MODIFIED: Create a new regex instance to avoid state issues
						const periodRegex =
							/(?<!(?:\b(?:vs|mr|mrs|dr|prof|inc|ltd|co|etc|e\.g|i\.e)|\d))(?:(\.)(?=\s|$)|(。))/i;
						const periodMatch = periodRegex.exec(streamBuffer);
						let periodEndIndex = -1;
						if (periodMatch) {
							periodEndIndex = periodMatch.index + periodMatch[0].length;
						}

						log.info(
							`Stream Debug: Break points - opening: ${openingBackticksIndex}, newline: ${newlineIndex}, period: ${periodEndIndex}`,
						);

						// Determine the earliest relevant break point
						let earliestBreakIndex = -1;
						let breakType = "";

						if (openingBackticksIndex !== -1) {
							earliestBreakIndex = openingBackticksIndex;
							breakType = "code_open";
						}
						if (
							newlineIndex !== -1 &&
							(earliestBreakIndex === -1 || newlineIndex < earliestBreakIndex)
						) {
							earliestBreakIndex = newlineIndex;
							breakType = "newline";
						}
						// Only check for period flush if humanizerDegree is HEAVY
						if (humanizerDegree === HumanizerDegree.HEAVY) {
							if (
								periodEndIndex !== -1 &&
								(earliestBreakIndex === -1 ||
									(periodMatch?.index ?? -1) < earliestBreakIndex)
							) {
								// biome-ignore lint/style/noNonNullAssertion: periodMatch existence verified by periodEndIndex check above
								earliestBreakIndex = periodMatch!.index;
								breakType = "period";
							}
						}

						log.info(
							`Stream Debug: Earliest break at ${earliestBreakIndex}, type: ${breakType}`,
						);

						if (earliestBreakIndex !== -1) {
							if (breakType === "code_open") {
								if (earliestBreakIndex > 0) {
									// Text exists before the code block starts, flush that text first
									segmentToFlush = streamBuffer.substring(
										0,
										earliestBreakIndex,
									);
									streamBuffer = streamBuffer.substring(earliestBreakIndex);
									log.info(
										`Stream Seg: Flushing text before code block: "${segmentToFlush.length > 50 ? `${segmentToFlush.substring(0, 50)}...` : segmentToFlush}"`,
									);
								} else {
									// Code block starts at the beginning of the current buffer
									// MODIFIED: Search for closing backticks starting from position 3 (after opening ```)
									const closingInThisSegment = streamBuffer.indexOf("```", 3);
									log.info(
										`Stream Debug: Complete code block check - closing found at: ${closingInThisSegment}`,
									);

									if (closingInThisSegment !== -1) {
										// Complete block found
										segmentToFlush = streamBuffer.substring(
											0,
											closingInThisSegment + 3,
										);
										streamBuffer = streamBuffer.substring(
											closingInThisSegment + 3,
										);
										log.info(
											`Stream Seg: Flushing complete code block: "${segmentToFlush.length > 100 ? `${segmentToFlush.substring(0, 100)}...` : segmentToFlush}"`,
										);
									} else {
										// Code block starts but doesn't end in the current buffer
										isInsideCodeBlock = true;
										log.info(
											`Stream Seg: Entering code block mode. Buffer length: ${streamBuffer.length}`,
										);
										break; // Break do...while to accumulate for the code block
									}
								}
							} else if (breakType === "newline") {
								segmentToFlush = streamBuffer.substring(
									0,
									earliestBreakIndex + 1,
								);
								streamBuffer = streamBuffer.substring(earliestBreakIndex + 1);
								log.info("Stream Seg: Extracted by newline");
							} else if (breakType === "period") {
								segmentToFlush = streamBuffer.substring(0, periodEndIndex);
								streamBuffer = streamBuffer.substring(periodEndIndex);
								log.info("Stream Seg: Extracted by period");
							}
						}
					}

					if (segmentToFlush) {
						await channel
							.sendTyping()
							.catch((e) => log.warn("Stream Seg: sendTyping failed", e));

						const cleanedSegment = cleanLLMOutput(
							segmentToFlush,
							botName,
							finalEmojiStrings,
							emojiUsageEnabled,
						);
						await sendSegment(cleanedSegment, humanizerDegree);
						processedSomethingInIteration = true;
					}
				} while (
					processedSomethingInIteration &&
					streamBuffer.length > 0 &&
					!isInsideCodeBlock
				);

				// After iterative processing, handle buffer size flush for REGULAR text (if not in code block)
				if (
					!isInsideCodeBlock &&
					streamBuffer.length >= DISCORD_STREAM_FLUSH_BUFFER_SIZE_REGULAR
				) {
					log.info(
						`Stream Seg: Flushing oversized regular buffer: ${streamBuffer.length} chars`,
					);
					await channel
						.sendTyping()
						.catch((e) =>
							log.warn("Stream Seg: sendTyping for oversized failed", e),
						);

					const segmentToFlushOversized = streamBuffer;
					streamBuffer = "";
					const cleanedRemainder = cleanLLMOutput(
						segmentToFlushOversized,
						botName,
						finalEmojiStrings,
						emojiUsageEnabled,
					);
					await sendSegment(cleanedRemainder, humanizerDegree);
				}
			}
		} // End of stream for-await loop

		if (inactivityTimer)
			// End of stream for-await loop

			clearTimeout(inactivityTimer);

		if (streamTimedOut) {
			// Clear timer at the end of successful stream or if loop finishes

			// Check after loop if timeout occurred
			return {
				status: "timeout",
				data: new Error("Stream timed out due to inactivity."),
			};
		}

		// Final flush at the end of the stream
		if (streamBuffer.length > 0) {
			log.info(
				`Stream Seg: Flushing final buffer content (${isInsideCodeBlock ? "still in code block" : "regular"}): "${streamBuffer}"`,
			); // No substring
			if (isInsideCodeBlock) {
				log.warn(
					"Stream Seg: Final flush occurred while still inside a code block. The block might be incomplete.",
				);
			}
			await channel
				.sendTyping()
				.catch((e) =>
					log.warn("Stream Seg: sendTyping for final flush failed", e),
				);

			const finalSegmentToFlush = streamBuffer;
			streamBuffer = ""; // Clear before async
			isInsideCodeBlock = false; // Reset state
			const finalCleaned = cleanLLMOutput(
				finalSegmentToFlush,
				botName,
				finalEmojiStrings,
				emojiUsageEnabled,
			);
			if (finalCleaned !== finalSegmentToFlush) {
				log.info(`Stream Seg: Cleaned final to: "${finalCleaned}"`); // No substring
			}
			await sendSegment(finalCleaned, humanizerDegree);
		}

		// 7. If nothing was ever sent (e.g. empty stream and no errors/FC)
		if (messageSentCount === 0) {
			// Check if any message was actually sent
			log.warn("Stream completed without sending any messages.", {
				channelId: channel.id,
			});
			await sendStandardEmbed(channel, channel.guild.preferredLocale, {
				// 'locale' is a parameter of streamGeminiToDiscord
				titleKey: "genai.empty_response_title",
				descriptionKey: "genai.empty_response_description",
				color: ColorCode.WARN, // WARN is suitable for an unexpected but non-critical outcome
			}).catch((e) =>
				log.warn("Stream: Failed to send empty response embed to channel", e),
			);
			messageSentCount++;
		}

		log.success(
			`Gemini stream to channel ${channel.id} completed. Messages sent: ${messageSentCount}`,
		);
		return { status: "completed" };
	} catch (error) {
		if (inactivityTimer) clearTimeout(inactivityTimer); // Clear timer on error
		lastError = error as Error;
		// Corrected: tomoriState.server_id is directly on tomoriState
		const errorContext = {
			serverId: tomoriState.server_id,
			errorType: "APIStreamError",
			metadata: { channelId: channel.id },
		};
		log.error(
			// Rule 22
			`Gemini stream to channel failed: ${lastError.message}`,
			lastError,
			errorContext,
		);

		// Error reporting: Prefer initialInteraction if available, otherwise send to channel
		const errorMessage = `An error occurred while streaming: ${lastError.message}`;
		if (initialInteraction) {
			if (!initialInteraction.replied && !initialInteraction.deferred) {
				await initialInteraction
					.reply({ content: errorMessage, flags: MessageFlags.Ephemeral })
					.catch((e) =>
						log.warn(
							"Stream: Failed to reply to initial interaction with error",
							e,
						),
					);
			} else {
				await initialInteraction
					.followUp({ content: errorMessage, flags: MessageFlags.Ephemeral })
					.catch((e) =>
						log.warn(
							"Stream: Failed to followUp initial interaction with error",
							e,
						),
					);
			}
		} else {
			// Avoid sending detailed errors directly to public channels unless necessary
			// Consider a more generic message or logging only.
			// For now, sending a simplified error.
			await sendStandardEmbed(channel, channel.guild.preferredLocale, {
				titleKey: "genai.generic_error_title",
				descriptionKey: "genai.generic_error_description",
				descriptionVars: { error_message: lastError.message }, // 'lastError' is the caught error
				color: ColorCode.ERROR,
			}).catch((e) =>
				log.warn("Stream: Failed to send generic error embed to channel", e),
			);
		}
		return { status: "error", data: lastError };
	}
}
