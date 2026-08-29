/**
 * Reminder Tool
 * Allows the AI to set reminders for users, causing TomoriBot to mention them at the specified time
 */

import { log } from "../../utils/misc/logger";
import { BaseTool, type ToolContext, type ToolResult, type ToolParameterSchema } from "../../types/tool/interfaces";
import { validateFutureTime } from "@/utils/text/processors/timeUtils";
import { formatTimeRemaining } from "@/utils/text/processors/formatters";
import {
  parseTimeWithOffset,
  formatUTCOffset,
  formatTimeWithOffset,
  isValidUtcOffset,
  UTC_OFFSET_MIN,
  UTC_OFFSET_MAX,
} from "../../utils/text/timezoneHelper";
import { localizer } from "@/utils/text/localizer";
import { isMatrixBridgeWebhookUsername } from "../../utils/bridges";
import { resolveChannelTarget, resolveUserTarget } from "@/utils/discord/targetResolver";

/**
 * Tool for creating scheduled tasks that trigger messages at specific times
 */
export class ReminderTool extends BaseTool {
  name = "create_task";
  description =
    "Create a scheduled task in a Discord channel. Use this for both user reminders and self tasks: a reminder is just a task that notifies a target user. IMPORTANT: Always set 'repetition_interval_hours' - use 0 for one-time tasks, or 1+ for recurring tasks (e.g., 24 for daily tasks). Use 'self_reminder' for tasks you should execute yourself on a schedule (for example daily summaries or periodic reports). For instant, one-time messages in other channels, use cross_channel_message instead as it sends immediately without scheduling. You can specify time in two ways: (1) Use relative time parameters like 'minutes_from_now', 'hours_from_now', 'days_from_now', 'months_from_now' for natural requests like 'in 2 hours' or 'tomorrow'. Multiple relative parameters add up. (2) Use absolute 'reminder_time' in YYYY-MM-DD_HH:MM format for specific dates/times. Pass the wall-clock time exactly as the user expressed it — NEVER convert between timezones yourself. By default absolute times are interpreted in the server's configured timezone (set via /server timezone); if the user expressed the time in their own personal timezone (shown in the conversation context), set 'utc_offset' to that timezone's UTC offset and the conversion is handled for you. If both absolute and relative times are provided, absolute time takes priority. If you omit all time parameters, the task defaults to 1 minute from now.";
  category = "utility" as const;

  parameters: ToolParameterSchema = {
    type: "object",
    properties: {
      reminder_purpose: {
        type: "string",
        description:
          "What the task is for. IMPORTANT: Be very descriptive and detailed (2-4 sentences) because you might not remember the context after a long time. Include WHAT the task is about, WHY it was set, and any relevant details from the conversation. The more context you provide now, the more helpful the task will be later, but do NOT include user/channel IDs or any meta information in this content.",
      },
      target_user: {
        type: "string",
        description:
          "OPTIONAL: Name of the user this task should notify, as shown in the current conversation or current server. Use natural names, not IDs. If omitted, the task notifies the current turn's invoking user. If this is a task for yourself instead, set self_reminder to true.",
      },
      reminder_time: {
        type: "string",
        description:
          "OPTIONAL: Absolute time to trigger the task in YYYY-MM-DD_HH:MM format (e.g., '2025-09-05_15:30'). Pass the wall-clock time exactly as the user expressed it. Do NOT convert between timezones yourself. Without 'utc_offset', this is interpreted in the server's configured timezone (set via /server timezone). Use this for specific dates/times. If provided, this takes priority over 'from now' parameters.",
      },
      utc_offset: {
        type: "number",
        description:
          "OPTIONAL: The UTC offset in hours that 'reminder_time' is expressed in (e.g., 8 for UTC+8, -5 for UTC-5, 5.5 for UTC+5:30). Set this to the target user's personal timezone offset (shown in the conversation context) when they expressed the time in their own local time. If omitted, the server's configured timezone is used. Only meaningful together with 'reminder_time'.",
      },
      minutes_from_now: {
        type: "number",
        description:
          "OPTIONAL: Minutes from the current time to schedule the task. Can be combined with other 'from now' parameters.",
      },
      hours_from_now: {
        type: "number",
        description:
          "OPTIONAL: Hours from the current time to schedule the task. Can be combined with other 'from now' parameters.",
      },
      days_from_now: {
        type: "number",
        description:
          "OPTIONAL: Days from the current time to schedule the task. Can be combined with other 'from now' parameters.",
      },
      months_from_now: {
        type: "number",
        description:
          "OPTIONAL: Months from the current time to schedule the task. Can be combined with other 'from now' parameters. Uses calendar months (30.44 days average).",
      },
      repetition_interval_hours: {
        type: "number",
        description:
          "REQUIRED: Set to 0 for one-time tasks. Set to 1 or higher to make the task recurring (repeats every X hours after the first trigger). Example: 24 for daily tasks, 168 for weekly tasks.",
      },
      self_reminder: {
        type: "boolean",
        description:
          "OPTIONAL: Set to true when this is a task for you to execute yourself. This disables user mentions and focuses the prompt on the task.",
      },
      target_channel: {
        type: "string",
        description:
          "OPTIONAL: Channel or active thread label where this task should trigger. Useful for cross-channel tasks. The channel must exist in the current server. If the prompt shows a copyable inline-code label like `#general (ID: ...)`, prefer copying that exact label to avoid ambiguity. A raw Discord channel/thread ID is also accepted. If omitted, the current channel is used.",
      },
    },
    required: ["reminder_purpose", "repetition_interval_hours"],
  };

