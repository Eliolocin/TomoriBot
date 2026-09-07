import { readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "bun:test";
import { ComponentType, type StringSelectMenuComponentData } from "discord.js";
import type { TomoriState, UserRow, UserSavedProviderConfigRow } from "@/types/db/schema";
import { PrivacyLevel } from "@/types/db/schema";
import type { PanelReadStatus, PanelReceipt } from "@/types/discord/panel";
import {
  SPOTLIGHT_REMOVE_PAGE_SIZE,
  decodeProviderRangeValue,
  encodeProviderParam,
  type PersonalConfigCategory,
  type PersonalConfigManagedCapability,
  type PersonalConfigPage,
} from "@/utils/discord/personalConfigPanelCatalog";
import { validateComponentsV2MessageLimits } from "@/utils/discord/ui/componentsV2Limits";
import {
  buildPersonalConfigPanelPayload,
  type PersonalConfigModelDisplayInfo,
  type PersonalConfigPanelRenderInput,
  type PersonalConfigPanelView,
  type PersonalConfigRoutingRow,
  type PersonalConfigSpotlightDisplayInfo,
} from "@/utils/discord/ui/personalConfigPanel";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const localesDir = join(process.cwd(), "src", "locales");
const RUNTIME_LOCALES = readdirSync(localesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const REALISTIC_RECEIPT: PanelReceipt = {
  tone: "success",
  heading: "Personal Settings Saved",
  detail:
    "Your preferred response model has been routed to Claude 3.5 Sonnet on OpenRouter, with fallback slot 1 active and timezone offset set to UTC+9.",
  metadata: "trace: pcfg-op-789012 | user: 123456789012345678 | latency: 29ms",
};

function makeUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    user_id: 1,
    user_disc_id: "user-123",
    user_name: "testuser",
    user_nickname: "Test User",
    prefix_override: "!",
    suffix_override: "~",
    gender_identity: "non-binary",
    pronouns: "they/them",
    addressing_style: "casual",
    language_pref: "en-US",
    timezone_offset: 540,
    physical_appearance_tags: ["tall", "glasses"],
    privacy_level: PrivacyLevel.MINIMAL,
    shortterm_cache_crossserver_opt_in: false,
    impersonation_prompt: "A helpful and kind companion",
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as unknown as UserRow;
}

function makePersona(id: number, lineageId: number, name: string): TomoriState {
  return {
    persona_id: id,
    persona_lineage_id: lineageId,
    persona_nickname: name,
    is_alter: false,
    server_id: 1,
  } as unknown as TomoriState;
}

function makeModelDisplayInfo(fallbackCount = 2, providerCount = 1): PersonalConfigModelDisplayInfo {
  const routingRow: PersonalConfigRoutingRow = {
    capability: "text",
    activeModelName: "Claude 3.5 Sonnet",
    storedProvider: "openrouter",
    storedModelName: "Claude 3.5 Sonnet",
  };
  const routingRows = {
    text: { ...routingRow, capability: "text" as const },
    vision: { ...routingRow, capability: "vision" as const, activeModelName: "GPT-4o" },
    embedding: { ...routingRow, capability: "embedding" as const, activeModelName: "text-embedding-3" },
    image: { ...routingRow, capability: "image" as const, activeModelName: "Flux.1 Schnell" },
    image_nai: { ...routingRow, capability: "image_nai" as const, activeModelName: "NAI Diffusion V3" },
    video: { ...routingRow, capability: "video" as const, activeModelName: "VideoGen 1" },
  } as Record<PersonalConfigManagedCapability, PersonalConfigRoutingRow>;

  const fallbackSlots = Array.from({ length: fallbackCount }, (_, i) => ({
    slot: i + 1,
    modelName: `Fallback Model ${i + 1}`,
  }));

  const makeProviders = (prefix: string): string[] =>
    Array.from({ length: providerCount }, (_, i) => `${prefix}_${i + 1}`);

  return {
    routingRows,
    availableCapabilities: ["text", "vision", "embedding", "image", "image_nai", "video"],
    eligibleProvidersForCapability: {
      text: makeProviders("provider_text"),
      vision: makeProviders("provider_vision"),
      embedding: makeProviders("provider_embedding"),
      image: makeProviders("provider_image"),
      image_nai: makeProviders("provider_nai"),
      video: makeProviders("provider_video"),
    },
    parametersProviders: ["openrouter"],
    selectedParametersConfig: {
      user_saved_config_id: 1,
      user_id: 1,
      provider: "openrouter",
      key_version: 1,
      api_key: null,
      llm_id: 101,
      diffusion_model_id: 201,
      aux_model_id: null,
      assigned_capabilities: ["text"],
      fallback_model_refs: [],
    } as unknown as UserSavedProviderConfigRow,
    fallbacksProviders: ["openrouter"],
    selectedFallbacksConfig: null,
    primaryModelName: "Claude 3.5 Sonnet",
    fallbackSlots,
    randomizerEnabled: false,
    canEnableRandomizer: true,
  };
}

function makeSpotlightDisplayInfo(activeCount = 2, personaCount = 5): PersonalConfigSpotlightDisplayInfo {
  const personas = Array.from({ length: personaCount }, (_, i) => ({
    id: i + 1,
    name: `Persona ${i + 1}`,
    isAlter: false,
  }));
  const activeSpotlights = Array.from({ length: activeCount }, (_, i) => ({
    channelDiscId: `12345678901234567${i}`,
    personaIds: [personas[0]?.id ?? 1],
    autoTriggerPersonaId: personas[0]?.id ?? 1,
    expiresAt: new Date(Date.now() + 3600 * 1000 * (i + 1)),
  }));
  return { activeSpotlights, personas };
}

function collectSelects(value: unknown): StringSelectMenuComponentData[] {
  if (Array.isArray(value)) return value.flatMap(collectSelects);
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const list: StringSelectMenuComponentData[] = [];
  if (record.type === ComponentType.StringSelect) {
    list.push(record as unknown as StringSelectMenuComponentData);
  }
  if (Array.isArray(record.components)) {
    list.push(...collectSelects(record.components));
  }
  return list;
}

function collectTextContents(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectTextContents);
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const list: string[] = [];
  if (record.type === ComponentType.TextDisplay && typeof record.content === "string") {
    list.push(record.content);
  }
  if (Array.isArray(record.components)) {
    list.push(...collectTextContents(record.components));
  }
  return list;
}

