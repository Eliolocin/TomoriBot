/**
 * Short-Term Memory Cache
 *
 * Stores recent conversations (up to the configured messages per channel) and tool-generated summaries
 * for cross-channel and cross-server awareness.
 *
 * Features:
 * - Cache-only crude conversations plus durable summaries, categories, and cadence state
 * - Separately configurable TTLs for crude conversations and summaries
 * - Persona-shared guild STM plus privacy-respecting cross-server user STM
 * - Relative timestamp formatting (e.g., "2 hours ago")
 *
 * Design:
 * - User key pattern: `shortterm:user:${userId}:${channelId}` or `shortterm:user:${userId}:${channelId}:${personaId}`
 * - Server key pattern: `shortterm:server:${serverId}:${channelId}` or `shortterm:server:${serverId}:${channelId}:${personaId}`
 * - Conversations: Most recent condensed turns (user + model messages), up to the configured limit
 * - Summaries: Tool-generated context that can augment or supersede crude conversations
 * - Cross-model compatible: Summaries created by any model work for all models
 */

import { sql } from "@/utils/db/client";
import { normalizeStmCategories, type ShortTermMemoryRow } from "@/types/db/schema";
import { log } from "@/utils/misc/logger";

/**
 * A single message in a short-term memory conversation
 */
interface ShortTermMessage {
  role: "user" | "model";
  content: string;
  timestamp: number;
  /** Original speaker name (persona name or username) for multi-persona labeling */
  speakerName?: string;
}

/**
 * A short-term memory entry for a specific channel
 */
export interface ShortTermMemoryEntry {
  /** Array of conversation messages, capped by the configured per-channel limit */
  messages: ShortTermMessage[];

  /** Optional tool-generated summary rendered according to the server STM mode */
  summary?: string;

  /** Structured memory categories for category-mode STM (slug → value map) */
  categories?: Record<string, string>;

  /** Turns elapsed since the last STM refresh (used for cadence-gated nudges) */
  turnsSinceRefresh?: number;

  /** Monotonic turn counter at the time of the last refresh */
  lastRefreshedTurn?: number;

  /** Discord server ID (or "DM" for direct messages) */
  serverId: string;

  /** Optional server name (for same-server channel mentions) */
  serverName?: string;

  /** Discord channel ID */
  channelId: string;

  /** Parent channel ID when channelId is a thread , so used for privacy/RP inheritance checks */
  parentChannelId?: string | null;

  /** Optional channel name (for same-server channel mentions) */
  channelName?: string;

  /** Tomori persona ID for persona-scoped memory */
  personaId?: number | null;

  /** Persona lineage ID for cross-server persona matching */
  personaLineageId?: number | null;

  /** Unix timestamp (ms) of last update */
  lastUpdated: number;
}

/**
 * Cache statistics for monitoring performance
 */
interface CacheStats {
  hits: number;
  misses: number;
  stores: number;
  invalidations: number;
  expirations: number;
}

const CRUDE_CONVERSATION_TTL_HOURS = Number.parseInt(process.env.SHORT_TERM_MEMORY_TTL_HOURS || "12", 10);
export const STM_MAX_CATEGORIES = Number.parseInt(process.env.STM_MAX_CATEGORIES || "5", 10);
const SUMMARY_TTL_HOURS = Number.parseInt(process.env.SHORT_TERM_MEMORY_SUMMARY_TTL_HOURS || "24", 10);
const MAX_SUMMARY_LENGTH = Number.parseInt(process.env.SHORT_TERM_MEMORY_MAX_SUMMARY_LENGTH || "1500", 10);
export const MAX_MESSAGES_PER_CHANNEL = Math.max(
  1,
  Number.parseInt(process.env.SHORT_TERM_MEMORY_MAX_MESSAGES_PER_CHANNEL || "10", 10) || 10,
);

const CRUDE_CONVERSATION_TTL_MS = CRUDE_CONVERSATION_TTL_HOURS * 60 * 60 * 1000;
const SUMMARY_TTL_MS = SUMMARY_TTL_HOURS * 60 * 60 * 1000;

export { MAX_SUMMARY_LENGTH };

const USER_CACHE_PREFIX = "shortterm:user";
const SERVER_CACHE_PREFIX = "shortterm:server";

const cache = new Map<string, ShortTermMemoryEntry>();

const stats: CacheStats = {
  hits: 0,
  misses: 0,
  stores: 0,
  invalidations: 0,
  expirations: 0,
};

// In-flight DB hydrations keyed by cache key: prevents duplicate reads and allows awaiting.
const pendingHydrations = new Map<string, Promise<void>>();

// Servers/users whose full STM row set has been bulk-loaded from the DB this process.
// After the one-shot bulk warm, every live STM write updates the cache directly, so we
// never need to re-query: this guards against re-running the bulk SELECT each turn.
const bulkWarmedServers = new Set<string>();
const bulkWarmedUsers = new Set<string>();

// Functional unique-index conflict target used in all short_term_memories upserts.
const STM_CONFLICT = `(scope_kind, COALESCE(server_disc_id, ''), COALESCE(user_disc_id, ''), channel_disc_id, COALESCE(persona_id, 0))`;

/**
 * Ensures a short_term_memories row exists for the given scope identity.
 * Does NOT overwrite existing categories, summary, or counters: safe to call
 * on every conversation turn to guarantee the row is present before later updates.
 */
async function ensureStmRow(
  scopeKind: "server" | "user",
  serverDiscId: string | null,
  userDiscId: string | null,
  channelDiscId: string,
  personaId: number | null,
  personaLineageId: number | null,
): Promise<void> {
  await sql.unsafe(
    `INSERT INTO short_term_memories
       (scope_kind, server_disc_id, user_disc_id, channel_disc_id, persona_id, persona_lineage_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT ${STM_CONFLICT} DO NOTHING`,
    [scopeKind, serverDiscId, userDiscId, channelDiscId, personaId, personaLineageId],
  );
}

/**
 * Upserts the summary field for a scope row; inserts the row if absent.
 */
