import type {
  CustomEndpointCapability,
  DiffusionModelRow,
  LlmRow,
  SavedProviderConfigRow,
  SavedProviderConfigUpsert,
  AssembledServerConfig,
  TomoriState,
  UserSavedProviderConfigRow,
  UserSavedProviderConfigUpsert,
} from "@/types/db/schema";
import { llmModelRepo, llmProviderRepo } from "@/utils/db/repositories";
import { isCustomProvider, parseCustomProvider } from "@/utils/provider/customProviderUtils";
import {
  getStaticProviderInfo,
  supportsEmbeddingCapability,
  supportsImageCapability,
  supportsVideoCapability,
  supportsVisionCapability,
} from "@/utils/provider/providerInfoRegistry";

export type SavedProviderCapability = "text" | "embedding" | "image" | "video" | "vision";

export interface ProviderDefaultSelectionIds {
  llm_id: number | null;
  diffusion_model_id: number | null;
  embedding_model_id: number | null;
  nai_diffusion_model_id: number | null;
  video_model_id: number | null;
  vision_llm_id: number | null;
}

/**
 * Decide whether a saved text-model selection must fall back to the provider default.
 *
 * Active selections are preserved across credential updates, including deliberate
 * non-default choices. Missing, deprecated, or cross-provider references are not
 * usable and should be replaced with the provider's current default.
 *
 * @param provider - Provider owning the saved configuration
 * @param model - Model currently referenced by the saved configuration
 * @returns Whether the caller should load and store the current provider default
 */
export function shouldRefreshSavedTextModel(
  provider: string,
  model: Pick<LlmRow, "llm_provider" | "is_deprecated"> | null,
): boolean {
  return model === null || model.is_deprecated || model.llm_provider.toLowerCase() !== provider.toLowerCase();
}

/**
 * Decide whether a saved image-model selection must fall back to the provider default.
 *
 * Mirrors {@link shouldRefreshSavedTextModel} for `image_diffusion_models`, which backs both the
 * `diffusion_model_id` and `nai_diffusion_model_id` selections. Without this, a server stays
 * pointed at a codename the provider has retired and every generation fails.
 *
 * @param provider - Provider owning the saved configuration
 * @param model - Diffusion model currently referenced by the saved configuration
 * @returns Whether the caller should load and store the current provider default
 */
export function shouldRefreshSavedDiffusionModel(
  provider: string,
  model: Pick<DiffusionModelRow, "provider" | "is_deprecated"> | null,
): boolean {
  return model === null || model.is_deprecated || model.provider.toLowerCase() !== provider.toLowerCase();
}

export function buildSavedProviderSnapshotFromTomoriState(tomoriState: TomoriState): SavedProviderConfigUpsert {
  return {
    server_id: tomoriState.server_id,
    provider: tomoriState.llm.llm_provider.toLowerCase(),
    api_key: tomoriState.config.api_key,
    key_version: tomoriState.config.key_version ?? 1,
    llm_id: tomoriState.config.llm_id,
    diffusion_model_id: tomoriState.config.diffusion_model_id ?? null,
    embedding_model_id: tomoriState.config.embedding_model_id ?? null,
    nai_diffusion_model_id: tomoriState.config.nai_diffusion_model_id ?? null,
    video_model_id: tomoriState.config.video_model_id ?? null,
    vision_llm_id: tomoriState.config.vision_llm_id ?? null,
    nai_preset_name: tomoriState.config.nai_preset_name ?? null,
    llm_temperature: tomoriState.config.llm_temperature,
    llm_top_p: tomoriState.config.llm_top_p,
    llm_top_k: tomoriState.config.llm_top_k,
    llm_frequency_penalty: tomoriState.config.llm_frequency_penalty,
    llm_presence_penalty: tomoriState.config.llm_presence_penalty,
    llm_min_p: tomoriState.config.llm_min_p,
    llm_disabled_params: tomoriState.config.llm_disabled_params ?? [],
    llm_logit_biases: tomoriState.config.llm_logit_biases ?? [],
    thinking_level: tomoriState.config.thinking_level,
    fallback_model_refs: tomoriState.config.fallback_model_refs ?? [],
  };
}

