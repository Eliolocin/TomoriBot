/**
 * Test runner wrapper for the TomoriBot regression harness.
 *
 * Behavior:
 *  1. Detect whether a valid local Postgres connection is available.
 *  2. If yes:  create a disposable `tomoribot_test_<id>` database, inject
 *              TEST_DB_READY=1 + POSTGRES_DB=<name> into the child env, run the
 *              suites, then drop the database on any exit path (clean finish,
 *              uncaught error, SIGINT, or SIGTERM).
 *  3. If no:   run the suites without DB env vars so the DB regression tests
 *              skip gracefully instead of erroring.
 *
 * Test files are grouped into LANES that run concurrently: see {@link planLanes}
 * for the grouping rules and why they are safe.
 *
 * Invoke via `bun run test` (package.json): not `bun test tests/` directly.
 */

import type { SQL } from "bun";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";
import { createScriptSqlClient } from "./lib/scriptSqlClient";
import { usesModuleMocks } from "./lib/testIsolation";

config({ quiet: true });

/**
 * Per-test and per-hook budget handed to every `bun test` child.
 *
 * Bun defaults to 5 s, which is sized for a quiet machine. Lanes here run concurrently, so a
 * CPU-bound suite can starve an unrelated lane and surface as a timeout in whichever test happened
 * to be running: a full-tree TypeScript parse and a database `beforeAll` both failed this way on CI
 * at just over 5 s while finishing in about 1 s locally. Applied as a CLI flag rather than a
 * per-test argument because only the flag also covers hooks; Bun silently ignores a third argument
 * to `describe`.
 */
const TEST_TIMEOUT_MS = process.env.TOMORI_TEST_TIMEOUT_MS ?? "30000";

/** Unique suffix for the disposable database created per run. */
const runId = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const tempDbName = `tomoribot_${runId}`;

/**
 * Resolved Postgres connection details extracted from whichever env-var
 * combination the contributor has set.
 */
interface ConnectionParams {
  host: string;
  port: string;
  user: string;
  password: string;
  /** The maintenance database used to issue CREATE/DROP DATABASE. */
  maintenanceDb: string;
}

/**
 * Parses connection parameters from `DATABASE_URL`/`POSTGRES_URL` or the
 * individual `POSTGRES_*` vars. Returns null when no credentials are found.
 */
function getConnectionParams(): ConnectionParams | null {
  const explicitUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  const maintenanceDb = process.env.POSTGRES_MAINTENANCE_DB ?? "postgres";

  if (explicitUrl) {
    try {
      const url = new URL(explicitUrl);
      if (!url.password) return null;
      return {
        host: url.hostname || "localhost",
        port: url.port || "5432",
        user: decodeURIComponent(url.username || "postgres"),
        password: decodeURIComponent(url.password),
        maintenanceDb,
      };
    } catch {
      return null;
    }
  }

  const password = process.env.POSTGRES_PASSWORD;
  if (!password) return null;

  return {
    host: process.env.POSTGRES_HOST ?? "localhost",
    port: process.env.POSTGRES_PORT ?? "5432",
    user: process.env.POSTGRES_USER ?? "postgres",
    password,
    maintenanceDb,
  };
}

/**
 * Builds a connection URL pointing at the given database name.
 */
