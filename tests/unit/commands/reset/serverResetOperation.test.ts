import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { PrivacyLevel } from "@/types/db/schema";
import {
  getCachedActiveBlocksForPersona,
  getCachedActiveBlocksForUser,
  invalidateAllPersonaUserBlockCacheForServer,
} from "@/utils/cache/personaUserBlockCache";
import {
  getChannelContextNoteCacheEntry,
  invalidateAllChannelContextNoteCacheForServer,
  setChannelContextNoteCache,
} from "@/utils/cache/channelContextNoteCacheStore";
import {
  clearUserCache,
  getCachedBlacklistStatus,
  invalidateAllUserBlacklistCacheForServer,
} from "@/utils/cache/userCache";
import { clearScheduledWorkNudgeHandler, registerScheduledWorkNudgeHandler } from "@/timers/scheduledWorkSignals";
import { personaUserBlockRepository } from "@/utils/db/repositories/PersonaUserBlockRepository";
import { resetRepository } from "@/utils/db/repositories/ResetRepository";
import { userRepository } from "@/utils/db/repositories/UserRepository";
import { resetServerConfiguration, type ServerResetOperationDependencies } from "@/commands/reset/serverResetOperation";

const SERVER_ID = 41;
const OTHER_SERVER_ID = 42;
const SERVER_DISC_ID = "410000000000000001";
const OTHER_SERVER_DISC_ID = "420000000000000001";
const USER_DISC_ID = "430000000000000001";

afterEach(() => {
  clearScheduledWorkNudgeHandler();
  clearUserCache();
  invalidateAllPersonaUserBlockCacheForServer(SERVER_ID);
  invalidateAllPersonaUserBlockCacheForServer(OTHER_SERVER_ID);
});

function buildDependencies(events: string[]): ServerResetOperationDependencies {
  return {
    resetServerConfiguration: async (serverId) => {
      expect(serverId).toBe(SERVER_ID);
      expect(events).toEqual([]);
      events.push("repository");
    },
    invalidateTomoriStateCache: (serverDiscId) => {
      expect(serverDiscId).toBe(SERVER_DISC_ID);
      events.push("tomori");
    },
    invalidateAllChannelLlmCacheForServer: (serverId) => {
      expect(serverId).toBe(SERVER_ID);
      events.push("channel-llm");
    },
    invalidateAllChannelPromptCacheForServer: (serverId) => {
      expect(serverId).toBe(SERVER_ID);
      events.push("channel-prompt");
    },
    invalidateAllChannelContextNoteCacheForServer: (serverId) => {
      expect(serverId).toBe(SERVER_ID);
      events.push("channel-context-note");
    },
    invalidateWhitelistCache: (serverDiscId) => {
      expect(serverDiscId).toBe(SERVER_DISC_ID);
      events.push("whitelist");
    },
    invalidateAllUserBlacklistCacheForServer: (serverDiscId) => {
      expect(serverDiscId).toBe(SERVER_DISC_ID);
      events.push("personalization-blacklist");
    },
    invalidateAllPersonaUserBlockCacheForServer: (serverId) => {
      expect(serverId).toBe(SERVER_ID);
      events.push("persona-user-block");
    },
    emitScheduledWorkNudge: (reason) => {
      expect(reason).toBe(`server-config-reset:${SERVER_ID}`);
      events.push("scheduler-nudge");
    },
  };
}

