/**
 * ConfigRepository: manages the 13 split server config tables and preset tables.
 *
 * All config reads and writes route through typed split-table methods.
 * The legacy `tomori_configs` god table was dropped by migration 008 (Task F2).
 * Persona identity fields (nickname, lineage) live in PersonaRepository.
 *
 * Export contract: toExportShape / fromExportShape are required by IRepository
 * and consumed by the Phase 6 (#16.7) export pipeline composition.
 */
import type { SQL } from "bun";
import type {
  ErrorContext,
  AssembledServerConfig,
  NaiPresetRow,
  ServerModelConfigRow,
  ServerChatConfigRow,
  ServerMemberPermissionsConfigRow,
  ServerCapabilitiesConfigRow,
  ServerNoticeEmbedsConfigRow,
  ServerNsfwConfigRow,
  ServerSpeechConfigRow,
  ServerAutoTriggerConfigRow,
  ServerChannelScopeConfigRow,
  ServerTriggerBehaviorConfigRow,
  ServerNovelaiImagegenConfigRow,
  ServerByokConfigRow,
  ServerMemoryConfigRow,
  ServerStmConfigRow,
  PersonaAutochRuntimeStateRow,
} from "@/types/db/schema";
import { assembledServerConfigSchema, personaAutochRuntimeStateSchema, naiPresetSchema } from "@/types/db/schema";
import type { TomoriPresetRow, SystemPromptPresetRow } from "@/types/db/schema";
import type { FallbackModelRef } from "@/types/db/schema";
import { invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCacheStore";
import type { SqlParameterArray } from "@/types/db/sqlOperations";
import { sql } from "@/utils/db/client";
import { log } from "@/utils/misc/logger";
import type { IRepository } from "./IRepository";

const TEXT_ARRAY_CONFIG_COLUMNS = new Set([
  "autoch_disc_ids",
  "crosschannel_blocklist_ids",
  "llm_disabled_params",
  "llm_stop_strings",
  "image_default_negative_tags",
  "image_default_positive_tags",
  "private_channel_ids",
  "rp_channel_ids",
  "tool_notice_hidden_keys",
]);

const JSONB_CONFIG_COLUMNS = new Set([
  "fallback_llm_ids",
  "fallback_model_refs",
  "llm_logit_biases",
  "other_model_capabilities",
]);

function toPostgresTextArrayLiteral(values: readonly unknown[]): string {
  return `{${values.map((value) => `"${String(value).replace(/(["\\])/g, "\\$1")}"`).join(",")}}`;
}

/** Row shape for server_capabilities_configs (Phase 6). */
export type ServerCapabilitiesConfigsRow = {
  emoji_usage_enabled: boolean;
  sticker_usage_enabled: boolean;
  web_search_enabled: boolean;
  manage_message_enabled: boolean;
  thread_creation_enabled: boolean;
  imagegen_enabled: boolean;
  videogen_enabled: boolean;
  voice_message_enabled: boolean;
  user_blocking_enabled: boolean;
  time_awareness_enabled: boolean;
  tool_use_enabled: boolean;
  verbatim_tool_calling_enabled: boolean;
};

/** Row shape for server_novelai_imagegen_configs (Phase 6). */
export type ServerNovelaiImagegenConfigsRow = {
  nai_preset_name: string | null;
  image_default_positive_tags: string[];
  image_default_negative_tags: string[];
  nai_sampler: string | null;
  nai_steps: number | null;
  nai_scale: number | null;
  nai_noise_schedule: string | null;
  nai_cfg_rescale: number | null;
  nai_diffusion_model_id: number | null;
};

/** Row shape for server_nsfw_configs (Phase 6). */
export type ServerNsfwConfigsRow = {
  uncensor_injection_enabled: boolean;
  uncensor_unicode_space_enabled: boolean;
  uncensor_sanitize_enabled: boolean;
};

/** Row shape for server_speech_configs (Phase 6). */
export type ServerSpeechConfigsRow = {
  voice_transcript_chat_mode: boolean;
  chatterbox_turbo_enabled: boolean;
  chatterbox_cfg_weight: number;
  chatterbox_exaggeration: number;
};

/** Row shape for server_byok_configs (Phase 6). */
export type ServerByokConfigsRow = {
  user_byok_mode: boolean;
};

/**
 * Composite export shape for ConfigRepository's Phase 6 tables.
 * Replaces the old Partial<AssembledServerConfig> stub.
 */
export type ConfigExportShape = {
  capabilities: ServerCapabilitiesConfigsRow | null;
  novelai_imagegen: ServerNovelaiImagegenConfigsRow | null;
  nsfw: ServerNsfwConfigsRow | null;
  speech: ServerSpeechConfigsRow | null;
  byok: ServerByokConfigsRow | null;
};

export class ConfigRepository implements IRepository<ConfigExportShape> {
  /**
   * Loads NAI sampling presets available for a given NAI model target.
   *
   * @param target - "kayra" or "erato"
   */
  async loadNaiPresets(target: "kayra" | "erato"): Promise<NaiPresetRow[]> {
    try {
      const rows = await sql`
        SELECT * FROM nai_presets
        WHERE model_target = ${target}
        ORDER BY is_default DESC, preset_name ASC
      `;

      const presets: NaiPresetRow[] = [];
      for (const row of rows) {
        const parsed = naiPresetSchema.safeParse(row);
        if (parsed.success) {
          presets.push(parsed.data);
        } else {
          log.warn(`Invalid nai_preset row for target ${target}:`, parsed.error.flatten());
        }
      }
      return presets;
    } catch (error) {
      log.error(`Error loading NAI presets for model target ${target}:`, error);
      return [];
    }
  }

  /**
   * Loads preset option rows with an optional max description length.
   *
   * @param maxDescriptionLength - Truncate descriptions to this length (default 100)
   */
  async loadPresetOptions(maxDescriptionLength?: number): Promise<Array<{ name: string; description: string }> | null> {
    try {
      const descriptionLength = maxDescriptionLength ?? 100;
      const presetRows = await sql`
        SELECT persona_preset_name, persona_preset_desc
        FROM persona_presets
        ORDER BY persona_preset_name ASC
      `;

      if (!presetRows || presetRows.length === 0) {
        log.warn("No personality presets found in the database.");
        return null;
      }

      const presetOptions = presetRows.map((row: Record<string, unknown>) => {
        const description = row.persona_preset_desc as string;
        const truncatedDescription =
          description.length > descriptionLength
            ? `${description.substring(0, descriptionLength - 3)}...`
            : description;

        return {
          name: row.persona_preset_name as string,
          description: truncatedDescription,
        };
      });

      log.info(`Found ${presetOptions.length} personality presets for selection menu.`);
      return presetOptions;
    } catch (error) {
      log.error("Error loading preset options from database:", error);
      return null;
    }
  }