async function upsertStmSummary(
  scopeKind: "server" | "user",
  serverDiscId: string | null,
  userDiscId: string | null,
  channelDiscId: string,
  personaId: number | null,
  personaLineageId: number | null,
  summary: string,
): Promise<void> {
  await sql.unsafe(
    `INSERT INTO short_term_memories
       (scope_kind, server_disc_id, user_disc_id, channel_disc_id, persona_id, persona_lineage_id, summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT ${STM_CONFLICT}
     DO UPDATE SET summary = EXCLUDED.summary`,
    [scopeKind, serverDiscId, userDiscId, channelDiscId, personaId, personaLineageId, summary],
  );
}

/**
 * Nulls the summary column on an existing scope row.
 * Used by summary-mode clear to durably remove the summary so it doesn't
 * resurrect on the next cache miss via hydrateEntryFromDb.
 */
async function clearStmSummary(
  scopeKind: "server" | "user",
  serverDiscId: string | null,
  userDiscId: string | null,
  channelDiscId: string,
  personaId: number | null,
): Promise<void> {
  await sql.unsafe(
    `UPDATE short_term_memories
     SET summary = NULL
     WHERE scope_kind = $1
       AND COALESCE(server_disc_id, '') = COALESCE($2, '')
       AND COALESCE(user_disc_id, '')   = COALESCE($3, '')
       AND channel_disc_id = $4
       AND COALESCE(persona_id, 0) = COALESCE($5, 0)`,
    [scopeKind, serverDiscId, userDiscId, channelDiscId, personaId],
  );
}

/**
 * Upserts the categories JSONB field for a scope row; inserts the row if absent.
 */
async function upsertStmCategories(
  scopeKind: "server" | "user",
  serverDiscId: string | null,
  userDiscId: string | null,
  channelDiscId: string,
  personaId: number | null,
  personaLineageId: number | null,
  categories: Record<string, string>,
): Promise<void> {
  await sql.unsafe(
    `INSERT INTO short_term_memories
       (scope_kind, server_disc_id, user_disc_id, channel_disc_id, persona_id, persona_lineage_id, categories)
     VALUES ($1, $2, $3, $4, $5, $6, $7::JSONB)
     ON CONFLICT ${STM_CONFLICT}
     DO UPDATE SET categories = EXCLUDED.categories`,
    [scopeKind, serverDiscId, userDiscId, channelDiscId, personaId, personaLineageId, JSON.stringify(categories)],
  );
}

/**
 * Atomically increments turns_since_refresh on a scope row (insert-or-increment).
 */
async function incrementStmCounter(
  scopeKind: "server" | "user",
  serverDiscId: string | null,
  userDiscId: string | null,
  channelDiscId: string,
  personaId: number | null,
  personaLineageId: number | null,
): Promise<void> {
  await sql.unsafe(
    `INSERT INTO short_term_memories
       (scope_kind, server_disc_id, user_disc_id, channel_disc_id, persona_id, persona_lineage_id, turns_since_refresh)
     VALUES ($1, $2, $3, $4, $5, $6, 1)
     ON CONFLICT ${STM_CONFLICT}
     DO UPDATE SET turns_since_refresh = short_term_memories.turns_since_refresh + 1`,
    [scopeKind, serverDiscId, userDiscId, channelDiscId, personaId, personaLineageId],
  );
}

/**
 * Resets turns_since_refresh to 0 and advances last_refreshed_turn by 1.
 */
async function resetStmCounter(
  scopeKind: "server" | "user",
  serverDiscId: string | null,
  userDiscId: string | null,
  channelDiscId: string,
  personaId: number | null,
  personaLineageId: number | null,
): Promise<void> {
  await sql.unsafe(
    `INSERT INTO short_term_memories
       (scope_kind, server_disc_id, user_disc_id, channel_disc_id, persona_id, persona_lineage_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT ${STM_CONFLICT}
     DO UPDATE SET
       turns_since_refresh = 0,
       last_refreshed_turn = short_term_memories.last_refreshed_turn + 1`,
    [scopeKind, serverDiscId, userDiscId, channelDiscId, personaId, personaLineageId],
  );
}

/**
 * Reads a single short_term_memories row from DB and warms the in-memory cache.
 * Only writes to cache if the key is still absent after the async round-trip.
 */
async function hydrateEntryFromDb(
  key: string,
  scopeKind: "server" | "user",
  serverDiscId: string | null,
  userDiscId: string | null,
  channelDiscId: string,
  personaId: number | null,
): Promise<void> {
  try {
    const rows = await sql.unsafe<ShortTermMemoryRow[]>(
      `SELECT * FROM short_term_memories
       WHERE scope_kind = $1
         AND COALESCE(server_disc_id, '') = COALESCE($2, '')
         AND COALESCE(user_disc_id, '')   = COALESCE($3, '')
         AND channel_disc_id = $4
         AND COALESCE(persona_id, 0) = COALESCE($5, 0)
       LIMIT 1`,
      [scopeKind, serverDiscId, userDiscId, channelDiscId, personaId],
    );

    const row = rows[0];
    if (row) warmRowIntoCache(key, row);
  } catch (error) {
    log.warn("[shortTermMemoryCache] Background DB hydration failed", { key, error });
  }
}

/**
 * Writes a persisted STM row into the in-memory cache under the given key, unless the
 * key is already warm (a live write wins over stale DB state). Shared by the single-key
 * hydration and the bulk warmers.
 *
 * @param key - Cache key (built via getServerCacheKey / getUserCacheKey)
 * @param row - Raw row from `SELECT * FROM short_term_memories`
 */
