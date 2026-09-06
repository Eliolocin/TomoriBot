/**
 * Reset-domain classification and SQL.
 *
 * The reset family restores configuration to its database defaults. The classification below is
 * the specification for what a reset touches: every column of every classified table is either
 * reset, preserved, or identity/audit metadata, and a database gate proves that against
 * `information_schema.columns` after migrations rather than against the `CREATE TABLE` text.
 *
 * Reset statements assign SQL `DEFAULT` rather than literal values. A hand-copied default list is
 * what left the legacy reset writing `llm_temperature = 1.2` long after the schema moved to `1.0`,
 * so the live DDL stays authoritative at execution time.
 */

import type { SQL } from "bun";
import { sql } from "@/utils/db/client";

/**
 * Columns a server singleton reset never assigns. `updated_at` is excluded because the reset
 * writes it to the current time as an audit record rather than restoring its default.
 */
export const SERVER_IDENTITY_AUDIT_COLUMNS = ["server_id", "created_at", "updated_at"] as const;

/** Columns a personal reset never assigns, for the same audit and identity reasons. */
export const PERSONAL_IDENTITY_AUDIT_COLUMNS = ["user_id", "user_disc_id", "created_at", "updated_at"] as const;

/** One classified singleton table: a row that is upserted back to its DDL defaults. */
export interface SingletonResetClassification {
  readonly table: string;
  /** Columns assigned SQL `DEFAULT` by the reset. */
  readonly reset: readonly string[];
  /** Columns deliberately carried through the reset unchanged. */
  readonly preserved: readonly string[];
}

/**
 * The 18 singleton configuration rows a server reset restores.
 *
 * Enumerated rather than derived. The natural derivation ("the in-scope `server_*` tables, less the
 * junction, plus the quota configuration tables") is arithmetic, and arithmetic that drops a table
 * inside a destructive transaction fails silently: the reset simply under-resets and reports
 * success. The cardinality is asserted in the database gate for the same reason.
 */
