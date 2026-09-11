import { log } from "@/utils/misc/logger";
import { DEFAULT_MESSAGE_FETCH_LIMIT } from "@/utils/discord/messageFetchLimit";
import {
  addProcessMemoryDeltaFields,
  addProcessMemorySnapshotFields,
  collectProcessMemorySnapshot,
  type ForcedGcRuntime,
  runForcedGc,
} from "@/utils/misc/processMemory";

/**
 * ============================================================================
 * GUARD CONFIGURATION
 * All security limits and thresholds centralized here for easy tuning
 * ============================================================================
 */

const IS_PRODUCTION = process.env.RUN_ENV === "production";
export const GUARDS_ENABLED = IS_PRODUCTION; // Automatically disabled in dev

export const MESSAGE_RATE_LIMITS = {
  /**
   * Maximum concurrent messages a single user can have active (processing + queued)
   * across ALL servers. Prevents a single user from spamming the bot.
   * @default 3 in production, Infinity in development
   */
  MAX_USER_ACTIVE_MESSAGES: GUARDS_ENABLED
    ? Number.parseInt(process.env.MAX_USER_ACTIVE_MESSAGES || "3", 10)
    : Number.POSITIVE_INFINITY,

  /**
   * Maximum concurrent messages a single server can have active (processing + queued)
   * across ALL channels. Prevents a single server from monopolizing bot resources.
   * @default 10 in production, Infinity in development
   */
  MAX_SERVER_ACTIVE_MESSAGES: GUARDS_ENABLED
    ? Number.parseInt(process.env.MAX_SERVER_ACTIVE_MESSAGES || "10", 10)
    : Number.POSITIVE_INFINITY,
} as const;

export const MEDIA_LIMITS = {
  /**
   * Default total number of messages fetched for context building.
   * Actual runtime limit is configurable per server via /config message-fetch-limit.
   * @default 80
   */
  MESSAGE_FETCH_LIMIT: DEFAULT_MESSAGE_FETCH_LIMIT,

  /**
   * Number of most recent messages that can contain full media (images, videos, GIFs)
   * Messages beyond this window will have media replaced with text placeholders
   * @default 10 messages
   */
  MEDIA_CONTEXT_WINDOW: Number.parseInt(process.env.MEDIA_CONTEXT_WINDOW || "10", 10),

  /**
   * Maximum size per individual media file in MB (for conversation context)
   * Larger files will be rejected or downscaled
   * @default 10 MB
   */
  MAX_MEDIA_SIZE_MB: Number.parseInt(process.env.MAX_MEDIA_SIZE_MB || "10", 10),

  /**
   * Maximum size per individual GIF file in MB (for process_gif tool in dev)
   * GIFs larger than this will be rejected before processing
   * @default 50 MB
   */
  MAX_GIF_SIZE_MB: Number.parseInt(process.env.MAX_GIF_SIZE_MB || "50", 10),
} as const;

export const PERSONA_LIMITS = {
  /**
   * Maximum size for persona avatar attachments (create/generate commands)
   * Used for image processing operations (download, crop, base64 encode)
   * @default 10 MB (matches Discord's standard upload limit)
   */
  MAX_AVATAR_SIZE_MB: Number.parseInt(process.env.MAX_AVATAR_SIZE_MB || "10", 10),
} as const;

