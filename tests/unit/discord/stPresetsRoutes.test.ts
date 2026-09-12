import { beforeAll, describe, expect, it } from "bun:test";
import type { ButtonInteraction, Client, ModalSubmitInteraction, StringSelectMenuInteraction } from "discord.js";
import type { StPresetNodeRow, StPresetRow } from "@/types/db/schema";
import { CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER } from "@/utils/discord/configPanelCatalog";
import {
  createStPresetsInteractionRoute,
  type StPresetsRouteDependencies,
} from "@/utils/discord/interactions/stPresetsRoutes";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

function preset(id: number, overrides: Partial<StPresetRow> = {}): StPresetRow {
  return {
    preset_id: id,
    server_id: 1,
    preset_name: `Preset ${id}`,
    raw_json: {},
    is_active: false,
    description: `Description ${id}`,
    created_at: new Date(id * 1000),
    updated_at: new Date(id * 1000),
    ...overrides,
  };
}

function node(id: number, overrides: Partial<StPresetNodeRow> = {}): StPresetNodeRow {
  return {
    node_id: id,
    preset_id: 1,
    identifier: `node_${id}`,
    name: `Node ${id}`,
    role: "system",
    content: `Content ${id}`,
    is_marker: false,
    is_enabled: true,
    is_comment: false,
    node_order: id,
    injection_position: 0,
    injection_depth: 4,
    injection_order: 100,
    ...overrides,
  };
}

function makeDependencies(
  calls: string[],
  overrides: Partial<StPresetsRouteDependencies> = {},
): StPresetsRouteDependencies {
  let activeId: number | null = 1;
  const presets = [preset(1, { is_active: true }), preset(2)];

  const snapshots = new Map<string, { presetId: number; identifiers: string[] }>();

  return {
    routeAdapter: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
    resolveScope: async (_interaction, forceRefresh) => {
      calls.push(forceRefresh ? "resolveScope-fresh" : "resolveScope");
      return {
        discordId: "100",
        kind: "guild",
        state: { server_id: 1 } as never,
        data: {
          scopeDiscId: "100",
          serverId: 1,
          readStatus: "fresh",
          presets: presets.map((p) => ({ ...p, is_active: p.preset_id === activeId })),
          activePresetId: activeId,
        },
      };
    },
    operations: {
      activateStPreset: async (input) => {
        calls.push(`activate:${input.presetId}`);
        activeId = input.presetId;
        return true;
      },
      deactivateAllStPresets: async () => {
        calls.push("deactivateAll");
        activeId = null;
        return true;
      },
      importStPreset: async (input) => {
        calls.push(`import:${input.attachmentName}`);
        const imported = preset(3, { preset_name: input.customPresetName ?? "Imported", is_active: true });
        presets.push(imported);
        activeId = 3;
        return {
          status: "success",
          preset: imported,
          presetName: imported.preset_name,
          nodes: [node(1), node(2)],
          enabledCount: 2,
        };
      },
      updateStPresetNodes: async (input) => {
        calls.push(`updateNodes:${input.presetId}`);
        return true;
      },
      removeStPresetsWithPromotion: async (input) => {
        calls.push(`removeWithPromotion:${input.presetIdsToRemove.join(",")}`);
        return {
          successCount: 1,
          failureCount: 0,
          promotedPreset: preset(2, { is_active: true }),
        };
      },
      deleteStPreset: async () => true,
      loadStPresetScopeData: async () => null,
      loadToggleableNodes: async () => [],
    },
    loadToggleableNodes: async (presetId) => {
      calls.push(`loadToggleableNodes:${presetId}`);
      return [node(1), node(2)];
    },
    createNonce: () => "fixed-nonce-123",
    showAddModal: async () => {
      calls.push("showAddModal");
    },
    showNodesModal: async () => {
      calls.push("showNodesModal");
    },
    takeFileUpload: (_interactionId, nonce) => {
      calls.push(`takeFileUpload:${nonce}`);
      return {
        id: "att-1",
        url: "https://example.com/preset.json",
        filename: "preset.json",
        size: 1024,
        content_type: "application/json",
      } as never;
    },
    takeNodeCheckboxValues: (_interactionId, nonce, groupIndex) => {
      calls.push(`takeNodeCheckbox:${nonce}:${groupIndex}`);
      return groupIndex === 0 ? ["node_1"] : [];
    },
    storeNodeSnapshot: (nonce, snapshot) => {
      calls.push(`storeNodeSnapshot:${nonce}`);
      snapshots.set(nonce, snapshot);
    },
    takeNodeSnapshot: (nonce) => {
      calls.push(`takeNodeSnapshot:${nonce}`);
      return snapshots.get(nonce) ?? { presetId: 1, identifiers: ["node_1", "node_2"] };
    },
    recordAction: overrides.recordAction ?? (() => {}),
    ...overrides,
  };
}

