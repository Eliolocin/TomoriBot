import { describe, expect, it } from "bun:test";
import { ButtonStyle, ComponentType, MessageFlags, type ChatInputCommandInteraction, type Client } from "discord.js";
import type { UserRow } from "@/types/db/schema";
import type { SummaryEmbedOptions } from "@/types/discord/embed";
import { ColorCode } from "@/utils/misc/logger";
import { executeStatusCommand, type StatusCommandDependencies } from "@/utils/metrics/status/command";
import {
  dashboardPayload,
  renderStatusPageDashboard,
  type StatusPageCategory,
} from "@/utils/metrics/status/statusPageRenderer";

type StatusScope = "personal" | "persona" | "behavior" | "models" | "access";
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
  cache: DependencyCall<"getCachedTomoriState">[];
  info: DependencyCall<"replyInfoEmbed">[];
  personal: DependencyCall<"showPersonalStatus">[];
  persona: DependencyCall<"showPersonaStatus">[];
  configPages: DependencyCall<"buildServerConfigPages">[];
  modelPages: DependencyCall<"buildServerModelPages">[];
  channelPages: DependencyCall<"buildServerChannelPages">[];
  buildPersonalPages: DependencyCall<"buildPersonalStatusPages">[];
  buildPersonaPages: DependencyCall<"buildPersonaStatusPages">[];
  dashboard: DependencyCall<"renderStatusPageDashboard">[];
};

const client = { user: { id: "bot-user" } } as Client;
const userData = { user_id: 42, user_disc_id: "user-42" } as UserRow;
const tomoriState = {} as CachedTomoriState;
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

const expectedInitialCategories: StatusPageCategory[] = [
  {
    id: "persona",
    labelKey: "commands.status.scope_choice_persona",
    pages: [],
  },
  ...expectedSiblingCategories,
];

function createInteraction(scope: string, guildId: string | null, interactionId = "interaction-123") {
  const deferCalls: ({ flags?: MessageFlags } | undefined)[] = [];
  const interaction: MockInteraction = {
    id: interactionId,
    guildId,
    user: { id: "dm-user" },
    options: {
      getString: (name, required) => {
        expect(name).toBe("scope");
        expect(required).toBe(true);
        return scope;
      },
    },
    deferred: false,
    replied: false,
    deferReply: async (options) => {
      deferCalls.push(options);
      interaction.deferred = true;
    },
  };

  return { interaction, deferCalls };
}

