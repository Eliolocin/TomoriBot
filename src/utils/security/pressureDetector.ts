/**
 * Sustained host-pressure detector, evaluated but not armed.
 *
 * `memoryGuard` watches process RSS, which is the wrong signal for host distress: swap makes RSS
 * read safe while the host is saturating zram and faulting to disk, and on a roomy host the same
 * guard inverts and pins itself in permanent emergency mode. This detector reads host PSI and
 * active swap-in instead.
 *
 * It is a pure function over a sample sequence, deliberately: the same logic has to run from three
 * drivers. In-process it records what it would have done, offline it replays historical observer
 * logs to tune thresholds, and a host-side watchdog is the only place it could ever act, because an
 * in-process detector stops running during the starvation it exists to detect.
 *
 * Nothing here restarts anything. `evaluatePressure` returns a recommendation; acting on one is
 * gated on a threshold set tuned across several daily cycles, since tuning a dwell period and a
 * hysteresis band off a single day commits at design time the error this design forbids at runtime.
 */

export type PressureLevel = "normal" | "elevated" | "critical";

/**
 * Ordered by cost. Co-tenants come first because recycling them alone was measured cutting host IO
 * pressure 43%, so the cheap rung is worth having below the expensive one. A VM restart is reserved
 * for a confirmed reclaim livelock, where the guest agent cannot deliver a container restart.
 */
export type PressureAction = "none" | "recycle_cotenants" | "recycle_bot" | "restart_vm";

/** Why a recommendation was withheld even though the level warranted one. */
type PressureSuppression = "startup_grace" | "dwell" | "rate_limit" | null;

export interface PressureSample {
  atMs: number;
  ioFullAvg60?: number;
  memFullAvg60?: number;
  swapInPerS?: number;
  hostAvailMb?: number;
  containerSwapMb?: number;
}

export interface PressureThresholds {
  elevatedIoFull: number;
  criticalIoFull: number;
  /** Separate from the entry thresholds so the level cannot oscillate on one noisy sample. */
  recoveryIoFull: number;
  /** Distinguishes cold pages evicted once, which are harmless, from a live shortfall. */
  minSwapInPerS: number;
  /** Trailing window the duty cycle is measured over, not a continuous run. */
  elevatedDwellMs: number;
  criticalDwellMs: number;
  /**
   * Fraction of samples in the window that must be at or above the level.
   *
   * A continuous-run rule does not work here: replaying 12 days of production showed `io_full`
   * crosses any threshold constantly but is almost never above it without interruption, so a
   * "sustained for T" condition resets on every dip and fires zero times through real incidents.
   */
  minDutyCycle: number;
  startupGraceMs: number;
  minActionIntervalMs: number;
}

export interface PressureState {
  level: PressureLevel;
  /**
   * Trailing samples as `[timestamp, level rank]`, pruned to the longest window in use. Bounded by
   * that window rather than by run length, so it cannot grow with uptime.
   */
  recent: Array<[number, number]>;
  rawLevel: PressureLevel;
  lastActionAtMs: number | null;
  lastAction: PressureAction;
}

export interface PressureVerdict {
  level: PressureLevel;
  rawLevel: PressureLevel;
  wouldAct: PressureAction;
  suppressedBy: PressureSuppression;
  /** Share of the trailing window spent at or above each level, in the range 0 to 1. */
  elevatedDuty: number;
  criticalDuty: number;
  /** History actually available, so a short window can be distinguished from a quiet one. */
  windowSpanMs: number;
}

/**
 * Derived by replaying 67,967 observer samples spanning 290 h of production through this exact
 * function, not chosen by intuition. Run `scripts/devtools/replayPressureDetector.ts` to reproduce.
 *
 * The selection criterion was discrimination rather than sensitivity: this set recommends an action
 * 3 times across 12 days, all of them on the two days before any mitigation shipped, and **zero**
 * times from the day co-tenant recycling landed onward, including after the monitoring agent was
 * removed. Looser sets are not merely noisier, they are wrong in kind: at a 0.7 duty cycle the same
 * corpus produces 2 actions per day spaced exactly one rate-limit interval apart, which is the
 * detector reporting a chronic baseline as if it were a series of incidents.
 *
 * These remain observe-only. Arming is a separate decision.
 */
export const DEFAULT_PRESSURE_THRESHOLDS: PressureThresholds = {
  elevatedIoFull: 15,
  criticalIoFull: 30,
  recoveryIoFull: 5,
  minSwapInPerS: 1,
  elevatedDwellMs: 60 * 60 * 1000,
  criticalDwellMs: 30 * 60 * 1000,
  minDutyCycle: 0.95,
  startupGraceMs: 15 * 60 * 1000,
  minActionIntervalMs: 6 * 60 * 60 * 1000,
};

function numberFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Builds a threshold set from the environment, kept out of {@link evaluatePressure} so the decision
 * stays a pure function of its inputs and can be replayed against historical logs.
 */
export function pressureThresholdsFromEnv(): PressureThresholds {
  return {
    elevatedIoFull: numberFromEnv("PRESSURE_ELEVATED_IO_FULL", DEFAULT_PRESSURE_THRESHOLDS.elevatedIoFull),
    criticalIoFull: numberFromEnv("PRESSURE_CRITICAL_IO_FULL", DEFAULT_PRESSURE_THRESHOLDS.criticalIoFull),
    recoveryIoFull: numberFromEnv("PRESSURE_RECOVERY_IO_FULL", DEFAULT_PRESSURE_THRESHOLDS.recoveryIoFull),
    minSwapInPerS: numberFromEnv("PRESSURE_MIN_SWAP_IN_PER_S", DEFAULT_PRESSURE_THRESHOLDS.minSwapInPerS),
    elevatedDwellMs: numberFromEnv("PRESSURE_ELEVATED_DWELL_MS", DEFAULT_PRESSURE_THRESHOLDS.elevatedDwellMs),
    criticalDwellMs: numberFromEnv("PRESSURE_CRITICAL_DWELL_MS", DEFAULT_PRESSURE_THRESHOLDS.criticalDwellMs),
    minDutyCycle: numberFromEnv("PRESSURE_MIN_DUTY_CYCLE", DEFAULT_PRESSURE_THRESHOLDS.minDutyCycle),
    startupGraceMs: numberFromEnv("PRESSURE_STARTUP_GRACE_MS", DEFAULT_PRESSURE_THRESHOLDS.startupGraceMs),
    minActionIntervalMs: numberFromEnv(
      "PRESSURE_MIN_ACTION_INTERVAL_MS",
      DEFAULT_PRESSURE_THRESHOLDS.minActionIntervalMs,
    ),
  };
}

/**
 * Whether a recommendation may be acted on. Defaults to false and must stay false until thresholds
 * are tuned across several daily cycles; the in-process detector has no action path regardless, so
 * today this only labels the recorded series.
 */
export function isPressureDetectorArmed(): boolean {
  return process.env.PRESSURE_DETECTOR_ARMED === "true";
}

/** Reads a host snapshot's flat fields into the detector's input shape. */
export function pressureSampleFromHostFields(fields: Record<string, number>, atMs: number): PressureSample {
  return {
    atMs,
    ioFullAvg60: fields.io_full_avg60,
    memFullAvg60: fields.mem_full_avg60,
    swapInPerS: fields.swap_in_per_s,
    hostAvailMb: fields.host_avail_mb,
    containerSwapMb: fields.zram_used_mb,
  };
}

export function initialPressureState(): PressureState {
  return {
    level: "normal",
    recent: [],
    rawLevel: "normal",
    lastActionAtMs: null,
    lastAction: "none",
  };
}

const LEVEL_RANK: Record<PressureLevel, number> = { normal: 0, elevated: 1, critical: 2 };

/**
 * Classifies a single sample, before any dwell or hysteresis is applied.
 *
 * Both a PSI reading and a live swap-in rate are required for anything above normal. PSI alone
 * fires on a transient reclaim burst, and swap depth alone fires on cold pages that were evicted
 * once and are never touched again, which is the reading that has already taken production down
 * once when treated as an incident.
 */
function classify(sample: PressureSample, thresholds: PressureThresholds): PressureLevel {
  const ioFull = sample.ioFullAvg60;
  const swapIn = sample.swapInPerS;
  if (ioFull === undefined || swapIn === undefined) return "normal";
  if (swapIn < thresholds.minSwapInPerS) return "normal";
  if (ioFull >= thresholds.criticalIoFull) return "critical";
  if (ioFull >= thresholds.elevatedIoFull) return "elevated";
  return "normal";
}

/**
 * Recovery is checked against its own lower threshold rather than the entry one, so a host sitting
 * exactly at the boundary does not alternate between levels every sample.
 */
function hasRecovered(sample: PressureSample, thresholds: PressureThresholds): boolean {
  const ioFull = sample.ioFullAvg60;
  if (ioFull === undefined) return false;
  return ioFull <= thresholds.recoveryIoFull;
}

function actionFor(level: PressureLevel): PressureAction {
  if (level === "critical") return "recycle_bot";
  if (level === "elevated") return "recycle_cotenants";
  return "none";
}

/**
 * Advances the detector by one sample and returns what it would recommend.
 *
 * `processStartMs` drives the startup grace: the normal warm-up working set of roughly 700 MB is
 * reached within ten minutes, and treating that as an incident is how a naive threshold creates a
 * restart loop out of a healthy boot.
 */
