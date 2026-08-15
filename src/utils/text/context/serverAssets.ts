import type { Client } from "discord.js";
import { ContextItemTag, type StructuredContextItem } from "@/types/misc/context";
import type { ServerEmojiRow, ServerStickerRow, AssembledServerConfig, TomoriState } from "@/types/db/schema";
import type { ToolPromptMacroResolver } from "@/utils/tools/toolPromptMacros";
import type { MentionConverter } from "./templates";
import { serverRepository } from "@/utils/db/repositories/ServerRepository";
import { isStickerSendable } from "@/utils/discord/stickerAvailability";

type EmojiMetadata =
  | ServerEmojiRow
  | {
      emoji_disc_id: string;
      emoji_name: string;
      emoji_desc: string | null;
      emotion_key: string | null;
      is_animated: boolean;
      created_at: Date | null;
      updated_at: Date | null;
    };

type StickerMetadata =
  | ServerStickerRow
  | {
      sticker_disc_id: string;
      sticker_name: string;
      sticker_desc: string | null;
      emotion_key: string | null;
      created_at: Date | null;
      updated_at: Date | null;
    };

export async function buildServerEmojiContextItem(params: {
  client: Client;
  guildId: string;
  serverName: string;
  botName: string;
  isDMChannel: boolean;
  isUserImpersonation: boolean;
  tomoriConfig: AssembledServerConfig;
  tomoriState: TomoriState | null;
  preloadedEmojis?: ServerEmojiRow[] | null;
  snapshot?: import("@/types/misc/context").RequestSnapshot;
  convertMentions: MentionConverter;
}): Promise<StructuredContextItem | null> {
  if (params.isDMChannel || !params.tomoriConfig.emoji_usage_enabled || !params.tomoriState) {
    return null;
  }

  const guildEmojisCache = params.client.guilds.cache.get(params.guildId)?.emojis.cache;
  if (!guildEmojisCache || guildEmojisCache.size === 0) {
    return null;
  }

  const emojiMetadata =
    params.preloadedEmojis && params.preloadedEmojis.length > 0
      ? params.preloadedEmojis
      : (await serverRepository.loadEmojis(params.tomoriState.server_id)) || [];

  const emojiMetadataByName = new Map<string, EmojiMetadata>();
  const hasEmojiMetadata = (metadata: EmojiMetadata) =>
    (metadata.emotion_key && metadata.emotion_key !== "unset") ||
    (metadata.emoji_desc && metadata.emoji_desc.trim().length > 0);
  const getMetadataTimestamp = (metadata: EmojiMetadata) =>
    Math.max(metadata.updated_at?.getTime() ?? 0, metadata.created_at?.getTime() ?? 0);

  for (const metadata of emojiMetadata) {
    if (!metadata.emoji_name) continue;
    const nameKey = metadata.emoji_name.toLowerCase();
    const existing = emojiMetadataByName.get(nameKey);
    if (
      !existing ||
      (hasEmojiMetadata(metadata) && !hasEmojiMetadata(existing)) ||
      (hasEmojiMetadata(metadata) === hasEmojiMetadata(existing) &&
        getMetadataTimestamp(metadata) >= getMetadataTimestamp(existing))
    ) {
      emojiMetadataByName.set(nameKey, metadata);
    }
  }

  const sortedEmojis = Array.from(guildEmojisCache.values()).sort(
    (a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0),
  );
  const latestEmojiByName = new Map<string, (typeof sortedEmojis)[number]>();
  for (const emoji of sortedEmojis) {
    if (emoji.name) latestEmojiByName.set(emoji.name.toLowerCase(), emoji);
  }

  const emojiLines = sortedEmojis
    .filter((emoji) => emoji.name && latestEmojiByName.get(emoji.name.toLowerCase())?.id === emoji.id)
    .map((emoji) => {
      const emojiName = emoji.name ?? "";
      const metadata = emojiMetadataByName.get(emojiName.toLowerCase());
      const emotionKey = metadata?.emotion_key === "unset" ? null : (metadata?.emotion_key ?? null);
      if (!metadata || (!metadata.emoji_desc && !emotionKey)) {
        return `:${emojiName}:`;
      }

      const labelParts: string[] = [];
      if (emotionKey) labelParts.push(`Expresses ${emotionKey}`);
      if (metadata.emoji_desc) labelParts.push(metadata.emoji_desc);
      return `:${emojiName}: (${labelParts.join("; ")})`;
    });

  const emojiContent = `## ${params.serverName}'s Emojis\n- ${emojiLines.join("\n- ")}.`;
  const emojiUsage = params.isUserImpersonation
    ? `\nTo use ${params.serverName}'s emojis, write :name: (name only, no IDs). Names are case-insensitive.\n`
    : `\nTo use ${params.serverName}'s emojis, just write :name: (name only, no IDs). Names are case-insensitive. {bot} only uses server emojis when it matches their actual mood.\n`;

  return {
    role: "system",
    parts: [
      {
        type: "text",
        text: await params.convertMentions(
          emojiContent + emojiUsage,
          params.client,
          params.guildId,
          "User",
          params.botName,
          params.tomoriConfig.personal_memories_enabled,
          params.snapshot,
        ),
      },
    ],
    metadataTag: ContextItemTag.KNOWLEDGE_SERVER_EMOJIS,
  };
}