function warmRowIntoCache(key: string, row: ShortTermMemoryRow): void {
  // Only warm if another path hasn't already populated this key.
  if (cache.has(key)) return;
  // `sql.unsafe` returns the JSONB `categories` column as a raw JSON string (it bypasses
  // the zod row schema that would normally parse it), so normalize it back to an object.
  // Without this, `Object.keys`/`Object.entries` would enumerate the string
  // character-by-character downstream and corrupt rendering.
  const normalizedCategories = normalizeStmCategories(row.categories);
  const hasCategories = Object.keys(normalizedCategories).length > 0;
  cache.set(key, {
    messages: [],
    summary: row.summary ?? undefined,
    categories: hasCategories ? normalizedCategories : undefined,
    turnsSinceRefresh: row.turns_since_refresh,
    lastRefreshedTurn: row.last_refreshed_turn,
    serverId: row.server_disc_id ?? "DM",
    channelId: row.channel_disc_id,
    personaId: row.persona_id ?? null,
    personaLineageId: row.persona_lineage_id ?? null,
    lastUpdated: row.updated_at ? row.updated_at.getTime() : Date.now(),
  });
}

/**
 * Generate cache key for a user in a channel, optionally scoped to a persona
 * @param userId - Discord user ID
 * @param channelId - Discord channel ID
 * @param personaId - Optional persona ID for persona-scoped memory
 */
function getUserCacheKey(userId: string, channelId: string, personaId?: number | null): string {
  if (personaId) return `${USER_CACHE_PREFIX}:${userId}:${channelId}:${personaId}`;
  return `${USER_CACHE_PREFIX}:${userId}:${channelId}`;
}

/**
 * Generate cache key for a server-shared channel memory, optionally scoped to a persona
 * @param serverId - Discord server ID
 * @param channelId - Discord channel ID
 * @param personaId - Optional persona ID for persona-scoped memory
 */
function getServerCacheKey(serverId: string, channelId: string, personaId?: number | null): string {
  if (personaId) {
    return `${SERVER_CACHE_PREFIX}:${serverId}:${channelId}:${personaId}`;
  }
  return `${SERVER_CACHE_PREFIX}:${serverId}:${channelId}`;
}

/**
 * Check if a cache entry has expired based on TTL
 * @returns True if expired, false otherwise
 */
function isExpired(entry: ShortTermMemoryEntry): boolean {
  const now = Date.now();
  const age = now - entry.lastUpdated;

  const ttl = entry.summary ? SUMMARY_TTL_MS : CRUDE_CONVERSATION_TTL_MS;

  return age > ttl;
}

/**
 * Format a timestamp as a relative time string
 */
export function getRelativeTimestamp(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;

  const diffMinutes = Math.floor(diffMs / (60 * 1000));
  const diffHours = Math.floor(diffMs / (60 * 60 * 1000));
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));

  if (diffMinutes < 1) {
    return "just now";
  }
  if (diffMinutes < 60) {
    return `${diffMinutes} minute${diffMinutes === 1 ? "" : "s"} ago`;
  }
  if (diffHours < 24) {
    return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  }
  if (diffDays < 7) {
    return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
  }
  return "over a week ago";
}

function storeMemoryEntry(
  key: string,
  channelId: string,
  messages: Array<{
    role: "user" | "model";
    content: string;
    timestamp: number;
    speakerName?: string;
  }>,
  serverId: string,
  serverName?: string,
  channelName?: string,
  personaId?: number | null,
  personaLineageId?: number | null,
  parentChannelId?: string | null,
): void {
  const existing = cache.get(key);

  const entry: ShortTermMemoryEntry = {
    messages,
    summary: existing?.summary,
    categories: existing?.categories,
    turnsSinceRefresh: existing?.turnsSinceRefresh,
    lastRefreshedTurn: existing?.lastRefreshedTurn,
    serverId,
    serverName,
    channelId,
    parentChannelId,
    channelName,
    personaId,
    personaLineageId,
    lastUpdated: Date.now(),
  };

  cache.set(key, entry);
  stats.stores++;
}

function collectMemories(
  keyPrefix: string,
  excludeChannelId?: string,
  personaLineageId?: number | null,
): ShortTermMemoryEntry[] {
  const memories: ShortTermMemoryEntry[] = [];
  const expiredKeys: string[] = [];

  for (const [key, entry] of cache.entries()) {
    if (!key.startsWith(keyPrefix)) {
      continue;
    }

    if (excludeChannelId && entry.channelId === excludeChannelId) {
      continue;
    }

    if (personaLineageId && entry.personaLineageId !== personaLineageId) {
      continue;
    }

    if (isExpired(entry)) {
      expiredKeys.push(key);
      continue;
    }

    memories.push(entry);
    stats.hits++;
  }

  for (const key of expiredKeys) {
    cache.delete(key);
    stats.expirations++;
  }

  memories.sort((a, b) => b.lastUpdated - a.lastUpdated);
  return memories;
}

/**
 * Parses a cache key back into its scope identity components.
 * Returns null for unrecognised key formats.
 */
function parseStmKey(key: string): {
  scopeKind: "server" | "user";
  discId: string;
  channelDiscId: string;
  personaId: number | null;
} | null {
  const userMatch = /^shortterm:user:([^:]+):([^:]+)(?::(\d+))?$/.exec(key);
  if (userMatch) {
    return {
      scopeKind: "user",
      discId: userMatch[1],
      channelDiscId: userMatch[2],
      personaId: userMatch[3] !== undefined ? Number(userMatch[3]) : null,
    };
  }
  const serverMatch = /^shortterm:server:([^:]+):([^:]+)(?::(\d+))?$/.exec(key);
  if (serverMatch) {
    return {
      scopeKind: "server",
      discId: serverMatch[1],
      channelDiscId: serverMatch[2],
      personaId: serverMatch[3] !== undefined ? Number(serverMatch[3]) : null,
    };
  }
  return null;
}

