import { beforeAll, describe, expect, it, mock } from "bun:test";
import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import type { TomoriState, UserRow } from "@/types/db/schema";
import { ComponentsV2LimitError, validateComponentsV2MessageLimits } from "@/utils/discord/ui/componentsV2Limits";
import { buildDashboardPagePayload, type DashboardPage } from "@/utils/metrics/status/statusPageRenderer";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";
import * as realDbClient from "@/utils/db/client";
import * as realPersonaWorkflow from "@/utils/discord/ui/personaWorkflow";
import * as realRepositories from "@/utils/db/repositories";
import { createScopedModuleMocker, overrideMembers, stubLogMembers } from "../../helpers/mockSurface";

const emptyRows = async () => [];
let personaStatusRows: TomoriState[] = [];
const personaStatusPayloads: unknown[] = [];
let activePersonaButton: { deferred: boolean; replied: boolean } | null = null;
let personaReadAcknowledged: boolean | null = null;

interface PersonaStatusMessage {
  anchorMessageId: string;
  replace: (payload: unknown) => Promise<void>;
  fetchMessage: () => Promise<{ awaitMessageComponent: () => Promise<PersonaStatusPageSelector> }>;
}

interface PersonaStatusPageSelector {
  values: string[];
  update: (payload: unknown) => Promise<void>;
}

interface PersonaStatusComponent {
  type?: ComponentType;
  disabled?: boolean;
  options?: Array<{ value: string; default?: boolean }>;
  components?: PersonaStatusComponent[];
}

function findPersonaPageSelector(payload: unknown): PersonaStatusComponent {
  const find = (component: PersonaStatusComponent): PersonaStatusComponent | undefined => {
    if (component.type === ComponentType.StringSelect) return component;
    for (const child of component.components ?? []) {
      const selected = find(child);
      if (selected) return selected;
    }
    return undefined;
  };

  const root = payload as { components?: PersonaStatusComponent[] };
  for (const component of root.components ?? []) {
    const selector = find(component);
    if (selector) return selector;
  }
  throw new Error("Persona status payload did not contain a page selector.");
}

interface PersonaStatusSelection {
  persona: TomoriState;
  message: PersonaStatusMessage;
  beginInPlaceWork: () => Promise<{ message: PersonaStatusMessage }>;
}

interface PersonaStatusPickerOptions {
  personas: TomoriState[];
  onSelected: (selection: PersonaStatusSelection) => Promise<unknown>;
}

function makeStatusPersona(populated: boolean): TomoriState {
  return {
    persona_id: 1,
    server_id: 1,
    persona_nickname: "Sparrow",
    persona_prompt: populated ? "persona prompt ".repeat(800) : null,
    context_note: populated ? "context note ".repeat(400) : null,
    persona_attributes: populated
      ? Array.from({ length: 20 }, (_, index) => ({ attribute_text: `attribute ${index}`, is_public: index % 2 === 0 }))
      : [],
    attribute_list: populated ? ["fallback attribute"] : [],
    sample_dialogues_in: populated ? ["dialogue input ".repeat(120)] : [],
    sample_dialogues_out: populated ? ["dialogue output ".repeat(120)] : [],
    server_memories: populated ? Array.from({ length: 20 }, (_, index) => `server memory ${index} `.repeat(30)) : [],
    trigger_words: populated ? ["Sparrow", "status"] : [],
    physical_appearance_tags: populated ? ["curious", "kind", "patient"] : [],
    persona_llm: null,
    config: { custom_model_name: null, other_model_codename: null },
    is_alter: false,
    webhook_avatar_url: populated ? "https://example.invalid/sparrow.png" : null,
    speech_voice_name: populated ? "voice" : null,
    nai_char_ref_url: populated ? "https://example.invalid/reference.png" : null,
    reward_conditioning_enabled: true,
    punish_conditioning_enabled: true,
    nai_attg_author: populated ? "author" : null,
    nai_attg_title: populated ? "title" : null,
    nai_attg_tags: populated ? "tags" : null,
    nai_attg_genre: populated ? "genre" : null,
    nai_attg_stars: populated ? 5 : null,
    persona_lineage_id: 1,
    context_note_depth: populated ? 12 : 0,
  } as unknown as TomoriState;
}

