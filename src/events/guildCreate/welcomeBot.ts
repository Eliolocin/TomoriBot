import { sql } from "bun";
import { log } from "../../utils/logBeautifier";
import { ColorScheme } from "../../utils/logBeautifier";
import { createStandardEmbed } from "../../utils/eventHelpers";
import type {
	Client,
	Guild,
	TextChannel,
	Collection,
	Message,
} from "discord.js";

/**
 * Analyzes recent messages in a channel to determine activity level
 * @param channel - The channel to analyze
 * @returns Promise<number> Number of non-bot messages in last 24h
 */
async function getChannelActivity(channel: TextChannel): Promise<number> {
	try {
		const messages = await channel.messages.fetch({ limit: 50 });
		const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

		return messages.filter(
			(msg) => !msg.author.bot && msg.createdTimestamp > oneDayAgo,
		).size;
	} catch {
		// If we can't fetch messages, assume no activity
		return 0;
	}
}

/**
 * Finds the most active text channel that's accessible to the bot
 * @param guild - The Discord guild to search in
 * @param client - The Discord client instance
 * @returns Promise<TextChannel | null>
 */
async function findBestChannel(
	guild: Guild,
	client: Client,
): Promise<TextChannel | null> {
	try {
		// 1. Get all text channels we can send messages in
		const textChannels = guild.channels.cache
			.filter(
				(ch): ch is TextChannel =>
					ch.isTextBased() &&
					// biome-ignore lint/style/noNonNullAssertion: Client user is guaranteed to exist here
					!!ch.permissionsFor(client.user!)?.has("SendMessages"),
			)
			.sort((a, b) => a.position - b.position);

		if (textChannels.size === 0) return null;

		// 2. Analyze activity for each channel
		const channelActivity = new Map<TextChannel, number>();
		for (const channel of textChannels.values()) {
			const activity = await getChannelActivity(channel);
			channelActivity.set(channel, activity);
		}

		// 3. Find channel with most activity
		return (
			[...channelActivity.entries()].sort(([ch1, act1], [ch2, act2]) => {
				// First by activity
				if (act1 !== act2) return act2 - act1;
				// Then by position (higher = closer to top)
				return ch1.position - ch2.position;
			})[0]?.[0] ?? null
		);
	} catch (error) {
		log.error("Error finding best channel:", error);
		return null;
	}
}

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

		// 3. Find most active accessible channel
		const channel = await findBestChannel(guild, client);
		if (!channel) {
			log.error(
				`No suitable text channel found in guild ${guild.name} (${guild.id})`,
			);
			return;
		}

		// 4. Create and send appropriate embed
		const serverLocale = guild.preferredLocale.startsWith("ja") ? "ja" : "en";
		const welcomeEmbed = createStandardEmbed(serverLocale, {
			titleKey: tomoriExists
				? "events.welcomeBot.rejoin_title"
				: "events.welcomeBot.setup_prompt_title",
			descriptionKey: tomoriExists
				? "events.welcomeBot.rejoin_description"
				: "events.welcomeBot.setup_prompt_description",
			color: tomoriExists ? ColorScheme.INFO : ColorScheme.WARN,
		});

		await channel.send({ embeds: [welcomeEmbed] });
		log.success(
			`Sent welcome message to channel ${channel.name} in ${guild.name}`,
		);
	} catch (error) {
		log.error(`Error handling guild join for ${guild.id}:`, error);
	}
};

export default handler;
