import { readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "bun:test";
import { ComponentType } from "discord.js";
import type { StPresetRow } from "@/types/db/schema";
import type { PanelReadStatus, PanelReceipt } from "@/types/discord/panel";
import { CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER } from "@/utils/discord/configPanelCatalog";
import { MAX_NODES_PER_MODAL_PAGE, NODE_RANGE_OPTIONS_PER_PAGE } from "@/utils/discord/stPresetsPanelCatalog";
import { MAX_PRESET_NAME_LENGTH } from "@/utils/stPreset/stPresetImportParser";
import { buildStPresetsPanelPayload, MAX_PRESETS_PER_SELECTOR_PAGE } from "@/utils/discord/ui/stPresetsPanel";
import { validateComponentsV2MessageLimits } from "@/utils/discord/ui/componentsV2Limits";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const localesDir = join(process.cwd(), "src", "locales");
const RUNTIME_LOCALES = readdirSync(localesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const REALISTIC_RECEIPT: PanelReceipt = {
  tone: "success",
  heading: "Preset Action Completed Successfully",
  detail: "The preset was saved and the active prompt-node state was refreshed.",
  metadata: "trace: preset-op-987654 | actor: 123456789012345678 | elapsed: 48ms",
};

const READ_STATUSES: PanelReadStatus[] = ["fresh", "stale", "unavailable"];
const RECEIPTS: Array<PanelReceipt | undefined> = [undefined, REALISTIC_RECEIPT];
const BACKTICK_RUNS = [3, 4, 5, 6, 8];
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function textDisplays(value: unknown): string[] {
  const contents: string[] = [];
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const child of current) visit(child);
      return;
    }
    if (!current || typeof current !== "object") return;
    const record = current as Record<string, unknown>;
    if (record.type === ComponentType.TextDisplay && typeof record.content === "string") {
      contents.push(record.content);
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return contents;
}

function assertSafePayload(payload: ReturnType<typeof buildStPresetsPanelPayload>, label: string): void {
  const result = validateComponentsV2MessageLimits(payload);
  expect(result.valid, `${label} violations: ${JSON.stringify(result.violations)}`).toBe(true);
  for (const content of textDisplays(payload)) {
    expect(LONE_SURROGATE.test(content), `${label} contains a lone surrogate`).toBe(false);
    const fenceStart = content.indexOf("```markdown\n");
    if (fenceStart === -1) continue;
    const bodyStart = fenceStart + "```markdown\n".length;
    const closingFence = content.lastIndexOf("\n```");
    if (closingFence <= bodyStart) continue;
    expect(content.slice(bodyStart, closingFence), `${label} has an adjacent backtick in a fence`).not.toMatch(/``/u);
  }
}

function preset(id: number, overrides: Partial<StPresetRow> = {}): StPresetRow {
  return {
    preset_id: id,
    server_id: 1,
    preset_name: `Preset ${id}`,
    raw_json: {},
    is_active: id === 1,
    description: `Description for preset ${id}`,
    created_at: new Date(id),
    updated_at: new Date(id),
    ...overrides,
  };
}

function selectorValues(value: unknown): string[] {
  const values: string[] = [];
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const child of current) visit(child);
      return;
    }
    if (!current || typeof current !== "object") return;
    const record = current as Record<string, unknown>;
    if (record.type === ComponentType.StringSelect && Array.isArray(record.options)) {
      for (const option of record.options) {
        if (!option || typeof option !== "object") continue;
        const optionRecord = option as Record<string, unknown>;
        if (typeof optionRecord.value === "string" && /^\d+$/u.test(optionRecord.value)) {
          values.push(optionRecord.value);
        }
      }
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return values;
}

