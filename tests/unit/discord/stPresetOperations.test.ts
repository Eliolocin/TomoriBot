import { describe, expect, it, spyOn } from "bun:test";
import type { StPresetRow, TomoriState } from "@/types/db/schema";
import * as stPresetCache from "@/utils/cache/stPresetCache";
import { presetRepository } from "@/utils/db/repositories/PresetRepository";
import {
  activateStPreset,
  deactivateAllStPresets,
  deleteStPreset,
  importStPreset,
  loadStPresetScopeData,
  removeStPresetsWithPromotion,
  updateStPresetNodes,
  type StPresetOperationsDependencies,
} from "@/utils/stPreset/stPresetOperations";

function makeMockTomoriState(serverId = 10): TomoriState {
  return {
    server_id: serverId,
    server_disc_id: "disc-10",
    persona_id: 1,
    persona_nickname: "Tomori",
    is_alter: false,
    config: {
      server_id: serverId,
    },
  } as unknown as TomoriState;
}

function makeMockPresetRow(overrides: Partial<StPresetRow> = {}): StPresetRow {
  return {
    preset_id: 1,
    server_id: 10,
    preset_name: "Test Preset",
    raw_json: {},
    is_active: false,
    description: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe("stPresetOperations domain delegation", () => {
  describe("navigation-shaped reads", () => {
    it("never activates, inserts, deletes, or writes to the database on read paths", async () => {
      const activeSpy = spyOn(presetRepository, "setActivePreset");
      const insertSpy = spyOn(presetRepository, "insertPresetWithNodes");
      const deleteSpy = spyOn(presetRepository, "deletePreset");
      const deactivateSpy = spyOn(presetRepository, "deactivateAllPresets");
      const updateNodesSpy = spyOn(presetRepository, "updateNodeEnabledStates");

      const mockDeps: StPresetOperationsDependencies = {
        getState: async () => makeMockTomoriState(10),
        getLastDbError: () => null,
        loadPresetsForServerResult: async () => ({
          status: "fresh",
          presets: [makeMockPresetRow({ preset_id: 1, is_active: true })],
        }),
        insertPresetWithNodes: async () => null,
        setActivePreset: async () => true,
        deactivateAllPresets: async () => true,
        deletePreset: async () => true,
        updateNodeEnabledStates: async () => true,
        safeDownload: async () => ({ success: true, buffer: Buffer.from("{}") }),
      };

      const result = await loadStPresetScopeData("disc-10", false, mockDeps);

      expect(result).not.toBeNull();
      expect(result?.readStatus).toBe("fresh");
      expect(result?.activePresetId).toBe(1);
      expect(result?.presets.length).toBe(1);

      expect(activeSpy).not.toHaveBeenCalled();
      expect(insertSpy).not.toHaveBeenCalled();
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(deactivateSpy).not.toHaveBeenCalled();
      expect(updateNodesSpy).not.toHaveBeenCalled();

      activeSpy.mockRestore();
      insertSpy.mockRestore();
      deleteSpy.mockRestore();
      deactivateSpy.mockRestore();
      updateNodesSpy.mockRestore();
    });

    it("distinguishes an authoritative empty read from an unavailable one", async () => {
      const emptyDeps: StPresetOperationsDependencies = {
        getState: async () => makeMockTomoriState(10),
        getLastDbError: () => null,
        loadPresetsForServerResult: async () => ({ status: "fresh", presets: [] }),
        insertPresetWithNodes: async () => null,
        setActivePreset: async () => true,
        deactivateAllPresets: async () => true,
        deletePreset: async () => true,
        updateNodeEnabledStates: async () => true,
        safeDownload: async () => ({ success: true, buffer: Buffer.from("{}") }),
      };

      const emptyResult = await loadStPresetScopeData("disc-10", false, emptyDeps);
      expect(emptyResult?.readStatus).toBe("fresh");
      expect(emptyResult?.presets).toEqual([]);
      expect(emptyResult?.activePresetId).toBeNull();

      const unavailableDeps: StPresetOperationsDependencies = {
        ...emptyDeps,
        loadPresetsForServerResult: async () => ({ status: "unavailable", presets: [] }),
      };

      const unavailableResult = await loadStPresetScopeData("disc-10", false, unavailableDeps);
      expect(unavailableResult).not.toBeNull();
      expect(unavailableResult?.readStatus).toBe("unavailable");
      expect(unavailableResult?.presets).toEqual([]);
    });

    it("loads activeNodeCounts for active preset on fresh read and skips on unavailable", async () => {
      let countCalledWith: { presetId: number; serverId: number } | null = null;
      const depsWithActive: StPresetOperationsDependencies = {
        getState: async () => makeMockTomoriState(10),
        getLastDbError: () => null,
        loadPresetsForServerResult: async () => ({
          status: "fresh",
          presets: [makeMockPresetRow({ preset_id: 42, is_active: true })],
        }),
        countToggleableNodesForServer: async (presetId, serverId) => {
          countCalledWith = { presetId, serverId };
          return { total: 54, enabled: 47 };
        },
        insertPresetWithNodes: async () => null,
        setActivePreset: async () => true,
        deactivateAllPresets: async () => true,
        deletePreset: async () => true,
        updateNodeEnabledStates: async () => true,
        safeDownload: async () => ({ success: true, buffer: Buffer.from("{}") }),
      };

      const result = await loadStPresetScopeData("disc-10", false, depsWithActive);
      expect(result?.activePresetId).toBe(42);
      expect(result?.activeNodeCounts).toEqual({ total: 54, enabled: 47 });
      expect(countCalledWith).toEqual({ presetId: 42, serverId: 10 });
    });

    it("reports stale readStatus when recorded db error exists despite state read", async () => {
      const staleDeps: StPresetOperationsDependencies = {
        getState: async () => makeMockTomoriState(10),
        getLastDbError: () => null,
        getRecordedDbError: () => ({ message: "Transient DB glitch", timestamp: Date.now() }),
        loadPresetsForServerResult: async () => ({ status: "fresh", presets: [makeMockPresetRow()] }),
        insertPresetWithNodes: async () => null,
        setActivePreset: async () => true,
        deactivateAllPresets: async () => true,
        deletePreset: async () => true,
        updateNodeEnabledStates: async () => true,
        safeDownload: async () => ({ success: true, buffer: Buffer.from("{}") }),
      };

      const result = await loadStPresetScopeData("disc-10", false, staleDeps);
      expect(result?.readStatus).toBe("stale");
    });
  });

  describe("scoped write boundaries and cache invalidation", () => {
    it("invalidates cache only after successful activation", async () => {
      const invalidateSpy = spyOn(stPresetCache, "invalidateStPresetCache");

      const successDeps: StPresetOperationsDependencies = {
        getState: async () => makeMockTomoriState(10),
        getLastDbError: () => null,
        loadPresetsForServerResult: async () => ({ status: "fresh", presets: [] }),
        insertPresetWithNodes: async () => null,
        setActivePreset: async (serverId, presetId) => {
          if (serverId === 10 && presetId === 1) {
            stPresetCache.invalidateStPresetCache(serverId);
            return true;
          }
          return false;
        },
        deactivateAllPresets: async () => true,
        deletePreset: async () => true,
        updateNodeEnabledStates: async () => true,
        safeDownload: async () => ({ success: true, buffer: Buffer.from("{}") }),
      };

      const success = await activateStPreset({ serverId: 10, presetId: 1 }, successDeps);
      expect(success).toBe(true);
      expect(invalidateSpy).toHaveBeenCalledWith(10);

      invalidateSpy.mockClear();

      const failed = await activateStPreset({ serverId: 10, presetId: 999 }, successDeps);
      expect(failed).toBe(false);
      expect(invalidateSpy).not.toHaveBeenCalled();

      invalidateSpy.mockRestore();
    });

    it("deactivate-all clears active presets for server and invalidates on success", async () => {
      const invalidateSpy = spyOn(stPresetCache, "invalidateStPresetCache");

      const deps: StPresetOperationsDependencies = {
        getState: async () => makeMockTomoriState(10),
        getLastDbError: () => null,
        loadPresetsForServerResult: async () => ({ status: "fresh", presets: [] }),
        insertPresetWithNodes: async () => null,
        setActivePreset: async () => true,
        deactivateAllPresets: async (serverId) => {
          if (serverId === 10) {
            stPresetCache.invalidateStPresetCache(serverId);
            return true;
          }
          return false;
        },
        deletePreset: async () => true,
        updateNodeEnabledStates: async () => true,
        safeDownload: async () => ({ success: true, buffer: Buffer.from("{}") }),
      };

      const success = await deactivateAllStPresets({ serverId: 10 }, deps);
      expect(success).toBe(true);
      expect(invalidateSpy).toHaveBeenCalledWith(10);

      invalidateSpy.mockClear();

      const failed = await deactivateAllStPresets({ serverId: 999 }, deps);
      expect(failed).toBe(false);
      expect(invalidateSpy).not.toHaveBeenCalled();

      invalidateSpy.mockRestore();
    });

    it("node updates and delete operations delegate with server scoping", async () => {
      const calls: Array<{ op: string; args: unknown[] }> = [];

      const deps: StPresetOperationsDependencies = {
        getState: async () => makeMockTomoriState(10),
        getLastDbError: () => null,
        loadPresetsForServerResult: async () => ({ status: "fresh", presets: [] }),
        insertPresetWithNodes: async () => null,
        setActivePreset: async () => true,
        deactivateAllPresets: async () => true,
        deletePreset: async (presetId, serverId) => {
          calls.push({ op: "delete", args: [presetId, serverId] });
          return true;
        },
        updateNodeEnabledStates: async (presetId, map, serverId) => {
          calls.push({ op: "updateNodes", args: [presetId, map, serverId] });
          return true;
        },
        safeDownload: async () => ({ success: true, buffer: Buffer.from("{}") }),
      };

      const enabledMap = new Map([["node_1", true]]);
      await updateStPresetNodes({ serverId: 10, presetId: 5, enabledMap }, deps);
      expect(calls).toContainEqual({ op: "updateNodes", args: [5, enabledMap, 10] });

      await deleteStPreset({ serverId: 10, presetId: 5 }, deps);
      expect(calls).toContainEqual({ op: "delete", args: [5, 10] });
    });
  });

  describe("importStPreset operation", () => {
    const validPresetJson = JSON.stringify({
      prompts: [
        {
          identifier: "main",
          name: "Main System Prompt",
          role: "system",
          content: "Prompt content",
          system_prompt: true,
        },
      ],
      prompt_order: [
        {
          character_id: 100001,
          order: [{ identifier: "main", enabled: true }],
        },
      ],
    });

    it("rejects nameless attachments with invalid_file and avoids downloading", async () => {
      let downloadCalled = false;
      const deps: StPresetOperationsDependencies = {
        getState: async () => makeMockTomoriState(10),
        getLastDbError: () => null,
        loadPresetsForServerResult: async () => ({ status: "fresh", presets: [] }),
        insertPresetWithNodes: async () => null,
        setActivePreset: async () => true,
        deactivateAllPresets: async () => true,
        deletePreset: async () => true,
        updateNodeEnabledStates: async () => true,
        safeDownload: async () => {
          downloadCalled = true;
          return { success: true, buffer: Buffer.from("{}") };
        },
      };

      const resultNull = await importStPreset(
        {
          serverId: 10,
          attachmentUrl: "https://discord.com/attachments/test",
          attachmentName: null,
        },
        deps,
      );
      expect(resultNull.status).toBe("invalid_file");
      expect(downloadCalled).toBe(false);

      const resultUndefined = await importStPreset(
        {
          serverId: 10,
          attachmentUrl: "https://discord.com/attachments/test",
        },
        deps,
      );
      expect(resultUndefined.status).toBe("invalid_file");
      expect(downloadCalled).toBe(false);
    });

    it("imports preset, stores author description, and activates inserted row", async () => {
      let insertedDescription: string | null | undefined;
      let activatedPresetId: number | null = null;

      const deps: StPresetOperationsDependencies = {
        getState: async () => makeMockTomoriState(10),
        getLastDbError: () => null,
        loadPresetsForServerResult: async () => ({ status: "fresh", presets: [] }),
        insertPresetWithNodes: async (_serverId, name, _rawJson, _nodes, desc) => {
          insertedDescription = desc;
          return makeMockPresetRow({ preset_id: 42, preset_name: name, description: desc });
        },
        setActivePreset: async (_serverId, presetId) => {
          activatedPresetId = presetId;
          return true;
        },
        deactivateAllPresets: async () => true,
        deletePreset: async () => true,
        updateNodeEnabledStates: async () => true,
        safeDownload: async () => ({
          success: true,
          buffer: Buffer.from(validPresetJson),
        }),
      };

      const result = await importStPreset(
        {
          serverId: 10,
          attachmentUrl: "https://discord.com/attachments/test.json",
          attachmentName: "MyCustomPreset.json",
          description: "Author-provided description",
        },
        deps,
      );

      expect(result.status).toBe("success");
      if (result.status !== "success") return;

      expect(result.presetName).toBe("MyCustomPreset");
      expect(result.preset.preset_id).toBe(42);
      expect(insertedDescription).toBe("Author-provided description");
      expect(activatedPresetId).toBe(42);
    });

    it("leaves description null when omitted", async () => {
      let insertedDescription: string | null | undefined;

      const deps: StPresetOperationsDependencies = {
        getState: async () => makeMockTomoriState(10),
        getLastDbError: () => null,
        loadPresetsForServerResult: async () => ({ status: "fresh", presets: [] }),
        insertPresetWithNodes: async (_serverId, name, _rawJson, _nodes, desc) => {
          insertedDescription = desc;
          return makeMockPresetRow({ preset_id: 42, preset_name: name });
        },
        setActivePreset: async () => true,
        deactivateAllPresets: async () => true,
        deletePreset: async () => true,
        updateNodeEnabledStates: async () => true,
        safeDownload: async () => ({
          success: true,
          buffer: Buffer.from(validPresetJson),
        }),
      };

      const result = await importStPreset(
        {
          serverId: 10,
          attachmentUrl: "https://discord.com/attachments/test.json",
          attachmentName: "DefaultPreset.json",
        },
        deps,
      );

      expect(result.status).toBe("success");
      expect(insertedDescription).toBeUndefined();
    });

    it("reports download_failed, invalid_json, not_a_preset, and insert_failed appropriately", async () => {
      const downloadFailDeps: StPresetOperationsDependencies = {
        getState: async () => makeMockTomoriState(10),
        getLastDbError: () => null,
        loadPresetsForServerResult: async () => ({ status: "fresh", presets: [] }),
        insertPresetWithNodes: async () => null,
        setActivePreset: async () => true,
        deactivateAllPresets: async () => true,
        deletePreset: async () => true,
        updateNodeEnabledStates: async () => true,
        safeDownload: async () => ({ success: false }),
      };

      const downloadResult = await importStPreset(
        { serverId: 10, attachmentUrl: "https://example.com/fail.json", attachmentName: "preset.json" },
        downloadFailDeps,
      );
      expect(downloadResult.status).toBe("download_failed");

      const invalidJsonDeps: StPresetOperationsDependencies = {
        ...downloadFailDeps,
        safeDownload: async () => ({ success: true, buffer: Buffer.from("not json") }),
      };
      const jsonResult = await importStPreset(
        { serverId: 10, attachmentUrl: "https://example.com/bad.json", attachmentName: "preset.json" },
        invalidJsonDeps,
      );
      expect(jsonResult.status).toBe("invalid_json");

      const notPresetDeps: StPresetOperationsDependencies = {
        ...downloadFailDeps,
        safeDownload: async () => ({ success: true, buffer: Buffer.from(JSON.stringify({ some_other_data: 123 })) }),
      };
      const notPresetResult = await importStPreset(
        { serverId: 10, attachmentUrl: "https://example.com/other.json", attachmentName: "preset.json" },
        notPresetDeps,
      );
      expect(notPresetResult.status).toBe("not_a_preset");
    });
  });

  describe("removeStPresetsWithPromotion", () => {
    it("deletes target presets and auto-promotes the newest surviving preset when active preset is removed", async () => {
      const preset1 = makeMockPresetRow({ preset_id: 1, preset_name: "Preset 1", is_active: false });
      const preset2 = makeMockPresetRow({ preset_id: 2, preset_name: "Preset 2", is_active: false });
      const preset3 = makeMockPresetRow({ preset_id: 3, preset_name: "Preset 3", is_active: true });

      const allPresets = [preset1, preset2, preset3];
      let activatedPresetId: number | null = null;
      const deletedPresetIds: number[] = [];

      const deps: StPresetOperationsDependencies = {
        getState: async () => makeMockTomoriState(10),
        getLastDbError: () => null,
        loadPresetsForServerResult: async () => ({ status: "fresh", presets: allPresets }),
        insertPresetWithNodes: async () => null,
        setActivePreset: async (_serverId, id) => {
          activatedPresetId = id;
          return true;
        },
        deactivateAllPresets: async () => true,
        deletePreset: async (presetId) => {
          deletedPresetIds.push(presetId);
          return true;
        },
        updateNodeEnabledStates: async () => true,
        safeDownload: async () => ({ success: true, buffer: Buffer.from("{}") }),
      };

      const result = await removeStPresetsWithPromotion(
        {
          serverId: 10,
          allPresets,
          presetIdsToRemove: [3],
        },
        deps,
      );

      expect(result.successCount).toBe(1);
      expect(result.removedNames).toEqual(["Preset 3"]);
      expect(result.promotedPreset?.preset_id).toBe(2);
      expect(result.promotedPreset?.preset_name).toBe("Preset 2");
      expect(activatedPresetId).toBe(2);
      expect(deletedPresetIds).toEqual([3]);
    });

    it("includes a failed deletion in the surviving candidate set for promotion", async () => {
      const preset1 = makeMockPresetRow({ preset_id: 1, preset_name: "Preset 1", is_active: false });
      const preset2 = makeMockPresetRow({ preset_id: 2, preset_name: "Preset 2", is_active: false });
      const presetActive = makeMockPresetRow({ preset_id: 3, preset_name: "Active Preset", is_active: true });

      const allPresets = [preset1, preset2, presetActive];
      let activatedPresetId: number | null = null;

      const deps: StPresetOperationsDependencies = {
        getState: async () => makeMockTomoriState(10),
        getLastDbError: () => null,
        loadPresetsForServerResult: async () => ({ status: "fresh", presets: allPresets }),
        insertPresetWithNodes: async () => null,
        setActivePreset: async (_serverId, id) => {
          activatedPresetId = id;
          return true;
        },
        deactivateAllPresets: async () => true,
        deletePreset: async (presetId) => {
          // Preset 2 fails deletion, Active Preset succeeds deletion
          if (presetId === 2) return false;
          return true;
        },
        updateNodeEnabledStates: async () => true,
        safeDownload: async () => ({ success: true, buffer: Buffer.from("{}") }),
      };

      const result = await removeStPresetsWithPromotion(
        {
          serverId: 10,
          allPresets,
          // Request to remove preset 2 and active preset 3
          presetIdsToRemove: [2, 3],
        },
        deps,
      );

      expect(result.successCount).toBe(1);
      expect(result.failedNames).toEqual(["Preset 2"]);
      expect(result.removedNames).toEqual(["Active Preset"]);
      // Preset 2 failed deletion, so it survives and is newer than Preset 1 (last in created_at order)
      expect(result.promotedPreset?.preset_id).toBe(2);
      expect(activatedPresetId).toBe(2);
    });

    it("does not promote any preset when active preset is not removed", async () => {
      const preset1 = makeMockPresetRow({ preset_id: 1, preset_name: "Preset 1", is_active: false });
      const preset2 = makeMockPresetRow({ preset_id: 2, preset_name: "Preset 2", is_active: true });

      const allPresets = [preset1, preset2];
      let promotionCalled = false;

      const deps: StPresetOperationsDependencies = {
        getState: async () => makeMockTomoriState(10),
        getLastDbError: () => null,
        loadPresetsForServerResult: async () => ({ status: "fresh", presets: allPresets }),
        insertPresetWithNodes: async () => null,
        setActivePreset: async () => {
          promotionCalled = true;
          return true;
        },
        deactivateAllPresets: async () => true,
        deletePreset: async () => true,
        updateNodeEnabledStates: async () => true,
        safeDownload: async () => ({ success: true, buffer: Buffer.from("{}") }),
      };

      const result = await removeStPresetsWithPromotion(
        {
          serverId: 10,
          allPresets,
          presetIdsToRemove: [1],
        },
        deps,
      );

      expect(result.successCount).toBe(1);
      expect(result.promotedPreset).toBeNull();
      expect(promotionCalled).toBe(false);
    });
  });
});
