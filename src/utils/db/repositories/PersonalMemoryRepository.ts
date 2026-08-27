/**
 * PersonalMemoryRepository: manages the `personal_memories` table.
 *
 * Personal memories are long-term facts Tomori learns about a specific user,
 * scoped to a persona lineage (or lineage 0 for global cross-persona memories).
 *
 * Export contract: toExportShape / fromExportShape are required by IRepository
 * and consumed by the Phase 6 (#16.7) export pipeline composition.
 */
import type { ErrorContext, PersonalMemoryRow } from "@/types/db/schema";
import { personalMemorySchema } from "@/types/db/schema";
import { sql } from "@/utils/db/client";
import { type MemoryValidationResult, getMemoryLimits, validateMemoryContent } from "@/utils/misc/memoryLimits";
import { log } from "@/utils/misc/logger";
import type { IRepository } from "./IRepository";

/** Portable personal memory export shape (expanded in Phase 6 #16.7). */
type PersonalMemoryExportShape = {
  user_disc_id: string;
  memories: Array<{ content: string; tags: string[]; persona_lineage_id: number }>;
};

class PersonalMemoryRepository implements IRepository<PersonalMemoryExportShape> {
  /**
   * Loads personal memories for a user scoped to a persona lineage.
   * When includeGlobalMemories is true (default), lineage-0 memories are also included.
   *
   * @param userId            - Internal user DB ID
   * @param personaLineageId  - Persona lineage to load for (0 = global)
   * @param includeGlobalMemories - Whether to also include lineage-0 memories
   * @returns Array of PersonalMemoryRow, newest first
   */
  async loadForUserLineage(
    userId: number,
    personaLineageId: number,
    includeGlobalMemories = true,
  ): Promise<PersonalMemoryRow[]> {
    try {
      const rows =
        includeGlobalMemories && personaLineageId !== 0
          ? await sql`
            SELECT *
            FROM personal_memories
            WHERE user_id = ${userId}
              AND (
                persona_lineage_id = ${personaLineageId}
                OR persona_lineage_id = 0
              )
            ORDER BY created_at DESC, personal_memory_id DESC
          `
          : await sql`
            SELECT *
            FROM personal_memories
            WHERE user_id = ${userId}
              AND persona_lineage_id = ${personaLineageId}
            ORDER BY created_at DESC, personal_memory_id DESC
          `;

      const parsedRows: PersonalMemoryRow[] = [];
      for (const row of rows) {
        const parsed = personalMemorySchema.safeParse(row);
        if (parsed.success) {
          parsedRows.push(parsed.data);
        } else {
          log.warn(`Skipping invalid personal memory row for user ${userId}:`, parsed.error.flatten());
        }
      }

      return parsedRows;
    } catch (error) {
      log.error(`Error loading personal memories for user ${userId} and lineage ${personaLineageId}:`, error);
      return [];
    }
  }

  /**
   * Returns the set of persona lineage ids for which this user has at least one
   * personal memory. Batched eligibility source for the persona-scoped `/memory
   * personal` picker filters, which load with `includeGlobalMemories = false`.
   *
   * Lineage `0` (global) is excluded on purpose: it is the command's separate
   * global branch, so a global memory must never make a specific persona look
   * eligible. This mirrors `loadForUserLineage(userId, lineageId, false)`, which
   * returns a non-empty array exactly for the non-zero lineages in this set.
   *
   * @param userId - Internal user DB ID
   * @returns Set of eligible non-zero `persona_lineage_id` values.
   */
  async lineageIdsWithMemories(userId: number): Promise<Set<number>> {
    try {
      const rows = await sql<Array<{ persona_lineage_id: number | string }>>`
        SELECT DISTINCT persona_lineage_id
        FROM personal_memories
        WHERE user_id = ${userId}
          AND persona_lineage_id <> 0
      `;
      return new Set(rows.map((row) => Number(row.persona_lineage_id)));
    } catch (error) {
      log.error(`Error loading lineage ids with personal memories for user ${userId}:`, error);
      return new Set();
    }
  }

  /**
   * Returns the total count of personal memories for a user across all personas and global scope.
   *
   * @param userId - Internal user DB ID
   * @returns Total count of personal memories
   */
  async countAllForUser(userId: number): Promise<number> {
    try {
      const rows = await sql<Array<{ count: string | number }>>`
        SELECT COUNT(*) as count
        FROM personal_memories
        WHERE user_id = ${userId}
      `;
      return Number(rows[0]?.count ?? 0);
    } catch (error) {
      log.error(`Error counting personal memories for user ${userId}:`, error);
      return 0;
    }
  }

