/**
 * Memory/Learning Tool
 * Allows the AI to learn and remember new information for future interactions
 */

import { log } from "../../utils/misc/logger";
import {
	BaseTool,
	type ToolContext,
	type ToolResult,
	type ToolParameterSchema,
} from "../../types/tool/interfaces";

/**
 * Tool for remembering and learning new information during conversations
 */
export class MemoryTool extends BaseTool {
	name = "remember_this_fact";
	description =
		"Use this function when you identify a new, distinct piece of information, fact, preference, or instruction during the conversation that seems important to remember for future interactions. This helps you learn and adapt. Specify if the information is a general server-wide fact or something specific about a user. Avoid saving information that is already known or redundant. IMPORTANT: Use {bot} instead of hardcoded bot names and {user} instead of hardcoded user names in your memory content to prevent confusion when names change.";
	category = "memory" as const;
	requiresFeatureFlag = "self_teaching";

	parameters: ToolParameterSchema = {
		type: "object",
		properties: {
			memory_content: {
				type: "string",
				description:
					"The specific piece of information, fact, or preference to remember. Be concise, clear, and ensure it's new information not already in your knowledge base. IMPORTANT: Use {bot} instead of hardcoded bot names (e.g., 'Tomori', 'Elen') and {user} instead of hardcoded user names in your memory content. Example: '{bot} likes {user}'s dogs!' instead of 'Tomori likes John's dogs!'",
			},
			memory_scope: {
				type: "string",
				description:
					"Specify the scope of this memory. Use 'server_wide' for general information applicable to the whole server, or 'target_user' for information specific to a particular user.",
				enum: ["server_wide", "target_user"],
			},
			target_user_discord_id: {
				type: "string",
				description:
					"If memory_scope is 'target_user', provide the unique Discord ID of the user this memory pertains to (e.g., '123456789012345678'). This ID should be obtained from the user's information visible in the context.",
			},
			target_user_nickname: {
				type: "string",
				description:
					"If memory_scope is 'target_user', also provide the nickname of the user this memory pertains to, as you see them in the current conversation or their user profile information. This is used to confirm the target user alongside their Discord ID.",
			},
		},
		required: ["memory_content", "memory_scope"],
	};

	/**
	 * Check if memory tool is available for the given provider
	 * @param _provider - LLM provider name (unused)
	 * @returns True if provider supports memory functionality
	 */
	isAvailableFor(_provider: string): boolean {
		// Memory functionality works with all providers
		return true;
	}

	/**
	 * Check if self-teaching functionality is enabled in Tomori config
	 * @param context - Tool execution context
	 * @returns True if self-teaching is enabled
	 */
	protected isEnabled(context: ToolContext): boolean {
		return context.tomoriState.config.self_teaching_enabled;
	}

