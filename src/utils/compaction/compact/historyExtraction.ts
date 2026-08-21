import type { Embed, TextBasedChannel } from "discord.js";
import { PrivacyLevel } from "@/types/db/schema";
import { getCachedPrivacyLevel } from "@/utils/cache/userCache";
import { extractNoticeTextFromComponents } from "@/utils/discord/componentNoticeReader";
import { MAX_MESSAGE_FETCH_LIMIT } from "@/utils/discord/messageFetchLimit";
import { localizer, getSupportedLocales } from "@/utils/text/localizer";
import { escapeRegExp } from "@/utils/text/processors/regexUtils";
import type { ConversationContext, ImageReference } from "./types";

export async function buildConversationContext(
  channel: TextBasedChannel,
  includeImages: boolean,
): Promise<ConversationContext> {
  const fetchedMessages = await channel.messages.fetch({ limit: MAX_MESSAGE_FETCH_LIMIT });
  const messagesArray = Array.from(fetchedMessages.values()).reverse();
  const resetIndex = findLastResetIndex(messagesArray);
  const relevantMessages = messagesArray.slice(resetIndex === -1 ? 0 : resetIndex + 1);
  const conversationLines: string[] = [];
  const imageReferences: ImageReference[] = [];
  const userIdSet = new Set<string>();
  let imageCounter = 1;

  for (const msg of relevantMessages) {
    const authorPrivacyLevel = await getCachedPrivacyLevel(msg.author.id);
    if (authorPrivacyLevel === PrivacyLevel.FULL) continue;

    userIdSet.add(msg.author.id);
    const authorName = msg.member?.displayName || msg.author.username;
    let messageContent = msg.content?.trim() || "";

    for (const embed of msg.embeds) {
      messageContent = appendEmbedContent(messageContent, { title: embed.title, description: embed.description });
    }

    // Components V2 notices (memory-learning, scheduled-task) carry no embeds,
    // so their text has to be reconstructed from the component tree or they are
    // silently dropped from the compaction summary.
    const notice = extractNoticeTextFromComponents(msg.components);
    if (notice) {
      messageContent = appendEmbedContent(messageContent, notice);
    }

    const messageImages: ImageReference[] = [];
    if (includeImages) {
      for (const attachment of msg.attachments.values()) {
        if (!attachment.contentType?.startsWith("image/")) continue;
        messageImages.push({
          label: `Image ${imageCounter++}`,
          url: attachment.url,
          mimeType: attachment.contentType ?? undefined,
          source: `${authorName} attachment${attachment.name ? ` (${attachment.name})` : ""}`,
        });
      }

      for (const emoji of extractCustomEmojiImages(msg.content || "")) {
        messageImages.push({
          label: `Image ${imageCounter++}`,
          url: emoji.url,
          mimeType: "image/png",
          source: `${authorName} emoji (${emoji.name})`,
        });
      }

      for (const sticker of msg.stickers.values()) {
        messageImages.push({
          label: `Image ${imageCounter++}`,
          url: `https://cdn.discordapp.com/stickers/${sticker.id}.png`,
          mimeType: "image/png",
          source: `${authorName} sticker (${sticker.name})`,
        });
      }
    }

    const labels = messageImages.map((img) => img.label).join(", ");
    const line =
      messageImages.length > 0 ? `${messageContent || "(no text)"} [${labels}]` : messageContent || "(no text)";
    imageReferences.push(...messageImages);
    conversationLines.push(`${authorName}: ${line}`);
  }

  return {
    conversationText: conversationLines.join("\n"),
    imageReferences,
    userIds: Array.from(userIdSet),
  };
}

function findLastResetIndex(messagesArray: Array<{ embeds: Embed[] }>): number {
  for (let index = messagesArray.length - 1; index >= 0; index--) {
    if (messagesArray[index].embeds.some((embed) => classifyEmbedTitle(embed.title ?? null).isReset)) {
      return index;
    }
  }
  return -1;
}

function extractCustomEmojiImages(content: string): Array<{ url: string; name: string }> {
  const results: Array<{ url: string; name: string }> = [];
  const emojiPattern = /<(a?):([^:]+):(\d{17,20})>/g;
  const seenEmojiIds = new Set<string>();
  let match = emojiPattern.exec(content);
  while (match !== null) {
    const emojiName = match[2];
    const emojiId = match[3];
    if (!seenEmojiIds.has(emojiId)) {
      seenEmojiIds.add(emojiId);
      results.push({
        url: `https://cdn.discordapp.com/emojis/${emojiId}.png`,
        name: emojiName,
      });
    }
    match = emojiPattern.exec(content);
  }

  return results;
}