export async function loadProviderDefaultSelectionIds(provider: string): Promise<ProviderDefaultSelectionIds> {
  const normalizedProvider = provider.toLowerCase();

  if (isCustomProvider(normalizedProvider)) {
    return {
      llm_id: null,
      diffusion_model_id: null,
      embedding_model_id: null,
      nai_diffusion_model_id: null,
      video_model_id: null,
      vision_llm_id: null,
    };
  }

  const [defaultTextModel, defaultEmbeddingModel, defaultDiffusionModel, defaultVideoModel] = await Promise.all([
    llmModelRepo.loadDefaultModel(normalizedProvider),
    llmModelRepo.loadDefaultEmbeddingModel(normalizedProvider),
    llmModelRepo.loadDefaultDiffusionModel(normalizedProvider),
    llmModelRepo.loadDefaultVideoGenerationModel(normalizedProvider),
  ]);

  const imageGenerationStyle = getStaticProviderInfo(normalizedProvider)?.featureSupport.imageGeneration ?? "none";

  return {
    llm_id: defaultTextModel?.llm_id ?? null,
    diffusion_model_id:
      imageGenerationStyle === "chat-completion" ? (defaultDiffusionModel?.diffusion_model_id ?? null) : null,
    embedding_model_id: defaultEmbeddingModel?.embedding_model_id ?? null,
    nai_diffusion_model_id:
      imageGenerationStyle === "nai-pipeline" ? (defaultDiffusionModel?.diffusion_model_id ?? null) : null,
    video_model_id: defaultVideoModel?.video_model_id ?? null,
    // Vision is an opt-in fallback slot, never seeded: a provider whose default text model happens
    // to see images would otherwise silently fill it with the model already answering chat.
    vision_llm_id: null,
  };
}

/**
 * Resolve which of the two saved image-model selections are unusable.
 *
 * Both `diffusion_model_id` and `nai_diffusion_model_id` index `image_diffusion_models`, so both
 * carry the same retirement exposure and are checked against their own provider default.
 *
 * @param provider - Normalized provider owning the saved configuration
 * @param existingConfig - Saved configuration being rebuilt, or null for a fresh one
 * @returns Whether each selection should be replaced with the provider default
 */
async function resolveDiffusionRefreshFlags(
  provider: string,
  existingConfig: {
    diffusion_model_id?: number | null;
    nai_diffusion_model_id?: number | null;
  } | null,
): Promise<{ refreshDiffusionModel: boolean; refreshNaiDiffusionModel: boolean }> {
  const diffusionModelId = existingConfig?.diffusion_model_id ?? null;
  const naiDiffusionModelId = existingConfig?.nai_diffusion_model_id ?? null;

  const [diffusionModel, naiDiffusionModel] = await Promise.all([
    diffusionModelId ? llmModelRepo.loadDiffusionModelById(diffusionModelId) : null,
    naiDiffusionModelId ? llmModelRepo.loadDiffusionModelById(naiDiffusionModelId) : null,
  ]);

  return {
    refreshDiffusionModel: shouldRefreshSavedDiffusionModel(provider, diffusionModel),
    refreshNaiDiffusionModel: shouldRefreshSavedDiffusionModel(provider, naiDiffusionModel),
  };
}

