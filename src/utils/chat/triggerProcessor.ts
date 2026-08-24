import type { Client, Message } from "discord.js";
import { DMChannel } from "discord.js";
import type { AssembledServerConfig, TomoriState } from "@/types/db/schema";
import { isMatrixBridgeWebhookUsername } from "@/utils/bridges";
import { normalizeRenderModifierName, resolveRenderModifierSourcePersona } from "@/utils/discord/renderModifierParser";
import { escapeRegExp, wrapWithWordBoundary } from "@/utils/text/processors/regexUtils";
import { normalizeTriggerWord } from "@/utils/text/triggerWords";

const NEVER_MATCH_REGEX = /a^/i;

/**
 * Creates a regex that matches a trigger word with "screaming" support.
 * Allows repeated letters, e.g. "Lilja" matches "Liiiljaaaa".
 */
function createScreamingRegex(trigger: string): RegExp {
  const normalizedTrigger = normalizeTriggerWord(trigger, { lowercase: false });
  if (!normalizedTrigger) {
    return NEVER_MATCH_REGEX;
  }

  let pattern = "";

  for (const char of normalizedTrigger) {
    if (/[a-zA-Z]/.test(char)) {
      pattern += `${char}+`;
    } else {
      pattern += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }

  return new RegExp(wrapWithWordBoundary(pattern), "iu");
}

function createDeliberateTriggerRegex(trigger: string): RegExp {
  const normalizedTrigger = normalizeTriggerWord(trigger, { lowercase: false });
  if (!normalizedTrigger) {
    return NEVER_MATCH_REGEX;
  }

  let pattern = "";

  for (const char of normalizedTrigger) {
    if (/[a-zA-Z]/.test(char)) {
      pattern += `${char}+`;
    } else if (/\s/.test(char)) {
      pattern += "\\s+";
    } else {
      pattern += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }

  return new RegExp(`@${pattern}`, "i");
}

export function getDeliberateTriggerMatch(content: string, trigger: string): RegExpMatchArray | null {
  const normalizedTrigger = normalizeTriggerWord(trigger, { lowercase: false });
  if (!normalizedTrigger) {
    return null;
  }

  const fullTriggerMatch = content.match(createDeliberateTriggerRegex(normalizedTrigger));
  if (fullTriggerMatch) {
    return fullTriggerMatch;
  }

  const firstTriggerWord = normalizedTrigger.split(/\s+/)[0]?.trim() ?? normalizedTrigger;
  if (!firstTriggerWord || firstTriggerWord === normalizedTrigger) {
    return null;
  }

  const isJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(normalizedTrigger);
  const hasFullTriggerMatch = isJapanese
    ? content.includes(normalizedTrigger)
    : createScreamingRegex(normalizedTrigger).test(content);
  if (!hasFullTriggerMatch) {
    return null;
  }

  return content.match(createDeliberateTriggerRegex(firstTriggerWord));
}

/**
 * Finds a persona trigger in already-sanitized text without applying deliberate
 * trigger mode. Context-reference discovery uses this so loading a public
 * profile cannot affect response routing.
 */
export function getTriggerFirstMatchIndexInContent(content: string, trigger: string, deliberateOnly = false): number {
  const normalizedTrigger = normalizeTriggerWord(trigger, { lowercase: false });
  if (!normalizedTrigger) {
    return Number.POSITIVE_INFINITY;
  }

  if (normalizedTrigger.startsWith("<@")) {
    const userId = normalizedTrigger.replace(/[<@!>]/g, "");
    const mentionPattern = new RegExp(`<@!?${escapeRegExp(userId)}>`);
    const mentionMatch = content.match(mentionPattern);
    return mentionMatch?.index ?? Number.POSITIVE_INFINITY;
  }

  if (deliberateOnly) {
    const deliberateMatch = getDeliberateTriggerMatch(content, normalizedTrigger);
    return deliberateMatch?.index ?? Number.POSITIVE_INFINITY;
  }

  const isJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(normalizedTrigger);
  if (isJapanese) {
    const index = content.indexOf(normalizedTrigger);
    return index >= 0 ? index : Number.POSITIVE_INFINITY;
  }

  const match = content.match(createScreamingRegex(normalizedTrigger));
  return match?.index ?? Number.POSITIVE_INFINITY;
}

export function getTriggerFirstMatchIndex(message: Message, trigger: string, deliberateOnly = false): number {
  const normalizedTrigger = normalizeTriggerWord(trigger, { lowercase: false });
  if (!normalizedTrigger) {
    return Number.POSITIVE_INFINITY;
  }

  if (normalizedTrigger.startsWith("<@")) {
    const userId = normalizedTrigger.replace(/[<@!>]/g, "");
    if (!message.mentions.users.has(userId)) {
      return Number.POSITIVE_INFINITY;
    }
    const contentMatchIndex = getTriggerFirstMatchIndexInContent(message.content, normalizedTrigger, deliberateOnly);
    return contentMatchIndex === Number.POSITIVE_INFINITY ? Number.MAX_SAFE_INTEGER : contentMatchIndex;
  }

  return getTriggerFirstMatchIndexInContent(message.content, normalizedTrigger, deliberateOnly);
}

export function doesMessageMatchTrigger(message: Message, trigger: string, deliberateOnly = false): boolean {
  return getTriggerFirstMatchIndex(message, trigger, deliberateOnly) !== Number.POSITIVE_INFINITY;
}

export function isMatrixRelayMessage(message: Pick<Message, "webhookId" | "author">): boolean {
  return Boolean(message.webhookId) && isMatrixBridgeWebhookUsername(message.author.username);
}

export function isRealUserLikeMessage(message: Message): boolean {
  return (!message.author.bot && !message.webhookId) || isMatrixRelayMessage(message);
}

export function isSelfTriggerMessage(message: Message, allPersonas: TomoriState[]): boolean {
  if (message.interaction) return false;

  const clientUserId = message.client.user?.id;
  if (clientUserId && message.author.id === clientUserId) {
    return true;
  }

  if (!message.webhookId) {
    return false;
  }

  const authorName = message.author.username?.toLowerCase();
  if (!authorName) return false;

  const personaByNickname = new Map<string, TomoriState>();
  for (const persona of allPersonas) {
    const nicknameKey = persona.persona_nickname ? normalizeRenderModifierName(persona.persona_nickname) : "";
    if (nicknameKey && !personaByNickname.has(nicknameKey)) {
      personaByNickname.set(nicknameKey, persona);
    }
  }

  return Boolean(
    resolveRenderModifierSourcePersona(message.author.username, personaByNickname) ??
      personaByNickname.get(normalizeRenderModifierName(authorName)),
  );
}

export function getAutochatRange(config: AssembledServerConfig): {
  minThreshold: number;
  maxThreshold: number;
} {
  const minThreshold = Math.max(config.autoch_threshold ?? 0, 0);
  if (minThreshold === 0) {
    return { minThreshold: 0, maxThreshold: 0 };
  }

  const rawMaxThreshold = Math.max(config.autoch_threshold_max ?? 0, 0);
  return {
    minThreshold,
    maxThreshold: rawMaxThreshold > 0 ? Math.max(rawMaxThreshold, minThreshold) : minThreshold,
  };
}

export function isAutochatConfiguredChannel(config: AssembledServerConfig, channelId: string): boolean {
  return config.autoch_disc_ids.length > 0 && config.autoch_disc_ids.includes(channelId);
}

export function getAutochatAssignedPersonaId(config: AssembledServerConfig, channelId: string): number | null {
  const assignedPersona = config.autoch_persona_overrides.find((entry) => entry.channel_disc_id === channelId);
  return assignedPersona?.persona_id ?? null;
}

export function isAutochatQualifyingMessage(message: Message, isSelfMessage: boolean): boolean {
  return !isSelfMessage && isRealUserLikeMessage(message) && !(message.channel instanceof DMChannel);
}

export function isAutochatCounterChannelActive(config: AssembledServerConfig, channelId: string): boolean {
  const { minThreshold, maxThreshold } = getAutochatRange(config);
  return minThreshold > 0 && maxThreshold > 0 && isAutochatConfiguredChannel(config, channelId);
}

export function isAutochatAlwaysReplyChannelActive(config: AssembledServerConfig, channelId: string): boolean {
  const { minThreshold, maxThreshold } = getAutochatRange(config);
  return minThreshold === 0 && maxThreshold === 0 && isAutochatConfiguredChannel(config, channelId);
}

export function isAutochatOverrideChannel(config: AssembledServerConfig, channelId: string): boolean {
  return (config.always_reply_enabled ?? false) || isAutochatConfiguredChannel(config, channelId);
}

export function isAutochatCounterHit(tomoriState: TomoriState, channelId: string): boolean {
  if (!isAutochatCounterChannelActive(tomoriState.config, channelId)) {
    return false;
  }

  return (
    tomoriState.autoch_counter > 0 &&
    tomoriState.autoch_next_target > 0 &&
    tomoriState.autoch_counter >= tomoriState.autoch_next_target
  );
}

/**
 * Checks whether a message contains an explicit trigger pointing to a persona
 * other than the currently active one. Used during follow-up admission to detect
 * cross-persona intent before the full turn planner runs.
 *
 * Covers all three explicit-trigger signal paths:
 * 1. Trigger words matching a different persona
 * 2. Bot mention or reply-to-bot message → main persona
 * 3. Reply to a webhook persona message → that persona
 *
 * @param message - The incoming Discord message
 * @param allPersonas - All known personas for this server
 */
export function hasExplicitCrossPersonaTrigger(
  message: Message,
  allPersonas: TomoriState[],
  activePersonaId: number,
): boolean {
  const mainPersona = allPersonas.find((p) => !p.is_alter);

  const personaByNickname = new Map<string, TomoriState>();
  for (const persona of allPersonas) {
    const key = persona.persona_nickname ? normalizeRenderModifierName(persona.persona_nickname) : "";
    if (key && !personaByNickname.has(key)) personaByNickname.set(key, persona);
  }

  const clientUserId = message.client.user?.id;

  const isBotMentioned = clientUserId ? message.mentions.users.has(clientUserId) : false;
  const refMessage = message.reference?.messageId
    ? message.channel.messages.cache.get(message.reference.messageId)
    : undefined;
  const isReplyToBot = refMessage ? refMessage.author.id === clientUserId : false;
  if ((isBotMentioned || isReplyToBot) && mainPersona?.persona_id !== activePersonaId) {
    return true;
  }

  if (refMessage?.webhookId) {
    const webhookPersona =
      resolveRenderModifierSourcePersona(refMessage.author.username, personaByNickname)?.persona ??
      personaByNickname.get(normalizeRenderModifierName(refMessage.author.username));
    if (webhookPersona && webhookPersona.persona_id !== activePersonaId) {
      return true;
    }
  }

  for (const persona of allPersonas) {
    if (persona.persona_id === activePersonaId) continue;
    const triggers = persona.trigger_words ?? [];
    if (triggers.some((trigger) => doesMessageMatchTrigger(message, trigger))) {
      return true;
    }
  }

  return false;
}

export function determineMatchingPersonas(
  message: Message,
  allPersonas: TomoriState[],
  client: Client,
  isReplyToBot: boolean,
  replyPersona: TomoriState | null,
  isBotMentioned: boolean,
  isAutoMsgHit: boolean,
  isAlwaysReply = false,
  autoTriggerPersonaId?: number | null,
  alwaysReplyFallbackPersonaId?: number | null,
  deliberateTriggerMode = false,
  isAutochatDtmExemptChannel = false,
  allowedPersonaIds?: ReadonlySet<number> | null,
): TomoriState[] {
  const mainPersona = allPersonas.find((persona) => !persona.is_alter);
  const resolveFallbackPersona = (personaId?: number | null): TomoriState | undefined =>
    (personaId ? allPersonas.find((persona) => persona.persona_id === personaId) : undefined) ?? mainPersona;
  const isPersonaAllowed = (persona?: TomoriState | null): persona is TomoriState =>
    Boolean(
      persona &&
        (!allowedPersonaIds || (typeof persona.persona_id === "number" && allowedPersonaIds.has(persona.persona_id))),
    );

  const forcedPersonas: TomoriState[] = [];
  const forcedPersonaIds = new Set<number>();
  const addForcedPersona = (persona?: TomoriState | null): void => {
    if (!isPersonaAllowed(persona)) {
      return;
    }
    if (typeof persona.persona_id === "number" && forcedPersonaIds.has(persona.persona_id)) {
      return;
    }
    if (typeof persona.persona_id !== "number" && forcedPersonas.includes(persona)) {
      return;
    }
    forcedPersonas.push(persona);
    if (typeof persona.persona_id === "number") {
      forcedPersonaIds.add(persona.persona_id);
    }
  };

  addForcedPersona(replyPersona);
  if (isReplyToBot || isBotMentioned) {
    addForcedPersona(mainPersona);
  }

  if (isAutoMsgHit && forcedPersonas.length === 0) {
    const autoTriggerPersona = resolveFallbackPersona(autoTriggerPersonaId);
    return isPersonaAllowed(autoTriggerPersona) ? [autoTriggerPersona] : [];
  }

  let senderPersona: TomoriState | undefined;
  const personaByNickname = new Map<string, TomoriState>();
  for (const persona of allPersonas) {
    const nicknameKey = persona.persona_nickname ? normalizeRenderModifierName(persona.persona_nickname) : "";
    if (!nicknameKey || personaByNickname.has(nicknameKey)) continue;
    personaByNickname.set(nicknameKey, persona);
  }
  if (message.webhookId) {
    const webhookName = message.author.username;
    senderPersona =
      resolveRenderModifierSourcePersona(webhookName, personaByNickname)?.persona ??
      personaByNickname.get(normalizeRenderModifierName(webhookName));
  } else if (message.author.id === client.user?.id) {
    senderPersona = allPersonas.find((persona) => !persona.is_alter);
  }

  let repliedToPersona: TomoriState | undefined;
  if (message.reference?.messageId) {
    const referenceMessage = message.channel.messages.cache.get(message.reference.messageId);
    if (referenceMessage) {
      if (referenceMessage.author.id === client.user?.id) {
        repliedToPersona = allPersonas.find((persona) => !persona.is_alter);
      } else if (referenceMessage.webhookId) {
        const webhookName = referenceMessage.author.username;
        repliedToPersona =
          resolveRenderModifierSourcePersona(webhookName, personaByNickname)?.persona ??
          personaByNickname.get(normalizeRenderModifierName(webhookName));
      }
    }
  }

  const matchingPersonas: Array<{
    persona: TomoriState;
    firstMatchIndex: number;
    insertionOrder: number;
  }> = [];

  for (const [insertionOrder, persona] of allPersonas.entries()) {
    if (!isPersonaAllowed(persona)) {
      continue;
    }

    if (senderPersona && persona.persona_id === senderPersona.persona_id) {
      continue;
    }
    if (repliedToPersona && persona.persona_id === repliedToPersona.persona_id) {
      continue;
    }
    if (typeof persona.persona_id === "number" && forcedPersonaIds.has(persona.persona_id)) {
      continue;
    }

    const config = persona.config;
    if (!config) continue;

    const triggers = persona.trigger_words ?? [];

    let hasMatch = false;
    let firstMatchIndex = Number.MAX_SAFE_INTEGER;

    for (const trigger of triggers) {
      const isPersonaDtmExempt =
        isAutochatDtmExemptChannel &&
        (autoTriggerPersonaId === null ? !persona.is_alter : autoTriggerPersonaId === persona.persona_id);
      const matchIndex = getTriggerFirstMatchIndex(message, trigger, deliberateTriggerMode && !isPersonaDtmExempt);
      if (matchIndex !== Number.POSITIVE_INFINITY) {
        hasMatch = true;
        if (matchIndex < firstMatchIndex) {
          firstMatchIndex = matchIndex;
        }
      }
    }

    if (hasMatch) {
      matchingPersonas.push({
        persona,
        firstMatchIndex,
        insertionOrder,
      });
    }
  }

  matchingPersonas.sort((a, b) => {
    if (a.firstMatchIndex !== b.firstMatchIndex) {
      return a.firstMatchIndex - b.firstMatchIndex;
    }
    return a.insertionOrder - b.insertionOrder;
  });

  const result = [...forcedPersonas, ...matchingPersonas.map((entry) => entry.persona)];

  if (isAlwaysReply && result.length === 0) {
    const fallbackPersona = resolveFallbackPersona(alwaysReplyFallbackPersonaId);
    if (isPersonaAllowed(fallbackPersona)) {
      return [fallbackPersona];
    }
  }

  return result;
}
