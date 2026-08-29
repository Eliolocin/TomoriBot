import { buildInteractionRouteId, type ParsedInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import {
  buildRouteSegments,
  decodeRouteSegments,
  indexCodecsByWireToken,
  parseNonNegativeInt,
  parseNonce,
  parsePositiveId,
  type RouteFieldCodec,
} from "@/utils/discord/panelRouteCodec";
import { parseLocale } from "@/utils/discord/panelRouteTokens";

export const MEMORIES_ROUTE_NAMESPACE = "memories";
export const MEMORIES_ROUTE_VERSION = "v1";

export type MemoriesCategory = "memories" | "documents" | "stm";

type MemoriesAction =
  | "category"
  | "persona-select"
  | "select"
  | "range"
  | "range-open"
  | "range-page"
  | "range-cancel"
  | "add-submit"
  | "edit-open"
  | "edit-submit"
  | "remove-prompt"
  | "remove-confirm"
  | "remove-cancel"
  | "retry"
  | "refresh";

export type MemoriesPanelRoute =
  | { action: "category"; locale: string; category: MemoriesCategory }
  | { action: "persona-select"; locale: string; lineageId: number }
  | { action: "select"; locale: string; lineageId: number; rangeIndex?: number }
  | { action: "range"; locale: string; lineageId: number; rangeIndex: number }
  | { action: "range-open" | "range-cancel"; locale: string; lineageId: number }
  | { action: "range-page"; locale: string; lineageId: number; chooserPage: number }
  | { action: "add-submit"; locale: string; lineageId: number; nonce: string }
  | {
      action: "edit-open" | "remove-prompt" | "remove-confirm" | "remove-cancel";
      locale: string;
      lineageId: number;
      memoryId: number;
    }
  | { action: "edit-submit"; locale: string; lineageId: number; memoryId: number; nonce: string }
  | { action: "retry" | "refresh"; locale: string; category: MemoriesCategory; lineageId?: number };

const categoryField: RouteFieldCodec<"category", MemoriesCategory> = {
  key: "category",
  encode: (val) => String(val),
  decode: (raw) => (raw === "memories" || raw === "documents" || raw === "stm" ? raw : null),
};

const lineageIdField: RouteFieldCodec<"lineageId", number> = {
  key: "lineageId",
  encode: (val) => String(val),
  decode: (raw) => parsePositiveId(raw),
};

const optionalLineageIdField: RouteFieldCodec<"lineageId", number> = {
  key: "lineageId",
  optional: true,
  encode: (val) => String(val),
  decode: (raw) => parsePositiveId(raw),
};

const memoryIdField: RouteFieldCodec<"memoryId", number> = {
  key: "memoryId",
  encode: (val) => String(val),
  decode: (raw) => parsePositiveId(raw),
};

const nonceField: RouteFieldCodec<"nonce", string> = {
  key: "nonce",
  encode: (val) => String(val),
  decode: (raw) => parseNonce(raw),
};

const rangeIndexField: RouteFieldCodec<"rangeIndex", number> = {
  key: "rangeIndex",
  encode: (val) => String(val),
  decode: (raw) => parseNonNegativeInt(raw),
};

const optionalRangeIndexField: RouteFieldCodec<"rangeIndex", number> = {
  key: "rangeIndex",
  optional: true,
  encode: (val) => String(val),
  decode: (raw) => parseNonNegativeInt(raw),
};

const chooserPageField: RouteFieldCodec<"chooserPage", number> = {
  key: "chooserPage",
  encode: (val) => String(val),
  decode: (raw) => parseNonNegativeInt(raw),
};

const MEMORIES_ROUTE_CODECS: Record<
  MemoriesAction,
  { wireToken: string; fields: readonly RouteFieldCodec<string, unknown>[] }
> = {
  category: {
    wireToken: "category",
    fields: [categoryField],
  },
  "persona-select": {
    wireToken: "persona-select",
    fields: [lineageIdField],
  },
  select: {
    wireToken: "select",
    fields: [lineageIdField, optionalRangeIndexField],
  },
  range: {
    wireToken: "range",
    fields: [lineageIdField, rangeIndexField],
  },
  "range-open": {
    wireToken: "range-open",
    fields: [lineageIdField],
  },
  "range-page": {
    wireToken: "range-page",
    fields: [lineageIdField, chooserPageField],
  },
  "range-cancel": {
    wireToken: "range-cancel",
    fields: [lineageIdField],
  },
  "add-submit": {
    wireToken: "add-submit",
    fields: [lineageIdField, nonceField],
  },
  "edit-open": {
    wireToken: "edit-open",
    fields: [lineageIdField, memoryIdField],
  },
  "edit-submit": {
    wireToken: "edit-submit",
    fields: [lineageIdField, memoryIdField, nonceField],
  },
  "remove-prompt": {
    wireToken: "remove-prompt",
    fields: [lineageIdField, memoryIdField],
  },
  "remove-confirm": {
    wireToken: "remove-confirm",
    fields: [lineageIdField, memoryIdField],
  },
  "remove-cancel": {
    wireToken: "remove-cancel",
    fields: [lineageIdField, memoryIdField],
  },
  retry: {
    wireToken: "retry",
    fields: [categoryField, optionalLineageIdField],
  },
  refresh: {
    wireToken: "refresh",
    fields: [categoryField, optionalLineageIdField],
  },
};

const CODECS_BY_WIRE_TOKEN = indexCodecsByWireToken<MemoriesAction, MemoriesPanelRoute>(MEMORIES_ROUTE_CODECS);

export function buildMemoriesRouteSegments(route: MemoriesPanelRoute): string[] {
  return buildRouteSegments(MEMORIES_ROUTE_CODECS[route.action], route);
}

export function buildMemoriesRouteId(route: MemoriesPanelRoute): string {
  return buildInteractionRouteId(
    MEMORIES_ROUTE_NAMESPACE,
    MEMORIES_ROUTE_VERSION,
    ...buildMemoriesRouteSegments(route),
  );
}

export function parseMemoriesPanelRoute(route: ParsedInteractionRoute): MemoriesPanelRoute | null {
  if (route.namespace !== MEMORIES_ROUTE_NAMESPACE || route.version !== MEMORIES_ROUTE_VERSION) {
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
