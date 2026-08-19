import { describe, expect, it } from "bun:test";
import {
  beginPanelInteraction,
  performPanelAction,
  resolveCollectionSelection,
} from "@/utils/discord/interactions/panelController";

describe("collection panel selection", () => {
  const rows = Array.from({ length: 26 }, (_, index) => ({ id: index + 1 }));

  it("pages without truncating and selects the first row in a requested range", () => {
    const selection = resolveCollectionSelection(rows, (row) => row.id, null, 1);
    expect(selection.item?.id).toBe(26);
    expect(selection.visibleItems).toEqual([{ id: 26 }]);
    expect(selection.rangeCount).toBe(2);
  });

  it("selects the row now occupying a removed row's old sorted index", () => {
    const remaining = rows.filter((row) => row.id !== 10);
    const selection = resolveCollectionSelection(remaining, (row) => row.id, 10, 0, 9);
    expect(selection.item?.id).toBe(11);
  });

  it("falls back to the final row after the former final row is removed", () => {
    const selection = resolveCollectionSelection(rows.slice(0, -1), (row) => row.id, 26, 1, 25);
    expect(selection.item?.id).toBe(25);
  });

  it("returns an empty Add-page selection after the final row is removed", () => {
    const selection = resolveCollectionSelection([], (row: { id: number }) => row.id, 1, 0, 0);
    expect(selection.item).toBeNull();
    expect(selection.visibleItems).toEqual([]);
    expect(selection.rangeCount).toBe(1);
  });

  it("acknowledges before authorization and state loading", async () => {
    const calls: string[] = [];
    const state = await beginPanelInteraction({
      acknowledge: async () => {
        calls.push("acknowledge");
      },
      authorize: () => {
        calls.push("authorize");
        return true;
      },
      onDenied: async () => {
        calls.push("denied");
      },
      load: async () => {
        calls.push("load");
        return { id: 1 };
      },
      onMissing: async () => {
        calls.push("missing");
      },
    });
    expect(state).toEqual({ id: 1 });
    expect(calls).toEqual(["acknowledge", "authorize", "load"]);
  });

  it("stops after denial and preserves an explicit reload failure", async () => {
    const denied: string[] = [];
    expect(
      await beginPanelInteraction({
        acknowledge: async () => {
          denied.push("acknowledge");
        },
        authorize: () => false,
        onDenied: async () => {
          denied.push("denied");
        },
        load: async () => {
          denied.push("load");
          return { id: 1 };
        },
        onMissing: async () => {},
      }),
    ).toBeNull();
    expect(denied).toEqual(["acknowledge", "denied"]);

    const actionCalls: string[] = [];
    const action = await performPanelAction(
      async () => {
        actionCalls.push("write");
        return "saved";
      },
      async () => {
        actionCalls.push("reload");
        return null;
      },
    );
    expect(action).toEqual({ result: "saved", state: null });
    expect(actionCalls).toEqual(["write", "reload"]);
  });
});