export const IMPORT_LIMITS = {
  /**
   * Maximum size for data export JSON files (personal/server memories)
   * @default 2 MB
   */
  MAX_DATA_IMPORT_SIZE_MB: Number.parseInt(process.env.MAX_DATA_IMPORT_SIZE_MB || "2", 10),

  /**
   * Maximum size for persona preset PNG files (image + embedded metadata)
   * @default 10 MB
   */
  MAX_PERSONA_IMPORT_SIZE_MB: Number.parseInt(process.env.MAX_PERSONA_IMPORT_SIZE_MB || "10", 10),

  /**
   * Maximum compressed size for a Character Card V3 (`.charx`) archive. An
   * archive carries an asset tree whose expanded size the download bound cannot
   * describe, so this value is a separate knob from the PNG/JSON bound.
   * @default 10 MB
   */
  MAX_CHARX_IMPORT_SIZE_MB: Number.parseInt(process.env.MAX_CHARX_IMPORT_SIZE_MB || "10", 10),

  /**
   * Maximum decompressed size of the `card.json` payload inside a `.charx`
   * archive. Only the card is decompressed; this bound is what stops a
   * compressed bomb from spending memory on the one entry that is read.
   * @default 4 MB
   */
  MAX_CHARX_CARD_SIZE_MB: Number.parseInt(process.env.MAX_CHARX_CARD_SIZE_MB || "4", 10),

  /**
   * Maximum number of assets a `.charx` card may declare before the import is
   * refused. Assets are not imported, so this only bounds the header scan.
   * @default 500
   */
  MAX_CHARX_ASSETS: Number.parseInt(process.env.MAX_CHARX_ASSETS || "500", 10),

  /**
   * Maximum declared total size of a `.charx` card's embedded assets. Sizes come
   * from the zip central directory, so a hostile tree is refused without being
   * decompressed.
   * @default 256 MB
   */
  MAX_CHARX_ASSET_TOTAL_MB: Number.parseInt(process.env.MAX_CHARX_ASSET_TOTAL_MB || "256", 10),
} as const;

export const PERSONA_RATE_LIMITS = {
  /**
   * Maximum persona operations (create/generate) per user per 24 hours
   * Prevents volume-based DDoS via rapid successive uploads
   * @default 25 in production, Infinity in development
   */
  MAX_OPERATIONS_PER_DAY: GUARDS_ENABLED
    ? Number.parseInt(process.env.MAX_PERSONA_OPERATIONS_PER_DAY || "25", 10)
    : Number.POSITIVE_INFINITY,
} as const;

export const IMPORT_RATE_LIMITS = {
  /**
   * Maximum import operations per user per 24 hours
   * Prevents volume-based DDoS via rapid successive imports
   * @default 50 in production, Infinity in development
   */
  MAX_OPERATIONS_PER_DAY: GUARDS_ENABLED
    ? Number.parseInt(process.env.MAX_IMPORT_OPERATIONS_PER_DAY || "50", 10)
    : Number.POSITIVE_INFINITY,
} as const;

export const DOCUMENT_RATE_LIMITS = {
  /**
   * Maximum document upload operations per user per 24 hours
   * Prevents volume-based DDoS via rapid successive document uploads
   * @default 20 in production, Infinity in development
   */
  MAX_OPERATIONS_PER_DAY: GUARDS_ENABLED
    ? Number.parseInt(process.env.MAX_DOCUMENT_OPERATIONS_PER_DAY || "20", 10)
    : Number.POSITIVE_INFINITY,
} as const;

export const AVATAR_RATE_LIMITS = {
  /**
   * Maximum avatar changes per server (guild) per 24 hours
   * Note: This is a guild-level quota, not user-level
   * Prevents server avatar spam attacks
   * @default 30 in production, Infinity in development
   */
  MAX_OPERATIONS_PER_DAY: GUARDS_ENABLED
    ? Number.parseInt(process.env.MAX_AVATAR_OPERATIONS_PER_DAY || "30", 10)
    : Number.POSITIVE_INFINITY,
} as const;

export const FETCH_LIMITS = {
  /**
   * Maximum fetch response size in MB (byte size check via HEAD request)
   * Prevents downloading excessively large webpages into memory
   * @default 5 MB in production, 50 MB in development
   */
  MAX_FETCH_SIZE_MB: GUARDS_ENABLED
    ? Number.parseInt(process.env.MAX_FETCH_SIZE_MB || "5", 10)
    : Number.parseInt(process.env.MAX_FETCH_SIZE_MB || "50", 10),

  /**
   * Base maximum character count for fetch content
   * This is dynamically reduced based on memory status using percentage cuts
   * @default 50000 characters
   */
  FETCH_CHAR_LIMIT: 50000,

  /**
   * Percentage cuts applied to FETCH_CHAR_LIMIT based on memory status
   * Safe mode: 100% (50k chars)
   * Warning mode: 30% (15k chars)
   * Critical mode: 4% (2k chars)
   */
  MEMORY_REDUCTION_WARNING: 0.3, // 30% of base limit
  MEMORY_REDUCTION_CRITICAL: 0.04, // 4% of base limit
} as const;

