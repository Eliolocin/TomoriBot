/**
 * Shared text-preview convention scanner.
 *
 * Commands that render user-authored text into a Discord message must route it
 * through `buildTextPreview` (`src/utils/text/textPreview.ts`). This module is
 * the single source of truth used by both the CLI validation check and its unit
 * tests, mirroring `personaWorkflowBoundary.ts`.
 *
 * Rule 1: `baked-ellipsis`
 *   A locale string where a `{placeholder}` is immediately followed by `...`.
 *   The ellipsis renders whether or not the value was actually truncated, so it
 *   claims truncation that may never have happened. Signal truncation from the
 *   command side instead, via `textPreviewFooterKey`.
 *
 * Rule 2: `unguarded-fenced-placeholder`
 *   A locale string that interpolates a `{placeholder}` inside a ``` fence,
 *   consumed by a file that does not import `buildTextPreview`. User-authored
 *   text containing its own fence closes the block early and mangles the rest
 *   of the message. `buildTextPreview` neutralizes backtick runs.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Glob } from "bun";

/** The helper every fenced, user-authored placeholder must be routed through. */
export const REQUIRED_HELPER = "buildTextPreview";

/**
 * Every locale audited for rule 1. Both are scanned because `check-locales`
 * enforces key PARITY, not content, so a baked ellipsis added only to `ja` would
 * otherwise pass every gate.
 */
export const AUDITED_LOCALES = ["en-US", "ja"] as const;

/**
 * Pre-existing rule 2 sites, frozen so the guard blocks NEW violations while
 * the backlog stays visible. Remove entries as they are migrated to
 * {@link REQUIRED_HELPER}; do not add to this list.
 */
export const KNOWN_UNGUARDED = new Set([
  "commands.persona.image-tags.success_description",
  "commands.personal.image-tags.success_description",
  "commands.config.image-tags.default-positive.success_description",
  "commands.config.image-tags.default-positive.cleared_description",
  "commands.config.image-tags.default-negative.success_description",
  "commands.config.image-tags.default-negative.cleared_description",
  "commands.novelai.generate.image.error_description",
  "commands.novelai.image.parameters.success_description",
]);

export const TEXT_PREVIEW_REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

/** A placeholder sitting inside a fenced block. */
const FENCED_PLACEHOLDER = /```[\s\S]*?\{[a-zA-Z_][a-zA-Z0-9_]*\}[\s\S]*?```/;
/** A placeholder immediately followed by an ellipsis. */
const BAKED_ELLIPSIS = /\{[a-zA-Z_][a-zA-Z0-9_]*\}(\.\.\.|…)/g;

export type TextPreviewViolationKind = "baked-ellipsis" | "unguarded-fenced-placeholder";

/** One text-preview convention breach. */
export interface TextPreviewViolation {
  kind: TextPreviewViolationKind;
  /** Dotted locale key, prefixed with `[locale]` for rule 1. */
  key: string;
  detail: string;
}

export interface TextPreviewAuditResult {
  violations: TextPreviewViolation[];
  scannedFiles: number;
}

/**
 * Rule 1: scans a single locale string for an unconditional ellipsis.
 *
 * Pure and synchronous so unit tests can exercise it without touching disk.
 *
 */
export function scanBakedEllipsis(key: string, value: string, locale = "en-US"): TextPreviewViolation[] {
  const violations: TextPreviewViolation[] = [];
  // matchAll on a /g regex is stateless per call, so no lastIndex reset needed.
  for (const match of value.matchAll(BAKED_ELLIPSIS)) {
    violations.push({
      kind: "baked-ellipsis",
      key: `[${locale}] ${key}`,
      detail: `renders "${match[0]}" even when nothing was truncated`,
    });
  }
  return violations;
}

/**
 * Reports whether a locale string interpolates a placeholder inside a fence.
 *
 */
