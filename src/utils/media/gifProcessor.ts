/**
 * GIF Processing Utility
 * Extracts keyframes from animated GIFs and converts them to compressed JPEG images
 * for use with LLM providers that don't support GIF format
 */

import gifFrames from "gif-frames";
import sharp from "sharp";
import { log } from "../misc/logger";

// ========================================
// GIF Processing Configuration Constants
// ========================================

/**
 * Maximum width for resized keyframe images (pixels)
 * Images maintain aspect ratio and won't be upscaled
 */
const MAX_KEYFRAME_WIDTH = 800;

/**
 * JPEG compression quality (0-100)
 * Higher = better quality but larger file size
 */
const JPEG_QUALITY = 80;

/**
 * Maximum number of keyframes to extract from a GIF
 * Prevents extremely long GIFs from overwhelming the context
 */
const MAX_KEYFRAMES = 10;

/**
 * Extract every Nth frame as a keyframe
 * E.g., 10 means extract frames 0, 10, 20, 30, etc. (plus first and last)
 */
const FRAME_INTERVAL = 10;

/**
 * Processing timeout in milliseconds
 * Prevents hanging on corrupted or extremely large GIFs
 */
const PROCESSING_TIMEOUT_MS = 30000; // 30 seconds

/**
 * Represents a processed GIF keyframe
 */
export interface ProcessedGifFrame {
	/** Base64-encoded JPEG image data */
	data: string;
	/** MIME type (always 'image/jpeg' for processed frames) */
	mimeType: string;
	/** Frame number (0-indexed) */
	frameNumber: number;
	/** Total number of frames in the original GIF */
	totalFrames: number;
	/** Original frame index in the GIF */
	originalFrameIndex: number;
}

/**
 * Configuration for GIF keyframe extraction
 */
export interface GifProcessorConfig {
	/** Maximum width for resized images (maintains aspect ratio) */
	maxWidth?: number;
	/** JPEG quality (0-100) */
	jpegQuality?: number;
	/** Maximum number of keyframes to extract */
	maxKeyframes?: number;
	/** Extract every Nth frame */
	frameInterval?: number;
	/** Processing timeout in milliseconds */
	timeoutMs?: number;
}

// Default configuration values (using constants defined above)
const DEFAULT_CONFIG: Required<GifProcessorConfig> = {
	maxWidth: MAX_KEYFRAME_WIDTH,
	jpegQuality: JPEG_QUALITY,
	maxKeyframes: MAX_KEYFRAMES,
	frameInterval: FRAME_INTERVAL,
	timeoutMs: PROCESSING_TIMEOUT_MS,
};

/**
 * Extract keyframes from an animated GIF
 *
 * Algorithm:
 * 1. Always includes first frame (index 0)
 * 2. Always includes last frame
 * 3. Includes every Nth frame in between (default N=10)
 * 4. Caps total frames at maxKeyframes
 *
 * @param gifSource - URL or Buffer containing the GIF data
 * @param config - Optional configuration for processing
 * @returns Array of processed keyframes with metadata
 * @throws Error if GIF processing fails
 */
export async function extractGifKeyframes(
	gifSource: string | Buffer,
	config: GifProcessorConfig = {},
): Promise<ProcessedGifFrame[]> {
	// 1. Merge with default configuration
	const finalConfig = { ...DEFAULT_CONFIG, ...config };

	const startTime = Date.now();
	const sourceDesc = typeof gifSource === "string" ? gifSource : `Buffer (${gifSource.length} bytes)`;
	log.info(
		`GIF Processor: Starting keyframe extraction - Source: ${sourceDesc}, Config: ${JSON.stringify(finalConfig)}`,
	);

	try {
		// 2. Create timeout promise
		const timeoutPromise = new Promise<never>((_, reject) => {
			setTimeout(() => {
				reject(new Error(`GIF processing timeout after ${finalConfig.timeoutMs}ms`));
			}, finalConfig.timeoutMs);
		});

		// 3. Extract frames with timeout
		const extractionPromise = extractFramesInternal(gifSource, finalConfig);
		const frames = await Promise.race([extractionPromise, timeoutPromise]);

		const processingTime = Date.now() - startTime;
		log.success(`GIF Processor: Extracted ${frames.length} keyframes in ${processingTime}ms`);

		return frames;
	} catch (error) {
		const processingTime = Date.now() - startTime;
		log.error(`GIF Processor: Failed to extract keyframes after ${processingTime}ms`, error as Error);
		throw error;
	}
}

/**
 * Internal function to extract and process GIF frames
 * Separated for cleaner timeout handling
 */
