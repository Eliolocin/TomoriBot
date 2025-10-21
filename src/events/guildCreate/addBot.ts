import { sql } from "bun";
import { log, ColorCode } from "../../utils/misc/logger";
import { sendStandardEmbed } from "../../utils/discord/embedHelper";
import type { Client, Guild } from "discord.js";
import { findBestChannel } from "@/utils/discord/eventHelper";

/**
 * Sends welcome message when bot joins a new guild.
 * Shows setup instructions or welcome back message based on existing data.
 * @param client - The Discord client instance
 * @param guild - The guild the bot joined
 * @returns Promise<void>
 */
const handler = async (client: Client, guild: Guild): Promise<void> => {
	try {
		log.info(`Bot joined new server: ${guild.name} (${guild.id})`);

		// 1. Check if server exists in database
		const [existingServer] = await sql`
            SELECT server_id FROM servers 
            WHERE server_disc_id = ${guild.id}
        `;

		// 2. Check if Tomori exists if server found
		let tomoriExists = false;
		if (existingServer?.server_id) {
			const [existingTomori] = await sql`
                SELECT tomori_id FROM tomoris 
                WHERE server_id = ${existingServer.server_id}
            `;
			tomoriExists = !!existingTomori;
		}

		// 3. Try to send to system channel first, fallback to best channel
		const serverLocale = guild.preferredLocale;
		let channel = guild.systemChannel;
		let sentSuccessfully = false;

		// Try sending to system channel if it exists
		if (channel) {
			try {
				await sendStandardEmbed(channel, serverLocale, {
					titleKey: tomoriExists
						? "events.addBot.rejoin_title"
						: "events.addBot.setup_prompt_title",
					descriptionKey: tomoriExists
						? "events.addBot.rejoin_description"
						: "events.addBot.setup_prompt_description",
					color: tomoriExists ? ColorCode.INFO : ColorCode.WARN,
				});
				sentSuccessfully = true;
				log.success(
					`Sent welcome message to system channel ${channel.name} in ${guild.name}`,
				);
			} catch (_error) {
				log.warn(
					`Failed to send to system channel in ${guild.name}, trying fallback`,
				);
			}
		}

		// Fallback to best channel if system channel failed or doesn't exist
		if (!sentSuccessfully) {
			channel = await findBestChannel(guild, client);
			if (!channel) {
				log.error(
					`No suitable text channel found in guild ${guild.name} (${guild.id})`,
				);
				return;
			}

			await sendStandardEmbed(channel, serverLocale, {
				titleKey: tomoriExists
					? "events.addBot.rejoin_title"
					: "events.addBot.setup_prompt_title",
				descriptionKey: tomoriExists
					? "events.addBot.rejoin_description"
					: "events.addBot.setup_prompt_description",
				color: tomoriExists ? ColorCode.INFO : ColorCode.WARN,
			});

			log.success(
				`Sent welcome message to fallback channel ${channel.name} in ${guild.name}`,
			);
		}
	} catch (error) {
		log.error(`Error handling guild join for ${guild.id}:`, error);
	}
};

export default handler;