  /**
   * Check if reminder tool is available for the given provider
   * @returns True if provider supports reminder functionality
   */
  isAvailableFor(_provider: string): boolean {
    return true;
  }

  /**
   * Context-aware availability check: disabled during non-task reminder-triggered turns
   * to prevent the AI from scheduling new reminders while executing an existing one.
   * Self-reminder (task) turns are exempt so tasks can spawn follow-up tasks.
   * @param context - Optional tool context containing streaming flags
   */
  isAvailableForContext(_provider: string, context?: ToolContext): boolean {
    if (context?.streamContext?.disableReminderTool) return false;
    return true;
  }

  /**
   * Execute reminder creation
   * @param args - Arguments containing reminder details
   */
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
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

    const reminderPurposeArg = args.reminder_purpose as string;
    const targetUserArg = args.target_user as string | undefined;
    const legacyTargetUserNicknameArg = args.target_user_nickname as string | undefined;
    const legacyTargetUserDiscordIdArg = args.target_user_discord_id as string | undefined;
    let reminderTimeArg = args.reminder_time as string | undefined;
    const utcOffsetArg = args.utc_offset as number | undefined;
    const minutesFromNowArg = args.minutes_from_now as number | undefined;
    const hoursFromNowArg = args.hours_from_now as number | undefined;
    const daysFromNowArg = args.days_from_now as number | undefined;
    const monthsFromNowArg = args.months_from_now as number | undefined;
    let repetitionIntervalHoursArg = args.repetition_interval_hours as number | undefined;
    const selfReminderArg = args.self_reminder as boolean | undefined;
    const targetChannelArg = args.target_channel as string | undefined;
    const legacyChannelIdArg = args.channel_id as string | undefined;

    // NovelAI GLM recovery: normalize absolute time format.
    // GLM may output "2025-09-05 15:30" (space), "2025-09-05T15:30" (ISO), or
    // "2025/09/05_15:30" (slashes) instead of the expected "YYYY-MM-DD_HH:MM" format.
    // Normalize common variants before parseTimeWithOffset rejects them.
    if (reminderTimeArg && typeof reminderTimeArg === "string") {
      let normalized = reminderTimeArg.trim();
      normalized = normalized.replace(/^(\d{4})\/(\d{2})\/(\d{2})/, "$1-$2-$3");
      normalized = normalized.replace(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/, "$1_$2");
      if (normalized !== reminderTimeArg) {
        log.info(`Reminder tool: Normalized time format "${reminderTimeArg}" → "${normalized}"`);
        reminderTimeArg = normalized;
      }
    }

    // NovelAI GLM recovery: default repetition_interval_hours to 0 (one-time) when missing.
    // GLM frequently omits this required parameter for simple "remind me in X" requests.
    // Only for NovelAI, so other providers have retries and should be required to explicitly
    // set this so the model is "conscious" of whether the reminder is one-time or recurring.
    if (context.provider === "novelai" && typeof repetitionIntervalHoursArg !== "number") {
      log.info("Reminder tool: Auto-filling missing repetition_interval_hours with 0 (one-time reminder)");
      repetitionIntervalHoursArg = 0;
    }