async function extractFramesInternal(
	gifSource: string | Buffer,
	config: Required<GifProcessorConfig>,
): Promise<ProcessedGifFrame[]> {
	// 1. Fetch GIF data if source is a URL
	let gifBuffer: Buffer;
	if (typeof gifSource === "string") {
		log.info(`GIF Processor: Fetching GIF from URL: ${gifSource}`);
		const response = await fetch(gifSource);
		if (!response.ok) {
			throw new Error(`Failed to fetch GIF: ${response.status} ${response.statusText}`);
		}
		const arrayBuffer = await response.arrayBuffer();
		gifBuffer = Buffer.from(arrayBuffer);
		log.info(`GIF Processor: Fetched ${gifBuffer.length} bytes`);
	} else {
		gifBuffer = gifSource;
	}

	// 2. Get frame metadata to determine total frame count
	// Extract all frames first to get accurate count
	const allFramesData = await gifFrames({
		url: gifBuffer,
		frames: "all",
		cumulative: true, // Important: composite frames for GIFs with delta encoding
	});

	const totalFrames = allFramesData.length;
	log.info(`GIF Processor: Total frames in GIF: ${totalFrames}`);

	// 3. Handle single-frame GIF (static image)
	if (totalFrames === 1) {
		log.info("GIF Processor: Single-frame GIF detected, processing as static image");
		const processedFrame = await processFrame(allFramesData[0], 0, 1, 0, totalFrames, config);
		return [processedFrame];
	}

	// 4. Calculate which frames to extract
	const frameIndices = calculateKeyframeIndices(
		totalFrames,
		config.frameInterval,
		config.maxKeyframes,
	);

	log.info(`GIF Processor: Selected ${frameIndices.length} keyframes: [${frameIndices.join(", ")}]`);

	// 5. Process selected frames
	const processedFrames: ProcessedGifFrame[] = [];
	for (let i = 0; i < frameIndices.length; i++) {
		const frameIndex = frameIndices[i];
		const frameData = allFramesData[frameIndex];
		const processedFrame = await processFrame(frameData, i, frameIndices.length, frameIndex, totalFrames, config);
		processedFrames.push(processedFrame);
	}

	return processedFrames;
}

/**
 * Calculate which frame indices to extract as keyframes
 * Always includes first and last frame, plus every Nth frame in between
 *
 * @param totalFrames - Total number of frames in the GIF
 * @param interval - Extract every Nth frame
 * @param maxFrames - Maximum number of keyframes to return
 * @returns Array of frame indices to extract (sorted)
 */
function calculateKeyframeIndices(
	totalFrames: number,
	interval: number,
	maxFrames: number,
): number[] {
	const indices = new Set<number>();

	// Always include first frame
	indices.add(0);

	// Always include last frame
	indices.add(totalFrames - 1);

	// Add every Nth frame
	for (let i = interval; i < totalFrames - 1; i += interval) {
		indices.add(i);
	}

	// Convert to sorted array
	const sortedIndices = Array.from(indices).sort((a, b) => a - b);

	// If we have too many frames, reduce by increasing the interval
	if (sortedIndices.length > maxFrames) {
		// Keep first and last, then evenly distribute remaining frames
		const result = [0, totalFrames - 1];
		const remainingSlots = maxFrames - 2;
		const step = Math.floor((sortedIndices.length - 2) / remainingSlots);

		for (let i = 1; i < sortedIndices.length - 1; i += step) {
			if (result.length >= maxFrames) break;
			result.push(sortedIndices[i]);
		}

		return result.sort((a, b) => a - b);
	}

	return sortedIndices;
}

/**
 * Process a single GIF frame: convert to JPEG and compress
 *
 * @param frameData - Frame data from gif-frames
 * @param frameNumber - Sequential frame number in the output (0-indexed)
 * @param totalOutputFrames - Total number of frames in the output (keyframes)
 * @param originalFrameIndex - Original frame index in the source GIF
 * @param totalSourceFrames - Total number of frames in the original source GIF
 * @param config - Processing configuration
 * @returns Processed frame with base64 data
 */
async function processFrame(
	frameData: { getImage: () => NodeJS.ReadableStream },
	frameNumber: number,
	totalOutputFrames: number,
	originalFrameIndex: number,
	totalSourceFrames: number,
	config: Required<GifProcessorConfig>,
): Promise<ProcessedGifFrame> {
	// 1. Get the frame as a buffer
	const frameStream = frameData.getImage();
	const chunks: Buffer[] = [];

	// Convert stream to buffer
	await new Promise<void>((resolve, reject) => {
		frameStream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		frameStream.on("end", () => resolve());
		frameStream.on("error", (error) => reject(error));
	});

	const frameBuffer = Buffer.concat(chunks);

	// 2. Process with sharp: resize and convert to JPEG
	const processedBuffer = await sharp(frameBuffer)
		.resize(config.maxWidth, undefined, {
			fit: "inside", // Maintain aspect ratio
			withoutEnlargement: true, // Don't upscale small images
		})
		.jpeg({
			quality: config.jpegQuality,
			progressive: true, // Progressive JPEG for better web performance
		})
		.toBuffer();

	// 3. Convert to base64
	const base64Data = processedBuffer.toString("base64");

	// 4. Log compression stats
	const originalSize = frameBuffer.length;
	const compressedSize = processedBuffer.length;
	const compressionRatio = ((1 - compressedSize / originalSize) * 100).toFixed(1);

	log.info(
		`GIF Processor: Processed frame ${frameNumber + 1}/${totalOutputFrames} ` +
		`(original index ${originalFrameIndex + 1}/${totalSourceFrames}): ` +
		`${originalSize} → ${compressedSize} bytes (${compressionRatio}% reduction)`,
	);

	return {
		data: base64Data,
		mimeType: "image/jpeg",
		frameNumber,
		totalFrames: totalSourceFrames,
		originalFrameIndex,
	};
}
