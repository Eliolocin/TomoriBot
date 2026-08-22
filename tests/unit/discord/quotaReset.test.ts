import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import { ApplicationCommandOptionType, PermissionsBitField } from "discord.js";
import type { ChatInputCommandInteraction, Client, User } from "discord.js";
import { execute as executeQuotaResetGlobal } from "@/commands/quota/reset/global";
import { execute as executeQuotaResetUser } from "@/commands/quota/reset/user";
import type { UserRow } from "@/types/db/schema";
import { serverRepository } from "@/utils/db/repositories/ServerRepository";
import { loadCommandData } from "@/utils/discord/commandLoader";
import {
  quotaResetOperations,
  resetGlobalQuota,
  resetUserQuota,
  type QuotaResetDependencies,
} from "@/utils/quota/quotaResetOperations";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";
import { callMethods, makeFakeInteraction } from "../../helpers/fakeInteraction";

beforeAll(async () => initializeLocalizer());

type OptionChoice = {
  name: string;
  value: string;
};

type OptionPayload = {
  name: string;
  type: number;
  required?: boolean;
  choices?: OptionChoice[];
  options?: OptionPayload[];
};

type CommandPayload = {
  name: string;
  contexts?: number[];
  default_member_permissions?: string;
  options?: OptionPayload[];
};

const DUMMY_USER_ROW: UserRow = {
  user_id: 1,
  user_disc_id: "user-1",
  user_name: "TestUser",
  language_pref: "en-US",
  created_at: new Date(),
  updated_at: new Date(),
};

describe("/quota registration and option shape", () => {
  it("registers /quota as guild-only and manager-only with exact option shapes", async () => {
    const { executionMap, registrationData } = await loadCommandData();
    const quota = registrationData.find((cmd) => cmd.name === "quota") as unknown as CommandPayload | undefined;

    expect(quota).toBeDefined();
    if (!quota) return;

    expect(quota.contexts).toEqual([0]);
    expect(quota.default_member_permissions).toBe(String(PermissionsBitField.Flags.ManageGuild));
    expect([...(executionMap.get("quota")?.keys() ?? [])].sort()).toEqual(["reset.global", "reset.user"]);

    const resetGroup = quota.options?.find((opt) => opt.name === "reset");
    expect(resetGroup).toBeDefined();
    expect(resetGroup?.type).toBe(ApplicationCommandOptionType.SubcommandGroup);

    const userSubcommand = resetGroup?.options?.find((sub) => sub.name === "user");
    expect(userSubcommand).toBeDefined();
    expect(userSubcommand?.type).toBe(ApplicationCommandOptionType.Subcommand);

    const memberOption = userSubcommand?.options?.find((opt) => opt.name === "member");
    expect(memberOption).toBeDefined();
    expect(memberOption?.type).toBe(ApplicationCommandOptionType.User);
    expect(memberOption?.required).toBe(true);

    const userQuotaTypeOption = userSubcommand?.options?.find((opt) => opt.name === "quota_type");
    expect(userQuotaTypeOption).toBeDefined();
    expect(userQuotaTypeOption?.type).toBe(ApplicationCommandOptionType.String);
    expect(userQuotaTypeOption?.required).toBe(true);
    expect(userQuotaTypeOption?.choices?.map((c) => c.value).sort()).toEqual(["image", "text", "video"]);

    const globalSubcommand = resetGroup?.options?.find((sub) => sub.name === "global");
    expect(globalSubcommand).toBeDefined();
    expect(globalSubcommand?.type).toBe(ApplicationCommandOptionType.Subcommand);

    const globalQuotaTypeOption = globalSubcommand?.options?.find((opt) => opt.name === "quota_type");
    expect(globalQuotaTypeOption).toBeDefined();
    expect(globalQuotaTypeOption?.type).toBe(ApplicationCommandOptionType.String);
    expect(globalQuotaTypeOption?.required).toBe(true);
    expect(globalQuotaTypeOption?.choices?.map((c) => c.value).sort()).toEqual(["image", "text", "video"]);
  });
});

