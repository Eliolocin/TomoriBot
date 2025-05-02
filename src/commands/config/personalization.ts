import {
	MessageFlags,
	type ChatInputCommandInteraction,
	type Client,
	type SlashCommandSubcommandBuilder,
} from "discord.js";
import { loadTomoriState } from "../../utils/db/dbRead";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import { replyInfoEmbed } from "../../utils/discord/interactionHelper";
import {
	type UserRow,
	type ErrorContext,
	tomoriConfigSchema,
} from "../../types/db/schema";
import { sql } from "bun";

// Configure the subcommand
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("personalization")
		.setDescription(
			localizer("en-US", "commands.config.personalization.command_description"),
		)
		.setDescriptionLocalizations({
			ja: localizer(
				"ja",
				"commands.config.personalization.command_description",
			),
		})
		.addStringOption((option) =>
			option
				.setName("set")
				.setDescription(
					localizer("en-US", "commands.config.personalization.set_description"),
				)
				.setDescriptionLocalizations({
					ja: localizer(
						"ja",
						"commands.config.personalization.set_description",
					),
				})
				.setRequired(true)
				.addChoices(
					{
						name: localizer("en-US", "commands.config.options.enable"),
						value: "enable",
					},
					{
						name: localizer("en-US", "commands.config.options.disable"),
						value: "disable",
					},
				),
		);

/**
 * Enables or disables personal memories and nicknames for everyone.
 * Server memories and Tomori's unique persona still preserved.
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
	// 1. Ensure command is run in a guild
	if (!interaction.guild || !interaction.channel) {
		await replyInfoEmbed(interaction, userData.language_pref, {
			titleKey: "general.errors.guild_only_title",
			descriptionKey: "general.errors.guild_only",
			color: ColorCode.ERROR,
		});
		return;
	}

	try {
		// 2. Get the action from the command options
		const setAction = interaction.options.getString("set", true);
		const isEnabled = setAction === "enable";

		// 3. Show ephemeral processing message (Rule #21 modification)
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		// 4. Load the Tomori state for this server (Rule #17)
		const tomoriState = await loadTomoriState(interaction.guild.id);
		if (!tomoriState) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.tomori_not_setup_title",
				descriptionKey: "general.errors.tomori_not_setup",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 5. Check if the setting is already the desired value
		if (tomoriState.config.personal_memories_enabled === isEnabled) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.personalization.already_set_title",
				descriptionKey: isEnabled
					? "commands.config.personalization.already_enabled_description"
					: "commands.config.personalization.already_disabled_description",
				color: ColorCode.WARN,
			});
			return;
		}

		// 6. Update the config in the database using direct SQL (Rule #4, #15)
		const [updatedRow] = await sql`
            UPDATE tomori_configs
            SET personal_memories_enabled = ${isEnabled}
            WHERE tomori_id = ${tomoriState.tomori_id}
            RETURNING *
        `;

		// 7. Validate the returned data (Rules #3, #5)
		const validatedConfig = tomoriConfigSchema.safeParse(updatedRow);

		if (!validatedConfig.success || !updatedRow) {
			const context: ErrorContext = {
				tomoriId: tomoriState.tomori_id,
				serverId: tomoriState.server_id, // Add serverId for context
				userId: userData.user_id, // Add userId for context
				errorType: "DatabaseUpdateError", // More specific error type
				metadata: {
					command: "config personalization",
					guildId: interaction.guild.id,
					isEnabled, // Log the value we tried to set
					validationErrors: validatedConfig.success
						? null
						: validatedConfig.error.flatten(), // Include Zod errors if validation failed
				},
			};
			await log.error(
				"Failed to update or validate personal_memories_enabled config",
				// Provide a specific error message based on the failure reason
				validatedConfig.success
					? new Error("Database update returned no rows or unexpected data")
					: new Error("Updated config data failed validation"),
				context,
			);

			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.update_failed_title",
				descriptionKey: "general.errors.update_failed_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 8. Success! Show the new setting
		await replyInfoEmbed(interaction, locale, {
			titleKey: "commands.config.personalization.success_title",
			descriptionKey: isEnabled
				? "commands.config.personalization.enabled_success" // Use more descriptive keys
				: "commands.config.personalization.disabled_success",
			color: isEnabled ? ColorCode.SUCCESS : ColorCode.WARN, // Use WARN for disable confirmation
		});
	} catch (error) {
		// 9. Log error with context (Rule #22)
		// Attempt to get server/tomori IDs only once if needed
		let serverIdForError: number | null = null;
		let tomoriIdForError: number | null = null;
		if (interaction.guild?.id) {
			const state = await loadTomoriState(interaction.guild.id);
			serverIdForError = state?.server_id ?? null;
			tomoriIdForError = state?.tomori_id ?? null;
		}

		const context: ErrorContext = {
			userId: userData.user_id, // Add executor's internal ID
			serverId: serverIdForError,
			tomoriId: tomoriIdForError,
			errorType: "CommandExecutionError",
			metadata: {
				command: "config personalization",
				guildId: interaction.guild?.id,
				executorDiscordId: interaction.user.id, // Add executor's Discord ID
				actionAttempted: interaction.options.getString("set"), // Log attempted action
			},
		};
		await log.error(
			`Error executing /config personalization for user ${userData.user_disc_id}`,
			error as Error,
			context,
		);

		// 10. Inform user of unknown error
		// Check if the interaction has already been replied to or deferred
		if (!interaction.replied && !interaction.deferred) {
			// If not replied/deferred, use reply
			await interaction.reply({
				content: localizer(locale, "general.errors.unknown_error_description"),
				flags: MessageFlags.Ephemeral,
			});
		} else {
			// If already deferred or replied, use followUp
			await interaction.followUp({
				content: localizer(locale, "general.errors.unknown_error_description"),
				flags: MessageFlags.Ephemeral,
			});
		}
		// Using followUp as deferReply was called. replyInfoEmbed might try to editReply again.
		// Simplified error reply for safety.
	}
}
