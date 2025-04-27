import type { Client, Message } from "discord.js";
import { TextChannel } from "discord.js"; // Import value for instanceof check
import { generateGeminiResponse, getGeminiTools } from "../../providers/google";
import type { TomoriState, UserRow } from "../../types/db/schema";
import type { ContextSegment } from "../../types/misc/context";
import { HarmCategory, HarmBlockThreshold } from "@google/genai";
import type { GeminiConfig } from "../../types/api/gemini";
import { loadTomoriState, loadUserRow } from "../../utils/db/dbRead";
import { incrementTomoriCounter } from "@/utils/db/dbWrite";
import { createStandardEmbed } from "../../utils/discord/embedHelper";
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

// Constants
const MESSAGE_FETCH_LIMIT = 80;
const DEFAULT_TOP_K = 1;
const DEFAULT_TOP_P = 0.9;
const MAX_OUTPUT_TOKENS = 8192;
const CHUNK_LENGTH = 1900;
const HUMANIZE_INSTRUCTION =
	"\nTry to limit yourself to only 0 to 2 emojis per response (from the available server emojis or kaomojis, if your personality uses those) and make sure to respond short and concisely, as a human would in public chatrooms. Only make lengthy responses if and only if a user is asking for assistance or an explanation that warrants it.";

// 5a. Define conversation reset markers
const CONVERSATION_RESET_MARKERS = ["REFRESH"];

/**
 * Handles incoming messages to potentially generate a response using Gemini.
 * @param client - The Discord client instance.
 * @param message - The incoming Discord message.
 */
