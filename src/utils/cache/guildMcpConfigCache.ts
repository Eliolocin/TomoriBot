import type { GuildMcpServerRow } from "@/types/db/schema";
import { log } from "@/utils/misc/logger";
import { mcpRepository, type McpConfigRepositoryReadResult } from "@/utils/db/repositories/McpRepository";

/**
 * Cache entry for a guild's MCP server configurations.
 * Stores all rows (enabled + disabled) so callers can filter in-memory.
 */
interface GuildMcpConfigCacheEntry {
  configs: GuildMcpServerRow[];
  cachedAt: number;
  // A failed refresh keeps rows usable for display but must not silently
  // re-enable writes on the next ordinary cache hit.
  stale: boolean;
}

export type GuildMcpConfigReadResult =
  | { status: "fresh"; configs: GuildMcpServerRow[] }
  | { status: "stale"; configs: GuildMcpServerRow[] }
  | { status: "unavailable"; configs: [] };

/**
 * Cache TTL in milliseconds. Default: 5 minutes.
 * Configurable via GUILD_MCP_CONFIG_CACHE_TTL_MINUTES env var.
 */
const CACHE_TTL_MS = (Number(process.env.GUILD_MCP_CONFIG_CACHE_TTL_MINUTES) || 5) * 60 * 1000;

export interface GuildMcpConfigCacheStats {
  hits: number;
  misses: number;
  hitRate: string;
  cacheSize: number;
}

export type GuildMcpConfigLoader = (serverId: number) => Promise<McpConfigRepositoryReadResult>;

export class GuildMcpConfigCache {
  private readonly cache = new Map<number, GuildMcpConfigCacheEntry>();
  private cacheHits = 0;
  private cacheMisses = 0;

  public constructor(
    private readonly load: GuildMcpConfigLoader,
    private readonly ttlMs = CACHE_TTL_MS,
  ) {}

  public async read(serverId: number, options: { forceRefresh?: boolean } = {}): Promise<GuildMcpConfigReadResult> {
    const now = Date.now();
    const entry = this.cache.get(serverId);

    if (entry && !options.forceRefresh) {
      const age = now - entry.cachedAt;
      if (age < this.ttlMs) {
        this.cacheHits++;
        return { status: entry.stale ? "stale" : "fresh", configs: entry.configs };
      }
    }

    this.cacheMisses++;
    const result = await this.load(serverId);
    if (result.status === "fresh") {
      this.cache.set(serverId, { configs: result.configs, cachedAt: now, stale: false });
      return { status: "fresh", configs: result.configs };
    }

    if (entry) {
      entry.stale = true;
      log.warn(`[GuildMcpConfigCache] Returning stale cache for server ${serverId} due to error`);
      return { status: "stale", configs: entry.configs };
    }
    return { status: "unavailable", configs: [] };
  }

  public invalidate(serverId: number): void {
    this.cache.delete(serverId);
  }

  public clear(): void {
    this.cache.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }

  public getStats(): GuildMcpConfigCacheStats {
    const total = this.cacheHits + this.cacheMisses;
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      hitRate: total > 0 ? `${((this.cacheHits / total) * 100).toFixed(2)}%` : "N/A",
      cacheSize: this.cache.size,
    };
  }
}

const guildMcpConfigCache = new GuildMcpConfigCache((serverId) => mcpRepository.loadGuildMcpConfigsResult(serverId));

/**
 * Get cached guild MCP server configurations for a server.
 * Returns all rows (enabled + disabled) from cache or DB.
 *
 * Cache flow:
 * - Check in-memory cache
 *    - HIT within TTL → return immediately with fresh/stale provenance (0 DB queries)
 *    - MISS or expired entry → load from DB, cache, and return
 *
 * @returns Array of GuildMcpServerRow (may be empty if none registered)
 */
export async function getCachedGuildMcpConfigs(serverId: number): Promise<GuildMcpServerRow[]> {
  return (await getGuildMcpConfigReadResult(serverId)).configs;
}

/**
 * Returns current MCP registrations with enough provenance for writable panels
 * to avoid presenting a failed read as an empty collection.
 */
export async function getGuildMcpConfigReadResult(
  serverId: number,
  options: { forceRefresh?: boolean } = {},
): Promise<GuildMcpConfigReadResult> {
  return guildMcpConfigCache.read(serverId, options);
}

/**
 * Get only enabled guild MCP server configurations.
 * Convenience wrapper that filters getCachedGuildMcpConfigs().
 *
 */
export async function getCachedEnabledGuildMcpConfigs(serverId: number): Promise<GuildMcpServerRow[]> {
  const configs = await getCachedGuildMcpConfigs(serverId);
  return configs.filter((c) => c.is_enabled);
}

/**
 * Invalidate the cache for a specific server.
 * Must be called after any DB write (insert/delete/toggle) to ensure consistency.
 *
 */
export function invalidateGuildMcpConfigCache(serverId: number): void {
  guildMcpConfigCache.invalidate(serverId);
}

/**
 * Useful for testing or manual refresh.
 */
export function clearGuildMcpConfigCache(): void {
  guildMcpConfigCache.clear();
}

/**
 * Get cache statistics for monitoring and debugging.
 *
 */
export function getGuildMcpConfigCacheStats(): GuildMcpConfigCacheStats {
  return guildMcpConfigCache.getStats();
}
