import type {
	ChatInputCommandInteraction,
	Client,
	SlashCommandSubcommandBuilder,
} from "discord.js";
import { MessageFlags } from "discord.js"; // Import if needed for error replies
import type { UserRow } from "../../types/db/schema"; // Rule 14: Use type for imports
import type { ErrorContext } from "../../types/db/schema"; // Rule 14: Use type for imports
import { localizer } from "../../utils/text/localizer"; // Rule 9: Use localizer
import { log, ColorCode } from "../../utils/misc/logger"; // Rule 12, 18: Use logger and ColorCode
import { replySummaryEmbed } from "../../utils/discord/interactionHelper"; // Rule 12, 19: Use helpers

// --- Configuration ---
// TODO: Replace '__topic__' with the actual help topic name (e.g., 'apikey', 'preset')
const HELP_TOPIC_NAME = "__topic__";
// --- End Configuration ---

// Rule 21: Configure the subcommand
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName(HELP_TOPIC_NAME) // Use the constant for the name
		.setDescription(
			// Use a consistent key structure: commands.help.<topic>.command_description
			localizer(
				"en-US",
				`commands.help.${HELP_TOPIC_NAME}.command_description`,
			),
		)
		.setDescriptionLocalizations({
			// Add other locales as needed
			ja: localizer(
				"ja",
				`commands.help.${HELP_TOPIC_NAME}.command_description`,
			),
		});

/**
 * Rule 1: JSDoc comment for exported function
 * Displays help information about the '__topic__' feature.
 * TODO: Update the description above.
 * @param _client - Discord client instance
 * @param interaction - Command interaction
 * @param userData - User data from database
 * @param locale - Locale of the interaction
 */
export async function execute(
	_client: Client,
	interaction: ChatInputCommandInteraction,
	userData: UserRow,
	locale: string,
): Promise<void> {
	try {
		// 1. Use replySummaryEmbed to show structured help info (Rule 19)
		// Help commands are typically non-ephemeral so everyone can see the info.
		await replySummaryEmbed(
			interaction,
			locale,
			{
				// Use consistent key structure
				titleKey: `commands.help.${HELP_TOPIC_NAME}.title`,
				descriptionKey: `commands.help.${HELP_TOPIC_NAME}.description`,
				color: ColorCode.INFO, // Rule 12: Use INFO color for help
				fields: [
					// TODO: Add 1-5 fields explaining the feature.
					// Use localizer() directly for the 'value' as it might contain formatting.
					{
						nameKey: `commands.help.${HELP_TOPIC_NAME}.field_1_name`, // Key for field name
						value: localizer(
							locale,
							`commands.help.${HELP_TOPIC_NAME}.field_1_value`,
						), // Localized value
						inline: false, // Usually false for help text blocks
					},
					{
						nameKey: `commands.help.${HELP_TOPIC_NAME}.field_2_name`,
						value: localizer(
							locale,
							`commands.help.${HELP_TOPIC_NAME}.field_2_value`,
						),
						inline: false,
					},
				],
				// Non-ephemeral by default
			},
			MessageFlags.SuppressNotifications,
		); // Explicitly pass undefined to override ephemeral default
	} catch (error) {
		// Rule 22: Log error with context
		const context: ErrorContext = {
			userId: userData.user_id,
			serverId: interaction.guild?.id, // Use guildId directly if available
			errorType: "CommandExecutionError",
			metadata: { commandName: `/help ${HELP_TOPIC_NAME}` },
		};
		// Log the error with context
		await log.error(
			`Error executing /help ${HELP_TOPIC_NAME} command`,
			error as Error, // Cast error to Error type
			context,
		);

		// Inform user of error (ephemeral)
		// Check if interaction can be replied to or followed up
		// Use a simple followUp/reply for error to avoid potential issues with helpers during error handling
		const errorMessage = localizer(
			locale,
			"general.errors.unknown_error_description",
		);
		try {
			if (interaction.replied || interaction.deferred) {
				await interaction.followUp({
					content: errorMessage,
					flags: MessageFlags.Ephemeral,
				});
			} else {
				await interaction.reply({
					content: errorMessage,
					flags: MessageFlags.Ephemeral,
				});
			}
		} catch (replyError) {
			// Log if even the error reply fails
			log.error(
				`Failed to send error reply for /help ${HELP_TOPIC_NAME}`,
				replyError,
				context, // Reuse context
			);
		}
	}
}
