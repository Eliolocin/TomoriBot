/**
 * Update Task Tool
 *
 * Replaces or deletes an existing scheduled reminder/task by ID.
 * The ID is shown in participant context as "ID:N".
 */

import { extractBridgeUserId, isMatrixBridgeWebhookUsername } from "@/utils/bridges";
import { sendTaskEmbedWithExpand } from "@/utils/discord/expandableEmbedNotice";
import { log, ColorCode } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";
import { validateFutureTime } from "@/utils/text/processors/timeUtils";
import {
  formatTimeWithOffset,
  formatUTCOffset,
  isValidUtcOffset,
  parseTimeWithOffset,
  UTC_OFFSET_MAX,
  UTC_OFFSET_MIN,
} from "@/utils/text/timezoneHelper";
import { BaseTool, type ToolContext, type ToolParameterSchema, type ToolResult } from "@/types/tool/interfaces";
import type { ReminderRow } from "@/types/db/schema";

const RELATIVE_TIME_MULTIPLIERS_MS = {
  minutes_from_now: 60 * 1000,
  hours_from_now: 60 * 60 * 1000,
  days_from_now: 24 * 60 * 60 * 1000,
  months_from_now: 30.44 * 24 * 60 * 60 * 1000,
} as const;

type RelativeTimeKey = keyof typeof RELATIVE_TIME_MULTIPLIERS_MS;

const RELATIVE_TIME_KEYS = Object.keys(RELATIVE_TIME_MULTIPLIERS_MS) as RelativeTimeKey[];

export type UpdateTaskActor = {
  requesterUserId?: number;
  requesterDiscordId?: string;
  requesterBridgeUserId?: string;
};

export type UpdateTaskArgumentParseResult =
  | {
      ok: true;
      reminderId: number;
      newPurpose: string;
      isDeleteRequested: boolean;
      newReminderTime?: Date;
      hasRepetitionIntervalUpdate: boolean;
      repetitionIntervalHours?: number | null;
    }
  | {
      ok: false;
      status: "task_update_failed_invalid_args" | "task_update_failed_invalid_time";
      reason: string;
    };

function truncateReminderPurpose(reminderPurpose: string, maxLength = 200): string {
  return reminderPurpose.length > maxLength ? `${reminderPurpose.substring(0, maxLength - 3)}...` : reminderPurpose;
}

function normalizeReminderTimeInput(reminderTime: string): string {
  let normalized = reminderTime.trim();
  normalized = normalized.replace(/^(\d{4})\/(\d{2})\/(\d{2})/, "$1-$2-$3");
  normalized = normalized.replace(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/, "$1_$2");
  return normalized;
}

function hasProvidedArg(args: Record<string, unknown>, key: string): boolean {
  return key in args && args[key] !== undefined && args[key] !== null;
}