export const SERVER_SINGLETON_RESET_TABLES: readonly SingletonResetClassification[] = [
  {
    table: "server_chat_configs",
    reset: [
      "humanizer_degree",
      "message_fetch_limit",
      "send_message_limit",
      "match_limit",
      "cascade_limit",
      "timezone_offset",
      "self_debug_enabled",
      "model_randomizer_enabled",
      "system_prompt",
      "context_note",
      "context_note_depth",
      "llm_stop_strings",
      "llm_stop_speaker_pattern_enabled",
      "llm_max_output_tokens",
      "llm_top_p",
      "llm_top_k",
      "llm_frequency_penalty",
      "llm_presence_penalty",
      "llm_min_p",
      "llm_logit_biases",
      "fallback_model_refs",
    ],
    preserved: [],
  },
  {
    table: "server_model_configs",
    reset: ["llm_temperature", "thinking_level", "llm_disabled_params", "fallback_llm_ids", "hide_respond_embed"],
    // Clearing any of these takes the bot offline or destroys something the database cannot
    // restore: `api_key` is the only copy of a credential whose plaintext exists nowhere else,
    // and the model and endpoint ids are the active identity the runtime reads. The other-model
    // capability cache is bound to `other_model_codename`, so it survives with it.
    preserved: [
      "llm_id",
      "embedding_model_id",
      "diffusion_model_id",
      "video_model_id",
      "vision_llm_id",
      "api_key",
      "key_version",
      "custom_endpoint_url",
      "custom_model_name",
      "custom_num_ctx",
      "other_model_codename",
      "other_model_capabilities",
      "other_model_capabilities_fetched_at",
    ],
  },
  {
    table: "server_member_permissions_configs",
    reset: [
      "server_memteaching_enabled",
      "attribute_memteaching_enabled",
      "sampledialogue_memteaching_enabled",
      "self_teaching_enabled",
      "personal_memories_enabled",
      "hide_impersonation_embeds",
      "prompt_snapshot_enabled",
    ],
    preserved: [],
  },
  {
    table: "server_capabilities_configs",
    reset: [
      "emoji_usage_enabled",
      "sticker_usage_enabled",
      "web_search_enabled",
      "manage_message_enabled",
      "thread_creation_enabled",
      "imagegen_enabled",
      "videogen_enabled",
      "voice_message_enabled",
      "user_blocking_enabled",
      "time_awareness_enabled",
      "tool_use_enabled",
      "short_term_memory_enabled",
      "verbatim_tool_calling_enabled",
      "user_info_updates_enabled",
    ],
    preserved: [],
  },
  {
    table: "server_notice_embeds_configs",
    reset: ["tool_notice_hidden_keys"],
    preserved: [],
  },
  {
    table: "server_nsfw_configs",
    reset: ["uncensor_injection_enabled", "uncensor_unicode_space_enabled", "uncensor_sanitize_enabled"],
    preserved: [],
  },
  {
    table: "server_speech_configs",
    reset: [
      "voice_transcript_chat_mode",
      "chatterbox_turbo_enabled",
      "chatterbox_cfg_weight",
      "chatterbox_exaggeration",
    ],
    preserved: [],
  },
  {
    table: "server_auto_trigger_configs",
    reset: ["autoch_disc_ids", "autoch_threshold", "autoch_threshold_max"],
    preserved: [],
  },
  {
    table: "server_channel_scope_configs",
    reset: [
      "rp_channel_ids",
      "private_channel_ids",
      "crosschannel_blocklist_ids",
      "stm_privacy_bypass",
      "thought_log_channel_disc_id",
    ],
    preserved: [],
  },
  {
    table: "server_trigger_behavior_configs",
    reset: [
      "always_reply_enabled",
      "deliberate_trigger_mode",
      "deliberate_tool_mode",
      "deliberate_tool_context_turns",
      "deliberate_tool_triggers",
      "cooldown_type",
      "cooldown_length",
    ],
    preserved: [],
  },
  {
    table: "server_novelai_imagegen_configs",
    reset: [
      "nai_preset_name",
      "image_default_positive_tags",
      "image_default_negative_tags",
      "nai_sampler",
      "nai_steps",
      "nai_scale",
      "nai_noise_schedule",
      "nai_cfg_rescale",
    ],
    // The selected diffusion model is active identity, classified with the model ids above.
    preserved: ["nai_diffusion_model_id"],
  },
  {
    table: "server_byok_configs",
    reset: ["user_byok_mode"],
    preserved: [],
  },
  {
    table: "server_memory_configs",
    reset: ["memory_tagging_enabled", "channel_memory_enabled"],
    preserved: [],
  },
  {
    table: "server_stm_configs",
    reset: [
      "refresh_cadence",
      "render_mode",
      "crude_message_count",
      "tool_description_override",
      "update_nudge_override",
      "nudge_injection_depth",
      "content_injection_depth",
    ],
    preserved: [],
  },
  {
    table: "server_welcome_configs",
    reset: ["welcome_channel_disc_id", "welcome_prompt", "welcome_persona_id"],
    preserved: [],
  },
  {
    table: "image_quota_configs",
    reset: ["daily_user_quota", "serverwide_quota", "serverwide_quota_resets_in", "enabled"],
    preserved: [],
  },
  {
    table: "text_quota_configs",
    reset: ["daily_user_quota", "serverwide_quota", "serverwide_quota_resets_in", "enabled"],
    preserved: [],
  },
  {
    table: "video_quota_configs",
    reset: ["daily_user_quota", "serverwide_quota", "serverwide_quota_resets_in", "enabled"],
    preserved: [],
  },
];

/**
 * The 11 collection tables a server reset empties for the server.
 *
 * `server_auto_trigger_persona_overrides` belongs here rather than among the singletons: it is the
 * junction the auto-trigger row's channel ids point through, so it is cleared by delete.
 */
export const SERVER_COLLECTION_RESET_TABLES = [
  "server_auto_trigger_persona_overrides",
  "stm_categories",
  "random_triggers",
  "channel_llm_overrides",
  "channel_prompt_overrides",
  "channel_context_notes",
  "personalization_blacklist",
  "persona_user_blocks",
  "channel_whitelist",
  "role_whitelist",
  "channel_persona_whitelist",
] as const;

/**
 * The two singleton rows a personal reset restores.
 *
 * `registration_locale` is preserved because it records the locale the account was created under
 * and is account history rather than a setting the owner edits.
 */
export const PERSONAL_SINGLETON_RESET_TABLES: readonly SingletonResetClassification[] = [
  {
    table: "users",
    reset: ["language_pref", "privacy_level"],
    preserved: ["registration_locale"],
  },
  {
    table: "user_personalization_configs",
    reset: [
      "user_nickname",
      "shortterm_cache_crossserver_opt_in",
      "physical_appearance_tags",
      "nai_char_ref_url",
      "impersonation_prompt",
      "personal_dtm",
      "personal_deliberate_tool_mode",
      "timezone_offset",
      "prefix_override",
      "suffix_override",
      "gender_identity",
      "pronouns",
      "addressing_style",
    ],
    preserved: [],
  },
];

