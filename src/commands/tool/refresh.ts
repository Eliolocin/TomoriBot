import type { SlashCommandSubcommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction, Client } from "discord.js";
import { replyInfoEmbed } from "../../utils/discord/interactionHelper";
import { ColorCode } from "../../utils/misc/logger";
import { localizer } from "../../utils/text/localizer";
import type { UserRow } from "../../types/db/schema";

/**
 * Configures the 'refresh' subcommand.
 */
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("refresh")
		.setDescription(localizer("en-US", "commands.tool.refresh.description"))
		.setDescriptionLocalizations({
			ja: localizer("ja", "commands.tool.refresh.description"),
		});

/**
 * Executes the 'refresh' command.
 * Sends an embed that acts as a visual separator and triggers conversation history reset.
 * @param client - The Discord client instance.
 * @param interaction - The chat input command interaction.
 * @param _userData - The user data (unused in this command).
 * @param locale - The user's preferred locale.
 */
export async function execute(
	_client: Client,
	interaction: ChatInputCommandInteraction,
	_userData: UserRow,
	locale: string,
): Promise<void> {
	// Defer reply to acknowledge the command
	await interaction.deferReply();

	// Send an embed that includes the keyword "refresh" in the description
	// This keyword is detected by the tomoriChat handler to reset context.
	await replyInfoEmbed(interaction, locale, {
		titleKey: "commands.tool.refresh.title",
		descriptionKey: "commands.tool.refresh.response", // Ensure this locale key contains "refresh"
		color: ColorCode.SECTION, // Use SECTION color for visual separation
	});
}
