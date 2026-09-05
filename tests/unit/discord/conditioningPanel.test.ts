import { beforeAll, describe, expect, it } from "bun:test";
import { ButtonStyle } from "discord.js";
import {
  buildConditioningRouteId,
  computeConditioningAggregateFingerprint,
  parseConditioningPanelRoute,
  type ConditioningAggregateEntry,
  type ConditioningPanelRoute,
} from "@/utils/discord/conditioningPanelCatalog";
import { parseInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import {
  CONDITIONING_PAGE_SELECT_MAX_BUTTONS,
  CONDITIONING_PAGE_SELECT_MAX_ENTRIES,
  buildConditioningPageSelectRows,
  buildConditioningRemoveModal,
} from "@/utils/discord/ui/conditioningPanel";
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
      { action: "page", locale: "en-US", page: 0 },
      { action: "page", locale: "en-US", page: 42 },
      { action: "remove-submit", locale: "en-US", page: 5, fp: "aB9_-xY1", nonce: "nonce-12345678" },
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
      parseConditioningPanelRoute({ namespace: "other", version: "v1", segments: ["page", "en-US", "0"] }),
    ).toBeNull();
    expect(
      parseConditioningPanelRoute({ namespace: "conditioning", version: "v2", segments: ["page", "en-US", "0"] }),
    ).toBeNull();
    expect(
      parseConditioningPanelRoute({
        namespace: "conditioning",
        version: "v1",
        segments: ["page", "invalid-locale", "0"],
      }),
    ).toBeNull();
    expect(
      parseConditioningPanelRoute({ namespace: "conditioning", version: "v1", segments: ["page", "en-US", "-1"] }),
    ).toBeNull();
    expect(
      parseConditioningPanelRoute({
        namespace: "conditioning",
        version: "v1",
        segments: ["remove-submit", "en-US", "0", "short"],
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
      page: 99999,
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

describe("conditioning removal modal builder", () => {
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

  it("renders the localized action label on modal checkbox options rather than raw action key", () => {
    const modal = buildConditioningRemoveModal("en-US", 0, "abcd1234", "nonce123", [
      createMockEntry(0, { conditioningType: "reward", actionKey: "headpat" }),
    ]);

    const serialized = JSON.stringify(modal);
    expect(serialized).toContain("Headpat");
    expect(serialized).not.toContain("history_label");
  });

  it("builds page select button rows for batches above the modal ceiling", () => {
    const rows = buildConditioningPageSelectRows("en-US", 125);
    expect(rows).toHaveLength(1);
    expect(rows[0].components).toHaveLength(3);
    expect(rows[0].components[0].label).toBe("1-50");
    expect(rows[0].components[1].label).toBe("51-100");
    expect(rows[0].components[2].label).toBe("101-125");
    expect(rows[0].components[0].style).toBe(ButtonStyle.Secondary);
  });
});

describe("conditioning page select overflow", () => {
  it("never exceeds Discord's five action rows, however many entries exist", () => {
    const rows = buildConditioningPageSelectRows("en-US", CONDITIONING_PAGE_SELECT_MAX_ENTRIES * 4);

    // A legacy message rejects a sixth action row outright, so an uncapped selector would make the
    // whole reply fail rather than degrade.
    expect(rows.length).toBeLessThanOrEqual(5);
    const buttons = rows.flatMap((row) => row.components);
    expect(buttons).toHaveLength(CONDITIONING_PAGE_SELECT_MAX_BUTTONS);
    for (const row of rows) {
      expect(row.components.length).toBeLessThanOrEqual(5);
    }
  });

  it("does not cap a server that fits", () => {
    const rows = buildConditioningPageSelectRows("en-US", 120);
    expect(rows.flatMap((row) => row.components)).toHaveLength(3);
  });
});
