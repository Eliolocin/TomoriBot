import { describe, expect, it } from "bun:test";
import type { ButtonInteraction, Client } from "discord.js";
import {
  InteractionRouteRegistry,
  parseInteractionRoute,
  type GlobalInteractionRoute,
} from "@/utils/discord/interactions/routeRegistry";

function makeButton(customId: string): ButtonInteraction {
  return { customId } as unknown as ButtonInteraction;
}

describe("global interaction route registry", () => {
  it("parses a versioned custom ID without interpreting route state", () => {
    expect(parseInteractionRoute("help:v1:navigate:providers:api-keys")).toEqual({
      namespace: "help",
      version: "v1",
      segments: ["navigate", "providers", "api-keys"],
    });
  });

  it("leaves unrelated collector-owned interactions untouched", async () => {
    const route: GlobalInteractionRoute = {
      namespace: "help",
      version: "v1",
      execute: async () => {},
    };
    const registry = new InteractionRouteRegistry([route]);

    await expect(registry.dispatch({} as Client, makeButton("persona:picker:next"))).resolves.toBe(false);
  });

  it("dispatches a matching route exactly once", async () => {
    const seen: string[] = [];
    const route: GlobalInteractionRoute = {
      namespace: "help",
      version: "v1",
      execute: async (_client, _interaction, parsed) => {
        seen.push(parsed.segments.join(":"));
      },
    };
    const registry = new InteractionRouteRegistry([route]);

    await expect(registry.dispatch({} as Client, makeButton("help:v1:category:memory"))).resolves.toBe(true);
    expect(seen).toEqual(["category:memory"]);
  });

  it("rejects duplicate namespace and version registrations", () => {
    const route: GlobalInteractionRoute = {
      namespace: "help",
      version: "v1",
      execute: async () => {},
    };
    expect(() => new InteractionRouteRegistry([route, route])).toThrow("Duplicate global interaction route");
  });
});
