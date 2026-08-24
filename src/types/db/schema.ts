import { StickerFormatType } from "discord.js";
import { z } from "zod";
import { SUPPORTED_PARAM_VALUES, isSupportedParamValue, type SupportedParamValue } from "@/constants/supportedParams";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_VALUES } from "@/constants/thinkingLevels";
import { TOOL_NOTICE_KEYS, isToolNoticeKey, type ToolNoticeKey } from "@/constants/toolNotices";
import {
  addressingStyleSchema,
  EMPTY_PERSONA_NAMING_CONFIG,
  personaNamingConfigSchema,
  type PersonaNamingConfig,
} from "@/types/personaNaming";
import { DEFAULT_IMAGE_NEGATIVE_TAGS, DEFAULT_IMAGE_POSITIVE_TAGS } from "@/utils/image/tagDefaults";
import { logitBiasEntrySchema, normalizeLogitBiasEntries } from "@/types/provider/logitBias";

export enum HumanizerDegree {
  NONE = 0,
  LIGHT = 1,
  MEDIUM = 2,
  HEAVY = 3,
}

export enum PrivacyLevel {
  MINIMAL = 0, // Minimal privacy (full personalization features)
  PARTIAL = 1, // Partial privacy (limited personalization)
  FULL = 2, // Full privacy (maximum protection - completely invisible)
}

export enum CooldownType {
  OFF = 0, // No cooldown on message triggers (default)
  PER_USER = 1, // Each user has their own cooldown per server
  PER_CHANNEL = 2, // Each channel has its own cooldown
  SERVER_WIDE = 3, // Everyone waits (server managers exempt)
  STRICT_SERVER_WIDE = 4, // Everyone waits (no exceptions)
  COMMAND_CATEGORY = 5, // Command category cooldowns (per-user, global across servers)
}

export const conditioningTypeSchema = z.enum(["reward", "punish"]);
export type ConditioningType = z.infer<typeof conditioningTypeSchema>;

