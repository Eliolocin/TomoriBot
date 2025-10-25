import {
	MessageFlags,
	type ChatInputCommandInteraction,
	type Client,
	type SlashCommandSubcommandBuilder,
} from "discord.js";
import { loadTomoriState, loadPresetRowsByLocale } from "../../utils/db/dbRead";
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
const MODAL_CUSTOM_ID = "preset_default_modal";
const PRESET_SELECT_ID = "preset_select";

// Configure the subcommand
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("default")
		.setDescription(localizer("en-US", "commands.preset.default.description"));

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

		// 5. Fetch available presets for the user's locale using shared helper
		const presets = await loadPresetRowsByLocale(locale);

		// 6. Check if there are any presets available
		if (!presets || presets.length === 0) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.preset.default.no_presets_title",
				descriptionKey: "commands.preset.default.no_presets_description",
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
			modalTitleKey: "commands.preset.default.modal_title",
			components: [
				{
					customId: PRESET_SELECT_ID,
					labelKey: "commands.preset.default.select_label",
					descriptionKey: "commands.preset.default.select_description",
					placeholder: "commands.preset.default.select_placeholder",
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
				content: localizer(locale, "commands.preset.default.preset_not_found"),
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
					command: "preset default",
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

		// 15. Reset guild avatar and server nickname to none
		try {
			// Reset server nickname if in a guild
			if (interaction.guild?.members.me) {
				await interaction.guild.members.me.setNickname(null);
				log.info(
					`Reset server nickname for guild ${interaction.guild.id} after applying preset`,
				);
			}

			// Reset guild-specific avatar to none using Discord API
			if (interaction.guild) {
				const endpoint = `https://discord.com/api/v10/guilds/${interaction.guild.id}/members/@me`;
				const response = await fetch(endpoint, {
					method: "PATCH",
					headers: {
						Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ avatar: null }),
				});

				if (response.ok) {
					log.info(
						`Reset guild avatar for guild ${interaction.guild.id} after applying preset`,
					);
				} else {
					log.warn(
						`Failed to reset guild avatar: ${response.status} ${response.statusText}`,
					);
				}
			}
		} catch (avatarError) {
			// Log avatar/nickname reset errors but don't fail the command
			log.warn(
				`Failed to reset avatar or nickname after applying preset: ${avatarError}`,
			);
		}

		// 16. Log success and show success message
		log.success(
			`Applied preset "${selectedPreset.tomori_preset_name}" to server ${tomoriState.server_id} by user ${userData.user_disc_id}`,
		);

		await replyInfoEmbed(modalSubmitInteraction, locale, {
			titleKey: "commands.preset.default.success_title",
			descriptionKey: "commands.preset.default.success_description",
			descriptionVars: {
				preset_name: selectedPreset.tomori_preset_name,
			},
			color: ColorCode.SUCCESS,
		});
	} catch (error) {
		// 17. Log error with context
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
				command: "preset default",
				guildId: interaction.guild?.id ?? interaction.user.id,
				executorDiscordId: interaction.user.id,
			},
		};
		await log.error(
			`Error executing /preset default for user ${userData.user_disc_id}`,
			error as Error,
			context,
		);

		// 18. Inform user of unknown error
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
