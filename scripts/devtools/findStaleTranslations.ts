import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Glob } from "bun";

/**
 * Lightweight logger (no DB dependency)
 */
const log = {
  info: (msg: string) => console.log(`ℹ️  ${msg}`),
  warn: (msg: string) => console.warn(`⚠️  ${msg}`),
  success: (msg: string) => console.log(`✅ ${msg}`),
};

/**
 * Recursively flattens a nested locale object into dot-notation key → value pairs.
 * Skips array values (e.g. base_trigger_words) as they are locale-specific by design.
 */
function flatten(obj: unknown, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};

  if (typeof obj === "string") {
    if (prefix) result[prefix] = obj;
    return result;
  }

  if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      Object.assign(result, flatten(v, path));
    }
  }

  return result;
}

/**
 * Checks if a string contains predominantly ASCII / Latin characters,
 * which strongly suggests the value was never translated into Japanese.
 * Strings that are entirely emoji, numbers, symbols, or proper nouns
 * (URLs, version strings) are excluded from the "likely English" check.
 */
function looksLikeEnglish(value: string): boolean {
  const stripped = value
    .replace(/\{[^}]+\}/g, "") // remove {placeholders}
    .replace(/https?:\/\/\S+/g, "") // remove URLs
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, "") // remove emoji
    .replace(/[^a-zA-Z\u3000-\u9FFF\uFF00-\uFFEF]/g, "") // keep only letters
    .trim();

  if (stripped.length === 0) return false; // nothing meaningful left

  const latinCount = (stripped.match(/[a-zA-Z]/g) ?? []).length;
  const cjkCount = (stripped.match(/[\u3000-\u9FFF\uFF00-\uFFEF]/g) ?? []).length;

  return latinCount > 0 && cjkCount === 0;
}

/**
 * Identifies values that are intentionally shared between English and Japanese:
 * brand names, emojis/placeholders-only templates, technical option IDs, and
 * sample placeholders such as URLs, model IDs, or prompt tag examples.
 */
function isIntentionallySharedTranslation(key: string, value: string): boolean {
  const stripped = value
    .replace(/\{[^}]+\}/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
    .replace(/[^a-zA-Z\u3000-\u9FFF\uFF00-\uFFEF]/g, "")
    .trim();

  if (stripped.length === 0) {
    return true;
  }

  if (
    /^commands\.help\.api-key\.provider_choice_/.test(key) &&
    key !== "commands.help.api-key.provider_choice_custom"
  ) {
    return true;
  }

  if (key === "commands.tool.visualize.modal.backend_novelai_label") {
    return true;
  }

  if (
    /^commands\.novelai\.image\.params\.sampler_option_/.test(key) ||
    key === "commands.novelai.image.params.noise_schedule_option_karras"
  ) {
    return true;
  }

  if (key.endsWith("_placeholder")) {
    const placeholderPatterns = [
      /^https?:\/\/\S+$/i,
      /^[a-z0-9][a-z0-9._/-]*$/i,
      /^[0-9]+(?:\s*-\s*[0-9]+)?$/,
      /^[a-z0-9_:-]+(?:,\s*[a-z0-9_:-]+)+$/i,
      /^[a-z0-9_][a-z0-9_-]*(?:\s+[a-z0-9_][a-z0-9_-]*)*(?:,\s*[a-z0-9_][a-z0-9_-]*(?:\s+[a-z0-9_][a-z0-9_-]*)*)+$/i,
    ];

    if (placeholderPatterns.some((pattern) => pattern.test(value))) {
      return true;
    }
  }

  return false;
}

export interface StaleEntry {
  key: string;
  en: string;
  ja: string;
  reason: "identical" | "likely_english";
}

/**
 * Loads and merges all category slice files for a locale into a single flat object.
 * The locale directory structure is: src/locales/{locale}/*.ts (category files).
 * Each category file exports a default object whose top-level keys are merged.
 *
 * @returns Merged locale object containing all keys from all category slices
 */
