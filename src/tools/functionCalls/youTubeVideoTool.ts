/**
 * YouTube Video Processing Tool
 * Allows the AI to selectively process YouTube videos on-demand for Google/Gemini provider
 * This prevents automatic processing of all YouTube links which can cause timeouts
 */

import { log, ColorCode } from "../../utils/misc/logger";
import type { EnhancedVideoContent } from "@/types/tool/enhancedContextTypes";
import { sendStandardEmbed } from "../../utils/discord/embedHelper";
import {
	BaseTool,
	type ToolContext,
	type ToolResult,
	type ToolParameterSchema,
} from "../../types/tool/interfaces";
import {
	ContextItemTag,
	type StructuredContextItem,
} from "../../types/misc/context";

/**
 * Tool for processing YouTube videos on-demand using Google's Gemini API
 * Only available for Google provider to leverage Gemini's YouTube processing capabilities
 */
export class YouTubeVideoTool extends BaseTool {
	name = "process_youtube_video";
	description =
		"Process and analyze a specific YouTube video using Google's video understanding capabilities. ONLY use this when needed as it costs a lot of processing power. Use sparingly. If you don't see any YouTube URLs in recent messages, it likely means you're already analyzing video content and should NOT call this function again.";
	category = "utility" as const;

	parameters: ToolParameterSchema = {
		type: "object",
		properties: {
			youtube_url: {
				type: "string",
				description:
					"The complete YouTube URL to process. Must be a valid YouTube URL that the user provided. Supports youtube.com/watch, youtu.be, youtube.com/embed, and youtube.com/shorts formats.",
			},
			reason: {
				type: "string",
				description:
					"Optional brief explanation of why you want to process this specific video. This helps with debugging and understanding AI decision-making.",
			},
		},
		required: ["youtube_url"],
	};

