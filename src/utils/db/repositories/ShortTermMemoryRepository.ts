/**
 * ShortTermMemoryRepository: manages in-conversation short-term working memory.
 *
 * Architecture (post migration 051):
 *   - Per-channel durable state (categories, summary, turn counters) lives in
 *     `short_term_memories` and is kept hot by shortTermMemoryCache.ts via
 *     read-through / write-through. State methods here delegate to the cache.
 *   - Per-server configuration (cadence, render mode, prompt overrides) lives in
 *     `server_stm_configs` and `stm_categories`. Those are managed directly by
 *     this repository since the cache layer has no config awareness.
 *
 * Export contract: toExportShape / fromExportShape export STM *config only*
 * (cadence, render mode, prompt overrides, category definitions). Per-channel
 * durable state is volatile and excluded from exports per design decision 8.
 */
import { sql } from "@/utils/db/client";
import type { ServerStmConfigRow, StmCategoryRow } from "@/types/db/schema";
import { serverStmConfigSchema, stmCategorySchema } from "@/types/db/schema";
import {
  storeShortTermMemory,
  getShortTermMemoriesForUser,
  getShortTermMemoriesForServer,
  getShortTermMemoryForUserChannel,
  getShortTermMemoryForServerChannel,
  updateShortTermMemorySummary,
  clearShortTermMemorySummary,
  updateShortTermMemoryCategories,
  incrementStmTurnCounter,
  resetStmTurnCounter,
  invalidateShortTermMemory,
  clearShortTermMemoryForChannel,
  clearShortTermMemoryForServerChannel,
  clearShortTermMemoryForUser,
  type ShortTermMemoryEntry,
} from "@/utils/cache/shortTermMemoryCache";
import { log } from "@/utils/misc/logger";
import type { IRepository } from "./IRepository";

/**
 * Exported shape for STM config (config only: per-channel state is excluded).
 * Consumed by the Phase 6 export pipeline and `/export config`.
 */
type ShortTermMemoryExportShape = {
  stm_config: {
    refresh_cadence: number;
    render_mode: "supersede" | "crude_summary";
    crude_message_count: number;
    tool_description_override: string | null;
    update_nudge_override: string | null;
    nudge_injection_depth?: number;
    content_injection_depth?: number;
  } | null;
  stm_categories: Array<{
    position: number;
    label: string;
    description: string;
  }>;
};

class ShortTermMemoryRepository implements IRepository<ShortTermMemoryExportShape> {
  // ── cache-delegating reads ─────────────────────────────────────────────────

  /**
   * Returns all active short-term memory entries for a user across channels.
   *
   * @param userId - Discord user snowflake
   */
  getForUser(userId: string): ShortTermMemoryEntry[] {
    return getShortTermMemoriesForUser(userId);
  }

  /**
   * Returns all active short-term memory entries for a server across channels.
   *
   * @param serverId - Discord server snowflake
   */
  getForServer(serverId: string): ShortTermMemoryEntry[] {
    return getShortTermMemoriesForServer(serverId);
  }

  /**
   * Returns the STM entry for a specific user in a specific channel.
   *
   * @param userId    - Discord user snowflake
   * @param channelId - Discord channel snowflake
   */
  getForUserChannel(userId: string, channelId: string): ShortTermMemoryEntry | undefined {
    return getShortTermMemoryForUserChannel(userId, channelId);
  }

  /**
   * Returns the server-scoped STM entry for a specific channel.
   *
   * @param serverId  - Discord server snowflake
   * @param channelId - Discord channel snowflake
   */
  getForServerChannel(serverId: string, channelId: string): ShortTermMemoryEntry | undefined {
    return getShortTermMemoryForServerChannel(serverId, channelId);
  }

  /**
   * Returns the best available STM entry for a channel (user-scoped preferred,
   * falls back to server-scoped).
   */
  getForChannel(
    ...args: Parameters<typeof getShortTermMemoryForUserChannel>
  ): ReturnType<typeof getShortTermMemoryForUserChannel> {
    return getShortTermMemoryForUserChannel(...args);
  }

