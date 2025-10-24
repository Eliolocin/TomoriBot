/**
 * PNG Metadata Utilities
 * Handles embedding and extracting JSON metadata in PNG tEXt chunks
 * Based on PNG specification: http://www.libpng.org/pub/png/spec/1.2/PNG-Chunks.html
 */

import type { PresetExport } from "../../types/preset/presetExport";
import { log } from "../misc/logger";

/**
 * PNG file signature (magic bytes)
 * Every PNG file must start with these 8 bytes
 */
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * PNG chunk types used in this implementation
 */
const TEXT_CHUNK_TYPE = "tEXt"; // Uncompressed text chunk
const IEND_CHUNK_TYPE = "IEND"; // End of PNG datastream marker

/**
 * Metadata key identifier for TomoriBot preset data
 * This key is used in the tEXt chunk to identify our JSON data
 */
const METADATA_KEY = "TomoriPreset";

/**
 * Reads a 4-byte big-endian unsigned integer from a byte array
 * @param data - Byte array to read from
 * @param offset - Position to start reading
 * @returns 32-bit unsigned integer
 */
function readUint32(data: Uint8Array, offset: number): number {
	return (
		(data[offset] << 24) |
		(data[offset + 1] << 16) |
		(data[offset + 2] << 8) |
		data[offset + 3]
	);
}

/**
 * Writes a 4-byte big-endian unsigned integer to a byte array
 * @param data - Byte array to write to
 * @param offset - Position to start writing
 * @param value - 32-bit unsigned integer to write
 */
function writeUint32(data: Uint8Array, offset: number, value: number): void {
	data[offset] = (value >>> 24) & 0xff;
	data[offset + 1] = (value >>> 16) & 0xff;
	data[offset + 2] = (value >>> 8) & 0xff;
	data[offset + 3] = value & 0xff;
}

/**
 * Converts a string to a UTF-8 byte array
 * @param str - String to convert
 * @returns Uint8Array containing UTF-8 encoded bytes
 */
function stringToBytes(str: string): Uint8Array {
	const encoder = new TextEncoder();
	return encoder.encode(str);
}

/**
 * Calculates CRC32 checksum for PNG chunk data
 * CRC32 is used to detect data corruption in PNG chunks
 * @param data - Byte array containing chunk type and chunk data
 * @param offset - Starting position in the array
 * @param length - Number of bytes to include in CRC calculation
 * @returns 32-bit CRC32 checksum
 */
function calculateCRC(
	data: Uint8Array,
	offset: number,
	length: number,
): number {
	// 1. Generate CRC32 lookup table (standard polynomial 0xEDB88320)
	const crcTable: number[] = [];
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let j = 0; j < 8; j++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		crcTable[i] = c;
	}

	// 2. Calculate CRC32 over the data
	let crc = 0xffffffff;
	for (let i = 0; i < length; i++) {
		crc = crcTable[(crc ^ data[offset + i]) & 0xff] ^ (crc >>> 8);
	}

	// 3. Return final CRC (inverted)
	return crc ^ 0xffffffff;
}

/**
 * Verifies that a buffer starts with a valid PNG signature
 * @param data - Buffer to verify
 * @returns True if buffer starts with PNG signature
 */
function verifyPNGSignature(data: Uint8Array): boolean {
	// 1. Check if buffer is long enough to contain signature
	if (data.length < PNG_SIGNATURE.length) {
		return false;
	}

	// 2. Compare each byte of the signature
	for (let i = 0; i < PNG_SIGNATURE.length; i++) {
		if (data[i] !== PNG_SIGNATURE[i]) {
			return false;
		}
	}

	return true;
}

/**
 * Extracts TomoriBot preset metadata from a PNG file
 * @param pngBuffer - PNG file as Buffer
 * @returns PresetExport object if found, null otherwise
 */
