import {
	MessageFlags,
	type ChatInputCommandInteraction,
	type Client,
	type SlashCommandSubcommandBuilder,
} from "discord.js";
import { sql } from "bun";
import { loadTomoriState } from "../../utils/db/dbRead";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import { replyInfoEmbed } from "../../utils/discord/interactionHelper";
import type { UserRow, ErrorContext } from "../../types/db/schema";

// Configure the subcommand
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("blacklist")
		.setDescription(
			localizer("en-US", "commands.serverconfig.blacklist.description"),
		)
		.addUserOption((option) =>
			option
				.setName("member")
				.setDescription(
					localizer(
						"en-US",
						"commands.serverconfig.blacklist.member_description",
					),
				)
				.setRequired(true),
		)
		.addStringOption((option) =>
			option
				.setName("action")
				.setDescription(
					localizer(
						"en-US",
						"commands.serverconfig.blacklist.action_description",
					),
				)
				.setRequired(true)
				.addChoices(
					{
						name: localizer("en-US", "commands.choices.add"),
						value: "add",
					},
					{
						name: localizer("en-US", "commands.choices.remove"),
						value: "remove",
					},
				),
		);

/**
 * Configures blacklist for Tomori. Blacklisted members won't have their
 * personalization options reflected to Tomori's context
 * @param _client - Discord client instance
 * @param interaction - Command interaction
 * @param userData - User data from database (the command executor)
 * @param locale - Locale of the interaction
 */
export async function execute(
	_client: Client,
	interaction: ChatInputCommandInteraction,
	userData: UserRow, // This is the user executing the command
	locale: string,
): Promise<void> {
	// 1. Ensure command is run in a guild
	if (!interaction.guild || !interaction.channel) {
		await replyInfoEmbed(interaction, userData.language_pref, {
			titleKey: "general.errors.guild_only_title",
			descriptionKey: "general.errors.guild_only_description",
			color: ColorCode.ERROR,
		});
		return;
	}

	const targetDiscordUser = interaction.options.getUser("member", true); // Discord User object

	try {
		// 2. Get command options
		const action = interaction.options.getString("action", true);

		// 2a. Prevent blacklisting bots (including TomoriBot herself)
		if (targetDiscordUser.bot) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.serverconfig.blacklist.cannot_blacklist_bot_title",
				descriptionKey:
					"commands.serverconfig.blacklist.cannot_blacklist_bot_description",
				descriptionVars: {
					user_name: targetDiscordUser.username,
				},
				color: ColorCode.ERROR,
			});
			return;
		}

		// 3. Load the Tomori state for this server - let helper functions manage interaction state
		const tomoriState = await loadTomoriState(interaction.guild.id);
		if (!tomoriState) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.tomori_not_setup_title",
				descriptionKey: "general.errors.tomori_not_setup_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 5. Check if personalization is enabled at all
		if (!tomoriState.config.personal_memories_enabled) {
			await replyInfoEmbed(interaction, locale, {
				titleKey:
					"commands.serverconfig.blacklist.personalization_disabled_title",
				descriptionKey:
					"commands.serverconfig.blacklist.personalization_disabled_description",
				color: ColorCode.WARN,
			});
			return;
		}

		// 6. Check if the user is already in the blacklist state matches the action
		// Now using Discord ID directly (no need to register user or get internal ID)
		const [existingEntry] = await sql`
            SELECT 1 FROM personalization_blacklist
            WHERE server_id = ${tomoriState.server_id} AND user_disc_id = ${targetDiscordUser.id}
            LIMIT 1
        `;

		const isAlreadyBlacklisted = !!existingEntry;

		// 7a. Prevent adding if already blacklisted
		if (action === "add" && isAlreadyBlacklisted) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.serverconfig.blacklist.already_blacklisted_title",
				descriptionKey:
					"commands.serverconfig.blacklist.already_blacklisted_description",
				descriptionVars: {
					user_name: targetDiscordUser.username,
				},
				color: ColorCode.WARN,
			});
			return;
		}

		// 7b. Prevent removing if not blacklisted
		if (action === "remove" && !isAlreadyBlacklisted) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.serverconfig.blacklist.not_blacklisted_title",
				descriptionKey:
					"commands.serverconfig.blacklist.not_blacklisted_description",
				descriptionVars: {
					user_name: targetDiscordUser.username,
				},
				color: ColorCode.WARN,
			});
			return;
		}

		// 8. Update the blacklist based on the action using direct SQL
		// Now using user_disc_id instead of user_id (persists across account deletions)
		if (action === "add") {
			await sql`
                INSERT INTO personalization_blacklist (server_id, user_disc_id)
                VALUES (${tomoriState.server_id}, ${targetDiscordUser.id})
            `;
			log.info(
				`Added user ${targetDiscordUser.id} to blacklist for server ${tomoriState.server_id}`,
			);
		} else {
			await sql`
                DELETE FROM personalization_blacklist
                WHERE server_id = ${tomoriState.server_id} AND user_disc_id = ${targetDiscordUser.id}
            `;
			log.info(
				`Removed user ${targetDiscordUser.id} from blacklist for server ${tomoriState.server_id}`,
			);
		}

		// 9. Send success confirmation message (Rule #12, #19)
		if (action === "add") {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.serverconfig.blacklist.added_title",
				descriptionKey: "commands.serverconfig.blacklist.added_description",
				descriptionVars: {
					user_name: targetDiscordUser.username,
				},
				color: ColorCode.SUCCESS,
			});
		} else {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.serverconfig.blacklist.removed_title",
				descriptionKey: "commands.serverconfig.blacklist.removed_description",
				descriptionVars: {
					user_name: targetDiscordUser.username,
				},
				color: ColorCode.WARN, // Use WARN for removal actions
			});
		}
	} catch (error) {
		// 10. Log error with context (Rule #22)
		// Attempt to get server/tomori IDs only once if needed
		let serverIdForError: number | null = null;
		let tomoriIdForError: number | null = null;
		if (interaction.guild?.id) {
			const state = await loadTomoriState(interaction.guild.id);
			serverIdForError = state?.server_id ?? null;
			tomoriIdForError = state?.tomori_id ?? null;
		}

		const context: ErrorContext = {
			userId: userData.user_id, // Executor's internal ID
			serverId: serverIdForError,
			tomoriId: tomoriIdForError,
			errorType: "CommandExecutionError",
			metadata: {
				command: "config blacklist",
				guildId: interaction.guild?.id,
				executorDiscordId: interaction.user.id, // Executor's Discord ID
				targetDiscordUserId: targetDiscordUser.id, // Target's Discord ID
				action: interaction.options.getString("action", true),
			},
		};
		await log.error(
			`Error executing /config blacklist for user ${userData.user_disc_id}`,
			error as Error,
			context,
		);

		// 11. Inform user of unknown error
		// Check if the interaction has already been replied to or deferred
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
		// Using followUp as deferReply was called. replyInfoEmbed might try to editReply again.
		// Simplified error reply for safety.
	}
}
