import { beforeAll, describe, expect, it } from "bun:test";
import { ComponentType, type ActionRowData, type ButtonComponentData } from "discord.js";
import {
  buildModerationRouteSegments,
  MODERATION_ROUTE_NAMESPACE,
  MODERATION_ROUTE_VERSION,
  parseModerationPanelRoute,
} from "@/utils/discord/moderationPanelCatalog";
import { parseInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import { buildPaginationRow, type PaginationRouteSegments } from "@/utils/discord/ui/panel";
import { buildModerationPanelPayload } from "@/utils/discord/ui/moderationPanel";
import type { ModerationScopeData } from "@/utils/moderation/moderationOperations";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

function createScopeData(overrides: Partial<ModerationScopeData> = {}): ModerationScopeData {
  return {
    guildId: "12345",
    serverId: 1,
    readStatus: "fresh",
    serverModelAccess: { allowServerModels: true },
    memberAccess: {
      serverMemteachingEnabled: true,
      attributeMemteachingEnabled: false,
      sampledialogueMemteachingEnabled: true,
      promptSnapshotEnabled: false,
    },
    userBlacklist: {
      personalizationUserIds: [],
      personaBlocks: [],
      personalMemoriesEnabled: true,
    },
    whitelist: {
      channels: [],
      personaChannels: [],
      roles: [],
      personaNames: new Map(),
    },
    quotas: {
      image: { daily_user_quota: 5, serverwide_quota: 50, serverwide_quota_resets_in: 30 },
      text: { daily_user_quota: 10, serverwide_quota: 100, serverwide_quota_resets_in: 7 },
      video: { daily_user_quota: 0, serverwide_quota: 0, serverwide_quota_resets_in: 365 },
    },
    ...overrides,
  };
}

function buildModerationRangeSegments(
  category: "user-blacklist" | "whitelist",
  page: "channels" | "persona-channels" | "roles" | "none",
): PaginationRouteSegments {
  return {
    page: (rangeIndex) =>
      buildModerationRouteSegments({
        action: "range",
        locale: "en-US",
        category,
        page,
        rangeIndex,
      }),
  };
}

function buildRow(rangeIndex: number, rangeCount: number, disabled = false): ActionRowData<ButtonComponentData> | null {
  return buildPaginationRow({
    locale: "en-US",
    rangeIndex,
    rangeCount,
    namespace: MODERATION_ROUTE_NAMESPACE,
    version: MODERATION_ROUTE_VERSION,
    disabled,
    buildSegments: buildModerationRangeSegments("whitelist", "channels"),
  });
}

describe("buildPaginationRow", () => {
  it("omits the row for a single page", () => {
    expect(buildRow(0, 1)).toBeNull();
  });

  it("renders bounded navigation, a disabled indicator, and the real moderation route seam", () => {
    const firstRow = buildRow(0, 3);
    const middleRow = buildRow(1, 3);
    const lastRow = buildRow(2, 3);

    expect(firstRow?.type).toBe(ComponentType.ActionRow);
    expect(firstRow?.components.map((button) => button.label)).toEqual(["← Previous", "Page 1 of 3", "Next →"]);
    expect(firstRow?.components.map((button) => button.disabled)).toEqual([true, true, false]);
    expect(middleRow?.components.map((button) => button.disabled)).toEqual([false, true, false]);
    expect(lastRow?.components.map((button) => button.disabled)).toEqual([false, true, true]);

    for (const row of [firstRow, middleRow, lastRow]) {
      const ids = row?.components.map((button) => button.customId ?? "") ?? [];
      expect(new Set(ids).size).toBe(3);
    }
    expect(parseInteractionRoute(firstRow?.components[1]?.customId ?? "")).toBeNull();

    const nextRoute = parseInteractionRoute(firstRow?.components[2]?.customId ?? "");
    expect(nextRoute).not.toBeNull();
    if (!nextRoute) throw new Error("Expected a pagination route");
    expect(parseModerationPanelRoute(nextRoute)).toEqual({
      action: "range",
      locale: "en-US",
      category: "whitelist",
      page: "channels",
      rangeIndex: 1,
    });
  });

  it("disables both directional buttons when the row is disabled", () => {
    const row = buildRow(1, 3, true);

    expect(row?.components.map((button) => button.disabled)).toEqual([true, true, true]);
  });
});

describe("moderation pagination wiring", () => {
  it("uses the shared row for every paginated moderation collection", () => {
    const now = new Date();
    const channelEntries = Array.from({ length: 11 }, (_, index) => ({
      server_id: 1,
      channel_disc_id: `channel-${index + 1}`,
      cooldown_type: null,
      cooldown_length: null,
      created_at: now,
      updated_at: now,
    }));
    const personaEntries = Array.from({ length: 11 }, (_, index) => ({
      server_id: 1,
      persona_id: index + 1,
      channel_disc_id: `persona-channel-${index + 1}`,
      created_at: now,
    }));
    const roleEntries = Array.from({ length: 11 }, (_, index) => ({
      server_id: 1,
      role_disc_id: `role-${index + 1}`,
      created_at: now,
      updated_at: now,
    }));

    const cases = [
      {
        category: "user-blacklist" as const,
        whitelistPage: "channels" as const,
        data: createScopeData({
          userBlacklist: {
            personalizationUserIds: Array.from({ length: 11 }, (_, index) => `user-${index + 1}`),
            personaBlocks: [],
          },
        }),
        route: "moderation:v1:range:en-US:user-blacklist:none:1",
      },
      {
        category: "whitelist" as const,
        whitelistPage: "channels" as const,
        data: createScopeData({
          whitelist: { channels: channelEntries, personaChannels: [], roles: [], personaNames: new Map() },
        }),
        route: "moderation:v1:range:en-US:whitelist:channels:1",
      },
      {
        category: "whitelist" as const,
        whitelistPage: "persona-channels" as const,
        data: createScopeData({
          whitelist: {
            channels: [],
            personaChannels: personaEntries,
            roles: [],
            personaNames: new Map(personaEntries.map((entry) => [entry.persona_id, `Persona ${entry.persona_id}`])),
          },
        }),
        route: "moderation:v1:range:en-US:whitelist:persona-channels:1",
      },
      {
        category: "whitelist" as const,
        whitelistPage: "roles" as const,
        data: createScopeData({
          whitelist: { channels: [], personaChannels: [], roles: roleEntries, personaNames: new Map() },
        }),
        route: "moderation:v1:range:en-US:whitelist:roles:1",
      },
    ];

    for (const testCase of cases) {
      const payload = buildModerationPanelPayload({
        locale: "en-US",
        category: testCase.category,
        whitelistPage: testCase.whitelistPage,
        rangeIndex: 0,
        data: testCase.data,
      });
      const serialized = JSON.stringify(payload);

      expect(serialized).toContain("Page 1 of 2");
      expect(serialized).toContain(testCase.route);
    }
  });

  it("keeps the blacklist body on the routed page while navigation changes", () => {
    const data = createScopeData({
      userBlacklist: {
        personalizationUserIds: Array.from({ length: 11 }, (_, index) => `user-${index + 1}`),
        personaBlocks: [],
      },
    });
    const firstPage = JSON.stringify(
      buildModerationPanelPayload({
        locale: "en-US",
        category: "user-blacklist",
        whitelistPage: "channels",
        rangeIndex: 0,
        data,
      }),
    );
    const lastPage = JSON.stringify(
      buildModerationPanelPayload({
        locale: "en-US",
        category: "user-blacklist",
        whitelistPage: "channels",
        rangeIndex: 1,
        data,
      }),
    );

    expect(firstPage).toContain("> <@user-1>");
    expect(firstPage).not.toContain("> <@user-11>");
    expect(lastPage).not.toContain("> <@user-1>");
    expect(lastPage).toContain("> <@user-11>");
    expect(lastPage).toContain("moderation:v1:range:en-US:user-blacklist:none:0");
  });
});