const quotaConfig = {
  enabled: false,
  daily_user_quota: null,
  serverwide_quota: null,
  serverwide_quota_resets_in: 0,
};

const scopedMock = createScopedModuleMocker(mock, {
  "@/utils/db/client": realDbClient,
  "@/utils/db/repositories": realRepositories,
  "@/utils/discord/ui/personaWorkflow": realPersonaWorkflow,
});

stubLogMembers({ warn: () => undefined });

scopedMock.module("@/utils/db/client", () => ({ ...realDbClient, sql: emptyRows }));
scopedMock.module("@/utils/db/repositories", () => ({
  ...realRepositories,
  llmProviderRepo: overrideMembers(realRepositories.llmProviderRepo, {
    loadSavedProviderConfigs: emptyRows,
    loadCustomEndpointsForServer: emptyRows,
    loadUserSavedProviderConfigs: emptyRows,
    loadCustomEndpointsForUser: emptyRows,
  }),
  llmModelRepo: overrideMembers(realRepositories.llmModelRepo, { loadEmbeddingModelById: async () => null }),
  llmOverrideRepo: overrideMembers(realRepositories.llmOverrideRepo, { getAllChannelLlmOverridesForServer: emptyRows }),
  personaRepository: overrideMembers(realRepositories.personaRepository, {
    loadAllForServer: async () => {
      personaReadAcknowledged = activePersonaButton
        ? activePersonaButton.deferred || activePersonaButton.replied
        : null;
      return personaStatusRows;
    },
  }),
  personalMemoryRepository: overrideMembers(realRepositories.personalMemoryRepository, {
    loadForUserLineage: emptyRows,
  }),
  serverScheduleRepository: overrideMembers(realRepositories.serverScheduleRepository, {
    getServerTriggers: emptyRows,
    getUserReminderCount: async () => 0,
  }),
  userRepository: overrideMembers(realRepositories.userRepository, { getBlacklistedMemberIds: emptyRows }),
}));
mock.module("@/utils/db/repositories/ToolRepository", () => ({ toolRepository: { loadMcpServers: emptyRows } }));
mock.module("@/utils/db/repositories/PresetRepository", () => ({
  presetRepository: { loadPresetsForServer: emptyRows, loadToggleableNodes: emptyRows },
}));
mock.module("@/utils/db/repositories/WhitelistRepository", () => ({
  whitelistRepository: {
    getAllWhitelistPersonas: emptyRows,
    getAllWhitelistChannels: emptyRows,
    getAllWhitelistRoles: emptyRows,
  },
}));
mock.module("@/utils/image/naiDiffusionModels", () => ({ getDiffusionModelById: async () => null }));
mock.module("@/utils/quota/imageQuotaManager", () => ({ getQuotaConfig: async () => quotaConfig }));
mock.module("@/utils/quota/textQuotaManager", () => ({ getTextQuotaConfig: async () => quotaConfig }));
mock.module("@/utils/quota/videoQuotaManager", () => ({ getVideoQuotaConfig: async () => quotaConfig }));
mock.module("@/utils/provider/speechEndpointResolver", () => ({
  resolveActiveSpeechEndpoint: async () => null,
  resolveActiveTranscriptionEndpoint: async () => null,
}));
mock.module("@/utils/provider/customEndpointService", () => ({ resolveCustomEndpointForProvider: async () => null }));
mock.module("@/utils/metrics/dbStats", () => ({ loadVideoModelById: async () => null }));
scopedMock.module("@/utils/discord/ui/personaWorkflow", () => ({
  ...realPersonaWorkflow,
  PersonaWorkflowUpdateError: class PersonaWorkflowUpdateError extends Error {},
  buildPersonaWorkflowNotice: () => ({
    components: [
      {
        type: ComponentType.Container,
        components: [{ type: ComponentType.TextDisplay, content: "persona workflow notice" }],
      },
    ],
    flags: MessageFlags.IsComponentsV2,
  }),
  completePersonaWorkflow: () => ({ outcome: "selected" }),
  runPersonaPickerWorkflow: async (_interaction: unknown, _locale: string, options: PersonaStatusPickerOptions) => {
    const persona = options.personas[0];
    if (!persona) throw new Error("Persona fixture is empty.");

    let nextPage = 1;
    const message: PersonaStatusMessage = {
      anchorMessageId: "persona-status-anchor",
      replace: async (payload) => {
        personaStatusPayloads.push(payload);
      },
      fetchMessage: async () => ({
        awaitMessageComponent: async () => {
          if (nextPage >= 5) throw "time";
          const page = nextPage++;
          return {
            values: [String(page)],
            update: async (payload: unknown) => {
              personaStatusPayloads.push(payload);
            },
          };
        },
      }),
    };

    return options.onSelected({
      persona,
      message,
      beginInPlaceWork: async () => ({ message }),
    });
  },
}));

