import { beforeAll, describe, expect, it } from "bun:test";
import {
  ComponentType,
  MessageFlags,
  type Client,
  type ComponentInContainerData,
  type ContainerComponentData,
  type StringSelectMenuComponentData,
} from "discord.js";
import { HELP_CATEGORIES } from "@/utils/discord/helpCatalog";
import { HELP_PROVIDER_IDS } from "@/utils/discord/helpProviderGuides";
import { commandRegistry } from "@/utils/discord/commandRegistry";
import {
  buildHelpDashboardPayload,
  buildHelpStops,
  buildProviderGuideModal,
  resolveHelpSelection,
} from "@/utils/discord/ui/helpDashboard";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";

beforeAll(async () => {
  await initializeLocalizer();
  const commands = new Map([["987654321012345678", { name: "config" }]]);
  const client = {
    application: {
      commands: {
        fetch: async () => commands,
      },
    },
  } as unknown as Client;
  await commandRegistry.initialize(client);
});

function getContainer(
  locale: string,
  categoryId: string,
  pageId: string,
  variantId?: string,
): ContainerComponentData<ComponentInContainerData> {
  const payload = buildHelpDashboardPayload(locale, categoryId, pageId, variantId);
  expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
  expect(payload.components).toHaveLength(2);
  return payload.components[0] as ContainerComponentData<ComponentInContainerData>;
}

