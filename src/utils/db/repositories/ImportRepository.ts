import { sql } from "@/utils/db/client";
import type { SQL } from "bun";
import { log } from "@/utils/misc/logger";
import {
  EXPORT_VERSION,
  personalConfigExportDataSchema,
  personalConfigExportSchema,
  personalMemoriesExportSchema,
  globalPersonalMemoriesExportSchema,
  personalSettingsExportSchema,
  serverMemoriesExportSchema,
  serverConfigOnlyExportSchema,
  V2_CONFIG_SECTION_SCHEMAS,
  workspaceConfigExportDataSchema,
  workspaceConfigExportSchema,
  getPersonalExportSchema,
  getServerExportSchema,
  type PersonalExportData,
  type PersonalConfigExport,
  type PersonalConfigExportData,
  type ServerExportData,
  type PersonalMemoriesExportData,
  type ServerMemoriesExportData,
  type PersonalSettingsExportData,
  type ServerConfigExport,
  type WorkspaceConfigExport,
  type WorkspaceConfigExportData,
  type ImportResult,
  type MemoryItem,
  type ExportResult,
  normalizeMemoryItem,
} from "@/types/db/dataExport";
import { getMemoryLimits, validateMemoryContent } from "@/utils/misc/memoryLimits";
import { validateTomoriConfigFields } from "@/utils/db/sqlSecurity";
import { invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCacheStore";
import { invalidateUserCache } from "@/utils/cache/userCache";
import { configRepository } from "@/utils/db/repositories/ConfigRepository";
import { shortTermMemoryRepository } from "@/utils/db/repositories/ShortTermMemoryRepository";
import type { SqlParameterArray } from "@/types/db/sqlOperations";
import type { ServerChatConfigRow, ServerNoticeEmbedsConfigRow } from "@/types/db/schema";

type ImportFileType =
  | "personal_memories"
  | "server_memories"
  | "personal_settings"
  | "server_config"
  | "global_personal_memories"
  | "personal"
  | "server";

interface ImportValidationResult {
  valid: boolean;
  type?: ImportFileType;
  data?:
    | PersonalMemoriesExportData
    | ServerMemoriesExportData
    | PersonalSettingsExportData
    | { config: ServerConfigExport }
    | PersonalExportData
    | ServerExportData;
  error?: string;
}

type MemoryRow = { content: string; tags: string[] | null };

function memoryKey(memory: MemoryItem): string {
  const normalized = normalizeMemoryItem(memory);
  return `${normalized.content}\u0000${normalized.tags.join("\u0000")}`;
}

export type WorkspaceConfigSection = keyof WorkspaceConfigExportData;
export type PersonalConfigSection = keyof PersonalConfigExportData;

type ConfigPatch = Record<string, unknown>;

interface ConfigTablePatch {
  tableName: string;
  idColumn: "server_id" | "user_id";
  id: number;
  patch: ConfigPatch;
}

interface SectionTableDefinition {
  tableName: string;
  fields: readonly string[];
  sourceKey?: string;
}

interface PreparedConfigImport {
  tablePatches: ConfigTablePatch[];
  stmCategories?: Array<{ position: number; label: string; description: string }>;
  configFieldsCount: number;
}

const WORKSPACE_SECTION_TABLES: Record<WorkspaceConfigSection, readonly SectionTableDefinition[]> = {
  chat: [
    {
      tableName: "server_model_configs",
      fields: ["llm_temperature", "thinking_level", "llm_disabled_params"],
    },
    {
      tableName: "server_chat_configs",
      fields: [
        "llm_top_p",
        "llm_top_k",
        "llm_frequency_penalty",
        "llm_presence_penalty",
        "llm_min_p",
        "llm_max_output_tokens",
        "llm_logit_biases",
        "llm_stop_strings",
        "llm_stop_speaker_pattern_enabled",
        "humanizer_degree",
        "timezone_offset",
        "message_fetch_limit",
        "system_prompt",
        "cascade_limit",
        "match_limit",
        "send_message_limit",
        "context_note",
        "context_note_depth",
      ],
    },
    { tableName: "server_welcome_configs", fields: ["welcome_prompt"] },
  ],
  triggers: [
    {
      tableName: "server_trigger_behavior_configs",
      fields: [
        "always_reply_enabled",
        "deliberate_trigger_mode",
        "deliberate_tool_mode",
        "deliberate_tool_context_turns",
        "deliberate_tool_triggers",
        "cooldown_type",
        "cooldown_length",
      ],
    },
  ],
  capabilities: [
    {
      tableName: "server_capabilities_configs",
      fields: [
        "web_search_enabled",
        "emoji_usage_enabled",
        "sticker_usage_enabled",
        "imagegen_enabled",
        "manage_message_enabled",
        "videogen_enabled",
        "voice_message_enabled",
        "thread_creation_enabled",
        "user_blocking_enabled",
        "time_awareness_enabled",
        "tool_use_enabled",
        "short_term_memory_enabled",
        "verbatim_tool_calling_enabled",
        "user_info_updates_enabled",
      ],
    },
    { tableName: "server_notice_embeds_configs", fields: ["tool_notice_hidden_keys"] },
    {
      tableName: "server_nsfw_configs",
      fields: ["uncensor_injection_enabled", "uncensor_unicode_space_enabled", "uncensor_sanitize_enabled"],
    },
    { tableName: "server_chat_configs", fields: ["self_debug_enabled"] },
  ],
  memory: [
    {
      tableName: "server_member_permissions_configs",
      fields: [
        "server_memteaching_enabled",
        "attribute_memteaching_enabled",
        "sampledialogue_memteaching_enabled",
        "self_teaching_enabled",
        "personal_memories_enabled",
        "prompt_snapshot_enabled",
      ],
    },
    { tableName: "server_channel_scope_configs", fields: ["stm_privacy_bypass"] },
    { tableName: "server_memory_configs", fields: ["memory_tagging_enabled", "channel_memory_enabled"] },
    {
      tableName: "server_stm_configs",
      sourceKey: "stm_config",
      fields: [
        "refresh_cadence",
        "render_mode",
        "crude_message_count",
        "tool_description_override",
        "update_nudge_override",
        "nudge_injection_depth",
        "content_injection_depth",
      ],
    },
  ],
  media: [
    {
      tableName: "server_novelai_imagegen_configs",
      fields: [
        "image_default_positive_tags",
        "image_default_negative_tags",
        "nai_sampler",
        "nai_steps",
        "nai_scale",
        "nai_noise_schedule",
        "nai_cfg_rescale",
      ],
    },
  ],
  speech: [
    {
      tableName: "server_speech_configs",
      fields: [
        "voice_transcript_chat_mode",
        "chatterbox_turbo_enabled",
        "chatterbox_cfg_weight",
        "chatterbox_exaggeration",
      ],
    },
  ],
  access: [{ tableName: "server_byok_configs", fields: ["user_byok_mode"] }],
};

const PERSONAL_SECTION_TABLES: Record<PersonalConfigSection, readonly SectionTableDefinition[]> = {
  profile: [
    { tableName: "users", fields: ["language_pref"] },
    {
      tableName: "user_personalization_configs",
      fields: [
        "user_nickname",
        "timezone_offset",
        "prefix_override",
        "suffix_override",
        "gender_identity",
        "pronouns",
        "addressing_style",
      ],
    },
  ],
  privacy: [
    { tableName: "users", fields: ["privacy_level"] },
    { tableName: "user_personalization_configs", fields: ["shortterm_cache_crossserver_opt_in"] },
  ],
  appearance: [{ tableName: "user_personalization_configs", fields: ["physical_appearance_tags"] }],
  response_modes: [
    {
      tableName: "user_personalization_configs",
      fields: ["impersonation_prompt", "personal_dtm", "personal_deliberate_tool_mode"],
    },
  ],
};

const TEXT_ARRAY_CONFIG_COLUMNS = new Set([
  "llm_disabled_params",
  "llm_stop_strings",
  "tool_notice_hidden_keys",
  "image_default_positive_tags",
  "image_default_negative_tags",
  "physical_appearance_tags",
]);

const JSONB_CONFIG_COLUMNS = new Set(["llm_logit_biases", "deliberate_tool_triggers"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPostgresTextArrayLiteral(values: readonly unknown[]): string {
  return `{${values.map((value) => `"${String(value).replace(/(["\\])/g, "\\$1")}"`).join(",")}}`;
}