export const STREAMING_LIMITS = {
  /**
   * Maximum number of message flushes per stream session
   * Prevents malicious prompts from causing excessive Discord API calls
   * Each flush = 1 Discord message sent (semantically complete chunks)
   * @default 40 in production, Infinity in development
   */
  MAX_FLUSH_COUNT: GUARDS_ENABLED ? Number.parseInt(process.env.MAX_FLUSH_COUNT || "40", 10) : Number.POSITIVE_INFINITY,
} as const;

/**
 * Returns memory protection configuration, read lazily from process.env.
 * Must be a function (not a const) so values are read after secrets are
 * loaded in index.ts, so module-level consts evaluate before getAppSecrets() runs.
 */
export function MEMORY_PROTECTION() {
  return {
    /**
     * Total container memory limit in MB (AWS instance/ECS task limit).
     * Set CONTAINER_MEMORY_LIMIT_MB in your environment to match actual allocation.
     * @default 1024 MB
     */
    CONTAINER_MEMORY_LIMIT_MB: Number.parseInt(process.env.CONTAINER_MEMORY_LIMIT_MB || "1024", 10),

    /**
     * Warning threshold as a fraction of total RSS (0.0 - 1.0).
     * When exceeded, reduce media processing aggressiveness.
     * @default 0.75 (75%)
     */
    MEMORY_WARNING_THRESHOLD: Number.parseFloat(process.env.MEMORY_WARNING_THRESHOLD || "0.75"),

    /**
     * Critical threshold as a fraction of total RSS (0.0 - 1.0).
     * When exceeded, enter emergency mode (text-only, force GC).
     * @default 0.85 (85%)
     */
    MEMORY_CRITICAL_THRESHOLD: Number.parseFloat(process.env.MEMORY_CRITICAL_THRESHOLD || "0.85"),

    /**
     * Emergency cooldown period in milliseconds after entering critical mode.
     * During this time, all media processing is disabled.
     * @default 60000 (1 minute)
     */
    EMERGENCY_COOLDOWN_MS: Number.parseInt(process.env.EMERGENCY_COOLDOWN_MS || "60000", 10),
  };
}

/**
 * ============================================================================
 * MEMORY GUARD (Global Singleton)
 * Monitors total process memory and triggers circuit breaker when necessary
 * ============================================================================
 */
export type MemoryStatus = "safe" | "warning" | "critical";

export interface MemoryCheckResult {
  status: MemoryStatus;
  rssUsedMB: number;
  memoryLimitMB: number;
  percentUsed: number;
  shouldProcessMedia: boolean;
  reducedMediaWindow?: number; // Suggested reduced media window during warning
}

export interface MemoryEmergencyEvent {
  rssUsedMB: number;
  memoryLimitMB: number;
  percentUsed: number;
  cooldownMs: number;
  enteredAt: number;
}

export type MemoryEmergencyHandler = (event: MemoryEmergencyEvent) => void;

const memoryEmergencyHandlers = new Set<MemoryEmergencyHandler>();

export function registerMemoryEmergencyHandler(handler: MemoryEmergencyHandler): () => void {
  memoryEmergencyHandlers.add(handler);
  return () => {
    memoryEmergencyHandlers.delete(handler);
  };
}

function notifyMemoryEmergencyHandlers(event: MemoryEmergencyEvent): void {
  for (const handler of memoryEmergencyHandlers) {
    try {
      handler(event);
    } catch (error) {
      log.error("Memory emergency handler failed", error, {
        errorType: "memory_emergency_handler_failed",
      });
    }
  }
}

