import { EmbedBuilder, MessageFlags, type BaseGuildTextChannel, type Client } from "discord.js";
import type { Request as BridgeRequest, WeakEvent } from "matrix-appservice-bridge";
import { getCachedAllPersonas } from "@/utils/cache/tomoriStateCache";
import { clearShortTermMemoryForChannel } from "@/utils/cache/shortTermMemoryCache";
import { getOrCreateWebhook } from "@/utils/discord/webhook/lifecycle";
import { StreamOrchestrator } from "@/utils/discord/streamOrchestrator";
import { ColorCode, log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";
import { sendMatrixInviteSetupNotice } from "./client";
import { downloadMatrixMedia, MATRIX_MAX_ATTACHMENT_BYTES } from "./media";
import { getDiscordChannelForRoom, getJoinViaServers } from "./rooms";
import {
  getPersonaReplyEventMetadata,
  getTrackedPersonaReply,
  markPendingMatrixReply,
  stripMatrixReplyFallback,
} from "./stateSync";
import { getMatrixBridge, MATRIX_MEMBER_EVENT_TYPE, MATRIX_TEXT_MSG_TYPE } from "./state";
import { rememberMatrixDisplayName, sendMatrixTypingIndicator } from "./userMapping";

export async function handleMatrixEvent(
  request: BridgeRequest<WeakEvent>,
  discordClient: Client,
  botUserId: string,
): Promise<void> {
  const event = request.getData();
  const serverName = process.env.MATRIX_SERVER_NAME ?? "";

  if (await handleInviteEvent(event, botUserId)) {
    return;
  }

  if (event.type !== MATRIX_TEXT_MSG_TYPE) return;

  const isOwnVirtualUser = event.sender.startsWith("@_tomori_") && event.sender.endsWith(`:${serverName}`);
  if (event.sender === botUserId || isOwnVirtualUser) return;

  const channelDiscId = await getDiscordChannelForRoom(event.room_id);
  if (!channelDiscId) return;

  const channel = await discordClient.channels.fetch(channelDiscId).catch(() => null);
  if (!channel?.isTextBased() || channel.isDMBased()) return;

  const senderLocalpart = event.sender.split(":")[0].replace("@", "");
  rememberMatrixDisplayName(senderLocalpart, event.sender);
  const username = buildWebhookUsername(event.sender, senderLocalpart);
  const content = event.content;
  const msgtype = (content.msgtype as string | undefined) ?? "m.text";
  const rawBody = (content.body as string | undefined)?.trim();
  const bodyText = rawBody ? stripMatrixReplyFallback(rawBody) : rawBody;

  if (
    await relayMatrixMediaIfNeeded(
      content,
      msgtype,
      bodyText ?? "attachment",
      username,
      channel as BaseGuildTextChannel,
    )
  ) {
    return;
  }

  if (msgtype === "m.notice" || !bodyText) return;

  if (bodyText === "/kill") {
    await handleMatrixKill(channel as BaseGuildTextChannel, channelDiscId, event.room_id, event.sender);
    return;
  }

  if (bodyText === "/refresh") {
    await handleMatrixRefresh(channel as BaseGuildTextChannel, channelDiscId);
    return;
  }

  const replyContext = await buildReplyContext(content, event.room_id, channelDiscId, senderLocalpart, serverName);
  const relayContent = `${msgtype === "m.emote" ? `* ${bodyText}` : bodyText}${replyContext ? ` ${replyContext}` : ""}`;
  const { webhook } = await getOrCreateWebhook(channel as BaseGuildTextChannel);
  if (!webhook) return;

  await webhook.send({
    content: relayContent,
    username,
    allowedMentions: { parse: [] },
  });
}

async function handleInviteEvent(event: WeakEvent, botUserId: string): Promise<boolean> {
  if (
    event.type !== MATRIX_MEMBER_EVENT_TYPE ||
    event.state_key !== botUserId ||
    (event.content as { membership?: string }).membership !== "invite"
  ) {
    return false;
  }

  try {
    const botIntent = getMatrixBridge()?.getIntent();
    if (!botIntent) return true;
    await botIntent.join(event.room_id, getJoinViaServers(event.room_id));
    log.info(`Matrix bridge: auto-accepted invite to ${event.room_id}`);
    await sendMatrixInviteSetupNotice(event.room_id);
  } catch (error) {
    const safeMsg = error instanceof Error ? error.message : String(error);
    log.warn(`Matrix bridge: failed to auto-accept invite to ${event.room_id}: ${safeMsg}`);
  }

  return true;
}

async function relayMatrixMediaIfNeeded(
  content: Record<string, unknown>,
  msgtype: string,
  filename: string,
  username: string,
  channel: BaseGuildTextChannel,
): Promise<boolean> {
  const isMediaMsg = msgtype === "m.image" || msgtype === "m.video" || msgtype === "m.file" || msgtype === "m.audio";
  if (!isMediaMsg) return false;

  const { webhook } = await getOrCreateWebhook(channel);
  if (!webhook) return true;

  const info = content.info as Record<string, unknown> | undefined;
  const knownSize = typeof info?.size === "number" ? info.size : undefined;
  if (knownSize !== undefined && knownSize > MATRIX_MAX_ATTACHMENT_BYTES) {
    const sizeMb = (knownSize / (1024 * 1024)).toFixed(1);
    await webhook.send({
      content: `[Matrix: attachment too large to relay (${sizeMb} MB)]`,
      username,
      allowedMentions: { parse: [] },
    });
    return true;
  }

  const mxcUrl = content.url as string | undefined;
  if (mxcUrl) {
    const media = await downloadMatrixMedia(
      mxcUrl,
      process.env.MATRIX_HOMESERVER_URL ?? "",
      process.env.MATRIX_ACCESS_TOKEN ?? "",
      knownSize,
    );
    if (media) {
      await webhook.send({
        files: [{ attachment: media.buffer, name: filename }],
        username,
        allowedMentions: { parse: [] },
      });
      return true;
    }
  }

  await webhook.send({
    content: `[Matrix: attachment unavailable - ${filename}]`,
    username,
    allowedMentions: { parse: [] },
  });
  return true;
}

async function handleMatrixKill(
  channel: BaseGuildTextChannel,
  channelDiscId: string,
  roomId: string,
  requesterId: string,
): Promise<void> {
  let hasActiveStream = false;
  let clearedQueueCount = 0;

  try {
    const { isChannelProcessingLocked, clearChannelProcessingQueue } = await import(
      "@/events/messageCreate/tomoriChat"
    );
    hasActiveStream = isChannelProcessingLocked(channelDiscId);
    clearedQueueCount = clearChannelProcessingQueue(channelDiscId);
    if (hasActiveStream) {
      StreamOrchestrator.requestStop(channelDiscId, requesterId);
    }
  } catch (error) {
    log.warn(`Matrix /kill: failed to stop stream/clear queue for channel ${channelDiscId}`, error);
  }

  const clearedTypingPersonaCount = await clearMatrixTypingIndicatorsForChannel(channel, roomId);
  log.info(
    `Stop/clear requested via Matrix /kill by user ${requesterId} in channel ${channelDiscId}. Active stream: ${hasActiveStream}. Cleared ${clearedQueueCount} queued message(s). Cleared Matrix typing for ${clearedTypingPersonaCount} persona(s).`,
  );
}

async function handleMatrixRefresh(channel: BaseGuildTextChannel, channelDiscId: string): Promise<void> {
  clearShortTermMemoryForChannel(channelDiscId);
  log.info(`Matrix /refresh: cleared short-term memories for channel ${channelDiscId}`);

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle(localizer("en-US", "commands.refresh.title"))
        .setDescription(localizer("en-US", "commands.refresh.response"))
        .setColor(ColorCode.SECTION),
    ],
    flags: MessageFlags.SuppressNotifications,
  });
}

