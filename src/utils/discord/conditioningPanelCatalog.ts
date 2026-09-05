import { createHash } from "node:crypto";
import type { ConditioningGroup } from "@/utils/db/repositories/ConditioningMemoryRepository";
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

export const CONDITIONING_ROUTE_NAMESPACE = "conditioning";
export const CONDITIONING_ROUTE_VERSION = "v1";

export type ConditioningAggregateEntry = ConditioningGroup & {
  serverId: number;
  personaName: string;
  personaLineageId: number;
};

export type ConditioningPanelRoute =
  | { action: "range"; locale: string; range: number }
  | { action: "remove-open"; locale: string; range: number; fp: string }
  | { action: "remove-submit"; locale: string; range: number; fp: string; nonce: string };

export type ConditioningAction = ConditioningPanelRoute["action"];

type ConditioningRouteForAction<A extends ConditioningAction> = ConditioningPanelRoute extends infer R
  ? R extends { action: string }
    ? A extends R["action"]
      ? R & { action: A }
      : never
    : never
  : never;

export type ConditioningRouteCodecs = {
  [A in ConditioningAction]: RouteCodec<ConditioningRouteForAction<A>>;
};

const rangeField: RouteFieldCodec<"range", number> = {
  key: "range",
  encode: (v) => String(v),
  decode: (v) => parseNonNegativeInt(v),
};

function parseFingerprint(value: string | undefined): string | null {
  return value && /^[A-Za-z0-9_-]{8}$/.test(value) ? value : null;
}

const fpField: RouteFieldCodec<"fp", string> = {
  key: "fp",
  encode: (v) => String(v),
  decode: (v) => parseFingerprint(v),
};

const nonceField: RouteFieldCodec<"nonce", string> = {
  key: "nonce",
  encode: (v) => String(v),
  decode: (v) => parseNonce(v),
};

export const CONDITIONING_ROUTE_CODECS: ConditioningRouteCodecs = {
  range: {
    wireToken: "range",
    fields: [rangeField],
  },
  "remove-open": {
    wireToken: "remove-open",
    fields: [rangeField, fpField],
  },
  "remove-submit": {
    wireToken: "remove-submit",
    fields: [rangeField, fpField, nonceField],
  },
};

const CODECS_BY_WIRE_TOKEN = indexCodecsByWireToken<ConditioningAction, ConditioningPanelRoute>(
  CONDITIONING_ROUTE_CODECS,
);

export function listConditioningPanelActions(): ConditioningAction[] {
  return Object.keys(CONDITIONING_ROUTE_CODECS) as ConditioningAction[];
}

export function buildConditioningRouteSegments(route: ConditioningPanelRoute): string[] {
  return buildRouteSegments(CONDITIONING_ROUTE_CODECS[route.action], route);
}

export function buildConditioningRouteId(route: ConditioningPanelRoute): string {
  return buildInteractionRouteId(
    CONDITIONING_ROUTE_NAMESPACE,
    CONDITIONING_ROUTE_VERSION,
    ...buildConditioningRouteSegments(route),
  );
}

export function parseConditioningPanelRoute(route: ParsedInteractionRoute): ConditioningPanelRoute | null {
  if (route.namespace !== CONDITIONING_ROUTE_NAMESPACE || route.version !== CONDITIONING_ROUTE_VERSION) {
    return null;
  }

  const [rawWireToken, rawLocale, ...tail] = route.segments;
  if (!rawWireToken || !rawLocale) return null;

  const locale = parseLocale(rawLocale);
  if (!locale) return null;

  const entry = CODECS_BY_WIRE_TOKEN.get(rawWireToken);
  if (!entry) return null;

  return decodeRouteSegments<ConditioningPanelRoute>(entry.codec, entry.action, locale, tail);
}

export interface ConditioningFingerprintEntry {
  conditioningType: string;
  actionKey: string;
  reasonNormalized: string;
  personaLineageId: number;
}

export function computeConditioningAggregateFingerprint(
  entries: readonly ConditioningFingerprintEntry[],
  range: number,
): string {
  const tuples = entries.map((entry) => [
    entry.conditioningType,
    entry.actionKey,
    entry.reasonNormalized,
    entry.personaLineageId,
  ]);
  return createHash("sha256")
    .update(`conditioning-aggregate:${range}:${JSON.stringify(tuples)}`)
    .digest("base64url")
    .slice(0, 8);
}
