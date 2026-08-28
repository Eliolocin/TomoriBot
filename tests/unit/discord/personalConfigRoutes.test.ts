import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import type { ButtonInteraction, Client, InteractionReplyOptions, ModalSubmitInteraction } from "discord.js";
import { PrivacyLevel, type UserRow, type TomoriState } from "@/types/db/schema";
import {
  createPersonalConfigInteractionRoute,
  personalConfigOperations,
  type PersonalConfigOperations,
  type PersonalConfigRouteDependencies,
} from "@/utils/discord/interactions/personalConfigRoutes";
import { llmModelRepo, llmProviderRepo, userNamingRepository, userRepository } from "@/utils/db/repositories";
import {
  buildPersonalConfigCustomId,
  decodeProviderParam,
  encodeProviderParam,
  parsePersonalConfigPanelRoute,
} from "@/utils/discord/personalConfigPanelCatalog";
import {
  buildPersonalConfigPanelPayload,
  buildSpotlightRemoveModal,
  buildSpotlightSetModal,
  type PersonalConfigRoutingRow,
} from "@/utils/discord/ui/personalConfigPanel";
import type { ThinkingLevelValue } from "@/constants/thinkingLevels";
import type { PersonalConfigManagedCapability } from "@/utils/discord/personalConfigPanelCatalog";
import { parseInteractionRoute, type ParsedInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import { dispatchGlobalInteraction } from "@/utils/discord/interactions/router";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";
import { loadCommandData } from "@/utils/discord/commandLoader";
import type { UserPersonaNamingPreference } from "@/types/personaNaming";

beforeAll(async () => initializeLocalizer());

function makeChannelCache(channelIds: string[]): Map<string, { type: number; name: string }> {
  // ChannelType.GuildText is 0; the route guard rejects anything else.
  return new Map(channelIds.map((id) => [id, { type: 0, name: `channel-${id.slice(-4)}` }]));
}

function requireRoute(customId: string): ParsedInteractionRoute {
  const parsed = parseInteractionRoute(customId);
  if (!parsed) throw new Error(`Failed to parse route for customId: ${customId}`);
  return parsed;
}

function makeUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    user_id: 1,
    user_disc_id: "user-123",
    user_name: "testuser",
    user_nickname: null,
    prefix_override: null,
    suffix_override: null,
    gender_identity: null,
    pronouns: null,
    addressing_style: null,
    language_pref: "en-US",
    timezone_offset: null,
    physical_appearance_tags: [],
    privacy_level: PrivacyLevel.MINIMAL,
    shortterm_cache_crossserver_opt_in: false,
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
    is_active: true,
  } as unknown as TomoriState;
}

function makeDependencies(
  calls: string[],
  overrides: Partial<PersonalConfigRouteDependencies> = {},
): {
  dependencies: PersonalConfigRouteDependencies;
  user: UserRow;
  personaPrefs: Map<string, UserPersonaNamingPreference>;
  telemetry: string[];
} {
  const user = makeUser();
  const personaPrefs = new Map<string, UserPersonaNamingPreference>();
  const telemetry: string[] = [];

  const operations: PersonalConfigOperations = {
    setLanguage: async (input) => {
      calls.push(`setLanguage:${input.language}`);
      user.language_pref = input.language;
      return { status: "success" };
    },
    setTimezone: async (input) => {
      calls.push(`setTimezone:${input.offset}`);
      user.timezone_offset = input.offset;
      return { status: "success" };
    },
    setNaming: async (input) => {
      calls.push(`setNaming:${input.nickname}:${input.prefix}:${input.suffix}`);
      user.user_nickname = input.nickname;
      user.prefix_override = input.prefix;
      user.suffix_override = input.suffix;
      return { status: "success" };
    },
    setPersonaNaming: async (input) => {
      calls.push(`setPersonaNaming:${input.personaLineageId}:${input.nickname}:${input.prefix}:${input.suffix}`);
      personaPrefs.set(`${input.userId}:${input.personaLineageId}`, {
        user_id: input.userId,
        persona_lineage_id: input.personaLineageId,
        nickname_override: input.nickname,
        prefix_override: input.prefix,
        suffix_override: input.suffix,
        created_at: new Date(),
        updated_at: new Date(),
      });
      return { status: "success" };
    },
    setAbout: async (input) => {
      calls.push(`setAbout:${input.genderIdentity}:${input.pronouns}:${input.addressingStyle}`);
      user.gender_identity = input.genderIdentity;
      user.pronouns = input.pronouns;
      user.addressing_style = input.addressingStyle;
      return { status: "success" };
    },
    setAppearance: async (input) => {
      calls.push(`setAppearance:${input.rawTags}`);
      const tags = input.rawTags.trim() ? input.rawTags.split(",").map((t) => t.trim()) : [];
      user.physical_appearance_tags = tags;
      return { status: "success", tags };
    },
    setPrivacyLevel: async (input) => {
      calls.push(`setPrivacyLevel:${input.level}`);
      user.privacy_level = input.level;
      return { status: "success" };
    },
    toggleCrossServerStm: async (_input) => {
      calls.push("toggleCrossServerStm");
      user.shortterm_cache_crossserver_opt_in = !user.shortterm_cache_crossserver_opt_in;
      return { status: "success", enabled: user.shortterm_cache_crossserver_opt_in };
    },
    setCapabilityModel: async (input) => {
      calls.push(`setCapabilityModel:${input.capability}:${input.provider}:${input.modelId}`);
      return { status: "success" };
    },
    setCapabilityEnabled: async (input) => {
      calls.push(`setCapabilityEnabled:${input.capability}:${input.enabled}`);
      return { status: "success" };
    },
    setQuickToggleRouting: async (input) => {
      calls.push(`setQuickToggleRouting:${Array.from(input.selectedCapabilities).sort().join(",")}`);
      return { status: "success" };
    },
    setParameters: async (input) => {
      calls.push(`setParameters:${input.provider}:${JSON.stringify(input.patch)}`);
      return { status: "success" };
    },
    setFallbacks: async (input) => {
      calls.push(`setFallbacks:${input.provider}:${input.slotValues.join(",")}`);
      return { status: "success", fallbacks: [] };
    },
    setRandomizer: async (input) => {
      calls.push(`setRandomizer:${input.provider}:${input.enabled}`);
      return { status: "success", enabled: input.enabled };
    },
    setTriggerMode: async (input) => {
      calls.push(`setTriggerMode:${input.mode}`);
      user.personal_dtm = input.mode;
      return { status: "success" };
    },
    setToolMode: async (input) => {
      calls.push(`setToolMode:${input.mode}`);
      user.personal_deliberate_tool_mode = input.mode;
      return { status: "success" };
    },
    setImpersonationPrompt: async (input) => {
      calls.push(`setImpersonationPrompt:${input.prompt}`);
      user.impersonation_prompt = input.prompt;
      return { status: "success" };
    },
    setSpotlight: async (input) => {
      calls.push(`setSpotlight:${input.channelId}:${input.personaIds.join(",")}:${input.autoTriggerPersonaId}`);
      return { status: "success" };
    },
    removeSpotlights: async (input) => {
      calls.push(`removeSpotlights:${input.channelIds.join(",")}`);
      return { status: "success", removedCount: input.channelIds.length };
    },
  };

  const dependencies: PersonalConfigRouteDependencies = {
    resolveScope: async () => ({
      userId: user.user_id,
      userDiscId: user.user_disc_id,
      guildId: "guild-123",
      workspaceId: "guild-123",
      internalServerId: 42,
      user,
      resolvedNickname: user.user_nickname ?? "LiveUser",
      personas: [makePersona(1, 10, "Tomori"), makePersona(2, 20, "Anon")],
      readStatus: "fresh",
    }),
    loadPersonaNamingPreference: async (userId, lineageId) => personaPrefs.get(`${userId}:${lineageId}`) ?? null,
    getMemoryCount: async () => 3,
    getStmCount: async () => 2,
    loadUserSavedProviders: async () => [
      {
        user_saved_config_id: 1,
        user_id: 1,
        provider: "openrouter",
        key_version: 1,
        api_key: null,
        llm_id: 101,
        diffusion_model_id: 201,
        embedding_model_id: 301,
        nai_diffusion_model_id: 202,
        video_model_id: 401,
        vision_llm_id: 102,
        nai_preset_name: null,
        llm_temperature: 0.7,
        llm_top_p: 0.95,
        llm_top_k: 0,
        llm_frequency_penalty: 0,
        llm_presence_penalty: 0,
        llm_min_p: 0.05,
        llm_max_output_tokens: 4096,
        llm_disabled_params: [],
        llm_logit_biases: [],
        thinking_level: "auto",
        model_randomizer_enabled: false,
        enabled_capabilities: ["text", "vision", "embedding", "image", "video"],
        assigned_capabilities: ["text", "vision", "embedding", "image", "video"],
        fallback_model_refs: [{ type: "llm", id: 103 }],
      } as unknown as UserSavedProviderConfigRow,
    ],
    loadPersonalModelDisplayInfo: async () => ({
      routingRows: {
        text: {
          capability: "text",
          activeModelName: "OpenRouter · Claude 3.5 Sonnet",
          storedProvider: "openrouter",
          storedModelName: "OpenRouter · Claude 3.5 Sonnet",
        },
        vision: {
          capability: "vision",
          activeModelName: "OpenRouter · GPT-4o",
          storedProvider: "openrouter",
          storedModelName: "OpenRouter · GPT-4o",
        },
        embedding: {
          capability: "embedding",
          activeModelName: "OpenRouter · text-embedding-3",
          storedProvider: "openrouter",
          storedModelName: "OpenRouter · text-embedding-3",
        },
        image: {
          capability: "image",
          activeModelName: "OpenRouter · Flux.1 Schnell",
          storedProvider: "openrouter",
          storedModelName: "OpenRouter · Flux.1 Schnell",
        },
        image_nai: {
          capability: "image_nai",
          activeModelName: "NovelAI · NAI Diffusion V3",
          storedProvider: "novelai",
          storedModelName: "NovelAI · NAI Diffusion V3",
        },
        video: {
          capability: "video",
          activeModelName: "OpenRouter · VideoGen 1",
          storedProvider: "openrouter",
          storedModelName: "OpenRouter · VideoGen 1",
        },
      },
      availableCapabilities: ["text", "vision", "embedding", "image", "image_nai", "video"],
      eligibleProvidersForCapability: {
        text: ["openrouter"],
        vision: ["openrouter"],
        embedding: ["openrouter"],
        image: ["openrouter"],
        image_nai: ["novelai"],
        video: ["openrouter"],
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
        embedding_model_id: 301,
        nai_diffusion_model_id: null,
        video_model_id: null,
        vision_llm_id: null,
        nai_preset_name: null,
        llm_temperature: 0.7,
        llm_top_p: 0.95,
        llm_top_k: 0,
        llm_frequency_penalty: 0,
        llm_presence_penalty: 0,
        llm_min_p: 0.05,
        llm_max_output_tokens: 4096,
        llm_disabled_params: [],
        llm_logit_biases: [],
        thinking_level: "auto",
        model_randomizer_enabled: false,
        enabled_capabilities: ["text"],
        assigned_capabilities: ["text"],
        fallback_model_refs: [{ type: "llm", id: 103 }],
      } as unknown as UserSavedProviderConfigRow,
      fallbacksProviders: ["openrouter"],
      selectedFallbacksConfig: {
        user_saved_config_id: 1,
        user_id: 1,
        provider: "openrouter",
        key_version: 1,
        api_key: null,
        llm_id: 101,
        diffusion_model_id: 201,
        embedding_model_id: 301,
        nai_diffusion_model_id: null,
        video_model_id: null,
        vision_llm_id: null,
        nai_preset_name: null,
        llm_temperature: 0.7,
        llm_top_p: 0.95,
        llm_top_k: 0,
        llm_frequency_penalty: 0,
        llm_presence_penalty: 0,
        llm_min_p: 0.05,
        llm_max_output_tokens: 4096,
        llm_disabled_params: [],
        llm_logit_biases: [],
        thinking_level: "auto",
        model_randomizer_enabled: false,
        enabled_capabilities: ["text"],
        assigned_capabilities: ["text"],
        fallback_model_refs: [{ type: "llm", id: 103 }],
      } as unknown as UserSavedProviderConfigRow,
      primaryModelName: "Claude 3.5 Sonnet",
      fallbackSlots: [
        { slot: 1, modelName: "Claude 3 Haiku" },
        { slot: 2, modelName: null },
        { slot: 3, modelName: null },
        { slot: 4, modelName: null },
        { slot: 5, modelName: null },
      ],
      randomizerEnabled: false,
      canEnableRandomizer: true,
    }),
    loadAvailableModelsForCapability: async () => [
      { id: 101, name: "Claude 3.5 Sonnet" },
      { id: 102, name: "Claude 3 Opus" },
    ],
    loadActiveSpotlights: async () => [
      {
        channelDiscId: "ch-100",
        personaIds: [1],
        autoTriggerPersonaId: null,
        expiresAt: null,
        userDiscId: "disc-user-1",
      },
    ],
    loadGuildPersonas: async () => [
      { id: 1, name: "Tomori", isAlter: false },
      { id: 2, name: "Anon", isAlter: true },
    ],
    loadTomoriState: async () => null,
    loadServerTriggerBehavior: async () => null,
    operations,
    recordAction: (input) => {
      telemetry.push(input.action);
    },
    createNonce: () => "nonce123456",
    showLanguageModal: async () => {},
    showTimezoneModal: async () => {},
    showNamingModal: async () => {},
    showPersonaNamingModal: async () => {},
    showAboutModal: async () => {},
    showAppearanceModal: async () => {},
    showPrivacyLevelModal: async () => {},
    showQuickToggleModal: async () => {},
    showModelSelectModal: async () => {},
    showParameters1Modal: async () => {},
    showParameters2Modal: async () => {},
    showFallbacksModal: async () => {},
    showImpersonationModal: async () => {},
    showSpotlightSetModal: async () => {},
    showSpotlightAutoTriggerModal: async () => {},
    showSpotlightRemoveModal: async () => {},
    ...overrides,
  };

  return { dependencies, user, personaPrefs, telemetry };
}