function forceGarbageCollection(): void {
  const beforeGc = collectProcessMemorySnapshot();
  let gcRuntime: ForcedGcRuntime = "unavailable";
  let failed = 0;

  try {
    gcRuntime = runForcedGc();
    if (gcRuntime === "unavailable") {
      log.warn("Garbage collection not available (Bun.gc or Node --expose-gc required for forced GC)");
    } else {
      log.info(`Forced ${gcRuntime} garbage collection`);
    }
  } catch (error) {
    failed = 1;
    log.error("Forced garbage collection failed", error, {
      errorType: "forced_gc_failed",
      metadata: { gcRuntime },
    });
  }

  const afterGc = collectProcessMemorySnapshot();
  const metricFields: Record<string, number | string> = {
    runtime: gcRuntime,
    available: gcRuntime === "unavailable" ? 0 : 1,
    failed,
  };
  addProcessMemorySnapshotFields(metricFields, "before_gc", beforeGc);
  addProcessMemorySnapshotFields(metricFields, "after_gc", afterGc);
  addProcessMemoryDeltaFields(metricFields, "gc", beforeGc, afterGc);
  log.metric("memory_forced_gc", metricFields);
}

class MemoryGuard {
  private isInEmergencyMode = false;
  private emergencyModeEnteredAt = 0;

  /**
   * Checks global process memory usage and returns status
   * This is called BEFORE processing any media to prevent OOM
   */
  checkMemory(): MemoryCheckResult {
    const protection = MEMORY_PROTECTION();

    // Disabled in development
    if (!GUARDS_ENABLED) {
      return {
        status: "safe",
        rssUsedMB: 0,
        memoryLimitMB: protection.CONTAINER_MEMORY_LIMIT_MB,
        percentUsed: 0,
        shouldProcessMedia: true,
      };
    }

    // Use RSS (Resident Set Size): the total memory the OS has allocated to this
    // process, including heap, native buffers, and shared libraries. This is what
    // the kernel's OOM killer tracks, so it's the correct metric for preventing crashes.
    const rssBytes = process.memoryUsage().rss;
    const limitBytes = protection.CONTAINER_MEMORY_LIMIT_MB * 1024 * 1024;

    const rssUsedMB = rssBytes / (1024 * 1024);
    const percentUsed = rssBytes / limitBytes;

    if (this.isInEmergencyMode) {
      const timeSinceEmergency = Date.now() - this.emergencyModeEnteredAt;

      if (timeSinceEmergency < protection.EMERGENCY_COOLDOWN_MS) {
        log.warn(
          `Still in emergency cooldown (${Math.round(timeSinceEmergency / 1000)}s / ${protection.EMERGENCY_COOLDOWN_MS / 1000}s). Media processing disabled.`,
        );
        return {
          status: "critical",
          rssUsedMB,
          memoryLimitMB: protection.CONTAINER_MEMORY_LIMIT_MB,
          percentUsed,
          shouldProcessMedia: false,
        };
      }

      log.info("Emergency cooldown expired. Resuming normal operation.");
      this.isInEmergencyMode = false;
    }

    if (percentUsed >= protection.MEMORY_CRITICAL_THRESHOLD) {
      if (!this.isInEmergencyMode) {
        this.enterEmergencyMode(rssUsedMB, percentUsed);
      }

      return {
        status: "critical",
        rssUsedMB,
        memoryLimitMB: protection.CONTAINER_MEMORY_LIMIT_MB,
        percentUsed,
        shouldProcessMedia: false,
      };
    }

    if (percentUsed >= protection.MEMORY_WARNING_THRESHOLD) {
      log.warn(
        `Memory warning: ${rssUsedMB.toFixed(2)} MB / ${protection.CONTAINER_MEMORY_LIMIT_MB} MB (${(percentUsed * 100).toFixed(1)}%)`,
      );

      return {
        status: "warning",
        rssUsedMB,
        memoryLimitMB: protection.CONTAINER_MEMORY_LIMIT_MB,
        percentUsed,
        shouldProcessMedia: true,
        reducedMediaWindow: 5, // Reduce to only last 5 messages
      };
    }

    return {
      status: "safe",
      rssUsedMB,
      memoryLimitMB: protection.CONTAINER_MEMORY_LIMIT_MB,
      percentUsed,
      shouldProcessMedia: true,
    };
  }

