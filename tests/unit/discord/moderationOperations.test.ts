import { beforeAll, describe, expect, it } from "bun:test";
import type { ChannelPersonaWhitelistRow, ChannelWhitelistRow, RoleWhitelistRow, TomoriState } from "@/types/db/schema";
import { CooldownType } from "@/types/db/schema";
import { whitelistRepository } from "@/utils/db/repositories";
import type { PersonaUserBlockWithPersona } from "@/utils/db/repositories/PersonaUserBlockRepository";
import {
  addUserToBlacklist,
  addWhitelistRole,
  loadModerationMemberAccessData,
  loadModerationScopeData,
  loadModerationUserBlacklistAddData,
  loadModerationWhitelistChannelAddData,
  removePersonaUserBlock,
  removeUserBlacklistBatch,
  removeUserFromBlacklist,
  removeWhitelistChannel,
  removeWhitelistRole,
  replacePersonaChannelWhitelist,
  updateMemberPermissions,
  updateQuotaSettings,
  upsertWhitelistChannel,
  type ModerationDataDependencies,
  type ModerationMemberAccessDataDependencies,
  type ModerationUserBlacklistAddDataDependencies,
  type QuotaOperationsDependencies,
} from "@/utils/moderation/moderationOperations";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

function mockTomoriState(overrides: Partial<TomoriState["config"]> = {}): TomoriState {
  return {
    server_id: 10,
    server_disc_id: "1001",
    persona_id: 1,
    persona_nickname: "Tomori",
    is_alter: false,
    config: {
      server_id: 10,
      server_memteaching_enabled: true,
      attribute_memteaching_enabled: false,
      sampledialogue_memteaching_enabled: true,
      prompt_snapshot_enabled: false,
      ...overrides,
    },
  } as unknown as TomoriState;
}

describe("WhitelistRepository error handling", () => {
  it("returns unavailable result while legacy array wrapper throws from failing read seam", async () => {
    const originalChannels = whitelistRepository.getAllWhitelistChannels;
    const originalPersonas = whitelistRepository.getAllWhitelistPersonas;
    const originalRoles = whitelistRepository.getAllWhitelistRoles;

    try {
      whitelistRepository.getAllWhitelistChannels = async () => {
        throw new Error("Channel table read failure");
      };
      whitelistRepository.getAllWhitelistPersonas = async () => {
        throw new Error("Persona whitelist table read failure");
      };
      whitelistRepository.getAllWhitelistRoles = async () => {
        throw new Error("Role whitelist table read failure");
      };

      await expect(whitelistRepository.getAllWhitelistChannels(10)).rejects.toThrow("Channel table read failure");
      await expect(whitelistRepository.getAllWhitelistPersonas(10)).rejects.toThrow(
        "Persona whitelist table read failure",
      );
      await expect(whitelistRepository.getAllWhitelistRoles(10)).rejects.toThrow("Role whitelist table read failure");

      const channelsResult = await whitelistRepository.getAllWhitelistChannelsResult(10);
      expect(channelsResult).toEqual({ status: "unavailable", channels: [] });

      const personasResult = await whitelistRepository.getAllWhitelistPersonasResult(10);
      expect(personasResult).toEqual({ status: "unavailable", personas: [] });

      const rolesResult = await whitelistRepository.getAllWhitelistRolesResult(10);
      expect(rolesResult).toEqual({ status: "unavailable", roles: [] });
    } finally {
      whitelistRepository.getAllWhitelistChannels = originalChannels;
      whitelistRepository.getAllWhitelistPersonas = originalPersonas;
      whitelistRepository.getAllWhitelistRoles = originalRoles;
    }
  });
});

