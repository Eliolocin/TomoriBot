/**
 * Cache Metrics Logger
 *
 * Periodically emits a structured `log.metric()` line containing the size of every
 * in-memory cache plus process RSS. Designed for AWS CloudWatch Logs Insights:
 * all fields land at the top level of a single log record so they can be graphed
 * together with queries like:
 *
 *   fields @timestamp, shortTermMemory, webhookChannel, rss_mb, rss_pct
 *   | filter metric = "cache_sizes"
 *   | stats max(shortTermMemory), max(webhookChannel), max(rss_mb) by bin(5m)
 *
 * This is diagnostic-only. It does not mutate caches or trigger cleanup.
 */

import type { Client } from "discord.js";
import { getVoiceTranscriptCacheSize } from "@/utils/audio/voiceTranscriptCache";
import { getChannelLlmCacheSize } from "@/utils/cache/channelLlmCacheStore";
import { getWhitelistCacheStats } from "@/utils/cache/channelWhitelistCache";
import { getEmojiStickerCacheStats } from "@/utils/cache/emojiStickerCache";
import { getGuildMcpConfigCacheStats } from "@/utils/cache/guildMcpConfigCache";
import { getLLMCacheSize } from "@/utils/cache/llmCache";
import { getNovelaiSubscriptionCacheSize } from "@/utils/cache/novelaiSubscriptionCache";
import { getOpenRouterCapabilityCacheSize } from "@/utils/cache/openrouterCapabilityCache";
import { getOpenRouterEmbeddingModelCacheSize } from "@/utils/cache/openrouterEmbeddingModelCache";
import { getOpenRouterImageModelCacheSize } from "@/utils/cache/openrouterImageModelCache";
import { getOpenRouterVideoModelCacheSize } from "@/utils/cache/openrouterVideoModelCache";
import { getPersonalSpotlightCacheStats } from "@/utils/cache/personalSpotlightCache";
import { getShortTermMemoryCacheStats } from "@/utils/cache/shortTermMemoryCache";
import { getStPresetCacheStats } from "@/utils/cache/stPresetCache";
import { getTomoriStateCacheStats } from "@/utils/cache/tomoriStateCache";
import { getUserCacheStats } from "@/utils/cache/userCache";
import { getWebhookIdentityCacheSize } from "@/utils/chat/webhookIdentity";
import { getWebhookCacheSizes } from "@/utils/discord/webhook/cache";
import { getPresetAvatarCacheSize } from "@/utils/image/avatarHelper";
import { log } from "@/utils/misc/logger";
import { collectProcessMemorySnapshot } from "@/utils/misc/processMemory";
import { memoryGuard } from "@/utils/security/rateLimiter";
import { getMarkdownTableCacheSize } from "@/utils/text/markdownTableCache";
import { getPersonaSpriteCacheSize } from "@/utils/cache/personaSpriteCacheStore";
import { getPersonaSpriteMessageCacheSize } from "@/utils/cache/personaSpriteMessageCache";

/**
 * Default sampling cadence when CACHE_METRICS_INTERVAL_MS is not set.
 * 5 minutes balances CloudWatch log volume against the ability to correlate
 * cache growth with the observed 50%→80% RSS drift.
 */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

let intervalId: NodeJS.Timeout | null = null;

/**
 * Collects Discord.js client cache sizes. Iterates `client.guilds.cache` once
 * for nested caches (members/channels/messages/threads/emojis) so all values
 * come from a single consistent snapshot.
 */
function collectDiscordCacheSizes(client: Client): Record<string, number> {
  let members = 0;
  let channels = 0;
  let messages = 0;
  let threads = 0;
  let emojis = 0;
  let stickers = 0;
  let presences = 0;
  let voiceStates = 0;

  for (const guild of client.guilds.cache.values()) {
    try {
      members += guild.members.cache.size;
      channels += guild.channels.cache.size;
      emojis += guild.emojis.cache.size;
      stickers += guild.stickers.cache.size;
      presences += guild.presences.cache.size;
      voiceStates += guild.voiceStates.cache.size;

      for (const channel of guild.channels.cache.values()) {
        if ("messages" in channel) {
          const mgr = (channel as unknown as { messages?: { cache?: { size?: number } } }).messages;
          if (mgr?.cache?.size) messages += mgr.cache.size;
        }
        if ("threads" in channel) {
          const mgr = (channel as unknown as { threads?: { cache?: { size?: number } } }).threads;
          if (mgr?.cache?.size) threads += mgr.cache.size;
        }
      }
    } catch {}
  }

  return {
    discord_guilds: client.guilds.cache.size,
    discord_users: client.users.cache.size,
    discord_channels: channels,
    discord_members: members,
    discord_messages: messages,
    discord_threads: threads,
    discord_emojis: emojis,
    discord_stickers: stickers,
    discord_presences: presences,
    discord_voiceStates: voiceStates,
  };
}

/**
 * Build a flat metric payload from every cache plus process RSS.
 * Exported so a future slash command or HTTP endpoint could call it on-demand.
 */