    const { userRepository, serverScheduleRepository } = await import("@/utils/db/repositories");
    const { sendTaskEmbedWithExpand } = await import("../../utils/discord/expandableEmbedNotice");
    const { ColorCode } = await import("../../utils/misc/logger");

    const tomoriState = context.tomoriState;
    const resolvedUserId = context.message?.author?.id || context.userId;

    // Matrix relay messages arrive via Discord webhook (author = webhook bot).
    // The webhook bot has no users table record, so loadUserRow returns null.
    // Detect this case so we can relax the requestingUserRow guard below and
    // store created_by_user_id = null (the column is nullable for this reason).
    const isMatrixRelayRequester =
      !!context.message?.webhookId && isMatrixBridgeWebhookUsername(context.message?.author?.username ?? "");

    const requestingUserRow = resolvedUserId ? await userRepository.loadByDiscordId(resolvedUserId) : null;
    const channelId = context.channel.id;
    const requestedTargetUser =
      targetUserArg?.trim() || legacyTargetUserNicknameArg?.trim() || legacyTargetUserDiscordIdArg?.trim();
    const requestedTargetChannel = targetChannelArg?.trim() || legacyChannelIdArg?.trim();

    if (
      !tomoriState ||
      // Allow null requestingUserRow for Matrix relay webhooks, so they have no
      // users table entry, so created_by_user_id will be stored as null
      (!requestingUserRow && !isMatrixRelayRequester) ||
      (requestingUserRow && !requestingUserRow.user_id) ||
      !tomoriState.server_id ||
      !resolvedUserId
    ) {
      const missing = [
        !tomoriState && "tomoriState",
        !requestingUserRow && !isMatrixRelayRequester && "requestingUserRow",
        requestingUserRow && !requestingUserRow.user_id && "requestingUserRow.user_id",
        tomoriState && !tomoriState.server_id && "tomoriState.server_id",
        !resolvedUserId && "resolvedUserId",
      ].filter(Boolean);
      log.error(`Critical state missing before handling create_task: [${missing.join(", ")}]`);
      return {
        success: false,
        error: "Internal bot error: Critical state information is missing",
        data: {
          status: "reminder_creation_failed_internal_error",
          reason: "Internal bot error: Critical state information is missing",
        },
      };
    }

    const personaNickname =
      context.personaUsername || tomoriState.persona_nickname || context.client.user?.username || "TomoriBot";

    if (typeof reminderPurposeArg !== "string" || !reminderPurposeArg.trim()) {
      return {
        success: false,
        error: "The 'reminder_purpose' argument was missing, empty, or not a string",
        data: {
          status: "reminder_creation_failed_invalid_args",
          reason: "The 'reminder_purpose' argument was missing, empty, or not a string",
        },
      };
    }

    const botUserId = context.client.user?.id;
    const isSelfReminder =
      selfReminderArg === true ||
      requestedTargetUser?.toLowerCase() === "self" ||
      (typeof legacyTargetUserDiscordIdArg === "string" &&
        !!botUserId &&
        legacyTargetUserDiscordIdArg.trim() === botUserId);

    const shouldDefaultTargetToInvoker = !isSelfReminder && !requestedTargetUser;
    if (shouldDefaultTargetToInvoker && !requestingUserRow?.user_id) {
      return {
        success: false,
        error: "The invoking user could not be resolved as the default reminder target.",
        data: {
          status: "reminder_creation_failed_user_not_found",
          reason: "The invoking user could not be resolved as the default reminder target.",
        },
      };
    }

    if (isSelfReminder && !botUserId) {
      return {
        success: false,
        error: "Tomori bot user ID is not available to create a self reminder",
        data: {
          status: "reminder_creation_failed_internal_error",
          reason: "Tomori bot user ID is missing.",
        },
      };
    }

    let repetitionIntervalHours: number | null = null;
    if (typeof repetitionIntervalHoursArg === "number") {
      if (
        !Number.isFinite(repetitionIntervalHoursArg) ||
        !Number.isInteger(repetitionIntervalHoursArg) ||
        repetitionIntervalHoursArg < 0
      ) {
        return {
          success: false,
          error: "The 'repetition_interval_hours' must be 0 (for one-time) or an integer >= 1 (for recurring)",
          data: {
            status: "reminder_creation_failed_invalid_repeat_interval",
            reason: "The 'repetition_interval_hours' must be 0 or an integer >= 1.",
          },
        };
      }
      // Only set repetitionIntervalHours if it's > 0 (recurring)
      repetitionIntervalHours = repetitionIntervalHoursArg > 0 ? repetitionIntervalHoursArg : null;
    }

