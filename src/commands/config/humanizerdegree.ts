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
const HUMANIZER_MIN = 0;
const HUMANIZER_MAX = 3;
const HUMANIZER_DEFAULT = 1;

// Configure the subcommand
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("humanizerdegree")
		.setDescription(
			localizer("en-US", "commands.config.humanizerdegree.command_description"),
		)
		.setDescriptionLocalizations({
			ja: localizer(
				"ja",
				"commands.config.humanizerdegree.command_description",
			),
		})
		.addIntegerOption((option) =>
			option
				.setName("value")
				.setDescription(
					localizer(
						"en-US",
						"commands.config.humanizerdegree.value_description",
					),
				)
				.setDescriptionLocalizations({
					ja: localizer(
						"ja",
						"commands.config.humanizerdegree.value_description",
					),
				})
				.setMinValue(HUMANIZER_MIN)
				.setMaxValue(HUMANIZER_MAX)
				.setRequired(true)
				.addChoices(
					{
						name: localizer(
							"en-US",
							"commands.config.humanizerdegree.choice_none",
						),
						value: 0,
					},
					{
						name: localizer(
							"en-US",
							"commands.config.humanizerdegree.choice_light",
						),
						value: 1,
					},
					{
						name: localizer(
							"en-US",
							"commands.config.humanizerdegree.choice_medium",
						),
						value: 2,
					},
					{
						name: localizer(
							"en-US",
							"commands.config.humanizerdegree.choice_heavy",
						),
						value: 3,
					},
				),
		);

/**
 * Configures the humanizer degree setting for Tomori.
 * Has 4 levels, each stacking upon each other:
 * 0 = No humanization
 * 1 = Added prompt to make Tomori more 'human'
 * 2 = Added typing simulation and chunking of messages
 * 3 = Lowercase all words and remove punctuations
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
		// 2. Get the humanizer value from options
		const humanizerValue = interaction.options.getInteger("value", true);

		// 3. Additional validation (Discord already handles min/max, but just in case)
		if (humanizerValue < HUMANIZER_MIN || humanizerValue > HUMANIZER_MAX) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.humanizerdegree.invalid_value_title",
				descriptionKey:
					"commands.config.humanizerdegree.invalid_value_description",
				descriptionVars: {
					min: HUMANIZER_MIN.toString(), // Ensure strings for localizer
					max: HUMANIZER_MAX.toString(),
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
				descriptionKey: "general.errors.tomori_not_setup",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 6. Check if this is the same as the current humanizer value
		const currentHumanizer =
			tomoriState.config.humanizer_degree ?? HUMANIZER_DEFAULT;
		if (humanizerValue === currentHumanizer) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.humanizerdegree.already_set_title",
				descriptionKey:
					"commands.config.humanizerdegree.already_set_description",
				descriptionVars: {
					value: getHumanizerLabel(locale, humanizerValue),
				},
				color: ColorCode.WARN,
			});
			return;
		}

		// 7. Update the config in the database using direct SQL (Rule #4, #15)
		const [updatedRow] = await sql`
            UPDATE tomori_configs
            SET humanizer_degree = ${humanizerValue}
            WHERE tomori_id = ${tomoriState.tomori_id}
            RETURNING *
        `;

		// 8. Validate the returned data (Rules #3, #5 - critical config change)
		const validatedConfig = tomoriConfigSchema.safeParse(updatedRow);

		if (!validatedConfig.success || !updatedRow) {
			const context: ErrorContext = {
				tomoriId: tomoriState.tomori_id,
				serverId: tomoriState.server_id,
				userId: userData.user_id,
				errorType: "DatabaseUpdateError",
				metadata: {
					command: "config humanizerdegree",
					guildId: interaction.guild.id,
					humanizerValue,
					validationErrors: validatedConfig.success
						? null
						: validatedConfig.error.flatten(), // Include Zod errors if validation failed
				},
			};
			await log.error(
				"Failed to update or validate humanizer_degree config",
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

		// 9. Success message with explanation of the humanizer effect
		await replyInfoEmbed(interaction, locale, {
			titleKey: "commands.config.humanizerdegree.success_title",
			descriptionKey: "commands.config.humanizerdegree.success_description",
			descriptionVars: {
				value: getHumanizerLabel(locale, humanizerValue),
				previous_value: getHumanizerLabel(locale, currentHumanizer),
			},
			color: ColorCode.SUCCESS,
		});
	} catch (error) {
		// 10. Log error with context (Rule #22)
		// Attempt to get server/tomori IDs only once if needed
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
				command: "config humanizerdegree",
				guildId: interaction.guild?.id,
				executorDiscordId: interaction.user.id,
				valueAttempted: interaction.options.getInteger("value"), // Log attempted value
			},
		};
		await log.error(
			`Error executing /config humanizerdegree for user ${userData.user_disc_id}`,
			error as Error,
			context,
		);

		// 11. Inform user of unknown error
		// Check if the interaction has already been replied to or deferred
		if (!interaction.replied && !interaction.deferred) {
			await interaction.reply({
				content: localizer(locale, "general.errors.unknown_error_description"),
				flags: MessageFlags.Ephemeral,
			});
		} else {
			await interaction.followUp({
				content: localizer(locale, "general.errors.unknown_error_description"),
				flags: MessageFlags.Ephemeral,
			});
		}
	}
}

/**
 * Helper function to get a user-friendly label for humanizer values
 * @param locale - The user's locale
 * @param value - Humanizer degree value
 * @returns Localized humanizer label
 */
function getHumanizerLabel(locale: string, value: number): string {
	switch (value) {
		case 0:
			return localizer(locale, "commands.config.humanizerdegree.choice_none");
		case 1:
			return localizer(locale, "commands.config.humanizerdegree.choice_light");
		case 2:
			return localizer(locale, "commands.config.humanizerdegree.choice_medium");
		case 3:
			return localizer(locale, "commands.config.humanizerdegree.choice_heavy");
		default:
			// Default to light if value is somehow unexpected, though validation should prevent this
			log.warn(
				`Unexpected humanizer value encountered in getHumanizerLabel: ${value}`,
			);
			return localizer(locale, "commands.config.humanizerdegree.choice_light");
	}
}
