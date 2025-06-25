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
import {
	ContextItemTag,
	type StructuredContextItem,
} from "../../types/misc/context";
import {
	HarmCategory,
	HarmBlockThreshold,
	type FunctionCall,
	type Part,
} from "@google/genai";
import type { GeminiConfig } from "../../types/api/gemini";
import {
	isBlacklisted,
	loadServerEmojis,
	loadTomoriState,
	loadUserRow,
} from "../../utils/db/dbRead";
import {
	addPersonalMemoryByTomori,
	addServerMemoryByTomori,
	incrementTomoriCounter,
} from "@/utils/db/dbWrite";
import {
	createStandardEmbed,
	sendStandardEmbed,
} from "../../utils/discord/embedHelper";
import { ColorCode, log } from "../../utils/misc/logger";
import { buildContext } from "../../utils/text/contextBuilder";
import { decryptApiKey } from "@/utils/security/crypto";

import type { TomoriState } from "@/types/db/schema";
import {
	queryGoogleSearchFunctionDeclaration,
	rememberThisFactFunctionDeclaration,
	selectStickerFunctionDeclaration,
} from "@/providers/google/functionCalls";
import { executeSearchSubAgent } from "@/providers/google/subAgents";

// Constants
const MESSAGE_FETCH_LIMIT = 80;
const DEFAULT_TOP_K = 1;
const DEFAULT_TOP_P = 0.95;
const MAX_OUTPUT_TOKENS = 8192;

// Base trigger words that will always work (with or without spaces for English)
const BASE_TRIGGER_WORDS = process.env.BASE_TRIGGER_WORDS?.split(",").map(
	(word) => word.trim(),
) || ["tomori", "tomo", "トモリ", "ともり"];

// Conversation reset markers
const CONVERSATION_RESET_MARKERS = [
	"REFRESH",
	"refresh",
	"リフレッシュ",
	"会話履歴がクリア",
];

const MAX_FUNCTION_CALL_ITERATIONS = 5; // Safety break for function call loops
const STREAM_SDK_CALL_TIMEOUT_MS = 35000; // Slightly longer than internal stream inactivity, 35 seconds