  // ── cache-delegating writes ────────────────────────────────────────────────

  /**
   * Stores a new short-term memory entry (also fires a durable DB upsert).
   */
  store(...args: Parameters<typeof storeShortTermMemory>): ReturnType<typeof storeShortTermMemory> {
    return storeShortTermMemory(...args);
  }

  /**
   * Updates the summary text of an existing STM entry (also fires a durable DB upsert).
   */
  updateSummary(
    ...args: Parameters<typeof updateShortTermMemorySummary>
  ): ReturnType<typeof updateShortTermMemorySummary> {
    return updateShortTermMemorySummary(...args);
  }

  /**
   * Updates the categories map for an STM entry (writes through to DB).
   */
  updateCategories(
    ...args: Parameters<typeof updateShortTermMemoryCategories>
  ): ReturnType<typeof updateShortTermMemoryCategories> {
    return updateShortTermMemoryCategories(...args);
  }

  /**
   * Clears the summary for an STM entry and persists that empty state.
   */
  clearSummary(
    ...args: Parameters<typeof clearShortTermMemorySummary>
  ): ReturnType<typeof clearShortTermMemorySummary> {
    return clearShortTermMemorySummary(...args);
  }

  /**
   * Increments the turn counter on the live scope row.
   */
  incrementTurnCounter(
    ...args: Parameters<typeof incrementStmTurnCounter>
  ): ReturnType<typeof incrementStmTurnCounter> {
    return incrementStmTurnCounter(...args);
  }

  /**
   * Resets the turn counter after a successful STM refresh.
   */
  resetTurnCounter(...args: Parameters<typeof resetStmTurnCounter>): ReturnType<typeof resetStmTurnCounter> {
    return resetStmTurnCounter(...args);
  }

  // ── cache-delegating invalidation ─────────────────────────────────────────

  /**
   * Invalidates (evicts from cache) a short-term memory entry.
   */
  invalidate(...args: Parameters<typeof invalidateShortTermMemory>): void {
    invalidateShortTermMemory(...args);
  }

  /**
   * Clears all STM cache entries for a channel.
   */
  clearForChannel(channelId: string): void {
    clearShortTermMemoryForChannel(channelId);
  }

  /**
   * Clears the cache entry scoped to a server + channel pair.
   */
  clearForServerChannel(...args: Parameters<typeof clearShortTermMemoryForServerChannel>): void {
    clearShortTermMemoryForServerChannel(...args);
  }

  /**
   * Clears all STM cache entries for a user across all channels.
   */
  clearForUser(userId: string): void {
    clearShortTermMemoryForUser(userId);
  }

  /**
   * Loads the STM config row for a server. Returns null when not yet set up.
   *
   * @param serverId - Internal server DB ID
   */
  async getStmConfig(serverId: number): Promise<ServerStmConfigRow | null> {
    try {
      const [row] = await sql`SELECT * FROM server_stm_configs WHERE server_id = ${serverId}`;
      if (!row) return null;
      const parsed = serverStmConfigSchema.safeParse(row);
      return parsed.success ? parsed.data : null;
    } catch (error) {
      log.error(`[STMRepo] Failed to load server_stm_configs for server ${serverId}`, error);
      return null;
    }
  }

