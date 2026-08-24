import type { DiffusionModelRow, EmbeddingModelRow, LlmRow, VideoGenerationModelRow } from "@/types/db/schema";
import { getOrFetchOpenRouterCapabilities } from "@/utils/cache/openrouterCapabilityCache";
import { getOrFetchOpenRouterEmbeddingModel } from "@/utils/cache/openrouterEmbeddingModelCache";
import { getOrFetchOpenRouterImageModel } from "@/utils/cache/openrouterImageModelCache";
import { getOrFetchOpenRouterVideoModelCapabilities } from "@/utils/cache/openrouterVideoModelCache";
import { llmModelRepo, llmProviderRepo } from "@/utils/db/repositories";
import { isOpenRouterGeminiModelCodename } from "@/utils/provider/openrouterModelCapabilities";

export type OpenRouterModelRegistryScope =
  | {
      kind: "server";
      ownerId: number;
    }
  | {
      kind: "personal";
      ownerId: number;
    };

export type OpenRouterModelCapability = "text" | "embedding" | "image" | "video";

interface RegisteredOpenRouterModelEntry {
  capability: OpenRouterModelCapability;
  codename: string;
  description: string | null;
  modelId: number;
}

export type RegisterOpenRouterModelResult =
  | {
      status: "registered";
      model: RegisteredOpenRouterModelEntry;
    }
  | {
      status: "already_registered";
      model: RegisteredOpenRouterModelEntry;
    }
  | {
      status: "already_available";
      model: RegisteredOpenRouterModelEntry;
    }
  | {
      status: "invalid_model";
    };

function normalizeModelCodename(modelName: string): string {
  return modelName.trim().toLowerCase();
}

function buildRegisteredEntryFromLlm(llm: LlmRow): RegisteredOpenRouterModelEntry | null {
  if (!llm.llm_id) {
    return null;
  }

  return {
    capability: "text",
    codename: llm.llm_codename,
    description: llm.llm_description ?? llm.ja_description ?? llm.llm_codename,
    modelId: llm.llm_id,
  };
}

function buildRegisteredEntryFromEmbeddingModel(model: EmbeddingModelRow): RegisteredOpenRouterModelEntry | null {
  if (!model.embedding_model_id) {
    return null;
  }

  return {
    capability: "embedding",
    codename: model.codename,
    description: model.model_description ?? model.ja_description ?? model.codename,
    modelId: model.embedding_model_id,
  };
}

function buildRegisteredEntryFromDiffusionModel(model: DiffusionModelRow): RegisteredOpenRouterModelEntry | null {
  if (!model.diffusion_model_id) {
    return null;
  }

  return {
    capability: "image",
    codename: model.codename,
    description: model.model_description ?? model.ja_description ?? model.codename,
    modelId: model.diffusion_model_id,
  };
}

function buildRegisteredEntryFromVideoModel(model: VideoGenerationModelRow): RegisteredOpenRouterModelEntry | null {
  if (!model.video_model_id) {
    return null;
  }

  return {
    capability: "video",
    codename: model.codename,
    description: model.model_description ?? model.ja_description ?? model.codename,
    modelId: model.video_model_id,
  };
}

/**
 * OpenRouter publishes one catalog per modality and lists a model in exactly the catalogs
 * that serve it: embedding models are absent from `/models` entirely, and image generation
 * has a far larger catalog than the handful of chat models with image output. Each
 * capability therefore has to be checked against its own endpoint.
 */
async function modelExistsInOpenRouterCatalog(
  capability: OpenRouterModelCapability,
  modelCodename: string,
): Promise<boolean> {
  switch (capability) {
    case "text":
      return Boolean(await getOrFetchOpenRouterCapabilities(modelCodename));
    case "embedding":
      return Boolean(await getOrFetchOpenRouterEmbeddingModel(modelCodename));
    case "image":
      return Boolean(await getOrFetchOpenRouterImageModel(modelCodename));
    case "video":
      return Boolean(await getOrFetchOpenRouterVideoModelCapabilities(modelCodename));
  }
}

async function upsertScopedOpenRouterLlm(modelCodename: string): Promise<LlmRow | null> {
  const capabilities = await getOrFetchOpenRouterCapabilities(modelCodename);
  if (!capabilities) {
    return null;
  }

  const llmId = await llmModelRepo.upsertScopedLlm(modelCodename, {
    hasTools: capabilities.hasTools,
    seesImages: capabilities.seesImages,
    seesVideos: capabilities.seesVideos,
    seesYoutube: isOpenRouterGeminiModelCodename(modelCodename),
    supportsStructuredOutput: capabilities.supportsStructuredOutput,
  });
  return llmId ? await llmModelRepo.loadByProviderAndCodename("openrouter", modelCodename) : null;
}

