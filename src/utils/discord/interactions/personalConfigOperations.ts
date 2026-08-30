import { DEFAULT_THINKING_LEVEL, isThinkingLevelValue } from "@/constants/thinkingLevels";
import {
  PrivacyLevel,
  type FallbackModelRef,
  type PersonalProviderCapability,
  type UserSavedProviderConfigUpsert,
} from "@/types/db/schema";
import {
  getCachedPersonalSpotlightStatus,
  invalidatePersonalSpotlightCache,
} from "@/utils/cache/personalSpotlightCache";
import { invalidateUserCache } from "@/utils/cache/userCache";
import { llmModelRepo, llmProviderRepo, userNamingRepository, userRepository } from "@/utils/db/repositories";
import type { ModelParameterOptions } from "@/utils/discord/modelParametersConfigMapping";
import {
  QUICK_TOGGLE_CAPABILITIES,
  type PersonalConfigManagedCapability,
} from "@/utils/discord/personalConfigPanelCatalog";
import { loadAvailableModelsForCapability } from "@/utils/discord/interactions/personalConfigLoaders";
import { parseAndValidateImageTags } from "@/utils/image/tagHelpers";
import { log } from "@/utils/misc/logger";
import { isCustomProvider, parseCustomProvider } from "@/utils/provider/customProviderUtils";
import {
  buildFallbackModelPersistence,
  getFallbackModelRefKey,
  getPrimaryFallbackRefKeys,
} from "@/utils/provider/fallbackModelIdentity";
import {
  assignPersonalCapabilityToProvider,
  getActivePersonalProviderForCapability,
  getStoredPersonalProviderForCapability,
  hasConfiguredPersonalModel,
  setPersonalCapabilityEnabled,
  withPersonalTextPrimary,
} from "@/utils/provider/personalProviderHelpers";
import {
  loadUserSavedProvidersForCapability,
  type SavedProviderCapability,
} from "@/utils/provider/savedProviderConfig";

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
