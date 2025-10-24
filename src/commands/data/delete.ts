import type {
	ChatInputCommandInteraction,
	Client,
	SlashCommandSubcommandBuilder,
} from "discord.js";
import { MessageFlags } from "discord.js";
import { sql } from "bun";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import { replyInfoEmbed } from "../../utils/discord/interactionHelper";
import type { UserRow, ErrorContext } from "../../types/db/schema";

/**
 * Configure the 'delete' subcommand
 */
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("delete")
		.setDescription(localizer("en-US", "commands.data.delete.description"))
		.addStringOption((option) =>
			option
				.setName("type")
				.setDescription(
					localizer("en-US", "commands.data.delete.type_description"),
				)
				.setRequired(true)
				.addChoices(
					{
						name: localizer("en-US", "commands.data.delete.type_choice_personal"),
						value: "personal",
					},
					{
						name: localizer("en-US", "commands.data.delete.type_choice_server"),
						value: "server",
					},
				),
		)
		.addStringOption((option) =>
			option
				.setName("confirmation")
				.setDescription(
					localizer("en-US", "commands.data.delete.confirmation_description"),
				)
				.setRequired(true)
				.addChoices({
					name: localizer("en-US", "commands.data.delete.confirmation_yes"),
					value: "yes",
				}),
		);

/**
 * Executes the 'delete' command
 * Permanently deletes user or server data with proper CASCADE behavior
 * @param client - The Discord client instance
 * @param interaction - The chat input command interaction
 * @param userData - The user data for the invoking user
 * @param locale - The user's preferred locale
 */
export async function execute(
	_client: Client,
	interaction: ChatInputCommandInteraction,
	userData: UserRow,
	locale: string,
): Promise<void> {
	// 1. Get the delete type and confirmation options
	const deleteType = interaction.options.getString("type", true);
	const confirmation = interaction.options.getString("confirmation", true);

	try {
		// 2. Validate confirmation
		if (confirmation !== "yes") {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.data.delete.confirmation_required_title",
				descriptionKey:
					"commands.data.delete.confirmation_required_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 3. Check permissions and context for server deletions
		if (deleteType === "server") {
			// 3a. Server deletions require guild context
			if (!interaction.guild) {
				await replyInfoEmbed(interaction, locale, {
					titleKey: "general.errors.guild_only_title",
					descriptionKey: "general.errors.guild_only_description",
					color: ColorCode.ERROR,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			// 3b. Server deletions require Manage Server permission
			// In DMs, there's no guild/permissions, so we skip this check
			const hasPermission =
				interaction.memberPermissions?.has("ManageGuild") ?? false;

			if (!hasPermission) {
				await replyInfoEmbed(interaction, locale, {
					titleKey: "commands.data.delete.no_permission_title",
					descriptionKey: "commands.data.delete.no_permission_description",
					color: ColorCode.ERROR,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}
		}

		// 4. Defer reply while we process the deletion
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		// 5. Execute deletion based on type
		if (deleteType === "personal") {
			// 5a. Delete personal data (user row - CASCADE handles related data)
			const userDiscId = interaction.user.id;

			const deletedRows = await sql`
				DELETE FROM users
				WHERE user_disc_id = ${userDiscId}
				RETURNING user_id
			`;

			if (deletedRows.length === 0) {
				// User data doesn't exist (might have been already deleted or never created)
				await replyInfoEmbed(interaction, locale, {
					titleKey: "commands.data.delete.no_data_title",
					descriptionKey: "commands.data.delete.no_data_description",
					color: ColorCode.WARN,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			// Log successful deletion
			log.success(
				`Personal data deleted for user ${userDiscId} (user_id: ${deletedRows[0].user_id})`,
			);

			// Show success message
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.data.delete.success_personal_title",
				descriptionKey: "commands.data.delete.success_personal_description",
				color: ColorCode.SUCCESS,
				flags: MessageFlags.Ephemeral,
			});
		} else if (deleteType === "server") {
			// 5b. Delete server data (server row - CASCADE handles all related data)
			// biome-ignore lint/style/noNonNullAssertion: Already validated guild exists above
			const serverDiscId = interaction.guild!.id;

			const deletedRows = await sql`
				DELETE FROM servers
				WHERE server_disc_id = ${serverDiscId}
				RETURNING server_id
			`;

			if (deletedRows.length === 0) {
				// Server data doesn't exist (might have been already deleted or never setup)
				await replyInfoEmbed(interaction, locale, {
					titleKey: "commands.data.delete.no_server_data_title",
					descriptionKey: "commands.data.delete.no_server_data_description",
					color: ColorCode.WARN,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			// Log successful deletion
			log.success(
				`Server data deleted for server ${serverDiscId} (server_id: ${deletedRows[0].server_id})`,
			);

			// Show success message
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.data.delete.success_server_title",
				descriptionKey: "commands.data.delete.success_server_description",
				color: ColorCode.SUCCESS,
				flags: MessageFlags.Ephemeral,
			});
		} else {
			// Invalid type (should never happen due to addChoices, but handle defensively)
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.invalid_option_title",
				descriptionKey: "general.errors.invalid_option_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
		}
	} catch (error) {
		// 6. Handle unexpected errors
		const context: ErrorContext = {
			userId: userData.user_id,
			serverId: interaction.guild?.id,
			errorType: "CommandExecutionError",
			metadata: {
				command: "data delete",
				deleteType,
				userDiscordId: interaction.user.id,
				guildId: interaction.guild?.id,
			},
		};

		await log.error(
			`Error executing /data delete for user ${userData.user_disc_id}`,
			error as Error,
			context,
		);

		// Inform user of error
		if (interaction.deferred || interaction.replied) {
			await interaction.followUp({
				content: localizer(locale, "general.errors.unknown_error_description"),
				flags: MessageFlags.Ephemeral,
			});
		} else {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.unknown_error_title",
				descriptionKey: "general.errors.unknown_error_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
		}
	}
}
