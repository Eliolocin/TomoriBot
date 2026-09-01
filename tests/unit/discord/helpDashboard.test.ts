import { beforeAll, describe, expect, it } from "bun:test";
import { ComponentType, MessageFlags, type ComponentInContainerData, type ContainerComponentData } from "discord.js";
import { HELP_CATEGORIES } from "@/utils/discord/helpCatalog";
import { HELP_PROVIDER_IDS } from "@/utils/discord/helpProviderGuides";
import {
  buildHelpDashboardPayload,
  buildProviderGuideModal,
  resolveHelpSelection,
} from "@/utils/discord/ui/helpDashboard";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => {
  await initializeLocalizer();
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
});
