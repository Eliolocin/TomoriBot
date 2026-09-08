import { beforeAll, describe, expect, it } from "bun:test";
import type { Client } from "discord.js";
import type { TomoriState, UserRow } from "@/types/db/schema";
import {
  InteractionRouteRegistry,
  parseInteractionRoute,
  type GlobalRoutableInteraction,
} from "@/utils/discord/interactions/routeRegistry";
import {
  buildStatusCategoryButtonId,
  buildStatusPageSelectorId,
  buildStatusPersonaRangeId,
  buildStatusPersonaSelectorId,
} from "@/utils/discord/statusDashboardCatalog";
import { createStatusInteractionRoute } from "@/utils/discord/interactions/statusRoutes";
import type { StatusPageCategory } from "@/utils/metrics/status/statusPageRenderer";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const state = { server_id: 9, config: {} } as TomoriState;
const user = { user_id: 7, user_disc_id: "viewer" } as UserRow;

function page(titleKey: string): StatusPageCategory["pages"][number] {
  return { titleKey, fields: [] };
}

function categories(suffix: string): StatusPageCategory[] {
  return [
    { id: "persona", labelKey: "commands.status.scope_choice_persona", pages: [] },
    {
      id: "behavior",
      labelKey: "commands.status.scope_choice_behavior",
      pages: [page(`commands.status.server_page1_title`), page(`commands.status.server_page2_title${suffix}`)],
    },
    {
      id: "models",
      labelKey: "commands.status.scope_choice_models",
      pages: [page("commands.status.server_page4_title")],
    },
    {
      id: "access",
      labelKey: "commands.status.scope_choice_access",
      pages: [page("commands.status.server_page8_title")],
    },
    {
      id: "personal",
      labelKey: "commands.status.scope_choice_personal",
      pages: [page("commands.status.personal_title")],
    },
  ];
}

function persona(personaId: number, personaNickname: string): TomoriState {
  return { persona_id: personaId, persona_nickname: personaNickname, persona_lineage_id: personaId } as TomoriState;
}

interface MockStatusInteraction {
  customId: string;
  guildId: string | null;
  user: { id: string };
  values: string[];
  deferred: boolean;
  replied: boolean;
  deferUpdate(): Promise<void>;
  editReply(payload: unknown): Promise<unknown>;
  isButton(): boolean;
  isStringSelectMenu(): boolean;
}

function makeInteraction(customId: string, kind: "button" | "string", values: string[] = []): MockStatusInteraction {
  const calls = { deferred: false };
  const interaction: MockStatusInteraction = {
    customId,
    guildId: "guild-9",
    user: { id: "viewer" },
    values,
    deferred: false,
    replied: false,
    deferUpdate: async () => {
      calls.deferred = true;
      interaction.deferred = true;
    },
    editReply: async (payload) => payload,
    isButton: () => kind === "button",
    isStringSelectMenu: () => kind === "string",
  };
  return interaction;
}

function makeRegistry(
  interaction: MockStatusInteraction,
  events: string[],
  resolve: () => Promise<StatusPageCategory[]>,
  personas: TomoriState[] = [],
  buildPersonaPages: (selectedPersona: TomoriState) => Promise<StatusPageCategory["pages"]> = async (selectedPersona) =>
    Array.from({ length: 5 }, (_, index) => ({
      titleKey: `commands.status.persona_page${index + 1}_title`,
      titleVars: { persona_name: selectedPersona.persona_nickname },
      fields: [],
    })),
): InteractionRouteRegistry {
  return new InteractionRouteRegistry([
    createStatusInteractionRoute({
      loadUserByDiscordId: async () => {
        events.push("user");
        expect(interaction.deferred).toBe(true);
        return user;
      },
      getCachedTomoriState: async () => {
        events.push("state");
        expect(interaction.deferred).toBe(true);
        return state;
      },
      loadPersonasForServer: async () => {
        events.push("personas");
        expect(interaction.deferred).toBe(true);
        return personas;
      },
      buildPersonaStatusPages: async (selectedPersona) => {
        events.push(`persona:${selectedPersona.persona_id}`);
        expect(interaction.deferred).toBe(true);
        return buildPersonaPages(selectedPersona);
      },
      resolveCategories: async () => {
        events.push("pages");
        expect(interaction.deferred).toBe(true);
        return resolve();
      },
    }),
  ]);
}

