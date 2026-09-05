import { beforeAll, describe, expect, it } from "bun:test";
import { ButtonStyle, ComponentType } from "discord.js";
import type { PanelReceipt } from "@/types/discord/panel";
import {
  buildConditioningRouteId,
  computeConditioningAggregateFingerprint,
  parseConditioningPanelRoute,
  type ConditioningAggregateEntry,
  type ConditioningPanelRoute,
} from "@/utils/discord/conditioningPanelCatalog";
import { parseInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import { buildConditioningPanelPayload, buildConditioningRemoveModal } from "@/utils/discord/ui/conditioningPanel";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => {
  await initializeLocalizer();
});

function createMockEntry(id: number, overrides: Partial<ConditioningAggregateEntry> = {}): ConditioningAggregateEntry {
  return {
    serverId: 1,
    personaName: `Persona${id}`,
    personaLineageId: 100 + id,
    conditioningType: id % 2 === 0 ? "reward" : "punish",
    actionKey: `action_${id}`,
    reasonText: `Reason for entry ${id}`,
    reasonNormalized: `reason for entry ${id}`,
    actionText: null,
    totalCount: id + 1,
    updatedAt: new Date(1700000000000 + id * 1000),
    userDiscIds: ["123456789012345678"],
    conditioningIds: [id],
    ...overrides,
  };
}

describe("conditioning panel route catalog", () => {
  it("round-trips every valid route action through codec encode and decode", () => {
    const routes: ConditioningPanelRoute[] = [
      { action: "range", locale: "en-US", range: 0 },
      { action: "range", locale: "en-US", range: 42 },
      { action: "remove-open", locale: "en-US", range: 3, fp: "aB9_-xY1" },
      { action: "remove-submit", locale: "en-US", range: 5, fp: "aB9_-xY1", nonce: "nonce-12345678" },
    ];

    for (const route of routes) {
      const customId = buildConditioningRouteId(route);
      const parsed = parseInteractionRoute(customId);
      expect(parsed).not.toBeNull();
      if (!parsed) throw new Error("Expected parsed interaction route");
      expect(parseConditioningPanelRoute(parsed)).toEqual(route);
    }
  });

  it("rejects routes with foreign namespace, bumped version, or invalid segments", () => {
    expect(
      parseConditioningPanelRoute({ namespace: "other", version: "v1", segments: ["range", "en-US", "0"] }),
    ).toBeNull();
    expect(
      parseConditioningPanelRoute({ namespace: "conditioning", version: "v2", segments: ["range", "en-US", "0"] }),
    ).toBeNull();
    expect(
      parseConditioningPanelRoute({
        namespace: "conditioning",
        version: "v1",
        segments: ["range", "invalid-locale", "0"],
      }),
    ).toBeNull();
    expect(
      parseConditioningPanelRoute({ namespace: "conditioning", version: "v1", segments: ["range", "en-US", "-1"] }),
    ).toBeNull();
    expect(
      parseConditioningPanelRoute({
        namespace: "conditioning",
        version: "v1",
        segments: ["remove-open", "en-US", "0", "short"],
      }),
    ).toBeNull();
    expect(
      parseConditioningPanelRoute({
        namespace: "conditioning",
        version: "v1",
        segments: ["remove-submit", "en-US", "0", "aB9_-xY1", "short"],
      }),
    ).toBeNull();
    expect(
      parseConditioningPanelRoute({ namespace: "conditioning", version: "v1", segments: ["unknown-action", "en-US"] }),
    ).toBeNull();
  });

  it("keeps the longest realistic route ID strictly under the 100 character limit", () => {
    const route: ConditioningPanelRoute = {
      action: "remove-submit",
      locale: "en-US",
      range: 99999,
      fp: "aB9_-xY1",
      nonce: "a".repeat(32),
    };
    const customId = buildConditioningRouteId(route);
    expect(customId.length).toBeLessThan(100);
  });
});

