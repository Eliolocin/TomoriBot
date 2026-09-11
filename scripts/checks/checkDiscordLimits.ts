import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { Glob } from "bun";
import { log } from "@/utils/misc/logger";
import { isFullOutput } from "./lib/gateOutput";

/**
 * Discord API Limits
 */
const DISCORD_LIMITS = {
  /**
   * Upper bound for `.setMaxLength()` on modal text inputs.
   *
   * Discord allows a modal text input `max_length` of 1-4000 (a slash-command
   * string option allows up to 6000). Patterns 2 and 4 below share a single
   * `.setMaxLength()` regex and cannot tell the two builders apart, so this
   * uses the stricter of the two limits.
   *
   * Previously 256, which is not a Discord limit for either builder and
   * produced five false positives on correct, shipped code.
   */
  MAX_TEXT_INPUT_LENGTH: 4000,
  MAX_CHOICE_COUNT: 25,
  MAX_SELECT_OPTIONS: 25,
} as const;

/**
 * Interface for tracking violations
 */
interface Violation {
  file: string;
  line: number;
  type: ViolationType;
  description: string;
  value?: string | number;
}

/**
 * Types of violations that can be detected
 */
type ViolationType = "missing_max_length" | "exceeds_max_length" | "exceeds_choice_limit" | "exceeds_select_limit";

/**
 * Interface for analysis results
 */
interface AnalysisResult {
  violations: Violation[];
  filesScanned: number;
  violationsByType: Map<ViolationType, number>;
}

/**
 * Extracts line number for a given match index in content
 */
function getLineNumber(content: string, matchIndex: number): number {
  const beforeMatch = content.substring(0, matchIndex);
  return beforeMatch.split("\n").length;
}

/**
 * Checks if a TextInputBuilder or SlashCommandStringOption has proper maxLength
 */
function checkStringLengthLimits(content: string, file: string): Violation[] {
  const violations: Violation[] = [];

  // Pattern 1: TextInputBuilder - find the complete builder chain
  // Match from 'new TextInputBuilder()' to the statement terminator (semicolon or ActionRowBuilder)
  const textInputPattern =
    /new\s+TextInputBuilder\s*\(\s*\)([\s\S]*?)(?=;|new\s+ActionRowBuilder|\.addComponents\(textInput\)|\.addComponents\(fallbackInput\))/g;

  let match: RegExpExecArray | null = textInputPattern.exec(content);
  while (match !== null) {
    const builderBlock = match[0] + match[1];
    if (!builderBlock.includes("setMaxLength")) {
      violations.push({
        file,
        line: getLineNumber(content, match.index),
        type: "missing_max_length",
        description: `TextInputBuilder missing .setMaxLength() - should not exceed ${DISCORD_LIMITS.MAX_TEXT_INPUT_LENGTH} characters`,
      });
    }
    match = textInputPattern.exec(content);
  }

  const textInputExcessPattern = /\.setMaxLength\s*\(\s*(\d+)\s*\)/g;
  match = textInputExcessPattern.exec(content);
  while (match !== null) {
    const maxLength = Number.parseInt(match[1], 10);
    if (maxLength > DISCORD_LIMITS.MAX_TEXT_INPUT_LENGTH) {
      violations.push({
        file,
        line: getLineNumber(content, match.index),
        type: "exceeds_max_length",
        description: `TextInputBuilder maxLength (${maxLength}) exceeds Discord limit of ${DISCORD_LIMITS.MAX_TEXT_INPUT_LENGTH}`,
        value: maxLength,
      });
    }
    match = textInputExcessPattern.exec(content);
  }

  const stringOptionPattern =
    /\.addStringOption\s*\(\s*(?:option|o)\s*=>\s*(?:option|o)(?:(?!setMaxLength)[\s\S]){0,500}?(?=\)|\n\s*\.add|\n\s*,)/g;

  match = stringOptionPattern.exec(content);
  while (match !== null) {
    const optionBlock = match[0];
    if (!optionBlock.includes("setMaxLength") && !optionBlock.includes("setAutocomplete(true)")) {
      // Only flag if it's not just an autocomplete field
      if (optionBlock.includes("setRequired(true)") || optionBlock.includes("setDescription")) {
        violations.push({
          file,
          line: getLineNumber(content, match.index),
          type: "missing_max_length",
          description: `SlashCommandStringOption missing .setMaxLength() - should not exceed ${DISCORD_LIMITS.MAX_TEXT_INPUT_LENGTH} characters`,
        });
      }
    }
    match = stringOptionPattern.exec(content);
  }

  // Pattern 4: SlashCommandStringOption with maxLength > 256
  // (reuse textInputExcessPattern since it's the same method name)

  return violations;
}

/**
 * Checks if choice arrays exceed Discord's 25-choice limit
 */
