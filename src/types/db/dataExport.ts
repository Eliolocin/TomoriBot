import { z } from "zod";
import { SUPPORTED_PARAM_VALUES } from "@/constants/supportedParams";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_VALUES } from "@/constants/thinkingLevels";
import { getMemoryLimits } from "@/utils/misc/memoryLimits";
import { logitBiasEntrySchema } from "@/types/provider/logitBias";
import { PrivacyLevel, deliberateToolTriggerEntrySchema } from "@/types/db/schema";
import { addressingStyleSchema } from "@/types/personaNaming";

/**
 * Version identifier for export/import format
 * Increment when breaking changes are made to the export format
 */
export const EXPORT_VERSION = "1.0";

/**
 * Explicit file type identifiers for /data export and /data import.
 * These map directly to user-facing export/delete choices.
 */
const DATA_EXPORT_TYPES = {
  personal_memories: "personal_memories",
  server_memories: "server_memories",
  personal_settings: "personal_settings",
  server_config: "server_config",
  global_personal_memories: "global_personal_memories",
  legacy_personal: "personal",
  legacy_server: "server",
} as const;
/**
 * A single memory entry. Accepts plain strings (legacy exports) or tagged objects;
 * both forms normalise to { content, tags } on parse.
 */
const memoryItemSchema = z.union([
  z.string().transform((s) => ({ content: s, tags: [] as string[] })),
  z.object({
    content: z.string(),
    tags: z.preprocess(
      (v) =>
        Array.isArray(v) ? v.map((t: unknown) => (typeof t === "string" ? t.replace(/^["']+|["']+$/g, "") : t)) : [],
      z.array(z.string().max(32)).max(5),
    ),
  }),
]);

export type MemoryItem = { content: string; tags: string[] };

/**
 * Get personal data export schema with dynamic memory limits from environment
 * Validates the structure of exported personal user data
 */
function getPersonalExportDataSchema() {
  const limits = getMemoryLimits();
  return z.object({
    user_nickname: z.string().min(1).max(100).nullable(),
    language_pref: z.string().min(2).max(10),
    impersonation_prompt: z.string().nullable().optional(),
    personal_memories: z.array(memoryItemSchema).max(limits.maxPersonalMemories),
  });
}

export type PersonalExportData = z.infer<ReturnType<typeof getPersonalExportDataSchema>>;

/**
 * Personal settings-only export schema.
 * Includes user-specific physical appearance image tags and NovelAI reference image URL.
 */
export const personalSettingsExportDataSchema = z.object({
  user_nickname: z.string().min(1).max(100).nullable(),
  language_pref: z.string().min(2).max(10),
  impersonation_prompt: z.string().nullable().optional(),
  physical_appearance_tags: z.array(z.string()).default([]),
  nai_char_ref_url: z.string().nullable().optional(),
  privacy_level: z.nativeEnum(PrivacyLevel).optional(),
  personal_dtm: z.enum(["off", "follow", "on"]).optional(),
  personal_deliberate_tool_mode: z.enum(["off", "follow", "on"]).optional(),
  shortterm_cache_crossserver_opt_in: z.boolean().optional(),
  timezone_offset: z.number().int().min(-12).max(14).nullable().optional(),
  prefix_override: z.string().max(100).nullable().optional(),
  suffix_override: z.string().max(100).nullable().optional(),
  gender_identity: z.string().max(200).nullable().optional(),
  pronouns: z.string().max(200).nullable().optional(),
  addressing_style: addressingStyleSchema.nullable().optional(),
  persona_naming_preferences: z
    .array(
      z.object({
        persona_lineage_id: z.number().int().nonnegative(),
        nickname_override: z.string().max(100).nullable(),
        prefix_override: z.string().max(100).nullable(),
        suffix_override: z.string().max(100).nullable(),
      }),
    )
    .default([]),
});

export type PersonalSettingsExportData = z.infer<typeof personalSettingsExportDataSchema>;

/**
 * Persona-scoped personal memories-only export schema.
 */
function getPersonalMemoriesExportDataSchema() {
  const limits = getMemoryLimits();
  return z.object({
    personal_memories: z.array(memoryItemSchema).max(limits.maxPersonalMemories),
  });
}

export type PersonalMemoriesExportData = z.infer<ReturnType<typeof getPersonalMemoriesExportDataSchema>>;

/**
 * Get complete personal export file schema with dynamic limits
 */
export function getPersonalExportSchema() {
  return z.object({
    version: z.literal(EXPORT_VERSION),
    type: z.literal("personal"),
    exported_at: z.string(),
    data: getPersonalExportDataSchema(),
  });
}

export type PersonalExport = z.infer<ReturnType<typeof getPersonalExportSchema>>;

/**
 * Portable server_model_configs export fields.
 * Excludes model-selection FKs and encrypted credential mirrors.
 */
const serverModelConfigExportSchema = z.object({
  llm_temperature: z.number().min(0.0).max(2.0),
  thinking_level: z.enum(THINKING_LEVEL_VALUES).default(DEFAULT_THINKING_LEVEL),
  llm_disabled_params: z.array(z.enum(SUPPORTED_PARAM_VALUES)).default([]),
});

/**
 * Portable server_chat_configs export fields.
 * Excludes provider/model fallback refs because they are server-specific model pointers.
 */
const serverChatConfigExportSchema = z.object({
  llm_top_p: z.number().min(0.0).max(1.0).default(0.95),
  llm_top_k: z.number().int().min(0).max(40).default(0),
  llm_frequency_penalty: z.number().min(-2.0).max(2.0).default(0.0),
  llm_presence_penalty: z.number().min(-2.0).max(2.0).default(0.0),
  llm_min_p: z.number().min(0.0).max(1.0).default(0.05),
  llm_max_output_tokens: z.number().int().min(1).nullable().optional(),
  llm_logit_biases: z.preprocess(
    (val) => (typeof val === "string" ? JSON.parse(val) : val),
    z.array(logitBiasEntrySchema).default([]),
  ),
  llm_stop_strings: z.array(z.string()).default([]),
  llm_stop_speaker_pattern_enabled: z.boolean().default(false),
  humanizer_degree: z.number().int().min(0).max(3),
  timezone_offset: z.number().int().min(-12).max(14),
  message_fetch_limit: z.number().int().min(20).max(100).default(80),
  system_prompt: z.string().nullable().default(null),
  cascade_limit: z.number().int().min(0).max(10).optional(),
  match_limit: z.number().int().min(1).max(10).optional(),
  send_message_limit: z.number().int().min(0).max(40).optional(),
  context_note: z.string().nullable().optional(),
  context_note_depth: z.number().int().min(0).max(100).optional(),
  self_debug_enabled: z.boolean().default(false),
  model_randomizer_enabled: z.boolean().default(false),
});

/** Portable server_member_permissions_configs export fields. */
const serverMemberPermissionsConfigExportSchema = z.object({
  server_memteaching_enabled: z.boolean().default(false),
  attribute_memteaching_enabled: z.boolean().default(false),
  sampledialogue_memteaching_enabled: z.boolean().default(false),
  self_teaching_enabled: z.boolean().default(true),
  personal_memories_enabled: z.boolean().default(true),
  prompt_snapshot_enabled: z.boolean().optional(),
});

/** Portable server_capabilities_configs export fields. */
const serverCapabilitiesConfigExportSchema = z.object({
  web_search_enabled: z.boolean().default(true),
  emoji_usage_enabled: z.boolean().default(true),
  sticker_usage_enabled: z.boolean().default(true),
  imagegen_enabled: z.boolean().default(true),
  manage_message_enabled: z.boolean().optional(),
  videogen_enabled: z.boolean().optional(),
  voice_message_enabled: z.boolean().optional(),
  thread_creation_enabled: z.boolean().optional(),
  user_blocking_enabled: z.boolean().optional(),
  time_awareness_enabled: z.boolean().optional(),
  tool_use_enabled: z.boolean().optional(),
  short_term_memory_enabled: z.boolean().optional(),
  verbatim_tool_calling_enabled: z.boolean().optional(),
  user_info_updates_enabled: z.boolean().default(true),
});

/** Portable server_notice_embeds_configs export fields. */
const serverNoticeEmbedsConfigExportSchema = z.object({
  tool_notice_hidden_keys: z.array(z.string()).default([]),
});

/** Portable server_nsfw_configs export fields. */
const serverNsfwConfigExportSchema = z.object({
  uncensor_injection_enabled: z.boolean().optional(),
  uncensor_unicode_space_enabled: z.boolean().optional(),
  uncensor_sanitize_enabled: z.boolean().optional(),
});

/** Portable server_speech_configs export fields. */
const serverSpeechConfigExportSchema = z.object({
  voice_transcript_chat_mode: z.boolean().optional(),
  chatterbox_turbo_enabled: z.boolean().optional(),
  chatterbox_cfg_weight: z.number().min(0.0).optional(),
  chatterbox_exaggeration: z.number().min(0.0).optional(),
});

/**
 * Portable server_channel_scope_configs export fields.
 * Discord channel IDs remain excluded because they are not portable.
 */
const serverChannelScopeConfigExportSchema = z.object({
  stm_privacy_bypass: z.boolean().optional(),
});

/**
 * server_auto_trigger_configs currently has no portable export fields.
 * Channel IDs, persona overrides, and channel-coupled thresholds are server-specific.
 */
const serverAutoTriggerConfigExportSchema = z.object({});

/** Portable server_trigger_behavior_configs export fields. */
const serverTriggerBehaviorConfigExportSchema = z.object({
  always_reply_enabled: z.boolean().optional(),
  deliberate_trigger_mode: z.boolean().optional(),
  deliberate_tool_mode: z.boolean().optional(), // Added May 2026
  deliberate_tool_context_turns: z.number().int().min(0).max(10).nullable().optional(), // Added May 2026
  deliberate_tool_triggers: z.record(z.string(), z.array(deliberateToolTriggerEntrySchema)).optional(), // Added May 2026 - keyed by tool target, values are literal strings or {type, value} entries (regex). Shared schema with DB row to prevent drift.
  cooldown_type: z.number().int().min(0).max(4).optional(),
  cooldown_length: z.number().int().min(1).max(86400).optional(),
});

/**
 * Portable server_novelai_imagegen_configs export fields.
 * Excludes model-selection FKs.
 */
const serverNovelaiImagegenConfigExportSchema = z.object({
  image_default_positive_tags: z.array(z.string()).optional(),
  image_default_negative_tags: z.array(z.string()).optional(),
  nai_sampler: z.string().nullable().optional(),
  nai_steps: z.number().int().min(1).max(50).nullable().optional(),
  nai_scale: z.number().min(0.0).max(10.0).nullable().optional(),
  nai_noise_schedule: z.string().nullable().optional(),
  nai_cfg_rescale: z.number().min(0.0).max(1.0).nullable().optional(),
  nai_preset_name: z.string().nullable().optional(),
});

/** Portable server_byok_configs export fields. */
const serverByokConfigExportSchema = z.object({
  user_byok_mode: z.boolean().optional(),
});

/** Portable server_memory_configs export fields. */
const serverMemoryConfigExportSchema = z.object({
  memory_tagging_enabled: z.boolean().optional(),
  channel_memory_enabled: z.boolean().optional(),
});

/**
 * Portable server_welcome_configs export fields.
 * Discord channel/persona references remain excluded.
 */
const serverWelcomeConfigExportSchema = z.object({
  welcome_prompt: z.string().nullable().optional(),
});

/**
 * Portable STM customization export fields (server_stm_configs + stm_categories).
 * Unlike the flat split-config tables, STM travels as a nested config object plus an
 * ordered categories array: these mirror ShortTermMemoryRepository's export shape.
 * Both keys are optional so exports predating STM customization still validate.
 * Per-channel durable STM *state* is intentionally NOT exported (design decision 8).
 */
const serverStmConfigExportSchema = z.object({
  stm_config: z
    .object({
      refresh_cadence: z.number().int(),
      render_mode: z.enum(["supersede", "crude_summary"]),
      crude_message_count: z.number().int(),
      tool_description_override: z.string().nullable(),
      update_nudge_override: z.string().nullable(),
      nudge_injection_depth: z.number().int().optional(),
      content_injection_depth: z.number().int().optional(),
    })
    .nullable()
    .optional(),
  stm_categories: z
    .array(
      z.object({
        position: z.number().int().min(0).max(4),
        label: z.string(),
        description: z.string(),
      }),
    )
    .optional(),
});

/**
 * Server configuration export schema.
 * Flat JSON shape is preserved for existing export/import file compatibility,
 * but the schema is now composed by split config-table ownership.
 */
const serverConfigExportSchema = serverModelConfigExportSchema
  .merge(serverChatConfigExportSchema)
  .merge(serverMemberPermissionsConfigExportSchema)
  .merge(serverCapabilitiesConfigExportSchema)
  .merge(serverNoticeEmbedsConfigExportSchema)
  .merge(serverNsfwConfigExportSchema)
  .merge(serverSpeechConfigExportSchema)
  .merge(serverAutoTriggerConfigExportSchema)
  .merge(serverChannelScopeConfigExportSchema)
  .merge(serverTriggerBehaviorConfigExportSchema)
  .merge(serverNovelaiImagegenConfigExportSchema)
  .merge(serverByokConfigExportSchema)
  .merge(serverMemoryConfigExportSchema)
  .merge(serverWelcomeConfigExportSchema)
  .merge(serverStmConfigExportSchema);

export type ServerConfigExport = z.infer<typeof serverConfigExportSchema>;

/**
 * Persona-scoped server memories-only export schema.
 */
function getServerMemoriesExportDataSchema() {
  const limits = getMemoryLimits();
  return z.object({
    server_memories: z.array(memoryItemSchema).max(limits.maxServerMemories),
  });
}

export type ServerMemoriesExportData = z.infer<ReturnType<typeof getServerMemoriesExportDataSchema>>;

/**
 * Server config-only export schema.
 */
const serverConfigOnlyExportDataSchema = z.object({
  config: serverConfigExportSchema,
});

export type ServerConfigOnlyExportData = z.infer<typeof serverConfigOnlyExportDataSchema>;

/**
 * Get server data export schema with dynamic memory limits from environment
 * Includes configuration and server memories
 */
function getServerExportDataSchema() {
  const limits = getMemoryLimits();
  return z.object({
    config: serverConfigExportSchema,
    server_memories: z.array(memoryItemSchema).max(limits.maxServerMemories),
  });
}

export type ServerExportData = z.infer<ReturnType<typeof getServerExportDataSchema>>;

/**
 * Get complete server export file schema with dynamic limits
 */
export function getServerExportSchema() {
  return z.object({
    version: z.literal(EXPORT_VERSION),
    type: z.literal("server"),
    exported_at: z.string(),
    data: getServerExportDataSchema(),
  });
}

export type ServerExport = z.infer<ReturnType<typeof getServerExportSchema>>;

/**
 * New explicit export formats used by /data command.
 */
export const personalMemoriesExportSchema = z.object({
  version: z.literal(EXPORT_VERSION),
  type: z.literal(DATA_EXPORT_TYPES.personal_memories),
  exported_at: z.string(),
  data: getPersonalMemoriesExportDataSchema(),
});

export type PersonalMemoriesExport = z.infer<typeof personalMemoriesExportSchema>;

export const globalPersonalMemoriesExportSchema = z.object({
  version: z.literal(EXPORT_VERSION),
  type: z.literal(DATA_EXPORT_TYPES.global_personal_memories),
  exported_at: z.string(),
  data: getPersonalMemoriesExportDataSchema(),
});

export type GlobalPersonalMemoriesExport = z.infer<typeof globalPersonalMemoriesExportSchema>;

export const personalSettingsExportSchema = z.object({
  version: z.literal(EXPORT_VERSION),
  type: z.literal(DATA_EXPORT_TYPES.personal_settings),
  exported_at: z.string(),
  data: personalSettingsExportDataSchema,
});

export type PersonalSettingsExport = z.infer<typeof personalSettingsExportSchema>;

export const serverMemoriesExportSchema = z.object({
  version: z.literal(EXPORT_VERSION),
  type: z.literal(DATA_EXPORT_TYPES.server_memories),
  exported_at: z.string(),
  data: getServerMemoriesExportDataSchema(),
});

export type ServerMemoriesExport = z.infer<typeof serverMemoriesExportSchema>;

export const serverConfigOnlyExportSchema = z.object({
  version: z.literal(EXPORT_VERSION),
  type: z.literal(DATA_EXPORT_TYPES.server_config),
  exported_at: z.string(),
  data: serverConfigOnlyExportDataSchema,
});

export type ServerConfigOnlyExport = z.infer<typeof serverConfigOnlyExportSchema>;

/**
 * Union type for all export formats
 */
type DataExport =
  | PersonalMemoriesExport
  | ServerMemoriesExport
  | PersonalSettingsExport
  | ServerConfigOnlyExport
  | GlobalPersonalMemoriesExport
  | PersonalExport
  | ServerExport;

/**
 * Result of export operation
 */
export interface ExportResult {
  success: boolean;
  data?: DataExport;
  error?: string;
}

/**
 * Result of personality text export operation
 */
export interface PersonalityExportResult {
  success: boolean;
  text?: string;
  error?: string;
}

/**
 * Result of import operation
 */
export interface ImportResult {
  success: boolean;
  itemsImported?: {
    memoriesCount?: number;
    configFieldsCount?: number;
  };
  error?: string;
}