function makeButtonInteraction(
  customId: string,
  calls: string[],
  overrides: Record<string, unknown> = {},
): ButtonInteraction {
  return {
    customId,
    guildId: "100",
    user: { id: "100" },
    memberPermissions: { has: (perm: string) => perm === "ManageGuild" },
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    deferUpdate: async () => {
      calls.push("deferUpdate");
    },
    reply: async () => {
      calls.push("reply");
    },
    editReply: async () => {
      calls.push("editReply");
    },
    ...overrides,
  } as unknown as ButtonInteraction;
}

function makeSelectInteraction(
  customId: string,
  values: string[],
  calls: string[],
  overrides: Record<string, unknown> = {},
): StringSelectMenuInteraction {
  return {
    customId,
    guildId: "100",
    user: { id: "100" },
    values,
    memberPermissions: { has: (perm: string) => perm === "ManageGuild" },
    isButton: () => false,
    isStringSelectMenu: () => true,
    isModalSubmit: () => false,
    deferUpdate: async () => {
      calls.push("deferUpdate");
    },
    reply: async () => {
      calls.push("reply");
    },
    editReply: async () => {
      calls.push("editReply");
    },
    ...overrides,
  } as unknown as StringSelectMenuInteraction;
}

function makeModalInteraction(
  id: string,
  customId: string,
  calls: string[],
  overrides: Record<string, unknown> = {},
): ModalSubmitInteraction {
  return {
    id,
    customId,
    guildId: "100",
    user: { id: "100" },
    memberPermissions: { has: (perm: string) => perm === "ManageGuild" },
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => true,
    deferUpdate: async () => {
      calls.push("deferUpdate");
    },
    reply: async () => {
      calls.push("reply");
    },
    editReply: async () => {
      calls.push("editReply");
    },
    fields: {
      getTextInputValue: (fieldId: string) => (fieldId.startsWith("name") ? "New Preset" : "My description"),
    },
    ...overrides,
  } as unknown as ModalSubmitInteraction;
}