describe("moderationOperations loader", () => {
  it("returns null when workspace is authoritatively not set up", async () => {
    const deps: ModerationDataDependencies = {
      getState: async () => null,
      getAllPersonas: async () => [],
      getLastDbError: () => null,
      getBlacklist: async () => ({ status: "fresh", memberIds: [] }),
      getPersonaBlocks: async () => ({ status: "fresh", blocks: [] }),
      getWhitelistChannels: async () => ({ status: "fresh", channels: [] }),
      getWhitelistPersonas: async () => ({ status: "fresh", personas: [] }),
      getWhitelistRoles: async () => ({ status: "fresh", roles: [] }),
      getTextQuotaConfig: async () => ({ status: "fresh", config: null }),
      getImageQuotaConfig: async () => ({ status: "fresh", config: null }),
      getVideoQuotaConfig: async () => ({ status: "fresh", config: null }),
    };

    const result = await loadModerationScopeData("1001", false, deps);
    expect(result).toBeNull();
  });

  it("returns unavailable when workspace state is null alongside a recent DB error", async () => {
    const deps: ModerationDataDependencies = {
      getState: async () => null,
      getAllPersonas: async () => [],
      getLastDbError: () => ({ message: "Database connection failed", timestamp: Date.now() }),
      getBlacklist: async () => ({ status: "fresh", memberIds: [] }),
      getPersonaBlocks: async () => ({ status: "fresh", blocks: [] }),
      getWhitelistChannels: async () => ({ status: "fresh", channels: [] }),
      getWhitelistPersonas: async () => ({ status: "fresh", personas: [] }),
      getWhitelistRoles: async () => ({ status: "fresh", roles: [] }),
      getTextQuotaConfig: async () => ({ status: "fresh", config: null }),
      getImageQuotaConfig: async () => ({ status: "fresh", config: null }),
      getVideoQuotaConfig: async () => ({ status: "fresh", config: null }),
    };

    const result = await loadModerationScopeData("1001", false, deps);
    expect(result).not.toBeNull();
    expect(result?.readStatus).toBe("unavailable");
    expect(result?.guildId).toBe("1001");
  });

  it("marks readStatus as stale when cached usable state is returned alongside a current DB error", async () => {
    const deps: ModerationDataDependencies = {
      getState: async () => mockTomoriState(),
      getAllPersonas: async () => [mockTomoriState()],
      getLastDbError: () => ({ message: "Transient network timeout", timestamp: Date.now() }),
      getBlacklist: async () => ({ status: "fresh", memberIds: ["user-1"] }),
      getPersonaBlocks: async () => ({ status: "fresh", blocks: [] }),
      getWhitelistChannels: async () => ({ status: "fresh", channels: [] }),
      getWhitelistPersonas: async () => ({ status: "fresh", personas: [] }),
      getWhitelistRoles: async () => ({ status: "fresh", roles: [] }),
      getTextQuotaConfig: async () => ({ status: "fresh", config: null }),
      getImageQuotaConfig: async () => ({ status: "fresh", config: null }),
      getVideoQuotaConfig: async () => ({ status: "fresh", config: null }),
    };

    const data = await loadModerationScopeData("1001", false, deps);
    expect(data).not.toBeNull();
    expect(data?.readStatus).toBe("stale");
    expect(data?.memberAccess.serverMemteachingEnabled).toBe(true);
    expect(data?.userBlacklist.personalizationUserIds).toEqual(["user-1"]);
  });

  it("does not treat the startup grace marker as a failed read when all scope data loaded", async () => {
    const deps: ModerationDataDependencies = {
      getState: async () => mockTomoriState(),
      getAllPersonas: async () => [mockTomoriState()],
      getLastDbError: () => ({ message: "Bot is still starting up (startup grace period)", timestamp: Date.now() }),
      getRecordedDbError: () => null,
      getBlacklist: async () => ({ status: "fresh", memberIds: [] }),
      getPersonaBlocks: async () => ({ status: "fresh", blocks: [] }),
      getWhitelistChannels: async () => ({ status: "fresh", channels: [] }),
      getWhitelistPersonas: async () => ({ status: "fresh", personas: [] }),
      getWhitelistRoles: async () => ({ status: "fresh", roles: [] }),
      getTextQuotaConfig: async () => ({ status: "fresh", config: null }),
      getImageQuotaConfig: async () => ({ status: "fresh", config: null }),
      getVideoQuotaConfig: async () => ({ status: "fresh", config: null }),
    };

    const data = await loadModerationScopeData("1001", false, deps);
    expect(data?.readStatus).toBe("fresh");
  });

  it("loads fresh moderation scope data correctly including quotas", async () => {
    const channelRow: ChannelWhitelistRow = {
      server_id: 10,
      channel_disc_id: "chan-1",
      cooldown_type: CooldownType.PER_USER,
      cooldown_length: 10,
      created_at: new Date(),
      updated_at: new Date(),
    };

    const personaChannelRow: ChannelPersonaWhitelistRow = {
      server_id: 10,
      persona_id: 1,
      channel_disc_id: "chan-2",
      created_at: new Date(),
    };

    const roleRow: RoleWhitelistRow = {
      server_id: 10,
      role_disc_id: "role-1",
      created_at: new Date(),
      updated_at: new Date(),
    };

    const blockRow: PersonaUserBlockWithPersona = {
      server_id: 10,
      persona_id: 1,
      user_disc_id: "user-block-1",
      block_type: "temporary",
      reason: "test reason",
      expires_at: new Date(Date.now() + 100000),
      created_at: new Date(),
      updated_at: new Date(),
      persona_name: "Tomori",
    };

    const deps: ModerationDataDependencies = {
      getState: async () => mockTomoriState(),
      getAllPersonas: async () => [mockTomoriState()],
      getLastDbError: () => null,
      getBlacklist: async () => ({ status: "fresh", memberIds: ["user-1", "user-2"] }),
      getPersonaBlocks: async () => ({ status: "fresh", blocks: [blockRow] }),
      getWhitelistChannels: async () => ({ status: "fresh", channels: [channelRow] }),
      getWhitelistPersonas: async () => ({ status: "fresh", personas: [personaChannelRow] }),
      getWhitelistRoles: async () => ({ status: "fresh", roles: [roleRow] }),
      getImageQuotaConfig: async () => ({
        status: "fresh",
        config: {
          server_id: 10,
          daily_user_quota: 5,
          serverwide_quota: 50,
          serverwide_quota_resets_in: 30,
          enabled: true,
          created_at: new Date(),
          updated_at: new Date(),
        },
      }),
      getTextQuotaConfig: async () => ({
        status: "fresh",
        config: null,
      }),
      getVideoQuotaConfig: async () => ({
        status: "fresh",
        config: {
          server_id: 10,
          daily_user_quota: 0,
          serverwide_quota: 0,
          serverwide_quota_resets_in: 365,
          enabled: false,
          created_at: new Date(),
          updated_at: new Date(),
        },
      }),
    };

    const data = await loadModerationScopeData("1001", false, deps);
    expect(data).not.toBeNull();
    if (!data) return;

    expect(data.readStatus).toBe("fresh");
    expect(data.guildId).toBe("1001");
    expect(data.serverId).toBe(10);

    expect(data.memberAccess.serverMemteachingEnabled).toBe(true);
    expect(data.memberAccess.attributeMemteachingEnabled).toBe(false);
    expect(data.memberAccess.sampledialogueMemteachingEnabled).toBe(true);
    expect(data.memberAccess.promptSnapshotEnabled).toBe(false);

    expect(data.userBlacklist.personalizationUserIds).toEqual(["user-1", "user-2"]);
    expect(data.userBlacklist.personaBlocks).toHaveLength(1);
    expect(data.userBlacklist.personaBlocks[0]?.user_disc_id).toBe("user-block-1");

    expect(data.whitelist.channels).toEqual([channelRow]);
    expect(data.whitelist.personaChannels).toEqual([personaChannelRow]);
    expect(data.whitelist.roles).toEqual([roleRow]);
    expect(data.whitelist.personaNames.get(1)).toBe("Tomori");

    expect(data.quotas.image).toEqual({ daily_user_quota: 5, serverwide_quota: 50, serverwide_quota_resets_in: 30 });
    expect(data.quotas.text).toEqual({ daily_user_quota: 0, serverwide_quota: 0, serverwide_quota_resets_in: 365 });
    expect(data.quotas.video).toEqual({ daily_user_quota: 0, serverwide_quota: 0, serverwide_quota_resets_in: 365 });
  });

  it("marks readStatus as unavailable when any quota repository read fails", async () => {
    const deps: ModerationDataDependencies = {
      getState: async () => mockTomoriState(),
      getAllPersonas: async () => [mockTomoriState()],
      getLastDbError: () => null,
      getBlacklist: async () => ({ status: "fresh", memberIds: [] }),
      getPersonaBlocks: async () => ({ status: "fresh", blocks: [] }),
      getWhitelistChannels: async () => ({ status: "fresh", channels: [] }),
      getWhitelistPersonas: async () => ({ status: "fresh", personas: [] }),
      getWhitelistRoles: async () => ({ status: "fresh", roles: [] }),
      getTextQuotaConfig: async () => ({ status: "fresh", config: null }),
      getImageQuotaConfig: async () => ({ status: "unavailable", config: null }),
      getVideoQuotaConfig: async () => ({ status: "fresh", config: null }),
    };

    const data = await loadModerationScopeData("1001", false, deps);
    expect(data).not.toBeNull();
    if (!data) return;

    expect(data.readStatus).toBe("unavailable");
  });

  it("marks readStatus as unavailable when any repository read fails", async () => {
    const deps: ModerationDataDependencies = {
      getState: async () => mockTomoriState(),
      getAllPersonas: async () => [mockTomoriState()],
      getLastDbError: () => null,
      getBlacklist: async () => ({ status: "unavailable", memberIds: [] }),
      getPersonaBlocks: async () => ({ status: "fresh", blocks: [] }),
      getWhitelistChannels: async () => ({ status: "fresh", channels: [] }),
      getWhitelistPersonas: async () => ({ status: "fresh", personas: [] }),
      getWhitelistRoles: async () => ({ status: "fresh", roles: [] }),
      getTextQuotaConfig: async () => ({ status: "fresh", config: null }),
      getImageQuotaConfig: async () => ({ status: "fresh", config: null }),
      getVideoQuotaConfig: async () => ({ status: "fresh", config: null }),
    };

    const data = await loadModerationScopeData("1001", false, deps);
    expect(data).not.toBeNull();
    if (!data) return;

    expect(data.readStatus).toBe("unavailable");
  });

  it("invokes refresh exactly once before reading state and personas when forceRefresh is true", async () => {
    const callOrder: string[] = [];

    const deps: ModerationDataDependencies = {
      refresh: async (guildId) => {
        callOrder.push(`refresh:${guildId}`);
      },
      getState: async (guildId) => {
        callOrder.push(`getState:${guildId}`);
        return mockTomoriState();
      },
      getAllPersonas: async (guildId) => {
        callOrder.push(`getAllPersonas:${guildId}`);
        return [mockTomoriState()];
      },
      getLastDbError: () => null,
      getBlacklist: async () => ({ status: "fresh", memberIds: [] }),
      getPersonaBlocks: async () => ({ status: "fresh", blocks: [] }),
      getWhitelistChannels: async () => ({ status: "fresh", channels: [] }),
      getWhitelistPersonas: async () => ({ status: "fresh", personas: [] }),
      getWhitelistRoles: async () => ({ status: "fresh", roles: [] }),
      getTextQuotaConfig: async () => ({ status: "fresh", config: null }),
      getImageQuotaConfig: async () => ({ status: "fresh", config: null }),
      getVideoQuotaConfig: async () => ({ status: "fresh", config: null }),
    };

    const result = await loadModerationScopeData("1001", true, deps);
    expect(result).not.toBeNull();
    expect(callOrder[0]).toBe("refresh:1001");
    expect(callOrder[1]).toBe("getState:1001");
    expect(callOrder).toContain("getAllPersonas:1001");
    expect(callOrder.filter((call) => call === "refresh:1001")).toHaveLength(1);
  });

  it("marks readStatus as stale when persona loader encounters an error recorded in getLastDbError", async () => {
    let recordedError: { message: string; timestamp: number } | null = null;

    const deps: ModerationDataDependencies = {
      getState: async () => mockTomoriState(),
      getAllPersonas: async () => {
        recordedError = { message: "Persona cache read failure", timestamp: Date.now() };
        return [mockTomoriState()];
      },
      getLastDbError: () => recordedError,
      getBlacklist: async () => ({ status: "fresh", memberIds: [] }),
      getPersonaBlocks: async () => ({ status: "fresh", blocks: [] }),
      getWhitelistChannels: async () => ({ status: "fresh", channels: [] }),
      getWhitelistPersonas: async () => ({ status: "fresh", personas: [] }),
      getWhitelistRoles: async () => ({ status: "fresh", roles: [] }),
      getTextQuotaConfig: async () => ({ status: "fresh", config: null }),
      getImageQuotaConfig: async () => ({ status: "fresh", config: null }),
      getVideoQuotaConfig: async () => ({ status: "fresh", config: null }),
    };

    const data = await loadModerationScopeData("1001", false, deps);
    expect(data).not.toBeNull();
    expect(data?.readStatus).toBe("stale");
    expect(data?.memberAccess.serverMemteachingEnabled).toBe(true);
  });
});

