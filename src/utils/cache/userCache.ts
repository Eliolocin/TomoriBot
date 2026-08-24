import { PrivacyLevel, type UserRow } from "@/types/db/schema";
// Import the singleton directly from its defining module rather than the
// repositories barrel: the barrel re-exports every repository, so importing it
// here pulled all of them (and their transitive graph) into the user-cache
// module and routed cycles through `repositories/index.ts`. The direct import
// yields the same singleton (`UserRepository.ts` defines it) and narrows the
// remaining cycle to the value-safe UserRepository <-> userCache pair.
import { userRepository } from "@/utils/db/repositories/UserRepository";
import { log } from "../misc/logger";

/**
 * Cache entry structure for user data.
 * Includes user row, privacy level, and per-server blacklist status.
 * Blacklist is per-server, so we store a map of serverDiscId -> userRepository.isBlacklisted.
 */
interface UserCacheEntry {
  userRow: UserRow | null; // null if user doesn't exist in DB
  privacyLevel: PrivacyLevel;
  blacklistStatus: Map<string, boolean>; // serverDiscId -> userRepository.isBlacklisted
  cachedAt: number; // Timestamp in milliseconds
}

/**
 * In-memory cache map: userDiscId -> cache entry
 * Reduces database queries from 3-15 per message to 0-1 (cache hit + possible blacklist miss).
 */
const cache = new Map<string, UserCacheEntry>();

/**
 * Cache duration: configurable via env, default 30 minutes.
 * Longer TTL for user data since it changes even less frequently than server config.
 */
const USER_CACHE_DURATION_MS = (Number(process.env.USER_CACHE_TTL_MINUTES) || 30) * 60 * 1000;

/**
 * Cache statistics for monitoring
 */
let cacheHits = 0;
let cacheMisses = 0;
let blacklistCacheHits = 0;
let blacklistCacheMisses = 0;

/**
 * Gets or creates a cache entry for a user, loading from DB if needed.
 * Internal helper function used by the public cache accessors.
 *
 * @param userDiscId - Discord user ID
 * @returns UserCacheEntry (never null, creates entry with defaults if user not found)
 */
async function getOrCreateCacheEntry(userDiscId: string): Promise<UserCacheEntry> {
  const now = Date.now();
  const cachedEntry = cache.get(userDiscId);

  if (cachedEntry) {
    const cacheAge = now - cachedEntry.cachedAt;
    if (cacheAge < USER_CACHE_DURATION_MS) {
      cacheHits++;
      return cachedEntry;
    }

    // Cache stale - fall through to refresh
  }

  // Cache miss or stale - refresh from DB
  cacheMisses++;

  try {
    const [userRow, privacyLevel] = await Promise.all([
      userRepository.loadByDiscordId(userDiscId),
      userRepository.getPrivacyLevel(userDiscId),
    ]);

    const newEntry: UserCacheEntry = {
      userRow,
      privacyLevel,
      blacklistStatus: cachedEntry?.blacklistStatus ?? new Map(),
      cachedAt: now,
    };

    cache.set(userDiscId, newEntry);
    return newEntry;
  } catch (error) {
    log.error(`[User Cache] Error loading user data for ${userDiscId}:`, error);

    // Stale data was read successfully at some point, so it beats a guess in either direction.
    if (cachedEntry) {
      log.warn(`[User Cache] Returning stale cache for user ${userDiscId} due to error`);
      return cachedEntry;
    }

    // FULL rather than MINIMAL: with nothing readable and nothing cached, the user's own
    // setting is unknown, and over-protecting for one call costs nothing while the reverse
    // exposes someone who chose to be invisible.
    //
    // Deliberately not written to `cache`: storing it would pin the restrictive guess for the
    // whole 30 minute TTL, so a blip measured in seconds turned into a half hour of degraded
    // personalization. Leaving it out makes the next call retry the database.
    return {
      userRow: null,
      privacyLevel: PrivacyLevel.FULL,
      blacklistStatus: new Map(),
      cachedAt: now,
    };
  }
}

