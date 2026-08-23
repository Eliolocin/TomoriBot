import { beforeAll, describe, expect, it } from "bun:test";
import { ComponentType } from "discord.js";
import type { StPresetNodeRow, StPresetRow } from "@/types/db/schema";
import type { PanelReceipt } from "@/types/discord/panel";
import { parseStPresetsPanelRoute } from "@/utils/discord/stPresetsPanelCatalog";
import {
  buildAddStPresetModal,
  buildNodesToggleModal,
  buildStPresetsPanelPayload,
} from "@/utils/discord/ui/stPresetsPanel";
import { takeRawModalFileUpload } from "@/utils/discord/ui/modals";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

function makePreset(id: number, overrides: Partial<StPresetRow> = {}): StPresetRow {
  return {
    preset_id: id,
    server_id: 1,
    preset_name: `Preset ${id}`,
    raw_json: {},
    is_active: false,
    description: `Description for preset ${id}`,
    created_at: new Date(id * 1000),
    updated_at: new Date(id * 1000),
    ...overrides,
  };
}

function makeNode(id: number, overrides: Partial<StPresetNodeRow> = {}): StPresetNodeRow {
  return {
    node_id: id,
    preset_id: 1,
    identifier: `node_${id}`,
    name: `Node ${id}`,
    role: "system",
    content: `Content for node ${id}`,
    is_marker: false,
    is_enabled: true,
    is_comment: false,
    node_order: id,
    injection_position: 0,
    injection_depth: 4,
    injection_order: 100,
    ...overrides,
  };
}

function countComponents(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((total, child) => total + countComponents(child), 0);
  if (!value || typeof value !== "object") return 0;
  const component = value as { type?: unknown; components?: unknown; component?: unknown };
  return (
    (typeof component.type === "number" ? 1 : 0) +
    countComponents(component.components) +
    countComponents(component.component)
  );
}

function receipt(tone: PanelReceipt["tone"]): PanelReceipt {
  return { tone, heading: `${tone} heading`, detail: `${tone} detail` };
}

