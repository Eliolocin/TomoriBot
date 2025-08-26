import {
	MessageFlags,
	type ChatInputCommandInteraction,
	type Client,
	type SlashCommandSubcommandBuilder,
} from "discord.js";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import { replyInfoEmbed } from "../../utils/discord/interactionHelper";
import {
	type UserRow,
	type ErrorContext,
	userSchema,
} from "../../types/db/schema";
import { sql } from "bun";

// Define constants at the top (Rule #20)
const SUPPORTED_LANGUAGES = ["en-US", "ja"] as const;
const DEFAULT_LANGUAGE = "en-US";

// Configure the subcommand
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("language")
		.setDescription(
			localizer("en-US", "commands.config.language.description"),
		)
		.addStringOption((option) =>
			option
				.setName("value")
				.setDescription(
					localizer(
						"en-US",
						"commands.config.language.value_description",
					),
				)
				.setDescriptionLocalizations({
					ja: localizer(
						"ja",
						"commands.config.language.value_description",
					),
				})
				.setRequired(true)
				.addChoices(
					{
						name: localizer(
							"en-US",
							"commands.config.language.choice_english",
						),
						value: "en-US",
					},
					{
						name: localizer(
							"en-US",
							"commands.config.language.choice_japanese",
						),
						value: "ja",
					},
				),
		);

/**
 * Configures the user's preferred interface language for TomoriBot.
 * This affects how the bot's messages and interfaces appear to the individual user.
 * Supported languages: English (en-US) and Japanese (ja)
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
		// 2. Get the language value from options
		const languageValue = interaction.options.getString("value", true);

		// 3. Additional validation (Discord already handles choices, but just in case)
		if (!(SUPPORTED_LANGUAGES as readonly string[]).includes(languageValue)) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.language.invalid_value_title",
				descriptionKey:
					"commands.config.language.invalid_value_description",
				descriptionVars: {
					supported: SUPPORTED_LANGUAGES.join(", "),
				},
				color: ColorCode.ERROR,
			});
			return;
		}

		// 4. Show ephemeral processing message (Rule #21 modification)
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		// 5. Check if this is the same as the current language preference
		const currentLanguage = userData.language_pref ?? DEFAULT_LANGUAGE;
		if (languageValue === currentLanguage) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.language.already_set_title",
				descriptionKey:
					"commands.config.language.already_set_description",
				descriptionVars: {
					value: getLanguageLabel(locale, languageValue),
				},
				color: ColorCode.WARN,
			});
			return;
		}

		// 6. Update the user's language preference in the database using direct SQL (Rule #4, #15)
		const [updatedRow] = await sql`
            UPDATE users
            SET language_pref = ${languageValue}
            WHERE user_disc_id = ${userData.user_disc_id}
            RETURNING *
        `;

		// 7. Validate the returned data (Rules #3, #5 - critical user data change)
		const validatedUser = userSchema.safeParse(updatedRow);

		if (!validatedUser.success || !updatedRow) {
			const context: ErrorContext = {
				userId: userData.user_id,
				errorType: "DatabaseUpdateError",
				metadata: {
					command: "config language",
					guildId: interaction.guild.id,
					languageValue,
					validationErrors: validatedUser.success
						? null
						: validatedUser.error.flatten(), // Include Zod errors if validation failed
				},
			};
			await log.error(
				"Failed to update or validate user language preference",
				// Provide a specific error message based on the failure reason
				validatedUser.success
					? new Error("Database update returned no rows or unexpected data")
					: new Error("Updated user data failed validation"),
				context,
			);

			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.update_failed_title",
				descriptionKey: "general.errors.update_failed_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 8. Success message with explanation of the language change
		await replyInfoEmbed(interaction, languageValue, {
			titleKey: "commands.config.language.success_title",
			descriptionKey: "commands.config.language.success_description",
			descriptionVars: {
				value: getLanguageLabel(languageValue, languageValue),
				previous_value: getLanguageLabel(languageValue, currentLanguage),
			},
			color: ColorCode.SUCCESS,
		});
	} catch (error) {
		// 9. Log error with context (Rule #22)
		const context: ErrorContext = {
			userId: userData.user_id,
			errorType: "CommandExecutionError",
			metadata: {
				command: "config language",
				guildId: interaction.guild?.id,
				executorDiscordId: interaction.user.id,
				valueAttempted: interaction.options.getString("value"), // Log attempted value
			},
		};
		await log.error(
			`Error executing /config language for user ${userData.user_disc_id}`,
			error as Error,
			context,
		);

		// 10. Inform user of unknown error
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
 * Helper function to get a user-friendly label for language values
 * @param locale - The user's locale for localization
 * @param value - Language preference value
 * @returns Localized language label
 */
function getLanguageLabel(locale: string, value: string): string {
	switch (value) {
		case "en-US":
			return localizer(locale, "commands.config.language.choice_english");
		case "ja":
			return localizer(locale, "commands.config.language.choice_japanese");
		default:
			// Default to English if value is somehow unexpected, though validation should prevent this
			log.warn(
				`Unexpected language value encountered in getLanguageLabel: ${value}`,
			);
			return localizer(locale, "commands.config.language.choice_english");
	}
}