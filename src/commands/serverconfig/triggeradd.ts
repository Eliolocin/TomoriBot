import type {
	ChatInputCommandInteraction,
	Client,
	SlashCommandSubcommandBuilder,
} from "discord.js";
import { loadTomoriState } from "../../utils/db/dbRead";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import { replyInfoEmbed } from "../../utils/discord/interactionHelper";
import type { UserRow, ErrorContext } from "../../types/db/schema";
import { sql } from "bun";
import { checkTriggerWordLimit } from "../../utils/db/memoryLimits";

// Configure the subcommand
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("triggeradd")
		.setDescription(
			localizer("en-US", "commands.config.triggeradd.description"),
		)
		.addStringOption((option) =>
			option
				.setName("word")
				.setDescription(
					localizer("en-US", "commands.config.triggeradd.word_description"),
				)
				.setDescriptionLocalizations({
					ja: localizer("ja", "commands.config.triggeradd.word_description"),
				})
				.setRequired(true),
		);

/**
 * Adds a trigger word that will make Tomori respond automatically when mentioned in chat
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
		await replyInfoEmbed(interaction, userData.language_pref, {
			titleKey: "general.errors.guild_only_title",
			descriptionKey: "general.errors.guild_only_description",
			color: ColorCode.ERROR,
		});
		return;
	}

	try {
		// Get the trigger word from options
		const triggerWord = interaction.options
			.getString("word", true)
			.toLowerCase()
			.trim();

		// Basic validation for the trigger word
		if (!triggerWord || triggerWord.length < 2) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.triggeradd.too_short_title",
				descriptionKey: "commands.config.triggeradd.too_short_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// Load the Tomori state for this server - let helper functions manage interaction state
		const tomoriState = await loadTomoriState(interaction.guild.id);
		if (!tomoriState) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.tomori_not_setup_title",
				descriptionKey: "general.errors.tomori_not_setup_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// Get the current trigger words array
		const currentTriggerWords = tomoriState.config.trigger_words || [];

		// Check if the word is already in the list
		if (currentTriggerWords.includes(triggerWord)) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.triggeradd.already_exists_title",
				descriptionKey: "commands.config.triggeradd.already_exists_description",
				descriptionVars: {
					word: triggerWord,
				},
				color: ColorCode.WARN,
			});
			return;
		}

		// Check trigger word limit before adding  
		if (!tomoriState.tomori_id) {
			log.error("TomoriState missing tomori_id - this should never happen");
			return;
		}
		const triggerLimitCheck = await checkTriggerWordLimit(tomoriState.tomori_id);
		if (!triggerLimitCheck.isValid) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.triggeradd.limit_exceeded_title",
				descriptionKey: "commands.config.triggeradd.limit_exceeded_description",
				descriptionVars: {
					current_count: triggerLimitCheck.currentCount?.toString() || "0",
					max_allowed: (triggerLimitCheck.maxAllowed || 10).toString(),
				},
				color: ColorCode.ERROR,
			});
			return;
		}

		// Update the trigger words array
		const updatedTriggerWords = [...currentTriggerWords, triggerWord];

		// Update the config in the database with the manually constructed array literal
		const [updatedConfig] = await sql`
            UPDATE tomori_configs
            SET trigger_words = array_append(trigger_words, ${triggerWord})
            WHERE tomori_id = ${tomoriState.tomori_id}
            RETURNING *
        `;

		if (!updatedConfig) {
			// Check if the update was successful
			// Refined error context following Rule 22
			const context: ErrorContext = {
				tomoriId: tomoriState.tomori_id,
				userId: userData.user_id, // Added user ID for context
				serverId: tomoriState.server_id, // Added server ID for context
				errorType: "DatabaseUpdateError", // More specific type
				metadata: {
					command: "config triggeradd",
					guildId: interaction.guild.id, // Discord Guild ID for reference
					wordAdded: triggerWord,
					updatedField: "trigger_words", // Specific field
					targetTable: "tomori_configs", // Specific table
				},
			};
			// Pass the actual error object to log.error (Rule 22)
			await log.error(
				"Failed to update trigger_words config in database",
				new Error("Database UPDATE failed to return updated row"), // More specific error message
				context,
			);

			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.update_failed_title",
				descriptionKey: "general.errors.update_failed_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// Success message
		await replyInfoEmbed(interaction, locale, {
			titleKey: "commands.config.triggeradd.success_title",
			descriptionKey: "commands.config.triggeradd.success_description",
			descriptionVars: {
				word: triggerWord,
				word_count: updatedTriggerWords.length.toString(),
			},
			color: ColorCode.SUCCESS,
		});
	} catch (error) {
		const context: ErrorContext = {
			errorType: "CommandExecutionError",
			metadata: {
				command: "config triggeradd",
				guildId: interaction.guild.id,
			},
		};
		await log.error("Error in /config triggeradd command", error, context);

		await replyInfoEmbed(interaction, locale, {
			titleKey: "general.errors.unknown_error_title",
			descriptionKey: "general.errors.unknown_error_description",
			color: ColorCode.ERROR,
		});
	}
}