async function upsertScopedOpenRouterEmbeddingModel(modelCodename: string): Promise<EmbeddingModelRow | null> {
  const embeddingModelId = await llmModelRepo.upsertScopedEmbeddingModel(modelCodename);
  return embeddingModelId
    ? await llmModelRepo.loadEmbeddingModelByProviderAndCodename("openrouter", modelCodename)
    : null;
}

async function upsertScopedOpenRouterDiffusionModel(modelCodename: string): Promise<DiffusionModelRow | null> {
  const diffusionModelId = await llmModelRepo.upsertScopedDiffusionModel(modelCodename);
  return diffusionModelId
    ? await llmModelRepo.loadDiffusionModelByProviderAndCodename("openrouter", modelCodename)
    : null;
}

async function upsertScopedOpenRouterVideoModel(modelCodename: string): Promise<VideoGenerationModelRow | null> {
  const videoModelId = await llmModelRepo.upsertScopedVideoModel(modelCodename);
  return videoModelId
    ? await llmModelRepo.loadVideoGenerationModelByProviderAndCodename("openrouter", modelCodename)
    : null;
}

async function loadRegisteredOpenRouterEntriesForCapability(
  scope: OpenRouterModelRegistryScope,
  capability: OpenRouterModelCapability,
): Promise<RegisteredOpenRouterModelEntry[]> {
  switch (capability) {
    case "text":
      return (await llmProviderRepo.loadScopedOpenRouterModels(scope, true))
        .filter((model) => model.is_scoped_registration)
        .map(buildRegisteredEntryFromLlm)
        .filter((model): model is RegisteredOpenRouterModelEntry => model !== null);
    case "embedding":
      return (await llmProviderRepo.loadScopedOpenRouterEmbeddingModels(scope, true))
        .filter((model) => model.is_scoped_registration)
        .map(buildRegisteredEntryFromEmbeddingModel)
        .filter((model): model is RegisteredOpenRouterModelEntry => model !== null);
    case "image":
      return (await llmProviderRepo.loadScopedOpenRouterDiffusionModels(scope, true))
        .filter((model) => model.is_scoped_registration)
        .map(buildRegisteredEntryFromDiffusionModel)
        .filter((model): model is RegisteredOpenRouterModelEntry => model !== null);
    case "video":
      return (await llmProviderRepo.loadScopedOpenRouterVideoGenerationModels(scope, true))
        .filter((model) => model.is_scoped_registration)
        .map(buildRegisteredEntryFromVideoModel)
        .filter((model): model is RegisteredOpenRouterModelEntry => model !== null);
  }
}

/**
 * Resolve a codename to a curated built-in catalog entry, or null when it is not
 * a built-in the scope can already use.
 *
 * A row counts as "built-in" (→ registration is rejected with `already_available`)
 * only when it is BOTH non-scoped AND non-deprecated. Deprecated built-ins are
 * deliberately excluded: every selection query filters `is_deprecated = false`, so
 * a deprecated catalog row is hidden from the picker and must instead be
 * registerable as a scoped model by a scope that explicitly opts into it. Returning
 * null here lets {@link registerOpenRouterModelForScope} promote the shared row to a
 * scoped registration (see `upsertScopedLlm`, which clears `is_deprecated`).
 */
async function loadOpenRouterBuiltInEntry(
  capability: OpenRouterModelCapability,
  modelCodename: string,
): Promise<RegisteredOpenRouterModelEntry | null> {
  switch (capability) {
    case "text": {
      const llm = await llmModelRepo.loadByProviderAndCodename("openrouter", modelCodename);
      return llm && !llm.is_scoped_registration && !llm.is_deprecated ? buildRegisteredEntryFromLlm(llm) : null;
    }
    case "embedding": {
      const model = await llmModelRepo.loadEmbeddingModelByProviderAndCodename("openrouter", modelCodename);
      return model && !model.is_scoped_registration && !model.is_deprecated
        ? buildRegisteredEntryFromEmbeddingModel(model)
        : null;
    }
    case "image": {
      const model = await llmModelRepo.loadDiffusionModelByProviderAndCodename("openrouter", modelCodename);
      return model && !model.is_scoped_registration && !model.is_deprecated
        ? buildRegisteredEntryFromDiffusionModel(model)
        : null;
    }
    case "video": {
      const model = await llmModelRepo.loadVideoGenerationModelByProviderAndCodename("openrouter", modelCodename);
      return model && !model.is_scoped_registration && !model.is_deprecated
        ? buildRegisteredEntryFromVideoModel(model)
        : null;
    }
  }
}

