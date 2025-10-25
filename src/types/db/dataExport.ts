import { z } from "zod";

/**
 * Version identifier for export/import format
 * Increment when breaking changes are made to the export format
 */
export const EXPORT_VERSION = "1.0";

/**
 * Personal data export schema
 * Validates the structure of exported personal user data
 */
export const personalExportDataSchema = z.object({
	user_nickname: z.string().min(1).max(100),
	language_pref: z.string().min(2).max(10),
	personal_memories: z.array(z.string()).max(50),
});

export type PersonalExportData = z.infer<typeof personalExportDataSchema>;

/**
 * Complete personal export file schema
 */
export const personalExportSchema = z.object({
	version: z.literal(EXPORT_VERSION),
	type: z.literal("personal"),
	exported_at: z.string(),
	data: personalExportDataSchema,
});

export type PersonalExport = z.infer<typeof personalExportSchema>;

/**
 * Server configuration export schema
 * Excludes sensitive data (API keys) and data managed by other commands (trigger words, personality)
 */
export const serverConfigExportSchema = z.object({
	llm_temperature: z.number().min(1.0).max(2.0),
	humanizer_degree: z.number().int().min(0).max(3),
	timezone_offset: z.number().int().min(-12).max(14),
	server_memteaching_enabled: z.boolean(),
	attribute_memteaching_enabled: z.boolean(),
	sampledialogue_memteaching_enabled: z.boolean(),
	self_teaching_enabled: z.boolean(),
	web_search_enabled: z.boolean(),
	personal_memories_enabled: z.boolean(),
	emoji_usage_enabled: z.boolean(),
	sticker_usage_enabled: z.boolean(),
});

export type ServerConfigExport = z.infer<typeof serverConfigExportSchema>;

/**
 * Server data export schema
 * Includes configuration and server memories
 */
export const serverExportDataSchema = z.object({
	config: serverConfigExportSchema,
	server_memories: z.array(z.string()).max(50),
});

export type ServerExportData = z.infer<typeof serverExportDataSchema>;

/**
 * Complete server export file schema
 */
export const serverExportSchema = z.object({
	version: z.literal(EXPORT_VERSION),
	type: z.literal("server"),
	exported_at: z.string(),
	data: serverExportDataSchema,
});

export type ServerExport = z.infer<typeof serverExportSchema>;

/**
 * Union type for all export formats
 */
export type DataExport = PersonalExport | ServerExport;

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
