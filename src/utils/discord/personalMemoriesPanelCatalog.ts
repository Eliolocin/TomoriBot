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

export const PERSONAL_MEMORIES_ROUTE_NAMESPACE = "personal-memories";
export const PERSONAL_MEMORIES_ROUTE_VERSION = "v1";

export type PersonalMemoriesCategory = "global" | "persona";

export type PersonalMemoriesPanelRoute =
  | { action: "category"; locale: string; category: PersonalMemoriesCategory }
  | { action: "persona-select"; locale: string; category: "persona"; lineageId: number }
  | {
      action: "select";
      locale: string;
      category: PersonalMemoriesCategory;
      lineageId: number;
      rangeIndex?: number;
    }
  | { action: "range-open" | "range-cancel"; locale: string; category: PersonalMemoriesCategory; lineageId: number }
  | { action: "range"; locale: string; category: PersonalMemoriesCategory; lineageId: number; rangeIndex: number }
  | { action: "range-page"; locale: string; category: PersonalMemoriesCategory; lineageId: number; chooserPage: number }
  | { action: "add-submit"; locale: string; category: PersonalMemoriesCategory; lineageId: number; nonce: string }
  | {
      action: "edit-open" | "remove-prompt" | "remove-confirm" | "remove-cancel";
      locale: string;
      category: PersonalMemoriesCategory;
      lineageId: number;
      memoryId: number;
    }
  | {
      action: "edit-submit";
      locale: string;
      category: PersonalMemoriesCategory;
      lineageId: number;
      memoryId: number;
      nonce: string;
    }
  | { action: "stm-clear"; locale: string; category: PersonalMemoriesCategory; lineageId: number }
  | { action: "retry" | "refresh"; locale: string; category: PersonalMemoriesCategory; lineageId: number };

export type PersonalMemoriesAction = PersonalMemoriesPanelRoute["action"];

type PersonalMemoriesRouteForAction<A extends PersonalMemoriesAction> = PersonalMemoriesPanelRoute extends infer R
  ? R extends { action: string }
    ? A extends R["action"]
      ? R & { action: A }
      : never
    : never
  : never;

export type PersonalMemoriesRouteCodecs = {
  [A in PersonalMemoriesAction]: RouteCodec<PersonalMemoriesRouteForAction<A>>;
};

function parseCategory(value: string | undefined): PersonalMemoriesCategory | null {
  if (value === "global" || value === "persona") return value;
  return null;
}

const categoryField: RouteFieldCodec<"category", PersonalMemoriesCategory> = {
  key: "category",
  encode: (v) => String(v),
  decode: (v) => parseCategory(v),
};

const personaCategoryField: RouteFieldCodec<"category", "persona"> = {
  key: "category",
  encode: (v) => String(v),
  decode: (v) => (v === "persona" ? "persona" : null),
};

const lineageIdField: RouteFieldCodec<"lineageId", number> = {
  key: "lineageId",
  encode: (v) => String(v),
  decode: (v) => parseNonNegativeInt(v),
};

const positiveLineageIdField: RouteFieldCodec<"lineageId", number> = {
  key: "lineageId",
  encode: (v) => String(v),
  decode: (v) => parsePositiveId(v),
};

const optionalRangeIndexField: RouteFieldCodec<"rangeIndex", number> = {
  key: "rangeIndex",
  optional: true,
  encode: (v) => String(v),
  decode: (v) => parseNonNegativeInt(v),
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

const memoryIdField: RouteFieldCodec<"memoryId", number> = {
  key: "memoryId",
  encode: (v) => String(v),
  decode: (v) => parsePositiveId(v),
};

const nonceField: RouteFieldCodec<"nonce", string> = {
  key: "nonce",
  encode: (v) => String(v),
  decode: (v) => parseNonce(v),
};

/**
 * Authoritative codec table for all personal-memories routes.
 * Keyed by semantic action to guarantee compile-time exhaustiveness.
 * Preserves the exact v1 wire format: wire token, locale, and ordered field serialization.
 */
export const PERSONAL_MEMORIES_ROUTE_CODECS: PersonalMemoriesRouteCodecs = {
  "add-submit": {
    wireToken: "add-submit",
    fields: [categoryField, lineageIdField, nonceField],
  },
  category: {
    wireToken: "category",
    fields: [categoryField],
  },
  "edit-open": {
    wireToken: "edit-open",
    fields: [categoryField, lineageIdField, memoryIdField],
  },
  "edit-submit": {
    wireToken: "edit-submit",
    fields: [categoryField, lineageIdField, memoryIdField, nonceField],
  },
  "persona-select": {
    wireToken: "persona-select",
    fields: [personaCategoryField, positiveLineageIdField],
  },
  range: {
    wireToken: "range",
    fields: [categoryField, lineageIdField, rangeIndexField],
  },
  "range-cancel": {
    wireToken: "range-cancel",
    fields: [categoryField, lineageIdField],
  },
  "range-open": {
    wireToken: "range-open",
    fields: [categoryField, lineageIdField],
  },
  "range-page": {
    wireToken: "range-page",
    fields: [categoryField, lineageIdField, chooserPageField],
  },
  refresh: {
    wireToken: "refresh",
    fields: [categoryField, lineageIdField],
  },
  "remove-cancel": {
    wireToken: "remove-cancel",
    fields: [categoryField, lineageIdField, memoryIdField],
  },
  "remove-confirm": {
    wireToken: "remove-confirm",
    fields: [categoryField, lineageIdField, memoryIdField],
  },
  "remove-prompt": {
    wireToken: "remove-prompt",
    fields: [categoryField, lineageIdField, memoryIdField],
  },
  retry: {
    wireToken: "retry",
    fields: [categoryField, lineageIdField],
  },
  select: {
    wireToken: "select",
    fields: [categoryField, lineageIdField, optionalRangeIndexField],
  },
  "stm-clear": {
    wireToken: "stm-clear",
    fields: [categoryField, lineageIdField],
  },
};

const CODECS_BY_WIRE_TOKEN = indexCodecsByWireToken<PersonalMemoriesAction, PersonalMemoriesPanelRoute>(
  PERSONAL_MEMORIES_ROUTE_CODECS,
);

export function listPersonalMemoriesPanelActions(): PersonalMemoriesAction[] {
  return Object.keys(PERSONAL_MEMORIES_ROUTE_CODECS) as PersonalMemoriesAction[];
}

/**
 * Encodes a typed route object through the authoritative codec table into route segments.
 */
export function buildPersonalMemoriesRouteSegments(route: PersonalMemoriesPanelRoute): string[] {
  return buildRouteSegments(PERSONAL_MEMORIES_ROUTE_CODECS[route.action], route);
}

/**
 * Builds a custom ID from a typed route object using the authoritative codec table.
 */
export function buildPersonalMemoriesRouteId(route: PersonalMemoriesPanelRoute): string {
  return buildInteractionRouteId(
    PERSONAL_MEMORIES_ROUTE_NAMESPACE,
    PERSONAL_MEMORIES_ROUTE_VERSION,
    ...buildPersonalMemoriesRouteSegments(route),
  );
}

export function parsePersonalMemoriesPanelRoute(route: ParsedInteractionRoute): PersonalMemoriesPanelRoute | null {
  if (route.namespace !== PERSONAL_MEMORIES_ROUTE_NAMESPACE || route.version !== PERSONAL_MEMORIES_ROUTE_VERSION) {
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
