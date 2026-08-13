import type { Client } from "discord.js";
import { clearVoiceTranscriptCache, getVoiceTranscriptCacheSize } from "@/utils/audio/voiceTranscriptCache";
import { clearChannelLlmCache, getChannelLlmCacheSize } from "@/utils/cache/channelLlmCacheStore";
import { clearWhitelistCache, getWhitelistCacheStats } from "@/utils/cache/channelWhitelistCache";
import { clearEmojiStickerCache, getEmojiStickerCacheStats } from "@/utils/cache/emojiStickerCache";
import { clearGuildMcpConfigCache, getGuildMcpConfigCacheStats } from "@/utils/cache/guildMcpConfigCache";
import { clearNovelaiSubscriptionCache, getNovelaiSubscriptionCacheSize } from "@/utils/cache/novelaiSubscriptionCache";
import { clearPersonalSpotlightCache, getPersonalSpotlightCacheStats } from "@/utils/cache/personalSpotlightCache";
import { clearPersonaSpriteCache, getPersonaSpriteCacheSize } from "@/utils/cache/personaSpriteCacheStore";
import {
  clearPersonaSpriteMessageCache,
  getPersonaSpriteMessageCacheSize,
} from "@/utils/cache/personaSpriteMessageCache";
import {
  clearExpiredEntries,
  clearShortTermMemoryCache,
  getShortTermMemoryCacheStats,
} from "@/utils/cache/shortTermMemoryCache";
import { clearStPresetCache, getStPresetCacheStats } from "@/utils/cache/stPresetCache";
import { clearTomoriStateCache, getTomoriStateCacheStats } from "@/utils/cache/tomoriStateCache";
import { clearUserCache, getUserCacheStats } from "@/utils/cache/userCache";
import { clearWebhookIdentityCache, getWebhookIdentityCacheSize } from "@/utils/chat/webhookIdentity";
import { clearWebhookCache, getWebhookCacheSizes } from "@/utils/discord/webhook/cache";
import { clearPresetAvatarCache, getPresetAvatarCacheSize } from "@/utils/image/avatarHelper";
import { log } from "@/utils/misc/logger";
import {
  addProcessMemoryDeltaFields,
  addProcessMemorySnapshotFields,
  collectProcessMemorySnapshot,
  type ProcessMemorySnapshot,
  runForcedGc,
} from "@/utils/misc/processMemory";
import { clearMarkdownTableCache, getMarkdownTableCacheSize } from "@/utils/text/markdownTableCache";

interface EmergencyCacheClearStep {
  name: string;
  before: number;
  after: number;
  cleared: number;
  error?: string;
}

export interface EmergencyCacheClearReport {
  enabled: boolean;
  includeShortTermMemory: boolean;
  clearDiscordVolatileCaches: boolean;
  totalClearedEntries: number;
  failedCaches: number;
  memoryBeforeClear: ProcessMemorySnapshot;
  memoryAfterClear: ProcessMemorySnapshot;
  steps: EmergencyCacheClearStep[];
}

export interface EmergencyCacheClearOptions {
  client?: Client;
  includeShortTermMemory?: boolean;
  clearDiscordVolatileCaches?: boolean;
  source?: string;
  /** Collect before measuring the result. Disable only in tests that assert on entry counts. */
  collectBeforeMeasuring?: boolean;
}

function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const rawValue = process.env[name]?.trim().toLowerCase();
  if (rawValue === undefined || rawValue.length === 0) return defaultValue;
  return ["1", "true", "yes", "on"].includes(rawValue);
}

function getWebhookTotalCacheSize(): number {
  const sizes = getWebhookCacheSizes();
  return Object.values(sizes).reduce((total, value) => total + value, 0);
}

function getStepErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getStepMetricName(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, "_");
}

function addPerCacheClearMetricFields(fields: Record<string, number | string>, steps: EmergencyCacheClearStep[]): void {
  for (const step of steps) {
    fields[`cleared_${getStepMetricName(step.name)}`] = step.cleared;
  }
}

