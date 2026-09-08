import { describe, expect, it } from "bun:test";
import { ButtonStyle, ComponentType, MessageFlags, type ChatInputCommandInteraction, type Client } from "discord.js";
import type { TomoriState, UserRow } from "@/types/db/schema";
import type { SummaryEmbedOptions } from "@/types/discord/embed";
import { ColorCode } from "@/utils/misc/logger";
import { executeStatusCommand, type StatusCommandDependencies } from "@/utils/metrics/status/command";
import {
  dashboardPayload,
  renderStatusPageDashboard,
  type StatusPageCategory,
} from "@/utils/metrics/status/statusPageRenderer";

type DependencyCall<Name extends keyof StatusCommandDependencies> = Parameters<StatusCommandDependencies[Name]>;
type CachedTomoriState = NonNullable<Awaited<ReturnType<StatusCommandDependencies["getCachedTomoriState"]>>>;

type MockInteraction = {
  id: string;
  guildId: string | null;
  user: { id: string };
  options: { getString: (name: string, required: boolean) => string };
  deferred: boolean;
  replied: boolean;
  deferReply: (options?: { flags?: MessageFlags }) => Promise<void>;
};

type DependencyCalls = {
  personas: DependencyCall<"getCachedAllPersonas">[];
  cache: DependencyCall<"getCachedTomoriState">[];
  info: DependencyCall<"replyInfoEmbed">[];
  personal: DependencyCall<"showPersonalStatus">[];
  configPages: DependencyCall<"buildServerConfigPages">[];
  modelPages: DependencyCall<"buildServerModelPages">[];
  channelPages: DependencyCall<"buildServerChannelPages">[];
  buildPersonalPages: DependencyCall<"buildPersonalStatusPages">[];
  buildPersonaPages: DependencyCall<"buildPersonaStatusPages">[];
  dashboard: DependencyCall<"renderStatusPageDashboard">[];
};

const client = { user: { id: "bot-user" } } as Client;
const userData = { user_id: 42, user_disc_id: "user-42" } as UserRow;
const tomoriState = { persona_id: 1, persona_nickname: "Main", is_alter: false } as CachedTomoriState;
const personas = [tomoriState] as TomoriState[];
const personaPages = Array.from(
  { length: 5 },
  (_, index) => ({ titleKey: `persona-${index}`, fields: [] }) as SummaryEmbedOptions,
);
const personalPages = Array.from(
  { length: 2 },
  (_, index) => ({ titleKey: `personal-${index}`, fields: [] }) as SummaryEmbedOptions,
);
const configPages = Array.from(
  { length: 5 },
  (_, index) => ({ titleKey: `config-${index}`, fields: [] }) as SummaryEmbedOptions,
);
const modelPages = Array.from(
  { length: 4 },
  (_, index) => ({ titleKey: `model-${index}`, fields: [] }) as SummaryEmbedOptions,
);
const channelPages = [{ titleKey: "channels", fields: [] } as SummaryEmbedOptions];

const expectedSiblingCategories: StatusPageCategory[] = [
  {
    id: "behavior",
    labelKey: "commands.status.scope_choice_behavior",
    pages: [configPages[0], configPages[3], channelPages[0]],
  },
  {
    id: "models",
    labelKey: "commands.status.scope_choice_models",
    pages: [modelPages[0], modelPages[1], modelPages[3], configPages[4]],
  },
  {
    id: "access",
    labelKey: "commands.status.scope_choice_access",
    pages: [configPages[1], configPages[2], modelPages[2]],
  },
  {
    id: "personal",
    labelKey: "commands.status.scope_choice_personal",
    pages: personalPages,
  },
];

const expectedCategories: StatusPageCategory[] = [
  {
    id: "persona",
    labelKey: "commands.status.scope_choice_persona",
    pages: personaPages,
  },
  ...expectedSiblingCategories,
];

function createInteraction(guildId: string | null, interactionId = "interaction-123") {
  const deferCalls: ({ flags?: MessageFlags } | undefined)[] = [];
  const interaction: MockInteraction = {
    id: interactionId,
    guildId,
    user: { id: "dm-user" },
    deferred: false,
    replied: false,
    deferReply: async (options) => {
      deferCalls.push(options);
      interaction.deferred = true;
    },
    options: {
      getString: () => {
        throw new Error("/status must not read command options");
      },
    },
  };

  return { interaction, deferCalls };
}

