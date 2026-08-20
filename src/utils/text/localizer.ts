import path from "node:path";
import { readdir } from "node:fs/promises";
import { Glob } from "bun";
import type { LocaleObject, Locales, LocaleValue, LocalizerVariables } from "../../types/discord/global";
import { log } from "../misc/logger";

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
  if (!str?.includes("\n")) return str;

  const lines = str.split("\n");

  const firstNonEmptyLine = lines.find((line) => line.trim().length > 0);
  if (!firstNonEmptyLine) return str; // All lines are empty

  const match = firstNonEmptyLine.match(/^[ \t]+/);
  if (!match) return str; // No common indent

  const indent = match[0];
  const indentRegex = new RegExp(`^${indent}`);

  return lines.map((line) => (line.trim().length > 0 ? line.replace(indentRegex, "") : line)).join("\n");
}

/**
 * Initialize the localization system by loading all locale files.
 * This must be called and awaited before using the localizer.
 * @returns A promise that resolves when all locale files are loaded
 */
export async function initializeLocalizer(): Promise<void> {
  if (isInitialized) {
    return;
  }

  try {
    const localesDir = path.resolve("src", "locales");
    const entries = await readdir(localesDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const locale = entry.name; // e.g., "en-US", "ja"
      const localeDir = path.join(localesDir, locale);
      const merged: Record<string, unknown> = {};

      const glob = new Glob("*.ts");
      for await (const file of glob.scan(localeDir)) {
        try {
          const module = await import(path.join(localeDir, file));
          const slice = module.default as Record<string, unknown>;

          for (const key of Object.keys(slice)) {
            if (key in merged) {
              log.warn(`Locale "${locale}": duplicate top-level key "${key}" in ${file} — overwriting`);
            }
          }

          Object.assign(merged, slice);
        } catch (importError) {
          log.error(`Failed to import locale slice: ${file}`, importError, {
            errorType: "LocaleLoadError",
            metadata: { locale, file },
          });
        }
      }

      if (Object.keys(merged).length > 0) {
        locales[locale] = processLocaleStrings(merged) as LocaleObject;
        log.info(`Loaded locale: ${locale}`);
      }
    }

    if (Object.keys(locales).length > 0) {
      log.success(`Successfully loaded locales: [${Object.keys(locales).join(", ")}]`);
      isInitialized = true;
    } else {
      log.warn("No locale files were loaded. Check the src/locales directory.");
      throw new Error("No locale files were loaded");
    }
  } catch (error) {
    log.error("Error scanning for locale files", error, {
      errorType: "LocaleLoadError",
    });
    throw error;
  }
}

/**
 * Recursively processes an object, applying dedent to all string values
 * @returns A new object with all strings dedented
 */
function processLocaleStrings(obj: unknown): LocaleValue {
  if (typeof obj === "string") {
    return dedent(obj);
  }

  if (typeof obj === "object" && obj !== null) {
    const result: LocaleObject = {};

    for (const [key, value] of Object.entries(obj)) {
      result[key] = processLocaleStrings(value);
    }

    return result;
  }

  return String(obj);
}

const FALLBACK_LOCALE = "en-US";

/** One `locale:key` per process, so a hot path cannot turn a single gap into a log flood. */
const warnedFallbackKeys = new Set<string>();

/**
 * Walks the loaded tree for `locale` only. Returns `undefined` for an absent path or for a
 * path that lands on a namespace rather than a leaf string, which lets callers tell a real
 * miss apart from a legitimately empty string.
 */
function lookupLocaleString(locale: string, key: string): string | undefined {
  const localeTree = locales[locale];
  if (!localeTree) return undefined;

  let value: unknown = localeTree;
  for (const segment of key.split(".")) {
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, segment)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[segment];
  }

  return typeof value === "string" ? value : undefined;
}

/**
 * Get a localized string for a specific key.
 *
 * Resolution order is the requested locale, then `en-US`, then the key itself. The per-key
 * `en-US` retry is what lets an incomplete locale degrade to English instead of showing users
 * a raw dot-notation path; a key absent from both locales still echoes back, which several
 * callers rely on to detect an unknown key.
 *
 * @param locale - The locale code (e.g., 'en-US', 'ja').
 * @param key - The key path from the locale object (e.g., 'commands.help.features.title').
 * @param variables - Key-value pairs to replace placeholders in the localized string.
 */
export const localizer = (locale: string, key: string, variables: LocalizerVariables = {}): string => {
  if (!isInitialized) {
    log.warn(`Localization system not initialized when requesting key: ${key}`);
    return key;
  }

  const usedLocale = locales[locale] ? locale : FALLBACK_LOCALE;

  if (!locales[usedLocale]) {
    log.warn(`Locale '${usedLocale}' not loaded. Returning key: ${key}`);
    return key;
  }

  let translation = lookupLocaleString(usedLocale, key);

  if (translation === undefined && usedLocale !== FALLBACK_LOCALE) {
    translation = lookupLocaleString(FALLBACK_LOCALE, key);

    if (translation !== undefined) {
      const warnedKey = `${usedLocale}:${key}`;
      if (!warnedFallbackKeys.has(warnedKey)) {
        warnedFallbackKeys.add(warnedKey);
        log.warn(`Locale '${usedLocale}' is missing key '${key}'. Falling back to '${FALLBACK_LOCALE}'.`);
      }
    }
  }

  if (translation === undefined) {
    return key;
  }

  let result: string = translation;
  for (const [placeholder, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`{${placeholder}}`, "g"), String(value));
  }

  return result;
};

