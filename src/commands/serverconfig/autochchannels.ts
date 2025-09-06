import {
	ChannelType,
	type ChatInputCommandInteraction,
	type Client,
	type SlashCommandSubcommandBuilder,
} from "discord.js";
import { sql } from "bun";
import { loadTomoriState } from "../../utils/db/dbRead";
import { tomoriConfigSchema } from "../../types/db/schema";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import { replyInfoEmbed } from "../../utils/discord/interactionHelper";
import type { UserRow, ErrorContext } from "../../types/db/schema";

// Configure the subcommand (no changes needed here)
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("autochchannels")
		.setDescription(
			localizer("en-US", "commands.config.autochchannels.description"),
		)
		.addChannelOption((option) =>
			option
				.setName("channel")
				.setDescription(
					localizer(
						"en-US",
						"commands.config.autochchannels.channel_description",
					),
				)
				.setDescriptionLocalizations({
					ja: localizer(
						"ja",
						"commands.config.autochchannels.channel_description",
					),
				})
				.addChannelTypes(ChannelType.GuildText)
				.setRequired(true),
		)
		.addStringOption((option) =>
			option
				.setName("action")
				.setDescription(
					localizer(
						"en-US",
						"commands.config.autochchannels.action_description",
					),
				)
				.setDescriptionLocalizations({
					ja: localizer(
						"ja",
						"commands.config.autochchannels.action_description",
					),
				})
				.setRequired(true)
				.addChoices(
					{
						name: localizer("en-US", "commands.config.options.add"),
						value: "add",
					},
					{
						name: localizer("en-US", "commands.config.options.remove"),
						value: "remove",
					},
				),
		);

/**
 * Configures auto-chat channels for Tomori where she will automatically send messages.
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
	// Ensure command is run in a guild
	if (!interaction.guild || !interaction.channel) {
		await replyInfoEmbed(interaction, userData.language_pref, {
			titleKey: "general.errors.guild_only_title",
			descriptionKey: "general.errors.guild_only_description",
			color: ColorCode.ERROR,
		});
		return;
	}

	try {
		// Get command options
		const channel = interaction.options.getChannel("channel", true);
		const action = interaction.options.getString("action", true);

		// Validate channel type (should be a text channel) - let helper functions manage interaction state
		if (channel.type !== ChannelType.GuildText) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.autochchannels.invalid_channel_title",
				descriptionKey:
					"commands.config.autochchannels.invalid_channel_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// Load the Tomori state for this server
		const tomoriState = await loadTomoriState(interaction.guild.id);
		if (!tomoriState) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.tomori_not_setup_title",
				descriptionKey: "general.errors.tomori_not_setup_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// Get the current channels array
		const currentChannels = tomoriState.config.autoch_disc_ids || [];

		// Check if the channel is already in the list (when adding)
		if (action === "add" && currentChannels.includes(channel.id)) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.autochchannels.already_added_title",
				descriptionKey:
					"commands.config.autochchannels.already_added_description",
				descriptionVars: {
					channel_name: channel.name ?? "UNDEFINED_CH",
				},
				color: ColorCode.WARN,
			});
			return;
		}

		// Check if the channel is not in the list (when removing)
		if (action === "remove" && !currentChannels.includes(channel.id)) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.autochchannels.not_in_list_title",
				descriptionKey:
					"commands.config.autochchannels.not_in_list_description",
				descriptionVars: {
					channel_name: channel.name ?? "UNDEFINED_CH",
				},
				color: ColorCode.WARN,
			});
			return;
		}

		// Update the channels array based on the action
		const updatedChannels =
			action === "add"
				? [...currentChannels, channel.id]
				: currentChannels.filter((id) => id !== channel.id);

		// Convert the array to a properly escaped PostgreSQL array literal
		const channelsArrayLiteral = `{${updatedChannels
			.map((id) => `"${id.replace(/(["\\])/g, "\\$1")}"`)
			.join(",")}}`;

		// Update the config in the database with direct SQL
		const [updatedRow] = await sql`
      UPDATE tomori_configs
      SET autoch_disc_ids = ${channelsArrayLiteral}::text[]
      WHERE tomori_id = ${tomoriState.tomori_id}
      RETURNING *
    `;

		if (!updatedRow) {
			const context: ErrorContext = {
				tomoriId: tomoriState.tomori_id,
				errorType: "CommandExecutionError",
				metadata: {
					command: "config autochchannels",
					guildId: interaction.guild.id,
					channelId: channel.id,
					action,
				},
			};
			await log.error(
				"Failed to update autoch_disc_ids config",
				new Error("Database update failed"),
				context,
			);

			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.update_failed_title",
				descriptionKey: "general.errors.update_failed_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// Validate the returned data
		const validatedConfig = tomoriConfigSchema.safeParse(updatedRow);
		if (!validatedConfig.success) {
			const context: ErrorContext = {
				tomoriId: tomoriState.tomori_id,
				errorType: "SchemaValidationError",
				metadata: {
					command: "config autochchannels",
					validationErrors: validatedConfig.error.flatten(),
				},
			};
			await log.error(
				"Failed to validate updated config",
				validatedConfig.error,
				context,
			);

			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.update_failed_title",
				descriptionKey: "general.errors.update_failed_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// Success message based on the action
		await replyInfoEmbed(interaction, locale, {
			titleKey:
				action === "add"
					? "commands.config.autochchannels.added_title"
					: "commands.config.autochchannels.removed_title",
			descriptionKey:
				action === "add"
					? "commands.config.autochchannels.added_description"
					: "commands.config.autochchannels.removed_description",
			descriptionVars: {
				channel_name: channel.name ?? "UNDEFINED_CH",
			},
			color: action === "add" ? ColorCode.SUCCESS : ColorCode.WARN,
		});
	} catch (error) {
		const context: ErrorContext = {
			errorType: "CommandExecutionError",
			metadata: {
				command: "config autochchannels",
				guildId: interaction.guild.id,
			},
		};
		await log.error("Error in /config autochchannels command", error, context);

		await replyInfoEmbed(interaction, locale, {
			titleKey: "general.errors.unknown_error_title",
			descriptionKey: "general.errors.unknown_error_description",
			color: ColorCode.ERROR,
		});
	}
}
