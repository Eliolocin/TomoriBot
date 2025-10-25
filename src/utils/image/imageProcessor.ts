/**
 * Image processing utilities for TomoriBot
 * Handles image manipulation tasks like cropping, resizing, and format conversion
 */

import sharp from "sharp";
import { log } from "../misc/logger";

/**
 * Center-crop an image to a 1:1 square aspect ratio
 * This is ideal for Discord avatar images which display best as squares
 *
 * @param buffer - Input image buffer (any format supported by Sharp)
 * @returns Promise<Buffer> - Output PNG buffer cropped to square
 *
 * @example
 * const squareImage = await centerCropToSquare(imageBuffer);
 * // Image is now 1:1 aspect ratio, centered from original
 */
export async function centerCropToSquare(buffer: Buffer): Promise<Buffer> {
	try {
		// 1. Get image metadata to determine current dimensions
		const metadata = await sharp(buffer).metadata();

		if (!metadata.width || !metadata.height) {
			throw new Error("Unable to read image dimensions");
		}

		log.info(
			`Processing image: ${metadata.width}x${metadata.height} (${metadata.format})`,
		);

		// 2. Determine the size of the square (use the smaller dimension)
		const squareSize = Math.min(metadata.width, metadata.height);

		// 3. Calculate the extraction position to center the crop
		// For a 1920x1080 image, we want to extract a 1080x1080 square from the center
		const left = Math.floor((metadata.width - squareSize) / 2);
		const top = Math.floor((metadata.height - squareSize) / 2);

		log.info(
			`Cropping to ${squareSize}x${squareSize} square (offset: ${left}x${top})`,
		);

		// 4. Extract the square region and convert to PNG
		const croppedBuffer = await sharp(buffer)
			.extract({
				left,
				top,
				width: squareSize,
				height: squareSize,
			})
			.png() // Convert to PNG format for consistency
			.toBuffer();

		log.info(
			`Image successfully cropped to square (${croppedBuffer.length} bytes)`,
		);

		return croppedBuffer;
	} catch (error) {
		log.error("Failed to crop image to square:", error);
		throw new Error(
			`Image processing failed: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Resize an image to a specific width while maintaining aspect ratio
 *
 * @param buffer - Input image buffer
 * @param targetWidth - Desired width in pixels
 * @returns Promise<Buffer> - Resized PNG buffer
 */
export async function resizeImage(
	buffer: Buffer,
	targetWidth: number,
): Promise<Buffer> {
	try {
		const resizedBuffer = await sharp(buffer)
			.resize({
				width: targetWidth,
				fit: "contain", // Maintain aspect ratio
			})
			.png()
			.toBuffer();

		log.info(`Image resized to ${targetWidth}px width`);
		return resizedBuffer;
	} catch (error) {
		log.error("Failed to resize image:", error);
		throw new Error(
			`Image resize failed: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Convert an image buffer to PNG format
 *
 * @param buffer - Input image buffer (any format)
 * @returns Promise<Buffer> - PNG buffer
 */
export async function convertToPNG(buffer: Buffer): Promise<Buffer> {
	try {
		const pngBuffer = await sharp(buffer).png().toBuffer();
		log.info("Image converted to PNG format");
		return pngBuffer;
	} catch (error) {
		log.error("Failed to convert image to PNG:", error);
		throw new Error(
			`Image conversion failed: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Get metadata from an image buffer
 *
 * @param buffer - Input image buffer
 * @returns Promise<sharp.Metadata> - Image metadata
 */
export async function getImageMetadata(
	buffer: Buffer,
): Promise<sharp.Metadata> {
	try {
		const metadata = await sharp(buffer).metadata();
		return metadata;
	} catch (error) {
		log.error("Failed to read image metadata:", error);
		throw new Error(
			`Image metadata read failed: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}