describe("help dashboard", () => {
  it("renders every planned page in both locales without unresolved help keys", () => {
    for (const locale of ["en-US", "ja"]) {
      for (const category of HELP_CATEGORIES) {
        for (const page of category.pages) {
          const serialized = JSON.stringify(getContainer(locale, category.id, page.id));
          expect(serialized).not.toContain("commands.help.");
          for (const variant of page.variants ?? []) {
            const variantSerialized = JSON.stringify(
              buildHelpDashboardPayload(locale, category.id, page.id, variant.id),
            );
            expect(variantSerialized).not.toContain("commands.help.");
          }
        }
      }
    }
  });

  it("asserts exactly 4 categories, 14 sections, and 17 subsections across the catalog", () => {
    expect(HELP_CATEGORIES.map((c) => c.id)).toEqual(["setup", "features", "moderation", "plugins"]);

    const totalPages = HELP_CATEGORIES.flatMap((c) => c.pages);
    expect(totalPages).toHaveLength(14);

    const totalSubsections = totalPages.flatMap((p) => p.variants ?? []);
    expect(totalSubsections).toHaveLength(17);

    const container = getContainer("en-US", "setup", "personal-profile");
    const categoryRow = container.components[0];
    expect(categoryRow.type).toBe(ComponentType.ActionRow);
    expect("components" in categoryRow ? categoryRow.components : []).toHaveLength(4);
    expect(container.accentColor).toBe(0x65c6c5);
    expect(getContainer("en-US", "features", "multiple-personas").accentColor).toBe(0x65c6c5);
  });

  it("ensures every section and subsection select option has a non-empty description <= 100 characters in length", () => {
    for (const locale of ["en-US", "ja"]) {
      for (const category of HELP_CATEGORIES) {
        for (const page of category.pages) {
          const variants = page.variants ?? [undefined];
          for (const variant of variants) {
            const payload = buildHelpDashboardPayload(locale, category.id, page.id, variant?.id);
            const container = payload.components[0] as ContainerComponentData<ComponentInContainerData>;

            for (const comp of container.components) {
              if (comp.type === ComponentType.ActionRow && "components" in comp) {
                for (const child of comp.components) {
                  if (child.type === ComponentType.StringSelect) {
                    const select = child as StringSelectMenuComponentData;
                    for (const option of select.options) {
                      expect(option.description).toBeDefined();
                      expect(typeof option.description).toBe("string");
                      expect(option.description?.length).toBeGreaterThan(0);
                      expect(option.description?.length).toBeLessThanOrEqual(100);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  });

  it("renders documentation and support as link buttons below the container and sets active subsection docs URL", () => {
    const comfyPayload = buildHelpDashboardPayload("en-US", "setup", "custom-endpoints", "comfyui");
    const comfyFooter = comfyPayload.components.at(-1);
    expect(comfyFooter?.type).toBe(ComponentType.ActionRow);
    const comfyButtons = comfyFooter && "components" in comfyFooter ? comfyFooter.components : [];
    expect(comfyButtons).toHaveLength(2);
    expect(JSON.stringify(comfyButtons)).toContain("Read the Web Version");
    expect(JSON.stringify(comfyButtons)).toContain(
      "https://docs.tomoribot.app/self-hosting/local-endpoints/setup-comfyui/",
    );
    expect(JSON.stringify(comfyButtons)).toContain("Get Technical Support");
    expect(JSON.stringify(comfyButtons)).toContain("discord.gg/bjCfHm9QsB");

    const personasPayload = buildHelpDashboardPayload("en-US", "features", "multiple-personas");
    const personasFooter = personasPayload.components.at(-1);
    const personasButtons = personasFooter && "components" in personasFooter ? personasFooter.components : [];
    expect(JSON.stringify(personasButtons)).toContain(
      "https://docs.tomoribot.app/features/chatting-personality/multiple-personas/",
    );
  });

  it("renders contextual endpoint and engine guides without changing the top-level page map", () => {
    const comfyUi = JSON.stringify(buildHelpDashboardPayload("en-US", "setup", "custom-endpoints", "comfyui"));
    const speech = JSON.stringify(
      buildHelpDashboardPayload("en-US", "features", "media-generation", "speech-generation"),
    );

    expect(comfyUi).toContain("ComfyUI");
    expect(comfyUi).toContain("/self-hosting/local-endpoints/setup-comfyui/");
    expect(speech).toContain("Speech Generation");
    expect(speech).toContain("help:v2:variant:en-US:features:media-generation");
  });

  it("renders clickable config mentions on every absorbed-command help page", () => {
    const expectedMention = "</config:987654321012345678>";
    const pages: [string, string, string?][] = [
      ["features", "multiple-personas"],
      ["features", "tons-of-tweakability"],
      ["features", "memory", "short-term-memory"],
      ["plugins", "sillytavern-presets"],
      ["plugins", "mcp-servers"],
    ];

    for (const [categoryId, pageId, variantId] of pages) {
      const serialized = JSON.stringify(buildHelpDashboardPayload("en-US", categoryId, pageId, variantId));
      expect(serialized).toContain(expectedMention);
      expect(serialized).not.toContain("</config:0>");
      expect(serialized).not.toContain("`/config`");
    }
  });

  it("falls back to setup > personal-profile for invalid external state", () => {
    const selection = resolveHelpSelection("unknown", "also-unknown");
    expect(selection.category.id).toBe("setup");
    expect(selection.page.id).toBe("personal-profile");
    expect(selection.variant).toBeUndefined();
  });

  it("builds text-only provider modals with persistent route IDs", () => {
    for (const providerId of HELP_PROVIDER_IDS) {
      const modal = buildProviderGuideModal("en-US", providerId).toJSON();
      expect(modal.custom_id).toBe(`help:v2:provider-modal:en-US:${providerId}`);
      expect(modal.components.length).toBeGreaterThan(0);
      expect(modal.components.length).toBeLessThanOrEqual(5);
      expect(modal.components.every((component) => component.type === ComponentType.TextDisplay)).toBe(true);
    }
  });

  it("renders the page header and subsection header when a variant is active", () => {
    const pageTitle = localizer("en-US", "commands.help.dashboard.sections.custom_endpoints");
    const variantTitle = localizer("en-US", "commands.help.dashboard.subsections.comfyui");
    expect(pageTitle).not.toBe(variantTitle);

    const payload = buildHelpDashboardPayload("en-US", "setup", "custom-endpoints", "comfyui");
    const container = payload.components[0] as ContainerComponentData<ComponentInContainerData>;
    const serialized = JSON.stringify(payload);

    expect(serialized).toContain(pageTitle);
    expect(serialized).toContain(variantTitle);

    const variantHeading = container.components.find(
      (comp) =>
        comp.type === ComponentType.TextDisplay && "content" in comp && comp.content.startsWith(`### ${variantTitle}`),
    );
    expect(variantHeading).toBeDefined();
  });

  it("renders all page sections and footer when a page has no variants", () => {
    const container = getContainer("en-US", "features", "multiple-personas");
    const serialized = JSON.stringify(container);

    expect(serialized).toContain(localizer("en-US", "commands.help.multiple_personas.mains_alters_title"));
    expect(serialized).toContain(localizer("en-US", "commands.help.multiple_personas.bringing_in_title"));
    expect(serialized).toContain(localizer("en-US", "commands.help.multiple_personas.where_to_find_title"));
    expect(serialized).toContain(localizer("en-US", "commands.help.multiple_personas.talking_title"));
    expect(serialized).toContain("Share one of your own with `/persona export`");
  });

  it("derives the flattened stop count for each category from the catalog", () => {
    for (const category of HELP_CATEGORIES) {
      const stops = buildHelpStops(category);
      const expectedCount = category.pages.reduce((sum, page) => sum + Math.max(1, page.variants?.length ?? 0), 0);
      expect(stops).toHaveLength(expectedCount);
    }
  });

  it("steps across the page boundary from the last personal-profile variant to the first custom-endpoints variant", () => {
    const setupCategory = HELP_CATEGORIES.find((candidate) => candidate.id === "setup");
    const personalProfilePage = setupCategory?.pages.find((candidate) => candidate.id === "personal-profile");
    const customEndpointsPage = setupCategory?.pages.find((candidate) => candidate.id === "custom-endpoints");

    const lastPersonalVariant = personalProfilePage?.variants?.at(-1);
    const firstCustomVariant = customEndpointsPage?.variants?.[0];

    if (!setupCategory || !personalProfilePage || !customEndpointsPage || !lastPersonalVariant || !firstCustomVariant) {
      throw new Error("Missing expected setup catalog entries");
    }

    const payload = buildHelpDashboardPayload(
      "en-US",
      setupCategory.id,
      personalProfilePage.id,
      lastPersonalVariant.id,
    );
    const container = payload.components[0] as ContainerComponentData<ComponentInContainerData>;
    const navRow = container.components.find(
      (comp) =>
        comp.type === ComponentType.ActionRow &&
        "components" in comp &&
        comp.components.some((child) => "customId" in child && child.customId?.startsWith("help:v2:navigate:")),
    );
    expect(navRow).toBeDefined();
    const buttons = navRow && "components" in navRow ? navRow.components : [];
    expect(buttons).toHaveLength(2);
    const nextButton = buttons[1];
    expect(nextButton?.disabled).toBe(false);

    const expectedCustomId = `help:v2:navigate:en-US:${setupCategory.id}:${customEndpointsPage.id}:${firstCustomVariant.id}`;
    expect(nextButton && "customId" in nextButton ? nextButton.customId : "").toBe(expectedCustomId);
  });

  it("disables the previous button on the first stop and the next button on the last stop", () => {
    for (const category of HELP_CATEGORIES) {
      const stops = buildHelpStops(category);
      expect(stops.length).toBeGreaterThan(0);

      const firstStop = stops[0];
      const firstPayload = buildHelpDashboardPayload("en-US", category.id, firstStop?.pageId, firstStop?.variantId);
      const firstContainer = firstPayload.components[0] as ContainerComponentData<ComponentInContainerData>;
      const firstNavRow = firstContainer.components.find(
        (comp) =>
          comp.type === ComponentType.ActionRow &&
          "components" in comp &&
          comp.components.some((child) => "customId" in child && child.customId?.startsWith("help:v2:navigate:")),
      );
      expect(firstNavRow).toBeDefined();
      const firstButtons = firstNavRow && "components" in firstNavRow ? firstNavRow.components : [];
      expect(firstButtons[0]?.disabled).toBe(true);

      const lastStop = stops[stops.length - 1];
      const lastPayload = buildHelpDashboardPayload("en-US", category.id, lastStop?.pageId, lastStop?.variantId);
      const lastContainer = lastPayload.components[0] as ContainerComponentData<ComponentInContainerData>;
      const lastNavRow = lastContainer.components.find(
        (comp) =>
          comp.type === ComponentType.ActionRow &&
          "components" in comp &&
          comp.components.some((child) => "customId" in child && child.customId?.startsWith("help:v2:navigate:")),
      );
      expect(lastNavRow).toBeDefined();
      const lastButtons = lastNavRow && "components" in lastNavRow ? lastNavRow.components : [];
      expect(lastButtons[1]?.disabled).toBe(true);
    }
  });
});
