import { describe, expect, it } from "bun:test";
import { PANEL_ACTIONS, resolveProviderPanelAction, type ProviderPanelResourceAndVerb } from "@/constants/panelActions";

describe("panelActions registry", () => {
  const grammarRegex = /^[a-z0-9-]+\.(workspace|personal)\.[a-z0-9-]+\.[a-z0-9-]+$/;

  it("conforms every action identifier to <surface>.<scope>.<resource>.<verb>", () => {
    for (const action of PANEL_ACTIONS) {
      expect(action).toMatch(grammarRegex);
    }
  });

  it("contains no duplicate action identifiers", () => {
    const unique = new Set(PANEL_ACTIONS);
    expect(unique.size).toBe(PANEL_ACTIONS.length);
  });

  it("resolves provider panel actions across server and personal scopes", () => {
    const verbs: ProviderPanelResourceAndVerb[] = [
      "provider.add",
      "provider.edit",
      "endpoint.add",
      "endpoint.edit",
      "model.save",
      "entry.remove",
    ];

    for (const verb of verbs) {
      const serverAction = resolveProviderPanelAction("server", verb);
      const undefinedScopeAction = resolveProviderPanelAction(undefined, verb);
      const personalAction = resolveProviderPanelAction("personal", verb);

      expect(serverAction).toBe(`providers.workspace.${verb}`);
      expect(undefinedScopeAction).toBe(`providers.workspace.${verb}`);
      expect(personalAction).toBe(`providers.personal.${verb}`);

      expect(PANEL_ACTIONS).toContain(serverAction);
      expect(PANEL_ACTIONS).toContain(personalAction);
    }
  });
});
