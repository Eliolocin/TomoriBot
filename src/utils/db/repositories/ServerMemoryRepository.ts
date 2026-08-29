/**
 * ServerMemoryRepository: manages the `server_memories` table.
 *
 * Server memories are long-term facts Tomori learns about a Discord server,
 * scoped to a persona lineage. They are read back as part of TomoriState
 * (loaded by PersonaRepository.loadState) and written here.
 *
 * Export contract: toExportShape / fromExportShape are required by IRepository
 * and consumed by the Phase 6 (#16.7) export pipeline composition.
 */
import type { ErrorContext, ServerMemoryRow } from "@/types/db/schema";
import { serverMemorySchema } from "@/types/db/schema";
import { invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCacheStore";
import { sql } from "@/utils/db/client";
import { type MemoryValidationResult, getMemoryLimits, validateMemoryContent } from "@/utils/misc/memoryLimits";
import { log } from "@/utils/misc/logger";
import type { IRepository } from "./IRepository";

/** Row shape for server_memory_configs (Phase 6). */
type ServerMemoryConfigsRow = {
  memory_tagging_enabled: boolean;
};

/**
 * Export shape for ServerMemoryRepository.
 * Includes the Phase 6 server_memory_configs table in addition to
 * the existing memories array (expanded in Phase 6 #16.7).
 */
type ServerMemoryExportShape = {
  server_disc_id: string;
  memory_configs: ServerMemoryConfigsRow | null;
  memories: Array<{ content: string; tags: string[] }>;
};

class ServerMemoryRepository implements IRepository<ServerMemoryExportShape> {
  /**
   * Returns the count of documents in the documents table for a server.
   *
   */
  async countDocuments(serverId: number): Promise<number> {
    try {
      const [row] = await sql<[{ doc_count: string | number }]>`
        SELECT COUNT(*) as doc_count FROM documents WHERE server_id = ${serverId}
      `;
      return Number(row?.doc_count || 0);
    } catch (error) {
      log.error(`Error counting documents for server ${serverId}:`, error);
      return 0;
    }
  }

  /**
   * Loads server memories scoped to a persona lineage, with optional user filter.
   * Used by /memory server edit and /memory server remove to populate the selection list.
   *
   * @param userId           - If provided, only returns memories owned by this user
   * @returns Ordered array of ServerMemoryRow (newest first)
   */
  async loadServerMemoriesScoped(
    serverId: number,
    personaLineageId: number,
    userId?: number,
  ): Promise<ServerMemoryRow[]> {
    try {
      if (userId !== undefined) {
        return await sql<ServerMemoryRow[]>`
          SELECT server_memory_id, server_id, persona_id, persona_lineage_id, user_id, content, tags, created_at, updated_at
          FROM server_memories
          WHERE server_id = ${serverId}
            AND persona_lineage_id = ${personaLineageId}
            AND user_id = ${userId}
          ORDER BY created_at DESC, server_memory_id DESC
        `;
      }
      return await sql<ServerMemoryRow[]>`
        SELECT server_memory_id, server_id, persona_id, persona_lineage_id, user_id, content, tags, created_at, updated_at
        FROM server_memories
        WHERE server_id = ${serverId}
          AND persona_lineage_id = ${personaLineageId}
        ORDER BY created_at DESC, server_memory_id DESC
      `;
    } catch (error) {
      log.error(`Error loading server memories for server ${serverId} lineage ${personaLineageId}:`, error);
      return [];
    }
  }

  /**
   * Returns the set of persona lineage ids that have at least one server memory
   * in the given server. Batched eligibility source for `/memory server` picker
   * filters: it reproduces exactly the filters `loadServerMemoriesScoped` applies
   * (server scope, plus the optional owner filter) so the filtered picker and the
   * loader always agree.
   *
   * @param userId   - If provided, restricts to memories owned by this user, so a
   *                   manager and a non-manager can receive different eligible sets
   *                   for the same command in the same guild.
   * @returns Set of eligible `persona_lineage_id` values.
   */
  async lineageIdsWithServerMemories(serverId: number, userId?: number): Promise<Set<number>> {
    try {
      const rows =
        userId !== undefined
          ? await sql<Array<{ persona_lineage_id: number | string }>>`
              SELECT DISTINCT persona_lineage_id
              FROM server_memories
              WHERE server_id = ${serverId}
                AND user_id = ${userId}
            `
          : await sql<Array<{ persona_lineage_id: number | string }>>`
              SELECT DISTINCT persona_lineage_id
              FROM server_memories
              WHERE server_id = ${serverId}
            `;
      return new Set(rows.map((row) => Number(row.persona_lineage_id)));
    } catch (error) {
      log.error(`Error loading lineage ids with server memories for server ${serverId}:`, error);
      return new Set();
    }
  }

  /**
   * Server memory count per persona lineage, for the panel's persona selector.
   *
   * Omits a lineage with no memories rather than mapping it to zero, matching
   * `PersonalMemoryRepository.memoryCountsByLineage`. The panel must not substitute a guess when a
   * lineage is absent: the count it renders is read as authoritative.
   *
   * @param userId - If provided, counts only memories taught by this user, matching the owner
   *                 filter `loadServerMemoriesScoped` applies for a non-manager
   */
  async memoryCountsByLineage(serverId: number, userId?: number): Promise<Map<number, number>> {
    try {
      const rows =
        userId !== undefined
          ? await sql<Array<{ persona_lineage_id: number | string; count: number | string }>>`
              SELECT persona_lineage_id, COUNT(*) AS count
              FROM server_memories
              WHERE server_id = ${serverId}
                AND user_id = ${userId}
              GROUP BY persona_lineage_id
            `
          : await sql<Array<{ persona_lineage_id: number | string; count: number | string }>>`
              SELECT persona_lineage_id, COUNT(*) AS count
              FROM server_memories
              WHERE server_id = ${serverId}
              GROUP BY persona_lineage_id
            `;
      return new Map(rows.map((row) => [Number(row.persona_lineage_id), Number(row.count)]));
    } catch (error) {
      log.error(`Error counting server memories by lineage for server ${serverId}:`, error);
      return new Map();
    }
  }

  /**
   * Document count per persona, plus the serverwide scope's own count.
   *
   * Serverwide is a separate field because `persona_id IS NULL` is a real scope here with its own
   * rows, and null cannot key a Map. Applies no `source_type` filter, matching `loadDocuments` and
   * `personaIdsWithDocuments`, so a history-sourced document counts exactly as it does in the list
   * the user is reading.
   */
  async documentCountsByPersona(serverId: number): Promise<{ byPersona: Map<number, number>; serverwide: number }> {
    try {
      const rows = await sql<Array<{ persona_id: number | string | null; count: number | string }>>`
        SELECT persona_id, COUNT(*) AS count
        FROM documents
        WHERE server_id = ${serverId}
        GROUP BY persona_id
      `;
      const byPersona = new Map<number, number>();
      let serverwide = 0;
      for (const row of rows) {
        if (row.persona_id === null) {
          serverwide = Number(row.count);
          continue;
        }
        byPersona.set(Number(row.persona_id), Number(row.count));
      }
      return { byPersona, serverwide };
    } catch (error) {
      log.error(`Error counting documents by persona for server ${serverId}:`, error);
      return { byPersona: new Map(), serverwide: 0 };
    }
  }

  /**
   * Returns all memory content strings for a server + persona lineage.
   * Used for case-insensitive duplicate detection before insert.
   *
   */
  async loadServerMemoryContents(serverId: number, personaLineageId: number): Promise<string[]> {
    try {
      const rows = await sql<Array<{ content: string }>>`
        SELECT content
        FROM server_memories
        WHERE server_id = ${serverId}
          AND persona_lineage_id = ${personaLineageId}
      `;
      return rows.map((r) => r.content);
    } catch (error) {
      log.error(`Error loading server memory contents for server ${serverId}:`, error);
      return [];
    }
  }

  /**
   * Returns memory content and tags for in-character history extraction context.
   * The caller owns any channel-tag filtering because it has the import channel set.
   *
   * @returns Newest-first rows containing content and optional tags
   */
  async loadServerMemoryContentTags(
    serverId: number,
    personaLineageId: number,
  ): Promise<Array<{ content: string; tags: string[] | null }>> {
    try {
      return await sql<Array<{ content: string; tags: string[] | null }>>`
        SELECT content, tags
        FROM server_memories
        WHERE server_id = ${serverId}
          AND persona_lineage_id = ${personaLineageId}
        ORDER BY created_at DESC
      `;
    } catch (error) {
      log.error(`Error loading server memory content/tags for server ${serverId}:`, error);
      return [];
    }
  }

  /**
   * Returns true if a document with the given name already exists in the scope.
   * Used for duplicate-name checking before insert.
   *
   * @param personaId     - null = serverwide scope; non-null = per-persona scope
   */
  async documentExistsByName(serverId: number, personaId: number | null, documentName: string): Promise<boolean> {
    try {
      const rows =
        personaId === null
          ? await sql`
              SELECT document_id FROM documents
              WHERE server_id = ${serverId}
                AND persona_id IS NULL
                AND document_name = ${documentName}
              LIMIT 1
            `
          : await sql`
              SELECT document_id FROM documents
              WHERE server_id = ${serverId}
                AND persona_id = ${personaId}
                AND document_name = ${documentName}
              LIMIT 1
            `;
      return rows.length > 0;
    } catch (error) {
      log.error(`Error checking document existence for server ${serverId}:`, error);
      return false;
    }
  }

  /**
   * Returns the count of documents in the given server + scope.
   *
   * @param personaId - null = serverwide scope; non-null = per-persona scope
   */
  async countDocumentsScoped(serverId: number, personaId: number | null): Promise<number> {
    try {
      const [row] =
        personaId === null
          ? await sql<[{ doc_count: string | number }]>`
              SELECT COUNT(*) as doc_count
              FROM documents
              WHERE server_id = ${serverId}
                AND persona_id IS NULL
            `
          : await sql<[{ doc_count: string | number }]>`
              SELECT COUNT(*) as doc_count
              FROM documents
              WHERE server_id = ${serverId}
                AND persona_id = ${personaId}
            `;
      return Number(row?.doc_count || 0);
    } catch (error) {
      log.error(`Error counting documents for server ${serverId}:`, error);
      return 0;
    }
  }

  /**
   * Returns the count of document chunks across all documents in the given server + scope.
   *
   * @param personaId - null = serverwide scope; non-null = per-persona scope
   */
  async countChunksScoped(serverId: number, personaId: number | null): Promise<number> {
    try {
      const [row] =
        personaId === null
          ? await sql<[{ chunk_count: string | number }]>`
              SELECT COUNT(*) as chunk_count
              FROM document_chunks dc
              JOIN documents d ON d.document_id = dc.document_id
              WHERE d.server_id = ${serverId}
                AND d.persona_id IS NULL
            `
          : await sql<[{ chunk_count: string | number }]>`
              SELECT COUNT(*) as chunk_count
              FROM document_chunks dc
              JOIN documents d ON d.document_id = dc.document_id
              WHERE d.server_id = ${serverId}
                AND d.persona_id = ${personaId}
            `;
      return Number(row?.chunk_count || 0);
    } catch (error) {
      log.error(`Error counting chunks for server ${serverId}:`, error);
      return 0;
    }
  }

  /**
   * Returns true if any document exists for the given server + RAG scope.
   * For persona scope, also checks serverwide documents (persona_id IS NULL)
   * since RAG retrieval includes shared docs.
   *
   * @param personaId - null = serverwide only; non-null = persona OR serverwide
   */
  async hasDocumentInScope(serverId: number, personaId: number | null): Promise<boolean> {
    try {
      const rows =
        personaId === null
          ? await sql`
              SELECT document_id FROM documents
              WHERE server_id = ${serverId}
                AND persona_id IS NULL
              LIMIT 1
            `
          : await sql`
              SELECT document_id FROM documents
              WHERE server_id = ${serverId}
                AND (persona_id = ${personaId} OR persona_id IS NULL)
              LIMIT 1
            `;
      return rows.length > 0;
    } catch (error) {
      log.error(`Error checking document existence for server ${serverId}:`, error);
      return false;
    }
  }

  async edit(serverMemoryId: number, content: string, tags: string[] = []): Promise<boolean> {
    try {
      const [updated] = await sql`
        UPDATE server_memories
        SET content = ${content}, tags = ${sql.array(tags, "TEXT")}, updated_at = NOW()
        WHERE server_memory_id = ${serverMemoryId}
        RETURNING server_memory_id
      `;
      return !!updated;
    } catch (error) {
      log.error(`Error editing server memory ${serverMemoryId}:`, error);
      return false;
    }
  }

  async remove(serverMemoryId: number): Promise<boolean> {
    try {
      const [deleted] = await sql`
        DELETE FROM server_memories
        WHERE server_memory_id = ${serverMemoryId}
        RETURNING server_memory_id
      `;
      return !!deleted;
    } catch (error) {
      log.error(`Error removing server memory ${serverMemoryId}:`, error);
      return false;
    }
  }

  /**
   * Batch-inserts multiple server memories in a single transaction.
   * All rows share the same serverId, personaId, personaLineageId, userId, and tags.
   * Rolls back all inserts if any row fails (atomicity guarantee).
   * Cache invalidation is the caller's responsibility after a successful return.
   *
   * @param personaLineageId - Persona lineage scope for all memories
   * @param tags             - Optional classification tags applied to all memories
   * @returns true on full success, false if the transaction was rolled back
   */
  async addBatch(
    serverId: number,
    personaId: number,
    personaLineageId: number,
    taughtByUserId: number,
    memories: string[],
    tags: string[] = [],
  ): Promise<boolean> {
    if (memories.length === 0) return true;

    try {
      await sql.transaction(async (tx) => {
        for (const memory of memories) {
          await tx`
            INSERT INTO server_memories (server_id, persona_id, persona_lineage_id, user_id, content, tags)
            VALUES (${serverId}, ${personaId}, ${personaLineageId}, ${taughtByUserId}, ${memory}, ${sql.array(tags, "TEXT")})
          `;
        }
      });
      return true;
    } catch (error) {
      const context: ErrorContext = {
        serverId,
        personaId,
        userId: taughtByUserId,
        errorType: "DatabaseInsertError",
        metadata: {
          operation: "addBatchServerMemories",
          personaLineageId,
          insertCount: memories.length,
        },
      };
      await log.error(
        `Error batch-inserting server memories for server ${serverId} tomori ${personaId}`,
        error,
        context,
      );
      return false;
    }
  }

  /**
   * Inserts a new server memory taught by Tomori.
   * Invalidates the tomori state cache so the next context build reads the new memory.
   *
   * @param serverDiscId    - Discord server snowflake (required for cache invalidation)
   * @returns Inserted ServerMemoryRow or null on failure
   */
  async add(
    serverId: number,
    personaId: number,
    personaLineageId: number,
    taughtByUserId: number,
    content: string,
    tags: string[] = [],
    serverDiscId?: string,
  ): Promise<ServerMemoryRow | null> {
    log.info(
      `Attempting to learn a server memory for server ID ${serverId}, tomori ID ${personaId}, lineage ${personaLineageId} (triggered by user ID ${taughtByUserId}): "${content.substring(0, 50)}..."`,
    );

    const contentValidation = validateMemoryContent(content);
    if (!contentValidation.isValid) {
      log.warn(`Server memory content validation failed for server ID ${serverId}: ${contentValidation.error}`);
      return null;
    }

    const serverLimitCheck = await this.checkServerMemoryLimit(serverId, personaLineageId);
    if (!serverLimitCheck.isValid) {
      log.warn(
        `Server memory limit exceeded for server ID ${serverId}: ${serverLimitCheck.currentCount}/${serverLimitCheck.maxAllowed}`,
      );
      return null;
    }

    const row = await this.addServerMemoryRow(serverId, personaId, personaLineageId, taughtByUserId, content, tags);
    if (row && serverDiscId) invalidateTomoriStateCache(serverDiscId);
    return row;
  }

  /**
   *
   * @param personaLineageId - Optional persona lineage scope
   * @returns MemoryValidationResult indicating whether the limit is exceeded
   */
  async checkServerMemoryLimit(serverId: number, personaLineageId?: number): Promise<MemoryValidationResult> {
    const limits = getMemoryLimits();

    try {
      const [countResult] =
        personaLineageId !== undefined
          ? await sql`
              SELECT COUNT(*) as memory_count
              FROM server_memories
              WHERE server_id = ${serverId}
                AND persona_lineage_id = ${personaLineageId}
            `
          : await sql`
              SELECT COUNT(*) as memory_count
              FROM server_memories
              WHERE server_id = ${serverId}
            `;

      const currentCount = Number(countResult?.memory_count || 0);

      if (currentCount >= limits.maxServerMemories) {
        return {
          isValid: false,
          error: "SERVER_MEMORY_LIMIT_EXCEEDED",
          currentCount,
          maxAllowed: limits.maxServerMemories,
        };
      }

      return { isValid: true, currentCount, maxAllowed: limits.maxServerMemories };
    } catch (error) {
      log.error(`Error checking server memory limit for server ${serverId}:`, error);
      return { isValid: false, error: "SERVER_MEMORY_LIMIT_EXCEEDED" };
    }
  }

  /**
   * Reads server_memory_configs for the given server.
   * Memory rows are exported by ExportRepository; this method covers the config table.
   *
   */
  async toExportShape(ownerId: string | number): Promise<ServerMemoryExportShape | null> {
    const serverDiscId = String(ownerId);
    const serverId = await this.resolveServerId(serverDiscId);
    if (!serverId) return null;

    const memoryConfigs = await this.sqlLoadMemoryConfigs(serverId);
    return { server_disc_id: serverDiscId, memory_configs: memoryConfigs, memories: [] };
  }

  /**
   * Restores server_memory_configs for a server.
   */
  async fromExportShape(ownerId: string | number, data: ServerMemoryExportShape): Promise<boolean> {
    const serverDiscId = String(ownerId);
    const serverId = await this.resolveServerId(serverDiscId);
    if (!serverId) {
      log.error(`ServerMemoryRepository.fromExportShape: server ${serverDiscId} not found`);
      return false;
    }

    if (!data.memory_configs) return true;

    try {
      await this.sqlUpsertMemoryConfigs(serverId, data.memory_configs);
      invalidateTomoriStateCache(serverDiscId);
      return true;
    } catch (error) {
      log.error(`ServerMemoryRepository.fromExportShape: write failed for ${serverDiscId}:`, error);
      return false;
    }
  }

  private async resolveServerId(serverDiscId: string): Promise<number | null> {
    const [row] = await sql`
      SELECT server_id FROM servers WHERE server_disc_id = ${serverDiscId} LIMIT 1
    `;
    return (row?.server_id as number | undefined) ?? null;
  }

  private async sqlLoadMemoryConfigs(serverId: number): Promise<ServerMemoryConfigsRow | null> {
    try {
      const [row] = await sql`
        SELECT memory_tagging_enabled FROM server_memory_configs WHERE server_id = ${serverId}
      `;
      return row ? (row as unknown as ServerMemoryConfigsRow) : null;
    } catch (error) {
      log.error(`Error loading server_memory_configs for server ${serverId}:`, error);
      return null;
    }
  }

  private async sqlUpsertMemoryConfigs(serverId: number, row: ServerMemoryConfigsRow): Promise<void> {
    await sql`
      INSERT INTO server_memory_configs (server_id, memory_tagging_enabled)
      VALUES (${serverId}, ${row.memory_tagging_enabled})
      ON CONFLICT (server_id) DO UPDATE SET
        memory_tagging_enabled = EXCLUDED.memory_tagging_enabled,
        updated_at             = NOW()
    `;
  }

  /**
   * Load non-history documents for a server/tomori scope.
   *
   * @param personaId - Null = server-wide (shared) scope; non-null = per-persona scope
   */
  async loadDocuments(
    serverId: number,
    personaId: number | null,
  ): Promise<Array<{ document_id: number; document_name: string; first_chunk: string | null }>> {
    if (personaId === null) {
      return await sql<Array<{ document_id: number; document_name: string; first_chunk: string | null }>>`
        SELECT d.document_id, d.document_name, dc.content AS first_chunk
        FROM documents d
        LEFT JOIN document_chunks dc
          ON dc.document_id = d.document_id
          AND dc.chunk_index = 0
        WHERE d.server_id = ${serverId}
          AND d.persona_id IS NULL
        ORDER BY d.created_at DESC
      `;
    }
    return await sql<Array<{ document_id: number; document_name: string; first_chunk: string | null }>>`
      SELECT d.document_id, d.document_name, dc.content AS first_chunk
      FROM documents d
      LEFT JOIN document_chunks dc
        ON dc.document_id = d.document_id
        AND dc.chunk_index = 0
      WHERE d.server_id = ${serverId}
        AND d.persona_id = ${personaId}
      ORDER BY d.created_at DESC
    `;
  }

  /**
   * Returns the set of persona ids that own at least one document in the given
   * server. Batched eligibility source for the persona-scoped `/memory document`
   * picker filters. Mirrors `loadDocuments` for persona scope, which deliberately
   * applies **no** `source_type` filter: history-sourced documents count here
   * exactly as they do in that loader. Serverwide documents (`persona_id IS NULL`)
   * are excluded because the persona picker only concerns persona-owned rows.
   *
   * @returns Set of eligible `persona_id` values.
   */
  async personaIdsWithDocuments(serverId: number): Promise<Set<number>> {
    try {
      const rows = await sql<Array<{ persona_id: number | string }>>`
        SELECT DISTINCT persona_id
        FROM documents
        WHERE server_id = ${serverId}
          AND persona_id IS NOT NULL
      `;
      return new Set(rows.map((row) => Number(row.persona_id)));
    } catch (error) {
      log.error(`Error loading persona ids with documents for server ${serverId}:`, error);
      return new Set();
    }
  }

  /**
   * Delete a document (chunks cascade-delete via FK).
   *
   * @param serverId   - Internal server DB ID (ownership guard)
   * @param personaId   - Null = server-wide scope; non-null = per-persona scope
   * @returns Deleted document_name or null when not found
   */
  async loadDocumentChunks(
    documentId: number,
    serverId: number,
    personaId: number | null,
  ): Promise<Array<{ document_chunk_id: number; chunk_index: number; content: string }>> {
    return personaId === null
      ? await sql<Array<{ document_chunk_id: number; chunk_index: number; content: string }>>`
          SELECT dc.document_chunk_id, dc.chunk_index, dc.content
          FROM document_chunks dc
          JOIN documents d ON d.document_id = dc.document_id
          WHERE dc.document_id = ${documentId}
            AND dc.server_id = ${serverId}
            AND d.persona_id IS NULL
          ORDER BY dc.chunk_index ASC
        `
      : await sql<Array<{ document_chunk_id: number; chunk_index: number; content: string }>>`
          SELECT dc.document_chunk_id, dc.chunk_index, dc.content
          FROM document_chunks dc
          JOIN documents d ON d.document_id = dc.document_id
          WHERE dc.document_id = ${documentId}
            AND dc.server_id = ${serverId}
            AND d.persona_id = ${personaId}
          ORDER BY dc.chunk_index ASC
        `;
  }

  /**
   * Updates a single chunk's content and embedding. Used by /memory document view edit flow.
   * The chunk's embedding_model_id and embedding_family are overwritten to match the
   * model that produced the new embedding, so retrieval keeps working.
   */
  async updateChunk(params: {
    chunkId: number;
    serverId: number;
    personaId: number | null;
    content: string;
    embeddingVector: string;
    embeddingModelId: number;
    embeddingFamily: string;
  }): Promise<boolean> {
    const { chunkId, serverId, personaId, content, embeddingVector, embeddingModelId, embeddingFamily } = params;
    try {
      const [updated] =
        personaId === null
          ? await sql`
              UPDATE document_chunks
              SET content = ${content},
                  embedding = ${embeddingVector}::vector,
                  embedding_model_id = ${embeddingModelId},
                  embedding_family = ${embeddingFamily}
              FROM documents
              WHERE document_chunks.document_chunk_id = ${chunkId}
                AND document_chunks.server_id = ${serverId}
                AND document_chunks.document_id = documents.document_id
                AND documents.persona_id IS NULL
              RETURNING document_chunks.document_chunk_id
            `
          : await sql`
              UPDATE document_chunks
              SET content = ${content},
                  embedding = ${embeddingVector}::vector,
                  embedding_model_id = ${embeddingModelId},
                  embedding_family = ${embeddingFamily}
              FROM documents
              WHERE document_chunks.document_chunk_id = ${chunkId}
                AND document_chunks.server_id = ${serverId}
                AND document_chunks.document_id = documents.document_id
                AND documents.persona_id = ${personaId}
              RETURNING document_chunks.document_chunk_id
            `;
      return !!updated;
    } catch (error) {
      log.error(`Error updating chunk ${chunkId}:`, error);
      return false;
    }
  }

  /**
   * Deletes a single chunk by ID. Returns true on success.
   * Leaves a gap in chunk_index; callers should rebuild text_content separately if needed.
   */
  async deleteChunk(chunkId: number, serverId: number, personaId: number | null): Promise<boolean> {
    try {
      const [deleted] =
        personaId === null
          ? await sql`
              DELETE FROM document_chunks
              USING documents
              WHERE document_chunks.document_chunk_id = ${chunkId}
                AND document_chunks.server_id = ${serverId}
                AND document_chunks.document_id = documents.document_id
                AND documents.persona_id IS NULL
              RETURNING document_chunks.document_chunk_id
            `
          : await sql`
              DELETE FROM document_chunks
              USING documents
              WHERE document_chunks.document_chunk_id = ${chunkId}
                AND document_chunks.server_id = ${serverId}
                AND document_chunks.document_id = documents.document_id
                AND documents.persona_id = ${personaId}
              RETURNING document_chunks.document_chunk_id
            `;
      return !!deleted;
    } catch (error) {
      log.error(`Error deleting chunk ${chunkId}:`, error);
      return false;
    }
  }

  /**
   * Loads document metadata needed by the view/edit flow (name + channel_tags).
   * Returns null if the document doesn't exist or belongs to a different server.
   */
  async loadDocumentMeta(
    documentId: number,
    serverId: number,
    personaId: number | null,
  ): Promise<{ document_name: string; channel_tags: string[] } | null> {
    const [row] =
      personaId === null
        ? await sql<Array<{ document_name: string; channel_tags: string[] | null }>>`
            SELECT document_name, channel_tags
            FROM documents
            WHERE document_id = ${documentId}
              AND server_id = ${serverId}
              AND persona_id IS NULL
            LIMIT 1
          `
        : await sql<Array<{ document_name: string; channel_tags: string[] | null }>>`
            SELECT document_name, channel_tags
            FROM documents
            WHERE document_id = ${documentId}
              AND server_id = ${serverId}
              AND persona_id = ${personaId}
            LIMIT 1
          `;
    if (!row) return null;
    return { document_name: row.document_name, channel_tags: row.channel_tags ?? [] };
  }

  /**
   * Replaces a document's channel_tags array. Empty array = available in all channels.
   */
  async updateDocumentChannelTags(
    documentId: number,
    serverId: number,
    channelTags: string[],
    personaId: number | null,
  ): Promise<boolean> {
    try {
      const [updated] =
        personaId === null
          ? await sql`
              UPDATE documents
              SET channel_tags = ${sql.array(channelTags, "TEXT")}
              WHERE document_id = ${documentId}
                AND server_id = ${serverId}
                AND persona_id IS NULL
              RETURNING document_id
            `
          : await sql`
              UPDATE documents
              SET channel_tags = ${sql.array(channelTags, "TEXT")}
              WHERE document_id = ${documentId}
                AND server_id = ${serverId}
                AND persona_id = ${personaId}
              RETURNING document_id
            `;
      return !!updated;
    } catch (error) {
      log.error(`Error updating channel_tags for document ${documentId}:`, error);
      return false;
    }
  }

  async removeDocument(documentId: number, serverId: number, personaId: number | null): Promise<string | null> {
    const rows =
      personaId === null
        ? await sql`
            DELETE FROM documents
            WHERE document_id = ${documentId}
              AND server_id = ${serverId}
              AND persona_id IS NULL
            RETURNING document_name
          `
        : await sql`
            DELETE FROM documents
            WHERE document_id = ${documentId}
              AND server_id = ${serverId}
              AND persona_id = ${personaId}
            RETURNING document_name
          `;
    return (rows[0]?.document_name as string | undefined) ?? null;
  }

  /**
   * Load history-sourced documents for a server/tomori scope.
   *
   * @param personaId - Null = server-wide scope; non-null = per-persona scope
   */
  async loadHistoryDocuments(
    serverId: number,
    personaId: number | null,
  ): Promise<Array<{ document_id: number; document_name: string }>> {
    if (personaId === null) {
      return await sql<Array<{ document_id: number; document_name: string }>>`
        SELECT document_id, document_name
        FROM documents
        WHERE server_id = ${serverId}
          AND persona_id IS NULL
          AND source_type = 'history'
        ORDER BY created_at DESC
      `;
    }
    return await sql<Array<{ document_id: number; document_name: string }>>`
      SELECT document_id, document_name
      FROM documents
      WHERE server_id = ${serverId}
        AND persona_id = ${personaId}
        AND source_type = 'history'
      ORDER BY created_at DESC
    `;
  }

  /**
   * Returns the set of persona ids that own at least one history-sourced document
   * in the given server. Batched eligibility source for the persona-scoped
   * `/memory history` picker filter. Reproduces the `source_type = 'history'`
   * filter `loadHistoryDocuments` applies, so a persona that has upload documents
   * but no history documents is correctly excluded here even though it appears in
   * {@link personaIdsWithDocuments}.
   *
   * @returns Set of eligible `persona_id` values.
   */
  async personaIdsWithHistoryDocuments(serverId: number): Promise<Set<number>> {
    try {
      const rows = await sql<Array<{ persona_id: number | string }>>`
        SELECT DISTINCT persona_id
        FROM documents
        WHERE server_id = ${serverId}
          AND persona_id IS NOT NULL
          AND source_type = 'history'
      `;
      return new Set(rows.map((row) => Number(row.persona_id)));
    } catch (error) {
      log.error(`Error loading persona ids with history documents for server ${serverId}:`, error);
      return new Set();
    }
  }

  /**
   * Delete a history-sourced document (chunks cascade-delete via FK).
   *
   * @param serverId   - Internal server DB ID (ownership guard)
   * @param personaId   - Null = server-wide scope; non-null = per-persona scope
   * @returns Deleted document_name or null when not found
   */
  async removeHistoryDocument(documentId: number, serverId: number, personaId: number | null): Promise<string | null> {
    const rows =
      personaId === null
        ? await sql`
            DELETE FROM documents
            WHERE document_id = ${documentId}
              AND server_id = ${serverId}
              AND persona_id IS NULL
              AND source_type = 'history'
            RETURNING document_name
          `
        : await sql`
            DELETE FROM documents
            WHERE document_id = ${documentId}
              AND server_id = ${serverId}
              AND persona_id = ${personaId}
              AND source_type = 'history'
            RETURNING document_name
          `;
    return (rows[0]?.document_name as string | undefined) ?? null;
  }

  /**
   * Delete a server memory scoped to server + persona lineage.
   * Used by the updateLongTermMemoryTool function call handler.
   *
   * @param serverId         - Internal server DB ID (ownership guard)
   * @param personaLineageId - Persona lineage scope guard
   * @returns Row with server_memory_id, content, user_id or null when not found
   */
  async removeByIdWithLineage(
    memoryId: number,
    serverId: number,
    personaLineageId: number,
  ): Promise<{ server_memory_id: number; content: string; user_id: number } | null> {
    const [row] = await sql`
      DELETE FROM server_memories
      WHERE server_memory_id = ${memoryId}
        AND server_id = ${serverId}
        AND persona_lineage_id = ${personaLineageId}
      RETURNING server_memory_id, content, user_id
    `;
    return row
      ? {
          server_memory_id: row.server_memory_id as number,
          content: row.content as string,
          user_id: row.user_id as number,
        }
      : null;
  }

  /**
   * Update a server memory's content, scoped to server + persona lineage.
   * Used by the updateLongTermMemoryTool function call handler.
   *
   * @param personaLineageId - Persona lineage scope guard
   * @returns Row with server_memory_id, content, user_id or null when not found
   */
  async updateByIdWithLineage(
    memoryId: number,
    content: string,
    serverId: number,
    personaLineageId: number,
  ): Promise<{ server_memory_id: number; content: string; user_id: number } | null> {
    const [row] = await sql`
      UPDATE server_memories
      SET content = ${content}, updated_at = CURRENT_TIMESTAMP
      WHERE server_memory_id = ${memoryId}
        AND server_id = ${serverId}
        AND persona_lineage_id = ${personaLineageId}
      RETURNING server_memory_id, content, user_id
    `;
    return row
      ? {
          server_memory_id: row.server_memory_id as number,
          content: row.content as string,
          user_id: row.user_id as number,
        }
      : null;
  }

  private async addServerMemoryRow(
    serverId: number,
    personaId: number,
    personaLineageId: number,
    taughtByUserId: number,
    content: string,
    tags: string[],
  ): Promise<ServerMemoryRow | null> {
    try {
      const [newMemory] = await sql`
        INSERT INTO server_memories (server_id, persona_id, persona_lineage_id, user_id, content, tags)
        VALUES (${serverId}, ${personaId}, ${personaLineageId}, ${taughtByUserId}, ${content}, ${sql.array(tags, "TEXT")})
        RETURNING *
      `;

      const validatedMemory = serverMemorySchema.safeParse(newMemory);
      if (!validatedMemory.success) {
        const context: ErrorContext = {
          serverId,
          personaId,
          userId: taughtByUserId,
          errorType: "SchemaValidationError",
          metadata: {
            operation: "addServerMemoryByTomori",
            contentAttempted: content.substring(0, 100),
            validationErrors: validatedMemory.error.flatten(),
          },
        };
        await log.error(
          `Failed to validate new server memory for server ID ${serverId}`,
          validatedMemory.error,
          context,
        );
        return null;
      }

      log.success(
        `Tomori successfully saved a new server memory (ID: ${validatedMemory.data.server_memory_id}) for server ID ${serverId}, tomori ID ${personaId}, taught by user ID ${taughtByUserId}.`,
      );
      return validatedMemory.data;
    } catch (error) {
      const context: ErrorContext = {
        serverId,
        personaId,
        userId: taughtByUserId,
        errorType: "DatabaseInsertError",
        metadata: {
          operation: "addServerMemoryByTomori",
          contentAttempted: content.substring(0, 100),
        },
      };
      await log.error(`Error adding server memory for server ID ${serverId}`, error, context);
      return null;
    }
  }
}

/** Singleton instance: import this in callers. */
export const serverMemoryRepository = new ServerMemoryRepository();
