import type { Message } from "discord.js"; // Use type import
import { TextChannel } from "discord.js"; // Keep value import for instanceof check
import type { TomoriState } from "../../types/db/schema"; // Import TomoriState (TomoriRow + TomoriConfigRow)

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

/**
 * Formats a boolean value into a user-friendly string ("Enabled" or "Disabled").
 * @param value - The boolean value to format.
 * @returns "Enabled" if true, "Disabled" if false.
 */
export function formatBoolean(value: boolean): string {
	return value ? "`Enabled`" : "`Disabled`";
}
