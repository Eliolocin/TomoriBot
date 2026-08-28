import type {
  CustomEndpointRow,
  PersonalProviderCapability,
  SavedProviderConfigRow,
  AssembledServerConfig,
  UserSavedProviderConfigRow,
} from "@/types/db/schema";
import { personalProviderCapabilitySchema } from "@/types/db/schema";
import { configRepository, llmModelRepo, llmProviderRepo } from "@/utils/db/repositories";
import { log } from "@/utils/misc/logger";
import { resolveCustomEndpointForProvider } from "@/utils/provider/customEndpointService";
import { decryptApiKey } from "@/utils/security/crypto";
import { CUSTOM_ENDPOINT_PLACEHOLDER_KEY } from "@/utils/provider/legacyCustomProvider";
import { isCustomProvider } from "@/utils/provider/customProviderUtils";

export type Capability = "text" | "embedding" | "image-standard" | "image-nai" | "video" | "vision";

export interface ResolvedCredentials {
  provider: string;
  apiKey: string;
  keyVersion: number;
  savedConfig: SavedProviderConfigRow | UserSavedProviderConfigRow;
  source: "server" | "personal";
  customEndpoint?: CustomEndpointRow;
  apiStyle?: string;
}

interface ResolverOptions {
  userId?: number | null;
}

type CapabilityConfigColumns = Pick<
  AssembledServerConfig,
  | "llm_id"
  | "embedding_model_id"
  | "diffusion_model_id"
  | "nai_diffusion_model_id"
  | "video_model_id"
  | "vision_llm_id"
  | "user_byok_mode"
>;

export class CredentialUnavailableError extends Error {
  constructor(
    public provider: string,
    public capability: Capability,
    public reason: "no_saved_config" | "decryption_failed" | "placeholder_key" | "missing_model_id",
    public source: "server" | "personal" = "server",
  ) {
    super(`No usable credentials for ${provider} (${capability}, ${source}): ${reason}`);
    this.name = "CredentialUnavailableError";
  }
}

export class PersonalProviderRequiredError extends Error {
  constructor(public capability: Capability) {
    super(`A personal provider is required for ${capability}`);
    this.name = "PersonalProviderRequiredError";
  }
}

function mapCapabilityToPersonalCapability(capability: Capability): PersonalProviderCapability {
  switch (capability) {
    case "text":
      return "text";
    case "embedding":
      return "embedding";
    case "image-standard":
      return "image";
    case "image-nai":
      return "image_nai";
    case "video":
      return "video";
    case "vision":
      return "vision";
  }
}

function getCapabilityModelId(
  savedConfig: SavedProviderConfigRow | UserSavedProviderConfigRow,
  capability: Capability,
): number | null {
  switch (capability) {
    case "text":
      return savedConfig.llm_id ?? null;
    case "embedding":
      return savedConfig.embedding_model_id ?? null;
    case "image-standard":
      return savedConfig.diffusion_model_id ?? null;
    case "image-nai":
      return savedConfig.nai_diffusion_model_id ?? null;
    case "video":
      return savedConfig.video_model_id ?? null;
    case "vision":
      return savedConfig.vision_llm_id ?? null;
  }
}

/**
 * Reads the active model id for a capability from live server config columns.
 *
 * Used to tell the custom-endpoint resolver which specific model is active (server scope), so the
 * correct endpoint row is chosen when a label hosts several models of the same capability.
 */
function capabilityModelIdFromColumns(config: CapabilityConfigColumns | null, capability: Capability): number | null {
  if (!config) {
    return null;
  }
  switch (capability) {
    case "text":
      return config.llm_id ?? null;
    case "embedding":
      return config.embedding_model_id ?? null;
    case "image-standard":
      return config.diffusion_model_id ?? null;
    case "image-nai":
      return config.nai_diffusion_model_id ?? null;
    case "video":
      return config.video_model_id ?? null;
    case "vision":
      return config.vision_llm_id ?? null;
  }
}

export function getResolvedCapabilityModelId(
  resolved: Pick<ResolvedCredentials, "savedConfig" | "source">,
  capability: Capability,
): number | null {
  if (resolved.source === "server") {
    return null;
  }
  return getCapabilityModelId(resolved.savedConfig, capability);
}

async function loadCapabilityConfig(serverId: number): Promise<CapabilityConfigColumns | null> {
  return configRepository.loadModelCapabilityIds(serverId);
}

