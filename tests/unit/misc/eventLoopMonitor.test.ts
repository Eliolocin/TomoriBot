import { describe, expect, test } from "bun:test";
import { eventLoopMonitor } from "@/utils/misc/eventLoopMonitor";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("eventLoopMonitor", () => {
  test("reports not running before start, and starts idempotently", () => {
    expect(eventLoopMonitor.getSnapshot().running).toBe(false);

    eventLoopMonitor.start();
    eventLoopMonitor.start();

    expect(eventLoopMonitor.getSnapshot().running).toBe(true);
    eventLoopMonitor.stop();
    expect(eventLoopMonitor.getSnapshot().running).toBe(false);
  });

  test("staleness stays within a sample interval while the loop is free", async () => {
    eventLoopMonitor.start();
    const { sampleIntervalMs } = eventLoopMonitor.getSnapshot();

    await sleep(sampleIntervalMs * 2);

    // Allow one extra interval of slack: the assertion is that staleness is bounded by the cadence,
    // not that the timer is punctual on a loaded CI box.
    expect(eventLoopMonitor.getSnapshot().stalenessMs).toBeLessThan(sampleIntervalMs * 3);
    eventLoopMonitor.stop();
  });

  test("a blocking job shows up as lag, which is the whole point of the monitor", async () => {
    eventLoopMonitor.start();
    const { sampleIntervalMs } = eventLoopMonitor.getSnapshot();
    eventLoopMonitor.takeIntervalPeakLagMs();

    // Synchronous spin: this is the shape of the failure being detected, where the thread is busy
    // rather than idle, so no amount of Discord or WebSocket state would reveal it.
    const blockUntil = Date.now() + sampleIntervalMs * 2;
    while (Date.now() < blockUntil) {
      /* deliberately blocking */
    }

    await sleep(sampleIntervalMs * 2);

    expect(eventLoopMonitor.getSnapshot().peakLagSinceStartMs).toBeGreaterThan(0);
    eventLoopMonitor.stop();
  });

  test("takeIntervalPeakLagMs resets its window but leaves the since-start peak alone", async () => {
    eventLoopMonitor.start();
    const { sampleIntervalMs } = eventLoopMonitor.getSnapshot();

    const blockUntil = Date.now() + sampleIntervalMs * 2;
    while (Date.now() < blockUntil) {
      /* deliberately blocking */
    }
    await sleep(sampleIntervalMs * 2);

    const firstRead = eventLoopMonitor.takeIntervalPeakLagMs();
    expect(firstRead).toBeGreaterThan(0);

    // A second read with no intervening stall must not re-report the same spike, or every metrics
    // sample after an incident would look like a fresh one.
    expect(eventLoopMonitor.takeIntervalPeakLagMs()).toBeLessThan(firstRead);
    expect(eventLoopMonitor.getSnapshot().peakLagSinceStartMs).toBeGreaterThanOrEqual(firstRead);

    eventLoopMonitor.stop();
  });
});
