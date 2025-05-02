import type { Client, PresenceStatus } from "discord.js";
import { GatewayIntentBits } from "discord.js";
import type { ContextSegment } from "../../types/misc/context"; // Import ContextSegment type
import {
	isBlacklisted, // Import blacklist checker
	loadTomoriState,
	loadUserRow,
} from "../db/dbRead"; // Import session helpers
import { registerUser } from "../db/dbWrite";
import { log } from "../misc/logger";
import { replaceTemplateVariables, getCurrentTime } from "./stringHelper";
import { humanizeString } from "./humanizer";
// Import ServerEmojiRow if needed for emoji query result type
// import type { ServerEmojiRow } from "../../types/db/schema";

/**
 * Maps userId -> nickname for the current mention replacement operation.
 * @remarks This cache is cleared after each text processing run to avoid stale data.
 */
const mentionCache = new Map<string, string>();

/**
 * Converts Discord mention IDs to human-readable names using cached database lookups.
 * Also handles special placeholders like {user} and {bot}.
 * Checks for custom user nicknames first, falls back to Discord usernames.
 * @param text - Text containing Discord mention strings or placeholders
 * @param client - Discord client for user/role lookups
 * @param serverId - Discord server ID for context
 * @param triggererName - Name of the user who triggered the action (for {user} replacement)
 * @returns Text with mentions and placeholders replaced by human-readable names
 */