describe("loadModerationMemberAccessData lightweight resolver", () => {
  it("returns fresh member access data without repository fan-out", async () => {
    let getStateCalled = 0;
    let getLastDbErrorCalled = 0;

    const deps: ModerationMemberAccessDataDependencies = {
      getState: async (guildId) => {
        getStateCalled++;
        expect(guildId).toBe("1001");
        return mockTomoriState({
          server_memteaching_enabled: true,
          attribute_memteaching_enabled: false,
          sampledialogue_memteaching_enabled: true,
          prompt_snapshot_enabled: false,
        });
      },
      getLastDbError: () => {
        getLastDbErrorCalled++;
        return null;
      },
    };

    const result = await loadModerationMemberAccessData("1001", deps);
    expect(result).toEqual({
      guildId: "1001",
      serverId: 10,
      readStatus: "fresh",
      memberAccess: {
        serverMemteachingEnabled: true,
        attributeMemteachingEnabled: false,
        sampledialogueMemteachingEnabled: true,
        promptSnapshotEnabled: false,
      },
    });
    expect(getStateCalled).toBe(1);
    expect(getLastDbErrorCalled).toBe(1);
  });

  it("returns stale member access data when cached state exists alongside a DB error", async () => {
    const deps: ModerationMemberAccessDataDependencies = {
      getState: async () => mockTomoriState(),
      getLastDbError: () => ({ message: "Transient network issue", timestamp: Date.now() }),
    };

    const result = await loadModerationMemberAccessData("1001", deps);
    expect(result).not.toBeNull();
    expect(result?.readStatus).toBe("stale");
    expect(result?.serverId).toBe(10);
    expect(result?.guildId).toBe("1001");
    expect(result?.memberAccess.serverMemteachingEnabled).toBe(true);
  });

  it("keeps a healthy loaded state fresh during startup grace", async () => {
    const result = await loadModerationMemberAccessData("1001", {
      getState: async () => mockTomoriState(),
      getLastDbError: () => ({ message: "Bot is still starting up (startup grace period)", timestamp: Date.now() }),
      getRecordedDbError: () => null,
    });

    expect(result?.readStatus).toBe("fresh");
  });

  it("returns null when setup is authoritatively missing", async () => {
    const deps: ModerationMemberAccessDataDependencies = {
      getState: async () => null,
      getLastDbError: () => null,
    };

    const result = await loadModerationMemberAccessData("1001", deps);
    expect(result).toBeNull();
  });

  it("returns unavailable when state is null alongside a DB error", async () => {
    const deps: ModerationMemberAccessDataDependencies = {
      getState: async () => null,
      getLastDbError: () => ({ message: "DB outage", timestamp: Date.now() }),
    };

    const result = await loadModerationMemberAccessData("1001", deps);
    expect(result).not.toBeNull();
    expect(result?.readStatus).toBe("unavailable");
    expect(result?.guildId).toBe("1001");
    expect(result?.serverId).toBe(0);
  });
});

describe("updateMemberPermissions canonical operation", () => {
  it("returns unchanged status without writing to repository or invalidating cache when selection matches state", async () => {
    let updateCalled = 0;
    let invalidateCalled = 0;

    const result = await updateMemberPermissions(
      {
        guildId: "1001",
        serverId: 10,
        currentState: {
          server_memteaching_enabled: true,
          attribute_memteaching_enabled: false,
          sampledialogue_memteaching_enabled: true,
          prompt_snapshot_enabled: false,
        },
        selectedValues: ["servermemories", "sampledialogues"],
      },
      {
        updateConfig: async () => {
          updateCalled++;
          return true;
        },
        invalidateCache: () => {
          invalidateCalled++;
        },
      },
    );

    expect(result).toEqual({
      status: "unchanged",
      changes: [],
      patch: {},
    });
    expect(updateCalled).toBe(0);
    expect(invalidateCalled).toBe(0);
  });

  it("writes exact patch to repository and invalidates cache once on success with write-before-invalidation ordering", async () => {
    const callOrder: string[] = [];
    let receivedPatch: Record<string, unknown> | null = null;

    const result = await updateMemberPermissions(
      {
        guildId: "1001",
        serverId: 10,
        currentState: {
          serverMemteachingEnabled: true,
          attributeMemteachingEnabled: false,
          sampledialogueMemteachingEnabled: true,
          promptSnapshotEnabled: false,
        },
        selectedValues: ["attributelist", "sampledialogues", "promptsnapshot"],
      },
      {
        updateConfig: async (serverId, patch) => {
          callOrder.push(`update:${serverId}`);
          receivedPatch = patch;
          return true;
        },
        invalidateCache: (guildId) => {
          callOrder.push(`invalidate:${guildId}`);
        },
      },
    );

    expect(result.status).toBe("success");
    expect(receivedPatch).toEqual({
      server_memteaching_enabled: false,
      attribute_memteaching_enabled: true,
      prompt_snapshot_enabled: true,
    });
    expect(result.changes).toHaveLength(3);
    expect(callOrder).toEqual(["update:10", "invalidate:1001"]);
  });

  it("returns failure without invalidating cache when repository update fails", async () => {
    let updateCalled = 0;
    let invalidateCalled = 0;

    const result = await updateMemberPermissions(
      {
        guildId: "1001",
        serverId: 10,
        currentState: {
          server_memteaching_enabled: true,
          attribute_memteaching_enabled: false,
          sampledialogue_memteaching_enabled: true,
          prompt_snapshot_enabled: false,
        },
        selectedValues: [],
      },
      {
        updateConfig: async () => {
          updateCalled++;
          return false;
        },
        invalidateCache: () => {
          invalidateCalled++;
        },
      },
    );

    expect(result.status).toBe("failure");
    expect(result.changes).toHaveLength(2);
    expect(updateCalled).toBe(1);
    expect(invalidateCalled).toBe(0);
  });
});

