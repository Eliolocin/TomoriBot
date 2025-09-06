import {
	MessageFlags,
	type ChatInputCommandInteraction,
	type Client,
	type SlashCommandSubcommandBuilder,
} from "discord.js";
import { loadTomoriState } from "../../utils/db/dbRead";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import {
	replyInfoEmbed,
	promptWithRawModal,
	safeSelectOptionText,
} from "../../utils/discord/interactionHelper";
import {
	type UserRow,
	type ErrorContext,
	tomoriSchema,
	type TomoriPresetRow,
} from "../../types/db/schema";
import type { SelectOption } from "../../types/discord/modal";
import { sql } from "bun";

// Modal configuration constants
const MODAL_CUSTOM_ID = "config_preset_modal";
const PRESET_SELECT_ID = "preset_select";

// Configure the subcommand
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("preset")
		.setDescription(localizer("en-US", "commands.config.preset.description"));

/**
 * Applies a preset personality configuration to Tomori.
 * Overwrites the current Attribute List and Sample Dialogues with preset values.
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
		await replyInfoEmbed(interaction, locale, {
			titleKey: "general.errors.channel_only_title",
			descriptionKey: "general.errors.channel_only_description",
			color: ColorCode.ERROR,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	try {
		// 2. Load the Tomori state for this server
		const tomoriState = await loadTomoriState(interaction.guild?.id ?? interaction.user.id);
		if (!tomoriState) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.tomori_not_setup_title",
				descriptionKey: "general.errors.tomori_not_setup_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 5. Fetch available presets for the user's locale
		// First try exact match (e.g., 'en-US')
		let presets = await sql`
            SELECT * FROM tomori_presets
            WHERE preset_language = ${locale}
            ORDER BY tomori_preset_name ASC
        `;

		// If no exact match, try language base (e.g., 'en' from 'en-US')
		if (presets.length === 0) {
			const baseLanguage = locale.split("-")[0];
			presets = await sql`
                SELECT * FROM tomori_presets
                WHERE preset_language = ${baseLanguage}
                ORDER BY tomori_preset_name ASC
            `;
		}

		// If still no presets, fall back to 'en'
		if (presets.length === 0 && locale !== "en") {
			presets = await sql`
                SELECT * FROM tomori_presets
                WHERE preset_language = 'en'
                ORDER BY tomori_preset_name ASC
            `;
		}

		// 6. Check if there are any presets available
		if (presets.length === 0) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.preset.no_presets_title",
				descriptionKey: "commands.config.preset.no_presets_description",
				color: ColorCode.WARN,
			});
			return;
		}

		// 7. Create preset options for the select menu using full descriptions
		const presetSelectOptions: SelectOption[] = presets.map(
			(preset: TomoriPresetRow) => ({
				label: safeSelectOptionText(preset.tomori_preset_name),
				value: safeSelectOptionText(preset.tomori_preset_name),
				description: safeSelectOptionText(preset.tomori_preset_desc),
			}),
		);

		// 8. Show the modal with preset selection
		const modalResult = await promptWithRawModal(interaction, locale, {
			modalCustomId: MODAL_CUSTOM_ID,
			modalTitleKey: "commands.config.preset.modal_title",
			components: [
				{
					customId: PRESET_SELECT_ID,
					labelKey: "commands.config.preset.select_label",
					descriptionKey: "commands.config.preset.select_description",
					placeholder: "commands.config.preset.select_placeholder",
					required: true,
					options: presetSelectOptions,
				},
			],
		});

		// 9. Handle modal outcome
		if (modalResult.outcome !== "submit") {
			log.info(
				`Preset selection modal ${modalResult.outcome} for user ${userData.user_id}`,
			);
			return;
		}

		// Extract values from the modal
		// biome-ignore lint/style/noNonNullAssertion: Modal submission outcome "submit" guarantees these values exist
		const modalSubmitInteraction = modalResult.interaction!;
		// biome-ignore lint/style/noNonNullAssertion: Modal submission outcome "submit" guarantees these values exist
		const selectedPresetName = modalResult.values![PRESET_SELECT_ID];

		// 10. Find the selected preset - let helper functions manage interaction state
		const selectedPreset = presets.find(
			(preset: TomoriPresetRow) =>
				preset.tomori_preset_name === selectedPresetName,
		);

		if (!selectedPreset) {
			await modalSubmitInteraction.editReply({
				content: localizer(locale, "commands.config.preset.preset_not_found"),
			});
			return;
		}

		// 11. Create attribute list with description as first element (Rule 23)
		const attributesWithDescription = [
			`{bot}'s Description: ${selectedPreset.tomori_preset_desc}`,
			...selectedPreset.preset_attribute_list,
		];

		// 12. Format arrays for PostgreSQL update (Rule 23)
		const attributeArrayLiteral = `{${attributesWithDescription
			.map((item: string) => `"${item.replace(/(["\\])/g, "\\$1")}"`)
			.join(",")}}`;

		const inArrayLiteral = `{${selectedPreset.preset_sample_dialogues_in
			.map((item: string) => `"${item.replace(/(["\\])/g, "\\$1")}"`)
			.join(",")}}`;

		const outArrayLiteral = `{${selectedPreset.preset_sample_dialogues_out
			.map((item: string) => `"${item.replace(/(["\\])/g, "\\$1")}"`)
			.join(",")}}`;

		// 13. Update Tomori in the database
		const [updatedTomoriResult] = await sql`
			UPDATE tomoris
			SET 
				attribute_list = ${attributeArrayLiteral}::text[],
				sample_dialogues_in = ${inArrayLiteral}::text[],
				sample_dialogues_out = ${outArrayLiteral}::text[]
			WHERE tomori_id = ${tomoriState.tomori_id}
			RETURNING *
		`;

		// 14. Validate the result
		const validationResult = tomoriSchema.safeParse(updatedTomoriResult);

		if (!validationResult.success || !updatedTomoriResult) {
			const context: ErrorContext = {
				userId: userData.user_id,
				serverId: tomoriState.server_id,
				tomoriId: tomoriState.tomori_id,
				errorType: "DatabaseValidationError",
				metadata: {
					command: "config preset",
					preset: selectedPreset.tomori_preset_name,
					presetId: selectedPreset.tomori_preset_id,
					validationErrors: validationResult.success
						? null
						: validationResult.error.flatten(),
				},
			};
			await log.error(
				"Failed to validate updated tomori data after applying preset",
				validationResult.success
					? new Error("Database update returned no rows or unexpected data")
					: new Error("Updated tomori data failed validation"),
				context,
			);

			await replyInfoEmbed(modalSubmitInteraction, locale, {
				titleKey: "general.errors.update_failed_title",
				descriptionKey: "general.errors.update_failed_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 15. Log success and show success message
		log.success(
			`Applied preset "${selectedPreset.tomori_preset_name}" to server ${tomoriState.server_id} by user ${userData.user_disc_id}`,
		);

		await replyInfoEmbed(modalSubmitInteraction, locale, {
			titleKey: "commands.config.preset.success_title",
			descriptionKey: "commands.config.preset.success_description",
			descriptionVars: {
				preset_name: selectedPreset.tomori_preset_name,
			},
			color: ColorCode.SUCCESS,
		});
	} catch (error) {
		// 16. Log error with context
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
				command: "config preset",
				guildId: interaction.guild?.id ?? interaction.user.id,
				executorDiscordId: interaction.user.id,
			},
		};
		await log.error(
			`Error executing /config preset for user ${userData.user_disc_id}`,
			error as Error,
			context,
		);

		// 17. Inform user of unknown error
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
