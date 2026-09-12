import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { ComponentType } from "discord.js";
import type { StPresetNodeRow, StPresetRow } from "@/types/db/schema";
import type { PanelReceipt } from "@/types/discord/panel";
import {
  DISCORD_MESSAGE_TOTAL_COMPONENTS_MAX,
  validateComponentsV2MessageLimits,
} from "@/utils/discord/ui/componentsV2Limits";
import { CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER } from "@/utils/discord/configPanelCatalog";
import type { StPresetsPanelRoute } from "@/utils/discord/stPresetsPanelCatalog";
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

function receipt(tone: PanelReceipt["tone"]): PanelReceipt {
  return { tone, heading: `${tone} heading`, detail: `${tone} detail` };
}

describe("ST Presets route codec", () => {
  const WIRE_CONTRACT_V1: ReadonlyArray<
    readonly { action: StPresetsPanelRoute["action"]; customId: string; parsed: StPresetsPanelRoute }
  > = [
    { action: "select", customId: "config:v2:st-presets-select:en-US", parsed: { action: "select", locale: "en-US" } },
    { action: "retry", customId: "config:v2:st-presets-retry:en-US", parsed: { action: "retry", locale: "en-US" } },
    { action: "none", customId: "config:v2:st-presets-none:en-US", parsed: { action: "none", locale: "en-US" } },
    {
      action: "disable",
      customId: "config:v2:st-presets-disable:en-US",
      parsed: { action: "disable", locale: "en-US" },
    },
    {
      action: "add-open",
      customId: "config:v2:st-presets-add-open:en-US",
      parsed: { action: "add-open", locale: "en-US" },
    },
    {
      action: "range",
      customId: "config:v2:st-presets-range:en-US:2",
      parsed: { action: "range", locale: "en-US", rangeIndex: 2 },
    },
    {
      action: "add-submit",
      customId: "config:v2:st-presets-add-submit:en-US:nonce123456",
      parsed: { action: "add-submit", locale: "en-US", nonce: "nonce123456" },
    },
    {
      action: "nodes-open",
      customId: "config:v2:st-presets-nodes-open:en-US:42",
      parsed: { action: "nodes-open", locale: "en-US", presetId: 42 },
    },
    {
      action: "nodes-range",
      customId: "config:v2:st-presets-nodes-range:en-US:42:1",
      parsed: { action: "nodes-range", locale: "en-US", presetId: 42, rangeIndex: 1 },
    },
    {
      action: "nodes-range-select",
      customId: "config:v2:st-presets-nodes-range-select:en-US:42",
      parsed: { action: "nodes-range-select", locale: "en-US", presetId: 42 },
    },
    {
      action: "nodes-page",
      customId: "config:v2:st-presets-nodes-page:en-US:42:3",
      parsed: { action: "nodes-page", locale: "en-US", presetId: 42, chooserPage: 3 },
    },
    {
      action: "nodes-submit",
      customId: "config:v2:st-presets-nodes-submit:en-US:42:nonce123456",
      parsed: { action: "nodes-submit", locale: "en-US", presetId: 42, nonce: "nonce123456" },
    },
    {
      action: "delete-prompt",
      customId: "config:v2:st-presets-delete-prompt:en-US:42",
      parsed: { action: "delete-prompt", locale: "en-US", presetId: 42 },
    },
    {
      action: "delete-cancel",
      customId: "config:v2:st-presets-delete-cancel:en-US:42",
      parsed: { action: "delete-cancel", locale: "en-US", presetId: 42 },
    },
    {
      action: "delete-confirm",
      customId: "config:v2:st-presets-delete-confirm:en-US:42",
      parsed: { action: "delete-confirm", locale: "en-US", presetId: 42 },
    },
  ];

  it("decodes every literal v1 wire string to its exact route", () => {
    for (const c of WIRE_CONTRACT_V1) {
      const parts = c.customId.split(":");
      const namespace = parts[0] as string;
      const version = parts[1] as string;
      const segments = parts.slice(2);
      const parsed = CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({ namespace, version, segments });
      expect(parsed).toEqual(c.parsed);
    }
  });

  it("encodes every typed route to exact literal wire bytes", () => {
    for (const c of WIRE_CONTRACT_V1) {
      expect(CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.buildRouteId(c.parsed)).toBe(c.customId);
      const expectedSegments = c.customId.split(":").slice(2);
      expect(CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.buildRouteSegments(c.parsed)).toEqual(expectedSegments);
    }
  });

  it("round trips parse and build for all canonical actions", () => {
    for (const c of WIRE_CONTRACT_V1) {
      const builtId = CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.buildRouteId(c.parsed);
      const parts = builtId.split(":");
      const parsedFromBuilt = CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: parts[0] as string,
        version: parts[1] as string,
        segments: parts.slice(2),
      });
      expect(parsedFromBuilt).toEqual(c.parsed);
    }
  });

  it("guarantees 15-action exhaustiveness across accepted actions, wire contract, and route handler comparisons", () => {
    const ACCEPTED_15_ACTIONS = [
      "add-open",
      "add-submit",
      "delete-cancel",
      "delete-confirm",
      "delete-prompt",
      "disable",
      "nodes-open",
      "nodes-page",
      "nodes-range",
      "nodes-range-select",
      "nodes-submit",
      "none",
      "range",
      "retry",
      "select",
    ].sort();

    const wireActions = [...new Set(WIRE_CONTRACT_V1.map((c) => c.action))].sort();

    const routesSource = readFileSync(
      new URL("../../../src/utils/discord/interactions/stPresetsRoutes.ts", import.meta.url),
      "utf8",
    );
    const handlerActions = new Set([...routesSource.matchAll(/route\.action === "([a-z0-9-]+)"/g)].map((m) => m[1]));

    expect(wireActions).toEqual(ACCEPTED_15_ACTIONS);

    expect(handlerActions.size).toBe(15);
    expect([...handlerActions].sort()).toEqual(ACCEPTED_15_ACTIONS);
    expect(ACCEPTED_15_ACTIONS.filter((a) => !handlerActions.has(a))).toEqual([]);
    expect([...handlerActions].filter((a) => !ACCEPTED_15_ACTIONS.includes(a))).toEqual([]);
  });

  it("guarantees producer coverage against production UI and modal surfaces with five allowlisted producerless actions", () => {
    const PRODUCERLESS_COMPATIBILITY_ACTIONS = ["add-open", "disable", "none", "nodes-page", "nodes-range"] as const;
    const ACCEPTED_15_ACTIONS = [
      "add-open",
      "add-submit",
      "delete-cancel",
      "delete-confirm",
      "delete-prompt",
      "disable",
      "nodes-open",
      "nodes-page",
      "nodes-range",
      "nodes-range-select",
      "nodes-submit",
      "none",
      "range",
      "retry",
      "select",
    ].sort();

    const collectedCustomIds: string[] = [];

    function harvestCustomIds(val: unknown): void {
      if (Array.isArray(val)) {
        for (const item of val) harvestCustomIds(item);
        return;
      }
      if (!val || typeof val !== "object") return;
      const obj = val as Record<string, unknown>;
      if (typeof obj.customId === "string" && obj.customId.startsWith("config:v2:st-presets-")) {
        collectedCustomIds.push(obj.customId);
      }
      if (typeof obj.custom_id === "string" && obj.custom_id.startsWith("config:v2:st-presets-")) {
        collectedCustomIds.push(obj.custom_id);
      }
      for (const prop of Object.values(obj)) {
        harvestCustomIds(prop);
      }
    }

    const nonePayload = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: [makePreset(1)],
      activePresetId: null,
      readStatus: "stale",
      page: { kind: "none" },
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
    });
    harvestCustomIds(nonePayload);

    const multiPagePayload = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: Array.from({ length: 24 }, (_, i) => makePreset(i + 1)),
      activePresetId: 1,
      readStatus: "fresh",
      page: { kind: "preset", presetId: 1 },
      rangeIndex: 1,
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
    });
    harvestCustomIds(multiPagePayload);

    const presetPayload = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: [makePreset(1, { is_active: true })],
      activePresetId: 1,
      readStatus: "fresh",
      page: { kind: "preset", presetId: 1 },
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
    });
    harvestCustomIds(presetPayload);

    const deletePayload = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: [makePreset(1)],
      activePresetId: 1,
      readStatus: "fresh",
      page: { kind: "delete", presetId: 1 },
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
    });
    harvestCustomIds(deletePayload);

    const nodePaginationPayload = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: [makePreset(1)],
      activePresetId: 1,
      readStatus: "fresh",
      page: { kind: "preset", presetId: 1, nodeRangeIndex: 1, nodeRangeCount: 3 },
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
    });
    harvestCustomIds(nodePaginationPayload);

    const addModal = buildAddStPresetModal("en-US", "nonce123456", CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER);
    harvestCustomIds(addModal);

    const nodesModal = buildNodesToggleModal(
      "en-US",
      makePreset(1),
      [makeNode(1)],
      0,
      "nonce123456",
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
    );
    harvestCustomIds(nodesModal);

    const producedActions = new Set<string>();
    for (const customId of collectedCustomIds) {
      const parts = customId.split(":");
      const parsed = CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: parts[0] as string,
        version: parts[1] as string,
        segments: parts.slice(2),
      });
      expect(parsed).not.toBeNull();
      if (parsed) {
        producedActions.add(parsed.action);
      }
    }

    for (const action of PRODUCERLESS_COMPATIBILITY_ACTIONS) {
      expect(producedActions.has(action)).toBe(false);
    }

    const unionedActions = [...new Set([...producedActions, ...PRODUCERLESS_COMPATIBILITY_ACTIONS])].sort();
    expect(unionedActions).toEqual(ACCEPTED_15_ACTIONS);
  });

  it("rejects unsupported locales and invalid segment counts", () => {
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-select", "fr-FR"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-select", ""],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-select", "en-US", "extra"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-retry", "en-US", "extra"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-none", "en-US", "extra"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-disable", "en-US", "extra"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-add-open", "en-US", "extra"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-range", "en-US"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-range", "en-US", "2", "extra"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-add-submit", "en-US"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-add-submit", "en-US", "nonce123456", "extra"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-nodes-open", "en-US"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-nodes-open", "en-US", "42", "extra"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-nodes-range", "en-US", "42"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-nodes-range", "en-US", "42", "1", "extra"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-nodes-page", "en-US", "42"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-nodes-page", "en-US", "42", "3", "extra"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-nodes-submit", "en-US", "42"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-nodes-submit", "en-US", "42", "nonce123456", "extra"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-delete-prompt", "en-US"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-delete-prompt", "en-US", "42", "extra"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-delete-cancel", "en-US"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-delete-cancel", "en-US", "42", "extra"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-delete-confirm", "en-US"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-delete-confirm", "en-US", "42", "extra"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "wrong",
        version: "v2",
        segments: ["st-presets-select", "en-US"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v1",
        segments: ["st-presets-select", "en-US"],
      }),
    ).toBeNull();
  });

  it("rejects non-positive or non-safe integer IDs", () => {
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-nodes-open", "en-US", "0"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-nodes-open", "en-US", "-5"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-nodes-open", "en-US", "abc"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-nodes-open", "en-US", "1.5"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-nodes-range", "en-US", "42", "-1"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-nodes-range", "en-US", "42", "1.5"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-nodes-page", "en-US", "42", "-1"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-range", "en-US", "-1"],
      }),
    ).toBeNull();
  });

  it("rejects smuggled names or invalid nonces", () => {
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-add-submit", "en-US", "short"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-add-submit", "en-US", "invalid nonce with spaces!"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-add-submit", "en-US", "a".repeat(33)],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-nodes-submit", "en-US", "42", "bad!nonce#"],
      }),
    ).toBeNull();
    expect(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute({
        namespace: "config",
        version: "v2",
        segments: ["st-presets-nodes-open", "en-US", "Preset Name"],
      }),
    ).toBeNull();
  });

  it("asserts realistic maximum-length routes stay comfortably within Discord's 100-character custom ID ceiling", () => {
    const maxLocale = "zh-Hans";
    const maxNonce = "nonce1234567";
    const maxPresetId = 2147483647;
    const maxIndex = 2147483647;

    const maxRoutes: StPresetsPanelRoute[] = [
      { action: "select", locale: maxLocale },
      { action: "retry", locale: maxLocale },
      { action: "none", locale: maxLocale },
      { action: "disable", locale: maxLocale },
      { action: "add-open", locale: maxLocale },
      { action: "range", locale: maxLocale, rangeIndex: maxIndex },
      { action: "add-submit", locale: maxLocale, nonce: maxNonce },
      { action: "nodes-open", locale: maxLocale, presetId: maxPresetId },
      { action: "nodes-range", locale: maxLocale, presetId: maxPresetId, rangeIndex: maxIndex },
      { action: "nodes-page", locale: maxLocale, presetId: maxPresetId, chooserPage: maxIndex },
      { action: "nodes-submit", locale: maxLocale, presetId: maxPresetId, nonce: maxNonce },
      { action: "delete-prompt", locale: maxLocale, presetId: maxPresetId },
      { action: "delete-cancel", locale: maxLocale, presetId: maxPresetId },
      { action: "delete-confirm", locale: maxLocale, presetId: maxPresetId },
    ];

    for (const route of maxRoutes) {
      const customId = CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.buildRouteId(route);
      expect(customId.length).toBeLessThanOrEqual(100);
    }
  });
});