describe("loadModerationUserBlacklistAddData lightweight resolver", () => {
  it("returns fresh user blacklist add scope data without repository fan-out", async () => {
    let getStateCalled = 0;
    let getLastDbErrorCalled = 0;

    const deps: ModerationUserBlacklistAddDataDependencies = {
      getState: async (guildId) => {
        getStateCalled++;
        expect(guildId).toBe("1001");
        return mockTomoriState({ personal_memories_enabled: true });
      },
      getLastDbError: () => {
        getLastDbErrorCalled++;
        return null;
      },
    };

    const result = await loadModerationUserBlacklistAddData("1001", deps);
    expect(result).toEqual({
      guildId: "1001",
      serverId: 10,
      readStatus: "fresh",
      personalMemoriesEnabled: true,
    });
    expect(getStateCalled).toBe(1);
    expect(getLastDbErrorCalled).toBe(1);
  });

  it("returns stale user blacklist add data when cached state exists alongside a DB error", async () => {
    const deps: ModerationUserBlacklistAddDataDependencies = {
      getState: async () => mockTomoriState({ personal_memories_enabled: false }),
      getLastDbError: () => ({ message: "Transient timeout", timestamp: Date.now() }),
    };

    const result = await loadModerationUserBlacklistAddData("1001", deps);
    expect(result).toEqual({
      guildId: "1001",
      serverId: 10,
      readStatus: "stale",
      personalMemoriesEnabled: false,
    });
  });

  it("returns null when setup is authoritatively missing", async () => {
    const deps: ModerationUserBlacklistAddDataDependencies = {
      getState: async () => null,
      getLastDbError: () => null,
    };

    const result = await loadModerationUserBlacklistAddData("1001", deps);
    expect(result).toBeNull();
  });

  it("returns unavailable when state is null alongside a DB error", async () => {
    const deps: ModerationUserBlacklistAddDataDependencies = {
      getState: async () => null,
      getLastDbError: () => ({ message: "DB failure", timestamp: Date.now() }),
    };

    const result = await loadModerationUserBlacklistAddData("1001", deps);
    expect(result).toEqual({
      guildId: "1001",
      serverId: 0,
      readStatus: "unavailable",
      personalMemoriesEnabled: false,
    });
  });
});

describe("addUserToBlacklist canonical operation", () => {
  it("returns bot status without querying repository or invalidating cache when target is a bot", async () => {
    let isBlacklistedCalled = 0;
    let addBlacklistCalled = 0;
    let invalidateCalled = 0;

    const result = await addUserToBlacklist(
      {
        guildId: "1001",
        serverId: 10,
        targetUserId: "bot-user-1",
        isBot: true,
        personalMemoriesEnabled: true,
      },
      {
        isUserBlacklisted: async () => {
          isBlacklistedCalled++;
          return false;
        },
        addUserBlacklist: async () => {
          addBlacklistCalled++;
          return true;
        },
        invalidateCache: () => {
          invalidateCalled++;
        },
      },
    );

    expect(result).toEqual({
      status: "bot",
      targetUserId: "bot-user-1",
    });
    expect(isBlacklistedCalled).toBe(0);
    expect(addBlacklistCalled).toBe(0);
    expect(invalidateCalled).toBe(0);
  });

  it("returns personalization_disabled status without querying repository when personalization is disabled", async () => {
    let isBlacklistedCalled = 0;
    let addBlacklistCalled = 0;
    let invalidateCalled = 0;

    const result = await addUserToBlacklist(
      {
        guildId: "1001",
        serverId: 10,
        targetUserId: "user-1",
        isBot: false,
        personalMemoriesEnabled: false,
      },
      {
        isUserBlacklisted: async () => {
          isBlacklistedCalled++;
          return false;
        },
        addUserBlacklist: async () => {
          addBlacklistCalled++;
          return true;
        },
        invalidateCache: () => {
          invalidateCalled++;
        },
      },
    );

    expect(result).toEqual({
      status: "personalization_disabled",
      targetUserId: "user-1",
    });
    expect(isBlacklistedCalled).toBe(0);
    expect(addBlacklistCalled).toBe(0);
    expect(invalidateCalled).toBe(0);
  });

  it("returns already_blacklisted status without writing or invalidating cache when member is already blacklisted", async () => {
    let addBlacklistCalled = 0;
    let invalidateCalled = 0;

    const result = await addUserToBlacklist(
      {
        guildId: "1001",
        serverId: 10,
        targetUserId: "user-dup",
        isBot: false,
        personalMemoriesEnabled: true,
      },
      {
        isUserBlacklisted: async (serverId, targetUserId) => {
          expect(serverId).toBe(10);
          expect(targetUserId).toBe("user-dup");
          return true;
        },
        addUserBlacklist: async () => {
          addBlacklistCalled++;
          return true;
        },
        invalidateCache: () => {
          invalidateCalled++;
        },
      },
    );

    expect(result).toEqual({
      status: "already_blacklisted",
      targetUserId: "user-dup",
    });
    expect(addBlacklistCalled).toBe(0);
    expect(invalidateCalled).toBe(0);
  });

  it("writes to repository and invalidates cache once on success with write-before-invalidation ordering", async () => {
    const callOrder: string[] = [];

    const result = await addUserToBlacklist(
      {
        guildId: "1001",
        serverId: 10,
        targetUserId: "user-new",
        isBot: false,
        personalMemoriesEnabled: true,
      },
      {
        isUserBlacklisted: async (serverId, targetUserId) => {
          callOrder.push(`check:${serverId}:${targetUserId}`);
          return false;
        },
        addUserBlacklist: async (serverId, targetUserId) => {
          callOrder.push(`add:${serverId}:${targetUserId}`);
          return true;
        },
        invalidateCache: (guildId, targetUserId) => {
          callOrder.push(`invalidate:${guildId}:${targetUserId}`);
        },
      },
    );

    expect(result).toEqual({
      status: "success",
      targetUserId: "user-new",
    });
    expect(callOrder).toEqual(["check:10:user-new", "add:10:user-new", "invalidate:1001:user-new"]);
  });

  it("returns failure without invalidating cache when repository write fails", async () => {
    const callOrder: string[] = [];

    const result = await addUserToBlacklist(
      {
        guildId: "1001",
        serverId: 10,
        targetUserId: "user-fail",
        isBot: false,
        personalMemoriesEnabled: true,
      },
      {
        isUserBlacklisted: async (serverId, targetUserId) => {
          callOrder.push(`check:${serverId}:${targetUserId}`);
          return false;
        },
        addUserBlacklist: async (serverId, targetUserId) => {
          callOrder.push(`add:${serverId}:${targetUserId}`);
          return false;
        },
        invalidateCache: (guildId, targetUserId) => {
          callOrder.push(`invalidate:${guildId}:${targetUserId}`);
        },
      },
    );

    expect(result).toEqual({
      status: "failure",
      targetUserId: "user-fail",
    });
    expect(callOrder).toEqual(["check:10:user-fail", "add:10:user-fail"]);
  });
});

