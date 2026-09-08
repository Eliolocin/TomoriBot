import { describe, expect, it } from "bun:test";
import type { Client } from "discord.js";
import { CommandRegistry } from "@/utils/discord/commandRegistry";

function createClientWithCommands(commands: Map<string, { name: string }>): Client {
  return {
    application: {
      commands: {
        fetch: async () => commands,
      },
    },
  } as unknown as Client;
}

describe("CommandRegistry", () => {
  it("keeps normal references inline and supports explicit clickable mentions", async () => {
    const registry = new CommandRegistry();
    const commands = new Map([["987654321012345678", { name: "config" }]]);

    expect(registry.getCommandMention("config")).toBe("`/config`");
    expect(registry.getCommandMention("unknown")).toBe("`/unknown`");
    expect(registry.getCommandMention("config", undefined, undefined, true)).toBe("`/config`");
    expect(registry.getCommandMention("unknown", undefined, undefined, true)).toBe("`/unknown`");

    await registry.initialize(createClientWithCommands(commands));

    expect(registry.getCommandMention("config")).toBe("`/config`");
    expect(registry.getCommandMention("config", undefined, undefined, true)).toBe("</config:987654321012345678>");
    expect(registry.getCommandMention("unknown")).toBe("`/unknown`");
    expect(registry.getCommandMention("unknown", undefined, undefined, true)).toBe("`/unknown`");
  });
});
