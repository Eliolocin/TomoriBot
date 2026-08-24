/**
 * Host memory and pressure sampler.
 *
 * Reads the host's own `/proc` and `/sys` counters rather than this process's usage. Docker does
 * not virtualize `/proc/meminfo` or `/proc/pressure/*`, so a container sees the real host values;
 * that is normally a wart, but it is what lets the bot record host telemetry without a host-side
 * agent. Removing the AzureMonitorLinuxAgent left host memory percent living only in
 * `/var/log/oom-observer.log`, a flat file rather than a queryable series.
 *
 * Every source is read independently and a missing or unparseable file drops only its own fields,
 * because this runs on developer machines where none of these paths exist.
 */

import { readFile } from "node:fs/promises";

export type HostMemoryFields = Record<string, number>;

/**
 * Reads one `/proc` or `/sys` path, resolving to `null` when it is absent or unreadable.
 * Injected rather than module-mocked: Bun registers `mock.module` process-wide for the whole
 * run and `mock.restore()` does not undo it, so a mocked `node:fs` leaks into every later file.
 */
export type HostFileReader = (path: string) => Promise<string | null>;

const KB_PER_MB = 1024;
const BYTES_PER_MB = 1024 * 1024;

/**
 * Cumulative counters from the previous sample, so `/proc/vmstat` totals can be reported as rates.
 * Levels are useless here: the runbook's rule for these fields is to read them as differences
 * between samples, never as absolutes.
 */
let previousCounters: { values: Record<string, number>; atMs: number } | null = null;

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Parses the `Key:   value kB` shape of `/proc/meminfo`. */
function parseMeminfo(text: string): Record<string, number> {
  const values: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^(\w+):\s+(\d+)\s*kB$/);
    if (match) values[match[1]] = Number(match[2]);
  }
  return values;
}

/**
 * Parses one `/proc/pressure/*` file into `{ some: {avg10,…}, full: {…} }`.
 * `full` is the share of wall time every task was blocked, which is the variant that tracked
 * every incident in this deployment; `some` is kept because it moves earlier.
 */
function parsePressure(text: string): Record<string, Record<string, number>> {
  const parsed: Record<string, Record<string, number>> = {};
  for (const line of text.split("\n")) {
    const [kind, ...rest] = line.trim().split(/\s+/);
    if (kind !== "some" && kind !== "full") continue;
    const windows: Record<string, number> = {};
    for (const pair of rest) {
      const [key, value] = pair.split("=");
      const numeric = Number(value);
      if (key && Number.isFinite(numeric)) windows[key] = numeric;
    }
    parsed[kind] = windows;
  }
  return parsed;
}

function addMeminfoFields(fields: HostMemoryFields, text: string): void {
  const info = parseMeminfo(text);
  const total = info.MemTotal;
  if (!total) return;

  fields.host_total_mb = round(total / KB_PER_MB);
  if (info.MemAvailable !== undefined) {
    fields.host_avail_mb = round(info.MemAvailable / KB_PER_MB);
    fields.host_avail_pct = round((info.MemAvailable / total) * 100);
  }
  if (info.MemFree !== undefined) fields.host_free_mb = round(info.MemFree / KB_PER_MB);
  if (info.Cached !== undefined) fields.host_cache_mb = round(info.Cached / KB_PER_MB);
  if (info.SwapTotal !== undefined && info.SwapFree !== undefined) {
    fields.host_swap_used_mb = round((info.SwapTotal - info.SwapFree) / KB_PER_MB);
  }
}

function addPressureFields(fields: HostMemoryFields, resource: "mem" | "io", text: string): void {
  const pressure = parsePressure(text);
  for (const kind of ["some", "full"] as const) {
    const windows = pressure[kind];
    if (!windows) continue;
    for (const window of ["avg10", "avg60", "avg300"] as const) {
      const value = windows[window];
      if (value !== undefined) fields[`${resource}_${kind}_${window}`] = value;
    }
  }
}