function getShortTermMemoryByKey(key: string): ShortTermMemoryEntry | undefined {
  const entry = cache.get(key);

  if (!entry) {
    stats.misses++;
    // Trigger a one-shot background DB hydration on miss so categories/summary
    // are available on the next request after a bot restart.
    if (!pendingHydrations.has(key)) {
      const parsed = parseStmKey(key);
      if (parsed) {
        const serverDiscId = parsed.scopeKind === "server" ? parsed.discId : null;
        const userDiscId = parsed.scopeKind === "user" ? parsed.discId : null;
        const promise = hydrateEntryFromDb(
          key,
          parsed.scopeKind,
          serverDiscId,
          userDiscId,
          parsed.channelDiscId,
          parsed.personaId,
        ).finally(() => pendingHydrations.delete(key));
        pendingHydrations.set(key, promise);
      }
    }
    return undefined;
  }

  if (isExpired(entry)) {
    cache.delete(key);
    stats.expirations++;
    stats.misses++;
    return undefined;
  }

  stats.hits++;
  return entry;
}

/**
 * Ensures the cache entry for a channel is populated before a synchronous read.
 * Call this (with await) before `getShortTermMemoryForServerChannel` or
 * `getShortTermMemoryForUserChannel` so the first post-restart turn sees the
 * persisted summary/categories instead of an empty cache.
 *
 * No-ops when the entry is already warm. If a background hydration is already
 * in flight (triggered by a concurrent sync read), awaits that same promise
 * rather than launching a second DB query.
 *
 * @param scopeKind - "server" for guild channels, "user" for DMs
 * @param discId    - Server snowflake (server scope) or user snowflake (user scope)
 * @param channelId - Channel snowflake
 * @param personaId - Optional persona ID for persona-scoped memory
 */
export async function preWarmStmEntry(
  scopeKind: "server" | "user",
  discId: string,
  channelId: string,
  personaId?: number | null,
): Promise<void> {
  const key =
    scopeKind === "server"
      ? getServerCacheKey(discId, channelId, personaId)
      : getUserCacheKey(discId, channelId, personaId);

  if (cache.has(key)) return;

  // Reuse an in-flight hydration rather than launching a second DB query
  const inflight = pendingHydrations.get(key);
  if (inflight) {
    await inflight;
    return;
  }

  const serverDiscId = scopeKind === "server" ? discId : null;
  const userDiscId = scopeKind === "user" ? discId : null;
  const promise = hydrateEntryFromDb(key, scopeKind, serverDiscId, userDiscId, channelId, personaId ?? null).finally(
    () => pendingHydrations.delete(key),
  );
  pendingHydrations.set(key, promise);
  await promise;
}

/**
 * Bulk-warms every persisted server-scoped STM row for a guild into the cache in a single
 * query. Call this (with await) before the synchronous `getShortTermMemoriesForServer`
 * read so cross-channel recall is available on the FIRST turn after a restart instead of
 * the second: the single-key pre-warm only covers the current channel, but cross-channel
 * recall needs every channel's row.
 *
 * One-shot per server per process: once warmed, live STM writes keep the cache current,
 * so we never re-query. Concurrent callers share the in-flight promise.
 *
 * @param serverDiscId - Guild snowflake
 */
export async function preWarmServerStmEntries(serverDiscId: string): Promise<void> {
  if (!serverDiscId || serverDiscId === "DM" || bulkWarmedServers.has(serverDiscId)) return;

  // Sentinel key (real channel keys are numeric snowflakes, so no collision) used only
  // to dedupe the in-flight bulk query inside the existing pendingHydrations map.
  const inflightKey = `${SERVER_CACHE_PREFIX}:${serverDiscId}:__bulk__`;
  const inflight = pendingHydrations.get(inflightKey);
  if (inflight) {
    await inflight;
    return;
  }

  const promise = (async () => {
    try {
      const rows = await sql.unsafe<ShortTermMemoryRow[]>(
        "SELECT * FROM short_term_memories WHERE scope_kind = 'server' AND server_disc_id = $1",
        [serverDiscId],
      );
      for (const row of rows) {
        warmRowIntoCache(getServerCacheKey(serverDiscId, row.channel_disc_id, row.persona_id), row);
      }
      bulkWarmedServers.add(serverDiscId);
    } catch (error) {
      log.warn("[shortTermMemoryCache] Bulk server STM warm failed", { serverDiscId, error });
    }
  })().finally(() => pendingHydrations.delete(inflightKey));

  pendingHydrations.set(inflightKey, promise);
  await promise;
}

/**
 * Bulk-warms every persisted user-scoped STM row for a user into the cache in a single
 * query. Used for DM recall and cross-server folding. Same one-shot semantics as
 * {@link preWarmServerStmEntries}.
 *
 * @param userDiscId - User snowflake
 */
export async function preWarmUserStmEntries(userDiscId: string): Promise<void> {
  if (!userDiscId || bulkWarmedUsers.has(userDiscId)) return;

  const inflightKey = `${USER_CACHE_PREFIX}:${userDiscId}:__bulk__`;
  const inflight = pendingHydrations.get(inflightKey);
  if (inflight) {
    await inflight;
    return;
  }

  const promise = (async () => {
    try {
      const rows = await sql.unsafe<ShortTermMemoryRow[]>(
        "SELECT * FROM short_term_memories WHERE scope_kind = 'user' AND user_disc_id = $1",
        [userDiscId],
      );
      for (const row of rows) {
        warmRowIntoCache(getUserCacheKey(userDiscId, row.channel_disc_id, row.persona_id), row);
      }
      bulkWarmedUsers.add(userDiscId);
    } catch (error) {
      log.warn("[shortTermMemoryCache] Bulk user STM warm failed", { userDiscId, error });
    }
  })().finally(() => pendingHydrations.delete(inflightKey));

  pendingHydrations.set(inflightKey, promise);
  await promise;
}

function updateSummaryForKey(
  key: string,
  summary: string,
  serverId: string,
  channelId: string,
  serverName?: string,
  channelName?: string,
  personaId?: number | null,
  personaLineageId?: number | null,
  parentChannelId?: string | null,
): void {
  let existing = cache.get(key);

  if (!existing) {
    existing = {
      messages: [],
      summary,
      serverId,
      serverName,
      channelId,
      parentChannelId,
      channelName,
      personaId,
      personaLineageId,
      lastUpdated: Date.now(),
    };
  } else {
    existing.summary = summary;
    existing.lastUpdated = Date.now();
  }

  cache.set(key, existing);
  // (categories, turnsSinceRefresh, lastRefreshedTurn preserved automatically since we mutate existing)
}