function clearMeasured(steps: EmergencyCacheClearStep[], name: string, getSize: () => number, clear: () => void): void {
  let before = 0;
  let after = 0;

  try {
    before = getSize();
    clear();
    after = getSize();
    steps.push({
      name,
      before,
      after,
      cleared: Math.max(0, before - after),
    });
  } catch (error) {
    steps.push({
      name,
      before,
      after,
      cleared: 0,
      error: getStepErrorMessage(error),
    });
  }
}

function clearDiscordVolatileCaches(client: Client): EmergencyCacheClearStep[] {
  const steps: EmergencyCacheClearStep[] = [];

  clearMeasured(
    steps,
    "discordMessages",
    () => {
      let total = 0;
      for (const guild of client.guilds.cache.values()) {
        for (const channel of guild.channels.cache.values()) {
          const manager = (channel as unknown as { messages?: { cache?: { size: number } } }).messages;
          total += manager?.cache?.size ?? 0;
        }
      }
      return total;
    },
    () => {
      for (const guild of client.guilds.cache.values()) {
        for (const channel of guild.channels.cache.values()) {
          const manager = (channel as unknown as { messages?: { cache?: { clear: () => void } } }).messages;
          manager?.cache?.clear();
        }
      }
    },
  );

  clearMeasured(
    steps,
    "discordBotUsers",
    () => client.users.cache.filter((user) => user.bot && user.id !== client.user?.id).size,
    () => {
      client.users.cache.sweep((user) => user.bot && user.id !== client.user?.id);
    },
  );

  clearMeasured(
    steps,
    "discordPresences",
    () => {
      let total = 0;
      for (const guild of client.guilds.cache.values()) {
        total += guild.presences.cache.size;
      }
      return total;
    },
    () => {
      for (const guild of client.guilds.cache.values()) {
        guild.presences.cache.clear();
      }
    },
  );

  clearMeasured(
    steps,
    "discordVoiceStates",
    () => {
      let total = 0;
      for (const guild of client.guilds.cache.values()) {
        total += guild.voiceStates.cache.size;
      }
      return total;
    },
    () => {
      for (const guild of client.guilds.cache.values()) {
        guild.voiceStates.cache.clear();
      }
    },
  );

  return steps;
}

