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

// Define constants at the top (Rule #20)
const TEMPERATURE_MIN = 1.0;
const TEMPERATURE_MAX = 2.0;
const TEMPERATURE_DEFAULT = 1.5;

// Configure the subcommand
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("temperature")
		.setDescription(
			localizer("en-US", "commands.config.temperature.description"),
		)
		.addNumberOption((option) =>
			option
				.setName("value")
				.setDescription(
					localizer("en-US", "commands.config.temperature.value_description"),
				)
				.setDescriptionLocalizations({
					ja: localizer("ja", "commands.config.temperature.value_description"),
				})
				.setMinValue(TEMPERATURE_MIN)
				.setMaxValue(TEMPERATURE_MAX)
				.setRequired(true),
		);

/**
 * Sets the temperature parameter for Tomori's LLM
 * Higher values make output more random, lower values make it more deterministic
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
		// 2. Get the temperature value from options
		const temperatureValue = interaction.options.getNumber("value", true);

		// 3. Additional validation (Discord already handles min/max, but just in case)
		if (
			temperatureValue < TEMPERATURE_MIN ||
			temperatureValue > TEMPERATURE_MAX
		) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.temperature.invalid_value_title",
				descriptionKey: "commands.config.temperature.invalid_value_description",
				descriptionVars: {
					min: TEMPERATURE_MIN.toFixed(1), // Format for display
					max: TEMPERATURE_MAX.toFixed(1), // Format for display
				},
				color: ColorCode.ERROR,
			});
			return;
		}

		// 4. Show ephemeral processing message (Rule #21 modification)
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		// 5. Load the Tomori state for this server (Rule #17)
		const tomoriState = await loadTomoriState(interaction.guild.id);
		if (!tomoriState) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.tomori_not_setup_title",
				descriptionKey: "general.errors.tomori_not_setup_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 6. Check if this is the same as the current temperature
		const currentTemperature =
			tomoriState.config.llm_temperature ?? TEMPERATURE_DEFAULT; // Use default if null
		if (Math.abs(temperatureValue - currentTemperature) < 0.01) {
			// Using a small epsilon for floating point comparison
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.temperature.already_set_title",
				descriptionKey: "commands.config.temperature.already_set_description",
				descriptionVars: {
					temperature: temperatureValue.toFixed(1),
				},
				color: ColorCode.WARN,
			});
			return;
		}

		// 7. Update the config in the database using direct SQL (Rule #4, #15)
		const [updatedRow] = await sql`
            UPDATE tomori_configs
            SET llm_temperature = ${temperatureValue}
            WHERE tomori_id = ${tomoriState.tomori_id}
            RETURNING *
        `;

		// 8. Validate the returned data (Rules #3, #5)
		const validatedConfig = tomoriConfigSchema.safeParse(updatedRow);

		if (!validatedConfig.success || !updatedRow) {
			const context: ErrorContext = {
				tomoriId: tomoriState.tomori_id,
				serverId: tomoriState.server_id,
				userId: userData.user_id,
				errorType: "DatabaseUpdateError",
				metadata: {
					command: "config temperature",
					guildId: interaction.guild.id,
					temperatureValue,
					validationErrors: validatedConfig.success
						? null
						: validatedConfig.error.flatten(),
				},
			};
			await log.error(
				"Failed to update or validate llm_temperature config",
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

		// 9. Success message with explanation of the temperature effect
		await replyInfoEmbed(interaction, locale, {
			titleKey: "commands.config.temperature.success_title",
			descriptionKey: "commands.config.temperature.success_description",
			descriptionVars: {
				temperature: temperatureValue.toFixed(1),
				previous_temperature: currentTemperature.toFixed(1),
			},
			color: ColorCode.SUCCESS,
		});
	} catch (error) {
		// 10. Log error with context (Rule #22)
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
				command: "config temperature",
				guildId: interaction.guild?.id,
				executorDiscordId: interaction.user.id,
				valueAttempted: interaction.options.getNumber("value"),
			},
		};
		await log.error(
			`Error executing /config temperature for user ${userData.user_disc_id}`,
			error as Error,
			context,
		);

		// 11. Inform user of unknown error
		// Use followUp since deferReply was used
		if (interaction.deferred && !interaction.replied) {
			await interaction.followUp({
				content: localizer(locale, "general.errors.unknown_error_description"),
				flags: MessageFlags.Ephemeral,
			});
		}
	}
}