export function collectCacheMetricsSnapshot(client: Client): Record<string, number> {
  const stm = getShortTermMemoryCacheStats();
  const tomoriState = getTomoriStateCacheStats();
  const user = getUserCacheStats();
  const whitelist = getWhitelistCacheStats();
  const emojiSticker = getEmojiStickerCacheStats();
  const guildMcp = getGuildMcpConfigCacheStats();
  const stPreset = getStPresetCacheStats();
  const webhook = getWebhookCacheSizes();
  const personalSpotlight = getPersonalSpotlightCacheStats();
  const memCheck = memoryGuard.checkMemory();
  const processMemory = collectProcessMemorySnapshot();

  return {
    // Tomori application-level caches
    shortTermMemory: stm.size,
    tomoriState: tomoriState.cacheSize,
    userCache: user.cacheSize,
    channelWhitelist: whitelist.size,
    channelLlm: getChannelLlmCacheSize(),
    emojiSticker: emojiSticker.cacheSize,
    guildMcpConfig: guildMcp.cacheSize,
    personalSpotlight: personalSpotlight.size,
    stPreset: stPreset.size,
    presetAvatar: getPresetAvatarCacheSize(),
    voiceTranscript: getVoiceTranscriptCacheSize(),
    markdownTable: getMarkdownTableCacheSize(),
    personaSprite: getPersonaSpriteCacheSize(),
    personaSpriteMessage: getPersonaSpriteMessageCacheSize(),
    llmCache: getLLMCacheSize(),
    openrouterCapability: getOpenRouterCapabilityCacheSize(),
    openrouterEmbeddingCatalog: getOpenRouterEmbeddingModelCacheSize(),
    openrouterImageCatalog: getOpenRouterImageModelCacheSize(),
    openrouterVideoCatalog: getOpenRouterVideoModelCacheSize(),
    novelaiSubscription: getNovelaiSubscriptionCacheSize(),

    // Webhook manager (no TTL, watch for unbounded growth)
    webhookChannel: webhook.webhookChannel,
    webhookPersona: webhook.webhookPersona,
    webhookMutationLocks: webhook.webhookMutationLocks,
    webhookAvatarState: webhook.webhookAvatarState,
    persistedManagedWebhookIds: webhook.persistedManagedWebhookIds,
    webhookIdentity: getWebhookIdentityCacheSize(),

    // Discord.js client caches
    ...collectDiscordCacheSizes(client),

    // Process memory (correlate cache growth with observed RSS drift)
    rss_mb: Math.round(memCheck.rssUsedMB * 100) / 100,
    rss_pct: Math.round(memCheck.percentUsed * 10000) / 100,
    rss_limit_mb: memCheck.memoryLimitMB,

    // Native allocations (decoded bitmaps, buffers) live in `external`/`arrayBuffers`, not in
    // the JS heap and not in any cache counted above, so entry counts alone cannot explain a
    // memory spike. RSS also understates the total once the kernel swaps part of the heap out.
    heap_used_mb: processMemory.heapUsedMb,
    heap_total_mb: processMemory.heapTotalMb,
    external_mb: processMemory.externalMb,
    array_buffers_mb: processMemory.arrayBuffersMb,
  };
}

/**
 * Emit one cache metrics snapshot to the logger.
 * Errors are caught and logged so a failed snapshot never kills the interval.
 */
function emitSnapshot(client: Client): void {
  try {
    const snapshot = collectCacheMetricsSnapshot(client);
    log.metric("cache_sizes", snapshot);
  } catch (error) {
    log.error("Failed to emit cache metrics snapshot", error, {
      errorType: "CacheMetricsLoggerError",
    });
  }
}

/**
 * Start the cache metrics interval. Only runs in production, these logs are
 * intended for CloudWatch Logs Insights and are not useful in local dev.
 * Safe to call multiple times, so a subsequent call is a no-op if already running.
 *
 * @param intervalMs - Optional override; defaults to CACHE_METRICS_INTERVAL_MS env or 5 min
 */
export function initializeCacheMetricsLogger(client: Client, intervalMs?: number): void {
  // Skip in non-production, so these snapshots are for CloudWatch, not local dev
  if (process.env.RUN_ENV !== "production") {
    return;
  }

  if (intervalId !== null) {
    log.warn("Cache metrics logger already initialized");
    return;
  }

  // Resolve interval from explicit argument, env var, or fallback default
  const resolved = intervalMs ?? Number.parseInt(process.env.CACHE_METRICS_INTERVAL_MS || "", 10);
  const finalInterval = Number.isFinite(resolved) && resolved > 0 ? resolved : DEFAULT_INTERVAL_MS;

  // Emit an immediate sample so CloudWatch has a baseline right after boot
  emitSnapshot(client);

  intervalId = setInterval(() => emitSnapshot(client), finalInterval);

  log.success(`Cache metrics logger started (interval: ${finalInterval / 1000}s)`);
}

/**
 * Stop the cache metrics interval. No-op if not running.
 */
export function stopCacheMetricsLogger(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
    log.info("Cache metrics logger stopped");
  }
}
