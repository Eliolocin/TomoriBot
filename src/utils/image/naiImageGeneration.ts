import JSZip from "jszip";
import type { EffectiveNaiImageParams } from "@/utils/image/naiImageParams";
import { log } from "@/utils/misc/logger";

const NAI_IMAGE_BASE_URL = "https://image.novelai.net";

export const NAI_DEFAULT_NEGATIVE_PROMPT =
  process.env.NAI_IMAGE_NEGATIVE_PROMPT ||
  "blurry, lowres, upscaled, artistic error, film grain, scan artifacts, bad anatomy, bad hands, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, @_@, mismatched pupils, glowing eyes, negative space, blank page";

function parseCharRefStrength(rawValue: string | undefined, fallback: number): number {
  const parsedValue = Number.parseFloat(rawValue ?? "");
  if (!Number.isFinite(parsedValue) || parsedValue < 0 || parsedValue > 1) {
    return fallback;
  }

  return parsedValue;
}

export const NAI_CHAR_REF_STRENGTH = parseCharRefStrength(process.env.NAI_CHAR_REF_STRENGTH, 0.6);
export const NAI_CHAR_REF_INFO_EXTRACTED = parseCharRefStrength(process.env.NAI_CHAR_REF_INFO_EXTRACTED, 1.0);
const NAI_CHAR_REF_SECONDARY_STRENGTH = parseCharRefStrength(process.env.NAI_CHAR_REF_SECONDARY_STRENGTH, 0.0);
const NAI_CHAR_REF_DESCRIPTION = process.env.NAI_CHAR_REF_DESCRIPTION?.trim() || "character&style";

const ORIENTATION_PRESETS: Record<string, { width: number; height: number }> = {
  portrait: { width: 832, height: 1216 },
  landscape: { width: 1216, height: 832 },
  square: { width: 1024, height: 1024 },
};
export type NaiImageErrorKind = "auth" | "quota" | "rate_limit" | "other";

interface NaiCharacterCaption {
  char_caption: string;
  centers: Array<{ x: number; y: number }>;
}

interface NaiCharacterPrompt {
  center: { x: number; y: number };
  enabled: true;
  prompt: string;
  uc: string;
}

export interface NaiGenerationCharacterPayload {
  useCoords?: boolean;
  charCaptions?: NaiCharacterCaption[];
  negativeCharCaptions?: NaiCharacterCaption[];
  characterPrompts?: NaiCharacterPrompt[];
  referenceImages?: string[];
  referenceStrengths?: number[];
  referenceInfoExtracted?: number[];
}

/** Whether a model uses NovelAI's V4+ structured prompt schema. */
export function usesNaiStructuredPromptFormat(model: string): boolean {
  // V5 retains the V4 structured prompt schema (v4_prompt/v4_negative_prompt).
  return /nai-diffusion-[45]/.test(model);
}

export function classifyNaiImageError(error: unknown): NaiImageErrorKind {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const normalizedErrorMessage = errorMessage.toLowerCase();

  if (
    /\b402\b/.test(errorMessage) ||
    normalizedErrorMessage.includes("payment required") ||
    normalizedErrorMessage.includes("anlas") ||
    normalizedErrorMessage.includes("credit") ||
    normalizedErrorMessage.includes("credits") ||
    normalizedErrorMessage.includes("generation quota")
  ) {
    return "quota";
  }

  if (
    /\b401\b/.test(errorMessage) ||
    /\b403\b/.test(errorMessage) ||
    normalizedErrorMessage.includes("unauthorized") ||
    normalizedErrorMessage.includes("forbidden") ||
    normalizedErrorMessage.includes("invalid api key")
  ) {
    return "auth";
  }

  if (
    /\b429\b/.test(errorMessage) ||
    normalizedErrorMessage.includes("rate limit") ||
    normalizedErrorMessage.includes("too many requests")
  ) {
    return "rate_limit";
  }

  return "other";
}

