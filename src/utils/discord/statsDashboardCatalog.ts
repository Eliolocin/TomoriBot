import { buildInteractionRouteId, type ParsedInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import { parsePositiveId, parseSnowflake } from "@/utils/discord/panelRouteCodec";
import { parseLocale } from "@/utils/discord/panelRouteTokens";

export const STATS_ROUTE_NAMESPACE = "stats";
export const STATS_ROUTE_VERSION = "v1";

export type StatsDashboardView = "personal" | "persona" | "server";
export type StatsDashboardTimeframe = "today" | "week" | "month" | "year" | "all_time";
export type StatsDashboardScope = "this_server" | "global";
type PersonalStatsTab = "overview" | "people" | "models" | "expression";
type PersonaStatsTab = PersonalStatsTab;
type ServerStatsTab = "overview" | "leaderboard" | "models" | "tools" | "expression";
type StatsDashboardTab = PersonalStatsTab | ServerStatsTab;

const TIMEFRAMES: readonly StatsDashboardTimeframe[] = ["today", "week", "month", "year", "all_time"];
const PERSONAL_TABS: readonly PersonalStatsTab[] = ["overview", "people", "models", "expression"];
const SERVER_TABS: readonly ServerStatsTab[] = ["overview", "leaderboard", "models", "tools", "expression"];

export type StatsDashboardRoute =
  | {
      view: "personal";
      locale: string;
      ownerId: string;
      serverId: number;
      timeframe: StatsDashboardTimeframe;
      scope: StatsDashboardScope;
      tab: PersonalStatsTab;
    }
  | {
      view: "persona";
      locale: string;
      ownerId: string;
      serverId: number;
      timeframe: StatsDashboardTimeframe;
      personaId: number;
      tab: PersonaStatsTab;
    }
  | {
      view: "server";
      locale: string;
      ownerId: string;
      serverId: number;
      timeframe: StatsDashboardTimeframe;
      tab: ServerStatsTab;
    };

function isOneOf<T extends string>(value: string | undefined, values: readonly T[]): value is T {
  return value !== undefined && values.includes(value as T);
}

function encodeLocale(value: string): string {
  if (!parseLocale(value)) throw new Error("Stats dashboard locale is not supported");
  return value;
}

function encodeOwnerId(value: string): string {
  if (!parseSnowflake(value)) throw new Error("Stats dashboard owner IDs must be Discord snowflakes");
  return value;
}

function encodePositiveId(value: number, label: string): string {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Stats dashboard ${label} must be positive`);
  return String(value);
}

function encodeTimeframe(value: StatsDashboardTimeframe): string {
  if (!isOneOf(value, TIMEFRAMES)) throw new Error("Stats dashboard timeframe is invalid");
  return value;
}

function encodeScope(value: StatsDashboardScope): string {
  if (value !== "this_server" && value !== "global") throw new Error("Stats dashboard scope is invalid");
  return value;
}

function encodeTab(value: string, view: StatsDashboardView): string {
  const tabs = view === "server" ? SERVER_TABS : PERSONAL_TABS;
  if (!isOneOf(value, tabs)) throw new Error("Stats dashboard tab is invalid");
  return value;
}

export function buildStatsDashboardRouteId(route: StatsDashboardRoute): string {
  const common = [
    encodeLocale(route.locale),
    route.view,
    encodeOwnerId(route.ownerId),
    encodePositiveId(route.serverId, "server IDs"),
    encodeTimeframe(route.timeframe),
  ];
  const tail =
    route.view === "personal"
      ? [encodeScope(route.scope), encodeTab(route.tab, route.view)]
      : route.view === "persona"
        ? [encodePositiveId(route.personaId, "persona IDs"), encodeTab(route.tab, route.view)]
        : [encodeTab(route.tab, route.view)];
  return buildInteractionRouteId(STATS_ROUTE_NAMESPACE, STATS_ROUTE_VERSION, "tab", ...common, ...tail);
}

export function buildStatsDashboardButtonId(
  context: {
    view: StatsDashboardView;
    locale: string;
    ownerId: string;
    serverId: number;
    timeframe: StatsDashboardTimeframe;
    scope?: StatsDashboardScope;
    personaId?: number;
  },
  tab: string,
): string {
  if (context.view === "personal") {
    if (!context.scope) throw new Error("Personal stats dashboard scope is required");
    return buildStatsDashboardRouteId({
      view: "personal",
      locale: context.locale,
      ownerId: context.ownerId,
      serverId: context.serverId,
      timeframe: context.timeframe,
      scope: context.scope,
      tab: tab as PersonalStatsTab,
    });
  }
  if (context.view === "persona") {
    if (context.personaId === undefined) throw new Error("Persona stats dashboard persona ID is required");
    return buildStatsDashboardRouteId({
      view: "persona",
      locale: context.locale,
      ownerId: context.ownerId,
      serverId: context.serverId,
      timeframe: context.timeframe,
      personaId: context.personaId,
      tab: tab as PersonaStatsTab,
    });
  }
  return buildStatsDashboardRouteId({
    view: "server",
    locale: context.locale,
    ownerId: context.ownerId,
    serverId: context.serverId,
    timeframe: context.timeframe,
    tab: tab as ServerStatsTab,
  });
}

function parseTimeframe(value: string | undefined): StatsDashboardTimeframe | null {
  return isOneOf(value, TIMEFRAMES) ? value : null;
}

function parseScope(value: string | undefined): StatsDashboardScope | null {
  return value === "this_server" || value === "global" ? value : null;
}

function parseTab(value: string | undefined, view: StatsDashboardView): StatsDashboardTab | null {
  const tabs = view === "server" ? SERVER_TABS : PERSONAL_TABS;
  return isOneOf(value, tabs) ? value : null;
}

export function parseStatsDashboardRoute(route: ParsedInteractionRoute): StatsDashboardRoute | null {
  if (route.namespace !== STATS_ROUTE_NAMESPACE || route.version !== STATS_ROUTE_VERSION) return null;
  const [rawAction, rawLocale, rawView, rawOwnerId, rawServerId, rawTimeframe, ...tail] = route.segments;
  const locale = parseLocale(rawLocale);
  if (rawAction !== "tab" || !locale || (rawView !== "personal" && rawView !== "persona" && rawView !== "server"))
    return null;
  const ownerId = parseSnowflake(rawOwnerId);
  const serverId = parsePositiveId(rawServerId);
  const timeframe = parseTimeframe(rawTimeframe);
  if (!ownerId || serverId === null || !timeframe) return null;

  if (rawView === "personal") {
    if (tail.length !== 2) return null;
    const scope = parseScope(tail[0]);
    const tab = parseTab(tail[1], rawView);
    if (!scope || !tab || !PERSONAL_TABS.includes(tab as PersonalStatsTab)) return null;
    return { view: rawView, locale, ownerId, serverId, timeframe, scope, tab: tab as PersonalStatsTab };
  }

  if (rawView === "persona") {
    if (tail.length !== 2) return null;
    const personaId = parsePositiveId(tail[0]);
    const tab = parseTab(tail[1], rawView);
    if (personaId === null || !tab || !PERSONAL_TABS.includes(tab as PersonalStatsTab)) return null;
    return { view: rawView, locale, ownerId, serverId, timeframe, personaId, tab: tab as PersonaStatsTab };
  }

  if (tail.length !== 1) return null;
  const tab = parseTab(tail[0], rawView);
  if (!tab || !SERVER_TABS.includes(tab as ServerStatsTab)) return null;
  return { view: rawView, locale, ownerId, serverId, timeframe, tab: tab as ServerStatsTab };
}
