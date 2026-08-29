import {
  ChannelType,
  ComponentType,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type InteractionEditReplyOptions,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import {
  PrivacyLevel,
  type UserRow,
  type TomoriState,
  type UserSavedProviderConfigRow,
  type UserSavedProviderConfigUpsert,
  type FallbackModelRef,
  type PersonalProviderCapability,
} from "@/types/db/schema";
import type { PersonalSpotlightStatus } from "@/utils/db/repositories/UserRepository";
import type { PanelReadStatus, PanelReceipt } from "@/types/discord/panel";
import type { UserPersonaNamingPreference } from "@/types/personaNaming";
import { getCachedAllPersonas, getCachedTomoriState } from "@/utils/cache/tomoriStateCache";
import {
  getCachedPersonalSpotlightStatus,
  invalidatePersonalSpotlightCache,
} from "@/utils/cache/personalSpotlightCache";
import { getShortTermMemoriesForUser, preWarmUserStmEntries } from "@/utils/cache/shortTermMemoryCache";
import { getCachedUserRow, invalidateUserCache } from "@/utils/cache/userCache";
import {
  llmModelRepo,
  llmProviderRepo,
  personaRepository,
  personalMemoryRepository,
  serverRepository,
  userNamingRepository,
  userRepository,
} from "@/utils/db/repositories";
import type { GlobalInteractionRoute, GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import { beginPanelInteraction, performPanelAction } from "@/utils/discord/interactions/panelController";
import { createNonce } from "@/utils/discord/panelRouteTokens";
import {
  PERSONAL_CONFIG_ROUTE_NAMESPACE,
  PERSONAL_CONFIG_ROUTE_VERSION,
  PERSONAL_FALLBACK_PAGE_SIZE,
  PERSONAL_MODEL_PAGE_SIZE,
  PERSONAL_PROVIDER_DIRECT_LIMIT,
  PERSONAL_PROVIDER_PAGE_SIZE,
  PERSONAL_PROVIDER_RANGE_VALUE,
  QUICK_TOGGLE_CAPABILITIES,
  SPOTLIGHT_AUTO_TRIGGER_PAGE_SIZE,
  SPOTLIGHT_PERSONA_PAGE_SIZE,
  SPOTLIGHT_REMOVE_PAGE_SIZE,
  computeSpotlightRemoveFingerprint,
  computeSpotlightSetFingerprint,
  decodeSpotlightMask,
  encodeSpotlightMask,
  decodeProviderParam,
  parsePersonalConfigPanelRoute,
  type PersonalConfigCategory,
  type PersonalConfigManagedCapability,
  type PersonalConfigPage,
} from "@/utils/discord/personalConfigPanelCatalog";
import {
  buildAboutModal,
  buildAppearanceModal,
  buildFallbacksModal,
  buildImpersonationModal,
  buildLanguageModal,
  buildModelSelectModal,
  buildNamingModal,
  buildParameters1Modal,
  buildParameters2Modal,
  buildPersonaNamingModal,
  buildPersonalConfigModalFieldId,
  buildPersonalConfigPanelPayload,
  buildPrivacyLevelModal,
  buildQuickToggleModal,
  buildSpotlightAutoTriggerModal,
  buildSpotlightRemoveModal,
  buildSpotlightSetModal,
  buildSpotlightStep1Modal,
  buildTimezoneModal,
  type PersonalConfigFallbackDisplaySlot,
  type PersonalConfigModelDisplayInfo,
  type PersonalConfigPanelView,
  ROUTING_CAPABILITY_LOCALE_KEYS,
  type PersonalConfigRoutingRow,
  type PersonalConfigSpotlightDisplayInfo,
} from "@/utils/discord/ui/personalConfigPanel";
import {
  showRoutedRawModal,
  takeRawModalCheckboxGroupValues,
  takeRawModalSelectValue,
} from "@/utils/discord/ui/modals";
import { buildPanelContainer } from "@/utils/discord/ui/panel";
import { MAX_TAG_LENGTH, MAX_TAGS, parseAndValidateImageTags } from "@/utils/image/tagHelpers";
import { log } from "@/utils/misc/logger";
import { recordPanelActionStat, type RecordPanelActionInput } from "@/utils/stats/panelActionMetrics";
import { formatUTCOffset } from "@/utils/text/timezoneHelper";
import { localizer } from "@/utils/text/localizer";
import {
  assignPersonalCapabilityToProvider,
  getActivePersonalProviderForCapability,
  getStoredPersonalProviderForCapability,
  hasConfiguredPersonalModel,
  setPersonalCapabilityEnabled,
  withPersonalTextPrimary,
} from "@/utils/provider/personalProviderHelpers";
import {
  buildFallbackModelPersistence,
  getFallbackModelRefKey,
  getPrimaryFallbackRefKeys,
} from "@/utils/provider/fallbackModelIdentity";
import { DEFAULT_THINKING_LEVEL, isThinkingLevelValue, type ThinkingLevelValue } from "@/constants/thinkingLevels";
import type { ModelParameterOptions } from "@/utils/discord/modelParametersConfigMapping";
import { getProviderDisplayName } from "@/utils/provider/providerInfoRegistry";
import {
  loadUserSavedProvidersForCapability,
  type SavedProviderCapability,
} from "@/utils/provider/savedProviderConfig";
import { isCustomProvider, parseCustomProvider } from "@/utils/provider/customProviderUtils";

interface PersonalConfigScope {
  userId: number;
  userDiscId: string;
  guildId: string | null;
  workspaceId: string;
  internalServerId: number | null;
  user: UserRow;
  resolvedNickname: string;
  personas: TomoriState[];
  readStatus: PanelReadStatus;
}

export interface PersonalConfigOperations {
  setLanguage(input: {
    userId: number;
    userDiscId: string;
    language: string;
  }): Promise<{ status: "success" } | { status: "invalid-value" | "write-failed" }>;
  setTimezone(input: {
    userId: number;
    userDiscId: string;
    offset: number | null;
  }): Promise<{ status: "success" } | { status: "invalid-value" | "write-failed" }>;
  setNaming(input: {
    userId: number;
    userDiscId: string;
    nickname: string | null;
    prefix: string | null;
    suffix: string | null;
  }): Promise<{ status: "success" } | { status: "write-failed" }>;
  setPersonaNaming(input: {
    userId: number;
    userDiscId: string;
    personaLineageId: number;
    nickname: string | null;
    prefix: string | null;
    suffix: string | null;
  }): Promise<{ status: "success" } | { status: "write-failed" }>;
  setAbout(input: {
    userId: number;
    userDiscId: string;
    genderIdentity: string | null;
    pronouns: string | null;
    addressingStyle: "masculine" | "feminine" | "neutral" | null;
  }): Promise<{ status: "success" } | { status: "write-failed" }>;
  setAppearance(input: {
    userId: number;
    userDiscId: string;
    rawTags: string;
  }): Promise<
    | { status: "success"; tags: string[] }
    | { status: "too-many-tags" | "tag-too-long" | "invalid-tags" | "write-failed" }
  >;
  setPrivacyLevel(input: {
    userId: number;
    userDiscId: string;
    level: PrivacyLevel;
  }): Promise<{ status: "success" } | { status: "invalid-value" | "write-failed" }>;
  toggleCrossServerStm(input: {
    userDiscId: string;
  }): Promise<{ status: "success"; enabled: boolean } | { status: "write-failed" }>;
  setCapabilityModel(input: {
    userId: number;
    userDiscId: string;
    capability: PersonalConfigManagedCapability;
    provider: string;
    modelId: number;
  }): Promise<{ status: "success" } | { status: "no-changes" | "write-failed" }>;
  setCapabilityEnabled(input: {
    userId: number;
    userDiscId: string;
    capability: PersonalProviderCapability;
    enabled: boolean;
  }): Promise<{ status: "success" } | { status: "no-changes" | "missing-model" | "write-failed" }>;
  setQuickToggleRouting(input: {
    userId: number;
    userDiscId: string;
    selectedCapabilities: Set<PersonalProviderCapability>;
  }): Promise<
    | { status: "success" }
    | { status: "no-changes" }
    | { status: "missing-model"; capability: PersonalProviderCapability }
    | { status: "write-failed" }
  >;
  setParameters(input: {
    userId: number;
    userDiscId: string;
    provider: string;
    patch: Partial<ModelParameterOptions>;
  }): Promise<{ status: "success" } | { status: "no-changes" | "invalid-value" | "not-found" | "write-failed" }>;
  setFallbacks(input: {
    userId: number;
    userDiscId: string;
    provider: string;
    slotValues: string[];
  }): Promise<
    | { status: "success"; fallbacks: FallbackModelRef[] }
    | { status: "no-changes" | "primary-conflict"; primaryModelName?: string }
    | { status: "not-found" | "write-failed" }
  >;
  setRandomizer(input: {
    userId: number;
    userDiscId: string;
    provider: string;
    enabled: boolean;
  }): Promise<
    | { status: "success"; enabled: boolean }
    | { status: "no-changes" }
    | { status: "requires-fallbacks" | "not-found" | "write-failed" }
  >;
  setTriggerMode(input: {
    userId: number;
    userDiscId: string;
    mode: "off" | "follow" | "on";
  }): Promise<{ status: "success" } | { status: "invalid-value" | "write-failed" }>;
  setToolMode(input: {
    userId: number;
    userDiscId: string;
    mode: "off" | "follow" | "on";
  }): Promise<{ status: "success" } | { status: "invalid-value" | "write-failed" }>;
  setImpersonationPrompt(input: {
    userId: number;
    userDiscId: string;
    prompt: string | null;
  }): Promise<{ status: "success" } | { status: "write-failed" }>;
  setSpotlight(input: {
    serverId: number;
    userId: number;
    userDiscId: string;
    channelId: string;
    personaIds: number[];
    autoTriggerPersonaId: number | null;
    expiresAt: Date | null;
  }): Promise<
    { status: "success" } | { status: "no-changes" | "no-personas" | "invalid-auto-trigger" | "write-failed" }
  >;
  removeSpotlights(input: {
    serverId: number;
    userId: number;
    userDiscId: string;
    channelIds: string[];
  }): Promise<
    | { status: "success"; removedCount: number }
    | { status: "no-changes" }
    | { status: "partial-failure"; removedCount: number; failedCount: number }
    | { status: "write-failed" }
  >;
}

export interface PersonalConfigRouteDependencies {
  resolveScope(
    interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
    forceRefresh?: boolean,
  ): Promise<PersonalConfigScope | null>;
  loadPersonaNamingPreference(userId: number, lineageId: number): Promise<UserPersonaNamingPreference | null>;
  getMemoryCount(userId: number): Promise<number>;
  getStmCount(userDiscId: string): Promise<number>;
  loadUserSavedProviders(userId: number): Promise<UserSavedProviderConfigRow[]>;
  loadPersonalModelDisplayInfo(
    userId: number,
    savedProviders: UserSavedProviderConfigRow[],
    selectedCap: PersonalConfigManagedCapability,
    selectedParamsProvider?: string,
    selectedFallbacksProvider?: string,
  ): Promise<PersonalConfigModelDisplayInfo>;
  loadAvailableModelsForCapability(
    userId: number,
    provider: string,
    capability: PersonalConfigManagedCapability,
  ): Promise<Array<{ id: number; name: string; description?: string }>>;
  loadActiveSpotlights(serverId: number, userId: number): Promise<PersonalSpotlightStatus[]>;
  loadGuildPersonas(guildId: string): Promise<Array<{ id: number; name: string; isAlter: boolean }>>;
  loadTomoriState(guildId: string): Promise<TomoriState | null>;
  loadServerTriggerBehavior(
    guildId: string,
  ): Promise<{ deliberate_trigger_mode: boolean; deliberate_tool_mode: boolean } | null>;
  operations: PersonalConfigOperations;
  recordAction(input: RecordPanelActionInput): void;
  createNonce(): string;
  showLanguageModal(
    interaction: ButtonInteraction,
    locale: string,
    nonce: string,
    currentLanguage: string,
  ): Promise<void>;
  showTimezoneModal(
    interaction: ButtonInteraction,
    locale: string,
    nonce: string,
    currentOffset: number | null,
  ): Promise<void>;
  showNamingModal(
    interaction: ButtonInteraction,
    locale: string,
    nonce: string,
    current: { nickname: string | null; prefix: string | null; suffix: string | null },
  ): Promise<void>;
  showPersonaNamingModal(
    interaction: ButtonInteraction,
    locale: string,
    lineageId: number,
    nonce: string,
    current: { nickname: string | null; prefix: string | null; suffix: string | null },
  ): Promise<void>;
  showAboutModal(
    interaction: ButtonInteraction,
    locale: string,
    nonce: string,
    current: { genderIdentity: string | null; pronouns: string | null; addressingStyle: string | null },
  ): Promise<void>;
  showAppearanceModal(
    interaction: ButtonInteraction,
    locale: string,
    nonce: string,
    currentTags: string[],
  ): Promise<void>;
  showPrivacyLevelModal(
    interaction: ButtonInteraction,
    locale: string,
    nonce: string,
    currentLevel: PrivacyLevel,
  ): Promise<void>;
  showQuickToggleModal(
    interaction: ButtonInteraction,
    locale: string,
    nonce: string,
    savedProviders: UserSavedProviderConfigRow[],
  ): Promise<void>;
  showModelSelectModal(
    interaction: StringSelectMenuInteraction | ButtonInteraction,
    locale: string,
    nonce: string,
    capability: PersonalConfigManagedCapability,
    provider: string,
    availableModels: Array<{ id: number; name: string; description?: string }>,
    currentModelId: number | null,
  ): Promise<void>;
  showParameters1Modal(
    interaction: ButtonInteraction,
    locale: string,
    nonce: string,
    provider: string,
    currentConfig: UserSavedProviderConfigRow | null,
  ): Promise<void>;
  showParameters2Modal(
    interaction: ButtonInteraction,
    locale: string,
    nonce: string,
    provider: string,
    currentConfig: UserSavedProviderConfigRow | null,
  ): Promise<void>;
  showFallbacksModal(
    // Reached from the Fallbacks provider select as well as the range chooser's buttons, and a
    // modal is a valid acknowledgement for either.
    interaction: ButtonInteraction | StringSelectMenuInteraction,
    locale: string,
    nonce: string,
    provider: string,
    availableOptions: Array<{ refKey: string; label: string }>,
    currentRefs: FallbackModelRef[],
  ): Promise<void>;
  showImpersonationModal(
    interaction: ButtonInteraction,
    locale: string,
    nonce: string,
    currentPrompt: string | null,
  ): Promise<void>;
  showSpotlightStep1Modal(interaction: ButtonInteraction, locale: string, nonce: string): Promise<void>;
  showSpotlightSetModal(
    interaction: ButtonInteraction,
    locale: string,
    nonce: string,
    channelId: string,
    hours: number,
    blockIdx: number,
    fp: string,
    personas: Array<{ id: number; name: string; isAlter: boolean }>,
  ): Promise<void>;
  showSpotlightAutoTriggerModal(
    interaction: ButtonInteraction,
    locale: string,
    nonce: string,
    channelId: string,
    hours: number,
    blockIdx: number,
    mask: string,
    fp: string,
    selectedPersonas: Array<{ id: number; name: string; isAlter: boolean }>,
  ): Promise<void>;
  showSpotlightRemoveModal(
    interaction: ButtonInteraction,
    locale: string,
    nonce: string,
    start: number,
    fp: string,
    activeSpotlights: PersonalSpotlightStatus[],
    personas: Array<{ id: number; name: string; isAlter: boolean }>,
    guildChannels: Map<string, { name: string }> | undefined,
  ): Promise<void>;
}

export const personalConfigOperations: PersonalConfigOperations = {
  async setLanguage({ userId, userDiscId, language }) {
    if (language !== "en-US" && language !== "ja") {
      return { status: "invalid-value" };
    }
    const ok = await userRepository.setLanguage(userId, language);
    if (!ok) return { status: "write-failed" };
    invalidateUserCache(userDiscId);
    return { status: "success" };
  },

  async setTimezone({ userId, userDiscId, offset }) {
    if (offset !== null) {
      if (Number.isNaN(offset) || offset < -12 || offset > 14) {
        return { status: "invalid-value" };
      }
    }
    const ok = await userRepository.setTimezoneOffset(userId, offset);
    if (!ok) return { status: "write-failed" };
    invalidateUserCache(userDiscId);
    return { status: "success" };
  },

  async setNaming({ userId, userDiscId, nickname, prefix, suffix }) {
    await userNamingRepository.applyUserInfoBatch(userId, {
      global: {
        user_nickname: nickname,
        prefix_override: prefix,
        suffix_override: suffix,
      },
    });
    invalidateUserCache(userDiscId);
    return { status: "success" };
  },

  async setPersonaNaming({ userId, userDiscId, personaLineageId, nickname, prefix, suffix }) {
    await userNamingRepository.applyUserInfoBatch(userId, {
      global: {},
      persona: {
        personaLineageId,
        patch: {
          nickname_override: nickname,
          prefix_override: prefix,
          suffix_override: suffix,
        },
      },
    });
    invalidateUserCache(userDiscId);
    return { status: "success" };
  },

  async setAbout({ userId, userDiscId, genderIdentity, pronouns, addressingStyle }) {
    await userNamingRepository.applyUserInfoBatch(userId, {
      global: {
        gender_identity: genderIdentity,
        pronouns,
        addressing_style: addressingStyle,
      },
    });
    invalidateUserCache(userDiscId);
    return { status: "success" };
  },

  async setAppearance({ userId, userDiscId: _userDiscId, rawTags }) {
    if (rawTags.trim().length === 0) {
      const ok = await userRepository.update(userId, { physical_appearance_tags: [] });
      if (!ok) return { status: "write-failed" };
      return { status: "success", tags: [] };
    }

    const validation = parseAndValidateImageTags(rawTags);
    if (!validation.isValid) {
      if (validation.reason === "too_many") return { status: "too-many-tags" };
      if (validation.reason === "tag_too_long") return { status: "tag-too-long" };
      return { status: "invalid-tags" };
    }

    const ok = await userRepository.update(userId, { physical_appearance_tags: validation.tags });
    if (!ok) return { status: "write-failed" };
    return { status: "success", tags: validation.tags };
  },

  async setPrivacyLevel({ userId: _userId, userDiscId, level }) {
    if (![PrivacyLevel.MINIMAL, PrivacyLevel.PARTIAL, PrivacyLevel.FULL].includes(level)) {
      return { status: "invalid-value" };
    }
    const updated = await userRepository.setPrivacyLevel(userDiscId, level);
    if (!updated) return { status: "write-failed" };
    return { status: "success" };
  },

  async toggleCrossServerStm({ userDiscId }) {
    try {
      const enabled = await userRepository.toggleCrossServerShmOptIn(userDiscId);
      return { status: "success", enabled };
    } catch {
      return { status: "write-failed" };
    }
  },

  async setCapabilityModel({ userId, userDiscId: _userDiscId, capability, provider, modelId }) {
    if (!Number.isInteger(modelId) || modelId <= 0) return { status: "write-failed" };

    const catalogCap: SavedProviderCapability = capability === "image_nai" ? "image" : capability;
    const eligibleRows = await loadUserSavedProvidersForCapability(userId, catalogCap);
    const targetRow = eligibleRows.find((row) => row.provider.toLowerCase() === provider.toLowerCase());
    if (!targetRow) return { status: "write-failed" };

    const availableModels = await loadAvailableModelsForCapability(userId, provider, capability);
    if (!availableModels.some((model) => model.id === modelId)) return { status: "write-failed" };

    const currentModelId =
      capability === "text"
        ? targetRow.llm_id
        : capability === "vision"
          ? targetRow.vision_llm_id
          : capability === "embedding"
            ? targetRow.embedding_model_id
            : capability === "image"
              ? targetRow.diffusion_model_id
              : capability === "image_nai"
                ? targetRow.nai_diffusion_model_id
                : targetRow.video_model_id;
    const activeRow = getActivePersonalProviderForCapability(eligibleRows, capability);
    if (currentModelId === modelId && activeRow?.provider.toLowerCase() === provider.toLowerCase()) {
      return { status: "no-changes" };
    }

    const endpoints = await llmProviderRepo.loadCustomEndpointsForUser(userId);

    const ok = await assignPersonalCapabilityToProvider(userId, provider, capability, (row) => {
      if (capability === "text") {
        return withPersonalTextPrimary(row, modelId, endpoints);
      }
      if (capability === "vision") {
        return { ...row, vision_llm_id: modelId };
      }
      if (capability === "embedding") {
        return { ...row, embedding_model_id: modelId };
      }
      if (capability === "image") {
        return { ...row, diffusion_model_id: modelId };
      }
      if (capability === "image_nai") {
        return { ...row, nai_diffusion_model_id: modelId };
      }
      if (capability === "video") {
        return { ...row, video_model_id: modelId };
      }
      return row;
    });

    if (!ok) return { status: "write-failed" };
    return { status: "success" };
  },

  async setCapabilityEnabled({ userId, userDiscId: _userDiscId, capability, enabled }) {
    const rows = await llmProviderRepo.loadUserSavedProviderConfigs(userId);
    const currentlyEnabled = getActivePersonalProviderForCapability(rows, capability) !== null;
    if (currentlyEnabled === enabled) return { status: "no-changes" };

    if (enabled) {
      const target = getStoredPersonalProviderForCapability(rows, capability);
      if (!target || !hasConfiguredPersonalModel(target, capability)) {
        return { status: "missing-model" };
      }
    }

    const ok = await setPersonalCapabilityEnabled(userId, capability, enabled);
    if (!ok) return { status: "write-failed" };
    return { status: "success" };
  },

  async setQuickToggleRouting({ userId, userDiscId: _userDiscId, selectedCapabilities }) {
    const rows = await llmProviderRepo.loadUserSavedProviderConfigs(userId);
    for (const cap of selectedCapabilities) {
      const target = getStoredPersonalProviderForCapability(rows, cap);
      if (!target || !hasConfiguredPersonalModel(target, cap)) {
        return { status: "missing-model", capability: cap };
      }
    }

    const hasChange = QUICK_TOGGLE_CAPABILITIES.some(
      (cap) => (getActivePersonalProviderForCapability(rows, cap) !== null) !== selectedCapabilities.has(cap),
    );
    if (!hasChange) return { status: "no-changes" };

    let allWritesSucceeded = true;
    for (const cap of QUICK_TOGGLE_CAPABILITIES) {
      const ok = await setPersonalCapabilityEnabled(userId, cap, selectedCapabilities.has(cap));
      allWritesSucceeded &&= ok;
    }
    return allWritesSucceeded ? { status: "success" } : { status: "write-failed" };
  },

  async setParameters({ userId, userDiscId: _userDiscId, provider, patch }) {
    const eligibleRows = await loadUserSavedProvidersForCapability(userId, "text");
    if (!eligibleRows.some((row) => row.provider.toLowerCase() === provider.toLowerCase())) {
      return { status: "not-found" };
    }
    const savedConfig = await llmProviderRepo.loadUserSavedProviderConfig(userId, provider);
    if (!savedConfig) return { status: "not-found" };

    if (
      patch.temperature !== undefined &&
      patch.temperature !== null &&
      (Number.isNaN(patch.temperature) || patch.temperature < 0 || patch.temperature > 2)
    ) {
      return { status: "invalid-value" };
    }
    if (
      patch.top_p !== undefined &&
      patch.top_p !== null &&
      (Number.isNaN(patch.top_p) || patch.top_p < 0 || patch.top_p > 1)
    ) {
      return { status: "invalid-value" };
    }
    if (
      patch.top_k !== undefined &&
      patch.top_k !== null &&
      (Number.isNaN(patch.top_k) || patch.top_k < 0 || patch.top_k > 256 || !Number.isInteger(patch.top_k))
    ) {
      return { status: "invalid-value" };
    }
    if (
      patch.frequency_penalty !== undefined &&
      patch.frequency_penalty !== null &&
      (Number.isNaN(patch.frequency_penalty) || patch.frequency_penalty < -2 || patch.frequency_penalty > 2)
    ) {
      return { status: "invalid-value" };
    }
    if (
      patch.presence_penalty !== undefined &&
      patch.presence_penalty !== null &&
      (Number.isNaN(patch.presence_penalty) || patch.presence_penalty < -2 || patch.presence_penalty > 2)
    ) {
      return { status: "invalid-value" };
    }
    if (
      patch.min_p !== undefined &&
      patch.min_p !== null &&
      (Number.isNaN(patch.min_p) || patch.min_p < 0 || patch.min_p > 1)
    ) {
      return { status: "invalid-value" };
    }
    if (
      patch.max_output_tokens !== undefined &&
      patch.max_output_tokens !== null &&
      (Number.isNaN(patch.max_output_tokens) ||
        patch.max_output_tokens < 1 ||
        patch.max_output_tokens > 131072 ||
        !Number.isInteger(patch.max_output_tokens))
    ) {
      return { status: "invalid-value" };
    }
    if (
      patch.thinking_level !== undefined &&
      patch.thinking_level !== null &&
      !isThinkingLevelValue(patch.thinking_level)
    ) {
      return { status: "invalid-value" };
    }

    const updatedConfig: UserSavedProviderConfigUpsert = {
      ...savedConfig,
      llm_temperature: patch.temperature !== undefined ? patch.temperature : savedConfig.llm_temperature,
      llm_top_p: patch.top_p !== undefined ? patch.top_p : savedConfig.llm_top_p,
      llm_top_k: patch.top_k !== undefined ? patch.top_k : savedConfig.llm_top_k,
      llm_frequency_penalty:
        patch.frequency_penalty !== undefined ? patch.frequency_penalty : savedConfig.llm_frequency_penalty,
      llm_presence_penalty:
        patch.presence_penalty !== undefined ? patch.presence_penalty : savedConfig.llm_presence_penalty,
      llm_min_p: patch.min_p !== undefined ? patch.min_p : savedConfig.llm_min_p,
      llm_max_output_tokens:
        patch.max_output_tokens !== undefined ? patch.max_output_tokens : savedConfig.llm_max_output_tokens,
      thinking_level: patch.thinking_level ?? savedConfig.thinking_level ?? DEFAULT_THINKING_LEVEL,
    };

    const noChange =
      updatedConfig.llm_temperature === savedConfig.llm_temperature &&
      updatedConfig.llm_top_p === savedConfig.llm_top_p &&
      updatedConfig.llm_top_k === savedConfig.llm_top_k &&
      updatedConfig.llm_frequency_penalty === savedConfig.llm_frequency_penalty &&
      updatedConfig.llm_presence_penalty === savedConfig.llm_presence_penalty &&
      updatedConfig.llm_min_p === savedConfig.llm_min_p &&
      updatedConfig.llm_max_output_tokens === savedConfig.llm_max_output_tokens &&
      updatedConfig.thinking_level === savedConfig.thinking_level;

    if (noChange) return { status: "no-changes" };

    const ok = await llmProviderRepo.upsertUserSavedProviderConfig(userId, updatedConfig);
    if (!ok) return { status: "write-failed" };
    return { status: "success" };
  },

  async setFallbacks({ userId, userDiscId: _userDiscId, provider, slotValues }) {
    const eligibleRows = await loadUserSavedProvidersForCapability(userId, "text");
    if (!eligibleRows.some((row) => row.provider.toLowerCase() === provider.toLowerCase())) {
      return { status: "not-found" };
    }
    const savedConfig = await llmProviderRepo.loadUserSavedProviderConfig(userId, provider);
    if (!savedConfig) return { status: "not-found" };

    const endpoints = await llmProviderRepo.loadCustomEndpointsForUser(userId);
    const customProvider = parseCustomProvider(provider);
    const availableModels = isCustomProvider(provider)
      ? []
      : ((await llmModelRepo.loadAvailableModelsForProvider(provider, false, {
          kind: "personal",
          ownerId: userId,
        })) ?? []);
    const selectableEndpoints = customProvider
      ? endpoints.filter(
          (endpoint) => endpoint.connection_id === customProvider.connectionId && endpoint.capability === "text",
        )
      : [];
    const primaryKeys = getPrimaryFallbackRefKeys(savedConfig.llm_id, endpoints);

    const existingRefs = savedConfig.fallback_model_refs ?? [];
    const submittedKeys = new Set<string>();
    const mergedRefs: FallbackModelRef[] = [];

    for (let i = 0; i < 5; i++) {
      const val = (slotValues[i] ?? "").trim();
      if (val === "") {
        if (existingRefs[i]) mergedRefs.push(existingRefs[i]);
      } else if (val === "__none__") {
        // clear
      } else if (val.startsWith("custom_endpoint:") || val.startsWith("ce:")) {
        const id = Number(val.replace(/^(custom_endpoint:|ce:)/, ""));
        const ep = selectableEndpoints.find((endpoint) => endpoint.custom_endpoint_id === id);
        if (!ep) return { status: "write-failed" };
        mergedRefs.push({ type: "custom_endpoint", id });
        submittedKeys.add(`custom_endpoint:${id}`);
      } else if (val.startsWith("llm:") || /^\d+$/.test(val)) {
        const id = val.startsWith("llm:") ? Number(val.slice("llm:".length)) : Number(val);
        const m = availableModels.find((model) => model.llm_id === id);
        if (!m || m.llm_id === undefined || m.llm_codename === "other-model") return { status: "write-failed" };
        mergedRefs.push({ type: "llm", id: m.llm_id });
        submittedKeys.add(`llm:${m.llm_id}`);
      } else {
        const m = availableModels.find((model) => model.llm_codename === val);
        if (!m || m.llm_id === undefined || m.llm_codename === "other-model") return { status: "write-failed" };
        mergedRefs.push({ type: "llm", id: m.llm_id });
        submittedKeys.add(`llm:${m.llm_id}`);
      }
    }

    const seen = new Set<string>();
    const dedupedRefs: FallbackModelRef[] = [];
    for (const ref of mergedRefs) {
      const key = getFallbackModelRefKey(ref);
      if (!seen.has(key)) {
        seen.add(key);
        dedupedRefs.push(ref);
      }
    }

    if ([...submittedKeys].some((key) => primaryKeys.has(key))) {
      let primaryModelName: string | undefined;
      if (savedConfig.llm_id) {
        const primaryLlm = await llmModelRepo.loadById(savedConfig.llm_id);
        primaryModelName = primaryLlm?.llm_codename;
      }
      return { status: "primary-conflict", primaryModelName };
    }

    const finalRefs = dedupedRefs.filter((ref) => !primaryKeys.has(getFallbackModelRefKey(ref)));

    const currentKeys = (savedConfig.fallback_model_refs ?? []).map(getFallbackModelRefKey).join(",");
    const newKeys = finalRefs.map(getFallbackModelRefKey).join(",");
    if (currentKeys === newKeys) {
      return { status: "no-changes" };
    }

    const { fallbackModelRefs } = buildFallbackModelPersistence(finalRefs, savedConfig.llm_id, endpoints);
    const updatedConfig: UserSavedProviderConfigUpsert = {
      ...savedConfig,
      fallback_model_refs: fallbackModelRefs,
    };

    const ok = await llmProviderRepo.upsertUserSavedProviderConfig(userId, updatedConfig);
    if (!ok) return { status: "write-failed" };
    return { status: "success", fallbacks: fallbackModelRefs };
  },

  async setRandomizer({ userId, userDiscId: _userDiscId, provider, enabled }) {
    const eligibleRows = await loadUserSavedProvidersForCapability(userId, "text");
    if (!eligibleRows.some((row) => row.provider.toLowerCase() === provider.toLowerCase())) {
      return { status: "not-found" };
    }
    const savedConfig = await llmProviderRepo.loadUserSavedProviderConfig(userId, provider);
    if (!savedConfig) return { status: "not-found" };
    if (Boolean(savedConfig.model_randomizer_enabled) === enabled) return { status: "no-changes" };

    if (enabled) {
      const fallbackCount = savedConfig.fallback_model_refs?.length ?? 0;
      if (fallbackCount === 0) {
        return { status: "requires-fallbacks" };
      }
    }

    const ok = await llmProviderRepo.updatePersonalModelRandomizer(userId, provider, enabled);
    if (!ok) return { status: "write-failed" };
    return { status: "success", enabled };
  },

  async setTriggerMode({ userId, userDiscId, mode }) {
    if (mode !== "off" && mode !== "follow" && mode !== "on") {
      return { status: "invalid-value" };
    }
    const ok = await userRepository.setDeliberateTriggerMode(userId, mode);
    if (!ok) return { status: "write-failed" };
    invalidateUserCache(userDiscId);
    return { status: "success" };
  },

  async setToolMode({ userId, userDiscId: _userDiscId, mode }) {
    if (mode !== "off" && mode !== "follow" && mode !== "on") {
      return { status: "invalid-value" };
    }
    const updated = await userRepository.update(userId, {
      personal_deliberate_tool_mode: mode,
    });
    if (!updated) return { status: "write-failed" };
    return { status: "success" };
  },

  async setImpersonationPrompt({ userId, userDiscId, prompt }) {
    const ok = await userRepository.setImpersonatePrompt(userId, prompt);
    if (!ok) return { status: "write-failed" };
    invalidateUserCache(userDiscId);
    return { status: "success" };
  },

  async setSpotlight({
    serverId,
    userId,
    userDiscId: _userDiscId,
    channelId,
    personaIds,
    autoTriggerPersonaId,
    expiresAt,
  }) {
    if (personaIds.length === 0) return { status: "no-personas" };
    if (autoTriggerPersonaId !== null && !personaIds.includes(autoTriggerPersonaId)) {
      return { status: "invalid-auto-trigger" };
    }
    if (expiresAt === null) {
      const current = await getCachedPersonalSpotlightStatus(serverId, userId, channelId);
      if (
        current &&
        current.expiresAt === null &&
        current.autoTriggerPersonaId === autoTriggerPersonaId &&
        current.personaIds.length === personaIds.length &&
        current.personaIds.every((id, idx) => id === personaIds[idx])
      ) {
        return { status: "no-changes" };
      }
    }
    try {
      await userRepository.replacePersonalSpotlight(
        serverId,
        userId,
        channelId,
        personaIds,
        autoTriggerPersonaId,
        expiresAt,
      );
      invalidatePersonalSpotlightCache(serverId, userId, channelId);
      return { status: "success" };
    } catch (error) {
      log.error("Failed to replace personal spotlight", error as Error);
      return { status: "write-failed" };
    }
  },

  async removeSpotlights({ serverId, userId, userDiscId: _userDiscId, channelIds }) {
    if (channelIds.length === 0) return { status: "no-changes" };
    let removedCount = 0;
    let failedCount = 0;
    for (const channelId of channelIds) {
      try {
        const ok = await userRepository.removePersonalSpotlight(serverId, userId, channelId);
        if (ok) {
          removedCount++;
          invalidatePersonalSpotlightCache(serverId, userId, channelId);
        } else {
          failedCount++;
        }
      } catch (error) {
        failedCount++;
        log.error("Failed to remove personal spotlight", error as Error);
      }
    }
    if (failedCount === 0 && removedCount > 0) {
      return { status: "success", removedCount };
    }
    if (removedCount > 0 && failedCount > 0) {
      return { status: "partial-failure", removedCount, failedCount };
    }
    return { status: "write-failed" };
  },
};

function terminalPayload(locale: string, key: string): InteractionEditReplyOptions {
  return {
    components: [
      buildPanelContainer([
        {
          type: ComponentType.TextDisplay,
          content: localizer(locale, key),
        },
      ]),
    ],
    flags: MessageFlags.IsComponentsV2,
  };
}

function noChangesReceipt(locale: string): PanelReceipt {
  return {
    tone: "info",
    heading: localizer(locale, "commands.personal.config.no_changes_heading"),
    detail: localizer(locale, "commands.personal.config.no_changes_detail"),
  };
}

async function resolveScope(
  interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
  _forceRefresh = false,
): Promise<PersonalConfigScope | null> {
  const userDiscId = interaction.user.id;
  try {
    const userRow = await getCachedUserRow(userDiscId);
    const registeredUser = userRow ?? (await userRepository.register(userDiscId, interaction.user.username));
    if (!registeredUser?.user_id) return null;

    const workspaceId = interaction.guildId ?? interaction.user.id;
    const internalServerId = await serverRepository.loadServerIdByDiscId(workspaceId);

    let personas: TomoriState[] = [];
    try {
      const allPersonas = await personaRepository.loadAllForServer(workspaceId);
      personas = allPersonas.filter(
        (p) => p.persona_lineage_id !== undefined && p.persona_lineage_id !== null && p.persona_lineage_id !== 0,
      );
    } catch (error) {
      log.warn("Failed to load personas for personal config scope", { workspaceId, error });
    }

    const memberDisplayName =
      interaction.member && "displayName" in interaction.member && typeof interaction.member.displayName === "string"
        ? interaction.member.displayName
        : undefined;
    const liveDisplayName = memberDisplayName ?? interaction.user.displayName ?? interaction.user.username;
    const resolvedNickname = registeredUser.user_nickname ?? liveDisplayName;

    return {
      userId: registeredUser.user_id,
      userDiscId,
      guildId: interaction.guildId ?? null,
      workspaceId,
      internalServerId: internalServerId ?? null,
      user: registeredUser,
      resolvedNickname,
      personas,
      readStatus: "fresh",
    };
  } catch (error) {
    log.error("Failed to resolve scope for personal config", error);
    return null;
  }
}

async function loadPersonaNamingPreference(
  userId: number,
  lineageId: number,
): Promise<UserPersonaNamingPreference | null> {
  const prefs = await userNamingRepository.loadPreferences([{ userId, personaLineageId: lineageId }]);
  return prefs.get(`${userId}:${lineageId}`) ?? null;
}

async function getMemoryCount(userId: number): Promise<number> {
  return personalMemoryRepository.countAllForUser(userId);
}

async function getStmCount(userDiscId: string): Promise<number> {
  await preWarmUserStmEntries(userDiscId);
  return getShortTermMemoriesForUser(userDiscId).length;
}

async function loadUserSavedProviders(userId: number): Promise<UserSavedProviderConfigRow[]> {
  return llmProviderRepo.loadUserSavedProviderConfigs(userId);
}

async function loadAvailableModelsForCapability(
  userId: number,
  provider: string,
  capability: PersonalConfigManagedCapability,
): Promise<Array<{ id: number; name: string; description?: string }>> {
  try {
    if (capability === "text") {
      const models = await llmModelRepo.loadAvailableModelsForProvider(provider, false, {
        kind: "personal",
        ownerId: userId,
      });
      return (models ?? [])
        .filter((m) => typeof m.llm_id === "number")
        .map((m) => ({ id: m.llm_id as number, name: m.llm_codename, description: m.llm_description ?? undefined }));
    }
    if (capability === "vision") {
      const models = await llmModelRepo.loadAvailableModelsForProvider(provider, false, {
        kind: "personal",
        ownerId: userId,
      });
      return (models ?? [])
        .filter((m) => typeof m.llm_id === "number" && m.sees_images)
        .map((m) => ({ id: m.llm_id as number, name: m.llm_codename, description: m.llm_description ?? undefined }));
    }
    if (capability === "embedding") {
      const models = await llmModelRepo.loadAvailableEmbeddingModels(provider, false, {
        kind: "personal",
        ownerId: userId,
      });
      return (models ?? [])
        .filter((m) => typeof m.embedding_model_id === "number")
        .map((m) => ({
          id: m.embedding_model_id as number,
          name: m.codename,
          description: m.model_description ?? undefined,
        }));
    }
    if (capability === "image") {
      const models = await llmModelRepo.loadAvailableDiffusionModels(provider, false, {
        kind: "personal",
        ownerId: userId,
      });
      return (models ?? [])
        .filter((m) => typeof m.diffusion_model_id === "number" && m.provider !== "novelai")
        .map((m) => ({
          id: m.diffusion_model_id as number,
          name: m.codename,
          description: m.model_description ?? undefined,
        }));
    }
    if (capability === "image_nai") {
      const models = await llmModelRepo.loadAvailableDiffusionModels(provider, false, {
        kind: "personal",
        ownerId: userId,
      });
      return (models ?? [])
        .filter((m) => typeof m.diffusion_model_id === "number" && m.provider === "novelai")
        .map((m) => ({
          id: m.diffusion_model_id as number,
          name: m.codename,
          description: m.model_description ?? undefined,
        }));
    }
    if (capability === "video") {
      const models = await llmModelRepo.loadAvailableVideoGenerationModels(provider, false, {
        kind: "personal",
        ownerId: userId,
      });
      return (models ?? [])
        .filter((m) => typeof m.video_model_id === "number")
        .map((m) => ({
          id: m.video_model_id as number,
          name: m.codename,
          description: m.model_description ?? undefined,
        }));
    }
  } catch (error) {
    log.warn("Failed to load available models for capability", { provider, capability, error });
  }
  return [];
}

async function loadFallbackSelectionOptions(
  userId: number,
  provider: string,
): Promise<Array<{ refKey: string; label: string }>> {
  const customProvider = parseCustomProvider(provider);
  if (customProvider) {
    const endpoints = await llmProviderRepo.loadCustomEndpointsForUser(userId);
    return endpoints
      .filter(
        (endpoint) =>
          endpoint.connection_id === customProvider.connectionId &&
          endpoint.capability === "text" &&
          typeof endpoint.custom_endpoint_id === "number",
      )
      .map((endpoint) => ({
        refKey: `custom_endpoint:${endpoint.custom_endpoint_id}`,
        label: endpoint.model_name ?? endpoint.label,
      }));
  }

  const models =
    (await llmModelRepo.loadAvailableModelsForProvider(provider, false, {
      kind: "personal",
      ownerId: userId,
    })) ?? [];
  return models
    .filter((model) => typeof model.llm_id === "number" && model.llm_codename !== "other-model")
    .map((model) => ({ refKey: `llm:${model.llm_id}`, label: model.llm_codename }));
}

async function loadPersonalModelDisplayInfo(
  userId: number,
  savedProviders: UserSavedProviderConfigRow[],
  _selectedCap: PersonalConfigManagedCapability = "text",
  selectedParamsProvider?: string,
  selectedFallbacksProvider?: string,
): Promise<PersonalConfigModelDisplayInfo> {
  const resolveCapName = async (
    row: UserSavedProviderConfigRow | null | undefined,
    cap: PersonalConfigManagedCapability,
  ): Promise<string | null> => {
    if (!row) return null;
    let modelName: string | null = null;
    try {
      if (cap === "text" && row.llm_id) {
        const m = await llmModelRepo.loadById(row.llm_id);
        modelName = m?.llm_codename ?? null;
      } else if (cap === "vision" && row.vision_llm_id) {
        const m = await llmModelRepo.loadById(row.vision_llm_id);
        modelName = m?.llm_codename ?? null;
      } else if (cap === "embedding" && row.embedding_model_id) {
        const m = await llmModelRepo.loadEmbeddingModelById(row.embedding_model_id);
        modelName = m?.codename ?? null;
      } else if (cap === "image" && row.diffusion_model_id) {
        const m = await llmModelRepo.loadDiffusionModelById(row.diffusion_model_id);
        modelName = m?.codename ?? null;
      } else if (cap === "image_nai" && row.nai_diffusion_model_id) {
        const m = await llmModelRepo.loadDiffusionModelById(row.nai_diffusion_model_id);
        modelName = m?.codename ?? null;
      } else if (cap === "video" && row.video_model_id) {
        const m = await llmModelRepo.loadVideoGenerationModelById(row.video_model_id);
        modelName = m?.codename ?? null;
      }
    } catch {
      modelName = null;
    }
    return modelName;
  };

  const textActive = getActivePersonalProviderForCapability(savedProviders, "text");
  const visionActive = getActivePersonalProviderForCapability(savedProviders, "vision");
  const embeddingActive = getActivePersonalProviderForCapability(savedProviders, "embedding");
  const imageActive = getActivePersonalProviderForCapability(savedProviders, "image");
  const imageNaiActive = getActivePersonalProviderForCapability(savedProviders, "image_nai");
  const videoActive = getActivePersonalProviderForCapability(savedProviders, "video");

  const textStored = getStoredPersonalProviderForCapability(savedProviders, "text");
  const visionStored = getStoredPersonalProviderForCapability(savedProviders, "vision");
  const embeddingStored = getStoredPersonalProviderForCapability(savedProviders, "embedding");
  const imageStored = getStoredPersonalProviderForCapability(savedProviders, "image");
  const imageNaiStored = getStoredPersonalProviderForCapability(savedProviders, "image_nai");
  const videoStored = getStoredPersonalProviderForCapability(savedProviders, "video");

  const [
    activeTextName,
    activeVisionName,
    activeEmbeddingName,
    activeImageName,
    activeImageNaiName,
    activeVideoName,
    storedTextName,
    storedVisionName,
    storedEmbeddingName,
    storedImageName,
    storedImageNaiName,
    storedVideoName,
  ] = await Promise.all([
    resolveCapName(textActive, "text"),
    resolveCapName(visionActive, "vision"),
    resolveCapName(embeddingActive, "embedding"),
    resolveCapName(imageActive, "image"),
    resolveCapName(imageNaiActive, "image_nai"),
    resolveCapName(videoActive, "video"),
    resolveCapName(textStored, "text"),
    resolveCapName(visionStored, "vision"),
    resolveCapName(embeddingStored, "embedding"),
    resolveCapName(imageStored, "image"),
    resolveCapName(imageNaiStored, "image_nai"),
    resolveCapName(videoStored, "video"),
  ]);

  const routingRows: Record<PersonalConfigManagedCapability, PersonalConfigRoutingRow> = {
    text: {
      capability: "text",
      activeModelName: activeTextName,
      storedProvider: textStored?.provider ?? null,
      storedModelName: storedTextName,
    },
    vision: {
      capability: "vision",
      activeModelName: activeVisionName,
      storedProvider: visionStored?.provider ?? null,
      storedModelName: storedVisionName,
    },
    embedding: {
      capability: "embedding",
      activeModelName: activeEmbeddingName,
      storedProvider: embeddingStored?.provider ?? null,
      storedModelName: storedEmbeddingName,
    },
    image: {
      capability: "image",
      activeModelName: activeImageName,
      storedProvider: imageStored?.provider ?? null,
      storedModelName: storedImageName,
    },
    image_nai: {
      capability: "image_nai",
      activeModelName: activeImageNaiName,
      storedProvider: imageNaiStored?.provider ?? null,
      storedModelName: storedImageNaiName,
    },
    video: {
      capability: "video",
      activeModelName: activeVideoName,
      storedProvider: videoStored?.provider ?? null,
      storedModelName: storedVideoName,
    },
  };

  const [textProviders, visionProviders, embeddingProviders, imageProviders, videoProviders] = await Promise.all([
    loadUserSavedProvidersForCapability(userId, "text"),
    loadUserSavedProvidersForCapability(userId, "vision"),
    loadUserSavedProvidersForCapability(userId, "embedding"),
    loadUserSavedProvidersForCapability(userId, "image"),
    loadUserSavedProvidersForCapability(userId, "video"),
  ]);

  const eligibleProvidersForCapability: Record<PersonalConfigManagedCapability, string[]> = {
    text: textProviders.map((p) => p.provider),
    vision: visionProviders.map((p) => p.provider),
    embedding: embeddingProviders.map((p) => p.provider),
    image: imageProviders.map((p) => p.provider),
    image_nai: imageProviders.map((p) => p.provider),
    video: videoProviders.map((p) => p.provider),
  };

  const textProviderRows = savedProviders.filter(
    (p) => textProviders.some((tp) => tp.provider === p.provider) || p.llm_id !== null,
  );
  const textProviderNames = textProviderRows.map((p) => p.provider);

  const activeParamsProvider =
    selectedParamsProvider ?? textActive?.provider ?? textStored?.provider ?? textProviderNames[0];
  const selectedParametersConfig = savedProviders.find(
    (p) => p.provider.toLowerCase() === activeParamsProvider?.toLowerCase(),
  );

  const activeFallbacksProvider =
    selectedFallbacksProvider ?? textActive?.provider ?? textStored?.provider ?? textProviderNames[0];
  const selectedFallbacksConfig = savedProviders.find(
    (p) => p.provider.toLowerCase() === activeFallbacksProvider?.toLowerCase(),
  );

  let primaryModelName: string | null = null;
  if (selectedFallbacksConfig?.llm_id) {
    try {
      const primary = await llmModelRepo.loadById(selectedFallbacksConfig.llm_id);
      primaryModelName = primary?.llm_codename ?? null;
    } catch {
      primaryModelName = null;
    }
  }

  const fallbackRefs = selectedFallbacksConfig?.fallback_model_refs ?? [];
  const fallbackSlots: PersonalConfigFallbackDisplaySlot[] = [];

  for (let slot = 1; slot <= 5; slot++) {
    const ref = fallbackRefs[slot - 1];
    let modelName: string | null = null;
    if (ref) {
      try {
        if (ref.type === "llm") {
          const m = await llmModelRepo.loadById(ref.id);
          modelName = m?.llm_codename ?? null;
        } else if (ref.type === "custom_endpoint") {
          const endpoints = await llmProviderRepo.loadCustomEndpointsByIds([ref.id]);
          modelName = endpoints[0]?.model_name ?? endpoints[0]?.label ?? `Endpoint #${ref.id}`;
        }
      } catch {
        modelName = null;
      }
    }
    fallbackSlots.push({ slot, modelName });
  }

  const randomizerEnabled = Boolean(selectedFallbacksConfig?.model_randomizer_enabled);
  const canEnableRandomizer = fallbackRefs.length > 0;

  return {
    routingRows,
    availableCapabilities: ["text", "vision", "embedding", "image", "image_nai", "video"],
    eligibleProvidersForCapability,
    parametersProviders: textProviderNames,
    selectedParametersConfig,
    fallbacksProviders: textProviderNames,
    selectedFallbacksConfig,
    primaryModelName,
    fallbackSlots,
    randomizerEnabled,
    canEnableRandomizer,
  };
}

// The positional signature placed dependencies at position 8, which forced call sites
// targeting later presentation fields to pad preceding positions with undefined.
interface PersonalConfigRepaintOptions {
  locale: string;
  scope: PersonalConfigScope;
  category: PersonalConfigCategory;
  page: PersonalConfigPage;
  selectedLineageId?: number;
  panelReceipt?: PanelReceipt;
  dependencies?: PersonalConfigRouteDependencies;
  selectedCapability?: PersonalConfigManagedCapability;
  selectedParametersProvider?: string;
  selectedFallbacksProvider?: string;
  view?: PersonalConfigPanelView;
}

async function repaint(
  interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
  options: PersonalConfigRepaintOptions,
): Promise<void> {
  const {
    locale,
    scope,
    category,
    page,
    selectedLineageId,
    panelReceipt,
    dependencies = defaultDependencies,
    selectedCapability,
    selectedParametersProvider,
    selectedFallbacksProvider,
    view,
  } = options;
  let personaPref: UserPersonaNamingPreference | null = null;
  if (category === "profile" && page === "persona") {
    const currentLineage = selectedLineageId ?? scope.personas[0]?.persona_lineage_id;
    if (currentLineage) {
      personaPref = await dependencies.loadPersonaNamingPreference(scope.userId, currentLineage);
    }
  }

  const memoryCount = category === "privacy" ? await dependencies.getMemoryCount(scope.userId) : 0;
  const stmCount = category === "privacy" ? await dependencies.getStmCount(scope.userDiscId) : 0;

  let savedProviders: UserSavedProviderConfigRow[] | undefined;
  let modelDisplayInfo: PersonalConfigModelDisplayInfo | undefined;
  if (category === "models") {
    savedProviders = await dependencies.loadUserSavedProviders(scope.userId);
    modelDisplayInfo = await dependencies.loadPersonalModelDisplayInfo(
      scope.userId,
      savedProviders,
      selectedCapability ?? "text",
      selectedParametersProvider,
      selectedFallbacksProvider,
    );
  }

  let spotlightDisplayInfo: PersonalConfigSpotlightDisplayInfo | undefined;
  if (category === "advanced" && page === "spotlight" && scope.guildId && scope.internalServerId) {
    const activeSpotlights = await dependencies.loadActiveSpotlights(scope.internalServerId, scope.userId);
    const personas = await dependencies.loadGuildPersonas(scope.guildId);
    spotlightDisplayInfo = { activeSpotlights, personas };
  }

  let serverTriggerBehavior: { deliberate_trigger_mode: boolean; deliberate_tool_mode: boolean } | null = null;
  if (category === "advanced" && page === "response-modes" && scope.guildId) {
    try {
      serverTriggerBehavior = await dependencies.loadServerTriggerBehavior(scope.guildId);
    } catch {
      serverTriggerBehavior = null;
    }
  }

  await interaction.editReply(
    buildPersonalConfigPanelPayload({
      locale,
      category,
      page,
      user: scope.user,
      resolvedNickname: scope.resolvedNickname,
      personas: scope.personas,
      guildId: scope.guildId,
      selectedLineageId,
      personaNamingPreference: personaPref,
      memoryCount,
      stmCount,
      readStatus: scope.readStatus,
      receipt: panelReceipt,
      savedProviders,
      selectedCapability,
      selectedParametersProvider,
      selectedFallbacksProvider,
      modelDisplayInfo,
      spotlightDisplayInfo,
      serverTriggerBehavior,
      view,
    }),
  );
}

const defaultDependencies: PersonalConfigRouteDependencies = {
  resolveScope,
  loadPersonaNamingPreference,
  getMemoryCount,
  getStmCount,
  loadUserSavedProviders,
  loadPersonalModelDisplayInfo,
  loadAvailableModelsForCapability,
  loadActiveSpotlights: (serverId, userId) => userRepository.getActivePersonalSpotlightsForUser(serverId, userId),
  loadGuildPersonas: async (guildId) => {
    const allPersonas: TomoriState[] = await getCachedAllPersonas(guildId);
    return (
      allPersonas
        .filter((p): p is TomoriState & { persona_id: number } => typeof p.persona_id === "number")
        // Spotlight selection travels as a positional bitmask over this list, so the order must not
        // depend on cache population order between the modal and its confirmation.
        .sort((left, right) => left.persona_id - right.persona_id)
        .map((p) => ({
          id: p.persona_id,
          name: p.persona_nickname,
          isAlter: Boolean(p.is_alter),
        }))
    );
  },
  loadTomoriState: async (guildId) => getCachedTomoriState(guildId),
  loadServerTriggerBehavior: async (guildId) => {
    try {
      const tomoriState = await getCachedTomoriState(guildId);
      if (!tomoriState?.config) return null;
      return {
        deliberate_trigger_mode: Boolean(tomoriState.config.deliberate_trigger_mode),
        deliberate_tool_mode: Boolean(tomoriState.config.deliberate_tool_mode),
      };
    } catch {
      return null;
    }
  },
  operations: personalConfigOperations,
  recordAction: (input) => {
    void recordPanelActionStat(input);
  },
  createNonce,
  showLanguageModal: (interaction, locale, nonce, currentLanguage) =>
    showRoutedRawModal(interaction, buildLanguageModal(locale, nonce, currentLanguage)),
  showTimezoneModal: (interaction, locale, nonce, currentOffset) =>
    showRoutedRawModal(interaction, buildTimezoneModal(locale, nonce, currentOffset)),
  showNamingModal: (interaction, locale, nonce, current) =>
    showRoutedRawModal(interaction, buildNamingModal(locale, nonce, current)),
  showPersonaNamingModal: (interaction, locale, lineageId, nonce, current) =>
    showRoutedRawModal(interaction, buildPersonaNamingModal(locale, lineageId, nonce, current)),
  showAboutModal: (interaction, locale, nonce, current) =>
    showRoutedRawModal(interaction, buildAboutModal(locale, nonce, current)),
  showAppearanceModal: (interaction, locale, nonce, currentTags) =>
    showRoutedRawModal(interaction, buildAppearanceModal(locale, nonce, currentTags)),
  showPrivacyLevelModal: (interaction, locale, nonce, currentLevel) =>
    showRoutedRawModal(interaction, buildPrivacyLevelModal(locale, nonce, currentLevel)),
  showQuickToggleModal: (interaction, locale, nonce, savedProviders) =>
    showRoutedRawModal(interaction, buildQuickToggleModal(locale, nonce, savedProviders)),
  showModelSelectModal: (interaction, locale, nonce, capability, provider, availableModels, currentModelId) =>
    showRoutedRawModal(
      interaction,
      buildModelSelectModal(locale, nonce, capability, provider, availableModels, currentModelId),
    ),
  showParameters1Modal: (interaction, locale, nonce, provider, currentConfig) =>
    showRoutedRawModal(interaction, buildParameters1Modal(locale, nonce, provider, currentConfig)),
  showParameters2Modal: (interaction, locale, nonce, provider, currentConfig) =>
    showRoutedRawModal(interaction, buildParameters2Modal(locale, nonce, provider, currentConfig)),
  showFallbacksModal: (interaction, locale, nonce, provider, availableOptions, currentRefs) =>
    showRoutedRawModal(interaction, buildFallbacksModal(locale, nonce, provider, availableOptions, currentRefs)),
  showImpersonationModal: (interaction, locale, nonce, currentPrompt) =>
    showRoutedRawModal(interaction, buildImpersonationModal(locale, nonce, currentPrompt)),
  showSpotlightStep1Modal: (interaction, locale, nonce) =>
    showRoutedRawModal(interaction, buildSpotlightStep1Modal(locale, nonce)),
  showSpotlightSetModal: (interaction, locale, nonce, channelId, hours, blockIdx, fp, personas) =>
    showRoutedRawModal(interaction, buildSpotlightSetModal(locale, nonce, channelId, hours, blockIdx, fp, personas)),
  showSpotlightAutoTriggerModal: (interaction, locale, nonce, channelId, hours, blockIdx, mask, fp, selectedPersonas) =>
    showRoutedRawModal(
      interaction,
      buildSpotlightAutoTriggerModal(locale, nonce, channelId, hours, blockIdx, mask, fp, selectedPersonas),
    ),
  showSpotlightRemoveModal: (interaction, locale, nonce, start, fp, activeSpotlights, personas, guildChannels) =>
    showRoutedRawModal(
      interaction,
      buildSpotlightRemoveModal(locale, nonce, start, fp, activeSpotlights, personas, guildChannels),
    ),
};

type SpotlightPersona = { id: number; name: string; isAlter: boolean };

/**
 * Resolves a block-relative selection bitmask back to personas. Returns null when the mask cannot
 * belong to the block it names, which is how a collection that shrank under an open continuation
 * fails stale instead of silently retargeting a different persona.
 */
function resolveSpotlightBlockSelection(
  personas: readonly SpotlightPersona[],
  blockIdx: number,
  mask: string,
): { block: SpotlightPersona[]; selected: SpotlightPersona[] } | null {
  const bits = decodeSpotlightMask(mask);
  if (bits === null) return null;
  const blockStart = blockIdx * SPOTLIGHT_PERSONA_PAGE_SIZE;
  const block = personas.slice(blockStart, blockStart + SPOTLIGHT_PERSONA_PAGE_SIZE);
  if (block.length === 0 || bits >> BigInt(block.length) !== 0n) return null;
  return { block, selected: block.filter((_, index) => (bits & (1n << BigInt(index))) !== 0n) };
}

export function createPersonalConfigInteractionRoute(
  overrides: Partial<PersonalConfigRouteDependencies> = {},
): GlobalInteractionRoute {
  const dependencies: PersonalConfigRouteDependencies = {
    ...defaultDependencies,
    ...overrides,
  };

  return {
    namespace: PERSONAL_CONFIG_ROUTE_NAMESPACE,
    version: PERSONAL_CONFIG_ROUTE_VERSION,
    async execute(_client, interaction, parsed): Promise<void> {
      const route = parsePersonalConfigPanelRoute(parsed);
      if (!route) throw new Error(`Malformed personal config panel route: ${interaction.customId}`);

      // Modal openings handle their own interaction response (they must not defer beforehand)
      if (route.action === "language-open") {
        if (!interaction.isButton()) throw new Error("language-open requires Button interaction");
        const cachedScope = await dependencies.resolveScope(interaction, false);
        if (!cachedScope) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.unavailable"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const nonce = dependencies.createNonce();
        await dependencies.showLanguageModal(
          interaction,
          route.locale,
          nonce,
          cachedScope.user.language_pref ?? "en-US",
        );
        return;
      }

      if (route.action === "timezone-open") {
        if (!interaction.isButton()) throw new Error("timezone-open requires Button interaction");
        const cachedScope = await dependencies.resolveScope(interaction, false);
        if (!cachedScope) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.unavailable"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const nonce = dependencies.createNonce();
        await dependencies.showTimezoneModal(
          interaction,
          route.locale,
          nonce,
          cachedScope.user.timezone_offset ?? null,
        );
        return;
      }

      if (route.action === "naming-open") {
        if (!interaction.isButton()) throw new Error("naming-open requires Button interaction");
        const cachedScope = await dependencies.resolveScope(interaction, false);
        if (!cachedScope) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.unavailable"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const nonce = dependencies.createNonce();
        await dependencies.showNamingModal(interaction, route.locale, nonce, {
          nickname: cachedScope.user.user_nickname ?? null,
          prefix: cachedScope.user.prefix_override ?? null,
          suffix: cachedScope.user.suffix_override ?? null,
        });
        return;
      }

      if (route.action === "persona-naming-open") {
        if (!interaction.isButton()) throw new Error("persona-naming-open requires Button interaction");
        const cachedScope = await dependencies.resolveScope(interaction, false);
        if (!cachedScope) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.unavailable"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const pref = await dependencies.loadPersonaNamingPreference(cachedScope.userId, route.lineageId);
        const nonce = dependencies.createNonce();
        await dependencies.showPersonaNamingModal(interaction, route.locale, route.lineageId, nonce, {
          nickname: pref?.nickname_override ?? null,
          prefix: pref?.prefix_override ?? null,
          suffix: pref?.suffix_override ?? null,
        });
        return;
      }

      if (route.action === "about-open") {
        if (!interaction.isButton()) throw new Error("about-open requires Button interaction");
        const cachedScope = await dependencies.resolveScope(interaction, false);
        if (!cachedScope) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.unavailable"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const nonce = dependencies.createNonce();
        await dependencies.showAboutModal(interaction, route.locale, nonce, {
          genderIdentity: cachedScope.user.gender_identity ?? null,
          pronouns: cachedScope.user.pronouns ?? null,
          addressingStyle: cachedScope.user.addressing_style ?? null,
        });
        return;
      }

      if (route.action === "appearance-open") {
        if (!interaction.isButton()) throw new Error("appearance-open requires Button interaction");
        const cachedScope = await dependencies.resolveScope(interaction, false);
        if (!cachedScope) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.unavailable"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const nonce = dependencies.createNonce();
        await dependencies.showAppearanceModal(
          interaction,
          route.locale,
          nonce,
          cachedScope.user.physical_appearance_tags ?? [],
        );
        return;
      }

      if (route.action === "privacy-level-open") {
        if (!interaction.isButton()) throw new Error("privacy-level-open requires Button interaction");
        const cachedScope = await dependencies.resolveScope(interaction, false);
        if (!cachedScope) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.unavailable"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const nonce = dependencies.createNonce();
        await dependencies.showPrivacyLevelModal(
          interaction,
          route.locale,
          nonce,
          cachedScope.user.privacy_level ?? PrivacyLevel.MINIMAL,
        );
        return;
      }

      if (route.action === "quick-toggle-open") {
        if (!interaction.isButton()) throw new Error("quick-toggle-open requires Button interaction");
        const cachedScope = await dependencies.resolveScope(interaction, false);
        if (!cachedScope) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.unavailable"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const rows = await dependencies.loadUserSavedProviders(cachedScope.userId);
        const nonce = dependencies.createNonce();
        await dependencies.showQuickToggleModal(interaction, route.locale, nonce, rows);
        return;
      }

      if (route.action === "parameters-1-open") {
        if (!interaction.isButton()) throw new Error("parameters-1-open requires Button interaction");
        const cachedScope = await dependencies.resolveScope(interaction, false);
        if (!cachedScope) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.unavailable"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const rows = await dependencies.loadUserSavedProviders(cachedScope.userId);
        const config = rows.find((r) => r.provider.toLowerCase() === route.provider.toLowerCase()) ?? null;
        const nonce = dependencies.createNonce();
        await dependencies.showParameters1Modal(interaction, route.locale, nonce, route.provider, config);
        return;
      }

      if (route.action === "parameters-2-open") {
        if (!interaction.isButton()) throw new Error("parameters-2-open requires Button interaction");
        const cachedScope = await dependencies.resolveScope(interaction, false);
        if (!cachedScope) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.unavailable"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const rows = await dependencies.loadUserSavedProviders(cachedScope.userId);
        const config = rows.find((r) => r.provider.toLowerCase() === route.provider.toLowerCase()) ?? null;
        const nonce = dependencies.createNonce();
        await dependencies.showParameters2Modal(interaction, route.locale, nonce, route.provider, config);
        return;
      }

      // Choosing a provider opens its fallback modal directly. This select replaced a separate
      // Edit button, so it is the only entry point and must not merely repaint.
      if (route.action === "fallbacks-provider-select") {
        const selectMenu = interaction as StringSelectMenuInteraction;
        const chosenProvider = decodeProviderParam(selectMenu.values[0]);
        // A modal is its own acknowledgement, so this branch must run before the panel controller
        // defers and must read a cached scope rather than forcing a refresh.
        const cachedScope = await dependencies.resolveScope(interaction, false);
        if (!cachedScope) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.unavailable"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const rows = await dependencies.loadUserSavedProviders(cachedScope.userId);
        const config = rows.find((r) => r.provider.toLowerCase() === chosenProvider.toLowerCase()) ?? null;
        const eligibleProviders = await loadUserSavedProvidersForCapability(cachedScope.userId, "text");
        if (!config || !eligibleProviders.some((row) => row.provider.toLowerCase() === chosenProvider.toLowerCase())) {
          await repaint(interaction, {
            locale: route.locale,
            scope: cachedScope,
            category: "models",
            page: "fallbacks",
            dependencies,
            selectedFallbacksProvider: chosenProvider,
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
              detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
            },
          });
          return;
        }

        let availableOptions: Array<{ refKey: string; label: string }> = [];
        try {
          availableOptions = await loadFallbackSelectionOptions(cachedScope.userId, chosenProvider);
        } catch (error) {
          log.warn("Failed to load available models for fallbacks modal", { provider: chosenProvider, error });
        }

        if (availableOptions.length > PERSONAL_FALLBACK_PAGE_SIZE) {
          await interaction.deferUpdate();
          await repaint(interaction, {
            locale: route.locale,
            scope: cachedScope,
            category: "models",
            page: "fallbacks",
            dependencies,
            selectedFallbacksProvider: chosenProvider,
            view: {
              kind: "fallbacks-range",
              provider: chosenProvider,
              rangePage: 0,
              totalOptions: availableOptions.length,
            },
          });
          return;
        }

        const nonce = dependencies.createNonce();
        await dependencies.showFallbacksModal(
          selectMenu,
          route.locale,
          nonce,
          chosenProvider,
          availableOptions,
          config?.fallback_model_refs ?? [],
        );
        return;
      }

      if (route.action === "fallbacks-range-open") {
        if (!interaction.isButton()) throw new Error("fallbacks-range-open requires Button interaction");
        const cachedScope = await dependencies.resolveScope(interaction, false);
        if (!cachedScope) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.unavailable"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const rows = await dependencies.loadUserSavedProviders(cachedScope.userId);
        const config = rows.find((r) => r.provider.toLowerCase() === route.provider.toLowerCase()) ?? null;
        const eligibleProviders = await loadUserSavedProvidersForCapability(cachedScope.userId, "text");
        if (!config || !eligibleProviders.some((row) => row.provider.toLowerCase() === route.provider.toLowerCase())) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.unavailable"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        let availableOptions: Array<{ refKey: string; label: string }> = [];
        try {
          availableOptions = await loadFallbackSelectionOptions(cachedScope.userId, route.provider);
        } catch (error) {
          log.warn("Failed to load available models for fallbacks modal", { provider: route.provider, error });
        }
        if (route.start % 24 !== 0 || route.start >= availableOptions.length) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.unavailable"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const slice = availableOptions.slice(route.start, route.start + PERSONAL_FALLBACK_PAGE_SIZE);
        const nonce = dependencies.createNonce();
        await dependencies.showFallbacksModal(
          interaction,
          route.locale,
          nonce,
          route.provider,
          slice,
          config?.fallback_model_refs ?? [],
        );
        return;
      }

      if (route.action === "model-range-open") {
        if (!interaction.isButton()) throw new Error("model-range-open requires Button interaction");
        const cachedScope = await dependencies.resolveScope(interaction, false);
        if (!cachedScope) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.unavailable"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const availableModels = await dependencies.loadAvailableModelsForCapability(
          cachedScope.userId,
          route.provider,
          route.capability,
        );
        if (route.start % PERSONAL_MODEL_PAGE_SIZE !== 0 || route.start >= availableModels.length) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.unavailable"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const rows = await dependencies.loadUserSavedProviders(cachedScope.userId);
        const currentConfig = rows.find((r) => r.provider.toLowerCase() === route.provider.toLowerCase());
        let currentModelId: number | null = null;
        if (currentConfig) {
          if (route.capability === "text") currentModelId = currentConfig.llm_id ?? null;
          else if (route.capability === "vision") currentModelId = currentConfig.vision_llm_id ?? null;
          else if (route.capability === "embedding") currentModelId = currentConfig.embedding_model_id ?? null;
          else if (route.capability === "image") currentModelId = currentConfig.diffusion_model_id ?? null;
          else if (route.capability === "image_nai") currentModelId = currentConfig.nai_diffusion_model_id ?? null;
          else if (route.capability === "video") currentModelId = currentConfig.video_model_id ?? null;
        }
        const slice = availableModels.slice(route.start, route.start + PERSONAL_MODEL_PAGE_SIZE);
        const nonce = dependencies.createNonce();
        await dependencies.showModelSelectModal(
          interaction,
          route.locale,
          nonce,
          route.capability,
          route.provider,
          slice,
          currentModelId,
        );
        return;
      }

      if (route.action === "model-provider-select") {
        if (!interaction.isStringSelectMenu()) {
          throw new Error("model-provider-select requires StringSelectMenu interaction");
        }
        const selectMenu = interaction as StringSelectMenuInteraction;
        const chosen = selectMenu.values[0];
        if (chosen === PERSONAL_PROVIDER_RANGE_VALUE) {
          await interaction.deferUpdate();
          const cachedScope = await dependencies.resolveScope(interaction, false);
          if (!cachedScope) {
            await interaction.editReply({
              content: localizer(route.locale, "commands.personal.config.unavailable"),
              components: [],
            });
            return;
          }
          const rows = await dependencies.loadUserSavedProviders(cachedScope.userId);
          const displayInfo = await dependencies.loadPersonalModelDisplayInfo(
            cachedScope.userId,
            rows,
            route.capability,
          );
          const providers = displayInfo.eligibleProvidersForCapability[route.capability];
          if (providers.length <= PERSONAL_PROVIDER_DIRECT_LIMIT) {
            await repaint(interaction, {
              locale: route.locale,
              scope: cachedScope,
              category: "models",
              page: "switch",
              panelReceipt: {
                tone: "error",
                heading: localizer(route.locale, "commands.personal.config.unavailable"),
                detail: localizer(route.locale, "commands.personal.config.stale_warning"),
              },
              dependencies,
            });
            return;
          }
          await repaint(interaction, {
            locale: route.locale,
            scope: cachedScope,
            category: "models",
            page: "switch",
            dependencies,
            selectedCapability: route.capability,
            view: {
              kind: "model-provider-range",
              capability: route.capability,
              rangePage: 0,
              totalOptions: providers.length,
            },
          });
          return;
        }
        if (chosen !== "__server_default__") {
          const provider = decodeProviderParam(chosen);
          const cachedScope = await dependencies.resolveScope(interaction, false);
          if (!cachedScope) {
            await interaction.reply({
              content: localizer(route.locale, "commands.personal.config.unavailable"),
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          const availableModels = await dependencies.loadAvailableModelsForCapability(
            cachedScope.userId,
            provider,
            route.capability,
          );

          if (availableModels.length === 0) {
            await interaction.deferUpdate();
            await repaint(interaction, {
              locale: route.locale,
              scope: cachedScope,
              category: "models",
              page: "switch",
              panelReceipt: {
                tone: "error",
                heading: localizer(route.locale, "commands.personal.config.no_models_available_heading"),
                detail: localizer(route.locale, "commands.personal.config.no_models_available_detail", {
                  provider: getProviderDisplayName(provider),
                }),
              },
              dependencies,
              selectedCapability: route.capability,
            });
            return;
          }

          if (availableModels.length > PERSONAL_MODEL_PAGE_SIZE) {
            await interaction.deferUpdate();
            await repaint(interaction, {
              locale: route.locale,
              scope: cachedScope,
              category: "models",
              page: "switch",
              dependencies,
              selectedCapability: route.capability,
              view: {
                kind: "model-range",
                capability: route.capability,
                provider,
                rangePage: 0,
                totalOptions: availableModels.length,
              },
            });
            return;
          }

          const rows = await dependencies.loadUserSavedProviders(cachedScope.userId);
          const currentConfig = rows.find((r) => r.provider.toLowerCase() === provider.toLowerCase());
          let currentModelId: number | null = null;
          if (currentConfig) {
            if (route.capability === "text") currentModelId = currentConfig.llm_id ?? null;
            else if (route.capability === "vision") currentModelId = currentConfig.vision_llm_id ?? null;
            else if (route.capability === "embedding") currentModelId = currentConfig.embedding_model_id ?? null;
            else if (route.capability === "image") currentModelId = currentConfig.diffusion_model_id ?? null;
            else if (route.capability === "image_nai") currentModelId = currentConfig.nai_diffusion_model_id ?? null;
            else if (route.capability === "video") currentModelId = currentConfig.video_model_id ?? null;
          }
          const nonce = dependencies.createNonce();
          await dependencies.showModelSelectModal(
            interaction,
            route.locale,
            nonce,
            route.capability,
            provider,
            availableModels,
            currentModelId,
          );
          return;
        }
      }

      if (route.action === "impersonation-open") {
        if (!interaction.isButton()) throw new Error("impersonation-open requires Button interaction");
        const cachedScope = await dependencies.resolveScope(interaction, false);
        if (!cachedScope) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.unavailable"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const nonce = dependencies.createNonce();
        await dependencies.showImpersonationModal(
          interaction,
          route.locale,
          nonce,
          cachedScope.user.impersonation_prompt ?? null,
        );
        return;
      }

      if (route.action === "spotlight-set-open") {
        if (!interaction.isButton()) throw new Error("spotlight-set-open requires Button interaction");
        const cachedScope = await dependencies.resolveScope(interaction, false);
        if (!cachedScope?.guildId || !cachedScope.internalServerId) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const personas = await dependencies.loadGuildPersonas(cachedScope.guildId);
        if (personas.length === 0) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.spotlight_no_personas_detail"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        await dependencies.showSpotlightStep1Modal(interaction, route.locale, dependencies.createNonce());
        return;
      }

      if (route.action === "spotlight-set-block") {
        if (!interaction.isButton()) throw new Error("spotlight-set-block requires Button interaction");
        const cachedScope = await dependencies.resolveScope(interaction, false);
        if (!cachedScope?.guildId || !cachedScope.internalServerId) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const personas = await dependencies.loadGuildPersonas(cachedScope.guildId);
        const expectedFp = computeSpotlightSetFingerprint(cachedScope.guildId, cachedScope.userDiscId, personas);
        if (expectedFp !== route.fp) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.stale_warning"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const blockStart = route.blockIdx * SPOTLIGHT_PERSONA_PAGE_SIZE;
        const block = personas.slice(blockStart, blockStart + SPOTLIGHT_PERSONA_PAGE_SIZE);
        if (block.length === 0) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.stale_warning"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        await dependencies.showSpotlightSetModal(
          interaction,
          route.locale,
          dependencies.createNonce(),
          route.channelId,
          route.hours,
          route.blockIdx,
          route.fp,
          block,
        );
        return;
      }

      if (route.action === "spot-set-auto") {
        if (!interaction.isButton()) throw new Error("spot-set-auto requires Button interaction");
        const cachedScope = await dependencies.resolveScope(interaction, false);
        if (!cachedScope?.guildId || !cachedScope.internalServerId) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const personas = await dependencies.loadGuildPersonas(cachedScope.guildId);
        const expectedFp = computeSpotlightSetFingerprint(cachedScope.guildId, cachedScope.userDiscId, personas);
        if (expectedFp !== route.fp) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.stale_warning"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const resolved = resolveSpotlightBlockSelection(personas, route.blockIdx, route.mask);
        if (!resolved) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.stale_warning"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const selectedPersonas = resolved.selected;
        if (selectedPersonas.length === 0) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.spotlight_no_selection_detail"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (selectedPersonas.length === 1) {
          await interaction.deferUpdate();
          const selectedPersonaIds = selectedPersonas.map((p) => p.id);
          const autoTriggerPersonaId = selectedPersonas[0]?.id ?? null;
          const autoIdx =
            autoTriggerPersonaId === null ? 0 : resolved.block.findIndex((p) => p.id === autoTriggerPersonaId) + 1;
          await repaint(interaction, {
            locale: route.locale,
            scope: cachedScope,
            category: "advanced",
            page: "spotlight",
            dependencies,
            view: {
              kind: "spotlight-set-review",
              channelId: route.channelId,
              hours: route.hours,
              blockIdx: route.blockIdx,
              selectedPersonaIds,
              autoTriggerPersonaId,
              autoIdx,
              mask: route.mask,
              fp: route.fp,
              nonce: dependencies.createNonce(),
            },
          });
          return;
        }
        if (selectedPersonas.length > SPOTLIGHT_AUTO_TRIGGER_PAGE_SIZE) {
          await interaction.deferUpdate();
          await repaint(interaction, {
            locale: route.locale,
            scope: cachedScope,
            category: "advanced",
            page: "spotlight",
            dependencies,
            view: {
              kind: "spotlight-auto-range",
              channelId: route.channelId,
              hours: route.hours,
              blockIdx: route.blockIdx,
              mask: route.mask,
              fp: route.fp,
              rangePage: 0,
              totalOptions: selectedPersonas.length,
            },
          });
          return;
        }
        const nonce = dependencies.createNonce();
        await dependencies.showSpotlightAutoTriggerModal(
          interaction,
          route.locale,
          nonce,
          route.channelId,
          route.hours,
          route.blockIdx,
          route.mask,
          route.fp,
          selectedPersonas,
        );
        return;
      }

      if (route.action === "spot-set-auto-range") {
        if (!interaction.isButton()) throw new Error("spot-set-auto-range requires Button interaction");
        const cachedScope = await dependencies.resolveScope(interaction, false);
        if (!cachedScope?.guildId || !cachedScope.internalServerId) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const personas = await dependencies.loadGuildPersonas(cachedScope.guildId);
        const expectedFp = computeSpotlightSetFingerprint(cachedScope.guildId, cachedScope.userDiscId, personas);
        if (expectedFp !== route.fp) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.stale_warning"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const resolvedRange = resolveSpotlightBlockSelection(personas, route.blockIdx, route.mask);
        if (!resolvedRange) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.stale_warning"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const slice = resolvedRange.selected.slice(route.start, route.start + SPOTLIGHT_AUTO_TRIGGER_PAGE_SIZE);
        const nonce = dependencies.createNonce();
        await dependencies.showSpotlightAutoTriggerModal(
          interaction,
          route.locale,
          nonce,
          route.channelId,
          route.hours,
          route.blockIdx,
          route.mask,
          route.fp,
          slice,
        );
        return;
      }

      if (route.action === "spotlight-remove-open") {
        if (!interaction.isButton()) throw new Error("spotlight-remove-open requires Button interaction");
        const cachedScope = await dependencies.resolveScope(interaction, false);
        if (!cachedScope?.guildId || !cachedScope.internalServerId) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const activeSpotlights = await dependencies.loadActiveSpotlights(
          cachedScope.internalServerId,
          cachedScope.userId,
        );
        if (activeSpotlights.length === 0) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.spotlight_none_active"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const fp = computeSpotlightRemoveFingerprint(cachedScope.guildId, cachedScope.userDiscId, activeSpotlights);
        if (activeSpotlights.length <= SPOTLIGHT_REMOVE_PAGE_SIZE) {
          const personas = await dependencies.loadGuildPersonas(cachedScope.guildId);
          const guildChannels = interaction.guild?.channels.cache;
          const nonce = dependencies.createNonce();
          await dependencies.showSpotlightRemoveModal(
            interaction,
            route.locale,
            nonce,
            0,
            fp,
            activeSpotlights,
            personas,
            guildChannels,
          );
          return;
        }
      }

      if (route.action === "spot-rem-range") {
        if (!interaction.isButton()) throw new Error("spot-rem-range requires Button interaction");
        const cachedScope = await dependencies.resolveScope(interaction, false);
        if (!cachedScope?.guildId || !cachedScope.internalServerId) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const allActive = await dependencies.loadActiveSpotlights(cachedScope.internalServerId, cachedScope.userId);
        const expectedFp = computeSpotlightRemoveFingerprint(cachedScope.guildId, cachedScope.userDiscId, allActive);
        if (expectedFp !== route.fp) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.config.stale_warning"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const slice = allActive.slice(route.start, route.start + SPOTLIGHT_REMOVE_PAGE_SIZE);
        const personas = await dependencies.loadGuildPersonas(cachedScope.guildId);
        const guildChannels = interaction.guild?.channels.cache;
        const nonce = dependencies.createNonce();
        await dependencies.showSpotlightRemoveModal(
          interaction,
          route.locale,
          nonce,
          route.start,
          route.fp,
          slice,
          personas,
          guildChannels,
        );
        return;
      }

      const initialScope = await beginPanelInteraction({
        acknowledge: () => interaction.deferUpdate(),
        authorize: () => true,
        onDenied: () => Promise.resolve(),
        load: () => dependencies.resolveScope(interaction, route.action === "retry" || route.action === "refresh"),
        onMissing: () => interaction.editReply(terminalPayload(route.locale, "commands.personal.config.unavailable")),
      });
      if (!initialScope) return;
      let scope = initialScope;

      if (route.action === "category") {
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: route.category,
          page: route.page,
          selectedLineageId:
            route.category === "profile" && route.page === "persona"
              ? scope.personas[0]?.persona_lineage_id
              : undefined,
          dependencies,
        });
        return;
      }

      if (route.action === "page") {
        const selectMenu = interaction as StringSelectMenuInteraction;
        const selectedPage = (selectMenu.values[0] as PersonalConfigPage) ?? route.page;
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: route.category,
          page: selectedPage,
          selectedLineageId:
            route.category === "profile" && selectedPage === "persona"
              ? scope.personas[0]?.persona_lineage_id
              : undefined,
          dependencies,
        });
        return;
      }

      if (route.action === "persona-select") {
        const selectMenu = interaction as StringSelectMenuInteraction;
        const selectedLineage = Number(selectMenu.values[0]);
        const validLineage = scope.personas.some((p) => p.persona_lineage_id === selectedLineage)
          ? selectedLineage
          : (scope.personas[0]?.persona_lineage_id ?? 0);
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "profile",
          page: "persona",
          selectedLineageId: validLineage,
          dependencies,
        });
        return;
      }

      if (route.action === "language-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const fieldId = buildPersonalConfigModalFieldId("language", route.nonce);
        const language = takeRawModalSelectValue(modal.id, fieldId) || "en-US";

        const action = await performPanelAction(
          () =>
            dependencies.operations.setLanguage({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              language,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.language.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          const langLabel =
            language === "ja"
              ? localizer(route.locale, "commands.personal.config.language_ja")
              : localizer(route.locale, "commands.personal.config.language_en");
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "profile",
            page: "general",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.language_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.language_updated_detail", {
                language: langLabel,
              }),
            },
            dependencies,
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "profile",
          page: "general",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
        return;
      }

      if (route.action === "timezone-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const fieldId = buildPersonalConfigModalFieldId("timezone", route.nonce);
        const rawOffset = modal.fields.getTextInputValue(fieldId).trim();
        const parsedOffset = Number(rawOffset);

        if (Number.isNaN(parsedOffset) || parsedOffset < -12 || parsedOffset > 14) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "profile",
            page: "general",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.invalid_timezone_heading"),
              detail: localizer(route.locale, "commands.personal.config.invalid_timezone_detail"),
            },
            dependencies,
          });
          return;
        }

        const action = await performPanelAction(
          () =>
            dependencies.operations.setTimezone({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              offset: parsedOffset,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.timezone.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "profile",
            page: "general",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.timezone_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.timezone_updated_detail", {
                timezone: formatUTCOffset(parsedOffset),
              }),
            },
            dependencies,
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "profile",
          page: "general",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
        return;
      }

      if (route.action === "timezone-server") {
        const action = await performPanelAction(
          () =>
            dependencies.operations.setTimezone({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              offset: null,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.timezone.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "profile",
            page: "general",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.timezone_cleared_heading"),
              detail: localizer(route.locale, "commands.personal.config.timezone_cleared_detail"),
            },
            dependencies,
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "profile",
          page: "general",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
        return;
      }

      if (route.action === "naming-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const nicknameRaw = modal.fields
          .getTextInputValue(buildPersonalConfigModalFieldId("nickname", route.nonce))
          .trim();
        const prefixRaw = modal.fields.getTextInputValue(buildPersonalConfigModalFieldId("prefix", route.nonce)).trim();
        const suffixRaw = modal.fields.getTextInputValue(buildPersonalConfigModalFieldId("suffix", route.nonce)).trim();

        const nickname = nicknameRaw || null;
        const prefix = prefixRaw || null;
        const suffix = suffixRaw || null;

        const action = await performPanelAction(
          () =>
            dependencies.operations.setNaming({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              nickname,
              prefix,
              suffix,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.naming.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "profile",
            page: "general",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.naming_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.naming_updated_detail"),
            },
            dependencies,
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "profile",
          page: "general",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
        return;
      }

      if (route.action === "persona-naming-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const nicknameRaw = modal.fields
          .getTextInputValue(buildPersonalConfigModalFieldId("nickname", route.nonce))
          .trim();
        const prefixRaw = modal.fields.getTextInputValue(buildPersonalConfigModalFieldId("prefix", route.nonce)).trim();
        const suffixRaw = modal.fields.getTextInputValue(buildPersonalConfigModalFieldId("suffix", route.nonce)).trim();

        const nickname = nicknameRaw || null;
        const prefix = prefixRaw || null;
        const suffix = suffixRaw || null;

        const action = await performPanelAction(
          () =>
            dependencies.operations.setPersonaNaming({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              personaLineageId: route.lineageId,
              nickname,
              prefix,
              suffix,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.naming.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "profile",
            page: "persona",
            selectedLineageId: route.lineageId,
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.naming_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.naming_updated_detail"),
            },
            dependencies,
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "profile",
          page: "persona",
          selectedLineageId: route.lineageId,
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
        return;
      }

      if (route.action === "about-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const genderRaw = modal.fields
          .getTextInputValue(buildPersonalConfigModalFieldId("gender_identity", route.nonce))
          .trim();
        const pronounsRaw = modal.fields
          .getTextInputValue(buildPersonalConfigModalFieldId("pronouns", route.nonce))
          .trim();
        const rawStyle = takeRawModalSelectValue(
          modal.id,
          buildPersonalConfigModalFieldId("addressing_style", route.nonce),
        );

        const genderIdentity = genderRaw || null;
        const pronouns = pronounsRaw || null;

        const resolvedStyle =
          rawStyle === "neutral"
            ? scope.user.addressing_style === "neutral"
              ? "neutral"
              : null
            : rawStyle === "masculine" || rawStyle === "feminine"
              ? rawStyle
              : null;

        const action = await performPanelAction(
          () =>
            dependencies.operations.setAbout({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              genderIdentity,
              pronouns,
              addressingStyle: resolvedStyle,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.about.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "profile",
            page: "general",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.about_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.about_updated_detail"),
            },
            dependencies,
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "profile",
          page: "general",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
        return;
      }

      if (route.action === "appearance-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const tagsInput = modal.fields.getTextInputValue(buildPersonalConfigModalFieldId("tags", route.nonce));

        const action = await performPanelAction(
          () =>
            dependencies.operations.setAppearance({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              rawTags: tagsInput,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.appearance.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          const isCleared = result.tags.length === 0;
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "profile",
            page: "appearance",
            panelReceipt: {
              tone: "success",
              heading: localizer(
                route.locale,
                isCleared
                  ? "commands.personal.config.appearance_cleared_heading"
                  : "commands.personal.config.appearance_updated_heading",
              ),
              detail: localizer(
                route.locale,
                isCleared
                  ? "commands.personal.config.appearance_cleared_detail"
                  : "commands.personal.config.appearance_updated_detail",
              ),
            },
            dependencies,
          });
          return;
        }

        const tone: "error" = "error";
        let headingKey = "commands.personal.config.write_failed_heading";
        let detailKey = "commands.personal.config.write_failed_detail";
        let vars: Record<string, string | number> | undefined;

        if (result.status === "too-many-tags") {
          headingKey = "commands.personal.config.too_many_tags_heading";
          detailKey = "commands.personal.config.too_many_tags_detail";
          vars = { max: MAX_TAGS };
        } else if (result.status === "tag-too-long") {
          headingKey = "commands.personal.config.tag_too_long_heading";
          detailKey = "commands.personal.config.tag_too_long_detail";
          vars = { max: MAX_TAG_LENGTH };
        } else if (result.status === "invalid-tags") {
          headingKey = "commands.personal.config.invalid_tags_heading";
          detailKey = "commands.personal.config.invalid_tags_detail";
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "profile",
          page: "appearance",
          panelReceipt: {
            tone,
            heading: localizer(route.locale, headingKey),
            detail: localizer(route.locale, detailKey, vars),
          },
          dependencies,
        });
        return;
      }

      if (route.action === "privacy-level-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const fieldId = buildPersonalConfigModalFieldId("privacy_level", route.nonce);
        const selectedValue = takeRawModalSelectValue(modal.id, fieldId) ?? "";
        const requestedLevel = Number.parseInt(selectedValue, 10) as PrivacyLevel;

        const action = await performPanelAction(
          () =>
            dependencies.operations.setPrivacyLevel({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              level: requestedLevel,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.privacy.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          const levelName =
            requestedLevel === PrivacyLevel.FULL
              ? localizer(route.locale, "commands.personal.config.privacy_level_full")
              : requestedLevel === PrivacyLevel.PARTIAL
                ? localizer(route.locale, "commands.personal.config.privacy_level_partial")
                : localizer(route.locale, "commands.personal.config.privacy_level_minimal");

          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "privacy",
            page: "controls",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.privacy_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.privacy_updated_detail", {
                level: levelName,
              }),
            },
            dependencies,
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "privacy",
          page: "controls",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
        return;
      }

      if (route.action === "crossserver-toggle") {
        const action = await performPanelAction(
          () =>
            dependencies.operations.toggleCrossServerStm({
              userDiscId: scope.userDiscId,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.crossserver-stm.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          const isEnabled = result.enabled;
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "privacy",
            page: "controls",
            panelReceipt: {
              tone: "success",
              heading: localizer(
                route.locale,
                isEnabled
                  ? "commands.personal.config.crossserver_enabled_heading"
                  : "commands.personal.config.crossserver_disabled_heading",
              ),
              detail: localizer(
                route.locale,
                isEnabled
                  ? "commands.personal.config.crossserver_enabled_detail"
                  : "commands.personal.config.crossserver_disabled_detail",
              ),
            },
            dependencies,
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "privacy",
          page: "controls",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
        return;
      }

      if (route.action === "parameters-provider-select") {
        const selectMenu = interaction as StringSelectMenuInteraction;
        const chosenProvider = decodeProviderParam(selectMenu.values[0]);
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "models",
          page: "parameters",
          dependencies,
          selectedParametersProvider: chosenProvider,
        });
        return;
      }

      if (route.action === "quick-toggle-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const fieldId = buildPersonalConfigModalFieldId("capabilities", route.nonce);
        const selectedCaps = (takeRawModalCheckboxGroupValues(modal.id, fieldId) ?? []) as PersonalProviderCapability[];
        const selectedCapSet = new Set<PersonalProviderCapability>(selectedCaps);

        const rows = await dependencies.loadUserSavedProviders(scope.userId);
        for (const cap of selectedCapSet) {
          const target = getStoredPersonalProviderForCapability(rows, cap);
          if (!target || !hasConfiguredPersonalModel(target, cap)) {
            const capLabel = localizer(route.locale, ROUTING_CAPABILITY_LOCALE_KEYS[cap]);
            await repaint(interaction, {
              locale: route.locale,
              scope,
              category: "models",
              page: "switch",
              panelReceipt: {
                tone: "error",
                heading: localizer(route.locale, "commands.personal.config.missing_model_heading"),
                detail: localizer(route.locale, "commands.personal.config.missing_model_detail", {
                  capability: capLabel,
                }),
              },
              dependencies,
            });
            return;
          }
        }

        const hasChange = QUICK_TOGGLE_CAPABILITIES.some(
          (cap) => (getActivePersonalProviderForCapability(rows, cap) !== null) !== selectedCapSet.has(cap),
        );
        if (!hasChange) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "models",
            page: "switch",
            panelReceipt: {
              tone: "info",
              heading: localizer(route.locale, "commands.personal.config.no_changes_heading"),
              detail: localizer(route.locale, "commands.personal.config.no_changes_detail"),
            },
            dependencies,
          });
          return;
        }

        const action = await performPanelAction(
          () =>
            dependencies.operations.setQuickToggleRouting({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              selectedCapabilities: selectedCapSet,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "no-changes") {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "models",
            page: "switch",
            panelReceipt: noChangesReceipt(route.locale),
            dependencies,
          });
          return;
        }

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.model-routing.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "models",
            page: "switch",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.routing_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.routing_updated_detail"),
            },
            dependencies,
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "models",
          page: "switch",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
        return;
      }

      // Now only backs the model, provider, and fallback range choosers: the activation confirmation
      // it was named for is gone, so the receipt reports the state, not a cancelled activation.
      if (route.action === "model-act-cancel") {
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "models",
          page: "switch",
          panelReceipt: noChangesReceipt(route.locale),
          dependencies,
        });
        return;
      }

      if (route.action === "model-provider-select") {
        const action = await performPanelAction(
          () =>
            dependencies.operations.setCapabilityEnabled({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              capability: route.capability,
              enabled: false,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "no-changes") {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "models",
            page: "switch",
            panelReceipt: noChangesReceipt(route.locale),
            dependencies,
            selectedCapability: route.capability,
          });
          return;
        }

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.model.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          const capLabel = localizer(route.locale, ROUTING_CAPABILITY_LOCALE_KEYS[route.capability]);
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "models",
            page: "switch",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.model_default_heading"),
              detail: localizer(route.locale, "commands.personal.config.model_default_detail", {
                capability: capLabel,
              }),
            },
            dependencies,
            selectedCapability: route.capability,
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "models",
          page: "switch",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
          selectedCapability: route.capability,
        });
        return;
      }

      if (route.action === "model-modal-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const fieldId = buildPersonalConfigModalFieldId("model", route.nonce);
        const rawModelId = takeRawModalSelectValue(modal.id, fieldId);
        const modelId = Number(rawModelId);

        const availableModels = await dependencies.loadAvailableModelsForCapability(
          scope.userId,
          route.provider,
          route.capability,
        );
        const validModel = availableModels.find((m) => m.id === modelId);

        if (!validModel || modelId === 0) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "models",
            page: "switch",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
              detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
            },
            dependencies,
            selectedCapability: route.capability,
          });
          return;
        }

        const action = await performPanelAction(
          () =>
            dependencies.operations.setCapabilityModel({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              capability: route.capability,
              provider: route.provider,
              modelId,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "no-changes") {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "models",
            page: "switch",
            panelReceipt: noChangesReceipt(route.locale),
            dependencies,
            selectedCapability: route.capability,
          });
          return;
        }

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.model.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          const capLabel = localizer(route.locale, ROUTING_CAPABILITY_LOCALE_KEYS[route.capability]);
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "models",
            page: "switch",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.model_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.model_updated_detail", {
                capability: capLabel,
                provider: getProviderDisplayName(route.provider),
                model: validModel.name,
              }),
            },
            dependencies,
            selectedCapability: route.capability,
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "models",
          page: "switch",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
          selectedCapability: route.capability,
        });
        return;
      }

      if (route.action === "model-range-page") {
        const availableModels = await dependencies.loadAvailableModelsForCapability(
          scope.userId,
          route.provider,
          route.capability,
        );
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "models",
          page: "switch",
          dependencies,
          selectedCapability: route.capability,
          view: {
            kind: "model-range",
            capability: route.capability,
            provider: route.provider,
            rangePage: route.chooserPage,
            totalOptions: availableModels.length,
          },
        });
        return;
      }

      if (route.action === "model-provider-range-open" || route.action === "model-provider-range-page") {
        const rows = await dependencies.loadUserSavedProviders(scope.userId);
        const displayInfo = await dependencies.loadPersonalModelDisplayInfo(scope.userId, rows, route.capability);
        const providers = displayInfo.eligibleProvidersForCapability[route.capability];

        if (route.action === "model-provider-range-open") {
          if (route.start % PERSONAL_PROVIDER_PAGE_SIZE !== 0 || route.start >= providers.length) {
            await repaint(interaction, {
              locale: route.locale,
              scope,
              category: "models",
              page: "switch",
              panelReceipt: {
                tone: "error",
                heading: localizer(route.locale, "commands.personal.config.unavailable"),
                detail: localizer(route.locale, "commands.personal.config.stale_warning"),
              },
              dependencies,
            });
            return;
          }
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "models",
            page: "switch",
            dependencies,
            selectedCapability: route.capability,
            view: { kind: "model-provider-page", capability: route.capability, start: route.start },
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "models",
          page: "switch",
          dependencies,
          selectedCapability: route.capability,
          view: {
            kind: "model-provider-range",
            capability: route.capability,
            rangePage: route.chooserPage,
            totalOptions: providers.length,
          },
        });
        return;
      }

      if (route.action === "fallbacks-range-page") {
        let availableOptions: Array<{ refKey: string; label: string }> = [];
        try {
          availableOptions = await loadFallbackSelectionOptions(scope.userId, route.provider);
        } catch (error) {
          log.warn("Failed to load available models for fallbacks modal", { provider: route.provider, error });
        }
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "models",
          page: "fallbacks",
          dependencies,
          selectedFallbacksProvider: route.provider,
          view: {
            kind: "fallbacks-range",
            provider: route.provider,
            rangePage: route.chooserPage,
            totalOptions: availableOptions.length,
          },
        });
        return;
      }

      if (route.action === "parameters-1-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const tempRaw = modal.fields
          .getTextInputValue(buildPersonalConfigModalFieldId("temperature", route.nonce))
          .trim();
        const minPRaw = modal.fields.getTextInputValue(buildPersonalConfigModalFieldId("min_p", route.nonce)).trim();
        const topPRaw = modal.fields.getTextInputValue(buildPersonalConfigModalFieldId("top_p", route.nonce)).trim();
        const topKRaw = modal.fields.getTextInputValue(buildPersonalConfigModalFieldId("top_k", route.nonce)).trim();
        const freqRaw = modal.fields
          .getTextInputValue(buildPersonalConfigModalFieldId("frequency_penalty", route.nonce))
          .trim();

        const patch: Partial<ModelParameterOptions> = {
          temperature: tempRaw ? Number(tempRaw) : null,
          min_p: minPRaw ? Number(minPRaw) : null,
          top_p: topPRaw ? Number(topPRaw) : null,
          top_k: topKRaw ? Number(topKRaw) : null,
          frequency_penalty: freqRaw ? Number(freqRaw) : null,
        };

        const action = await performPanelAction(
          () =>
            dependencies.operations.setParameters({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              provider: route.provider,
              patch,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.parameters.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "models",
            page: "parameters",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.parameters_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.parameters_updated_detail", {
                provider: getProviderDisplayName(route.provider),
              }),
            },
            dependencies,
            selectedParametersProvider: route.provider,
          });
          return;
        }

        const isInvalid = result.status === "invalid-value";
        const isNoChanges = result.status === "no-changes";

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "models",
          page: "parameters",
          panelReceipt: {
            tone: isNoChanges ? "info" : "error",
            heading: localizer(
              route.locale,
              isInvalid
                ? "commands.personal.config.invalid_parameters_heading"
                : isNoChanges
                  ? "commands.personal.config.no_changes_heading"
                  : "commands.personal.config.write_failed_heading",
            ),
            detail: localizer(
              route.locale,
              isInvalid
                ? "commands.personal.config.invalid_parameters_detail"
                : isNoChanges
                  ? "commands.personal.config.no_changes_detail"
                  : "commands.personal.config.write_failed_detail",
            ),
          },
          dependencies,
          selectedParametersProvider: route.provider,
        });
        return;
      }

      if (route.action === "parameters-2-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const presRaw = modal.fields
          .getTextInputValue(buildPersonalConfigModalFieldId("presence_penalty", route.nonce))
          .trim();
        const maxTokRaw = modal.fields
          .getTextInputValue(buildPersonalConfigModalFieldId("max_output_tokens", route.nonce))
          .trim();
        const thinkRaw = takeRawModalSelectValue(
          modal.id,
          buildPersonalConfigModalFieldId("thinking_level", route.nonce),
        );

        const patch: Partial<ModelParameterOptions> = {
          presence_penalty: presRaw ? Number(presRaw) : null,
          max_output_tokens: maxTokRaw ? Number(maxTokRaw) : null,
          thinking_level: (thinkRaw as ThinkingLevelValue) ?? null,
        };

        const action = await performPanelAction(
          () =>
            dependencies.operations.setParameters({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              provider: route.provider,
              patch,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.parameters.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "models",
            page: "parameters",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.parameters_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.parameters_updated_detail", {
                provider: getProviderDisplayName(route.provider),
              }),
            },
            dependencies,
            selectedParametersProvider: route.provider,
          });
          return;
        }

        const isInvalid = result.status === "invalid-value";
        const isNoChanges = result.status === "no-changes";

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "models",
          page: "parameters",
          panelReceipt: {
            tone: isNoChanges ? "info" : "error",
            heading: localizer(
              route.locale,
              isInvalid
                ? "commands.personal.config.invalid_parameters_heading"
                : isNoChanges
                  ? "commands.personal.config.no_changes_heading"
                  : "commands.personal.config.write_failed_heading",
            ),
            detail: localizer(
              route.locale,
              isInvalid
                ? "commands.personal.config.invalid_parameters_detail"
                : isNoChanges
                  ? "commands.personal.config.no_changes_detail"
                  : "commands.personal.config.write_failed_detail",
            ),
          },
          dependencies,
          selectedParametersProvider: route.provider,
        });
        return;
      }

      if (route.action === "fallbacks-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const slotValues = [
          takeRawModalSelectValue(modal.id, buildPersonalConfigModalFieldId("slot_1", route.nonce)) ?? "",
          takeRawModalSelectValue(modal.id, buildPersonalConfigModalFieldId("slot_2", route.nonce)) ?? "",
          takeRawModalSelectValue(modal.id, buildPersonalConfigModalFieldId("slot_3", route.nonce)) ?? "",
          takeRawModalSelectValue(modal.id, buildPersonalConfigModalFieldId("slot_4", route.nonce)) ?? "",
          takeRawModalSelectValue(modal.id, buildPersonalConfigModalFieldId("slot_5", route.nonce)) ?? "",
        ];

        const action = await performPanelAction(
          () =>
            dependencies.operations.setFallbacks({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              provider: route.provider,
              slotValues,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.fallbacks.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "models",
            page: "fallbacks",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.fallbacks_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.fallbacks_updated_detail", {
                provider: getProviderDisplayName(route.provider),
              }),
            },
            dependencies,
            selectedFallbacksProvider: route.provider,
          });
          return;
        }

        const isConflict = result.status === "primary-conflict";
        const isNoChanges = result.status === "no-changes";

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "models",
          page: "fallbacks",
          panelReceipt: {
            tone: isNoChanges ? "info" : "error",
            heading: localizer(
              route.locale,
              isConflict
                ? "commands.personal.config.fallback_primary_conflict_heading"
                : isNoChanges
                  ? "commands.personal.config.no_changes_heading"
                  : "commands.personal.config.write_failed_heading",
            ),
            detail: isConflict
              ? localizer(route.locale, "commands.personal.config.fallback_primary_conflict_detail", {
                  model:
                    result.primaryModelName ??
                    localizer(route.locale, "commands.personal.config.saved_assignment_none"),
                })
              : isNoChanges
                ? localizer(route.locale, "commands.personal.config.no_changes_detail")
                : localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
          selectedFallbacksProvider: route.provider,
        });
        return;
      }

      if (route.action === "randomizer-toggle") {
        const rows = await dependencies.loadUserSavedProviders(scope.userId);
        const config = rows.find((r) => r.provider.toLowerCase() === route.provider.toLowerCase());
        const currentEnabled = Boolean(config?.model_randomizer_enabled);

        const action = await performPanelAction(
          () =>
            dependencies.operations.setRandomizer({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              provider: route.provider,
              enabled: !currentEnabled,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "no-changes") {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "models",
            page: "fallbacks",
            panelReceipt: noChangesReceipt(route.locale),
            dependencies,
            selectedFallbacksProvider: route.provider,
          });
          return;
        }

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.randomizer.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          const isEnabled = result.enabled;
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "models",
            page: "fallbacks",
            panelReceipt: {
              tone: "success",
              heading: localizer(
                route.locale,
                isEnabled
                  ? "commands.personal.config.randomizer_enabled_heading"
                  : "commands.personal.config.randomizer_disabled_heading",
              ),
              detail: localizer(
                route.locale,
                isEnabled
                  ? "commands.personal.config.randomizer_enabled_detail"
                  : "commands.personal.config.randomizer_disabled_detail",
                { provider: getProviderDisplayName(route.provider) },
              ),
            },
            dependencies,
            selectedFallbacksProvider: route.provider,
          });
          return;
        }

        const isRequiresFallback = result.status === "requires-fallbacks";

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "models",
          page: "fallbacks",
          panelReceipt: {
            tone: "error",
            heading: localizer(
              route.locale,
              isRequiresFallback
                ? "commands.personal.config.randomizer_requires_fallback_heading"
                : "commands.personal.config.write_failed_heading",
            ),
            detail: isRequiresFallback
              ? localizer(route.locale, "commands.personal.config.randomizer_requires_fallback_detail")
              : localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
          selectedFallbacksProvider: route.provider,
        });
        return;
      }

      if (route.action === "trigger-mode-set") {
        if (scope.readStatus !== "fresh") {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "response-modes",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }
        const currentMode = scope.user.personal_dtm ?? "follow";
        if (currentMode === route.mode) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "response-modes",
            panelReceipt: noChangesReceipt(route.locale),
            dependencies,
          });
          return;
        }
        const action = await performPanelAction(
          () =>
            dependencies.operations.setTriggerMode({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              mode: route.mode,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;
        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.trigger-mode.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "response-modes",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.trigger_mode_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.trigger_mode_updated_detail", {
                mode: localizer(route.locale, `commands.personal.config.mode_${route.mode}`),
              }),
            },
            dependencies,
          });
          return;
        }
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "response-modes",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
        return;
      }

      if (route.action === "tool-mode-set") {
        if (scope.readStatus !== "fresh") {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "response-modes",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }
        const currentMode = scope.user.personal_deliberate_tool_mode ?? "follow";
        if (currentMode === route.mode) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "response-modes",
            panelReceipt: noChangesReceipt(route.locale),
            dependencies,
          });
          return;
        }
        const action = await performPanelAction(
          () =>
            dependencies.operations.setToolMode({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              mode: route.mode,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;
        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.tool-mode.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "response-modes",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.tool_mode_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.tool_mode_updated_detail", {
                mode: localizer(route.locale, `commands.personal.config.mode_${route.mode}`),
              }),
            },
            dependencies,
          });
          return;
        }
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "response-modes",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
        return;
      }

      if (route.action === "impersonation-submit") {
        if (!interaction.isModalSubmit()) throw new Error("impersonation-submit requires ModalSubmit interaction");
        const modal = interaction as ModalSubmitInteraction;
        if (scope.readStatus !== "fresh") {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "impersonation",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }
        const fieldId = buildPersonalConfigModalFieldId("prompt", route.nonce);
        const rawPrompt = modal.fields.getTextInputValue(fieldId).trim();
        if (!rawPrompt) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "impersonation",
            panelReceipt: {
              tone: "info",
              heading: localizer(route.locale, "commands.personal.config.impersonation_blank_refusal_heading"),
              detail: localizer(route.locale, "commands.personal.config.impersonation_blank_refusal_detail"),
            },
            dependencies,
          });
          return;
        }
        if (rawPrompt === scope.user.impersonation_prompt?.trim()) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "impersonation",
            panelReceipt: noChangesReceipt(route.locale),
            dependencies,
          });
          return;
        }
        const action = await performPanelAction(
          () =>
            dependencies.operations.setImpersonationPrompt({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              prompt: rawPrompt,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;
        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.impersonation.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "impersonation",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.impersonation_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.impersonation_updated_detail"),
            },
            dependencies,
          });
          return;
        }
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "impersonation",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
        return;
      }

      if (route.action === "impersonation-clear-view") {
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "impersonation",
          dependencies,
          view: {
            kind: "impersonation-clear-confirm",
            nonce: dependencies.createNonce(),
          },
        });
        return;
      }

      if (route.action === "impersonation-clear-cancel") {
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "impersonation",
          dependencies,
        });
        return;
      }

      if (route.action === "impersonation-clear-confirm") {
        if (scope.readStatus !== "fresh") {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "impersonation",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }
        if (!scope.user.impersonation_prompt) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "impersonation",
            panelReceipt: noChangesReceipt(route.locale),
            dependencies,
          });
          return;
        }
        const action = await performPanelAction(
          () =>
            dependencies.operations.setImpersonationPrompt({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              prompt: null,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;
        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.impersonation.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "impersonation",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.impersonation_cleared_heading"),
              detail: localizer(route.locale, "commands.personal.config.impersonation_cleared_detail"),
            },
            dependencies,
          });
          return;
        }
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "impersonation",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
        return;
      }

      if (route.action === "spotlight-set-step1" || route.action === "spotlight-set-block-page") {
        if (!scope.guildId || !scope.internalServerId) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.spotlight_guild_only_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
            },
            dependencies,
          });
          return;
        }

        const personas = await dependencies.loadGuildPersonas(scope.guildId);
        const fp = computeSpotlightSetFingerprint(scope.guildId, scope.userDiscId, personas);

        let channelId: string;
        let hours: number;
        let chooserPage = 0;

        if (route.action === "spotlight-set-block-page") {
          if (fp !== route.fp) {
            await repaint(interaction, {
              locale: route.locale,
              scope,
              category: "advanced",
              page: "spotlight",
              panelReceipt: {
                tone: "error",
                heading: localizer(route.locale, "commands.personal.config.unavailable"),
                detail: localizer(route.locale, "commands.personal.config.stale_warning"),
              },
              dependencies,
            });
            return;
          }
          channelId = route.channelId;
          hours = route.hours;
          chooserPage = route.chooserPage;
        } else {
          const modal = interaction as ModalSubmitInteraction;
          const rawChannelId = takeRawModalSelectValue(
            modal.id,
            buildPersonalConfigModalFieldId("channel", route.nonce),
          );
          if (!rawChannelId || !/^\d{17,20}$/.test(rawChannelId)) {
            await repaint(interaction, {
              locale: route.locale,
              scope,
              category: "advanced",
              page: "spotlight",
              panelReceipt: {
                tone: "error",
                heading: localizer(route.locale, "commands.personal.config.spotlight_invalid_channel_heading"),
                detail: localizer(route.locale, "commands.personal.config.spotlight_invalid_channel_detail"),
              },
              dependencies,
            });
            return;
          }
          const rawHours = modal.fields.getTextInputValue(buildPersonalConfigModalFieldId("hours", route.nonce)).trim();
          const parsedHours = Number.parseInt(rawHours, 10);
          if (Number.isNaN(parsedHours) || parsedHours < 0 || !/^\d+$/.test(rawHours)) {
            await repaint(interaction, {
              locale: route.locale,
              scope,
              category: "advanced",
              page: "spotlight",
              panelReceipt: {
                tone: "error",
                heading: localizer(route.locale, "commands.personal.config.spotlight_invalid_hours_heading"),
                detail: localizer(route.locale, "commands.personal.config.spotlight_invalid_hours_detail"),
              },
              dependencies,
            });
            return;
          }
          channelId = rawChannelId;
          hours = parsedHours;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "spotlight",
          dependencies,
          view: {
            kind: "spotlight-persona-select",
            channelId,
            hours,
            fp,
            totalPersonas: personas.length,
            chooserPage,
          },
        });
        return;
      }

      if (route.action === "spotlight-set-submit") {
        if (!interaction.isModalSubmit()) throw new Error("spotlight-set-submit requires ModalSubmit interaction");
        const modal = interaction as ModalSubmitInteraction;
        if (!scope.guildId || !scope.internalServerId) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.spotlight_guild_only_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
            },
            dependencies,
          });
          return;
        }
        if (scope.readStatus !== "fresh") {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }

        const personas = await dependencies.loadGuildPersonas(scope.guildId);
        const expectedFp = computeSpotlightSetFingerprint(scope.guildId, scope.userDiscId, personas);
        const blockStart = route.blockIdx * SPOTLIGHT_PERSONA_PAGE_SIZE;
        const block = personas.slice(blockStart, blockStart + SPOTLIGHT_PERSONA_PAGE_SIZE);
        if (expectedFp !== route.fp || block.length === 0) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }

        let bitmask = 0n;
        const selectedPersonaIds: number[] = [];
        for (let g = 0; g < SPOTLIGHT_PERSONA_PAGE_SIZE / 10; g++) {
          const groupValues = takeRawModalCheckboxGroupValues(
            modal.id,
            buildPersonalConfigModalFieldId(`personas_${g}`, route.nonce),
          );
          if (!groupValues) continue;
          for (const val of groupValues) {
            const pid = Number.parseInt(val, 10);
            const indexInBlock = block.findIndex((p) => p.id === pid);
            if (indexInBlock >= 0) {
              bitmask |= 1n << BigInt(indexInBlock);
              selectedPersonaIds.push(pid);
            }
          }
        }

        if (selectedPersonaIds.length === 0) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.spotlight_no_selection_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_no_selection_detail"),
            },
            dependencies,
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "spotlight",
          dependencies,
          view: {
            kind: "spotlight-set-review",
            channelId: route.channelId,
            hours: route.hours,
            blockIdx: route.blockIdx,
            selectedPersonaIds,
            autoTriggerPersonaId: null,
            autoIdx: 0,
            mask: encodeSpotlightMask(bitmask),
            fp: route.fp,
            nonce: dependencies.createNonce(),
          },
        });
        return;
      }

      if (route.action === "spot-set-auto-sub") {
        if (!interaction.isModalSubmit()) throw new Error("spot-set-auto-sub requires ModalSubmit interaction");
        const modal = interaction as ModalSubmitInteraction;
        if (!scope.guildId || !scope.internalServerId) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.spotlight_guild_only_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
            },
            dependencies,
          });
          return;
        }
        const personas = await dependencies.loadGuildPersonas(scope.guildId);
        const expectedFp = computeSpotlightSetFingerprint(scope.guildId, scope.userDiscId, personas);
        if (expectedFp !== route.fp) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }
        const resolvedSub = resolveSpotlightBlockSelection(personas, route.blockIdx, route.mask);
        if (!resolvedSub) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }
        const selectedPersonaIds = resolvedSub.selected.map((p) => p.id);

        const autoFieldId = buildPersonalConfigModalFieldId("auto_trigger", route.nonce);
        const rawAutoId = takeRawModalSelectValue(modal.id, autoFieldId) ?? "0";
        const autoTriggerId = Number.parseInt(rawAutoId, 10);
        const validAutoId =
          !Number.isNaN(autoTriggerId) && autoTriggerId > 0 && selectedPersonaIds.includes(autoTriggerId)
            ? autoTriggerId
            : null;
        const validAutoIdx = validAutoId === null ? 0 : resolvedSub.block.findIndex((p) => p.id === validAutoId) + 1;

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "spotlight",
          dependencies,
          view: {
            kind: "spotlight-set-review",
            channelId: route.channelId,
            hours: route.hours,
            blockIdx: route.blockIdx,
            selectedPersonaIds,
            autoTriggerPersonaId: validAutoId,
            autoIdx: validAutoIdx,
            mask: route.mask,
            fp: route.fp,
            nonce: dependencies.createNonce(),
          },
        });
        return;
      }

      if (route.action === "spot-set-cf") {
        const serverId = scope.internalServerId;
        if (!scope.guildId || serverId === null) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.spotlight_guild_only_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
            },
            dependencies,
          });
          return;
        }
        if (scope.readStatus !== "fresh") {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }
        // The channel arrives from the custom ID, so the select menu that produced it is not a guard.
        // A spotlight belongs to one guild text channel, and the write is keyed on the raw snowflake.
        const confirmChannel = interaction.guild?.channels.cache.get(route.channelId);
        if (!confirmChannel || confirmChannel.type !== ChannelType.GuildText) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.spotlight_invalid_channel_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_invalid_channel_detail"),
            },
            dependencies,
          });
          return;
        }

        const personas = await dependencies.loadGuildPersonas(scope.guildId);
        const expectedFp = computeSpotlightSetFingerprint(scope.guildId, scope.userDiscId, personas);
        if (expectedFp !== route.fp) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }
        const resolvedConfirm = resolveSpotlightBlockSelection(personas, route.blockIdx, route.mask);
        if (!resolvedConfirm) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }
        const selectedPersonaIds = resolvedConfirm.selected.map((p) => p.id);
        if (selectedPersonaIds.length === 0) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.spotlight_no_selection_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_no_selection_detail"),
            },
            dependencies,
          });
          return;
        }

        // The auto-trigger travels as a position inside the presented block rather than a persona ID,
        // because 50 explicit IDs do not fit beside a snowflake and a fingerprint in 100 characters.
        const autoPersona = route.autoIdx > 0 ? (resolvedConfirm.block[route.autoIdx - 1] ?? null) : null;

        // Silently writing null here would contradict the review page the user just confirmed, so a
        // chosen auto-trigger that no longer resolves is surfaced instead of dropped.
        if (route.autoIdx > 0 && (autoPersona === null || !selectedPersonaIds.includes(autoPersona.id))) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.spotlight_auto_stale_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_auto_stale_detail"),
            },
            dependencies,
          });
          return;
        }
        const autoTriggerPersonaId = autoPersona?.id ?? null;
        const expiresAt = route.hours === 0 ? null : new Date(Date.now() + route.hours * 60 * 60 * 1000);

        const action = await performPanelAction(
          () =>
            dependencies.operations.setSpotlight({
              serverId,
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              channelId: route.channelId,
              personaIds: selectedPersonaIds,
              autoTriggerPersonaId,
              expiresAt,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "no-changes") {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "info",
              heading: localizer(route.locale, "commands.personal.config.no_changes_heading"),
              detail: localizer(route.locale, "commands.personal.config.no_changes_detail"),
            },
            dependencies,
          });
          return;
        }

        if (result.status === "success") {
          dependencies.recordAction({
            action: "personal-config.personal.spotlight.set",
            serverId,
            userDiscId: interaction.user.id,
          });
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.spotlight_saved_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_saved_detail", {
                channel: route.channelId,
              }),
            },
            dependencies,
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "spotlight",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
        return;
      }

      if (route.action === "spotlight-set-cancel") {
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "spotlight",
          dependencies,
        });
        return;
      }

      if (route.action === "spotlight-remove-open") {
        if (!scope.guildId || !scope.internalServerId) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.spotlight_guild_only_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
            },
            dependencies,
          });
          return;
        }
        const activeSpotlights = await dependencies.loadActiveSpotlights(scope.internalServerId, scope.userId);
        if (activeSpotlights.length > SPOTLIGHT_REMOVE_PAGE_SIZE) {
          const fp = computeSpotlightRemoveFingerprint(scope.guildId, scope.userDiscId, activeSpotlights);
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            dependencies,
            view: {
              kind: "spotlight-remove-range",
              rangePage: 0,
              totalOptions: activeSpotlights.length,
              fp,
            },
          });
          return;
        }
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "spotlight",
          dependencies,
        });
        return;
      }

      if (route.action === "spotlight-remove-page") {
        const serverId = scope.internalServerId;
        if (!scope.guildId || serverId === null) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.spotlight_guild_only_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
            },
            dependencies,
          });
          return;
        }
        const activeSpotlights = await dependencies.loadActiveSpotlights(serverId, scope.userId);
        const expectedFp = computeSpotlightRemoveFingerprint(scope.guildId, scope.userDiscId, activeSpotlights);
        if (expectedFp !== route.fp) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "spotlight",
          dependencies,
          view: {
            kind: "spotlight-remove-range",
            rangePage: route.chooserPage,
            totalOptions: activeSpotlights.length,
            fp: route.fp,
          },
        });
        return;
      }

      if (route.action === "spotlight-remove-cancel") {
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "spotlight",
          dependencies,
        });
        return;
      }

      if (route.action === "spot-set-auto-page") {
        const serverId = scope.internalServerId;
        if (!scope.guildId || serverId === null) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.spotlight_guild_only_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
            },
            dependencies,
          });
          return;
        }
        const personas = await dependencies.loadGuildPersonas(scope.guildId);
        const expectedFp = computeSpotlightSetFingerprint(scope.guildId, scope.userDiscId, personas);
        if (expectedFp !== route.fp) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }
        const bitmask = BigInt(`0x${route.mask}`);
        const selectedPersonas = personas.filter((_, i) => (bitmask & (1n << BigInt(i))) !== 0n);
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "spotlight",
          dependencies,
          view: {
            kind: "spotlight-auto-range",
            channelId: route.channelId,
            hours: route.hours,
            blockIdx: route.blockIdx,
            mask: route.mask,
            fp: route.fp,
            rangePage: route.chooserPage,
            totalOptions: selectedPersonas.length,
          },
        });
        return;
      }

      if (route.action === "spot-set-auto-cancel") {
        const serverId = scope.internalServerId;
        if (!scope.guildId || serverId === null) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.spotlight_guild_only_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
            },
            dependencies,
          });
          return;
        }
        const personas = await dependencies.loadGuildPersonas(scope.guildId);
        const expectedFp = computeSpotlightSetFingerprint(scope.guildId, scope.userDiscId, personas);
        if (expectedFp !== route.fp) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }
        const resolvedCancel = resolveSpotlightBlockSelection(personas, route.blockIdx, route.mask);
        if (!resolvedCancel) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }
        const selectedPersonaIds = resolvedCancel.selected.map((p) => p.id);
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "spotlight",
          dependencies,
          view: {
            kind: "spotlight-set-review",
            channelId: route.channelId,
            hours: route.hours,
            blockIdx: route.blockIdx,
            selectedPersonaIds,
            autoTriggerPersonaId: null,
            autoIdx: 0,
            mask: route.mask,
            fp: route.fp,
            nonce: dependencies.createNonce(),
          },
        });
        return;
      }

      if (route.action === "spotlight-remove-submit") {
        if (!interaction.isModalSubmit()) throw new Error("spotlight-remove-submit requires ModalSubmit interaction");
        const modal = interaction as ModalSubmitInteraction;
        const serverId = scope.internalServerId;
        if (!scope.guildId || serverId === null) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.spotlight_guild_only_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
            },
            dependencies,
          });
          return;
        }
        if (scope.readStatus !== "fresh") {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }

        const activeSpotlights = await dependencies.loadActiveSpotlights(serverId, scope.userId);
        const expectedFp = computeSpotlightRemoveFingerprint(scope.guildId, scope.userDiscId, activeSpotlights);
        if (expectedFp !== route.fp) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }
        const presentedSlice = activeSpotlights.slice(route.start, route.start + SPOTLIGHT_REMOVE_PAGE_SIZE);
        const keptChannelIds = new Set<string>();
        const presentedChannelIds: string[] = [];

        for (let g = 0; g < 5 && g * 10 < presentedSlice.length; g++) {
          const chunk = presentedSlice.slice(g * 10, (g + 1) * 10);
          for (const entry of chunk) {
            presentedChannelIds.push(entry.channelDiscId);
          }
          const groupValues = takeRawModalCheckboxGroupValues(
            modal.id,
            buildPersonalConfigModalFieldId(`spotlights_${g}`, route.nonce),
          );
          if (groupValues) {
            for (const val of groupValues) {
              keptChannelIds.add(val);
            }
          }
        }

        const removedChannelIds = presentedChannelIds.filter((chId) => !keptChannelIds.has(chId));
        if (removedChannelIds.length === 0) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: noChangesReceipt(route.locale),
            dependencies,
          });
          return;
        }

        const action = await performPanelAction(
          () =>
            dependencies.operations.removeSpotlights({
              serverId,
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              channelIds: removedChannelIds,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "success") {
          dependencies.recordAction({
            action: "personal-config.personal.spotlight.remove",
            serverId,
            userDiscId: interaction.user.id,
          });
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.spotlight_removed_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_removed_detail", {
                removed_count: result.removedCount,
              }),
            },
            dependencies,
          });
          return;
        }

        if (result.status === "partial-failure") {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "warning",
              heading: localizer(route.locale, "commands.personal.config.spotlight_partial_removal_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_partial_removal_detail", {
                removed_count: result.removedCount,
                failed_count: result.failedCount,
              }),
            },
            dependencies,
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "spotlight",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
        return;
      }

      if (route.action === "retry" || route.action === "refresh") {
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: route.category,
          page: route.page,
          selectedLineageId: route.lineageId,
          dependencies,
        });
        return;
      }
    },
  };
}

