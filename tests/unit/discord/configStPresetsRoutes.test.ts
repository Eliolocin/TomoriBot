import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import type { Client } from "discord.js";
import type { ConfigScope } from "@/utils/discord/interactions/configRouteContext";
import { createConfigInteractionRoute } from "@/utils/discord/interactions/configRoutes";
import { CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER } from "@/utils/discord/configPanelCatalog";
import type { StPresetNodeRow, StPresetRow } from "@/types/db/schema";
import { stPresetOperations } from "@/utils/stPreset/stPresetOperations";
import { buildStPresetsNodesModalFieldId } from "@/utils/discord/ui/stPresetsPanel";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

function makePreset(): StPresetRow {
  return {
    preset_id: 23,
    server_id: 15,
    preset_name: "Geechan",
    raw_json: {},
    is_active: true,
    description: null,
    created_at: new Date(0),
    updated_at: new Date(0),
  };
}

function makeNode(identifier: string, isEnabled: boolean): StPresetNodeRow {
  return {
    node_id: identifier === "nsfw-prompt" ? 1 : 2,
    preset_id: 23,
    identifier,
    name: identifier,
    role: "system",
    content: identifier,
    is_marker: false,
    is_enabled: isEnabled,
    is_comment: false,
    node_order: identifier === "nsfw-prompt" ? 1 : 2,
    injection_position: 0,
    injection_depth: 4,
    injection_order: 100,
  };
}

function makeScope(): ConfigScope {
  return {
    serverDiscId: "guild-1",
    guildId: "guild-1",
    internalServerId: 15,
    userId: 99,
    actor: { workspaceKind: "guild", isManager: true },
    personas: [{ server_id: 15, persona_id: 1, is_alter: false, config: {} } as never],
    readStatus: "fresh",
  };
}

function makeInteraction(
  customId: string,
  kind: "button" | "modal",
  manager: boolean,
  id = "interaction-1",
): Record<string, unknown> {
  return {
    id,
    customId,
    guildId: "guild-1",
    user: { id: manager ? "manager" : "member" },
    memberPermissions: { has: () => manager },
    isButton: () => kind === "button",
    isStringSelectMenu: () => false,
    isModalSubmit: () => kind === "modal",
    deferUpdate: async () => {},
    editReply: async () => {},
    reply: async () => {},
    fields: { getTextInputValue: () => "" },
  };
}

describe("Config-hosted ST preset node routes", () => {
  it("writes the manager modal map and rejects a replay or non-manager submission", async () => {
    const scope = makeScope();
    const data = {
      scopeDiscId: "guild-1",
      serverId: 15,
      readStatus: "fresh" as const,
      presets: [makePreset()],
      activePresetId: 23,
    };
    const nodes = [makeNode("nsfw-prompt", true), makeNode("nsfw-simplified-prompt", false)];
    const nonce = "nodeNonce123";
    let modalCustomId = "";
    let capturedInput: Parameters<typeof stPresetOperations.updateStPresetNodes>[0] | undefined;
    const checkboxFieldIds: string[] = [];

    const loadScopeData = spyOn(stPresetOperations, "loadStPresetScopeData").mockResolvedValue(data);
    const loadNodes = spyOn(stPresetOperations, "loadToggleableNodes").mockResolvedValue(nodes);
    const updateNodes = spyOn(stPresetOperations, "updateStPresetNodes").mockImplementation(async (input) => {
      capturedInput = input;
      return true;
    });

    const route = createConfigInteractionRoute({
      resolveScope: async () => scope,
      createNonce: () => nonce,
      showModal: async (_interaction, payload) => {
        modalCustomId = payload.custom_id;
      },
      takeCheckboxValues: (_interactionId, fieldId) => {
        checkboxFieldIds.push(fieldId);
        const groupIndex = Number(fieldId.split("_")[1]);
        return groupIndex === 0 ? ["nsfw-simplified-prompt"] : [];
      },
      recordAction: () => {},
    });

    try {
      const openRoute = { action: "nodes-open" as const, locale: "en-US", presetId: 23 };
      await route.execute(
        {} as Client,
        makeInteraction(CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.buildRouteId(openRoute), "button", true) as never,
        {
          namespace: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.namespace,
          version: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.version,
          segments: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.buildRouteSegments(openRoute),
        },
      );

      expect(modalCustomId).toBe(
        CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.buildRouteId({
          action: "nodes-submit",
          locale: "en-US",
          presetId: 23,
          nonce,
        }),
      );

      const submitRoute = { action: "nodes-submit" as const, locale: "en-US", presetId: 23, nonce };
      const parsedSubmit = {
        namespace: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.namespace,
        version: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.version,
        segments: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.buildRouteSegments(submitRoute),
      };
      await route.execute(
        {} as Client,
        makeInteraction(modalCustomId, "modal", true, "modal-manager") as never,
        parsedSubmit,
      );

      expect(capturedInput).toBeDefined();
      expect(capturedInput?.serverId).toBe(15);
      expect(capturedInput?.presetId).toBe(23);
      if (!capturedInput) throw new Error("Canonical node update was not reached");
      expect([...capturedInput.enabledMap.entries()]).toEqual([
        ["nsfw-prompt", false],
        ["nsfw-simplified-prompt", true],
      ]);
      expect(checkboxFieldIds).toEqual(
        [0, 1, 2, 3, 4].map((groupIndex) => buildStPresetsNodesModalFieldId(nonce, groupIndex)),
      );
      expect(updateNodes).toHaveBeenCalledTimes(1);

      await route.execute(
        {} as Client,
        makeInteraction(modalCustomId, "modal", true, "modal-replay") as never,
        parsedSubmit,
      );
      await route.execute(
        {} as Client,
        makeInteraction(modalCustomId, "modal", false, "modal-member") as never,
        parsedSubmit,
      );

      expect(updateNodes).toHaveBeenCalledTimes(1);
    } finally {
      updateNodes.mockRestore();
      loadNodes.mockRestore();
      loadScopeData.mockRestore();
    }
  });
});
