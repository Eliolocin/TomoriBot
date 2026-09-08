import { personaSpriteSchema, type PersonaSpriteRow } from "@/types/db/schema";
import { invalidatePersonaSpriteCache } from "@/utils/cache/personaSpriteCacheStore";
import { sql } from "@/utils/db/client";
import { log } from "@/utils/misc/logger";

type PersonaSpriteUpsertInput = {
  personaId: number;
  spriteName: string;
  spriteKey: string;
  avatarUrl: string;
  usageInstructions: string;
  isIdentity: boolean;
};

type PersonaSpriteUpsertResult = {
  sprite: PersonaSpriteRow;
  previousAvatarUrl: string | null;
  replaced: boolean;
};

type PersonaSpriteMetadataUpdateInput = {
  // The sprite is identified by its CURRENT lookup key (stable across a
  // pointer→materialized fork, unlike sprite_id which is reassigned on copy).
  currentSpriteKey: string;
  personaId: number;
  spriteName: string;
  spriteKey: string;
  avatarUrl?: string;
  usageInstructions: string;
  isIdentity: boolean;
};

type PersonaSpriteUpsertRow = PersonaSpriteRow & {
  previous_avatar_url: string | null;
  previous_sprite_id: number | null;
};

type PersonaSpriteUpdateRow = PersonaSpriteRow & {
  previous_avatar_url: string | null;
};

type PersonaSpriteMetadataUpdateResult = {
  sprite: PersonaSpriteRow;
  previousAvatarUrl: string | null;
};

class PersonaSpriteRepository {
  /**
   * Resolves a persona's sprites. For a live preset pointer, the sprites are
   * resolved from the shared `preset_sprites` table (so every server's pointer
   * persona sees the same default set, backed by one shared image). For a
   * materialized/independent persona, its own `persona_sprites` rows are returned.
   *
   * @param personaId - Target persona id
   * @returns Sprite rows (preset-resolved or persona-owned)
   * @throws When the persona or sprite query fails, so callers that make cleanup decisions do not
   * treat an unavailable snapshot as an empty sprite set.
   */
  async listForPersona(personaId: number): Promise<PersonaSpriteRow[]> {
    try {
      // Live preset pointers resolve the shared official sprite set.
      const pointer = await this.resolvePointerPreset(personaId);
      if (pointer) {
        return await this.listPresetSpritesForPointer(personaId, pointer.lineageId, pointer.language);
      }

      // Otherwise read the persona's own sprite rows.
      const rows = await sql<PersonaSpriteRow[]>`
        SELECT sprite_id, persona_id, sprite_name, sprite_key, avatar_url, usage_instructions, is_identity, created_at, updated_at
        FROM persona_sprites
        WHERE persona_id = ${personaId}
        ORDER BY sprite_key ASC, sprite_id ASC
      `;

      return this.parseRowsStrict(rows, `persona ${personaId}`);
    } catch (error) {
      log.error(`Error loading persona sprites for persona ${personaId}:`, error);
      throw error;
    }
  }

  /**
   * Returns the preset identity (lineage + language) a persona points at, or
   * null when the persona is not a live preset pointer.
   */
  private async resolvePointerPreset(personaId: number): Promise<{ lineageId: number; language: string } | null> {
    const [row] = await sql<
      Array<{
        is_pointer: boolean | null;
        preset_lineage_id: number | string | bigint | null;
        preset_language: string | null;
      }>
    >`
      SELECT is_pointer, preset_lineage_id, preset_language
      FROM personas
      WHERE persona_id = ${personaId}
      LIMIT 1
    `;

    if (!row || row.is_pointer !== true) {
      return null;
    }
    // preset_lineage_id is BIGINT (pg may return string); official ids are small.
    const lineageId = row.preset_lineage_id == null ? Number.NaN : Number(row.preset_lineage_id);
    if (!Number.isFinite(lineageId) || !row.preset_language) {
      return null;
    }
    return { lineageId, language: row.preset_language };
  }

