import type { Client, Message, Sticker } from "discord.js";
import { BaseGuildTextChannel, DMChannel } from "discord.js"; // Import value for instanceof check
import {
	type GeminiResponseOutput,
	generateGeminiResponse,
	getGeminiTools,
} from "../../providers/google";
import type { ContextSegment } from "../../types/misc/context";
import {
	HarmCategory,
	HarmBlockThreshold,
	type FunctionCall,
	type Part,
} from "@google/genai";
import type { GeminiConfig } from "../../types/api/gemini";
import {
	loadServerEmojis,
	loadTomoriState,
	loadUserRow,
} from "../../utils/db/dbRead";
import { incrementTomoriCounter } from "@/utils/db/dbWrite";
import {
	createStandardEmbed,
	sendStandardEmbed,
} from "../../utils/discord/embedHelper";
import { ColorCode, log } from "../../utils/misc/logger";
import { shouldBotReply } from "../../utils/misc/boolUtils";
import { buildContext } from "../../utils/text/contextBuilder";
import {
	replaceTemplateVariables,
	cleanLLMOutput,
	chunkMessage,
} from "@/utils/text/stringHelper";
import { decryptApiKey } from "@/utils/security/crypto";
import {
	humanizeString,
	sendWithTypingSimulation,
} from "@/utils/text/humanizer";
import { selectStickerFunctionDeclaration } from "@/functions/sendSticker";

// Constants
const MESSAGE_FETCH_LIMIT = 80;
const DEFAULT_TOP_K = 1;
const DEFAULT_TOP_P = 0.9;
const MAX_OUTPUT_TOKENS = 8192;
const CHUNK_LENGTH = 1900;
const HUMANIZE_INSTRUCTION =
	"\nTry to limit yourself to only 0 to 2 emojis per response (from the available server emojis or kaomojis, if your personality uses those) and make sure to respond short and concisely, as a human would in public chatrooms. Only make lengthy responses if and only if a user is asking for assistance or an explanation that warrants it.";

// Base trigger words that will always work (with or without spaces for English)
const BASE_TRIGGER_WORDS = process.env.BASE_TRIGGER_WORDS?.split(",").map(
	(word) => word.trim(),
) || ["tomori", "tomo", "トモリ", "ともり"];

// Conversation reset markers
const CONVERSATION_RESET_MARKERS = ["REFRESH", "refresh", "リフレッシュ"];

const MAX_FUNCTION_CALL_ITERATIONS = 5; // Safety break for function call loops

/**
 * Handles incoming messages to potentially generate a response using genai.
 * @param client - The Discord client instance.
 * @param message - The incoming Discord message.
 */