describe("removeUserFromBlacklist canonical operation", () => {
  it("removes user from personalization blacklist and invalidates cache once on success with write-before-invalidation ordering", async () => {
    const callOrder: string[] = [];

    const result = await removeUserFromBlacklist(
      {
        guildId: "1001",
        serverId: 10,
        targetUserId: "user-rem-1",
      },
      {
        removePersonalizationMany: async (serverId, userIds) => {
          callOrder.push(`remove:${serverId}:${userIds.join(",")}`);
          return 1;
        },
        invalidateCache: (guildId, targetUserId) => {
          callOrder.push(`invalidate:${guildId}:${targetUserId}`);
        },
      },
    );

    expect(result).toEqual({
      status: "success",
      targetUserId: "user-rem-1",
    });
    expect(callOrder).toEqual(["remove:10:user-rem-1", "invalidate:1001:user-rem-1"]);
  });

  it("returns not_found without invalidating cache when entry does not exist", async () => {
    let invalidateCalled = 0;

    const result = await removeUserFromBlacklist(
      {
        guildId: "1001",
        serverId: 10,
        targetUserId: "user-missing",
      },
      {
        removePersonalizationMany: async () => 0,
        invalidateCache: () => {
          invalidateCalled++;
        },
      },
    );

    expect(result).toEqual({
      status: "not_found",
      targetUserId: "user-missing",
    });
    expect(invalidateCalled).toBe(0);
  });

  it("returns failure without invalidating cache when repository throws", async () => {
    let invalidateCalled = 0;

    const result = await removeUserFromBlacklist(
      {
        guildId: "1001",
        serverId: 10,
        targetUserId: "user-err",
      },
      {
        removePersonalizationMany: async () => {
          throw new Error("DB failure");
        },
        invalidateCache: () => {
          invalidateCalled++;
        },
      },
    );

    expect(result).toEqual({
      status: "failure",
      targetUserId: "user-err",
    });
    expect(invalidateCalled).toBe(0);
  });
});

describe("removePersonaUserBlock canonical operation", () => {
  it("removes active persona block and invalidates cache once on success with write-before-invalidation ordering", async () => {
    const callOrder: string[] = [];
    const mockRow = {
      server_id: 10,
      persona_id: 2,
      user_disc_id: "user-block-1",
      block_type: "mute" as const,
      reason: "test",
      expires_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    };

    const result = await removePersonaUserBlock(
      {
        guildId: "1001",
        serverId: 10,
        personaId: 2,
        targetUserId: "user-block-1",
      },
      {
        removeBlocksByKeys: async (serverId, keys) => {
          callOrder.push(`remove:${serverId}:${keys.map((k) => `${k.personaId}-${k.userDiscId}`).join(",")}`);
          return [mockRow];
        },
        invalidateCache: (serverId, personaId, targetUserId) => {
          callOrder.push(`invalidate:${serverId}:${personaId}:${targetUserId}`);
        },
      },
    );

    expect(result).toEqual({
      status: "success",
      personaId: 2,
      targetUserId: "user-block-1",
      block: mockRow,
    });
    expect(callOrder).toEqual(["remove:10:2-user-block-1", "invalidate:10:2:user-block-1"]);
  });

  it("returns not_found without invalidating cache when block does not exist", async () => {
    let invalidateCalled = 0;

    const result = await removePersonaUserBlock(
      {
        guildId: "1001",
        serverId: 10,
        personaId: 2,
        targetUserId: "user-block-missing",
      },
      {
        removeBlocksByKeys: async () => [],
        invalidateCache: () => {
          invalidateCalled++;
        },
      },
    );

    expect(result).toEqual({
      status: "not_found",
      personaId: 2,
      targetUserId: "user-block-missing",
    });
    expect(invalidateCalled).toBe(0);
  });

  it("returns failure without invalidating cache when repository throws", async () => {
    let invalidateCalled = 0;

    const result = await removePersonaUserBlock(
      {
        guildId: "1001",
        serverId: 10,
        personaId: 2,
        targetUserId: "user-block-err",
      },
      {
        removeBlocksByKeys: async () => {
          throw new Error("DB error");
        },
        invalidateCache: () => {
          invalidateCalled++;
        },
      },
    );

    expect(result).toEqual({
      status: "failure",
      personaId: 2,
      targetUserId: "user-block-err",
    });
    expect(invalidateCalled).toBe(0);
  });
});

describe("removeUserBlacklistBatch legacy operation", () => {
  it("removes both personalization and persona blocks, invalidating only affected caches", async () => {
    const callOrder: string[] = [];
    const mockRow = {
      server_id: 10,
      persona_id: 3,
      user_disc_id: "u-block",
      block_type: "temporary" as const,
      reason: "test",
      expires_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    };

    const result = await removeUserBlacklistBatch(
      {
        guildId: "1001",
        serverId: 10,
        personalizationUserIds: ["u-pers-1", "u-pers-2"],
        personaBlockKeys: [{ personaId: 3, userDiscId: "u-block" }],
      },
      {
        removePersonalizationMany: async (serverId, userIds) => {
          callOrder.push(`removePers:${serverId}:${userIds.join(",")}`);
          return 2;
        },
        removeBlocksByKeys: async (serverId, keys) => {
          callOrder.push(`removeBlocks:${serverId}:${keys.map((k) => `${k.personaId}-${k.userDiscId}`).join(",")}`);
          return [mockRow];
        },
        invalidatePersonalizationCache: (guildId, userId) => {
          callOrder.push(`invalidatePers:${guildId}:${userId}`);
        },
        invalidatePersonaBlockCache: (serverId, personaId, userId) => {
          callOrder.push(`invalidateBlock:${serverId}:${personaId}:${userId}`);
        },
      },
    );

    expect(result).toEqual({
      status: "success",
      removedPersonalizationCount: 2,
      removedPersonaBlocks: [mockRow],
    });
    expect(callOrder).toEqual([
      "removePers:10:u-pers-1,u-pers-2",
      "invalidatePers:1001:u-pers-1",
      "invalidatePers:1001:u-pers-2",
      "removeBlocks:10:3-u-block",
      "invalidateBlock:10:3:u-block",
    ]);
  });

  it("does not invalidate personalization cache when removed count is 0, and does not invalidate block cache when 0 rows returned", async () => {
    const callOrder: string[] = [];

    const result = await removeUserBlacklistBatch(
      {
        guildId: "1001",
        serverId: 10,
        personalizationUserIds: ["u-pers-none"],
        personaBlockKeys: [{ personaId: 3, userDiscId: "u-block-none" }],
      },
      {
        removePersonalizationMany: async (serverId, userIds) => {
          callOrder.push(`removePers:${serverId}:${userIds.join(",")}`);
          return 0;
        },
        removeBlocksByKeys: async (serverId, keys) => {
          callOrder.push(`removeBlocks:${serverId}:${keys.map((k) => `${k.personaId}-${k.userDiscId}`).join(",")}`);
          return [];
        },
        invalidatePersonalizationCache: (guildId, userId) => {
          callOrder.push(`invalidatePers:${guildId}:${userId}`);
        },
        invalidatePersonaBlockCache: (serverId, personaId, userId) => {
          callOrder.push(`invalidateBlock:${serverId}:${personaId}:${userId}`);
        },
      },
    );

    expect(result).toEqual({
      status: "success",
      removedPersonalizationCount: 0,
      removedPersonaBlocks: [],
    });
    expect(callOrder).toEqual(["removePers:10:u-pers-none", "removeBlocks:10:3-u-block-none"]);
  });

  it("returns failure when repository throws", async () => {
    const result = await removeUserBlacklistBatch(
      {
        guildId: "1001",
        serverId: 10,
        personalizationUserIds: ["u1"],
        personaBlockKeys: [],
      },
      {
        removePersonalizationMany: async () => {
          throw new Error("DB batch error");
        },
        removeBlocksByKeys: async () => [],
        invalidatePersonalizationCache: () => {},
        invalidatePersonaBlockCache: () => {},
      },
    );

    expect(result).toEqual({
      status: "failure",
      removedPersonalizationCount: 0,
      removedPersonaBlocks: [],
    });
  });
});

