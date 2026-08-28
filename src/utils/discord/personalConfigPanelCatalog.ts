import { createHash } from "node:crypto";
import { buildInteractionRouteId, type ParsedInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import { getSupportedLocales } from "@/utils/text/localizer";

export const PERSONAL_CONFIG_ROUTE_NAMESPACE = "personal-config";
export const PERSONAL_CONFIG_ROUTE_VERSION = "v2";

export type PersonalConfigCategory = "profile" | "privacy" | "models" | "advanced";

type ProfilePage = "general" | "persona" | "appearance";
type PrivacyPage = "controls";
type ModelsPage = "switch" | "parameters" | "fallbacks";
type AdvancedPage = "response-modes" | "impersonation" | "spotlight";

export type PersonalConfigPage = ProfilePage | PrivacyPage | ModelsPage | AdvancedPage;

export const DEFAULT_PAGE_FOR_CATEGORY: Record<PersonalConfigCategory, PersonalConfigPage> = {
  profile: "general",
  privacy: "controls",
  models: "switch",
  advanced: "response-modes",
};

export type PersonalConfigManagedCapability = "text" | "vision" | "embedding" | "image" | "image_nai" | "video";

/**
 * Rows one Spotlight removal modal can present: Discord allows five components, each a ten-option
 * checkbox group. The renderer, the range chooser, and the submit handler must agree on it, because
 * unchecked-means-remove derives the removal set from the slice that was presented.
 */
export const SPOTLIGHT_REMOVE_PAGE_SIZE = 50;

export function encodeProviderParam(provider: string): string {
  return provider.replace(/:/g, "~");
}

export function decodeProviderParam(encoded: string): string {
  return encoded.replace(/~/g, ":");
}

/**
 * Binds spotlight set selection to the exact presented persona collection and actor scope.
 * Drift in persona count or ordering invalidates the continuation without writing.
 */
export function computeSpotlightSetFingerprint(
  guildId: string,
  userDiscId: string,
  personas: readonly { id: number }[],
): string {
  const ids = personas.map((p) => p.id).join(",");
  return createHash("sha256").update(`spotlight-set:${guildId}:${userDiscId}:${ids}`).digest("base64url").slice(0, 8);
}

/**
 * Binds spotlight removal to the exact active rows presented when the removal action started.
 * Drift in active rows or ordering invalidates unchecked-means-remove derivation without writing.
 */
export function computeSpotlightRemoveFingerprint(
  guildId: string,
  userDiscId: string,
  spotlights: readonly { channelDiscId: string }[],
): string {
  const ids = spotlights.map((s) => s.channelDiscId).join(",");
  return createHash("sha256")
    .update(`spotlight-remove:${guildId}:${userDiscId}:${ids}`)
    .digest("base64url")
    .slice(0, 8);
}

export type PersonalConfigPanelRoute =
  | { action: "category"; locale: string; category: PersonalConfigCategory; page: PersonalConfigPage }
  | { action: "page"; locale: string; category: PersonalConfigCategory; page: PersonalConfigPage }
  | { action: "persona-select"; locale: string; lineageId: number }
  | { action: "language-open"; locale: string }
  | { action: "language-submit"; locale: string; nonce: string }
  | { action: "timezone-open"; locale: string }
  | { action: "timezone-submit"; locale: string; nonce: string }
  | { action: "timezone-server"; locale: string }
  | { action: "naming-open"; locale: string }
  | { action: "naming-submit"; locale: string; nonce: string }
  | { action: "about-open"; locale: string }
  | { action: "about-submit"; locale: string; nonce: string }
  | { action: "persona-naming-open"; locale: string; lineageId: number }
  | { action: "persona-naming-submit"; locale: string; lineageId: number; nonce: string }
  | { action: "appearance-open"; locale: string }
  | { action: "appearance-submit"; locale: string; nonce: string }
  | { action: "privacy-level-open"; locale: string }
  | { action: "privacy-level-submit"; locale: string; nonce: string }
  | { action: "crossserver-toggle"; locale: string }
  // Models - Switch Models
  | { action: "capability-select"; locale: string }
  | { action: "quick-toggle-open"; locale: string }
  | { action: "quick-toggle-submit"; locale: string; nonce: string }
  | { action: "quick-toggle-confirm"; locale: string; mask: string; nonce: string }
  | { action: "quick-toggle-cancel"; locale: string }
  | { action: "model-enable"; locale: string; capability: PersonalConfigManagedCapability }
  | { action: "model-default"; locale: string; capability: PersonalConfigManagedCapability }
  | { action: "model-provider-select"; locale: string; capability: PersonalConfigManagedCapability }
  | {
      action: "model-range-open";
      locale: string;
      capability: PersonalConfigManagedCapability;
      provider: string;
      start: number;
    }
  | {
      action: "model-modal-submit";
      locale: string;
      capability: PersonalConfigManagedCapability;
      provider: string;
      nonce: string;
    }
  | {
      action: "model-act-confirm";
      locale: string;
      capability: PersonalConfigManagedCapability;
      provider: string;
      modelId: number;
      nonce: string;
    }
  | { action: "model-act-cancel"; locale: string }
  // Models - Parameters
  | { action: "parameters-provider-select"; locale: string }
  | { action: "parameters-1-open"; locale: string; provider: string }
  | { action: "parameters-1-submit"; locale: string; provider: string; nonce: string }
  | { action: "parameters-2-open"; locale: string; provider: string }
  | { action: "parameters-2-submit"; locale: string; provider: string; nonce: string }
  // Models - Fallbacks
  | { action: "fallbacks-provider-select"; locale: string }
  | { action: "fallbacks-open"; locale: string; provider: string }
  | { action: "fallbacks-range-open"; locale: string; provider: string; start: number }
  | { action: "fallbacks-submit"; locale: string; provider: string; nonce: string }
  | { action: "randomizer-toggle"; locale: string; provider: string }
  // Advanced - Response Modes
  | { action: "trigger-mode-set"; locale: string; mode: "off" | "follow" | "on" }
  | { action: "tool-mode-set"; locale: string; mode: "off" | "follow" | "on" }
  // Advanced - Impersonation
  | { action: "impersonation-open"; locale: string }
  | { action: "impersonation-submit"; locale: string; nonce: string }
  | { action: "impersonation-clear-view"; locale: string }
  | { action: "impersonation-clear-confirm"; locale: string; nonce: string }
  | { action: "impersonation-clear-cancel"; locale: string }
  // Advanced - Personal Spotlight
  | { action: "spotlight-set-open"; locale: string }
  | { action: "spotlight-set-submit"; locale: string; fp: string; nonce: string }
  | {
      action: "spot-set-cf";
      locale: string;
      channelId: string;
      hours: number;
      autoTriggerId: number;
      mask: string;
      fp: string;
      nonce: string;
    }
  | {
      action: "spot-set-auto";
      locale: string;
      channelId: string;
      hours: number;
      mask: string;
      fp: string;
      nonce: string;
    }
  | {
      action: "spot-set-auto-sub";
      locale: string;
      channelId: string;
      hours: number;
      mask: string;
      fp: string;
      nonce: string;
    }
  | { action: "spotlight-set-cancel"; locale: string }
  | { action: "spotlight-remove-open"; locale: string }
  | { action: "spot-rem-range"; locale: string; start: number; fp: string }
  | { action: "spotlight-remove-submit"; locale: string; start: number; fp: string; nonce: string }
  | { action: "spotlight-remove-cancel"; locale: string }
  | {
      action: "retry" | "refresh";
      locale: string;
      category: PersonalConfigCategory;
      page: PersonalConfigPage;
      lineageId?: number;
      capability?: PersonalConfigManagedCapability;
      provider?: string;
    };

const WIRE_ACTION_TOKENS: Record<string, string> = {
  "spotlight-set-submit": "s-set-sub",
  "spot-set-cf": "s-cf",
  "spot-set-auto": "s-auto",
  "spot-set-auto-sub": "s-asub",
  "spot-rem-range": "s-rem-r",
  "spotlight-remove-submit": "s-rem-sub",
};

export function buildPersonalConfigCustomId(
  action: string,
  locale: string,
  ...segments: Array<string | number>
): string {
  const wireAction = WIRE_ACTION_TOKENS[action] ?? action;
  return buildInteractionRouteId(
    PERSONAL_CONFIG_ROUTE_NAMESPACE,
    PERSONAL_CONFIG_ROUTE_VERSION,
    wireAction,
    locale,
    ...segments.map(String),
  );
}

function parseLocale(value: string | undefined): string | null {
  return value && getSupportedLocales().includes(value) ? value : null;
}

function parseCategory(value: string | undefined): PersonalConfigCategory | null {
  if (value === "profile" || value === "privacy" || value === "models" || value === "advanced") {
    return value;
  }
  return null;
}

function parsePage(category: PersonalConfigCategory, value: string | undefined): PersonalConfigPage | null {
  if (!value) return null;
  switch (category) {
    case "profile":
      if (value === "general" || value === "persona" || value === "appearance") return value;
      return null;
    case "privacy":
      if (value === "controls") return value;
      return null;
    case "models":
      if (value === "switch" || value === "parameters" || value === "fallbacks") return value;
      return null;
    case "advanced":
      if (value === "response-modes" || value === "impersonation" || value === "spotlight") return value;
      return null;
    default:
      return null;
  }
}

function parsePositiveId(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseNonNegativeInt(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseNonce(value: string | undefined): string | null {
  return value && /^[A-Za-z0-9_-]{8,32}$/.test(value) ? value : null;
}

function parseManagedCapability(value: string | undefined): PersonalConfigManagedCapability | null {
  if (
    value === "text" ||
    value === "vision" ||
    value === "embedding" ||
    value === "image" ||
    value === "image_nai" ||
    value === "video"
  ) {
    return value;
  }
  return null;
}

function parseProvider(value: string | undefined): string | null {
  if (!value || !/^[A-Za-z0-9_~-]{1,60}$/.test(value)) return null;
  return decodeProviderParam(value);
}

function parseDtmMode(value: string | undefined): "off" | "follow" | "on" | null {
  if (value === "off" || value === "follow" || value === "on") return value;
  return null;
}

function parseSnowflake(value: string | undefined): string | null {
  if (!value || !/^\d{17,20}$/.test(value)) return null;
  return value;
}

function parseHexMask(value: string | undefined): string | null {
  if (!value || !/^[0-9a-fA-F]{1,16}$/.test(value)) return null;
  return value;
}

function parseFingerprint(value: string | undefined): string | null {
  if (!value || !/^[A-Za-z0-9_-]{8}$/.test(value)) return null;
  return value;
}

export function parsePersonalConfigPanelRoute(route: ParsedInteractionRoute): PersonalConfigPanelRoute | null {
  if (route.namespace !== PERSONAL_CONFIG_ROUTE_NAMESPACE || route.version !== PERSONAL_CONFIG_ROUTE_VERSION) {
    return null;
  }

  const [action, rawLocale, first, second, third, fourth, fifth, sixth] = route.segments;
  const locale = parseLocale(rawLocale);
  if (!locale || !action) return null;

  if (action === "category" || action === "page") {
    if (route.segments.length !== 4) return null;
    const category = parseCategory(first);
    if (!category) return null;
    const page = parsePage(category, second);
    if (!page) return null;
    return { action, locale, category, page };
  }

  if (action === "persona-select" && route.segments.length === 3) {
    const lineageId = parsePositiveId(first);
    return lineageId === null ? null : { action, locale, lineageId };
  }

  if ((action === "trigger-mode-set" || action === "tool-mode-set") && route.segments.length === 3) {
    const mode = parseDtmMode(first);
    return mode === null ? null : { action, locale, mode };
  }

  if (
    action === "language-open" ||
    action === "timezone-open" ||
    action === "timezone-server" ||
    action === "naming-open" ||
    action === "about-open" ||
    action === "appearance-open" ||
    action === "privacy-level-open" ||
    action === "crossserver-toggle" ||
    action === "capability-select" ||
    action === "quick-toggle-open" ||
    action === "quick-toggle-cancel" ||
    action === "model-act-cancel" ||
    action === "parameters-provider-select" ||
    action === "fallbacks-provider-select" ||
    action === "impersonation-open" ||
    action === "impersonation-clear-view" ||
    action === "impersonation-clear-cancel" ||
    action === "spotlight-set-open" ||
    action === "spotlight-set-cancel" ||
    action === "spotlight-remove-open" ||
    action === "spotlight-remove-cancel"
  ) {
    if (route.segments.length !== 2) return null;
    return { action, locale };
  }

  if (
    action === "language-submit" ||
    action === "timezone-submit" ||
    action === "naming-submit" ||
    action === "about-submit" ||
    action === "appearance-submit" ||
    action === "privacy-level-submit" ||
    action === "quick-toggle-submit" ||
    action === "impersonation-submit" ||
    action === "impersonation-clear-confirm"
  ) {
    if (route.segments.length !== 3) return null;
    const nonce = parseNonce(first);
    return nonce === null ? null : { action, locale, nonce };
  }

  if (action === "s-set-sub" && route.segments.length === 4) {
    const fp = parseFingerprint(first);
    const nonce = parseNonce(second);
    return fp === null || nonce === null ? null : { action: "spotlight-set-submit", locale, fp, nonce };
  }

  if (action === "s-cf" && route.segments.length === 8) {
    const channelId = parseSnowflake(first);
    const hours = parseNonNegativeInt(second);
    const autoTriggerId = parseNonNegativeInt(third);
    const mask = parseHexMask(fourth);
    const fp = parseFingerprint(fifth);
    const nonce = parseNonce(sixth);
    if (!channelId || hours === null || autoTriggerId === null || !mask || !fp || !nonce) return null;
    return { action: "spot-set-cf", locale, channelId, hours, autoTriggerId, mask, fp, nonce };
  }

  if (action === "s-auto" && route.segments.length === 7) {
    const channelId = parseSnowflake(first);
    const hours = parseNonNegativeInt(second);
    const mask = parseHexMask(third);
    const fp = parseFingerprint(fourth);
    const nonce = parseNonce(fifth);
    if (!channelId || hours === null || !mask || !fp || !nonce) return null;
    return { action: "spot-set-auto", locale, channelId, hours, mask, fp, nonce };
  }

  if (action === "s-asub" && route.segments.length === 7) {
    const channelId = parseSnowflake(first);
    const hours = parseNonNegativeInt(second);
    const mask = parseHexMask(third);
    const fp = parseFingerprint(fourth);
    const nonce = parseNonce(fifth);
    if (!channelId || hours === null || !mask || !fp || !nonce) return null;
    return { action: "spot-set-auto-sub", locale, channelId, hours, mask, fp, nonce };
  }

  if (action === "s-rem-r" && route.segments.length === 4) {
    const start = parseNonNegativeInt(first);
    const fp = parseFingerprint(second);
    return start === null || fp === null ? null : { action: "spot-rem-range", locale, start, fp };
  }

  // The removal modal presents one 50-row slice, and unchecked-means-remove derives the removal set
  // from the rows that were presented. Without the offset the submit handler recomputes that set from
  // the first slice and deletes rows the user never saw.
  if (action === "s-rem-sub" && route.segments.length === 5) {
    const start = parseNonNegativeInt(first);
    const fp = parseFingerprint(second);
    const nonce = parseNonce(third);
    return start === null || fp === null || nonce === null
      ? null
      : { action: "spotlight-remove-submit", locale, start, fp, nonce };
  }

  if (action === "quick-toggle-confirm" && route.segments.length === 4) {
    const mask = first;
    const nonce = parseNonce(second);
    if (!mask || !/^[01]{5}$/.test(mask) || nonce === null) return null;
    return { action, locale, mask, nonce };
  }

  if (action === "persona-naming-open" && route.segments.length === 3) {
    const lineageId = parsePositiveId(first);
    return lineageId === null ? null : { action, locale, lineageId };
  }

  if (action === "persona-naming-submit" && route.segments.length === 4) {
    const lineageId = parsePositiveId(first);
    const nonce = parseNonce(second);
    return lineageId === null || nonce === null ? null : { action, locale, lineageId, nonce };
  }

  if (
    (action === "model-enable" || action === "model-default" || action === "model-provider-select") &&
    route.segments.length === 3
  ) {
    const capability = parseManagedCapability(first);
    return capability === null ? null : { action, locale, capability };
  }

  if (action === "model-range-open" && route.segments.length === 5) {
    const capability = parseManagedCapability(first);
    const provider = parseProvider(second);
    const start = parseNonNegativeInt(third);
    return capability === null || provider === null || start === null
      ? null
      : { action, locale, capability, provider, start };
  }

  if (action === "model-modal-submit" && route.segments.length === 5) {
    const capability = parseManagedCapability(first);
    const provider = parseProvider(second);
    const nonce = parseNonce(third);
    return capability === null || provider === null || nonce === null
      ? null
      : { action, locale, capability, provider, nonce };
  }

  if (action === "model-act-confirm" && route.segments.length === 6) {
    const capability = parseManagedCapability(first);
    const provider = parseProvider(second);
    const modelId = parsePositiveId(third);
    const nonce = parseNonce(fourth);
    return capability === null || provider === null || modelId === null || nonce === null
      ? null
      : { action, locale, capability, provider, modelId, nonce };
  }

  if (
    (action === "parameters-1-open" ||
      action === "parameters-2-open" ||
      action === "fallbacks-open" ||
      action === "randomizer-toggle") &&
    route.segments.length === 3
  ) {
    const provider = parseProvider(first);
    return provider === null ? null : { action, locale, provider };
  }

  if (action === "fallbacks-range-open" && route.segments.length === 4) {
    const provider = parseProvider(first);
    const start = parseNonNegativeInt(second);
    return provider === null || start === null ? null : { action, locale, provider, start };
  }

  if (
    (action === "parameters-1-submit" || action === "parameters-2-submit" || action === "fallbacks-submit") &&
    route.segments.length === 4
  ) {
    const provider = parseProvider(first);
    const nonce = parseNonce(second);
    return provider === null || nonce === null ? null : { action, locale, provider, nonce };
  }

  if (action === "retry" || action === "refresh") {
    if (route.segments.length < 4 || route.segments.length > 6) return null;
    const category = parseCategory(first);
    if (!category) return null;
    const page = parsePage(category, second);
    if (!page) return null;
    const lineageId = route.segments.length >= 5 ? (parsePositiveId(third) ?? undefined) : undefined;
    const capability = route.segments.length >= 5 ? (parseManagedCapability(third) ?? undefined) : undefined;
    const provider = route.segments.length >= 5 ? (parseProvider(third) ?? undefined) : undefined;
    return { action, locale, category, page, lineageId, capability, provider };
  }

  return null;
}
