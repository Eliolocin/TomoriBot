/**
 * Reminder Tool
 * Allows the AI to set reminders for users, causing TomoriBot to mention them at the specified time
 */

import { log } from "../../utils/misc/logger";
import {
	BaseTool,
	type ToolContext,
	type ToolResult,
	type ToolParameterSchema,
} from "../../types/tool/interfaces";
import {
	validateFutureTime,
	formatTimeRemaining,
} from "../../utils/text/stringHelper";
import {
	parseTimeWithOffset,
	formatUTCOffset,
	formatTimeWithOffset,
} from "../../utils/text/timezoneHelper";

/**
 * Tool for setting user reminders that will trigger messages at specific times
 */
export class ReminderTool extends BaseTool {
	name = "set_reminder_for_user";
	description =
		"Set a reminder for a Discord user. TomoriBot will mention the user in the channel where this reminder was set at the specified time with the reminder purpose. You can specify time in two ways: (1) Use relative time parameters like 'minutes_from_now', 'hours_from_now', 'days_from_now', 'months_from_now' - these are much easier for natural requests like 'remind me in 2 hours' or 'remind me tomorrow' (1 day from now). Multiple relative parameters add up. (2) Use absolute 'reminder_time' in YYYY-MM-DD_HH:MM format using the server's configured timezone (set via /config timezone) for specific dates/times. If both are provided, absolute time takes priority. You must provide either absolute time OR at least one relative time parameter.";
	category = "utility" as const;

	parameters: ToolParameterSchema = {
		type: "object",
		properties: {
			reminder_purpose: {
				type: "string",
				description:
					'What the reminder is for. Should be descriptive in 1 or more sentences explaining what the user wants to be reminded about. Eg. "User wants to be reminded about dinner."',
			},
			target_user_nickname: {
				type: "string",
				description:
					"Nickname of the Discord user the reminder is for, as you see them in the current conversation or their user profile information.",
			},
			target_user_discord_id: {
				type: "string",
				description:
					"Discord ID of the user the reminder is for (e.g., '123456789012345678'). This ID should be obtained from the user's information visible in the context.",
			},
			reminder_time: {
				type: "string",
				description:
					"OPTIONAL: Absolute time to remind the user in YYYY-MM-DD_HH:MM format (e.g., '2025-09-05_15:30') using the server's configured timezone. Times are interpreted using the server's timezone setting from /config timezone. Use this for specific dates/times. If provided, this takes priority over 'from now' parameters.",
			},
			minutes_from_now: {
				type: "number",
				description:
					"OPTIONAL: Minutes from the current time to set the reminder. Can be combined with other 'from now' parameters.",
			},
			hours_from_now: {
				type: "number",
				description:
					"OPTIONAL: Hours from the current time to set the reminder. Can be combined with other 'from now' parameters.",
			},
			days_from_now: {
				type: "number",
				description:
					"OPTIONAL: Days from the current time to set the reminder. Can be combined with other 'from now' parameters.",
			},
			months_from_now: {
				type: "number",
				description:
					"OPTIONAL: Months from the current time to set the reminder. Can be combined with other 'from now' parameters. Uses calendar months (30.44 days average).",
			},
		},
		required: [
			"reminder_purpose",
			"target_user_nickname",
			"target_user_discord_id",
		],
	};

	/**
	 * Check if reminder tool is available for the given provider
	 * @param _provider - LLM provider name (unused)
	 * @returns True if provider supports reminder functionality
	 */
	isAvailableFor(_provider: string): boolean {
		// Reminder functionality works with all providers
		return true;
	}

