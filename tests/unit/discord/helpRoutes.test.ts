import { beforeAll, describe, expect, it } from "bun:test";
import {
  ComponentType,
  type ActionRowData,
  type ButtonInteraction,
  type Client,
  type ComponentInContainerData,
  type ContainerComponentData,
  type ModalSubmitInteraction,
  type StringSelectMenuComponentData,
  type StringSelectMenuInteraction,
  type TopLevelComponentData,
} from "discord.js";
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
      segments: ["category", "ja", "features"],
    });

    expect(payload).toContain("機能");
    expect(payload).toContain("help:v2:page:ja:features");
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

  it("navigates to a specific subsection and marks it default in the select menu", async () => {
    let capturedPayload: unknown;
    const interaction = {
      locale: "en-US",
      guildLocale: "en-US",
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      update: async (nextPayload: unknown) => {
        capturedPayload = nextPayload;
      },
    } as unknown as ButtonInteraction;

    await helpInteractionRoute.execute({} as Client, interaction, {
      namespace: "help",
      version: "v2",
      segments: ["navigate", "en-US", "features", "media-generation", "speech-generation"],
    });

    expect(capturedPayload).toBeDefined();
    const container = (capturedPayload as { components: TopLevelComponentData[] })
      .components[0] as ContainerComponentData<ComponentInContainerData>;
    const variantRow = container.components.find(
      (comp) =>
        comp.type === ComponentType.ActionRow &&
        "components" in comp &&
        comp.components.some(
          (child) =>
            child.type === ComponentType.StringSelect && "customId" in child && child.customId?.includes(":variant:"),
        ),
    ) as ActionRowData<StringSelectMenuComponentData> | undefined;

    expect(variantRow).toBeDefined();
    const selectMenu = variantRow?.components[0];
    const speechOption = selectMenu?.options.find((opt) => opt.value === "speech-generation");
    expect(speechOption).toBeDefined();
    expect(speechOption?.default).toBe(true);
  });

  it("throws when navigate targets a nonexistent subsection", async () => {
    const interaction = {
      locale: "en-US",
      guildLocale: "en-US",
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      update: async () => {},
    } as unknown as ButtonInteraction;

    await expect(
      helpInteractionRoute.execute({} as Client, interaction, {
        namespace: "help",
        version: "v2",
        segments: ["navigate", "en-US", "features", "media-generation", "nonexistent-variant"],
      }),
    ).rejects.toThrow("Invalid help navigation target");
  });
});
