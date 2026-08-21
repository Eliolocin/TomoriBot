import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder } from "discord.js";
import { ColorCode } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";
import type {} from "./types";

export function buildConversationEmbed(
  locale: string,
  summaryText: string,
  refresh: boolean,
  editDeadline?: string,
): EmbedBuilder {
  const title = refresh
    ? localizer(locale, "commands.compact.summary_title_refreshed")
    : localizer(locale, "commands.compact.summary_title");

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(truncateEmbedDescription(summaryText))
    .setColor(ColorCode.SECTION);

  const footerText = buildFooterText(locale, refresh, editDeadline);
  if (footerText) embed.setFooter({ text: footerText });

  return embed;
}

export function buildRoleplayEmbeds(
  locale: string,
  summaryText: string,
  refresh: boolean,
  editDeadline?: string,
): EmbedBuilder[] {
  const title = refresh
    ? localizer(locale, "commands.compact.roleplay_scene_title_refreshed")
    : localizer(locale, "commands.compact.roleplay_scene_title");

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(truncateEmbedDescription(summaryText))
    .setColor(ColorCode.SECTION);

  const footerText = buildFooterText(locale, refresh, editDeadline);
  if (footerText) embed.setFooter({ text: footerText });

  return [embed];
}

function buildFooterText(locale: string, refresh: boolean, editDeadline?: string): string {
  const parts: string[] = [];
  if (refresh) parts.push(localizer(locale, "commands.compact.refresh_footer"));
  if (editDeadline) parts.push(localizer(locale, "commands.compact.edit_footer", { deadline: editDeadline }));
  return parts.join(" · ");
}

export function isDiscordThreadChannel(channel: unknown): boolean {
  if (!channel || typeof channel !== "object") return false;
  if ("isThread" in channel && typeof channel.isThread === "function") return channel.isThread();
  if (!("type" in channel)) return false;
  const channelType = Number((channel as { type: number }).type);
  return (
    channelType === ChannelType.PublicThread ||
    channelType === ChannelType.PrivateThread ||
    channelType === ChannelType.AnnouncementThread
  );
}

export function buildManualEmbed(
  locale: string,
  summaryText: string,
  refresh: boolean,
  editDeadline?: string,
): EmbedBuilder {
  const title = refresh
    ? localizer(locale, "commands.compact.manual_entry_title_refreshed")
    : localizer(locale, "commands.compact.manual_entry_title");

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(truncateEmbedDescription(summaryText))
    .setColor(ColorCode.SECTION);

  const footerText = buildFooterText(locale, refresh, editDeadline);
  if (footerText) embed.setFooter({ text: footerText });

  return embed;
}

export const COMPACT_EDIT_BUTTON_ID = "compact_edit_summary";
export const COMPACT_ADD_TO_DOCS_BUTTON_ID = "compact_add_to_docs";

export function buildEditSummaryButtonRow(locale: string): ActionRowBuilder<ButtonBuilder> {
  const button = new ButtonBuilder()
    .setCustomId(COMPACT_EDIT_BUTTON_ID)
    .setLabel(localizer(locale, "commands.compact.edit_button_label"))
    .setStyle(ButtonStyle.Secondary);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
}

export function buildAddToDocsButtonRow(locale: string): ActionRowBuilder<ButtonBuilder> {
  const button = new ButtonBuilder()
    .setCustomId(COMPACT_ADD_TO_DOCS_BUTTON_ID)
    .setLabel(localizer(locale, "commands.compact.add_to_docs_button_label"))
    .setStyle(ButtonStyle.Secondary);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
}

function truncateEmbedDescription(text: string, maxLength = 4000): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}
