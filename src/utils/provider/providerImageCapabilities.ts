import type { DiffusionModelRow } from "@/types/db/schema";
import type { ImageEndpointSupports } from "@/utils/provider/customImageEndpointSupport";
import { resolveProviderFeatureImplementation } from "@/utils/provider/providerInfoRegistry";

/** Per-model declarations a curated diffusion row may carry; null means the operator never declared one. */
export type DeclaredImageSupports = Pick<
  DiffusionModelRow,
  "supports_txt2img" | "supports_img2img" | "supports_inpaint" | "supports_negative_prompt"
>;

const TEXT_ONLY_IMAGE_SUPPORTS: ImageEndpointSupports = {
  txt2img: true,
  img2img: false,
  inpaint: false,
  negative_prompt: false,
};

const REFERENCE_IMAGE_SUPPORTS: ImageEndpointSupports = {
  txt2img: true,
  img2img: true,
  inpaint: false,
  negative_prompt: false,
};

/**
 * What a curated provider's image models can do before any per-model declaration.
 *
 * Null means the provider's image path does not consult these flags at all: NovelAI runs through its own
 * tool, and a provider whose `imageGeneration` feature is "none" generates no images. Callers must treat
 * null as "not declarable" rather than substituting an empty capability set.
 */
export function getCuratedProviderImageDefaults(provider: string): ImageEndpointSupports | null {
  const normalizedProvider = provider.trim().toLowerCase();

  if (
    normalizedProvider === "google" ||
    normalizedProvider === "openrouter" ||
    normalizedProvider === "vertex" ||
    normalizedProvider === "vertexexpress"
  ) {
    return { ...REFERENCE_IMAGE_SUPPORTS };
  }

  const implementation = resolveProviderFeatureImplementation(normalizedProvider, "imageGeneration");
  if (implementation === "zai" || implementation === "nvidia") {
    return { ...TEXT_ONLY_IMAGE_SUPPORTS };
  }
  if (implementation === "google" || implementation === "openrouter") {
    return { ...REFERENCE_IMAGE_SUPPORTS };
  }

  return null;
}

/**
 * Layers a model's declarations over its provider's defaults, one field at a time.
 *
 * The columns are nullable precisely so an undeclared model keeps following its provider's defaults as
 * those change, rather than freezing whatever the defaults happened to be when the row was written.
 */
export function resolveCuratedImageSupports(
  provider: string,
  declared?: DeclaredImageSupports | null,
): ImageEndpointSupports | null {
  const defaults = getCuratedProviderImageDefaults(provider);
  if (!defaults) return null;

  return {
    txt2img: declared?.supports_txt2img ?? defaults.txt2img,
    img2img: declared?.supports_img2img ?? defaults.img2img,
    inpaint: declared?.supports_inpaint ?? defaults.inpaint,
    negative_prompt: declared?.supports_negative_prompt ?? defaults.negative_prompt,
  };
}

/**
 * Parses submitted checkbox values for a curated provider's model.
 *
 * Deliberately not `imageEndpointSupportsFromSubmittedValues`: that one forces inpainting off for every api
 * style but ComfyUI, which is right for a self-hosted endpoint and wrong here, where the provider's own API
 * decides. Returns null when the provider has no declarable image path.
 */
export function curatedImageSupportsFromSubmittedValues(
  values: string[] | undefined,
  provider: string,
): ImageEndpointSupports | null {
  const defaults = getCuratedProviderImageDefaults(provider);
  if (!defaults) return null;

  const selected = new Set(
    values ??
      Object.entries(defaults)
        .filter(([, enabled]) => enabled)
        .map(([support]) => support),
  );
  const hasGenerationMode = selected.has("txt2img") || selected.has("img2img") || selected.has("inpaint");

  return {
    txt2img: hasGenerationMode ? selected.has("txt2img") : true,
    img2img: selected.has("img2img"),
    inpaint: selected.has("inpaint"),
    negative_prompt: selected.has("negative_prompt"),
  };
}