/**
 *
 * @param userId - Discord user ID
 * @param channelId - Discord channel ID
 * @param messages - Conversation messages with optional speaker names; the configured storage cap is applied
 * @param serverId - Discord server ID (or "DM" for direct messages)
 * @param serverName - Optional server name for same-server channel mentions
 * @param channelName - Optional channel name for same-server channel mentions
 * @param personaId - Optional persona ID for persona-scoped memory
 * @param personaLineageId - Optional persona lineage ID for cross-server persona matching
 * @param parentChannelId - Parent channel ID when channelId is a thread (used for privacy inheritance)
 */
export function storeShortTermMemory(
  userId: string,
  channelId: string,
  messages: Array<{
    role: "user" | "model";
    content: string;
    timestamp: number;
    speakerName?: string;
  }>,
  serverId: string,
  serverName?: string,
  channelName?: string,
  personaId?: number | null,
  personaLineageId?: number | null,
  parentChannelId?: string | null,
): void {
  try {
    if (!userId || !channelId || !serverId) {
      log.warn(
        `[shortTermMemoryCache] Invalid parameters for storeShortTermMemory - userId=${!!userId}, channelId=${!!channelId}, serverId=${!!serverId}`,
      );
      return;
    }

    const limitedMessages = messages.slice(-MAX_MESSAGES_PER_CHANNEL);
    const resolvedPersonaId = personaId ?? null;
    const resolvedLineageId = personaLineageId ?? null;
    storeMemoryEntry(
      getUserCacheKey(userId, channelId, personaId),
      channelId,
      limitedMessages,
      serverId,
      serverName,
      channelName,
      personaId,
      personaLineageId,
      parentChannelId,
    );

    if (serverId !== "DM") {
      storeMemoryEntry(
        getServerCacheKey(serverId, channelId, personaId),
        channelId,
        limitedMessages,
        serverId,
        serverName,
        channelName,
        personaId,
        personaLineageId,
        parentChannelId,
      );
    }

    // Ensure durable rows exist (fire-and-forget; DO NOTHING on conflict to preserve categories/summary)
    const serverDiscId = serverId !== "DM" ? serverId : null;
    void ensureStmRow("user", serverDiscId, userId, channelId, resolvedPersonaId, resolvedLineageId).catch((err) =>
      log.warn("[shortTermMemoryCache] Failed to persist user STM row", { error: err }),
    );
    if (serverId !== "DM") {
      void ensureStmRow("server", serverId, null, channelId, resolvedPersonaId, resolvedLineageId).catch((err) =>
        log.warn("[shortTermMemoryCache] Failed to persist server STM row", { error: err }),
      );
    }
  } catch (error) {
    log.error(
      `[shortTermMemoryCache] Failed to store short-term memory - userId=${userId}, channelId=${channelId}`,
      error,
      {
        errorType: "CACHE_STORAGE_ERROR",
        metadata: { userDiscId: userId, channelId },
      },
    );
  }
}

/**
 * Get all short-term memories for a user across channels, optionally scoped to a persona lineage
 *
 * @param userId - Discord user ID
 * @param excludeChannelId - Optional channel ID to exclude (e.g., current channel)
 * @param personaLineageId - Optional persona lineage ID to filter by (only returns entries matching this lineage)
 */
export function getShortTermMemoriesForUser(
  userId: string,
  excludeChannelId?: string,
  personaLineageId?: number | null,
): ShortTermMemoryEntry[] {
  try {
    const memories = collectMemories(`${USER_CACHE_PREFIX}:${userId}:`, excludeChannelId, personaLineageId);
    return memories;
  } catch (error) {
    log.error(`[shortTermMemoryCache] Failed to get short-term memories - userId=${userId}`, error, {
      errorType: "CACHE_RETRIEVAL_ERROR",
      metadata: { userDiscId: userId },
    });
    return [];
  }
}

/**
 * Get all server-shared short-term memories for a guild, optionally scoped to a persona lineage
 *
 * @param serverId - Discord server ID
 * @param excludeChannelId - Optional channel ID to exclude (e.g., current channel)
 * @param personaLineageId - Optional persona lineage ID to filter by
 */
export function getShortTermMemoriesForServer(
  serverId: string,
  excludeChannelId?: string,
  personaLineageId?: number | null,
): ShortTermMemoryEntry[] {
  try {
    if (!serverId || serverId === "DM") {
      return [];
    }

    const memories = collectMemories(`${SERVER_CACHE_PREFIX}:${serverId}:`, excludeChannelId, personaLineageId);
    return memories;
  } catch (error) {
    log.error(`[shortTermMemoryCache] Failed to get server-shared short-term memories - serverId=${serverId}`, error, {
      errorType: "CACHE_RETRIEVAL_ERROR",
      metadata: { serverId },
    });
    return [];
  }
}

/**
 * Get short-term memory for a specific user/channel pair, optionally scoped to a persona
 *
 * @param userId - Discord user ID
 * @param channelId - Discord channel ID
 * @param personaId - Optional persona ID for persona-scoped memory
 * @returns Memory entry if found and not expired, undefined otherwise
 */
export function getShortTermMemoryForUserChannel(
  userId: string,
  channelId: string,
  personaId?: number | null,
): ShortTermMemoryEntry | undefined {
  try {
    return getShortTermMemoryByKey(getUserCacheKey(userId, channelId, personaId));
  } catch (error) {
    log.error(
      `[shortTermMemoryCache] Failed to get user short-term memory for channel - userId=${userId}, channelId=${channelId}`,
      error,
      {
        errorType: "CACHE_RETRIEVAL_ERROR",
        metadata: { userDiscId: userId, channelId },
      },
    );
    return undefined;
  }
}

