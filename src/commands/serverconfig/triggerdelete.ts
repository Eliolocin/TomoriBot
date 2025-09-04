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
	promptWithPaginatedModal,
	safeSelectOptionText,
} from "../../utils/discord/interactionHelper";
import { loadTomoriState } from "../../utils/db/dbRead";
import {
	type UserRow,
	type ErrorContext,
	tomoriConfigSchema,
} from "../../types/db/schema";
import type { SelectOption } from "../../types/discord/modal";
import { sql } from "bun";

// Rule 20: Constants for static values at the top
const MODAL_CUSTOM_ID = "serverconfig_triggerdelete_modal";
const TRIGGER_SELECT_ID = "trigger_select";

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
			descriptionKey: "general.errors.guild_only_description",
			color: ColorCode.ERROR,
		});
		return;
	}

	try {
		// 2. Note: Modal will be the first response, so no early defer needed

		// 3. Load the Tomori state for this server (Rule #17)
		const tomoriState = await loadTomoriState(interaction.guild.id);
		if (!tomoriState) {
			await replyInfoEmbed(
				interaction,
				locale,
				{
					titleKey: "general.errors.tomori_not_setup_title",
					descriptionKey: "general.errors.tomori_not_setup_description",
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
					descriptionKey: "commands.config.triggerdelete.no_triggers_description",
					color: ColorCode.WARN,
				},
				MessageFlags.Ephemeral,
			);
			return;
		}

		// 6. Create trigger word select options for the modal
		const triggerWordSelectOptions: SelectOption[] = currentTriggerWords.map(
			(trigger, index) => ({
				label: safeSelectOptionText(trigger, 50),
				value: index.toString(), // Use index to avoid truncation issues
				description: safeSelectOptionText(trigger),
			}),
		);

		// 7. Show the paginated modal with trigger word selection
		const modalResult = await promptWithPaginatedModal(interaction, locale, {
			modalCustomId: MODAL_CUSTOM_ID,
			modalTitleKey: "commands.config.triggerdelete.modal_title",
			components: [
				{
					customId: TRIGGER_SELECT_ID,
					labelKey: "commands.config.triggerdelete.select_label",
					descriptionKey:
						"commands.config.triggerdelete.select_description",
					placeholder: "commands.config.triggerdelete.select_placeholder",
					required: true,
					options: triggerWordSelectOptions,
				},
			],
		});

		// 8. Handle modal outcome
		if (modalResult.outcome !== "submit") {
			log.info(
				`Trigger word deletion modal ${modalResult.outcome} for user ${userData.user_id}`,
			);
			return;
		}

		// 9. Extract values from the modal
		const modalSubmitInteraction = modalResult.interaction;
		const selectedIndex = modalResult.values?.[TRIGGER_SELECT_ID];

		// Safety checks (should never be null after submit outcome)
		if (!modalSubmitInteraction || !selectedIndex) {
			log.error("Modal result unexpectedly missing interaction or values");
			return;
		}

		// Get the trigger word to remove
		const selectedIndexNum = Number.parseInt(selectedIndex, 10);
		const wordToRemove = currentTriggerWords[selectedIndexNum];

		// 10. Defer the reply for the modal submission
		await modalSubmitInteraction.deferReply({
			flags: MessageFlags.Ephemeral,
		});

		// 11. Update the config in the database using direct SQL
		const [updatedRow] = await sql`
			UPDATE tomori_configs
			SET trigger_words = array_remove(trigger_words, ${wordToRemove})
			WHERE tomori_id = ${tomoriState.tomori_id}
			RETURNING *
		`;

		// 12. Validate the returned data
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
					selectedIndex: selectedIndexNum,
					validationErrors: validatedConfig.success
						? null
						: validatedConfig.error.flatten(),
				},
			};

			await log.error(
				"Failed to update or validate trigger_words in tomori_configs table",
				validatedConfig.success
					? new Error("Database update returned no rows or unexpected data")
					: new Error("Updated config data failed validation"),
				context,
			);

			await replyInfoEmbed(modalSubmitInteraction, locale, {
				titleKey: "general.errors.update_failed_title",
				descriptionKey: "general.errors.update_failed_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 13. Log success and show success message
		log.success(
			`Removed trigger word "${wordToRemove}" for tomori ${tomoriState.tomori_id} by user ${userData.user_disc_id}`,
		);

		await replyInfoEmbed(modalSubmitInteraction, locale, {
			titleKey: "commands.config.triggerdelete.success_title",
			descriptionKey: "commands.config.triggerdelete.success_description",
			descriptionVars: {
				triggerWord: wordToRemove,
			},
			color: ColorCode.SUCCESS,
		});
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