/**
 * Cross-domain reset SQL.
 *
 * Every statement is written out rather than generated from the classification above. `SET column =
 * DEFAULT` is SQL syntax, not a bindable value, so a generated form would have to concatenate
 * identifiers into the statement text. The two lists are kept honest by the schema-parity gate
 * instead, which fails by table and column when they drift apart.
 *
 * Each singleton is an upsert. Setup does not seed every split row, so a plain UPDATE would leave a
 * missing row missing, and every later panel write against that table reports a write failure while
 * reads silently succeed on Zod defaults.
 */
class ResetRepository {
  /**
   * Restores one server's configuration to its database defaults in a single transaction.
   *
   * Throws on the first failed statement so the whole reset rolls back: a partial reset is worse
   * than none, because the owner is told configuration was restored while some of it was not.
   * Cache invalidation and the scheduler nudge are deliberately not done here; they belong to the
   * caller, after this resolves.
   */
  async resetServerConfiguration(serverId: number): Promise<void> {
    await sql.begin(async (tx: SQL) => {
      await tx`
        INSERT INTO server_chat_configs (server_id) VALUES (${serverId})
        ON CONFLICT (server_id) DO UPDATE SET
          humanizer_degree = DEFAULT,
          message_fetch_limit = DEFAULT,
          send_message_limit = DEFAULT,
          match_limit = DEFAULT,
          cascade_limit = DEFAULT,
          timezone_offset = DEFAULT,
          self_debug_enabled = DEFAULT,
          model_randomizer_enabled = DEFAULT,
          system_prompt = DEFAULT,
          context_note = DEFAULT,
          context_note_depth = DEFAULT,
          llm_stop_strings = DEFAULT,
          llm_stop_speaker_pattern_enabled = DEFAULT,
          llm_max_output_tokens = DEFAULT,
          llm_top_p = DEFAULT,
          llm_top_k = DEFAULT,
          llm_frequency_penalty = DEFAULT,
          llm_presence_penalty = DEFAULT,
          llm_min_p = DEFAULT,
          llm_logit_biases = DEFAULT,
          fallback_model_refs = DEFAULT,
          updated_at = NOW()
      `;

      // Model identities and credentials are absent from this SET on purpose. See the preserve set
      // on SERVER_SINGLETON_RESET_TABLES for why each one survives.
      await tx`
        INSERT INTO server_model_configs (server_id) VALUES (${serverId})
        ON CONFLICT (server_id) DO UPDATE SET
          llm_temperature = DEFAULT,
          thinking_level = DEFAULT,
          llm_disabled_params = DEFAULT,
          fallback_llm_ids = DEFAULT,
          hide_respond_embed = DEFAULT,
          updated_at = NOW()
      `;

      await tx`
        INSERT INTO server_member_permissions_configs (server_id) VALUES (${serverId})
        ON CONFLICT (server_id) DO UPDATE SET
          server_memteaching_enabled = DEFAULT,
          attribute_memteaching_enabled = DEFAULT,
          sampledialogue_memteaching_enabled = DEFAULT,
          self_teaching_enabled = DEFAULT,
          personal_memories_enabled = DEFAULT,
          hide_impersonation_embeds = DEFAULT,
          prompt_snapshot_enabled = DEFAULT,
          updated_at = NOW()
      `;

      await tx`
        INSERT INTO server_capabilities_configs (server_id) VALUES (${serverId})
        ON CONFLICT (server_id) DO UPDATE SET
          emoji_usage_enabled = DEFAULT,
          sticker_usage_enabled = DEFAULT,
          web_search_enabled = DEFAULT,
          manage_message_enabled = DEFAULT,
          thread_creation_enabled = DEFAULT,
          imagegen_enabled = DEFAULT,
          videogen_enabled = DEFAULT,
          voice_message_enabled = DEFAULT,
          user_blocking_enabled = DEFAULT,
          time_awareness_enabled = DEFAULT,
          tool_use_enabled = DEFAULT,
          short_term_memory_enabled = DEFAULT,
          verbatim_tool_calling_enabled = DEFAULT,
          user_info_updates_enabled = DEFAULT,
          updated_at = NOW()
      `;

      await tx`
        INSERT INTO server_notice_embeds_configs (server_id) VALUES (${serverId})
        ON CONFLICT (server_id) DO UPDATE SET
          tool_notice_hidden_keys = DEFAULT,
          updated_at = NOW()
      `;

      await tx`
        INSERT INTO server_nsfw_configs (server_id) VALUES (${serverId})
        ON CONFLICT (server_id) DO UPDATE SET
          uncensor_injection_enabled = DEFAULT,
          uncensor_unicode_space_enabled = DEFAULT,
          uncensor_sanitize_enabled = DEFAULT,
          updated_at = NOW()
      `;

      await tx`
        INSERT INTO server_speech_configs (server_id) VALUES (${serverId})
        ON CONFLICT (server_id) DO UPDATE SET
          voice_transcript_chat_mode = DEFAULT,
          chatterbox_turbo_enabled = DEFAULT,
          chatterbox_cfg_weight = DEFAULT,
          chatterbox_exaggeration = DEFAULT,
          updated_at = NOW()
      `;

      await tx`
        INSERT INTO server_auto_trigger_configs (server_id) VALUES (${serverId})
        ON CONFLICT (server_id) DO UPDATE SET
          autoch_disc_ids = DEFAULT,
          autoch_threshold = DEFAULT,
          autoch_threshold_max = DEFAULT,
          updated_at = NOW()
      `;

      await tx`
        INSERT INTO server_channel_scope_configs (server_id) VALUES (${serverId})
        ON CONFLICT (server_id) DO UPDATE SET
          rp_channel_ids = DEFAULT,
          private_channel_ids = DEFAULT,
          crosschannel_blocklist_ids = DEFAULT,
          stm_privacy_bypass = DEFAULT,
          thought_log_channel_disc_id = DEFAULT,
          updated_at = NOW()
      `;

      await tx`
        INSERT INTO server_trigger_behavior_configs (server_id) VALUES (${serverId})
        ON CONFLICT (server_id) DO UPDATE SET
          always_reply_enabled = DEFAULT,
          deliberate_trigger_mode = DEFAULT,
          deliberate_tool_mode = DEFAULT,
          deliberate_tool_context_turns = DEFAULT,
          deliberate_tool_triggers = DEFAULT,
          cooldown_type = DEFAULT,
          cooldown_length = DEFAULT,
          updated_at = NOW()
      `;

      await tx`
        INSERT INTO server_novelai_imagegen_configs (server_id) VALUES (${serverId})
        ON CONFLICT (server_id) DO UPDATE SET
          nai_preset_name = DEFAULT,
          image_default_positive_tags = DEFAULT,
          image_default_negative_tags = DEFAULT,
          nai_sampler = DEFAULT,
          nai_steps = DEFAULT,
          nai_scale = DEFAULT,
          nai_noise_schedule = DEFAULT,
          nai_cfg_rescale = DEFAULT,
          updated_at = NOW()
      `;

      await tx`
        INSERT INTO server_byok_configs (server_id) VALUES (${serverId})
        ON CONFLICT (server_id) DO UPDATE SET
          user_byok_mode = DEFAULT,
          updated_at = NOW()
      `;

      await tx`
        INSERT INTO server_memory_configs (server_id) VALUES (${serverId})
        ON CONFLICT (server_id) DO UPDATE SET
          memory_tagging_enabled = DEFAULT,
          channel_memory_enabled = DEFAULT,
          updated_at = NOW()
      `;

      await tx`
        INSERT INTO server_stm_configs (server_id) VALUES (${serverId})
        ON CONFLICT (server_id) DO UPDATE SET
          refresh_cadence = DEFAULT,
          render_mode = DEFAULT,
          crude_message_count = DEFAULT,
          tool_description_override = DEFAULT,
          update_nudge_override = DEFAULT,
          nudge_injection_depth = DEFAULT,
          content_injection_depth = DEFAULT,
          updated_at = NOW()
      `;

      await tx`
        INSERT INTO server_welcome_configs (server_id) VALUES (${serverId})
        ON CONFLICT (server_id) DO UPDATE SET
          welcome_channel_disc_id = DEFAULT,
          welcome_prompt = DEFAULT,
          welcome_persona_id = DEFAULT,
          updated_at = NOW()
      `;

      // Quota settings only. The per-user and server-wide usage tables record consumption that
      // already happened, so they are not part of a configuration reset.
      await tx`
        INSERT INTO image_quota_configs (server_id) VALUES (${serverId})
        ON CONFLICT (server_id) DO UPDATE SET
          daily_user_quota = DEFAULT,
          serverwide_quota = DEFAULT,
          serverwide_quota_resets_in = DEFAULT,
          enabled = DEFAULT,
          updated_at = NOW()
      `;

      await tx`
        INSERT INTO text_quota_configs (server_id) VALUES (${serverId})
        ON CONFLICT (server_id) DO UPDATE SET
          daily_user_quota = DEFAULT,
          serverwide_quota = DEFAULT,
          serverwide_quota_resets_in = DEFAULT,
          enabled = DEFAULT,
          updated_at = NOW()
      `;

      await tx`
        INSERT INTO video_quota_configs (server_id) VALUES (${serverId})
        ON CONFLICT (server_id) DO UPDATE SET
          daily_user_quota = DEFAULT,
          serverwide_quota = DEFAULT,
          serverwide_quota_resets_in = DEFAULT,
          enabled = DEFAULT,
          updated_at = NOW()
      `;

      await tx`DELETE FROM server_auto_trigger_persona_overrides WHERE server_id = ${serverId}`;
      // Deletes the category definitions only. Persisted short_term_memories carry their own
      // categories payload and render from it, so STM data survives a configuration reset.
      await tx`DELETE FROM stm_categories WHERE server_id = ${serverId}`;
      await tx`DELETE FROM random_triggers WHERE server_id = ${serverId}`;
      await tx`DELETE FROM channel_llm_overrides WHERE server_id = ${serverId}`;
      await tx`DELETE FROM channel_prompt_overrides WHERE server_id = ${serverId}`;
      await tx`DELETE FROM channel_context_notes WHERE server_id = ${serverId}`;
      await tx`DELETE FROM personalization_blacklist WHERE server_id = ${serverId}`;
      await tx`DELETE FROM persona_user_blocks WHERE server_id = ${serverId}`;
      await tx`DELETE FROM channel_whitelist WHERE server_id = ${serverId}`;
      await tx`DELETE FROM role_whitelist WHERE server_id = ${serverId}`;
      await tx`DELETE FROM channel_persona_whitelist WHERE server_id = ${serverId}`;
    });
  }

