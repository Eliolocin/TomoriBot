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
  expect(payload.components).toHaveLength(1);
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

  it("keeps five category buttons at the top and the persistent links at the bottom", () => {
    const container = getContainer("en-US", "setup", "first-time-setup");
    const first = container.components[0];
    const last = container.components.at(-1);

    expect(first.type).toBe(ComponentType.ActionRow);
    expect("components" in first ? first.components : []).toHaveLength(5);
    expect(last?.type).toBe(ComponentType.TextDisplay);
    expect("content" in (last ?? {}) ? last.content : "").toContain("Read the full documentation");
    expect("content" in (last ?? {}) ? last.content : "").toContain("discord.gg/bjCfHm9QsB");
  });

  it("adds the provider picker only to the API Keys page", () => {
    const apiKeys = JSON.stringify(getContainer("en-US", "providers", "api-keys"));
    const personalProviders = JSON.stringify(getContainer("en-US", "providers", "personal-providers"));

    expect(apiKeys).toContain("help:v1:provider");
    expect(personalProviders).not.toContain('help:v1:provider"');
  });

  it("renders contextual endpoint and engine guides without changing the top-level page map", () => {
    const comfyUi = JSON.stringify(buildHelpDashboardPayload("en-US", "providers", "custom-endpoints", "comfyui"));
    const whisperX = JSON.stringify(buildHelpDashboardPayload("en-US", "providers", "transcription", "whisperx"));

    expect(comfyUi).toContain("ComfyUI Setup");
    expect(comfyUi).toContain("/self-hosting/local-endpoints/setup-comfyui/");
    expect(whisperX).toContain("WhisperX Transcription");
    expect(whisperX).toContain("help:v1:variant:en-US:providers:transcription");
  });

  it("falls back to Setup and First-Time Setup for invalid external state", () => {
    const selection = resolveHelpSelection("unknown", "also-unknown");
    expect(selection.category.id).toBe("setup");
    expect(selection.page.id).toBe("first-time-setup");
  });

  it("builds text-only provider modals with persistent route IDs", () => {
    for (const providerId of HELP_PROVIDER_IDS) {
      const modal = buildProviderGuideModal("en-US", providerId).toJSON();
      expect(modal.custom_id).toBe(`help:v1:provider-modal:en-US:${providerId}`);
      expect(modal.components.length).toBeGreaterThan(0);
      expect(modal.components.length).toBeLessThanOrEqual(5);
      expect(modal.components.every((component) => component.type === ComponentType.TextDisplay)).toBe(true);
    }
  });
});