/**
 * Appends a classified system notice to the conversation line being built.
 *
 * Accepts a transport-agnostic {title, description} pair so real embeds and
 * Components V2 notices reconstructed by `extractNoticeTextFromComponents`
 * produce identical compaction input.
 *
 * @param baseContent - The message text accumulated so far.
 * @returns `baseContent` with the notice appended, or unchanged when the notice
 *          is not one of the classified system types.
 */
function appendEmbedContent(baseContent: string, source: { title: string | null; description: string | null }): string {
  if (!source.description || !source.title) return baseContent;

  const classification = classifyEmbedTitle(source.title);
  if (!classification.isSystemInjection && !classification.isMemoryLearning && !classification.isReminderSet) {
    return baseContent;
  }

  const description = source.description.trim();
  if (!description) return baseContent;

  const systemContent = classification.isMemoryLearning
    ? `[System: ${source.title}\n${description}]`
    : classification.isSystemInjection
      ? `[System: ${description}]`
      : `[The following is a system-produced embed]\n${source.title}\n${description}`;
  return baseContent ? `${baseContent}\n${systemContent}` : systemContent;
}

function classifyEmbedTitle(embedTitle: string | null): {
  isReset: boolean;
  isSystemInjection: boolean;
  isMemoryLearning: boolean;
  isReminderSet: boolean;
} {
  if (!embedTitle) {
    return { isReset: false, isSystemInjection: false, isMemoryLearning: false, isReminderSet: false };
  }

  for (const supportedLocale of getSupportedLocales()) {
    const memoryLearningTitles = [
      localizer(supportedLocale, "genai.self_teach.server_memory_learned_title"),
      localizer(supportedLocale, "genai.self_teach.personal_memory_learned_title"),
      localizer(supportedLocale, "genai.self_teach.server_memory_updated_title"),
      localizer(supportedLocale, "genai.self_teach.personal_memory_updated_title"),
      localizer(supportedLocale, "genai.self_teach.server_memory_deleted_title"),
      localizer(supportedLocale, "genai.self_teach.personal_memory_deleted_title"),
    ];
    const reminderSetTitles = [
      localizer(supportedLocale, "reminders.reminder_set_title"),
      localizer(supportedLocale, "reminders.recurring_task_set_title"),
      localizer(supportedLocale, "reminders.task_set_title"),
    ];
    const compactCharacterTitlePrefix = localizer(supportedLocale, "commands.compact.roleplay_character_title_prefix");
    const isMemoryLearning = memoryLearningTitles.some((title) => matchesLocalizedTitleTemplate(title, embedTitle));
    const isReminderSet = reminderSetTitles.some((title) => matchesLocalizedTitleTemplate(title, embedTitle));
    const isReset =
      embedTitle === localizer(supportedLocale, "commands.refresh.title") ||
      embedTitle === localizer(supportedLocale, "commands.compact.summary_title_refreshed") ||
      embedTitle === localizer(supportedLocale, "commands.compact.roleplay_scene_title_refreshed") ||
      embedTitle === localizer(supportedLocale, "commands.compact.manual_entry_title_refreshed");
    const isSystemInjection =
      embedTitle === localizer(supportedLocale, "commands.bot.impersonate.system_title") ||
      embedTitle === localizer(supportedLocale, "commands.compact.summary_title") ||
      embedTitle === localizer(supportedLocale, "commands.compact.summary_title_refreshed") ||
      embedTitle === localizer(supportedLocale, "commands.compact.roleplay_scene_title") ||
      embedTitle === localizer(supportedLocale, "commands.compact.roleplay_scene_title_refreshed") ||
      embedTitle === localizer(supportedLocale, "commands.compact.manual_entry_title") ||
      embedTitle === localizer(supportedLocale, "commands.compact.manual_entry_title_refreshed") ||
      Boolean(compactCharacterTitlePrefix && embedTitle.startsWith(compactCharacterTitlePrefix));

    if (isMemoryLearning || isReminderSet || isReset || isSystemInjection) {
      return { isReset, isSystemInjection, isMemoryLearning, isReminderSet };
    }
  }

  return { isReset: false, isSystemInjection: false, isMemoryLearning: false, isReminderSet: false };
}

function matchesLocalizedTitleTemplate(template: string, actualTitle: string): boolean {
  if (!template.includes("{")) return actualTitle === template;
  const pattern = new RegExp(`^${escapeRegExp(template).replace(/\\\{[^}]+\\\}/g, ".+?")}$`);
  return pattern.test(actualTitle);
}
