import { describe, expect, it } from "bun:test";
import {
  findProcessWideMutations,
  findUnrestoredMutations,
  reachesTestDatabase,
  usesModuleMocks,
} from "../../../scripts/checks/lib/testIsolation";

/**
 * Enforces the invariants that let `bun run test` batch files into shared
 * processes. The runner (scripts/checks/runTests.ts) groups most files into one
 * `bun test` process per lane and runs the lanes concurrently, which is only
 * safe while two rules hold:
 *
 *   - Nothing under `tests/unit/` touches the fixture database, because the
 *      unit lanes run CONCURRENTLY with the serial DB lane.
 *   - No file that shares a process mutates process-wide state without undoing
 *      it, because Bun does not reset such state between files.
 *
 * Both rules used to hold for free: the old runner gave every file its own
 * process, so nothing could leak and nothing could race. Batching traded that
 * blanket guarantee for speed, and this test is what replaces it: a contributor
 * (or agent) who has never read the lane docs gets a red gate with instructions
 * instead of corrupting an unrelated file's results.
 *
 * The detectors are shared with the runner via scripts/checks/lib/testIsolation.ts
 * so the gate and the harness can never disagree about what counts as isolated.
 */

/**
 * Meta-tests live here and quote the very markers the detectors search for, so
 * scanning them would flag this tooling rather than real tests. Excluded by path
 * for the same reason the locale scanner needs its examples written in split form.
 */
const SCAN_EXEMPT_DIRECTORY = "tests/unit/checks/";

/** Every discovered test file, normalized to forward slashes for stable matching. */
async function discoverTestFiles(): Promise<string[]> {
  const glob = new Bun.Glob("**/*.test.ts");
  const files: string[] = [];
  for await (const relative of glob.scan({ cwd: "tests" })) {
    files.push(`tests/${relative.replaceAll("\\", "/")}`);
  }
  return files.sort();
}

/** Reads every scannable test file as `[path, source]` pairs. */
async function readScannableFiles(): Promise<Array<[string, string]>> {
  const files = (await discoverTestFiles()).filter((file) => !file.startsWith(SCAN_EXEMPT_DIRECTORY));
  return Promise.all(files.map(async (file) => [file, await Bun.file(file).text()] as [string, string]));
}

describe("test isolation hygiene", () => {
  it("keeps database-touching tests out of the concurrently-running unit lanes", async () => {
    const offenders = (await readScannableFiles())
      .filter(([file]) => file.startsWith("tests/unit/"))
      .filter(([, source]) => reachesTestDatabase(source))
      .map(([file]) => file);

    // A DB test under tests/unit/ joins the unit lane, which runs at the same time
    // as the DB lane, so both would hit the same disposable database and its fixed-id
    // fixtures. Move it to tests/regression/db/, where files run serially.
    expect(offenders).toEqual([]);
  });

  it("requires process-wide mutations to be undone in an afterEach/afterAll hook", async () => {
    const offenders = (await readScannableFiles())
      .map(([file, source]) => [file, findUnrestoredMutations(source)] as const)
      .filter(([, unrestored]) => unrestored.length > 0)
      .map(([file, unrestored]) => `${file} -> ${unrestored.join(", ")}`);

    // These persist for the life of the process, so an unrestored mutation silently
    // changes behaviour for every other file batched alongside this one and the
    // failure surfaces in THAT file, not this one. Restore it in afterEach/afterAll.
    expect(offenders).toEqual([]);
  });
});

describe("testIsolation detectors", () => {
  // Markers are assembled from fragments so this file never contains a literal
  // occurrence: the scanners above read test sources, and a bare marker here
  // would make the suite flag its own fixtures.
  const MOCK_CALL = `mock${"."}module("@/x", () => ({}))`;
  const SCOPED_MOCK_CALL = `createScopedModuleMocker(mock, { "@/x": realX })`;
  const DB_IMPORT = `import { testSql } from "./setup${"/"}testDb"`;

  it("detects module mocks", () => {
    expect(usesModuleMocks(MOCK_CALL)).toBe(true);
    expect(usesModuleMocks(SCOPED_MOCK_CALL)).toBe(true);
    expect(usesModuleMocks("const spy = spyOn(obj, 'method');")).toBe(false);
  });

  it("ignores module-mock markers in comments", () => {
    expect(usesModuleMocks(`/** ${MOCK_CALL} */\nconst value = 1;`)).toBe(false);
    expect(usesModuleMocks(`// ${SCOPED_MOCK_CALL}\nconst value = 1;`)).toBe(false);
  });

  it("detects reachability of the fixture database", () => {
    expect(reachesTestDatabase(DB_IMPORT)).toBe(true);
    expect(reachesTestDatabase(`import { resolveTls } from "@/utils/db/client"`)).toBe(false);
  });

  it("finds assignments but ignores comparisons", () => {
    expect(findProcessWideMutations("globalThis.fetch = stub;")).toEqual(["globalThis.fetch"]);
    expect(findProcessWideMutations("if (globalThis.fetch === original) return;")).toEqual([]);
    expect(findProcessWideMutations('const ttl = process.env.TTL || "10";')).toEqual([]);
  });

  it("finds the fake clock", () => {
    expect(findProcessWideMutations("setSystemTime(new Date(0));")).toEqual(["setSystemTime"]);
  });

  it("treats a mutation restored in a hook as clean", () => {
    const source = `
      const originalFetch = globalThis.fetch;
      afterEach(() => {
        globalThis.fetch = originalFetch;
      });
      it("works", () => { globalThis.fetch = stub; });
    `;
    expect(findUnrestoredMutations(source)).toEqual([]);
  });

  it("flags a mutation with no restore hook at all", () => {
    const source = `it("leaks", () => { globalThis.fetch = stub; });`;
    expect(findUnrestoredMutations(source)).toEqual(["globalThis.fetch"]);
  });

  it("flags a mutation whose restore hook undoes something else", () => {
    const source = `
      afterEach(() => { clearCache(); });
      it("leaks", () => { globalThis.fetch = stub; });
    `;
    expect(findUnrestoredMutations(source)).toEqual(["globalThis.fetch"]);
  });

  it("exempts files that already run in their own process", () => {
    // Mock users get a private process, so nothing they mutate can reach another
    // file: this is why tests/unit/chat/toolLoop.test.ts may set process.env at
    // module scope without restoring it.
    const source = `${MOCK_CALL}\nprocess.env.BOT_MAX_ITERATIONS = "10";`;
    expect(findUnrestoredMutations(source)).toEqual([]);
  });
});