  /**
   * Loads preset option rows filtered by locale, with an optional max description length.
   *
   * @param locale               - Locale code (e.g. "en-US")
   * @param maxDescriptionLength - Truncate descriptions to this length (default 100)
   */
  async loadPresetOptionsByLocale(
    locale: string,
    maxDescriptionLength?: number,
  ): Promise<Array<{ name: string; description: string }> | null> {
    try {
      const descriptionLength = maxDescriptionLength ?? 100;
      let presetRows = await sql`
        SELECT persona_preset_name, persona_preset_desc
        FROM persona_presets
        WHERE preset_language = ${locale}
        ORDER BY persona_preset_name ASC
      `;

      if (presetRows.length === 0) {
        const baseLanguage = locale.split("-")[0];
        presetRows = await sql`
          SELECT persona_preset_name, persona_preset_desc
          FROM persona_presets
          WHERE preset_language = ${baseLanguage}
          ORDER BY persona_preset_name ASC
        `;

        if (presetRows.length > 0) {
          log.info(`No presets found for locale '${locale}', using base language '${baseLanguage}' instead.`);
        }
      }

      if (presetRows.length === 0 && locale !== "en-US") {
        presetRows = await sql`
          SELECT persona_preset_name, persona_preset_desc
          FROM persona_presets
          WHERE preset_language = 'en-US'
          ORDER BY persona_preset_name ASC
        `;

        if (presetRows.length > 0) {
          log.info(`No presets found for locale '${locale}', falling back to English presets.`);
        }
      }

      if (!presetRows || presetRows.length === 0) {
        log.warn(`No personality presets found for locale '${locale}' or any fallback language.`);
        return null;
      }

      const presetOptions = presetRows.map((row: Record<string, unknown>) => {
        const description = row.persona_preset_desc as string;
        const truncatedDescription =
          description.length > descriptionLength
            ? `${description.substring(0, descriptionLength - 3)}...`
            : description;

        return {
          name: row.persona_preset_name as string,
          description: truncatedDescription,
        };
      });

      log.info(`Found ${presetOptions.length} personality presets for locale '${locale}' (selection menu).`);
      return presetOptions;
    } catch (error) {
      log.error(`Error loading preset options for locale '${locale}' from database:`, error);
      return null;
    }
  }

  async loadPresetRowsByLocale(locale: string): Promise<TomoriPresetRow[] | null> {
    try {
      let presets = await sql`
        SELECT * FROM persona_presets
        WHERE preset_language = ${locale}
        ORDER BY persona_preset_name ASC
      `;

      if (presets.length === 0) {
        const baseLanguage = locale.split("-")[0];
        presets = await sql`
          SELECT * FROM persona_presets
          WHERE preset_language = ${baseLanguage}
          ORDER BY persona_preset_name ASC
        `;

        if (presets.length > 0) {
          log.info(`No presets found for locale '${locale}', using base language '${baseLanguage}' instead.`);
        }
      }

      if (presets.length === 0 && locale !== "en-US") {
        presets = await sql`
          SELECT * FROM persona_presets
          WHERE preset_language = 'en-US'
          ORDER BY persona_preset_name ASC
        `;

        if (presets.length > 0) {
          log.info(`No presets found for locale '${locale}', falling back to English presets.`);
        }
      }

      if (!presets || presets.length === 0) {
        log.warn(`No personality presets found for locale '${locale}' or any fallback language.`);
        return null;
      }

      log.info(`Found ${presets.length} personality preset rows for locale '${locale}'.`);
      return presets as TomoriPresetRow[];
    } catch (error) {
      log.error(`Error loading preset rows for locale '${locale}' from database:`, error);
      return null;
    }
  }

  /** Loads all preset rows regardless of locale. */
  async loadAllPresets(): Promise<TomoriPresetRow[] | null> {
    try {
      const presets = await sql`
        SELECT * FROM persona_presets
        ORDER BY persona_preset_name ASC
      `;

      if (!presets || presets.length === 0) {
        log.warn("No personality presets found in database.");
        return null;
      }

      log.info(`Loaded ${presets.length} personality presets from database.`);
      return presets as TomoriPresetRow[];
    } catch (error) {
      log.error("Error loading all presets from database:", error);
      return null;
    }
  }

  async loadSystemPromptPresets(): Promise<SystemPromptPresetRow[] | null> {
    try {
      const presets = await sql`
        SELECT * FROM system_prompt_presets
        ORDER BY system_prompt_preset_id ASC
      `;

      if (!presets || presets.length === 0) {
        log.warn("No system prompt presets found in database.");
        return null;
      }

      log.info(`Loaded ${presets.length} system prompt presets from database.`);
      return presets as SystemPromptPresetRow[];
    } catch (error) {
      log.error("Error loading system prompt presets from database:", error);
      return null;
    }
  }

  /**
   * Loads a single preset row by exact name match.
   * Used by setup to validate and retrieve preset metadata after modal submission.
   *
   * @param presetName - Exact preset name to look up
   * @returns Preset row, or null if not found
   */
  async loadPresetByName(presetName: string): Promise<TomoriPresetRow | null> {
    try {
      const [row] = await sql`
        SELECT *
        FROM persona_presets
        WHERE persona_preset_name = ${presetName}
        LIMIT 1
      `;
      if (!row) return null;
      return row as TomoriPresetRow;
    } catch (error) {
      log.error(`Error loading preset by name "${presetName}":`, error);
      return null;
    }
  }