/**
 * Share of samples inside the trailing window at or above `minRank`.
 *
 * `covered` reports whether history reaches back past the window at all, and it is deliberately
 * measured from the oldest *retained* sample rather than the oldest in-window one. Those differ:
 * history is retained for longer than any window precisely so this check can be true, since an
 * in-window sample is by definition younger than the window and could never prove coverage.
 */
function dutyCycle(
  recent: Array<[number, number]>,
  nowMs: number,
  windowMs: number,
  minRank: number,
): { duty: number; covered: boolean } {
  let hits = 0;
  let total = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const [atMs, rank] = recent[i];
    if (nowMs - atMs > windowMs) break;
    total++;
    if (rank >= minRank) hits++;
  }
  const oldestRetained = recent.length > 0 ? recent[0][0] : nowMs;
  return { duty: total === 0 ? 0 : hits / total, covered: nowMs - oldestRetained >= windowMs };
}

/**
 * Advances the detector by one sample and returns what it would recommend.
 *
 * `processStartMs` drives the startup grace: the normal warm-up working set of roughly 700 MB is
 * reached within ten minutes, and treating that as an incident is how a naive threshold creates a
 * restart loop out of a healthy boot.
 */
export function evaluatePressure(
  state: PressureState,
  sample: PressureSample,
  processStartMs: number,
  thresholds: PressureThresholds = DEFAULT_PRESSURE_THRESHOLDS,
): { state: PressureState; verdict: PressureVerdict } {
  const rawLevel = classify(sample, thresholds);

  // Retain twice the longest window so `covered` can be satisfied: pruning to exactly the window
  // leaves every retained sample younger than it, which made the condition unreachable.
  const longestWindowMs = Math.max(thresholds.elevatedDwellMs, thresholds.criticalDwellMs);
  const retainMs = longestWindowMs * 2;
  const recent = [...state.recent, [sample.atMs, LEVEL_RANK[rawLevel]] as [number, number]].filter(
    ([atMs]) => sample.atMs - atMs <= retainMs,
  );

  const elevated = dutyCycle(recent, sample.atMs, thresholds.elevatedDwellMs, LEVEL_RANK.elevated);
  const critical = dutyCycle(recent, sample.atMs, thresholds.criticalDwellMs, LEVEL_RANK.critical);

  // A window that is not yet full cannot satisfy a duty cycle: a fresh process would otherwise
  // reach 1.0 off its first two samples and act before it has seen anything.
  const criticalMet = critical.covered && critical.duty >= thresholds.minDutyCycle;
  const elevatedMet = elevated.covered && elevated.duty >= thresholds.minDutyCycle;

  const metLevel: PressureLevel = criticalMet ? "critical" : elevatedMet ? "elevated" : "normal";

  let level = state.level;
  if (LEVEL_RANK[metLevel] > LEVEL_RANK[level]) {
    level = metLevel;
  } else if (level !== "normal" && hasRecovered(sample, thresholds)) {
    level = "normal";
  }

  let wouldAct: PressureAction = "none";
  let suppressedBy: PressureSuppression = null;

  if (rawLevel !== "normal") {
    if (metLevel === "normal") {
      suppressedBy = "dwell";
    } else if (sample.atMs - processStartMs < thresholds.startupGraceMs) {
      suppressedBy = "startup_grace";
    } else if (state.lastActionAtMs !== null && sample.atMs - state.lastActionAtMs < thresholds.minActionIntervalMs) {
      suppressedBy = "rate_limit";
    } else {
      wouldAct = actionFor(metLevel);
    }
  }

  // The action timestamp advances on a recommendation even though nothing is armed, so the rate
  // limit is exercised by the observe-only run rather than first meeting reality when armed.
  const acted = wouldAct !== "none";

  return {
    state: {
      level,
      recent,
      rawLevel,
      lastActionAtMs: acted ? sample.atMs : state.lastActionAtMs,
      lastAction: acted ? wouldAct : state.lastAction,
    },
    verdict: {
      level,
      rawLevel,
      wouldAct,
      suppressedBy,
      elevatedDuty: Math.round(elevated.duty * 1000) / 1000,
      criticalDuty: Math.round(critical.duty * 1000) / 1000,
      windowSpanMs: recent.length > 0 ? sample.atMs - recent[0][0] : 0,
    },
  };
}

/** Flattens a verdict for `metric_samples`, whose fields are scalar. */
export function pressureVerdictFields(verdict: PressureVerdict, armed: boolean): Record<string, number | string> {
  return {
    pressure_level: verdict.level,
    pressure_raw_level: verdict.rawLevel,
    pressure_would_act: verdict.wouldAct,
    pressure_suppressed_by: verdict.suppressedBy ?? "none",
    pressure_elevated_duty: verdict.elevatedDuty,
    pressure_critical_duty: verdict.criticalDuty,
    pressure_window_span_ms: verdict.windowSpanMs,
    pressure_armed: armed ? 1 : 0,
  };
}