function createDependencies(interaction: MockInteraction, state: CachedTomoriState | null) {
  const calls: DependencyCalls = {
    cache: [],
    info: [],
    personal: [],
    persona: [],
    configPages: [],
    modelPages: [],
    channelPages: [],
    buildPersonalPages: [],
    buildPersonaPages: [],
    dashboard: [],
  };
  const expectAcknowledged = () => expect(interaction.deferred || interaction.replied).toBe(true);

  const dependencies: StatusCommandDependencies = {
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
    showPersonaStatus: async (...args) => {
      calls.persona.push(args);
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
  expect(calls.dashboard).toHaveLength(0);
  expect(calls.persona).toHaveLength(0);
  expect(calls.personal).toHaveLength(0);
}

describe("executeStatusCommand", () => {
  it("acknowledges before dispatching and delivers all 5 ordered categories across scopes", async () => {
    const scopes: StatusScope[] = ["persona", "behavior", "models", "access", "personal"];

    for (const scope of scopes) {
      const { interaction, deferCalls } = createInteraction(scope, "guild-123");
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

      if (scope === "persona") {
        expect(calls.persona).toEqual([
          [
            interaction as unknown as ChatInputCommandInteraction,
            userData,
            "guild-123",
            "en-US",
            expectedSiblingCategories,
          ],
        ]);
        expect(calls.dashboard).toHaveLength(0);
      } else {
        expect(calls.buildPersonaPages).toHaveLength(0);
        expect(calls.dashboard).toEqual([
          [
            interaction as unknown as ChatInputCommandInteraction,
            "en-US",
            expectedInitialCategories,
            scope,
            expect.any(Function),
          ],
        ]);
      }
    }
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
      expect(buttons.map((b) => b.customId)).toEqual(
        orderedCategoryIds.map((id) => `status:anchor-456:category:${id}`),
      );

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
    for (const scope of ["behavior", "models", "access"] as const) {
      const { interaction } = createInteraction(scope, null);
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
    }
  });

  it("replies for not-setup server categories without building pages", async () => {
    for (const scope of ["persona", "behavior", "models", "access", "personal"] as const) {
      const { interaction } = createInteraction(scope, "guild-empty");
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
    }
  });

  it("replies for an invalid scope after acknowledgement", async () => {
    const { interaction } = createInteraction("unknown", "guild-123");
    const { dependencies, calls } = createDependencies(interaction, tomoriState);
    await executeStatusCommand(
      client,
      interaction as unknown as ChatInputCommandInteraction,
      userData,
      "en-US",
      dependencies,
    );

    expect(calls.cache).toHaveLength(0);
    expect(calls.info).toEqual([
      [
        interaction,
        "en-US",
        {
          titleKey: "general.errors.unknown_error_title",
          descriptionKey: "general.errors.unknown_error_description",
          color: ColorCode.ERROR,
        },
      ],
    ]);
    expectNoPageBuilderCalls(calls);
  });

  it("enters the persona workflow when activating Persona from a non-Persona scope and renders the selected persona", async () => {
    const { interaction } = createInteraction("behavior", "guild-123", "anchor-789");
    const { dependencies } = createDependencies(interaction, tomoriState);

    let capturedCollectorHandler:
      | ((component: {
          customId: string;
          user: { id: string };
          deferUpdate?: () => Promise<void>;
          update?: (payload: unknown) => Promise<void>;
        }) => Promise<void>)
      | undefined;
    let collectorStoppedWithReason: string | undefined;

    const deliveredDashboardPayloads: unknown[] = [];
    const mockMessage = {
      createMessageComponentCollector: () => ({
        on: (
          event: string,
          handler: (component: {
            customId: string;
            user: { id: string };
            deferUpdate?: () => Promise<void>;
            update?: (payload: unknown) => Promise<void>;
          }) => Promise<void>,
        ) => {
          if (event === "collect") {
            capturedCollectorHandler = handler;
          }
        },
        stop: (reason?: string) => {
          collectorStoppedWithReason = reason;
        },
      }),
    };

    const mockInteraction = interaction as unknown as ChatInputCommandInteraction & {
      editReply: (payload: unknown) => Promise<unknown>;
    };
    mockInteraction.editReply = async (payload: unknown) => {
      deliveredDashboardPayloads.push(payload);
      return mockMessage;
    };

    dependencies.renderStatusPageDashboard = renderStatusPageDashboard;

    const nonDefaultPersona = {
      persona_id: 2,
      server_id: 1,
      persona_nickname: "Sparrow",
      persona_lineage_id: 2,
    } as CachedTomoriState;
    const sparrowPages = [
      {
        titleKey: "commands.status.persona_page1_title",
        titleVars: { persona_name: nonDefaultPersona.persona_nickname },
        fields: [{ nameKey: "commands.status.field_nickname", value: nonDefaultPersona.persona_nickname }],
      } as SummaryEmbedOptions,
      { titleKey: "commands.status.persona_page2_title", fields: [] } as SummaryEmbedOptions,
      { titleKey: "commands.status.persona_page3_title", fields: [] } as SummaryEmbedOptions,
      { titleKey: "commands.status.persona_page4_title", fields: [] } as SummaryEmbedOptions,
      { titleKey: "commands.status.persona_page5_title", fields: [] } as SummaryEmbedOptions,
    ];

    let pickerInvoked = false;
    let renderedPersonaPayload: unknown = null;
    dependencies.showPersonaStatus = async (personaInteraction, _user, _serverDiscId, locale, siblings) => {
      pickerInvoked = true;
      const fullCategories: StatusPageCategory[] = [
        {
          id: "persona",
          labelKey: "commands.status.scope_choice_persona",
          pages: sparrowPages,
        },
        ...(siblings ?? []),
      ];
      renderedPersonaPayload = dashboardPayload("anchor-789", locale, fullCategories, "persona", 0, false);
      if ("update" in personaInteraction && typeof personaInteraction.update === "function") {
        await personaInteraction.update(renderedPersonaPayload);
      }
    };

    await executeStatusCommand(client, mockInteraction, userData, "en-US", dependencies);

    expect(deliveredDashboardPayloads).toHaveLength(1);
    expect(capturedCollectorHandler).toBeDefined();

    const personaButtonInteraction = {
      id: "btn-persona",
      customId: "status:anchor-789:category:persona",
      user: { id: "dm-user" },
      deferred: false,
      replied: false,
      deferUpdate: async () => {
        personaButtonInteraction.deferred = true;
      },
      update: async (payload: unknown) => {
        renderedPersonaPayload = payload;
      },
    };

    await capturedCollectorHandler?.(personaButtonInteraction);

    expect(collectorStoppedWithReason).toBe("persona_transition");
    expect(pickerInvoked).toBe(true);
    expect(renderedPersonaPayload).not.toBeNull();

    const serialized = JSON.stringify(renderedPersonaPayload);
    expect(serialized).toContain("Sparrow");
    expect(serialized).toContain("status:anchor-789:category:persona");
    expect(serialized).toContain("status:anchor-789:category:behavior");
    expect(serialized).toContain("status:anchor-789:category:models");
    expect(serialized).toContain("status:anchor-789:category:access");
    expect(serialized).toContain("status:anchor-789:category:personal");
  });
});
