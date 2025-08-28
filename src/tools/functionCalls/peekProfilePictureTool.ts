/**
 * Peek Profile Picture Tool
 * Allows the AI to selectively process Discord user profile pictures on-demand
 * This prevents automatic processing and enables targeted avatar analysis
 */

import { log } from "../../utils/misc/logger";
import type { EnhancedImageContent } from "@/types/tool/enhancedContextTypes";
// import { sendStandardEmbed } from "../../utils/discord/embedHelper";
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
 * Tool for processing Discord user profile pictures on-demand
 * Available for providers with image processing capabilities
 */
export class PeekProfilePictureTool extends BaseTool {
	/**
	 * Static map to store pending enhanced context items
	 * This prevents base64 data from being serialized in tool responses
	 * Keys are user IDs, values are enhanced context items with base64 data
	 */
	static pendingEnhancedContextItems = new Map<string, StructuredContextItem>();
	name = "peek_profile_picture";
	description =
		"Process and analyze a Discord user's profile picture using AI vision capabilities. ONLY use this when specifically asked to look at someone's avatar. If you don't see a user ID or mention in recent messages, avoid calling this function.";
	category = "utility" as const;

	parameters: ToolParameterSchema = {
		type: "object",
		properties: {
			user_id: {
				type: "string",
				description:
					"The Discord user ID (snowflake) of the user whose profile picture to analyze. Must be a valid 17-19 digit Discord ID.",
			},
			reason: {
				type: "string",
				description:
					"Optional brief explanation of why you want to analyze this user's profile picture. This helps with debugging and understanding AI decision-making.",
			},
		},
		required: ["user_id"],
	};

	/**
	 * Discord snowflake ID validation pattern
	 * Discord IDs are 17-19 digit snowflakes
	 */
	private static readonly DISCORD_ID_PATTERN = /^\d{17,19}$/;

	/**
	 * Check if profile picture tool is available for the given provider
	 * This tool requires providers with image processing capabilities
	 * @param provider - LLM provider name
	 * @returns True if provider supports image processing
	 */
	isAvailableFor(provider: string): boolean {
		// Available for providers that support image processing
		// Currently Google/Gemini is the primary provider with vision capabilities
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

		// Check for profile picture processing disable flag in context
		if (context?.streamContext?.disableProfilePictureProcessing) {
			log.info(
				"PeekProfilePictureTool: Temporarily disabled during enhanced context restart",
			);
			return false;
		}

		return true;
	}

	/**
	 * Execute profile picture processing
	 * @param args - Arguments containing user_id and optional reason
	 * @param context - Tool execution context
	 * @returns Promise resolving to tool result with processed image data
	 */
	async execute(
		args: Record<string, unknown>,
		context: ToolContext,
	): Promise<ToolResult> {
		// Check if profile picture processing is temporarily disabled during enhanced context restart
		if (context.streamContext?.disableProfilePictureProcessing) {
			log.info(
				"PeekProfilePictureTool: Execution blocked - Profile picture processing temporarily disabled during enhanced context restart",
			);
			return {
				success: false,
				error: "Profile picture processing is temporarily disabled",
				message:
					"Profile picture processing is temporarily disabled while analyzing another image.",
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
					"The user_id argument was missing or not in the expected format. Please provide a valid Discord user ID.",
			};
		}

		const userId = args.user_id as string;
		const reason = (args.reason as string) || "User-requested avatar analysis";

		log.info(
			`Processing profile picture for user ID: ${userId} - Reason: ${reason}`,
		);

		try {
			// Validate Discord user ID format
			if (!this.isValidDiscordId(userId)) {
				return {
					success: false,
					error: "Invalid Discord user ID format",
					message:
						"The provided user ID is not a valid Discord snowflake ID. Please provide a valid Discord user ID (17-19 digits).",
					data: {
						status: "invalid_user_id",
						provided_id: userId,
						expected_format: "17-19 digit snowflake ID",
					},
				};
			}

			// Fetch user and avatar URL
			const avatarData = await this.fetchUserAvatar(userId, context);

			// Fetch and convert the avatar image to base64
			const base64ImageData = await this.fetchAndConvertImageToBase64(
				avatarData.avatarUrl,
			);

			log.success(
				`Profile picture processed for enhanced context restart: ${userId} (Username: ${avatarData.username})`,
			);

			// Create artificial user message containing the profile picture Part
			// This will be added to the context for the restart
			// Special marker 'enhancedContext: true' indicates this should be processed by provider
			const imageContextItem: StructuredContextItem = {
				role: "user",
				metadataTag: ContextItemTag.DIALOGUE_HISTORY,
				parts: [
					{
						type: "text",
						text: `[This message contains profile picture content from a previous avatar analysis request you made for user: ${avatarData.username}]`,
					},
					{
						type: "image",
						uri: `data:image/png;base64,${base64ImageData}`,
						mimeType: "image/png",
						inlineData: {
							mimeType: "image/png",
							data: base64ImageData,
						},
						isProfilePicture: true,
						enhancedContext: true, // Special marker for processing
					} as EnhancedImageContent,
				],
			};

			// Return completely clean response following BraveSearchHandler pattern
			// Store image data externally and return clean text only
			// This prevents rate limit issues while still triggering enhanced context restart
			
			// Store the enhanced context item in a module-level map for tomoriChat to access
			// This is the cleanest way to avoid serializing base64 data in tool responses
			PeekProfilePictureTool.pendingEnhancedContextItems.set(userId, imageContextItem);
			
			return {
				success: true,
				message: `Profile picture analyzed for user: ${avatarData.username}. Image processing completed and ready for enhanced context restart.`,
				data: {
					type: "context_restart_with_image",
					user_id: userId,
					username: avatarData.username,
					avatar_url: avatarData.avatarUrl,
					reason: reason,
					// Clean metadata only - no base64 data anywhere in response
					image_processed: true,
					status: "completed",
					has_pending_context: true,
				},
			};
		} catch (error) {
			log.error(
				`Profile picture processing failed for user ID: ${userId}`,
				error as Error,
			);

			// Categorize errors for better user experience
			let errorMessage = "Failed to process the user's profile picture.";
			let errorStatus = "profile_processing_failed";

			if (error instanceof Error) {
				if (
					error.message.includes("User with ID") &&
					error.message.includes("not found")
				) {
					errorMessage = `User with ID ${userId} was not found on Discord. Please check the user ID and try again.`;
					errorStatus = "user_not_found";
				} else if (error.message.includes("privacy settings")) {
					errorMessage =
						"Cannot access this user's profile due to privacy settings.";
					errorStatus = "privacy_restricted";
				} else if (error.message.includes("Avatar image processing failed")) {
					errorMessage =
						"Failed to download and process the user's avatar image. The image may be corrupted or inaccessible.";
					errorStatus = "image_processing_failed";
				} else if (error.message.includes("Failed to fetch avatar image")) {
					errorMessage =
						"Could not download the avatar image from Discord's servers. Please try again later.";
					errorStatus = "image_fetch_failed";
				}
			}

			return {
				success: false,
				error:
					error instanceof Error
						? error.message
						: "Unknown error occurred during profile picture processing",
				message: errorMessage,
				data: {
					status: errorStatus,
					provided_user_id: userId,
					reason: error instanceof Error ? error.message : "Unknown error",
				},
			};
		}
	}

