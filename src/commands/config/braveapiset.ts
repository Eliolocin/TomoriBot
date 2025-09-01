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
import { storeOptApiKey } from "../../utils/security/crypto";

/**
 * Configure the subcommand for setting Brave Search API key
 * @param subcommand - Discord slash command subcommand builder
 * @returns Configured subcommand builder
 */
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("braveapiset")
		.setDescription(
			localizer("en-US", "commands.config.braveapiset.description"),
		)
		.setDescriptionLocalizations({
			ja: localizer("ja", "commands.config.braveapiset.description"),
		})
		.addStringOption((option) =>
			option
				.setName("key")
				.setDescription(
					localizer("en-US", "commands.config.braveapiset.key_description"),
				)
				.setDescriptionLocalizations({
					ja: localizer("ja", "commands.config.braveapiset.key_description"),
				})
				.setRequired(true),
		);

/**
 * Sets the Brave Search API key for the server's MCP configuration
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
	if (!interaction.channel) {
		await replyInfoEmbed(interaction, userData.language_pref, {
			titleKey: "general.errors.channel_only_title",
			descriptionKey: "general.errors.channel_only_description",
			color: ColorCode.ERROR,
		});
		return;
	}

	let apiKey: string | null = null; // For error context

	try {
		// 2. Get the API key from options
		apiKey = interaction.options.getString("key", true);

		// 3. Basic validation (no specific Brave API validation available)
		if (!apiKey || apiKey.length < 10) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.braveapiset.invalid_key_title",
				descriptionKey: "commands.config.braveapiset.invalid_key_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 4. Show ephemeral processing message
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		// 5. Load the Tomori state for this server
		const tomoriState = await loadTomoriState(
			interaction.guild?.id ?? interaction.user.id,
		);
		if (!tomoriState) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.tomori_not_setup_title",
				descriptionKey: "general.errors.tomori_not_setup_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		const isStored = await storeOptApiKey(
			tomoriState.server_id,
			"brave-search",
			apiKey,
		);

		if (!isStored) {
			const context: ErrorContext = {
				tomoriId: tomoriState.tomori_id,
				serverId: tomoriState.server_id,
				userId: userData.user_id,
				errorType: "DatabaseUpdateError",
				metadata: {
					command: "config braveapiset",
					guildId: interaction.guild?.id ?? interaction.user.id,
					serviceName: "brave-search",
				},
			};
			await log.error(
				"Failed to store Brave Search API key in optional API keys table",
				new Error("storeOptApiKey returned false"),
				context,
			);

			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.update_failed_title",
				descriptionKey: "general.errors.update_failed_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 7. Success message
		await replyInfoEmbed(interaction, locale, {
			titleKey: "commands.config.braveapiset.success_title",
			descriptionKey: "commands.config.braveapiset.success_description",
			color: ColorCode.SUCCESS,
		});
	} catch (error) {
		// 8. Log error with context
		let serverIdForError: number | null = null;
		let tomoriIdForError: number | null = null;
		if (interaction.guild?.id) {
			const state = await loadTomoriState(
				interaction.guild?.id ?? interaction.user.id,
			);
			serverIdForError = state?.server_id ?? null;
			tomoriIdForError = state?.tomori_id ?? null;
		}

		const context: ErrorContext = {
			userId: userData.user_id,
			serverId: serverIdForError,
			tomoriId: tomoriIdForError,
			errorType: "CommandExecutionError",
			metadata: {
				command: "config braveapiset",
				guildId: interaction.guild?.id,
				executorDiscordId: interaction.user.id,
				serviceName: "brave-search",
				// Do not log API key here
				apiKeyLength: apiKey?.length, // Log length as a hint
			},
		};
		await log.error(
			`Error executing /config braveapiset for user ${userData.user_disc_id}`,
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
	}
}
