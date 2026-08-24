/**
 * Counters for connection-pool retirement events, drained into the periodic `host_memory`
 * metric sample.
 *
 * Deliberately importless. `client.ts` already sits in an import cycle with `logger.ts`
 * (client -> logger -> ErrorLogRepository -> client) that only survives because nothing uses
 * the imported bindings during module initialization. This module is imported by `client.ts`,
 * so it stays a pure counter and lets its caller do the logging.
 */

/** Codes grouped separately because they answer different questions during triage. */
const LIFETIME_CODE = "ERR_POSTGRES_LIFETIME_TIMEOUT";
const IDLE_CODE = "ERR_POSTGRES_IDLE_TIMEOUT";

const DEFAULT_EPISODE_QUIET_MS = 60_000;

interface PoolEventCounters {
  total: number;
  lifetime: number;
  idle: number;
  other: number;
  retriesRecovered: number;
  exhausted: number;
  /** Phase of the most recent lifetime retirement, so a drained sample carries one exemplar. */
  lastLifetimePhaseS: number;
}

function emptyCounters(): PoolEventCounters {
  return { total: 0, lifetime: 0, idle: 0, other: 0, retriesRecovered: 0, exhausted: 0, lastLifetimePhaseS: -1 };
}

let counters = emptyCounters();
let lastEventAtMs = 0;

const processStartMs = Date.now();

function episodeQuietMs(): number {
  const parsed = Number.parseInt(process.env.POOL_EVENT_EPISODE_QUIET_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EPISODE_QUIET_MS;
}

export interface PoolEventRecord {
  /** True when no pool event landed within the quiet window, marking an episode boundary. */
  isFirstOfEpisode: boolean;
  uptimeS: number;
  /**
   * Uptime folded into the configured lifetime window.
   *
   * Bun exposes no per-connection age, so this is the closest available discriminator: a pool
   * whose connections were all created in one burst retires them together, which shows up as
   * lifetime failures clustering at a consistent phase. A flat distribution instead means age
   * is not what is driving retirement, and raising `maxLifetime` would not help.
   */
  lifetimePhaseS: number;
}

/**
 * Counts one retired-connection error and reports whether it opens a new episode.
 *
 * @param maxLifetimeSeconds - Pool lifetime cap, used to fold uptime into a phase.
 */
export function recordPoolEvent(code: string, maxLifetimeSeconds: number): PoolEventRecord {
  const now = Date.now();
  const isFirstOfEpisode = now - lastEventAtMs > episodeQuietMs();
  lastEventAtMs = now;

  const uptimeS = Math.floor((now - processStartMs) / 1000);
  const lifetimePhaseS = maxLifetimeSeconds > 0 ? uptimeS % maxLifetimeSeconds : -1;

  counters.total += 1;
  if (code === LIFETIME_CODE) {
    counters.lifetime += 1;
    counters.lastLifetimePhaseS = lifetimePhaseS;
  } else if (code === IDLE_CODE) {
    counters.idle += 1;
  } else {
    counters.other += 1;
  }

  return { isFirstOfEpisode, uptimeS, lifetimePhaseS };
}

/**
 * Counts a retirement that a retry went on to absorb.
 *
 * This is the signal production has never had: the per-retry log line is `log.warn`, and the
 * production logger is pinned at `error`, so only exhausted retries were ever visible. Without
 * this the ratio of masked to user-visible failures cannot be measured.
 */
export function recordPoolRetryRecovered(): void {
  counters.retriesRecovered += 1;
}

export function recordPoolRetryExhausted(): void {
  counters.exhausted += 1;
}

/**
 * Returns the counts since the previous drain and resets them, so the fields carry a rate over
 * the sampling interval rather than an ever-growing total that every panel would have to
 * difference itself.
 */
export function drainPoolEventCounters(): Record<string, number> {
  const drained = counters;
  counters = emptyCounters();

  return {
    pool_errors_5m: drained.total,
    pool_lifetime_5m: drained.lifetime,
    pool_idle_5m: drained.idle,
    pool_other_5m: drained.other,
    pool_retries_recovered_5m: drained.retriesRecovered,
    pool_retries_exhausted_5m: drained.exhausted,
    pool_last_lifetime_phase_s: drained.lastLifetimePhaseS,
  };
}

/** Test seam: resets counters and episode state between cases. */
export function resetPoolEventCountersForTesting(): void {
  counters = emptyCounters();
  lastEventAtMs = 0;
}
