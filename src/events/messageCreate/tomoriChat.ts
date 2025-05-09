import type { Client, Message, Sticker } from "discord.js";
import {
	BaseGuildTextChannel,
	DMChannel,
	MessageFlags,
	TextChannel,
} from "discord.js"; // Import value for instanceof check
import {
	getGeminiTools,
	streamGeminiToDiscord,
} from "../../providers/google/gemini";
import type { StructuredContextItem } from "../../types/misc/context";
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
import { buildContext } from "../../utils/text/contextBuilder";
import { decryptApiKey } from "@/utils/security/crypto";

import {
	HumanizerDegree,
	type ErrorContext,
	type TomoriState,
} from "@/types/db/schema";
import { selectStickerFunctionDeclaration } from "@/providers/google/functionCalls";

// Constants
const MESSAGE_FETCH_LIMIT = 80;
const DEFAULT_TOP_K = 1;
const DEFAULT_TOP_P = 0.9;
const MAX_OUTPUT_TOKENS = 8192;

// Base trigger words that will always work (with or without spaces for English)
const BASE_TRIGGER_WORDS = process.env.BASE_TRIGGER_WORDS?.split(",").map(
	(word) => word.trim(),
) || ["tomori", "tomo", "トモリ", "ともり"];

// Conversation reset markers
const CONVERSATION_RESET_MARKERS = ["REFRESH", "refresh", "リフレッシュ"];

const MAX_FUNCTION_CALL_ITERATIONS = 5; // Safety break for function call loops

// Regex to identify if a string is solely a Tenor GIF URL
//const TENOR_GIF_REGEX = /^(https?:\/\/)?(www\.)?tenor\.com\/view\/[a-zA-Z0-9-]+-gif-\d+(\?.*)?$/i;

// Define a type for our simplified message structure.
// This will be passed to buildContext, which will then convert it into StructuredContextItem[].
// Rule 13: This type is local to this file's processing logic for now.
// If it becomes shared across multiple files for context building, we can move it to /types/.
type SimplifiedMessageForContext = {
	authorId: string;
	authorName: string; // Resolved name (Tomori's nickname or user's display name)
	content: string | null; // Message text content
	imageAttachments: Array<{
		url: string; // Original URL of the image
		proxyUrl: string; // Discord's proxy URL, often more stable for fetching
		mimeType: string | null; // e.g., 'image/png', 'image/jpeg'
		filename: string; // Original filename
	}>;
	// Future consideration: user-sent stickers
	// stickerAttachments: Array<{ name: string; id: string; formatType: StickerFormatType }>;
};

// New: Constants for the semaphore/locking mechanism
const CHANNEL_LOCK_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes for a lock to be considered stale

// New: In-memory store for channel locks and message queues
interface ChannelLockEntry {
	isLocked: boolean;
	lockedAt: number; // Timestamp when the lock was acquired
	currentMessageId?: string; // Discord ID of the message currently being processed
	messageQueue: Array<{
		message: Message;
		// We might not need explicit promise resolvers if we just process sequentially
		// For now, just storing the message is enough.
	}>;
}
const channelLocks = new Map<string, ChannelLockEntry>(); // Key: channel.id

/**
 * Handles incoming messages to potentially generate a response using genai.
 * @param client - The Discord client instance.
 * @param message - The incoming Discord message.
 */