describe("personalConfigPanelCatalog", () => {
  it("builds and parses category and page routes", () => {
    const categoryId = buildPersonalConfigCustomId("category", "en-US", "privacy", "controls");
    const parsedCategory = parsePersonalConfigPanelRoute(requireRoute(categoryId));
    expect(parsedCategory).toEqual({
      action: "category",
      locale: "en-US",
      category: "privacy",
      page: "controls",
    });

    const pageId = buildPersonalConfigCustomId("page", "en-US", "profile", "appearance");
    const parsedPage = parsePersonalConfigPanelRoute(requireRoute(pageId));
    expect(parsedPage).toEqual({
      action: "page",
      locale: "en-US",
      category: "profile",
      page: "appearance",
    });
  });

  it("builds and parses modal open and submit routes", () => {
    const langOpen = buildPersonalConfigCustomId("language-open", "en-US");
    expect(parsePersonalConfigPanelRoute(requireRoute(langOpen))).toEqual({
      action: "language-open",
      locale: "en-US",
    });

    const langSubmit = buildPersonalConfigCustomId("language-submit", "en-US", "nonce123456");
    expect(parsePersonalConfigPanelRoute(requireRoute(langSubmit))).toEqual({
      action: "language-submit",
      locale: "en-US",
      nonce: "nonce123456",
    });

    const personaNamingSubmit = buildPersonalConfigCustomId("persona-naming-submit", "en-US", 10, "nonce123456");
    expect(parsePersonalConfigPanelRoute(requireRoute(personaNamingSubmit))).toEqual({
      action: "persona-naming-submit",
      locale: "en-US",
      lineageId: 10,
      nonce: "nonce123456",
    });

    const toggle = buildPersonalConfigCustomId("crossserver-toggle", "en-US");
    expect(parsePersonalConfigPanelRoute(requireRoute(toggle))).toEqual({
      action: "crossserver-toggle",
      locale: "en-US",
    });

    const triggerMode = buildPersonalConfigCustomId("trigger-mode-set", "en-US", "on");
    expect(parsePersonalConfigPanelRoute(requireRoute(triggerMode))).toEqual({
      action: "trigger-mode-set",
      locale: "en-US",
      mode: "on",
    });

    const toolMode = buildPersonalConfigCustomId("tool-mode-set", "en-US", "off");
    expect(parsePersonalConfigPanelRoute(requireRoute(toolMode))).toEqual({
      action: "tool-mode-set",
      locale: "en-US",
      mode: "off",
    });

    const impOpen = buildPersonalConfigCustomId("impersonation-open", "en-US");
    expect(parsePersonalConfigPanelRoute(requireRoute(impOpen))).toEqual({
      action: "impersonation-open",
      locale: "en-US",
    });

    const impSubmit = buildPersonalConfigCustomId("impersonation-submit", "en-US", "nonce123456");
    expect(parsePersonalConfigPanelRoute(requireRoute(impSubmit))).toEqual({
      action: "impersonation-submit",
      locale: "en-US",
      nonce: "nonce123456",
    });

    const impClearView = buildPersonalConfigCustomId("impersonation-clear-view", "en-US");
    expect(parsePersonalConfigPanelRoute(requireRoute(impClearView))).toEqual({
      action: "impersonation-clear-view",
      locale: "en-US",
    });

    const impClearConfirm = buildPersonalConfigCustomId("impersonation-clear-confirm", "en-US", "nonce123456");
    expect(parsePersonalConfigPanelRoute(requireRoute(impClearConfirm))).toEqual({
      action: "impersonation-clear-confirm",
      locale: "en-US",
      nonce: "nonce123456",
    });

    const spotSetOpen = buildPersonalConfigCustomId("spotlight-set-open", "en-US");
    expect(parsePersonalConfigPanelRoute(requireRoute(spotSetOpen))).toEqual({
      action: "spotlight-set-open",
      locale: "en-US",
    });

    const spotSetSubmit = buildPersonalConfigCustomId("spotlight-set-submit", "en-US", "nonce123456");
    expect(parsePersonalConfigPanelRoute(requireRoute(spotSetSubmit))).toEqual({
      action: "spotlight-set-submit",
      locale: "en-US",
      nonce: "nonce123456",
    });

    const spotSetAuto = buildPersonalConfigCustomId(
      "spot-set-auto",
      "en-US",
      "123456789012345678",
      24,
      "3",
      "nonce123456",
    );
    expect(parsePersonalConfigPanelRoute(requireRoute(spotSetAuto))).toEqual({
      action: "spot-set-auto",
      locale: "en-US",
      channelId: "123456789012345678",
      hours: 24,
      mask: "3",
      nonce: "nonce123456",
    });

    const spotSetAutoSub = buildPersonalConfigCustomId(
      "spot-set-auto-sub",
      "en-US",
      "123456789012345678",
      24,
      "3",
      "nonce123456",
    );
    expect(parsePersonalConfigPanelRoute(requireRoute(spotSetAutoSub))).toEqual({
      action: "spot-set-auto-sub",
      locale: "en-US",
      channelId: "123456789012345678",
      hours: 24,
      mask: "3",
      nonce: "nonce123456",
    });

    const spotSetCf = buildPersonalConfigCustomId(
      "spot-set-cf",
      "en-US",
      "123456789012345678",
      24,
      101,
      "3",
      "nonce123456",
    );
    expect(parsePersonalConfigPanelRoute(requireRoute(spotSetCf))).toEqual({
      action: "spot-set-cf",
      locale: "en-US",
      channelId: "123456789012345678",
      hours: 24,
      autoTriggerId: 101,
      mask: "3",
      nonce: "nonce123456",
    });

    const spotRemOpen = buildPersonalConfigCustomId("spotlight-remove-open", "en-US");
    expect(parsePersonalConfigPanelRoute(requireRoute(spotRemOpen))).toEqual({
      action: "spotlight-remove-open",
      locale: "en-US",
    });

    const spotRemRange = buildPersonalConfigCustomId("spot-rem-range", "en-US", 50);
    expect(parsePersonalConfigPanelRoute(requireRoute(spotRemRange))).toEqual({
      action: "spot-rem-range",
      locale: "en-US",
      start: 50,
    });

    const spotRemSubmit = buildPersonalConfigCustomId("spotlight-remove-submit", "en-US", 50, "nonce123456");
    expect(parsePersonalConfigPanelRoute(requireRoute(spotRemSubmit))).toEqual({
      action: "spotlight-remove-submit",
      locale: "en-US",
      start: 50,
      nonce: "nonce123456",
    });
  });

  it("rejects malformed routes", () => {
    expect(parsePersonalConfigPanelRoute(requireRoute("other:v1:category:en-US:profile:general"))).toBeNull();
    expect(parsePersonalConfigPanelRoute(requireRoute("personal-config:v2:category:en-US:profile:general"))).toBeNull();
    expect(
      parsePersonalConfigPanelRoute(requireRoute("personal-config:v1:category:invalid-locale:profile:general")),
    ).toBeNull();
    expect(parsePersonalConfigPanelRoute(requireRoute("personal-config:v1:category:en-US:unknown:general"))).toBeNull();
  });
});

describe("/personal config command registration", () => {
  it("registers /personal config as a leaf command without config.* subcommands", async () => {
    const { registrationData, executionMap } = await loadCommandData();
    const personalCommand = registrationData.find((cmd) => cmd.name === "personal");
    expect(personalCommand).toBeDefined();

    const options = (personalCommand as { options?: Array<{ name: string; type: number }> }).options ?? [];
    const configOption = options.find((opt) => opt.name === "config");
    expect(configOption).toBeDefined();
    // type 1 is Subcommand (leaf)
    expect(configOption?.type).toBe(1);

    const personalExecutions = executionMap.get("personal");
    expect(personalExecutions?.has("config")).toBe(true);
    expect(personalExecutions?.has("config.export")).toBe(false);
    expect(personalExecutions?.has("config.import")).toBe(false);
    expect(personalExecutions?.has("config.remove")).toBe(false);
  }, 30000);
});

describe("personalConfigOperations invariants", () => {
  it("setNaming applies userNamingRepository.applyUserInfoBatch and invalidates cache", async () => {
    const batchSpy = spyOn(userNamingRepository, "applyUserInfoBatch").mockImplementation(async () => {});
    const result = await personalConfigOperations.setNaming({
      userId: 1,
      userDiscId: "user-123",
      nickname: "NewNick",
      prefix: "Sir",
      suffix: "-sama",
    });

    expect(result).toEqual({ status: "success" });
    expect(batchSpy).toHaveBeenCalledWith(1, {
      global: {
        user_nickname: "NewNick",
        prefix_override: "Sir",
        suffix_override: "-sama",
      },
    });
    batchSpy.mockRestore();
  });

  it("setPersonaNaming applies userNamingRepository.applyUserInfoBatch for persona lineage", async () => {
    const batchSpy = spyOn(userNamingRepository, "applyUserInfoBatch").mockImplementation(async () => {});
    const result = await personalConfigOperations.setPersonaNaming({
      userId: 1,
      userDiscId: "user-123",
      personaLineageId: 10,
      nickname: "PersonaNick",
      prefix: null,
      suffix: null,
    });

    expect(result).toEqual({ status: "success" });
    expect(batchSpy).toHaveBeenCalledWith(1, {
      global: {},
      persona: {
        personaLineageId: 10,
        patch: {
          nickname_override: "PersonaNick",
          prefix_override: null,
          suffix_override: null,
        },
      },
    });
    batchSpy.mockRestore();
  });

  it("setAbout applies userNamingRepository.applyUserInfoBatch for about fields", async () => {
    const batchSpy = spyOn(userNamingRepository, "applyUserInfoBatch").mockImplementation(async () => {});
    const result = await personalConfigOperations.setAbout({
      userId: 1,
      userDiscId: "user-123",
      genderIdentity: "Non-binary",
      pronouns: "they/them",
      addressingStyle: "neutral",
    });

    expect(result).toEqual({ status: "success" });
    expect(batchSpy).toHaveBeenCalledWith(1, {
      global: {
        gender_identity: "Non-binary",
        pronouns: "they/them",
        addressing_style: "neutral",
      },
    });
    batchSpy.mockRestore();
  });

  it("setAppearance validates and updates physical appearance tags", async () => {
    const updateSpy = spyOn(userRepository, "update").mockImplementation(async () => true);

    // Empty tags clears
    const clearResult = await personalConfigOperations.setAppearance({
      userId: 1,
      userDiscId: "user-123",
      rawTags: "   ",
    });
    expect(clearResult).toEqual({ status: "success", tags: [] });
    expect(updateSpy).toHaveBeenCalledWith(1, { physical_appearance_tags: [] });

    // Valid tags updates
    const validResult = await personalConfigOperations.setAppearance({
      userId: 1,
      userDiscId: "user-123",
      rawTags: "white hair, red eyes",
    });
    expect(validResult).toEqual({ status: "success", tags: ["white hair", "red eyes"] });
    expect(updateSpy).toHaveBeenCalledWith(1, { physical_appearance_tags: ["white hair", "red eyes"] });

    updateSpy.mockRestore();
  });

  it("setPrivacyLevel and toggleCrossServerStm call repository methods", async () => {
    const privacySpy = spyOn(userRepository, "setPrivacyLevel").mockImplementation(async () => true);
    const toggleSpy = spyOn(userRepository, "toggleCrossServerShmOptIn").mockImplementation(async () => true);

    const privacyResult = await personalConfigOperations.setPrivacyLevel({
      userId: 1,
      userDiscId: "user-123",
      level: PrivacyLevel.FULL,
    });
    expect(privacyResult).toEqual({ status: "success" });
    expect(privacySpy).toHaveBeenCalledWith("user-123", PrivacyLevel.FULL);

    const toggleResult = await personalConfigOperations.toggleCrossServerStm({
      userDiscId: "user-123",
    });
    expect(toggleResult).toEqual({ status: "success", enabled: true });
    expect(toggleSpy).toHaveBeenCalledWith("user-123");

    privacySpy.mockRestore();
    toggleSpy.mockRestore();
  });
});