describe("SillyTavern presets panel Components V2 limits", () => {
  it("covers both scopes, all page kinds, every read status, receipt state, and preset collection size", () => {
    const sizes = [
      0,
      1,
      MAX_PRESETS_PER_SELECTOR_PAGE - 1,
      MAX_PRESETS_PER_SELECTOR_PAGE,
      MAX_PRESETS_PER_SELECTOR_PAGE + 1,
      MAX_PRESETS_PER_SELECTOR_PAGE * 3,
    ];
    for (const locale of RUNTIME_LOCALES) {
      for (const scope of ["guild", "dm"] as const) {
        for (const receipt of RECEIPTS) {
          for (const readStatus of READ_STATUSES) {
            for (const size of sizes) {
              const presets = Array.from({ length: size }, (_, index) => preset(index + 1));
              for (const page of [
                { kind: "none" as const },
                { kind: "preset" as const, presetId: presets[0]?.preset_id, nodeRangeCount: 2, nodeTotalCount: 51 },
                { kind: "delete" as const, presetId: presets[0]?.preset_id ?? 1 },
              ]) {
                assertSafePayload(
                  buildStPresetsPanelPayload({
                    locale,
                    scope,
                    presets,
                    activePresetId: presets[0]?.preset_id ?? null,
                    activeNodeCounts: { total: 51, enabled: 25 },
                    readStatus,
                    page,
                    rangeIndex: 2,
                    receipt,
                    routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
                  }),
                  `${locale}/${scope}/${readStatus}/size-${size}/${page.kind}`,
                );
              }
            }
          }
        }
      }
    }
  });

  it("sweeps node-range inputs at their exported modal and selector page sizes", () => {
    const nodeCounts = [
      0,
      1,
      MAX_NODES_PER_MODAL_PAGE - 1,
      MAX_NODES_PER_MODAL_PAGE,
      MAX_NODES_PER_MODAL_PAGE + 1,
      MAX_NODES_PER_MODAL_PAGE * 3,
    ];
    for (const nodeTotalCount of nodeCounts) {
      const nodeRangeCount = Math.max(1, Math.ceil(nodeTotalCount / MAX_NODES_PER_MODAL_PAGE));
      for (const nodeRangeIndex of [0, Math.max(0, nodeRangeCount - 1), nodeRangeCount + NODE_RANGE_OPTIONS_PER_PAGE]) {
        assertSafePayload(
          buildStPresetsPanelPayload({
            locale: "en-US",
            scope: "guild",
            presets: [preset(1)],
            activePresetId: 1,
            activeNodeCounts: { total: nodeTotalCount, enabled: Math.floor(nodeTotalCount / 2) },
            readStatus: "fresh",
            page: { kind: "preset", presetId: 1, nodeRangeIndex, nodeRangeCount, nodeTotalCount },
            routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
          }),
          `nodes-${nodeTotalCount}/${nodeRangeIndex}`,
        );
      }
    }
  });

  it("bounds preset names and descriptions across stored, oversized, fenced, and astral shapes", () => {
    const shapes = [
      { name: "N".repeat(MAX_PRESET_NAME_LENGTH), description: "D".repeat(500) },
      { name: "O".repeat(MAX_PRESET_NAME_LENGTH + 1), description: "O".repeat(20_000) },
      ...BACKTICK_RUNS.map((length) => ({
        name: `preset ${"`".repeat(length)} name`,
        description: `preset ${"`".repeat(length)} description`,
      })),
      { name: "🌟".repeat(20_000), description: "🌟".repeat(20_000) },
    ];
    for (const [index, shape] of shapes.entries()) {
      const item = preset(index + 1, { preset_name: shape.name, description: shape.description });
      for (const page of [
        { kind: "preset" as const, presetId: item.preset_id },
        { kind: "delete" as const, presetId: item.preset_id as number },
      ]) {
        assertSafePayload(
          buildStPresetsPanelPayload({
            locale: "en-US",
            scope: "guild",
            presets: [item],
            activePresetId: item.preset_id as number,
            readStatus: "fresh",
            page,
            receipt: REALISTIC_RECEIPT,
            routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
          }),
          `shape-${index}/${page.kind}`,
        );
      }
    }

    // Explicitly test a full page of presets at MAX_PRESETS_PER_SELECTOR_PAGE with oversized names and descriptions
    const fullPagePresets = Array.from({ length: MAX_PRESETS_PER_SELECTOR_PAGE }, (_, index) =>
      preset(index + 1, {
        preset_name: "P".repeat(MAX_PRESET_NAME_LENGTH + 1),
        description: "D".repeat(20_000),
      }),
    );
    for (const locale of RUNTIME_LOCALES) {
      for (const receipt of RECEIPTS) {
        for (const page of [
          { kind: "preset" as const, presetId: fullPagePresets[0]?.preset_id },
          { kind: "delete" as const, presetId: fullPagePresets[0]?.preset_id as number },
        ]) {
          assertSafePayload(
            buildStPresetsPanelPayload({
              locale,
              scope: "guild",
              presets: fullPagePresets,
              activePresetId: fullPagePresets[0]?.preset_id as number,
              readStatus: "fresh",
              page,
              receipt,
              routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
            }),
            `full-page-oversized/${locale}/${page.kind}/receipt=${Boolean(receipt)}`,
          );
        }
      }
    }
  });

  it("covers every preset exactly once across selector ranges", () => {
    const total = MAX_PRESETS_PER_SELECTOR_PAGE + 1;
    const presets = Array.from({ length: total }, (_, index) => preset(index + 1));
    const seen: string[] = [];
    const rangeCount = Math.ceil(total / MAX_PRESETS_PER_SELECTOR_PAGE);
    for (let rangeIndex = 0; rangeIndex < rangeCount; rangeIndex++) {
      seen.push(
        ...selectorValues(
          buildStPresetsPanelPayload({
            locale: "en-US",
            scope: "guild",
            presets,
            activePresetId: null,
            readStatus: "fresh",
            page: { kind: "none" },
            rangeIndex,
            routes: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
          }),
        ),
      );
    }
    expect(seen.sort()).toEqual(presets.map((item) => String(item.preset_id)).sort());
  });
});
