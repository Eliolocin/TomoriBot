import type { Client } from "discord.js";
import {
  ContextItemTag,
  type ContextPart,
  type MediaDescriptor,
  type StructuredContextItem,
} from "@/types/misc/context";
import { HumanizerDegree, type AssembledServerConfig, type TomoriState } from "@/types/db/schema";
import { normalizeMessageFetchLimit } from "@/utils/discord/messageFetchLimit";
import { log } from "@/utils/misc/logger";
import { memoryGuard } from "@/utils/security/rateLimiter";
import { humanizeString } from "@/utils/text/processors/formatters";
import { applyUncensorInputTransforms } from "@/utils/text/uncensor";
import {
  VERBATIM_TOOL_CALLING_CONTEXT_DEPTH,
  VERBATIM_TOOL_CALLING_NUDGE,
  shouldInjectVerbatimToolCallingNudge,
} from "@/utils/tools/verbatimToolCalling";
import type { MessageIdMap } from "@/utils/text/messageIdMap";
import {
  buildMediaAttributionText,
  formatMessageTimestamp,
  getLastImageOccurrenceIndices,
  getRenderedImageMessageIdsWithinWindow,
  isCountedRenderedImageAttachment,
  MEDIA_IMAGE_MESSAGE_LIMIT,
  pushDialogueHistoryContextItem,
} from "./history";
import { normalizeCustomEmojisForLlm, splitLeadingSystemBlocks } from "./mentionNormalizer";
import type { MentionConverter } from "./templates";
import type { SimplifiedMessageForContext } from "./types";
import { buildDateSpacer, TIME_AWARENESS_NOTE_DEPTH } from "./timeAwareness";

