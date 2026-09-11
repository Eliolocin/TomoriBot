import { describe, expect, it } from "bun:test";
import type { Message } from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import { resolvePersonaForMessage, resolveReferencedWebhookTarget } from "@/utils/chat/webhookIdentity";

function persona(nickname: string, id: number): TomoriState {
  return {
    persona_id: id,
    persona_nickname: nickname,
  } as TomoriState;
}

function webhookMessage(username: string): Message {
  return {
    webhookId: "webhook_1",
    author: {
      username,
    },
  } as Message;
}

function directMessage(authorId: string): Message {
  return {
    webhookId: null,
    author: {
      id: authorId,
      username: "Tomori",
    },
  } as Message;
}

describe("resolveReferencedWebhookTarget", () => {
  it("routes replies to copied-render webhook names back to the source persona", () => {
    const ren = persona("Ren", 123);
    const personaByNickname = new Map([["ren", ren]]);

    const result = resolveReferencedWebhookTarget(webhookMessage("Ren (Obonya)"), personaByNickname, null);

    expect(result.replyPersona).toBe(ren);
    expect(result.impersonatedUserId).toBeNull();
  });
});

describe("resolvePersonaForMessage", () => {
  it("resolves bot-authored direct messages to the main persona", () => {
    const main = persona("Tomori", 1);
    const alter = persona("Ren", 2);
    alter.is_alter = true;

    expect(resolvePersonaForMessage(directMessage("bot_1"), [main, alter], "bot_1")).toBe(main);
  });

  it("resolves alter webhook messages by copied-render username", () => {
    const main = persona("Tomori", 1);
    const ren = persona("Ren", 2);
    ren.is_alter = true;

    expect(resolvePersonaForMessage(webhookMessage("Ren (Obonya)"), [main, ren], "bot_1")).toBe(ren);
  });

  it("ignores non-persona bridge webhook messages", () => {
    const ren = persona("Ren", 2);
    ren.is_alter = true;

    expect(resolvePersonaForMessage(webhookMessage("[Matrix|@ren:example.org] Ren"), [ren], "bot_1")).toBeNull();
  });
});
