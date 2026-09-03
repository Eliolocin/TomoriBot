import type { FallbackEntry, FallbackModelRef, TomoriState } from "@/types/db/schema";
import { llmModelRepo, llmOverrideRepo, llmProviderRepo } from "@/utils/db/repositories";
import {
  CONFIG_FALLBACK_PAGE_SIZE,
  CONFIG_FALLBACK_SLOT_COUNT,
  CONFIG_MODEL_CAPABILITY_ORDER,
  type ConfigModelCapability,
} from "@/utils/discord/configPanelCatalog";
import {
  CONFIG_FALLBACK_ENDPOINT_PREFIX,
  currentModelIdForCapability,
  loadConfigModelChoices,
  loadConfigModelProviders,
} from "@/utils/discord/interactions/configModelOperations";
import type { ConfigFallbackOption } from "@/utils/discord/ui/configModelModals";
import type {
  ConfigFallbacksView,
  ConfigImageGenerationView,
  ConfigParametersView,
  ConfigSwitchModelsView,
} from "@/utils/discord/ui/configModelsPanel";
import { buildProviderPageEntries } from "@/utils/discord/ui/modelRoutingControls";
import { resolveNaiImageParams } from "@/utils/image/naiImageParams";
import { isCustomProvider, parseCustomProvider } from "@/utils/provider/customProviderUtils";
import { getProviderDisplayName } from "@/utils/provider/providerInfoRegistry";
import { loadSavedProvidersForCapability } from "@/utils/provider/savedProviderConfig";
import { localizer } from "@/utils/text/localizer";

/**
 * Resolves the display name of whatever currently occupies one slot.
 *
 * Each slot reads a different catalog, and only Text and Vision are joined into `TomoriState`
 * already, so the remaining four need a lookup by id rather than a field read.
 */
async function resolveSlotAssignment(
  state: TomoriState,
  capability: ConfigModelCapability,
): Promise<{ modelName: string | null; provider: string | null }> {
  switch (capability) {
    case "text":
      return { modelName: state.llm?.llm_codename ?? null, provider: state.llm?.llm_provider ?? null };
    case "vision":
      return {
        modelName: state.vision_llm?.llm_codename ?? null,
        provider: state.vision_llm?.llm_provider ?? null,
      };
    case "embedding": {
      const id = state.config.embedding_model_id;
      if (!id) return { modelName: null, provider: null };
      const model = await llmModelRepo.loadEmbeddingModelById(id);
      return { modelName: model?.codename ?? null, provider: model?.provider ?? null };
    }
    case "image":
    case "nai-image": {
      const id = capability === "image" ? state.config.diffusion_model_id : state.config.nai_diffusion_model_id;
      if (!id) return { modelName: null, provider: null };
      const model = await llmModelRepo.loadDiffusionModelById(id);
      return { modelName: model?.codename ?? null, provider: model?.provider ?? null };
    }
    case "video": {
      const id = state.config.video_model_id;
      if (!id) return { modelName: null, provider: null };
      const model = await llmModelRepo.loadVideoGenerationModelById(id);
      return { modelName: model?.codename ?? null, provider: model?.provider ?? null };
    }
  }
}

export async function loadConfigSwitchModelsView(
  state: TomoriState,
  providerPage: { capability: ConfigModelCapability; start: number } | undefined,
): Promise<ConfigSwitchModelsView> {
  const slots = await Promise.all(
    CONFIG_MODEL_CAPABILITY_ORDER.map(async (capability) => {
      const [assignment, providers] = await Promise.all([
        resolveSlotAssignment(state, capability),
        loadConfigModelProviders(state.server_id, capability),
      ]);
      return {
        capability,
        currentModelName: assignment.modelName,
        currentProvider: assignment.provider,
        eligibleProviders: providers.map((row) => row.provider),
        providerPageStart: providerPage?.capability === capability ? providerPage.start : 0,
      };
    }),
  );

  const [channelOverrides, personaOverrides] = await Promise.all([
    llmOverrideRepo.getAllChannelLlmOverridesForServer(state.server_id),
    llmOverrideRepo.loadPersonaLlmOverridesForServer(state.server_id),
  ]);

  return {
    slots,
    channelOverrideCount: channelOverrides.length,
    personaOverrideCount: personaOverrides.length,
  };
}

export async function loadConfigParametersView(
  state: TomoriState,
  requestedProvider: string | undefined,
  logitBiasPageStart: number,
): Promise<ConfigParametersView> {
  const providers = await loadSavedProvidersForCapability(state.server_id, "text");
  const selected =
    providers.find((row) => row.provider.toLowerCase() === requestedProvider?.toLowerCase()) ??
    providers.find((row) => row.provider.toLowerCase() === state.llm?.llm_provider?.toLowerCase()) ??
    providers[0] ??
    null;

  return {
    textProviders: providers.map((row) => row.provider),
    selectedProvider: selected?.provider ?? null,
    selectedConfig: selected,
    stopStrings: state.config.llm_stop_strings ?? [],
    speakerPatternEnabled: state.config.llm_stop_speaker_pattern_enabled ?? false,
    logitBiasEntries: state.config.llm_logit_biases ?? [],
    logitBiasPageStart,
  };
}

