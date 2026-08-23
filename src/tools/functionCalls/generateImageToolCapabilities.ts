import type { CustomEndpointRow } from "@/types/db/schema";
import type { ToolAssemblyState } from "@/types/tool/interfaces";
import { configRepository } from "@/utils/db/repositories/ConfigRepository";
import { llmModelRepo } from "@/utils/db/repositories/LlmModelRepository";
import { log } from "@/utils/misc/logger";
import { readImageEndpointSupports } from "@/utils/provider/customImageEndpointSupport";
import { resolveCustomEndpointForProvider } from "@/utils/provider/customEndpointService";
import { isCustomProvider } from "@/utils/provider/customProviderUtils";
import { resolveProviderFeatureImplementation } from "@/utils/provider/providerInfoRegistry";

export interface ImageToolCapabilities {
  textToImage: boolean;
  imageToImage: boolean;
  inpaint: boolean;
  outpaint: boolean;
  negativePrompt: boolean;
  sourceLabel: string;
}

const TEXT_ONLY_IMAGE_CAPABILITIES: Omit<ImageToolCapabilities, "sourceLabel"> = {
  textToImage: true,
  imageToImage: false,
  inpaint: false,
  outpaint: false,
  negativePrompt: false,
};

const REFERENCE_IMAGE_CAPABILITIES: Omit<ImageToolCapabilities, "sourceLabel"> = {
  textToImage: true,
  imageToImage: true,
  inpaint: false,
  outpaint: false,
  negativePrompt: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBooleanField(record: Record<string, unknown>, fieldName: string, fallback: boolean): boolean {
  const value = record[fieldName];
  return typeof value === "boolean" ? value : fallback;
}

function readEndpointImageModeConfig(endpoint: CustomEndpointRow): Record<string, unknown> | null {
  const imageModes = endpoint.extra_config.image_modes;
  if (isRecord(imageModes)) {
    return imageModes;
  }

  const workflowSupports = endpoint.extra_config.workflow_supports;
  return isRecord(workflowSupports) ? workflowSupports : null;
}

function resolveCustomEndpointImageCapabilities(endpoint: CustomEndpointRow): ImageToolCapabilities {
  const imageModeConfig = readEndpointImageModeConfig(endpoint);
  const supports = readImageEndpointSupports(endpoint);
  const sourceLabel = endpoint.model_name?.trim() || endpoint.label;

  if (endpoint.api_style === "comfyui") {
    return {
      textToImage: supports.txt2img,
      imageToImage: supports.img2img,
      inpaint: supports.inpaint,
      outpaint: imageModeConfig ? readBooleanField(imageModeConfig, "outpaint", supports.inpaint) : supports.inpaint,
      negativePrompt: supports.negative_prompt,
      sourceLabel,
    };
  }

  if (imageModeConfig) {
    const inpaint = readBooleanField(imageModeConfig, "inpaint", false);
    return {
      textToImage: supports.txt2img,
      imageToImage: supports.img2img,
      inpaint,
      outpaint: readBooleanField(imageModeConfig, "outpaint", false),
      negativePrompt: supports.negative_prompt,
      sourceLabel,
    };
  }

  return {
    ...TEXT_ONLY_IMAGE_CAPABILITIES,
    negativePrompt: supports.negative_prompt,
    sourceLabel,
  };
}

function resolveStaticProviderImageCapabilities(provider: string): ImageToolCapabilities | null {
  const normalizedProvider = provider.trim().toLowerCase();

  if (
    normalizedProvider === "google" ||
    normalizedProvider === "openrouter" ||
    normalizedProvider === "vertex" ||
    normalizedProvider === "vertexexpress"
  ) {
    return {
      ...REFERENCE_IMAGE_CAPABILITIES,
      sourceLabel: provider,
    };
  }

  const implementation = resolveProviderFeatureImplementation(normalizedProvider, "imageGeneration");
  if (implementation === "zai" || implementation === "nvidia") {
    return {
      ...TEXT_ONLY_IMAGE_CAPABILITIES,
      sourceLabel: provider,
    };
  }

  if (implementation === "google" || implementation === "openrouter") {
    return {
      ...REFERENCE_IMAGE_CAPABILITIES,
      sourceLabel: provider,
    };
  }

  return null;
}

async function resolveConfiguredDiffusionModelId(state: ToolAssemblyState): Promise<number | null> {
  if (state.diffusion_model_id != null) {
    return state.diffusion_model_id;
  }

  const serverId = Number.parseInt(state.server_id, 10);
  if (!Number.isInteger(serverId) || serverId <= 0) {
    return null;
  }

  const modelConfig = await configRepository.getModelConfig(serverId);
  return modelConfig?.diffusion_model_id ?? null;
}

export async function resolveImageToolCapabilities(state: ToolAssemblyState): Promise<ImageToolCapabilities | null> {
  const diffusionModelId = await resolveConfiguredDiffusionModelId(state);
  if (!diffusionModelId) {
    return null;
  }

  const diffusionModel = await llmModelRepo.loadDiffusionModelById(diffusionModelId);
  if (!diffusionModel) {
    return null;
  }

  const provider = diffusionModel.provider.trim().toLowerCase();
  if (isCustomProvider(provider)) {
    const endpoint = await resolveCustomEndpointForProvider(provider, "image", diffusionModelId);
    if (!endpoint) {
      log.warn(`Image tool assembly could not resolve custom endpoint for provider ${provider}`);
      return null;
    }
    return resolveCustomEndpointImageCapabilities(endpoint);
  }

  return resolveStaticProviderImageCapabilities(provider);
}
