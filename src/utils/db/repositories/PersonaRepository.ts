/**
 * PersonaRepository: manages the `personas` and persona resolution tables.
 *
 * Owns TomoriState loading (composite persona + config + memories read) and
 * all writes to the `personas` table. Configuration writes live in
 * ConfigRepository; the split mirrors the planned #14 DB partition.
 *
 * Export contract: toExportShape / fromExportShape are required by IRepository
 * and consumed by the Phase 6 (#16.7) export pipeline composition.
 */
import type { SQL } from "bun";
import {
  apiKeyRotationSchema,
  naiPresetSchema,
  personaConfigSchema,
  assembledServerConfigSchema,
  tomoriStateSchema,
  tomoriSchema,
  type ApiKeyRotationRow,
  type ErrorContext,
  type FallbackEntry,
  type FallbackModelRef,
  type LlmRow,
  type NaiPresetRow,
  type PersonaAttributeRow,
  type PersonaConfigRow,
  type AssembledServerConfig,
  type TomoriRow,
  type TomoriPresetRow,
  type TomoriState,
} from "@/types/db/schema";
import type { PersonaAutochRuntimeStateRow } from "@/types/db/schema";
import { EMPTY_PERSONA_NAMING_CONFIG, type PersonaNamingConfig } from "@/types/personaNaming";
import type { SqlParameterArray } from "@/types/db/sqlOperations";
import { DatabaseUnavailableError } from "@/types/errors";
import { getCachedLLM } from "@/utils/cache/llmCache";
import { invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCacheStore";
import { sql, withTransientDbRetry } from "@/utils/db/client";
import { validateTomoriFields } from "@/utils/db/sqlSecurity";
import { llmModelRepo } from "@/utils/db/repositories/LlmModelRepository";
import { llmProviderRepo } from "@/utils/db/repositories/LlmProviderRepository";
import { userNamingRepository } from "@/utils/db/repositories/UserNamingRepository";
import { type MemoryValidationResult, getMemoryLimits } from "@/utils/misc/memoryLimits";
import { getUnconfiguredLlm } from "@/utils/provider/unconfiguredLlm";
import { log } from "@/utils/misc/logger";
import { getBaseTriggerWords } from "@/utils/text/localizer";
import { dedupeTriggerWords, normalizeTriggerWord, selectUnclaimedTriggerWords } from "@/utils/text/triggerWords";
import type { IRepository } from "./IRepository";

/** Row shape for persona_context_note_configs (Phase 6). */
type PersonaContextNoteConfigsRow = {
  persona_id: number;
  context_note: string | null;
  context_note_depth: number;
};

/** Row shape for persona_voice_configs (Phase 6). */
type PersonaVoiceConfigsRow = {
  persona_id: number;
  speech_voice_sample_id: number | null;
  speech_voice_id: string | null;
  speech_voice_name: string | null;
  speech_voice_design_prompt: string | null;
};

/** Row shape for persona_imagegen_configs (Phase 6). */
type PersonaImagegenConfigsRow = {
  persona_id: number;
  physical_appearance_tags: string[];
  nai_char_ref_url: string | null;
};

/** Row shape for persona_textgen_configs (Phase 6). */
type PersonaTextgenConfigsRow = {
  persona_id: number;
  nai_attg_author: string | null;
  nai_attg_title: string | null;
  nai_attg_tags: string | null;
  nai_attg_genre: string | null;
  nai_attg_stars: number | null;
};

type PersonaScopedConfigFields = Omit<PersonaContextNoteConfigsRow, "persona_id"> &
  Omit<PersonaVoiceConfigsRow, "persona_id"> &
  Omit<PersonaImagegenConfigsRow, "persona_id"> &
  Omit<PersonaTextgenConfigsRow, "persona_id">;

/** Per-persona config bundle (Stage A). */
type PersonaConfigBundle = {
  persona_id: number;
  persona_nickname: string;
  persona_lineage_id: number | null;
  context_note_configs: PersonaContextNoteConfigsRow | null;
  voice_configs: PersonaVoiceConfigsRow | null;
  imagegen_configs: PersonaImagegenConfigsRow | null;
  textgen_configs: PersonaTextgenConfigsRow | null;
};

/**
 * Export shape for PersonaRepository.
 * Contains all personas and their Phase 6 config bundles for a server.
 */
type PersonaExportShape = {
  personas: PersonaConfigBundle[];
};

function normalizeAttributePublicFlags(attributes: string[], flags?: boolean[]): boolean[] {
  return attributes.map((_attribute, index) => flags?.[index] ?? false);
}

function normalizeLineageId(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function presetPointerKey(lineageId: number, language: string): string {
  return `${lineageId}:${language}`;
}

function resolvePresetTriggerWords(preset: TomoriPresetRow): string[] {
  const presetTriggerWords = dedupeTriggerWords(preset.preset_trigger_words ?? [], { lowercase: false });
  if (presetTriggerWords.length > 0) {
    return presetTriggerWords;
  }
  return dedupeTriggerWords(getBaseTriggerWords(preset.preset_language), { lowercase: false });
}

function resolvePresetPersonaPrompt(preset: TomoriPresetRow): string | null {
  const trimmed = preset.persona_preset_desc.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const TOMORI_POINTER_CONTENT_FIELDS = new Set<string>([
  "persona_nickname",
  "attribute_list",
  "sample_dialogues_in",
  "sample_dialogues_out",
]);

/** Fields where SQL NULL carries semantic meaning ("not configured") and must not be coerced to undefined. */
const MEANINGFULLY_NULLABLE_CONFIG_FIELDS = new Set([
  "llm_id",
  "embedding_model_id",
  "diffusion_model_id",
  "video_model_id",
  "vision_llm_id",
  "api_key",
  "system_prompt",
  "context_note",
  "llm_max_output_tokens",
  "custom_endpoint_url",
  "custom_model_name",
  "custom_num_ctx",
  "nai_preset_name",
  "nai_sampler",
  "nai_steps",
  "nai_scale",
  "nai_noise_schedule",
  "nai_cfg_rescale",
  "nai_diffusion_model_id",
  "other_model_codename",
  "other_model_capabilities",
  "other_model_capabilities_fetched_at",
  "welcome_channel_disc_id",
  "welcome_prompt",
  "welcome_persona_id",
  "thought_log_channel_disc_id",
]);

/**
 * A main persona whose Discord guild avatar is out of date with its preset:
 * the unit of work consumed by the background preset-avatar fan-out reconciler.
 */
export type UnsyncedMainPointer = {
  server_disc_id: string;
  persona_id: number;
  preset_avatar_shared_url: string;
  preset_avatar_hash: string;
};

class PersonaRepository implements IRepository<PersonaExportShape> {
  private static readonly FALLBACK_DEBUG_ENABLED = new Set(["1", "true", "yes", "on"]).has(
    (process.env.FALLBACK_DEBUG_ENABLED ?? "").trim().toLowerCase(),
  );

  /**
   * Loads the full composite TomoriState for a server's main persona.
   * Returns null if the server has no registered persona.
   *
   * @param serverDiscId - Discord server snowflake
   */
  async loadState(serverDiscId: string): Promise<TomoriState | null> {
    return this.loadTomoriState(serverDiscId);
  }

  /**
   * Loads TomoriState for every persona registered in the server.
   *
   * @param serverDiscId - Discord server snowflake
   */
  async loadAllForServer(serverDiscId: string): Promise<TomoriState[]> {
    return this.loadAllPersonasForServer(serverDiscId);
  }

  /**
   * Loads the PersonaConfigRow for a specific tomori by internal ID.
   *
   * @param personaId - Internal tomori DB ID
   */
  async loadPersonaConfig(personaId: number) {
    return this.loadPersonaConfigRow(personaId);
  }

  /**
   * Loads persona summaries for modal selector and context overrides.
   * Includes fields needed for context builder persona identity without loading full TomoriState.
   * Returns main persona first (is_alter=false), then alters ordered by recency.
   *
   * @param serverId - Numeric DB server ID
   * @returns Array of persona summaries with identity/override fields
   */
  async loadServerPersonaSummaries(serverId: number): Promise<
    Array<{
      persona_id: number;
      persona_nickname: string;
      webhook_avatar_url: string | null;
      is_alter: boolean;
      attribute_list: string[];
      persona_lineage_id: number | null;
      persona_prompt: string | null;
    }>
  > {
    try {
      const rows = await sql`
        SELECT
          t.persona_id,
          t.persona_nickname,
          t.webhook_avatar_url,
          t.is_alter,
          CASE
            WHEN pp.persona_preset_id IS NOT NULL THEN pp.preset_attribute_list
            ELSE COALESCE(
              (
                SELECT array_agg(pa.attribute_text ORDER BY pa.attribute_order)
                FROM persona_attributes pa
                WHERE pa.persona_id = t.persona_id
              ),
              t.attribute_list
            )
          END AS attribute_list,
          t.persona_lineage_id,
          CASE
            WHEN pp.persona_preset_id IS NOT NULL THEN NULLIF(BTRIM(pp.persona_preset_desc), '')
            ELSE pc.persona_prompt
          END AS persona_prompt
        FROM personas t
        LEFT JOIN persona_configs pc ON pc.persona_id = t.persona_id
        LEFT JOIN persona_presets pp
          ON t.is_pointer = true
          AND pp.preset_lineage_id = t.preset_lineage_id
          AND pp.preset_language = t.preset_language
        WHERE t.server_id = ${serverId}
        ORDER BY t.is_alter ASC, t.updated_at DESC NULLS LAST, t.persona_id DESC
      `;
      return rows ?? [];
    } catch (error) {
      log.error(`Error loading persona summaries for server ${serverId}:`, error);
      return [];
    }
  }

  /**
   * Returns true when a main persona (is_alter=false) exists for the given server.
   * Used by setup to distinguish "no main persona" from "main persona exists but broken state".
   *
   * @param serverId - Internal server DB ID
   */
  async hasMainPersona(serverId: number): Promise<boolean> {
    try {
      const [row] = await sql`
        SELECT 1
        FROM personas
        WHERE server_id = ${serverId}
          AND is_alter = false
        LIMIT 1
      `;
      return row !== undefined;
    } catch (error) {
      log.error(`Error checking main persona existence for server ${serverId}:`, error);
      return false;
    }
  }

  /**
   * Updates arbitrary fields on a Tomori row.
   * Invalidates the server's tomori state cache after write.
   *
   * @param personaId      - Internal tomori DB ID
   * @param tomoriData    - Partial TomoriRow with fields to update
   * @param serverDiscId  - Discord server snowflake (required for cache invalidation)
   * @returns Updated TomoriRow or null on failure
   */
  async update(personaId: number, tomoriData: Partial<TomoriRow>, serverDiscId?: string): Promise<TomoriRow | null> {
    if (Object.keys(tomoriData).some((field) => TOMORI_POINTER_CONTENT_FIELDS.has(field))) {
      const materialized = await this.materializeIfPointer(personaId);
      if (!materialized) {
        return null;
      }
    }

    const row = await this.updateTomori(personaId, tomoriData);
    if (row && serverDiscId) invalidateTomoriStateCache(serverDiscId);
    return row;
  }

  async replaceAttributes(personaId: number, attributes: string[], publicFlags?: boolean[]): Promise<boolean> {
    try {
      const flags = normalizeAttributePublicFlags(attributes, publicFlags);
      return await sql.transaction(async (tx) => {
        const materialized = await this.materializeIfPointerWithClient(personaId, tx);
        if (!materialized) {
          return false;
        }

        await tx`DELETE FROM persona_attributes WHERE persona_id = ${personaId}`;

        for (let index = 0; index < attributes.length; index++) {
          await tx`
            INSERT INTO persona_attributes (persona_id, attribute_order, attribute_text, is_public)
            VALUES (${personaId}, ${index + 1}, ${attributes[index]}, ${flags[index]})
          `;
        }

        const result = await tx`
          UPDATE personas
          SET
            attribute_list = ${sql.array(attributes, "TEXT")},
            updated_at = NOW()
          WHERE persona_id = ${personaId}
          RETURNING persona_id
        `;
        return result.length > 0;
      });
    } catch (e) {
      log.error(`Error replacing attributes for persona ${personaId}:`, e);
      return false;
    }
  }

  async addAttributes(personaId: number, attributes: string[], isPublic = false): Promise<boolean> {
    if (attributes.length === 0) {
      return true;
    }

    try {
      return await sql.transaction(async (tx) => {
        const materialized = await this.materializeIfPointerWithClient(personaId, tx);
        if (!materialized) {
          return false;
        }

        await tx`
          INSERT INTO persona_attributes (persona_id, attribute_order, attribute_text, is_public)
          SELECT
            p.persona_id,
            attr.ord::INT,
            attr.attribute_text,
            false
          FROM personas p
          CROSS JOIN LATERAL unnest(COALESCE(p.attribute_list, ARRAY[]::TEXT[]))
            WITH ORDINALITY AS attr(attribute_text, ord)
          WHERE p.persona_id = ${personaId}
            AND NOT EXISTS (
              SELECT 1
              FROM persona_attributes pa
              WHERE pa.persona_id = p.persona_id
            )
          ON CONFLICT (persona_id, attribute_order) DO NOTHING
        `;

        const [orderRow] = await tx<Array<{ max_order: number }>>`
          SELECT COALESCE(MAX(attribute_order), 0)::INT AS max_order
          FROM persona_attributes
          WHERE persona_id = ${personaId}
        `;
        const maxOrder = orderRow?.max_order ?? 0;

        for (let index = 0; index < attributes.length; index++) {
          await tx`
            INSERT INTO persona_attributes (persona_id, attribute_order, attribute_text, is_public)
            VALUES (${personaId}, ${maxOrder + index + 1}, ${attributes[index]}, ${isPublic})
          `;
        }

        const result = await tx`
          UPDATE personas p
          SET
            attribute_list = COALESCE(
              (
                SELECT array_agg(pa.attribute_text ORDER BY pa.attribute_order)
                FROM persona_attributes pa
                WHERE pa.persona_id = p.persona_id
              ),
              ARRAY[]::TEXT[]
            ),
            updated_at = NOW()
          WHERE p.persona_id = ${personaId}
          RETURNING p.persona_id
        `;
        return result.length > 0;
      });
    } catch (e) {
      log.error(`Error adding attributes for persona ${personaId}:`, e);
      return false;
    }
  }

  async editAttributeAt(
    personaId: number,
    index1Based: number,
    newAttribute: string,
    isPublic?: boolean,
  ): Promise<boolean> {
    try {
      return await sql.transaction(async (tx) => {
        const materialized = await this.materializeIfPointerWithClient(personaId, tx);
        if (!materialized) {
          return false;
        }

        await tx`
          INSERT INTO persona_attributes (persona_id, attribute_order, attribute_text, is_public)
          SELECT
            p.persona_id,
            attr.ord::INT,
            attr.attribute_text,
            false
          FROM personas p
          CROSS JOIN LATERAL unnest(COALESCE(p.attribute_list, ARRAY[]::TEXT[]))
            WITH ORDINALITY AS attr(attribute_text, ord)
          WHERE p.persona_id = ${personaId}
            AND NOT EXISTS (
              SELECT 1
              FROM persona_attributes pa
              WHERE pa.persona_id = p.persona_id
            )
          ON CONFLICT (persona_id, attribute_order) DO NOTHING
        `;

        const result = await tx`
          UPDATE persona_attributes
          SET
            attribute_text = ${newAttribute},
            is_public = COALESCE(${isPublic ?? null}::BOOLEAN, is_public),
            updated_at = NOW()
          WHERE persona_id = ${personaId}
            AND attribute_order = ${index1Based}
          RETURNING persona_id
        `;
        if (result.length === 0) {
          return false;
        }

        await tx`
          UPDATE personas p
          SET
            attribute_list = COALESCE(
              (
                SELECT array_agg(pa.attribute_text ORDER BY pa.attribute_order)
                FROM persona_attributes pa
                WHERE pa.persona_id = p.persona_id
              ),
              ARRAY[]::TEXT[]
            ),
            updated_at = NOW()
          WHERE p.persona_id = ${personaId}
        `;
        return true;
      });
    } catch (e) {
      log.error(`Error editing attribute at index ${index1Based} for persona ${personaId}:`, e);
      return false;
    }
  }

  async removeAttributeAt(personaId: number, index1Based: number): Promise<boolean> {
    try {
      return await sql.transaction(async (tx) => {
        const materialized = await this.materializeIfPointerWithClient(personaId, tx);
        if (!materialized) {
          return false;
        }

        await tx`
          INSERT INTO persona_attributes (persona_id, attribute_order, attribute_text, is_public)
          SELECT
            p.persona_id,
            attr.ord::INT,
            attr.attribute_text,
            false
          FROM personas p
          CROSS JOIN LATERAL unnest(COALESCE(p.attribute_list, ARRAY[]::TEXT[]))
            WITH ORDINALITY AS attr(attribute_text, ord)
          WHERE p.persona_id = ${personaId}
            AND NOT EXISTS (
              SELECT 1
              FROM persona_attributes pa
              WHERE pa.persona_id = p.persona_id
            )
          ON CONFLICT (persona_id, attribute_order) DO NOTHING
        `;

        const rows = await tx<Array<Pick<PersonaAttributeRow, "attribute_text" | "is_public">>>`
          SELECT attribute_text, is_public
          FROM persona_attributes
          WHERE persona_id = ${personaId}
          ORDER BY attribute_order
        `;
        if (index1Based < 1 || index1Based > rows.length) {
          return false;
        }

        const remainingRows = rows.filter((_row, index) => index + 1 !== index1Based);
        await tx`DELETE FROM persona_attributes WHERE persona_id = ${personaId}`;
        for (let index = 0; index < remainingRows.length; index++) {
          const row = remainingRows[index];
          await tx`
            INSERT INTO persona_attributes (persona_id, attribute_order, attribute_text, is_public)
            VALUES (${personaId}, ${index + 1}, ${row.attribute_text}, ${row.is_public})
          `;
        }

        const result = await tx`
          UPDATE personas
          SET
            attribute_list = ${sql.array(
              remainingRows.map((row) => row.attribute_text),
              "TEXT",
            )},
            updated_at = NOW()
          WHERE persona_id = ${personaId}
          RETURNING persona_id
        `;
        return result.length > 0;
      });
    } catch (e) {
      log.error(`Error removing attribute at index ${index1Based} for persona ${personaId}:`, e);
      return false;
    }
  }

  async removeAttribute(personaId: number, attributeToRemove: string): Promise<boolean> {
    try {
      const materialized = await this.materializeIfPointer(personaId);
      if (!materialized) {
        return false;
      }

      const [row] = await sql<Array<{ attribute_order: number }>>`
        SELECT attribute_order
        FROM persona_attributes
        WHERE persona_id = ${personaId}
          AND attribute_text = ${attributeToRemove}
        ORDER BY attribute_order
        LIMIT 1
      `;
      if (!row) {
        const [personaRow] = await sql<Array<{ attribute_list: string[] }>>`
          SELECT attribute_list
          FROM personas
          WHERE persona_id = ${personaId}
          LIMIT 1
        `;
        const mirrorIndex = personaRow?.attribute_list?.indexOf(attributeToRemove) ?? -1;
        if (mirrorIndex < 0) {
          return false;
        }
        return await this.removeAttributeAt(personaId, mirrorIndex + 1);
      }
      return await this.removeAttributeAt(personaId, row.attribute_order);
    } catch (e) {
      log.error(`Error removing attribute for persona ${personaId}:`, e);
      return false;
    }
  }

  async setPrompt(personaId: number, prompt: string): Promise<boolean> {
    try {
      const materialized = await this.materializeIfPointer(personaId);
      if (!materialized) {
        return false;
      }

      const result = await sql`
        INSERT INTO persona_configs (persona_id, persona_prompt)
        VALUES (${personaId}, ${prompt})
        ON CONFLICT (persona_id) DO UPDATE
        SET persona_prompt = EXCLUDED.persona_prompt
        RETURNING *
      `;
      return result.length > 0;
    } catch (e) {
      log.error(`Error setting prompt for persona ${personaId}:`, e);
      return false;
    }
  }

  async removePrompt(personaId: number): Promise<boolean> {
    try {
      const materialized = await this.materializeIfPointer(personaId);
      if (!materialized) {
        return false;
      }

      const result = await sql`
        UPDATE persona_configs
        SET persona_prompt = NULL
        WHERE persona_id = ${personaId}
        RETURNING *
      `;
      return result.length > 0;
    } catch (e) {
      log.error(`Error removing prompt for persona ${personaId}:`, e);
      return false;
    }
  }

  /**
   * Set the context note (and depth) for a persona.
   *
   * @param personaId - Internal persona DB ID
   * @param contextNote - Note text, or null to clear
   * @param contextNoteDepth - Injection depth (0 disables)
   */
  async setContextNote(personaId: number, contextNote: string | null, contextNoteDepth: number): Promise<boolean> {
    try {
      const materialized = await this.materializeIfPointer(personaId);
      if (!materialized) {
        return false;
      }

      const row: PersonaContextNoteConfigsRow = {
        persona_id: personaId,
        context_note: contextNote,
        context_note_depth: contextNoteDepth,
      };
      await this.sqlUpsertPersonaContextNoteConfigs(row);
      return true;
    } catch (e) {
      log.error(`Error setting context note for persona ${personaId}:`, e);
      return false;
    }
  }

  /**
   * Sets or clears the per-persona humanizer degree override in persona_configs.
   * Operational setting (like the persona LLM override): does NOT materialize
   * pointer-preset personas, since no preset content is edited.
   * Upserts so the write is self-healing if the persona_configs row is missing.
   *
   * @param personaId - Internal persona DB ID
   * @param humanizerDegree - Override value 0-3, or null to inherit the server-wide setting
   * @returns True when the write succeeded
   */
  async setHumanizerOverride(personaId: number, humanizerDegree: number | null): Promise<boolean> {
    try {
      const result = await sql`
        INSERT INTO persona_configs (persona_id, humanizer_degree)
        VALUES (${personaId}, ${humanizerDegree})
        ON CONFLICT (persona_id) DO UPDATE
        SET humanizer_degree = EXCLUDED.humanizer_degree
        RETURNING *
      `;
      return result.length > 0;
    } catch (e) {
      log.error(`Error setting humanizer override for persona ${personaId}:`, e);
      return false;
    }
  }

  /**
   * Set the NovelAI ATTG (Author/Title/Tags/Genre/Stars) metadata for a persona.
   *
   * @param personaId - Internal persona DB ID
   * @param attg     - ATTG fields; any subset may be null to clear that field
   */
  async setNaiAttg(
    personaId: number,
    attg: {
      nai_attg_author: string | null;
      nai_attg_title: string | null;
      nai_attg_tags: string | null;
      nai_attg_genre: string | null;
      nai_attg_stars: number | null;
    },
  ): Promise<boolean> {
    try {
      const materialized = await this.materializeIfPointer(personaId);
      if (!materialized) {
        return false;
      }

      const row: PersonaTextgenConfigsRow = { persona_id: personaId, ...attg };
      await this.sqlUpsertPersonaTextgenConfigs(row);
      return true;
    } catch (e) {
      log.error(`Error setting NAI ATTG for persona ${personaId}:`, e);
      return false;
    }
  }

  /**
   * Replace the full voice assignment config for a persona.
   *
   * @param personaId - Internal persona DB ID
   * @param voice - Complete voice config row excluding persona_id
   */
  async setVoiceConfig(personaId: number, voice: Omit<PersonaVoiceConfigsRow, "persona_id">): Promise<boolean> {
    try {
      const materialized = await this.materializeIfPointer(personaId);
      if (!materialized) {
        return false;
      }

      await this.sqlUpsertPersonaVoiceConfigs({ persona_id: personaId, ...voice });
      return true;
    } catch (e) {
      log.error(`Error setting voice config for persona ${personaId}:`, e);
      return false;
    }
  }

  /**
   * Replace the persona's physical appearance image tags.
   * Writes only `physical_appearance_tags`, preserving `nai_char_ref_url`.
   *
   * @param personaId - Internal persona DB ID
   * @param tags - Full replacement tag array (use [] to clear)
   */
  async setPhysicalAppearanceTags(personaId: number, tags: string[]): Promise<boolean> {
    try {
      const materialized = await this.materializeIfPointer(personaId);
      if (!materialized) {
        return false;
      }

      await sql`
        INSERT INTO persona_imagegen_configs (persona_id, physical_appearance_tags)
        VALUES (${personaId}, ${sql.array(tags, "TEXT")})
        ON CONFLICT (persona_id) DO UPDATE SET
          physical_appearance_tags = EXCLUDED.physical_appearance_tags,
          updated_at = NOW()
      `;
      return true;
    } catch (e) {
      log.error(`Error setting physical appearance tags for persona ${personaId}:`, e);
      return false;
    }
  }

  /**
   * Replace the persona's NovelAI character reference image URL.
   *
   * @param personaId - Internal persona DB ID
   * @param refUrl    - Stored reference URL/path, or null to clear
   */
  async setNaiCharRef(personaId: number, refUrl: string | null): Promise<boolean> {
    try {
      const materialized = await this.materializeIfPointer(personaId);
      if (!materialized) {
        return false;
      }

      await sql`
        INSERT INTO persona_imagegen_configs (persona_id, nai_char_ref_url)
        VALUES (${personaId}, ${refUrl})
        ON CONFLICT (persona_id) DO UPDATE SET
          nai_char_ref_url = EXCLUDED.nai_char_ref_url,
          updated_at = NOW()
      `;
      return true;
    } catch (e) {
      log.error(`Error setting NAI character reference for persona ${personaId}:`, e);
      return false;
    }
  }

  async addSampleDialoguePair(personaId: number, inputs: string[], outputs: string[]): Promise<boolean> {
    if (inputs.length !== outputs.length) {
      log.error(`addSampleDialoguePair input/output length mismatch for persona ${personaId}`);
      return false;
    }
    if (inputs.length === 0) return true;

    try {
      const materialized = await this.materializeIfPointer(personaId);
      if (!materialized) {
        return false;
      }

      const result = await sql`
        UPDATE personas
        SET sample_dialogues_in = array_cat(sample_dialogues_in, ${sql.array(inputs, "TEXT")}),
            sample_dialogues_out = array_cat(sample_dialogues_out, ${sql.array(outputs, "TEXT")})
        WHERE persona_id = ${personaId}
        RETURNING persona_id
      `;
      return result.length > 0;
    } catch (e) {
      log.error(`Error adding sample dialogue pair(s) for persona ${personaId}:`, e);
      return false;
    }
  }

  async editSampleDialoguePairAt(
    personaId: number,
    index1Based: number,
    newInput: string,
    newOutput: string,
  ): Promise<boolean> {
    try {
      const materialized = await this.materializeIfPointer(personaId);
      if (!materialized) {
        return false;
      }

      const result = await sql`
        UPDATE personas
        SET sample_dialogues_in[${index1Based}] = ${newInput},
            sample_dialogues_out[${index1Based}] = ${newOutput}
        WHERE persona_id = ${personaId}
        RETURNING persona_id
      `;
      return result.length > 0;
    } catch (e) {
      log.error(`Error editing sample dialogue at index ${index1Based} for persona ${personaId}:`, e);
      return false;
    }
  }

  async removeSampleDialoguePairAt(personaId: number, index1Based: number): Promise<boolean> {
    try {
      const materialized = await this.materializeIfPointer(personaId);
      if (!materialized) {
        return false;
      }

      const result = await sql`
        UPDATE personas
        SET
          sample_dialogues_in = (
            SELECT COALESCE(array_agg(elem ORDER BY ord), '{}')
            FROM unnest(sample_dialogues_in) WITH ORDINALITY AS t(elem, ord)
            WHERE ord != ${index1Based}
          ),
          sample_dialogues_out = (
            SELECT COALESCE(array_agg(elem ORDER BY ord), '{}')
            FROM unnest(sample_dialogues_out) WITH ORDINALITY AS t(elem, ord)
            WHERE ord != ${index1Based}
          )
        WHERE persona_id = ${personaId}
        RETURNING persona_id
      `;
      return result.length > 0;
    } catch (e) {
      log.error(`Error removing sample dialogue at index ${index1Based} for persona ${personaId}:`, e);
      return false;
    }
  }

  /**
   * Repairs mismatched sample-dialogue arrays by truncating both to a safe pair count.
   *
   * @param personaId    - Internal persona DB ID
   * @param safeLength  - Length to truncate both dialogue arrays to
   * @returns The repaired dialogue arrays, or null when no row was updated
   */
  async repairSampleDialogues(
    personaId: number,
    safeLength: number,
  ): Promise<{ repairedIn: string[]; repairedOut: string[] } | null> {
    const materialized = await this.materializeIfPointer(personaId);
    if (!materialized) {
      return null;
    }

    const [updatedRow] = await sql`
      UPDATE personas
      SET
        sample_dialogues_in = sample_dialogues_in[1:${safeLength}],
        sample_dialogues_out = sample_dialogues_out[1:${safeLength}]
      WHERE persona_id = ${personaId}
      RETURNING sample_dialogues_in, sample_dialogues_out
    `;

    return updatedRow
      ? {
          repairedIn: (updatedRow.sample_dialogues_in as string[]) ?? [],
          repairedOut: (updatedRow.sample_dialogues_out as string[]) ?? [],
        }
      : null;
  }

  async removePersona(personaId: number): Promise<boolean> {
    try {
      const result = await sql`
        DELETE FROM personas
        WHERE persona_id = ${personaId}
        RETURNING persona_id
      `;
      return result.length > 0;
    } catch (e) {
      log.error(`Error removing persona ${personaId}:`, e);
      return false;
    }
  }

  async countMainPersonasForServer(serverId: number): Promise<number> {
    try {
      const [row] = await sql<Array<{ main_count: number | string }>>`
        SELECT COUNT(*)::int AS main_count
        FROM personas
        WHERE server_id = ${serverId}
          AND is_alter = false
      `;
      return Number(row?.main_count ?? 0);
    } catch (e) {
      log.error(`Error counting main personas for server ${serverId}:`, e);
      return 0;
    }
  }

  async renamePersona(personaId: number, newName: string): Promise<boolean> {
    try {
      const materialized = await this.materializeIfPointer(personaId);
      if (!materialized) {
        return false;
      }

      const result = await sql`
        UPDATE personas
        SET persona_nickname = ${newName}
        WHERE persona_id = ${personaId}
        RETURNING *
      `;
      return result.length > 0;
    } catch (e) {
      log.error(`Error renaming persona ${personaId}:`, e);
      return false;
    }
  }

  async hasNicknameConflict(serverId: number, excludedPersonaId: number, nickname: string): Promise<boolean> {
    try {
      const rows = await sql<Array<{ persona_id: number }>>`
        SELECT persona_id
        FROM personas
        WHERE server_id = ${serverId}
          AND persona_id <> ${excludedPersonaId}
          AND lower(btrim(persona_nickname)) = lower(btrim(${nickname}))
        LIMIT 1
      `;
      return rows.length > 0;
    } catch (e) {
      log.error(`Error checking persona nickname conflict for server ${serverId}:`, e);
      return true;
    }
  }

  async swapPersona(mainPersonaId: number, alterPersonaId: number): Promise<boolean> {
    try {
      await sql.transaction(async (tx) => {
        const rows = await tx<Array<{ persona_id: number; server_id: number; is_alter: boolean }>>`
          SELECT persona_id, server_id, is_alter
          FROM personas
          WHERE persona_id IN (${mainPersonaId}, ${alterPersonaId})
          FOR UPDATE
        `;

        const mainPersona = rows.find((row) => row.persona_id === mainPersonaId);
        const alterPersona = rows.find((row) => row.persona_id === alterPersonaId);

        if (!mainPersona || !alterPersona || mainPersona.server_id !== alterPersona.server_id) {
          throw new Error("Persona swap requires two personas from the same server.");
        }

        if (mainPersona.is_alter || !alterPersona.is_alter) {
          throw new Error("Persona swap requires the first persona to be main and the second persona to be an alter.");
        }

        await tx`
          UPDATE personas
          SET is_alter = true
          WHERE persona_id = ${mainPersonaId}
        `;
        await tx`
          UPDATE personas
          SET is_alter = false
          WHERE persona_id = ${alterPersonaId}
        `;
      });
      return true;
    } catch (e) {
      log.error(`Error swapping personas ${mainPersonaId} and ${alterPersonaId}:`, e);
      return false;
    }
  }

  async setAvatar(personaId: number, avatarUrl: string | null): Promise<boolean> {
    try {
      const result = await sql`
        UPDATE personas
        SET webhook_avatar_url = ${avatarUrl}
        WHERE persona_id = ${personaId}
        RETURNING *
      `;
      return result.length > 0;
    } catch (e) {
      log.error(`Error setting avatar for persona ${personaId}:`, e);
      return false;
    }
  }

  /**
   * Creates an alter persona row and returns the inserted row.
   * Intentionally does not catch DB errors so callers can preserve
   * unique-violation handling for user-facing name-conflict replies.
   *
   * @param params - Alter persona fields to insert
   */
  async createAlterPersona(params: {
    serverId: number;
    nickname: string;
    attributes: string[];
    attributePublicFlags?: boolean[];
    sampleDialoguesIn: string[];
    sampleDialoguesOut: string[];
    personaLineageId?: number | null;
    physicalAppearanceTags?: string[];
    naiCharRefUrl?: string | null;
    naiAttgAuthor?: string | null;
    naiAttgTitle?: string | null;
    naiAttgTags?: string | null;
    naiAttgGenre?: string | null;
    naiAttgStars?: number | null;
  }): Promise<TomoriRow | null> {
    const row = await sql.transaction(async (tx) => {
      const [insertedRow] = await tx`
        INSERT INTO personas (
          server_id,
          persona_nickname,
          attribute_list,
          sample_dialogues_in,
          sample_dialogues_out,
          is_alter,
          persona_lineage_id
        )
        VALUES (
          ${params.serverId},
          ${params.nickname},
          ${sql.array(params.attributes, "TEXT")},
          ${sql.array(params.sampleDialoguesIn, "TEXT")},
          ${sql.array(params.sampleDialoguesOut, "TEXT")},
          true,
          COALESCE(${params.personaLineageId ?? null}::bigint, nextval('persona_lineage_id_seq'))
        )
        RETURNING *
      `;
      if (!insertedRow?.persona_id) {
        return null;
      }
      const personaId = insertedRow.persona_id as number;

      await tx`
        INSERT INTO persona_imagegen_configs (persona_id, physical_appearance_tags, nai_char_ref_url)
        VALUES (${personaId}, ${sql.array(params.physicalAppearanceTags ?? [], "TEXT")}, ${params.naiCharRefUrl ?? null})
        ON CONFLICT (persona_id) DO UPDATE SET
          physical_appearance_tags = EXCLUDED.physical_appearance_tags,
          nai_char_ref_url = EXCLUDED.nai_char_ref_url,
          updated_at = NOW()
      `;

      await tx`
        INSERT INTO persona_textgen_configs (
          persona_id, nai_attg_author, nai_attg_title, nai_attg_tags, nai_attg_genre, nai_attg_stars
        )
        VALUES (
          ${personaId},
          ${params.naiAttgAuthor ?? null},
          ${params.naiAttgTitle ?? null},
          ${params.naiAttgTags ?? null},
          ${params.naiAttgGenre ?? null},
          ${params.naiAttgStars ?? null}
        )
        ON CONFLICT (persona_id) DO UPDATE SET
          nai_attg_author = EXCLUDED.nai_attg_author,
          nai_attg_title = EXCLUDED.nai_attg_title,
          nai_attg_tags = EXCLUDED.nai_attg_tags,
          nai_attg_genre = EXCLUDED.nai_attg_genre,
          nai_attg_stars = EXCLUDED.nai_attg_stars,
          updated_at = NOW()
      `;

      const flags = normalizeAttributePublicFlags(params.attributes, params.attributePublicFlags);
      for (let index = 0; index < params.attributes.length; index++) {
        await tx`
          INSERT INTO persona_attributes (persona_id, attribute_order, attribute_text, is_public)
          VALUES (${personaId}, ${index + 1}, ${params.attributes[index]}, ${flags[index]})
        `;
      }

      return insertedRow;
    });
    return row ? (row as unknown as TomoriRow) : null;
  }

  async applyPresetPointerToPersona(params: {
    personaId: number;
    nickname: string;
    preset: TomoriPresetRow;
    personaLineageId?: number | null;
    triggerWords?: string[];
    personaPrompt?: string | null;
  }): Promise<TomoriRow | null> {
    const pointerLineageId = normalizeLineageId(params.preset.preset_lineage_id);
    if (pointerLineageId === null) {
      log.error(`Cannot create preset pointer for persona ${params.personaId}: preset has no lineage id.`);
      return null;
    }

    try {
      const row = await sql.transaction(async (tx) => {
        const [updatedRow] = await tx`
          UPDATE personas
          SET
            persona_nickname = ${params.nickname},
            attribute_list = ${sql.array(params.preset.preset_attribute_list, "TEXT")},
            sample_dialogues_in = ${sql.array(params.preset.preset_sample_dialogues_in, "TEXT")},
            sample_dialogues_out = ${sql.array(params.preset.preset_sample_dialogues_out, "TEXT")},
            persona_lineage_id = ${params.personaLineageId ?? pointerLineageId},
            is_pointer = true,
            preset_lineage_id = ${pointerLineageId},
            preset_language = ${params.preset.preset_language},
            -- Re-pointing is a fresh pointer: drop any stored avatar so the persona
            -- resolves the official preset avatar again (alters live-resolve the
            -- shared image; mains re-receive it via the guild-avatar reconciler).
            -- The caller deletes the old server-owned image (shared presets/ images
            -- are immutable and skipped by the delete guard).
            webhook_avatar_url = NULL,
            updated_at = NOW()
          WHERE persona_id = ${params.personaId}
          RETURNING *
        `;
        if (!updatedRow?.persona_id) {
          return null;
        }

        await this.replacePresetAttributesWithClient(tx, params.personaId, params.preset);
        await this.writePresetPersonaConfigWithClient(
          tx,
          params.personaId,
          params.triggerWords ?? resolvePresetTriggerWords(params.preset),
          params.personaPrompt ?? resolvePresetPersonaPrompt(params.preset),
        );
        // Re-pointing resets sprites: drop the persona's own rows so it resolves
        // the official preset sprite set live again. Server-owned sprite IMAGES
        // are cleaned up by the caller (the shared preset images are immutable).
        await tx`DELETE FROM persona_sprites WHERE persona_id = ${params.personaId}`;

        return updatedRow;
      });

      return row ? (row as unknown as TomoriRow) : null;
    } catch (error) {
      log.error(`Error applying preset pointer to persona ${params.personaId}:`, error);
      return null;
    }
  }

  /**
   * Records that a server's main persona guild avatar is now in sync with its
   * preset; call this immediately after a SUCCESSFUL guild-avatar PATCH at an
   * apply site (`/setup`, `/persona default`). It stamps
   * `applied_avatar_hash = preset_avatar_hash` so the background fan-out
   * reconciler skips this persona until the catalog art actually changes again
   * (preventing a redundant re-PATCH on the next boot).
   *
   * Only stamps an unforked **main pointer** whose preset carries a seeded avatar
   * hash; materialized/non-pointer mains and avatar-less presets are no-ops (the
   * reconciler ignores them anyway), so this is safe to call unconditionally on
   * any successful guild-avatar apply.
   *
   * @param serverDiscId - The Discord guild id whose main avatar was just applied
   */
  async markServerMainAvatarSynced(serverDiscId: string): Promise<void> {
    try {
      await sql`
        UPDATE personas p
        SET applied_avatar_hash = pp.preset_avatar_hash
        FROM servers s, persona_presets pp
        WHERE s.server_disc_id = ${serverDiscId}
          AND p.server_id = s.server_id
          AND p.is_alter = false
          AND p.is_pointer = true
          AND pp.preset_lineage_id = p.preset_lineage_id
          AND pp.preset_language = p.preset_language
          AND pp.preset_avatar_hash IS NOT NULL
          AND p.applied_avatar_hash IS DISTINCT FROM pp.preset_avatar_hash
      `;
    } catch (error) {
      // Non-fatal: a missed stamp only costs one redundant reconciler PATCH later.
      log.warn(`Failed to stamp applied_avatar_hash for server ${serverDiscId} (non-fatal)`, error);
    }
  }

  /**
   * Loads every server whose active main persona is an unforked preset pointer
   * and whose last-applied avatar hash differs from its preset's current avatar
   * hash: exactly the work set for the background preset-avatar fan-out
   * reconciler. Materialized personas (`is_pointer = false`) and presets without
   * a seeded avatar are excluded by the join/predicates.
   *
   * Errors propagate to the caller, which owns the "skip this run" semantics.
   */
  async loadUnsyncedMainPointers(): Promise<UnsyncedMainPointer[]> {
    return await sql<UnsyncedMainPointer[]>`
      SELECT
        s.server_disc_id,
        p.persona_id,
        pp.preset_avatar_shared_url,
        pp.preset_avatar_hash
      FROM personas p
      JOIN servers s ON s.server_id = p.server_id
      JOIN persona_presets pp
        ON pp.preset_lineage_id = p.preset_lineage_id
        AND pp.preset_language = p.preset_language
      WHERE p.is_alter = false
        AND p.is_pointer = true
        AND pp.preset_avatar_hash IS NOT NULL
        AND pp.preset_avatar_shared_url IS NOT NULL
        AND p.applied_avatar_hash IS DISTINCT FROM pp.preset_avatar_hash
    `;
  }

  /**
   * Returns whether a persona is still an unforked pointer, or `null` when the
   * row no longer exists. The avatar reconciler uses this to skip a persona the
   * user customized (materialized) while it waited in the reconciler queue.
   *
   * Errors propagate so the caller can decide to skip the persona to be safe.
   *
   * @param personaId - Internal persona DB ID
   */
  async isPersonaPointer(personaId: number): Promise<boolean | null> {
    const [row] = await sql<Array<{ is_pointer: boolean | null }>>`
      SELECT is_pointer FROM personas WHERE persona_id = ${personaId}
    `;
    if (!row) return null;
    return row.is_pointer ?? false;
  }

  /**
   * Stamps a single main pointer's `applied_avatar_hash` after a SUCCESSFUL
   * guild-avatar PATCH so the reconciler skips it until the preset art changes
   * again. Unlike {@link markServerMainAvatarSynced} (which resolves the hash via
   * the preset join for an apply-site), this writes a hash the caller already
   * holds for one specific persona.
   *
   * Errors propagate so the caller can log and retry on the next boot.
   *
   * @param personaId        - Internal persona DB ID
   */
  async stampPointerAvatarHash(personaId: number, presetAvatarHash: string): Promise<void> {
    await sql`
      UPDATE personas
      SET applied_avatar_hash = ${presetAvatarHash}
      WHERE persona_id = ${personaId}
    `;
  }

  async createPresetPointerAlterPersona(params: {
    serverId: number;
    nickname: string;
    preset: TomoriPresetRow;
    personaLineageId?: number | null;
    useFreshLineage?: boolean;
    triggerWords?: string[];
    personaPrompt?: string | null;
  }): Promise<TomoriRow | null> {
    const pointerLineageId = normalizeLineageId(params.preset.preset_lineage_id);
    if (pointerLineageId === null) {
      log.error(`Cannot create alter preset pointer "${params.nickname}": preset has no lineage id.`);
      return null;
    }

    const row = await sql.transaction(async (tx) => {
      let memoryLineageId = params.personaLineageId ?? pointerLineageId;
      if (params.useFreshLineage === true) {
        const [lineageRow] = await tx<Array<{ lineage_id: number | string | bigint }>>`
          SELECT nextval('persona_lineage_id_seq') AS lineage_id
        `;
        memoryLineageId = Number(lineageRow.lineage_id);
      }

      const [insertedRow] = await tx`
        INSERT INTO personas (
          server_id,
          persona_nickname,
          attribute_list,
          sample_dialogues_in,
          sample_dialogues_out,
          is_alter,
          persona_lineage_id,
          is_pointer,
          preset_lineage_id,
          preset_language
        )
        VALUES (
          ${params.serverId},
          ${params.nickname},
          ${sql.array(params.preset.preset_attribute_list, "TEXT")},
          ${sql.array(params.preset.preset_sample_dialogues_in, "TEXT")},
          ${sql.array(params.preset.preset_sample_dialogues_out, "TEXT")},
          true,
          ${memoryLineageId},
          true,
          ${pointerLineageId},
          ${params.preset.preset_language}
        )
        RETURNING *
      `;
      if (!insertedRow?.persona_id) {
        return null;
      }

      await this.replacePresetAttributesWithClient(tx, insertedRow.persona_id as number, params.preset);
      await this.writePresetPersonaConfigWithClient(
        tx,
        insertedRow.persona_id as number,
        params.triggerWords ?? resolvePresetTriggerWords(params.preset),
        params.personaPrompt ?? resolvePresetPersonaPrompt(params.preset),
      );

      return insertedRow;
    });

    return row ? (row as unknown as TomoriRow) : null;
  }

  async addTrigger(personaId: number, triggers: string[]): Promise<boolean> {
    try {
      const materialized = await this.materializeIfPointer(personaId);
      if (!materialized) {
        return false;
      }

      const normalizedTriggers = dedupeTriggerWords(triggers, { lowercase: false });
      if (normalizedTriggers.length === 0) {
        return true;
      }

      const result = await sql`
        INSERT INTO persona_configs (persona_id, trigger_words)
        VALUES (${personaId}, ${sql.array(normalizedTriggers, "TEXT")})
        ON CONFLICT (persona_id) DO UPDATE
        SET trigger_words = array_cat(persona_configs.trigger_words, EXCLUDED.trigger_words)
        RETURNING *
      `;
      return result.length > 0;
    } catch (e) {
      log.error(`Error adding triggers for persona ${personaId}:`, e);
      return false;
    }
  }

  /**
   * Replace the persona's trigger_words list with the given remaining set.
   * Upserts into `persona_configs`, so if no row exists yet, one is created
   * (matches addTrigger's behavior; the caller no longer needs a guarantor INSERT).
   *
   * @param personaId          - Internal persona DB ID
   * @param triggersRemaining - The full replacement list (NOT a delta)
   */
  async removeTrigger(personaId: number, triggersRemaining: string[]): Promise<boolean> {
    try {
      const materialized = await this.materializeIfPointer(personaId);
      if (!materialized) {
        return false;
      }

      const normalizedTriggersRemaining = dedupeTriggerWords(triggersRemaining, { lowercase: false });
      const result = await sql`
        INSERT INTO persona_configs (persona_id, trigger_words)
        VALUES (${personaId}, ${sql.array(normalizedTriggersRemaining, "TEXT")})
        ON CONFLICT (persona_id) DO UPDATE
        SET trigger_words = EXCLUDED.trigger_words
        RETURNING *
      `;
      return result.length > 0;
    } catch (e) {
      log.error(`Error removing triggers for persona ${personaId}:`, e);
      return false;
    }
  }

  /**
   * Atomically upserts both trigger_words and persona_prompt in persona_configs.
   * Mirrors the INSERT … ON CONFLICT DO UPDATE pattern used by preset-apply flows.
   *
   * @param personaId - Internal persona DB ID
   * @param triggers - Full replacement trigger word list (use [] to clear)
   * @param prompt   - Persona prompt text, or null to clear
   */
  async setPersonaConfig(
    personaId: number,
    triggers: string[],
    prompt: string | null,
    options: { materialize?: boolean } = {},
  ): Promise<boolean> {
    try {
      if (options.materialize !== false) {
        const materialized = await this.materializeIfPointer(personaId);
        if (!materialized) {
          return false;
        }
      }

      const normalizedTriggers = dedupeTriggerWords(triggers, { lowercase: false });
      await sql`
        INSERT INTO persona_configs (persona_id, trigger_words, persona_prompt)
        VALUES (${personaId}, ${sql.array(normalizedTriggers, "TEXT")}, ${prompt})
        ON CONFLICT (persona_id) DO UPDATE
        SET trigger_words  = EXCLUDED.trigger_words,
            persona_prompt = EXCLUDED.persona_prompt
      `;
      return true;
    } catch (e) {
      log.error(`Error setting persona config for persona ${personaId}:`, e);
      return false;
    }
  }

  /**
   * Check if a server has reached its trigger word limit.
   *
   * @param serverId  - Internal server DB ID
   * @param personaId  - Optional tomori ID for persona-scoped trigger words
   * @returns MemoryValidationResult indicating whether the limit is exceeded
   */
  async checkTriggerWordLimit(serverId: number, personaId?: number): Promise<MemoryValidationResult> {
    const limits = getMemoryLimits();

    try {
      const [configResult] = personaId
        ? await sql`
            SELECT
              CASE
                WHEN pp.persona_preset_id IS NOT NULL THEN array_length(pp.preset_trigger_words, 1)
                ELSE array_length(pc.trigger_words, 1)
              END as trigger_count
            FROM personas p
            LEFT JOIN persona_configs pc ON pc.persona_id = p.persona_id
            LEFT JOIN persona_presets pp
              ON p.is_pointer = true
              AND pp.preset_lineage_id = p.preset_lineage_id
              AND pp.preset_language = p.preset_language
            WHERE p.persona_id = ${personaId}
          `
        : await sql`
            SELECT
              CASE
                WHEN pp.persona_preset_id IS NOT NULL THEN array_length(pp.preset_trigger_words, 1)
                ELSE array_length(pc.trigger_words, 1)
              END as trigger_count
            FROM persona_configs pc
            JOIN personas t ON t.persona_id = pc.persona_id
            LEFT JOIN persona_presets pp
              ON t.is_pointer = true
              AND pp.preset_lineage_id = t.preset_lineage_id
              AND pp.preset_language = t.preset_language
            WHERE t.server_id = ${serverId}
              AND t.is_alter = false
            LIMIT 1
          `;

      const currentCount = configResult?.trigger_count || 0;

      if (currentCount >= limits.maxTriggerWords) {
        return {
          isValid: false,
          error: "TRIGGER_WORD_LIMIT_EXCEEDED",
          currentCount,
          maxAllowed: limits.maxTriggerWords,
        };
      }

      return { isValid: true, currentCount, maxAllowed: limits.maxTriggerWords };
    } catch (error) {
      log.error(`Error checking trigger word limit for server ${serverId}:`, error);
      return { isValid: false, error: "TRIGGER_WORD_LIMIT_EXCEEDED" };
    }
  }

  /**
   * Check if a tomori has reached its sample dialogue limit.
   *
   * @param personaId - Internal tomori DB ID
   * @returns MemoryValidationResult indicating whether the limit is exceeded
   */
  async checkSampleDialogueLimit(personaId: number): Promise<MemoryValidationResult> {
    const limits = getMemoryLimits();

    try {
      const [tomoriResult] = await sql`
        SELECT
          CASE
            WHEN pp.persona_preset_id IS NOT NULL THEN array_length(pp.preset_sample_dialogues_in, 1)
            ELSE array_length(p.sample_dialogues_in, 1)
          END as dialogue_count
        FROM personas p
        LEFT JOIN persona_presets pp
          ON p.is_pointer = true
          AND pp.preset_lineage_id = p.preset_lineage_id
          AND pp.preset_language = p.preset_language
        WHERE p.persona_id = ${personaId}
      `;

      const currentCount = tomoriResult?.dialogue_count || 0;

      if (currentCount >= limits.maxSampleDialogues) {
        return {
          isValid: false,
          error: "SAMPLE_DIALOGUE_LIMIT_EXCEEDED",
          currentCount,
          maxAllowed: limits.maxSampleDialogues,
        };
      }

      return { isValid: true, currentCount, maxAllowed: limits.maxSampleDialogues };
    } catch (error) {
      log.error(`Error checking sample dialogue limit for tomori ${personaId}:`, error);
      return { isValid: false, error: "SAMPLE_DIALOGUE_LIMIT_EXCEEDED" };
    }
  }

  /**
   * Check if a tomori has reached its attribute limit.
   *
   * @param personaId - Internal tomori DB ID
   * @returns MemoryValidationResult indicating whether the limit is exceeded
   */
  async checkAttributeLimit(personaId: number): Promise<MemoryValidationResult> {
    const limits = getMemoryLimits();

    try {
      const [tomoriResult] = await sql`
        SELECT
          CASE
            WHEN pp.persona_preset_id IS NOT NULL THEN COALESCE(array_length(pp.preset_attribute_list, 1), 0)
            ELSE GREATEST(
              COALESCE((
                SELECT COUNT(*)::INT
                FROM persona_attributes pa
                WHERE pa.persona_id = p.persona_id
              ), 0),
              COALESCE(array_length(p.attribute_list, 1), 0)
            )
          END AS attribute_count
        FROM personas p
        LEFT JOIN persona_presets pp
          ON p.is_pointer = true
          AND pp.preset_lineage_id = p.preset_lineage_id
          AND pp.preset_language = p.preset_language
        WHERE p.persona_id = ${personaId}
      `;

      const currentCount = tomoriResult?.attribute_count || 0;

      if (currentCount >= limits.maxAttributes) {
        return {
          isValid: false,
          error: "ATTRIBUTE_LIMIT_EXCEEDED",
          currentCount,
          maxAllowed: limits.maxAttributes,
        };
      }

      return { isValid: true, currentCount, maxAllowed: limits.maxAttributes };
    } catch (error) {
      log.error(`Error checking attribute limit for tomori ${personaId}:`, error);
      return { isValid: false, error: "ATTRIBUTE_LIMIT_EXCEEDED" };
    }
  }

  /**
   * Exports all personas and their Phase 6 config bundles for a server.
   *
   * @param ownerId - Discord server snowflake
   */
  async toExportShape(ownerId: string | number): Promise<PersonaExportShape | null> {
    const serverDiscId = String(ownerId);
    const serverId = await this.resolveServerInternalId(serverDiscId);
    if (!serverId) return null;

    const tomoriRows = await this.sqlLoadAllTomoriIds(serverId);
    if (!tomoriRows.length) return null;

    const bundles = await Promise.all(
      tomoriRows.map(async (t) => {
        const [contextNote, voice, imagegen, textgen] = await Promise.all([
          this.sqlLoadPersonaContextNoteConfigs(t.persona_id),
          this.sqlLoadPersonaVoiceConfigs(t.persona_id),
          this.sqlLoadPersonaImagegenConfigs(t.persona_id),
          this.sqlLoadPersonaTextgenConfigs(t.persona_id),
        ]);
        return {
          persona_id: t.persona_id,
          persona_nickname: t.persona_nickname,
          persona_lineage_id: t.persona_lineage_id ?? null,
          context_note_configs: contextNote,
          voice_configs: voice,
          imagegen_configs: imagegen,
          textgen_configs: textgen,
        } satisfies PersonaConfigBundle;
      }),
    );

    return { personas: bundles };
  }

  /**
   * Restores persona config table rows for all personas in a server.
   *
   * @param ownerId - Discord server snowflake
   * @param data    - Previously exported PersonaExportShape
   */
  async fromExportShape(ownerId: string | number, data: PersonaExportShape): Promise<boolean> {
    const serverDiscId = String(ownerId);

    try {
      for (const bundle of data.personas) {
        const ops: Promise<void>[] = [];

        if (bundle.context_note_configs) {
          ops.push(this.sqlUpsertPersonaContextNoteConfigs(bundle.context_note_configs));
        }
        if (bundle.voice_configs) {
          ops.push(this.sqlUpsertPersonaVoiceConfigs(bundle.voice_configs));
        }
        if (bundle.imagegen_configs) {
          ops.push(this.sqlUpsertPersonaImagegenConfigs(bundle.imagegen_configs));
        }
        if (bundle.textgen_configs) {
          ops.push(this.sqlUpsertPersonaTextgenConfigs(bundle.textgen_configs));
        }

        await Promise.all(ops);
      }
      return true;
    } catch (error) {
      log.error(`PersonaRepository.fromExportShape: write failed for server ${serverDiscId}:`, error);
      return false;
    }
  }

  private async resolveServerInternalId(serverDiscId: string): Promise<number | null> {
    const [row] = await sql`
      SELECT server_id FROM servers WHERE server_disc_id = ${serverDiscId} LIMIT 1
    `;
    return (row?.server_id as number | undefined) ?? null;
  }

  private async sqlLoadAllTomoriIds(
    serverId: number,
  ): Promise<Array<{ persona_id: number; persona_nickname: string; persona_lineage_id: number | null }>> {
    try {
      const rows = await sql`
        SELECT persona_id, persona_nickname, persona_lineage_id FROM personas WHERE server_id = ${serverId}
      `;
      return rows as unknown as Array<{
        persona_id: number;
        persona_nickname: string;
        persona_lineage_id: number | null;
      }>;
    } catch (error) {
      log.error(`Error loading tomori IDs for server ${serverId}:`, error);
      return [];
    }
  }

  private async sqlLoadPersonaContextNoteConfigs(personaId: number): Promise<PersonaContextNoteConfigsRow | null> {
    try {
      const [row] = await sql`
        SELECT persona_id, context_note, context_note_depth
        FROM persona_context_note_configs WHERE persona_id = ${personaId}
      `;
      return row ? (row as unknown as PersonaContextNoteConfigsRow) : null;
    } catch (error) {
      log.error(`Error loading persona_context_note_configs for tomori ${personaId}:`, error);
      return null;
    }
  }

  private async sqlLoadPersonaVoiceConfigs(personaId: number): Promise<PersonaVoiceConfigsRow | null> {
    try {
      const [row] = await sql`
        SELECT persona_id, speech_voice_sample_id, speech_voice_id, speech_voice_name,
               speech_voice_design_prompt
        FROM persona_voice_configs WHERE persona_id = ${personaId}
      `;
      return row ? (row as unknown as PersonaVoiceConfigsRow) : null;
    } catch (error) {
      log.error(`Error loading persona_voice_configs for tomori ${personaId}:`, error);
      return null;
    }
  }

  private async sqlLoadPersonaImagegenConfigs(personaId: number): Promise<PersonaImagegenConfigsRow | null> {
    try {
      const [row] = await sql`
        SELECT persona_id, physical_appearance_tags, nai_char_ref_url
        FROM persona_imagegen_configs WHERE persona_id = ${personaId}
      `;
      return row ? (row as unknown as PersonaImagegenConfigsRow) : null;
    } catch (error) {
      log.error(`Error loading persona_imagegen_configs for tomori ${personaId}:`, error);
      return null;
    }
  }

  private async sqlLoadPersonaTextgenConfigs(personaId: number): Promise<PersonaTextgenConfigsRow | null> {
    try {
      const [row] = await sql`
        SELECT persona_id, nai_attg_author, nai_attg_title, nai_attg_tags, nai_attg_genre, nai_attg_stars
        FROM persona_textgen_configs WHERE persona_id = ${personaId}
      `;
      return row ? (row as unknown as PersonaTextgenConfigsRow) : null;
    } catch (error) {
      log.error(`Error loading persona_textgen_configs for tomori ${personaId}:`, error);
      return null;
    }
  }

  private async sqlUpsertPersonaContextNoteConfigs(row: PersonaContextNoteConfigsRow): Promise<void> {
    await sql`
      INSERT INTO persona_context_note_configs (persona_id, context_note, context_note_depth)
      VALUES (${row.persona_id}, ${row.context_note}, ${row.context_note_depth})
      ON CONFLICT (persona_id) DO UPDATE SET
        context_note       = EXCLUDED.context_note,
        context_note_depth = EXCLUDED.context_note_depth,
        updated_at         = NOW()
    `;
  }

  private async sqlUpsertPersonaVoiceConfigs(row: PersonaVoiceConfigsRow): Promise<void> {
    await sql`
      INSERT INTO persona_voice_configs (
        persona_id, speech_voice_sample_id, speech_voice_id, speech_voice_name,
        speech_voice_design_prompt
      ) VALUES (
        ${row.persona_id}, ${row.speech_voice_sample_id}, ${row.speech_voice_id},
        ${row.speech_voice_name}, ${row.speech_voice_design_prompt}
      )
      ON CONFLICT (persona_id) DO UPDATE SET
        speech_voice_sample_id    = EXCLUDED.speech_voice_sample_id,
        speech_voice_id           = EXCLUDED.speech_voice_id,
        speech_voice_name         = EXCLUDED.speech_voice_name,
        speech_voice_design_prompt = EXCLUDED.speech_voice_design_prompt,
        updated_at                = NOW()
    `;
  }

  private async sqlUpsertPersonaImagegenConfigs(row: PersonaImagegenConfigsRow): Promise<void> {
    await sql`
      INSERT INTO persona_imagegen_configs (persona_id, physical_appearance_tags, nai_char_ref_url)
      VALUES (${row.persona_id}, ${sql.array(row.physical_appearance_tags, "TEXT")}, ${row.nai_char_ref_url})
      ON CONFLICT (persona_id) DO UPDATE SET
        physical_appearance_tags       = EXCLUDED.physical_appearance_tags,
        nai_char_ref_url = EXCLUDED.nai_char_ref_url,
        updated_at     = NOW()
    `;
  }

  private async sqlUpsertPersonaTextgenConfigs(row: PersonaTextgenConfigsRow): Promise<void> {
    await sql`
      INSERT INTO persona_textgen_configs (
        persona_id, nai_attg_author, nai_attg_title, nai_attg_tags, nai_attg_genre, nai_attg_stars
      ) VALUES (
        ${row.persona_id}, ${row.nai_attg_author}, ${row.nai_attg_title},
        ${row.nai_attg_tags}, ${row.nai_attg_genre}, ${row.nai_attg_stars}
      )
      ON CONFLICT (persona_id) DO UPDATE SET
        nai_attg_author = EXCLUDED.nai_attg_author,
        nai_attg_title  = EXCLUDED.nai_attg_title,
        nai_attg_tags   = EXCLUDED.nai_attg_tags,
        nai_attg_genre  = EXCLUDED.nai_attg_genre,
        nai_attg_stars  = EXCLUDED.nai_attg_stars,
        updated_at      = NOW()
      `;
  }

  /**
   * Converts a Postgres bytea hex-string representation (e.g., "\\xDEADBEEF") to Buffer.
   * Returns null when the input is malformed or cannot be parsed as hex.
   */
  private parseJsonBytea(value: unknown): Buffer | null {
    if (value === null || value === undefined) return null;
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (typeof value !== "string") return null;

    const normalized = value.startsWith("\\x") ? value.slice(2) : value.startsWith("0x") ? value.slice(2) : value;

    if (!/^[0-9a-fA-F]*$/.test(normalized) || normalized.length % 2 !== 0) {
      return null;
    }

    return Buffer.from(normalized, "hex");
  }

  /**
   * Converts SQL NULL to undefined for fields that use Zod .default(), letting
   * defaults fire on a LEFT JOIN miss. Skips fields in MEANINGFULLY_NULLABLE_CONFIG_FIELDS
   * where null encodes "not configured" and must be preserved.
   */
  private coerceNullsForZod(rawRow: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawRow)) {
      result[key] = value === null && !MEANINGFULLY_NULLABLE_CONFIG_FIELDS.has(key) ? undefined : value;
    }
    return result;
  }

  /**
   * Normalizes a flat split-table join row into runtime-compatible types.
   * - Hydrates api_key: Uint8Array (direct DB read) → Buffer; hex string (legacy) → Buffer.
   * - Applies backward-compat autoch_threshold_max backfill for older rows.
   * - Guards timestamps against edge-case string values (Bun SQL normally returns Date).
   */
  private normalizeTomoriConfigFromJson(rawRow: unknown): unknown {
    if (!rawRow || typeof rawRow !== "object" || Array.isArray(rawRow)) {
      return rawRow;
    }

    const row = { ...(rawRow as Record<string, unknown>) };

    // Hydrate api_key: direct DB reads yield Uint8Array or Buffer; legacy JSON path yields hex string.
    const rawKey = row.api_key;
    if (rawKey instanceof Uint8Array && !Buffer.isBuffer(rawKey)) {
      row.api_key = Buffer.from(rawKey);
    } else if (typeof rawKey === "string") {
      row.api_key = this.parseJsonBytea(rawKey);
    }
    // null stays null; Buffer stays Buffer.

    // Backward compat: older rows only stored a single auto-chat threshold.
    const threshold = Number(row.autoch_threshold ?? 0);
    const thresholdMax = Number(row.autoch_threshold_max ?? 0);
    if (Number.isFinite(threshold) && threshold > 0 && thresholdMax <= 0) {
      row.autoch_threshold_max = threshold;
    }

    // Guard timestamps: Bun SQL returns Date for TIMESTAMPTZ, but handle string edge cases.
    for (const key of ["created_at", "updated_at"] as const) {
      const value = row[key];
      if (typeof value === "string" || typeof value === "number") {
        const parsedDate = new Date(value);
        row[key] = Number.isNaN(parsedDate.getTime()) ? undefined : parsedDate;
      }
    }

    return row;
  }

  /**
   * Shared SELECT column list for all split-table config joins.
   * Referenced by both sqlLoadTomoriConfigByServerId and sqlLoadTomoriConfigByTomoriId.
   *
   * Table aliases:
   *   s    = servers
   *   smc  = server_model_configs          (1)
   *   scc  = server_chat_configs           (2)
   *   smpc = server_member_permissions_configs (3)
   *   scaps = server_capabilities_configs  (4)
   *   snec = server_notice_embeds_configs  (5)
   *   snsfw = server_nsfw_configs          (6)
   *   sspeech = server_speech_configs      (7)
   *   satc = server_auto_trigger_configs   (8)
   *   scsc = server_channel_scope_configs  (9)
   *   stbc = server_trigger_behavior_configs (10)
   *   snaic = server_novelai_imagegen_configs (11)
   *   sbyok = server_byok_configs          (12)
   *   smem = server_memory_configs         (13)
   *   swc  = server_welcome_configs        (not in composition schema; kept for backward compat)
   */

  private async sqlLoadTomoriConfigByServerId(serverId: number): Promise<AssembledServerConfig | null> {
    const [rawRow] = await sql`
      SELECT
        s.server_id,
        smc.created_at, smc.updated_at,
        -- 1. server_model_configs
        smc.llm_id, smc.embedding_model_id, smc.diffusion_model_id, smc.video_model_id,
        smc.vision_llm_id, smc.api_key, smc.key_version, smc.llm_temperature,
        smc.thinking_level, smc.llm_disabled_params, smc.custom_endpoint_url,
        smc.custom_model_name, smc.custom_num_ctx, smc.fallback_llm_ids,
        smc.other_model_codename, smc.other_model_capabilities,
        smc.other_model_capabilities_fetched_at, smc.hide_respond_embed,
        -- 2. server_chat_configs
        scc.humanizer_degree, scc.message_fetch_limit, scc.send_message_limit,
        scc.match_limit, scc.cascade_limit, scc.timezone_offset, scc.self_debug_enabled,
        scc.model_randomizer_enabled,
        scc.system_prompt, scc.context_note, scc.context_note_depth,
        scc.llm_stop_strings, scc.llm_stop_speaker_pattern_enabled,
        scc.llm_max_output_tokens, scc.llm_top_p, scc.llm_top_k,
        scc.llm_frequency_penalty, scc.llm_presence_penalty, scc.llm_min_p,
        scc.llm_logit_biases, scc.fallback_model_refs,
        -- 3. server_member_permissions_configs
        smpc.server_memteaching_enabled, smpc.attribute_memteaching_enabled,
        smpc.sampledialogue_memteaching_enabled, smpc.self_teaching_enabled,
        smpc.personal_memories_enabled, smpc.hide_impersonation_embeds,
        smpc.prompt_snapshot_enabled,
        -- 4. server_capabilities_configs
        scaps.emoji_usage_enabled, scaps.sticker_usage_enabled, scaps.web_search_enabled,
        scaps.manage_message_enabled, scaps.thread_creation_enabled, scaps.imagegen_enabled,
        scaps.videogen_enabled, scaps.voice_message_enabled, scaps.user_blocking_enabled,
        scaps.time_awareness_enabled,
        scaps.tool_use_enabled, scaps.verbatim_tool_calling_enabled,
        scaps.short_term_memory_enabled, scaps.user_info_updates_enabled,
        -- 5. server_notice_embeds_configs
        snec.tool_notice_hidden_keys,
        -- 6. server_nsfw_configs
        snsfw.uncensor_injection_enabled, snsfw.uncensor_unicode_space_enabled,
        snsfw.uncensor_sanitize_enabled,
        -- 7. server_speech_configs
        sspeech.voice_transcript_chat_mode, sspeech.chatterbox_turbo_enabled,
        sspeech.chatterbox_cfg_weight, sspeech.chatterbox_exaggeration,
        -- 8. server_auto_trigger_configs (persona overrides aggregated from junction table)
        satc.autoch_disc_ids,
        (
          SELECT COALESCE(
            JSON_AGG(JSON_BUILD_OBJECT('channel_disc_id', o.channel_disc_id, 'persona_id', o.persona_id)),
            '[]'::JSON
          )
          FROM server_auto_trigger_persona_overrides o
          WHERE o.server_id = s.server_id
        ) AS autoch_persona_overrides,
        satc.autoch_threshold, satc.autoch_threshold_max,
        -- 9. server_channel_scope_configs
        scsc.rp_channel_ids, scsc.private_channel_ids, scsc.crosschannel_blocklist_ids,
        scsc.stm_privacy_bypass, scsc.thought_log_channel_disc_id,
        -- 10. server_trigger_behavior_configs
        stbc.always_reply_enabled, stbc.deliberate_trigger_mode,
        stbc.cooldown_type, stbc.cooldown_length,
        stbc.deliberate_tool_mode, stbc.deliberate_tool_context_turns,
        stbc.deliberate_tool_triggers,
        -- 11. server_novelai_imagegen_configs
        snaic.nai_preset_name, snaic.image_default_positive_tags, snaic.image_default_negative_tags,
        snaic.nai_sampler, snaic.nai_steps, snaic.nai_scale,
        snaic.nai_noise_schedule, snaic.nai_cfg_rescale, snaic.nai_diffusion_model_id,
        -- 12. server_byok_configs
        sbyok.user_byok_mode,
        -- 13. server_memory_configs
        smem.memory_tagging_enabled, smem.channel_memory_enabled,
        -- server_welcome_configs (backward compat; not part of the 13-schema composition)
        swc.welcome_channel_disc_id, swc.welcome_prompt, swc.welcome_persona_id
      FROM servers s
      LEFT JOIN server_model_configs smc ON smc.server_id = s.server_id
      LEFT JOIN server_chat_configs scc ON scc.server_id = s.server_id
      LEFT JOIN server_member_permissions_configs smpc ON smpc.server_id = s.server_id
      LEFT JOIN server_capabilities_configs scaps ON scaps.server_id = s.server_id
      LEFT JOIN server_notice_embeds_configs snec ON snec.server_id = s.server_id
      LEFT JOIN server_nsfw_configs snsfw ON snsfw.server_id = s.server_id
      LEFT JOIN server_speech_configs sspeech ON sspeech.server_id = s.server_id
      LEFT JOIN server_auto_trigger_configs satc ON satc.server_id = s.server_id
      LEFT JOIN server_channel_scope_configs scsc ON scsc.server_id = s.server_id
      LEFT JOIN server_trigger_behavior_configs stbc ON stbc.server_id = s.server_id
      LEFT JOIN server_novelai_imagegen_configs snaic ON snaic.server_id = s.server_id
      LEFT JOIN server_byok_configs sbyok ON sbyok.server_id = s.server_id
      LEFT JOIN server_memory_configs smem ON smem.server_id = s.server_id
      LEFT JOIN server_welcome_configs swc ON swc.server_id = s.server_id
      WHERE s.server_id = ${serverId}
    `;

    if (!rawRow) return null;

    const coerced = this.coerceNullsForZod(rawRow as Record<string, unknown>);
    const normalized = this.normalizeTomoriConfigFromJson(coerced);
    const parsedConfig = assembledServerConfigSchema.safeParse(normalized);
    if (!parsedConfig.success) {
      log.error(`Invalid server-scoped tomori config for server_id ${serverId}:`, parsedConfig.error.flatten());
      return null;
    }

    return parsedConfig.data;
  }

  /**
   * Loads config anchored on a persona_id by joining through personas → servers across split tables.
   * tomori_configs was dropped in Task F2 (migration 008); this method now reads exclusively from the 13 split tables.
   */
  private async sqlLoadTomoriConfigByTomoriId(personaId: number): Promise<AssembledServerConfig | null> {
    const [rawRow] = await sql`
      SELECT
        s.server_id,
        smc.created_at, smc.updated_at,
        -- 1. server_model_configs
        smc.llm_id, smc.embedding_model_id, smc.diffusion_model_id, smc.video_model_id,
        smc.vision_llm_id, smc.api_key, smc.key_version, smc.llm_temperature,
        smc.thinking_level, smc.llm_disabled_params, smc.custom_endpoint_url,
        smc.custom_model_name, smc.custom_num_ctx, smc.fallback_llm_ids,
        smc.other_model_codename, smc.other_model_capabilities,
        smc.other_model_capabilities_fetched_at, smc.hide_respond_embed,
        -- 2. server_chat_configs
        scc.humanizer_degree, scc.message_fetch_limit, scc.send_message_limit,
        scc.match_limit, scc.cascade_limit, scc.timezone_offset, scc.self_debug_enabled,
        scc.model_randomizer_enabled,
        scc.system_prompt, scc.context_note, scc.context_note_depth,
        scc.llm_stop_strings, scc.llm_stop_speaker_pattern_enabled,
        scc.llm_max_output_tokens, scc.llm_top_p, scc.llm_top_k,
        scc.llm_frequency_penalty, scc.llm_presence_penalty, scc.llm_min_p,
        scc.llm_logit_biases, scc.fallback_model_refs,
        -- 3. server_member_permissions_configs
        smpc.server_memteaching_enabled, smpc.attribute_memteaching_enabled,
        smpc.sampledialogue_memteaching_enabled, smpc.self_teaching_enabled,
        smpc.personal_memories_enabled, smpc.hide_impersonation_embeds,
        smpc.prompt_snapshot_enabled,
        -- 4. server_capabilities_configs
        scaps.emoji_usage_enabled, scaps.sticker_usage_enabled, scaps.web_search_enabled,
        scaps.manage_message_enabled, scaps.thread_creation_enabled, scaps.imagegen_enabled,
        scaps.videogen_enabled, scaps.voice_message_enabled, scaps.user_blocking_enabled,
        scaps.time_awareness_enabled,
        scaps.tool_use_enabled, scaps.verbatim_tool_calling_enabled,
        scaps.short_term_memory_enabled, scaps.user_info_updates_enabled,
        -- 5. server_notice_embeds_configs
        snec.tool_notice_hidden_keys,
        -- 6. server_nsfw_configs
        snsfw.uncensor_injection_enabled, snsfw.uncensor_unicode_space_enabled,
        snsfw.uncensor_sanitize_enabled,
        -- 7. server_speech_configs
        sspeech.voice_transcript_chat_mode, sspeech.chatterbox_turbo_enabled,
        sspeech.chatterbox_cfg_weight, sspeech.chatterbox_exaggeration,
        -- 8. server_auto_trigger_configs (persona overrides aggregated from junction table)
        satc.autoch_disc_ids,
        (
          SELECT COALESCE(
            JSON_AGG(JSON_BUILD_OBJECT('channel_disc_id', o.channel_disc_id, 'persona_id', o.persona_id)),
            '[]'::JSON
          )
          FROM server_auto_trigger_persona_overrides o
          WHERE o.server_id = s.server_id
        ) AS autoch_persona_overrides,
        satc.autoch_threshold, satc.autoch_threshold_max,
        -- 9. server_channel_scope_configs
        scsc.rp_channel_ids, scsc.private_channel_ids, scsc.crosschannel_blocklist_ids,
        scsc.stm_privacy_bypass, scsc.thought_log_channel_disc_id,
        -- 10. server_trigger_behavior_configs
        stbc.always_reply_enabled, stbc.deliberate_trigger_mode,
        stbc.cooldown_type, stbc.cooldown_length,
        stbc.deliberate_tool_mode, stbc.deliberate_tool_context_turns,
        stbc.deliberate_tool_triggers,
        -- 11. server_novelai_imagegen_configs
        snaic.nai_preset_name, snaic.image_default_positive_tags, snaic.image_default_negative_tags,
        snaic.nai_sampler, snaic.nai_steps, snaic.nai_scale,
        snaic.nai_noise_schedule, snaic.nai_cfg_rescale, snaic.nai_diffusion_model_id,
        -- 12. server_byok_configs
        sbyok.user_byok_mode,
        -- 13. server_memory_configs
        smem.memory_tagging_enabled, smem.channel_memory_enabled,
        -- server_welcome_configs (backward compat; not part of the 13-schema composition)
        swc.welcome_channel_disc_id, swc.welcome_prompt, swc.welcome_persona_id
      FROM personas t
      JOIN servers s ON s.server_id = t.server_id
      LEFT JOIN server_model_configs smc ON smc.server_id = s.server_id
      LEFT JOIN server_chat_configs scc ON scc.server_id = s.server_id
      LEFT JOIN server_member_permissions_configs smpc ON smpc.server_id = s.server_id
      LEFT JOIN server_capabilities_configs scaps ON scaps.server_id = s.server_id
      LEFT JOIN server_notice_embeds_configs snec ON snec.server_id = s.server_id
      LEFT JOIN server_nsfw_configs snsfw ON snsfw.server_id = s.server_id
      LEFT JOIN server_speech_configs sspeech ON sspeech.server_id = s.server_id
      LEFT JOIN server_auto_trigger_configs satc ON satc.server_id = s.server_id
      LEFT JOIN server_channel_scope_configs scsc ON scsc.server_id = s.server_id
      LEFT JOIN server_trigger_behavior_configs stbc ON stbc.server_id = s.server_id
      LEFT JOIN server_novelai_imagegen_configs snaic ON snaic.server_id = s.server_id
      LEFT JOIN server_byok_configs sbyok ON sbyok.server_id = s.server_id
      LEFT JOIN server_memory_configs smem ON smem.server_id = s.server_id
      LEFT JOIN server_welcome_configs swc ON swc.server_id = s.server_id
      WHERE t.persona_id = ${personaId}
      LIMIT 1
    `;

    if (!rawRow) return null;

    const coerced = this.coerceNullsForZod(rawRow as Record<string, unknown>);
    const normalized = this.normalizeTomoriConfigFromJson(coerced);
    const parsedConfig = assembledServerConfigSchema.safeParse(normalized);
    if (!parsedConfig.success) {
      log.error(`Invalid legacy tomori config for persona_id ${personaId}:`, parsedConfig.error.flatten());
      return null;
    }

    return parsedConfig.data;
  }

  async materializeIfPointer(personaId: number): Promise<boolean> {
    try {
      return await sql.transaction((tx) => this.materializeIfPointerWithClient(personaId, tx));
    } catch (error) {
      log.error(`Error materializing preset pointer persona ${personaId}:`, error);
      return false;
    }
  }

  async updateNamingConfig(personaId: number, config: PersonaNamingConfig): Promise<boolean> {
    try {
      return await sql.transaction(async (tx) => {
        const materialized = await this.materializeIfPointerWithClient(personaId, tx);
        if (!materialized) return false;
        await userNamingRepository.savePersonaConfig(personaId, config, tx);
        return true;
      });
    } catch (error) {
      log.error(`Error updating naming config for persona ${personaId}:`, error);
      return false;
    }
  }

  private async materializeIfPointerWithClient(personaId: number, client: SQL): Promise<boolean> {
    const [personaRow] = await client<
      Array<{
        persona_id: number;
        is_pointer: boolean | null;
        preset_lineage_id: number | string | bigint | null;
        preset_language: string | null;
      }>
    >`
      SELECT persona_id, is_pointer, preset_lineage_id, preset_language
      FROM personas
      WHERE persona_id = ${personaId}
      FOR UPDATE
    `;

    if (!personaRow) {
      return false;
    }

    if (personaRow.is_pointer !== true) {
      return true;
    }

    const pointerLineageId = normalizeLineageId(personaRow.preset_lineage_id);
    const pointerLanguage = personaRow.preset_language;
    if (pointerLineageId === null || !pointerLanguage) {
      log.error(`Pointer persona ${personaId} is missing preset lineage/language.`);
      return false;
    }

    const preset = await this.loadPresetForPointer(client, pointerLineageId, pointerLanguage);
    if (!preset) {
      log.error(
        `Pointer persona ${personaId} references missing preset lineage=${pointerLineageId} language=${pointerLanguage}.`,
      );
      return false;
    }

    await client`
      UPDATE personas
      SET
        attribute_list = ${sql.array(preset.preset_attribute_list, "TEXT")},
        sample_dialogues_in = ${sql.array(preset.preset_sample_dialogues_in, "TEXT")},
        sample_dialogues_out = ${sql.array(preset.preset_sample_dialogues_out, "TEXT")},
        is_pointer = false,
        updated_at = NOW()
      WHERE persona_id = ${personaId}
    `;
    await this.replacePresetAttributesWithClient(client, personaId, preset);
    await this.writePresetPersonaConfigWithClient(
      client,
      personaId,
      resolvePresetTriggerWords(preset),
      resolvePresetPersonaPrompt(preset),
    );
    await userNamingRepository.savePersonaConfig(personaId, preset.preset_naming_config, client);
    // Copy the shared preset sprites into this persona's own rows, reusing the
    // shared image URL (no byte duplication). The persona stops resolving sprites
    // live once materialized, so this freezes its current default sprite set.
    await this.copyPresetSpritesWithClient(client, personaId, pointerLineageId, pointerLanguage);
    // Freeze the alter avatar by reference too: a pointer alter live-resolves the
    // shared preset avatar, so once it materializes it must keep that exact
    // reference (still the immutable presets/ URL: no byte duplication, and the
    // delete guard still protects it). Mains deliver via the guild avatar, so
    // only fill this for alters that have no avatar of their own.
    if (preset.preset_avatar_shared_url) {
      await client`
        UPDATE personas
        SET webhook_avatar_url = ${preset.preset_avatar_shared_url}
        WHERE persona_id = ${personaId}
          AND is_alter = true
          AND webhook_avatar_url IS NULL
      `;
    }

    return true;
  }

  /**
   * Copies a preset's shared sprites into `persona_sprites` for a persona being
   * materialized. The `avatar_url` is the shared `presets/` reference, so the
   * per-persona delete guard later refuses to delete it (other servers rely on it).
   * Existing keys are left untouched (a re-materialization is a no-op).
   */
  private async copyPresetSpritesWithClient(
    client: SQL,
    personaId: number,
    presetLineageId: number,
    presetLanguage: string,
  ): Promise<void> {
    await client`
      INSERT INTO persona_sprites (persona_id, sprite_name, sprite_key, avatar_url, usage_instructions, is_identity)
      SELECT ${personaId}, sprite_name, sprite_key, avatar_url, usage_instructions, is_identity
      FROM preset_sprites
      WHERE preset_lineage_id = ${presetLineageId}
        AND preset_language = ${presetLanguage}
      ON CONFLICT (persona_id, sprite_key) DO NOTHING
    `;
  }

  private async loadPresetForPointer(
    client: SQL,
    presetLineageId: number,
    presetLanguage: string,
  ): Promise<TomoriPresetRow | null> {
    const [preset] = await client<TomoriPresetRow[]>`
      SELECT *
      FROM persona_presets
      WHERE preset_lineage_id = ${presetLineageId}
        AND preset_language = ${presetLanguage}
      LIMIT 1
    `;

    return preset ?? null;
  }

  private async loadPointerPresetsForRows(rows: TomoriRow[]): Promise<Map<number, TomoriPresetRow>> {
    const pointerRefs = rows
      .map((row) => {
        const personaId = row.persona_id;
        const lineageId = normalizeLineageId(row.preset_lineage_id);
        const language = row.preset_language;
        if (row.is_pointer !== true || typeof personaId !== "number" || lineageId === null || !language) {
          return null;
        }
        return { personaId, lineageId, language };
      })
      .filter((row): row is { personaId: number; lineageId: number; language: string } => row !== null);

    if (pointerRefs.length === 0) {
      return new Map();
    }

    const lineageIds = [...new Set(pointerRefs.map((row) => row.lineageId))];
    const languages = [...new Set(pointerRefs.map((row) => row.language))];
    const presetRows = await sql<TomoriPresetRow[]>`
      SELECT *
      FROM persona_presets
      WHERE preset_lineage_id = ANY(${sql.array(lineageIds, "int8")})
        AND preset_language = ANY(${sql.array(languages, "TEXT")})
    `;

    const presetsByPointerKey = new Map<string, TomoriPresetRow>();
    for (const preset of presetRows) {
      const lineageId = normalizeLineageId(preset.preset_lineage_id);
      if (lineageId === null) {
        continue;
      }
      presetsByPointerKey.set(presetPointerKey(lineageId, preset.preset_language), preset);
    }

    const presetsByPersonaId = new Map<number, TomoriPresetRow>();
    for (const ref of pointerRefs) {
      const preset = presetsByPointerKey.get(presetPointerKey(ref.lineageId, ref.language));
      if (preset) {
        presetsByPersonaId.set(ref.personaId, preset);
      } else {
        log.warn(
          `Pointer persona ${ref.personaId} references missing preset lineage=${ref.lineageId} language=${ref.language}.`,
        );
      }
    }

    return presetsByPersonaId;
  }

  /**
   * Resolves a persona's effective webhook avatar reference for the cached state.
   *
   * An unforked pointer ALTER with no avatar of its own live-resolves the shared
   * preset avatar (`preset_avatar_shared_url`), so catalog avatar edits fan out
   * to it on the next reseed; exactly like preset sprites/triggers/prompt. The
   * resolution happens once at load time, so every downstream avatar consumer
   * reads it from the cache with no hot-path query, and the existing pointer
   * cache invalidation refreshes it after a seed update. Main personas deliver
   * via the bot's guild member avatar, so their stored reference is untouched
   * here (the main-avatar fan-out reconciler owns that channel).
   *
   * @param row - The raw persona row
   * @param pointerPreset - The live preset backing this row, or undefined when forked
   * @returns The avatar reference to store on the cached state
   */
  private resolvePointerAlterAvatarUrl(
    row: TomoriRow,
    pointerPreset: TomoriPresetRow | undefined,
  ): string | null | undefined {
    if (pointerPreset && row.is_alter === true && !row.webhook_avatar_url && pointerPreset.preset_avatar_shared_url) {
      return pointerPreset.preset_avatar_shared_url;
    }
    return row.webhook_avatar_url;
  }

  private buildPresetAttributeRows(personaId: number, preset: TomoriPresetRow): PersonaAttributeRow[] {
    const publicFlags = normalizeAttributePublicFlags(
      preset.preset_attribute_list,
      preset.preset_attribute_public_flags,
    );

    return preset.preset_attribute_list.map((attribute, index) => ({
      persona_id: personaId,
      attribute_order: index + 1,
      attribute_text: attribute,
      is_public: publicFlags[index] ?? false,
    }));
  }

  private async loadPersonaAttributeRows(personaId: number): Promise<PersonaAttributeRow[]> {
    const rows = await sql<
      Array<{
        attribute_id: number;
        persona_id: number;
        attribute_order: number;
        attribute_text: string;
        is_public: boolean | null;
        created_at: Date | undefined;
        updated_at: Date | undefined;
      }>
    >`
      SELECT attribute_id, persona_id, attribute_order, attribute_text, is_public, created_at, updated_at
      FROM persona_attributes
      WHERE persona_id = ${personaId}
      ORDER BY attribute_order
    `;

    return rows.map((row) => ({
      attribute_id: row.attribute_id as number,
      persona_id: row.persona_id as number,
      attribute_order: row.attribute_order as number,
      attribute_text: row.attribute_text as string,
      is_public: (row.is_public as boolean) ?? false,
      created_at: row.created_at as Date | undefined,
      updated_at: row.updated_at as Date | undefined,
    }));
  }

  private async replacePresetAttributesWithClient(
    client: SQL,
    personaId: number,
    preset: TomoriPresetRow,
  ): Promise<void> {
    const publicFlags = normalizeAttributePublicFlags(
      preset.preset_attribute_list,
      preset.preset_attribute_public_flags,
    );

    await client`DELETE FROM persona_attributes WHERE persona_id = ${personaId}`;
    for (let index = 0; index < preset.preset_attribute_list.length; index++) {
      await client`
        INSERT INTO persona_attributes (persona_id, attribute_order, attribute_text, is_public)
        VALUES (${personaId}, ${index + 1}, ${preset.preset_attribute_list[index]}, ${publicFlags[index]})
      `;
    }
  }

  private async writePresetPersonaConfigWithClient(
    client: SQL,
    personaId: number,
    triggerWords: string[],
    personaPrompt: string | null,
  ): Promise<void> {
    const normalizedTriggers = dedupeTriggerWords(triggerWords, { lowercase: false });
    await client`
      INSERT INTO persona_configs (persona_id, trigger_words, persona_prompt)
      VALUES (${personaId}, ${sql.array(normalizedTriggers, "TEXT")}, ${personaPrompt})
      ON CONFLICT (persona_id) DO UPDATE
      SET
        trigger_words = EXCLUDED.trigger_words,
        persona_prompt = EXCLUDED.persona_prompt,
        updated_at = NOW()
    `;
  }

  private withPersonaSplitConfigFields(row: Record<string, unknown>): TomoriRow & PersonaScopedConfigFields {
    return {
      ...row,
      context_note: (row.split_context_note as string | null | undefined) ?? null,
      context_note_depth: (row.split_context_note_depth as number | null | undefined) ?? 0,
      speech_voice_sample_id: (row.split_speech_voice_sample_id as number | null | undefined) ?? null,
      speech_voice_id: (row.split_speech_voice_id as string | null | undefined) ?? null,
      speech_voice_name: (row.split_speech_voice_name as string | null | undefined) ?? null,
      speech_voice_design_prompt: (row.split_speech_voice_design_prompt as string | null | undefined) ?? null,
      physical_appearance_tags: Array.isArray(row.split_physical_appearance_tags)
        ? (row.split_physical_appearance_tags as string[])
        : [],
      nai_char_ref_url: (row.split_nai_char_ref_url as string | null | undefined) ?? null,
      nai_attg_author: (row.split_nai_attg_author as string | null | undefined) ?? null,
      nai_attg_title: (row.split_nai_attg_title as string | null | undefined) ?? null,
      nai_attg_tags: (row.split_nai_attg_tags as string | null | undefined) ?? null,
      nai_attg_genre: (row.split_nai_attg_genre as string | null | undefined) ?? null,
      nai_attg_stars: (row.split_nai_attg_stars as number | null | undefined) ?? null,
    } as TomoriRow & PersonaScopedConfigFields;
  }

  private async loadTomoriState(serverDiscId: string): Promise<TomoriState | null> {
    try {
      const tomoriRows = await sql`
        SELECT
          t.*,
          pcnc.context_note AS split_context_note,
          pcnc.context_note_depth AS split_context_note_depth,
          pvc.speech_voice_sample_id AS split_speech_voice_sample_id,
          pvc.speech_voice_id AS split_speech_voice_id,
          pvc.speech_voice_name AS split_speech_voice_name,
          pvc.speech_voice_design_prompt AS split_speech_voice_design_prompt,
          pic.physical_appearance_tags AS split_physical_appearance_tags,
          pic.nai_char_ref_url AS split_nai_char_ref_url,
          ptc.nai_attg_author AS split_nai_attg_author,
          ptc.nai_attg_title AS split_nai_attg_title,
          ptc.nai_attg_tags AS split_nai_attg_tags,
          ptc.nai_attg_genre AS split_nai_attg_genre,
          ptc.nai_attg_stars AS split_nai_attg_stars
        FROM personas t
        JOIN servers s ON t.server_id = s.server_id
        LEFT JOIN persona_context_note_configs pcnc ON pcnc.persona_id = t.persona_id
        LEFT JOIN persona_voice_configs pvc ON pvc.persona_id = t.persona_id
        LEFT JOIN persona_imagegen_configs pic ON pic.persona_id = t.persona_id
        LEFT JOIN persona_textgen_configs ptc ON ptc.persona_id = t.persona_id
        WHERE s.server_disc_id = ${serverDiscId}
        ORDER BY t.is_alter ASC, t.updated_at DESC NULLS LAST, t.persona_id DESC
        LIMIT 1
      `;

      if (!tomoriRows.length) {
        log.warn(`No Tomori instance found for server ${serverDiscId}`);
        return null;
      }
      const tomoriData = this.withPersonaSplitConfigFields(tomoriRows[0] as Record<string, unknown>);

      // Load associated config using server_id (server-scoped config)
      // biome-ignore lint/style/noNonNullAssertion: Row existence checked above, ID is guaranteed by DB schema.
      const personaId = tomoriData.persona_id!;
      const serverId = tomoriData.server_id;
      const pointerPresetsByPersonaId = await this.loadPointerPresetsForRows([tomoriData]);
      const pointerPreset = pointerPresetsByPersonaId.get(personaId);
      const personaNamingConfigs = await userNamingRepository.loadPersonaConfigs([personaId]);
      let configData = await this.sqlLoadTomoriConfigByServerId(serverId);

      // Backward compatibility: fall back to persona_id if server_id config missing
      if (!configData) {
        log.warn(`No server-scoped config found for server ${serverDiscId}; falling back to persona_id ${personaId}`);
        configData = await this.sqlLoadTomoriConfigByTomoriId(personaId);
      }

      if (!configData) {
        log.error(`Found Tomori (${personaId}) but no config for server ${serverDiscId}`);
        return null;
      }

      // Load LLM data using the llm_id from the config (with cache fallback).
      // BYOK-only servers may intentionally leave llm_id NULL until a personal provider is overlaid.
      let llmData: LlmRow;
      if (!configData.llm_id) {
        llmData = getUnconfiguredLlm();
      } else {
        const cachedLlm = getCachedLLM(configData.llm_id);

        // Fallback to database if cache miss (cache not initialized or LLM not found)
        if (!cachedLlm) {
          log.info(`Cache miss for LLM ID ${configData.llm_id}, querying database`);
          const llmRows = await sql`
            SELECT * FROM llms
            WHERE llm_id = ${configData.llm_id}
            LIMIT 1
          `;

          if (!llmRows.length) {
            log.error(`Found Tomori config but no LLM data for server ${serverDiscId}, llm_id: ${configData.llm_id}`);
            return null;
          }
          llmData = llmRows[0] as LlmRow;
        } else {
          llmData = cachedLlm as LlmRow;
        }
      }

      const personaConfigRows = await sql`
        SELECT *
        FROM persona_configs
        WHERE persona_id = ${personaId}
        LIMIT 1
      `;
      let personaConfig: PersonaConfigRow | null = null;
      if (personaConfigRows.length > 0) {
        const parsedPersonaConfig = personaConfigSchema.safeParse(personaConfigRows[0]);
        if (parsedPersonaConfig.success) {
          personaConfig = parsedPersonaConfig.data;
        } else {
          log.warn(`Invalid persona config row for tomori ${personaId}:`, parsedPersonaConfig.error.flatten());
        }
      }

      const rawLineageId = tomoriData.persona_lineage_id;
      const parsedPersonaLineageId =
        typeof rawLineageId === "bigint"
          ? Number(rawLineageId)
          : typeof rawLineageId === "string"
            ? Number(rawLineageId)
            : (rawLineageId ?? 0);
      const personaLineageId = Number.isFinite(parsedPersonaLineageId) ? parsedPersonaLineageId : 0;
      const serverMemoriesRows = await sql`
        SELECT content
        FROM server_memories
        WHERE server_id = ${tomoriData.server_id}
          AND persona_lineage_id = ${personaLineageId}
        ORDER BY created_at DESC
      `;

      // Extract memory content strings into an array
      const serverMemories = serverMemoriesRows.map((row: { content: string }) => row.content);

      // Load autochat runtime counters for this persona (default to 0 if row not yet created).
      const autochRuntimeRows = await sql`
        SELECT autoch_counter, autoch_next_target
        FROM persona_autoch_runtime_state
        WHERE persona_id = ${personaId}
        LIMIT 1
      `;
      const autochRuntime: Pick<PersonaAutochRuntimeStateRow, "autoch_counter" | "autoch_next_target"> =
        autochRuntimeRows.length > 0
          ? {
              autoch_counter: (autochRuntimeRows[0].autoch_counter as number) ?? 0,
              autoch_next_target: (autochRuntimeRows[0].autoch_next_target as number) ?? 0,
            }
          : { autoch_counter: 0, autoch_next_target: 0 };

      // Load API key rotation pool for this server (if any)
      const rotationKeysRows = await sql`
        SELECT
          akr.rotation_key_id, akr.server_id, akr.provider, akr.api_key, akr.key_version,
          akr.is_main_key_pointer, akr.is_enabled, akr.created_at, akr.updated_at,
          COALESCE(rs.usage_count, 0) AS usage_count,
          COALESCE(rs.error_count, 0) AS error_count,
          rs.last_used_at, rs.last_error_at, rs.last_error_type, rs.last_error_message
        FROM api_key_rotation akr
        LEFT JOIN api_key_rotation_runtime_state rs USING (rotation_key_id)
        WHERE akr.server_id = ${tomoriData.server_id}
          AND akr.provider = ${llmData.llm_provider.toLowerCase()}
        ORDER BY COALESCE(rs.usage_count, 0) ASC, akr.rotation_key_id ASC
      `;

      const rotationKeys: ApiKeyRotationRow[] = [];
      for (const row of rotationKeysRows) {
        const parsed = apiKeyRotationSchema.safeParse(row);
        if (parsed.success) {
          rotationKeys.push(parsed.data);
        } else {
          const errorDetails = JSON.stringify(parsed.error.flatten(), null, 2);
          log.warn(`Invalid rotation key row for server ${serverDiscId}:\n${errorDetails}`);
        }
      }

      let naiPreset: NaiPresetRow | undefined;
      const presetName = configData.nai_preset_name;
      if (presetName) {
        const presetRows = await sql`
          SELECT * FROM nai_presets
          WHERE preset_name = ${presetName}
          LIMIT 1
        `;
        if (presetRows.length > 0) {
          const parsedPreset = naiPresetSchema.safeParse(presetRows[0]);
          if (parsedPreset.success) {
            naiPreset = parsedPreset.data;
          } else {
            log.warn(`Invalid nai_preset row for preset "${presetName}":`, parsedPreset.error.flatten());
          }
        }
      }

      // Resolve fallback model chain: prefer fallback_model_refs (new), fall back to fallback_llm_ids (legacy)
      const rawFallbackIds = configData.fallback_llm_ids;
      const fallbackLlmIds = configData.fallback_llm_ids;
      const fallbackLlms = fallbackLlmIds.length > 0 ? await llmModelRepo.getLlmsByIds(fallbackLlmIds) : [];
      if (PersonaRepository.FALLBACK_DEBUG_ENABLED) {
        log.info(
          `[FallbackDebug][loadTomoriState] server_disc_id=${serverDiscId} server_id=${serverId} raw_fallback_ids=${JSON.stringify(rawFallbackIds)} parsed_fallback_ids=[${fallbackLlmIds.join(", ")}] resolved_fallbacks=[${fallbackLlms.map((llm) => `${llm.llm_id}:${llm.llm_codename}`).join(", ")}]`,
        );
      }

      // Build typed fallback_chain from fallback_model_refs (supports both llm and custom_endpoint refs)
      const modelRefs = configData.fallback_model_refs ?? [];
      let fallbackChain: FallbackEntry[] | undefined;
      if (modelRefs.length > 0) {
        const llmRefIds = modelRefs
          .filter((r: FallbackModelRef) => r.type === "llm")
          .map((r: FallbackModelRef) => r.id);
        const epRefIds = modelRefs
          .filter((r: FallbackModelRef) => r.type === "custom_endpoint")
          .map((r: FallbackModelRef) => r.id);
        const [refLlms, refEndpoints] = await Promise.all([
          llmRefIds.length > 0 ? llmModelRepo.getLlmsByIds(llmRefIds) : Promise.resolve([]),
          epRefIds.length > 0 ? llmProviderRepo.loadCustomEndpointsByIds(epRefIds) : Promise.resolve([]),
        ]);
        const llmMap = new Map(refLlms.map((m) => [m.llm_id as number, m]));
        const epMap = new Map(refEndpoints.map((e) => [e.custom_endpoint_id as number, e]));
        const resolved = modelRefs
          .map((ref: FallbackModelRef) => {
            if (ref.type === "llm") {
              const model = llmMap.get(ref.id);
              return model ? ({ kind: "llm", model } as FallbackEntry) : null;
            }
            const endpoint = epMap.get(ref.id);
            return endpoint ? ({ kind: "custom_endpoint", endpoint } as FallbackEntry) : null;
          })
          .filter((e): e is FallbackEntry => e !== null);
        if (resolved.length > 0) fallbackChain = resolved;
      }

      // Load vision model if configured (for non-vision chat model image analysis delegation)
      let visionLlm: LlmRow | undefined;
      if (configData.vision_llm_id) {
        visionLlm = getCachedLLM(configData.vision_llm_id) as LlmRow | undefined;
        if (!visionLlm) {
          const visionLlmRows = await sql`
            SELECT * FROM llms WHERE llm_id = ${configData.vision_llm_id} LIMIT 1
          `;
          if (visionLlmRows.length) {
            visionLlm = visionLlmRows[0] as LlmRow;
          }
        }
      }

      const personaAttributes = pointerPreset
        ? this.buildPresetAttributeRows(personaId, pointerPreset)
        : await this.loadPersonaAttributeRows(personaId);
      const attributeList = pointerPreset
        ? pointerPreset.preset_attribute_list
        : personaAttributes.length > 0
          ? personaAttributes.map((attribute) => attribute.attribute_text)
          : ((tomoriData.attribute_list as string[] | undefined) ?? []);
      const sampleDialoguesIn = pointerPreset
        ? pointerPreset.preset_sample_dialogues_in
        : ((tomoriData.sample_dialogues_in as string[] | undefined) ?? []);
      const sampleDialoguesOut = pointerPreset
        ? pointerPreset.preset_sample_dialogues_out
        : ((tomoriData.sample_dialogues_out as string[] | undefined) ?? []);
      const triggerWords = pointerPreset
        ? resolvePresetTriggerWords(pointerPreset)
        : (personaConfig?.trigger_words ?? []);
      const personaPrompt = pointerPreset
        ? resolvePresetPersonaPrompt(pointerPreset)
        : (personaConfig?.persona_prompt ?? null);
      const namingConfig = pointerPreset
        ? pointerPreset.preset_naming_config
        : (personaNamingConfigs.get(personaId) ?? EMPTY_PERSONA_NAMING_CONFIG);

      // Per-persona humanizer override: overlay onto a copy of the server config at
      // load time so every runtime consumer of config.humanizer_degree (providers,
      // stream buffer, context templates) sees the persona-scoped value unchanged.
      const humanizerOverride = personaConfig?.humanizer_degree ?? null;

      // Combine and validate the full state
      const combinedState = {
        ...tomoriData,
        // Pointer alters live-resolve the shared preset avatar (see helper).
        webhook_avatar_url: this.resolvePointerAlterAvatarUrl(tomoriData, pointerPreset),
        attribute_list: attributeList,
        sample_dialogues_in: sampleDialoguesIn,
        sample_dialogues_out: sampleDialoguesOut,
        persona_attributes: personaAttributes,
        config: humanizerOverride !== null ? { ...configData, humanizer_degree: humanizerOverride } : configData,
        llm: llmData,
        trigger_words: triggerWords,
        persona_prompt: personaPrompt,
        naming_config: namingConfig,
        reward_conditioning_enabled: personaConfig?.reward_conditioning_enabled ?? true,
        punish_conditioning_enabled: personaConfig?.punish_conditioning_enabled ?? true,
        humanizer_degree_override: humanizerOverride,
        ...autochRuntime,
        server_memories: serverMemories,
        rotation_keys: rotationKeys.length > 0 ? rotationKeys : undefined,
        vision_llm: visionLlm,
        nai_preset: naiPreset,
        fallback_llms: fallbackLlms.length > 0 ? fallbackLlms : undefined,
        fallback_chain: fallbackChain,
      };

      const parsedState = tomoriStateSchema.safeParse(combinedState);

      if (!parsedState.success) {
        log.error(`Failed to validate combined Tomori state for server ${serverDiscId}:`, parsedState.error.flatten());
        return null;
      }

      return parsedState.data;
    } catch (error) {
      log.error(`Error loading tomori state for server ${serverDiscId}:`, error);
      return null;
    }
  }

  private async loadAllPersonasForServer(serverDiscId: string): Promise<TomoriState[]> {
    try {
      return await withTransientDbRetry(async () => {
        // Load all Tomori persona rows for this server (main first, then alters)
        const tomoriRows = await sql`
            SELECT
              t.*,
              pcnc.context_note AS split_context_note,
              pcnc.context_note_depth AS split_context_note_depth,
              pvc.speech_voice_sample_id AS split_speech_voice_sample_id,
              pvc.speech_voice_id AS split_speech_voice_id,
              pvc.speech_voice_name AS split_speech_voice_name,
              pvc.speech_voice_design_prompt AS split_speech_voice_design_prompt,
              pic.physical_appearance_tags AS split_physical_appearance_tags,
              pic.nai_char_ref_url AS split_nai_char_ref_url,
              ptc.nai_attg_author AS split_nai_attg_author,
              ptc.nai_attg_title AS split_nai_attg_title,
              ptc.nai_attg_tags AS split_nai_attg_tags,
              ptc.nai_attg_genre AS split_nai_attg_genre,
              ptc.nai_attg_stars AS split_nai_attg_stars
            FROM personas t
            JOIN servers s ON t.server_id = s.server_id
            LEFT JOIN persona_context_note_configs pcnc ON pcnc.persona_id = t.persona_id
            LEFT JOIN persona_voice_configs pvc ON pvc.persona_id = t.persona_id
            LEFT JOIN persona_imagegen_configs pic ON pic.persona_id = t.persona_id
            LEFT JOIN persona_textgen_configs ptc ON ptc.persona_id = t.persona_id
            WHERE s.server_disc_id = ${serverDiscId}
            ORDER BY t.is_alter ASC, t.updated_at DESC NULLS LAST, t.persona_id DESC
          `;

        if (!tomoriRows.length) {
          log.warn(`No personas found for server ${serverDiscId}`);
          return [];
        }

        const typedTomoriRows: Array<TomoriRow & PersonaScopedConfigFields> = tomoriRows.map((row: unknown) =>
          this.withPersonaSplitConfigFields(row as Record<string, unknown>),
        );
        const serverId = typedTomoriRows[0].server_id;
        const pointerPresetsByPersonaId = await this.loadPointerPresetsForRows(typedTomoriRows);
        const personaNamingConfigs = await userNamingRepository.loadPersonaConfigs(
          typedTomoriRows.flatMap((row) => (typeof row.persona_id === "number" ? [row.persona_id] : [])),
        );

        // Load server-scoped config once (fallback to main persona config)
        let configData = await this.sqlLoadTomoriConfigByServerId(serverId);

        if (!configData) {
          const mainTomoriRow = typedTomoriRows.find((row) => row.is_alter === false) ?? typedTomoriRows[0];
          const fallbackTomoriId = mainTomoriRow?.persona_id;
          if (fallbackTomoriId) {
            log.warn(
              `No server-scoped config found for server ${serverDiscId}; falling back to persona_id ${fallbackTomoriId}`,
            );
            configData = await this.sqlLoadTomoriConfigByTomoriId(fallbackTomoriId);
          }
        }

        if (!configData) {
          log.error(`No config found for server ${serverDiscId}; cannot build persona states`);
          return [];
        }

        // Resolve server-scoped fallback chain once (shared across all personas for this server).
        const rawFallbackIds = configData.fallback_llm_ids;
        const fallbackLlmIds = configData.fallback_llm_ids;
        const fallbackLlms = fallbackLlmIds.length > 0 ? await llmModelRepo.getLlmsByIds(fallbackLlmIds) : [];
        if (PersonaRepository.FALLBACK_DEBUG_ENABLED) {
          log.info(
            `[FallbackDebug][loadAllPersonasForServer] server_disc_id=${serverDiscId} server_id=${serverId} raw_fallback_ids=${JSON.stringify(rawFallbackIds)} parsed_fallback_ids=[${fallbackLlmIds.join(", ")}] resolved_fallbacks=[${fallbackLlms.map((llm) => `${llm.llm_id}:${llm.llm_codename}`).join(", ")}]`,
          );
        }

        const modelRefs = configData.fallback_model_refs ?? [];
        let fallbackChain: FallbackEntry[] | undefined;
        if (modelRefs.length > 0) {
          const llmRefIds = modelRefs
            .filter((r: FallbackModelRef) => r.type === "llm")
            .map((r: FallbackModelRef) => r.id);
          const epRefIds = modelRefs
            .filter((r: FallbackModelRef) => r.type === "custom_endpoint")
            .map((r: FallbackModelRef) => r.id);
          const [refLlms, refEndpoints] = await Promise.all([
            llmRefIds.length > 0 ? llmModelRepo.getLlmsByIds(llmRefIds) : Promise.resolve([]),
            epRefIds.length > 0 ? llmProviderRepo.loadCustomEndpointsByIds(epRefIds) : Promise.resolve([]),
          ]);
          const llmMap = new Map(refLlms.map((m) => [m.llm_id as number, m]));
          const epMap = new Map(refEndpoints.map((e) => [e.custom_endpoint_id as number, e]));
          const resolved = modelRefs
            .map((ref: FallbackModelRef) => {
              if (ref.type === "llm") {
                const model = llmMap.get(ref.id);
                return model ? ({ kind: "llm", model } as FallbackEntry) : null;
              }
              const endpoint = epMap.get(ref.id);
              return endpoint ? ({ kind: "custom_endpoint", endpoint } as FallbackEntry) : null;
            })
            .filter((e): e is FallbackEntry => e !== null);
          if (resolved.length > 0) fallbackChain = resolved;
        }

        // Load LLM data once (with cache fallback). BYOK-only servers may intentionally
        // omit the server text model until a member overlays a personal provider.
        let llmData: LlmRow;
        if (!configData.llm_id) {
          llmData = getUnconfiguredLlm();
        } else {
          const cachedLlm = getCachedLLM(configData.llm_id);
          if (!cachedLlm) {
            log.info(`Cache miss for LLM ID ${configData.llm_id}, querying database`);
            const llmRows = await sql`
                SELECT * FROM llms
                WHERE llm_id = ${configData.llm_id}
                LIMIT 1
              `;

            if (!llmRows.length) {
              log.error(
                `Found persona config but no LLM data for server ${serverDiscId}, llm_id: ${configData.llm_id}`,
              );
              return [];
            }
            llmData = llmRows[0] as LlmRow;
          } else {
            llmData = cachedLlm as LlmRow;
          }
        }

        const rotationKeysRows = await sql`
            SELECT
              akr.rotation_key_id, akr.server_id, akr.provider, akr.api_key, akr.key_version,
              akr.is_main_key_pointer, akr.is_enabled, akr.created_at, akr.updated_at,
              COALESCE(rs.usage_count, 0) AS usage_count,
              COALESCE(rs.error_count, 0) AS error_count,
              rs.last_used_at, rs.last_error_at, rs.last_error_type, rs.last_error_message
            FROM api_key_rotation akr
            LEFT JOIN api_key_rotation_runtime_state rs USING (rotation_key_id)
            WHERE akr.server_id = ${serverId}
              AND akr.provider = ${llmData.llm_provider.toLowerCase()}
            ORDER BY COALESCE(rs.usage_count, 0) ASC, akr.rotation_key_id ASC
          `;

        const rotationKeys: ApiKeyRotationRow[] = [];
        for (const row of rotationKeysRows) {
          const parsed = apiKeyRotationSchema.safeParse(row);
          if (parsed.success) {
            rotationKeys.push(parsed.data);
          } else {
            const errorDetails = JSON.stringify(parsed.error.flatten(), null, 2);
            log.warn(`Invalid rotation key row for server ${serverDiscId}:\n${errorDetails}`);
          }
        }

        const personaConfigRows = await sql`
            SELECT pc.*
            FROM persona_configs pc
            JOIN personas t ON t.persona_id = pc.persona_id
            WHERE t.server_id = ${serverId}
          `;
        const personaConfigMap = new Map<number, PersonaConfigRow>();
        for (const row of personaConfigRows) {
          const parsed = personaConfigSchema.safeParse(row);
          if (parsed.success) {
            personaConfigMap.set(parsed.data.persona_id, parsed.data);
          } else {
            log.warn(`Invalid persona config row for server ${serverDiscId}:`, parsed.error.flatten());
          }
        }

        const memoryRows = await sql<
          Array<{
            persona_lineage_id: number | string | bigint | null;
            content: string;
          }>
        >`
            SELECT persona_lineage_id, content
            FROM server_memories
            WHERE server_id = ${serverId}
            ORDER BY created_at DESC
          `;
        const memoriesByLineage = new Map<number, string[]>();
        for (const row of memoryRows) {
          const lineageId =
            typeof row.persona_lineage_id === "bigint"
              ? Number(row.persona_lineage_id)
              : typeof row.persona_lineage_id === "string"
                ? Number(row.persona_lineage_id)
                : row.persona_lineage_id;
          if (typeof lineageId !== "number" || !Number.isFinite(lineageId) || lineageId < 0) {
            log.warn(`Skipping server memory with invalid persona_lineage_id for server ${serverDiscId}`);
            continue;
          }
          const existing = memoriesByLineage.get(lineageId) ?? [];
          existing.push(row.content);
          memoriesByLineage.set(lineageId, existing);
        }

        // Batch-load autochat runtime counters for all personas in this server.
        const personaIds: number[] = typedTomoriRows
          .map((r: TomoriRow & PersonaScopedConfigFields) => r.persona_id)
          .filter((id): id is number => typeof id === "number");
        const personaAttributeRows =
          personaIds.length > 0
            ? await sql`
                SELECT attribute_id, persona_id, attribute_order, attribute_text, is_public, created_at, updated_at
                FROM persona_attributes
                WHERE persona_id = ANY(${sql.array(personaIds, "int4")})
                ORDER BY persona_id, attribute_order
              `
            : [];
        const attributesByPersonaId = new Map<number, PersonaAttributeRow[]>();
        for (const row of personaAttributeRows) {
          const personaId = row.persona_id as number;
          const parsedAttribute: PersonaAttributeRow = {
            attribute_id: row.attribute_id as number,
            persona_id: personaId,
            attribute_order: row.attribute_order as number,
            attribute_text: row.attribute_text as string,
            is_public: (row.is_public as boolean) ?? false,
            created_at: row.created_at as Date | undefined,
            updated_at: row.updated_at as Date | undefined,
          };
          const existing = attributesByPersonaId.get(personaId) ?? [];
          existing.push(parsedAttribute);
          attributesByPersonaId.set(personaId, existing);
        }

        const autochRuntimeRows =
          personaIds.length > 0
            ? await sql`
                SELECT persona_id, autoch_counter, autoch_next_target
                FROM persona_autoch_runtime_state
                WHERE persona_id = ANY(${sql.array(personaIds, "int4")})
              `
            : [];
        const autochRuntimeByPersonaId = new Map<
          number,
          Pick<PersonaAutochRuntimeStateRow, "autoch_counter" | "autoch_next_target">
        >();
        for (const row of autochRuntimeRows) {
          autochRuntimeByPersonaId.set(row.persona_id as number, {
            autoch_counter: (row.autoch_counter as number) ?? 0,
            autoch_next_target: (row.autoch_next_target as number) ?? 0,
          });
        }

        // Load vision model if configured (server-scoped, loaded once for all personas)
        let visionLlm: LlmRow | undefined;
        if (configData.vision_llm_id) {
          visionLlm = getCachedLLM(configData.vision_llm_id) as LlmRow | undefined;
          if (!visionLlm) {
            const visionLlmRows = await sql`
                SELECT * FROM llms WHERE llm_id = ${configData.vision_llm_id} LIMIT 1
              `;
            if (visionLlmRows.length) {
              visionLlm = visionLlmRows[0] as LlmRow;
            }
          }
        }

        const personas: TomoriState[] = [];
        for (const tomoriRow of typedTomoriRows) {
          const personaId = tomoriRow.persona_id;
          if (!personaId) {
            log.warn(`Skipping persona with missing persona_id for server ${serverDiscId}`);
            continue;
          }

          const personaConfig = personaConfigMap.get(personaId);

          // Resolve persona-specific LLM override if set (cache first, DB fallback)
          let personaLlm: LlmRow | undefined;
          if (personaConfig?.llm_id) {
            personaLlm = getCachedLLM(personaConfig.llm_id) as LlmRow | undefined;
            if (!personaLlm) {
              const personaLlmRows = await sql`
                  SELECT * FROM llms WHERE llm_id = ${personaConfig.llm_id} LIMIT 1
                `;
              if (personaLlmRows.length) {
                personaLlm = personaLlmRows[0] as LlmRow;
              }
            }
          }

          const rawPersonaLineageId = tomoriRow.persona_lineage_id;
          const parsedPersonaLineageId =
            typeof rawPersonaLineageId === "bigint"
              ? Number(rawPersonaLineageId)
              : typeof rawPersonaLineageId === "string"
                ? Number(rawPersonaLineageId)
                : (rawPersonaLineageId ?? 0);
          const personaLineageId = Number.isFinite(parsedPersonaLineageId) ? parsedPersonaLineageId : 0;
          // Personas sharing lineage intentionally share server memories.
          const serverMemories = memoriesByLineage.get(personaLineageId) ?? [];

          const autochRuntime = autochRuntimeByPersonaId.get(personaId) ?? {
            autoch_counter: 0,
            autoch_next_target: 0,
          };
          const pointerPreset = pointerPresetsByPersonaId.get(personaId);
          const personaAttributes = pointerPreset
            ? this.buildPresetAttributeRows(personaId, pointerPreset)
            : (attributesByPersonaId.get(personaId) ?? []);
          const attributeList = pointerPreset
            ? pointerPreset.preset_attribute_list
            : personaAttributes.length > 0
              ? personaAttributes.map((attribute) => attribute.attribute_text)
              : ((tomoriRow.attribute_list as string[] | undefined) ?? []);
          const sampleDialoguesIn = pointerPreset
            ? pointerPreset.preset_sample_dialogues_in
            : ((tomoriRow.sample_dialogues_in as string[] | undefined) ?? []);
          const sampleDialoguesOut = pointerPreset
            ? pointerPreset.preset_sample_dialogues_out
            : ((tomoriRow.sample_dialogues_out as string[] | undefined) ?? []);
          // A live pointer resolves trigger_words from its preset (mirrors
          // persona_prompt below), so preset edits propagate until the first
          // content edit forks the persona. Once forked, `pointerPreset` is
          // undefined and the persona's own persona_configs triggers are used.
          const triggerWords = pointerPreset
            ? resolvePresetTriggerWords(pointerPreset)
            : (personaConfig?.trigger_words ?? []);
          const personaPrompt = pointerPreset
            ? resolvePresetPersonaPrompt(pointerPreset)
            : (personaConfig?.persona_prompt ?? null);
          const namingConfig = pointerPreset
            ? pointerPreset.preset_naming_config
            : (personaNamingConfigs.get(personaId) ?? EMPTY_PERSONA_NAMING_CONFIG);

          // Per-persona humanizer override: overlay onto a copy of the shared server
          // config so only this persona's state sees the overridden degree. Each
          // state is Zod-parsed below, so the shared configData base stays untouched.
          const humanizerOverride = personaConfig?.humanizer_degree ?? null;

          const combinedState = {
            ...tomoriRow,
            // Pointer alters live-resolve the shared preset avatar (see helper).
            webhook_avatar_url: this.resolvePointerAlterAvatarUrl(tomoriRow, pointerPreset),
            attribute_list: attributeList,
            sample_dialogues_in: sampleDialoguesIn,
            sample_dialogues_out: sampleDialoguesOut,
            persona_attributes: personaAttributes,
            config: humanizerOverride !== null ? { ...configData, humanizer_degree: humanizerOverride } : configData,
            llm: llmData,
            trigger_words: triggerWords,
            persona_prompt: personaPrompt,
            naming_config: namingConfig,
            reward_conditioning_enabled: personaConfig?.reward_conditioning_enabled ?? true,
            punish_conditioning_enabled: personaConfig?.punish_conditioning_enabled ?? true,
            humanizer_degree_override: humanizerOverride,
            server_memories: serverMemories,
            rotation_keys: rotationKeys.length > 0 ? rotationKeys : undefined,
            ...autochRuntime,
            vision_llm: visionLlm,
            fallback_llms: fallbackLlms.length > 0 ? fallbackLlms : undefined,
            fallback_chain: fallbackChain,
            persona_llm: personaLlm,
          };

          const parsedState = tomoriStateSchema.safeParse(combinedState);
          if (!parsedState.success) {
            log.error(
              `Failed to validate persona state for server ${serverDiscId}, persona_id ${personaId}:`,
              parsedState.error.flatten(),
            );
            continue;
          }

          personas.push(parsedState.data);
        }

        if (personas.length === 0) {
          log.warn(`No valid personas found for server ${serverDiscId}`);
          return [];
        }

        // Collapse shared trigger words to a single owner before returning, so a
        // word every preset bundles (e.g. "tomori") routes to one persona instead
        // of firing every alter at once. See applyTriggerWordOwnership.
        this.applyTriggerWordOwnership(personas);

        return personas;
      }, `load all personas for server ${serverDiscId}`);
    } catch (error) {
      log.error(`Error loading all personas for server ${serverDiscId}:`, error);
      // Wrapping happens outside withTransientDbRetry: the helper matches on the driver's
      // error code, which a DatabaseUnavailableError would hide, so wrapping any earlier
      // silently disables the retry.
      // Throw a typed error so the cache layer can distinguish
      // "DB unreachable" from "server genuinely has no data" (which returns [])
      throw new DatabaseUnavailableError(
        `Failed to load personas for server ${serverDiscId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Enforces single-owner trigger words across a server's persona set.
   *
   * Every official preset deliberately bundles the shared base word ("tomori")
   * alongside its unique name (e.g. shy = `[tomori, lilya]`). Pointer personas
   * resolve their triggers live from that shared preset, so without this step the
   * same word would route to the main persona AND every alter at once. Here we
   * award each trigger to exactly one persona by priority:
   *
   *   1. Main persona(s) (`is_alter = false`): they additionally reserve the
   *      configured base trigger words even if their stored list omits them, so
   *      an alter can never steal the bot's own name regardless of server locale.
   *   2. Alters in creation order (ascending `persona_id`): first created wins a
   *      contested word; later personas drop it.
   *
   * Each persona keeps only the triggers no higher-priority persona already owns;
   * whatever it keeps is then claimed for everyone after it. The main persona's
   * list is never trimmed. Mutates `trigger_words` in place and preserves the
   * input array order (callers rely on the main-first / recency load ordering).
   *
   * @param personas - Assembled persona states for one server.
   */
  private applyTriggerWordOwnership(personas: TomoriState[]): void {
    // Seed the claimed set with base trigger words for both shipped locales so
    //    the main persona implicitly owns the bot's name in any language.
    const claimedTriggerKeys = new Set<string>();
    for (const baseWord of [...getBaseTriggerWords("en-US"), ...getBaseTriggerWords("ja")]) {
      const normalizedBaseWord = normalizeTriggerWord(baseWord);
      if (normalizedBaseWord.length > 0) {
        claimedTriggerKeys.add(normalizedBaseWord);
      }
    }

    // Visit personas in ownership priority: main first, then alters oldest-first.
    const personasByOwnershipPriority = [...personas].sort((a, b) => {
      if (a.is_alter !== b.is_alter) {
        return a.is_alter ? 1 : -1;
      }
      return (a.persona_id ?? 0) - (b.persona_id ?? 0);
    });

    for (const persona of personasByOwnershipPriority) {
      // Alters drop any trigger a higher-priority persona already owns; the
      //     main persona keeps its full list unchanged.
      if (persona.is_alter) {
        persona.trigger_words = selectUnclaimedTriggerWords(persona.trigger_words ?? [], claimedTriggerKeys, {
          lowercase: false,
        });
      }

      // Claim whatever this persona kept so later personas can't reuse it.
      for (const trigger of persona.trigger_words ?? []) {
        const normalizedTrigger = normalizeTriggerWord(trigger);
        if (normalizedTrigger.length > 0) {
          claimedTriggerKeys.add(normalizedTrigger);
        }
      }
    }
  }

  private async loadPersonaConfigRow(personaId: number): Promise<PersonaConfigRow | null> {
    try {
      const rows = await sql`
        SELECT *
        FROM persona_configs
        WHERE persona_id = ${personaId}
        LIMIT 1
      `;

      if (!rows.length) {
        return null;
      }

      const parsed = personaConfigSchema.safeParse(rows[0]);
      if (!parsed.success) {
        log.warn(`Failed to validate persona config for tomori ${personaId}:`, parsed.error.flatten());
        return null;
      }

      return parsed.data;
    } catch (error) {
      log.error(`Error loading persona config for tomori ${personaId}:`, error);
      return null;
    }
  }

  private async updateTomori(personaId: number, tomoriData: Partial<TomoriRow>): Promise<TomoriRow | null> {
    try {
      // Validate the partial data with Zod (Rule #7)
      const validTomoriData = tomoriSchema.partial().parse(tomoriData);

      // Extract field names and values for the SQL query.
      // Filter to only keys present in the original input, because Zod injects defaults
      // for all schema fields with .default(), which would incorrectly expand the
      // SET clause (e.g. attribute_list: [] would overwrite existing data).
      const fields = Object.keys(validTomoriData).filter((key) => key !== "persona_id" && key in tomoriData);

      if (fields.length === 0) {
        log.warn(`No fields provided to update for persona_id: ${personaId}`);
        return null;
      }

      // Security validation: Ensure all field names are whitelisted to prevent SQL injection
      validateTomoriFields(fields);

      // Prepare arrays for placeholders and values
      const setParts: string[] = [];
      const values: SqlParameterArray = [];

      // Iterate through fields to build SET clause parts and collect values.
      // sql.unsafe() cannot infer PostgreSQL column types, so JavaScript arrays
      // must be manually serialized to PostgreSQL array literals (e.g. {"a","b"}).
      fields.forEach((field, index) => {
        setParts.push(`${field} = $${index + 1}`);
        const rawValue = validTomoriData[field as keyof typeof validTomoriData];
        if (Array.isArray(rawValue)) {
          // Serialize to PostgreSQL array literal: {"val1","val2"} or {}
          const escaped = rawValue.map((v) => `"${String(v).replace(/(["\\])/g, "\\$1")}"`);
          values.push(`{${escaped.join(",")}}`);
        } else {
          values.push(rawValue);
        }
      });

      // Join the SET parts
      const setClause = setParts.join(", ");

      const finalPlaceholderIndex = values.length + 1;
      values.push(personaId);

      // Execute the UPDATE using sql.unsafe() with the values array (not spread, because
      // Bun SQL expects a single array argument, not individual arguments).
      const result = await sql.unsafe(
        `
          UPDATE personas
          SET ${setClause}
          WHERE persona_id = $${finalPlaceholderIndex}
          RETURNING *
        `,
        values,
      );

      if (!result.length) {
        const context: ErrorContext = {
          personaId,
          errorType: "DatabaseUpdateError",
          metadata: {
            operation: "updateTomori",
            fields,
          },
        };
        await log.error(`No tomori found with id: ${personaId}`, new Error("Tomori not found"), context);
        return null;
      }

      const updatedTomori = tomoriSchema.safeParse(result[0]);
      if (!updatedTomori.success) {
        const context: ErrorContext = {
          personaId,
          errorType: "SchemaValidationError",
          metadata: {
            operation: "updateTomori",
            validationErrors: updatedTomori.error.flatten(),
          },
        };
        await log.error(`Failed to validate updated tomori for id: ${personaId}`, updatedTomori.error, context);
        return null;
      }

      return updatedTomori.data;
    } catch (error) {
      const context: ErrorContext = {
        personaId,
        errorType: "DatabaseUpdateError",
        metadata: {
          operation: "updateTomori",
        },
      };
      await log.error(`Error updating tomori for id: ${personaId}`, error, context);
      return null;
    }
  }
}

/** Singleton instance: import this in callers. */
export const personaRepository = new PersonaRepository();