	/**
	 * Execute memory storage
	 * @param args - Arguments containing memory details
	 * @param context - Tool execution context
	 * @returns Promise resolving to tool result
	 */
	async execute(
		args: Record<string, unknown>,
		context: ToolContext,
	): Promise<ToolResult> {
		// Real implementation extracted from tomoriChat.ts:1068-1340

		// Validate parameters
		const validation = this.validateParameters(args);
		if (!validation.isValid) {
			return {
				success: false,
				error: `Invalid parameters: ${validation.errors?.join(", ") || `Missing required parameters: ${validation.missingParams?.join(", ")}`}`,
				data: {
					status: "memory_save_failed_invalid_args",
					reason: `Invalid parameters: ${validation.errors?.join(", ") || `Missing required parameters: ${validation.missingParams?.join(", ")}`}`,
				},
			};
		}

		// Check if tool is enabled
		if (!this.isEnabled(context)) {
			return {
				success: false,
				error: "Self-teaching is disabled for this server",
				data: {
					status: "memory_save_failed_disabled",
					reason: "Self-teaching functionality is disabled for this server",
				},
			};
		}

		// Extract arguments (from tomoriChat.ts:1070-1076)
		const memoryContentArg = args.memory_content as string;
		const memoryScopeArg = args.memory_scope as "server_wide" | "target_user";
		const targetUserDiscordIdArg = args.target_user_discord_id as
			| string
			| undefined;
		const targetUserNicknameArg = args.target_user_nickname as
			| string
			| undefined;

		// Import database functions
		const { addPersonalMemoryByTomori, addServerMemoryByTomori } = await import(
			"../../utils/db/dbWrite"
		);
		const { isBlacklisted, loadUserRow } = await import(
			"../../utils/db/dbRead"
		);
		const { sendStandardEmbed } = await import(
			"../../utils/discord/embedHelper"
		);
		const { ColorCode } = await import("../../utils/misc/logger");
		const { convertMentions } = await import("../../utils/text/contextBuilder");

		// Import memory validation functions
		const {
			validateMemoryContent,
			checkPersonalMemoryLimit,
			checkServerMemoryLimit,
		} = await import("../../utils/db/memoryLimits");

		// Critical state validation (from tomoriChat.ts:1078-1104)
		const tomoriState = context.tomoriState;
		const userRow = await loadUserRow(
			context.message?.author?.id || context.userId || "",
		);

		if (
			!tomoriState ||
			!userRow ||
			!userRow.user_id ||
			!tomoriState.server_id
		) {
			log.error(
				"Critical state missing (tomoriState, userRow, or their IDs) before handling remember_this_fact",
			);
			return {
				success: false,
				error: "Internal bot error: Critical state information is missing",
				data: {
					status: "memory_save_failed_internal_error",
					reason: "Internal bot error: Critical state information is missing",
				},
			};
		}

		// Validate memory content (from tomoriChat.ts:1105-1113)
		if (typeof memoryContentArg !== "string" || !memoryContentArg.trim()) {
			return {
				success: false,
				error:
					"The 'memory_content' argument was missing, empty, or not a string",
				data: {
					status: "memory_save_failed_invalid_args",
					reason:
						"The 'memory_content' argument was missing, empty, or not a string",
				},
			};
		}

		// Validate memory scope (from tomoriChat.ts:1114-1122)
		if (
			typeof memoryScopeArg !== "string" ||
			!["server_wide", "target_user"].includes(memoryScopeArg)
		) {
			return {
				success: false,
				error:
					"The 'memory_scope' argument was missing or invalid. Must be 'server_wide' or 'target_user'",
				data: {
					status: "memory_save_failed_invalid_args",
					reason:
						"The 'memory_scope' argument was missing or invalid. Must be 'server_wide' or 'target_user'",
				},
			};
		}

		const memoryContent = memoryContentArg.trim();

		// Validate memory content length
		const contentValidation = validateMemoryContent(memoryContent);
		if (!contentValidation.isValid) {
			return {
				success: false,
				error:
					contentValidation.error === "CONTENT_EMPTY"
						? "Memory content cannot be empty"
						: `Memory content is too long. Maximum length is ${contentValidation.maxAllowed} characters.`,
				data: {
					status: "memory_save_failed_invalid_content",
					reason:
						contentValidation.error === "CONTENT_EMPTY"
							? "Memory content cannot be empty"
							: `Memory content exceeds maximum length of ${contentValidation.maxAllowed} characters`,
				},
			};
		}

		if (memoryScopeArg === "server_wide") {
			// Server-wide memory handling (from tomoriChat.ts:1127-1179)
			try {
				// Check server memory limit before adding
				const serverLimitCheck = await checkServerMemoryLimit(
					tomoriState.server_id,
				);
				if (!serverLimitCheck.isValid) {
					return {
						success: false,
						error: `Server memory limit reached. This server can have up to ${serverLimitCheck.maxAllowed} memories (currently: ${serverLimitCheck.currentCount}).`,
						data: {
							status: "memory_save_failed_limit_exceeded",
							scope: "server_wide",
							current_count: serverLimitCheck.currentCount,
							max_allowed: serverLimitCheck.maxAllowed,
							reason: `Server memory limit of ${serverLimitCheck.maxAllowed} memories has been reached`,
						},
					};
				}

				const dbResult = await addServerMemoryByTomori(
					tomoriState.server_id,
					userRow.user_id,
					memoryContent,
				);

				if (dbResult) {
					log.success(
						`Tomori self-taught a server-wide memory (ID: ${dbResult.server_memory_id}): "${memoryContent}"`,
					);

					// Process memory content for display (convert {user} and {bot} tokens to actual names)
					const processedMemoryContent = await convertMentions(
						memoryContent,
						context.client,
						context.channel.guild.id,
						userRow.user_nickname, // Use triggerer's name for {user} replacement
						tomoriState.tomori_nickname, // Use bot's current nickname for {bot} replacement
					);

					// Send notification embed to the channel
					await sendStandardEmbed(context.channel, context.locale, {
						color: ColorCode.SUCCESS,
						titleKey: "genai.self_teach.server_memory_learned_title",
						descriptionKey:
							"genai.self_teach.server_memory_learned_description",
						descriptionVars: {
							memory_content:
								processedMemoryContent.length > 200
									? `${processedMemoryContent.substring(0, 197)}...`
									: processedMemoryContent,
						},
						footerKey: "genai.self_teach.server_memory_footer",
					});

					return {
						success: true,
						message: "Memory saved successfully",
						data: {
							status: "memory_saved_successfully",
							scope: "server_wide",
							content_saved: memoryContent,
							memory_id: dbResult.server_memory_id,
						},
					};
				}

				log.error(
					"Failed to save server-wide memory via self-teach (DB error)",
				);
				return {
					success: false,
					error: "Database operation failed to save server-wide memory",
					data: {
						status: "memory_save_failed_db_error",
						scope: "server_wide",
						reason: "Database operation failed to save server-wide memory",
					},
				};
			} catch (error) {
				log.error(
					"Database error during server-wide memory save",
					error as Error,
				);
				return {
					success: false,
					error: "Database error occurred while saving memory",
					data: {
						status: "memory_save_failed_db_error",
						scope: "server_wide",
						reason: "Database error occurred",
					},
				};
			}
		} else if (memoryScopeArg === "target_user") {
			// User-specific memory handling (from tomoriChat.ts:1180-1339)

			// Validate required arguments for target_user scope
			if (
				typeof targetUserDiscordIdArg !== "string" ||
				!targetUserDiscordIdArg.trim()
			) {
				return {
					success: false,
					error:
						"The 'target_user_discord_id' argument was missing or empty, which is required when 'memory_scope' is 'target_user'",
					data: {
						status: "memory_save_failed_invalid_args",
						scope: "target_user",
						reason:
							"The 'target_user_discord_id' argument was missing or empty, which is required when 'memory_scope' is 'target_user'",
					},
				};
			}

			if (
				typeof targetUserNicknameArg !== "string" ||
				!targetUserNicknameArg.trim()
			) {
				return {
					success: false,
					error:
						"The 'target_user_nickname' argument was missing or empty, which is required when 'memory_scope' is 'target_user'",
					data: {
						status: "memory_save_failed_invalid_args",
						scope: "target_user",
						reason:
							"The 'target_user_nickname' argument was missing or empty, which is required when 'memory_scope' is 'target_user'",
					},
				};
			}

			try {
				// Load target user (from tomoriChat.ts:1204-1206)
				const targetUserRow = await loadUserRow(targetUserDiscordIdArg);

				if (!targetUserRow || !targetUserRow.user_id) {
					log.warn(
						`Self-teach: Target user with Discord ID ${targetUserDiscordIdArg} not found`,
					);
					return {
						success: false,
						error: `The user with Discord ID '${targetUserDiscordIdArg}' was not found in Tomori's records`,
						data: {
							status: "memory_save_failed_user_not_found",
							scope: "target_user",
							target_user_discord_id: targetUserDiscordIdArg,
							reason: `The user with Discord ID '${targetUserDiscordIdArg}' was not found in Tomori's records. Tomori can only save memories for users she knows.`,
						},
					};
				}

				// Verify nickname as "two-factor" check (from tomoriChat.ts:1227-1261)
				const actualNicknameInDB = targetUserRow.user_nickname;
				const guildMember = context.message?.guild?.members.cache.get(
					targetUserDiscordIdArg,
				);
				const guildDisplayName = guildMember?.displayName?.toLowerCase();

				if (
					actualNicknameInDB.toLowerCase() !==
						targetUserNicknameArg.toLowerCase() &&
					actualNicknameInDB.toLowerCase() !== guildDisplayName
				) {
					log.warn(
						`Self-teach: Nickname mismatch for target user ${targetUserDiscordIdArg}. LLM provided: '${targetUserNicknameArg}', DB has: '${actualNicknameInDB}'.`,
					);
					return {
						success: false,
						error: `The provided nickname '${targetUserNicknameArg}' does not match the records for user ID '${targetUserDiscordIdArg}'`,
						data: {
							status: "memory_save_failed_nickname_mismatch",
							scope: "target_user",
							target_user_discord_id: targetUserDiscordIdArg,
							provided_nickname: targetUserNicknameArg,
							actual_nickname: actualNicknameInDB,
							reason: `The provided nickname '${targetUserNicknameArg}' does not match the records for user ID '${targetUserDiscordIdArg}' (Tomori knows them as '${actualNicknameInDB}'). Please ensure the Discord ID and nickname correspond to the same user.`,
						},
					};
				}

				// Check personal memory limit before adding
				const personalLimitCheck = await checkPersonalMemoryLimit(
					targetUserRow.user_id,
				);
				if (!personalLimitCheck.isValid) {
					return {
						success: false,
						error: `Personal memory limit reached. Users can have up to ${personalLimitCheck.maxAllowed} personal memories (currently: ${personalLimitCheck.currentCount}).`,
						data: {
							status: "memory_save_failed_limit_exceeded",
							scope: "target_user",
							target_user_discord_id: targetUserDiscordIdArg,
							current_count: personalLimitCheck.currentCount,
							max_allowed: personalLimitCheck.maxAllowed,
							reason: `Personal memory limit of ${personalLimitCheck.maxAllowed} memories has been reached for this user`,
						},
					};
				}

				// Save personal memory (from tomoriChat.ts:1262-1335)
				const dbResult = await addPersonalMemoryByTomori(
					targetUserRow.user_id,
					memoryContent,
				);

				if (dbResult) {
					log.success(
						`Tomori self-taught a personal memory for ${targetUserNicknameArg} (Discord ID: ${targetUserDiscordIdArg}, Internal ID: ${targetUserRow.user_id}): "${memoryContent}"`,
					);

					// Process memory content for display (convert {user} and {bot} tokens to actual names)
					const processedMemoryContent = await convertMentions(
						memoryContent,
						context.client,
						context.channel.guild.id,
						targetUserNicknameArg, // Use target user's name for {user} replacement
						tomoriState.tomori_nickname, // Use bot's current nickname for {bot} replacement
					);

					// Determine footer key based on personalization settings
					const personalizationEnabled =
						tomoriState?.config.personal_memories_enabled ?? true;
					const serverDiscId = context.channel.guild.id;
					const targetUserIsBlacklisted =
						(await isBlacklisted(serverDiscId, targetUserDiscordIdArg)) ??
						false;

					let personalMemoryFooterKey: string;
					if (!personalizationEnabled) {
						personalMemoryFooterKey =
							"genai.self_teach.personal_memory_footer_personalization_disabled";
					} else if (targetUserIsBlacklisted) {
						personalMemoryFooterKey =
							"genai.self_teach.personal_memory_footer_user_blacklisted";
					} else {
						personalMemoryFooterKey =
							"genai.self_teach.personal_memory_footer_manage";
					}

					// Send notification embed
					await sendStandardEmbed(context.channel, context.locale, {
						color: ColorCode.SUCCESS,
						titleKey: "genai.self_teach.personal_memory_learned_title",
						descriptionKey:
							"genai.self_teach.personal_memory_learned_description",
						descriptionVars: {
							user_nickname: targetUserNicknameArg,
							memory_content:
								processedMemoryContent.length > 200
									? `${processedMemoryContent.substring(0, 197)}...`
									: processedMemoryContent,
						},
						footerKey: personalMemoryFooterKey,
					});

					return {
						success: true,
						message: "Memory saved successfully",
						data: {
							status: "memory_saved_successfully",
							scope: "target_user",
							user_discord_id: targetUserDiscordIdArg,
							user_nickname: targetUserNicknameArg,
							content_saved: memoryContent,
						},
					};
				}

				log.error(
					`Failed to save personal memory for ${targetUserNicknameArg} (Discord ID: ${targetUserDiscordIdArg}) via self-teach (DB error)`,
				);
				return {
					success: false,
					error:
						"Database operation failed to save personal memory for the target user",
					data: {
						status: "memory_save_failed_db_error",
						scope: "target_user",
						reason:
							"Database operation failed to save personal memory for the target user",
					},
				};
			} catch (error) {
				log.error("Error during target_user memory processing", error as Error);
				return {
					success: false,
					error: "Error occurred while processing user-specific memory",
					data: {
						status: "memory_save_failed_error",
						scope: "target_user",
						reason: error instanceof Error ? error.message : "Unknown error",
					},
				};
			}
		}

		// This should never be reached due to validation above
		return {
			success: false,
			error: "Invalid memory scope",
			data: {
				status: "memory_save_failed_invalid_scope",
				reason: "Memory scope validation failed",
			},
		};
	}

	// Removed unused helper methods - functionality moved to main execute method
}
