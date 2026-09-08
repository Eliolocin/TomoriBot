import { beforeAll, describe, expect, it } from "bun:test";
import { parseInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import {
  buildStatsDashboardButtonId,
  buildStatsDashboardRouteId,
  parseStatsDashboardRoute,
  STATS_ROUTE_NAMESPACE,
  STATS_ROUTE_VERSION,
} from "@/utils/discord/statsDashboardCatalog";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const ownerId = "123456789012345678";

describe("stats dashboard route catalog", () => {
  it("round-trips each view and keeps the target tab in the wire contract", () => {
    const routes = [
      {
        view: "personal" as const,
        locale: "en-US",
        ownerId,
        serverId: 9,
        timeframe: "all_time" as const,
        scope: "this_server" as const,
        tab: "people" as const,
      },
      {
        view: "persona" as const,
        locale: "en-US",
        ownerId,
        serverId: 9,
        timeframe: "month" as const,
        personaId: 42,
        tab: "expression" as const,
      },
      {
        view: "server" as const,
        locale: "en-US",
        ownerId,
        serverId: 9,
        timeframe: "week" as const,
        tab: "leaderboard" as const,
      },
    ];

    for (const expected of routes) {
      const customId = buildStatsDashboardRouteId(expected);
      const parsed = parseInteractionRoute(customId);
      expect(parsed).not.toBeNull();
      expect(customId.startsWith(`${STATS_ROUTE_NAMESPACE}:${STATS_ROUTE_VERSION}:`)).toBe(true);
      expect(customId).toContain(expected.view);
      expect(customId).toContain(expected.ownerId);
      expect(customId).toContain(expected.tab);
      expect(customId.length).toBeLessThanOrEqual(100);
      expect(parsed ? parseStatsDashboardRoute(parsed) : null).toEqual(expected);
    }
  });

  it("rejects malformed, out-of-catalog, and overlong route fields", () => {
    const valid = buildStatsDashboardRouteId({
      view: "server",
      locale: "en-US",
      ownerId,
      serverId: 9,
      timeframe: "all_time",
      tab: "overview",
    });
    const malformed = [
      valid.replace(":all_time:overview", ":daily:overview"),
      valid.replace(":overview", ":unknown"),
      valid.replace(`:${ownerId}:`, ":not-a-snowflake:"),
      `${valid}:extra`,
      valid.replace(":server:", ":unknown-view:"),
    ];

    for (const customId of malformed) {
      const parsed = parseInteractionRoute(customId);
      expect(parsed).not.toBeNull();
      expect(parsed ? parseStatsDashboardRoute(parsed) : null).toBeNull();
    }

    expect(() =>
      buildStatsDashboardRouteId({
        view: "persona",
        locale: "en-US",
        ownerId,
        serverId: Number.MAX_SAFE_INTEGER,
        timeframe: "all_time",
        personaId: Number.MAX_SAFE_INTEGER,
        tab: "expression",
      }),
    ).not.toThrow();
    expect(
      buildStatsDashboardRouteId({
        view: "persona",
        locale: "en-US",
        ownerId,
        serverId: Number.MAX_SAFE_INTEGER,
        timeframe: "all_time",
        personaId: Number.MAX_SAFE_INTEGER,
        tab: "expression",
      }).length,
    ).toBeLessThanOrEqual(100);
  });

  it("builds the same strict IDs used by payload buttons", () => {
    const context = {
      view: "personal" as const,
      locale: "en-US",
      ownerId,
      serverId: 9,
      timeframe: "year" as const,
      scope: "global" as const,
    };
    expect(buildStatsDashboardButtonId(context, "models")).toBe(
      buildStatsDashboardRouteId({ ...context, tab: "models" }),
    );
  });
});