async function clearMatrixTypingIndicatorsForChannel(channel: BaseGuildTextChannel, roomId: string): Promise<number> {
  const personaNames = new Set<string>();

  try {
    const personas = await getCachedAllPersonas(channel.guildId);
    for (const persona of personas) {
      const name = persona.persona_nickname?.trim();
      if (name) personaNames.add(name);
    }
  } catch (error) {
    log.warn(`Matrix /kill: failed to load personas for typing clear in channel ${channel.id}`, error);
  }

  personaNames.add(process.env.DEFAULT_BOTNAME || "Tomori");
  const names = Array.from(personaNames);
  await Promise.all(names.map((personaName) => sendMatrixTypingIndicator(roomId, personaName, false)));
  return names.length;
}

async function buildReplyContext(
  content: Record<string, unknown>,
  roomId: string,
  channelDiscId: string,
  senderLocalpart: string,
  serverName: string,
): Promise<string> {
  const relatesTo = content["m.relates_to"] as Record<string, unknown> | undefined;
  const inReplyTo = relatesTo?.["m.in_reply_to"] as { event_id?: string } | undefined;
  const replyEventId = inReplyTo?.event_id;
  if (!replyEventId) return "";

  const tracked = getTrackedPersonaReply(replyEventId);
  if (tracked) {
    markPendingMatrixReply(channelDiscId);
    const quotedSnippet = tracked.replySnippet ? ` "${tracked.replySnippet}"` : "";
    return `[System: ${senderLocalpart} is replying to ${tracked.personaName}'s message${quotedSnippet}]`;
  }

  const replyMetadata = await getPersonaReplyEventMetadata(roomId, replyEventId, serverName);
  if (!replyMetadata.isPersonaReply) return "";

  markPendingMatrixReply(channelDiscId);
  const quotedSnippet = replyMetadata.replySnippet ? ` "${replyMetadata.replySnippet}"` : "";
  return `[System: ${senderLocalpart} is replying to another person's message${quotedSnippet}]`;
}

function buildWebhookUsername(sender: string, senderLocalpart: string): string {
  const rawUsername = `[Matrix|${sender}] ${senderLocalpart}`;
  return rawUsername.length > 80 ? `${rawUsername.slice(0, 77)}...` : rawUsername;
}