export function extractMetadataFromPNG(
	pngBuffer: Buffer,
): PresetExport | null {
	try {
		// 1. Convert Buffer to Uint8Array for processing
		const data = new Uint8Array(pngBuffer);

		// 2. Verify PNG signature
		if (!verifyPNGSignature(data)) {
			log.warn("Invalid PNG signature detected during metadata extraction");
			return null;
		}

		// 3. Start reading chunks after PNG signature
		let offset = PNG_SIGNATURE.length;

		// 4. Parse PNG chunks until we find our metadata or reach the end
		while (offset < data.length) {
			// Read chunk length (4 bytes)
			const length = readUint32(data, offset);
			offset += 4;

			// Read chunk type (4 bytes as ASCII)
			const chunkType = String.fromCharCode(
				data[offset],
				data[offset + 1],
				data[offset + 2],
				data[offset + 3],
			);
			offset += 4;

			// Check if this is a tEXt chunk
			if (chunkType === TEXT_CHUNK_TYPE) {
				// 5. Parse tEXt chunk to extract key-value pair
				// Format: keyword (null-terminated) + text data

				// Find the null terminator that separates key from value
				let keyEnd = offset;
				while (keyEnd < offset + length && data[keyEnd] !== 0) {
					keyEnd++;
				}

				// Extract the key
				const key = String.fromCharCode(...data.slice(offset, keyEnd));

				// 6. Check if this is our TomoriPreset metadata
				if (key === METADATA_KEY && keyEnd + 1 < offset + length) {
					// Extract the value (JSON string)
					const value = new TextDecoder().decode(
						data.slice(keyEnd + 1, offset + length),
					);

					// 7. Parse and return the JSON data
					try {
						const parsed = JSON.parse(value) as PresetExport;
						log.success("Successfully extracted TomoriPreset metadata from PNG");
						return parsed;
					} catch (error) {
						log.error(
							"Failed to parse TomoriPreset JSON metadata:",
							error as Error,
						);
						return null;
					}
				}
			}

			// 8. Move to the next chunk
			offset += length; // Skip chunk data
			offset += 4; // Skip CRC
		}

		// No metadata found
		log.info("No TomoriPreset metadata found in PNG");
		return null;
	} catch (error) {
		log.error("Error extracting metadata from PNG:", error as Error);
		return null;
	}
}

/**
 * Embeds TomoriBot preset metadata into a PNG file
 * Inserts a tEXt chunk before the IEND chunk
 * @param pngBuffer - Original PNG file as Buffer
 * @param metadata - PresetExport object to embed
 * @returns New PNG Buffer with embedded metadata
 */
export function embedMetadataInPNG(
	pngBuffer: Buffer,
	metadata: PresetExport,
): Buffer {
	try {
		// 1. Convert Buffer to Uint8Array for processing
		const data = new Uint8Array(pngBuffer);

		// 2. Verify PNG signature
		if (!verifyPNGSignature(data)) {
			throw new Error("Invalid PNG signature");
		}

		// 3. Find the IEND chunk position
		// We need to insert our metadata chunk BEFORE IEND
		let offset = PNG_SIGNATURE.length;
		let iendOffset = -1;

		while (offset < data.length) {
			const length = readUint32(data, offset);
			offset += 4;

			const chunkType = String.fromCharCode(
				data[offset],
				data[offset + 1],
				data[offset + 2],
				data[offset + 3],
			);

			if (chunkType === IEND_CHUNK_TYPE) {
				iendOffset = offset - 4; // Store position before IEND chunk
				break;
			}

			offset += 4; // Skip chunk type
			offset += length; // Skip chunk data
			offset += 4; // Skip CRC
		}

		if (iendOffset === -1) {
			throw new Error("Could not find IEND chunk in PNG");
		}

		// 4. Prepare the metadata chunk
		// Format: key (null-terminated) + JSON value
		const metadataJSON = JSON.stringify(metadata);
		const keyBytes = stringToBytes(`${METADATA_KEY}\0`); // Null terminator
		const valueBytes = stringToBytes(metadataJSON);

		// Combine key and value into chunk data
		const chunkData = new Uint8Array(keyBytes.length + valueBytes.length);
		chunkData.set(keyBytes, 0);
		chunkData.set(valueBytes, keyBytes.length);

		const chunkLength = chunkData.length;

		// 5. Calculate the new PNG size
		// Original size + chunk header (4 bytes length + 4 bytes type) + chunk data + CRC (4 bytes)
		const newPngSize = data.length + 12 + chunkLength;
		const newPngData = new Uint8Array(newPngSize);

		// 6. Build the new PNG file
		// Copy everything up to the IEND chunk
		newPngData.set(data.slice(0, iendOffset));

		let writeOffset = iendOffset;

		// Write chunk length
		writeUint32(newPngData, writeOffset, chunkLength);
		writeOffset += 4;

		// Write chunk type (tEXt)
		const typeBytes = stringToBytes(TEXT_CHUNK_TYPE);
		newPngData.set(typeBytes, writeOffset);
		writeOffset += 4;

		// Write chunk data
		newPngData.set(chunkData, writeOffset);
		writeOffset += chunkLength;

		// 7. Calculate and write CRC for the chunk
		// CRC is calculated over chunk type + chunk data
		const crcData = new Uint8Array(4 + chunkLength);
		crcData.set(typeBytes);
		crcData.set(chunkData, 4);
		const crc = calculateCRC(crcData, 0, crcData.length);
		writeUint32(newPngData, writeOffset, crc);
		writeOffset += 4;

		// 8. Copy IEND chunk and everything after
		newPngData.set(data.slice(iendOffset), writeOffset);

		log.success(
			`Successfully embedded TomoriPreset metadata (${metadataJSON.length} bytes) into PNG`,
		);

		// 9. Convert back to Buffer and return
		return Buffer.from(newPngData);
	} catch (error) {
		log.error("Error embedding metadata in PNG:", error as Error);
		throw error;
	}
}