	/**
	 * YouTube URL detection patterns (from tomoriChat.ts)
	 */
	private static readonly YOUTUBE_URL_PATTERNS = [
		/(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/i,
		/(?:https?:\/\/)?(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]{11})/i,
		/(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/i,
		/(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/i,
	];

	/**
	 * Check if YouTube tool is available for the given provider
	 * This tool is exclusively for Google/Gemini provider
	 * Also checks if YouTube processing is temporarily disabled during enhanced context restart
	 * @param provider - LLM provider name
	 * @returns True only if provider is "google" and YouTube processing is not disabled
	 */
	isAvailableFor(provider: string): boolean {
		return provider === "google";
	}

	/**
	 * Enhanced availability check that considers context flags
	 * @param provider - LLM provider name
	 * @param context - Tool context that may contain disable flags
	 * @returns True if tool should be available
	 */
	isAvailableForContext(provider: string, context?: ToolContext): boolean {
		// Base provider check
		if (!this.isAvailableFor(provider)) {
			return false;
		}

		// Check for YouTube processing disable flag in context
		if (context?.streamContext?.disableYouTubeProcessing) {
			log.info(
				"YouTubeVideoTool: Temporarily disabled during enhanced context restart",
			);
			return false;
		}

		return true;
	}

	/**
	 * Execute YouTube video processing
	 * @param args - Arguments containing youtube_url and optional reason
	 * @param context - Tool execution context
	 * @returns Promise resolving to tool result with processed video data
	 */
	async execute(
		args: Record<string, unknown>,
		context: ToolContext,
	): Promise<ToolResult> {
		// Check if YouTube processing is temporarily disabled during enhanced context restart
		if (context.streamContext?.disableYouTubeProcessing) {
			log.info(
				"YouTubeVideoTool: Execution blocked - YouTube processing temporarily disabled during enhanced context restart",
			);
			return {
				success: false,
				error: "YouTube processing is temporarily disabled",
				message:
					"YouTube video processing is temporarily disabled while analyzing another video.",
				data: {
					status: "temporarily_disabled",
					reason: "Enhanced context restart in progress",
				},
			};
		}

		// Validate parameters
		const validation = this.validateParameters(args);
		if (!validation.isValid) {
			return {
				success: false,
				error: `Invalid parameters: ${validation.errors?.join(", ") || `Missing required parameters: ${validation.missingParams?.join(", ")}`}`,
				message:
					"The youtube_url argument was missing or not in the expected format. Please provide a valid YouTube URL.",
			};
		}

		const youtubeUrl = args.youtube_url as string;
		const reason = (args.reason as string) || "User-requested video analysis";

		log.info(`Processing YouTube video: ${youtubeUrl} - Reason: ${reason}`);

		// Send notification embed to user about YouTube processing
		try {
			await sendStandardEmbed(context.channel, context.locale, {
				titleKey: "genai.video.youtube_processing_title",
				descriptionKey: "genai.video.youtube_processing_description",
				descriptionVars: { video_url: youtubeUrl },
				color: ColorCode.INFO,
			});
		} catch (embedError) {
			// Log but don't fail the tool execution if embed fails
			log.warn(
				`Failed to send YouTube processing notification embed: ${embedError instanceof Error ? embedError.message : String(embedError)}`,
			);
		}

		try {
			// Validate YouTube URL using existing patterns
			const videoId = this.extractVideoId(youtubeUrl);
			if (!videoId) {
				return {
					success: false,
					error: "Invalid YouTube URL format",
					message:
						"The provided URL is not a valid YouTube URL. Please provide a valid YouTube link (youtube.com/watch, youtu.be, youtube.com/embed, or youtube.com/shorts).",
					data: {
						status: "invalid_url",
						provided_url: youtubeUrl,
						supported_formats: [
							"youtube.com/watch?v=...",
							"youtu.be/...",
							"youtube.com/embed/...",
							"youtube.com/shorts/...",
						],
					},
				};
			}

			log.success(
				`YouTube video validated for enhanced context restart: ${youtubeUrl} (ID: ${videoId})`,
			);

			// Create artificial user message containing the YouTube video Part
			// This will be added to the context for the restart
			// Special marker 'enhancedContext: true' indicates this should be processed by googleStreamAdapter
			const videoContextItem: StructuredContextItem = {
				role: "user",
				metadataTag: ContextItemTag.DIALOGUE_HISTORY,
				parts: [
					{
						type: "text",
						text: "[This message contains video content from a previous YouTube processing request you made]",
					},
					{
						type: "video",
						uri: youtubeUrl,
						mimeType: "video/youtube",
						isYouTubeLink: true,
						enhancedContext: true, // Special marker for processing
					} as EnhancedVideoContent,
				],
			};

			// Return restart signal with enhanced context
			return {
				success: true,
				message:
					"YouTube video processing initiated - restarting with enhanced context",
				data: {
					type: "context_restart_with_video",
					video_id: videoId,
					video_url: youtubeUrl,
					reason: reason,
					// Enhanced context item to add
					enhanced_context_item: videoContextItem,
				},
			};
		} catch (error) {
			log.error(
				`YouTube video processing failed for URL: ${youtubeUrl}`,
				error as Error,
			);

			return {
				success: false,
				error:
					error instanceof Error
						? error.message
						: "Unknown error occurred during YouTube video processing",
				message:
					"Failed to process the YouTube video. This could be due to an invalid URL, network issues, or the video being unavailable. Please try with a different video URL.",
				data: {
					status: "video_processing_failed",
					provided_url: youtubeUrl,
					reason: error instanceof Error ? error.message : "Unknown error",
				},
			};
		}
	}

	/**
	 * Extract video ID from YouTube URL using existing patterns from tomoriChat.ts
	 * @param url - YouTube URL to extract ID from
	 * @returns Video ID string or null if not found
	 */
	private extractVideoId(url: string): string | null {
		for (const pattern of YouTubeVideoTool.YOUTUBE_URL_PATTERNS) {
			const match = url.match(pattern);
			if (match?.[1]) {
				return match[1];
			}
		}
		return null;
	}

	/**
	 * Helper method to check if a URL is a valid YouTube URL
	 * @param url - URL to validate
	 * @returns True if the URL matches YouTube patterns
	 */
	static isValidYouTubeUrl(url: string): boolean {
		return YouTubeVideoTool.YOUTUBE_URL_PATTERNS.some((pattern) =>
			pattern.test(url),
		);
	}

	/**
	 * Helper method to get all video IDs from a text containing multiple YouTube URLs
	 * @param text - Text that may contain YouTube URLs
	 * @returns Array of extracted video IDs
	 */
	static extractAllVideoIds(text: string): string[] {
		const videoIds: string[] = [];
		for (const pattern of YouTubeVideoTool.YOUTUBE_URL_PATTERNS) {
			const matches = text.matchAll(
				new RegExp(pattern.source, `${pattern.flags}g`),
			);
			for (const match of matches) {
				if (match[1]) {
					videoIds.push(match[1]);
				}
			}
		}
		// Remove duplicates
		return [...new Set(videoIds)];
	}
}