describe("ST Presets panel rendering", () => {
  it("orders selector options as + Add new Preset, None, and presets", () => {
    const presets = [makePreset(1, { is_active: true }), makePreset(2)];
    const payload = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets,
      activePresetId: 1,
      readStatus: "fresh",
      page: { kind: "preset", presetId: 1 },
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("None (no chat completion preset)");
    expect(serialized).toContain("Preset 1");
    expect(serialized).toContain("Preset 2");
    expect(serialized).toContain("+ Add new Preset");
    expect(serialized).toContain("**Select** or **add** a preset using the dropdown below.");

    const nonePos = serialized.indexOf("None (no chat completion preset)");
    const p1Pos = serialized.indexOf("Preset 1");
    const p2Pos = serialized.indexOf("Preset 2");
    const addPos = serialized.indexOf("+ Add new Preset");

    expect(addPos).toBeLessThan(nonePos);
    expect(nonePos).toBeLessThan(p1Pos);
    expect(p1Pos).toBeLessThan(p2Pos);
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
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
    });
    const serialized23 = JSON.stringify(payload23);
    expect(serialized23).not.toContain("config:v2:st-presets-range");

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
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
    });
    const serialized24 = JSON.stringify(payload24);
    expect(serialized24).toContain("config:v2:st-presets-range:en-US:1");
    expect(serialized24).toContain('"disabled":true'); // Previous disabled at page 0

    const getPaginationButtons = (payload: ReturnType<typeof buildStPresetsPanelPayload>) => {
      const container = payload.components.find((component) => component.type === ComponentType.Container) as {
        components?: Array<{
          type: number;
          components?: Array<{ customId?: string; disabled?: boolean; label?: string }>;
        }>;
      };
      return (
        container.components?.find(
          (component) => component.type === ComponentType.ActionRow && component.components?.length === 3,
        )?.components ?? []
      );
    };

    const firstPageButtons = getPaginationButtons(payload24);
    expect(firstPageButtons.map((button) => button.label)).toEqual(["← Previous", "Page 1 of 2", "Next →"]);
    expect(firstPageButtons.map((button) => button.disabled)).toEqual([true, true, false]);
    expect(firstPageButtons[0]?.customId).toBe("config:v2:st-presets-range:en-US:0");
    expect(firstPageButtons[2]?.customId).toBe("config:v2:st-presets-range:en-US:1");
    expect(new Set(firstPageButtons.map((button) => button.customId)).size).toBe(3);

    const secondPage = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: presets24,
      activePresetId: 1,
      readStatus: "fresh",
      page: { kind: "preset", presetId: 1 },
      rangeIndex: 1,
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
    });
    const secondPageButtons = getPaginationButtons(secondPage);
    expect(secondPageButtons.map((button) => button.label)).toEqual(["← Previous", "Page 2 of 2", "Next →"]);
    expect(secondPageButtons.map((button) => button.disabled)).toEqual([false, true, true]);

    const stalePage = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: presets24,
      activePresetId: 1,
      readStatus: "stale",
      page: { kind: "preset", presetId: 1 },
      rangeIndex: 1,
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
    });
    expect(getPaginationButtons(stalePage).map((button) => button.disabled)).toEqual([true, true, true]);
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
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
    });
    const serializedStale = JSON.stringify(stalePayload);
    expect(serializedStale).toContain(
      '"type":3,"customId":"config:v2:st-presets-select:en-US","placeholder":"Choose a preset or action...","options":[',
    );
    expect(serializedStale).toContain('"disabled":true');
    expect(serializedStale).toContain("Saved data may be out of date");
    expect(serializedStale).toContain('"customId":"config:v2:st-presets-retry:en-US","label":"Retry"');

    const unavailablePayload = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: [],
      activePresetId: null,
      readStatus: "unavailable",
      page: { kind: "none" },
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
    });
    const serializedUnavailable = JSON.stringify(unavailablePayload);
    expect(serializedUnavailable).toContain("Preset data could not be loaded. Retry to try again.");
    expect(serializedUnavailable).toContain('"customId":"config:v2:st-presets-retry:en-US","label":"Retry"');
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
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
    });
    const serializedNoActive = JSON.stringify(noActivePayload);
    expect(serializedNoActive).toContain("No Active Preset");
    expect(serializedNoActive).toContain("Chat completion presets are currently disabled");
    expect(serializedNoActive).not.toContain("Disable Presets");
    expect(serializedNoActive).not.toContain("config:v2:st-presets-disable");

    // State 2: Active preset exists (still renders single state, no button)
    const activePayload = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: [makePreset(1, { is_active: true })],
      activePresetId: 1,
      readStatus: "fresh",
      page: { kind: "none" },
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
    });
    const serializedActive = JSON.stringify(activePayload);
    expect(serializedActive).toContain("No Active Preset");
    expect(serializedActive).toContain("Chat completion presets are currently disabled");
    expect(serializedActive).not.toContain("Disable Presets");
    expect(serializedActive).not.toContain("config:v2:st-presets-disable");
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
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
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
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
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
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
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
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
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
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
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
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
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
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
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
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
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
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
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
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("Delete **My Special Preset**?");
    expect(serialized).toContain("config:v2:st-presets-delete-confirm:en-US:1");
    expect(serialized).toContain("config:v2:st-presets-delete-cancel:en-US:1");
  });

  it("keeps the active preset body while exposing oversized node modal pages", () => {
    const payload = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: [makePreset(1)],
      activePresetId: 1,
      readStatus: "fresh",
      page: { kind: "preset", presetId: 1, nodeRangeIndex: 0, nodeRangeCount: 3 },
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("Select Page");
    expect(serialized).toContain("Currently active preset");
    expect(serialized).toContain("config:v2:st-presets-nodes-range-select:en-US:1");
    // Every range including the first is its own option, so no slice is stranded behind a
    // disabled control.
    expect(serialized).toContain('"value":"0","label":"Nodes 1-50"');
    expect(serialized).toContain('"value":"1","label":"Nodes 51-100"');
    expect(serialized).toContain('"value":"2","label":"Nodes 101-150"');
    expect(serialized).not.toContain('"label":"Next →"');
  });

  it("keeps a second-page preset selected and on its own selector page after a repaint", () => {
    const presets24 = Array.from({ length: 24 }, (_, i) => makePreset(i + 1));
    // Preset 24 sits on selector page 2; a repaint that names it carries no rangeIndex.
    const payload = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: presets24,
      activePresetId: 24,
      readStatus: "fresh",
      page: { kind: "preset", presetId: 24 },
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain('"label":"Page 2 of 2"');
    expect(serialized).toContain('"value":"24","description":"Description for preset 24","default":true');
    expect(serialized).not.toContain('"value":"1","description":"Description for preset 1"');
  });

  it("keeps a delete prompt on the selector page holding its target", () => {
    const presets24 = Array.from({ length: 24 }, (_, i) => makePreset(i + 1));
    const payload = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: presets24,
      activePresetId: 1,
      readStatus: "fresh",
      page: { kind: "delete", presetId: 24 },
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
    });
    expect(JSON.stringify(payload)).toContain('"label":"Page 2 of 2"');
  });

  it("still honours an explicit selector page over the selection anchor", () => {
    const presets24 = Array.from({ length: 24 }, (_, i) => makePreset(i + 1));
    const payload = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: presets24,
      activePresetId: 24,
      readStatus: "fresh",
      page: { kind: "preset", presetId: 24 },
      rangeIndex: 0,
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
    });
    expect(JSON.stringify(payload)).toContain('"label":"Page 1 of 2"');
  });

  it("labels a partial final node range from the real node total", () => {
    const payload = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: [makePreset(1)],
      activePresetId: 1,
      readStatus: "fresh",
      page: { kind: "preset", presetId: 1, nodeRangeIndex: 0, nodeRangeCount: 2, nodeTotalCount: 51 },
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain('"value":"0","label":"Nodes 1-50"');
    expect(serialized).toContain('"value":"1","label":"Nodes 51-51"');
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
      routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
    });

    const result = validateComponentsV2MessageLimits(payload);
    expect(
      result.valid,
      `Components V2 limit ${DISCORD_MESSAGE_TOTAL_COMPONENTS_MAX} violations: ${JSON.stringify(result.violations)}`,
    ).toBe(true);
  });
});

describe("Modal builders and raw modal transport", () => {
  it("builds the Add Preset modal with file upload and text inputs", () => {
    const modal = buildAddStPresetModal("en-US", "nonce123", CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER);
    expect(modal.custom_id).toBe("config:v2:st-presets-add-submit:en-US:nonce123");
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
    const modal = buildNodesToggleModal("en-US", preset, nodes, 0, "nonce456", CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER);

    expect(modal.custom_id).toBe("config:v2:st-presets-nodes-submit:en-US:1:nonce456");
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
