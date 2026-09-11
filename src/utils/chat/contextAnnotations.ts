import type { Embed, Message, MessageReaction } from "discord.js";
import { MessageType } from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import type { ForcedMention } from "@/types/discord/mentions";
import { ContextItemTag, type StructuredContextItem } from "@/types/misc/context";
import { getCachedBlacklistStatus, getCachedUserRow } from "@/utils/cache/userCache";
import { stripBridgePrefix } from "@/utils/bridges";
import { resolvePreferredDiscordDisplayName } from "@/utils/discord/displayName";
import { normalizeRenderModifierName, resolveRenderModifierSourcePersona } from "@/utils/discord/renderModifierParser";
import { resolveSpriteMessageDisplayName } from "@/utils/discord/spriteMessageLabel";
import { log } from "@/utils/misc/logger";
import { parseIntegerEnvFlag } from "@/utils/misc/envFlags";
import { compactWhitespace, normalizeTailDirective } from "@/utils/chat/contextDirectives";
import type { SimplifiedMessageForContext } from "@/utils/text/contextBuilder";
import { formatTimestampInline } from "@/utils/text/contextBuilder";
import { getSupportedLocales, localizer } from "@/utils/text/localizer";
import { escapeRegExp } from "@/utils/text/processors/regexUtils";
import type { MessageIdMap } from "@/utils/text/messageIdMap";
import { normalizeTriggerWord } from "@/utils/text/triggerWords";

const REACTION_CONTEXT_ENABLED = parseBooleanEnvFlag(process.env.REACTION_CONTEXT_ENABLED, true);
const REACTION_CONTEXT_MAX_API_CALLS_PER_TURN = parseIntegerEnvFlag(
  process.env.REACTION_CONTEXT_MAX_API_CALLS_PER_TURN,
  20,
  0,
);
const REACTION_CONTEXT_MAX_REACTIONS_PER_MESSAGE = parseIntegerEnvFlag(
  process.env.REACTION_CONTEXT_MAX_REACTIONS_PER_MESSAGE,
  4,
  1,
);
const REACTION_CONTEXT_MAX_USERS_PER_REACTION = parseIntegerEnvFlag(
  process.env.REACTION_CONTEXT_MAX_USERS_PER_REACTION,
  5,
  0,
);
const SUPPORTED_VIDEO_MIME_TYPES = [
  "video/mp4",
  "video/mpeg",
  "video/mov",
  "video/avi",
  "video/x-flv",
  "video/mpg",
  "video/webm",
  "video/wmv",
  "video/3gpp",
];
const DISCORD_MESSAGE_LINK_PATTERN = /discord(?:app)?\.com\/channels\/(?:@me|\d+)\/(\d+)\/(\d+)/;
const REPLY_CONTEXT_URL_SENTINEL = "https://discord.com/channels/0/0";
const REPLY_CONTEXT_USER_SENTINEL = "__tomori_user__";

export type ReactionContextBudgetState = {
  callsUsed: number;
  budgetExhaustedLogged: boolean;
  messagesWithReactions: number;
  fallbackCount: number;
};

export function createReactionContextBudgetState(): ReactionContextBudgetState {
  return {
    callsUsed: 0,
    budgetExhaustedLogged: false,
    messagesWithReactions: 0,
    fallbackCount: 0,
  };
}

