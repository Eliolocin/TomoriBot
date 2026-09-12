import { join, relative } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { Project, SyntaxKind, type CallExpression } from "ts-morph";
import { CONFIG_PAGES_BY_CATEGORY, type ConfigCategory, type ConfigPage } from "@/utils/discord/configPanelCatalog";
import { CATEGORY_LOCALE_KEYS, PAGE_LOCALE_KEYS } from "@/utils/discord/ui/configPanel";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";

export type BreadcrumbFinding = {
  file: string;
  line: number;
  kind: "english-literal" | "invalid-signature" | "nonexistent-category" | "nonexistent-page" | "missing-key" | "stale-label-mapping";
  message: string;
};

const BREADCRUMB_KEY_PATTERN = /^commands\.help\.breadcrumbs\.([a-z0-9_-]+)\.([a-z0-9_-]+)$/;

type BreadcrumbResolver = (key: string) => string;

export function validateBreadcrumbCall(
  call: CallExpression,
  filePath: string,
  resolveBreadcrumb: BreadcrumbResolver = (key) => localizer("en-US", key),
): BreadcrumbFinding | null {
  const line = call.getStartLineNumber();
  const file = relative(process.cwd(), filePath).replace(/\\/g, "/");
  const args = call.getArguments();

  if (args.length !== 2) {
    const rawCallText = call.getText();
    return {
      file,
      line,
      kind: "invalid-signature",
      message: `Expected configPage(locale, key) signature with 2 arguments, got \`${rawCallText}\``,
    };
  }

  const keyArg = args[1];
  if (!keyArg || !keyArg.isKind(SyntaxKind.StringLiteral)) {
    return {
      file,
      line,
      kind: "invalid-signature",
      message: `Breadcrumb key argument must be a string literal, got \`${keyArg?.getText() ?? ""}\``,
    };
  }

  const key = keyArg.getLiteralValue();
  const match = key.match(BREADCRUMB_KEY_PATTERN);
  if (!match) {
    return {
      file,
      line,
      kind: "english-literal",
      message: `Remaining English literal or non-breadcrumb key: "${key}"`,
    };
  }

  const [, category, page] = match;
  if (!category || !(category in CONFIG_PAGES_BY_CATEGORY)) {
    return {
      file,
      line,
      kind: "nonexistent-category",
      message: `Nonexistent category "${category}" referenced by "${key}"`,
    };
  }

  const validPages = CONFIG_PAGES_BY_CATEGORY[category as ConfigCategory];
  if (!page || !validPages.includes(page as ConfigPage)) {
    return {
      file,
      line,
      kind: "nonexistent-page",
      message: `Nonexistent page "${page}" for category "${category}" referenced by "${key}"`,
    };
  }

  const resolved = resolveBreadcrumb(key);
  if (!resolved || resolved === key) {
    return {
      file,
      line,
      kind: "missing-key",
      message: `Missing locale key "${key}" in en-US`,
    };
  }

  const categoryLocaleKey = CATEGORY_LOCALE_KEYS[category as ConfigCategory];
  const pageLocaleKey = PAGE_LOCALE_KEYS[category as ConfigCategory]?.[page];
  const expectedCategoryLabel = categoryLocaleKey ? localizer("en-US", categoryLocaleKey) : null;
  const expectedPageLabel = pageLocaleKey ? localizer("en-US", pageLocaleKey) : null;
  const expectedBreadcrumb = `${expectedCategoryLabel} > ${expectedPageLabel}`;

  if (resolved !== expectedBreadcrumb) {
    return {
      file,
      line,
      kind: "stale-label-mapping",
      message: `Stale label mapping for "${key}": expected "${expectedBreadcrumb}", got "${resolved}"`,
    };
  }

  return null;
}

export function inspectSourceForBreadcrumbs(
  sourceText: string,
  filePath = "src/utils/discord/helpCatalog.ts",
  resolveBreadcrumb?: BreadcrumbResolver,
): { findings: BreadcrumbFinding[]; callCount: number } {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile(filePath, sourceText);
  const calls = sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => call.getExpression().getText() === "configPage");

  const findings: BreadcrumbFinding[] = [];
  for (const call of calls) {
    const finding = validateBreadcrumbCall(call, filePath, resolveBreadcrumb);
    if (finding) {
      findings.push(finding);
    }
  }

  return { findings, callCount: calls.length };
}

async function collectSourceFilesWithCalls(dirPath: string): Promise<string[]> {
  const matchingFiles: string[] = [];
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectSourceFilesWithCalls(fullPath);
      matchingFiles.push(...nested);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      const content = await readFile(fullPath, "utf-8");
      if (content.includes("configPage(")) {
        matchingFiles.push(fullPath);
      }
    }
  }

  return matchingFiles;
}

async function main(): Promise<void> {
  await initializeLocalizer();

  const srcDir = join(process.cwd(), "src");
  const candidateFiles = await collectSourceFilesWithCalls(srcDir);
  const project = new Project({ skipAddingFilesFromTsConfig: true });

  const allFindings: BreadcrumbFinding[] = [];
  let totalCalls = 0;

  for (const filePath of candidateFiles) {
    const sourceFile = project.addSourceFileAtPath(filePath);
    const calls = sourceFile
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((call) => call.getExpression().getText() === "configPage");

    totalCalls += calls.length;
    for (const call of calls) {
      const finding = validateBreadcrumbCall(call, filePath);
      if (finding) {
        allFindings.push(finding);
      }
    }
  }

  if (totalCalls === 0) {
    console.error("No configPage() call sites were discovered in src/.");
    process.exit(1);
  }

  if (allFindings.length === 0) {
    console.log(
      `Config breadcrumbs OK (${totalCalls} call sites verified across ${candidateFiles.length} files)`,
    );
    process.exit(0);
  }

  console.error(`Found ${allFindings.length} configPage breadcrumb issue(s):`);
  for (const finding of allFindings) {
    console.error(`  ${finding.file}:${finding.line} [${finding.kind}] ${finding.message}`);
  }
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