  /**
   * Loads model-selection and BYOK columns from the split config tables for a server.
   * Used by credentialResolver to resolve provider for each capability without
   * bypassing the TomoriState cache (this is an intentional fresh DB read).
   *
   * @param serverId - Internal server DB ID
   */
  async loadModelCapabilityIds(
    serverId: number,
  ): Promise<Pick<
    AssembledServerConfig,
    | "llm_id"
    | "embedding_model_id"
    | "diffusion_model_id"
    | "nai_diffusion_model_id"
    | "video_model_id"
    | "vision_llm_id"
    | "user_byok_mode"
  > | null> {
    try {
      // Join the three split tables that own capability-selection columns.
      //    server_model_configs anchors (always present post-E0 backfill);
      //    the other two are LEFT JOINs for migration-window safety.
      const [row] = await sql`
        SELECT
          smc.llm_id,
          smc.embedding_model_id,
          smc.diffusion_model_id,
          smc.video_model_id,
          smc.vision_llm_id,
          snai.nai_diffusion_model_id,
          sbc.user_byok_mode
        FROM server_model_configs smc
        LEFT JOIN server_novelai_imagegen_configs snai USING (server_id)
        LEFT JOIN server_byok_configs sbc USING (server_id)
        WHERE smc.server_id = ${serverId}
        LIMIT 1
      `;
      if (!row) return null;

      const parsed = assembledServerConfigSchema
        .pick({
          llm_id: true,
          embedding_model_id: true,
          diffusion_model_id: true,
          nai_diffusion_model_id: true,
          video_model_id: true,
          vision_llm_id: true,
          user_byok_mode: true,
        })
        .safeParse(row);

      if (!parsed.success) {
        log.warn(`Failed to validate capability model IDs for server ${serverId}: ${parsed.error.message}`);
        return null;
      }
      return parsed.data;
    } catch (error) {
      log.error(`Error loading model capability IDs for server ${serverId}:`, error);
      return null;
    }
  }

  /**
   * Applies a NovelAI preset's sampling parameters to a server's config.
   * Writes through typed split-table methods. Because these writes are not
   * transactional, invalidates the tomori state cache when any write succeeds,
   * including a partial failure.
   *
   * @param serverId     - Internal server DB ID
   * @param preset       - NaiPresetRow to apply
   * @param model        - LLM codename for temperature conversion
   * @param serverDiscId - Discord server snowflake used for cache invalidation
   * @returns true on success, false if any write failed
   */
  async applyNaiPreset(serverId: number, preset: NaiPresetRow, model: string, serverDiscId: string): Promise<boolean> {
    const params = preset.parameters;
    const naiTemp = typeof params.temperature === "number" ? params.temperature : 1.35;
    const llm_temperature = this.invertNaiTemperature(naiTemp, model);
    const llm_top_k = typeof params.top_k === "number" ? Math.round(params.top_k) : 0;
    const llm_top_p = typeof params.top_p === "number" ? params.top_p : 1.0;
    const llm_min_p = typeof params.min_p === "number" ? params.min_p : 0.05;

    // Write sampling params across their owning split tables in parallel.
    const [modelOk, chatOk, naiOk] = await Promise.all([
      this.updateModelConfig(serverId, { llm_temperature }),
      this.updateChatConfig(serverId, { llm_top_p, llm_top_k, llm_min_p }),
      this.updateNovelaiImagegenConfig(serverId, { nai_preset_name: preset.preset_name }),
    ]);

    const ok = modelOk && chatOk && naiOk;
    if (modelOk || chatOk || naiOk) invalidateTomoriStateCache(serverDiscId);
    return ok;
  }

  /**
   * Increments the auto-chat counter for a Tomori and rolls a new target if needed.
   * Does NOT invalidate the tomori state cache (counter is a hot-path write).
   *
   * @param personaId     - Internal tomori DB ID
   * @param minThreshold - Minimum auto-chat threshold from config
   * @param maxThreshold - Maximum auto-chat threshold from config
   */
  async incrementTomoriCounter(
    personaId: number,
    minThreshold: number,
    maxThreshold: number,
  ): Promise<PersonaAutochRuntimeStateRow | null> {
    try {
      const normalizedMin = Math.max(minThreshold, 0);
      const normalizedMax = Math.max(maxThreshold, normalizedMin);

      if (normalizedMin <= 0 || normalizedMax <= 0) {
        const [runtimeRow] = await sql`
          INSERT INTO persona_autoch_runtime_state (persona_id, autoch_counter, autoch_next_target)
          VALUES (${personaId}, 0, 0)
          ON CONFLICT (persona_id) DO UPDATE
            SET autoch_counter = 0, autoch_next_target = 0
          RETURNING *
        `;

        const parsed = personaAutochRuntimeStateSchema.safeParse(runtimeRow);
        return parsed.success ? parsed.data : null;
      }

      // Threshold mode; read current state, compute next, write back atomically.
      const updatedRuntime = await sql.transaction(async (tx) => {
        const [currentRuntime] = await tx`
          SELECT *
          FROM persona_autoch_runtime_state
          WHERE persona_id = ${personaId}
          FOR UPDATE
        `;

        // Row may not exist for personas created before migration 015.
        const currentCounter = (currentRuntime?.autoch_counter as number | undefined) ?? 0;
        const currentTarget = (currentRuntime?.autoch_next_target as number | undefined) ?? 0;

        const shouldStartNewCycle = currentTarget > 0 && currentCounter >= currentTarget;
        const nextTarget =
          shouldStartNewCycle || currentTarget <= 0
            ? this.rollAutochatTarget(normalizedMin, normalizedMax)
            : currentTarget;
        const nextCounter = shouldStartNewCycle ? 1 : currentCounter + 1;

        const [updatedRow] = await tx`
          INSERT INTO persona_autoch_runtime_state (persona_id, autoch_counter, autoch_next_target)
          VALUES (${personaId}, ${nextCounter}, ${nextTarget})
          ON CONFLICT (persona_id) DO UPDATE
            SET autoch_counter = ${nextCounter}, autoch_next_target = ${nextTarget}
          RETURNING *
        `;

        return updatedRow ?? null;
      });

      if (!updatedRuntime) {
        const context: ErrorContext = {
          personaId,
          errorType: "DatabaseUpdateError",
          metadata: {
            operation: "incrementTomoriCounter",
            minThreshold: normalizedMin,
            maxThreshold: normalizedMax,
          },
        };

        await log.error(
          `Failed to increment auto-chat counter for Tomori ${personaId}`,
          new Error("Runtime state upsert returned no rows"),
          context,
        );
        return null;
      }

      const parsedRuntime = personaAutochRuntimeStateSchema.safeParse(updatedRuntime);
      if (!parsedRuntime.success) {
        const context: ErrorContext = {
          personaId,
          errorType: "SchemaValidationError",
          metadata: {
            operation: "incrementTomoriCounter",
            validationErrors: parsedRuntime.error.flatten(),
          },
        };

        await log.error("Failed to validate autochat runtime state after counter update", parsedRuntime.error, context);
        return null;
      }

      return parsedRuntime.data;
    } catch (error) {
      const context: ErrorContext = {
        personaId,
        errorType: "DatabaseOperationError",
        metadata: {
          operation: "incrementTomoriCounter",
          minThreshold,
          maxThreshold,
        },
      };

      await log.error(`Error incrementing auto counter for Tomori ${personaId}`, error, context);
      return null;
    }
  }