describe("PersonalConfigPanel Limits & Boundary Sweeps", () => {
  it("conforms to Discord Components V2 protocol limits across all views and categories", () => {
    const categories: PersonalConfigCategory[] = ["profile", "privacy", "models", "advanced"];
    const pagesByCategory: Record<PersonalConfigCategory, PersonalConfigPage[]> = {
      profile: ["general", "persona", "appearance"],
      privacy: ["controls"],
      models: ["switch", "parameters", "fallbacks"],
      advanced: ["response-modes", "impersonation", "spotlight"],
    };

    const readStatuses: PanelReadStatus[] = ["fresh", "stale", "unavailable"];
    const receipts: (PanelReceipt | undefined)[] = [undefined, REALISTIC_RECEIPT];
    const personaSizes = [0, 1, 24, 25, 26, 75];

    for (const locale of RUNTIME_LOCALES) {
      for (const receipt of receipts) {
        for (const readStatus of readStatuses) {
          const user = makeUser();

          for (const category of categories) {
            for (const page of pagesByCategory[category]) {
              const input: PersonalConfigPanelRenderInput = {
                locale,
                category,
                page,
                user,
                resolvedNickname: "Tester",
                personas: [makePersona(1, 10, "Tomori")],
                guildId: "guild-123",
                memoryCount: 5,
                stmCount: 2,
                readStatus,
                receipt,
                modelDisplayInfo: makeModelDisplayInfo(3),
                spotlightDisplayInfo: makeSpotlightDisplayInfo(2, 5),
              };
              const payload = buildPersonalConfigPanelPayload(input);
              const result = validateComponentsV2MessageLimits(payload);
              if (!result.valid) {
                throw new Error(
                  `PersonalConfig main (${category}/${page}, locale: ${locale}, status: ${readStatus}) violations: ${JSON.stringify(result.violations)}`,
                );
              }
              expect(result.valid).toBe(true);
            }
          }

          for (const pSize of personaSizes) {
            const personas = Array.from({ length: pSize }, (_, i) => makePersona(i + 1, 100 + i, `Persona ${i + 1}`));
            const input: PersonalConfigPanelRenderInput = {
              locale,
              category: "profile",
              page: "persona",
              user,
              resolvedNickname: "Tester",
              personas,
              guildId: "guild-123",
              memoryCount: 5,
              stmCount: 2,
              readStatus,
              receipt,
            };
            const payload = buildPersonalConfigPanelPayload(input);
            const result = validateComponentsV2MessageLimits(payload);
            if (!result.valid) {
              throw new Error(
                `PersonalConfig persona size sweep (pSize: ${pSize}) violations: ${JSON.stringify(result.violations)}`,
              );
            }
            expect(result.valid).toBe(true);
          }

          const subviews: Exclude<PersonalConfigPanelView, { kind: "main" }>[] = [
            { kind: "impersonation-clear-confirm", nonce: "nonce-1" },
            {
              kind: "spotlight-set-review",
              channelId: "123456789012345678",
              hours: 2,
              blockIdx: 0,
              selectedPersonaIds: [1],
              autoTriggerPersonaId: 1,
              autoIdx: 0,
              mask: "1",
              fp: "fp1",
              nonce: "nonce-2",
            },
            {
              kind: "spotlight-persona-select",
              channelId: "123456789012345678",
              hours: 2,
              fp: "fp1",
              totalPersonas: 50,
              chooserPage: 0,
            },
            {
              kind: "spotlight-auto-range",
              channelId: "123456789012345678",
              hours: 2,
              blockIdx: 0,
              mask: "1",
              fp: "fp1",
              rangePage: 0,
              totalOptions: 50,
            },
            {
              kind: "spotlight-remove-range",
              rangePage: 0,
              totalOptions: 50,
              fp: "fp1",
            },
          ];

          for (const view of subviews) {
            const input: PersonalConfigPanelRenderInput = {
              locale,
              category: "advanced",
              page: "spotlight",
              user,
              resolvedNickname: "Tester",
              personas: [makePersona(1, 10, "Tomori")],
              guildId: "guild-123",
              memoryCount: 0,
              stmCount: 0,
              readStatus,
              receipt,
              view,
              spotlightDisplayInfo: makeSpotlightDisplayInfo(2, 10),
            };
            const payload = buildPersonalConfigPanelPayload(input);
            const result = validateComponentsV2MessageLimits(payload);
            if (!result.valid) {
              throw new Error(`PersonalConfig subview ${view.kind} violations: ${JSON.stringify(result.violations)}`);
            }
            expect(result.valid).toBe(true);
          }
        }
      }
    }
  });

  it("covers every record in the union of paginated pages without dropping overflow", () => {
    const totalRemoveOptions = SPOTLIGHT_REMOVE_PAGE_SIZE + 1; // 51 options -> 2 blocks
    const page0Input: PersonalConfigPanelRenderInput = {
      locale: "en-US",
      category: "advanced",
      page: "spotlight",
      user: makeUser(),
      resolvedNickname: "Tester",
      personas: [],
      guildId: "guild-123",
      memoryCount: 0,
      stmCount: 0,
      readStatus: "fresh",
      view: {
        kind: "spotlight-remove-range",
        rangePage: 0,
        totalOptions: totalRemoveOptions,
        fp: "fp-test",
      },
    };
    const page0Payload = buildPersonalConfigPanelPayload(page0Input);

    const selects = collectSelects(page0Payload.components);

    const removeSelect = selects.find((s) => s.customId?.includes(":s-rem-s:"));
    expect(removeSelect).toBeDefined();
    // SPOTLIGHT_REMOVE_PAGE_SIZE + 1 options yields 2 blocks: 1..pageSize and (pageSize + 1)..total
    expect(removeSelect?.options.length).toBe(2);
    expect(removeSelect?.options[0]?.value).toBe("0");
    expect(removeSelect?.options[1]?.value).toBe(String(SPOTLIGHT_REMOVE_PAGE_SIZE));

    const overflowPersonaCount = 26; // > PERSONA_SELECT_MAX_OPTIONS (25)
    const personas = Array.from({ length: overflowPersonaCount }, (_, i) =>
      makePersona(i + 1, 1000 + i, `Persona ${i + 1}`),
    );
    const personaInput: PersonalConfigPanelRenderInput = {
      locale: "en-US",
      category: "profile",
      page: "persona",
      user: makeUser(),
      resolvedNickname: "Tester",
      personas,
      guildId: "guild-123",
      memoryCount: 0,
      stmCount: 0,
      readStatus: "fresh",
    };
    const personaPayload = buildPersonalConfigPanelPayload(personaInput);
    const personaSelects = collectSelects(personaPayload.components);

    const personaSelect = personaSelects.find((s) => s.customId?.includes("persona-select"));
    expect(personaSelect).toBeDefined();
    expect(personaSelect?.options.length).toBe(25);

    // Verify hidden count text display exists
    const texts = collectTextContents(personaPayload.components);
    const hasHiddenNotice = texts.some((content) => content.includes("1"));
    expect(hasHiddenNotice).toBe(true);
  });

  it("conforms to Discord Components V2 protocol limits across provider count sweeps on Switch Models", () => {
    const providerCounts = [1, 24, 25, 26, 60];
    const receipts: (PanelReceipt | undefined)[] = [undefined, REALISTIC_RECEIPT];
    const readStatuses: PanelReadStatus[] = ["fresh", "stale", "unavailable"];

    for (const providerCount of providerCounts) {
      for (const receipt of receipts) {
        for (const readStatus of readStatuses) {
          const input: PersonalConfigPanelRenderInput = {
            locale: "en-US",
            category: "models",
            page: "switch",
            user: makeUser(),
            resolvedNickname: "Tester",
            personas: [makePersona(1, 10, "Tomori")],
            guildId: "guild-123",
            memoryCount: 5,
            stmCount: 2,
            readStatus,
            receipt,
            modelDisplayInfo: makeModelDisplayInfo(2, providerCount),
          };
          const payload = buildPersonalConfigPanelPayload(input);
          const result = validateComponentsV2MessageLimits(payload);
          if (!result.valid) {
            throw new Error(
              `PersonalConfig models/switch (providerCount: ${providerCount}, status: ${readStatus}, receipt: ${Boolean(receipt)}) violations: ${JSON.stringify(result.violations)}`,
            );
          }
          expect(result.valid).toBe(true);
        }
      }
    }
  });

  it("renders the workspace speech endpoint direction on Personal Models", () => {
    const input: PersonalConfigPanelRenderInput = {
      locale: "en-US",
      category: "models",
      page: "switch",
      user: makeUser(),
      resolvedNickname: "Tester",
      personas: [makePersona(1, 10, "Tomori")],
      guildId: "guild-123",
      memoryCount: 5,
      stmCount: 2,
      readStatus: "fresh",
      modelDisplayInfo: makeModelDisplayInfo(2, 1),
    };

    const payload = buildPersonalConfigPanelPayload(input);
    const texts = collectTextContents(payload.components);

    expect(texts).toContain("-# Server-wide TTS/STT: `/config` > Models > Switch Models.");
  });

  it("walks provider navigation options across windows reaching all 60 providers without looping infinitely", () => {
    const totalProviders = 60;
    const modelDisplayInfo = makeModelDisplayInfo(2, totalProviders);
    const expectedProviders = new Set(
      modelDisplayInfo.eligibleProvidersForCapability.text.map((p) => encodeProviderParam(p)),
    );

    const visitedStarts = new Set<number>();
    const seenProviderValues = new Set<string>();
    let providerStart = 0;
    const maxHops = 20;
    let hops = 0;

    while (hops < maxHops) {
      hops += 1;
      if (visitedStarts.has(providerStart)) {
        break;
      }
      visitedStarts.add(providerStart);

      const input: PersonalConfigPanelRenderInput = {
        locale: "en-US",
        category: "models",
        page: "switch",
        user: makeUser(),
        resolvedNickname: "Tester",
        personas: [makePersona(1, 10, "Tomori")],
        guildId: "guild-123",
        memoryCount: 0,
        stmCount: 0,
        readStatus: "fresh",
        selectedCapability: "text",
        providerStart,
        modelDisplayInfo,
      };

      const payload = buildPersonalConfigPanelPayload(input);
      const validation = validateComponentsV2MessageLimits(payload);
      expect(validation.valid).toBe(true);

      const selects = collectSelects(payload.components);
      const textSelect = selects.find((s) => s.customId?.endsWith(":model-provider-select:en-US:text"));
      expect(textSelect).toBeDefined();
      if (!textSelect) throw new Error("Expected textSelect to be defined");

      for (const option of textSelect.options) {
        if (option.value === "__server_default__") continue;
        const range = decodeProviderRangeValue(option.value);
        if (range === null) {
          seenProviderValues.add(option.value);
        }
      }

      const moreOption = textSelect.options.find((o) => decodeProviderRangeValue(o.value) !== null);
      expect(moreOption).toBeDefined();
      if (!moreOption) throw new Error("Expected moreOption to be defined");
      const decoded = decodeProviderRangeValue(moreOption.value);
      expect(decoded).not.toBeNull();
      if (!decoded) throw new Error("Expected decoded to not be null");
      providerStart = decoded.start;
    }

    expect(hops).toBeLessThan(maxHops);
    expect(visitedStarts.size).toBe(3);
    expect(providerStart).toBe(0);
    expect(seenProviderValues).toEqual(expectedProviders);
  });
});