function buildUrl(params: ConnectionParams, database: string): string {
  const url = new URL("postgresql://localhost");
  url.hostname = params.host;
  url.port = params.port;
  url.username = encodeURIComponent(params.user);
  url.password = encodeURIComponent(params.password);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Rejects non-local hosts to prevent accidentally creating/dropping a
 * database on a remote or production server. Opt-out via env var for
 * intentional use against a disposable remote instance.
 */
function isLocalHost(params: ConnectionParams): boolean {
  if (process.env.TOMORI_TESTS_ALLOW_NONLOCAL_DB === "true") return true;
  const allowed = new Set(["localhost", "127.0.0.1", "::1", "postgres", "tomoribot-db", "host.docker.internal"]);
  return allowed.has(params.host.toLowerCase());
}

async function discoverTestFiles(): Promise<string[]> {
  const glob = new Bun.Glob("**/*.test.ts");
  const files: string[] = [];
  for await (const rel of glob.scan({ cwd: "tests" })) {
    // Normalize Windows separators so the path is a valid `bun test` argument.
    files.push(`tests/${rel.replaceAll("\\", "/")}`);
  }
  // Sort for stable, reproducible run order across platforms.
  return files.sort();
}

/**
 * Concatenates per-file JUnit XML files into the single outfile the caller
 * expects, then removes the per-file temporaries. The `vl` JUnit parser scans
 * for `<testsuite>` tags across the whole string, so plain concatenation yields a
 * file it reads correctly without needing one well-formed root element.
 */
async function mergeJUnitFiles(sources: string[], dest: string): Promise<void> {
  const parts: string[] = [];
  for (const src of sources) {
    const text = await Bun.file(src)
      .text()
      .catch(() => "");
    if (text.trim()) parts.push(text);
    await rm(src, { force: true }).catch(() => undefined);
  }
  await Bun.write(dest, parts.join("\n"));
}

/** One `bun test` invocation covering one or more files. */
interface Batch {
  files: string[];
}

/** An ordered list of batches. Batches within a lane run sequentially; lanes run concurrently. */
interface Lane {
  id: string;
  batches: Batch[];
}

/**
 * Every `bun test` process currently running. Signal handlers iterate this so
 * Ctrl+C terminates all concurrent lanes before the disposable database is dropped.
 */
const liveProcesses = new Set<ReturnType<typeof Bun.spawn>>();

/** Kills every running `bun test` process and waits for them to exit. */
async function killLiveTestProcesses(): Promise<void> {
  const running = [...liveProcesses];
  for (const proc of running) proc.kill();
  await Promise.all(running.map((proc) => proc.exited.catch(() => undefined)));
  liveProcesses.clear();
}

/** True when the file calls `mock.module()`, which leaks process-wide in Bun. */
async function fileUsesModuleMocks(file: string): Promise<boolean> {
  const source = await Bun.file(file)
    .text()
    .catch(() => "");
  return usesModuleMocks(source);
}

/**
 * Groups test files into concurrently-runnable lanes.
 *
 * `mock.module()` is applied process-wide by Bun and never restored between
 * files, so a file that stubs a shared module (e.g. the `@/utils/db/repositories`
 * barrel) corrupts every file loaded LATER IN THE SAME PROCESS: surfacing as
 * ordering-dependent "X is not a function" / "Export named X not found" failures.
 * That hazard is confined to a single process, so the rule required is "no two
 * mock-using files share a process", NOT "no two files ever share a process".
 * Mock users are therefore detected by source inspection and given a batch each,
 * while everything else shares one. Detection is by content rather than a
 * hardcoded list so a newly-added mock user isolates itself automatically instead
 * of silently corrupting its neighbours.
 *
 * DB regression files all live in one lane and never run concurrently with each
 * other: they share a single disposable Postgres database with fixed-id fixtures,
 * so parallel runs would collide on the same rows. They are safe to overlap with
 * the unit lanes, which touch no database.
 *
 * Input order is preserved within every lane so batching never reorders DB
 * fixture interactions relative to a sequential run.
 */
async function planLanes(files: string[]): Promise<Lane[]> {
  const mockFlags = await Promise.all(files.map(fileUsesModuleMocks));

  const shared: Record<"unit" | "db", string[]> = { unit: [], db: [] };
  const isolated: Record<"unit" | "db", string[]> = { unit: [], db: [] };

  for (const [index, file] of files.entries()) {
    const group = file.includes("/regression/") ? "db" : "unit";
    (mockFlags[index] ? isolated : shared)[group].push(file);
  }

  const lanes: Lane[] = [];

  // Lane order doubles as the deterministic order buffered output is replayed in.
  if (shared.unit.length > 0) lanes.push({ id: "unit", batches: [{ files: shared.unit }] });
  if (isolated.unit.length > 0) {
    lanes.push({ id: "unit-isolated", batches: isolated.unit.map((file) => ({ files: [file] })) });
  }

  // Shared batch first, then any mock-using regression file on its own: all
  // sequential within the single DB lane.
  const dbBatches: Batch[] = [
    ...(shared.db.length > 0 ? [{ files: shared.db }] : []),
    ...isolated.db.map((file) => ({ files: [file] })),
  ];
  if (dbBatches.length > 0) lanes.push({ id: "db", batches: dbBatches });

  return lanes;
}

/** Result of running one lane to completion. */
interface LaneResult {
  lane: Lane;
  exitCode: number;
  output: string;
  junitOutfiles: string[];
}

/**
 * Runs a lane's batches sequentially. Output is buffered rather than inherited
 * because lanes run concurrently and interleaved test output is unreadable; the
 * caller replays each lane's buffer in lane order once everything settles.
 */
async function runLane(lane: Lane, extraEnv: Record<string, string>, requestedOutfile?: string): Promise<LaneResult> {
  const junitOutfiles: string[] = [];
  const chunks: string[] = [];
  let exitCode = 0;

  for (const [index, batch] of lane.batches.entries()) {
    const reporterArgs: string[] = [];
    if (requestedOutfile) {
      const batchOutfile = join(tmpdir(), `tomori-junit-${runId}-${lane.id}-${index}.xml`);
      reporterArgs.push("--reporter=junit", `--reporter-outfile=${batchOutfile}`);
      junitOutfiles.push(batchOutfile);
    }

    // Spawn the batch and track it so signal-driven cleanup can terminate it.
    const proc = Bun.spawn(["bun", "test", "--timeout", TEST_TIMEOUT_MS, ...batch.files, ...reporterArgs], {
      env: { ...process.env, ...extraEnv },
      stdout: "pipe",
      stderr: "pipe",
    });
    liveProcesses.add(proc);

    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = (await proc.exited) ?? 1;
    liveProcesses.delete(proc);

    chunks.push(stdout + stderr);

    // Remember the first failure but keep going so every batch reports.
    if (code !== 0 && exitCode === 0) exitCode = code;
  }

  return { lane, exitCode, output: chunks.join(""), junitOutfiles };
}

/**
 * Runs every file across concurrent lanes. When `BUN_TEST_JUNIT_OUTFILE` is set
 * (the `vl` checklist sets it), each batch writes its own JUnit file which are
 * then merged into that requested path.
 *
 */
async function runTestFiles(files: string[], extraEnv: Record<string, string> = {}): Promise<number> {
  const requestedOutfile = process.env.BUN_TEST_JUNIT_OUTFILE;
  const lanes = await planLanes(files);

  const results = await Promise.all(lanes.map((lane) => runLane(lane, extraEnv, requestedOutfile)));

  // Replay buffered output in fixed lane order so concurrent runs stay readable.
  for (const result of results) {
    const fileCount = result.lane.batches.reduce((total, batch) => total + batch.files.length, 0);
    process.stdout.write(`\n──── lane: ${result.lane.id} (${fileCount} files) ────\n`);
    process.stdout.write(result.output);
  }

  const allOutfiles = results.flatMap((result) => result.junitOutfiles);
  if (requestedOutfile && allOutfiles.length > 0) {
    await mergeJUnitFiles(allOutfiles, requestedOutfile);
  }

  return results.find((result) => result.exitCode !== 0)?.exitCode ?? 0;
}

async function main(): Promise<void> {
  if (process.env.RUN_ENV === "production") {
    throw new Error("[test-runner] Refusing to run with RUN_ENV=production.");
  }

  const testFiles = await discoverTestFiles();
  if (testFiles.length === 0) {
    console.error("[test-runner] No test files found under tests/.");
    process.exit(1);
  }

  const params = getConnectionParams();

  if (!params) {
    console.log("[test-runner] No Postgres credentials found. DB regression tests will be skipped.");
    process.exit(await runTestFiles(testFiles));
  }

  // Non-local host detected, so fall back to skip mode to avoid touching remote DBs.
  if (!isLocalHost(params)) {
    console.warn(
      `[test-runner] Postgres host "${params.host}" is not local. Skipping DB provisioning.\n` +
        "Set TOMORI_TESTS_ALLOW_NONLOCAL_DB=true to override.",
    );
    process.exit(await runTestFiles(testFiles));
  }

  const adminUrl = buildUrl(params, params.maintenanceDb);
  const testDbUrl = buildUrl(params, tempDbName);

  let adminSql: SQL | null = null;

  /** Kills every running test process and drops the disposable database. */
  async function cleanup(): Promise<void> {
    // Lanes run concurrently, so several processes may be alive at once.
    await killLiveTestProcesses();
    if (adminSql) {
      // Terminate any remaining connections so DROP DATABASE can proceed.
      await adminSql`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = ${tempDbName}
          AND pid <> pg_backend_pid()
      `.catch(() => undefined);
      await adminSql`DROP DATABASE IF EXISTS ${adminSql(tempDbName)} WITH (FORCE)`.catch(() => undefined);
      await adminSql.close({ timeout: 1 }).catch(() => undefined);
      adminSql = null;
    }
  }

  // Register signal handlers so Ctrl+C and process termination still drop the DB.
  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(143);
  });

  try {
    adminSql = createScriptSqlClient(adminUrl);
    await adminSql`SELECT 1`;
  } catch {
    console.log("[test-runner] Could not reach Postgres. DB regression tests will be skipped.");
    await adminSql?.close({ timeout: 1 }).catch(() => undefined);
    adminSql = null;
    process.exit(await runTestFiles(testFiles));
  }

  let exitCode = 1;

  try {
    console.log(`[test-runner] Provisioning test database: ${tempDbName}`);
    await adminSql`DROP DATABASE IF EXISTS ${adminSql(tempDbName)} WITH (FORCE)`;
    await adminSql`CREATE DATABASE ${adminSql(tempDbName)}`;

    // Inject the test DB coordinates into the child environment.
    //    TEST_DB_READY=1 tells testDb.ts to enable the DB regression suites.
    const testEnv: Record<string, string> = {
      POSTGRES_HOST: params.host,
      POSTGRES_PORT: params.port,
      POSTGRES_USER: params.user,
      POSTGRES_PASSWORD: params.password,
      POSTGRES_DB: tempDbName,
      DATABASE_URL: testDbUrl,
      TEST_DB_READY: "1",
    };

    // Run the lanes; every spawned process registers itself in liveProcesses so
    // signal-driven cleanup can terminate them all and still drop the DB.
    exitCode = await runTestFiles(testFiles, testEnv);
  } finally {
    console.log(`[test-runner] Dropping test database: ${tempDbName}`);
    await cleanup();
  }

  process.exit(exitCode);
}

main().catch(async (err) => {
  console.error("[test-runner] Fatal:", err);
  process.exit(1);
});