export async function buildSavedProviderConfigFromExistingOrDefaults(params: {
  serverId: number;
  provider: string;
  apiKey: Buffer | null;
  keyVersion: number;
  baseConfig: AssembledServerConfig;
  existingConfig?: SavedProviderConfigRow | null;
  llmId?: number | null;
}): Promise<SavedProviderConfigUpsert> {
  const normalizedProvider = params.provider.toLowerCase();
  const existingConfig = params.existingConfig ?? null;
  const candidateLlmId = params.llmId ?? existingConfig?.llm_id ?? null;
  const candidateLlm = candidateLlmId ? await llmModelRepo.loadById(candidateLlmId) : null;
  const refreshTextModel = shouldRefreshSavedTextModel(normalizedProvider, candidateLlm);
  const { refreshDiffusionModel, refreshNaiDiffusionModel } = await resolveDiffusionRefreshFlags(
    normalizedProvider,
    existingConfig,
  );
  const defaults =
    !existingConfig || refreshTextModel || refreshDiffusionModel || refreshNaiDiffusionModel
      ? await loadProviderDefaultSelectionIds(normalizedProvider)
      : null;

  return {
    server_id: params.serverId,
    provider: normalizedProvider,
    api_key: params.apiKey,
    key_version: params.keyVersion,
    llm_id: refreshTextModel ? (defaults?.llm_id ?? null) : candidateLlmId,
    diffusion_model_id: refreshDiffusionModel
      ? (defaults?.diffusion_model_id ?? null)
      : (existingConfig?.diffusion_model_id ?? null),
    embedding_model_id: existingConfig?.embedding_model_id ?? defaults?.embedding_model_id ?? null,
    nai_diffusion_model_id: refreshNaiDiffusionModel
      ? (defaults?.nai_diffusion_model_id ?? null)
      : (existingConfig?.nai_diffusion_model_id ?? null),
    video_model_id: existingConfig?.video_model_id ?? defaults?.video_model_id ?? null,
    vision_llm_id: existingConfig?.vision_llm_id ?? null,
    nai_preset_name: existingConfig?.nai_preset_name ?? null,
    llm_temperature: existingConfig?.llm_temperature ?? params.baseConfig.llm_temperature,
    llm_top_p: existingConfig?.llm_top_p ?? params.baseConfig.llm_top_p,
    llm_top_k: existingConfig?.llm_top_k ?? params.baseConfig.llm_top_k,
    llm_frequency_penalty: existingConfig?.llm_frequency_penalty ?? params.baseConfig.llm_frequency_penalty,
    llm_presence_penalty: existingConfig?.llm_presence_penalty ?? params.baseConfig.llm_presence_penalty,
    llm_min_p: existingConfig?.llm_min_p ?? params.baseConfig.llm_min_p,
    llm_disabled_params: existingConfig?.llm_disabled_params ?? params.baseConfig.llm_disabled_params ?? [],
    llm_logit_biases: existingConfig?.llm_logit_biases ?? params.baseConfig.llm_logit_biases ?? [],
    thinking_level: existingConfig?.thinking_level ?? params.baseConfig.thinking_level,
    fallback_model_refs: existingConfig?.fallback_model_refs ?? [],
  };
}