  /**
   * Enters emergency mode when critical RSS threshold is exceeded.
   * Triggers garbage collection and sets cooldown timer.
   */
  private enterEmergencyMode(rssUsedMB: number, percentUsed: number): void {
    const protection = MEMORY_PROTECTION();
    this.isInEmergencyMode = true;
    this.emergencyModeEnteredAt = Date.now();
    const event: MemoryEmergencyEvent = {
      rssUsedMB,
      memoryLimitMB: protection.CONTAINER_MEMORY_LIMIT_MB,
      percentUsed,
      cooldownMs: protection.EMERGENCY_COOLDOWN_MS,
      enteredAt: this.emergencyModeEnteredAt,
    };

    log.error(
      `CRITICAL MEMORY PRESSURE: ${rssUsedMB.toFixed(2)} MB / ${protection.CONTAINER_MEMORY_LIMIT_MB} MB RSS (${(percentUsed * 100).toFixed(1)}%). Entering emergency mode.`,
      {
        errorType: "memory_critical",
        metadata: {
          rssUsedMB,
          percentUsed: percentUsed * 100,
          cooldownMs: protection.EMERGENCY_COOLDOWN_MS,
        },
      },
    );

    notifyMemoryEmergencyHandlers(event);

    // Kept even though the cache clearer collects before it measures: clearing can be turned
    // off by env, and no handler is registered at all until the memory monitor starts.
    forceGarbageCollection();
  }

  /**
   * Gets the current media window based on memory status
   * Dynamically reduces window during high memory pressure
   */
  getMediaWindow(): number {
    const memCheck = this.checkMemory();

    if (memCheck.status === "critical") {
      return 0; // No media in critical mode
    }

    if (memCheck.status === "warning" && memCheck.reducedMediaWindow) {
      return memCheck.reducedMediaWindow;
    }

    return MEDIA_LIMITS.MEDIA_CONTEXT_WINDOW;
  }

  /**
   * Gets the current fetch character limit based on memory status
   * Dynamically reduces fetch size during high memory pressure
   * @returns Maximum characters allowed for fetch tool
   */
  getFetchCharLimit(): number {
    const memCheck = this.checkMemory();

    if (memCheck.status === "critical") {
      return Math.floor(FETCH_LIMITS.FETCH_CHAR_LIMIT * FETCH_LIMITS.MEMORY_REDUCTION_CRITICAL); // 4% = 2k chars
    }

    if (memCheck.status === "warning") {
      return Math.floor(FETCH_LIMITS.FETCH_CHAR_LIMIT * FETCH_LIMITS.MEMORY_REDUCTION_WARNING); // 30% = 15k chars
    }

    return FETCH_LIMITS.FETCH_CHAR_LIMIT; // 100% = 50k chars in safe mode
  }

  /**
   * Gets the current memory status without full check result
   */
  getStatus(): MemoryStatus {
    return this.checkMemory().status;
  }

  /**
   * Manually force emergency mode exit (for testing or admin commands)
   */
  forceExitEmergencyMode(): void {
    log.warn("Manually forcing exit from emergency mode");
    this.isInEmergencyMode = false;
    this.emergencyModeEnteredAt = 0;
  }
}

export const memoryGuard = new MemoryGuard();

/**
 * ============================================================================
 * QUOTA TRACKING SYSTEM
 * In-memory quota tracking for volume-based DDoS protection
 * ============================================================================
 */

/**
 * Quota entry tracking usage count and reset timestamp
 */
interface QuotaEntry {
  /**
   * Number of operations used within the current 24-hour window
   */
  count: number;

  /**
   * Unix timestamp (milliseconds) when the quota resets (24 hours from first operation)
   */
  resetAt: number;
}

/**
 * Quota tracking result returned by check functions
 */
interface QuotaCheckResult {
  /**
   * Whether the operation is allowed (quota not exceeded)
   */
  allowed: boolean;

  /**
   * Unix timestamp when the quota resets (if quota exceeded)
   */
  resetAt?: number;

  /**
   * Current operation count (if quota exceeded)
   */
  current?: number;

  /**
   * Maximum allowed operations (if quota exceeded)
   */
  max?: number;
}

