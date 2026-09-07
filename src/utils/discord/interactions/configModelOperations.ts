import type {
  CustomEndpointRow,
  EmbeddingModelRow,
  FallbackModelRef,
  DiffusionModelRow,
  LlmRow,
  SavedProviderConfigRow,
  SavedProviderConfigUpsert,
  TomoriState,
  VideoGenerationModelRow,
} from "@/types/db/schema";
import { DEFAULT_THINKING_LEVEL, isThinkingLevelValue, type ThinkingLevelValue } from "@/constants/thinkingLevels";
import {
  LOGIT_BIAS_MAX,
  LOGIT_BIAS_MIN,
  LOGIT_BIAS_TEXT_MAX_LENGTH,
  buildLogitBiasEntries,
  logitBiasEntrySchema,
  mergeLogitBiasEntries,
  parseLogitBiasInputTerms,
  parseLogitBiasValue,
  type LogitBiasEntry,
} from "@/types/provider/logitBias";
import { invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import {
  configRepository,
  llmModelRepo,
  llmOverrideRepo,
  llmProviderRepo,
  ragRepository,
  serverMemoryRepository,
} from "@/utils/db/repositories";
import { isRagAvailable } from "@/utils/db/ragAvailability";
import {
  CONFIG_FALLBACK_SLOT_COUNT,
  isConfigCatalogModelCapability,
  type ConfigCatalogModelCapability,
  type ConfigModelCapability,
} from "@/utils/discord/configPanelCatalog";
import { DEFAULT_IMAGE_NEGATIVE_TAGS, DEFAULT_IMAGE_POSITIVE_TAGS } from "@/utils/image/tagDefaults";
import { parseAndValidateImageTags } from "@/utils/image/tagHelpers";
import { NAI_IMAGE_NOISE_SCHEDULES, NAI_IMAGE_SAMPLERS } from "@/utils/image/naiImageParams";
import { getMemoryLimits } from "@/utils/misc/memoryLimits";
import { log } from "@/utils/misc/logger";
import { resolveCapabilityCredentials } from "@/utils/provider/credentialResolver";
import { isCustomProvider, parseCustomProvider } from "@/utils/provider/customProviderUtils";
import {
  buildFallbackModelPersistence,
  getFallbackModelRefKey,
  getPrimaryFallbackRefKeys,
} from "@/utils/provider/fallbackModelIdentity";
import { resolveLogitBiasEntriesForLlm } from "@/utils/provider/logitBiasResolver";
import { getStaticProviderInfo } from "@/utils/provider/providerInfoRegistry";
import { loadSavedProvidersForCapability, type SavedProviderCapability } from "@/utils/provider/savedProviderConfig";
import {
  providerPanelOperations,
  type ActivateWorkspaceEndpointResult,
} from "@/utils/provider/providerPanelOperations";
import {
  MAX_STOP_STRINGS_PER_SERVER,
  MAX_STOP_STRING_LENGTH,
  mergeConfiguredStopStrings,
  parseCommaSeparatedStopStrings,
} from "@/utils/provider/stopStringConfig";

/** Sentinel a fallback slot select carries to empty that slot. */
export const CONFIG_FALLBACK_CLEAR_VALUE = "__none__";

/** Distinguishes a custom-endpoint fallback pick from an LLM codename in a slot select value. */
export const CONFIG_FALLBACK_ENDPOINT_PREFIX = "ce:";

/** Capability slot to the saved-provider capability whose eligibility list backs it. */
const SAVED_PROVIDER_CAPABILITY: Record<ConfigCatalogModelCapability, SavedProviderCapability> = {
  text: "text",
  vision: "vision",
  embedding: "embedding",
  image: "image",
  "nai-image": "image",
  video: "video",
};

/**
 * Splits the single `image` eligibility list across the panel's two image slots.
 *
 * `/model image` picks its target column from the chosen provider's `imageGeneration` style, so a
 * provider that would write `nai_diffusion_model_id` must not appear under Standard Image and vice
 * versa. A custom label always writes the standard column whatever its connection points at, which
 * is why the custom check comes first here exactly as it does in the command.
 */
export function isNaiPipelineProvider(provider: string): boolean {
  if (isCustomProvider(provider)) return false;
  return getStaticProviderInfo(provider)?.featureSupport.imageGeneration === "nai-pipeline";
}

export function filterProvidersForCapability(
  capability: ConfigCatalogModelCapability,
  providers: readonly SavedProviderConfigRow[],
): SavedProviderConfigRow[] {
  if (capability === "image") return providers.filter((row) => !isNaiPipelineProvider(row.provider));
  if (capability === "nai-image") return providers.filter((row) => isNaiPipelineProvider(row.provider));
  return [...providers];
}

export async function loadConfigModelProviders(
  serverId: number,
  capability: ConfigModelCapability,
): Promise<SavedProviderConfigRow[]> {
  if (!isConfigCatalogModelCapability(capability)) {
    // Speech and transcription are custom endpoint activations, not saved model providers.
    return [];
  }
  const providers = await loadSavedProvidersForCapability(serverId, SAVED_PROVIDER_CAPABILITY[capability]);
  return filterProvidersForCapability(capability, providers);
}

/** One selectable model in a capability slot, flattened so the renderer needs no per-slot branch. */
export interface ConfigModelChoice {
  /** Primary key of the row this slot writes, which is what the route carries. */
  id: number;
  name: string;
  description: string | null;
}

export async function loadConfigModelChoices(
  serverId: number,
  capability: ConfigCatalogModelCapability,
  provider: string,
): Promise<ConfigModelChoice[]> {
  const owner = { kind: "server", ownerId: serverId } as const;
  switch (capability) {
    case "text":
    case "vision": {
      const models = (await llmModelRepo.loadAvailableModelsForProvider(provider, false, owner)) ?? [];
      const eligible = capability === "vision" ? models.filter((model) => model.sees_images) : models;
      return eligible
        .filter((model): model is LlmRow & { llm_id: number } => model.llm_id !== undefined)
        .map((model) => ({ id: model.llm_id, name: model.llm_codename, description: model.llm_description ?? null }));
    }
    case "embedding": {
      const models = (await llmModelRepo.loadAvailableEmbeddingModels(provider, false, owner)) ?? [];
      return models
        .filter(
          (model): model is EmbeddingModelRow & { embedding_model_id: number } =>
            model.embedding_model_id !== undefined && model.embedding_model_id !== null,
        )
        .map((model) => ({
          id: model.embedding_model_id,
          name: model.codename,
          description: model.model_description ?? null,
        }));
    }
    case "image":
    case "nai-image": {
      const models = (await llmModelRepo.loadAvailableDiffusionModels(provider, false, owner)) ?? [];
      return models
        .filter(
          (model): model is DiffusionModelRow & { diffusion_model_id: number } =>
            model.diffusion_model_id !== undefined && model.diffusion_model_id !== null,
        )
        .map((model) => ({
          id: model.diffusion_model_id,
          name: model.codename,
          description: model.model_description ?? null,
        }));
    }
    case "video": {
      const models = (await llmModelRepo.loadAvailableVideoGenerationModels(provider, false, owner)) ?? [];
      return models
        .filter(
          (model): model is VideoGenerationModelRow & { video_model_id: number } =>
            model.video_model_id !== undefined && model.video_model_id !== null,
        )
        .map((model) => ({
          id: model.video_model_id,
          name: model.codename,
          description: model.model_description ?? null,
        }));
    }
  }
}

export type ConfigModelSetResult =
  | { status: "success"; modelName: string; reembedded: boolean }
  | { status: "already-selected"; modelName: string }
  | { status: "openrouter-moved" }
  | { status: "not-found" | "no-models" | "write-failed" };

export type ConfigModelClearResult =
  | { status: "success" }
  | { status: "already-clear" }
  | { status: "not-clearable" | "write-failed" };

export type ConfigParameterResult =
  | { status: "success" }
  | { status: "no-changes" | "invalid-value" | "not-found" | "write-failed" };

export type ConfigStopAddResult =
  | { status: "success"; addedCount: number; totalCount: number }
  | { status: "no-changes" | "invalid-input" | "write-failed" }
  | { status: "too-long"; maxLength: number }
  | { status: "too-many"; maxCount: number };

export type ConfigStopManageResult =
  | { status: "success"; removedCount: number; speakerPatternEnabled: boolean }
  | { status: "no-changes" | "stale" | "write-failed" };

export type ConfigLogitAddResult =
  | { status: "success"; addedCount: number; updatedCount: number; totalCount: number }
  | { status: "no-changes" | "empty-terms" | "term-too-long" | "invalid-bias" | "write-failed" };

export type ConfigLogitUploadResult =
  | { status: "success"; addedCount: number; updatedCount: number; totalCount: number }
  | { status: "no-changes" | "invalid-file" | "write-failed" };

export type ConfigLogitRemoveResult =
  | { status: "success"; removedCount: number }
  | { status: "no-changes" | "stale" | "write-failed" };

export type ConfigFallbackResult =
  | { status: "success"; refs: FallbackModelRef[] }
  | { status: "no-changes" | "openrouter-moved" | "not-found" | "write-failed" }
  | { status: "primary-conflict"; primaryModelName: string };

export type ConfigRandomizerResult =
  | { status: "success"; enabled: boolean }
  | { status: "no-changes" | "requires-fallbacks" | "write-failed" };

export type ConfigImageTagsResult =
  | { status: "success"; tags: string[]; reset: boolean }
  | { status: "no-tags" | "too-many" | "tag-too-long" | "invalid" | "write-failed" };

export type ConfigNaiParametersResult =
  | { status: "success" }
  | {
      status:
        | "invalid-sampler"
        | "invalid-steps"
        | "invalid-scale"
        | "invalid-noise-schedule"
        | "invalid-rescale"
        | "write-failed";
    };

export interface ConfigNaiParameterInput {
  sampler: string | null;
  steps: string;
  scale: string;
  noiseSchedule: string | null;
  cfgRescale: string;
}

export interface ConfigParameterPatch {
  temperature?: number | null;
  top_p?: number | null;
  top_k?: number | null;
  frequency_penalty?: number | null;
  presence_penalty?: number | null;
  min_p?: number | null;
  max_output_tokens?: number | null;
  thinking_level?: ThinkingLevelValue | null;
}

export interface ConfigModelOperations {
  setCapabilityModel(input: {
    tomoriState: TomoriState;
    serverDiscId: string;
    capability: ConfigModelCapability;
    provider: string;
    modelId: number;
  }): Promise<ConfigModelSetResult>;
  clearCapabilityModel(input: {
    tomoriState: TomoriState;
    serverDiscId: string;
    capability: ConfigModelCapability;
  }): Promise<ConfigModelClearResult>;
  activateWorkspaceEndpoint(input: {
    tomoriState: TomoriState;
    serverDiscId: string;
    ownerId?: number;
    scopeKind?: "server" | "personal";
    capability: "tts" | "stt";
    customEndpointId: number;
  }): Promise<ActivateWorkspaceEndpointResult>;
  setProviderParameters(input: {
    tomoriState: TomoriState;
    serverDiscId: string;
    provider: string;
    patch: ConfigParameterPatch;
  }): Promise<ConfigParameterResult>;
  addStopStrings(input: {
    tomoriState: TomoriState;
    serverDiscId: string;
    rawInput: string;
  }): Promise<ConfigStopAddResult>;
  manageStopStrings(input: {
    tomoriState: TomoriState;
    serverDiscId: string;
    presentedStopStrings: readonly string[];
    keptIndices: readonly number[];
    speakerPatternEnabled: boolean;
  }): Promise<ConfigStopManageResult>;
  addLogitBias(input: {
    tomoriState: TomoriState;
    serverDiscId: string;
    rawTerms: string;
    rawBias: string;
  }): Promise<ConfigLogitAddResult>;
  uploadLogitBias(input: {
    tomoriState: TomoriState;
    serverDiscId: string;
    payload: unknown;
  }): Promise<ConfigLogitUploadResult>;
  removeLogitBias(input: {
    tomoriState: TomoriState;
    serverDiscId: string;
    presentedIds: readonly string[];
    keptIds: readonly string[];
  }): Promise<ConfigLogitRemoveResult>;
  setFallbackChain(input: {
    tomoriState: TomoriState;
    serverDiscId: string;
    provider: string;
    slotValues: readonly string[];
  }): Promise<ConfigFallbackResult>;
  setModelRandomizer(input: {
    tomoriState: TomoriState;
    serverDiscId: string;
    enabled: boolean;
  }): Promise<ConfigRandomizerResult>;
  setImageDefaultTags(input: {
    tomoriState: TomoriState;
    serverDiscId: string;
    negative: boolean;
    rawInput: string;
  }): Promise<ConfigImageTagsResult>;
  setNaiImageParameters(input: {
    tomoriState: TomoriState;
    serverDiscId: string;
    values: ConfigNaiParameterInput;
  }): Promise<ConfigNaiParametersResult>;
}

export function currentModelIdForCapability(state: TomoriState, capability: ConfigModelCapability): number | null {
  switch (capability) {
    case "text":
      return state.config.llm_id ?? null;
    case "vision":
      return state.config.vision_llm_id ?? null;
    case "embedding":
      return state.config.embedding_model_id ?? null;
    case "image":
      return state.config.diffusion_model_id ?? null;
    case "nai-image":
      return state.config.nai_diffusion_model_id ?? null;
    case "video":
      return state.config.video_model_id ?? null;
    case "tts":
    case "stt":
      // Endpoint activation identity lives in custom_endpoints, not in a model id column.
      return null;
  }
}

/**
 * Promotes a Text model exactly as `/model text` does for the server scope.
 *
 * The saved-provider snapshot supplies the samplers, key, and thinking level so a provider switch
 * restores what that provider was last configured with. The fallback chain is pruned rather than
 * cleared because it is cross-provider by design: only the model being promoted has to leave it,
 * or every later fallback edit would be blocked by its own primary.
 */
async function promoteTextModel(
  tomoriState: TomoriState,
  serverDiscId: string,
  provider: string,
  model: LlmRow & { llm_id: number },
  savedConfig: SavedProviderConfigRow | null,
): Promise<boolean> {
  const resolvedLogitBiases = resolveLogitBiasEntriesForLlm(
    savedConfig?.llm_logit_biases ?? tomoriState.config.llm_logit_biases ?? [],
    model,
  );
  const customEndpoints = isCustomProvider(provider)
    ? await llmProviderRepo.loadCustomEndpointsForServer(tomoriState.server_id)
    : undefined;
  const { fallbackModelRefs, fallbackLlmIds } = buildFallbackModelPersistence(
    tomoriState.config.fallback_model_refs ?? [],
    model.llm_id,
    customEndpoints,
  );

  const [updatedModel, updatedChat] = await Promise.all([
    configRepository.updateModelConfig(tomoriState.server_id, {
      llm_id: model.llm_id,
      api_key: savedConfig?.api_key ?? null,
      key_version: savedConfig?.key_version ?? 1,
      thinking_level: savedConfig?.thinking_level ?? "auto",
      fallback_llm_ids: fallbackLlmIds,
      llm_temperature: savedConfig?.llm_temperature ?? tomoriState.config.llm_temperature ?? 1.0,
      llm_disabled_params: savedConfig?.llm_disabled_params ?? [],
      custom_model_name: null,
      custom_endpoint_url: null,
      custom_num_ctx: null,
    }),
    configRepository.updateChatConfig(tomoriState.server_id, {
      llm_top_p: savedConfig?.llm_top_p ?? tomoriState.config.llm_top_p ?? 0.95,
      llm_top_k: savedConfig?.llm_top_k ?? tomoriState.config.llm_top_k ?? 0,
      llm_frequency_penalty: savedConfig?.llm_frequency_penalty ?? tomoriState.config.llm_frequency_penalty ?? 0.0,
      llm_presence_penalty: savedConfig?.llm_presence_penalty ?? tomoriState.config.llm_presence_penalty ?? 0.0,
      llm_min_p: savedConfig?.llm_min_p ?? tomoriState.config.llm_min_p ?? 0.05,
      llm_logit_biases: resolvedLogitBiases.entries,
      fallback_model_refs: fallbackModelRefs,
    }),
  ]);
  // The split-table writes are not transactional, so a partial success still has to invalidate or
  // readers would assemble a state that never existed.
  if (updatedModel || updatedChat) invalidateTomoriStateCache(serverDiscId);
  if (!updatedModel || !updatedChat) return false;

  const naiDefaultPresets: Record<string, { name: string; target: "kayra" | "erato" }> = {
    "kayra-v1": { name: "Carefree-Kayra", target: "kayra" },
    "llama-3-erato-v1": { name: "Erato-Shosetsu", target: "erato" },
  };
  const defaultPresetEntry = naiDefaultPresets[model.llm_codename];
  if (!defaultPresetEntry) return true;

  const naiPresets = await configRepository.loadNaiPresets(defaultPresetEntry.target);
  const defaultPreset = naiPresets.find((preset) => preset.preset_name === defaultPresetEntry.name);
  if (!defaultPreset) {
    log.warn(
      `Default NAI preset "${defaultPresetEntry.name}" not found in DB. Was the seed catalog loaded? Skipping auto-apply.`,
    );
    return true;
  }

  const applied = await configRepository.applyNaiPreset(
    tomoriState.server_id,
    defaultPreset,
    model.llm_codename,
    serverDiscId,
  );
  if (!applied) {
    // The preset spans three non-transactional writes, so any sub-write that committed must not
    // stay hidden behind the cache.
    invalidateTomoriStateCache(serverDiscId);
    return false;
  }
  return true;
}

function parseBoundedInteger(raw: string, min: number, max: number): number | null | "invalid" {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (Number.isNaN(parsed) || parsed < min || parsed > max || trimmed !== parsed.toString()) return "invalid";
  return parsed;
}

function parseBoundedFloat(raw: string, min: number, max: number): number | null | "invalid" {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number.parseFloat(trimmed);
  if (Number.isNaN(parsed) || parsed < min || parsed > max) return "invalid";
  return parsed;
}

export const configModelOperations: ConfigModelOperations = {
  async setCapabilityModel({ tomoriState, serverDiscId, capability, provider, modelId }) {
    if (capability === "tts" || capability === "stt") {
      // Endpoint activations are not model-column writes and have no model catalog to query.
      return { status: "not-found" };
    }
    const eligible = await loadConfigModelProviders(tomoriState.server_id, capability);
    const savedConfig = eligible.find((row) => row.provider.toLowerCase() === provider.toLowerCase()) ?? null;
    if (!savedConfig) return { status: "not-found" };

    if (capability === "text" || capability === "vision") {
      const models =
        (await llmModelRepo.loadAvailableModelsForProvider(savedConfig.provider, false, {
          kind: "server",
          ownerId: tomoriState.server_id,
        })) ?? [];
      const eligibleModels = capability === "vision" ? models.filter((model) => model.sees_images) : models;
      if (eligibleModels.length === 0) return { status: "no-models" };
      const model = eligibleModels.find((candidate) => candidate.llm_id === modelId);
      if (model?.llm_id === undefined) return { status: "not-found" };
      if (model.llm_codename === "other-model") return { status: "openrouter-moved" };
      if (model.llm_id === currentModelIdForCapability(tomoriState, capability)) {
        return { status: "already-selected", modelName: model.llm_codename };
      }

      if (capability === "text") {
        const promoted = await promoteTextModel(
          tomoriState,
          serverDiscId,
          savedConfig.provider,
          model as LlmRow & { llm_id: number },
          savedConfig,
        );
        return promoted
          ? { status: "success", modelName: model.llm_codename, reembedded: false }
          : { status: "write-failed" };
      }

      const updated = await configRepository.updateModelConfig(tomoriState.server_id, { vision_llm_id: model.llm_id });
      if (!updated) return { status: "write-failed" };
      invalidateTomoriStateCache(serverDiscId);
      return { status: "success", modelName: model.llm_codename, reembedded: false };
    }

    const choices = await loadConfigModelChoices(tomoriState.server_id, capability, savedConfig.provider);
    if (choices.length === 0) return { status: "no-models" };
    const choice = choices.find((candidate) => candidate.id === modelId);
    if (!choice) return { status: "not-found" };
    if (choice.id === currentModelIdForCapability(tomoriState, capability)) {
      return { status: "already-selected", modelName: choice.name };
    }

    if (capability === "embedding") {
      const currentEmbeddingModel = tomoriState.config.embedding_model_id
        ? await llmModelRepo.loadEmbeddingModelById(tomoriState.config.embedding_model_id)
        : null;
      const chosenModel = await llmModelRepo.loadEmbeddingModelById(choice.id);
      if (!chosenModel) return { status: "not-found" };
      // A change of embedding family leaves stored vectors in a space the new model does not share,
      // so the documents are re-embedded rather than left silently unsearchable.
      const shouldReembed =
        !!currentEmbeddingModel?.model_family && currentEmbeddingModel.model_family !== chosenModel.model_family;

      const updated = await configRepository.updateModelConfig(tomoriState.server_id, {
        embedding_model_id: choice.id,
      });
      if (!updated) return { status: "write-failed" };
      invalidateTomoriStateCache(serverDiscId);

      let reembedded = false;
      if (shouldReembed && isRagAvailable()) {
        const documentCount = await serverMemoryRepository.countDocuments(tomoriState.server_id);
        if (documentCount > 0) {
          const credentials = await resolveCapabilityCredentials(tomoriState.server_id, "embedding");
          const limits = getMemoryLimits();
          await ragRepository.reembedServerDocuments({
            serverId: tomoriState.server_id,
            embeddingModel: chosenModel,
            apiKey: credentials.apiKey,
            chunkSize: limits.documentChunkSize,
            chunkOverlap: limits.documentChunkOverlap,
          });
          reembedded = true;
        }
      }
      return { status: "success", modelName: choice.name, reembedded };
    }

    const updated =
      capability === "nai-image"
        ? await configRepository.updateNovelaiImagegenConfig(tomoriState.server_id, {
            nai_diffusion_model_id: choice.id,
          })
        : capability === "image"
          ? await configRepository.updateModelConfig(tomoriState.server_id, { diffusion_model_id: choice.id })
          : await configRepository.updateModelConfig(tomoriState.server_id, { video_model_id: choice.id });
    if (!updated) return { status: "write-failed" };
    invalidateTomoriStateCache(serverDiscId);
    return { status: "success", modelName: choice.name, reembedded: false };
  },

  async clearCapabilityModel({ tomoriState, serverDiscId, capability }) {
    if (capability === "tts" || capability === "stt") {
      // Endpoint activation identity lives in custom_endpoints, so model clearing cannot handle it.
      return { status: "not-clearable" };
    }
    if (capability === "text" || capability === "embedding" || capability === "video") {
      return { status: "not-clearable" };
    }
    if (currentModelIdForCapability(tomoriState, capability) === null) return { status: "already-clear" };

    const updated =
      capability === "vision"
        ? await configRepository.updateModelConfig(tomoriState.server_id, { vision_llm_id: null })
        : capability === "image"
          ? await configRepository.updateModelConfig(tomoriState.server_id, { diffusion_model_id: null })
          : await configRepository.updateNovelaiImagegenConfig(tomoriState.server_id, {
              nai_diffusion_model_id: null,
            });
    if (!updated) return { status: "write-failed" };
    invalidateTomoriStateCache(serverDiscId);
    return { status: "success" };
  },

  async activateWorkspaceEndpoint({ tomoriState, serverDiscId, ownerId, scopeKind, capability, customEndpointId }) {
    return providerPanelOperations.activateWorkspaceEndpoint({
      serverDiscId,
      ownerId,
      scopeKind,
      state: tomoriState,
      capability: capability === "tts" ? "speech" : "transcription",
      customEndpointId,
    });
  },

  async setProviderParameters({ tomoriState, serverDiscId, provider, patch }) {
    const eligible = await loadSavedProvidersForCapability(tomoriState.server_id, "text");
    const savedConfig = eligible.find((row) => row.provider.toLowerCase() === provider.toLowerCase()) ?? null;
    if (!savedConfig) return { status: "not-found" };

    // A modal Text Input carries no bounds, so the ranges the slash command declared as option
    // constraints have to be re-applied here or the panel would widen them.
    const outOfRange = (value: number | null | undefined, min: number, max: number, integer = false): boolean =>
      value !== undefined &&
      value !== null &&
      (Number.isNaN(value) || value < min || value > max || (integer && !Number.isInteger(value)));

    if (
      outOfRange(patch.temperature, 0, 2) ||
      outOfRange(patch.top_p, 0, 1) ||
      outOfRange(patch.top_k, 0, 256, true) ||
      outOfRange(patch.frequency_penalty, -2, 2) ||
      outOfRange(patch.presence_penalty, -2, 2) ||
      outOfRange(patch.min_p, 0, 1) ||
      outOfRange(patch.max_output_tokens, 1, 131072, true) ||
      (patch.thinking_level !== undefined &&
        patch.thinking_level !== null &&
        !isThinkingLevelValue(patch.thinking_level))
    ) {
      return { status: "invalid-value" };
    }

    const nextConfig: SavedProviderConfigUpsert = {
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

    const unchanged =
      nextConfig.llm_temperature === savedConfig.llm_temperature &&
      nextConfig.llm_top_p === savedConfig.llm_top_p &&
      nextConfig.llm_top_k === savedConfig.llm_top_k &&
      nextConfig.llm_frequency_penalty === savedConfig.llm_frequency_penalty &&
      nextConfig.llm_presence_penalty === savedConfig.llm_presence_penalty &&
      nextConfig.llm_min_p === savedConfig.llm_min_p &&
      nextConfig.llm_max_output_tokens === savedConfig.llm_max_output_tokens &&
      nextConfig.thinking_level === savedConfig.thinking_level;
    if (unchanged) return { status: "no-changes" };

    const upserted = await llmProviderRepo.upsertSavedProviderConfig(tomoriState.server_id, nextConfig, {
      serverDiscId,
    });
    if (!upserted) return { status: "write-failed" };

    // Editing the active provider must reach in-flight requests without a model switch, so the
    // saved snapshot is mirrored into the split config tables the runtime actually reads.
    if (savedConfig.provider.toLowerCase() === tomoriState.llm.llm_provider.toLowerCase()) {
      await Promise.all([
        configRepository.updateModelConfig(tomoriState.server_id, {
          llm_temperature: nextConfig.llm_temperature ?? 1.0,
          thinking_level: nextConfig.thinking_level,
        }),
        configRepository.updateChatConfig(tomoriState.server_id, {
          llm_top_p: nextConfig.llm_top_p ?? 0.95,
          llm_top_k: nextConfig.llm_top_k ?? 0,
          llm_frequency_penalty: nextConfig.llm_frequency_penalty ?? 0.0,
          llm_presence_penalty: nextConfig.llm_presence_penalty ?? 0.0,
          llm_min_p: nextConfig.llm_min_p ?? 0.05,
          llm_max_output_tokens: nextConfig.llm_max_output_tokens ?? null,
        }),
      ]);
    }
    invalidateTomoriStateCache(serverDiscId);
    return { status: "success" };
  },

  async addStopStrings({ tomoriState, serverDiscId, rawInput }) {
    const parsed = parseCommaSeparatedStopStrings(rawInput);
    if (parsed.length === 0) return { status: "invalid-input" };
    if (parsed.some((stop) => stop.length > MAX_STOP_STRING_LENGTH)) {
      return { status: "too-long", maxLength: MAX_STOP_STRING_LENGTH };
    }

    const existing = tomoriState.config.llm_stop_strings ?? [];
    const merged = mergeConfiguredStopStrings(existing, parsed);
    if (merged.length > MAX_STOP_STRINGS_PER_SERVER) {
      return { status: "too-many", maxCount: MAX_STOP_STRINGS_PER_SERVER };
    }
    const added = merged.filter((stop) => !existing.includes(stop));
    if (added.length === 0) return { status: "no-changes" };

    const updated = await configRepository.updateChatConfig(tomoriState.server_id, { llm_stop_strings: merged });
    if (!updated) return { status: "write-failed" };
    invalidateTomoriStateCache(serverDiscId);
    return { status: "success", addedCount: added.length, totalCount: merged.length };
  },

  async manageStopStrings({ tomoriState, serverDiscId, presentedStopStrings, keptIndices, speakerPatternEnabled }) {
    const current = tomoriState.config.llm_stop_strings ?? [];
    // The modal's checkbox positions address the list as it stood when it opened, so a concurrent
    // add or removal has to invalidate the submission rather than remove a different string.
    if (
      current.length !== presentedStopStrings.length ||
      current.some((stop, index) => stop !== presentedStopStrings[index])
    ) {
      return { status: "stale" };
    }

    const kept = new Set(keptIndices);
    const nextStopStrings = current.filter((_stop, index) => kept.has(index));
    const removedCount = current.length - nextStopStrings.length;
    const patternChanged = speakerPatternEnabled !== (tomoriState.config.llm_stop_speaker_pattern_enabled ?? false);
    if (removedCount === 0 && !patternChanged) return { status: "no-changes" };

    const updated = await configRepository.updateChatConfig(tomoriState.server_id, {
      llm_stop_strings: nextStopStrings,
      llm_stop_speaker_pattern_enabled: speakerPatternEnabled,
    });
    if (!updated) return { status: "write-failed" };
    invalidateTomoriStateCache(serverDiscId);
    return { status: "success", removedCount, speakerPatternEnabled };
  },

  async addLogitBias({ tomoriState, serverDiscId, rawTerms, rawBias }) {
    const terms = parseLogitBiasInputTerms(rawTerms);
    if (terms.length === 0) return { status: "empty-terms" };
    if (terms.some((term) => term.length > LOGIT_BIAS_TEXT_MAX_LENGTH)) return { status: "term-too-long" };

    const biasValue = parseLogitBiasValue(rawBias);
    if (biasValue === null) return { status: "invalid-bias" };

    const resolved = resolveLogitBiasEntriesForLlm(buildLogitBiasEntries(terms, biasValue), tomoriState.llm);
    const merged = mergeLogitBiasEntries(tomoriState.config.llm_logit_biases ?? [], resolved.entries);
    if (merged.addedCount === 0 && merged.updatedCount === 0) return { status: "no-changes" };

    const updated = await configRepository.updateChatConfig(tomoriState.server_id, {
      llm_logit_biases: merged.entries,
    });
    if (!updated) return { status: "write-failed" };
    invalidateTomoriStateCache(serverDiscId);
    return {
      status: "success",
      addedCount: merged.addedCount,
      updatedCount: merged.updatedCount,
      totalCount: merged.entries.length,
    };
  },

  async uploadLogitBias({ tomoriState, serverDiscId, payload }) {
    const candidates = Array.isArray(payload)
      ? payload
      : payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).logit_biases)
        ? ((payload as Record<string, unknown>).logit_biases as unknown[])
        : [payload];
    const parsed = uploadedLogitBiasSchema.safeParse(candidates);
    if (!parsed.success || parsed.data.length === 0) return { status: "invalid-file" };

    const entries: LogitBiasEntry[] = parsed.data.flatMap((entry) => buildLogitBiasEntries([entry.text], entry.value));
    const resolved = resolveLogitBiasEntriesForLlm(entries, tomoriState.llm);
    const merged = mergeLogitBiasEntries(tomoriState.config.llm_logit_biases ?? [], resolved.entries);
    if (merged.addedCount === 0 && merged.updatedCount === 0) return { status: "no-changes" };

    const updated = await configRepository.updateChatConfig(tomoriState.server_id, {
      llm_logit_biases: merged.entries,
    });
    if (!updated) return { status: "write-failed" };
    invalidateTomoriStateCache(serverDiscId);
    return {
      status: "success",
      addedCount: merged.addedCount,
      updatedCount: merged.updatedCount,
      totalCount: merged.entries.length,
    };
  },

  async removeLogitBias({ tomoriState, serverDiscId, presentedIds, keptIds }) {
    const current = tomoriState.config.llm_logit_biases ?? [];
    const currentIds = new Set(current.map((entry) => entry.id));
    // Removal derives from what the modal showed, so an entry that vanished between open and submit
    // invalidates the continuation instead of removing whichever entry now holds that position.
    if (presentedIds.some((id) => !currentIds.has(id))) return { status: "stale" };

    const presented = new Set(presentedIds);
    const kept = new Set(keptIds);
    const nextEntries = current.filter((entry) => !presented.has(entry.id) || kept.has(entry.id));
    const removedCount = current.length - nextEntries.length;
    if (removedCount === 0) return { status: "no-changes" };

    const updated = await configRepository.updateChatConfig(tomoriState.server_id, {
      llm_logit_biases: nextEntries,
    });
    if (!updated) return { status: "write-failed" };
    invalidateTomoriStateCache(serverDiscId);
    return { status: "success", removedCount };
  },

  async setFallbackChain({ tomoriState, serverDiscId, provider, slotValues }) {
    const eligible = await loadSavedProvidersForCapability(tomoriState.server_id, "text");
    const savedConfig = eligible.find((row) => row.provider.toLowerCase() === provider.toLowerCase()) ?? null;
    if (!savedConfig) return { status: "not-found" };

    const resolvedProvider = savedConfig.provider;
    const customProvider = parseCustomProvider(resolvedProvider);
    const allEndpoints = await llmProviderRepo.loadCustomEndpointsForServer(tomoriState.server_id);
    const selectableEndpoints: CustomEndpointRow[] = customProvider
      ? allEndpoints.filter(
          (endpoint) => endpoint.connection_id === customProvider.connectionId && endpoint.capability === "text",
        )
      : [];
    const availableModels = customProvider
      ? []
      : ((await llmModelRepo.loadAvailableModelsForProvider(resolvedProvider, false, {
          kind: "server",
          ownerId: tomoriState.server_id,
        })) ?? []);

    const existingRefs = tomoriState.config.fallback_model_refs ?? [];
    const mergedRefs: FallbackModelRef[] = [];
    const submittedKeys = new Set<string>();

    for (let slot = 0; slot < CONFIG_FALLBACK_SLOT_COUNT; slot += 1) {
      const raw = (slotValues[slot] ?? "").trim();
      if (raw === "") {
        // An untouched slot keeps what it already held, which is what lets one submission edit a
        // single position of a chain whose other entries belong to other providers.
        if (existingRefs[slot]) mergedRefs.push(existingRefs[slot]);
        continue;
      }
      if (raw === CONFIG_FALLBACK_CLEAR_VALUE) continue;
      // A pick that no longer resolves drops that slot alone. One submission edits five positions
      // at once, so failing the whole write would also discard the untouched slots it was carrying
      // through, and a catalog that changed while the modal sat open is an ordinary race here.
      if (raw.startsWith(CONFIG_FALLBACK_ENDPOINT_PREFIX)) {
        const endpointId = Number.parseInt(raw.slice(CONFIG_FALLBACK_ENDPOINT_PREFIX.length), 10);
        const endpoint = selectableEndpoints.find((candidate) => candidate.custom_endpoint_id === endpointId);
        if (endpoint?.custom_endpoint_id === undefined) continue;
        mergedRefs.push({ type: "custom_endpoint", id: endpoint.custom_endpoint_id });
        submittedKeys.add(`custom_endpoint:${endpoint.custom_endpoint_id}`);
        continue;
      }
      if (resolvedProvider === "openrouter" && raw === "other-model") return { status: "openrouter-moved" };
      const model = availableModels.find((candidate) => candidate.llm_codename === raw);
      if (model?.llm_id === undefined) continue;
      mergedRefs.push({ type: "llm", id: model.llm_id });
      submittedKeys.add(`llm:${model.llm_id}`);
    }

    const seen = new Set<string>();
    const dedupedRefs = mergedRefs.filter((ref) => {
      const key = getFallbackModelRefKey(ref);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // A fallback equal to the primary never survives the write. Only a pick made in this submission
    // is worth an error; an inherited duplicate is dropped silently, or every submission would be
    // rejected until the user found and cleared an untouched slot.
    const primaryKeys = getPrimaryFallbackRefKeys(tomoriState.config.llm_id, allEndpoints);
    if ([...submittedKeys].some((key) => primaryKeys.has(key))) {
      return { status: "primary-conflict", primaryModelName: tomoriState.llm.llm_codename };
    }
    const finalRefs = dedupedRefs.filter((ref) => !primaryKeys.has(getFallbackModelRefKey(ref)));

    const unchanged =
      finalRefs.length === existingRefs.length &&
      finalRefs.every((ref, index) => getFallbackModelRefKey(ref) === getFallbackModelRefKey(existingRefs[index]));
    if (unchanged) return { status: "no-changes" };

    const written = await llmOverrideRepo.setFallbackModelRefs(tomoriState.server_id, finalRefs, { serverDiscId });
    if (!written) return { status: "write-failed" };
    return { status: "success", refs: finalRefs };
  },

  async setModelRandomizer({ tomoriState, serverDiscId, enabled }) {
    // The pool is primary plus fallbacks, so enabling with an empty chain would be a silent no-op.
    if (enabled && (tomoriState.config.fallback_model_refs ?? []).length === 0) {
      return { status: "requires-fallbacks" };
    }
    if ((tomoriState.config.model_randomizer_enabled ?? false) === enabled) return { status: "no-changes" };

    const updated = await configRepository.updateChatConfig(tomoriState.server_id, {
      model_randomizer_enabled: enabled,
    });
    if (!updated) return { status: "write-failed" };
    invalidateTomoriStateCache(serverDiscId);
    return { status: "success", enabled };
  },

  async setImageDefaultTags({ tomoriState, serverDiscId, negative, rawInput }) {
    // An empty submission restores the built-in defaults rather than creating a new empty state,
    // which is the reset path the absorbed commands already offer.
    if (rawInput.trim().length === 0) {
      const defaults = negative ? [...DEFAULT_IMAGE_NEGATIVE_TAGS] : [...DEFAULT_IMAGE_POSITIVE_TAGS];
      const reset = await configRepository.updateNovelaiImagegenConfig(
        tomoriState.server_id,
        negative ? { image_default_negative_tags: defaults } : { image_default_positive_tags: defaults },
      );
      if (!reset) return { status: "write-failed" };
      invalidateTomoriStateCache(serverDiscId);
      return { status: "success", tags: defaults, reset: true };
    }

    const validation = parseAndValidateImageTags(rawInput);
    if (!validation.isValid) {
      if (validation.reason === "empty") return { status: "no-tags" };
      if (validation.reason === "too_many") return { status: "too-many" };
      if (validation.reason === "tag_too_long") return { status: "tag-too-long" };
      return { status: "invalid" };
    }

    const updated = await configRepository.updateNovelaiImagegenConfig(
      tomoriState.server_id,
      negative ? { image_default_negative_tags: validation.tags } : { image_default_positive_tags: validation.tags },
    );
    if (!updated) return { status: "write-failed" };
    invalidateTomoriStateCache(serverDiscId);
    return { status: "success", tags: validation.tags, reset: false };
  },

  async setNaiImageParameters({ tomoriState, serverDiscId, values }) {
    const sampler = values.sampler?.trim() ?? "";
    if (sampler && !NAI_IMAGE_SAMPLERS.includes(sampler as (typeof NAI_IMAGE_SAMPLERS)[number])) {
      return { status: "invalid-sampler" };
    }
    const noiseSchedule = values.noiseSchedule?.trim() ?? "";
    if (
      noiseSchedule &&
      !NAI_IMAGE_NOISE_SCHEDULES.includes(noiseSchedule as (typeof NAI_IMAGE_NOISE_SCHEDULES)[number])
    ) {
      return { status: "invalid-noise-schedule" };
    }

    const steps = parseBoundedInteger(values.steps, 1, 50);
    if (steps === "invalid") return { status: "invalid-steps" };
    const scale = parseBoundedFloat(values.scale, 0, 10);
    if (scale === "invalid") return { status: "invalid-scale" };
    const cfgRescale = parseBoundedFloat(values.cfgRescale, 0, 1);
    if (cfgRescale === "invalid") return { status: "invalid-rescale" };

    const updated = await configRepository.updateNovelaiImagegenConfig(tomoriState.server_id, {
      nai_sampler: sampler || null,
      nai_steps: steps,
      nai_scale: scale,
      nai_noise_schedule: noiseSchedule || null,
      nai_cfg_rescale: cfgRescale,
    });
    if (!updated) return { status: "write-failed" };
    invalidateTomoriStateCache(serverDiscId);
    return { status: "success" };
  },
};

/**
 * Uploaded entries carry no id: `buildLogitBiasEntries` derives one, so accepting a supplied id
 * would let a file overwrite an unrelated stored entry.
 */
const uploadedLogitBiasSchema = logitBiasEntrySchema
  .pick({ text: true, value: true })
  .extend({ value: logitBiasEntrySchema.shape.value.min(LOGIT_BIAS_MIN).max(LOGIT_BIAS_MAX) })
  .array();
