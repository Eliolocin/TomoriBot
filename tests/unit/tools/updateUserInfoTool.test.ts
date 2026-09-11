import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import type { ToolContext, ToolStateForContext } from "@/types/tool/interfaces";
import { stripRedundantAffixes, UpdateUserInfoTool } from "@/tools/functionCalls/updateUserInfoTool";
import { getAvailableToolsForContext } from "@/tools/availability";
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
    const result = await new UpdateUserInfoTool().execute({ nickname: "Sparrow" }, makeContext(false));
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ status: "user_info_updates_disabled" });
  });

  it("rejects wildcard targets before resolution or persistence", async () => {
    const result = await new UpdateUserInfoTool().execute(
      { target_user: "everyone", clear: ["nickname"] },
      makeContext(true),
    );
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ status: "user_info_update_invalid_target" });
  });

  it("rejects a call that changes nothing", async () => {
    const result = await new UpdateUserInfoTool().execute({}, makeContext(true));
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ status: "user_info_update_invalid_change" });
  });

  it("rejects a field that is both set and cleared", async () => {
    const result = await new UpdateUserInfoTool().execute({ prefix: "Master", clear: ["prefix"] }, makeContext(true));
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ status: "user_info_update_duplicate_change" });
  });

  it("rejects malformed input without echoing submitted identity values", async () => {
    const result = await new UpdateUserInfoTool().execute(
      { pronouns: "sensitive-value", unknown_field: true },
      makeContext(true),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain("sensitive-value");
  });

  it("redacts identity values from execution history and thought-log details", () => {
    const redacted = redactToolParametersForStorage("update_user_info", {
      target_user: "Sparrow",
      pronouns: "sensitive-value",
      timezone_offset: 8,
      clear: ["prefix"],
    });
    expect(redacted).toEqual({
      target_user: "Sparrow",
      changed_fields: ["pronouns", "timezone_offset"],
      cleared_fields: ["prefix"],
    });
    expect(JSON.stringify(redacted)).not.toContain("sensitive-value");
    expect(JSON.stringify(redacted)).not.toContain("8");
  });

  it("routes naming fields to the active lineage and identity fields to global storage", async () => {
    const loadSpy = spyOn(userRepository, "loadByDiscordId").mockResolvedValue({
      user_id: 42,
      user_disc_id: "123456789012345678",
      privacy_level: PrivacyLevel.MINIMAL,
    } as never);
    const writeSpy = spyOn(userNamingRepository, "applyUserInfoBatch").mockResolvedValue(undefined);
    const preferenceSpy = spyOn(userNamingRepository, "loadPreferences").mockResolvedValue(new Map() as never);
    try {
      const result = await new UpdateUserInfoTool().execute(
        { nickname: "Sparrow", pronouns: "they/them", clear: ["prefix"] },
        makeContext(true),
      );
      expect(result.success).toBe(true);
      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(writeSpy).toHaveBeenCalledWith(42, {
        global: { pronouns: "they/them" },
        persona: { personaLineageId: 77, patch: { nickname_override: "Sparrow", prefix_override: "" } },
      });
    } finally {
      loadSpy.mockRestore();
      writeSpy.mockRestore();
      preferenceSpy.mockRestore();
    }
  });

  it("treats a blank string as a removal rather than a rejected value", async () => {
    const loadSpy = spyOn(userRepository, "loadByDiscordId").mockResolvedValue({
      user_id: 46,
      user_disc_id: "123456789012345678",
      privacy_level: PrivacyLevel.MINIMAL,
    } as never);
    const writeSpy = spyOn(userNamingRepository, "applyUserInfoBatch").mockResolvedValue(undefined);
    const preferenceSpy = spyOn(userNamingRepository, "loadPreferences").mockResolvedValue(new Map() as never);
    try {
      const result = await new UpdateUserInfoTool().execute({ prefix: "   " }, makeContext(true));
      expect(result.success).toBe(true);
      expect(writeSpy).toHaveBeenCalledWith(46, {
        global: {},
        persona: { personaLineageId: 77, patch: { prefix_override: "" } },
      });
    } finally {
      loadSpy.mockRestore();
      writeSpy.mockRestore();
      preferenceSpy.mockRestore();
    }
  });

  it("allows privacy-restricted clears while rejecting sets before persistence", async () => {
    const loadSpy = spyOn(userRepository, "loadByDiscordId").mockResolvedValue({
      user_id: 43,
      user_disc_id: "123456789012345678",
      privacy_level: PrivacyLevel.FULL,
    } as never);
    const writeSpy = spyOn(userNamingRepository, "applyUserInfoBatch").mockResolvedValue(undefined);
    const preferenceSpy = spyOn(userNamingRepository, "loadPreferences").mockResolvedValue(new Map() as never);
    try {
      const rejected = await new UpdateUserInfoTool().execute({ pronouns: "they/them" }, makeContext(true));
      expect(rejected.data).toMatchObject({ status: "user_info_update_privacy_restricted" });
      expect(writeSpy).not.toHaveBeenCalled();

      const cleared = await new UpdateUserInfoTool().execute({ clear: ["pronouns"] }, makeContext(true));
      expect(cleared.success).toBe(true);
      expect(writeSpy).toHaveBeenCalledWith(43, { global: { pronouns: null } });
    } finally {
      loadSpy.mockRestore();
      writeSpy.mockRestore();
      preferenceSpy.mockRestore();
    }
  });

  it("reports the resulting name only when that name actually moved", async () => {
    const row = {
      user_id: 47,
      user_disc_id: "123456789012345678",
      user_nickname: "Obonya",
      privacy_level: PrivacyLevel.MINIMAL,
      addressing_style: null,
    };
    let stored: Record<string, unknown> = { ...row };
    const loadSpy = spyOn(userRepository, "loadByDiscordId").mockImplementation(async () => stored as never);
    const writeSpy = spyOn(userNamingRepository, "applyUserInfoBatch").mockImplementation(async (_id, batch) => {
      stored = { ...stored, ...batch.global };
    });
    const preferenceSpy = spyOn(userNamingRepository, "loadPreferences").mockResolvedValue(new Map() as never);
    const nerine: PersonaNamingConfig = {
      prefixes: { masculine: "Master", feminine: "Mistress" },
      suffixes: {},
      addressTerms: {},
    };
    try {
      // A pronoun edit leaves the rendered name untouched.
      stored = { ...row };
      const pronounsOnly = await new UpdateUserInfoTool().execute({ pronouns: "he/him" }, makeContext(true, nerine));
      expect(pronounsOnly.success).toBe(true);
      expect(pronounsOnly.message).not.toContain("now calls");

      // An addressing-style switch moves the affix with no naming field present.
      stored = { ...row };
      const styleChange = await new UpdateUserInfoTool().execute(
        { addressing_style: "feminine" },
        makeContext(true, nerine),
      );
      expect(styleChange.success).toBe(true);
      expect(styleChange.message).toContain('now calls Obonya "Mistress Obonya"');
    } finally {
      loadSpy.mockRestore();
      writeSpy.mockRestore();
      preferenceSpy.mockRestore();
    }
  });

  it("rejects an out-of-range timezone before target lookup or persistence", async () => {
    const loadSpy = spyOn(userRepository, "loadByDiscordId");
    const writeSpy = spyOn(userNamingRepository, "applyUserInfoBatch");
    try {
      const result = await new UpdateUserInfoTool().execute(
        { nickname: "Sparrow", timezone_offset: 15 },
        makeContext(true),
      );
      expect(result.data).toMatchObject({ status: "user_info_update_invalid_args" });
      expect(loadSpy).not.toHaveBeenCalled();
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      loadSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });
});

