/**
 * Resolved per-channel context note.
 * `null` (cached) means the channel has no note : a negative-cache hit.
 */
export type ChannelContextNote = {
  note: string;
  depth: number;
};

/**
 * In-memory TTL store for per-channel context notes.
 * Repository writes invalidate this store after successful note changes.
 */
const channelContextNoteCache = new Map<string, { entry: ChannelContextNote | null; expiresAt: number }>();

const CACHE_TTL_MINUTES = Number.parseInt(process.env.TOMORI_STATE_CACHE_TTL_MINUTES || "10", 10);
const CACHE_TTL_MS = CACHE_TTL_MINUTES * 60 * 1000;

function getCacheKey(serverId: number, channelDiscId: string): string {
  return `${serverId}:${channelDiscId}`;
}

/**
 * Returns the cached entry (or cached `null` for "no note"), or `undefined` on miss/expiry.
 */
export function getChannelContextNoteCacheEntry(
  serverId: number,
  channelDiscId: string,
): ChannelContextNote | null | undefined {
  const cached = channelContextNoteCache.get(getCacheKey(serverId, channelDiscId));
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    channelContextNoteCache.delete(getCacheKey(serverId, channelDiscId));
    return undefined;
  }
  return cached.entry;
}

export function setChannelContextNoteCache(
  serverId: number,
  channelDiscId: string,
  entry: ChannelContextNote | null,
): void {
  channelContextNoteCache.set(getCacheKey(serverId, channelDiscId), {
    entry,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

export function invalidateChannelContextNoteCache(serverId: number, channelDiscId: string): void {
  channelContextNoteCache.delete(getCacheKey(serverId, channelDiscId));
}

/** Removes every cached context-note result for one server without flushing other servers. */
export function invalidateAllChannelContextNoteCacheForServer(serverId: number): void {
  const prefix = `${serverId}:`;
  for (const key of channelContextNoteCache.keys()) {
    if (key.startsWith(prefix)) {
      channelContextNoteCache.delete(key);
    }
  }
}
