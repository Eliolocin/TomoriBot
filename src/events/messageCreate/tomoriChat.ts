import type { Client, Message, Sticker } from "discord.js";
import {
	BaseGuildTextChannel,
	DMChannel,
	MessageFlags,
	TextChannel,
} from "discord.js"; // Import value for instanceof check
// Provider imports moved to factory pattern
import type { StructuredContextItem } from "../../types/misc/context";
// Provider-specific types moved to individual providers
import type { FunctionCall } from "../../types/provider/interfaces";
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
import { StreamOrchestrator } from "../../utils/discord/streamOrchestrator";
import { ColorCode, log } from "../../utils/misc/logger";
import { buildContext } from "../../utils/text/contextBuilder";
import {
	removeYouTubeUrls,
	extractYouTubeVideoIds,
} from "../../utils/text/youTubeUrlCleaner";
import { PeekProfilePictureTool } from "../../tools/functionCalls/peekProfilePictureTool";
import { decryptApiKey } from "@/utils/security/crypto";
import { localizer, getSupportedLocales } from "../../utils/text/localizer";

import type { TomoriState } from "@/types/db/schema";
// Provider-specific function declarations moved to providers
import { getProviderForTomori } from "../../utils/provider/providerFactory";
import type {
	LLMProvider,
	StreamResult,
} from "../../types/provider/interfaces";
import { ToolRegistry } from "../../tools/toolRegistry";

// Constants
const MESSAGE_FETCH_LIMIT = 80;

// Base trigger words that will always work (with or without spaces for English)
const BASE_TRIGGER_WORDS = process.env.BASE_TRIGGER_WORDS?.split(",").map(
	(word) => word.trim(),
) || ["tomori", "tomo", "トモリ", "ともり"];

const MAX_FUNCTION_CALL_ITERATIONS = 5; // Safety break for function call loops
const STREAM_SDK_CALL_TIMEOUT_MS = 35000; // Slightly longer than internal stream inactivity, 35 seconds

/**
 * Creates comprehensive natural stop patterns for graceful stream interruption
 * Organized by category for easy maintenance and expansion
 * @returns Array of RegExp patterns for stop detection
 */
function createNaturalStopPatterns(): RegExp[] {
	// 1. Basic stop commands (single words with word boundaries)
	const basicStops = [
		"wait",
		"stop",
		"enough",
		"chill",
		"halt",
		"pause",
		"quit",
	];

	// 2. Polite stop phrases (with contextual words)
	const politeStops = [
		"okay\\s+(stop|enough)",
		"that's\\s+(enough|good|fine)",
		"alright\\s+stop",
		"please\\s+stop",
	];

	// 3. Dismissive phrases
	const dismissive = [
		"nevermind",
		"never\\s*mind",
		"cut\\s+it\\s+out",
		"tone\\s+it\\s+down",
		"knock\\s+it\\s+off",
	];

	// 4. Japanese stop patterns (common ways to say stop/enough in Japanese)
	const japanese = [
		"やめて", // yamete - stop it
		"ストップ", // sutoppu - stop (katakana)
		"もういい", // mou ii - that's enough
		"十分", // juubun - enough/sufficient
		"もう十分", // mou juubun - that's enough
		"いいよ", // ii yo - that's fine/enough
		"もうやめて", // mou yamete - stop it already
		"待って", // matte - wait
		"ちょっと待って", // chotto matte - wait a moment
	];

	// 5. Create regex patterns
	const patterns: RegExp[] = [];

	// Basic stops with word boundaries
	for (const stop of basicStops) {
		patterns.push(new RegExp(`\\b${stop}\\b`, "i"));
	}

	// Polite stops (already have proper spacing patterns)
	for (const polite of politeStops) {
		patterns.push(new RegExp(polite, "i"));
	}

	// Dismissive phrases with word boundaries where appropriate
	for (const dismiss of dismissive) {
		patterns.push(new RegExp(`\\b${dismiss}\\b`, "i"));
	}

	// Japanese patterns (no word boundaries needed for Japanese text)
	for (const jp of japanese) {
		patterns.push(new RegExp(jp, "i"));
	}

	return patterns;
}

// Generate stop patterns once at module load
const NATURAL_STOP_PATTERNS = createNaturalStopPatterns();

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
		isManuallyTriggered?: boolean;
		forceReason?: boolean;
		llmOverrideCodename?: string;
		isStopResponse?: boolean; // Flag to prevent stopping stop responses
	}>;
}
const channelLocks = new Map<string, ChannelLockEntry>(); // Key: channel.id

/**
 * Checks if a message contains natural stop patterns
 * @param content - The message content to check
 * @returns True if the message contains stop patterns
 */
function isNaturalStopMessage(content: string): boolean {
	if (!content?.trim()) return false;
	return NATURAL_STOP_PATTERNS.some((pattern) =>
		pattern.test(content.toLowerCase()),
	);
}

/**
 * Handles incoming messages to potentially generate a response using genai.
 * @param client - The Discord client instance.
 * @param message - The incoming Discord message.
 * @param isFromQueue - Whether this message is being processed from the queue.
 * @param isManuallyTriggered - Whether this call is triggered by a manual command.
 * @param forceReason - Whether to use reasoning mode for this response.
 * @param llmOverrideCodename - Override LLM model codename to use instead of server default.
 * @param isStopResponse - Whether this is a stop response (cannot be stopped).
 * @param retryCount - Number of retry attempts for empty responses (internal use).
 * @param skipLock - Whether to skip semaphore lock acquisition (for recursive calls).
 */
