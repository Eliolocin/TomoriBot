/**
 * Preset Import Command
 * Imports TomoriBot's personality from a PNG file with embedded metadata
 */

import type {
	ChatInputCommandInteraction,
	Client,
	SlashCommandSubcommandBuilder,
} from "discord.js";
import { MessageFlags, EmbedBuilder } from "discord.js";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import { replyInfoEmbed } from "../../utils/discord/interactionHelper";
import type { UserRow } from "../../types/db/schema";
import {
	validatePresetFile,
	importPresetData,
} from "../../utils/db/presetImport";
import type { PresetExportData } from "../../types/preset/presetExport";
import { extractMetadataFromPNG } from "../../utils/image/pngMetadata";
import { validatePNGBuffer } from "../../utils/image/avatarHelper";

/**
 * Maximum file size for imports (10MB)
 */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * Helper function to localize error messages from utility functions
 * Handles both simple locale keys and keys with pipe-separated variables
 * @param locale - User's locale
 * @param errorString - Error string (locale key or key|var1|var2...)
 * @returns Localized error message
 */
function localizeError(locale: string, errorString: string): string {
	const parts = errorString.split("|");
	const key = parts[0];

	if (parts.length === 1) {
		// Simple locale key without variables
		return localizer(locale, key);
	}

	// Handle keys with variables
	if (key === "commands.preset.import.error_invalid_attribute") {
		return localizer(locale, key, { details: parts[1] });
	}
	if (key === "commands.preset.import.error_invalid_dialogue_in") {
		return localizer(locale, key, { details: parts[1] });
	}
	if (key === "commands.preset.import.error_invalid_dialogue_out") {
		return localizer(locale, key, { details: parts[1] });
	}
	if (key === "commands.preset.import.error_invalid_trigger_word") {
		return localizer(locale, key, { details: parts[1] });
	}
	if (key === "commands.preset.import.error_incompatible_version") {
		return localizer(locale, key, { expected: parts[1], actual: parts[2] });
	}
	if (key === "commands.preset.import.error_invalid_type") {
		return localizer(locale, key, { type: parts[1] });
	}

	// Fallback: just localize the key
	return localizer(locale, key);
}

/**
 * Configure the 'import' subcommand
 */
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("import")
		.setDescription(localizer("en-US", "commands.preset.import.description"))
		.addAttachmentOption((option) =>
			option
				.setName("file")
				.setDescription(
					localizer("en-US", "commands.preset.import.file_description"),
				)
				.setRequired(true),
		)
		.addStringOption((option) =>
			option
				.setName("confirmation")
				.setDescription(
					localizer("en-US", "commands.preset.import.confirmation_description"),
				)
				.setRequired(true)
				.addChoices(
					{
						name: localizer(
							"en-US",
							"commands.preset.import.confirmation_choice_yes",
						),
						value: "yes",
					},
					{
						name: localizer(
							"en-US",
							"commands.preset.import.confirmation_choice_no",
						),
						value: "no",
					},
				),
		);

