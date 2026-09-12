import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { config } from "dotenv";
import { AUDIT_IGNORED_ADVISORIES } from "./lib/auditIgnores";
import { isVerboseOutput } from "./lib/gateOutput";

/** Shape of every item pushed into the results array */
type ResultItem = {
  name: string;
  exitCode: number | null;
  fatal: boolean;
  skippedReason?: string;
  isWarning?: boolean;
  subItems?: string[];
  summary?: string;
  /** Inline hint shown on failure: takes precedence over the global HINTS lookup */
  hint?: string;
  /** Used by CATEGORIES to identify test-file buckets without string matching */
  _category?: "unit-test" | "regression-test";
};

/**
 * Detail level for this run, resolved once in main().
 *
 * Quiet and full differ in exactly one place: whether a check that PASSED prints its
 * output. A failing check prints its full detail under both, because that detail is
 * the reason anyone runs the gate at all. Quiet mode must never be able to hide a
 * finding, only the passing noise around it.
 */
let verboseOutput = false;

/** First-party checks in scripts/checks/ that understand `--verbose` / `--no-verbose`. */
type Command = { argv: string[]; acceptsDetailFlag: boolean };

/**
 * The flag to forward to a first-party check so it picks its own detail level.
 *
 * Always explicit rather than only sent when true, because `--no-verbose` is what lets
 * this process override a `--verbose` it forwards for a sibling. Only our own scripts in
 * scripts/checks/ may receive it: `bun run lint`, `knip`, `bunx tsc` and `bun audit`
 * are third-party CLIs whose argument parsers would reject an unknown flag.
 */
function detailFlag(): string {
  return verboseOutput ? "--verbose" : "--no-verbose";
}

/**
 * Builds the argv to spawn, forwarding the detail flag only to checks that read it.
 *
 * The `--` separator is what delivers the flag to the script itself rather than to
 * bun's own argument parser, which normalizes the two forms inconsistently across
 * platforms.
 */
function resolveArgv({ argv, acceptsDetailFlag }: Command): string[] {
  return acceptsDetailFlag ? [...argv, "--", detailFlag()] : argv;
}

