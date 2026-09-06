import { emitScheduledWorkNudge } from "@/timers/scheduledWorkSignals";
import { invalidateAllChannelContextNoteCacheForServer } from "@/utils/cache/channelContextNoteCacheStore";
import { invalidateAllChannelLlmCacheForServer } from "@/utils/cache/channelLlmCacheStore";
import { invalidateAllChannelPromptCacheForServer } from "@/utils/cache/channelPromptCacheStore";
import { invalidateWhitelistCache } from "@/utils/cache/channelWhitelistCache";
import { invalidateAllPersonaUserBlockCacheForServer } from "@/utils/cache/personaUserBlockCache";
import { invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { invalidateAllUserBlacklistCacheForServer } from "@/utils/cache/userCache";
import { resetRepository } from "@/utils/db/repositories/ResetRepository";

export interface ServerResetOperationInput {
  serverId: number;
  serverDiscId: string;
}

export interface ServerResetOperationDependencies {
  resetServerConfiguration(serverId: number): Promise<void>;
  invalidateTomoriStateCache(serverDiscId: string): void;
  invalidateAllChannelLlmCacheForServer(serverId: number): void;
  invalidateAllChannelPromptCacheForServer(serverId: number): void;
  invalidateAllChannelContextNoteCacheForServer(serverId: number): void;
  invalidateWhitelistCache(serverDiscId: string): void;
  invalidateAllUserBlacklistCacheForServer(serverDiscId: string): void;
  invalidateAllPersonaUserBlockCacheForServer(serverId: number): void;
  emitScheduledWorkNudge(reason: string): void;
}

const defaultDependencies: ServerResetOperationDependencies = {
  resetServerConfiguration: (serverId) => resetRepository.resetServerConfiguration(serverId),
  invalidateTomoriStateCache,
  invalidateAllChannelLlmCacheForServer,
  invalidateAllChannelPromptCacheForServer,
  invalidateAllChannelContextNoteCacheForServer,
  invalidateWhitelistCache,
  invalidateAllUserBlacklistCacheForServer,
  invalidateAllPersonaUserBlockCacheForServer,
  emitScheduledWorkNudge,
};

/** Excludes this operation module from being registered as a slash subcommand by commandLoader. */
export const isCommandEnabled = () => false;

/**
 * Resets a server and clears every cache that can retain reset configuration.
 *
 * Cache eviction and scheduler coordination happen only after the repository transaction commits,
 * so a failed reset leaves the current configuration and its cached view together.
 */
export async function resetServerConfiguration(
  input: ServerResetOperationInput,
  deps: ServerResetOperationDependencies = defaultDependencies,
): Promise<void> {
  await deps.resetServerConfiguration(input.serverId);

  deps.invalidateTomoriStateCache(input.serverDiscId);
  deps.invalidateAllChannelLlmCacheForServer(input.serverId);
  deps.invalidateAllChannelPromptCacheForServer(input.serverId);
  deps.invalidateAllChannelContextNoteCacheForServer(input.serverId);
  deps.invalidateWhitelistCache(input.serverDiscId);
  deps.invalidateAllUserBlacklistCacheForServer(input.serverDiscId);
  deps.invalidateAllPersonaUserBlockCacheForServer(input.serverId);
  deps.emitScheduledWorkNudge(`server-config-reset:${input.serverId}`);
}
