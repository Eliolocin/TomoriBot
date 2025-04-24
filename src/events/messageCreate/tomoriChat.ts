import type { Client, Message } from "discord.js";
import { TextChannel } from "discord.js"; // Import value for instanceof check
import { generateGeminiResponse, getGeminiTools } from "../../providers/google";
import type { TomoriState, UserRow } from "../../types/db/schema";
import type { ContextSegment } from "../../types/misc/context";
import { HarmCategory, HarmBlockThreshold } from "@google/genai";
import type { GeminiConfig } from "../../types/api/gemini";
import {
	incrementTomoriCounter,
	loadTomoriState,
	loadUserRow,
} from "../../utils/db/sessionHelper";
import { createStandardEmbed } from "../../utils/discord/eventHelper";
import { ColorCode, log } from "../../utils/misc/logger";
import { shouldBotReply } from "../../utils/misc/messageUtils";
import { buildContext } from "../../utils/text/contextBuilder";
import {
	replaceTemplateVariables,
	cleanLLMOutput,
	chunkMessage,
} from "@/utils/text/stringHelper";
import { decryptApiKey } from "@/utils/security/crypto";

// Constants
const MESSAGE_FETCH_LIMIT = 80;
const DEFAULT_TOP_K = 1;
const DEFAULT_TOP_P = 0.9;
const MAX_OUTPUT_TOKENS = 8192;
const CHUNK_LENGTH = 1900;

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

		const messages = await channel.messages.fetch({
			limit: MESSAGE_FETCH_LIMIT,
		});
		const conversationHistory: string[] = [];
		const userListSet = new Set<string>();

		for (const msg of messages.values()) {
			if (msg.content) {
				const authorId = msg.author.id;
				userListSet.add(authorId);
				let authorName = msg.author.username;

				// Check if this is Tomori's message
				if (msg.author.id === client.user?.id) {
					// We already have tomoriState from earlier in the function
					authorName = tomoriState.tomori_nickname;
				} else {
					// Otherwise look up the user's nickname
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
				conversationHistory.unshift(`${authorName}: ${msg.content}`);
			}
		}
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

			// 8. Sanitize and Send Response
			const sanitizedReply = cleanLLMOutput(
				responseText,
				tomoriState.tomori_nickname,
			);

			if (sanitizedReply.length > 0) {
				// Use our dedicated chunkMessage function for intelligent message splitting
				const messageChunks = chunkMessage(sanitizedReply, CHUNK_LENGTH);
				log.info(`Sending response in ${messageChunks.length} chunks`);

				// Send each chunk as a separate message
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
