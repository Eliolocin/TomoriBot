import {
	MessageFlags,
	type ChatInputCommandInteraction,
	type Client,
	type SlashCommandSubcommandBuilder,
} from "discord.js";
import { loadTomoriState } from "../../utils/db/dbRead"; // Rule 17
import { localizer } from "../../utils/text/localizer"; // Rule 9
import { log, ColorCode } from "../../utils/misc/logger"; // Rule 18
import { replyInfoEmbed } from "../../utils/discord/interactionHelper"; // Rule 12, 19
import {
	type UserRow,
	type ErrorContext,
	tomoriConfigSchema, // Rule 6
} from "../../types/db/schema";
import { sql } from "bun"; // Rule 4
// Rule 21: Configure the subcommand
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("tomoripermissions")
		.setDescription(
			localizer(
				"en-US",
				"commands.config.tomoripermissions.description",
			),
		)
		.addStringOption((option) =>
			option
				.setName("permission")
				.setDescription(
					localizer(
						"en-US",
						"commands.config.tomoripermissions.option_description",
					),
				)
				.setDescriptionLocalizations({
					ja: localizer(
						"ja",
						"commands.config.tomoripermissions.option_description",
					),
				})
				.setRequired(true)
				.addChoices(
					{
						name: localizer(
							"en-US",
							"commands.config.tomoripermissions.selfteaching_option",
						),
						value: "selfteaching",
					},
					{
						name: localizer(
							"en-US",
							"commands.config.tomoripermissions.personalization_option",
						),
						value: "personalization",
					},
					{
						name: localizer(
							"en-US",
							"commands.config.tomoripermissions.emojiusage_option",
						),
						value: "emojiusage",
					},
					{
						name: localizer(
							"en-US",
							"commands.config.tomoripermissions.stickerusage_option",
						),
						value: "stickerusage",
					},
					// New: Added Google Search permission choice
					{
						name: localizer(
							"en-US",
							"commands.config.tomoripermissions.websearch_option",
						),
						value: "websearch",
					},
				),
		)
		.addStringOption((option) =>
			option
				.setName("set")
				.setDescription(
					localizer(
						"en-US",
						"commands.config.tomoripermissions.set_description",
					),
				)
				.setDescriptionLocalizations({
					ja: localizer(
						"ja",
						"commands.config.tomoripermissions.set_description",
					),
				})
				.setRequired(true)
				.addChoices(
					{
						name: localizer("en-US", "commands.config.options.enable"),
						value: "enable",
					},
					{
						name: localizer("en-US", "commands.config.options.disable"),
						value: "disable",
					},
				),
		);

/**
 * Rule 1: JSDoc comment
 * Configures various permissions for Tomori's behavior on the server.
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
		// 2. Get command options
		const permissionChoice = interaction.options.getString("permission", true);
		const setAction = interaction.options.getString("set", true);
		const isEnabled = setAction === "enable";

		// 3. Show ephemeral processing message
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

		// 5. Determine the database column and localization key based on permission choice
		let dbColumnName = "";
		let permissionTypeKey = ""; // For user-facing permission name
		let currentSetting: boolean | undefined;

		switch (permissionChoice) {
			case "selfteaching":
				dbColumnName = "self_teaching_enabled";
				permissionTypeKey =
					"commands.config.tomoripermissions.selfteaching_option";
				currentSetting = tomoriState.config.self_teaching_enabled;
				break;
			case "personalization":
				dbColumnName = "personal_memories_enabled";
				permissionTypeKey =
					"commands.config.tomoripermissions.personalization_option";
				currentSetting = tomoriState.config.personal_memories_enabled;
				break;
			case "emojiusage":
				dbColumnName = "emoji_usage_enabled";
				permissionTypeKey =
					"commands.config.tomoripermissions.emojiusage_option";
				currentSetting = tomoriState.config.emoji_usage_enabled;
				break;
			case "stickerusage":
				dbColumnName = "sticker_usage_enabled";
				permissionTypeKey =
					"commands.config.tomoripermissions.stickerusage_option";
				currentSetting = tomoriState.config.sticker_usage_enabled;
				break;
			// New: Handle Web Search permission (Brave Search)
			case "websearch":
				dbColumnName = "web_search_enabled";
				permissionTypeKey =
					"commands.config.tomoripermissions.websearch_option";
				currentSetting = tomoriState.config.web_search_enabled;
				break;
			default:
				// This should not happen due to Discord's option validation
				log.error(
					`Invalid permissionChoice received in /config tomoripermissions: ${permissionChoice}`,
				);
				await replyInfoEmbed(interaction, locale, {
					titleKey: "general.errors.invalid_option_title",
					descriptionKey: "general.errors.invalid_option",
					color: ColorCode.ERROR,
				});
				return;
		}

		// 6. Check if the setting is already the desired value
		if (currentSetting === isEnabled) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.tomoripermissions.already_set_title",
				descriptionKey: isEnabled
					? "commands.config.tomoripermissions.already_enabled_description"
					: "commands.config.tomoripermissions.already_disabled_description",
				descriptionVars: {
					permission_type: localizer(locale, permissionTypeKey),
				},
				color: ColorCode.WARN,
			});
			return;
		}

		// 7. Update the config in the database using direct SQL (Rule #4, #15)
		// sql.unsafe is used here because dbColumnName is dynamic.
		// This is safe because dbColumnName is strictly controlled by the switch statement.
		const [updatedRow] = await sql`
            UPDATE tomori_configs
            SET ${sql.unsafe(dbColumnName)} = ${isEnabled}
            WHERE tomori_id = ${tomoriState.tomori_id}
            RETURNING *
        `;

		// 8. Validate the returned data (Rules #3, #5 - critical config change)
		const validatedConfig = tomoriConfigSchema.safeParse(updatedRow);

		if (!validatedConfig.success || !updatedRow) {
			const context: ErrorContext = {
				tomoriId: tomoriState.tomori_id,
				serverId: tomoriState.server_id,
				userId: userData.user_id,
				errorType: "DatabaseUpdateError",
				metadata: {
					command: "config tomoripermissions",
					guildId: interaction.guild.id,
					permissionChoice,
					dbColumnName,
					isEnabled,
					validationErrors: validatedConfig.success
						? null
						: validatedConfig.error.flatten(),
				},
			};
			await log.error(
				"Failed to update or validate Tomori permissions config",
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

		// 9. Success! Show the permission change
		await replyInfoEmbed(interaction, locale, {
			titleKey: "commands.config.tomoripermissions.success_title",
			descriptionKey: isEnabled
				? "commands.config.tomoripermissions.enabled_success"
				: "commands.config.tomoripermissions.disabled_success",
			descriptionVars: {
				permission_type: localizer(locale, permissionTypeKey),
			},
			color: isEnabled ? ColorCode.SUCCESS : ColorCode.WARN, // WARN for disable
		});
	} catch (error) {
		// 10. Log error with context (Rule #22)
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
				command: "config tomoripermissions",
				guildId: interaction.guild?.id,
				executorDiscordId: interaction.user.id,
				permissionAttempted: interaction.options.getString("permission"),
				actionAttempted: interaction.options.getString("set"),
			},
		};
		await log.error(
			`Error executing /config tomoripermissions for user ${userData.user_disc_id}`,
			error as Error,
			context,
		);

		// 11. Inform user of unknown error
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