const personaQuotaMap = new Map<string, QuotaEntry>(); // Key: userId
const importQuotaMap = new Map<string, QuotaEntry>(); // Key: userId
const documentQuotaMap = new Map<string, QuotaEntry>(); // Key: userId
const avatarQuotaMap = new Map<string, QuotaEntry>(); // Key: guildId (server-level)

/**
 * ============================================================================
 * RATE LIMIT GUARDS
 * Centralized rate limiting logic for messages and media
 * ============================================================================
 */

interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  currentCount?: number;
  maxLimit?: number;
}

/**
 * Checks if a user has exceeded their message rate limit
 * @param userActiveCount - Current number of active messages for this user
 */
export function checkUserRateLimit(userActiveCount: number): RateLimitResult {
  if (!GUARDS_ENABLED) {
    return { allowed: true };
  }

  const limit = MESSAGE_RATE_LIMITS.MAX_USER_ACTIVE_MESSAGES;

  if (userActiveCount >= limit) {
    return {
      allowed: false,
      reason: "user_rate_limit_exceeded",
      currentCount: userActiveCount,
      maxLimit: limit,
    };
  }

  return { allowed: true };
}

/**
 * Checks if a server has exceeded their message rate limit
 * @param serverActiveCount - Current number of active messages for this server
 */
export function checkServerRateLimit(serverActiveCount: number): RateLimitResult {
  if (!GUARDS_ENABLED) {
    return { allowed: true };
  }

  const limit = MESSAGE_RATE_LIMITS.MAX_SERVER_ACTIVE_MESSAGES;

  if (serverActiveCount >= limit) {
    return {
      allowed: false,
      reason: "server_rate_limit_exceeded",
      currentCount: serverActiveCount,
      maxLimit: limit,
    };
  }

  return { allowed: true };
}

/**
 * ============================================================================
 * QUOTA CHECK/INCREMENT FUNCTIONS
 * Volume-based DDoS protection for upload operations
 * ============================================================================
 */

/**
 * Atomically checks and reserves a persona operation quota slot
 * Combines check and increment into a single operation to prevent race conditions
 * @returns Quota check result - if allowed, quota is already reserved
 */
export function reservePersonaQuota(userId: string): QuotaCheckResult {
  // Disabled in development
  if (!GUARDS_ENABLED) {
    return { allowed: true };
  }

  const now = Date.now();
  const quota = personaQuotaMap.get(userId);
  const limit = PERSONA_RATE_LIMITS.MAX_OPERATIONS_PER_DAY;

  // First operation or expired quota - create with count 1 (atomically reserve)
  if (!quota || now >= quota.resetAt) {
    personaQuotaMap.set(userId, {
      count: 1,
      resetAt: now + 24 * 60 * 60 * 1000,
    });
    return { allowed: true };
  }

  if (quota.count >= limit) {
    return {
      allowed: false,
      resetAt: quota.resetAt,
      current: quota.count,
      max: limit,
    };
  }

  // Atomically increment and return success
  quota.count++;
  return { allowed: true };
}

/**
 * Atomically checks and reserves an import operation quota slot
 * Combines check and increment into a single operation to prevent race conditions
 * @returns Quota check result - if allowed, quota is already reserved
 */
export function reserveImportQuota(userId: string): QuotaCheckResult {
  // Disabled in development
  if (!GUARDS_ENABLED) {
    return { allowed: true };
  }

  const now = Date.now();
  const quota = importQuotaMap.get(userId);
  const limit = IMPORT_RATE_LIMITS.MAX_OPERATIONS_PER_DAY;

  // First operation or expired quota - create with count 1 (atomically reserve)
  if (!quota || now >= quota.resetAt) {
    importQuotaMap.set(userId, {
      count: 1,
      resetAt: now + 24 * 60 * 60 * 1000,
    });
    return { allowed: true };
  }

  if (quota.count >= limit) {
    return {
      allowed: false,
      resetAt: quota.resetAt,
      current: quota.count,
      max: limit,
    };
  }

  // Atomically increment and return success
  quota.count++;
  return { allowed: true };
}

/**
 * Atomically checks and reserves a document upload quota slot
 * Combines check and increment into a single operation to prevent race conditions
 * @returns Quota check result - if allowed, quota is already reserved
 */