export async function appendDialogueHistoryContext(params: {
  contextItems: StructuredContextItem[];
  client: Client;
  guildId: string;
  simplifiedMessageHistory: SimplifiedMessageForContext[];
  botName: string;
  tomoriConfig: AssembledServerConfig;
  tomoriState: TomoriState | null;
  channelContextNote?: { note: string; depth: number } | null;
  reunionNote?: string | null;
  dateSpacerTemplate?: string | null;
  includeTimestamps: boolean;
  isUserImpersonation: boolean;
  impersonatedUserId?: string;
  triggererDiscordId?: string;
  triggererFormattedName: string;
  historyUserLabels?: Map<string, string>;
  historyPersonaMentionLabels?: Map<string, string>;
  messageIdMap?: MessageIdMap;
  uncensorInputOptions: { unicodeSpacesEnabled: boolean; sanitizeEnabled: boolean };
  convertMentions: MentionConverter;
}): Promise<void> {
  const totalMessages = params.simplifiedMessageHistory.length;
  const configuredMessageFetchLimit = normalizeMessageFetchLimit(params.tomoriConfig.message_fetch_limit);
  const effectiveMediaWindow = Math.min(memoryGuard.getMediaWindow(), configuredMessageFetchLimit);
  const mediaWindowCutoff = totalMessages - effectiveMediaWindow;
  const renderedImageMessageIds = getRenderedImageMessageIdsWithinWindow(
    params.simplifiedMessageHistory,
    mediaWindowCutoff,
  );
  const duplicateImageLastIndex = getLastImageOccurrenceIndices(
    params.simplifiedMessageHistory,
    renderedImageMessageIds,
    mediaWindowCutoff,
  );

  // Persona and channel notes are additive (both injected when set).
  // Global note is a fallback used only when neither persona nor channel has one.
  const personaNoteText = params.tomoriState?.context_note?.trim() || null;
  const channelNoteText = params.channelContextNote?.note?.trim() || null;

  const activeNotes: Array<{ text: string; targetIndex: number; emitted: boolean }> = [];

  if (personaNoteText) {
    const depth = params.tomoriState?.context_note_depth ?? 0;
    activeNotes.push({ text: personaNoteText, targetIndex: Math.max(0, totalMessages - depth), emitted: false });
  }
  if (channelNoteText) {
    const depth = params.channelContextNote?.depth ?? 0;
    activeNotes.push({ text: channelNoteText, targetIndex: Math.max(0, totalMessages - depth), emitted: false });
  }
  if (activeNotes.length === 0) {
    const globalNoteText = params.tomoriConfig.context_note?.trim() || null;
    if (globalNoteText) {
      const depth = params.tomoriConfig.context_note_depth ?? 0;
      activeNotes.push({ text: globalNoteText, targetIndex: Math.max(0, totalMessages - depth), emitted: false });
    }
  }
  if (shouldInjectVerbatimToolCallingNudge(params.tomoriConfig, params.tomoriState)) {
    activeNotes.push({
      text: VERBATIM_TOOL_CALLING_NUDGE,
      targetIndex: Math.max(0, totalMessages - VERBATIM_TOOL_CALLING_CONTEXT_DEPTH),
      emitted: false,
    });
  }
  // The reunion note sits above the newest messages rather than directly against
  // the triggering prompt, so it reads as background awareness instead of an
  // instruction that outranks whatever the user actually asked for.
  const reunionNoteText = params.reunionNote?.trim();
  if (reunionNoteText) {
    activeNotes.push({
      text: reunionNoteText,
      targetIndex: Math.max(0, totalMessages - TIME_AWARENESS_NOTE_DEPTH),
      emitted: false,
    });
  }

  const botNameLower = params.botName.toLowerCase();
  let previousCreatedAt: number | undefined;
  for (const [index, msg] of params.simplifiedMessageHistory.entries()) {
    const isPersonaMessage = msg.authorType === "persona" && !!msg.personaName;
    const isCurrentPersonaMessage = isPersonaMessage && msg.personaName?.toLowerCase() === botNameLower;
    const role =
      params.isUserImpersonation && msg.authorType === "user" && msg.authorId === params.impersonatedUserId
        ? "model"
        : params.isUserImpersonation || !isCurrentPersonaMessage
          ? "user"
          : "model";
    const sender: StructuredContextItem["sender"] = {
      name: msg.personaName ?? msg.authorName,
      type: msg.authorType,
    };

    if (params.dateSpacerTemplate && previousCreatedAt !== undefined && msg.createdAt !== undefined) {
      const spacer = buildDateSpacer(
        previousCreatedAt,
        msg.createdAt,
        params.tomoriConfig.timezone_offset,
        params.dateSpacerTemplate,
      );
      if (spacer) {
        pushDialogueHistoryContextItem(
          params.contextItems,
          "user",
          [{ type: "text", text: spacer }],
          `date_spacer_${msg.id}`,
        );
      }
    }
    if (msg.createdAt !== undefined) previousCreatedAt = msg.createdAt;

    for (const note of activeNotes) {
      if (!note.emitted && index === note.targetIndex) {
        pushDialogueHistoryContextItem(
          params.contextItems,
          "user",
          [{ type: "text", text: `[System: ${note.text}]` }],
          "context_note_injection",
          ContextItemTag.CONTEXT_NOTE_INJECTION,
        );
        note.emitted = true;
      }
    }

    const parts: ContextPart[] = [];
    const detachedSystemParts: ContextPart[] = [];
    const mediaDescriptors: MediaDescriptor[] = [];
    const isWithinMediaWindow = index >= mediaWindowCutoff;
    const hasNonEmojiImages = msg.imageAttachments.some((attachment) => !attachment.isEmoji);
    const hasVideos = msg.videoAttachments.length > 0;
    const hasSignificantMedia = hasNonEmojiImages || hasVideos;

    const mediaIdHintAdded = appendMediaDescriptors({
      ...params,
      msg,
      index,
      mediaDescriptors,
      detachedSystemParts,
      isWithinMediaWindow,
      hasNonEmojiImages,
      hasVideos,
      renderedImageMessageIds,
      duplicateImageLastIndex,
      mediaWindowCutoff,
    });

    const mediaAttributionHint =
      hasSignificantMedia && !mediaIdHintAdded
        ? await buildMediaAttributionHint({ ...params, msg, hasNonEmojiImages, hasVideos })
        : null;

    await appendTextParts({
      ...params,
      msg,
      role,
      parts,
      detachedSystemParts,
      hasMediaDescriptors: mediaDescriptors.length > 0,
      mediaAttributionHint,
    });

    if (role === "user" && (parts.length > 0 || detachedSystemParts.length > 0 || mediaDescriptors.length > 0)) {
      pushDialogueHistoryContextItem(
        params.contextItems,
        "user",
        [...detachedSystemParts, ...parts],
        msg.id,
        undefined,
        sender,
        mediaDescriptors,
      );
    } else {
      pushDialogueHistoryContextItem(params.contextItems, "user", detachedSystemParts, msg.id, undefined, sender);
      pushDialogueHistoryContextItem(params.contextItems, role, parts, msg.id, undefined, sender, mediaDescriptors);
    }
  }

  for (const note of activeNotes) {
    if (!note.emitted) {
      pushDialogueHistoryContextItem(
        params.contextItems,
        "user",
        [{ type: "text", text: `[System: ${note.text}]` }],
        "context_note_injection",
        ContextItemTag.CONTEXT_NOTE_INJECTION,
      );
    }
  }
}

