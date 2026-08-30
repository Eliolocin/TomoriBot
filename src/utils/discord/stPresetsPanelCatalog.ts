import { buildInteractionRouteId, type ParsedInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import {
  buildRouteSegments,
  decodeRouteSegments,
  indexCodecsByWireToken,
  parseNonNegativeInt,
  parseNonce,
  parsePositiveId,
  type RouteCodec,
  type RouteFieldCodec,
} from "@/utils/discord/panelRouteCodec";
import { parseLocale } from "@/utils/discord/panelRouteTokens";

export const ST_PRESETS_ROUTE_NAMESPACE = "st-presets";
export const ST_PRESETS_ROUTE_VERSION = "v1";

export type StPresetsPanelRoute =
  | { action: "select" | "retry" | "none" | "disable" | "add-open"; locale: string }
  | { action: "range"; locale: string; rangeIndex: number }
  | { action: "add-submit"; locale: string; nonce: string }
  | { action: "nodes-open" | "delete-prompt" | "delete-cancel" | "delete-confirm"; locale: string; presetId: number }
  | { action: "nodes-range"; locale: string; presetId: number; rangeIndex: number }
  | { action: "nodes-page"; locale: string; presetId: number; chooserPage: number }
  | { action: "nodes-submit"; locale: string; presetId: number; nonce: string };

export type StPresetsAction = StPresetsPanelRoute["action"];

type StPresetsRouteForAction<A extends StPresetsAction> = StPresetsPanelRoute extends infer R
  ? R extends { action: string }
    ? A extends R["action"]
      ? R & { action: A }
      : never
    : never
  : never;

export type StPresetsRouteCodecs = {
  [A in StPresetsAction]: RouteCodec<StPresetsRouteForAction<A>>;
};

const presetIdField: RouteFieldCodec<"presetId", number> = {
  key: "presetId",
  encode: (v) => String(v),
  decode: (v) => parsePositiveId(v),
};

const rangeIndexField: RouteFieldCodec<"rangeIndex", number> = {
  key: "rangeIndex",
  encode: (v) => String(v),
  decode: (v) => parseNonNegativeInt(v),
};

const chooserPageField: RouteFieldCodec<"chooserPage", number> = {
  key: "chooserPage",
  encode: (v) => String(v),
  decode: (v) => parseNonNegativeInt(v),
};

const nonceField: RouteFieldCodec<"nonce", string> = {
  key: "nonce",
  encode: (v) => String(v),
  decode: (v) => parseNonce(v),
};

/**
 * Authoritative codec table for all st-presets routes.
 * Keyed by semantic action to guarantee compile-time exhaustiveness.
 * Preserves the exact v1 wire format: wire token, locale, and ordered field serialization.
 */
export const ST_PRESETS_ROUTE_CODECS: StPresetsRouteCodecs = {
  "add-open": {
    wireToken: "add-open",
    fields: [],
  },
  "add-submit": {
    wireToken: "add-submit",
    fields: [nonceField],
  },
  "delete-cancel": {
    wireToken: "delete-cancel",
    fields: [presetIdField],
  },
  "delete-confirm": {
    wireToken: "delete-confirm",
    fields: [presetIdField],
  },
  "delete-prompt": {
    wireToken: "delete-prompt",
    fields: [presetIdField],
  },
  disable: {
    wireToken: "disable",
    fields: [],
  },
  "nodes-open": {
    wireToken: "nodes-open",
    fields: [presetIdField],
  },
  "nodes-page": {
    wireToken: "nodes-page",
    fields: [presetIdField, chooserPageField],
  },
  "nodes-range": {
    wireToken: "nodes-range",
    fields: [presetIdField, rangeIndexField],
  },
  "nodes-submit": {
    wireToken: "nodes-submit",
    fields: [presetIdField, nonceField],
  },
  none: {
    wireToken: "none",
    fields: [],
  },
  range: {
    wireToken: "range",
    fields: [rangeIndexField],
  },
  retry: {
    wireToken: "retry",
    fields: [],
  },
  select: {
    wireToken: "select",
    fields: [],
  },
};

const CODECS_BY_WIRE_TOKEN = indexCodecsByWireToken<StPresetsAction, StPresetsPanelRoute>(ST_PRESETS_ROUTE_CODECS);

export function listStPresetsPanelActions(): StPresetsAction[] {
  return Object.keys(ST_PRESETS_ROUTE_CODECS) as StPresetsAction[];
}

/**
 * Encodes a typed route object through the authoritative codec table into route segments.
 */
export function buildStPresetsRouteSegments(route: StPresetsPanelRoute): string[] {
  return buildRouteSegments(ST_PRESETS_ROUTE_CODECS[route.action], route);
}

/**
 * Builds a custom ID from a typed route object using the authoritative codec table.
 */
export function buildStPresetsRouteId(route: StPresetsPanelRoute): string {
  return buildInteractionRouteId(
    ST_PRESETS_ROUTE_NAMESPACE,
    ST_PRESETS_ROUTE_VERSION,
    ...buildStPresetsRouteSegments(route),
  );
}

export function parseStPresetsPanelRoute(route: ParsedInteractionRoute): StPresetsPanelRoute | null {
  if (route.namespace !== ST_PRESETS_ROUTE_NAMESPACE || route.version !== ST_PRESETS_ROUTE_VERSION) {
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
