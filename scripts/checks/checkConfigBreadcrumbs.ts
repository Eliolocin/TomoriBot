import { join, relative } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { Project, SyntaxKind, type CallExpression } from "ts-morph";
import { CONFIG_PAGES_BY_CATEGORY, type ConfigCategory, type ConfigPage } from "@/utils/discord/configPanelCatalog";
import { CATEGORY_LOCALE_KEYS, PAGE_LOCALE_KEYS } from "@/utils/discord/ui/configPanel";
import {
  PERSONAL_CONFIG_PAGES_BY_CATEGORY,
  type PersonalConfigCategory,
  type PersonalConfigPage,
} from "@/utils/discord/personalConfigPanelCatalog";
import { PERSONAL_CATEGORY_LOCALE_KEYS, PERSONAL_PAGE_LOCALE_KEYS } from "@/utils/discord/ui/personalConfigPanel";
import { MODERATION_CATEGORIES, type ModerationCategory } from "@/utils/discord/moderationPanelCatalog";
import { MODERATION_CATEGORY_LOCALE_KEYS } from "@/utils/discord/ui/moderationPanel";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";

export type BreadcrumbFinding = {
  file: string;
  line: number;
  kind:
    | "english-literal"
    | "invalid-signature"
    | "nonexistent-category"
    | "nonexistent-page"
    | "missing-key"
    | "stale-label-mapping"
    | "wrong-root-namespace";
  message: string;
};

const BREADCRUMB_HELPERS = new Set([
  "configPage",
  "personalConfigPage",
  "moderationPage",
  "breadcrumbPage",
]);