export default async function tomoriChat(
	client: Client,
	message: Message,
): Promise<void> {
	// 1. Initial Checks & State Loading
	const channel = message.channel;
	let locale = "en-US"; // Default locale

	// Early return if not a guild-based text channel (DMs or group chats)
	if (!(channel instanceof BaseGuildTextChannel)) {
		// Create and send an embed explaining that Tomori only works in servers
		const errorEmbed = createStandardEmbed(locale, {
			color: ColorCode.ERROR,
			titleKey: "general.errors.dm_not_supported_title", // Updated key
			descriptionKey: "general.errors.dm_not_supported_description", // Updated key
		});
		// Check if channel can send messages

		if (
			"send" in channel &&
			channel instanceof DMChannel &&
			// biome-ignore lint/style/noNonNullAssertion: client.user is checked during startup
			message.author.id !== client.user!.id
		) {
			try {
				await channel.send({ embeds: [errorEmbed] });
			} catch (sendError) {
				log.error("Failed to send DM not supported message", sendError);
			}
		}
		return;
	}

	// biome-ignore lint/style/noNonNullAssertion: client.user is checked during startup
	if (!channel.permissionsFor(client.user!)?.has("SendMessages")) return;

	// biome-ignore lint/style/noNonNullAssertion: Guild is always present in guild message events
	const guild = message.guild!;
	const serverDiscId = guild.id; // Keep Discord Guild ID

	// biome-ignore lint/style/noNonNullAssertion: Author is always present in non-system messages
	const userDiscId = message.author!.id;
	let triggererName = message.author.displayName;

	// 2. Load critical state data early to use throughout function
	try {
		// Load Tomori configuration and user data early
		const tomoriState = await loadTomoriState(serverDiscId);
		const userRow = await loadUserRow(userDiscId);
		locale = userRow?.language_pref ?? "en-US"; // Set locale based on user pref
		triggererName = userRow?.user_nickname ?? message.author.displayName;

		// Function to check for base trigger words - stays contained within the try block
		function checkForBaseTriggerWords(content: string): boolean {
			// Check for exact matches with word boundaries (case-insensitive)
			for (const baseWord of BASE_TRIGGER_WORDS) {
				// For Japanese characters, check if the content includes them directly
				if (/[\u3040-\u30FF\u4E00-\u9FFF]/.test(baseWord)) {
					if (content.includes(baseWord)) {
						return true;
					}
				} else {
					// For English triggers, use word boundaries to ensure it's a distinct word
					const regex = new RegExp(`\\b${baseWord}\\b`, "i");
					if (regex.test(content)) {
						return true;
					}
				}
			}
			return false;
		}

		// 3. Enhanced direct trigger checks (base words or direct reply)
		let isReplyToBot = false;
		let isBaseTriggerWord = false;

		// Check if message is a reply to the bot
		if (message.reference?.messageId) {
			try {
				const referenceMessage = await message.channel.messages.fetch(
					message.reference.messageId,
				);
				isReplyToBot = referenceMessage?.author.id === client.user?.id;
			} catch (fetchError) {
				log.warn(
					"Could not fetch reference message for reply check",
					fetchError,
				);
			}
		}

		// Check for base trigger words
		isBaseTriggerWord = checkForBaseTriggerWords(message.content);

		// 4. Early validation for directly triggered messages
		if (isBaseTriggerWord || isReplyToBot) {
			// If user directly mentioned Tomori or replied to it, we should validate
			// Tomori's state and API key immediately

			// Validate Tomori is set up
			if (!tomoriState) {
				log.info(
					`User mentioned Tomori in server ${serverDiscId} but Tomori not set up.`,
				);
				await sendStandardEmbed(channel, locale, {
					color: ColorCode.ERROR,
					titleKey: "general.errors.tomori_not_setup_title",
					descriptionKey: "general.errors.tomori_not_setup_description", // Use description key
				});
				return;
			}

			// Validate API key is configured
			if (!tomoriState.config.api_key) {
				log.info(
					`User mentioned Tomori in server ${serverDiscId} but API key not configured.`,
				);
				await sendStandardEmbed(channel, locale, {
					color: ColorCode.ERROR,
					titleKey: "general.errors.api_key_missing_title", // Use errors namespace
					descriptionKey: "general.errors.api_key_missing_description", // Use errors namespace
				});
				return;
			}
		} else if (!tomoriState) {
			// For non-direct messages, just log and return if Tomori isn't set up
			// log.info(`Tomori state not found for server ${serverDiscId}. Skipping non-triggered message.`); // Reduce noise
			return;
		}

		// 5. Auto-Counter Update (only needs to happen if Tomori is set up)
		const config = tomoriState.config;
		const isAutoChannelActive =
			config.autoch_threshold > 0 && config.autoch_disc_ids.length > 0;

		if (
			!message.author.bot &&
			isAutoChannelActive &&
			config.autoch_disc_ids.includes(channel.id)
		) {
			if (!tomoriState.tomori_id) {
				log.error(
					`Tomori ID missing for server ${serverDiscId} during counter increment.`,
				);
			} else {
				try {
					const updatedTomoriRow = await incrementTomoriCounter(
						tomoriState.tomori_id,
						config.autoch_threshold,
					);
					if (updatedTomoriRow) {
						tomoriState.autoch_counter = updatedTomoriRow.autoch_counter;
						log.info(
							`Auto-message counter updated for server ${serverDiscId}. New value: ${tomoriState.autoch_counter}`,
						);
					} else {
						log.warn(
							`Failed to update auto-message counter for server ${serverDiscId}.`,
						);
					}
				} catch (dbError) {
					log.error(
						`Error updating auto-message counter for server ${serverDiscId}`,
						dbError,
					);
				}
			}
		}

		// 6. Determine if Bot Should Reply using shouldBotReply helper
		if (!shouldBotReply(message, tomoriState)) {
			return;
		}

		log.info(`Conditions met for Gemini reply in server ${serverDiscId}`);

		// 7. Prepare Data for buildContext
		await channel.sendTyping();

		// Fetch messages (newest to oldest is default)
		const fetchedMessages = await channel.messages.fetch({
			limit: MESSAGE_FETCH_LIMIT,
		});

		// Convert to array and reverse to get chronological order (oldest first)
		const messagesArray = Array.from(fetchedMessages.values()).reverse();

		// 8. Find the index of the *last* reset message (most recent)
		// This message could be from the bot (confirmation embed) or a user command
		let resetIndex = -1;
		for (let i = messagesArray.length - 1; i >= 0; i--) {
			const msg = messagesArray[i];

			// Helper function to check if text contains a reset marker (case-insensitive)
			const containsResetMarker = (
				text: string | null | undefined,
			): boolean => {
				if (!text) return false;
				const lowerText = text.toLowerCase();
				// Check if any marker from the list is included in the text
				return CONVERSATION_RESET_MARKERS.some((marker) =>
					lowerText.includes(marker.toLowerCase()),
				);
			};

			// Check if *any* embed in the message contains the reset marker in its title or description
			const embedContainsReset = msg.embeds.some(
				(embed) =>
					containsResetMarker(embed.title) ||
					containsResetMarker(embed.description),
			);

			// If an embed contains the marker, this is our reset point
			if (embedContainsReset) {
				resetIndex = i;
				log.info(
					`Reset marker detected in message content or embed at index ${i} from ${msg.author.username}. History will start after this message.`,
				);
				// Found the most recent reset marker, stop searching
				break;
			}
		}

		// 9. Determine the messages to include in the history
		const startIndex = resetIndex === -1 ? 0 : resetIndex + 1;
		const relevantMessagesArray = messagesArray.slice(startIndex);

		// 10. Build the final conversationHistory string array and user list from relevant messages
		const conversationHistory: string[] = [];
		const userListSet = new Set<string>();
		let lastMessageAuthorId: string | null = null;

		for (const msg of relevantMessagesArray) {
			if (msg.content) {
				const authorId = msg.author.id;
				userListSet.add(authorId);
				const authorName = `<@${authorId}>`;

				if (
					authorId === lastMessageAuthorId &&
					authorId === client.user?.id &&
					conversationHistory.length > 0
				) {
					conversationHistory[conversationHistory.length - 1] +=
						`\n${msg.content}`;
				} else {
					conversationHistory.push(`${authorName}: ${msg.content}`);
					lastMessageAuthorId = authorId;
				}
			}
		}

		const userList = Array.from(userListSet);
		const channelName = channel.name;
		const channelDesc = channel.topic;
		const serverName = guild.name;
		const serverDescription = guild.description;

		let emojiStrings: string[] = [];

		if (tomoriState.config.emoji_usage_enabled) {
			// biome-ignore lint/style/noNonNullAssertion: tomoriState check above guarantees server_id exists
			const emojis = await loadServerEmojis(tomoriState.server_id!);
			if (emojis && emojis.length > 0) {
				// Initialize emojiStrings as an empty array of strings

				emojiStrings = emojis.map(
					(e) =>
						`<${e.is_animated ? "a" : ""}:${e.emoji_name}:${e.emoji_disc_id}>`,
				);
			}
		}

		// 11. Build Context
		let contextSegments: ContextSegment[] = [];
		try {
			contextSegments = await buildContext({
				guildId: serverDiscId,
				serverName,
				serverDescription,
				conversationHistory,
				userList,
				channelDesc,
				channelName,
				client,
				triggererName,
				emojiStrings,
			});
		} catch (error) {
			log.error("Error building context for LLM API Call:", error);
			await sendStandardEmbed(channel, locale, {
				color: ColorCode.ERROR,
				titleKey: "general.errors.context_error_title",
				descriptionKey: "general.errors.context_error_description",
			});
			return;
		}

		// biome-ignore lint/style/noNonNullAssertion: API key presence was validated earlier for triggered messages
		const decryptedApiKey = await decryptApiKey(tomoriState.config.api_key!);
		if (!decryptedApiKey) {
			log.error("API Key is not set or failed to decrypt.");
			await sendStandardEmbed(channel, locale, {
				color: ColorCode.ERROR,
				titleKey: "general.errors.api_key_error_title",
				descriptionKey: "general.errors.api_key_error_description",
			});
			return;
		}

		// 12. Generate Response
		try {
			// Only support Google for now
			if (tomoriState.llm.llm_provider.toLowerCase() !== "google") {
				log.warn(
					`Unsupported LLM provider configured: ${tomoriState.llm.llm_provider}`,
				);
				// Optionally send a message if needed, or just return silently
				return;
			}

			const geminiConfig: GeminiConfig = {
				model: tomoriState.llm.llm_codename,
				apiKey: decryptedApiKey,
				safetySettings: [
					// Example: Adjust safety settings if needed, BLOCK_NONE can be risky
					{
						category: HarmCategory.HARM_CATEGORY_HARASSMENT,
						threshold: HarmBlockThreshold.BLOCK_NONE,
					},
					{
						category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
						threshold: HarmBlockThreshold.BLOCK_NONE,
					},
					{
						category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
						threshold: HarmBlockThreshold.BLOCK_NONE,
					},
					{
						category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
						threshold: HarmBlockThreshold.BLOCK_NONE,
					},
				],
				generationConfig: {
					temperature: config.llm_temperature,
					topK: DEFAULT_TOP_K,
					topP: DEFAULT_TOP_P,
					maxOutputTokens: MAX_OUTPUT_TOKENS,
					stopSequences: [
						`\n${tomoriState.tomori_nickname}:`,
						`\n${triggererName}:`,
					],
				},
				// Tools are determined by the provider function now
				tools: getGeminiTools(tomoriState),
			};

			const promptString = contextSegments
				.sort((a, b) => a.order - b.order)
				.map((segment) => segment.content)
				.join("\n");
			let systemInstruction = tomoriState.attribute_list.join("\n");
			if (config.humanizer_degree >= 1)
				systemInstruction += HUMANIZE_INSTRUCTION;

			const tomoriNickname = tomoriState.tomori_nickname;
			systemInstruction = replaceTemplateVariables(systemInstruction, {
				bot: tomoriNickname,
				user: triggererName,
			});

			// --- Function Calling Loop ---
			let llmFinalResponseText: string | undefined;
			let selectedStickerToSend: Sticker | null = null; // Store the Discord Sticker object
			const functionInteractionHistory: {
				functionCall: FunctionCall;
				functionResponse: Part;
			}[] = [];

			for (let i = 0; i < MAX_FUNCTION_CALL_ITERATIONS; i++) {
				log.info(
					`LLM Call Iteration: ${i + 1}/${MAX_FUNCTION_CALL_ITERATIONS}. History items: ${functionInteractionHistory.length}`,
				);
				const llmOutput: GeminiResponseOutput = await generateGeminiResponse(
					geminiConfig,
					promptString, // Original full prompt is always sent
					systemInstruction, // System instruction is always sent
					functionInteractionHistory.length > 0
						? functionInteractionHistory
						: undefined,
				);

				if (llmOutput.type === "text_response") {
					llmFinalResponseText = llmOutput.text;
					log.success(
						`LLM provided final text response after ${i + 1} iteration(s).`,
					);
					break; // Exit loop, we have the final text
				}

				if (llmOutput.type === "function_call") {
					const funcCall = llmOutput.call;
					log.info(
						`LLM wants to call function: ${funcCall.name} with args: ${JSON.stringify(funcCall.args)}`,
					);

					let functionExecutionResult: Record<string, unknown>; // To hold the outcome of our local function execution

					// 12.a. Execute the function locally based on its name
					if (funcCall.name === selectStickerFunctionDeclaration.name) {
						const stickerIdArg = funcCall.args?.sticker_id;
						if (typeof stickerIdArg === "string") {
							// biome-ignore lint/style/noNonNullAssertion: Guild is checked and asserted earlier
							const discordSticker = guild!.stickers.cache.get(stickerIdArg);
							if (discordSticker) {
								log.success(
									`Sticker '${discordSticker.name}' (${stickerIdArg}) found locally.`,
								);
								functionExecutionResult = {
									status: "sticker_selected_successfully",
									sticker_id: discordSticker.id,
									sticker_name: discordSticker.name,
									sticker_description: discordSticker.description,
									// Potentially add sticker_description if available and useful for LLM
								};
								selectedStickerToSend = discordSticker; // Store the actual Sticker object
							} else {
								log.warn(
									`Sticker with ID ${stickerIdArg} not found in server cache. Informing LLM.`,
								);
								functionExecutionResult = {
									status: "sticker_not_found",
									sticker_id_attempted: stickerIdArg,
									reason:
										"The sticker ID provided was not found among the available server stickers. Please choose from the provided list or do not use a sticker.",
								};
								selectedStickerToSend = null; // Ensure no sticker is sent if selection fails this turn
							}
						} else {
							log.warn(
								"Invalid or missing sticker_id in function call arguments for select_sticker_for_response.",
							);
							functionExecutionResult = {
								status: "sticker_selection_failed_invalid_args",
								reason:
									"The sticker_id argument was missing or not in the expected format. Please provide a valid sticker_id string.",
							};
							selectedStickerToSend = null;
						}
					} else {
						log.warn(
							`LLM called unknown function: ${funcCall.name}. Informing LLM.`,
						);
						functionExecutionResult = {
							status: "unknown_function_called",
							function_name_called: funcCall.name,
							message: `The function '${funcCall.name}' is not recognized or implemented. Please proceed without calling this function, or use one of the available functions.`,
						};
						// We don't break here; let the LLM decide what to do next based on this feedback.
					}

					// 12.b. Add the model's function call and our function's result to the history
					functionInteractionHistory.push({
						functionCall: funcCall, // The FunctionCall object from the LLM
						functionResponse: {
							// This is the 'Part' object for the function response
							functionResponse: {
								name: funcCall.name, // The name of the function that was called
								response: {
									// The actual result of our local execution
									// Wrapping in 'result' is a common pattern shown in Google's examples
									result: functionExecutionResult,
								},
							},
						},
					});

					// 12.c. Safety break if max iterations reached
					if (i === MAX_FUNCTION_CALL_ITERATIONS - 1) {
						log.warn(
							"Max function call iterations reached. LLM did not provide a final text response.",
						);
						llmFinalResponseText =
							"I tried to use a special tool but got a bit stuck. Could you try rephrasing your request?"; // Fallback message
						selectedStickerToSend = null; // Clear any potentially selected sticker
						break;
					}
				}
			}
			if (!llmFinalResponseText) {
				// --- End Function Calling Loop ---

				log.error(
					"LLM interaction finished without a discernible text response after loop.",
				);
				await sendStandardEmbed(channel, locale, {
					color: ColorCode.ERROR,
					titleKey: "genai.generic_error_title",
					descriptionKey: "genai.no_final_response_description", // Create this locale key
				});
				return; // Exit early
			}

			log.success(
				`Tomori generated final response for server ${serverDiscId}.`,
			);
			if (selectedStickerToSend) {
				log.info(`A sticker was selected: ${selectedStickerToSend.name}`);
			}

			log.section("Raw final response from LLM");
			console.log(llmFinalResponseText);

			// 13. Sanitize and Send Response
			let sanitizedReply = cleanLLMOutput(
				llmFinalResponseText, // Use the final text from the loop
				tomoriState.tomori_nickname,
				emojiStrings,
				tomoriState.config.emoji_usage_enabled,
			);

			if (sanitizedReply.length > 0) {
				if (config.humanizer_degree >= 3)
					sanitizedReply = humanizeString(sanitizedReply);

				log.section("Cleaned response");
				console.log(sanitizedReply);

				const messageChunks = chunkMessage(
					sanitizedReply,
					config.humanizer_degree,
					CHUNK_LENGTH,
				);
				log.info(`Sending response in ${messageChunks.length} chunks.`);

				// Prepare sticker payload for sending
				const stickerPayload = selectedStickerToSend
					? [selectedStickerToSend.id]
					: undefined;

				if (config.humanizer_degree >= 2) {
					// Assuming sendWithTypingSimulation can handle a sticker payload
					// It should attach stickers only to the last message it sends.
					await sendWithTypingSimulation(
						channel,
						messageChunks,
						stickerPayload,
					);
				} else {
					for (let j = 0; j < messageChunks.length; j++) {
						const chunk = messageChunks[j];
						const isLastChunk = j === messageChunks.length - 1;
						await channel.send({
							content: chunk,
							stickers: isLastChunk ? stickerPayload : undefined,
						});
					}
				}
			} else {
				// ... (existing logic for empty sanitized reply) ...
				log.warn("Sanitized reply resulted in empty string. Not sending.");
				await sendStandardEmbed(channel, locale, {
					color: ColorCode.WARN,
					titleKey: "genai.empty_response_title",
					descriptionKey: "genai.empty_response_description",
				});
			}
		} catch (error) {
			// --- Enhanced Error Handling ---
			log.error("Error during Response generation or sending:", error);

			let titleKey = "genai.generic_error_title";
			let descriptionKey = "genai.generic_error_description";
			let descriptionVars: Record<string, string> = {};

			if (error instanceof Error) {
				const errorMessage = error.message.toLowerCase();

				// 1. Safety Block Check
				if (errorMessage.startsWith("safetyblock:")) {
					titleKey = "genai.safety_block_title";
					descriptionKey = "genai.safety_block_description";
					// Extract reason if possible
					const reasonMatch = errorMessage.match(/due to (\w+)/);
					descriptionVars = {
						reason: reasonMatch ? reasonMatch[1] : "Unknown Safety Reason",
					};
				}
				// 2. Specific GEmini API Error Checks (using regex on error.message)
				else if (
					errorMessage.includes("permission_denied") ||
					errorMessage.includes("api key not valid")
				) {
					titleKey = "genai.api_error_title";
					descriptionKey = "genai.403_permission_denied_description";
				} else if (errorMessage.includes("invalid_argument")) {
					titleKey = "genai.api_error_title";
					descriptionKey = "genai.400_invalid_argument_description";
				} else if (errorMessage.includes("failed_precondition")) {
					titleKey = "genai.api_error_title";
					descriptionKey = "genai.400_failed_precondition_description";
				} else if (errorMessage.includes("not_found")) {
					titleKey = "genai.api_error_title";
					descriptionKey = "genai.404_not_found_description";
				} else if (
					errorMessage.includes("resource_exhausted") ||
					errorMessage.includes("quota exceeded")
				) {
					titleKey = "genai.api_error_title";
					descriptionKey = "genai.429_resource_exhausted_description";
				} else if (errorMessage.includes("internal")) {
					// 500
					titleKey = "genai.api_error_title";
					descriptionKey = "genai.500_internal_description";
				} else if (errorMessage.includes("unavailable")) {
					// 503
					titleKey = "genai.api_error_title";
					descriptionKey = "genai.503_unavailable_description";
				} else if (errorMessage.includes("deadline_exceeded")) {
					// 504
					titleKey = "genai.api_error_title";
					descriptionKey = "genai.504_deadline_exceeded_description";
				} else {
					// Fallback for other Gemini errors not explicitly listed
					titleKey = "genai.api_error_title";
					descriptionKey = "genai.unknown_api_error_description";
					descriptionVars = { error: error.message }; // Include the raw error message
				}
			}

			// Send the specific or generic error embed
			await sendStandardEmbed(channel, locale, {
				color: ColorCode.ERROR,
				titleKey: titleKey,
				descriptionKey: descriptionKey,
				descriptionVars: descriptionVars,
			});
			// --- End Enhanced Error Handling ---
		}
	} catch (error) {
		// 14. Global error handler for entire function
		log.error("Unhandled error in tomoriChat handler:", error);
		// Use default locale as userRow might not be available
		await sendStandardEmbed(channel, "en-US", {
			color: ColorCode.ERROR,
			titleKey: "general.errors.critical_error_title",
			descriptionKey: "general.errors.critical_error_description",
		});
	}
}