export function clearEmergencyCaches(options: EmergencyCacheClearOptions = {}): EmergencyCacheClearReport {
  const enabled = parseBooleanEnv("EMERGENCY_CACHE_CLEAR_ENABLED", true);
  const includeShortTermMemory =
    options.includeShortTermMemory ?? parseBooleanEnv("EMERGENCY_CACHE_CLEAR_INCLUDE_STM", false);
  const shouldClearDiscordVolatileCaches =
    options.clearDiscordVolatileCaches ?? parseBooleanEnv("EMERGENCY_CACHE_CLEAR_DISCORD_VOLATILE", true);
  const steps: EmergencyCacheClearStep[] = [];
  const memoryBeforeClear = collectProcessMemorySnapshot();

  if (!enabled) {
    const memoryAfterClear = collectProcessMemorySnapshot();
    log.warn("[Emergency Cache Clear] Skipped because EMERGENCY_CACHE_CLEAR_ENABLED=false");
    return {
      enabled: false,
      includeShortTermMemory,
      clearDiscordVolatileCaches: shouldClearDiscordVolatileCaches,
      totalClearedEntries: 0,
      failedCaches: 0,
      memoryBeforeClear,
      memoryAfterClear,
      steps,
    };
  }

  clearMeasured(steps, "tomoriState", () => getTomoriStateCacheStats().cacheSize, clearTomoriStateCache);
  clearMeasured(steps, "user", () => getUserCacheStats().cacheSize, clearUserCache);
  clearMeasured(steps, "channelWhitelist", () => getWhitelistCacheStats().size, clearWhitelistCache);
  clearMeasured(steps, "channelLlm", getChannelLlmCacheSize, clearChannelLlmCache);
  clearMeasured(steps, "emojiSticker", () => getEmojiStickerCacheStats().cacheSize, clearEmojiStickerCache);
  clearMeasured(steps, "guildMcpConfig", () => getGuildMcpConfigCacheStats().cacheSize, clearGuildMcpConfigCache);
  clearMeasured(steps, "personalSpotlight", () => getPersonalSpotlightCacheStats().size, clearPersonalSpotlightCache);
  clearMeasured(steps, "stPreset", () => getStPresetCacheStats().size, clearStPresetCache);
  clearMeasured(steps, "webhook", getWebhookTotalCacheSize, clearWebhookCache);
  clearMeasured(steps, "webhookIdentity", getWebhookIdentityCacheSize, clearWebhookIdentityCache);
  clearMeasured(steps, "novelaiSubscription", getNovelaiSubscriptionCacheSize, clearNovelaiSubscriptionCache);
  // The OpenRouter catalogs are deliberately absent: they are provider metadata rather
  // than per-guild growth, and dropping one would gate chat on database flags until the
  // next refresh window for a few hundred KB.
  clearMeasured(steps, "presetAvatar", getPresetAvatarCacheSize, clearPresetAvatarCache);
  clearMeasured(steps, "voiceTranscript", getVoiceTranscriptCacheSize, clearVoiceTranscriptCache);
  clearMeasured(steps, "markdownTable", getMarkdownTableCacheSize, clearMarkdownTableCache);
  clearMeasured(steps, "personaSprite", getPersonaSpriteCacheSize, clearPersonaSpriteCache);
  clearMeasured(steps, "personaSpriteMessage", getPersonaSpriteMessageCacheSize, clearPersonaSpriteMessageCache);

  clearMeasured(steps, "shortTermMemoryExpired", () => getShortTermMemoryCacheStats().size, clearExpiredEntries);
  if (includeShortTermMemory) {
    clearMeasured(steps, "shortTermMemory", () => getShortTermMemoryCacheStats().size, clearShortTermMemoryCache);
  }

  if (options.client && shouldClearDiscordVolatileCaches) {
    steps.push(...clearDiscordVolatileCaches(options.client));
  }

  // Dropping a cache reference frees nothing observable until a collection runs, so without
  // this pass every `*_delta_clear` field reads exactly 0 and the report cannot show whether
  // clearing helped. The guard's own forced GC happens after this function returns, too late
  // to be captured here.
  if (options.collectBeforeMeasuring ?? true) {
    try {
      runForcedGc();
    } catch (error) {
      log.warn(`[Emergency Cache Clear] Forced collection failed before measurement: ${getStepErrorMessage(error)}`);
    }
  }

  const memoryAfterClear = collectProcessMemorySnapshot();
  const totalClearedEntries = steps.reduce((total, step) => total + step.cleared, 0);
  const failedCaches = steps.filter((step) => step.error !== undefined).length;
  const clearedSummary = steps
    .filter((step) => step.cleared > 0)
    .map((step) => `${step.name}:${step.cleared}`)
    .join(", ");

  log.warn(
    `[Emergency Cache Clear] Cleared ${totalClearedEntries} entries across ${steps.length} cache groups` +
      ` (STM ${includeShortTermMemory ? "cleared" : "preserved"}, source=${options.source ?? "unknown"})` +
      (clearedSummary ? `: ${clearedSummary}` : ""),
  );

  if (failedCaches > 0) {
    const failures = steps
      .filter((step) => step.error !== undefined)
      .map((step) => `${step.name}:${step.error}`)
      .join(", ");
    log.warn(`[Emergency Cache Clear] ${failedCaches} cache clear step(s) failed: ${failures}`);
  }

  const metricFields: Record<string, number | string> = {
    totalClearedEntries,
    failedCaches,
    cacheGroups: steps.length,
    includeShortTermMemory: includeShortTermMemory ? 1 : 0,
    clearDiscordVolatileCaches: options.client && shouldClearDiscordVolatileCaches ? 1 : 0,
  };
  addProcessMemorySnapshotFields(metricFields, "before_clear", memoryBeforeClear);
  addProcessMemorySnapshotFields(metricFields, "after_clear", memoryAfterClear);
  addProcessMemoryDeltaFields(metricFields, "clear", memoryBeforeClear, memoryAfterClear);
  addPerCacheClearMetricFields(metricFields, steps);

  log.metric("emergency_cache_clear", metricFields);

  return {
    enabled,
    includeShortTermMemory,
    clearDiscordVolatileCaches: shouldClearDiscordVolatileCaches,
    totalClearedEntries,
    failedCaches,
    memoryBeforeClear,
    memoryAfterClear,
    steps,
  };
}