/**
 * Executes the 'import' command
 * Imports TomoriBot's personality from an uploaded PNG file
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
	try {
		// 1. Check confirmation
		const confirmation = interaction.options.getString("confirmation", true);

		if (confirmation !== "yes") {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.preset.import.cancelled_title",
				descriptionKey: "commands.preset.import.cancelled_description",
				color: ColorCode.INFO,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 2. Check if command is run in a guild (server-only command)
		if (!interaction.guild) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.guild_only_title",
				descriptionKey: "general.errors.guild_only_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 3. Check permissions (ManageGuild required for import)
		const hasPermission =
			interaction.memberPermissions?.has("ManageGuild") ?? false;

		if (!hasPermission) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.preset.import.no_permission_title",
				descriptionKey: "commands.preset.import.no_permission_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 4. Get uploaded file attachment
		const attachment = interaction.options.getAttachment("file", true);

		// 5. Validate file type and size
		if (!attachment.name.endsWith(".png")) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.preset.import.invalid_file_type_title",
				descriptionKey: "commands.preset.import.invalid_file_type_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		if (attachment.size > MAX_FILE_SIZE) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.preset.import.file_too_large_title",
				descriptionKey: "commands.preset.import.file_too_large_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 6. Defer reply while we process
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		// 7. Download the PNG file
		let pngBuffer: Buffer;
		try {
			const response = await fetch(attachment.url);
			if (!response.ok) {
				throw new Error(
					`Failed to download file: ${response.status} ${response.statusText}`,
				);
			}
			const arrayBuffer = await response.arrayBuffer();
			pngBuffer = Buffer.from(arrayBuffer);
		} catch (downloadError) {
			log.error("Failed to download attachment:", downloadError as Error);
			await interaction.editReply({
				embeds: [
					new EmbedBuilder()
						.setTitle(
							localizer(locale, "commands.preset.import.download_failed_title"),
						)
						.setDescription(
							localizer(
								locale,
								"commands.preset.import.download_failed_description",
							),
						)
						.setColor(ColorCode.ERROR),
				],
			});
			return;
		}

		// 8. Validate PNG buffer
		const pngValidation = validatePNGBuffer(pngBuffer, MAX_FILE_SIZE);
		if (!pngValidation.isValid) {
			log.warn(
				`Invalid PNG buffer during preset import: ${pngValidation.error}`,
			);
			await interaction.editReply({
				embeds: [
					new EmbedBuilder()
						.setTitle(
							localizer(locale, "commands.preset.import.invalid_png_title"),
						)
						.setDescription(
							localizer(
								locale,
								"commands.preset.import.invalid_png_description",
							),
						)
						.setColor(ColorCode.ERROR),
				],
			});
			return;
		}

		// 9. Extract metadata from PNG
		const metadata = extractMetadataFromPNG(pngBuffer);

		if (!metadata) {
			await interaction.editReply({
				embeds: [
					new EmbedBuilder()
						.setTitle(
							localizer(locale, "commands.preset.import.no_metadata_title"),
						)
						.setDescription(
							localizer(locale, "commands.preset.import.no_metadata_description"),
						)
						.setColor(ColorCode.ERROR),
				],
			});
			return;
		}

		// 10. Validate preset file structure
		const validation = validatePresetFile(metadata);

		if (!validation.valid || !validation.data) {
			await interaction.editReply({
				embeds: [
					new EmbedBuilder()
						.setTitle(
							localizer(locale, "commands.preset.import.invalid_file_title"),
						)
						.setDescription(
							validation.error
								? localizeError(locale, validation.error)
								: localizer(
										locale,
										"commands.preset.import.invalid_file_description",
								  ),
						)
						.setColor(ColorCode.ERROR),
				],
			});
			return;
		}

		// 11. Import preset data
		const importResult = await importPresetData(
			interaction.guild.id,
			validation.data as PresetExportData,
		);

		if (!importResult.success) {
			await interaction.editReply({
				embeds: [
					new EmbedBuilder()
						.setTitle(localizer(locale, "commands.preset.import.failed_title"))
						.setDescription(
							importResult.error
								? localizeError(locale, importResult.error)
								: localizer(locale, "commands.preset.import.failed_description"),
						)
						.setColor(ColorCode.ERROR),
				],
			});
			return;
		}

		// 12. Try to set TomoriBot's server-specific avatar (non-fatal if fails)
		try {
			// Convert PNG buffer to base64 data URI
			const base64 = pngBuffer.toString("base64");
			const avatarDataUri = `data:image/png;base64,${base64}`;

			// Use Discord API to set bot's guild avatar
			const endpoint = `https://discord.com/api/v10/guilds/${interaction.guild.id}/members/@me`;
			const response = await fetch(endpoint, {
				method: "PATCH",
				headers: {
					Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					avatar: avatarDataUri,
				}),
			});

			if (response.ok) {
				log.success(
					`Successfully updated TomoriBot's server avatar for ${interaction.guild.id} during preset import`,
				);
			} else {
				const errorText = await response.text();
				log.warn(
					`Failed to update bot's server avatar (non-fatal): ${response.status} ${response.statusText} - ${errorText}`,
				);
			}
		} catch (avatarError) {
			// Non-fatal error - personality was imported successfully
			log.warn(
				`Failed to update bot's server avatar during preset import (non-fatal): ${avatarError instanceof Error ? avatarError.message : "Unknown error"}`,
			);
		}

		// 13. Send success message with import summary
		const itemsImported = importResult.itemsImported;

		if (!itemsImported) {
			log.error("Import result missing itemsImported data");
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
			return;
		}

		await interaction.editReply({
			embeds: [
				new EmbedBuilder()
					.setTitle(localizer(locale, "commands.preset.import.success_title"))
					.setDescription(
						localizer(locale, "commands.preset.import.success_description", {
							nickname: itemsImported.nickname,
							attribute_count: itemsImported.attributeCount,
							dialogue_count: itemsImported.dialogueCount,
							trigger_word_count: itemsImported.triggerWordCount,
						}),
					)
					.setColor(ColorCode.SUCCESS),
			],
		});

		log.success(
			`Successfully imported preset for guild ${interaction.guild.id}: ${itemsImported.nickname}`,
		);
	} catch (error) {
		log.error("Error executing preset import command:", error, {
			errorType: "CommandExecutionError",
			metadata: { commandName: "preset import" },
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
