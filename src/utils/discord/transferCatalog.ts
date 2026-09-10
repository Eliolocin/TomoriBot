import { buildInteractionRouteId, type ParsedInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import {
  buildRouteSegments,
  decodeRouteSegments,
  indexCodecsByWireToken,
  parseNonNegativeInt,
  parseNonce,
  type RouteCodec,
  type RouteFieldCodec,
} from "@/utils/discord/panelRouteCodec";
import { parseLocale } from "@/utils/discord/panelRouteTokens";

export const TRANSFER_ROUTE_NAMESPACE = "transfer";
export const TRANSFER_ROUTE_VERSION = "v1";

export type TransferPanelRoute =
  | { action: "config-continue"; locale: string; nonce: string }
  | { action: "config-apply"; locale: string; nonce: string }
  | { action: "memory-strategy"; locale: string; nonce: string; strategy: "merge" | "replace" }
  | { action: "memory-bucket-select"; locale: string; nonce: string; bucketPage: number }
  | { action: "memory-bucket-page"; locale: string; nonce: string; bucketPage: number }
  | { action: "memory-map"; locale: string; nonce: string; bucketIndex: number; destPage: number }
  | { action: "memory-map-page"; locale: string; nonce: string; bucketIndex: number; destPage: number }
  | { action: "memory-confirm"; locale: string; nonce: string }
  | { action: "cancel"; locale: string; nonce: string };

type TransferAction = TransferPanelRoute["action"];

type TransferRouteForAction<A extends TransferAction> = TransferPanelRoute extends infer R
  ? R extends { action: string }
    ? A extends R["action"]
      ? R & { action: A }
      : never
    : never
  : never;

type TransferRouteCodecs = {
  [A in TransferAction]: RouteCodec<TransferRouteForAction<A>>;
};

const nonceField: RouteFieldCodec<"nonce", string> = {
  key: "nonce",
  encode: (value) => String(value),
  decode: (value) => parseNonce(value),
};

const bucketPageField: RouteFieldCodec<"bucketPage", number> = {
  key: "bucketPage",
  encode: (value) => String(value),
  decode: (value) => parseNonNegativeInt(value),
};

const destPageField: RouteFieldCodec<"destPage", number> = {
  key: "destPage",
  encode: (value) => String(value),
  decode: (value) => parseNonNegativeInt(value),
};

const bucketIndexField: RouteFieldCodec<"bucketIndex", number> = {
  key: "bucketIndex",
  // The wire carries an index because bucket names in the import schema are unrestricted and may contain colons
  // or exceed the custom ID budget, while the snapshot bucket array is immutable for its lifetime, making the index
  // safe and stable within one flow.
  encode: (value) => String(value),
  decode: (value) => parseNonNegativeInt(value),
};

const strategyField: RouteFieldCodec<"strategy", "merge" | "replace"> = {
  key: "strategy",
  encode: (value) => (value === "merge" ? "m" : "r"),
  decode: (value) => (value === "m" ? "merge" : value === "r" ? "replace" : null),
};

export const TRANSFER_ROUTE_CODECS: TransferRouteCodecs = {
  "config-continue": {
    wireToken: "config-continue",
    fields: [nonceField],
  },
  "config-apply": {
    wireToken: "config-apply",
    fields: [nonceField],
  },
  "memory-strategy": {
    wireToken: "memory-strategy",
    fields: [nonceField, strategyField],
  },
  "memory-bucket-select": {
    wireToken: "mbsel",
    fields: [nonceField, bucketPageField],
  },
  "memory-bucket-page": {
    wireToken: "mbpage",
    fields: [nonceField, bucketPageField],
  },
  "memory-map": {
    wireToken: "memory-map",
    fields: [nonceField, bucketIndexField, destPageField],
  },
  "memory-map-page": {
    wireToken: "memory-map-page",
    fields: [nonceField, bucketIndexField, destPageField],
  },
  "memory-confirm": {
    wireToken: "memory-confirm",
    fields: [nonceField],
  },
  cancel: {
    wireToken: "cancel",
    fields: [nonceField],
  },
};

const CODECS_BY_WIRE_TOKEN = indexCodecsByWireToken<TransferAction, TransferPanelRoute>(TRANSFER_ROUTE_CODECS);

function buildTransferRouteSegments(route: TransferPanelRoute): string[] {
  return buildRouteSegments(TRANSFER_ROUTE_CODECS[route.action], route);
}

export function buildTransferRouteId(route: TransferPanelRoute): string {
  return buildInteractionRouteId(
    TRANSFER_ROUTE_NAMESPACE,
    TRANSFER_ROUTE_VERSION,
    ...buildTransferRouteSegments(route),
  );
}

export function parseTransferPanelRoute(route: ParsedInteractionRoute): TransferPanelRoute | null {
  if (route.namespace !== TRANSFER_ROUTE_NAMESPACE || route.version !== TRANSFER_ROUTE_VERSION) {
    return null;
  }

  const [rawWireToken, rawLocale, ...tail] = route.segments;
  if (!rawWireToken || !rawLocale) return null;

  const locale = parseLocale(rawLocale);
  if (!locale) return null;

  const entry = CODECS_BY_WIRE_TOKEN.get(rawWireToken);
  if (!entry) return null;

  return decodeRouteSegments<TransferPanelRoute>(entry.codec, entry.action, locale, tail);
}
