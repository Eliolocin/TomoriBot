import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import type { ToolContext } from "@/types/tool/interfaces";
import {
  stripRedundantAffixes,
  suppressOutrankingOverrides,
  UpdateUserInfoTool,
} from "@/tools/functionCalls/updateUserInfoTool";
import type { UserInfoWriteBatch } from "@/utils/db/repositories/UserNamingRepository";
import { resolveEffectiveUserNaming } from "@/utils/text/userNaming";
import { PrivacyLevel } from "@/types/db/schema";
import { EMPTY_PERSONA_NAMING_CONFIG, type PersonaNamingConfig } from "@/types/personaNaming";
import { initializeLocalizer } from "@/utils/text/localizer";
import { userNamingRepository, userRepository } from "@/utils/db/repositories";
import { configToFeatureFlags, filterToolsByFeatureFlags } from "@/utils/tools/featureFlagMapper";
import { redactToolParametersForStorage } from "@/utils/tools/toolParameterRedaction";

function makeContext(enabled: boolean, namingConfig?: PersonaNamingConfig): ToolContext {
  return {
    userId: "123456789012345678",
    guildId: "987654321098765432",
    locale: "en-US",
    suppressProgressNotices: true,
    personaUsername: "Sparrow",
    tomoriState: {
      persona_lineage_id: 77,
      persona_nickname: "Sparrow",
      naming_config: namingConfig ?? EMPTY_PERSONA_NAMING_CONFIG,
      config: { user_info_updates_enabled: enabled },
    },
  } as ToolContext;
}