describe("personalConfigRoutes interaction handling and telemetry", () => {
  it("acknowledges interaction before writing and emits telemetry on success", async () => {
    const calls: string[] = [];
    let acknowledgedDuringWrite = false;

    const { dependencies, telemetry } = makeDependencies(calls, {
      operations: {
        ...personalConfigOperations,
        setNaming: async (input) => {
          acknowledgedDuringWrite = interaction.deferred || interaction.replied;
          calls.push(`setNaming:${input.nickname}`);
          return { status: "success" };
        },
      },
    });

    const route = createPersonalConfigInteractionRoute(dependencies);
    const customId = buildPersonalConfigCustomId("naming-submit", "en-US", "nonce123456");

    let deferred = false;
    const replied = false;
    const interaction = {
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      customId,
      user: { id: "user-123", username: "tester", displayName: "Tester" },
      guildId: "guild-123",
      get deferred() {
        return deferred;
      },
      get replied() {
        return replied;
      },
      deferUpdate: async () => {
        deferred = true;
      },
      editReply: async () => {},
      fields: {
        getTextInputValue: (fieldId: string) => {
          if (fieldId.startsWith("nickname_")) return "SuperUser";
          return "";
        },
      },
    } as unknown as ModalSubmitInteraction;

    await route.execute({} as Client, interaction, requireRoute(customId));

    expect(calls).toContain("setNaming:SuperUser");
    expect(acknowledgedDuringWrite).toBe(true);
    expect(telemetry).toContain("personal-config.personal.naming.set");
  });

  it("emits crossserver-stm telemetry on toggle", async () => {
    const calls: string[] = [];
    const { dependencies, telemetry } = makeDependencies(calls);
    const route = createPersonalConfigInteractionRoute(dependencies);
    const customId = buildPersonalConfigCustomId("crossserver-toggle", "en-US");

    let deferred = false;
    const interaction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      customId,
      user: { id: "user-123", username: "tester", displayName: "Tester" },
      guildId: "guild-123",
      get deferred() {
        return deferred;
      },
      get replied() {
        return false;
      },
      deferUpdate: async () => {
        deferred = true;
      },
      editReply: async () => {},
    } as unknown as ButtonInteraction;

    await route.execute({} as Client, interaction, requireRoute(customId));

    expect(calls).toContain("toggleCrossServerStm");
    expect(telemetry).toContain("personal-config.personal.crossserver-stm.set");
  });

  it("handles outdated panel version in router", async () => {
    let replyPayload: InteractionReplyOptions | null = null;
    const staleInteraction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      customId: "personal-config:v0:category:en-US:profile:general",
      locale: "en-US",
      user: { id: "user-123" },
      reply: async (payload: InteractionReplyOptions) => {
        replyPayload = payload;
      },
    } as unknown as ButtonInteraction;

    const handled = await dispatchGlobalInteraction({} as Client, staleInteraction);
    expect(handled).toBe(true);
    expect(replyPayload).toBeDefined();
    expect((replyPayload as unknown as { content: string }).content).toContain("/personal config");
  });
});

// The route converts each empty modal field to null before the operation sees it, and null is what
// `applyUserInfoBatch` turns into "inherit". Storing "" instead would be a distinct, non-null value
// that permanently defeats the live-Discord-name fallback, and the operations-level tests cannot
// catch it because they are handed nulls directly.
describe("naming modal empty fields mean inherit", () => {
  it("submits a blank or whitespace-only field to the operation as null, not an empty string", async () => {
    const calls: string[] = [];
    let received: { nickname: string | null; prefix: string | null; suffix: string | null } | null = null;

    const { dependencies } = makeDependencies(calls, {
      operations: {
        ...personalConfigOperations,
        setNaming: async (input) => {
          received = { nickname: input.nickname, prefix: input.prefix, suffix: input.suffix };
          return { status: "success" };
        },
      },
    });

    const route = createPersonalConfigInteractionRoute(dependencies);
    const customId = buildPersonalConfigCustomId("naming-submit", "en-US", "nonce123456");

    let deferred = false;
    const interaction = {
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      customId,
      user: { id: "user-123", username: "tester", displayName: "Tester" },
      guildId: "guild-123",
      get deferred() {
        return deferred;
      },
      get replied() {
        return false;
      },
      deferUpdate: async () => {
        deferred = true;
      },
      editReply: async () => {},
      fields: {
        // Whitespace rather than "" so a dropped .trim() fails here too.
        getTextInputValue: (fieldId: string) => (fieldId.startsWith("nickname_") ? "   " : ""),
      },
    } as unknown as ModalSubmitInteraction;

    await route.execute({} as Client, interaction, requireRoute(customId));

    expect(received).toEqual({ nickname: null, prefix: null, suffix: null });
  });
});

describe("personalConfigPanelCatalog Models routes", () => {
  it("encodes and decodes provider names with colons", () => {
    expect(encodeProviderParam("custom:12")).toBe("custom~12");
    expect(decodeProviderParam("custom~12")).toBe("custom:12");
    expect(encodeProviderParam("openrouter")).toBe("openrouter");
    expect(decodeProviderParam("openrouter")).toBe("openrouter");
  });

  it("builds custom IDs within 100 characters for all Models actions", () => {
    const actions: Array<[string, ...unknown[]]> = [
      ["capability-select", "en-US"],
      ["quick-toggle-open", "en-US"],
      ["quick-toggle-submit", "en-US", "nonce123456"],
      ["model-enable", "en-US", "image_nai"],
      ["model-default", "en-US", "image_nai"],
      ["model-provider-select", "en-US", "image_nai"],
      ["model-modal-submit", "en-US", "image_nai", encodeProviderParam("custom:123456789"), "nonce123456"],
      ["parameters-provider-select", "en-US"],
      ["parameters-1-open", "en-US", encodeProviderParam("custom:123456789")],
      ["parameters-1-submit", "en-US", encodeProviderParam("custom:123456789"), "nonce123456"],
      ["parameters-2-open", "en-US", encodeProviderParam("custom:123456789")],
      ["parameters-2-submit", "en-US", encodeProviderParam("custom:123456789"), "nonce123456"],
      ["fallbacks-provider-select", "en-US"],
      ["fallbacks-open", "en-US", encodeProviderParam("custom:123456789")],
      ["fallbacks-submit", "en-US", encodeProviderParam("custom:123456789"), "nonce123456"],
      ["randomizer-toggle", "en-US", encodeProviderParam("custom:123456789")],
    ];

    for (const [action, locale, ...args] of actions) {
      const id = buildPersonalConfigCustomId(
        action as Parameters<typeof buildPersonalConfigCustomId>[0],
        locale as string,
        ...(args as string[]),
      );
      expect(id.length).toBeLessThanOrEqual(100);
      const parsed = parsePersonalConfigPanelRoute(requireRoute(id));
      expect(parsed).toBeDefined();
      expect(parsed?.action).toBe(action);
    }
  });
});

describe("personalConfigOperations Models invariants", () => {
  it("setCapabilityEnabled rejects enabling when no model is configured", async () => {
    const loadSpy = spyOn(llmProviderRepo, "loadUserSavedProviderConfigs").mockImplementation(async () => [
      {
        user_saved_config_id: 1,
        user_id: 1,
        provider: "openrouter",
        key_version: 1,
        api_key: null,
        llm_id: null,
        diffusion_model_id: null,
        embedding_model_id: null,
        nai_diffusion_model_id: null,
        video_model_id: null,
        vision_llm_id: null,
        nai_preset_name: null,
        llm_temperature: null,
        llm_top_p: null,
        llm_top_k: null,
        llm_frequency_penalty: null,
        llm_presence_penalty: null,
        llm_min_p: null,
        llm_max_output_tokens: null,
        llm_disabled_params: [],
        llm_logit_biases: [],
        thinking_level: "auto",
        model_randomizer_enabled: false,
        enabled_capabilities: [],
        assigned_capabilities: ["text"],
        fallback_model_refs: [],
      } as unknown as UserSavedProviderConfigRow,
    ]);

    const result = await personalConfigOperations.setCapabilityEnabled({
      userId: 1,
      userDiscId: "user-123",
      capability: "text",
      enabled: true,
    });

    expect(result).toEqual({ status: "missing-model" });
    loadSpy.mockRestore();
  });

  it("setCapabilityModel rejects a model outside the fresh provider catalog", async () => {
    const savedRow = {
      provider: "openrouter",
      llm_id: 101,
      enabled_capabilities: ["text"],
      assigned_capabilities: ["text"],
    } as unknown as UserSavedProviderConfigRow;
    const loadConfigsSpy = spyOn(llmProviderRepo, "loadUserSavedProviderConfigs").mockImplementation(async () => [
      savedRow,
    ]);
    const availableSpy = spyOn(llmModelRepo, "loadAvailableModelsForProvider").mockImplementation(
      async () =>
        [{ llm_id: 101, llm_codename: "allowed-model" }] as unknown as ReturnType<
          typeof llmModelRepo.loadAvailableModelsForProvider
        > extends Promise<infer T>
          ? T
          : never,
    );
    const upsertSpy = spyOn(llmProviderRepo, "upsertUserSavedProviderConfig").mockImplementation(async () => true);

    const result = await personalConfigOperations.setCapabilityModel({
      userId: 1,
      userDiscId: "user-123",
      capability: "text",
      provider: "openrouter",
      modelId: 999,
    });

    expect(result).toEqual({ status: "write-failed" });
    expect(upsertSpy).not.toHaveBeenCalled();
    loadConfigsSpy.mockRestore();
    availableSpy.mockRestore();
    upsertSpy.mockRestore();
  });

  it("setQuickToggleRouting attempts all five capabilities after a partial failure", async () => {
    const savedRow = {
      provider: "openrouter",
      llm_id: 101,
      vision_llm_id: 102,
      embedding_model_id: 201,
      diffusion_model_id: 301,
      nai_diffusion_model_id: null,
      video_model_id: 401,
      enabled_capabilities: [],
      assigned_capabilities: ["text", "vision", "embedding", "image", "video"],
    } as unknown as UserSavedProviderConfigRow;
    const loadConfigsSpy = spyOn(llmProviderRepo, "loadUserSavedProviderConfigs").mockImplementation(async () => [
      savedRow,
    ]);
    let writeCount = 0;
    const upsertSpy = spyOn(llmProviderRepo, "upsertUserSavedProviderConfig").mockImplementation(async () => {
      writeCount += 1;
      return writeCount !== 1;
    });

    const result = await personalConfigOperations.setQuickToggleRouting({
      userId: 1,
      userDiscId: "user-123",
      selectedCapabilities: new Set(["text", "vision", "embedding", "image", "video"]),
    });

    expect(result).toEqual({ status: "write-failed" });
    expect(writeCount).toBe(5);
    loadConfigsSpy.mockRestore();
    upsertSpy.mockRestore();
  });

  it("setParameters rejects invalid bounds and thinking level", async () => {
    const loadConfigsSpy = spyOn(llmProviderRepo, "loadUserSavedProviderConfigs").mockImplementation(async () => [
      {
        provider: "openrouter",
        llm_id: 101,
        enabled_capabilities: ["text"],
        assigned_capabilities: ["text"],
      } as unknown as UserSavedProviderConfigRow,
    ]);
    const loadSpy = spyOn(llmProviderRepo, "loadUserSavedProviderConfig").mockImplementation(
      async () =>
        ({
          user_saved_config_id: 1,
          user_id: 1,
          provider: "openrouter",
          key_version: 1,
          api_key: null,
          llm_id: 101,
          diffusion_model_id: null,
          embedding_model_id: null,
          nai_diffusion_model_id: null,
          video_model_id: null,
          vision_llm_id: null,
          nai_preset_name: null,
          llm_temperature: 0.7,
          llm_top_p: 0.95,
          llm_top_k: 0,
          llm_frequency_penalty: 0,
          llm_presence_penalty: 0,
          llm_min_p: 0.05,
          llm_max_output_tokens: 4096,
          llm_disabled_params: [],
          llm_logit_biases: [],
          thinking_level: "auto",
          model_randomizer_enabled: false,
          enabled_capabilities: ["text"],
          assigned_capabilities: ["text"],
          fallback_model_refs: [],
        }) as unknown as UserSavedProviderConfigRow,
    );

    const badTemp = await personalConfigOperations.setParameters({
      userId: 1,
      userDiscId: "user-123",
      provider: "openrouter",
      patch: { temperature: 3.5 },
    });
    expect(badTemp).toEqual({ status: "invalid-value" });

    const badTopK = await personalConfigOperations.setParameters({
      userId: 1,
      userDiscId: "user-123",
      provider: "openrouter",
      patch: { top_k: -5 },
    });
    expect(badTopK).toEqual({ status: "invalid-value" });

    const badThinking = await personalConfigOperations.setParameters({
      userId: 1,
      userDiscId: "user-123",
      provider: "openrouter",
      patch: { thinking_level: "ultra" as unknown as ThinkingLevelValue },
    });
    expect(badThinking).toEqual({ status: "invalid-value" });

    loadSpy.mockRestore();
    loadConfigsSpy.mockRestore();
  });

  it("setRandomizer requires at least one fallback model when enabling", async () => {
    const loadConfigsSpy = spyOn(llmProviderRepo, "loadUserSavedProviderConfigs").mockImplementation(async () => [
      {
        provider: "openrouter",
        llm_id: 101,
        enabled_capabilities: ["text"],
        assigned_capabilities: ["text"],
      } as unknown as UserSavedProviderConfigRow,
    ]);
    const loadSpy = spyOn(llmProviderRepo, "loadUserSavedProviderConfig").mockImplementation(
      async () =>
        ({
          user_saved_config_id: 1,
          user_id: 1,
          provider: "openrouter",
          key_version: 1,
          api_key: null,
          llm_id: 101,
          diffusion_model_id: null,
          embedding_model_id: null,
          nai_diffusion_model_id: null,
          video_model_id: null,
          vision_llm_id: null,
          nai_preset_name: null,
          llm_temperature: 0.7,
          llm_top_p: 0.95,
          llm_top_k: 0,
          llm_frequency_penalty: 0,
          llm_presence_penalty: 0,
          llm_min_p: 0.05,
          llm_max_output_tokens: 4096,
          llm_disabled_params: [],
          llm_logit_biases: [],
          thinking_level: "auto",
          model_randomizer_enabled: false,
          enabled_capabilities: ["text"],
          assigned_capabilities: ["text"],
          fallback_model_refs: [],
        }) as unknown as UserSavedProviderConfigRow,
    );

    const result = await personalConfigOperations.setRandomizer({
      userId: 1,
      userDiscId: "user-123",
      provider: "openrouter",
      enabled: true,
    });

    expect(result).toEqual({ status: "requires-fallbacks" });
    loadSpy.mockRestore();
    loadConfigsSpy.mockRestore();
  });
});

