/**
 * Event-loop progress monitor.
 *
 * A ready Discord client and a healthy WebSocket ping both stay green while the main thread is
 * starved or spinning, so neither says the bot is still doing work. This records whether a timer
 * callback is actually getting scheduled, which is the difference between "the process is alive"
 * and "the process is making progress".
 *
 * Reports only. Nothing here changes the `/healthz` verdict or restarts anything, because the
 * thresholds that would justify acting cannot be set until a post-AMA baseline exists. See
 * `plans/pressure-aware-recovery.md`.
 */

const SAMPLE_INTERVAL_MS = Math.max(Number.parseInt(process.env.EVENT_LOOP_SAMPLE_INTERVAL_MS || "", 10) || 1000, 100);

class EventLoopMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt = Date.now();
  private lastLagMs = 0;
  private peakLagSinceStartMs = 0;
  private peakLagSinceReadMs = 0;

  start(): void {
    if (this.timer) {
      return;
    }

    this.lastTickAt = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      const lag = Math.max(0, now - this.lastTickAt - SAMPLE_INTERVAL_MS);
      this.lastTickAt = now;
      this.lastLagMs = lag;
      this.peakLagSinceStartMs = Math.max(this.peakLagSinceStartMs, lag);
      this.peakLagSinceReadMs = Math.max(this.peakLagSinceReadMs, lag);
    }, SAMPLE_INTERVAL_MS);

    // Never hold the process open: this is diagnostics, and a live handle here would stall shutdown.
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Point-in-time reading for `/healthz`. Does not reset the windowed peak, so probing the endpoint
   * cannot blind the metrics series.
   */
  getSnapshot(): EventLoopSnapshot {
    return {
      running: this.timer !== null,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      stalenessMs: Date.now() - this.lastTickAt,
      lastLagMs: this.lastLagMs,
      peakLagSinceStartMs: this.peakLagSinceStartMs,
    };
  }

  /**
   * Peak lag observed since the previous call, then resets that window.
   *
   * Sampling `lastLagMs` on a 5-minute cadence would only ever describe the single tick before the
   * sample, which is a poor estimator of a spike lasting seconds. Reading a windowed maximum makes
   * each emitted point cover the whole interval. Intended for one caller only.
   */
  takeIntervalPeakLagMs(): number {
    const peak = this.peakLagSinceReadMs;
    this.peakLagSinceReadMs = 0;
    return peak;
  }
}

interface EventLoopSnapshot {
  running: boolean;
  sampleIntervalMs: number;

  /**
   * Milliseconds since the last recorded tick.
   *
   * Healthy readings sit between zero and one sample interval. A large value means callbacks are
   * not being scheduled, which is the CPU-starvation signature: the endpoint still answers because
   * a starved loop yields between chunks of work, while multi-step handlers behind it make no
   * progress. A loop blocked outright serves no response at all, so that case shows up as a probe
   * timeout rather than as a large number here.
   */
  stalenessMs: number;

  lastLagMs: number;
  peakLagSinceStartMs: number;
}

export const eventLoopMonitor = new EventLoopMonitor();