const RUNTIME_LOCALES = ["en-US", "ja"] as const;
const COMPONENT_BUDGET = 36;

function countComponents(component: unknown): number {
  if (Array.isArray(component)) return component.reduce((total, item) => total + countComponents(item), 0);
  if (!component || typeof component !== "object") return 0;
  const value = component as { components?: unknown[] };
  return 1 + (value.components?.reduce((total, item) => total + countComponents(item), 0) ?? 0);
}

function emptyConfig(overrides: Record<string, unknown> = {}): TomoriState["config"] {
  return new Proxy(
    {
      timezone_offset: 0,
      cooldown_type: "off",
      tool_notice_hidden_keys: [],
      llm_disabled_params: [],
      llm_logit_biases: [],
      image_default_positive_tags: [],
      image_default_negative_tags: [],
      crosschannel_blocklist_ids: [],
      private_channel_ids: [],
      rp_channel_ids: [],
      ...overrides,
    },
    { get: (config, key) => (key in config ? config[key as keyof typeof config] : null) },
  ) as TomoriState["config"];
}

const client = { channels: { cache: new Map() } } as unknown as Client;
const interaction = { user: { id: "status-user" } } as unknown as ChatInputCommandInteraction;
const state = { server_id: 1, config: emptyConfig(), llm: null, vision_llm: null } as TomoriState;
const user = { user_id: 1, user_disc_id: "status-user", language_pref: "en-US" } as UserRow;
const populatedState = {
  ...state,
  config: emptyConfig({
    system_prompt: "configured system prompt ".repeat(800),
    context_note: "configured context note ".repeat(400),
    image_default_positive_tags: ["bright", "detailed"],
    image_default_negative_tags: ["blurry"],
    llm_disabled_params: ["top_k"],
    llm_logit_biases: [{ token: "status", bias: 1 }],
    crosschannel_blocklist_ids: ["42"],
    private_channel_ids: ["43"],
    rp_channel_ids: ["44"],
    welcome_prompt: "welcome prompt",
  }),
} as TomoriState;
const populatedUser = {
  ...user,
  impersonation_prompt: "personal prompt ".repeat(800),
  physical_appearance_tags: ["kind", "curious"],
  nai_char_ref_url: "https://example.invalid/reference.png",
} as UserRow;

beforeAll(async () => {
  await initializeLocalizer();
});