  /**
   * Atomically updates the shared auto-chat threshold range and resets the
   * persona's runtime cycle counter in a single transaction.
   *
   * @param serverId     - Internal server DB ID
   * @param personaId    - Internal persona DB ID whose cycle is being reset
   * @param threshold    - Minimum (or fixed) auto-chat threshold; 0 = always-reply
   * @param maxThreshold - Maximum auto-chat threshold (>= threshold)
   * @param nextTarget   - Next cycle target to seed the runtime row with
   * @returns Updated runtime state row, or null on failure (config row missing, etc.)
   */
  async setAutoChatThreshold(
    serverId: number,
    personaId: number,
    threshold: number,
    maxThreshold: number,
    nextTarget: number,
  ): Promise<PersonaAutochRuntimeStateRow | null> {
    try {
      const result = await sql.transaction(async (tx) => {
        const [configRow] = await tx`
          UPDATE server_auto_trigger_configs
          SET autoch_threshold = ${threshold},
              autoch_threshold_max = ${maxThreshold}
          WHERE server_id = ${serverId}
          RETURNING server_id
        `;

        if (!configRow) {
          throw new Error(`server_auto_trigger_configs row not found for server_id ${serverId}`);
        }

        const [runtimeRow] = await tx`
          INSERT INTO persona_autoch_runtime_state (persona_id, autoch_counter, autoch_next_target)
          VALUES (${personaId}, 0, ${nextTarget})
          ON CONFLICT (persona_id) DO UPDATE
            SET autoch_counter = 0,
                autoch_next_target = EXCLUDED.autoch_next_target
          RETURNING *
        `;

        return runtimeRow ?? null;
      });

      if (!result) {
        const context: ErrorContext = {
          serverId,
          personaId: personaId,
          errorType: "DatabaseUpdateError",
          metadata: {
            operation: "setAutoChatThreshold",
            threshold,
            maxThreshold,
            nextTarget,
          },
        };
        await log.error(
          `Auto-chat threshold update returned no runtime row for server ${serverId}`,
          new Error("Runtime state upsert returned no rows"),
          context,
        );
        return null;
      }

      const parsed = personaAutochRuntimeStateSchema.safeParse(result);
      if (!parsed.success) {
        const context: ErrorContext = {
          serverId,
          personaId: personaId,
          errorType: "SchemaValidationError",
          metadata: {
            operation: "setAutoChatThreshold",
            validationErrors: parsed.error.flatten(),
          },
        };
        await log.error("Failed to validate runtime state after threshold reset", parsed.error, context);
        return null;
      }

      return parsed.data;
    } catch (error) {
      const context: ErrorContext = {
        serverId,
        personaId: personaId,
        errorType: "DatabaseOperationError",
        metadata: {
          operation: "setAutoChatThreshold",
          threshold,
          maxThreshold,
          nextTarget,
        },
      };
      await log.error(`Error setting auto-chat threshold for server ${serverId}`, error, context);
      return null;
    }
  }

  /**
   * Replaces the fallback LLM list for a server (legacy integer-ID form).
   * Invalidates the tomori state cache after write.
   *
   * @param serverId     - Internal server DB ID
   * @param llmIds       - Ordered list of fallback LLM IDs
   * @param serverDiscId - Discord server snowflake (required for cache invalidation)
   */
  async setFallbackLlms(serverId: number, llmIds: number[], serverDiscId: string): Promise<boolean> {
    const ok = await this.setFallbackLlmRows(serverId, llmIds);
    if (ok) invalidateTomoriStateCache(serverDiscId);
    return ok;
  }

  /**
   * Replaces the fallback model reference list for a server (provider+codename form).
   * Invalidates the tomori state cache after write.
   *
   * @param serverId     - Internal server DB ID
   * @param refs         - Ordered list of FallbackModelRef objects
   * @param serverDiscId - Discord server snowflake (required for cache invalidation)
   */
  async setFallbackModelRefs(serverId: number, refs: FallbackModelRef[], serverDiscId: string): Promise<boolean> {
    const ok = await this.setFallbackModelRefRows(serverId, refs);
    if (ok) invalidateTomoriStateCache(serverDiscId);
    return ok;
  }

  async updateModelConfig(serverId: number, patch: Partial<ServerModelConfigRow>): Promise<boolean> {
    return this.executeUpdate("server_model_configs", serverId, patch);
  }

  async updateChatConfig(serverId: number, patch: Partial<ServerChatConfigRow>): Promise<boolean> {
    return this.executeUpdate("server_chat_configs", serverId, patch);
  }

  async updateCapabilitiesConfig(serverId: number, patch: Partial<ServerCapabilitiesConfigRow>): Promise<boolean> {
    return this.executeUpdate("server_capabilities_configs", serverId, patch);
  }

  async updateMemberPermissionsConfig(
    serverId: number,
    patch: Partial<ServerMemberPermissionsConfigRow>,
  ): Promise<boolean> {
    return this.executeUpdate("server_member_permissions_configs", serverId, patch);
  }