export function parseUpdateTaskArguments(
  args: Record<string, unknown>,
  timezoneOffset: number,
): UpdateTaskArgumentParseResult {
  const reminderIdArg = args.reminder_id;
  if (typeof reminderIdArg !== "number" || !Number.isSafeInteger(reminderIdArg) || reminderIdArg <= 0) {
    return {
      ok: false,
      status: "task_update_failed_invalid_args",
      reason: "The 'reminder_id' argument was missing or invalid.",
    };
  }

  const reminderPurposeArg = args.reminder_purpose;
  if (typeof reminderPurposeArg !== "string") {
    return {
      ok: false,
      status: "task_update_failed_invalid_args",
      reason: "The 'reminder_purpose' argument was missing or not a string.",
    };
  }

  const newPurpose = reminderPurposeArg.trim();
  const isDeleteRequested = newPurpose.length === 0;
  if (isDeleteRequested) {
    return {
      ok: true,
      reminderId: Math.trunc(reminderIdArg),
      newPurpose,
      isDeleteRequested,
      hasRepetitionIntervalUpdate: false,
    };
  }

  let newReminderTime: Date | undefined;
  const reminderTimeArg = args.reminder_time;
  if (typeof reminderTimeArg === "string" && reminderTimeArg.trim()) {
    // The model labels the timezone frame of reminder_time via utc_offset instead of
    // converting the time itself; fall back to the server timezone when unlabeled.
    let effectiveParseOffset = timezoneOffset;
    if (hasProvidedArg(args, "utc_offset")) {
      const utcOffsetArg = args.utc_offset;
      if (!isValidUtcOffset(utcOffsetArg)) {
        return {
          ok: false,
          status: "task_update_failed_invalid_args",
          reason: `Invalid 'utc_offset' value: '${utcOffsetArg}'. Expected a number of hours between ${UTC_OFFSET_MIN} and ${UTC_OFFSET_MAX}.`,
        };
      }
      effectiveParseOffset = utcOffsetArg;
    }

    const normalizedReminderTime = normalizeReminderTimeInput(reminderTimeArg);
    const parsedReminderTime = parseTimeWithOffset(normalizedReminderTime, effectiveParseOffset);
    if (!parsedReminderTime) {
      return {
        ok: false,
        status: "task_update_failed_invalid_time",
        reason: `Invalid reminder time format: '${reminderTimeArg}'. Expected YYYY-MM-DD_HH:MM format in ${formatUTCOffset(effectiveParseOffset)}.`,
      };
    }
    newReminderTime = parsedReminderTime;
  } else {
    const hasRelativeParams = RELATIVE_TIME_KEYS.some((key) => hasProvidedArg(args, key));
    if (hasRelativeParams) {
      let totalMilliseconds = 0;

      for (const key of RELATIVE_TIME_KEYS) {
        if (!hasProvidedArg(args, key)) continue;

        const value = args[key];
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
          return {
            ok: false,
            status: "task_update_failed_invalid_time",
            reason: `The '${key}' argument must be a number greater than 0 when provided.`,
          };
        }

        totalMilliseconds += value * RELATIVE_TIME_MULTIPLIERS_MS[key];
      }

      if (totalMilliseconds <= 0) {
        return {
          ok: false,
          status: "task_update_failed_invalid_time",
          reason: "Relative time parameters must schedule the task in the future.",
        };
      }

      newReminderTime = new Date(Date.now() + totalMilliseconds);
    }
  }

  if (newReminderTime && !validateFutureTime(newReminderTime)) {
    return {
      ok: false,
      status: "task_update_failed_invalid_time",
      reason: "The updated reminder time must be in the future.",
    };
  }

  let hasRepetitionIntervalUpdate = false;
  let repetitionIntervalHours: number | null | undefined;
  if (hasProvidedArg(args, "repetition_interval_hours")) {
    const repetitionIntervalHoursArg = args.repetition_interval_hours;
    if (
      typeof repetitionIntervalHoursArg !== "number" ||
      !Number.isSafeInteger(repetitionIntervalHoursArg) ||
      repetitionIntervalHoursArg < 0
    ) {
      return {
        ok: false,
        status: "task_update_failed_invalid_args",
        reason: "The 'repetition_interval_hours' argument must be 0 or an integer greater than or equal to 1.",
      };
    }

    hasRepetitionIntervalUpdate = true;
    repetitionIntervalHours = repetitionIntervalHoursArg > 0 ? repetitionIntervalHoursArg : null;
  }

  return {
    ok: true,
    reminderId: Math.trunc(reminderIdArg),
    newPurpose,
    isDeleteRequested,
    newReminderTime,
    hasRepetitionIntervalUpdate,
    repetitionIntervalHours,
  };
}

export function canReminderActorModifyReminder(
  reminder: Pick<ReminderRow, "created_by_user_id" | "self_reminder" | "user_discord_id">,
  actor: UpdateTaskActor,
): boolean {
  if (
    typeof actor.requesterUserId === "number" &&
    typeof reminder.created_by_user_id === "number" &&
    reminder.created_by_user_id === actor.requesterUserId
  ) {
    return true;
  }

  if (reminder.self_reminder === true) {
    return false;
  }

  if (actor.requesterDiscordId && reminder.user_discord_id === actor.requesterDiscordId) {
    return true;
  }

  return Boolean(actor.requesterBridgeUserId && reminder.user_discord_id === actor.requesterBridgeUserId);
}

function buildFailureResult(
  status:
    | "task_update_failed_invalid_args"
    | "task_update_failed_invalid_time"
    | "task_update_failed_not_found"
    | "task_update_failed_unauthorized"
    | "task_update_failed_db_error"
    | "task_update_failed_internal_error"
    | "task_update_failed_user_not_found",
  reason: string,
): ToolResult {
  return {
    success: false,
    error: reason,
    data: {
      status,
      reason,
    },
  };
}

