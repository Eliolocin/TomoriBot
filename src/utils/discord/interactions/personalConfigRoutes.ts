import {
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
import type { PanelReadStatus, PanelReceipt } from "@/types/discord/panel";
import type { UserPersonaNamingPreference } from "@/types/personaNaming";
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
import {
  PERSONAL_CONFIG_ROUTE_NAMESPACE,
  PERSONAL_CONFIG_ROUTE_VERSION,
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
  buildTimezoneModal,
  type PersonalConfigFallbackDisplaySlot,
  type PersonalConfigModelDisplayInfo,
  type PersonalConfigPanelView,
  type PersonalConfigRoutingRow,
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
  activatesNewPersonalOverride,
  assignPersonalCapabilityToProvider,
  findNewlyEnabledPersonalCapabilities,
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
import { loadUserSavedProvidersForCapability } from "@/utils/provider/savedProviderConfig";
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
    interaction: ButtonInteraction,
    locale: string,
    nonce: string,
    provider: string,
    availableOptions: Array<{ refKey: string; label: string }>,
    currentRefs: FallbackModelRef[],
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

  async setAppearance({ userId, userDiscId, rawTags }) {
    if (rawTags.trim().length === 0) {
      const ok = await userRepository.update(userId, { physical_appearance_tags: [] });
      if (!ok) return { status: "write-failed" };
      invalidateUserCache(userDiscId);
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
    invalidateUserCache(userDiscId);
    return { status: "success", tags: validation.tags };
  },

  async setPrivacyLevel({ userId: _userId, userDiscId, level }) {
    if (![PrivacyLevel.MINIMAL, PrivacyLevel.PARTIAL, PrivacyLevel.FULL].includes(level)) {
      return { status: "invalid-value" };
    }
    const updated = await userRepository.setPrivacyLevel(userDiscId, level);
    if (!updated) return { status: "write-failed" };
    invalidateUserCache(userDiscId);
    return { status: "success" };
  },

  async toggleCrossServerStm({ userDiscId }) {
    try {
      const enabled = await userRepository.toggleCrossServerShmOptIn(userDiscId);
      invalidateUserCache(userDiscId);
      return { status: "success", enabled };
    } catch {
      return { status: "write-failed" };
    }
  },

  async setCapabilityModel({ userId, userDiscId: _userDiscId, capability, provider, modelId }) {
    const underlyingCap: PersonalProviderCapability =
      capability === "image_nai" ? "image" : (capability as PersonalProviderCapability);
    if (!Number.isInteger(modelId) || modelId <= 0) return { status: "write-failed" };

    const eligibleRows = await loadUserSavedProvidersForCapability(userId, underlyingCap);
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
    const activeRow = getActivePersonalProviderForCapability(eligibleRows, underlyingCap);
    if (currentModelId === modelId && activeRow?.provider.toLowerCase() === provider.toLowerCase()) {
      return { status: "no-changes" };
    }

    const endpoints = await llmProviderRepo.loadCustomEndpointsForUser(userId);

    const ok = await assignPersonalCapabilityToProvider(userId, provider, underlyingCap, (row) => {
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

    const ALL_CAPS: PersonalProviderCapability[] = ["text", "vision", "embedding", "image", "video"];
    const hasChange = ALL_CAPS.some(
      (cap) => (getActivePersonalProviderForCapability(rows, cap) !== null) !== selectedCapabilities.has(cap),
    );
    if (!hasChange) return { status: "no-changes" };

    let allWritesSucceeded = true;
    for (const cap of ALL_CAPS) {
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
    const providerName = getProviderDisplayName(row.provider);
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
    return modelName ? `${providerName} · ${modelName}` : null;
  };

  const textActive = getActivePersonalProviderForCapability(savedProviders, "text");
  const visionActive = getActivePersonalProviderForCapability(savedProviders, "vision");
  const embeddingActive = getActivePersonalProviderForCapability(savedProviders, "embedding");
  const imageActive = getActivePersonalProviderForCapability(savedProviders, "image");
  const videoActive = getActivePersonalProviderForCapability(savedProviders, "video");

  const textStored = getStoredPersonalProviderForCapability(savedProviders, "text");
  const visionStored = getStoredPersonalProviderForCapability(savedProviders, "vision");
  const embeddingStored = getStoredPersonalProviderForCapability(savedProviders, "embedding");
  const imageStored = getStoredPersonalProviderForCapability(savedProviders, "image");
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
    imageActive?.diffusion_model_id ? resolveCapName(imageActive, "image") : Promise.resolve(null),
    imageActive?.nai_diffusion_model_id ? resolveCapName(imageActive, "image_nai") : Promise.resolve(null),
    resolveCapName(videoActive, "video"),
    resolveCapName(textStored, "text"),
    resolveCapName(visionStored, "vision"),
    resolveCapName(embeddingStored, "embedding"),
    imageStored?.diffusion_model_id ? resolveCapName(imageStored, "image") : Promise.resolve(null),
    imageStored?.nai_diffusion_model_id ? resolveCapName(imageStored, "image_nai") : Promise.resolve(null),
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
      storedProvider: imageStored?.provider ?? null,
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

async function repaint(
  interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
  locale: string,
  scope: PersonalConfigScope,
  category: PersonalConfigCategory,
  page: PersonalConfigPage,
  selectedLineageId?: number,
  panelReceipt?: PanelReceipt,
  dependencies: PersonalConfigRouteDependencies = defaultDependencies,
  selectedCapability?: PersonalConfigManagedCapability,
  selectedParametersProvider?: string,
  selectedFallbacksProvider?: string,
  view?: PersonalConfigPanelView,
): Promise<void> {
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

  await interaction.editReply(
    buildPersonalConfigPanelPayload({
      locale,
      category,
      page,
      user: scope.user,
      resolvedNickname: scope.resolvedNickname,
      personas: scope.personas,
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
  operations: personalConfigOperations,
  recordAction: (input) => {
    void recordPanelActionStat(input);
  },
  createNonce: () => crypto.randomUUID().replaceAll("-", "").slice(0, 12),
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
};

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

      if (route.action === "fallbacks-open") {
        if (!interaction.isButton()) throw new Error("fallbacks-open requires Button interaction");
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

        if (availableOptions.length > 24) {
          await interaction.deferUpdate();
          await repaint(
            interaction,
            route.locale,
            cachedScope,
            "models",
            "fallbacks",
            undefined,
            undefined,
            dependencies,
            undefined,
            undefined,
            route.provider,
            {
              kind: "fallbacks-range",
              provider: route.provider,
              rangePage: 0,
              totalOptions: availableOptions.length,
            },
          );
          return;
        }

        const nonce = dependencies.createNonce();
        await dependencies.showFallbacksModal(
          interaction,
          route.locale,
          nonce,
          route.provider,
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
        const slice = availableOptions.slice(route.start, route.start + 24);
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
        if (route.start % 25 !== 0 || route.start >= availableModels.length) {
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
        const slice = availableModels.slice(route.start, route.start + 25);
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
            await repaint(
              interaction,
              route.locale,
              cachedScope,
              "models",
              "switch",
              undefined,
              {
                tone: "error",
                heading: localizer(route.locale, "commands.personal.config.no_models_available_heading"),
                detail: localizer(route.locale, "commands.personal.config.no_models_available_detail", {
                  provider: getProviderDisplayName(provider),
                }),
              },
              dependencies,
              route.capability,
            );
            return;
          }

          if (availableModels.length > 25) {
            await interaction.deferUpdate();
            await repaint(
              interaction,
              route.locale,
              cachedScope,
              "models",
              "switch",
              undefined,
              undefined,
              dependencies,
              route.capability,
              undefined,
              undefined,
              {
                kind: "model-range",
                capability: route.capability,
                provider,
                rangePage: 0,
                totalOptions: availableModels.length,
              },
            );
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
        await repaint(
          interaction,
          route.locale,
          scope,
          route.category,
          route.page,
          route.category === "profile" && route.page === "persona" ? scope.personas[0]?.persona_lineage_id : undefined,
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "page") {
        const selectMenu = interaction as StringSelectMenuInteraction;
        const selectedPage = (selectMenu.values[0] as PersonalConfigPage) ?? route.page;
        await repaint(
          interaction,
          route.locale,
          scope,
          route.category,
          selectedPage,
          route.category === "profile" && selectedPage === "persona"
            ? scope.personas[0]?.persona_lineage_id
            : undefined,
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "persona-select") {
        const selectMenu = interaction as StringSelectMenuInteraction;
        const selectedLineage = Number(selectMenu.values[0]);
        const validLineage = scope.personas.some((p) => p.persona_lineage_id === selectedLineage)
          ? selectedLineage
          : (scope.personas[0]?.persona_lineage_id ?? 0);
        await repaint(interaction, route.locale, scope, "profile", "persona", validLineage, undefined, dependencies);
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
          await repaint(
            interaction,
            route.locale,
            scope,
            "profile",
            "general",
            undefined,
            {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.language_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.language_updated_detail", {
                language: langLabel,
              }),
            },
            dependencies,
          );
          return;
        }

        await repaint(
          interaction,
          route.locale,
          scope,
          "profile",
          "general",
          undefined,
          {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        );
        return;
      }

      if (route.action === "timezone-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const fieldId = buildPersonalConfigModalFieldId("timezone", route.nonce);
        const rawOffset = modal.fields.getTextInputValue(fieldId).trim();
        const parsedOffset = Number(rawOffset);

        if (Number.isNaN(parsedOffset) || parsedOffset < -12 || parsedOffset > 14) {
          await repaint(
            interaction,
            route.locale,
            scope,
            "profile",
            "general",
            undefined,
            {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.invalid_timezone_heading"),
              detail: localizer(route.locale, "commands.personal.config.invalid_timezone_detail"),
            },
            dependencies,
          );
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
          await repaint(
            interaction,
            route.locale,
            scope,
            "profile",
            "general",
            undefined,
            {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.timezone_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.timezone_updated_detail", {
                timezone: formatUTCOffset(parsedOffset),
              }),
            },
            dependencies,
          );
          return;
        }

        await repaint(
          interaction,
          route.locale,
          scope,
          "profile",
          "general",
          undefined,
          {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        );
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
          await repaint(
            interaction,
            route.locale,
            scope,
            "profile",
            "general",
            undefined,
            {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.timezone_cleared_heading"),
              detail: localizer(route.locale, "commands.personal.config.timezone_cleared_detail"),
            },
            dependencies,
          );
          return;
        }

        await repaint(
          interaction,
          route.locale,
          scope,
          "profile",
          "general",
          undefined,
          {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        );
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
          await repaint(
            interaction,
            route.locale,
            scope,
            "profile",
            "general",
            undefined,
            {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.naming_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.naming_updated_detail"),
            },
            dependencies,
          );
          return;
        }

        await repaint(
          interaction,
          route.locale,
          scope,
          "profile",
          "general",
          undefined,
          {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        );
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
          await repaint(
            interaction,
            route.locale,
            scope,
            "profile",
            "persona",
            route.lineageId,
            {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.naming_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.naming_updated_detail"),
            },
            dependencies,
          );
          return;
        }

        await repaint(
          interaction,
          route.locale,
          scope,
          "profile",
          "persona",
          route.lineageId,
          {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        );
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
          await repaint(
            interaction,
            route.locale,
            scope,
            "profile",
            "general",
            undefined,
            {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.about_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.about_updated_detail"),
            },
            dependencies,
          );
          return;
        }

        await repaint(
          interaction,
          route.locale,
          scope,
          "profile",
          "general",
          undefined,
          {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        );
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
          await repaint(
            interaction,
            route.locale,
            scope,
            "profile",
            "appearance",
            undefined,
            {
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
          );
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

        await repaint(
          interaction,
          route.locale,
          scope,
          "profile",
          "appearance",
          undefined,
          {
            tone,
            heading: localizer(route.locale, headingKey),
            detail: localizer(route.locale, detailKey, vars),
          },
          dependencies,
        );
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

          await repaint(
            interaction,
            route.locale,
            scope,
            "privacy",
            "controls",
            undefined,
            {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.privacy_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.privacy_updated_detail", {
                level: levelName,
              }),
            },
            dependencies,
          );
          return;
        }

        await repaint(
          interaction,
          route.locale,
          scope,
          "privacy",
          "controls",
          undefined,
          {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        );
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
          await repaint(
            interaction,
            route.locale,
            scope,
            "privacy",
            "controls",
            undefined,
            {
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
          );
          return;
        }

        await repaint(
          interaction,
          route.locale,
          scope,
          "privacy",
          "controls",
          undefined,
          {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        );
        return;
      }

      if (route.action === "capability-select") {
        const selectMenu = interaction as StringSelectMenuInteraction;
        const chosenCap = (selectMenu.values[0] as PersonalConfigManagedCapability) ?? "text";
        await repaint(
          interaction,
          route.locale,
          scope,
          "models",
          "switch",
          undefined,
          undefined,
          dependencies,
          chosenCap,
        );
        return;
      }

      if (route.action === "parameters-provider-select") {
        const selectMenu = interaction as StringSelectMenuInteraction;
        const chosenProvider = decodeProviderParam(selectMenu.values[0]);
        await repaint(
          interaction,
          route.locale,
          scope,
          "models",
          "parameters",
          undefined,
          undefined,
          dependencies,
          undefined,
          chosenProvider,
        );
        return;
      }

      if (route.action === "fallbacks-provider-select") {
        const selectMenu = interaction as StringSelectMenuInteraction;
        const chosenProvider = decodeProviderParam(selectMenu.values[0]);
        await repaint(
          interaction,
          route.locale,
          scope,
          "models",
          "fallbacks",
          undefined,
          undefined,
          dependencies,
          undefined,
          undefined,
          chosenProvider,
        );
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
            const capLabel = localizer(
              route.locale,
              `commands.personal.config.routing_${cap === "image" ? "image_standard" : cap}`,
            );
            await repaint(
              interaction,
              route.locale,
              scope,
              "models",
              "switch",
              undefined,
              {
                tone: "error",
                heading: localizer(route.locale, "commands.personal.config.missing_model_heading"),
                detail: localizer(route.locale, "commands.personal.config.missing_model_detail", {
                  capability: capLabel,
                }),
              },
              dependencies,
            );
            return;
          }
        }

        const ALL_CAPS: PersonalProviderCapability[] = ["text", "vision", "embedding", "image", "video"];
        const hasChange = ALL_CAPS.some(
          (cap) => (getActivePersonalProviderForCapability(rows, cap) !== null) !== selectedCapSet.has(cap),
        );
        if (!hasChange) {
          await repaint(
            interaction,
            route.locale,
            scope,
            "models",
            "switch",
            undefined,
            {
              tone: "info",
              heading: localizer(route.locale, "commands.personal.config.no_changes_heading"),
              detail: localizer(route.locale, "commands.personal.config.no_changes_detail"),
            },
            dependencies,
          );
          return;
        }

        const newlyEnabled = findNewlyEnabledPersonalCapabilities(rows, selectedCapSet, ALL_CAPS);
        if (newlyEnabled.length > 0) {
          const mask = ALL_CAPS.map((c) => (selectedCapSet.has(c) ? "1" : "0")).join("");
          await repaint(
            interaction,
            route.locale,
            scope,
            "models",
            "switch",
            undefined,
            undefined,
            dependencies,
            undefined,
            undefined,
            undefined,
            {
              kind: "quick-toggle-confirm",
              mask,
              newlyEnabledCaps: newlyEnabled,
              nonce: dependencies.createNonce(),
            },
          );
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
          await repaint(
            interaction,
            route.locale,
            scope,
            "models",
            "switch",
            undefined,
            noChangesReceipt(route.locale),
            dependencies,
          );
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
          await repaint(
            interaction,
            route.locale,
            scope,
            "models",
            "switch",
            undefined,
            {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.routing_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.routing_updated_detail"),
            },
            dependencies,
          );
          return;
        }

        await repaint(
          interaction,
          route.locale,
          scope,
          "models",
          "switch",
          undefined,
          {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        );
        return;
      }

      if (route.action === "quick-toggle-confirm") {
        const ALL_CAPS: PersonalProviderCapability[] = ["text", "vision", "embedding", "image", "video"];
        const selectedCapSet = new Set<PersonalProviderCapability>();
        for (let i = 0; i < ALL_CAPS.length; i++) {
          if (route.mask[i] === "1") selectedCapSet.add(ALL_CAPS[i]);
        }

        const rows = await dependencies.loadUserSavedProviders(scope.userId);
        for (const cap of selectedCapSet) {
          const target = getStoredPersonalProviderForCapability(rows, cap);
          if (!target || !hasConfiguredPersonalModel(target, cap)) {
            const capLabel = localizer(
              route.locale,
              `commands.personal.config.routing_${cap === "image" ? "image_standard" : cap}`,
            );
            await repaint(
              interaction,
              route.locale,
              scope,
              "models",
              "switch",
              undefined,
              {
                tone: "error",
                heading: localizer(route.locale, "commands.personal.config.missing_model_heading"),
                detail: localizer(route.locale, "commands.personal.config.missing_model_detail", {
                  capability: capLabel,
                }),
              },
              dependencies,
            );
            return;
          }
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
          await repaint(
            interaction,
            route.locale,
            scope,
            "models",
            "switch",
            undefined,
            noChangesReceipt(route.locale),
            dependencies,
          );
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
          await repaint(
            interaction,
            route.locale,
            scope,
            "models",
            "switch",
            undefined,
            {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.routing_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.routing_updated_detail"),
            },
            dependencies,
          );
          return;
        }

        await repaint(
          interaction,
          route.locale,
          scope,
          "models",
          "switch",
          undefined,
          {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        );
        return;
      }

      if (route.action === "quick-toggle-cancel" || route.action === "model-act-cancel") {
        await repaint(
          interaction,
          route.locale,
          scope,
          "models",
          "switch",
          undefined,
          {
            tone: "info",
            heading: localizer(route.locale, "commands.personal.config.activation_cancelled_heading"),
            detail: localizer(route.locale, "commands.personal.config.activation_cancelled_detail"),
          },
          dependencies,
        );
        return;
      }

      if (route.action === "model-enable") {
        const underlyingCap: PersonalProviderCapability =
          route.capability === "image_nai" ? "image" : (route.capability as PersonalProviderCapability);

        const rows = await dependencies.loadUserSavedProviders(scope.userId);
        const target = getStoredPersonalProviderForCapability(rows, underlyingCap);
        const storedModelId = target
          ? route.capability === "text"
            ? target.llm_id
            : route.capability === "vision"
              ? target.vision_llm_id
              : route.capability === "embedding"
                ? target.embedding_model_id
                : route.capability === "image"
                  ? target.diffusion_model_id
                  : route.capability === "image_nai"
                    ? target.nai_diffusion_model_id
                    : target.video_model_id
          : null;
        const availableModels =
          target && storedModelId
            ? await dependencies.loadAvailableModelsForCapability(scope.userId, target.provider, route.capability)
            : [];
        const storedModel = availableModels.find((model) => model.id === storedModelId);
        if (!target || !storedModelId || !storedModel) {
          const capLabel = localizer(
            route.locale,
            `commands.personal.config.routing_${route.capability === "image_nai" ? "image_nai" : route.capability === "image" ? "image_standard" : route.capability}`,
          );
          await repaint(
            interaction,
            route.locale,
            scope,
            "models",
            "switch",
            undefined,
            {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.missing_model_heading"),
              detail: localizer(route.locale, "commands.personal.config.missing_model_detail", {
                capability: capLabel,
              }),
            },
            dependencies,
            route.capability,
          );
          return;
        }

        const activatesOverride = activatesNewPersonalOverride(rows, underlyingCap);
        if (activatesOverride) {
          await repaint(
            interaction,
            route.locale,
            scope,
            "models",
            "switch",
            undefined,
            undefined,
            dependencies,
            route.capability,
            undefined,
            undefined,
            {
              kind: "model-activate-confirm",
              capability: route.capability,
              provider: target.provider,
              modelId: storedModelId,
              modelName: storedModel.name,
              nonce: dependencies.createNonce(),
            },
          );
          return;
        }

        const action = await performPanelAction(
          () =>
            dependencies.operations.setCapabilityEnabled({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              capability: underlyingCap,
              enabled: true,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "no-changes") {
          await repaint(
            interaction,
            route.locale,
            scope,
            "models",
            "switch",
            undefined,
            noChangesReceipt(route.locale),
            dependencies,
            route.capability,
          );
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
          await repaint(
            interaction,
            route.locale,
            scope,
            "models",
            "switch",
            undefined,
            {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.routing_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.routing_updated_detail"),
            },
            dependencies,
            route.capability,
          );
          return;
        }

        await repaint(
          interaction,
          route.locale,
          scope,
          "models",
          "switch",
          undefined,
          {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
          route.capability,
        );
        return;
      }

      if (route.action === "model-default" || route.action === "model-provider-select") {
        const underlyingCap: PersonalProviderCapability =
          route.capability === "image_nai" ? "image" : (route.capability as PersonalProviderCapability);

        const action = await performPanelAction(
          () =>
            dependencies.operations.setCapabilityEnabled({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              capability: underlyingCap,
              enabled: false,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "no-changes") {
          await repaint(
            interaction,
            route.locale,
            scope,
            "models",
            "switch",
            undefined,
            noChangesReceipt(route.locale),
            dependencies,
            route.capability,
          );
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
          const capLabel = localizer(
            route.locale,
            `commands.personal.config.routing_${route.capability === "image_nai" ? "image_nai" : route.capability === "image" ? "image_standard" : route.capability}`,
          );
          await repaint(
            interaction,
            route.locale,
            scope,
            "models",
            "switch",
            undefined,
            {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.model_default_heading"),
              detail: localizer(route.locale, "commands.personal.config.model_default_detail", {
                capability: capLabel,
              }),
            },
            dependencies,
            route.capability,
          );
          return;
        }

        await repaint(
          interaction,
          route.locale,
          scope,
          "models",
          "switch",
          undefined,
          {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
          route.capability,
        );
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
          await repaint(
            interaction,
            route.locale,
            scope,
            "models",
            "switch",
            undefined,
            {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
              detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
            },
            dependencies,
            route.capability,
          );
          return;
        }

        const rows = await dependencies.loadUserSavedProviders(scope.userId);
        const underlyingCap: PersonalProviderCapability =
          route.capability === "image_nai" ? "image" : (route.capability as PersonalProviderCapability);
        const activatesOverride = activatesNewPersonalOverride(rows, underlyingCap);

        if (activatesOverride) {
          await repaint(
            interaction,
            route.locale,
            scope,
            "models",
            "switch",
            undefined,
            undefined,
            dependencies,
            route.capability,
            undefined,
            undefined,
            {
              kind: "model-activate-confirm",
              capability: route.capability,
              provider: route.provider,
              modelId,
              modelName: validModel.name,
              nonce: dependencies.createNonce(),
            },
          );
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
          await repaint(
            interaction,
            route.locale,
            scope,
            "models",
            "switch",
            undefined,
            noChangesReceipt(route.locale),
            dependencies,
            route.capability,
          );
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
          const capLabel = localizer(
            route.locale,
            `commands.personal.config.routing_${route.capability === "image_nai" ? "image_nai" : route.capability === "image" ? "image_standard" : route.capability}`,
          );
          await repaint(
            interaction,
            route.locale,
            scope,
            "models",
            "switch",
            undefined,
            {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.model_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.model_updated_detail", {
                capability: capLabel,
                provider: getProviderDisplayName(route.provider),
                model: validModel.name,
              }),
            },
            dependencies,
            route.capability,
          );
          return;
        }

        await repaint(
          interaction,
          route.locale,
          scope,
          "models",
          "switch",
          undefined,
          {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
          route.capability,
        );
        return;
      }

      if (route.action === "model-act-confirm") {
        const availableModels = await dependencies.loadAvailableModelsForCapability(
          scope.userId,
          route.provider,
          route.capability,
        );
        const validModel = availableModels.find((m) => m.id === route.modelId);

        if (!validModel || route.modelId === 0) {
          await repaint(
            interaction,
            route.locale,
            scope,
            "models",
            "switch",
            undefined,
            {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
              detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
            },
            dependencies,
            route.capability,
          );
          return;
        }

        const action = await performPanelAction(
          () =>
            dependencies.operations.setCapabilityModel({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              capability: route.capability,
              provider: route.provider,
              modelId: route.modelId,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "no-changes") {
          await repaint(
            interaction,
            route.locale,
            scope,
            "models",
            "switch",
            undefined,
            noChangesReceipt(route.locale),
            dependencies,
            route.capability,
          );
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
          const capLabel = localizer(
            route.locale,
            `commands.personal.config.routing_${route.capability === "image_nai" ? "image_nai" : route.capability === "image" ? "image_standard" : route.capability}`,
          );
          await repaint(
            interaction,
            route.locale,
            scope,
            "models",
            "switch",
            undefined,
            {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.model_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.model_updated_detail", {
                capability: capLabel,
                provider: getProviderDisplayName(route.provider),
                model: validModel.name,
              }),
            },
            dependencies,
            route.capability,
          );
          return;
        }

        await repaint(
          interaction,
          route.locale,
          scope,
          "models",
          "switch",
          undefined,
          {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
          route.capability,
        );
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
          await repaint(
            interaction,
            route.locale,
            scope,
            "models",
            "parameters",
            undefined,
            {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.parameters_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.parameters_updated_detail", {
                provider: getProviderDisplayName(route.provider),
              }),
            },
            dependencies,
            undefined,
            route.provider,
          );
          return;
        }

        const isInvalid = result.status === "invalid-value";
        const isNoChanges = result.status === "no-changes";

        await repaint(
          interaction,
          route.locale,
          scope,
          "models",
          "parameters",
          undefined,
          {
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
          undefined,
          route.provider,
        );
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
          await repaint(
            interaction,
            route.locale,
            scope,
            "models",
            "parameters",
            undefined,
            {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.parameters_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.parameters_updated_detail", {
                provider: getProviderDisplayName(route.provider),
              }),
            },
            dependencies,
            undefined,
            route.provider,
          );
          return;
        }

        const isInvalid = result.status === "invalid-value";
        const isNoChanges = result.status === "no-changes";

        await repaint(
          interaction,
          route.locale,
          scope,
          "models",
          "parameters",
          undefined,
          {
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
          undefined,
          route.provider,
        );
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
          await repaint(
            interaction,
            route.locale,
            scope,
            "models",
            "fallbacks",
            undefined,
            {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.fallbacks_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.fallbacks_updated_detail", {
                provider: getProviderDisplayName(route.provider),
              }),
            },
            dependencies,
            undefined,
            undefined,
            route.provider,
          );
          return;
        }

        const isConflict = result.status === "primary-conflict";
        const isNoChanges = result.status === "no-changes";

        await repaint(
          interaction,
          route.locale,
          scope,
          "models",
          "fallbacks",
          undefined,
          {
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
          undefined,
          undefined,
          route.provider,
        );
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
          await repaint(
            interaction,
            route.locale,
            scope,
            "models",
            "fallbacks",
            undefined,
            noChangesReceipt(route.locale),
            dependencies,
            undefined,
            undefined,
            route.provider,
          );
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
          await repaint(
            interaction,
            route.locale,
            scope,
            "models",
            "fallbacks",
            undefined,
            {
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
            undefined,
            undefined,
            route.provider,
          );
          return;
        }

        const isRequiresFallback = result.status === "requires-fallbacks";

        await repaint(
          interaction,
          route.locale,
          scope,
          "models",
          "fallbacks",
          undefined,
          {
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
          undefined,
          undefined,
          route.provider,
        );
        return;
      }

      if (route.action === "retry" || route.action === "refresh") {
        await repaint(
          interaction,
          route.locale,
          scope,
          route.category,
          route.page,
          route.lineageId,
          undefined,
          dependencies,
        );
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
    // Only the privacy page renders these, and the panel always opens on profile, so the counts are
    // never read here. Changing the opening category means fetching them, as `repaint` does.
    memoryCount: 0,
    stmCount: 0,
    readStatus: scope.readStatus,
  });
}