export async function convertMentions(
	text: string,
	client: Client,
	serverId: string,
	triggererName?: string,
): Promise<string> {
	// Clear the cache before processing new text
	mentionCache.clear();

	// First handle Discord mentions
	const mentionPattern = /<[@#][!&]?(\d{17,19})>/g;
	const matches = Array.from(text.matchAll(mentionPattern));

	// Load Tomori's state for her nickname if needed
	let tomoriNickname: string | null = "Tomori";
	const tomoriState = await loadTomoriState(serverId);
	if (tomoriState?.tomori_nickname) {
		tomoriNickname = tomoriState.tomori_nickname;
	}

	let result = text;

	// Process Discord mentions
	if (matches.length > 0) {
		const mentions = matches.map((match) => ({
			match: match[0],
			id: match[1],
			start: match.index ?? 0,
			end: (match.index ?? 0) + match[0].length,
		}));

		const replacements = await Promise.all(
			mentions.map(async ({ match, id }) => {
				// --- User Mentions ---
				if (match.startsWith("<@")) {
					const cachedName = mentionCache.get(id);
					if (cachedName) return `${cachedName}`;
					try {
						// Check if this is Tomori herself
						if (client.user && id === client.user.id && tomoriNickname) {
							mentionCache.set(id, tomoriNickname);
							return `${tomoriNickname}`;
						}

						// Check if user is blacklisted
						const isUserBlacklisted = await isBlacklisted(serverId, id);

						// Otherwise process as normal user
						const userData = await loadUserRow(id);

						// If user is blacklisted, use Discord display name instead of custom nickname
						if (isUserBlacklisted || !userData?.user_nickname) {
							// Try getting user from cache first
							const user = client.users.cache.get(id);
							if (user) {
								mentionCache.set(id, user.displayName);
								return `${user.displayName}`;
							}

							// If not in cache, fetch the user
							const fetchedUser = await client.users
								.fetch(id)
								.catch(() => null);
							if (fetchedUser) {
								mentionCache.set(id, fetchedUser.displayName);
								return `${fetchedUser.displayName}`;
							}
						} else {
							// User not blacklisted and has custom nickname
							mentionCache.set(id, userData.user_nickname);
							return `${userData.user_nickname}`;
						}
					} catch (error) {
						log.error(`Error resolving nickname for user ${id}: ${error}`);
					}
					log.warn(`Could not resolve user mention: ${match}`);
					return match;
				}

				// --- Channel Mentions ---
				if (match.startsWith("<#")) {
					try {
						const guild = client.guilds.cache.get(serverId);
						const channel = guild?.channels.cache.get(id);
						if (channel) {
							return `#${channel.name}`;
						}
						const fetchedChannel = await client.channels
							.fetch(id)
							.catch(() => null);
						if (fetchedChannel?.isTextBased() && !fetchedChannel.isDMBased()) {
							return `#${fetchedChannel.name}`;
						}
					} catch (error) {
						log.error(`Error resolving channel mention ${id}: ${error}`);
					}
					log.warn(`Could not resolve channel mention: ${match}`);
					return match;
				}

				// --- Role Mentions ---
				if (match.startsWith("<@&")) {
					try {
						const guild = client.guilds.cache.get(serverId);
						const role = guild?.roles.cache.get(id);
						if (role) {
							return `@${role.name}`;
						}
						const fetchedRole = await guild?.roles.fetch(id).catch(() => null);
						if (fetchedRole) {
							return `@${fetchedRole.name}`;
						}
					} catch (error) {
						log.error(`Error resolving role mention ${id}: ${error}`);
					}
					log.warn(`Could not resolve role mention: ${match}`);
					return match;
				}

				return match;
			}),
		);

		// Apply replacements for Discord mentions (from end to start to avoid index issues)
		for (let i = mentions.length - 1; i >= 0; i--) {
			const { start, end } = mentions[i];
			if (start !== undefined && end !== undefined && start < end) {
				result =
					result.substring(0, start) + replacements[i] + result.substring(end);
			}
		}
	}

	result = replaceTemplateVariables(result, {
		bot: tomoriNickname,
		user: triggererName,
	});

	return result;
}

/**
 * Builds an array of context segments for the LLM prompt based on the provided data.
 * Segments are ordered based on the 'order' property.
 * @param options - Options containing data needed to build the context.
 * @param options.guildId - The Discord ID of the server (used for DB lookups).
 * @param options.serverName - The name of the Discord server.
 * @param options.serverDescription - The description of the Discord server (can be null).
 * @param options.conversationHistory - Array of recent messages as strings ("Nickname: Message content").
 * @param options.userList - Array of unique user IDs involved in the conversation history.
 * @param options.channelDesc - The description/topic of the current channel (can be null).
 * @param options.channelName - The name of the current channel.
 * @param options.client - The Discord client instance (for mention conversion).
 * @param options.triggererName - Name of the user who triggered the action.
 * @returns A promise resolving to an array of ContextSegment objects.
 */
export async function buildContext({
	guildId,
	serverName,
	serverDescription,
	conversationHistory,
	userList,
	channelDesc,
	channelName,
	client,
	triggererName,
	emojiStrings,
}: {
	guildId: string;
	serverName: string;
	serverDescription: string | null;
	conversationHistory: string[];
	userList: string[];
	channelDesc: string | null;
	channelName: string;
	client: Client;
	triggererName: string;
	emojiStrings?: string[];
}): Promise<ContextSegment[]> {
	const segments: ContextSegment[] = [];

	// 1. Load Server-Specific Bot State (TomoriState) using guildId
	const tomoriState = await loadTomoriState(guildId);
	if (!tomoriState) {
		log.error(`buildContext: Failed to load TomoriState for guild ${guildId}.`);
		throw new Error(`Failed to load server state for guild ${guildId}`);
	}
	const botName = tomoriState.tomori_nickname || "Tomori";

	// --- Segment 1: Server Description ---
	let serverInfoContent = `You are ${botName}, currently in the Discord server named "${serverName}".\n`;
	if (serverDescription)
		serverInfoContent += `${serverName}'s Description: ${serverDescription}`;
	segments.push({
		type: "preamble",
		content: serverInfoContent,
		order: 1, // Order 1
	});

	// --- Segment 2: Emojis ---
	if (emojiStrings && emojiStrings.length > 0) {
		// Declare with const inside the block to fix Biome lint error
		const emojiContent = `${serverName}'s Emojis:\n${emojiStrings.join(", ")}.`;
		const emojiUsage = `\nIn order to use ${serverName}'s Emojis, input the name and the code like such: <:name:numbercode>\nAnimated emojis require an 'a' flag in the beginning like such: <a:name:numbercode>\n`;
		segments.push({
			type: "preamble",
			content: emojiContent + emojiUsage,
			order: 2, // Order 2
		});
	}

	// --- Segment 3: Server Memories ---
	if (
		tomoriState.server_memories &&
		Array.isArray(tomoriState.server_memories) &&
		tomoriState.server_memories.length > 0
	) {
		segments.push({
			type: "memory",
			content: `\n${botName}'s Memories about ${serverName}:\n${tomoriState.server_memories.join("\n")}\n`,
			order: 3, // Order 3
		});
	}

	// --- Segment 4: Personal Memories ---
	const personalizationEnabled =
		tomoriState.config?.personal_memories_enabled ?? true;
	if (personalizationEnabled && userList.length > 0) {
		let personalMemoriesContent = "";
		log.info(
			`Building personal memories content for ${userList.length} users in guild ${guildId}`,
		);

		// First attempt to load users from database
		const userRows = await Promise.all(
			userList.map((id) =>
				loadUserRow(id).catch((e) => {
					log.warn(`buildContext: Failed to load user ${id} for memories`, e);
					return null;
				}),
			),
		);

		log.info(
			`Successfully loaded ${userRows.filter(Boolean).length}/${userList.length} user rows`,
		);

		// Process each user, registering those not found in the database
		for (let i = 0; i < userList.length; i++) {
			const userId = userList[i];
			let userRow = userRows[i];

			// If user not found in database, try to fetch from Discord and register them
			if (!userRow) {
				try {
					log.info(
						`User ${userId} not found in database, fetching from Discord and registering`,
					);
					const guild = client.guilds.cache.get(guildId);
					if (guild) {
						const member = await guild.members.fetch(userId).catch(() => null);
						if (member) {
							// Register user with our centralized function
							const serverLocale = guild.preferredLocale;
							const userLanguage = serverLocale.startsWith("ja")
								? "ja"
								: "en-US";
							userRow = await registerUser(
								userId,
								member.displayName,
								userLanguage,
							);
							log.info(
								`Successfully registered user ${userId} (${member.displayName})`,
							);
						} else {
							log.warn(`Could not fetch member ${userId} from Discord`);
						}
					}
				} catch (error) {
					log.error(
						`Error registering user ${userId} during context building:`,
						error,
					);
				}
			}

			// Skip if user is still null after registration attempt
			if (
				!userRow ||
				typeof userRow.user_id !== "number" ||
				!userRow.user_disc_id
			) {
				log.warn(
					`Skipping invalid user row for ${userId}: ${JSON.stringify(userRow)}`,
				);
				continue;
			}

			// Use the imported isBlacklisted function
			const userBlacklisted = await isBlacklisted(
				guildId,
				userRow.user_disc_id,
			);

			log.info(`User ${userRow.user_disc_id} blacklisted: ${userBlacklisted}`);

			if (!userBlacklisted) {
				const userNickname = userRow.user_nickname || userRow.user_disc_id;
				log.info(`Processing user ${userNickname} (${userRow.user_disc_id})`);

				// Get the user's current presence and activity information regardless of memories
				const presenceInfo = await getUserPresenceDetails(
					client,
					userRow.user_disc_id,
					guildId,
				);

				log.info(`Got presence for ${userNickname}: "${presenceInfo}"`);

				// Add any personal memories if they exist
				if (userRow.personal_memories && userRow.personal_memories.length > 0) {
					log.info(
						`Adding ${userRow.personal_memories.length} memories for ${userNickname}`,
					);
					personalMemoriesContent += `${botName}'s Memories about ${userNickname}:\n${userRow.personal_memories.join("\n")}\n`;
				} else {
					log.info(`No personal memories found for ${userNickname}`);
				}

				// Always add status information for non-blacklisted users
				log.info(`Adding status information for ${userNickname}`);
				personalMemoriesContent += `${userNickname}'s current status: ${presenceInfo}\n\n`;
			}
		}

		if (personalMemoriesContent) {
			log.info(
				`Adding personal memories segment with ${personalMemoriesContent.length} characters`,
			);
			log.info(
				`Personal memories: ${personalMemoriesContent.substring(0, 100)}...`,
			);
			segments.push({
				type: "memory",
				content: personalMemoriesContent.trim(),
				order: 4, // Order 4
			});
		} else {
			log.warn(`No personal memories content generated for guild ${guildId}`);
		}
	} else {
		log.info(
			`Skipping personal memories: personalization enabled: ${personalizationEnabled}, user count: ${userList.length}`,
		);
	}

	// --- Segment 5: Current Context (Time, Channel) ---
	let currentContextContent = `\nCurrent Time: ${getCurrentTime()}.\n${botName} is currently in text channel #${channelName}.`;
	if (channelDesc) {
		currentContextContent += `\n${channelName}'s Description: ${channelDesc}\n`;
	}
	segments.push({
		type: "preamble",
		content: currentContextContent,
		order: 5, // Order 5
	});

	// --- Segment 6: Sample Dialogues ---
	if (
		tomoriState.sample_dialogues_in.length > 0 &&
		tomoriState.sample_dialogues_out.length > 0 &&
		tomoriState.sample_dialogues_in.length ===
			tomoriState.sample_dialogues_out.length
	) {
		let sampleContent = "";
		for (let i = 0; i < tomoriState.sample_dialogues_in.length; i++) {
			sampleContent += `\n${triggererName}: ${tomoriState.sample_dialogues_in[i]}\n${tomoriState.tomori_nickname}: ${tomoriState.sample_dialogues_out[i]}`;
		}

		if (tomoriState.config.humanizer_degree >= 3)
			sampleContent = humanizeString(sampleContent);
		segments.push({
			type: "sample",
			content: sampleContent.trim(),
			order: 6, // Order 6
		});
	}

	// --- Segment 7: Conversation History ---
	if (conversationHistory.length > 0) {
		let historyString = conversationHistory.join("\n");

		if (tomoriState.config.humanizer_degree >= 3)
			historyString = humanizeString(historyString);
		segments.push({
			type: "history",
			content: `${historyString}\n${botName}:`,
			order: 7, // Order 7
		});
	}

	// Sort segments by order before finalizing
	segments.sort((a, b) => a.order - b.order);

	// Now we process all segments at once with convertMentions
	// This is much more efficient than processing each segment individually
	const processedSegments = await Promise.all(
		segments.map(async (segment) => {
			return {
				...segment,
				content: await convertMentions(
					segment.content,
					client,
					guildId,
					triggererName,
				),
			};
		}),
	);

	log.info(
		`Built ${processedSegments.length} context segments for guild ${guildId}.`,
	);
	return processedSegments;
}

/**
 * Fetches a user's current presence and activity information
 * @param client - Discord client for presence lookups
 * @param userId - Discord user ID to fetch presence for
 * @param guildId - Discord guild ID where the user is active
 * @returns A formatted string describing user's status and activities
 */
async function getUserPresenceDetails(
	client: Client,
	userId: string,
	guildId: string,
): Promise<string> {
	try {
		log.info(`Fetching presence data for user ${userId} in guild ${guildId}`);

		// 1. Try to get the guild and member objects
		const guild = client.guilds.cache.get(guildId);
		if (!guild) {
			log.warn(`Guild ${guildId} not found in cache when fetching presence`);
			return "Status unknown";
		}

		// 2. Attempt to get the member with presence data
		// Note: This requires GUILD_PRESENCES intent to be enabled
		log.info(`Fetching member data for ${userId} in guild ${guild.name}`);
		const member = await guild.members
			.fetch({ user: userId, force: true })
			.catch((error) => {
				log.warn(`Failed to fetch member ${userId}: ${error.message}`);
				return null;
			});

		if (!member) {
			log.warn(`Member ${userId} not found in guild ${guild.name}`);
			return "Offline or status unknown";
		}

		log.info(`Member found: ${member.displayName} (${member.id})`);

		if (!member.presence) {
			log.warn(
				`No presence data available for ${member.displayName} (${member.id})`,
			);
			log.info(
				`Presence permission check: GUILD_PRESENCES intent enabled: ${Boolean(client.options.intents?.has(GatewayIntentBits.GuildPresences))}`,
			);
			return "Offline or status unknown";
		}

		// 3. Format the base status
		const statusMap: Record<PresenceStatus, string> = {
			online: "Online",
			idle: "Away/Idle",
			dnd: "Do Not Disturb",
			offline: "Offline",
			invisible: "Invisible",
		};

		const status = statusMap[member.presence.status] || "Status unknown";
		let result = status;

		log.info(`User ${member.displayName} status: ${status}`);

		// 4. Format activities if present
		if (member.presence.activities && member.presence.activities.length > 0) {
			log.info(
				`User ${member.displayName} has ${member.presence.activities.length} activities`,
			);

			const activityDetails = member.presence.activities.map((activity) => {
				log.info(
					`Activity found: ${activity.type} - ${activity.name} - Details: ${activity.details || "none"} - State: ${activity.state || "none"}`,
				);

				// Build activity description based on type
				switch (activity.type) {
					case 0: // Playing
						return `Playing ${activity.name}${activity.details ? ` (${activity.details})` : ""}${getTimeSpent(activity.timestamps?.start, activity.timestamps?.end)}`;
					case 1: // Streaming
						return `Streaming ${activity.name}${getTimeSpent(activity.timestamps?.start, activity.timestamps?.end)}`;
					case 2: // Listening
						if (
							activity.name === "Spotify" &&
							activity.details &&
							activity.state
						) {
							return `Listening to ${activity.details} by ${activity.state} on Spotify${getTimeSpent(activity.timestamps?.start, activity.timestamps?.end)}`;
						}

						if (activity.details && activity.state) {
							return `Listening to ${activity.state} by ${activity.details} on ${activity.name}${getTimeSpent(activity.timestamps?.start, activity.timestamps?.end)}`;
						}
						return `Listening to ${activity.name}${getTimeSpent(activity.timestamps?.start, activity.timestamps?.end)}`;
					case 3: // Watching
						return `Watching ${activity.name}${getTimeSpent(activity.timestamps?.start, activity.timestamps?.end)}`;
					case 4: // Custom Status
						return activity.state || "Custom status";
					case 5: // Competing
						return `Competing in ${activity.name}${getTimeSpent(activity.timestamps?.start, activity.timestamps?.end)}`;
					default:
						return activity.name;
				}
			});

			result += ` - ${activityDetails.join(", ")}`;
			log.info(`Final presence string: "${result}"`);
		} else {
			log.info(`User ${member.displayName} has no activities`);
		}

		return result;
	} catch (error) {
		log.error(`Error getting presence for user ${userId}:`, error);
		return "Status unknown";
	}
}

/**
 * Formats time spent on an activity based on start and end timestamps
 * @param startTimestamp - The activity start timestamp (as Date or number)
 * @param endTimestamp - The activity end timestamp (as Date or number, optional)
 * @returns Formatted string with time duration (e.g., "2 hours, 15 minutes")
 */
function getTimeSpent(
	startTimestamp?: Date | null | number,
	endTimestamp?: Date | null | number,
): string {
	if (!startTimestamp) {
		return "";
	}

	// Convert Date objects to timestamps if needed
	const startTime =
		startTimestamp instanceof Date
			? startTimestamp.getTime()
			: typeof startTimestamp === "number"
				? startTimestamp
				: 0;

	// If no valid start time, return empty string
	if (startTime === 0) {
		return "";
	}

	// If no end timestamp is provided, use current time
	const now = Date.now();
	const endTime =
		endTimestamp instanceof Date
			? endTimestamp.getTime()
			: typeof endTimestamp === "number"
				? endTimestamp
				: now;

	// Calculate time difference in milliseconds
	const timeDiff = endTime - startTime;

	// Convert to hours, minutes, seconds
	const seconds = Math.floor((timeDiff / 1000) % 60);
	const minutes = Math.floor((timeDiff / (1000 * 60)) % 60);
	const hours = Math.floor(timeDiff / (1000 * 60 * 60));

	// Format the time spent string
	let timeSpent = "";

	if (hours > 0) {
		timeSpent += `${hours} hour${hours !== 1 ? "s" : ""}`;
	}

	if (minutes > 0) {
		if (timeSpent) timeSpent += ", ";
		timeSpent += `${minutes} minute${minutes !== 1 ? "s" : ""}`;
	}

	if (seconds > 0 && hours === 0) {
		// Only show seconds if less than an hour
		if (timeSpent) timeSpent += ", ";
		timeSpent += `${seconds} second${seconds !== 1 ? "s" : ""}`;
	}

	return timeSpent ? ` for ${timeSpent}` : "";
}