function getDefinedPatch(source: unknown, fields: readonly string[]): ConfigPatch {
  if (!isRecord(source)) return {};
  return Object.fromEntries(
    fields
      .filter((field) => Object.hasOwn(source, field) && source[field] !== undefined)
      .map((field) => [field, source[field]]),
  );
}

function getSelectedSections<TSection extends string>(
  selectedSections: readonly TSection[] | undefined,
  presentSections: readonly TSection[],
  allowedSections: readonly TSection[],
): TSection[] | null {
  const selected = selectedSections ?? presentSections;
  if (selected.some((section) => !allowedSections.includes(section))) return null;
  return [...new Set(selected)].filter((section) => presentSections.includes(section));
}

function buildTablePatches(
  sectionValue: unknown,
  definitions: readonly SectionTableDefinition[],
  idColumn: ConfigTablePatch["idColumn"],
  id: number,
): ConfigTablePatch[] {
  return definitions.flatMap((definition) => {
    const source = definition.sourceKey && isRecord(sectionValue) ? sectionValue[definition.sourceKey] : sectionValue;
    const patch = getDefinedPatch(source, definition.fields);
    return Object.keys(patch).length > 0 ? [{ tableName: definition.tableName, idColumn, id, patch }] : [];
  });
}

function getStmCategories(value: unknown): Array<{ position: number; label: string; description: string }> | undefined {
  if (!isRecord(value) || !Array.isArray(value.stm_categories)) return undefined;
  return value.stm_categories.map((category) => {
    if (!isRecord(category)) throw new Error("Invalid STM category patch");
    const { position, label, description } = category;
    if (typeof position !== "number" || typeof label !== "string" || typeof description !== "string") {
      throw new Error("Invalid STM category patch");
    }
    return { position, label, description };
  });
}

/**
 * ImportRepository: owns all data import operations.
 *
 * Handles personal and server data import, per-domain slice imports
 * (memories, settings, config), import file validation, and cache
 * invalidation after successful writes. Private SQL methods hold raw
 * database logic; public methods add cache invalidation on top.
 * Composite methods (importPersonalData, importServerData) call private
 * SQL sub-methods directly to avoid double cache invalidation.
 */
class ImportRepository {
  private prepareWorkspaceConfig(
    input: unknown,
    selectedSections?: readonly WorkspaceConfigSection[],
  ): { success: true; prepared: PreparedConfigImport } | { success: false; error: string } {
    const rawData =
      isRecord(input) && input.type === "workspace_config"
        ? workspaceConfigExportSchema.safeParse(input)
        : workspaceConfigExportDataSchema.safeParse(input);
    if (!rawData.success) return { success: false, error: "commands.data.import.error_invalid_server_config_format" };

    const data = "data" in rawData.data ? rawData.data.data : rawData.data;
    const presentSections = (Object.keys(data) as WorkspaceConfigSection[]).filter(
      (section) => data[section] !== undefined,
    );
    const selected = getSelectedSections(
      selectedSections,
      presentSections,
      Object.keys(WORKSPACE_SECTION_TABLES) as WorkspaceConfigSection[],
    );
    if (!selected) return { success: false, error: "commands.data.import.error_invalid_config" };

    const tablePatches: ConfigTablePatch[] = [];
    let stmCategories: PreparedConfigImport["stmCategories"];
    let configFieldsCount = 0;

    for (const section of presentSections) {
      const sectionValidation = V2_CONFIG_SECTION_SCHEMAS[section].safeParse(data[section]);
      if (!sectionValidation.success) return { success: false, error: "commands.data.import.error_invalid_config" };
      if (!selected.includes(section)) continue;

      const sectionPatches = buildTablePatches(
        sectionValidation.data,
        WORKSPACE_SECTION_TABLES[section],
        "server_id",
        0,
      );
      tablePatches.push(...sectionPatches);
      configFieldsCount += sectionPatches.reduce(
        (count, tablePatch) => count + Object.keys(tablePatch.patch).length,
        0,
      );

      if (section === "memory" && isRecord(sectionValidation.data)) {
        const categories = getStmCategories(sectionValidation.data);
        if (categories !== undefined) {
          stmCategories = categories;
          configFieldsCount += categories.length;
        }
      }
    }

    return { success: true, prepared: { tablePatches, stmCategories, configFieldsCount } };
  }

  private preparePersonalConfig(
    input: unknown,
    selectedSections?: readonly PersonalConfigSection[],
  ): { success: true; prepared: PreparedConfigImport } | { success: false; error: string } {
    const rawData =
      isRecord(input) && input.type === "personal_config"
        ? personalConfigExportSchema.safeParse(input)
        : personalConfigExportDataSchema.safeParse(input);
    if (!rawData.success)
      return { success: false, error: "commands.data.import.error_invalid_personal_settings_format" };

    const data = "data" in rawData.data ? rawData.data.data : rawData.data;
    const presentSections = (Object.keys(data) as PersonalConfigSection[]).filter(
      (section) => data[section] !== undefined,
    );
    const selected = getSelectedSections(
      selectedSections,
      presentSections,
      Object.keys(PERSONAL_SECTION_TABLES) as PersonalConfigSection[],
    );
    if (!selected) return { success: false, error: "commands.data.import.error_invalid_config" };

    const tablePatches: ConfigTablePatch[] = [];
    let configFieldsCount = 0;
    for (const section of presentSections) {
      const sectionValidation = V2_CONFIG_SECTION_SCHEMAS[section].safeParse(data[section]);
      if (!sectionValidation.success) return { success: false, error: "commands.data.import.error_invalid_config" };
      if (!selected.includes(section)) continue;

      const sectionPatches = buildTablePatches(sectionValidation.data, PERSONAL_SECTION_TABLES[section], "user_id", 0);
      tablePatches.push(...sectionPatches);
      configFieldsCount += sectionPatches.reduce(
        (count, tablePatch) => count + Object.keys(tablePatch.patch).length,
        0,
      );
    }

    return { success: true, prepared: { tablePatches, configFieldsCount } };
  }

  private async hasConfigRow(tableName: string, idColumn: ConfigTablePatch["idColumn"], id: number): Promise<boolean> {
    const rows = await sql.unsafe(`SELECT ${idColumn} FROM ${tableName} WHERE ${idColumn} = $1 LIMIT 1`, [
      id,
    ] as SqlParameterArray);
    return rows.length > 0;
  }

  private async validateWorkspaceConfigTarget(
    serverDiscId: string,
    tablePatches: readonly ConfigTablePatch[],
    hasStmCategories: boolean,
  ): Promise<number | null> {
    const serverId = await this.resolveServerId(serverDiscId);
    if (!serverId) return null;

    const requiredRows = new Map<string, ConfigTablePatch["idColumn"]>();
    for (const tablePatch of tablePatches) requiredRows.set(tablePatch.tableName, tablePatch.idColumn);
    if (hasStmCategories) requiredRows.set("servers", "server_id");

    for (const [tableName, idColumn] of requiredRows) {
      if (!(await this.hasConfigRow(tableName, idColumn, serverId))) return null;
    }
    return serverId;
  }

  private async validatePersonalConfigTarget(
    userDiscId: string,
    tablePatches: readonly ConfigTablePatch[],
  ): Promise<number | null> {
    const userRows = await sql<Array<{ user_id: number }>>`
      SELECT user_id
      FROM users
      WHERE user_disc_id = ${userDiscId}
      LIMIT 1
    `;
    const userId = userRows[0]?.user_id;
    if (!userId) return null;

    const requiredRows = new Set(tablePatches.map((tablePatch) => tablePatch.tableName));
    for (const tableName of requiredRows) {
      if (!(await this.hasConfigRow(tableName, "user_id", userId))) return null;
    }
    return userId;
  }