async function extractPngFromZipResponse(response: Response): Promise<Buffer> {
  const zipBuffer = Buffer.from(await response.arrayBuffer());
  const zip = await JSZip.loadAsync(zipBuffer);
  const pngFileName = Object.keys(zip.files).find((name) => name.toLowerCase().endsWith(".png"));

  if (!pngFileName) {
    throw new Error("NovelAI response ZIP did not contain a PNG file");
  }

  const pngData = await zip.files[pngFileName].async("nodebuffer");
  return Buffer.from(pngData);
}

export async function generateNovelAiImage(options: {
  apiKey: string;
  model: string;
  prompt: string;
  negativePrompt: string;
  orientation: string;
  imageParams: EffectiveNaiImageParams;
  characterPayload?: NaiGenerationCharacterPayload;
  abortSignal?: AbortSignal;
}): Promise<Buffer> {
  const { apiKey, model, prompt, negativePrompt, orientation, imageParams, characterPayload, abortSignal } = options;

  const dimensions = ORIENTATION_PRESETS[orientation] || ORIENTATION_PRESETS.portrait;
  const seed = Math.floor(Math.random() * 2147483647);
  const charCaptions = characterPayload?.charCaptions ?? [];
  const negativeCharCaptions = characterPayload?.negativeCharCaptions ?? [];
  const characterPrompts = characterPayload?.characterPrompts ?? [];
  const referenceImages = characterPayload?.referenceImages ?? [];
  const referenceStrengths = characterPayload?.referenceStrengths ?? [];
  const referenceInfoExtracted = characterPayload?.referenceInfoExtracted ?? [];
  const useCoords = characterPayload?.useCoords ?? false;

  let requestPayload: Record<string, unknown>;

  if (usesNaiStructuredPromptFormat(model)) {
    const buildDirectorReferenceDescriptions = (count: number) =>
      Array.from({ length: count }, () => ({
        caption: {
          base_caption: NAI_CHAR_REF_DESCRIPTION,
          char_captions: [],
        },
        legacy_uc: false,
      }));
    const buildDirectorReferenceSecondaryStrengths = (count: number) =>
      Array.from({ length: count }, () => NAI_CHAR_REF_SECONDARY_STRENGTH);
    const buildV4RequestPayload = (includeReferences: boolean): Record<string, unknown> => {
      const refsForRequest = includeReferences ? referenceImages : [];
      const directorRefCount = refsForRequest.length;
      const refStrengthsForRequest = includeReferences ? referenceStrengths : [];
      const refInfoForRequest = includeReferences ? referenceInfoExtracted : [];

      return {
        action: "generate",
        input: prompt,
        model,
        parameters: {
          prompt,
          negative_prompt: negativePrompt,
          seed,
          n_samples: 1,
          steps: imageParams.steps,
          height: dimensions.height,
          width: dimensions.width,
          scale: imageParams.scale,
          uncond_scale: 0.0,
          cfg_rescale: imageParams.cfgRescale,
          sampler: imageParams.sampler,
          noise_schedule: imageParams.noiseSchedule,
          legacy_v3_extend: false,
          characterPrompts: characterPrompts.length > 0 ? characterPrompts : undefined,
          use_coords: useCoords,
          legacy_uc: false,
          normalize_reference_strength_multiple: directorRefCount > 0 ? true : undefined,
          director_reference_descriptions:
            directorRefCount > 0 ? buildDirectorReferenceDescriptions(directorRefCount) : undefined,
          director_reference_information_extracted: refInfoForRequest.length > 0 ? refInfoForRequest : undefined,
          director_reference_strength_values: refStrengthsForRequest.length > 0 ? refStrengthsForRequest : undefined,
          director_reference_secondary_strength_values:
            directorRefCount > 0 ? buildDirectorReferenceSecondaryStrengths(directorRefCount) : undefined,
          director_reference_images: refsForRequest.length > 0 ? refsForRequest : undefined,
          v4_prompt: {
            caption: {
              base_caption: prompt,
              char_captions: charCaptions,
            },
            use_coords: useCoords,
            use_order: true,
            legacy_uc: false,
          },
          v4_negative_prompt: {
            caption: {
              base_caption: negativePrompt,
              char_captions:
                negativeCharCaptions.length > 0
                  ? negativeCharCaptions
                  : charCaptions.map((charCaption) => ({
                      char_caption: "",
                      centers: charCaption.centers,
                    })),
            },
            legacy_uc: false,
          },
          controlnet_strength: 1.0,
          controlnet_model: null,
          dynamic_thresholding: false,
          dynamic_thresholding_percentile: 0.999,
          dynamic_thresholding_mimic_scale: 10.0,
          sm: false,
          sm_dyn: false,
          skip_cfg_above_sigma: null,
          skip_cfg_below_sigma: 0.0,
          lora_unet_weights: null,
          lora_clip_weights: null,
          deliberate_euler_ancestral_bug: false,
          prefer_brownian: true,
          cfg_sched_eligibility: "enable_for_post_summer_samplers",
          explike_fine_detail: false,
          minimize_sigma_inf: false,
          uncond_per_vibe: true,
          wonky_vibe_correlation: true,
          version: 1,
          request_type: "PromptGenerateRequest",
        },
      };
    };

    const attempts: Array<{
      label: string;
      includeReferences: boolean;
    }> = [];
    const seenAttempts = new Set<string>();
    const pushAttempt = (label: string, includeReferences: boolean) => {
      const key = includeReferences.toString();
      if (seenAttempts.has(key)) {
        return;
      }

      seenAttempts.add(key);
      attempts.push({
        label,
        includeReferences,
      });
    };

    if (referenceImages.length > 0) {
      pushAttempt("director_refs", true);
    }
    pushAttempt("without_refs", false);

    let lastError: Error | null = null;

    for (const [attemptIndex, attempt] of attempts.entries()) {
      requestPayload = buildV4RequestPayload(attempt.includeReferences);

      log.info(
        `[NAI] V4 generate attempt "${attempt.label}" (chars: ${charCaptions.length}, coords: ${useCoords}, refs: ${attempt.includeReferences ? referenceImages.length : 0})`,
      );

      const response = await fetch(`${NAI_IMAGE_BASE_URL}/ai/generate-image`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestPayload),
        signal: abortSignal,
      });

      if (response.ok) {
        return await extractPngFromZipResponse(response);
      }

      const correlationId = response.headers.get("x-correlation-id");
      const errorText = await response.text().catch(() => "");
      const snippet = errorText.slice(0, 500);
      lastError = new Error(
        `NovelAI image generation failed (${response.status} ${response.statusText})${correlationId ? ` [correlation-id: ${correlationId}]` : ""}: ${snippet}`,
      );

      const hasFallbackAttempt = attemptIndex < attempts.length - 1;
      if (hasFallbackAttempt && attempt.includeReferences) {
        log.warn(
          `[NAI] V4 generate attempt "${attempt.label}" failed with ${response.status}. Retrying with "${attempts[attemptIndex + 1].label}"`,
        );
        continue;
      }

      throw lastError;
    }

    throw lastError ?? new Error("NovelAI image generation failed");
  }

  requestPayload = {
    action: "generate",
    input: prompt,
    model,
    parameters: {
      width: dimensions.width,
      height: dimensions.height,
      steps: imageParams.steps,
      scale: imageParams.scale,
      sampler: imageParams.sampler,
      noise_schedule: imageParams.noiseSchedule,
      n_samples: 1,
      seed,
      negative_prompt: negativePrompt,
    },
  };

  log.info(`[NAI] Generating image with model "${model}" (${dimensions.width}x${dimensions.height}, seed: ${seed})`);

  const response = await fetch(`${NAI_IMAGE_BASE_URL}/ai/generate-image`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestPayload),
    signal: abortSignal,
  });

  if (!response.ok) {
    const correlationId = response.headers.get("x-correlation-id");
    const errorText = await response.text().catch(() => "");
    const snippet = errorText.slice(0, 500);
    throw new Error(
      `NovelAI image generation failed (${response.status} ${response.statusText})${correlationId ? ` [correlation-id: ${correlationId}]` : ""}: ${snippet}`,
    );
  }

  return await extractPngFromZipResponse(response);
}
