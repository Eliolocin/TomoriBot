import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  drainPoolEventCounters,
  recordPoolEvent,
  recordPoolRetryExhausted,
  recordPoolRetryRecovered,
  resetPoolEventCountersForTesting,
} from "@/utils/db/poolEvents";

const MAX_LIFETIME_S = 600;

const previousQuietMs = process.env.POOL_EVENT_EPISODE_QUIET_MS;

beforeEach(() => {
  resetPoolEventCountersForTesting();
  process.env.POOL_EVENT_EPISODE_QUIET_MS = "60000";
});

afterAll(() => {
  resetPoolEventCountersForTesting();
  if (previousQuietMs === undefined) delete process.env.POOL_EVENT_EPISODE_QUIET_MS;
  else process.env.POOL_EVENT_EPISODE_QUIET_MS = previousQuietMs;
});

describe("pool event counters", () => {
  it("splits the codes that answer different triage questions", () => {
    recordPoolEvent("ERR_POSTGRES_LIFETIME_TIMEOUT", MAX_LIFETIME_S);
    recordPoolEvent("ERR_POSTGRES_IDLE_TIMEOUT", MAX_LIFETIME_S);
    recordPoolEvent("ERR_POSTGRES_IDLE_TIMEOUT", MAX_LIFETIME_S);
    recordPoolEvent("ERR_POSTGRES_INVALID_MESSAGE", MAX_LIFETIME_S);

    const drained = drainPoolEventCounters();

    expect(drained.pool_errors_5m).toBe(4);
    expect(drained.pool_lifetime_5m).toBe(1);
    expect(drained.pool_idle_5m).toBe(2);
    expect(drained.pool_other_5m).toBe(1);
  });

  // Only the first event of an episode is logged; the rest are counted. If this inverted, one
  // incident would again produce thousands of lines and become a load source of its own.
  it("marks only the first event of an episode", () => {
    expect(recordPoolEvent("ERR_POSTGRES_IDLE_TIMEOUT", MAX_LIFETIME_S).isFirstOfEpisode).toBe(true);
    expect(recordPoolEvent("ERR_POSTGRES_IDLE_TIMEOUT", MAX_LIFETIME_S).isFirstOfEpisode).toBe(false);
    expect(recordPoolEvent("ERR_POSTGRES_LIFETIME_TIMEOUT", MAX_LIFETIME_S).isFirstOfEpisode).toBe(false);
  });

  it("reopens an episode once the quiet window has passed", () => {
    process.env.POOL_EVENT_EPISODE_QUIET_MS = "1";
    recordPoolEvent("ERR_POSTGRES_IDLE_TIMEOUT", MAX_LIFETIME_S);

    // The window has to be exceeded, not merely reached, so the clock must move past it.
    const start = Date.now();
    while (Date.now() - start <= 1) {
      // Spin: a sleep here would be slower than the window being tested.
    }

    expect(recordPoolEvent("ERR_POSTGRES_IDLE_TIMEOUT", MAX_LIFETIME_S).isFirstOfEpisode).toBe(true);
  });

  it("folds uptime into the lifetime window so cohort retirement is visible", () => {
    const { lifetimePhaseS, uptimeS } = recordPoolEvent("ERR_POSTGRES_LIFETIME_TIMEOUT", MAX_LIFETIME_S);

    expect(lifetimePhaseS).toBe(uptimeS % MAX_LIFETIME_S);
    expect(lifetimePhaseS).toBeLessThan(MAX_LIFETIME_S);
  });

  // The production logger is pinned at `error`, so the per-retry `log.warn` never reached any
  // sink and only exhausted retries were ever countable. Without this the masked-to-visible
  // ratio, which is the whole measure of whether retrying works, cannot be recovered.
  it("counts retries that recovered separately from retries that exhausted", () => {
    recordPoolRetryRecovered();
    recordPoolRetryRecovered();
    recordPoolRetryExhausted();

    const drained = drainPoolEventCounters();

    expect(drained.pool_retries_recovered_5m).toBe(2);
    expect(drained.pool_retries_exhausted_5m).toBe(1);
  });

  it("resets on drain so each sample carries the interval, not a running total", () => {
    recordPoolEvent("ERR_POSTGRES_IDLE_TIMEOUT", MAX_LIFETIME_S);
    drainPoolEventCounters();

    expect(drainPoolEventCounters().pool_errors_5m).toBe(0);
  });

  it("reports an absent phase rather than a misleading zero when nothing retired", () => {
    // Zero is a legitimate phase value, so a sample with no lifetime retirement has to be
    // distinguishable from one that retired exactly on the boundary.
    expect(drainPoolEventCounters().pool_last_lifetime_phase_s).toBe(-1);
  });
});
