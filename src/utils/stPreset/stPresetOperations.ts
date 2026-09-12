import type { StPresetNodeRow, StPresetRow, TomoriState } from "@/types/db/schema";
import type { PanelReadStatus } from "@/types/discord/panel";
import {
  getCachedTomoriState,
  getLastDbError,
  getRecordedDbError,
  invalidateTomoriStateCache,
} from "@/utils/cache/tomoriStateCache";
import {
  presetRepository,
  type StPresetNodeCounts,
  type StPresetsReadResult,
} from "@/utils/db/repositories/PresetRepository";
import { safeDownload } from "@/utils/security/safeDownload";
import { log } from "@/utils/misc/logger";
import {
  MAX_PRESET_FILE_SIZE_MB,
  MAX_PRESET_NAME_LENGTH,
  collectUnsupportedEnabledMacros,
  derivePresetName,
  normalizePresetShape,
  parsePresetNodes,
  validateAttachment,
  type RawSTPreset,
} from "./stPresetImportParser";

export interface ImportStPresetInput {
  serverId: number;
  attachmentUrl: string;
  attachmentName?: string | null;
  attachmentSize?: number;
  attachmentContentType?: string | null;
  customPresetName?: string;
  description?: string | null;
}

export type ImportStPresetResult =
  | {
      status: "success";
      preset: StPresetRow;
      nodes: Omit<StPresetNodeRow, "node_id" | "preset_id">[];
      presetName: string;
      markerCount: number;
      toggleableCount: number;
      enabledCount: number;
      commentOnlyCount: number;
      disabledByPreset: number;
      legacyNodeCount: number;
      sourceKind: "modern" | "legacy_text_completion";
      unsupportedEnabledMacros: string[];
    }
  | {
      status: "invalid_file";
      errorKey: string;
    }
  | {
      status: "file_too_large";
      maxSizeMB: number;
    }
  | {
      status: "download_failed";
    }
  | {
      status: "invalid_json";
    }
  | {
      status: "not_a_preset";
    }
  | {
      status: "no_nodes";
    }
  | {
      status: "insert_failed";
    };

export interface ActivateStPresetInput {
  serverId: number;
  presetId: number;
}

export interface DeactivateAllStPresetsInput {
  serverId: number;
}

export interface DeleteStPresetInput {
  serverId: number;
  presetId: number;
}

export interface UpdateStPresetNodesInput {
  serverId: number;
  presetId: number;
  enabledMap: Map<string, boolean>;
}

export interface RemoveStPresetsWithPromotionInput {
  serverId: number;
  allPresets: StPresetRow[];
  presetIdsToRemove: number[];
}

export interface RemoveStPresetsWithPromotionResult {
  successCount: number;
  failedNames: string[];
  removedNames: string[];
  promotedPreset: StPresetRow | null;
}

export interface StPresetScopeData {
  scopeDiscId: string;
  serverId: number;
  readStatus: PanelReadStatus;
  presets: StPresetRow[];
  activePresetId: number | null;
  activeNodeCounts?: StPresetNodeCounts | null;
}

export interface StPresetOperationsDependencies {
  getState: (scopeDiscId: string) => Promise<TomoriState | null>;
  getLastDbError: (scopeDiscId: string) => { message: string; timestamp: number } | null;
  getRecordedDbError?: (scopeDiscId: string) => { message: string; timestamp: number } | null;
  refresh?: (scopeDiscId: string) => void | Promise<void>;
  loadPresetsForServerResult: (serverId: number) => Promise<StPresetsReadResult>;
  insertPresetWithNodes: (
    serverId: number,
    presetName: string,
    rawJson: unknown,
    nodes: Omit<StPresetNodeRow, "node_id" | "preset_id">[],
    description?: string | null,
  ) => Promise<StPresetRow | null>;
  setActivePreset: (serverId: number, presetId: number) => Promise<boolean>;
  deactivateAllPresets: (serverId: number) => Promise<boolean>;
  deletePreset: (presetId: number, serverId: number) => Promise<boolean>;
  updateNodeEnabledStates: (presetId: number, enabledMap: Map<string, boolean>, serverId: number) => Promise<boolean>;
  loadToggleableNodes?: (presetId: number) => Promise<StPresetNodeRow[]>;
  countToggleableNodesForServer?: (presetId: number, serverId: number) => Promise<StPresetNodeCounts>;
  safeDownload: typeof safeDownload;
}

