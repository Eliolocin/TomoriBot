import type { Client, PresenceStatus } from "discord.js";
import { GatewayIntentBits } from "discord.js";
import {
	isBlacklisted, // Import blacklist checker
	loadTomoriState,
	loadUserRow,
} from "../db/dbRead"; // Import session helpers
import {
	ContextItemTag,
	type ContextPart, // New: For text/image parts
	type StructuredContextItem, // New: The main output type
} from "../../types/misc/context";
import { registerUser } from "../db/dbWrite";
import { log } from "../misc/logger";
import {
	replaceTemplateVariables,
	getCurrentTime,
	humanizeString,
} from "./stringHelper";
import { HumanizerDegree, type TomoriConfigRow } from "@/types/db/schema";
// Import ServerEmojiRow if needed for emoji query result type
// import type { ServerEmojiRow } from "../../types/db/schema";

/**
 * Maps userId -> nickname for the current mention replacement operation.
 * @remarks This cache is cleared after each text processing run to avoid stale data.
 */
const mentionCache = new Map<string, string>();
const MAX_LOADED_EMOJIS = 10;

const HUMANIZE_INSTRUCTION =
	"\n{bot} limits themselves to only 0 to 2 emojis per response ({bot} prefers to use available server emojis than normal emojis) and makes sure to respond short and concisely, as {bot} is aware that no one really likes to read walls of text. {bot} only makes lengthy responses if and only if people are asking for assistance or an explanation that warrants it.";

/**
 * Simplified message structure received from tomoriChat.ts.
 * This is an internal representation before converting to StructuredContextItem.
 */
type SimplifiedMessageForContext = {
	authorId: string;
	authorName: string;
	content: string | null;
	imageAttachments: Array<{
		url: string;
		proxyUrl: string;
		mimeType: string | null;
		filename: string;
	}>;
	videoAttachments: Array<{
		url: string;
		proxyUrl: string;
		mimeType: string | null;
		filename: string;
		isYouTubeLink: boolean;
	}>;
};

/**
 * Converts Discord mention IDs to human-readable names using cached database lookups.
 * Also handles special placeholders like {user} and {bot}.
 * Checks for custom user nicknames first, falls back to Discord usernames.
 * @param text - Text containing Discord mention strings or placeholders
 * @param client - Discord client for user/role lookups
 * @param serverId - Discord server ID for context
 * @param triggererName - Name of the user who triggered the action (for {user} replacement)
 * @param tomoriNickname - The bot's current nickname for {bot} replacement.
 * @param personalMemoriesEnabled - Whether server personalization is enabled (affects custom nickname usage)
 * @returns Text with mentions and placeholders replaced by human-readable names
 */
