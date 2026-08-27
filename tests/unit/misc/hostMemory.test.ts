import { beforeEach, describe, expect, it } from "bun:test";
import {
  collectHostMemorySnapshot,
  type HostFileReader,
  resetHostMemoryCountersForTests,
} from "@/utils/misc/hostMemory";

// Captured from the production container on 2026-08-19, so the parsers are checked against the
// exact whitespace and column layout the host actually emits rather than an idealized fixture.
const MEMINFO = `MemTotal:         862976 kB
MemFree:           68804 kB
MemAvailable:     217692 kB
Buffers:            1892 kB
Cached:           266784 kB
SwapTotal:       4194296 kB
SwapFree:        3390948 kB
`;

const MEM_PRESSURE = `some avg10=6.78 avg60=2.77 avg300=0.88 total=6536473696
full avg10=6.56 avg60=2.66 avg300=0.84 total=6191209904
`;

const IO_PRESSURE = `some avg10=4.23 avg60=1.50 avg300=0.52 total=14000097238
full avg10=2.76 avg60=1.04 avg300=0.39 total=12482310568
`;

const SWAPS = `Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority
/swapfile                               file\t\t3145724\t\t21704\t\t-2
/dev/zram0                              partition\t1048572\t\t779004\t\t100
`;

const ZRAM_MM_STAT = "742866944 194764825 200683520        0 336125952       72 13958232     2683   879616\n";

function vmstat(swapIn: number, swapOut: number, majorFaults: number): string {
  return `nr_free_pages 17201\npswpin ${swapIn}\npswpout ${swapOut}\npgmajfault ${majorFaults}\n`;
}

function readerFor(sources: Record<string, string>): HostFileReader {
  return async (path) => sources[path] ?? null;
}

const FULL_SOURCES: Record<string, string> = {
  "/proc/meminfo": MEMINFO,
  "/proc/pressure/memory": MEM_PRESSURE,
  "/proc/pressure/io": IO_PRESSURE,
  "/proc/swaps": SWAPS,
  "/sys/block/zram0/mm_stat": ZRAM_MM_STAT,
  "/proc/vmstat": vmstat(192763062, 165879498, 201968715),
};

describe("collectHostMemorySnapshot", () => {
  beforeEach(() => {
    resetHostMemoryCountersForTests();
  });

  it("parses a real production sample", async () => {
    const fields = await collectHostMemorySnapshot(0, readerFor(FULL_SOURCES));

    expect(fields).not.toBeNull();
    expect(fields?.host_total_mb).toBe(842.75);
    expect(fields?.host_avail_mb).toBe(212.59);
    expect(fields?.host_avail_pct).toBe(25.23);
    expect(fields?.host_cache_mb).toBe(260.53);
    expect(fields?.mem_full_avg60).toBe(2.66);
    expect(fields?.io_full_avg60).toBe(1.04);
    expect(fields?.io_some_avg10).toBe(4.23);
  });

  it("splits swap usage per device", async () => {
    // The aggregate from /proc/meminfo cannot answer the question this sink exists for: zram and
    // the disk-backed /swapfile differ by roughly 100x in fault cost, and the AMA offload's
    // success criterion is specifically /swapfile growth.
    const fields = await collectHostMemorySnapshot(0, readerFor(FULL_SOURCES));

    expect(fields?.swapfile_used_mb).toBe(21.2);
    expect(fields?.zram_used_mb).toBe(760.75);
  });

  it("reports the zram compression ratio, which swapon hides", async () => {
    const fields = await collectHostMemorySnapshot(0, readerFor(FULL_SOURCES));

    expect(fields?.zram_orig_mb).toBe(708.45);
    expect(fields?.zram_compr_mb).toBe(185.74);
    expect(fields?.zram_ratio).toBe(3.81);
  });

  it("returns null when no source is readable", async () => {
    // The normal case on a developer machine, where writing an empty row every interval would be
    // worse than writing none.
    expect(await collectHostMemorySnapshot(0, readerFor({}))).toBeNull();
  });

  it("drops only the fields of a missing source", async () => {
    const { "/sys/block/zram0/mm_stat": _zram, ...withoutZram } = FULL_SOURCES;
    const fields = await collectHostMemorySnapshot(0, readerFor(withoutZram));

    expect(fields?.zram_ratio).toBeUndefined();
    expect(fields?.host_total_mb).toBe(842.75);
  });

  it("reports no rates until a second sample exists", async () => {
    const fields = await collectHostMemorySnapshot(0, readerFor(FULL_SOURCES));

    expect(fields?.swap_in_per_s).toBeUndefined();
    expect(fields?.major_faults_per_s).toBeUndefined();
  });

  it("converts cumulative counters into per-second rates", async () => {
    const read = readerFor({ ...FULL_SOURCES, "/proc/vmstat": vmstat(1000, 2000, 3000) });
    await collectHostMemorySnapshot(0, read);

    const later = readerFor({ ...FULL_SOURCES, "/proc/vmstat": vmstat(1600, 2300, 3900) });
    const fields = await collectHostMemorySnapshot(10_000, later);

    expect(fields?.swap_in_per_s).toBe(60);
    expect(fields?.swap_out_per_s).toBe(30);
    expect(fields?.major_faults_per_s).toBe(90);
  });

  it("drops rates when the counters restart", async () => {
    // A host reboot zeroes /proc/vmstat. Reporting the negative delta would draw a large downward
    // spike into a series whose whole purpose is spotting upward pressure.
    const read = readerFor({ ...FULL_SOURCES, "/proc/vmstat": vmstat(9000, 9000, 9000) });
    await collectHostMemorySnapshot(0, read);

    const afterReboot = readerFor({ ...FULL_SOURCES, "/proc/vmstat": vmstat(12, 20, 30) });
    const fields = await collectHostMemorySnapshot(10_000, afterReboot);

    expect(fields?.swap_in_per_s).toBeUndefined();
    expect(fields?.host_total_mb).toBe(842.75);
  });
});
