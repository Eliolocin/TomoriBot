import type { PersonaUserBlockRow } from "@/types/db/schema";
import { personaUserBlockRepository } from "@/utils/db/repositories";
import { log } from "@/utils/misc/logger";

const CACHE_TTL_MS = (Number(process.env.PERSONA_USER_BLOCK_CACHE_TTL_SECONDS) || 60) * 1000;

type CacheEntry<T> = {
  value: T;
  cachedAt: number;
};

const personaCache = new Map<string, CacheEntry<PersonaUserBlockRow[]>>();
const userCache = new Map<string, CacheEntry<PersonaUserBlockRow[]>>();

function personaCacheKey(serverId: number, personaId: number): string {
  return `${serverId}:${personaId}`;
}

function userCacheKey(serverId: number, userDiscId: string): string {
  return `${serverId}:${userDiscId}`;
}

function isFresh<T>(entry: CacheEntry<T> | undefined): boolean {
  return !!entry && Date.now() - entry.cachedAt < CACHE_TTL_MS;
}

export async function getCachedActiveBlocksForPersona(
  serverId: number,
  personaId: number,
): Promise<PersonaUserBlockRow[]> {
  const key = personaCacheKey(serverId, personaId);
  const cached = personaCache.get(key);
  if (cached && isFresh(cached)) return cached.value;

  try {
    const value = await personaUserBlockRepository.loadActiveBlocksForPersona(serverId, personaId);
    personaCache.set(key, { value, cachedAt: Date.now() });
    return value;
  } catch (error) {
    log.warn(`Failed to load persona user block cache for persona ${personaId}`, error as Error);
    return cached?.value ?? [];
  }
}

export async function getCachedActiveBlocksForUser(
  serverId: number,
  userDiscId: string,
): Promise<PersonaUserBlockRow[]> {
  const key = userCacheKey(serverId, userDiscId);
  const cached = userCache.get(key);
  if (cached && isFresh(cached)) return cached.value;

  try {
    const value = await personaUserBlockRepository.loadActiveBlocksForUser(serverId, userDiscId);
    userCache.set(key, { value, cachedAt: Date.now() });
    return value;
  } catch (error) {
    // Stale entries were read successfully once, so they still describe real blocks.
    if (cached) {
      log.warn(`Serving stale persona user block cache for user ${userDiscId}`, error as Error);
      return cached.value;
    }

    // With nothing cached, "which personas are blocked" has no safe expressible answer: an empty
    // list is read downstream as "none", which lifts every block. Propagating instead aborts the
    // turn, and a persona that stays silent is the same outcome the block asks for.
    log.error(`Failed to load persona user blocks for user ${userDiscId}`, error);
    throw error;
  }
}

export function invalidatePersonaUserBlockCache(serverId: number, personaId: number, userDiscId?: string): void {
  personaCache.delete(personaCacheKey(serverId, personaId));
  if (userDiscId) {
    userCache.delete(userCacheKey(serverId, userDiscId));
  } else {
    for (const key of userCache.keys()) {
      if (key.startsWith(`${serverId}:`)) {
        userCache.delete(key);
      }
    }
  }
}
