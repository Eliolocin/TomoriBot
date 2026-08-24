/**
 * Replays a host observer log through the pressure detector to tune its thresholds offline.
 *
 * The detector deliberately has no action path, so the only way to learn whether a threshold set is
 * sane is to ask what it would have done against history. `/var/log/oom-observer.log` samples every
 * 15 s and never rotates, so it holds the incidents themselves rather than a quiet window after
 * them. That is a far better tuning corpus than waiting for the live series to accumulate, and it
 * is available now.
 *
 * Usage:
 *   bun run scripts/devtools/replayPressureDetector.ts <observer.log> [--elevated 10] [--critical 20]
 *     [--recovery 5] [--min-swap-in 1] [--elevated-dwell-min 10] [--critical-dwell-min 5]
 *     [--grace-min 15] [--action-interval-h 6] [--verbose]
 *
 * The log is fetched with the read-only recipe in
 * `docs/en/wiki/azure-production-inspection.md`; this script never touches production itself.
 */

import { readFile } from "node:fs/promises";
import {
  DEFAULT_PRESSURE_THRESHOLDS,
  evaluatePressure,
  initialPressureState,
  type PressureAction,
  type PressureLevel,
  type PressureSample,
  type PressureThresholds,
} from "@/utils/security/pressureDetector";

interface ObserverRow {
  atMs: number;
  ioFullAvg60?: number;
  memFullAvg60?: number;
  availMb?: number;
  cgSwapMb?: number;
  majorFaults?: number;
}

function parseArgs(argv: string[]): { path: string; thresholds: PressureThresholds; verbose: boolean } {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const path = positional[0];
  if (!path) {
    throw new Error("Usage: replayPressureDetector.ts <observer.log> [--elevated N] ...");
  }

  const flag = (name: string): number | undefined => {
    const at = argv.indexOf(`--${name}`);
    if (at === -1) return undefined;
    const value = Number(argv[at + 1]);
    return Number.isFinite(value) ? value : undefined;
  };

  const minute = 60 * 1000;
  return {
    path,
    verbose: argv.includes("--verbose"),
    thresholds: {
      elevatedIoFull: flag("elevated") ?? DEFAULT_PRESSURE_THRESHOLDS.elevatedIoFull,
      criticalIoFull: flag("critical") ?? DEFAULT_PRESSURE_THRESHOLDS.criticalIoFull,
      recoveryIoFull: flag("recovery") ?? DEFAULT_PRESSURE_THRESHOLDS.recoveryIoFull,
      minSwapInPerS: flag("min-swap-in") ?? DEFAULT_PRESSURE_THRESHOLDS.minSwapInPerS,
      minDutyCycle: flag("min-duty") ?? DEFAULT_PRESSURE_THRESHOLDS.minDutyCycle,
      elevatedDwellMs:
        (flag("elevated-dwell-min") ?? DEFAULT_PRESSURE_THRESHOLDS.elevatedDwellMs / minute) * minute,
      criticalDwellMs:
        (flag("critical-dwell-min") ?? DEFAULT_PRESSURE_THRESHOLDS.criticalDwellMs / minute) * minute,
      startupGraceMs:
        (flag("grace-min") ?? DEFAULT_PRESSURE_THRESHOLDS.startupGraceMs / minute) * minute,
      minActionIntervalMs:
        (flag("action-interval-h") ?? DEFAULT_PRESSURE_THRESHOLDS.minActionIntervalMs / 3_600_000) *
        3_600_000,
    },
  };
}

/** Each observer line is flat `key=value`; PSI values are `avg10/avg60/avg300`. */
function parseRow(line: string): ObserverRow | null {
  const fields: Record<string, string> = {};
  for (const pair of line.trim().split(/\s+/)) {
    const at = pair.indexOf("=");
    if (at > 0) fields[pair.slice(0, at)] = pair.slice(at + 1);
  }

  const ts = Number(fields.ts);
  if (!Number.isFinite(ts)) return null;

  const window60 = (raw: string | undefined): number | undefined => {
    const value = Number(raw?.split("/")[1]);
    return Number.isFinite(value) ? value : undefined;
  };

  return {
    atMs: ts * 1000,
    ioFullAvg60: window60(fields.io_full),
    memFullAvg60: window60(fields.mem_full),
    availMb: Number(fields.avail_mb) || undefined,
    cgSwapMb: Number(fields.cg_swap_mb) || undefined,
    majorFaults: Number.isFinite(Number(fields.majflt)) ? Number(fields.majflt) : undefined,
  };
}