function createDependencies(interaction: MockInteraction, state: CachedTomoriState | null) {
  const calls: DependencyCalls = {
    personas: [],
    cache: [],
    info: [],
    personal: [],
    configPages: [],
    modelPages: [],
    channelPages: [],
    buildPersonalPages: [],
    buildPersonaPages: [],
    dashboard: [],
  };
  const expectAcknowledged = () => expect(interaction.deferred || interaction.replied).toBe(true);

  const dependencies: StatusCommandDependencies = {
    getCachedAllPersonas: async (...args) => {
      calls.personas.push(args);
      expectAcknowledged();
      return personas;
    },
    getCachedTomoriState: async (...args) => {
      calls.cache.push(args);
      expectAcknowledged();
      return state;
    },
    replyInfoEmbed: async (...args) => {
      calls.info.push(args);
      expectAcknowledged();
    },
    showPersonalStatus: async (...args) => {
      calls.personal.push(args);
      expectAcknowledged();
    },
    buildServerConfigPages: async (...args) => {
      calls.configPages.push(args);
      expectAcknowledged();
      return configPages;
    },
    buildServerModelPages: async (...args) => {
      calls.modelPages.push(args);
      expectAcknowledged();
      return modelPages;
    },
    buildServerChannelPages: async (...args) => {
      calls.channelPages.push(args);
      expectAcknowledged();
      return channelPages;
    },
    buildPersonalStatusPages: async (...args) => {
      calls.buildPersonalPages.push(args);
      expectAcknowledged();
      return personalPages;
    },
    buildPersonaStatusPages: async (...args) => {
      calls.buildPersonaPages.push(args);
      expectAcknowledged();
      return personaPages;
    },
    renderStatusPageDashboard: async (...args) => {
      calls.dashboard.push(args);
      expectAcknowledged();
    },
  };

  return { dependencies, calls };
}

function expectNoPageBuilderCalls(calls: DependencyCalls): void {
  expect(calls.configPages).toHaveLength(0);
  expect(calls.modelPages).toHaveLength(0);
  expect(calls.channelPages).toHaveLength(0);
  expect(calls.buildPersonalPages).toHaveLength(0);
  expect(calls.buildPersonaPages).toHaveLength(0);
  expect(calls.personas).toHaveLength(0);
  expect(calls.dashboard).toHaveLength(0);
  expect(calls.personal).toHaveLength(0);
}