  async edit(personalMemoryId: number, content: string, tags: string[] = []): Promise<boolean> {
    try {
      const [updated] = await sql`
        UPDATE personal_memories
        SET content = ${content}, tags = ${sql.array(tags, "TEXT")}, updated_at = NOW()
        WHERE personal_memory_id = ${personalMemoryId}
        RETURNING personal_memory_id
      `;
      return !!updated;
    } catch (error) {
      log.error(`Error editing personal memory ${personalMemoryId}:`, error);
      return false;
    }
  }

  async remove(personalMemoryId: number): Promise<boolean> {
    try {
      const [deleted] = await sql`
        DELETE FROM personal_memories
        WHERE personal_memory_id = ${personalMemoryId}
        RETURNING personal_memory_id
      `;
      return !!deleted;
    } catch (error) {
      log.error(`Error removing personal memory ${personalMemoryId}:`, error);
      return false;
    }
  }

  /**
   * Delete a personal memory scoped to user + persona lineage.
   * Used by the updateLongTermMemoryTool function call handler.
   *
   * @param memoryId         - Primary key of the personal memory
   * @param userId           - Internal user DB ID
   * @param personaLineageId - Persona lineage scope guard; lineage 0 also matches
   * @returns Row with personal_memory_id and content, or null when not found
   */
  async removeByIdForUserAndLineage(
    memoryId: number,
    userId: number,
    personaLineageId: number,
  ): Promise<{ personal_memory_id: number; content: string } | null> {
    const [row] = await sql`
      DELETE FROM personal_memories
      WHERE personal_memory_id = ${memoryId}
        AND user_id = ${userId}
        AND (
          persona_lineage_id = ${personaLineageId}
          OR persona_lineage_id = 0
        )
      RETURNING personal_memory_id, content
    `;
    return row
      ? {
          personal_memory_id: row.personal_memory_id as number,
          content: row.content as string,
        }
      : null;
  }

  /**
   * Update a personal memory scoped to user + persona lineage.
   * Used by the updateLongTermMemoryTool function call handler.
   *
   * @param memoryId         - Primary key of the personal memory
   * @param content          - New memory content
   * @param userId           - Internal user DB ID
   * @param personaLineageId - Persona lineage scope guard; lineage 0 also matches
   * @returns Row with personal_memory_id and content, or null when not found
   */
  async updateByIdForUserAndLineage(
    memoryId: number,
    content: string,
    userId: number,
    personaLineageId: number,
  ): Promise<{ personal_memory_id: number; content: string } | null> {
    const [row] = await sql`
      UPDATE personal_memories
      SET content = ${content}, updated_at = CURRENT_TIMESTAMP
      WHERE personal_memory_id = ${memoryId}
        AND user_id = ${userId}
        AND (
          persona_lineage_id = ${personaLineageId}
          OR persona_lineage_id = 0
        )
      RETURNING personal_memory_id, content
    `;
    return row
      ? {
          personal_memory_id: row.personal_memory_id as number,
          content: row.content as string,
        }
      : null;
  }

  /**
   * Batch-inserts multiple personal memories for a user in a single transaction.
   * All rows share the same userId, personaLineageId, and tags.
   * Rolls back all inserts if any row fails (atomicity guarantee).
   *
   * @param userId           - Internal user DB ID
   * @param personaLineageId - Persona lineage scope for all memories
   * @param memories         - Array of content strings to insert
   * @param tags             - Optional classification tags applied to all memories
   * @returns true on full success, false if the transaction was rolled back
   */
  async addBatch(userId: number, personaLineageId: number, memories: string[], tags: string[] = []): Promise<boolean> {
    if (memories.length === 0) return true;

    try {
      await sql.transaction(async (tx) => {
        for (const memory of memories) {
          await tx`
            INSERT INTO personal_memories (user_id, persona_lineage_id, content, tags)
            VALUES (${userId}, ${personaLineageId}, ${memory}, ${sql.array(tags, "TEXT")})
          `;
        }
      });
      return true;
    } catch (error) {
      const context: ErrorContext = {
        userId,
        errorType: "DatabaseInsertError",
        metadata: {
          operation: "addBatchPersonalMemories",
          personaLineageId,
          insertCount: memories.length,
        },
      };
      await log.error(
        `Error batch-inserting personal memories for user ${userId} in lineage ${personaLineageId}`,
        error,
        context,
      );
      return false;
    }
  }