function appendMediaDescriptors(
  params: Parameters<typeof appendDialogueHistoryContext>[0] & {
    msg: SimplifiedMessageForContext;
    index: number;
    mediaDescriptors: MediaDescriptor[];
    detachedSystemParts: ContextPart[];
    isWithinMediaWindow: boolean;
    hasNonEmojiImages: boolean;
    hasVideos: boolean;
    renderedImageMessageIds: Set<string>;
    duplicateImageLastIndex: Map<string, number>;
    mediaWindowCutoff: number;
  },
): boolean {
  if (!params.isWithinMediaWindow) {
    for (const attachment of params.msg.imageAttachments) {
      if (attachment.isEmoji) continue;
      const mediaId = registerAttachmentMediaId(params, attachment.sourceMessageId);
      params.mediaDescriptors.push({
        kind: "image",
        uri: attachment.proxyUrl,
        mimeType: attachment.mimeType,
        ...(attachment.url !== attachment.proxyUrl && { fallbackUri: attachment.url }),
        mediaId,
        withinWindow: false,
        filename: attachment.filename,
      });
    }
    for (const attachment of params.msg.videoAttachments) {
      const mediaId = registerAttachmentMediaId(params, attachment.sourceMessageId);
      params.mediaDescriptors.push({
        kind: "video",
        uri: attachment.isYouTubeLink ? attachment.url : attachment.proxyUrl,
        mimeType: attachment.mimeType,
        mediaId,
        withinWindow: false,
        isYouTubeLink: attachment.isYouTubeLink,
        filename: attachment.filename,
      });
    }
    return params.mediaDescriptors.length > 0;
  }

  appendImageDescriptors(params);
  appendVideoDescriptors(params);
  return false;
}

function appendImageDescriptors(params: Parameters<typeof appendMediaDescriptors>[0]): void {
  if (params.msg.imageAttachments.length === 0) return;

  const hasCountedImages = params.msg.imageAttachments.some(isCountedRenderedImageAttachment);
  const shouldRenderCountedImages = !hasCountedImages || params.renderedImageMessageIds.has(params.msg.id);
  let skippedCountedImageCount = 0;
  let skippedDuplicateImageCount = 0;

  for (const attachment of params.msg.imageAttachments) {
    if (attachment.isEmoji) continue;

    const countsTowardRenderedImageLimit = isCountedRenderedImageAttachment(attachment);
    if (countsTowardRenderedImageLimit && !shouldRenderCountedImages) {
      skippedCountedImageCount++;
      continue;
    }

    const lastIndex = params.duplicateImageLastIndex.get(attachment.proxyUrl);
    if (lastIndex !== undefined && countsTowardRenderedImageLimit && lastIndex !== params.index) {
      skippedDuplicateImageCount++;
      continue;
    }

    const mediaId = registerAttachmentMediaId(params, attachment.sourceMessageId);
    params.mediaDescriptors.push({
      kind: "image",
      uri: attachment.proxyUrl,
      mimeType: attachment.mimeType,
      ...(attachment.url !== attachment.proxyUrl && { fallbackUri: attachment.url }),
      mediaId,
      withinWindow: true,
      filename: attachment.filename,
    });
  }

  if (skippedDuplicateImageCount > 0) {
    log.info(
      `Skipped ${skippedDuplicateImageCount} duplicate image(s) for message ${params.msg.id} - same image rendered in a later message`,
    );
  }
  if (skippedCountedImageCount > 0) {
    const skippedImageDescription =
      skippedCountedImageCount === 1
        ? "1 image omitted due to rendered-image limit. Do not claim to see it."
        : `${skippedCountedImageCount} images omitted due to rendered-image limit. Do not claim to see them.`;
    params.detachedSystemParts.push({ type: "text", text: `[System: ${skippedImageDescription}]` });
    log.info(
      `Skipped ${skippedCountedImageCount} counted image(s) for message ${params.msg.id} due to MEDIA_IMAGE_MESSAGE_LIMIT=${MEDIA_IMAGE_MESSAGE_LIMIT}`,
    );
  }
}

