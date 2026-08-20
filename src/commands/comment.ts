import type { Client, ChatInputCommandInteraction } from "discord.js";
import { MessageFlags, type SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { localizer } from "@/utils/text/localizer";
import { ColorCode } from "@/utils/misc/logger";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { isGuildMessageCommandChannel } from "@/utils/discord/guildMessageChannel";
import type { UserRow } from "@/types/db/schema";

/**
 * Configures the /comment command
 */
export const configureCommand = (command: SlashCommandBuilder) => {
  return command
    .setName("comment")
    .setDescription(localizer("en-US", "commands.comment.description"))
    .addStringOption((option) =>
      option
        .setName("content")
        .setDescription(localizer("en-US", "commands.comment.content_description"))
        .setRequired(true)
        .setMaxLength(4000),
    );
};

/**
 * Executes the /comment command
 * Sends an embed with user input text and a footer showing who created the comment
 */
export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  _userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.guild || !interaction.channel) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.guild_only_title",
      descriptionKey: "general.errors.guild_only_description",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!isGuildMessageCommandChannel(interaction.channel)) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.comment.invalid_channel_title",
      descriptionKey: "commands.comment.invalid_channel_description",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = interaction.channel;

  // Defer reply ephemerally while processing
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const commentContent = interaction.options.getString("content", true);

  const embed = new EmbedBuilder().setDescription(commentContent).setColor(ColorCode.INFO);

  const memberAvatarUrl = interaction.member
    ? (interaction.member as import("discord.js").GuildMember).displayAvatarURL({
        size: 64,
        extension: "png",
        forceStatic: true,
      })
    : interaction.user.displayAvatarURL({
        size: 64,
        extension: "png",
        forceStatic: true,
      });

  embed.setFooter({
    text: localizer(locale, "commands.comment.footer", {
      user: interaction.user.username,
    }),
    iconURL: memberAvatarUrl,
  });

  await channel.send({
    embeds: [embed],
  });

  await replyInfoEmbed(interaction, locale, {
    titleKey: "commands.comment.success_title",
    descriptionKey: "commands.comment.success_description",
    color: ColorCode.SUCCESS,
  });
}
