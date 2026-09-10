import { describe, expect, it } from "bun:test";
import type { sql } from "@/utils/db/client";
import { V2_CONFIG_EXCLUSIONS, personalConfigExportSchema, workspaceConfigExportSchema } from "@/types/db/dataExport";
import { ExportRepository } from "@/utils/db/repositories/ExportRepository";

const queryLog: string[] = [];

const workspaceRow: Record<string, unknown> = {
  server_id: 42,
  llm_temperature: 0.7,
  thinking_level: "medium",
  llm_disabled_params: ["temperature"],
  llm_top_p: 0.9,
  llm_top_k: 20,
  llm_frequency_penalty: 0.1,
  llm_presence_penalty: 0.2,
  llm_min_p: 0.05,
  llm_max_output_tokens: 512,
  llm_logit_biases: [{ id: "bias-1", text: "hello", value: 2, tokenizations: [] }],
  llm_stop_strings: ["END"],
  llm_stop_speaker_pattern_enabled: true,
  humanizer_degree: 2,
  timezone_offset: 8,
  message_fetch_limit: 60,
  system_prompt: "Portable system prompt",
  cascade_limit: 3,
  match_limit: 4,
  send_message_limit: 5,
  context_note: "Portable context note",
  context_note_depth: 6,
  server_memteaching_enabled: true,
  attribute_memteaching_enabled: false,
  sampledialogue_memteaching_enabled: true,
  self_teaching_enabled: true,
  personal_memories_enabled: false,
  prompt_snapshot_enabled: true,
  web_search_enabled: false,
  emoji_usage_enabled: true,
  sticker_usage_enabled: false,
  imagegen_enabled: true,
  manage_message_enabled: true,
  videogen_enabled: false,
  voice_message_enabled: true,
  thread_creation_enabled: false,
  user_blocking_enabled: true,
  time_awareness_enabled: false,
  tool_use_enabled: true,
  short_term_memory_enabled: true,
  verbatim_tool_calling_enabled: false,
  user_info_updates_enabled: true,
  tool_notice_hidden_keys: ["web_search"],
  uncensor_injection_enabled: true,
  uncensor_unicode_space_enabled: false,
  uncensor_sanitize_enabled: true,
  self_debug_enabled: true,
  voice_transcript_chat_mode: true,
  chatterbox_turbo_enabled: false,
  chatterbox_cfg_weight: 1.2,
  chatterbox_exaggeration: 0.8,
  always_reply_enabled: true,
  deliberate_trigger_mode: false,
  deliberate_tool_mode: true,
  deliberate_tool_context_turns: 2,
  deliberate_tool_triggers: { memory: ["remember this"] },
  cooldown_type: 1,
  cooldown_length: 30,
  stm_privacy_bypass: true,
  image_default_positive_tags: ["portrait"],
  image_default_negative_tags: ["blurry"],
  nai_sampler: "karras",
  nai_steps: 28,
  nai_scale: 6,
  nai_noise_schedule: "native",
  nai_cfg_rescale: 0.3,
  user_byok_mode: false,
  memory_tagging_enabled: true,
  channel_memory_enabled: true,
  welcome_prompt: "Welcome",
  stm_config_server_id: 42,
  refresh_cadence: 5,
  render_mode: "supersede",
  crude_message_count: 10,
  tool_description_override: null,
  update_nudge_override: null,
  nudge_injection_depth: 1,
  content_injection_depth: 2,
};

const personalRow: Record<string, unknown> = {
  user_nickname: "Jordan",
  language_pref: "en-US",
  privacy_level: 1,
  shortterm_cache_crossserver_opt_in: true,
  physical_appearance_tags: ["short hair"],
  impersonation_prompt: "Use first person",
  personal_dtm: "follow",
  personal_deliberate_tool_mode: "on",
  timezone_offset: 8,
  prefix_override: "Captain",
  suffix_override: null,
  gender_identity: "neutral",
  pronouns: "they/them",
  addressing_style: "neutral",
};

const fakeSql = ((strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> => {
  const query = strings.join(" ? ").replace(/\s+/g, " ").trim();
  queryLog.push(query);

  if (query.includes("FROM servers s")) return Promise.resolve([workspaceRow]);
  if (query.includes("FROM stm_categories sc")) {
    return Promise.resolve([{ position: 0, label: "Facts", description: "Known facts" }]);
  }
  if (query.includes("FROM users u")) return Promise.resolve([personalRow]);
  return Promise.resolve([]);
}) as unknown as typeof sql;

function freshRepository(): ExportRepository {
  queryLog.length = 0;
  return new ExportRepository(fakeSql);
}

function objectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) objectKeys(item, keys);
    return keys;
  }
  if (typeof value !== "object" || value === null) return keys;

  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    objectKeys(child, keys);
  }
  return keys;
}