describe("Models interaction routing and telemetry", () => {
  it("quick-toggle-submit acknowledges before the operation and records telemetry on success", async () => {
    const calls: string[] = [];
    let deferred = false;
    const { dependencies, telemetry } = makeDependencies(calls);
    dependencies.operations = {
      ...dependencies.operations,
      setQuickToggleRouting: async () => {
        expect(deferred).toBe(true);
        calls.push("setQuickToggleRouting");
        return { status: "success" };
      },
    };
    const route = createPersonalConfigInteractionRoute(dependencies);
    const customId = buildPersonalConfigCustomId("quick-toggle-submit", "en-US", "nonce123456");

    const interaction = {
      id: "modal-1",
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      customId,
      user: { id: "user-123", username: "tester", displayName: "Tester" },
      guildId: "guild-123",
      get deferred() {
        return deferred;
      },
      get replied() {
        return false;
      },
      deferUpdate: async () => {
        deferred = true;
      },
      editReply: async () => {},
    } as unknown as ModalSubmitInteraction;

    await route.execute({} as Client, interaction, requireRoute(customId));

    expect(calls.some((c) => c.startsWith("setQuickToggleRouting"))).toBe(true);
    expect(telemetry).toContain("personal-config.personal.model-routing.set");
  });

  it("model-enable records personal-config.personal.model.set telemetry", async () => {
    const calls: string[] = [];
    const { dependencies, telemetry } = makeDependencies(calls);
    const route = createPersonalConfigInteractionRoute(dependencies);
    const customId = buildPersonalConfigCustomId("model-enable", "en-US", "text");

    let deferred = false;
    const interaction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      customId,
      user: { id: "user-123", username: "tester", displayName: "Tester" },
      guildId: "guild-123",
      get deferred() {
        return deferred;
      },
      get replied() {
        return false;
      },
      deferUpdate: async () => {
        deferred = true;
      },
      editReply: async () => {},
    } as unknown as ButtonInteraction;

    await route.execute({} as Client, interaction, requireRoute(customId));

    expect(calls).toContain("setCapabilityEnabled:text:true");
    expect(telemetry).toContain("personal-config.personal.model.set");
  });

  it("randomizer-toggle records personal-config.personal.randomizer.set telemetry", async () => {
    const calls: string[] = [];
    const { dependencies, telemetry } = makeDependencies(calls);
    const route = createPersonalConfigInteractionRoute(dependencies);
    const customId = buildPersonalConfigCustomId("randomizer-toggle", "en-US", encodeProviderParam("openrouter"));

    let deferred = false;
    const interaction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      customId,
      user: { id: "user-123", username: "tester", displayName: "Tester" },
      guildId: "guild-123",
      get deferred() {
        return deferred;
      },
      get replied() {
        return false;
      },
      deferUpdate: async () => {
        deferred = true;
      },
      editReply: async () => {},
    } as unknown as ButtonInteraction;

    await route.execute({} as Client, interaction, requireRoute(customId));

    expect(calls).toContain("setRandomizer:openrouter:true");
    expect(telemetry).toContain("personal-config.personal.randomizer.set");
  });

  it("parameters-1-submit records personal-config.personal.parameters.set telemetry", async () => {
    const calls: string[] = [];
    const { dependencies, telemetry } = makeDependencies(calls);
    const route = createPersonalConfigInteractionRoute(dependencies);
    const customId = buildPersonalConfigCustomId(
      "parameters-1-submit",
      "en-US",
      encodeProviderParam("openrouter"),
      "nonce123456",
    );

    let deferred = false;
    const interaction = {
      id: "modal-1",
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      customId,
      user: { id: "user-123", username: "tester", displayName: "Tester" },
      guildId: "guild-123",
      get deferred() {
        return deferred;
      },
      get replied() {
        return false;
      },
      deferUpdate: async () => {
        deferred = true;
      },
      editReply: async () => {},
      fields: {
        getTextInputValue: (fieldId: string) => {
          if (fieldId.startsWith("temperature_")) return "0.8";
          if (fieldId.startsWith("min_p_")) return "0.1";
          if (fieldId.startsWith("top_p_")) return "0.9";
          if (fieldId.startsWith("top_k_")) return "40";
          if (fieldId.startsWith("frequency_penalty_")) return "0.2";
          return "";
        },
      },
    } as unknown as ModalSubmitInteraction;

    await route.execute({} as Client, interaction, requireRoute(customId));

    expect(calls.some((c) => c.startsWith("setParameters:openrouter:"))).toBe(true);
    expect(telemetry).toContain("personal-config.personal.parameters.set");
  });

  it("fallbacks-submit records personal-config.personal.fallbacks.set telemetry", async () => {
    const calls: string[] = [];
    const { dependencies, telemetry } = makeDependencies(calls);
    const route = createPersonalConfigInteractionRoute(dependencies);
    const customId = buildPersonalConfigCustomId(
      "fallbacks-submit",
      "en-US",
      encodeProviderParam("openrouter"),
      "nonce123456",
    );

    let deferred = false;
    const interaction = {
      id: "modal-1",
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      customId,
      user: { id: "user-123", username: "tester", displayName: "Tester" },
      guildId: "guild-123",
      get deferred() {
        return deferred;
      },
      get replied() {
        return false;
      },
      deferUpdate: async () => {
        deferred = true;
      },
      editReply: async () => {},
      fields: {
        getTextInputValue: () => "",
      },
    } as unknown as ModalSubmitInteraction;

    await route.execute({} as Client, interaction, requireRoute(customId));

    expect(calls.some((c) => c.startsWith("setFallbacks:openrouter:"))).toBe(true);
    expect(telemetry).toContain("personal-config.personal.fallbacks.set");
  });
});

describe("Models panel rendering", () => {
  it("renders 6 routing rows and never renders Off as a routing status on Switch Models page", () => {
    const user = makeUser();
    const payload = buildPersonalConfigPanelPayload({
      locale: "en-US",
      category: "models",
      page: "switch",
      user,
      resolvedNickname: "Tester",
      personas: [makePersona(1, 10, "Tomori")],
      memoryCount: 0,
      stmCount: 0,
      readStatus: "fresh",
      modelDisplayInfo: {
        routingRows: {
          text: {
            capability: "text",
            activeModelName: "OpenRouter · Claude 3.5 Sonnet",
            storedProvider: "openrouter",
            storedModelName: "OpenRouter · Claude 3.5 Sonnet",
          },
          vision: {
            capability: "vision",
            activeModelName: null,
            storedProvider: null,
            storedModelName: null,
          },
          embedding: {
            capability: "embedding",
            activeModelName: "OpenRouter · text-embedding-3",
            storedProvider: "openrouter",
            storedModelName: "OpenRouter · text-embedding-3",
          },
          image: {
            capability: "image",
            activeModelName: "OpenRouter · Flux.1 Schnell",
            storedProvider: "openrouter",
            storedModelName: "OpenRouter · Flux.1 Schnell",
          },
          image_nai: {
            capability: "image_nai",
            activeModelName: "NovelAI · NAI Diffusion V3",
            storedProvider: "novelai",
            storedModelName: "NovelAI · NAI Diffusion V3",
          },
          video: {
            capability: "video",
            activeModelName: null,
            storedProvider: null,
            storedModelName: null,
          },
        },
        availableCapabilities: ["text", "vision", "embedding", "image", "image_nai", "video"],
        eligibleProvidersForCapability: {
          text: ["openrouter"],
          vision: ["openrouter"],
          embedding: ["openrouter"],
          image: ["openrouter"],
          image_nai: ["novelai"],
          video: ["openrouter"],
        },
        parametersProviders: ["openrouter"],
        selectedParametersConfig: null,
        fallbacksProviders: ["openrouter"],
        selectedFallbacksConfig: null,
        primaryModelName: null,
        fallbackSlots: [],
        randomizerEnabled: false,
        canEnableRandomizer: false,
      },
    });

    const payloadJson = JSON.stringify(payload);
    expect(payloadJson).toContain("Text");
    expect(payloadJson).toContain("Vision");
    expect(payloadJson).toContain("Embedding");
    expect(payloadJson).toContain("Standard Image");
    expect(payloadJson).toContain("NovelAI Image");
    expect(payloadJson).toContain("Video");
    expect(payloadJson).toContain("Server Default");
    // Routing status should never render "Off"
    expect(payloadJson).not.toContain("`Off`");
    expect(payloadJson).not.toContain("`off`");
  });

  it("renders Parameters page with 8 parameter rows and split 1-5 and 6-8 edit buttons", () => {
    const user = makeUser();
    const payload = buildPersonalConfigPanelPayload({
      locale: "en-US",
      category: "models",
      page: "parameters",
      user,
      resolvedNickname: "Tester",
      personas: [makePersona(1, 10, "Tomori")],
      memoryCount: 0,
      stmCount: 0,
      readStatus: "fresh",
      modelDisplayInfo: {
        routingRows: {} as unknown as Record<PersonalConfigManagedCapability, PersonalConfigRoutingRow>,
        availableCapabilities: ["text"],
        eligibleProvidersForCapability: { text: ["openrouter"] } as unknown as Record<
          PersonalConfigManagedCapability,
          string[]
        >,
        parametersProviders: ["openrouter"],
        selectedParametersConfig: {
          user_saved_config_id: 1,
          user_id: 1,
          provider: "openrouter",
          key_version: 1,
          api_key: null,
          llm_id: 101,
          diffusion_model_id: null,
          embedding_model_id: null,
          nai_diffusion_model_id: null,
          video_model_id: null,
          vision_llm_id: null,
          nai_preset_name: null,
          llm_temperature: 0.7,
          llm_top_p: 0.95,
          llm_top_k: 0,
          llm_frequency_penalty: 0,
          llm_presence_penalty: 0,
          llm_min_p: 0.05,
          llm_max_output_tokens: 4096,
          llm_disabled_params: [],
          llm_logit_biases: [],
          thinking_level: "auto",
          model_randomizer_enabled: false,
          enabled_capabilities: ["text"],
          assigned_capabilities: ["text"],
          fallback_model_refs: [],
        } as unknown as UserSavedProviderConfigRow,
        fallbacksProviders: ["openrouter"],
        selectedFallbacksConfig: null,
        primaryModelName: null,
        fallbackSlots: [],
        randomizerEnabled: false,
        canEnableRandomizer: false,
      },
    });

    const payloadJson = JSON.stringify(payload);
    expect(payloadJson).toContain("Temperature");
    expect(payloadJson).toContain("Min P");
    expect(payloadJson).toContain("Top P");
    expect(payloadJson).toContain("Top K");
    expect(payloadJson).toContain("Frequency penalty");
    expect(payloadJson).toContain("Presence penalty");
    expect(payloadJson).toContain("Maximum output tokens");
    expect(payloadJson).toContain("Thinking level");
    expect(payloadJson).toContain("Edit Parameters 1-5");
    expect(payloadJson).toContain("Edit Parameters 6-8");
  });

  it("renders Fallbacks page with primary model, 5 ordered slots, and Randomizer toggle button", () => {
    const user = makeUser();
    const payload = buildPersonalConfigPanelPayload({
      locale: "en-US",
      category: "models",
      page: "fallbacks",
      user,
      resolvedNickname: "Tester",
      personas: [makePersona(1, 10, "Tomori")],
      memoryCount: 0,
      stmCount: 0,
      readStatus: "fresh",
      modelDisplayInfo: {
        routingRows: {} as unknown as Record<PersonalConfigManagedCapability, PersonalConfigRoutingRow>,
        availableCapabilities: ["text"],
        eligibleProvidersForCapability: { text: ["openrouter"] } as unknown as Record<
          PersonalConfigManagedCapability,
          string[]
        >,
        parametersProviders: ["openrouter"],
        selectedParametersConfig: null,
        fallbacksProviders: ["openrouter"],
        selectedFallbacksConfig: {
          user_saved_config_id: 1,
          user_id: 1,
          provider: "openrouter",
          key_version: 1,
          api_key: null,
          llm_id: 101,
          diffusion_model_id: null,
          embedding_model_id: null,
          nai_diffusion_model_id: null,
          video_model_id: null,
          vision_llm_id: null,
          nai_preset_name: null,
          llm_temperature: 0.7,
          llm_top_p: 0.95,
          llm_top_k: 0,
          llm_frequency_penalty: 0,
          llm_presence_penalty: 0,
          llm_min_p: 0.05,
          llm_max_output_tokens: 4096,
          llm_disabled_params: [],
          llm_logit_biases: [],
          thinking_level: "auto",
          model_randomizer_enabled: false,
          enabled_capabilities: ["text"],
          assigned_capabilities: ["text"],
          fallback_model_refs: [{ type: "llm", id: 102 }],
        } as unknown as UserSavedProviderConfigRow,
        primaryModelName: "Claude 3.5 Sonnet",
        fallbackSlots: [
          { slot: 1, modelName: "Claude 3 Haiku" },
          { slot: 2, modelName: null },
          { slot: 3, modelName: null },
          { slot: 4, modelName: null },
          { slot: 5, modelName: null },
        ],
        randomizerEnabled: false,
        canEnableRandomizer: true,
      },
    });

    const payloadJson = JSON.stringify(payload);
    expect(payloadJson).toContain("Primary");
    expect(payloadJson).toContain("Claude 3.5 Sonnet");
    expect(payloadJson).toContain("Claude 3 Haiku");
    expect(payloadJson).toContain("Edit Fallback Models");
    expect(payloadJson).toContain("Model Randomizer");
    expect(payloadJson).toContain("Enable Randomizer");
  });
});

