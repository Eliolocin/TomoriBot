import type { FunctionResponseImageMetadata } from "@/types/provider/interfaces";
import { fetchAndOptimizeImage } from "@/utils/image/imageProcessor";
import { log } from "@/utils/misc/logger";

type ToolImage = FunctionResponseImageMetadata["imageUrls"][number];

export type OpenAIToolImageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/**
 * Resolves a tool-produced Discord attachment locally before provider replay.
 *
 * Provider-side fetchers cannot reliably access Discord's signed media proxy URLs. Local
 * resolution also lets the shared image pipeline correct misleading MIME labels before the
 * payload is encoded as a data URI.
 */
export async function inlineToolResponseImage(
  image: ToolImage,
  adapterName: string,
): Promise<OpenAIToolImageContentPart> {
  const candidateUrls = [image.url, image.originalUrl].filter(
    (url, index, urls): url is string => Boolean(url) && urls.indexOf(url) === index,
  );
  let lastError: unknown;

  for (const url of candidateUrls) {
    try {
      const optimized = await fetchAndOptimizeImage(url, image.mimeType);
      if (optimized.mimeType === "image/gif") {
        log.info(`${adapterName}: Replaced tool-returned GIF with a compatibility placeholder`);
        return {
          type: "text",
          text: "[System: A GIF returned by the tool is not supported by this endpoint.]",
        };
      }

      return {
        type: "image_url",
        image_url: {
          url: `data:${optimized.mimeType};base64,${optimized.data}`,
        },
      };
    } catch (error) {
      lastError = error;
    }
  }

  log.warn(`${adapterName}: Could not load a tool-returned image for provider context`, {
    error: lastError instanceof Error ? lastError.message : String(lastError ?? "no image URL"),
  });
  return {
    type: "text",
    text: "[System: An image returned by the tool could not be loaded.]",
  };
}
