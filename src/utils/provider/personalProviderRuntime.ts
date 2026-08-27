import type {
  FallbackEntry,
  FallbackModelRef,
  PersonalProviderCapability,
  TomoriState,
  UserSavedProviderConfigRow,
} from "@/types/db/schema";
import { llmModelRepo, llmProviderRepo } from "@/utils/db/repositories";
import { hasConfiguredPersonalModel } from "@/utils/provider/personalProviderHelpers";
import { log } from "@/utils/misc/logger";

export interface PersonalProviderOverlayResult {
  tomoriState: TomoriState;
  activeConfigs: Partial<Record<PersonalProviderCapability, UserSavedProviderConfigRow>>;
}

function collectActiveConfigs(
  rows: UserSavedProviderConfigRow[],
): Partial<Record<PersonalProviderCapability, UserSavedProviderConfigRow>> {
  const active: Partial<Record<PersonalProviderCapability, UserSavedProviderConfigRow>> = {};

  for (const capability of ["text", "embedding", "image", "video", "vision"] as const) {
    // The model check keeps this in step with what the commands call active. Without
    // it an enabled row whose model pointer went NULL would swap its credential in
    // under the server's model, while the UI still reported the server default.
    const matches = rows.filter(
      (row) => row.enabled_capabilities.includes(capability) && hasConfiguredPersonalModel(row, capability),
    );
    if (matches.length === 0) {
      continue;
    }

    matches.sort((left, right) => left.provider.localeCompare(right.provider));
    if (matches.length > 1) {
      log.warn(
        `Multiple enabled personal providers matched capability ${capability} for user ${rows[0]?.user_id}. Falling back to ${matches[0].provider}.`,
      );
    }

    active[capability] = matches[0];
  }

  return active;
}

async function resolvePersonalFallbackChain(refs: FallbackModelRef[], userId: number): Promise<FallbackEntry[]> {
  const llmRefIds = refs.filter((ref) => ref.type === "llm").map((ref) => ref.id);
  const endpointRefIds = refs.filter((ref) => ref.type === "custom_endpoint").map((ref) => ref.id);
  const [llms, endpoints] = await Promise.all([
    llmRefIds.length > 0 ? llmModelRepo.getLlmsByIds(llmRefIds) : Promise.resolve([]),
    endpointRefIds.length > 0 ? llmProviderRepo.loadCustomEndpointsByIds(endpointRefIds) : Promise.resolve([]),
  ]);
  const llmMap = new Map(llms.map((model) => [model.llm_id as number, model]));
  const endpointMap = new Map(
    endpoints
      .filter((endpoint) => endpoint.user_id === userId && endpoint.server_id == null)
      .map((endpoint) => [endpoint.custom_endpoint_id as number, endpoint]),
  );

  return refs.flatMap((ref): FallbackEntry[] => {
    if (ref.type === "llm") {
      const model = llmMap.get(ref.id);
      return model ? [{ kind: "llm", model }] : [];
    }

    const endpoint = endpointMap.get(ref.id);
    return endpoint ? [{ kind: "custom_endpoint", endpoint }] : [];
  });
}

