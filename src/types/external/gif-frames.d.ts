/**
 * Type definitions for gif-frames
 * Library for extracting frames from animated GIFs
 */

declare module "gif-frames" {
	/**
	 * Options for extracting GIF frames
	 */
	interface GifFramesOptions {
		/** URL or Buffer containing the GIF data */
		url: string | Buffer;
		/** Frame indices to extract - can be a number, array of numbers, or "all" */
		frames: number | number[] | "all";
		/** Whether to composite frames (important for GIFs with delta encoding) */
		cumulative?: boolean;
		/** Output type (defaults to "png") */
		outputType?: "png" | "jpg" | "bmp";
		/** Quality for JPEG output (0-100) */
		quality?: number;
	}

	/**
	 * Represents a single extracted frame
	 */
	interface GifFrame {
		/** Get the frame as a readable stream */
		getImage(): NodeJS.ReadableStream;
		/** Frame metadata */
		frameInfo?: {
			/** Frame dimensions */
			x?: number;
			y?: number;
			width?: number;
			height?: number;
			/** Frame delay in milliseconds */
			delay?: number;
			/** Disposal method */
			disposal?: number;
		};
	}

	/**
	 * Extract frames from a GIF
	 * @param options - Configuration options for frame extraction
	 * @returns Promise resolving to an array of extracted frames
	 */
	function gifFrames(options: GifFramesOptions): Promise<GifFrame[]>;

	export = gifFrames;
}
