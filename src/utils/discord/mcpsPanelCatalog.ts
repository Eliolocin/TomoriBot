import { buildInteractionRouteId, type ParsedInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import { getSupportedLocales } from "@/utils/text/localizer";
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

export function buildMcpsCustomId(action: string, ...segments: Array<string | number>): string {
  return buildInteractionRouteId(MCPS_ROUTE_NAMESPACE, MCPS_ROUTE_VERSION, action, ...segments.map(String));
}

function parseLocale(value: string | undefined): string | null {
  return value && getSupportedLocales().includes(value) ? value : null;
}

function parsePositiveId(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseRange(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseServerType(value: string | undefined): McpServerType | null {
  return MCP_SERVER_TYPES.find((candidate) => candidate === value) ?? null;
}

export function parseMcpsPanelRoute(route: ParsedInteractionRoute): McpsPanelRoute | null {
  if (route.namespace !== MCPS_ROUTE_NAMESPACE || route.version !== MCPS_ROUTE_VERSION) return null;
  const [action, rawLocale, first, second] = route.segments;
  const locale = parseLocale(rawLocale);
  if (!locale || !action) return null;

  if ((action === "select" || action === "range") && route.segments.length === 3) {
    const rangeIndex = parseRange(first);
    return rangeIndex === null ? null : { action, locale, rangeIndex };
  }
  if ((action === "retry" || action === "refresh") && route.segments.length === 3) {
    if (first === "none" || (action === "refresh" && first === "add")) {
      return { action, locale, selectedId: "none" };
    }
    const selectedId = parsePositiveId(first);
    return selectedId === null ? null : { action, locale, selectedId };
  }
  if (action === "add-open" && route.segments.length === 2) return { action, locale };
  if (action === "add-open" && route.segments.length === 3) {
    return parseServerType(first) ? { action, locale } : null;
  }
  if (action === "add-page" && route.segments.length === 3) {
    const serverType = parseServerType(first);
    return serverType ? { action, locale, serverType } : null;
  }
  if (action === "add-type" && route.segments.length === 2) return { action, locale };
  if (action === "add-submit" && route.segments.length === 3) {
    if (!first || !/^[A-Za-z0-9_-]{8,32}$/.test(first)) return null;
    return { action, locale, nonce: first };
  }
  if (action === "add-submit" && route.segments.length === 4) {
    const serverType = parseServerType(first);
    if (!serverType || !second || !/^[A-Za-z0-9_-]{8,32}$/.test(second)) return null;
    return { action, locale, nonce: second, legacyServerType: serverType };
  }
  if (action === "set-enabled" && route.segments.length === 4) {
    const entityId = parsePositiveId(first);
    if (entityId === null || (second !== "0" && second !== "1")) return null;
    return { action, locale, entityId, enabled: second === "1" };
  }
  if (
    (action === "remove-prompt" || action === "remove-cancel" || action === "remove-confirm") &&
    route.segments.length === 3
  ) {
    const entityId = parsePositiveId(first);
    return entityId === null ? null : { action, locale, entityId };
  }
  return null;
}