  /**
   * Inserts a new personal memory for a user.
   * Personal memories have no associated server-level cache to invalidate;
   * they are loaded fresh per context build via loadForUserLineage.
   *
   * @param userId           - Internal user DB ID
   * @param personaLineageId - Persona lineage this memory belongs to
   * @param content          - Memory content string
   * @param tags             - Optional classification tags
   * @returns Inserted PersonalMemoryRow or null on failure
   */
  async add(
    userId: number,
    personaLineageId: number,
    content: string,
    tags: string[] = [],
  ): Promise<PersonalMemoryRow | null> {
    log.info(
      `Attempting to learn a personal memory for user ${userId} in lineage ${personaLineageId}: "${content.substring(0, 50)}..."`,
    );

    const contentValidation = validateMemoryContent(content);
    if (!contentValidation.isValid) {
      log.warn(`Personal memory content validation failed for user ID ${userId}: ${contentValidation.error}`);
      return null;
    }

    const personalLimitCheck = await this.checkPersonalMemoryLimit(userId, personaLineageId, true);
    if (!personalLimitCheck.isValid) {
      log.warn(
        `Personal memory limit exceeded for user ID ${userId}: ${personalLimitCheck.currentCount}/${personalLimitCheck.maxAllowed}`,
      );
      return null;
    }

    try {
      const [insertedMemory] = await sql`
        INSERT INTO personal_memories (user_id, persona_lineage_id, content, tags)
        VALUES (${userId}, ${personaLineageId}, ${content}, ${sql.array(tags, "TEXT")})
        RETURNING *
      `;

      if (!insertedMemory) {
        log.warn(`Attempted to insert personal memory for non-existent user ${userId}`);
        return null;
      }

      const validatedMemory = personalMemorySchema.safeParse(insertedMemory);
      if (!validatedMemory.success) {
        const context: ErrorContext = {
          userId,
          errorType: "SchemaValidationError",
          metadata: {
            operation: "addPersonalMemoryByTomori",
            personaLineageId,
            contentAttempted: content.substring(0, 100),
            validationErrors: validatedMemory.error.flatten(),
          },
        };
        await log.error(
          `Failed to validate inserted personal memory for user ${userId} in lineage ${personaLineageId}`,
          validatedMemory.error,
          context,
        );
        return null;
      }

      log.success(
        `Tomori successfully inserted personal memory (ID: ${validatedMemory.data.personal_memory_id}) for user ${userId} in lineage ${personaLineageId}.`,
      );
      return validatedMemory.data;
    } catch (error) {
      const context: ErrorContext = {
        userId,
        errorType: "DatabaseUpdateError",
        metadata: {
          operation: "addPersonalMemoryByTomori",
          personaLineageId,
          contentAttempted: content.substring(0, 100),
        },
      };
      await log.error(
        `Error inserting personal memory for user ${userId} in lineage ${personaLineageId}`,
        error,
        context,
      );
      return null;
    }
  }

  /**
   * Check if a user has reached their personal memory limit.
   *
   * @param userId              - Internal user DB ID
   * @param personaLineageId    - Persona lineage scope (0 = global)
   * @param includeGlobalMemories - Whether to count lineage-0 memories too
   * @returns MemoryValidationResult indicating whether the limit is exceeded
   */
  async checkPersonalMemoryLimit(
    userId: number,
    personaLineageId = 0,
    includeGlobalMemories = true,
  ): Promise<MemoryValidationResult> {
    const limits = getMemoryLimits();

    try {
      const [countResult] =
        includeGlobalMemories && personaLineageId !== 0
          ? await sql`
              SELECT COUNT(*) as memory_count
              FROM personal_memories
              WHERE user_id = ${userId}
                AND (
                  persona_lineage_id = ${personaLineageId}
                  OR persona_lineage_id = 0
                )
            `
          : await sql`
              SELECT COUNT(*) as memory_count
              FROM personal_memories
              WHERE user_id = ${userId}
                AND persona_lineage_id = ${personaLineageId}
            `;

      const currentCount = Number(countResult?.memory_count || 0);

      if (currentCount >= limits.maxPersonalMemories) {
        return {
          isValid: false,
          error: "PERSONAL_MEMORY_LIMIT_EXCEEDED",
          currentCount,
          maxAllowed: limits.maxPersonalMemories,
        };
      }

      return { isValid: true, currentCount, maxAllowed: limits.maxPersonalMemories };
    } catch (error) {
      log.error(`Error checking personal memory limit for user ${userId}:`, error);
      return { isValid: false, error: "PERSONAL_MEMORY_LIMIT_EXCEEDED" };
    }
  }

  /**
   * Personal memory export is handled by ImportExportRepository.
   * Stub satisfies IRepository contract pending Phase 6 #16.7.
   *
   * @param _ownerId - Discord user snowflake (unused until Phase 6)
   */
  async toExportShape(_ownerId: string | number): Promise<PersonalMemoryExportShape | null> {
    return null;
  }

  /**
   * Personal memory import is handled by ImportExportRepository.
   * Stub satisfies IRepository contract pending Phase 6 #16.7.
   */
  async fromExportShape(_ownerId: string | number, _data: PersonalMemoryExportShape): Promise<boolean> {
    return false;
  }
}

/** Singleton instance: import this in callers. */
export const personalMemoryRepository = new PersonalMemoryRepository();
