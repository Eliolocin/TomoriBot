import { createOpenRouterCatalog, normalizeOpenRouterCodename } from "@/utils/cache/openrouterCatalog";

const OPENROUTER_VIDEO_MODELS_URL = "https://openrouter.ai/api/v1/videos/models";

type OpenRouterFrameType = "first_frame" | "last_frame";

export interface OpenRouterVideoModelCapabilities {
  id: string;
  supportedResolutions: string[];
  supportedAspectRatios: string[];
  supportedDurations: number[];
  supportedFrameImages: OpenRouterFrameType[];
  generateAudio: boolean | null;
  allowedPassthroughParameters: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function readNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))
    : [];
}

function readFrameTypes(value: unknown): OpenRouterFrameType[] {
  return readStringArray(value).filter(
    (entry): entry is OpenRouterFrameType => entry === "first_frame" || entry === "last_frame",
  );
}

export function parseOpenRouterVideoModelList(payload: unknown): OpenRouterVideoModelCapabilities[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("Unexpected OpenRouter video models response: missing data array");
  }

  const models: OpenRouterVideoModelCapabilities[] = [];
  for (const entry of payload.data) {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.trim().length === 0) {
      continue;
    }

    models.push({
      id: normalizeOpenRouterCodename(entry.id),
      supportedResolutions: readStringArray(entry.supported_resolutions),
      supportedAspectRatios: readStringArray(entry.supported_aspect_ratios),
      supportedDurations: readNumberArray(entry.supported_durations),
      supportedFrameImages: readFrameTypes(entry.supported_frame_images),
      generateAudio: typeof entry.generate_audio === "boolean" ? entry.generate_audio : null,
      allowedPassthroughParameters: readStringArray(entry.allowed_passthrough_parameters),
    });
  }

  return models;
}

const videoCatalog = createOpenRouterCatalog<OpenRouterVideoModelCapabilities>({
  label: "video",
  url: OPENROUTER_VIDEO_MODELS_URL,
  parse: parseOpenRouterVideoModelList,
  keyOf: (entry) => entry.id,
});

export async function initializeOpenRouterVideoModelCache(): Promise<void> {
  await videoCatalog.initialize();
}

export function getOrFetchOpenRouterVideoModelCapabilities(
  modelCodename: string,
  options?: { fresh?: boolean },
): Promise<OpenRouterVideoModelCapabilities | undefined> {
  return videoCatalog.getOrFetch(modelCodename, options);
}

export function refreshOpenRouterVideoModelCacheIfStale(): Promise<boolean> {
  return videoCatalog.refreshIfStale();
}

export function getOpenRouterVideoModelCacheSize(): number {
  return videoCatalog.size();
}

export function isOpenRouterVideoModelCacheReady(): boolean {
  return videoCatalog.isReady();
}

export function resetOpenRouterVideoModelCache(): void {
  videoCatalog.reset();
}
