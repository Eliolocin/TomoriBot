import {
	type ChatInputCommandInteraction,
	type Client,
	PermissionsBitField,
	ActionRowBuilder,
	TextInputStyle,
	ModalBuilder,
	TextInputBuilder,
} from "discord.js";
import { sql } from "bun";
import type { BaseCommand } from "../../types/discord/global";
import type { SetupConfig, TomoriPresetRow } from "../../types/db/schema";
import { setupConfigSchema, tomoriPresetSchema } from "../../types/db/schema";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import {
	showInfoEmbed,
	showSummaryEmbed,
} from "../../utils/discord/interactionHelper";
import { validateApiKey } from "../../providers/google";
import { encryptApiKey } from "../../utils/security/crypto";
import { setupServer } from "../../utils/db/setupHelper";

/**
 * Command to guide users through the initial setup of TomoriBot for their server
 * @description Collects configuration and initializes TomoriBot's database state
 */
const command: BaseCommand = {
	name: "setup",
	description: localizer("en", "tool.setup.command_description"),
	category: "tool",
	permissionsRequired: [
		new PermissionsBitField(PermissionsBitField.Flags.ManageGuild),
	],
	callback: async (
		_client: Client,
		interaction: ChatInputCommandInteraction,
	): Promise<void> => {
		// Ensure command is run in a guild
		if (!interaction.guild || !interaction.channel) {
			await interaction.reply({
				content: localizer(interaction.locale, "errors.guild_only"),
				ephemeral: true,
			});
			return;
		}

		const locale = interaction.locale ?? interaction.guildLocale ?? "en";

		// Check permissions again (belt-and-suspenders)
		const memberPermissions = interaction.member?.permissions;
		if (
			!memberPermissions ||
			!(memberPermissions instanceof PermissionsBitField) ||
			!memberPermissions.has(PermissionsBitField.Flags.ManageGuild)
		) {
			await showInfoEmbed(interaction, locale, {
				titleKey: "tool.setup.error_title",
				descriptionKey: "tool.setup.no_permission",
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
				WHERE preset_language = ${locale} OR preset_language = 'en'
				ORDER BY tomori_preset_id
			`;

			// Validate preset data
			const availablePresets: TomoriPresetRow[] = presetRows.map(
				(row: Record<string, unknown>) => tomoriPresetSchema.parse(row),
			);

			if (availablePresets.length === 0) {
				log.warn(`No presets found for locale '${locale}' or fallback 'en'`);
				await interaction.reply({
					content: localizer(locale, "tool.setup.no_presets_found"),
					ephemeral: true,
				});
				return;
			}

			// Create a placeholder showing available preset options
			const presetOptions = availablePresets
				.map((preset) => preset.tomori_preset_name)
				.join(", ");
			const presetPlaceholder = `Available: ${
				presetOptions.length > 50
					? `${presetOptions.substring(0, 47)}...`
					: presetOptions
			}`;

			// Create a comprehensive single setup modal
			const modal = new ModalBuilder()
				.setCustomId("tomori_setup_modal")
				.setTitle(localizer(locale, "tool.setup.modal_title"));

			// API Key input
			const apiKeyInput = new TextInputBuilder()
				.setCustomId("api_key")
				.setLabel(localizer(locale, "tool.setup.api_key_label"))
				.setStyle(TextInputStyle.Short)
				.setPlaceholder("Enter your Gemini API Key")
				.setRequired(true);

			// Personality preset input with choices in placeholder
			const presetInput = new TextInputBuilder()
				.setCustomId("preset_name")
				.setLabel(localizer(locale, "tool.setup.preset_label"))
				.setStyle(TextInputStyle.Short)
				.setPlaceholder(presetPlaceholder)
				.setRequired(true);
			//.setValue(availablePresets[0].tomori_preset_name); // Default to first preset

			// Auto-chat channels input
			const autoChInput = new TextInputBuilder()
				.setCustomId("auto_channels")
				.setLabel(localizer(locale, "tool.setup.channels_label"))
				.setStyle(TextInputStyle.Short)
				.setPlaceholder("general,chat,random (leave empty to disable)")
				.setRequired(false);

			// Auto-chat threshold
			const thresholdInput = new TextInputBuilder()
				.setCustomId("threshold")
				.setLabel(localizer(locale, "tool.setup.threshold_label"))
				.setStyle(TextInputStyle.Short)
				.setPlaceholder("Range: 30-100, recommended: 30")
				//.setValue("15")
				.setRequired(false);

			// Humanizer toggle - make it clear it's a yes/no field
			const humanizerInput = new TextInputBuilder()
				.setCustomId("humanizer")
				.setLabel(localizer(locale, "tool.setup.humanizer_label"))
				.setStyle(TextInputStyle.Short)
				.setPlaceholder("Enter 'yes' or 'no'")
				//.setValue("yes")
				.setRequired(true);

			// Add inputs to the modal
			modal.addComponents(
				new ActionRowBuilder<TextInputBuilder>().addComponents(apiKeyInput),
				new ActionRowBuilder<TextInputBuilder>().addComponents(presetInput),
				new ActionRowBuilder<TextInputBuilder>().addComponents(autoChInput),
				new ActionRowBuilder<TextInputBuilder>().addComponents(thresholdInput),
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
				const autoChannelsText =
					submission.fields.getTextInputValue("auto_channels");
				const thresholdText = submission.fields.getTextInputValue("threshold");
				const humanizerText = submission.fields
					.getTextInputValue("humanizer")
					.toLowerCase();

				// Validate and transform inputs

				// 1. Validate API Key with length check and actual API test
				if (!apiKey || apiKey.length < 10) {
					await submission.editReply({
						content: localizer(locale, "tool.setup.api_key_invalid"),
					});
					return;
				}

				// Test the API key with a real API call to Google
				await submission.editReply({
					content: localizer(locale, "tool.setup.api_key_validating"),
				});

				const isApiKeyValid = await validateApiKey(apiKey);
				if (!isApiKeyValid) {
					await submission.editReply({
						content: localizer(locale, "tool.setup.api_key_invalid_api"),
					});
					return;
				}

				// API key is valid, proceed with encryption
				const encryptedKey = await encryptApiKey(apiKey);

				// 2. Validate preset name against available presets
				// Find the preset with the closest name (case-insensitive)
				const selectedPreset = availablePresets.find(
					(p) =>
						p.tomori_preset_name.toLowerCase() === presetName.toLowerCase(),
				);

				if (!selectedPreset) {
					await submission.editReply({
						content: localizer(locale, "tool.setup.preset_invalid", {
							available: presetOptions,
						}),
					});
					return;
				}

				const selectedPresetId = selectedPreset.tomori_preset_id;
				log.info(
					`Selected preset ID: ${selectedPresetId} (${selectedPreset.tomori_preset_name})`,
				);

				// 3. Process auto-chat channels
				const autochChannels = autoChannelsText.trim()
					? autoChannelsText.split(",").map((channel) => channel.trim())
					: [];

				// 4. Process threshold
				const autochThreshold = Number.parseInt(thresholdText, 10);
				if (
					Number.isNaN(autochThreshold) ||
					autochThreshold < 5 ||
					autochThreshold > 100
				) {
					await submission.editReply({
						content: localizer(locale, "tool.setup.threshold_invalid_desc"),
					});
					return;
				}

				// 5. Process humanizer setting
				if (!["yes", "no", "true", "false", "y", "n"].includes(humanizerText)) {
					await submission.editReply({
						content: localizer(locale, "tool.setup.humanizer_invalid"),
					});
					return;
				}
				const humanizerEnabled = ["yes", "true", "y"].includes(humanizerText);

				// Create setup config
				const setupConfig: SetupConfig = {
					serverId: interaction.guild.id,
					encryptedApiKey: encryptedKey,
					presetId: selectedPresetId,
					autochChannels,
					autochThreshold,
					humanizer: humanizerEnabled,
					tomoriName: locale === "ja" ? "ともり" : "Tomori", // Default name
					locale,
				};

				// Validate config using zod schema
				try {
					setupConfigSchema.parse(setupConfig);
				} catch (error) {
					log.error("Setup config validation failed:", error);
					await submission.editReply({
						content: localizer(locale, "tool.setup.config_invalid"),
					});
					return;
				}

				// Setup the server
				try {
					await setupServer(interaction.guild, setupConfig);
				} catch (error) {
					log.error("Server setup failed:", error);
					await submission.editReply({
						content: localizer(locale, "tool.setup.setup_failed"),
					});
					return;
				}

				// Show success message
				await showSummaryEmbed(submission, locale, {
					titleKey: "tool.setup.success_title",
					descriptionKey: "tool.setup.success_desc",
					color: ColorCode.SUCCESS,
					fields: [
						{
							nameKey: "tool.setup.preset_field",
							value: selectedPreset.tomori_preset_name,
						},
						{
							nameKey: "tool.setup.autoch_field",
							value: autochChannels.length
								? "tool.setup.autoch_enabled"
								: "tool.setup.autoch_disabled",
							vars: autochChannels.length
								? {
										channels: autochChannels.length,
										threshold: autochThreshold,
									}
								: undefined,
						},
						{
							nameKey: "tool.setup.humanizer_field",
							value: humanizerEnabled
								? "tool.setup.humanizer_enabled"
								: "tool.setup.humanizer_disabled",
						},
						{
							nameKey: "tool.setup.name_field",
							value: locale === "ja" ? "ともり" : "Tomori",
						},
					],
				});
			} catch (error) {
				log.error("Modal submission error:", error);
				await interaction.followUp({
					content: localizer(locale, "tool.setup.modal_timeout"),
					ephemeral: true,
				});
			}
		} catch (error) {
			log.error("Error during setup process:", error);
			if (!interaction.replied && !interaction.deferred) {
				await interaction.reply({
					content: localizer(locale, "general.errors.generic_error"),
					ephemeral: true,
				});
			} else {
				await interaction.followUp({
					content: localizer(locale, "general.errors.generic_error"),
					ephemeral: true,
				});
			}
		}
	},
} as const;

export default command;
