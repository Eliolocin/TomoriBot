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
		.setName("selfteach")
		.setDescription(
			localizer("en-US", "commands.config.selfteach.command_description"),
		)
		.setDescriptionLocalizations({
			ja: localizer("ja", "commands.config.selfteach.command_description"),
		})
		.addStringOption((option) =>
			option
				.setName("set")
				.setDescription(
					localizer("en-US", "commands.config.selfteach.set_description"),
				)
				.setDescriptionLocalizations({
					ja: localizer("ja", "commands.config.selfteach.set_description"),
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
 * Configures Tomori's self-teaching setting
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
		if (tomoriState.config.self_teaching_enabled === isEnabled) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.selfteach.already_set_title", // New key needed
				descriptionKey: isEnabled
					? "commands.config.selfteach.already_enabled_description" // New key needed
					: "commands.config.selfteach.already_disabled_description", // New key needed
				color: ColorCode.WARN,
			});
			return;
		}

		// 6. Update the config in the database using direct SQL (Rule #4, #15)
		const [updatedRow] = await sql`
            UPDATE tomori_configs
            SET self_teaching_enabled = ${isEnabled}
            WHERE tomori_id = ${tomoriState.tomori_id}
            RETURNING *
        `;

		// 7. Validate the returned data (Rules #3, #5)
		const validatedConfig = tomoriConfigSchema.safeParse(updatedRow);

		if (!validatedConfig.success || !updatedRow) {
			const context: ErrorContext = {
				tomoriId: tomoriState.tomori_id,
				serverId: tomoriState.server_id,
				userId: userData.user_id,
				errorType: "DatabaseUpdateError",
				metadata: {
					command: "config selfteach",
					guildId: interaction.guild.id,
					isEnabled,
					validationErrors: validatedConfig.success
						? null
						: validatedConfig.error.flatten(),
				},
			};
			await log.error(
				"Failed to update or validate self_teaching_enabled config",
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
			titleKey: "commands.config.selfteach.success_title",
			descriptionKey: isEnabled
				? "commands.config.selfteach.enabled_success" // Renamed key
				: "commands.config.selfteach.disabled_success", // Renamed key
			color: isEnabled ? ColorCode.SUCCESS : ColorCode.WARN, // WARN for disable
		});
	} catch (error) {
		// 9. Log error with context (Rule #22)
		let serverIdForError: number | null = null;
		let tomoriIdForError: number | null = null;
		if (interaction.guild?.id) {
			const state = await loadTomoriState(interaction.guild.id);
			serverIdForError = state?.server_id ?? null;
			tomoriIdForError = state?.tomori_id ?? null;
		}

		const context: ErrorContext = {
			userId: userData.user_id,
			serverId: serverIdForError,
			tomoriId: tomoriIdForError,
			errorType: "CommandExecutionError",
			metadata: {
				command: "config selfteach",
				guildId: interaction.guild?.id,
				executorDiscordId: interaction.user.id,
				actionAttempted: interaction.options.getString("set"),
			},
		};
		await log.error(
			`Error executing /config selfteach for user ${userData.user_disc_id}`,
			error as Error,
			context,
		);

		// 10. Inform user of unknown error
		// Use followUp since deferReply was used
		if (interaction.deferred && !interaction.replied) {
			await interaction.followUp({
				content: localizer(locale, "general.errors.unknown_error_description"),
				flags: MessageFlags.Ephemeral,
			});
		}
	}
}
