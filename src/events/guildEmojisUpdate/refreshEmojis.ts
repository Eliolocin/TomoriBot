import { type Client, type Guild, GuildEmoji } from "discord.js"; // Import GuildEmoji
import { sql } from "bun";
import type { EventFunction, EventArg } from "../../types/discord/global"; // Rule 14
import type { ErrorContext } from "../../types/db/schema"; // Rule 14
import { serverEmojiSchema } from "../../types/db/schema"; // Rule 6, Use serverEmojiSchema
import { log } from "../../utils/misc/logger"; // Rule 18

/**
 * Rule 1: JSDoc comment for exported function
 * Handles emoji create, delete, and update events by refreshing the guild's emoji list in the database.
 * @param _client - Discord client instance (unused)
 * @param args - Event arguments (expected: GuildEmoji or [GuildEmoji, GuildEmoji])
 */
const handleGuildEmojisUpdate: EventFunction = async (
	_client: Client,
	...args: EventArg[]
): Promise<void> => {
	// 1. Identify the GuildEmoji and Guild from the event arguments
	// The first argument should always be a GuildEmoji object for these events
	const emoji = args[0];
	if (!(emoji instanceof GuildEmoji) || !emoji.guild) {
		log.warn(
			"guildEmojisUpdate event triggered without a valid GuildEmoji or Guild.",
			{ args },
		);
		return; // Cannot proceed without guild info
	}
	const guild: Guild = emoji.guild;
	log.info(`Emoji change detected in guild: ${guild.name} (${guild.id})`);

	let serverId: number | undefined; // Variable to hold the internal server ID

	try {
		// 2. Check if server is registered and get internal server_id (Rule 4, 16)
		const [serverRow] = await sql`
            SELECT server_id
            FROM servers
            WHERE server_disc_id = ${guild.id}
            LIMIT 1
        `;

		if (!serverRow || !serverRow.server_id) {
			log.warn(
				`Received emoji update for guild ${guild.id} but server is not registered in DB. Skipping refresh.`,
			);
			return; // Server not setup, nothing to refresh
		}
		// biome-ignore lint/style/noNonNullAssertion: Row existence guarantees server_id is present (Rule 8)
		serverId = serverRow.server_id!; // Assign the found server ID

		// 3. Fetch the current complete list of emojis from the guild cache
		const currentEmojis = Array.from(guild.emojis.cache.values());
		log.info(
			`Found ${currentEmojis.length} emojis in cache for guild ${guild.id}. Refreshing DB...`,
		);

		// 4. Perform database update within a transaction (Rule 15)
		await sql.transaction(async (tx) => {
			// 4a. Delete all existing emojis for this server
			const { rowCount: deletedCount } = await tx`
                DELETE FROM server_emojis
                WHERE server_id = ${serverId}
            `;
			log.info(
				`Deleted ${deletedCount} existing emoji entries for server ${serverId}.`,
			);

			// 4b. Map current emojis to database format
			const emojiValues = currentEmojis.map((e) => ({
				emoji_disc_id: e.id,
				emoji_name: e.name ?? "", // Use name, default to empty string if null
				emotion_key: "unset", // Default emotion key, can be updated later
				is_animated: e.animated ?? false, // Use animated property
			}));

			// 4c. Insert the current emojis (similar to setupServer logic)
			let insertedCount = 0;
			for (const {
				emoji_disc_id,
				emoji_name,
				emotion_key,
				is_animated,
			} of emojiValues) {
				const [row] = await tx`
                    INSERT INTO server_emojis (
                        server_id,
                        emoji_disc_id,
                        emoji_name,
                        emotion_key,
                        is_animated
                        -- is_global defaults to false in DB schema
                    ) VALUES (
                        ${serverId},
                        ${emoji_disc_id},
                        ${emoji_name},
                        ${emotion_key},
                        ${is_animated}
                    )
                    ON CONFLICT (server_id, emoji_disc_id) DO NOTHING -- Avoid errors if somehow exists
                    RETURNING *
                `;
				if (row) {
					serverEmojiSchema.parse(row); // Rule 6, Validate with serverEmojiSchema
					insertedCount++;
				}
			}
			log.info(
				`Inserted ${insertedCount} current emoji entries for server ${serverId}.`,
			);
		});

		log.success(
			`Successfully refreshed emojis for guild ${guild.id} (Server ID: ${serverId}).`,
		);
	} catch (error) {
		// Rule 22: Log error with context
		const context: ErrorContext = {
			serverId: serverId, // Use the serverId if found, otherwise undefined
			errorType: "EmojiRefreshError", // Specific error type
			metadata: { guildId: guild.id, eventArgsCount: args.length },
		};
		await log.error(
			`Failed to refresh emojis for guild ${guild.id}`,
			error,
			context,
		);
	}
};

export default handleGuildEmojisUpdate;
