import type { CustomEndpointCapability } from "@/types/db/schema";
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

export const PROVIDERS_ROUTE_NAMESPACE = "providers";
export const PERSONAL_PROVIDERS_ROUTE_NAMESPACE = "personal-providers";
export const PROVIDERS_ROUTE_VERSION = "v1";

export type ProvidersRouteNamespace = typeof PROVIDERS_ROUTE_NAMESPACE | typeof PERSONAL_PROVIDERS_ROUTE_NAMESPACE;

export type ProvidersPanelRoute =
  | { action: "select" | "retry" | "range-open" | "range-cancel"; locale: string }
  | { action: "range" | "range-page"; locale: string; rangeIndex: number }
  | {
      action: "model-open" | "model-select" | "model-close";
      locale: string;
      entryKind: "provider" | "endpoint";
      entryKey: string;
    }
  | { action: "edit-provider-open"; locale: string; provider: string; rotationKeyCount: number }
  | { action: "edit-provider-submit"; locale: string; provider: string; nonce: string }
  | { action: "edit-endpoint-open"; locale: string; connectionId: number }
  | { action: "edit-endpoint-submit"; locale: string; connectionId: number; nonce: string }
  | {
      action: "remove-prompt" | "remove-cancel" | "remove-confirm";
      locale: string;
      entryKind: "provider" | "endpoint" | "brave";
      entryKey: string;
    }
  | {
      action: "model-range";
      locale: string;
      entryKind: "provider" | "endpoint";
      entryKey: string;
      rangeIndex: number;
    }
  | {
      action: "model-submit";
      locale: string;
      entryKind: "provider" | "endpoint";
      entryKey: string;
      capability: CustomEndpointCapability;
      editingModelId: number | null;
      nonce: string;
    }
  | { action: "add-submit"; locale: string; nonce: string }
  | { action: "endpoint-submit"; locale: string; nonce: string };

export type ProvidersAction = ProvidersPanelRoute["action"];

type ProvidersRouteForAction<A extends ProvidersAction> = ProvidersPanelRoute extends infer R
  ? R extends { action: string }
    ? A extends R["action"]
      ? R & { action: A }
      : never
    : never
  : never;

export type ProvidersRouteCodecs = {
  [A in ProvidersAction]: RouteCodec<ProvidersRouteForAction<A>>;
};

const rangeIndexField: RouteFieldCodec<"rangeIndex", number> = {
  key: "rangeIndex",
  encode: (v) => String(v),
  decode: (v) => parseNonNegativeInt(v),
};

const entryKindField: RouteFieldCodec<"entryKind", "provider" | "endpoint"> = {
  key: "entryKind",
  encode: (v) => String(v),
  decode: (v) => (v === "provider" || v === "endpoint" ? v : null),
};

const entryKeyField: RouteFieldCodec<"entryKey", string> = {
  key: "entryKey",
  encode: (v) => String(v),
  decode: (v, r) => {
    if (r.entryKind === "provider") return /^[a-z0-9_-]{1,40}$/.test(v) ? v : null;
    if (r.entryKind === "endpoint") return parsePositiveId(v) !== null ? v : null;
    return null;
  },
};

const removalEntryKindField: RouteFieldCodec<"entryKind", "provider" | "endpoint" | "brave"> = {
  key: "entryKind",
  encode: (v) => String(v),
  decode: (v) => (v === "provider" || v === "endpoint" || v === "brave" ? v : null),
};

const removalEntryKeyField: RouteFieldCodec<"entryKey", string> = {
  key: "entryKey",
  encode: (v) => String(v),
  decode: (v, r) => {
    if (r.entryKind === "brave") return v === "brave" ? "brave" : null;
    if (r.entryKind === "provider") return /^[a-z0-9_-]{1,40}$/.test(v) ? v : null;
    if (r.entryKind === "endpoint") return parsePositiveId(v) !== null ? v : null;
    return null;
  },
};

const providerField: RouteFieldCodec<"provider", string> = {
  key: "provider",
  encode: (v) => String(v),
  decode: (v) => (/^[a-z0-9_-]{1,40}$/.test(v) ? v : null),
};

const rotationKeyCountField: RouteFieldCodec<"rotationKeyCount", number> = {
  key: "rotationKeyCount",
  encode: (v) => String(v),
  decode: (v) => parseNonNegativeInt(v),
};

const connectionIdField: RouteFieldCodec<"connectionId", number> = {
  key: "connectionId",
  encode: (v) => String(v),
  decode: (v) => parsePositiveId(v),
};

const capabilityField: RouteFieldCodec<"capability", CustomEndpointCapability> = {
  key: "capability",
  encode: (v) => String(v),
  decode: (v) =>
    ["text", "embedding", "image", "video", "speech", "transcription"].includes(v as CustomEndpointCapability)
      ? (v as CustomEndpointCapability)
      : null,
};

