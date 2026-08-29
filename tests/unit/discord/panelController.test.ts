import { describe, expect, it } from "bun:test";
import { beginPanelInteraction, performPanelAction } from "@/utils/discord/interactions/panelController";

describe("panel controller lifecycle", () => {
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
