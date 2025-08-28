/**
 * TypeScript types for enhanced context processing in function call tools
 * 
 * This module provides proper type definitions for extended content objects
 * that include additional properties for enhanced context processing in AI tools.
 */

/**
 * Base interface for enhanced context content objects.
 * Extends standard content with additional metadata for processing.
 */
export interface BaseEnhancedContent {
	/** Content type identifier */
	type: string;
	/** Special marker indicating enhanced context processing is required */
	enhancedContext: boolean;
}

/**
 * Enhanced video content object for YouTube video processing.
 * Used when tools need to provide video context with additional metadata.
 */
export interface EnhancedVideoContent extends BaseEnhancedContent {
	type: "video";
	/** Video URI */
	uri: string;
	/** MIME type for the video */
	mimeType: string;
	/** Flag indicating this is a YouTube link */
	isYouTubeLink: boolean;
}

/**
 * Enhanced image content object for profile picture and image processing.
 * Used when tools need to provide image context with additional metadata.
 */
export interface EnhancedImageContent extends BaseEnhancedContent {
	type: "image";
	/** Image URI (data URI or public URL) */
	uri: string;
	/** MIME type for the image */
	mimeType: string;
	/** Inline image data */
	inlineData: {
		/** MIME type for the image */
		mimeType: string;
		/** Base64 encoded image data */
		data: string;
	};
	/** Flag indicating this is a profile picture */
	isProfilePicture: boolean;
}

/**
 * Union type for all enhanced content types.
 * Used when a function can return various types of enhanced content.
 */
export type EnhancedContent = EnhancedVideoContent | EnhancedImageContent;

/**
 * Enhanced context message structure for AI tool responses.
 * Contains enhanced content objects for processing by AI providers.
 */
export interface EnhancedContextMessage {
	/** Array of enhanced content objects */
	contents: EnhancedContent[];
}