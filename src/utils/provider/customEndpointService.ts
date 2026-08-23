import type {
  CustomEndpointApiStyle,
  CustomEndpointCapability,
  CustomEndpointRow,
  PersonalProviderCapability,
  SavedProviderConfigUpsert,
  SavedProviderConfigRow,
  ServerModelConfigRow,
  ServerNovelaiImagegenConfigRow,
  AssembledServerConfig,
  UserSavedProviderConfigUpsert,
  UserSavedProviderConfigRow,
} from "@/types/db/schema";
import { invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { configRepository, llmModelRepo, llmOverrideRepo, llmProviderRepo } from "@/utils/db/repositories";

import { CUSTOM_ENDPOINT_PLACEHOLDER_KEY } from "@/utils/provider/legacyCustomProvider";
import {
  buildSavedProviderConfigFromExistingOrDefaults,
  buildUserSavedProviderConfigFromExistingOrDefaults,
} from "@/utils/provider/savedProviderConfig";
import {
  buildCustomProviderName,
  buildSyntheticCustomModelCodename,
  parseCustomProvider,
} from "@/utils/provider/customProviderUtils";
import { buildFallbackModelPersistence, prunePrimaryFallbackRefs } from "@/utils/provider/fallbackModelIdentity";
import { assignPersonalCapabilityToProvider, withPersonalTextPrimary } from "@/utils/provider/personalProviderHelpers";
import { resolveLogitBiasEntriesForLlm } from "@/utils/provider/logitBiasResolver";
import { encryptApiKey } from "@/utils/security/crypto";
import { fetchUserRemoteUrl } from "@/utils/security/userRemoteFetch";

type RegistrationScope =
  | {
      kind: "server";
      ownerId: number;
      baseConfig: AssembledServerConfig;
      serverDiscId?: string;
    }
  | {
      kind: "personal";
      ownerId: number;
      baseConfig: AssembledServerConfig;
    };

export interface CustomEndpointRegistrationInput {
  scope: RegistrationScope;
  label: string;
  capability: CustomEndpointCapability;
  apiStyle: CustomEndpointApiStyle;
  endpointUrl: string;
  modelName?: string | null;
  authToken?: string | null;
  numCtx?: number | null;
  hasTools?: boolean;
  seesImages?: boolean;
  seesVideos?: boolean;
  supportsStructOutput?: boolean;
  // Strict chat-completion compatibility toggles (text capability). Synced to the synthetic llms
  // row so the runtime resolves them uniformly with built-in providers.
  strictRoleAlternation?: boolean;
  supportsPrefixCompletion?: boolean;
  extraConfig?: Record<string, unknown>;
  // When set, edit that exact endpoint row in place (update its model + row by id) instead of
  // registering a new model. Add flows omit it; the edit command supplies the selected row's id.
  editingEndpointId?: number;
}

export interface CustomEndpointRegistrationResult {
  provider: string;
  customEndpoint: CustomEndpointRow;
  modelId: number | null;
}

function getSyntheticModelDescription(endpoint: CustomEndpointRegistrationInput): string {
  return endpoint.modelName?.trim() || endpoint.label;
}

async function getExistingSavedConfig(
  scope: RegistrationScope,
  provider: string,
): Promise<SavedProviderConfigRow | UserSavedProviderConfigRow | null> {
  return scope.kind === "server"
    ? await llmProviderRepo.loadSavedProviderConfig(scope.ownerId, provider)
    : await llmProviderRepo.loadUserSavedProviderConfig(scope.ownerId, provider);
}

async function upsertSyntheticTextModel(
  provider: string,
  endpoint: CustomEndpointRegistrationInput,
): Promise<number | null> {
  const codename = buildSyntheticCustomModelCodename(endpoint.label, endpoint.modelName);
  const description = getSyntheticModelDescription(endpoint);
  const modelId = await llmModelRepo.upsertSyntheticCustomLlm({
    provider,
    codename,
    displayName: description,
    hasTools: endpoint.hasTools ?? false,
    seesImages: endpoint.seesImages ?? false,
    seesVideos: endpoint.seesVideos ?? false,
    supportsStructOutput: endpoint.supportsStructOutput ?? false,
    strictRoleAlternation: endpoint.strictRoleAlternation ?? false,
    supportsPrefixCompletion: endpoint.supportsPrefixCompletion ?? false,
  });

  return modelId;
}

async function upsertSyntheticEmbeddingModel(
  provider: string,
  endpoint: CustomEndpointRegistrationInput,
): Promise<number | null> {
  const codename = buildSyntheticCustomModelCodename(endpoint.label, endpoint.modelName);
  const description = getSyntheticModelDescription(endpoint);
  const modelId = await llmModelRepo.upsertSyntheticCustomEmbeddingModel({
    provider,
    codename,
    displayName: description,
  });

  return modelId;
}

async function upsertSyntheticImageModel(
  provider: string,
  endpoint: CustomEndpointRegistrationInput,
): Promise<number | null> {
  const codename = buildSyntheticCustomModelCodename(endpoint.label, endpoint.modelName);
  const description = getSyntheticModelDescription(endpoint);
  const modelId = await llmModelRepo.upsertSyntheticCustomDiffusionModel({
    provider,
    codename,
    displayName: description,
  });

  return modelId;
}

async function upsertSyntheticVideoModel(
  provider: string,
  endpoint: CustomEndpointRegistrationInput,
): Promise<number | null> {
  const codename = buildSyntheticCustomModelCodename(endpoint.label, endpoint.modelName);
  const description = getSyntheticModelDescription(endpoint);
  const modelId = await llmModelRepo.upsertSyntheticCustomVideoModel({
    provider,
    codename,
    displayName: description,
  });

  return modelId;
}

async function upsertSyntheticCapabilityModel(
  provider: string,
  endpoint: CustomEndpointRegistrationInput,
): Promise<number | null> {
  switch (endpoint.capability) {
    case "text":
      return await upsertSyntheticTextModel(provider, endpoint);
    case "embedding":
      return await upsertSyntheticEmbeddingModel(provider, endpoint);
    case "image":
      return await upsertSyntheticImageModel(provider, endpoint);
    case "video":
      return await upsertSyntheticVideoModel(provider, endpoint);
    default:
      return null;
  }
}

/**
 * Writes the synthetic model row backing an endpoint and returns its id.
 *
 * On the add path (no existing model ref) it inserts a fresh synthetic model. On the edit path it
 * updates the existing model row in place by id, so a renamed model_name (which changes the derived
 * codename) does not orphan the row that live config still references by id.
 */
async function writeSyntheticCapabilityModel(
  provider: string,
  endpoint: CustomEndpointRegistrationInput,
  existingModelRefId: number | null,
): Promise<number | null> {
  if (existingModelRefId == null) {
    return await upsertSyntheticCapabilityModel(provider, endpoint);
  }

  if (endpoint.capability === "speech" || endpoint.capability === "transcription") {
    return null;
  }

  const codename = buildSyntheticCustomModelCodename(endpoint.label, endpoint.modelName);
  const description = getSyntheticModelDescription(endpoint);
  await llmModelRepo.updateSyntheticCustomCapabilityModelById({
    modelRefId: existingModelRefId,
    capability: endpoint.capability,
    codename,
    displayName: description,
    hasTools: endpoint.hasTools ?? false,
    seesImages: endpoint.seesImages ?? false,
    seesVideos: endpoint.seesVideos ?? false,
    supportsStructOutput: endpoint.supportsStructOutput ?? false,
    strictRoleAlternation: endpoint.strictRoleAlternation ?? false,
    supportsPrefixCompletion: endpoint.supportsPrefixCompletion ?? false,
  });
  return existingModelRefId;
}

function getCapabilityModelId(
  config: SavedProviderConfigRow | UserSavedProviderConfigRow,
  capability: CustomEndpointCapability,
): number | null {
  switch (capability) {
    case "text":
      return config.llm_id ?? null;
    case "embedding":
      return config.embedding_model_id ?? null;
    case "image":
      return config.diffusion_model_id ?? null;
    case "video":
      return config.video_model_id ?? null;
    case "speech":
    case "transcription":
      return null;
  }
}

function toPersonalModelCapability(capability: CustomEndpointCapability): PersonalProviderCapability | null {
  switch (capability) {
    case "text":
    case "embedding":
    case "image":
    case "video":
      return capability;
    case "speech":
    case "transcription":
      return null;
  }
}

async function activateServerCustomTextModel(params: {
  scope: Extract<RegistrationScope, { kind: "server" }>;
  endpoint: CustomEndpointRow;
  savedConfig: SavedProviderConfigRow | SavedProviderConfigUpsert;
  modelId: number;
}): Promise<boolean> {
  const selectedModel = await llmModelRepo.loadById(params.modelId);
  if (!selectedModel?.llm_id) {
    return false;
  }

  const promotedLlmId = selectedModel.llm_id;
  // Registration activates the endpoint immediately, but it must not discard the server-wide
  // cross-provider fallback chain that was active before registration.
  const { fallbackModelRefs, fallbackLlmIds } = buildFallbackModelPersistence(
    params.scope.baseConfig.fallback_model_refs ?? [],
    promotedLlmId,
    [params.endpoint],
  );
  const resolvedLogitBiases = resolveLogitBiasEntriesForLlm(
    params.savedConfig.llm_logit_biases ?? params.scope.baseConfig.llm_logit_biases ?? [],
    selectedModel,
  );

  const [updatedModel, updatedChat] = await Promise.all([
    configRepository.updateModelConfig(params.scope.ownerId, {
      llm_id: selectedModel.llm_id,
      api_key: params.savedConfig.api_key,
      key_version: params.savedConfig.key_version ?? 1,
      thinking_level: params.savedConfig.thinking_level ?? "auto",
      fallback_llm_ids: fallbackLlmIds,
      llm_temperature: params.savedConfig.llm_temperature ?? params.scope.baseConfig.llm_temperature ?? 1.0,
      llm_disabled_params: params.savedConfig.llm_disabled_params ?? [],
      custom_model_name: null,
      custom_endpoint_url: null,
      custom_num_ctx: null,
    }),
    configRepository.updateChatConfig(params.scope.ownerId, {
      llm_top_p: params.savedConfig.llm_top_p ?? params.scope.baseConfig.llm_top_p ?? 0.95,
      llm_top_k: params.savedConfig.llm_top_k ?? params.scope.baseConfig.llm_top_k ?? 0,
      llm_frequency_penalty:
        params.savedConfig.llm_frequency_penalty ?? params.scope.baseConfig.llm_frequency_penalty ?? 0.0,
      llm_presence_penalty:
        params.savedConfig.llm_presence_penalty ?? params.scope.baseConfig.llm_presence_penalty ?? 0.0,
      llm_min_p: params.savedConfig.llm_min_p ?? params.scope.baseConfig.llm_min_p ?? 0.05,
      llm_logit_biases: resolvedLogitBiases.entries,
      fallback_model_refs: fallbackModelRefs,
    }),
  ]);

  if (updatedModel && updatedChat && params.scope.serverDiscId) {
    invalidateTomoriStateCache(params.scope.serverDiscId);
  }

  return updatedModel && updatedChat;
}

async function activateServerCustomEndpointForCapability(params: {
  scope: Extract<RegistrationScope, { kind: "server" }>;
  endpoint: CustomEndpointRow;
  capability: CustomEndpointCapability;
  modelId: number | null;
  savedConfig: SavedProviderConfigRow | SavedProviderConfigUpsert;
}): Promise<boolean> {
  if (params.capability === "speech" || params.capability === "transcription") {
    return true;
  }

  if (!params.modelId) {
    return false;
  }

  if (params.capability === "text") {
    return await activateServerCustomTextModel({
      scope: params.scope,
      endpoint: params.endpoint,
      savedConfig: params.savedConfig,
      modelId: params.modelId,
    });
  }

  const updated =
    params.capability === "embedding"
      ? await configRepository.updateModelConfig(params.scope.ownerId, { embedding_model_id: params.modelId })
      : params.capability === "image"
        ? await configRepository.updateModelConfig(params.scope.ownerId, { diffusion_model_id: params.modelId })
        : await configRepository.updateModelConfig(params.scope.ownerId, { video_model_id: params.modelId });

  if (updated && params.scope.serverDiscId) {
    invalidateTomoriStateCache(params.scope.serverDiscId);
  }

  return updated;
}

async function activatePersonalCustomEndpointForCapability(params: {
  userId: number;
  provider: string;
  endpoint: CustomEndpointRow;
  capability: CustomEndpointCapability;
  modelId: number | null;
  seesImages: boolean;
}): Promise<boolean> {
  const capability = toPersonalModelCapability(params.capability);
  if (!capability) {
    return true;
  }

  if (!params.modelId) {
    return false;
  }

  const updated = await assignPersonalCapabilityToProvider(params.userId, params.provider, capability, (row) => {
    switch (params.capability) {
      case "text":
        return withPersonalTextPrimary(row, params.modelId, [params.endpoint]);
      case "embedding":
        return { ...row, embedding_model_id: params.modelId };
      case "image":
        return { ...row, diffusion_model_id: params.modelId };
      case "video":
        return { ...row, video_model_id: params.modelId };
      case "speech":
      case "transcription":
        return row;
    }
  });

  return updated;
}

async function clearServerScopedLiveReferences(
  scope: Extract<RegistrationScope, { kind: "server" }>,
  capability: CustomEndpointCapability,
  modelId: number | null,
  siblingModelId: number | null,
): Promise<void> {
  if (!modelId) {
    return;
  }

  const serverId = scope.ownerId;
  const modelPatch: Partial<ServerModelConfigRow> = {};
  const novelaiPatch: Partial<ServerNovelaiImagegenConfigRow> = {};

  switch (capability) {
    case "text":
      if (scope.baseConfig.llm_id === modelId) {
        modelPatch.llm_id = siblingModelId;
        modelPatch.custom_endpoint_url = null;
        modelPatch.custom_model_name = null;
        modelPatch.custom_num_ctx = null;
      }
      if (scope.baseConfig.vision_llm_id === modelId) {
        modelPatch.vision_llm_id = null;
      }
      await Promise.all([
        updateModelConfigIfNeeded(serverId, modelPatch),
        llmOverrideRepo.deleteChannelLlmOverridesForModel(serverId, modelId, { serverDiscId: scope.serverDiscId }),
        llmOverrideRepo.clearPersonaLlmOverridesForModel(serverId, modelId, { serverDiscId: scope.serverDiscId }),
      ]);
      return;
    case "embedding":
      if (scope.baseConfig.embedding_model_id === modelId) {
        modelPatch.embedding_model_id = siblingModelId;
      }
      await updateModelConfigIfNeeded(serverId, modelPatch);
      return;
    case "image":
      if (scope.baseConfig.diffusion_model_id === modelId) {
        modelPatch.diffusion_model_id = siblingModelId;
      }
      if (scope.baseConfig.nai_diffusion_model_id === modelId) {
        novelaiPatch.nai_diffusion_model_id = null;
      }
      await Promise.all([
        updateModelConfigIfNeeded(serverId, modelPatch),
        updateNovelaiImagegenConfigIfNeeded(serverId, novelaiPatch),
      ]);
      return;
    case "video":
      if (scope.baseConfig.video_model_id === modelId) {
        modelPatch.video_model_id = siblingModelId;
      }
      await updateModelConfigIfNeeded(serverId, modelPatch);
      return;
  }
}

async function updateModelConfigIfNeeded(serverId: number, patch: Partial<ServerModelConfigRow>): Promise<boolean> {
  return Object.keys(patch).length > 0 ? await configRepository.updateModelConfig(serverId, patch) : true;
}

async function updateNovelaiImagegenConfigIfNeeded(
  serverId: number,
  patch: Partial<ServerNovelaiImagegenConfigRow>,
): Promise<boolean> {
  return Object.keys(patch).length > 0 ? await configRepository.updateNovelaiImagegenConfig(serverId, patch) : true;
}

async function buildSavedConfigForCustomEndpoint(
  scope: RegistrationScope,
  provider: string,
  existingConfig: SavedProviderConfigRow | UserSavedProviderConfigRow | null,
  endpoint: CustomEndpointRegistrationInput,
  modelId: number | null,
) {
  const trimmedAuthToken = endpoint.authToken?.trim();
  const encryptionResult =
    trimmedAuthToken && trimmedAuthToken.length > 0
      ? await encryptApiKey(trimmedAuthToken)
      : existingConfig?.api_key
        ? {
            encrypted: existingConfig.api_key,
            version: existingConfig.key_version || 1,
          }
        : await encryptApiKey(CUSTOM_ENDPOINT_PLACEHOLDER_KEY);

  const textModelId = endpoint.capability === "text" ? modelId : undefined;

  return scope.kind === "server"
    ? await buildSavedProviderConfigFromExistingOrDefaults({
        serverId: scope.ownerId,
        provider,
        apiKey: encryptionResult.encrypted,
        keyVersion: encryptionResult.version,
        baseConfig: scope.baseConfig,
        existingConfig: existingConfig as SavedProviderConfigRow | null,
        llmId: textModelId,
      })
    : await buildUserSavedProviderConfigFromExistingOrDefaults({
        userId: scope.ownerId,
        provider,
        apiKey: encryptionResult.encrypted,
        keyVersion: encryptionResult.version,
        baseConfig: scope.baseConfig,
        existingConfig: existingConfig as UserSavedProviderConfigRow | null,
        llmId: textModelId,
        enabledCapabilities: (existingConfig as UserSavedProviderConfigRow | null)?.enabled_capabilities ?? [],
      }).then((config) => {
        // Registering an endpoint both switches its capabilities on and claims them
        // for this provider, so the two arrays take the same additions.
        const claimed = capabilitiesClaimedByEndpoint(endpoint);
        return {
          ...config,
          enabled_capabilities: Array.from(new Set([...config.enabled_capabilities, ...claimed])),
          assigned_capabilities: Array.from(new Set([...config.assigned_capabilities, ...claimed])),
        };
      });
}

function capabilitiesClaimedByEndpoint(endpoint: {
  capability: CustomEndpointCapability;
  seesImages?: boolean;
}): PersonalProviderCapability[] {
  switch (endpoint.capability) {
    case "text":
      return endpoint.seesImages ? ["text", "vision"] : ["text"];
    case "embedding":
      return ["embedding"];
    case "image":
      return ["image"];
    default:
      return ["video"];
  }
}

export async function registerCustomEndpoint(
  input: CustomEndpointRegistrationInput,
): Promise<CustomEndpointRegistrationResult | null> {
  const isEdit = input.editingEndpointId != null;

  const editingRow = isEdit
    ? ((await llmProviderRepo.loadCustomEndpointsByIds([input.editingEndpointId as number]))[0] ?? null)
    : null;

  if (isEdit && !editingRow) {
    return null;
  }

  // The connection must exist before synthetic models and saved configs can reference its stable ID.
  const connectionId = isEdit
    ? editingRow?.connection_id
    : await llmProviderRepo.upsertCustomEndpointConnection({
        serverId: input.scope.kind === "server" ? input.scope.ownerId : null,
        userId: input.scope.kind === "personal" ? input.scope.ownerId : null,
        label: input.label,
        capability: input.capability,
        apiStyle: input.apiStyle,
        endpointUrl: input.endpointUrl,
        requiresAuth: Boolean(input.authToken?.trim()),
      });

  if (!connectionId) {
    return null;
  }

  const provider = buildCustomProviderName(connectionId);
  const existingConfig = await getExistingSavedConfig(input.scope, provider);

  // Keep activation semantics separate so edits preserve the selected row while additions claim the provider.
  const allEndpoints = await llmProviderRepo.loadCustomEndpointsByConnectionId(connectionId);
  const otherSiblings = allEndpoints.filter((endpoint) => endpoint.custom_endpoint_id !== input.editingEndpointId);
  const shouldActivateNewRegistration = !isEdit;
  const shouldBeDefault = isEdit ? (editingRow?.is_default ?? false) : false;

  const modelId = await writeSyntheticCapabilityModel(provider, input, editingRow?.model_ref_id ?? null);

  // Authentication belongs to the connection, so tokenless siblings inherit its credential requirement.
  const authSibling = editingRow ?? otherSiblings[0] ?? null;
  const trimmedAuthToken = input.authToken?.trim();
  const requiresAuth = trimmedAuthToken && trimmedAuthToken.length > 0 ? true : (authSibling?.requires_auth ?? false);
  const serverScope = input.scope.kind === "server" ? input.scope : null;

  const customEndpoint = await llmProviderRepo.upsertCustomEndpoint(
    {
      serverId: input.scope.kind === "server" ? input.scope.ownerId : null,
      userId: input.scope.kind === "personal" ? input.scope.ownerId : null,
      label: input.label,
      capability: input.capability,
      apiStyle: input.apiStyle,
      endpointUrl: input.endpointUrl,
      modelName: input.modelName ?? null,
      modelRefId: modelId,
      numCtx: input.numCtx ?? null,
      requiresAuth,
      extraConfig: input.extraConfig ?? {},
      hasTools: input.hasTools ?? false,
      seesImages: input.seesImages ?? false,
      seesVideos: input.seesVideos ?? false,
      supportsStructOutput: input.supportsStructOutput ?? false,
      strictRoleAlternation: input.strictRoleAlternation ?? false,
      supportsPrefixCompletion: input.supportsPrefixCompletion ?? false,
      isDefault: shouldBeDefault,
      customEndpointId: isEdit ? input.editingEndpointId : null,
    },
    serverScope ? { serverDiscId: serverScope.serverDiscId } : {},
  );

  if (!customEndpoint) {
    return null;
  }

  const activationEndpointId = customEndpoint.custom_endpoint_id;
  if (shouldActivateNewRegistration && !activationEndpointId) {
    return null;
  }

  // New registrations become active immediately. Edits preserve the existing
  // active slot unless the provider did not have one yet.
  const currentActive = existingConfig ? getCapabilityModelId(existingConfig, input.capability) : null;
  const activeId = shouldActivateNewRegistration ? modelId : (currentActive ?? modelId);

  const savedConfig = await buildSavedConfigForCustomEndpoint(input.scope, provider, existingConfig, input, modelId);
  // Registering an image-capable text model never claims the vision slot: that write also moved the
  // live text model, so one submit silently changed two models. Vision is chosen via /model vision.
  const nextSavedConfig = {
    ...savedConfig,
    llm_id: input.capability === "text" ? activeId : savedConfig.llm_id,
    vision_llm_id: existingConfig?.vision_llm_id ?? null,
    embedding_model_id: input.capability === "embedding" ? activeId : savedConfig.embedding_model_id,
    diffusion_model_id: input.capability === "image" ? activeId : savedConfig.diffusion_model_id,
    video_model_id: input.capability === "video" ? activeId : savedConfig.video_model_id,
    fallback_model_refs:
      input.capability === "text"
        ? prunePrimaryFallbackRefs(savedConfig.fallback_model_refs ?? [], activeId, [customEndpoint])
        : savedConfig.fallback_model_refs,
  };

  const writeOk = serverScope
    ? await llmProviderRepo.upsertSavedProviderConfig(
        serverScope.ownerId,
        nextSavedConfig as SavedProviderConfigUpsert,
        {
          serverDiscId: serverScope.serverDiscId,
        },
      )
    : await llmProviderRepo.upsertUserSavedProviderConfig(
        input.scope.ownerId,
        nextSavedConfig as UserSavedProviderConfigUpsert,
      );

  if (!writeOk) {
    return null;
  }

  if (shouldActivateNewRegistration) {
    if (!activationEndpointId) {
      return null;
    }

    const activated = serverScope
      ? await activateServerCustomEndpointForCapability({
          scope: serverScope,
          endpoint: customEndpoint,
          capability: input.capability,
          modelId,
          savedConfig: nextSavedConfig as SavedProviderConfigUpsert,
        })
      : await activatePersonalCustomEndpointForCapability({
          userId: input.scope.ownerId,
          provider,
          endpoint: customEndpoint,
          capability: input.capability,
          modelId,
          seesImages: input.seesImages ?? false,
        });

    if (!activated) {
      return null;
    }

    const defaulted = await llmProviderRepo.setDefaultCustomEndpoint(
      {
        serverId: input.scope.kind === "server" ? input.scope.ownerId : null,
        userId: input.scope.kind === "personal" ? input.scope.ownerId : null,
        capability: input.capability,
        customEndpointId: activationEndpointId,
        clearScope: input.capability === "speech" || input.capability === "transcription" ? "capability" : "label",
      },
      serverScope ? { serverDiscId: serverScope.serverDiscId } : {},
    );

    if (!defaulted) {
      return null;
    }
  }

  return {
    provider,
    customEndpoint,
    modelId,
  };
}

export async function setActiveCustomEndpoint(params: {
  serverId: number;
  capability: "speech" | "transcription";
  customEndpointId: number;
}): Promise<boolean> {
  return await llmProviderRepo.setActiveCustomEndpoint(params);
}

/**
 * Resolves the custom endpoint row backing a provider for a capability.
 *
 * When an active model id is supplied, the specific endpoint owning that synthetic model is
 * returned: this is how the runtime picks the right row when several models share a connection.
 * When omitted (or no match), it falls back to the most-recently-updated endpoint for the connection.
 *
 * @param provider      - Internal custom provider name (custom:<connection_id>)
 * @param capability    - Endpoint capability
 * @param activeModelId - Optional id of the currently-active synthetic model for this capability
 */
export async function resolveCustomEndpointForProvider(
  provider: string,
  capability: CustomEndpointCapability,
  activeModelId?: number | null,
): Promise<CustomEndpointRow | null> {
  const parsed = parseCustomProvider(provider);
  if (!parsed) {
    return null;
  }

  return await llmProviderRepo.loadCustomEndpointByConnection(parsed.connectionId, capability, activeModelId);
}

export async function removeCustomEndpointRegistration(params: {
  scope: RegistrationScope;
  customEndpointId: number;
  label: string;
  capability: CustomEndpointCapability;
  modelRefId: number | null;
}): Promise<boolean> {
  const endpoints = await llmProviderRepo.loadCustomEndpointsByIds([params.customEndpointId]);
  const targetEndpoint = endpoints[0] ?? null;
  const connectionId = targetEndpoint?.connection_id ?? null;
  const provider = connectionId ? buildCustomProviderName(connectionId) : null;
  const existingConfig = provider ? await getExistingSavedConfig(params.scope, provider) : null;

  // Keep sibling models and their shared connection when removing one model.
  const deleted =
    params.scope.kind === "server"
      ? await llmProviderRepo.deleteCustomEndpointById(params.customEndpointId, {
          serverId: params.scope.ownerId,
          serverDiscId: params.scope.serverDiscId,
        })
      : await llmProviderRepo.deleteCustomEndpointById(params.customEndpointId);

  if (!deleted) {
    return false;
  }

  // Prefer the default sibling during promotion so an explicit model preference survives removal.
  const remaining = connectionId ? await llmProviderRepo.loadCustomEndpointsByConnectionId(connectionId) : [];
  const sameCapabilityRemaining = remaining.filter(
    (endpoint) => endpoint.capability === params.capability && endpoint.model_ref_id != null,
  );
  const siblingModelId =
    (sameCapabilityRemaining.find((e) => e.is_default) ?? sameCapabilityRemaining[0])?.model_ref_id ?? null;

  // Preserve live references by moving them to a surviving sibling when possible.
  if (params.scope.kind === "server") {
    await clearServerScopedLiveReferences(params.scope, params.capability, params.modelRefId, siblingModelId);
  }

  if (params.modelRefId != null) {
    await llmModelRepo.deleteSyntheticCustomCapabilityModelById(params.modelRefId, params.capability);
  }

  // Connection-scoped state is removable only after its final model is gone.
  if (remaining.length === 0) {
    if (connectionId) {
      await llmProviderRepo.deleteCustomEndpointConnectionById(connectionId);
    }
    if (provider) {
      if (params.scope.kind === "server") {
        await llmProviderRepo.deleteSavedProviderConfig(params.scope.ownerId, provider, {
          serverDiscId: params.scope.serverDiscId,
        });
      } else {
        await llmProviderRepo.deleteUserSavedProviderConfig(params.scope.ownerId, provider);
      }
    }
    return true;
  }

  // Keep the saved capability selection aligned with the live endpoint after removal.
  if (!existingConfig || params.modelRefId == null || !provider) {
    return true;
  }
  const activeForCapability = getCapabilityModelId(existingConfig, params.capability);
  const visionMatches = params.capability === "text" && existingConfig.vision_llm_id === params.modelRefId;
  if (activeForCapability !== params.modelRefId && !visionMatches) {
    return true;
  }

  const clearActive = activeForCapability === params.modelRefId;
  const nextConfig = {
    ...existingConfig,
    llm_id: params.capability === "text" && clearActive ? siblingModelId : existingConfig.llm_id,
    vision_llm_id: visionMatches ? null : existingConfig.vision_llm_id,
    embedding_model_id:
      params.capability === "embedding" && clearActive ? siblingModelId : existingConfig.embedding_model_id,
    diffusion_model_id:
      params.capability === "image" && clearActive ? siblingModelId : existingConfig.diffusion_model_id,
    video_model_id: params.capability === "video" && clearActive ? siblingModelId : existingConfig.video_model_id,
  };

  if (params.scope.kind === "server") {
    await llmProviderRepo.upsertSavedProviderConfig(params.scope.ownerId, nextConfig as SavedProviderConfigRow, {
      serverDiscId: params.scope.serverDiscId,
    });
  } else {
    await llmProviderRepo.upsertUserSavedProviderConfig(params.scope.ownerId, nextConfig as UserSavedProviderConfigRow);
  }

  return true;
}

export async function cleanupCustomProviderArtifacts(provider: string): Promise<void> {
  const parsed = parseCustomProvider(provider);
  if (!parsed) {
    return;
  }

  await llmProviderRepo.deleteCustomEndpointConnectionById(parsed.connectionId);

  // Drop every synthetic model owned by this custom provider across all capability tables.
  await llmModelRepo.deleteAllSyntheticModelsForProvider(parsed.raw);
}

export async function validateCustomEndpointReachability(params: {
  apiStyle: CustomEndpointApiStyle;
  endpointUrl: string;
  apiKey?: string | null;
  strict?: boolean;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const headers: Record<string, string> = {};
  if (params.apiKey?.trim()) {
    headers.Authorization = `Bearer ${params.apiKey.trim()}`;
  }

  const fetchOptions = { strict: params.strict };

  try {
    const baseUrl = params.endpointUrl.replace(/\/+$/, "");

    if (params.apiStyle === "comfyui") {
      const response = await fetchUserRemoteUrl(`${baseUrl}/system_stats`, { headers }, fetchOptions);
      return response.ok ? { ok: true } : { ok: false, reason: `HTTP ${response.status} ${response.statusText}` };
    }

    // tts-clone servers implement GET /health per the TomoriBot TTS spec.
    if (params.apiStyle === "tts-clone") {
      const response = await fetchUserRemoteUrl(`${baseUrl}/health`, { headers }, fetchOptions);
      return response.ok ? { ok: true } : { ok: false, reason: `HTTP ${response.status} ${response.statusText}` };
    }

    // openai-compatible-transcription servers expose /v1/models (OpenAI-compatible) or /models.
    if (params.apiStyle === "openai-compatible-transcription") {
      const response = await fetchUserRemoteUrl(`${baseUrl}/v1/models`, { headers }, fetchOptions);
      if (response.ok) return { ok: true };
      // Fall back to the shorter /models path some servers expose.
      const fallback = await fetchUserRemoteUrl(`${baseUrl}/models`, { headers }, fetchOptions);
      return fallback.ok ? { ok: true } : { ok: false, reason: `HTTP ${response.status} ${response.statusText}` };
    }

    const response = await fetchUserRemoteUrl(`${baseUrl}/models`, { headers }, fetchOptions);
    return response.ok ? { ok: true } : { ok: false, reason: `HTTP ${response.status} ${response.statusText}` };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
