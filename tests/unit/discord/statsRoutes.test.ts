import { beforeAll, describe, expect, it } from "bun:test";
import { AttachmentBuilder, ComponentType, MessageFlags, type Client } from "discord.js";
import type { TomoriState, UserRow } from "@/types/db/schema";
import { InteractionRouteRegistry, type GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import { createStatsInteractionRoute } from "@/utils/discord/interactions/statsRoutes";
import { buildStatsDashboardRouteId, type StatsDashboardRoute } from "@/utils/discord/statsDashboardCatalog";
import { buildStatsDashboardPayload, type StatsTab } from "@/utils/stats/statsDashboard";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const ownerId = "123456789012345678";
const state = { server_id: 9 } as TomoriState;
const user = { user_id: 7, user_disc_id: ownerId, timezone_offset: 8 } as UserRow;

function tab(id: StatsTab["id"]): StatsTab {
  return {
    id,
    labelKey: `commands.stats.tabs.${id}_label`,
    page: {
      titleKey: "commands.stats.tabs.overview_title",
      subtitle: "Snapshot",
      fields: [],
    },
  };
}

function interactionFor(
  route: StatsDashboardRoute,
  userId = ownerId,
): {
  interaction: Record<string, unknown>;
  events: string[];
  replies: unknown[];
  publicEdits: unknown[];
} {
  const customId = buildStatsDashboardRouteId(route);
  const events: string[] = [];
  const replies: unknown[] = [];
  const publicEdits: unknown[] = [];
  const interaction: Record<string, unknown> = {
    customId,
    guildId: "guild-9",
    guild: null,
    user: {
      id: userId,
      displayName: "Viewer",
      username: "viewer",
      displayAvatarURL: () => "https://example.invalid/user.png",
    },
    deferred: false,
    replied: false,
    isButton: () => true,
    reply: async (payload: unknown) => {
      replies.push(payload);
      interaction.replied = true;
      return payload;
    },
    followUp: async (payload: unknown) => {
      replies.push(payload);
      return payload;
    },
    deferUpdate: async () => {
      events.push("defer");
      interaction.deferred = true;
    },
    editReply: async (payload: unknown) => {
      publicEdits.push(payload);
      return payload;
    },
  };
  return { interaction, events, replies, publicEdits };
}

function registryFor(
  harness: ReturnType<typeof interactionFor>,
  builders: {
    personal?: (
      args: Parameters<typeof import("@/utils/stats/statsDashboard").buildPersonalTabs>[0],
    ) => Promise<StatsTab[]>;
    persona?: (
      args: Parameters<typeof import("@/utils/stats/statsDashboard").buildPersonaTabs>[0],
    ) => Promise<StatsTab[]>;
    server?: (
      args: Parameters<typeof import("@/utils/stats/statsDashboard").buildServerTabs>[0],
    ) => Promise<StatsTab[]>;
  } = {},
): InteractionRouteRegistry {
  return new InteractionRouteRegistry([
    createStatsInteractionRoute({
      loadUserByDiscordId: async () => {
        harness.events.push("user");
        expect(harness.interaction.deferred).toBe(true);
        return user;
      },
      getCachedTomoriState: async () => {
        harness.events.push("state");
        expect(harness.interaction.deferred).toBe(true);
        return state;
      },
      getCachedAllPersonas: async () => {
        harness.events.push("personas");
        expect(harness.interaction.deferred).toBe(true);
        return [
          {
            ...state,
            persona_id: 42,
            persona_lineage_id: 41,
            persona_nickname: "Sparrow",
            is_alter: true,
            webhook_avatar_url: "https://example.invalid/persona.png",
          } as TomoriState,
        ];
      },
      buildPersonalTabs: async (args) => {
        harness.events.push("personal-tabs");
        expect(harness.interaction.deferred).toBe(true);
        return builders.personal
          ? builders.personal(args)
          : [tab("overview"), tab("people"), tab("models"), tab("expression")];
      },
      buildPersonaTabs: async (args) => {
        harness.events.push("persona-tabs");
        expect(harness.interaction.deferred).toBe(true);
        return builders.persona
          ? builders.persona(args)
          : [tab("overview"), tab("people"), tab("models"), tab("expression")];
      },
      buildServerTabs: async (args) => {
        harness.events.push("server-tabs");
        expect(harness.interaction.deferred).toBe(true);
        return builders.server
          ? builders.server(args)
          : [tab("overview"), tab("leaderboard"), tab("models"), tab("tools"), tab("expression")];
      },
    }),
  ]);
}

describe("durable stats dashboard interaction route", () => {
  it("has no collector or interaction-bound dashboard anchor", async () => {
    const source = await Bun.file(new URL("../../../src/utils/stats/statsDashboard.ts", import.meta.url)).text();
    const oldInteractionAnchor = ["`stats:", "$", "{interactionId}:"].join("");

    expect(source).not.toContain("createMessageComponentCollector");
    expect(source).not.toContain("STATS_DASHBOARD_TIMEOUT_MS");
    expect(source).not.toContain(oldInteractionAnchor);
  });

  it("rejects a wrong component type privately without acknowledgement or reads", async () => {
    const harness = interactionFor({
      view: "server",
      locale: "en-US",
      ownerId,
      serverId: 9,
      timeframe: "all_time",
      tab: "overview",
    });
    harness.interaction.isButton = () => false;
    const registry = registryFor(harness);

    await registry.dispatch({} as Client, harness.interaction as unknown as GlobalRoutableInteraction);

    expect(harness.interaction.deferred).toBe(false);
    expect(harness.replies).toHaveLength(1);
    expect((harness.replies[0] as { flags: MessageFlags }).flags).toBe(MessageFlags.Ephemeral);
    expect(harness.publicEdits).toHaveLength(0);
    expect(harness.events).toEqual([]);
  });

  it("rejects a non-owner privately before deferUpdate or public edit", async () => {
    const harness = interactionFor(
      {
        view: "server",
        locale: "en-US",
        ownerId,
        serverId: 9,
        timeframe: "all_time",
        tab: "overview",
      },
      "987654321098765432",
    );
    const registry = registryFor(harness);

    await registry.dispatch({} as Client, harness.interaction as unknown as GlobalRoutableInteraction);

    expect(harness.interaction.deferred).toBe(false);
    expect(harness.replies).toHaveLength(1);
    expect((harness.replies[0] as { flags: MessageFlags }).flags).toBe(MessageFlags.Ephemeral);
    expect(harness.publicEdits).toHaveLength(0);
    expect(harness.events).toEqual([]);
  });

  it("acknowledges before fresh personal, persona, and server reconstruction", async () => {
    const cases: StatsDashboardRoute[] = [
      {
        view: "personal",
        locale: "en-US",
        ownerId,
        serverId: 9,
        timeframe: "all_time",
        scope: "global",
        tab: "models",
      },
      {
        view: "persona",
        locale: "en-US",
        ownerId,
        serverId: 9,
        timeframe: "month",
        personaId: 42,
        tab: "people",
      },
      {
        view: "server",
        locale: "en-US",
        ownerId,
        serverId: 9,
        timeframe: "week",
        tab: "tools",
      },
    ];

    for (const route of cases) {
      const harness = interactionFor(route);
      const registry = registryFor(harness);
      await registry.dispatch({} as Client, harness.interaction as unknown as GlobalRoutableInteraction);
      expect(harness.events[0]).toBe("defer");
      expect(harness.publicEdits).toHaveLength(1);
    }
  });

  it("uses a private follow-up and leaves the public dashboard untouched for stale data", async () => {
    const harness = interactionFor({
      view: "persona",
      locale: "en-US",
      ownerId,
      serverId: 9,
      timeframe: "all_time",
      personaId: 999,
      tab: "overview",
    });
    const registry = registryFor(harness);

    await registry.dispatch({} as Client, harness.interaction as unknown as GlobalRoutableInteraction);

    expect(harness.interaction.deferred).toBe(true);
    expect(harness.replies).toHaveLength(1);
    expect(harness.publicEdits).toHaveLength(0);
  });

  it("uses a private follow-up when a catalog-valid tab is absent from a fresh view", async () => {
    const harness = interactionFor({
      view: "server",
      locale: "en-US",
      ownerId,
      serverId: 9,
      timeframe: "all_time",
      tab: "tools",
    });
    const registry = registryFor(harness, { server: async () => [tab("overview")] });

    await registry.dispatch({} as Client, harness.interaction as unknown as GlobalRoutableInteraction);

    expect(harness.interaction.deferred).toBe(true);
    expect(harness.replies).toHaveLength(1);
    expect(harness.publicEdits).toHaveLength(0);
  });

  it("acknowledges and privately rejects a forged tab without a public edit", async () => {
    const harness = interactionFor({
      view: "server",
      locale: "en-US",
      ownerId,
      serverId: 9,
      timeframe: "all_time",
      tab: "overview",
    });
    harness.interaction.customId = (harness.interaction.customId as string).replace(":overview", ":forged");
    const registry = registryFor(harness);

    await registry.dispatch({} as Client, harness.interaction as unknown as GlobalRoutableInteraction);

    expect(harness.interaction.deferred).toBe(true);
    expect(harness.replies).toHaveLength(1);
    expect(harness.publicEdits).toHaveLength(0);
  });

  it("keeps versioned buttons above the body and reattaches persona files", () => {
    const iconFile = new AttachmentBuilder(Buffer.from("avatar"), { name: "stats_persona_icon.png" });
    const payload = buildStatsDashboardPayload(
      {
        view: "persona",
        locale: "en-US",
        ownerId,
        serverId: 9,
        guildId: "guild-9",
        timeframe: "all_time",
        personaId: 42,
      },
      [tab("overview"), tab("people")],
      0,
      true,
      "attachment://stats_persona_icon.png",
      iconFile,
    );
    const body = (payload.components[0] as { components: Array<{ type: number; components?: unknown[] }> }).components;

    expect((body[0] as { type: number }).type).toBe(ComponentType.ActionRow);
    expect((body[1] as { type: number }).type).toBe(ComponentType.Separator);
    expect(payload.files).toEqual([iconFile]);
    expect(JSON.stringify(payload)).toContain("stats:v1:tab:en-US:persona");
  });
});