describe("canonical quota reset operations", () => {
  it("routes resetUserQuota to exact repository methods with exact arguments", async () => {
    const calls: Array<{ type: string; args: unknown[] }> = [];
    const mockDeps: QuotaResetDependencies = {
      resetUserDailyImageQuota: async (serverId, userId) => {
        calls.push({ type: "image", args: [serverId, userId] });
      },
      resetUserDailyTextQuota: async (serverId, userId) => {
        calls.push({ type: "text", args: [serverId, userId] });
      },
      resetUserDailyVideoQuota: async (serverId, userId) => {
        calls.push({ type: "video", args: [serverId, userId] });
      },
      resetServerwideImageQuotaPool: async (serverId) => {
        calls.push({ type: "global_image", args: [serverId] });
      },
      resetServerwideTextQuotaPool: async (serverId) => {
        calls.push({ type: "global_text", args: [serverId] });
      },
      resetServerwideVideoQuotaPool: async (serverId) => {
        calls.push({ type: "global_video", args: [serverId] });
      },
    };

    await resetUserQuota({ serverId: 101, targetUserId: "disc-user-1", quotaType: "image" }, mockDeps);
    await resetUserQuota({ serverId: 102, targetUserId: "disc-user-2", quotaType: "text" }, mockDeps);
    await resetUserQuota({ serverId: 103, targetUserId: "disc-user-3", quotaType: "video" }, mockDeps);

    expect(calls).toEqual([
      { type: "image", args: [101, "disc-user-1"] },
      { type: "text", args: [102, "disc-user-2"] },
      { type: "video", args: [103, "disc-user-3"] },
    ]);
  });

  it("routes resetGlobalQuota to exact repository methods with exact arguments", async () => {
    const calls: Array<{ type: string; args: unknown[] }> = [];
    const mockDeps: QuotaResetDependencies = {
      resetUserDailyImageQuota: async (serverId, userId) => {
        calls.push({ type: "user_image", args: [serverId, userId] });
      },
      resetUserDailyTextQuota: async (serverId, userId) => {
        calls.push({ type: "user_text", args: [serverId, userId] });
      },
      resetUserDailyVideoQuota: async (serverId, userId) => {
        calls.push({ type: "user_video", args: [serverId, userId] });
      },
      resetServerwideImageQuotaPool: async (serverId) => {
        calls.push({ type: "global_image", args: [serverId] });
      },
      resetServerwideTextQuotaPool: async (serverId) => {
        calls.push({ type: "global_text", args: [serverId] });
      },
      resetServerwideVideoQuotaPool: async (serverId) => {
        calls.push({ type: "global_video", args: [serverId] });
      },
    };

    await resetGlobalQuota({ serverId: 201, quotaType: "image" }, mockDeps);
    await resetGlobalQuota({ serverId: 202, quotaType: "text" }, mockDeps);
    await resetGlobalQuota({ serverId: 203, quotaType: "video" }, mockDeps);

    expect(calls).toEqual([
      { type: "global_image", args: [201] },
      { type: "global_text", args: [202] },
      { type: "global_video", args: [203] },
    ]);
  });
});

describe("/quota reset user handler", () => {
  it("rejects non-guild and non-channel interactions", async () => {
    const { interaction, calls } = makeFakeInteraction({
      guild: null,
      channel: null,
    });

    await executeQuotaResetUser(
      {} as Client,
      interaction as unknown as ChatInputCommandInteraction,
      DUMMY_USER_ROW,
      "en-US",
    );

    expect(callMethods(calls)).toEqual(["reply"]);
    const replyPayload = calls[0]?.args[0] as { embeds?: Array<{ data?: { title?: string } }> };
    expect(replyPayload?.embeds?.[0]?.data?.title).toContain(localizer("en-US", "general.errors.guild_only_title"));
  });

  it("denies non-managers before any server lookup or write", async () => {
    const serverRepoSpy = spyOn(serverRepository, "loadServerIdByDiscId").mockResolvedValue(null);
    const resetUserSpy = spyOn(quotaResetOperations, "resetUserQuota");

    const { interaction, calls } = makeFakeInteraction({
      guild: { id: "guild-1" },
      channel: {},
      guildId: "guild-1",
      memberPermissions: { has: () => false },
    });

    try {
      await executeQuotaResetUser(
        {} as Client,
        interaction as unknown as ChatInputCommandInteraction,
        DUMMY_USER_ROW,
        "en-US",
      );

      expect(serverRepoSpy).not.toHaveBeenCalled();
      expect(resetUserSpy).not.toHaveBeenCalled();
      expect(callMethods(calls)).toEqual(["reply"]);
      const replyPayload = calls[0]?.args[0] as { embeds?: Array<{ data?: { title?: string } }> };
      expect(replyPayload?.embeds?.[0]?.data?.title).toContain(
        localizer("en-US", "general.errors.permission_denied_title"),
      );
    } finally {
      serverRepoSpy.mockRestore();
      resetUserSpy.mockRestore();
    }
  });

  it("acknowledges before writing, then replies with the user mention", async () => {
    const serverRepoSpy = spyOn(serverRepository, "loadServerIdByDiscId").mockResolvedValue(42);
    let acknowledgedBeforeWrite = false;
    const resetUserSpy = spyOn(quotaResetOperations, "resetUserQuota").mockImplementation(async () => {
      acknowledgedBeforeWrite = interaction.deferred || interaction.replied;
    });

    const targetUser = { id: "target-user-123" } as User;
    const { interaction, calls } = makeFakeInteraction({
      guild: { id: "guild-1" },
      channel: {},
      guildId: "guild-1",
      memberPermissions: { has: () => true },
      options: {
        getUser: (_name: string) => targetUser,
        getString: (_name: string) => "image",
        getBoolean: () => null,
      } as never,
    });

    try {
      await executeQuotaResetUser(
        {} as Client,
        interaction as unknown as ChatInputCommandInteraction,
        DUMMY_USER_ROW,
        "en-US",
      );

      expect(serverRepoSpy).toHaveBeenCalledWith("guild-1");
      expect(resetUserSpy).toHaveBeenCalledWith({
        serverId: 42,
        targetUserId: "target-user-123",
        quotaType: "image",
      });
      // Discord drops an interaction that is not acknowledged within three seconds, and this path
      // does a server lookup and a quota write first, so the write must never precede the ack.
      expect(callMethods(calls)).toEqual(["deferReply", "editReply"]);
      expect(acknowledgedBeforeWrite).toBe(true);

      const replyPayload = calls[1]?.args[0] as {
        embeds?: Array<{ data?: { title?: string; description?: string } }>;
      };
      expect(replyPayload?.embeds?.[0]?.data?.title).toContain(
        localizer("en-US", "commands.quota.reset.user.success_title"),
      );
      expect(replyPayload?.embeds?.[0]?.data?.description).toContain("<@target-user-123>");
    } finally {
      serverRepoSpy.mockRestore();
      resetUserSpy.mockRestore();
    }
  });
});

