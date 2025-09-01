import type { SlashCommandSubcommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction, Client, Message } from "discord.js";
import { MessageFlags } from "discord.js";
import { replyInfoEmbed } from "../../utils/discord/interactionHelper";
import { ColorCode, log } from "../../utils/misc/logger";
import { localizer } from "../../utils/text/localizer";
import type { UserRow } from "../../types/db/schema";
import { loadTomoriState, loadSmartestModel } from "../../utils/db/dbRead";
import tomoriChat from "../../events/messageCreate/tomoriChat";

/**
 * Configure the reason subcommand
 * @param subcommand - The slash command subcommand builder
 * @returns The configured subcommand
 */
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("reason")
		.setDescription(localizer("en-US", "commands.bot.reason.description"))
		.addStringOption((option) =>
			option
				.setName("query")
				.setDescription(
					localizer("en-US", "commands.bot.reason.query_description"),
				)
				.setRequired(false),
		);

/**
 * Execute the reason command - use Tomori's smartest reasoning model to respond
 * @param client - Discord client instance
 * @param interaction - Command interaction
 * @param _userData - User data from database (not used)
 * @param locale - Locale of the interaction
 */
export async function execute(
	client: Client,
	interaction: ChatInputCommandInteraction,
	_userData: UserRow,
	locale: string,
): Promise<void> {
	// 1. Defer reply with ephemeral flag
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	// 2. Ensure command is run in a guild text channel
	if (!interaction.channel || !("messages" in interaction.channel)) {
		await replyInfoEmbed(interaction, locale, {
			titleKey: "general.errors.channel_only_title",
			descriptionKey: "general.errors.channel_only_description",
			color: ColorCode.ERROR,
		});
		return;
	}

	try {
		// 3. Load Tomori state to get current provider
		const tomoriState = await loadTomoriState(
			interaction.guild?.id ?? interaction.user.id,
		);
		if (!tomoriState) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.tomori_not_setup_title",
				descriptionKey: "general.errors.tomori_not_setup_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 4. Get the smartest model for current provider
		const currentProvider = tomoriState.llm.llm_provider;
		const smartestModel = await loadSmartestModel(currentProvider);

		if (!smartestModel) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.bot.reason.no_smart_model_title",
				descriptionKey: "commands.bot.reason.no_smart_model_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 5. Get optional query parameter
		const query = interaction.options.getString("query", false);

		// 6. Send immediate ephemeral response to user
		const queryText = query ? ` to your query: "${query}"` : "";
		await replyInfoEmbed(interaction, locale, {
			titleKey: "commands.bot.reason.success_title",
			descriptionKey: "commands.bot.reason.success_description",
			descriptionVars: { query: queryText },
			color: ColorCode.SUCCESS,
		});

		// 7. Get the latest message in the channel
		const messages = await interaction.channel.messages.fetch({ limit: 1 });
		const latestMessage = messages.first();

		if (!latestMessage) {
			log.warn(
				`No messages found in channel ${interaction.channel.id} for manual reason command.`,
			);
			return;
		}

		// 8. Create a "passport" message that will trigger tomoriChat
		// If query is provided, we need to modify the message content to include it
		const passportMessage = latestMessage;

		if (query) {
			// Create a temporary modified message that includes the query and trigger words
			// This ensures tomoriChat will process it while providing the reasoning query context
			const modifiedContent = `tomori ${query}`;

			// Create a copy of the message with modified content
			// We'll use Object.defineProperty to temporarily override the content property
			const originalContent = passportMessage.content;
			Object.defineProperty(passportMessage, "content", {
				value: modifiedContent,
				configurable: true,
			});

			log.info(
				`Modified passport message content from "${originalContent}" to "${modifiedContent}" for reasoning command`,
			);
		}

		// 9. Manually trigger tomoriChat with reasoning flags
		log.info(
			`Manual reason command triggered by ${interaction.user.id} in channel ${interaction.channel.id} for message ${latestMessage.id} using model ${smartestModel.llm_codename}`,
		);

		await tomoriChat(
			client,
			passportMessage as Message,
			false, // isFromQueue
			true, // isManuallyTriggered - bypasses normal trigger logic
			true, // forceReason - enables reasoning mode
			smartestModel.llm_codename, // llmOverrideCodename - use smartest model
		);
	} catch (error) {
		log.error("Error in bot reason command:", error, {
			errorType: "BotReasonCommandError",
			metadata: {
				userId: interaction.user.id,
				guildId: interaction.guild?.id,
				channelId: interaction.channel?.id,
			},
		});

		// Try to send error feedback if possible
		try {
			await interaction.followUp({
				content: localizer(locale, "general.errors.unknown_error_description"),
				flags: MessageFlags.Ephemeral,
			});
		} catch (followUpError) {
			log.error(
				"Failed to send error followup for bot reason command:",
				followUpError,
			);
		}
	}
}
