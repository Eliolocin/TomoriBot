import type { Client, Guild, TextChannel } from "discord.js";
import { log } from "../misc/logger";

/**
 * Analyzes recent messages in a channel to determine activity level
 * @param channel - The channel to analyze
 * @returns Promise<number> Number of non-bot messages in last 24h
 */
export async function getChannelActivity(
	channel: TextChannel,
): Promise<number> {
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
export async function findBestChannel(
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
