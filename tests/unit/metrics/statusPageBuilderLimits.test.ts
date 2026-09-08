import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { Client } from "discord.js";
import type { TomoriState, UserRow } from "@/types/db/schema";
import { ComponentsV2LimitError, validateComponentsV2MessageLimits } from "@/utils/discord/ui/componentsV2Limits";
import {
  buildDashboardPagePayload,
  dashboardPayload,
  type DashboardPage,
  type StatusPageCategory,
} from "@/utils/metrics/status/statusPageRenderer";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";
import * as realDbClient from "@/utils/db/client";
import * as realRepositories from "@/utils/db/repositories";
import { createScopedModuleMocker, overrideMembers, stubLogMembers } from "../../helpers/mockSurface";

const emptyRows = async () => [];
const quotaConfig = {
  enabled: false,
  daily_user_quota: null,
  serverwide_quota: null,
  serverwide_quota_resets_in: 0,
};

const scopedMock = createScopedModuleMocker(mock, {
  "@/utils/db/client": realDbClient,
  "@/utils/db/repositories": realRepositories,
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
    loadAllForServer: async () => [],
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
const interaction = { user: { id: "status-user" } };
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

        const categories: StatusPageCategory[] = [
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
            const personaRoster = Array.from({ length: 51 }, (_, index) => ({
              persona_id: index + 1,
              persona_nickname: index === 0 ? "Sparrow" : `Persona ${index + 1}`,
            })) as TomoriState[];
            const payload =
              category.id === "persona"
                ? dashboardPayload("status-test", locale, categories, category.id, pageIndex, false, {
                    selectedPersonaId: 1,
                    personas: personaRoster,
                    personaSelectStart: 25,
                  })
                : dashboardPayload("status-test", locale, categories, category.id, pageIndex, false);

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