/**
 * Get short-term memory for a specific server/channel pair, optionally scoped to a persona
 *
 * @param serverId - Discord server ID
 * @param channelId - Discord channel ID
 * @param personaId - Optional persona ID for persona-scoped memory
 * @returns Memory entry if found and not expired, undefined otherwise
 */
export function getShortTermMemoryForServerChannel(
  serverId: string,
  channelId: string,
  personaId?: number | null,
): ShortTermMemoryEntry | undefined {
  try {
    if (!serverId || serverId === "DM") {
      return undefined;
    }

    return getShortTermMemoryByKey(getServerCacheKey(serverId, channelId, personaId));
  } catch (error) {
    log.error(
      `[shortTermMemoryCache] Failed to get server short-term memory for channel - serverId=${serverId}, channelId=${channelId}`,
      error,
      {
        errorType: "CACHE_RETRIEVAL_ERROR",
        metadata: { serverId, channelId },
      },
    );
    return undefined;
  }
}

/**
 * Update the summary for short-term memory entries (used by update_short_term_memory tool)
 *
 * @param userId - Discord user ID
 * @param channelId - Discord channel ID
 * @param summary - Tool-generated summary text
 * @param serverId - Discord server ID (required if creating new entry)
 * @param serverName - Server name (optional, for new entries)
 * @param channelName - Channel name (optional, for new entries)
 * @param personaId - Optional persona ID for persona-scoped memory
 * @param personaLineageId - Optional persona lineage ID for cross-server persona matching
 * @param parentChannelId - Parent channel ID when channelId is a thread (used for privacy inheritance)
 */
export function updateShortTermMemorySummary(
  userId: string,
  channelId: string,
  summary: string,
  serverId?: string,
  serverName?: string,
  channelName?: string,
  personaId?: number | null,
  personaLineageId?: number | null,
  parentChannelId?: string | null,
): void {
  try {
    if (!userId || !channelId || !summary) {
      log.warn(
        `[shortTermMemoryCache] Invalid parameters for updateShortTermMemorySummary - userId=${!!userId}, channelId=${!!channelId}, summary=${!!summary}`,
      );
      return;
    }

    const truncatedSummary = summary.length > MAX_SUMMARY_LENGTH ? summary.slice(0, MAX_SUMMARY_LENGTH) : summary;
    const resolvedPersonaId = personaId ?? null;
    const resolvedLineageId = personaLineageId ?? null;
    updateSummaryForKey(
      getUserCacheKey(userId, channelId, personaId),
      truncatedSummary,
      serverId || "unknown",
      channelId,
      serverName,
      channelName,
      personaId,
      personaLineageId,
      parentChannelId,
    );

    if (serverId && serverId !== "DM") {
      updateSummaryForKey(
        getServerCacheKey(serverId, channelId, personaId),
        truncatedSummary,
        serverId,
        channelId,
        serverName,
        channelName,
        personaId,
        personaLineageId,
        parentChannelId,
      );
    }

    // Persist to DB after successful cache update (CLAUDE.md rule 5)
    const serverDiscId = serverId && serverId !== "DM" ? serverId : null;
    void upsertStmSummary(
      "user",
      serverDiscId,
      userId,
      channelId,
      resolvedPersonaId,
      resolvedLineageId,
      truncatedSummary,
    ).catch((err) => log.warn("[shortTermMemoryCache] Failed to persist STM summary (user scope)", { error: err }));
    if (serverId && serverId !== "DM") {
      void upsertStmSummary(
        "server",
        serverId,
        null,
        channelId,
        resolvedPersonaId,
        resolvedLineageId,
        truncatedSummary,
      ).catch((err) => log.warn("[shortTermMemoryCache] Failed to persist STM summary (server scope)", { error: err }));
    }
  } catch (error) {
    log.error(
      `[shortTermMemoryCache] Failed to update short-term memory summary - userId=${userId}, channelId=${channelId}`,
      error,
      {
        errorType: "CACHE_UPDATE_ERROR",
        metadata: { userDiscId: userId, channelId },
      },
    );
  }
}

/**
 * Invalidate (remove) a specific short-term memory entry
 *
 * @param userId - Discord user ID
 * @param channelId - Discord channel ID
 * @param personaId - Optional persona ID for persona-scoped memory
 */
export function invalidateShortTermMemory(
  userId: string,
  channelId: string,
  personaId?: number | null,
  serverId?: string,
): void {
  try {
    let clearedCount = 0;

    if (cache.delete(getUserCacheKey(userId, channelId, personaId))) {
      clearedCount++;
    }

    if (serverId && serverId !== "DM" && cache.delete(getServerCacheKey(serverId, channelId, personaId))) {
      clearedCount++;
    }

    if (clearedCount > 0) {
      stats.invalidations += clearedCount;
    }
  } catch (error) {
    log.error(
      `[shortTermMemoryCache] Failed to invalidate short-term memory - userId=${userId}, channelId=${channelId}`,
      error,
      {
        errorType: "CACHE_INVALIDATION_ERROR",
        metadata: { userDiscId: userId, channelId },
      },
    );
  }
}

/**
 * Durably clear a short-term memory summary: evicts cache and nulls the
 * summary column in the DB so the cleared state survives cache misses.
 *
 * @param userId - Discord user ID
 * @param channelId - Discord channel ID
 * @param personaId - Optional persona ID for persona-scoped memory
 * @param serverId - Optional Discord server ID (omit or "DM" for DMs)
 */
export function clearShortTermMemorySummary(
  userId: string,
  channelId: string,
  personaId?: number | null,
  serverId?: string,
): void {
  try {
    invalidateShortTermMemory(userId, channelId, personaId, serverId);

    // Eviction alone is not durable: hydrateEntryFromDb would resurrect the old
    // summary on the next cache miss, so the clear must also reach the DB.
    const serverDiscId = serverId && serverId !== "DM" ? serverId : null;
    const resolvedPersonaId = personaId ?? null;
    void clearStmSummary("user", serverDiscId, userId, channelId, resolvedPersonaId).catch((err) =>
      log.warn("[shortTermMemoryCache] Failed to clear STM summary in DB (user scope)", { error: err }),
    );
    if (serverDiscId) {
      void clearStmSummary("server", serverDiscId, null, channelId, resolvedPersonaId).catch((err) =>
        log.warn("[shortTermMemoryCache] Failed to clear STM summary in DB (server scope)", { error: err }),
      );
    }
  } catch (error) {
    log.error(
      `[shortTermMemoryCache] Failed to clear short-term memory summary - userId=${userId}, channelId=${channelId}`,
      error,
      {
        errorType: "CACHE_CLEAR_ERROR",
        metadata: { userDiscId: userId, channelId },
      },
    );
  }
}

