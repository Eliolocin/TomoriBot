import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { executePersonalReset, type PersonalResetOperationDependencies } from "@/commands/reset/personalResetOperation";
import {
  clearPersonalSpotlightCache,
  getCachedPersonalSpotlightStatus,
  getPersonalSpotlightCacheStats,
  invalidatePersonalSpotlightCache,
} from "@/utils/cache/personalSpotlightCache";
import { clearUserCache, getCachedUserRow, getUserCacheStats, invalidateUserCache } from "@/utils/cache/userCache";
import { userRepository } from "@/utils/db/repositories/UserRepository";

const USER_ID = 51;
const USER_DISC_ID = "510000000000000001";
const SERVER_ID_A = 101;
const SERVER_ID_B = 102;

afterEach(() => {
  clearUserCache();
  clearPersonalSpotlightCache();
});

function buildDependencies(events: string[]): PersonalResetOperationDependencies {
  return {
    resetPersonalConfiguration: async (userId) => {
      expect(userId).toBe(USER_ID);
      expect(events).toEqual([]);
      events.push("repository");
      return {
        userDiscId: USER_DISC_ID,
        affectedServerIds: [SERVER_ID_A, SERVER_ID_B],
      };
    },
    invalidateUserCache: (userDiscId) => {
      expect(userDiscId).toBe(USER_DISC_ID);
      events.push("user-cache");
    },
    invalidatePersonalSpotlightCache: (serverId, userId) => {
      expect(userId).toBe(USER_ID);
      events.push(`spotlight-cache:${serverId}`);
    },
  };
}

describe("personal reset post-commit operation", () => {
  it("invalidates user cache and affected spotlight caches after a successful repository reset", async () => {
    const events: string[] = [];

    const result = await executePersonalReset({ userId: USER_ID }, buildDependencies(events));

    expect(result).toEqual({
      userDiscId: USER_DISC_ID,
      affectedServerIds: [SERVER_ID_A, SERVER_ID_B],
    });
    expect(events).toEqual([
      "repository",
      "user-cache",
      `spotlight-cache:${SERVER_ID_A}`,
      `spotlight-cache:${SERVER_ID_B}`,
    ]);
  });

  it("does not invalidate caches when repository reset fails", async () => {
    const events: string[] = [];
    const deps: PersonalResetOperationDependencies = {
      resetPersonalConfiguration: async () => {
        events.push("repository-error");
        throw new Error("repository failure");
      },
      invalidateUserCache: () => events.push("user-cache"),
      invalidatePersonalSpotlightCache: () => events.push("spotlight-cache"),
    };

    await expect(executePersonalReset({ userId: USER_ID }, deps)).rejects.toThrow("repository failure");
    expect(events).toEqual(["repository-error"]);
  });

  it("does not invalidate caches when user record is not found", async () => {
    const events: string[] = [];
    const deps: PersonalResetOperationDependencies = {
      resetPersonalConfiguration: async () => {
        events.push("repository-null");
        return null;
      },
      invalidateUserCache: () => events.push("user-cache"),
      invalidatePersonalSpotlightCache: () => events.push("spotlight-cache"),
    };

    const result = await executePersonalReset({ userId: USER_ID }, deps);

    expect(result).toBeNull();
    expect(events).toEqual(["repository-null"]);
  });

  it("evicts populated user and spotlight cache entries when real invalidators are wired", async () => {
    // Populate user cache entry
    const loadSpy = spyOn(userRepository, "loadByDiscordId").mockResolvedValue({
      user_id: USER_ID,
      user_disc_id: USER_DISC_ID,
      language_pref: "en-US",
      created_at: new Date(),
      updated_at: new Date(),
      privacy_level: 0,
      registration_locale: null,
    });
    const privacySpy = spyOn(userRepository, "getPrivacyLevel").mockResolvedValue(0);

    await getCachedUserRow(USER_DISC_ID);
    expect(getUserCacheStats().cacheSize).toBe(1);

    // Populate spotlight cache entry
    const hasSpotlightsSpy = spyOn(userRepository, "serverHasPersonalSpotlights").mockResolvedValue(true);
    const spotlightStatusSpy = spyOn(userRepository, "getPersonalSpotlightStatus").mockResolvedValue({
      hasPersonalSpotlight: true,
      allowedPersonaIds: [1],
      autoTriggerPersonaId: null,
    });

    await getCachedPersonalSpotlightStatus(SERVER_ID_A, USER_ID, "channel_1");
    expect(getPersonalSpotlightCacheStats().size).toBe(1);

    try {
      const result = await executePersonalReset(
        { userId: USER_ID },
        {
          resetPersonalConfiguration: async () => ({
            userDiscId: USER_DISC_ID,
            affectedServerIds: [SERVER_ID_A],
          }),
          invalidateUserCache,
          invalidatePersonalSpotlightCache,
        },
      );

      expect(result).not.toBeNull();
      // Both populated caches must now be evicted
      expect(getUserCacheStats().cacheSize).toBe(0);
      expect(getPersonalSpotlightCacheStats().size).toBe(0);
    } finally {
      loadSpy.mockRestore();
      privacySpy.mockRestore();
      hasSpotlightsSpy.mockRestore();
      spotlightStatusSpy.mockRestore();
    }
  });
});
