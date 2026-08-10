/**
 * Type definitions and schemas for TomoriBot preset export/import system
 * Enables sharing personalities as PNG files with embedded metadata
 */

import { z } from "zod";
import {
  EMPTY_PERSONA_NAMING_CONFIG,
  personaNamingConfigSchema,
  type PersonaNamingConfig,
} from "@/types/personaNaming";

/**
 * Current version of the preset export format
 * Used for compatibility checking during import
 */
export const PRESET_EXPORT_VERSION = "1.0.0";

/**
 * Internal marker used for model-only sample dialogues (no paired user turn).
 * Context builder detects this value and skips injecting a user example turn.
 */
export const UNPAIRED_SAMPLE_DIALOGUE_SENTINEL = "__UNPAIRED_SAMPLE_DIALOGUE__";

function parsePositiveIntegerEnv(name: string, defaultValue: number): number {
  const parsedValue = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : defaultValue;
}

/**
 * Preset import/export schema limits.
 * Admins can raise these with env vars, but doing so affects untrusted import files
 * and cross-instance preset portability.
 */
export const PRESET_MAX_STRING_LENGTH = parsePositiveIntegerEnv("PRESET_MAX_STRING_LENGTH", 5000);
export const PRESET_MAX_ATTRIBUTES = parsePositiveIntegerEnv("PRESET_MAX_ATTRIBUTES", 200);
const PRESET_MAX_SAMPLE_DIALOGUES = parsePositiveIntegerEnv("PRESET_MAX_SAMPLE_DIALOGUES", 100);
const PRESET_MAX_TRIGGER_WORDS = parsePositiveIntegerEnv("PRESET_MAX_TRIGGER_WORDS", 100);
const PRESET_MAX_IMAGE_TAGS = parsePositiveIntegerEnv("PRESET_MAX_IMAGE_TAGS", 200);

/**
 * Generated presets use the canonical 6-attribute layout from presetCommon.ts:
 * Description, Appearance, Personality, Likes, Dislikes, Behavioral Quirks.
 */
const GENERATED_PRESET_APPEARANCE_ATTRIBUTE_INDEX = 1;

export function buildPrivateAttributePublicFlags(attributeList: readonly string[]): boolean[] {
  return attributeList.map(() => false);
}

export function buildGeneratedPresetAttributePublicFlags(attributeList: readonly string[]): boolean[] {
  return attributeList.map((_attribute, index) => index === GENERATED_PRESET_APPEARANCE_ATTRIBUTE_INDEX);
}

/**
 * Preset personality data structure
 * Contains all personality-related fields from personas and persona-scoped config tables.
 */
export interface PresetExportData {
  tomori_nickname: string;
  attribute_list: string[];
  /** Visibility flags aligned to attribute_list; true exposes the attribute to other triggered personas */
  attribute_public_flags?: boolean[];
  sample_dialogues_in: string[];
  sample_dialogues_out: string[];
  trigger_words: string[];
  persona_prompt?: string | null;
  naming_config?: PersonaNamingConfig;
  persona_lineage_id?: number;
  /** Official preset lineage, when this export was materialized from a preset pointer */
  preset_lineage_id?: number;
  /** Public imageboard-style persona physical appearance tags for image generation */
  physical_appearance_tags?: string[];
  /** Persona-specific NovelAI character reference image URL */
  nai_char_ref_url?: string | null;
  /** ATTG: Story author name */
  nai_attg_author?: string | null;
  /** ATTG: Story title */
  nai_attg_title?: string | null;
  /** ATTG: Genre/style tags */
  nai_attg_tags?: string | null;
  /** ATTG: Genre categories */
  nai_attg_genre?: string | null;
  /** ATTG: Quality stars (Erato only, 1-5) */
  nai_attg_stars?: number | null;
}

/**
 * Complete preset export structure with metadata
 * This is what gets embedded in the PNG tEXt chunk
 */
export interface PresetExport {
  version: string;
  type: "preset";
  exported_at: string; // ISO 8601 timestamp
  data: PresetExportData;
}

/**
 * Result type for export operations
 */
export type ExportResult =
  | {
      success: true;
      data: PresetExport;
    }
  | {
      success: false;
      error: string; // Locale key for error message
    };

/**
 * Result type for import operations
 */
export type ImportResult =
  | {
      success: true;
      itemsImported: {
        nickname: string;
        attributeCount: number;
        dialogueCount: number;
        triggerWordCount: number;
      };
    }
  | {
      success: false;
      error: string; // Locale key or pipe-separated error with variables
    };

/**
 * Validation result for import file structure
 */
export interface ValidationResult {
  valid: boolean;
  data?: PresetExportData;
  error?: string; // Locale key or pipe-separated error
}

/**
 * Zod schema for preset export data validation
 */
export const presetExportDataSchema = z.object({
  tomori_nickname: z.string().min(1, "Nickname cannot be empty").max(100, "Nickname too long"),
  attribute_list: z.array(z.string().max(PRESET_MAX_STRING_LENGTH)).max(PRESET_MAX_ATTRIBUTES),
  attribute_public_flags: z.array(z.boolean()).max(PRESET_MAX_ATTRIBUTES).optional(),
  sample_dialogues_in: z.array(z.string().max(PRESET_MAX_STRING_LENGTH)).max(PRESET_MAX_SAMPLE_DIALOGUES),
  sample_dialogues_out: z.array(z.string().max(PRESET_MAX_STRING_LENGTH)).max(PRESET_MAX_SAMPLE_DIALOGUES),
  trigger_words: z.array(z.string().max(PRESET_MAX_STRING_LENGTH)).max(PRESET_MAX_TRIGGER_WORDS),
  persona_prompt: z.string().max(PRESET_MAX_STRING_LENGTH).nullable().optional(),
  naming_config: personaNamingConfigSchema.default(EMPTY_PERSONA_NAMING_CONFIG),
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
    .optional(),
  preset_lineage_id: z
    .preprocess((value) => {
      if (typeof value === "bigint") {
        return Number(value);
      }
      if (typeof value === "string" && value.trim() !== "") {
        return Number(value);
      }
      return value;
    }, z.number().int().nonnegative())
    .optional(),
  physical_appearance_tags: z.array(z.string().max(PRESET_MAX_STRING_LENGTH)).max(PRESET_MAX_IMAGE_TAGS).optional(),
  nai_char_ref_url: z.string().max(PRESET_MAX_STRING_LENGTH).nullable().optional(),
  nai_attg_author: z.string().max(PRESET_MAX_STRING_LENGTH).nullable().optional(),
  nai_attg_title: z.string().max(PRESET_MAX_STRING_LENGTH).nullable().optional(),
  nai_attg_tags: z.string().max(PRESET_MAX_STRING_LENGTH).nullable().optional(),
  nai_attg_genre: z.string().max(PRESET_MAX_STRING_LENGTH).nullable().optional(),
  nai_attg_stars: z.number().int().min(1).max(5).nullable().optional(),
});

/**
 * Zod schema for complete preset export structure validation
 */
export const presetExportSchema = z.object({
  version: z.string(),
  type: z.literal("preset"),
  exported_at: z.string(), // ISO 8601 format
  data: presetExportDataSchema,
});