export async function convertMentions(
	text: string,
	client: Client,
	serverId: string,
	triggererName?: string,
	tomoriNickname?: string, // Added tomoriNickname parameter
	personalMemoriesEnabled?: boolean, // Added personalMemoriesEnabled parameter
): Promise<string> {
	// Clear the cache before processing new text
	mentionCache.clear();

	// 1. Determine Tomori's nickname for {bot} replacement.
	//    If not passed, load it. If passed, use the provided one.
	let currentTomoriNickname = tomoriNickname;
	if (!currentTomoriNickname) {
		const tomoriState = await loadTomoriState(serverId);
		currentTomoriNickname =
			tomoriState?.tomori_nickname || process.env.DEFAULT_BOTNAME || "Tomori";
	}

	// 2. First handle Discord mentions
	const mentionPattern = /<[@#][!&]?(\d{17,19})>/g;
	const matches = Array.from(text.matchAll(mentionPattern));
	let result = text;

	// 3. Process Discord mentions
	if (matches.length > 0) {
		const mentionsData = matches.map((match) => ({
			match: match[0],
			id: match[1],
			start: match.index ?? 0,
			end: (match.index ?? 0) + match[0].length,
		}));

		const replacements = await Promise.all(
			mentionsData.map(async ({ match, id }) => {
				// --- User Mentions ---
				if (match.startsWith("<@")) {
					const cachedName = mentionCache.get(id);
					if (cachedName) return `${cachedName}`;
					try {
						// Check if this is Tomori herself
						if (client.user && id === client.user.id && currentTomoriNickname) {
							mentionCache.set(id, currentTomoriNickname);
							return `${currentTomoriNickname}`;
						}

						const isUserBlacklisted = await isBlacklisted(serverId, id);
						const userData = await loadUserRow(id);
						const serverPersonalizationDisabled =
							personalMemoriesEnabled === false;

						// Use Discord username if user is blacklisted OR server personalization is disabled OR no custom nickname exists
						if (
							isUserBlacklisted ||
							serverPersonalizationDisabled ||
							!userData?.user_nickname
						) {
							const user =
								client.users.cache.get(id) ||
								(await client.users.fetch(id).catch(() => null));
							if (user) {
								mentionCache.set(id, user.username);
								return `${user.username}`;
							}
						} else {
							// Use custom nickname only if user is not blacklisted AND personalization is enabled
							mentionCache.set(id, userData.user_nickname);
							return `${userData.user_nickname}`;
						}
					} catch (error) {
						log.error(
							`Error resolving nickname for user ${id} in convertMentions:`,
							error,
							{ serverId, metadata: { userIdToResolve: id } },
						);
					}
					log.warn(`Could not resolve user mention: ${match}`);
					return match; // Return original mention if resolution fails
				}

				// --- Channel Mentions ---
				if (match.startsWith("<#")) {
					try {
						const guild = client.guilds.cache.get(serverId);
						const channel =
							guild?.channels.cache.get(id) ||
							(await client.channels.fetch(id).catch(() => null));
						if (channel?.isTextBased() && !channel.isDMBased()) {
							return `#${channel.name}`;
						}
					} catch (error) {
						log.error(
							`Error resolving channel mention ${id} in convertMentions:`,
							error,
							{ serverId, metadata: { channelIdToResolve: id } },
						);
					}
					log.warn(`Could not resolve channel mention: ${match}`);
					return match;
				}

				// --- Role Mentions ---
				if (match.startsWith("<@&")) {
					try {
						const guild = client.guilds.cache.get(serverId);
						const role =
							guild?.roles.cache.get(id) ||
							(await guild?.roles.fetch(id).catch(() => null));
						if (role) {
							return `@${role.name}`;
						}
					} catch (error) {
						log.error(
							`Error resolving role mention ${id} in convertMentions:`,
							error,
							{ serverId, metadata: { roleIdToResolve: id } },
						);
					}
					log.warn(`Could not resolve role mention: ${match}`);
					return match;
				}
				return match; // Should not happen if regex is correct
			}),
		);

		// 4. Apply replacements for Discord mentions (from end to start to avoid index issues)
		for (let i = mentionsData.length - 1; i >= 0; i--) {
			const { start, end } = mentionsData[i];
			// Ensure start and end are valid before attempting substring
			if (
				typeof start === "number" &&
				typeof end === "number" &&
				start < end &&
				start < result.length &&
				end <= result.length
			) {
				result =
					result.substring(0, start) + replacements[i] + result.substring(end);
			} else {
				log.warn(
					`Invalid mention indices for replacement: start=${start}, end=${end}, match=${mentionsData[i].match}`,
				);
			}
		}
	}

	// 5. Apply template variable replacements (like {bot} and {user})
	// Ensure triggererName is defined, default to "User" if not.
	const finalTriggererName = triggererName || "User";
	result = replaceTemplateVariables(result, {
		bot: currentTomoriNickname,
		user: finalTriggererName,
	});

	return result;
}
export async function buildContext({
	guildId,
	serverName,
	serverDescription,
	simplifiedMessageHistory,
	userList,
	channelDesc,
	channelName,
	client,
	triggererName,
	emojiStrings,
	tomoriNickname,
	tomoriAttributes,
	tomoriConfig,
	isDMChannel = false,
}: {
	guildId: string;
	serverName: string;
	serverDescription: string | null;
	simplifiedMessageHistory: SimplifiedMessageForContext[];
	userList: string[];
	channelDesc: string | null;
	channelName: string;
	client: Client;
	triggererName: string;
	emojiStrings?: string[];
	tomoriNickname: string;
	tomoriAttributes: string[];
	tomoriConfig: TomoriConfigRow;
	isDMChannel?: boolean; // Added for DM support
}): Promise<StructuredContextItem[]> {
	const contextItems: StructuredContextItem[] = [];
	const botName = tomoriNickname;

	// 1. System Instruction (Tomori's Personality and Humanizer)
	// This will be expanded in Phase 2 to include all non-dialogue context.
	// For now, it's just personality and humanizer rules.
	let personalityInstructionText = tomoriAttributes.join("\n");
	if (tomoriConfig.humanizer_degree >= HumanizerDegree.LIGHT) {
		personalityInstructionText += HUMANIZE_INSTRUCTION;
	}
	personalityInstructionText = await convertMentions(
		personalityInstructionText,
		client,
		guildId,
		triggererName,
		botName,
		tomoriConfig.personal_memories_enabled,
	);
	personalityInstructionText += `\nWhen ${botName} wants to mention and ping a specific user in their response, they MUST use the format <@USER_DISCORD_ID> (e.g., <@123456789012345678>). The USER_DISCORD_ID can be found in the user's status block in this context (e.g., "Nickname (User ID: 123...)"). This ensures the user gets a notification.`;

	contextItems.push({
		role: "system",
		parts: [{ type: "text", text: personalityInstructionText }],
		metadataTag: ContextItemTag.SYSTEM_PERSONALITY, // Tagging for personality
	});

	// --- Preamble/Knowledge Base Segments ---
	// These will be consolidated into the system prompt in Phase 2.
	// For now, they are tagged individually.

	// 2. Server Description
	let serverInfoContent = `# Knowledge Base\n${botName} is currently in the Discord server named "${serverName}".\n`;
	if (serverDescription) {
		serverInfoContent += `## ${serverName}'s Description\n${serverDescription}`;
	}
	contextItems.push({
		role: "system",
		parts: [
			{
				type: "text",
				text: await convertMentions(
					serverInfoContent,
					client,
					guildId,
					triggererName,
					botName,
					tomoriConfig.personal_memories_enabled,
				),
			},
		],
		metadataTag: ContextItemTag.KNOWLEDGE_SERVER_INFO, // Tagging
	});

	// 3. Emojis
	if (emojiStrings && emojiStrings.length > 0) {
		// 1. Shuffle the emoji array to randomize selection
		const shuffledEmojis = [...emojiStrings].sort(() => Math.random() - 0.5);

		// 2. Limit emojis to prevent context bloat
		const maxEmojis = MAX_LOADED_EMOJIS;
		const selectedEmojis = shuffledEmojis.slice(
			0,
			Math.min(maxEmojis, shuffledEmojis.length),
		);

		const emojiContent = `## ${serverName}'s Emojis\n- ${selectedEmojis.join("\n- ")}.`;
		const emojiUsage = `\nIn order to use ${serverName}'s Emojis, input the name and the code like such: <:name:numbercode>\nAnimated emojis require an 'a' flag in the beginning like such: <a:name:numbercode>\n`;
		contextItems.push({
			role: "system",
			parts: [
				{
					type: "text",
					text: await convertMentions(
						emojiContent + emojiUsage,
						client,
						guildId,
						triggererName,
						botName,
						tomoriConfig.personal_memories_enabled,
					),
				},
			],
			metadataTag: ContextItemTag.KNOWLEDGE_SERVER_EMOJIS, // Tagging
		});
	}

	// 4. Stickers (only available in guild channels, not DMs)
	if (tomoriConfig.sticker_usage_enabled && !isDMChannel) {
		const guild = client.guilds.cache.get(guildId);
		const serverStickers = guild?.stickers.cache;
		if (serverStickers && serverStickers.size > 0) {
			let stickerContent = `## ${serverName}'s Stickers\nThis server has the following stickers available for ${botName} to use with the 'select_sticker_for_response' function:\n`;
			for (const sticker of serverStickers.values()) {
				stickerContent += `- Name: "${sticker.name}", ID: "${sticker.id}"${sticker.description ? `, Description/Usage: "${sticker.description}"` : ""}\n`;
			}
			stickerContent += `To use a sticker, the 'select_sticker_for_response' function should be called with the exact 'sticker_id' of the desired sticker.\n`;
			contextItems.push({
				role: "system",
				parts: [
					{
						type: "text",
						text: await convertMentions(
							stickerContent,
							client,
							guildId,
							triggererName,
							botName,
							tomoriConfig.personal_memories_enabled,
						),
					},
				],
				metadataTag: ContextItemTag.KNOWLEDGE_SERVER_STICKERS, // Tagging
			});
		}
	}

	// 5. Server Memories
	const tomoriState = await loadTomoriState(guildId);
	if (
		tomoriState?.server_memories &&
		Array.isArray(tomoriState.server_memories) &&
		tomoriState.server_memories.length > 0
	) {
		const serverMemoriesText = `\n## ${botName}'s Memories about ${serverName}\n${tomoriState.server_memories.join("\n")}\n`;
		contextItems.push({
			role: "system",
			parts: [
				{
					type: "text",
					text: await convertMentions(
						serverMemoriesText,
						client,
						guildId,
						triggererName,
						botName,
						tomoriConfig.personal_memories_enabled,
					),
				},
			],
			metadataTag: ContextItemTag.KNOWLEDGE_SERVER_MEMORIES, // Tagging
		});
	}

	// 6. User Context (Status & Conditional Personal Memories)
	// This section will now always try to add user status for users in userList.
	// Personal memories will only be added if server personalization is enabled AND the specific user is not blacklisted.
	if (userList.length > 0) {
		// MODIFIED: Loop if there are users, status is always relevant.
		let combinedUserContextText = ""; // MODIFIED: Renamed for clarity
		log.info(
			`Building user context (status and conditional memories) for ${userList.length} users in guild ${guildId}`,
		);

		// First attempt to load users from database
		const userRowsAttempt = await Promise.all(
			// Renamed for clarity
			userList.map((id) =>
				loadUserRow(id).catch(() => {
					log.warn(`buildContext: Failed to load user ${id} initially`);
					return null; // Return null on error to continue processing others
				}),
			),
		);

		log.info(
			`Initial load attempt: ${userRowsAttempt.filter(Boolean).length}/${userList.length} user rows from DB.`,
		);

		// Process each user, registering those not found or failed to load initially
		for (const userIdToProcess of userList) {
			let userRow =
				userRowsAttempt.find((u) => u?.user_disc_id === userIdToProcess) ||
				null;

			// Always try to fetch member for server nickname, regardless of registration status
			const guild = client.guilds.cache.get(guildId);
			let member = null;
			if (guild) {
				member = await guild.members.fetch(userIdToProcess).catch(() => null);
			}

			if (!userRow) {
				// If user not found in initial batch load (or failed), try to register them
				try {
					log.info(
						`User ${userIdToProcess} not found in initial DB load, attempting to fetch from Discord and register.`,
					);
					if (guild && member) {
						const serverLocale = guild.preferredLocale;
						const userLanguage = serverLocale.startsWith("ja") ? "ja" : "en-US";
						userRow = await registerUser(
							// This will UPSERT
							userIdToProcess,
							member.user.username, // Base username for registration
							userLanguage,
						);
						if (userRow) {
							log.info(
								`Successfully registered/loaded user ${userIdToProcess} (${member.user.username}) after fetch.`,
							);
						} else {
							log.warn(
								`Failed to register user ${userIdToProcess} after fetching from Discord.`,
							);
						}
					} else {
						log.warn(
							`Could not fetch member ${userIdToProcess} from Discord for registration.`,
						);
					}
				} catch (error) {
					await log.error(
						`Error registering user ${userIdToProcess} during context building:`,
						error,
						{
							serverId: guildId,
							errorType: "UserRegistrationError",
						},
					);
				}
			}

			if (
				!userRow || // Check if userRow is still null or invalid
				typeof userRow.user_id !== "number" ||
				!userRow.user_disc_id
			) {
				log.warn(
					`Skipping user context for ${userIdToProcess} due to invalid/missing user data after all attempts. UserRow: ${JSON.stringify(userRow)}`,
				);
				continue; // Skip to the next user if userRow is still not valid
			}

			// At this point, userRow is considered valid.
			const userDiscordId = userRow.user_disc_id;

			// Format nickname to include both custom nickname and server nickname
			let displayName: string;
			const customNickname = userRow.user_nickname;
			const serverNickname = member?.nickname;

			if (customNickname) {
				// Use custom nickname as base, add server nickname if it exists
				displayName = serverNickname
					? `${customNickname} (Server Nickname: "${serverNickname}")`
					: customNickname;
			} else if (serverNickname) {
				// No custom nickname but has server nickname
				displayName = serverNickname;
			} else {
				// No custom or server nickname, fallback to mention format
				displayName = `<@${userRow.user_disc_id}>`;
			}
			const nickname = displayName;

			let userSpecificContent = "";

			// 6.a. Add Personal Memories (conditionally)
			const serverPersonalizationEnabled =
				tomoriConfig.personal_memories_enabled ?? true;
			const userIsBlacklisted = await isBlacklisted(
				guildId,
				userRow.user_disc_id,
			);

			log.info(
				`User ${userDiscordId}: Server Personalization Enabled: ${serverPersonalizationEnabled}, User Blacklisted: ${userIsBlacklisted}`,
			);

			if (serverPersonalizationEnabled && !userIsBlacklisted) {
				if (userRow.personal_memories && userRow.personal_memories.length > 0) {
					// Process personal memories with the memory owner's name for {user} token replacement
					const processedMemories = await Promise.all(
						userRow.personal_memories.map((memory) =>
							convertMentions(
								memory,
								client,
								guildId,
								nickname, // Use the memory owner's name, not the triggerer's name
								botName,
								tomoriConfig.personal_memories_enabled,
							),
						),
					);
					userSpecificContent += `## ${botName}'s Memories about ${nickname} (User ID: ${userDiscordId})\n${processedMemories.join("\n")}\n`;
				}
			} else {
				if (!serverPersonalizationEnabled) {
					log.info(
						`Personal memories omitted for ${userDiscordId}: Server personalization is disabled.`,
					);
				}
				if (userIsBlacklisted) {
					log.info(
						`Personal memories omitted for ${userDiscordId}: User is blacklisted.`,
					);
				}
			}

			// 6.b. Add User Status (always, if userRow is valid)
			// For DMs, presence information is not available since there's no guild context
			const presenceInfo = isDMChannel
				? "Online (Direct Message)" // Simple fallback for DMs
				: await getUserPresenceDetails(client, userRow.user_disc_id, guildId);
			userSpecificContent += `### ${nickname} (User ID: ${userDiscordId})'s current status\n${presenceInfo}\n\n`;
			combinedUserContextText += userSpecificContent;
		}

		if (combinedUserContextText) {
			contextItems.push({
				role: "system",
				parts: [
					{
						type: "text",
						text: await convertMentions(
							combinedUserContextText.trim(), // MODIFIED: Use new variable
							client,
							guildId,
							triggererName,
							botName,
							tomoriConfig.personal_memories_enabled,
						),
					},
				],
				metadataTag: ContextItemTag.KNOWLEDGE_USER_MEMORIES, // MODIFIED: More generic tag
			});
		} else {
			log.warn(
				`No user context (status/memories) content generated for guild ${guildId}`,
			);
		}
	} else {
		log.info(
			"Skipping user context section: userList is empty.", // MODIFIED: Updated log message
		);
	}
	// 7. Current Context (Time, Channel)
	let currentContextContent = `\n# Current Context\nCurrent Time: ${getCurrentTime()}.\n${botName} is currently in text channel #${channelName}.`;
	if (channelDesc) {
		currentContextContent += ` ${channelDesc}\n`;
	}
	contextItems.push({
		role: "system",
		parts: [
			{
				type: "text",
				text: await convertMentions(
					currentContextContent,
					client,
					guildId,
					triggererName,
					botName,
					tomoriConfig.personal_memories_enabled,
				),
			},
		],
		metadataTag: ContextItemTag.KNOWLEDGE_CURRENT_CONTEXT, // Tagging
	});

	if (
		tomoriState &&
		tomoriState.sample_dialogues_in.length > 0 &&
		tomoriState.sample_dialogues_out.length > 0 &&
		tomoriState.sample_dialogues_in.length ===
			tomoriState.sample_dialogues_out.length
	) {
		// 8. Sample Dialogues (Request 3: Changed to alternating user/model turns)
		// biome-ignore lint/style/noNonNullAssertion: tomoriState is checked above
		for (let i = 0; i < tomoriState!.sample_dialogues_in.length; i++) {
			// 8.a. User's part of the sample dialogue
			// biome-ignore lint/style/noNonNullAssertion: tomoriState is checked above
			let userSampleText = tomoriState!.sample_dialogues_in[i];
			// Prepend a generic "User:" for sample dialogues, or use triggererName if preferred.
			userSampleText = `${triggererName}: ${userSampleText}`; // Or `${triggererName}: ${userSampleText}`
			if (tomoriConfig.humanizer_degree >= HumanizerDegree.HEAVY) {
				userSampleText = humanizeString(userSampleText);
			}
			contextItems.push({
				role: "user",
				parts: [
					{
						type: "text",
						text: await convertMentions(
							userSampleText,
							client,
							guildId,
							triggererName, // triggererName for {user} if it appears in sample
							botName,
							tomoriConfig.personal_memories_enabled,
						),
					},
				],
				metadataTag: ContextItemTag.DIALOGUE_SAMPLE, // Tagging
			});

			// 8.b. Bot's part of the sample dialogue
			// biome-ignore lint/style/noNonNullAssertion: tomoriState is checked above
			let modelSampleText = tomoriState!.sample_dialogues_out[i];
			modelSampleText = `${botName}: ${modelSampleText}`; // Prepend bot's name
			if (tomoriConfig.humanizer_degree >= HumanizerDegree.HEAVY) {
				modelSampleText = humanizeString(modelSampleText);
			}
			contextItems.push({
				role: "model",
				parts: [
					{
						type: "text",
						text: await convertMentions(
							modelSampleText,
							client,
							guildId,
							triggererName,
							botName, // botName for {bot} if it appears in sample
							tomoriConfig.personal_memories_enabled,
						),
					},
				],
				metadataTag: ContextItemTag.DIALOGUE_SAMPLE, // Tagging
			});
		}
	}

	// 9. Conversation History (Main Dialogue)
	for (const msg of simplifiedMessageHistory) {
		const role = msg.authorId === client.user?.id ? "model" : "user";
		const parts: ContextPart[] = [];
		// 9.a. Add image parts if attachments exist
		for (const attachment of msg.imageAttachments) {
			if (attachment.mimeType) {
				parts.push({
					type: "image",
					uri: attachment.proxyUrl,
					mimeType: attachment.mimeType,
				});
			} else {
				log.warn(
					`Skipping image attachment due to missing mimeType: ${attachment.filename} from user ${msg.authorName}`,
				);
			}
		}

		// 9.b. Add video parts if attachments exist
		for (const attachment of msg.videoAttachments) {
			if (attachment.mimeType) {
				parts.push({
					type: "video",
					uri: attachment.isYouTubeLink ? attachment.url : attachment.proxyUrl,
					mimeType: attachment.mimeType,
					isYouTubeLink: attachment.isYouTubeLink,
				});
			} else {
				log.warn(
					`Skipping video attachment due to missing mimeType: ${attachment.filename} from user ${msg.authorName}`,
				);
			}
		}

		// 9.c. Add text part if content exists
		if (msg.content) {
			// Request 4: Prepend speaker name to content
			let processedContent = `${msg.authorName}: ${msg.content}`;

			if (
				tomoriConfig.humanizer_degree >= HumanizerDegree.HEAVY &&
				role === "model"
			) {
				processedContent = humanizeString(processedContent);
			}
			// convertMentions will handle {user} and {bot} replacements.
			// The {user} in convertMentions will refer to msg.authorName if it's a user message.
			processedContent = await convertMentions(
				processedContent,
				client,
				guildId,
				msg.authorName, // Pass the actual author of this historical message
				botName,
				tomoriConfig.personal_memories_enabled,
			);
			parts.push({ type: "text", text: processedContent });
		}

		if (parts.length > 0) {
			contextItems.push({
				role,
				parts,
				metadataTag: ContextItemTag.DIALOGUE_HISTORY, // Tagging
			});
		}
	}

	log.info(
		`Built ${contextItems.length} structured context items for guild ${guildId}.`,
	);
	return contextItems;
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
				log.warn(`Failed to fetch member ${userId}: ${error}`);
				return null;
			});

		if (!member) {
			log.warn(`Member ${userId} not found in guild ${guild.name}`);
			return "Offline or status unknown";
		}

		log.info(`Member found: ${member.user.username} (${member.id})`);

		if (!member.presence) {
			log.warn(
				`No presence data available for ${member.user.username} (${member.id})`,
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

		log.info(`User ${member.user.username} status: ${status}`);

		// 4. Format activities if present
		if (member.presence.activities && member.presence.activities.length > 0) {
			log.info(
				`User ${member.user.username} has ${member.presence.activities.length} activities`,
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
			log.info(`User ${member.user.username} has no activities`);
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
