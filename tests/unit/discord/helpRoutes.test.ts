import { beforeAll, describe, expect, it } from "bun:test";
import type { ButtonInteraction, Client, ModalSubmitInteraction, StringSelectMenuInteraction } from "discord.js";
import { helpInteractionRoute } from "@/utils/discord/interactions/helpRoutes";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => {
  await initializeLocalizer();
});

describe("help global interaction route", () => {
  it("preserves the panel locale carried by the custom ID", async () => {
    let payload = "";
    const interaction = {
      locale: "en-US",
      guildLocale: "en-US",
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      update: async (nextPayload: unknown) => {
        payload = JSON.stringify(nextPayload);
      },
    } as unknown as ButtonInteraction;

    await helpInteractionRoute.execute({} as Client, interaction, {
      namespace: "help",
      version: "v2",
      segments: ["category", "ja", "memory"],
    });

    expect(payload).toContain("永続メモリ");
    expect(payload).toContain("help:v2:page:ja:memory");
  });

  it("opens a provider modal as the select interaction's only acknowledgement", async () => {
    const calls: string[] = [];
    const interaction = {
      locale: "en-US",
      guildLocale: null,
      values: ["openrouter"],
      isButton: () => false,
      isStringSelectMenu: () => true,
      isModalSubmit: () => false,
      showModal: async () => {
        calls.push("showModal");
      },
      update: async () => {
        calls.push("update");
      },
      deferUpdate: async () => {
        calls.push("deferUpdate");
      },
    } as unknown as StringSelectMenuInteraction;

    await helpInteractionRoute.execute({} as Client, interaction, {
      namespace: "help",
      version: "v2",
      segments: ["provider", "en-US"],
    });

    expect(calls).toEqual(["showModal"]);
  });

  it("silently acknowledges an information-modal submission without repainting the panel", async () => {
    const calls: string[] = [];
    const interaction = {
      locale: "en-US",
      guildLocale: null,
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      deferUpdate: async () => {
        calls.push("deferUpdate");
      },
      update: async () => {
        calls.push("update");
      },
    } as unknown as ModalSubmitInteraction;

    await helpInteractionRoute.execute({} as Client, interaction, {
      namespace: "help",
      version: "v2",
      segments: ["provider-modal", "en-US", "openrouter"],
    });

    expect(calls).toEqual(["deferUpdate"]);
  });
});