export async function buildServerStickerContextItem(params: {
  client: Client;
  guildId: string;
  serverName: string;
  botName: string;
  isDMChannel: boolean;
  isUserImpersonation: boolean;
  tomoriConfig: AssembledServerConfig;
  tomoriState: TomoriState | null;
  preloadedStickers?: ServerStickerRow[] | null;
  toolPromptMacroResolver: ToolPromptMacroResolver;
  convertMentions: MentionConverter;
}): Promise<StructuredContextItem | null> {
  if (
    !params.tomoriConfig.sticker_usage_enabled ||
    params.isDMChannel ||
    params.isUserImpersonation ||
    !params.tomoriState
  ) {
    return null;
  }

  const guildStickersCache = params.client.guilds.cache.get(params.guildId)?.stickers.cache;
  if (!guildStickersCache || guildStickersCache.size === 0) {
    return null;
  }

  const stickerMetadata =
    params.preloadedStickers && params.preloadedStickers.length > 0
      ? params.preloadedStickers
      : await serverRepository.loadStickersByInternalId(params.tomoriState.server_id);

  const stickerMetadataByName = new Map<string, StickerMetadata>();
  const hasStickerMetadata = (metadata: StickerMetadata) =>
    (metadata.emotion_key && metadata.emotion_key !== "unset") ||
    (metadata.sticker_desc && metadata.sticker_desc.trim().length > 0);
  const getStickerMetadataTimestamp = (metadata: StickerMetadata) =>
    Math.max(metadata.updated_at?.getTime() ?? 0, metadata.created_at?.getTime() ?? 0);

  for (const metadata of stickerMetadata) {
    if (!metadata.sticker_name) continue;
    const nameKey = metadata.sticker_name.toLowerCase();
    const existing = stickerMetadataByName.get(nameKey);
    if (
      !existing ||
      (hasStickerMetadata(metadata) && !hasStickerMetadata(existing)) ||
      (hasStickerMetadata(metadata) === hasStickerMetadata(existing) &&
        getStickerMetadataTimestamp(metadata) >= getStickerMetadataTimestamp(existing))
    ) {
      stickerMetadataByName.set(nameKey, metadata);
    }
  }

  const sortedStickers = Array.from(guildStickersCache.values())
    .filter((sticker) => isStickerSendable(sticker))
    .sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0));
  const latestStickerByName = new Map<string, (typeof sortedStickers)[number]>();
  for (const sticker of sortedStickers) {
    if (sticker.name) latestStickerByName.set(sticker.name.toLowerCase(), sticker);
  }

  let stickerContent = `## ${params.serverName}'s Stickers\nThis server has the following stickers available for ${params.botName} to use with the '{sticker_tool}' function:\n`;
  for (const sticker of sortedStickers.filter(
    (sticker) => sticker.name && latestStickerByName.get(sticker.name.toLowerCase())?.id === sticker.id,
  )) {
    const stickerName = sticker.name ?? "";
    const metadata = stickerMetadataByName.get(stickerName.toLowerCase());
    const emotionKey = metadata?.emotion_key === "unset" ? null : (metadata?.emotion_key ?? null);
    const labelParts: string[] = [];
    if (emotionKey) labelParts.push(`Expresses ${emotionKey}`);
    if (metadata?.sticker_desc) labelParts.push(metadata.sticker_desc);
    if (labelParts.length === 0 && sticker.description) labelParts.push(sticker.description);
    stickerContent += `- "${stickerName}"${labelParts.length > 0 ? ` (${labelParts.join("; ")})` : ""}\n`;
  }
  stickerContent += "To use a sticker, call '{sticker_tool}' with the sticker's name (case-insensitive).\n";

  return {
    role: "system",
    parts: [
      {
        type: "text",
        text: await params.convertMentions(
          await params.toolPromptMacroResolver.expand(stickerContent),
          params.client,
          params.guildId,
          "User",
          params.botName,
          params.tomoriConfig.personal_memories_enabled,
        ),
      },
    ],
    metadataTag: ContextItemTag.KNOWLEDGE_SERVER_STICKERS,
  };
}
