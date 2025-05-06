import { type Client, type Guild, Sticker } from "discord.js";
import { sql } from "bun";
import type { EventFunction, EventArg } from "../../types/discord/global"; // Rule 14
import type { ErrorContext } from "../../types/db/schema"; // Rule 14, Import ServerRow
import { serverStickerSchema } from "../../types/db/schema"; // Rule 6
import { log } from "../../utils/misc/logger"; // Rule 18
// Removed loadServerState import

/**
 * Rule 1: JSDoc comment for exported function
 * Handles sticker create, delete, and update events by refreshing the guild's sticker list in the database.
 * @param _client - Discord client instance (unused)
 * @param args - Event arguments (expected: Sticker or [Sticker, Sticker])
 */
const handleGuildStickersUpdate: EventFunction = async (
	_client: Client,
	...args: EventArg[]
): Promise<void> => {
	// 1. Identify the Sticker and Guild from the event arguments
	const sticker = args[0];
	if (!(sticker instanceof Sticker) || !sticker.guild) {
		log.warn(
			"guildStickersUpdate event triggered without a valid Sticker or Guild.",
			{ args },
		);
		return; // Cannot proceed without guild info
	}
	const guild: Guild = sticker.guild;
	log.info(`Sticker change detected in guild: ${guild.name} (${guild.id})`);

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
				`Received sticker update for guild ${guild.id} but server is not registered in DB. Skipping refresh.`,
			);
			return; // Server not setup, nothing to refresh
		}
		// biome-ignore lint/style/noNonNullAssertion: Row existence guarantees server_id is present (Rule 8)
		serverId = serverRow.server_id!; // Assign the found server ID

		// 3. Fetch the current complete list of stickers from the guild cache
		// ... (rest of the code remains the same) ...

		// 4. Perform database update within a transaction (Rule 15)
		await sql.transaction(async (tx) => {
			// 4a. Delete all existing stickers for this server
			const { rowCount: deletedCount } = await tx`
                DELETE FROM server_stickers
                WHERE server_id = ${serverId}
            `;
			log.info(
				`Deleted ${deletedCount} existing sticker entries for server ${serverId}.`,
			);

			// 4b. Map current stickers to database format
			// ... (mapping logic remains the same) ...
			const currentStickers = Array.from(guild.stickers.cache.values());
			const stickerValues = currentStickers.map((s) => ({
				sticker_disc_id: s.id,
				sticker_name: s.name,
				sticker_desc: s.description ?? "",
				emotion_key: "unset",
				sticker_format: s.format,
			}));

			// 4c. Insert the current stickers (similar to setupServer logic)
			// ... (insert loop remains the same) ...
			let insertedCount = 0;
			for (const {
				sticker_disc_id,
				sticker_name,
				sticker_desc,
				emotion_key,
				sticker_format,
			} of stickerValues) {
				const [row] = await tx`
                    INSERT INTO server_stickers (
                        server_id,
                        sticker_disc_id,
                        sticker_name,
                        sticker_desc,
                        emotion_key,
                        sticker_format
                    ) VALUES (
                        ${serverId},
                        ${sticker_disc_id},
                        ${sticker_name},
                        ${sticker_desc},
                        ${emotion_key},
                        ${sticker_format}
                    )
                    ON CONFLICT (server_id, sticker_disc_id) DO NOTHING
                    RETURNING *
                `;
				if (row) {
					serverStickerSchema.parse(row); // Rule 6
					insertedCount++;
				}
			}
			log.info(
				`Inserted ${insertedCount} current sticker entries for server ${serverId}.`,
			);
		});

		log.success(
			`Successfully refreshed stickers for guild ${guild.id} (Server ID: ${serverId}).`,
		);
	} catch (error) {
		// Rule 22: Log error with context
		// serverId might be undefined if the initial SELECT failed
		const context: ErrorContext = {
			serverId: serverId, // Use the serverId if found, otherwise undefined
			errorType: "StickerRefreshError",
			metadata: { guildId: guild.id, eventArgsCount: args.length },
		};
		await log.error(
			`Failed to refresh stickers for guild ${guild.id}`,
			error,
			context,
		);
	}
};

export default handleGuildStickersUpdate;