export default async function tomoriChat(
	client: Client,
	message: Message,
	isFromQueue: boolean, // MODIFIED: Added isFromQueue parameter
): Promise<void> {
	// 1. Initial Checks & State Loading
	const channel = message.channel;
	let locale = "en-US";

	if (!(channel instanceof BaseGuildTextChannel)) {
		// Default locale

		// Early return if not a guild-based text channel (DMs or group chats)
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

	// --- New Semaphore Logic ---
	const channelLockId = channel.id;
	let lockEntry = channelLocks.get(channelLockId);

	if (!lockEntry) {
		// 2. Initialize lock entry if it doesn't exist
		lockEntry = {
			isLocked: false,
			lockedAt: 0,
			currentMessageId: undefined,
			messageQueue: [],
		};
		channelLocks.set(channelLockId, lockEntry);
	}

	if (
		lockEntry.isLocked &&
		Date.now() - lockEntry.lockedAt > CHANNEL_LOCK_TIMEOUT_MS
	) {
		// 3. Check for stale lock (if current message finds it locked)
		log.warn(
			`Channel ${channelLockId} lock is stale (locked since ${new Date(lockEntry.lockedAt).toISOString()} for message ${lockEntry.currentMessageId}). Forcibly releasing. Previous queue length: ${lockEntry.messageQueue.length}`,
		);
		lockEntry.isLocked = false; // Release stale lock
		lockEntry.messageQueue = []; // Clear queue as well, as context might be very old
		// The current message will now attempt to acquire the lock.
	}

	if (lockEntry.isLocked) {
		// 4. If channel is locked by another message, enqueue this message
		lockEntry.messageQueue.push({ message });
		log.info(
			`Channel ${channelLockId} is busy processing message ${lockEntry.currentMessageId}. Enqueued message ${message.id}. Queue size: ${lockEntry.messageQueue.length}`,
		);
		// Send "waiting line" message (only if it's not the bot itself causing a loop)
		if (message.author.id !== client.user?.id) {
			try {
				// For an ephemeral message, we might not need to load full tomoriState
				// just for the locale if guild.preferredLocale is sufficient or a default.
				const tempUserRow = await loadUserRow(userDiscId); // userDiscId is string
				// Attempt to load tomoriState to get server_id for logging if needed,
				// but don't let it block the ephemeral reply.
				let tempTomoriStateForLog: TomoriState | null;
				try {
					tempTomoriStateForLog = await loadTomoriState(guild.id);
				} catch {
					/* ignore, just for logging context */
				}

				const waitingLocale =
					tempUserRow?.language_pref ?? guild.preferredLocale ?? "en-US";

				const currentMessageLink = lockEntry.currentMessageId
					? `https://discord.com/channels/${guild.id}/${channel.id}/${lockEntry.currentMessageId}`
					: "a previous message";

				// 1. Create the embed using our helper
				const busyEmbed = createStandardEmbed(waitingLocale, {
					titleKey: "general.tomori_busy_title", // New locale key for the title
					descriptionKey: "general.tomori_busy_replying",
					descriptionVars: { message_link: currentMessageLink },
					color: ColorCode.INFO, // Or ColorCode.WARN if you prefer
					flags: MessageFlags.Ephemeral,
				});

				// 2. Send the embed as an ephemeral reply
				await message
					.reply({
						embeds: [busyEmbed], // Pass the created embed
						// flags: MessageFlags.SuppressEmbeds, // Generally not needed for embed-only replies, but harmless
					})
					.catch((e) => {
						// Log with more context if ephemeral reply fails
						const errorContext: ErrorContext = {
							// Ensure ErrorContext type is imported or defined
							// MODIFIED: Use internal DB IDs (numbers) if available, otherwise undefined
							userId: tempUserRow?.user_id,
							serverId: tempTomoriStateForLog?.server_id,
							errorType: "EphemeralReplyError",
							metadata: {
								messageId: message.id,
								channelId: channel.id,
								currentMessageIdInQueue: lockEntry.currentMessageId,
								userDiscId: userDiscId, // Keep Discord ID for metadata if internal is not found
								guildDiscId: guild.id, // Keep Discord ID for metadata
							},
						};
						log.error(
							"Failed to send ephemeral 'Tomori busy' reply",
							e,
							errorContext,
						);
					});
			} catch (e) {
				// This catch is for errors during loadUserRow or localizer
				const errorContext: ErrorContext = {
					// MODIFIED: Use internal DB IDs (numbers) if available, otherwise undefined
					userId: undefined, // tempUserRow might not be available if loadUserRow failed
					errorType: "BusyReplyPrepError",
					metadata: {
						messageId: message.id,
						channelId: channel.id,
						userDiscId: userDiscId, // Keep Discord ID for metadata
						guildDiscId: guild.id, // Keep Discord ID for metadata
					},
				};
				log.error(
					"Failed to prepare 'Tomori busy' ephemeral reply due to state loading or localization error",
					e,
					errorContext,
				);
			}
		}
		return; // Stop processing for this message instance, it's in the queue
	}

	// 5. Acquire the lock for the current message
	lockEntry.isLocked = true;
	lockEntry.lockedAt = Date.now();
	lockEntry.currentMessageId = message.id;
	// --- End Semaphore Logic ---

	// 2. Load critical state data early to use throughout function
	try {
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

			// MODIFIED: If processing a message from the queue, ensure it's treated as the latest message for context
			const queuedMessageId = message.id;
			const indexOfQueuedMessage = messagesArray.findIndex(
				(m) => m.id === queuedMessageId,
			);

			if (isFromQueue) {
				if (indexOfQueuedMessage !== -1) {
					// 1. Remove the queued message from its current position in the fetched history
					const [queuedMessageInHistory] = messagesArray.splice(
						indexOfQueuedMessage,
						1,
					);
					// 2. Add it (or the current message object, which should be identical) to the very end
					messagesArray.push(queuedMessageInHistory); // Using the one from history ensures it's the exact same object reference
					log.info(
						`Queued message ${queuedMessageId} was found in fetched history and moved to the end for context building.`,
					);
				} else {
					// 3. If not found (e.g., older than MESSAGE_FETCH_LIMIT or deleted), append the current 'message' object.
					// This ensures its content is present, though its original surrounding history might be incomplete.
					messagesArray.push(message as Message<true>);
					log.warn(
						`Queued message ${queuedMessageId} not found in fetched history. Appending current message object directly. This might occur if it's older than MESSAGE_FETCH_LIMIT or was deleted.`,
					);
				}
			}

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
			// 10. Build the `SimplifiedMessageForContext` array and user list from relevant messages
			const simplifiedMessages: SimplifiedMessageForContext[] = []; // Array for structured messages
			const userListSet = new Set<string>(); // Still useful for fetching user-specific memories/data

			for (const msg of relevantMessagesArray) {
				const authorId = msg.author.id;

				const authorName =
					msg.author.id === client.user?.id
						? tomoriState?.tomori_nickname // tomoriState is guaranteed to be non-null if we reach here and bot is replying
						: msg.author.displayName;
				userListSet.add(authorId);

				const imageAttachments: SimplifiedMessageForContext["imageAttachments"] =
					[];
				const messageContentForLlm: string | null = msg.content; // Start with original content

				// 10.a. Process direct image attachments and stickers
				if (msg.attachments.size > 0) {
					for (const attachment of msg.attachments.values()) {
						if (
							attachment.contentType?.startsWith("image/png") ||
							attachment.contentType?.startsWith("image/jpeg") ||
							attachment.contentType?.startsWith("image/webp") ||
							attachment.contentType?.startsWith("image/heic") ||
							attachment.contentType?.startsWith("image/heif")
						) {
							imageAttachments.push({
								url: attachment.url,
								proxyUrl: attachment.proxyURL,
								mimeType: attachment.contentType,
								filename: attachment.name,
							});
						}
					}
				}

				// Process stickers sent in the message
				if (msg.stickers.size > 0) {
					for (const sticker of msg.stickers.values()) {
						// Get the sticker URL for Lottie, PNG, or other formats
						// Discord CDN URL follows a consistent pattern
						const stickerUrl = `https://cdn.discordapp.com/stickers/${sticker.id}.png`;

						imageAttachments.push({
							url: stickerUrl,
							proxyUrl: stickerUrl, // Use same URL for proxy
							mimeType: "image/png", // Discord serves PNG version for stickers
							filename: `${sticker.name}.png`,
						});

						log.info(`Processed sticker: ${sticker.name} (${sticker.id})`);
					}
				}

				// 10.b. Check for Tenor GIF links if no direct image attachments were found
				// and the message content solely consists of a Tenor link.
				/*
			if (
				imageAttachments.length === 0 &&
				msg.content &&
				TENOR_GIF_REGEX.test(msg.content.trim())
			) {
				const tenorUrl = msg.content.trim();
				imageAttachments.push({
					url: tenorUrl,
					proxyUrl: tenorUrl, // For Tenor links, original URL is the proxy for now
					mimeType: "image/gif", // Assume GIF for Tenor links
					filename: "tenor.gif", // Generic filename for Tenor GIFs
				});
				// If the content was *only* a Tenor link, we can set content to null
				// as the image part will represent it.
				messageContentForLlm = null;
				log.info(
					`Detected Tenor GIF link as image content: ${tenorUrl} for msg ID ${msg.id}`,
				);
			}*/

				// 10.c. Check if this message is from the same author as the previous one
				const prevMessage = simplifiedMessages[simplifiedMessages.length - 1];
				const isSameAuthorAsPrevious =
					prevMessage && prevMessage.authorId === authorId;

				// 10.d. Determine if we should combine with the previous message or create a new entry
				if (
					isSameAuthorAsPrevious &&
					messageContentForLlm &&
					prevMessage.content
				) {
					// Append this message's content to the previous message with a newline
					prevMessage.content += `\n${messageContentForLlm}`;

					// If this message has images, add them to the previous message's images
					if (imageAttachments.length > 0) {
						prevMessage.imageAttachments = [
							...prevMessage.imageAttachments,
							...imageAttachments,
						];
					}
				} else if (messageContentForLlm || imageAttachments.length > 0) {
					// Create a new entry if it's a different author or the previous has no content
					simplifiedMessages.push({
						authorId,
						authorName,
						content: messageContentForLlm,
						imageAttachments,
					});
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
			// The `buildContext` function will be refactored in a subsequent step to accept
			// `simplifiedMessages` and produce `StructuredContextItem[]`.
			// For now, its signature and output type (ContextSegment[]) remain, but we pass the new data.
			let contextSegments: StructuredContextItem[] = [];
			try {
				// NOTE: The `buildContext` call signature will change.
				// It will take `simplifiedMessageHistory: simplifiedMessages` instead of `conversationHistory`.
				// It will also need `tomoriNickname`, `tomoriAttributes`, and `tomoriConfig` to build system instructions.
				contextSegments = await buildContext({
					guildId: serverDiscId,
					serverName,
					serverDescription,
					// conversationHistory: conversationHistory, // This parameter will be removed
					simplifiedMessageHistory: simplifiedMessages, // New parameter for structured history
					userList,
					channelDesc,
					channelName,
					client,
					triggererName,
					emojiStrings,
					// biome-ignore lint/style/noNonNullAssertion: tomoriState is checked
					tomoriNickname: tomoriState!.tomori_nickname,
					// biome-ignore lint/style/noNonNullAssertion: tomoriState is checked
					tomoriAttributes: tomoriState!.attribute_list,
					// biome-ignore lint/style/noNonNullAssertion: tomoriState is checked
					tomoriConfig: tomoriState!.config,
				});
			} catch (error) {
				log.error("Error building context for LLM API Call:", error, {
					serverId: tomoriState?.server_id, // Use internal DB ID if available
					errorType: "ContextBuildingError",
					metadata: {
						guildId: serverDiscId,
						channelName: channel.name,
						userCountInContext: userList.length,
					},
				});
				await sendStandardEmbed(channel, locale, {
					color: ColorCode.ERROR,
					titleKey: "general.errors.context_error_title",
					descriptionKey: "general.errors.context_error_description",
				});
				return;
			}

			// biome-ignore lint/style/noNonNullAssertion: API key presence was validated earlier for triggered messages, tomoriState is checked
			const decryptedApiKey = await decryptApiKey(tomoriState!.config.api_key!);
			if (!decryptedApiKey) {
				log.error("API Key is not set or failed to decrypt.", undefined, {
					serverId: tomoriState?.server_id,
					errorType: "ApiKeyError",
				});
				await sendStandardEmbed(channel, locale, {
					color: ColorCode.ERROR,
					titleKey: "general.errors.api_key_error_title",
					descriptionKey: "general.errors.api_key_error_description",
				});
				return;
			}

			// 12. Generate Response

			// biome-ignore lint/style/noNonNullAssertion: tomoriState is checked
			if (tomoriState!.llm.llm_provider.toLowerCase() !== "google") {
				log.warn(
					`Unsupported LLM provider configured: ${tomoriState?.llm.llm_provider}`,
					{
						serverId: tomoriState?.server_id,
						errorType: "ConfigurationError",
						metadata: { provider: tomoriState?.llm.llm_provider },
					},
				);
				return;
			}

			const geminiConfig: GeminiConfig = {
				// biome-ignore lint/style/noNonNullAssertion: tomoriState is checked
				model: tomoriState!.llm.llm_codename,
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
					// biome-ignore lint/style/noNonNullAssertion: tomoriState and config are checked
					temperature: tomoriState!.config.llm_temperature,
					topK: DEFAULT_TOP_K,
					topP: DEFAULT_TOP_P,
					maxOutputTokens: MAX_OUTPUT_TOKENS,
					stopSequences: [
						// biome-ignore lint/style/noNonNullAssertion: tomoriState is checked
						`\n${tomoriState!.tomori_nickname}:`,
						`\n${triggererName}:`,
					],
				},
				// biome-ignore lint/style/noNonNullAssertion: tomoriState is checked
				tools: getGeminiTools(tomoriState!),
			};

			if (tomoriState.config.humanizer_degree >= HumanizerDegree.LIGHT) {
				log.info(
					"Streaming mode enabled. Attempting to stream response to Discord.",
				);

				// 1. Initialize variables for the function calling loop in streaming mode
				let selectedStickerToSend: Sticker | null = null;
				const functionInteractionHistory: {
					functionCall: FunctionCall;
					functionResponse: Part;
				}[] = [];
				let finalStreamCompleted = false;

				for (let i = 0; i < MAX_FUNCTION_CALL_ITERATIONS; i++) {
					log.info(
						`Streaming LLM Call Iteration: ${i + 1}/${MAX_FUNCTION_CALL_ITERATIONS}. History items: ${functionInteractionHistory.length}`,
					);
					try {
						const streamResult = await streamGeminiToDiscord(
							channel,
							client,
							// biome-ignore lint/style/noNonNullAssertion: Missing Tomoristate handled at start of TomoriChat
							tomoriState!,
							geminiConfig,
							contextSegments, // Original full prompt context
							emojiStrings,
							functionInteractionHistory.length > 0
								? functionInteractionHistory
								: undefined, // Pass history if it exists
							undefined,
							isFromQueue ? message : undefined,
						);

						if (streamResult.status === "completed") {
							log.success("Streaming to Discord completed successfully.");
							finalStreamCompleted = true;
							break; // Exit loop, final text stream was handled by streamGeminiToDiscord
						}

						if (streamResult.status === "error") {
							log.error(
								"Streaming to Discord reported an error.",
								streamResult.data,
								{
									serverId: tomoriState?.server_id,
									errorType: "StreamingError",
								},
							);
							// streamGeminiToDiscord already attempts to send an error message.
							finalStreamCompleted = true; // Consider it "completed" to break loop, error handled.
							break;
						}

						if (streamResult.status === "function_call" && streamResult.data) {
							const funcCall = streamResult.data as FunctionCall; // Type assertion
							log.info(
								`Stream LLM wants to call function: ${funcCall.name} with args: ${JSON.stringify(funcCall.args)}`,
							);

							let functionExecutionResult: Record<string, unknown>;

							// 2. Execute the function locally based on its name
							if (funcCall.name === selectStickerFunctionDeclaration.name) {
								const stickerIdArg = funcCall.args?.sticker_id;
								if (typeof stickerIdArg === "string") {
									const discordSticker =
										// biome-ignore lint/style/noNonNullAssertion: TomoriChat checks for guild
										guild!.stickers.cache.get(stickerIdArg);
									if (discordSticker) {
										log.success(
											`Sticker '${discordSticker.name}' (${stickerIdArg}) found locally for stream.`,
										);
										functionExecutionResult = {
											status: "sticker_selected_successfully",
											sticker_id: discordSticker.id,
											sticker_name: discordSticker.name,
											sticker_description: discordSticker.description,
										};
										selectedStickerToSend = discordSticker;
									} else {
										log.warn(
											`Sticker with ID ${stickerIdArg} not found in server cache for stream. Informing LLM.`,
										);
										functionExecutionResult = {
											status: "sticker_not_found",
											sticker_id_attempted: stickerIdArg,
											reason:
												"The sticker ID provided was not found among the available server stickers. Please choose from the provided list or do not use a sticker.",
										};
										selectedStickerToSend = null;
									}
								} else {
									log.warn(
										"Invalid or missing sticker_id in stream function call args for select_sticker_for_response.",
									);
									functionExecutionResult = {
										status: "sticker_selection_failed_invalid_args",
										reason:
											"The sticker_id argument was missing or not in the expected format. Please provide a valid sticker_id string.",
									};
									selectedStickerToSend = null;
								}
							}
							// TODO: Add handling for self_teach_tomori here when implemented
							// else if (funcCall.name === selfTeachTomoriFunctionDeclaration.name) { ... }
							else {
								log.warn(
									`Stream LLM called unknown function: ${funcCall.name}. Informing LLM.`,
								);
								functionExecutionResult = {
									status: "unknown_function_called",
									function_name_called: funcCall.name,
									message: `The function '${funcCall.name}' is not recognized or implemented. Please proceed without calling this function, or use one of the available functions.`,
								};
							}

							// 3. Add the model's function call and our function's result to the history
							functionInteractionHistory.push({
								functionCall: funcCall,
								functionResponse: {
									functionResponse: {
										name: funcCall.name,
										response: { result: functionExecutionResult },
									},
								},
							});

							// 4. Safety break if max iterations reached
							if (i === MAX_FUNCTION_CALL_ITERATIONS - 1) {
								log.warn(
									"Max function call iterations reached in streaming mode. LLM did not provide a final text stream.",
								);
								// Send a fallback message if no stream occurred.
								// If some text was streamed before this, this might be redundant.
								// For now, assume streamGeminiToDiscord handles its own errors if it starts streaming.
								// If it returns function_call repeatedly, this is the fallback.
								await sendStandardEmbed(channel, locale, {
									color: ColorCode.WARN,
									titleKey: "genai.max_iterations_title", // New locale key
									descriptionKey: "genai.max_iterations_streaming_description", // New locale key
								});
								finalStreamCompleted = true; // Mark as "completed" to exit loop
								selectedStickerToSend = null; // Clear sticker
								break;
							}
							// Continue to the next iteration of the loop to call streamGeminiToDiscord again with updated history
						} else {
							// Should not happen if status is not completed, error, or function_call
							log.error(
								"Unexpected streamResult status in streaming loop:",
								streamResult,
							);
							finalStreamCompleted = true; // Break loop on unexpected status
							break;
						}
					} catch (streamingError) {
						log.error(
							"Critical error during streamGeminiToDiscord call within streaming loop:",
							streamingError,
							{
								serverId: tomoriState?.server_id,
								errorType: "StreamingInvocationError",
								metadata: { channelId: channel.id, iteration: i + 1 },
							},
						);
						await sendStandardEmbed(channel, locale, {
							color: ColorCode.ERROR,
							titleKey: "genai.generic_error_title",
							descriptionKey: "genai.streaming_failed_description",
						});
						finalStreamCompleted = true; // Break loop on critical error
						break;
					}
				} // End of for loop for function call iterations

				// 5. After the loop, if a sticker was selected and a stream completed, send the sticker.
				// This is a simple approach; sticker will appear after the streamed text.
				if (selectedStickerToSend && finalStreamCompleted) {
					try {
						// If the last interaction was a reply (isFromQueue), try to reply with sticker too.
						// Otherwise, just send to channel.
						if (isFromQueue) {
							await message.reply({ stickers: [selectedStickerToSend.id] });
						} else {
							await channel.send({ stickers: [selectedStickerToSend.id] });
						}
						log.info(
							`Sent selected sticker '${selectedStickerToSend.name}' after stream.`,
						);
					} catch (stickerError) {
						log.error(
							"Failed to send selected sticker after stream:",
							stickerError,
							{
								serverId: tomoriState?.server_id,
								errorType: "StickerSendError",
								metadata: { stickerId: selectedStickerToSend.id },
							},
						);
					}
				} else if (!finalStreamCompleted) {
					log.warn(
						"Streaming process did not complete successfully, final response might be missing.",
					);
					// Potentially send a message indicating an issue if no error was already sent.
				}
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
	} finally {
		// --- New Semaphore Logic: Release lock and process queue ---
		if (lockEntry) {
			// Ensure lockEntry is defined
			lockEntry.isLocked = false;
			lockEntry.lockedAt = 0;
			lockEntry.currentMessageId = undefined;
			log.info(
				`Channel ${channelLockId} lock released for message ${message.id}.`,
			);

			// Check if there are messages in the queue for this channel
			if (lockEntry.messageQueue.length > 0) {
				const nextMessageData = lockEntry.messageQueue.shift(); // Get the next message (FIFO)
				if (nextMessageData) {
					log.info(
						`Processing next message ${nextMessageData.message.id} from queue for channel ${channelLockId}. Queue size: ${lockEntry.messageQueue.length}`,
					);
					// Call tomoriChat recursively for the next message.
					// This will re-evaluate the lock status (which should now be false).
					// Use a non-blocking call or setImmediate to avoid deep recursion issues if many messages are queued.
					setImmediate(() => {
						tomoriChat(client, nextMessageData.message, true).catch((e) => {
							log.error(
								`Error processing queued message ${nextMessageData.message.id}:`,
								e,
							);
						});
					});
				}
			} else {
				// If queue is empty, we can consider removing the lock entry to save memory,
				// or keep it for a while if channels are frequently active.
				// For simplicity now, we'll keep it.
				// If we wanted to clean up:
				// if (channelLocks.get(channelLockId)?.messageQueue.length === 0 && !channelLocks.get(channelLockId)?.isLocked) {
				// channelLocks.delete(channelLockId);
				// log.info(`Cleaned up empty lock entry for channel ${channelLockId}`);
				// }
			}
		}
		// --- End Semaphore Logic in finally ---
	}
}

/**
 * Determines if the bot should generate a reply based on message context and bot settings.
 * @param message - The incoming Discord message.
 * @param tomoriState - The current state of the bot for the server (TomoriRow + TomoriConfigRow).
 * @returns True if the bot should reply, false otherwise.
 */
export function shouldBotReply(
	message: Message,
	tomoriState: TomoriState,
): boolean {
	// 1. Basic checks: Ignore bots, commands, non-text channels, and messages with no content
	if (
		message.author.bot ||
		message.content.startsWith("!") || // Basic command prefix check
		!(message.channel instanceof TextChannel) // Use TextChannel as value
	) {
		return false;
	}

	// Config is guaranteed to exist by loadTomoriState structure
	// biome-ignore lint/style/noNonNullAssertion: config is part of TomoriState type
	const config = tomoriState.config!;

	// 2. Check if the message is a reply to the bot
	let isReplyToBot = false;
	if (message.reference?.messageId) {
		const referenceMessage = message.channel.messages.cache.get(
			message.reference.messageId,
		);
		// biome-ignore lint/style/noNonNullAssertion: client.user is available in messageCreate event
		isReplyToBot = referenceMessage?.author.id === message.client.user!.id;
	}

	// 3. Check if the message content triggers the bot based on configured triggers
	// Use 'trigger_words' from the config object
	const triggersActive = config.trigger_words.some((trigger: string) => {
		// Check if trigger is a mention (starts with <@)
		if (trigger.startsWith("<@")) {
			const userId = trigger.replace(/[<@!>]/g, ""); // Extract user ID
			return message.mentions.users.has(userId);
		}
		// Check if trigger contains Japanese characters
		const isJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(
			trigger,
		);
		if (isJapanese) {
			return message.content.includes(trigger);
		}
		// Use word boundaries for English triggers (case-insensitive)
		const regex = new RegExp(`\\b${trigger}\\b`, "i");
		return regex.test(message.content);
	});

	// 4. Check if the auto-message counter threshold is met
	const autoMsgThreshold = config.autoch_threshold;
	const isAutoChannelActive =
		autoMsgThreshold > 0 && config.autoch_disc_ids.length > 0;
	// Use 'autoch_counter' directly from tomoriState (TomoriRow part)
	const currentCount = tomoriState.autoch_counter;

	// Check if auto-channel is active, threshold is positive, counter has started, AND modulo is 0
	// Also ensure the message is in one of the designated auto-channels
	const isAutoMsgHit =
		isAutoChannelActive &&
		config.autoch_disc_ids.includes(message.channel.id) && // Check if current channel is an auto-channel
		currentCount > 0 && // Ensure counter has started (avoid trigger on first message after reset)
		currentCount % autoMsgThreshold === 0;

	// 5. Determine if bot should reply:
	// Reply if (it's a reply to the bot OR triggers are active) OR if the auto-message threshold is hit
	return isReplyToBot || triggersActive || isAutoMsgHit;
}