describe("ST Presets interaction routes", () => {
  it("opens Add modal directly with no deferUpdate on add-open and select + Add", async () => {
    const calls: string[] = [];
    const route = createStPresetsInteractionRoute(makeDependencies(calls));

    const buttonInteraction = makeButtonInteraction("config:v2:st-presets-add-open:en-US", calls);

    await route.execute({} as Client, buttonInteraction, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-add-open", "en-US"],
    });

    expect(calls).toEqual(["showAddModal"]);

    calls.length = 0;
    const selectInteraction = makeSelectInteraction("config:v2:st-presets-select:en-US", ["add"], calls);

    await route.execute({} as Client, selectInteraction, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-select", "en-US"],
    });

    expect(calls).toEqual(["showAddModal"]);
  });

  it("lets a hosted route repaint its denied select fallback after acknowledgement", async () => {
    const calls: string[] = [];
    const route = createStPresetsInteractionRoute({
      ...makeDependencies(calls),
      routeAdapter: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
      onDenied: async () => {
        calls.push("hostedDenied");
      },
    });
    const segments = CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.buildRouteSegments({
      action: "select",
      locale: "en-US",
    });
    const interaction = makeSelectInteraction(
      CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.buildRouteId({ action: "select", locale: "en-US" }),
      ["none"],
      calls,
      { memberPermissions: { has: () => false } },
    );

    await route.execute({} as Client, interaction, {
      namespace: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.namespace,
      version: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.version,
      segments,
    });

    expect(calls).toEqual(["deferUpdate", "hostedDenied"]);
  });

  it("acknowledges hosted modal-oriented denials before their fallback repaint", async () => {
    const calls: string[] = [];
    const route = createStPresetsInteractionRoute({
      ...makeDependencies(calls),
      routeAdapter: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
      onDenied: async () => {
        calls.push("hostedDenied");
      },
    });
    const deniedPermissions = { memberPermissions: { has: () => false } };
    const cases: Array<{
      route: Parameters<typeof CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.buildRouteId>[0];
      interaction: "button" | "select";
      values?: string[];
    }> = [
      { route: { action: "add-open", locale: "en-US" }, interaction: "button" },
      { route: { action: "select", locale: "en-US" }, interaction: "select", values: ["add"] },
      { route: { action: "nodes-open", locale: "en-US", presetId: 1 }, interaction: "button" },
      { route: { action: "nodes-range", locale: "en-US", presetId: 1, rangeIndex: 0 }, interaction: "button" },
      {
        route: { action: "nodes-range-select", locale: "en-US", presetId: 1 },
        interaction: "select",
        values: ["0"],
      },
    ];

    for (const entry of cases) {
      calls.length = 0;
      const customId = CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.buildRouteId(entry.route);
      const interaction =
        entry.interaction === "button"
          ? makeButtonInteraction(customId, calls, deniedPermissions)
          : makeSelectInteraction(customId, entry.values ?? [], calls, deniedPermissions);
      const segments = CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.buildRouteSegments(entry.route);

      await route.execute({} as Client, interaction, {
        namespace: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.namespace,
        version: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.version,
        segments,
      });

      expect(calls).toEqual(["deferUpdate", "hostedDenied"]);
    }
  });

  it("selecting None with active preset deactivates immediately and repaints with disabled receipt", async () => {
    const calls: string[] = [];
    let editReplyPayload: unknown = null;
    const route = createStPresetsInteractionRoute(makeDependencies(calls));

    const selectNoneInteraction = makeSelectInteraction("config:v2:st-presets-select:en-US", ["none"], calls, {
      editReply: async (opts: unknown) => {
        calls.push("editReply");
        editReplyPayload = opts;
      },
    });

    await route.execute({} as Client, selectNoneInteraction, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-select", "en-US"],
    });

    expect(calls).toEqual(["deferUpdate", "resolveScope", "deactivateAll", "resolveScope-fresh", "editReply"]);
    const serialized = JSON.stringify(editReplyPayload);
    expect(serialized).toContain("Presets disabled");
  });

  it("selecting None with nothing active performs no write and shows no receipt", async () => {
    const calls: string[] = [];
    let editReplyPayload: unknown = null;
    const route = createStPresetsInteractionRoute(
      makeDependencies(calls, {
        resolveScope: async () => {
          calls.push("resolveScope");
          return {
            discordId: "100",
            kind: "guild",
            state: { server_id: 1 } as never,
            data: {
              scopeDiscId: "100",
              serverId: 1,
              readStatus: "fresh",
              presets: [preset(1, { is_active: false }), preset(2, { is_active: false })],
              activePresetId: null,
            },
          };
        },
      }),
    );

    const selectNoneInteraction = makeSelectInteraction("config:v2:st-presets-select:en-US", ["none"], calls, {
      editReply: async (opts: unknown) => {
        calls.push("editReply");
        editReplyPayload = opts;
      },
    });

    await route.execute({} as Client, selectNoneInteraction, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-select", "en-US"],
    });

    expect(calls).toEqual(["deferUpdate", "resolveScope", "editReply"]);
    expect(calls).not.toContain("deactivateAll");
    const serialized = JSON.stringify(editReplyPayload);
    expect(serialized).not.toContain("Presets disabled");
  });

  it("selecting None on stale read performs no write", async () => {
    const calls: string[] = [];
    const route = createStPresetsInteractionRoute(
      makeDependencies(calls, {
        resolveScope: async () => {
          calls.push("resolveScope-stale");
          return {
            discordId: "100",
            kind: "guild",
            state: { server_id: 1 } as never,
            data: {
              scopeDiscId: "100",
              serverId: 1,
              readStatus: "stale",
              presets: [preset(1, { is_active: true }), preset(2)],
              activePresetId: 1,
            },
          };
        },
      }),
    );

    const selectNoneInteraction = makeSelectInteraction("config:v2:st-presets-select:en-US", ["none"], calls);

    await route.execute({} as Client, selectNoneInteraction, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-select", "en-US"],
    });

    expect(calls).toEqual(["deferUpdate", "resolveScope-stale", "editReply"]);
    expect(calls).not.toContain("deactivateAll");
  });

  it("handles legacy disable and none route actions", async () => {
    const calls: string[] = [];
    let editReplyPayload: unknown = null;
    const route = createStPresetsInteractionRoute(makeDependencies(calls));

    // Legacy disable button
    const disableInteraction = makeButtonInteraction("config:v2:st-presets-disable:en-US", calls, {
      editReply: async (opts: unknown) => {
        calls.push("editReply");
        editReplyPayload = opts;
      },
    });

    await route.execute({} as Client, disableInteraction, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-disable", "en-US"],
    });

    expect(calls).toEqual(["deferUpdate", "resolveScope", "deactivateAll", "resolveScope-fresh", "editReply"]);
    expect(JSON.stringify(editReplyPayload)).toContain("Presets disabled");

    // Legacy none route action
    calls.length = 0;
    editReplyPayload = null;
    const noneInteraction = makeButtonInteraction("config:v2:st-presets-none:en-US", calls, {
      editReply: async (opts: unknown) => {
        calls.push("editReply");
        editReplyPayload = opts;
      },
    });

    await route.execute({} as Client, noneInteraction, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-none", "en-US"],
    });

    expect(calls).toEqual(["deferUpdate", "resolveScope", "editReply"]);
    expect(calls).not.toContain("deactivateAll");
  });

  it("keeps the active preset body while the top-level selector changes page", async () => {
    const calls: string[] = [];
    const manyPresets = Array.from({ length: 24 }, (_, index) => preset(index + 1, { is_active: index === 0 }));
    let editReplyPayload: unknown;
    const route = createStPresetsInteractionRoute(
      makeDependencies(calls, {
        resolveScope: async () => {
          calls.push("resolveScope");
          return {
            discordId: "100",
            kind: "guild",
            state: { server_id: 1 } as never,
            data: {
              scopeDiscId: "100",
              serverId: 1,
              readStatus: "fresh",
              presets: manyPresets,
              activePresetId: 1,
            },
          };
        },
      }),
    );
    const interaction = makeButtonInteraction("config:v2:st-presets-range:en-US:1", calls, {
      editReply: async (payload: unknown) => {
        calls.push("editReply");
        editReplyPayload = payload;
      },
    });

    await route.execute({} as Client, interaction, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-range", "en-US", "1"],
    });

    expect(calls).toEqual(["deferUpdate", "resolveScope", "editReply"]);
    const rendered = JSON.stringify(editReplyPayload);
    expect(rendered).toContain('"label":"Page 2 of 2"');
    expect(rendered).toContain("config:v2:st-presets-range:en-US:0");
    expect(rendered).toContain("config:v2:st-presets-range:en-US:1");
    expect(rendered).toContain("> Description 1");
    expect(rendered).not.toContain("> Description 24");
  });

  it("repaints vanished-preset state on active preset page when one is active and None page when none is", async () => {
    const calls: string[] = [];
    let editReplyPayload: unknown = null;

    // Case 1: Preset 99 selected (not found), but Preset 1 is active -> lands on Preset 1 page with changed receipt
    const route = createStPresetsInteractionRoute(makeDependencies(calls));
    const selectMissingInteraction = makeSelectInteraction("config:v2:st-presets-select:en-US", ["99"], calls, {
      editReply: async (opts: unknown) => {
        calls.push("editReply");
        editReplyPayload = opts;
      },
    });

    await route.execute({} as Client, selectMissingInteraction, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-select", "en-US"],
    });

    expect(calls).toEqual(["deferUpdate", "resolveScope", "editReply"]);
    let serialized = JSON.stringify(editReplyPayload);
    expect(serialized).toContain("Preset list changed");
    expect(serialized).toContain("Preset 1");

    // Case 2: Preset 99 selected (not found), and nothing is active -> lands on None page with changed receipt
    calls.length = 0;
    editReplyPayload = null;
    const routeNoActive = createStPresetsInteractionRoute(
      makeDependencies(calls, {
        resolveScope: async () => {
          calls.push("resolveScope");
          return {
            discordId: "100",
            kind: "guild",
            state: { server_id: 1 } as never,
            data: {
              scopeDiscId: "100",
              serverId: 1,
              readStatus: "fresh",
              presets: [preset(1, { is_active: false })],
              activePresetId: null,
            },
          };
        },
      }),
    );

    const selectMissingNoActive = makeSelectInteraction("config:v2:st-presets-select:en-US", ["99"], calls, {
      editReply: async (opts: unknown) => {
        calls.push("editReply");
        editReplyPayload = opts;
      },
    });

    await routeNoActive.execute({} as Client, selectMissingNoActive, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-select", "en-US"],
    });

    expect(calls).toEqual(["deferUpdate", "resolveScope", "editReply"]);
    serialized = JSON.stringify(editReplyPayload);
    expect(serialized).toContain("Preset list changed");
    expect(serialized).toContain("No Active Preset");
  });

  it("selecting a preset activates it and repaints with receipt", async () => {
    const calls: string[] = [];
    const route = createStPresetsInteractionRoute(makeDependencies(calls));

    const selectInteraction = makeSelectInteraction("config:v2:st-presets-select:en-US", ["2"], calls);

    await route.execute({} as Client, selectInteraction, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-select", "en-US"],
    });

    expect(calls).toEqual(["deferUpdate", "resolveScope", "activate:2", "resolveScope-fresh", "editReply"]);
  });

  it("handles Add submission with acknowledgment before write", async () => {
    const calls: string[] = [];
    const route = createStPresetsInteractionRoute(makeDependencies(calls));

    const modalInteraction = makeModalInteraction(
      "modal-1",
      "config:v2:st-presets-add-submit:en-US:fixed-nonce-123",
      calls,
    );

    await route.execute({} as Client, modalInteraction, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-add-submit", "en-US", "fixed-nonce-123"],
    });

    expect(calls).toEqual([
      "deferUpdate",
      "resolveScope",
      "takeFileUpload:fixed-nonce-123",
      "import:preset.json",
      "resolveScope-fresh",
      "editReply",
    ]);
  });

  it("nodes-open with <= 50 nodes opens modal directly", async () => {
    const calls: string[] = [];
    const route = createStPresetsInteractionRoute(makeDependencies(calls));

    const buttonInteraction = makeButtonInteraction("config:v2:st-presets-nodes-open:en-US:1", calls);

    await route.execute({} as Client, buttonInteraction, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-nodes-open", "en-US", "1"],
    });

    expect(calls).toEqual([
      "resolveScope",
      "loadToggleableNodes:1",
      "storeNodeSnapshot:fixed-nonce-123",
      "showNodesModal",
    ]);
  });

  it("nodes-open with > 50 nodes keeps the preset body and exposes modal pagination", async () => {
    const calls: string[] = [];
    let editReplyPayload: unknown;
    const manyNodes = Array.from({ length: 60 }, (_, i) => node(i + 1));
    const route = createStPresetsInteractionRoute(
      makeDependencies(calls, {
        loadToggleableNodes: async (presetId) => {
          calls.push(`loadToggleableNodes:${presetId}`);
          return manyNodes;
        },
      }),
    );

    const buttonInteraction = makeButtonInteraction("config:v2:st-presets-nodes-open:en-US:1", calls, {
      editReply: async (payload: unknown) => {
        calls.push("editReply");
        editReplyPayload = payload;
      },
    });

    await route.execute({} as Client, buttonInteraction, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-nodes-open", "en-US", "1"],
    });

    expect(calls).toEqual(["resolveScope", "loadToggleableNodes:1", "deferUpdate", "editReply"]);
    const rendered = JSON.stringify(editReplyPayload);
    expect(rendered).toContain("Currently active preset");
    expect(rendered).toContain("config:v2:st-presets-nodes-range-select:en-US:1");
    expect(rendered).toContain('"value":"0","label":"Nodes 1-50"');
    expect(rendered).toContain('"value":"1","label":"Nodes 51-60"');
    expect(rendered).not.toContain("Select Page");
  });

  it("keeps legacy node-page routes routable without repainting a chooser", async () => {
    const calls: string[] = [];
    const manyNodes = Array.from({ length: 120 }, (_, i) => node(i + 1));
    let editReplyPayload: unknown;
    const route = createStPresetsInteractionRoute(
      makeDependencies(calls, {
        loadToggleableNodes: async (presetId) => {
          calls.push(`loadToggleableNodes:${presetId}`);
          return manyNodes;
        },
      }),
    );
    const customId = "config:v2:st-presets-nodes-page:en-US:1:2";
    const buttonInteraction = makeButtonInteraction(customId, calls, {
      editReply: async (payload: unknown) => {
        calls.push("editReply");
        editReplyPayload = payload;
      },
    });

    await route.execute({} as Client, buttonInteraction, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-nodes-page", "en-US", "1", "2"],
    });

    expect(calls).toEqual(["deferUpdate", "resolveScope", "loadToggleableNodes:1", "editReply"]);
    const rendered = JSON.stringify(editReplyPayload);
    // The legacy chooser page snaps to its block, so every range stays selectable.
    expect(rendered).toContain('"value":"0","label":"Nodes 1-50"');
    expect(rendered).toContain('"value":"2","label":"Nodes 101-120"');
    expect(rendered).not.toContain("Select Page");
  });

  it("clamps oversized node modal routes to the last 50-node page", async () => {
    const calls: string[] = [];
    const manyNodes = Array.from({ length: 60 }, (_, i) => node(i + 1));
    let openedOffset: number | undefined;
    let openedCount: number | undefined;
    const route = createStPresetsInteractionRoute(
      makeDependencies(calls, {
        loadToggleableNodes: async (presetId) => {
          calls.push(`loadToggleableNodes:${presetId}`);
          return manyNodes;
        },
        showNodesModal: async (_interaction, _locale, _preset, pageNodes, pageOffset) => {
          openedOffset = pageOffset;
          openedCount = pageNodes.length;
          calls.push("showNodesModal");
        },
      }),
    );
    const customId = "config:v2:st-presets-nodes-range:en-US:1:99";

    await route.execute({} as Client, makeButtonInteraction(customId, calls), {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-nodes-range", "en-US", "1", "99"],
    });

    expect(calls).toEqual([
      "resolveScope",
      "loadToggleableNodes:1",
      "storeNodeSnapshot:fixed-nonce-123",
      "showNodesModal",
    ]);
    expect(openedOffset).toBe(50);
    expect(openedCount).toBe(10);
  });

  it("opens the first 50-node slice from the node range selector", async () => {
    const calls: string[] = [];
    const manyNodes = Array.from({ length: 60 }, (_, i) => node(i + 1));
    let openedOffset: number | undefined;
    let openedCount: number | undefined;
    const route = createStPresetsInteractionRoute(
      makeDependencies(calls, {
        loadToggleableNodes: async (presetId) => {
          calls.push(`loadToggleableNodes:${presetId}`);
          return manyNodes;
        },
        showNodesModal: async (_interaction, _locale, _preset, pageNodes, pageOffset) => {
          openedOffset = pageOffset;
          openedCount = pageNodes.length;
          calls.push("showNodesModal");
        },
      }),
    );
    const customId = "config:v2:st-presets-nodes-range-select:en-US:1";

    await route.execute({} as Client, makeSelectInteraction(customId, ["0"], calls), {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-nodes-range-select", "en-US", "1"],
    });

    expect(calls).toContain("showNodesModal");
    expect(openedOffset).toBe(0);
    expect(openedCount).toBe(50);
  });

  it("repaints instead of opening a modal when the node range value is not a number", async () => {
    const calls: string[] = [];
    const manyNodes = Array.from({ length: 60 }, (_, i) => node(i + 1));
    let modalShown = false;
    const route = createStPresetsInteractionRoute(
      makeDependencies(calls, {
        loadToggleableNodes: async () => manyNodes,
        showNodesModal: async () => {
          modalShown = true;
        },
      }),
    );
    const customId = "config:v2:st-presets-nodes-range-select:en-US:1";

    await route.execute({} as Client, makeSelectInteraction(customId, ["not-a-range"], calls), {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-nodes-range-select", "en-US", "1"],
    });

    expect(modalShown).toBe(false);
    expect(calls).toContain("editReply");
  });

  it("nodes-submit updates enabled nodes and repaints with receipt", async () => {
    const calls: string[] = [];
    const route = createStPresetsInteractionRoute(makeDependencies(calls));

    const modalInteraction = makeModalInteraction(
      "modal-nodes-1",
      "config:v2:st-presets-nodes-submit:en-US:1:fixed-nonce-123",
      calls,
    );

    await route.execute({} as Client, modalInteraction, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-nodes-submit", "en-US", "1", "fixed-nonce-123"],
    });

    expect(calls).toContain("takeNodeSnapshot:fixed-nonce-123");
    expect(calls).toContain("updateNodes:1");
    expect(calls).toContain("resolveScope-fresh");
    expect(calls).toContain("editReply");
  });

  it("delete confirm deletes with promotion and cancel writes nothing", async () => {
    const calls: string[] = [];
    const route = createStPresetsInteractionRoute(makeDependencies(calls));

    // Cancel
    const cancelInteraction = makeButtonInteraction("config:v2:st-presets-delete-cancel:en-US:1", calls);

    await route.execute({} as Client, cancelInteraction, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-delete-cancel", "en-US", "1"],
    });

    expect(calls).toEqual(["deferUpdate", "resolveScope", "editReply"]);

    // Confirm
    calls.length = 0;
    const confirmInteraction = makeButtonInteraction("config:v2:st-presets-delete-confirm:en-US:1", calls);

    await route.execute({} as Client, confirmInteraction, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-delete-confirm", "en-US", "1"],
    });

    expect(calls).toEqual(["deferUpdate", "resolveScope", "removeWithPromotion:1", "resolveScope-fresh", "editReply"]);
  });

  it("blocks writes on stale or unavailable state", async () => {
    const calls: string[] = [];
    const route = createStPresetsInteractionRoute(
      makeDependencies(calls, {
        resolveScope: async () => {
          calls.push("resolveScope-stale");
          return {
            discordId: "100",
            kind: "guild",
            state: { server_id: 1 } as never,
            data: {
              scopeDiscId: "100",
              serverId: 1,
              readStatus: "stale",
              presets: [preset(1, { is_active: true }), preset(2)],
              activePresetId: 1,
            },
          };
        },
      }),
    );

    const selectInteraction = makeSelectInteraction("config:v2:st-presets-select:en-US", ["2"], calls);

    await route.execute({} as Client, selectInteraction, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-select", "en-US"],
    });

    expect(calls).toEqual(["deferUpdate", "resolveScope-stale", "editReply"]);
    expect(calls).not.toContain("activate:2");
  });

  it("denies non-manager guild interactions without performing writes or opening modals", async () => {
    const calls: string[] = [];
    let replyPayload: unknown = null;
    let editReplyPayload: unknown = null;

    const route = createStPresetsInteractionRoute(makeDependencies(calls));
    const nonManagerOverrides = {
      memberPermissions: { has: () => false },
      reply: async (opts: unknown) => {
        calls.push("reply-denied");
        replyPayload = opts;
      },
      editReply: async (opts: unknown) => {
        calls.push("editReply-denied");
        editReplyPayload = opts;
      },
    };

    // add-open denied
    calls.length = 0;
    const addOpenBtn = makeButtonInteraction("config:v2:st-presets-add-open:en-US", calls, nonManagerOverrides);
    await route.execute({} as Client, addOpenBtn, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-add-open", "en-US"],
    });
    expect(calls).toEqual(["reply-denied"]);
    expect(JSON.stringify(replyPayload)).toContain("Manage Server");

    // select "add" denied
    calls.length = 0;
    const selectAdd = makeSelectInteraction("config:v2:st-presets-select:en-US", ["add"], calls, nonManagerOverrides);
    await route.execute({} as Client, selectAdd, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-select", "en-US"],
    });
    expect(calls).toEqual(["reply-denied"]);

    // nodes-open denied
    calls.length = 0;
    const nodesOpen = makeButtonInteraction("config:v2:st-presets-nodes-open:en-US:1", calls, nonManagerOverrides);
    await route.execute({} as Client, nodesOpen, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-nodes-open", "en-US", "1"],
    });
    expect(calls).toEqual(["reply-denied"]);

    // select activation denied without write
    calls.length = 0;
    const selectPreset = makeSelectInteraction("config:v2:st-presets-select:en-US", ["2"], calls, nonManagerOverrides);
    await route.execute({} as Client, selectPreset, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-select", "en-US"],
    });
    expect(calls).toEqual(["deferUpdate", "editReply-denied"]);
    expect(JSON.stringify(editReplyPayload)).toContain("Manage Server");
    expect(calls).not.toContain("activate:2");

    // disable denied without write
    calls.length = 0;
    const disableBtn = makeButtonInteraction("config:v2:st-presets-disable:en-US", calls, nonManagerOverrides);
    await route.execute({} as Client, disableBtn, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-disable", "en-US"],
    });
    expect(calls).toEqual(["deferUpdate", "editReply-denied"]);
    expect(calls).not.toContain("deactivateAll");

    // delete-confirm denied without write
    calls.length = 0;
    const deleteBtn = makeButtonInteraction("config:v2:st-presets-delete-confirm:en-US:1", calls, nonManagerOverrides);
    await route.execute({} as Client, deleteBtn, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-delete-confirm", "en-US", "1"],
    });
    expect(calls).toEqual(["deferUpdate", "editReply-denied"]);
    expect(calls).not.toContain("removeWithPromotion:1");
  });

  it("allows DM interactions without guild permissions", async () => {
    const calls: string[] = [];
    const route = createStPresetsInteractionRoute(makeDependencies(calls));

    const dmInteraction = makeSelectInteraction("config:v2:st-presets-select:en-US", ["2"], calls, {
      guildId: null,
      memberPermissions: null,
    });

    await route.execute({} as Client, dmInteraction, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-select", "en-US"],
    });

    expect(calls).toEqual(["deferUpdate", "resolveScope", "activate:2", "resolveScope-fresh", "editReply"]);
  });

  it("records panel_action telemetry on ST preset operations", async () => {
    const recorded: string[] = [];
    const recordAction = (input: { action: string; serverId: number; userDiscId: string }) => {
      recorded.push(`${input.action}:${input.serverId}:${input.userDiscId}`);
    };

    // Activate preset via select
    const activateRoute = createStPresetsInteractionRoute(makeDependencies([], { recordAction }));
    const activateInteraction = makeSelectInteraction("config:v2:st-presets-select:en-US", ["2"], []);
    await activateRoute.execute({} as Client, activateInteraction, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-select", "en-US"],
    });
    expect(recorded).toContain("st-presets.workspace.preset.activate:1:100");

    // Deactivate via select none
    const deactivateSelectRoute = createStPresetsInteractionRoute(makeDependencies([], { recordAction }));
    const deactivateSelectInteraction = makeSelectInteraction("config:v2:st-presets-select:en-US", ["none"], []);
    await deactivateSelectRoute.execute({} as Client, deactivateSelectInteraction, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-select", "en-US"],
    });
    expect(recorded).toContain("st-presets.workspace.preset.deactivate:1:100");

    // Deactivate via disable button
    const disableButtonRoute = createStPresetsInteractionRoute(makeDependencies([], { recordAction }));
    const disableButtonInteraction = makeButtonInteraction("config:v2:st-presets-disable:en-US", []);
    await disableButtonRoute.execute({} as Client, disableButtonInteraction, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-disable", "en-US"],
    });
    expect(recorded).toContain("st-presets.workspace.preset.deactivate:1:100");

    // Import preset (add-submit)
    const addRoute = createStPresetsInteractionRoute(makeDependencies([], { recordAction }));
    const addInteraction = {
      id: "submit-add",
      customId: "config:v2:st-presets-add-submit:en-US:fixed-nonce-123",
      guildId: "100",
      user: { id: "100" },
      memberPermissions: { has: () => true },
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      deferUpdate: async () => {},
      editReply: async () => {},
      fields: { getTextInputValue: () => "My Preset" },
    } as unknown as ModalSubmitInteraction;
    await addRoute.execute({} as Client, addInteraction, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-add-submit", "en-US", "fixed-nonce-123"],
    });
    expect(recorded).toContain("st-presets.workspace.preset.add:1:100");

    // Update nodes (nodes-submit)
    const nodesRoute = createStPresetsInteractionRoute(makeDependencies([], { recordAction }));
    const nodesInteraction = {
      id: "submit-nodes",
      customId: "config:v2:st-presets-nodes-submit:en-US:1:fixed-nonce-123",
      guildId: "100",
      user: { id: "100" },
      memberPermissions: { has: () => true },
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      deferUpdate: async () => {},
      editReply: async () => {},
    } as unknown as ModalSubmitInteraction;
    await nodesRoute.execute({} as Client, nodesInteraction, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-nodes-submit", "en-US", "1", "fixed-nonce-123"],
    });
    expect(recorded).toContain("st-presets.workspace.nodes.save:1:100");

    // Delete preset (delete-confirm)
    const deleteRoute = createStPresetsInteractionRoute(makeDependencies([], { recordAction }));
    const deleteInteraction = makeButtonInteraction("config:v2:st-presets-delete-confirm:en-US:1", []);
    await deleteRoute.execute({} as Client, deleteInteraction, {
      namespace: "config",
      version: "v2",
      segments: ["st-presets-delete-confirm", "en-US", "1"],
    });
    expect(recorded).toContain("st-presets.workspace.preset.remove:1:100");
  });
});