function checkChoiceLimits(content: string, file: string): Violation[] {
  const violations: Violation[] = [];

  const choicePattern = /\.(addChoices|setChoices)\s*\(\s*\[([\s\S]*?)\]\s*\)/g;

  let match: RegExpExecArray | null = choicePattern.exec(content);
  while (match !== null) {
    const choicesArray = match[2];

    const choiceCount = (choicesArray.match(/\{\s*name:/g) || []).length;

    if (choiceCount > DISCORD_LIMITS.MAX_CHOICE_COUNT) {
      violations.push({
        file,
        line: getLineNumber(content, match.index),
        type: "exceeds_choice_limit",
        description: `Choice array has ${choiceCount} items, exceeds Discord limit of ${DISCORD_LIMITS.MAX_CHOICE_COUNT}`,
        value: choiceCount,
      });
    }
    match = choicePattern.exec(content);
  }

  return violations;
}

/**
 * Checks if select menus exceed Discord's 25-option limit
 */
function checkSelectMenuLimits(content: string, file: string): Violation[] {
  const violations: Violation[] = [];

  const selectMenuPattern =
    /new\s+StringSelectMenuBuilder\s*\(\s*\)([\s\S]{0,800}?)(?=new\s+\w+Builder|const|let|var|;|\n\n)/g;

  let match: RegExpExecArray | null = selectMenuPattern.exec(content);
  while (match !== null) {
    const menuBlock = match[1];

    const optionsPattern = /\.(addOptions|setOptions)\s*\(\s*\[([\s\S]*?)\]\s*\)/g;
    let optionsMatch: RegExpExecArray | null = optionsPattern.exec(menuBlock);

    while (optionsMatch !== null) {
      const optionsArray = optionsMatch[2];

      const optionCount = (optionsArray.match(/\{\s*label:/g) || []).length;

      if (optionCount > DISCORD_LIMITS.MAX_SELECT_OPTIONS) {
        violations.push({
          file,
          line: getLineNumber(content, match.index),
          type: "exceeds_select_limit",
          description: `Select menu has ${optionCount} options, exceeds Discord limit of ${DISCORD_LIMITS.MAX_SELECT_OPTIONS}`,
          value: optionCount,
        });
      }
      optionsMatch = optionsPattern.exec(menuBlock);
    }
    match = selectMenuPattern.exec(content);
  }

  return violations;
}

/**
 * Main analysis function that scans all TypeScript files
 */
async function analyzeDiscordLimits(): Promise<AnalysisResult> {
  log.info("🔍 Starting Discord API limits analysis...");

  const violations: Violation[] = [];
  const srcPath = join(process.cwd(), "src");
  let filesScanned = 0;

  try {
    const glob = new Glob("**/*.ts");
    for await (const file of glob.scan(srcPath)) {
      if (file.includes(".d.ts") || file.includes(".test.ts")) {
        continue;
      }

      const filePath = join(srcPath, file);
      try {
        const content = await readFile(filePath, "utf-8");
        filesScanned++;

        const stringLengthViolations = checkStringLengthLimits(content, file);
        const choiceViolations = checkChoiceLimits(content, file);
        const selectMenuViolations = checkSelectMenuLimits(content, file);

        violations.push(...stringLengthViolations, ...choiceViolations, ...selectMenuViolations);
      } catch (readError) {
        log.warn(`Failed to read file: ${file}`, readError);
      }
    }
  } catch (error) {
    log.error("Error scanning source files", error);
    throw error;
  }

  const violationsByType = new Map<ViolationType, number>();
  for (const violation of violations) {
    violationsByType.set(violation.type, (violationsByType.get(violation.type) || 0) + 1);
  }

  return {
    violations,
    filesScanned,
    violationsByType,
  };
}

/**
 * Formats violation type into a human-readable category
 */
function formatViolationType(type: ViolationType): string {
  const typeLabels: Record<ViolationType, string> = {
    missing_max_length: "Missing Max Length",
    exceeds_max_length: "Exceeds Max Length",
    exceeds_choice_limit: "Exceeds Choice Limit (25 items)",
    exceeds_select_limit: "Exceeds Select Menu Limit (25 options)",
  };
  return typeLabels[type];
}

/**
 * Displays analysis results in a formatted way
 */
function displayResults(results: AnalysisResult): void {
  const fullOutput = isFullOutput();
  const violations = results.violations;

  // A clean run gets one line. The banner, the summary block, and the closing
  // encouragement are all scaffolding around "no violations", which is the whole report.
  if (violations.length === 0) {
    console.log(`✅ Discord API limits OK (${results.filesScanned} files scanned, 0 violations)`);
    return;
  }

  console.log(`\n${"=".repeat(80)}`);
  console.log("🔍 DISCORD API LIMITS ANALYSIS RESULTS");
  console.log("=".repeat(80));

  // Violations are blocking, so their listing always prints. Only the summary that
  // follows it is collapsed, because the reader already has the detail above.
  console.log("\n❌ VIOLATIONS FOUND:");
  console.log("-".repeat(60));

  const violationsByType = new Map<ViolationType, Violation[]>();
  for (const violation of violations) {
    if (!violationsByType.has(violation.type)) {
      violationsByType.set(violation.type, []);
    }
    violationsByType.get(violation.type)?.push(violation);
  }

  for (const [type, typedViolations] of violationsByType) {
    console.log(`\n⚠️  ${formatViolationType(type)} (${typedViolations.length}):`);
    for (const violation of typedViolations.sort((a, b) => a.file.localeCompare(b.file))) {
      console.log(`  ❌ ${violation.file}:${violation.line}`);
      console.log(`     ${violation.description}`);
    }
  }

  console.log(`\n📊 ${results.filesScanned} files scanned, ${violations.length} violations.`);
  if (fullOutput) {
    console.log("\n  Breakdown by type:");
    for (const [type, count] of results.violationsByType) {
      console.log(`    - ${formatViolationType(type)}: ${count}`);
    }
    console.log("\n⚠️  Please fix the violations above to ensure Discord API compliance.");
    console.log(`\n${"=".repeat(80)}`);
  }
}

/**
 * Main execution function
 */
async function main(): Promise<void> {
  try {
    const results = await analyzeDiscordLimits();
    displayResults(results);

    if (results.violations.length > 0) {
      process.exit(1);
    }
  } catch (error) {
    log.error("Fatal error during Discord limits analysis", error);
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