  private async updateConfigRow(tx: SQL, tablePatch: ConfigTablePatch): Promise<void> {
    const entries = Object.entries(tablePatch.patch);
    if (entries.length === 0) return;

    const setParts: string[] = [];
    const values: SqlParameterArray = [];
    for (const [field, value] of entries) {
      const placeholder = `$${values.length + 1}`;
      if (TEXT_ARRAY_CONFIG_COLUMNS.has(field)) {
        if (!Array.isArray(value)) throw new Error(`Expected string array for ${field}`);
        setParts.push(`${field} = ${placeholder}::TEXT[]`);
        values.push(toPostgresTextArrayLiteral(value));
      } else if (JSONB_CONFIG_COLUMNS.has(field)) {
        setParts.push(`${field} = ${placeholder}::JSONB`);
        values.push(JSON.stringify(value));
      } else {
        setParts.push(`${field} = ${placeholder}`);
        values.push(value);
      }
    }

    values.push(tablePatch.id);
    const idPlaceholder = `$${values.length}`;
    // Identifiers come from fixed section definitions. Values remain bound parameters so a portable field cannot alter the statement.
    const result = await tx.unsafe(
      `UPDATE ${tablePatch.tableName} SET ${setParts.join(", ")} WHERE ${tablePatch.idColumn} = ${idPlaceholder} RETURNING ${tablePatch.idColumn}`,
      values,
    );
    if (result.length === 0) {
      throw new Error(`Config row not found in ${tablePatch.tableName}`);
    }
  }

  private async updateStmCategories(
    tx: SQL,
    serverId: number,
    categories: readonly { position: number; label: string; description: string }[],
  ): Promise<void> {
    await tx`DELETE FROM stm_categories WHERE server_id = ${serverId}`;
    for (const category of categories) {
      await tx`
        INSERT INTO stm_categories (server_id, position, label, description)
        VALUES (${serverId}, ${category.position}, ${category.label}, ${category.description})
      `;
    }
  }

  /**
   * Imports selected workspace config sections as one database operation.
   * Validation and target-row checks happen before the transaction so a failed patch cannot follow a committed patch.
   */
  async importWorkspaceConfig(
    serverDiscId: string,
    input: WorkspaceConfigExportData | WorkspaceConfigExport,
    selectedSections?: readonly WorkspaceConfigSection[],
  ): Promise<ImportResult> {
    try {
      const preparedResult = this.prepareWorkspaceConfig(input, selectedSections);
      if (!preparedResult.success) return preparedResult;
      const { prepared } = preparedResult;
      if (prepared.tablePatches.length === 0 && prepared.stmCategories === undefined) {
        return { success: true, itemsImported: { configFieldsCount: 0 } };
      }

      const serverId = await this.validateWorkspaceConfigTarget(
        serverDiscId,
        prepared.tablePatches,
        prepared.stmCategories !== undefined,
      );
      if (!serverId) return { success: false, error: "commands.data.import.error_no_server_data" };

      const tablePatches = prepared.tablePatches.map((tablePatch) => ({ ...tablePatch, id: serverId }));
      await sql.begin(async (tx: SQL) => {
        for (const tablePatch of tablePatches) await this.updateConfigRow(tx, tablePatch);
        if (prepared.stmCategories !== undefined) await this.updateStmCategories(tx, serverId, prepared.stmCategories);
      });

      invalidateTomoriStateCache(serverDiscId);
      return { success: true, itemsImported: { configFieldsCount: prepared.configFieldsCount } };
    } catch (error) {
      log.error(`Error importing workspace config for server ${serverDiscId}:`, error);
      return { success: false, error: "commands.data.import.error_import_failed" };
    }
  }

  /**
   * Imports selected personal config sections as one database operation.
   * Validation and target-row checks happen before the transaction so a failed patch cannot follow a committed patch.
   */
  async importPersonalConfig(
    userDiscId: string,
    input: PersonalConfigExportData | PersonalConfigExport,
    selectedSections?: readonly PersonalConfigSection[],
  ): Promise<ImportResult> {
    try {
      const preparedResult = this.preparePersonalConfig(input, selectedSections);
      if (!preparedResult.success) return preparedResult;
      const { prepared } = preparedResult;
      if (prepared.tablePatches.length === 0) {
        return { success: true, itemsImported: { configFieldsCount: 0 } };
      }

      const userId = await this.validatePersonalConfigTarget(userDiscId, prepared.tablePatches);
      if (!userId) return { success: false, error: "commands.data.import.error_update_failed" };

      const tablePatches = prepared.tablePatches.map((tablePatch) => ({ ...tablePatch, id: userId }));
      await sql.begin(async (tx: SQL) => {
        for (const tablePatch of tablePatches) await this.updateConfigRow(tx, tablePatch);
      });

      invalidateUserCache(userDiscId);
      return { success: true, itemsImported: { configFieldsCount: prepared.configFieldsCount } };
    } catch (error) {
      log.error(`Error importing personal config for user ${userDiscId}:`, error);
      return { success: false, error: "commands.data.import.error_import_failed" };
    }
  }

  /** Upserts a user row by Discord ID and returns the internal user_id. */
  private async ensureUserId(userDiscId: string): Promise<number | null> {
    const upserted = await sql.begin(async (tx) => {
      const rows = await tx<Array<{ user_id: number }>>`
        INSERT INTO users (
          user_disc_id,
          language_pref
        ) VALUES (
          ${userDiscId},
          'en'
        )
        ON CONFLICT (user_disc_id) DO UPDATE
        SET user_disc_id = EXCLUDED.user_disc_id
        RETURNING user_id
      `;

      const userId = rows[0]?.user_id;
      if (userId) {
        await tx`
          INSERT INTO user_personalization_configs (user_id, user_nickname)
          VALUES (${userId}, ${userDiscId})
          ON CONFLICT (user_id) DO NOTHING
        `;
      }

      return rows;
    });

    return upserted[0]?.user_id ?? null;
  }

  /** Resolves a Discord server ID to the internal server_id. */
  private async resolveServerId(serverDiscId: string): Promise<number | null> {
    const serverRows = await sql<Array<{ server_id: number }>>`
      SELECT s.server_id
      FROM servers s
      WHERE s.server_disc_id = ${serverDiscId}
      LIMIT 1
    `;
    return serverRows[0]?.server_id ?? null;
  }