describe("Activation confirmation semantics", () => {
  it("prompts for confirmation when model assignment newly activates an override", async () => {
    const calls: string[] = [];
    let repaintedView: unknown = null;

    const { dependencies, telemetry } = makeDependencies(calls, {
      loadUserSavedProviders: async () => [
        {
          user_saved_config_id: 1,
          user_id: 1,
          provider: "openrouter",
          enabled_capabilities: [], // currently disabled (uses server default)
          assigned_capabilities: ["text"],
          llm_id: 101,
        } as unknown as UserSavedProviderConfigRow,
      ],
      loadAvailableModelsForCapability: async () => [
        { id: 101, name: "Claude 3.5 Sonnet" },
        { id: 102, name: "Claude 3 Opus" },
      ],
    });

    const route = createPersonalConfigInteractionRoute(dependencies);
    const customId = buildPersonalConfigCustomId(
      "model-modal-submit",
      "en-US",
      "text",
      encodeProviderParam("openrouter"),
      "nonce123456",
    );

    const interaction = {
      id: "modal-1",
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      customId,
      user: { id: "user-123", username: "tester", displayName: "Tester" },
      guildId: "guild-123",
      deferred: false,
      replied: false,
      deferUpdate: async () => {},
      editReply: async (payload: { components: unknown[] }) => {
        repaintedView = payload;
      },
      fields: {
        getTextInputValue: () => "",
      },
    } as unknown as ModalSubmitInteraction;

    // Simulate modal value for model ID 102
    const modalsModule = await import("@/utils/discord/ui/modals");
    const takeSpy = spyOn(modalsModule, "takeRawModalSelectValue").mockReturnValue("102");

    await route.execute({} as Client, interaction, requireRoute(customId));

    takeSpy.mockRestore();

    // Did NOT execute write yet
    expect(calls.some((c) => c.startsWith("setCapabilityModel"))).toBe(false);
    // Did NOT emit telemetry
    expect(telemetry).not.toContain("personal-config.personal.model.set");
    // Repainted with confirmation view
    const json = JSON.stringify(repaintedView);
    expect(json).toContain("model-act-confirm");
    expect(json).toContain("model-act-cancel");
  });

  it("writes immediately without confirmation when capability is already an active override", async () => {
    const calls: string[] = [];
    let repaintedView: unknown = null;

    const { dependencies, telemetry } = makeDependencies(calls, {
      loadUserSavedProviders: async () => [
        {
          user_saved_config_id: 1,
          user_id: 1,
          provider: "openrouter",
          enabled_capabilities: ["text"], // already active override!
          assigned_capabilities: ["text"],
          llm_id: 101,
        } as unknown as UserSavedProviderConfigRow,
      ],
      loadAvailableModelsForCapability: async () => [
        { id: 101, name: "Claude 3.5 Sonnet" },
        { id: 102, name: "Claude 3 Opus" },
      ],
    });

    const route = createPersonalConfigInteractionRoute(dependencies);
    const customId = buildPersonalConfigCustomId(
      "model-modal-submit",
      "en-US",
      "text",
      encodeProviderParam("openrouter"),
      "nonce123456",
    );

    const interaction = {
      id: "modal-1",
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      customId,
      user: { id: "user-123", username: "tester", displayName: "Tester" },
      guildId: "guild-123",
      deferred: false,
      replied: false,
      deferUpdate: async () => {},
      editReply: async (payload: unknown) => {
        repaintedView = payload;
      },
      fields: {
        getTextInputValue: () => "",
      },
    } as unknown as ModalSubmitInteraction;

    const modalsModule = await import("@/utils/discord/ui/modals");
    const takeSpy = spyOn(modalsModule, "takeRawModalSelectValue").mockReturnValue("102");

    await route.execute({} as Client, interaction, requireRoute(customId));

    takeSpy.mockRestore();

    expect(calls).toContain("setCapabilityModel:text:openrouter:102");
    expect(telemetry).toContain("personal-config.personal.model.set");
    const json = JSON.stringify(repaintedView);
    expect(json).not.toContain("model-act-confirm");
    expect(json).toContain("Text now routes to OpenRouter using Claude 3 Opus");
  });

  it("model-act-confirm executes write and emits telemetry on success", async () => {
    const calls: string[] = [];
    const { dependencies, telemetry } = makeDependencies(calls, {
      loadAvailableModelsForCapability: async () => [{ id: 102, name: "Claude 3 Opus" }],
    });

    const route = createPersonalConfigInteractionRoute(dependencies);
    const customId = buildPersonalConfigCustomId(
      "model-act-confirm",
      "en-US",
      "text",
      encodeProviderParam("openrouter"),
      102,
      "nonce123456",
    );

    const interaction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      customId,
      user: { id: "user-123", username: "tester", displayName: "Tester" },
      guildId: "guild-123",
      deferred: false,
      replied: false,
      deferUpdate: async () => {},
      editReply: async () => {},
    } as unknown as ButtonInteraction;

    await route.execute({} as Client, interaction, requireRoute(customId));

    expect(calls).toContain("setCapabilityModel:text:openrouter:102");
    expect(telemetry).toContain("personal-config.personal.model.set");
  });

  it("model-act-cancel repaints without writing or emitting telemetry", async () => {
    const calls: string[] = [];
    let repaintedView: unknown = null;
    const { dependencies, telemetry } = makeDependencies(calls);

    const route = createPersonalConfigInteractionRoute(dependencies);
    const customId = buildPersonalConfigCustomId("model-act-cancel", "en-US");

    const interaction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      customId,
      user: { id: "user-123", username: "tester", displayName: "Tester" },
      guildId: "guild-123",
      deferred: false,
      replied: false,
      deferUpdate: async () => {},
      editReply: async (payload: unknown) => {
        repaintedView = payload;
      },
    } as unknown as ButtonInteraction;

    await route.execute({} as Client, interaction, requireRoute(customId));

    expect(calls.some((c) => c.startsWith("setCapabilityModel"))).toBe(false);
    expect(telemetry).toHaveLength(0);
    const json = JSON.stringify(repaintedView);
    expect(json).toContain("Activation Cancelled");
  });

  it("fails closed on model-act-confirm when target model is no longer available", async () => {
    const calls: string[] = [];
    let repaintedView: unknown = null;
    const { dependencies, telemetry } = makeDependencies(calls, {
      loadAvailableModelsForCapability: async () => [], // model 999 no longer exists!
    });

    const route = createPersonalConfigInteractionRoute(dependencies);
    const customId = buildPersonalConfigCustomId(
      "model-act-confirm",
      "en-US",
      "text",
      encodeProviderParam("openrouter"),
      999,
      "nonce123456",
    );

    const interaction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      customId,
      user: { id: "user-123", username: "tester", displayName: "Tester" },
      guildId: "guild-123",
      deferred: false,
      replied: false,
      deferUpdate: async () => {},
      editReply: async (payload: unknown) => {
        repaintedView = payload;
      },
    } as unknown as ButtonInteraction;

    await route.execute({} as Client, interaction, requireRoute(customId));

    expect(calls.some((c) => c.startsWith("setCapabilityModel"))).toBe(false);
    expect(telemetry).toHaveLength(0);
    const json = JSON.stringify(repaintedView);
    expect(json).toContain("Operation Failed");
  });
});

describe("Re-resolution and zero model guard", () => {
  it("model-provider-select shows named no-models receipt when provider has 0 eligible models", async () => {
    let modalShown = false;
    let repaintedView: unknown = null;

    const { dependencies } = makeDependencies([], {
      loadAvailableModelsForCapability: async () => [],
      showModelSelectModal: async () => {
        modalShown = true;
      },
    });

    const route = createPersonalConfigInteractionRoute(dependencies);
    const customId = buildPersonalConfigCustomId("model-provider-select", "en-US", "text");

    const interaction = {
      isButton: () => false,
      isStringSelectMenu: () => true,
      isModalSubmit: () => false,
      customId,
      values: ["openrouter"],
      user: { id: "user-123", username: "tester", displayName: "Tester" },
      guildId: "guild-123",
      deferred: false,
      replied: false,
      deferUpdate: async () => {},
      editReply: async (payload: unknown) => {
        repaintedView = payload;
      },
    } as unknown as StringSelectMenuInteraction;

    await route.execute({} as Client, interaction, requireRoute(customId));

    expect(modalShown).toBe(false);
    const json = JSON.stringify(repaintedView);
    expect(json).toContain("No Models Available");
    expect(json).toContain("OpenRouter");
  });

  it("server default explicitly disables personal capability", async () => {
    const calls: string[] = [];
    const { dependencies, telemetry } = makeDependencies(calls);

    const route = createPersonalConfigInteractionRoute(dependencies);
    const customId = buildPersonalConfigCustomId("model-provider-select", "en-US", "text");

    const interaction = {
      isButton: () => false,
      isStringSelectMenu: () => true,
      isModalSubmit: () => false,
      customId,
      values: ["__server_default__"],
      user: { id: "user-123", username: "tester", displayName: "Tester" },
      guildId: "guild-123",
      deferred: false,
      replied: false,
      deferUpdate: async () => {},
      editReply: async () => {},
    } as unknown as StringSelectMenuInteraction;

    await route.execute({} as Client, interaction, requireRoute(customId));

    expect(calls).toContain("setCapabilityEnabled:text:false");
    expect(telemetry).toContain("personal-config.personal.model.set");
  });
});