export default async function tomoriChat(
	client: Client,
	message: Message,
	isFromQueue: boolean,
	isManuallyTriggered?: boolean,
	forceReason?: boolean,
	llmOverrideCodename?: string,
	isStopResponse?: boolean,
	retryCount = 0,
	skipLock = false,
): Promise<void> {
	// 1. Initial Checks & State Loading
	const channel = message.channel;
	let locale = "en-US";

	// Early return for bot messages (including TomoriBot's own messages)
	if (message.author.bot && !isManuallyTriggered) {
		return;
	}

	// Debug logging for stop response
	if (isStopResponse) {
		log.info(
			`Processing stop response for message ${message.id} using original message as passport`,
		);
	}

	// Initialize streaming context for context-aware tool availability
	const streamingContext = {
		disableYouTubeProcessing: false, // Will be set to true during enhanced context restart
		disableProfilePictureProcessing: false, // Will be set to true during enhanced context restart
		forceReason, // Pass reasoning flag for enhanced AI responses
		isManuallyTriggered, // Pass command flag to indicate manual triggering
	};

	// biome-ignore lint/style/noNonNullAssertion: Author is always present in non-system messages
	const userDiscId = message.author!.id;

	// Handle different channel types - Guild channels vs DM channels
	let guild: typeof message.guild;
	let serverDiscId: string;
	let isDMChannel = false;

	if (channel instanceof BaseGuildTextChannel) {
		// Standard guild text channel
		// biome-ignore lint/style/noNonNullAssertion: Guild is always present in guild message events
		guild = message.guild!;
		serverDiscId = guild.id;
		isDMChannel = false;
	} else if (channel instanceof DMChannel) {
		// Direct Message channel - treat as pseudo-server
		guild = null;
		serverDiscId = userDiscId; // Use user ID as server ID for DMs
		isDMChannel = true;
		// Always treat DM messages as manually triggered (bypass trigger word checks)
		// Note: Using local variable to avoid parameter reassignment warning
		streamingContext.isManuallyTriggered = true;
		// biome-ignore lint/style/noParameterAssign: We want to ensure this is always true in DMs
		isManuallyTriggered = true; // Fix: Also update the parameter used in shouldBotReply check
		log.info(`Processing DM from user ${userDiscId} in channel ${channel.id}`);
	} else {
		// Group DMs or other unsupported channel types
		const errorEmbed = createStandardEmbed(locale, {
			color: ColorCode.ERROR,
			titleKey: "general.errors.channel_not_supported_title",
			descriptionKey: "general.errors.channel_not_supported_description",
		});

		if (
			"send" in channel &&
			// biome-ignore lint/style/noNonNullAssertion: client.user is checked during startup
			message.author.id !== client.user!.id
		) {
			try {
				await channel.send({ embeds: [errorEmbed] });
			} catch (sendError) {
				log.error("Failed to send unsupported channel type message", sendError);
			}
		}
		return;
	}
	// Skip permission check for DMs as we always have send permission

	if (
		!isDMChannel &&
		"permissionsFor" in channel &&
		// biome-ignore lint/style/noNonNullAssertion: client.user is checked during startup
		!channel.permissionsFor(client.user!)?.has("SendMessages")
	)
		return;

	// --- Pre-Semaphore Tomori State Loading for shouldBotReply check ---
	// Attempt to load Tomori state early to determine if a reply would even be considered.
	// This helps decide if a "busy" message is warranted.
	let earlyTomoriState: TomoriState | null = null;
	if (!skipLock) {
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
	}

	// --- Semaphore Logic (skipped for recursive retry calls) ---
	let lockEntry: ChannelLockEntry | undefined;
	if (!skipLock) {
		const channelLockId = channel.id;
		lockEntry = channelLocks.get(channelLockId);

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
			// Check for natural stop message first (if not already a stop response)
			if (!isStopResponse && isNaturalStopMessage(message.content)) {
				log.info(
					`Stop message detected in channel ${channelLockId} while processing message ${lockEntry.currentMessageId}. Signaling graceful stop.`,
				);

				// Import at the top if not already imported
				const { StreamOrchestrator } = await import(
					"../../utils/discord/streamOrchestrator"
				);

				// Signal the stream to stop with context for later response generation
				StreamOrchestrator.requestStop(channelLockId, message.author.id, {
					originalStopMessage: message,
					client,
				});

				log.info(
					`Stop signal sent for channel ${channelLockId}. Stop response will be generated after stream completes.`,
				);
				return;
			}

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
				// Always enqueue if it's a manual command, otherwise use shouldBotReply logic
				if (
					isManuallyTriggered ||
					shouldBotReply(message, modifiedEarlyTomoriStateForCheck)
				) {
					lockEntry.messageQueue.push({
						message,
						isManuallyTriggered,
						forceReason,
						llmOverrideCodename,
					});
					log.info(
						`Channel ${channelLockId} is busy (msg ${lockEntry.currentMessageId}). Enqueued message ${message.id}. Queue: ${lockEntry.messageQueue.length}. Tomori would reply (autoch_counter simulated as 0 for this check).`,
					);

					// 3. Send "busy" reply to the user if not the bot itself.
					// biome-ignore lint/style/noNonNullAssertion: client.user is checked during startup
					if (message.author.id !== client.user!.id) {
						try {
							const tempUserRow = await loadUserRow(userDiscId);
							const waitingLocale =
								tempUserRow?.language_pref ?? guild?.preferredLocale ?? "en-US";
							const currentMessageLink = lockEntry.currentMessageId
								? isDMChannel
									? `https://discord.com/channels/@me/${channel.id}/${lockEntry.currentMessageId}`
									: guild?.id
										? `https://discord.com/channels/${guild.id}/${channel.id}/${lockEntry.currentMessageId}`
										: "a previous message"
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
											currentMessageIdInQueue: lockEntry?.currentMessageId,
											userDiscId,
											guildDiscId: guild?.id || null, // null for DMs
											isDMChannel,
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
										guildDiscId: guild?.id || null, // null for DMs
										isDMChannel,
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
	}
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

			/**
			 * Check if an embed title matches target localizer keys that should be processed as text.
			 * Checks against all supported locales to handle cross-locale embed detection.
			 * @param embedTitle - The embed title to check
			 * @returns Object with isTarget boolean and the type of target found
			 */
			function checkTargetEmbedTitle(embedTitle: string | null): {
				isTarget: boolean;
				type: "memory_learning" | "reset" | null;
			} {
				if (!embedTitle) return { isTarget: false, type: null };

				// Check against all supported locales to handle cross-locale scenarios
				// (e.g., Japanese user creates reset embed, English user should still detect it)
				for (const supportedLocale of getSupportedLocales()) {
					// Target localizer keys for memory learning embeds
					const memoryLearningTitles = [
						localizer(
							supportedLocale,
							"genai.self_teach.server_memory_learned_title",
						),
						localizer(
							supportedLocale,
							"genai.self_teach.personal_memory_learned_title",
						),
					];

					// Target localizer key for conversation reset
					const resetTitle = localizer(
						supportedLocale,
						"commands.tool.refresh.title",
					);

					// Check for memory learning embeds
					if (memoryLearningTitles.some((title) => embedTitle === title)) {
						return { isTarget: true, type: "memory_learning" };
					}

					// Check for reset embed
					if (embedTitle === resetTitle) {
						return { isTarget: true, type: "reset" };
					}
				}

				// EXTENSIBILITY EXAMPLE: Adding new embed types is easy!
				// 1. Add new type to union: 'memory_learning' | 'reset' | 'new_type' | null
				// 2. Add new localizer checks inside the locale loop:
				// const newTypeTitles = [
				//     localizer(supportedLocale, "commands.some_feature.title"),
				//     localizer(supportedLocale, "genai.some_other.title"),
				// ];
				// if (newTypeTitles.some(title => embedTitle === title)) {
				//     return { isTarget: true, type: 'new_type' };
				// }

				return { isTarget: false, type: null };
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
					if (referenceMessage) {
						isReplyToBot = referenceMessage.author.id === client.user?.id;
					}
				} catch (fetchError) {
					log.warn(
						"Could not fetch reference message for reply check",
						fetchError,
					);
				}
			}

			// Check for base trigger words
			isBaseTriggerWord = checkForBaseTriggerWords(message.content);

			// 4. Early validation for directly triggered messages or manual triggers (including DMs)
			// For DMs, always validate regardless of content since all DM messages should trigger responses
			if (
				isBaseTriggerWord ||
				isReplyToBot ||
				isManuallyTriggered ||
				(isDMChannel && message.author.id !== client.user?.id)
			) {
				// If user directly mentioned Tomori, replied to it, or manually triggered (DMs), validate state

				// Validate Tomori is set up
				if (!tomoriState) {
					const contextMessage = isDMChannel
						? `User tried to use Tomori in DM but no Tomori instance found for user ${userDiscId}.`
						: `User mentioned Tomori in server ${serverDiscId} but Tomori not set up.`;
					log.info(contextMessage);

					await sendStandardEmbed(channel, locale, {
						color: ColorCode.ERROR,
						titleKey: "general.errors.tomori_not_setup_title",
						descriptionKey: "general.errors.tomori_not_setup_description",
						...(isDMChannel && {
							footerKey: "general.errors.tomori_not_setup_dm_footer",
						}),
					});
					return;
				}

				// Validate API key is configured
				if (!tomoriState.config.api_key) {
					const contextMessage = isDMChannel
						? `User tried to use Tomori in DM but API key not configured for user ${userDiscId}.`
						: `User mentioned Tomori in server ${serverDiscId} but API key not configured.`;
					log.info(contextMessage);

					await sendStandardEmbed(channel, locale, {
						color: ColorCode.ERROR,
						titleKey: "general.errors.api_key_missing_title",
						descriptionKey: "general.errors.api_key_missing_description",
						...(isDMChannel && {
							footerKey: "general.errors.tomori_not_setup_dm_footer",
						}),
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
			// Skip check if this is a manual command trigger
			if (!isManuallyTriggered && !shouldBotReply(message, tomoriState)) {
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

				// Check if *any* embed in the message contains a reset title using localizer
				const embedContainsReset = msg.embeds.some((embed) => {
					const embedCheck = checkTargetEmbedTitle(embed.title);
					return embedCheck.isTarget && embedCheck.type === "reset";
				});

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

			for (const [index, msg] of relevantMessagesArray.entries()) {
				const authorId = msg.author.id;
				const isLastMessage = index === relevantMessagesArray.length - 1;

				// Variable to store referenced message data for later attachment extraction
				let referencedMessageData: { message: Message } | undefined;

				// 1. Check for debug prefix "$:" at the start of the message
				const isDebugMessage = msg.content.startsWith("$:"); // Easter egg functionality hehehe
				let processedContent = msg.content;

				// 2. If debug prefix found, trim it and treat message as coming from bot
				if (isDebugMessage) {
					processedContent = msg.content.slice(2); // Remove "$:" prefix
				}

				// 3. Add reference context if this is the last message and it's replying to another message
				if (isLastMessage && msg.reference?.messageId && processedContent) {
					try {
						const msgReferencedMessage = await channel.messages.fetch(
							msg.reference.messageId,
						);
						if (msgReferencedMessage) {
							// Get the author name for the referenced message
							const referencedAuthorName =
								msgReferencedMessage.author.id === client.user?.id
									? tomoriState?.tomori_nickname || "Bot"
									: msgReferencedMessage.author.username;

							// Get the referenced message content (truncate if too long)
							let referencedContent =
								msgReferencedMessage.content || "[No text content]";
							if (referencedContent.length > 200) {
								referencedContent = `${referencedContent.substring(0, 197)}...`;
							}

							// Store referenced message info for later attachment extraction
							// (attachments will be processed after imageAttachments/videoAttachments arrays are declared)
							referencedMessageData = {
								message: msgReferencedMessage,
							};

							// Create enhanced reference context that mentions attachments (will be updated later)
							let attachmentInfo = "";
							// Temporarily count attachments to show in context
							let imageCount = 0;
							let videoCount = 0;
							if (msgReferencedMessage.attachments.size > 0) {
								for (const attachment of msgReferencedMessage.attachments.values()) {
									if (
										attachment.contentType?.startsWith("image/png") ||
										attachment.contentType?.startsWith("image/jpeg") ||
										attachment.contentType?.startsWith("image/webp") ||
										attachment.contentType?.startsWith("image/heic") ||
										attachment.contentType?.startsWith("image/heif")
									) {
										imageCount++;
									} else if (
										attachment.contentType &&
										SUPPORTED_VIDEO_MIME_TYPES.some((type) =>
											attachment.contentType?.startsWith(type),
										)
									) {
										videoCount++;
									}
								}
							}

							if (imageCount > 0) {
								attachmentInfo += ` (with ${imageCount} image${imageCount > 1 ? "s" : ""})`;
							}
							if (videoCount > 0) {
								attachmentInfo += ` (with ${videoCount} video${videoCount > 1 ? "s" : ""})`;
							}

							// Add reference context to the message
							const referenceContext = `[System: This message is referring to a previous message by ${referencedAuthorName} saying: ${referencedContent}${attachmentInfo}]`;
							processedContent = `${referenceContext}\n${processedContent}`;
						}
					} catch (fetchError) {
						log.warn(
							`Could not fetch referenced message ${msg.reference.messageId} for context`,
							fetchError,
						);
					}
				}

				// 4. Determine author name and ID based on message type
				let effectiveAuthorId = authorId;
				let authorName: string;

				if (msg.author.id === client.user?.id || isDebugMessage) {
					authorName = tomoriState?.tomori_nickname; // Use Tomori's nickname for bot messages or debug messages
				} else {
					authorName = `<@${authorId}>`; // Format user as <@ID>, to be converted by convertMentions later to user's registered name (if existing)
				}

				userListSet.add(authorId);
				const imageAttachments: SimplifiedMessageForContext["imageAttachments"] =
					[];
				const videoAttachments: SimplifiedMessageForContext["videoAttachments"] =
					[];
				let messageContentForLlm: string | null = processedContent; // Use processed content (with reference context and "$:" removed if present)
				let hasProcessedEmbed = false; // Track if this message contains a processed embed

				// Extract attachments from referenced message if it exists (after arrays are declared)
				// Check if this is the last message and we have stored reference message data
				if (
					isLastMessage &&
					typeof referencedMessageData !== "undefined" &&
					referencedMessageData.message.attachments.size > 0
				) {
					for (const attachment of referencedMessageData.message.attachments.values()) {
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
						} else if (
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
						}
					}

					// Log attachment extraction for debugging
					const extractedImages = imageAttachments.length;
					const extractedVideos = videoAttachments.filter(
						(v) => !v.isYouTubeLink,
					).length;
					if (extractedImages > 0 || extractedVideos > 0) {
						log.info(
							`Extracted ${extractedImages} images and ${extractedVideos} videos from referenced message ${referencedMessageData.message.id}`,
						);
					}
				}

				// Process embeds for target titles that should be included as text content
				if (msg.embeds.length > 0) {
					for (const embed of msg.embeds) {
						const embedCheck = checkTargetEmbedTitle(embed.title);
						if (
							embedCheck.isTarget &&
							embedCheck.type === "memory_learning" &&
							embed.description
						) {
							// Remove bot name prefix from embed description if present
							let cleanedDescription = embed.description;
							if (tomoriState?.tomori_nickname) {
								// Escape special regex characters in the bot nickname
								const escapedNickname = tomoriState.tomori_nickname.replace(
									/[.*+?^${}()|[\]\\]/g,
									"\\$&",
								);
								const botNamePattern = new RegExp(
									`^${escapedNickname}:\\s*`,
									"i",
								);
								if (botNamePattern.test(cleanedDescription)) {
									cleanedDescription = cleanedDescription
										.replace(botNamePattern, "")
										.trim();
								}
							}

							// Add embed content to message text with special marker
							const embedContent = `[The following is a system-produced embed]\n${cleanedDescription}`;
							messageContentForLlm = messageContentForLlm
								? `${messageContentForLlm}\n${embedContent}`
								: embedContent;
							hasProcessedEmbed = true;
						}
					}
				}

				// Override author information for special message types
				if (hasProcessedEmbed) {
					// Processed embeds should appear as system/user messages
					effectiveAuthorId = "system-embed"; // Use a special system ID to prevent combination
					authorName = "System"; // Use "System" as the author name for processed embeds
				} else if (isDebugMessage) {
					// Debug messages ($:) should appear as coming from the bot (model role)
					effectiveAuthorId = client.user?.id || "bot"; // Use bot's actual ID for debug messages
					authorName = tomoriState?.tomori_nickname || "Bot"; // Keep bot nickname
				}

				// 5.a. Process direct image attachments and stickers
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

				// 5.b. Check for Tenor GIF links if no direct image attachments were found
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

				// 5.c. Check if this message is from the same effective author as the previous one
				const prevMessage = simplifiedMessages[simplifiedMessages.length - 1];

				// 6. Check if the previous message was also a debug message
				const prevWasDebugMessage =
					prevMessage &&
					prevMessage.authorName === tomoriState?.tomori_nickname &&
					prevMessage.authorId !== client.user?.id; // Was debug message if it shows as Tomori but isn't actually from the bot

				// 7. Only combine messages from the same "effective author"
				// This prevents combining debug messages ($:) with regular messages from the same user
				// and prevents combining processed embed messages with other messages
				const isSameEffectiveAuthor =
					prevMessage &&
					prevMessage.authorId === effectiveAuthorId &&
					prevWasDebugMessage === isDebugMessage;

				// 5.d. Determine if we should combine with the previous message or create a new entry
				if (
					isSameEffectiveAuthor &&
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
						authorId: effectiveAuthorId,
						authorName,
						content: messageContentForLlm,
						imageAttachments,
						videoAttachments,
					});
				}
			}

			const userList = Array.from(userListSet);
			const channelName = isDMChannel
				? "Direct Message"
				: "name" in channel
					? channel.name
					: "Unknown Channel";
			const channelDesc = isDMChannel
				? null
				: "topic" in channel
					? channel.topic
					: null;
			const serverName = isDMChannel
				? "Direct Message"
				: guild?.name || "Unknown Server";
			const serverDescription = isDMChannel ? null : guild?.description;

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
					serverDescription: serverDescription ?? null,
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
					isDMChannel, // Pass DM channel flag for proper context building
				});

				// Inject system context for stop responses
				if (isStopResponse) {
					// Find the last user message in context and replace/supplement it with system context
					let lastUserContextIndex = -1;
					for (let i = contextSegments.length - 1; i >= 0; i--) {
						if (contextSegments[i].role === "user") {
							lastUserContextIndex = i;
							break;
						}
					}

					if (lastUserContextIndex !== -1) {
						// Replace the last user message content with system context
						const lastUserContext = contextSegments[lastUserContextIndex];
						const originalContent = lastUserContext.parts
							.filter((part) => part.type === "text")
							.map((part) => (part as { type: "text"; text: string }).text)
							.join(" ");

						// Replace text parts with system context, preserve other parts (images, etc.)
						const nonTextParts = lastUserContext.parts.filter(
							(part) => part.type !== "text",
						);
						lastUserContext.parts = [
							{
								type: "text",
								text: `[System: The user has requested you to stop your current generation. Original message: "${originalContent}"]`,
							},
							...nonTextParts,
						];

						log.info(
							`Replaced last user message with system stop context. Original content: "${originalContent}"`,
						);
					} else {
						// Fallback: add as new context item if no user message found
						const systemStopContext: StructuredContextItem = {
							role: "user",
							parts: [
								{
									type: "text",
									text: "[System: The user has requested you to stop your current generation]",
								},
							],
						};
						contextSegments.push(systemStopContext);
						log.info(
							"Added system stop context as new message (no user context found)",
						);
					}
				}
			} catch (error) {
				log.error("Error building context for LLM API Call:", error, {
					serverId: tomoriState?.server_id, // Use internal DB ID if available
					errorType: "ContextBuildingError",
					metadata: {
						guildId: serverDiscId,
						channelName: channelName, // Use the channelName variable we already calculated
						userCountInContext: userList.length,
					},
				});
				await sendStandardEmbed(channel, locale, {
					color: ColorCode.ERROR,
					titleKey: "general.errors.context_error_title",
					descriptionKey: "general.errors.context_error_description",
					footerKey: "genai.generic_error_footer",
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

			// 12. Generate Response - Get provider instance

			// Get the appropriate provider based on TomoriState configuration
			let provider: LLMProvider;
			try {
				provider = getProviderForTomori(tomoriState);
			} catch (error) {
				log.error(
					`Failed to get LLM provider: ${error instanceof Error ? error.message : String(error)}`,
					error as Error,
					{
						serverId: tomoriState?.server_id,
						errorType: "ProviderError",
						metadata: {
							configuredProvider: tomoriState?.llm.llm_provider,
							configuredModel: tomoriState?.llm.llm_codename,
						},
					},
				);
				await sendStandardEmbed(channel, locale, {
					color: ColorCode.ERROR,
					titleKey: "general.errors.provider_not_supported_title",
					descriptionKey: "general.errors.provider_not_supported_description",
					descriptionVars: {
						provider: tomoriState?.llm.llm_provider || "unknown",
					},
				});
				return;
			}

			// Create provider-specific configuration
			// If model override is specified, temporarily modify tomoriState
			let originalModelCodename: string | undefined;
			if (llmOverrideCodename) {
				originalModelCodename = tomoriState.llm.llm_codename;
				tomoriState.llm.llm_codename = llmOverrideCodename;
				log.info(
					`Overriding model from ${originalModelCodename} to ${llmOverrideCodename} for manual command`,
				);
			}

			const providerConfig = await provider.createConfig(
				tomoriState,
				decryptedApiKey,
			);

			// Restore original model if it was overridden
			if (originalModelCodename) {
				tomoriState.llm.llm_codename = originalModelCodename;
			}

			log.info(
				"Streaming mode enabled. Attempting to stream response to Discord.",
			);

			// 1. Initialize variables for the function calling loop in streaming mode
			let selectedStickerToSend: Sticker | null = null;
			const functionInteractionHistory: {
				functionCall: FunctionCall;
				functionResponse: Record<string, unknown>;
			}[] = [];
			let finalStreamCompleted = false;
			const accumulatedStreamedModelParts: Array<Record<string, unknown>> = [];

			for (let i = 0; i < MAX_FUNCTION_CALL_ITERATIONS; i++) {
				log.info(
					`Streaming LLM Call Iteration: ${i + 1}/${MAX_FUNCTION_CALL_ITERATIONS}. History items: ${functionInteractionHistory.length}`,
				);

				try {
					const streamProviderPromise = await provider.streamToDiscord(
						channel,
						client,
						// biome-ignore lint/style/noNonNullAssertion: Missing Tomoristate handled at start of TomoriChat
						tomoriState!,
						providerConfig,
						contextSegments, // Original full prompt context
						accumulatedStreamedModelParts, // MODIFIED: Pass the accumulator (Rule 26)
						emojiStrings,
						functionInteractionHistory.length > 0
							? functionInteractionHistory
							: undefined, // Pass history if it exists
						undefined,
						isFromQueue ? message : undefined,
						streamingContext, // Pass streaming context for context-aware tool availability
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
											"SDK_CALL_TIMEOUT: provider streamToDiscord call timed out.",
										),
									),
								STREAM_SDK_CALL_TIMEOUT_MS,
							),
					);

					let streamResult: StreamResult;
					try {
						// Promise.race will settle as soon as one of the promises settles
						streamResult = await Promise.race([
							streamProviderPromise,
							timeoutPromise,
						]);
					} catch (raceError) {
						// This catch block will execute if timeoutPromise rejects first,
						// or if streamProviderPromise itself rejects *before* the timeout.
						if (
							raceError instanceof Error &&
							raceError.message.startsWith("SDK_CALL_TIMEOUT:")
						) {
							log.error(
								`Provider streamToDiscord call timed out for channel ${channel.id}.`,
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

					// Handle empty response with fresh context retry
					if (streamResult.status === "empty_response") {
						const MAX_EMPTY_RESPONSE_RETRIES = 2;
						const RETRY_DELAY_MS = 1000;

						if (retryCount < MAX_EMPTY_RESPONSE_RETRIES) {
							log.info(
								`Empty response detected (attempt ${retryCount + 1}/${MAX_EMPTY_RESPONSE_RETRIES + 1}). Retrying with fresh context in ${RETRY_DELAY_MS}ms...`,
							);

							// Wait before retry
							await new Promise((resolve) =>
								setTimeout(resolve, RETRY_DELAY_MS),
							);

							// Recursive call with fresh context (skipLock=true to avoid semaphore issues)
							return await tomoriChat(
								client,
								message,
								isFromQueue,
								true, // isManuallyTriggered - bypass trigger checks for retry
								forceReason,
								llmOverrideCodename,
								isStopResponse,
								retryCount + 1, // Increment retry count
								true, // skipLock - parent already holds the lock
							);
						} else {
							// Max retries reached, show error embed
							log.warn(
								`Empty response after ${MAX_EMPTY_RESPONSE_RETRIES} retries. Showing error embed.`,
							);

							await sendStandardEmbed(channel, locale, {
								titleKey: "genai.empty_response_title",
								descriptionKey: "genai.empty_response_description",
								color: ColorCode.WARN,
								footerKey: "genai.generic_error_footer",
							}).catch((e) =>
								log.warn("Failed to send empty response embed to channel", e),
							);

							finalStreamCompleted = true; // Mark as completed to exit
							break;
						}
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

					// Handle user-requested stop (natural stop triggers)
					if (streamResult.status === "stopped_by_user") {
						log.info(
							`Streaming was stopped by user request for channel ${channel.id}.`,
						);
						finalStreamCompleted = true;

						// Check if we have stop context to create a response
						const { StreamOrchestrator } = await import(
							"../../utils/discord/streamOrchestrator"
						);
						const stopContext = StreamOrchestrator.getAndClearStopContext(
							channel.id,
						);

						if (stopContext) {
							// Get the current lock entry to queue the stop response
							const currentLockEntry = channelLocks.get(channel.id);
							if (currentLockEntry) {
								// Queue the original stop message as a "passport" for stop response
								currentLockEntry.messageQueue.unshift({
									message: stopContext.originalStopMessage,
									isManuallyTriggered: true, // This bypasses normal trigger logic
									forceReason: false,
									llmOverrideCodename,
									isStopResponse: true, // This response cannot be stopped
								});

								log.info(
									`Stop response queued after stream completion for channel ${channel.id}. Queue size: ${currentLockEntry.messageQueue.length}`,
								);
							}
						}

						break; // Exit the loop gracefully, stop response will be handled by queue
					}

					if (streamResult.status === "function_call" && streamResult.data) {
						const funcCall = streamResult.data as FunctionCall; // Type assertion
						const funcName = funcCall.name?.trim() ?? "";
						log.info(
							`Stream LLM wants to call function: ${funcName} with args: ${JSON.stringify(funcCall.args)}`,
						);

						// 2. Execute function using modular tool system
						log.info(
							`Executing tool: ${funcName} with args: ${JSON.stringify(funcCall.args)}`,
						);

						// Build tool execution context
						const toolContext = {
							channel,
							client,
							message,
							userId: userRow?.user_id?.toString() || userDiscId,
							tomoriState,
							locale,
							provider: "google" as const,
							streamContext: streamingContext, // Pass streaming context to tools
						};

						// Execute tool using ToolRegistry (handles both built-in and MCP tools seamlessly)
						// Check for stop request before executing function call
						if (StreamOrchestrator.hasStopRequest(channel.id)) {
							log.info(
								`Function call execution cancelled due to stop request: ${funcName}`,
							);
							finalStreamCompleted = true;
							break;
						}

						const functionCallStart = Date.now();
						const toolResult = await ToolRegistry.executeTool(
							funcName,
							funcCall.args || {},
							toolContext,
						);
						const functionCallDuration = Date.now() - functionCallStart;

						// Log function call timing (especially long-running ones)
						if (functionCallDuration > 5000) {
							log.warn(
								`Long-running function call: ${funcName} took ${functionCallDuration}ms`,
							);
						} else {
							log.info(
								`Function call completed: ${funcName} (${functionCallDuration}ms)`,
							);
						}

						// Convert tool result to function execution result format
						let functionExecutionResult: Record<string, unknown>;

						if (toolResult.success) {
							functionExecutionResult = (toolResult.data as Record<
								string,
								unknown
							>) || { status: "completed" };

							// Handle sticker selection specifically (extract sticker for later sending)
							if (
								funcName === "select_sticker_for_response" &&
								toolResult.data
							) {
								const stickerData = toolResult.data as Record<string, unknown>;
								if (stickerData.status === "sticker_selected_successfully") {
									// Find the sticker in guild cache to send later
									const discordSticker = guild?.stickers.cache.get(
										stickerData.sticker_id as string,
									);
									selectedStickerToSend = discordSticker || null;
									log.success(
										`Sticker '${stickerData.sticker_name}' selected for sending`,
									);
								} else {
									selectedStickerToSend = null;
								}
							}

							// Handle YouTube video restart signal (enhanced context restart)
							if (
								funcName === "process_youtube_video" &&
								toolResult.data &&
								(toolResult.data as Record<string, unknown>).type ===
									"context_restart_with_video"
							) {
								const restartData = toolResult.data as Record<string, unknown>;
								const enhancedContextItem =
									restartData.enhanced_context_item as StructuredContextItem;
								const videoUrl = restartData.video_url as string;
								const videoId = restartData.video_id as string;

								log.info(
									`YouTube video restart signal detected for: ${videoUrl}. Cleaning URLs and enhancing context.`,
								);

								// Set flag to disable YouTube processing during enhanced context restart
								// This prevents TomoriBot from making additional YouTube function calls while processing
								streamingContext.disableYouTubeProcessing = true;
								log.info(
									"Temporarily disabled YouTube processing function during enhanced context restart",
								);

								// Clean YouTube URLs from all existing context text parts FIRST to prevent false duplication detection
								for (const contextItem of contextSegments) {
									for (const part of contextItem.parts) {
										if (part.type === "text") {
											const originalText = part.text;
											part.text = removeYouTubeUrls(part.text, "");
											if (originalText !== part.text) {
												log.info(
													`Cleaned YouTube URLs from context text during duplication check. Original length: ${originalText.length}, cleaned length: ${part.text.length}`,
												);
											}
										}
									}
								}

								// Check for existing video parts with same video ID to prevent duplication
								// Only check actual video Parts, not text mentions (which are now cleaned)
								const existingVideoIds = new Set<string>();
								for (const contextItem of contextSegments) {
									for (const part of contextItem.parts) {
										// Check for enhanced context YouTube video parts specifically
										if (
											part.type === "video" &&
											part.uri &&
											"isYouTubeLink" in part &&
											(part as { isYouTubeLink: boolean }).isYouTubeLink &&
											"enhancedContext" in part &&
											(part as { enhancedContext: boolean }).enhancedContext
										) {
											const existingIds = extractYouTubeVideoIds(part.uri);
											for (const id of existingIds) {
												existingVideoIds.add(id);
											}
										}
									}
								}

								// Only add video part if not already present
								if (!existingVideoIds.has(videoId)) {
									// Add the video context item to existing context
									contextSegments.push(enhancedContextItem);
									log.success(
										`Enhanced context with YouTube video Part (ID: ${videoId}). Total context items: ${contextSegments.length}`,
									);
								} else {
									log.warn(
										`YouTube video ${videoId} already exists in context. Skipping duplication.`,
									);
								}

								// Continue to next iteration WITHOUT adding to function interaction history
								// This will restart the streaming with enhanced context
								continue;
							}

							// Handle profile picture restart signal (enhanced context restart)
							if (
								funcName === "peek_profile_picture" &&
								toolResult.data &&
								(toolResult.data as Record<string, unknown>).type ===
									"context_restart_with_image"
							) {
								const restartData = toolResult.data as Record<string, unknown>;
								const userId = restartData.user_id as string;
								const username = restartData.username as string;

								log.info(
									`Profile picture restart signal detected for user: ${username} (${userId}). Enhancing context with avatar image.`,
								);

								// Get the enhanced context item from external storage
								const enhancedContextItem =
									PeekProfilePictureTool.getPendingEnhancedContext(userId);

								if (!enhancedContextItem) {
									log.warn(
										`No pending enhanced context found for user ${userId}. Profile picture restart failed.`,
									);
									continue;
								}

								// Set flag to disable profile picture processing during enhanced context restart
								// This prevents TomoriBot from making additional profile picture function calls while processing
								streamingContext.disableProfilePictureProcessing = true;
								log.info(
									"Temporarily disabled profile picture processing function during enhanced context restart",
								);

								// Check for existing profile picture parts for this user to prevent duplication
								let hasExistingProfilePicture = false;
								for (const contextItem of contextSegments) {
									for (const part of contextItem.parts) {
										// Check for enhanced context profile picture parts specifically
										if (
											part.type === "image" &&
											"isProfilePicture" in part &&
											(part as { isProfilePicture: boolean })
												.isProfilePicture &&
											"enhancedContext" in part &&
											(part as { enhancedContext: boolean }).enhancedContext
										) {
											hasExistingProfilePicture = true;
											break;
										}
									}
									if (hasExistingProfilePicture) break;
								}

								// Only add profile picture part if not already present
								if (!hasExistingProfilePicture) {
									// Add the profile picture context item to existing context
									contextSegments.push(enhancedContextItem);
									log.success(
										`Enhanced context with profile picture for user: ${username}. Total context items: ${contextSegments.length}`,
									);
								} else {
									log.warn(
										`Profile picture for user ${username} already exists in context. Skipping duplication.`,
									);
								}

								// Continue to next iteration WITHOUT adding to function interaction history
								// This will restart the streaming with enhanced context
								continue;
							}
						} else {
							// Tool execution failed
							functionExecutionResult = {
								status: "tool_execution_failed",
								reason:
									toolResult.error ||
									"Tool execution failed without specific error",
								tool_name: funcName,
							};
							log.error(
								`Tool execution failed for ${funcName}: ${toolResult.error}`,
							);
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
								footerKey: "genai.generic_error_footer",
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
						descriptionKey: "genai.stream.streaming_failed_description",
						descriptionVars: {
							error_message:
								streamingError instanceof Error
									? streamingError.message
									: "Unknown Error",
						},
						footerKey: "genai.generic_error_footer",
					});
					finalStreamCompleted = true; // Break loop on critical error
					break;
				}
			} // End of for loop for function call iterations

			// Clear YouTube processing disable flag after streaming completes
			if (streamingContext.disableYouTubeProcessing) {
				streamingContext.disableYouTubeProcessing = false;
				log.info(
					"Re-enabled YouTube processing function after enhanced context restart completion",
				);
			}

			// Clear profile picture processing disable flag after streaming completes
			if (streamingContext.disableProfilePictureProcessing) {
				streamingContext.disableProfilePictureProcessing = false;
				log.info(
					"Re-enabled profile picture processing function after enhanced context restart completion",
				);
			}

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
				footerKey: "genai.generic_error_footer",
			});
		}
	} finally {
		// --- Semaphore Logic: Release lock and process queue (only for non-recursive calls) ---
		if (!skipLock && lockEntry) {
			// Ensure lockEntry is defined
			const channelLockId = channel.id;
			lockEntry.isLocked = false;
			lockEntry.lockedAt = 0;
			lockEntry.currentMessageId = undefined;
			log.info(
				`Channel ${channelLockId} lock released for message ${message.id}.`,
			);

			// Check for stop context and create response after lock release
			const { StreamOrchestrator } = await import(
				"../../utils/discord/streamOrchestrator"
			);
			const stopContext =
				StreamOrchestrator.getAndClearStopContext(channelLockId);
			if (stopContext) {
				log.info(
					`Found stop context for channel ${channelLockId}. Triggering stop response after lock release.`,
				);

				// Trigger stop response after current execution completes and lock is fully released
				setImmediate(async () => {
					try {
						await handleStopResponse(
							stopContext.originalStopMessage,
							stopContext.client,
						);
					} catch (error) {
						log.error(
							"Failed to generate stop response after lock release:",
							error,
						);
					}
				});
			}

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
						tomoriChat(
							client,
							nextMessageData.message,
							true,
							nextMessageData.isManuallyTriggered,
							nextMessageData.forceReason,
							nextMessageData.llmOverrideCodename,
							nextMessageData.isStopResponse, // Pass through the stop response flag
							0, // retryCount - start fresh for queued messages
							false, // skipLock - queued messages should acquire lock normally
						).catch((e) => {
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
		!(
			message.channel instanceof TextChannel ||
			message.channel instanceof DMChannel
		) // Support both TextChannel and DMChannel
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

/**
 * Handles stop response generation after a stream has been interrupted
 * @param originalStopMessage - The original message that requested the stop
 * @param client - Discord client
 */
export async function handleStopResponse(
	originalStopMessage: Message,
	client: Client,
): Promise<void> {
	try {
		log.info(
			`Generating stop response for message ${originalStopMessage.id} in channel ${originalStopMessage.channel.id}`,
		);

		// Use original stop message as "passport" (like respond.ts command does)
		// isManuallyTriggered: true bypasses all normal trigger logic
		await tomoriChat(
			client,
			originalStopMessage,
			true, // isFromQueue to trigger reply to same message
			true, // isManuallyTriggered - this bypasses normal trigger logic and forces response
			false, // forceReason
			undefined, // llmOverrideCodename
			true, // isStopResponse - This prevents the stop response from being stopped
			0, // retryCount - start fresh for stop responses
			false, // skipLock - stop responses should acquire lock normally
		);
	} catch (error) {
		log.error("Failed to handle stop response:", error);
	}
}
