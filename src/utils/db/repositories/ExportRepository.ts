import { sql } from "@/utils/db/client";
import { log } from "@/utils/misc/logger";
import {
  EXPORT_VERSION,
  EXPORT_V2_VERSION,
  EXPORT_BUCKET_LABEL_MAX_LENGTH,
  personalMemoriesExportSchema,
  globalPersonalMemoriesExportSchema,
  personalSettingsExportSchema,
  serverMemoriesExportSchema,
  serverConfigOnlyExportSchema,
  personalConfigExportSchema,
  workspaceConfigExportSchema,
  getPersonalMemoriesV2ExportSchema,
  getWorkspaceMemoriesExportSchema,
  getPersonalExportSchema,
  getServerExportSchema,
  type PersonalMemoriesExport,
  type GlobalPersonalMemoriesExport,
  type PersonalSettingsExport,
  type ServerMemoriesExport,
  type ServerConfigOnlyExport,
  type PersonalExport,
  type ServerExport,
  type ExportResult,
  type PersonalityExportResult,
  type MemoryItem,
} from "@/types/db/dataExport";
import { shortTermMemoryRepository } from "./ShortTermMemoryRepository";

interface WorkspaceConfigProjectionRow {
  server_id: number;
  llm_temperature: number;
  thinking_level: string;
  llm_disabled_params: string[];
  llm_top_p: number;
  llm_top_k: number;
  llm_frequency_penalty: number;
  llm_presence_penalty: number;
  llm_min_p: number;
  llm_max_output_tokens: number | null;
  llm_logit_biases: unknown;
  llm_stop_strings: string[];
  llm_stop_speaker_pattern_enabled: boolean;
  humanizer_degree: number;
  timezone_offset: number;
  message_fetch_limit: number;
  system_prompt: string | null;
  cascade_limit: number;
  match_limit: number;
  send_message_limit: number;
  context_note: string | null;
  context_note_depth: number;
  server_memteaching_enabled: boolean;
  attribute_memteaching_enabled: boolean;
  sampledialogue_memteaching_enabled: boolean;
  self_teaching_enabled: boolean;
  personal_memories_enabled: boolean;
  prompt_snapshot_enabled: boolean;
  web_search_enabled: boolean;
  emoji_usage_enabled: boolean;
  sticker_usage_enabled: boolean;
  imagegen_enabled: boolean;
  manage_message_enabled: boolean;
  videogen_enabled: boolean;
  voice_message_enabled: boolean;
  thread_creation_enabled: boolean;
  user_blocking_enabled: boolean;
  time_awareness_enabled: boolean;
  tool_use_enabled: boolean;
  short_term_memory_enabled: boolean;
  verbatim_tool_calling_enabled: boolean;
  user_info_updates_enabled: boolean;
  tool_notice_hidden_keys: string[];
  uncensor_injection_enabled: boolean;
  uncensor_unicode_space_enabled: boolean;
  uncensor_sanitize_enabled: boolean;
  self_debug_enabled: boolean;
  voice_transcript_chat_mode: boolean;
  chatterbox_turbo_enabled: boolean;
  chatterbox_cfg_weight: number;
  chatterbox_exaggeration: number;
  always_reply_enabled: boolean;
  deliberate_trigger_mode: boolean;
  deliberate_tool_mode: boolean;
  deliberate_tool_context_turns: number | null;
  deliberate_tool_triggers: Record<string, unknown>;
  cooldown_type: number;
  cooldown_length: number;
  stm_privacy_bypass: boolean;
  image_default_positive_tags: string[];
  image_default_negative_tags: string[];
  nai_sampler: string | null;
  nai_steps: number | null;
  nai_scale: number | null;
  nai_noise_schedule: string | null;
  nai_cfg_rescale: number | null;
  user_byok_mode: boolean;
  memory_tagging_enabled: boolean;
  channel_memory_enabled: boolean;
  welcome_prompt: string | null;
  stm_config_server_id: number | null;
  refresh_cadence: number | null;
  render_mode: "supersede" | "crude_summary" | null;
  crude_message_count: number | null;
  tool_description_override: string | null;
  update_nudge_override: string | null;
  nudge_injection_depth: number | null;
  content_injection_depth: number | null;
}

interface StmCategoryProjectionRow {
  position: number;
  label: string;
  description: string;
}

interface PersonalConfigProjectionRow {
  user_nickname: string | null;
  language_pref: string | null;
  privacy_level: number | null;
  shortterm_cache_crossserver_opt_in: boolean;
  physical_appearance_tags: string[];
  impersonation_prompt: string | null;
  personal_dtm: "off" | "follow" | "on";
  personal_deliberate_tool_mode: "off" | "follow" | "on";
  timezone_offset: number | null;
  prefix_override: string | null;
  suffix_override: string | null;
  gender_identity: string | null;
  pronouns: string | null;
  addressing_style: "masculine" | "feminine" | "neutral" | null;
}

type DatabaseId = number | string | bigint;

interface MemoryProjectionRow {
  content: string;
  tags: string[] | null;
  persona_lineage_id?: DatabaseId;
}

interface PersonaLabelProjectionRow {
  persona_lineage_id: DatabaseId;
  persona_nickname: string | null;
}

interface PersonaMemoryScopeRow extends PersonaLabelProjectionRow {
  persona_id: DatabaseId;
}

/**
 * ExportRepository: owns all data export operations.
 *
 * Handles personal and server data export, per-domain slice exports
 * (memories, settings, config, personality), JSON sanitization, and
 * schema validation. Export operations are read-only; no cache
 * invalidation is performed here.
 */
export class ExportRepository {
  private readonly database: typeof sql;

  constructor(database: typeof sql = sql) {
    this.database = database;
  }

