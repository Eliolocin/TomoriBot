import { createHash } from "node:crypto";
import type { PersonalProviderCapability } from "@/types/db/schema";
import { buildInteractionRouteId, type ParsedInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import {
  buildRouteSegments,
  decodeRouteSegments,
  indexCodecsByWireToken,
  parseNonNegativeInt,
  parseNonce,
  parsePositiveId,
  parseSnowflake,
  type RouteCodec,
  type RouteFieldCodec,
} from "@/utils/discord/panelRouteCodec";
import { parseLocale } from "@/utils/discord/panelRouteTokens";

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

export const QUICK_TOGGLE_CAPABILITIES: readonly PersonalProviderCapability[] = [
  "text",
  "vision",
  "embedding",
  "image",
  "image_nai",
  "video",
] as const;

/**
 * Literal locale key per routing capability. Keep these literal: `check-locales` only sees
 * dot-notation string literals, so a composed key resolves to raw text with every gate green.
 */
export const ROUTING_CAPABILITY_LOCALE_KEYS: Record<PersonalProviderCapability, string> = {
  text: "commands.personal.config.routing_text",
  vision: "commands.personal.config.routing_vision",
  embedding: "commands.personal.config.routing_embedding",
  image: "commands.personal.config.routing_image_standard",
  image_nai: "commands.personal.config.routing_image_nai",
  video: "commands.personal.config.routing_video",
};

/**
 * Rows one Spotlight removal modal can present: Discord allows five components, each a ten-option
 * checkbox group. The renderer, the range chooser, and the submit handler must agree on it, because
 * unchecked-means-remove derives the removal set from the slice that was presented.
 */
export const SPOTLIGHT_REMOVE_PAGE_SIZE = 50;

/**
 * Options one String Select modal page can present. A String Select caps at 25, so a page that
 * reserves a slot for its own "none" entry holds 24. Each renderer, range chooser, and modal
 * builder that slices the same list must share one of these, because a range button carries an
 * absolute row offset and a reader that divides by a different size lands on another page.
 */
export const PERSONAL_MODEL_PAGE_SIZE = 25;
export const PERSONAL_PROVIDER_PAGE_SIZE = 25;
export const PERSONAL_PROVIDER_DIRECT_LIMIT = 24;
export const PERSONAL_PROVIDER_RANGE_VALUE = "__provider_range__";
export const PERSONAL_FALLBACK_PAGE_SIZE = 24;
export const SPOTLIGHT_AUTO_TRIGGER_PAGE_SIZE = 24;

/**
 * Personas one Spotlight persona modal can present: five components, each a ten-option checkbox
 * group. Channel and duration take their own earlier step precisely so all five are available here.
 * A spotlight's personas therefore come from one block of this size, which is why the selection
 * bitmask is block-relative and the block index travels with it.
 */
export const SPOTLIGHT_PERSONA_PAGE_SIZE = 50;

/**
 * Range/block options one select menu can present: Discord allows at most 25 options.
 */
export const SPOTLIGHT_BLOCK_OPTIONS_PER_PAGE = 25;

/**
 * Base36 rather than hex because the bitmask shares a 100-character custom ID with a snowflake, a
 * duration, a fingerprint, and a nonce. At the 50-bit bound a hex mask is 13 characters and lands
 * `spot-set-cf` on exactly 100 with no headroom; base36 is 10.
 */
export function encodeSpotlightMask(bits: bigint): string {
  return bits.toString(36);
}

export function decodeSpotlightMask(value: string | undefined): bigint | null {
  if (!value || !/^[0-9a-z]{1,11}$/.test(value)) return null;
  let bits = 0n;
  for (const char of value) {
    const digit = Number.parseInt(char, 36);
    if (Number.isNaN(digit)) return null;
    bits = bits * 36n + BigInt(digit);
  }
  return bits >> BigInt(SPOTLIGHT_PERSONA_PAGE_SIZE) === 0n ? bits : null;
}

export function encodeProviderParam(provider: string): string {
  return provider.replace(/:/g, "~");
}

export function decodeProviderParam(encoded: string): string {
  return encoded.replace(/~/g, ":");
}

/**
 * Marks a provider select value that also carries a page offset into that provider's option list.
 * `!` survives the `:`/`~` swap {@link encodeProviderParam} performs, so a page value stays
 * distinguishable from a bare provider value after decoding.
 */
const PROVIDER_PAGE_VALUE_PREFIX = "page!";

export function encodeProviderPageValue(provider: string, start: number): string {
  return `${PROVIDER_PAGE_VALUE_PREFIX}${start}!${encodeProviderParam(provider)}`;
}

/**
 * Returns null for a bare provider value so callers can branch on shape rather than on a separate
 * flag that could disagree with the value they actually received.
 */
export function decodeProviderPageValue(value: string): { provider: string; start: number } | null {
  if (!value.startsWith(PROVIDER_PAGE_VALUE_PREFIX)) return null;
  const rest = value.slice(PROVIDER_PAGE_VALUE_PREFIX.length);
  const delimiter = rest.indexOf("!");
  if (delimiter <= 0) return null;
  const start = Number(rest.slice(0, delimiter));
  if (!Number.isSafeInteger(start) || start < 0) return null;
  const provider = decodeProviderParam(rest.slice(delimiter + 1));
  return provider ? { provider, start } : null;
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
  | { action: "crossserver-set"; locale: string; enabled: boolean }
  // Models - Switch Models
  | { action: "quick-toggle-open"; locale: string }
  | { action: "quick-toggle-submit"; locale: string; nonce: string }
  | { action: "model-provider-select"; locale: string; capability: PersonalConfigManagedCapability }
  | {
      action: "model-provider-page";
      locale: string;
      capability: PersonalConfigManagedCapability;
      provider: string;
      start: number;
    }
  | {
      action: "model-provider-range-open";
      locale: string;
      capability: PersonalConfigManagedCapability;
      start: number;
    }
  | {
      action: "model-provider-range-page";
      locale: string;
      capability: PersonalConfigManagedCapability;
      chooserPage: number;
    }
  | {
      action: "model-range-open";
      locale: string;
      capability: PersonalConfigManagedCapability;
      provider: string;
      start: number;
    }
  | {
      action: "model-range-page";
      locale: string;
      capability: PersonalConfigManagedCapability;
      provider: string;
      chooserPage: number;
    }
  | {
      action: "model-modal-submit";
      locale: string;
      capability: PersonalConfigManagedCapability;
      provider: string;
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
  | { action: "fallbacks-page"; locale: string; provider: string; start: number }
  | { action: "fallbacks-range-open"; locale: string; provider: string; start: number }
  | { action: "fallbacks-range-page"; locale: string; provider: string; chooserPage: number }
  | { action: "fallbacks-submit"; locale: string; provider: string; nonce: string }
  | { action: "randomizer-toggle"; locale: string; provider: string }
  | { action: "randomizer-set"; locale: string; provider: string; enabled: boolean }
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
  | { action: "spotlight-set-step1"; locale: string; nonce: string }
  | { action: "spotlight-set-block"; locale: string; channelId: string; hours: number; fp: string; blockIdx: number }
  | {
      action: "spotlight-set-block-page";
      locale: string;
      channelId: string;
      hours: number;
      fp: string;
      chooserPage: number;
    }
  | {
      action: "spotlight-set-submit";
      locale: string;
      channelId: string;
      hours: number;
      blockIdx: number;
      fp: string;
      nonce: string;
    }
  | {
      action: "spot-set-cf";
      locale: string;
      channelId: string;
      hours: number;
      autoIdx: number;
      blockIdx: number;
      mask: string;
      fp: string;
      nonce: string;
    }
  | {
      action: "spot-set-auto";
      locale: string;
      channelId: string;
      hours: number;
      blockIdx: number;
      mask: string;
      fp: string;
      nonce: string;
    }
  | {
      action: "spot-set-auto-range";
      locale: string;
      channelId: string;
      hours: number;
      blockIdx: number;
      mask: string;
      fp: string;
      start: number;
    }
  | {
      action: "spot-set-auto-page";
      locale: string;
      channelId: string;
      hours: number;
      blockIdx: number;
      mask: string;
      fp: string;
      chooserPage: number;
    }
  | {
      action: "spot-set-auto-cancel";
      locale: string;
      channelId: string;
      hours: number;
      blockIdx: number;
      mask: string;
      fp: string;
    }
  | {
      action: "spot-set-auto-sub";
      locale: string;
      channelId: string;
      hours: number;
      blockIdx: number;
      mask: string;
      fp: string;
      nonce: string;
    }
  | { action: "spotlight-set-cancel"; locale: string }
  | {
      action: "spotlight-set-block-select";
      locale: string;
      channelId: string;
      hours: number;
      fp: string;
    }
  | {
      action: "spot-set-auto-select";
      locale: string;
      channelId: string;
      hours: number;
      blockIdx: number;
      mask: string;
      fp: string;
    }
  | { action: "spotlight-remove-open"; locale: string }
  | { action: "spot-rem-range"; locale: string; start: number; fp: string }
  | { action: "spotlight-remove-page"; locale: string; chooserPage: number; fp: string }
  | { action: "spotlight-remove-select"; locale: string; fp: string }
  | { action: "spotlight-remove-submit"; locale: string; start: number; fp: string; nonce: string }
  | { action: "spotlight-remove-cancel"; locale: string }
  | {
      action: "retry" | "refresh";
      locale: string;
      category: PersonalConfigCategory;
      page: PersonalConfigPage;
      lineageId?: number;
    };

// const WIRE_ACTION_TOKENS was folded into PERSONAL_CONFIG_ROUTE_CODECS; wire tokens are defined per codec.

export type PersonalConfigAction = PersonalConfigPanelRoute["action"];

export type PersonalConfigRouteForAction<A extends PersonalConfigAction> = PersonalConfigPanelRoute extends infer R
  ? R extends { action: string }
    ? A extends R["action"]
      ? R & { action: A }
      : never
    : never
  : never;

export type PersonalConfigRouteCodecs = {
  [A in PersonalConfigAction]: RouteCodec<PersonalConfigRouteForAction<A>>;
};

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

function parseEnabled(value: string | undefined): boolean | null {
  if (value === "on") return true;
  if (value === "off") return false;
  return null;
}

function parseSpotlightMask(value: string | undefined): string | null {
  return decodeSpotlightMask(value) === null ? null : (value as string);
}

function parseFingerprint(value: string | undefined): string | null {
  if (!value || !/^[A-Za-z0-9_-]{8}$/.test(value)) return null;
  return value;
}

const categoryField: RouteFieldCodec<"category", PersonalConfigCategory> = {
  key: "category",
  encode: (v) => String(v),
  decode: (v) => parseCategory(v),
};

const pageField: RouteFieldCodec<"page", PersonalConfigPage> = {
  key: "page",
  encode: (v) => String(v),
  decode: (v, r) => (r.category ? parsePage(r.category as PersonalConfigCategory, v) : null),
};

const lineageIdField: RouteFieldCodec<"lineageId", number> = {
  key: "lineageId",
  encode: (v) => String(v),
  decode: (v) => parsePositiveId(v),
};

const optionalLineageIdField: RouteFieldCodec<"lineageId", number> = {
  key: "lineageId",
  optional: true,
  encode: (v) => String(v),
  decode: (v) => parsePositiveId(v),
};

const nonceField: RouteFieldCodec<"nonce", string> = {
  key: "nonce",
  encode: (v) => String(v),
  decode: (v) => parseNonce(v),
};

const capabilityField: RouteFieldCodec<"capability", PersonalConfigManagedCapability> = {
  key: "capability",
  encode: (v) => String(v),
  decode: (v) => parseManagedCapability(v),
};

const providerField: RouteFieldCodec<"provider", string> = {
  key: "provider",
  encode: (v) => encodeProviderParam(String(v)),
  decode: (v) => parseProvider(v),
};

const modeField: RouteFieldCodec<"mode", "off" | "follow" | "on"> = {
  key: "mode",
  encode: (v) => String(v),
  decode: (v) => parseDtmMode(v),
};

const channelIdField: RouteFieldCodec<"channelId", string> = {
  key: "channelId",
  encode: (v) => String(v),
  decode: (v) => parseSnowflake(v),
};

const hoursField: RouteFieldCodec<"hours", number> = {
  key: "hours",
  encode: (v) => String(v),
  decode: (v) => parseNonNegativeInt(v),
};

const blockIdxField: RouteFieldCodec<"blockIdx", number> = {
  key: "blockIdx",
  encode: (v) => String(v),
  decode: (v) => parseNonNegativeInt(v),
};

const chooserPageField: RouteFieldCodec<"chooserPage", number> = {
  key: "chooserPage",
  encode: (v) => String(v),
  decode: (v) => parseNonNegativeInt(v),
};

const startField: RouteFieldCodec<"start", number> = {
  key: "start",
  encode: (v) => String(v),
  decode: (v) => parseNonNegativeInt(v),
};

const autoIdxField: RouteFieldCodec<"autoIdx", number> = {
  key: "autoIdx",
  encode: (v) => String(v),
  decode: (v) => {
    const parsed = parseNonNegativeInt(v);
    return parsed !== null && parsed <= SPOTLIGHT_PERSONA_PAGE_SIZE ? parsed : null;
  },
};

const maskField: RouteFieldCodec<"mask", string> = {
  key: "mask",
  encode: (v) => String(v),
  decode: (v) => parseSpotlightMask(v),
};

const fpField: RouteFieldCodec<"fp", string> = {
  key: "fp",
  encode: (v) => String(v),
  decode: (v) => parseFingerprint(v),
};

const enabledField: RouteFieldCodec<"enabled", boolean> = {
  key: "enabled",
  encode: (v) => (v ? "on" : "off"),
  decode: (v) => parseEnabled(v),
};

/**
 * Authoritative codec table for all personal-config routes.
 * Keyed by semantic action to guarantee compile-time exhaustiveness.
 * Preserves the exact v2 wire format: wire token, locale, and ordered field serialization.
 */
export const PERSONAL_CONFIG_ROUTE_CODECS: PersonalConfigRouteCodecs = {
  category: {
    wireToken: "category",
    fields: [categoryField, pageField],
  },
  page: {
    wireToken: "page",
    fields: [categoryField, pageField],
  },
  "persona-select": {
    wireToken: "persona-select",
    fields: [lineageIdField],
  },
  "language-open": {
    wireToken: "language-open",
    fields: [],
  },
  "language-submit": {
    wireToken: "language-submit",
    fields: [nonceField],
  },
  "timezone-open": {
    wireToken: "timezone-open",
    fields: [],
  },
  "timezone-submit": {
    wireToken: "timezone-submit",
    fields: [nonceField],
  },
  "timezone-server": {
    wireToken: "timezone-server",
    fields: [],
  },
  "naming-open": {
    wireToken: "naming-open",
    fields: [],
  },
  "naming-submit": {
    wireToken: "naming-submit",
    fields: [nonceField],
  },
  "about-open": {
    wireToken: "about-open",
    fields: [],
  },
  "about-submit": {
    wireToken: "about-submit",
    fields: [nonceField],
  },
  "persona-naming-open": {
    wireToken: "persona-naming-open",
    fields: [lineageIdField],
  },
  "persona-naming-submit": {
    wireToken: "persona-naming-submit",
    fields: [lineageIdField, nonceField],
  },
  "appearance-open": {
    wireToken: "appearance-open",
    fields: [],
  },
  "appearance-submit": {
    wireToken: "appearance-submit",
    fields: [nonceField],
  },
  "privacy-level-open": {
    wireToken: "privacy-level-open",
    fields: [],
  },
  "privacy-level-submit": {
    wireToken: "privacy-level-submit",
    fields: [nonceField],
  },
  "crossserver-toggle": {
    wireToken: "crossserver-toggle",
    fields: [],
  },
  "crossserver-set": {
    wireToken: "crossserver-set",
    fields: [enabledField],
  },
  "quick-toggle-open": {
    wireToken: "quick-toggle-open",
    fields: [],
  },
  "quick-toggle-submit": {
    wireToken: "quick-toggle-submit",
    fields: [nonceField],
  },
  "model-provider-select": {
    wireToken: "model-provider-select",
    fields: [capabilityField],
  },
  "model-provider-page": {
    wireToken: "model-provider-page",
    fields: [capabilityField, providerField, startField],
  },
  "model-provider-range-open": {
    wireToken: "model-provider-range-open",
    fields: [capabilityField, startField],
  },
  "model-provider-range-page": {
    wireToken: "model-provider-range-page",
    fields: [capabilityField, chooserPageField],
  },
  "model-range-open": {
    wireToken: "model-range-open",
    fields: [capabilityField, providerField, startField],
  },
  "model-range-page": {
    wireToken: "model-range-page",
    fields: [capabilityField, providerField, chooserPageField],
  },
  "model-modal-submit": {
    wireToken: "model-modal-submit",
    fields: [capabilityField, providerField, nonceField],
  },
  "model-act-cancel": {
    wireToken: "model-act-cancel",
    fields: [],
  },
  "parameters-provider-select": {
    wireToken: "parameters-provider-select",
    fields: [],
  },
  "parameters-1-open": {
    wireToken: "parameters-1-open",
    fields: [providerField],
  },
  "parameters-1-submit": {
    wireToken: "parameters-1-submit",
    fields: [providerField, nonceField],
  },
  "parameters-2-open": {
    wireToken: "parameters-2-open",
    fields: [providerField],
  },
  "parameters-2-submit": {
    wireToken: "parameters-2-submit",
    fields: [providerField, nonceField],
  },
  "fallbacks-provider-select": {
    wireToken: "fallbacks-provider-select",
    fields: [],
  },
  "fallbacks-page": {
    wireToken: "fallbacks-page",
    fields: [providerField, startField],
  },
  "fallbacks-range-open": {
    wireToken: "fallbacks-range-open",
    fields: [providerField, startField],
  },
  "fallbacks-range-page": {
    wireToken: "fallbacks-range-page",
    fields: [providerField, chooserPageField],
  },
  "fallbacks-submit": {
    wireToken: "fallbacks-submit",
    fields: [providerField, nonceField],
  },
  "randomizer-toggle": {
    wireToken: "randomizer-toggle",
    fields: [providerField],
  },
  "randomizer-set": {
    wireToken: "randomizer-set",
    fields: [providerField, enabledField],
  },
  "trigger-mode-set": {
    wireToken: "trigger-mode-set",
    fields: [modeField],
  },
  "tool-mode-set": {
    wireToken: "tool-mode-set",
    fields: [modeField],
  },
  "impersonation-open": {
    wireToken: "impersonation-open",
    fields: [],
  },
  "impersonation-submit": {
    wireToken: "impersonation-submit",
    fields: [nonceField],
  },
  "impersonation-clear-view": {
    wireToken: "impersonation-clear-view",
    fields: [],
  },
  "impersonation-clear-confirm": {
    wireToken: "impersonation-clear-confirm",
    fields: [nonceField],
  },
  "impersonation-clear-cancel": {
    wireToken: "impersonation-clear-cancel",
    fields: [],
  },
  "spotlight-set-open": {
    wireToken: "spotlight-set-open",
    fields: [],
  },
  "spotlight-set-step1": {
    wireToken: "s-step1",
    fields: [nonceField],
  },
  "spotlight-set-block": {
    wireToken: "s-blk",
    fields: [channelIdField, hoursField, fpField, blockIdxField],
  },
  "spotlight-set-block-page": {
    wireToken: "s-blk-p",
    fields: [channelIdField, hoursField, fpField, chooserPageField],
  },
  "spotlight-set-submit": {
    wireToken: "s-set-sub",
    fields: [channelIdField, hoursField, blockIdxField, fpField, nonceField],
  },
  "spot-set-cf": {
    wireToken: "s-cf",
    fields: [channelIdField, hoursField, autoIdxField, blockIdxField, maskField, fpField, nonceField],
  },
  "spot-set-auto": {
    wireToken: "s-auto",
    fields: [channelIdField, hoursField, blockIdxField, maskField, fpField, nonceField],
  },
  "spot-set-auto-range": {
    wireToken: "s-auto-r",
    fields: [channelIdField, hoursField, blockIdxField, maskField, fpField, startField],
  },
  "spot-set-auto-page": {
    wireToken: "s-auto-p",
    fields: [channelIdField, hoursField, blockIdxField, maskField, fpField, chooserPageField],
  },
  "spot-set-auto-cancel": {
    wireToken: "s-auto-c",
    fields: [channelIdField, hoursField, blockIdxField, maskField, fpField],
  },
  "spot-set-auto-sub": {
    wireToken: "s-asub",
    fields: [channelIdField, hoursField, blockIdxField, maskField, fpField, nonceField],
  },
  "spotlight-set-cancel": {
    wireToken: "spotlight-set-cancel",
    fields: [],
  },
  "spotlight-set-block-select": {
    wireToken: "s-blk-s",
    fields: [channelIdField, hoursField, fpField],
  },
  "spot-set-auto-select": {
    wireToken: "s-auto-s",
    fields: [channelIdField, hoursField, blockIdxField, maskField, fpField],
  },
  "spotlight-remove-open": {
    wireToken: "spotlight-remove-open",
    fields: [],
  },
  "spot-rem-range": {
    wireToken: "s-rem-r",
    fields: [startField, fpField],
  },
  "spotlight-remove-page": {
    wireToken: "s-rem-p",
    fields: [chooserPageField, fpField],
  },
  "spotlight-remove-select": {
    wireToken: "s-rem-s",
    fields: [fpField],
  },
  "spotlight-remove-submit": {
    wireToken: "s-rem-sub",
    fields: [startField, fpField, nonceField],
  },
  "spotlight-remove-cancel": {
    wireToken: "spotlight-remove-cancel",
    fields: [],
  },
  retry: {
    wireToken: "retry",
    fields: [categoryField, pageField, optionalLineageIdField],
  },
  refresh: {
    wireToken: "refresh",
    fields: [categoryField, pageField, optionalLineageIdField],
  },
};

const CODECS_BY_WIRE_TOKEN = indexCodecsByWireToken<PersonalConfigAction, PersonalConfigPanelRoute>(
  PERSONAL_CONFIG_ROUTE_CODECS,
);

/**
 * Encodes a typed route object through the authoritative codec table into route segments.
 */
export function buildPersonalConfigRouteSegments(route: PersonalConfigPanelRoute): string[] {
  return buildRouteSegments(PERSONAL_CONFIG_ROUTE_CODECS[route.action], route);
}

/**
 * Builds a custom ID from a typed route object using the authoritative codec table.
 */
export function buildPersonalConfigRouteId(route: PersonalConfigPanelRoute): string {
  return buildInteractionRouteId(
    PERSONAL_CONFIG_ROUTE_NAMESPACE,
    PERSONAL_CONFIG_ROUTE_VERSION,
    ...buildPersonalConfigRouteSegments(route),
  );
}

export function parsePersonalConfigPanelRoute(route: ParsedInteractionRoute): PersonalConfigPanelRoute | null {
  if (route.namespace !== PERSONAL_CONFIG_ROUTE_NAMESPACE || route.version !== PERSONAL_CONFIG_ROUTE_VERSION) {
    return null;
  }

  const [rawWireToken, rawLocale, ...tail] = route.segments;
  if (!rawWireToken || !rawLocale) return null;

  const locale = parseLocale(rawLocale);
  if (!locale) return null;

  const entry = CODECS_BY_WIRE_TOKEN.get(rawWireToken);
  if (!entry) return null;

  return decodeRouteSegments(entry.codec, entry.action, locale, tail);
}