  async updateCapabilitiesAndMemberPermissionsConfig(
    serverId: number,
    patch: {
      capabilities?: Partial<ServerCapabilitiesConfigRow>;
      memberPermissions?: Partial<ServerMemberPermissionsConfigRow>;
    },
  ): Promise<boolean> {
    const capabilitiesPatch = patch.capabilities ?? {};
    const memberPermissionsPatch = patch.memberPermissions ?? {};
    const hasCapabilitiesPatch = Object.values(capabilitiesPatch).some((value) => value !== undefined);
    const hasMemberPermissionsPatch = Object.values(memberPermissionsPatch).some((value) => value !== undefined);

    if (!hasCapabilitiesPatch && !hasMemberPermissionsPatch) return false;

    try {
      await sql.begin(async (tx: SQL) => {
        if (hasMemberPermissionsPatch) {
          const updated = await this.executeUpdate(
            "server_member_permissions_configs",
            serverId,
            memberPermissionsPatch,
            tx,
          );
          if (!updated) {
            throw new Error(`server_member_permissions_configs row not found for server_id ${serverId}`);
          }
        }

        if (hasCapabilitiesPatch) {
          const updated = await this.executeUpdate("server_capabilities_configs", serverId, capabilitiesPatch, tx);
          if (!updated) {
            throw new Error(`server_capabilities_configs row not found for server_id ${serverId}`);
          }
        }
      });

      return true;
    } catch (error) {
      log.error(`Error updating capabilities/member permissions configs for server_id: ${serverId}:`, error);
      return false;
    }
  }

  async updateNoticeEmbedsConfig(serverId: number, patch: Partial<ServerNoticeEmbedsConfigRow>): Promise<boolean> {
    return this.executeUpdate("server_notice_embeds_configs", serverId, patch);
  }

  async updateNsfwConfig(serverId: number, patch: Partial<ServerNsfwConfigRow>): Promise<boolean> {
    return this.executeUpdate("server_nsfw_configs", serverId, patch);
  }

  async updateSpeechConfig(serverId: number, patch: Partial<ServerSpeechConfigRow>): Promise<boolean> {
    return this.executeUpdate("server_speech_configs", serverId, patch);
  }

  /**
   * Atomically updates `server_auto_trigger_configs` columns and replaces junction rows in
   * `server_auto_trigger_persona_overrides`. Both writes are wrapped in a single transaction
   * so a failure never leaves the config row and junction in an inconsistent state.
   *
   * @param serverId - Internal server DB ID
   * @param patch    - Partial auto-trigger config; `autoch_persona_overrides` is routed to the
   *                   junction table while all other keys update the config row directly.
   */
  async updateAutoTriggerConfig(serverId: number, patch: Partial<ServerAutoTriggerConfigRow>): Promise<boolean> {
    const { autoch_persona_overrides: overrides, ...tableColumns } = patch;
    const columnEntries = Object.entries(tableColumns).filter(([, v]) => v !== undefined);
    const hasColumns = columnEntries.length > 0;
    const hasOverrides = overrides !== undefined;

    if (!hasColumns && !hasOverrides) return false;

    try {
      await sql.begin(async (tx) => {
        const existingConfigRows = await tx`
          SELECT server_id
          FROM server_auto_trigger_configs
          WHERE server_id = ${serverId}
          FOR UPDATE
        `;
        if (existingConfigRows.length === 0) {
          throw new Error(`server_auto_trigger_configs row not found for server_id ${serverId}`);
        }

        if (hasColumns) {
          const setParts: string[] = [];
          const values: SqlParameterArray = [];
          columnEntries.forEach(([key, value]) => {
            this.pushUpdateValue(key, value, setParts, values);
          });
          values.push(serverId);
          await tx.unsafe(
            `UPDATE server_auto_trigger_configs SET ${setParts.join(", ")} WHERE server_id = $${values.length}`,
            values as never[],
          );
        }

        // Replace junction rows atomically (DELETE + INSERT to handle removals).
        if (hasOverrides) {
          await tx`DELETE FROM server_auto_trigger_persona_overrides WHERE server_id = ${serverId}`;
          for (const override of overrides) {
            await tx`
              INSERT INTO server_auto_trigger_persona_overrides (server_id, channel_disc_id, persona_id)
              VALUES (${serverId}, ${override.channel_disc_id}, ${override.persona_id})
            `;
          }
        }
      });
      return true;
    } catch (error) {
      log.error(`Error updating auto_trigger config for server_id: ${serverId}:`, error);
      return false;
    }
  }

  async updateChannelScopeConfig(serverId: number, patch: Partial<ServerChannelScopeConfigRow>): Promise<boolean> {
    return this.executeUpdate("server_channel_scope_configs", serverId, patch);
  }

  async updateTriggerBehaviorConfig(
    serverId: number,
    patch: Partial<ServerTriggerBehaviorConfigRow>,
  ): Promise<boolean> {
    return this.executeUpdate("server_trigger_behavior_configs", serverId, patch);
  }

  async updateNovelaiImagegenConfig(
    serverId: number,
    patch: Partial<ServerNovelaiImagegenConfigRow>,
  ): Promise<boolean> {
    return this.executeUpdate("server_novelai_imagegen_configs", serverId, patch);
  }

  async updateByokConfig(serverId: number, patch: Partial<ServerByokConfigRow>): Promise<boolean> {
    return this.executeUpdate("server_byok_configs", serverId, patch);
  }

  async updateMemoryConfig(serverId: number, patch: Partial<ServerMemoryConfigRow>): Promise<boolean> {
    return this.executeUpdate("server_memory_configs", serverId, patch);
  }

  async updateStmConfig(serverId: number, patch: Partial<ServerStmConfigRow>): Promise<boolean> {
    return this.executeUpdate("server_stm_configs", serverId, patch);
  }

  async updateWelcomeConfig(
    serverId: number,
    patch: Partial<{
      welcome_channel_disc_id: string | null;
      welcome_prompt: string | null;
      welcome_persona_id: number | null;
    }>,
  ): Promise<boolean> {
    return this.executeUpdate("server_welcome_configs", serverId, patch);
  }

