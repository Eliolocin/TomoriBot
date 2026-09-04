import { describe, expect, it } from "bun:test";
import type { Interaction } from "discord.js";
import { isGlobalRoutableInteraction } from "@/utils/discord/interactions/router";

function makeInteraction(
  kind: "button" | "string" | "channel" | "role" | "user" | "mentionable" | "modal" | "other",
): Interaction {
  return {
    isMessageComponent: () => ["button", "string", "channel", "role", "user", "mentionable"].includes(kind),
    isModalSubmit: () => kind === "modal",
  } as unknown as Interaction;
}

describe("global interaction router predicate", () => {
  it("admits every message component and modal without enumerating select types", () => {
    expect(isGlobalRoutableInteraction(makeInteraction("button"))).toBe(true);
    expect(isGlobalRoutableInteraction(makeInteraction("string"))).toBe(true);
    expect(isGlobalRoutableInteraction(makeInteraction("channel"))).toBe(true);
    expect(isGlobalRoutableInteraction(makeInteraction("role"))).toBe(true);
    expect(isGlobalRoutableInteraction(makeInteraction("user"))).toBe(true);
    expect(isGlobalRoutableInteraction(makeInteraction("mentionable"))).toBe(true);
    expect(isGlobalRoutableInteraction(makeInteraction("modal"))).toBe(true);
    expect(isGlobalRoutableInteraction(makeInteraction("other"))).toBe(false);
  });
});
