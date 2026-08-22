import type { TomoriState } from "@/types/db/schema";
import { DatabaseUnavailableError } from "@/types/errors";
import { personaRepository } from "@/utils/db/repositories";
import { cache, lastDbError, invalidateTomoriStateCache } from "./tomoriStateCacheStore";
import { log } from "../misc/logger";

// Re-export so existing callers can still import these from "tomoriStateCache".
// New code (especially repositories) should import directly from
// "tomoriStateCacheStore" to avoid the circular dependency through the
// repositories barrel.
export { invalidateTomoriStateCache };

/**
 * How long a DB error entry stays relevant (2 minutes).
 * After this, we assume the error is stale and fall back to "not set up".
 */
const DB_ERROR_STALENESS_MS = 2 * 60 * 1000;

/**
 * Cache duration: configurable via env, default 10 minutes.
 * Longer TTL than emoji cache since config changes are less frequent.
 */
const TOMORI_STATE_CACHE_DURATION_MS = (Number(process.env.TOMORI_STATE_CACHE_TTL_MINUTES) || 10) * 60 * 1000;

/**
 * Cache statistics for monitoring
 */
let cacheHits = 0;
let cacheMisses = 0;

/**
 * Tracks when the bot process started so the UI layer can treat "not set up"
 * results as "currently updating" during the startup grace period.
 * During fresh container starts (e.g. ECS deployments), the DB may be
 * available but the first query can return empty results before connections
 * stabilise. This grace period prevents showing the misleading
 * "Initial Setup Required" embed to users of servers that ARE set up.
 */
const botStartTimestamp = Date.now();

/**
 * How long after process start to treat empty persona results as "updating"
 * rather than "not set up". Configurable via env (default 3 minutes).
 */
const STARTUP_GRACE_PERIOD_MS = (Number(process.env.STARTUP_GRACE_PERIOD_MINUTES) || 3) * 60 * 1000;

/** Returns only a recent database failure recorded for this workspace. */
export function getRecordedDbError(serverDiscId: string): { message: string; timestamp: number } | null {
  const entry = lastDbError.get(serverDiscId);
  if (entry) {
    if (Date.now() - entry.timestamp > DB_ERROR_STALENESS_MS) {
      lastDbError.delete(serverDiscId);
    } else {
      return entry;
    }
  }

  return null;
}

/**
 * Returns a recent database failure or a startup-grace marker for an empty workspace read.
 * The synthetic startup marker must not be used to downgrade successfully loaded data.
 */
export function getLastDbError(serverDiscId: string): { message: string; timestamp: number } | null {
  const entry = getRecordedDbError(serverDiscId);
  if (entry) return entry;

  // During startup grace period, treat empty results as "updating"
  //    so users don't see "Initial Setup Required" on servers that ARE
  //    configured but whose data hasn't been fetched yet.
  if (Date.now() - botStartTimestamp < STARTUP_GRACE_PERIOD_MS) {
    return {
      message: "Bot is still starting up (startup grace period)",
      timestamp: botStartTimestamp,
    };
  }

  return null;
}

/**
 * Loads ALL personas (main + alters) with 10-minute in-memory cache.
 * Falls back to DB query on cache miss or stale.
 *
 * Cache flow:
 * 1. Check in-memory cache
 *    - HIT & FRESH (<10 min) -> Return immediately (0 DB queries)
 *    - MISS or STALE -> Continue to step 2
 * 2. Load from DB via personaRepository.loadAllForServer()
 * 3. Cache in memory for next requests
 *
 * @param serverDiscId - Discord server ID
 * @returns Array of TomoriState objects (main first, then alters), or empty array if not found
 */