describe("Range pagination workflow", () => {
  it("renders range view when available models exceed 25", async () => {
    let modalShown = false;
    let repaintedView: unknown = null;

    const thirtyModels = Array.from({ length: 30 }, (_, i) => ({
      id: 100 + i,
      name: `Model ${i + 1}`,
    }));

    const { dependencies } = makeDependencies([], {
      loadAvailableModelsForCapability: async () => thirtyModels,
      showModelSelectModal: async () => {
        modalShown = true;
      },
    });

    const route = createPersonalConfigInteractionRoute(dependencies);
    const customId = buildPersonalConfigCustomId("model-provider-select", "en-US", "text");

    const interaction = {
      isButton: () => false,
      isStringSelectMenu: () => true,
      isModalSubmit: () => false,
      customId,
      values: ["openrouter"],
      user: { id: "user-123", username: "tester", displayName: "Tester" },
      guildId: "guild-123",
      deferred: false,
      replied: false,
      deferUpdate: async () => {},
      editReply: async (payload: unknown) => {
        repaintedView = payload;
      },
    } as unknown as StringSelectMenuInteraction;

    await route.execute({} as Client, interaction, requireRoute(customId));

    expect(modalShown).toBe(false);
    const json = JSON.stringify(repaintedView);
    expect(json).toContain("Select Text Model Range");
    expect(json).toContain("1 - 25");
    expect(json).toContain("26 - 30");
  });

  it("opens modal with sliced models on model-range-open", async () => {
    let passedModels: Array<{ id: number; name: string }> = [];

    const thirtyModels = Array.from({ length: 30 }, (_, i) => ({
      id: 100 + i,
      name: `Model ${i + 1}`,
    }));

    const { dependencies } = makeDependencies([], {
      loadAvailableModelsForCapability: async () => thirtyModels,
      showModelSelectModal: async (_interaction, _locale, _nonce, _cap, _prov, models) => {
        passedModels = models;
      },
    });

    const route = createPersonalConfigInteractionRoute(dependencies);
    const customId = buildPersonalConfigCustomId(
      "model-range-open",
      "en-US",
      "text",
      encodeProviderParam("openrouter"),
      25,
    );

    const interaction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      customId,
      user: { id: "user-123", username: "tester", displayName: "Tester" },
      guildId: "guild-123",
      deferred: false,
      replied: false,
    } as unknown as ButtonInteraction;

    await route.execute({} as Client, interaction, requireRoute(customId));

    expect(passedModels).toHaveLength(5);
    expect(passedModels[0].name).toBe("Model 26");
    expect(passedModels[4].name).toBe("Model 30");
  });
});

describe("Models-page cache invalidation invariants", () => {
  it("does not call invalidateUserCache on any Models operations writes", async () => {
    const userCacheModule = await import("@/utils/cache/userCache");
    const invalidateSpy = spyOn(userCacheModule, "invalidateUserCache").mockImplementation(() => {});
    const upsertSpy = spyOn(llmProviderRepo, "upsertUserSavedProviderConfig").mockImplementation(async () => true);
    const randomizerSpy = spyOn(llmProviderRepo, "updatePersonalModelRandomizer").mockImplementation(async () => true);

    const dummyConfig: UserSavedProviderConfigRow = {
      user_saved_config_id: 1,
      user_id: 1,
      provider: "openrouter",
      key_version: 1,
      api_key: null,
      llm_id: 101,
      diffusion_model_id: null,
      embedding_model_id: null,
      nai_diffusion_model_id: null,
      video_model_id: null,
      vision_llm_id: null,
      nai_preset_name: null,
      llm_temperature: 0.7,
      llm_top_p: 0.95,
      llm_top_k: 0,
      llm_frequency_penalty: 0,
      llm_presence_penalty: 0,
      llm_min_p: 0.05,
      llm_max_output_tokens: 4096,
      llm_disabled_params: [],
      llm_logit_biases: [],
      thinking_level: "auto",
      model_randomizer_enabled: false,
      enabled_capabilities: ["text"],
      assigned_capabilities: ["text"],
      fallback_model_refs: [{ type: "llm", id: 102 }],
    } as unknown as UserSavedProviderConfigRow;

    const loadConfigSpy = spyOn(llmProviderRepo, "loadUserSavedProviderConfig").mockImplementation(
      async () => dummyConfig,
    );
    const loadConfigsSpy = spyOn(llmProviderRepo, "loadUserSavedProviderConfigs").mockImplementation(async () => [
      dummyConfig,
    ]);
    const loadEndpointsSpy = spyOn(llmProviderRepo, "loadCustomEndpointsForUser").mockImplementation(async () => []);
    const availableModelsSpy = spyOn(llmModelRepo, "loadAvailableModelsForProvider").mockImplementation(
      async () =>
        [{ llm_id: 102, llm_codename: "replacement-model" }] as unknown as ReturnType<
          typeof llmModelRepo.loadAvailableModelsForProvider
        > extends Promise<infer T>
          ? T
          : never,
    );

    await personalConfigOperations.setCapabilityModel({
      userId: 1,
      userDiscId: "user-123",
      capability: "text",
      provider: "openrouter",
      modelId: 102,
    });
    expect(invalidateSpy).not.toHaveBeenCalled();

    await personalConfigOperations.setCapabilityEnabled({
      userId: 1,
      userDiscId: "user-123",
      capability: "text",
      enabled: false,
    });
    expect(invalidateSpy).not.toHaveBeenCalled();

    await personalConfigOperations.setParameters({
      userId: 1,
      userDiscId: "user-123",
      provider: "openrouter",
      patch: { temperature: 0.9 },
    });
    expect(invalidateSpy).not.toHaveBeenCalled();

    await personalConfigOperations.setRandomizer({
      userId: 1,
      userDiscId: "user-123",
      provider: "openrouter",
      enabled: true,
    });
    expect(invalidateSpy).not.toHaveBeenCalled();

    invalidateSpy.mockRestore();
    upsertSpy.mockRestore();
    randomizerSpy.mockRestore();
    loadConfigSpy.mockRestore();
    loadConfigsSpy.mockRestore();
    loadEndpointsSpy.mockRestore();
    availableModelsSpy.mockRestore();
  });
});

describe("Fallbacks submission re-resolution and invariants", () => {
  it("keeps blank slots, clears none slots, deduplicates, and rejects primary conflict", async () => {
    let savedConfigUpsert: unknown = null;
    const loadConfigsSpy = spyOn(llmProviderRepo, "loadUserSavedProviderConfigs").mockImplementation(async () => [
      {
        provider: "openrouter",
        llm_id: 101,
        enabled_capabilities: ["text"],
        assigned_capabilities: ["text"],
      } as unknown as UserSavedProviderConfigRow,
    ]);
    const loadSpy = spyOn(llmProviderRepo, "loadUserSavedProviderConfig").mockImplementation(
      async () =>
        ({
          user_saved_config_id: 1,
          user_id: 1,
          provider: "openrouter",
          llm_id: 101,
          fallback_model_refs: [
            { type: "llm", id: 102 },
            { type: "llm", id: 103 },
          ],
        }) as unknown as UserSavedProviderConfigRow,
    );
    const availableSpy = spyOn(llmModelRepo, "loadAvailableModelsForProvider").mockImplementation(
      async () =>
        [
          { llm_id: 101, llm_codename: "claude-3-5-sonnet" },
          { llm_id: 102, llm_codename: "claude-3-opus" },
          { llm_id: 103, llm_codename: "gpt-4o" },
          { llm_id: 104, llm_codename: "gemini-pro" },
        ] as unknown as ReturnType<typeof llmModelRepo.loadAvailableModelsForProvider> extends Promise<infer T>
          ? T
          : never,
    );
    const endpointsSpy = spyOn(llmProviderRepo, "loadCustomEndpointsForUser").mockImplementation(async () => []);
    const upsertSpy = spyOn(llmProviderRepo, "upsertUserSavedProviderConfig").mockImplementation(
      async (_userId, cfg) => {
        savedConfigUpsert = cfg;
        return true;
      },
    );

    const conflictResult = await personalConfigOperations.setFallbacks({
      userId: 1,
      userDiscId: "user-123",
      provider: "openrouter",
      slotValues: ["llm:101", "", "", "", ""],
    });
    expect(conflictResult.status).toBe("primary-conflict");

    const validResult = await personalConfigOperations.setFallbacks({
      userId: 1,
      userDiscId: "user-123",
      provider: "openrouter",
      slotValues: ["", "__none__", "llm:104", "llm:104", ""],
    });
    expect(validResult.status).toBe("success");
    expect((savedConfigUpsert as { fallback_model_refs: unknown[] }).fallback_model_refs).toEqual([
      { type: "llm", id: 102 },
      { type: "llm", id: 104 },
    ]);

    loadSpy.mockRestore();
    loadConfigsSpy.mockRestore();
    availableSpy.mockRestore();
    endpointsSpy.mockRestore();
    upsertSpy.mockRestore();
  });

  it("rejects a custom endpoint submitted for a standard provider", async () => {
    const savedRow = {
      provider: "openrouter",
      llm_id: 101,
      fallback_model_refs: [],
      enabled_capabilities: ["text"],
      assigned_capabilities: ["text"],
    } as unknown as UserSavedProviderConfigRow;
    const loadConfigsSpy = spyOn(llmProviderRepo, "loadUserSavedProviderConfigs").mockImplementation(async () => [
      savedRow,
    ]);
    const loadConfigSpy = spyOn(llmProviderRepo, "loadUserSavedProviderConfig").mockImplementation(
      async () => savedRow,
    );
    const availableSpy = spyOn(llmModelRepo, "loadAvailableModelsForProvider").mockImplementation(async () => []);
    const endpointsSpy = spyOn(llmProviderRepo, "loadCustomEndpointsForUser").mockImplementation(
      async () =>
        [
          {
            custom_endpoint_id: 55,
            connection_id: 9,
            capability: "text",
            label: "owned-endpoint",
          },
        ] as unknown as ReturnType<typeof llmProviderRepo.loadCustomEndpointsForUser> extends Promise<infer T>
          ? T
          : never,
    );
    const upsertSpy = spyOn(llmProviderRepo, "upsertUserSavedProviderConfig").mockImplementation(async () => true);

    const result = await personalConfigOperations.setFallbacks({
      userId: 1,
      userDiscId: "user-123",
      provider: "openrouter",
      slotValues: ["custom_endpoint:55", "", "", "", ""],
    });

    expect(result).toEqual({ status: "write-failed" });
    expect(upsertSpy).not.toHaveBeenCalled();
    loadConfigsSpy.mockRestore();
    loadConfigSpy.mockRestore();
    availableSpy.mockRestore();
    endpointsSpy.mockRestore();
    upsertSpy.mockRestore();
  });
});

describe("Quick-Toggle modal structure and routing copy", () => {
  it("renders 5 checkbox options labeled Image controlling Standard and NovelAI Image", () => {
    const { buildQuickToggleModal } = require("@/utils/discord/ui/personalConfigPanel");
    const modal = buildQuickToggleModal("en-US", "nonce123456", [
      {
        user_saved_config_id: 1,
        user_id: 1,
        provider: "openrouter",
        enabled_capabilities: ["text", "image"],
        assigned_capabilities: ["text", "image"],
      } as unknown as UserSavedProviderConfigRow,
    ]);

    const modalJson = JSON.stringify(modal);
    expect(modalJson).toContain("Toggle Personal Capabilities");
    expect(modalJson).toContain("Checked capabilities are personal overrides in every server");
    // Checkbox label should be "Image", not "Standard Image"
    expect(modalJson).toContain('"label":"Image"');
    // 5 options in checkbox group: text, vision, embedding, image, video
    expect(modalJson).toContain('"value":"text"');
    expect(modalJson).toContain('"value":"vision"');
    expect(modalJson).toContain('"value":"embedding"');
    expect(modalJson).toContain('"value":"image"');
    expect(modalJson).toContain('"value":"video"');
    expect(modalJson).not.toContain('"value":"image_nai"');
  });
});

