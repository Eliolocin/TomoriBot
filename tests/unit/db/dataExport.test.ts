import { describe, expect, it } from "bun:test";
import {
  EXPORT_VERSION,
  EXPORT_V2_VERSION,
  V1_CONFIG_FIELD_SECTION_OVERRIDES,
  V1_CONFIG_TABLE_SCHEMAS,
  V1_CONFIG_TABLE_SECTION_OWNERSHIP,
  V2_CONFIG_EXCLUSIONS,
  V2_CONFIG_SECTION_SCHEMAS,
  adaptV1PersonalConfig,
  adaptV1PersonalMemories,
  adaptV1WorkspaceConfig,
  adaptV1WorkspaceMemories,
  areMemoryItemsEqual,
  getServerExportSchema,
  memoryItemSchema,
  parseExportFile,
  personalConfigExportSchema,
  serverConfigExportSchema,
  workspaceConfigExportSchema,
  workspaceMemoriesExportSchema,
} from "@/types/db/dataExport";
import { getMemoryLimits } from "@/utils/misc/memoryLimits";

function fullWorkspaceConfig(): Record<string, unknown> {
  return {
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
    system_prompt: "A portable prompt",
    cascade_limit: 3,
    match_limit: 4,
    send_message_limit: 5,
    context_note: "A context note",
    context_note_depth: 6,
    self_debug_enabled: true,
    model_randomizer_enabled: false,
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
    voice_transcript_chat_mode: true,
    chatterbox_turbo_enabled: false,
    chatterbox_cfg_weight: 1.2,
    chatterbox_exaggeration: 0.8,
    stm_privacy_bypass: true,
    always_reply_enabled: true,
    deliberate_trigger_mode: false,
    deliberate_tool_mode: true,
    deliberate_tool_context_turns: 2,
    deliberate_tool_triggers: { memory: ["remember this"] },
    cooldown_type: 1,
    cooldown_length: 30,
    image_default_positive_tags: ["portrait"],
    image_default_negative_tags: ["blurry"],
    nai_sampler: "karras",
    nai_steps: 28,
    nai_scale: 6,
    nai_noise_schedule: "native",
    nai_cfg_rescale: 0.3,
    nai_preset_name: "source-only",
    user_byok_mode: false,
    memory_tagging_enabled: true,
    channel_memory_enabled: true,
    welcome_prompt: "Welcome",
    stm_config: {
      refresh_cadence: 5,
      render_mode: "supersede",
      crude_message_count: 10,
      tool_description_override: null,
      update_nudge_override: null,
      nudge_injection_depth: 1,
      content_injection_depth: 2,
    },
    stm_categories: [{ position: 0, label: "Facts", description: "Known facts" }],
  };
}

function validChatSection(): Record<string, unknown> {
  return {
    llm_temperature: 0.7,
    llm_logit_biases: [],
    humanizer_degree: 1,
    timezone_offset: 8,
  };
}

