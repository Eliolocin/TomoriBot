import type {
	ChatInputCommandInteraction,
	Client,
	SlashCommandSubcommandBuilder,
} from "discord.js";
import { AttachmentBuilder, MessageFlags, EmbedBuilder } from "discord.js";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import { replyInfoEmbed } from "../../utils/discord/interactionHelper";
import type { UserRow } from "../../types/db/schema";
import {
	exportPersonalData,
	exportServerData,
	exportPersonalityData,
} from "../../utils/db/dataExport";

/**
 * Configure the 'export' subcommand
 */
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("export")
		.setDescription(localizer("en-US", "commands.data.export.description"))
		.addStringOption((option) =>
			option
				.setName("type")
				.setDescription(
					localizer("en-US", "commands.data.export.type_description"),
				)
				.setRequired(true)
				.addChoices(
					{
						name: localizer("en-US", "commands.data.export.type_choice_personal"),
						value: "personal",
					},
					{
						name: localizer("en-US", "commands.data.export.type_choice_server"),
						value: "server",
					},
					{
						name: localizer("en-US", "commands.data.export.type_choice_personality"),
						value: "personality",
					},
				),
		);

/**
 * Executes the 'export' command
 * Exports user or server data to a JSON file and sends it via DM
 * @param client - The Discord client instance
 * @param interaction - The chat input command interaction
 * @param userData - The user data for the invoking user
 * @param locale - The user's preferred locale
 */