export async function buildUserSavedProviderConfigFromExistingOrDefaults(params: {
  userId: number;
  provider: string;
  apiKey: Buffer | null;
  keyVersion: number;
  baseConfig: AssembledServerConfig;
  existingConfig?: UserSavedProviderConfigRow | null;
  llmId?: number | null;
  enabledCapabilities?: Array<"text" | "embedding" | "image" | "video" | "vision">;
}): Promise<UserSavedProviderConfigUpsert> {
  const normalizedProvider = params.provider.toLowerCase();
  const existingConfig = params.existingConfig ?? null;
  const candidateLlmId = params.llmId ?? existingConfig?.llm_id ?? null;
  const candidateLlm = candidateLlmId ? await llmModelRepo.loadById(candidateLlmId) : null;
  const refreshTextModel = shouldRefreshSavedTextModel(normalizedProvider, candidateLlm);
  const { refreshDiffusionModel, refreshNaiDiffusionModel } = await resolveDiffusionRefreshFlags(
    normalizedProvider,
    existingConfig,
  );
  const defaults =
    !existingConfig || refreshTextModel || refreshDiffusionModel || refreshNaiDiffusionModel
      ? await loadProviderDefaultSelectionIds(normalizedProvider)
      : null;
  const enabledCapabilities = params.enabledCapabilities ?? existingConfig?.enabled_capabilities ?? [];

  return {
    user_id: params.userId,
    provider: normalizedProvider,
    api_key: params.apiKey,
    key_version: params.keyVersion,
    llm_id: refreshTextModel ? (defaults?.llm_id ?? null) : candidateLlmId,
    diffusion_model_id: refreshDiffusionModel
      ? (defaults?.diffusion_model_id ?? null)
      : (existingConfig?.diffusion_model_id ?? null),
    embedding_model_id: existingConfig?.embedding_model_id ?? defaults?.embedding_model_id ?? null,
    nai_diffusion_model_id: refreshNaiDiffusionModel
      ? (defaults?.nai_diffusion_model_id ?? null)
      : (existingConfig?.nai_diffusion_model_id ?? null),
    video_model_id: existingConfig?.video_model_id ?? defaults?.video_model_id ?? null,
    vision_llm_id: existingConfig?.vision_llm_id ?? null,
    nai_preset_name: existingConfig?.nai_preset_name ?? null,
    llm_temperature: existingConfig?.llm_temperature ?? params.baseConfig.llm_temperature,
    llm_top_p: existingConfig?.llm_top_p ?? params.baseConfig.llm_top_p,
    llm_top_k: existingConfig?.llm_top_k ?? params.baseConfig.llm_top_k,
    llm_frequency_penalty: existingConfig?.llm_frequency_penalty ?? params.baseConfig.llm_frequency_penalty,
    llm_presence_penalty: existingConfig?.llm_presence_penalty ?? params.baseConfig.llm_presence_penalty,
    llm_min_p: existingConfig?.llm_min_p ?? params.baseConfig.llm_min_p,
    llm_disabled_params: existingConfig?.llm_disabled_params ?? params.baseConfig.llm_disabled_params ?? [],
    llm_logit_biases: existingConfig?.llm_logit_biases ?? params.baseConfig.llm_logit_biases ?? [],
    thinking_level: existingConfig?.thinking_level ?? params.baseConfig.thinking_level,
    enabled_capabilities: enabledCapabilities,
    // Anything switched on here is owned here. Previously assigned capabilities are
    // kept even when currently off, so a re-enable still resolves to this provider.
    assigned_capabilities: Array.from(
      new Set([...(existingConfig?.assigned_capabilities ?? []), ...enabledCapabilities]),
    ),
    fallback_model_refs: existingConfig?.fallback_model_refs ?? [],
  };
}

function mapSavedCapabilityToCustomEndpointCapability(
  capability: SavedProviderCapability,
): CustomEndpointCapability | null {
  switch (capability) {
    case "text":
    case "embedding":
    case "image":
    case "video":
      return capability;
    case "vision":
      return "text";
    default:
      return null;
  }
}

async function hasRegisteredCustomEndpointCapability(
  provider: string,
  capability: SavedProviderCapability,
): Promise<boolean> {
  const parsed = parseCustomProvider(provider);
  const endpointCapability = mapSavedCapabilityToCustomEndpointCapability(capability);

  if (!parsed || parsed.ownerId === null || !endpointCapability) {
    return false;
  }

  const ownerId = parsed.ownerId;

  // A label can host several models per capability, and loadCustomEndpoint returns only the most
  // recently updated one. Vision therefore scans the whole label: a blank text model registered
  // after an image-capable one must not hide the label from the vision picker.
  if (capability === "vision") {
    const endpoints =
      parsed.scope === "server"
        ? await llmProviderRepo.loadCustomEndpointsForServer(ownerId)
        : await llmProviderRepo.loadCustomEndpointsForUser(ownerId);

    return endpoints.some(
      (row) => row.label === parsed.label && row.capability === endpointCapability && row.sees_images,
    );
  }

  const endpoint =
    parsed.scope === "server"
      ? await llmProviderRepo.loadCustomEndpoint({
          serverId: parsed.ownerId,
          label: parsed.label,
          capability: endpointCapability,
        })
      : await llmProviderRepo.loadCustomEndpoint({
          userId: parsed.ownerId,
          label: parsed.label,
          capability: endpointCapability,
        });

  return endpoint !== null;
}