describe("executeStatusCommand", () => {
  it("acknowledges before reads and opens the main Persona with all five categories", async () => {
    const { interaction, deferCalls } = createInteraction("guild-123");
    const { dependencies, calls } = createDependencies(interaction, tomoriState);
    await executeStatusCommand(
      client,
      interaction as unknown as ChatInputCommandInteraction,
      userData,
      "en-US",
      dependencies,
    );

    expect(deferCalls).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(calls.info).toHaveLength(0);
    expect(calls.cache).toEqual([["guild-123"]]);
    expect(calls.configPages).toEqual([[client, tomoriState, "en-US"]]);
    expect(calls.modelPages).toEqual([[client, "guild-123", tomoriState, "en-US"]]);
    expect(calls.channelPages).toEqual([[client, "guild-123", tomoriState, "en-US"]]);
    expect(calls.buildPersonalPages).toEqual([
      [interaction as unknown as ChatInputCommandInteraction, userData, "en-US"],
    ]);
    expect(calls.dashboard).toHaveLength(1);
    expect(calls.personas).toEqual([["guild-123"]]);
    expect(calls.buildPersonaPages).toEqual([[tomoriState, userData, "en-US"]]);
    expect(calls.dashboard[0]?.[2]).toEqual(expectedCategories);
    expect((calls.dashboard[0]?.[2] as StatusPageCategory[]).map(({ id }) => id)).toEqual([
      "persona",
      "behavior",
      "models",
      "access",
      "personal",
    ]);
    expect(calls.dashboard[0]?.[3]).toBe("persona");
    expect(calls.dashboard[0]?.[4]).toEqual({ selectedPersonaId: 1, personas });
  });

  it("renders exactly the five ordered buttons and expected page counts at the seam", () => {
    const orderedCategoryIds = ["persona", "behavior", "models", "access", "personal"] as const;
    const expectedPageCounts = { persona: 5, behavior: 3, models: 4, access: 3, personal: 2 };

    for (const scope of orderedCategoryIds) {
      const payload = dashboardPayload("anchor-456", "en-US", expectedCategories, scope, 0, false);
      const container = payload.components[0] as {
        components: Array<{
          type: ComponentType;
          components?: Array<{ type: ComponentType; customId?: string; style?: ButtonStyle; options?: unknown[] }>;
        }>;
      };

      const buttonRow = container.components[0];
      expect(buttonRow.type).toBe(ComponentType.ActionRow);
      expect(buttonRow.components).toHaveLength(5);

      const buttons = buttonRow.components ?? [];
      expect(buttons.map((b) => b.customId)).toEqual(orderedCategoryIds.map((id) => `status:v1:category:en-US:${id}`));

      for (const [index, id] of orderedCategoryIds.entries()) {
        const expectedStyle = id === scope ? ButtonStyle.Primary : ButtonStyle.Secondary;
        expect(buttons[index]?.style).toBe(expectedStyle);
      }

      const selectRow = container.components[2];
      expect(selectRow.type).toBe(ComponentType.ActionRow);
      const selectMenu = selectRow.components?.[0];
      expect(selectMenu?.type).toBe(ComponentType.StringSelect);
      expect(selectMenu?.options).toHaveLength(expectedPageCounts[scope]);
    }
  });

  it("uses the DM user ID as the effective server ID", async () => {
    const { interaction } = createInteraction(null);
    const { dependencies, calls } = createDependencies(interaction, tomoriState);
    await executeStatusCommand(
      client,
      interaction as unknown as ChatInputCommandInteraction,
      userData,
      "ja",
      dependencies,
    );

    expect(calls.cache).toEqual([["dm-user"]]);
    expect(calls.channelPages).toEqual([[client, "dm-user", tomoriState, "ja"]]);
    expect(calls.modelPages).toEqual([[client, "dm-user", tomoriState, "ja"]]);
    expect(calls.personas).toEqual([["dm-user"]]);
    expect(calls.buildPersonaPages).toEqual([[tomoriState, userData, "ja"]]);
    expect(calls.dashboard[0]?.[2]).toEqual(expectedCategories);
    expect(calls.dashboard[0]?.[3]).toBe("persona");
  });

  it("replies for not-setup server categories without building pages", async () => {
    const { interaction } = createInteraction("guild-empty");
    const { dependencies, calls } = createDependencies(interaction, null);
    await executeStatusCommand(
      client,
      interaction as unknown as ChatInputCommandInteraction,
      userData,
      "en-US",
      dependencies,
    );

    expect(calls.cache).toEqual([["guild-empty"]]);
    expect(calls.info).toEqual([
      [
        interaction,
        "en-US",
        {
          titleKey: "general.errors.tomori_not_setup_title",
          descriptionKey: "general.errors.tomori_not_setup_description",
          color: ColorCode.ERROR,
        },
      ],
    ]);
    expectNoPageBuilderCalls(calls);
  });

  it("renders the Persona control as a persistent global route", async () => {
    const { interaction } = createInteraction("guild-123", "anchor-789");
    const { dependencies } = createDependencies(interaction, tomoriState);
    const deliveredDashboardPayloads: unknown[] = [];
    const mockInteraction = interaction as unknown as ChatInputCommandInteraction & {
      editReply: (payload: unknown) => Promise<unknown>;
    };
    mockInteraction.editReply = async (payload: unknown) => {
      deliveredDashboardPayloads.push(payload);
      return payload;
    };
    dependencies.renderStatusPageDashboard = renderStatusPageDashboard;

    await executeStatusCommand(client, mockInteraction, userData, "en-US", dependencies);

    expect(deliveredDashboardPayloads).toHaveLength(1);
    const serialized = JSON.stringify(deliveredDashboardPayloads[0]);
    expect(serialized).toContain('"customId":"status:v1:category:en-US:persona:1"');
    expect(serialized).toContain('"customId":"status:v1:category:en-US:behavior:1"');
    expect(serialized).toContain('"customId":"status:v1:page:en-US:persona:1"');
    expect(serialized).toContain('"customId":"status:v1:persona-select:en-US:1"');
    expect(serialized).toMatch(/"customId":"status:v1:category:en-US:persona:1","label":"[^"]+","disabled":false/);
  });
});