describe("ST Presets route codec", () => {
  it("round-trips all valid route actions", () => {
    const cases = [
      { action: "select", customId: "st-presets:v1:select:en-US", parsed: { action: "select", locale: "en-US" } },
      { action: "retry", customId: "st-presets:v1:retry:en-US", parsed: { action: "retry", locale: "en-US" } },
      { action: "none", customId: "st-presets:v1:none:en-US", parsed: { action: "none", locale: "en-US" } },
      { action: "disable", customId: "st-presets:v1:disable:en-US", parsed: { action: "disable", locale: "en-US" } },
      { action: "add-open", customId: "st-presets:v1:add-open:en-US", parsed: { action: "add-open", locale: "en-US" } },
      {
        action: "range",
        customId: "st-presets:v1:range:en-US:2",
        parsed: { action: "range", locale: "en-US", rangeIndex: 2 },
      },
      {
        action: "add-submit",
        customId: "st-presets:v1:add-submit:en-US:nonce123456",
        parsed: { action: "add-submit", locale: "en-US", nonce: "nonce123456" },
      },
      {
        action: "nodes-open",
        customId: "st-presets:v1:nodes-open:en-US:42",
        parsed: { action: "nodes-open", locale: "en-US", presetId: 42 },
      },
      {
        action: "nodes-range",
        customId: "st-presets:v1:nodes-range:en-US:42:1",
        parsed: { action: "nodes-range", locale: "en-US", presetId: 42, rangeIndex: 1 },
      },
      {
        action: "nodes-page",
        customId: "st-presets:v1:nodes-page:en-US:42:3",
        parsed: { action: "nodes-page", locale: "en-US", presetId: 42, chooserPage: 3 },
      },
      {
        action: "nodes-submit",
        customId: "st-presets:v1:nodes-submit:en-US:42:nonce123456",
        parsed: { action: "nodes-submit", locale: "en-US", presetId: 42, nonce: "nonce123456" },
      },
      {
        action: "delete-prompt",
        customId: "st-presets:v1:delete-prompt:en-US:42",
        parsed: { action: "delete-prompt", locale: "en-US", presetId: 42 },
      },
      {
        action: "delete-cancel",
        customId: "st-presets:v1:delete-cancel:en-US:42",
        parsed: { action: "delete-cancel", locale: "en-US", presetId: 42 },
      },
      {
        action: "delete-confirm",
        customId: "st-presets:v1:delete-confirm:en-US:42",
        parsed: { action: "delete-confirm", locale: "en-US", presetId: 42 },
      },
    ] as const;

    for (const c of cases) {
      const parts = c.customId.split(":");
      const namespace = parts[0] as string;
      const version = parts[1] as string;
      const segments = parts.slice(2);
      const parsed = parseStPresetsPanelRoute({ namespace, version, segments });
      expect(parsed).toEqual(c.parsed);
    }
  });

  it("rejects unsupported locales and invalid segment counts", () => {
    expect(
      parseStPresetsPanelRoute({ namespace: "st-presets", version: "v1", segments: ["select", "fr-FR"] }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({ namespace: "st-presets", version: "v1", segments: ["select", "en-US", "extra"] }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({ namespace: "st-presets", version: "v1", segments: ["range", "en-US"] }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({ namespace: "st-presets", version: "v1", segments: ["nodes-open", "en-US"] }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({ namespace: "st-presets", version: "v1", segments: ["nodes-range", "en-US", "42"] }),
    ).toBeNull();
  });

  it("rejects non-positive or non-safe integer IDs", () => {
    expect(
      parseStPresetsPanelRoute({ namespace: "st-presets", version: "v1", segments: ["nodes-open", "en-US", "0"] }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({ namespace: "st-presets", version: "v1", segments: ["nodes-open", "en-US", "-5"] }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({ namespace: "st-presets", version: "v1", segments: ["nodes-open", "en-US", "abc"] }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({ namespace: "st-presets", version: "v1", segments: ["nodes-open", "en-US", "1.5"] }),
    ).toBeNull();
  });

  it("rejects smuggled names or invalid nonces", () => {
    expect(
      parseStPresetsPanelRoute({ namespace: "st-presets", version: "v1", segments: ["add-submit", "en-US", "short"] }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({
        namespace: "st-presets",
        version: "v1",
        segments: ["add-submit", "en-US", "invalid nonce with spaces!"],
      }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({
        namespace: "st-presets",
        version: "v1",
        segments: ["nodes-open", "en-US", "Preset Name"],
      }),
    ).toBeNull();
  });
});

describe("ST Presets panel rendering", () => {
  it("orders selector options as None, presets, + Add new Preset", () => {
    const presets = [makePreset(1, { is_active: true }), makePreset(2)];
    const payload = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets,
      activePresetId: 1,
      readStatus: "fresh",
      page: { kind: "preset", presetId: 1 },
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("None (no chat completion preset)");
    expect(serialized).toContain("Preset 1");
    expect(serialized).toContain("Preset 2");
    expect(serialized).toContain("+ Add new Preset");

    const nonePos = serialized.indexOf("None (no chat completion preset)");
    const p1Pos = serialized.indexOf("Preset 1");
    const p2Pos = serialized.indexOf("Preset 2");
    const addPos = serialized.indexOf("+ Add new Preset");

    expect(nonePos).toBeLessThan(p1Pos);
    expect(p1Pos).toBeLessThan(p2Pos);
    expect(p2Pos).toBeLessThan(addPos);
  });

  it("enforces selector ceiling of 23 presets and renders range controls only beyond it", () => {
    // Exactly 23 presets: 1 page, no range buttons
    const presets23 = Array.from({ length: 23 }, (_, i) => makePreset(i + 1));
    const payload23 = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: presets23,
      activePresetId: 1,
      readStatus: "fresh",
      page: { kind: "preset", presetId: 1 },
    });
    const serialized23 = JSON.stringify(payload23);
    expect(serialized23).not.toContain("st-presets:v1:range");

    // 24 presets: 2 pages, range controls present
    const presets24 = Array.from({ length: 24 }, (_, i) => makePreset(i + 1));
    const payload24 = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: presets24,
      activePresetId: 1,
      readStatus: "fresh",
      page: { kind: "preset", presetId: 1 },
      rangeIndex: 0,
    });
    const serialized24 = JSON.stringify(payload24);
    expect(serialized24).toContain("st-presets:v1:range:en-US:1");
    expect(serialized24).toContain('"disabled":true'); // Previous disabled at page 0
  });

  it("renders selector and action buttons disabled on stale or unavailable reads", () => {
    const presets = [makePreset(1, { is_active: true })];
    const stalePayload = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets,
      activePresetId: 1,
      readStatus: "stale",
      page: { kind: "preset", presetId: 1 },
    });
    const serializedStale = JSON.stringify(stalePayload);
    expect(serializedStale).toContain(
      '"type":3,"customId":"st-presets:v1:select:en-US","placeholder":"Choose a preset or action...","options":[',
    );
    expect(serializedStale).toContain('"disabled":true');
    expect(serializedStale).toContain("Saved data may be out of date");
    expect(serializedStale).toContain('"customId":"st-presets:v1:retry:en-US","label":"Retry"');

    const unavailablePayload = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: [],
      activePresetId: null,
      readStatus: "unavailable",
      page: { kind: "none" },
    });
    const serializedUnavailable = JSON.stringify(unavailablePayload);
    expect(serializedUnavailable).toContain("Preset data could not be loaded. Retry to try again.");
    expect(serializedUnavailable).toContain('"customId":"st-presets:v1:retry:en-US","label":"Retry"');
  });

  it("renders None page in a single state with no action button regardless of active preset", () => {
    // State 1: No active preset
    const noActivePayload = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: [makePreset(1)],
      activePresetId: null,
      readStatus: "fresh",
      page: { kind: "none" },
    });
    const serializedNoActive = JSON.stringify(noActivePayload);
    expect(serializedNoActive).toContain("No Active Preset");
    expect(serializedNoActive).toContain("Chat completion presets are currently disabled");
    expect(serializedNoActive).not.toContain("Disable Presets");
    expect(serializedNoActive).not.toContain("st-presets:v1:disable");

    // State 2: Active preset exists (still renders single state, no button)
    const activePayload = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: [makePreset(1, { is_active: true })],
      activePresetId: 1,
      readStatus: "fresh",
      page: { kind: "none" },
    });
    const serializedActive = JSON.stringify(activePayload);
    expect(serializedActive).toContain("No Active Preset");
    expect(serializedActive).toContain("Chat completion presets are currently disabled");
    expect(serializedActive).not.toContain("Disable Presets");
    expect(serializedActive).not.toContain("st-presets:v1:disable");
  });

  it("derives exactly one default option across selector states to prevent Discord payload crash", () => {
    const presets24 = Array.from({ length: 24 }, (_, i) => makePreset(i + 1));

    function getSelectOptions(payload: ReturnType<typeof buildStPresetsPanelPayload>) {
      const container = payload.components.find((c) => c.type === ComponentType.Container) as {
        components: Array<{
          type: number;
          components?: Array<{ type: number; options?: Array<{ value: string; default?: boolean }> }>;
        }>;
      };
      const selectRow = container?.components.find(
        (c) => c.type === ComponentType.ActionRow && c.components?.[0]?.type === ComponentType.StringSelect,
      );
      return selectRow?.components?.[0]?.options ?? [];
    }

    // None page with active preset (reproduces the reported crash condition)
    const noneWithActive = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: presets24,
      activePresetId: 1,
      readStatus: "fresh",
      page: { kind: "none" },
    });
    const defaultsNoneActive = getSelectOptions(noneWithActive).filter((o) => o.default);
    expect(defaultsNoneActive).toHaveLength(1);
    expect(defaultsNoneActive[0].value).toBe("none");

    // None page with nothing active
    const noneNoActive = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: presets24,
      activePresetId: null,
      readStatus: "fresh",
      page: { kind: "none" },
    });
    const defaultsNoneNoActive = getSelectOptions(noneNoActive).filter((o) => o.default);
    expect(defaultsNoneNoActive).toHaveLength(1);
    expect(defaultsNoneNoActive[0].value).toBe("none");

    // Preset page on visible range
    const presetPage = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: presets24,
      activePresetId: 1,
      readStatus: "fresh",
      page: { kind: "preset", presetId: 2 },
    });
    const defaultsPreset = getSelectOptions(presetPage).filter((o) => o.default);
    expect(defaultsPreset).toHaveLength(1);
    expect(defaultsPreset[0].value).toBe("2");

    // Preset page whose preset is off the current range page (yields 0 defaults, valid in Discord)
    const presetOffRange = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: presets24,
      activePresetId: 1,
      readStatus: "fresh",
      page: { kind: "preset", presetId: 24 },
      rangeIndex: 0,
    });
    const defaultsOffRange = getSelectOptions(presetOffRange).filter((o) => o.default);
    expect(defaultsOffRange).toHaveLength(0);
  });

  it("renders preset page without ### heading and with bold node counts for active preset", () => {
    // Active preset with node counts: bold line with counts, no ### heading
    const activePayload = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: [makePreset(1, { preset_name: "My Preset", is_active: true, description: "A test description" })],
      activePresetId: 1,
      activeNodeCounts: { total: 54, enabled: 47 },
      readStatus: "fresh",
      page: { kind: "preset", presetId: 1 },
    });
    const serializedActive = JSON.stringify(activePayload);
    expect(serializedActive).not.toContain("### My Preset");
    expect(serializedActive).toContain("**🟢 This preset is selected and activated with 47 out of 54 nodes**");
    expect(serializedActive).toContain("> A test description");

    // Non-active preset display falls back to plain marker without node counts
    const nonActivePayload = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: [
        makePreset(1, { preset_name: "First Preset", is_active: false }),
        makePreset(2, { preset_name: "Second Preset", is_active: true }),
      ],
      activePresetId: 2,
      activeNodeCounts: { total: 54, enabled: 47 },
      readStatus: "fresh",
      page: { kind: "preset", presetId: 1 },
    });
    const serializedNonActive = JSON.stringify(nonActivePayload);
    expect(serializedNonActive).not.toContain("### First Preset");
    expect(serializedNonActive).toContain("🟢 Currently active preset");
    expect(serializedNonActive).not.toContain("47 out of 54");

    // Active preset without node counts provided falls back to plain marker
    const noCountsPayload = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: [makePreset(1, { is_active: true })],
      activePresetId: 1,
      activeNodeCounts: null,
      readStatus: "fresh",
      page: { kind: "preset", presetId: 1 },
    });
    const serializedNoCounts = JSON.stringify(noCountsPayload);
    expect(serializedNoCounts).not.toContain("### Preset 1");
    expect(serializedNoCounts).toContain("🟢 Currently active preset");
    expect(serializedNoCounts).not.toContain("out of");
  });

  it("renders preset page with description quote row only when description exists", () => {
    const withDesc = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: [makePreset(1, { description: "An author-written note." })],
      activePresetId: 1,
      readStatus: "fresh",
      page: { kind: "preset", presetId: 1 },
    });
    const serializedWithDesc = JSON.stringify(withDesc);
    expect(serializedWithDesc).toContain("> An author");

    const withoutDesc = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: [makePreset(1, { description: null })],
      activePresetId: 1,
      readStatus: "fresh",
      page: { kind: "preset", presetId: 1 },
    });
    const serializedWithoutDesc = JSON.stringify(withoutDesc);
    expect(serializedWithoutDesc).not.toContain("> ");
  });

  it("renders delete confirmation view", () => {
    const payload = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: [makePreset(1, { preset_name: "My Special Preset" })],
      activePresetId: 1,
      readStatus: "fresh",
      page: { kind: "delete", presetId: 1 },
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("Delete **My Special Preset**?");
    expect(serialized).toContain("st-presets:v1:delete-confirm:en-US:1");
    expect(serialized).toContain("st-presets:v1:delete-cancel:en-US:1");
  });

  it("hands off to range chooser when page is nodes-chooser", () => {
    const payload = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: [makePreset(1)],
      activePresetId: 1,
      readStatus: "fresh",
      page: { kind: "nodes-chooser", presetId: 1, totalCount: 120, chooserPage: 0 },
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("Select Page");
    expect(serialized).toContain("1-50");
    expect(serialized).toContain("51-100");
    expect(serialized).toContain("101-120");
    expect(serialized).toContain("st-presets:v1:nodes-range:en-US:1:0");
  });

  it("stays within the 40-component ceiling on the heaviest realistic payload", () => {
    const presets24 = Array.from({ length: 24 }, (_, i) =>
      makePreset(i + 1, {
        preset_name: `Preset ${i + 1} with long title`,
        description: `Long author description for preset ${i + 1}`,
      }),
    );
    const payload = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: presets24,
      activePresetId: 1,
      readStatus: "stale",
      page: { kind: "preset", presetId: 1 },
      rangeIndex: 0,
      receipt: receipt("warning"),
    });

    const totalComponents = countComponents(payload);
    expect(totalComponents).toBeLessThanOrEqual(40);
  });
});

