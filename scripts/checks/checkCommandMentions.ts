/**
 * Validates every slash path named in locale prose against the registered command tree.
 *
 * Locale strings routinely tell a user to run a command ("Use `/kill` if I am stuck").
 * `check-locales` validates key existence and parity but never inspects a string's content,
 * and `check-command-reference` only compares the generated reference page, so a command
 * move leaves those mentions pointing at a path Discord no longer exposes with nothing
 * failing. This check closes that gap.
 */
import { join } from "node:path";
import { collectValidCommandPaths } from "../lib/commandReference";

const LOCALE_ROOT = join(process.cwd(), "src", "locales");
const SRC_ROOT = join(process.cwd(), "src");
const EXCEPTIONS_PATH = join(process.cwd(), "scripts", "checks", "command-mention-exceptions.json");

/**
 * Locale strings are template literals, so an inline code span is written with escaped
 * backticks. Double-quoted strings carry bare backticks instead, hence the optional escape
 * on each side. A path is lowercase words separated by single spaces, matching Discord's
 * own command-name rules.
 */
const MENTION_PATTERN = /(?:\\)?`\/([a-z][a-z0-9_-]*(?: [a-z][a-z0-9_-]*)*)(?:\\)?`/g;

/**
 * Local wrappers shadow getCommandMention to inject a shared prefix. Matching a bare
 * mention() identifier everywhere introduces false positives where an argument like
 * action: "add" | "remove" is parsed as a root command. This list restricts bare
 * mention() scanning to files known to implement that pattern safely.
 */
const WRAPPER_ALLOWLIST = [
  "src/utils/discord/helpCatalog.ts",
];

type Exception = {
  path: string;
  reason: string;
};

export type Finding = {
  file: string;
  line: number;
  mention: string;
};

async function loadExceptions(): Promise<Set<string>> {
  const file = Bun.file(EXCEPTIONS_PATH);
  if (!(await file.exists())) return new Set();
  const parsed = (await file.json()) as { exceptions?: Exception[] };
  return new Set((parsed.exceptions ?? []).map((entry) => entry.path));
}

function findMentions(source: string, relativePath: string): Finding[] {
  const findings: Finding[] = [];

  source.split(/\r?\n/).forEach((text, index) => {
    for (const match of text.matchAll(MENTION_PATTERN)) {
      const mention = match[1];
      if (mention) findings.push({ file: relativePath, line: index + 1, mention });
    }
  });

  return findings;
}

export function findRuntimeMentions(source: string, relativePath: string): Finding[] {
  const findings: Finding[] = [];
  const normalizedPath = relativePath.replace(/\\/g, "/");

  if (normalizedPath === "src/utils/discord/commandRegistry.ts") return findings;

  const allowMentionWrapper = WRAPPER_ALLOWLIST.includes(normalizedPath);
  const regex = /\b(getCommandMention|mention)\s*\(([^)]+)\)/g;

  for (const match of source.matchAll(regex)) {
    const funcName = match[1];
    if (funcName === "mention" && !allowMentionWrapper) continue;

    const argsStr = match[2];
    const argMatches = [...argsStr.matchAll(/["']([a-z0-9_-]+)["']/g)];

    const isAllLiterals = /^(\s*["'][a-z0-9_-]+["']\s*,?\s*)+$/.test(argsStr);
    if (isAllLiterals && argMatches.length > 0) {
      const mentionPath = argMatches.map(m => m[1]).join(" ");
      const line = (source.slice(0, match.index).match(/\n/g) || []).length + 1;
      findings.push({ file: relativePath, line, mention: mentionPath });
    }
  }

  return findings;
}

/** Longest registered path sharing a prefix with the stale mention, used as a repair hint. */
function suggestClosest(mention: string, validPaths: Set<string>): string | null {
  const segments = mention.split(" ");

  for (let length = segments.length - 1; length >= 1; length--) {
    const prefix = segments.slice(0, length).join(" ");
    if (validPaths.has(prefix)) return prefix;
  }

  const tail = segments[segments.length - 1];
  const tailMatch = [...validPaths].find((path) => path === tail || path.endsWith(` ${tail}`));
  return tailMatch ?? null;
}

async function main(): Promise<void> {
  process.env.RUN_ENV = "production";

  const [validPaths, allowed] = await Promise.all([collectValidCommandPaths(), loadExceptions()]);

  const localeGlob = new Bun.Glob("**/*.ts");
  const findings: Finding[] = [];

  for await (const file of localeGlob.scan(LOCALE_ROOT)) {
    const absolute = join(LOCALE_ROOT, file);
    const source = await Bun.file(absolute).text();
    findings.push(...findMentions(source, join("src", "locales", file).replace(/\\/g, "/")));
  }

  const srcGlob = new Bun.Glob("**/*.ts");
  for await (const file of srcGlob.scan(SRC_ROOT)) {
    const absolute = join(SRC_ROOT, file);
    const source = await Bun.file(absolute).text();
    findings.push(...findRuntimeMentions(source, join("src", file).replace(/\\/g, "/")));
  }

  const stale = findings.filter((finding) => !validPaths.has(finding.mention) && !allowed.has(finding.mention));

  if (stale.length === 0) {
    console.log(`Command mentions OK (${findings.length} checked against ${validPaths.size} registered paths)`);
    return;
  }

  console.error("\nSTALE COMMAND MENTIONS (named in locale prose or source but not registered):");
  console.error("-".repeat(70));

  const byMention = new Map<string, Finding[]>();
  for (const finding of stale) {
    const bucket = byMention.get(finding.mention) ?? [];
    bucket.push(finding);
    byMention.set(finding.mention, bucket);
  }

  for (const [mention, occurrences] of [...byMention].sort((a, b) => a[0].localeCompare(b[0]))) {
    const closest = suggestClosest(mention, validPaths);
    console.error(`  /${mention}${closest ? `   (did you mean /${closest}?)` : ""}`);
    for (const occurrence of occurrences) {
      console.error(`     ${occurrence.file}:${occurrence.line}`);
    }
  }

  console.error(
    "\nUpdate the prose to the new path, or add a documented entry to scripts/checks/command-mention-exceptions.json.",
  );
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
