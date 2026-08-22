import { buildInteractionRouteId, type ParsedInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import { getSupportedLocales } from "@/utils/text/localizer";

export const MODERATION_ROUTE_NAMESPACE = "moderation";
export const MODERATION_ROUTE_VERSION = "v1";

const MODERATION_CATEGORIES = ["member-access", "user-blacklist", "whitelist"] as const;
export type ModerationCategory = (typeof MODERATION_CATEGORIES)[number];

const WHITELIST_PAGES = ["channels", "persona-channels", "roles"] as const;
export type WhitelistPage = (typeof WHITELIST_PAGES)[number];

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
  | { action: "persona-channel-remove-submit"; locale: string; nonce: string };

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

export function buildModerationCustomId(action: string, ...segments: Array<string | number>): string {
  return buildInteractionRouteId(MODERATION_ROUTE_NAMESPACE, MODERATION_ROUTE_VERSION, action, ...segments.map(String));
}

function parseLocale(value: string | undefined): string | null {
  return value && getSupportedLocales().includes(value) ? value : null;
}

function parseCategory(value: string | undefined): ModerationCategory | null {
  return MODERATION_CATEGORIES.find((candidate) => candidate === value) ?? null;
}

export function parseWhitelistPage(value: string | undefined): WhitelistPage | null {
  return WHITELIST_PAGES.find((candidate) => candidate === value) ?? null;
}

function parseRange(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseModerationPanelRoute(route: ParsedInteractionRoute): ModerationPanelRoute | null {
  if (route.namespace !== MODERATION_ROUTE_NAMESPACE || route.version !== MODERATION_ROUTE_VERSION) {
    return null;
  }

  const [action, rawLocale, first, second, third] = route.segments;
  const locale = parseLocale(rawLocale);
  if (!locale || !action) return null;

  if (action === "category" && route.segments.length === 3) {
    const category = parseCategory(first);
    return category ? { action, locale, category } : null;
  }

  if (action === "select-page" && route.segments.length === 2) {
    return { action, locale };
  }

  if (action === "page" && route.segments.length === 3) {
    const page = parseWhitelistPage(first);
    return page ? { action, locale, page } : null;
  }

  if (action === "range" && route.segments.length === 5) {
    const category = parseCategory(first);
    const page = first === "whitelist" ? parseWhitelistPage(second) : second === "none" ? "none" : null;
    const rangeIndex = parseRange(third);
    if (!category || !page || rangeIndex === null) return null;
    return { action, locale, category, page, rangeIndex };
  }

  if (action === "retry" && route.segments.length === 4) {
    const category = parseCategory(first);
    const page = first === "whitelist" ? parseWhitelistPage(second) : second === "none" ? "none" : null;
    if (!category || !page) return null;
    return { action, locale, category, page };
  }

  if (action === "member-access-open" && route.segments.length === 2) {
    return { action, locale };
  }

  if (action === "member-access-submit" && route.segments.length === 3) {
    const nonce = first;
    if (!nonce || !/^[a-zA-Z0-9_-]+$/.test(nonce)) return null;
    return { action, locale, nonce };
  }

  if (action === "user-blacklist-add-open" && route.segments.length === 2) {
    return { action, locale };
  }

  if (action === "user-blacklist-add-submit" && route.segments.length === 3) {
    const nonce = first;
    if (!nonce || !/^[a-zA-Z0-9_-]+$/.test(nonce)) return null;
    return { action, locale, nonce };
  }

  if (action === "user-blacklist-remove-open" && route.segments.length === 2) return { action, locale };
  if (action === "user-blacklist-remove-submit" && route.segments.length === 3) {
    const nonce = first;
    return nonce && /^[a-zA-Z0-9_-]+$/.test(nonce) ? { action, locale, nonce } : null;
  }

  if (action === "user-blacklist-remove-cancel" && route.segments.length === 2) {
    return { action, locale };
  }

  if (action === "whitelist-channel-add-open" && route.segments.length === 2) {
    return { action, locale };
  }

  if (action === "whitelist-channel-add-submit" && route.segments.length === 3) {
    const nonce = first;
    if (!nonce || !/^[a-zA-Z0-9_-]+$/.test(nonce)) return null;
    return { action, locale, nonce };
  }

  if (action === "whitelist-channel-remove-open" && route.segments.length === 2) return { action, locale };
  if (action === "whitelist-channel-remove-submit" && route.segments.length === 3) {
    const nonce = first;
    return nonce && /^[a-zA-Z0-9_-]+$/.test(nonce) ? { action, locale, nonce } : null;
  }

  if (action === "whitelist-channel-remove-cancel" && route.segments.length === 2) {
    return { action, locale };
  }

  if (action === "whitelist-role-add-open" && route.segments.length === 2) {
    return { action, locale };
  }

  if (action === "whitelist-role-add-submit" && route.segments.length === 3) {
    const nonce = first;
    if (!nonce || !/^[a-zA-Z0-9_-]+$/.test(nonce)) return null;
    return { action, locale, nonce };
  }

  if (action === "whitelist-role-remove-open" && route.segments.length === 2) return { action, locale };
  if (action === "whitelist-role-remove-submit" && route.segments.length === 3) {
    const nonce = first;
    return nonce && /^[a-zA-Z0-9_-]+$/.test(nonce) ? { action, locale, nonce } : null;
  }

  if (action === "whitelist-role-remove-cancel" && route.segments.length === 2) {
    return { action, locale };
  }

  if (action === "persona-channel-add-open" && route.segments.length === 2) return { action, locale };
  if (action === "persona-channel-remove-open" && route.segments.length === 2) return { action, locale };
  if (
    (action === "persona-channel-add-submit" || action === "persona-channel-remove-submit") &&
    route.segments.length === 3
  ) {
    const nonce = first;
    return nonce && /^[a-zA-Z0-9_-]+$/.test(nonce) ? { action, locale, nonce } : null;
  }

  if (action === "whitelist-role-remove-prompt" || action === "whitelist-role-remove-confirm") {
    if (route.segments.length === 3) {
      const roleId = first;
      if (!roleId || !/^\d{17,20}$/.test(roleId)) return null;
      return { action, locale, roleId };
    }
    return null;
  }

  if (action === "whitelist-channel-remove-prompt" || action === "whitelist-channel-remove-confirm") {
    if (route.segments.length === 3) {
      const channelId = first;
      if (!channelId || !/^\d{17,20}$/.test(channelId)) return null;
      return { action, locale, channelId };
    }
    return null;
  }

  if (action === "user-blacklist-remove-prompt" || action === "user-blacklist-remove-confirm") {
    if (first === "personalization" && route.segments.length === 4) {
      const userId = second;
      if (!userId || !/^\d{17,20}$/.test(userId)) return null;
      return { action, locale, target: { source: "personalization", userId } };
    }
    if (first === "persona-block" && route.segments.length === 5) {
      if (!second || !/^\d+$/.test(second)) return null;
      const personaId = Number(second);
      const userId = third;
      if (!Number.isSafeInteger(personaId) || personaId <= 0) return null;
      if (!userId || !/^\d{17,20}$/.test(userId)) return null;
      return { action, locale, target: { source: "persona-block", personaId, userId } };
    }
    return null;
  }

  return null;
}
