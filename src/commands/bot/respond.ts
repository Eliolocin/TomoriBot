import type { SlashCommandSubcommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction, Client, Message } from "discord.js";
import { MessageFlags } from "discord.js";
import { replyInfoEmbed } from "../../utils/discord/interactionHelper";
import { ColorCode, log } from "../../utils/misc/logger";
import { localizer } from "../../utils/text/localizer";
import type { UserRow } from "../../types/db/schema";
import tomoriChat from "../../events/messageCreate/tomoriChat";

/**
 * Configure the respond subcommand
 * @param subcommand - The slash command subcommand builder
 * @returns The configured subcommand
 */
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("respond")
		.setDescription(localizer("en-US", "commands.bot.respond.description"));

/**
 * Execute the respond command - manually trigger Tomori to respond to the latest message
 * @param client - Discord client instance
 * @param interaction - Command interaction
 * @param _userData - User data from database (not used)
 * @param locale - Locale of the interaction
 */
export async function execute(
	client: Client,
	interaction: ChatInputCommandInteraction,
	_userData: UserRow,
	locale: string,
): Promise<void> {
	// 1. Ensure command is run in a guild text channel - let helper functions manage interaction state
	if (!interaction.channel || !("messages" in interaction.channel)) {
		await replyInfoEmbed(interaction, locale, {
			titleKey: "general.errors.guild_only_title",
			descriptionKey: "general.errors.guild_only_description",
			color: ColorCode.ERROR,
		});
		return;
	}

	try {
		// 3. Send immediate ephemeral response to user
		await replyInfoEmbed(interaction, locale, {
			titleKey: "commands.bot.respond.success_title",
			descriptionKey: "commands.bot.respond.success_description",
			color: ColorCode.SUCCESS,
		});

		// 4. Get the latest message in the channel (excluding the interaction itself)
		const messages = await interaction.channel.messages.fetch({ limit: 1 });
		const latestMessage = messages.first();

		if (!latestMessage) {
			log.warn(
				`No messages found in channel ${interaction.channel.id} for manual respond command.`,
			);
			return;
		}

		// 5. Create a "passport" message that will trigger tomoriChat
		// We need to ensure this message will pass the trigger checks
		const passportMessage = latestMessage;

		// 6. Manually trigger tomoriChat with command flags
		log.info(
			`Manual respond command triggered by ${interaction.user.id} in channel ${interaction.channel.id} for message ${latestMessage.id}`,
		);

		await tomoriChat(
			client,
			passportMessage as Message,
			false, // isFromQueue
			true, // isManuallyTriggered - this bypasses normal trigger logic
		);
	} catch (error) {
		log.error("Error in bot respond command:", error, {
			errorType: "BotRespondCommandError",
			metadata: {
				userId: interaction.user.id,
				guildId: interaction.guild?.id ?? interaction.user.id,
				channelId: interaction.channel?.id,
			},
		});

		// Try to send error feedback if possible
		try {
			await interaction.followUp({
				content: localizer(locale, "general.errors.unknown_error_description"),
				flags: MessageFlags.Ephemeral,
			});
		} catch (followUpError) {
			log.error(
				"Failed to send error followup for bot respond command:",
				followUpError,
			);
		}
	}
}