describe("persistent status interaction route", () => {
  it("routes a category button through the registry after acknowledgement and repaints fresh data", async () => {
    const interaction = makeInteraction(buildStatusCategoryButtonId("en-US", "models"), "button");
    const events: string[] = [];
    const replies: unknown[] = [];
    interaction.editReply = async (payload) => {
      replies.push(payload);
      return payload;
    };
    const registry = makeRegistry(interaction, events, async () => categories("-fresh"));

    const handled = await registry.dispatch({} as Client, interaction as unknown as GlobalRoutableInteraction);

    expect(handled).toBe(true);
    expect(events).toEqual(["user", "state", "pages"]);
    expect(interaction.deferred).toBe(true);
    expect(replies).toHaveLength(1);
    expect(JSON.stringify(replies[0])).toContain("Server Status: Models and Sampling");
  });

  it("routes a page selector with a bounded value and uses editReply rather than update", async () => {
    const interaction = makeInteraction(buildStatusPageSelectorId("en-US", "behavior"), "string", ["1"]);
    const events: string[] = [];
    const replies: unknown[] = [];
    interaction.editReply = async (payload) => {
      replies.push(payload);
      return payload;
    };
    const registry = makeRegistry(interaction, events, async () => categories("-fresh"));

    await registry.dispatch({} as Client, interaction as unknown as GlobalRoutableInteraction);

    expect(events).toEqual(["user", "state", "pages"]);
    expect(replies).toHaveLength(1);
    expect(JSON.stringify(replies[0])).toContain("server_page2_title-fresh");
    expect(JSON.stringify(replies[0])).toContain(buildStatusPageSelectorId("en-US", "behavior"));
  });

  it("requires concrete component types before type-specific access", async () => {
    const buttonWithPageRoute = makeInteraction(buildStatusPageSelectorId("en-US", "behavior"), "button", ["0"]);
    const selectWithCategoryRoute = makeInteraction(buildStatusCategoryButtonId("en-US", "behavior"), "string");
    const buttonWithPersonaSelectorRoute = makeInteraction(buildStatusPersonaSelectorId("en-US", 2), "button", ["2"]);
    const selectWithPersonaRangeRoute = makeInteraction(buildStatusPersonaRangeId("en-US", 2, 25), "string");
    const events: string[] = [];
    const registry = makeRegistry(buttonWithPageRoute, events, async () => categories(""));
    const secondRegistry = makeRegistry(selectWithCategoryRoute, events, async () => categories(""));
    const thirdRegistry = makeRegistry(buttonWithPersonaSelectorRoute, events, async () => categories(""));
    const fourthRegistry = makeRegistry(selectWithPersonaRangeRoute, events, async () => categories(""));

    await expect(
      registry.dispatch({} as Client, buttonWithPageRoute as unknown as GlobalRoutableInteraction),
    ).rejects.toThrow("String Select");
    await expect(
      secondRegistry.dispatch({} as Client, selectWithCategoryRoute as unknown as GlobalRoutableInteraction),
    ).rejects.toThrow("button");
    await expect(
      thirdRegistry.dispatch({} as Client, buttonWithPersonaSelectorRoute as unknown as GlobalRoutableInteraction),
    ).rejects.toThrow("String Select");
    await expect(
      fourthRegistry.dispatch({} as Client, selectWithPersonaRangeRoute as unknown as GlobalRoutableInteraction),
    ).rejects.toThrow("button");
    expect(events).toHaveLength(0);
  });

  it("rejects forged page values before user/workspace reads", async () => {
    const interaction = makeInteraction(buildStatusPageSelectorId("en-US", "behavior"), "string", ["forged"]);
    const events: string[] = [];
    const replies: unknown[] = [];
    interaction.editReply = async (payload) => {
      replies.push(payload);
      return payload;
    };
    const registry = makeRegistry(interaction, events, async () => categories(""));

    await registry.dispatch({} as Client, interaction as unknown as GlobalRoutableInteraction);

    expect(interaction.deferred).toBe(true);
    expect(events).toEqual([]);
    expect(replies).toHaveLength(1);
  });

  it("opens Persona from a fresh roster and rebuilds its five pages", async () => {
    const interaction = makeInteraction(buildStatusCategoryButtonId("en-US", "persona"), "button");
    const events: string[] = [];
    const replies: unknown[] = [];
    interaction.editReply = async (payload) => {
      replies.push(payload);
      return payload;
    };
    const registry = makeRegistry(interaction, events, async () => categories(""), [persona(2, "Sparrow")]);

    await registry.dispatch({} as Client, interaction as unknown as GlobalRoutableInteraction);

    expect(interaction.deferred).toBe(true);
    expect(events).toEqual(["user", "state", "personas", "pages", "persona:2"]);
    expect(replies).toHaveLength(1);
    expect(JSON.stringify(replies[0])).toContain("Sparrow");
    expect(JSON.stringify(replies[0])).toContain(buildStatusPersonaSelectorId("en-US", 2));
  });

  it("validates the selected Persona against a fresh roster before repainting", async () => {
    const interaction = makeInteraction(buildStatusPersonaSelectorId("en-US", 1), "string", ["2"]);
    const events: string[] = [];
    const replies: unknown[] = [];
    interaction.editReply = async (payload) => {
      replies.push(payload);
      return payload;
    };
    const registry = makeRegistry(interaction, events, async () => categories(""), [
      persona(1, "Main"),
      persona(2, "Sparrow"),
    ]);

    await registry.dispatch({} as Client, interaction as unknown as GlobalRoutableInteraction);

    expect(events).toEqual(["user", "state", "personas", "pages", "persona:2"]);
    expect(replies).toHaveLength(1);
    expect(JSON.stringify(replies[0])).toContain("Sparrow");
  });

  it("falls back safely when a selected Persona was deleted", async () => {
    const interaction = makeInteraction(buildStatusPersonaRangeId("en-US", 99, 25), "button");
    const events: string[] = [];
    const replies: unknown[] = [];
    interaction.editReply = async (payload) => {
      replies.push(payload);
      return payload;
    };
    const registry = makeRegistry(interaction, events, async () => categories(""), [persona(2, "Current")]);

    await registry.dispatch({} as Client, interaction as unknown as GlobalRoutableInteraction);

    expect(events).toEqual(["user", "state", "personas", "pages", "persona:2"]);
    expect(replies).toHaveLength(1);
    expect(JSON.stringify(replies[0])).toContain("Current");
  });

  it("carries a validated selected Persona through non-Persona navigation", async () => {
    const interaction = makeInteraction(buildStatusCategoryButtonId("en-US", "behavior", 2), "button");
    const events: string[] = [];
    const replies: unknown[] = [];
    interaction.editReply = async (payload) => {
      replies.push(payload);
      return payload;
    };
    const registry = makeRegistry(interaction, events, async () => categories(""), [persona(2, "Sparrow")]);

    await registry.dispatch({} as Client, interaction as unknown as GlobalRoutableInteraction);

    expect(events).toEqual(["user", "state", "personas", "pages"]);
    expect(replies).toHaveLength(1);
    expect(JSON.stringify(replies[0])).toContain(buildStatusCategoryButtonId("en-US", "persona", 2));
    expect(JSON.stringify(replies[0])).toContain(buildStatusPageSelectorId("en-US", "behavior", 2));
  });

  it("does not depend on the old command interaction ID", () => {
    expect(buildStatusCategoryButtonId("en-US", "behavior")).toBe("status:v1:category:en-US:behavior");
    expect(parseInteractionRoute("status:v1:category:en-US:behavior")?.segments).toEqual([
      "category",
      "en-US",
      "behavior",
    ]);
  });
});
