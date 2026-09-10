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
export const EXPORT_V2_VERSION = "2.0";

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
const memoryItemObjectSchema = z.object({
  content: z.string(),
  tags: z.preprocess(
    (v) =>
      Array.isArray(v) ? v.map((t: unknown) => (typeof t === "string" ? t.replace(/^["']+|["']+$/g, "") : t)) : [],
    z.array(z.string().max(32)).max(5),
  ),
});

const memoryStringSchema = z.string().transform((s) => ({ content: s, tags: [] as string[] }));

export const memoryItemSchema = z.union([memoryStringSchema, memoryItemObjectSchema]);

const strictMemoryItemSchema = z.union([memoryStringSchema, memoryItemObjectSchema.strict()]);

export type MemoryItem = { content: string; tags: string[] };

function normalizeMemoryWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

/** Canonicalizes memory values so merge can compare content and unordered tags. */
export function normalizeMemoryItem(memory: MemoryItem): MemoryItem {
  const tags = new Set(memory.tags.map((tag) => normalizeMemoryWhitespace(tag.replace(/^["']+|["']+$/g, ""))));

  return {
    content: normalizeMemoryWhitespace(memory.content),
    tags: [...tags].sort(),
  };
}

export function areMemoryItemsEqual(left: MemoryItem, right: MemoryItem): boolean {
  const normalizedLeft = normalizeMemoryItem(left);
  const normalizedRight = normalizeMemoryItem(right);
  return (
    normalizedLeft.content === normalizedRight.content &&
    normalizedLeft.tags.join("\u0000") === normalizedRight.tags.join("\u0000")
  );
}

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
export const serverModelConfigExportSchema = z.object({
  llm_temperature: z.number().min(0.0).max(2.0),
  thinking_level: z.enum(THINKING_LEVEL_VALUES).default(DEFAULT_THINKING_LEVEL),
  llm_disabled_params: z.array(z.enum(SUPPORTED_PARAM_VALUES)).default([]),
});

/**
 * Portable server_chat_configs export fields.
 * Excludes provider/model fallback refs because they are server-specific model pointers.
 */
export const serverChatConfigExportSchema = z.object({
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
export const serverMemberPermissionsConfigExportSchema = z.object({
  server_memteaching_enabled: z.boolean().default(false),
  attribute_memteaching_enabled: z.boolean().default(false),
  sampledialogue_memteaching_enabled: z.boolean().default(false),
  self_teaching_enabled: z.boolean().default(true),
  personal_memories_enabled: z.boolean().default(true),
  prompt_snapshot_enabled: z.boolean().optional(),
});

/** Portable server_capabilities_configs export fields. */
export const serverCapabilitiesConfigExportSchema = z.object({
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
export const serverNoticeEmbedsConfigExportSchema = z.object({
  tool_notice_hidden_keys: z.array(z.string()).default([]),
});

/** Portable server_nsfw_configs export fields. */
export const serverNsfwConfigExportSchema = z.object({
  uncensor_injection_enabled: z.boolean().optional(),
  uncensor_unicode_space_enabled: z.boolean().optional(),
  uncensor_sanitize_enabled: z.boolean().optional(),
});

/** Portable server_speech_configs export fields. */
export const serverSpeechConfigExportSchema = z.object({
  voice_transcript_chat_mode: z.boolean().optional(),
  chatterbox_turbo_enabled: z.boolean().optional(),
  chatterbox_cfg_weight: z.number().min(0.0).optional(),
  chatterbox_exaggeration: z.number().min(0.0).optional(),
});

/**
 * Portable server_channel_scope_configs export fields.
 * Discord channel IDs remain excluded because they are not portable.
 */
export const serverChannelScopeConfigExportSchema = z.object({
  stm_privacy_bypass: z.boolean().optional(),
});

/**
 * server_auto_trigger_configs currently has no portable export fields.
 * Channel IDs, persona overrides, and channel-coupled thresholds are server-specific.
 */
export const serverAutoTriggerConfigExportSchema = z.object({});

/** Portable server_trigger_behavior_configs export fields. */
export const serverTriggerBehaviorConfigExportSchema = z.object({
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
export const serverNovelaiImagegenConfigExportSchema = z.object({
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
export const serverByokConfigExportSchema = z.object({
  user_byok_mode: z.boolean().optional(),
});

/** Portable server_memory_configs export fields. */
export const serverMemoryConfigExportSchema = z.object({
  memory_tagging_enabled: z.boolean().optional(),
  channel_memory_enabled: z.boolean().optional(),
});

/**
 * Portable server_welcome_configs export fields.
 * Discord channel/persona references remain excluded.
 */
export const serverWelcomeConfigExportSchema = z.object({
  welcome_prompt: z.string().nullable().optional(),
});

/**
 * Portable STM customization export fields (server_stm_configs + stm_categories).
 * Unlike the flat split-config tables, STM travels as a nested config object plus an
 * ordered categories array: these mirror ShortTermMemoryRepository's export shape.
 * Both keys are optional so exports predating STM customization still validate.
 * Per-channel durable STM *state* is intentionally NOT exported (design decision 8).
 */
export const serverStmConfigExportSchema = z.object({
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
export const serverConfigExportSchema = serverModelConfigExportSchema
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
 * Chat omits both fields it would otherwise inherit from `server_chat_configs`. `self_debug_enabled` is a
 * capability-class toggle and is claimed by `capabilities`; `model_randomizer_enabled` travels nowhere because
 * its fallback model pool is excluded, so carrying the flag alone would enable a randomizer over nothing.
 */
export const workspaceChatConfigSectionSchema = serverModelConfigExportSchema
  .merge(serverChatConfigExportSchema.omit({ self_debug_enabled: true, model_randomizer_enabled: true }))
  .merge(serverWelcomeConfigExportSchema)
  .strict();

export const workspaceTriggersConfigSectionSchema = serverTriggerBehaviorConfigExportSchema.strict();

export const workspaceCapabilitiesConfigSectionSchema = serverCapabilitiesConfigExportSchema
  .merge(serverNoticeEmbedsConfigExportSchema)
  .merge(serverNsfwConfigExportSchema)
  .merge(serverChatConfigExportSchema.pick({ self_debug_enabled: true }))
  .strict();

export const workspaceMemoryConfigSectionSchema = serverMemberPermissionsConfigExportSchema
  .merge(serverChannelScopeConfigExportSchema)
  .merge(serverMemoryConfigExportSchema)
  .merge(serverStmConfigExportSchema)
  .strict();

export const workspaceMediaConfigSectionSchema = serverNovelaiImagegenConfigExportSchema
  .omit({ nai_preset_name: true })
  .strict();

export const workspaceSpeechConfigSectionSchema = serverSpeechConfigExportSchema.strict();

export const workspaceAccessConfigSectionSchema = serverByokConfigExportSchema.strict();

export const personalProfileConfigSectionSchema = personalSettingsExportDataSchema
  .pick({
    user_nickname: true,
    language_pref: true,
    timezone_offset: true,
    prefix_override: true,
    suffix_override: true,
    gender_identity: true,
    pronouns: true,
    addressing_style: true,
  })
  .strict();

export const personalPrivacyConfigSectionSchema = personalSettingsExportDataSchema
  .pick({ privacy_level: true, shortterm_cache_crossserver_opt_in: true })
  .strict();

export const personalAppearanceConfigSectionSchema = personalSettingsExportDataSchema
  .pick({ physical_appearance_tags: true })
  .strict();

export const personalResponseModesConfigSectionSchema = personalSettingsExportDataSchema
  .pick({ impersonation_prompt: true, personal_dtm: true, personal_deliberate_tool_mode: true })
  .strict();

/** Section objects have no defaults because an absent section means that import leaves it untouched. */
export const workspaceConfigExportDataSchema = z
  .object({
    chat: workspaceChatConfigSectionSchema.optional(),
    triggers: workspaceTriggersConfigSectionSchema.optional(),
    capabilities: workspaceCapabilitiesConfigSectionSchema.optional(),
    memory: workspaceMemoryConfigSectionSchema.optional(),
    media: workspaceMediaConfigSectionSchema.optional(),
    speech: workspaceSpeechConfigSectionSchema.optional(),
    access: workspaceAccessConfigSectionSchema.optional(),
  })
  .strict();

export const personalConfigExportDataSchema = z
  .object({
    profile: personalProfileConfigSectionSchema.optional(),
    privacy: personalPrivacyConfigSectionSchema.optional(),
    appearance: personalAppearanceConfigSectionSchema.optional(),
    response_modes: personalResponseModesConfigSectionSchema.optional(),
  })
  .strict();

export type WorkspaceConfigExportData = z.infer<typeof workspaceConfigExportDataSchema>;
export type PersonalConfigExportData = z.infer<typeof personalConfigExportDataSchema>;

export const workspaceConfigExportSchema = z
  .object({
    version: z.literal(EXPORT_V2_VERSION),
    type: z.literal("workspace_config"),
    exported_at: z.string(),
    data: workspaceConfigExportDataSchema,
  })
  .strict();

export const personalConfigExportSchema = z
  .object({
    version: z.literal(EXPORT_V2_VERSION),
    type: z.literal("personal_config"),
    exported_at: z.string(),
    data: personalConfigExportDataSchema,
  })
  .strict();

export type WorkspaceConfigExport = z.infer<typeof workspaceConfigExportSchema>;
export type PersonalConfigExport = z.infer<typeof personalConfigExportSchema>;

export const V1_CONFIG_TABLE_SCHEMAS = {
  personalSettings: personalSettingsExportDataSchema,
  serverModel: serverModelConfigExportSchema,
  serverChat: serverChatConfigExportSchema,
  serverMemberPermissions: serverMemberPermissionsConfigExportSchema,
  serverCapabilities: serverCapabilitiesConfigExportSchema,
  serverNoticeEmbeds: serverNoticeEmbedsConfigExportSchema,
  serverNsfw: serverNsfwConfigExportSchema,
  serverSpeech: serverSpeechConfigExportSchema,
  serverAutoTrigger: serverAutoTriggerConfigExportSchema,
  serverChannelScope: serverChannelScopeConfigExportSchema,
  serverTriggerBehavior: serverTriggerBehaviorConfigExportSchema,
  serverNovelaiImagegen: serverNovelaiImagegenConfigExportSchema,
  serverByok: serverByokConfigExportSchema,
  serverMemory: serverMemoryConfigExportSchema,
  serverWelcome: serverWelcomeConfigExportSchema,
  serverStm: serverStmConfigExportSchema,
} as const;

export const V1_CONFIG_TABLE_SECTION_OWNERSHIP = {
  personalSettings: "profile",
  serverModel: "chat",
  serverChat: "chat",
  serverMemberPermissions: "memory",
  serverCapabilities: "capabilities",
  serverNoticeEmbeds: "capabilities",
  serverNsfw: "capabilities",
  serverSpeech: "speech",
  serverAutoTrigger: null,
  serverChannelScope: "memory",
  serverTriggerBehavior: "triggers",
  serverNovelaiImagegen: "media",
  serverByok: "access",
  serverMemory: "memory",
  serverWelcome: "chat",
  serverStm: "memory",
} as const;

export const V1_CONFIG_FIELD_SECTION_OVERRIDES = {
  personalSettings: {
    user_nickname: "profile",
    language_pref: "profile",
    impersonation_prompt: "response_modes",
    physical_appearance_tags: "appearance",
    nai_char_ref_url: null,
    privacy_level: "privacy",
    personal_dtm: "response_modes",
    personal_deliberate_tool_mode: "response_modes",
    shortterm_cache_crossserver_opt_in: "privacy",
    timezone_offset: "profile",
    prefix_override: "profile",
    suffix_override: "profile",
    gender_identity: "profile",
    pronouns: "profile",
    addressing_style: "profile",
    persona_naming_preferences: null,
  },
  serverChat: {
    self_debug_enabled: "capabilities",
    model_randomizer_enabled: null,
  },
  serverNovelaiImagegen: {
    nai_preset_name: null,
  },
} as const;

export const V2_CONFIG_EXCLUSIONS = {
  nai_preset_name: {
    sourceTable: "serverNovelaiImagegen",
    reason: "An active preset pointer may not exist at the destination.",
  },
  nai_char_ref_url: {
    sourceTable: "personalSettings",
    reason: "A reference URL depends on the source deployment.",
  },
  persona_naming_preferences: {
    sourceTable: "personalSettings",
    reason: "Lineage identifiers cannot be safely bound at the destination.",
  },
  model_randomizer_enabled: {
    sourceTable: "serverChat",
    reason: "The required fallback model pool is not portable.",
  },
} as const;

export const V2_CONFIG_SECTION_SCHEMAS = {
  chat: workspaceChatConfigSectionSchema,
  triggers: workspaceTriggersConfigSectionSchema,
  capabilities: workspaceCapabilitiesConfigSectionSchema,
  memory: workspaceMemoryConfigSectionSchema,
  media: workspaceMediaConfigSectionSchema,
  speech: workspaceSpeechConfigSectionSchema,
  access: workspaceAccessConfigSectionSchema,
  profile: personalProfileConfigSectionSchema,
  privacy: personalPrivacyConfigSectionSchema,
  appearance: personalAppearanceConfigSectionSchema,
  response_modes: personalResponseModesConfigSectionSchema,
} as const;

export const EXPORT_BUCKET_NAME_MAX_LENGTH = 100;
export const EXPORT_BUCKET_LABEL_MAX_LENGTH = 100;

/** Strict bucket entries prevent internal identifiers from crossing the portability boundary. */
export const memoryBucketSchema = z
  .object({
    name: z.string().trim().min(1).max(EXPORT_BUCKET_NAME_MAX_LENGTH),
    label: z.string().trim().min(1).max(EXPORT_BUCKET_LABEL_MAX_LENGTH),
    memories: z.array(strictMemoryItemSchema),
  })
  .strict();

function getMemoryBucketSchema(maxMemories: number) {
  return memoryBucketSchema.extend({ memories: z.array(strictMemoryItemSchema).max(maxMemories) }).strict();
}

function getMemoryBundleDataSchema(maxMemories: number) {
  return z
    .object({
      buckets: z.array(getMemoryBucketSchema(maxMemories)).min(1),
    })
    .strict()
    .superRefine((data, context) => {
      const names = new Set<string>();
      data.buckets.forEach((bucket, index) => {
        if (names.has(bucket.name)) {
          context.addIssue({
            code: "custom",
            path: ["buckets", index, "name"],
            message: `Bucket name is duplicated: ${bucket.name}.`,
          });
        }
        names.add(bucket.name);
      });
    });
}

export type MemoryBucket = z.infer<typeof memoryBucketSchema>;

export function getWorkspaceMemoriesExportSchema() {
  return z
    .object({
      version: z.literal(EXPORT_V2_VERSION),
      type: z.literal("workspace_memories"),
      exported_at: z.string(),
      data: getMemoryBundleDataSchema(getMemoryLimits().maxServerMemories),
    })
    .strict();
}

export function getPersonalMemoriesV2ExportSchema() {
  return z
    .object({
      version: z.literal(EXPORT_V2_VERSION),
      type: z.literal("personal_memories"),
      exported_at: z.string(),
      data: getMemoryBundleDataSchema(getMemoryLimits().maxPersonalMemories),
    })
    .strict();
}

export const workspaceMemoriesExportSchema = getWorkspaceMemoriesExportSchema();
export const personalMemoriesV2ExportSchema = getPersonalMemoriesV2ExportSchema();

export type WorkspaceMemoriesExport = z.infer<typeof workspaceMemoriesExportSchema>;
export type PersonalMemoriesV2Export = z.infer<typeof personalMemoriesV2ExportSchema>;
export type WorkspaceMemoriesExportData = WorkspaceMemoriesExport["data"];
export type PersonalMemoriesV2ExportData = PersonalMemoriesV2Export["data"];

export function getV2ExportSchema() {
  return z.discriminatedUnion("type", [
    workspaceConfigExportSchema,
    personalConfigExportSchema,
    getWorkspaceMemoriesExportSchema(),
    getPersonalMemoriesV2ExportSchema(),
  ]);
}

export const v2ExportSchema = getV2ExportSchema();

type ConfigSectionName = keyof typeof V2_CONFIG_SECTION_SCHEMAS;
type ConfigTableName = keyof typeof V1_CONFIG_TABLE_SCHEMAS;
type V2ConfigSectionData = WorkspaceConfigExportData | PersonalConfigExportData;
type V2MemoryBundleData = WorkspaceMemoriesExportData | PersonalMemoriesV2ExportData;

const WORKSPACE_CONFIG_SECTION_NAMES = Object.keys(workspaceConfigExportDataSchema.shape) as Array<
  keyof WorkspaceConfigExportData
>;
const PERSONAL_CONFIG_SECTION_NAMES = Object.keys(personalConfigExportDataSchema.shape) as Array<
  keyof PersonalConfigExportData
>;

const WORKSPACE_CONFIG_TABLE_NAMES = [
  "serverModel",
  "serverChat",
  "serverMemberPermissions",
  "serverCapabilities",
  "serverNoticeEmbeds",
  "serverNsfw",
  "serverSpeech",
  "serverAutoTrigger",
  "serverChannelScope",
  "serverTriggerBehavior",
  "serverNovelaiImagegen",
  "serverByok",
  "serverMemory",
  "serverWelcome",
  "serverStm",
] as const satisfies ReadonlyArray<Exclude<ConfigTableName, "personalSettings">>;

const PERSONAL_CONFIG_TABLE_NAMES = ["personalSettings"] as const;

export interface V2AdapterSuccess<TPayload> {
  success: true;
  detectedSections: string[];
  payload: TPayload;
  droppedFields: string[];
}

export interface V2AdapterFailure {
  success: false;
  error: string;
}

export type V2AdapterResult<TPayload> = V2AdapterSuccess<TPayload> | V2AdapterFailure;

export interface CombinedV2Payload {
  config: WorkspaceConfigExportData | PersonalConfigExportData;
  memories: WorkspaceMemoriesExportData | PersonalMemoriesV2ExportData;
}

export type ParsedExportPayload = V2ConfigSectionData | V2MemoryBundleData | CombinedV2Payload;

export interface ExportParseSuccess {
  success: true;
  sourceVersion: typeof EXPORT_VERSION | typeof EXPORT_V2_VERSION;
  sourceType: string;
  detectedSections: string[];
  payload: ParsedExportPayload;
  droppedFields: string[];
}

export interface ExportParseFailure {
  success: false;
  error: string;
}

export type ExportParseResult = ExportParseSuccess | ExportParseFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatSchemaError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "file"}: ${issue.message}`)
    .join("; ");
}

function resolveConfigSection(table: ConfigTableName, field: string): ConfigSectionName | null {
  const overrides = (
    V1_CONFIG_FIELD_SECTION_OVERRIDES as Partial<
      Record<ConfigTableName, Readonly<Record<string, ConfigSectionName | null>>>
    >
  )[table];
  if (overrides && Object.hasOwn(overrides, field)) return overrides[field] ?? null;

  const section = V1_CONFIG_TABLE_SECTION_OWNERSHIP[table];
  return section as ConfigSectionName | null;
}

function findSourceTable(field: string, tables: readonly ConfigTableName[]): ConfigTableName | undefined {
  return tables.find((table) => Object.hasOwn(V1_CONFIG_TABLE_SCHEMAS[table].shape, field));
}

function adaptV1ConfigData<TPayload>(
  input: unknown,
  sourceSchema: z.ZodType,
  outputSchema: z.ZodType<TPayload>,
  sourceTables: readonly ConfigTableName[],
  sectionNames: readonly string[],
): V2AdapterResult<TPayload> {
  const validated = sourceSchema.safeParse(input);
  if (!validated.success) {
    return { success: false, error: `Invalid v1 config: ${formatSchemaError(validated.error)}` };
  }

  const sourceValues = validated.data as Record<string, unknown>;
  const populatedFields = new Set(isRecord(input) ? Object.keys(input) : Object.keys(sourceValues));
  const sections: Partial<Record<ConfigSectionName, Record<string, unknown>>> = {};
  const droppedFields: string[] = [];

  for (const field of populatedFields) {
    const sourceTable = findSourceTable(field, sourceTables);
    if (!sourceTable) continue;

    const section = resolveConfigSection(sourceTable, field);
    if (section === null) {
      droppedFields.push(field);
      continue;
    }

    const sectionValues = sections[section] ?? {};
    sectionValues[field] = sourceValues[field];
    sections[section] = sectionValues;
  }

  const adapted = outputSchema.safeParse(sections);
  if (!adapted.success) {
    return { success: false, error: `Invalid adapted v2 config: ${formatSchemaError(adapted.error)}` };
  }

  return {
    success: true,
    detectedSections: sectionNames.filter((section) => Object.hasOwn(sections, section)),
    payload: adapted.data,
    droppedFields,
  };
}

export function adaptV1WorkspaceConfig(input: unknown): V2AdapterResult<WorkspaceConfigExportData> {
  return adaptV1ConfigData(
    input,
    serverConfigExportSchema,
    workspaceConfigExportDataSchema,
    WORKSPACE_CONFIG_TABLE_NAMES,
    WORKSPACE_CONFIG_SECTION_NAMES,
  );
}

export function adaptV1PersonalConfig(input: unknown): V2AdapterResult<PersonalConfigExportData> {
  return adaptV1ConfigData(
    input,
    personalSettingsExportDataSchema,
    personalConfigExportDataSchema,
    PERSONAL_CONFIG_TABLE_NAMES,
    PERSONAL_CONFIG_SECTION_NAMES,
  );
}

function adaptV1MemoryData(
  input: unknown,
  sourceSchema: z.ZodType,
  memoryField: "personal_memories" | "server_memories",
  outputSchema: z.ZodType<V2MemoryBundleData>,
  bucketName: string,
): V2AdapterResult<V2MemoryBundleData> {
  const validated = sourceSchema.safeParse(input);
  if (!validated.success) {
    return { success: false, error: `Invalid v1 memories: ${formatSchemaError(validated.error)}` };
  }

  const sourceValues = validated.data as Record<string, unknown>;
  const memories = sourceValues[memoryField];
  if (!Array.isArray(memories)) {
    return { success: false, error: `Invalid v1 memories: ${memoryField} must be an array.` };
  }

  const adapted = outputSchema.safeParse({
    buckets: [
      {
        name: bucketName,
        label: bucketName,
        memories: memories as MemoryItem[],
      },
    ],
  });
  if (!adapted.success) {
    return { success: false, error: `Invalid adapted v2 memories: ${formatSchemaError(adapted.error)}` };
  }

  return {
    success: true,
    detectedSections: [bucketName],
    payload: adapted.data,
    droppedFields: [],
  };
}

export function adaptV1PersonalMemories(
  input: unknown,
  scope: "personal" | "global" = "personal",
): V2AdapterResult<PersonalMemoriesV2ExportData> {
  const outputSchema = getMemoryBundleDataSchema(
    getMemoryLimits().maxPersonalMemories,
  ) as z.ZodType<PersonalMemoriesV2ExportData>;
  return adaptV1MemoryData(input, getPersonalMemoriesExportDataSchema(), "personal_memories", outputSchema, scope);
}

export function adaptV1WorkspaceMemories(input: unknown): V2AdapterResult<WorkspaceMemoriesExportData> {
  const outputSchema = getMemoryBundleDataSchema(
    getMemoryLimits().maxServerMemories,
  ) as z.ZodType<WorkspaceMemoriesExportData>;
  return adaptV1MemoryData(input, getServerMemoriesExportDataSchema(), "server_memories", outputSchema, "workspace");
}

function addEnvelopeMetadata<TPayload extends ParsedExportPayload>(
  result: V2AdapterResult<TPayload>,
  sourceType: string,
): ExportParseResult {
  if (!result.success) return result;
  return {
    ...result,
    sourceVersion: EXPORT_VERSION,
    sourceType,
  };
}

function parseV2Export(input: unknown): ExportParseResult {
  const validated = getV2ExportSchema().safeParse(input);
  if (!validated.success) return { success: false, error: `Invalid v2 export: ${formatSchemaError(validated.error)}` };

  const envelope = validated.data;
  if (envelope.type === "workspace_config" || envelope.type === "personal_config") {
    return {
      success: true,
      sourceVersion: EXPORT_V2_VERSION,
      sourceType: envelope.type,
      detectedSections: Object.keys(envelope.data),
      payload: envelope.data,
      droppedFields: [],
    };
  }

  return {
    success: true,
    sourceVersion: EXPORT_V2_VERSION,
    sourceType: envelope.type,
    detectedSections: envelope.data.buckets.map((bucket) => bucket.name),
    payload: envelope.data,
    droppedFields: [],
  };
}

function getEnvelopeData(input: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(input.data) ? input.data : null;
}

export function parseExportFile(input: unknown): ExportParseResult {
  if (!isRecord(input)) return { success: false, error: "Export must be a JSON object." };

  const version = input.version;
  if (version === EXPORT_V2_VERSION) return parseV2Export(input);
  if (version !== EXPORT_VERSION) {
    return {
      success: false,
      error: `Unsupported export version: ${typeof version === "string" ? version : "unknown"}.`,
    };
  }

  const type = input.type;
  const data = getEnvelopeData(input);
  if (typeof type !== "string" || !data) return { success: false, error: "v1 export requires a type and data object." };

  switch (type) {
    case "server_config": {
      const validated = serverConfigOnlyExportSchema.safeParse(input);
      if (!validated.success)
        return { success: false, error: `Invalid v1 server config: ${formatSchemaError(validated.error)}` };
      return addEnvelopeMetadata(adaptV1WorkspaceConfig(data.config), type);
    }
    case "personal_settings": {
      const validated = personalSettingsExportSchema.safeParse(input);
      if (!validated.success) {
        return { success: false, error: `Invalid v1 personal config: ${formatSchemaError(validated.error)}` };
      }
      return addEnvelopeMetadata(adaptV1PersonalConfig(data), type);
    }
    case "server_memories": {
      const validated = serverMemoriesExportSchema.safeParse(input);
      if (!validated.success)
        return { success: false, error: `Invalid v1 server memories: ${formatSchemaError(validated.error)}` };
      return addEnvelopeMetadata(adaptV1WorkspaceMemories(data), type);
    }
    case "personal_memories": {
      const validated = personalMemoriesExportSchema.safeParse(input);
      if (!validated.success)
        return { success: false, error: `Invalid v1 personal memories: ${formatSchemaError(validated.error)}` };
      return addEnvelopeMetadata(adaptV1PersonalMemories(data), type);
    }
    case "global_personal_memories": {
      const validated = globalPersonalMemoriesExportSchema.safeParse(input);
      if (!validated.success)
        return { success: false, error: `Invalid v1 global memories: ${formatSchemaError(validated.error)}` };
      return addEnvelopeMetadata(adaptV1PersonalMemories(data, "global"), type);
    }
    case "personal": {
      const validated = getPersonalExportSchema().safeParse(input);
      if (!validated.success)
        return { success: false, error: `Invalid v1 personal export: ${formatSchemaError(validated.error)}` };

      const config = adaptV1PersonalConfig(data);
      const memories = adaptV1PersonalMemories(data);
      if (!config.success) return config;
      if (!memories.success) return memories;
      return {
        success: true,
        sourceVersion: EXPORT_VERSION,
        sourceType: type,
        detectedSections: [
          ...config.detectedSections.map((section) => `config.${section}`),
          ...memories.detectedSections.map((bucket) => `bucket:${bucket}`),
        ],
        payload: { config: config.payload, memories: memories.payload },
        droppedFields: [...config.droppedFields, ...memories.droppedFields],
      };
    }
    case "server": {
      const validated = getServerExportSchema().safeParse(input);
      if (!validated.success)
        return { success: false, error: `Invalid v1 server export: ${formatSchemaError(validated.error)}` };

      const config = adaptV1WorkspaceConfig(data.config);
      const memories = adaptV1WorkspaceMemories(data);
      if (!config.success) return config;
      if (!memories.success) return memories;
      return {
        success: true,
        sourceVersion: EXPORT_VERSION,
        sourceType: type,
        detectedSections: [
          ...config.detectedSections.map((section) => `config.${section}`),
          ...memories.detectedSections.map((bucket) => `bucket:${bucket}`),
        ],
        payload: { config: config.payload, memories: memories.payload },
        droppedFields: [...config.droppedFields, ...memories.droppedFields],
      };
    }
    default:
      return { success: false, error: `Unknown export type: ${type}.` };
  }
}

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
  | ServerExport
  | WorkspaceConfigExport
  | PersonalConfigExport
  | WorkspaceMemoriesExport
  | PersonalMemoriesV2Export;

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
    memoriesInserted?: number;
    memoriesSkipped?: number;
    memoriesDeleted?: number;
  };
  error?: string;
}