const defaultDependencies: StPresetOperationsDependencies = {
  getState: (scopeDiscId) => getCachedTomoriState(scopeDiscId),
  getLastDbError: (scopeDiscId) => getLastDbError(scopeDiscId),
  getRecordedDbError: (scopeDiscId) => getRecordedDbError(scopeDiscId),
  refresh: (scopeDiscId) => invalidateTomoriStateCache(scopeDiscId),
  loadPresetsForServerResult: (serverId) => presetRepository.loadPresetsForServerResult(serverId),
  insertPresetWithNodes: (serverId, presetName, rawJson, nodes, description) =>
    presetRepository.insertPresetWithNodes(serverId, presetName, rawJson, nodes, description),
  setActivePreset: (serverId, presetId) => presetRepository.setActivePreset(serverId, presetId),
  deactivateAllPresets: (serverId) => presetRepository.deactivateAllPresets(serverId),
  deletePreset: (presetId, serverId) => presetRepository.deletePreset(presetId, serverId),
  updateNodeEnabledStates: (presetId, enabledMap, serverId) =>
    presetRepository.updateNodeEnabledStates(presetId, enabledMap, serverId),
  loadToggleableNodes: (presetId) => presetRepository.loadToggleableNodes(presetId),
  countToggleableNodesForServer: (presetId, serverId) =>
    presetRepository.countToggleableNodesForServer(presetId, serverId),
  safeDownload,
};