export async function getCachedAllPersonas(serverDiscId: string): Promise<TomoriState[]> {
  const now = Date.now();
  const cachedEntry = cache.get(serverDiscId);

  if (cachedEntry) {
    // Check if cache is still fresh (< 10 minutes old)
    const cacheAge = now - cachedEntry.cachedAt;
    if (cacheAge < TOMORI_STATE_CACHE_DURATION_MS) {
      cacheHits++;
      return cachedEntry.personas;
    }

    // Cache stale - fall through to refresh
  }

  // Cache miss or stale - refresh from DB
  cacheMisses++;

  try {
    const personas = await personaRepository.loadAllForServer(serverDiscId);

    lastDbError.delete(serverDiscId);

    if (personas.length > 0) {
      const mainPersona = personas.find((p) => !p.is_alter);
      if (!mainPersona) {
        log.error(`[TomoriState Cache] No main persona found for server ${serverDiscId}`);
        return personas; // Return alters anyway, but log error
      }

      // Apply tool-use master toggle: when tool_use_enabled is false, artificially
      // override has_tools to false on every persona so all providers see no tools.
      const effectivePersonas = personas.map((p) =>
        p.config.tool_use_enabled ? p : { ...p, llm: { ...p.llm, has_tools: false } },
      );
      const effectiveMainPersona = effectivePersonas.find((p) => !p.is_alter) ?? mainPersona;

      cache.set(serverDiscId, {
        personas: effectivePersonas,
        mainPersona: effectiveMainPersona,
        cachedAt: now,
      });

      return effectivePersonas;
    }

    return personas;
  } catch (error) {
    // Track DB errors so the UI layer can show "Currently Updating..."
    // instead of the misleading "Initial Setup Required"
    if (error instanceof DatabaseUnavailableError) {
      lastDbError.set(serverDiscId, {
        message: error.message,
        timestamp: Date.now(),
      });
      log.warn(`[TomoriState Cache] DB unavailable for server ${serverDiscId}, recorded for UI differentiation`);
    }

    log.error(`[TomoriState Cache] Error loading personas for server ${serverDiscId}:`, error);

    // Return stale cache if available (graceful fallback)
    if (cachedEntry) {
      log.warn(`[TomoriState Cache] Returning stale cache for server ${serverDiscId} due to error`);
      return cachedEntry.personas;
    }

    // No cache available, return empty array
    return [];
  }
}

/**
 * Loads ONLY the main persona with 10-minute in-memory cache.
 * Backward compatibility wrapper for getCachedAllPersonas().
 *
 * @param serverDiscId - Discord server ID
 * @returns Main TomoriState or null if not found
 */
export async function getCachedMainPersona(serverDiscId: string): Promise<TomoriState | null> {
  const cachedEntry = cache.get(serverDiscId);
  if (cachedEntry) {
    const cacheAge = Date.now() - cachedEntry.cachedAt;
    if (cacheAge < TOMORI_STATE_CACHE_DURATION_MS) {
      cacheHits++;
      return cachedEntry.mainPersona;
    }
  }

  // Cache miss or stale - load all personas
  const personas = await getCachedAllPersonas(serverDiscId);

  if (personas.length === 0) {
    return null;
  }

  const mainPersona = personas.find((p) => !p.is_alter);
  return mainPersona || null;
}

/**
 * DEPRECATED: Use getCachedMainPersona() or getCachedAllPersonas() instead.
 * Kept for backward compatibility during transition.
 *
 * @deprecated Use getCachedMainPersona() for main persona only, or getCachedAllPersonas() for all personas.
 */
export async function getCachedTomoriState(serverDiscId: string): Promise<TomoriState | null> {
  return getCachedMainPersona(serverDiscId);
}

/**
 * Clears entire in-memory cache.
 * Useful for testing or manual refresh operations.
 */
export function clearTomoriStateCache(): void {
  cache.clear();
  lastDbError.clear();
  cacheHits = 0;
  cacheMisses = 0;
}

/**
 * Gets cache statistics for monitoring and debugging.
 *
 * @returns Object with cache hits, misses, hit rate percentage, and cache size
 */
export function getTomoriStateCacheStats(): {
  hits: number;
  misses: number;
  hitRate: string;
  cacheSize: number;
} {
  const total = cacheHits + cacheMisses;
  const hitRate = total > 0 ? `${((cacheHits / total) * 100).toFixed(2)}%` : "N/A";

  return {
    hits: cacheHits,
    misses: cacheMisses,
    hitRate,
    cacheSize: cache.size,
  };
}