export async function registerOpenRouterModelForScope(
  scope: OpenRouterModelRegistryScope,
  capability: OpenRouterModelCapability,
  modelName: string,
): Promise<RegisterOpenRouterModelResult> {
  const normalizedModelName = normalizeModelCodename(modelName);
  if (!normalizedModelName) {
    return { status: "invalid_model" };
  }

  const builtInModel = await loadOpenRouterBuiltInEntry(capability, normalizedModelName);
  if (builtInModel) {
    return {
      status: "already_available",
      model: builtInModel,
    };
  }

  const visibleModels = await loadRegisteredOpenRouterEntriesForCapability(scope, capability);
  const alreadyRegistered = visibleModels.find((model) => model.codename === normalizedModelName);
  if (alreadyRegistered) {
    return {
      status: "already_registered",
      model: alreadyRegistered,
    };
  }

  // Validating before any upsert keeps a typo from creating a scoped row that no request
  // can ever route to and that only shows up later as a provider-side model error.
  if (!(await modelExistsInOpenRouterCatalog(capability, normalizedModelName))) {
    return { status: "invalid_model" };
  }

  switch (capability) {
    case "text": {
      const llm = await upsertScopedOpenRouterLlm(normalizedModelName);
      const entry = llm ? buildRegisteredEntryFromLlm(llm) : null;
      if (!entry) {
        return { status: "invalid_model" };
      }

      const registration =
        scope.kind === "server"
          ? await llmProviderRepo.upsertOpenRouterModelRegistration({
              serverId: scope.ownerId,
              llmId: entry.modelId,
            })
          : await llmProviderRepo.upsertOpenRouterModelRegistration({
              userId: scope.ownerId,
              llmId: entry.modelId,
            });

      if (!registration) {
        throw new Error(`Failed to register scoped OpenRouter text model ${normalizedModelName}`);
      }

      return {
        status: "registered",
        model: entry,
      };
    }
    case "embedding": {
      const model = await upsertScopedOpenRouterEmbeddingModel(normalizedModelName);
      const entry = model ? buildRegisteredEntryFromEmbeddingModel(model) : null;
      if (!entry) {
        return { status: "invalid_model" };
      }

      const registration =
        scope.kind === "server"
          ? await llmProviderRepo.upsertOpenRouterEmbeddingModelRegistration({
              serverId: scope.ownerId,
              embeddingModelId: entry.modelId,
            })
          : await llmProviderRepo.upsertOpenRouterEmbeddingModelRegistration({
              userId: scope.ownerId,
              embeddingModelId: entry.modelId,
            });

      if (!registration) {
        throw new Error(`Failed to register scoped OpenRouter embedding model ${normalizedModelName}`);
      }

      return {
        status: "registered",
        model: entry,
      };
    }
    case "image": {
      const model = await upsertScopedOpenRouterDiffusionModel(normalizedModelName);
      const entry = model ? buildRegisteredEntryFromDiffusionModel(model) : null;
      if (!entry) {
        return { status: "invalid_model" };
      }

      const registration =
        scope.kind === "server"
          ? await llmProviderRepo.upsertOpenRouterImageModelRegistration({
              serverId: scope.ownerId,
              diffusionModelId: entry.modelId,
            })
          : await llmProviderRepo.upsertOpenRouterImageModelRegistration({
              userId: scope.ownerId,
              diffusionModelId: entry.modelId,
            });

      if (!registration) {
        throw new Error(`Failed to register scoped OpenRouter image model ${normalizedModelName}`);
      }

      return {
        status: "registered",
        model: entry,
      };
    }
    case "video": {
      const model = await upsertScopedOpenRouterVideoModel(normalizedModelName);
      const entry = model ? buildRegisteredEntryFromVideoModel(model) : null;
      if (!entry) {
        return { status: "invalid_model" };
      }

      const registration =
        scope.kind === "server"
          ? await llmProviderRepo.upsertOpenRouterVideoModelRegistration({
              serverId: scope.ownerId,
              videoModelId: entry.modelId,
            })
          : await llmProviderRepo.upsertOpenRouterVideoModelRegistration({
              userId: scope.ownerId,
              videoModelId: entry.modelId,
            });

      if (!registration) {
        throw new Error(`Failed to register scoped OpenRouter video model ${normalizedModelName}`);
      }

      return {
        status: "registered",
        model: entry,
      };
    }
  }
}
