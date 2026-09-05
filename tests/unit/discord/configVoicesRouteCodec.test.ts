import { beforeAll, describe, expect, it } from "bun:test";
import {
  CONFIG_PAGES_BY_CATEGORY,
  CONFIG_ROUTE_CODECS,
  buildConfigRouteId,
  parseConfigPanelRoute,
  type ConfigPanelRoute,
} from "@/utils/discord/configPanelCatalog";
import { parseInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

describe("config voices route catalog & codecs", () => {
  it("includes 'voices' in CONFIG_PAGES_BY_CATEGORY.models", () => {
    expect(CONFIG_PAGES_BY_CATEGORY.models).toContain("voices");
    expect(CONFIG_PAGES_BY_CATEGORY.models[CONFIG_PAGES_BY_CATEGORY.models.length - 1]).toBe("voices");
  });

  it("ensures every wire token in CONFIG_ROUTE_CODECS is globally unique", () => {
    const seen = new Map<string, string>();
    for (const [action, codec] of Object.entries(CONFIG_ROUTE_CODECS)) {
      const existing = seen.get(codec.wireToken);
      if (existing) {
        throw new Error(`Duplicate wire token "${codec.wireToken}" found in actions "${existing}" and "${action}"`);
      }
      seen.set(codec.wireToken, action);
    }
    expect(seen.size).toBe(Object.keys(CONFIG_ROUTE_CODECS).length);
  });

  const testRoutes: ConfigPanelRoute[] = [
    { action: "tts-parameters-open", locale: "en-US" },
    { action: "tts-parameters-submit", locale: "en-US", nonce: "nonce-12345" },
    { action: "tts-turbo-set", locale: "en-US", enabled: false },
    { action: "tts-turbo-set", locale: "en-US", enabled: true },
    { action: "voice-sample-select", locale: "en-US", start: 0 },
    { action: "voice-sample-select", locale: "en-US", start: 5 },
    { action: "voice-sample-page", locale: "en-US", start: 0 },
    { action: "voice-sample-page", locale: "en-US", start: 10 },
    { action: "voice-sample-add-open", locale: "en-US" },
    { action: "voice-sample-add-submit", locale: "en-US", nonce: "nonce-67890" },
    { action: "voice-sample-remove-view", locale: "en-US", index: 0, fp: "fp123456" },
    { action: "voice-sample-remove-view", locale: "en-US", index: 2, fp: "fp654321" },
    { action: "voice-sample-remove-confirm", locale: "en-US", index: 0, fp: "fp123456", nonce: "nonce-abcde" },
    { action: "voice-sample-remove-confirm", locale: "en-US", index: 4, fp: "fp987654", nonce: "nonce-xyz01" },
    { action: "voice-sample-remove-cancel", locale: "en-US" },
  ];

  it("losslessly round-trips all ten voice route actions preserving zero and boolean values", () => {
    for (const route of testRoutes) {
      const customId = buildConfigRouteId(route);
      const parsed = parseInteractionRoute(customId);
      const decoded = parseConfigPanelRoute(parsed);
      expect(decoded).toEqual(route);
    }
  });

  it("ensures all generated voice route IDs are at most 100 characters", () => {
    for (const route of testRoutes) {
      const customId = buildConfigRouteId(route);
      expect(customId.length).toBeLessThanOrEqual(100);
    }

    // Also test maximum length with a 32-character nonce
    const maxNonceRoute: ConfigPanelRoute = {
      action: "voice-sample-remove-confirm",
      locale: "en-US",
      index: 9999,
      fp: "fp123456",
      nonce: "12345678901234567890123456789012",
    };
    const maxCustomId = buildConfigRouteId(maxNonceRoute);
    expect(maxCustomId.length).toBeLessThanOrEqual(100);
  });
});
