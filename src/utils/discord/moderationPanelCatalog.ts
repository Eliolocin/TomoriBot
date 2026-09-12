import { buildInteractionRouteId, type ParsedInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import {
  buildRouteSegments,
  decodeRouteSegments,
  indexCodecsByWireToken,
  parseNonNegativeInt,
  parseNonce,
  parsePositiveId,
  parseSnowflake,
  type RouteCodec,
  type RouteFieldCodec,
} from "@/utils/discord/panelRouteCodec";
import { parseLocale } from "@/utils/discord/panelRouteTokens";

export const MODERATION_ROUTE_NAMESPACE = "moderation";
export const MODERATION_ROUTE_VERSION = "v1";

export const MODERATION_CATEGORIES = ["member-access", "user-blacklist", "whitelist", "quotas"] as const;
export type ModerationCategory = (typeof MODERATION_CATEGORIES)[number];

const WHITELIST_PAGES = ["channels", "persona-channels", "roles"] as const;
export type WhitelistPage = (typeof WHITELIST_PAGES)[number];

const QUOTA_TYPES = ["image", "text", "video"] as const;
export type QuotaType = (typeof QUOTA_TYPES)[number];

export type UserBlacklistRemovalTarget =
  | { source: "personalization"; userId: string }
  | { source: "persona-block"; personaId: number; userId: string };

export type ModerationPanelRoute =
  | { action: "category"; locale: string; category: ModerationCategory }
  | { action: "select-page"; locale: string }
  | { action: "page"; locale: string; page: WhitelistPage }
  | {
      action: "range";
      locale: string;
      category: ModerationCategory;
      page: WhitelistPage | "none";
      rangeIndex: number;
    }
  | {
      action: "retry";
      locale: string;
      category: ModerationCategory;
      page: WhitelistPage | "none";
    }
  | { action: "member-access-open"; locale: string }
  | { action: "member-access-submit"; locale: string; nonce: string }
  | { action: "model-access-set"; locale: string; allowServerModels: boolean }
  | { action: "user-blacklist-add-open"; locale: string }
  | { action: "user-blacklist-add-submit"; locale: string; nonce: string }
  | { action: "user-blacklist-remove-open"; locale: string }
  | { action: "user-blacklist-remove-submit"; locale: string; nonce: string }
  | { action: "user-blacklist-remove-prompt"; locale: string; target: UserBlacklistRemovalTarget }
  | { action: "user-blacklist-remove-confirm"; locale: string; target: UserBlacklistRemovalTarget }
  | { action: "user-blacklist-remove-cancel"; locale: string }
  | { action: "whitelist-channel-add-open"; locale: string }
  | { action: "whitelist-channel-add-submit"; locale: string; nonce: string }
  | { action: "whitelist-channel-remove-open"; locale: string }
  | { action: "whitelist-channel-remove-submit"; locale: string; nonce: string }
  | { action: "whitelist-channel-remove-prompt"; locale: string; channelId: string }
  | { action: "whitelist-channel-remove-confirm"; locale: string; channelId: string }
  | { action: "whitelist-channel-remove-cancel"; locale: string }
  | { action: "whitelist-role-add-open"; locale: string }
  | { action: "whitelist-role-add-submit"; locale: string; nonce: string }
  | { action: "whitelist-role-remove-open"; locale: string }
  | { action: "whitelist-role-remove-submit"; locale: string; nonce: string }
  | { action: "whitelist-role-remove-prompt"; locale: string; roleId: string }
  | { action: "whitelist-role-remove-confirm"; locale: string; roleId: string }
  | { action: "whitelist-role-remove-cancel"; locale: string }
  | { action: "persona-channel-add-open"; locale: string }
  | { action: "persona-channel-add-submit"; locale: string; nonce: string }
  | { action: "persona-channel-remove-open"; locale: string }
  | { action: "persona-channel-remove-submit"; locale: string; nonce: string }
  | { action: "quota-edit-open"; locale: string; quotaType: QuotaType }
  | { action: "quota-edit-submit"; locale: string; quotaType: QuotaType; nonce: string };

export type ModerationAction = ModerationPanelRoute["action"];

type ModerationFixedAction = Exclude<
  ModerationAction,
  "user-blacklist-remove-prompt" | "user-blacklist-remove-confirm"
>;

type ModerationRouteForAction<A extends ModerationFixedAction> = ModerationPanelRoute extends infer R
  ? R extends { action: string }
    ? A extends R["action"]
      ? R & { action: A }
      : never
    : never
  : never;

export type ModerationRouteCodecs = {
  [A in ModerationFixedAction]: RouteCodec<ModerationRouteForAction<A>>;
};

export function buildQuotaModalFieldId(
  nonce: string,
  field: "daily_user_quota" | "serverwide_quota" | "serverwide_quota_resets_in",
): string {
  return `quota_edit_${field}_${nonce}`;
}

function parseQuotaType(value: string | undefined): QuotaType | null {
  return QUOTA_TYPES.find((candidate) => candidate === value) ?? null;
}

export function buildMemberAccessModalFieldId(nonce: string): string {
  return `memberaccess_checkbox_${nonce}`;
}

export function buildUserBlacklistAddModalFieldId(nonce: string): string {
  return `userblacklist_add_user_${nonce}`;
}

export function buildWhitelistChannelAddModalFieldId(nonce: string, field: "channel" | "type" | "length"): string {
  return `whitelist_channel_add_${field}_${nonce}`;
}

export function buildWhitelistRoleAddModalFieldId(nonce: string): string {
  return `whitelist_role_add_role_${nonce}`;
}

export function buildModerationRemoveModalFieldId(nonce: string, index: number): string {
  return `moderation_remove_${index}_${nonce}`;
}

export function buildPersonaChannelAddModalFieldId(nonce: string, field: "persona" | "channel"): string {
  return `persona_channel_add_${field}_${nonce}`;
}

function parseCategory(value: string | undefined): ModerationCategory | null {
  return MODERATION_CATEGORIES.find((candidate) => candidate === value) ?? null;
}

export function parseWhitelistPage(value: string | undefined): WhitelistPage | null {
  return WHITELIST_PAGES.find((candidate) => candidate === value) ?? null;
}

const categoryField: RouteFieldCodec<"category", ModerationCategory> = {
  key: "category",
  encode: (v) => String(v),
  decode: (v) => parseCategory(v),
};

const whitelistPageField: RouteFieldCodec<"page", WhitelistPage> = {
  key: "page",
  encode: (v) => String(v),
  decode: (v) => parseWhitelistPage(v),
};

const pageField: RouteFieldCodec<"page", WhitelistPage | "none"> = {
  key: "page",
  encode: (v) => String(v),
  decode: (v, r) => (r.category === "whitelist" ? parseWhitelistPage(v) : v === "none" ? "none" : null),
};

const rangeIndexField: RouteFieldCodec<"rangeIndex", number> = {
  key: "rangeIndex",
  encode: (v) => String(v),
  decode: (v) => parseNonNegativeInt(v),
};

const allowServerModelsField: RouteFieldCodec<"allowServerModels", boolean> = {
  key: "allowServerModels",
  encode: (v) => (v ? "allow" : "require-personal"),
  decode: (v) => (v === "allow" ? true : v === "require-personal" ? false : null),
};

const nonceField: RouteFieldCodec<"nonce", string> = {
  key: "nonce",
  encode: (v) => String(v),
  decode: (v) => parseNonce(v),
};

const channelIdField: RouteFieldCodec<"channelId", string> = {
  key: "channelId",
  encode: (v) => String(v),
  decode: (v) => parseSnowflake(v),
};

const roleIdField: RouteFieldCodec<"roleId", string> = {
  key: "roleId",
  encode: (v) => String(v),
  decode: (v) => parseSnowflake(v),
};

const quotaTypeField: RouteFieldCodec<"quotaType", QuotaType> = {
  key: "quotaType",
  encode: (v) => String(v),
  decode: (v) => parseQuotaType(v),
};

/**
 * Authoritative codec table for all moderation routes with fixed-width arguments.
 * Keyed by semantic action to guarantee compile-time exhaustiveness.
 * Preserves the exact v1 wire format: wire token, locale, and ordered field serialization.
 */
export const MODERATION_ROUTE_CODECS: ModerationRouteCodecs = {
  category: {
    wireToken: "category",
    fields: [categoryField],
  },
  "select-page": {
    wireToken: "select-page",
    fields: [],
  },
  page: {
    wireToken: "page",
    fields: [whitelistPageField],
  },
  range: {
    wireToken: "range",
    fields: [categoryField, pageField, rangeIndexField],
  },
  retry: {
    wireToken: "retry",
    fields: [categoryField, pageField],
  },
  "member-access-open": {
    wireToken: "member-access-open",
    fields: [],
  },
  "member-access-submit": {
    wireToken: "member-access-submit",
    fields: [nonceField],
  },
  "model-access-set": {
    wireToken: "model-access-set",
    fields: [allowServerModelsField],
  },
  "user-blacklist-add-open": {
    wireToken: "user-blacklist-add-open",
    fields: [],
  },
  "user-blacklist-add-submit": {
    wireToken: "user-blacklist-add-submit",
    fields: [nonceField],
  },
  "user-blacklist-remove-open": {
    wireToken: "user-blacklist-remove-open",
    fields: [],
  },
  "user-blacklist-remove-submit": {
    wireToken: "user-blacklist-remove-submit",
    fields: [nonceField],
  },
  "user-blacklist-remove-cancel": {
    wireToken: "user-blacklist-remove-cancel",
    fields: [],
  },
  "whitelist-channel-add-open": {
    wireToken: "whitelist-channel-add-open",
    fields: [],
  },
  "whitelist-channel-add-submit": {
    wireToken: "whitelist-channel-add-submit",
    fields: [nonceField],
  },
  "whitelist-channel-remove-open": {
    wireToken: "whitelist-channel-remove-open",
    fields: [],
  },
  "whitelist-channel-remove-submit": {
    wireToken: "whitelist-channel-remove-submit",
    fields: [nonceField],
  },
  "whitelist-channel-remove-prompt": {
    wireToken: "whitelist-channel-remove-prompt",
    fields: [channelIdField],
  },
  "whitelist-channel-remove-confirm": {
    wireToken: "whitelist-channel-remove-confirm",
    fields: [channelIdField],
  },
  "whitelist-channel-remove-cancel": {
    wireToken: "whitelist-channel-remove-cancel",
    fields: [],
  },
  "whitelist-role-add-open": {
    wireToken: "whitelist-role-add-open",
    fields: [],
  },
  "whitelist-role-add-submit": {
    wireToken: "whitelist-role-add-submit",
    fields: [nonceField],
  },
  "whitelist-role-remove-open": {
    wireToken: "whitelist-role-remove-open",
    fields: [],
  },
  "whitelist-role-remove-submit": {
    wireToken: "whitelist-role-remove-submit",
    fields: [nonceField],
  },
  "whitelist-role-remove-prompt": {
    wireToken: "whitelist-role-remove-prompt",
    fields: [roleIdField],
  },
  "whitelist-role-remove-confirm": {
    wireToken: "whitelist-role-remove-confirm",
    fields: [roleIdField],
  },
  "whitelist-role-remove-cancel": {
    wireToken: "whitelist-role-remove-cancel",
    fields: [],
  },
  "persona-channel-add-open": {
    wireToken: "persona-channel-add-open",
    fields: [],
  },
  "persona-channel-add-submit": {
    wireToken: "persona-channel-add-submit",
    fields: [nonceField],
  },
  "persona-channel-remove-open": {
    wireToken: "persona-channel-remove-open",
    fields: [],
  },
  "persona-channel-remove-submit": {
    wireToken: "persona-channel-remove-submit",
    fields: [nonceField],
  },
  "quota-edit-open": {
    wireToken: "quota-edit-open",
    fields: [quotaTypeField],
  },
  "quota-edit-submit": {
    wireToken: "quota-edit-submit",
    fields: [quotaTypeField, nonceField],
  },
};

export type ModerationFixedRoute = Extract<ModerationPanelRoute, { action: ModerationFixedAction }>;

const CODECS_BY_WIRE_TOKEN = indexCodecsByWireToken<ModerationFixedAction, ModerationFixedRoute>(
  MODERATION_ROUTE_CODECS,
);

const ACCEPTED_35_ACTIONS: readonly ModerationAction[] = [
  "category",
  "member-access-open",
  "member-access-submit",
  "model-access-set",
  "page",
  "persona-channel-add-open",
  "persona-channel-add-submit",
  "persona-channel-remove-open",
  "persona-channel-remove-submit",
  "quota-edit-open",
  "quota-edit-submit",
  "range",
  "retry",
  "select-page",
  "user-blacklist-add-open",
  "user-blacklist-add-submit",
  "user-blacklist-remove-cancel",
  "user-blacklist-remove-confirm",
  "user-blacklist-remove-open",
  "user-blacklist-remove-prompt",
  "user-blacklist-remove-submit",
  "whitelist-channel-add-open",
  "whitelist-channel-add-submit",
  "whitelist-channel-remove-cancel",
  "whitelist-channel-remove-confirm",
  "whitelist-channel-remove-open",
  "whitelist-channel-remove-prompt",
  "whitelist-channel-remove-submit",
  "whitelist-role-add-open",
  "whitelist-role-add-submit",
  "whitelist-role-remove-cancel",
  "whitelist-role-remove-confirm",
  "whitelist-role-remove-open",
  "whitelist-role-remove-prompt",
  "whitelist-role-remove-submit",
] as const;

export function listModerationPanelActions(): ModerationAction[] {
  return [...ACCEPTED_35_ACTIONS];
}

/**
 * Encodes a typed route object through the authoritative codec table or target variant builder into route segments.
 */
export function buildModerationRouteSegments(route: ModerationPanelRoute): string[] {
  if (route.action === "user-blacklist-remove-prompt" || route.action === "user-blacklist-remove-confirm") {
    if (route.target.source === "personalization") {
      return [route.action, route.locale, "personalization", route.target.userId];
    }
    return [route.action, route.locale, "persona-block", String(route.target.personaId), route.target.userId];
  }
  return buildRouteSegments(MODERATION_ROUTE_CODECS[route.action], route);
}

/**
 * Builds a custom ID from a typed route object using the authoritative codec table and exact target variants.
 */
export function buildModerationRouteId(route: ModerationPanelRoute): string {
  return buildInteractionRouteId(
    MODERATION_ROUTE_NAMESPACE,
    MODERATION_ROUTE_VERSION,
    ...buildModerationRouteSegments(route),
  );
}

function decodeUserBlacklistRemovalRoute(
  action: "user-blacklist-remove-prompt" | "user-blacklist-remove-confirm",
  locale: string,
  tail: readonly string[],
): ModerationPanelRoute | null {
  if (tail.length === 2 && tail[0] === "personalization") {
    const userId = parseSnowflake(tail[1]);
    if (!userId) return null;
    return { action, locale, target: { source: "personalization", userId } };
  }
  if (tail.length === 3 && tail[0] === "persona-block") {
    const personaId = parsePositiveId(tail[1]);
    const userId = parseSnowflake(tail[2]);
    if (!personaId || !userId) return null;
    return { action, locale, target: { source: "persona-block", personaId, userId } };
  }
  return null;
}

export function parseModerationPanelRoute(route: ParsedInteractionRoute): ModerationPanelRoute | null {
  if (route.namespace !== MODERATION_ROUTE_NAMESPACE || route.version !== MODERATION_ROUTE_VERSION) {
    return null;
  }

  const [rawWireToken, rawLocale, ...tail] = route.segments;
  if (!rawWireToken || !rawLocale) return null;

  const locale = parseLocale(rawLocale);
  if (!locale) return null;

  if (rawWireToken === "user-blacklist-remove-prompt" || rawWireToken === "user-blacklist-remove-confirm") {
    return decodeUserBlacklistRemovalRoute(rawWireToken, locale, tail);
  }

  const entry = CODECS_BY_WIRE_TOKEN.get(rawWireToken);
  if (!entry) return null;

  return decodeRouteSegments<ModerationPanelRoute>(entry.codec, entry.action, locale, tail);
}
