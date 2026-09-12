import { beforeAll, describe, expect, it } from "bun:test";
import {
  ComponentType,
  MessageFlags,
  type Client,
  type ComponentInContainerData,
  type ContainerComponentData,
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
): ContainerComponentData<ComponentInContainerData> {
  const payload = buildHelpDashboardPayload(locale, categoryId, pageId);
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

  it("shows the onboarding header only on Setup Step 1 and keeps five category buttons", () => {
    const container = getContainer("en-US", "setup", "setup-step-1");
    const first = container.components[0];
    const intro = container.components[2];
    const step = container.components[3];
    const features = JSON.stringify(getContainer("en-US", "features", "features"));

    expect(first.type).toBe(ComponentType.ActionRow);
    expect("components" in first ? first.components : []).toHaveLength(5);
    expect(container.accentColor).toBe(0x65c6c5);
    expect(getContainer("en-US", "features", "features").accentColor).toBe(0x65c6c5);
    expect("content" in intro ? intro.content : "").toStartWith("## Getting Started with TomoriBot");
    expect("content" in step ? step.content : "").toStartWith("### Step 1: Get an API Key");
    expect(features).not.toContain("Getting Started with TomoriBot");
    expect(JSON.stringify(getContainer("en-US", "setup", "setup-step-2"))).toContain(
      "### Step 2: Run the Setup Command",
    );
    expect(JSON.stringify(getContainer("en-US", "setup", "setup-step-3"))).toContain("### Step 3: Start Chatting");
    expect(JSON.stringify(getContainer("en-US", "setup", "setup-step-4"))).toContain(
      "### Step 4: Customize TomoriBot (Optional)",
    );
    expect(JSON.stringify(container)).toContain("← Previous");
    expect(JSON.stringify(container)).toContain("Next →");
  });

  it("renders documentation and support as link buttons below the container", () => {
    const payload = buildHelpDashboardPayload("en-US", "setup", "setup-step-1");
    const footer = payload.components.at(-1);

    expect(footer?.type).toBe(ComponentType.ActionRow);
    const buttons = footer && "components" in footer ? footer.components : [];
    expect(buttons).toHaveLength(2);
    expect(JSON.stringify(buttons)).toContain("Read the Web Version");
    expect(JSON.stringify(buttons)).toContain("Get Technical Support");
    expect(JSON.stringify(buttons)).toContain("discord.gg/bjCfHm9QsB");
  });

  it("adds described provider choices only to Setup Step 1", () => {
    const stepOne = JSON.stringify(getContainer("en-US", "setup", "setup-step-1"));
    const stepTwo = JSON.stringify(getContainer("en-US", "setup", "setup-step-2"));

    expect(stepOne).toContain("help:v2:provider");
    expect(stepOne).toContain("Choose Provider");
    expect(stepOne).toContain("General-purpose and has generous free usage");
    expect(stepTwo).not.toContain('help:v2:provider"');
  });

  it("renders contextual endpoint and engine guides without changing the top-level page map", () => {
    const comfyUi = JSON.stringify(buildHelpDashboardPayload("en-US", "features", "custom-endpoints", "comfyui"));
    const whisperX = JSON.stringify(buildHelpDashboardPayload("en-US", "features", "transcription", "whisperx"));

    expect(comfyUi).toContain("ComfyUI Setup");
    expect(comfyUi).toContain("/self-hosting/local-endpoints/setup-comfyui/");
    expect(whisperX).toContain("WhisperX Transcription");
    expect(whisperX).toContain("help:v2:variant:en-US:features:transcription");
  });

  it("renders clickable config mentions on every absorbed-command help page", () => {
    const expectedMention = "</config:987654321012345678>";
    const pages = [
      ["setup", "setup-step-3"],
      ["behavior", "customization"],
      ["memory", "short-term-memory"],
      ["memory", "memory-tagging"],
      ["behavior", "deliberate-tool-mode"],
    ];

    for (const [categoryId, pageId] of pages) {
      const serialized = JSON.stringify(buildHelpDashboardPayload("en-US", categoryId, pageId));
      expect(serialized).toContain(expectedMention);
      expect(serialized).not.toContain("</config:0>");
      expect(serialized).not.toContain("`/config`");
    }
  });

  it("falls back to Setup Step 1 for invalid external state", () => {
    const selection = resolveHelpSelection("unknown", "also-unknown");
    expect(selection.category.id).toBe("setup");
    expect(selection.page.id).toBe("setup-step-1");
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
    const pageTitle = localizer("en-US", "commands.help.speech.overview.title");
    const variantTitle = localizer("en-US", "commands.help.speech.chatterbox.title");
    expect(pageTitle).not.toBe(variantTitle);

    const payload = buildHelpDashboardPayload("en-US", "features", "speech", "chatterbox");
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
    const container = getContainer("en-US", "features", "personal-providers");
    const serialized = JSON.stringify(container);

    expect(serialized).toContain(localizer("en-US", "commands.help.personal-provider.setup_field"));
    expect(serialized).toContain(localizer("en-US", "commands.help.personal-provider.behavior_field"));
    expect(serialized).toContain(localizer("en-US", "commands.help.personal-provider.byok_field"));
    expect(serialized).toContain(localizer("en-US", "commands.help.personal-provider.footer"));
  });

  it("derives the flattened stop count for each category from the catalog", () => {
    for (const category of HELP_CATEGORIES) {
      const stops = buildHelpStops(category);
      const expectedCount = category.pages.reduce((sum, page) => sum + Math.max(1, page.variants?.length ?? 0), 0);
      expect(stops).toHaveLength(expectedCount);
    }
  });

  it("steps across the page boundary from the last custom-endpoints variant to the first speech variant", () => {
    const featuresCategory = HELP_CATEGORIES.find((candidate) => candidate.id === "features");
    const customEndpointsPage = featuresCategory?.pages.find((candidate) => candidate.id === "custom-endpoints");
    const speechPage = featuresCategory?.pages.find((candidate) => candidate.id === "speech");

    const lastCustomVariant = customEndpointsPage?.variants?.at(-1);
    const firstSpeechVariant = speechPage?.variants?.[0];

    if (!featuresCategory || !customEndpointsPage || !speechPage || !lastCustomVariant || !firstSpeechVariant) {
      throw new Error("Missing expected features catalog entries");
    }

    const payload = buildHelpDashboardPayload(
      "en-US",
      featuresCategory.id,
      customEndpointsPage.id,
      lastCustomVariant.id,
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

    const expectedCustomId = `help:v2:navigate:en-US:${featuresCategory.id}:${speechPage.id}:${firstSpeechVariant.id}`;
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
