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
import type { UserRow, ErrorContext } from "../../types/db/schema";
import { deleteOptApiKey, hasOptApiKey } from "../../utils/security/crypto";

/**
 * Configure the subcommand for deleting Brave Search API key
 * @param subcommand - Discord slash command subcommand builder
 * @returns Configured subcommand builder
 */
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("braveapidelete")
		.setDescription(
			localizer("en-US", "commands.config.braveapidelete.description"),
		)
		.setDescriptionLocalizations({
			ja: localizer("ja", "commands.config.braveapidelete.description"),
		});

/**
 * Removes the Brave Search API key from the server's MCP configuration
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
		// 2. Show ephemeral processing message
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		// 3. Load the Tomori state for this server
		const tomoriState = await loadTomoriState(interaction.guild.id);
		if (!tomoriState) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.tomori_not_setup_title",
				descriptionKey: "general.errors.tomori_not_setup",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 4. Check if there's a Brave Search API key to remove
		const hasKey = await hasOptApiKey(tomoriState.server_id, "brave-search");
		if (!hasKey) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.braveapidelete.no_key_title",
				descriptionKey: "commands.config.braveapidelete.no_key_description",
				color: ColorCode.WARN,
			});
			return;
		}

		// 5. Delete the API key from the optional API keys table
		const isDeleted = await deleteOptApiKey(
			tomoriState.server_id,
			"brave-search",
		);

		if (!isDeleted) {
			const context: ErrorContext = {
				tomoriId: tomoriState.tomori_id,
				serverId: tomoriState.server_id,
				userId: userData.user_id,
				errorType: "DatabaseUpdateError",
				metadata: {
					command: "config braveapidelete",
					guildId: interaction.guild.id,
					serviceName: "brave-search",
				},
			};
			await log.error(
				"Failed to delete Brave Search API key from optional API keys table",
				new Error("deleteOptApiKey returned false"),
				context,
			);

			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.update_failed_title",
				descriptionKey: "general.errors.update_failed_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 6. Success message
		await replyInfoEmbed(interaction, locale, {
			titleKey: "commands.config.braveapidelete.success_title",
			descriptionKey: "commands.config.braveapidelete.success_description",
			color: ColorCode.SUCCESS,
		});
	} catch (error) {
		// 7. Log error with context
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
				command: "config braveapidelete",
				guildId: interaction.guild?.id,
				executorDiscordId: interaction.user.id,
				serviceName: "brave-search",
			},
		};
		await log.error(
			`Error executing /config braveapidelete for user ${userData.user_disc_id}`,
			error as Error,
			context,
		);

		// 8. Inform user of unknown error
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
