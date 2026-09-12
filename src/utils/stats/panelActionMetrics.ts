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
 * Suppresses repeat reports so a pool-wide failure reports once, not once per panel action.
 *
 * Mirrors `MetricSampleRepository.warnOnce`, including the reset on the next write that gets far
 * enough to be recorded: a second outage after a recovery is worth knowing about.
 */
let hasReportedSinceSuccess = false;

/**
 * Reports a failed `panel_action` write, once per outage.
 *
 * `log.metric`, not `log.warn`: production pins pino at level `error`, so the warn this replaces
 * was dropped before either sink and a silently dead success counter left no trace anywhere. Not
 * `log.error` either, which would attempt an `error_logs` insert down the same pool that just
 * failed, adding load to the incident it reports.
 */
function reportPanelActionFailure(action: PanelAction, error: unknown): void {
  if (hasReportedSinceSuccess) return;
  hasReportedSinceSuccess = true;

  log.metric("panel_action_failure", {
    reason: "panel_action_stat_write_failed",
    action,
    error: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Clears the suppression latch, for tests that need a known starting state.
 *
 * The latch is module-level because it tracks an outage rather than a call. Exposed rather than
 * reset by re-importing the module, which `mock.module` cannot undo cleanly for the whole run.
 */
export function resetPanelActionFailureReporting(): void {
  hasReportedSinceSuccess = false;
}

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

    // Cleared before the write, because `record` returns void and a buffered counter cannot report
    // its own later failure. The next action that reaches this point re-arms reporting.
    hasReportedSinceSuccess = false;
    deps.record({
      serverId: input.serverId,
      userId: userRow.user_id,
      metric: "panel_action",
      metricKey: input.action,
    });
  } catch (error) {
    reportPanelActionFailure(input.action, error);
  }
}