function appendVideoDescriptors(params: Parameters<typeof appendMediaDescriptors>[0]): void {
  if (params.msg.videoAttachments.length === 0) return;

  for (const attachment of params.msg.videoAttachments) {
    const mediaId = registerAttachmentMediaId(params, attachment.sourceMessageId);
    params.mediaDescriptors.push({
      kind: "video",
      uri: attachment.isYouTubeLink ? attachment.url : attachment.proxyUrl,
      mimeType: attachment.mimeType,
      mediaId,
      withinWindow: true,
      isYouTubeLink: attachment.isYouTubeLink,
      filename: attachment.filename,
    });
  }
}

/**
 * Register the fetchable Discord message that owns one media attachment.
 *
 * Copied reply media carries the referenced source message. Local media and
 * forwarded snapshots fall back to the current wrapper message.
 */
function registerAttachmentMediaId(
  params: Parameters<typeof appendMediaDescriptors>[0],
  sourceMessageId?: string,
): string {
  const resolvedMessageId = sourceMessageId ?? params.msg.id;
  return params.messageIdMap?.register(resolvedMessageId, "media") ?? resolvedMessageId;
}

async function buildMediaAttributionHint(
  params: Parameters<typeof appendDialogueHistoryContext>[0] & {
    msg: SimplifiedMessageForContext;
    hasNonEmojiImages: boolean;
    hasVideos: boolean;
  },
): Promise<string> {
  const mediaMessageIds = [
    ...new Set([
      ...params.msg.imageAttachments
        .filter((attachment) => !attachment.isEmoji)
        .map((attachment) => attachment.sourceMessageId ?? params.msg.id),
      ...params.msg.videoAttachments.map((attachment) => attachment.sourceMessageId ?? params.msg.id),
    ]),
  ];
  const nonEmojiImageCount = params.msg.imageAttachments.filter((attachment) => !attachment.isEmoji).length;
  const videoCount = params.msg.videoAttachments.length;
  const totalMediaCount = nonEmojiImageCount + videoCount;
  const mediaWord =
    nonEmojiImageCount > 0 && videoCount === 0
      ? nonEmojiImageCount === 1
        ? "image"
        : "images"
      : videoCount > 0 && nonEmojiImageCount === 0
        ? videoCount === 1
          ? "video"
          : "videos"
        : "media files";
  const idLabel = mediaMessageIds.length === 1 ? "Media ID" : "Media IDs";
  const idList = mediaMessageIds.map((id) => params.messageIdMap?.register(id, "media") ?? id).join(", ");
  const thisOrThese = totalMediaCount === 1 ? "This" : "These";
  const wasSent = totalMediaCount === 1 ? "was" : "were";

  // Forwarded media registers the wrapper message's own id (so tools can resolve
  // it in the current channel), so it would pass the includes() check below.
  // branch on the source kind first to keep the forwarded attribution wording.
  if (params.msg.remoteMediaSourceKind === "forwarded") {
    return `[System: ${thisOrThese} ${mediaWord} (${idLabel}: ${idList}) ${wasSent} attached to the forwarded message described above]`;
  }

  if (!mediaMessageIds.includes(params.msg.id)) {
    return `[System: ${thisOrThese} ${mediaWord} (${idLabel}: ${idList}) ${wasSent} included in the message being replied to]`;
  }

  const resolvedHintAuthorName = await params.convertMentions(
    params.msg.authorName,
    params.client,
    params.guildId,
    params.msg.authorName,
    params.botName,
    params.tomoriConfig.personal_memories_enabled,
  );
  return `[System: ${thisOrThese} ${mediaWord} (${idLabel}: ${idList}) ${wasSent} sent by ${resolvedHintAuthorName}]`;
}

