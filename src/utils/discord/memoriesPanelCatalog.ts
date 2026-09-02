import { createHash } from "node:crypto";
import { buildInteractionRouteId, type ParsedInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import {
  buildRouteSegments,
  decodeRouteSegments,
  indexCodecsByWireToken,
  parseNonNegativeInt,
  parseNonce,
  parsePositiveId,
  type RouteFieldCodec,
} from "@/utils/discord/panelRouteCodec";
import { parseLocale } from "@/utils/discord/panelRouteTokens";

export const MEMORIES_ROUTE_NAMESPACE = "memories";
export const MEMORIES_ROUTE_VERSION = "v1";

export type MemoriesCategory = "memories" | "documents" | "stm";

export function computeServerStmFingerprint(
  workspaceId: string,
  userDiscId: string,
  entries: readonly { channelId: string; personaId?: number | null }[],
): string {
  const identities = entries.map((entry) => `${entry.channelId}:${entry.personaId ?? "none"}`).join(",");
  return createHash("sha256")
    .update(`memories-stm:${workspaceId}:${userDiscId}:${identities}`)
    .digest("base64url")
    .slice(0, 8);
}

type MemoriesAction =
  | "category"
  | "persona-select"
  | "persona-page"
  | "select"
  | "range"
  | "range-open"
  | "range-page"
  | "range-cancel"
  | "add-submit"
  | "edit-open"
  | "edit-submit"
  | "remove-prompt"
  | "remove-confirm"
  | "remove-cancel"
  | "vectorize-prompt"
  | "vectorize-confirm"
  | "vectorize-submit"
  | "vectorize-cancel"
  | "document-scope"
  | "document-persona-select"
  | "document-persona-page"
  | "document-select"
  | "document-range"
  | "document-range-open"
  | "document-range-page"
  | "document-range-cancel"
  | "document-add-submit"
  | "document-remove-prompt"
  | "document-remove-confirm"
  | "document-remove-cancel"
  | "history-remove-prompt"
  | "history-remove-confirm"
  | "history-remove-cancel"
  | "document-chunk-prev"
  | "document-chunk-next"
  | "document-chunk-edit-open"
  | "document-chunk-edit-submit"
  | "document-chunk-remove-prompt"
  | "document-chunk-remove-confirm"
  | "document-chunk-remove-cancel"
  | "stm-open"
  | "stm-submit"
  | "stm-entry"
  | "retry"
  | "refresh";

export type MemoriesPanelRoute =
  | { action: "category"; locale: string; category: MemoriesCategory }
  | { action: "persona-select"; locale: string; lineageId: number }
  | { action: "persona-page"; locale: string; lineageId: number; rangeIndex: number }
  | { action: "select"; locale: string; lineageId: number; rangeIndex?: number }
  | { action: "range"; locale: string; lineageId: number; rangeIndex: number }
  | { action: "range-open" | "range-cancel"; locale: string; lineageId: number }
  | { action: "range-page"; locale: string; lineageId: number; chooserPage: number }
  | { action: "add-submit"; locale: string; lineageId: number; nonce: string }
  | {
      action: "edit-open" | "remove-prompt" | "remove-confirm" | "remove-cancel";
      locale: string;
      lineageId: number;
      memoryId: number;
    }
  | { action: "edit-submit"; locale: string; lineageId: number; memoryId: number; nonce: string }
  | {
      action: "vectorize-prompt" | "vectorize-confirm" | "vectorize-cancel";
      locale: string;
      lineageId: number;
      personaId: number;
      memoryId: number;
    }
  | {
      action: "vectorize-submit";
      locale: string;
      lineageId: number;
      personaId: number;
      memoryId: number;
      nonce: string;
    }
  | { action: "document-scope" | "document-persona-select"; locale: string; personaId: number }
  | { action: "document-persona-page"; locale: string; personaId: number; rangeIndex: number }
  | { action: "document-select"; locale: string; personaId: number; rangeIndex?: number }
  | { action: "document-range"; locale: string; personaId: number; rangeIndex: number }
  | { action: "document-range-open" | "document-range-cancel"; locale: string; personaId: number }
  | { action: "document-range-page"; locale: string; personaId: number; chooserPage: number }
  | { action: "document-add-submit"; locale: string; personaId: number; nonce: string }
  | {
      action:
        | "document-remove-prompt"
        | "document-remove-confirm"
        | "document-remove-cancel"
        | "history-remove-prompt"
        | "history-remove-confirm"
        | "history-remove-cancel";
      locale: string;
      personaId: number;
      documentId: number;
    }
  | {
      action:
        | "document-chunk-prev"
        | "document-chunk-next"
        | "document-chunk-edit-open"
        | "document-chunk-remove-prompt"
        | "document-chunk-remove-confirm"
        | "document-chunk-remove-cancel";
      locale: string;
      personaId: number;
      documentId: number;
      chunkIdx: number;
    }
  | {
      action: "document-chunk-edit-submit";
      locale: string;
      personaId: number;
      documentId: number;
      chunkIdx: number;
      nonce: string;
    }
  | { action: "stm-open"; locale: string }
  | { action: "stm-submit"; locale: string; nonce: string }
  | { action: "stm-entry"; locale: string; channelId: string; personaId: number }
  | { action: "retry" | "refresh"; locale: string; category: MemoriesCategory; lineageId?: number };

const categoryField: RouteFieldCodec<"category", MemoriesCategory> = {
  key: "category",
  encode: (val) => String(val),
  decode: (raw) => (raw === "memories" || raw === "documents" || raw === "stm" ? raw : null),
};

const lineageIdField: RouteFieldCodec<"lineageId", number> = {
  key: "lineageId",
  encode: (val) => String(val),
  decode: (raw) => parsePositiveId(raw),
};

const optionalLineageIdField: RouteFieldCodec<"lineageId", number> = {
  key: "lineageId",
  optional: true,
  encode: (val) => String(val),
  decode: (raw) => parsePositiveId(raw),
};

const memoryIdField: RouteFieldCodec<"memoryId", number> = {
  key: "memoryId",
  encode: (val) => String(val),
  decode: (raw) => parsePositiveId(raw),
};

const personaIdField: RouteFieldCodec<"personaId", number> = {
  key: "personaId",
  encode: (val) => String(val),
  decode: (raw) => parseNonNegativeInt(raw),
};

const documentIdField: RouteFieldCodec<"documentId", number> = {
  key: "documentId",
  encode: (val) => String(val),
  decode: (raw) => parsePositiveId(raw),
};

const chunkIdxField: RouteFieldCodec<"chunkIdx", number> = {
  key: "chunkIdx",
  encode: (val) => String(val),
  decode: (raw) => parseNonNegativeInt(raw),
};

const channelIdField: RouteFieldCodec<"channelId", string> = {
  key: "channelId",
  encode: (val) => String(val),
  decode: (raw) => (/^\d{17,20}$/.test(raw) ? raw : null),
};

const nonceField: RouteFieldCodec<"nonce", string> = {
  key: "nonce",
  encode: (val) => String(val),
  decode: (raw) => parseNonce(raw),
};

const rangeIndexField: RouteFieldCodec<"rangeIndex", number> = {
  key: "rangeIndex",
  encode: (val) => String(val),
  decode: (raw) => parseNonNegativeInt(raw),
};

const optionalRangeIndexField: RouteFieldCodec<"rangeIndex", number> = {
  key: "rangeIndex",
  optional: true,
  encode: (val) => String(val),
  decode: (raw) => parseNonNegativeInt(raw),
};

const chooserPageField: RouteFieldCodec<"chooserPage", number> = {
  key: "chooserPage",
  encode: (val) => String(val),
  decode: (raw) => parseNonNegativeInt(raw),
};

const MEMORIES_ROUTE_CODECS: Record<
  MemoriesAction,
  { wireToken: string; fields: readonly RouteFieldCodec<string, unknown>[] }
> = {
  category: {
    wireToken: "category",
    fields: [categoryField],
  },
  "persona-select": {
    wireToken: "persona-select",
    fields: [lineageIdField],
  },
  "persona-page": {
    wireToken: "persona-page",
    fields: [lineageIdField, rangeIndexField],
  },
  select: {
    wireToken: "select",
    fields: [lineageIdField, optionalRangeIndexField],
  },
  range: {
    wireToken: "range",
    fields: [lineageIdField, rangeIndexField],
  },
  "range-open": {
    wireToken: "range-open",
    fields: [lineageIdField],
  },
  "range-page": {
    wireToken: "range-page",
    fields: [lineageIdField, chooserPageField],
  },
  "range-cancel": {
    wireToken: "range-cancel",
    fields: [lineageIdField],
  },
  "add-submit": {
    wireToken: "add-submit",
    fields: [lineageIdField, nonceField],
  },
  "edit-open": {
    wireToken: "edit-open",
    fields: [lineageIdField, memoryIdField],
  },
  "edit-submit": {
    wireToken: "edit-submit",
    fields: [lineageIdField, memoryIdField, nonceField],
  },
  "remove-prompt": {
    wireToken: "remove-prompt",
    fields: [lineageIdField, memoryIdField],
  },
  "remove-confirm": {
    wireToken: "remove-confirm",
    fields: [lineageIdField, memoryIdField],
  },
  "remove-cancel": {
    wireToken: "remove-cancel",
    fields: [lineageIdField, memoryIdField],
  },
  "vectorize-prompt": {
    wireToken: "vectorize-prompt",
    fields: [lineageIdField, personaIdField, memoryIdField],
  },
  "vectorize-confirm": {
    wireToken: "vectorize-confirm",
    fields: [lineageIdField, personaIdField, memoryIdField],
  },
  "vectorize-submit": {
    wireToken: "vectorize-submit",
    fields: [lineageIdField, personaIdField, memoryIdField, nonceField],
  },
  "vectorize-cancel": {
    wireToken: "vectorize-cancel",
    fields: [lineageIdField, personaIdField, memoryIdField],
  },
  "document-scope": {
    wireToken: "document-scope",
    fields: [personaIdField],
  },
  "document-persona-select": {
    wireToken: "document-persona-select",
    fields: [personaIdField],
  },
  "document-persona-page": {
    wireToken: "document-persona-page",
    fields: [personaIdField, rangeIndexField],
  },
  "document-select": {
    wireToken: "document-select",
    fields: [personaIdField, optionalRangeIndexField],
  },
  "document-range": {
    wireToken: "document-range",
    fields: [personaIdField, rangeIndexField],
  },
  "document-range-open": {
    wireToken: "document-range-open",
    fields: [personaIdField],
  },
  "document-range-page": {
    wireToken: "document-range-page",
    fields: [personaIdField, chooserPageField],
  },
  "document-range-cancel": {
    wireToken: "document-range-cancel",
    fields: [personaIdField],
  },
  "document-add-submit": {
    wireToken: "document-add-submit",
    fields: [personaIdField, nonceField],
  },
  "document-remove-prompt": {
    wireToken: "document-remove-prompt",
    fields: [personaIdField, documentIdField],
  },
  "document-remove-confirm": {
    wireToken: "document-remove-confirm",
    fields: [personaIdField, documentIdField],
  },
  "document-remove-cancel": {
    wireToken: "document-remove-cancel",
    fields: [personaIdField, documentIdField],
  },
  "history-remove-prompt": {
    wireToken: "history-remove-prompt",
    fields: [personaIdField, documentIdField],
  },
  "history-remove-confirm": {
    wireToken: "history-remove-confirm",
    fields: [personaIdField, documentIdField],
  },
  "history-remove-cancel": {
    wireToken: "history-remove-cancel",
    fields: [personaIdField, documentIdField],
  },
  "document-chunk-prev": {
    wireToken: "document-chunk-prev",
    fields: [personaIdField, documentIdField, chunkIdxField],
  },
  "document-chunk-next": {
    wireToken: "document-chunk-next",
    fields: [personaIdField, documentIdField, chunkIdxField],
  },
  "document-chunk-edit-open": {
    wireToken: "document-chunk-edit-open",
    fields: [personaIdField, documentIdField, chunkIdxField],
  },
  "document-chunk-edit-submit": {
    wireToken: "document-chunk-edit-submit",
    fields: [personaIdField, documentIdField, chunkIdxField, nonceField],
  },
  "document-chunk-remove-prompt": {
    wireToken: "document-chunk-remove-prompt",
    fields: [personaIdField, documentIdField, chunkIdxField],
  },
  "document-chunk-remove-confirm": {
    wireToken: "document-chunk-remove-confirm",
    fields: [personaIdField, documentIdField, chunkIdxField],
  },
  "document-chunk-remove-cancel": {
    wireToken: "document-chunk-remove-cancel",
    fields: [personaIdField, documentIdField, chunkIdxField],
  },
  "stm-open": {
    wireToken: "stm-open",
    fields: [],
  },
  "stm-submit": {
    wireToken: "stm-submit",
    fields: [nonceField],
  },
  "stm-entry": {
    wireToken: "stm-entry",
    fields: [channelIdField, personaIdField],
  },
  retry: {
    wireToken: "retry",
    fields: [categoryField, optionalLineageIdField],
  },
  refresh: {
    wireToken: "refresh",
    fields: [categoryField, optionalLineageIdField],
  },
};

const CODECS_BY_WIRE_TOKEN = indexCodecsByWireToken<MemoriesAction, MemoriesPanelRoute>(MEMORIES_ROUTE_CODECS);

export function listMemoriesPanelActions(): string[] {
  return Object.keys(MEMORIES_ROUTE_CODECS);
}

export function buildMemoriesRouteSegments(route: MemoriesPanelRoute): string[] {
  return buildRouteSegments(MEMORIES_ROUTE_CODECS[route.action], route);
}

export function buildMemoriesRouteId(route: MemoriesPanelRoute): string {
  return buildInteractionRouteId(
    MEMORIES_ROUTE_NAMESPACE,
    MEMORIES_ROUTE_VERSION,
    ...buildMemoriesRouteSegments(route),
  );
}

export function parseMemoriesPanelRoute(route: ParsedInteractionRoute): MemoriesPanelRoute | null {
  if (route.namespace !== MEMORIES_ROUTE_NAMESPACE || route.version !== MEMORIES_ROUTE_VERSION) {
    return null;
  }

  const [rawWireToken, rawLocale, ...tail] = route.segments;
  if (!rawWireToken || !rawLocale) return null;

  const locale = parseLocale(rawLocale);
  if (!locale) return null;

  const entry = CODECS_BY_WIRE_TOKEN.get(rawWireToken);
  if (!entry) return null;

  return decodeRouteSegments(entry.codec, entry.action, locale, tail);
}
