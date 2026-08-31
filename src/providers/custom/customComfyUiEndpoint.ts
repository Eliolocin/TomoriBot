import type { CustomEndpointRow } from "@/types/db/schema";
import type {
  ProviderNativeImageGenerationRequest,
  ProviderNativeImageGenerationResult,
  ProviderNativeVideoGenerationRequest,
  ProviderNativeVideoGenerationResult,
} from "@/types/provider/featureInterfaces";
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import {
  DEFAULT_COMFYUI_REFERENCE_DENOISE,
  createComfyUiClothingSegmentSelection,
  inferComfyUiForegroundMaskPrompt,
  inferComfyUiInpaintPreset,
  isComfyUiHairMaskPrompt,
  normalizeComfyUiInpaintMode,
  normalizeComfyUiMaskMode,
  resolveComfyUiClothingSegmentCategories,
  resolveComfyUiEffectiveInpaintSettings,
  resolveComfyUiInpaintMaskContent,
  resolveComfyUiInpaintSettings,
  resolveComfyUiMaskProtectionSettings,
  resolveComfyUiWorkflowMaskPrompt,
  shouldUseComfyUiClothingParser,
  shouldUseComfyUiClothingParserHairTarget,
  shouldUseComfyUiClothingParserProtection,
  shouldUseComfyUiClothingParserTarget,
  shouldUseComfyUiDifferentialDiffusion,
  shouldUseComfyUiRmbgBackgroundMask,
  strengthenComfyUiHairRecolorPrompt,
  stripComfyUiHairRecolorPreservationClauses,
  stripComfyUiNegativeInpaintClauses,
} from "@/providers/custom/customComfyUiInpainting";
import {
  COMFYUI_INPAINT_MASK_FILENAME_PREFIX,
  COMFYUI_INPAINT_RESULT_DEBUG_FILENAME_PREFIX,
  describeComfyUiAssets,
  formatComfyUiDiagnosticSection,
  getComfyUiDiagnosticLabel,
  isComfyUiDiagnosticAsset,
  isComfyUiDiagnosticSaveImageNode,
} from "@/providers/custom/customImageDiagnostics";
import { buildCustomHeaders } from "@/providers/custom/customOpenAICompatibleUtils";
import { log } from "@/utils/misc/logger";
import { fetchUserRemoteUrl } from "@/utils/security/userRemoteFetch";
import { safeDownload } from "@/utils/security/safeDownload";

type ComfyUiGenerationMode = "image" | "video";
type ComfyUiOutpaintStrategy = "edge_extend" | "zoom_out" | "full_canvas";
type ComfyUiOutpaintAmount = "slight" | "moderate" | "large" | "dramatic";

interface ComfyUiReferenceImage {
  mimeType: string;
  data: string;
  url?: string;
  fallbackUrl?: string;
  width?: number;
  height?: number;
  comfyUiFilename?: string;
  comfyUiSubfolder?: string;
  comfyUiType?: string;
}

interface ComfyUiGenerationOptions {
  mode: ComfyUiGenerationMode;
  prompt: string;
  negativePrompt?: string | null;
  aspectRatio?: string;
  durationSeconds?: number;
  fps?: number;
  resolution?: string;
  generateAudio?: boolean;
  audioPrompt?: string;
  loop?: boolean;
  referenceImages?: ComfyUiReferenceImage[];
  referenceImageDataUrl?: string | null;
  inpaint?: boolean;
  maskPrompt?: string | null;
  maskThreshold?: number | null;
  maskGrow?: number | null;
  maskFeather?: number | null;
  cfg?: number | null;
  denoise?: number | null;
  referenceDenoise?: number | null;
  seed?: number | null;
  inpaintMaskMode?: string | null;
  inpaintMode?: string | null;
  inpaintPreset?: string | null;
  outpaint?: boolean | null;
  outpaintStrategy?: string | null;
  outpaintAmount?: string | null;
  outpaintOverlap?: number | null;
  outpaintZoomScale?: number | null;
  outpaintLeftPrompt?: string | null;
  outpaintRightPrompt?: string | null;
  outpaintTopPrompt?: string | null;
  outpaintBottomPrompt?: string | null;
  inpaintExtendDirection?: string | null;
  inpaintExtendPixels?: number | null;
  inpaintExtendGrow?: number | null;
  inpaintExtendFeather?: number | null;
  inpaintExtendPadding?: number | null;
  clothingMode?: boolean | null;
  clothingSegmentCategories?: string[] | null;
  disableClothingParser?: boolean;
}

type WorkflowPlaceholderValue = string | number | boolean | null | Record<string, unknown> | Array<unknown>;
type ComfyUiWorkflow = Record<string, unknown>;
type ComfyUiAsset = {
  filename: string;
  subfolder?: string;
  type?: string;
  mediaKind?: "image" | "gif" | "video";
};
type ComfyUiMediaKind = NonNullable<ComfyUiAsset["mediaKind"]>;
type ComfyUiGenerationResponse = { files: ComfyUiAsset[]; seed: number };
type ComfyUiWorkflowSupports = {
  txt2img: boolean;
  img2img: boolean;
  inpaint: boolean;
};
type RgbColor = { r: number; g: number; b: number };

const DEFAULT_COMFYUI_WORKFLOW_SUPPORTS: ComfyUiWorkflowSupports = {
  txt2img: true,
  img2img: true,
  inpaint: false,
};

const COMFYUI_IMAGE_TARGET_AREA = (() => {
  const parsed = Number.parseInt(process.env.COMFYUI_IMAGE_TARGET_AREA || "1048576", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1024 * 1024;
})();
const COMFYUI_DIMENSION_MULTIPLE = 64;
const COMFYUI_MAX_RANDOM_SEED = 2 ** 32;
const COMFYUI_OUTPAINT_INACTIVE_EXTEND_FACTOR = 0.01;
const COMFYUI_OUTPAINT_PRESERVE_SUBJECT_ONLY = false;
const COMFYUI_OUTPAINT_SUBJECT_MASK_GROW = 2;
const COMFYUI_OUTPAINT_SUBJECT_MASK_FEATHER = 2;
const COMFYUI_LANPAINT_SUPPORTED_SAMPLERS = new Set([
  "euler",
  "euler_ancestral",
  "heun",
  "heunpp2",
  "dpm_2",
  "dpm_2_ancestral",
  "dpm_fast",
  "dpmpp_sde",
  "dpmpp_sde_gpu",
  "dpmpp_2m",
  "dpmpp_2m_sde",
  "dpmpp_2m_sde_gpu",
  "dpmpp_3m_sde",
  "dpmpp_3m_sde_gpu",
  "ddpm",
  "deis",
  "res_multistep",
  "res_multistep_ancestral",
  "gradient_estimation",
  "er_sde",
  "seeds_2",
  "seeds_3",
]);
const COMFYUI_BASE_NEGATIVE_PROMPT =
  "low quality, worst quality, low detail, bad drawing, bad quality, oldest, (score_3, score_2, score_1:0.25), jpeg artifacts, watermark, signature, artist name, missing head, missing limb, bad anatomy, bad proportions, bad hands, missing fingers, spiral eyes, multiple views, duplicate face, extra face, second character, collage, inset image, tiny subject, distant subject, small subject, excessive empty space, subject too small";
const COMFYUI_DEFAULT_VIDEO_DURATION_SECONDS = 5;
const COMFYUI_DEFAULT_VIDEO_FPS = 16;
const COMFYUI_DEFAULT_VIDEO_PLAYBACK_SPEED_MULTIPLIER = 1.5;
const COMFYUI_REFERENCE_IMAGE_DOWNLOAD_MAX_MB = 25;
const COMFYUI_DEFAULT_VIDEO_STEPS = 4;
const COMFYUI_DEFAULT_VIDEO_CFG = 1;
const COMFYUI_VIDEO_PROMPT_STABILIZER =
  "Preserve the exact character identity, face proportions, eye shape, hairstyle, clothing, composition, and anime art style from the reference image. Use subtle, natural motion only. Keep the face cute and coherent. Hands must remain anatomically correct with five fingers per hand.";
const COMFYUI_VIDEO_NEGATIVE_PROMPT =
  "melted face, distorted face, uncanny face, warped eyes, misaligned eyes, broken mouth, deformed cheeks, excessive face deformation, extra hands, missing hands, malformed hands, extra fingers, missing fingers, fused fingers, broken fingers, dislocated arms, duplicated person, duplicated face, body horror, aggressive squeezing, violent motion, jitter, flicker, morphing identity, changed character, changed hairstyle, changed outfit, low quality, worst quality, blurry, artifacts, watermark, subtitles, text";
const COMFYUI_DEFAULT_VIDEO_AUDIO_STEPS = 25;
const COMFYUI_DEFAULT_VIDEO_AUDIO_CFG = 4.5;
const COMFYUI_VIDEO_AUDIO_PROMPT_STABILIZER =
  "Generate synchronized foley and ambient sound effects that match the visible motion. Keep the audio clean and natural. Do not add speech, vocals, or music unless explicitly requested.";
const COMFYUI_VIDEO_AUDIO_NEGATIVE_PROMPT =
  "low quality, distorted, clipping, harsh noise, static, hiss, crackle, out of sync, loud music, vocals, speech, dialogue, narration";
function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readOptionalNumberEnv(name: string): number | null {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === "") {
    return null;
  }

  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : null;
}

function readOptionalStringEnv(name: string): string | null {
  const rawValue = process.env[name];
  const trimmed = rawValue?.trim();
  return trimmed ? trimmed : null;
}

