import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHeapSnapshotHandler } from "@/init/heapSnapshot";

/**
 * The handler is process-global, so each test removes its own SIGUSR2 listeners
 * rather than leaking them into the next one.
 */
const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "heapsnap-"));
  dirs.push(dir);
  return dir;
}

/** Waits for the handler's detached write to land, polling instead of racing a fixed delay. */
async function waitForFiles(dir: string, timeoutMs = 15000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = readdirSync(dir);
    if (files.length > 0) {
      // Let a concurrent second snapshot land too, so the guard assertion is not
      // merely observing that the first one finished first.
      await new Promise((resolve) => setTimeout(resolve, 500));
      return readdirSync(dir);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return readdirSync(dir);
}

afterEach(() => {
  process.removeAllListeners("SIGUSR2");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("registerHeapSnapshotHandler", () => {
  test("stays unregistered when no directory is configured", () => {
    registerHeapSnapshotHandler(undefined);
    expect(process.listenerCount("SIGUSR2")).toBe(0);
  });

  test("registers a listener when a directory is given", () => {
    registerHeapSnapshotHandler(makeDir());
    expect(process.listenerCount("SIGUSR2")).toBe(1);
  });

  test("writes a DevTools-loadable snapshot on SIGUSR2", async () => {
    const dir = makeDir();
    registerHeapSnapshotHandler(dir);

    process.emit("SIGUSR2");
    const files = await waitForFiles(dir);

    expect(files).toHaveLength(1);
    expect(files[0]).toEndWith(".heapsnapshot");

    const parsed = await Bun.file(join(dir, files[0])).json();
    expect(parsed.snapshot.meta.node_fields).toContain("self_size");
    expect(parsed.nodes.length).toBeGreaterThan(0);
  }, 30000);

  test("ignores a second signal while one snapshot is still serializing", async () => {
    const dir = makeDir();
    registerHeapSnapshotHandler(dir);

    // Both signals are delivered before the first write resolves, so a missing guard
    // would hold two full serializations at once: the allocation spike this must avoid.
    process.emit("SIGUSR2");
    process.emit("SIGUSR2");

    expect(await waitForFiles(dir)).toHaveLength(1);
  }, 30000);
});
