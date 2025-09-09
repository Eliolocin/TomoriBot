import path from "node:path";
import { Glob } from "bun";
import type {
	LocaleObject,
	Locales,
	LocaleValue,
	LocalizerVariables,
} from "../../types/discord/global";
import { log } from "../misc/logger";

// 1. Initialize locales object
const locales: Locales = {};
let isInitialized = false; // Track initialization state

/**
 * Removes common indentation from multi-line strings.
 * Allows for proper indentation in locale files without affecting output.
 * @param str - The string to dedent
 * @returns The dedented string with common leading whitespace removed
 */
function dedent(str: string): string {
	// If string is empty or has only one line, return it as is
	if (!str || !str.includes("\n")) return str;

	// Split into lines
	const lines = str.split("\n");

	// Find first non-empty line to determine indent pattern
	const firstNonEmptyLine = lines.find((line) => line.trim().length > 0);
	if (!firstNonEmptyLine) return str; // All lines are empty

	// Calculate common indent by counting leading spaces/tabs in first non-empty line
	const match = firstNonEmptyLine.match(/^[ \t]+/);
	if (!match) return str; // No common indent

	const indent = match[0];
	const indentRegex = new RegExp(`^${indent}`);

	// Remove indent from all lines (except completely empty lines)
	return lines
		.map((line) =>
			line.trim().length > 0 ? line.replace(indentRegex, "") : line,
		)
		.join("\n");
}

/**
 * Initialize the localization system by loading all locale files.
 * This must be called and awaited before using the localizer.
 * @returns A promise that resolves when all locale files are loaded
 */
export async function initializeLocalizer(): Promise<void> {
	if (isInitialized) {
		return; // Already initialized
	}

	try {
		// Define the pattern for locale files
		const glob = new Glob("src/locales/*.ts");

		// Use Bun.glob to find all matching files
		for await (const file of glob.scan(".")) {
			// Get the locale name (e.g., 'en-US') from the filename
			const locale: string = path.basename(file, ".ts");
			try {
				// Dynamically import the TypeScript module
				const module = await import(path.resolve(file));
				// Process all strings in the locale object to remove indentation
				const processedLocale = processLocaleStrings(module.default);
				// Assign the default export to the locales object
				locales[locale] = processedLocale as LocaleObject;
				log.info(`Loaded locale module: ${locale} from ${file}`);
			} catch (importError) {
				log.error(`Failed to import locale file: ${file}`, importError, {
					errorType: "LocaleLoadError",
					metadata: { file },
				});
			}
		}

		// Log loaded locales for verification during startup
		if (Object.keys(locales).length > 0) {
			log.success(
				`Successfully loaded locales: [${Object.keys(locales).join(", ")}]`,
			);
			isInitialized = true;
		} else {
			log.warn("No locale files were loaded. Check the src/locales directory.");
			throw new Error("No locale files were loaded");
		}
	} catch (globError) {
		log.error("Error scanning for locale files", globError, {
			errorType: "LocaleLoadError",
		});
		throw globError; // Re-throw to indicate initialization failure
	}
}

/**
 * Recursively processes an object, applying dedent to all string values
 * @param obj - The object containing locale strings
 * @returns A new object with all strings dedented
 */
function processLocaleStrings(obj: unknown): LocaleValue {
	// 1. If it's a string, dedent it
	if (typeof obj === "string") {
		return dedent(obj);
	}

	// 2. If it's an object, process each value recursively
	if (typeof obj === "object" && obj !== null) {
		// Use LocaleObject type to match our type definition
		const result: LocaleObject = {};

		for (const [key, value] of Object.entries(obj)) {
			result[key] = processLocaleStrings(value);
		}

		return result;
	}

	// 3. For any other type (unlikely in locale files), convert to string
	return String(obj);
}

/**
 * Get a localized string for a specific key.
 * @param locale - The locale code (e.g., 'en-US', 'ja').
 * @param key - The key path from the locale object (e.g., 'commands.help.apikey.title').
 * @param variables - Key-value pairs to replace placeholders in the localized string.
 * @returns The localized string, or the key itself if not found.
 */
export const localizer = (
	locale: string,
	key: string,
	variables: LocalizerVariables = {},
): string => {
	// Check if localization system is initialized
	if (!isInitialized) {
		log.warn(`Localization system not initialized when requesting key: ${key}`);
		return key;
	}

	// Determine the locale to use, falling back to 'en-US'
	const fallbackLocale = "en-US";
	// Check if the specific locale exists, otherwise use the fallback
	const usedLocale = locales[locale] ? locale : fallbackLocale;

	// If even the fallback locale isn't loaded, return the key immediately
	if (!locales[usedLocale]) {
		// Log a warning if this happens, as it indicates a loading issue
		log.warn(`Locale '${usedLocale}' not loaded. Returning key: ${key}`);
		return key;
	}

	// 1. Split the key into parts
	const keys: string[] = key.split(".");
	// 2. Start with the top-level object for the used locale
	let translation: unknown = locales[usedLocale];

	// 3. Traverse the locale object using the key parts
	for (const k of keys) {
		if (
			typeof translation !== "object" ||
			translation === null ||
			!Object.hasOwn(translation, k)
		) {
			// If path is invalid, return the key
			return key;
		}
		translation = (translation as Record<string, unknown>)[k];
	}

	// 4. Check if the final value is a string
	if (typeof translation !== "string") {
		return key;
	}

	// 5. Replace placeholders
	let result: string = translation as string;
	for (const [placeholder, value] of Object.entries(variables)) {
		result = result.replace(new RegExp(`{${placeholder}}`, "g"), String(value));
	}

	// 6. Return the final string
	return result;
};

/**
 * Get the list of currently supported/loaded locale codes.
 * This is dynamically determined from the locale files loaded during initialization.
 * @returns Array of supported locale codes (e.g., ['en-US', 'ja'])
 */
export function getSupportedLocales(): string[] {
	// Return empty array if not initialized to avoid errors
	if (!isInitialized) {
		log.warn("Localization system not initialized when requesting supported locales");
		return [];
	}
	
	// Return the dynamic list of loaded locale keys
	return Object.keys(locales);
}
