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
		.setName("memberpermissions")
		.setDescription(
			localizer(
				"en-US",
				"commands.config.memberpermissions.command_description",
			),
		)
		.setDescriptionLocalizations({
			ja: localizer(
				"ja",
				"commands.config.memberpermissions.command_description",
			),
		})
		.addStringOption((option) =>
			option
				.setName("permission")
				.setDescription(
					localizer(
						"en-US",
						"commands.config.memberpermissions.option_description",
					),
				)
				.setDescriptionLocalizations({
					ja: localizer(
						"ja",
						"commands.config.memberpermissions.option_description",
					),
				})
				.setRequired(true)
				.addChoices(
					{
						name: localizer(
							"en-US",
							"commands.config.memberpermissions.servermemories_option",
						),
						value: "servermemories",
					},
					{
						name: localizer(
							"en-US",
							"commands.config.memberpermissions.attributelist_option",
						),
						value: "attributelist",
					},
					{
						name: localizer(
							"en-US",
							"commands.config.memberpermissions.sampledialogues_option",
						),
						value: "sampledialogues",
					},
				),
		)
		.addStringOption((option) =>
			option
				.setName("set")
				.setDescription(
					localizer(
						"en-US",
						"commands.config.memberpermissions.set_description",
					),
				)
				.setDescriptionLocalizations({
					ja: localizer(
						"ja",
						"commands.config.memberpermissions.set_description",
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
 * Configures which Teach permissions members with no Manage Server permissions have.
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
		const permissionType = interaction.options.getString("permission", true);
		const setAction = interaction.options.getString("set", true);
		const isEnabled = setAction === "enable";

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

		// 5. Determine the database column and localization key based on permission type
		let dbColumnName = "";
		let permissionTypeKey = "";
		let currentSetting: boolean | undefined;

		switch (permissionType) {
			case "servermemories":
				dbColumnName = "server_memteaching_enabled";
				permissionTypeKey =
					"commands.config.memberpermissions.servermemories_option";
				currentSetting = tomoriState.config.server_memteaching_enabled;
				break;
			case "attributelist":
				dbColumnName = "attribute_memteaching_enabled";
				permissionTypeKey =
					"commands.config.memberpermissions.attributelist_option";
				currentSetting = tomoriState.config.attribute_memteaching_enabled;
				break;
			case "sampledialogues":
				dbColumnName = "sampledialogue_memteaching_enabled";
				permissionTypeKey =
					"commands.config.memberpermissions.sampledialogues_option";
				currentSetting = tomoriState.config.sampledialogue_memteaching_enabled;
				break;
			default:
				// This should never happen due to Discord's option validation
				// Log an error just in case
				log.error(
					`Invalid permissionType received in /config memberpermissions: ${permissionType}`,
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
				titleKey: "commands.config.memberpermissions.already_set_title",
				descriptionKey: isEnabled
					? "commands.config.memberpermissions.already_enabled_description"
					: "commands.config.memberpermissions.already_disabled_description",
				descriptionVars: {
					permission_type: localizer(locale, permissionTypeKey),
				},
				color: ColorCode.WARN,
			});
			return;
		}

		// 7. Update the config in the database using direct SQL (Rule #4, #15)
		// We use sql.unsafe here ONLY because the column name is dynamic based on user input.
		// This is generally discouraged, but safe here because:
		// a) The possible values for dbColumnName are strictly controlled by the switch statement above.
		// b) The actual value being set (`isEnabled`) is parameterized.
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
					command: "config memberpermissions",
					guildId: interaction.guild.id,
					permissionType,
					dbColumnName, // Log the actual column name attempted
					isEnabled,
					validationErrors: validatedConfig.success
						? null
						: validatedConfig.error.flatten(),
				},
			};
			await log.error(
				"Failed to update or validate member permissions config",
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
			titleKey: "commands.config.memberpermissions.success_title",
			descriptionKey: isEnabled
				? "commands.config.memberpermissions.enabled_success"
				: "commands.config.memberpermissions.disabled_success",
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
				command: "config memberpermissions",
				guildId: interaction.guild?.id,
				executorDiscordId: interaction.user.id,
				permissionAttempted: interaction.options.getString("permission"),
				actionAttempted: interaction.options.getString("set"),
			},
		};
		await log.error(
			`Error executing /config memberpermissions for user ${userData.user_disc_id}`,
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
