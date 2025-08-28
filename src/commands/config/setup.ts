import { TextInputStyle, MessageFlags } from "discord.js";
import type {
	ChatInputCommandInteraction,
	Client,
	SlashCommandSubcommandBuilder,
} from "discord.js";
import { sql } from "bun";
import type { SetupConfig, UserRow } from "../../types/db/schema";
import type { SelectOption } from "../../types/discord/modal";
import { setupConfigSchema } from "../../types/db/schema";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import {
	replyInfoEmbed,
	replySummaryEmbed,
	promptWithRawModal,
} from "../../utils/discord/interactionHelper";
import { GoogleProvider } from "../../providers/google/googleProvider";
import { encryptApiKey } from "../../utils/security/crypto";
import { setupServer } from "../../utils/db/dbWrite";
import {
	loadTomoriState,
	loadUniqueProviders,
	loadPresetOptions,
} from "@/utils/db/dbRead";

import { HumanizerDegree } from "@/types/db/schema";

// Define constants at the top (Rule #20)

// Configure the subcommand
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("setup")
		.setDescription(localizer("en-US", "commands.config.setup.description"));

/**
 * Execute the setup command - guides users through the initial setup of TomoriBot for their server
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
	// Ensure command is run in a guild
	if (!interaction.guild || !interaction.channel) {
		await interaction.reply({
			content: localizer(
				userData.language_pref,
				"general.errors.guild_only_description",
			),
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	try {
		// 2. Check if Tomori already exists for this server - NEW CHECK
		const existingTomoriState = await loadTomoriState(interaction.guild.id);

		// 3. If Tomori already exists, inform user and exit early
		if (existingTomoriState) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.setup.already_setup_title",
				descriptionKey: "commands.config.setup.already_setup_description",
				color: ColorCode.WARN,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// Load dynamic data for the modal
		const [uniqueProviders, presetOptions] = await Promise.all([
			loadUniqueProviders(),
			loadPresetOptions(100),
		]);

		// Check if we have the required data
		if (!uniqueProviders || uniqueProviders.length === 0) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.unknown_error_title",
				descriptionKey: "No LLM providers found in database",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		if (!presetOptions || presetOptions.length === 0) {
			await interaction.reply({
				content: localizer(locale, "commands.config.setup.no_presets_found"),
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// Create provider options for the select menu
		const providerSelectOptions: SelectOption[] = uniqueProviders.map(
			(provider) => ({
				label: provider.charAt(0).toUpperCase() + provider.slice(1), // Capitalize first letter
				value: provider,
				description: `Use ${provider} LLM provider`,
			}),
		);

		// Create preset options for the select menu
		const presetSelectOptions: SelectOption[] = presetOptions.map((preset) => ({
			label: preset.name,
			value: preset.name,
			description: preset.description,
		}));

		// Create the modal using the new promptWithRawModal utility with Component Type 18 support
		const modalResult = await promptWithRawModal(interaction, locale, {
			modalCustomId: "tomori_setup_modal",
			modalTitleKey: "commands.config.setup.modal_title",
			components: [
				{
					customId: "api_provider",
					labelKey: "commands.config.setup.api_provider_label",
					descriptionKey: "commands.config.setup.api_provider_description",
					placeholder: "commands.config.setup.api_provider_placeholder",
					required: true,
					options: providerSelectOptions,
				},
				{
					customId: "api_key",
					labelKey: "commands.config.setup.api_key_label",
					descriptionKey: "commands.config.setup.api_key_description",
					style: TextInputStyle.Short,
					required: true,
				},
				{
					customId: "preset_name",
					labelKey: "commands.config.setup.preset_label",
					descriptionKey: "commands.config.setup.preset_description",
					placeholder: "commands.config.setup.preset_placeholder",
					required: true,
					options: presetSelectOptions,
				},
			],
		});

		// Handle modal outcome
		if (modalResult.outcome !== "submit") {
			log.info(
				`Setup modal ${modalResult.outcome} for user ${userData.user_id}`,
			);
			return;
		}

		// Extract values from the modal
		// biome-ignore lint/style/noNonNullAssertion: Modal submission outcome "submit" guarantees these values exist
		const modalSubmitInteraction = modalResult.interaction!;
		// biome-ignore lint/style/noNonNullAssertion: Modal submission outcome "submit" guarantees these values exist
		const apiProvider = modalResult.values!.api_provider;
		// biome-ignore lint/style/noNonNullAssertion: Modal submission outcome "submit" guarantees these values exist
		const apiKey = modalResult.values!.api_key;
		// biome-ignore lint/style/noNonNullAssertion: Modal submission outcome "submit" guarantees these values exist
		const presetName = modalResult.values!.preset_name;

		// Defer the reply for the modal submission
		await modalSubmitInteraction.deferReply({ flags: MessageFlags.Ephemeral });

		// Validate and transform inputs

		// 1. Validate API Provider (case-insensitive)
		const normalizedProvider = uniqueProviders.find(
			(provider) => provider.toLowerCase() === apiProvider.toLowerCase(),
		);

		if (!apiProvider || !normalizedProvider) {
			await modalSubmitInteraction.editReply({
				content: "Invalid API provider selected.",
			});
			return;
		}

		// 2. Validate API Key with length check and actual API test
		if (!apiKey || apiKey.length < 10) {
			await modalSubmitInteraction.editReply({
				content: localizer(locale, "commands.config.setup.api_key_invalid"),
			});
			return;
		}

		// Test the API key with a real API call (currently only supports Google)
		if (normalizedProvider.toLowerCase() === "google") {
			await modalSubmitInteraction.editReply({
				content: localizer(locale, "commands.config.setup.api_key_validating"),
			});

			const googleProvider = new GoogleProvider();
			const isApiKeyValid = await googleProvider.validateApiKey(apiKey);
			if (!isApiKeyValid) {
				await modalSubmitInteraction.editReply({
					content: localizer(
						locale,
						"commands.config.setup.api_key_invalid_api",
					),
				});
				return;
			}
		}

		// API key is valid, proceed with encryption
		const encryptedKey = await encryptApiKey(apiKey);

		// 4. Validate preset name against available presets
		const selectedPresetOption = presetOptions.find(
			(p) => p.name.toLowerCase() === presetName.trim().toLowerCase(),
		);

		if (!selectedPresetOption) {
			await modalSubmitInteraction.editReply({
				content: localizer(locale, "commands.config.setup.preset_invalid", {
					available: presetOptions.map((p) => p.name).join(", "),
				}),
			});
			return;
		}

		// Get the full preset data from database
		const presetRows = await sql`
			SELECT tomori_preset_id, tomori_preset_name 
			FROM tomori_presets 
			WHERE tomori_preset_name = ${selectedPresetOption.name}
			LIMIT 1
		`;

		if (!presetRows.length) {
			await modalSubmitInteraction.editReply({
				content: "Selected preset not found in database.",
			});
			return;
		}

		const selectedPresetId = presetRows[0].tomori_preset_id;
		log.info(
			`Selected preset ID: ${selectedPresetId} (${selectedPresetOption.name})`,
		);

		// Create setup config
		const setupConfig: SetupConfig = {
			serverId: interaction.guild.id,
			encryptedApiKey: encryptedKey,
			provider: normalizedProvider, // Use the case-normalized provider name
			presetId: selectedPresetId,
			humanizer: HumanizerDegree.HEAVY, // Always default to HEAVY as decided
			tomoriName:
				locale === "ja"
					? process.env.DEFAULT_BOTNAME_JP || "ともり" // Use environment variable with fallback
					: process.env.DEFAULT_BOTNAME || "Tomori", // Use environment variable with fallback
			locale,
		};

		// Validate config using zod schema
		try {
			setupConfigSchema.parse(setupConfig);
		} catch (error) {
			log.error("Setup config validation failed:", error);
			await modalSubmitInteraction.editReply({
				content: localizer(locale, "commands.config.setup.config_invalid"),
			});
			return;
		}

		// Setup the server
		try {
			await setupServer(interaction.guild, setupConfig);
		} catch (error) {
			log.error("Server setup failed:", error);
			await modalSubmitInteraction.editReply({
				content: localizer(
					locale,
					"commands.config.setup.setup_failed_description",
				),
			});
			return;
		}

		// Show success message
		await replySummaryEmbed(modalSubmitInteraction, locale, {
			titleKey: "commands.config.setup.success_title",
			descriptionKey: "commands.config.setup.success_desc",
			color: ColorCode.SUCCESS,
			fields: [
				{
					nameKey: "commands.config.setup.preset_field",
					value: selectedPresetOption.name,
				},
				{
					nameKey: "commands.config.setup.name_field",
					value:
						locale === "ja"
							? process.env.DEFAULT_BOTNAME_JP || "ともり" // Use environment variable with fallback
							: process.env.DEFAULT_BOTNAME || "Tomori", // Use environment variable with fallback
				},
			],
		});
	} catch (error) {
		log.error("Error during setup process:", error);
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
