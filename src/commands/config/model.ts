import type {
	ChatInputCommandInteraction,
	Client,
	SlashCommandSubcommandBuilder,
} from "discord.js";
import { MessageFlags } from "discord.js";
// Import sql
import { sql } from "bun";
import { loadTomoriState, loadAvailableLlms } from "../../utils/db/dbRead";
// Remove updateTomoriConfig import
// import { updateTomoriConfig } from "../../utils/db/dbWrite";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import {
	replyInfoEmbed,
	promptWithRawModal,
	safeSelectOptionText,
} from "../../utils/discord/interactionHelper";
// Import TomoriConfigRow for validation and LlmRow for type hints
import {
	type UserRow,
	type ErrorContext,
	tomoriConfigSchema,
	type LlmRow,
} from "../../types/db/schema";
import type { SelectOption } from "../../types/discord/modal";

// Modal configuration constants
const MODAL_CUSTOM_ID = "config_model_modal";
const MODEL_SELECT_ID = "model_select";

// Configure the subcommand (Rule #21)
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("model")
		.setDescription(localizer("en-US", "commands.config.model.description"));

/**
 * Changes Tomori's LLM model (Gemini)
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
		await replyInfoEmbed(interaction, userData.language_pref, {
			titleKey: "general.errors.channel_only_title",
			descriptionKey: "general.errors.channel_only_description",
			color: ColorCode.ERROR,
		});
		return;
	}

	let selectedModel: LlmRow | null = null; // For error context and logic
	try {
		// 2. Load the Tomori state for this server (Rule #17)
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

		// 2.5. Check if an API key is configured
		if (!tomoriState.config.api_key) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.model.no_api_key_title",
				descriptionKey: "commands.config.model.no_api_key_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 3. Load all available models from the database for modal options
		const availableModels = await loadAvailableLlms();
		if (!availableModels || availableModels.length === 0) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.model.no_models_title",
				descriptionKey: "commands.config.model.no_models_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 4. Create model options for the select menu using database descriptions
		const modelSelectOptions: SelectOption[] = availableModels.map((model) => ({
			label: safeSelectOptionText(model.llm_codename), // Use codename as display label
			value: safeSelectOptionText(model.llm_codename), // Use codename as value
			description: safeSelectOptionText(model.llm_description || `${model.llm_provider} model`), // Use description from DB or fallback
		}));

		// 5. Show the modal with model selection
		const modalResult = await promptWithRawModal(interaction, locale, {
			modalCustomId: MODAL_CUSTOM_ID,
			modalTitleKey: "commands.config.model.modal_title",
			components: [
				{
					customId: MODEL_SELECT_ID,
					labelKey: "commands.config.model.select_label",
					descriptionKey: "commands.config.model.select_description",
					placeholder: "commands.config.model.select_placeholder",
					required: true,
					options: modelSelectOptions,
				},
			],
		});

		// 6. Handle modal outcome
		if (modalResult.outcome !== "submit") {
			log.info(
				`Model selection modal ${modalResult.outcome} for user ${userData.user_id}`,
			);
			return;
		}

		// Extract values from the modal
		// biome-ignore lint/style/noNonNullAssertion: Modal submission outcome "submit" guarantees these values exist
		const modalSubmitInteraction = modalResult.interaction!;
		// biome-ignore lint/style/noNonNullAssertion: Modal submission outcome "submit" guarantees these values exist
		const selectedModelCodename = modalResult.values![MODEL_SELECT_ID];

		// 7. Find the selected model details (including llm_id) by codename - let helper functions manage interaction state
		selectedModel =
			availableModels.find(
				(model) => model.llm_codename === selectedModelCodename,
			) ?? null;

		if (!selectedModel?.llm_id) {
			const context: ErrorContext = {
				tomoriId: tomoriState.tomori_id,
				serverId: tomoriState.server_id,
				userId: userData.user_id,
				errorType: "CommandExecutionError",
				metadata: {
					command: "config model",
					guildId: interaction.guild?.id ?? interaction.user.id,
					requestedModel: selectedModelCodename,
					availableModels: availableModels.map((m) => m.llm_codename),
				},
			};
			// Log the error even if it seems impossible due to modal choices
			await log.error(
				"Selected model codename not found in available LLMs from DB",
				new Error("Invalid model selection despite modal choices"),
				context,
			);

			await modalSubmitInteraction.editReply({
				content: localizer(
					locale,
					"commands.config.model.invalid_model_description",
				),
			});
			return;
		}

		// 8. Check if this is the same as the current model
		if (selectedModel.llm_id === tomoriState.config.llm_id) {
			await replyInfoEmbed(modalSubmitInteraction, locale, {
				titleKey: "commands.config.model.already_selected_title",
				descriptionKey: "commands.config.model.already_selected_description",
				descriptionVars: {
					model_name: selectedModel.llm_codename,
				},
				color: ColorCode.WARN,
			});
			return;
		}

		// 8.5. Validate API key compatibility with new model's provider (if different provider)
		const currentProvider = tomoriState.llm?.llm_provider?.toLowerCase();
		const newProvider = selectedModel.llm_provider?.toLowerCase();

		if (currentProvider !== newProvider) {
			// Show validation message
			await modalSubmitInteraction.editReply({
				content: localizer(
					locale,
					"commands.config.model.validating_api_key_compatibility",
				),
			});

			try {
				// Decrypt and validate the API key with the new provider
				const { decryptApiKey } = await import("../../utils/security/crypto");
				const decryptedApiKey = await decryptApiKey(tomoriState.config.api_key);

				// Create provider instance for validation
				let isKeyCompatible = false;
				if (newProvider === "google" || newProvider === "gemini") {
					const { GoogleProvider } = await import(
						"../../providers/google/googleProvider"
					);
					const provider = new GoogleProvider();
					isKeyCompatible = await provider.validateApiKey(decryptedApiKey);
				} else {
					// For other providers, we can't validate yet, so assume compatible
					// but log a warning
					log.warn(
						`Cannot validate API key for provider ${newProvider} - validation not implemented`,
					);
					isKeyCompatible = true;
				}

				if (!isKeyCompatible) {
					await replyInfoEmbed(modalSubmitInteraction, locale, {
						titleKey: "commands.config.model.api_key_incompatible_title",
						descriptionKey:
							"commands.config.model.api_key_incompatible_description",
						descriptionVars: {
							model_name: selectedModel.llm_codename,
							provider:
								newProvider.charAt(0).toUpperCase() + newProvider.slice(1),
						},
						color: ColorCode.ERROR,
					});
					return;
				}
			} catch (error) {
				log.error(
					`Error validating API key compatibility for provider ${newProvider}`,
					error as Error,
				);
				await replyInfoEmbed(modalSubmitInteraction, locale, {
					titleKey: "commands.config.model.validation_error_title",
					descriptionKey: "commands.config.model.validation_error_description",
					color: ColorCode.ERROR,
				});
				return;
			}
		}

		// 9. Update the config in the database using direct SQL (Rule #4, #15)
		const [updatedRow] = await sql`
            UPDATE tomori_configs
            SET llm_id = ${selectedModel.llm_id}
            WHERE tomori_id = ${tomoriState.tomori_id}
            RETURNING *
        `;

		// 10. Validate the returned data (Rules #3, #5)
		const validatedConfig = tomoriConfigSchema.safeParse(updatedRow);

		if (!validatedConfig.success || !updatedRow) {
			const context: ErrorContext = {
				tomoriId: tomoriState.tomori_id,
				serverId: tomoriState.server_id,
				userId: userData.user_id,
				errorType: "DatabaseUpdateError",
				metadata: {
					command: "config model",
					guildId: interaction.guild?.id ?? interaction.user.id,
					selectedModelCodename,
					targetLlmId: selectedModel.llm_id,
					validationErrors: validatedConfig.success
						? null
						: validatedConfig.error.flatten(),
				},
			};
			await log.error(
				"Failed to update or validate LLM config after DB update",
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

		// 11. Success message
		// Find previous model name
		const previousModel = availableModels.find(
			(model) => model.llm_id === tomoriState.config.llm_id,
		);

		await replyInfoEmbed(modalSubmitInteraction, locale, {
			titleKey: "commands.config.model.success_title",
			descriptionKey: "commands.config.model.success_description",
			descriptionVars: {
				model_name: selectedModel.llm_codename,
				previous_model:
					previousModel?.llm_codename ?? localizer(locale, "general.unknown"),
			},
			color: ColorCode.SUCCESS,
		});
	} catch (error) {
		// 12. Log error with context (Rule #22)
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
				command: "config model",
				guildId: interaction.guild?.id ?? interaction.user.id,
				executorDiscordId: interaction.user.id,
				targetLlmIdAttempted: selectedModel?.llm_id,
			},
		};
		await log.error(
			`Error executing /config model for user ${userData.user_disc_id}`,
			error as Error,
			context,
		);

		// 13. Inform user of unknown error
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