const BREADCRUMB_HELPER_CALL_PATTERN =
  /(?:configPage|personalConfigPage|moderationPage|breadcrumbPage)\s*\(/;

type BreadcrumbResolver = (key: string) => string;

export function getBreadcrumbHelperName(call: CallExpression): string | null {
  const expr = call.getExpression();
  const text = expr.getText();
  if (BREADCRUMB_HELPERS.has(text)) {
    return text;
  }
  if (expr.isKind(SyntaxKind.PropertyAccessExpression)) {
    const name = expr.getName();
    if (BREADCRUMB_HELPERS.has(name)) {
      return name;
    }
  }
  return null;
}

export function validateBreadcrumbCall(
  call: CallExpression,
  filePath: string,
  resolveBreadcrumb: BreadcrumbResolver = (key) => localizer("en-US", key),
): BreadcrumbFinding | null {
  const line = call.getStartLineNumber();
  const file = relative(process.cwd(), filePath).replace(/\\/g, "/");
  const helperName = getBreadcrumbHelperName(call) ?? "configPage";
  const args = call.getArguments();

  const isSharedHelper = helperName === "breadcrumbPage";

  let root: "config" | "personal" | "moderation";
  let keyArgIndex: number;

  if (isSharedHelper) {
    if (args.length !== 3) {
      const rawCallText = call.getText();
      return {
        file,
        line,
        kind: "invalid-signature",
        message: `Expected ${helperName}(root, locale, key) signature with 3 arguments, got \`${rawCallText}\``,
      };
    }

    const rootArg = args[0];
    if (!rootArg || !rootArg.isKind(SyntaxKind.StringLiteral)) {
      return {
        file,
        line,
        kind: "invalid-signature",
        message: `Breadcrumb root argument must be a string literal, got \`${rootArg?.getText() ?? ""}\``,
      };
    }

    const rawRoot = rootArg.getLiteralValue();
    if (rawRoot === "config") {
      root = "config";
    } else if (rawRoot === "personal" || rawRoot === "personal-config") {
      root = "personal";
    } else if (rawRoot === "moderation") {
      root = "moderation";
    } else {
      return {
        file,
        line,
        kind: "invalid-signature",
        message: `Unknown breadcrumb root "${rawRoot}"`,
      };
    }

    keyArgIndex = 2;
  } else {
    if (args.length !== 2) {
      const rawCallText = call.getText();
      return {
        file,
        line,
        kind: "invalid-signature",
        message: `Expected ${helperName}(locale, key) signature with 2 arguments, got \`${rawCallText}\``,
      };
    }

    if (helperName === "personalConfigPage") {
      root = "personal";
    } else if (helperName === "moderationPage") {
      root = "moderation";
    } else {
      root = "config";
    }

    keyArgIndex = 1;
  }

  const keyArg = args[keyArgIndex];
  if (!keyArg || !keyArg.isKind(SyntaxKind.StringLiteral)) {
    return {
      file,
      line,
      kind: "invalid-signature",
      message: `Breadcrumb key argument must be a string literal, got \`${keyArg?.getText() ?? ""}\``,
    };
  }

  const key = keyArg.getLiteralValue();
  if (!key.startsWith("commands.help.breadcrumbs.")) {
    return {
      file,
      line,
      kind: "english-literal",
      message: `Remaining English literal or non-breadcrumb key: "${key}"`,
    };
  }

  const path = key.slice("commands.help.breadcrumbs.".length);
  const parts = path.split(".");
  if (parts.some((p) => !/^[a-z0-9_-]+$/.test(p))) {
    return {
      file,
      line,
      kind: "english-literal",
      message: `Remaining English literal or non-breadcrumb key: "${key}"`,
    };
  }

  if (root === "config") {
    if (parts[0] === "personal" || parts[0] === "moderation") {
      return {
        file,
        line,
        kind: "wrong-root-namespace",
        message: `Namespace mismatch: key "${key}" belongs to "${parts[0]}" namespace, but helper root is "config"`,
      };
    }

    const [category, page] = parts;
    if (!category || !(category in CONFIG_PAGES_BY_CATEGORY)) {
      return {
        file,
        line,
        kind: "nonexistent-category",
        message: `Nonexistent category "${category ?? ""}" referenced by "${key}"`,
      };
    }

    const validPages = CONFIG_PAGES_BY_CATEGORY[category as ConfigCategory];
    if (!page || !validPages.includes(page as ConfigPage)) {
      return {
        file,
        line,
        kind: "nonexistent-page",
        message: `Nonexistent page "${page ?? ""}" for category "${category}" referenced by "${key}"`,
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
  } else if (root === "personal") {
    if (parts[0] !== "personal") {
      return {
        file,
        line,
        kind: "wrong-root-namespace",
        message: `Namespace mismatch: key "${key}" does not belong to personal namespace for root "personal"`,
      };
    }

    const [, category, page] = parts;
    if (!category || !(category in PERSONAL_CONFIG_PAGES_BY_CATEGORY)) {
      return {
        file,
        line,
        kind: "nonexistent-category",
        message: `Nonexistent personal config category "${category ?? ""}" referenced by "${key}"`,
      };
    }

    const validPages = PERSONAL_CONFIG_PAGES_BY_CATEGORY[category as PersonalConfigCategory];
    if (!page || !validPages.includes(page as PersonalConfigPage)) {
      return {
        file,
        line,
        kind: "nonexistent-page",
        message: `Nonexistent page "${page ?? ""}" for personal config category "${category}" referenced by "${key}"`,
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

    const categoryLocaleKey = PERSONAL_CATEGORY_LOCALE_KEYS[category as PersonalConfigCategory];
    const pageLocaleKey = PERSONAL_PAGE_LOCALE_KEYS[category as PersonalConfigCategory]?.[page];
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
  } else if (root === "moderation") {
    if (parts[0] !== "moderation") {
      return {
        file,
        line,
        kind: "wrong-root-namespace",
        message: `Namespace mismatch: key "${key}" does not belong to moderation namespace for root "moderation"`,
      };
    }

    const [, category] = parts;
    if (!category || !(MODERATION_CATEGORIES as readonly string[]).includes(category)) {
      return {
        file,
        line,
        kind: "nonexistent-category",
        message: `Nonexistent moderation category "${category ?? ""}" referenced by "${key}"`,
      };
    }

    if (parts.length > 2) {
      return {
        file,
        line,
        kind: "nonexistent-page",
        message: `Moderation category "${category}" has no subpages, but got "${parts.slice(2).join(".")}" in "${key}"`,
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

    const categoryLocaleKey = MODERATION_CATEGORY_LOCALE_KEYS[category as ModerationCategory];
    const expectedCategoryLabel = categoryLocaleKey ? localizer("en-US", categoryLocaleKey) : null;
    const expectedBreadcrumb = expectedCategoryLabel;

    if (resolved !== expectedBreadcrumb) {
      return {
        file,
        line,
        kind: "stale-label-mapping",
        message: `Stale label mapping for "${key}": expected "${expectedBreadcrumb}", got "${resolved}"`,
      };
    }
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
    .filter((call) => getBreadcrumbHelperName(call) !== null);

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
      if (BREADCRUMB_HELPER_CALL_PATTERN.test(content)) {
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
      .filter((call) => getBreadcrumbHelperName(call) !== null);

    totalCalls += calls.length;
    for (const call of calls) {
      const finding = validateBreadcrumbCall(call, filePath);
      if (finding) {
        allFindings.push(finding);
      }
    }
  }

  if (totalCalls === 0) {
    console.error("No breadcrumb call sites were discovered in src/.");
    process.exit(1);
  }

  if (allFindings.length === 0) {
    console.log(
      `Breadcrumbs OK (${totalCalls} call sites verified across ${candidateFiles.length} files)`,
    );
    process.exit(0);
  }

  console.error(`Found ${allFindings.length} breadcrumb issue(s):`);
  for (const finding of allFindings) {
    console.error(`  ${finding.file}:${finding.line} [${finding.kind}] ${finding.message}`);
  }
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
