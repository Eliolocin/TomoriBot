import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHeapSnapshotHandler } from "@/init/heapSnapshot";

/**
 * A stub serializer stands in for `Bun.generateHeapSnapshot`. Producing a real snapshot
 * is a stop-the-world pause proportional to heap size, which in the shared test process
 * runs to seconds and starves later database suites of their hook timeouts. The
 * DevTools format is the runtime's contract, not this module's, so these tests cover
 * only the wiring around it.
 */
const FAKE_SNAPSHOT = JSON.stringify({ snapshot: { meta: {} }, nodes: [] });

const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "heapsnap-"));
  dirs.push(dir);
  return dir;
}

/** Polls for the handler's detached write instead of racing a fixed delay. */
async function waitForFiles(dir: string, timeoutMs = 5000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readdirSync(dir).length > 0) {
      // Give a second concurrent write the chance to land, so the guard assertion is not
      // merely observing that the first one finished first.
      await new Promise((resolve) => setTimeout(resolve, 100));
      return readdirSync(dir);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return readdirSync(dir);
}

afterEach(() => {
  process.removeAllListeners("SIGUSR2");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("registerHeapSnapshotHandler", () => {
  test("stays unregistered when no directory is configured", () => {
    registerHeapSnapshotHandler(undefined, () => FAKE_SNAPSHOT);
    expect(process.listenerCount("SIGUSR2")).toBe(0);
  });

  test("registers a listener when a directory is given", () => {
    registerHeapSnapshotHandler(makeDir(), () => FAKE_SNAPSHOT);
    expect(process.listenerCount("SIGUSR2")).toBe(1);
  });

  test("writes the serialized snapshot on SIGUSR2", async () => {
    const dir = makeDir();
    registerHeapSnapshotHandler(dir, () => FAKE_SNAPSHOT);

    process.emit("SIGUSR2");
    const files = await waitForFiles(dir);

    expect(files).toHaveLength(1);
    expect(files[0]).toEndWith(".heapsnapshot");
    expect(await Bun.file(join(dir, files[0])).text()).toBe(FAKE_SNAPSHOT);
  });

  test("ignores a second signal while one snapshot is still serializing", async () => {
    const dir = makeDir();
    let calls = 0;
    registerHeapSnapshotHandler(dir, () => {
      calls++;
      return FAKE_SNAPSHOT;
    });

    // Both signals are delivered before the first write resolves, so a missing guard
    // would hold two full serializations at once: the allocation spike this must avoid.
    process.emit("SIGUSR2");
    process.emit("SIGUSR2");
    await waitForFiles(dir);

    expect(calls).toBe(1);
  });

  test("does not throw when the destination is unwritable", async () => {
    const dir = join(makeDir(), "nested", "missing-parent");
    registerHeapSnapshotHandler(dir, () => {
      throw new Error("serializer exploded");
    });

    process.emit("SIGUSR2");
    await new Promise((resolve) => setTimeout(resolve, 100));

    // A failed snapshot must never take the bot down: it is a diagnostic, not a feature.
    expect(process.listenerCount("SIGUSR2")).toBe(1);
  });
});