function formatReminderTime(reminderTime: Date, timezoneOffset: number): string {
  return `${formatTimeWithOffset(reminderTime, timezoneOffset, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })} (${formatUTCOffset(timezoneOffset)})`;
}

function formatRepeatText(locale: string, repetitionIntervalHours: number | null | undefined): string {
  if (typeof repetitionIntervalHours === "number" && repetitionIntervalHours >= 1) {
    return localizer(locale, "reminders.task_update_repeat_hours", {
      repetition_interval_hours: repetitionIntervalHours,
    });
  }

  return localizer(locale, "reminders.task_update_repeat_none");
}

export class UpdateTaskTool extends BaseTool {
  name = "update_task";
  description =
    "Replace or delete an existing scheduled task/reminder by ID. Use the reminder ID shown in context (for example, ID:42). Set reminder_purpose to the full replacement content. If reminder_purpose is empty or blank, delete the targeted reminder instead. You may optionally reschedule it with reminder_time in YYYY-MM-DD_HH:MM (pass the wall-clock time exactly as the user expressed it. NEVER convert between timezones yourself; it is interpreted in the server timezone unless you set utc_offset to the offset the user spoke in), or relative time parameters such as minutes_from_now/hours_from_now/days_from_now/months_from_now. If no time is provided, keep the existing trigger time. You may optionally set repetition_interval_hours to 0 for one-time, or 1+ for recurring; if omitted, keep the existing repeat interval. Do not use this to change target user, target channel, or whether it is a self task.";
  category = "utility" as const;

  parameters: ToolParameterSchema = {
    type: "object",
    properties: {
      reminder_id: {
        type: "number",
        description: "The reminder/task ID shown in context, such as ID:42. Must be a positive integer.",
      },
      reminder_purpose: {
        type: "string",
        description:
          "The full replacement reminder/task content. If this is empty or blank, delete the targeted reminder/task instead.",
      },
      reminder_time: {
        type: "string",
        description:
          "OPTIONAL: Absolute replacement trigger time in YYYY-MM-DD_HH:MM format. Pass the wall-clock time exactly as the user expressed it. do NOT convert between timezones yourself. Without 'utc_offset', this is interpreted in the server's configured timezone. If provided, this takes priority over relative time parameters.",
      },
      utc_offset: {
        type: "number",
        description:
          "OPTIONAL: The UTC offset in hours that 'reminder_time' is expressed in (e.g., 8 for UTC+8, -5 for UTC-5, 5.5 for UTC+5:30). Set this to the target user's personal timezone offset (shown in the conversation context) when they expressed the time in their own local time. If omitted, the server's configured timezone is used. Only meaningful together with 'reminder_time'.",
      },
      minutes_from_now: {
        type: "number",
        description:
          "OPTIONAL: Minutes from now for the replacement trigger time. Can be combined with other relative parameters.",
      },
      hours_from_now: {
        type: "number",
        description:
          "OPTIONAL: Hours from now for the replacement trigger time. Can be combined with other relative parameters.",
      },
      days_from_now: {
        type: "number",
        description:
          "OPTIONAL: Days from now for the replacement trigger time. Can be combined with other relative parameters.",
      },
      months_from_now: {
        type: "number",
        description: "OPTIONAL: Months from now for the replacement trigger time. Uses calendar months as 30.44 days.",
      },
      repetition_interval_hours: {
        type: "number",
        description:
          "OPTIONAL: Set to 0 for a one-time task/reminder, or 1+ to make it recurring. If omitted, the existing repeat interval is preserved.",
      },
    },
    required: ["reminder_id", "reminder_purpose"],
  };

  isAvailableFor(_provider: string): boolean {
    return true;
  }