export function reserveDocumentQuota(userId: string): QuotaCheckResult {
  // Disabled in development
  if (!GUARDS_ENABLED) {
    return { allowed: true };
  }

  const now = Date.now();
  const quota = documentQuotaMap.get(userId);
  const limit = DOCUMENT_RATE_LIMITS.MAX_OPERATIONS_PER_DAY;

  // First operation or expired quota - create with count 1 (atomically reserve)
  if (!quota || now >= quota.resetAt) {
    documentQuotaMap.set(userId, {
      count: 1,
      resetAt: now + 24 * 60 * 60 * 1000,
    });
    return { allowed: true };
  }

  if (quota.count >= limit) {
    return {
      allowed: false,
      resetAt: quota.resetAt,
      current: quota.count,
      max: limit,
    };
  }

  // Atomically increment and return success
  quota.count++;
  return { allowed: true };
}

/**
 * Atomically checks and reserves an avatar change quota slot
 * Combines check and increment into a single operation to prevent race conditions
 * Note: This is a guild-level quota, not user-level
 * @returns Quota check result - if allowed, quota is already reserved
 */
export function reserveAvatarQuota(guildId: string): QuotaCheckResult {
  // Disabled in development
  if (!GUARDS_ENABLED) {
    return { allowed: true };
  }

  const now = Date.now();
  const quota = avatarQuotaMap.get(guildId);
  const limit = AVATAR_RATE_LIMITS.MAX_OPERATIONS_PER_DAY;

  // First operation or expired quota - create with count 1 (atomically reserve)
  if (!quota || now >= quota.resetAt) {
    avatarQuotaMap.set(guildId, {
      count: 1,
      resetAt: now + 24 * 60 * 60 * 1000,
    });
    return { allowed: true };
  }

  if (quota.count >= limit) {
    return {
      allowed: false,
      resetAt: quota.resetAt,
      current: quota.count,
      max: limit,
    };
  }

  // Atomically increment and return success
  quota.count++;
  return { allowed: true };
}

/**
 * ============================================================================
 * UTILITY FUNCTIONS
 * ============================================================================
 */

/**
 * Logs current configuration (useful for debugging)
 */
