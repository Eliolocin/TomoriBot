/**
 * Preset Export Command
 * Exports TomoriBot's personality as a PNG file with embedded metadata
 */

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
import { exportPresetData } from "../../utils/db/presetExport";
import { getServerAvatar } from "../../utils/image/avatarHelper";
import { embedMetadataInPNG } from "../../utils/image/pngMetadata";

/**
 * Configure the 'export' subcommand
 */
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("export")
		.setDescription(localizer("en-US", "commands.preset.export.description"));

/**
 * Executes the 'export' command
 * Exports TomoriBot's personality to a PNG file and sends it to the channel
 * @param client - The Discord client instance
 * @param interaction - The chat input command interaction
 * @param userData - The user data for the invoking user
 * @param locale - The user's preferred locale
 */
export async function execute(
	client: Client,
	interaction: ChatInputCommandInteraction,
	_userData: UserRow,
	locale: string,
): Promise<void> {
	try {
		// 1. Check if command is run in a guild (server-only command)
		if (!interaction.guild) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.guild_only_title",
				descriptionKey: "general.errors.guild_only_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 2. Defer reply while we process (not ephemeral for transparency)
		await interaction.deferReply();

		// 3. Export preset data from database
		const exportResult = await exportPresetData(interaction.guild.id);

		if (!exportResult.success) {
			await interaction.editReply({
				embeds: [
					new EmbedBuilder()
						.setTitle(localizer(locale, "commands.preset.export.failed_title"))
						.setDescription(
							localizer(locale, exportResult.error),
						)
						.setColor(ColorCode.ERROR),
				],
			});
			return;
		}

		// Type is now narrowed to success variant
		const presetData = exportResult.data;

		// 4. Get server avatar (or bot default avatar)
		let avatarBuffer: Buffer;
		try {
			avatarBuffer = await getServerAvatar(interaction.guild, client);
		} catch (error) {
			log.error(
				`Failed to get server avatar for guild ${interaction.guild.id}:`,
				error as Error,
			);
			await interaction.editReply({
				embeds: [
					new EmbedBuilder()
						.setTitle(
							localizer(locale, "commands.preset.export.avatar_failed_title"),
						)
						.setDescription(
							localizer(
								locale,
								"commands.preset.export.avatar_failed_description",
							),
						)
						.setColor(ColorCode.ERROR),
				],
			});
			return;
		}

		// 5. Embed metadata into PNG
		let pngWithMetadata: Buffer;
		try {
			pngWithMetadata = embedMetadataInPNG(avatarBuffer, presetData);
		} catch (error) {
			log.error(
				`Failed to embed metadata into PNG for guild ${interaction.guild.id}:`,
				error as Error,
			);
			await interaction.editReply({
				embeds: [
					new EmbedBuilder()
						.setTitle(
							localizer(locale, "commands.preset.export.embed_failed_title"),
						)
						.setDescription(
							localizer(
								locale,
								"commands.preset.export.embed_failed_description",
							),
						)
						.setColor(ColorCode.ERROR),
				],
			});
			return;
		}

		// 6. Create filename with nickname and timestamp
		const nickname = presetData.data.tomori_nickname;
		const sanitizedNickname = nickname
			.replace(/[^a-zA-Z0-9-_]/g, "_")
			.slice(0, 50);
		const timestamp = Date.now();
		const filename = `tomori-preset-${sanitizedNickname}-${timestamp}.png`;

		// 7. Create attachment
		const attachment = new AttachmentBuilder(pngWithMetadata, {
			name: filename,
		});

		// 8. Send to channel (visible to everyone for transparency)
		await interaction.editReply({
			embeds: [
				new EmbedBuilder()
					.setTitle(localizer(locale, "commands.preset.export.success_title"))
					.setDescription(
						localizer(locale, "commands.preset.export.success_description", {
							nickname: nickname,
						}),
					)
					.setColor(ColorCode.SUCCESS),
			],
			files: [attachment],
		});

		log.success(
			`Successfully exported preset for guild ${interaction.guild.id}: ${nickname}`,
		);
	} catch (error) {
		log.error("Error executing preset export command:", error, {
			errorType: "CommandExecutionError",
			metadata: { commandName: "preset export" },
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