function toUpperSnakeCase(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function readOptionalBooleanEnv(name: string): boolean | null {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === "") {
    return null;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return null;
}

function shouldUnloadComfyUiModelsAfterSuccessfulGeneration(): boolean {
  return (
    readOptionalBooleanEnv("COMFYUI_UNLOAD_MODELS_AFTER_SUCCESS") ??
    readOptionalBooleanEnv("TOMORI_COMFYUI_UNLOAD_MODELS_AFTER_SUCCESS") ??
    false
  );
}

async function unloadComfyUiModelsAfterSuccessfulGeneration(
  endpoint: CustomEndpointRow,
  apiKey: string,
  mode: ComfyUiGenerationMode,
): Promise<void> {
  if (!shouldUnloadComfyUiModelsAfterSuccessfulGeneration()) {
    return;
  }

  try {
    const response = await fetchUserRemoteUrl(`${endpoint.endpoint_url.replace(/\/+$/, "")}/free`, {
      method: "POST",
      headers: buildCustomHeaders(apiKey),
      body: JSON.stringify({
        unload_models: true,
        free_memory: true,
      }),
    });

    if (!response.ok) {
      log.warn(
        `ComfyUI model unload after successful ${mode} generation failed: ${response.status} ${response.statusText}`,
      );
      return;
    }

    log.info(`ComfyUI models unloaded after successful ${mode} generation.`);
  } catch (error) {
    log.warn(`ComfyUI model unload after successful ${mode} generation failed`, error);
  }
}

function resolveComfyUiRuntimeWorkflowPath(endpoint: CustomEndpointRow): string | null {
  const extraConfigPath =
    isRecord(endpoint.extra_config) && typeof endpoint.extra_config.workflow_path === "string"
      ? endpoint.extra_config.workflow_path.trim()
      : "";
  if (extraConfigPath) {
    return extraConfigPath;
  }

  const labelToken = toUpperSnakeCase(endpoint.label ?? "");
  if (labelToken) {
    const labelScoped =
      readOptionalStringEnv(`COMFYUI_WORKFLOW_JSON_PATH_${labelToken}`) ??
      readOptionalStringEnv(`ANIMA3_COMFYUI_WORKFLOW_JSON_PATH_${labelToken}`);
    if (labelScoped) {
      return labelScoped;
    }
  }

  return (
    readOptionalStringEnv("COMFYUI_WORKFLOW_JSON_PATH") ?? readOptionalStringEnv("ANIMA3_COMFYUI_WORKFLOW_JSON_PATH")
  );
}

function loadComfyUiWorkflowFromPath(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    const raw = readFileSync(path, "utf8");
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Failed to load ComfyUI workflow JSON from "${path}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(`ComfyUI workflow JSON at "${path}" must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function normalizeComfyUiExtendDirection(direction: string | null | undefined): string {
  const normalized = direction?.trim().toLowerCase() || "down";
  return ["down", "up", "left", "right", "down_left", "down_right", "up_left", "up_right", "all"].includes(normalized)
    ? normalized
    : "down";
}

function resolveComfyUiExtendOffset(direction: string, pixels: number): { x: number; y: number } {
  switch (direction) {
    case "up":
      return { x: 0, y: -pixels };
    case "left":
      return { x: -pixels, y: 0 };
    case "right":
      return { x: pixels, y: 0 };
    case "down_left":
      return { x: -pixels, y: pixels };
    case "down_right":
      return { x: pixels, y: pixels };
    case "up_left":
      return { x: -pixels, y: -pixels };
    case "up_right":
      return { x: pixels, y: -pixels };
    case "all":
      return { x: 0, y: 0 };
    default:
      return { x: 0, y: pixels };
  }
}

function isComfyUiOutpaint(options: Pick<ComfyUiGenerationOptions, "inpaintMode" | "outpaint">): boolean {
  return normalizeComfyUiInpaintMode(options) === "outpaint";
}

function normalizeComfyUiOutpaintAmount(value: string | null | undefined): ComfyUiOutpaintAmount | null {
  const normalized =
    value
      ?.trim()
      .toLowerCase()
      .replace(/[-\s]+/g, "_") ?? "";
  if (!normalized) {
    return null;
  }
  if (["slight", "small", "subtle", "little", "a_little", "tiny", "minimal"].includes(normalized)) {
    return "slight";
  }
  if (["moderate", "medium", "normal", "default", "regular"].includes(normalized)) {
    return "moderate";
  }
  if (["large", "wide", "strong", "more"].includes(normalized)) {
    return "large";
  }
  if (["dramatic", "very_large", "huge", "extreme", "maximum", "max"].includes(normalized)) {
    return "dramatic";
  }
  return null;
}

function inferComfyUiOutpaintAmount(prompt: string): ComfyUiOutpaintAmount | null {
  if (
    /\b(?:a little|little bit|slightly|slight|subtle|small amount|tiny bit|just a bit|zoom out a bit)\b/i.test(prompt)
  ) {
    return "slight";
  }
  if (/\b(?:dramatic|huge|extreme|way out|far away|very wide|much wider|zoom way out)\b/i.test(prompt)) {
    return "dramatic";
  }
  if (
    /\b(?:large amount|zoom out more|much more|wider view|wide view|full[-\s]?body|full outfit|whole outfit|entire outfit|entire silhouette|head[-\s]?to[-\s]?toe|legs?|feet|lower body|lower half)\b/i.test(
      prompt,
    )
  ) {
    return "large";
  }
  return null;
}

function resolveComfyUiOutpaintAmount(options: ComfyUiGenerationOptions): ComfyUiOutpaintAmount {
  return (
    normalizeComfyUiOutpaintAmount(options.outpaintAmount) ?? inferComfyUiOutpaintAmount(options.prompt) ?? "moderate"
  );
}

function getComfyUiOutpaintAmountDefaults(amount: ComfyUiOutpaintAmount): {
  pixels: number;
  zoomScaleAll: number;
  zoomScaleOneSide: number;
} {
  switch (amount) {
    case "slight":
      return { pixels: 224, zoomScaleAll: 0.78, zoomScaleOneSide: 0.84 };
    case "large":
      return { pixels: 512, zoomScaleAll: 0.56, zoomScaleOneSide: 0.7 };
    case "dramatic":
      return { pixels: 704, zoomScaleAll: 0.5, zoomScaleOneSide: 0.62 };
    default:
      return { pixels: 352, zoomScaleAll: 0.66, zoomScaleOneSide: 0.76 };
  }
}

function resolveComfyUiOutpaintPixels(options: ComfyUiGenerationOptions): number {
  const amountDefaults = getComfyUiOutpaintAmountDefaults(resolveComfyUiOutpaintAmount(options));
  return clampNumber(options.inpaintExtendPixels ?? amountDefaults.pixels, 0, 1024);
}

function normalizeComfyUiOutpaintStrategy(value: string | null | undefined): ComfyUiOutpaintStrategy | null {
  const normalized =
    value
      ?.trim()
      .toLowerCase()
      .replace(/[-\s]+/g, "_") ?? "";
  if (!normalized) {
    return null;
  }
  if (["full_canvas", "canvas", "canvas_inpaint", "novelai", "novelai_style"].includes(normalized)) {
    return "full_canvas";
  }
  if (["zoom_out", "zoomout", "pull_back", "shrink", "reframe"].includes(normalized)) {
    return "zoom_out";
  }
  if (["edge_extend", "extend_edges", "pad", "padding", "crop_stitch", "crop_and_stitch"].includes(normalized)) {
    return "edge_extend";
  }
  return null;
}

function isComfyUiZoomOutPrompt(prompt: string): boolean {
  return /\b(?:zoom out|pull back|wider shot|wide shot|wide[-\s]?angle(?: shot)?|wide framing|wider view|wide view|more distant shot|full[-\s]?body|full outfit|whole outfit|entire outfit|entire silhouette)\b/i.test(
    prompt,
  );
}

function resolveComfyUiOutpaintStrategy(options: ComfyUiGenerationOptions): ComfyUiOutpaintStrategy {
  const explicitStrategy = normalizeComfyUiOutpaintStrategy(options.outpaintStrategy);
  if (explicitStrategy) {
    // The current Anima workflow exposes LanPaint full-canvas stages for every
    // direction. Keep accepting older strategy names from the tool API, but route
    // them through the maintained branch instead of the old CropAndStitch path.
    return explicitStrategy === "edge_extend" || explicitStrategy === "zoom_out" ? "full_canvas" : explicitStrategy;
  }

  return "full_canvas";
}

function resolveComfyUiOutpaintOverlap(options: ComfyUiGenerationOptions): number {
  return clampNumber(options.outpaintOverlap ?? 16, 0, 256);
}

function resolveComfyUiOutpaintPadFeather(): number {
  return 0;
}

function resolveComfyUiOutpaintBlendFeather(): number {
  return 12;
}

function resolveComfyUiOutpaintCenterPreserveFeather(): number {
  return 10;
}

function resolveComfyUiOutpaintGuideBlurRadius(): number {
  return 24;
}

function resolveComfyUiOutpaintGuideBlurSigma(): number {
  return 6;
}

function resolveComfyUiOutpaintDenoise(): number {
  return 0.9;
}

function resolveComfyUiOutpaintCfg(): number {
  return clampNumber(
    readOptionalNumberEnv("COMFYUI_OUTPAINT_CFG") ?? readOptionalNumberEnv("ANIMA3_OUTPAINT_CFG") ?? 3,
    1,
    30,
  );
}

function resolveComfyUiOutpaintSteps(): number {
  return Math.round(
    clampNumber(
      readOptionalNumberEnv("COMFYUI_OUTPAINT_STEPS") ??
        readOptionalNumberEnv("ANIMA3_OUTPAINT_STEPS") ??
        readOptionalNumberEnv("COMFYUI_LANPAINT_STEPS") ??
        readOptionalNumberEnv("ANIMA3_LANPAINT_STEPS") ??
        20,
      1,
      10000,
    ),
  );
}

function resolveComfyUiOutpaintThinkingSteps(): number {
  return Math.round(
    clampNumber(
      readOptionalNumberEnv("COMFYUI_OUTPAINT_THINKING_STEPS") ??
        readOptionalNumberEnv("ANIMA3_OUTPAINT_THINKING_STEPS") ??
        readOptionalNumberEnv("COMFYUI_OUTPAINT_LANPAINT_NUM_STEPS") ??
        readOptionalNumberEnv("ANIMA3_OUTPAINT_LANPAINT_NUM_STEPS") ??
        readOptionalNumberEnv("COMFYUI_LANPAINT_NUM_STEPS") ??
        readOptionalNumberEnv("ANIMA3_LANPAINT_NUM_STEPS") ??
        2,
      0,
      100,
    ),
  );
}

function resolveComfyUiLanPaintSteps(): number {
  return Math.round(
    clampNumber(
      readOptionalNumberEnv("COMFYUI_LANPAINT_STEPS") ?? readOptionalNumberEnv("ANIMA3_LANPAINT_STEPS") ?? 16,
      1,
      10000,
    ),
  );
}

function resolveComfyUiLanPaintNumSteps(): number {
  return Math.round(
    clampNumber(
      readOptionalNumberEnv("COMFYUI_LANPAINT_NUM_STEPS") ?? readOptionalNumberEnv("ANIMA3_LANPAINT_NUM_STEPS") ?? 3,
      0,
      100,
    ),
  );
}

function normalizeComfyUiLanPaintSampler(sampler: string, fallback: string): string {
  return COMFYUI_LANPAINT_SUPPORTED_SAMPLERS.has(sampler) ? sampler : fallback;
}

function resolveComfyUiLanPaintSampler(): string {
  const sampler =
    readOptionalStringEnv("COMFYUI_LANPAINT_SAMPLER") ?? readOptionalStringEnv("ANIMA3_LANPAINT_SAMPLER") ?? "er_sde";
  return normalizeComfyUiLanPaintSampler(sampler, "er_sde");
}

function resolveComfyUiOutpaintSampler(): string {
  const sampler =
    readOptionalStringEnv("COMFYUI_OUTPAINT_SAMPLER") ??
    readOptionalStringEnv("ANIMA3_OUTPAINT_SAMPLER") ??
    readOptionalStringEnv("COMFYUI_LANPAINT_SAMPLER") ??
    readOptionalStringEnv("ANIMA3_LANPAINT_SAMPLER") ??
    "euler";
  return normalizeComfyUiLanPaintSampler(sampler, "euler");
}

function resolveComfyUiLanPaintPromptMode(): "Image First" | "Prompt First" {
  return "Image First";
}

function resolveComfyUiLanPaintMaskBlendOverlap(): number {
  return 9;
}

function resolveComfyUiFlorence2Model(): string {
  return "microsoft/Florence-2-large-ft";
}

function resolveComfyUiFlorence2Precision(): "fp16" | "bf16" | "fp32" {
  return "fp16";
}

function resolveComfyUiFlorence2Attention(): "flash_attention_2" | "sdpa" | "eager" {
  return "sdpa";
}

function shouldKeepComfyUiFlorence2ModelLoaded(): boolean {
  return false;
}

function resolveComfyUiOutpaintUnderpaintColor(): number {
  return 8421504;
}

function resolveComfyUiOutpaintZoomScale(options: ComfyUiGenerationOptions, direction: string): number {
  const amountDefaults = getComfyUiOutpaintAmountDefaults(resolveComfyUiOutpaintAmount(options));
  const defaultScale = direction === "all" ? amountDefaults.zoomScaleAll : amountDefaults.zoomScaleOneSide;
  return clampNumber(options.outpaintZoomScale ?? defaultScale, 0.5, 0.95);
}

function shouldScaleComfyUiOutpaintSource(
  options: ComfyUiGenerationOptions,
  strategy: ComfyUiOutpaintStrategy,
  direction: string,
): boolean {
  if (strategy === "zoom_out") {
    return true;
  }
  if (strategy !== "full_canvas") {
    return false;
  }
  if (options.outpaintZoomScale !== null && options.outpaintZoomScale !== undefined) {
    return true;
  }
  const explicitStrategy = normalizeComfyUiOutpaintStrategy(options.outpaintStrategy);
  if (explicitStrategy === "zoom_out") {
    return true;
  }
  return normalizeComfyUiExtendDirection(direction) === "all" && isComfyUiZoomOutPrompt(options.prompt);
}

function getComfyUiDirectionalOutpaintFactors(direction: string): {
  up: number;
  down: number;
  left: number;
  right: number;
} {
  return {
    up: direction === "up" || direction === "up_left" || direction === "up_right" || direction === "all" ? 1 : 0,
    down:
      direction === "down" || direction === "down_left" || direction === "down_right" || direction === "all" ? 1 : 0,
    left: direction === "left" || direction === "down_left" || direction === "up_left" || direction === "all" ? 1 : 0,
    right:
      direction === "right" || direction === "down_right" || direction === "up_right" || direction === "all" ? 1 : 0,
  };
}

function getComfyUiWorkflowOutpaintFactors(
  direction: string,
  outpaint: boolean,
): {
  up: number;
  down: number;
  left: number;
  right: number;
} {
  const factors = getComfyUiDirectionalOutpaintFactors(direction);
  return {
    up: outpaint && factors.up > 0 ? factors.up : COMFYUI_OUTPAINT_INACTIVE_EXTEND_FACTOR,
    down: outpaint && factors.down > 0 ? factors.down : COMFYUI_OUTPAINT_INACTIVE_EXTEND_FACTOR,
    left: outpaint && factors.left > 0 ? factors.left : COMFYUI_OUTPAINT_INACTIVE_EXTEND_FACTOR,
    right: outpaint && factors.right > 0 ? factors.right : COMFYUI_OUTPAINT_INACTIVE_EXTEND_FACTOR,
  };
}

function getComfyUiLayoutOutpaintFactors(
  layout: ComfyUiOutpaintLayout | null,
  outputDimensions: { width: number; height: number },
  fallbackDirection: string,
  outpaint: boolean,
  outpaintPixels: number,
): {
  up: number;
  down: number;
  left: number;
  right: number;
} {
  if (!layout || layout.sourceScale >= 1 || !outpaint || outpaintPixels <= 0) {
    return getComfyUiWorkflowOutpaintFactors(fallbackDirection, outpaint);
  }

  const leftPad = layout.placedSourceX;
  const topPad = layout.placedSourceY;
  const rightPad = outputDimensions.width - layout.placedSourceX - layout.placedSourceWidth;
  const bottomPad = outputDimensions.height - layout.placedSourceY - layout.placedSourceHeight;
  const toFactor = (pixels: number): number =>
    pixels > 0
      ? Math.max(COMFYUI_OUTPAINT_INACTIVE_EXTEND_FACTOR, pixels / outpaintPixels)
      : COMFYUI_OUTPAINT_INACTIVE_EXTEND_FACTOR;

  return {
    up: toFactor(topPad),
    down: toFactor(bottomPad),
    left: toFactor(leftPad),
    right: toFactor(rightPad),
  };
}

function buildComfyUiOutpaintDimensions(
  options: ComfyUiGenerationOptions,
  sourceDimensions: { width: number; height: number },
  direction: string,
  pixels: number,
): { width: number; height: number } {
  const strategy = resolveComfyUiOutpaintStrategy(options);
  const factors = getComfyUiDirectionalOutpaintFactors(direction);
  if (shouldScaleComfyUiOutpaintSource(options, strategy, direction)) {
    const sourceScale = resolveComfyUiOutpaintZoomScale(options, direction);
    return {
      width:
        factors.left > 0 || factors.right > 0
          ? roundToNearestMultiple(sourceDimensions.width / sourceScale, COMFYUI_DIMENSION_MULTIPLE)
          : sourceDimensions.width,
      height:
        factors.up > 0 || factors.down > 0
          ? roundToNearestMultiple(sourceDimensions.height / sourceScale, COMFYUI_DIMENSION_MULTIPLE)
          : sourceDimensions.height,
    };
  }
  return {
    width: roundToNearestMultiple(
      sourceDimensions.width + pixels * factors.left + pixels * factors.right,
      COMFYUI_DIMENSION_MULTIPLE,
    ),
    height: roundToNearestMultiple(
      sourceDimensions.height + pixels * factors.up + pixels * factors.down,
      COMFYUI_DIMENSION_MULTIPLE,
    ),
  };
}

type ComfyUiOutpaintLayout = {
  strategy: ComfyUiOutpaintStrategy;
  sourceScale: number;
  overlap: number;
  placedSourceX: number;
  placedSourceY: number;
  placedSourceWidth: number;
  placedSourceHeight: number;
  maskSourceX: number;
  maskSourceY: number;
  maskSourceWidth: number;
  maskSourceHeight: number;
};

function resolveComfyUiOutpaintAxisPlacement(
  outputSize: number,
  placedSize: number,
  extendStart: boolean,
  extendEnd: boolean,
): number {
  if (extendStart && !extendEnd) {
    return outputSize - placedSize;
  }
  if (extendEnd && !extendStart) {
    return 0;
  }
  return Math.max(0, Math.floor((outputSize - placedSize) / 2));
}

function buildComfyUiOutpaintLayout(
  options: ComfyUiGenerationOptions,
  sourceDimensions: { width: number; height: number },
  outputDimensions: { width: number; height: number },
  direction: string,
): ComfyUiOutpaintLayout {
  const strategy = resolveComfyUiOutpaintStrategy(options);
  const factors = getComfyUiDirectionalOutpaintFactors(direction);
  const scaleSource = shouldScaleComfyUiOutpaintSource(options, strategy, direction);
  const sourceScale = scaleSource ? resolveComfyUiOutpaintZoomScale(options, direction) : 1;
  const placedSourceWidth = sourceDimensions.width;
  const placedSourceHeight = sourceDimensions.height;
  const placedSourceX = scaleSource
    ? resolveComfyUiOutpaintAxisPlacement(
        outputDimensions.width,
        placedSourceWidth,
        factors.left > 0,
        factors.right > 0,
      )
    : factors.left > 0
      ? Math.max(
          0,
          outputDimensions.width - sourceDimensions.width - factors.right * resolveComfyUiOutpaintPixels(options),
        )
      : 0;
  const placedSourceY = scaleSource
    ? resolveComfyUiOutpaintAxisPlacement(outputDimensions.height, placedSourceHeight, factors.up > 0, factors.down > 0)
    : factors.up > 0
      ? Math.max(
          0,
          outputDimensions.height - sourceDimensions.height - factors.down * resolveComfyUiOutpaintPixels(options),
        )
      : 0;
  const rawOverlap = resolveComfyUiOutpaintOverlap(options);
  const zoomOutOverlapCap = 48;
  const overlap = Math.min(rawOverlap, Math.floor(Math.min(placedSourceWidth, placedSourceHeight) / 3));
  const effectiveOverlap = scaleSource ? Math.min(overlap, zoomOutOverlapCap) : overlap;
  const leftPad = placedSourceX;
  const topPad = placedSourceY;
  const rightPad = outputDimensions.width - placedSourceX - placedSourceWidth;
  const bottomPad = outputDimensions.height - placedSourceY - placedSourceHeight;
  const maskInsetLeft = leftPad > 0 ? effectiveOverlap : 0;
  const maskInsetTop = topPad > 0 ? effectiveOverlap : 0;
  const maskInsetRight = rightPad > 0 ? effectiveOverlap : 0;
  const maskInsetBottom = bottomPad > 0 ? effectiveOverlap : 0;
  const maskSourceX = placedSourceX + maskInsetLeft;
  const maskSourceY = placedSourceY + maskInsetTop;
  const maskSourceWidth = Math.max(1, placedSourceWidth - maskInsetLeft - maskInsetRight);
  const maskSourceHeight = Math.max(1, placedSourceHeight - maskInsetTop - maskInsetBottom);

  return {
    strategy,
    sourceScale,
    overlap: effectiveOverlap,
    placedSourceX,
    placedSourceY,
    placedSourceWidth,
    placedSourceHeight,
    maskSourceX,
    maskSourceY,
    maskSourceWidth,
    maskSourceHeight,
  };
}

function buildComfyUiOutpaintDirectionPrompt(direction: string, scaleSource = false): string[] {
  const normalizedDirection = normalizeComfyUiExtendDirection(direction);
  if (normalizedDirection.startsWith("down")) {
    return [
      "new canvas is below the original bottom edge",
      "continue bottom-edge content downward",
      "extend cropped lower-body, clothing, floor, or ground only when visible at the edge",
    ];
  }
  if (normalizedDirection.startsWith("up")) {
    return [
      "new canvas is above the original top edge",
      "continue top-edge sky, ceiling, hair, fabric, or headroom upward",
    ];
  }
  if (normalizedDirection === "left" || normalizedDirection === "right") {
    return [`new canvas is on the ${normalizedDirection} edge`, `continue ${normalizedDirection}-edge content outward`];
  }
  return [
    scaleSource
      ? "treat all-direction zoom-out as a wider view around the source image"
      : "treat all-direction outpaint as edge continuation, not a redraw",
    "continue each original edge outward from edge-touching content",
  ];
}

function resolveComfyUiOutpaintStageFeather(largestOutpaintPad: number): number {
  if (largestOutpaintPad <= 0) {
    return 0;
  }
  return Math.min(64, largestOutpaintPad);
}

function normalizeComfyUiOutpaintStagePrompt(prompt: string | null | undefined): string | null {
  const trimmed = prompt?.trim();
  return trimmed ? trimmed : null;
}

function resolveComfyUiOutpaintStagePrompt(
  options: ComfyUiGenerationOptions,
  direction: "horizontal" | "top" | "bottom",
): string {
  const normalizedDirection = normalizeComfyUiExtendDirection(options.inpaintExtendDirection);
  const factors = getComfyUiDirectionalOutpaintFactors(normalizedDirection);
  const basePrompt = options.prompt.trim();

  if (direction === "top") {
    return normalizeComfyUiOutpaintStagePrompt(options.outpaintTopPrompt) ?? basePrompt;
  }

  if (direction === "bottom") {
    return normalizeComfyUiOutpaintStagePrompt(options.outpaintBottomPrompt) ?? basePrompt;
  }

  const leftPrompt = normalizeComfyUiOutpaintStagePrompt(options.outpaintLeftPrompt);
  const rightPrompt = normalizeComfyUiOutpaintStagePrompt(options.outpaintRightPrompt);
  // The workflow has one horizontal LanPaint stage, so left/right guidance is
  // collapsed only when both sides are active.
  if (factors.left > 0 && factors.right > 0 && leftPrompt && rightPrompt && leftPrompt !== rightPrompt) {
    return `left side: ${leftPrompt}; right side: ${rightPrompt}`;
  }
  if (factors.left > 0 && leftPrompt) {
    return leftPrompt;
  }
  if (factors.right > 0 && rightPrompt) {
    return rightPrompt;
  }
  return leftPrompt ?? rightPrompt ?? basePrompt;
}

function buildComfyUiOutpaintStagePositivePrompt(
  options: ComfyUiGenerationOptions,
  direction: "horizontal" | "top" | "bottom",
): string {
  const stagePrompt = resolveComfyUiOutpaintStagePrompt(options, direction);
  // Directional LanPaint stages get their own prompt. Keep this compact so the
  // user prompt and optional edge prompt stay more important than our guardrails.
  const shared = [
    stagePrompt,
    "continue visible edge content into the new canvas",
    "match color, lighting, perspective, texture, and anime style",
    "one continuous scene",
  ];

  if (direction === "horizontal") {
    shared.push(
      "extend horizontally from left and right edges",
      "continue edge-touching background, atmosphere, open space, structures, hair, fabric, and details",
    );
  } else if (direction === "top") {
    shared.push(
      "extend upward from the top edge",
      "continue edge-touching sky, lighting, architecture, hair, fabric, atmosphere, and headroom",
    );
  } else {
    shared.push(
      "extend downward from the bottom edge",
      "continue edge-touching ground, floor, lower environment, clothing, hair, fabric, and cropped lower-body details",
      "complete anatomy only when visibly cropped and there is enough room",
    );
  }

  return shared.join(", ");
}

function buildComfyUiOutpaintStageNegativePrompt(
  options: ComfyUiGenerationOptions,
  direction: "horizontal" | "top" | "bottom",
): string {
  const negativeParts = [
    buildComfyUiNegativePrompt(options, true, normalizeComfyUiMaskMode(options.inpaintMaskMode)),
    "hard seam",
    "visible border",
    "blank padding",
    "flat color block",
    "disconnected scene",
    "duplicate subject",
    "new unrelated subject",
  ];

  if (direction === "bottom") {
    negativeParts.push(
      "covered legs",
      "grass covering legs",
      "tiny legs",
      "malformed legs",
      "broken feet",
      "unrelated lower body",
    );
  }

  return negativeParts.join(", ");
}

function buildComfyUiPromptWithDefaults(
  options: ComfyUiGenerationOptions,
  inpaint: boolean,
  maskMode: string,
  invertMask: boolean,
  hasReference: boolean,
): string {
  const prompt = options.prompt.trim();
  const qualityPrefix = "masterpiece, best quality, newest, (score_9, score_8, score_7:0.25)";
  if (hasReference && !inpaint) {
    return [
      qualityPrefix,
      `reference-inspired image generation: ${prompt}`,
      "use the reference image as loose visual inspiration for subject, composition, palette, or style",
      "create a new similar image with the requested changes clearly visible",
      "do not copy the reference exactly, allow meaningful variation while preserving the user's requested intent",
    ].join(", ");
  }

  if (!inpaint) {
    return `${qualityPrefix}, well-composed, main subject clearly visible, ${prompt}`;
  }

  const maskPrompt = options.maskPrompt?.trim() || "masked region";
  if (isComfyUiOutpaint(options)) {
    const normalizedDirection = normalizeComfyUiExtendDirection(options.inpaintExtendDirection);
    const outpaintStrategy = resolveComfyUiOutpaintStrategy(options);
    const scaleSource = shouldScaleComfyUiOutpaintSource(options, outpaintStrategy, normalizedDirection);
    const direction = normalizedDirection.replaceAll("_", " ");
    const sourcePreservation = scaleSource
      ? "preserve the main source subject in place"
      : "preserve the source image area";
    return [
      qualityPrefix,
      `canvas outpainting edit: ${prompt}`,
      `extend the image ${direction} beyond the original canvas`,
      ...(outpaintStrategy === "full_canvas"
        ? scaleSource
          ? [
              "zoom-out full-canvas outpainting",
              "continue the visible background beyond the original edges",
              "avoid treating the old image rectangle as a panel",
            ]
          : ["full-canvas outpainting", "fill only the newly revealed canvas by continuing source edges"]
        : outpaintStrategy === "zoom_out"
          ? ["zoom-out outpainting around the scaled source image", "complete nearby context around the source"]
          : ["edge-extension outpainting beyond the original edges"]),
      ...buildComfyUiOutpaintDirectionPrompt(normalizedDirection, scaleSource),
      "continue visible background, lighting, perspective, and environment",
      "extend subjects only where they are cropped by the original edge",
      "most added canvas should be surrounding scene",
      sourcePreservation,
      "match the original lighting, perspective, camera angle, line style, color palette, and texture",
      "no duplicate subject, extra face, unrelated body parts, separate panel, border, or blank padding",
      "new content connects seamlessly to the existing image edge",
    ].join(", ");
  }

  if (maskMode === "background") {
    const protectedRegion = invertMask ? maskPrompt : "main foreground subject";
    const editableRegion = invertMask
      ? `the surroundings outside the protected ${maskPrompt}`
      : "the detected background/surroundings region";
    return [
      qualityPrefix,
      `surroundings-only inpainting edit: ${prompt}`,
      "replace the editable surroundings with the requested background, environment, location, atmosphere, or setting",
      "the new surroundings must fill the entire editable canvas edge to edge, all the way to every image border",
      `apply the requested scene change only to ${editableRegion}`,
      `keep the protected ${protectedRegion} unchanged, same shape, color, lighting, position, and style`,
      "flat continuous background behind the protected subject, clean edge transition",
      "no halo, no outline, no glow, no bubble, no glass dome, no capsule, no transparent shell, no reflection around or over the protected subject",
      "no inset panel or framed rectangle",
    ].join(", ");
  }

  return [
    qualityPrefix,
    `localized inpainting edit for the masked ${maskPrompt}: ${prompt}`,
    "change only the masked area",
    "use the source image as the structure guide",
    ...(isComfyUiHairMaskPrompt(options.maskPrompt)
      ? ["for hair recolors, change pigment only", "keep the source hairstyle geometry"]
      : []),
    "keep unmasked regions unchanged",
    "if the user prompt mentions full-scene or full-character details, treat those as style hints for the masked area only",
  ].join(", ");
}

function extractNegatedPromptTerms(prompt: string): string[] {
  const colorTerms = [
    "white",
    "blue",
    "cyan",
    "teal",
    "green",
    "yellow",
    "orange",
    "red",
    "pink",
    "purple",
    "violet",
    "brown",
    "black",
    "gray",
    "grey",
    "beige",
  ];
  const settingTerms = [
    "indoor",
    "indoors",
    "outdoor",
    "outdoors",
    "interior",
    "exterior",
    "room",
    "studio",
    "plain",
    "empty",
    "blank",
  ];
  const terms = [...colorTerms, ...settingTerms];
  const negatedClauses = [...prompt.matchAll(/\b(?:not|no|without)\s+([^,.]+)/gi)].map(
    (match) => match[1]?.toLowerCase() ?? "",
  );
  const negatedTerms = new Set<string>();
  for (const clause of negatedClauses) {
    for (const term of terms) {
      if (new RegExp(`\\b${term}\\b`, "i").test(clause)) {
        negatedTerms.add(term);
      }
    }
  }
  return [...negatedTerms];
}

function buildComfyUiNegativePrompt(options: ComfyUiGenerationOptions, inpaint: boolean, maskMode: string): string {
  const configuredNegativePrompt = options.negativePrompt?.trim();
  if (!inpaint) {
    return [COMFYUI_BASE_NEGATIVE_PROMPT, configuredNegativePrompt].filter(Boolean).join(", ");
  }

  const negativeParts = [
    COMFYUI_BASE_NEGATIVE_PROMPT,
    ...(configuredNegativePrompt ? [configuredNegativePrompt] : []),
    "unrequested changes, changed unmasked area",
  ];
  if (isComfyUiOutpaint(options)) {
    negativeParts.push(
      "moved original image",
      "resized original image content",
      "cropped original image content",
      "changed original source area",
      "visible seam",
      "hard border",
      "dark outer frame",
      "black outer border",
      "matte border",
      "vignette frame",
      "blank padding",
      "empty extension",
      "mirrored edge",
      "repeated edge artifacts",
      "duplicate character",
      "second character",
      "extra face",
      "giant face",
      "giant torso",
      "giant body",
      "giant limb",
      "unrelated body parts",
      "new character in border",
      "separate scene",
      "disconnected scene",
      "different camera view",
      "new horizon line",
      "lower illustration panel",
      "unrequested character behind subject",
      "unrequested person behind subject",
      "unrequested creature behind subject",
      "unrequested background character",
      "unrequested partial body behind subject",
      "unrequested face in background",
      "unrequested body silhouette in background",
      "cropped duplicate person",
    );
    return negativeParts.join(", ");
  }

  if (maskMode === "background") {
    negativeParts.push(
      "changed protected foreground subject",
      "altered protected subject color",
      "altered protected subject shape",
      "halo around protected subject",
      "glow around protected subject",
      "bubble around protected subject",
      "glass dome around protected subject",
      "transparent shell around protected subject",
      "capsule around protected subject",
      "reflection over protected subject",
      "specular highlight over protected subject",
      "outline around protected subject",
      "old background, original background, unchanged background",
      "centered background panel",
      "inset rectangle",
      "framed rectangle",
      "picture frame",
      "border around background",
      "margin around background",
      "blank outer area",
      "empty outer area",
      "background only behind subject",
    );

    for (const term of extractNegatedPromptTerms(options.prompt)) {
      negativeParts.push(`${term} background`, `${term} backdrop`, `${term} environment`, `${term} setting`);
    }
  } else {
    negativeParts.push(
      "garment redesign",
      "different clothing type",
      "changed neckline",
      "changed sleeves",
      "changed hem",
      "changed fit",
      "new accessories",
      "removed accessories",
      "changed body anatomy",
      "changed pose",
      "changed face",
      "new pattern not requested",
      "logo added",
      "text added",
    );
  }

  return negativeParts.join(", ");
}

function resolveComfyUiDenoise(options: ComfyUiGenerationOptions): number {
  if (!buildReferenceImageDataUrl(options)) {
    return 1;
  }

  const rawDenoise = options.denoise ?? options.referenceDenoise ?? null;
  if (rawDenoise !== null) {
    return Number.isFinite(rawDenoise) ? clampNumber(rawDenoise, 0, 1) : DEFAULT_COMFYUI_REFERENCE_DENOISE;
  }

  if (options.inpaint === true) {
    return resolveComfyUiInpaintSettings(options).referenceDenoise;
  }

  const envDenoise = readOptionalNumberEnv("COMFYUI_REFERENCE_DENOISE");
  if (envDenoise !== null) {
    return clampNumber(envDenoise, 0, 1);
  }

  const img2imgDenoise =
    readOptionalNumberEnv("COMFYUI_IMG2IMG_DENOISE") ?? readOptionalNumberEnv("ANIMA3_IMG2IMG_DENOISE");
  if (img2imgDenoise !== null) {
    return clampNumber(img2imgDenoise, 0, 1);
  }

  return DEFAULT_COMFYUI_REFERENCE_DENOISE;
}

function resolveComfyUiEffectiveDenoise(options: ComfyUiGenerationOptions, inpaint: boolean, maskMode: string): number {
  const denoise = resolveComfyUiDenoise(options);
  if (!inpaint || maskMode !== "background") {
    return denoise;
  }

  return 1;
}

function getComfyUiTimeoutMs(): number {
  const defaultTimeoutMs = 900000;
  const parsed = Number.parseInt(process.env.COMFYUI_POLL_TIMEOUT_MS ?? `${defaultTimeoutMs}`, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultTimeoutMs;
}

function generateComfyUiSeed(): number {
  return randomInt(0, COMFYUI_MAX_RANDOM_SEED);
}

function parseAspectRatio(
  aspectRatio: string | undefined,
  fallback: string,
): { widthUnits: number; heightUnits: number } {
  const normalized = aspectRatio?.trim() || fallback;
  const match = normalized.match(/^(\d+):(\d+)$/);
  if (!match) {
    return fallback === normalized ? { widthUnits: 1, heightUnits: 1 } : parseAspectRatio(fallback, fallback);
  }

  const widthUnits = Number.parseInt(match[1], 10);
  const heightUnits = Number.parseInt(match[2], 10);
  if (!Number.isFinite(widthUnits) || !Number.isFinite(heightUnits) || widthUnits <= 0 || heightUnits <= 0) {
    return fallback === normalized ? { widthUnits: 1, heightUnits: 1 } : parseAspectRatio(fallback, fallback);
  }

  return { widthUnits, heightUnits };
}

function roundToNearestMultiple(value: number, multiple: number): number {
  return Math.max(multiple, Math.round(value / multiple) * multiple);
}

function buildComfyUiImageDimensions(aspectRatio: string | undefined): { width: number; height: number } {
  const { widthUnits, heightUnits } = parseAspectRatio(aspectRatio, "1:1");
  const width = Math.sqrt((COMFYUI_IMAGE_TARGET_AREA * widthUnits) / heightUnits);
  const height = Math.sqrt((COMFYUI_IMAGE_TARGET_AREA * heightUnits) / widthUnits);

  return {
    width: roundToNearestMultiple(width, COMFYUI_DIMENSION_MULTIPLE),
    height: roundToNearestMultiple(height, COMFYUI_DIMENSION_MULTIPLE),
  };
}

function buildComfyUiVideoDimensions(
  aspectRatio: string | undefined,
  resolution: string | undefined,
): {
  width: number;
  height: number;
} {
  const normalizedResolution = normalizeComfyUiVideoResolution(resolution);
  const normalizedAspectRatio = aspectRatio === "9:16" || aspectRatio === "1:1" ? aspectRatio : "16:9";

  if (normalizedAspectRatio === "9:16") {
    if (normalizedResolution === "1080p") {
      return { width: 1080, height: 1920 };
    }
    if (normalizedResolution === "720p") {
      return { width: 720, height: 1280 };
    }
    return { width: 480, height: 854 };
  }

  if (normalizedAspectRatio === "1:1") {
    if (normalizedResolution === "1080p") {
      return { width: 1024, height: 1024 };
    }
    if (normalizedResolution === "720p") {
      return { width: 720, height: 720 };
    }
    return { width: 480, height: 480 };
  }

  if (normalizedResolution === "1080p") {
    return { width: 1920, height: 1080 };
  }
  if (normalizedResolution === "720p") {
    return { width: 1280, height: 720 };
  }
  return { width: 854, height: 480 };
}

function getComfyUiVideoLongSide(resolution: string | undefined): number {
  const normalizedResolution = normalizeComfyUiVideoResolution(resolution);
  if (normalizedResolution === "1080p") {
    return 1920;
  }
  if (normalizedResolution === "720p") {
    return 1280;
  }
  return 854;
}

function buildComfyUiVideoDimensionsFromReference(
  referenceImage: ComfyUiReferenceImage,
  resolution: string | undefined,
): { width: number; height: number } | null {
  if (
    typeof referenceImage.width !== "number" ||
    typeof referenceImage.height !== "number" ||
    !Number.isFinite(referenceImage.width) ||
    !Number.isFinite(referenceImage.height) ||
    referenceImage.width <= 0 ||
    referenceImage.height <= 0
  ) {
    return null;
  }

  const maxSide = getComfyUiVideoLongSide(resolution);
  const scale = Math.min(1, maxSide / Math.max(referenceImage.width, referenceImage.height));
  const width = Math.max(16, Math.floor((referenceImage.width * scale) / 16) * 16);
  const height = Math.max(16, Math.floor((referenceImage.height * scale) / 16) * 16);
  return { width, height };
}

function buildComfyUiDimensions(options: ComfyUiGenerationOptions): { width: number; height: number } {
  if (options.mode === "video") {
    const referenceDimensions = options.referenceImages?.[0]
      ? buildComfyUiVideoDimensionsFromReference(options.referenceImages[0], options.resolution)
      : null;
    return referenceDimensions ?? buildComfyUiVideoDimensions(options.aspectRatio, options.resolution);
  }

  return buildComfyUiImageDimensions(options.aspectRatio);
}

function normalizeComfyUiVideoResolution(resolution: string | undefined): "480p" | "720p" | "1080p" {
  return resolution === "1080p" ? "1080p" : resolution === "720p" ? "720p" : "480p";
}

function readComfyUiVideoMaxResolution(): "480p" | "720p" | "1080p" | null {
  const rawValue =
    readOptionalStringEnv("COMFYUI_VIDEO_MAX_RESOLUTION") ??
    readOptionalStringEnv("TOMORI_COMFYUI_VIDEO_MAX_RESOLUTION") ??
    readOptionalStringEnv("COMFYUI_MAX_VIDEO_RESOLUTION");
  if (!rawValue) {
    return null;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (normalized === "1080p" || normalized === "1080") {
    return "1080p";
  }
  if (normalized === "720p" || normalized === "720") {
    return "720p";
  }
  if (normalized === "480p" || normalized === "480") {
    return "480p";
  }
  return null;
}

function capComfyUiVideoResolution(resolution: string | undefined): "480p" | "720p" | "1080p" {
  const normalizedResolution = normalizeComfyUiVideoResolution(resolution);
  const maxResolution = readComfyUiVideoMaxResolution();
  if (!maxResolution) {
    return normalizedResolution;
  }

  const rank = { "480p": 0, "720p": 1, "1080p": 2 } as const;
  return rank[normalizedResolution] > rank[maxResolution] ? maxResolution : normalizedResolution;
}

function resolveComfyUiVideoDurationSeconds(durationSeconds: number | undefined): number {
  const requested =
    typeof durationSeconds === "number" && Number.isFinite(durationSeconds) && durationSeconds > 0
      ? durationSeconds
      : COMFYUI_DEFAULT_VIDEO_DURATION_SECONDS;
  const maxDuration =
    readOptionalNumberEnv("COMFYUI_VIDEO_MAX_DURATION_SECONDS") ??
    readOptionalNumberEnv("TOMORI_COMFYUI_VIDEO_MAX_DURATION_SECONDS") ??
    readOptionalNumberEnv("COMFYUI_MAX_VIDEO_DURATION_SECONDS");
  const capped = maxDuration !== null && maxDuration > 0 ? Math.min(requested, maxDuration) : requested;
  return clampNumber(capped, 1, 60);
}

function resolveComfyUiVideoFps(requestedFps: number | undefined): number {
  // Honor a user-supplied FPS (from the /generate video modal) when valid,
  //    mirroring how resolveComfyUiVideoDurationSeconds() prioritizes the request.
  // Otherwise fall back through the operator env overrides to the built-in default.
  const requested =
    typeof requestedFps === "number" && Number.isFinite(requestedFps) && requestedFps > 0
      ? requestedFps
      : (readOptionalNumberEnv("COMFYUI_VIDEO_FPS") ??
        readOptionalNumberEnv("TOMORI_COMFYUI_VIDEO_FPS") ??
        COMFYUI_DEFAULT_VIDEO_FPS);
  return clampNumber(requested, 1, 120);
}

function resolveComfyUiVideoOutputFps(baseFps: number): number {
  const explicitOutputFps =
    readOptionalNumberEnv("COMFYUI_VIDEO_OUTPUT_FPS") ?? readOptionalNumberEnv("TOMORI_COMFYUI_VIDEO_OUTPUT_FPS");
  if (explicitOutputFps !== null) {
    return clampNumber(explicitOutputFps, 1, 120);
  }

  const playbackSpeed = clampNumber(
    readOptionalNumberEnv("COMFYUI_VIDEO_PLAYBACK_SPEED_MULTIPLIER") ??
      readOptionalNumberEnv("TOMORI_COMFYUI_VIDEO_PLAYBACK_SPEED_MULTIPLIER") ??
      COMFYUI_DEFAULT_VIDEO_PLAYBACK_SPEED_MULTIPLIER,
    0.25,
    4,
  );
  return clampNumber(baseFps * playbackSpeed, 1, 120);
}

function resolveComfyUiVideoFrameCount(durationSeconds: number, fps: number): number {
  return Math.max(1, Math.floor(durationSeconds * fps + 1));
}

function resolveComfyUiVideoSteps(): number {
  return Math.round(
    clampNumber(
      readOptionalNumberEnv("COMFYUI_VIDEO_STEPS") ??
        readOptionalNumberEnv("TOMORI_COMFYUI_VIDEO_STEPS") ??
        COMFYUI_DEFAULT_VIDEO_STEPS,
      1,
      100,
    ),
  );
}

function resolveComfyUiVideoCfg(): number {
  return clampNumber(
    readOptionalNumberEnv("COMFYUI_VIDEO_CFG") ??
      readOptionalNumberEnv("TOMORI_COMFYUI_VIDEO_CFG") ??
      COMFYUI_DEFAULT_VIDEO_CFG,
    0,
    30,
  );
}

function resolveComfyUiVideoAudioSteps(): number {
  return Math.round(
    clampNumber(
      readOptionalNumberEnv("COMFYUI_VIDEO_AUDIO_STEPS") ??
        readOptionalNumberEnv("TOMORI_COMFYUI_VIDEO_AUDIO_STEPS") ??
        COMFYUI_DEFAULT_VIDEO_AUDIO_STEPS,
      1,
      100,
    ),
  );
}

function resolveComfyUiVideoAudioCfg(): number {
  return clampNumber(
    readOptionalNumberEnv("COMFYUI_VIDEO_AUDIO_CFG") ??
      readOptionalNumberEnv("TOMORI_COMFYUI_VIDEO_AUDIO_CFG") ??
      COMFYUI_DEFAULT_VIDEO_AUDIO_CFG,
    0,
    30,
  );
}

function normalizeComfyUiVideoOptions<T extends ComfyUiGenerationOptions>(options: T): T {
  if (options.mode !== "video") {
    return options;
  }

  return {
    ...options,
    durationSeconds: resolveComfyUiVideoDurationSeconds(options.durationSeconds),
    resolution: capComfyUiVideoResolution(options.resolution),
  } as T;
}

function buildComfyUiVideoPrompt(prompt: string): string {
  const extra = readOptionalStringEnv("COMFYUI_VIDEO_PROMPT_SUFFIX") ?? COMFYUI_VIDEO_PROMPT_STABILIZER;
  const trimmedPrompt = prompt.trim();
  const trimmedExtra = extra.trim();
  return trimmedExtra ? `${trimmedPrompt}\n\n${trimmedExtra}` : trimmedPrompt;
}

function buildComfyUiVideoNegativePrompt(): string {
  return readOptionalStringEnv("COMFYUI_VIDEO_NEGATIVE_PROMPT") ?? COMFYUI_VIDEO_NEGATIVE_PROMPT;
}

function buildComfyUiVideoAudioPrompt(prompt: string, audioPrompt?: string): string {
  const extra = readOptionalStringEnv("COMFYUI_VIDEO_AUDIO_PROMPT_SUFFIX") ?? COMFYUI_VIDEO_AUDIO_PROMPT_STABILIZER;
  const trimmedPrompt = (audioPrompt?.trim() || prompt).trim();
  const trimmedExtra = extra.trim();
  return trimmedExtra ? `${trimmedPrompt}\n\n${trimmedExtra}` : trimmedPrompt;
}

function buildComfyUiVideoAudioNegativePrompt(): string {
  return readOptionalStringEnv("COMFYUI_VIDEO_AUDIO_NEGATIVE_PROMPT") ?? COMFYUI_VIDEO_AUDIO_NEGATIVE_PROMPT;
}

function buildComfyUiReferencePayload(referenceImages: ComfyUiReferenceImage[]): Array<Record<string, unknown>> {
  return referenceImages.map((referenceImage, index) => ({
    index: index + 1,
    mimeType: referenceImage.mimeType,
    data: referenceImage.data,
    dataUrl: `data:${referenceImage.mimeType};base64,${referenceImage.data}`,
    ...(referenceImage.url ? { url: referenceImage.url } : {}),
    ...(referenceImage.fallbackUrl ? { fallbackUrl: referenceImage.fallbackUrl } : {}),
    ...(referenceImage.comfyUiFilename ? { filename: referenceImage.comfyUiFilename } : {}),
    ...(referenceImage.comfyUiSubfolder ? { subfolder: referenceImage.comfyUiSubfolder } : {}),
    ...(referenceImage.comfyUiType ? { type: referenceImage.comfyUiType } : {}),
  }));
}

function getComfyUiImageExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("jpeg") || normalized.includes("jpg")) {
    return "jpg";
  }
  if (normalized.includes("webp")) {
    return "webp";
  }
  if (normalized.includes("gif")) {
    return "gif";
  }
  return "png";
}

function normalizeComfyUiUploadField(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function buildDiscordDownloadInit(url: string): RequestInit | undefined {
  if (!process.env.DISCORD_TOKEN || !/discord(?:app)?\.(?:com|net)|discordcdn\.com/i.test(url)) {
    return undefined;
  }

  return {
    headers: {
      Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
    },
  };
}

async function resolveComfyUiReferenceImageBuffer(referenceImage: ComfyUiReferenceImage): Promise<{
  buffer: Buffer;
  mimeType: string;
}> {
  if (referenceImage.data) {
    return {
      buffer: Buffer.from(referenceImage.data, "base64"),
      mimeType: referenceImage.mimeType || "image/png",
    };
  }

  if (!referenceImage.url) {
    throw new Error("ComfyUI image-to-video requires a reference image payload or URL.");
  }

  const urls = [referenceImage.url, referenceImage.fallbackUrl].filter((url): url is string => !!url);
  let lastDownloadDetails = "unknown error";
  for (const url of urls) {
    const downloadResult = await safeDownload(url, {
      maxSizeMB: COMFYUI_REFERENCE_IMAGE_DOWNLOAD_MAX_MB,
      timeoutMs: 15_000,
      requestInit: buildDiscordDownloadInit(url),
    });
    if (downloadResult.success && downloadResult.buffer) {
      return {
        buffer: downloadResult.buffer,
        mimeType: downloadResult.contentType ?? referenceImage.mimeType ?? "image/png",
      };
    }
    lastDownloadDetails = downloadResult.details ?? downloadResult.error ?? lastDownloadDetails;
  }

  throw new Error(`Failed to download ComfyUI reference image: ${lastDownloadDetails}`);
}

async function uploadComfyUiReferenceImage(
  endpoint: CustomEndpointRow,
  apiKey: string,
  referenceImage: ComfyUiReferenceImage,
  index: number,
): Promise<ComfyUiReferenceImage> {
  const { buffer, mimeType } = await resolveComfyUiReferenceImageBuffer(referenceImage);
  const filename = `tomoribot_ref_${Date.now()}_${index}.${getComfyUiImageExtension(mimeType)}`;
  const imageBytes = new Uint8Array(buffer.length);
  imageBytes.set(buffer);
  const formData = new FormData();
  formData.append("image", new Blob([imageBytes], { type: mimeType }), filename);
  formData.append("type", "input");
  formData.append("overwrite", "true");

  const headers = buildCustomHeaders(apiKey);
  delete headers["Content-Type"];
  const response = await fetchUserRemoteUrl(`${endpoint.endpoint_url.replace(/\/+$/, "")}/upload/image`, {
    method: "POST",
    headers,
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`ComfyUI reference image upload failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json().catch(() => ({}))) as {
    name?: string;
    subfolder?: string;
    type?: string;
  };
  const metadata = await sharp(buffer)
    .metadata()
    .catch(() => null);

  return {
    ...referenceImage,
    data: referenceImage.data || buffer.toString("base64"),
    mimeType,
    ...(typeof metadata?.width === "number" && metadata.width > 0 ? { width: metadata.width } : {}),
    ...(typeof metadata?.height === "number" && metadata.height > 0 ? { height: metadata.height } : {}),
    comfyUiFilename: normalizeComfyUiUploadField(payload.name) ?? filename,
    comfyUiSubfolder: normalizeComfyUiUploadField(payload.subfolder),
    comfyUiType: normalizeComfyUiUploadField(payload.type) ?? "input",
  };
}

async function uploadComfyUiReferenceImages(
  endpoint: CustomEndpointRow,
  apiKey: string,
  referenceImages: ComfyUiReferenceImage[],
): Promise<ComfyUiReferenceImage[]> {
  if (referenceImages.length === 0) {
    return [];
  }

  return Promise.all(
    referenceImages.map((referenceImage, index) =>
      uploadComfyUiReferenceImage(endpoint, apiKey, referenceImage, index + 1),
    ),
  );
}

function pruneComfyUiOutpaintDiagnosticSaveNodes(workflow: ComfyUiWorkflow): number {
  let removed = 0;
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (isComfyUiDiagnosticSaveImageNode(node)) {
      delete workflow[nodeId];
      removed += 1;
    }
  }
  return removed;
}

function parseComfyUiRecolorTargetColor(prompt: string): RgbColor | null {
  const normalized = prompt.toLowerCase();
  const colorPatterns: Array<[RegExp, RgbColor]> = [
    [
      /\b(?:dark|deep|near[-\s]?black|almost\s+black|blackish)\s+(?:purple|violet)\b|\b(?:purple|violet)\s+(?:near[-\s]?black|almost\s+black|blackish)\b/,
      { r: 42, g: 20, b: 68 },
    ],
    [
      /\b(?:dark|deep|near[-\s]?black|almost\s+black|blackish)\s+(?:blue|navy)\b|\b(?:blue|navy)\s+(?:near[-\s]?black|almost\s+black|blackish)\b/,
      { r: 18, g: 30, b: 78 },
    ],
    [
      /\b(?:dark|deep|near[-\s]?black|almost\s+black|blackish)\s+(?:red|burgundy|maroon)\b|\b(?:red|burgundy|maroon)\s+(?:near[-\s]?black|almost\s+black|blackish)\b/,
      { r: 74, g: 18, b: 28 },
    ],
    [/\bred[-\s]?orange\b|\borange[-\s]?red\b|\bcopper\b|\bginger\b|\bauburn\b/, { r: 229, g: 83, b: 24 }],
    [/\borange\b|\btabby\b/, { r: 230, g: 116, b: 28 }],
    [/\bred\b/, { r: 210, g: 42, b: 42 }],
    [/\byellow\b|\bgold(?:en)?\b/, { r: 232, g: 188, b: 48 }],
    [/\bgreen\b|\bemerald\b/, { r: 38, g: 168, b: 96 }],
    [/\bcyan\b|\bteal\b/, { r: 26, g: 174, b: 180 }],
    [/\bblue\b/, { r: 54, g: 116, b: 220 }],
    [/\bpurple\b|\bviolet\b/, { r: 132, g: 72, b: 190 }],
    [/\bpink\b|\bmagenta\b/, { r: 224, g: 92, b: 154 }],
    [/\bbrown\b/, { r: 128, g: 77, b: 42 }],
    [/\bblack\b/, { r: 28, g: 25, b: 24 }],
    [/\bwhite\b/, { r: 236, g: 232, b: 220 }],
    [/\bgrey\b|\bgray\b|\bsilver\b/, { r: 150, g: 150, b: 150 }],
  ];

  return colorPatterns.find(([pattern]) => pattern.test(normalized))?.[1] ?? null;
}

function rgbToComfyUiColor(color: RgbColor): number {
  return (color.r << 16) + (color.g << 8) + color.b;
}

function shouldUseComfyUiMaskedTintReference(options: ComfyUiGenerationOptions): boolean {
  void options;
  return false;
}

function stringifyWorkflowPlaceholder(value: WorkflowPlaceholderValue): string {
  if (value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

function replaceWorkflowStringPlaceholders(
  value: string,
  placeholders: Record<string, WorkflowPlaceholderValue>,
): WorkflowPlaceholderValue {
  const exactMatch = value.match(/^\{([A-Z0-9_]+)\}$/);
  if (exactMatch && Object.hasOwn(placeholders, exactMatch[1])) {
    return placeholders[exactMatch[1]];
  }

  let replaced = value;
  for (const [placeholderName, placeholderValue] of Object.entries(placeholders)) {
    const token = `{${placeholderName}}`;
    if (!replaced.includes(token)) {
      continue;
    }
    replaced = replaced.split(token).join(stringifyWorkflowPlaceholder(placeholderValue));
  }

  return replaced;
}

function replaceWorkflowPlaceholders(value: unknown, placeholders: Record<string, WorkflowPlaceholderValue>): unknown {
  if (typeof value === "string") {
    return replaceWorkflowStringPlaceholders(value, placeholders);
  }

  if (Array.isArray(value)) {
    return value.map((item) => replaceWorkflowPlaceholders(item, placeholders));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, childValue]) => [key, replaceWorkflowPlaceholders(childValue, placeholders)]),
    );
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepCloneWorkflow(workflow: Record<string, unknown>): ComfyUiWorkflow {
  return structuredClone(workflow) as ComfyUiWorkflow;
}

function workflowContainsPlaceholder(value: unknown, placeholder: string): boolean {
  if (typeof value === "string") {
    return value.includes(`{${placeholder}}`);
  }
  if (Array.isArray(value)) {
    return value.some((item) => workflowContainsPlaceholder(item, placeholder));
  }
  if (isRecord(value)) {
    return Object.values(value).some((childValue) => workflowContainsPlaceholder(childValue, placeholder));
  }
  return false;
}

function isComfyUiNodeLink(value: unknown): value is [string, number] {
  return Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "number";
}

function readComfyUiBooleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }

  return null;
}

type ComfyUiConstantValue = string | number | boolean | null;

function readComfyUiConstantValue(
  value: unknown,
  constantValues: Map<string, ComfyUiConstantValue>,
): ComfyUiConstantValue | undefined {
  if (isComfyUiNodeLink(value)) {
    return constantValues.get(value[0]);
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }

  return undefined;
}

function compareComfyUiConstantValues(a: ComfyUiConstantValue, b: ComfyUiConstantValue, cmp: string): boolean | null {
  const normalizedCmp = cmp.trim().toLowerCase().replace(/\s+/g, " ");
  const normalizedA = typeof a === "string" ? a.trim() : a;
  const normalizedB = typeof b === "string" ? b.trim() : b;

  switch (normalizedCmp) {
    case "a = b":
    case "a == b":
    case "a === b":
      return normalizedA === normalizedB;
    case "a != b":
    case "a !== b":
      return normalizedA !== normalizedB;
    case "a > b":
    case "a >= b":
    case "a < b":
    case "a <= b": {
      const numericA = typeof normalizedA === "number" ? normalizedA : Number(normalizedA);
      const numericB = typeof normalizedB === "number" ? normalizedB : Number(normalizedB);
      if (!Number.isFinite(numericA) || !Number.isFinite(numericB)) {
        return null;
      }
      if (normalizedCmp === "a > b") {
        return numericA > numericB;
      }
      if (normalizedCmp === "a >= b") {
        return numericA >= numericB;
      }
      if (normalizedCmp === "a < b") {
        return numericA < numericB;
      }
      return numericA <= numericB;
    }
    default:
      return null;
  }
}

function buildConstantComfyUiNodeValues(workflow: ComfyUiWorkflow): Map<string, ComfyUiConstantValue> {
  const constantValues = new Map<string, ComfyUiConstantValue>();

  for (let pass = 0; pass < 10; pass += 1) {
    let added = 0;

    for (const [nodeId, node] of Object.entries(workflow)) {
      if (
        !isRecord(node) ||
        !isRecord(node.inputs) ||
        typeof node.class_type !== "string" ||
        constantValues.has(nodeId)
      ) {
        continue;
      }

      const classType = node.class_type.toLowerCase();
      if (
        classType.includes("impactconvertdatatype") ||
        classType.includes("impactint") ||
        classType.includes("impactfloat") ||
        classType.includes("impactstring")
      ) {
        const value = readComfyUiConstantValue(node.inputs.value, constantValues);
        if (value !== undefined) {
          constantValues.set(nodeId, value);
          added += 1;
        }
        continue;
      }

      if (classType.includes("impactcompare")) {
        const a = readComfyUiConstantValue(node.inputs.a, constantValues);
        const b = readComfyUiConstantValue(node.inputs.b, constantValues);
        const cmp = typeof node.inputs.cmp === "string" ? node.inputs.cmp : "";
        if (a === undefined || b === undefined || !cmp) {
          continue;
        }

        const compared = compareComfyUiConstantValues(a, b, cmp);
        if (compared !== null) {
          constantValues.set(nodeId, compared);
          added += 1;
        }
      }
    }

    if (added === 0) {
      break;
    }
  }

  return constantValues;
}

function rewriteComfyUiNodeReferences(workflow: ComfyUiWorkflow, fromNodeId: string, toLink: [string, number]): number {
  let rewritten = 0;

  for (const node of Object.values(workflow)) {
    if (!isRecord(node) || !isRecord(node.inputs)) {
      continue;
    }

    for (const [inputName, inputValue] of Object.entries(node.inputs)) {
      if (isComfyUiNodeLink(inputValue) && inputValue[0] === fromNodeId) {
        node.inputs[inputName] = [...toLink];
        rewritten += 1;
      }
    }
  }

  return rewritten;
}

function collectComfyUiNodeLinks(value: unknown, links: Set<string>): void {
  if (isComfyUiNodeLink(value)) {
    links.add(value[0]);
    return;
  }

  if (Array.isArray(value)) {
    for (const childValue of value) {
      collectComfyUiNodeLinks(childValue, links);
    }
    return;
  }

  if (isRecord(value)) {
    for (const childValue of Object.values(value)) {
      collectComfyUiNodeLinks(childValue, links);
    }
  }
}

function isComfyUiOutputNode(node: unknown): boolean {
  if (!isRecord(node) || typeof node.class_type !== "string") {
    return false;
  }

  const classType = node.class_type.toLowerCase();
  return classType.includes("saveimage") || classType.includes("previewimage");
}

function pruneUnreachableComfyUiNodes(workflow: ComfyUiWorkflow): number {
  const rootNodeIds = Object.entries(workflow)
    .filter(([, node]) => isComfyUiOutputNode(node))
    .map(([nodeId]) => nodeId);

  if (rootNodeIds.length === 0) {
    return 0;
  }

  const reachableNodeIds = new Set<string>();
  const pendingNodeIds = [...rootNodeIds];

  while (pendingNodeIds.length > 0) {
    const nodeId = pendingNodeIds.pop();
    if (!nodeId || reachableNodeIds.has(nodeId)) {
      continue;
    }

    const node = workflow[nodeId];
    if (!node) {
      continue;
    }

    reachableNodeIds.add(nodeId);
    const linkedNodeIds = new Set<string>();
    collectComfyUiNodeLinks(node, linkedNodeIds);
    for (const linkedNodeId of linkedNodeIds) {
      if (!reachableNodeIds.has(linkedNodeId)) {
        pendingNodeIds.push(linkedNodeId);
      }
    }
  }

  let removed = 0;
  for (const nodeId of Object.keys(workflow)) {
    if (!reachableNodeIds.has(nodeId)) {
      delete workflow[nodeId];
      removed += 1;
    }
  }

  return removed;
}

function foldConstantComfyUiConditionals(workflow: ComfyUiWorkflow): number {
  let totalRewritten = 0;

  for (let pass = 0; pass < 10; pass += 1) {
    const constantValues = buildConstantComfyUiNodeValues(workflow);

    let passRewritten = 0;
    for (const [nodeId, node] of Object.entries(workflow)) {
      if (!isRecord(node) || !isRecord(node.inputs) || typeof node.class_type !== "string") {
        continue;
      }

      if (!node.class_type.toLowerCase().includes("impactconditionalbranch")) {
        continue;
      }

      const cond = node.inputs.cond;
      if (!isComfyUiNodeLink(cond)) {
        continue;
      }

      const condValue = constantValues.get(cond[0]);
      const condBoolean = readComfyUiBooleanValue(condValue);
      if (condBoolean === null) {
        continue;
      }

      const selectedInput = condBoolean ? node.inputs.tt_value : node.inputs.ff_value;
      if (!isComfyUiNodeLink(selectedInput)) {
        continue;
      }

      passRewritten += rewriteComfyUiNodeReferences(workflow, nodeId, selectedInput);
    }

    totalRewritten += passRewritten;
    if (passRewritten === 0) {
      break;
    }
  }

  return totalRewritten;
}

function hasActiveComfyUiOutpaintNode(workflow: ComfyUiWorkflow): boolean {
  return Object.values(workflow).some((node) => {
    if (!isRecord(node) || !isRecord(node.inputs) || typeof node.class_type !== "string") {
      return false;
    }
    return node.class_type.toLowerCase().includes("inpaintcrop") && node.inputs.extend_for_outpainting === true;
  });
}

function assertComfyUiFullCanvasOutpaintWorkflow(savedWorkflow: ComfyUiWorkflow): void {
  if (workflowContainsPlaceholder(savedWorkflow, "TOMORI_OUTPAINT_FULL_CANVAS")) {
    return;
  }

  throw new Error(
    [
      "The active ComfyUI workflow does not expose a full-canvas outpaint branch.",
      "Add a branch gated by {TOMORI_OUTPAINT_FULL_CANVAS} that routes to the expanded LanPaint outpaint output.",
      "Full-canvas outpainting must avoid InpaintCropImproved/InpaintStitchImproved and feed the expanded canvas plus border mask directly into inpaint conditioning.",
    ].join(" "),
  );
}

function hasComfyUiVisualWorkflowShape(workflow: ComfyUiWorkflow): boolean {
  return Array.isArray(workflow.nodes) || Array.isArray(workflow.links) || Array.isArray(workflow.groups);
}

function buildReferenceImageDataUrl(options: ComfyUiGenerationOptions): string | null {
  if (options.referenceImageDataUrl) {
    return options.referenceImageDataUrl;
  }

  const firstReferenceImage = options.referenceImages?.[0];
  if (!firstReferenceImage) {
    return null;
  }

  return `data:${firstReferenceImage.mimeType};base64,${firstReferenceImage.data}`;
}

function readComfyUiWorkflowSupports(endpoint: CustomEndpointRow): ComfyUiWorkflowSupports {
  const rawSupports = endpoint.extra_config.workflow_supports;
  if (!isRecord(rawSupports)) {
    return DEFAULT_COMFYUI_WORKFLOW_SUPPORTS;
  }

  return {
    txt2img: typeof rawSupports.txt2img === "boolean" ? rawSupports.txt2img : DEFAULT_COMFYUI_WORKFLOW_SUPPORTS.txt2img,
    img2img: typeof rawSupports.img2img === "boolean" ? rawSupports.img2img : DEFAULT_COMFYUI_WORKFLOW_SUPPORTS.img2img,
    inpaint: typeof rawSupports.inpaint === "boolean" ? rawSupports.inpaint : DEFAULT_COMFYUI_WORKFLOW_SUPPORTS.inpaint,
  };
}

function assertComfyUiWorkflowSupportsRequest(
  options: ComfyUiGenerationOptions,
  supports: ComfyUiWorkflowSupports,
): void {
  const hasReference = !!buildReferenceImageDataUrl(options);
  if (options.inpaint === true && !hasReference) {
    throw new Error("Inpaint requires a reference image.");
  }
  if (options.inpaint === true && !options.maskPrompt?.trim()) {
    throw new Error("Inpaint requires a mask_prompt describing the region to edit.");
  }
  if (options.inpaint === true && !supports.inpaint) {
    throw new Error("This ComfyUI workflow is not configured to support inpaint requests.");
  }
  if (hasReference && options.inpaint !== true && !supports.img2img) {
    throw new Error("This ComfyUI workflow is not configured to support reference-image requests.");
  }
  if (!hasReference && !supports.txt2img) {
    throw new Error("This ComfyUI workflow is not configured to support text-to-image requests.");
  }
}

function applyComfyUiImageInputDefaults(
  workflow: ComfyUiWorkflow,
  options: ComfyUiGenerationOptions & { seed: number },
): number {
  const inpaintSettings = resolveComfyUiInpaintSettings(options);
  const inpaint = !!buildReferenceImageDataUrl(options) && options.inpaint === true;
  const maskMode = inpaint ? normalizeComfyUiMaskMode(options.inpaintMaskMode) : "target";
  const referenceDenoise = resolveComfyUiEffectiveDenoise(options, inpaint, maskMode);
  let defaultsApplied = 0;

  for (const node of Object.values(workflow)) {
    if (!isRecord(node) || !isRecord(node.inputs)) {
      continue;
    }

    const classType = typeof node.class_type === "string" ? node.class_type.toLowerCase() : "";
    const inputs = node.inputs;

    if (classType.includes("clipseg") && inputs.threshold == null) {
      inputs.threshold = inpaintSettings.maskThreshold;
      defaultsApplied += 1;
    }

    if (classType.includes("growmask")) {
      if (inputs.expand == null) {
        inputs.expand = inpaintSettings.maskGrow;
        defaultsApplied += 1;
      }
      if (inputs.blur_radius == null) {
        inputs.blur_radius = inpaintSettings.maskFeather;
        defaultsApplied += 1;
      }
    }

    const looksLikeSampler = classType.includes("ksampler") || ("sampler_name" in inputs && "latent_image" in inputs);
    const looksLikeSeedNode = classType.includes("seedgenerator");
    if ((looksLikeSampler || looksLikeSeedNode) && "seed" in inputs && !Array.isArray(inputs.seed)) {
      inputs.seed = options.seed;
      defaultsApplied += 1;
    }
    if (looksLikeSampler && "noise_seed" in inputs && !Array.isArray(inputs.noise_seed)) {
      inputs.noise_seed = options.seed;
      defaultsApplied += 1;
    }
    if (looksLikeSampler && inputs.denoise == null) {
      inputs.denoise = referenceDenoise;
      defaultsApplied += 1;
    }
    if (looksLikeSampler && inputs.cfg == null && options.inpaint === true) {
      inputs.cfg = inpaintSettings.cfg;
      defaultsApplied += 1;
    }
  }

  return defaultsApplied;
}

function buildComfyUiPlaceholderMap(
  endpoint: CustomEndpointRow,
  options: ComfyUiGenerationOptions,
  dimensions: { source: { width: number; height: number }; output: { width: number; height: number } },
  referencePayload: Array<Record<string, unknown>>,
): Record<string, WorkflowPlaceholderValue> {
  const referenceImageDataUrl = buildReferenceImageDataUrl(options);
  const hasReference = !!referenceImageDataUrl;
  const inpaint = hasReference && options.inpaint === true;
  const requestedMaskPrompt = options.maskPrompt?.trim() || options.prompt;
  const outpaint = inpaint && isComfyUiOutpaint(options);
  const maskPrompt =
    outpaint && /^main foreground object$/i.test(requestedMaskPrompt)
      ? inferComfyUiForegroundMaskPrompt(options.prompt)
      : requestedMaskPrompt;
  const seed = options.seed ?? generateComfyUiSeed();
  const firstReferenceImage = referencePayload[0];
  const maskMode = inpaint ? normalizeComfyUiMaskMode(options.inpaintMaskMode) : "target";
  const workflowMaskPrompt = resolveComfyUiWorkflowMaskPrompt(maskPrompt, maskMode, options.prompt);
  const invertInpaintMask = maskMode === "background";
  const promptOptions = workflowMaskPrompt === maskPrompt ? options : { ...options, maskPrompt: workflowMaskPrompt };
  const rawInpaintSettings = resolveComfyUiInpaintSettings(options);
  const inpaintSettings = resolveComfyUiEffectiveInpaintSettings(rawInpaintSettings, inpaint, maskMode);
  const protectionSettings = resolveComfyUiMaskProtectionSettings({ ...options, inpaint });
  const denoise = resolveComfyUiEffectiveDenoise(options, inpaint, maskMode);
  const inpaintMaskContent = resolveComfyUiInpaintMaskContent(options, inpaint, maskMode);
  const maskedTintReference = shouldUseComfyUiMaskedTintReference(options);
  const useDifferentialDiffusion = shouldUseComfyUiDifferentialDiffusion(options);
  const useRmbgBackgroundMask = shouldUseComfyUiRmbgBackgroundMask(options);
  const useClothingParser = shouldUseComfyUiClothingParser(options);
  const useClothingParserTarget = useClothingParser && shouldUseComfyUiClothingParserTarget(options);
  const useClothingParserHairTarget = shouldUseComfyUiClothingParserHairTarget(options);
  const useClothingParserProtection =
    useClothingParser &&
    isComfyUiHairMaskPrompt(options.maskPrompt) &&
    shouldUseComfyUiClothingParserProtection(options);
  const useSubtractionProtection = protectionSettings.enabled;
  const clothingSegmentCategories = resolveComfyUiClothingSegmentCategories(options);
  const clothingSegmentSelection = createComfyUiClothingSegmentSelection(clothingSegmentCategories);
  const differentialDiffusionStrength = 1;
  const recolorTargetColor = parseComfyUiRecolorTargetColor(options.prompt);
  const maskedTintBlend = 0.28;
  const subtractClothingMask = useSubtractionProtection;
  const inpaintMode = inpaint ? normalizeComfyUiInpaintMode(options) : "normal";
  const inpaintPreset = inpaint ? inferComfyUiInpaintPreset(options) : "";
  const maskPromptIsHair = isComfyUiHairMaskPrompt(maskPrompt);
  const requestedExtendDirection = normalizeComfyUiExtendDirection(options.inpaintExtendDirection);
  const extendDirection =
    inpaintMode === "extend" && maskPromptIsHair && requestedExtendDirection === "all"
      ? "down"
      : requestedExtendDirection;
  const outpaintPixels = resolveComfyUiOutpaintPixels(options);
  const effectiveExtendPixels = outpaint ? outpaintPixels : inpaintSettings.extendPixels;
  const extendOffset = resolveComfyUiExtendOffset(extendDirection, effectiveExtendPixels);
  const outpaintLayout = outpaint
    ? buildComfyUiOutpaintLayout(options, dimensions.source, dimensions.output, extendDirection)
    : null;
  const outpaintStrategy = outpaintLayout?.strategy ?? "edge_extend";
  const preserveSubjectOnly = outpaint && COMFYUI_OUTPAINT_PRESERVE_SUBJECT_ONLY;
  const workflowOutpaintFactors = getComfyUiLayoutOutpaintFactors(
    outpaintLayout,
    dimensions.output,
    extendDirection,
    outpaint,
    outpaintPixels,
  );
  const videoDurationSeconds = resolveComfyUiVideoDurationSeconds(options.durationSeconds);
  const videoFps = resolveComfyUiVideoFps(options.fps);
  const videoOutputFps = resolveComfyUiVideoOutputFps(videoFps);
  const videoFrameCount = resolveComfyUiVideoFrameCount(videoDurationSeconds, videoOutputFps);
  const videoOutputDurationSeconds = videoFrameCount / videoOutputFps;
  const videoSteps = resolveComfyUiVideoSteps();
  const videoCfg = resolveComfyUiVideoCfg();
  const videoAudioSteps = resolveComfyUiVideoAudioSteps();
  const videoAudioCfg = resolveComfyUiVideoAudioCfg();
  const workflowPrompt = options.mode === "video" ? buildComfyUiVideoPrompt(options.prompt) : options.prompt;
  const workflowSourceWidth = outpaintLayout?.placedSourceWidth ?? dimensions.source.width;
  const workflowSourceHeight = outpaintLayout?.placedSourceHeight ?? dimensions.source.height;
  const outpaintSourceX = outpaintLayout?.placedSourceX ?? 0;
  const outpaintSourceY = outpaintLayout?.placedSourceY ?? 0;
  const outpaintPadLeft = outpaintLayout?.placedSourceX ?? 0;
  const outpaintPadTop = outpaintLayout?.placedSourceY ?? 0;
  const outpaintPadRight = outpaintLayout
    ? Math.max(0, dimensions.output.width - outpaintLayout.placedSourceX - outpaintLayout.placedSourceWidth)
    : 0;
  const outpaintPadBottom = outpaintLayout
    ? Math.max(0, dimensions.output.height - outpaintLayout.placedSourceY - outpaintLayout.placedSourceHeight)
    : 0;
  const largestOutpaintPad = Math.max(outpaintPadLeft, outpaintPadTop, outpaintPadRight, outpaintPadBottom);
  const outpaintPadFeather =
    largestOutpaintPad > 0 ? Math.min(resolveComfyUiOutpaintPadFeather(), largestOutpaintPad) : 0;
  const outpaintStageFeather = resolveComfyUiOutpaintStageFeather(largestOutpaintPad);
  const leftStageWidth = dimensions.source.width;
  const leftStageHeight = dimensions.source.height;
  const leftCropWidth = Math.max(1, leftStageWidth - outpaintPadLeft);
  const rightStageWidth = dimensions.source.width + outpaintPadLeft;
  const rightStageHeight = dimensions.source.height;
  const rightCropWidth = Math.max(1, rightStageWidth - outpaintPadRight);
  const topStageWidth = dimensions.source.width + outpaintPadLeft + outpaintPadRight;
  const topStageHeight = dimensions.source.height;
  const topCropHeight = Math.max(1, topStageHeight - outpaintPadTop);
  const bottomStageWidth = topStageWidth;
  const bottomStageHeight = dimensions.source.height + outpaintPadTop;
  const bottomCropHeight = Math.max(1, bottomStageHeight - outpaintPadBottom);
  const placeholderMap: Record<string, WorkflowPlaceholderValue> = {
    TOMORI_PROMPT: workflowPrompt,
    TOMORI_RAW_PROMPT: options.prompt,
    TOMORI_PROMPT_WITH_DEFAULTS: buildComfyUiPromptWithDefaults(
      promptOptions,
      inpaint,
      maskMode,
      invertInpaintMask,
      hasReference,
    ),
    TOMORI_NEGATIVE_PROMPT: buildComfyUiNegativePrompt(options, inpaint, maskMode),
    TOMORI_VIDEO_NEGATIVE_PROMPT: buildComfyUiVideoNegativePrompt(),
    TOMORI_MODEL: endpoint.model_name ?? "",
    TOMORI_MODEL_NAME: endpoint.model_name ?? "",
    TOMORI_MODE: options.mode,
    TOMORI_IMAGE_MODE: inpaint ? "inpaint" : hasReference ? "img2img" : "txt2img",
    TOMORI_ASPECT_RATIO: options.aspectRatio ?? (options.mode === "video" ? "16:9" : "1:1"),
    TOMORI_WIDTH: dimensions.output.width,
    TOMORI_HEIGHT: dimensions.output.height,
    TOMORI_SOURCE_WIDTH: workflowSourceWidth,
    TOMORI_SOURCE_HEIGHT: workflowSourceHeight,
    TOMORI_ORIGINAL_SOURCE_WIDTH: dimensions.source.width,
    TOMORI_ORIGINAL_SOURCE_HEIGHT: dimensions.source.height,
    TOMORI_OUTPUT_WIDTH: dimensions.output.width,
    TOMORI_OUTPUT_HEIGHT: dimensions.output.height,
    TOMORI_SIZE: `${dimensions.output.width}x${dimensions.output.height}`,
    TOMORI_SOURCE_SIZE: `${dimensions.source.width}x${dimensions.source.height}`,
    TOMORI_OUTPUT_SIZE: `${dimensions.output.width}x${dimensions.output.height}`,
    TOMORI_SEED: seed,
    TOMORI_HAS_REFERENCE_IMAGE: hasReference,
    TOMORI_REFERENCE_IMAGE_DATA_URL: referenceImageDataUrl ?? "",
    TOMORI_REFERENCE_IMAGE_BASE64:
      firstReferenceImage && typeof firstReferenceImage.data === "string" ? firstReferenceImage.data : "",
    TOMORI_REFERENCE_IMAGE_MIME_TYPE:
      firstReferenceImage && typeof firstReferenceImage.mimeType === "string" ? firstReferenceImage.mimeType : "",
    TOMORI_INPAINT: inpaint,
    TOMORI_INPAINT_MASK_MODE: maskMode,
    TOMORI_INPAINT_PRESET: inpaintPreset,
    TOMORI_INPAINT_INVERT_MASK: invertInpaintMask,
    TOMORI_INPAINT_MODE: inpaintMode,
    TOMORI_OUTPAINT: outpaint,
    TOMORI_OUTPAINT_STRATEGY: outpaintStrategy,
    TOMORI_OUTPAINT_FULL_CANVAS: outpaintStrategy === "full_canvas",
    TOMORI_OUTPAINT_EDGE_EXTEND: outpaintStrategy === "edge_extend",
    TOMORI_OUTPAINT_USE_CROP_STITCH: outpaintStrategy !== "full_canvas",
    TOMORI_OUTPAINT_ZOOM_OUT: outpaintStrategy === "zoom_out",
    TOMORI_OUTPAINT_AMOUNT: resolveComfyUiOutpaintAmount(options),
    TOMORI_OUTPAINT_SOURCE_SCALE: outpaintLayout?.sourceScale ?? 1,
    TOMORI_OUTPAINT_OVERLAP: outpaintLayout?.overlap ?? 0,
    TOMORI_OUTPAINT_DIRECTION: extendDirection,
    TOMORI_OUTPAINT_PIXELS: outpaintPixels,
    TOMORI_OUTPAINT_SOURCE_X: outpaintSourceX,
    TOMORI_OUTPAINT_SOURCE_Y: outpaintSourceY,
    TOMORI_OUTPAINT_PLACED_SOURCE_X: outpaintLayout?.placedSourceX ?? 0,
    TOMORI_OUTPAINT_PLACED_SOURCE_Y: outpaintLayout?.placedSourceY ?? 0,
    TOMORI_OUTPAINT_PLACED_SOURCE_WIDTH: outpaintLayout?.placedSourceWidth ?? dimensions.source.width,
    TOMORI_OUTPAINT_PLACED_SOURCE_HEIGHT: outpaintLayout?.placedSourceHeight ?? dimensions.source.height,
    TOMORI_OUTPAINT_PAD_LEFT: outpaintPadLeft,
    TOMORI_OUTPAINT_PAD_TOP: outpaintPadTop,
    TOMORI_OUTPAINT_PAD_RIGHT: outpaintPadRight,
    TOMORI_OUTPAINT_PAD_BOTTOM: outpaintPadBottom,
    TOMORI_OUTPAINT_PAD_FEATHER: outpaintPadFeather,
    TOMORI_OUTPAINT_STAGE_FEATHER: outpaintStageFeather,
    TOMORI_OUTPAINT_LEFT_CROP_WIDTH: leftCropWidth,
    TOMORI_OUTPAINT_LEFT_CROP_HEIGHT: leftStageHeight,
    TOMORI_OUTPAINT_RIGHT_CROP_WIDTH: rightCropWidth,
    TOMORI_OUTPAINT_RIGHT_CROP_HEIGHT: rightStageHeight,
    TOMORI_OUTPAINT_RIGHT_CROP_X: outpaintPadRight,
    TOMORI_OUTPAINT_TOP_CROP_WIDTH: topStageWidth,
    TOMORI_OUTPAINT_TOP_CROP_HEIGHT: topCropHeight,
    TOMORI_OUTPAINT_BOTTOM_CROP_WIDTH: bottomStageWidth,
    TOMORI_OUTPAINT_BOTTOM_CROP_HEIGHT: bottomCropHeight,
    TOMORI_OUTPAINT_BOTTOM_CROP_Y: outpaintPadBottom,
    TOMORI_OUTPAINT_BLEND_FEATHER: resolveComfyUiOutpaintBlendFeather(),
    TOMORI_OUTPAINT_CENTER_PRESERVE_FEATHER: resolveComfyUiOutpaintCenterPreserveFeather(),
    TOMORI_OUTPAINT_GUIDE_BLUR_RADIUS: resolveComfyUiOutpaintGuideBlurRadius(),
    TOMORI_OUTPAINT_GUIDE_BLUR_SIGMA: resolveComfyUiOutpaintGuideBlurSigma(),
    TOMORI_OUTPAINT_DENOISE: resolveComfyUiOutpaintDenoise(),
    TOMORI_OUTPAINT_CFG: resolveComfyUiOutpaintCfg(),
    TOMORI_OUTPAINT_STEPS: resolveComfyUiOutpaintSteps(),
    TOMORI_OUTPAINT_THINKING_STEPS: resolveComfyUiOutpaintThinkingSteps(),
    TOMORI_OUTPAINT_SAMPLER: resolveComfyUiOutpaintSampler(),
    TOMORI_OUTPAINT_HORIZONTAL_POSITIVE_PROMPT: buildComfyUiOutpaintStagePositivePrompt(options, "horizontal"),
    TOMORI_OUTPAINT_HORIZONTAL_NEGATIVE_PROMPT: buildComfyUiOutpaintStageNegativePrompt(options, "horizontal"),
    TOMORI_OUTPAINT_TOP_POSITIVE_PROMPT: buildComfyUiOutpaintStagePositivePrompt(options, "top"),
    TOMORI_OUTPAINT_TOP_NEGATIVE_PROMPT: buildComfyUiOutpaintStageNegativePrompt(options, "top"),
    TOMORI_OUTPAINT_BOTTOM_POSITIVE_PROMPT: buildComfyUiOutpaintStagePositivePrompt(options, "bottom"),
    TOMORI_OUTPAINT_BOTTOM_NEGATIVE_PROMPT: buildComfyUiOutpaintStageNegativePrompt(options, "bottom"),
    TOMORI_LANPAINT_STEPS: resolveComfyUiLanPaintSteps(),
    TOMORI_LANPAINT_NUM_STEPS: resolveComfyUiLanPaintNumSteps(),
    TOMORI_LANPAINT_SAMPLER: resolveComfyUiLanPaintSampler(),
    TOMORI_LANPAINT_PROMPT_MODE: resolveComfyUiLanPaintPromptMode(),
    TOMORI_LANPAINT_MASK_BLEND_OVERLAP: resolveComfyUiLanPaintMaskBlendOverlap(),
    TOMORI_LANPAINT_INPAINTING_MODE: "🖼️ Image Inpainting",
    TOMORI_OUTPAINT_MASK_SOURCE_X: outpaintLayout?.maskSourceX ?? 0,
    TOMORI_OUTPAINT_MASK_SOURCE_Y: outpaintLayout?.maskSourceY ?? 0,
    TOMORI_OUTPAINT_PROTECTED_SOURCE_X: outpaintLayout
      ? Math.max(0, outpaintLayout.maskSourceX - outpaintLayout.placedSourceX)
      : 0,
    TOMORI_OUTPAINT_PROTECTED_SOURCE_Y: outpaintLayout
      ? Math.max(0, outpaintLayout.maskSourceY - outpaintLayout.placedSourceY)
      : 0,
    TOMORI_OUTPAINT_MASK_SOURCE_WIDTH: outpaintLayout?.maskSourceWidth ?? dimensions.source.width,
    TOMORI_OUTPAINT_MASK_SOURCE_HEIGHT: outpaintLayout?.maskSourceHeight ?? dimensions.source.height,
    TOMORI_OUTPAINT_PRESERVE_SUBJECT_ONLY: preserveSubjectOnly,
    TOMORI_OUTPAINT_SUBJECT_MASK_GROW: COMFYUI_OUTPAINT_SUBJECT_MASK_GROW,
    TOMORI_OUTPAINT_SUBJECT_MASK_FEATHER: COMFYUI_OUTPAINT_SUBJECT_MASK_FEATHER,
    TOMORI_OUTPAINT_UNDERPAINT_COLOR: resolveComfyUiOutpaintUnderpaintColor(),
    TOMORI_OUTPAINT_EXTEND_UP_FACTOR: workflowOutpaintFactors.up,
    TOMORI_OUTPAINT_EXTEND_DOWN_FACTOR: workflowOutpaintFactors.down,
    TOMORI_OUTPAINT_EXTEND_LEFT_FACTOR: workflowOutpaintFactors.left,
    TOMORI_OUTPAINT_EXTEND_RIGHT_FACTOR: workflowOutpaintFactors.right,
    TOMORI_MASK_PROMPT: workflowMaskPrompt,
    TOMORI_INPAINT_MASK_CONTENT: inpaintMaskContent,
    TOMORI_INPAINT_USE_LATENT_NOISE_MASK_CONTENT: inpaintMaskContent === "latent_noise",
    TOMORI_INPAINT_USE_DIFFERENTIAL_DIFFUSION: useDifferentialDiffusion,
    TOMORI_INPAINT_DIFFERENTIAL_DIFFUSION_STRENGTH: differentialDiffusionStrength,
    TOMORI_INPAINT_USE_RMBG_BACKGROUND_MASK: useRmbgBackgroundMask,
    TOMORI_RMBG_MODEL: "RMBG-2.0",
    TOMORI_RMBG_SENSITIVITY: 1,
    TOMORI_RMBG_PROCESS_RES: 1024,
    TOMORI_RMBG_MASK_BLUR: 0,
    TOMORI_RMBG_MASK_OFFSET: 0,
    TOMORI_RMBG_REFINE_FOREGROUND: false,
    TOMORI_INPAINT_USE_CLOTHING_PARSER: useClothingParser,
    TOMORI_INPAINT_USE_CLOTHING_PARSER_TARGET: useClothingParserTarget,
    TOMORI_INPAINT_USE_CLOTHING_PARSER_HAIR_TARGET: useClothingParserHairTarget,
    TOMORI_INPAINT_USE_CLOTHING_PARSER_PROTECTION: useClothingParserProtection,
    TOMORI_INPAINT_CLOTHING_SEGMENT_CATEGORIES: clothingSegmentCategories.join(","),
    TOMORI_INPAINT_CLOTHING_SEGMENT_HAT: clothingSegmentSelection.Hat,
    TOMORI_INPAINT_CLOTHING_SEGMENT_HAIR: clothingSegmentSelection.Hair,
    TOMORI_INPAINT_CLOTHING_SEGMENT_FACE: clothingSegmentSelection.Face,
    TOMORI_INPAINT_CLOTHING_SEGMENT_SUNGLASSES: clothingSegmentSelection.Sunglasses,
    TOMORI_INPAINT_CLOTHING_SEGMENT_UPPER_CLOTHES: clothingSegmentSelection["Upper-clothes"],
    TOMORI_INPAINT_CLOTHING_SEGMENT_SKIRT: clothingSegmentSelection.Skirt,
    TOMORI_INPAINT_CLOTHING_SEGMENT_DRESS: clothingSegmentSelection.Dress,
    TOMORI_INPAINT_CLOTHING_SEGMENT_BELT: clothingSegmentSelection.Belt,
    TOMORI_INPAINT_CLOTHING_SEGMENT_PANTS: clothingSegmentSelection.Pants,
    TOMORI_INPAINT_CLOTHING_SEGMENT_LEFT_ARM: clothingSegmentSelection["Left-arm"],
    TOMORI_INPAINT_CLOTHING_SEGMENT_RIGHT_ARM: clothingSegmentSelection["Right-arm"],
    TOMORI_INPAINT_CLOTHING_SEGMENT_LEFT_LEG: clothingSegmentSelection["Left-leg"],
    TOMORI_INPAINT_CLOTHING_SEGMENT_RIGHT_LEG: clothingSegmentSelection["Right-leg"],
    TOMORI_INPAINT_CLOTHING_SEGMENT_BAG: clothingSegmentSelection.Bag,
    TOMORI_INPAINT_CLOTHING_SEGMENT_SCARF: clothingSegmentSelection.Scarf,
    TOMORI_INPAINT_CLOTHING_SEGMENT_LEFT_SHOE: clothingSegmentSelection["Left-shoe"],
    TOMORI_INPAINT_CLOTHING_SEGMENT_RIGHT_SHOE: clothingSegmentSelection["Right-shoe"],
    TOMORI_INPAINT_CLOTHING_SEGMENT_BACKGROUND: clothingSegmentSelection.Background,
    TOMORI_INPAINT_USE_MASKED_TINT_REFERENCE: maskedTintReference,
    TOMORI_RECOLOR_TARGET_COLOR: recolorTargetColor ? rgbToComfyUiColor(recolorTargetColor) : 0,
    TOMORI_RECOLOR_TARGET_R: recolorTargetColor?.r ?? 0,
    TOMORI_RECOLOR_TARGET_G: recolorTargetColor?.g ?? 0,
    TOMORI_RECOLOR_TARGET_B: recolorTargetColor?.b ?? 0,
    TOMORI_INPAINT_MASKED_TINT_BLEND: maskedTintBlend,
    TOMORI_INPAINT_SUBTRACT_FACE_MASK: useSubtractionProtection,
    TOMORI_INPAINT_PROTECT_MASK_PROMPT: protectionSettings.maskPrompt,
    TOMORI_INPAINT_FACE_MASK_PROMPT: protectionSettings.maskPrompt,
    TOMORI_INPAINT_FACE_MASK_THRESHOLD: protectionSettings.maskThreshold,
    TOMORI_INPAINT_FACE_MASK_GROW: protectionSettings.maskGrow,
    TOMORI_INPAINT_FACE_MASK_FEATHER: protectionSettings.maskFeather,
    TOMORI_INPAINT_SUBTRACT_CLOTHING_MASK: subtractClothingMask,
    TOMORI_INPAINT_CLOTHING_MASK_PROMPT: protectionSettings.clothingMaskPrompt,
    TOMORI_INPAINT_CLOTHING_MASK_THRESHOLD: protectionSettings.clothingMaskThreshold,
    TOMORI_INPAINT_CLOTHING_MASK_GROW: protectionSettings.clothingMaskGrow,
    TOMORI_INPAINT_CLOTHING_MASK_FEATHER: protectionSettings.clothingMaskFeather,
    TOMORI_INPAINT_SUBTRACT_ARMS_MASK: useSubtractionProtection,
    TOMORI_INPAINT_ARMS_MASK_PROMPT: protectionSettings.armsMaskPrompt,
    TOMORI_INPAINT_ARMS_MASK_THRESHOLD: protectionSettings.armsMaskThreshold,
    TOMORI_INPAINT_ARMS_MASK_GROW: protectionSettings.armsMaskGrow,
    TOMORI_INPAINT_ARMS_MASK_FEATHER: protectionSettings.armsMaskFeather,
    TOMORI_INPAINT_SUBTRACT_NECK_MASK: useSubtractionProtection,
    TOMORI_INPAINT_NECK_MASK_PROMPT: protectionSettings.neckMaskPrompt,
    TOMORI_INPAINT_NECK_MASK_THRESHOLD: protectionSettings.neckMaskThreshold,
    TOMORI_INPAINT_NECK_MASK_GROW: protectionSettings.neckMaskGrow,
    TOMORI_INPAINT_NECK_MASK_FEATHER: protectionSettings.neckMaskFeather,
    TOMORI_INPAINT_SUBTRACT_SKIN_MASK: useSubtractionProtection,
    TOMORI_INPAINT_SKIN_MASK_PROMPT: protectionSettings.skinMaskPrompt,
    TOMORI_INPAINT_SKIN_MASK_THRESHOLD: protectionSettings.skinMaskThreshold,
    TOMORI_INPAINT_SKIN_MASK_GROW: protectionSettings.skinMaskGrow,
    TOMORI_INPAINT_SKIN_MASK_FEATHER: protectionSettings.skinMaskFeather,
    TOMORI_INPAINT_SUBTRACT_LEGS_MASK: false,
    TOMORI_INPAINT_LEGS_MASK_PROMPT: protectionSettings.legsMaskPrompt,
    TOMORI_INPAINT_LEGS_MASK_THRESHOLD: protectionSettings.legsMaskThreshold,
    TOMORI_INPAINT_LEGS_MASK_GROW: protectionSettings.legsMaskGrow,
    TOMORI_INPAINT_LEGS_MASK_FEATHER: protectionSettings.legsMaskFeather,
    TOMORI_INPAINT_SUBTRACT_FEET_MASK: false,
    TOMORI_INPAINT_FEET_MASK_PROMPT: protectionSettings.feetMaskPrompt,
    TOMORI_INPAINT_FEET_MASK_THRESHOLD: protectionSettings.feetMaskThreshold,
    TOMORI_INPAINT_FEET_MASK_GROW: protectionSettings.feetMaskGrow,
    TOMORI_INPAINT_FEET_MASK_FEATHER: protectionSettings.feetMaskFeather,
    TOMORI_INPAINT_SUBTRACT_BODY_MASK: subtractClothingMask,
    TOMORI_INPAINT_BODY_MASK_PROMPT: protectionSettings.clothingMaskPrompt,
    TOMORI_INPAINT_BODY_MASK_THRESHOLD: protectionSettings.clothingMaskThreshold,
    TOMORI_INPAINT_BODY_MASK_GROW: protectionSettings.clothingMaskGrow,
    TOMORI_INPAINT_BODY_MASK_FEATHER: protectionSettings.clothingMaskFeather,
    TOMORI_FLORENCE2_MODEL: resolveComfyUiFlorence2Model(),
    TOMORI_FLORENCE2_PRECISION: resolveComfyUiFlorence2Precision(),
    TOMORI_FLORENCE2_ATTENTION: resolveComfyUiFlorence2Attention(),
    TOMORI_FLORENCE2_KEEP_MODEL_LOADED: shouldKeepComfyUiFlorence2ModelLoaded(),
    TOMORI_INPAINT_MASK_THRESHOLD: inpaintSettings.maskThreshold,
    TOMORI_INPAINT_MASK_GROW: inpaintSettings.maskGrow,
    TOMORI_INPAINT_MASK_FEATHER: inpaintSettings.maskFeather,
    TOMORI_INPAINT_EXTEND_DIRECTION: extendDirection,
    TOMORI_INPAINT_EXTEND_PIXELS: effectiveExtendPixels,
    TOMORI_INPAINT_EXTEND_X: extendOffset.x,
    TOMORI_INPAINT_EXTEND_Y: extendOffset.y,
    TOMORI_INPAINT_EXTEND_GROW: inpaintSettings.extendGrow,
    TOMORI_INPAINT_EXTEND_FEATHER: inpaintSettings.extendFeather,
    TOMORI_INPAINT_EXTEND_PADDING: inpaintSettings.extendPadding,
    TOMORI_CFG: inpaint ? inpaintSettings.cfg : 0,
    TOMORI_INPAINT_CFG: inpaintSettings.cfg,
    TOMORI_DENOISE: denoise,
    TOMORI_IMG2IMG_DENOISE: denoise,
    TOMORI_INPAINT_DENOISE: denoise,
    TOMORI_INPAINT_MASK_FILENAME_PREFIX: COMFYUI_INPAINT_MASK_FILENAME_PREFIX,
    TOMORI_INPAINT_RESULT_DEBUG_FILENAME_PREFIX: COMFYUI_INPAINT_RESULT_DEBUG_FILENAME_PREFIX,
    TOMORI_REFERENCE_IMAGE_COUNT: referencePayload.length,
    TOMORI_REFERENCE_IMAGES: referencePayload,
    TOMORI_REFERENCE_IMAGES_JSON: JSON.stringify(referencePayload),
    TOMORI_VIDEO_DURATION: videoDurationSeconds,
    TOMORI_DURATION_SECONDS: videoDurationSeconds,
    TOMORI_VIDEO_OUTPUT_DURATION: videoOutputDurationSeconds,
    TOMORI_OUTPUT_DURATION: videoOutputDurationSeconds,
    TOMORI_VIDEO_RESOLUTION: options.resolution ?? "",
    TOMORI_RESOLUTION: options.resolution ?? "",
    TOMORI_VIDEO_FPS: videoFps,
    TOMORI_FPS: videoFps,
    TOMORI_VIDEO_OUTPUT_FPS: videoOutputFps,
    TOMORI_OUTPUT_FPS: videoOutputFps,
    TOMORI_VIDEO_FRAME_COUNT: videoFrameCount,
    TOMORI_FRAME_COUNT: videoFrameCount,
    TOMORI_VIDEO_STEPS: videoSteps,
    TOMORI_STEPS: videoSteps,
    TOMORI_VIDEO_CFG: videoCfg,
    TOMORI_GENERATE_AUDIO: options.generateAudio ?? false,
    TOMORI_VIDEO_AUDIO_PROMPT: buildComfyUiVideoAudioPrompt(options.prompt, options.audioPrompt),
    TOMORI_AUDIO_PROMPT: buildComfyUiVideoAudioPrompt(options.prompt, options.audioPrompt),
    TOMORI_VIDEO_AUDIO_NEGATIVE_PROMPT: buildComfyUiVideoAudioNegativePrompt(),
    TOMORI_AUDIO_NEGATIVE_PROMPT: buildComfyUiVideoAudioNegativePrompt(),
    TOMORI_VIDEO_AUDIO_STEPS: videoAudioSteps,
    TOMORI_AUDIO_STEPS: videoAudioSteps,
    TOMORI_VIDEO_AUDIO_CFG: videoAudioCfg,
    TOMORI_AUDIO_CFG: videoAudioCfg,
    TOMORI_VIDEO_LOOP: options.loop === true,
    TOMORI_LOOP_VIDEO: options.loop === true,
  };

  placeholderMap.TOMORI_REFERENCE_IMAGE_1_DATA_URL = placeholderMap.TOMORI_REFERENCE_IMAGE_DATA_URL;
  placeholderMap.TOMORI_REFERENCE_IMAGE_1_BASE64 = placeholderMap.TOMORI_REFERENCE_IMAGE_BASE64;
  placeholderMap.TOMORI_REFERENCE_IMAGE_1_MIME_TYPE = placeholderMap.TOMORI_REFERENCE_IMAGE_MIME_TYPE;
  placeholderMap.TOMORI_REFERENCE_IMAGE_FILENAME = "";
  placeholderMap.TOMORI_REFERENCE_IMAGE_1_FILENAME = "";
  placeholderMap.TOMORI_REFERENCE_IMAGE_1_SUBFOLDER = "";
  placeholderMap.TOMORI_REFERENCE_IMAGE_1_TYPE = "";

  for (const referenceImage of referencePayload) {
    const index = referenceImage.index as number;
    placeholderMap[`TOMORI_REFERENCE_IMAGE_${index}`] = referenceImage;
    placeholderMap[`TOMORI_REFERENCE_IMAGE_${index}_DATA_URL`] = referenceImage.dataUrl as string;
    placeholderMap[`TOMORI_REFERENCE_IMAGE_${index}_BASE64`] = referenceImage.data as string;
    placeholderMap[`TOMORI_REFERENCE_IMAGE_${index}_MIME_TYPE`] = referenceImage.mimeType as string;
    if (typeof referenceImage.url === "string") {
      placeholderMap[`TOMORI_REFERENCE_IMAGE_${index}_URL`] = referenceImage.url;
    }
    if (typeof referenceImage.filename === "string") {
      placeholderMap[`TOMORI_REFERENCE_IMAGE_${index}_FILENAME`] = referenceImage.filename;
      if (index === 1) {
        placeholderMap.TOMORI_REFERENCE_IMAGE_FILENAME = referenceImage.filename;
      }
    }
    if (typeof referenceImage.subfolder === "string") {
      placeholderMap[`TOMORI_REFERENCE_IMAGE_${index}_SUBFOLDER`] = referenceImage.subfolder;
    }
    if (typeof referenceImage.type === "string") {
      placeholderMap[`TOMORI_REFERENCE_IMAGE_${index}_TYPE`] = referenceImage.type;
    }
  }

  return placeholderMap;
}

function applyComfyUiVideoLoopDefaults(workflow: ComfyUiWorkflow, options: ComfyUiGenerationOptions): number {
  if (options.mode !== "video" || options.loop === true) {
    return 0;
  }

  let updated = 0;
  for (const node of Object.values(workflow)) {
    if (!isRecord(node) || typeof node.class_type !== "string" || !isRecord(node.inputs)) {
      continue;
    }

    if (node.class_type !== "WanFirstLastFrameToVideo") {
      continue;
    }

    node.class_type = "WanImageToVideo";
    updated += 1;
    if ("end_image" in node.inputs) {
      delete node.inputs.end_image;
    }
    delete node.inputs.clip_vision_start_image;
    if ("clip_vision_end_image" in node.inputs) {
      delete node.inputs.clip_vision_end_image;
    }
  }

  return updated;
}

function applyComfyUiVideoAudioDefaults(workflow: ComfyUiWorkflow, options: ComfyUiGenerationOptions): number {
  if (options.mode !== "video" || options.generateAudio === true) {
    return 0;
  }

  let updated = 0;
  for (const node of Object.values(workflow)) {
    if (!isRecord(node) || typeof node.class_type !== "string" || !isRecord(node.inputs)) {
      continue;
    }

    if ("audio" in node.inputs) {
      delete node.inputs.audio;
      updated += 1;
    }
  }

  return updated;
}

function inferComfyUiAssetMediaKind(filename: string, fallback?: ComfyUiMediaKind): ComfyUiMediaKind {
  const normalized = filename.toLowerCase();
  if (/\.(gif)$/.test(normalized)) {
    return "gif";
  }
  if (/\.(mp4|webm|mov|mkv)$/.test(normalized)) {
    return "video";
  }
  if (/\.(png|jpe?g|webp|bmp)$/.test(normalized)) {
    return "image";
  }
  return fallback ?? "image";
}

function normalizeComfyUiAsset(value: unknown, fallback?: ComfyUiMediaKind): ComfyUiAsset | null {
  if (!isRecord(value) || typeof value.filename !== "string" || value.filename.trim() === "") {
    return null;
  }

  return {
    filename: value.filename,
    ...(typeof value.subfolder === "string" ? { subfolder: value.subfolder } : {}),
    ...(typeof value.type === "string" ? { type: value.type } : {}),
    mediaKind: inferComfyUiAssetMediaKind(value.filename, fallback),
  };
}

function collectComfyUiAssetsFromValue(value: unknown, fallback?: ComfyUiMediaKind, depth = 0): ComfyUiAsset[] {
  if (depth > 6) {
    return [];
  }

  const directAsset = normalizeComfyUiAsset(value, fallback);
  if (directAsset) {
    return [directAsset];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectComfyUiAssetsFromValue(item, fallback, depth + 1));
  }

  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([key, childValue]) => {
    const childFallback =
      key === "videos" || key === "video"
        ? "video"
        : key === "gifs" || key === "gif"
          ? "gif"
          : key === "images" || key === "image"
            ? "image"
            : fallback;
    return collectComfyUiAssetsFromValue(childValue, childFallback, depth + 1);
  });
}

function collectComfyUiHistoryFiles(outputs: Record<string, unknown> | undefined): ComfyUiAsset[] {
  if (!outputs) {
    return [];
  }

  return Object.values(outputs).flatMap((output) => collectComfyUiAssetsFromValue(output));
}

function describeComfyUiHistoryOutputs(outputs: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!outputs) {
    return { nodeCount: 0 };
  }

  return {
    nodeCount: Object.keys(outputs).length,
    nodes: Object.entries(outputs).map(([nodeId, output]) => ({
      nodeId,
      keys: isRecord(output) ? Object.keys(output) : [],
      files: collectComfyUiAssetsFromValue(output).map((file) => ({
        filename: file.filename,
        subfolder: file.subfolder ?? null,
        type: file.type ?? null,
        mediaKind: file.mediaKind ?? null,
      })),
    })),
  };
}

async function generateWithComfyUi(
  endpoint: CustomEndpointRow,
  apiKey: string,
  options: ComfyUiGenerationOptions,
): Promise<ComfyUiGenerationResponse> {
  const workflowPath = resolveComfyUiRuntimeWorkflowPath(endpoint);
  // A workflow uploaded with the endpoint is its configuration of record. Static paths remain
  // available for legacy endpoints that have no uploaded workflow.
  const savedWorkflow =
    endpoint.extra_config.workflow ?? (workflowPath ? loadComfyUiWorkflowFromPath(workflowPath) : null);
  if (!savedWorkflow || typeof savedWorkflow !== "object") {
    throw new Error("ComfyUI workflow JSON is missing.");
  }

  const seed = options.seed ?? generateComfyUiSeed();
  const sanitizedPrompt = stripComfyUiNegativeInpaintClauses(
    stripComfyUiHairRecolorPreservationClauses(options.prompt, options.maskPrompt),
  );
  const strengthenedPrompt = strengthenComfyUiHairRecolorPrompt(sanitizedPrompt || options.prompt, options.maskPrompt);
  const generationOptions = normalizeComfyUiVideoOptions({ ...options, prompt: strengthenedPrompt, seed });
  const uploadedReferenceImages = await uploadComfyUiReferenceImages(
    endpoint,
    apiKey,
    generationOptions.referenceImages ?? [],
  );
  if (generationOptions.mode === "video") {
    const firstUploadedReference = uploadedReferenceImages[0];
    if (!firstUploadedReference?.comfyUiFilename) {
      throw new Error("ComfyUI image-to-video requires an uploaded reference image.");
    }
  }
  generationOptions.referenceImages = uploadedReferenceImages;
  const sourceDimensions = buildComfyUiDimensions(generationOptions);
  const outpaint =
    generationOptions.mode === "image" &&
    generationOptions.inpaint === true &&
    !!buildReferenceImageDataUrl(generationOptions) &&
    isComfyUiOutpaint(generationOptions);
  const outpaintStrategy = outpaint ? resolveComfyUiOutpaintStrategy(generationOptions) : "edge_extend";
  const outpaintDirection = normalizeComfyUiExtendDirection(generationOptions.inpaintExtendDirection);
  const outpaintPixels = resolveComfyUiOutpaintPixels(generationOptions);
  const dimensions = {
    source: sourceDimensions,
    output: outpaint
      ? buildComfyUiOutpaintDimensions(generationOptions, sourceDimensions, outpaintDirection, outpaintPixels)
      : sourceDimensions,
  };
  const referencePayload = buildComfyUiReferencePayload(uploadedReferenceImages);
  const placeholders = buildComfyUiPlaceholderMap(endpoint, generationOptions, dimensions, referencePayload);
  const workflowSupports = readComfyUiWorkflowSupports(endpoint);
  const workflow = deepCloneWorkflow(savedWorkflow as Record<string, unknown>);
  if (hasComfyUiVisualWorkflowShape(workflow)) {
    throw new Error("ComfyUI workflow must be exported in API prompt format, not visual workflow format.");
  }
  if (generationOptions.mode === "image") {
    assertComfyUiWorkflowSupportsRequest(generationOptions, workflowSupports);
  }
  if (outpaint && outpaintStrategy === "full_canvas") {
    assertComfyUiFullCanvasOutpaintWorkflow(workflow);
  }

  const preparedWorkflow = replaceWorkflowPlaceholders(workflow, placeholders) as ComfyUiWorkflow;
  const videoLoopRewrites = applyComfyUiVideoLoopDefaults(preparedWorkflow, generationOptions);
  const videoAudioRewrites = applyComfyUiVideoAudioDefaults(preparedWorkflow, generationOptions);
  const constantConditionalRewrites = foldConstantComfyUiConditionals(preparedWorkflow);
  const prunedOutpaintDiagnosticSaves = outpaint ? pruneComfyUiOutpaintDiagnosticSaveNodes(preparedWorkflow) : 0;
  const prunedUnreachableNodes = pruneUnreachableComfyUiNodes(preparedWorkflow);
  if (outpaint && outpaintStrategy !== "full_canvas" && !hasActiveComfyUiOutpaintNode(preparedWorkflow)) {
    throw new Error(
      [
        "This ComfyUI workflow does not have active outpainting support.",
        "Update the stored endpoint workflow to the latest tomoribot-anima3-comfyui.json.",
        "The active workflow must expose InpaintCropImproved extend_for_outpainting with the TOMORI_OUTPAINT placeholders, or use TOMORI_OUTPAINT_FULL_CANVAS for full-canvas outpainting.",
      ].join(" "),
    );
  }
  const defaultsApplied =
    generationOptions.mode === "image" ? applyComfyUiImageInputDefaults(preparedWorkflow, generationOptions) : 0;
  if (generationOptions.mode === "image") {
    const referenceImageDataUrl = buildReferenceImageDataUrl(generationOptions);
    const hasReference = !!referenceImageDataUrl;
    const inpaint = hasReference && generationOptions.inpaint === true;
    const inpaintSettings = resolveComfyUiInpaintSettings(generationOptions);
    const maskMode = inpaint ? normalizeComfyUiMaskMode(generationOptions.inpaintMaskMode) : "target";
    const denoise = resolveComfyUiEffectiveDenoise(generationOptions, inpaint, maskMode);
    log.info(
      `Prepared ComfyUI image generation payload ${JSON.stringify({
        workflowPath: workflowPath ?? null,
        hasReference,
        inpaint,
        maskPrompt: generationOptions.maskPrompt?.trim() ?? null,
        seed,
        denoise,
        maskMode,
        inpaintMode: normalizeComfyUiInpaintMode(generationOptions),
        outpaint,
        outpaintStrategy: outpaint ? outpaintStrategy : null,
        requestedOutpaintStrategy: generationOptions.outpaintStrategy ?? null,
        outpaintDirection: outpaint ? placeholders.TOMORI_OUTPAINT_DIRECTION : null,
        maskThreshold: inpaintSettings.maskThreshold,
        maskGrow: inpaintSettings.maskGrow,
        maskFeather: inpaintSettings.maskFeather,
        cfg: inpaintSettings.cfg,
        referenceDenoise: denoise,
        defaultsApplied,
        constantConditionalRewrites,
        prunedOutpaintDiagnosticSaves,
        prunedUnreachableNodes,
      })}`,
    );
  } else if (generationOptions.mode === "video") {
    log.info(
      `Prepared ComfyUI video generation payload ${JSON.stringify({
        workflowPath: workflowPath ?? null,
        hasReference: uploadedReferenceImages.length > 0,
        referenceFilename: uploadedReferenceImages[0]?.comfyUiFilename ?? null,
        seed,
        durationSeconds: generationOptions.durationSeconds,
        resolution: generationOptions.resolution,
        width: dimensions.output.width,
        height: dimensions.output.height,
        referenceWidth: uploadedReferenceImages[0]?.width ?? null,
        referenceHeight: uploadedReferenceImages[0]?.height ?? null,
        fps: placeholders.TOMORI_VIDEO_FPS,
        outputFps: placeholders.TOMORI_VIDEO_OUTPUT_FPS,
        outputDurationSeconds: placeholders.TOMORI_VIDEO_OUTPUT_DURATION,
        generateAudio: generationOptions.generateAudio === true,
        loop: generationOptions.loop === true,
        videoLoopRewrites,
        videoAudioRewrites,
        constantConditionalRewrites,
        prunedUnreachableNodes,
      })}`,
    );
  }

  const postHeaders = buildCustomHeaders(apiKey);
  const getHeaders = { ...postHeaders };
  delete getHeaders["Content-Type"];
  const clientId = `tomoribot-${Date.now()}`;

  const promptResponse = await fetchUserRemoteUrl(`${endpoint.endpoint_url.replace(/\/+$/, "")}/prompt`, {
    method: "POST",
    headers: postHeaders,
    body: JSON.stringify({
      prompt: preparedWorkflow,
      client_id: clientId,
    }),
  });

  if (!promptResponse.ok) {
    const errorBody = await promptResponse.text().catch(() => "");
    const errorDetail = errorBody.trim() ? `: ${errorBody.trim().slice(0, 2000)}` : "";
    throw new Error(`ComfyUI prompt failed: ${promptResponse.status} ${promptResponse.statusText}${errorDetail}`);
  }

  const promptPayload = (await promptResponse.json()) as { prompt_id?: string };
  if (!promptPayload.prompt_id) {
    throw new Error("ComfyUI did not return a prompt_id.");
  }

  log.info(
    `ComfyUI prompt accepted ${JSON.stringify({
      promptId: promptPayload.prompt_id,
      mode: generationOptions.mode,
    })}`,
  );

  const timeoutAt = Date.now() + getComfyUiTimeoutMs();
  let loggedHistoryWithoutFinal = false;
  while (Date.now() < timeoutAt) {
    const historyResponse = await fetchUserRemoteUrl(
      `${endpoint.endpoint_url.replace(/\/+$/, "")}/history/${encodeURIComponent(promptPayload.prompt_id)}`,
      { headers: getHeaders },
    );

    if (historyResponse.ok) {
      const historyPayload = (await historyResponse.json()) as Record<
        string,
        {
          outputs?: Record<
            string,
            {
              images?: Array<{ filename: string; subfolder?: string; type?: string }>;
              gifs?: Array<{ filename: string; subfolder?: string; type?: string }>;
              videos?: Array<{ filename: string; subfolder?: string; type?: string }>;
            }
          >;
          status?: {
            completed?: boolean;
            status_str?: string;
          };
        }
      >;

      const directHistoryItem = isRecord(historyPayload.outputs) ? historyPayload : null;
      const historyItem = historyPayload[promptPayload.prompt_id] ?? directHistoryItem;
      const outputs = isRecord(historyItem?.outputs) ? historyItem.outputs : undefined;
      const files = collectComfyUiHistoryFiles(outputs);
      const finalFiles =
        generationOptions.mode === "image"
          ? files.filter((file) => !isComfyUiDiagnosticAsset(file))
          : files.filter((file) => file.mediaKind === "video" || file.mediaKind === "gif");
      if (finalFiles.length > 0) {
        return { files: generationOptions.mode === "video" ? finalFiles : files, seed };
      }
      if (historyItem && !loggedHistoryWithoutFinal) {
        loggedHistoryWithoutFinal = true;
        log.warn(
          `ComfyUI history had no final ${generationOptions.mode} files yet ${JSON.stringify({
            promptId: promptPayload.prompt_id,
            status: historyItem.status ?? null,
            outputs: describeComfyUiHistoryOutputs(outputs),
          })}`,
        );
      }
      if (generationOptions.mode === "video" && historyItem?.status?.completed === true) {
        throw new Error(
          `ComfyUI completed video prompt without returning a video file. Outputs: ${JSON.stringify(
            describeComfyUiHistoryOutputs(outputs),
          ).slice(0, 2000)}`,
        );
      }
    }

    await Bun.sleep(1500);
  }

  throw new Error("ComfyUI generation timed out.");
}

async function downloadComfyUiAsset(endpoint: CustomEndpointRow, apiKey: string, asset: ComfyUiAsset): Promise<Buffer> {
  const url = new URL(`${endpoint.endpoint_url.replace(/\/+$/, "")}/view`);
  url.searchParams.set("filename", asset.filename);
  if (asset.subfolder) {
    url.searchParams.set("subfolder", asset.subfolder);
  }
  if (asset.type) {
    url.searchParams.set("type", asset.type);
  }

  const headers = { ...buildCustomHeaders(apiKey) };
  delete headers["Content-Type"];

  const response = await fetchUserRemoteUrl(url.toString(), { headers });
  if (!response.ok) {
    throw new Error(`ComfyUI asset download failed: ${response.status} ${response.statusText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function inferComfyUiVideoMimeType(asset: ComfyUiAsset, buffer: Buffer): string {
  const filename = asset.filename.toLowerCase();
  if (filename.endsWith(".gif") || buffer.subarray(0, 3).toString("ascii") === "GIF") {
    return "image/gif";
  }
  if (filename.endsWith(".webm")) {
    return "video/webm";
  }
  if (filename.endsWith(".mov")) {
    return "video/quicktime";
  }
  return "video/mp4";
}

function buildComfyUiVideoDownloadFilename(asset: ComfyUiAsset, mimeType: string): string {
  const sourceFilename = asset.filename.split(/[\\/]/).pop()?.trim();
  if (sourceFilename && /\.[a-z0-9]{2,5}$/i.test(sourceFilename)) {
    return sourceFilename;
  }

  const extension = mimeType === "image/gif" ? "gif" : mimeType === "video/webm" ? "webm" : "mp4";
  return `generated_${Date.now()}.${extension}`;
}

function describeVideoBufferSignature(buffer: Buffer): string {
  if (buffer.length === 0) {
    return "empty";
  }
  if (buffer.subarray(0, 3).toString("ascii") === "GIF") {
    return "gif";
  }
  if (buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    return `mp4:${buffer.subarray(8, 12).toString("ascii")}`;
  }
  if (buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return "webm";
  }
  return `unknown:${buffer.subarray(0, 16).toString("hex")}`;
}

export async function generateComfyUiImageViaEndpoint(params: {
  endpoint: CustomEndpointRow;
  apiKey: string;
  prompt: string;
  negativePrompt?: string | null;
  aspectRatio: string;
  referenceImages?: ProviderNativeImageGenerationRequest["referenceImages"];
  referenceImageDataUrl?: string | null;
  inpaint?: boolean;
  maskPrompt?: string | null;
  maskThreshold?: number | null;
  maskGrow?: number | null;
  maskFeather?: number | null;
  cfg?: number | null;
  denoise?: number | null;
  seed?: number | null;
  inpaintMaskMode?: string | null;
  inpaintMode?: string | null;
  inpaintPreset?: string | null;
  outpaint?: boolean | null;
  outpaintStrategy?: string | null;
  outpaintAmount?: string | null;
  outpaintOverlap?: number | null;
  outpaintZoomScale?: number | null;
  outpaintLeftPrompt?: string | null;
  outpaintRightPrompt?: string | null;
  outpaintTopPrompt?: string | null;
  outpaintBottomPrompt?: string | null;
  inpaintExtendDirection?: string | null;
  inpaintExtendPixels?: number | null;
  inpaintExtendGrow?: number | null;
  inpaintExtendFeather?: number | null;
  inpaintExtendPadding?: number | null;
  clothingMode?: boolean | null;
  clothingSegmentCategories?: string[] | null;
}): Promise<ProviderNativeImageGenerationResult> {
  const {
    endpoint,
    apiKey,
    prompt,
    negativePrompt,
    aspectRatio,
    referenceImages,
    referenceImageDataUrl,
    inpaint,
    maskPrompt,
    maskThreshold,
    maskGrow,
    maskFeather,
    cfg,
    denoise,
    seed,
    inpaintMaskMode,
    inpaintMode,
    inpaintPreset,
    outpaint,
    outpaintStrategy,
    outpaintAmount,
    outpaintOverlap,
    outpaintZoomScale,
    outpaintLeftPrompt,
    outpaintRightPrompt,
    outpaintTopPrompt,
    outpaintBottomPrompt,
    inpaintExtendDirection,
    inpaintExtendPixels,
    inpaintExtendGrow,
    inpaintExtendFeather,
    inpaintExtendPadding,
    clothingMode,
    clothingSegmentCategories,
  } = params;

  const imageGenerationOptions = {
    mode: "image",
    prompt,
    negativePrompt,
    aspectRatio,
    referenceImages,
    referenceImageDataUrl,
    inpaint,
    maskPrompt,
    maskThreshold,
    maskGrow,
    maskFeather,
    cfg,
    denoise,
    seed,
    inpaintMaskMode,
    inpaintMode,
    inpaintPreset,
    outpaint,
    outpaintStrategy,
    outpaintAmount,
    outpaintOverlap,
    outpaintZoomScale,
    outpaintLeftPrompt,
    outpaintRightPrompt,
    outpaintTopPrompt,
    outpaintBottomPrompt,
    inpaintExtendDirection,
    inpaintExtendPixels,
    inpaintExtendGrow,
    inpaintExtendFeather,
    inpaintExtendPadding,
    clothingMode,
    clothingSegmentCategories,
  } satisfies ComfyUiGenerationOptions;
  let comfyUiResult: ComfyUiGenerationResponse;
  try {
    comfyUiResult = await generateWithComfyUi(endpoint, apiKey, imageGenerationOptions);
  } catch (error) {
    const canRetryWithoutParser =
      inpaint === true &&
      shouldUseComfyUiClothingParser(imageGenerationOptions) &&
      error instanceof Error &&
      /timed out/i.test(error.message);
    if (!canRetryWithoutParser) {
      throw error;
    }

    const isClothingMaskRequest = shouldUseComfyUiClothingParserTarget(imageGenerationOptions);
    const retryOptions = isClothingMaskRequest
      ? {
          ...imageGenerationOptions,
          disableClothingParser: true,
          clothingMode: false,
          maskPrompt: "clothing",
          maskThreshold: 0.34,
          maskGrow: 8,
          maskFeather: 4,
        }
      : {
          ...imageGenerationOptions,
          disableClothingParser: true,
        };

    log.warn(
      `ComfyUI run timed out with clothing parser enabled; retrying once with clothing parser disabled${
        isClothingMaskRequest ? " and broadened clothing mask settings" : ""
      }.`,
    );
    comfyUiResult = await generateWithComfyUi(endpoint, apiKey, retryOptions);
  }

  const { files, seed: comfyUiSeed } = comfyUiResult;
  const includeDiagnostics = inpaint === true && !isComfyUiOutpaint(imageGenerationOptions);
  let diagnosticFiles = includeDiagnostics ? files.filter(isComfyUiDiagnosticAsset) : [];
  const imageFiles = files.filter((file) => !isComfyUiDiagnosticAsset(file));
  const firstFile = imageFiles[0];
  if (!firstFile) {
    const outputList = describeComfyUiAssets(files);
    throw new Error(
      `ComfyUI workflow returned only diagnostic image outputs and no final image output.${
        outputList ? ` Returned files: ${outputList}` : ""
      }`,
    );
  }
  const imageBuffer = await downloadComfyUiAsset(endpoint, apiKey, firstFile);
  const usedTintReference = shouldUseComfyUiMaskedTintReference(imageGenerationOptions);
  const diagnosticOptions = {
    mode: "image" as const,
    prompt,
    aspectRatio,
    referenceImages,
    referenceImageDataUrl,
    inpaint,
    maskPrompt,
    seed,
    inpaintMaskMode,
    inpaintMode,
    inpaintPreset,
    outpaint,
    outpaintStrategy,
    outpaintAmount,
    outpaintOverlap,
    outpaintZoomScale,
    outpaintLeftPrompt,
    outpaintRightPrompt,
    outpaintTopPrompt,
    outpaintBottomPrompt,
    inpaintExtendDirection,
    inpaintExtendPixels,
    inpaintExtendGrow,
    inpaintExtendFeather,
    inpaintExtendPadding,
    clothingMode,
    clothingSegmentCategories,
  };
  const diagnosticMaskMode = normalizeComfyUiMaskMode(inpaintMaskMode);
  const diagnosticInpaintSettings = resolveComfyUiEffectiveInpaintSettings(
    resolveComfyUiInpaintSettings(diagnosticOptions),
    inpaint === true,
    diagnosticMaskMode,
  );
  const diagnosticProtectionSettings = resolveComfyUiMaskProtectionSettings({
    ...diagnosticOptions,
    inpaint: inpaint === true,
  });
  const diagnosticReferenceDenoise = resolveComfyUiEffectiveDenoise(
    diagnosticOptions,
    inpaint === true,
    diagnosticMaskMode,
  );
  const diagnosticMaskContent = resolveComfyUiInpaintMaskContent(
    diagnosticOptions,
    inpaint === true,
    diagnosticMaskMode,
  );
  const diagnosticDifferentialDiffusion = shouldUseComfyUiDifferentialDiffusion(diagnosticOptions);
  const diagnosticUseRmbgBackgroundMask = shouldUseComfyUiRmbgBackgroundMask(diagnosticOptions);
  const diagnosticDifferentialDiffusionStrength = 1;
  const diagnosticUseClothingParser = shouldUseComfyUiClothingParser(diagnosticOptions);
  const diagnosticUseClothingParserTarget =
    diagnosticUseClothingParser && shouldUseComfyUiClothingParserTarget(diagnosticOptions);
  const diagnosticUseClothingParserHairTarget = shouldUseComfyUiClothingParserHairTarget(diagnosticOptions);
  const diagnosticUseClothingParserProtection =
    diagnosticUseClothingParser &&
    isComfyUiHairMaskPrompt(diagnosticOptions.maskPrompt) &&
    shouldUseComfyUiClothingParserProtection(diagnosticOptions);
  const diagnosticClothingSegmentCategories = resolveComfyUiClothingSegmentCategories(diagnosticOptions).join(",");
  const diagnosticUseSubtractionProtection = diagnosticProtectionSettings.enabled;
  const diagnosticSubtractClothingMask = diagnosticUseSubtractionProtection;
  const diagnosticMaskedTintBlend = 0.28;
  const diagnosticOutpaint = isComfyUiOutpaint(diagnosticOptions);
  if (diagnosticOutpaint) {
    diagnosticFiles = diagnosticFiles.filter((file) => file.filename.toLowerCase().includes("_outpaint"));
  }
  const diagnosticOutpaintPixels = resolveComfyUiOutpaintPixels(diagnosticOptions);
  const diagnosticSourceDimensions = buildComfyUiDimensions(diagnosticOptions);
  const diagnosticOutpaintDirection = normalizeComfyUiExtendDirection(inpaintExtendDirection);
  const diagnosticOutputDimensions = diagnosticOutpaint
    ? buildComfyUiOutpaintDimensions(
        diagnosticOptions,
        diagnosticSourceDimensions,
        diagnosticOutpaintDirection,
        diagnosticOutpaintPixels,
      )
    : diagnosticSourceDimensions;
  const diagnosticOutpaintLayout = diagnosticOutpaint
    ? buildComfyUiOutpaintLayout(
        diagnosticOptions,
        diagnosticSourceDimensions,
        diagnosticOutputDimensions,
        diagnosticOutpaintDirection,
      )
    : null;
  const finalImageMetadata = await sharp(imageBuffer)
    .metadata()
    .catch(() => null);
  const finalImageWidth = finalImageMetadata?.width ?? null;
  const finalImageHeight = finalImageMetadata?.height ?? null;
  if (
    diagnosticOutpaint &&
    finalImageWidth !== null &&
    finalImageHeight !== null &&
    (finalImageWidth < diagnosticOutputDimensions.width || finalImageHeight < diagnosticOutputDimensions.height)
  ) {
    throw new Error(
      `ComfyUI outpaint returned a non-expanded final image (${finalImageWidth}x${finalImageHeight}); expected about ${diagnosticOutputDimensions.width}x${diagnosticOutputDimensions.height}. Check that the active workflow routes TOMORI_OUTPAINT to the expanded outpaint decode before SaveImage.`,
    );
  }
  const diagnosticRequestedMaskPrompt = maskPrompt?.trim() || prompt;
  const diagnosticWorkflowMaskPrompt = resolveComfyUiWorkflowMaskPrompt(
    diagnosticRequestedMaskPrompt,
    diagnosticMaskMode,
    prompt,
  );
  const diagnosticOutpaintPadLeft = diagnosticOutpaintLayout?.placedSourceX ?? 0;
  const diagnosticOutpaintPadTop = diagnosticOutpaintLayout?.placedSourceY ?? 0;
  const diagnosticOutpaintPadRight = diagnosticOutpaintLayout
    ? Math.max(
        0,
        diagnosticOutputDimensions.width -
          diagnosticOutpaintLayout.placedSourceX -
          diagnosticOutpaintLayout.placedSourceWidth,
      )
    : 0;
  const diagnosticOutpaintPadBottom = diagnosticOutpaintLayout
    ? Math.max(
        0,
        diagnosticOutputDimensions.height -
          diagnosticOutpaintLayout.placedSourceY -
          diagnosticOutpaintLayout.placedSourceHeight,
      )
    : 0;
  const diagnosticLargestOutpaintPad = Math.max(
    diagnosticOutpaintPadLeft,
    diagnosticOutpaintPadTop,
    diagnosticOutpaintPadRight,
    diagnosticOutpaintPadBottom,
  );
  const diagnosticOutpaintPadFeather =
    diagnosticLargestOutpaintPad > 0 ? Math.min(resolveComfyUiOutpaintPadFeather(), diagnosticLargestOutpaintPad) : 0;
  const diagnosticMode = diagnosticOutpaint ? "outpainting" : normalizeComfyUiInpaintMode(diagnosticOptions);
  const diagnosticMaskProvider = diagnosticUseRmbgBackgroundMask
    ? "RMBG"
    : diagnosticUseClothingParserHairTarget
      ? "Clothing parser (hair target)"
      : diagnosticUseClothingParserTarget
        ? "Clothing parser"
        : "Florence2";
  const diagnosticDirectionalPromptLabels = [
    normalizeComfyUiOutpaintStagePrompt(diagnosticOptions.outpaintLeftPrompt) ? "left" : null,
    normalizeComfyUiOutpaintStagePrompt(diagnosticOptions.outpaintRightPrompt) ? "right" : null,
    normalizeComfyUiOutpaintStagePrompt(diagnosticOptions.outpaintTopPrompt) ? "top" : null,
    normalizeComfyUiOutpaintStagePrompt(diagnosticOptions.outpaintBottomPrompt) ? "bottom" : null,
  ].filter((label): label is string => label !== null);
  const diagnosticRmbgModel = "RMBG-2.0";
  const diagnosticDetails = [
    formatComfyUiDiagnosticSection("🧭 **Run**", [
      `Mode: ${diagnosticMode}`,
      `Seed: ${comfyUiSeed}`,
      `Source: ${diagnosticSourceDimensions.width}x${diagnosticSourceDimensions.height}`,
      `Expected output: ${diagnosticOutputDimensions.width}x${diagnosticOutputDimensions.height}`,
      `Final output: ${finalImageWidth ?? "unknown"}x${finalImageHeight ?? "unknown"}`,
    ]),
    diagnosticOutpaint
      ? formatComfyUiDiagnosticSection("🖼️ **Outpaint**", [
          `Direction: ${normalizeComfyUiExtendDirection(inpaintExtendDirection)}`,
          diagnosticOutpaintLayout ? `Strategy: ${diagnosticOutpaintLayout.strategy}` : null,
          `Amount: ${resolveComfyUiOutpaintAmount(diagnosticOptions)} (${diagnosticOutpaintPixels}px)`,
          diagnosticOutpaintLayout ? `Source scale: ${diagnosticOutpaintLayout.sourceScale}` : null,
          diagnosticOutpaintLayout ? `Overlap: ${diagnosticOutpaintLayout.overlap}px` : null,
          diagnosticOutpaintLayout
            ? `Padding L/T/R/B: ${diagnosticOutpaintPadLeft}/${diagnosticOutpaintPadTop}/${diagnosticOutpaintPadRight}/${diagnosticOutpaintPadBottom}`
            : null,
          diagnosticOutpaintLayout
            ? `Source rect: ${diagnosticOutpaintLayout.placedSourceWidth}x${diagnosticOutpaintLayout.placedSourceHeight} at ${diagnosticOutpaintLayout.placedSourceX},${diagnosticOutpaintLayout.placedSourceY}`
            : null,
          diagnosticDirectionalPromptLabels.length > 0
            ? `Directional prompts: ${diagnosticDirectionalPromptLabels.join(", ")}`
            : null,
          `Mask: sharp padding mask, feather ${diagnosticOutpaintPadFeather}px`,
          `Preserve: ${diagnosticOutpaint && COMFYUI_OUTPAINT_PRESERVE_SUBJECT_ONLY ? "subject" : "center source"}`,
        ])
      : formatComfyUiDiagnosticSection("🎯 **Inpaint Mask**", [
          `Prompt: ${JSON.stringify(diagnosticWorkflowMaskPrompt)}`,
          diagnosticWorkflowMaskPrompt !== diagnosticRequestedMaskPrompt
            ? `Requested prompt: ${JSON.stringify(diagnosticRequestedMaskPrompt)}`
            : null,
          `Provider: ${diagnosticMaskProvider}`,
          `Mode: ${diagnosticMaskMode}`,
          `Content: ${diagnosticMaskContent}`,
          `Threshold / grow / feather: ${diagnosticInpaintSettings.maskThreshold} / ${diagnosticInpaintSettings.maskGrow} / ${diagnosticInpaintSettings.maskFeather}`,
        ]),
    formatComfyUiDiagnosticSection("🎛️ **Sampler**", [
      "Engine: LanPaint",
      `Steps: ${diagnosticOutpaint ? resolveComfyUiOutpaintSteps() : resolveComfyUiLanPaintSteps()}`,
      `Thinking steps: ${
        diagnosticOutpaint ? resolveComfyUiOutpaintThinkingSteps() : resolveComfyUiLanPaintNumSteps()
      }`,
      `Sampler: ${diagnosticOutpaint ? resolveComfyUiOutpaintSampler() : resolveComfyUiLanPaintSampler()}`,
      `CFG: ${diagnosticOutpaint ? resolveComfyUiOutpaintCfg() : diagnosticInpaintSettings.cfg}`,
      `Denoise: ${diagnosticOutpaint ? resolveComfyUiOutpaintDenoise() : diagnosticReferenceDenoise}`,
      `Prompt mode: ${resolveComfyUiLanPaintPromptMode()}`,
      `Mask blend overlap: ${resolveComfyUiLanPaintMaskBlendOverlap()}`,
    ]),
    diagnosticOutpaint
      ? null
      : formatComfyUiDiagnosticSection("🧩 **Mask Helpers**", [
          `Differential diffusion: ${diagnosticDifferentialDiffusion}${
            diagnosticDifferentialDiffusion ? `, strength ${diagnosticDifferentialDiffusionStrength}` : ""
          }`,
          `RMBG background mask: ${diagnosticUseRmbgBackgroundMask} (${diagnosticRmbgModel})`,
          `Clothing mode: ${diagnosticOptions.clothingMode ?? "auto"}`,
          `Clothing parser: ${diagnosticUseClothingParser}`,
          diagnosticUseClothingParser
            ? `Parser roles: target ${diagnosticUseClothingParserTarget}, hair target ${diagnosticUseClothingParserHairTarget}, protection ${diagnosticUseClothingParserProtection}`
            : null,
          diagnosticUseClothingParser ? `Parser categories: ${diagnosticClothingSegmentCategories}` : null,
          `Masked tint reference: ${usedTintReference}${
            usedTintReference ? `, blend ${diagnosticMaskedTintBlend}` : ""
          }`,
        ]),
    !diagnosticOutpaint && diagnosticProtectionSettings.enabled
      ? formatComfyUiDiagnosticSection("🛡️ **Protection Masks**", [
          `Face: ${JSON.stringify(diagnosticProtectionSettings.maskPrompt)} (${diagnosticProtectionSettings.maskThreshold}/${diagnosticProtectionSettings.maskGrow}/${diagnosticProtectionSettings.maskFeather})`,
          `Clothing: ${JSON.stringify(diagnosticProtectionSettings.clothingMaskPrompt)} (${diagnosticProtectionSettings.clothingMaskThreshold}/${diagnosticProtectionSettings.clothingMaskGrow}/${diagnosticProtectionSettings.clothingMaskFeather})`,
          `Arms: ${JSON.stringify(diagnosticProtectionSettings.armsMaskPrompt)} (${diagnosticProtectionSettings.armsMaskThreshold}/${diagnosticProtectionSettings.armsMaskGrow}/${diagnosticProtectionSettings.armsMaskFeather})`,
          `Neck: ${JSON.stringify(diagnosticProtectionSettings.neckMaskPrompt)} (${diagnosticProtectionSettings.neckMaskThreshold}/${diagnosticProtectionSettings.neckMaskGrow}/${diagnosticProtectionSettings.neckMaskFeather})`,
          `Skin: ${JSON.stringify(diagnosticProtectionSettings.skinMaskPrompt)} (${diagnosticProtectionSettings.skinMaskThreshold}/${diagnosticProtectionSettings.skinMaskGrow}/${diagnosticProtectionSettings.skinMaskFeather})`,
          `Subtract face/skin: ${diagnosticUseSubtractionProtection}`,
          `Subtract clothing: ${diagnosticSubtractClothingMask}`,
        ])
      : null,
  ]
    .filter((section): section is string => section !== null)
    .join("\n\n");
  const diagnosticImages = await Promise.all(
    diagnosticFiles.map(async (file) => {
      const diagnosticBuffer = await downloadComfyUiAsset(endpoint, apiKey, file);
      const label = `${diagnosticOutpaint ? "Outpaint" : "Inpaint"} ${getComfyUiDiagnosticLabel(file).toLowerCase()}`;
      return {
        label,
        imageData: diagnosticBuffer.toString("base64"),
        mimeType: "image/png",
        filename: file.filename,
        details: diagnosticDetails,
      };
    }),
  );
  await unloadComfyUiModelsAfterSuccessfulGeneration(endpoint, apiKey, "image");
  return {
    imageData: imageBuffer.toString("base64"),
    mimeType: "image/png",
    ...(diagnosticImages.length > 0 ? { diagnosticImages } : {}),
  };
}

export async function generateComfyUiVideoViaEndpoint(params: {
  endpoint: CustomEndpointRow;
  apiKey: string;
  prompt: string;
  aspectRatio?: string;
  durationSeconds?: number;
  fps?: number;
  resolution?: string;
  referenceImages?: ProviderNativeVideoGenerationRequest["referenceImages"];
  generateAudio?: boolean;
  audioPrompt?: string;
  loop?: boolean;
}): Promise<ProviderNativeVideoGenerationResult> {
  const {
    endpoint,
    apiKey,
    prompt,
    aspectRatio,
    durationSeconds,
    fps,
    resolution,
    referenceImages,
    generateAudio,
    audioPrompt,
    loop,
  } = params;

  const { files } = await generateWithComfyUi(endpoint, apiKey, {
    mode: "video",
    prompt,
    aspectRatio,
    durationSeconds,
    fps,
    resolution,
    referenceImages,
    generateAudio,
    audioPrompt,
    loop,
  });
  const firstFile = files[0];
  log.info(
    `ComfyUI video output selected ${JSON.stringify({
      filename: firstFile.filename,
      subfolder: firstFile.subfolder ?? null,
      type: firstFile.type ?? null,
      mediaKind: firstFile.mediaKind ?? null,
    })}`,
  );
  const videoBuffer = await downloadComfyUiAsset(endpoint, apiKey, firstFile);
  if (videoBuffer.length === 0) {
    throw new Error("ComfyUI returned an empty video file.");
  }
  const mimeType = inferComfyUiVideoMimeType(firstFile, videoBuffer);
  const filename = buildComfyUiVideoDownloadFilename(firstFile, mimeType);
  log.info(
    `ComfyUI video downloaded ${JSON.stringify({
      filename,
      mimeType,
      bytes: videoBuffer.length,
      signature: describeVideoBufferSignature(videoBuffer),
    })}`,
  );
  await unloadComfyUiModelsAfterSuccessfulGeneration(endpoint, apiKey, "video");
  return {
    videoData: videoBuffer,
    mimeType,
    filename,
  };
}
