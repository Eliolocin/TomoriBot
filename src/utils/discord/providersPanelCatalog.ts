import { buildInteractionRouteId, type ParsedInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import { parseLocale } from "@/utils/discord/panelRouteTokens";
import type { CustomEndpointCapability } from "@/types/db/schema";

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

export function buildProvidersCustomId(action: string, ...segments: Array<string | number>): string {
  return buildProvidersCustomIdForNamespace(PROVIDERS_ROUTE_NAMESPACE, action, ...segments);
}

export function buildProvidersCustomIdForNamespace(
  namespace: ProvidersRouteNamespace,
  action: string,
  ...segments: Array<string | number>
): string {
  return buildInteractionRouteId(namespace, PROVIDERS_ROUTE_VERSION, action, ...segments.map(String));
}

function parseNonNegativeInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseEntry(
  kind: string | undefined,
  key: string | undefined,
): {
  entryKind: "provider" | "endpoint";
  entryKey: string;
} | null {
  if (kind === "provider" && key && /^[a-z0-9_-]{1,40}$/.test(key)) {
    return { entryKind: kind, entryKey: key };
  }
  if (kind === "endpoint" && key && parseNonNegativeInteger(key) !== null && key !== "0") {
    return { entryKind: kind, entryKey: key };
  }
  return null;
}

function parseRemovalEntry(
  kind: string | undefined,
  key: string | undefined,
): { entryKind: "provider" | "endpoint" | "brave"; entryKey: string } | null {
  if (kind === "brave" && key === "brave") return { entryKind: kind, entryKey: key };
  return parseEntry(kind, key);
}

export function parseProvidersPanelRoute(
  route: ParsedInteractionRoute,
  namespace: ProvidersRouteNamespace = PROVIDERS_ROUTE_NAMESPACE,
): ProvidersPanelRoute | null {
  if (route.namespace !== namespace || route.version !== PROVIDERS_ROUTE_VERSION) return null;

  const [action, rawLocale, rawRange, rawNonce] = route.segments;
  const locale = parseLocale(rawLocale);
  if (!locale || !action) return null;

  if (
    route.segments.length === 2 &&
    (action === "select" || action === "retry" || action === "range-open" || action === "range-cancel")
  ) {
    return { action, locale };
  }
  if (route.segments.length === 3 && (action === "range" || action === "range-page")) {
    const rangeIndex = parseNonNegativeInteger(rawRange);
    return rangeIndex === null ? null : { action, locale, rangeIndex };
  }
  if (
    route.segments.length === 4 &&
    (action === "model-open" || action === "model-select" || action === "model-close")
  ) {
    const entry = parseEntry(rawRange, rawNonce);
    return entry ? { action, locale, ...entry } : null;
  }
  if (
    route.segments.length === 4 &&
    (action === "remove-prompt" || action === "remove-cancel" || action === "remove-confirm")
  ) {
    const entry = parseRemovalEntry(rawRange, rawNonce);
    return entry ? { action, locale, ...entry } : null;
  }
  if (route.segments.length === 5 && action === "model-range") {
    const entry = parseEntry(rawRange, rawNonce);
    const rangeIndex = parseNonNegativeInteger(route.segments[4]);
    return entry && rangeIndex !== null ? { action, locale, ...entry, rangeIndex } : null;
  }
  if (route.segments.length === 7 && action === "model-submit") {
    const entry = parseEntry(rawRange, rawNonce);
    const capability = ["text", "embedding", "image", "video", "speech", "transcription"].find(
      (value) => value === route.segments[4],
    ) as CustomEndpointCapability | undefined;
    const modelId = parseNonNegativeInteger(route.segments[5]);
    const nonce = route.segments[6];
    if (!entry || !capability || modelId === null || !nonce || !/^[A-Za-z0-9_-]{8,32}$/.test(nonce)) return null;
    return {
      action,
      locale,
      ...entry,
      capability,
      editingModelId: modelId === 0 ? null : modelId,
      nonce,
    };
  }
  if (route.segments.length === 3 && action === "add-submit") {
    if (!rawRange || !/^[A-Za-z0-9_-]{8,32}$/.test(rawRange)) return null;
    return { action, locale, nonce: rawRange };
  }
  if (route.segments.length === 4 && action === "edit-provider-open") {
    const provider = rawRange;
    const rotationKeyCount = parseNonNegativeInteger(rawNonce);
    return provider && /^[a-z0-9_-]{1,40}$/.test(provider) && rotationKeyCount !== null
      ? { action, locale, provider, rotationKeyCount }
      : null;
  }
  if (route.segments.length === 4 && action === "edit-provider-submit") {
    const provider = rawRange;
    return provider && /^[a-z0-9_-]{1,40}$/.test(provider) && rawNonce && /^[A-Za-z0-9_-]{8,32}$/.test(rawNonce)
      ? { action, locale, provider, nonce: rawNonce }
      : null;
  }
  if (route.segments.length === 3 && action === "edit-endpoint-open") {
    const connectionId = parseNonNegativeInteger(rawRange);
    return connectionId && connectionId > 0 ? { action, locale, connectionId } : null;
  }
  if (route.segments.length === 4 && action === "edit-endpoint-submit") {
    const connectionId = parseNonNegativeInteger(rawRange);
    return connectionId && connectionId > 0 && rawNonce && /^[A-Za-z0-9_-]{8,32}$/.test(rawNonce)
      ? { action, locale, connectionId, nonce: rawNonce }
      : null;
  }
  if (route.segments.length === 3 && action === "endpoint-submit") {
    if (!rawRange || !/^[A-Za-z0-9_-]{8,32}$/.test(rawRange)) return null;
    return { action, locale, nonce: rawRange };
  }
  return null;
}