export async function applyPersonalProviderSelectionsToTomoriState(
  tomoriState: TomoriState,
  userId: number | null | undefined,
): Promise<PersonalProviderOverlayResult> {
  if (!userId) {
    return {
      tomoriState,
      activeConfigs: {},
    };
  }

  const rows = await llmProviderRepo.loadUserSavedProviderConfigs(userId);
  if (rows.length === 0) {
    return {
      tomoriState,
      activeConfigs: {},
    };
  }

  const activeConfigs = collectActiveConfigs(rows);
  const nextConfig = { ...tomoriState.config };

  if (activeConfigs.text) {
    nextConfig.llm_id = activeConfigs.text.llm_id ?? nextConfig.llm_id;
    nextConfig.api_key = activeConfigs.text.api_key;
    nextConfig.key_version = activeConfigs.text.key_version ?? nextConfig.key_version;
    nextConfig.llm_temperature = activeConfigs.text.llm_temperature ?? nextConfig.llm_temperature;
    nextConfig.llm_top_p = activeConfigs.text.llm_top_p ?? nextConfig.llm_top_p;
    nextConfig.llm_top_k = activeConfigs.text.llm_top_k ?? nextConfig.llm_top_k;
    nextConfig.llm_frequency_penalty = activeConfigs.text.llm_frequency_penalty ?? nextConfig.llm_frequency_penalty;
    nextConfig.llm_presence_penalty = activeConfigs.text.llm_presence_penalty ?? nextConfig.llm_presence_penalty;
    nextConfig.llm_min_p = activeConfigs.text.llm_min_p ?? nextConfig.llm_min_p;
    nextConfig.llm_disabled_params = activeConfigs.text.llm_disabled_params ?? nextConfig.llm_disabled_params;
    nextConfig.llm_logit_biases = activeConfigs.text.llm_logit_biases ?? nextConfig.llm_logit_biases;
    nextConfig.thinking_level = activeConfigs.text.thinking_level ?? nextConfig.thinking_level;
    nextConfig.model_randomizer_enabled = activeConfigs.text.model_randomizer_enabled;
    const personalFallbackIds = (activeConfigs.text.fallback_model_refs ?? [])
      .filter((r) => r.type === "llm")
      .map((r) => r.id);
    nextConfig.fallback_llm_ids = personalFallbackIds;
    // custom_endpoint_url/name/ctx are no longer on user saved configs; resolved from custom_endpoints at runtime
  }

  if (activeConfigs.embedding?.embedding_model_id) {
    nextConfig.embedding_model_id = activeConfigs.embedding.embedding_model_id;
  }
  if (activeConfigs.image?.diffusion_model_id) {
    nextConfig.diffusion_model_id = activeConfigs.image.diffusion_model_id;
  }
  if (activeConfigs.image?.nai_diffusion_model_id) {
    nextConfig.nai_diffusion_model_id = activeConfigs.image.nai_diffusion_model_id;
  }
  if (activeConfigs.video?.video_model_id) {
    nextConfig.video_model_id = activeConfigs.video.video_model_id;
  }
  if (activeConfigs.vision?.vision_llm_id) {
    nextConfig.vision_llm_id = activeConfigs.vision.vision_llm_id;
  }

  let nextLlm = tomoriState.llm;
  if (activeConfigs.text?.llm_id) {
    const personalLlm = await llmModelRepo.loadById(activeConfigs.text.llm_id);
    if (personalLlm) {
      nextLlm = personalLlm;
    }
  }

  let nextVisionLlm = tomoriState.vision_llm;
  if (activeConfigs.vision?.vision_llm_id) {
    const personalVisionLlm = await llmModelRepo.loadById(activeConfigs.vision.vision_llm_id);
    if (personalVisionLlm) {
      nextVisionLlm = personalVisionLlm;
    }
  }

  const personalFallbackChain = activeConfigs.text
    ? await resolvePersonalFallbackChain(activeConfigs.text.fallback_model_refs ?? [], userId)
    : null;
  const nextFallbackChain = activeConfigs.text
    ? personalFallbackChain && personalFallbackChain.length > 0
      ? personalFallbackChain
      : undefined
    : tomoriState.fallback_chain;
  const nextFallbackLlms = activeConfigs.text
    ? personalFallbackChain?.flatMap((entry) => (entry.kind === "llm" ? [entry.model] : []))
    : tomoriState.fallback_llms;

  return {
    tomoriState: {
      ...tomoriState,
      config: nextConfig,
      llm: nextLlm,
      vision_llm: nextVisionLlm,
      fallback_llms: nextFallbackLlms && nextFallbackLlms.length > 0 ? nextFallbackLlms : undefined,
      fallback_chain: nextFallbackChain,
      rotation_keys: activeConfigs.text ? undefined : tomoriState.rotation_keys,
    },
    activeConfigs,
  };
}