describe("v2 config export projections", () => {
  it("emits every workspace section with portable values", async () => {
    const result = await freshRepository().exportWorkspaceConfig("workspace-disc-id");

    expect(result.success).toBe(true);
    if (!result.success || !result.data || result.data.type !== "workspace_config") return;

    expect(Object.keys(result.data.data)).toEqual([
      "chat",
      "triggers",
      "capabilities",
      "memory",
      "media",
      "speech",
      "access",
    ]);
    expect(result.data.data.chat?.system_prompt).toBe("Portable system prompt");
    expect(result.data.data.capabilities?.self_debug_enabled).toBe(true);
    expect(result.data.data.memory?.stm_categories).toEqual([
      { position: 0, label: "Facts", description: "Known facts" },
    ]);
    expect(result.data.data.media).not.toHaveProperty("nai_preset_name");
    expect(result.data.data).not.toHaveProperty("model_randomizer_enabled");
  });

  it("emits every personal section with portable values", async () => {
    const result = await freshRepository().exportPersonalConfig("user-disc-id");

    expect(result.success).toBe(true);
    if (!result.success || !result.data || result.data.type !== "personal_config") return;

    expect(Object.keys(result.data.data)).toEqual(["profile", "privacy", "appearance", "response_modes"]);
    expect(result.data.data.profile?.user_nickname).toBe("Jordan");
    expect(result.data.data.privacy?.privacy_level).toBe(1);
    expect(result.data.data.appearance?.physical_appearance_tags).toEqual(["short hair"]);
    expect(result.data.data.response_modes?.personal_deliberate_tool_mode).toBe("on");
  });

  it("does not put a v2 exclusion in either projection", async () => {
    const workspace = await freshRepository().exportWorkspaceConfig("workspace-disc-id");
    const personal = await freshRepository().exportPersonalConfig("user-disc-id");

    expect(workspace.success).toBe(true);
    expect(personal.success).toBe(true);
    if (!workspace.success || !workspace.data || !personal.success || !personal.data) return;

    const workspaceKeys = objectKeys(workspace.data);
    const personalKeys = objectKeys(personal.data);
    for (const excludedField of Object.keys(V2_CONFIG_EXCLUSIONS)) {
      expect(workspaceKeys.has(excludedField)).toBe(false);
      expect(personalKeys.has(excludedField)).toBe(false);
    }
  });

  it("validates both completed envelopes with their v2 schemas", async () => {
    const workspace = await freshRepository().exportWorkspaceConfig("workspace-disc-id");
    const personal = await freshRepository().exportPersonalConfig("user-disc-id");

    expect(workspace.success).toBe(true);
    expect(personal.success).toBe(true);
    if (!workspace.success || !workspace.data || !personal.success || !personal.data) return;

    expect(workspaceConfigExportSchema.safeParse(workspace.data).success).toBe(true);
    expect(personalConfigExportSchema.safeParse(personal.data).success).toBe(true);
  });

  it("uses a configuration-only read path without composite data", async () => {
    const result = await freshRepository().exportWorkspaceConfig("workspace-disc-id");

    expect(result.success).toBe(true);
    expect(queryLog).toHaveLength(2);
    expect(queryLog.join("\n")).not.toContain("FROM personas");
    expect(queryLog.join("\n")).not.toContain("FROM server_memories");
    expect(queryLog.join("\n")).not.toContain("FROM personal_memories");
    expect(queryLog.join("\n")).toContain("LEFT JOIN server_stm_configs");
    expect(queryLog.join("\n")).toContain("FROM stm_categories");
  });

  it("tolerates jsonb columns that hold a JSON string instead of the value", async () => {
    // Both columns really are string-typed in deployed data: an older writer handed the driver a value it encoded a
    // second time, so jsonb_typeof is 'string' and the driver returns that string. The export must still produce the
    // record and array shapes its own schema promises, because the bot reads those same rows without complaint.
    const originalTriggers = workspaceRow.deliberate_tool_triggers;
    const originalBiases = workspaceRow.llm_logit_biases;
    workspaceRow.deliberate_tool_triggers = JSON.stringify(originalTriggers);
    workspaceRow.llm_logit_biases = JSON.stringify(originalBiases);

    try {
      const result = await freshRepository().exportWorkspaceConfig("workspace-disc-id");

      expect(result.success).toBe(true);
      if (!result.success || !result.data || result.data.type !== "workspace_config") return;
      expect(result.data.data.triggers?.deliberate_tool_triggers).toEqual({ memory: ["remember this"] });
      expect(result.data.data.chat?.llm_logit_biases).toEqual([
        { id: "bias-1", kind: "text", text: "hello", value: 2, tokenizations: [] },
      ]);
    } finally {
      workspaceRow.deliberate_tool_triggers = originalTriggers;
      workspaceRow.llm_logit_biases = originalBiases;
    }
  });

  it("round-trips a complete workspace projection without schema changes", async () => {
    const result = await freshRepository().exportWorkspaceConfig("workspace-disc-id");

    expect(result.success).toBe(true);
    if (!result.success || !result.data) return;

    const parsed = workspaceConfigExportSchema.parse(result.data);
    expect(parsed).toEqual(result.data);
    expect(parsed.data.chat?.llm_logit_biases).toEqual([
      { id: "bias-1", kind: "text", text: "hello", value: 2, tokenizations: [] },
    ]);
    expect(parsed.data.triggers?.deliberate_tool_triggers).toEqual({ memory: ["remember this"] });
    expect(parsed.data.memory?.stm_config).toEqual({
      refresh_cadence: 5,
      render_mode: "supersede",
      crude_message_count: 10,
      tool_description_override: null,
      update_nudge_override: null,
      nudge_injection_depth: 1,
      content_injection_depth: 2,
    });
  });
});