/**
 * Clear all short-term memories for a specific channel (used by /refresh)
 *
 * @param channelId - Discord channel ID
 */
export function clearShortTermMemoryForChannel(channelId: string): void {
  try {
    let clearedCount = 0;

    for (const [key, entry] of cache.entries()) {
      if (entry.channelId === channelId) {
        cache.delete(key);
        clearedCount++;
      }
    }

    stats.invalidations += clearedCount;

    // Eviction alone is not durable: hydrateEntryFromDb would resurrect the old
    // row on the next cache miss, so the clear must also reach the DB.
    void sql
      .unsafe(`DELETE FROM short_term_memories WHERE channel_disc_id = $1`, [channelId])
      .catch((err) =>
        log.warn("[shortTermMemoryCache] Failed to delete STM from DB for channel", { error: err, channelId }),
      );
  } catch (error) {
    log.error(
      `[shortTermMemoryCache] Failed to clear short-term memories for channel - channelId=${channelId}`,
      error,
      {
        errorType: "CACHE_CLEAR_ERROR",
        metadata: { channelId },
      },
    );
  }
}

/**
 * Clear one server-scoped short-term memory entry for a specific channel/persona pair.
 *
 * @param serverId - Discord server ID
 * @param channelId - Discord channel ID
 * @param personaId - Optional persona ID for persona-scoped memory
 */
export function clearShortTermMemoryForServerChannel(
  serverId: string,
  channelId: string,
  personaId?: number | null,
): void {
  try {
    if (!serverId || serverId === "DM" || !channelId) {
      log.warn(
        `[shortTermMemoryCache] Invalid parameters for clearShortTermMemoryForServerChannel - serverId=${serverId}, channelId=${channelId}, personaId=${personaId ?? "none"}`,
      );
      return;
    }

    if (cache.delete(getServerCacheKey(serverId, channelId, personaId))) {
      stats.invalidations++;
    }

    // Eviction alone is not durable: hydrateEntryFromDb would resurrect the old
    // row on the next cache miss, so the clear must also reach the DB.
    void sql
      .unsafe(
        `DELETE FROM short_term_memories
       WHERE scope_kind = 'server'
         AND server_disc_id = $1
         AND channel_disc_id = $2
         AND COALESCE(persona_id, 0) = COALESCE($3, 0)`,
        [serverId, channelId, personaId ?? null],
      )
      .catch((err) =>
        log.warn("[shortTermMemoryCache] Failed to delete server STM from DB", { error: err, serverId, channelId }),
      );
  } catch (error) {
    log.error(
      `[shortTermMemoryCache] Failed to clear server short-term memory entry - serverId=${serverId}, channelId=${channelId}, personaId=${personaId ?? "none"}`,
      error,
      {
        errorType: "CACHE_CLEAR_ERROR",
        metadata: { serverId, channelId, personaId },
      },
    );
  }
}

/**
 * Clear all user-scoped short-term memories for a user (used by /personal stm clear)
 *
 * @param userId - Discord user ID
 */
export function clearShortTermMemoryForUser(userId: string): void {
  try {
    let clearedCount = 0;

    for (const key of cache.keys()) {
      if (key.startsWith(`${USER_CACHE_PREFIX}:${userId}:`)) {
        cache.delete(key);
        clearedCount++;
      }
    }

    stats.invalidations += clearedCount;

    // Eviction alone is not durable: hydrateEntryFromDb would resurrect the old
    // row on the next cache miss, so the clear must also reach the DB.
    void sql
      .unsafe(`DELETE FROM short_term_memories WHERE scope_kind = 'user' AND user_disc_id = $1`, [userId])
      .catch((err) => log.warn("[shortTermMemoryCache] Failed to delete user STM from DB", { error: err, userId }));
  } catch (error) {
    log.error(`[shortTermMemoryCache] Failed to clear short-term memories for user - userId=${userId}`, error, {
      errorType: "CACHE_CLEAR_ERROR",
      metadata: { userDiscId: userId },
    });
  }
}

/**
 * Remove expired entries from cache (cleanup job)
 * Should be called periodically (e.g., every 30 minutes)
 */
export function clearExpiredEntries(): void {
  try {
    let expiredCount = 0;

    for (const [key, entry] of cache.entries()) {
      if (isExpired(entry)) {
        cache.delete(key);
        expiredCount++;
      }
    }

    stats.expirations += expiredCount;
  } catch (error) {
    log.error("[shortTermMemoryCache] Failed to clear expired entries", error, {
      errorType: "CACHE_CLEANUP_ERROR",
    });
  }
}

/**
 * Clear all short-term memories.
 *
 * This is intentionally not used by normal cache invalidation paths because STM
 * is user-visible conversational state. It exists for explicit emergency memory
 * pressure handling where the operator has opted into sacrificing STM.
 */
export function clearShortTermMemoryCache(): void {
  try {
    const clearedCount = cache.size;
    cache.clear();
    stats.invalidations += clearedCount;
  } catch (error) {
    log.error("[shortTermMemoryCache] Failed to clear all short-term memory entries", error, {
      errorType: "CACHE_CLEAR_ERROR",
    });
  }
}

/**
 * Get cache statistics for monitoring performance
 *
 */
export function getShortTermMemoryCacheStats(): CacheStats & {
  size: number;
  hitRate: string;
} {
  const totalRequests = stats.hits + stats.misses;
  const hitRate = totalRequests > 0 ? `${((stats.hits / totalRequests) * 100).toFixed(1)}%` : "0%";

  return {
    ...stats,
    size: cache.size,
    hitRate,
  };
}