function isoDay(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const { path, thresholds, verbose } = parseArgs(Bun.argv.slice(2));
  const text = await readFile(path, "utf8");

  const rows = text.split("\n").map(parseRow).filter((r): r is ObserverRow => r !== null);
  if (rows.length === 0) throw new Error(`No parseable observer rows in ${path}`);
  rows.sort((a, b) => a.atMs - b.atMs);

  let state = initialPressureState();
  let previous: ObserverRow | null = null;
  const levelCounts: Record<PressureLevel, number> = { normal: 0, elevated: 0, critical: 0 };
  const actions: Array<{ atMs: number; action: PressureAction; ioFull?: number }> = [];
  const suppressed: Record<string, number> = {};
  const perDay: Record<string, { samples: number; elevated: number; critical: number; actions: number }> = {};

  // The observer has no pswpin/pswpout split, so the major-fault rate stands in for active
  // swap-in. It is the proxy the design already nominates, but it is a proxy: the live detector
  // reads /proc/vmstat directly, so replayed and live verdicts are not guaranteed identical.
  const processStartMs = rows[0].atMs;

  for (const row of rows) {
    let swapInPerS: number | undefined;
    if (previous && row.majorFaults !== undefined && previous.majorFaults !== undefined) {
      const elapsed = (row.atMs - previous.atMs) / 1000;
      const delta = row.majorFaults - previous.majorFaults;
      if (elapsed > 0 && delta >= 0) swapInPerS = delta / elapsed;
    }
    previous = row;

    const sample: PressureSample = {
      atMs: row.atMs,
      ioFullAvg60: row.ioFullAvg60,
      memFullAvg60: row.memFullAvg60,
      swapInPerS,
      hostAvailMb: row.availMb,
      containerSwapMb: row.cgSwapMb,
    };

    const { state: next, verdict } = evaluatePressure(state, sample, processStartMs, thresholds);
    state = next;

    const day = isoDay(row.atMs);
    perDay[day] ??= { samples: 0, elevated: 0, critical: 0, actions: 0 };
    perDay[day].samples++;
    levelCounts[verdict.rawLevel]++;
    if (verdict.rawLevel === "elevated") perDay[day].elevated++;
    if (verdict.rawLevel === "critical") perDay[day].critical++;
    if (verdict.suppressedBy) suppressed[verdict.suppressedBy] = (suppressed[verdict.suppressedBy] ?? 0) + 1;
    if (verdict.wouldAct !== "none") {
      actions.push({ atMs: row.atMs, action: verdict.wouldAct, ioFull: row.ioFullAvg60 });
      perDay[day].actions++;
    }
  }

  const span = (rows.at(-1)!.atMs - rows[0].atMs) / 3_600_000;
  console.log(`Samples: ${rows.length} over ${span.toFixed(1)} h (${isoDay(rows[0].atMs)} to ${isoDay(rows.at(-1)!.atMs)})`);
  console.log(
    `Thresholds: elevated>=${thresholds.elevatedIoFull} critical>=${thresholds.criticalIoFull} ` +
      `recovery<=${thresholds.recoveryIoFull} minSwapIn=${thresholds.minSwapInPerS} ` +
      `window=${thresholds.elevatedDwellMs / 60000}m/${thresholds.criticalDwellMs / 60000}m ` +
      `minDuty=${thresholds.minDutyCycle} ` +
      `grace=${thresholds.startupGraceMs / 60000}m rateLimit=${thresholds.minActionIntervalMs / 3_600_000}h`,
  );
  console.log(
    `Raw levels: normal=${levelCounts.normal} elevated=${levelCounts.elevated} critical=${levelCounts.critical}`,
  );
  console.log(`Suppressed: ${JSON.stringify(suppressed)}`);
  console.log(`Would have acted ${actions.length} time(s), i.e. ${(actions.length / (span / 24)).toFixed(2)}/day`);

  for (const entry of actions) {
    console.log(`  ${new Date(entry.atMs).toISOString()}  ${entry.action}  io_full60=${entry.ioFull}`);
  }

  if (verbose) {
    console.log("\nPer day:");
    for (const [day, d] of Object.entries(perDay).sort()) {
      console.log(
        `  ${day}  samples=${String(d.samples).padStart(5)}  elevated=${String(d.elevated).padStart(5)}` +
          `  critical=${String(d.critical).padStart(5)}  actions=${d.actions}`,
      );
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