async function runCheck(
  name: string,
  argv: string[],
  fatal: boolean = true,
  acceptsDetailFlag: boolean = false,
): Promise<ResultItem> {
  console.log(`> Running ${name}...`);
  const proc = spawn(resolveArgv({ argv, acceptsDetailFlag }), { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  if (exitCode !== 0 || verboseOutput) {
    console.log(stdout + stderr);
  }
  return { name, exitCode, fatal };
}

/** How one advisory-graded check reports itself, and what its non-zero exit means. */
interface WarningCheckOptions {
  /** True when the child's output contains advisory findings that cannot change the exit code. */
  outputHasWarnings?: (output: string) => boolean;
  /** Counts advisory findings, so a passing run can collapse them to a number. */
  summarizeWarnings?: (output: string) => string;
  /** One extra line shown under a non-zero row, for a check that fails as a whole. */
  summarizeFailure?: (output: string) => string | undefined;
  /** Forwards the detail flag, for a child under scripts/checks/ that reads it. */
  acceptsDetailFlag?: boolean;
  /**
   * Whether a non-zero exit is a real failure rather than a finding.
   *
   * This is the one thing `runWarningCheck` cannot infer, and getting it wrong is how a
   * gate goes silent: `knip` reports "found unused things" with exit 1 and `vl` grades it
   * a warning, so a count is the whole report. `audit-comments` reports unactionable
   * counts the same way but exits 1 only for errors that are entirely file and line
   * specific, so its listing is the report. Defaults to true, because silence is the
   * failure mode that hides bugs.
   */
  failureNeedsDetail?: boolean;
}

async function runWarningCheck(
  name: string,
  argv: string[],
  {
    outputHasWarnings = () => false,
    summarizeWarnings,
    summarizeFailure,
    acceptsDetailFlag = false,
    failureNeedsDetail = true,
  }: WarningCheckOptions = {},
): Promise<ResultItem> {
  console.log(`> Running ${name}...`);
  const proc = spawn(resolveArgv({ argv, acceptsDetailFlag }), { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  const output = stdout + stderr;
  const isWarning = exitCode !== 0 || outputHasWarnings(output);
  const summary = isWarning ? summarizeWarnings?.(output) || undefined : undefined;
  const subItems = exitCode !== 0 ? summarizeFailure?.(output) : undefined;

  // A failure prints its detail. The exception is a check whose non-zero exit is a
  // finding the caller has already counted, which is a state the caller has to declare
  // rather than one inferred from the output having matched a summary.
  const detailIsReported = (failureNeedsDetail && exitCode !== 0) || (isWarning && !summary && !subItems);
  if (detailIsReported || verboseOutput) {
    console.log(output);
  }

  return {
    name,
    exitCode,
    fatal: false,
    isWarning,
    summary,
    subItems: subItems ? [subItems] : undefined,
  };
}

async function runLocalesCheck(
  name: string,
  command: string[],
): Promise<ResultItem> {
  console.log(`> Running ${name}...`);
  const proc = spawn(resolveArgv({ argv: command, acceptsDetailFlag: true }), { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  const output = stdout + stderr;

  // Exit code 2 means only locale parity issues were found. Those are advisory, so the
  // child collapses its five-figure per-key listing to a count. The `summary` below is
  // what surfaces that count: echoing the child's text here too would say it twice.
  // Exit code 1 is a real failure and prints its full detail.
  if (exitCode !== 2 || verboseOutput) {
    console.log(output);
  }

  const advisoryCount = output.match(/(\d+) keys missing in some locale/)?.[1];
  return {
    name,
    exitCode,
    fatal: exitCode === 1 || (exitCode !== 0 && exitCode !== 2),
    summary:
      advisoryCount && !verboseOutput
        ? `(${advisoryCount} keys missing in some locale, re-run with --verbose to list)`
        : undefined,
  };
}

const WORD_DISPLAY_OVERRIDES: Record<string, string> = {
  ai: "AI",
  api: "API",
  byok: "BYOK",
  db: "DB",
  dtm: "DTM",
  id: "ID",
  ids: "IDs",
  json: "JSON",
  junit: "JUnit",
  llm: "LLM",
  mcp: "MCP",
  nai: "NAI",
  nsfw: "NSFW",
  rag: "RAG",
  sql: "SQL",
  stt: "STT",
  ttl: "TTL",
  tts: "TTS",
  ui: "UI",
  url: "URL",
  xml: "XML",
  google: "Google",
  novelai: "NovelAI",
  openrouter: "OpenRouter",
  searxng: "SearXNG",
};

function decodeXmlAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function normalizeTestPath(file: string): string {
  return file.replace(/\\/g, "/");
}

function classifyTestFile(file: string): "unit-test" | "regression-test" {
  const normalized = normalizeTestPath(file);
  return normalized.includes("/regression/") || normalized.startsWith("tests/regression/")
    ? "regression-test"
    : "unit-test";
}

function testCategoryRank(category: ResultItem["_category"]): number {
  return category === "regression-test" ? 1 : 0;
}

function testHintForFile(file: string): string {
  return `Run \`bun test ${normalizeTestPath(file)}\``;
}

function fileNameFromPath(file: string): string {
  return normalizeTestPath(file).split("/").pop() ?? file;
}

function stripTestSuffix(fileName: string): string {
  return fileName.replace(/\.test\.ts$/, "").replace(/\.regression$/, "");
}

function humanizeDisplayName(value: string): string {
  const spaced = value
    .replace(/[—–]/g, "-")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return spaced
    .split(" ")
    .map((word) => {
      const lower = word.toLowerCase();
      if (WORD_DISPLAY_OVERRIDES[lower]) return WORD_DISPLAY_OVERRIDES[lower];
      if (word === "&") return word;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function displayNameFromSuiteName(suiteName: string): string {
  return humanizeDisplayName(
    suiteName
      .replace(/\s*[—–-]\s*regression\s*$/i, "")
      .replace(/\s+regression\s*$/i, ""),
  );
}

function displayNameFromTestFile(file: string, topLevelDescribeNames: string[] = []): string {
  const uniqueDescribeNames = [...new Set(topLevelDescribeNames.filter(Boolean))];
  if (uniqueDescribeNames.length === 1) {
    return displayNameFromSuiteName(uniqueDescribeNames[0]);
  }

  return humanizeDisplayName(stripTestSuffix(fileNameFromPath(file)));
}

/** One decoded file-level `<testsuite>` element from bun's JUnit reporter output. */
type JUnitSuite = {
  name: string;
  file: string;
  tests: number;
  failures: number;
  skipped: number;
  topLevelDescribeNames: string[];
};

function buildTestResultItem(suite: JUnitSuite): ResultItem {
  const passCount = Math.max(0, suite.tests - suite.failures - suite.skipped);
  return {
    name: displayNameFromTestFile(suite.file, suite.topLevelDescribeNames),
    exitCode: suite.failures > 0 ? 1 : 0,
    fatal: suite.failures > 0,
    summary: `(${passCount} pass, ${suite.skipped} skip, ${suite.failures} fail)`,
    hint: testHintForFile(suite.file),
    _category: classifyTestFile(suite.file),
  };
}

function sortTestItems(items: ResultItem[]): ResultItem[] {
  return items.sort((a, b) => {
    const categoryOrder = testCategoryRank(a._category) - testCategoryRank(b._category);
    if (categoryOrder !== 0) return categoryOrder;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Parses bun's JUnit XML into one ResultItem per test FILE.
 *
 * Bun emits a file-level `<testsuite>` (where `name` equals the `file` path)
 * plus nested suites for `describe` blocks. We keep the file-level suites for
 * counts and collect direct child describe names as optional display-name hints.
 * Returns `null` when the XML has no usable suites so the caller can fall back.
 */
export function parseJUnitSuites(xml: string): ResultItem[] | null {
  const fileSuites = new Map<string, Omit<JUnitSuite, "topLevelDescribeNames">>();
  const topLevelDescribeNames = new Map<string, string[]>();
  const stack: Array<{ name: string; file: string; isFileSuite: boolean }> = [];
  const attr = (tag: string, key: string): string => decodeXmlAttr(tag.match(new RegExp(`${key}="([^"]*)"`))?.[1] ?? "");
  const countAttr = (tag: string, key: string): number => Number.parseInt(attr(tag, key) || "0", 10);

  for (const tag of xml.match(/<\/?testsuite\b[^>]*>/g) ?? []) {
    if (tag.startsWith("</")) {
      stack.pop();
      continue;
    }

    const name = attr(tag, "name");
    const file = normalizeTestPath(attr(tag, "file"));
    const parent = stack.at(-1);

    // Bun emits `name` and `file` using the host platform's separator, so a file-level
    // suite is only recognisable once BOTH sides are normalized (on Windows the raw
    // values are backslash-delimited). `name` itself is stored verbatim because it
    // doubles as a describe-block label, which is arbitrary user text.
    const isFileSuite = Boolean(file) && normalizeTestPath(name) === file;

    if (isFileSuite) {
      fileSuites.set(file, {
        name,
        file,
        tests: countAttr(tag, "tests"),
        failures: countAttr(tag, "failures"),
        skipped: countAttr(tag, "skipped"),
      });
    } else if (file && name && parent?.file === file && parent.isFileSuite) {
      const names = topLevelDescribeNames.get(file) ?? [];
      names.push(name);
      topLevelDescribeNames.set(file, names);
    }

    if (!tag.endsWith("/>")) {
      stack.push({ name, file, isFileSuite });
    }
  }

  if (fileSuites.size === 0) return null;

  return sortTestItems(
    [...fileSuites.values()].map((suite) =>
      buildTestResultItem({
        ...suite,
        topLevelDescribeNames: topLevelDescribeNames.get(suite.file) ?? [],
      }),
    ),
  );
}

/**
 * Legacy fallback: parse `bun test`'s piped console output into per-file items.
 * Used only when the JUnit XML is unavailable (older bun, reporter failure).
 * Note: bun omits per-file headers for files that log nothing, so this path can
 * under-report, so the JUnit path above is preferred.
 */
function parseConsoleOutput(output: string, exitCode: number): ResultItem[] {
  const testBlocks = output.split(/([a-zA-Z0-9_\\/\-.]+\.test\.ts):/);
  const items: ResultItem[] = [];
  const seen = new Set<string>();

  for (let i = 1; i < testBlocks.length; i += 2) {
    const file = normalizeTestPath(testBlocks[i]);
    if (seen.has(file)) continue;
    seen.add(file);

    const blockContent = testBlocks[i + 1] ?? "";
    const passCount = (blockContent.match(/\(pass\)/g) ?? []).length;
    const skipCount = (blockContent.match(/\(skip\)/g) ?? []).length;
    const failCount = (blockContent.match(/\(fail\)/g) ?? []).length;

    items.push(
      buildTestResultItem({
        name: file,
        file,
        tests: passCount + skipCount + failCount,
        failures: failCount,
        skipped: skipCount,
        topLevelDescribeNames: [],
      }),
    );
  }

  if (items.length === 0) {
    items.push({
      name: "Tests (bun run test)",
      exitCode: exitCode !== 0 ? 1 : 0,
      fatal: exitCode !== 0,
      summary: exitCode !== 0 ? "(no test output — possible compilation error)" : "(0 pass, 0 skip, 0 fail)",
      hint: "Run `bun run test` directly to see the full runner output.",
      _category: "unit-test",
    });
  }

  return sortTestItems(items);
}

/**
 * Runs all tests and returns one ResultItem per test file. Prefers bun's JUnit
 * reporter (reliable per-file enumeration) and falls back to console parsing.
 *
 * On failure the runner's own output is reprinted rather than a per-file subset of it.
 * The runner prints each lane as one buffered block, so extracting only the failing
 * files would mean re-running them, and a targeted re-run in this environment surfaces
 * the application logger's DB and cache chatter instead of a clean assertion diff. The
 * red per-file rows below already name each failing file and the command to reproduce
 * it, so the full output is kept as the backstop it has always been.
 */
async function runTests(): Promise<ResultItem[]> {
  console.log(`> Running Tests (bun run test)...`);

  // runTests.ts forwards these reporter flags to `bun test` when this env var is set.
  const junitOutfile = join(tmpdir(), `tomori-vl-junit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.xml`);
  const proc = spawn(["bun", "run", "test"], {
    stdout: "pipe",
    stderr: "pipe",
    // TOMORI_TEST_QUIET suppresses the runner's lane replay, which the per-file rows
    // below replace. Under --verbose the replay is wanted, so the flag is not set.
    env: { ...process.env, BUN_TEST_JUNIT_OUTFILE: junitOutfile, ...(verboseOutput ? {} : { TOMORI_TEST_QUIET: "true" }) },
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;

  const output = stdout + stderr;

  // Prefer the JUnit XML because it lists every file regardless of console logging.
  let items: ResultItem[] | null = null;
  try {
    const xml = await Bun.file(junitOutfile).text();
    items = parseJUnitSuites(xml);
  } catch {
  } finally {
    await rm(junitOutfile, { force: true }).catch(() => undefined);
  }

  const resolved = items ?? parseConsoleOutput(output, exitCode);

  // The runner can exit non-zero without any individual file reporting a failure
  //    (segfault, OOM, harness error, a batch dying before it emits results). Those
  //    runs must never read as green just because the parsed items all look clean.
  const unaccountedFailure = exitCode !== 0 && resolved.every((item) => item.exitCode === 0);
  if (unaccountedFailure) {
    resolved.push({
      name: "Test Runner (bun run test)",
      exitCode: 1,
      fatal: true,
      summary: `(runner exited ${exitCode} with no failing file reported)`,
      hint: "Run `bun run test` directly — a file likely crashed before reporting results.",
      _category: "unit-test",
    });
  }

  // A failing suite prints the runner's output, which is what today's run shows and the
  // only evidence available when a batch died before any file could report. The quiet
  // gain is in the green case, where this and the ~360 per-file rows both stay silent.
  if (verboseOutput || unaccountedFailure || exitCode !== 0) {
    console.log(output);
  }

  return resolved;
}

async function runLint(): Promise<ResultItem> {
  console.log(`> Running Linting (bun run lint)...`);
  const proc = spawn(["bun", "run", "lint"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;

  const output = stdout + stderr;
  if (exitCode !== 0 || verboseOutput) {
    console.log(output);
  }

  const warningsMatch = output.match(/Found (\d+) warning/i);
  const fixedMatch = output.match(/Fixed (\d+) file/i);

  let isWarning = false;
  let summary = "";

  if (exitCode === 0 && (warningsMatch || fixedMatch)) {
    isWarning = Boolean(warningsMatch); // auto-fixes alone stay green; only actual warnings turn yellow
    const parts = [];
    if (fixedMatch) parts.push(`fixed ${fixedMatch[1]}`);
    if (warningsMatch) parts.push(`${warningsMatch[1]} warning`);
    summary = `(${parts.join(", ")})`;
  }

  return {
    name: "Linting (bun run lint)",
    exitCode,
    fatal: exitCode !== 0,
    isWarning,
    summary,
  };
}

/**
 * Keeps only the `bun audit` package blocks holding a high or critical advisory.
 *
 * `bun audit` groups its output into blocks: an unindented package line, then an
 * indented dependency path per line, then an indented severity line per advisory. A
 * block is kept whole rather than filtered line by line, because a severity line only
 * means something next to the dependency path that reaches it. The trailing counts
 * line and anything after it are unindented and pass through untouched.
 */
function selectBlockingAuditBlocks(output: string): string {
  const blocks: string[][] = [];
  let current: string[] = [];

  for (const line of output.split("\n")) {
    if (line.length > 0 && !/^\s/.test(line) && current.length > 0) {
      blocks.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current);

  return blocks
    .filter((block, index) => {
      // The final block is the vulnerability tally and the fix hints, never a package.
      if (index === blocks.length - 1) return true;
      return block.some((line) => /\b(?:high|critical):/i.test(line));
    })
    .map((block) => block.join("\n"))
    .join("\n");
}

async function runAudit(): Promise<ResultItem> {
  console.log(`> Running Dependency Audit (bun audit)...`);

  // bun audit has no working workspace filter: it always audits the whole
  // lockfile, including apps/docs devDeps. Advisories reaching the gate via
  // workspace:tomoribot-docs are build-time-only, but still block audit:clean.
  // We use cmd.exe on Windows for bun audit to prevent pipe hangs, just in case.
  const ignoreFlags = AUDIT_IGNORED_ADVISORIES.map((id) => `--ignore=${id}`);
  let command = ["bun", "audit", ...ignoreFlags];
  if (process.platform === "win32") {
    command = ["cmd.exe", "/d", "/s", "/c", ["bun", "audit", ...ignoreFlags].join(" ")];
  }

  // This is the only check that depends on a remote server, so it is the only one
  // that can stall indefinitely. Without a bound, an unreachable or slow registry
  // turns the whole ~15s gate into an open-ended wait.
  const timeoutMs = Number.parseInt(process.env.TOMORI_VL_AUDIT_TIMEOUT_MS || "60000", 10);

  const proc = spawn(command, { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // On Windows this kills the cmd.exe wrapper; a lingering child exits on its
    // own. Either way vl stops waiting, which is the point.
    proc.kill();
  }, timeoutMs);

  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  const output = stdout + stderr;
  // A timed-out audit proves nothing either way, so report it as a warning rather
  // than a pass or a failure, so the advisory state is simply unknown this run.
  if (timedOut) {
    // Killed mid-flight, so whatever it managed to print is the only evidence of how
    // far it got, and it is small because the timeout bounds it.
    console.log(output);
    return {
      name: "Dependency Audit (bun audit)",
      exitCode: 1,
      fatal: false,
      isWarning: true,
      summary: `(timed out after ${timeoutMs}ms — registry unreachable?)`,
      hint: "The advisory registry did not respond. Re-run when back online, or raise TOMORI_VL_AUDIT_TIMEOUT_MS.",
    };
  }

  let hasHighOrCritical = false;
  if (/(\d+)\s+critical/i.test(output) && !output.match(/0\s+critical/i)) hasHighOrCritical = true;
  if (/(\d+)\s+high/i.test(output) && !output.match(/0\s+high/i)) hasHighOrCritical = true;

  // The tally line is the only proof that the audit ran to completion. Without it a
  // non-zero exit could be a transport error or a changed output format, in which case
  // claiming "no high or critical advisories" would assert something never established.
  const parsedTally = /\d+\s+vulnerabilit/i.test(output);

  // bun audit prints every advisory in the lockfile, transitive ones included, which
  // runs to five figures of lines on this repo while the verdict is one word. Print
  // only the blocks that carry an advisory at or above the blocking threshold, so the
  // listing stays proportional to what actually moved the verdict. Low and moderate
  // advisories still grade yellow below, so suppressing their text cannot hide them.
  // An unparsed run prints in full, because its output is the only clue to what failed.
  if (verboseOutput || !parsedTally) {
    console.log(output);
  } else if (hasHighOrCritical) {
    console.log(selectBlockingAuditBlocks(output));
  }

  return {
    name: "Dependency Audit (bun audit)",
    exitCode: hasHighOrCritical ? 1 : exitCode !== 0 ? 1 : 0,
    // Audit issues are never contributor-caused; warn locally, block only in the deploy pipeline
    fatal: false,
    isWarning: hasHighOrCritical || exitCode !== 0,
    // Only a completed run may claim absence, and only a completed clean one has nothing
    // else to say. Any other state already printed its output above.
    summary: parsedTally && exitCode === 0 ? "(no high or critical advisories)" : undefined,
  };
}

/**
 * Whether a local database is reachable, so the DB-dependent checks can run.
 * Read lazily inside main() rather than at module scope: `parseJUnitSuites` is
 * imported by its unit test, and loading `.env` as an import side effect would
 * leak real credentials into every other test sharing that process.
 */
function isDbConfigured(): boolean {
  return !!(process.env.POSTGRES_PASSWORD || process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

/**
 * True for the fixed set of named checks, false for per-test-file items.
 *
 * Sections are rendered by independent filters, so an item matching two
 * predicates would print (and be counted) twice. Test files are named after their
 * top-level `describe`, which is arbitrary prose that can easily contain a word a
 * named-check predicate looks for: "Database Only Lifecycle Secrets" matches
 * `includes("Lifecycle")`, for example. Test items are therefore routed solely by
 * `_category`, and every named-check predicate is gated on this guard.
 */
const isNamedCheck = (r: ResultItem): boolean => r._category === undefined;

const CATEGORIES = {
  // Architectural guards (persona-workflow boundary, text-preview conventions)
  // are deliberately absent: their scanners are asserted against the real source
  // tree by tests/unit/checks/, which the test lanes below already run. A named
  // check here would scan the repo a second time for the same answer. For a
  // targeted local report, run those test files directly.
  CODE: (r: ResultItem) =>
    isNamedCheck(r) &&
    (r.name.includes("Type Check") ||
      r.name.includes("Linting") ||
      r.name.includes("Runtime Imports") ||
      r.name.includes("SQL Audit") ||
      r.name.includes("Knip")),
  // Assets and seed data rather than source code: these fail on *content*
  // (an oversized PNG, a malformed catalog entry), not on how code is written.
  CONTENT: (r: ResultItem) =>
    isNamedCheck(r) && (r.name.includes("Media Size") || r.name.includes("Seed Catalog")),
  SECURITY: (r: ResultItem) => isNamedCheck(r) && r.name.includes("Dependency Audit"),
  UNIT_TESTS: (r: ResultItem) => r._category === "unit-test",
  REGRESSION_TESTS: (r: ResultItem) => r._category === "regression-test",
  DB: (r: ResultItem) =>
    isNamedCheck(r) &&
    (r.name.includes("Schema Drift") || r.name.includes("Lifecycle") || r.name.includes("Migration Files")),
  LOCALES: (r: ResultItem) =>
    isNamedCheck(r) && (r.name.includes("Localization") || r.name.includes("Config Breadcrumbs")),
  DOCUMENTATION: (r: ResultItem) =>
    isNamedCheck(r) &&
    (r.name.includes("Command Reference") ||
      r.name.includes("Command Mentions") ||
      r.name.includes("Command Roots") ||
      r.name.includes("Comment Audit")),
};

async function main() {
  // Load .env here rather than at module scope so importing this file is side-effect free.
  config({ quiet: true });
  verboseOutput = isVerboseOutput();
  const dbConfigured = isDbConfigured();

  console.log(
    verboseOutput
      ? "Running Validation Checks (verbose: every check prints its full output)...\n"
      : "Running Validation Checks... (quiet is the default; pass --verbose for full detail, --no-verbose to force quiet)\n",
  );

  // Run the checks that do not load the complete command graph concurrently.
  const [
    typeCheckResult,
    lintResult,
    runtimeImportsResult,
    knipResult,
    commentAuditResult,
    auditResult,
    sqlAuditResult,
    mediaSizeResult,
    modelCatalogResult,
    migrationFilesResult,
    testResultItems,
    schemaDriftResult,
    dbLifecycleResult,
    localesResult,
    localeLengthsResult,
    configBreadcrumbsResult,
  ] = await Promise.all([
    runCheck("Type Check (bun run check)", ["bun", "run", "check"], true),
    runLint(),
    runCheck("Runtime Imports (bun run check-runtime-imports)", ["bun", "run", "check-runtime-imports"], true, true),
    runWarningCheck("Knip (bun run knip)", ["bun", "run", "knip"], {
      // knip signals "unused things found" with exit 1 while `vl` grades it a warning, so
      // its three-figure listing is a finding rather than a failure. Count what it found
      // so the yellow row stays explained without the listing.
      outputHasWarnings: (output) => /\(\d+\)$/.test(output),
      summarizeWarnings: (output) => {
        const counts = [...output.matchAll(/^(\S[^\n]*?) \((\d+)\)$/gm)].map(([, label, count]) => {
          return `${count} ${label.toLowerCase()}`;
        });
        return counts.length > 0 ? `(${counts.join(", ")})` : "";
      },
      failureNeedsDetail: false,
    }),

    runWarningCheck("Comment Audit (bun run audit-comments)", ["bun", "run", "audit-comments"], {
      outputHasWarnings: (output) => /^WARN /m.test(output),
      // Only meaningful on a clean run. A failing audit prints its own listing plus the
      // severity line below, and "0 warnings" next to a failure caused by an error
      // reports the wrong thing.
      summarizeWarnings: (output) => {
        const warningCount = output.match(/^WARN /gm)?.length ?? 0;
        return warningCount > 0 ? `(${warningCount} warning${warningCount === 1 ? "" : "s"})` : "";
      },
      // Read from the check's own verdict line rather than re-counting severities here,
      // so the two counts cannot drift apart.
      summarizeFailure: (output) => output.match(/\d+ error\(s\), \d+ warning\(s\), \d+ file\(s\) checked/)?.[0],
      // A failing audit is entirely file-and-line findings, so the listing is the report.
      failureNeedsDetail: true,
      acceptsDetailFlag: true,
    }),
    runAudit(),

    runCheck("SQL Audit (bun run audit-sql)", ["bun", "run", "audit-sql"], true, true),
    runCheck("Media Size (bun run check-media-size)", ["bun", "run", "check-media-size"], true, true),
    runCheck("Seed Catalog (bun run check-seed-catalogs)", ["bun", "run", "check-seed-catalogs"], true, true),
    // Filesystem-only (no DB): verifies rollback pairing + numbering uniqueness,
    // so it runs unconditionally regardless of local DB configuration.
    runCheck("Migration Files (bun run check-migrations)", ["bun", "run", "check-migrations"], true, true),
    runTests(),
    dbConfigured
      ? runCheck("Schema Drift Check (bun run check-schema)", ["bun", "run", "check-schema"], true, true)
      : Promise.resolve<ResultItem>({ name: "Schema Drift Check", exitCode: null, fatal: true, skippedReason: "No local DB configured" }),
    dbConfigured
      ? runCheck("DB Lifecycle Validation (bun run db:lifecycle)", ["bun", "run", "db:lifecycle"], true, true)
      : Promise.resolve<ResultItem>({ name: "DB Lifecycle Validation", exitCode: null, fatal: true, skippedReason: "No local DB configured" }),
    runLocalesCheck("Localization Keys (bun run check-locales)", ["bun", "run", "check-locales"]),
    // Discord length limits are a hard blocker: modal placeholders/descriptions and command
    // descriptions get silently truncated by Discord beyond their max length, so any
    // violation here must block the PR gate (fatal: true); unlike the broader locale
    // parity check above, which tolerates missing Japanese translations.
    runCheck(
      "Localization Discord Limits (bun run check-locale-lengths)",
      ["bun", "run", "check-locale-lengths"],
      true,
      true,
    ),
    runCheck(
      "Config Breadcrumbs (bun run check-config-breadcrumbs)",
      ["bun", "run", "check-config-breadcrumbs"],
      true,
      true,
    ),
  ]);

  // This check imports the complete command graph. Keep it outside the parallel
  // block so Windows/Bun does not run multiple command-graph loaders at once.
  const commandReferenceResult = await runCheck(
    "Command Reference Freshness (bun run check-command-reference)",
    ["bun", "run", "check-command-reference"],
    true,
    true,
  );

  // Also loads the complete command graph, so it stays serialized alongside the check above.
  const commandMentionsResult = await runCheck(
    "Command Mentions (bun run check-command-mentions)",
    ["bun", "run", "check-command-mentions"],
    true,
    true,
  );

  // Also loads the complete command graph, so it stays serialized alongside the checks above.
  const commandRootsResult = await runCheck(
    "Command Roots Documentation (bun run check-command-roots)",
    ["bun", "run", "check-command-roots"],
    true,
    true,
  );

  const results: ResultItem[] = [
    typeCheckResult,
    lintResult,
    runtimeImportsResult,
    knipResult,
    commentAuditResult,
    auditResult,
    sqlAuditResult,
    mediaSizeResult,
    modelCatalogResult,
    migrationFilesResult,
    ...testResultItems,
    schemaDriftResult,
    dbLifecycleResult,
    localesResult,
    localeLengthsResult,
    configBreadcrumbsResult,
    commandReferenceResult,
    commandMentionsResult,
    commandRootsResult,
  ];

  console.log("\n====================================");
  console.log("VALIDATION RESULTS");
  console.log("====================================\n");

  // Compute before printing, so avoids relying on printItem side-effects and handles
  // any item that might not match a category filter
  const allFatalPassed = results.every(
    (r) => r.skippedReason !== undefined || r.exitCode === 0 || r.isWarning || !r.fatal,
  );

  const HINTS: Record<string, string> = {
    "Type Check": "Run `bun run check` locally to see TypeScript errors.",
    "Linting (bun run lint)": "Review the warning or commit the auto-fixed files.",
    "Runtime Imports":
      "Run `bun install --frozen-lockfile`, then `bun run check-runtime-imports`. Confirm bun.lock resolves gaxios to uuid@9.",
    Knip: "Run `bun run knip` and remove unused files, dependencies, or exports, or update scripts/knip.json for intentional entry points.",
    "Comment Audit":
      "Run `bun run audit-comments` and review each finding against docs/en/contributing/comment-policy.md before editing.",
    "Command Mentions":
      "A locale string names a slash path that is not registered. Update the prose to the new path, or add a documented entry to scripts/checks/command-mention-exceptions.json.",
    "Dependency Audit":
      "Update the parent dependency or run `bun update <package-name>` specifically. Only use a global override when the replacement stays within every dependent package's declared version range.",
    "SQL Audit":
      "Ensure all raw SQL queries are inside the 'src/utils/db/repositories/' folder or exempt them in the script.",
    "Seed Catalog":
      "Run `bun run check-seed-catalogs` to see which invariant broke. Seed catalogs live in `src/db/seed/catalog/` — the same validations run at bot startup, so a failure here would also fail a real boot.",
    "Media Size":
      "Run `bun run compress-media` to fix this automatically (lossless re-encode, downscaling oversized art to fit). Default Persona avatars/sprites ship to Discord, so keep them under 1 MB. Override the budget with MEDIA_SIZE_LIMIT_BYTES if truly needed.",
    "Schema Drift Check": "Ensure `schema.sql` and your Zod types in `src/types/db/schema.ts` are in sync. See the check output for the specific mismatch (column missing from schema.sql, export coverage gap, or INSERT column count mismatch).",
    "Migration Files":
      "Every `NNN_*.sql` up-migration needs a paired `NNN_*.down.sql`, and no two may share an `NNN` prefix. If another PR already merged your number, rename yours to the next free number.",
    "DB Lifecycle Validation": "Check the detailed logs above. Your migration might be invalid or nuke-db failed.",
    "Localization Keys":
      "Missing keys (red/blocking) mean a source file references a key that exists in no locale; this must be fixed. Missing Japanese equivalents (orange/advisory) are safe to push — run `bun run prune-locales` to clean up orphaned keys, or add the missing `ja` entries.",
    "Localization Discord Limits":
      "Discord truncates modal placeholders/descriptions and select-option labels/descriptions (>100 chars), modal titles/labels (>45), and command descriptions (>100). Shorten the listed locale strings — both `en-US` and `ja` sides must fit.",
    "Command Reference":
      "Run `bun run generate-command-reference` and commit the regenerated docs/en/features/command-reference.md.",
    "Command Roots":
      "Update the documented top-level categories in docs/en/architecture/subsystems/command-system.md to match runtime registration.",
    "Config Breadcrumbs":
      "Update breadcrumb calls in helpCatalog.ts to match CONFIG_PAGES_BY_CATEGORY and config labels.",
  };

  const getHint = (name: string) => {
    const key = Object.keys(HINTS).find((k) => name.includes(k));
    return key ? `\n      Hint: ${HINTS[key]}` : "";
  };

  const printItem = (r: ResultItem) => {
    const summary = r.summary ? ` ${r.summary}` : "";
    const hintText = r.hint ? `\n      💡 Hint: ${r.hint}` : getHint(r.name);

    if (r.skippedReason) {
      console.log(`  [⚪] ${r.name} (Skipped: ${r.skippedReason})`);
    } else if (r.exitCode === 0 && !r.isWarning) {
      console.log(`  [🟢] ${r.name}${summary}`);
    } else if (r.isWarning) {
      console.log(`  [🟡] ${r.name} (Warning)${summary}${hintText}`);
    } else if (!r.fatal && r.exitCode !== 0) {
      console.log(`  [🟠] ${r.name} (Safe to push — fix when possible)${summary}${hintText}`);
    } else {
      console.log(`  [🔴] ${r.name} (Failed)${summary}${hintText}`);
    }

    if (r.subItems && r.subItems.length > 0) {
      for (const item of r.subItems) {
        console.log(`      ↳ ${item}`);
      }
    }
  };

  const printSection = (title: string, items: ResultItem[], emptyMessage?: string) => {
    console.log(title);
    if (items.length === 0 && emptyMessage) {
      console.log(`  [⚪] ${emptyMessage}`);
      return;
    }
    for (const item of items) printItem(item);
  };

  /**
   * Test-file sections, where one row per file is detail rather than a verdict.
   *
   * There are roughly 360 test files, so listing every green one buries the handful
   * that matter. Only the non-green rows are printed under quiet mode, with the green
   * count that replaces them stated explicitly so a silent section can never be
   * mistaken for a section that did not run.
   */
  const printTestSection = (title: string, items: ResultItem[], emptyMessage: string) => {
    if (verboseOutput) {
      printSection(title, items, emptyMessage);
      return;
    }

    console.log(title);
    if (items.length === 0) {
      console.log(`  [⚪] ${emptyMessage}`);
      return;
    }

    const passing = items.filter((r) => r.exitCode === 0 && !r.isWarning && r.skippedReason === undefined);
    for (const item of items) {
      if (!passing.includes(item)) printItem(item);
    }
    if (passing.length > 0) {
      console.log(`  [🟢] ${passing.length} test files passed (pass --verbose to list them)`);
    }
  };

  printSection("Code Quality", results.filter((r) => CATEGORIES.CODE(r)));

  printSection("\nContent Guards", results.filter((r) => CATEGORIES.CONTENT(r)));

  printSection("\nProject Security", results.filter((r) => CATEGORIES.SECURITY(r)));

  printTestSection(
    "\nUnit Tests (bun run test)",
    results.filter((r) => CATEGORIES.UNIT_TESTS(r)),
    "No unit test files reported by runner",
  );

  printTestSection(
    "\nRegression Tests (bun run test)",
    results.filter((r) => CATEGORIES.REGRESSION_TESTS(r)),
    "No regression test files reported by runner",
  );

  printSection("\nDatabase Validation", results.filter((r) => CATEGORIES.DB(r)));

  printSection("\nLocalization", results.filter((r) => CATEGORIES.LOCALES(r)));

  printSection("\nDocumentation", results.filter((r) => CATEGORIES.DOCUMENTATION(r)));

  // Safety net: a check whose name matches no predicate still gates the exit code
  // but would otherwise never be printed, leaving a ❌ run with nothing to explain
  // it. Surfacing strays here means adding a check can never make it invisible.
  const categorized = new Set(
    Object.values(CATEGORIES).flatMap((matches) => results.filter((r) => matches(r))),
  );
  const uncategorized = results.filter((r) => !categorized.has(r));
  if (uncategorized.length > 0) {
    printSection("\nOther Checks (uncategorized — add these to CATEGORIES in vl.ts)", uncategorized);
  }

  console.log("\n====================================");

  // A machine-readable final line, because a caller (agent harness, background job
  // wrapper, CI step) otherwise has to infer the outcome from the narrative above or
  // write its own exit marker into the log. Printed last so that a reader who trusts
  // only the tail of the output still gets the verdict and the counts behind it.
  const grade = (r: ResultItem): "skip" | "pass" | "warn" | "fail" => {
    if (r.skippedReason !== undefined) return "skip";
    if (r.isWarning) return "warn";
    if (r.exitCode === 0) return "pass";
    return r.fatal ? "fail" : "warn";
  };
  const tally = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const r of results) tally[grade(r)]++;

  const exitCode = allFatalPassed ? 0 : 1;
  console.log(
    `\nvl-status: ${exitCode === 0 ? "PASS" : "FAIL"} exit=${exitCode}` +
      ` pass=${tally.pass} warn=${tally.warn} fail=${tally.fail} skip=${tally.skip}\n`,
  );

  if (allFatalPassed) {
    console.log("✅ All required checks passed.\n");
    process.exit(0);
  } else {
    console.log("❌ Some required checks failed. Please fix the errors above before opening a PR.\n");
    process.exit(1);
  }
}

// Guarded so `parseJUnitSuites` can be imported by its unit test without
// running the entire validation suite as a side effect of the import.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