    let resolvedChannelId = channelId;
    let resolvedChannelLabel = "Current channel";
    if (requestedTargetChannel) {
      if (!context.guildId) {
        return {
          success: false,
          error: "Channel overrides are not supported in DMs.",
          data: {
            status: "reminder_creation_failed_invalid_channel",
            reason: "Channel overrides are not supported in DMs.",
          },
        };
      }

      const channelResolution = await resolveChannelTarget(requestedTargetChannel, context);
      if (channelResolution.status === "ambiguous") {
        const shownCount = channelResolution.candidates.length;
        const overflowCount = channelResolution.totalCount - shownCount;
        const overflowNote = overflowCount > 0 ? ` (and ${overflowCount} more; use a raw channel ID for others)` : "";
        const candidateLabels = channelResolution.candidates.map((c) => c.label).join(", ");
        return {
          success: false,
          error: `Multiple channels or threads match "${requestedTargetChannel}". Please clarify using the exact inline-code label or raw ID:\n${candidateLabels}${overflowNote}`,
          data: {
            status: "reminder_creation_failed_ambiguous_channel",
            reason: "Multiple channels or threads matched the requested target.",
            candidates: channelResolution.candidates.map((c) => c.label),
            total_matches: channelResolution.totalCount,
          },
        };
      }

      if (channelResolution.status === "not_found") {
        return {
          success: false,
          error: `Could not find a text channel or thread matching "${requestedTargetChannel}" in this server.`,
          data: {
            status: "reminder_creation_failed_invalid_channel",
            reason: "The requested channel or thread was not found in this server.",
          },
        };
      }

      resolvedChannelId = channelResolution.channel.id;
      resolvedChannelLabel = channelResolution.displayLabel;
    } else if ("name" in context.channel) {
      resolvedChannelLabel = `#${context.channel.name}`;
    }

    // Determine which time method to use and calculate the final reminder time
    let finalReminderTime: Date | null = null;
    let timeCalculationMethod = "";

    // Get the server's configured timezone offset (default to 0/UTC if not set)
    const timezoneOffset = tomoriState.config.timezone_offset ?? 0;

