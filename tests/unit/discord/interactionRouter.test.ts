import { describe, expect, it, spyOn } from "bun:test";
import type { Client, Interaction } from "discord.js";
import { dispatchGlobalInteraction, isGlobalRoutableInteraction } from "@/utils/discord/interactions/router";
import type { GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";

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

describe("retired panel namespaces", () => {
  it("leaves legacy MCP and ST preset controls unmatched without replying", async () => {
    for (const customId of ["mcps:v1:retry:en-US:none", "st-presets:v1:retry:en-US"]) {
      const interaction = {
        id: `retired-${customId}`,
        customId,
        locale: "en-US",
        guildLocale: "en-US",
        user: { id: "user-1" },
        replied: false,
        deferred: false,
        reply: async () => {},
      } as unknown as GlobalRoutableInteraction;
      const replySpy = spyOn(interaction, "reply");

      await expect(dispatchGlobalInteraction({} as Client, interaction)).resolves.toBe(false);
      expect(replySpy).not.toHaveBeenCalled();

      replySpy.mockRestore();
    }
  });
});