/**
 * Get the list of currently supported/loaded locale codes.
 * This is dynamically determined from the locale files loaded during initialization.
 * @returns Array of supported locale codes (e.g., ['en-US', 'ja'])
 */
export function getSupportedLocales(): string[] {
  if (!isInitialized) {
    log.warn("Localization system not initialized when requesting supported locales");
    return [];
  }

  return Object.keys(locales);
}

/**
 * Get the child keys of a locale path that resolve to objects (i.e., sub-namespaces).
 * Useful for dynamically discovering all entries under a locale group (e.g., all reward types).
 * @param locale - The locale code (e.g., 'en-US')
 * @param path - Dot-notation path to the parent object (e.g., 'commands.reward')
 */
export function getLocaleSubKeys(locale: string, path: string): string[] {
  if (!isInitialized || !locales[locale]) return [];

  const keys = path.split(".");
  let obj: unknown = locales[locale];
  for (const k of keys) {
    if (typeof obj !== "object" || obj === null || !Object.hasOwn(obj, k)) {
      return [];
    }
    obj = (obj as Record<string, unknown>)[k];
  }

  if (typeof obj !== "object" || obj === null) return [];

  // Return only keys whose values are objects (sub-namespaces), not leaf strings
  return Object.entries(obj as Record<string, unknown>)
    .filter(([, v]) => typeof v === "object" && v !== null)
    .map(([k]) => k);
}

/**
 * True when `locale` itself defines `key` as a leaf string, with no `en-US` fallback.
 *
 * Callers that build keys dynamically need this because `localizer()`'s return value can no
 * longer answer the question: a miss now yields English rather than the key path, so inspecting
 * the returned string cannot distinguish "this locale defines it" from "English was substituted".
 *
 * @param locale - The locale code (e.g., 'en-US')
 * @param key - Dot-notation path to a leaf string (e.g., 'commands.reward.hug.embed_title')
 */
export function hasLocaleKey(locale: string, key: string): boolean {
  if (!isInitialized) return false;

  return lookupLocaleString(locale, key) !== undefined;
}

/**
 * Uses the localization system to fetch the appropriate bot name based on the server's locale.
 * Falls back to environment variables and hardcoded defaults if locale keys are not found.
 * @param locale - The locale code (e.g., 'en-US', 'ja')
 * @returns The default bot name for the specified locale
 */
export function getDefaultBotName(locale: string): string {
  const localizedName = localizer(locale, "general.defaults.bot_name");

  if (localizedName !== "general.defaults.bot_name") {
    return localizedName;
  }

  // Fallback to environment variables with hardcoded defaults
  // This ensures backward compatibility with existing environment variable configuration
  if (locale === "ja") {
    return process.env.DEFAULT_BOTNAME_JP || "ともり";
  }

  return process.env.DEFAULT_BOTNAME || "Tomori";
}

/**
 * Uses the localization system to fetch locale-appropriate trigger words.
 * Falls back to environment variables and hardcoded defaults if locale keys are not found.
 * @param locale - The locale code (e.g., 'en-US', 'ja')
 * @returns Array of base trigger words for the specified locale
 */
export function getBaseTriggerWords(locale: string): string[] {
  if (!isInitialized) {
    log.warn("Localization system not initialized when requesting base trigger words");
    // Fallback to environment variable or hardcoded defaults
    return (
      process.env.BASE_TRIGGER_WORDS?.split(",").map((word) => word.trim()) || ["tomori", "tomo", "トモリ", "ともり"]
    );
  }

  const fallbackLocale = "en-US";
  const usedLocale = locales[locale] ? locale : fallbackLocale;

  const localeData = locales[usedLocale];
  if (
    localeData &&
    typeof localeData === "object" &&
    "general" in localeData &&
    typeof localeData.general === "object" &&
    localeData.general !== null &&
    "defaults" in localeData.general &&
    typeof localeData.general.defaults === "object" &&
    localeData.general.defaults !== null &&
    "base_trigger_words" in localeData.general.defaults
  ) {
    const triggerWords = (localeData.general.defaults as Record<string, unknown>).base_trigger_words;

    if (Array.isArray(triggerWords) && triggerWords.every((word) => typeof word === "string")) {
      return triggerWords as string[];
    }
  }

  // Fallback to environment variables with hardcoded defaults
  // This ensures backward compatibility with existing environment variable configuration
  return (
    process.env.BASE_TRIGGER_WORDS?.split(",").map((word) => word.trim()) || ["tomori", "tomo", "トモリ", "ともり"]
  );
}
