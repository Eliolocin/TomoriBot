/**
 * Image processing utilities for TomoriBot
 * Handles image manipulation tasks like cropping, resizing, and format conversion,
 * as well as optimizing images before sending to LLM providers.
 */

// sharp v0.35 moved to ESM-style types, so `Metadata` is a named type export
//    rather than a member of a merged `sharp` namespace.
import sharp from "sharp";
import { log } from "../misc/logger";
import { MEDIA_LIMITS } from "@/utils/security/rateLimiter";
import { safeDownload } from "@/utils/security/safeDownload";

// Images exceeding these limits are downscaled before being sent to providers
// to prevent stream timeouts (especially on slower models like Qwen via OpenRouter).

/** Raw byte-size threshold that triggers dimension inspection (default 2 MB) */
const IMAGE_CONTEXT_MAX_BYTES = Number.parseInt(process.env.IMAGE_CONTEXT_MAX_BYTES ?? "2097152", 10);

/** Maximum pixel dimension on the longest side before downscaling (default 2048 px) */
const IMAGE_CONTEXT_MAX_DIMENSION = Number.parseInt(process.env.IMAGE_CONTEXT_MAX_DIMENSION ?? "2048", 10);

/** JPEG quality used when an image is downscaled (default 85) */
const IMAGE_CONTEXT_JPEG_QUALITY = Number.parseInt(process.env.IMAGE_CONTEXT_JPEG_QUALITY ?? "85", 10);

/** Timeout in milliseconds for fetching images for LLM context (default 20 s) */
const IMAGE_FETCH_TIMEOUT_MS = Number.parseInt(process.env.IMAGE_FETCH_TIMEOUT_MS ?? "20000", 10);

/** Result of fetching and optionally optimizing an image for LLM context */
export interface OptimizedImage {
  /** Raw base64-encoded image data (no data-URI prefix) */
  data: string;
  /** MIME type of the resulting image (may change to image/jpeg after optimization) */
  mimeType: string;
}

function detectImageMimeType(buffer: Buffer): string | undefined {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 6) {
    const signature = buffer.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") {
      return "image/gif";
    }
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (buffer.length >= 16 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    const brands = buffer.subarray(8, Math.min(buffer.length, 32)).toString("ascii");
    if (brands.includes("avif") || brands.includes("avis")) {
      return "image/avif";
    }
  }
  return undefined;
}

function normalizeMimeType(mimeType: string | undefined): string | undefined {
  const normalized = mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized || undefined;
}

/**
 * Fetch an image from a URL and conditionally downscale it for LLM context use.
 *
 * Uses a three-tier cost check to avoid unnecessary work:
 * 1. **Buffer byte length** (O(1)) if under threshold, return as-is.
 * 2. **Sharp metadata** (header-only read, <1 ms): check pixel dimensions.
 * 3. **Sharp resize** (decode + encode); only runs when the image actually exceeds
 *    the maximum dimension, converting to JPEG for significantly smaller payloads.
 *
 * This prevents multi-MB base64 payloads from causing provider stream timeouts
 * while adding near-zero overhead for normally-sized images.
 *
 * @param sourceMimeType - Original MIME type hint (used as fallback if no optimization needed)
 * @returns Optimized base64 image data and final MIME type
 * @throws Error if the fetch itself fails
 */
export async function fetchAndOptimizeImage(url: string, sourceMimeType?: string): Promise<OptimizedImage> {
  const downloadResult = await safeDownload(url, {
    maxSizeMB: MEDIA_LIMITS.MAX_MEDIA_SIZE_MB,
    timeoutMs: IMAGE_FETCH_TIMEOUT_MS,
  });
  if (!downloadResult.success || !downloadResult.buffer) {
    throw new Error(`Image fetch failed: ${downloadResult.details ?? downloadResult.error ?? "unknown error"}`);
  }

  const buffer = downloadResult.buffer;
  const rawSize = buffer.byteLength;
  // Discord filenames and remote headers can disagree with the payload bytes. Provider APIs use
  // the data-URI MIME label while decoding, so prefer recognizable file signatures.
  const finalMimeType =
    detectImageMimeType(buffer) ??
    normalizeMimeType(sourceMimeType) ??
    normalizeMimeType(downloadResult.contentType) ??
    "image/jpeg";

  if (rawSize <= IMAGE_CONTEXT_MAX_BYTES) {
    return { data: buffer.toString("base64"), mimeType: finalMimeType };
  }

  try {
    const metadata = await sharp(buffer).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    const longestSide = Math.max(width, height);

    if (longestSide <= IMAGE_CONTEXT_MAX_DIMENSION) {
      return { data: buffer.toString("base64"), mimeType: finalMimeType };
    }

    const optimizedBuffer = await sharp(buffer)
      .resize({
        width: IMAGE_CONTEXT_MAX_DIMENSION,
        height: IMAGE_CONTEXT_MAX_DIMENSION,
        fit: "inside", // Maintains aspect ratio, fits within the box
        withoutEnlargement: true,
      })
      .jpeg({ quality: IMAGE_CONTEXT_JPEG_QUALITY })
      .toBuffer();

    return {
      data: optimizedBuffer.toString("base64"),
      mimeType: "image/jpeg",
    };
  } catch (sharpError) {
    // Sharp failed (corrupt image, unsupported format, etc.), so fall back to raw data
    // so the provider can still attempt to process it
    log.warn(
      `Image optimization failed, sending raw (${(rawSize / 1024 / 1024).toFixed(1)} MB): ${sharpError instanceof Error ? sharpError.message : String(sharpError)}`,
    );
    return { data: buffer.toString("base64"), mimeType: finalMimeType };
  }
}

