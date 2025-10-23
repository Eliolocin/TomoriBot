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
	validateImportFile,
	importPersonalData,
	importServerData,
} from "../../utils/db/dataImport";
import type {
	PersonalExportData,
	ServerExportData,
} from "../../types/db/dataExport";

// Maximum file size for imports (1MB)
const MAX_FILE_SIZE = 1024 * 1024;

/**
 * Configure the 'import' subcommand
 */
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("import")
		.setDescription(localizer("en-US", "commands.data.import.description"))
		.addAttachmentOption((option) =>
			option
				.setName("file")
				.setDescription(
					localizer("en-US", "commands.data.import.file_description"),
				)
				.setRequired(true),
		)
		.addStringOption((option) =>
			option
				.setName("confirmation")
				.setDescription(
					localizer("en-US", "commands.data.import.confirmation_description"),
				)
				.setRequired(true)
				.addChoices(
					{
						name: localizer(
							"en-US",
							"commands.data.import.confirmation_choice_yes",
						),
						value: "yes",
					},
					{
						name: localizer(
							"en-US",
							"commands.data.import.confirmation_choice_no",
						),
						value: "no",
					},
				),
		);

/**
 * Executes the 'import' command
 * Imports user or server data from an uploaded JSON file
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
				titleKey: "commands.data.import.cancelled_title",
				descriptionKey: "commands.data.import.cancelled_description",
				color: ColorCode.INFO,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 2. Get uploaded file attachment
		const attachment = interaction.options.getAttachment("file", true);

		// 3. Validate file type and size
		if (!attachment.name.endsWith(".json")) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.data.import.invalid_file_type_title",
				descriptionKey: "commands.data.import.invalid_file_type_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		if (attachment.size > MAX_FILE_SIZE) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.data.import.file_too_large_title",
				descriptionKey: "commands.data.import.file_too_large_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 4. Defer reply while we process
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		// 5. Download and parse the JSON file
		let jsonData: unknown;
		try {
			const response = await fetch(attachment.url);
			const textContent = await response.text();
			jsonData = JSON.parse(textContent);
		} catch (parseError) {
			log.error("Failed to parse import file:", parseError as Error);
			await interaction.editReply({
				embeds: [
					new EmbedBuilder()
						.setTitle(localizer(locale, "commands.data.import.parse_failed_title"))
						.setDescription(
							localizer(locale, "commands.data.import.parse_failed_description"),
						)
						.setColor(ColorCode.ERROR),
				],
			});
			return;
		}

		// 6. Validate import file structure
		const validation = validateImportFile(jsonData);

		if (!validation.valid || !validation.type || !validation.data) {
			await interaction.editReply({
				embeds: [
					new EmbedBuilder()
						.setTitle(localizer(locale, "commands.data.import.invalid_file_title"))
						.setDescription(
							validation.error ||
								localizer(locale, "commands.data.import.invalid_file_description"),
						)
						.setColor(ColorCode.ERROR),
				],
			});
			return;
		}

		// 7. Check permissions for server imports
		if (validation.type === "server") {
			const hasPermission =
				interaction.memberPermissions?.has("ManageGuild") ?? false;

			if (!hasPermission) {
				await interaction.editReply({
					embeds: [
						new EmbedBuilder()
							.setTitle(
								localizer(locale, "commands.data.import.no_permission_title"),
							)
							.setDescription(
								localizer(locale, "commands.data.import.no_permission_description"),
							)
							.setColor(ColorCode.ERROR),
					],
				});
				return;
			}

			// Server imports require a guild context
			if (!interaction.guild) {
				await interaction.editReply({
					embeds: [
						new EmbedBuilder()
							.setTitle(localizer(locale, "general.errors.guild_only_title"))
							.setDescription(
								localizer(locale, "general.errors.guild_only_description"),
							)
							.setColor(ColorCode.ERROR),
					],
				});
				return;
			}
		}

		// 8. Import data based on type
		let importResult: Awaited<ReturnType<typeof importPersonalData>> | Awaited<ReturnType<typeof importServerData>>;

		if (validation.type === "personal") {
			importResult = await importPersonalData(
				interaction.user.id,
				validation.data as PersonalExportData,
			);
		} else if (validation.type === "server" && interaction.guild) {
			importResult = await importServerData(
				interaction.guild.id,
				validation.data as ServerExportData,
			);
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

		// 9. Handle import result
		if (!importResult.success) {
			await interaction.editReply({
				embeds: [
					new EmbedBuilder()
						.setTitle(localizer(locale, "commands.data.import.failed_title"))
						.setDescription(
							importResult.error ||
								localizer(locale, "commands.data.import.failed_description"),
						)
						.setColor(ColorCode.ERROR),
				],
			});
			return;
		}

		// 10. Send success message with import summary
		const memoriesCount = importResult.itemsImported?.memoriesCount || 0;
		const configFieldsCount = importResult.itemsImported?.configFieldsCount || 0;

		await interaction.editReply({
			embeds: [
				new EmbedBuilder()
					.setTitle(localizer(locale, "commands.data.import.success_title"))
					.setDescription(
						localizer(locale, "commands.data.import.success_description", {
							type: validation.type,
							memories_count: memoriesCount,
							config_count: configFieldsCount,
						}),
					)
					.setColor(ColorCode.SUCCESS),
			],
		});
	} catch (error) {
		log.error("Error executing import command:", error, {
			errorType: "CommandExecutionError",
			metadata: { commandName: "import" },
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
