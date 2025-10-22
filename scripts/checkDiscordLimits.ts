import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { Glob } from "bun";
import { log } from "../src/utils/misc/logger";

/**
 * Discord API Limits
 */
const DISCORD_LIMITS = {
	MAX_STRING_LENGTH: 256,
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
type ViolationType =
	| "missing_max_length"
	| "exceeds_max_length"
	| "exceeds_choice_limit"
	| "exceeds_select_limit";

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
 * @param content - File content
 * @param matchIndex - Index of the match in the content
 * @returns Line number (1-indexed)
 */
function getLineNumber(content: string, matchIndex: number): number {
	const beforeMatch = content.substring(0, matchIndex);
	return beforeMatch.split("\n").length;
}

/**
 * Checks if a TextInputBuilder or SlashCommandStringOption has proper maxLength
 * @param content - File content
 * @param file - File path
 * @returns Array of violations found
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
		// Check if this block has setMaxLength
		if (!builderBlock.includes("setMaxLength")) {
			violations.push({
				file,
				line: getLineNumber(content, match.index),
				type: "missing_max_length",
				description:
					"TextInputBuilder missing .setMaxLength() - should not exceed 256 characters",
			});
		}
		match = textInputPattern.exec(content);
	}

	// Pattern 2: TextInputBuilder with maxLength > 256
	const textInputExcessPattern = /\.setMaxLength\s*\(\s*(\d+)\s*\)/g;
	match = textInputExcessPattern.exec(content);
	while (match !== null) {
		const maxLength = Number.parseInt(match[1], 10);
		if (maxLength > DISCORD_LIMITS.MAX_STRING_LENGTH) {
			violations.push({
				file,
				line: getLineNumber(content, match.index),
				type: "exceeds_max_length",
				description: `TextInputBuilder maxLength (${maxLength}) exceeds Discord limit of ${DISCORD_LIMITS.MAX_STRING_LENGTH}`,
				value: maxLength,
			});
		}
		match = textInputExcessPattern.exec(content);
	}

	// Pattern 3: SlashCommandStringOption without setMaxLength
	const stringOptionPattern =
		/\.addStringOption\s*\(\s*(?:option|o)\s*=>\s*(?:option|o)(?:(?!setMaxLength)[\s\S]){0,500}?(?=\)|\n\s*\.add|\n\s*,)/g;

	match = stringOptionPattern.exec(content);
	while (match !== null) {
		const optionBlock = match[0];
		// Check if this block has setMaxLength and it's required (not autocomplete-only)
		if (
			!optionBlock.includes("setMaxLength") &&
			!optionBlock.includes("setAutocomplete(true)")
		) {
			// Only flag if it's not just an autocomplete field
			if (
				optionBlock.includes("setRequired(true)") ||
				optionBlock.includes("setDescription")
			) {
				violations.push({
					file,
					line: getLineNumber(content, match.index),
					type: "missing_max_length",
					description:
						"SlashCommandStringOption missing .setMaxLength() - should not exceed 256 characters",
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
 * @param content - File content
 * @param file - File path
 * @returns Array of violations found
 */
function checkChoiceLimits(content: string, file: string): Violation[] {
	const violations: Violation[] = [];

	// Pattern: .addChoices([...]) or .setChoices([...])
	const choicePattern = /\.(addChoices|setChoices)\s*\(\s*\[([\s\S]*?)\]\s*\)/g;

	let match: RegExpExecArray | null = choicePattern.exec(content);
	while (match !== null) {
		const choicesArray = match[2];

		// Count choice objects (look for name: or { patterns)
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
 * @param content - File content
 * @param file - File path
 * @returns Array of violations found
 */
function checkSelectMenuLimits(content: string, file: string): Violation[] {
	const violations: Violation[] = [];

	// Pattern: StringSelectMenuBuilder with addOptions or setOptions
	const selectMenuPattern =
		/new\s+StringSelectMenuBuilder\s*\(\s*\)([\s\S]{0,800}?)(?=new\s+\w+Builder|const|let|var|;|\n\n)/g;

	let match: RegExpExecArray | null = selectMenuPattern.exec(content);
	while (match !== null) {
		const menuBlock = match[1];

		// Look for .addOptions([...]) or .setOptions([...])
		const optionsPattern = /\.(addOptions|setOptions)\s*\(\s*\[([\s\S]*?)\]\s*\)/g;
		let optionsMatch: RegExpExecArray | null = optionsPattern.exec(menuBlock);

		while (optionsMatch !== null) {
			const optionsArray = optionsMatch[2];

			// Count option objects
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
 * @returns Analysis results with all violations found
 */
async function analyzeDiscordLimits(): Promise<AnalysisResult> {
	log.info("🔍 Starting Discord API limits analysis...");

	const violations: Violation[] = [];
	const srcPath = join(process.cwd(), "src");
	let filesScanned = 0;

	try {
		const glob = new Glob("**/*.ts");
		for await (const file of glob.scan(srcPath)) {
			// Skip type definition files and test files
			if (file.includes(".d.ts") || file.includes(".test.ts")) {
				continue;
			}

			const filePath = join(srcPath, file);
			try {
				const content = await readFile(filePath, "utf-8");
				filesScanned++;

				// Run all checks
				const stringLengthViolations = checkStringLengthLimits(content, file);
				const choiceViolations = checkChoiceLimits(content, file);
				const selectMenuViolations = checkSelectMenuLimits(content, file);

				violations.push(
					...stringLengthViolations,
					...choiceViolations,
					...selectMenuViolations,
				);
			} catch (readError) {
				log.warn(`Failed to read file: ${file}`, readError);
			}
		}
	} catch (error) {
		log.error("Error scanning source files", error);
		throw error;
	}

	// Count violations by type
	const violationsByType = new Map<ViolationType, number>();
	for (const violation of violations) {
		violationsByType.set(
			violation.type,
			(violationsByType.get(violation.type) || 0) + 1,
		);
	}

	return {
		violations,
		filesScanned,
		violationsByType,
	};
}

/**
 * Formats violation type into a human-readable category
 * @param type - Violation type
 * @returns Formatted category name
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
 * @param results - Analysis results to display
 */
function displayResults(results: AnalysisResult): void {
	console.log(`\n${"=".repeat(80)}`);
	console.log("🔍 DISCORD API LIMITS ANALYSIS RESULTS");
	console.log("=".repeat(80));

	if (results.violations.length > 0) {
		console.log("\n❌ VIOLATIONS FOUND:");
		console.log("-".repeat(60));

		// Group violations by type
		const violationsByType = new Map<ViolationType, Violation[]>();
		for (const violation of results.violations) {
			if (!violationsByType.has(violation.type)) {
				violationsByType.set(violation.type, []);
			}
			violationsByType.get(violation.type)?.push(violation);
		}

		// Display each category
		for (const [type, violations] of violationsByType) {
			console.log(`\n⚠️  ${formatViolationType(type)} (${violations.length}):`);
			for (const violation of violations.sort((a, b) =>
				a.file.localeCompare(b.file),
			)) {
				console.log(`  ❌ ${violation.file}:${violation.line}`);
				console.log(`     ${violation.description}`);
			}
		}
	} else {
		console.log("\n✅ No violations found!");
	}

	// Summary
	console.log("\n📊 SUMMARY:");
	console.log("-".repeat(60));
	console.log(`  • ${results.filesScanned} files scanned`);
	console.log(`  • ${results.violations.length} total violations found`);

	if (results.violationsByType.size > 0) {
		console.log("\n  Breakdown by type:");
		for (const [type, count] of results.violationsByType) {
			console.log(`    - ${formatViolationType(type)}: ${count}`);
		}
	}

	if (results.violations.length === 0) {
		console.log("\n🎉 Perfect! All Discord API limits are respected!");
	} else {
		console.log(
			"\n⚠️  Please fix the violations above to ensure Discord API compliance.",
		);
	}

	console.log(`\n${"=".repeat(80)}`);
}

/**
 * Main execution function
 */
async function main(): Promise<void> {
	try {
		const results = await analyzeDiscordLimits();
		displayResults(results);

		// Exit with error code if violations found (strict mode)
		if (results.violations.length > 0) {
			process.exit(1);
		}
	} catch (error) {
		log.error("Fatal error during Discord limits analysis", error);
		process.exit(1);
	}
}

// Run the script if executed directly
if (import.meta.main) {
	await main();
}
