import type { SlashCommandSubcommandBuilder, EmbedField } from "discord.js";
import {
	type ChatInputCommandInteraction,
	type Client,
	TextChannel,
} from "discord.js";
import {
	replyInfoEmbed,
	replySummaryEmbed,
} from "../../utils/discord/interactionHelper";
import { ColorCode, log } from "../../utils/misc/logger";
import { localizer } from "../../utils/text/localizer";
import { loadTomoriState, getUserReminderCount } from "../../utils/db/dbRead";
import type { UserRow } from "../../types/db/schema";
import { formatBoolean } from "@/utils/text/stringHelper";
import { getMemoryLimits } from "@/utils/db/memoryLimits";

// Constants
const MAX_ITEMS_DISPLAY = 5; // Max number of items to list directly (e.g., trigger words, channels)
const MAX_MEMORIES_DISPLAY = 10; // Max number of memories to display
const MEMORY_TRUNCATE_LENGTH = 100; // Max length for memory snippets

/**
 * Formats an array of memories for display in an embed field.
 * Truncates long memories and limits display to MAX_MEMORIES_DISPLAY items.
 * @param memories - Array of memory strings to format
 * @param locale - User's locale for localization
 * @returns Formatted string for display, or "None" if empty
 */
function formatMemoriesForDisplay(memories: string[], locale: string): string {
	// 1. Handle empty memories
	if (memories.length === 0) {
		return localizer(locale, "commands.tool.status.none");
	}

	// 2. Limit to first MAX_MEMORIES_DISPLAY memories
	const memoriesToShow = memories.slice(0, MAX_MEMORIES_DISPLAY);
	const omittedCount = memories.length - MAX_MEMORIES_DISPLAY;

	// 3. Format each memory with truncation
	const formattedMemories = memoriesToShow.map((memory, index) => {
		// Truncate if longer than MEMORY_TRUNCATE_LENGTH
		const truncated =
			memory.length > MEMORY_TRUNCATE_LENGTH
				? `${memory.substring(0, MEMORY_TRUNCATE_LENGTH)}...`
				: memory;
		return `${index + 1}. ${truncated}`;
	});

	// 4. Add message if there are more than MAX_MEMORIES_DISPLAY
	if (omittedCount > 0) {
		formattedMemories.push(
			`\n*${localizer(locale, "commands.tool.status.memories_omitted", { count: omittedCount })}*`,
		);
	}

	return formattedMemories.join("\n");
}

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
				.setRequired(true)
				.addChoices(
					{
						name: localizer(
							"en-US",
							"commands.tool.status.type_choice_personal",
						),
						value: "personal",
					},
					{
						name: localizer("en-US", "commands.tool.status.type_choice_server"),
						value: "server",
					},
				),
		);

/**
 * Executes the 'status' command.
 * Displays either personal user status or server/bot status based on user choice.
 * @param client - The Discord client instance.
 * @param interaction - The chat input command interaction.
 * @param userData - The user data for displaying personal status.
 * @param locale - The user's preferred locale.
 */
