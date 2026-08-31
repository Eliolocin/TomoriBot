import type { ChatInputCommandInteraction } from "discord.js";
import type { TomoriState, UserRow, UserSavedProviderConfigRow } from "@/types/db/schema";
import type { PanelReadStatus } from "@/types/discord/panel";
import type { UserPersonaNamingPreference } from "@/types/personaNaming";
import { getShortTermMemoriesForUser, preWarmUserStmEntries } from "@/utils/cache/shortTermMemoryCache";
import { getCachedUserRow } from "@/utils/cache/userCache";
import {
  llmModelRepo,
  llmProviderRepo,
  personaRepository,
  personalMemoryRepository,
  serverRepository,
  userNamingRepository,
  userRepository,
} from "@/utils/db/repositories";
import type { GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import type { PersonalConfigManagedCapability } from "@/utils/discord/personalConfigPanelCatalog";
import type {
  PersonalConfigFallbackDisplaySlot,
  PersonalConfigModelDisplayInfo,
  PersonalConfigRoutingRow,
} from "@/utils/discord/ui/personalConfigPanel";
import { log } from "@/utils/misc/logger";
import { parseCustomProvider } from "@/utils/provider/customProviderUtils";
import {
  getActivePersonalProviderForCapability,
  getStoredPersonalProviderForCapability,
} from "@/utils/provider/personalProviderHelpers";
import { loadUserSavedProvidersForCapability } from "@/utils/provider/savedProviderConfig";
import { resolvePersonaAvatarPublicUrl } from "@/utils/storage/avatarStorage";

export interface PersonalConfigScope {
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

export async function resolveScope(
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

export async function loadPersonaNamingPreference(
  userId: number,
  lineageId: number,
): Promise<UserPersonaNamingPreference | null> {
  const prefs = await userNamingRepository.loadPreferences([{ userId, personaLineageId: lineageId }]);
  return prefs.get(`${userId}:${lineageId}`) ?? null;
}

export async function getMemoryCount(userId: number): Promise<number> {
  return personalMemoryRepository.countAllForUser(userId);
}

export async function getStmCount(userDiscId: string): Promise<number> {
  await preWarmUserStmEntries(userDiscId);
  return getShortTermMemoriesForUser(userDiscId).length;
}

/**
 * Resolves the public face used beside a persona-scoped panel heading.
 *
 * Main personas speak as the bot, so their guild-specific member avatar is preferred. Alter
 * personas use their stored public avatar. Local paths deliberately return null because Discord
 * cannot fetch them for a Components V2 Thumbnail.
 */
export async function getPersonaAvatarUrl(
  interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
  persona: TomoriState,
): Promise<string | null> {
  if (persona.is_alter) {
    return resolvePersonaAvatarPublicUrl(persona.webhook_avatar_url);
  }
  const avatarOptions = { size: 256, extension: "png", forceStatic: true } as const;
  return (
    interaction.guild?.members.me?.displayAvatarURL(avatarOptions) ??
    interaction.client.user?.displayAvatarURL(avatarOptions) ??
    resolvePersonaAvatarPublicUrl(persona.webhook_avatar_url)
  );
}

export async function loadUserSavedProviders(userId: number): Promise<UserSavedProviderConfigRow[]> {
  return llmProviderRepo.loadUserSavedProviderConfigs(userId);
}

export async function loadAvailableModelsForCapability(
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

export async function loadFallbackSelectionOptions(
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

export async function loadPersonalModelDisplayInfo(
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
