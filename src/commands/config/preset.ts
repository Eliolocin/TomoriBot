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
	replyPaginatedChoices,
} from "../../utils/discord/interactionHelper";
import {
	type UserRow,
	type ErrorContext,
	tomoriSchema,
} from "../../types/db/schema";
import { sql } from "bun";

// Configure the subcommand
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("preset")
		.setDescription(
			localizer("en-US", "commands.config.preset.description"),
		);

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
	// 1. Ensure command is run in a guild
	if (!interaction.guild || !interaction.channel) {
		await replyInfoEmbed(interaction, locale, {
			titleKey: "general.errors.guild_only_title",
			descriptionKey: "general.errors.guild_only",
			color: ColorCode.ERROR,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	try {
		// 3. Show ephemeral processing message
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		// 4. Load the Tomori state for this server
		const tomoriState = await loadTomoriState(interaction.guild.id);
		if (!tomoriState) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.not_setup_title",
				descriptionKey: "general.errors.not_setup_description",
				color: ColorCode.ERROR,
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

		// 7. Prepare display items for presets
		const displayItems = presets.map(
			(preset: { tomori_preset_name: string; tomori_preset_desc: string }) =>
				`${preset.tomori_preset_name}: ${preset.tomori_preset_desc.substring(0, 80)}${preset.tomori_preset_desc.length > 80 ? "..." : ""}`,
		);

		// 8. Use replyPaginatedChoices for preset selection
		const result = await replyPaginatedChoices(interaction, locale, {
			titleKey: "commands.config.preset.select_title",
			descriptionKey: "commands.config.preset.select_description", // Includes warning about overwriting
			itemLabelKey: "commands.config.preset.preset_label",
			items: displayItems,
			color: ColorCode.WARN, // Warning color to emphasize data overwrite
			flags: MessageFlags.Ephemeral,

			onSelect: async (selectedIndex) => {
				const selectedPreset = presets[selectedIndex];

				// Create attribute list with description as first element (Rule 23)
				const attributesWithDescription = [
					`{bot}'s Description: ${selectedPreset.tomori_preset_desc}`,
					...selectedPreset.preset_attribute_list,
				];

				// Format arrays for PostgreSQL update (Rule 23)
				const attributeArrayLiteral = `{${attributesWithDescription
					.map((item: string) => `"${item.replace(/(["\\])/g, "\\$1")}"`)
					.join(",")}}`;

				const inArrayLiteral = `{${selectedPreset.preset_sample_dialogues_in
					.map((item: string) => `"${item.replace(/(["\\])/g, "\\$1")}"`)
					.join(",")}}`;

				const outArrayLiteral = `{${selectedPreset.preset_sample_dialogues_out
					.map((item: string) => `"${item.replace(/(["\\])/g, "\\$1")}"`)
					.join(",")}}`;

				// Update Tomori in the database
				const [updatedTomoriResult] = await sql`
					UPDATE tomoris
					SET 
						attribute_list = ${attributeArrayLiteral}::text[],
						sample_dialogues_in = ${inArrayLiteral}::text[],
						sample_dialogues_out = ${outArrayLiteral}::text[]
					WHERE tomori_id = ${tomoriState.tomori_id}
					RETURNING *
				`;

				// Validate the result
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
					throw await log.error(
						"Failed to validate updated tomori data after applying preset",
						validationResult.success
							? new Error("Database update returned no rows or unexpected data")
							: new Error("Updated tomori data failed validation"),
						context,
					);
				}

				// Log success
				log.success(
					`Applied preset "${selectedPreset.tomori_preset_name}" to server ${tomoriState.server_id} by user ${userData.user_disc_id}`,
				);
				// replyPaginatedChoices handles the success message
			},

			// Handle cancel
			onCancel: async () => {
				log.info(
					`User ${userData.user_disc_id} cancelled preset selection for server ${tomoriState.server_id}`,
				);
				// replyPaginatedChoices handles the cancellation message
			},
		});

		// 9. Handle potential errors from the helper
		if (!result.success && result.reason === "error") {
			log.warn(
				`replyPaginatedChoices reported an error for user ${userData.user_disc_id} in /config preset`,
			);
		} else if (!result.success && result.reason === "timeout") {
			log.warn(
				`Preset selection timed out for user ${userData.user_disc_id} (Server ID: ${tomoriState.server_id})`,
			);
		}
	} catch (error) {
		// 10. Log error with context
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
				guildId: interaction.guild?.id,
				executorDiscordId: interaction.user.id,
			},
		};
		await log.error(
			`Error executing /config preset for user ${userData.user_disc_id}`,
			error as Error,
			context,
		);

		// 11. Inform user of unknown error
		if (interaction.deferred || interaction.replied) {
			try {
				await interaction.followUp({
					content: localizer(
						locale,
						"general.errors.unknown_error_description",
					),
					flags: MessageFlags.Ephemeral,
				});
			} catch (followUpError) {
				log.error(
					"Failed to send follow-up error message in preset catch block",
					followUpError,
				);
			}
		} else {
			log.warn(
				"Interaction was not replied or deferred in preset catch block",
				context,
			);
		}
	}
}
