import type { Client, Message } from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import type { ChatIncoming } from "@/utils/chat/types";
import { doesMessageMatchTrigger } from "@/utils/chat/triggerProcessor";
import { normalizeRenderModifierName, resolveRenderModifierSourcePersona } from "@/utils/discord/renderModifierParser";
import { escapeRegExp, wrapWithWordBoundary } from "@/utils/text/processors/regexUtils";

export const BASE_TRIGGER_WORDS: readonly string[] = process.env.BASE_TRIGGER_WORDS?.split(",")
  .map((word) => word.trim())
  .filter((word) => word.length > 0) || ["tomori", "tomo", "トモリ", "ともり"];

export function isBaseTriggerWordMatch(content: string): boolean {
  for (const baseWord of BASE_TRIGGER_WORDS) {
    if (/[\u3040-\u30FF\u4E00-\u9FFF]/.test(baseWord)) {
      if (content.includes(baseWord)) {
        return true;
      }
    } else if (new RegExp(wrapWithWordBoundary(escapeRegExp(baseWord)), "iu").test(content)) {
      return true;
    }
  }
  return false;
}

function hasPersonaTriggerMatch(message: Message, allPersonas: readonly TomoriState[]): boolean {
  return allPersonas.some((persona) =>
    (persona.trigger_words ?? []).some((trigger) => doesMessageMatchTrigger(message, trigger)),
  );
}

function isCachedReplyToKnownPersona(message: Message, client: Client, allPersonas: readonly TomoriState[]): boolean {
  if (!message.reference?.messageId || !("messages" in message.channel)) {
    return false;
  }

  const referencedMessage = message.channel.messages.cache.get(message.reference.messageId);
  if (!referencedMessage) {
    return false;
  }

  if (referencedMessage.author.id === client.user?.id) {
    return true;
  }

  if (!referencedMessage.webhookId) {
    return false;
  }

  const referencedWebhookName = referencedMessage.author.username;
  const personaByNickname = new Map<string, TomoriState>();
  for (const persona of allPersonas) {
    const nicknameKey = persona.persona_nickname ? normalizeRenderModifierName(persona.persona_nickname) : "";
    if (nicknameKey && !personaByNickname.has(nicknameKey)) {
      personaByNickname.set(nicknameKey, persona);
    }
  }

  return Boolean(
    resolveRenderModifierSourcePersona(referencedWebhookName, personaByNickname) ??
      personaByNickname.get(normalizeRenderModifierName(referencedWebhookName)),
  );
}

function hasDirectChatSignal(args: {
  client: Client;
  message: Message;
  allPersonas: readonly TomoriState[];
  isReplyToBotOrPersona?: boolean;
  isBotMentioned?: boolean;
}): boolean {
  if (args.isBotMentioned || (args.client.user && args.message.mentions.users.has(args.client.user.id))) {
    return true;
  }

  if (args.isReplyToBotOrPersona || isCachedReplyToKnownPersona(args.message, args.client, args.allPersonas)) {
    return true;
  }

  if (isBaseTriggerWordMatch(args.message.content)) {
    return true;
  }

  return hasPersonaTriggerMatch(args.message, args.allPersonas);
}

export function shouldSurfaceChatUserErrors(args: {
  incoming: ChatIncoming;
  client: Client;
  message: Message;
  isDMChannel: boolean;
  allPersonas: readonly TomoriState[];
  isReplyToBotOrPersona?: boolean;
  isBotMentioned?: boolean;
}): boolean {
  if (typeof args.incoming.shouldSurfaceUserErrors === "boolean") {
    return args.incoming.shouldSurfaceUserErrors;
  }

  if (
    args.incoming.manualTriggerInvoker ||
    args.incoming.reminderRecipientID ||
    args.incoming.reminderData?.self_reminder ||
    args.incoming.isStopResponse
  ) {
    return true;
  }

  if (args.isDMChannel && args.message.author.id !== args.client.user?.id) {
    return true;
  }

  return hasDirectChatSignal(args);
}
