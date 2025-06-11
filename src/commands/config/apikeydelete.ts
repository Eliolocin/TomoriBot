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
import { sql } from "bun";

// Configure the subcommand
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("apikeydelete")
		.setDescription(
			localizer("en-US", "commands.config.apikeydelete.command_description"),
		)
		.setDescriptionLocalizations({
			ja: localizer("ja", "commands.config.apikeydelete.command_description"),
		});

/**
 * Removes API key from database
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

	try {
		// 2. Show ephemeral processing message (Rule #21 modification)
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		// 3. Load the Tomori state for this server (Rule #17)
		const tomoriState = await loadTomoriState(interaction.guild.id);
		if (!tomoriState) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.tomori_not_setup_title",
				descriptionKey: "general.errors.tomori_not_setup",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 4. Check if there's an API key to remove
		if (!tomoriState.config.api_key) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.apikeydelete.no_key_title",
				descriptionKey: "commands.config.apikeydelete.no_key_description",
				color: ColorCode.WARN,
			});
			return;
		}

		// 5. Update the config in the database using direct SQL (Rule #4, #15)
		// Set api_key to NULL
		const [updatedRow] = await sql`
            UPDATE tomori_configs
            SET api_key = NULL
            WHERE tomori_id = ${tomoriState.tomori_id}
            RETURNING *
        `;

		// 6. Validate the returned data (Rules #3, #5)
		const validatedConfig = tomoriConfigSchema.safeParse(updatedRow);

		if (!validatedConfig.success || !updatedRow) {
			const context: ErrorContext = {
				tomoriId: tomoriState.tomori_id,
				serverId: tomoriState.server_id,
				userId: userData.user_id,
				errorType: "DatabaseUpdateError",
				metadata: {
					command: "config apikeydelete",
					guildId: interaction.guild.id,
					validationErrors: validatedConfig.success
						? null
						: validatedConfig.error.flatten(),
				},
			};
			await log.error(
				"Failed to update or validate config after removing API key",
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

		// 7. Success message with embed
		await replyInfoEmbed(interaction, locale, {
			titleKey: "commands.config.apikeydelete.success_title",
			descriptionKey: "commands.config.apikeydelete.success_description",
			color: ColorCode.SUCCESS,
		});
	} catch (error) {
		// 8. Log error with context (Rule #22)
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
				command: "config apikeydelete",
				guildId: interaction.guild?.id,
				executorDiscordId: interaction.user.id,
			},
		};
		await log.error(
			`Error executing /config apikeydelete for user ${userData.user_disc_id}`,
			error as Error,
			context,
		);

		// 9. Inform user of unknown error
		// Use followUp since deferReply was used
		if (interaction.deferred && !interaction.replied) {
			await interaction.followUp({
				content: localizer(locale, "general.errors.unknown_error_description"),
				flags: MessageFlags.Ephemeral,
			});
		}
		// Avoid using replyInfoEmbed here to prevent potential double-reply issues
	}
}
