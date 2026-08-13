/**
 * OpenRouter image generation model catalog.
 *
 * `/api/v1/models` lists a handful of chat models that can emit images, but the image
 * *generation* surface is a separate and much larger catalog, so registration validates
 * against this endpoint rather than filtering output modalities off the text list.
 */

import {
  createOpenRouterCatalog,
  type OpenRouterCatalogModelEntry,
  parseOpenRouterCatalogModelList,
} from "@/utils/cache/openrouterCatalog";

const OPENROUTER_IMAGE_MODELS_URL = "https://openrouter.ai/api/v1/images/models";

export function parseOpenRouterImageModelList(payload: unknown): OpenRouterCatalogModelEntry[] {
  return parseOpenRouterCatalogModelList("image", payload);
}

const imageCatalog = createOpenRouterCatalog<OpenRouterCatalogModelEntry>({
  label: "image",
  url: OPENROUTER_IMAGE_MODELS_URL,
  parse: parseOpenRouterImageModelList,
  keyOf: (entry) => entry.id,
});

export async function initializeOpenRouterImageModelCache(): Promise<void> {
  await imageCatalog.initialize();
}

export function getOrFetchOpenRouterImageModel(
  modelCodename: string,
): Promise<OpenRouterCatalogModelEntry | undefined> {
  return imageCatalog.getOrFetch(modelCodename);
}

export function refreshOpenRouterImageModelCacheIfStale(): Promise<boolean> {
  return imageCatalog.refreshIfStale();
}

export function getOpenRouterImageModelCacheSize(): number {
  return imageCatalog.size();
}

export function isOpenRouterImageModelCacheReady(): boolean {
  return imageCatalog.isReady();
}

export function resetOpenRouterImageModelCache(): void {
  imageCatalog.reset();
}