describe("personalConfigOperations Advanced operations", () => {
  it("setTriggerMode calls userRepository.setDeliberateTriggerMode", async () => {
    const triggerSpy = spyOn(userRepository, "setDeliberateTriggerMode").mockImplementation(async () => true);
    const result = await personalConfigOperations.setTriggerMode({
      userId: 1,
      userDiscId: "user-123",
      mode: "on",
    });
    expect(result).toEqual({ status: "success" });
    expect(triggerSpy).toHaveBeenCalledWith(1, "on");
    triggerSpy.mockRestore();
  });

  it("setToolMode calls userRepository.update", async () => {
    const updateSpy = spyOn(userRepository, "update").mockImplementation(async () => true);
    const result = await personalConfigOperations.setToolMode({
      userId: 1,
      userDiscId: "user-123",
      mode: "off",
    });
    expect(result).toEqual({ status: "success" });
    expect(updateSpy).toHaveBeenCalledWith(1, { personal_deliberate_tool_mode: "off" });
    updateSpy.mockRestore();
  });

  it("setImpersonationPrompt calls userRepository.setImpersonatePrompt", async () => {
    const impSpy = spyOn(userRepository, "setImpersonatePrompt").mockImplementation(async () => true);
    const result = await personalConfigOperations.setImpersonationPrompt({
      userId: 1,
      userDiscId: "user-123",
      prompt: "Act like a helpful cat",
    });
    expect(result).toEqual({ status: "success" });
    expect(impSpy).toHaveBeenCalledWith(1, "Act like a helpful cat");
    impSpy.mockRestore();
  });

  it("setSpotlight calls userRepository.replacePersonalSpotlight", async () => {
    const spotSpy = spyOn(userRepository, "replacePersonalSpotlight").mockImplementation(async () => {});
    const result = await personalConfigOperations.setSpotlight({
      serverId: 42,
      userId: 1,
      userDiscId: "user-123",
      channelId: "ch-100",
      personaIds: [1, 2],
      autoTriggerPersonaId: 1,
      expiresAt: null,
    });
    expect(result).toEqual({ status: "success" });
    expect(spotSpy).toHaveBeenCalledWith(42, 1, "ch-100", [1, 2], 1, null);
    spotSpy.mockRestore();
  });

  it("removeSpotlights calls userRepository.removePersonalSpotlight for each channel", async () => {
    const remSpy = spyOn(userRepository, "removePersonalSpotlight").mockImplementation(async () => true);
    const result = await personalConfigOperations.removeSpotlights({
      serverId: 42,
      userId: 1,
      userDiscId: "user-123",
      channelIds: ["ch-100", "ch-200"],
    });
    expect(result).toEqual({ status: "success", removedCount: 2 });
    expect(remSpy).toHaveBeenCalledTimes(2);
    remSpy.mockRestore();
  });
});