export const personalConfigInteractionRoute = createPersonalConfigInteractionRoute();

export type PersonalConfigPanelPayloadOrTerminal =
  | ReturnType<typeof buildPersonalConfigPanelPayload>
  | InteractionEditReplyOptions;

export async function buildInitialPersonalConfigPanel(
  interaction: ChatInputCommandInteraction,
  locale: string,
  dependenciesOverride?: Partial<PersonalConfigRouteDependencies>,
): Promise<PersonalConfigPanelPayloadOrTerminal> {
  const dependencies: PersonalConfigRouteDependencies = {
    ...defaultDependencies,
    ...dependenciesOverride,
  };
  const scope = await dependencies.resolveScope(interaction);
  if (!scope) {
    return terminalPayload(locale, "commands.personal.config.unavailable") as PersonalConfigPanelPayloadOrTerminal;
  }
  return buildPersonalConfigPanelPayload({
    locale,
    category: "profile",
    page: "general",
    user: scope.user,
    resolvedNickname: scope.resolvedNickname,
    personas: scope.personas,
    guildId: scope.guildId,
    // Only the privacy page renders these, and the panel always opens on profile, so the counts are
    // never read here. Changing the opening category means fetching them, as `repaint` does.
    memoryCount: 0,
    stmCount: 0,
    readStatus: scope.readStatus,
  });
}