/**
 * Update category values for STM entries (both user and server scope).
 * Writes through to the durable short_term_memories DB row after updating cache.
 *
 * @param userId - Discord user ID
 * @param channelId - Discord channel ID
 * @param categories - Map of category slug → value
 * @param serverId - Discord server ID (or "DM")
 * @param serverName - Optional server name
 * @param channelName - Optional channel name
 * @param personaId - Optional persona ID for persona-scoped memory
 * @param personaLineageId - Optional persona lineage ID
 * @param parentChannelId - Optional parent channel ID (thread privacy)
 */
export async function updateShortTermMemoryCategories(
  userId: string,
  channelId: string,
  categories: Record<string, string>,
  serverId?: string,
  serverName?: string,
  channelName?: string,
  personaId?: number | null,
  personaLineageId?: number | null,
  parentChannelId?: string | null,
): Promise<void> {
  try {
    if (!userId || !channelId) {
      log.warn(
        `[shortTermMemoryCache] Invalid parameters for updateShortTermMemoryCategories - userId=${!!userId}, channelId=${!!channelId}`,
      );
      return;
    }

    const resolvedPersonaId = personaId ?? null;
    const resolvedLineageId = personaLineageId ?? null;
    const userKey = getUserCacheKey(userId, channelId, personaId);
    let userEntry = cache.get(userKey);
    if (!userEntry) {
      userEntry = {
        messages: [],
        serverId: serverId ?? "unknown",
        serverName,
        channelId,
        parentChannelId,
        channelName,
        personaId,
        personaLineageId,
        lastUpdated: Date.now(),
      };
    }
    userEntry.categories = categories;
    userEntry.lastUpdated = Date.now();
    cache.set(userKey, userEntry);

    if (serverId && serverId !== "DM") {
      const serverKey = getServerCacheKey(serverId, channelId, personaId);
      let serverEntry = cache.get(serverKey);
      if (!serverEntry) {
        serverEntry = {
          messages: [],
          serverId,
          serverName,
          channelId,
          parentChannelId,
          channelName,
          personaId,
          personaLineageId,
          lastUpdated: Date.now(),
        };
      }
      serverEntry.categories = categories;
      serverEntry.lastUpdated = Date.now();
      cache.set(serverKey, serverEntry);
    }

    // Persist to DB after cache is updated (CLAUDE.md rule 5)
    const serverDiscId = serverId && serverId !== "DM" ? serverId : null;
    await upsertStmCategories(
      "user",
      serverDiscId,
      userId,
      channelId,
      resolvedPersonaId,
      resolvedLineageId,
      categories,
    );
    if (serverId && serverId !== "DM") {
      await upsertStmCategories("server", serverId, null, channelId, resolvedPersonaId, resolvedLineageId, categories);
    }
  } catch (error) {
    log.error(
      `[shortTermMemoryCache] Failed to update STM categories - userId=${userId}, channelId=${channelId}`,
      error,
      {
        errorType: "CACHE_UPDATE_ERROR",
        metadata: { userDiscId: userId, channelId },
      },
    );
  }
}

/**
 * Increment the turn counter on the live scope row after a bot-participation cycle.
 * In guilds the live scope is server-shared (pass serverId, userId=null).
 * In DMs the live scope is user-scoped (pass userId, serverId=null).
 *
 * @param channelId - Discord channel ID
 * @param serverId - Discord server ID for guild scope; null for DM
 * @param userId - Discord user ID for DM scope; null for guild
 * @param personaId - Optional persona ID
 */
export async function incrementStmTurnCounter(
  channelId: string,
  serverId: string | null,
  userId: string | null,
  personaId?: number | null,
): Promise<void> {
  try {
    if (!serverId && !userId) return;
    const resolvedPersonaId = personaId ?? null;
    const scopeKind = serverId ? "server" : "user";
    const cacheKey = serverId
      ? getServerCacheKey(serverId, channelId, personaId)
      : getUserCacheKey(userId ?? "", channelId, personaId);
    const entry = cache.get(cacheKey);
    if (entry) {
      entry.turnsSinceRefresh = (entry.turnsSinceRefresh ?? 0) + 1;
    }
    await incrementStmCounter(scopeKind, serverId, userId, channelId, resolvedPersonaId, null);
  } catch (error) {
    log.error("[shortTermMemoryCache] Failed to increment STM turn counter", error, {
      errorType: "CACHE_UPDATE_ERROR",
      metadata: { channelId, serverId, userId },
    });
  }
}

/**
 * Reset the turn counter on the live scope row after a successful STM refresh.
 * Advances last_refreshed_turn monotonically so callers can track refresh epochs.
 *
 * @param channelId - Discord channel ID
 * @param serverId - Discord server ID for guild scope; null for DM
 * @param userId - Discord user ID for DM scope; null for guild
 * @param personaId - Optional persona ID
 */
export async function resetStmTurnCounter(
  channelId: string,
  serverId: string | null,
  userId: string | null,
  personaId?: number | null,
): Promise<void> {
  try {
    if (!serverId && !userId) return;
    const resolvedPersonaId = personaId ?? null;
    const scopeKind = serverId ? "server" : "user";
    const cacheKey = serverId
      ? getServerCacheKey(serverId, channelId, personaId)
      : getUserCacheKey(userId ?? "", channelId, personaId);
    const entry = cache.get(cacheKey);
    if (entry) {
      entry.lastRefreshedTurn = (entry.lastRefreshedTurn ?? 0) + 1;
      entry.turnsSinceRefresh = 0;
    }
    await resetStmCounter(scopeKind, serverId, userId, channelId, resolvedPersonaId, null);
  } catch (error) {
    log.error("[shortTermMemoryCache] Failed to reset STM turn counter", error, {
      errorType: "CACHE_UPDATE_ERROR",
      metadata: { channelId, serverId, userId },
    });
  }
}
