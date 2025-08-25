import {
	MessageFlags,
	type ChatInputCommandInteraction,
	type Client,
	type SlashCommandSubcommandBuilder,
} from "discord.js";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import {
	replyInfoEmbed,
	replyPaginatedChoices,
} from "../../utils/discord/interactionHelper";
import { loadTomoriState } from "../../utils/db/dbRead";
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
		.setName("triggerdelete")
		.setDescription(
			localizer("en-US", "commands.config.triggerdelete.description"),
		);

/**
 * Removes trigger word from database using a Paginated embed
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
		// 2. Show ephemeral processing message (Rule #21 modification)
		// Note: replyPaginatedChoices will handle the actual reply/edit
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		// 3. Load the Tomori state for this server (Rule #17)
		const tomoriState = await loadTomoriState(interaction.guild.id);
		if (!tomoriState) {
			await replyInfoEmbed(
				interaction,
				locale,
				{
					titleKey: "general.errors.tomori_not_setup_title",
					descriptionKey: "general.errors.tomori_not_setup",
					color: ColorCode.ERROR,
				},
				MessageFlags.Ephemeral,
			);
			return;
		}

		// 4. Get the current trigger words
		const currentTriggerWords = tomoriState.config.trigger_words ?? []; // Use ?? [] for safety

		// 5. Check if there are any trigger words to remove
		if (currentTriggerWords.length === 0) {
			await replyInfoEmbed(
				interaction,
				locale,
				{
					titleKey: "commands.config.triggerdelete.no_triggers_title",
					descriptionKey: "commands.config.triggerdelete.no_triggers",
					color: ColorCode.WARN,
				},
				MessageFlags.Ephemeral,
			);
			return;
		}

		// 6. Use the replyPaginatedChoices helper (pass ephemeral flag)
		const result = await replyPaginatedChoices(interaction, locale, {
			titleKey: "commands.config.triggerdelete.select_title",
			descriptionKey: "commands.config.triggerdelete.select_description", // Ensure this key has {{items}} in locale file
			itemLabelKey: "commands.config.triggerdelete.trigger_words_label",
			items: currentTriggerWords,
			color: ColorCode.INFO,
			flags: MessageFlags.Ephemeral, // Make the pagination ephemeral
			onSelect: async (selectedIndex) => {
				// This runs when a user selects an item
				const wordToRemove = currentTriggerWords[selectedIndex];

				// 7. Create a new array without the selected word
				const updatedTriggerWords = currentTriggerWords.filter(
					(_, index) => index !== selectedIndex, // More robust filtering by index
				);

				// 9. Update the config in the database using direct SQL (Rule #4, #15)
				const [updatedRow] = await sql`
					UPDATE tomori_configs
					SET trigger_words = array_remove(trigger_words, ${wordToRemove})
					WHERE tomori_id = ${tomoriState.tomori_id}
					RETURNING *
				`;

				// 10. Validate the returned data (Rules #3, #5)
				const validatedConfig = tomoriConfigSchema.safeParse(updatedRow);

				if (!validatedConfig.success || !updatedRow) {
					// Log error specific to this update failure
					const context: ErrorContext = {
						tomoriId: tomoriState.tomori_id,
						serverId: tomoriState.server_id,
						userId: userData.user_id,
						errorType: "DatabaseUpdateError",
						metadata: {
							command: "config triggerdelete",
							guildId: interaction.guild?.id,
							wordToRemove,
							updatedTriggerWords, // Log the array we tried to set
							validationErrors: validatedConfig.success
								? null
								: validatedConfig.error.flatten(),
						},
					};
					// Throw error to be caught by replyPaginatedChoices's handler
					throw await log.error(
						"Failed to update or validate trigger_words in tomori_configs table",
						validatedConfig.success
							? new Error("Database update returned no rows or unexpected data")
							: new Error("Updated config data failed validation"),
						context,
					);
				}

				// 11. Log success (onSelect doesn't handle user feedback directly)
				log.success(
					`Removed trigger word "${wordToRemove}" for tomori ${tomoriState.tomori_id} by user ${userData.user_disc_id}`,
				);
				// The replyPaginatedChoices helper will show the success message
			},
			onCancel: async () => {
				// This runs if the user clicks Cancel
				log.info(
					`User ${userData.user_disc_id} cancelled removing a trigger word for tomori ${tomoriState.tomori_id}`,
				);
				// The replyPaginatedChoices helper will show the cancellation message
			},
		});

		// 12. Handle potential errors from the helper itself (e.g., Discord API errors)
		if (!result.success && result.reason === "error") {
			// Error should have already been logged by the helper or the onSelect callback
			// No need to log again here unless providing additional context
			log.warn(
				`replyPaginatedChoices reported an error for user ${userData.user_disc_id} in /config triggerdelete`,
			);
			// The helper should have already informed the user
		} else if (!result.success && result.reason === "timeout") {
			// Log timeout specifically if needed
			log.warn(
				`Trigger word removal timed out for user ${userData.user_disc_id} (Tomori ID: ${tomoriState.tomori_id})`,
			);
			// The helper shows the timeout message
		}
	} catch (error) {
		// 13. Catch unexpected errors during setup or helper execution
		let serverIdForError: number | null = null;
		let tomoriIdForError: number | null = null;
		if (interaction.guild?.id) {
			// Avoid reloading state if possible, but reload if needed for context
			const state =
				(await loadTomoriState(interaction.guild.id).catch(() => null)) ?? null;
			serverIdForError = state?.server_id ?? null;
			tomoriIdForError = state?.tomori_id ?? null;
		}

		const context: ErrorContext = {
			userId: userData.user_id,
			serverId: serverIdForError,
			tomoriId: tomoriIdForError,
			errorType: "CommandExecutionError",
			metadata: {
				command: "config triggerdelete",
				guildId: interaction.guild?.id,
				executorDiscordId: interaction.user.id,
			},
		};
		// Log the error using the standard logger
		await log.error(
			`Unexpected error in /config triggerdelete for user ${userData.user_disc_id}`,
			error as Error, // Type assertion
			context,
		);

		// 14. Inform user of unknown error (use followUp since deferred)
		// Check if interaction is still available and not already replied
		if (interaction.deferred && !interaction.replied) {
			await interaction.followUp({
				content: localizer(locale, "general.errors.unknown_error_description"),
				flags: MessageFlags.Ephemeral,
			});
		}
	}
}