export async function hasRegisteredCustomProvider(provider: string): Promise<boolean> {
  const parsed = parseCustomProvider(provider);
  if (!parsed || parsed.ownerId === null) {
    return false;
  }

  const registeredEndpoints =
    parsed.scope === "server"
      ? await llmProviderRepo.loadCustomEndpointsForServer(parsed.ownerId)
      : await llmProviderRepo.loadCustomEndpointsForUser(parsed.ownerId);

  return registeredEndpoints.some((endpoint) => endpoint.label === parsed.label);
}

export async function loadSavedProvidersForCapability(
  serverId: number,
  capability: SavedProviderCapability,
): Promise<SavedProviderConfigRow[]> {
  const savedConfigs = await llmProviderRepo.loadSavedProviderConfigs(serverId);
  const registeredVisibility = await Promise.all(
    savedConfigs.map(async (config) => {
      if (!isCustomProvider(config.provider)) {
        return true;
      }

      return await hasRegisteredCustomEndpointCapability(config.provider, capability);
    }),
  );

  return savedConfigs.filter((config, index) => {
    if (!registeredVisibility[index]) {
      return false;
    }

    if (isCustomProvider(config.provider)) {
      switch (capability) {
        case "text":
          return config.llm_id !== null;
        case "embedding":
          return config.embedding_model_id !== null;
        case "image":
          return config.diffusion_model_id !== null || config.nai_diffusion_model_id !== null;
        case "video":
          return config.video_model_id !== null;
        // Unlike the other slots, vision has no saved selection to require: registering an
        // image-capable text endpoint is what makes the label eligible, and the picker chooses
        // among that label's image-capable models.
        case "vision":
          return true;
        default:
          return false;
      }
    }

    switch (capability) {
      case "text":
        return true;
      case "embedding":
        return supportsEmbeddingCapability(config.provider);
      case "image":
        return supportsImageCapability(config.provider);
      case "video":
        return supportsVideoCapability(config.provider);
      case "vision":
        return supportsVisionCapability(config.provider);
      default:
        return false;
    }
  });
}

export async function loadUserSavedProvidersForCapability(
  userId: number,
  capability: SavedProviderCapability,
): Promise<UserSavedProviderConfigRow[]> {
  const savedConfigs = await llmProviderRepo.loadUserSavedProviderConfigs(userId);
  const registeredVisibility = await Promise.all(
    savedConfigs.map(async (config) => {
      if (!isCustomProvider(config.provider)) {
        return true;
      }

      return await hasRegisteredCustomEndpointCapability(config.provider, capability);
    }),
  );

  return savedConfigs.filter((config, index) => {
    if (!registeredVisibility[index]) {
      return false;
    }

    if (isCustomProvider(config.provider)) {
      switch (capability) {
        case "text":
          return config.llm_id !== null;
        case "embedding":
          return config.embedding_model_id !== null;
        case "image":
          return config.diffusion_model_id !== null || config.nai_diffusion_model_id !== null;
        case "video":
          return config.video_model_id !== null;
        // Unlike the other slots, vision has no saved selection to require: registering an
        // image-capable text endpoint is what makes the label eligible, and the picker chooses
        // among that label's image-capable models.
        case "vision":
          return true;
        default:
          return false;
      }
    }

    switch (capability) {
      case "text":
        return true;
      case "embedding":
        return supportsEmbeddingCapability(config.provider);
      case "image":
        return supportsImageCapability(config.provider);
      case "video":
        return supportsVideoCapability(config.provider);
      case "vision":
        return supportsVisionCapability(config.provider);
      default:
        return false;
    }
  });
}