export function hasFencedPlaceholder(value: string): boolean {
  return FENCED_PLACEHOLDER.test(value);
}

/**
 * Rule 2: checks that every consumer of a fenced-placeholder key guards it.
 *
 * Keys with no locatable consumer are SKIPPED rather than flagged: some call
 * sites build key names dynamically (e.g. `embed${n}_description`), and a
 * static scan cannot resolve those without false positives.
 *
 */
export function scanFencedPlaceholderUsage(
  key: string,
  value: string,
  sources: Map<string, string>,
): TextPreviewViolation[] {
  if (!hasFencedPlaceholder(value)) return [];
  if (KNOWN_UNGUARDED.has(key)) return [];

  const consumers = [...sources].filter(([, content]) => content.includes(key));
  if (consumers.length === 0) return [];

  return consumers
    .filter(([, content]) => !content.includes(REQUIRED_HELPER))
    .map(([file]) => ({
      kind: "unguarded-fenced-placeholder" as const,
      key,
      detail: `consumed by ${file} without ${REQUIRED_HELPER}`,
    }));
}

/**
 * Loads one locale tree as a single object.
 *
 * @returns The merged locale object across every slice file.
 */
async function loadLocale(locale: string): Promise<Record<string, unknown>> {
  const localeDir = join(TEXT_PREVIEW_REPO_ROOT, "src/locales", locale);
  const files = (await readdir(localeDir)).filter((file) => file.endsWith(".ts"));

  let merged: Record<string, unknown> = {};
  for (const file of files) {
    const module = await import(join(localeDir, file));
    merged = { ...merged, ...(module.default ?? module) };
  }
  return merged;
}

/**
 * Flattens a locale tree into dotted key/value pairs.
 *
 */
export function flattenLocale(node: unknown, path: string[], out: Map<string, string>): void {
  if (typeof node === "string") {
    out.set(path.join("."), node);
    return;
  }
  if (node && typeof node === "object") {
    for (const [segment, child] of Object.entries(node)) flattenLocale(child, [...path, segment], out);
  }
}

/**
 * Runs both rules across the real repository.
 *
 */
export async function auditTextPreview(): Promise<TextPreviewAuditResult> {
  const violations: TextPreviewViolation[] = [];

  // Flatten every audited locale so each string carries its dotted key.
  //    Locales load concurrently because this runs inside `bun run vl`'s shared unit
  //    lane, so avoidable serial I/O lands directly on the critical path.
  const loaded = await Promise.all(
    AUDITED_LOCALES.map(async (locale) => [locale, await loadLocale(locale)] as const),
  );
  const perLocale = new Map<string, Map<string, string>>();
  for (const [locale, tree] of loaded) {
    const flat = new Map<string, string>();
    flattenLocale(tree, [], flat);
    perLocale.set(locale, flat);
  }

  // Rule 1 runs per locale, so a translation must not reintroduce it alone.
  for (const [locale, flat] of perLocale) {
    for (const [key, value] of flat) violations.push(...scanBakedEllipsis(key, value, locale));
  }

  const sourceFiles = (await Array.fromAsync(new Glob("src/**/*.ts").scan(TEXT_PREVIEW_REPO_ROOT))).filter(
    (file) => !file.replaceAll("\\", "/").includes("src/locales/"),
  );
  // Read concurrently because serializing roughly 850 file reads dominates this audit.
  const sources = new Map<string, string>(
    await Promise.all(
      sourceFiles.map(
        async (file) => [file, await readFile(join(TEXT_PREVIEW_REPO_ROOT, file), "utf-8")] as [string, string],
      ),
    ),
  );

  // Rule 2 is structural, so the reference locale alone drives it.
  const reference = perLocale.get(AUDITED_LOCALES[0]) ?? new Map<string, string>();
  for (const [key, value] of reference) violations.push(...scanFencedPlaceholderUsage(key, value, sources));

  return { violations, scannedFiles: sources.size };
}
