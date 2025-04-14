import fs from "fs";
import path from "path";
import { Locales, LocalizerVariables } from "../types/global";

// Load language files dynamically
const locales: Locales = {};
const localesPath: string = path.join(__dirname, "../locales");

// Read all JSON files from locales directory
fs.readdirSync(localesPath)
	.filter((file: string) => file.endsWith(".json"))
	.forEach((file: string) => {
		const locale: string = path.basename(file, ".json");
		locales[locale] = require(`../locales/${file}`);
	});

/**
 * Get a localized string for a specific key.
 * @param locale - The locale code (e.g., 'en', 'ja').
 * @param key - The key path from the JSON files (e.g., 'commands.deposit.success').
 * @param variables - Key-value pairs to replace placeholders in the localized string.
 * @returns The localized string.
 */
const localizer = (
	locale: string,
	key: string,
	variables: LocalizerVariables = {},
): string => {
	const keys: string[] = key.split(".");
	let translation: any = locales[locale];

	for (const k of keys) {
		if (!translation[k]) {
			return key;
		}
		translation = translation[k];
	}

	let result: string = translation;
	for (const [placeholder, value] of Object.entries(variables)) {
		result = result.replace(`{${placeholder}}`, String(value));
	}

	return result;
};

export { localizer };
