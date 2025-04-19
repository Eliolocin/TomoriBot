import path from "node:path"; // Still needed for path.basename
import { Glob } from "bun"; // Import Glob for finding files
import type { Locales, LocalizerVariables } from "../types/global";
import { log } from "./logBeautifier";

// 1. Initialize locales object
const locales: Locales = {};
// Define the pattern for locale files relative to the project root
const glob = new Glob("src/locales/*.json");

// 2. Asynchronously load language files using Bun APIs
// We wrap this in an immediately invoked async function to use await at the top level
(async () => {
	// Use Bun.glob to find all matching files
	// Use for...of loop instead of forEach (Biome suggestion)
	for await (const file of glob.scan(".")) {
		// Get the locale name (e.g., 'en') from the filename
		const locale: string = path.basename(file, ".json");
		// Read the file content using Bun.file
		const fileContent = Bun.file(file);
		// Parse the JSON content
		locales[locale] = await fileContent.json();
	}
	// Log loaded locales for verification during startup
	log.success(`Loaded locales: [${Object.keys(locales)}]`);
})();

/**
 * Get a localized string for a specific key.
 * @param locale - The locale code (e.g., 'en', 'ja').
 * @param key - The key path from the JSON files (e.g., 'commands.deposit.success').
 * @param variables - Key-value pairs to replace placeholders in the localized string.
 * @returns The localized string, or the key itself if not found.
 */
const localizer = (
	locale: string,
	key: string,
	variables: LocalizerVariables = {},
): string => {
	// 1. Split the key into parts (e.g., 'tool.ping.description' -> ['tool', 'ping', 'description'])
	const keys: string[] = key.split(".");
	// 2. Start with the top-level object for the requested locale, typed as unknown for safety
	let translation: unknown = locales[locale];

	// 3. Traverse the locale object using the key parts
	for (const k of keys) {
		// Check if the current level is a valid object and contains the next key
		if (
			typeof translation !== "object" || // Ensure it's an object
			translation === null || // Ensure it's not null
			!Object.prototype.hasOwnProperty.call(translation, k) // Ensure the key exists
		) {
			// If the path is invalid, return the original key as a fallback
			return key;
		}
		// Move to the next level, casting to Record<string, unknown> after check
		translation = (translation as Record<string, unknown>)[k];
	}

	// 4. After traversing, check if the final value is a string
	if (typeof translation !== "string") {
		// If the final value isn't a string (e.g., it's an object because the key was too short), return the key
		return key;
	}

	// 5. Replace placeholders like {variable_name} with values from the variables object
	let result: string = translation; // Now we know translation is a string
	// Use for...of for iterating over object entries
	for (const [placeholder, value] of Object.entries(variables)) {
		// Use a RegExp for global replacement just in case a placeholder appears multiple times
		result = result.replace(new RegExp(`{${placeholder}}`, "g"), String(value));
	}

	// 6. Return the final localized and formatted string
	return result;
};

export { localizer };
