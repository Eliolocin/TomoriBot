import { describe, expect, it } from "bun:test";
import {
  buildCapabilitiesManageConfigWritePlan,
  type CapabilitiesManageConfigState,
} from "@/utils/discord/manageConfigMapping";
import {
  buildServerMemberPermissionsConfigWritePlan,
  type ServerMemberPermissionsCommandConfigState,
} from "@/utils/discord/memberPermissionsConfigMapping";
import { buildWorkaroundConfigWritePlan, type WorkaroundConfigState } from "@/utils/discord/workaroundConfigMapping";

function sorted(values: string[]): string[] {
  return values.toSorted();
}

const disabledCapabilitiesManageState: CapabilitiesManageConfigState = {
  self_teaching_enabled: false,
  personal_memories_enabled: false,
  emoji_usage_enabled: false,
  sticker_usage_enabled: false,
  web_search_enabled: false,
  manage_message_enabled: false,
  thread_creation_enabled: false,
  imagegen_enabled: false,
  videogen_enabled: false,
  voice_message_enabled: false,
  user_blocking_enabled: false,
  short_term_memory_enabled: false,
  user_info_updates_enabled: false,
  time_awareness_enabled: false,
};

const enabledCapabilitiesManageState: CapabilitiesManageConfigState = {
  self_teaching_enabled: true,
  personal_memories_enabled: true,
  emoji_usage_enabled: true,
  sticker_usage_enabled: true,
  web_search_enabled: true,
  manage_message_enabled: true,
  thread_creation_enabled: true,
  imagegen_enabled: true,
  videogen_enabled: true,
  voice_message_enabled: true,
  user_blocking_enabled: true,
  short_term_memory_enabled: true,
  user_info_updates_enabled: true,
  time_awareness_enabled: true,
};

const disabledServerMemberPermissionsState: ServerMemberPermissionsCommandConfigState = {
  server_memteaching_enabled: false,
  attribute_memteaching_enabled: false,
  sampledialogue_memteaching_enabled: false,
  prompt_snapshot_enabled: false,
};

const enabledServerMemberPermissionsState: ServerMemberPermissionsCommandConfigState = {
  server_memteaching_enabled: true,
  attribute_memteaching_enabled: true,
  sampledialogue_memteaching_enabled: true,
  prompt_snapshot_enabled: true,
};

const disabledWorkaroundState: WorkaroundConfigState = {
  verbatim_tool_calling_enabled: false,
};

const enabledWorkaroundState: WorkaroundConfigState = {
  verbatim_tool_calling_enabled: true,
};

describe("config command write mappings", () => {
  describe("/capabilities manage", () => {
    it("routes personalization and selfteaching to server_member_permissions_configs", () => {
      const plan = buildCapabilitiesManageConfigWritePlan(
        disabledCapabilitiesManageState,
        ["personalization", "selfteaching"],
        { includeElevenLabs: true },
      );

      expect(plan.method).toBe("updateCapabilitiesAndMemberPermissionsConfig");
      expect(plan.patch.memberPermissions).toEqual({
        personal_memories_enabled: true,
        self_teaching_enabled: true,
      });
      expect(plan.patch.capabilities).toEqual({});
      expect(sorted(plan.changes.map((change) => `${change.table}.${change.dbColumn}`))).toEqual([
        "memberPermissions.personal_memories_enabled",
        "memberPermissions.self_teaching_enabled",
      ]);
    });

    it("routes feature toggles to server_capabilities_configs", () => {
      const plan = buildCapabilitiesManageConfigWritePlan(
        disabledCapabilitiesManageState,
        [
          "emojiusage",
          "stickerusage",
          "websearch",
          "managemessage",
          "threadcreation",
          "imagegen",
          "videogen",
          "voicemessage",
          "userinfo",
          "timeawareness",
        ],
        { includeElevenLabs: true },
      );

      expect(plan.method).toBe("updateCapabilitiesAndMemberPermissionsConfig");
      expect(plan.patch.capabilities).toEqual({
        emoji_usage_enabled: true,
        sticker_usage_enabled: true,
        web_search_enabled: true,
        manage_message_enabled: true,
        thread_creation_enabled: true,
        imagegen_enabled: true,
        videogen_enabled: true,
        voice_message_enabled: true,
        user_info_updates_enabled: true,
        time_awareness_enabled: true,
      });
      expect(plan.patch.memberPermissions).toEqual({});
    });

    it("does not put member-permissions columns in the capabilities patch", () => {
      const plan = buildCapabilitiesManageConfigWritePlan(enabledCapabilitiesManageState, [], {
        includeElevenLabs: true,
      });

      const capabilitiesColumns = Object.keys(plan.patch.capabilities);
      expect(capabilitiesColumns).not.toContain("personal_memories_enabled");
      expect(capabilitiesColumns).not.toContain("self_teaching_enabled");
      expect(plan.patch.memberPermissions).toEqual({
        personal_memories_enabled: false,
        self_teaching_enabled: false,
      });
    });

    it("does not disable the hidden voice option when ElevenLabs is unavailable", () => {
      const plan = buildCapabilitiesManageConfigWritePlan(enabledCapabilitiesManageState, [], {
        includeElevenLabs: false,
      });

      expect("voice_message_enabled" in plan.patch.capabilities).toBe(false);
      expect(plan.patch.capabilities.imagegen_enabled).toBe(false);
    });
  });

  describe("/moderation Member Access", () => {
    it("routes checkbox selections to server_member_permissions_configs", () => {
      const plan = buildServerMemberPermissionsConfigWritePlan(disabledServerMemberPermissionsState, [
        "servermemories",
        "attributelist",
        "sampledialogues",
        "promptsnapshot",
      ]);

      expect(plan.method).toBe("updateMemberPermissionsConfig");
      expect(plan.patch).toEqual({
        server_memteaching_enabled: true,
        attribute_memteaching_enabled: true,
        sampledialogue_memteaching_enabled: true,
        prompt_snapshot_enabled: true,
      });
    });

    it("does not include capabilities-manage split columns", () => {
      const plan = buildServerMemberPermissionsConfigWritePlan(enabledServerMemberPermissionsState, []);
      const patchColumns = Object.keys(plan.patch);

      expect(patchColumns).not.toContain("personal_memories_enabled");
      expect(patchColumns).not.toContain("self_teaching_enabled");
      expect(sorted(patchColumns)).toEqual([
        "attribute_memteaching_enabled",
        "prompt_snapshot_enabled",
        "sampledialogue_memteaching_enabled",
        "server_memteaching_enabled",
      ]);
    });
  });

  describe("/config workarounds", () => {
    it("routes verbatim tool-calling to server_capabilities_configs", () => {
      const plan = buildWorkaroundConfigWritePlan(disabledWorkaroundState, ["verbatim_tool_calling"]);

      expect(plan.method).toBe("updateCapabilitiesConfig");
      expect(plan.patch).toEqual({
        verbatim_tool_calling_enabled: true,
      });
      expect(plan.changes).toEqual([
        {
          value: "verbatim_tool_calling",
          dbColumn: "verbatim_tool_calling_enabled",
          isEnabled: true,
          labelKey: "commands.config.workarounds.verbatim_tool_calling_option",
        },
      ]);
    });

    it("returns an empty patch when the selected state is unchanged", () => {
      const plan = buildWorkaroundConfigWritePlan(enabledWorkaroundState, ["verbatim_tool_calling"]);

      expect(plan.patch).toEqual({});
      expect(plan.changes).toHaveLength(0);
    });
  });
});
