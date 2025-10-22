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
import { localizer, getDefaultBotName } from "../../utils/text/localizer";
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
	loadPresetOptionsByLocale,
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
	// Check if channel exists (required for both guilds and DMs)
	if (!interaction.channel) {
		await interaction.reply({
			content: localizer(
				userData.language_pref,
				"general.errors.operation_failed_description",
			),
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// Determine if this is a DM or guild context
	const isDMChannel = interaction.channel.isDMBased();
	const serverId = isDMChannel ? interaction.user.id : interaction.guild?.id;
	
	if (!serverId) {
		await interaction.reply({
			content: localizer(
				userData.language_pref,
				"general.errors.critical_error_description",
			),
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	try {
		// 2. Check if Tomori already exists for this server - NEW CHECK
		const existingTomoriState = await loadTomoriState(serverId);

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
			loadPresetOptionsByLocale(locale, 100),
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
				description: undefined,
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

		// Process modal submission - wrap in try-catch to handle errors within modal context
		try {
			// Extract values from the modal
			// biome-ignore lint/style/noNonNullAssertion: Modal submission outcome "submit" guarantees these values exist
			const modalSubmitInteraction = modalResult.interaction!;
		
		// Extract values with validation - modal submission can have missing values due to Component Type 18 handling
		
		const apiProvider = modalResult.values?.api_provider;
		const apiKey = modalResult.values?.api_key;
		const presetName = modalResult.values?.preset_name;

		// Validate that all required values are present - let helper functions manage interaction state
		if (!apiProvider || !apiKey || !presetName) {
			log.error("Missing required modal values:", {
				apiProvider: apiProvider || "MISSING",
				apiKey: apiKey ? "PROVIDED" : "MISSING", 
				presetName: presetName || "MISSING",
				allValuesKeys: modalResult.values ? Object.keys(modalResult.values) : "NO_VALUES",
				allValuesStringified: modalResult.values ? JSON.stringify(modalResult.values, null, 2) : "NO_VALUES"
			});
			await replyInfoEmbed(modalSubmitInteraction, locale, {
				titleKey: "general.errors.operation_failed_title",
				descriptionKey: "commands.config.setup.modal_values_missing",
				color: ColorCode.ERROR,
			});
			return;
		}

		// Validate and transform inputs

		// 1. Validate API Provider (case-insensitive)
		const normalizedProvider = uniqueProviders.find(
			(provider) => provider.toLowerCase() === apiProvider.toLowerCase(),
		);

		if (!apiProvider || !normalizedProvider) {
			await replyInfoEmbed(modalSubmitInteraction, locale, {
				titleKey: "general.errors.operation_failed_title",
				descriptionKey: "commands.config.setup.provider_invalid",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 2. Validate API Key with length check and actual API test
		if (!apiKey || apiKey.length < 10) {
			await replyInfoEmbed(modalSubmitInteraction, locale, {
				titleKey: "general.errors.operation_failed_title",
				descriptionKey: "commands.config.setup.api_key_invalid",
				color: ColorCode.ERROR,
			});
			return;
		}

		// Test the API key with a real API call (currently only supports Google)
		if (normalizedProvider.toLowerCase() === "google") {
			await replyInfoEmbed(modalSubmitInteraction, locale, {
				titleKey: "commands.config.setup.api_key_validating",
				descriptionKey: "commands.config.setup.api_key_validating",
				color: ColorCode.INFO,
			});

			const googleProvider = new GoogleProvider();
			const isApiKeyValid = await googleProvider.validateApiKey(apiKey);
			if (!isApiKeyValid) {
				await replyInfoEmbed(modalSubmitInteraction, locale, {
					titleKey: "general.errors.operation_failed_title",
					descriptionKey: "commands.config.setup.api_key_invalid_api",
					color: ColorCode.ERROR,
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
			await replyInfoEmbed(modalSubmitInteraction, locale, {
				titleKey: "general.errors.operation_failed_title",
				descriptionKey: "commands.config.setup.preset_invalid",
				descriptionVars: {
					available: presetOptions.map((p) => p.name).join(", "),
				},
				color: ColorCode.ERROR,
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
			await replyInfoEmbed(modalSubmitInteraction, locale, {
				titleKey: "general.errors.operation_failed_title",
				descriptionKey: "commands.config.setup.preset_not_found",
				color: ColorCode.ERROR,
			});
			return;
		}

		const selectedPresetId = presetRows[0].tomori_preset_id;
		log.info(
			`Selected preset ID: ${selectedPresetId} (${selectedPresetOption.name})`,
		);

		// Create setup config
		const setupConfig: SetupConfig = {
			serverId: serverId,
			encryptedApiKey: encryptedKey,
			provider: normalizedProvider, // Use the case-normalized provider name
			presetId: selectedPresetId,
			humanizer: HumanizerDegree.HEAVY, // Always default to HEAVY as decided
			tomoriName: getDefaultBotName(locale), // Get bot name from locale files
			locale,
		};

		// Validate config using zod schema
		try {
			setupConfigSchema.parse(setupConfig);
		} catch (error) {
			log.error("Setup config validation failed:", error);
			await replyInfoEmbed(modalSubmitInteraction, locale, {
				titleKey: "general.errors.operation_failed_title",
				descriptionKey: "commands.config.setup.config_invalid",
				color: ColorCode.ERROR,
			});
			return;
		}

		// Setup the server
		try {
			await setupServer(interaction.guild, setupConfig);
		} catch (error) {
			log.error("Server setup failed:", error);
			await replyInfoEmbed(modalSubmitInteraction, locale, {
				titleKey: "general.errors.operation_failed_title",
				descriptionKey: "commands.config.setup.setup_failed_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// Prepare fields for success message
		const successFields = [
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
		];

		// Add DM explanation field if in DM context
		if (isDMChannel) {
			successFields.push({
				nameKey: "commands.config.setup.dm_context_explanation_title",
				value: localizer(locale, "commands.config.setup.dm_context_explanation"),
			});
		}

		// Show success message
		await replySummaryEmbed(modalSubmitInteraction, locale, {
			titleKey: "commands.config.setup.success_title",
			descriptionKey: isDMChannel ? "commands.config.setup.success_desc_dm" : "commands.config.setup.success_desc",
			color: ColorCode.SUCCESS,
			fields: successFields,
		});
		} catch (modalError) {
			// Handle errors within modal submission context
			log.error("Error during modal submission processing:", modalError);
			
			// Try to respond to the modal submission interaction if we have it
			const modalSubmitInteraction = modalResult.interaction;
			if (modalSubmitInteraction) {
				try {
					await replyInfoEmbed(modalSubmitInteraction, locale, {
						titleKey: "general.errors.unknown_error_title",
						descriptionKey: "general.errors.unknown_error_description",
						color: ColorCode.ERROR,
					});
				} catch (replyError) {
					log.error("Failed to send modal error reply:", replyError);
				}
			}
		}
	} catch (error) {
		// Top-level error handler for non-modal errors (before modal is shown)
		log.error("Error during setup process:", error);
		if (!interaction.replied && !interaction.deferred) {
			try {
				await replyInfoEmbed(interaction, locale, {
					titleKey: "general.errors.unknown_error_title",
					descriptionKey: "general.errors.unknown_error_description",
					color: ColorCode.ERROR,
				});
			} catch (replyError) {
				log.error("Failed to send setup error reply:", replyError);
			}
		}
	}
}