describe("loadModerationWhitelistChannelAddData", () => {
  it("returns null when TomoriState is null and no db error exists", async () => {
    const data = await loadModerationWhitelistChannelAddData("1001", {
      getState: async () => null,
      getLastDbError: () => null,
    });
    expect(data).toBeNull();
  });

  it("returns unavailable when TomoriState is null but recent db error exists", async () => {
    const data = await loadModerationWhitelistChannelAddData("1001", {
      getState: async () => null,
      getLastDbError: () => ({ message: "DB timeout", timestamp: Date.now() }),
    });
    expect(data).toEqual({
      guildId: "1001",
      serverId: 0,
      readStatus: "unavailable",
      config: {
        cooldown_type: null,
        cooldown_length: null,
      },
    });
  });

  it("returns fresh config data when TomoriState is available and no db error", async () => {
    const data = await loadModerationWhitelistChannelAddData("1001", {
      getState: async () => mockTomoriState({ cooldown_type: CooldownType.PER_CHANNEL, cooldown_length: 15 }),
      getLastDbError: () => null,
    });
    expect(data).toEqual({
      guildId: "1001",
      serverId: 10,
      readStatus: "fresh",
      config: {
        cooldown_type: CooldownType.PER_CHANNEL,
        cooldown_length: 15,
      },
    });
  });
});

describe("upsertWhitelistChannel", () => {
  it("stores null/null (inherited) when both cooldown fields are omitted", async () => {
    const log: string[] = [];
    const result = await upsertWhitelistChannel(
      {
        guildId: "1001",
        serverId: 10,
        channelId: "987654321",
        requestedCooldownType: null,
        requestedCooldownLength: null,
      },
      {
        getChannelWhitelist: async () => null,
        upsertChannelWhitelist: async (serverId, channelId, type, length) => {
          log.push(`upsert:${serverId}:${channelId}:${type}:${length}`);
          return {
            server_id: serverId,
            channel_disc_id: channelId,
            cooldown_type: type,
            cooldown_length: length,
          } as ChannelWhitelistRow;
        },
        invalidateCache: (guildId) => {
          log.push(`invalidate:${guildId}`);
        },
      },
    );

    expect(result).toEqual({
      status: "success",
      channelId: "987654321",
      cooldownType: null,
      cooldownLength: null,
      isUpdate: false,
    });
    expect(log).toEqual(["upsert:10:987654321:null:null", "invalidate:1001"]);
  });

  it("resolves fallback chain when only cooldown length is provided", async () => {
    const log: string[] = [];
    const result = await upsertWhitelistChannel(
      {
        guildId: "1001",
        serverId: 10,
        channelId: "987654321",
        requestedCooldownLength: 20,
        serverConfig: {
          cooldown_type: CooldownType.SERVER_WIDE,
          cooldown_length: 10,
        },
      },
      {
        getChannelWhitelist: async () => null,
        upsertChannelWhitelist: async (serverId, channelId, type, length) => {
          log.push(`upsert:${serverId}:${channelId}:${type}:${length}`);
          return {
            server_id: serverId,
            channel_disc_id: channelId,
            cooldown_type: type,
            cooldown_length: length,
          } as ChannelWhitelistRow;
        },
        invalidateCache: (guildId) => {
          log.push(`invalidate:${guildId}`);
        },
      },
    );

    expect(result).toEqual({
      status: "success",
      channelId: "987654321",
      cooldownType: CooldownType.SERVER_WIDE,
      cooldownLength: 20,
      isUpdate: false,
    });
    expect(log).toEqual(["upsert:10:987654321:3:20", "invalidate:1001"]);
  });

  it("uses existing channel override as fallback before server config", async () => {
    const log: string[] = [];
    const existing: ChannelWhitelistRow = {
      server_id: 10,
      channel_disc_id: "987654321",
      cooldown_type: CooldownType.PER_USER,
      cooldown_length: 30,
    } as ChannelWhitelistRow;

    const result = await upsertWhitelistChannel(
      {
        guildId: "1001",
        serverId: 10,
        channelId: "987654321",
        requestedCooldownLength: 45,
        serverConfig: {
          cooldown_type: CooldownType.SERVER_WIDE,
          cooldown_length: 10,
        },
      },
      {
        getChannelWhitelist: async () => existing,
        upsertChannelWhitelist: async (serverId, channelId, type, length) => {
          log.push(`upsert:${serverId}:${channelId}:${type}:${length}`);
          return {
            server_id: serverId,
            channel_disc_id: channelId,
            cooldown_type: type,
            cooldown_length: length,
          } as ChannelWhitelistRow;
        },
        invalidateCache: (guildId) => {
          log.push(`invalidate:${guildId}`);
        },
      },
    );

    expect(result).toEqual({
      status: "success",
      channelId: "987654321",
      cooldownType: CooldownType.PER_USER,
      cooldownLength: 45,
      isUpdate: true,
    });
    expect(log).toEqual(["upsert:10:987654321:1:45", "invalidate:1001"]);
  });

  it("returns unchanged without writing to DB or invalidating cache when entry matches exactly", async () => {
    const log: string[] = [];
    const existing: ChannelWhitelistRow = {
      server_id: 10,
      channel_disc_id: "987654321",
      cooldown_type: CooldownType.PER_CHANNEL,
      cooldown_length: 15,
    } as ChannelWhitelistRow;

    const result = await upsertWhitelistChannel(
      {
        guildId: "1001",
        serverId: 10,
        channelId: "987654321",
        requestedCooldownType: CooldownType.PER_CHANNEL,
        requestedCooldownLength: 15,
      },
      {
        getChannelWhitelist: async () => existing,
        upsertChannelWhitelist: async () => {
          log.push("upsert");
          return existing;
        },
        invalidateCache: () => {
          log.push("invalidate");
        },
      },
    );

    expect(result).toEqual({
      status: "unchanged",
      channelId: "987654321",
      cooldownType: CooldownType.PER_CHANNEL,
      cooldownLength: 15,
    });
    expect(log).toEqual([]);
  });

  it("returns failure when repository throws", async () => {
    const log: string[] = [];
    const result = await upsertWhitelistChannel(
      {
        guildId: "1001",
        serverId: 10,
        channelId: "987654321",
        requestedCooldownType: CooldownType.OFF,
        requestedCooldownLength: 0,
      },
      {
        getChannelWhitelist: async () => null,
        upsertChannelWhitelist: async () => {
          throw new Error("DB write error");
        },
        invalidateCache: () => {
          log.push("invalidate");
        },
      },
    );

    expect(result).toEqual({
      status: "failure",
      channelId: "987654321",
    });
    expect(log).toEqual([]);
  });
});