export function mergeForcedMentions(...mentionLists: Array<ForcedMention[] | undefined>): ForcedMention[] {
  const seen = new Set<string>();
  const merged: ForcedMention[] = [];

  for (const mentionList of mentionLists) {
    if (!mentionList) continue;
    for (const mention of mentionList) {
      const dedupeKey = `${mention.userId}:${mention.handle.toLowerCase()}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      merged.push(mention);
    }
  }

  return merged;
}

export function stripAtPersonaTriggers(content: string, allPersonas: TomoriState[]): string {
  let result = content;
  for (const persona of allPersonas) {
    const triggers = persona.trigger_words ?? [];

    for (const trigger of triggers) {
      const normalizedTrigger = normalizeTriggerWord(trigger, { lowercase: false });
      if (!normalizedTrigger) continue;
      const pattern = new RegExp(`(?<![\\w])@${escapeRegExp(normalizedTrigger)}`, "gi");
      result = result.replace(pattern, normalizedTrigger);
    }
  }
  return result;
}

export function buildRevealedMessageMetadataTailDirective(): string {
  return (
    "Recent message metadata has been revealed in the visible conversation turns. " +
    "Each annotated message now includes a `ref_N` handle and sent timestamp. " +
    // The system prompt still documents `reveal_message_metadata` (macros expand
    // once at context-build time, before the reveal), so without this line the
    // model re-requests a reveal it has already been given.
    "That reveal is already complete, so do not call `reveal_message_metadata` again for the rest of this turn: use the `ref_N` handles shown above. " +
    "`manage_message` can pin any recent message if Discord permissions allow it, and can edit or delete recent messages you or another character owns. " +
    "`interact_with_recent_message` can react to a recent message with an emoji or send a short reply/backtrack comment about it; replies targeting a known persona message use that persona identity when possible."
  );
}

export function buildCombinedTailDirectiveMessage(directives: string[]): StructuredContextItem | null {
  const normalized = directives
    .map((directive) => normalizeTailDirective(directive))
    .filter((directive) => directive.length > 0);
  if (normalized.length === 0) return null;

  return {
    role: "user",
    parts: [{ type: "text", text: `[System: ${normalized.join("\n\n")}]` }],
    metadataTag: ContextItemTag.DIALOGUE_HISTORY,
  };
}

export function buildTailDirectiveMessage(directive: string | null | undefined): StructuredContextItem | null {
  if (!directive) return null;
  return buildCombinedTailDirectiveMessage([directive]);
}

export function buildSpeakerGuardRetryDirective(activePersonaName?: string | null): StructuredContextItem | null {
  const normalizedPersonaName = compactWhitespace(activePersonaName ?? "") || process.env.DEFAULT_BOTNAME || "Tomori";
  const sanitizedPersonaName = normalizedPersonaName.replaceAll('"', "'");

  return buildTailDirectiveMessage(
    `Your previous attempt started as the wrong speaker and was discarded. Reply only as ${sanitizedPersonaName}. Start exactly with "${sanitizedPersonaName}:". Do not start with any other speaker name or write dialogue for anyone else.`,
  );
}

export function mergeInjectedContextItems(
  existingItems: StructuredContextItem[] | undefined,
  extraItem: StructuredContextItem | null,
): StructuredContextItem[] | undefined {
  if (!extraItem) {
    return existingItems;
  }

  if (!existingItems || existingItems.length === 0) {
    return [extraItem];
  }

  const extraText = extraItem.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const alreadyPresent = existingItems.some((item) => {
    const itemText = item.parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    return item.role === extraItem.role && item.metadataTag === extraItem.metadataTag && itemText === extraText;
  });

  if (alreadyPresent) {
    return existingItems;
  }

  return [...existingItems, extraItem];
}

export function appendInjectedContextItems(
  contextItems: StructuredContextItem[],
  injectedContextItems?: StructuredContextItem[],
): StructuredContextItem[] {
  if (!injectedContextItems || injectedContextItems.length === 0) {
    return contextItems;
  }

  return [...contextItems, ...injectedContextItems];
}

export function insertBeforeLatestDialoguePair(
  contextSegments: StructuredContextItem[],
  injectedItem: StructuredContextItem,
): void {
  const dialogueIndexes: number[] = [];

  for (let index = contextSegments.length - 1; index >= 0; index--) {
    const item = contextSegments[index];
    if (item.metadataTag === ContextItemTag.DIALOGUE_HISTORY && (item.role === "user" || item.role === "model")) {
      dialogueIndexes.push(index);
      if (dialogueIndexes.length === 2) break;
    }
  }

  if (dialogueIndexes.length === 0) {
    contextSegments.push(injectedItem);
    return;
  }

  const insertAt = dialogueIndexes.length >= 2 ? dialogueIndexes[1] : dialogueIndexes[0];
  contextSegments.splice(insertAt, 0, injectedItem);
}

/**
 * Injects an item into the dialogue history at a given depth from the bottom.
 * depth=0 → appended after all dialogue (tail, right before model generates).
 * depth=N → inserted before the Nth DIALOGUE_HISTORY item from the end.
 *
 * Only ContextItemTag.DIALOGUE_HISTORY items are counted: DIALOGUE_SAMPLE
 * (sample/example dialogues) are intentionally excluded from the depth walk
 * so they don't interfere with nudge positioning in real conversation history.
 *
 * If fewer real dialogue turns exist than requested depth, clamps to the
 * earliest available position (just before the first real dialogue turn) rather
 * than jumping to tail, keeping the nudge within the conversation area.
 */
export function insertAtDialogueDepth(
  items: StructuredContextItem[],
  nudge: StructuredContextItem,
  depth: number,
): void {
  if (depth <= 0) {
    items.push(nudge);
    return;
  }
  let found = 0;
  let lastFoundIndex = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].metadataTag === ContextItemTag.DIALOGUE_HISTORY) {
      found++;
      lastFoundIndex = i;
      if (found === depth) {
        items.splice(i, 0, nudge);
        return;
      }
    }
  }
  // Fewer real dialogue turns than depth: clamp to the earliest found position.
  // This keeps the nudge inside the conversation area rather than jumping to tail.
  if (lastFoundIndex !== -1) {
    items.splice(lastFoundIndex, 0, nudge);
  } else {
    // No dialogue history at all: tail is the only option
    items.push(nudge);
  }
}

export function findReplyContextTargetInMessage(
  message: Pick<Message, "embeds">,
): { channelId: string; messageId: string } | null {
  for (const embed of message.embeds) {
    const target = extractReplyContextTargetFromEmbed(embed);
    if (target) {
      return target;
    }
  }
  return null;
}

function extractReplyContextTargetFromEmbed(embed: Embed): { channelId: string; messageId: string } | null {
  const description = embed.description?.trim() ?? "";
  const authorName = embed.author?.name?.trim() ?? "";
  const footerText = embed.footer?.text?.trim() ?? "";
  const hasReplyDescription = matchesLocalizedReplyContextTemplate(
    description,
    "genai.message_interaction.reply_context_description",
    { message_url: REPLY_CONTEXT_URL_SENTINEL },
  );
  const hasReplyAuthor = matchesLocalizedReplyContextTemplate(
    authorName,
    "genai.message_interaction.reply_context_author",
    { user: REPLY_CONTEXT_USER_SENTINEL },
  );
  const hasReplyFooter = matchesLocalizedReplyContextTemplate(
    footerText,
    "genai.message_interaction.reply_context_footer",
    {
      user: REPLY_CONTEXT_USER_SENTINEL,
      message_url: REPLY_CONTEXT_URL_SENTINEL,
    },
  );

  if (!hasReplyDescription && !hasReplyAuthor && !hasReplyFooter) {
    return null;
  }

  const match = `${embed.url ?? ""}\n${description}`.match(DISCORD_MESSAGE_LINK_PATTERN);
  if (!match) {
    return null;
  }

  return {
    channelId: match[1],
    messageId: match[2],
  };
}

function matchesLocalizedReplyContextTemplate(
  text: string,
  templateKey: string,
  placeholderValues: Record<string, string>,
): boolean {
  for (const locale of getSupportedLocales()) {
    const template = localizer(locale, templateKey, placeholderValues);
    let pattern = escapeRegExp(template);
    for (const placeholderValue of Object.values(placeholderValues)) {
      pattern = pattern.replaceAll(escapeRegExp(placeholderValue), ".+?");
    }
    if (new RegExp(`^${pattern}$`).test(text)) {
      return true;
    }
  }
  return false;
}

export function annotateRecentMessageMetadataInContext(params: {
  simplifiedMessages: SimplifiedMessageForContext[];
  contextSegments: StructuredContextItem[];
  messageIdMap: MessageIdMap;
}): { annotatedCount: number; patchedReplyReferenceCount: number } {
  const metadataByMessageId = new Map<string, { inline: string; annotation: string }>();
  // Maps a dialogue turn's representative message ID (the entry's own `id`, which is
  // what context items carry) to the ordered list of original message IDs folded
  // into that turn. Merged turns expand to all constituents; plain turns map to one.
  const constituentIdsByEntryId = new Map<string, string[]>();
  for (const message of params.simplifiedMessages) {
    // Resolve the original messages folded into this entry. Merged entries carry
    //    combinedMessageIds + combinedCreatedAts (parallel arrays); plain entries
    //    fall back to their own id + createdAt.
    const isMerged = !!message.combinedMessageIds && message.combinedMessageIds.length > 0;
    const ids = isMerged ? (message.combinedMessageIds as string[]) : [message.id];
    const createdAts = isMerged
      ? (message.combinedCreatedAts ?? [])
      : message.createdAt !== undefined
        ? [message.createdAt]
        : [];

    const registeredIds: string[] = [];
    for (let i = 0; i < ids.length; i += 1) {
      const createdAt = createdAts[i];
      if (createdAt === undefined) continue;
      const messageRef = params.messageIdMap.register(ids[i], "ref");
      metadataByMessageId.set(ids[i], {
        inline: buildRecentMessageMetadataInline(createdAt),
        annotation: buildRecentMessageMetadataAnnotation(messageRef, createdAt),
      });
      registeredIds.push(ids[i]);
    }
    if (registeredIds.length > 0) {
      constituentIdsByEntryId.set(message.id, registeredIds);
    }
  }

  if (metadataByMessageId.size === 0) {
    return { annotatedCount: 0, patchedReplyReferenceCount: 0 };
  }

  let annotatedCount = 0;
  for (const contextItem of params.contextSegments) {
    if (contextItem.metadataTag !== ContextItemTag.DIALOGUE_HISTORY || !contextItem.messageId) {
      continue;
    }
    const constituentIds = constituentIdsByEntryId.get(contextItem.messageId);
    if (!constituentIds) {
      continue;
    }
    const textParts = contextItem.parts.filter(
      (part): part is Extract<StructuredContextItem["parts"][number], { type: "text" }> => part.type === "text",
    );
    if (textParts.some((part) => part.text.includes("[System: Message metadata: ref="))) {
      continue;
    }
    // Emit one metadata line per constituent message (in message order) so each
    //    original message in a merged turn still exposes its own ref_N handle and
    //    sent timestamp for manage_message / interact_with_recent_message.
    const annotationBlock = constituentIds
      .map((id) => metadataByMessageId.get(id)?.annotation)
      .filter((annotation): annotation is string => annotation !== undefined)
      .join("\n");
    if (!annotationBlock) {
      continue;
    }
    const targetTextPart = textParts.at(-1);
    if (targetTextPart) {
      targetTextPart.text = `${targetTextPart.text}\n${annotationBlock}`;
    } else {
      contextItem.parts.push({ type: "text", text: annotationBlock });
    }
    annotatedCount++;
  }

  const replyRefPattern = /\[System: This message \(ID: (ref_\d+)\).*previous message \(ID: (ref_\d+)\)/g;
  let patchedReplyReferenceCount = 0;
  for (const contextItem of params.contextSegments) {
    for (const part of contextItem.parts) {
      if (part.type !== "text" || !part.text.includes("previous message (ID: ref_")) {
        continue;
      }
      part.text = part.text.replace(replyRefPattern, (match, _replyRef: string, referencedRef: string) => {
        const referencedMessageId = params.messageIdMap.resolve(referencedRef);
        const metadata = referencedMessageId ? metadataByMessageId.get(referencedMessageId) : undefined;
        if (!metadata || match.includes(", sent ")) {
          return match;
        }
        patchedReplyReferenceCount++;
        return match.replace(`(ID: ${referencedRef})`, `(ID: ${referencedRef}, ${metadata.inline})`);
      });
    }
  }

  return { annotatedCount, patchedReplyReferenceCount };
}

export async function buildReplyReferenceContextAnnotation(params: {
  replyMessage: Message;
  referencedMessage: Message;
  clientUserId: string | undefined;
  botDisplayName: string | null | undefined;
  personaByNickname: Map<string, TomoriState>;
  serverDiscId: string;
  serverPersonalizationDisabled: boolean;
  messageIdMap: MessageIdMap;
}): Promise<string> {
  const replyAuthorName = await resolveMessageAuthorDisplayName({
    message: params.replyMessage,
    clientUserId: params.clientUserId,
    botDisplayName: params.botDisplayName,
    personaByNickname: params.personaByNickname,
    serverDiscId: params.serverDiscId,
    serverPersonalizationDisabled: params.serverPersonalizationDisabled,
  });
  const referencedAuthorName = await resolveMessageAuthorDisplayName({
    message: params.referencedMessage,
    clientUserId: params.clientUserId,
    botDisplayName: params.botDisplayName,
    personaByNickname: params.personaByNickname,
    serverDiscId: params.serverDiscId,
    serverPersonalizationDisabled: params.serverPersonalizationDisabled,
  });

  const replyRef = params.messageIdMap.register(params.replyMessage.id, "ref");
  const referencedRef = params.messageIdMap.register(params.referencedMessage.id, "ref");
  const referencedSummary = `${formatInlineSystemContent(params.referencedMessage.content)}${buildReplyReferenceAttachmentInfo(params.referencedMessage)}`;

  if (params.replyMessage.type === MessageType.ChannelPinnedMessage) {
    return `[System: ${replyAuthorName} pinned a previous message (ID: ${referencedRef}) by ${referencedAuthorName} saying: ${referencedSummary}]`;
  }

  return `[System: This message (ID: ${replyRef}) by ${replyAuthorName} is referring to a previous message (ID: ${referencedRef}) by ${referencedAuthorName} saying: ${referencedSummary}]`;
}

export async function buildReactionContextAnnotation(
  message: Message,
  budgetState: ReactionContextBudgetState,
  options?: {
    clientUserId?: string;
    mainPersonaNickname?: string | null;
  },
): Promise<string | null> {
  if (!REACTION_CONTEXT_ENABLED || REACTION_CONTEXT_MAX_REACTIONS_PER_MESSAGE < 1) {
    return null;
  }

  const availableReactions = Array.from(message.reactions.cache.values())
    .filter((reaction) => (reaction.count ?? 0) > 0)
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  if (availableReactions.length === 0) {
    return null;
  }

  budgetState.messagesWithReactions += 1;
  const selectedReactions = availableReactions.slice(0, REACTION_CONTEXT_MAX_REACTIONS_PER_MESSAGE);
  const reactionSegments: string[] = [];

  for (const reaction of selectedReactions) {
    const count = reaction.count ?? 0;
    const emojiLabel = normalizeReactionEmojiLabel(reaction);
    let segment = `${emojiLabel} x${count}`;

    if (count > 0 && REACTION_CONTEXT_MAX_USERS_PER_REACTION > 0) {
      if (budgetState.callsUsed < REACTION_CONTEXT_MAX_API_CALLS_PER_TURN) {
        try {
          budgetState.callsUsed += 1;
          const users = await reaction.users.fetch({ limit: REACTION_CONTEXT_MAX_USERS_PER_REACTION });
          const userLabels = Array.from(users.values())
            .map((user) => formatReactionUserLabel(user, options))
            .filter((label): label is string => label.length > 0);

          if (userLabels.length > 0) {
            segment += ` by ${userLabels.join(", ")}`;
            const remaining = Math.max(0, count - userLabels.length);
            if (remaining > 0) {
              segment += ` (+${remaining} more)`;
            }
          }
        } catch (error) {
          budgetState.fallbackCount += 1;
          log.warn(
            `Reaction context: Failed to fetch users for ${emojiLabel} on message ${message.id}. Using counts only.`,
            error,
          );
        }
      } else {
        budgetState.fallbackCount += 1;
        if (!budgetState.budgetExhaustedLogged) {
          budgetState.budgetExhaustedLogged = true;
          log.info(
            `Reaction context: User fetch budget exhausted (${budgetState.callsUsed}/${REACTION_CONTEXT_MAX_API_CALLS_PER_TURN}). Falling back to counts-only reactions.`,
          );
        }
      }
    }

    reactionSegments.push(segment);
  }

  const remainingReactionTypes = availableReactions.length - selectedReactions.length;
  if (remainingReactionTypes > 0) {
    reactionSegments.push(`+${remainingReactionTypes} more reaction type${remainingReactionTypes === 1 ? "" : "s"}`);
  }

  return reactionSegments.length > 0 ? `[System: Reactions on this message: ${reactionSegments.join("; ")}]` : null;
}

function parseBooleanEnvFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (typeof value !== "string") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  return defaultValue;
}

function buildRecentMessageMetadataInline(createdAt: number): string {
  return `sent ${formatTimestampInline(createdAt)}`;
}

function buildRecentMessageMetadataAnnotation(messageRef: string, createdAt: number): string {
  return `[System: Message metadata: ref=${messageRef} | ${buildRecentMessageMetadataInline(createdAt)}]`;
}

function buildReplyReferenceAttachmentInfo(message: Message): string {
  const attachments = Array.from(message.attachments.values());
  const imageCount = attachments.filter((attachment) => attachment.contentType?.startsWith("image/")).length;
  const videoCount = attachments.filter(
    (attachment) =>
      attachment.contentType && SUPPORTED_VIDEO_MIME_TYPES.some((type) => attachment.contentType?.startsWith(type)),
  ).length;
  return `${imageCount > 0 ? ` (with ${imageCount} image${imageCount > 1 ? "s" : ""})` : ""}${videoCount > 0 ? ` (with ${videoCount} video${videoCount > 1 ? "s" : ""})` : ""}`;
}

async function resolveMessageAuthorDisplayName(params: {
  message: Message;
  clientUserId: string | undefined;
  botDisplayName: string | null | undefined;
  personaByNickname: Map<string, TomoriState>;
  serverDiscId: string;
  serverPersonalizationDisabled: boolean;
}): Promise<string> {
  const webhookName = stripBridgePrefix(params.message.author.username);
  const renderModifierSource = params.message.webhookId
    ? resolveRenderModifierSourcePersona(webhookName, params.personaByNickname)
    : null;
  const matchedPersona = params.message.webhookId
    ? (renderModifierSource?.persona ?? params.personaByNickname.get(normalizeRenderModifierName(webhookName)))
    : undefined;
  const userRow =
    params.message.author.id !== params.clientUserId && !matchedPersona
      ? await getCachedUserRow(params.message.author.id)
      : null;
  const userBlacklisted =
    userRow !== null ? await getCachedBlacklistStatus(params.serverDiscId, params.message.author.id) : false;
  const fallbackName = resolvePreferredDiscordDisplayName({
    memberDisplayName: params.message.member?.displayName,
    user: params.message.author,
    fallback: webhookName,
  });

  if (params.message.author.id === params.clientUserId) {
    return params.botDisplayName || "Bot";
  }

  // Clean-named sprite messages carry no "(sprite)" suffix in the webhook name;
  // recover the decorated label from the persisted mapping.
  const spriteDisplayName =
    !renderModifierSource && matchedPersona
      ? await resolveSpriteMessageDisplayName(
          params.message.id,
          matchedPersona.persona_id,
          matchedPersona.persona_nickname,
        )
      : null;

  return (
    renderModifierSource?.displayName ??
    spriteDisplayName ??
    matchedPersona?.persona_nickname ??
    (userBlacklisted || params.serverPersonalizationDisabled || !userRow?.user_nickname
      ? fallbackName
      : userRow.user_nickname)
  );
}

function normalizeReactionEmojiLabel(reaction: MessageReaction): string {
  const emojiName = reaction.emoji.name;
  const emojiId = reaction.emoji.id;
  if (emojiId && emojiName) {
    return `:${emojiName}:`;
  }
  if (emojiName) {
    return emojiName;
  }
  return emojiId ? `<emoji:${emojiId}>` : "unknown_emoji";
}

function formatReactionUserLabel(
  user: { id: string; globalName: string | null; username: string },
  options?: {
    clientUserId?: string;
    mainPersonaNickname?: string | null;
  },
): string {
  if (options?.clientUserId && user.id === options.clientUserId && options.mainPersonaNickname?.trim()) {
    return options.mainPersonaNickname.trim();
  }
  return user.globalName || user.username;
}

export function formatInlineSystemContent(content: string | null | undefined): string {
  return content?.replace(/\s+/g, " ").trim() || "[System: No text content was included]";
}

// Turn-ephemeral `[System: …]` annotations the context builder injects into message
// text. They carry per-turn `ref_N` handles and message/channel IDs that are minted
// fresh each turn (see buildReplyReferenceContextAnnotation / buildRecentMessageMetadataAnnotation
// / buildReactionContextAnnotation and the provider media notices). Persisting them
// verbatim into durable stores (e.g. short-term memory) leaves stale handles that a
// later turn re-renders against a different messageIdMap: risking mis-targeted
// manage_message / interact_with_recent_message actions. Strip them before storing.
const INJECTED_CONTEXT_ANNOTATION_PATTERNS: RegExp[] = [
  // Reply-reference annotation AND media/GIF notices: "[System: This message (ID: …) …]"
  /\[System: This message \(ID: [^)]*\)[^\]]*\]/g,
  // Recent-message metadata: "[System: Message metadata: ref=… | …]"
  /\[System: Message metadata:[^\]]*\]/g,
  // Reaction context: "[System: Reactions on this message: …]"
  /\[System: Reactions on this message:[^\]]*\]/g,
];

/**
 * Removes injected, turn-ephemeral `[System: …]` annotations from message text so the
 * clean conversational content can be persisted (e.g. into short-term memory) without
 * stale per-turn `ref_N` handles or IDs leaking into future turns.
 *
 * @param content - Raw message text that may carry injected context annotations.
 * @returns The text with known injected annotations removed and blank lines collapsed.
 */
export function stripInjectedContextAnnotations(content: string): string {
  let cleaned = content;
  for (const pattern of INJECTED_CONTEXT_ANNOTATION_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }
  // Collapse trailing whitespace and blank lines left behind by removed annotations.
  return cleaned
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
