import { buildInteractionRouteId, type ParsedInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import {
  buildRouteSegments,
  decodeRouteSegments,
  indexCodecsByWireToken,
  parseNonNegativeInt,
  parsePositiveId,
  type RouteCodec,
  type RouteFieldCodec,
} from "@/utils/discord/panelRouteCodec";
import { parseLocale } from "@/utils/discord/panelRouteTokens";

export const STATUS_ROUTE_NAMESPACE = "status";
export const STATUS_ROUTE_VERSION = "v1";
export const STATUS_PERSONA_SELECT_PAGE_SIZE = 25;

export type StatusCategory = "persona" | "behavior" | "models" | "access" | "personal";

export type StatusDashboardRoute =
  | { action: "category"; locale: string; category: StatusCategory; personaId?: number }
  | { action: "page"; locale: string; category: StatusCategory; personaId?: number }
  | { action: "persona-select"; locale: string; personaId: number }
  | { action: "persona-page"; locale: string; personaId: number; start: number };

type StatusDashboardAction = StatusDashboardRoute["action"];

type StatusDashboardRouteForAction<A extends StatusDashboardAction> = StatusDashboardRoute extends infer R
  ? R extends { action: string }
    ? A extends R["action"]
      ? R & { action: A }
      : never
    : never
  : never;

type StatusDashboardRouteCodecs = {
  [A in StatusDashboardAction]: RouteCodec<StatusDashboardRouteForAction<A>>;
};

function parseCategory(value: string | undefined): StatusCategory | null {
  if (value === "persona" || value === "behavior" || value === "models" || value === "access" || value === "personal") {
    return value;
  }
  return null;
}

const categoryField: RouteFieldCodec<"category", StatusCategory> = {
  key: "category",
  encode: (value) => String(value),
  decode: (value) => parseCategory(value),
};

const personaIdField: RouteFieldCodec<"personaId", number> = {
  key: "personaId",
  encode: (value) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error("Status persona IDs must be positive safe integers");
    }
    return String(value);
  },
  decode: (value) => parsePositiveId(value),
};

const optionalPersonaIdField: RouteFieldCodec<"personaId", number> = {
  ...personaIdField,
  optional: true,
};

const personaRangeField: RouteFieldCodec<"start", number> = {
  key: "start",
  encode: (value) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error("Status persona range starts must be non-negative safe integers");
    }
    return String(value);
  },
  decode: (value) => parseNonNegativeInt(value),
};

const STATUS_ROUTE_CODECS: StatusDashboardRouteCodecs = {
  category: { wireToken: "category", fields: [categoryField, optionalPersonaIdField] },
  page: { wireToken: "page", fields: [categoryField, optionalPersonaIdField] },
  "persona-select": { wireToken: "persona-select", fields: [personaIdField] },
  "persona-page": { wireToken: "persona-page", fields: [personaIdField, personaRangeField] },
};

const CODECS_BY_WIRE_TOKEN = indexCodecsByWireToken<StatusDashboardAction, StatusDashboardRoute>(STATUS_ROUTE_CODECS);

function buildStatusDashboardRouteSegments(route: StatusDashboardRoute): string[] {
  return buildRouteSegments(STATUS_ROUTE_CODECS[route.action], route);
}

export function buildStatusDashboardRouteId(route: StatusDashboardRoute): string {
  return buildInteractionRouteId(
    STATUS_ROUTE_NAMESPACE,
    STATUS_ROUTE_VERSION,
    ...buildStatusDashboardRouteSegments(route),
  );
}

export function buildStatusCategoryButtonId(
  locale: string,
  category: StatusCategory,
  personaId?: number | null,
): string {
  return buildStatusDashboardRouteId({ action: "category", locale, category, personaId: personaId ?? undefined });
}

export function buildStatusPageSelectorId(locale: string, category: StatusCategory, personaId?: number | null): string {
  return buildStatusDashboardRouteId({ action: "page", locale, category, personaId: personaId ?? undefined });
}

export function buildStatusPersonaSelectorId(locale: string, personaId: number): string {
  return buildStatusDashboardRouteId({ action: "persona-select", locale, personaId });
}

export function buildStatusPersonaRangeId(locale: string, personaId: number, start: number): string {
  return buildStatusDashboardRouteId({ action: "persona-page", locale, personaId, start });
}

export function buildStatusPersonaRangeSegments(locale: string, personaId: number, start: number): string[] {
  return buildStatusDashboardRouteSegments({ action: "persona-page", locale, personaId, start });
}

export function parseStatusDashboardRoute(route: ParsedInteractionRoute): StatusDashboardRoute | null {
  if (route.namespace !== STATUS_ROUTE_NAMESPACE || route.version !== STATUS_ROUTE_VERSION) return null;

  const [rawWireToken, rawLocale, ...tail] = route.segments;
  if (!rawWireToken || !rawLocale) return null;

  const locale = parseLocale(rawLocale);
  if (!locale) return null;

  const entry = CODECS_BY_WIRE_TOKEN.get(rawWireToken);
  if (!entry) return null;

  return decodeRouteSegments<StatusDashboardRoute>(entry.codec, entry.action, locale, tail);
}

export function parseStatusPageSelection(value: string | undefined): number | null {
  return parseNonNegativeInt(value);
}

export function parseStatusPersonaSelection(value: string | undefined): number | null {
  return parsePositiveId(value);
}

export function parseStatusPersonaRange(value: string | undefined): number | null {
  return parseNonNegativeInt(value);
}