export default async function tomoriChat(
	client: Client,
	message: Message,
): Promise<void> {
	// 1. Initial Checks & State Loading
	// biome-ignore lint/style/noNonNullAssertion: Guild is always present in guild message events
	const guild = message.guild!;
	const serverDiscId = guild.id; // Keep Discord Guild ID
	// biome-ignore lint/style/noNonNullAssertion: Author is always present in non-system messages
	const userDiscId = message.author!.id;
	const channel = message.channel;
	let triggererName = message.author.displayName;

	if (!(channel instanceof TextChannel)) {
		return;
	}
	// biome-ignore lint/style/noNonNullAssertion: client.user is checked during startup
	if (!channel.permissionsFor(client.user!)?.has("SendMessages")) {
		return;
	}

	let tomoriState: TomoriState | null = null;
	let userRow: UserRow | null = null;

	try {
		tomoriState = await loadTomoriState(serverDiscId);
		userRow = await loadUserRow(userDiscId);

		if (!tomoriState) {
			log.warn(
				`Tomori state not found for server ${serverDiscId}. Skipping Gemini response.`,
			);
			return;
		}

		const locale = userRow?.language_pref ?? "en";
		triggererName = userRow?.user_nickname ?? "message.author.displayName";

		// 2. Auto-Counter Update
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
			}
		}

		// 3. Determine if Bot Should Reply
		if (!shouldBotReply(message, tomoriState)) {
			return;
		}

		log.info(`Conditions met for Gemini reply in server ${serverDiscId}`);

		// 4. Check Setup Requirements
		if (
			tomoriState.sample_dialogues_in.length < 1 ||
			tomoriState.sample_dialogues_out.length < 1
		) {
			log.warn(
				`Tomori setup incomplete for server ${serverDiscId}. Missing sample dialogues.`,
			);
			const setupEmbed = createStandardEmbed(locale, {
				color: ColorCode.ERROR,
				titleKey: "events.tomoriChat.setup_required_title",
				descriptionKey: "events.tomoriChat.setup_required_description",
			});
			await channel.send({ embeds: [setupEmbed] });
			return;
		}

		// 5. Prepare Data for buildContext
		await channel.sendTyping();

		// Fetch messages (newest to oldest is default)
		const fetchedMessages = await channel.messages.fetch({
			limit: MESSAGE_FETCH_LIMIT,
		});

		// Convert to array and reverse to get chronological order (oldest first)
		const messagesArray = Array.from(fetchedMessages.values()).reverse();

		// 5b. Find the index of the *last* reset message (most recent)
		let resetIndex = -1;
		// Iterate backwards through the chronologically ordered array
		for (let i = messagesArray.length - 1; i >= 0; i--) {
			const msg = messagesArray[i];
			// Check only non-empty messages from users (not the bot itself)
			if (msg.content && msg.author.id !== client.user?.id) {
				const isResetMessage = CONVERSATION_RESET_MARKERS.some(
					(marker) => msg.content.toLowerCase() === marker.toLowerCase(),
				);
				if (isResetMessage) {
					// 1. Record the index of the latest reset message found
					resetIndex = i;
					log.info(
						`Reset marker detected at index ${i} (message: "${msg.content}") from ${msg.author.username}. History will start after this message.`,
					);
					// 2. Stop searching once the latest reset is found
					break;
				}
			}
		}

		// 5c. Determine the messages to include in the history
		// If a reset was found (resetIndex > -1), start from the message *after* it.
		// Otherwise (resetIndex === -1), start from the beginning (index 0).
		const startIndex = resetIndex === -1 ? 0 : resetIndex + 1;
		// 3. Slice the array to get only messages from the startIndex onwards
		const relevantMessagesArray = messagesArray.slice(startIndex);

		// 5d. Build the final conversationHistory string array and user list from relevant messages
		const conversationHistory: string[] = [];
		const userListSet = new Set<string>();
		let lastMessageAuthorId: string | null = null;

		// 4. Iterate through the relevant messages (now guaranteed to be after the last reset, or all messages if no reset)
		for (const msg of relevantMessagesArray) {
			// Only process messages with content
			if (msg.content) {
				const authorId = msg.author.id;
				// 5. Collect all unique user IDs found in the relevant history
				userListSet.add(authorId);
				let authorName = msg.author.username;

				// Resolve author name (Tomori or User Nickname)
				if (msg.author.id === client.user?.id) {
					// biome-ignore lint/style/noNonNullAssertion: tomoriState is checked earlier
					authorName = tomoriState!.tomori_nickname;
				} else {
					try {
						const authorRow = await loadUserRow(authorId);
						if (authorRow?.user_nickname) {
							authorName = authorRow.user_nickname;
						}
					} catch (dbError) {
						log.warn(
							`Could not load user ${authorId} for nickname lookup`,
							dbError,
						);
					}
				}

				// 6. Merge consecutive bot messages or add new entry
				// Check if this message is from the same author as the last one AND that author is the bot
				if (
					authorId === lastMessageAuthorId &&
					authorId === client.user?.id && // Ensure it's the bot
					conversationHistory.length > 0
				) {
					// Append content with a newline to the last entry (using push means last entry is at the end)
					conversationHistory[conversationHistory.length - 1] +=
						`\n${msg.content}`;
				} else {
					// Add a new entry with the "Author: Content" format using push (since iterating oldest-to-newest)
					conversationHistory.push(`${authorName}: ${msg.content}`);
					// Update tracking for the next iteration
					lastMessageAuthorId = authorId;
				}
			}
		}

		// Convert the set of users found in the relevant history to an array
		const userList = Array.from(userListSet);

		const channelName = channel.name;
		const channelDesc = channel.topic;
		const serverName = guild.name;
		const serverDescription = guild.description;

		// 6. Build Context
		let contextSegments: ContextSegment[] = [];
		try {
			// Re-applying fix: Ensure serverName and serverDescription are passed
			contextSegments = await buildContext({
				guildId: serverDiscId,
				serverName, // Pass serverName
				serverDescription, // Pass serverDescription
				conversationHistory,
				userList,
				channelDesc,
				channelName,
				client,
				triggererName,
			});
		} catch (error) {
			log.error("Error building context for LLM API Call:", error);
			const contextErrorEmbed = createStandardEmbed(locale, {
				color: ColorCode.ERROR,
				titleKey: "events.tomoriChat.context_error_title",
				descriptionKey: "events.tomoriChat.context_error_description",
			});
			await channel.send({ embeds: [contextErrorEmbed] });
			return;
		}

		// 7. Generate Response
		try {
			// Only support Google for now
			if (tomoriState.llm.llm_provider.toLowerCase() !== "google") return;
			// biome-ignore lint/style/noNonNullAssertion: TomoriState contains verified non-null api key
			const decryptedApiKey = await decryptApiKey(tomoriState.config.api_key!);
			if (!decryptedApiKey) {
				log.error("API Key is not set.");
				const apiKeyErrorEmbed = createStandardEmbed(locale, {
					color: ColorCode.ERROR,
					titleKey: "events.tomoriChat.api_key_error_title",
					descriptionKey: "events.tomoriChat.api_key_error_description",
				});
				await channel.send({ embeds: [apiKeyErrorEmbed] });
				return;
			}

			const geminiConfig: GeminiConfig = {
				model: tomoriState.llm.llm_codename,
				apiKey: decryptedApiKey,
				safetySettings: [
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
				// Enable web search/grounding capabilities
				enableSearch: true,
				tools: getGeminiTools(tomoriState.llm.llm_codename),
			};

			const promptString = contextSegments
				.sort((a, b) => a.order - b.order)
				.map((segment) => segment.content)
				.join("\n");
			let systemInstruction = tomoriState.attribute_list.join("\n");
			if (config.humanizer_degree >= 1)
				systemInstruction += HUMANIZE_INSTRUCTION;

			// Replace placeholder tokens in system instruction
			const tomoriNickname = tomoriState.tomori_nickname;

			// Use the function to replace placeholders
			systemInstruction = replaceTemplateVariables(systemInstruction, {
				bot: tomoriNickname,
				user: triggererName,
			});

			const responseText = await generateGeminiResponse(
				geminiConfig,
				promptString,
				systemInstruction,
			);

			log.success(`Gemini generated response for server ${serverDiscId}.`);

			log.section("Raw response");
			console.log(responseText);

			// 8. Sanitize and Send Response
			let sanitizedReply = cleanLLMOutput(
				responseText,
				tomoriState.tomori_nickname,
			);

			if (sanitizedReply.length > 0) {
				// Smartly lowercases words and removes punctuations at level 3+
				if (config.humanizer_degree >= 3)
					sanitizedReply = humanizeString(sanitizedReply);

				log.section("Cleaned response");
				console.log(sanitizedReply);

				// Use our dedicated chunkMessage function for intelligent message splitting
				const messageChunks = chunkMessage(
					sanitizedReply,
					config.humanizer_degree,
					CHUNK_LENGTH,
				);
				log.info(`Sending response in ${messageChunks.length} chunks`);

				// Send each chunk as a separate message at level 2+
				if (config.humanizer_degree >= 2)
					// Simulate human typing
					sendWithTypingSimulation(channel, messageChunks);
				else
					for (const chunk of messageChunks) {
						await channel.send(chunk);
					}
			} else {
				log.warn("Sanitized reply resulted in empty string. Not sending.");
			}
		} catch (error) {
			log.error("Error during Gemini generation or sending:", error);
			const genericErrorEmbed = createStandardEmbed(locale, {
				color: ColorCode.ERROR,
				titleKey: "events.tomoriChat.generation_error_title",
				descriptionKey: "events.tomoriChat.generation_error_description",
			});
			try {
				await channel.send({ embeds: [genericErrorEmbed] });
			} catch (sendError) {
				log.error("Failed to send generation error message:", sendError);
			}
		}
	} catch (error) {
		log.error("Unhandled error in tomoriChat handler:", error);
		const locale = userRow?.language_pref ?? "en";
		const criticalErrorEmbed = createStandardEmbed(locale, {
			color: ColorCode.ERROR,
			titleKey: "events.tomoriChat.critical_error_title",
			descriptionKey: "events.tomoriChat.critical_error_description",
		});
		try {
			await channel.send({ embeds: [criticalErrorEmbed] });
		} catch (sendError) {
			log.error("Failed to send critical error message to channel:", sendError);
		}
	}
}