  /**
   * Resolves the shared preset sprite set for a pointer persona, shaped as
   * `PersonaSpriteRow` so all downstream consumers are pointer-agnostic. The
   * `sprite_id` carries the preset row id (read-only context: mutation paths
   * materialize first, then operate on real persona_sprites rows).
   */
  private async listPresetSpritesForPointer(
    personaId: number,
    lineageId: number,
    language: string,
  ): Promise<PersonaSpriteRow[]> {
    const rows = await sql<PersonaSpriteRow[]>`
      SELECT
        preset_sprite_id AS sprite_id,
        ${personaId}::int AS persona_id,
        sprite_name,
        sprite_key,
        avatar_url,
        usage_instructions,
        is_identity,
        created_at,
        updated_at
      FROM preset_sprites
      WHERE preset_lineage_id = ${lineageId}
        AND preset_language = ${language}
      ORDER BY sprite_key ASC, preset_sprite_id ASC
    `;

    return this.parseRows(rows, `preset pointer persona ${personaId}`);
  }

  /**
   * Returns the subset of the given persona ids that have at least one sprite,
   * resolving preset pointers in bulk. Batched eligibility source for the
   * `/persona sprites` picker filters.
   *
   * A plain `GROUP BY persona_id` over `persona_sprites` would be wrong: a live
   * preset-pointer persona owns **zero** `persona_sprites` rows yet still has
   * sprites through the shared preset set. This query reproduces
   * {@link listForPersona}'s branch order: pointer resolution first, own rows
   * otherwise; and treats a persona as eligible when:
   *   - it is not a live pointer and owns at least one `persona_sprites` row
   *     (real rows always carry a numeric `sprite_id`, reproducing the caller's
   *     `typeof sprite.sprite_id === "number"` narrowing); or
   *   - it is a live pointer whose resolved preset lineage/language has at least
   *     one `preset_sprites` row.
   *
   * @param personaIds - Candidate persona ids (usually every persona on a server)
   * @returns Set of eligible `persona_id` values.
   */
  async personaIdsWithSprites(personaIds: number[]): Promise<Set<number>> {
    if (personaIds.length === 0) {
      return new Set();
    }

    try {
      const rows = await sql<Array<{ persona_id: number | string }>>`
        SELECT DISTINCT p.persona_id
        FROM personas p
        WHERE p.persona_id = ANY(${sql.array(personaIds, "int4")})
          AND (
            (
              p.is_pointer IS NOT TRUE
              AND EXISTS (
                SELECT 1 FROM persona_sprites ps WHERE ps.persona_id = p.persona_id
              )
            )
            OR (
              p.is_pointer = TRUE
              AND p.preset_lineage_id IS NOT NULL
              AND p.preset_language IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM preset_sprites prs
                WHERE prs.preset_lineage_id = p.preset_lineage_id
                  AND prs.preset_language = p.preset_language
              )
            )
          )
      `;
      return new Set(rows.map((row) => Number(row.persona_id)));
    } catch (error) {
      log.error(`Error loading persona ids with sprites for ${personaIds.length} personas:`, error);
      return new Set();
    }
  }

  async countForPersona(personaId: number): Promise<number> {
    try {
      const [row] = await sql<Array<{ count: string | number }>>`
        SELECT COUNT(*) AS count
        FROM persona_sprites
        WHERE persona_id = ${personaId}
      `;
      return Number(row?.count ?? 0);
    } catch (error) {
      log.error(`Error counting persona sprites for persona ${personaId}:`, error);
      return 0;
    }
  }

  async getByKey(personaId: number, spriteKey: string): Promise<PersonaSpriteRow | null> {
    try {
      const [row] = await sql<PersonaSpriteRow[]>`
        SELECT sprite_id, persona_id, sprite_name, sprite_key, avatar_url, usage_instructions, is_identity, created_at, updated_at
        FROM persona_sprites
        WHERE persona_id = ${personaId}
          AND sprite_key = ${spriteKey}
        LIMIT 1
      `;
      return row ? this.parseRow(row, `persona ${personaId} sprite ${spriteKey}`) : null;
    } catch (error) {
      log.error(`Error loading persona sprite ${spriteKey} for persona ${personaId}:`, error);
      return null;
    }
  }

