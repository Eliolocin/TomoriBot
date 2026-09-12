import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { SETUP_ENDPOINT_API_STYLES, SETUP_ENDPOINT_TEXT_CAPABILITIES } from "@/utils/discord/ui/setupPanel";
import { hasLocaleKey, initializeLocalizer } from "@/utils/text/localizer";
import wizardLocale from "@/locales/en-US/commands/setup";

await initializeLocalizer();

const WIZARD_PREFIX = "commands.setup.wizard.";

/** The wizard sources that name a locale key, one for the panels and modals, one for the routes. */
const WIZARD_SOURCE_FILES = ["src/utils/discord/ui/setupPanel.ts", "src/utils/discord/interactions/setupRoutes.ts"];

/**
 * Keys the wizard composes from a value it holds rather than naming as a literal string.
 *
 * The style and capability families are derived from the same enums the composing code reads, so
 * adding a style or a capability produces a key this test requires and the locale does not have yet,
 * instead of a panel that renders the key path. The five notice keys are the ones a rejection or a
 * failed catalog read picks by name.
 */
function composedWizardKeys(): string[] {
  return [
    "settings_persona_unknown",
    "settings_prompt_unknown",
    "settings_catalog_unavailable",
    "settings_timezone_invalid",
    "settings_timezone_out_of_range",
    ...SETUP_ENDPOINT_API_STYLES.flatMap((style) => {
      const suffix = style === "openai-compatible" ? "openai" : "ollama";
      return [`custom_endpoint_style_${suffix}`, `custom_endpoint_style_${suffix}_desc`];
    }),
    ...SETUP_ENDPOINT_TEXT_CAPABILITIES.flatMap((capability) => [
      `custom_endpoint_cap_${capability}`,
      `custom_endpoint_cap_${capability}_desc`,
    ]),
  ];
}

/** Literal `commands.setup.wizard.*` keys the wizard sources name. */
function literalWizardKeys(): string[] {
  const keys = new Set<string>();
  for (const file of WIZARD_SOURCE_FILES) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/"commands\.setup\.wizard\.([a-z0-9_]+)"/g)) {
      keys.add(match[1]);
    }
  }
  return [...keys].sort();
}

/** Every leaf key the `en-US` wizard block defines, which is what `localizer` reads as `commands.*`. */
function definedWizardKeys(): string[] {
  const wizard = (wizardLocale as { setup?: { wizard?: Record<string, unknown> } }).setup?.wizard;
  return wizard ? Object.keys(wizard).sort() : [];
}

describe("setup wizard locale parity", () => {
  const literal = literalWizardKeys();
  const composed = composedWizardKeys();
  const defined = definedWizardKeys();

  it("finds a key surface large enough for the assertions below to mean something", () => {
    // Guards the extraction itself: a regex that stopped matching would make every assertion here
    // vacuous while still passing, which is the failure mode this file exists to prevent.
    expect(literal.length).toBeGreaterThanOrEqual(100);
    expect(composed.length).toBeGreaterThanOrEqual(20);
    expect(defined.length).toBeGreaterThanOrEqual(140);
  });

  it("keeps the imported locale module the one the localizer serves", () => {
    for (const key of defined) {
      expect(`${key}:${hasLocaleKey("en-US", WIZARD_PREFIX + key)}`).toBe(`${key}:true`);
    }
  });

  it("resolves every key the wizard names literally", () => {
    const missing = literal.filter((key) => !hasLocaleKey("en-US", WIZARD_PREFIX + key));
    expect(missing).toEqual([]);
  });

  it("resolves every key the wizard composes at runtime", () => {
    const missing = composed.filter((key) => !hasLocaleKey("en-US", WIZARD_PREFIX + key));
    expect(missing).toEqual([]);
  });

  it("leaves no rendered wizard key unread", () => {
    // The reverse direction: a key nothing names is either dead copy or, as happened here, copy the
    // panel hardcoded instead of reading, which ships English on every locale.
    const reachable = new Set([...literal, ...composed]);
    expect(defined.filter((key) => !reachable.has(key))).toEqual([]);
  });
});