  /** Normalizes bigint/string/number persona_lineage_id values to a plain number. */
  private coerceLineageId(value: number | string | bigint | null | undefined): number | null {
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "string" && value.trim() !== "") return Number(value);
    if (typeof value === "number") return value;
    return null;
  }

  /** Returns the main persona persona_id and persona_lineage_id for a server. */
  private async resolveMainTomoriScope(
    serverId: number,
  ): Promise<{ personaId: number; personaLineageId: number } | null> {
    const mainPersonaRows = await sql<Array<{ persona_id: number; persona_lineage_id: number | string | bigint }>>`
      SELECT persona_id, persona_lineage_id
      FROM personas
      WHERE server_id = ${serverId}
        AND is_alter = false
      ORDER BY updated_at DESC NULLS LAST, persona_id DESC
      LIMIT 1
    `;

    const mainTomori = mainPersonaRows[0];
    if (!mainTomori) return null;

    const personaLineageId = this.coerceLineageId(mainTomori.persona_lineage_id);
    if (typeof personaLineageId !== "number" || !Number.isFinite(personaLineageId)) return null;

    return { personaId: mainTomori.persona_id, personaLineageId };
  }

  private async sqlImportPersonalMemories(
    userDiscId: string,
    memories: MemoryItem[],
    personaLineageId = 0,
  ): Promise<ImportResult> {
    try {
      for (const memory of memories) {
        const validation = validateMemoryContent(memory.content);
        if (!validation.isValid) {
          return { success: false, error: `commands.data.import.error_invalid_memory|${validation.error}` };
        }
      }

      const targetUserId = await this.ensureUserId(userDiscId);
      if (!targetUserId) {
        return { success: false, error: "commands.data.import.error_update_failed" };
      }

      await sql`
        DELETE FROM personal_memories
        WHERE user_id = ${targetUserId}
          AND persona_lineage_id = ${personaLineageId}
      `;

      for (const memory of memories) {
        await sql`
          INSERT INTO personal_memories (user_id, persona_lineage_id, content, tags)
            VALUES (${targetUserId}, ${personaLineageId}, ${memory.content}, ${sql.array(memory.tags, "TEXT")})
        `;
      }

      return { success: true, itemsImported: { memoriesCount: memories.length } };
    } catch (error) {
      log.error(`Error importing personal memories for user ${userDiscId}:`, error);
      return { success: false, error: "commands.data.import.error_import_failed" };
    }
  }

  private async sqlImportPersonalSettings(
    userDiscId: string,
    importData: PersonalSettingsExportData,
  ): Promise<ImportResult> {
    try {
      const physicalAppearanceTags = importData.physical_appearance_tags ?? [];
      const naiCharRefUrl = importData.nai_char_ref_url ?? null;
      const impersonationPrompt = importData.impersonation_prompt ?? null;

      const updateResult = await sql.begin(async (tx) => {
        const userRows = await tx<Array<{ user_id: number }>>`
          INSERT INTO users (
            user_disc_id,
            language_pref,
            privacy_level
          ) VALUES (
            ${userDiscId},
            ${importData.language_pref},
            ${importData.privacy_level ?? 0}
          )
          ON CONFLICT (user_disc_id) DO UPDATE
          SET
            language_pref = EXCLUDED.language_pref,
            privacy_level = COALESCE(${importData.privacy_level ?? null}, users.privacy_level)
          RETURNING user_id
        `;

        const userId = userRows[0]?.user_id;
        if (!userId) {
          return userRows;
        }

        await tx`
          INSERT INTO user_personalization_configs (
            user_id,
            user_nickname,
            shortterm_cache_crossserver_opt_in,
            physical_appearance_tags,
            nai_char_ref_url,
            impersonation_prompt,
            personal_dtm,
            personal_deliberate_tool_mode,
            timezone_offset,
            prefix_override,
            suffix_override,
            gender_identity,
            pronouns,
            addressing_style
          ) VALUES (
            ${userId},
            ${importData.user_nickname},
            ${importData.shortterm_cache_crossserver_opt_in ?? false},
            ${sql.array(physicalAppearanceTags, "TEXT")},
            ${naiCharRefUrl},
            ${impersonationPrompt},
            ${importData.personal_dtm ?? "follow"},
            ${importData.personal_deliberate_tool_mode ?? "follow"},
            ${importData.timezone_offset ?? null},
            ${importData.prefix_override ?? null},
            ${importData.suffix_override ?? null},
            ${importData.gender_identity ?? null},
            ${importData.pronouns ?? null},
            ${importData.addressing_style ?? null}
          )
          ON CONFLICT (user_id) DO UPDATE SET
            user_nickname = EXCLUDED.user_nickname,
            shortterm_cache_crossserver_opt_in = COALESCE(${importData.shortterm_cache_crossserver_opt_in ?? null}, user_personalization_configs.shortterm_cache_crossserver_opt_in),
            physical_appearance_tags = EXCLUDED.physical_appearance_tags,
            nai_char_ref_url = EXCLUDED.nai_char_ref_url,
            impersonation_prompt = EXCLUDED.impersonation_prompt,
            personal_dtm = COALESCE(${importData.personal_dtm ?? null}, user_personalization_configs.personal_dtm),
            personal_deliberate_tool_mode = COALESCE(${importData.personal_deliberate_tool_mode ?? null}, user_personalization_configs.personal_deliberate_tool_mode),
            timezone_offset = CASE WHEN ${importData.timezone_offset !== undefined} THEN EXCLUDED.timezone_offset ELSE user_personalization_configs.timezone_offset END,
            prefix_override = CASE WHEN ${importData.prefix_override !== undefined} THEN EXCLUDED.prefix_override ELSE user_personalization_configs.prefix_override END,
            suffix_override = CASE WHEN ${importData.suffix_override !== undefined} THEN EXCLUDED.suffix_override ELSE user_personalization_configs.suffix_override END,
            gender_identity = CASE WHEN ${importData.gender_identity !== undefined} THEN EXCLUDED.gender_identity ELSE user_personalization_configs.gender_identity END,
            pronouns = CASE WHEN ${importData.pronouns !== undefined} THEN EXCLUDED.pronouns ELSE user_personalization_configs.pronouns END,
            addressing_style = CASE WHEN ${importData.addressing_style !== undefined} THEN EXCLUDED.addressing_style ELSE user_personalization_configs.addressing_style END,
            updated_at = NOW()
        `;

        for (const preference of importData.persona_naming_preferences ?? []) {
          await tx`
            INSERT INTO user_persona_naming_preferences (
              user_id,
              persona_lineage_id,
              nickname_override,
              prefix_override,
              suffix_override
            ) VALUES (
              ${userId},
              ${preference.persona_lineage_id},
              ${preference.nickname_override},
              ${preference.prefix_override},
              ${preference.suffix_override}
            )
            ON CONFLICT (user_id, persona_lineage_id) DO UPDATE SET
              nickname_override = EXCLUDED.nickname_override,
              prefix_override = EXCLUDED.prefix_override,
              suffix_override = EXCLUDED.suffix_override,
              updated_at = NOW()
          `;
        }

        return userRows;
      });

      if (!updateResult.length) {
        return { success: false, error: "commands.data.import.error_update_failed" };
      }

      // Count imported fields (base 2 + optional impersonation/image/behavioral fields)
      let fieldsCount = 2;
      if (impersonationPrompt) fieldsCount++;
      if (physicalAppearanceTags.length > 0) fieldsCount++;
      if (naiCharRefUrl) fieldsCount++;
      if (importData.privacy_level !== undefined) fieldsCount++;
      if (importData.personal_dtm !== undefined) fieldsCount++;
      if (importData.personal_deliberate_tool_mode !== undefined) fieldsCount++;
      if (importData.shortterm_cache_crossserver_opt_in !== undefined) fieldsCount++;
      if (importData.timezone_offset !== undefined) fieldsCount++;
      if (importData.prefix_override !== undefined) fieldsCount++;
      if (importData.suffix_override !== undefined) fieldsCount++;
      if (importData.gender_identity !== undefined) fieldsCount++;
      if (importData.pronouns !== undefined) fieldsCount++;
      if (importData.addressing_style !== undefined) fieldsCount++;
      fieldsCount += importData.persona_naming_preferences?.length ?? 0;

      return { success: true, itemsImported: { configFieldsCount: fieldsCount } };
    } catch (error) {
      log.error(`Error importing personal settings for user ${userDiscId}:`, error);
      return { success: false, error: "commands.data.import.error_import_failed" };
    }
  }

  private async sqlImportServerConfig(serverDiscId: string, config: ServerConfigExport): Promise<ImportResult> {
    try {
      const serverId = await this.resolveServerId(serverDiscId);
      if (!serverId) {
        return { success: false, error: "commands.data.import.error_no_server_data" };
      }

      // STM customization travels as nested keys (stm_config / stm_categories) that are
      // restored via shortTermMemoryRepository.fromExportShape, NOT the dynamic flat-config
      // SQL writer: so exclude them from the column-name allowlist validation below.
      const configFields = Object.keys(config).filter((f) => f !== "stm_config" && f !== "stm_categories");
      try {
        validateTomoriConfigFields(configFields);
      } catch (error) {
        log.error("Config field validation failed during import:", error);
        return { success: false, error: "commands.data.import.error_invalid_config" };
      }

      const hasMaxOutputTokens = Object.hasOwn(config, "llm_max_output_tokens");

      const modelPatch = {
        llm_temperature: config.llm_temperature,
        thinking_level: config.thinking_level,
        llm_disabled_params: config.llm_disabled_params,
      };

      const chatPatch: Partial<ServerChatConfigRow> = {
        llm_top_p: config.llm_top_p,
        llm_top_k: config.llm_top_k,
        llm_frequency_penalty: config.llm_frequency_penalty,
        llm_presence_penalty: config.llm_presence_penalty,
        llm_min_p: config.llm_min_p,
        llm_logit_biases: config.llm_logit_biases,
        llm_stop_strings: config.llm_stop_strings,
        llm_stop_speaker_pattern_enabled: config.llm_stop_speaker_pattern_enabled ?? false,
        humanizer_degree: config.humanizer_degree as ServerChatConfigRow["humanizer_degree"],
        timezone_offset: config.timezone_offset,
        message_fetch_limit: config.message_fetch_limit,
        system_prompt: config.system_prompt ?? null,
        self_debug_enabled: config.self_debug_enabled,
        model_randomizer_enabled: config.model_randomizer_enabled,
        ...(hasMaxOutputTokens && { llm_max_output_tokens: config.llm_max_output_tokens ?? null }),
        ...(config.context_note !== undefined && { context_note: config.context_note }),
        ...(config.context_note_depth !== undefined && { context_note_depth: config.context_note_depth }),
        ...(config.cascade_limit !== undefined && { cascade_limit: config.cascade_limit }),
        ...(config.match_limit !== undefined && { match_limit: config.match_limit }),
        ...(config.send_message_limit !== undefined && { send_message_limit: config.send_message_limit }),
      };

      const memberPermPatch = {
        server_memteaching_enabled: config.server_memteaching_enabled,
        attribute_memteaching_enabled: config.attribute_memteaching_enabled,
        sampledialogue_memteaching_enabled: config.sampledialogue_memteaching_enabled,
        self_teaching_enabled: config.self_teaching_enabled,
        personal_memories_enabled: config.personal_memories_enabled,
        ...(config.prompt_snapshot_enabled !== undefined && {
          prompt_snapshot_enabled: config.prompt_snapshot_enabled,
        }),
      };

      const capsPatch = {
        emoji_usage_enabled: config.emoji_usage_enabled,
        sticker_usage_enabled: config.sticker_usage_enabled,
        imagegen_enabled: config.imagegen_enabled,
        web_search_enabled: config.web_search_enabled,
        ...(config.manage_message_enabled !== undefined && { manage_message_enabled: config.manage_message_enabled }),
        ...(config.videogen_enabled !== undefined && { videogen_enabled: config.videogen_enabled }),
        ...(config.voice_message_enabled !== undefined && { voice_message_enabled: config.voice_message_enabled }),
        ...(config.thread_creation_enabled !== undefined && {
          thread_creation_enabled: config.thread_creation_enabled,
        }),
        ...(config.user_blocking_enabled !== undefined && {
          user_blocking_enabled: config.user_blocking_enabled,
        }),
        ...(config.time_awareness_enabled !== undefined && {
          time_awareness_enabled: config.time_awareness_enabled,
        }),
        ...(config.tool_use_enabled !== undefined && { tool_use_enabled: config.tool_use_enabled }),
        ...(config.short_term_memory_enabled !== undefined && {
          short_term_memory_enabled: config.short_term_memory_enabled,
        }),
        ...(config.verbatim_tool_calling_enabled !== undefined && {
          verbatim_tool_calling_enabled: config.verbatim_tool_calling_enabled,
        }),
        user_info_updates_enabled: config.user_info_updates_enabled,
      };

      // server_notice_embeds_configs: tool notice key suppressions
      // ToolNoticeKey union type is satisfied by the validated string values from the export schema.
      const noticeEmbedsPatch: Partial<ServerNoticeEmbedsConfigRow> = {
        tool_notice_hidden_keys:
          config.tool_notice_hidden_keys as ServerNoticeEmbedsConfigRow["tool_notice_hidden_keys"],
      };

      const requiredWriteResults = await Promise.all([
        configRepository.updateModelConfig(serverId, modelPatch),
        configRepository.updateChatConfig(serverId, chatPatch),
        configRepository.updateMemberPermissionsConfig(serverId, memberPermPatch),
        configRepository.updateCapabilitiesConfig(serverId, capsPatch),
        configRepository.updateNoticeEmbedsConfig(serverId, noticeEmbedsPatch),
      ]);

      if (requiredWriteResults.some((ok) => !ok)) {
        return { success: false, error: "commands.data.import.error_update_failed" };
      }

      const optionalWriteResults = await Promise.all([
        config.uncensor_injection_enabled !== undefined ||
        config.uncensor_unicode_space_enabled !== undefined ||
        config.uncensor_sanitize_enabled !== undefined
          ? configRepository.updateNsfwConfig(serverId, {
              ...(config.uncensor_injection_enabled !== undefined && {
                uncensor_injection_enabled: config.uncensor_injection_enabled,
              }),
              ...(config.uncensor_unicode_space_enabled !== undefined && {
                uncensor_unicode_space_enabled: config.uncensor_unicode_space_enabled,
              }),
              ...(config.uncensor_sanitize_enabled !== undefined && {
                uncensor_sanitize_enabled: config.uncensor_sanitize_enabled,
              }),
            })
          : Promise.resolve(true),

        config.voice_transcript_chat_mode !== undefined ||
        config.chatterbox_turbo_enabled !== undefined ||
        config.chatterbox_cfg_weight !== undefined ||
        config.chatterbox_exaggeration !== undefined
          ? configRepository.updateSpeechConfig(serverId, {
              ...(config.voice_transcript_chat_mode !== undefined && {
                voice_transcript_chat_mode: config.voice_transcript_chat_mode,
              }),
              ...(config.chatterbox_turbo_enabled !== undefined && {
                chatterbox_turbo_enabled: config.chatterbox_turbo_enabled,
              }),
              ...(config.chatterbox_cfg_weight !== undefined && {
                chatterbox_cfg_weight: config.chatterbox_cfg_weight,
              }),
              ...(config.chatterbox_exaggeration !== undefined && {
                chatterbox_exaggeration: config.chatterbox_exaggeration,
              }),
            })
          : Promise.resolve(true),

        config.always_reply_enabled !== undefined ||
        config.deliberate_trigger_mode !== undefined ||
        config.deliberate_tool_mode !== undefined ||
        config.deliberate_tool_context_turns !== undefined ||
        config.deliberate_tool_triggers !== undefined ||
        config.cooldown_type !== undefined ||
        config.cooldown_length !== undefined
          ? configRepository.updateTriggerBehaviorConfig(serverId, {
              ...(config.always_reply_enabled !== undefined && { always_reply_enabled: config.always_reply_enabled }),
              ...(config.deliberate_trigger_mode !== undefined && {
                deliberate_trigger_mode: config.deliberate_trigger_mode,
              }),
              ...(config.deliberate_tool_mode !== undefined && {
                deliberate_tool_mode: config.deliberate_tool_mode,
              }),
              ...(config.deliberate_tool_context_turns !== undefined && {
                deliberate_tool_context_turns: config.deliberate_tool_context_turns,
              }),
              ...(config.deliberate_tool_triggers !== undefined && {
                deliberate_tool_triggers: config.deliberate_tool_triggers,
              }),
              ...(config.cooldown_type !== undefined && { cooldown_type: config.cooldown_type }),
              ...(config.cooldown_length !== undefined && { cooldown_length: config.cooldown_length }),
            })
          : Promise.resolve(true),

        config.stm_privacy_bypass !== undefined
          ? configRepository.updateChannelScopeConfig(serverId, { stm_privacy_bypass: config.stm_privacy_bypass })
          : Promise.resolve(true),

        config.image_default_positive_tags !== undefined ||
        config.image_default_negative_tags !== undefined ||
        config.nai_sampler !== undefined ||
        config.nai_steps !== undefined ||
        config.nai_scale !== undefined ||
        config.nai_noise_schedule !== undefined ||
        config.nai_cfg_rescale !== undefined ||
        config.nai_preset_name !== undefined
          ? configRepository.updateNovelaiImagegenConfig(serverId, {
              ...(config.image_default_positive_tags !== undefined && {
                image_default_positive_tags: config.image_default_positive_tags,
              }),
              ...(config.image_default_negative_tags !== undefined && {
                image_default_negative_tags: config.image_default_negative_tags,
              }),
              ...(config.nai_sampler !== undefined && { nai_sampler: config.nai_sampler }),
              ...(config.nai_steps !== undefined && { nai_steps: config.nai_steps }),
              ...(config.nai_scale !== undefined && { nai_scale: config.nai_scale }),
              ...(config.nai_noise_schedule !== undefined && { nai_noise_schedule: config.nai_noise_schedule }),
              ...(config.nai_cfg_rescale !== undefined && { nai_cfg_rescale: config.nai_cfg_rescale }),
              ...(config.nai_preset_name !== undefined && { nai_preset_name: config.nai_preset_name }),
            })
          : Promise.resolve(true),

        config.user_byok_mode !== undefined
          ? configRepository.updateByokConfig(serverId, { user_byok_mode: config.user_byok_mode })
          : Promise.resolve(true),

        config.memory_tagging_enabled !== undefined || config.channel_memory_enabled !== undefined
          ? configRepository.updateMemoryConfig(serverId, {
              ...(config.memory_tagging_enabled !== undefined && {
                memory_tagging_enabled: config.memory_tagging_enabled,
              }),
              ...(config.channel_memory_enabled !== undefined && {
                channel_memory_enabled: config.channel_memory_enabled,
              }),
            })
          : Promise.resolve(true),

        config.welcome_prompt !== undefined
          ? configRepository.updateWelcomeConfig(serverId, { welcome_prompt: config.welcome_prompt })
          : Promise.resolve(true),

        // STM customization (config + categories) restores via the repository's export
        // shape, which upserts server_stm_configs and replace-alls stm_categories.
        config.stm_config !== undefined || config.stm_categories !== undefined
          ? shortTermMemoryRepository.fromExportShape(serverDiscId, {
              stm_config: config.stm_config ?? null,
              stm_categories: config.stm_categories ?? [],
            })
          : Promise.resolve(true),
      ]);

      if (optionalWriteResults.some((ok) => !ok)) {
        return { success: false, error: "commands.data.import.error_update_failed" };
      }

      return { success: true, itemsImported: { configFieldsCount: configFields.length } };
    } catch (error) {
      log.error(`Error importing server config for server ${serverDiscId}:`, error);
      return { success: false, error: "commands.data.import.error_import_failed" };
    }
  }

  private async sqlImportServerMemories(
    serverDiscId: string,
    memories: MemoryItem[],
    target: { mode: "persona"; personaId?: number } | { mode: "global" },
  ): Promise<ImportResult> {
    try {
      const serverId = await this.resolveServerId(serverDiscId);
      if (!serverId) {
        return { success: false, error: "commands.data.import.error_no_server_data" };
      }

      for (const memory of memories) {
        const validation = validateMemoryContent(memory.content);
        if (!validation.isValid) {
          return { success: false, error: `commands.data.import.error_invalid_server_memory|${validation.error}` };
        }
      }

      let insertTomoriId: number | null = null;
      let targetPersonaLineageId: number | null = null;

      if (target.mode === "persona") {
        if (target.personaId) {
          const [targetPersona] = await sql<
            Array<{
              persona_id: number;
              persona_lineage_id: number | string | bigint;
            }>
          >`
            SELECT persona_id, persona_lineage_id
            FROM personas
            WHERE server_id = ${serverId}
              AND persona_id = ${target.personaId}
            LIMIT 1
          `;
          if (!targetPersona) {
            return { success: false, error: "commands.data.import.error_no_server_data" };
          }
          insertTomoriId = targetPersona.persona_id;
          targetPersonaLineageId = this.coerceLineageId(targetPersona.persona_lineage_id);
        } else {
          const mainScope = await this.resolveMainTomoriScope(serverId);
          insertTomoriId = mainScope?.personaId ?? null;
          targetPersonaLineageId = mainScope?.personaLineageId ?? null;
        }
      } else {
        // Global target maps to the current main persona lineage.
        const mainScope = await this.resolveMainTomoriScope(serverId);
        targetPersonaLineageId = mainScope?.personaLineageId ?? null;
        insertTomoriId = null;
      }

      if (typeof targetPersonaLineageId !== "number" || !Number.isFinite(targetPersonaLineageId)) {
        return { success: false, error: "commands.data.import.error_no_server_data" };
      }

      await sql`
        DELETE FROM server_memories
        WHERE server_id = ${serverId}
          AND persona_lineage_id = ${targetPersonaLineageId}
      `;

      if (memories.length === 0) {
        return { success: true, itemsImported: { memoriesCount: 0 } };
      }

      const userRows = await sql<Array<{ user_id: number }>>`
        SELECT u.user_id
        FROM users u
        LIMIT 1
      `;

      if (!userRows.length) {
        return { success: false, error: "commands.data.import.error_no_users" };
      }

      const userId = userRows[0].user_id;

      for (const memory of memories) {
        await sql`
          INSERT INTO server_memories (server_id, persona_id, persona_lineage_id, user_id, content, tags)
          VALUES (${serverId}, ${insertTomoriId}, ${targetPersonaLineageId}, ${userId}, ${memory.content}, ${sql.array(memory.tags, "TEXT")})
        `;
      }

      return { success: true, itemsImported: { memoriesCount: memories.length } };
    } catch (error) {
      log.error(`Error importing server memories for server ${serverDiscId}:`, error);
      return { success: false, error: "commands.data.import.error_import_failed" };
    }
  }

  /**
   * Raw composite personal import; no cache invalidation.
   * Used internally by importPersonalData (which adds cache) and
   * fromExportShape (which intentionally skips cache for pipeline use).
   */
  private async sqlImportPersonalData(
    userDiscId: string,
    importData: PersonalExportData,
    personaLineageId = 0,
  ): Promise<ImportResult> {
    const settingsResult = await this.sqlImportPersonalSettings(userDiscId, {
      user_nickname: importData.user_nickname,
      language_pref: importData.language_pref,
      impersonation_prompt: importData.impersonation_prompt ?? null,
      physical_appearance_tags: [],
      nai_char_ref_url: null,
      persona_naming_preferences: [],
    });
    if (!settingsResult.success) return settingsResult;

    const memoriesResult = await this.sqlImportPersonalMemories(
      userDiscId,
      importData.personal_memories,
      personaLineageId,
    );
    if (!memoriesResult.success) return memoriesResult;

    return {
      success: true,
      itemsImported: {
        memoriesCount: memoriesResult.itemsImported?.memoriesCount ?? 0,
        configFieldsCount: settingsResult.itemsImported?.configFieldsCount ?? 0,
      },
    };
  }

  /**
   * Raw composite server import; no cache invalidation.
   * Used internally by importServerData (which adds cache).
   */
  private async sqlImportServerData(
    serverDiscId: string,
    importData: ServerExportData,
    personaId?: number,
  ): Promise<ImportResult> {
    const configResult = await this.sqlImportServerConfig(serverDiscId, importData.config);
    if (!configResult.success) return configResult;

    const memoriesResult = await this.sqlImportServerMemories(serverDiscId, importData.server_memories, {
      mode: "persona",
      personaId,
    });
    if (!memoriesResult.success) return memoriesResult;

    return {
      success: true,
      itemsImported: {
        memoriesCount: memoriesResult.itemsImported?.memoriesCount ?? 0,
        configFieldsCount: configResult.itemsImported?.configFieldsCount ?? 0,
      },
    };
  }

  /**
   * Imports personal memories for a user from an export payload.
   * @param userDiscId - Discord user snowflake
   * @param memories - Array of memory items to import
   * @param personaLineageId - Persona lineage namespace to import into (default 0)
   */
  async importPersonalMemories(
    userDiscId: string,
    memories: MemoryItem[],
    personaLineageId = 0,
  ): Promise<ImportResult> {
    const result = await this.sqlImportPersonalMemories(userDiscId, memories, personaLineageId);
    if (result.success) invalidateUserCache(userDiscId);
    return result;
  }

  async importWorkspaceMemoryBundle(
    serverDiscId: string,
    importerUserDiscId: string,
    mappings: ReadonlyArray<{ bucketName: string; personaId: number; memories: MemoryItem[] }>,
    strategy: "merge" | "replace",
  ): Promise<ImportResult> {
    try {
      if (mappings.length === 0) return { success: false, error: "commands.data.import.error_update_failed" };

      const serverId = await this.resolveServerId(serverDiscId);
      if (!serverId) return { success: false, error: "commands.data.import.error_no_server_data" };

      const importerUserId = await this.ensureUserId(importerUserDiscId);
      if (!importerUserId) return { success: false, error: "commands.data.import.error_update_failed" };

      const limits = getMemoryLimits();
      const destinations = new Set<number>();
      const preparedMappings: Array<{
        personaId: number;
        personaLineageId: number;
        memories: MemoryItem[];
      }> = [];
      let memoriesInserted = 0;
      let memoriesSkipped = 0;

      for (const mapping of mappings) {
        const [persona] = await sql<Array<{ persona_id: number; persona_lineage_id: number | string | bigint }>>`
          SELECT persona_id, persona_lineage_id
          FROM personas
          WHERE persona_id = ${mapping.personaId}
            AND server_id = ${serverId}
          LIMIT 1
        `;
        const personaLineageId = this.coerceLineageId(persona?.persona_lineage_id);
        if (!persona || personaLineageId === null || !Number.isFinite(personaLineageId)) {
          log.error("Workspace memory bundle persona lookup failed", undefined, {
            metadata: { bucketName: mapping.bucketName },
          });
          return {
            success: false,
            error: "commands.data.import.error_no_server_data",
          };
        }
        if (destinations.has(personaLineageId)) {
          log.error("Workspace memory bundle contains a duplicate destination", undefined, {
            metadata: { bucketName: mapping.bucketName },
          });
          return {
            success: false,
            error: "commands.data.import.error_update_failed",
          };
        }
        destinations.add(personaLineageId);

        for (const memory of mapping.memories) {
          const validation = validateMemoryContent(memory.content);
          if (!validation.isValid) {
            return {
              success: false,
              error: `commands.data.import.error_invalid_server_memory|${validation.error}`,
            };
          }
        }

        let memoriesToInsert = mapping.memories;
        let existingRows: MemoryRow[] = [];
        if (strategy === "merge") {
          existingRows = await sql<MemoryRow[]>`
            SELECT content, tags
            FROM server_memories
            WHERE server_id = ${serverId}
              AND persona_lineage_id = ${personaLineageId}
          `;
          const existingMemories = new Set(
            existingRows.map((row) => memoryKey({ content: row.content, tags: row.tags ?? [] })),
          );
          const incomingMemories = new Set<string>();
          memoriesToInsert = mapping.memories.filter((memory) => {
            const key = memoryKey(memory);
            if (existingMemories.has(key) || incomingMemories.has(key)) return false;
            incomingMemories.add(key);
            return true;
          });
          memoriesSkipped += mapping.memories.length - memoriesToInsert.length;
        }

        if (
          (strategy === "merge" ? existingRows.length + memoriesToInsert.length : memoriesToInsert.length) >
          limits.maxServerMemories
        ) {
          log.error("Workspace memory bundle exceeds the memory limit", undefined, {
            metadata: { bucketName: mapping.bucketName },
          });
          return {
            success: false,
            error: "commands.data.import.error_update_failed",
          };
        }

        memoriesInserted += memoriesToInsert.length;
        preparedMappings.push({
          personaId: persona.persona_id,
          personaLineageId,
          memories: memoriesToInsert,
        });
      }

      let memoriesDeleted = 0;
      await sql.begin(async (tx: SQL) => {
        for (const mapping of preparedMappings) {
          if (strategy === "replace") {
            const deletedRows = await tx<Array<{ server_memory_id: number }>>`
              DELETE FROM server_memories
              WHERE server_id = ${serverId}
                AND persona_lineage_id = ${mapping.personaLineageId}
              RETURNING server_memory_id
            `;
            memoriesDeleted += deletedRows.length;
          }
          for (const memory of mapping.memories) {
            await tx`
              INSERT INTO server_memories (server_id, persona_id, persona_lineage_id, user_id, content, tags)
              VALUES (${serverId}, ${mapping.personaId}, ${mapping.personaLineageId}, ${importerUserId}, ${memory.content}, ${sql.array(memory.tags, "TEXT")})
            `;
          }
        }
      });

      invalidateTomoriStateCache(serverDiscId);
      return {
        success: true,
        itemsImported: { memoriesInserted, memoriesSkipped, memoriesDeleted, memoriesCount: memoriesInserted },
      };
    } catch (error) {
      log.error(`Error importing workspace memory bundle for server ${serverDiscId}:`, error);
      return { success: false, error: "commands.data.import.error_import_failed" };
    }
  }

  async importPersonalMemoryBundle(
    userDiscId: string,
    mappings: ReadonlyArray<{ bucketName: string; personaLineageId: number; memories: MemoryItem[] }>,
    strategy: "merge" | "replace",
  ): Promise<ImportResult> {
    try {
      if (mappings.length === 0) return { success: false, error: "commands.data.import.error_update_failed" };

      const userId = await this.ensureUserId(userDiscId);
      if (!userId) return { success: false, error: "commands.data.import.error_update_failed" };

      const limits = getMemoryLimits();
      const destinations = new Set<number>();
      const preparedMappings: Array<{ personaLineageId: number; memories: MemoryItem[] }> = [];
      let memoriesInserted = 0;
      let memoriesSkipped = 0;

      for (const mapping of mappings) {
        if (!Number.isFinite(mapping.personaLineageId) || destinations.has(mapping.personaLineageId)) {
          log.error("Personal memory bundle contains an invalid or duplicate destination", undefined, {
            metadata: { bucketName: mapping.bucketName },
          });
          return {
            success: false,
            error: "commands.data.import.error_update_failed",
          };
        }
        destinations.add(mapping.personaLineageId);

        for (const memory of mapping.memories) {
          const validation = validateMemoryContent(memory.content);
          if (!validation.isValid) {
            return { success: false, error: `commands.data.import.error_invalid_memory|${validation.error}` };
          }
        }

        let memoriesToInsert = mapping.memories;
        let existingRows: MemoryRow[] = [];
        if (strategy === "merge") {
          existingRows = await sql<MemoryRow[]>`
            SELECT content, tags
            FROM personal_memories
            WHERE user_id = ${userId}
              AND persona_lineage_id = ${mapping.personaLineageId}
          `;
          const existingMemories = new Set(
            existingRows.map((row) => memoryKey({ content: row.content, tags: row.tags ?? [] })),
          );
          const incomingMemories = new Set<string>();
          memoriesToInsert = mapping.memories.filter((memory) => {
            const key = memoryKey(memory);
            if (existingMemories.has(key) || incomingMemories.has(key)) return false;
            incomingMemories.add(key);
            return true;
          });
          memoriesSkipped += mapping.memories.length - memoriesToInsert.length;
        }

        if (
          (strategy === "merge" ? existingRows.length + memoriesToInsert.length : memoriesToInsert.length) >
          limits.maxPersonalMemories
        ) {
          log.error("Personal memory bundle exceeds the memory limit", undefined, {
            metadata: { bucketName: mapping.bucketName },
          });
          return {
            success: false,
            error: "commands.data.import.error_update_failed",
          };
        }

        memoriesInserted += memoriesToInsert.length;
        preparedMappings.push({ personaLineageId: mapping.personaLineageId, memories: memoriesToInsert });
      }

      let memoriesDeleted = 0;
      await sql.begin(async (tx: SQL) => {
        for (const mapping of preparedMappings) {
          if (strategy === "replace") {
            const deletedRows = await tx<Array<{ personal_memory_id: number }>>`
              DELETE FROM personal_memories
              WHERE user_id = ${userId}
                AND persona_lineage_id = ${mapping.personaLineageId}
              RETURNING personal_memory_id
            `;
            memoriesDeleted += deletedRows.length;
          }
          for (const memory of mapping.memories) {
            await tx`
              INSERT INTO personal_memories (user_id, persona_lineage_id, content, tags)
              VALUES (${userId}, ${mapping.personaLineageId}, ${memory.content}, ${sql.array(memory.tags, "TEXT")})
            `;
          }
        }
      });

      invalidateUserCache(userDiscId);
      return {
        success: true,
        itemsImported: { memoriesInserted, memoriesSkipped, memoriesDeleted, memoriesCount: memoriesInserted },
      };
    } catch (error) {
      log.error(`Error importing personal memory bundle for user ${userDiscId}:`, error);
      return { success: false, error: "commands.data.import.error_import_failed" };
    }
  }

  /**
   * Imports personal settings for a user from an export payload.
   * @param userDiscId - Discord user snowflake
   * @param importData - PersonalSettingsExportData payload
   */
  async importPersonalSettings(userDiscId: string, importData: PersonalSettingsExportData): Promise<ImportResult> {
    const result = await this.sqlImportPersonalSettings(userDiscId, importData);
    if (result.success) invalidateUserCache(userDiscId);
    return result;
  }

  /**
   * Imports server configuration from an export payload.
   * @param serverDiscId - Discord server snowflake
   * @param config - ServerConfigExport payload
   */
  async importServerConfig(serverDiscId: string, config: ServerConfigExport): Promise<ImportResult> {
    const result = await this.sqlImportServerConfig(serverDiscId, config);
    if (result.success) invalidateTomoriStateCache(serverDiscId);
    return result;
  }

  /**
   * @param serverDiscId - Discord server snowflake
   * @param memories - Array of memory items to import
   * @param target - Target scope: persona (with optional personaId) or global
   */
  async importServerMemories(
    serverDiscId: string,
    memories: MemoryItem[],
    target: { mode: "persona"; personaId?: number } | { mode: "global" },
  ): Promise<ImportResult> {
    const result = await this.sqlImportServerMemories(serverDiscId, memories, target);
    if (result.success) invalidateTomoriStateCache(serverDiscId);
    return result;
  }

  /**
   * Imports the full personal data bundle (settings + memories).
   * @param userDiscId - Discord user snowflake
   * @param importData - PersonalExportData payload
   * @param personaLineageId - Persona lineage namespace to import memories into (default 0)
   */
  async importPersonalData(
    userDiscId: string,
    importData: PersonalExportData,
    personaLineageId = 0,
  ): Promise<ImportResult> {
    const result = await this.sqlImportPersonalData(userDiscId, importData, personaLineageId);
    if (result.success) invalidateUserCache(userDiscId);
    return result;
  }

  /**
   * Imports the full server data bundle (config + memories).
   * @param serverDiscId - Discord server snowflake
   * @param importData - ServerExportData payload
   * @param personaId - Optional specific tomori ID to scope memories
   */
  async importServerData(
    serverDiscId: string,
    importData: ServerExportData,
    personaId?: number,
  ): Promise<ImportResult> {
    const result = await this.sqlImportServerData(serverDiscId, importData, personaId);
    if (result.success) invalidateTomoriStateCache(serverDiscId);
    return result;
  }

  /**
   * Validates a raw JSON import payload and returns the detected type + data.
   * @param jsonData - Raw JSON object from the uploaded import file
   */
  validateImportFile(jsonData: unknown): ImportValidationResult {
    if (typeof jsonData !== "object" || jsonData === null) {
      return { valid: false, error: "commands.data.import.error_not_json" };
    }

    const version = (jsonData as { version?: string }).version;
    if (version !== EXPORT_VERSION) {
      return {
        valid: false,
        error: `commands.data.import.error_incompatible_version|${EXPORT_VERSION}|${version || "unknown"}`,
      };
    }

    const type = (jsonData as { type?: string }).type;

    if (type === "personal_memories") {
      const validated = personalMemoriesExportSchema.safeParse(jsonData);
      if (!validated.success) {
        log.error("Personal memories import validation failed:", validated.error);
        return { valid: false, error: "commands.data.import.error_invalid_personal_memories_format" };
      }
      return { valid: true, type, data: validated.data.data };
    }

    if (type === "global_personal_memories") {
      const validated = globalPersonalMemoriesExportSchema.safeParse(jsonData);
      if (!validated.success) {
        log.error("Global personal memories import validation failed:", validated.error);
        return { valid: false, error: "commands.data.import.error_invalid_personal_memories_format" };
      }
      return { valid: true, type, data: validated.data.data };
    }

    if (type === "server_memories") {
      const validated = serverMemoriesExportSchema.safeParse(jsonData);
      if (!validated.success) {
        log.error("Server memories import validation failed:", validated.error);
        return { valid: false, error: "commands.data.import.error_invalid_server_memories_format" };
      }
      return { valid: true, type, data: validated.data.data };
    }

    if (type === "personal_settings") {
      const validated = personalSettingsExportSchema.safeParse(jsonData);
      if (!validated.success) {
        log.error("Personal settings import validation failed:", validated.error);
        return { valid: false, error: "commands.data.import.error_invalid_personal_settings_format" };
      }
      return { valid: true, type, data: validated.data.data };
    }

    if (type === "server_config") {
      const validated = serverConfigOnlyExportSchema.safeParse(jsonData);
      if (!validated.success) {
        log.error("Server config import validation failed:", validated.error);
        return { valid: false, error: "commands.data.import.error_invalid_server_config_format" };
      }
      return { valid: true, type, data: validated.data.data };
    }

    if (type === "personal") {
      const validated = getPersonalExportSchema().safeParse(jsonData);
      if (!validated.success) {
        log.error("Personal import validation failed:", validated.error);
        return { valid: false, error: "commands.data.import.error_invalid_personal_format" };
      }
      return { valid: true, type: "personal", data: validated.data.data };
    }

    if (type === "server") {
      const validated = getServerExportSchema().safeParse(jsonData);
      if (!validated.success) {
        log.error("Server import validation failed:", validated.error);
        return { valid: false, error: "commands.data.import.error_invalid_server_format" };
      }
      return { valid: true, type: "server", data: validated.data.data };
    }

    return { valid: false, error: `commands.data.import.error_unknown_type|${type}` };
  }

  /**
   * Imports a previously exported personal data bundle (IRepository contract).
   * Intentionally bypasses cache invalidation: this is a pipeline/batch entry
   * point where the caller controls cache lifecycle.
   *
   * @param ownerId - Discord user snowflake
   * @param data    - Previously exported ExportResult from ExportRepository.toExportShape
   */
  async fromExportShape(ownerId: string | number, data: ExportResult): Promise<boolean> {
    if (!data.success || !data.data) return false;
    const envelope = data.data as { type?: string; data?: PersonalExportData };
    if (envelope.type !== "personal" || !envelope.data) return false;
    const result = await this.sqlImportPersonalData(String(ownerId), envelope.data);
    return result.success;
  }
}

/** Singleton instance: import this in callers. */
export const importRepository = new ImportRepository();
