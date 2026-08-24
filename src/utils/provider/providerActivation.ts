import type { SavedProviderConfigRow, SavedProviderConfigUpsert, TomoriState } from "@/types/db/schema";
import { invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { configRepository, llmModelRepo, llmProviderRepo } from "@/utils/db/repositories";
import { isCustomProvider } from "@/utils/provider/customProviderUtils";
import { buildFallbackModelPersistence } from "@/utils/provider/fallbackModelIdentity";
import { assignPersonalCapabilityToProvider, withPersonalTextPrimary } from "@/utils/provider/personalProviderHelpers";
import { resolveLogitBiasEntriesForLlm } from "@/utils/provider/logitBiasResolver";

type ActivationStatus = "activated" | "missing_model" | "missing_provider" | "update_failed";

export interface ActivationResult {
  status: ActivationStatus;
  modelName?: string;
}

type ServerSavedProviderConfig = SavedProviderConfigRow | SavedProviderConfigUpsert;

export async function activateServerTextModelFromSavedConfig(params: {
  serverDiscId: string;
  tomoriState: TomoriState;
  savedConfig: ServerSavedProviderConfig;
  llmId?: number | null;
}): Promise<ActivationResult> {
  const targetLlmId = params.llmId ?? params.savedConfig.llm_id;
  if (!targetLlmId) {
    return { status: "missing_model" };
  }

  const selectedModel = await llmModelRepo.loadById(targetLlmId);
  if (!selectedModel?.llm_id) {
    return { status: "missing_model" };
  }

  const promotedLlmId = selectedModel.llm_id;
  const normalizedProvider = params.savedConfig.provider.toLowerCase();
  const customEndpoints = isCustomProvider(normalizedProvider)
    ? await llmProviderRepo.loadCustomEndpointsForServer(params.tomoriState.server_id)
    : [];
  // The live chain is server-wide and may intentionally span providers. Switching the primary
  // only removes entries that resolve to the promoted model.
  const { fallbackModelRefs, fallbackLlmIds } = buildFallbackModelPersistence(
    params.tomoriState.config.fallback_model_refs ?? [],
    promotedLlmId,
    customEndpoints,
  );
  const resolvedLogitBiases = resolveLogitBiasEntriesForLlm(
    params.savedConfig.llm_logit_biases ?? params.tomoriState.config.llm_logit_biases ?? [],
    selectedModel,
  );

  const [updatedModel, updatedChat] = await Promise.all([
    configRepository.updateModelConfig(params.tomoriState.server_id, {
      llm_id: selectedModel.llm_id,
      api_key: params.savedConfig.api_key,
      key_version: params.savedConfig.key_version ?? 1,
      thinking_level: params.savedConfig.thinking_level ?? "auto",
      fallback_llm_ids: fallbackLlmIds,
      llm_temperature: params.savedConfig.llm_temperature ?? params.tomoriState.config.llm_temperature ?? 1.0,
      llm_disabled_params: params.savedConfig.llm_disabled_params ?? [],
      custom_model_name: null,
      custom_endpoint_url: null,
      custom_num_ctx: null,
    }),
    configRepository.updateChatConfig(params.tomoriState.server_id, {
      llm_top_p: params.savedConfig.llm_top_p ?? params.tomoriState.config.llm_top_p ?? 0.95,
      llm_top_k: params.savedConfig.llm_top_k ?? params.tomoriState.config.llm_top_k ?? 0,
      llm_frequency_penalty:
        params.savedConfig.llm_frequency_penalty ?? params.tomoriState.config.llm_frequency_penalty ?? 0.0,
      llm_presence_penalty:
        params.savedConfig.llm_presence_penalty ?? params.tomoriState.config.llm_presence_penalty ?? 0.0,
      llm_min_p: params.savedConfig.llm_min_p ?? params.tomoriState.config.llm_min_p ?? 0.05,
      llm_logit_biases: resolvedLogitBiases.entries,
      fallback_model_refs: fallbackModelRefs,
    }),
  ]);

  if (!updatedModel || !updatedChat) {
    return { status: "update_failed" };
  }

  invalidateTomoriStateCache(params.serverDiscId);
  return { status: "activated", modelName: selectedModel.llm_codename };
}

export async function activatePersonalProviderTextModel(params: {
  userId: number;
  provider: string;
  llmId: number | null | undefined;
}): Promise<ActivationResult> {
  if (!params.llmId) {
    return { status: "missing_model" };
  }

  const selectedModel = await llmModelRepo.loadById(params.llmId);
  if (!selectedModel?.llm_id) {
    return { status: "missing_model" };
  }

  const customEndpoints = isCustomProvider(params.provider)
    ? await llmProviderRepo.loadCustomEndpointsForUser(params.userId)
    : [];
  const updated = await assignPersonalCapabilityToProvider(params.userId, params.provider, "text", (row) =>
    withPersonalTextPrimary(row, selectedModel.llm_id ?? null, customEndpoints),
  );

  return updated ? { status: "activated", modelName: selectedModel.llm_codename } : { status: "update_failed" };
}