	/**
	 * Validate Discord user ID format using snowflake pattern
	 * @param userId - Discord user ID to validate
	 * @returns True if ID matches Discord snowflake format
	 */
	private isValidDiscordId(userId: string): boolean {
		return PeekProfilePictureTool.DISCORD_ID_PATTERN.test(userId);
	}

	/**
	 * Fetch Discord user and their avatar URL
	 * @param userId - Discord user ID
	 * @param context - Tool execution context containing Discord client
	 * @returns Promise resolving to user data with avatar URL
	 */
	private async fetchUserAvatar(
		userId: string,
		context: ToolContext,
	): Promise<{ username: string; avatarUrl: string }> {
		try {
			// Fetch user from Discord API
			const user = await context.client.users.fetch(userId);

			// Get high-resolution avatar URL
			// Use displayAvatarURL to get either custom avatar or default Discord avatar
			const avatarUrl = user.displayAvatarURL({
				size: 1024,
				extension: "png",
				forceStatic: false, // Allow animated avatars if present
			});

			return {
				username: user.username,
				avatarUrl: avatarUrl,
			};
		} catch (error) {
			if (error instanceof Error) {
				// Handle specific Discord API errors
				if (error.message.includes("Unknown User")) {
					throw new Error(`User with ID ${userId} not found on Discord`);
				}
				if (error.message.includes("Missing Permissions")) {
					throw new Error(
						`Cannot access user ${userId} due to privacy settings`,
					);
				}
				throw new Error(`Discord API error: ${error.message}`);
			}
			throw new Error("Unknown error while fetching user from Discord");
		}
	}

	/**
	 * Fetch avatar image from Discord CDN and convert to base64
	 * @param avatarUrl - Discord avatar URL to fetch
	 * @returns Promise resolving to base64 encoded image data
	 */
	private async fetchAndConvertImageToBase64(
		avatarUrl: string,
	): Promise<string> {
		try {
			// Fetch the image from Discord CDN
			const response = await fetch(avatarUrl);

			if (!response.ok) {
				throw new Error(
					`Failed to fetch avatar image: ${response.status} ${response.statusText}`,
				);
			}

			// Get the image as array buffer
			const imageBuffer = await response.arrayBuffer();

			// Convert array buffer to base64
			const base64String = Buffer.from(imageBuffer).toString("base64");

			return base64String;
		} catch (error) {
			log.error(
				`Failed to fetch and convert avatar image: ${avatarUrl}`,
				error as Error,
			);

			if (error instanceof Error) {
				throw new Error(`Avatar image processing failed: ${error.message}`);
			}
			throw new Error("Unknown error occurred while processing avatar image");
		}
	}

	/**
	 * Helper method to check if a user ID is a valid Discord snowflake
	 * @param userId - User ID to validate
	 * @returns True if the ID matches Discord snowflake patterns
	 */
	static isValidDiscordUserId(userId: string): boolean {
		return PeekProfilePictureTool.DISCORD_ID_PATTERN.test(userId);
	}

	/**
	 * Get and remove pending enhanced context item for a user
	 * Used by tomoriChat during restart processing
	 * @param userId - User ID to get pending context for
	 * @returns Enhanced context item if found, undefined otherwise
	 */
	static getPendingEnhancedContext(userId: string): StructuredContextItem | undefined {
		const contextItem = PeekProfilePictureTool.pendingEnhancedContextItems.get(userId);
		if (contextItem) {
			// Remove from map to prevent memory leaks
			PeekProfilePictureTool.pendingEnhancedContextItems.delete(userId);
		}
		return contextItem;
	}

	/**
	 * Check if a user has pending enhanced context
	 * @param userId - User ID to check
	 * @returns True if user has pending enhanced context
	 */
	static hasPendingEnhancedContext(userId: string): boolean {
		return PeekProfilePictureTool.pendingEnhancedContextItems.has(userId);
	}

	/**
	 * Clear all pending enhanced context items (for cleanup)
	 */
	static clearAllPendingEnhancedContext(): void {
		PeekProfilePictureTool.pendingEnhancedContextItems.clear();
	}
}