// YouTube URL detection patterns for video analysis
const YOUTUBE_URL_PATTERNS = [
	/(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/i,
	/(?:https?:\/\/)?(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]{11})/i,
	/(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/i,
	/(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/i, // YouTube Shorts support
];

// Supported video MIME types for direct video uploads (following Gemini API documentation)
const SUPPORTED_VIDEO_MIME_TYPES = [
	"video/mp4",
	"video/mpeg",
	"video/mov",
	"video/avi",
	"video/x-flv",
	"video/mpg",
	"video/webm",
	"video/wmv",
	"video/3gpp",
];

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
	videoAttachments: Array<{
		url: string; // Original URL of the video
		proxyUrl: string; // Discord's proxy URL, often more stable for fetching
		mimeType: string | null; // e.g., 'video/mp4', 'video/webm', or 'video/youtube' for YouTube links
		filename: string; // Original filename or generated name for YouTube videos
		isYouTubeLink: boolean; // True if this is a YouTube URL, false for direct video uploads
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

	// --- New Semaphore Logic ---
	const channelLockId = channel.id;
	let lockEntry = channelLocks.get(channelLockId);

	// --- Pre-Semaphore Tomori State Loading for shouldBotReply check ---
	// Attempt to load Tomori state early to determine if a reply would even be considered.
	// This helps decide if a "busy" message is warranted.
	let earlyTomoriState: TomoriState | null = null;
	try {
		earlyTomoriState = await loadTomoriState(serverDiscId);
	} catch (e) {
		// Log the error but don't stop; the main logic will try to load it again
		// and handle errors more comprehensively.
		await log.error(
			// Rule 22
			`Failed to load TomoriState early for server ${serverDiscId} in tomoriChat's lock check phase.`,
			e,
			{
				// serverId will be the Discord ID here as internal might not be known
				errorType: "EarlyStateLoadingError",
				metadata: { serverDiscId: serverDiscId, channelId: channel.id },
			},
		);
	}

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

	// MODIFIED: Check if locked AND if Tomori would reply
	if (lockEntry.isLocked) {
		// Only enqueue and send "busy" message if Tomori is set up and would have replied.
		if (earlyTomoriState) {
			// 1. Create a modified version of earlyTomoriState for the shouldBotReply check.
			// This simulates the autoch_counter as 1 for the decision to queue,
			// preventing queueing based solely on an auto-reply hit while Tomori is busy.
			const modifiedEarlyTomoriStateForCheck: TomoriState = {
				...earlyTomoriState,
				autoch_counter: 1, // Simulate counter as 1 for this check
			};

			// 2. Decide whether to enqueue based on the modified state.
			if (shouldBotReply(message, modifiedEarlyTomoriStateForCheck)) {
				lockEntry.messageQueue.push({ message });
				log.info(
					`Channel ${channelLockId} is busy (msg ${lockEntry.currentMessageId}). Enqueued message ${message.id}. Queue: ${lockEntry.messageQueue.length}. Tomori would reply (autoch_counter simulated as 0 for this check).`,
				);

				// 3. Send "busy" reply to the user if not the bot itself.
				// biome-ignore lint/style/noNonNullAssertion: client.user is checked during startup
				if (message.author.id !== client.user!.id) {
					try {
						const tempUserRow = await loadUserRow(userDiscId);
						const waitingLocale =
							tempUserRow?.language_pref ?? guild.preferredLocale ?? "en-US";
						const currentMessageLink = lockEntry.currentMessageId
							? `https://discord.com/channels/${guild.id}/${channel.id}/${lockEntry.currentMessageId}`
							: "a previous message";

						const busyEmbed = createStandardEmbed(waitingLocale, {
							titleKey: "general.tomori_busy_title",
							descriptionKey: "general.tomori_busy_replying",
							descriptionVars: { message_link: currentMessageLink },
							color: ColorCode.INFO,
							flags: MessageFlags.Ephemeral,
						});
						await message.reply({ embeds: [busyEmbed] }).catch((e) => {
							log.error(
								// Rule 22
								"Failed to send ephemeral 'Tomori busy' reply",
								e,
								{
									userId: tempUserRow?.user_id,
									serverId: earlyTomoriState?.server_id, // Use original earlyTomoriState for accurate ID
									errorType: "EphemeralReplyError",
									metadata: {
										messageId: message.id,
										channelId: channel.id,
										currentMessageIdInQueue: lockEntry.currentMessageId,
										userDiscId,
										guildDiscId: guild.id,
									},
								},
							);
						});
					} catch (e) {
						log.error(
							// Rule 22
							"Failed to prepare 'Tomori busy' ephemeral reply (state/locale error)",
							e,
							{
								errorType: "BusyReplyPrepError",
								metadata: {
									messageId: message.id,
									channelId: channel.id,
									userDiscId,
									guildDiscId: guild.id,
								},
							},
						);
					}
				}
			} else {
				// If locked, but Tomori wouldn't reply anyway (e.g., not setup, or message doesn't trigger,
				// even with simulated counter reset), then don't enqueue or send busy message.
				log.info(
					`Channel ${channelLockId} is busy (msg ${lockEntry.currentMessageId}), but message ${message.id} would not have triggered a reply from Tomori (autoch_counter simulated as 0 for this check). Ignoring for queue.`,
				);
			}
		} else {
			// earlyTomoriState is null, meaning Tomori is not set up on this server.
			// In this case, Tomori wouldn't reply anyway, so don't enqueue.
			log.info(
				`Channel ${channelLockId} is busy (msg ${lockEntry.currentMessageId}), but Tomori is not set up on this server (earlyTomoriState is null). Message ${message.id} ignored for queue.`,
			);
		}
		return; // Message enqueued, or ignored because Tomori wouldn't reply anyway.
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
			const tomoriState =
				earlyTomoriState ?? (await loadTomoriState(serverDiscId));
			const userRow = await loadUserRow(userDiscId);
			locale = userRow?.language_pref ?? "en-US"; // Set locale based on user pref
			const triggererName = userRow?.user_nickname ?? message.author.username;

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
						? tomoriState?.tomori_nickname // Use Tomori's nickname for bot messages
						: `<@${authorId}>`; // Format user as <@ID>, to be converted by convertMentions later to user's registered name (if existing)
				userListSet.add(authorId);
				const imageAttachments: SimplifiedMessageForContext["imageAttachments"] =
					[];
				const videoAttachments: SimplifiedMessageForContext["videoAttachments"] =
					[];
				const messageContentForLlm: string | null = msg.content; // Start with original content				// 10.a. Process direct image attachments and stickers
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
						// 1. Check for video attachments using supported MIME types
						else if (
							attachment.contentType &&
							SUPPORTED_VIDEO_MIME_TYPES.some((type) =>
								attachment.contentType?.startsWith(type),
							)
						) {
							videoAttachments.push({
								url: attachment.url,
								proxyUrl: attachment.proxyURL,
								mimeType: attachment.contentType,
								filename: attachment.name,
								isYouTubeLink: false,
							});
							log.info(
								`Processed video attachment: ${attachment.name} (${attachment.contentType})`,
							);
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

				// 2. Process YouTube links in message content
				if (msg.content) {
					for (const pattern of YOUTUBE_URL_PATTERNS) {
						const match = msg.content.match(pattern);
						if (match) {
							const youtubeUrl = match[0];
							const videoId = match[1];
							videoAttachments.push({
								url: youtubeUrl,
								proxyUrl: youtubeUrl, // YouTube links don't need proxy
								mimeType: "video/youtube", // Custom MIME type for YouTube
								filename: `youtube_video_${videoId}.mp4`,
								isYouTubeLink: true,
							});
							log.info(`Detected YouTube link: ${youtubeUrl} (ID: ${videoId})`);
							break; // Only process the first YouTube link found to avoid duplicates
						}
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
					prevMessage.content += `\n${messageContentForLlm}`; // If this message has images, add them to the previous message's images
					if (imageAttachments.length > 0) {
						prevMessage.imageAttachments = [
							...prevMessage.imageAttachments,
							...imageAttachments,
						];
					}
					// If this message has videos, add them to the previous message's videos
					if (videoAttachments.length > 0) {
						prevMessage.videoAttachments = [
							...prevMessage.videoAttachments,
							...videoAttachments,
						];
					}
				} else if (
					messageContentForLlm ||
					imageAttachments.length > 0 ||
					videoAttachments.length > 0
				) {
					// Create a new entry if it's a different author or the previous has no content
					simplifiedMessages.push({
						authorId,
						authorName,
						content: messageContentForLlm,
						imageAttachments,
						videoAttachments,
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
						//`\n${tomoriState!.tomori_nickname}:`,
						//`\n${triggererName}:`,
					],
				},
				// biome-ignore lint/style/noNonNullAssertion: tomoriState is checked
				tools: getGeminiTools(tomoriState!),
			};

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
			const accumulatedStreamedModelParts: Part[] = [];

			for (let i = 0; i < MAX_FUNCTION_CALL_ITERATIONS; i++) {
				log.info(
					`Streaming LLM Call Iteration: ${i + 1}/${MAX_FUNCTION_CALL_ITERATIONS}. History items: ${functionInteractionHistory.length}`,
				);

				try {
					const streamGeminiPromise = await streamGeminiToDiscord(
						channel,
						client,
						// biome-ignore lint/style/noNonNullAssertion: Missing Tomoristate handled at start of TomoriChat
						tomoriState!,
						geminiConfig,
						contextSegments, // Original full prompt context
						accumulatedStreamedModelParts, // MODIFIED: Pass the accumulator (Rule 26)
						emojiStrings,
						functionInteractionHistory.length > 0
							? functionInteractionHistory
							: undefined, // Pass history if it exists
						undefined,
						isFromQueue ? message : undefined,
					);
					const timeoutPromise = new Promise<never>(
						(
							_,
							reject, // Promise<never> indicates it only rejects
						) =>
							setTimeout(
								() =>
									reject(
										new Error(
											"SDK_CALL_TIMEOUT: streamGeminiToDiscord call timed out.",
										),
									),
								STREAM_SDK_CALL_TIMEOUT_MS,
							),
					);

					let streamResult: Awaited<ReturnType<typeof streamGeminiToDiscord>>;
					try {
						// Promise.race will settle as soon as one of the promises settles
						streamResult = await Promise.race([
							streamGeminiPromise,
							timeoutPromise,
						]);
					} catch (raceError) {
						// This catch block will execute if timeoutPromise rejects first,
						// or if streamGeminiPromise itself rejects *before* the timeout.
						if (
							raceError instanceof Error &&
							raceError.message.startsWith("SDK_CALL_TIMEOUT:")
						) {
							log.error(
								`SDK call to streamGeminiToDiscord timed out for channel ${channel.id}.`,
								raceError, // Log the timeout error
								{
									serverId: tomoriState?.server_id,
									errorType: "SDKTimeoutError",
								},
							);
							await sendStandardEmbed(channel, locale, {
								color: ColorCode.ERROR, // Using ERROR as it's a more critical failure
								titleKey: "genai.error_stream_timeout_title", // New locale key
								descriptionKey: "genai.error_stream_timeout_description", // New locale key
							});
							finalStreamCompleted = true; // Consider it "completed" to break the loop
							break;
						}
						// If it's not our specific timeout error, re-throw to be caught by the outer catch
						throw raceError;
					}

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

					// This is the internal stream inactivity timeout from streamGeminiToDiscord
					if (streamResult.status === "timeout") {
						log.warn(
							`Streaming to Discord timed out due to inactivity for channel ${channel.id}.`,
							streamResult.data,
						);
						await sendStandardEmbed(channel, locale, {
							color: ColorCode.WARN,
							titleKey: "genai.error_stream_timeout_title",
							descriptionKey: "genai.error_stream_timeout_description",
						});
						finalStreamCompleted = true;
						break;
					}

					if (streamResult.status === "function_call" && streamResult.data) {
						const funcCall = streamResult.data as FunctionCall; // Type assertion
						const funcName = funcCall.name?.trim() ?? "";
						log.info(
							`Stream LLM wants to call function: ${funcName} with args: ${JSON.stringify(funcCall.args)}`,
						);

						// Initialize functionExecutionResult to an empty object or a default error state.
						let functionExecutionResult: Record<string, unknown> = {
							status: "processing_error",
							reason: "Function execution result was not properly set.",
						};

						// 2. Execute the function locally based on its name
						if (funcName === selectStickerFunctionDeclaration.name) {
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
						} else if (funcName === queryGoogleSearchFunctionDeclaration.name) {
							const searchQueryArg = funcCall.args?.search_query;
							if (typeof searchQueryArg === "string" && searchQueryArg.trim()) {
								// 1. Send disclaimer embed BEFORE executing the search (Rule 12, 19)
								// This informs the user while the search is happening.
								await sendStandardEmbed(channel, locale, {
									color: ColorCode.INFO, // Or WARN if preferred for a disclaimer
									titleKey: "genai.search.disclaimer_title", // New locale key
									descriptionKey: "genai.search.disclaimer_description", // New locale key
									// Not ephemeral, as it's a general notice.
								});
								// Send typing indicator as search might take a moment
								await channel.sendTyping();

								// 1. Construct conversationHistory string from contextSegments
								const dialogueHistoryStrings: string[] = [];
								for (const item of contextSegments) {
									if (
										item.metadataTag === ContextItemTag.DIALOGUE_HISTORY ||
										item.metadataTag === ContextItemTag.DIALOGUE_SAMPLE
									) {
										let turnText = "";
										for (const part of item.parts) {
											if (part.type === "text") {
												turnText += part.text; // Text parts should already be formatted with speaker names by buildContext
											}
										}
										if (turnText.trim()) {
											dialogueHistoryStrings.push(turnText.trim());
										}
									}
								}
								const conversationHistoryString =
									dialogueHistoryStrings.join("\n");
								// Log the length or a snippet for debugging if needed
								log.info(
									`Constructed conversation history string for sub-agent. Length: ${conversationHistoryString.length}`,
								);

								log.info(
									`Executing Google Search sub-agent for query: "${searchQueryArg}"`,
								);

								const searchResult = await executeSearchSubAgent(
									searchQueryArg,
									conversationHistoryString,
									// biome-ignore lint/style/noNonNullAssertion: API key presence was validated earlier for triggered messages, tomoriState is checked
									tomoriState!,
									// biome-ignore lint/style/noNonNullAssertion: API key presence was validated earlier for triggered messages, tomoriState is checked
									decryptedApiKey!,
								);

								if (searchResult.summary) {
									log.success("Google Search sub-agent returned a summary.");
									functionExecutionResult = {
										status: "search_completed_successfully",
										summary: searchResult.summary,
										original_query: searchQueryArg,
									};
								} else {
									log.warn(
										`Google Search sub-agent failed or returned no summary. Error: ${searchResult.error}`,
									);
									functionExecutionResult = {
										status: "search_failed",
										error_message:
											searchResult.error ||
											"The search sub-agent did not return a summary.",
										original_query: searchQueryArg,
									};
									// Optionally, inform the user if the search itself failed critically
									// before the LLM gets a chance to respond.
									// However, usually, we let the LLM explain based on the error_message.
								}
							} else {
								log.warn(
									"Invalid or missing search_query in stream function call args for query_google_search.",
								);
								functionExecutionResult = {
									status: "search_failed_invalid_args",
									reason:
										"The search_query argument was missing, empty, or not in the expected string format. Please provide a valid search query.",
								};
							}
						}
						// TODO: Add handling for self_teach_tomori here when implemented
						// else if (funcName === selfTeachTomoriFunctionDeclaration.name) { ... }
						else if (funcName === rememberThisFactFunctionDeclaration.name) {
							// 1. Extract arguments from the function call
							const memoryContentArg = funcCall.args?.memory_content;
							const memoryScopeArg = funcCall.args?.memory_scope;
							// MODIFIED: Extract new arguments for targeted user memory
							const targetUserDiscordIdArg =
								funcCall.args?.target_user_discord_id;
							const targetUserNicknameArg = funcCall.args?.target_user_nickname;

							if (
								!tomoriState ||
								!userRow ||
								!userRow.user_id ||
								!tomoriState.server_id
							) {
								// 2. Validate arguments
								// This is a critical internal state error if these are null here.
								log.error(
									"Critical state missing (tomoriState, userRow, or their IDs) before handling remember_this_fact.",
									undefined,
									{
										serverId: tomoriState?.server_id,
										userId: userRow?.user_id,
										errorType: "SelfTeachStateError",
										metadata: {
											hasTomoriState: !!tomoriState,
											hasUserRow: !!userRow,
											hasUserId: !!userRow?.user_id,
											hasServerId: !!tomoriState?.server_id,
										},
									},
								);
								functionExecutionResult = {
									status: "memory_save_failed_internal_error",
									reason:
										"Internal bot error: Critical state information is missing.",
								};
							} else if (
								typeof memoryContentArg !== "string" ||
								!memoryContentArg.trim()
							) {
								functionExecutionResult = {
									status: "memory_save_failed_invalid_args",
									reason:
										"The 'memory_content' argument was missing, empty, or not a string.",
								};
							} else if (
								typeof memoryScopeArg !== "string" ||
								!["server_wide", "target_user"].includes(memoryScopeArg)
							) {
								functionExecutionResult = {
									status: "memory_save_failed_invalid_args",
									reason:
										"The 'memory_scope' argument was missing or invalid. Must be 'server_wide' or 'target_user'.",
								};
							} else {
								// Arguments seem valid enough to proceed
								const memoryContent = memoryContentArg.trim();

								if (memoryScopeArg === "server_wide") {
									// 3.a. Handle server-wide memory
									const dbResult = await addServerMemoryByTomori(
										tomoriState.server_id, // tomoriState.server_id is non-null due to check above
										userRow.user_id, // userRow.user_id is non-null due to check above
										memoryContent,
									);
									if (dbResult) {
										functionExecutionResult = {
											status: "memory_saved_successfully",
											scope: "server_wide",
											content_saved: memoryContent,
											memory_id: dbResult.server_memory_id,
										};
										log.success(
											`Tomori self-taught a server-wide memory (ID: ${dbResult.server_memory_id}): "${memoryContent}"`,
										);
										// Send notification embed to the channel
										await sendStandardEmbed(channel, locale, {
											color: ColorCode.SUCCESS, // Or ColorCode.INFO
											titleKey: "genai.self_teach.server_memory_learned_title",
											descriptionKey:
												"genai.self_teach.server_memory_learned_description",
											descriptionVars: {
												memory_content:
													memoryContent.length > 200
														? `${memoryContent.substring(0, 197)}...`
														: memoryContent,
											},
											footerKey: "genai.self_teach.server_memory_footer", // Add footer
											// Not ephemeral, so everyone sees it
										});
									} else {
										functionExecutionResult = {
											status: "memory_save_failed_db_error",
											scope: "server_wide",
											reason:
												"Database operation failed to save server-wide memory.",
										};
										log.error(
											"Failed to save server-wide memory via self-teach (DB error).",
											undefined,
											{
												serverId: tomoriState.server_id,
												userId: userRow.user_id,
												errorType: "SelfTeachDBError",
												metadata: {
													scope: "server_wide",
													content: memoryContent,
												},
											},
										);
									}
								} else if (memoryScopeArg === "target_user") {
									// 3.b. MODIFIED: Handle user-specific memory with Discord ID and Nickname
									if (
										typeof targetUserDiscordIdArg !== "string" ||
										!targetUserDiscordIdArg.trim()
									) {
										functionExecutionResult = {
											status: "memory_save_failed_invalid_args",
											scope: "target_user",
											reason:
												"The 'target_user_discord_id' argument was missing or empty, which is required when 'memory_scope' is 'target_user'.",
										};
									} else if (
										typeof targetUserNicknameArg !== "string" ||
										!targetUserNicknameArg.trim()
									) {
										functionExecutionResult = {
											status: "memory_save_failed_invalid_args",
											scope: "target_user",
											reason:
												"The 'target_user_nickname' argument was missing or empty, which is required when 'memory_scope' is 'target_user'.",
										};
									} else {
										// Attempt to load the target user by their Discord ID
										const targetUserRow = await loadUserRow(
											targetUserDiscordIdArg,
										);

										if (!targetUserRow || !targetUserRow.user_id) {
											functionExecutionResult = {
												status: "memory_save_failed_user_not_found",
												scope: "target_user",
												target_user_discord_id: targetUserDiscordIdArg,
												reason: `The user with Discord ID '${targetUserDiscordIdArg}' was not found in Tomori's records. Tomori can only save memories for users she knows.`,
											};
											log.warn(
												`Self-teach: Target user with Discord ID ${targetUserDiscordIdArg} not found.`,
												{
													// biome-ignore lint/style/noNonNullAssertion: tomoriState.server_id checked above
													serverId: tomoriState!.server_id,
													metadata: {
														targetDiscordId: targetUserDiscordIdArg,
														targetNicknameAttempt: targetUserNicknameArg,
													},
												},
											);
										} else {
											// User found, now verify nickname as a "two-factor" check
											// Get the actual nickname from DB, falling back to guild nickname or Discord ID
											const actualNicknameInDB = targetUserRow.user_nickname;
											// Case-insensitive comparison for nickname
											if (
												actualNicknameInDB.toLowerCase() !==
													targetUserNicknameArg.toLowerCase() &&
												actualNicknameInDB.toLowerCase() !==
													message.guild?.members.cache
														.get(targetUserDiscordIdArg)
														?.displayName?.toLowerCase() // Fallback to guild nickname if available
											) {
												functionExecutionResult = {
													status: "memory_save_failed_nickname_mismatch",
													scope: "target_user",
													target_user_discord_id: targetUserDiscordIdArg,
													provided_nickname: targetUserNicknameArg,
													actual_nickname: actualNicknameInDB,
													reason: `The provided nickname '${targetUserNicknameArg}' does not match the records for user ID '${targetUserDiscordIdArg}' (Tomori knows them as '${actualNicknameInDB}'). Please ensure the Discord ID and nickname correspond to the same user.`,
												};
												log.warn(
													`Self-teach: Nickname mismatch for target user ${targetUserDiscordIdArg}. LLM provided: '${targetUserNicknameArg}', DB has: '${actualNicknameInDB}'.`,
													{
														// biome-ignore lint/style/noNonNullAssertion: tomoriState.server_id checked above
														serverId: tomoriState!.server_id,
														userId: targetUserRow.user_id, // Target user's internal ID
														errorType: "SelfTeachVerificationError",
														metadata: {
															targetDiscordId: targetUserDiscordIdArg,
															providedNickname: targetUserNicknameArg,
															dbNickname: actualNicknameInDB,
														},
													},
												);
											} else {
												// Nickname matches, proceed to save personal memory for the targetUserRow
												const dbResult = await addPersonalMemoryByTomori(
													targetUserRow.user_id, // Use the target user's internal ID
													memoryContent,
												);
												if (dbResult) {
													functionExecutionResult = {
														status: "memory_saved_successfully",
														scope: "target_user",
														user_discord_id: targetUserDiscordIdArg,
														user_nickname: targetUserNicknameArg, // Use the verified nickname
														content_saved: memoryContent,
													};
													log.success(
														`Tomori self-taught a personal memory for ${targetUserNicknameArg} (Discord ID: ${targetUserDiscordIdArg}, Internal ID: ${targetUserRow.user_id}): "${memoryContent}"`,
													);

													let personalMemoryFooterKey: string | undefined;
													const personalizationEnabled =
														tomoriState?.config.personal_memories_enabled ??
														true;
													const targetUserIsBlacklisted =
														(await isBlacklisted(serverDiscId, userDiscId)) ??
														false;

													if (!personalizationEnabled) {
														personalMemoryFooterKey =
															"genai.self_teach.personal_memory_footer_personalization_disabled";
													} else if (targetUserIsBlacklisted) {
														personalMemoryFooterKey =
															"genai.self_teach.personal_memory_footer_user_blacklisted";
													} else {
														personalMemoryFooterKey =
															"genai.self_teach.personal_memory_footer_manage";
													}
													await sendStandardEmbed(channel, locale, {
														color: ColorCode.SUCCESS,
														titleKey:
															"genai.self_teach.personal_memory_learned_title",
														descriptionKey:
															"genai.self_teach.personal_memory_learned_description",
														descriptionVars: {
															user_nickname: targetUserNicknameArg, // Display the name Tomori used
															memory_content:
																memoryContent.length > 200
																	? `${memoryContent.substring(0, 197)}...`
																	: memoryContent,
														},
														footerKey: personalMemoryFooterKey,
													});
												} else {
													functionExecutionResult = {
														status: "memory_save_failed_db_error",
														scope: "target_user",
														reason:
															"Database operation failed to save personal memory for the target user.",
													};
													await log.error(
														`Failed to save personal memory for ${targetUserNicknameArg} (Discord ID: ${targetUserDiscordIdArg}) via self-teach (DB error).`,
														undefined,
														{
															userId: targetUserRow.user_id, // Target user's internal ID
															// biome-ignore lint/style/noNonNullAssertion: tomoriState.server_id checked above
															serverId: tomoriState!.server_id,
															errorType: "SelfTeachDBError",
															metadata: {
																scope: "target_user",
																content: memoryContent,
																targetDiscordId: targetUserDiscordIdArg,
																targetNickname: targetUserNicknameArg,
															},
														},
													);
												}
											}
										}
									}
								}
							}
						} else {
							log.warn(
								`Stream LLM called unknown function: ${funcName}. Informing LLM.`,
							);
							functionExecutionResult = {
								status: "unknown_function_called",
								function_name_called: funcName,
								message: `The function '${funcName}' is not recognized or implemented. Please proceed without calling this function, or use one of the available functions.`,
							};
						}

						// 3. Add the model's function call and our function's result to the history
						functionInteractionHistory.push({
							functionCall: funcCall,
							functionResponse: {
								functionResponse: {
									name: funcName,
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
						descriptionVars: {
							error_message:
								streamingError instanceof Error
									? streamingError.message
									: "Unknown Error",
						},
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

	// 3. Check if the bot is mentioned directly
	// biome-ignore lint/style/noNonNullAssertion: client.user is available in messageCreate event
	const isBotMentioned = message.mentions.users.has(message.client.user!.id);

	// 4. Check if the message content triggers the bot based on configured triggers
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

	// 5. Check if the auto-message counter threshold is met
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

	// 6. Determine if bot should reply:
	// Reply if (it's a reply to the bot OR bot is mentioned OR triggers are active) OR if the auto-message threshold is hit
	return isReplyToBot || isBotMentioned || triggersActive || isAutoMsgHit;
}