describe("removeWhitelistChannel", () => {
  it("removes channel and invalidates cache when row was deleted", async () => {
    const log: string[] = [];
    const result = await removeWhitelistChannel(
      {
        guildId: "1001",
        serverId: 10,
        channelId: "987654321",
      },
      {
        removeChannelWhitelist: async (serverId, channelId) => {
          log.push(`remove:${serverId}:${channelId}`);
          return true;
        },
        invalidateCache: (guildId) => {
          log.push(`invalidate:${guildId}`);
        },
      },
    );

    expect(result).toEqual({
      status: "success",
      channelId: "987654321",
    });
    expect(log).toEqual(["remove:10:987654321", "invalidate:1001"]);
  });

  it("returns not_found without cache invalidation when channel was not present", async () => {
    const log: string[] = [];
    const result = await removeWhitelistChannel(
      {
        guildId: "1001",
        serverId: 10,
        channelId: "987654321",
      },
      {
        removeChannelWhitelist: async (serverId, channelId) => {
          log.push(`remove:${serverId}:${channelId}`);
          return false;
        },
        invalidateCache: () => {
          log.push("invalidate");
        },
      },
    );

    expect(result).toEqual({
      status: "not_found",
      channelId: "987654321",
    });
    expect(log).toEqual(["remove:10:987654321"]);
  });

  it("returns failure without cache invalidation on throw", async () => {
    const log: string[] = [];
    const result = await removeWhitelistChannel(
      {
        guildId: "1001",
        serverId: 10,
        channelId: "987654321",
      },
      {
        removeChannelWhitelist: async () => {
          throw new Error("DB error");
        },
        invalidateCache: () => {
          log.push("invalidate");
        },
      },
    );

    expect(result).toEqual({
      status: "failure",
      channelId: "987654321",
    });
    expect(log).toEqual([]);
  });
});

describe("whitelist role operations", () => {
  it("does not write or invalidate when the role is already whitelisted", async () => {
    const events: string[] = [];
    const result = await addWhitelistRole(
      { guildId: "guild-1", serverId: 10, roleId: "role-1" },
      {
        isRoleWhitelisted: async () => true,
        upsertRoleWhitelist: async () => {
          events.push("write");
          return {} as RoleWhitelistRow;
        },
        invalidateCache: () => events.push("invalidate"),
      },
    );

    expect(result.status).toBe("unchanged");
    expect(events).toEqual([]);
  });

  it("adds and removes roles with write-before-invalidation ordering", async () => {
    const addEvents: string[] = [];
    const addResult = await addWhitelistRole(
      { guildId: "guild-1", serverId: 10, roleId: "role-1" },
      {
        isRoleWhitelisted: async () => false,
        upsertRoleWhitelist: async () => {
          addEvents.push("write");
          return { server_id: 10, role_disc_id: "role-1" } as RoleWhitelistRow;
        },
        invalidateCache: () => addEvents.push("invalidate"),
      },
    );
    expect(addResult.status).toBe("success");
    expect(addEvents).toEqual(["write", "invalidate"]);

    const removeEvents: string[] = [];
    const removeResult = await removeWhitelistRole(
      { guildId: "guild-1", serverId: 10, roleId: "role-1" },
      {
        removeRoleWhitelist: async () => {
          removeEvents.push("write");
          return true;
        },
        invalidateCache: () => removeEvents.push("invalidate"),
      },
    );
    expect(removeResult.status).toBe("success");
    expect(removeEvents).toEqual(["write", "invalidate"]);
  });

  it("does not invalidate failed or missing role removals", async () => {
    const events: string[] = [];
    const missing = await removeWhitelistRole(
      { guildId: "guild-1", serverId: 10, roleId: "role-1" },
      {
        removeRoleWhitelist: async () => false,
        invalidateCache: () => events.push("invalidate"),
      },
    );
    expect(missing.status).toBe("not_found");
    expect(events).toEqual([]);
  });
});

describe("persona channel whitelist operations", () => {
  it("does not write or invalidate when the normalized channel set is unchanged", async () => {
    const events: string[] = [];
    const result = await replacePersonaChannelWhitelist(
      {
        guildId: "guild-1",
        serverId: 10,
        personaId: 4,
        selectedChannelIds: new Set(["channel-2", "missing", "channel-1"]),
        availableChannelIds: ["channel-1", "channel-2", "channel-2"],
      },
      {
        getPersonaWhitelistChannels: async () =>
          ["channel-1", "channel-2"].map((channel_disc_id) => ({ channel_disc_id }) as ChannelPersonaWhitelistRow),
        replacePersonaWhitelistChannels: async () => events.push("write"),
        invalidateCache: () => events.push("invalidate"),
      },
    );

    expect(result).toEqual({ status: "unchanged", channelIds: ["channel-1", "channel-2"] });
    expect(events).toEqual([]);
  });

  it("writes the complete normalized set before invalidating, including an empty clear", async () => {
    const events: string[] = [];
    const result = await replacePersonaChannelWhitelist(
      {
        guildId: "guild-1",
        serverId: 10,
        personaId: 4,
        selectedChannelIds: new Set<string>(),
        availableChannelIds: ["channel-1"],
      },
      {
        getPersonaWhitelistChannels: async () => [{ channel_disc_id: "channel-1" } as ChannelPersonaWhitelistRow],
        replacePersonaWhitelistChannels: async (serverId, personaId, channelIds) => {
          events.push(`write:${serverId}:${personaId}:${channelIds.join(",")}`);
        },
        invalidateCache: (guildId) => events.push(`invalidate:${guildId}`),
      },
    );

    expect(result).toEqual({ status: "success", channelIds: [] });
    expect(events).toEqual(["write:10:4:", "invalidate:guild-1"]);
  });

  it("returns failure without invalidating when a read or write fails", async () => {
    const events: string[] = [];
    const result = await replacePersonaChannelWhitelist(
      {
        guildId: "guild-1",
        serverId: 10,
        personaId: 4,
        selectedChannelIds: new Set(["channel-1"]),
        availableChannelIds: ["channel-1"],
      },
      {
        getPersonaWhitelistChannels: async () => [],
        replacePersonaWhitelistChannels: async () => {
          events.push("write");
          throw new Error("DB error");
        },
        invalidateCache: () => events.push("invalidate"),
      },
    );

    expect(result).toEqual({ status: "failure" });
    expect(events).toEqual(["write"]);
  });
});