async function loadMergedLocale(localeName: string): Promise<Record<string, unknown>> {
  const localeDir = join(process.cwd(), "src", "locales", localeName);
  const merged: Record<string, unknown> = {};
  const glob = new Glob("*.ts");
  for await (const file of glob.scan(localeDir)) {
    const module = await import(join(localeDir, file));
    Object.assign(merged, module.default);
  }
  return merged;
}

/**
 * Finds keys where the Japanese translation is either identical to the English value
 * (never translated) or contains no CJK characters (still English text).
 * Returns results sorted by key for easy review.
 */
async function findStaleTranslations(): Promise<StaleEntry[]> {
  const enLocale = await loadMergedLocale("en-US");
  const jaLocale = await loadMergedLocale("ja");

  const enFlat = flatten(enLocale);
  const jaFlat = flatten(jaLocale);

  const stale: StaleEntry[] = [];

  for (const [key, enValue] of Object.entries(enFlat)) {
    const jaValue = jaFlat[key];
    if (!jaValue) continue; // missing keys are a parity issue, not a staleness issue

    if (jaValue === enValue) {
      if (isIntentionallySharedTranslation(key, jaValue)) {
        continue;
      }
      stale.push({ key, en: enValue, ja: jaValue, reason: "identical" });
    } else if (looksLikeEnglish(jaValue)) {
      stale.push({ key, en: enValue, ja: jaValue, reason: "likely_english" });
    }
  }

  return stale.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Main entry: two modes:
 *   (default)     Print a compact human-readable review list to the console
 *   --export      Write a JSON file for use with the translation script
 */
async function main(): Promise<void> {
  const doExport = process.argv.includes("--export");

  log.info("Scanning for stale Japanese translations…");
  const stale = await findStaleTranslations();

  const identical = stale.filter((e) => e.reason === "identical");
  const likelyEnglish = stale.filter((e) => e.reason === "likely_english");

  log.info(`Found ${stale.length} potentially stale entries:`);
  log.info(`  • ${identical.length} keys with value identical to English (never translated)`);
  log.info(`  • ${likelyEnglish.length} keys with Japanese value that appears to be English text`);

  if (!doExport) {
    const grouped = new Map<string, StaleEntry[]>();
    for (const entry of stale) {
      const prefix = entry.key.split(".").slice(0, 3).join(".");
      const group = grouped.get(prefix) ?? [];
      group.push(entry);
      grouped.set(prefix, group);
    }

    console.log(`\n${"=".repeat(80)}`);
    console.log("🔍 STALE JAPANESE TRANSLATION REVIEW");
    console.log("=".repeat(80));

    for (const [prefix, entries] of [...grouped.entries()].sort()) {
      console.log(`\n## ${prefix} (${entries.length})`);
      for (const { key, en, ja, reason } of entries) {
        const leaf = key.split(".").slice(3).join(".");
        const tag = reason === "identical" ? "[IDENTICAL]" : "[ENGLISH?]";
        console.log(`  ${tag} .${leaf || key}`);
        console.log(`    EN: ${en.slice(0, 80)}${en.length > 80 ? "…" : ""}`);
        console.log(`    JA: ${ja.slice(0, 80)}${ja.length > 80 ? "…" : ""}`);
      }
    }

    console.log(`\n${"=".repeat(80)}`);
    console.log("Run with --export to write stale-translations.json for batch translation.");
  } else {
    // Export JSON for use by translateStaleLocales.ts
    const outputPath = join(process.cwd(), "scripts", "maintenance", "stale-translations.json");
    await writeFile(outputPath, JSON.stringify(stale, null, 2), "utf-8");
    log.success(`Exported ${stale.length} entries to ${outputPath}`);
    log.info("Review and edit the file to remove entries you do NOT want translated.");
    log.info("Then run: bun run scripts/maintenance/translateStaleLocales.ts");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
