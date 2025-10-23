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
import { formatUTCOffset } from "../../utils/text/timezoneHelper";

// Define constants at the top
const TIMEZONE_MIN = -12;
const TIMEZONE_MAX = 14;
const TIMEZONE_DEFAULT = 0; // UTC

/**
 * Configures the subcommand for timezone setting
 * @param subcommand - The subcommand builder
 * @returns Configured subcommand builder
 */
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("timezone")
		.setDescription(localizer("en-US", "commands.config.timezone.description"))
		.addNumberOption((option) =>
			option
				.setName("value")
				.setDescription(
					localizer("en-US", "commands.config.timezone.value_description"),
				)
				.setMinValue(TIMEZONE_MIN)
				.setMaxValue(TIMEZONE_MAX)
				.setRequired(true),
		);

/**
 * Sets the timezone offset for the server
 * This affects how times are displayed in reminders and context messages
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
			descriptionKey: "general.errors.guild_only_description",
			color: ColorCode.ERROR,
		});
		return;
	}

	try {
		// 2. Get the timezone offset value from options
		const timezoneValue = interaction.options.getNumber("value", true);

		// 3. Additional validation (Discord already handles min/max, but just in case)
		if (timezoneValue < TIMEZONE_MIN || timezoneValue > TIMEZONE_MAX) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.timezone.invalid_value_title",
				descriptionKey: "commands.config.timezone.invalid_value_description",
				descriptionVars: {
					min: TIMEZONE_MIN.toString(),
					max: TIMEZONE_MAX.toString(),
				},
				color: ColorCode.ERROR,
			});
			return;
		}

		// 4. Load the Tomori state for this server
		const tomoriState = await loadTomoriState(interaction.guild.id);
		if (!tomoriState) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.tomori_not_setup_title",
				descriptionKey: "general.errors.tomori_not_setup_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 5. Check if this is the same as the current timezone offset
		const currentTimezone =
			tomoriState.config.timezone_offset ?? TIMEZONE_DEFAULT;
		if (timezoneValue === currentTimezone) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.timezone.already_set_title",
				descriptionKey: "commands.config.timezone.already_set_description",
				descriptionVars: {
					timezone: formatUTCOffset(timezoneValue),
				},
				color: ColorCode.WARN,
			});
			return;
		}

		// 6. Update the config in the database using direct SQL
		const [updatedRow] = await sql`
            UPDATE tomori_configs
            SET timezone_offset = ${timezoneValue}
            WHERE tomori_id = ${tomoriState.tomori_id}
            RETURNING *
        `;

		// 7. Validate the returned data
		const validatedConfig = tomoriConfigSchema.safeParse(updatedRow);

		if (!validatedConfig.success || !updatedRow) {
			const context: ErrorContext = {
				tomoriId: tomoriState.tomori_id,
				serverId: tomoriState.server_id,
				userId: userData.user_id,
				errorType: "DatabaseUpdateError",
				metadata: {
					command: "config timezone",
					guildId: interaction.guild?.id,
					timezoneValue,
					validationErrors: validatedConfig.success
						? null
						: validatedConfig.error.flatten(),
				},
			};
			await log.error(
				"Failed to update or validate timezone_offset config",
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

		// 8. Success message with formatted timezone display
		await replyInfoEmbed(interaction, locale, {
			titleKey: "commands.config.timezone.success_title",
			descriptionKey: "commands.config.timezone.success_description",
			descriptionVars: {
				timezone: formatUTCOffset(timezoneValue),
				previous_timezone: formatUTCOffset(currentTimezone),
			},
			color: ColorCode.SUCCESS,
		});
	} catch (error) {
		// 9. Log error with context
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
				command: "config timezone",
				guildId: interaction.guild?.id,
				executorDiscordId: interaction.user.id,
				valueAttempted: interaction.options.getNumber("value"),
			},
		};
		await log.error(
			`Error executing /config timezone for user ${userData.user_disc_id}`,
			error as Error,
			context,
		);

		// 10. Inform user of unknown error
		if (interaction.deferred && !interaction.replied) {
			await interaction.followUp({
				content: localizer(locale, "general.errors.unknown_error_description"),
				flags: MessageFlags.Ephemeral,
			});
		}
	}
}