  isAvailableForContext(_provider: string, context?: ToolContext): boolean {
    if (context?.streamContext?.disableReminderTool) return false;
    return true;
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const validation = this.validateParameters(args);
    if (!validation.isValid) {
      return buildFailureResult(
        "task_update_failed_invalid_args",
        `Invalid parameters: ${validation.errors?.join(", ") || `Missing required parameters: ${validation.missingParams?.join(", ")}`}`,
      );
    }

    const tomoriState = context.tomoriState;
    if (!tomoriState?.server_id) {
      log.error("Missing server_id in Tomori state for update_task");
      return buildFailureResult("task_update_failed_internal_error", "Internal bot error: Missing server context.");
    }

    const timezoneOffset = tomoriState.config.timezone_offset ?? 0;
    const parsedArgs = parseUpdateTaskArguments(args, timezoneOffset);
    if (!parsedArgs.ok) {
      return buildFailureResult(parsedArgs.status, parsedArgs.reason);
    }

    const { serverScheduleRepository, userRepository } = await import("@/utils/db/repositories");

    const isMatrixRelayRequester =
      !!context.message?.webhookId && isMatrixBridgeWebhookUsername(context.message.author.username ?? "");
    const requesterBridgeUserId = isMatrixRelayRequester
      ? (extractBridgeUserId(context.message?.author.username ?? "") ?? undefined)
      : undefined;
    const requesterDiscordId = requesterBridgeUserId ? undefined : context.message?.author?.id || context.userId;
    const requesterUserRow = requesterDiscordId ? await userRepository.loadByDiscordId(requesterDiscordId) : null;

    if (!requesterBridgeUserId && (!requesterDiscordId || !requesterUserRow?.user_id)) {
      return buildFailureResult(
        "task_update_failed_user_not_found",
        "The invoking user could not be resolved for reminder/task editing.",
      );
    }

    const actor: UpdateTaskActor = {
      requesterUserId: requesterUserRow?.user_id,
      requesterDiscordId,
      requesterBridgeUserId,
    };

    if (parsedArgs.isDeleteRequested) {
      const deleteResult = await serverScheduleRepository.deleteReminderForRequester({
        reminder_id: parsedArgs.reminderId,
        server_id: tomoriState.server_id,
        actor: {
          requester_user_id: actor.requesterUserId,
          requester_discord_id: actor.requesterDiscordId,
          requester_bridge_user_id: actor.requesterBridgeUserId,
        },
      });

      if (deleteResult.status === "not_found") {
        return buildFailureResult("task_update_failed_not_found", "Reminder/task ID not found in this server.");
      }
      if (deleteResult.status === "unauthorized") {
        return buildFailureResult(
          "task_update_failed_unauthorized",
          "You can only delete reminders/tasks you created, or non-self reminders targeted at you.",
        );
      }
      if (deleteResult.status !== "deleted") {
        return buildFailureResult("task_update_failed_db_error", "Database operation failed to delete reminder/task.");
      }

      const deletedPurpose = truncateReminderPurpose(deleteResult.reminder.reminder_purpose);
      const personaNickname =
        context.personaUsername || tomoriState.persona_nickname || context.client.user?.username || "TomoriBot";

      await sendTaskEmbedWithExpand(
        context.channel,
        context.locale,
        {
          color: ColorCode.ERROR,
          titleKey: "reminders.task_deleted_title",
          titleVars: {
            persona_nickname: personaNickname,
          },
          descriptionKey: "reminders.task_deleted_description",
          descriptionVars: {
            reminder_id: parsedArgs.reminderId,
            reminder_purpose: deletedPurpose,
          },
          footerKey: "reminders.task_deleted_footer",
        },
        deleteResult.reminder.reminder_purpose,
        {
          webhook: context.webhook,
          personaUsername: context.personaUsername,
          personaAvatarUrl: context.personaAvatarUrl,
        },
      );

      return {
        success: true,
        message: "Reminder/task deleted successfully",
        data: {
          status: "task_deleted_successfully",
          reminder_id: parsedArgs.reminderId,
          reminder_purpose_deleted: deleteResult.reminder.reminder_purpose,
        },
      };
    }

    const existingReminder = await serverScheduleRepository.getReminderById(parsedArgs.reminderId);
    if (!existingReminder || existingReminder.server_id !== tomoriState.server_id) {
      return buildFailureResult("task_update_failed_not_found", "Reminder/task ID not found in this server.");
    }

    if (!canReminderActorModifyReminder(existingReminder, actor)) {
      return buildFailureResult(
        "task_update_failed_unauthorized",
        "You can only update reminders/tasks you created, or non-self reminders targeted at you.",
      );
    }

    const finalReminderTime = parsedArgs.newReminderTime ?? new Date(existingReminder.reminder_time);
    if (!validateFutureTime(finalReminderTime)) {
      return buildFailureResult("task_update_failed_invalid_time", "The updated reminder time must be in the future.");
    }

    const finalRepetitionIntervalHours = parsedArgs.hasRepetitionIntervalUpdate
      ? (parsedArgs.repetitionIntervalHours ?? null)
      : (existingReminder.repetition_interval_hours ?? null);

    const updateResult = await serverScheduleRepository.updateReminderCoreForRequester({
      reminder_id: parsedArgs.reminderId,
      server_id: tomoriState.server_id,
      reminder_purpose: parsedArgs.newPurpose,
      reminder_time: finalReminderTime,
      repetition_interval_hours: finalRepetitionIntervalHours,
      actor: {
        requester_user_id: actor.requesterUserId,
        requester_discord_id: actor.requesterDiscordId,
        requester_bridge_user_id: actor.requesterBridgeUserId,
      },
    });

    if (updateResult.status === "not_found") {
      return buildFailureResult("task_update_failed_not_found", "Reminder/task ID not found in this server.");
    }
    if (updateResult.status === "unauthorized") {
      return buildFailureResult(
        "task_update_failed_unauthorized",
        "You can only update reminders/tasks you created, or non-self reminders targeted at you.",
      );
    }
    if (updateResult.status !== "updated") {
      return buildFailureResult("task_update_failed_db_error", "Database operation failed to update reminder/task.");
    }

    const personaNickname =
      context.personaUsername || tomoriState.persona_nickname || context.client.user?.username || "TomoriBot";
    const reminderPurposeText = truncateReminderPurpose(parsedArgs.newPurpose);

    // Show both clocks when the target user has a personal timezone (/personal config)
    // differing from the server's, so lets the user spot a mislabeled/misconverted time.
    // Self tasks target the bot, which has no personal timezone.
    let targetPersonalOffset: number | null = null;
    if (!existingReminder.self_reminder) {
      const targetUserRow = await userRepository.loadByDiscordId(existingReminder.user_discord_id);
      targetPersonalOffset = targetUserRow?.timezone_offset ?? null;
    }
    const reminderTimeText =
      targetPersonalOffset != null && targetPersonalOffset !== timezoneOffset
        ? localizer(context.locale, "reminders.dual_time_display", {
            server_time: formatTimeWithOffset(finalReminderTime, timezoneOffset, {
              year: "numeric",
              month: "long",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }),
            server_offset: formatUTCOffset(timezoneOffset),
            user_time: formatTimeWithOffset(finalReminderTime, targetPersonalOffset, {
              year: "numeric",
              month: "long",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }),
            user_offset: formatUTCOffset(targetPersonalOffset),
            user_nickname: existingReminder.user_nickname,
          })
        : formatReminderTime(finalReminderTime, timezoneOffset);
    const repeatText = formatRepeatText(context.locale, finalRepetitionIntervalHours);

    await sendTaskEmbedWithExpand(
      context.channel,
      context.locale,
      {
        color: ColorCode.MEMORY_UPDATE,
        titleKey: "reminders.task_updated_title",
        titleVars: {
          persona_nickname: personaNickname,
        },
        descriptionKey: "reminders.task_updated_description",
        descriptionVars: {
          reminder_id: parsedArgs.reminderId,
          reminder_purpose: reminderPurposeText,
          reminder_time: reminderTimeText,
          repeat_text: repeatText,
        },
        footerKey: "reminders.task_updated_footer",
      },
      parsedArgs.newPurpose,
      {
        webhook: context.webhook,
        personaUsername: context.personaUsername,
        personaAvatarUrl: context.personaAvatarUrl,
      },
    );

    return {
      success: true,
      message: "Reminder/task updated successfully",
      data: {
        status: "task_updated_successfully",
        reminder_id: parsedArgs.reminderId,
        reminder_purpose: parsedArgs.newPurpose,
        reminder_time: finalReminderTime.toISOString(),
        repetition_interval_hours: finalRepetitionIntervalHours,
        self_reminder: existingReminder.self_reminder ?? false,
        target_user: existingReminder.user_nickname,
        target_channel_id: existingReminder.channel_disc_id,
      },
    };
  }
}
