import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { ComponentType } from "discord.js";
import type { StPresetNodeRow, StPresetRow } from "@/types/db/schema";
import type { PanelReceipt } from "@/types/discord/panel";
import {
  buildStPresetsRouteId,
  buildStPresetsRouteSegments,
  listStPresetsPanelActions,
  parseStPresetsPanelRoute,
  ST_PRESETS_ROUTE_CODECS,
  type StPresetsPanelRoute,
} from "@/utils/discord/stPresetsPanelCatalog";
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
  // These literal IDs record the v1 bytes already-open Discord panels send. A shared codec can
  // move encoder and decoder fields together while round trips stay green, so this fixture must
  // remain independent of the builder it constrains.
  const WIRE_CONTRACT_V1: ReadonlyArray<
    readonly { action: StPresetsPanelRoute["action"]; customId: string; parsed: StPresetsPanelRoute }
  > = [
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
  ];

  it("decodes every literal v1 wire string to its exact route", () => {
    for (const c of WIRE_CONTRACT_V1) {
      const parts = c.customId.split(":");
      const namespace = parts[0] as string;
      const version = parts[1] as string;
      const segments = parts.slice(2);
      const parsed = parseStPresetsPanelRoute({ namespace, version, segments });
      expect(parsed).toEqual(c.parsed);
    }
  });

  it("encodes every typed route to exact literal wire bytes", () => {
    for (const c of WIRE_CONTRACT_V1) {
      expect(buildStPresetsRouteId(c.parsed)).toBe(c.customId);
      const expectedSegments = c.customId.split(":").slice(2);
      expect(buildStPresetsRouteSegments(c.parsed)).toEqual(expectedSegments);
    }
  });

  it("round trips parse and build for all canonical actions", () => {
    for (const c of WIRE_CONTRACT_V1) {
      const builtId = buildStPresetsRouteId(c.parsed);
      const parts = builtId.split(":");
      const parsedFromBuilt = parseStPresetsPanelRoute({
        namespace: parts[0] as string,
        version: parts[1] as string,
        segments: parts.slice(2),
      });
      expect(parsedFromBuilt).toEqual(c.parsed);
    }
  });

  it("guarantees 14-action exhaustiveness across catalog, accepted actions, wire contract, and route handler comparisons", () => {
    const ACCEPTED_14_ACTIONS = [
      "add-open",
      "add-submit",
      "delete-cancel",
      "delete-confirm",
      "delete-prompt",
      "disable",
      "nodes-open",
      "nodes-page",
      "nodes-range",
      "nodes-submit",
      "none",
      "range",
      "retry",
      "select",
    ].sort();

    const catalogActions = listStPresetsPanelActions().sort();
    const wireActions = [...new Set(WIRE_CONTRACT_V1.map((c) => c.action))].sort();
    const codecTableActions = Object.keys(ST_PRESETS_ROUTE_CODECS).sort();

    const routesSource = readFileSync(
      new URL("../../../src/utils/discord/interactions/stPresetsRoutes.ts", import.meta.url),
      "utf8",
    );
    const handlerActions = new Set([...routesSource.matchAll(/route\.action === "([a-z0-9-]+)"/g)].map((m) => m[1]));

    expect(catalogActions).toEqual(ACCEPTED_14_ACTIONS);
    expect(wireActions).toEqual(ACCEPTED_14_ACTIONS);
    expect(codecTableActions).toEqual(ACCEPTED_14_ACTIONS);

    expect(handlerActions.size).toBe(14);
    expect([...handlerActions].sort()).toEqual(ACCEPTED_14_ACTIONS);
    expect(ACCEPTED_14_ACTIONS.filter((a) => !handlerActions.has(a))).toEqual([]);
    expect([...handlerActions].filter((a) => !ACCEPTED_14_ACTIONS.includes(a))).toEqual([]);
    expect(codecTableActions.filter((a) => !handlerActions.has(a))).toEqual([]);
    expect([...handlerActions].filter((a) => !codecTableActions.includes(a))).toEqual([]);
  });

  it("guarantees producer coverage against production UI and modal surfaces with exactly three allowlisted producerless actions", () => {
    const PRODUCERLESS_COMPATIBILITY_ACTIONS = ["add-open", "disable", "none"] as const;
    const ACCEPTED_14_ACTIONS = [
      "add-open",
      "add-submit",
      "delete-cancel",
      "delete-confirm",
      "delete-prompt",
      "disable",
      "nodes-open",
      "nodes-page",
      "nodes-range",
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
      if (typeof obj.customId === "string" && obj.customId.startsWith("st-presets:")) {
        collectedCustomIds.push(obj.customId);
      }
      if (typeof obj.custom_id === "string" && obj.custom_id.startsWith("st-presets:")) {
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
    });
    harvestCustomIds(multiPagePayload);

    const presetPayload = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: [makePreset(1, { is_active: true })],
      activePresetId: 1,
      readStatus: "fresh",
      page: { kind: "preset", presetId: 1 },
    });
    harvestCustomIds(presetPayload);

    const deletePayload = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: [makePreset(1)],
      activePresetId: 1,
      readStatus: "fresh",
      page: { kind: "delete", presetId: 1 },
    });
    harvestCustomIds(deletePayload);

    const chooserPayload = buildStPresetsPanelPayload({
      locale: "en-US",
      scope: "guild",
      presets: [makePreset(1)],
      activePresetId: 1,
      readStatus: "fresh",
      page: { kind: "nodes-chooser", presetId: 1, totalCount: 600, chooserPage: 1 },
    });
    harvestCustomIds(chooserPayload);

    const addModal = buildAddStPresetModal("en-US", "nonce123456");
    harvestCustomIds(addModal);

    const nodesModal = buildNodesToggleModal("en-US", makePreset(1), [makeNode(1)], 0, "nonce123456");
    harvestCustomIds(nodesModal);

    const producedActions = new Set<string>();
    for (const customId of collectedCustomIds) {
      const parts = customId.split(":");
      const parsed = parseStPresetsPanelRoute({
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
    expect(unionedActions).toEqual(ACCEPTED_14_ACTIONS);
  });

  it("rejects unsupported locales and invalid segment counts", () => {
    expect(
      parseStPresetsPanelRoute({ namespace: "st-presets", version: "v1", segments: ["select", "fr-FR"] }),
    ).toBeNull();
    expect(parseStPresetsPanelRoute({ namespace: "st-presets", version: "v1", segments: ["select", ""] })).toBeNull();
    expect(
      parseStPresetsPanelRoute({ namespace: "st-presets", version: "v1", segments: ["select", "en-US", "extra"] }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({ namespace: "st-presets", version: "v1", segments: ["retry", "en-US", "extra"] }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({ namespace: "st-presets", version: "v1", segments: ["none", "en-US", "extra"] }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({ namespace: "st-presets", version: "v1", segments: ["disable", "en-US", "extra"] }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({ namespace: "st-presets", version: "v1", segments: ["add-open", "en-US", "extra"] }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({ namespace: "st-presets", version: "v1", segments: ["range", "en-US"] }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({ namespace: "st-presets", version: "v1", segments: ["range", "en-US", "2", "extra"] }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({
        namespace: "st-presets",
        version: "v1",
        segments: ["add-submit", "en-US"],
      }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({
        namespace: "st-presets",
        version: "v1",
        segments: ["add-submit", "en-US", "nonce123456", "extra"],
      }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({ namespace: "st-presets", version: "v1", segments: ["nodes-open", "en-US"] }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({
        namespace: "st-presets",
        version: "v1",
        segments: ["nodes-open", "en-US", "42", "extra"],
      }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({ namespace: "st-presets", version: "v1", segments: ["nodes-range", "en-US", "42"] }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({
        namespace: "st-presets",
        version: "v1",
        segments: ["nodes-range", "en-US", "42", "1", "extra"],
      }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({ namespace: "st-presets", version: "v1", segments: ["nodes-page", "en-US", "42"] }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({
        namespace: "st-presets",
        version: "v1",
        segments: ["nodes-page", "en-US", "42", "3", "extra"],
      }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({ namespace: "st-presets", version: "v1", segments: ["nodes-submit", "en-US", "42"] }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({
        namespace: "st-presets",
        version: "v1",
        segments: ["nodes-submit", "en-US", "42", "nonce123456", "extra"],
      }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({ namespace: "st-presets", version: "v1", segments: ["delete-prompt", "en-US"] }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({
        namespace: "st-presets",
        version: "v1",
        segments: ["delete-prompt", "en-US", "42", "extra"],
      }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({ namespace: "st-presets", version: "v1", segments: ["delete-cancel", "en-US"] }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({
        namespace: "st-presets",
        version: "v1",
        segments: ["delete-cancel", "en-US", "42", "extra"],
      }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({ namespace: "st-presets", version: "v1", segments: ["delete-confirm", "en-US"] }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({
        namespace: "st-presets",
        version: "v1",
        segments: ["delete-confirm", "en-US", "42", "extra"],
      }),
    ).toBeNull();
    expect(parseStPresetsPanelRoute({ namespace: "wrong", version: "v1", segments: ["select", "en-US"] })).toBeNull();
    expect(
      parseStPresetsPanelRoute({ namespace: "st-presets", version: "v2", segments: ["select", "en-US"] }),
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
    expect(
      parseStPresetsPanelRoute({
        namespace: "st-presets",
        version: "v1",
        segments: ["nodes-range", "en-US", "42", "-1"],
      }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({
        namespace: "st-presets",
        version: "v1",
        segments: ["nodes-range", "en-US", "42", "1.5"],
      }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({
        namespace: "st-presets",
        version: "v1",
        segments: ["nodes-page", "en-US", "42", "-1"],
      }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({ namespace: "st-presets", version: "v1", segments: ["range", "en-US", "-1"] }),
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
        segments: ["add-submit", "en-US", "a".repeat(33)],
      }),
    ).toBeNull();
    expect(
      parseStPresetsPanelRoute({
        namespace: "st-presets",
        version: "v1",
        segments: ["nodes-submit", "en-US", "42", "bad!nonce#"],
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
      const customId = buildStPresetsRouteId(route);
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