  /**
   * Delete every config-table row owned by this server across the 13 split tables.
   * Used by `/setup` to recover from the orphaned-alters state.
   * Wiping all configs frees the constraint without touching `personas` rows, so
   * alters survive the reset.
   *
   * @param serverId - Internal server DB ID
   */
  async resetAllServerConfigs(serverId: number): Promise<void> {
    await Promise.all([
      sql`DELETE FROM server_model_configs WHERE server_id = ${serverId}`,
      sql`DELETE FROM server_chat_configs WHERE server_id = ${serverId}`,
      sql`DELETE FROM server_member_permissions_configs WHERE server_id = ${serverId}`,
      sql`DELETE FROM server_capabilities_configs WHERE server_id = ${serverId}`,
      sql`DELETE FROM server_notice_embeds_configs WHERE server_id = ${serverId}`,
      sql`DELETE FROM server_nsfw_configs WHERE server_id = ${serverId}`,
      sql`DELETE FROM server_speech_configs WHERE server_id = ${serverId}`,
      sql`DELETE FROM server_auto_trigger_configs WHERE server_id = ${serverId}`,
      sql`DELETE FROM server_channel_scope_configs WHERE server_id = ${serverId}`,
      sql`DELETE FROM server_trigger_behavior_configs WHERE server_id = ${serverId}`,
      sql`DELETE FROM server_byok_configs WHERE server_id = ${serverId}`,
      sql`DELETE FROM server_novelai_imagegen_configs WHERE server_id = ${serverId}`,
      sql`DELETE FROM server_memory_configs WHERE server_id = ${serverId}`,
    ]);
  }

  async getChatConfig(serverId: number): Promise<ServerChatConfigRow | null> {
    try {
      const [row] = await sql`SELECT * FROM server_chat_configs WHERE server_id = ${serverId}`;
      return (row as unknown as ServerChatConfigRow) ?? null;
    } catch (error) {
      log.error(`Error loading server_chat_configs for server ${serverId}:`, error);
      return null;
    }
  }

  async getModelConfig(serverId: number): Promise<ServerModelConfigRow | null> {
    try {
      const [row] = await sql`SELECT * FROM server_model_configs WHERE server_id = ${serverId}`;
      return (row as unknown as ServerModelConfigRow) ?? null;
    } catch (error) {
      log.error(`Error loading server_model_configs for server ${serverId}:`, error);
      return null;
    }
  }

  async getSpeechConfig(serverId: number): Promise<ServerSpeechConfigRow | null> {
    try {
      const [row] = await sql`SELECT * FROM server_speech_configs WHERE server_id = ${serverId}`;
      return (row as unknown as ServerSpeechConfigRow) ?? null;
    } catch (error) {
      log.error(`Error loading server_speech_configs for server ${serverId}:`, error);
      return null;
    }
  }

  private async executeUpdate(
    tableName: string,
    serverId: number,
    patch: Record<string, unknown>,
    sqlClient: SQL = sql,
  ): Promise<boolean> {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return false;

    try {
      const setParts: string[] = [];
      const values: SqlParameterArray = [];

      entries.forEach(([key, value]) => {
        this.pushUpdateValue(key, value, setParts, values);
      });

      const setClause = setParts.join(", ");
      values.push(serverId);
      const serverIdIndex = values.length;

      // sql.unsafe is intentional: tableName is dynamic (13 split-config tables) and cannot
      // be expressed as a typed sql`` identifier; sql(patch) for SET also requires a static
      // template tag so mixing both with a dynamic table name forces sql.unsafe here.
      const result = await sqlClient.unsafe(
        `UPDATE ${tableName} SET ${setClause} WHERE server_id = $${serverIdIndex} RETURNING server_id`,
        values,
      );
      return result.length > 0;
    } catch (error) {
      log.error(`Error updating ${tableName} for server_id: ${serverId}:`, error);
      return false;
    }
  }

  private pushUpdateValue(key: string, value: unknown, setParts: string[], values: SqlParameterArray): void {
    const placeholder = `$${values.length + 1}`;

    if (TEXT_ARRAY_CONFIG_COLUMNS.has(key)) {
      if (!Array.isArray(value)) {
        throw new Error(`Expected string array for ${key}`);
      }
      setParts.push(`${key} = ${placeholder}::TEXT[]`);
      values.push(toPostgresTextArrayLiteral(value));
      return;
    }

    if (JSONB_CONFIG_COLUMNS.has(key)) {
      setParts.push(`${key} = ${placeholder}::JSONB`);
      values.push(value === null ? null : JSON.stringify(value));
      return;
    }

    if (Array.isArray(value)) {
      throw new Error(`Array-valued config column ${key} needs explicit SQL type handling`);
    }

    setParts.push(`${key} = ${placeholder}`);
    values.push(value as never);
  }

  /**
   * Reads capabilities, NAI imagegen, NSFW, speech, and BYOK configs for the given server.
   * Returns null if the server has no config row (i.e., not yet set up).
   *
   * @param ownerId - Discord server snowflake
   */
  async toExportShape(ownerId: string | number): Promise<ConfigExportShape | null> {
    const serverDiscId = String(ownerId);
    const serverId = await this.resolveServerId(serverDiscId);
    if (!serverId) return null;

    const [caps, nai, nsfw, speech, byok] = await Promise.all([
      this.sqlLoadCapabilitiesConfigs(serverId),
      this.sqlLoadNovelaiImagegenConfigs(serverId),
      this.sqlLoadNsfwConfigs(serverId),
      this.sqlLoadSpeechConfigs(serverId),
      this.sqlLoadByokConfigs(serverId),
    ]);

    if (!caps && !nai && !nsfw && !speech && !byok) return null;

    return { capabilities: caps, novelai_imagegen: nai, nsfw, speech, byok };
  }

  /**
   * Restores ConfigRepository-owned table rows for a server.
   * @param ownerId - Discord server snowflake
   * @param data    - Previously exported ConfigExportShape
   */
  async fromExportShape(ownerId: string | number, data: ConfigExportShape): Promise<boolean> {
    const serverDiscId = String(ownerId);
    const serverId = await this.resolveServerId(serverDiscId);
    if (!serverId) {
      log.error(`ConfigRepository.fromExportShape: server ${serverDiscId} not found`);
      return false;
    }

    try {
      const ops: Promise<void>[] = [];

      if (data.capabilities) ops.push(this.sqlUpsertCapabilitiesConfigs(serverId, data.capabilities));
      if (data.novelai_imagegen) ops.push(this.sqlUpsertNovelaiImagegenConfigs(serverId, data.novelai_imagegen));
      if (data.nsfw) ops.push(this.sqlUpsertNsfwConfigs(serverId, data.nsfw));
      if (data.speech) ops.push(this.sqlUpsertSpeechConfigs(serverId, data.speech));
      if (data.byok) ops.push(this.sqlUpsertByokConfigs(serverId, data.byok));

      await Promise.all(ops);
      invalidateTomoriStateCache(serverDiscId);
      return true;
    } catch (error) {
      log.error(`ConfigRepository.fromExportShape: write failed for ${serverDiscId}:`, error);
      return false;
    }
  }