describe("Modal builders and raw modal transport", () => {
  it("builds the Add Preset modal with file upload and text inputs", () => {
    const modal = buildAddStPresetModal("en-US", "nonce123");
    expect(modal.custom_id).toBe("st-presets:v1:add-submit:en-US:nonce123");
    expect(modal.title).toBe("Add New Preset");
    expect(modal.components).toHaveLength(3);

    const [fileComp, nameComp, descComp] = modal.components;
    expect(fileComp?.component?.type).toBe(19);
    expect(fileComp?.component?.custom_id).toBe("file_nonce123");
    expect(nameComp?.component?.type).toBe(4);
    expect(nameComp?.component?.custom_id).toBe("name_nonce123");
    expect(descComp?.component?.type).toBe(4);
    expect(descComp?.component?.custom_id).toBe("description_nonce123");
  });

  it("builds the Node Toggle modal chunked into groups of 10", () => {
    const nodes = Array.from({ length: 25 }, (_, i) => makeNode(i + 1));
    const preset = makePreset(1, { preset_name: "Preset Celia" });
    const modal = buildNodesToggleModal("en-US", preset, nodes, 0, "nonce456");

    expect(modal.custom_id).toBe("st-presets:v1:nodes-submit:en-US:1:nonce456");
    expect(modal.title).toBe("Preset Celia");
    expect(modal.components).toHaveLength(3); // 10 + 10 + 5 = 3 groups

    const group0 = modal.components[0];
    expect(group0?.label).toBe("Nodes 1-10");
    expect(group0?.component?.type).toBe(22);
    expect(group0?.component?.options).toHaveLength(10);
  });

  it("takeRawModalFileUpload returns undefined for unknown interaction", () => {
    expect(takeRawModalFileUpload("nonexistent-interaction", "file_123")).toBeUndefined();
  });
});