describe("/quota reset global handler", () => {
  it("rejects non-guild and non-channel interactions", async () => {
    const { interaction, calls } = makeFakeInteraction({
      guild: null,
      channel: null,
    });

    await executeQuotaResetGlobal(
      {} as Client,
      interaction as unknown as ChatInputCommandInteraction,
      DUMMY_USER_ROW,
      "en-US",
    );

    expect(callMethods(calls)).toEqual(["reply"]);
    const replyPayload = calls[0]?.args[0] as { embeds?: Array<{ data?: { title?: string } }> };
    expect(replyPayload?.embeds?.[0]?.data?.title).toContain(localizer("en-US", "general.errors.guild_only_title"));
  });

  it("denies non-managers before any server lookup or write", async () => {
    const serverRepoSpy = spyOn(serverRepository, "loadServerIdByDiscId").mockResolvedValue(null);
    const resetGlobalSpy = spyOn(quotaResetOperations, "resetGlobalQuota");

    const { interaction, calls } = makeFakeInteraction({
      guild: { id: "guild-1" },
      channel: {},
      guildId: "guild-1",
      memberPermissions: { has: () => false },
    });

    try {
      await executeQuotaResetGlobal(
        {} as Client,
        interaction as unknown as ChatInputCommandInteraction,
        DUMMY_USER_ROW,
        "en-US",
      );

      expect(serverRepoSpy).not.toHaveBeenCalled();
      expect(resetGlobalSpy).not.toHaveBeenCalled();
      expect(callMethods(calls)).toEqual(["reply"]);
      const replyPayload = calls[0]?.args[0] as { embeds?: Array<{ data?: { title?: string } }> };
      expect(replyPayload?.embeds?.[0]?.data?.title).toContain(
        localizer("en-US", "general.errors.permission_denied_title"),
      );
    } finally {
      serverRepoSpy.mockRestore();
      resetGlobalSpy.mockRestore();
    }
  });

  it("defers reply and executes serverwide reset successfully", async () => {
    const serverRepoSpy = spyOn(serverRepository, "loadServerIdByDiscId").mockResolvedValue(42);
    const resetGlobalSpy = spyOn(quotaResetOperations, "resetGlobalQuota").mockResolvedValue(undefined);

    const { interaction, calls } = makeFakeInteraction({
      guild: { id: "guild-1" },
      channel: {},
      guildId: "guild-1",
      memberPermissions: { has: () => true },
      options: {
        getString: (_name: string) => "video",
        getBoolean: () => null,
      } as never,
    });

    try {
      await executeQuotaResetGlobal(
        {} as Client,
        interaction as unknown as ChatInputCommandInteraction,
        DUMMY_USER_ROW,
        "en-US",
      );

      expect(serverRepoSpy).toHaveBeenCalledWith("guild-1");
      expect(resetGlobalSpy).toHaveBeenCalledWith({
        serverId: 42,
        quotaType: "video",
      });
      expect(callMethods(calls)).toEqual(["deferReply", "editReply"]);

      const replyPayload = calls[1]?.args[0] as {
        embeds?: Array<{ data?: { title?: string; description?: string } }>;
      };
      expect(replyPayload?.embeds?.[0]?.data?.title).toContain(
        localizer("en-US", "commands.quota.reset.global.success_title"),
      );
    } finally {
      serverRepoSpy.mockRestore();
      resetGlobalSpy.mockRestore();
    }
  });
});
