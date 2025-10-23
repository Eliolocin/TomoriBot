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
	type TomoriState,
} from "../../types/db/schema";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import { replyInfoEmbed } from "../../utils/discord/interactionHelper";
import { loadTomoriState } from "../../utils/db/dbRead";

// Rule 20: Constants for static values at the top
const NICKNAME_MIN_LENGTH = 2;
const NICKNAME_MAX_LENGTH = 32;

// Rule 21: Configure the subcommand (Using updated localization keys)
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("nickname") // Keep name simple as per refactor
		.setDescription(localizer("en-US", "commands.teach.nickname.description"))
		.addStringOption((option) =>
			option
				.setName("name")
				.setDescription(
					localizer("en-US", "commands.teach.nickname.option_description"),
				)
				.setRequired(true)
				.setMinLength(NICKNAME_MIN_LENGTH)
				.setMaxLength(NICKNAME_MAX_LENGTH),
		);

/**
 * Rule 1: JSDoc comment for exported function
 * Updates how Tomori refers to the user.
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
	// Ensure command is run in a valid channel context
	if (!interaction.channel) {
		await replyInfoEmbed(interaction, locale, {
			titleKey: "general.errors.channel_only_title",
			descriptionKey: "general.errors.channel_only_description",
			color: ColorCode.ERROR,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	let tomoriState: TomoriState | null = null; // Define outside for catch block

	try {
		// 1. Get the new nickname from the command options
		const newNickname = interaction.options.getString("name", true);

		// 2. Validate nickname length (redundant check, Discord handles this, but good for safety)
		// Let helper functions manage interaction state
		if (
			newNickname.length < NICKNAME_MIN_LENGTH ||
			newNickname.length > NICKNAME_MAX_LENGTH
		) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.teach.nickname.invalid_length_title",
				descriptionKey: "commands.teach.nickname.invalid_length",
				descriptionVars: {
					min: NICKNAME_MIN_LENGTH.toString(),
					max: NICKNAME_MAX_LENGTH.toString(),
				},
				color: ColorCode.ERROR,
				// No flags needed, already deferred
			});
			return;
		}

		// 4. Load server's Tomori state to check personalization setting
		tomoriState = await loadTomoriState(
			interaction.guild?.id ?? interaction.user.id,
		);

		// 5. Check if Tomori is set up (needed for config check)
		if (!tomoriState) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.tomori_not_setup_title",
				descriptionKey: "general.errors.tomori_not_setup_description",
				color: ColorCode.ERROR,
				// No flags needed
			});
			return;
		}

		// 6. Store the old nickname for the success message
		const oldNickname = userData.user_nickname;

		// 7. Update the user's nickname in the database using Bun SQL
		const [updatedResult] = await sql`
            UPDATE users
            SET user_nickname = ${newNickname}
            WHERE user_id = ${userData.user_id}
            RETURNING *
        `;

		// 8. Validate the result from the database
		const validationResult = userSchema.safeParse(updatedResult);

		if (!validationResult.success) {
			const context: ErrorContext = {
				userId: userData.user_id,
				serverId: tomoriState.server_id, // Include server ID
				tomoriId: tomoriState.tomori_id, // Include tomori ID
				errorType: "DatabaseValidationError",
				metadata: {
					command: "teach nickname",
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
				// No flags needed
			});
			return;
		}

		// 9. Check if personalization is disabled on this server and prepare message
		let descriptionKey = "commands.teach.nickname.success_description";
		let embedColor = ColorCode.SUCCESS;

		// Assuming 'personalization_enabled' is the single config key
		// biome-ignore lint/style/noNonNullAssertion: tomoriState checked earlier
		if (!tomoriState!.config.personal_memories_enabled) {
			descriptionKey =
				"commands.teach.nickname.success_but_disabled_description"; // Use the warning description
			embedColor = ColorCode.WARN; // Use warning color
		}

		// 10. Success! Show the nickname change (with potential warning)
		await replyInfoEmbed(interaction, locale, {
			titleKey: "commands.teach.nickname.success_title",
			descriptionKey: descriptionKey, // Use the determined description key
			descriptionVars: {
				old_nickname: oldNickname,
				new_nickname: newNickname,
			},
			color: embedColor, // Use the determined color
			// No flags needed
		});
	} catch (error) {
		// Rule 22: Log error with context
		const context: ErrorContext = {
			userId: userData.user_id,
			serverId: tomoriState?.server_id, // Use optional chaining
			tomoriId: tomoriState?.tomori_id, // Use optional chaining
			errorType: "CommandExecutionError",
			metadata: {
				command: "teach nickname",
				userDiscordId: interaction.user.id,
				guildId: interaction.guild?.id,
			},
		};
		await log.error("Error in /teach nickname command", error, context);

		// Rule 12 & 19: Use helper for unknown error embed
		// Use followUp since we deferred initially
		if (interaction.deferred || interaction.replied) {
			try {
				await interaction.followUp({
					// Use followUp
					content: localizer(
						locale,
						"general.errors.unknown_error_description",
					),
					flags: MessageFlags.Ephemeral,
				});
			} catch (followUpError) {
				log.error(
					"Failed to send follow-up error message in nickname catch block",
					followUpError,
				);
			}
		} else {
			// This case should be rare after initial deferReply
			log.warn(
				"Interaction was not replied or deferred in nickname catch block, cannot send error message.",
				context,
			);
		}
	}
}
