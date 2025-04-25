import {
	type ChatInputCommandInteraction,
	type Client,
	PermissionsBitField,
	ActionRowBuilder,
	TextInputStyle,
	ModalBuilder,
	TextInputBuilder,
	MessageFlags,
} from "discord.js";
import { sql } from "bun";
import type { BaseCommand } from "../../types/discord/global";
import type {
	SetupConfig,
	TomoriPresetRow,
	UserRow,
} from "../../types/db/schema";
import { setupConfigSchema, tomoriPresetSchema } from "../../types/db/schema";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import {
	replyInfoEmbed,
	replySummaryEmbed,
} from "../../utils/discord/interactionHelper";
import { validateApiKey } from "../../providers/google";
import { encryptApiKey } from "../../utils/security/crypto";
import { setupServer } from "../../utils/db/configHelper";

/**
 * Command to guide users through the initial setup of TomoriBot for their server
 * @description Collects configuration and initializes TomoriBot's database state
 */
const command: BaseCommand = {
	name: "setup",
	description: localizer("en", "commands.setup.command_description"),
	category: "tool",
	permissionsRequired: [
		new PermissionsBitField(PermissionsBitField.Flags.ManageGuild),
	],
	callback: async (
		_client: Client,
		interaction: ChatInputCommandInteraction,
		userData: UserRow,
	): Promise<void> => {
		// Ensure command is run in a guild
		if (!interaction.guild || !interaction.channel) {
			await interaction.reply({
				content: localizer(interaction.locale, "errors.guild_only"),
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const locale = userData.language_pref ?? interaction.guildLocale ?? "en";

		// Check permissions again (belt-and-suspenders)
		const memberPermissions = interaction.member?.permissions;
		if (
			!memberPermissions ||
			!(memberPermissions instanceof PermissionsBitField) ||
			!memberPermissions.has(PermissionsBitField.Flags.ManageGuild)
		) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.setup.error_title",
				descriptionKey: "commands.setup.no_permission",
				color: ColorCode.ERROR,
			});
			return;
		}

		try {
			// First, load available presets for the server's locale (or fallback to English)
			// This helps us create an informative placeholder showing available options
			const presetRows = await sql`
				SELECT tomori_preset_id, tomori_preset_name, tomori_preset_desc, preset_language
				FROM tomori_presets
				WHERE preset_language = ${locale}
				ORDER BY tomori_preset_id
			`;

			// Validate preset data
			const availablePresets: TomoriPresetRow[] = presetRows.map(
				(row: Record<string, unknown>) => tomoriPresetSchema.parse(row),
			);

			if (availablePresets.length === 0) {
				log.warn(`No presets found for locale '${locale}'`);
				await interaction.reply({
					content: localizer(locale, "commands.setup.no_presets_found"),
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			// Create a placeholder showing available preset options
			const presetOptions = availablePresets
				.map((preset) => preset.tomori_preset_name)
				.join(", ");
			// Build a multi-line placeholder with name and description for each preset
			const presetPlaceholder = availablePresets
				.map((preset, i) => `${i + 1}. ${preset.tomori_preset_name}`)
				.join("\n");

			// Create a comprehensive single setup modal
			const modal = new ModalBuilder()
				.setCustomId("tomori_setup_modal")
				.setTitle(localizer(locale, "commands.setup.modal_title"));

			// API Key input
			const apiKeyInput = new TextInputBuilder()
				.setCustomId("api_key")
				.setLabel(localizer(locale, "commands.setup.api_key_label"))
				.setStyle(TextInputStyle.Short)
				.setPlaceholder("Enter your Gemini API Key")
				.setRequired(true);

			// Personality preset input as a large text area with detailed placeholder
			const presetInput = new TextInputBuilder()
				.setCustomId("preset_name")
				.setLabel(localizer(locale, "commands.setup.preset_label"))
				.setStyle(TextInputStyle.Paragraph) // Use Paragraph for large text area
				.setPlaceholder(presetPlaceholder.slice(0, 100)) // Discord limit: 400 chars
				.setRequired(true);

			// Humanizer toggle - make it clear it's a yes/no field
			const humanizerInput = new TextInputBuilder()
				.setCustomId("humanizer")
				.setLabel(localizer(locale, "commands.setup.humanizer_label"))
				.setStyle(TextInputStyle.Short)
				.setPlaceholder("Enter a value from 0 to 3.")
				//.setValue("yes")
				.setRequired(true);

			// Add inputs to the modal
			modal.addComponents(
				new ActionRowBuilder<TextInputBuilder>().addComponents(apiKeyInput),
				new ActionRowBuilder<TextInputBuilder>().addComponents(presetInput),
				new ActionRowBuilder<TextInputBuilder>().addComponents(humanizerInput),
			);

			// Show the modal
			await interaction.showModal(modal);

			// Wait for the modal submission
			try {
				const submission = await interaction.awaitModalSubmit({
					time: 300000, // 5 minutes to complete setup
					filter: (i) =>
						i.customId === "tomori_setup_modal" &&
						i.user.id === interaction.user.id,
				});

				// Process the submission
				await submission.deferReply({ ephemeral: true });

				// Extract values from the modal
				const apiKey = submission.fields.getTextInputValue("api_key");
				const presetName = submission.fields.getTextInputValue("preset_name");
				const humanizerText = submission.fields
					.getTextInputValue("humanizer")
					.trim();

				// Validate and transform inputs

				// 1. Validate API Key with length check and actual API test
				if (!apiKey || apiKey.length < 10) {
					await submission.editReply({
						content: localizer(locale, "commands.setup.api_key_invalid"),
					});
					return;
				}

				// Test the API key with a real API call to Google
				await submission.editReply({
					content: localizer(locale, "commands.setup.api_key_validating"),
				});

				const isApiKeyValid = await validateApiKey(apiKey);
				if (!isApiKeyValid) {
					await submission.editReply({
						content: localizer(locale, "commands.setup.api_key_invalid_api"),
					});
					return;
				}

				// API key is valid, proceed with encryption
				const encryptedKey = await encryptApiKey(apiKey);

				// 2. Validate preset name against available presets
				// Find the preset with the closest name (case-insensitive)
				const selectedPreset = availablePresets.find(
					(p) =>
						p.tomori_preset_name.toLowerCase() ===
						presetName.trim().toLowerCase(),
				);

				if (!selectedPreset) {
					await submission.editReply({
						content: localizer(locale, "commands.setup.preset_invalid", {
							available: presetOptions,
						}),
					});
					return;
				}

				const selectedPresetId = selectedPreset.tomori_preset_id;
				log.info(
					`Selected preset ID: ${selectedPresetId} (${selectedPreset.tomori_preset_name})`,
				);

				const humanizerValue = Number.parseInt(humanizerText);
				// 3. Process humanizer setting
				if (humanizerValue < 0 || humanizerValue > 3) {
					await submission.editReply({
						content: localizer(locale, "commands.setup.humanizer_invalid"),
					});
					return;
				}

				// Create setup config
				const setupConfig: SetupConfig = {
					serverId: interaction.guild.id,
					encryptedApiKey: encryptedKey,
					presetId: selectedPresetId,
					humanizer: humanizerValue,
					tomoriName: locale === "ja" ? "ともり" : "Tomori", // Default name
					locale,
				};

				// Validate config using zod schema
				try {
					setupConfigSchema.parse(setupConfig);
				} catch (error) {
					log.error("Setup config validation failed:", error);
					await submission.editReply({
						content: localizer(locale, "commands.setup.config_invalid"),
					});
					return;
				}

				// Setup the server
				try {
					await setupServer(interaction.guild, setupConfig);
				} catch (error) {
					log.error("Server setup failed:", error);
					await submission.editReply({
						content: localizer(locale, "commands.setup.setup_failed"),
					});
					return;
				}

				// Show success message
				await replySummaryEmbed(submission, locale, {
					titleKey: "commands.setup.success_title",
					descriptionKey: "commands.setup.success_desc",
					color: ColorCode.SUCCESS,
					fields: [
						{
							nameKey: "commands.setup.preset_field",
							value: selectedPreset.tomori_preset_name,
						},
						{
							nameKey: "commands.setup.humanizer_field",
							value: String(humanizerValue),
						},
						{
							nameKey: "commands.setup.name_field",
							value: locale === "ja" ? "ともり" : "Tomori",
						},
					],
				});
			} catch (error) {
				log.error("Modal submission error:", error);
				await interaction.followUp({
					content: localizer(locale, "commands.setup.modal_timeout"),
					flags: MessageFlags.Ephemeral,
				});
			}
		} catch (error) {
			log.error("Error during setup process:", error);
			if (!interaction.replied && !interaction.deferred) {
				await interaction.reply({
					content: localizer(locale, "general.errors.generic_error"),
					flags: MessageFlags.Ephemeral,
				});
			} else {
				await interaction.followUp({
					content: localizer(locale, "general.errors.generic_error"),
					flags: MessageFlags.Ephemeral,
				});
			}
		}
	},
} as const;

export default command;
