import type { SlashCommandSubcommandBuilder, EmbedField } from "discord.js";
import {
	type ChatInputCommandInteraction,
	type Client,
	MessageFlags,
	TextChannel,
} from "discord.js";
import {
	replyInfoEmbed,
	replySummaryEmbed,
} from "../../utils/discord/interactionHelper";
import { ColorCode, log } from "../../utils/misc/logger";
import { localizer } from "../../utils/text/localizer";
import { loadTomoriState } from "../../utils/db/dbRead";
import type { UserRow } from "../../types/db/schema";
import { formatBoolean } from "@/utils/text/stringHelper";

// Constants
const MAX_ITEMS_DISPLAY = 5; // Max number of items to list directly (e.g., trigger words, channels)

/**
 * Configures the 'status' subcommand with type options.
 */
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("status")
		.setDescription(localizer("en-US", "commands.tool.status.description"))
		.addStringOption((option) =>
			option
				.setName("type")
				.setDescription(
					localizer("en-US", "commands.tool.status.type_description"),
				)
				.setDescriptionLocalizations({
					ja: localizer("ja", "commands.tool.status.type_description"),
				})
				.setRequired(true)
				.addChoices(
					{
						name: localizer("en-US", "commands.tool.status.type_choice_config"),
						name_localizations: {
							ja: localizer("ja", "commands.tool.status.type_choice_config"),
						},
						value: "config",
					},
					{
						name: localizer(
							"en-US",
							"commands.tool.status.type_choice_personality",
						),
						name_localizations: {
							ja: localizer(
								"ja",
								"commands.tool.status.type_choice_personality",
							),
						},
						value: "personality",
					},
				),
		);

/**
 * Executes the 'status' command.
 * Displays either configuration or personality status based on user choice.
 * @param client - The Discord client instance.
 * @param interaction - The chat input command interaction.
 * @param _userData - The user data (unused in this command).
 * @param locale - The user's preferred locale.
 */
