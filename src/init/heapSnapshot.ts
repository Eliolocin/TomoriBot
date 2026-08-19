import { log } from "@/utils/misc/logger";

/**
 * Serializes the live heap in Chrome DevTools format.
 *
 * The "v8" format returns a string that can go straight to disk. The default JSC shape
 * is an object needing a JSON.stringify pass, which would hold the graph and its
 * serialization at the same time and double peak memory.
 */
type SnapshotGenerator = () => string;

const generateSnapshot: SnapshotGenerator = () => Bun.generateHeapSnapshot("v8");

/**
 * Registers a `SIGUSR2` handler that writes a heap snapshot to `HEAP_SNAPSHOT_DIR`.
 *
 * Opt-in by design. A snapshot serializes to a large fraction of the live heap as a
 * single string, so on a memory-constrained host taking one is itself a pressure event.
 * Leaving the handler unregistered unless a directory is configured makes that cost
 * impossible to trigger by accident.
 *
 * @param dir - Destination directory; defaults to `HEAP_SNAPSHOT_DIR`. Must be a
 *   writable mount, since the container root filesystem is read-only in production.
 * @param generate - Serializer seam. Generating a real snapshot is a stop-the-world
 *   pause proportional to heap size, which in a shared test process runs to seconds and
 *   starves unrelated suites of their timers and sockets. Tests pass a stub so they
 *   exercise this module's own behavior rather than the runtime's serializer.
 */
export function registerHeapSnapshotHandler(
  dir = process.env.HEAP_SNAPSHOT_DIR,
  generate: SnapshotGenerator = generateSnapshot,
): void {
  if (!dir) return;

  let inProgress = false;

  process.on("SIGUSR2", () => {
    // A second signal mid-serialization would double the peak allocation, which is the
    // one thing this must never do on a host already short of memory.
    if (inProgress) return;

    inProgress = true;
    void writeHeapSnapshot(dir, generate).finally(() => {
      inProgress = false;
    });
  });

  log.info(`Heap snapshot handler armed: SIGUSR2 writes to ${dir}`);
}

/**
 * Serializes the heap to `dir` and records the cost as a metric.
 *
 * Emitted through `log.metric` rather than `log.info` because production discards
 * everything below level 50, and the memory cost of the snapshot is the main thing
 * worth knowing afterwards.
 */
async function writeHeapSnapshot(dir: string, generate: SnapshotGenerator): Promise<void> {
  const startedAt = Date.now();
  const heapBeforeMb = process.memoryUsage().heapUsed / 1048576;
  const path = `${dir}/heap-${new Date().toISOString().replace(/[:.]/g, "-")}.heapsnapshot`;

  try {
    const bytes = await Bun.write(path, generate());

    log.metric("heap_snapshot", {
      path,
      bytes,
      heap_used_mb_before: Math.round(heapBeforeMb * 100) / 100,
      heap_used_mb_after: Math.round((process.memoryUsage().heapUsed / 1048576) * 100) / 100,
      duration_ms: Date.now() - startedAt,
    });
  } catch (error) {
    await log.error("Heap snapshot failed", error);
  }
}
