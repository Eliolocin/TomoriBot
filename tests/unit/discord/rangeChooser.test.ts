import { beforeAll, describe, expect, it } from "bun:test";
import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type ActionRowData,
  type ButtonComponentData,
  type Client,
} from "discord.js";
import { RANGES_PER_CHOOSER_PAGE, resolveRangeChooser } from "@/utils/discord/interactions/panelController";
import { InteractionRouteRegistry, parseInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import {
  buildCategoryButtonRow,
  buildPanelContainer,
  buildPanelReceiptContainer,
  buildRangeChooserComponents,
  buildRangeNavigationRows,
  type RangeChooserRouteSegments,
} from "@/utils/discord/ui/panel";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

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

describe("resolveRangeChooser arithmetic", () => {
  it("exports RANGES_PER_CHOOSER_PAGE as 10", () => {
    expect(RANGES_PER_CHOOSER_PAGE).toBe(10);
  });

  it("handles zero totalCount as no ranges and one chooser page", () => {
    const resolved = resolveRangeChooser({ totalCount: 0, pageSize: 50, chooserPage: 0 });
    expect(resolved.rangeCount).toBe(0);
    expect(resolved.chooserPageCount).toBe(1);
    expect(resolved.chooserPage).toBe(0);
    expect(resolved.ranges).toEqual([]);
  });

  it("handles exactly one full page", () => {
    const resolved = resolveRangeChooser({ totalCount: 50, pageSize: 50, chooserPage: 0 });
    expect(resolved.rangeCount).toBe(1);
    expect(resolved.chooserPageCount).toBe(1);
    expect(resolved.chooserPage).toBe(0);
    expect(resolved.ranges).toEqual([{ rangeIndex: 0, start: 1, end: 50 }]);
  });

  it("handles exactly one full chooser page of ten ranges", () => {
    const resolved = resolveRangeChooser({ totalCount: 500, pageSize: 50, chooserPage: 0 });
    expect(resolved.rangeCount).toBe(10);
    expect(resolved.chooserPageCount).toBe(1);
    expect(resolved.chooserPage).toBe(0);
    expect(resolved.ranges).toHaveLength(10);
    expect(resolved.ranges[0]).toEqual({ rangeIndex: 0, start: 1, end: 50 });
    expect(resolved.ranges[9]).toEqual({ rangeIndex: 9, start: 451, end: 500 });
  });

  it("handles one item over a page boundary", () => {
    const resolved = resolveRangeChooser({ totalCount: 51, pageSize: 50, chooserPage: 0 });
    expect(resolved.rangeCount).toBe(2);
    expect(resolved.chooserPageCount).toBe(1);
    expect(resolved.chooserPage).toBe(0);
    expect(resolved.ranges).toEqual([
      { rangeIndex: 0, start: 1, end: 50 },
      { rangeIndex: 1, start: 51, end: 51 },
    ]);
  });

  it("handles one item over a chooser page boundary across both chooser pages", () => {
    const pageZero = resolveRangeChooser({ totalCount: 501, pageSize: 50, chooserPage: 0 });
    expect(pageZero.rangeCount).toBe(11);
    expect(pageZero.chooserPageCount).toBe(2);
    expect(pageZero.chooserPage).toBe(0);
    expect(pageZero.ranges).toHaveLength(10);
    expect(pageZero.ranges[0]).toEqual({ rangeIndex: 0, start: 1, end: 50 });
    expect(pageZero.ranges[9]).toEqual({ rangeIndex: 9, start: 451, end: 500 });

    const pageOne = resolveRangeChooser({ totalCount: 501, pageSize: 50, chooserPage: 1 });
    expect(pageOne.rangeCount).toBe(11);
    expect(pageOne.chooserPageCount).toBe(2);
    expect(pageOne.chooserPage).toBe(1);
    expect(pageOne.ranges).toEqual([{ rangeIndex: 10, start: 501, end: 501 }]);
  });

  it("clamps out-of-bounds chooserPage input without throwing", () => {
    const high = resolveRangeChooser({ totalCount: 501, pageSize: 50, chooserPage: 999 });
    expect(high.chooserPage).toBe(1);
    expect(high.ranges).toEqual([{ rangeIndex: 10, start: 501, end: 501 }]);

    const negative = resolveRangeChooser({ totalCount: 501, pageSize: 50, chooserPage: -10 });
    expect(negative.chooserPage).toBe(0);
    expect(negative.ranges).toHaveLength(10);

    const emptyHigh = resolveRangeChooser({ totalCount: 0, pageSize: 50, chooserPage: 5 });
    expect(emptyHigh.chooserPage).toBe(0);
    expect(emptyHigh.ranges).toEqual([]);
  });

  it("honours pageSize parameter at both 50 and 25", () => {
    const size50 = resolveRangeChooser({ totalCount: 120, pageSize: 50, chooserPage: 0 });
    expect(size50.rangeCount).toBe(3);
    expect(size50.ranges).toEqual([
      { rangeIndex: 0, start: 1, end: 50 },
      { rangeIndex: 1, start: 51, end: 100 },
      { rangeIndex: 2, start: 101, end: 120 },
    ]);

    const size25 = resolveRangeChooser({ totalCount: 120, pageSize: 25, chooserPage: 0 });
    expect(size25.rangeCount).toBe(5);
    expect(size25.ranges).toEqual([
      { rangeIndex: 0, start: 1, end: 25 },
      { rangeIndex: 1, start: 26, end: 50 },
      { rangeIndex: 2, start: 51, end: 75 },
      { rangeIndex: 3, start: 76, end: 100 },
      { rangeIndex: 4, start: 101, end: 120 },
    ]);
  });
});

describe("buildRangeChooserComponents rendering", () => {
  it("renders Cancel button and omits Previous/Next when there is only one chooser page", () => {
    const components = buildRangeChooserComponents({
      locale: "en-US",
      totalCount: 120,
      pageSize: 50,
      chooserPage: 0,
      namespace: "test-ns",
      version: "v1",
      baseSegments: ["items"],
    });

    expect(components).toHaveLength(4);
    expect(components[0]).toEqual({
      type: ComponentType.TextDisplay,
      content: "### Select Page",
    });
    expect(components[1]).toEqual({
      type: ComponentType.TextDisplay,
      content: "Choose a page to view from 120 items across 3 pages:",
    });

    const rangeRow = components[2] as ActionRowData<ButtonComponentData>;
    expect(rangeRow.type).toBe(ComponentType.ActionRow);
    expect(rangeRow.components).toHaveLength(3);
    expect(rangeRow.components[0].label).toBe("1-50");
    expect(rangeRow.components[1].label).toBe("51-100");
    expect(rangeRow.components[2].label).toBe("101-120");

    const cancelRow = components[3] as ActionRowData<ButtonComponentData>;
    expect(cancelRow.type).toBe(ComponentType.ActionRow);
    expect(cancelRow.components).toHaveLength(1);
    expect(cancelRow.components[0].label).toBe("Cancel");
    expect(cancelRow.components[0].style).toBe(ButtonStyle.Danger);
  });

  it("renders navigation row with bounded states when multiple chooser pages exist", () => {
    const pageZero = buildRangeChooserComponents({
      locale: "en-US",
      totalCount: 550,
      pageSize: 50,
      chooserPage: 0,
      namespace: "test-ns",
      version: "v1",
      baseSegments: ["items"],
    });

    expect(pageZero).toHaveLength(5);
    const navRowZero = pageZero[4] as ActionRowData<ButtonComponentData>;
    expect(navRowZero.components).toHaveLength(3);

    const [prevZero, cancelZero, nextZero] = navRowZero.components;
    expect(prevZero.label).toBe("Previous");
    expect(prevZero.disabled).toBe(true);
    expect(cancelZero.label).toBe("Cancel");
    expect(cancelZero.style).toBe(ButtonStyle.Danger);
    expect(nextZero.label).toBe("Next");
    expect(nextZero.disabled).toBe(false);

    const pageOne = buildRangeChooserComponents({
      locale: "en-US",
      totalCount: 550,
      pageSize: 50,
      chooserPage: 1,
      namespace: "test-ns",
      version: "v1",
      baseSegments: ["items"],
    });

    expect(pageOne).toHaveLength(4);
    const navRowOne = pageOne[3] as ActionRowData<ButtonComponentData>;
    const [prevOne, cancelOne, nextOne] = navRowOne.components;
    expect(prevOne.disabled).toBe(false);
    expect(cancelOne.label).toBe("Cancel");
    expect(nextOne.disabled).toBe(true);
  });
});

describe("buildRangeNavigationRows rendering", () => {
  const baseOptions = {
    locale: "en-US",
    pageSize: 24,
    activeRangeIndex: 0,
    namespace: "test",
    version: "v1",
    baseSegments: ["items"],
    overflowButton: {
      type: ComponentType.Button as const,
      style: ButtonStyle.Secondary,
      customId: "open-chooser",
      label: "Select Page",
    },
  };

  it("renders up to five ranges directly", () => {
    const rows = buildRangeNavigationRows({ ...baseOptions, totalCount: 100 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.components.map((button) => button.label)).toEqual(["1-24", "25-48", "49-72", "73-96", "97-100"]);
    expect(rows[0]?.components[0]?.disabled).toBe(true);
  });

  it("uses the chooser beyond five ranges", () => {
    const rows = buildRangeNavigationRows({ ...baseOptions, totalCount: 121 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.components).toEqual([baseOptions.overflowButton]);
  });
});

describe("multi-namespace routing and real seam dispatch", () => {
  it("renders distinct custom IDs that parse back through parseInteractionRoute", () => {
    const buildSegmentsA: RangeChooserRouteSegments = {
      range: (idx) => ["nodes", "range", String(idx)],
      previous: (p) => ["nodes", "page", String(p)],
      next: (p) => ["nodes", "page", String(p)],
      cancel: () => ["nodes", "cancel"],
    };

    const buildSegmentsB: RangeChooserRouteSegments = {
      range: (idx) => ["remove-range", "en-US", String(idx)],
      previous: (p) => ["remove-page", "en-US", String(p)],
      next: (p) => ["remove-page", "en-US", String(p)],
      cancel: () => ["remove-cancel", "en-US"],
    };

    const componentsA = buildRangeChooserComponents({
      locale: "en-US",
      totalCount: 550,
      pageSize: 50,
      chooserPage: 0,
      namespace: "st-presets",
      version: "v1",
      buildSegments: buildSegmentsA,
    });

    const componentsB = buildRangeChooserComponents({
      locale: "en-US",
      totalCount: 550,
      pageSize: 50,
      chooserPage: 0,
      namespace: "moderation",
      version: "v1",
      buildSegments: buildSegmentsB,
    });

    const buttonsA = componentsA
      .filter((c): c is ActionRowData<ButtonComponentData> => c.type === ComponentType.ActionRow)
      .flatMap((row) => row.components);

    const buttonsB = componentsB
      .filter((c): c is ActionRowData<ButtonComponentData> => c.type === ComponentType.ActionRow)
      .flatMap((row) => row.components);

    expect(buttonsA.length).toBeGreaterThan(0);
    expect(buttonsB.length).toBeGreaterThan(0);
    expect(buttonsA.length).toBe(buttonsB.length);

    for (let i = 0; i < buttonsA.length; i += 1) {
      const customIdA = buttonsA[i].customId;
      const customIdB = buttonsB[i].customId;

      expect(customIdA).not.toBe(customIdB);

      const parsedA = parseInteractionRoute(customIdA);
      expect(parsedA).not.toBeNull();
      expect(parsedA?.namespace).toBe("st-presets");
      expect(parsedA?.version).toBe("v1");

      const parsedB = parseInteractionRoute(customIdB);
      expect(parsedB).not.toBeNull();
      expect(parsedB?.namespace).toBe("moderation");
      expect(parsedB?.version).toBe("v1");
    }
  });

  it("dispatches through the real InteractionRouteRegistry seam", async () => {
    let executedA = 0;
    let executedB = 0;

    const registry = new InteractionRouteRegistry([
      {
        namespace: "st-presets",
        version: "v1",
        async execute() {
          executedA += 1;
        },
      },
      {
        namespace: "moderation",
        version: "v1",
        async execute() {
          executedB += 1;
        },
      },
    ]);

    const dummyClient = {} as Client;

    const componentsA = buildRangeChooserComponents({
      locale: "en-US",
      totalCount: 550,
      pageSize: 50,
      chooserPage: 0,
      namespace: "st-presets",
      version: "v1",
      baseSegments: ["nodes"],
    });

    const buttonsA = componentsA
      .filter((c): c is ActionRowData<ButtonComponentData> => c.type === ComponentType.ActionRow)
      .flatMap((row) => row.components);

    for (const button of buttonsA) {
      const result = await registry.dispatchDetailed(dummyClient, { customId: button.customId } as never);
      expect(result).toBe("handled");
    }
    expect(executedA).toBe(buttonsA.length);

    const componentsB = buildRangeChooserComponents({
      locale: "en-US",
      totalCount: 550,
      pageSize: 50,
      chooserPage: 0,
      namespace: "moderation",
      version: "v1",
      baseSegments: ["bulk-remove"],
    });

    const buttonsB = componentsB
      .filter((c): c is ActionRowData<ButtonComponentData> => c.type === ComponentType.ActionRow)
      .flatMap((row) => row.components);

    for (const button of buttonsB) {
      const result = await registry.dispatchDetailed(dummyClient, { customId: button.customId } as never);
      expect(result).toBe("handled");
    }
    expect(executedB).toBe(buttonsB.length);

    const staleResult = await registry.dispatchDetailed(dummyClient, {
      customId: "st-presets:v999:nodes:cancel",
    } as never);
    expect(staleResult).toBe("stale-version");

    const unmatchedResult = await registry.dispatchDetailed(dummyClient, {
      customId: "unknown-ns:v1:nodes:cancel",
    } as never);
    expect(unmatchedResult).toBe("unmatched");
  });
});

describe("component budget", () => {
  it("keeps total components <= 40 when spliced into a full panel payload", () => {
    const chooserComponents = buildRangeChooserComponents({
      locale: "en-US",
      totalCount: 550,
      pageSize: 50,
      chooserPage: 0,
      namespace: "moderation",
      version: "v1",
      baseSegments: ["bulk-remove"],
    });

    const categories = [
      { id: "member-access", label: "Member Access", customId: "moderation:v1:category:en-US:member-access" },
      { id: "user-blacklist", label: "User Blacklist", customId: "moderation:v1:category:en-US:user-blacklist" },
      { id: "whitelist", label: "Whitelist", customId: "moderation:v1:category:en-US:whitelist" },
      { id: "quotas", label: "Quotas", customId: "moderation:v1:category:en-US:quotas" },
    ];

    const payload = {
      components: [
        buildPanelReceiptContainer({
          tone: "info",
          heading: "Page Selection",
          detail: "Select a range of items to manage in bulk.",
        }),
        buildPanelContainer([
          buildCategoryButtonRow(categories, "whitelist"),
          { type: ComponentType.Separator, divider: true, spacing: 1 },
          ...chooserComponents,
        ]),
      ],
      flags: MessageFlags.IsComponentsV2,
    };

    expect(countComponents(payload)).toBeLessThanOrEqual(40);
  });
});