async function resolveProviderForCapability(serverId: number, capability: Capability): Promise<string> {
  const config = await loadCapabilityConfig(serverId);
  if (!config) {
    throw new CredentialUnavailableError("unknown", capability, "missing_model_id");
  }

  switch (capability) {
    case "text": {
      if (!config.llm_id) {
        throw new CredentialUnavailableError("unknown", capability, "missing_model_id");
      }
      const llm = await llmModelRepo.loadById(config.llm_id);
      if (!llm?.llm_provider) {
        throw new CredentialUnavailableError("unknown", capability, "missing_model_id");
      }
      return llm.llm_provider.toLowerCase();
    }
    case "embedding": {
      if (!config.embedding_model_id) {
        throw new CredentialUnavailableError("unknown", capability, "missing_model_id");
      }
      const embModel = await llmModelRepo.loadEmbeddingModelById(config.embedding_model_id);
      if (!embModel?.provider) {
        throw new CredentialUnavailableError("unknown", capability, "missing_model_id");
      }
      return String(embModel.provider).toLowerCase();
    }
    case "image-standard": {
      if (!config.diffusion_model_id) {
        throw new CredentialUnavailableError("unknown", capability, "missing_model_id");
      }
      const diffModel = await llmModelRepo.loadDiffusionModelById(config.diffusion_model_id);
      if (!diffModel?.provider) {
        throw new CredentialUnavailableError("unknown", capability, "missing_model_id");
      }
      return String(diffModel.provider).toLowerCase();
    }
    case "image-nai": {
      if (!config.nai_diffusion_model_id) {
        throw new CredentialUnavailableError("unknown", capability, "missing_model_id");
      }
      const naiModel = await llmModelRepo.loadDiffusionModelById(config.nai_diffusion_model_id);
      if (!naiModel?.provider) {
        throw new CredentialUnavailableError("unknown", capability, "missing_model_id");
      }
      return String(naiModel.provider).toLowerCase();
    }
    case "video": {
      if (!config.video_model_id) {
        throw new CredentialUnavailableError("unknown", capability, "missing_model_id");
      }
      const videoModel = await llmModelRepo.loadVideoGenerationModelById(config.video_model_id);
      if (!videoModel?.provider) {
        throw new CredentialUnavailableError("unknown", capability, "missing_model_id");
      }
      return String(videoModel.provider).toLowerCase();
    }
    case "vision": {
      if (!config.vision_llm_id) {
        throw new CredentialUnavailableError("unknown", capability, "missing_model_id");
      }
      const visionLlm = await llmModelRepo.loadById(config.vision_llm_id);
      if (!visionLlm?.llm_provider) {
        throw new CredentialUnavailableError("unknown", capability, "missing_model_id");
      }
      return visionLlm.llm_provider.toLowerCase();
    }
  }
}

async function decryptResolvedApiKey(
  savedConfig: SavedProviderConfigRow | UserSavedProviderConfigRow,
  provider: string,
  capability: Capability,
  source: "server" | "personal",
  contextLabel: string,
  activeModelId?: number | null,
): Promise<ResolvedCredentials> {
  const customEndpointCapability =
    capability === "image-standard"
      ? "image"
      : capability === "vision"
        ? "text"
        : capability === "image-nai"
          ? null
          : capability;
  // Pass the active model id so the right endpoint row is chosen when several models share a
  // label+capability; resolution falls back to the label's default when no id matches.
  const customEndpoint =
    isCustomProvider(provider) && customEndpointCapability
      ? await resolveCustomEndpointForProvider(provider, customEndpointCapability, activeModelId)
      : null;

  if (!savedConfig.api_key) {
    throw new CredentialUnavailableError(provider, capability, "no_saved_config", source);
  }

  let decryptedKey: string;
  try {
    decryptedKey = await decryptApiKey(savedConfig.api_key, savedConfig.key_version || 1);
  } catch (error) {
    log.warn(`Failed to decrypt credentials for provider ${provider} (${capability}) on ${contextLabel}`, error);
    throw new CredentialUnavailableError(provider, capability, "decryption_failed", source);
  }

  if (!decryptedKey || decryptedKey === CUSTOM_ENDPOINT_PLACEHOLDER_KEY) {
    if (customEndpoint && customEndpoint.requires_auth === false) {
      return {
        provider,
        apiKey: "",
        keyVersion: savedConfig.key_version || 1,
        savedConfig,
        source,
        customEndpoint,
        apiStyle: customEndpoint.api_style,
      };
    }
    throw new CredentialUnavailableError(provider, capability, "placeholder_key", source);
  }

  return {
    provider,
    apiKey: decryptedKey,
    keyVersion: savedConfig.key_version || 1,
    savedConfig,
    source,
    customEndpoint: customEndpoint ?? undefined,
    apiStyle: customEndpoint?.api_style,
  };
}

async function resolvePersonalCredentials(userId: number, capability: Capability): Promise<ResolvedCredentials | null> {
  const personalCapability = mapCapabilityToPersonalCapability(capability);
  personalProviderCapabilitySchema.parse(personalCapability);

  const qualifyingRows = (await llmProviderRepo.loadUserSavedProviderConfigs(userId))
    .filter((row) => row.enabled_capabilities.includes(personalCapability))
    .filter((row) => getCapabilityModelId(row, capability) !== null)
    .sort((left, right) => left.provider.localeCompare(right.provider));

  if (qualifyingRows.length === 0) {
    return null;
  }

  if (qualifyingRows.length > 1) {
    log.warn(
      `Multiple personal providers matched user ${userId} capability ${capability}. Falling back to ${qualifyingRows[0].provider}.`,
    );
  }

  const savedConfig = qualifyingRows[0];
  return await decryptResolvedApiKey(
    savedConfig,
    savedConfig.provider.toLowerCase(),
    capability,
    "personal",
    `user ${userId}`,
    getCapabilityModelId(savedConfig, capability),
  );
}

export async function resolveCapabilityCredentials(
  serverId: number,
  capability: Capability,
  options?: ResolverOptions,
): Promise<ResolvedCredentials> {
  const userId = options?.userId ?? null;
  const capabilityConfig = await loadCapabilityConfig(serverId);

  if (userId !== null) {
    const personalResolved = await resolvePersonalCredentials(userId, capability);
    if (personalResolved) {
      return personalResolved;
    }

    if (capabilityConfig?.user_byok_mode) {
      throw new PersonalProviderRequiredError(capability);
    }
  }

  const provider = await resolveProviderForCapability(serverId, capability);
  const savedConfig = await llmProviderRepo.loadSavedProviderConfig(serverId, provider);

  if (!savedConfig) {
    throw new CredentialUnavailableError(provider, capability, "no_saved_config", "server");
  }

  return await decryptResolvedApiKey(
    savedConfig,
    provider,
    capability,
    "server",
    `server ${serverId}`,
    capabilityModelIdFromColumns(capabilityConfig, capability),
  );
}