function describeFallbackEntry(
  locale: string,
  entry: FallbackEntry | null,
  rawRef: FallbackModelRef | null,
): string | null {
  if (!entry) {
    if (!rawRef) return null;
    return `${localizer(locale, "general.unknown")} (#${rawRef.id})`;
  }
  if (entry.kind === "llm") {
    return `${entry.model.llm_codename} (${getProviderDisplayName(entry.model.llm_provider)})`;
  }
  return `${entry.endpoint.label}:${entry.endpoint.model_name ?? entry.endpoint.label} (${localizer(
    locale,
    "commands.model.fallback.custom_provider_label",
  )})`;
}

/**
 * Value a fallback provider option carries: the provider plus the option-page offset the modal
 * should open on.
 *
 * The five slot selects share one option list, so the modal cannot page inside itself; the range is
 * chosen here, as one select option per page, rather than by a prev/next row that would strand the
 * page it is parked on.
 */
export function encodeFallbackProviderValue(provider: string, start: number): string {
  return `${start}|${provider}`;
}

export function decodeFallbackProviderValue(value: string): { provider: string; start: number } | null {
  const separator = value.indexOf("|");
  if (separator < 0) return null;
  const start = Number.parseInt(value.slice(0, separator), 10);
  const provider = value.slice(separator + 1);
  if (!Number.isInteger(start) || start < 0 || !provider) return null;
  return { provider, start };
}

export async function loadConfigFallbacksView(
  state: TomoriState,
  locale: string,
  expandedProvider: string | null,
): Promise<ConfigFallbacksView> {
  const providers = await loadSavedProvidersForCapability(state.server_id, "text");
  const refs = state.config.fallback_model_refs ?? [];
  const chain = state.fallback_chain ?? [];

  const expandedOptionCount = expandedProvider ? (await loadConfigFallbackOptions(state, expandedProvider)).length : 0;
  const { entries } = buildProviderPageEntries({
    providers: providers.map((row) => row.provider),
    expandedProvider,
    expandedOptionCount,
    pageSize: CONFIG_FALLBACK_PAGE_SIZE,
    locale,
    encodeProviderValue: (provider) => encodeFallbackProviderValue(provider, 0),
    encodePageValue: (provider, start) => encodeFallbackProviderValue(provider, start),
  });

  return {
    slots: Array.from({ length: CONFIG_FALLBACK_SLOT_COUNT }, (_slot, index) => ({
      label: describeFallbackEntry(locale, chain[index] ?? null, refs[index] ?? null),
    })),
    providerEntries: entries,
    randomizerEnabled: state.config.model_randomizer_enabled ?? false,
    hasFallbacks: refs.length > 0,
  };
}

/**
 * The models one provider contributes to a fallback slot.
 *
 * A custom label resolves through connection-scoped endpoint rows rather than the model catalog, so
 * each saved fallback keeps pointing at the exact endpoint it was chosen from.
 */
export async function loadConfigFallbackOptions(state: TomoriState, provider: string): Promise<ConfigFallbackOption[]> {
  if (isCustomProvider(provider)) {
    const parsed = parseCustomProvider(provider);
    if (!parsed) return [];
    const endpoints = await llmProviderRepo.loadCustomEndpointsForServer(state.server_id);
    return endpoints
      .filter((endpoint) => endpoint.connection_id === parsed.connectionId && endpoint.capability === "text")
      .map((endpoint) => ({
        value: `${CONFIG_FALLBACK_ENDPOINT_PREFIX}${endpoint.custom_endpoint_id}`,
        label: `${endpoint.label}:${endpoint.model_name ?? endpoint.label}`,
        description: endpoint.model_name ?? endpoint.label,
      }));
  }

  const models =
    (await llmModelRepo.loadAvailableModelsForProvider(provider, false, {
      kind: "server",
      ownerId: state.server_id,
    })) ?? [];
  // `other-model` is a migration placeholder rather than a routable model, so it never becomes a
  // fallback the chain would try to call.
  return models
    .filter((model) => model.llm_codename !== "other-model")
    .map((model) => ({
      value: model.llm_codename,
      label: model.llm_codename,
      description: model.llm_description ?? undefined,
    }));
}

export function loadConfigImageGenerationView(state: TomoriState, locale: string): ConfigImageGenerationView {
  const effective = resolveNaiImageParams({
    nai_sampler: state.config.nai_sampler,
    nai_steps: state.config.nai_steps,
    nai_scale: state.config.nai_scale,
    nai_noise_schedule: state.config.nai_noise_schedule,
    nai_cfg_rescale: state.config.nai_cfg_rescale,
  });
  const noneLabel = localizer(locale, "commands.config.panel.none_label");

  return {
    positiveTags: state.config.image_default_positive_tags ?? [],
    negativeTags: state.config.image_default_negative_tags ?? [],
    sampler: effective.sampler || noneLabel,
    steps: String(effective.steps),
    scale: String(effective.scale),
    noiseSchedule: effective.noiseSchedule || noneLabel,
    cfgRescale: String(effective.cfgRescale),
  };
}

export async function loadConfigModelListView(
  state: TomoriState,
  capability: ConfigModelCapability,
  provider: string,
  start: number,
): Promise<{
  models: Awaited<ReturnType<typeof loadConfigModelChoices>>;
  currentModelId: number | null;
  start: number;
}> {
  const models = await loadConfigModelChoices(state.server_id, capability, provider);
  return { models, currentModelId: currentModelIdForCapability(state, capability), start };
}
