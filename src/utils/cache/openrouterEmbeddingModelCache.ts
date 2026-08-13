/**
 * OpenRouter embedding model catalog.
 *
 * Embedding models are absent from `/api/v1/models` entirely, so registration can only be
 * validated against this dedicated endpoint.
 */

import {
  createOpenRouterCatalog,
  type OpenRouterCatalogModelEntry,
  parseOpenRouterCatalogModelList,
} from "@/utils/cache/openrouterCatalog";

const OPENROUTER_EMBEDDING_MODELS_URL = "https://openrouter.ai/api/v1/embeddings/models";

export function parseOpenRouterEmbeddingModelList(payload: unknown): OpenRouterCatalogModelEntry[] {
  return parseOpenRouterCatalogModelList("embedding", payload);
}

const embeddingCatalog = createOpenRouterCatalog<OpenRouterCatalogModelEntry>({
  label: "embedding",
  url: OPENROUTER_EMBEDDING_MODELS_URL,
  parse: parseOpenRouterEmbeddingModelList,
  keyOf: (entry) => entry.id,
});

export async function initializeOpenRouterEmbeddingModelCache(): Promise<void> {
  await embeddingCatalog.initialize();
}

export function getOrFetchOpenRouterEmbeddingModel(
  modelCodename: string,
): Promise<OpenRouterCatalogModelEntry | undefined> {
  return embeddingCatalog.getOrFetch(modelCodename);
}

export function refreshOpenRouterEmbeddingModelCacheIfStale(): Promise<boolean> {
  return embeddingCatalog.refreshIfStale();
}

export function getOpenRouterEmbeddingModelCacheSize(): number {
  return embeddingCatalog.size();
}

export function isOpenRouterEmbeddingModelCacheReady(): boolean {
  return embeddingCatalog.isReady();
}

export function resetOpenRouterEmbeddingModelCache(): void {
  embeddingCatalog.reset();
}