describe("portable jsonb column tolerance", () => {
  it("reads a jsonb value that arrives as a JSON string", () => {
    const parsed = workspaceConfigExportSchema.safeParse({
      version: EXPORT_V2_VERSION,
      type: "workspace_config",
      exported_at: "2026-01-01T00:00:00.000Z",
      data: {
        chat: { ...validChatSection(), llm_logit_biases: "[]" },
        triggers: { deliberate_tool_triggers: JSON.stringify({ memory: ["remember this"] }) },
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.data.triggers?.deliberate_tool_triggers).toEqual({ memory: ["remember this"] });
    expect(parsed.data.data.chat?.llm_logit_biases).toEqual([]);
  });

  it("reports a malformed string at its own path instead of throwing out of the parse", () => {
    const parsed = workspaceConfigExportSchema.safeParse({
      version: EXPORT_V2_VERSION,
      type: "workspace_config",
      exported_at: "2026-01-01T00:00:00.000Z",
      data: {
        chat: { ...validChatSection(), llm_logit_biases: "not json" },
        triggers: { deliberate_tool_triggers: "{not json" },
      },
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.path.join(".")).sort()).toEqual([
      "data.chat.llm_logit_biases",
      "data.triggers.deliberate_tool_triggers",
    ]);
  });
});

describe("v1 export characterization", () => {
  it("normalizes string and object memory items exactly as the v1 schema does", () => {
    expect(memoryItemSchema.parse("  plain memory  ")).toEqual({ content: "  plain memory  ", tags: [] });
    expect(
      memoryItemSchema.parse({
        content: "tagged memory",
        tags: ["'one'", '"two"', "three"],
      }),
    ).toEqual({ content: "tagged memory", tags: ["one", "two", "three"] });
  });

  it("keeps v1 tag limits and parses a representative complete v1 workspace file", () => {
    expect(memoryItemSchema.safeParse({ content: "too many tags", tags: ["1", "2", "3", "4", "5", "6"] }).success).toBe(
      false,
    );
    expect(memoryItemSchema.safeParse({ content: "long tag", tags: ["x".repeat(33)] }).success).toBe(false);

    const file = getServerExportSchema().safeParse({
      version: EXPORT_VERSION,
      type: "server",
      exported_at: "2026-01-01T00:00:00.000Z",
      data: {
        config: fullWorkspaceConfig(),
        server_memories: ["legacy memory", { content: "tagged", tags: ["'portable'"] }],
      },
    });

    expect(file.success).toBe(true);
    if (!file.success) return;
    expect(file.data.data.config.llm_temperature).toBe(0.7);
    expect(file.data.data.server_memories).toEqual([
      { content: "legacy memory", tags: [] },
      { content: "tagged", tags: ["portable"] },
    ]);
  });
});

describe("v2 section semantics", () => {
  it("keeps an omitted section distinct from a present section with defaults", () => {
    const omitted = workspaceConfigExportSchema.parse({
      version: EXPORT_V2_VERSION,
      type: "workspace_config",
      exported_at: "2026-01-01T00:00:00.000Z",
      data: {},
    });
    const present = workspaceConfigExportSchema.parse({
      version: EXPORT_V2_VERSION,
      type: "workspace_config",
      exported_at: "2026-01-01T00:00:00.000Z",
      data: { chat: validChatSection() },
    });

    expect(Object.hasOwn(omitted.data, "chat")).toBe(false);
    expect(Object.hasOwn(present.data, "chat")).toBe(true);
    expect(present.data.chat?.llm_top_p).toBe(0.95);
  });

  it("covers every v1 table field exactly once or records it as excluded", () => {
    const expected = new Set<string>();
    const expectedExcluded = new Set<string>();
    let expectedClaimCount = 0;
    for (const [tableName, schema] of Object.entries(V1_CONFIG_TABLE_SCHEMAS)) {
      const table = tableName as keyof typeof V1_CONFIG_TABLE_SCHEMAS;
      const defaultSection = V1_CONFIG_TABLE_SECTION_OWNERSHIP[table];
      const overrides = (
        V1_CONFIG_FIELD_SECTION_OVERRIDES as Partial<
          Record<keyof typeof V1_CONFIG_TABLE_SCHEMAS, Readonly<Record<string, string | null>>>
        >
      )[table];

      for (const field of Object.keys(schema.shape)) {
        const section = overrides && Object.hasOwn(overrides, field) ? overrides[field] : defaultSection;
        if (section) {
          expected.add(`${section}.${field}`);
          expectedClaimCount++;
        } else {
          expectedExcluded.add(field);
        }
      }
    }

    const actual = new Set<string>();
    for (const [section, schema] of Object.entries(V2_CONFIG_SECTION_SCHEMAS)) {
      for (const field of Object.keys(schema.shape)) actual.add(`${section}.${field}`);
    }

    const excluded = new Set(Object.keys(V2_CONFIG_EXCLUSIONS));
    const sourceFields = new Set<string>();
    for (const [tableName, schema] of Object.entries(V1_CONFIG_TABLE_SCHEMAS)) {
      for (const field of Object.keys(schema.shape)) sourceFields.add(`${tableName}.${field}`);
    }

    expect(excluded).toEqual(expectedExcluded);
    expect(actual).toEqual(expected);
    expect(expectedClaimCount).toBe(actual.size);
    expect(sourceFields.size).toBe(expectedClaimCount + expectedExcluded.size);
  });
});

describe("v2 discriminator and strictness", () => {
  it("rejects malformed discriminators without sniffing data keys", () => {
    expect(
      parseExportFile({
        version: EXPORT_V2_VERSION,
        data: { chat: validChatSection() },
      }).success,
    ).toBe(false);
    expect(
      parseExportFile({
        version: EXPORT_V2_VERSION,
        type: "server_config",
        data: { chat: validChatSection() },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown sections and unknown fields", () => {
    const unknownSection = parseExportFile({
      version: EXPORT_V2_VERSION,
      type: "workspace_config",
      exported_at: "2026-01-01T00:00:00.000Z",
      data: { unknown_section: {} },
    });
    const unknownField = parseExportFile({
      version: EXPORT_V2_VERSION,
      type: "workspace_config",
      exported_at: "2026-01-01T00:00:00.000Z",
      data: { chat: { ...validChatSection(), unknown_field: true } },
    });

    expect(unknownSection.success).toBe(false);
    expect(unknownField.success).toBe(false);
    if (!unknownSection.success && !unknownField.success) {
      expect(unknownSection.error).toContain("unknown_section");
      expect(unknownField.error).toContain("unknown_field");
    }
  });
});

describe("v1 adaptation", () => {
  it("maps a populated v1 workspace config and names both dropped workspace fields", () => {
    const result = adaptV1WorkspaceConfig(fullWorkspaceConfig());
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.detectedSections).toEqual([
      "chat",
      "triggers",
      "capabilities",
      "memory",
      "media",
      "speech",
      "access",
    ]);
    expect(result.payload.chat?.welcome_prompt).toBe("Welcome");
    expect(result.payload.capabilities?.self_debug_enabled).toBe(true);
    expect(result.payload.capabilities?.tool_notice_hidden_keys).toEqual(["web_search"]);
    expect(result.payload.memory?.stm_categories).toEqual([
      { position: 0, label: "Facts", description: "Known facts" },
    ]);
    expect(result.payload.media).not.toHaveProperty("nai_preset_name");
    expect(result.droppedFields).toEqual(["model_randomizer_enabled", "nai_preset_name"]);
  });

  it("maps personal settings across sections and names both dropped personal fields", () => {
    const result = adaptV1PersonalConfig({
      user_nickname: "Jordan",
      language_pref: "en-US",
      impersonation_prompt: "Use first person",
      physical_appearance_tags: ["short hair"],
      nai_char_ref_url: "https://source.invalid/ref.png",
      privacy_level: 1,
      personal_dtm: "follow",
      personal_deliberate_tool_mode: "on",
      shortterm_cache_crossserver_opt_in: true,
      timezone_offset: 8,
      prefix_override: "Captain",
      suffix_override: null,
      gender_identity: "neutral",
      pronouns: "they/them",
      addressing_style: "neutral",
      persona_naming_preferences: [
        { persona_lineage_id: 12, nickname_override: "J", prefix_override: null, suffix_override: null },
      ],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.detectedSections).toEqual(["profile", "privacy", "appearance", "response_modes"]);
    expect(result.payload.profile?.user_nickname).toBe("Jordan");
    expect(result.payload.privacy?.privacy_level).toBe(1);
    expect(result.payload.appearance?.physical_appearance_tags).toEqual(["short hair"]);
    expect(result.payload.response_modes?.personal_deliberate_tool_mode).toBe("on");
    expect(result.payload).not.toHaveProperty("nai_char_ref_url");
    expect(result.droppedFields).toEqual(["nai_char_ref_url", "persona_naming_preferences"]);
  });

  it("adapts each v1 single-scope memory format into a named bucket", () => {
    const personal = adaptV1PersonalMemories({ personal_memories: ["one"] });
    const workspace = adaptV1WorkspaceMemories({ server_memories: [{ content: "two", tags: ["'tag'"] }] });

    expect(personal.success).toBe(true);
    expect(workspace.success).toBe(true);
    if (!personal.success || !workspace.success) return;
    expect(personal.payload.buckets).toEqual([
      { name: "personal", label: "personal", memories: [{ content: "one", tags: [] }] },
    ]);
    expect(workspace.payload.buckets).toEqual([
      { name: "workspace", label: "workspace", memories: [{ content: "two", tags: ["tag"] }] },
    ]);
  });

  it("parses a complete v1 file into a normalized composite payload without writing", () => {
    const result = parseExportFile({
      version: EXPORT_VERSION,
      type: "server",
      exported_at: "2026-01-01T00:00:00.000Z",
      data: {
        config: fullWorkspaceConfig(),
        server_memories: ["legacy memory"],
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.sourceType).toBe("server");
    expect(result.detectedSections).toContain("config.capabilities");
    expect(result.detectedSections).toContain("bucket:workspace");
    expect(result.droppedFields).toEqual(["model_randomizer_enabled", "nai_preset_name"]);
  });
});

describe("v2 memory bundles", () => {
  it("rejects oversized memory arrays and internal identifiers", () => {
    const oversized = workspaceMemoriesExportSchema.safeParse({
      version: EXPORT_V2_VERSION,
      type: "workspace_memories",
      exported_at: "2026-01-01T00:00:00.000Z",
      data: {
        buckets: [
          {
            name: "workspace",
            label: "Workspace",
            memories: Array.from({ length: getMemoryLimits().maxServerMemories + 1 }, () => "memory"),
          },
        ],
      },
    });
    expect(oversized.success).toBe(false);

    const bucketId = workspaceMemoriesExportSchema.safeParse({
      version: EXPORT_V2_VERSION,
      type: "workspace_memories",
      exported_at: "2026-01-01T00:00:00.000Z",
      data: { buckets: [{ name: "workspace", label: "Workspace", id: 42, memories: [] }] },
    });
    expect(bucketId.success).toBe(false);

    const memoryId = workspaceMemoriesExportSchema.safeParse({
      version: EXPORT_V2_VERSION,
      type: "workspace_memories",
      exported_at: "2026-01-01T00:00:00.000Z",
      data: {
        buckets: [
          { name: "workspace", label: "Workspace", memories: [{ content: "memory", tags: [], server_memory_id: 42 }] },
        ],
      },
    });
    expect(memoryId.success).toBe(false);
  });

  it("accepts one full bucket per workspace persona lineage", () => {
    const fullBucket = Array.from({ length: getMemoryLimits().maxServerMemories }, () => "memory");
    const result = workspaceMemoriesExportSchema.safeParse({
      version: EXPORT_V2_VERSION,
      type: "workspace_memories",
      exported_at: "2026-01-01T00:00:00.000Z",
      data: {
        buckets: [
          { name: "persona-1", label: "Persona 1", memories: fullBucket },
          { name: "persona-2", label: "Persona 2", memories: fullBucket },
          { name: "persona-3", label: "Persona 3", memories: fullBucket },
        ],
      },
    });

    expect(result.success).toBe(true);
  });

  it("compares normalized content and tag sets", () => {
    expect(
      areMemoryItemsEqual(
        { content: "  hello\nworld  ", tags: ["'red'", "blue", "red"] },
        { content: "hello world", tags: [" blue ", "red"] },
      ),
    ).toBe(true);
    expect(areMemoryItemsEqual({ content: "hello", tags: ["red"] }, { content: "hello", tags: ["green"] })).toBe(false);
  });

  it("parses a v2 memory file through the explicit file entry point", () => {
    const result = parseExportFile({
      version: EXPORT_V2_VERSION,
      type: "personal_memories",
      exported_at: "2026-01-01T00:00:00.000Z",
      data: { buckets: [{ name: "core", label: "Core", memories: ["memory"] }] },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.detectedSections).toEqual(["core"]);
    expect(result.droppedFields).toEqual([]);
  });
});

describe("v2 schema exports", () => {
  it("keeps v1 and v2 config schemas independently usable", () => {
    expect(serverConfigExportSchema.safeParse(validChatSection()).success).toBe(true);
    expect(
      personalConfigExportSchema.safeParse({
        version: EXPORT_V2_VERSION,
        type: "personal_config",
        exported_at: "2026-01-01T00:00:00.000Z",
        data: {},
      }).success,
    ).toBe(true);
  });
});