export const userSchema = z.object({
  user_id: z.number().optional(),
  user_disc_id: z.string(),
  user_nickname: z.string().nullable(),
  language_pref: z.string().default("en-US"),
  registration_locale: z.string().nullable(), // Static locale captured at registration
  privacy_level: z.nativeEnum(PrivacyLevel).default(PrivacyLevel.MINIMAL),
  personal_memories: z.array(z.string()).default([]),
  physical_appearance_tags: z.array(z.string()).default([]), // Public imageboard-style physical appearance tags
  nai_char_ref_url: z.string().nullable().optional(), // Added March 2026 - User-specific NovelAI character reference image
  impersonation_prompt: z.string().nullable().optional(), // Added March 2026 - Global user-owned prompt for user impersonation replies
  shortterm_cache_crossserver_opt_in: z.boolean().default(false), // Short-term memory cross-server sharing
  personal_dtm: z.enum(["off", "follow", "on"]).default("follow"), // Added April 2026 - User-scoped DTM tri-state: 'off' (always disabled), 'follow' (server setting), 'on' (always enabled)
  personal_deliberate_tool_mode: z.enum(["off", "follow", "on"]).default("follow"), // Added May 2026 - User-scoped deliberate tool mode tri-state
  timezone_offset: z.number().int().min(-12).max(14).nullable().optional(), // Added June 2026 - Personal UTC offset; NULL = not set / opt-out
  prefix_override: z.string().nullable().optional(),
  suffix_override: z.string().nullable().optional(),
  gender_identity: z.string().nullable().optional(),
  pronouns: z.string().nullable().optional(),
  addressing_style: addressingStyleSchema.nullable().optional(),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type UserRow = z.infer<typeof userSchema>;

const serverSchema = z.object({
  server_id: z.number().optional(),
  server_disc_id: z.string(),
  is_dm_channel: z.boolean().default(false), // Added for DM support
  registration_locale: z.string().nullable(), // Static locale captured at server setup
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export const tomoriSchema = z.object({
  persona_id: z.number().optional(),
  server_id: z.number(),
  persona_lineage_id: z
    .preprocess((value) => {
      if (typeof value === "bigint") {
        return Number(value);
      }
      if (typeof value === "string" && value.trim() !== "") {
        return Number(value);
      }
      return value;
    }, z.number().int().nonnegative())
    .default(0),
  is_pointer: z.boolean().default(false),
  preset_lineage_id: z
    .preprocess((value) => {
      if (typeof value === "bigint") {
        return Number(value);
      }
      if (typeof value === "string" && value.trim() !== "") {
        return Number(value);
      }
      return value;
    }, z.number().int().nonnegative().nullable())
    .optional(),
  preset_language: z.string().nullable().optional(),
  persona_nickname: z.string(),
  attribute_list: z.array(z.string()).default([]),
  sample_dialogues_in: z.array(z.string()).default([]),
  sample_dialogues_out: z.array(z.string()).default([]),
  // autoch_counter and autoch_next_target moved to personaAutochRuntimeStateSchema (migration 015).
  is_alter: z.boolean().default(false), // Added January 2026 - Distinguishes main persona (false) from alter personas (true)
  webhook_avatar_url: z.string().nullable().optional(), // Added January 2026 - Stored alter avatar reference (production URL; non-production URL or local avatar path)
  applied_avatar_hash: z.string().nullable().optional(), // Added migration 033 - preset_avatar_hash last PATCHed onto this persona's guild member avatar (NULL = never synced)
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type TomoriRow = z.infer<typeof tomoriSchema>;

const personaScopedConfigStateSchema = z.object({
  physical_appearance_tags: z.array(z.string()).default([]), // From persona_imagegen_configs
  nai_char_ref_url: z.string().nullable().optional(), // From persona_imagegen_configs
  nai_attg_author: z.string().nullable().optional(), // From persona_textgen_configs
  nai_attg_title: z.string().nullable().optional(), // From persona_textgen_configs
  nai_attg_tags: z.string().nullable().optional(), // From persona_textgen_configs
  nai_attg_genre: z.string().nullable().optional(), // From persona_textgen_configs
  nai_attg_stars: z.number().int().min(1).max(5).nullable().optional(), // From persona_textgen_configs
  context_note: z.string().nullable().optional(), // From persona_context_note_configs
  context_note_depth: z.number().int().min(0).max(100).default(0), // From persona_context_note_configs
  speech_voice_sample_id: z.number().int().nullable().optional(), // From persona_voice_configs
  speech_voice_id: z.string().nullable().optional(), // From persona_voice_configs
  speech_voice_name: z.string().nullable().optional(), // From persona_voice_configs
  speech_voice_design_prompt: z.string().nullable().optional(), // From persona_voice_configs
});
type PersonaScopedConfigState = z.infer<typeof personaScopedConfigStateSchema>;

const personaAttributeSchema = z.object({
  attribute_id: z.number().optional(),
  persona_id: z.number().int(),
  attribute_order: z.number().int().min(1),
  attribute_text: z.string(),
  is_public: z.boolean().default(false),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type PersonaAttributeRow = z.infer<typeof personaAttributeSchema>;

export const personaSpriteSchema = z.object({
  sprite_id: z.number().optional(),
  persona_id: z.number().int(),
  sprite_name: z.string().min(1).max(64),
  sprite_key: z.string().min(1).max(64),
  avatar_url: z.string().min(1),
  usage_instructions: z.string().max(1000).default(""),
  // When true, the sprite renders its decorated "Sprite (Persona)" name in
  // Discord (DID alter style) instead of the clean persona name.
  is_identity: z.boolean().default(false),
  created_at: z.coerce.date().optional(),
  updated_at: z.coerce.date().optional(),
});
export type PersonaSpriteRow = z.infer<typeof personaSpriteSchema>;

// Shared official preset sprites, resolved live by pointer personas. Keyed by
// the preset identity (preset_lineage_id, preset_language) and seeded from the
// catalog; the avatar_url is a shared object-storage reference used by every
// server's pointer persona. See docs/subsystems/persona-presets.md.
/**
 * Maps a webhook-delivered sprite message to the sprite label it rendered with.
 * Sprite messages display a clean persona name in Discord; context rebuilding
 * uses these rows to recover the decorated "Name (sprite):" label for the model.
 */
export const personaSpriteMessageSchema = z.object({
  message_disc_id: z.string().min(1),
  persona_id: z.number().int(),
  sprite_name: z.string().min(1).max(64),
  channel_disc_id: z.string().min(1),
  created_at: z.coerce.date().optional(),
});
export type PersonaSpriteMessageRow = z.infer<typeof personaSpriteMessageSchema>;

/**
 * Runtime autochat counters for a persona (Phase 6 Step #16B).
 * Separated from personas so identity rows are not mutated on every message tick.
 * FK column is persona_id → personas(persona_id); ON DELETE CASCADE keeps cleanup atomic.
 */
export const personaAutochRuntimeStateSchema = z.object({
  persona_id: z.number().int(),
  autoch_counter: z.number().int().default(0),
  autoch_next_target: z.number().int().default(0),
  updated_at: z.date().optional(),
});
export type PersonaAutochRuntimeStateRow = z.infer<typeof personaAutochRuntimeStateSchema>;
/**
 * Schema for voice_samples table : reference audio clips for local TTS voice cloning.
 * file_path stores either a production S3/CloudFront URL or a local data/voice-samples path.
 */
export const voiceSampleSchema = z.object({
  sample_id: z.number().optional(),
  server_id: z.number(),
  name: z.string(),
  file_path: z.string(),
  ref_text: z.string().nullable().optional(),
  duration_ms: z.number().int().default(0),
  created_at: z.date().optional(),
});
export type VoiceSampleRow = z.infer<typeof voiceSampleSchema>;

export const llmSchema = z.object({
  llm_id: z.number().optional(),
  llm_provider: z.string(),
  llm_codename: z.string(),
  is_scoped_registration: z.boolean().default(false), // Shared-provider registration; exclude from global pickers unless joined for the owner
  is_smartest: z.boolean().default(false),
  is_default: z.boolean().default(false),
  is_reasoning: z.boolean().default(false),
  is_deprecated: z.boolean().default(false),
  is_free: z.boolean().default(false),
  has_tools: z.boolean().default(false),
  sees_images: z.boolean().default(false),
  sees_videos: z.boolean().default(false),
  sees_youtube: z.boolean().default(false),
  is_uncensored: z.boolean().default(false),
  supports_structoutput: z.boolean().default(false),
  // Strict chat-completion compatibility flags (see docs/subsystems/strict-chat-completion.md).
  // strict_role_alternation: merge consecutive same-role turns + force a leading user turn.
  // supports_prefix_completion: allow `prefix: true` on the trailing assistant prefill turn.
  strict_role_alternation: z.boolean().default(false),
  supports_prefix_completion: z.boolean().default(false),
  llm_description: z.string().nullable().optional(),
  ja_description: z.string().nullable().optional(),
  // Official per-model pricing (USD per million tokens, uncached standard rate). Null for
  // free/non-metered providers. OpenRouter rows are not seeded with a price but are refreshed
  // from the live API at startup, so SQL-computed cost surfaces can price them; the live cache
  // stays authoritative for request-time math. Coerced because Postgres NUMERIC arrives as a string.
  input_price_per_million: z.coerce.number().nullable().optional(),
  output_price_per_million: z.coerce.number().nullable().optional(),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type LlmRow = z.infer<typeof llmSchema>;

export const diffusionModelSchema = z.object({
  diffusion_model_id: z.number().optional(),
  provider: z.string(),
  codename: z.string(),
  is_scoped_registration: z.boolean().default(false), // Shared-provider registration; exclude from global image pickers unless joined for the owner
  model_description: z.string().nullable().optional(),
  ja_description: z.string().nullable().optional(),
  is_default: z.boolean().default(false),
  is_deprecated: z.boolean().default(false),
  is_free: z.boolean().default(false),
  is_uncensored: z.boolean().default(false),
  // Null means the model follows its provider's built-in image defaults, so these must stay nullable
  // rather than gaining a `.default()` that would freeze an undeclared model against today's defaults.
  supports_txt2img: z.boolean().nullable().optional(),
  supports_img2img: z.boolean().nullable().optional(),
  supports_inpaint: z.boolean().nullable().optional(),
  supports_negative_prompt: z.boolean().nullable().optional(),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type DiffusionModelRow = z.infer<typeof diffusionModelSchema>;

export const videoGenerationModelSchema = z.object({
  video_model_id: z.number().optional(),
  provider: z.string(),
  codename: z.string(),
  is_scoped_registration: z.boolean().default(false), // Shared-provider registration; exclude from global video pickers unless joined for the owner
  model_description: z.string().nullable().optional(),
  ja_description: z.string().nullable().optional(),
  is_default: z.boolean().default(false),
  is_deprecated: z.boolean().default(false),
  is_free: z.boolean().default(false),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type VideoGenerationModelRow = z.infer<typeof videoGenerationModelSchema>;

export const embeddingModelSchema = z.object({
  embedding_model_id: z.number().optional(),
  provider: z.string(),
  codename: z.string(),
  model_family: z.string(),
  is_scoped_registration: z.boolean().default(false), // Shared-provider registration; exclude from global embedding pickers unless joined for the owner
  model_description: z.string().nullable().optional(),
  ja_description: z.string().nullable().optional(),
  is_default: z.boolean().default(false),
  is_deprecated: z.boolean().default(false),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type EmbeddingModelRow = z.infer<typeof embeddingModelSchema>;

const customEndpointCapabilitySchema = z.enum(["text", "embedding", "image", "video", "speech", "transcription"]);
export type CustomEndpointCapability = z.infer<typeof customEndpointCapabilitySchema>;

const customEndpointApiStyleSchema = z.enum([
  "openai-compatible",
  "comfyui",
  "ollama-native",
  "elevenlabs",
  "elevenlabs-transcription",
  "tts-clone",
  "openai-compatible-transcription",
]);
export type CustomEndpointApiStyle = z.infer<typeof customEndpointApiStyleSchema>;

export const customEndpointConnectionSchema = z.object({
  connection_id: z.number().int().positive(),
  server_id: z.number().nullable().optional(),
  user_id: z.number().nullable().optional(),
  label: z.string(),
  capability: customEndpointCapabilitySchema,
  api_style: customEndpointApiStyleSchema,
  endpoint_url: z.string(),
  requires_auth: z.boolean().default(false),
  created_at: z.coerce.date().optional(),
  updated_at: z.coerce.date().optional(),
});
export type CustomEndpointConnectionRow = z.infer<typeof customEndpointConnectionSchema>;

export const customEndpointSchema = customEndpointConnectionSchema.extend({
  custom_endpoint_id: z.number().optional(),
  model_name: z.string().nullable().optional(),
  // Links this endpoint row to the synthetic model row it owns (llms / embedding_models /
  // image_diffusion_models / video_generation_models, disambiguated by `capability`). Lets the
  // runtime resolve the specific selected model back to its endpoint when several models share a
  // connection. Null for legacy rows until backfilled and for speech/transcription.
  model_ref_id: z.number().int().nullable().optional(),
  num_ctx: z.number().int().min(512).nullable().optional(),
  extra_config: z.preprocess((value) => {
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {
        return {};
      }
    }
    return value ?? {};
  }, z.record(z.string(), z.unknown()).default({})),
  has_tools: z.boolean().default(false),
  sees_images: z.boolean().default(false),
  sees_videos: z.boolean().default(false),
  supports_structoutput: z.boolean().default(false),
  // Strict chat-completion compatibility flags for proxies fronting strict backends. Synced to the
  // endpoint's synthetic llms row so the runtime resolves them uniformly with built-in providers.
  strict_role_alternation: z.boolean().default(false),
  supports_prefix_completion: z.boolean().default(false),
  is_default: z.boolean().default(false),
});
export type CustomEndpointRow = z.infer<typeof customEndpointSchema>;

export const openRouterModelRegistrationSchema = z.object({
  openrouter_model_registration_id: z.number().optional(),
  server_id: z.number().nullable().optional(),
  user_id: z.number().nullable().optional(),
  llm_id: z.number().int(),
  created_at: z.coerce.date().optional(),
  updated_at: z.coerce.date().optional(),
});
export type OpenRouterModelRegistrationRow = z.infer<typeof openRouterModelRegistrationSchema>;

export const openRouterEmbeddingModelRegistrationSchema = z.object({
  openrouter_embedding_model_registration_id: z.number().optional(),
  server_id: z.number().nullable().optional(),
  user_id: z.number().nullable().optional(),
  embedding_model_id: z.number().int(),
  created_at: z.coerce.date().optional(),
  updated_at: z.coerce.date().optional(),
});
export type OpenRouterEmbeddingModelRegistrationRow = z.infer<typeof openRouterEmbeddingModelRegistrationSchema>;

export const openRouterImageModelRegistrationSchema = z.object({
  openrouter_image_model_registration_id: z.number().optional(),
  server_id: z.number().nullable().optional(),
  user_id: z.number().nullable().optional(),
  diffusion_model_id: z.number().int(),
  created_at: z.coerce.date().optional(),
  updated_at: z.coerce.date().optional(),
});
export type OpenRouterImageModelRegistrationRow = z.infer<typeof openRouterImageModelRegistrationSchema>;

export const openRouterVideoModelRegistrationSchema = z.object({
  openrouter_video_model_registration_id: z.number().optional(),
  server_id: z.number().nullable().optional(),
  user_id: z.number().nullable().optional(),
  video_model_id: z.number().int(),
  created_at: z.coerce.date().optional(),
  updated_at: z.coerce.date().optional(),
});
export type OpenRouterVideoModelRegistrationRow = z.infer<typeof openRouterVideoModelRegistrationSchema>;

/**
 * Normalizes a JSONB array value from the database driver.
 * Handles the case where Bun SQL returns JSONB columns as strings
 * instead of parsed objects ; parses the string before returning.
 * @param value - Raw value from the database (may be array, string, or other)
 * @returns Parsed array, or empty array if parsing fails
 */
function normalizeJsonbArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeFallbackLlmIds(value: unknown): number[] {
  let source: unknown = value;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(source)) {
    return [];
  }

  return source
    .map((id) => {
      const parsed = typeof id === "number" ? id : typeof id === "string" ? Number(id) : NaN;
      return Number.isInteger(parsed) ? parsed : null;
    })
    .filter((id): id is number => id !== null);
}

const fallbackModelRefSchema = z.object({
  type: z.enum(["llm", "custom_endpoint"]),
  id: z.number().int(),
});
export type FallbackModelRef = z.infer<typeof fallbackModelRefSchema>;

/** Resolved fallback entry : either a known LLM row or a custom endpoint row. */
export type FallbackEntry =
  | { kind: "llm"; model: z.infer<typeof llmSchema> }
  | { kind: "custom_endpoint"; endpoint: z.infer<typeof customEndpointSchema> };

function normalizeFallbackModelRefs(value: unknown): FallbackModelRef[] {
  const rows = normalizeJsonbArray(value);
  const parsed = fallbackModelRefSchema.array().safeParse(rows);
  return parsed.success ? parsed.data : [];
}

function normalizeEnabledCapabilities(value: unknown): string[] {
  let source: unknown = value;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(source)) {
    return [];
  }

  return source.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function normalizeToolNoticeHiddenKeys(value: unknown): ToolNoticeKey[] {
  let source: unknown = value;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(source)) {
    return [];
  }

  return source.filter((item): item is ToolNoticeKey => typeof item === "string" && isToolNoticeKey(item));
}

function normalizeStringArray(value: unknown): string[] {
  let source: unknown = value;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(source)) {
    return [];
  }

  return source.filter((item): item is string => typeof item === "string" && item.length > 0);
}

export const deliberateToolTriggerEntrySchema = z.union([
  z.string(),
  z.object({
    type: z.enum(["literal", "regex"]),
    value: z.string(),
  }),
]);

function normalizeDeliberateToolTriggers(
  value: unknown,
): Record<string, Array<string | { type: "literal" | "regex"; value: string }>> {
  let source: unknown = value;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      return {};
    }
  }

  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return {};
  }

  const normalized: Record<string, Array<string | { type: "literal" | "regex"; value: string }>> = {};
  for (const [target, triggers] of Object.entries(source)) {
    if (!Array.isArray(triggers)) continue;
    const seen = new Set<string>();
    const normalizedTriggers: Array<string | { type: "literal" | "regex"; value: string }> = [];
    for (const trigger of triggers) {
      if (typeof trigger === "string") {
        const normalizedTrigger = trigger.replace(/\s+/g, " ").trim().toLowerCase();
        const key = `literal:${normalizedTrigger}`;
        if (normalizedTrigger.length > 0 && !seen.has(key)) {
          seen.add(key);
          normalizedTriggers.push(normalizedTrigger);
        }
        continue;
      }

      if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) continue;
      const triggerEntry = trigger as { type?: unknown; value?: unknown };
      if (triggerEntry.type !== "literal" && triggerEntry.type !== "regex") continue;
      if (typeof triggerEntry.value !== "string") continue;
      const normalizedValue =
        triggerEntry.type === "literal"
          ? triggerEntry.value.replace(/\s+/g, " ").trim().toLowerCase()
          : triggerEntry.value.trim();
      const key = `${triggerEntry.type}:${normalizedValue}`;
      if (normalizedValue.length > 0 && !seen.has(key)) {
        seen.add(key);
        normalizedTriggers.push({ type: triggerEntry.type, value: normalizedValue });
      }
    }

    if (normalizedTriggers.length > 0) {
      normalized[target] = normalizedTriggers;
    }
  }

  return normalized;
}

function normalizeDisabledLlmParams(value: unknown): SupportedParamValue[] {
  let source: unknown = value;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(source)) {
    return [];
  }

  return source.filter((item): item is SupportedParamValue => typeof item === "string" && isSupportedParamValue(item));
}

const toolNoticeKeySchema = z.enum(TOOL_NOTICE_KEYS);
const supportedParamSchema = z.enum(SUPPORTED_PARAM_VALUES);
const autochatPersonaOverrideSchema = z.object({
  channel_disc_id: z.string(),
  persona_id: z.number().int(),
});
export type AutochatPersonaOverride = z.infer<typeof autochatPersonaOverrideSchema>;

const userPersonalizationConfigsSchema = z.object({
  user_id: z.number().int(),
  user_nickname: z.string().nullable(),
  shortterm_cache_crossserver_opt_in: z.boolean().default(false),
  physical_appearance_tags: z.array(z.string()).default([]),
  nai_char_ref_url: z.string().nullable().optional(),
  impersonation_prompt: z.string().nullable().optional(),
  personal_dtm: z.enum(["off", "follow", "on"]).default("follow"),
  personal_deliberate_tool_mode: z.enum(["off", "follow", "on"]).default("follow"),
  timezone_offset: z.number().int().min(-12).max(14).nullable().optional(),
  prefix_override: z.string().nullable().optional(),
  suffix_override: z.string().nullable().optional(),
  gender_identity: z.string().nullable().optional(),
  pronouns: z.string().nullable().optional(),
  addressing_style: addressingStyleSchema.nullable().optional(),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type UserPersonalizationConfigsRow = z.infer<typeof userPersonalizationConfigsSchema>;

const serverModelConfigSchema = z.object({
  server_id: z.number().int(),
  llm_id: z.number().int().nullable().optional(),
  embedding_model_id: z.number().int().nullable().optional(),
  diffusion_model_id: z.number().int().nullable().optional(),
  video_model_id: z.number().int().nullable().optional(),
  vision_llm_id: z.number().int().nullable().optional(),
  api_key: z.instanceof(Buffer).nullable().optional(),
  key_version: z.number().int().default(1),
  llm_temperature: z.number().min(0.0).max(2.0).default(1.0),
  thinking_level: z.enum(THINKING_LEVEL_VALUES).default(DEFAULT_THINKING_LEVEL),
  llm_disabled_params: z.preprocess(
    (value) => normalizeDisabledLlmParams(value),
    z.array(supportedParamSchema).default([]),
  ),
  custom_endpoint_url: z.string().nullable().optional(),
  custom_model_name: z.string().nullable().optional(),
  custom_num_ctx: z.number().int().nullable().optional(),
  fallback_llm_ids: z.preprocess((value) => normalizeFallbackLlmIds(value), z.array(z.number().int()).default([])),
  other_model_codename: z.string().nullable().optional(),
  other_model_capabilities: z.unknown().nullable().optional(),
  other_model_capabilities_fetched_at: z.date().nullable().optional(),
  hide_respond_embed: z.boolean().default(false),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type ServerModelConfigRow = z.infer<typeof serverModelConfigSchema>;

const serverChatConfigSchema = z.object({
  server_id: z.number().int(),
  humanizer_degree: z.nativeEnum(HumanizerDegree).default(HumanizerDegree.LIGHT),
  message_fetch_limit: z.number().int().default(80),
  send_message_limit: z.number().int().default(0),
  match_limit: z.number().int().default(3),
  cascade_limit: z.number().int().default(3),
  timezone_offset: z.number().int().default(0),
  self_debug_enabled: z.boolean().default(false),
  model_randomizer_enabled: z.boolean().default(false),
  system_prompt: z.string().nullable().optional(),
  context_note: z.string().nullable().optional(),
  context_note_depth: z.number().int().default(0),
  llm_stop_strings: z.preprocess((value) => normalizeStringArray(value), z.array(z.string()).default([])),
  llm_stop_speaker_pattern_enabled: z.boolean().default(false),
  llm_max_output_tokens: z.number().int().nullable().optional(),
  llm_top_p: z.number().default(0.95),
  llm_top_k: z.number().int().default(0),
  llm_frequency_penalty: z.number().default(0.0),
  llm_presence_penalty: z.number().default(0.0),
  llm_min_p: z.number().default(0.05),
  llm_logit_biases: z.preprocess(
    (value) => normalizeLogitBiasEntries(value),
    z.array(logitBiasEntrySchema).default([]),
  ),
  fallback_model_refs: z.preprocess(
    (value) => normalizeFallbackModelRefs(value),
    fallbackModelRefSchema.array().default([]),
  ),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type ServerChatConfigRow = z.infer<typeof serverChatConfigSchema>;

const serverMemberPermissionsConfigSchema = z.object({
  server_id: z.number().int(),
  server_memteaching_enabled: z.boolean().default(false),
  attribute_memteaching_enabled: z.boolean().default(false),
  sampledialogue_memteaching_enabled: z.boolean().default(false),
  self_teaching_enabled: z.boolean().default(true),
  personal_memories_enabled: z.boolean().default(true),
  hide_impersonation_embeds: z.boolean().default(false),
  prompt_snapshot_enabled: z.boolean().default(false),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type ServerMemberPermissionsConfigRow = z.infer<typeof serverMemberPermissionsConfigSchema>;

const serverCapabilitiesConfigSchema = z.object({
  server_id: z.number().int(),
  emoji_usage_enabled: z.boolean().default(true),
  sticker_usage_enabled: z.boolean().default(true),
  web_search_enabled: z.boolean().default(true),
  manage_message_enabled: z.boolean().default(true),
  thread_creation_enabled: z.boolean().default(true),
  imagegen_enabled: z.boolean().default(true),
  videogen_enabled: z.boolean().default(false),
  voice_message_enabled: z.boolean().default(true),
  user_blocking_enabled: z.boolean().default(true),
  time_awareness_enabled: z.boolean().default(true),
  tool_use_enabled: z.boolean().default(true),
  // Master switch for the short-term memory subsystem (tool + context injection).
  // Default true keeps existing servers unchanged; see migration 054.
  short_term_memory_enabled: z.boolean().default(true),
  verbatim_tool_calling_enabled: z.boolean().default(false),
  user_info_updates_enabled: z.boolean().default(true),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type ServerCapabilitiesConfigRow = z.infer<typeof serverCapabilitiesConfigSchema>;

const serverNoticeEmbedsConfigSchema = z.object({
  server_id: z.number().int(),
  tool_notice_hidden_keys: z.preprocess(
    (value) => normalizeToolNoticeHiddenKeys(value),
    z.array(toolNoticeKeySchema).default([]),
  ),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type ServerNoticeEmbedsConfigRow = z.infer<typeof serverNoticeEmbedsConfigSchema>;

const serverNsfwConfigSchema = z.object({
  server_id: z.number().int(),
  uncensor_injection_enabled: z.boolean().default(false),
  uncensor_unicode_space_enabled: z.boolean().default(false),
  uncensor_sanitize_enabled: z.boolean().default(false),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type ServerNsfwConfigRow = z.infer<typeof serverNsfwConfigSchema>;

const serverSpeechConfigSchema = z.object({
  server_id: z.number().int(),
  voice_transcript_chat_mode: z.boolean().default(true),
  chatterbox_turbo_enabled: z.boolean().default(true),
  chatterbox_cfg_weight: z.number().default(0.5),
  chatterbox_exaggeration: z.number().default(0.5),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type ServerSpeechConfigRow = z.infer<typeof serverSpeechConfigSchema>;

const serverAutoTriggerConfigSchema = z.object({
  server_id: z.number().int(),
  autoch_disc_ids: z.array(z.string()).default([]),
  autoch_persona_overrides: z.preprocess(
    (value) => normalizeJsonbArray(value),
    z.array(autochatPersonaOverrideSchema).default([]),
  ),
  autoch_threshold: z.number().int().default(0),
  autoch_threshold_max: z.number().int().default(0),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type ServerAutoTriggerConfigRow = z.infer<typeof serverAutoTriggerConfigSchema>;

const serverChannelScopeConfigSchema = z.object({
  server_id: z.number().int(),
  rp_channel_ids: z.array(z.string()).default([]),
  private_channel_ids: z.array(z.string()).default([]),
  crosschannel_blocklist_ids: z.array(z.string()).default([]),
  stm_privacy_bypass: z.boolean().default(false),
  thought_log_channel_disc_id: z.string().nullable().optional(),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type ServerChannelScopeConfigRow = z.infer<typeof serverChannelScopeConfigSchema>;

const serverTriggerBehaviorConfigSchema = z.object({
  server_id: z.number().int(),
  always_reply_enabled: z.boolean().default(false),
  deliberate_trigger_mode: z.boolean().default(false),
  deliberate_tool_mode: z.boolean().default(false), // Added May 2026 - Tools require explicit tool intent when enabled
  deliberate_tool_context_turns: z.number().int().min(0).max(10).nullable().default(null), // Added May 2026 - Successful tools remain available for this many following channel turns; NULL uses env default
  deliberate_tool_triggers: z.preprocess(
    (value) => normalizeDeliberateToolTriggers(value),
    z.record(z.string(), z.array(deliberateToolTriggerEntrySchema)).default({}),
  ), // Added May 2026 - Server-defined deliberate tool trigger phrases by tool target
  cooldown_type: z.number().int().default(0),
  cooldown_length: z.number().int().default(5),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type ServerTriggerBehaviorConfigRow = z.infer<typeof serverTriggerBehaviorConfigSchema>;

const serverNovelaiImagegenConfigSchema = z.object({
  server_id: z.number().int(),
  nai_preset_name: z.string().nullable().optional(),
  image_default_positive_tags: z.array(z.string()).default([...DEFAULT_IMAGE_POSITIVE_TAGS]),
  image_default_negative_tags: z.array(z.string()).default([...DEFAULT_IMAGE_NEGATIVE_TAGS]),
  nai_sampler: z.string().nullable().optional(),
  nai_steps: z.number().int().nullable().optional(),
  nai_scale: z.number().nullable().optional(),
  nai_noise_schedule: z.string().nullable().optional(),
  nai_cfg_rescale: z.number().nullable().optional(),
  nai_diffusion_model_id: z.number().int().nullable().optional(),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type ServerNovelaiImagegenConfigRow = z.infer<typeof serverNovelaiImagegenConfigSchema>;

const serverByokConfigSchema = z.object({
  server_id: z.number().int(),
  user_byok_mode: z.boolean().default(false),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type ServerByokConfigRow = z.infer<typeof serverByokConfigSchema>;

const serverMemoryConfigSchema = z.object({
  server_id: z.number().int(),
  memory_tagging_enabled: z.boolean().default(false),
  channel_memory_enabled: z.boolean().default(false), // Added May 2026 - Per-channel memory scoping toggle
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type ServerMemoryConfigRow = z.infer<typeof serverMemoryConfigSchema>;

export const serverStmConfigSchema = z.object({
  server_id: z.number().int(),
  refresh_cadence: z.number().int().default(5),
  render_mode: z.enum(["supersede", "crude_summary"]).default("crude_summary"),
  crude_message_count: z.number().int().default(6),
  tool_description_override: z.string().nullable().optional(),
  // Unified nudge override (merged create+update, migration 052). NULL → seed default.
  update_nudge_override: z.string().nullable().optional(),
  // Positional injection depth for the nudge, counted in dialogue TURNS from the
  // bottom (not pairs): 0 = tail, 1 = before the final turn, 2 = before the latest
  // pair, N = before the Nth turn (migration 052, default 2).
  nudge_injection_depth: z.number().int().default(2),
  // Positional injection depth for the STM content block (same/other-channel memory),
  // counted in dialogue TURNS from the bottom like nudge_injection_depth, with an extra
  // sentinel: -1 = default (keep the block anchored near the top as ambient knowledge,
  // legacy behavior), 0 = tail (last dialogue item), N = before the Nth turn
  // (migration 053, default -1). At equal depths the nudge lands just below the block.
  content_injection_depth: z.number().int().default(-1),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type ServerStmConfigRow = z.infer<typeof serverStmConfigSchema>;

export const stmCategorySchema = z.object({
  stm_category_id: z.number().int().optional(),
  server_id: z.number().int(),
  position: z.number().int().min(0).max(4),
  label: z.string(),
  description: z.string(),
});
export type StmCategoryRow = z.infer<typeof stmCategorySchema>;

export function normalizeStmCategories(value: unknown): Record<string, string> {
  if (value === null || value === undefined) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
        return parsed as Record<string, string>;
    } catch {
      return {};
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, string>;
  return {};
}

const shortTermMemoryRowSchema = z.object({
  stm_id: z.number().int().optional(),
  server_disc_id: z.string().nullable().optional(),
  user_disc_id: z.string().nullable().optional(),
  channel_disc_id: z.string(),
  persona_id: z.number().int().nullable().optional(),
  persona_lineage_id: z.number().int().nullable().optional(),
  scope_kind: z.enum(["server", "user"]),
  categories: z.preprocess(normalizeStmCategories, z.record(z.string(), z.string()).default({})),
  summary: z.string().nullable().optional(),
  turns_since_refresh: z.number().int().default(0),
  last_refreshed_turn: z.number().int().default(0),
  updated_at: z.date().optional(),
});
export type ShortTermMemoryRow = z.infer<typeof shortTermMemoryRowSchema>;

/**
 * Assembled view over the 13 split server config tables (Phase 6 / Stage B).
 * Replaces the previous monolithic `tomori_configs` row shape.
 * Callers read this as a flat object : nested restructuring (config.model.X) is deferred to Task G.
 *
 * Composition order: serverModelConfigSchema anchors the merge chain (13 tables total).
 * Shared identity columns (server_id, created_at, updated_at) are omitted from every
 * split schema before merging, then re-extended once to prevent silent field shadowing.
 *
 * The .extend() block also:
 *   - Preserves exact nullable types for llm_id and api_key (non-optional in the legacy shape)
 *   - Overrides other_model_capabilities with the typed object shape callers access
 *   - Adds welcome_* fields (live in server_welcome_configs, not a schema in this composition)
 *   - Drops trigger_words (verified zero config.trigger_words callers; canonical store is persona_configs)
 */
const _sharedOmit = { server_id: true, created_at: true, updated_at: true } as const;
export const assembledServerConfigSchema = serverModelConfigSchema
  .omit(_sharedOmit)
  .merge(serverChatConfigSchema.omit(_sharedOmit))
  .merge(serverMemberPermissionsConfigSchema.omit(_sharedOmit))
  .merge(serverCapabilitiesConfigSchema.omit(_sharedOmit))
  .merge(serverNoticeEmbedsConfigSchema.omit(_sharedOmit))
  .merge(serverNsfwConfigSchema.omit(_sharedOmit))
  .merge(serverSpeechConfigSchema.omit(_sharedOmit))
  .merge(serverAutoTriggerConfigSchema.omit(_sharedOmit))
  .merge(serverChannelScopeConfigSchema.omit(_sharedOmit))
  .merge(serverTriggerBehaviorConfigSchema.omit(_sharedOmit))
  .merge(serverNovelaiImagegenConfigSchema.omit(_sharedOmit))
  .merge(serverByokConfigSchema.omit(_sharedOmit))
  .merge(serverMemoryConfigSchema.omit(_sharedOmit))
  .extend({
    // Identity fields added once after the merge chain.
    tomori_config_id: z.number().optional(),
    tomori_id: z.number().nullable().optional(),
    server_id: z.number().nullable().optional(),
    created_at: z.date().optional(),
    updated_at: z.date().optional(),
    // Preserve non-optional nullable types to avoid breaking callers that declare these as T | null.
    llm_id: z.number().int().nullable(),
    api_key: z.instanceof(Buffer).nullable(),
    // Override with the properly typed shape; openrouterProvider accesses .hasTools / .seesImages.
    other_model_capabilities: z.preprocess(
      (value) => (typeof value === "string" ? JSON.parse(value) : value),
      z
        .object({
          hasTools: z.boolean().default(false),
          seesImages: z.boolean().default(false),
          seesVideos: z.boolean().default(false),
          supportsStructuredOutput: z.boolean().default(false),
        })
        .nullable()
        .optional(),
    ),
    welcome_channel_disc_id: z.string().nullable().optional(),
    welcome_prompt: z.string().nullable().optional(),
    welcome_persona_id: z.number().int().nullable().optional(),
  });
export type AssembledServerConfig = z.infer<typeof assembledServerConfigSchema>;

/**
 * Schema for a NovelAI sampling preset row.
 * Stores the full parameter JSON alongside human-readable descriptions.
 * Schema-compatible fields (temperature, top_k, top_p, min_p) are written
 * to the split server config tables; NAI-specific fields are merged at generation time.
 */
export const naiPresetSchema = z.object({
  nai_preset_id: z.number(),
  preset_name: z.string(),
  model_target: z.string(), // "kayra" or "erato"
  is_default: z.boolean(),
  preset_desc: z.string(), // EN human-readable description
  ja_preset_desc: z.string(), // JA human-readable description
  parameters: z.record(z.string(), z.unknown()),
  created_at: z.date().optional(),
});
export type NaiPresetRow = z.infer<typeof naiPresetSchema>;

export const personaConfigSchema = z.object({
  persona_id: z.number(),
  trigger_words: z.array(z.string()).default([]),
  persona_prompt: z.string().nullable().optional(),
  reward_conditioning_enabled: z.boolean().default(true),
  punish_conditioning_enabled: z.boolean().default(true),
  llm_id: z.number().int().nullable().optional(), // Added March 2026 - Persona-specific LLM model override
  humanizer_degree: z.number().int().min(0).max(3).nullable().optional(), // Added July 2026 - Persona humanizer override; NULL inherits server_chat_configs
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type PersonaConfigRow = z.infer<typeof personaConfigSchema>;
/** Prompt-mode values for a per-channel system prompt override. */
const CHANNEL_PROMPT_MODES = ["append", "replace"] as const;
export type ChannelPromptMode = (typeof CHANNEL_PROMPT_MODES)[number];
const tomoriPresetSchema = z.object({
  persona_preset_id: z.number(),
  persona_preset_name: z.string(),
  persona_preset_desc: z.string(),
  preset_lineage_id: z
    .preprocess((value) => {
      if (typeof value === "bigint") {
        return Number(value);
      }
      if (typeof value === "string" && value.trim() !== "") {
        return Number(value);
      }
      return value;
    }, z.number().int().nonnegative().nullable())
    .optional(),
  preset_attribute_list: z.array(z.string()).default([]),
  preset_attribute_public_flags: z.array(z.boolean()).default([]),
  preset_sample_dialogues_in: z.array(z.string()).default([]),
  preset_sample_dialogues_out: z.array(z.string()).default([]),
  preset_language: z.string(),
  preset_avatar_path: z.string().nullable().optional(),
  // Shared object-storage URL of the official avatar image (migration 033),
  // uploaded once and live-resolved by pointer alters; the hash is its
  // content-addressed version token used to gate the main-avatar fan-out.
  preset_avatar_shared_url: z.string().nullable().optional(),
  preset_avatar_hash: z.string().nullable().optional(),
  preset_trigger_words: z.array(z.string()).default([]),
  preset_naming_config: z.preprocess((value) => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }, personaNamingConfigSchema.default(EMPTY_PERSONA_NAMING_CONFIG)),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type TomoriPresetRow = z.infer<typeof tomoriPresetSchema>;

const systemPromptPresetSchema = z.object({
  system_prompt_preset_id: z.number(),
  system_prompt_preset_name: z.string(),
  system_prompt_preset_desc: z.string(),
  ja_description: z.string().nullable().optional(),
  preset_prompt_text: z.string(),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type SystemPromptPresetRow = z.infer<typeof systemPromptPresetSchema>;

export const serverEmojiSchema = z.object({
  server_emoji_id: z.number().optional(),
  server_id: z.number(),
  emoji_disc_id: z.string(),
  emoji_name: z.string(),
  emoji_desc: z.string().default(""),
  emotion_key: z.string(),
  is_global: z.boolean().default(false),
  is_animated: z.boolean().default(false),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type ServerEmojiRow = z.infer<typeof serverEmojiSchema>;

export const serverStickerSchema = z.object({
  server_sticker_id: z.number().optional(),
  server_id: z.number(),
  sticker_disc_id: z.string(),
  sticker_name: z.string(),
  sticker_desc: z.string().default(""),
  emotion_key: z.string(),
  is_global: z.boolean().default(false),
  sticker_format: z.nativeEnum(StickerFormatType).default(StickerFormatType.PNG),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type ServerStickerRow = z.infer<typeof serverStickerSchema>;

export const serverMemorySchema = z.object({
  server_memory_id: z.number().optional(),
  server_id: z.number(),
  persona_id: z.number().nullable().optional(),
  persona_lineage_id: z.preprocess((value) => {
    if (typeof value === "bigint") {
      return Number(value);
    }
    if (typeof value === "string" && value.trim() !== "") {
      return Number(value);
    }
    return value;
  }, z.number().int().nonnegative()),
  user_id: z.number().nullable(), // Nullable - set to NULL if user deleted
  content: z.string(),
  tags: z.preprocess((v) => (Array.isArray(v) ? v : []), z.array(z.string().max(32)).max(5)),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type ServerMemoryRow = z.infer<typeof serverMemorySchema>;

export const conditioningHistorySchema = z.object({
  conditioning_id: z.number().optional(),
  server_id: z.number(),
  persona_lineage_id: z.preprocess((value) => {
    if (typeof value === "bigint") {
      return Number(value);
    }
    if (typeof value === "string" && value.trim() !== "") {
      return Number(value);
    }
    return value;
  }, z.number().int().nonnegative()),
  conditioning_type: conditioningTypeSchema,
  action_key: z.string(),
  reason_text: z.string(),
  reason_normalized: z.string(),
  action_text: z.string().nullable().optional(),
  user_id: z.number(),
  count: z.number().int().min(1).default(1),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type ConditioningHistoryRow = z.infer<typeof conditioningHistorySchema>;

export const personalMemorySchema = z.object({
  personal_memory_id: z.number().optional(),
  user_id: z.number(),
  persona_lineage_id: z.preprocess((value) => {
    if (typeof value === "bigint") {
      return Number(value);
    }
    if (typeof value === "string" && value.trim() !== "") {
      return Number(value);
    }
    return value;
  }, z.number().int().nonnegative()),
  content: z.string(),
  tags: z.preprocess((v) => (Array.isArray(v) ? v : []), z.array(z.string().max(32)).max(5)),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type PersonalMemoryRow = z.infer<typeof personalMemorySchema>;
const personaUserBlockTypeSchema = z.enum(["mute", "block"]);
export type PersonaUserBlockType = z.infer<typeof personaUserBlockTypeSchema>;

export const personaUserBlockSchema = z.object({
  server_id: z.number().int(),
  persona_id: z.number().int(),
  user_disc_id: z.string(),
  block_type: personaUserBlockTypeSchema,
  reason: z.string(),
  expires_at: z.date(),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type PersonaUserBlockRow = z.infer<typeof personaUserBlockSchema>;

/**
 * Channel Whitelist Schema
 * Defines channel allowlist entries with optional per-channel cooldown overrides.
 * When ANY channel is whitelisted, ONLY whitelisted channels can trigger the bot.
 */
const channelWhitelistSchema = z.object({
  server_id: z.number(),
  channel_disc_id: z.string(),
  cooldown_type: z.nativeEnum(CooldownType).nullable().default(null),
  cooldown_length: z.number().int().min(0).max(86400).nullable().default(null),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type ChannelWhitelistRow = z.infer<typeof channelWhitelistSchema>;

/**
 * Role Whitelist Schema
 * Defines role-based trigger access for server-wide whitelist restrictions.
 * When ANY role is whitelisted, only members with whitelisted roles can trigger the bot.
 */
const roleWhitelistSchema = z.object({
  server_id: z.number(),
  role_disc_id: z.string(),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type RoleWhitelistRow = z.infer<typeof roleWhitelistSchema>;

/**
 * Channel Persona Whitelist Schema
 * Defines persona-specific channel allowlists for automatic message triggers.
 * If a channel has no entries, all personas remain eligible in that channel.
 */
const channelPersonaWhitelistSchema = z.object({
  server_id: z.number(),
  channel_disc_id: z.string(),
  persona_id: z.number().int(),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type ChannelPersonaWhitelistRow = z.infer<typeof channelPersonaWhitelistSchema>;

export interface ErrorContext {
  personaId?: number | null;
  userId?: number | null;
  serverId?: number | null; // Database ID only - use metadata for Discord snowflakes
  errorType?: string;
  metadata?: Record<string, unknown> | null;
}

const optApiKeySchema = z.object({
  opt_api_key_id: z.number().optional(), // Primary key, optional as it's generated
  server_id: z.number(), // Foreign key to servers table
  service_name: z.string(), // Service name identifier (e.g., 'brave-search', 'duckduckgo-search', 'fetch')
  api_key: z.instanceof(Buffer).nullable(), // Encrypted API key using pgcrypto, nullable for free services
  key_version: z.number().int().default(1).optional(), // Added November 2025 - Encryption key version for rotation
  created_at: z.date().optional(), // Handled by DB default
  updated_at: z.date().optional(), // Handled by DB default/trigger
});
export type OptApiKeyRow = z.infer<typeof optApiKeySchema>;

export const reminderSchema = z.object({
  reminder_id: z.number().optional(), // Primary key, optional as it's generated
  server_id: z.number(), // Foreign key to servers table
  server_disc_id: z.string().optional(), // Joined routing identity for scheduler-triggered turns
  server_is_dm_channel: z.boolean().optional(), // Joined routing scope for scheduler-triggered turns
  channel_disc_id: z.string(), // Discord channel ID where reminder was set
  user_discord_id: z.string(), // Target user's Discord ID
  user_nickname: z.string(), // Target user's nickname for display
  reminder_purpose: z.string(), // What the reminder is for
  reminder_time: z.date(), // When to trigger the reminder (TIMESTAMP WITH TIME ZONE)
  next_attempt_at: z.date().nullable().optional(), // Retry lease; canonical cadence stays in reminder_time
  delivery_retry_count: z.number().int().nonnegative().default(0),
  repetition_interval_hours: z.number().int().nullable().optional(), // Optional: repeat interval in hours
  self_reminder: z.boolean().nullable().optional(), // Optional: reminder targets the bot itself
  created_by_user_id: z.number().nullable(), // Who requested the reminder (nullable - set to NULL if user deleted)
  persona_id: z.number().nullable().optional(), // Persona that created the reminder (nullable - fallback to main)
  created_at: z.date().optional(), // Handled by DB default
  updated_at: z.date().optional(), // Handled by DB default/trigger
});
export type ReminderRow = z.infer<typeof reminderSchema>;

/**
 * API Key Rotation error types for cooldown logic
 * - rate_limit: 429 errors, 60-second cooldown
 * - api_error: Other API errors (401, 403, etc.), 5-minute cooldown
 */
export const ApiKeyRotationErrorType = z.enum(["rate_limit", "api_error"]);
export type ApiKeyRotationErrorType = z.infer<typeof ApiKeyRotationErrorType>;

const coerceNumber = z.preprocess((value) => {
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    return Number(value);
  }
  return value;
}, z.number());

const coerceIntNumber = z.preprocess((value) => {
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    return Number(value);
  }
  return value;
}, z.number().int());

/**
 * Schema for api_key_rotation table (config/security columns only).
 * Runtime telemetry lives in api_key_rotation_runtime_state.
 */
const apiKeyRotationConfigSchema = z.object({
  rotation_key_id: z.number().optional(), // Primary key, auto-generated
  server_id: z.number(), // Foreign key to servers table
  provider: z.string(), // Must match the active provider for this server
  api_key: z.instanceof(Buffer).nullable(), // NULL if is_main_key_pointer = true
  key_version: z.number().int().default(1), // Encryption key version
  is_main_key_pointer: z.boolean().default(false), // true = use the assembled server config api_key
  is_enabled: z.boolean().default(true), // Manual or auto-disabled after errors
  created_at: z.date().optional(), // Handled by DB default
  updated_at: z.date().optional(), // Handled by DB default/trigger
});

/**
 * Schema for api_key_rotation_runtime_state table.
 * Excluded from export; reset independently of config/credentials.
 */
const apiKeyRotationRuntimeStateSchema = z.object({
  rotation_key_id: z.number(), // PK + FK → api_key_rotation(rotation_key_id) ON DELETE CASCADE
  usage_count: coerceNumber.default(0), // For round-robin tracking
  error_count: coerceIntNumber.default(0), // Consecutive errors since last success
  last_used_at: z.date().nullable().optional(), // Last successful API call
  last_error_at: z.date().nullable().optional(), // For cooldown logic
  last_error_type: ApiKeyRotationErrorType.nullable().optional(), // Error category for cooldown
  last_error_message: z.string().nullable().optional(), // Human-readable error (truncated to 500)
  updated_at: z.date().optional(), // Handled by DB default/trigger
});
/**
 * Schema for the joined api_key_rotation + api_key_rotation_runtime_state row.
 * All key selection queries JOIN both tables; this is the shape returned to callers.
 */
export const apiKeyRotationSchema = apiKeyRotationConfigSchema.merge(
  apiKeyRotationRuntimeStateSchema.omit({ rotation_key_id: true }),
);
export type ApiKeyRotationRow = z.infer<typeof apiKeyRotationSchema>;

/**
 * Schema for image quota configuration (per-server settings)
 * Controls daily user quotas and server-wide quota pools
 */
export const imageQuotaConfigSchema = z.object({
  server_id: z.number(), // Foreign key to servers table
  daily_user_quota: z.number().int().min(0).max(100).default(0), // Per-user daily limit (0 = unlimited)
  serverwide_quota: z.number().int().min(0).max(99999).default(0), // Total server quota (0 = unlimited)
  serverwide_quota_resets_in: z.number().int().min(0).max(365).default(365), // Days before server quota resets (1-365)
  enabled: z.boolean().default(false), // Master toggle for quota system
  created_at: z.date().optional(), // Handled by DB default
  updated_at: z.date().optional(), // Handled by DB default/trigger
});
export type ImageQuotaConfigRow = z.infer<typeof imageQuotaConfigSchema>;

/**
 * Schema for per-user daily image quota tracking
 * Resets daily at midnight (server timezone)
 */
export const imageQuotaSchema = z.object({
  quota_id: z.number().optional(), // Primary key, auto-generated
  server_id: z.number(), // Foreign key to servers table
  user_disc_id: z.string(), // User's Discord ID
  usage_count: z.number().int().min(0).default(0), // Images generated today
  quota_date: z.date(), // Date this quota is for (YYYY-MM-DD)
  last_reset: z.date().optional(), // Handled by DB default
});
export type ImageQuotaRow = z.infer<typeof imageQuotaSchema>;

/**
 * Schema for server-wide image quota tracking
 * Resets based on serverwide_quota_resets_in configuration
 */
export const serverwideQuotaSchema = z.object({
  server_id: z.number(), // Primary key, foreign key to servers table
  usage_count: z.number().int().min(0).default(0), // Total images generated this period
  quota_period_start: z.date(), // When this quota period started
  quota_period_end: z.date(), // When this quota period ends (calculated from config)
  last_updated: z.date().optional(), // Handled by DB default
});
export type ServerwideQuotaRow = z.infer<typeof serverwideQuotaSchema>;

/**
 * Schema for text quota configuration (per-server settings)
 * Controls daily user quotas and server-wide quota pools for text generations
 */
export const textQuotaConfigSchema = z.object({
  server_id: z.number(), // Foreign key to servers table
  daily_user_quota: z.number().int().min(0).max(100).default(0), // Per-user daily limit (0 = unlimited)
  serverwide_quota: z.number().int().min(0).max(99999).default(0), // Total server quota (0 = unlimited)
  serverwide_quota_resets_in: z.number().int().min(0).max(365).default(365), // Days before server quota resets (1-365)
  enabled: z.boolean().default(false), // Master toggle for quota system
  created_at: z.date().optional(), // Handled by DB default
  updated_at: z.date().optional(), // Handled by DB default/trigger
});
export type TextQuotaConfigRow = z.infer<typeof textQuotaConfigSchema>;

/**
 * Schema for per-user daily text quota tracking
 * Resets daily at midnight (server timezone)
 */
export const textQuotaSchema = z.object({
  quota_id: z.number().optional(), // Primary key, auto-generated
  server_id: z.number(), // Foreign key to servers table
  user_disc_id: z.string(), // User's Discord ID
  usage_count: z.number().int().min(0).default(0), // Text generations triggered today
  quota_date: z.date(), // Date this quota is for (YYYY-MM-DD)
  last_reset: z.date().optional(), // Handled by DB default
});
export type TextQuotaRow = z.infer<typeof textQuotaSchema>;

/**
 * Schema for server-wide text quota tracking
 * Resets based on serverwide_quota_resets_in configuration
 */
export const textServerwideQuotaSchema = z.object({
  server_id: z.number(), // Primary key, foreign key to servers table
  usage_count: z.number().int().min(0).default(0), // Total text generations this period
  quota_period_start: z.date(), // When this quota period started
  quota_period_end: z.date(), // When this quota period ends (calculated from config)
  updated_at: z.date().optional(), // Handled by DB default
});
export type TextServerwideQuotaRow = z.infer<typeof textServerwideQuotaSchema>;

/**
 * Schema for video quota configuration (per-server settings)
 * Controls daily user quotas and server-wide quota pools for video generation
 */
export const videoQuotaConfigSchema = z.object({
  server_id: z.number(), // Foreign key to servers table
  daily_user_quota: z.number().int().min(0).max(100).default(0), // Per-user daily limit (0 = unlimited)
  serverwide_quota: z.number().int().min(0).max(99999).default(0), // Total server quota (0 = unlimited)
  serverwide_quota_resets_in: z.number().int().min(0).max(365).default(365), // Days before server quota resets (1-365)
  enabled: z.boolean().default(false), // Master toggle for quota system
  created_at: z.date().optional(), // Handled by DB default
  updated_at: z.date().optional(), // Handled by DB default/trigger
});
export type VideoQuotaConfigRow = z.infer<typeof videoQuotaConfigSchema>;

/**
 * Schema for per-user daily video quota tracking
 * Resets daily at midnight (server timezone)
 */
export const videoQuotaSchema = z.object({
  quota_id: z.number().optional(), // Primary key, auto-generated
  server_id: z.number(), // Foreign key to servers table
  user_disc_id: z.string(), // User's Discord ID
  usage_count: z.number().int().min(0).default(0), // Videos generated today
  quota_date: z.date(), // Date this quota is for (YYYY-MM-DD)
  last_reset: z.date().optional(), // Handled by DB default
});
export type VideoQuotaRow = z.infer<typeof videoQuotaSchema>;

/**
 * Schema for server-wide video quota tracking
 * Resets based on serverwide_quota_resets_in configuration
 */
export const videoServerwideQuotaSchema = z.object({
  server_id: z.number(), // Primary key, foreign key to servers table
  usage_count: z.number().int().min(0).default(0), // Total videos generated this period
  quota_period_start: z.date(), // When this quota period started
  quota_period_end: z.date(), // When this quota period ends (calculated from config)
  updated_at: z.date().optional(), // Handled by DB default
});
export type VideoServerwideQuotaRow = z.infer<typeof videoServerwideQuotaSchema>;
export const randomTriggerSchema = z.object({
  trigger_id: z.number().optional(), // Primary key, auto-generated
  server_id: z.number(), // Foreign key to servers table
  channel_disc_id: z.string(), // Discord channel ID where trigger fires
  persona_id: z.number().nullable().optional(), // NULL = "Random" persona selection
  timer_hours: z.number().int().min(1), // How often to roll the dice (hours)
  random_offset_range: z.number().int().min(0).nullable().optional(), // Optional +/- jitter range (hours)
  chance_percent: z.number().int().min(1).max(100), // Probability of firing (1-100%)
  silence_threshold_hours: z.number().int().nullable().optional(), // Skip if channel active within N hours
  respond_to_self: z.boolean().default(false), // Whether to fire if persona spoke last
  custom_prompt: z.string().nullable().optional(), // Optional injected system prompt
  failure_threshold: z.number().int().min(1).nullable().optional(), // NULL = disabled; force-fire after N consecutive misses
  consecutive_failures: z.number().int().min(0).default(0).optional(), // Current consecutive miss count; resets on fire
  next_trigger_at: z.date(), // Scheduled time for next dice roll
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type RandomTriggerRow = z.infer<typeof randomTriggerSchema>;

/**
 * Tomori's combined state (base config + LLM settings + LLM info)
 */
export type TomoriState = TomoriRow &
  PersonaScopedConfigState & {
    config: AssembledServerConfig;
    llm: LlmRow; // Added LLM information
    trigger_words: string[]; // Persona-scoped trigger words from persona_configs
    persona_prompt: string | null; // Optional persona-specific prompt appended after system prompt
    naming_config: PersonaNamingConfig;
    persona_attributes: PersonaAttributeRow[]; // Ordered persona attributes with public/private visibility
    reward_conditioning_enabled: boolean; // Persona-scoped reward conditioning injection toggle
    punish_conditioning_enabled: boolean; // Persona-scoped punish conditioning injection toggle
    humanizer_degree_override: number | null; // Persona-scoped humanizer override; when set, load-time overlay writes it onto config.humanizer_degree
    server_memories: string[]; // Changed to string array to match implementation
    rotation_keys?: ApiKeyRotationRow[]; // Optional: API key rotation pool for load balancing/failover
    persona_llm?: LlmRow; // Added March 2026 - Persona-specific model override (highest priority in chain)
    vision_llm?: LlmRow; // Added March 2026 - Dedicated vision model for non-vision chat models
    nai_preset?: NaiPresetRow; // Added March 2026 - Active NovelAI sampling preset (null when not using NAI)
    fallback_llms?: LlmRow[]; // Added March 2026 - Resolved LLM rows for fallback model failover chain (legacy; prefer fallback_chain)
    fallback_chain?: FallbackEntry[]; // Added April 2026 - Ordered fallback entries resolving both llm and custom_endpoint refs
    // Autochat runtime counters from persona_autoch_runtime_state (migration 015).
    autoch_counter: number;
    autoch_next_target: number;
  };

/**
 * Schema for validating the combined Tomori state
 */
export const tomoriStateSchema = tomoriSchema.merge(personaScopedConfigStateSchema).extend({
  config: assembledServerConfigSchema,
  llm: llmSchema, // Added LLM schema validation
  trigger_words: z.array(z.string()).default([]),
  persona_prompt: z.string().nullable().default(null),
  naming_config: personaNamingConfigSchema.default(EMPTY_PERSONA_NAMING_CONFIG),
  persona_attributes: z.array(personaAttributeSchema).default([]),
  reward_conditioning_enabled: z.boolean().default(true),
  punish_conditioning_enabled: z.boolean().default(true),
  humanizer_degree_override: z.number().int().min(0).max(3).nullable().default(null), // Persona humanizer override; NULL = inherit global
  server_memories: z.array(z.string()).default([]), // Changed to array of strings
  rotation_keys: z.array(apiKeyRotationSchema).optional(), // API key rotation pool
  persona_llm: llmSchema.optional(), // Added March 2026 - Persona-specific model override
  vision_llm: llmSchema.optional(), // Added March 2026 - Dedicated vision model for non-vision chat models
  nai_preset: naiPresetSchema.optional(), // Added March 2026 - Active NovelAI sampling preset
  fallback_llms: z.array(llmSchema).optional(), // Added March 2026 - Resolved fallback LLM rows (legacy; prefer fallback_chain)
  fallback_chain: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("llm"), model: llmSchema }),
        z.object({ kind: z.literal("custom_endpoint"), endpoint: customEndpointSchema }),
      ]),
    )
    .optional(), // Added April 2026 - Ordered fallback entries (llm + custom_endpoint refs)
  // Autochat runtime counters loaded from persona_autoch_runtime_state (migration 015).
  autoch_counter: z.number().int().default(0),
  autoch_next_target: z.number().int().default(0),
});

/**
 * Configuration data needed for server setup
 */
export const setupConfigSchema = z
  .object({
    serverId: z.string(),
    encryptedApiKey: z.instanceof(Buffer).nullable(),
    keyVersion: z.number().int().default(1), // Encryption key version
    provider: z.string().nullable(), // Null when bootstrapping without an immediate server text provider
    presetId: z.number(),
    humanizer: z.number().default(1),
    tomoriName: z.string(),
    timezoneOffset: z.number().int().min(-12).max(14).default(0), // Timezone offset in hours
    locale: z.string(),
    registrationLocale: z.string().nullable(), // Analytics-only locale captured at setup; not used for functionality
    userByokMode: z.boolean().default(false),
    deferredCustomEndpointSetup: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (!value.userByokMode && !value.deferredCustomEndpointSetup && (!value.provider || !value.encryptedApiKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Standard setup requires both provider and encrypted API key.",
        path: ["provider"],
      });
    }
  });
export type SetupConfig = z.infer<typeof setupConfigSchema>;

/**
 * Result of the setup operation, containing all created database rows
 */
export const setupResultSchema = z.object({
  server: serverSchema,
  tomori: tomoriSchema,
  emojis: z.array(serverEmojiSchema),
  stickers: z.array(serverStickerSchema),
});
export type SetupResult = z.infer<typeof setupResultSchema>;

/**
 * Guild MCP Server : per-guild remote MCP server registration.
 * Stored in guild_mcp_servers table; auth_token is PGP-encrypted BYTEA and
 * last_discovered_tool_names is display-only metadata, never an invocation source.
 */
const guildMcpServerSchema = z.object({
  guild_mcp_id: z.number().optional(),
  server_id: z.number(),
  name: z.string(),
  url: z.string(),
  auth_token: z.instanceof(Buffer).nullable().optional(),
  key_version: z.number().int().default(1),
  is_enabled: z.boolean().default(true),
  server_type: z.string().nullable().optional(),
  last_discovered_tool_names: z.array(z.string()).nullable().optional(),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type GuildMcpServerRow = z.infer<typeof guildMcpServerSchema>;

/**
 * Saved Provider Config : snapshot of provider-specific settings stored in
 * saved_provider_configs. One row per provider per server; UPSERT on save.
 */
export const savedProviderConfigSchema = z.object({
  saved_config_id: z.number().optional(),
  server_id: z.number(),
  provider: z.string(),
  api_key: z.instanceof(Buffer).nullable(),
  key_version: z.number().int().default(1),
  llm_id: z.number().nullable(),
  diffusion_model_id: z.number().nullable(),
  embedding_model_id: z.number().nullable(),
  nai_diffusion_model_id: z.number().nullable(),
  video_model_id: z.number().nullable().optional(), // Added April 2026 - Video model snapshot
  vision_llm_id: z.number().nullable().optional(), // Added March 2026 - Vision model snapshot
  nai_preset_name: z.string().nullable(),
  llm_temperature: z.number().nullable().optional(), // Added March 2026 - Sampler snapshot
  llm_top_p: z.number().nullable().optional(), // Added March 2026 - Sampler snapshot
  llm_top_k: z.number().int().nullable().optional(), // Added March 2026 - Sampler snapshot
  llm_frequency_penalty: z.number().nullable().optional(), // Added March 2026 - Sampler snapshot
  llm_presence_penalty: z.number().nullable().optional(), // Added March 2026 - Sampler snapshot
  llm_min_p: z.number().nullable().optional(), // Added March 2026 - Sampler snapshot
  llm_max_output_tokens: z.number().int().min(1).nullable().optional(), // Added April 2026 - Max output tokens override snapshot
  llm_disabled_params: z.preprocess(
    (value) => normalizeDisabledLlmParams(value),
    z.array(supportedParamSchema).default([]),
  ), // Added April 2026 - Omitted parameter snapshot
  llm_logit_biases: z.preprocess(
    (value) => normalizeLogitBiasEntries(value),
    z.array(logitBiasEntrySchema).default([]),
  ), // Added March 2026 - Logit bias snapshot
  thinking_level: z.enum(THINKING_LEVEL_VALUES).default(DEFAULT_THINKING_LEVEL),
  fallback_model_refs: z.preprocess(
    (value) => normalizeFallbackModelRefs(value),
    fallbackModelRefSchema.array().default([]),
  ),
  saved_at: z.coerce.date().optional(),
  updated_at: z.coerce.date().optional(),
});
export type SavedProviderConfigRow = z.infer<typeof savedProviderConfigSchema>;

/**
 * Input type for upserting a saved provider config.
 * Omits auto-generated fields (saved_config_id, saved_at, updated_at).
 */
export type SavedProviderConfigUpsert = Omit<SavedProviderConfigRow, "saved_config_id" | "saved_at" | "updated_at">;

export const personalProviderCapabilitySchema = z.enum(["text", "embedding", "image", "video", "vision"]);
export type PersonalProviderCapability = z.infer<typeof personalProviderCapabilitySchema>;

/**
 * User Saved Provider Config : personal provider snapshot stored in
 * user_saved_provider_configs. One row per provider per user; UPSERT on save.
 */
export const userSavedProviderConfigSchema = z.object({
  user_saved_config_id: z.number().optional(),
  user_id: z.number(),
  provider: z.string(),
  api_key: z.instanceof(Buffer).nullable(),
  key_version: z.number().int().default(1),
  llm_id: z.number().nullable(),
  diffusion_model_id: z.number().nullable(),
  embedding_model_id: z.number().nullable(),
  nai_diffusion_model_id: z.number().nullable(),
  video_model_id: z.number().nullable().optional(),
  vision_llm_id: z.number().nullable().optional(),
  nai_preset_name: z.string().nullable(),
  llm_temperature: z.number().nullable().optional(),
  llm_top_p: z.number().nullable().optional(),
  llm_top_k: z.number().int().nullable().optional(),
  llm_frequency_penalty: z.number().nullable().optional(),
  llm_presence_penalty: z.number().nullable().optional(),
  llm_min_p: z.number().nullable().optional(),
  llm_max_output_tokens: z.number().int().min(1).nullable().optional(), // Added April 2026 - Max output tokens override snapshot
  llm_disabled_params: z.preprocess(
    (value) => normalizeDisabledLlmParams(value),
    z.array(supportedParamSchema).default([]),
  ),
  llm_logit_biases: z.preprocess(
    (value) => normalizeLogitBiasEntries(value),
    z.array(logitBiasEntrySchema).default([]),
  ),
  thinking_level: z.enum(THINKING_LEVEL_VALUES).default(DEFAULT_THINKING_LEVEL),
  // Which of this row's assigned capabilities are currently switched on.
  // Always a subset of assigned_capabilities; see migration 060 for why the two are separate.
  enabled_capabilities: z.preprocess(
    (value) => normalizeEnabledCapabilities(value),
    z.array(personalProviderCapabilitySchema).default([]),
  ),
  // Which capabilities this row owns. Survives being switched off, so re-enabling
  // returns to the provider the user actually chose.
  assigned_capabilities: z.preprocess(
    (value) => normalizeEnabledCapabilities(value),
    z.array(personalProviderCapabilitySchema).default([]),
  ),
  fallback_model_refs: z.preprocess(
    (value) => normalizeFallbackModelRefs(value),
    fallbackModelRefSchema.array().default([]),
  ),
  saved_at: z.coerce.date().optional(),
  updated_at: z.coerce.date().optional(),
});
export type UserSavedProviderConfigRow = z.infer<typeof userSavedProviderConfigSchema>;

/**
 * Input type for upserting a user saved provider config.
 * Omits auto-generated fields (user_saved_config_id, saved_at, updated_at).
 */
export type UserSavedProviderConfigUpsert = Omit<
  UserSavedProviderConfigRow,
  "user_saved_config_id" | "saved_at" | "updated_at"
>;

/**
 * SillyTavern Preset : imported preset metadata + raw JSON blob.
 * Stored in st_presets table; scoped per server_id.
 * Multiple presets may exist per server; only one is active at a time.
 */
const stPresetSchema = z.object({
  preset_id: z.number().optional(),
  server_id: z.number(),
  preset_name: z.string(),
  raw_json: z.unknown(),
  is_active: z.boolean().default(false),
  description: z.string().nullable().optional(),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type StPresetRow = z.infer<typeof stPresetSchema>;

/**
 * SillyTavern Preset Node : individual toggleable prompt node parsed
 * from a preset's prompts array. Stored in st_preset_nodes table.
 * Nodes are ordered by node_order (matching the preset's prompt_order).
 */
const stPresetNodeSchema = z.object({
  node_id: z.number().optional(),
  preset_id: z.number(),
  identifier: z.string(),
  name: z.string(),
  role: z.string().default("system"),
  content: z.string().default(""),
  is_marker: z.boolean().default(false),
  is_enabled: z.boolean().default(true),
  is_comment: z.boolean().default(false),
  node_order: z.number(),
  injection_position: z.number().default(0),
  injection_depth: z.number().default(4),
  injection_order: z.number().default(100),
});
export type StPresetNodeRow = z.infer<typeof stPresetNodeSchema>;