describe("conditioning aggregate fingerprint", () => {
  it("remains stable when metadata changes but visible tuples and range are identical", () => {
    const entryA = createMockEntry(1);
    const entryB = createMockEntry(2);

    const fp1 = computeConditioningAggregateFingerprint([entryA, entryB], 0);

    const entryAModifiedMeta = {
      ...entryA,
      personaName: "RenamedPersona",
      totalCount: 999,
      updatedAt: new Date(0),
      serverId: 99,
    };
    const fp2 = computeConditioningAggregateFingerprint([entryAModifiedMeta, entryB], 0);

    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[A-Za-z0-9_-]{8}$/);
  });

  it("changes when any tuple field or range index changes", () => {
    const entryA = createMockEntry(1);
    const entryB = createMockEntry(2);
    const baseline = computeConditioningAggregateFingerprint([entryA, entryB], 0);

    expect(computeConditioningAggregateFingerprint([entryA, entryB], 1)).not.toBe(baseline);
    expect(computeConditioningAggregateFingerprint([{ ...entryA, conditioningType: "reward" }, entryB], 0)).not.toBe(
      baseline,
    );
    expect(computeConditioningAggregateFingerprint([{ ...entryA, actionKey: "different_action" }, entryB], 0)).not.toBe(
      baseline,
    );
    expect(
      computeConditioningAggregateFingerprint([{ ...entryA, reasonNormalized: "different reason" }, entryB], 0),
    ).not.toBe(baseline);
    expect(computeConditioningAggregateFingerprint([{ ...entryA, personaLineageId: 999 }, entryB], 0)).not.toBe(
      baseline,
    );
    expect(computeConditioningAggregateFingerprint([entryB, entryA], 0)).not.toBe(baseline);
  });
});

describe("conditioning panel payload builder", () => {
  it("renders empty state when there are no entries", () => {
    const payload = buildConditioningPanelPayload({
      locale: "en-US",
      entries: [],
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("Server Conditioning Memories");
    expect(serialized).toContain("No Conditioning Memories");
    expect(serialized).not.toContain("Showing");
    expect(serialized).not.toContain("general.pagination");

    const container = payload.components[0] as {
      components: Array<{ type: number; components?: Array<{ style?: number; disabled?: boolean }> }>;
    };
    const actionRow = container.components.find((c) => c.type === ComponentType.ActionRow);
    expect(actionRow).toBeDefined();
    const removalButton = actionRow?.components?.[0];
    expect(removalButton?.style).toBe(ButtonStyle.Danger);
    expect(removalButton?.disabled).toBe(true);
  });

  it("renders expected entry count and clamps out-of-range requests", () => {
    const entries = Array.from({ length: 25 }, (_, i) => createMockEntry(i + 1));

    const page0 = buildConditioningPanelPayload({
      locale: "en-US",
      entries,
      rangeIndex: 0,
    });
    const serialized0 = JSON.stringify(page0);
    expect(serialized0).toContain("Showing 10 of 25 entries (15 hidden).");
    expect(serialized0).toContain("Persona1");
    expect(serialized0).toContain("Persona10");
    expect(serialized0).not.toContain("Persona11");

    const page2 = buildConditioningPanelPayload({
      locale: "en-US",
      entries,
      rangeIndex: 2,
    });
    const serialized2 = JSON.stringify(page2);
    expect(serialized2).toContain("Persona21");
    expect(serialized2).toContain("Persona25");
    expect(serialized2).not.toContain("Persona1");

    const clampedHigh = buildConditioningPanelPayload({
      locale: "en-US",
      entries,
      rangeIndex: 999,
    });
    expect(JSON.stringify(clampedHigh)).toBe(serialized2);

    const clampedLow = buildConditioningPanelPayload({
      locale: "en-US",
      entries,
      rangeIndex: -10,
    });
    expect(JSON.stringify(clampedLow)).toBe(serialized0);
  });

  it("renders the localized action label rather than the raw action key", () => {
    const payload = buildConditioningPanelPayload({
      locale: "en-US",
      entries: [createMockEntry(0, { conditioningType: "reward", actionKey: "headpat" })],
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("Headpat");
    expect(serialized).not.toContain("history_label");
  });

  it("builds the removal modal from a label wrapper around a checkbox group", () => {
    const modal = buildConditioningRemoveModal("en-US", 0, "abcd1234", "nonce123", [
      createMockEntry(0, { conditioningType: "reward", actionKey: "headpat" }),
    ]);

    // Discord component types are bare numbers, so nothing but this assertion distinguishes a
    // CheckboxGroup from a FileUpload. A FileUpload submits no values, and removal treats an
    // absent value as unchecked, so the wrong number here deletes every presented row.
    expect(modal.components).toHaveLength(1);
    const wrapper = modal.components[0] as { type: number; component: { type: number; options: unknown[] } };
    expect(wrapper.type).toBe(18);
    expect(wrapper.component.type).toBe(22);
    expect(wrapper.component.options).toHaveLength(1);
    expect((wrapper.component.options[0] as { default: boolean }).default).toBe(true);
  });

  it("includes receipt container when a receipt is provided", () => {
    const receipt: PanelReceipt = {
      tone: "success",
      heading: "Conditioning Cleared",
      detail: "Deleted 3 conditioning records.",
    };
    const payload = buildConditioningPanelPayload({
      locale: "en-US",
      entries: [createMockEntry(1)],
      receipt,
    });

    expect(payload.components).toHaveLength(2);
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("Conditioning Cleared");
    expect(serialized).toContain("Deleted 3 conditioning records.");
  });
});
