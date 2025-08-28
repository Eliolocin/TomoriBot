import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { Glob } from "bun";
import { log } from "../src/utils/misc/logger";

/**
 * Interface for tracking key usage statistics
 */
interface KeyUsage {
	key: string;
	files: Set<string>;
}

/**
 * Interface for analysis results
 */
interface AnalysisResult {
	missingKeys: KeyUsage[];
	unusedKeys: KeyUsage[];
	referencedKeys: Set<string>;
	availableKeys: Set<string>;
}

/**
 * Recursively extracts all keys from a nested locale object
 * @param obj - The locale object or nested object
 * @param prefix - Current key path prefix
 * @returns Set of all flattened key paths
 */
function extractKeysFromLocaleObject(obj: unknown, prefix = ""): Set<string> {
	const keys = new Set<string>();

	if (typeof obj === "string") {
		// This is a leaf node, add the key
		if (prefix) {
			keys.add(prefix);
		}
		return keys;
	}

	if (typeof obj === "object" && obj !== null) {
		for (const [key, value] of Object.entries(obj)) {
			const currentPath = prefix ? `${prefix}.${key}` : key;
			const nestedKeys = extractKeysFromLocaleObject(value, currentPath);
			for (const nestedKey of nestedKeys) {
				keys.add(nestedKey);
			}
		}
	}

	return keys;
}

/**
 * Loads all locale files and extracts available keys
 * @returns Set of all available keys across all locales
 */
async function loadAvailableKeys(): Promise<Set<string>> {
	const availableKeys = new Set<string>();
	const localesPath = join(process.cwd(), "src", "locales");

	try {
		const glob = new Glob("*.ts");
		for await (const file of glob.scan(localesPath)) {
			const filePath = join(localesPath, file);
			try {
				// Dynamic import the locale file
				const module = await import(filePath);
				const localeObject = module.default;

				// Extract all keys from this locale
				const keys = extractKeysFromLocaleObject(localeObject);
				for (const key of keys) {
					availableKeys.add(key);
				}

				log.info(`Loaded keys from locale file: ${file}`);
			} catch (importError) {
				log.error(`Failed to import locale file: ${file}`, importError);
			}
		}
	} catch (error) {
		log.error("Error scanning locale files", error);
		throw error;
	}

	return availableKeys;
}

/**
 * Validates if a string is likely a valid localization key
 * @param key - The string to validate
 * @returns True if the string looks like a valid localization key
 */
function isValidLocalizationKey(key: string): boolean {
	// Must have at least 2 dot-separated segments
	const segments = key.split(".");
	if (segments.length < 2) return false;

	// Filter out common false positives
	const falsePositives = [
		// URLs and domains
		/^https?:\/\//i,
		/\.com|\.org|\.net|\.io|\.dev/i,
		// File extensions
		/\.(js|ts|json|css|html|md|txt|yml|yaml)$/i,
		// Version numbers
		/^\d+\.\d+/,
		// Import paths
		/^node:|^@\w+/,
		// Error codes
		/^\d{3}_/,
		// Database/SQL patterns (word boundaries to avoid false positives)
		/\b(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)\b/i,
	];

	for (const pattern of falsePositives) {
		if (pattern.test(key)) return false;
	}

	// Should start with common locale prefixes
	const validPrefixes = [
		"commands", "general", "events", "genai", "functions", 
		"errors", "tool", "config", "teach", "unlearn"
	];
	
	const firstSegment = segments[0];
	if (validPrefixes.includes(firstSegment)) return true;

	// If it has 3+ segments and looks like a locale key structure, allow it
	return segments.length >= 3 && /^[a-zA-Z][a-zA-Z0-9_]*$/.test(firstSegment);
}

/**
 * Extracts localization keys referenced in TypeScript source files
 * @returns Map of referenced keys to files that reference them
 */