const editingModelIdField: RouteFieldCodec<"editingModelId", number | null> = {
  key: "editingModelId",
  encode: (v) => (v === null || v === 0 ? "0" : String(v)),
  decode: (v) => (v === "0" ? 0 : parsePositiveId(v)),
};

const nonceField: RouteFieldCodec<"nonce", string> = {
  key: "nonce",
  encode: (v) => String(v),
  decode: (v) => parseNonce(v),
};

/**
 * Authoritative codec table for all provider routes across workspace and personal namespaces.
 * Keyed by semantic action to guarantee compile-time exhaustiveness.
 * Preserves the exact v1 wire format: wire token, locale, and ordered field serialization.
 */
export const PROVIDERS_ROUTE_CODECS: ProvidersRouteCodecs = {
  "add-submit": {
    wireToken: "add-submit",
    fields: [nonceField],
  },
  "edit-endpoint-open": {
    wireToken: "edit-endpoint-open",
    fields: [connectionIdField],
  },
  "edit-endpoint-submit": {
    wireToken: "edit-endpoint-submit",
    fields: [connectionIdField, nonceField],
  },
  "edit-provider-open": {
    wireToken: "edit-provider-open",
    fields: [providerField, rotationKeyCountField],
  },
  "edit-provider-submit": {
    wireToken: "edit-provider-submit",
    fields: [providerField, nonceField],
  },
  "endpoint-submit": {
    wireToken: "endpoint-submit",
    fields: [nonceField],
  },
  "model-close": {
    wireToken: "model-close",
    fields: [entryKindField, entryKeyField],
  },
  "model-open": {
    wireToken: "model-open",
    fields: [entryKindField, entryKeyField],
  },
  "model-range": {
    wireToken: "model-range",
    fields: [entryKindField, entryKeyField, rangeIndexField],
  },
  "model-select": {
    wireToken: "model-select",
    fields: [entryKindField, entryKeyField],
  },
  "model-submit": {
    wireToken: "model-submit",
    fields: [entryKindField, entryKeyField, capabilityField, editingModelIdField, nonceField],
  },
  range: {
    wireToken: "range",
    fields: [rangeIndexField],
  },
  "range-cancel": {
    wireToken: "range-cancel",
    fields: [],
  },
  "range-open": {
    wireToken: "range-open",
    fields: [],
  },
  "range-page": {
    wireToken: "range-page",
    fields: [rangeIndexField],
  },
  "remove-cancel": {
    wireToken: "remove-cancel",
    fields: [removalEntryKindField, removalEntryKeyField],
  },
  "remove-confirm": {
    wireToken: "remove-confirm",
    fields: [removalEntryKindField, removalEntryKeyField],
  },
  "remove-prompt": {
    wireToken: "remove-prompt",
    fields: [removalEntryKindField, removalEntryKeyField],
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

const CODECS_BY_WIRE_TOKEN = indexCodecsByWireToken<ProvidersAction, ProvidersPanelRoute>(PROVIDERS_ROUTE_CODECS);

export function listProvidersPanelActions(): ProvidersAction[] {
  return Object.keys(PROVIDERS_ROUTE_CODECS) as ProvidersAction[];
}

/**
 * Encodes a typed route object through the authoritative codec table into route segments.
 */
export function buildProvidersRouteSegments(route: ProvidersPanelRoute): string[] {
  return buildRouteSegments(PROVIDERS_ROUTE_CODECS[route.action], route);
}

/**
 * Builds a custom ID from a typed route object and target namespace using the authoritative codec table.
 */
export function buildProvidersRouteId(namespace: ProvidersRouteNamespace, route: ProvidersPanelRoute): string {
  return buildInteractionRouteId(namespace, PROVIDERS_ROUTE_VERSION, ...buildProvidersRouteSegments(route));
}

export function parseProvidersPanelRoute(
  route: ParsedInteractionRoute,
  namespace: ProvidersRouteNamespace = PROVIDERS_ROUTE_NAMESPACE,
): ProvidersPanelRoute | null {
  if (route.namespace !== namespace || route.version !== PROVIDERS_ROUTE_VERSION) {
    return null;
  }

  const [rawWireToken, rawLocale, ...tail] = route.segments;
  if (!rawWireToken || !rawLocale) return null;

  const locale = parseLocale(rawLocale);
  if (!locale) return null;

  const entry = CODECS_BY_WIRE_TOKEN.get(rawWireToken);
  if (!entry) return null;

  const canonical = decodeRouteSegments<ProvidersPanelRoute>(entry.codec, entry.action, locale, tail);
  if (!canonical) return null;

  if (canonical.action === "model-submit") {
    return {
      ...canonical,
      editingModelId: canonical.editingModelId === 0 ? null : canonical.editingModelId,
    };
  }

  return canonical;
}
