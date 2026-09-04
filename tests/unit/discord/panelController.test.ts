import { describe, expect, it } from "bun:test";
import { beginPanelInteraction, performPanelAction } from "@/utils/discord/interactions/panelController";

describe("panel controller lifecycle", () => {
  it("acknowledges before authorization and state loading", async () => {
    const calls: string[] = [];
    const interaction = {
      deferUpdate: async () => {
        calls.push("acknowledge");
      },
    };
    const state = await beginPanelInteraction(interaction, {
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
    const interaction = {
      deferUpdate: async () => {
        denied.push("acknowledge");
      },
    };
    expect(
      await beginPanelInteraction(interaction, {
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

describe("panelController guarded delivery exports", () => {
  it("re-exports deliverGuardedPanel and buildPanelFallbackPayload", async () => {
    const { deliverGuardedPanel, buildPanelFallbackPayload } = await import(
      "@/utils/discord/interactions/panelController"
    );
    expect(typeof deliverGuardedPanel).toBe("function");
    expect(typeof buildPanelFallbackPayload).toBe("function");

    const fallback = buildPanelFallbackPayload("en-US");
    expect(fallback.flags).toBeDefined();

    let delivered: unknown;
    const target = {
      editReply: async (payload: unknown) => {
        delivered = payload;
        return { id: "ok" };
      },
    };

    await deliverGuardedPanel(target, fallback, { method: "editReply" });
    expect(delivered).toEqual(fallback);
  });
});