async function extractReferencedKeys(): Promise<Map<string, Set<string>>> {
	const referencedKeys = new Map<string, Set<string>>();
	const srcPath = join(process.cwd(), "src");

	// Regex patterns for finding localization keys
	const patterns = [
		// titleKey, descriptionKey, nameKey, labelKey, etc.
		/(?:titleKey|descriptionKey|nameKey|labelKey|modalTitleKey|itemLabelKey):\s*["']([a-zA-Z0-9._]+)["']/g,
		// localizer function calls
		/localizer\s*\(\s*["'][^"']*["']\s*,\s*["']([a-zA-Z0-9._]+)["']/g,
		// Quoted strings that look like localization keys (dot-separated paths)
		/["']([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9_]*){2,})["']/g,
		// Direct key references in ternary operators and assignments
		/[?:]\s*["']([a-zA-Z0-9._]+)["']/g,
	];

	try {
		const glob = new Glob("**/*.ts");
		for await (const file of glob.scan(srcPath)) {
			// Skip locale files
			if (file.includes("locales/")) {
				continue;
			}

			const filePath = join(srcPath, file);
			try {
				const content = await readFile(filePath, "utf-8");

				// Apply all patterns to find keys
				for (const pattern of patterns) {
					let match: RegExpExecArray | null;
					pattern.lastIndex = 0; // Reset regex state
					match = pattern.exec(content);
					while (match !== null) {
						const key = match[1];
						
						// Filter out false positives
						if (isValidLocalizationKey(key)) {
							if (!referencedKeys.has(key)) {
								referencedKeys.set(key, new Set());
							}
							referencedKeys.get(key)?.add(file);
						}
						match = pattern.exec(content);
					}
				}
			} catch (readError) {
				log.warn(`Failed to read file: ${file}`, readError);
			}
		}
	} catch (error) {
		log.error("Error scanning source files", error);
		throw error;
	}

	return referencedKeys;
}

/**
 * Main analysis function
 */
async function analyzeLocalizationKeys(): Promise<AnalysisResult> {
	log.info("🔍 Starting localization key analysis...");

	// Load available keys from locale files
	log.info("📚 Loading available keys from locale files...");
	const availableKeys = await loadAvailableKeys();

	// Extract referenced keys from source code
	log.info("🔎 Scanning source code for referenced keys...");
	const referencedKeysMap = await extractReferencedKeys();
	const referencedKeys = new Set(referencedKeysMap.keys());

	// Find missing keys (referenced but not available)
	const missingKeys: KeyUsage[] = [];
	for (const [key, files] of referencedKeysMap) {
		if (!availableKeys.has(key)) {
			missingKeys.push({ key, files: new Set(files) });
		}
	}

	// Find unused keys (available but not referenced)
	const unusedKeys: KeyUsage[] = [];
	for (const key of availableKeys) {
		if (!referencedKeys.has(key)) {
			unusedKeys.push({ key, files: new Set(["locale files"]) });
		}
	}

	return {
		missingKeys,
		unusedKeys,
		referencedKeys,
		availableKeys,
	};
}

/**
 * Formats and displays the analysis results
 */
function displayResults(results: AnalysisResult): void {
	console.log(`\n${"=".repeat(80)}`);
	console.log("🔍 LOCALIZATION KEY ANALYSIS RESULTS");
	console.log("=".repeat(80));

	// Missing keys section
	if (results.missingKeys.length > 0) {
		console.log("\n❌ MISSING LOCALIZATION KEYS (Referenced but don't exist):");
		console.log("-".repeat(60));
		
		for (const { key, files } of results.missingKeys.sort((a, b) => a.key.localeCompare(b.key))) {
			console.log(`  ❌ ${key}`);
			console.log(`     📁 Used in ${files.size} files: ${Array.from(files).slice(0, 3).join(", ")}${files.size > 3 ? "..." : ""}`);
		}
	} else {
		console.log("\n✅ No missing localization keys found!");
	}

	// Unused keys section
	if (results.unusedKeys.length > 0) {
		console.log("\n🗑️  UNUSED LOCALIZATION KEYS (Exist but never referenced):");
		console.log("-".repeat(60));
		
		for (const { key } of results.unusedKeys.sort((a, b) => a.key.localeCompare(b.key))) {
			console.log(`  ⚠️  ${key}`);
		}
	} else {
		console.log("\n✅ No unused localization keys found!");
	}

	// Summary
	console.log("\n📊 SUMMARY:");
	console.log("-".repeat(60));
	console.log(`  • ${results.availableKeys.size} total keys available in locale files`);
	console.log(`  • ${results.referencedKeys.size} total keys referenced in source code`);
	console.log(`  • ${results.missingKeys.length} missing keys (referenced but don't exist)`);
	console.log(`  • ${results.unusedKeys.length} unused keys (exist but never referenced)`);
	
	if (results.missingKeys.length === 0 && results.unusedKeys.length === 0) {
		console.log("\n🎉 Perfect! Your localization is fully synchronized!");
	}
	
	console.log(`\n${"=".repeat(80)}`);
}

/**
 * Main execution
 */
async function main(): Promise<void> {
	try {
		const results = await analyzeLocalizationKeys();
		displayResults(results);
		
		// Exit with error code if there are issues
		if (results.missingKeys.length > 0 || results.unusedKeys.length > 0) {
			process.exit(1);
		}
	} catch (error) {
		log.error("Fatal error during localization key analysis", error);
		process.exit(1);
	}
}

// Run the script if executed directly
if (import.meta.main) {
	await main();
}