/**
 * Loads UserRow with 30-minute in-memory cache.
 * Falls back to DB query on cache miss or stale.
 *
 * @param userDiscId - Discord user ID
 * @returns UserRow or null if not found
 */
export async function getCachedUserRow(userDiscId: string): Promise<UserRow | null> {
  const entry = await getOrCreateCacheEntry(userDiscId);
  return entry.userRow;
}

/**
 * Gets privacy level with 30-minute in-memory cache.
 *
 * @param userDiscId - Discord user ID
 * @returns PrivacyLevel (defaults to MINIMAL if not found)
 */
export async function getCachedPrivacyLevel(userDiscId: string): Promise<PrivacyLevel> {
  const entry = await getOrCreateCacheEntry(userDiscId);
  return entry.privacyLevel;
}

/**
 * Checks blacklist status with caching.
 * Per-server blacklist is stored within the user cache entry.
 * If blacklist status for a specific server is not cached, it queries the DB
 * and caches the result for future lookups.
 *
 * @param serverDiscId - Discord server ID
 * @param userDiscId - Discord user ID
 * @returns boolean indicating if user is blacklisted in this server
 */
export async function getCachedBlacklistStatus(serverDiscId: string, userDiscId: string): Promise<boolean> {
  const entry = await getOrCreateCacheEntry(userDiscId);

  if (entry.blacklistStatus.has(serverDiscId)) {
    blacklistCacheHits++;
    // biome-ignore lint/style/noNonNullAssertion: has() check guarantees existence
    return entry.blacklistStatus.get(serverDiscId)!;
  }

  blacklistCacheMisses++;

  try {
    const isUserBlacklisted = await userRepository.isBlacklisted(serverDiscId, userDiscId);
    entry.blacklistStatus.set(serverDiscId, isUserBlacklisted);
    return isUserBlacklisted;
  } catch (error) {
    // Treat the restriction as still in force, and do not record it: a moderation control that
    // lifts itself on a database hiccup is not a control, but neither should an unreadable
    // database pin a user as blacklisted once the database recovers.
    log.error(`[User Cache] Error checking blacklist for user ${userDiscId} in server ${serverDiscId}:`, error);
    return true;
  }
}

/**
 * Invalidates entire user cache entry.
 * Called when user settings change (privacy, nickname, memories).
 *
 * @param userDiscId - Discord user ID to invalidate
 */
export function invalidateUserCache(userDiscId: string): void {
  cache.delete(userDiscId);
}

/**
 * Invalidates only blacklist status for a user in a specific server.
 * More granular than full user invalidation - preserves user row and privacy level.
 *
 * @param serverDiscId - Discord server ID
 * @param userDiscId - Discord user ID
 */
export function invalidateUserBlacklistCache(serverDiscId: string, userDiscId: string): void {
  const entry = cache.get(userDiscId);
  if (entry) {
    entry.blacklistStatus.delete(serverDiscId);
  }
}

/**
 * Useful for testing or manual refresh operations.
 */
export function clearUserCache(): void {
  cache.clear();
  cacheHits = 0;
  cacheMisses = 0;
  blacklistCacheHits = 0;
  blacklistCacheMisses = 0;
}

/**
 * Gets cache statistics for monitoring and debugging.
 *
 */
export function getUserCacheStats(): {
  hits: number;
  misses: number;
  hitRate: string;
  cacheSize: number;
  blacklistHits: number;
  blacklistMisses: number;
  blacklistHitRate: string;
} {
  const total = cacheHits + cacheMisses;
  const hitRate = total > 0 ? `${((cacheHits / total) * 100).toFixed(2)}%` : "N/A";

  const blacklistTotal = blacklistCacheHits + blacklistCacheMisses;
  const blacklistHitRate = blacklistTotal > 0 ? `${((blacklistCacheHits / blacklistTotal) * 100).toFixed(2)}%` : "N/A";

  return {
    hits: cacheHits,
    misses: cacheMisses,
    hitRate,
    cacheSize: cache.size,
    blacklistHits: blacklistCacheHits,
    blacklistMisses: blacklistCacheMisses,
    blacklistHitRate,
  };
}