  private async resolveServerId(serverDiscId: string): Promise<number | null> {
    const [row] = await sql`
      SELECT server_id FROM servers WHERE server_disc_id = ${serverDiscId} LIMIT 1
    `;
    return (row?.server_id as number | undefined) ?? null;
  }

  private async sqlLoadCapabilitiesConfigs(serverId: number): Promise<ServerCapabilitiesConfigsRow | null> {
    try {
      const [row] = await sql`
        SELECT emoji_usage_enabled, sticker_usage_enabled, web_search_enabled,
               manage_message_enabled, thread_creation_enabled, imagegen_enabled,
               videogen_enabled, voice_message_enabled, user_blocking_enabled, time_awareness_enabled,
               tool_use_enabled,
               verbatim_tool_calling_enabled
        FROM server_capabilities_configs
        WHERE server_id = ${serverId}
      `;
      return row ? (row as unknown as ServerCapabilitiesConfigsRow) : null;
    } catch (error) {
      log.error(`Error loading server_capabilities_configs for server ${serverId}:`, error);
      return null;
    }
  }

  private async sqlLoadNovelaiImagegenConfigs(serverId: number): Promise<ServerNovelaiImagegenConfigsRow | null> {
    try {
      const [row] = await sql`
        SELECT nai_preset_name, image_default_positive_tags, image_default_negative_tags, nai_sampler,
               nai_steps, nai_scale, nai_noise_schedule, nai_cfg_rescale, nai_diffusion_model_id
        FROM server_novelai_imagegen_configs
        WHERE server_id = ${serverId}
      `;
      return row ? (row as unknown as ServerNovelaiImagegenConfigsRow) : null;
    } catch (error) {
      log.error(`Error loading server_novelai_imagegen_configs for server ${serverId}:`, error);
      return null;
    }
  }

  private async sqlLoadNsfwConfigs(serverId: number): Promise<ServerNsfwConfigsRow | null> {
    try {
      const [row] = await sql`
        SELECT uncensor_injection_enabled, uncensor_unicode_space_enabled, uncensor_sanitize_enabled
        FROM server_nsfw_configs
        WHERE server_id = ${serverId}
      `;
      return row ? (row as unknown as ServerNsfwConfigsRow) : null;
    } catch (error) {
      log.error(`Error loading server_nsfw_configs for server ${serverId}:`, error);
      return null;
    }
  }

  private async sqlLoadSpeechConfigs(serverId: number): Promise<ServerSpeechConfigsRow | null> {
    try {
      const [row] = await sql`
        SELECT voice_transcript_chat_mode, chatterbox_turbo_enabled,
               chatterbox_cfg_weight, chatterbox_exaggeration
        FROM server_speech_configs
        WHERE server_id = ${serverId}
      `;
      return row ? (row as unknown as ServerSpeechConfigsRow) : null;
    } catch (error) {
      log.error(`Error loading server_speech_configs for server ${serverId}:`, error);
      return null;
    }
  }

  private async sqlLoadByokConfigs(serverId: number): Promise<ServerByokConfigsRow | null> {
    try {
      const [row] = await sql`
        SELECT user_byok_mode
        FROM server_byok_configs
        WHERE server_id = ${serverId}
      `;
      return row ? (row as unknown as ServerByokConfigsRow) : null;
    } catch (error) {
      log.error(`Error loading server_byok_configs for server ${serverId}:`, error);
      return null;
    }
  }

  private async sqlUpsertCapabilitiesConfigs(serverId: number, row: ServerCapabilitiesConfigsRow): Promise<void> {
    await sql`
      INSERT INTO server_capabilities_configs (
        server_id, emoji_usage_enabled, sticker_usage_enabled, web_search_enabled,
        manage_message_enabled, thread_creation_enabled, imagegen_enabled,
        videogen_enabled, voice_message_enabled, user_blocking_enabled, time_awareness_enabled,
        tool_use_enabled,
        verbatim_tool_calling_enabled
      ) VALUES (
        ${serverId}, ${row.emoji_usage_enabled}, ${row.sticker_usage_enabled},
        ${row.web_search_enabled}, ${row.manage_message_enabled}, ${row.thread_creation_enabled},
        ${row.imagegen_enabled}, ${row.videogen_enabled}, ${row.voice_message_enabled},
        ${row.user_blocking_enabled}, ${row.time_awareness_enabled}, ${row.tool_use_enabled},
        ${row.verbatim_tool_calling_enabled ?? false}
      )
      ON CONFLICT (server_id) DO UPDATE SET
        emoji_usage_enabled    = EXCLUDED.emoji_usage_enabled,
        sticker_usage_enabled  = EXCLUDED.sticker_usage_enabled,
        web_search_enabled     = EXCLUDED.web_search_enabled,
        manage_message_enabled = EXCLUDED.manage_message_enabled,
        thread_creation_enabled = EXCLUDED.thread_creation_enabled,
        imagegen_enabled       = EXCLUDED.imagegen_enabled,
        videogen_enabled       = EXCLUDED.videogen_enabled,
        voice_message_enabled  = EXCLUDED.voice_message_enabled,
        user_blocking_enabled  = EXCLUDED.user_blocking_enabled,
        time_awareness_enabled = EXCLUDED.time_awareness_enabled,
        tool_use_enabled       = EXCLUDED.tool_use_enabled,
        verbatim_tool_calling_enabled = EXCLUDED.verbatim_tool_calling_enabled,
        updated_at             = NOW()
    `;
  }