describe("server reset post-commit operation", () => {
  it("invalidates each affected cache and emits one nudge after a successful repository reset", async () => {
    const events: string[] = [];

    await resetServerConfiguration({ serverId: SERVER_ID, serverDiscId: SERVER_DISC_ID }, buildDependencies(events));

    expect(events).toEqual([
      "repository",
      "tomori",
      "channel-llm",
      "channel-prompt",
      "channel-context-note",
      "whitelist",
      "personalization-blacklist",
      "persona-user-block",
      "scheduler-nudge",
    ]);
  });

  it("does not invalidate or nudge when the repository reset fails", async () => {
    const events: string[] = [];
    const dependencies = buildDependencies(events);
    dependencies.resetServerConfiguration = async () => {
      expect(events).toEqual([]);
      throw new Error("injected reset failure");
    };

    await expect(
      resetServerConfiguration({ serverId: SERVER_ID, serverDiscId: SERVER_DISC_ID }, dependencies),
    ).rejects.toThrow("injected reset failure");

    expect(events).toEqual([]);
  });

  it("delegates to the default repository and signals when dependencies are omitted", async () => {
    const resetSpy = spyOn(resetRepository, "resetServerConfiguration").mockResolvedValue();
    let nudgeReason: string | undefined;
    registerScheduledWorkNudgeHandler((reason) => {
      nudgeReason = reason;
    });

    try {
      await resetServerConfiguration({ serverId: SERVER_ID, serverDiscId: SERVER_DISC_ID });

      expect(resetSpy).toHaveBeenCalledWith(SERVER_ID);
      expect(nudgeReason).toBe(`server-config-reset:${SERVER_ID}`);
    } finally {
      resetSpy.mockRestore();
    }
  });
});

describe("server-scoped reset cache invalidators", () => {
  it("removes only context notes belonging to the reset server", () => {
    setChannelContextNoteCache(SERVER_ID, "target-a", { note: "target", depth: 1 });
    setChannelContextNoteCache(OTHER_SERVER_ID, "other-a", { note: "other", depth: 2 });

    invalidateAllChannelContextNoteCacheForServer(SERVER_ID);

    expect(getChannelContextNoteCacheEntry(SERVER_ID, "target-a")).toBeUndefined();
    expect(getChannelContextNoteCacheEntry(OTHER_SERVER_ID, "other-a")).toEqual({ note: "other", depth: 2 });
  });

  it("removes every cached personalization blacklist answer for the reset workspace", async () => {
    const userRowSpy = spyOn(userRepository, "loadByDiscordId").mockResolvedValue(null);
    const privacySpy = spyOn(userRepository, "getPrivacyLevel").mockResolvedValue(PrivacyLevel.MINIMAL);
    const blacklistSpy = spyOn(userRepository, "isBlacklisted").mockResolvedValue(false);

    try {
      await getCachedBlacklistStatus(SERVER_DISC_ID, USER_DISC_ID);
      await getCachedBlacklistStatus(OTHER_SERVER_DISC_ID, USER_DISC_ID);
      invalidateAllUserBlacklistCacheForServer(SERVER_DISC_ID);
      await getCachedBlacklistStatus(SERVER_DISC_ID, USER_DISC_ID);
      await getCachedBlacklistStatus(OTHER_SERVER_DISC_ID, USER_DISC_ID);

      expect(blacklistSpy.mock.calls.map(([serverDiscId]) => serverDiscId)).toEqual([
        SERVER_DISC_ID,
        OTHER_SERVER_DISC_ID,
        SERVER_DISC_ID,
      ]);
    } finally {
      userRowSpy.mockRestore();
      privacySpy.mockRestore();
      blacklistSpy.mockRestore();
    }
  });

  it("removes persona and user block entries for the reset server only", async () => {
    const personaSpy = spyOn(personaUserBlockRepository, "loadActiveBlocksForPersona").mockResolvedValue([]);
    const userSpy = spyOn(personaUserBlockRepository, "loadActiveBlocksForUser").mockResolvedValue([]);

    try {
      await getCachedActiveBlocksForPersona(SERVER_ID, 1);
      await getCachedActiveBlocksForUser(SERVER_ID, USER_DISC_ID);
      await getCachedActiveBlocksForPersona(OTHER_SERVER_ID, 1);
      await getCachedActiveBlocksForUser(OTHER_SERVER_ID, USER_DISC_ID);
      invalidateAllPersonaUserBlockCacheForServer(SERVER_ID);
      await getCachedActiveBlocksForPersona(SERVER_ID, 1);
      await getCachedActiveBlocksForUser(SERVER_ID, USER_DISC_ID);
      await getCachedActiveBlocksForPersona(OTHER_SERVER_ID, 1);
      await getCachedActiveBlocksForUser(OTHER_SERVER_ID, USER_DISC_ID);

      expect(personaSpy).toHaveBeenCalledTimes(3);
      expect(userSpy).toHaveBeenCalledTimes(3);
    } finally {
      personaSpy.mockRestore();
      userSpy.mockRestore();
    }
  });
});