describe("personalConfigRoutes Advanced interactions and telemetry", () => {
  it("sets trigger mode and records telemetry", async () => {
    const calls: string[] = [];
    const { dependencies, telemetry } = makeDependencies(calls);
    const route = createPersonalConfigInteractionRoute(dependencies);
    const customId = buildPersonalConfigCustomId("trigger-mode-set", "en-US", "on");

    let deferred = false;
    const interaction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      customId,
      user: { id: "user-123", username: "tester", displayName: "Tester" },
      guildId: "guild-123",
      get deferred() {
        return deferred;
      },
      deferUpdate: async () => {
        deferred = true;
      },
      editReply: async () => {},
    } as unknown as ButtonInteraction;

    await route.execute({} as Client, interaction, requireRoute(customId));

    expect(calls).toContain("setTriggerMode:on");
    expect(telemetry).toContain("personal-config.personal.trigger-mode.set");
  });

  it("sets tool mode and records telemetry", async () => {
    const calls: string[] = [];
    const { dependencies, telemetry } = makeDependencies(calls);
    const route = createPersonalConfigInteractionRoute(dependencies);
    const customId = buildPersonalConfigCustomId("tool-mode-set", "en-US", "off");

    let deferred = false;
    const interaction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      customId,
      user: { id: "user-123", username: "tester", displayName: "Tester" },
      guildId: "guild-123",
      get deferred() {
        return deferred;
      },
      deferUpdate: async () => {
        deferred = true;
      },
      editReply: async () => {},
    } as unknown as ButtonInteraction;

    await route.execute({} as Client, interaction, requireRoute(customId));

    expect(calls).toContain("setToolMode:off");
    expect(telemetry).toContain("personal-config.personal.tool-mode.set");
  });

  it("opens impersonation modal with prefilled prompt", async () => {
    const calls: string[] = [];
    let openedModalPrompt: string | null = "unopened";
    const { dependencies } = makeDependencies(calls, {
      showImpersonationModal: async (_interaction, _locale, _nonce, currentPrompt) => {
        openedModalPrompt = currentPrompt;
      },
    });

    const route = createPersonalConfigInteractionRoute(dependencies);
    const customId = buildPersonalConfigCustomId("impersonation-open", "en-US");

    const interaction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      customId,
      user: { id: "user-123", username: "tester", displayName: "Tester" },
      guildId: "guild-123",
      deferred: false,
      replied: false,
    } as unknown as ButtonInteraction;

    await route.execute({} as Client, interaction, requireRoute(customId));

    expect(openedModalPrompt).toBeNull();
  });

  it("refuses blank impersonation submission with info receipt and no write", async () => {
    const calls: string[] = [];
    const { dependencies, telemetry } = makeDependencies(calls);
    const route = createPersonalConfigInteractionRoute(dependencies);
    const customId = buildPersonalConfigCustomId("impersonation-submit", "en-US", "nonce123456");

    let replyPayload: unknown;
    const interaction = {
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      customId,
      user: { id: "user-123", username: "tester", displayName: "Tester" },
      guildId: "guild-123",
      deferred: false,
      deferUpdate: async () => {},
      editReply: async (payload: unknown) => {
        replyPayload = payload;
      },
      fields: {
        getTextInputValue: () => "   ",
      },
    } as unknown as ModalSubmitInteraction;

    await route.execute({} as Client, interaction, requireRoute(customId));

    expect(calls.filter((c) => c.startsWith("setImpersonationPrompt"))).toHaveLength(0);
    expect(telemetry).not.toContain("personal-config.personal.impersonation.set");
    expect(JSON.stringify(replyPayload)).toContain("Prompt Required");
  });

  it("updates impersonation prompt and records telemetry", async () => {
    const calls: string[] = [];
    const { dependencies, telemetry } = makeDependencies(calls);
    const route = createPersonalConfigInteractionRoute(dependencies);
    const customId = buildPersonalConfigCustomId("impersonation-submit", "en-US", "nonce123456");

    const interaction = {
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      customId,
      user: { id: "user-123", username: "tester", displayName: "Tester" },
      guildId: "guild-123",
      deferred: false,
      deferUpdate: async () => {},
      editReply: async () => {},
      fields: {
        getTextInputValue: () => "Speak concisely",
      },
    } as unknown as ModalSubmitInteraction;

    await route.execute({} as Client, interaction, requireRoute(customId));

    expect(calls).toContain("setImpersonationPrompt:Speak concisely");
    expect(telemetry).toContain("personal-config.personal.impersonation.set");
  });

  it("clears impersonation prompt via confirmation and records telemetry", async () => {
    const calls: string[] = [];
    const { dependencies, user, telemetry } = makeDependencies(calls);
    user.impersonation_prompt = "Existing prompt";
    const route = createPersonalConfigInteractionRoute(dependencies);
    const customId = buildPersonalConfigCustomId("impersonation-clear-confirm", "en-US", "nonce123456");

    const interaction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      customId,
      user: { id: "user-123", username: "tester", displayName: "Tester" },
      guildId: "guild-123",
      deferred: false,
      deferUpdate: async () => {},
      editReply: async () => {},
    } as unknown as ButtonInteraction;

    await route.execute({} as Client, interaction, requireRoute(customId));

    expect(calls).toContain("setImpersonationPrompt:null");
    expect(telemetry).toContain("personal-config.personal.impersonation.set");
  });

  it("rejects spotlight actions in DM context cleanly", async () => {
    const calls: string[] = [];
    const { dependencies } = makeDependencies(calls, {
      resolveScope: async () => ({
        userId: 1,
        userDiscId: "user-123",
        guildId: null,
        workspaceId: "dm",
        internalServerId: null,
        user: makeUser(),
        resolvedNickname: "LiveUser",
        personas: [],
        readStatus: "fresh",
      }),
    });

    const route = createPersonalConfigInteractionRoute(dependencies);
    const customId = buildPersonalConfigCustomId("spotlight-set-open", "en-US");

    let replyPayload: unknown;
    const interaction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      customId,
      user: { id: "user-123", username: "tester", displayName: "Tester" },
      guildId: null,
      reply: async (payload: unknown) => {
        replyPayload = payload;
      },
    } as unknown as ButtonInteraction;

    await route.execute({} as Client, interaction, requireRoute(customId));

    expect(JSON.stringify(replyPayload)).toContain("Personal Spotlight is only available in a server.");
  });

  it("handles spotlight set review, auto-trigger, and confirm", async () => {
    const calls: string[] = [];
    const { dependencies, telemetry } = makeDependencies(calls);
    const route = createPersonalConfigInteractionRoute(dependencies);
    const customId = buildPersonalConfigCustomId(
      "spot-set-cf",
      "en-US",
      "123456789012345678",
      12,
      1,
      "1",
      "nonce123456",
    );

    const interaction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      customId,
      user: { id: "user-123", username: "tester", displayName: "Tester" },
      guildId: "guild-123",
      guild: { channels: { cache: makeChannelCache(["123456789012345678"]) } },
      deferred: false,
      deferUpdate: async () => {},
      editReply: async () => {},
    } as unknown as ButtonInteraction;

    await route.execute({} as Client, interaction, requireRoute(customId));

    expect(calls).toContain("setSpotlight:123456789012345678:1:1");
    expect(telemetry).toContain("personal-config.personal.spotlight.set");
  });

  it("performs no spotlight write when the confirmed channel is not a text channel in this guild", async () => {
    const calls: string[] = [];
    const { dependencies, telemetry } = makeDependencies(calls);
    const route = createPersonalConfigInteractionRoute(dependencies);
    const customId = buildPersonalConfigCustomId(
      "spot-set-cf",
      "en-US",
      "999999999999999999",
      12,
      1,
      "1",
      "nonce123456",
    );

    const interaction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      customId,
      user: { id: "user-123", username: "tester", displayName: "Tester" },
      guildId: "guild-123",
      // The confirmed snowflake belongs to no channel this guild can see.
      guild: { channels: { cache: makeChannelCache(["123456789012345678"]) } },
      deferred: false,
      deferUpdate: async () => {},
      editReply: async () => {},
    } as unknown as ButtonInteraction;

    await route.execute({} as Client, interaction, requireRoute(customId));

    expect(calls.some((entry) => entry.startsWith("setSpotlight:"))).toBe(false);
    expect(telemetry).not.toContain("personal-config.personal.spotlight.set");
  });

  it("removes only the presented range when the removal modal was opened past the first page", async () => {
    const calls: string[] = [];
    const activeSpotlights = Array.from({ length: 60 }, (_, index) => ({
      channelDiscId: String(100000000000000000n + BigInt(index)),
      personaIds: [1],
      autoTriggerPersonaId: null,
      expiresAt: null,
      userDiscId: "user-123",
    }));
    const { dependencies } = makeDependencies(calls, {
      loadActiveSpotlights: async () => activeSpotlights,
    });
    const route = createPersonalConfigInteractionRoute(dependencies);
    const customId = buildPersonalConfigCustomId("spotlight-remove-submit", "en-US", 50, "nonce123456");

    const interaction = {
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      customId,
      user: { id: "user-123", username: "tester", displayName: "Tester" },
      guildId: "guild-123",
      deferred: false,
      deferUpdate: async () => {},
      editReply: async () => {},
      fields: {},
      id: "modal-range-2",
    } as unknown as ModalSubmitInteraction;

    await route.execute({} as Client, interaction, requireRoute(customId));

    const removal = calls.find((entry) => entry.startsWith("removeSpotlights:"));
    expect(removal).toBeDefined();
    const removedIds = (removal ?? "").slice("removeSpotlights:".length).split(",");
    expect(removedIds).toEqual(activeSpotlights.slice(50).map((entry) => entry.channelDiscId));
    expect(removedIds).not.toContain(activeSpotlights[0].channelDiscId);
  });

  it("emits one persona option per lineage and never exceeds Discord's option cap", () => {
    // Naming preferences are lineage-keyed, so two personas can legitimately share a lineage.
    // Discord rejects a repeated option value outright with COMPONENT_OPTION_VALUE_DUPLICATED.
    const shared = [makePersona(1, 10, "Tomori"), makePersona(2, 10, "Tomori (alter)")];
    const many = Array.from({ length: 40 }, (_, index) => makePersona(100 + index, 200 + index, `P${index}`));

    const payload = buildPersonalConfigPanelPayload({
      locale: "en-US",
      category: "profile",
      page: "persona",
      user: makeUser(),
      resolvedNickname: "Tester",
      personas: [...shared, ...many],
      guildId: "guild-123",
      memoryCount: 0,
      stmCount: 0,
      readStatus: "fresh",
    });

    const json = JSON.stringify(payload);
    const optionValues = [...json.matchAll(/"customId":"personal-config:v1:persona-select[^"]*"/g)];
    expect(optionValues.length).toBe(1);

    const select = JSON.parse(json).components[0].components.find(
      (row: { components?: Array<{ customId?: string; options?: Array<{ value: string }> }> }) =>
        row.components?.[0]?.customId?.includes("persona-select"),
    ).components[0];

    const values: string[] = select.options.map((option: { value: string }) => option.value);
    expect(values.length).toBeLessThanOrEqual(25);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toContain("10");
  });

  it("renders both spotlight multi-selects as checkbox groups, never file uploads", () => {
    // RawDiscordComponent.type is a bare number, so TypeScript accepts any of them. Component type 19
    // is FileUpload and 22 is CheckboxGroup: picking 19 renders an upload box that submits no values,
    // which for the unchecked-means-remove modal means every presented row is treated as unchecked.
    const setModal = buildSpotlightSetModal("en-US", "nonce123456", [
      { id: 1, name: "Tomori", isAlter: false },
      { id: 2, name: "Sparrow", isAlter: true },
    ]);
    const removeModal = buildSpotlightRemoveModal(
      "en-US",
      "nonce123456",
      0,
      [
        {
          channelDiscId: "123456789012345678",
          personaIds: [1],
          autoTriggerPersonaId: null,
          expiresAt: null,
        },
      ] as unknown as Parameters<typeof buildSpotlightRemoveModal>[3],
      [{ id: 1, name: "Tomori", isAlter: false }],
      new Map([["123456789012345678", { name: "general" }]]),
    );

    for (const modal of [setModal, removeModal]) {
      const optionBearing = modal.components.filter((label) => label.component?.options !== undefined);
      expect(optionBearing.length).toBeGreaterThan(0);
      for (const label of optionBearing) {
        expect(label.component?.type).not.toBe(19);
      }
    }

    const personaGroups = setModal.components.filter((label) => label.component?.custom_id?.startsWith("personas_"));
    expect(personaGroups.length).toBeGreaterThan(0);
    for (const group of personaGroups) expect(group.component?.type).toBe(22);

    const removalGroups = removeModal.components.filter((label) =>
      label.component?.custom_id?.startsWith("spotlights_"),
    );
    expect(removalGroups.length).toBeGreaterThan(0);
    for (const group of removalGroups) expect(group.component?.type).toBe(22);
  });

  it("resolves every composed Response Modes locale key to real text", () => {
    // check-locales matches literal dot-notation strings only, so a key built from a template is
    // invisible to it and a missing half would render its own key to the user with every gate green.
    // Only `mode_` is still composed; the receipt handlers build it from the route's mode.
    for (const mode of ["off", "follow", "on"] as const) {
      const key = `commands.personal.config.mode_${mode}`;
      expect(localizer("en-US", key)).not.toBe(key);
    }
  });

  it("renders Response Modes with effect-first status, docs links, and parenthetical modes in guilds and DMs", () => {
    const payloadGuildOff = buildPersonalConfigPanelPayload({
      locale: "en-US",
      category: "advanced",
      page: "response-modes",
      user: makeUser({ personal_dtm: "follow", personal_deliberate_tool_mode: "follow" }),
      resolvedNickname: "Tester",
      personas: [],
      guildId: "guild-123",
      memoryCount: 0,
      stmCount: 0,
      readStatus: "fresh",
      serverTriggerBehavior: { deliberate_trigger_mode: false, deliberate_tool_mode: false },
    });
    const guildOffJson = JSON.stringify(payloadGuildOff);
    expect(guildOffJson).toContain(
      "**[Deliberate Trigger Mode](https://docs.tomoribot.app/en/features/chatting-personality/chatting-and-triggers/#deliberate-trigger-mode)**",
    );
    expect(guildOffJson).toContain(
      "**[Deliberate Tool Mode](https://docs.tomoribot.app/en/features/capabilities/tools-and-extensions/#deliberate-tool-mode)** (EXPERIMENTAL)",
    );
    expect(guildOffJson).toContain("> You can trigger me by saying my name\\n> (Follow Server, currently off here)");
    expect(guildOffJson).toContain("> All my tools are always available\\n> (Follow Server, currently off here)");
    // No double blank line before quote rows (C1)
    expect(guildOffJson).not.toContain("\\n\\n> You can trigger me");
    expect(guildOffJson).not.toContain("\\n\\n> All my tools");

    const payloadGuildOn = buildPersonalConfigPanelPayload({
      locale: "en-US",
      category: "advanced",
      page: "response-modes",
      user: makeUser({ personal_dtm: "follow", personal_deliberate_tool_mode: "follow" }),
      resolvedNickname: "Tester",
      personas: [],
      guildId: "guild-123",
      memoryCount: 0,
      stmCount: 0,
      readStatus: "fresh",
      serverTriggerBehavior: { deliberate_trigger_mode: true, deliberate_tool_mode: true },
    });
    const guildOnJson = JSON.stringify(payloadGuildOn);
    expect(guildOnJson).toContain(
      "> Only an @mention, a reply, or /respond reaches me\\n> (Follow Server, currently on here)",
    );
    expect(guildOnJson).toContain(
      "> My tools are only offered when the conversation calls for them\\n> (Follow Server, currently on here)",
    );

    const payloadUserOn = buildPersonalConfigPanelPayload({
      locale: "en-US",
      category: "advanced",
      page: "response-modes",
      user: makeUser({ personal_dtm: "on", personal_deliberate_tool_mode: "on" }),
      resolvedNickname: "Tester",
      personas: [],
      guildId: "guild-123",
      memoryCount: 0,
      stmCount: 0,
      readStatus: "fresh",
      serverTriggerBehavior: { deliberate_trigger_mode: false, deliberate_tool_mode: false },
    });
    const userOnJson = JSON.stringify(payloadUserOn);
    expect(userOnJson).toContain("> Only an @mention, a reply, or /respond reaches me\\n> (On)");
    expect(userOnJson).toContain("> My tools are only offered when the conversation calls for them\\n> (On)");

    const payloadDm = buildPersonalConfigPanelPayload({
      locale: "en-US",
      category: "advanced",
      page: "response-modes",
      user: makeUser({ personal_dtm: "follow", personal_deliberate_tool_mode: "follow" }),
      resolvedNickname: "Tester",
      personas: [],
      guildId: null,
      memoryCount: 0,
      stmCount: 0,
      readStatus: "fresh",
      serverTriggerBehavior: null,
    });
    const dmJson = JSON.stringify(payloadDm);
    expect(dmJson).toContain("> Deliberate Trigger Mode does not apply in direct messages\\n> (Follow Server)");
    expect(dmJson).toContain("> All my tools are always available\\n> (Follow Server)");
  });

  it("renders Profile General and Persona with section descriptions and precise fallback wording (never bare Inherited)", () => {
    const generalPayload = buildPersonalConfigPanelPayload({
      locale: "en-US",
      category: "profile",
      page: "general",
      user: makeUser({ prefix_override: null, suffix_override: null }),
      resolvedNickname: "Tester",
      personas: [],
      guildId: "guild-123",
      memoryCount: 0,
      stmCount: 0,
      readStatus: "fresh",
    });
    const generalJson = JSON.stringify(generalPayload);
    expect(generalJson).toContain("**Interface**\\nHow I talk to you and what time I think you are in");
    expect(generalJson).toContain("**Naming**\\nWhat I call you, across every server");
    expect(generalJson).toContain("**About You**\\nHow I refer to you when I talk about you");
    expect(generalJson).toContain("> Prefix: Persona default (unset)");
    expect(generalJson).toContain("> Suffix: Persona default (unset)");
    expect(generalJson).not.toContain("Inherited");

    const personaPayload = buildPersonalConfigPanelPayload({
      locale: "en-US",
      category: "profile",
      page: "persona",
      user: makeUser(),
      resolvedNickname: "Tester",
      personas: [makePersona(1, 10, "Tomori")],
      guildId: "guild-123",
      memoryCount: 0,
      stmCount: 0,
      readStatus: "fresh",
      personaNamingPreference: null,
    });
    const personaJson = JSON.stringify(personaPayload);
    expect(personaJson).toContain("> Nickname override: Global profile or persona default");
    expect(personaJson).toContain("> Prefix override: Global profile or persona default");
    expect(personaJson).toContain("> Suffix override: Global profile or persona default");
    expect(personaJson).not.toContain("Inherited");
  });

  it("renders Privacy with clean Your Data spacing and separated Cross-Server STM section", () => {
    const privacyPayload = buildPersonalConfigPanelPayload({
      locale: "en-US",
      category: "privacy",
      page: "privacy-controls",
      user: makeUser({ shortterm_cache_crossserver_opt_in: false }),
      resolvedNickname: "Tester",
      personas: [],
      guildId: "guild-123",
      memoryCount: 5,
      stmCount: 0,
      readStatus: "fresh",
    });
    const privacyJson = JSON.stringify(privacyPayload);
    // Section headers
    expect(privacyJson).toContain("**Your Data**");
    expect(privacyJson).toContain("**Cross-Server STM**");
    // Cross-server STM section footer
    expect(privacyJson).toContain("-# `/personal memories` always persist across servers, but not STM");
    // Button label
    expect(privacyJson).toContain("Enable Cross-Server Sharing");
  });

  it("renders Models switch page with Change Personal <Capability> Model select options while preserving routing_* labels", () => {
    const modelsPayload = buildPersonalConfigPanelPayload({
      locale: "en-US",
      category: "models",
      page: "switch",
      user: makeUser(),
      resolvedNickname: "Tester",
      personas: [],
      guildId: "guild-123",
      memoryCount: 0,
      stmCount: 0,
      readStatus: "fresh",
      modelDisplayInfo: {
        routingRows: {
          text: {
            capability: "text",
            activeModelName: "Claude 3.5 Sonnet",
            storedProvider: "openrouter",
            storedModelName: "Claude 3.5 Sonnet",
          },
          vision: { capability: "vision", activeModelName: null, storedProvider: null, storedModelName: null },
          embedding: { capability: "embedding", activeModelName: null, storedProvider: null, storedModelName: null },
          image: { capability: "image", activeModelName: null, storedProvider: null, storedModelName: null },
          image_nai: { capability: "image_nai", activeModelName: null, storedProvider: null, storedModelName: null },
          video: { capability: "video", activeModelName: null, storedProvider: null, storedModelName: null },
        },
        availableCapabilities: ["text", "vision", "embedding", "image", "image_nai", "video"],
        eligibleProvidersForCapability: {
          text: ["openrouter"],
          vision: [],
          embedding: [],
          image: [],
          image_nai: [],
          video: [],
        },
        parametersProviders: [],
        fallbacksProviders: [],
        primaryModelName: "Claude 3.5 Sonnet",
        fallbackSlots: [],
        randomizerEnabled: false,
        canEnableRandomizer: false,
      },
    });
    const modelsJson = JSON.stringify(modelsPayload);
    // Dropdown labels
    expect(modelsJson).toContain("Change Personal Text Model");
    expect(modelsJson).toContain("Change Personal Vision Model");
    expect(modelsJson).toContain("Change Personal Embedding Model");
    expect(modelsJson).toContain("Change Personal Standard Image Model");
    expect(modelsJson).toContain("Change Personal NovelAI Image Model");
    expect(modelsJson).toContain("Change Personal Video Model");
    // Status row labels still present
    expect(modelsJson).toContain("> Text: `Claude 3.5 Sonnet`");
    expect(modelsJson).toContain("> Vision: `Server Default`");
  });

  it("handles spotlight removal and records telemetry on success", async () => {
    const calls: string[] = [];
    const { dependencies, telemetry } = makeDependencies(calls, {
      loadActiveSpotlights: async () => [
        {
          channelDiscId: "123456789012345678",
          personaIds: [1],
          autoTriggerPersonaId: null,
          expiresAt: null,
          userDiscId: "user-123",
        },
      ],
    });
    const route = createPersonalConfigInteractionRoute(dependencies);
    const customId = buildPersonalConfigCustomId("spotlight-remove-submit", "en-US", 0, "nonce123456");

    const interaction = {
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      customId,
      user: { id: "user-123", username: "tester", displayName: "Tester" },
      guildId: "guild-123",
      deferred: false,
      deferUpdate: async () => {},
      editReply: async () => {},
      fields: {},
      id: "modal-1",
    } as unknown as ModalSubmitInteraction;

    // Unchecked item means it is removed
    await route.execute({} as Client, interaction, requireRoute(customId));

    expect(calls).toContain("removeSpotlights:123456789012345678");
    expect(telemetry).toContain("personal-config.personal.spotlight.remove");
  });
});