export async function importStPreset(
  input: ImportStPresetInput,
  deps: StPresetOperationsDependencies = defaultDependencies,
): Promise<ImportStPresetResult> {
  const validation = validateAttachment(input.attachmentName ?? "", input.attachmentContentType);
  if (!validation.isValid) {
    return { status: "invalid_file", errorKey: validation.errorKey ?? "invalid_format" };
  }

  const maxSizeBytes = MAX_PRESET_FILE_SIZE_MB * 1024 * 1024;
  if (input.attachmentSize && input.attachmentSize > maxSizeBytes) {
    return { status: "file_too_large", maxSizeMB: MAX_PRESET_FILE_SIZE_MB };
  }

  const downloadResult = await deps.safeDownload(input.attachmentUrl, {
    maxSizeMB: MAX_PRESET_FILE_SIZE_MB,
    timeoutMs: 15000,
    knownSize: input.attachmentSize,
  });

  if (!downloadResult.success || !downloadResult.buffer) {
    return { status: "download_failed" };
  }

  let rawPreset: RawSTPreset;
  try {
    rawPreset = JSON.parse(downloadResult.buffer.toString("utf-8"));
  } catch (error) {
    // A preset that will not parse, or is not JSON at all, is the actor's file rather than an
    // incident, but the uploaded bytes are gone by the time they see the receipt, so warn here is
    // still not enough to diagnose a report. Recorded as a metric to stay out of the error stream.
    log.metric("panel_failure", {
      namespace: "config",
      tone: "error",
      reason: "st_preset_upload_invalid_json",
      detail: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
    return { status: "invalid_json" };
  }

  const normalizedPreset = normalizePresetShape(rawPreset);
  if (!normalizedPreset) {
    return { status: "not_a_preset" };
  }

  const parseResult = parsePresetNodes(normalizedPreset);
  if (!parseResult) {
    return { status: "no_nodes" };
  }

  const presetName = input.customPresetName?.trim()
    ? input.customPresetName.trim().slice(0, MAX_PRESET_NAME_LENGTH)
    : derivePresetName(input.attachmentName ?? "Unnamed Preset");

  const preset = await deps.insertPresetWithNodes(
    input.serverId,
    presetName,
    rawPreset,
    parseResult.nodes,
    input.description,
  );

  if (!preset) {
    return { status: "insert_failed" };
  }

  if (preset.preset_id) {
    await deps.setActivePreset(input.serverId, preset.preset_id);
  }

  const markerCount = parseResult.nodes.filter((n) => n.is_marker).length;
  const toggleableCount = parseResult.nodes.filter((n) => !n.is_marker).length;
  const enabledCount = parseResult.nodes.filter((n) => n.is_enabled && !n.is_marker && !n.is_comment).length;
  const unsupportedEnabledMacros = collectUnsupportedEnabledMacros(parseResult.nodes);

  return {
    status: "success",
    preset,
    nodes: parseResult.nodes,
    presetName,
    markerCount,
    toggleableCount,
    enabledCount,
    commentOnlyCount: parseResult.commentOnlyCount,
    disabledByPreset: parseResult.disabledByPreset,
    legacyNodeCount: parseResult.legacyNodeCount,
    sourceKind: parseResult.sourceKind,
    unsupportedEnabledMacros,
  };
}

export async function activateStPreset(
  input: ActivateStPresetInput,
  deps: StPresetOperationsDependencies = defaultDependencies,
): Promise<boolean> {
  return deps.setActivePreset(input.serverId, input.presetId);
}

export async function deactivateAllStPresets(
  input: DeactivateAllStPresetsInput,
  deps: StPresetOperationsDependencies = defaultDependencies,
): Promise<boolean> {
  return deps.deactivateAllPresets(input.serverId);
}

export async function deleteStPreset(
  input: DeleteStPresetInput,
  deps: StPresetOperationsDependencies = defaultDependencies,
): Promise<boolean> {
  return deps.deletePreset(input.presetId, input.serverId);
}

export async function updateStPresetNodes(
  input: UpdateStPresetNodesInput,
  deps: StPresetOperationsDependencies = defaultDependencies,
): Promise<boolean> {
  return deps.updateNodeEnabledStates(input.presetId, input.enabledMap, input.serverId);
}

export async function removeStPresetsWithPromotion(
  input: RemoveStPresetsWithPromotionInput,
  deps: StPresetOperationsDependencies = defaultDependencies,
): Promise<RemoveStPresetsWithPromotionResult> {
  const { serverId, allPresets, presetIdsToRemove } = input;
  const toRemoveSet = new Set(presetIdsToRemove);
  const presetsToRemove = allPresets.filter((p) => p.preset_id !== undefined && toRemoveSet.has(p.preset_id));

  const removingActivePreset = presetsToRemove.some((p) => p.is_active);

  let successCount = 0;
  const failedNames: string[] = [];
  const successfullyDeletedIds = new Set<number>();

  for (const preset of presetsToRemove) {
    if (preset.preset_id === undefined) continue;
    const deleted = await deps.deletePreset(preset.preset_id, serverId);
    if (deleted) {
      successCount++;
      successfullyDeletedIds.add(preset.preset_id);
    } else {
      failedNames.push(preset.preset_name);
    }
  }

  let promotedPreset: StPresetRow | null = null;
  if (removingActivePreset) {
    const activePresetWasDeleted = presetsToRemove.some(
      (p) => p.is_active && p.preset_id !== undefined && successfullyDeletedIds.has(p.preset_id),
    );
    if (activePresetWasDeleted) {
      // Presets whose deletion failed remain in the database and are valid promotion candidates.
      const survivingPresets = allPresets.filter(
        (p) => p.preset_id !== undefined && !successfullyDeletedIds.has(p.preset_id),
      );
      const candidate = survivingPresets[survivingPresets.length - 1] ?? null;
      if (candidate && candidate.preset_id !== undefined) {
        const promoted = await deps.setActivePreset(serverId, candidate.preset_id);
        if (promoted) {
          promotedPreset = candidate;
        }
      }
    }
  }

  const removedNames = presetsToRemove.filter((p) => !failedNames.includes(p.preset_name)).map((p) => p.preset_name);

  return {
    successCount,
    failedNames,
    removedNames,
    promotedPreset,
  };
}

export async function loadStPresetScopeData(
  scopeDiscId: string,
  forceRefresh = false,
  deps: StPresetOperationsDependencies = defaultDependencies,
): Promise<StPresetScopeData | null> {
  if (forceRefresh) {
    await deps.refresh?.(scopeDiscId);
  }

  const tomoriState = await deps.getState(scopeDiscId);

  if (!tomoriState) {
    const dbError = deps.getLastDbError(scopeDiscId);
    if (dbError) {
      return {
        scopeDiscId,
        serverId: 0,
        readStatus: "unavailable",
        presets: [],
        activePresetId: null,
      };
    }
    return null;
  }

  const presetsResult = await deps.loadPresetsForServerResult(tomoriState.server_id);
  const dbError = (deps.getRecordedDbError ?? deps.getLastDbError)(scopeDiscId);

  let readStatus: PanelReadStatus = "fresh";
  if (presetsResult.status === "unavailable") {
    readStatus = "unavailable";
  } else if (dbError) {
    readStatus = "stale";
  }

  const presets = presetsResult.presets;
  const activePreset = presets.find((p) => p.is_active);
  const activePresetId = activePreset?.preset_id ?? null;

  let activeNodeCounts: StPresetNodeCounts | null = null;
  if (activePresetId !== null && readStatus === "fresh") {
    const counter =
      deps.countToggleableNodesForServer ?? ((p, s) => presetRepository.countToggleableNodesForServer(p, s));
    activeNodeCounts = await counter(activePresetId, tomoriState.server_id);
  }

  return {
    scopeDiscId,
    serverId: tomoriState.server_id,
    readStatus,
    presets,
    activePresetId,
    activeNodeCounts,
  };
}

export async function loadStPresetToggleableNodes(
  presetId: number,
  deps: StPresetOperationsDependencies = defaultDependencies,
): Promise<StPresetNodeRow[]> {
  return (deps.loadToggleableNodes ?? ((id) => presetRepository.loadToggleableNodes(id)))(presetId);
}

export const stPresetOperations = {
  importStPreset,
  activateStPreset,
  deactivateAllStPresets,
  deleteStPreset,
  updateStPresetNodes,
  removeStPresetsWithPromotion,
  loadStPresetScopeData,
  loadToggleableNodes: loadStPresetToggleableNodes,
};