  /**
   * Restores one user's personal configuration to its database defaults in a single transaction.
   *
   * Resets language preference and privacy level in users, resets all portable personalization
   * settings in user_personalization_configs via upsert (repairing missing rows), removes persona
   * naming preferences, and deletes personal spotlights owned by the user across all servers.
   * Returns the user's Discord ID and distinct server IDs whose spotlights were deleted so the
   * caller can perform scoped cache invalidations after commit.
   */
  async resetPersonalConfiguration(userId: number): Promise<PersonalResetResult | null> {
    return await sql.begin(async (tx: SQL) => {
      const [user] = await tx<Array<{ user_disc_id: string }>>`
        UPDATE users
        SET
          language_pref = DEFAULT,
          privacy_level = DEFAULT,
          updated_at = NOW()
        WHERE user_id = ${userId}
        RETURNING user_disc_id
      `;
      if (!user) return null;

      await tx`
        INSERT INTO user_personalization_configs (user_id) VALUES (${userId})
        ON CONFLICT (user_id) DO UPDATE SET
          user_nickname = DEFAULT,
          shortterm_cache_crossserver_opt_in = DEFAULT,
          physical_appearance_tags = DEFAULT,
          nai_char_ref_url = DEFAULT,
          impersonation_prompt = DEFAULT,
          personal_dtm = DEFAULT,
          personal_deliberate_tool_mode = DEFAULT,
          timezone_offset = DEFAULT,
          prefix_override = DEFAULT,
          suffix_override = DEFAULT,
          gender_identity = DEFAULT,
          pronouns = DEFAULT,
          addressing_style = DEFAULT,
          updated_at = NOW()
      `;

      await tx`DELETE FROM user_persona_naming_preferences WHERE user_id = ${userId}`;

      const deletedSpotlights = await tx<Array<{ server_id: number }>>`
        DELETE FROM personal_spotlights
        WHERE user_id = ${userId}
        RETURNING server_id
      `;

      const affectedServerIds = [...new Set(deletedSpotlights.map((row) => row.server_id))];

      return {
        userDiscId: user.user_disc_id,
        affectedServerIds,
      };
    });
  }
}

export interface PersonalResetResult {
  userDiscId: string;
  affectedServerIds: number[];
}

export const resetRepository = new ResetRepository();