/**
 * Optimize an already-fetched image buffer for LLM context use.
 * Same tiered logic as {@link fetchAndOptimizeImage} but skips the HTTP fetch step.
 *
 * @param buffer - Raw image buffer
 * @param sourceMimeType - Original MIME type of the image
 * @returns Optimized base64 image data and final MIME type
 */
export async function optimizeImageBuffer(buffer: Buffer, sourceMimeType: string): Promise<OptimizedImage> {
  const rawSize = buffer.byteLength;

  if (rawSize <= IMAGE_CONTEXT_MAX_BYTES) {
    return { data: buffer.toString("base64"), mimeType: sourceMimeType };
  }

  try {
    const metadata = await sharp(buffer).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    const longestSide = Math.max(width, height);

    if (longestSide <= IMAGE_CONTEXT_MAX_DIMENSION) {
      return { data: buffer.toString("base64"), mimeType: sourceMimeType };
    }

    const optimizedBuffer = await sharp(buffer)
      .resize({
        width: IMAGE_CONTEXT_MAX_DIMENSION,
        height: IMAGE_CONTEXT_MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: IMAGE_CONTEXT_JPEG_QUALITY })
      .toBuffer();

    return {
      data: optimizedBuffer.toString("base64"),
      mimeType: "image/jpeg",
    };
  } catch (sharpError) {
    log.warn(
      `Image buffer optimization failed, sending raw (${(rawSize / 1024 / 1024).toFixed(1)} MB): ${sharpError instanceof Error ? sharpError.message : String(sharpError)}`,
    );
    return { data: buffer.toString("base64"), mimeType: sourceMimeType };
  }
}

const NAI_REFERENCE_CANVASES = [
  { width: 1024, height: 1536 },
  { width: 1472, height: 1472 },
  { width: 1536, height: 1024 },
] as const;

function selectClosestNaiReferenceCanvas(width: number, height: number): { width: number; height: number } {
  const aspectRatio = width / height;

  return NAI_REFERENCE_CANVASES.reduce((bestCanvas, candidateCanvas) => {
    const bestDistance = Math.abs(Math.log(aspectRatio / (bestCanvas.width / bestCanvas.height)));
    const candidateDistance = Math.abs(Math.log(aspectRatio / (candidateCanvas.width / candidateCanvas.height)));

    return candidateDistance < bestDistance ? candidateCanvas : bestCanvas;
  });
}

/**
 * Center-crop an image to a 1:1 square aspect ratio
 * This is ideal for Discord avatar images which display best as squares
 *
 * @returns Promise<Buffer> - Output PNG buffer cropped to square
 *
 * @example
 * const squareImage = await centerCropToSquare(imageBuffer);
 * // Image is now 1:1 aspect ratio, centered from original
 */
export async function centerCropToSquare(buffer: Buffer): Promise<Buffer> {
  try {
    const metadata = await sharp(buffer).metadata();

    if (!metadata.width || !metadata.height) {
      throw new Error("Unable to read image dimensions");
    }

    const squareSize = Math.min(metadata.width, metadata.height);

    // Calculate the extraction position to center the crop
    // For a 1920x1080 image, we want to extract a 1080x1080 square from the center
    const left = Math.floor((metadata.width - squareSize) / 2);
    const top = Math.floor((metadata.height - squareSize) / 2);

    const croppedBuffer = await sharp(buffer)
      .extract({
        left,
        top,
        width: squareSize,
        height: squareSize,
      })
      .png() // Convert to PNG format for consistency
      .toBuffer();

    return croppedBuffer;
  } catch (error) {
    log.error("Failed to crop image to square:", error);
    throw new Error(`Image processing failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

/**
 * Normalize a NovelAI character/director reference image onto one of the
 * accepted canvases using black padding.
 *
 * NovelAI's reference pipeline fits images into 1024x1536, 1472x1472, or
 * 1536x1024. This helper mirrors that preprocessing so API requests don't send
 * arbitrary image dimensions directly.
 *
 * @returns Promise<Buffer> - PNG buffer normalized to a supported NAI canvas
 */
export async function normalizeNaiReferenceImage(buffer: Buffer): Promise<Buffer> {
  try {
    const metadata = await sharp(buffer).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error("Unable to read image dimensions");
    }

    const canvas = selectClosestNaiReferenceCanvas(metadata.width, metadata.height);

    const normalizedBuffer = await sharp(buffer)
      .flatten({ background: { r: 0, g: 0, b: 0 } })
      .resize(canvas.width, canvas.height, {
        fit: "contain",
        position: "centre",
        background: { r: 0, g: 0, b: 0, alpha: 1 },
      })
      .png()
      .toBuffer();

    return normalizedBuffer;
  } catch (error) {
    log.error("Failed to normalize NovelAI reference image:", error);
    throw new Error(
      `NovelAI reference normalization failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Convert an image buffer to PNG format
 *
 * @returns Promise<Buffer> - PNG buffer
 */
export async function convertToPNG(buffer: Buffer): Promise<Buffer> {
  try {
    const pngBuffer = await sharp(buffer).png().toBuffer();
    return pngBuffer;
  } catch (error) {
    log.error("Failed to convert image to PNG:", error);
    throw new Error(`Image conversion failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}
