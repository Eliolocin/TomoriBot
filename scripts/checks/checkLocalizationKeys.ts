import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { Glob } from "bun";

/**
 * Lightweight logger that doesn't require database connection
 * Avoids circular dependency issues with the main logger
 */
const log = {
  info: (msg: string) => console.log(`ℹ️  ${msg}`),
  warn: (msg: string, error?: unknown) => console.warn(`⚠️  ${msg}`, error ? `| ${error}` : ""),
  error: (msg: string, error?: unknown) => console.error(`❌ ${msg}`, error ? `| ${error}` : ""),
};

/**
 * Interface for tracking key usage statistics
 */
interface KeyUsage {
  key: string;
  files: Set<string>;
}

/**
 * Interface for tracking string length violations
 */
interface _StringLengthViolation {
  key: string;
  value: string;
  length: number;
  files: Set<string>;
}

/**
 * Interface for locale key parity issues
 */
interface LocaleParityIssue {
  key: string;
  missingIn: string[];
  presentIn: string[];
}

/**
 * Interface for modal title length violations
 */
interface ModalTitleViolation {
  key: string;
  value: string;
  length: number;
  locale: string;
}

/**
 * Interface for modal description length violations
 */
interface ModalDescriptionViolation {
  key: string;
  value: string;
  length: number;
  locale: string;
}

/**
 * Interface for command description length violations
 */
interface CommandDescriptionViolation {
  key: string;
  value: string;
  length: number;
  locale: string;
}

/**
 * Discord enforces different length caps for each modal component slot. These are derived
 * from `src/utils/discord/ui/interactionCore.ts` (setLabel → 45, setPlaceholder → 100,
 * setTitle → 45); `descriptionKey` shares the placeholder cap because the code at
 * line 664 truncates it via `description.substring(0, 100)` when no explicit placeholder
 * is supplied.
 */
const MODAL_KIND_LIMITS = {
  title: 45,
  label: 45,
  description: 100,
  placeholder: 100,
  // Discord string-select option fields (`StringSelectMenuOptionBuilder.setLabel`/`setDescription`)
  // both cap at 100 chars. These flow through `label:`/`description:` props inside an `options:`
  // array: objects shaped `{ value, label, description }` with no `customId`/`labelKey`, so the
  // modal-component tracer below misses them. Discord silently truncates overruns in the picker UI.
  optionLabel: 100,
  optionDescription: 100,
} as const;
type ModalKind = keyof typeof MODAL_KIND_LIMITS;

/**
 * Message component slot length limits per Discord UI specification.
 */
const MESSAGE_SLOT_LIMITS = {
  buttonLabel: 80,
  selectPlaceholder: 150,
  optionLabel: 100,
  optionDescription: 100,
} as const;
type MessageSlotKind = keyof typeof MESSAGE_SLOT_LIMITS;

/**
 * A locale key that flows into a message component slot at runtime, traced from source.
 */
interface MessageSlotUsage {
  key: string;
  kind: MessageSlotKind;
  files: Set<string>;
}

/**
 * Length violation for a source-traced message component key.
 */
interface MessageSlotViolation {
  key: string;
  kind: MessageSlotKind;
  maxLength: number;
  value: string;
  length: number;
  locale: string;
  files: Set<string>;
}

/**
 * A locale key that flows into a modal component at runtime, traced from a source file.
 * Tracked per (kind, key) so the same key used as both label and placeholder is reported
 * with both context-specific caps.
 */
interface ModalKeyUsage {
  key: string;
  kind: ModalKind;
  files: Set<string>;
}

/**
 * Length violation for a source-traced modal component key.
 */
interface ModalUsageViolation {
  key: string;
  kind: ModalKind;
  maxLength: number;
  value: string;
  length: number;
  locale: string;
  files: Set<string>;
}

interface ExpectedMetadataKey {
  key: string;
  file: string;
  strict: boolean;
}

/**
 * Interface for analysis results
 */
interface AnalysisResult {
  missingKeys: KeyUsage[];
  unusedKeys: KeyUsage[];
  referencedKeys: Set<string>;
  availableKeys: Set<string>;
  localeKeys: Map<string, Set<string>>;
  parityIssues: LocaleParityIssue[];
  modalTitleViolations: ModalTitleViolation[];
  modalDescriptionViolations: ModalDescriptionViolation[];
  commandDescriptionViolations: CommandDescriptionViolation[];
  modalUsageViolations: ModalUsageViolation[];
  messageSlotViolations: MessageSlotViolation[];
}

/**
 * Recursively extracts all keys from a nested locale object
 */
