import { z } from "zod";

export const userSchema = z.object({
	user_id: z.number().optional(),
	user_disc_id: z.string(),
	user_nickname: z.string(),
	tomocoins_held: z.number().default(0),
	tomocoins_deposited: z.number().default(0),
	language_pref: z.string().default("en"),
	personal_memories: z.array(z.string()).default([]),
	created_at: z.date().optional(),
});
export type UserRow = z.infer<typeof userSchema>;

export const serverSchema = z.object({
	server_id: z.number().optional(),
	server_disc_id: z.string(),
	created_at: z.date().optional(),
});
export type ServerRow = z.infer<typeof serverSchema>;

export const tomoriSchema = z.object({
	tomori_id: z.number().optional(),
	server_id: z.number(),
	tomori_nickname: z.string(),
	server_memories: z.array(z.string()).default([]),
	attribute_list: z.array(z.string()).default([]),
	sample_dialogues_in: z.array(z.string()).default([]),
	sample_dialogues_out: z.array(z.string()).default([]),
	autoch_counter: z.number().default(0),
	created_at: z.date().optional(),
});
export type TomoriRow = z.infer<typeof tomoriSchema>;

export const llmSchema = z.object({
	llm_id: z.number().optional(),
	llm_provider: z.string(),
	llm_codename: z.string(),
	created_at: z.date().optional(),
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
	personal_memories_enabled: z.boolean().default(true),
	humanizer_enabled: z.boolean().default(true),
	created_at: z.date().optional(),
});
export type TomoriConfigRow = z.infer<typeof tomoriConfigSchema>;

export const tomoriPresetSchema = z.object({
	tomori_preset_id: z.number().optional(),
	tomori_preset_name: z.string(),
	tomori_preset_desc: z.string(),
	preset_attribute_list: z.array(z.string()).default([]),
	preset_sample_dialogues_in: z.array(z.string()).default([]),
	preset_sample_dialogues_out: z.array(z.string()).default([]),
	preset_language: z.string(),
	created_at: z.date().optional(),
});
export type TomoriPresetRow = z.infer<typeof tomoriPresetSchema>;

export const tomoriEmojiSchema = z.object({
	tomori_emoji_id: z.number().optional(),
	tomori_id: z.number(),
	emotion_key: z.string(),
	emoji_code: z.string(),
	created_at: z.date().optional(),
});
export type TomoriEmojiRow = z.infer<typeof tomoriEmojiSchema>;

export const personalizationBlacklistSchema = z.object({
	server_id: z.number(),
	user_id: z.number(),
	created_at: z.date().optional(),
});
export type PersonalizationBlacklistRow = z.infer<
	typeof personalizationBlacklistSchema
>;

export const errorLogSchema = z.object({
	error_log_id: z.number().optional(),
	tomori_id: z.number(),
	user_id: z.number(),
	server_id: z.number(),
	error_type: z.string(),
	error_message: z.string(),
	error_metadata: z.record(z.unknown()),
	created_at: z.date().optional(),
});
export type ErrorLogRow = z.infer<typeof errorLogSchema>;
