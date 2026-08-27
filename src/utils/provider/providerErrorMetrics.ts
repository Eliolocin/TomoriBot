/**
 * Aggregate recording for terminal provider failures.
 *
 * Kept as its own leaf module so `src/types/stream/interfaces.ts` (where `BaseStreamAdapter`
 * lives) takes on exactly one narrow runtime dependency instead of pulling the repository layer
 * into a file almost everything imports.
 *
 * Scope constraint: this is operational telemetry only. Nothing behavioral may read the
 * `provider_error` counter, so no persona, routing, or model-selection decision ever takes a
 * failure rate as input.
 */

import type { ProviderError, StreamContext } from "@/types/stream/interfaces";
import { statRepository } from "@/utils/db/repositories/StatRepository";
import { log } from "@/utils/misc/logger";

/**
 * Record one `provider_error` counter for a failure that reached the user.
 *
 * Never throws: a telemetry write must not be able to turn a recoverable provider error into a
 * crash on the error path itself.
 *
 * @param providerName - Adapter identity used as the first half of the metric key.
 */
export function recordProviderErrorStat(
  providerName: string,
  providerError: ProviderError,
  context?: StreamContext,
): void {
  const serverId = context?.tomoriState?.server_id;
  const userId = context?.triggererUserId;
  // stat_counters.server_id and user_id are NOT NULL FKs, so an unscoped failure (a DM, or a
  // flow with no resolved triggerer) records nothing rather than inventing a sentinel row.
  if (!serverId || !userId) return;

  try {
    statRepository.recordStat({
      serverId,
      userId,
      metric: "provider_error",
      metricKey: `${providerName}:${providerError.code ?? "unknown"}`,
    });
  } catch (error) {
    log.warn(`Failed to record provider_error stat for ${providerName}`, error);
  }
}
