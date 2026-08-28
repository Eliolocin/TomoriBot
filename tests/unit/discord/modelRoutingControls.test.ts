import { describe, expect, it } from "bun:test";
import { initializeLocalizer } from "@/utils/text/localizer";
import { buildModelRoutingControl } from "@/utils/discord/ui/modelRoutingControls";

await initializeLocalizer();

describe("shared model routing controls", () => {
  it("renders direct providers and bounds the current-value placeholder", () => {
    const row = buildModelRoutingControl({
      capabilityLabel: "Text",
      activeModelName: "x".repeat(200),
      activeProvider: "openrouter",
      eligibleProviders: ["openrouter", "custom:12"],
      customId: "routing:text",
      serverDefaultValue: "__server_default__",
      serverDefaultLabel: "Using Server Default",
      serverDefaultDisplay: "Using Server Default",
      providerOverflowValue: "__provider_range__",
      providerOverflowLabel: "Select Page",
      directProviderLimit: 24,
      encodeProviderValue: (provider) => provider.replace(":", "~"),
      disabled: false,
    });

    const select = row.components[0];
    expect(select.placeholder?.length).toBe(150);
    expect(select.options.map((option) => option.value)).toEqual(["__server_default__", "openrouter", "custom~12"]);
    expect(select.disabled).toBe(false);
  });

  it("routes overflow explicitly instead of truncating providers", () => {
    const providers = Array.from({ length: 25 }, (_, index) => `custom:${index + 1}`);
    const row = buildModelRoutingControl({
      capabilityLabel: "Text",
      activeModelName: null,
      activeProvider: null,
      eligibleProviders: providers,
      customId: "routing:text",
      serverDefaultValue: "__server_default__",
      serverDefaultLabel: "Using Server Default",
      serverDefaultDisplay: "Using Server Default",
      providerOverflowValue: "__provider_range__",
      providerOverflowLabel: "Select Page",
      directProviderLimit: 24,
      encodeProviderValue: (provider) => provider,
      disabled: false,
    });

    expect(row.components[0].options.map((option) => option.value)).toEqual([
      "__server_default__",
      "__provider_range__",
    ]);
  });
});
