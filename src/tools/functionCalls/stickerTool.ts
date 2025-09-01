/**
 * Discord Sticker Selection Tool
 * Allows the AI to select appropriate stickers to accompany responses
 */

import { log } from "../../utils/misc/logger";
import {
	BaseTool,
	type ToolContext,
	type ToolResult,
	type ToolParameterSchema,
} from "../../types/tool/interfaces";

/**
 * Tool for selecting Discord stickers based on conversational context
 */
export class StickerTool extends BaseTool {
	name = "select_sticker_for_response";
	description =
		"Selects a specific sticker from the available server stickers that is relevant to the current conversational context. Use this to choose a sticker that expresses an emotion or reaction aligning with the sticker's name or description. You will be informed of the selection result and will then generate the final text message for the user.";
	category = "discord" as const;
	requiresFeatureFlag = "sticker_usage";
	requiresPermissions = ["USE_EXTERNAL_STICKERS"];

	parameters: ToolParameterSchema = {
		type: "object",
		properties: {
			sticker_id: {
				type: "string",
				description:
					"The unique Discord ID of the sticker to select (e.g., '123456789012345678'). This ID must be from the provided list of available server stickers.",
			},
		},
		required: ["sticker_id"],
	};

	/**
	 * Check if sticker tool is available for the given provider
	 * @param _provider - LLM provider name (unused)
	 * @returns True if provider supports sticker selection
	 */
	isAvailableFor(_provider: string): boolean {
		// Stickers work with all providers
		return true;
	}

	/**
	 * Check if sticker functionality is enabled in Tomori config
	 * @param context - Tool execution context
	 * @returns True if sticker usage is enabled
	 */
	protected isEnabled(context: ToolContext): boolean {
		return context.tomoriState.config.sticker_usage_enabled;
	}

	/**
	 * Execute sticker selection - Real implementation from tomoriChat.ts
	 * @param args - Arguments containing sticker_id
	 * @param context - Tool execution context
	 * @returns Promise resolving to tool result
	 */
	async execute(
		args: Record<string, unknown>,
		context: ToolContext,
	): Promise<ToolResult> {
		// Validate parameters
		const validation = this.validateParameters(args);
		if (!validation.isValid) {
			return {
				success: false,
				error: `Invalid parameters: ${validation.errors?.join(", ") || `Missing required parameters: ${validation.missingParams?.join(", ")}`}`,
				message:
					"The sticker_id argument was missing or not in the expected format. Please provide a valid sticker_id string.",
			};
		}

		// Check if tool is enabled
		if (!this.isEnabled(context)) {
			return {
				success: false,
				error: "Sticker usage is disabled for this server",
				message: "Sticker functionality is not enabled for this server.",
			};
		}

		// Check if this is a DM channel - stickers are not available in DMs
		if (!('guild' in context.channel)) {
			return {
				success: false,
				error: "Stickers not available in DMs",
				message: "Stickers are not available in Direct Messages.",
			};
		}

		const stickerId = args.sticker_id as string;

		try {
			log.info(`Attempting to select sticker: ${stickerId}`);

			// Get the guild from channel context
			const guild = context.channel.guild;

			// Get stickers from guild cache (direct implementation from tomoriChat.ts)
			const selectedSticker = guild.stickers.cache.get(stickerId);

			if (selectedSticker) {
				// Success case - sticker found (from tomoriChat.ts:947-957)
				log.success(
					`Sticker '${selectedSticker.name}' (${stickerId}) found locally`,
				);

				return {
					success: true,
					message: "Sticker selected successfully",
					data: {
						// Return format matching tomoriChat.ts functionExecutionResult
						status: "sticker_selected_successfully",
						sticker_id: selectedSticker.id,
						sticker_name: selectedSticker.name,
						sticker_description:
							selectedSticker.description || "No description available",
						// Additional data for compatibility
						sticker: selectedSticker,
					},
				};
			}

			// Sticker not found case (from tomoriChat.ts:958-969)
			log.warn(
				`Sticker with ID ${stickerId} not found in server cache. Informing LLM.`,
			);

			// Get available stickers for error message
			const availableStickers = guild.stickers.cache;
			const availableStickerData = availableStickers
				.map((sticker) => ({
					id: sticker.id,
					name: sticker.name,
					description: sticker.description || "No description available",
				}))
				.slice(0, 10); // Limit to prevent overwhelming the LLM

			return {
				success: false,
				error: "Sticker not found",
				message:
					"The sticker ID provided was not found among the available server stickers. Please choose from the provided list or do not use a sticker.",
				data: {
					// Return format matching tomoriChat.ts functionExecutionResult
					status: "sticker_not_found",
					sticker_id_attempted: stickerId,
					reason:
						"The sticker ID provided was not found among the available server stickers. Please choose from the provided list or do not use a sticker.",
					availableStickers: availableStickerData,
				},
			};
		} catch (error) {
			log.error(
				`Sticker selection failed for ID: ${stickerId}`,
				error as Error,
			);

			return {
				success: false,
				error:
					error instanceof Error
						? error.message
						: "Unknown error occurred during sticker selection",
				message:
					"Failed to select the requested sticker. Please try with a different sticker.",
				data: {
					status: "sticker_selection_failed_error",
					reason: error instanceof Error ? error.message : "Unknown error",
				},
			};
		}
	}

	/**
	 * Get available stickers for context building
	 * This helper method can be used to provide sticker options to the LLM
	 * @param context - Tool context
	 * @returns Array of available sticker information
	 */
	static getAvailableStickers(context: ToolContext): Array<{
		id: string;
		name: string;
		description: string;
	}> {
		try {
			// Return empty array for DM channels - no stickers available
			if (!('guild' in context.channel)) {
				return [];
			}

			const guild = context.channel.guild;
			const availableStickers = guild.stickers.cache;

			return availableStickers
				.map((sticker) => ({
					id: sticker.id,
					name: sticker.name,
					description: sticker.description || "No description available",
				}))
				.slice(0, 20); // Limit to prevent context bloat
		} catch (error) {
			log.warn(
				`Failed to get available stickers for context: ${(error as Error).message}`,
			);
			return [];
		}
	}
}