export async function execute(
	client: Client,
	interaction: ChatInputCommandInteraction,
	userData: UserRow,
	locale: string,
): Promise<void> {
	// Handle both guild and DM contexts - use user ID as server ID for DMs - let helper functions manage interaction state
	const serverDiscId = interaction.guildId ?? interaction.user.id;
	const statusType = interaction.options.getString("type", true); // Required option

	// 1. Get memory limits for slot usage display
	const limits = getMemoryLimits();

	// 2. Prepare fields based on the requested status type
	const fields: EmbedField[] = [];
	let titleKey: string;
	let descriptionKey: string;
	let footerKey: string | undefined;

	try {
		switch (statusType) {
			case "personal": {
				// 1. Display personal/user status
				titleKey = "commands.tool.status.personal_title";
				descriptionKey = "commands.tool.status.personal_description";

				// 2. Format personal memories
				const personalMemoriesValue = formatMemoriesForDisplay(
					userData.personal_memories,
					locale,
				);

				// 3. Format personal memories count with slot usage
				const personalMemoriesCount = userData.personal_memories.length;
				const personalMemoriesFieldName = localizer(
					locale,
					"commands.tool.status.field_personal_memories_with_count",
					{
						current: personalMemoriesCount,
						max: limits.maxPersonalMemories,
					},
				);

				// 4. Get reminder count for the user
				const reminderCount = await getUserReminderCount(interaction.user.id);

				// 5. Add user-specific fields
				fields.push(
					{
						name: localizer(locale, "commands.tool.status.field_user_nickname"),
						value: userData.user_nickname,
						inline: true,
					},
					{
						name: localizer(locale, "commands.tool.status.field_language_pref"),
						value: userData.language_pref,
						inline: true,
					},
					{
						name: localizer(
							locale,
							"commands.tool.status.field_reminders_count",
						),
						value: String(reminderCount),
						inline: true,
					},
					{
						name: personalMemoriesFieldName,
						value: personalMemoriesValue,
						inline: false,
					},
				);

				// 6. Set footer for export command
				footerKey = "commands.tool.status.export_footer";
				break;
			}
			case "server": {
				// 1. Load Tomori State for server information
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

				titleKey = "commands.tool.status.server_title";
				descriptionKey = "commands.tool.status.server_description";
				const config = tomoriState.config;
				const llm = tomoriState.llm;

				// 3. Format Auto-Chat Channels
				const autoChannelMentions = await Promise.all(
					config.autoch_disc_ids.map(async (id) => {
						try {
							const channel = await client.channels.fetch(id);
							return channel instanceof TextChannel ? channel.toString() : id;
						} catch {
							return `*<${localizer(locale, "commands.tool.status.unknown_channel")} ${id}>*`;
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

				// 4. Format Trigger Words with slot usage - always show all trigger words
				const triggerWordsCount = config.trigger_words.length;
				const triggerWordsValue =
					triggerWordsCount > 0
						? config.trigger_words.map((w) => `\`${w}\``).join(", ")
						: localizer(locale, "commands.tool.status.none");
				const triggerWordsFieldName = localizer(
					locale,
					"commands.tool.status.field_trigger_words_with_count",
					{
						current: triggerWordsCount,
						max: limits.maxTriggerWords,
					},
				);

				// 5. Format Attributes with slot usage
				const attributesCount = tomoriState.attribute_list.length;
				const attributesValue =
					attributesCount > 0
						? attributesCount <= MAX_ITEMS_DISPLAY
							? tomoriState.attribute_list.map((a) => `• ${a}`).join("\n")
							: localizer(locale, "commands.tool.status.item_count", {
									count: attributesCount,
								})
						: localizer(locale, "commands.tool.status.none");
				const attributesFieldName = localizer(
					locale,
					"commands.tool.status.field_attributes_with_count",
					{
						current: attributesCount,
						max: limits.maxAttributes,
					},
				);

				// 6. Format Server Memories with slot usage
				const serverMemoriesCount = tomoriState.server_memories.length;
				const serverMemoriesValue = formatMemoriesForDisplay(
					tomoriState.server_memories,
					locale,
				);
				const serverMemoriesFieldName = localizer(
					locale,
					"commands.tool.status.field_server_memories_with_count",
					{
						current: serverMemoriesCount,
						max: limits.maxServerMemories,
					},
				);

				// 7. Format Sample Dialogues count with slot usage
				const dialogueCount = tomoriState.sample_dialogues_in.length;
				const dialogueFieldName = localizer(
					locale,
					"commands.tool.status.field_dialogue_count_with_count",
					{
						current: dialogueCount,
						max: limits.maxSampleDialogues,
					},
				);

				// 7. Add all server-related fields (config + personality + memories)
				fields.push(
					// Configuration Section
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
						inline: false,
					},
					{
						name: triggerWordsFieldName,
						value: triggerWordsValue,
						inline: false,
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
						value: formatBoolean(!!config.api_key),
						inline: true,
					},
					{
						name: localizer(locale, "commands.tool.status.field_emoji_usage"),
						value: formatBoolean(config.emoji_usage_enabled),
						inline: true,
					},
					{
						name: localizer(locale, "commands.tool.status.field_sticker_usage"),
						value: formatBoolean(config.sticker_usage_enabled),
						inline: true,
					},
					{
						name: localizer(locale, "commands.tool.status.field_web_search"),
						value: formatBoolean(config.web_search_enabled),
						inline: true,
					},
					{
						name: localizer(
							locale,
							"commands.tool.status.field_server_memteaching",
						),
						value: formatBoolean(config.server_memteaching_enabled),
						inline: true,
					},
					{
						name: localizer(
							locale,
							"commands.tool.status.field_attribute_memteaching",
						),
						value: formatBoolean(config.attribute_memteaching_enabled),
						inline: true,
					},
					{
						name: localizer(
							locale,
							"commands.tool.status.field_sampledialogue_memteaching",
						),
						value: formatBoolean(config.sampledialogue_memteaching_enabled),
						inline: true,
					},
					// Personality Section
					{
						name: localizer(locale, "commands.tool.status.field_nickname"),
						value: tomoriState.tomori_nickname,
						inline: true,
					},
					{
						name: dialogueFieldName,
						value: String(dialogueCount),
						inline: true,
					},
					{
						name: attributesFieldName,
						value: attributesValue,
						inline: false,
					},
					// Server Memories Section
					{
						name: serverMemoriesFieldName,
						value: serverMemoriesValue,
						inline: false,
					},
				);

				// 8. Set footer for export command
				footerKey = "commands.tool.status.export_footer_full";
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
			footerKey: footerKey,
		});
	} catch (error) {
		log.error(`Error executing status command for type ${statusType}:`, error, {
			serverId: serverDiscId,
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