  private async sqlUpsertNovelaiImagegenConfigs(serverId: number, row: ServerNovelaiImagegenConfigsRow): Promise<void> {
    await sql`
      INSERT INTO server_novelai_imagegen_configs (
        server_id, nai_preset_name, image_default_positive_tags, image_default_negative_tags,
        nai_sampler, nai_steps, nai_scale, nai_noise_schedule, nai_cfg_rescale,
        nai_diffusion_model_id
      ) VALUES (
        ${serverId}, ${row.nai_preset_name}, ${sql.array(row.image_default_positive_tags, "TEXT")},
        ${sql.array(row.image_default_negative_tags, "TEXT")}, ${row.nai_sampler}, ${row.nai_steps},
        ${row.nai_scale}, ${row.nai_noise_schedule}, ${row.nai_cfg_rescale},
        ${row.nai_diffusion_model_id}
      )
      ON CONFLICT (server_id) DO UPDATE SET
        nai_preset_name        = EXCLUDED.nai_preset_name,
        image_default_positive_tags         = EXCLUDED.image_default_positive_tags,
        image_default_negative_tags      = EXCLUDED.image_default_negative_tags,
        nai_sampler            = EXCLUDED.nai_sampler,
        nai_steps              = EXCLUDED.nai_steps,
        nai_scale              = EXCLUDED.nai_scale,
        nai_noise_schedule     = EXCLUDED.nai_noise_schedule,
        nai_cfg_rescale        = EXCLUDED.nai_cfg_rescale,
        nai_diffusion_model_id = EXCLUDED.nai_diffusion_model_id,
        updated_at             = NOW()
    `;
  }

  private async sqlUpsertNsfwConfigs(serverId: number, row: ServerNsfwConfigsRow): Promise<void> {
    await sql`
      INSERT INTO server_nsfw_configs (
        server_id, uncensor_injection_enabled, uncensor_unicode_space_enabled, uncensor_sanitize_enabled
      ) VALUES (
        ${serverId}, ${row.uncensor_injection_enabled}, ${row.uncensor_unicode_space_enabled},
        ${row.uncensor_sanitize_enabled}
      )
      ON CONFLICT (server_id) DO UPDATE SET
        uncensor_injection_enabled     = EXCLUDED.uncensor_injection_enabled,
        uncensor_unicode_space_enabled = EXCLUDED.uncensor_unicode_space_enabled,
        uncensor_sanitize_enabled      = EXCLUDED.uncensor_sanitize_enabled,
        updated_at                     = NOW()
    `;
  }

  private async sqlUpsertSpeechConfigs(serverId: number, row: ServerSpeechConfigsRow): Promise<void> {
    await sql`
      INSERT INTO server_speech_configs (
        server_id, voice_transcript_chat_mode, chatterbox_turbo_enabled,
        chatterbox_cfg_weight, chatterbox_exaggeration
      ) VALUES (
        ${serverId}, ${row.voice_transcript_chat_mode}, ${row.chatterbox_turbo_enabled},
        ${row.chatterbox_cfg_weight}, ${row.chatterbox_exaggeration}
      )
      ON CONFLICT (server_id) DO UPDATE SET
        voice_transcript_chat_mode = EXCLUDED.voice_transcript_chat_mode,
        chatterbox_turbo_enabled   = EXCLUDED.chatterbox_turbo_enabled,
        chatterbox_cfg_weight      = EXCLUDED.chatterbox_cfg_weight,
        chatterbox_exaggeration    = EXCLUDED.chatterbox_exaggeration,
        updated_at                 = NOW()
    `;
  }

  private async sqlUpsertByokConfigs(serverId: number, row: ServerByokConfigsRow): Promise<void> {
    await sql`
      INSERT INTO server_byok_configs (server_id, user_byok_mode)
      VALUES (${serverId}, ${row.user_byok_mode})
      ON CONFLICT (server_id) DO UPDATE SET
        user_byok_mode = EXCLUDED.user_byok_mode,
        updated_at     = NOW()
    `;
  }

  private invertNaiTemperature(naiTemp: number, _model: string): number {
    return Math.min(2.0, Math.max(0.0, naiTemp));
  }

  private rollAutochatTarget(minThreshold: number, maxThreshold: number): number {
    const normalizedMin = Math.max(minThreshold, 0);
    const normalizedMax = Math.max(maxThreshold, normalizedMin);

    if (normalizedMin <= 0 || normalizedMax <= 0) {
      return 0;
    }

    if (normalizedMin === normalizedMax) {
      return normalizedMin;
    }

    return Math.floor(Math.random() * (normalizedMax - normalizedMin + 1)) + normalizedMin;
  }

  private async setFallbackLlmRows(serverId: number, llmIds: number[]): Promise<boolean> {
    try {
      const ok = await this.updateModelConfig(serverId, { fallback_llm_ids: llmIds });
      if (!ok) {
        log.warn(
          `[FallbackConfig] setFallbackLlms matched 0 rows for server_id ${serverId} (requested ids: [${llmIds.join(", ")}])`,
        );
        return false;
      }
      if (this.fallbackDebugEnabled()) {
        log.info(`[FallbackDebug][setFallbackLlms] server_id=${serverId} requested_ids=[${llmIds.join(", ")}]`);
      }
      return true;
    } catch (error) {
      log.error(`Error setting fallback LLMs for server ${serverId} (ids: [${llmIds.join(", ")}]):`, error);
      return false;
    }
  }

  private async setFallbackModelRefRows(serverId: number, refs: FallbackModelRef[]): Promise<boolean> {
    try {
      const legacyIds = refs.filter((ref) => ref.type === "llm").map((ref) => ref.id);
      // Write refs to server_chat_configs and sync legacy integer-ID list in server_model_configs in parallel.
      const [refsOk, idsOk] = await Promise.all([
        this.updateChatConfig(serverId, { fallback_model_refs: refs }),
        this.updateModelConfig(serverId, { fallback_llm_ids: legacyIds }),
      ]);
      if (!refsOk || !idsOk) {
        log.warn(`[FallbackConfig] setFallbackModelRefs matched 0 rows for server_id ${serverId}`);
        return false;
      }
      return true;
    } catch (error) {
      log.error(`Error setting fallback model refs for server ${serverId}:`, error);
      return false;
    }
  }

  private fallbackDebugEnabled(): boolean {
    return new Set(["1", "true", "yes", "on"]).has((process.env.FALLBACK_DEBUG_ENABLED ?? "").trim().toLowerCase());
  }
}

/** Singleton instance: import this in callers. */
export const configRepository = new ConfigRepository();
