import type {
	ChatInputCommandInteraction,
	Client,
	SlashCommandSubcommandBuilder,
} from "discord.js";
import { MessageFlags } from "discord.js";
import { sql } from "bun";
import {
	userSchema,
	type UserRow,
	type ErrorContext,
	type TomoriState, // Import TomoriRow type
} from "../../types/db/schema";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import { replyInfoEmbed } from "../../utils/discord/interactionHelper";
import { loadTomoriState } from "../../utils/db/dbRead"; // Import loadTomoriState

// Rule 20: Constants for static values at the top
const NICKNAME_MIN_LENGTH = 2;
const NICKNAME_MAX_LENGTH = 32;

// Rule 21: Configure the subcommand
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("personalnickname")
		.setDescription(
			localizer("en-US", "commands.teach.personalnickname.command_description"),
		)
		.setDescriptionLocalizations({
			ja: localizer(
				"ja",
				"commands.teach.personalnickname.command_description",
			),
		})
		.addStringOption((option) =>
			option
				.setName("name")
				.setDescription(
					localizer(
						"en-US",
						"commands.teach.personalnickname.option_description",
					),
				)
				.setDescriptionLocalizations({
					ja: localizer(
						"ja",
						"commands.teach.personalnickname.option_description",
					),
				})
				.setRequired(true)
				.setMinLength(NICKNAME_MIN_LENGTH)
				.setMaxLength(NICKNAME_MAX_LENGTH),
		);

/**
 * Rule 1: JSDoc comment for exported function
 * Updates how Tomori refers to the user
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
	// Ensure command is run in a guild context for server settings check
	if (!interaction.guild) {
		await replyInfoEmbed(interaction, locale, {
			titleKey: "general.errors.guild_only_title",
			descriptionKey: "general.errors.guild_only",
			color: ColorCode.ERROR,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	try {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });
		// 1. Get the new nickname from the command options
		const newNickname = interaction.options.getString("name", true);

		// 2. Validate nickname length (redundant check, Discord handles this, but good for safety)
		if (
			newNickname.length < NICKNAME_MIN_LENGTH ||
			newNickname.length > NICKNAME_MAX_LENGTH
		) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.teach.personalnickname.invalid_length_title",
				descriptionKey: "commands.teach.personalnickname.invalid_length",
				descriptionVars: {
					min: NICKNAME_MIN_LENGTH.toString(),
					max: NICKNAME_MAX_LENGTH.toString(),
				},
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 3. Defer reply to indicate processing
		await interaction.deferReply({ ephemeral: true });

		// 4. Load server's Tomori state to check personalization setting
		const tomoriState: TomoriState | null = await loadTomoriState(
			interaction.guild.id,
		);

		// 5. Store the old nickname for the success message
		const oldNickname = userData.user_nickname;

		// 6. Update the user's nickname in the database using Bun SQL

		const [updatedResult] = await sql`
            UPDATE users
            SET user_nickname = ${newNickname}
            WHERE user_id = ${
							// biome-ignore lint/style/noNonNullAssertion: <explanation>
							userData.user_id!
						}
            RETURNING *
        `;

		// 7. Validate the result from the database
		const validationResult = userSchema.safeParse(updatedResult);

		if (!validationResult.success) {
			const context: ErrorContext = {
				userId: userData.user_id,
				serverId: tomoriState?.server_id, // Include server ID if available
				errorType: "DatabaseValidationError",
				metadata: {
					command: "teach personalnickname",
					userDiscordId: interaction.user.id,
					newNickname,
					validationErrors: validationResult.error.issues,
				},
			};
			await log.error(
				"Failed to validate updated user data for user_nickname",
				validationResult.error,
				context,
			);

			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.update_failed_title",
				descriptionKey: "general.errors.update_failed_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 10. Success! Show the nickname change (with potential warning)
		await replyInfoEmbed(interaction, locale, {
			titleKey: "commands.teach.personalnickname.success_title",
			descriptionKey: "commands.teach.personalnickname.success_description", // Use the potentially modified description
			descriptionVars: {
				old_nickname: oldNickname,
				new_nickname: newNickname,
			},
			color: ColorCode.SUCCESS,
			flags: MessageFlags.Ephemeral,
		});
	} catch (error) {
		// Rule 22: Log error with context
		const context: ErrorContext = {
			userId: userData.user_id,
			errorType: "CommandExecutionError",
			metadata: {
				command: "teach personalnickname",
				userDiscordId: interaction.user.id,
				guildId: interaction.guild?.id, // Add guild ID for context
			},
		};
		await log.error("Error in /teach personalnickname command", error, context);

		// Rule 12 & 19: Use helper for unknown error embed
		if (interaction.replied || interaction.deferred) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.unknown_error_title",
				descriptionKey: "general.errors.unknown_error_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
		} else {
			log.warn(
				"Interaction was not replied or deferred, cannot send error message to user.",
				context,
			);
		}
	}
}
