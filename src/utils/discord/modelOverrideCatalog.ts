import { createHash } from "node:crypto";
import type { LlmRow } from "@/types/db/schema";
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

export const MODEL_OVERRIDE_ROUTE_NAMESPACE = "model-overrides";
export const MODEL_OVERRIDE_ROUTE_VERSION = "v1";
export const MODEL_OVERRIDE_MODAL_CAPACITY = 50;

export type ChannelOverrideEntry = {
  scope: "channel";
  channelDiscId: string;
  llm: LlmRow;
};

export type PersonaOverrideEntry = {
  scope: "persona";
  persona_id: number;
  persona_nickname: string;
  persona_llm: LlmRow;
};

export type ModelOverrideEntry = ChannelOverrideEntry | PersonaOverrideEntry;

export type ModelOverridePanelRoute =
  | { action: "page"; locale: string; page: number }
  | { action: "remove-submit"; locale: string; page: number; fp: string; nonce: string };

type ModelOverrideAction = ModelOverridePanelRoute["action"];

type ModelOverrideRouteForAction<A extends ModelOverrideAction> = ModelOverridePanelRoute extends infer R
  ? R extends { action: string }
    ? A extends R["action"]
      ? R & { action: A }
      : never
    : never
  : never;

type ModelOverrideRouteCodecs = {
  [A in ModelOverrideAction]: RouteCodec<ModelOverrideRouteForAction<A>>;
};

const pageField: RouteFieldCodec<"page", number> = {
  key: "page",
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

const MODEL_OVERRIDE_ROUTE_CODECS: ModelOverrideRouteCodecs = {
  page: {
    wireToken: "page",
    fields: [pageField],
  },
  "remove-submit": {
    wireToken: "remove-submit",
    fields: [pageField, fpField, nonceField],
  },
};

const CODECS_BY_WIRE_TOKEN = indexCodecsByWireToken<ModelOverrideAction, ModelOverridePanelRoute>(
  MODEL_OVERRIDE_ROUTE_CODECS,
);

function buildModelOverrideRouteSegments(route: ModelOverridePanelRoute): string[] {
  return buildRouteSegments(MODEL_OVERRIDE_ROUTE_CODECS[route.action], route);
}

export function buildModelOverrideRouteId(route: ModelOverridePanelRoute): string {
  return buildInteractionRouteId(
    MODEL_OVERRIDE_ROUTE_NAMESPACE,
    MODEL_OVERRIDE_ROUTE_VERSION,
    ...buildModelOverrideRouteSegments(route),
  );
}

export function parseModelOverridePanelRoute(route: ParsedInteractionRoute): ModelOverridePanelRoute | null {
  if (route.namespace !== MODEL_OVERRIDE_ROUTE_NAMESPACE || route.version !== MODEL_OVERRIDE_ROUTE_VERSION) {
    return null;
  }

  const [rawWireToken, rawLocale, ...tail] = route.segments;
  if (!rawWireToken || !rawLocale) return null;

  const locale = parseLocale(rawLocale);
  if (!locale) return null;

  const entry = CODECS_BY_WIRE_TOKEN.get(rawWireToken);
  if (!entry) return null;

  return decodeRouteSegments<ModelOverridePanelRoute>(entry.codec, entry.action, locale, tail);
}

/**
 * Fingerprint exact batch content including scope, stable target ID, llm_id, and page.
 * Exactly 8 base64url characters.
 */
export function computeModelOverrideBatchFingerprint(entries: readonly ModelOverrideEntry[], page: number): string {
  const tuples = entries.map((entry) => [
    entry.scope,
    entry.scope === "channel" ? entry.channelDiscId : String(entry.persona_id),
    entry.scope === "channel" ? entry.llm.llm_id : entry.persona_llm.llm_id,
  ]);
  return createHash("sha256")
    .update(`model-overrides:${page}:${JSON.stringify(tuples)}`)
    .digest("base64url")
    .slice(0, 8);
}

/**
 * Data ordering contract: sort channel entries first by channelDiscId,
 * then persona entries by persona_nickname with numeric persona_id tie-breaker.
 */
export function sortModelOverrideEntries(
  channelEntries: readonly ChannelOverrideEntry[],
  personaEntries: readonly PersonaOverrideEntry[],
): ModelOverrideEntry[] {
  const sortedChannels = [...channelEntries].sort((a, b) => a.channelDiscId.localeCompare(b.channelDiscId));
  const sortedPersonas = [...personaEntries].sort((a, b) => {
    const nameDiff = a.persona_nickname.localeCompare(b.persona_nickname);
    if (nameDiff !== 0) return nameDiff;
    return a.persona_id - b.persona_id;
  });
  return [...sortedChannels, ...sortedPersonas];
}