  async upsertSprite(input: PersonaSpriteUpsertInput): Promise<PersonaSpriteUpsertResult | null> {
    try {
      const [row] = await sql<PersonaSpriteUpsertRow[]>`
        WITH existing AS (
          SELECT sprite_id, avatar_url
          FROM persona_sprites
          WHERE persona_id = ${input.personaId}
            AND sprite_key = ${input.spriteKey}
        ),
        upserted AS (
          INSERT INTO persona_sprites (persona_id, sprite_name, sprite_key, avatar_url, usage_instructions, is_identity)
          VALUES (
            ${input.personaId},
            ${input.spriteName},
            ${input.spriteKey},
            ${input.avatarUrl},
            ${input.usageInstructions},
            ${input.isIdentity}
          )
          ON CONFLICT (persona_id, sprite_key) DO UPDATE
          SET
            sprite_name = EXCLUDED.sprite_name,
            avatar_url = EXCLUDED.avatar_url,
            usage_instructions = EXCLUDED.usage_instructions,
            is_identity = EXCLUDED.is_identity,
            updated_at = NOW()
          RETURNING sprite_id, persona_id, sprite_name, sprite_key, avatar_url, usage_instructions, is_identity, created_at, updated_at
        )
        SELECT
          upserted.*,
          existing.avatar_url AS previous_avatar_url,
          existing.sprite_id AS previous_sprite_id
        FROM upserted
        LEFT JOIN existing ON true
      `;

      if (!row) {
        return null;
      }

      const sprite = this.parseRow(row, `persona ${input.personaId} sprite ${input.spriteKey}`);
      if (!sprite) {
        return null;
      }

      invalidatePersonaSpriteCache(input.personaId);
      return {
        sprite,
        previousAvatarUrl: row.previous_avatar_url ?? null,
        replaced: row.previous_sprite_id !== null,
      };
    } catch (error) {
      log.error(`Error upserting persona sprite ${input.spriteKey} for persona ${input.personaId}:`, error);
      return null;
    }
  }

  /**
   * Updates a sprite's metadata in place (name, lookup key, usage instructions,
   * and identity flag). When `avatarUrl` is provided, the stored image reference
   * is replaced in the same write.
   *
   * Renaming changes `sprite_key`; callers must guarantee the new key does not
   * collide with another sprite on the same persona (the `(persona_id, sprite_key)`
   * unique constraint). A collision surfaces as a caught error returning null.
   *
   * @param input - target sprite identifiers plus the new metadata values
   * @returns the updated row and previous avatar URL, or null when no row matched or the update failed
   */
  async updateSpriteMetadata(
    input: PersonaSpriteMetadataUpdateInput,
  ): Promise<PersonaSpriteMetadataUpdateResult | null> {
    try {
      const [row] = await sql<PersonaSpriteUpdateRow[]>`
        WITH existing AS (
          SELECT avatar_url
          FROM persona_sprites
          WHERE persona_id = ${input.personaId}
            AND sprite_key = ${input.currentSpriteKey}
        ),
        updated AS (
          UPDATE persona_sprites
          SET
            sprite_name = ${input.spriteName},
            sprite_key = ${input.spriteKey},
            avatar_url = COALESCE(${input.avatarUrl ?? null}, avatar_url),
            usage_instructions = ${input.usageInstructions},
            is_identity = ${input.isIdentity},
            updated_at = NOW()
          WHERE persona_id = ${input.personaId}
            AND sprite_key = ${input.currentSpriteKey}
          RETURNING sprite_id, persona_id, sprite_name, sprite_key, avatar_url, usage_instructions, is_identity, created_at, updated_at
        )
        SELECT updated.*, existing.avatar_url AS previous_avatar_url
        FROM updated
        LEFT JOIN existing ON true
      `;

      if (!row) {
        return null;
      }

      const sprite = this.parseRow(row, `persona ${input.personaId} sprite ${input.currentSpriteKey}`);
      if (!sprite) {
        return null;
      }

      invalidatePersonaSpriteCache(input.personaId);
      return {
        sprite,
        previousAvatarUrl: row.previous_avatar_url ?? null,
      };
    } catch (error) {
      log.error(`Error updating persona sprite ${input.currentSpriteKey} for persona ${input.personaId}:`, error);
      return null;
    }
  }

