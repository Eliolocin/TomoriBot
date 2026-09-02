import { beforeAll, describe, expect, it } from "bun:test";
import { ButtonStyle, ComponentType, type ActionRowData, type ButtonComponentData } from "discord.js";
import { parseInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import { MODERATION_PANEL_RANGE_SIZE, resolveRangeSelection } from "@/utils/discord/interactions/panelController";
import { buildPaginationRow, type PaginationRouteSegments } from "@/utils/discord/ui/panel";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const testRouteSegments: PaginationRouteSegments = {
  page: (rangeIndex) => ["items", "page", String(rangeIndex)],
};

function createPaginationRow(
  rangeIndex: number,
  rangeCount: number,
  disabled = false,
): ActionRowData<ButtonComponentData> | null {
  return buildPaginationRow({
    locale: "en-US",
    rangeIndex,
    rangeCount,
    namespace: "test-panel",
    version: "v1",
    buildSegments: testRouteSegments,
    disabled,
  });
}

describe("resolveRangeSelection arithmetic and boundaries", () => {
  it("handles empty collection as single empty page", () => {
    const result = resolveRangeSelection([], 0, 10);
    expect(result.rangeIndex).toBe(0);
    expect(result.rangeCount).toBe(1);
    expect(result.totalCount).toBe(0);
    expect(result.visibleItems).toEqual([]);
  });

  it("handles single item collection", () => {
    const items = ["item-1"];
    const result = resolveRangeSelection(items, 0, 10);
    expect(result.rangeIndex).toBe(0);
    expect(result.rangeCount).toBe(1);
    expect(result.totalCount).toBe(1);
    expect(result.visibleItems).toEqual(["item-1"]);
  });

  it("handles exact page boundary sizing", () => {
    const items = Array.from({ length: 20 }, (_, i) => `item-${i + 1}`);
    const page0 = resolveRangeSelection(items, 0, 10);
    expect(page0.rangeIndex).toBe(0);
    expect(page0.rangeCount).toBe(2);
    expect(page0.totalCount).toBe(20);
    expect(page0.visibleItems).toHaveLength(10);
    expect(page0.visibleItems[0]).toBe("item-1");
    expect(page0.visibleItems[9]).toBe("item-10");

    const page1 = resolveRangeSelection(items, 1, 10);
    expect(page1.rangeIndex).toBe(1);
    expect(page1.rangeCount).toBe(2);
    expect(page1.visibleItems).toHaveLength(10);
    expect(page1.visibleItems[0]).toBe("item-11");
    expect(page1.visibleItems[9]).toBe("item-20");
  });

  it("handles one item over page boundary", () => {
    const items = Array.from({ length: 21 }, (_, i) => `item-${i + 1}`);
    const page2 = resolveRangeSelection(items, 2, 10);
    expect(page2.rangeIndex).toBe(2);
    expect(page2.rangeCount).toBe(3);
    expect(page2.totalCount).toBe(21);
    expect(page2.visibleItems).toEqual(["item-21"]);
  });

  it("clamps negative requested range index to zero", () => {
    const items = ["a", "b", "c"];
    const result = resolveRangeSelection(items, -5, 10);
    expect(result.rangeIndex).toBe(0);
    expect(result.visibleItems).toEqual(["a", "b", "c"]);
  });

  it("clamps excessive requested range index to last page", () => {
    const items = Array.from({ length: 25 }, (_, i) => `item-${i + 1}`);
    const result = resolveRangeSelection(items, 999, 10);
    expect(result.rangeIndex).toBe(2);
    expect(result.rangeCount).toBe(3);
    expect(result.visibleItems).toEqual(["item-21", "item-22", "item-23", "item-24", "item-25"]);
  });

  it("defaults to MODERATION_PANEL_RANGE_SIZE (10) when rangeSize is omitted", () => {
    const items = Array.from({ length: 15 }, (_, i) => `item-${i + 1}`);
    const result = resolveRangeSelection(items, 0);
    expect(MODERATION_PANEL_RANGE_SIZE).toBe(10);
    expect(result.rangeCount).toBe(2);
    expect(result.visibleItems).toHaveLength(10);
  });
});

describe("buildPaginationRow boundary states", () => {
  it("returns null when total rangeCount <= 1", () => {
    expect(createPaginationRow(0, 1)).toBeNull();
    expect(createPaginationRow(0, 0)).toBeNull();
    expect(createPaginationRow(-1, 1)).toBeNull();
  });

  it("renders first page with Previous disabled, Indicator disabled, and Next enabled", () => {
    const row = createPaginationRow(0, 3);
    expect(row).not.toBeNull();
    expect(row?.type).toBe(ComponentType.ActionRow);
    expect(row?.components).toHaveLength(3);

    const [prevBtn, indicatorBtn, nextBtn] = row?.components ?? [];
    expect(prevBtn?.label).toBe("← Previous");
    expect(prevBtn?.style).toBe(ButtonStyle.Secondary);
    expect(prevBtn?.disabled).toBe(true);

    expect(indicatorBtn?.label).toBe("Page 1 of 3");
    expect(indicatorBtn?.style).toBe(ButtonStyle.Secondary);
    expect(indicatorBtn?.disabled).toBe(true);

    expect(nextBtn?.label).toBe("Next →");
    expect(nextBtn?.style).toBe(ButtonStyle.Secondary);
    expect(nextBtn?.disabled).toBe(false);
  });

  it("renders middle page with both Previous and Next enabled", () => {
    const row = createPaginationRow(1, 3);
    expect(row).not.toBeNull();

    const [prevBtn, indicatorBtn, nextBtn] = row?.components ?? [];
    expect(prevBtn?.disabled).toBe(false);
    expect(indicatorBtn?.label).toBe("Page 2 of 3");
    expect(indicatorBtn?.disabled).toBe(true);
    expect(nextBtn?.disabled).toBe(false);
  });

  it("renders last page with Previous enabled, Indicator disabled, and Next disabled", () => {
    const row = createPaginationRow(2, 3);
    expect(row).not.toBeNull();

    const [prevBtn, indicatorBtn, nextBtn] = row?.components ?? [];
    expect(prevBtn?.disabled).toBe(false);
    expect(indicatorBtn?.label).toBe("Page 3 of 3");
    expect(indicatorBtn?.disabled).toBe(true);
    expect(nextBtn?.disabled).toBe(true);
  });

  it("clamps out-of-bounds rangeIndex inputs cleanly", () => {
    const negativeRow = createPaginationRow(-5, 3);
    expect(negativeRow?.components[0]?.disabled).toBe(true);
    expect(negativeRow?.components[1]?.label).toBe("Page 1 of 3");
    expect(negativeRow?.components[2]?.disabled).toBe(false);

    const excessiveRow = createPaginationRow(99, 3);
    expect(excessiveRow?.components[0]?.disabled).toBe(false);
    expect(excessiveRow?.components[1]?.label).toBe("Page 3 of 3");
    expect(excessiveRow?.components[2]?.disabled).toBe(true);
  });

  it("emits unique component IDs where navigation routes parse and indicator is non-routable", () => {
    const row = createPaginationRow(1, 3);
    expect(row).not.toBeNull();

    const [prevBtn, indicatorBtn, nextBtn] = row?.components ?? [];
    const ids = [prevBtn?.customId, indicatorBtn?.customId, nextBtn?.customId];
    expect(new Set(ids).size).toBe(3);

    const parsedPrev = parseInteractionRoute(prevBtn?.customId ?? "");
    expect(parsedPrev).not.toBeNull();
    expect(parsedPrev?.namespace).toBe("test-panel");
    expect(parsedPrev?.version).toBe("v1");
    expect(parsedPrev?.segments).toEqual(["items", "page", "0"]);

    const parsedNext = parseInteractionRoute(nextBtn?.customId ?? "");
    expect(parsedNext).not.toBeNull();
    expect(parsedNext?.namespace).toBe("test-panel");
    expect(parsedNext?.version).toBe("v1");
    expect(parsedNext?.segments).toEqual(["items", "page", "2"]);

    expect(parseInteractionRoute(indicatorBtn?.customId ?? "")).toBeNull();
  });
});

describe("deletion-clamping scenarios", () => {
  it("clamps to previous page when the sole item on the final page is deleted", () => {
    // Initial state: 21 items -> 3 pages (10, 10, 1)
    const initialItems = Array.from({ length: 21 }, (_, i) => `doc-${i + 1}`);
    const beforeDeletion = resolveRangeSelection(initialItems, 2, 10);
    expect(beforeDeletion.rangeIndex).toBe(2);
    expect(beforeDeletion.rangeCount).toBe(3);
    expect(beforeDeletion.visibleItems).toEqual(["doc-21"]);

    // Actor deletes doc-21 -> 20 items remain (2 pages of 10)
    const remainingItems = initialItems.slice(0, 20);

    // Repaint requests the old rangeIndex 2, which should clamp to index 1
    const afterDeletion = resolveRangeSelection(remainingItems, 2, 10);
    expect(afterDeletion.rangeIndex).toBe(1);
    expect(afterDeletion.rangeCount).toBe(2);
    expect(afterDeletion.totalCount).toBe(20);
    expect(afterDeletion.visibleItems).toHaveLength(10);
    expect(afterDeletion.visibleItems[0]).toBe("doc-11");
    expect(afterDeletion.visibleItems[9]).toBe("doc-20");

    // Pagination row updates accordingly: Page 2 of 2 with Next disabled
    const row = createPaginationRow(afterDeletion.rangeIndex, afterDeletion.rangeCount);
    expect(row).not.toBeNull();
    expect(row?.components[1].label).toBe("Page 2 of 2");
    expect(row?.components[0].disabled).toBe(false);
    expect(row?.components[2].disabled).toBe(true);
  });

  it("clamps across multiple page drops during bulk deletion", () => {
    // 50 items (5 pages of 10) dropping to 15 items (2 pages of 10)
    const bulkRemaining = Array.from({ length: 15 }, (_, i) => `item-${i + 1}`);
    const staleRangeIndex = 4; // previously on page 5

    const resolved = resolveRangeSelection(bulkRemaining, staleRangeIndex, 10);
    expect(resolved.rangeIndex).toBe(1);
    expect(resolved.rangeCount).toBe(2);
    expect(resolved.visibleItems).toEqual(["item-11", "item-12", "item-13", "item-14", "item-15"]);

    const row = createPaginationRow(resolved.rangeIndex, resolved.rangeCount);
    expect(row?.components[1].label).toBe("Page 2 of 2");
    expect(row?.components[2].disabled).toBe(true);
  });

  it("omits pagination row when deletion shrinks collection to single page or zero", () => {
    const singlePageRemaining = ["item-1", "item-2"];
    const resolvedSingle = resolveRangeSelection(singlePageRemaining, 3, 10);
    expect(resolvedSingle.rangeIndex).toBe(0);
    expect(resolvedSingle.rangeCount).toBe(1);
    expect(createPaginationRow(resolvedSingle.rangeIndex, resolvedSingle.rangeCount)).toBeNull();

    const emptyRemaining: string[] = [];
    const resolvedEmpty = resolveRangeSelection(emptyRemaining, 2, 10);
    expect(resolvedEmpty.rangeIndex).toBe(0);
    expect(resolvedEmpty.rangeCount).toBe(1);
    expect(createPaginationRow(resolvedEmpty.rangeIndex, resolvedEmpty.rangeCount)).toBeNull();
  });
});

describe("stale-state scenarios", () => {
  it("disables all navigation buttons when row disabled flag is true", () => {
    const row = createPaginationRow(1, 3, true);
    expect(row).not.toBeNull();

    const [prevBtn, indicatorBtn, nextBtn] = row?.components ?? [];
    expect(prevBtn?.disabled).toBe(true);
    expect(indicatorBtn?.disabled).toBe(true);
    expect(nextBtn?.disabled).toBe(true);
    expect(indicatorBtn?.label).toBe("Page 2 of 3");
  });

  it("safely handles stale route submissions against mutated backend state", () => {
    const freshState = ["alpha", "beta"];
    // Client clicked a stale Next button requesting rangeIndex 5
    const resolved = resolveRangeSelection(freshState, 5, 10);
    expect(resolved.rangeIndex).toBe(0);
    expect(resolved.rangeCount).toBe(1);
    expect(resolved.visibleItems).toEqual(["alpha", "beta"]);
  });

  it("produces deterministic indicator IDs preventing churn across rapid stale repaints", () => {
    const rowA = createPaginationRow(1, 3);
    const rowB = createPaginationRow(1, 3);
    expect(rowA?.components[1]?.customId).toBe(rowB?.components[1]?.customId);
  });
});

describe("concurrent-addition scenarios", () => {
  it("enables Next button when concurrent additions create new pages", () => {
    // Initially on last page: 15 items -> 2 pages (10, 5), parked on page 2 of 2
    const initialItems = Array.from({ length: 15 }, (_, i) => `item-${i + 1}`);
    const beforeAdd = resolveRangeSelection(initialItems, 1, 10);
    expect(beforeAdd.rangeIndex).toBe(1);
    expect(beforeAdd.rangeCount).toBe(2);

    const initialRow = createPaginationRow(beforeAdd.rangeIndex, beforeAdd.rangeCount);
    expect(initialRow?.components[1].label).toBe("Page 2 of 2");
    expect(initialRow?.components[2].disabled).toBe(true); // Next was disabled

    // 15 items added concurrently -> 30 items (3 pages of 10)
    const expandedItems = Array.from({ length: 30 }, (_, i) => `item-${i + 1}`);
    const afterAdd = resolveRangeSelection(expandedItems, 1, 10);
    expect(afterAdd.rangeIndex).toBe(1);
    expect(afterAdd.rangeCount).toBe(3);
    expect(afterAdd.visibleItems).toHaveLength(10);
    expect(afterAdd.visibleItems[0]).toBe("item-11");
    expect(afterAdd.visibleItems[9]).toBe("item-20");

    const updatedRow = createPaginationRow(afterAdd.rangeIndex, afterAdd.rangeCount);
    expect(updatedRow?.components[1].label).toBe("Page 2 of 3");
    expect(updatedRow?.components[0].disabled).toBe(false); // Previous enabled
    expect(updatedRow?.components[2].disabled).toBe(false); // Next is now enabled!
  });

  it("introduces pagination row when single page expands past page size", () => {
    // Initially 5 items -> single page, no pagination row
    const initialItems = Array.from({ length: 5 }, (_, i) => `item-${i + 1}`);
    const beforeAdd = resolveRangeSelection(initialItems, 0, 10);
    expect(createPaginationRow(beforeAdd.rangeIndex, beforeAdd.rangeCount)).toBeNull();

    // Concurrently expanded to 12 items -> 2 pages
    const expandedItems = Array.from({ length: 12 }, (_, i) => `item-${i + 1}`);
    const afterAdd = resolveRangeSelection(expandedItems, 0, 10);
    expect(afterAdd.rangeCount).toBe(2);

    const newRow = createPaginationRow(afterAdd.rangeIndex, afterAdd.rangeCount);
    expect(newRow).not.toBeNull();
    expect(newRow?.components[0].disabled).toBe(true);
    expect(newRow?.components[1].label).toBe("Page 1 of 2");
    expect(newRow?.components[2].disabled).toBe(false);
  });
});