export function logGuardConfiguration(): void {
  log.info("=== Guard Manager Configuration ===");
  log.info(`Guards Enabled: ${GUARDS_ENABLED}`);
  log.info(`Environment: ${process.env.RUN_ENV || "development"}`);
  log.info("\n--- Message Rate Limits ---");
  log.info(`Max User Active Messages: ${MESSAGE_RATE_LIMITS.MAX_USER_ACTIVE_MESSAGES}`);
  log.info(`Max Server Active Messages: ${MESSAGE_RATE_LIMITS.MAX_SERVER_ACTIVE_MESSAGES}`);
  log.info("\n--- Media Limits ---");
  log.info(`Media Context Window: ${MEDIA_LIMITS.MEDIA_CONTEXT_WINDOW}`);
  log.info(
    `Default Max Media Extend: ${MEDIA_LIMITS.MESSAGE_FETCH_LIMIT - MEDIA_LIMITS.MEDIA_CONTEXT_WINDOW} (actual value depends on /config message-fetch-limit)`,
  );
  log.info(`Max Media Size: ${MEDIA_LIMITS.MAX_MEDIA_SIZE_MB} MB`);
  log.info(`Max GIF Size: ${MEDIA_LIMITS.MAX_GIF_SIZE_MB} MB`);
  log.info("\n--- Persona Limits ---");
  log.info(`Max Avatar Size: ${PERSONA_LIMITS.MAX_AVATAR_SIZE_MB} MB`);
  log.info("\n--- Import Limits ---");
  log.info(`Max Data Import Size: ${IMPORT_LIMITS.MAX_DATA_IMPORT_SIZE_MB} MB`);
  log.info(`Max Persona Import Size: ${IMPORT_LIMITS.MAX_PERSONA_IMPORT_SIZE_MB} MB`);
  log.info(`Max Character Card Archive Size: ${IMPORT_LIMITS.MAX_CHARX_IMPORT_SIZE_MB} MB`);
  log.info(`Max Character Card Payload Size: ${IMPORT_LIMITS.MAX_CHARX_CARD_SIZE_MB} MB`);
  log.info("\n--- Upload Quota Limits (24h) ---");
  log.info(`Max Persona Operations: ${PERSONA_RATE_LIMITS.MAX_OPERATIONS_PER_DAY} per user`);
  log.info(`Max Import Operations: ${IMPORT_RATE_LIMITS.MAX_OPERATIONS_PER_DAY} per user`);
  log.info(`Max Document Operations: ${DOCUMENT_RATE_LIMITS.MAX_OPERATIONS_PER_DAY} per user`);
  log.info(`Max Avatar Operations: ${AVATAR_RATE_LIMITS.MAX_OPERATIONS_PER_DAY} per server`);
  log.info("\n--- Fetch Tool Limits ---");
  log.info(`Max Fetch Size: ${FETCH_LIMITS.MAX_FETCH_SIZE_MB} MB`);
  log.info(`Base Fetch Char Limit: ${FETCH_LIMITS.FETCH_CHAR_LIMIT}`);
  log.info(
    `Memory Reductions: ${FETCH_LIMITS.MEMORY_REDUCTION_WARNING * 100}% (warning), ${FETCH_LIMITS.MEMORY_REDUCTION_CRITICAL * 100}% (critical)`,
  );
  log.info("\n--- Streaming Limits ---");
  log.info(`Max Flush Count: ${STREAMING_LIMITS.MAX_FLUSH_COUNT}`);
  const protection = MEMORY_PROTECTION();
  log.info("\n--- Memory Protection ---");
  log.info(`Container Memory Limit: ${protection.CONTAINER_MEMORY_LIMIT_MB} MB (RSS)`);
  log.info(`Warning Threshold: ${protection.MEMORY_WARNING_THRESHOLD * 100}%`);
  log.info(`Critical Threshold: ${protection.MEMORY_CRITICAL_THRESHOLD * 100}%`);
  log.info(`Emergency Cooldown: ${protection.EMERGENCY_COOLDOWN_MS / 1000}s`);
  log.info("===================================");
}

/**
 * Renders an already-taken memory reading.
 *
 * Callers that branch on a reading must format that same reading rather than calling
 * `getMemoryStatusSummary`, which samples afresh. Emergency clearing runs between the two
 * samples, so prod logs carried lines whose label and body disagreed
 * ("changed to CRITICAL: ... - Status: WARNING").
 */
export function formatMemoryStatus(check: MemoryCheckResult): string {
  return `Memory (RSS): ${check.rssUsedMB.toFixed(2)} MB / ${check.memoryLimitMB} MB (${(check.percentUsed * 100).toFixed(1)}%) - Status: ${check.status.toUpperCase()}`;
}

/**
 * Gets a summary of current memory status (useful for monitoring/logging)
 */
export function getMemoryStatusSummary(): string {
  return formatMemoryStatus(memoryGuard.checkMemory());
}

/**
 * Initializes the quota cleanup interval
 * Removes expired quota entries every hour to prevent memory leaks
 * Should be called once during application startup
 */
export function initializeQuotaCleanup(): void {
  const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  setInterval(() => {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [userId, quota] of personaQuotaMap.entries()) {
      if (now >= quota.resetAt) {
        personaQuotaMap.delete(userId);
        cleanedCount++;
      }
    }

    for (const [userId, quota] of importQuotaMap.entries()) {
      if (now >= quota.resetAt) {
        importQuotaMap.delete(userId);
        cleanedCount++;
      }
    }

    for (const [userId, quota] of documentQuotaMap.entries()) {
      if (now >= quota.resetAt) {
        documentQuotaMap.delete(userId);
        cleanedCount++;
      }
    }

    for (const [guildId, quota] of avatarQuotaMap.entries()) {
      if (now >= quota.resetAt) {
        avatarQuotaMap.delete(guildId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      log.info(`Quota cleanup: Removed ${cleanedCount} expired entries`);
    }
  }, CLEANUP_INTERVAL_MS);

  log.info("Quota cleanup interval initialized (runs every 1 hour)");
}
