import { buildInteractionRouteId, type ParsedInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import { getSupportedLocales } from "@/utils/text/localizer";

export const ST_PRESETS_ROUTE_NAMESPACE = "st-presets";
export const ST_PRESETS_ROUTE_VERSION = "v1";

export type StPresetsPanelRoute =
  | { action: "select" | "retry" | "none" | "disable" | "add-open"; locale: string }
  | { action: "range"; locale: string; rangeIndex: number }
  | { action: "add-submit"; locale: string; nonce: string }
  | { action: "nodes-open" | "delete-prompt" | "delete-cancel" | "delete-confirm"; locale: string; presetId: number }
  | { action: "nodes-range"; locale: string; presetId: number; rangeIndex: number }
  | { action: "nodes-page"; locale: string; presetId: number; chooserPage: number }
  | { action: "nodes-submit"; locale: string; presetId: number; nonce: string };

export function buildStPresetsCustomId(action: string, ...segments: Array<string | number>): string {
  return buildInteractionRouteId(ST_PRESETS_ROUTE_NAMESPACE, ST_PRESETS_ROUTE_VERSION, action, ...segments.map(String));
}

function parseLocale(value: string | undefined): string | null {
  return value && getSupportedLocales().includes(value) ? value : null;
}

function parsePositiveId(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseNonNegativeInt(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseNonce(value: string | undefined): string | null {
  return value && /^[A-Za-z0-9_-]{8,32}$/.test(value) ? value : null;
}

export function parseStPresetsPanelRoute(route: ParsedInteractionRoute): StPresetsPanelRoute | null {
  if (route.namespace !== ST_PRESETS_ROUTE_NAMESPACE || route.version !== ST_PRESETS_ROUTE_VERSION) {
    return null;
  }

  const [action, rawLocale, first, second] = route.segments;
  const locale = parseLocale(rawLocale);
  if (!locale || !action) return null;

  if (route.segments.length === 2) {
    if (
      action === "select" ||
      action === "retry" ||
      action === "none" ||
      action === "disable" ||
      action === "add-open"
    ) {
      return { action, locale };
    }
    return null;
  }

  if (route.segments.length === 3) {
    if (action === "range") {
      const rangeIndex = parseNonNegativeInt(first);
      return rangeIndex === null ? null : { action, locale, rangeIndex };
    }
    if (action === "add-submit") {
      const nonce = parseNonce(first);
      return nonce === null ? null : { action, locale, nonce };
    }
    if (
      action === "nodes-open" ||
      action === "delete-prompt" ||
      action === "delete-cancel" ||
      action === "delete-confirm"
    ) {
      const presetId = parsePositiveId(first);
      return presetId === null ? null : { action, locale, presetId };
    }
    return null;
  }

  if (route.segments.length === 4) {
    const presetId = parsePositiveId(first);
    if (presetId === null) return null;

    if (action === "nodes-range") {
      const rangeIndex = parseNonNegativeInt(second);
      return rangeIndex === null ? null : { action, locale, presetId, rangeIndex };
    }
    if (action === "nodes-page") {
      const chooserPage = parseNonNegativeInt(second);
      return chooserPage === null ? null : { action, locale, presetId, chooserPage };
    }
    if (action === "nodes-submit") {
      const nonce = parseNonce(second);
      return nonce === null ? null : { action, locale, presetId, nonce };
    }
    return null;
  }

  return null;
}