  /**
   * Returns a set of persona_ids that have non-empty short-term memory stored in the specified channel and scope.
   *
   * @param scopeKind - "server" for guild channels, "user" for DMs
   * @param discId    - Server snowflake (server scope) or user snowflake (user scope)
   * @param channelId - Channel snowflake
   */
  async personaIdsWithStm(scopeKind: "server" | "user", discId: string, channelId: string): Promise<Set<number>> {
    try {
      const serverDiscId = scopeKind === "server" ? discId : null;
      const userDiscId = scopeKind === "user" ? discId : null;
      const rows = await sql<{ persona_id: number }[]>`
        SELECT persona_id
        FROM short_term_memories
        WHERE scope_kind = ${scopeKind}
          AND COALESCE(server_disc_id, '') = COALESCE(${serverDiscId}, '')
          AND COALESCE(user_disc_id, '')   = COALESCE(${userDiscId}, '')
          AND channel_disc_id = ${channelId}
          AND persona_id IS NOT NULL
          AND persona_id > 0
          AND (
            (summary IS NOT NULL AND TRIM(summary) != '')
            OR (categories IS NOT NULL AND categories != '{}'::jsonb)
          )
      `;
      return new Set(rows.map((r) => r.persona_id));
    } catch (error) {
      log.error("[STMRepo] Failed to resolve personaIdsWithStm", error);
      return new Set();
    }
  }

  /**
   * Loads the ordered category definitions for a server.
   * Returns the default 'summary' category when the server has none yet.
   *
   * @param serverId - Internal server DB ID
   */
  async getStmCategories(serverId: number): Promise<StmCategoryRow[]> {
    try {
      const rows = await sql`
        SELECT * FROM stm_categories
        WHERE server_id = ${serverId}
        ORDER BY position ASC
      `;

      const categories: StmCategoryRow[] = [];
      for (const row of rows) {
        const parsed = stmCategorySchema.safeParse(row);
        if (parsed.success) categories.push(parsed.data);
      }

      if (categories.length === 0) {
        // Fallback: return the implicit default so callers never get an empty list
        return [
          {
            server_id: serverId,
            position: 0,
            label: "summary",
            description: "A running summary of recent events, topics, and context from this conversation.",
          },
        ];
      }

      return categories;
    } catch (error) {
      log.error(`[STMRepo] Failed to load stm_categories for server ${serverId}`, error);
      return [
        {
          server_id: serverId,
          position: 0,
          label: "summary",
          description: "A running summary of recent events, topics, and context from this conversation.",
        },
      ];
    }
  }

  /**
   * Upserts the STM config row for a server (insert on first save, update thereafter).
   * Returns true on success.
   *
   * @param serverId - Internal server DB ID
   * @param patch    - Partial config fields to write
   */
  async upsertStmConfig(serverId: number, patch: Partial<Omit<ServerStmConfigRow, "server_id">>): Promise<boolean> {
    // Allowlist guards against column-name injection when building dynamic SQL.
    const ALLOWED_STM_CONFIG_COLS = new Set<string>([
      "refresh_cadence",
      "render_mode",
      "crude_message_count",
      "tool_description_override",
      "update_nudge_override",
      "nudge_injection_depth",
      "content_injection_depth",
    ]);

    const entries = Object.entries(patch).filter(([k, v]) => v !== undefined && ALLOWED_STM_CONFIG_COLS.has(k));
    if (entries.length === 0) return false;

    try {
      const cols = ["server_id", ...entries.map(([k]) => k)];
      const vals: unknown[] = [serverId, ...entries.map(([, v]) => v)];
      const setClause = entries.map(([k], i) => `${k} = $${i + 2}`).join(", ");
      const colList = cols.join(", ");
      const placeholders = vals.map((_, i) => `$${i + 1}`).join(", ");

      await sql.unsafe(
        `INSERT INTO server_stm_configs (${colList})
         VALUES (${placeholders})
         ON CONFLICT (server_id)
         DO UPDATE SET ${setClause}`,
        vals,
      );
      return true;
    } catch (error) {
      log.error(`[STMRepo] Failed to upsert server_stm_configs for server ${serverId}`, error);
      return false;
    }
  }

