/**
 * Cache Metrics Logger
 *
 * Periodically records the size of every in-memory cache plus process memory, to two sinks:
 * a structured `log.metric()` line and a row in `metric_samples`.
 *
 * All fields land at the top level of a single flat record, so a log query can graph them
 * together and Grafana can read them as `(fields->>'heap_used_mb')::float`.
 *
 * Both sinks are kept because they fail at different times. The log line reaches the host
 * JSONL, which survives container recreate, VM reboot, and the bot stalling deep in swap, and
 * is what incident triage greps. The database row is the one Grafana can graph, and it stops
 * exactly when the bot cannot reach Postgres.
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
import { drainPoolEventCounters } from "@/utils/db/poolEvents";
import { metricSampleRepository } from "@/utils/db/repositories/MetricSampleRepository";
import { getWebhookCacheSizes } from "@/utils/discord/webhook/cache";
import { getPresetAvatarCacheSize } from "@/utils/image/avatarHelper";
import { eventLoopMonitor } from "@/utils/misc/eventLoopMonitor";
import { collectHostMemorySnapshot } from "@/utils/misc/hostMemory";
import {
  evaluatePressure,
  initialPressureState,
  isPressureDetectorArmed,
  type PressureState,
  pressureSampleFromHostFields,
  pressureThresholdsFromEnv,
  pressureVerdictFields,
} from "@/utils/security/pressureDetector";
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
 * Detector state is carried across intervals because dwell and rate limiting are defined over a
 * sequence, not a sample. It resets with the process, which is correct: a container recreate is
 * exactly the recovery the detector would have recommended.
 */
let pressureState: PressureState = initialPressureState();
const processStartMs = Date.now();

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
    webhookFailure: webhook.webhookFailure,
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

    // Worst timer lag across the whole interval rather than the instant of the sample, since a
    // stall lasting seconds would almost never coincide with a 5-minute sample. This is the only
    // series that distinguishes a starved event loop from a healthy one, because Discord readiness
    // and WebSocket ping both stay green through it.
    event_loop_peak_lag_ms: eventLoopMonitor.takeIntervalPeakLagMs(),
  };
}

/**
 * Emit one cache metrics snapshot to the logger and to the Postgres sink.
 * Errors are caught and logged so a failed snapshot never kills the interval.
 *
 * Both sinks are kept rather than one: the host JSONL survives container recreate, VM reboot,
 * and the bot stalling deep in swap, and it is what the runbook greps during an incident. The
 * Postgres row is what Grafana can graph. The insert is fire-and-forget because a sample is
 * worth less than the interval that produces it.
 */
function emitSnapshot(client: Client): void {
  try {
    const snapshot = collectCacheMetricsSnapshot(client);
    log.metric("cache_sizes", snapshot);
    void metricSampleRepository.recordSample("cache_sizes", snapshot);
  } catch (error) {
    log.error("Failed to emit cache metrics snapshot", error, {
      errorType: "CacheMetricsLoggerError",
    });
  }

  void emitHostSnapshot();
}

/**
 * Emit one host memory and pressure sample to the Postgres sink.
 *
 * Unlike `cache_sizes` this deliberately has no `log.metric()` twin. The two-sink rule exists
 * because the JSONL survives conditions the database does not, but `tomoribot-oom-observer`
 * already writes these same host counters to disk every 15 s, so a 5-minute copy would duplicate
 * a finer-grained record while adding to that file's unbounded growth. The database row is the
 * part that did not exist: removing the AzureMonitorLinuxAgent left host memory with no
 * queryable series at all.
 */
async function emitHostSnapshot(): Promise<void> {
  try {
    const snapshot = await collectHostMemorySnapshot();
    if (!snapshot) return;

    // The detector reads this same snapshot rather than taking its own. `swap_in_per_s` is
    // differenced against the previous call, so a second read would measure a near-zero interval
    // and report a rate of roughly zero no matter what the host is doing.
    const now = Date.now();
    const { state, verdict } = evaluatePressure(
      pressureState,
      pressureSampleFromHostFields(snapshot, now),
      processStartMs,
      pressureThresholdsFromEnv(),
    );
    pressureState = state;

    const armed = isPressureDetectorArmed();
    if (verdict.wouldAct !== "none") {
      log.warn(
        `Host pressure ${verdict.level}: would ${verdict.wouldAct} (elevated duty ${verdict.elevatedDuty}, critical duty ${verdict.criticalDuty}, armed=${armed})`,
      );
    }

    // Pool retirements ride this sample rather than a series of their own so a cascade can be
    // read against swap, PSI and event-loop lag on one time axis. Cross-tabbing those by hand
    // from separate sources is what turned the last diagnosis into an afternoon.
    await metricSampleRepository.recordSample("host_memory", {
      ...snapshot,
      ...pressureVerdictFields(verdict, armed),
      ...drainPoolEventCounters(),
    });
  } catch (error) {
    log.error("Failed to emit host memory snapshot", error, {
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