async function appendTextParts(
  params: Parameters<typeof appendDialogueHistoryContext>[0] & {
    msg: SimplifiedMessageForContext;
    role: "user" | "model";
    parts: ContextPart[];
    detachedSystemParts: ContextPart[];
    hasMediaDescriptors: boolean;
    mediaAttributionHint: string | null;
  },
): Promise<void> {
  const authorLabel =
    params.msg.authorType === "user"
      ? (params.historyUserLabels?.get(params.msg.authorId) ??
        (params.triggererDiscordId === params.msg.authorId && params.triggererFormattedName
          ? params.triggererFormattedName
          : params.msg.authorName))
      : params.msg.authorName;

  if (params.msg.content) {
    let normalizedContent = normalizeCustomEmojisForLlm(params.msg.content);
    if (params.msg.authorPersonaLineageId != null && params.historyPersonaMentionLabels) {
      normalizedContent = normalizedContent.replace(/<@!?(\d+)>/gu, (mention, targetId: string) => {
        return params.historyPersonaMentionLabels?.get(`${params.msg.authorPersonaLineageId}:${targetId}`) ?? mention;
      });
    }

    // The author label is text WE author, so identity macros in it must still resolve: it is
    //    what tells the model which name owns the turn. Resolved BEFORE the join so the body,
    //    which is raw prose, can opt out of macro expansion in step 3.
    const resolvedAuthorLabel = await params.convertMentions(
      authorLabel,
      params.client,
      params.guildId,
      authorLabel,
      params.botName,
      params.tomoriConfig.personal_memories_enabled,
      undefined,
      "resolve",
    );

    let processedContent: string;
    if (normalizedContent.startsWith("[System:")) {
      const { leadingSystemBlocks, remainingContent } = splitLeadingSystemBlocks(normalizedContent);
      processedContent =
        leadingSystemBlocks.length > 0 && remainingContent
          ? `${leadingSystemBlocks.join("\n")}\n${resolvedAuthorLabel}: ${remainingContent}`
          : normalizedContent;
    } else {
      processedContent = `${resolvedAuthorLabel}: ${normalizedContent}`;
    }

    if (params.tomoriConfig.humanizer_degree >= HumanizerDegree.HEAVY && params.role === "model") {
      processedContent = humanizeString(processedContent);
    }
    // Mentions, channel links, and roles still resolve here. Only the identity macros are left
    //    literal: this string carries a real Discord message body, so rewriting "{bot}"/"{char}"
    //    would corrupt legitimate content (e.g. a persona preset Tomori drafted for a user) and,
    //    on a model-role line, would collapse both macros onto the persona's own name.
    processedContent = await params.convertMentions(
      processedContent,
      params.client,
      params.guildId,
      params.msg.authorName,
      params.botName,
      params.tomoriConfig.personal_memories_enabled,
      undefined,
      "preserve",
    );
    if (!processedContent.startsWith("[System:")) {
      processedContent = applyUncensorInputTransforms(processedContent, params.uncensorInputOptions);
    }
    if (params.mediaAttributionHint) processedContent += `\n${params.mediaAttributionHint}`;
    params.parts.push({ type: "text", text: processedContent });
    if (params.includeTimestamps && params.msg.createdAt) {
      params.parts.push({ type: "text", text: formatMessageTimestamp(params.msg.createdAt) });
    }
  } else if (params.parts.length > 0 || params.detachedSystemParts.length > 0 || params.hasMediaDescriptors) {
    if (params.mediaAttributionHint) {
      params.parts.push({ type: "text", text: params.mediaAttributionHint });
      return;
    }

    params.parts.push({
      type: "text",
      text: await params.convertMentions(
        buildMediaAttributionText(params.msg, authorLabel),
        params.client,
        params.guildId,
        authorLabel,
        params.botName,
        params.tomoriConfig.personal_memories_enabled,
      ),
    });
  }
}