export async function execute(
	client: Client,
	interaction: ChatInputCommandInteraction,
	_userData: UserRow,
	locale: string,
): Promise<void> {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	// Handle both guild and DM contexts - use user ID as server ID for DMs
	const serverDiscId = interaction.guildId ?? interaction.user.id;
	const statusType = interaction.options.getString("type", true); // Required option

	// 1. Load Tomori State
	const tomoriState = await loadTomoriState(serverDiscId);

	// 2. Handle case where Tomori is not set up
	if (!tomoriState) {
		await replyInfoEmbed(interaction, locale, {
			titleKey: "general.errors.tomori_not_setup_title",
			descriptionKey: "general.errors.tomori_not_setup_description",
			color: ColorCode.ERROR,
		});
		return;
	}

	// 3. Prepare fields based on the requested status type
	const fields: EmbedField[] = [];
	let titleKey: string;
	let descriptionKey: string;

	try {
		switch (statusType) {
			case "config": {
				titleKey = "commands.tool.status.config_title";
				descriptionKey = "commands.tool.status.config_description";
				const config = tomoriState.config; // Already loaded
				const llm = tomoriState.llm; // Already loaded

				// Format Auto-Chat Channels
				const autoChannelMentions = await Promise.all(
					config.autoch_disc_ids.map(async (id) => {
						try {
							const channel = await client.channels.fetch(id);
							return channel instanceof TextChannel ? channel.toString() : id; // Mention if channel found, else show ID
						} catch {
							return `*<${localizer(locale, "commands.tool.status.unknown_channel")} ${id}>*`; // Indicate unknown channel
						}
					}),
				);
				const autoChannelsValue =
					autoChannelMentions.length > 0
						? autoChannelMentions.length <= MAX_ITEMS_DISPLAY
							? autoChannelMentions.join(", ")
							: localizer(locale, "commands.tool.status.item_count", {
									count: autoChannelMentions.length,
								})
						: localizer(locale, "commands.tool.status.none");

				// Format Trigger Words
				const triggerWordsValue =
					config.trigger_words.length > 0
						? config.trigger_words.length <= MAX_ITEMS_DISPLAY
							? config.trigger_words.map((w) => `\`${w}\``).join(", ")
							: localizer(locale, "commands.tool.status.item_count", {
									count: config.trigger_words.length,
								})
						: localizer(locale, "commands.tool.status.none");

				fields.push(
					{
						name: localizer(locale, "commands.tool.status.field_model"),
						value: `\`${llm.llm_codename}\` (${llm.llm_provider})`,
						inline: true,
					},
					{
						name: localizer(locale, "commands.tool.status.field_temperature"),
						value: String(config.llm_temperature),
						inline: true,
					},
					{
						name: localizer(locale, "commands.tool.status.field_humanizer"),
						value: String(config.humanizer_degree),
						inline: true,
					},
					{
						name: localizer(
							locale,
							"commands.tool.status.field_autoch_threshold",
						),
						value:
							config.autoch_threshold > 0
								? String(config.autoch_threshold)
								: localizer(locale, "commands.tool.status.disabled"),
						inline: true,
					},
					{
						name: localizer(
							locale,
							"commands.tool.status.field_autoch_channels",
						),
						value: autoChannelsValue,
						inline: false, // Full width for potentially long list/count
					},
					{
						name: localizer(locale, "commands.tool.status.field_trigger_words"),
						value: triggerWordsValue,
						inline: false, // Full width
					},
					{
						name: localizer(
							locale,
							"commands.tool.status.field_personalization",
						),
						value: formatBoolean(config.personal_memories_enabled),
						inline: true,
					},
					{
						name: localizer(locale, "commands.tool.status.field_self_teach"),
						value: formatBoolean(config.self_teaching_enabled),
						inline: true,
					},
					{
						name: localizer(locale, "commands.tool.status.field_api_key_set"),
						value: formatBoolean(!!config.api_key), // Check if api_key exists and is not null/empty
						inline: true,
					},
				);
				break;
			}
			case "personality": {
				titleKey = "commands.tool.status.personality_title";
				descriptionKey = "commands.tool.status.personality_description";

				// Format Attributes
				const attributesValue =
					tomoriState.attribute_list.length > 0
						? tomoriState.attribute_list.length <= MAX_ITEMS_DISPLAY
							? tomoriState.attribute_list.map((a) => `• ${a}`).join("\n")
							: localizer(locale, "commands.tool.status.item_count", {
									count: tomoriState.attribute_list.length,
								})
						: localizer(locale, "commands.tool.status.none");

				fields.push(
					{
						name: localizer(locale, "commands.tool.status.field_nickname"),
						value: tomoriState.tomori_nickname,
						inline: true,
					},
					{
						name: localizer(
							locale,
							"commands.tool.status.field_dialogue_count",
						),
						// Assuming dialogue count isn't directly on tomoriState, might need another query or adjustment
						// For now, let's put a placeholder or 0 if not available
						value: localizer(locale, "commands.tool.status.not_available"), // Placeholder
						inline: true,
					},
					{
						name: localizer(
							locale,
							"commands.tool.status.field_server_memory_count",
						),
						value: String(tomoriState.server_memories.length),
						inline: true,
					},
					{
						name: localizer(locale, "commands.tool.status.field_attributes"),
						value: attributesValue,
						inline: false, // Full width for list
					},
				);
				break;
			}
			default:
				// Should not happen due to required choice option
				log.error(`Invalid status type received: ${statusType}`);
				await replyInfoEmbed(interaction, locale, {
					titleKey: "general.errors.unknown_error_title",
					descriptionKey: "general.errors.unknown_error_description",
					color: ColorCode.ERROR,
				});
				return;
		}

		// 4. Send the status embed
		await replySummaryEmbed(interaction, locale, {
			titleKey: titleKey,
			descriptionKey: descriptionKey,
			color: ColorCode.INFO,
			fields: fields,
		});
	} catch (error) {
		log.error(`Error executing status command for type ${statusType}:`, error, {
			serverId: tomoriState?.server_id, // Use internal ID if available
			errorType: "CommandExecutionError",
			metadata: { commandName: "status", type: statusType },
		});
		await replyInfoEmbed(interaction, locale, {
			titleKey: "general.errors.unknown_error_title",
			descriptionKey: "general.errors.unknown_error_description",
			color: ColorCode.ERROR,
		});
	}
}