describe("update_user_info affix de-duplication", () => {
  it("removes a prefix the caller re-typed into the nickname", () => {
    expect(stripRedundantAffixes("Master Obo", "Master", "")).toBe("Obo");
  });

  it("removes a suffix the caller re-typed into the nickname", () => {
    expect(stripRedundantAffixes("Obo-san", "", "-san")).toBe("Obo");
  });

  it("removes both affixes at once", () => {
    expect(stripRedundantAffixes("Master Obo-san", "Master", "-san")).toBe("Obo");
  });

  it("never splits a nickname that does not contain the resolved affix", () => {
    expect(stripRedundantAffixes("Big Obo", "Master", "")).toBe("Big Obo");
  });

  it("keeps a nickname that is exactly the affix rather than emptying it", () => {
    expect(stripRedundantAffixes("Master", "Master", "")).toBe("Master");
  });

  it("does nothing when no affix is in effect", () => {
    expect(stripRedundantAffixes("Master Obo", "", "")).toBe("Master Obo");
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
    user_info_updates_enabled: true,
    thread_creation_enabled: true,
  };

  it("maps the capability column straight through without a defaulting step", () => {
    expect(configToFeatureFlags(baseConfig).user_info_updates).toBe(true);
    expect(configToFeatureFlags({ ...baseConfig, user_info_updates_enabled: false }).user_info_updates).toBe(false);
  });

  it("filters the tool by name when the capability is disabled", () => {
    const disabled = configToFeatureFlags({ ...baseConfig, user_info_updates_enabled: false });
    expect(filterToolsByFeatureFlags(["update_user_info", "review_capabilities"], disabled)).toEqual([
      "review_capabilities",
    ]);
  });

  // Guards the gap that shipped: every provider assembles this config by hand, so a
  // correct column, mapper, and registry entry still advertised the tool because the
  // assembled state dropped the field on the way through.
  it("withholds the tool from the assembled context state when the capability is disabled", () => {
    const stateFor = (enabled: boolean): ToolStateForContext => ({
      server_id: "1",
      activePersonaHasElevenlabsVoice: false,
      activePersonaVoiceDesignPrompt: null,
      activePersonaVoiceName: null,
      diffusion_model_id: null,
      nai_diffusion_model_id: null,
      video_model_id: null,
      llm: {
        llm_codename: "test-model",
        has_tools: true,
        sees_images: true,
        sees_videos: false,
        sees_youtube: false,
        supports_structoutput: true,
      },
      config: { ...baseConfig, user_info_updates_enabled: enabled },
    });

    const names = (enabled: boolean) =>
      getAvailableToolsForContext([new UpdateUserInfoTool()], "google", stateFor(enabled)).map((tool) => tool.name);

    expect(names(true)).toContain("update_user_info");
    expect(names(false)).not.toContain("update_user_info");
  });
});
