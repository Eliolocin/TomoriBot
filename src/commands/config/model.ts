import type {
	ChatInputCommandInteraction,
	Client,
	SlashCommandSubcommandBuilder,
} from "discord.js";
// Import MessageFlags
import { MessageFlags } from "discord.js";
// Import sql
import { sql } from "bun";
import { loadTomoriState, loadAvailableLlms } from "../../utils/db/dbRead";
// Remove updateTomoriConfig import
// import { updateTomoriConfig } from "../../utils/db/dbWrite";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import { replyInfoEmbed } from "../../utils/discord/interactionHelper";
// Import TomoriConfigRow for validation and LlmRow for type hints
import {
	type UserRow,
	type ErrorContext,
	tomoriConfigSchema,
	type LlmRow,
} from "../../types/db/schema";

// --- Static LLM Choices with Localization Keys (Rule #20) ---
// Using keys allows localizer to handle the text
const LLM_CHOICES = [
	{
		codename: "gemini-2.5-flash-preview-05-20",
		nameKey: "commands.config.model.choice_balanced_fastest", // e.g., "Balanced/Fastest: Gemini 2.5 Flash (Default)"
	},
	{
		codename: "gemini-2.5-pro-preview-05-06",
		nameKey: "commands.config.model.choice_smartest_fast", // e.g., "Smartest/Fast: Gemini 2.5 Pro"
	},
	{
		codename: "gemini-2.0-flash-thinking-exp-01-21",
		nameKey: "commands.config.model.choice_old", // e.g., "Old: Gemini 2.0 Flash Thinking"
	},
];
// --- End Static LLM Choices ---

// Configure the subcommand (Rule #21)
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("model")
		.setDescription(
			localizer("en-US", "commands.config.model.description"),
		)
		.addStringOption((option) =>
			option
				.setName("name") // Keep internal name simple
				.setDescription(
					localizer("en-US", "commands.config.model.name_description"),
				)
				.setDescriptionLocalizations({
					ja: localizer("ja", "commands.config.model.name_description"),
				})
				.setRequired(true)
				.addChoices(
					// Add localized choices dynamically (Rule #9)
					...LLM_CHOICES.map((choice) => ({
						name: localizer("en-US", choice.nameKey), // Base name for Discord API
						name_localizations: {
							ja: localizer("ja", choice.nameKey),
							// Add other locales if needed
						},
						value: choice.codename, // Use codename as the value
					})),
				),
		);

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
	// 1. Ensure command is run in a guild
	if (!interaction.guild || !interaction.channel) {
		await replyInfoEmbed(interaction, userData.language_pref, {
			titleKey: "general.errors.guild_only_title",
			descriptionKey: "general.errors.guild_only",
			color: ColorCode.ERROR,
		});
		return;
	}

	let selectedModelCodename: string | null = null; // For error context
	let selectedModel: LlmRow | null = null; // For error context and logic

	try {
		// 2. Get the selected model codename from options
		selectedModelCodename = interaction.options.getString("name", true);

		// 3. Show ephemeral processing message (Rule #21 modification)
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		// 4. Load the Tomori state for this server (Rule #17)
		const tomoriState = await loadTomoriState(interaction.guild.id);
		if (!tomoriState) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.tomori_not_setup_title",
				descriptionKey: "general.errors.tomori_not_setup",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 5. Load all available models from the database to verify selection and get ID
		// Note: We load all here to also get the previous model's name later.
		// If performance becomes an issue, we could load only the selected one first.
		const availableModels = await loadAvailableLlms();
		if (!availableModels || availableModels.length === 0) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.model.no_models_title",
				descriptionKey: "commands.config.model.no_models_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 6. Find the selected model details (including llm_id) by codename
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
					guildId: interaction.guild.id,
					requestedModel: selectedModelCodename,
					availableModels: availableModels.map((m) => m.llm_codename),
				},
			};
			// Log the error even if it seems impossible due to choices
			await log.error(
				"Selected model codename not found in available LLMs from DB",
				new Error("Invalid model selection despite command choices"),
				context,
			);

			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.model.invalid_model_title",
				descriptionKey: "commands.config.model.invalid_model_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 7. Check if this is the same as the current model
		if (selectedModel.llm_id === tomoriState.config.llm_id) {
			// Find the localized name for the current model
			const currentChoice = LLM_CHOICES.find(
				(c) => c.codename === selectedModelCodename,
			);
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.model.already_selected_title",
				descriptionKey: "commands.config.model.already_selected_description",
				descriptionVars: {
					// Use localized name if found, otherwise codename
					model_name: currentChoice
						? localizer(locale, currentChoice.nameKey)
						: selectedModel.llm_codename,
				},
				color: ColorCode.WARN,
			});
			return;
		}

		// 8. Update the config in the database using direct SQL (Rule #4, #15)
		const [updatedRow] = await sql`
            UPDATE tomori_configs
            SET llm_id = ${selectedModel.llm_id}
            WHERE tomori_id = ${tomoriState.tomori_id}
            RETURNING *
        `;

		// 9. Validate the returned data (Rules #3, #5)
		const validatedConfig = tomoriConfigSchema.safeParse(updatedRow);

		if (!validatedConfig.success || !updatedRow) {
			const context: ErrorContext = {
				tomoriId: tomoriState.tomori_id,
				serverId: tomoriState.server_id,
				userId: userData.user_id,
				errorType: "DatabaseUpdateError",
				metadata: {
					command: "config model",
					guildId: interaction.guild.id,
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

			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.update_failed_title",
				descriptionKey: "general.errors.update_failed_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 10. Success message
		// Find previous and new model names (localized)
		const previousModel = availableModels.find(
			(model) => model.llm_id === tomoriState.config.llm_id,
		);
		const previousChoice = LLM_CHOICES.find(
			(c) => c.codename === previousModel?.llm_codename,
		);
		const newChoice = LLM_CHOICES.find(
			(c) => c.codename === selectedModelCodename,
		);

		await replyInfoEmbed(interaction, locale, {
			titleKey: "commands.config.model.success_title",
			descriptionKey: "commands.config.model.success_description",
			descriptionVars: {
				// Use localized name if found, otherwise codename
				model_name: newChoice
					? localizer(locale, newChoice.nameKey)
					: selectedModel.llm_codename,
				previous_model: previousChoice
					? localizer(locale, previousChoice.nameKey)
					: (previousModel?.llm_codename ??
						localizer(locale, "general.unknown")),
			},
			color: ColorCode.SUCCESS,
		});
	} catch (error) {
		// 11. Log error with context (Rule #22)
		let serverIdForError: number | null = null;
		let tomoriIdForError: number | null = null;
		if (interaction.guild?.id) {
			// Avoid re-fetching if tomoriState was loaded successfully before error
			const state =
				(await loadTomoriState(interaction.guild.id)) ?? // Fetch if not loaded
				null; // Ensure null if fetch fails
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
				guildId: interaction.guild?.id,
				executorDiscordId: interaction.user.id,
				selectedModelCodename:
					selectedModelCodename ?? interaction.options.getString("name"),
				targetLlmIdAttempted: selectedModel?.llm_id,
			},
		};
		await log.error(
			`Error executing /config model for user ${userData.user_disc_id}`,
			error as Error,
			context,
		);

		// 12. Inform user of unknown error
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