describe("quota operations (updateQuotaSettings)", () => {
  it("executes image quota writes in exact per-field order and re-reads config before step 2 and step 3", async () => {
    const callLog: string[] = [];
    let readCount = 0;

    const deps: QuotaOperationsDependencies = {
      getImageConfig: async (serverId) => {
        readCount++;
        callLog.push(`read:image:${serverId}:${readCount}`);
        return {
          server_id: serverId,
          daily_user_quota: 5,
          serverwide_quota: readCount >= 3 ? 500 : 0,
          serverwide_quota_resets_in: 30,
          enabled: true,
          created_at: new Date(),
          updated_at: new Date(),
        };
      },
      updateImageDailyUserQuota: async (serverId, limit) => {
        callLog.push(`write:daily:${serverId}:${limit}`);
      },
      updateImageServerwideQuota: async (serverId, limit, currentResetDays, previousLimit) => {
        callLog.push(`write:serverwide:${serverId}:${limit}:${currentResetDays}:${previousLimit}`);
      },
      updateImageServerwideResetDays: async (serverId, days, serverwideActive) => {
        callLog.push(`write:resets:${serverId}:${days}:${serverwideActive}`);
      },
      getTextConfig: async () => {
        throw new Error("unexpected text read");
      },
      updateTextDailyUserQuota: async () => {},
      updateTextServerwideQuota: async () => {},
      updateTextServerwideResetDays: async () => {},
      getVideoConfig: async () => {
        throw new Error("unexpected video read");
      },
      updateVideoDailyUserQuota: async () => {},
      updateVideoServerwideQuota: async () => {},
      updateVideoServerwideResetDays: async () => {},
    };

    const result = await updateQuotaSettings(
      {
        serverId: 42,
        quotaType: "image",
        dailyUserQuota: 10,
        serverwideQuota: 500,
        serverwideQuotaResetsIn: 14,
      },
      deps,
    );

    expect(result).toEqual({
      status: "success",
      quotaType: "image",
      appliedFields: ["daily_user_quota", "serverwide_quota", "serverwide_quota_resets_in"],
    });

    expect(callLog).toEqual([
      "read:image:42:1",
      "write:daily:42:10",
      "read:image:42:2",
      "write:serverwide:42:500:30:0",
      "read:image:42:3",
      "write:resets:42:14:true",
    ]);
  });

  it("executes text and video quota writes with their respective repository methods", async () => {
    const textLog: string[] = [];
    const textDeps: QuotaOperationsDependencies = {
      getImageConfig: async () => {
        throw new Error("unexpected");
      },
      updateImageDailyUserQuota: async () => {},
      updateImageServerwideQuota: async () => {},
      updateImageServerwideResetDays: async () => {},
      getTextConfig: async (serverId) => {
        textLog.push(`read:text:${serverId}`);
        return {
          server_id: serverId,
          daily_user_quota: 0,
          serverwide_quota: 0,
          serverwide_quota_resets_in: 365,
          enabled: false,
          created_at: new Date(),
          updated_at: new Date(),
        };
      },
      updateTextDailyUserQuota: async (serverId, limit) => {
        textLog.push(`write:daily:${serverId}:${limit}`);
      },
      updateTextServerwideQuota: async (serverId, limit) => {
        textLog.push(`write:serverwide:${serverId}:${limit}`);
      },
      updateTextServerwideResetDays: async (serverId, days) => {
        textLog.push(`write:resets:${serverId}:${days}`);
      },
      getVideoConfig: async () => {
        throw new Error("unexpected");
      },
      updateVideoDailyUserQuota: async () => {},
      updateVideoServerwideQuota: async () => {},
      updateVideoServerwideResetDays: async () => {},
    };

    const textResult = await updateQuotaSettings(
      {
        serverId: 10,
        quotaType: "text",
        dailyUserQuota: 20,
        serverwideQuota: null,
        serverwideQuotaResetsIn: null,
      },
      textDeps,
    );

    expect(textResult).toEqual({
      status: "success",
      quotaType: "text",
      appliedFields: ["daily_user_quota"],
    });
    expect(textLog).toEqual(["read:text:10", "write:daily:10:20"]);

    const videoLog: string[] = [];
    const videoDeps: QuotaOperationsDependencies = {
      ...textDeps,
      getVideoConfig: async (serverId) => {
        videoLog.push(`read:video:${serverId}`);
        return {
          server_id: serverId,
          daily_user_quota: 0,
          serverwide_quota: 100,
          serverwide_quota_resets_in: 30,
          enabled: true,
          created_at: new Date(),
          updated_at: new Date(),
        };
      },
      updateVideoDailyUserQuota: async (serverId, limit) => {
        videoLog.push(`write:video:daily:${serverId}:${limit}`);
      },
      updateVideoServerwideQuota: async (serverId, limit) => {
        videoLog.push(`write:video:serverwide:${serverId}:${limit}`);
      },
      updateVideoServerwideResetDays: async (serverId, days) => {
        videoLog.push(`write:video:resets:${serverId}:${days}`);
      },
    };

    const videoResult = await updateQuotaSettings(
      {
        serverId: 10,
        quotaType: "video",
        dailyUserQuota: 5,
        serverwideQuota: 200,
        serverwideQuotaResetsIn: 15,
      },
      videoDeps,
    );

    expect(videoResult.status).toBe("success");
    expect(videoLog).toHaveLength(6);
  });

  it("validates bounds and refuses to write on out-of-range or non-integer values", async () => {
    let writes = 0;
    const deps: QuotaOperationsDependencies = {
      getImageConfig: async () => {
        throw new Error("should not be called");
      },
      updateImageDailyUserQuota: async () => {
        writes++;
      },
      updateImageServerwideQuota: async () => {
        writes++;
      },
      updateImageServerwideResetDays: async () => {
        writes++;
      },
      getTextConfig: async () => {
        throw new Error("should not be called");
      },
      updateTextDailyUserQuota: async () => {
        writes++;
      },
      updateTextServerwideQuota: async () => {
        writes++;
      },
      updateTextServerwideResetDays: async () => {
        writes++;
      },
      getVideoConfig: async () => {
        throw new Error("should not be called");
      },
      updateVideoDailyUserQuota: async () => {
        writes++;
      },
      updateVideoServerwideQuota: async () => {
        writes++;
      },
      updateVideoServerwideResetDays: async () => {
        writes++;
      },
    };

    const invalidInputs = [
      { dailyUserQuota: -1 },
      { dailyUserQuota: 101 },
      { dailyUserQuota: 5.5 },
      { dailyUserQuota: Number.NaN },
      { serverwideQuota: -1 },
      { serverwideQuota: 100000 },
      { serverwideQuota: 10.2 },
      { serverwideQuotaResetsIn: 0 },
      { serverwideQuotaResetsIn: 366 },
      { serverwideQuotaResetsIn: 30.5 },
    ];

    for (const invalid of invalidInputs) {
      const result = await updateQuotaSettings(
        {
          serverId: 1,
          quotaType: "image",
          ...invalid,
        },
        deps,
      );

      expect(result.status).toBe("invalid");
      expect(writes).toBe(0);
    }
  });

  it("propagates failure when a repository write throws and reports failed status", async () => {
    const deps: QuotaOperationsDependencies = {
      getImageConfig: async (serverId) => ({
        server_id: serverId,
        daily_user_quota: 0,
        serverwide_quota: 0,
        serverwide_quota_resets_in: 30,
        enabled: true,
        created_at: new Date(),
        updated_at: new Date(),
      }),
      updateImageDailyUserQuota: async () => {
        throw new Error("DB write error on daily quota");
      },
      updateImageServerwideQuota: async () => {},
      updateImageServerwideResetDays: async () => {},
      getTextConfig: async () => {
        throw new Error("unexpected");
      },
      updateTextDailyUserQuota: async () => {},
      updateTextServerwideQuota: async () => {},
      updateTextServerwideResetDays: async () => {},
      getVideoConfig: async () => {
        throw new Error("unexpected");
      },
      updateVideoDailyUserQuota: async () => {},
      updateVideoServerwideQuota: async () => {},
      updateVideoServerwideResetDays: async () => {},
    };

    const result = await updateQuotaSettings(
      {
        serverId: 1,
        quotaType: "image",
        dailyUserQuota: 10,
      },
      deps,
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect((result.error as Error).message).toBe("DB write error on daily quota");
    }
  });
});