/**
 * Splits swap usage per device. The zram device and the disk-backed `/swapfile` differ by roughly
 * 100x in fault cost, so the aggregate from `/proc/meminfo` cannot answer whether the host is
 * merely compressing or actually paging to disk.
 */
function addSwapDeviceFields(fields: HostMemoryFields, text: string): void {
  for (const line of text.split("\n").slice(1)) {
    const [filename, , , used] = line.trim().split(/\s+/);
    const usedKb = Number(used);
    if (!filename || !Number.isFinite(usedKb)) continue;
    if (filename.includes("zram")) fields.zram_used_mb = round(usedKb / KB_PER_MB);
    else fields.swapfile_used_mb = round(usedKb / KB_PER_MB);
  }
}

/**
 * `orig_data_size` and `compr_data_size` from `/sys/block/zram0/mm_stat`. `swapon` reports the
 * uncompressed size, which hides how much RAM the device actually holds, so the ratio is the only
 * way to see how close the pool is to its real ceiling.
 */
function addZramFields(fields: HostMemoryFields, text: string): void {
  const [orig, compressed] = text.trim().split(/\s+/).map(Number);
  if (!Number.isFinite(orig) || !Number.isFinite(compressed) || compressed <= 0) return;
  fields.zram_orig_mb = round(orig / BYTES_PER_MB);
  fields.zram_compr_mb = round(compressed / BYTES_PER_MB);
  fields.zram_ratio = round(orig / compressed);
}

/**
 * Converts `/proc/vmstat`'s cumulative swap and fault counters into per-second rates.
 *
 * A negative delta means the host rebooted and the counters restarted, so the rates are dropped
 * rather than reported as a large negative spike. The first sample after startup has no
 * predecessor and therefore reports no rates at all.
 */
function addVmstatRateFields(fields: HostMemoryFields, text: string, nowMs: number): void {
  const wanted = ["pswpin", "pswpout", "pgmajfault"] as const;
  const values: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    if ((wanted as readonly string[]).includes(key)) values[key] = Number(value);
  }
  if (Object.keys(values).length !== wanted.length) return;

  const previous = previousCounters;
  previousCounters = { values, atMs: nowMs };
  if (!previous) return;

  const elapsedSeconds = (nowMs - previous.atMs) / 1000;
  if (elapsedSeconds <= 0) return;

  const names: Record<string, string> = {
    pswpin: "swap_in_per_s",
    pswpout: "swap_out_per_s",
    pgmajfault: "major_faults_per_s",
  };
  for (const key of wanted) {
    const delta = values[key] - previous.values[key];
    if (delta < 0) return;
    fields[names[key]] = round(delta / elapsedSeconds);
  }
}

/**
 * Samples host memory, PSI, swap, and zram.
 *
 * Returns `null` when nothing could be read, which is the normal case off Linux, so the caller can
 * skip the sink entirely rather than writing an empty row every interval.
 */
export async function collectHostMemorySnapshot(
  nowMs = Date.now(),
  read: HostFileReader = readText,
): Promise<HostMemoryFields | null> {
  const [meminfo, memPressure, ioPressure, swaps, zram, vmstat] = await Promise.all([
    read("/proc/meminfo"),
    read("/proc/pressure/memory"),
    read("/proc/pressure/io"),
    read("/proc/swaps"),
    read("/sys/block/zram0/mm_stat"),
    read("/proc/vmstat"),
  ]);

  const fields: HostMemoryFields = {};
  if (meminfo) addMeminfoFields(fields, meminfo);
  if (memPressure) addPressureFields(fields, "mem", memPressure);
  if (ioPressure) addPressureFields(fields, "io", ioPressure);
  if (swaps) addSwapDeviceFields(fields, swaps);
  if (zram) addZramFields(fields, zram);
  if (vmstat) addVmstatRateFields(fields, vmstat, nowMs);

  return Object.keys(fields).length > 0 ? fields : null;
}

/** Test seam: the rate fields depend on state carried between calls. */
export function resetHostMemoryCountersForTests(): void {
  previousCounters = null;
}