    if (reminderTimeArg && typeof reminderTimeArg === "string" && reminderTimeArg.trim()) {
      // Method 1: Absolute time provided - parse in the offset the model labeled
      // the time with (utc_offset), falling back to the server's configured timezone.
      // The model passes wall-clock time as spoken and labels the frame instead of
      // converting it, so deterministic code does the offset arithmetic here.
      timeCalculationMethod = "absolute";

      // Validate utc_offset only when it will actually be used (absolute path)
      if (utcOffsetArg !== undefined && !isValidUtcOffset(utcOffsetArg)) {
        return {
          success: false,
          error: `Invalid 'utc_offset' value '${utcOffsetArg}'. It must be a number of hours between ${UTC_OFFSET_MIN} and ${UTC_OFFSET_MAX} (e.g., 8 for UTC+8, -5 for UTC-5).`,
          data: {
            status: "reminder_creation_failed_invalid_utc_offset",
            reason: `Invalid 'utc_offset' value: '${utcOffsetArg}'. Expected a number between ${UTC_OFFSET_MIN} and ${UTC_OFFSET_MAX}.`,
          },
        };
      }

      const effectiveParseOffset = typeof utcOffsetArg === "number" ? utcOffsetArg : timezoneOffset;
      finalReminderTime = parseTimeWithOffset(reminderTimeArg.trim(), effectiveParseOffset);
      if (!finalReminderTime) {
        return {
          success: false,
          error: `Invalid reminder time format. Please use YYYY-MM-DD_HH:MM format (e.g., '2025-09-05_15:30'). Without 'utc_offset', times are interpreted in the server's configured timezone (${formatUTCOffset(timezoneOffset)}). The provided format '${reminderTimeArg}' is invalid.`,
          data: {
            status: "reminder_creation_failed_invalid_time_format",
            reason: `Invalid reminder time format: '${reminderTimeArg}'. Expected YYYY-MM-DD_HH:MM format in ${formatUTCOffset(effectiveParseOffset)}.`,
            provided_time: reminderTimeArg,
            server_timezone: formatUTCOffset(timezoneOffset),
          },
        };
      }
    } else {
      const hasRelativeParams =
        (typeof minutesFromNowArg === "number" && minutesFromNowArg > 0) ||
        (typeof hoursFromNowArg === "number" && hoursFromNowArg > 0) ||
        (typeof daysFromNowArg === "number" && daysFromNowArg > 0) ||
        (typeof monthsFromNowArg === "number" && monthsFromNowArg > 0);

      // Default to 1 minute if no time parameters provided (immediate message use case)
      let effectiveMinutesFromNow = minutesFromNowArg;
      if (!hasRelativeParams) {
        effectiveMinutesFromNow = 1;
        log.info("No time parameters provided for reminder - defaulting to 1 minute from now");
      }

      timeCalculationMethod = "relative";
      const currentTime = new Date();
      let totalMilliseconds = 0;

      if (typeof effectiveMinutesFromNow === "number" && effectiveMinutesFromNow > 0) {
        totalMilliseconds += effectiveMinutesFromNow * 60 * 1000;
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
      let actualNicknameInDB = requestedTargetUser || "Tomori";
      let resolvedTargetUserId = "";
      let resolvedTargetUserLabel = actualNicknameInDB;
      // Target's personal timezone offset (/personal config): used only for the
      // dual-clock confirmation display, never for time interpretation
      let targetPersonalOffset: number | null = null;

      if (isSelfReminder) {
        resolvedTargetUserId = botUserId as string;
        actualNicknameInDB = tomoriState.persona_nickname || context.client.user?.username || "Tomori";
        resolvedTargetUserLabel = actualNicknameInDB;
      } else if (shouldDefaultTargetToInvoker) {
        resolvedTargetUserId = resolvedUserId;
        actualNicknameInDB = requestingUserRow?.user_nickname ?? context.message?.author?.displayName ?? "Unknown";
        resolvedTargetUserLabel = actualNicknameInDB;
        targetPersonalOffset = requestingUserRow?.timezone_offset ?? null;
        log.info(`Reminder tool: Defaulted missing target_user to invoking user ${resolvedTargetUserId}`);
      } else {
        const userResolution = await resolveUserTarget(requestedTargetUser as string, context);
        if (userResolution.status === "ambiguous") {
          return {
            success: false,
            error: `Multiple users match "${requestedTargetUser}". Please clarify which one you mean: ${userResolution.candidates.map((candidate) => candidate.label).join(", ")}.`,
            data: {
              status: "reminder_creation_failed_ambiguous_user",
              reason: "Multiple users matched the requested target.",
              candidates: userResolution.candidates.map((candidate) => candidate.label),
            },
          };
        }

        if (userResolution.status === "not_found") {
          return {
            success: false,
            error: `Could not find a user matching "${requestedTargetUser}" in this conversation or server.`,
            data: {
              status: "reminder_creation_failed_user_not_found",
              reason: "The requested user was not found in this conversation or server.",
            },
          };
        }

        resolvedTargetUserId = userResolution.targetId;
        resolvedTargetUserLabel = userResolution.displayLabel;

        if (userResolution.isBridgeUser) {
          actualNicknameInDB = userResolution.displayLabel.replace(/\s+\(Matrix\)$/u, "");
          log.info(
            `Reminder: Target is a bridge user (${resolvedTargetUserId}), storing display label "${actualNicknameInDB}" without a DB lookup`,
          );
        } else {
          const targetUserRow = await userRepository.loadByDiscordId(resolvedTargetUserId);

          if (!targetUserRow?.user_id) {
            log.warn(`Reminder: Resolved target user ${resolvedTargetUserId} is unknown to TomoriBot`);
            return {
              success: false,
              error: `I don't know ${resolvedTargetUserLabel} yet, so I cannot create a reminder for them.`,
              data: {
                status: "reminder_creation_failed_user_not_found",
                reason: "I can only create reminders for users I already know.",
              },
            };
          }

          actualNicknameInDB = resolvedTargetUserLabel ?? targetUserRow.user_nickname ?? targetUserRow.user_disc_id;
          targetPersonalOffset = targetUserRow.timezone_offset ?? null;
        }
      }

      const dbResult = await serverScheduleRepository.addReminder({
        server_id: tomoriState.server_id,
        channel_disc_id: resolvedChannelId,
        user_discord_id: resolvedTargetUserId,
        user_nickname: actualNicknameInDB, // Use the verified nickname from DB
        reminder_purpose: reminderPurpose,
        reminder_time: finalReminderTime,
        repetition_interval_hours: repetitionIntervalHours,
        self_reminder: isSelfReminder,
        created_by_user_id: requestingUserRow?.user_id ?? null,
        persona_id: context.tomoriState.persona_id ?? null,
      });

      if (dbResult) {
        log.success(
          `Reminder created (ID: ${dbResult.reminder_id}): "${reminderPurpose}" for ${actualNicknameInDB} (${resolvedTargetUserId}) at ${finalReminderTime.toISOString()}`,
        );

        const timeRemainingMs = finalReminderTime.getTime() - Date.now();
        const timeRemainingStr = formatTimeRemaining(timeRemainingMs);

        // Format the reminder time in the server's configured timezone
        const timeFormatOptions: Intl.DateTimeFormatOptions = {
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        };
        const formattedReminderTime = formatTimeWithOffset(finalReminderTime, timezoneOffset, timeFormatOptions);

        const useRecurringTaskEmbed = isSelfReminder && repetitionIntervalHours !== null;
        const useOneTimeTaskEmbed = isSelfReminder && repetitionIntervalHours === null;
        const reminderPurposeText =
          reminderPurpose.length > 200 ? `${reminderPurpose.substring(0, 197)}...` : reminderPurpose;
        // Show both clocks when the target has a personal timezone differing from
        // the server's, so lets the user immediately spot a mislabeled/misconverted time
        const reminderTimeText =
          targetPersonalOffset != null && targetPersonalOffset !== timezoneOffset
            ? localizer(context.locale, "reminders.dual_time_display", {
                server_time: formattedReminderTime,
                server_offset: formatUTCOffset(timezoneOffset),
                user_time: formatTimeWithOffset(finalReminderTime, targetPersonalOffset, timeFormatOptions),
                user_offset: formatUTCOffset(targetPersonalOffset),
                user_nickname: actualNicknameInDB,
              })
            : `${formattedReminderTime} (${formatUTCOffset(timezoneOffset)})`;
        const baseDescriptionVars = {
          user_nickname: actualNicknameInDB,
          reminder_purpose: reminderPurposeText,
          reminder_time: reminderTimeText,
        };
        const descriptionVars = useRecurringTaskEmbed
          ? {
              ...baseDescriptionVars,
              repetition_interval_hours: repetitionIntervalHours as number,
            }
          : baseDescriptionVars;

        // Long purposes receive an expansion button so the full text remains
        // available ephemerally without adding channel clutter.
        await sendTaskEmbedWithExpand(
          context.channel,
          context.locale,
          {
            color: useRecurringTaskEmbed ? ColorCode.INFO : ColorCode.SUCCESS,
            titleKey: useRecurringTaskEmbed
              ? "reminders.recurring_task_set_title"
              : useOneTimeTaskEmbed
                ? "reminders.task_set_title"
                : "reminders.reminder_set_title",
            titleVars: {
              persona_nickname: personaNickname,
            },
            descriptionKey: useRecurringTaskEmbed
              ? "reminders.recurring_task_set_description"
              : useOneTimeTaskEmbed
                ? "reminders.task_set_description"
                : "reminders.reminder_set_description",
            descriptionVars,
            footerKey: useRecurringTaskEmbed
              ? "reminders.recurring_task_set_footer"
              : repetitionIntervalHours
                ? "reminders.reminder_set_footer_recurring"
                : useOneTimeTaskEmbed
                  ? "reminders.task_set_footer"
                  : "reminders.reminder_set_footer",
            footerVars: repetitionIntervalHours
              ? {
                  time_remaining: timeRemainingStr,
                  repetition_interval_hours: repetitionIntervalHours,
                }
              : {
                  time_remaining: timeRemainingStr,
                },
          },
          reminderPurpose,
          {
            webhook: context.webhook,
            personaUsername: context.personaUsername,
            personaAvatarUrl: context.personaAvatarUrl,
          },
        );

        return {
          success: true,
          message: `Reminder successfully set for ${actualNicknameInDB}`,
          data: {
            status: "reminder_created_successfully",
            reminder_id: dbResult.reminder_id,
            target_user: resolvedTargetUserLabel,
            reminder_purpose: reminderPurpose,
            reminder_time: finalReminderTime.toISOString(),
            repetition_interval_hours: repetitionIntervalHours,
            target_channel: resolvedChannelLabel,
            self_reminder: isSelfReminder,
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
