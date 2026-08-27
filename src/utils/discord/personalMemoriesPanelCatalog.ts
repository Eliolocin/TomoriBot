import { buildInteractionRouteId, type ParsedInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import { getSupportedLocales } from "@/utils/text/localizer";

export const PERSONAL_MEMORIES_ROUTE_NAMESPACE = "personal-memories";
export const PERSONAL_MEMORIES_ROUTE_VERSION = "v1";

export type PersonalMemoriesCategory = "global" | "persona";

export type PersonalMemoriesPanelRoute =
  | { action: "category"; locale: string; category: PersonalMemoriesCategory }
  | { action: "persona-select"; locale: string; category: "persona"; lineageId: number }
  | {
      action: "select";
      locale: string;
      category: PersonalMemoriesCategory;
      lineageId: number;
      rangeIndex?: number;
    }
  | { action: "range-open" | "range-cancel"; locale: string; category: PersonalMemoriesCategory; lineageId: number }
  | { action: "range"; locale: string; category: PersonalMemoriesCategory; lineageId: number; rangeIndex: number }
  | { action: "range-page"; locale: string; category: PersonalMemoriesCategory; lineageId: number; chooserPage: number }
  | { action: "add-submit"; locale: string; category: PersonalMemoriesCategory; lineageId: number; nonce: string }
  | {
      action: "edit-open" | "remove-prompt" | "remove-confirm" | "remove-cancel";
      locale: string;
      category: PersonalMemoriesCategory;
      lineageId: number;
      memoryId: number;
    }
  | {
      action: "edit-submit";
      locale: string;
      category: PersonalMemoriesCategory;
      lineageId: number;
      memoryId: number;
      nonce: string;
    }
  | { action: "stm-clear"; locale: string; category: PersonalMemoriesCategory; lineageId: number }
  | { action: "retry" | "refresh"; locale: string; category: PersonalMemoriesCategory; lineageId: number };

export function buildPersonalMemoriesCustomId(
  action: string,
  locale: string,
  ...segments: Array<string | number>
): string {
  return buildInteractionRouteId(
    PERSONAL_MEMORIES_ROUTE_NAMESPACE,
    PERSONAL_MEMORIES_ROUTE_VERSION,
    action,
    locale,
    ...segments.map(String),
  );
}

function parseLocale(value: string | undefined): string | null {
  return value && getSupportedLocales().includes(value) ? value : null;
}

function parseCategory(value: string | undefined): PersonalMemoriesCategory | null {
  if (value === "global" || value === "persona") return value;
  return null;
}

function parseNonNegativeInt(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parsePositiveId(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseNonce(value: string | undefined): string | null {
  return value && /^[A-Za-z0-9_-]{8,32}$/.test(value) ? value : null;
}

export function parsePersonalMemoriesPanelRoute(route: ParsedInteractionRoute): PersonalMemoriesPanelRoute | null {
  if (route.namespace !== PERSONAL_MEMORIES_ROUTE_NAMESPACE || route.version !== PERSONAL_MEMORIES_ROUTE_VERSION) {
    return null;
  }

  const [action, rawLocale, rawCategory, first, second, third] = route.segments;
  const locale = parseLocale(rawLocale);
  if (!locale || !action) return null;

  const category = parseCategory(rawCategory);
  if (!category) return null;

  if (action === "category" && route.segments.length === 3) {
    return { action, locale, category };
  }

  const lineageId = parseNonNegativeInt(first);
  if (lineageId === null) return null;

  if (action === "persona-select" && route.segments.length === 4) {
    if (category !== "persona" || lineageId === 0) return null;
    return { action, locale, category, lineageId };
  }

  if (action === "select") {
    if (route.segments.length === 4) {
      return { action, locale, category, lineageId };
    }
    if (route.segments.length === 5) {
      const rangeIndex = parseNonNegativeInt(second);
      return rangeIndex === null ? null : { action, locale, category, lineageId, rangeIndex };
    }
    return null;
  }

  if ((action === "range-open" || action === "range-cancel") && route.segments.length === 4) {
    return { action, locale, category, lineageId };
  }

  if (action === "range" && route.segments.length === 5) {
    const rangeIndex = parseNonNegativeInt(second);
    return rangeIndex === null ? null : { action, locale, category, lineageId, rangeIndex };
  }

  if (action === "range-page" && route.segments.length === 5) {
    const chooserPage = parseNonNegativeInt(second);
    return chooserPage === null ? null : { action, locale, category, lineageId, chooserPage };
  }

  if (action === "add-submit" && route.segments.length === 5) {
    const nonce = parseNonce(second);
    return nonce === null ? null : { action, locale, category, lineageId, nonce };
  }

  if (
    (action === "edit-open" ||
      action === "remove-prompt" ||
      action === "remove-confirm" ||
      action === "remove-cancel") &&
    route.segments.length === 5
  ) {
    const memoryId = parsePositiveId(second);
    return memoryId === null ? null : { action, locale, category, lineageId, memoryId };
  }

  if (action === "edit-submit" && route.segments.length === 6) {
    const memoryId = parsePositiveId(second);
    const nonce = parseNonce(third);
    return memoryId === null || nonce === null ? null : { action, locale, category, lineageId, memoryId, nonce };
  }

  if (action === "stm-clear" && route.segments.length === 4) {
    return { action, locale, category, lineageId };
  }

  if ((action === "retry" || action === "refresh") && route.segments.length === 4) {
    return { action, locale, category, lineageId };
  }

  return null;
}
