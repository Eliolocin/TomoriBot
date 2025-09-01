import { StickerFormatType } from "discord.js";
import { z } from "zod";

export enum HumanizerDegree {
	NONE = 0,
	LIGHT = 1,
	MEDIUM = 2,
	HEAVY = 3,
}

export const userSchema = z.object({
	user_id: z.number().optional(),
	user_disc_id: z.string(),
	user_nickname: z.string(),
	tomocoins_held: z.number().default(0),
	tomocoins_deposited: z.number().default(0),
	language_pref: z.string().default("en-US"),
	personal_memories: z.array(z.string()).default([]),
	created_at: z.date().optional(),
	updated_at: z.date().optional(),
});
export type UserRow = z.infer<typeof userSchema>;

export const serverSchema = z.object({
	server_id: z.number().optional(),
	server_disc_id: z.string(),
	is_dm_channel: z.boolean().default(false), // Added for DM support (January 2025)
	created_at: z.date().optional(),
	updated_at: z.date().optional(),
});
export type ServerRow = z.infer<typeof serverSchema>;

export const tomoriSchema = z.object({
	tomori_id: z.number().optional(),
	server_id: z.number(),
	tomori_nickname: z.string(),
	attribute_list: z.array(z.string()).default([]),
	sample_dialogues_in: z.array(z.string()).default([]),
	sample_dialogues_out: z.array(z.string()).default([]),
	autoch_counter: z.number().default(0),
	created_at: z.date().optional(),
	updated_at: z.date().optional(),
});
export type TomoriRow = z.infer<typeof tomoriSchema>;

export const llmSchema = z.object({
	llm_id: z.number().optional(),
	llm_provider: z.string(),
	llm_codename: z.string(),
	is_smartest: z.boolean().default(false),
	is_default: z.boolean().default(false),
	is_reasoning: z.boolean().default(false),
	llm_description: z.string().nullable().optional(),
	created_at: z.date().optional(),
	updated_at: z.date().optional(),
});
export type LlmRow = z.infer<typeof llmSchema>;

export const tomoriConfigSchema = z.object({
	tomori_config_id: z.number().optional(),
	tomori_id: z.number(),
	llm_id: z.number(),
	llm_temperature: z.number().min(1.0).max(2.0).default(1.5),
	api_key: z.instanceof(Buffer).nullable(),
	trigger_words: z.array(z.string()).default([]),
	autoch_disc_ids: z.array(z.string()).default([]),
	autoch_threshold: z.number().default(0),
	teach_cost: z.number().default(1000),
	gamba_limit: z.number().default(3),
	server_memteaching_enabled: z.boolean().default(true),
	attribute_memteaching_enabled: z.boolean().default(false),
	sampledialogue_memteaching_enabled: z.boolean().default(false),
	self_teaching_enabled: z.boolean().default(true),
	web_search_enabled: z.boolean().default(true), // New: Added for Web Search permission (Brave Search)
	personal_memories_enabled: z.boolean().default(true),
	humanizer_degree: z
		.nativeEnum(HumanizerDegree)
		.default(HumanizerDegree.LIGHT),
	emoji_usage_enabled: z.boolean().default(true), // Added May 5, 2025
	sticker_usage_enabled: z.boolean().default(true), // Added May 5, 2025
	created_at: z.date().optional(),
	updated_at: z.date().optional(),
});
export type TomoriConfigRow = z.infer<typeof tomoriConfigSchema>;

export const tomoriPresetSchema = z.object({
	tomori_preset_id: z.number(),
	tomori_preset_name: z.string(),
	tomori_preset_desc: z.string(),
	preset_attribute_list: z.array(z.string()).default([]),
	preset_sample_dialogues_in: z.array(z.string()).default([]),
	preset_sample_dialogues_out: z.array(z.string()).default([]),
	preset_language: z.string(),
	created_at: z.date().optional(),
	updated_at: z.date().optional(),
});
export type TomoriPresetRow = z.infer<typeof tomoriPresetSchema>;

