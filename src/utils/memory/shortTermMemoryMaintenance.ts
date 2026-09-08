import type { TomoriState } from "@/types/db/schema";
import {
  getShortTermMemoryForServerChannel,
  getShortTermMemoryForUserChannel,
  preWarmStmEntry,
} from "@/utils/cache/shortTermMemoryCache";
import { shortTermMemoryRepository } from "@/utils/db/repositories/ShortTermMemoryRepository";
import { log } from "@/utils/misc/logger";

const DEFAULT_STM_REFRESH_CADENCE = 5;

export interface ShortTermMemoryMaintenanceParams {
  triggeringUserId: string;
  currentChannelId: string;
  currentServerId: string;
  tomoriState: TomoriState | null | undefined;
  explicitLongTermMemoryIntent?: boolean;
  disableShortTermMemoryUpdate?: boolean;
}

/**
 * Returns whether autonomous short-term-memory maintenance is due for this turn.
 *
 * This intentionally does not depend on user wording. The STM cadence is an internal
 * maintenance trigger, so Deliberate Tool Mode should treat a due refresh the same way
 * it treats user-requested tool intent and expose only `update_short_term_memory` when
 * no other tool is needed.
 */
export async function isShortTermMemoryMaintenanceDue(params: ShortTermMemoryMaintenanceParams): Promise<boolean> {
  const { tomoriState } = params;

  if (!tomoriState?.llm?.has_tools) return false;
  if (tomoriState.llm.llm_provider === "novelai") return false;
  if (tomoriState.config?.short_term_memory_enabled === false) return false;
  if (params.explicitLongTermMemoryIntent) return false;
  if (params.disableShortTermMemoryUpdate) return false;

  try {
    const numericServerId = tomoriState.server_id ?? null;
    const stmConfig = numericServerId ? await shortTermMemoryRepository.getStmConfig(numericServerId) : null;
    const refreshCadence = stmConfig?.refresh_cadence ?? DEFAULT_STM_REFRESH_CADENCE;

    await (params.currentServerId === "DM"
      ? preWarmStmEntry("user", params.triggeringUserId, params.currentChannelId, tomoriState.persona_id)
      : preWarmStmEntry("server", params.currentServerId, params.currentChannelId, tomoriState.persona_id));

    const sameChannelMemory =
      params.currentServerId === "DM"
        ? getShortTermMemoryForUserChannel(params.triggeringUserId, params.currentChannelId, tomoriState.persona_id)
        : getShortTermMemoryForServerChannel(params.currentServerId, params.currentChannelId, tomoriState.persona_id);

    return (sameChannelMemory?.turnsSinceRefresh ?? 0) >= refreshCadence;
  } catch (error) {
    await log.error(
      `[isShortTermMemoryMaintenanceDue] Failed to resolve short-term memory maintenance - triggeringUserId=${params.triggeringUserId}, currentChannelId=${params.currentChannelId}`,
      error,
      {
        errorType: "SHORT_TERM_MEMORY_CONTEXT_ERROR",
        metadata: { userDiscId: params.triggeringUserId, currentChannelId: params.currentChannelId },
      },
    );
    return false;
  }
}
