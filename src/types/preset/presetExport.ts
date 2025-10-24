/**
 * Type definitions and schemas for TomoriBot preset export/import system
 * Enables sharing personalities as PNG files with embedded metadata
 */

import { z } from "zod";

/**
 * Current version of the preset export format
 * Used for compatibility checking during import
 */
export const PRESET_EXPORT_VERSION = "1.0.0";

/**
 * Maximum array sizes for validation (prevent DoS attacks)
 */
export const MAX_ARRAY_SIZE = 100;
export const MAX_STRING_LENGTH = 2000; // Per item in arrays

/**
 * Preset personality data structure
 * Contains all personality-related fields from tomoris and tomori_configs tables
 */
export interface PresetExportData {
	tomori_nickname: string;
	attribute_list: string[];
	sample_dialogues_in: string[];
	sample_dialogues_out: string[];
	trigger_words: string[];
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
	tomori_nickname: z
		.string()
		.min(1, "Nickname cannot be empty")
		.max(100, "Nickname too long"),
	attribute_list: z
		.array(z.string().max(MAX_STRING_LENGTH))
		.max(MAX_ARRAY_SIZE),
	sample_dialogues_in: z
		.array(z.string().max(MAX_STRING_LENGTH))
		.max(MAX_ARRAY_SIZE),
	sample_dialogues_out: z
		.array(z.string().max(MAX_STRING_LENGTH))
		.max(MAX_ARRAY_SIZE),
	trigger_words: z
		.array(z.string().max(MAX_STRING_LENGTH))
		.max(MAX_ARRAY_SIZE),
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

/**
 * Type inference from Zod schemas for TypeScript safety
 */
export type PresetExportDataValidated = z.infer<typeof presetExportDataSchema>;
export type PresetExportValidated = z.infer<typeof presetExportSchema>;
