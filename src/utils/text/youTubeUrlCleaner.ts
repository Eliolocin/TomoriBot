/**
 * YouTube URL Cleaning Utility
 * Provides functions to detect and remove YouTube URLs from text content
 * 
 * Used primarily for enhanced context restart to prevent infinite loops
 * where TomoriBot keeps seeing YouTube URLs after processing them as video parts
 */

/**
 * YouTube URL detection patterns (matches those used in youTubeVideoTool.ts)
 * Supports various YouTube URL formats
 */
export const YOUTUBE_URL_PATTERNS = [
	/(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/gi,
	/(?:https?:\/\/)?(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]{11})/gi,
	/(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/gi,
	/(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/gi,
];

/**
 * Extract all YouTube URLs from text content
 * @param text - Text content to search for YouTube URLs
 * @returns Array of YouTube URLs found in the text
 */
export function extractYouTubeUrls(text: string): string[] {
	const urls: string[] = [];
	
	for (const pattern of YOUTUBE_URL_PATTERNS) {
		// Reset regex lastIndex to ensure proper matching
		pattern.lastIndex = 0;
		
		let match: RegExpExecArray | null;
		// biome-ignore lint/suspicious/noAssignInExpressions: RegExp.exec() pattern requires assignment in expression
		while ((match = pattern.exec(text)) !== null) {
			urls.push(match[0]);
		}
		
		// Reset again after processing
		pattern.lastIndex = 0;
	}
	
	// Remove duplicates and return
	return [...new Set(urls)];
}

/**
 * Extract all YouTube video IDs from text content
 * @param text - Text content to search for YouTube URLs
 * @returns Array of unique YouTube video IDs
 */
export function extractYouTubeVideoIds(text: string): string[] {
	const videoIds: string[] = [];
	
	for (const pattern of YOUTUBE_URL_PATTERNS) {
		// Reset regex lastIndex to ensure proper matching
		pattern.lastIndex = 0;
		
		let match: RegExpExecArray | null;
		// biome-ignore lint/suspicious/noAssignInExpressions: RegExp.exec() pattern requires assignment in expression
		while ((match = pattern.exec(text)) !== null) {
			if (match[1]) {
				videoIds.push(match[1]);
			}
		}
		
		// Reset again after processing
		pattern.lastIndex = 0;
	}
	
	// Remove duplicates and return
	return [...new Set(videoIds)];
}

/**
 * Remove all YouTube URLs from text content
 * Replaces YouTube URLs with optional replacement text
 * @param text - Text content to clean
 * @param replacement - Optional replacement text (default: empty string)
 * @returns Text with YouTube URLs removed/replaced
 */
export function removeYouTubeUrls(
	text: string, 
	replacement = ""
): string {
	let cleanedText = text;
	
	for (const pattern of YOUTUBE_URL_PATTERNS) {
		// Reset regex lastIndex to ensure proper matching
		pattern.lastIndex = 0;
		cleanedText = cleanedText.replace(pattern, replacement);
		// Reset again after processing
		pattern.lastIndex = 0;
	}
	
	// Clean up any extra whitespace that might result from URL removal
	return cleanedText.replace(/\s+/g, " ").trim();
}

/**
 * Replace YouTube URLs with descriptive placeholders
 * Useful for maintaining context while preventing function call loops
 * @param text - Text content to process
 * @param placeholder - Placeholder text template (default includes video ID)
 * @returns Text with YouTube URLs replaced with placeholders
 */
export function replaceYouTubeUrlsWithPlaceholders(
	text: string,
	placeholder = "[YouTube video processed]"
): string {
	let processedText = text;
	
	for (const pattern of YOUTUBE_URL_PATTERNS) {
		// Reset regex lastIndex to ensure proper matching
		pattern.lastIndex = 0;
		
		processedText = processedText.replace(pattern, (_, videoId) => {
			// If placeholder contains {videoId}, replace it with actual video ID
			if (placeholder.includes("{videoId}") && videoId) {
				return placeholder.replace("{videoId}", videoId);
			}
			return placeholder;
		});
		
		// Reset again after processing
		pattern.lastIndex = 0;
	}
	
	return processedText.replace(/\s+/g, " ").trim();
}

/**
 * Check if text contains any YouTube URLs
 * @param text - Text content to check
 * @returns True if text contains YouTube URLs
 */
export function containsYouTubeUrls(text: string): boolean {
	for (const pattern of YOUTUBE_URL_PATTERNS) {
		// Reset regex lastIndex to ensure proper matching
		pattern.lastIndex = 0;
		if (pattern.test(text)) {
			// Reset after test
			pattern.lastIndex = 0;
			return true;
		}
		// Reset again just to be safe
		pattern.lastIndex = 0;
	}
	return false;
}

/**
 * Get statistics about YouTube URLs in text
 * @param text - Text content to analyze
 * @returns Object with URL count and unique video IDs
 */
export function getYouTubeUrlStats(text: string): {
	urlCount: number;
	uniqueVideoIds: string[];
	urls: string[];
} {
	const urls = extractYouTubeUrls(text);
	const videoIds = extractYouTubeVideoIds(text);
	
	return {
		urlCount: urls.length,
		uniqueVideoIds: videoIds,
		urls: urls,
	};
}