  /**
   * Sanitizes a string for safe JSON serialization.
   * Removes control characters (except newlines and tabs) that could break JSON.
   * @returns Object with sanitized content and flag indicating if sanitization occurred
   */
  private sanitizeForJson(content: string): { sanitized: string; wasSanitized: boolean } {
    // Remove null bytes and control characters except \n (0x0A) and \t (0x09)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Intentionally matching control characters for sanitization
    const cleaned = content.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, "");
    return { sanitized: cleaned, wasSanitized: cleaned !== content };
  }

  private sanitizeMemoryItems(items: MemoryItem[], contextLabel: string): MemoryItem[] {
    return items.map((item, index) => {
      const { sanitized, wasSanitized } = this.sanitizeForJson(item.content);
      if (wasSanitized) log.warn(`Sanitized ${contextLabel} at index ${index}: removed control characters`);
      return { content: sanitized, tags: item.tags };
    });
  }

  private coerceDatabaseId(value: DatabaseId): number | null {
    const id = Number(value);
    return Number.isFinite(id) ? id : null;
  }

  private bucketLabel(nickname: string | null | undefined, fallback: string): string {
    const trimmedNickname = nickname?.trim();
    const label = trimmedNickname || fallback;
    return label.slice(0, EXPORT_BUCKET_LABEL_MAX_LENGTH).trim() || fallback;
  }

  private memoryItems(rows: MemoryProjectionRow[]): MemoryItem[] {
    return this.sanitizeMemoryItems(
      rows.map((row) => ({ content: row.content, tags: row.tags ?? [] })),
      "memory bundle",
    );
  }

  /**
   * Exports personal user data (nickname, language preference, impersonation prompt, memories).
   * @param userDiscId - Discord user ID to export data for
   * @param personaLineageId - Persona lineage namespace to export memories from
   * @param includeGlobalMemories - Include lineage-0 memories when exporting a non-zero lineage
   * @returns ExportResult containing the exported data or error
   */
  async exportPersonalData(
    userDiscId: string,
    personaLineageId = 0,
    includeGlobalMemories = true,
  ): Promise<ExportResult> {
    try {
      const rows = await sql`
        SELECT
          u.user_id,
          upc.user_nickname,
          u.language_pref,
          upc.impersonation_prompt,
          COALESCE(upc.physical_appearance_tags, ARRAY[]::TEXT[]) AS physical_appearance_tags,
          upc.nai_char_ref_url
        FROM users u
        LEFT JOIN user_personalization_configs upc ON upc.user_id = u.user_id
        WHERE u.user_disc_id = ${userDiscId}
        LIMIT 1
      `;

      if (!rows.length) {
        return { success: false, error: "commands.data.export.error_no_user_data" };
      }

      const userData = rows[0];

      const memoryRows =
        includeGlobalMemories && personaLineageId !== 0
          ? await sql`
              SELECT content, tags
              FROM personal_memories
              WHERE user_id = ${userData.user_id}
                AND (
                  persona_lineage_id = ${personaLineageId}
                  OR persona_lineage_id = 0
                )
              ORDER BY created_at DESC, personal_memory_id DESC
            `
          : await sql`
              SELECT content, tags
              FROM personal_memories
              WHERE user_id = ${userData.user_id}
                AND persona_lineage_id = ${personaLineageId}
              ORDER BY created_at DESC, personal_memory_id DESC
            `;

      const rawPersonalMemories: MemoryItem[] = memoryRows.map((row: { content: string; tags: string[] | null }) => ({
        content: row.content,
        tags: row.tags ?? [],
      }));

      // Sanitize memories for safe JSON export
      const sanitizedMemories = this.sanitizeMemoryItems(rawPersonalMemories, "personal memories");

      const exportData: PersonalExport = {
        version: EXPORT_VERSION,
        type: "personal",
        exported_at: new Date().toISOString(),
        data: {
          user_nickname: userData.user_nickname,
          language_pref: userData.language_pref,
          impersonation_prompt: userData.impersonation_prompt ?? null,
          personal_memories: sanitizedMemories,
        },
      };

      const validated = getPersonalExportSchema().safeParse(exportData);
      if (!validated.success) {
        log.error(`Personal export validation failed for user ${userDiscId}:`, validated.error);
        return { success: false, error: "commands.data.export.error_validation_failed" };
      }

      return { success: true, data: validated.data };
    } catch (error) {
      log.error(`Error exporting personal data for user ${userDiscId}:`, error);
      return { success: false, error: "commands.data.export.error_export_failed" };
    }
  }

  /**
   * Exports server data (configuration and server memories).
   * @param serverDiscId - Discord server ID to export data for
   * @param personaId - Optional persona ID to export persona-scoped server memories from
   * @returns ExportResult containing the exported data or error
   */
  async exportServerData(serverDiscId: string, personaId?: number): Promise<ExportResult> {
    try {
      const serverRows = await sql`
        SELECT server_id
        FROM servers
        WHERE server_disc_id = ${serverDiscId}
        LIMIT 1
      `;

      if (!serverRows.length) {
        return { success: false, error: "commands.data.export.error_no_server_data" };
      }

      const serverId = serverRows[0].server_id;

      // Get tomori configuration: 13 split-table LEFT JOINs + welcome (E6: replaces dual tomori_configs join).
      //    COALESCE defaults are belt-and-suspenders for the migration window (servers without a split row).
      const configRows = await sql`
        SELECT
          COALESCE(smc.llm_temperature, 1.0)                        AS llm_temperature,
          COALESCE(scc.llm_top_p, 0.95)                             AS llm_top_p,
          COALESCE(scc.llm_top_k, 0)                                AS llm_top_k,
          COALESCE(scc.llm_frequency_penalty, 0.0)                  AS llm_frequency_penalty,
          COALESCE(scc.llm_presence_penalty, 0.0)                   AS llm_presence_penalty,
          COALESCE(scc.llm_min_p, 0.05)                             AS llm_min_p,
          scc.llm_max_output_tokens                                  AS llm_max_output_tokens,
          COALESCE(smc.llm_disabled_params, ARRAY[]::TEXT[])        AS llm_disabled_params,
          COALESCE(scc.llm_logit_biases, '[]'::jsonb)               AS llm_logit_biases,
          COALESCE(scc.llm_stop_strings, ARRAY[]::TEXT[])           AS llm_stop_strings,
          COALESCE(scc.llm_stop_speaker_pattern_enabled, false)     AS llm_stop_speaker_pattern_enabled,
          COALESCE(scc.humanizer_degree, 1)                         AS humanizer_degree,
          COALESCE(smc.thinking_level, 'auto')                      AS thinking_level,
          COALESCE(scc.timezone_offset, 0)                          AS timezone_offset,
          COALESCE(scc.message_fetch_limit, 80)                     AS message_fetch_limit,
          scc.system_prompt                                          AS system_prompt,
          COALESCE(smpc.server_memteaching_enabled, false)          AS server_memteaching_enabled,
          COALESCE(smpc.attribute_memteaching_enabled, false)       AS attribute_memteaching_enabled,
          COALESCE(smpc.sampledialogue_memteaching_enabled, false)  AS sampledialogue_memteaching_enabled,
          COALESCE(smpc.self_teaching_enabled, true)                AS self_teaching_enabled,
          COALESCE(scac.web_search_enabled, true)                   AS web_search_enabled,
          COALESCE(smpc.personal_memories_enabled, true)            AS personal_memories_enabled,
          COALESCE(scac.emoji_usage_enabled, true)                  AS emoji_usage_enabled,
          COALESCE(scac.sticker_usage_enabled, true)                AS sticker_usage_enabled,
          COALESCE(scac.imagegen_enabled, true)                     AS imagegen_enabled,
          COALESCE(snec.tool_notice_hidden_keys, ARRAY[]::TEXT[])   AS tool_notice_hidden_keys,
          COALESCE(scc.self_debug_enabled, false)                   AS self_debug_enabled,
          COALESCE(scc.model_randomizer_enabled, false)             AS model_randomizer_enabled,
          snaic.image_default_positive_tags                                       AS image_default_positive_tags,
          snaic.image_default_negative_tags                                    AS image_default_negative_tags,
          snaic.nai_sampler                                          AS nai_sampler,
          snaic.nai_steps                                            AS nai_steps,
          snaic.nai_scale                                            AS nai_scale,
          snaic.nai_noise_schedule                                   AS nai_noise_schedule,
          snaic.nai_cfg_rescale                                      AS nai_cfg_rescale,
          snaic.nai_preset_name                                      AS nai_preset_name,
          COALESCE(scc.cascade_limit, 3)                            AS cascade_limit,
          COALESCE(scc.match_limit, 3)                              AS match_limit,
          COALESCE(scc.send_message_limit, 0)                       AS send_message_limit,
          COALESCE(stbc.always_reply_enabled, false)                AS always_reply_enabled,
          COALESCE(stbc.deliberate_trigger_mode, false)             AS deliberate_trigger_mode,
          COALESCE(stbc.deliberate_tool_mode, false)                AS deliberate_tool_mode,
          stbc.deliberate_tool_context_turns                         AS deliberate_tool_context_turns,
          COALESCE(stbc.deliberate_tool_triggers, '{}'::JSONB)      AS deliberate_tool_triggers,
          COALESCE(stbc.cooldown_type, 0)                           AS cooldown_type,
          COALESCE(stbc.cooldown_length, 5)                         AS cooldown_length,
          COALESCE(scsc.stm_privacy_bypass, false)                  AS stm_privacy_bypass,
          COALESCE(sbc.user_byok_mode, false)                       AS user_byok_mode,
          scc.context_note                                           AS context_note,
          COALESCE(scc.context_note_depth, 0)                       AS context_note_depth,
          COALESCE(scac.manage_message_enabled, true)               AS manage_message_enabled,
          COALESCE(scac.videogen_enabled, false)                    AS videogen_enabled,
          COALESCE(scac.voice_message_enabled, true)                AS voice_message_enabled,
          COALESCE(scac.thread_creation_enabled, true)              AS thread_creation_enabled,
          COALESCE(scac.user_blocking_enabled, true)                AS user_blocking_enabled,
          COALESCE(scac.time_awareness_enabled, true)               AS time_awareness_enabled,
          COALESCE(ssc.voice_transcript_chat_mode, true)            AS voice_transcript_chat_mode,
          COALESCE(ssc.chatterbox_turbo_enabled, true)              AS chatterbox_turbo_enabled,
          COALESCE(ssc.chatterbox_cfg_weight, 0.5)                  AS chatterbox_cfg_weight,
          COALESCE(ssc.chatterbox_exaggeration, 0.5)                AS chatterbox_exaggeration,
          COALESCE(snc.uncensor_injection_enabled, false)           AS uncensor_injection_enabled,
          COALESCE(snc.uncensor_unicode_space_enabled, false)       AS uncensor_unicode_space_enabled,
          COALESCE(snc.uncensor_sanitize_enabled, false)            AS uncensor_sanitize_enabled,
          COALESCE(scac.tool_use_enabled, true)                     AS tool_use_enabled,
          COALESCE(scac.short_term_memory_enabled, true)            AS short_term_memory_enabled,
          COALESCE(scac.verbatim_tool_calling_enabled, false)       AS verbatim_tool_calling_enabled,
          COALESCE(scac.user_info_updates_enabled, true)            AS user_info_updates_enabled,
          COALESCE(smpc.prompt_snapshot_enabled, false)             AS prompt_snapshot_enabled,
          COALESCE(smemoc.memory_tagging_enabled, false)            AS memory_tagging_enabled,
          COALESCE(smemoc.channel_memory_enabled, false)            AS channel_memory_enabled,
          swc.welcome_prompt                                         AS welcome_prompt
        FROM personas t
        LEFT JOIN server_model_configs smc               ON smc.server_id   = t.server_id
        LEFT JOIN server_chat_configs scc                ON scc.server_id   = t.server_id
        LEFT JOIN server_member_permissions_configs smpc ON smpc.server_id  = t.server_id
        LEFT JOIN server_capabilities_configs scac       ON scac.server_id  = t.server_id
        LEFT JOIN server_notice_embeds_configs snec      ON snec.server_id  = t.server_id
        LEFT JOIN server_nsfw_configs snc                ON snc.server_id   = t.server_id
        LEFT JOIN server_speech_configs ssc              ON ssc.server_id   = t.server_id
        LEFT JOIN server_channel_scope_configs scsc      ON scsc.server_id  = t.server_id
        LEFT JOIN server_trigger_behavior_configs stbc   ON stbc.server_id  = t.server_id
        LEFT JOIN server_novelai_imagegen_configs snaic  ON snaic.server_id = t.server_id
        LEFT JOIN server_byok_configs sbc                ON sbc.server_id   = t.server_id
        LEFT JOIN server_memory_configs smemoc           ON smemoc.server_id = t.server_id
        LEFT JOIN server_welcome_configs swc             ON swc.server_id   = t.server_id
        WHERE t.server_id = ${serverId}
          AND t.is_alter = false
        LIMIT 1
      `;

      if (!configRows.length) {
        return { success: false, error: "commands.data.export.error_no_server_config" };
      }

      const configData = configRows[0];

      let targetPersonaId = personaId;
      let targetPersonaLineageId: number | null = null;
      if (!targetPersonaId) {
        const mainPersonaRows = await sql<
          Array<{
            persona_id: number;
            persona_lineage_id: number | bigint | string;
          }>
        >`
          SELECT persona_id, persona_lineage_id
          FROM personas
          WHERE server_id = ${serverId}
            AND is_alter = false
          ORDER BY updated_at DESC NULLS LAST, persona_id DESC
          LIMIT 1
        `;
        targetPersonaId = mainPersonaRows[0]?.persona_id;
        const rawMainLineageId = mainPersonaRows[0]?.persona_lineage_id;
        targetPersonaLineageId =
          typeof rawMainLineageId === "bigint"
            ? Number(rawMainLineageId)
            : typeof rawMainLineageId === "string"
              ? Number(rawMainLineageId)
              : (rawMainLineageId ?? null);
      } else {
        const [targetPersonaMeta] = await sql<Array<{ persona_lineage_id: number | bigint | string }>>`
          SELECT persona_lineage_id
          FROM personas
          WHERE persona_id = ${targetPersonaId}
            AND server_id = ${serverId}
          LIMIT 1
        `;
        if (!targetPersonaMeta) {
          return { success: false, error: "commands.data.export.error_no_server_data" };
        }
        const rawLineageId = targetPersonaMeta?.persona_lineage_id;
        targetPersonaLineageId =
          typeof rawLineageId === "bigint"
            ? Number(rawLineageId)
            : typeof rawLineageId === "string"
              ? Number(rawLineageId)
              : (rawLineageId ?? null);
      }

      if (targetPersonaLineageId !== null && !Number.isFinite(targetPersonaLineageId)) {
        targetPersonaLineageId = null;
      }

      const memoryRows =
        targetPersonaLineageId !== null
          ? await sql`
              SELECT content, tags
              FROM server_memories
              WHERE server_id = ${serverId}
                AND persona_lineage_id = ${targetPersonaLineageId}
              ORDER BY created_at DESC
            `
          : await sql`
              SELECT content, tags
              FROM server_memories
              WHERE server_id = ${serverId}
              ORDER BY created_at DESC
            `;

      const rawServerMemories: MemoryItem[] = memoryRows.map((row: { content: string; tags: string[] | null }) => ({
        content: row.content,
        tags: row.tags ?? [],
      }));

      // Sanitize memories for safe JSON export
      const sanitizedServerMemories = this.sanitizeMemoryItems(rawServerMemories, "server memories");

      // Per-channel STM state is intentionally excluded from the export: only the
      // reusable customization (cadence, render mode, prompt overrides, categories)
      // is portable across servers.
      const stmExport = await shortTermMemoryRepository.toExportShape(serverDiscId);

      const exportData: ServerExport = {
        version: EXPORT_VERSION,
        type: "server",
        exported_at: new Date().toISOString(),
        data: {
          config: {
            llm_temperature: configData.llm_temperature,
            llm_top_p: configData.llm_top_p,
            llm_top_k: configData.llm_top_k,
            llm_frequency_penalty: configData.llm_frequency_penalty,
            llm_presence_penalty: configData.llm_presence_penalty,
            llm_min_p: configData.llm_min_p,
            llm_max_output_tokens: configData.llm_max_output_tokens ?? null,
            llm_disabled_params: configData.llm_disabled_params ?? [],
            llm_logit_biases: configData.llm_logit_biases ?? [],
            llm_stop_strings: configData.llm_stop_strings ?? [],
            llm_stop_speaker_pattern_enabled: configData.llm_stop_speaker_pattern_enabled ?? false,
            humanizer_degree: configData.humanizer_degree,
            thinking_level: configData.thinking_level,
            timezone_offset: configData.timezone_offset,
            message_fetch_limit: configData.message_fetch_limit,
            system_prompt: configData.system_prompt ?? null,
            server_memteaching_enabled: configData.server_memteaching_enabled,
            attribute_memteaching_enabled: configData.attribute_memteaching_enabled,
            sampledialogue_memteaching_enabled: configData.sampledialogue_memteaching_enabled,
            self_teaching_enabled: configData.self_teaching_enabled,
            web_search_enabled: configData.web_search_enabled,
            personal_memories_enabled: configData.personal_memories_enabled,
            emoji_usage_enabled: configData.emoji_usage_enabled,
            sticker_usage_enabled: configData.sticker_usage_enabled,
            imagegen_enabled: configData.imagegen_enabled,
            tool_notice_hidden_keys: configData.tool_notice_hidden_keys ?? [],
            self_debug_enabled: configData.self_debug_enabled,
            model_randomizer_enabled: configData.model_randomizer_enabled,
            image_default_positive_tags: configData.image_default_positive_tags ?? undefined,
            image_default_negative_tags: configData.image_default_negative_tags ?? undefined,
            nai_sampler: configData.nai_sampler ?? null,
            nai_steps: configData.nai_steps ?? null,
            nai_scale: configData.nai_scale ?? null,
            nai_noise_schedule: configData.nai_noise_schedule ?? null,
            nai_cfg_rescale: configData.nai_cfg_rescale ?? null,
            nai_preset_name: configData.nai_preset_name ?? null,
            cascade_limit: configData.cascade_limit,
            match_limit: configData.match_limit,
            send_message_limit: configData.send_message_limit,
            always_reply_enabled: configData.always_reply_enabled,
            deliberate_trigger_mode: configData.deliberate_trigger_mode,
            deliberate_tool_mode: configData.deliberate_tool_mode,
            deliberate_tool_context_turns: configData.deliberate_tool_context_turns ?? null,
            deliberate_tool_triggers: configData.deliberate_tool_triggers ?? {},
            cooldown_type: configData.cooldown_type,
            cooldown_length: configData.cooldown_length,
            stm_privacy_bypass: configData.stm_privacy_bypass,
            user_byok_mode: configData.user_byok_mode,
            context_note: configData.context_note ?? null,
            context_note_depth: configData.context_note_depth,
            manage_message_enabled: configData.manage_message_enabled,
            videogen_enabled: configData.videogen_enabled,
            voice_message_enabled: configData.voice_message_enabled,
            thread_creation_enabled: configData.thread_creation_enabled,
            user_blocking_enabled: configData.user_blocking_enabled,
            time_awareness_enabled: configData.time_awareness_enabled,
            voice_transcript_chat_mode: configData.voice_transcript_chat_mode,
            chatterbox_turbo_enabled: configData.chatterbox_turbo_enabled,
            chatterbox_cfg_weight: configData.chatterbox_cfg_weight,
            chatterbox_exaggeration: configData.chatterbox_exaggeration,
            uncensor_injection_enabled: configData.uncensor_injection_enabled,
            uncensor_unicode_space_enabled: configData.uncensor_unicode_space_enabled,
            uncensor_sanitize_enabled: configData.uncensor_sanitize_enabled,
            tool_use_enabled: configData.tool_use_enabled,
            short_term_memory_enabled: configData.short_term_memory_enabled,
            verbatim_tool_calling_enabled: configData.verbatim_tool_calling_enabled,
            user_info_updates_enabled: configData.user_info_updates_enabled,
            prompt_snapshot_enabled: configData.prompt_snapshot_enabled,
            memory_tagging_enabled: configData.memory_tagging_enabled,
            channel_memory_enabled: configData.channel_memory_enabled,
            welcome_prompt: configData.welcome_prompt ?? null,
            // STM customization (nested config object + ordered categories array).
            stm_config: stmExport?.stm_config ?? null,
            stm_categories: stmExport?.stm_categories ?? [],
          },
          server_memories: sanitizedServerMemories,
        },
      };

      const validated = getServerExportSchema().safeParse(exportData);
      if (!validated.success) {
        log.error(`Server export validation failed for server ${serverDiscId}:`, validated.error);
        return { success: false, error: "commands.data.export.error_validation_failed" };
      }

      return { success: true, data: validated.data };
    } catch (error) {
      log.error(`Error exporting server data for server ${serverDiscId}:`, error);
      return { success: false, error: "commands.data.export.error_export_failed" };
    }
  }

  /**
   * Exports persona-scoped personal memories only.
   * @param userDiscId - Discord user ID to export data for
   * @param personaLineageId - Persona lineage namespace to export memories from
   */
  async exportPersonaPersonalMemories(userDiscId: string, personaLineageId: number): Promise<ExportResult> {
    const baseExport = await this.exportPersonalData(userDiscId, personaLineageId, false);
    if (!baseExport.success || !baseExport.data || baseExport.data.type !== "personal") {
      return { success: false, error: baseExport.error || "commands.data.export.error_export_failed" };
    }

    const exportData: PersonalMemoriesExport = {
      version: EXPORT_VERSION,
      type: "personal_memories",
      exported_at: baseExport.data.exported_at,
      data: { personal_memories: baseExport.data.data.personal_memories },
    };

    const validated = personalMemoriesExportSchema.safeParse(exportData);
    if (!validated.success) {
      log.error(`Persona personal memories export validation failed for user ${userDiscId}:`, validated.error);
      return { success: false, error: "commands.data.export.error_validation_failed" };
    }

    return { success: true, data: validated.data };
  }

  /**
   * Exports global personal memories only (lineage 0).
   * @param userDiscId - Discord user ID to export data for
   */
  async exportGlobalPersonalMemories(userDiscId: string): Promise<ExportResult> {
    const baseExport = await this.exportPersonalData(userDiscId, 0, false);
    if (!baseExport.success || !baseExport.data || baseExport.data.type !== "personal") {
      return { success: false, error: baseExport.error || "commands.data.export.error_export_failed" };
    }

    const exportData: GlobalPersonalMemoriesExport = {
      version: EXPORT_VERSION,
      type: "global_personal_memories",
      exported_at: baseExport.data.exported_at,
      data: { personal_memories: baseExport.data.data.personal_memories },
    };

    const validated = globalPersonalMemoriesExportSchema.safeParse(exportData);
    if (!validated.success) {
      log.error(`Global personal memories export validation failed for user ${userDiscId}:`, validated.error);
      return { success: false, error: "commands.data.export.error_validation_failed" };
    }

    return { success: true, data: validated.data };
  }

  /**
   * Exports personal settings only (nickname, language, impersonation prompt, image appearance data).
   * @param userDiscId - Discord user ID to export data for
   */
  async exportPersonalSettings(userDiscId: string): Promise<ExportResult> {
    try {
      const rows = await sql`
        SELECT
          upc.user_nickname,
          u.language_pref,
          upc.impersonation_prompt,
          COALESCE(upc.physical_appearance_tags, ARRAY[]::TEXT[]) AS physical_appearance_tags,
          upc.nai_char_ref_url,
          u.privacy_level,
          COALESCE(upc.personal_dtm, 'follow') AS personal_dtm,
          COALESCE(upc.personal_deliberate_tool_mode, 'follow') AS personal_deliberate_tool_mode,
          COALESCE(upc.shortterm_cache_crossserver_opt_in, false) AS shortterm_cache_crossserver_opt_in,
          upc.timezone_offset,
          upc.prefix_override,
          upc.suffix_override,
          upc.gender_identity,
          upc.pronouns,
          upc.addressing_style
        FROM users u
        LEFT JOIN user_personalization_configs upc ON upc.user_id = u.user_id
        WHERE u.user_disc_id = ${userDiscId}
        LIMIT 1
      `;

      if (!rows.length) {
        return { success: false, error: "commands.data.export.error_no_user_data" };
      }

      const userData = rows[0];
      const personaNamingPreferences = await sql<
        Array<{
          persona_lineage_id: number;
          nickname_override: string | null;
          prefix_override: string | null;
          suffix_override: string | null;
        }>
      >`
        SELECT
          upnp.persona_lineage_id,
          upnp.nickname_override,
          upnp.prefix_override,
          upnp.suffix_override
        FROM user_persona_naming_preferences upnp
        JOIN users u ON u.user_id = upnp.user_id
        WHERE u.user_disc_id = ${userDiscId}
        ORDER BY upnp.persona_lineage_id
      `;

      const exportData: PersonalSettingsExport = {
        version: EXPORT_VERSION,
        type: "personal_settings",
        exported_at: new Date().toISOString(),
        data: {
          user_nickname: userData.user_nickname,
          language_pref: userData.language_pref,
          impersonation_prompt: userData.impersonation_prompt ?? null,
          physical_appearance_tags: userData.physical_appearance_tags ?? [],
          nai_char_ref_url: userData.nai_char_ref_url ?? null,
          privacy_level: userData.privacy_level ?? undefined,
          personal_dtm: userData.personal_dtm ?? undefined,
          personal_deliberate_tool_mode: userData.personal_deliberate_tool_mode ?? undefined,
          shortterm_cache_crossserver_opt_in: userData.shortterm_cache_crossserver_opt_in ?? undefined,
          timezone_offset: userData.timezone_offset ?? undefined,
          prefix_override: userData.prefix_override ?? null,
          suffix_override: userData.suffix_override ?? null,
          gender_identity: userData.gender_identity ?? null,
          pronouns: userData.pronouns ?? null,
          addressing_style: userData.addressing_style ?? null,
          persona_naming_preferences: personaNamingPreferences.map((preference) => ({
            ...preference,
            persona_lineage_id: Number(preference.persona_lineage_id),
          })),
        },
      };

      const validated = personalSettingsExportSchema.safeParse(exportData);
      if (!validated.success) {
        log.error(`Personal settings export validation failed for user ${userDiscId}:`, validated.error);
        return { success: false, error: "commands.data.export.error_validation_failed" };
      }

      return { success: true, data: validated.data };
    } catch (error) {
      log.error(`Error exporting personal settings for user ${userDiscId}:`, error);
      return { success: false, error: "commands.data.export.error_export_failed" };
    }
  }

  /**
   * Exports persona-scoped server memories only.
   * @param serverDiscId - Discord server ID to export data for
   * @param personaId - Persona ID to export memories from
   */
  async exportPersonaServerMemories(serverDiscId: string, personaId: number): Promise<ExportResult> {
    const baseExport = await this.exportServerData(serverDiscId, personaId);
    if (!baseExport.success || !baseExport.data || baseExport.data.type !== "server") {
      return { success: false, error: baseExport.error || "commands.data.export.error_export_failed" };
    }

    const exportData: ServerMemoriesExport = {
      version: EXPORT_VERSION,
      type: "server_memories",
      exported_at: baseExport.data.exported_at,
      data: { server_memories: baseExport.data.data.server_memories },
    };

    const validated = serverMemoriesExportSchema.safeParse(exportData);
    if (!validated.success) {
      log.error(`Persona server memories export validation failed for server ${serverDiscId}:`, validated.error);
      return { success: false, error: "commands.data.export.error_validation_failed" };
    }

    return { success: true, data: validated.data };
  }

  /**
   * Exports the portable workspace configuration in the v2 sectioned format.
   * The read is scoped to configuration tables so memory rows are never loaded.
   */
  async exportWorkspaceConfig(serverDiscId: string): Promise<ExportResult> {
    try {
      const configRows = await this.database<Array<WorkspaceConfigProjectionRow>>`
        SELECT
          s.server_id AS server_id,
          COALESCE(smc.llm_temperature, 1.0) AS llm_temperature,
          COALESCE(smc.thinking_level, 'auto') AS thinking_level,
          COALESCE(smc.llm_disabled_params, ARRAY[]::TEXT[]) AS llm_disabled_params,
          COALESCE(scc.llm_top_p, 0.95) AS llm_top_p,
          COALESCE(scc.llm_top_k, 0) AS llm_top_k,
          COALESCE(scc.llm_frequency_penalty, 0.0) AS llm_frequency_penalty,
          COALESCE(scc.llm_presence_penalty, 0.0) AS llm_presence_penalty,
          COALESCE(scc.llm_min_p, 0.05) AS llm_min_p,
          scc.llm_max_output_tokens AS llm_max_output_tokens,
          COALESCE(scc.llm_logit_biases, '[]'::jsonb) AS llm_logit_biases,
          COALESCE(scc.llm_stop_strings, ARRAY[]::TEXT[]) AS llm_stop_strings,
          COALESCE(scc.llm_stop_speaker_pattern_enabled, false) AS llm_stop_speaker_pattern_enabled,
          COALESCE(scc.humanizer_degree, 1) AS humanizer_degree,
          COALESCE(scc.timezone_offset, 0) AS timezone_offset,
          COALESCE(scc.message_fetch_limit, 80) AS message_fetch_limit,
          scc.system_prompt AS system_prompt,
          COALESCE(scc.cascade_limit, 3) AS cascade_limit,
          COALESCE(scc.match_limit, 3) AS match_limit,
          COALESCE(scc.send_message_limit, 0) AS send_message_limit,
          scc.context_note AS context_note,
          COALESCE(scc.context_note_depth, 0) AS context_note_depth,
          COALESCE(smpc.server_memteaching_enabled, false) AS server_memteaching_enabled,
          COALESCE(smpc.attribute_memteaching_enabled, false) AS attribute_memteaching_enabled,
          COALESCE(smpc.sampledialogue_memteaching_enabled, false) AS sampledialogue_memteaching_enabled,
          COALESCE(smpc.self_teaching_enabled, true) AS self_teaching_enabled,
          COALESCE(smpc.personal_memories_enabled, true) AS personal_memories_enabled,
          COALESCE(smpc.prompt_snapshot_enabled, false) AS prompt_snapshot_enabled,
          COALESCE(scac.web_search_enabled, true) AS web_search_enabled,
          COALESCE(scac.emoji_usage_enabled, true) AS emoji_usage_enabled,
          COALESCE(scac.sticker_usage_enabled, true) AS sticker_usage_enabled,
          COALESCE(scac.imagegen_enabled, true) AS imagegen_enabled,
          COALESCE(scac.manage_message_enabled, true) AS manage_message_enabled,
          COALESCE(scac.videogen_enabled, false) AS videogen_enabled,
          COALESCE(scac.voice_message_enabled, true) AS voice_message_enabled,
          COALESCE(scac.thread_creation_enabled, true) AS thread_creation_enabled,
          COALESCE(scac.user_blocking_enabled, true) AS user_blocking_enabled,
          COALESCE(scac.time_awareness_enabled, true) AS time_awareness_enabled,
          COALESCE(scac.tool_use_enabled, true) AS tool_use_enabled,
          COALESCE(scac.short_term_memory_enabled, true) AS short_term_memory_enabled,
          COALESCE(scac.verbatim_tool_calling_enabled, false) AS verbatim_tool_calling_enabled,
          COALESCE(scac.user_info_updates_enabled, true) AS user_info_updates_enabled,
          COALESCE(snec.tool_notice_hidden_keys, ARRAY[]::TEXT[]) AS tool_notice_hidden_keys,
          COALESCE(snc.uncensor_injection_enabled, false) AS uncensor_injection_enabled,
          COALESCE(snc.uncensor_unicode_space_enabled, false) AS uncensor_unicode_space_enabled,
          COALESCE(snc.uncensor_sanitize_enabled, false) AS uncensor_sanitize_enabled,
          COALESCE(scc.self_debug_enabled, false) AS self_debug_enabled,
          COALESCE(ssc.voice_transcript_chat_mode, true) AS voice_transcript_chat_mode,
          COALESCE(ssc.chatterbox_turbo_enabled, true) AS chatterbox_turbo_enabled,
          COALESCE(ssc.chatterbox_cfg_weight, 0.5) AS chatterbox_cfg_weight,
          COALESCE(ssc.chatterbox_exaggeration, 0.5) AS chatterbox_exaggeration,
          COALESCE(stbc.always_reply_enabled, false) AS always_reply_enabled,
          COALESCE(stbc.deliberate_trigger_mode, false) AS deliberate_trigger_mode,
          COALESCE(stbc.deliberate_tool_mode, false) AS deliberate_tool_mode,
          stbc.deliberate_tool_context_turns AS deliberate_tool_context_turns,
          COALESCE(stbc.deliberate_tool_triggers, '{}'::JSONB) AS deliberate_tool_triggers,
          COALESCE(stbc.cooldown_type, 0) AS cooldown_type,
          COALESCE(stbc.cooldown_length, 5) AS cooldown_length,
          COALESCE(scsc.stm_privacy_bypass, false) AS stm_privacy_bypass,
          COALESCE(snaic.image_default_positive_tags, ARRAY[]::TEXT[]) AS image_default_positive_tags,
          COALESCE(snaic.image_default_negative_tags, ARRAY[]::TEXT[]) AS image_default_negative_tags,
          snaic.nai_sampler AS nai_sampler,
          snaic.nai_steps AS nai_steps,
          snaic.nai_scale AS nai_scale,
          snaic.nai_noise_schedule AS nai_noise_schedule,
          snaic.nai_cfg_rescale AS nai_cfg_rescale,
          COALESCE(sbc.user_byok_mode, false) AS user_byok_mode,
          COALESCE(smemoc.memory_tagging_enabled, false) AS memory_tagging_enabled,
          COALESCE(smemoc.channel_memory_enabled, false) AS channel_memory_enabled,
          swc.welcome_prompt AS welcome_prompt,
          stmc.server_id AS stm_config_server_id,
          stmc.refresh_cadence AS refresh_cadence,
          stmc.render_mode AS render_mode,
          stmc.crude_message_count AS crude_message_count,
          stmc.tool_description_override AS tool_description_override,
          stmc.update_nudge_override AS update_nudge_override,
          stmc.nudge_injection_depth AS nudge_injection_depth,
          stmc.content_injection_depth AS content_injection_depth
        FROM servers s
        LEFT JOIN server_model_configs smc ON smc.server_id = s.server_id
        LEFT JOIN server_chat_configs scc ON scc.server_id = s.server_id
        LEFT JOIN server_member_permissions_configs smpc ON smpc.server_id = s.server_id
        LEFT JOIN server_capabilities_configs scac ON scac.server_id = s.server_id
        LEFT JOIN server_notice_embeds_configs snec ON snec.server_id = s.server_id
        LEFT JOIN server_nsfw_configs snc ON snc.server_id = s.server_id
        LEFT JOIN server_speech_configs ssc ON ssc.server_id = s.server_id
        LEFT JOIN server_channel_scope_configs scsc ON scsc.server_id = s.server_id
        LEFT JOIN server_trigger_behavior_configs stbc ON stbc.server_id = s.server_id
        LEFT JOIN server_novelai_imagegen_configs snaic ON snaic.server_id = s.server_id
        LEFT JOIN server_byok_configs sbc ON sbc.server_id = s.server_id
        LEFT JOIN server_memory_configs smemoc ON smemoc.server_id = s.server_id
        LEFT JOIN server_welcome_configs swc ON swc.server_id = s.server_id
        LEFT JOIN server_stm_configs stmc ON stmc.server_id = s.server_id
        WHERE s.server_disc_id = ${serverDiscId}
        LIMIT 1
      `;

      if (!configRows.length) {
        return { success: false, error: "commands.data.export.error_no_server_config" };
      }

      const [configData] = configRows;
      const categoryRows = await this.database<Array<StmCategoryProjectionRow>>`
        SELECT
          sc.position AS position,
          sc.label AS label,
          sc.description AS description
        FROM stm_categories sc
        WHERE sc.server_id = ${configData.server_id}
        ORDER BY sc.position
      `;

      const data = {
        chat: {
          llm_temperature: configData.llm_temperature,
          thinking_level: configData.thinking_level,
          llm_disabled_params: configData.llm_disabled_params,
          llm_top_p: configData.llm_top_p,
          llm_top_k: configData.llm_top_k,
          llm_frequency_penalty: configData.llm_frequency_penalty,
          llm_presence_penalty: configData.llm_presence_penalty,
          llm_min_p: configData.llm_min_p,
          llm_max_output_tokens: configData.llm_max_output_tokens,
          llm_logit_biases: configData.llm_logit_biases,
          llm_stop_strings: configData.llm_stop_strings,
          llm_stop_speaker_pattern_enabled: configData.llm_stop_speaker_pattern_enabled,
          humanizer_degree: configData.humanizer_degree,
          timezone_offset: configData.timezone_offset,
          message_fetch_limit: configData.message_fetch_limit,
          system_prompt: configData.system_prompt,
          cascade_limit: configData.cascade_limit,
          match_limit: configData.match_limit,
          send_message_limit: configData.send_message_limit,
          context_note: configData.context_note,
          context_note_depth: configData.context_note_depth,
          welcome_prompt: configData.welcome_prompt,
        },
        triggers: {
          always_reply_enabled: configData.always_reply_enabled,
          deliberate_trigger_mode: configData.deliberate_trigger_mode,
          deliberate_tool_mode: configData.deliberate_tool_mode,
          deliberate_tool_context_turns: configData.deliberate_tool_context_turns,
          deliberate_tool_triggers: configData.deliberate_tool_triggers,
          cooldown_type: configData.cooldown_type,
          cooldown_length: configData.cooldown_length,
        },
        capabilities: {
          web_search_enabled: configData.web_search_enabled,
          emoji_usage_enabled: configData.emoji_usage_enabled,
          sticker_usage_enabled: configData.sticker_usage_enabled,
          imagegen_enabled: configData.imagegen_enabled,
          manage_message_enabled: configData.manage_message_enabled,
          videogen_enabled: configData.videogen_enabled,
          voice_message_enabled: configData.voice_message_enabled,
          thread_creation_enabled: configData.thread_creation_enabled,
          user_blocking_enabled: configData.user_blocking_enabled,
          time_awareness_enabled: configData.time_awareness_enabled,
          tool_use_enabled: configData.tool_use_enabled,
          short_term_memory_enabled: configData.short_term_memory_enabled,
          verbatim_tool_calling_enabled: configData.verbatim_tool_calling_enabled,
          user_info_updates_enabled: configData.user_info_updates_enabled,
          tool_notice_hidden_keys: configData.tool_notice_hidden_keys,
          uncensor_injection_enabled: configData.uncensor_injection_enabled,
          uncensor_unicode_space_enabled: configData.uncensor_unicode_space_enabled,
          uncensor_sanitize_enabled: configData.uncensor_sanitize_enabled,
          self_debug_enabled: configData.self_debug_enabled,
        },
        memory: {
          server_memteaching_enabled: configData.server_memteaching_enabled,
          attribute_memteaching_enabled: configData.attribute_memteaching_enabled,
          sampledialogue_memteaching_enabled: configData.sampledialogue_memteaching_enabled,
          self_teaching_enabled: configData.self_teaching_enabled,
          personal_memories_enabled: configData.personal_memories_enabled,
          prompt_snapshot_enabled: configData.prompt_snapshot_enabled,
          stm_privacy_bypass: configData.stm_privacy_bypass,
          memory_tagging_enabled: configData.memory_tagging_enabled,
          channel_memory_enabled: configData.channel_memory_enabled,
          stm_config:
            configData.stm_config_server_id === null
              ? null
              : {
                  refresh_cadence: configData.refresh_cadence,
                  render_mode: configData.render_mode,
                  crude_message_count: configData.crude_message_count,
                  tool_description_override: configData.tool_description_override,
                  update_nudge_override: configData.update_nudge_override,
                  nudge_injection_depth: configData.nudge_injection_depth,
                  content_injection_depth: configData.content_injection_depth,
                },
          stm_categories: categoryRows.map((category) => ({
            position: category.position,
            label: category.label,
            description: category.description,
          })),
        },
        media: {
          image_default_positive_tags: configData.image_default_positive_tags,
          image_default_negative_tags: configData.image_default_negative_tags,
          nai_sampler: configData.nai_sampler,
          nai_steps: configData.nai_steps,
          nai_scale: configData.nai_scale,
          nai_noise_schedule: configData.nai_noise_schedule,
          nai_cfg_rescale: configData.nai_cfg_rescale,
        },
        speech: {
          voice_transcript_chat_mode: configData.voice_transcript_chat_mode,
          chatterbox_turbo_enabled: configData.chatterbox_turbo_enabled,
          chatterbox_cfg_weight: configData.chatterbox_cfg_weight,
          chatterbox_exaggeration: configData.chatterbox_exaggeration,
        },
        access: {
          user_byok_mode: configData.user_byok_mode,
        },
      };

      const exportCandidate = {
        version: EXPORT_V2_VERSION,
        type: "workspace_config",
        exported_at: new Date().toISOString(),
        data,
      };
      const validated = workspaceConfigExportSchema.safeParse(exportCandidate);
      if (!validated.success) {
        log.error(`Workspace config export validation failed for server ${serverDiscId}:`, validated.error);
        return { success: false, error: "commands.data.export.error_validation_failed" };
      }

      return { success: true, data: validated.data };
    } catch (error) {
      log.error(`Error exporting workspace config for server ${serverDiscId}:`, error);
      return { success: false, error: "commands.data.export.error_export_failed" };
    }
  }

  /**
   * Exports the portable personal configuration in the v2 sectioned format.
   * The query omits naming lineage data because it cannot be rebound safely.
   */
  async exportPersonalConfig(userDiscId: string): Promise<ExportResult> {
    try {
      const rows = await this.database<Array<PersonalConfigProjectionRow>>`
        SELECT
          upc.user_nickname AS user_nickname,
          COALESCE(u.language_pref, 'en-US') AS language_pref,
          COALESCE(u.privacy_level, 0) AS privacy_level,
          COALESCE(upc.shortterm_cache_crossserver_opt_in, false) AS shortterm_cache_crossserver_opt_in,
          COALESCE(upc.physical_appearance_tags, ARRAY[]::TEXT[]) AS physical_appearance_tags,
          upc.impersonation_prompt AS impersonation_prompt,
          COALESCE(upc.personal_dtm, 'follow') AS personal_dtm,
          COALESCE(upc.personal_deliberate_tool_mode, 'follow') AS personal_deliberate_tool_mode,
          upc.timezone_offset AS timezone_offset,
          upc.prefix_override AS prefix_override,
          upc.suffix_override AS suffix_override,
          upc.gender_identity AS gender_identity,
          upc.pronouns AS pronouns,
          upc.addressing_style AS addressing_style
        FROM users u
        LEFT JOIN user_personalization_configs upc ON upc.user_id = u.user_id
        WHERE u.user_disc_id = ${userDiscId}
        LIMIT 1
      `;

      if (!rows.length) {
        return { success: false, error: "commands.data.export.error_no_user_data" };
      }

      const [configData] = rows;
      const data = {
        profile: {
          user_nickname: configData.user_nickname,
          language_pref: configData.language_pref,
          timezone_offset: configData.timezone_offset,
          prefix_override: configData.prefix_override,
          suffix_override: configData.suffix_override,
          gender_identity: configData.gender_identity,
          pronouns: configData.pronouns,
          addressing_style: configData.addressing_style,
        },
        privacy: {
          privacy_level: configData.privacy_level,
          shortterm_cache_crossserver_opt_in: configData.shortterm_cache_crossserver_opt_in,
        },
        appearance: {
          physical_appearance_tags: configData.physical_appearance_tags,
        },
        response_modes: {
          impersonation_prompt: configData.impersonation_prompt,
          personal_dtm: configData.personal_dtm,
          personal_deliberate_tool_mode: configData.personal_deliberate_tool_mode,
        },
      };

      const exportCandidate = {
        version: EXPORT_V2_VERSION,
        type: "personal_config",
        exported_at: new Date().toISOString(),
        data,
      };
      const validated = personalConfigExportSchema.safeParse(exportCandidate);
      if (!validated.success) {
        log.error(`Personal config export validation failed for user ${userDiscId}:`, validated.error);
        return { success: false, error: "commands.data.export.error_validation_failed" };
      }

      return { success: true, data: validated.data };
    } catch (error) {
      log.error(`Error exporting personal config for user ${userDiscId}:`, error);
      return { success: false, error: "commands.data.export.error_export_failed" };
    }
  }

  async exportWorkspaceMemories(
    serverDiscId: string,
    scope: { mode: "main" } | { mode: "persona"; personaId: number } | { mode: "all" },
  ): Promise<ExportResult> {
    try {
      const serverRows = await this.database<Array<{ server_id: DatabaseId }>>`
        SELECT server_id
        FROM servers
        WHERE server_disc_id = ${serverDiscId}
        LIMIT 1
      `;
      const serverId = serverRows[0] ? this.coerceDatabaseId(serverRows[0].server_id) : null;
      if (serverId === null) {
        return { success: false, error: "commands.data.export.error_no_server_data" };
      }

      let buckets: Array<{ name: string; label: string; memories: MemoryItem[] }>;
      if (scope.mode === "all") {
        const memoryRows = await this.database<MemoryProjectionRow[]>`
          SELECT persona_lineage_id, content, tags
          FROM server_memories
          WHERE server_id = ${serverId}
          ORDER BY persona_lineage_id ASC, created_at DESC NULLS LAST, server_memory_id DESC
        `;
        if (!memoryRows.length) {
          return { success: false, error: "commands.data.export.error_no_server_data" };
        }

        const groupedRows = new Map<number, MemoryProjectionRow[]>();
        for (const row of memoryRows) {
          if (row.persona_lineage_id === undefined) {
            return { success: false, error: "commands.data.export.error_validation_failed" };
          }
          const lineageId = this.coerceDatabaseId(row.persona_lineage_id);
          if (lineageId === null) {
            return { success: false, error: "commands.data.export.error_validation_failed" };
          }
          const lineageRows = groupedRows.get(lineageId) ?? [];
          lineageRows.push(row);
          groupedRows.set(lineageId, lineageRows);
        }

        const lineageIds = [...groupedRows.keys()].sort((left, right) => left - right);
        const labelRows = await this.database<PersonaLabelProjectionRow[]>`
          SELECT persona_lineage_id, persona_nickname
          FROM personas
          WHERE server_id = ${serverId}
            AND persona_lineage_id = ANY(${sql.array(lineageIds, "int8")})
          ORDER BY persona_lineage_id ASC, updated_at DESC NULLS LAST, persona_id DESC
        `;
        const labels = new Map<number, string>();
        for (const row of labelRows) {
          const lineageId = this.coerceDatabaseId(row.persona_lineage_id);
          if (lineageId !== null && !labels.has(lineageId)) {
            labels.set(lineageId, row.persona_nickname ?? "");
          }
        }

        buckets = lineageIds.map((lineageId, index) => ({
          name: `persona-${index + 1}`,
          label: this.bucketLabel(labels.get(lineageId), `Persona ${index + 1}`),
          memories: this.memoryItems(groupedRows.get(lineageId) ?? []),
        }));
      } else {
        const personaRows =
          scope.mode === "main"
            ? await this.database<PersonaMemoryScopeRow[]>`
                SELECT persona_id, persona_lineage_id, persona_nickname
                FROM personas
                WHERE server_id = ${serverId}
                  AND is_alter = false
                ORDER BY updated_at DESC NULLS LAST, persona_id DESC
                LIMIT 1
              `
            : await this.database<PersonaMemoryScopeRow[]>`
                SELECT persona_id, persona_lineage_id, persona_nickname
                FROM personas
                WHERE persona_id = ${scope.personaId}
                  AND server_id = ${serverId}
                LIMIT 1
              `;
        const persona = personaRows[0];
        if (!persona) {
          return { success: false, error: "commands.data.export.error_no_server_data" };
        }
        const lineageId = this.coerceDatabaseId(persona.persona_lineage_id);
        if (lineageId === null) {
          return { success: false, error: "commands.data.export.error_validation_failed" };
        }

        const memoryRows = await this.database<MemoryProjectionRow[]>`
          SELECT content, tags
          FROM server_memories
          WHERE server_id = ${serverId}
            AND persona_lineage_id = ${lineageId}
          ORDER BY created_at DESC, server_memory_id DESC
        `;
        buckets = [
          {
            name: scope.mode,
            label: this.bucketLabel(
              persona.persona_nickname,
              scope.mode === "main" ? "Main Persona" : "Selected Persona",
            ),
            memories: this.memoryItems(memoryRows),
          },
        ];
      }

      const exportCandidate = {
        version: EXPORT_V2_VERSION,
        type: "workspace_memories",
        exported_at: new Date().toISOString(),
        data: { buckets },
      };
      const validated = getWorkspaceMemoriesExportSchema().safeParse(exportCandidate);
      if (!validated.success) {
        log.error(`Workspace memory bundle export validation failed for server ${serverDiscId}:`, validated.error);
        return { success: false, error: "commands.data.export.error_validation_failed" };
      }

      return { success: true, data: validated.data };
    } catch (error) {
      log.error(`Error exporting workspace memory bundle for server ${serverDiscId}:`, error);
      return { success: false, error: "commands.data.export.error_export_failed" };
    }
  }

  async exportPersonalMemories(
    userDiscId: string,
    scope: { mode: "global" } | { mode: "persona"; personaLineageId: number } | { mode: "all" },
  ): Promise<ExportResult> {
    try {
      const userRows = await this.database<Array<{ user_id: DatabaseId }>>`
        SELECT user_id
        FROM users
        WHERE user_disc_id = ${userDiscId}
        LIMIT 1
      `;
      const userId = userRows[0] ? this.coerceDatabaseId(userRows[0].user_id) : null;
      if (userId === null) {
        return { success: false, error: "commands.data.export.error_no_user_data" };
      }

      let buckets: Array<{ name: string; label: string; memories: MemoryItem[] }>;
      if (scope.mode === "all") {
        const memoryRows = await this.database<MemoryProjectionRow[]>`
          SELECT persona_lineage_id, content, tags
          FROM personal_memories
          WHERE user_id = ${userId}
          ORDER BY persona_lineage_id ASC, created_at DESC NULLS LAST, personal_memory_id DESC
        `;
        if (!memoryRows.length) {
          return { success: false, error: "commands.data.export.error_no_user_data" };
        }

        const groupedRows = new Map<number, MemoryProjectionRow[]>();
        for (const row of memoryRows) {
          if (row.persona_lineage_id === undefined) {
            return { success: false, error: "commands.data.export.error_validation_failed" };
          }
          const lineageId = this.coerceDatabaseId(row.persona_lineage_id);
          if (lineageId === null) {
            return { success: false, error: "commands.data.export.error_validation_failed" };
          }
          const lineageRows = groupedRows.get(lineageId) ?? [];
          lineageRows.push(row);
          groupedRows.set(lineageId, lineageRows);
        }

        const lineageIds = [...groupedRows.keys()].sort((left, right) => {
          if (left === 0) return -1;
          if (right === 0) return 1;
          return left - right;
        });
        const nonGlobalLineageIds = lineageIds.filter((lineageId) => lineageId !== 0);
        const labelRows = nonGlobalLineageIds.length
          ? await this.database<PersonaLabelProjectionRow[]>`
              SELECT persona_lineage_id, persona_nickname
              FROM personas
              WHERE persona_lineage_id = ANY(${sql.array(nonGlobalLineageIds, "int8")})
              ORDER BY persona_lineage_id ASC, updated_at DESC NULLS LAST, persona_id DESC
            `
          : [];
        const labels = new Map<number, string>();
        for (const row of labelRows) {
          const lineageId = this.coerceDatabaseId(row.persona_lineage_id);
          if (lineageId !== null && !labels.has(lineageId)) {
            labels.set(lineageId, row.persona_nickname ?? "");
          }
        }

        buckets = [];
        let personaOrdinal = 0;
        for (const lineageId of lineageIds) {
          if (lineageId === 0) {
            buckets.push({
              name: "global",
              label: "Global",
              memories: this.memoryItems(groupedRows.get(lineageId) ?? []),
            });
            continue;
          }
          personaOrdinal += 1;
          buckets.push({
            name: `persona-${personaOrdinal}`,
            label: this.bucketLabel(labels.get(lineageId), `Persona ${personaOrdinal}`),
            memories: this.memoryItems(groupedRows.get(lineageId) ?? []),
          });
        }
      } else {
        const lineageId = scope.mode === "global" ? 0 : this.coerceDatabaseId(scope.personaLineageId);
        if (lineageId === null) {
          return { success: false, error: "commands.data.export.error_validation_failed" };
        }

        let label = scope.mode === "global" ? "Global" : "Selected Persona";
        if (scope.mode === "persona") {
          const labelRows = await this.database<PersonaLabelProjectionRow[]>`
            SELECT persona_lineage_id, persona_nickname
            FROM personas
            WHERE persona_lineage_id = ${lineageId}
            ORDER BY updated_at DESC NULLS LAST, persona_id DESC
            LIMIT 1
          `;
          label = this.bucketLabel(labelRows[0]?.persona_nickname, "Selected Persona");
        }

        const memoryRows = await this.database<MemoryProjectionRow[]>`
          SELECT content, tags
          FROM personal_memories
          WHERE user_id = ${userId}
            AND persona_lineage_id = ${lineageId}
          ORDER BY created_at DESC, personal_memory_id DESC
        `;
        buckets = [
          {
            name: scope.mode,
            label,
            memories: this.memoryItems(memoryRows),
          },
        ];
      }

      const exportCandidate = {
        version: EXPORT_V2_VERSION,
        type: "personal_memories",
        exported_at: new Date().toISOString(),
        data: { buckets },
      };
      const validated = getPersonalMemoriesV2ExportSchema().safeParse(exportCandidate);
      if (!validated.success) {
        log.error(`Personal memory bundle export validation failed for user ${userDiscId}:`, validated.error);
        return { success: false, error: "commands.data.export.error_validation_failed" };
      }

      return { success: true, data: validated.data };
    } catch (error) {
      log.error(`Error exporting personal memory bundle for user ${userDiscId}:`, error);
      return { success: false, error: "commands.data.export.error_export_failed" };
    }
  }

  /**
   * Exports server config only.
   * @param serverDiscId - Discord server ID to export data for
   */
  async exportServerConfig(serverDiscId: string): Promise<ExportResult> {
    const baseExport = await this.exportServerData(serverDiscId);
    if (!baseExport.success || !baseExport.data || baseExport.data.type !== "server") {
      return { success: false, error: baseExport.error || "commands.data.export.error_export_failed" };
    }

    const exportData: ServerConfigOnlyExport = {
      version: EXPORT_VERSION,
      type: "server_config",
      exported_at: baseExport.data.exported_at,
      data: { config: baseExport.data.data.config },
    };

    const validated = serverConfigOnlyExportSchema.safeParse(exportData);
    if (!validated.success) {
      log.error(`Server config export validation failed for server ${serverDiscId}:`, validated.error);
      return { success: false, error: "commands.data.export.error_validation_failed" };
    }

    return { success: true, data: validated.data };
  }

  /**
   * Exports personality data as a human-readable text file.
   * @param serverDiscId - Discord server ID to export personality for
   * @param personaId - Optional persona ID to export personality for
   * @returns PersonalityExportResult containing formatted text or error
   */
  async exportPersonalityData(serverDiscId: string, personaId?: number): Promise<PersonalityExportResult> {
    try {
      const rows =
        typeof personaId === "number"
          ? await sql`
              SELECT
                t.persona_nickname,
                t.attribute_list,
                t.sample_dialogues_in,
                t.sample_dialogues_out
              FROM personas t
              JOIN servers s ON t.server_id = s.server_id
              WHERE s.server_disc_id = ${serverDiscId}
                AND t.persona_id = ${personaId}
              LIMIT 1
            `
          : await sql`
              SELECT
                t.persona_nickname,
                t.attribute_list,
                t.sample_dialogues_in,
                t.sample_dialogues_out
              FROM personas t
              JOIN servers s ON t.server_id = s.server_id
              WHERE s.server_disc_id = ${serverDiscId}
                AND t.is_alter = false
              LIMIT 1
            `;

      if (!rows.length) {
        return { success: false, error: "commands.data.export.error_no_personality_data" };
      }

      const personalityData = rows[0];

      let textOutput = "";

      textOutput += `========================================\n`;
      textOutput += `TOMORI PERSONALITY EXPORT\n`;
      textOutput += `========================================\n\n`;
      textOutput += `Personality Name: ${personalityData.persona_nickname}\n`;
      textOutput += `Exported: ${new Date().toISOString()}\n\n`;

      textOutput += `========================================\n`;
      textOutput += `ATTRIBUTES\n`;
      textOutput += `========================================\n\n`;

      const attributes = personalityData.attribute_list || [];
      if (attributes.length > 0) {
        attributes.forEach((attr: string, index: number) => {
          textOutput += `${index + 1}. ${attr}\n`;
        });
      } else {
        textOutput += `No attributes defined.\n`;
      }

      textOutput += `\n`;

      textOutput += `========================================\n`;
      textOutput += `SAMPLE DIALOGUES\n`;
      textOutput += `========================================\n\n`;

      const dialoguesIn = personalityData.sample_dialogues_in || [];
      const dialoguesOut = personalityData.sample_dialogues_out || [];

      if (dialoguesIn.length > 0 && dialoguesOut.length > 0) {
        const maxLength = Math.max(dialoguesIn.length, dialoguesOut.length);
        for (let i = 0; i < maxLength; i++) {
          textOutput += `--- Dialogue ${i + 1} ---\n`;
          textOutput += `User: ${dialoguesIn[i] || "(none)"}\n`;
          textOutput += `Tomori: ${dialoguesOut[i] || "(none)"}\n\n`;
        }
      } else {
        textOutput += `No sample dialogues defined.\n\n`;
      }

      textOutput += `========================================\n`;
      textOutput += `NOTE\n`;
      textOutput += `========================================\n\n`;
      textOutput += `This export is for informational purposes only.\n`;
      textOutput += `To import personalities, use the /persona commands.\n`;

      return { success: true, text: textOutput };
    } catch (error) {
      log.error(`Error exporting personality data for server ${serverDiscId}:`, error);
      return { success: false, error: "commands.data.export.error_export_failed" };
    }
  }

  /**
   * Exports a user's full personal data bundle (IRepository contract).
   * The ownerId is the Discord snowflake of the user.
   * @param ownerId - Discord user snowflake
   */
  async toExportShape(ownerId: string | number): Promise<ExportResult | null> {
    const result = await this.exportPersonalData(String(ownerId));
    return result.success ? result : null;
  }
}

/** Singleton instance: import this in callers. */
export const exportRepository = new ExportRepository();
