/**
 * Discord Pin Message Tool
 * Allows the AI to pin selected Discord messages in the channel for important information or "pins of shame"
 */

import { log } from "../../utils/misc/logger";
import {
	BaseTool,
	type ToolContext,
	type ToolResult,
	type ToolParameterSchema,
} from "../../types/tool/interfaces";

/**
 * Tool for pinning Discord messages from recent conversation
 * Uses recent message validation to prevent cross-server misfires
 */
export class PinMessageTool extends BaseTool {
	name = "pin_selected_message";
	description =
		"Pin a specific Discord message in the channel. Use only when specifically asked to pin a message, for very important information that other server members need to see, or as a 'pin of shame' when a server member says something embarrassing or absurd for comedy when the context/mood is appropriate. Only works on messages from recent conversation (last 100 messages).";
	category = "discord" as const;
	requiresPermissions = ["MANAGE_MESSAGES"];

	parameters: ToolParameterSchema = {
		type: "object",
		properties: {
			message_id: {
				type: "string",
				description:
					"The unique Discord ID of the message to pin (e.g., '123456789012345678'). This message must be from the recent conversation in the current channel (last 100 messages).",
			},
		},
		required: ["message_id"],
	};

	/**
	 * Check if pin message tool is available for the given provider
	 * @param _provider - LLM provider name (unused)
	 * @returns True if provider supports message pinning
	 */
	isAvailableFor(_provider: string): boolean {
		// Message pinning works with all providers
		return true;
	}

	/**
	 * Execute message pinning with recent message validation
	 * @param args - Arguments containing message_id
	 * @param context - Tool execution context
	 * @returns Promise resolving to tool result
	 */
	async execute(
		args: Record<string, unknown>,
		context: ToolContext,
	): Promise<ToolResult> {
		// 1. Validate parameters
		const validation = this.validateParameters(args);
		if (!validation.isValid) {
			return {
				success: false,
				error: `Invalid parameters: ${validation.errors?.join(", ") || `Missing required parameters: ${validation.missingParams?.join(", ")}`}`,
				message:
					"The message_id argument was missing or not in the expected format. Please provide a valid message_id string.",
			};
		}

		// 2. Check if this is a DM channel - pinning is not available in DMs
		if (!("guild" in context.channel)) {
			return {
				success: false,
				error: "Message pinning not available in DMs",
				message: "Message pinning is not available in Direct Messages.",
			};
		}

		const messageId = args.message_id as string;

		// 3. Validate message ID format (Discord snowflake pattern)
		if (!/^\d{17,20}$/.test(messageId)) {
			return {
				success: false,
				error: "Invalid message ID format",
				message:
					"The message ID provided doesn't appear to be a valid Discord message ID. Please check the ID and try again.",
				data: {
					status: "invalid_message_id_format",
					attempted_id: messageId,
				},
			};
		}

		try {
			log.info(`PinMessageTool: Attempting to pin message ID: ${messageId}`);

			// 4. Fetch recent messages from the channel (last 100)
			const recentMessages = await context.channel.messages.fetch({
				limit: 100,
			});

			// 5. Check if the message ID exists in recent messages
			const targetMessage = recentMessages.get(messageId);

			if (!targetMessage) {
				// Message not found in recent messages
				log.warn(
					`PinMessageTool: Message ID ${messageId} not found in recent messages (last 100)`,
				);

				return {
					success: false,
					error: "Message not found in recent conversation",
					message:
						"I couldn't find that message in the recent conversation (last 100 messages). The message might be too old to pin, or the ID might be incorrect.",
					data: {
						status: "message_not_found_in_recent",
						attempted_id: messageId,
						reason:
							"Message not found in the last 100 messages of this channel",
					},
				};
			}

			// 6. Check if message is already pinned
			if (targetMessage.pinned) {
				log.info(
					`PinMessageTool: Message ID ${messageId} is already pinned`,
				);

				// Get a preview of the message content for the response
				const messagePreview =
					targetMessage.content.length > 100
						? `${targetMessage.content.substring(0, 100)}...`
						: targetMessage.content || "[No text content]";

				return {
					success: false,
					error: "Message is already pinned",
					message: "That message is already pinned in this channel.",
					data: {
						status: "message_already_pinned",
						message_id: targetMessage.id,
						author: targetMessage.author.displayName || targetMessage.author.username,
						preview: messagePreview,
					},
				};
			}

			// 7. Attempt to pin the message
			await targetMessage.pin();

			// 8. Success - provide confirmation with message preview
			const messagePreview =
				targetMessage.content.length > 150
					? `${targetMessage.content.substring(0, 150)}...`
					: targetMessage.content || "[No text content]";

			log.success(
				`PinMessageTool: Successfully pinned message ID ${messageId} by ${targetMessage.author.displayName || targetMessage.author.username}`,
			);

			return {
				success: true,
				message: "Message successfully pinned!",
				data: {
					status: "message_pinned_successfully",
					message_id: targetMessage.id,
					author: targetMessage.author.displayName || targetMessage.author.username,
					timestamp: targetMessage.createdAt.toISOString(),
					preview: messagePreview,
					channel_id: context.channel.id,
				},
			};
		} catch (error) {
			log.error(
				`PinMessageTool: Failed to pin message ID: ${messageId}`,
				error as Error,
			);

			// 9. Handle specific Discord API errors
			if (error instanceof Error) {
				// Check for permission errors
				if (
					error.message.includes("Missing Permissions") ||
					error.message.includes("50013")
				) {
					return {
						success: false,
						error: "Insufficient permissions to pin messages",
						message:
							"I don't have permission to pin messages in this channel. Please make sure I have the 'Manage Messages' permission.",
						data: {
							status: "insufficient_permissions",
							required_permission: "MANAGE_MESSAGES",
						},
					};
				}

				// Check for channel pin limit (max 50 pins per channel)
				if (
					error.message.includes("50019") ||
					error.message.includes("pin limit")
				) {
					return {
						success: false,
						error: "Channel pin limit reached",
						message:
							"This channel has reached the maximum number of pinned messages (50). Please unpin some older messages before pinning new ones.",
						data: {
							status: "pin_limit_reached",
							max_pins: 50,
						},
					};
				}

				// Check for rate limiting
				if (
					error.message.includes("rate limit") ||
					error.message.includes("429")
				) {
					return {
						success: false,
						error: "Rate limited by Discord API",
						message:
							"I'm being rate limited by Discord. Please try again in a moment.",
						data: {
							status: "rate_limited",
							retry_suggestion: "Try again in 30-60 seconds",
						},
					};
				}
			}

			// 10. Generic error fallback
			return {
				success: false,
				error:
					error instanceof Error
						? error.message
						: "Unknown error occurred during message pinning",
				message:
					"Failed to pin the message due to an unexpected error. Please try again or check if the message ID is correct.",
				data: {
					status: "pin_operation_failed",
					attempted_id: messageId,
					error_details: error instanceof Error ? error.message : "Unknown error",
				},
			};
		}
	}
}