import {
	MessageFlags,
	type ChatInputCommandInteraction,
	type Client,
	type SlashCommandSubcommandBuilder,
} from "discord.js";
import { loadTomoriState } from "../../utils/db/dbRead";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import { replyInfoEmbed } from "../../utils/discord/interactionHelper";
import {
	type UserRow,
	type ErrorContext,
	tomoriConfigSchema,
} from "../../types/db/schema";
import { validateApiKey } from "../../providers/google/gemini";
import { encryptApiKey } from "../../utils/security/crypto";
import { sql } from "bun";

// Configure the subcommand
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("apikeyset")
		.setDescription(
			localizer("en-US", "commands.config.apikeyset.command_description"),
		)
		.setDescriptionLocalizations({
			ja: localizer("ja", "commands.config.apikeyset.command_description"),
		})
		.addStringOption((option) =>
			option
				.setName("key")
				.setDescription(
					localizer("en-US", "commands.config.apikeyset.key_description"),
				)
				.setDescriptionLocalizations({
					ja: localizer("ja", "commands.config.apikeyset.key_description"),
				})
				.setRequired(true),
		);

/**
 * Sets the API key Tomori will use for this server
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

	let apiKey: string | null = null; // For error context

	try {
		// 2. Get the API key from options
		apiKey = interaction.options.getString("key", true);

		// 3. Basic validation
		if (!apiKey || apiKey.length < 10) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.apikeyset.invalid_key_title",
				descriptionKey: "commands.config.apikeyset.invalid_key_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 4. Show ephemeral processing message
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		// 5. Load the Tomori state for this server (Rule #17)
		const tomoriState = await loadTomoriState(interaction.guild.id);
		if (!tomoriState) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.tomori_not_setup_title",
				descriptionKey: "general.errors.tomori_not_setup",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 6. Validate the API key with Google
		await interaction.editReply({
			content: localizer(locale, "commands.config.apikeyset.validating_key"),
		});

		const isApiKeyValid = await validateApiKey(apiKey);
		if (!isApiKeyValid) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.apikeyset.key_validation_failed_title",
				descriptionKey:
					"commands.config.apikeyset.key_validation_failed_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 7. Encrypt the API key (returns Buffer)
		const encryptedKey = await encryptApiKey(apiKey);

		// 8. Update the config in the database using direct SQL (Rule #4, #15)
		const [updatedRow] = await sql`
            UPDATE tomori_configs
            SET api_key = ${encryptedKey} -- Pass Buffer directly
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
					command: "config apikeyset",
					guildId: interaction.guild.id,
					// Do not log the API key itself, even encrypted
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

			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.update_failed_title",
				descriptionKey: "general.errors.update_failed_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 10. Success message
		await replyInfoEmbed(interaction, locale, {
			titleKey: "commands.config.apikeyset.success_title",
			descriptionKey: "commands.config.apikeyset.success_description",
			color: ColorCode.SUCCESS,
		});
	} catch (error) {
		// 11. Log error with context (Rule #22)
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
				// Do not log API key here either
				apiKeyLength: apiKey?.length, // Log length as a hint
			},
		};
		await log.error(
			`Error executing /config apikeyset for user ${userData.user_disc_id}`,
			error as Error,
			context,
		);

		// 12. Inform user of unknown error
		// Use followUp since deferReply was used
		if (interaction.deferred && !interaction.replied) {
			await interaction.followUp({
				content: localizer(locale, "general.errors.unknown_error_description"),
				flags: MessageFlags.Ephemeral,
			});
		}
	}
}