  /**
   * Deletes the given sprites (by lookup key) from a persona's own rows.
   * Keys are stable across a pointer→materialized fork, so callers that listed
   * sprites before forking can safely delete after.
   *
   * @returns The deleted rows (for storage cleanup), or [] on error/no-op
   */
  async deleteSpritesByKeys(personaId: number, spriteKeys: string[]): Promise<PersonaSpriteRow[]> {
    if (spriteKeys.length === 0) {
      return [];
    }

    try {
      const rows = await sql<PersonaSpriteRow[]>`
        DELETE FROM persona_sprites
        WHERE persona_id = ${personaId}
          AND sprite_key = ANY(${sql.array(spriteKeys, "text")})
        RETURNING sprite_id, persona_id, sprite_name, sprite_key, avatar_url, usage_instructions, is_identity, created_at, updated_at
      `;
      const parsedRows = this.parseRows(rows, `persona ${personaId} sprite deletion`);
      if (parsedRows.length > 0) {
        invalidatePersonaSpriteCache(personaId);
      }
      return parsedRows;
    } catch (error) {
      log.error(`Error deleting persona sprites for persona ${personaId}:`, error);
      return [];
    }
  }

  /**
   * Deletes ALL of a persona's own sprite rows (used when `/persona default`
   * re-points a persona, resetting it to the official preset sprite set).
   *
   * @returns The deleted rows (for storage cleanup), or [] when no rows matched
   * @throws When the delete query fails
   */
  async deleteAllForPersona(personaId: number): Promise<PersonaSpriteRow[]> {
    try {
      const rows = await sql<PersonaSpriteRow[]>`
        DELETE FROM persona_sprites
        WHERE persona_id = ${personaId}
        RETURNING sprite_id, persona_id, sprite_name, sprite_key, avatar_url, usage_instructions, is_identity, created_at, updated_at
      `;
      // A successful DELETE with no matching rows still establishes that the cache is not
      // authoritative for this reset. Invalidation follows the completed write, never before it.
      invalidatePersonaSpriteCache(personaId);
      return this.parseRowsStrict(rows, `persona ${personaId} sprite reset`);
    } catch (error) {
      log.error(`Error clearing persona sprites for persona ${personaId}:`, error);
      throw error;
    }
  }

  private parseRows(rows: PersonaSpriteRow[], context: string): PersonaSpriteRow[] {
    const parsedRows: PersonaSpriteRow[] = [];
    for (const row of rows) {
      const parsed = this.parseRow(row, context);
      if (parsed) {
        parsedRows.push(parsed);
      }
    }
    return parsedRows;
  }

  private parseRowsStrict(rows: PersonaSpriteRow[], context: string): PersonaSpriteRow[] {
    const parsedRows: PersonaSpriteRow[] = [];
    for (const row of rows) {
      const parsed = this.parseRow(row, context);
      if (!parsed) {
        throw new Error(`Invalid persona_sprites row for ${context}`);
      }
      parsedRows.push(parsed);
    }
    return parsedRows;
  }

  private parseRow(row: unknown, context: string): PersonaSpriteRow | null {
    const parsed = personaSpriteSchema.safeParse(row);
    if (!parsed.success) {
      log.warn(`Invalid persona_sprites row for ${context}: ${parsed.error.message}`);
      return null;
    }
    return parsed.data;
  }
}

export const personaSpriteRepository = new PersonaSpriteRepository();