export async function execute(
	_client: Client,
	interaction: ChatInputCommandInteraction,
	_userData: UserRow,
	locale: string,
): Promise<void> {
	// 1. Get the export type option
	const exportType = interaction.options.getString("type", true);

	try {
		// 2. Check permissions for server and personality exports
		if (exportType === "server" || exportType === "personality") {
			// Server and personality exports require Manage Server permission
			const hasPermission =
				interaction.memberPermissions?.has("ManageGuild") ?? false;

			if (!hasPermission) {
				await replyInfoEmbed(interaction, locale, {
					titleKey: "commands.data.export.no_permission_title",
					descriptionKey: "commands.data.export.no_permission_description",
					color: ColorCode.ERROR,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			// Server and personality exports require a guild context
			if (!interaction.guild) {
				await replyInfoEmbed(interaction, locale, {
					titleKey: "general.errors.guild_only_title",
					descriptionKey: "general.errors.guild_only_description",
					color: ColorCode.ERROR,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}
		}

		// 3. Defer reply while we process
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		// 4. Handle personality export separately (returns text instead of JSON)
		if (exportType === "personality" && interaction.guild) {
			const personalityResult = await exportPersonalityData(
				interaction.guild.id,
			);

			if (!personalityResult.success || !personalityResult.text) {
				await interaction.editReply({
					embeds: [
						new EmbedBuilder()
							.setTitle(localizer(locale, "commands.data.export.failed_title"))
							.setDescription(
								personalityResult.error
									? localizer(locale, personalityResult.error)
									: localizer(locale, "commands.data.export.failed_description"),
							)
							.setColor(ColorCode.ERROR),
					],
				});
				return;
			}

			// Create text file attachment
			const filename = `tomori-personality-${interaction.guild.id}-${Date.now()}.txt`;
			const attachment = new AttachmentBuilder(
				Buffer.from(personalityResult.text, "utf-8"),
				{
					name: filename,
				},
			);

			// Get bot's guild avatar for the thumbnail
			const botMember = await interaction.guild.members.fetch(
				interaction.client.user.id,
			);
			const botAvatarUrl = botMember.displayAvatarURL({ size: 256 });

			// Send to user's DM with bot avatar thumbnail
			try {
				await interaction.user.send({
					embeds: [
						new EmbedBuilder()
							.setTitle(localizer(locale, "commands.data.export.dm_title"))
							.setDescription(
								localizer(locale, "commands.data.export.dm_description_personality"),
							)
							.setThumbnail(botAvatarUrl)
							.setColor(ColorCode.INFO),
					],
					files: [attachment],
				});

				// Confirm success in the channel
				await interaction.editReply({
					embeds: [
						new EmbedBuilder()
							.setTitle(localizer(locale, "commands.data.export.success_title"))
							.setDescription(
								localizer(
									locale,
									"commands.data.export.success_description_personality",
								),
							)
							.setColor(ColorCode.SUCCESS),
					],
				});
			} catch (dmError) {
				// DM failed, likely because user has DMs disabled
				log.warn(
					`Failed to send personality export DM to user ${interaction.user.id}:`,
					dmError as Error,
				);
				await interaction.editReply({
					embeds: [
						new EmbedBuilder()
							.setTitle(localizer(locale, "commands.data.export.dm_failed_title"))
							.setDescription(
								localizer(locale, "commands.data.export.dm_failed_description"),
							)
							.setColor(ColorCode.ERROR),
					],
				});
			}
			return;
		}

		// 5. Export data based on type (personal or server)
		let exportResult:
			| Awaited<ReturnType<typeof exportPersonalData>>
			| Awaited<ReturnType<typeof exportServerData>>;
		let filename: string;

		if (exportType === "personal") {
			exportResult = await exportPersonalData(interaction.user.id);
			filename = `tomori-personal-${interaction.user.id}-${Date.now()}.json`;
		} else if (exportType === "server" && interaction.guild) {
			exportResult = await exportServerData(interaction.guild.id);
			filename = `tomori-server-${interaction.guild.id}-${Date.now()}.json`;
		} else {
			await interaction.editReply({
				embeds: [
					new EmbedBuilder()
						.setTitle(localizer(locale, "general.errors.invalid_option_title"))
						.setDescription(
							localizer(locale, "general.errors.invalid_option_description"),
						)
						.setColor(ColorCode.ERROR),
				],
			});
			return;
		}

		// 6. Handle export errors
		if (!exportResult.success || !exportResult.data) {
			await interaction.editReply({
				embeds: [
					new EmbedBuilder()
						.setTitle(localizer(locale, "commands.data.export.failed_title"))
						.setDescription(
							exportResult.error
								? localizer(locale, exportResult.error)
								: localizer(locale, "commands.data.export.failed_description"),
						)
						.setColor(ColorCode.ERROR),
				],
			});
			return;
		}

		// 7. Create JSON file attachment
		const jsonString = JSON.stringify(exportResult.data, null, 2);
		const attachment = new AttachmentBuilder(Buffer.from(jsonString, "utf-8"), {
			name: filename,
		});

		// 8. Send to user's DM
		try {
			// Use different description for server exports (mentions excluded data)
			const dmDescriptionKey =
				exportType === "server"
					? "commands.data.export.dm_description_server"
					: "commands.data.export.dm_description";

			await interaction.user.send({
				embeds: [
					new EmbedBuilder()
						.setTitle(localizer(locale, "commands.data.export.dm_title"))
						.setDescription(
							localizer(locale, dmDescriptionKey, {
								type: exportType,
							}),
						)
						.setColor(ColorCode.INFO),
				],
				files: [attachment],
			});

			// 9. Confirm success in the channel
			await interaction.editReply({
				embeds: [
					new EmbedBuilder()
						.setTitle(localizer(locale, "commands.data.export.success_title"))
						.setDescription(
							localizer(locale, "commands.data.export.success_description", {
								type: exportType,
							}),
						)
						.setColor(ColorCode.SUCCESS),
				],
			});
		} catch (dmError) {
			// DM failed, likely because user has DMs disabled
			log.warn(`Failed to send export DM to user ${interaction.user.id}:`, dmError as Error);
			await interaction.editReply({
				embeds: [
					new EmbedBuilder()
						.setTitle(localizer(locale, "commands.data.export.dm_failed_title"))
						.setDescription(
							localizer(locale, "commands.data.export.dm_failed_description"),
						)
						.setColor(ColorCode.ERROR),
				],
			});
		}
	} catch (error) {
		log.error("Error executing export command:", error, {
			errorType: "CommandExecutionError",
			metadata: { commandName: "export", exportType },
		});

		// If we haven't replied yet, reply with error
		if (!interaction.replied && !interaction.deferred) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.unknown_error_title",
				descriptionKey: "general.errors.unknown_error_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
		} else {
			await interaction.editReply({
				embeds: [
					new EmbedBuilder()
						.setTitle(localizer(locale, "general.errors.unknown_error_title"))
						.setDescription(
							localizer(locale, "general.errors.unknown_error_description"),
						)
						.setColor(ColorCode.ERROR),
				],
			});
		}
	}
}
