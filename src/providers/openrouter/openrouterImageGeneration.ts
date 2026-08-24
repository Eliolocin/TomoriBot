import { isOpenRouterGeminiModelCodename } from "@/utils/provider/openrouterModelCapabilities";
import { buildOpenRouterAttributionHeaders } from "@/utils/provider/openrouterAttribution";
import { log } from "@/utils/misc/logger";
import { MEDIA_LIMITS } from "@/utils/security/rateLimiter";
import { safeDownload } from "@/utils/security/safeDownload";

const OPENROUTER_ORIGIN = "https://openrouter.ai";
const OPENROUTER_CHAT_URL = `${OPENROUTER_ORIGIN}/api/v1/chat/completions`;
const OPENROUTER_IMAGES_URL = `${OPENROUTER_ORIGIN}/api/v1/images`;

export interface OpenRouterImageReference {
  mimeType: string;
  data: string;
}

export interface OpenRouterImageGenerationRequest {
  apiKey: string;
  modelCodename: string;
  prompt: string;
  aspectRatio: string;
  referenceImages?: OpenRouterImageReference[];
  abortSignal?: AbortSignal;
}

export interface OpenRouterImageGenerationResult {
  imageData: string | null;
  mimeType: string | null;
}

/**
 * Whether a model generates images as a chat completion rather than through the image endpoint.
 *
 * Gemini models are chat models that happen to emit images, so they answer on `/chat/completions` with
 * `modalities`. Every dedicated image model moved to OpenRouter's unified `/api/v1/images` endpoint and
 * now rejects `/chat/completions` outright: some report the legible 404 "is an image generation model and
 * cannot be used with the chat/completions endpoint", while others surface it as an opaque 500.
 */
export function usesChatCompletionsImageGeneration(modelCodename: string): boolean {
  return isOpenRouterGeminiModelCodename(modelCodename);
}

function buildRequestFailure(modelCodename: string, status: number, statusText: string, body: string): Error {
  const bodySnippet = body.slice(0, 500);

  let parsedMessage = "";
  try {
    const parsed = JSON.parse(body);
    parsedMessage = (parsed?.error?.message as string | undefined) || (parsed?.message as string | undefined) || "";
  } catch {
    // A non-JSON body is reported verbatim below; OpenRouter's own errors are always JSON.
  }

  const friendlyMessage = parsedMessage || bodySnippet || `${status} ${statusText}`.trim();
  return new Error(
    `OpenRouter API request failed (${status} ${statusText}) for model "${modelCodename}": ${friendlyMessage}`,
  );
}

async function resolveImageUrl(imageUrl: string, abortSignal?: AbortSignal): Promise<OpenRouterImageGenerationResult> {
  const dataUrlMatches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (dataUrlMatches) {
    return { imageData: dataUrlMatches[2], mimeType: dataUrlMatches[1] };
  }

  if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
    const imageResponse = await safeDownload(imageUrl, {
      maxSizeMB: MEDIA_LIMITS.MAX_MEDIA_SIZE_MB,
      timeoutMs: 15_000,
      ...(abortSignal ? { externalSignal: abortSignal } : {}),
    });
    if (imageResponse.success && imageResponse.buffer) {
      return {
        imageData: imageResponse.buffer.toString("base64"),
        mimeType: imageResponse.contentType?.split(";")[0] || null,
      };
    }
  }

  return { imageData: null, mimeType: null };
}

async function generateViaChatCompletions(
  request: OpenRouterImageGenerationRequest,
): Promise<OpenRouterImageGenerationResult> {
  const { apiKey, modelCodename, prompt, aspectRatio, referenceImages, abortSignal } = request;

  const contentParts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
    { type: "text", text: prompt },
  ];
  for (const image of referenceImages ?? []) {
    contentParts.push({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } });
  }

  const response = await fetch(OPENROUTER_CHAT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelCodename,
      messages: [{ role: "user", content: contentParts }],
      modalities: ["image", "text"],
      image_config: { aspect_ratio: aspectRatio },
    }),
    ...(abortSignal ? { signal: abortSignal } : {}),
  });

  if (!response.ok) {
    const errorText = await response.text();
    log.warn(
      `[OpenRouter] Chat image request failed (${response.status} ${response.statusText}) for model "${modelCodename}". Body: ${errorText.slice(0, 500)}`,
    );
    throw buildRequestFailure(modelCodename, response.status, response.statusText, errorText);
  }

  const result = await response.json();
  const message = result.choices?.[0]?.message;

  let imageUrl: string | null = null;
  if (message?.images?.[0]) {
    const firstImage = message.images[0];
    // OpenRouter returns either snake_case (image_url) or camelCase (imageUrl) here.
    imageUrl = firstImage?.image_url?.url || firstImage?.imageUrl?.url || null;
  } else if (Array.isArray(message?.content)) {
    const firstImagePart = message.content.find(
      (part: unknown) =>
        typeof part === "object" && part !== null && "type" in part && (part as { type?: string }).type === "image_url",
    ) as { image_url?: { url?: string } } | undefined;
    imageUrl = firstImagePart?.image_url?.url || null;
  }

  return imageUrl ? await resolveImageUrl(imageUrl, abortSignal) : { imageData: null, mimeType: null };
}

async function generateViaImagesEndpoint(
  request: OpenRouterImageGenerationRequest,
): Promise<OpenRouterImageGenerationResult> {
  const { apiKey, modelCodename, prompt, aspectRatio, referenceImages, abortSignal } = request;

  const body: Record<string, unknown> = {
    model: modelCodename,
    prompt,
    aspect_ratio: aspectRatio,
  };
  if (referenceImages && referenceImages.length > 0) {
    body.input_references = referenceImages.map((image) => ({
      type: "image_url",
      image_url: { url: `data:${image.mimeType};base64,${image.data}` },
    }));
  }

  const response = await fetch(OPENROUTER_IMAGES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...buildOpenRouterAttributionHeaders(),
    },
    body: JSON.stringify(body),
    ...(abortSignal ? { signal: abortSignal } : {}),
  });

  if (!response.ok) {
    const errorText = await response.text();
    log.warn(
      `[OpenRouter] Image request failed (${response.status} ${response.statusText}) for model "${modelCodename}". Body: ${errorText.slice(0, 500)}`,
    );
    throw buildRequestFailure(modelCodename, response.status, response.statusText, errorText);
  }

  const result = await response.json();
  const first = result?.data?.[0];
  const base64 = typeof first?.b64_json === "string" ? first.b64_json : null;
  if (!base64) {
    return { imageData: null, mimeType: null };
  }

  // media_type is omitted only when the format cannot be determined; callers default to PNG.
  return { imageData: base64, mimeType: typeof first?.media_type === "string" ? first.media_type : null };
}

export async function generateOpenRouterImage(
  request: OpenRouterImageGenerationRequest,
): Promise<OpenRouterImageGenerationResult> {
  const viaChat = usesChatCompletionsImageGeneration(request.modelCodename);
  log.info(
    `[OpenRouter] Sending image request to model "${request.modelCodename}" via ${viaChat ? "chat/completions" : "images"} (aspect ratio: ${request.aspectRatio}, refs: ${request.referenceImages?.length ?? 0})`,
  );

  return viaChat ? await generateViaChatCompletions(request) : await generateViaImagesEndpoint(request);
}
