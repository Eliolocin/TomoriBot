/**
 * Aggregate recording for completed panel operations.
 *
 * Kept as its own leaf module so callers take on one narrow runtime dependency
 * instead of pulling the repository layer into files that many things import.
 *
 * Scope constraint: operational telemetry only. Nothing behavioral reads the
 * `panel_action` counter. Recording is buffered and best-effort through
 * `StatRepository`.
 */

import type { PanelAction } from "@/constants/panelActions";
import { getCachedUserRow } from "@/utils/cache/userCache";
import { statRepository, type RecordStatInput } from "@/utils/db/repositories/StatRepository";
import { log } from "@/utils/misc/logger";

export interface RecordPanelActionInput {
  action: PanelAction;
  /** Internal servers FK for the workspace the panel resolved, never the Discord snowflake. */
  serverId: number;
  userDiscId: string;
}

export interface PanelActionMetricsDependencies {
  loadUserRow(userDiscId: string): Promise<{ user_id?: number } | null>;
  record(input: RecordStatInput): void;
}

const defaultDependencies: PanelActionMetricsDependencies = {
  loadUserRow: (userDiscId) => getCachedUserRow(userDiscId),
  record: (input) => statRepository.recordStat(input),
};

/**
 * Records one `panel_action` counter after a semantic panel operation succeeds.
 *
 * Never rejects: telemetry writes must never throw or delay the response path.
 */
export async function recordPanelActionStat(
  input: RecordPanelActionInput,
  deps: PanelActionMetricsDependencies = defaultDependencies,
): Promise<void> {
  // stat_counters.server_id and user_id are NOT NULL FKs. An unscoped action
  // or an unregistered user records nothing rather than inventing a sentinel row.
  if (!input.serverId || !input.userDiscId) return;

  try {
    const userRow = await deps.loadUserRow(input.userDiscId);
    if (!userRow?.user_id) return;

    deps.record({
      serverId: input.serverId,
      userId: userRow.user_id,
      metric: "panel_action",
      metricKey: input.action,
    });
  } catch (error) {
    log.warn(`Failed to record panel_action stat for ${input.action}`, error);
  }
}