function extractKeysFromLocaleObject(obj: unknown, prefix = ""): Set<string> {
  const keys = new Set<string>();

  if (typeof obj === "string") {
    if (prefix) {
      keys.add(prefix);
    }
    return keys;
  }

  // Arrays are treated as opaque leaf values (e.g. base_trigger_words: ["tomori", "tomo"]).
  // Recursing into them would generate spurious keys like "general.defaults.base_trigger_words.0"
  // that can never be statically referenced, causing them to be flagged as unused.
  if (Array.isArray(obj)) {
    if (prefix) keys.add(prefix);
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
 * Recursively extracts all string values and their lengths from a nested locale object
 * @param maxLength - Maximum allowed string length (default: 99 for Discord modal limit)
 */
function _extractStringLengthViolations(
  obj: unknown,
  prefix = "",
  maxLength = 99,
): Map<string, { value: string; length: number }> {
  const violations = new Map<string, { value: string; length: number }>();

  if (typeof obj === "string") {
    if (prefix && obj.length >= maxLength) {
      violations.set(prefix, { value: obj, length: obj.length });
    }
    return violations;
  }

  if (typeof obj === "object" && obj !== null) {
    for (const [key, value] of Object.entries(obj)) {
      const currentPath = prefix ? `${prefix}.${key}` : key;
      const nestedViolations = _extractStringLengthViolations(value, currentPath, maxLength);
      for (const [nestedKey, violation] of nestedViolations) {
        violations.set(nestedKey, violation);
      }
    }
  }

  return violations;
}

/**
 * Loads all locale files and extracts available keys
 */
async function loadAvailableKeys(): Promise<{
  availableKeys: Set<string>;
  localeKeys: Map<string, Set<string>>;
}> {
  const availableKeys = new Set<string>();
  const localeKeys = new Map<string, Set<string>>();
  const localesPath = join(process.cwd(), "src", "locales");

  try {
    const entries = await readdir(localesPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const localeName = entry.name; // e.g., "en-US", "ja"
      const localeDir = join(localesPath, localeName);
      const merged: Record<string, unknown> = {};

      const glob = new Glob("*.ts");
      for await (const file of glob.scan(localeDir)) {
        const filePath = join(localeDir, file);
        try {
          const module = await import(filePath);
          Object.assign(merged, module.default);
        } catch (importError) {
          log.error(`Failed to import locale slice: ${localeName}/${file}`, importError);
        }
      }

      const keys = extractKeysFromLocaleObject(merged);
      localeKeys.set(localeName, keys);

      for (const key of keys) {
        availableKeys.add(key);
      }

      log.info(`Loaded ${keys.size} keys from locale: ${localeName}`);
    }
  } catch (error) {
    log.error("Error scanning locale files", error);
    throw error;
  }

  return { availableKeys, localeKeys };
}

/**
 * Escapes a string for use in a regular expression
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Validates if a string is likely a valid localization key
 */
function isValidLocalizationKey(key: string): boolean {
  const segments = key.split(".");
  if (segments.length < 2) return false;

  const templatePatterns = [
    /^category\./i, // "category.group.subcommand"
    /^example\./i, // "example.key.path"
    /^placeholder\./i, // "placeholder.text"
    /^template\./i, // "template.string"
    /\.placeholder$/i, // "something.placeholder"
  ];

  for (const pattern of templatePatterns) {
    if (pattern.test(key)) return false;
  }

  const falsePositives = [
    /^https?:\/\//i,
    /^(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev)(?:\/|$)/i,
    /\.(js|ts|json|css|html|md|txt|yml|yaml)$/i,
    /^\d+\.\d+/,
    /^node:|^@\w+/,
    /^\d{3}_/,
    // Database/SQL patterns - require whole SQL keywords so locale keys like
    // "commands.data.delete.success_personal_settings_title" are not rejected.
    /\b(?:SELECT|INSERT|UPDATE|DELETE)\b[\s\S]*\b(?:FROM|WHERE|INTO|SET)\b/i,
    // Panel action telemetry keys (<surface>.<scope>.<resource>.<verb>). The surface is anchored to the
    // known panel list because "workspace|personal" alone also matches real keys such as
    // "commands.personal.stm.description", which would exempt the whole commands.personal namespace from
    // validation. A new panel surface that omits itself here fails loudly as a missing key.
    /^(?:mcps|st-presets|providers|moderation|personal-memories|personal-config|server-config|memories)\.(?:workspace|personal)\.[a-z0-9-]+\.[a-z0-9-]+$/,
  ];

  for (const pattern of falsePositives) {
    if (pattern.test(key)) return false;
  }

  // Must start with a known top-level locale prefix
  // This list is derived from the top-level keys in the locale files, so
  // update it whenever a new top-level namespace is added to the locale object
  const validPrefixes = [
    "commands",
    "general",
    "events",
    "genai",
    "rate_limit",
    "reminders",
    "tools",
    "matrix",
    // Legacy / sub-namespace prefixes still referenced in source
    "functions",
    "errors",
    "tool",
    "config",
    "teach",
    "forget",
  ];

  const firstSegment = segments[0];
  if (validPrefixes.includes(firstSegment)) return true;

  return segments.length >= 3 && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(firstSegment);
}

/**
 * Checks if a localization key is used for a modal title
 */
function isModalTitleKey(key: string): boolean {
  return key.endsWith(".modal_title") || key.endsWith(".modal.title");
}

/**
 * Checks if a localization key is used for a modal description
 */
function isModalDescriptionKey(key: string): boolean {
  // Pattern 1: *.modal_description (bare leaf)
  // Pattern 2: *.{field}_modal_description (field-scoped leaf, e.g. prompt_modal_description)
  // Pattern 3: *.modal.{field}_description (nested under a `modal` sub-object)
  return /(?:[._])modal_description$|\.modal\.[a-z_]+_description$/.test(key);
}

/**
 * Checks if a localization key is used for a command description
 */
function isCommandDescriptionKey(key: string): boolean {
  // Pattern: commands.*.*.command_description or commands.*.*.*.command_description
  // Examples: commands.help.memory.command_description, commands.teach.memory.personal.command_description
  return /^commands\.[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+\.command_description$/.test(key);
}

function getLocalizationAliases(key: string): string[] {
  const aliases: string[] = [];

  const staticAliases: Record<string, string> = {
    "commands.memory.description": "commands.teach.memory.description",
    "commands.conditioning.reward.description": "commands.reward.description",
    "commands.conditioning.punish.description": "commands.punish.description",
    "commands.persona.attribute.description": "commands.teach.attribute.description",
    "commands.persona.sample-dialogue.description": "commands.teach.sampledialogue.description",
    "commands.persona.prompt.description": "commands.teach.personaprompt.description",
    "commands.memory.document.description": "commands.teach.document.description",
    "commands.memory.personal.description": "commands.teach.memory.personal.description",
    "commands.memory.server.description": "commands.teach.memory.server.description",
    "commands.persona.attribute.add.description": "commands.teach.attribute.description",
    "commands.persona.attribute.remove.description": "commands.forget.attribute.description",
    "commands.persona.sample-dialogue.add.description": "commands.teach.sampledialogue.description",
    "commands.persona.sample-dialogue.remove.description": "commands.forget.sampledialogue.description",
    "commands.persona.prompt.set.description": "commands.teach.personaprompt.description",
    "commands.persona.prompt.remove.description": "commands.forget.personaprompt.description",
    "commands.memory.document.add.description": "commands.teach.document.description",
    "commands.memory.document.remove.description": "commands.forget.document.description",
    "commands.memory.personal.add.description": "commands.teach.memory.personal.description",
    "commands.memory.personal.remove.description": "commands.forget.memory.personal.description",
    "commands.memory.server.add.description": "commands.teach.memory.server.description",
    "commands.memory.server.remove.description": "commands.forget.memory.server.description",
  };

  const staticAlias = staticAliases[key];
  if (staticAlias) {
    aliases.push(staticAlias);
  }

  const pathAliases: Record<string, string> = {
    "commands.config.bot-permissions.description": "commands.config.permissions.description",
    "commands.config.send-limit.description": "commands.config.sendlimit.description",
    "commands.server.always-reply.description": "commands.server.alwaysreply.description",
    "commands.server.deliberate-trigger-mode.description": "commands.server.deliberatetriggermode.description",
    "commands.personal.deliberate-trigger-mode.description": "commands.personal.deliberatetriggermode.description",
    "commands.config.model-fallback.remove.description": "commands.config.remove.modelfallback.description",
    "commands.tool.status.description": "commands.status.description",
  };
  const pathAlias = pathAliases[key];
  if (pathAlias) {
    aliases.push(pathAlias);
  }

  const systemPromptMatch = key.match(/^commands\.config\.system-prompt\.(set|remove|preset)\.description$/);
  if (systemPromptMatch) {
    const aliasByAction: Record<string, string> = {
      set: "commands.config.prompt.change.command_description",
      remove: "commands.config.prompt.clear.command_description",
      preset: "commands.config.prompt.preset.command_description",
    };
    aliases.push(aliasByAction[systemPromptMatch[1]]);
  }

  const conditioningMatch = key.match(
    /^commands\.conditioning\.(reward|punish)\.([a-z0-9-]+)\.(description|reason_description)$/,
  );
  if (conditioningMatch) {
    const [, type, actionKey, suffix] = conditioningMatch;
    aliases.push(`commands.${type}.${actionKey}.${suffix}`);
  }

  return aliases;
}

function resolveLocalizationKey(key: string, availableKeys: Set<string>): string | null {
  if (availableKeys.has(key)) {
    return key;
  }

  for (const alias of getLocalizationAliases(key)) {
    if (availableKeys.has(alias)) {
      return alias;
    }
  }

  return null;
}

/**
 * Recursively extracts string values from a nested locale object
 */
function extractStringValues(obj: unknown, prefix = ""): Map<string, string> {
  const values = new Map<string, string>();

  if (typeof obj === "string") {
    if (prefix) {
      values.set(prefix, obj);
    }
    return values;
  }

  // Arrays are opaque leaf values, so skip recursion to avoid index keys like "key.0", "key.1"
  if (Array.isArray(obj)) return values;

  if (typeof obj === "object" && obj !== null) {
    for (const [key, value] of Object.entries(obj)) {
      const currentPath = prefix ? `${prefix}.${key}` : key;
      const nestedValues = extractStringValues(value, currentPath);
      for (const [nestedKey, nestedValue] of nestedValues) {
        values.set(nestedKey, nestedValue);
      }
    }
  }

  return values;
}

/**
 * Loads and merges all category slice files for a locale into one locale object.
 * Replaces direct imports of the old monolithic `{locale}.ts` files.
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

async function checkModalTitleLengths(localeKeys: Map<string, Set<string>>): Promise<ModalTitleViolation[]> {
  const violations: ModalTitleViolation[] = [];

  // Discord modal title constraints
  const MIN_LENGTH = 5;
  const MAX_LENGTH = 45;

  for (const [localeName, keys] of localeKeys) {
    const modalTitleKeys = Array.from(keys).filter(isModalTitleKey);

    if (modalTitleKeys.length === 0) continue;

    try {
      const localeObject = await loadMergedLocale(localeName);
      const stringValues = extractStringValues(localeObject);

      for (const key of modalTitleKeys) {
        const value = stringValues.get(key);
        if (!value) continue;

        const length = value.length;

        if (length < MIN_LENGTH || length > MAX_LENGTH) {
          violations.push({
            key,
            value,
            length,
            locale: localeName,
          });
        }
      }
    } catch (error) {
      log.error(`Failed to check modal titles in locale: ${localeName}`, error);
    }
  }

  return violations;
}

async function checkModalDescriptionLengths(
  localeKeys: Map<string, Set<string>>,
): Promise<ModalDescriptionViolation[]> {
  const violations: ModalDescriptionViolation[] = [];

  // Discord modal placeholder constraint: `setPlaceholder` accepts up to 100 chars.
  // Anything beyond is silently truncated by `interactionCore.ts` via `substring(0, 100)`,
  // so we treat >100 as a hard violation rather than allowing a smaller safety margin.
  const MAX_LENGTH = 100;

  for (const [localeName, keys] of localeKeys) {
    const modalDescriptionKeys = Array.from(keys).filter(isModalDescriptionKey);

    if (modalDescriptionKeys.length === 0) continue;

    try {
      const localeObject = await loadMergedLocale(localeName);
      const stringValues = extractStringValues(localeObject);

      for (const key of modalDescriptionKeys) {
        const value = stringValues.get(key);
        if (!value) continue;

        const length = value.length;

        // Check if length violates Discord constraint (only max, no min)
        if (length > MAX_LENGTH) {
          violations.push({
            key,
            value,
            length,
            locale: localeName,
          });
        }
      }
    } catch (error) {
      log.error(`Failed to check modal descriptions in locale: ${localeName}`, error);
    }
  }

  return violations;
}

/**
 * Walks backward from `idx` to find the nearest unmatched `{` and forward to its matching `}`.
 * Used to scope-confine modal-component property lookups so we don't accidentally pick up
 * sibling properties from adjacent object literals on the page.
 *
 * Caveat: a naive character-by-character brace counter doesn't strip braces inside strings,
 * template literals, or comments. In practice this is safe for modal field specs because
 * locale keys are short dot-separated identifiers (no embedded braces), and the surrounding
 * TS code in command files keeps each modal field on its own object literal block.
 */
function findEnclosingObjectRange(content: string, idx: number): { start: number; end: number } | null {
  let depth = 0;
  let start = -1;
  for (let i = idx - 1; i >= 0; i--) {
    const ch = content[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start === -1) return null;

  depth = 0;
  for (let i = start; i < content.length; i++) {
    const ch = content[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  return null;
}

/**
 * Source-traces locale keys that flow into Discord modal components at runtime. Unlike
 * the name-pattern checks above (`isModalDescriptionKey`, etc.), this scanner identifies
 * keys by their *usage*, finding object literals that match the `ModalComponent` shape
 * from `src/types/discord/modal.ts`, and binds each key to its Discord cap based on the
 * prop it's assigned to.
 *
 * Detection rules:
 * 1. `modalTitleKey: "literal"` anywhere → title (cap 45). Prop name is unambiguous;
 *    no scope confinement needed.
 * 2. Object literal that contains both `customId:` and `labelKey:` props at the same
 *    scope level → it's a `ModalComponent` per the type union. Within that literal:
 *    - `labelKey: "literal"` → label (cap 45)
 *    - `descriptionKey: "literal"` → description (cap 100; truncated as placeholder)
 *    - `placeholder: "commands.*"` → placeholder (cap 100; only `commands.*` literals
 *      are treated as locale keys, matching the runtime check at interactionCore.ts:671-674)
 * 3. String-select option object: `label: localizer(locale, "literal")` whose enclosing
 *    literal also has a `value:` prop (the `{ value, label, description }` shape). These are
 *    the checkbox/select choices rendered inside modals and message components. Within it:
 *    - `label: localizer(…, "literal")` → optionLabel (cap 100)
 *    - `description: localizer(…, "literal")` → optionDescription (cap 100)
 *    The `value:` sibling requirement excludes button literals (`{ customId, label }`), whose
 *    `label` carries a different (80-char) cap.
 */
async function extractModalComponentUsages(): Promise<Map<string, ModalKeyUsage>> {
  const usages = new Map<string, ModalKeyUsage>();
  const srcPath = join(process.cwd(), "src");

  // Composite-key map so the same locale key tracked as both `label` and `placeholder`
  // produces two independent usage entries (each with its own cap).
  const add = (key: string, kind: ModalKind, file: string): void => {
    const compositeKey = `${kind}::${key}`;
    let entry = usages.get(compositeKey);
    if (!entry) {
      entry = { key, kind, files: new Set() };
      usages.set(compositeKey, entry);
    }
    entry.files.add(file);
  };

  const glob = new Glob("**/*.ts");
  for await (const file of glob.scan(srcPath)) {
    if (file.includes("locales/")) continue;

    const filePath = join(srcPath, file);
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    // modalTitleKey is unambiguous no enclosing-scope check needed.
    const titlePattern = /\bmodalTitleKey\s*:\s*["']([a-zA-Z0-9._-]+)["']/g;
    let titleMatch: RegExpExecArray | null = titlePattern.exec(content);
    while (titleMatch !== null) {
      add(titleMatch[1], "title", file);
      titleMatch = titlePattern.exec(content);
    }

    // Modal field components: discriminator is an object literal with both `customId:` and `labelKey:`.
    // Iterate each customId occurrence, scope-confine to its enclosing object, then inspect siblings.
    const customIdPattern = /\bcustomId\s*:/g;
    let customIdMatch: RegExpExecArray | null = customIdPattern.exec(content);
    while (customIdMatch !== null) {
      const range = findEnclosingObjectRange(content, customIdMatch.index);
      if (range) {
        const obj = content.substring(range.start, range.end);

        const labelMatch = obj.match(/\blabelKey\s*:\s*["']([a-zA-Z0-9._-]+)["']/);
        if (labelMatch) {
          add(labelMatch[1], "label", file);

          const descMatch = obj.match(/\bdescriptionKey\s*:\s*["']([a-zA-Z0-9._-]+)["']/);
          if (descMatch) add(descMatch[1], "description", file);

          // Only `commands.*` placeholders are locale keys per interactionCore.ts:671-674;
          // anything else is a literal display string and out of scope for this check.
          const placeholderMatch = obj.match(/\bplaceholder\s*:\s*["'](commands\.[a-zA-Z0-9._-]+)["']/);
          if (placeholderMatch) add(placeholderMatch[1], "placeholder", file);
        }
      }
      customIdMatch = customIdPattern.exec(content);
    }

    // String-select option fields: anchor on `label: localizer(…, "key")`, then confirm the
    // enclosing literal is an option (has a `value:` sibling) rather than a button. Both the
    // option label and its `description: localizer(…)` cap at 100 chars in Discord's picker.
    const optionLabelPattern = /\blabel\s*:\s*localizer\s*\([^,]+,\s*["']([a-zA-Z0-9._-]+)["']/g;
    let optionLabelMatch: RegExpExecArray | null = optionLabelPattern.exec(content);
    while (optionLabelMatch !== null) {
      const range = findEnclosingObjectRange(content, optionLabelMatch.index);
      if (range) {
        const obj = content.substring(range.start, range.end);

        // `value:` sibling marks a select option ({ value, label, description }); buttons
        // ({ customId, label }) lack it and carry a different cap, so they stay out of scope.
        if (/\bvalue\s*:/.test(obj)) {
          add(optionLabelMatch[1], "optionLabel", file);

          const optionDescMatch = obj.match(/\bdescription\s*:\s*localizer\s*\([^,]+,\s*["']([a-zA-Z0-9._-]+)["']/);
          if (optionDescMatch) add(optionDescMatch[1], "optionDescription", file);
        }
      }
      optionLabelMatch = optionLabelPattern.exec(content);
    }
  }

  return usages;
}

/**
 * Resolves each traced modal usage against the locale strings and flags any whose value
 * exceeds the Discord cap for its slot. Skips keys missing from a locale because the parity
 * check already covers those.
 */
async function checkModalComponentUsageLengths(
  usages: Map<string, ModalKeyUsage>,
  localeKeys: Map<string, Set<string>>,
): Promise<ModalUsageViolation[]> {
  const violations: ModalUsageViolation[] = [];

  for (const [localeName, keysInLocale] of localeKeys) {
    let stringValues: Map<string, string>;
    try {
      const localeObject = await loadMergedLocale(localeName);
      stringValues = extractStringValues(localeObject);
    } catch (error) {
      log.error(`Failed to load locale for modal usage check: ${localeName}`, error);
      continue;
    }

    for (const usage of usages.values()) {
      const resolved = resolveLocalizationKey(usage.key, keysInLocale) ?? usage.key;
      const value = stringValues.get(resolved);
      if (!value) continue;

      const maxLength = MODAL_KIND_LIMITS[usage.kind];
      if (value.length > maxLength) {
        violations.push({
          key: usage.key,
          kind: usage.kind,
          maxLength,
          value,
          length: value.length,
          locale: localeName,
          files: new Set(usage.files),
        });
      }
    }
  }

  return violations;
}

/**
 * Source-traces direct single-key localized strings flowing into message components:
 * button labels, select placeholders, and select option labels and descriptions.
 *
 * Scope boundary: this scanner inspects only direct single-key slots (plain localizer calls).
 * It cannot see composed or interpolated text, so it proves nothing about runtime concatenation;
 * rendered payload integration tests remain the authority for composed text and message totals.
 * Any slot whose argument is not a single literal key is skipped to avoid false positive assumptions.
 */
export async function extractMessageComponentUsages(): Promise<Map<string, MessageSlotUsage>> {
  const usages = new Map<string, MessageSlotUsage>();
  const srcPath = join(process.cwd(), "src");

  const add = (key: string, kind: MessageSlotKind, file: string): void => {
    const compositeKey = `${kind}::${key}`;
    let entry = usages.get(compositeKey);
    if (!entry) {
      entry = { key, kind, files: new Set() };
      usages.set(compositeKey, entry);
    }
    entry.files.add(file);
  };

  const glob = new Glob("**/*.ts");
  for await (const file of glob.scan(srcPath)) {
    if (file.includes("locales/")) continue;

    const filePath = join(srcPath, file);
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    const setLabelPattern = /\.setLabel\s*\(\s*localizer\s*\([^,]+,\s*["']([a-zA-Z0-9._-]+)["']\s*\)\)/g;
    let setLabelMatch: RegExpExecArray | null = setLabelPattern.exec(content);
    while (setLabelMatch !== null) {
      add(setLabelMatch[1], "buttonLabel", file);
      setLabelMatch = setLabelPattern.exec(content);
    }

    const setPlaceholderPattern = /\.setPlaceholder\s*\(\s*localizer\s*\([^,]+,\s*["']([a-zA-Z0-9._-]+)["']\s*\)\)/g;
    let setPlaceholderMatch: RegExpExecArray | null = setPlaceholderPattern.exec(content);
    while (setPlaceholderMatch !== null) {
      add(setPlaceholderMatch[1], "selectPlaceholder", file);
      setPlaceholderMatch = setPlaceholderPattern.exec(content);
    }

    const labelPattern = /\blabel\s*:\s*localizer\s*\([^,]+,\s*["']([a-zA-Z0-9._-]+)["']/g;
    let labelMatch: RegExpExecArray | null = labelPattern.exec(content);
    while (labelMatch !== null) {
      const range = findEnclosingObjectRange(content, labelMatch.index);
      if (range) {
        const obj = content.substring(range.start, range.end);
        if (/\bvalue\s*:/.test(obj)) {
          add(labelMatch[1], "optionLabel", file);
        } else if (/\bcustomId\s*:|\burl\s*:|\bstyle\s*:|\btype\s*:/.test(obj)) {
          add(labelMatch[1], "buttonLabel", file);
        }
      }
      labelMatch = labelPattern.exec(content);
    }

    const descriptionPattern = /\bdescription\s*:\s*localizer\s*\([^,]+,\s*["']([a-zA-Z0-9._-]+)["']/g;
    let descriptionMatch: RegExpExecArray | null = descriptionPattern.exec(content);
    while (descriptionMatch !== null) {
      const range = findEnclosingObjectRange(content, descriptionMatch.index);
      if (range) {
        const obj = content.substring(range.start, range.end);
        if (/\bvalue\s*:/.test(obj)) {
          add(descriptionMatch[1], "optionDescription", file);
        }
      }
      descriptionMatch = descriptionPattern.exec(content);
    }

    const placeholderPattern = /\bplaceholder\s*:\s*localizer\s*\([^,]+,\s*["']([a-zA-Z0-9._-]+)["']/g;
    let placeholderMatch: RegExpExecArray | null = placeholderPattern.exec(content);
    while (placeholderMatch !== null) {
      const range = findEnclosingObjectRange(content, placeholderMatch.index);
      if (range) {
        const obj = content.substring(range.start, range.end);
        if (!/\blabelKey\s*:/.test(obj) && /\boptions\s*:|\bcustomId\s*:|\btype\s*:/.test(obj)) {
          add(placeholderMatch[1], "selectPlaceholder", file);
        }
      }
      placeholderMatch = placeholderPattern.exec(content);
    }
  }

  return usages;
}

/**
 * Validates each traced message component slot against the Discord ceiling for its kind.
 * Skips missing keys because locale parity already reports those.
 */
export async function checkMessageComponentUsageLengths(
  usages: Map<string, MessageSlotUsage>,
  localeKeys: Map<string, Set<string>>,
): Promise<MessageSlotViolation[]> {
  const violations: MessageSlotViolation[] = [];

  for (const [localeName, keysInLocale] of localeKeys) {
    let stringValues: Map<string, string>;
    try {
      const localeObject = await loadMergedLocale(localeName);
      stringValues = extractStringValues(localeObject);
    } catch (error) {
      log.error(`Failed to load locale for message component usage check: ${localeName}`, error);
      continue;
    }

    for (const usage of usages.values()) {
      const resolved = resolveLocalizationKey(usage.key, keysInLocale) ?? usage.key;
      const value = stringValues.get(resolved);
      if (!value) continue;

      const maxLength = MESSAGE_SLOT_LIMITS[usage.kind];
      if (value.length > maxLength) {
        violations.push({
          key: usage.key,
          kind: usage.kind,
          maxLength,
          value,
          length: value.length,
          locale: localeName,
          files: new Set(usage.files),
        });
      }
    }
  }

  return violations;
}

async function checkCommandDescriptionLengths(
  localeKeys: Map<string, Set<string>>,
): Promise<CommandDescriptionViolation[]> {
  const violations: CommandDescriptionViolation[] = [];

  // Discord command description constraints
  const MIN_LENGTH = 1;
  const MAX_LENGTH = 100;

  for (const [localeName, keys] of localeKeys) {
    const commandDescriptionKeys = Array.from(keys).filter(isCommandDescriptionKey);

    if (commandDescriptionKeys.length === 0) continue;

    try {
      const localeObject = await loadMergedLocale(localeName);
      const stringValues = extractStringValues(localeObject);

      for (const key of commandDescriptionKeys) {
        const value = stringValues.get(key);
        if (!value) continue;

        const length = value.length;

        if (length < MIN_LENGTH || length > MAX_LENGTH) {
          violations.push({
            key,
            value,
            length,
            locale: localeName,
          });
        }
      }
    } catch (error) {
      log.error(`Failed to check command descriptions in locale: ${localeName}`, error);
    }
  }

  return violations;
}

/**
 * Checks if a string appears in a Set declaration context
 */
function isInSetDeclaration(content: string, matchIndex: number): boolean {
  const lookbackDistance = 300;
  const beforeMatch = content.substring(Math.max(0, matchIndex - lookbackDistance), matchIndex);

  const setPatterns = [
    /new\s+Set\s*<[^>]*>\s*\(\s*\[[\s\S]*$/, // new Set<T>([...
    /new\s+Set\s*\(\s*\[[\s\S]*$/, // new Set([...
    /Set\s*<[^>]*>\s*\(\s*\[[\s\S]*$/, // Set<T>([...
    /Set\s*\(\s*\[[\s\S]*$/, // Set([...
    /=\s*new\s+Set\s*<[^>]*>\s*\(\s*\[[\s\S]*$/, // = new Set<T>([...
    /=\s*new\s+Set\s*\(\s*\[[\s\S]*$/, // = new Set([...
  ];

  for (const pattern of setPatterns) {
    if (pattern.test(beforeMatch)) {
      // Additional check: make sure we're still inside the array (no closing ])
      const afterSetDecl = beforeMatch.match(pattern)?.[0] || "";
      const openBrackets = (afterSetDecl.match(/\[/g) || []).length;
      const closeBrackets = (afterSetDecl.match(/\]/g) || []).length;

      if (openBrackets > closeBrackets) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Extracts dynamic template literal keys from file content
 */
function extractDynamicTemplateKeys(content: string, availableKeys: Set<string>): string[] {
  const matchedKeys: string[] = [];

  // Matches patterns like: `commands.server.avatar.${errorKey}`
  const templatePattern =
    /(?:titleKey|descriptionKey|nameKey|labelKey|modalTitleKey|itemLabelKey):\s*`([a-zA-Z][a-zA-Z0-9._-]*)\$\{([^}]+)\}([a-zA-Z0-9._-]*)`/g;

  let match = templatePattern.exec(content);
  while (match !== null) {
    const prefix = match[1]; // e.g., "commands.server.avatar."
    const variable = match[2]; // e.g., "errorKey"
    const suffix = match[3]; // e.g., "" (empty in most cases)

    // Extract the variable name (strip any property access, array indexing, or nullish coalesce)
    // e.g. `userData.personal_dtm ?? "follow"` -> base variable is the whole expression's first ident
    const variableName = variable.split(/[.[\s?]/)[0];

    // Look for literal values bound to this variable through any of: assignment, nullish coalesce,
    // addChoices({ value: "literal" }) options on slash commands, or simple = / === comparisons.
    for (const assignedValue of resolveAssignedStringValues(content, variableName)) {
      const fullKey = `${prefix}${assignedValue}${suffix}`;
      if (availableKeys.has(fullKey)) matchedKeys.push(fullKey);
    }

    for (const literal of extractNullishFallbackLiterals(variable)) {
      const fullKey = `${prefix}${literal}${suffix}`;
      if (availableKeys.has(fullKey)) matchedKeys.push(fullKey);
    }

    match = templatePattern.exec(content);
  }

  return matchedKeys;
}

// Pulls "follow" out of expressions like `userData.personal_dtm ?? "follow"`.
// Lets dynamic keys whose only literal source is the fallback survive pruning.
function extractNullishFallbackLiterals(variableExpression: string): string[] {
  const literals: string[] = [];
  const pattern = /\?\?\s*["'`]([a-zA-Z0-9._-]+)["'`]/g;
  let match = pattern.exec(variableExpression);
  while (match !== null) {
    literals.push(match[1]);
    match = pattern.exec(variableExpression);
  }
  return literals;
}

/**
 * Resolves simple string assignments for a variable in the current file.
 * Supports both direct string literals and concatenated string literals like:
 *   const keyBase = "commands.config" + ".provider.switch";
 * This specifically protects dynamic locale namespaces used by commands like
 * /config provider switch, where `${keyBase}.restored_label` would otherwise
 * look unused and get pruned even though it is rendered at runtime.
 */
function resolveAssignedStringValues(content: string, variableName: string): string[] {
  const resolvedValues = new Set<string>();
  const safeVar = escapeRegExp(variableName);

  const directAssignmentPattern = new RegExp(`${safeVar}\\s*=\\s*["']([a-zA-Z0-9._-]+)["']`, "g");
  let directMatch = directAssignmentPattern.exec(content);
  while (directMatch !== null) {
    resolvedValues.add(directMatch[1]);
    directMatch = directAssignmentPattern.exec(content);
  }

  const concatAssignmentPattern = new RegExp(
    `${safeVar}\\s*=\\s*((?:["'][^"']*["']\\s*\\+\\s*)+["'][^"']*["'])`,
    "g",
  );
  let concatMatch = concatAssignmentPattern.exec(content);
  while (concatMatch !== null) {
    const expression = concatMatch[1];
    const parts = Array.from(expression.matchAll(/["']([^"']*)["']/g)).map((part) => part[1]);
    if (parts.length > 0) {
      resolvedValues.add(parts.join(""));
    }
    concatMatch = concatAssignmentPattern.exec(content);
  }

  // Discord slash-command builders bind the value set via .addChoices({ name, value: "literal" }).
  // When that value later flows into a template literal (e.g. `key.${selectedMode}_title`), the
  // assignment search above misses it because the binding happens via interaction.options.getString.
  // Collect every `value: "literal"` inside an addChoices(...) block.
  const addChoicesPattern = /\.addChoices\s*\(([\s\S]*?)\)/g;
  let addChoicesMatch = addChoicesPattern.exec(content);
  while (addChoicesMatch !== null) {
    const choicesBlock = addChoicesMatch[1];
    const valuePattern = /value\s*:\s*["']([a-zA-Z0-9._-]+)["']/g;
    let valueMatch = valuePattern.exec(choicesBlock);
    while (valueMatch !== null) {
      resolvedValues.add(valueMatch[1]);
      valueMatch = valuePattern.exec(choicesBlock);
    }
    addChoicesMatch = addChoicesPattern.exec(content);
  }

  return Array.from(resolvedValues);
}

/**
 * Extracts keys from localizer() / localizeWithAliases() calls with template literals
 * Handles patterns like: localizer(locale, `genai.google.${messageKey}`)
 * Also handles: localizeWithAliases(locale, `commands.${categoryName}.description`)
 * @param content - The file content to analyze
 * @param availableKeys - Set of all available locale keys to match against
 * @returns Array of matched keys
 */
function extractLocalizerTemplateKeys(content: string, availableKeys: Set<string>): string[] {
  const matchedKeys: string[] = [];

  // Pattern: localizer() or localizeWithAliases() with template literal as second argument
  // Matches: localizer(locale, `genai.google.${messageKey}`)
  //          localizeWithAliases(locale, `commands.${categoryName}.description`)
  //          localizer(locale, `${keyBase}.restored_label`)
  //          localizer(locale, `${keyBase}.restore_more_suffix`, { count: hiddenCount })
  // Keep this pattern broad enough to allow extra args after the template key;
  // provider-switch summary labels pass description vars as a third argument.
  const localizerTemplatePattern =
    /(?:localizer|localizeWithAliases)\s*\([^,]+,\s*`([a-zA-Z][a-zA-Z0-9._-]*)?\$\{([^}]+)\}([a-zA-Z0-9._-]*)`/g;

  let match = localizerTemplatePattern.exec(content);
  while (match !== null) {
    const prefix = match[1]; // e.g., "genai.google."
    const variable = match[2]; // e.g., "messageKey"
    const suffix = match[3]; // e.g., "" (usually empty)

    const variableName = variable.split(/[.[]/)[0];
    const safeVar = escapeRegExp(variableName);

    // Look for string literal values for this variable via assignments AND strict equality comparisons
    // Patterns like: messageKey = "429_default_message" OR conditioningType === "reward"
    const valuePattern = new RegExp(
      `(?:${safeVar}\\s*(?:=|===)\\s*["'\`]([a-zA-Z0-9._-]+)["'\`]|["'\`]([a-zA-Z0-9._-]+)["'\`]\\s*===\\s*${safeVar})`,
      "g",
    );

    for (const assignedValue of resolveAssignedStringValues(content, variableName)) {
      const fullKey = `${prefix ?? ""}${assignedValue}${suffix}`;
      if (availableKeys.has(fullKey)) {
        matchedKeys.push(fullKey);
      }
    }

    let valueMatch = valuePattern.exec(content);
    while (valueMatch !== null) {
      const resolvedValue = valueMatch[1] ?? valueMatch[2];
      if (resolvedValue) {
        const fullKey = `${prefix ?? ""}${resolvedValue}${suffix}`;
        if (availableKeys.has(fullKey)) {
          matchedKeys.push(fullKey);
        }
      }

      valueMatch = valuePattern.exec(content);
    }

    match = localizerTemplatePattern.exec(content);
  }

  return matchedKeys;
}

/**
 * Extracts error code pattern keys from file content
 * Handles patterns like: messageKey = `${errorCode}_default_message`
 */
function extractErrorCodeKeys(content: string, availableKeys: Set<string>): string[] {
  const matchedKeys: string[] = [];

  // Pattern 1: Template literals with variable + suffix
  // Matches: `${errorCode}_default_message` or `${statusCode}_error_title`
  const templateWithSuffixPattern = /`\$\{([^}]+)\}([a-zA-Z0-9._-]+)`/g;

  let match = templateWithSuffixPattern.exec(content);
  while (match !== null) {
    const variable = match[1]; // e.g., "errorCode"
    const suffix = match[2]; // e.g., "_default_message"

    const variableName = variable.split(/[.[]/)[0];

    // Look for all available keys that match this pattern
    // Common error codes and status codes
    const commonCodes = ["400", "401", "403", "404", "429", "500", "503", "504", "unknown"];

    const safeVar = escapeRegExp(variableName);
    const numericAssignPattern = new RegExp(`${safeVar}\\s*===?\\s*(\\d+|["']\\d+["'])`, "g");
    let numMatch = numericAssignPattern.exec(content);
    while (numMatch !== null) {
      const code = numMatch[1].replace(/["']/g, "");
      commonCodes.push(code);
      numMatch = numericAssignPattern.exec(content);
    }

    for (const code of commonCodes) {
      const fullKey = `${code}${suffix}`;
      if (availableKeys.has(fullKey)) {
        matchedKeys.push(fullKey);
      }
    }

    match = templateWithSuffixPattern.exec(content);
  }

  // Matches: `genai.google.${errorCode}_default_message`
  const templateWithPrefixPattern = /`([a-zA-Z][a-zA-Z0-9._-]*)\$\{([^}]+)\}([a-zA-Z0-9._-]*)`/g;

  let prefixMatch = templateWithPrefixPattern.exec(content);
  while (prefixMatch !== null) {
    const prefix = prefixMatch[1]; // e.g., "genai.google."
    const variable = prefixMatch[2]; // e.g., "errorCode"
    const suffix = prefixMatch[3]; // e.g., "_default_message"

    // Skip if this is already handled by extractDynamicTemplateKeys
    // (those have titleKey/descriptionKey before the backtick)
    const variableName = variable.split(/[.[]/)[0];

    const commonCodes = ["400", "401", "403", "404", "429", "500", "503", "504", "unknown"];

    const safeVar = escapeRegExp(variableName);
    const numericAssignPattern = new RegExp(`${safeVar}\\s*===?\\s*(\\d+|["']\\d+["'])`, "g");
    let numMatch = numericAssignPattern.exec(content);
    while (numMatch !== null) {
      const code = numMatch[1].replace(/["']/g, "");
      commonCodes.push(code);
      numMatch = numericAssignPattern.exec(content);
    }

    for (const code of commonCodes) {
      const fullKey = `${prefix}${code}${suffix}`;
      if (availableKeys.has(fullKey)) {
        matchedKeys.push(fullKey);
      }
    }

    prefixMatch = templateWithPrefixPattern.exec(content);
  }

  return matchedKeys;
}

/**
 * Extracts locale keys that are embedded in pipe-delimited payload strings.
 * Handles patterns like:
 *   "commands.data.import.error_incompatible_version|1.0|unknown"
 *   `commands.data.import.error_incompatible_version|${expected}|${actual}`
 * @param content - The file content to analyze
 * @param availableKeys - Set of all available locale keys to match against
 * @returns Array of matched keys
 */
function extractPipeEncodedLocaleKeys(content: string, availableKeys: Set<string>): string[] {
  const matchedKeys: string[] = [];
  const pipePattern = /[`"']([a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z][a-zA-Z0-9_-]*){1,})\|/g;

  let match = pipePattern.exec(content);
  while (match !== null) {
    const key = match[1];
    if (availableKeys.has(key)) {
      matchedKeys.push(key);
    }
    match = pipePattern.exec(content);
  }

  return matchedKeys;
}

/**
 * Keys that are provably used at runtime but cannot be detected by static regex analysis
 * because their values come from TypeScript type constraints or object key enumeration.
 * Example: `commands.conditioning.shared.${type}_footer` where type ∈ ConditioningType
 * which is a Zod enum; the values come from a Record<ConditioningType, ...> object
 * whose keys cannot be reliably traced back to the template variable without type inference.
 */
const KNOWN_DYNAMIC_LOCALE_KEYS = new Set([
  "commands.conditioning.shared.punish_footer",
  "commands.conditioning.shared.reward_footer",
]);

/**
 * Detects getLocaleSubKeys(locale, "prefix") calls and marks all available keys
 * under that prefix as referenced. This function enumerates locale sub-keys at
 * runtime so all child keys under the prefix are implicitly used.
 */
async function extractGetLocaleSubKeysUsage(availableKeys: Set<string>): Promise<string[]> {
  const matchedKeys: string[] = [];
  const srcPath = join(process.cwd(), "src");
  const getSubKeysPattern = /getLocaleSubKeys\s*\([^,]+,\s*["']([a-zA-Z0-9._-]+)["']\)/g;

  const glob = new Glob("**/*.ts");
  for await (const file of glob.scan(srcPath)) {
    if (file.includes("locales/")) continue;
    const filePath = join(srcPath, file);
    try {
      const content = await readFile(filePath, "utf-8");
      let match = getSubKeysPattern.exec(content);
      while (match !== null) {
        const prefix = match[1]; // e.g., "commands.reward"
        // All keys starting with "prefix." are dynamically enumerated
        for (const key of availableKeys) {
          if (key.startsWith(`${prefix}.`)) {
            matchedKeys.push(key);
          }
        }
        match = getSubKeysPattern.exec(content);
      }
    } catch {
    }
  }

  return matchedKeys;
}

/**
 * Marks commands.{category}.description and commands.{category}.{group}.description
 * keys as referenced, because commandLoader.ts dynamically builds these keys from the
 * src/commands/ directory structure (using path.basename) rather than string literals.
 * @param _availableKeys - Unused; retained for backwards-compatible call sites
 * @returns Array of matched description keys derived from the filesystem layout
 */
async function extractExpectedCommandMetadataKeys(): Promise<ExpectedMetadataKey[]> {
  const expectedKeys: ExpectedMetadataKey[] = [];
  const commandsPath = join(process.cwd(), "src", "commands");

  try {
    const { readdir } = await import("node:fs/promises");
    const categories = await readdir(commandsPath, { withFileTypes: true });

    for (const cat of categories) {
      if (!cat.isDirectory()) continue;
      const catName = cat.name;

      // Top-level command description: commands.{category}.description
      expectedKeys.push({
        key: `commands.${catName}.description`,
        file: `src/commands/${catName}`,
        strict: false,
      });

      // Subcommand group descriptions: commands.{category}.{group}.description
      const catPath = join(commandsPath, catName);
      const subEntries = await readdir(catPath, { withFileTypes: true });
      for (const sub of subEntries) {
        const subPath = join(catPath, sub.name);

        if (sub.isDirectory()) {
          expectedKeys.push({
            key: `commands.${catName}.${sub.name}.description`,
            file: `src/commands/${catName}/${sub.name}`,
            strict: false,
          });

          const groupFiles = await readdir(subPath, { withFileTypes: true });
          for (const groupFile of groupFiles) {
            if (!groupFile.isFile() || !groupFile.name.endsWith(".ts")) continue;

            const relativePath = `src/commands/${catName}/${sub.name}/${groupFile.name}`;
            const filePath = join(subPath, groupFile.name);
            const content = await readFile(filePath, "utf-8");
            const nameMatch = content.match(/setName\("([^"]+)"\)/);

            // Skip non-command files (type/config mapping helpers with no setName call)
            if (!nameMatch) continue;
            const subcommandName = nameMatch[1];

            expectedKeys.push({
              key: `commands.${catName}.${sub.name}.${subcommandName}.description`,
              file: relativePath,
              strict: true,
            });

            if (catName === "conditioning" && (sub.name === "reward" || sub.name === "punish")) {
              expectedKeys.push({
                key: `commands.${catName}.${sub.name}.${subcommandName}.reason_description`,
                file: relativePath,
                strict: true,
              });
            }
          }

          continue;
        }

        if (!sub.isFile() || !sub.name.endsWith(".ts")) continue;

        const relativePath = `src/commands/${catName}/${sub.name}`;
        const content = await readFile(subPath, "utf-8");
        const nameMatch = content.match(/setName\("([^"]+)"\)/);

        // Skip non-command files (type/config mapping helpers with no setName call)
        if (!nameMatch) continue;
        const subcommandName = nameMatch[1];

        expectedKeys.push({
          key: `commands.${catName}.${subcommandName}.description`,
          file: relativePath,
          strict: true,
        });
      }
    }
  } catch (error) {
    log.warn("Failed to scan command directories for description keys", error);
  }

  return expectedKeys;
}

/**
 * Extracts localization keys referenced in TypeScript source files
 */
async function extractReferencedKeys(availableKeys: Set<string>): Promise<Map<string, Set<string>>> {
  const referencedKeys = new Map<string, Set<string>>();
  const srcPath = join(process.cwd(), "src");

  const patterns = [
    /(?:titleKey|descriptionKey|nameKey|labelKey|modalTitleKey|itemLabelKey):\s*["']([a-zA-Z0-9._-]+)["']/g,
    // localizer() calls: first arg can be a string literal ("en-US") OR a variable (locale)
    /localizer\s*\(\s*(?:"[^"]*"|'[^']*'|\w+)\s*,\s*["']([a-zA-Z0-9._-]+)["']/g,
    // Quoted strings that look like localization keys (dot-separated paths).
    // Allow 2-segment keys like "general.cancel" in addition to deeper paths.
    /["']([a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z][a-zA-Z0-9_-]*){1,})["']/g,
    /[?:]\s*["']([a-zA-Z0-9._-]+)["']/g,
  ];

  try {
    const glob = new Glob("**/*.ts");
    for await (const file of glob.scan(srcPath)) {
      // Skip locale files; other source files may still contain valid locale keys.
      if (file.includes("locales/")) {
        continue;
      }

      const filePath = join(srcPath, file);
      try {
        const content = await readFile(filePath, "utf-8");

        for (const [patternIndex, pattern] of patterns.entries()) {
          let match: RegExpExecArray | null;
          pattern.lastIndex = 0; // Reset regex state
          match = pattern.exec(content);
          while (match !== null) {
            const key = match[1];
            const matchIndex = match.index;

            if (isInSetDeclaration(content, matchIndex)) {
              match = pattern.exec(content);
              continue;
            }

            // The generic catch-all patterns intentionally allow 2-segment keys so
            // leaf keys like "general.cancel" are detected, but they also see parent
            // prefixes like "commands.reward" in getLocaleSubKeys() calls. Keep those
            // generic patterns limited to known leaf keys when only 2 segments exist.
            if (patternIndex >= 2 && key.split(".").length === 2 && !availableKeys.has(key)) {
              match = pattern.exec(content);
              continue;
            }

            if (isValidLocalizationKey(key)) {
              if (!referencedKeys.has(key)) {
                referencedKeys.set(key, new Set());
              }
              referencedKeys.get(key)?.add(file);
            }
            match = pattern.exec(content);
          }
        }

        const dynamicKeys = extractDynamicTemplateKeys(content, availableKeys);
        for (const key of dynamicKeys) {
          if (!referencedKeys.has(key)) {
            referencedKeys.set(key, new Set());
          }
          referencedKeys.get(key)?.add(file);
        }

        // Extract localizer template literal keys
        const localizerTemplateKeys = extractLocalizerTemplateKeys(content, availableKeys);
        for (const key of localizerTemplateKeys) {
          if (!referencedKeys.has(key)) {
            referencedKeys.set(key, new Set());
          }
          referencedKeys.get(key)?.add(file);
        }

        const errorCodeKeys = extractErrorCodeKeys(content, availableKeys);
        for (const key of errorCodeKeys) {
          if (!referencedKeys.has(key)) {
            referencedKeys.set(key, new Set());
          }
          referencedKeys.get(key)?.add(file);
        }

        const pipeEncodedKeys = extractPipeEncodedLocaleKeys(content, availableKeys);
        for (const key of pipeEncodedKeys) {
          if (!referencedKeys.has(key)) {
            referencedKeys.set(key, new Set());
          }
          referencedKeys.get(key)?.add(file);
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
 * Checks for key parity issues across all locales
 */
function checkLocaleParity(localeKeys: Map<string, Set<string>>): LocaleParityIssue[] {
  const parityIssues: LocaleParityIssue[] = [];
  const allLocales = Array.from(localeKeys.keys());

  const allKeys = new Set<string>();
  for (const keys of localeKeys.values()) {
    for (const key of keys) {
      allKeys.add(key);
    }
  }

  for (const key of allKeys) {
    const missingIn: string[] = [];
    const presentIn: string[] = [];

    for (const locale of allLocales) {
      const keys = localeKeys.get(locale);
      if (keys?.has(key)) {
        presentIn.push(locale);
      } else {
        missingIn.push(locale);
      }
    }

    if (missingIn.length > 0) {
      parityIssues.push({ key, missingIn, presentIn });
    }
  }

  return parityIssues;
}

/**
 * Main analysis function
 */
export async function analyzeLocalizationKeys(): Promise<AnalysisResult> {
  const { availableKeys, localeKeys } = await loadAvailableKeys();
  const parityIssues = checkLocaleParity(localeKeys);
  const modalTitleViolations = await checkModalTitleLengths(localeKeys);
  const modalDescriptionViolations = await checkModalDescriptionLengths(localeKeys);
  const commandDescriptionViolations = await checkCommandDescriptionLengths(localeKeys);
  const modalUsages = await extractModalComponentUsages();
  const modalUsageViolations = await checkModalComponentUsageLengths(modalUsages, localeKeys);
  const messageUsages = await extractMessageComponentUsages();
  const messageSlotViolations = await checkMessageComponentUsageLengths(messageUsages, localeKeys);
  const referencedKeysMap = await extractReferencedKeys(availableKeys);
  const referencedKeys = new Set(referencedKeysMap.keys());

  // Add keys discovered via getLocaleSubKeys() runtime enumeration
  const subKeyMatches = await extractGetLocaleSubKeysUsage(availableKeys);
  for (const key of subKeyMatches) referencedKeys.add(key);

  const expectedMetadataKeys = await extractExpectedCommandMetadataKeys();
  for (const { key, file, strict } of expectedMetadataKeys) {
    const resolvedKey = resolveLocalizationKey(key, availableKeys);
    const trackedKey = resolvedKey ?? key;

    referencedKeys.add(trackedKey);
    if (strict) {
      if (!referencedKeysMap.has(trackedKey)) {
        referencedKeysMap.set(trackedKey, new Set());
      }
      referencedKeysMap.get(trackedKey)?.add(file);
    }
  }

  // Add keys that are provably used but cannot be detected statically
  for (const key of KNOWN_DYNAMIC_LOCALE_KEYS) referencedKeys.add(key);

  const missingKeys: KeyUsage[] = [];
  for (const [key, files] of referencedKeysMap) {
    if (!resolveLocalizationKey(key, availableKeys)) {
      missingKeys.push({ key, files: new Set(files) });
    }
  }

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
    localeKeys,
    parityIssues,
    modalTitleViolations,
    modalDescriptionViolations,
    commandDescriptionViolations,
    modalUsageViolations,
    messageSlotViolations,
  };
}

function displayResults(results: AnalysisResult): void {
  const hasErrors =
    results.parityIssues.length > 0 ||
    results.modalTitleViolations.length > 0 ||
    results.modalDescriptionViolations.length > 0 ||
    results.commandDescriptionViolations.length > 0 ||
    results.modalUsageViolations.length > 0 ||
    results.messageSlotViolations.length > 0 ||
    results.missingKeys.length > 0;

  if (!hasErrors) {
    const localeNames = Array.from(results.localeKeys.keys());
    console.log(
      `✅ Locales OK (${localeNames.join(", ")} — ${results.availableKeys.size} keys, ${results.unusedKeys.length} unused)`,
    );
    return;
  }

  console.log(`\n${"=".repeat(80)}`);
  console.log("🔍 LOCALIZATION KEY ANALYSIS RESULTS");
  console.log("=".repeat(80));

  if (results.parityIssues.length > 0) {
    console.log("\n🌐 LOCALE PARITY ISSUES (Keys missing in some locales):");
    console.log("-".repeat(60));
    for (const { key, missingIn, presentIn } of results.parityIssues.sort((a, b) => a.key.localeCompare(b.key))) {
      console.log(`  ⚠️  ${key}`);
      console.log(`     ✅ Present in: ${presentIn.join(", ")}`);
      console.log(`     ❌ Missing in: ${missingIn.join(", ")}`);
    }
  }

  if (results.modalTitleViolations.length > 0) {
    console.log("\n📏 MODAL TITLE LENGTH VIOLATIONS (Must be 5-45 characters for Discord):");
    console.log("-".repeat(60));
    for (const { key, value, length, locale } of results.modalTitleViolations.sort((a, b) =>
      a.key.localeCompare(b.key),
    )) {
      const status = length < 5 ? "Too short" : "Too long";
      console.log(`  ⚠️  ${key} [${locale}]`);
      console.log(`     ❌ ${status}: "${value}" (${length} characters)`);
    }
  }

  if (results.modalDescriptionViolations.length > 0) {
    console.log("\n📏 MODAL DESCRIPTION LENGTH VIOLATIONS (Must be ≤100 characters — Discord truncates beyond this):");
    console.log("-".repeat(60));
    for (const { key, value, length, locale } of results.modalDescriptionViolations.sort((a, b) =>
      a.key.localeCompare(b.key),
    )) {
      console.log(`  ⚠️  ${key} [${locale}]`);
      console.log(`     ❌ Too long: "${value}" (${length} characters)`);
    }
  }

  if (results.modalUsageViolations.length > 0) {
    // Group by kind so each Discord cap is its own section; readers see "all label
    // violations" together rather than mixed in with placeholders and titles.
    const KIND_HEADERS: Record<ModalKind, string> = {
      title: "📏 MODAL TITLE USAGE VIOLATIONS (setTitle cap: ≤45 chars)",
      label: "📏 MODAL LABEL USAGE VIOLATIONS (setLabel cap: ≤45 chars)",
      description: "📏 MODAL DESCRIPTION USAGE VIOLATIONS (setPlaceholder cap: ≤100 chars — truncated by interactionCore.ts)",
      placeholder: "📏 MODAL PLACEHOLDER USAGE VIOLATIONS (setPlaceholder cap: ≤100 chars)",
      optionLabel: "📏 SELECT OPTION LABEL VIOLATIONS (option setLabel cap: ≤100 chars)",
      optionDescription: "📏 SELECT OPTION DESCRIPTION VIOLATIONS (option setDescription cap: ≤100 chars)",
    };

    const byKind = new Map<ModalKind, ModalUsageViolation[]>();
    for (const v of results.modalUsageViolations) {
      const list = byKind.get(v.kind) ?? [];
      list.push(v);
      byKind.set(v.kind, list);
    }

    for (const kind of ["title", "label", "description", "placeholder", "optionLabel", "optionDescription"] as ModalKind[]) {
      const list = byKind.get(kind);
      if (!list || list.length === 0) continue;
      console.log(`\n${KIND_HEADERS[kind]}:`);
      console.log("-".repeat(60));
      for (const { key, value, length, maxLength, locale, files } of list.sort((a, b) =>
        a.key.localeCompare(b.key),
      )) {
        const filesPreview = Array.from(files).slice(0, 2).join(", ") + (files.size > 2 ? "..." : "");
        console.log(`  ⚠️  ${key} [${locale}] (cap ${maxLength})`);
        console.log(`     ❌ Too long: "${value}" (${length} characters)`);
        console.log(`     📁 Used in: ${filesPreview}`);
      }
    }
  }

  if (results.messageSlotViolations.length > 0) {
    const MESSAGE_KIND_HEADERS: Record<MessageSlotKind, string> = {
      buttonLabel: "📏 MESSAGE BUTTON LABEL VIOLATIONS (label cap: ≤80 chars)",
      selectPlaceholder: "📏 MESSAGE SELECT PLACEHOLDER VIOLATIONS (placeholder cap: ≤150 chars)",
      optionLabel: "📏 MESSAGE SELECT OPTION LABEL VIOLATIONS (option label cap: ≤100 chars)",
      optionDescription: "📏 MESSAGE SELECT OPTION DESCRIPTION VIOLATIONS (option description cap: ≤100 chars)",
    };

    const byKind = new Map<MessageSlotKind, MessageSlotViolation[]>();
    for (const v of results.messageSlotViolations) {
      const list = byKind.get(v.kind) ?? [];
      list.push(v);
      byKind.set(v.kind, list);
    }

    for (const kind of ["buttonLabel", "selectPlaceholder", "optionLabel", "optionDescription"] as MessageSlotKind[]) {
      const list = byKind.get(kind);
      if (!list || list.length === 0) continue;
      console.log(`\n${MESSAGE_KIND_HEADERS[kind]}:`);
      console.log("-".repeat(60));
      for (const { key, value, length, maxLength, locale, files } of list.sort((a, b) =>
        a.key.localeCompare(b.key),
      )) {
        const filesPreview = Array.from(files).slice(0, 2).join(", ") + (files.size > 2 ? "..." : "");
        console.log(`  ⚠️  ${key} [${locale}] (cap ${maxLength})`);
        console.log(`     ❌ Too long: "${value}" (${length} characters)`);
        console.log(`     📁 Used in: ${filesPreview}`);
      }
    }
  }

  if (results.commandDescriptionViolations.length > 0) {
    console.log("\n📏 COMMAND DESCRIPTION LENGTH VIOLATIONS (Must be 1-100 characters for Discord):");
    console.log("-".repeat(60));
    for (const { key, value, length, locale } of results.commandDescriptionViolations.sort((a, b) =>
      a.key.localeCompare(b.key),
    )) {
      const status = length < 1 ? "Empty" : "Too long";
      console.log(`  ⚠️  ${key} [${locale}]`);
      console.log(`     ❌ ${status}: "${value}" (${length} characters)`);
    }
  }

  if (results.missingKeys.length > 0) {
    console.log("\n❌ MISSING LOCALIZATION KEYS (Referenced but don't exist):");
    console.log("-".repeat(60));
    for (const { key, files } of results.missingKeys.sort((a, b) => a.key.localeCompare(b.key))) {
      console.log(`  ❌ ${key}`);
      console.log(
        `     📁 Used in ${files.size} files: ${Array.from(files).slice(0, 3).join(", ")}${files.size > 3 ? "..." : ""}`,
      );
    }
  }

  console.log(`\n${"=".repeat(80)}`);
}

/**
 * Displays unused keys grouped by prefix for review
 */
function displayUnusedKeys(unusedKeys: KeyUsage[]): void {
  const grouped = new Map<string, string[]>();
  for (const { key } of unusedKeys.sort((a, b) => a.key.localeCompare(b.key))) {
    const prefix = key.split(".").slice(0, 2).join(".");
    const list = grouped.get(prefix) || [];
    list.push(key);
    grouped.set(prefix, list);
  }

  console.log(`\n${"=".repeat(80)}`);
  console.log(`🗑️  UNUSED LOCALIZATION KEYS (${unusedKeys.length} total)`);
  console.log("=".repeat(80));

  for (const [prefix, keys] of Array.from(grouped.entries()).sort()) {
    console.log(`\n## ${prefix} (${keys.length} keys)`);
    for (const key of keys) {
      console.log(`  ${key}`);
    }
  }
  console.log(`\n${"=".repeat(80)}`);
}

/**
 * Main execution
 */
/**
 * Length-only fast path used by `bun run vl` so that Discord limit violations
 * (modal titles, modal descriptions, command descriptions) block the PR gate
 * without paying for the full unused/parity source scan.
 */
async function runStrictLengthsOnly(): Promise<void> {
  const { localeKeys } = await loadAvailableKeys();
  const modalTitleViolations = await checkModalTitleLengths(localeKeys);
  const modalDescriptionViolations = await checkModalDescriptionLengths(localeKeys);
  const commandDescriptionViolations = await checkCommandDescriptionLengths(localeKeys);
  const modalUsages = await extractModalComponentUsages();
  const modalUsageViolations = await checkModalComponentUsageLengths(modalUsages, localeKeys);
  const messageUsages = await extractMessageComponentUsages();
  const messageSlotViolations = await checkMessageComponentUsageLengths(messageUsages, localeKeys);

  const total =
    modalTitleViolations.length +
    modalDescriptionViolations.length +
    commandDescriptionViolations.length +
    modalUsageViolations.length +
    messageSlotViolations.length;

  if (total === 0) {
    console.log(
      `✅ Discord length limits OK (titles, descriptions, command descriptions, ${modalUsages.size} traced modal slots, ${messageUsages.size} traced message slots)`,
    );
    return;
  }

  // Reuse the same display formatting as the full report by funnelling violations
  // through displayResults() with empty sets for the other categories.
  displayResults({
    missingKeys: [],
    unusedKeys: [],
    referencedKeys: new Set(),
    availableKeys: new Set(),
    localeKeys,
    parityIssues: [],
    modalTitleViolations,
    modalDescriptionViolations,
    commandDescriptionViolations,
    modalUsageViolations,
    messageSlotViolations,
  });

  process.exit(1);
}

async function main(): Promise<void> {
  try {
    const listUnused = process.argv.includes("--list-unused");
    const strictLengths = process.argv.includes("--strict-lengths");

    if (strictLengths) {
      await runStrictLengthsOnly();
      return;
    }

    const results = await analyzeLocalizationKeys();

    if (listUnused) {
      displayUnusedKeys(results.unusedKeys);
      return;
    }

    displayResults(results);

    if (
      results.missingKeys.length > 0 ||
      results.modalTitleViolations.length > 0 ||
      results.modalDescriptionViolations.length > 0 ||
      results.commandDescriptionViolations.length > 0 ||
      results.modalUsageViolations.length > 0 ||
      results.messageSlotViolations.length > 0
    ) {
      process.exit(1);
    } else if (results.parityIssues.length > 0) {
      process.exit(2);
    }
  } catch (error) {
    log.error("Fatal error during localization key analysis", error);
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
