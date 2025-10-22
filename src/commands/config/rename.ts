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
	tomoriSchema,
	tomoriConfigSchema,
} from "../../types/db/schema";
import { sql } from "bun";

// Constants for validation
const NICKNAME_MIN_LENGTH = 2;
const NICKNAME_MAX_LENGTH = 32;

// Configure the subcommand
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("rename")
		.setDescription(localizer("en-US", "commands.config.rename.description"))
		.addStringOption((option) =>
			option
				.setName("name")
				.setDescription(
					localizer("en-US", "commands.config.rename.option_description"),
				)
				.setDescriptionLocalizations({
					ja: localizer("ja", "commands.config.rename.option_description"),
				})
				.setRequired(true)
				.setMinLength(NICKNAME_MIN_LENGTH)
				.setMaxLength(NICKNAME_MAX_LENGTH),
		);

/**
 * Changes what Tomori refers to herself in context and in chat.
 * Also adds the new nickname to her trigger words if not already present.
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
	// 1. Ensure command is run in a channel
	if (!interaction.channel) {
		await replyInfoEmbed(interaction, userData.language_pref, {
			titleKey: "general.errors.channel_only_title",
			descriptionKey: "general.errors.channel_only_description",
			color: ColorCode.ERROR,
		});
		return;
	}

	try {
		// 2. Get the new nickname from the command options
		const newNickname = interaction.options.getString("name", true);

		// 3. Validate nickname length (redundant check for safety)
		if (
			newNickname.length < NICKNAME_MIN_LENGTH ||
			newNickname.length > NICKNAME_MAX_LENGTH
		) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.rename.invalid_length_title",
				descriptionKey: "commands.config.rename.invalid_length",
				descriptionVars: {
					min: NICKNAME_MIN_LENGTH.toString(),
					max: NICKNAME_MAX_LENGTH.toString(),
				},
				color: ColorCode.ERROR,
			});
			return;
		}

		// 4. Load the Tomori state for this server - let helper functions manage interaction state
		const tomoriState = await loadTomoriState(interaction.guild?.id ?? interaction.user.id);
		if (!tomoriState) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.tomori_not_setup_title",
				descriptionKey: "general.errors.tomori_not_setup_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 6. Store the old nickname for the success message
		const oldNickname = tomoriState.tomori_nickname;

		// 7. Check if the nickname is actually changing
		if (newNickname === oldNickname) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.rename.already_set_title",
				descriptionKey: "commands.config.rename.already_set_description",
				descriptionVars: {
					nickname: newNickname,
				},
				color: ColorCode.WARN,
			});
			return;
		}

		// --- Transaction Start (Conceptually) ---
		// We perform two separate updates, but ideally this would be a transaction
		// if the database supported it easily with Bun's current driver.

		// 8. Update the nickname in the `tomoris` table using direct SQL (Rule #4, #15)
		const [updatedTomoriRow] = await sql`
            UPDATE tomoris
            SET tomori_nickname = ${newNickname}
            WHERE tomori_id = ${tomoriState.tomori_id}
            RETURNING *
        `;

		// 9. Validate the returned `tomoris` data (Rules #3, #5)
		const validatedTomori = tomoriSchema.safeParse(updatedTomoriRow);

		if (!validatedTomori.success || !updatedTomoriRow) {
			// Log error specific to tomoris update failure
			const context: ErrorContext = {
				tomoriId: tomoriState.tomori_id,
				serverId: tomoriState.server_id,
				userId: userData.user_id,
				errorType: "DatabaseUpdateError",
				metadata: {
					command: "config nickname",
					table: "tomoris",
					guildId: interaction.guild?.id ?? interaction.user.id,
					newNickname,
					validationErrors: validatedTomori.success
						? null
						: validatedTomori.error.flatten(),
				},
			};
			await log.error(
				"Failed to update or validate tomori_nickname in tomoris table",
				validatedTomori.success
					? new Error("Database update returned no rows or unexpected data")
					: new Error("Updated tomori data failed validation"),
				context,
			);

			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.update_failed_title",
				descriptionKey: "general.errors.update_failed_description",
				color: ColorCode.ERROR,
			});
			return; // Stop if the primary update failed
		}

		// 10. Add new nickname to trigger words if not already present
		const currentTriggers = tomoriState.config.trigger_words ?? [];
		let triggerUpdateNeeded = false;
		const updatedTriggers = [...currentTriggers]; // Create a mutable copy

		// Case-insensitive check if the nickname exists
		if (
			!currentTriggers.some(
				(trigger) => trigger.toLowerCase() === newNickname.toLowerCase(),
			)
		) {
			updatedTriggers.push(newNickname);
			triggerUpdateNeeded = true;
			log.info(
				`Adding new nickname '${newNickname}' to trigger words for tomori ${tomoriState.tomori_id}`,
			);
		} else {
			log.info(
				`Nickname '${newNickname}' already exists in trigger words for tomori ${tomoriState.tomori_id}. Skipping update.`,
			);
		}

		// 11. Update trigger_words in `tomori_configs` if needed (Rule #4, #15, #23)
		if (triggerUpdateNeeded) {
			// Construct properly escaped PostgreSQL array literal (Rule #23)
			const [updatedConfigRow] = await sql`
            UPDATE tomori_configs
            SET trigger_words = array_append(trigger_words, ${newNickname})
            WHERE tomori_id = ${tomoriState.tomori_id}
            RETURNING *
        `;

			// 12. Validate the returned `tomori_configs` data (Rules #3, #5)
			const validatedConfig = tomoriConfigSchema.safeParse(updatedConfigRow);

			if (!validatedConfig.success || !updatedConfigRow) {
				// Log error specific to tomori_configs update failure
				const context: ErrorContext = {
					tomoriId: tomoriState.tomori_id,
					serverId: tomoriState.server_id,
					userId: userData.user_id,
					errorType: "DatabaseUpdateError",
					metadata: {
						command: "config nickname",
						table: "tomori_configs",
						column: "trigger_words",
						guildId: interaction.guild?.id ?? interaction.user.id,
						newNickname,
						updatedTriggers, // Log the array we tried to set
						validationErrors: validatedConfig.success
							? null
							: validatedConfig.error.flatten(),
					},
				};
				// Log this as a warning since the primary nickname update succeeded,
				// but inform the user of the partial failure.
				await log.error(
					"Failed to update or validate trigger_words in tomori_configs table",
					validatedConfig.success
						? new Error("Database update returned no rows or unexpected data")
						: new Error("Updated config data failed validation"),
					context,
				);

				// Inform user about partial success
				await replyInfoEmbed(interaction, locale, {
					titleKey: "commands.config.rename.partial_success_title",
					descriptionKey: "commands.config.rename.partial_success_description",
					descriptionVars: {
						old_nickname: oldNickname,
						new_nickname: newNickname,
					},
					color: ColorCode.WARN, // Use WARN for partial success
				});
				return; // Stop execution after informing about partial success
			}
			log.success(
				`Successfully updated trigger words for tomori ${tomoriState.tomori_id}`,
			);
		}
		// --- Transaction End (Conceptually) ---

		// 13. Update bot's server nickname if in a guild
		let nicknameUpdateSuccess = false;
		if (interaction.guild) {
			try {
				const botMember = await interaction.guild.members.fetchMe();
				if (botMember) {
					await botMember.setNickname(newNickname);
					nicknameUpdateSuccess = true;
					log.success(
						`Successfully updated bot nickname to '${newNickname}' in guild ${interaction.guild.id}`,
					);
				}
			} catch (nicknameError) {
				// Log the error but don't fail the entire command
				await log.warn(
					`Failed to update bot's server nickname in guild ${interaction.guild.id} (permissions issue or API error): ${(nicknameError as Error).message}`,
				);
			}
		}

		// 14. Success! Show the nickname change (covers both nickname and trigger word update if applicable)
		await replyInfoEmbed(interaction, locale, {
			titleKey: "commands.config.rename.success_title",
			descriptionKey: nicknameUpdateSuccess
				? triggerUpdateNeeded
					? "commands.config.rename.success_with_trigger_and_discord_description"
					: "commands.config.rename.success_with_discord_description"
				: triggerUpdateNeeded
					? "commands.config.rename.success_with_trigger_description"
					: "commands.config.rename.success_description",
			descriptionVars: {
				old_nickname: oldNickname,
				new_nickname: newNickname,
			},
			color: ColorCode.SUCCESS,
			footerKey: !nicknameUpdateSuccess && interaction.guild
				? "commands.config.rename.nickname_update_failed_footer"
				: undefined,
		});
	} catch (error) {
		// 14. Log error with context (Rule #22)
		// ... (error logging remains largely the same, maybe add which step failed if possible) ...
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
				command: "config nickname",
				guildId: interaction.guild?.id ?? interaction.user.id,
				executorDiscordId: interaction.user.id,
				nicknameAttempted: interaction.options.getString("name"),
				// Consider adding a 'stepFailed' field here if easily trackable
			},
		};
		await log.error(
			`Error executing /config nickname for user ${userData.user_disc_id}`,
			error as Error,
			context,
		);

		// 15. Inform user of unknown error
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
