import {
	MessageFlags,
	TextInputStyle,
	type ChatInputCommandInteraction,
	type Client,
	type SlashCommandSubcommandBuilder,
} from "discord.js";
import { loadTomoriState, loadUniqueProviders } from "../../utils/db/dbRead";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import {
	replyInfoEmbed,
	promptWithRawModal,
} from "../../utils/discord/interactionHelper";
import {
	type UserRow,
	type ErrorContext,
	tomoriConfigSchema,
} from "../../types/db/schema";
import type { SelectOption, ModalComponent } from "../../types/discord/modal";
import {
	ProviderFactory,
	ProviderType,
} from "../../utils/provider/providerFactory";
import { encryptApiKey } from "../../utils/security/crypto";
import { sql } from "bun";

// Modal configuration constants
const MODAL_CUSTOM_ID = "config_apikeyset_modal";
const PROVIDER_SELECT_ID = "provider_select";
const API_KEY_INPUT_ID = "api_key_input";

// Configure the subcommand
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("apikeyset")
		.setDescription(
			localizer("en-US", "commands.config.apikeyset.description"),
		);

/**
 * Sets the API key Tomori will use for this server with dynamic provider selection
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
			descriptionKey: "general.errors.guild_only_description",
			color: ColorCode.ERROR,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	try {
		// 2. Load the Tomori state for this server
		const tomoriState = await loadTomoriState(interaction.guild.id);
		if (!tomoriState) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.tomori_not_setup_title",
				descriptionKey: "general.errors.tomori_not_setup_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 3. Load unique providers from database
		const uniqueProviders = await loadUniqueProviders();
		if (!uniqueProviders || uniqueProviders.length === 0) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.apikeyset.no_providers_title",
				descriptionKey: "commands.config.apikeyset.no_providers_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 4. Create provider select options with descriptions
		const providerSelectOptions: SelectOption[] = uniqueProviders.map(
			(provider) => {
				// Get provider info for description
				let description = `${provider} API key`;
				try {
					const providerEnum = provider.toLowerCase() as ProviderType;
					if (Object.values(ProviderType).includes(providerEnum)) {
						const info = ProviderFactory.getAvailableProviders().find(
							(p) => p.type === providerEnum,
						);
						if (info) {
							description = info.info.name || description;
						}
					}
				} catch {
					// Fallback to default description
				}

				return {
					label: provider.charAt(0).toUpperCase() + provider.slice(1),
					value: provider.toLowerCase(),
					description: description,
				};
			},
		);

		// 5. Show modal with provider selection and API key input
		const modalComponents: ModalComponent[] = [
			{
				customId: PROVIDER_SELECT_ID,
				labelKey: "commands.config.apikeyset.provider_label",
				descriptionKey: "commands.config.apikeyset.provider_description",
				placeholder: "commands.config.apikeyset.provider_placeholder",
				required: true,
				options: providerSelectOptions,
			},
			{
				customId: API_KEY_INPUT_ID,
				labelKey: "commands.config.apikeyset.api_key_label",
				descriptionKey: "commands.config.apikeyset.api_key_description",
				placeholder: "commands.config.apikeyset.api_key_placeholder",
				required: true,
				style: TextInputStyle.Short,
				maxLength: 200,
			},
		];

		const modalResult = await promptWithRawModal(interaction, locale, {
			modalCustomId: MODAL_CUSTOM_ID,
			modalTitleKey: "commands.config.apikeyset.modal_title",
			components: modalComponents,
		});

		// 6. Handle modal outcome
		if (modalResult.outcome !== "submit") {
			log.info(
				`API key set modal ${modalResult.outcome} for user ${userData.user_id}`,
			);
			return;
		}

		// Extract values from the modal
		const modalSubmitInteraction = modalResult.interaction;
		const selectedProvider = modalResult.values?.[PROVIDER_SELECT_ID];
		const apiKey = modalResult.values?.[API_KEY_INPUT_ID];

		// Safety checks
		if (!modalSubmitInteraction || !selectedProvider || !apiKey) {
			log.error("Modal result unexpectedly missing interaction or values");
			return;
		}

		// Defer the reply for the modal submission
		await modalSubmitInteraction.deferReply({ flags: MessageFlags.Ephemeral });

		// 7. Basic API key validation
		if (apiKey.length < 10) {
			await replyInfoEmbed(modalSubmitInteraction, locale, {
				titleKey: "commands.config.apikeyset.invalid_key_title",
				descriptionKey: "commands.config.apikeyset.invalid_key_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 8. Show validation message
		await modalSubmitInteraction.editReply({
			content: localizer(locale, "commands.config.apikeyset.validating_key"),
		});

		// 9. Create provider instance and validate API key
		let isValid = false;
		try {
			// Create a temporary provider instance for validation
			let provider: {
				validateApiKey: (key: string) => Promise<boolean>;
			} | null = null;
			const providerName = selectedProvider.toLowerCase();

			if (providerName === "google" || providerName === "gemini") {
				const { GoogleProvider } = await import(
					"../../providers/google/googleProvider"
				);
				provider = new GoogleProvider();
			} else {
				// Unsupported provider selected
				await replyInfoEmbed(modalSubmitInteraction, locale, {
					titleKey: "commands.config.apikeyset.unsupported_provider_title",
					descriptionKey:
						"commands.config.apikeyset.unsupported_provider_description",
					descriptionVars: {
						provider: selectedProvider,
					},
					color: ColorCode.ERROR,
				});
				return;
			}

			// Validate the API key with the provider
			if (provider?.validateApiKey) {
				isValid = await provider.validateApiKey(apiKey);
			} else {
				throw new Error(
					`Provider ${selectedProvider} does not support API key validation`,
				);
			}
		} catch (error) {
			log.error(
				`Error validating API key for provider ${selectedProvider}`,
				error as Error,
			);
			await replyInfoEmbed(modalSubmitInteraction, locale, {
				titleKey: "commands.config.apikeyset.validation_error_title",
				descriptionKey:
					"commands.config.apikeyset.validation_error_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 10. Handle validation failure with error embed (not reply)
		if (!isValid) {
			await replyInfoEmbed(modalSubmitInteraction, locale, {
				titleKey: "commands.config.apikeyset.key_validation_failed_title",
				descriptionKey:
					"commands.config.apikeyset.key_validation_failed_description",
				descriptionVars: {
					provider:
						selectedProvider.charAt(0).toUpperCase() +
						selectedProvider.slice(1),
				},
				color: ColorCode.ERROR,
			});
			return;
		}

		// 11. Encrypt and store the API key
		const encryptedKey = await encryptApiKey(apiKey);

		// 12. Update the config in the database
		const [updatedRow] = await sql`
			UPDATE tomori_configs
			SET api_key = ${encryptedKey}
			WHERE tomori_id = ${tomoriState.tomori_id}
			RETURNING *
		`;

		// 13. Validate the returned data
		const validatedConfig = tomoriConfigSchema.safeParse(updatedRow);

		if (!validatedConfig.success || !updatedRow) {
			const context: ErrorContext = {
				tomoriId: tomoriState.tomori_id,
				serverId: tomoriState.server_id,
				userId: userData.user_id,
				errorType: "DatabaseUpdateError",
				metadata: {
					command: "config apikeyset",
					selectedProvider,
					validationErrors: validatedConfig.success
						? null
						: validatedConfig.error.flatten(),
				},
			};
			await log.error(
				"Failed to update or validate config after setting API key",
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

		// 14. Success message
		await replyInfoEmbed(modalSubmitInteraction, locale, {
			titleKey: "commands.config.apikeyset.success_title",
			descriptionKey: "commands.config.apikeyset.success_description",
			descriptionVars: {
				provider:
					selectedProvider.charAt(0).toUpperCase() + selectedProvider.slice(1),
			},
			color: ColorCode.SUCCESS,
		});
	} catch (error) {
		// Error handling
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
				command: "config apikeyset",
				guildId: interaction.guild?.id,
				executorDiscordId: interaction.user.id,
			},
		};
		await log.error(
			`Error executing /config apikeyset for user ${userData.user_disc_id}`,
			error as Error,
			context,
		);

		// Inform user of unknown error
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