describe("actual status page builders", () => {
  it("acknowledges a Persona category button before loading personas", async () => {
    const { showPersonaStatus } = await import("@/utils/metrics/status/personaPages");
    const personaUser = { user_id: null, user_disc_id: "status-user" } as UserRow;
    const button = {
      user: { id: "status-user" },
      deferred: false,
      replied: false,
      deferUpdate: async () => {
        button.deferred = true;
      },
    };

    activePersonaButton = button;
    personaStatusRows = [makeStatusPersona(false)];
    personaReadAcknowledged = null;

    try {
      await showPersonaStatus(button as unknown as ButtonInteraction, personaUser, "status-server", "en-US");
      expect(personaReadAcknowledged).toBe(true);
    } finally {
      activePersonaButton = null;
      personaStatusRows = [];
      personaStatusPayloads.length = 0;
    }
  });

  it("keeps sparse and populated Persona status pages within the reserved budget", async () => {
    const { showPersonaStatus } = await import("@/utils/metrics/status/personaPages");
    const personaUser = { user_id: null, user_disc_id: "status-user" } as UserRow;

    for (const populated of [false, true]) {
      personaStatusRows = [makeStatusPersona(populated)];
      personaStatusPayloads.length = 0;

      try {
        await showPersonaStatus(interaction, personaUser, "status-server", "en-US");
        expect(personaStatusPayloads).toHaveLength(7);

        const renderedPages = personaStatusPayloads.slice(1);
        expect(renderedPages).toHaveLength(6);
        const pageTitles = [
          "### Sparrow: Identity",
          "### Sparrow: Attributes",
          "### Sparrow: Sample Dialogues",
          "### Sparrow: Memories",
          "### Sparrow: Prompt and Tags",
        ];
        const pagePayloads = renderedPages.slice(0, 5);
        for (const [pageIndex, payload] of pagePayloads.entries()) {
          const typedPayload = payload as Parameters<typeof validateComponentsV2MessageLimits>[0];
          expect(countComponents(typedPayload.components)).toBeLessThanOrEqual(COMPONENT_BUDGET);
          expect(validateComponentsV2MessageLimits(typedPayload).valid).toBe(true);
          const selector = findPersonaPageSelector(payload);
          expect(selector.disabled).toBe(false);
          expect(selector.options?.map((option) => option.value)).toEqual(["0", "1", "2", "3", "4"]);
          expect(selector.options?.filter((option) => option.default).map((option) => option.value)).toEqual([
            String(pageIndex),
          ]);
          expect(JSON.stringify(payload)).toContain(pageTitles[pageIndex]);
        }

        const terminalPayload = renderedPages[5];
        expect(findPersonaPageSelector(terminalPayload).disabled).toBe(true);
        expect(JSON.stringify(terminalPayload)).toContain(pageTitles[4]);

        const serialized = JSON.stringify(renderedPages);
        if (populated) {
          expect(serialized).toContain("persona prompt");
        } else {
          expect(serialized).not.toContain("persona prompt");
        }
      } finally {
        personaStatusRows = [];
        personaStatusPayloads.length = 0;
      }
    }
  });

  it("renders API and welcome prompt producers without their sensitive values", async () => {
    const apiKeySecret = "builder-api-secret";
    const welcomePromptSecret = "builder-welcome-prompt-secret";
    const producerState = {
      ...state,
      config: emptyConfig({ api_key: Buffer.from(apiKeySecret), welcome_prompt: welcomePromptSecret }),
    } as TomoriState;
    const { buildServerConfigPages } = await import("@/utils/metrics/status/serverConfigPages");
    const { buildServerChannelPages } = await import("@/utils/metrics/status/serverChannelPages");
    const [configPages, channelPages] = await Promise.all([
      buildServerConfigPages(client, producerState, "en-US"),
      buildServerChannelPages(client, "status-server", producerState, "en-US"),
    ]);
    const payloads = [...configPages, ...channelPages].map((page) =>
      buildDashboardPagePayload({ locale: "en-US", page: page as DashboardPage }),
    );
    const serialized = JSON.stringify(payloads);

    expect(serialized).toContain(localizer("en-US", "commands.status.field_api_key_set"));
    expect(serialized).toContain(localizer("en-US", "commands.status.field_welcome_prompt"));
    expect(serialized).toContain(localizer("en-US", "commands.choices.enabled"));
    expect(serialized).not.toContain(apiKeySecret);
    expect(serialized).not.toContain(welcomePromptSecret);
  });

  it("keeps every built page and its real dashboard controls within the reserved budget, with all fields surviving", async () => {
    const { buildPersonaStatusPages } = await import("@/utils/metrics/status/personaPages");
    const { buildServerConfigPages } = await import("@/utils/metrics/status/serverConfigPages");
    const { buildServerModelPages } = await import("@/utils/metrics/status/serverModelPages");
    const { buildServerChannelPages } = await import("@/utils/metrics/status/serverChannelPages");
    const { buildPersonalStatusPages } = await import("@/utils/metrics/status/personalPages");

    for (const locale of RUNTIME_LOCALES) {
      for (const [tomoriState, userData] of [
        [state, user],
        [populatedState, populatedUser],
      ] as const) {
        const [configPages, modelPages, channelPages, personaPages, personalPages] = await Promise.all([
          buildServerConfigPages(client, tomoriState, locale),
          buildServerModelPages(client, "status-server", tomoriState, locale),
          buildServerChannelPages(client, "status-server", tomoriState, locale),
          buildPersonaStatusPages(tomoriState, userData, locale),
          buildPersonalStatusPages(interaction, userData, locale),
        ]);

        const categories = [
          {
            id: "persona",
            labelKey: "commands.status.scope_choice_persona",
            pages: personaPages,
          },
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

        expect(categories.map((c) => c.pages.length)).toEqual([5, 3, 4, 3, 2]);
        expect(categories.flatMap((c) => c.pages)).toHaveLength(17);

        for (const category of categories) {
          for (const [pageIndex, page] of category.pages.entries()) {
            const payload = buildDashboardPagePayload({
              locale,
              page: page as DashboardPage,
              buttonRows: [
                {
                  type: ComponentType.ActionRow,
                  components: categories.map((candidate) => ({
                    type: ComponentType.Button,
                    customId: `status-test:${candidate.id}`,
                    label: candidate.id,
                    style: candidate.id === category.id ? ButtonStyle.Primary : ButtonStyle.Secondary,
                  })),
                },
              ],
              controlRows:
                category.pages.length > 1
                  ? [
                      {
                        type: ComponentType.ActionRow,
                        components: [
                          {
                            type: ComponentType.StringSelect,
                            customId: `status-test:${category.id}:page`,
                            options: category.pages.map((candidate, index) => ({
                              label: candidate.titleKey,
                              value: String(index),
                              default: index === pageIndex,
                            })),
                          },
                        ],
                      },
                    ]
                  : [],
            });

            expect(countComponents(payload.components)).toBeLessThanOrEqual(COMPONENT_BUDGET);
            expect(validateComponentsV2MessageLimits(payload).valid).toBe(true);

            const serialized = JSON.stringify(payload);
            for (const field of page.fields) {
              if ("nameKey" in field && field.nameKey) {
                const expectedName = localizer(locale, field.nameKey, field.nameVars);
                expect(serialized).toContain(expectedName);
              }
            }
            if (page.footerKey) {
              const expectedFooter = localizer(locale, page.footerKey, page.footerVars);
              expect(serialized).toContain(expectedFooter);
            }
          }
        }
      }
    }
  });

  it("proves over-budget mutations fail validation", () => {
    const overBudgetPage: DashboardPage = {
      titleKey: "commands.status.personal_title",
      descriptionKey: "commands.status.personal_description",
      color: 0x65c6c5,
      fields: [
        {
          nameKey: "commands.status.field_user_nickname",
          value: "x".repeat(4500),
        },
      ],
    };

    expect(() =>
      buildDashboardPagePayload({
        locale: "en-US",
        page: overBudgetPage,
      }),
    ).toThrow(ComponentsV2LimitError);
  });

  it("proves field-loss mutations fail field-preservation assertions", () => {
    const page: DashboardPage = {
      titleKey: "commands.status.personal_title",
      descriptionKey: "commands.status.personal_description",
      color: 0x65c6c5,
      footerKey: "commands.status.export_footer_global_personal_memories",
      fields: [
        {
          nameKey: "commands.status.field_user_nickname",
          value: "Alice",
        },
        {
          nameKey: "commands.status.field_language_pref",
          value: "en-US",
        },
      ],
    };

    const mutatedPage: DashboardPage = {
      ...page,
      fields: [page.fields[0]], // dropped language_pref
    };

    const assertFieldsSurvive = (expectedPage: DashboardPage, renderedJson: string) => {
      for (const field of expectedPage.fields) {
        if ("nameKey" in field && field.nameKey) {
          expect(renderedJson).toContain(localizer("en-US", field.nameKey));
        }
      }
      if (expectedPage.footerKey) {
        expect(renderedJson).toContain(localizer("en-US", expectedPage.footerKey));
      }
    };

    const validPayload = buildDashboardPagePayload({ locale: "en-US", page });
    expect(() => assertFieldsSurvive(page, JSON.stringify(validPayload))).not.toThrow();

    const mutatedPayload = buildDashboardPagePayload({ locale: "en-US", page: mutatedPage });
    expect(() => assertFieldsSurvive(page, JSON.stringify(mutatedPayload))).toThrow();
  });
});
