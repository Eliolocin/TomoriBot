import { invalidatePersonalSpotlightCache } from "@/utils/cache/personalSpotlightCache";
import { invalidateUserCache } from "@/utils/cache/userCache";
import { type PersonalResetResult, resetRepository } from "@/utils/db/repositories/ResetRepository";

/**
 * Disables commandLoader auto-registration for this operational helper.
 * Command loader iterates all files under commands/ directories; helper modules
 * must export isCommandEnabled => false to avoid missing subcommand metadata warnings.
 */
export const isCommandEnabled = () => false;

export interface PersonalResetOperationInput {
  userId: number;
}

export interface PersonalResetOperationDependencies {
  resetPersonalConfiguration: (userId: number) => Promise<PersonalResetResult | null>;
  invalidateUserCache: (userDiscId: string) => void;
  invalidatePersonalSpotlightCache: (serverId: number, userId?: number, channelDiscId?: string) => void;
}

const defaultDependencies: PersonalResetOperationDependencies = {
  resetPersonalConfiguration: (userId) => resetRepository.resetPersonalConfiguration(userId),
  invalidateUserCache,
  invalidatePersonalSpotlightCache,
};

/**
 * Coordinates atomic personal reset and post-commit cache invalidation.
 *
 * Invalidation runs strictly after the database transaction succeeds. If the
 * database transaction throws or the target user does not exist, zero cache
 * entries are invalidated.
 */
export async function executePersonalReset(
  input: PersonalResetOperationInput,
  deps: PersonalResetOperationDependencies = defaultDependencies,
): Promise<PersonalResetResult | null> {
  const result = await deps.resetPersonalConfiguration(input.userId);
  if (!result) return null;

  deps.invalidateUserCache(result.userDiscId);
  for (const serverId of result.affectedServerIds) {
    deps.invalidatePersonalSpotlightCache(serverId, input.userId);
  }

  return result;
}
