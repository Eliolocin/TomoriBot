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
import { MCP_SERVER_TYPES, type McpServerType } from "@/utils/mcp/mcpConfigOperations";

export const MCPS_ROUTE_NAMESPACE = "mcps";
export const MCPS_ROUTE_VERSION = "v1";

export type McpsPanelRoute =
  | { action: "select" | "range"; locale: string; rangeIndex: number }
  | { action: "retry" | "refresh"; locale: string; selectedId: number | "none" }
  | { action: "add-open"; locale: string }
  | { action: "add-page"; locale: string; serverType: McpServerType }
  | { action: "add-type"; locale: string }
  | { action: "add-submit"; locale: string; nonce: string; legacyServerType?: McpServerType }
  | { action: "set-enabled"; locale: string; entityId: number; enabled: boolean }
  | { action: "remove-prompt" | "remove-cancel" | "remove-confirm"; locale: string; entityId: number };

export type McpsAction = McpsPanelRoute["action"];

type McpsRouteForAction<A extends McpsAction> = McpsPanelRoute extends infer R
  ? R extends { action: string }
    ? A extends R["action"]
      ? R & { action: A }
      : never
    : never
  : never;

export type McpsRouteCodecs = {
  [A in McpsAction]: RouteCodec<McpsRouteForAction<A>>;
};

function parseServerType(value: string | undefined): McpServerType | null {
  return MCP_SERVER_TYPES.find((candidate) => candidate === value) ?? null;
}

const entityIdField: RouteFieldCodec<"entityId", number> = {
  key: "entityId",
  encode: (v) => String(v),
  decode: (v) => parsePositiveId(v),
};

const rangeIndexField: RouteFieldCodec<"rangeIndex", number> = {
  key: "rangeIndex",
  encode: (v) => String(v),
  decode: (v) => parseNonNegativeInt(v),
};

const selectedIdField: RouteFieldCodec<"selectedId", number | "none"> = {
  key: "selectedId",
  encode: (v) => String(v),
  decode: (v) => (v === "none" ? "none" : parsePositiveId(v)),
};

const serverTypeField: RouteFieldCodec<"serverType", McpServerType> = {
  key: "serverType",
  encode: (v) => String(v),
  decode: (v) => parseServerType(v),
};

const nonceField: RouteFieldCodec<"nonce", string> = {
  key: "nonce",
  encode: (v) => String(v),
  decode: (v) => parseNonce(v),
};

const enabledField: RouteFieldCodec<"enabled", boolean> = {
  key: "enabled",
  encode: (v) => (v ? "1" : "0"),
  decode: (v) => (v === "1" ? true : v === "0" ? false : null),
};

/**
 * Authoritative codec table for all mcps routes.
 * Keyed by semantic action to guarantee compile-time exhaustiveness.
 * Preserves the exact v1 wire format: wire token, locale, and ordered field serialization.
 */
export const MCPS_ROUTE_CODECS: McpsRouteCodecs = {
  "add-open": {
    wireToken: "add-open",
    fields: [],
  },
  "add-page": {
    wireToken: "add-page",
    fields: [serverTypeField],
  },
  "add-submit": {
    wireToken: "add-submit",
    fields: [nonceField],
  },
  "add-type": {
    wireToken: "add-type",
    fields: [],
  },
  range: {
    wireToken: "range",
    fields: [rangeIndexField],
  },
  refresh: {
    wireToken: "refresh",
    fields: [selectedIdField],
  },
  "remove-cancel": {
    wireToken: "remove-cancel",
    fields: [entityIdField],
  },
  "remove-confirm": {
    wireToken: "remove-confirm",
    fields: [entityIdField],
  },
  "remove-prompt": {
    wireToken: "remove-prompt",
    fields: [entityIdField],
  },
  retry: {
    wireToken: "retry",
    fields: [selectedIdField],
  },
  select: {
    wireToken: "select",
    fields: [rangeIndexField],
  },
  "set-enabled": {
    wireToken: "set-enabled",
    fields: [entityIdField, enabledField],
  },
};

const CODECS_BY_WIRE_TOKEN = indexCodecsByWireToken<McpsAction, McpsPanelRoute>(MCPS_ROUTE_CODECS);

export function listMcpsPanelActions(): McpsAction[] {
  return Object.keys(MCPS_ROUTE_CODECS) as McpsAction[];
}

/**
 * Encodes a typed route object through the authoritative codec table into route segments.
 */
export function buildMcpsRouteSegments(route: McpsPanelRoute): string[] {
  return buildRouteSegments(MCPS_ROUTE_CODECS[route.action], route);
}

/**
 * Builds a custom ID from a typed route object using the authoritative codec table.
 */
export function buildMcpsRouteId(route: McpsPanelRoute): string {
  return buildInteractionRouteId(MCPS_ROUTE_NAMESPACE, MCPS_ROUTE_VERSION, ...buildMcpsRouteSegments(route));
}

function decodeCompatibilityRoute(action: McpsAction, locale: string, tail: readonly string[]): McpsPanelRoute | null {
  if (action === "add-open" && tail.length === 1) {
    return parseServerType(tail[0]) ? { action: "add-open", locale } : null;
  }
  if (action === "add-submit" && tail.length === 2) {
    const serverType = parseServerType(tail[0]);
    const nonce = parseNonce(tail[1]);
    return serverType && nonce ? { action: "add-submit", locale, nonce, legacyServerType: serverType } : null;
  }
  if (action === "refresh" && tail.length === 1 && tail[0] === "add") {
    return { action: "refresh", locale, selectedId: "none" };
  }
  return null;
}

export function parseMcpsPanelRoute(route: ParsedInteractionRoute): McpsPanelRoute | null {
  if (route.namespace !== MCPS_ROUTE_NAMESPACE || route.version !== MCPS_ROUTE_VERSION) {
    return null;
  }

  const [rawWireToken, rawLocale, ...tail] = route.segments;
  if (!rawWireToken || !rawLocale) return null;

  const locale = parseLocale(rawLocale);
  if (!locale) return null;

  const entry = CODECS_BY_WIRE_TOKEN.get(rawWireToken);
  if (!entry) return null;

  const canonical = decodeRouteSegments<McpsPanelRoute>(entry.codec, entry.action, locale, tail);
  if (canonical) return canonical;

  return decodeCompatibilityRoute(entry.action, locale, tail);
}