	/**
	 * Execute reminder creation
	 * @param args - Arguments containing reminder details
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
				data: {
					status: "reminder_creation_failed_invalid_args",
					reason: `Invalid parameters: ${validation.errors?.join(", ") || `Missing required parameters: ${validation.missingParams?.join(", ")}`}`,
				},
			};
		}

		// Extract arguments
		const reminderPurposeArg = args.reminder_purpose as string;
		const targetUserNicknameArg = args.target_user_nickname as string;
		const targetUserDiscordIdArg = args.target_user_discord_id as string;
		const reminderTimeArg = args.reminder_time as string | undefined;
		const minutesFromNowArg = args.minutes_from_now as number | undefined;
		const hoursFromNowArg = args.hours_from_now as number | undefined;
		const daysFromNowArg = args.days_from_now as number | undefined;
		const monthsFromNowArg = args.months_from_now as number | undefined;

		// Import database functions and utilities
		const { loadUserRow } = await import("../../utils/db/dbRead");
		const { addReminder } = await import("../../utils/db/dbWrite");
		const { sendStandardEmbed } = await import(
			"../../utils/discord/embedHelper"
		);
		const { ColorCode } = await import("../../utils/misc/logger");

		// Get server and user context
		const tomoriState = context.tomoriState;
		const requestingUserRow = await loadUserRow(
			context.message?.author?.id || context.userId || "",
		);
		const channelId = context.channel.id;

		if (
			!tomoriState ||
			!requestingUserRow ||
			!requestingUserRow.user_id ||
			!tomoriState.server_id
		) {
			log.error(
				"Critical state missing (tomoriState, requestingUserRow, or their IDs) before handling set_reminder_for_user",
			);
			return {
				success: false,
				error: "Internal bot error: Critical state information is missing",
				data: {
					status: "reminder_creation_failed_internal_error",
					reason: "Internal bot error: Critical state information is missing",
				},
			};
		}

		// Validate reminder purpose
		if (typeof reminderPurposeArg !== "string" || !reminderPurposeArg.trim()) {
			return {
				success: false,
				error:
					"The 'reminder_purpose' argument was missing, empty, or not a string",
				data: {
					status: "reminder_creation_failed_invalid_args",
					reason:
						"The 'reminder_purpose' argument was missing, empty, or not a string",
				},
			};
		}

		// Validate target user nickname
		if (
			typeof targetUserNicknameArg !== "string" ||
			!targetUserNicknameArg.trim()
		) {
			return {
				success: false,
				error:
					"The 'target_user_nickname' argument was missing, empty, or not a string",
				data: {
					status: "reminder_creation_failed_invalid_args",
					reason:
						"The 'target_user_nickname' argument was missing, empty, or not a string",
				},
			};
		}

		// Validate target user Discord ID
		if (
			typeof targetUserDiscordIdArg !== "string" ||
			!targetUserDiscordIdArg.trim()
		) {
			return {
				success: false,
				error:
					"The 'target_user_discord_id' argument was missing, empty, or not a string",
				data: {
					status: "reminder_creation_failed_invalid_args",
					reason:
						"The 'target_user_discord_id' argument was missing, empty, or not a string",
				},
			};
		}

		// Determine which time method to use and calculate the final reminder time
		let finalReminderTime: Date | null = null;
		let timeCalculationMethod = "";

		// Get the server's configured timezone offset (default to 0/UTC if not set)
		const timezoneOffset = tomoriState.config.timezone_offset ?? 0;

		if (
			reminderTimeArg &&
			typeof reminderTimeArg === "string" &&
			reminderTimeArg.trim()
		) {
			// Method 1: Absolute time provided - parse in server's configured timezone
			timeCalculationMethod = "absolute";
			finalReminderTime = parseTimeWithOffset(
				reminderTimeArg.trim(),
				timezoneOffset,
			);
			if (!finalReminderTime) {
				return {
					success: false,
					error: `Invalid reminder time format. Please use YYYY-MM-DD_HH:MM format (e.g., '2025-09-05_15:30') in the server's configured timezone (${formatUTCOffset(timezoneOffset)}). The provided format '${reminderTimeArg}' is invalid.`,
					data: {
						status: "reminder_creation_failed_invalid_time_format",
						reason: `Invalid reminder time format: '${reminderTimeArg}'. Expected YYYY-MM-DD_HH:MM format in ${formatUTCOffset(timezoneOffset)}.`,
						provided_time: reminderTimeArg,
						server_timezone: formatUTCOffset(timezoneOffset),
					},
				};
			}
		} else {
			// Method 2: Relative time parameters - calculate from current time
			const hasRelativeParams =
				(typeof minutesFromNowArg === "number" && minutesFromNowArg > 0) ||
				(typeof hoursFromNowArg === "number" && hoursFromNowArg > 0) ||
				(typeof daysFromNowArg === "number" && daysFromNowArg > 0) ||
				(typeof monthsFromNowArg === "number" && monthsFromNowArg > 0);

			if (!hasRelativeParams) {
				return {
					success: false,
					error:
						"You must provide either a 'reminder_time' OR at least one positive 'from now' parameter (minutes_from_now, hours_from_now, days_from_now, months_from_now).",
					data: {
						status: "reminder_creation_failed_no_time_specified",
						reason:
							"Neither absolute time nor relative time parameters were provided.",
					},
				};
			}

			// Calculate relative time by adding all "from now" parameters
			timeCalculationMethod = "relative";
			const currentTime = new Date();
			let totalMilliseconds = 0;

			// Add each time component (convert to milliseconds)
			if (typeof minutesFromNowArg === "number" && minutesFromNowArg > 0) {
				totalMilliseconds += minutesFromNowArg * 60 * 1000;
			}
			if (typeof hoursFromNowArg === "number" && hoursFromNowArg > 0) {
				totalMilliseconds += hoursFromNowArg * 60 * 60 * 1000;
			}
			if (typeof daysFromNowArg === "number" && daysFromNowArg > 0) {
				totalMilliseconds += daysFromNowArg * 24 * 60 * 60 * 1000;
			}
			if (typeof monthsFromNowArg === "number" && monthsFromNowArg > 0) {
				// Use average month length (30.44 days) for consistency
				totalMilliseconds += monthsFromNowArg * 30.44 * 24 * 60 * 60 * 1000;
			}

			finalReminderTime = new Date(currentTime.getTime() + totalMilliseconds);
		}

		const reminderPurpose = reminderPurposeArg.trim();
		const targetUserNickname = targetUserNicknameArg.trim();
		const targetUserDiscordId = targetUserDiscordIdArg.trim();

		// Validate that the calculated time is in the future (both absolute and relative times)
		if (!finalReminderTime || !validateFutureTime(finalReminderTime)) {
			const timeDisplay =
				timeCalculationMethod === "absolute"
					? reminderTimeArg
					: `calculated from relative parameters (${[
							minutesFromNowArg && `${minutesFromNowArg} minutes`,
							hoursFromNowArg && `${hoursFromNowArg} hours`,
							daysFromNowArg && `${daysFromNowArg} days`,
							monthsFromNowArg && `${monthsFromNowArg} months`,
						]
							.filter(Boolean)
							.join(", ")})`;

			return {
				success: false,
				error: `The reminder time must be in the future. The ${timeCalculationMethod} time ${timeDisplay} results in a past time or is too close to the current time.`,
				data: {
					status: "reminder_creation_failed_past_time",
					reason: `The ${timeCalculationMethod} time calculation resulted in a past time.`,
					calculated_time: finalReminderTime?.toISOString() || "invalid",
					current_utc_time: new Date().toISOString(),
					time_method: timeCalculationMethod,
				},
			};
		}

		try {
			// Load target user to verify they exist
			const targetUserRow = await loadUserRow(targetUserDiscordId);

			if (!targetUserRow || !targetUserRow.user_id) {
				log.warn(
					`Reminder: Target user with Discord ID ${targetUserDiscordId} not found`,
				);
				return {
					success: false,
					error: `The user with Discord ID '${targetUserDiscordId}' was not found in TomoriBot's records`,
					data: {
						status: "reminder_creation_failed_user_not_found",
						target_user_discord_id: targetUserDiscordId,
						reason: `The user with Discord ID '${targetUserDiscordId}' was not found in TomoriBot's records. TomoriBot can only create reminders for users she knows.`,
					},
				};
			}

			// Verify nickname as "two-factor" check
			const actualNicknameInDB = targetUserRow.user_nickname;
			const guildMember =
				context.message?.guild?.members.cache.get(targetUserDiscordId);
			const guildDisplayName = guildMember?.displayName?.toLowerCase();

			if (
				actualNicknameInDB.toLowerCase() !== targetUserNickname.toLowerCase() &&
				actualNicknameInDB.toLowerCase() !== guildDisplayName
			) {
				log.warn(
					`Reminder: Nickname mismatch for target user ${targetUserDiscordId}. LLM provided: '${targetUserNickname}', DB has: '${actualNicknameInDB}'.`,
				);
				return {
					success: false,
					error: `The provided nickname '${targetUserNickname}' does not match the records for user ID '${targetUserDiscordId}'`,
					data: {
						status: "reminder_creation_failed_nickname_mismatch",
						target_user_discord_id: targetUserDiscordId,
						provided_nickname: targetUserNickname,
						actual_nickname: actualNicknameInDB,
						reason: `The provided nickname '${targetUserNickname}' does not match the records for user ID '${targetUserDiscordId}' (TomoriBot knows them as '${actualNicknameInDB}'). Please ensure the Discord ID and nickname correspond to the same user.`,
					},
				};
			}

			// Create the reminder in the database
			const dbResult = await addReminder({
				server_id: tomoriState.server_id,
				channel_disc_id: channelId,
				user_discord_id: targetUserDiscordId,
				user_nickname: actualNicknameInDB, // Use the verified nickname from DB
				reminder_purpose: reminderPurpose,
				reminder_time: finalReminderTime,
				created_by_user_id: requestingUserRow.user_id,
			});

			if (dbResult) {
				log.success(
					`Reminder created (ID: ${dbResult.reminder_id}): "${reminderPurpose}" for ${actualNicknameInDB} (${targetUserDiscordId}) at ${finalReminderTime.toISOString()}`,
				);

				// Calculate time remaining for user-friendly display
				const timeRemainingMs = finalReminderTime.getTime() - Date.now();
				const timeRemainingStr = formatTimeRemaining(timeRemainingMs);

				// Send confirmation embed to the channel
				// Format the reminder time in the server's configured timezone
				const formattedReminderTime = formatTimeWithOffset(
					finalReminderTime,
					timezoneOffset,
					{
						year: "numeric",
						month: "long",
						day: "numeric",
						hour: "2-digit",
						minute: "2-digit",
					},
				);

				await sendStandardEmbed(context.channel, context.locale, {
					color: ColorCode.SUCCESS,
					titleKey: "reminders.reminder_set_title",
					descriptionKey: "reminders.reminder_set_description",
					descriptionVars: {
						user_nickname: actualNicknameInDB,
						reminder_purpose:
							reminderPurpose.length > 200
								? `${reminderPurpose.substring(0, 197)}...`
								: reminderPurpose,
						reminder_time: `${formattedReminderTime} (${formatUTCOffset(timezoneOffset)})`,
					},
					footerKey: "reminders.reminder_set_footer",
					footerVars: {
						time_remaining: timeRemainingStr,
					},
				});

				return {
					success: true,
					message: `Reminder successfully set for ${actualNicknameInDB}`,
					data: {
						status: "reminder_created_successfully",
						reminder_id: dbResult.reminder_id,
						target_user_nickname: actualNicknameInDB,
						target_user_discord_id: targetUserDiscordId,
						reminder_purpose: reminderPurpose,
						reminder_time: finalReminderTime.toISOString(),
						time_remaining_ms: timeRemainingMs,
						time_remaining_text: timeRemainingStr,
					},
				};
			}

			log.error("Failed to create reminder (DB error)");
			return {
				success: false,
				error: "Database operation failed to create reminder",
				data: {
					status: "reminder_creation_failed_db_error",
					reason: "Database operation failed to create reminder",
				},
			};
		} catch (error) {
			log.error("Error during reminder creation", error as Error);
			return {
				success: false,
				error: "Error occurred while creating reminder",
				data: {
					status: "reminder_creation_failed_error",
					reason: error instanceof Error ? error.message : "Unknown error",
				},
			};
		}
	}
}