describe("UpdateUserInfoTool", () => {
  beforeAll(async () => {
    await initializeLocalizer();
  });

  it("defends execution when the capability is disabled", async () => {
    const result = await new UpdateUserInfoTool().execute(
      {
        changes: [{ field: "nickname", scope: "global", action: "set", text_value: "Sparrow" }],
      },
      makeContext(false),
    );
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ status: "user_info_updates_disabled" });
  });

  it("rejects wildcard targets before resolution or persistence", async () => {
    const result = await new UpdateUserInfoTool().execute(
      {
        target_user: "everyone",
        changes: [{ field: "nickname", scope: "global", action: "clear" }],
      },
      makeContext(true),
    );
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ status: "user_info_update_invalid_target" });
  });

  it("rejects malformed batches without echoing submitted identity values", async () => {
    const result = await new UpdateUserInfoTool().execute(
      {
        changes: [{ field: "pronouns", scope: "persona", action: "set", text_value: "sensitive-value" }],
      },
      makeContext(true),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain("sensitive-value");
  });

  it("redacts identity values from execution history and thought-log details", () => {
    const redacted = redactToolParametersForStorage("update_user_info", {
      target_user: "Sparrow",
      changes: [
        { field: "pronouns", scope: "global", action: "set", text_value: "sensitive-value" },
        { field: "timezone_offset", scope: "global", action: "set", number_value: 8 },
      ],
    });
    expect(redacted).toEqual({
      target_user: "Sparrow",
      changes: [
        { field: "pronouns", scope: "global", action: "set" },
        { field: "timezone_offset", scope: "global", action: "set" },
      ],
    });
    expect(JSON.stringify(redacted)).not.toContain("sensitive-value");
  });

  it("applies omitted-target global and active-persona changes as one batch", async () => {
    const loadSpy = spyOn(userRepository, "loadByDiscordId").mockResolvedValue({
      user_id: 42,
      user_disc_id: "123456789012345678",
      privacy_level: PrivacyLevel.MINIMAL,
    } as never);
    const writeSpy = spyOn(userNamingRepository, "applyUserInfoBatch").mockResolvedValue(undefined);
    try {
      const result = await new UpdateUserInfoTool().execute(
        {
          changes: [
            { field: "nickname", scope: "global", action: "set", text_value: "Sparrow" },
            { field: "prefix", scope: "persona", action: "none" },
          ],
        },
        makeContext(true),
      );
      expect(result.success).toBe(true);
      expect(loadSpy).toHaveBeenCalledWith("123456789012345678");
      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(writeSpy).toHaveBeenCalledWith(42, {
        global: { user_nickname: "Sparrow" },
        persona: { personaLineageId: 77, patch: { prefix_override: "" } },
      });
    } finally {
      loadSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  it("allows privacy-restricted clears while rejecting sets before persistence", async () => {
    const loadSpy = spyOn(userRepository, "loadByDiscordId").mockResolvedValue({
      user_id: 43,
      user_disc_id: "123456789012345678",
      privacy_level: PrivacyLevel.FULL,
    } as never);
    const writeSpy = spyOn(userNamingRepository, "applyUserInfoBatch").mockResolvedValue(undefined);
    try {
      const rejected = await new UpdateUserInfoTool().execute(
        { changes: [{ field: "pronouns", scope: "global", action: "set", text_value: "they/them" }] },
        makeContext(true),
      );
      expect(rejected.data).toMatchObject({ status: "user_info_update_privacy_restricted" });
      expect(writeSpy).not.toHaveBeenCalled();

      const cleared = await new UpdateUserInfoTool().execute(
        { changes: [{ field: "pronouns", scope: "global", action: "clear" }] },
        makeContext(true),
      );
      expect(cleared.success).toBe(true);
      expect(writeSpy).toHaveBeenCalledWith(43, { global: { pronouns: null } });
    } finally {
      loadSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  it("rejects an invalid mixed batch before target lookup or persistence", async () => {
    const loadSpy = spyOn(userRepository, "loadByDiscordId");
    const writeSpy = spyOn(userNamingRepository, "applyUserInfoBatch");
    try {
      const result = await new UpdateUserInfoTool().execute(
        {
          changes: [
            { field: "nickname", scope: "global", action: "set", text_value: "Sparrow" },
            { field: "timezone_offset", scope: "global", action: "set", number_value: 15 },
          ],
        },
        makeContext(true),
      );
      expect(result.data).toMatchObject({ status: "user_info_update_invalid_change" });
      expect(loadSpy).not.toHaveBeenCalled();
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      loadSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });
});

describe("update_user_info affix de-duplication", () => {
  function naming(prefix: string, suffix: string) {
    return resolveEffectiveUserNaming({
      global: {
        userNickname: "Bred",
        prefixOverride: prefix || null,
        suffixOverride: suffix || null,
        addressingStyle: null,
      },
      liveDisplayName: "Bredrumb",
    });
  }

  it("removes a prefix the model re-typed into the nickname", () => {
    const changes = [{ field: "nickname", scope: "global", action: "set", text_value: "Master Bred" }] as never;
    stripRedundantAffixes(changes, naming("Master", ""));
    expect(changes).toEqual([{ field: "nickname", scope: "global", action: "set", text_value: "Bred" }] as never);
  });

  it("removes a suffix the model re-typed into the nickname", () => {
    const changes = [{ field: "nickname", scope: "global", action: "set", text_value: "Bred-san" }] as never;
    stripRedundantAffixes(changes, naming("", "-san"));
    expect(changes).toEqual([{ field: "nickname", scope: "global", action: "set", text_value: "Bred" }] as never);
  });

  it("matches the affix the same batch is setting rather than the one it replaces", () => {
    const changes = [
      { field: "prefix", scope: "global", action: "set", text_value: "Sir" },
      { field: "nickname", scope: "global", action: "set", text_value: "Sir Bred" },
    ] as never;
    stripRedundantAffixes(changes, naming("Master", ""));
    expect((changes as unknown as Array<{ text_value: string }>)[1].text_value).toBe("Bred");
  });

  it("leaves a nickname alone when the batch suppresses the affix", () => {
    const changes = [
      { field: "prefix", scope: "global", action: "none" },
      { field: "nickname", scope: "global", action: "set", text_value: "Master Bred" },
    ] as never;
    stripRedundantAffixes(changes, naming("Master", ""));
    expect((changes as unknown as Array<{ text_value: string }>)[1].text_value).toBe("Master Bred");
  });

  it("never splits a nickname that does not contain the resolved affix", () => {
    const changes = [{ field: "nickname", scope: "global", action: "set", text_value: "Big Bred" }] as never;
    stripRedundantAffixes(changes, naming("Master", ""));
    expect((changes as unknown as Array<{ text_value: string }>)[0].text_value).toBe("Big Bred");
  });

  it("also clears a persona-lineage override that would outrank a global none", () => {
    const changes = [{ field: "prefix", scope: "global", action: "none" }] as never;
    const batch: UserInfoWriteBatch = { global: {}, persona: { personaLineageId: 77, patch: {} } };
    const outranked = resolveEffectiveUserNaming({
      global: { userNickname: "Bred", prefixOverride: null, suffixOverride: null, addressingStyle: null },
      liveDisplayName: "Bredrumb",
      preference: { nickname_override: null, prefix_override: "Captain", suffix_override: null },
    });
    expect(outranked.prefixSource).toBe("persona_preference");

    suppressOutrankingOverrides(changes, outranked, batch);
    expect(batch.persona?.patch).toEqual({ prefix_override: null });
  });

  it("leaves a lineage override alone when the same batch sets it deliberately", () => {
    const changes = [
      { field: "prefix", scope: "persona", action: "set", text_value: "Captain" },
      { field: "prefix", scope: "global", action: "none" },
    ] as never;
    const batch: UserInfoWriteBatch = {
      global: {},
      persona: { personaLineageId: 77, patch: { prefix_override: "Captain" } },
    };
    const outranked = resolveEffectiveUserNaming({
      global: { userNickname: "Bred", prefixOverride: null, suffixOverride: null, addressingStyle: null },
      liveDisplayName: "Bredrumb",
      preference: { nickname_override: null, prefix_override: "Captain", suffix_override: null },
    });

    suppressOutrankingOverrides(changes, outranked, batch);
    expect(batch.persona?.patch).toEqual({ prefix_override: "Captain" });
  });

  it("does not widen inherit, whose fall-back semantics are intentional", () => {
    const changes = [{ field: "prefix", scope: "global", action: "inherit" }] as never;
    const batch: UserInfoWriteBatch = { global: {}, persona: { personaLineageId: 77, patch: {} } };
    const outranked = resolveEffectiveUserNaming({
      global: { userNickname: "Bred", prefixOverride: null, suffixOverride: null, addressingStyle: null },
      liveDisplayName: "Bredrumb",
      preference: { nickname_override: null, prefix_override: "Captain", suffix_override: null },
    });

    suppressOutrankingOverrides(changes, outranked, batch);
    expect(batch.persona?.patch).toEqual({});
  });

  it("keeps a nickname that is exactly the affix rather than emptying it", () => {
    const changes = [{ field: "nickname", scope: "global", action: "set", text_value: "Master" }] as never;
    stripRedundantAffixes(changes, naming("Master", ""));
    expect((changes as unknown as Array<{ text_value: string }>)[0].text_value).toBe("Master");
  });
});

describe("user info capability mapping", () => {
  const baseConfig = {
    sticker_usage_enabled: true,
    web_search_enabled: true,
    self_teaching_enabled: true,
    manage_message_enabled: true,
    imagegen_enabled: true,
    videogen_enabled: true,
    voice_message_enabled: true,
    user_blocking_enabled: true,
    thread_creation_enabled: true,
  };

  it("defaults enabled for older assembled state and filters when explicitly disabled", () => {
    expect(configToFeatureFlags(baseConfig).user_info_updates).toBe(true);
    const disabled = configToFeatureFlags({ ...baseConfig, user_info_updates_enabled: false });
    expect(filterToolsByFeatureFlags(["update_user_info", "review_capabilities"], disabled)).toEqual([
      "review_capabilities",
    ]);
  });
});