  /**
   * Replaces all category definitions for a server atomically.
   * Deletes existing rows, then inserts new ones inside a transaction.
   * Returns true on success.
   *
   * @param serverId   - Internal server DB ID
   * @param categories - Ordered array of category definitions (max 5)
   */
  async upsertStmCategories(
    serverId: number,
    categories: Array<{ position: number; label: string; description: string }>,
  ): Promise<boolean> {
    try {
      await sql.begin(async (tx) => {
        await tx`DELETE FROM stm_categories WHERE server_id = ${serverId}`;
        for (const cat of categories) {
          await tx`
            INSERT INTO stm_categories (server_id, position, label, description)
            VALUES (${serverId}, ${cat.position}, ${cat.label}, ${cat.description})
          `;
        }
      });
      return true;
    } catch (error) {
      log.error(`[STMRepo] Failed to upsert stm_categories for server ${serverId}`, error);
      return false;
    }
  }

  /**
   * Deletes durable `short_term_memories` rows untouched for longer than the
   * retention window, returning how many were removed. Cache entries are left
   * alone because they age out on their own TTL.
   *
   * @param retentionDays - Age threshold in days
   */
  async purgeStaleEntries(retentionDays: number): Promise<number> {
    const rows = await sql`
      DELETE FROM short_term_memories
      WHERE updated_at < NOW() - (${retentionDays} || ' days')::INTERVAL
      RETURNING stm_id
    `;
    return rows.length;
  }

  /**
   * Exports STM config (cadence, render mode, prompt overrides, category definitions)
   * for a server identified by its Discord snowflake.
   * Per-channel durable state is intentionally excluded (design decision 8).
   *
   * @param ownerId - Internal server DB ID or Discord server snowflake
   */
  async toExportShape(ownerId: string | number): Promise<ShortTermMemoryExportShape | null> {
    try {
      const serverDiscId = String(ownerId);

      // Resolve internal server_id from Discord snowflake
      const [serverRow] = await sql`SELECT server_id FROM servers WHERE server_disc_id = ${serverDiscId}`;
      if (!serverRow) return null;
      const serverId = serverRow.server_id as number;

      const [config, categories] = await Promise.all([this.getStmConfig(serverId), this.getStmCategories(serverId)]);

      return {
        stm_config: config
          ? {
              refresh_cadence: config.refresh_cadence,
              render_mode: config.render_mode,
              crude_message_count: config.crude_message_count,
              tool_description_override: config.tool_description_override ?? null,
              update_nudge_override: config.update_nudge_override ?? null,
              nudge_injection_depth: config.nudge_injection_depth,
              content_injection_depth: config.content_injection_depth,
            }
          : null,
        stm_categories: categories.map((c) => ({
          position: c.position,
          label: c.label,
          description: c.description,
        })),
      };
    } catch (error) {
      log.error("[STMRepo] toExportShape failed", error);
      return null;
    }
  }

  /**
   * Restores STM config for a server from a previously exported shape.
   * Per-channel state is intentionally skipped (design decision 8).
   *
   * @param ownerId - Internal server DB ID or Discord server snowflake
   * @param data    - Previously exported ShortTermMemoryExportShape
   */
  async fromExportShape(ownerId: string | number, data: ShortTermMemoryExportShape): Promise<boolean> {
    try {
      const serverDiscId = String(ownerId);
      const [serverRow] = await sql`SELECT server_id FROM servers WHERE server_disc_id = ${serverDiscId}`;
      if (!serverRow) {
        log.error(`[STMRepo] fromExportShape: server ${serverDiscId} not found`);
        return false;
      }
      const serverId = serverRow.server_id as number;

      const writes: Promise<boolean>[] = [];

      if (data.stm_config) {
        writes.push(this.upsertStmConfig(serverId, data.stm_config));
      }

      if (data.stm_categories.length > 0) {
        writes.push(this.upsertStmCategories(serverId, data.stm_categories));
      }

      if (writes.length === 0) return true;

      const results = await Promise.all(writes);
      return results.every(Boolean);
    } catch (error) {
      log.error("[STMRepo] fromExportShape failed", error);
      return false;
    }
  }
}

/** Singleton instance: import this in callers. */
export const shortTermMemoryRepository = new ShortTermMemoryRepository();