export const serverEmojiSchema = z.object({
	server_emoji_id: z.number().optional(),
	server_id: z.number(),
	emoji_disc_id: z.string(),
	emoji_name: z.string(),
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
	//is_animated: z.boolean().default(false),
	sticker_format: z
		.nativeEnum(StickerFormatType)
		.default(StickerFormatType.PNG),
	created_at: z.date().optional(),
	updated_at: z.date().optional(),
});
export type ServerStickerRow = z.infer<typeof serverStickerSchema>;

export const serverMemorySchema = z.object({
	server_memory_id: z.number().optional(),
	server_id: z.number(),
	user_id: z.number(),
	content: z.string(),
	created_at: z.date().optional(),
	updated_at: z.date().optional(),
});
export type ServerMemoryRow = z.infer<typeof serverMemorySchema>;

export const personalizationBlacklistSchema = z.object({
	server_id: z.number(),
	user_id: z.number(),
	created_at: z.date().optional(),
	updated_at: z.date().optional(),
});
export type PersonalizationBlacklistRow = z.infer<
	typeof personalizationBlacklistSchema
>;

export const errorLogSchema = z.object({
	error_log_id: z.number().optional(), // Primary key, optional as it's generated
	// Context IDs - Optional because errors can occur outside specific contexts
	tomori_id: z.number().nullable().optional(),
	user_id: z.number().nullable().optional(),
	server_id: z.number().nullable().optional(),
	// Error Details
	error_type: z.string().default("GenericError"), // Categorize the error, default if not specified
	error_message: z.string(), // The main error message, required
	stack_trace: z.string().nullable().optional(), // Dedicated field for stack trace, optional
	error_metadata: z.record(z.unknown()).nullable().optional().default({}), // Flexible JSON for extra context, optional
	// Timestamps
	created_at: z.date().optional(), // Handled by DB default
	updated_at: z.date().optional(), // Handled by DB default/trigger
});
export type ErrorLogRow = z.infer<typeof errorLogSchema>;

export interface ErrorContext {
	tomoriId?: number | null;
	userId?: number | null;
	serverId?: number | string | null;
	errorType?: string;
	metadata?: Record<string, unknown> | null;
}

export const cooldownSchema = z.object({
	user_disc_id: z.string(),
	command_category: z.string(),
	expiry_time: z.number(),
});
export type CooldownRow = z.infer<typeof cooldownSchema>;

export const optApiKeySchema = z.object({
	opt_api_key_id: z.number().optional(), // Primary key, optional as it's generated
	server_id: z.number(), // Foreign key to servers table
	service_name: z.string(), // Service name identifier (e.g., 'brave-search', 'duckduckgo-search', 'fetch')
	api_key: z.instanceof(Buffer).nullable(), // Encrypted API key using pgcrypto, nullable for free services
	created_at: z.date().optional(), // Handled by DB default
	updated_at: z.date().optional(), // Handled by DB default/trigger
});
export type OptApiKeyRow = z.infer<typeof optApiKeySchema>;

/**
 * Tomori's combined state (base config + LLM settings + LLM info)
 */
export type TomoriState = TomoriRow & {
	config: TomoriConfigRow;
	llm: LlmRow; // Added LLM information
	server_memories: string[]; // Changed to string array to match implementation
};

/**
 * Schema for validating the combined Tomori state
 */
export const tomoriStateSchema = tomoriSchema.extend({
	config: tomoriConfigSchema,
	llm: llmSchema, // Added LLM schema validation
	server_memories: z.array(z.string()).default([]), // Changed to array of strings
});

/**
 * Configuration data needed for server setup
 */
export const setupConfigSchema = z.object({
	serverId: z.string(),
	encryptedApiKey: z.instanceof(Buffer),
	provider: z.string(), // LLM provider name (e.g., "google", "openai")
	presetId: z.number(),
	humanizer: z.number().default(1),
	tomoriName: z.string(),
	locale: z.string(),
});
export type SetupConfig = z.infer<typeof setupConfigSchema>;

/**
 * Result of the setup operation, containing all created database rows
 */
export const setupResultSchema = z.object({
	server: serverSchema,
	tomori: tomoriSchema,
	config: tomoriConfigSchema,
	emojis: z.array(serverEmojiSchema),
	stickers: z.array(serverStickerSchema),
});
export type SetupResult = z.infer<typeof setupResultSchema>;
