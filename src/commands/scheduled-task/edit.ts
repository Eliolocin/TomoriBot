import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  ModalSubmitInteraction,
  SlashCommandSubcommandBuilder,
} from "discord.js";
import { MessageFlags, TextInputStyle } from "discord.js";
import { localizer } from "@/utils/text/localizer";
import { log, ColorCode } from "@/utils/misc/logger";
import {
  acknowledgeModalSubmitForRefresh,
  promptWithPaginatedModal,
  promptWithRawModal,
  safeSelectOptionText,
} from "@/utils/discord/ui/modals";
import { promptWithUnacknowledgedConfirmation } from "@/utils/discord/ui/confirmation";
import { replyComponentsV2Status } from "@/utils/discord/ui/statusComponents";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { getCachedTomoriState } from "@/utils/cache/tomoriStateCache";
import { serverScheduleRepository } from "@/utils/db/repositories";
import { isBridgeUserId } from "@/utils/bridges";
import { validateFutureTime } from "@/utils/text/processors/timeUtils";
import { formatTimeWithOffset, formatUTCOffset } from "@/utils/text/timezoneHelper";
import type { SelectOption } from "@/types/discord/modal";
import type { ErrorContext, TomoriState, UserRow } from "@/types/db/schema";
import type { ReminderSelectionRow } from "@/utils/db/repositories";

const SELECT_MODAL_CUSTOM_ID = "scheduled_task_edit_select_modal";
const EDIT_MODAL_CUSTOM_ID = "scheduled_task_edit_value_modal";
const REMINDER_SELECT_ID = "reminder_select";
const PURPOSE_INPUT_ID = "reminder_purpose_input";
const TIME_INPUT_ID = "reminder_time_input";
const INTERVAL_INPUT_ID = "reminder_interval_input";
const REMINDER_FOR_ME_ID = "reminder_for_me_checkbox";
const REMINDER_PURPOSE_MAX_LENGTH = 4000;

type ParsedTimeOfDay = {
  hour: number;
  minute: number;
  addDay: boolean;
};

function formatReminderPreview(reminderPurpose: string, maxLength = 96): string {
  return reminderPurpose.length > maxLength ? `${reminderPurpose.slice(0, maxLength - 3)}...` : reminderPurpose;
}

function getChannelName(interaction: ChatInputCommandInteraction, channelId: string): string {
  return interaction.guild?.channels.cache.get(channelId)?.name ?? channelId;
}

function getChannelDisplay(interaction: ChatInputCommandInteraction, channelId: string): string {
  const channelName = getChannelName(interaction, channelId);
  return channelName === channelId ? channelId : `#${channelName}`;
}

function getLocalDateParts(
  date: Date,
  offsetHours: number,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const localDate = new Date(date.getTime() + offsetHours * 3600000);
  return {
    year: localDate.getUTCFullYear(),
    month: localDate.getUTCMonth() + 1,
    day: localDate.getUTCDate(),
    hour: localDate.getUTCHours(),
    minute: localDate.getUTCMinutes(),
  };
}

function localDatePartsToUtcDate(
  parts: { year: number; month: number; day: number; hour: number; minute: number },
  offsetHours: number,
): Date {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - offsetHours * 3600000);
}

function formatTimeInput(date: Date, offsetHours: number): string {
  const parts = getLocalDateParts(date, offsetHours);
  return `${parts.hour.toString().padStart(2, "0")}:${parts.minute.toString().padStart(2, "0")}`;
}

function parseTimeOfDay(input: string): ParsedTimeOfDay | null {
  const trimmed = input.trim();
  const colonMatch = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  const compactMatch = trimmed.match(/^(\d{3,4})$/);

  let hour: number;
  let minute: number;
  if (colonMatch) {
    hour = Number.parseInt(colonMatch[1], 10);
    minute = Number.parseInt(colonMatch[2], 10);
  } else if (compactMatch) {
    const compact = compactMatch[1].padStart(4, "0");
    hour = Number.parseInt(compact.slice(0, 2), 10);
    minute = Number.parseInt(compact.slice(2), 10);
  } else {
    return null;
  }

  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return null;
  }
  if (hour === 24 && minute === 0) {
    return { hour: 0, minute: 0, addDay: true };
  }
  if (hour < 0 || hour > 23) {
    return null;
  }

  return { hour, minute, addDay: false };
}

function buildEditedReminderTime(currentReminderTime: Date, timeInput: string, offsetHours: number): Date | null {
  const parsedTime = parseTimeOfDay(timeInput);
  if (!parsedTime) {
    return null;
  }

  const currentParts = getLocalDateParts(currentReminderTime, offsetHours);
  let editedTime = localDatePartsToUtcDate(
    {
      year: currentParts.year,
      month: currentParts.month,
      day: currentParts.day + (parsedTime.addDay ? 1 : 0),
      hour: parsedTime.hour,
      minute: parsedTime.minute,
    },
    offsetHours,
  );

  while (!validateFutureTime(editedTime)) {
    editedTime = new Date(editedTime.getTime() + 24 * 60 * 60 * 1000);
  }

  return editedTime;
}

function parseIntervalHours(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const interval = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(interval) ? interval : null;
}

function formatReminderDetails(
  interaction: ChatInputCommandInteraction,
  reminder: ReminderSelectionRow,
  timezoneOffset: number,
  locale: string,
): {
  reminder_purpose: string;
  reminder_time: string;
  repetition_interval_hours: string;
  reminder_type: string;
  target_user: string;
  target_channel: string;
} {
  const reminderTime = formatTimeWithOffset(new Date(reminder.reminder_time), timezoneOffset, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const repetitionInterval =
    typeof reminder.repetition_interval_hours === "number" && reminder.repetition_interval_hours >= 1
      ? `${reminder.repetition_interval_hours}`
      : "0";

  return {
    reminder_purpose: formatReminderPreview(reminder.reminder_purpose, 240),
    reminder_time: `${reminderTime} (${formatUTCOffset(timezoneOffset)})`,
    repetition_interval_hours: repetitionInterval,
    reminder_type: reminder.self_reminder
      ? localizer(locale, "commands.scheduled-task.edit.type_task")
      : localizer(locale, "commands.scheduled-task.edit.type_reminder"),
    target_user: reminder.self_reminder
      ? localizer(locale, "commands.scheduled-task.edit.target_none")
      : reminder.user_nickname,
    target_channel: getChannelDisplay(interaction, reminder.channel_disc_id),
  };
}

async function performReminderEdit(
  reminderToEdit: ReminderSelectionRow,
  newPurpose: string,
  newReminderTime: Date,
  newIntervalHours: number,
  isReminderForInvoker: boolean,
  client: Client,
  tomoriState: TomoriState,
  userData: UserRow,
  hasManagePermission: boolean,
  replyInteraction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction,
  locale: string,
  suppressSuccessReply = false,
): Promise<boolean> {
  const botUserId = client.user?.id;
  if (!isReminderForInvoker && !botUserId) {
    await replyInfoEmbed(replyInteraction, locale, {
      titleKey: "general.errors.operation_failed_title",
      descriptionKey: "general.errors.operation_failed_description",
      color: ColorCode.ERROR,
    });
    return false;
  }

  const targetUserId = isReminderForInvoker ? userData.user_disc_id : (botUserId as string);
  const targetUserNickname = isReminderForInvoker
    ? (userData.user_nickname ?? replyInteraction.user.displayName)
    : (tomoriState.persona_nickname ?? client.user?.username ?? "Tomori");

  const updatedReminder = await serverScheduleRepository.updateReminder({
    reminder_id: reminderToEdit.reminder_id,
    server_id: tomoriState.server_id,
    reminder_purpose: newPurpose,
    reminder_time: newReminderTime,
    repetition_interval_hours: newIntervalHours > 0 ? newIntervalHours : null,
    self_reminder: !isReminderForInvoker,
    user_discord_id: targetUserId,
    user_nickname: targetUserNickname,
    owner_user_id: hasManagePermission ? undefined : userData.user_id,
  });

  if (!updatedReminder) {
    await replyInfoEmbed(replyInteraction, locale, {
      titleKey: "general.errors.update_failed_title",
      descriptionKey: "general.errors.update_failed_description",
      color: ColorCode.ERROR,
    });
    return false;
  }

  log.success(`Edited reminder ${reminderToEdit.reminder_id} (${formatReminderPreview(newPurpose, 60)})`);

  if (!suppressSuccessReply) {
    await replyInfoEmbed(replyInteraction, locale, {
      titleKey: "commands.scheduled-task.edit.success_title",
      descriptionKey: "commands.scheduled-task.edit.success_description",
      descriptionVars: {
        reminder_purpose: formatReminderPreview(newPurpose, 96),
      },
      color: ColorCode.SUCCESS,
    });
  }

  return true;
}

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("edit").setDescription(localizer("en-US", "commands.scheduled-task.edit.description"));

export async function execute(
  client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.channel) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.channel_only_title",
      descriptionKey: "general.errors.channel_only_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let tomoriState: TomoriState | null = null;

  try {
    tomoriState = await getCachedTomoriState(interaction.guild?.id ?? interaction.user.id);
    if (!tomoriState) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const hasManagePermission = interaction.memberPermissions?.has("ManageGuild") ?? false;
    const timezoneOffset = tomoriState.config.timezone_offset ?? 0;
    const state = tomoriState;

    const reminders = await serverScheduleRepository.loadReminderSelections(
      tomoriState.server_id,
      hasManagePermission ? undefined : userData.user_id,
    );

    if (!reminders || reminders.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.scheduled-task.edit.no_entries_title",
        descriptionKey: "commands.scheduled-task.edit.no_entries",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Build select options: persona_id NULL means the main persona owns the reminder
    const reminderSelectOptions: SelectOption[] = reminders.map((reminder, index) => {
      const personaName = reminder.persona_nickname ?? state.persona_nickname;
      const formattedTime = formatTimeWithOffset(new Date(reminder.reminder_time), timezoneOffset, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      const repeatText =
        typeof reminder.repetition_interval_hours === "number" && reminder.repetition_interval_hours >= 1
          ? localizer(locale, "commands.scheduled-task.edit.select_repeat_text", {
              hours: reminder.repetition_interval_hours,
            })
          : "";
      const typeText = reminder.self_reminder
        ? localizer(locale, "commands.scheduled-task.edit.select_type_task")
        : localizer(locale, "commands.scheduled-task.edit.select_type_reminder", {
            user_nickname: reminder.user_nickname,
          });
      const isMatrixReminder = reminder.created_by_user_id === null && isBridgeUserId(reminder.user_discord_id);
      const creatorName = isMatrixReminder
        ? `${reminder.user_nickname} (Matrix)`
        : (reminder.created_by_nickname ??
          (reminder.created_by_user_id ? `user #${reminder.created_by_user_id}` : "unknown"));
      const managerCreatedByText =
        hasManagePermission && reminder.created_by_user_id !== userData.user_id
          ? localizer(locale, "commands.scheduled-task.edit.select_manager_created_by_text", {
              creator_name: creatorName,
            })
          : "";
      const description = localizer(locale, "commands.scheduled-task.edit.select_option_description", {
        persona_name: personaName,
        reminder_time: formattedTime,
        timezone: formatUTCOffset(timezoneOffset),
        target_channel: getChannelDisplay(interaction, reminder.channel_disc_id),
        reminder_type: typeText,
        repeat_text: repeatText,
        manager_created_by_text: managerCreatedByText,
      });

      return {
        label: safeSelectOptionText(reminder.reminder_purpose, 40),
        value: index.toString(),
        description: safeSelectOptionText(description),
      };
    });

    const selectModalResult = await promptWithPaginatedModal(interaction, locale, {
      modalCustomId: SELECT_MODAL_CUSTOM_ID,
      modalTitleKey: "commands.scheduled-task.edit.select_modal_title",
      components: [
        {
          customId: REMINDER_SELECT_ID,
          labelKey: "commands.scheduled-task.edit.select_label",
          descriptionKey: "commands.scheduled-task.edit.select_description",
          placeholder: "commands.scheduled-task.edit.select_placeholder",
          required: true,
          options: reminderSelectOptions,
        },
      ],
    });

    if (selectModalResult.outcome !== "submit") {
      log.info(`Reminder edit selection modal ${selectModalResult.outcome} for user ${userData.user_id}`);
      return;
    }

    const selectModalInteraction = selectModalResult.interaction;
    const selectedIndexRaw = selectModalResult.values?.[REMINDER_SELECT_ID];
    if (!selectModalInteraction || !selectedIndexRaw) {
      log.error("Reminder edit selection unexpectedly missing interaction or values");
      return;
    }

    const selectedReminder = reminders[Number.parseInt(selectedIndexRaw, 10)];
    if (!selectedReminder) {
      await replyInfoEmbed(selectModalInteraction, locale, {
        titleKey: "general.errors.operation_failed_title",
        descriptionKey: "general.errors.operation_failed_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    // Confirm which reminder will be edited.
    // Pass selectModalInteraction directly (unacknowledged) so the confirmation becomes
    // the one ephemeral message for this whole flow, so success will update it in-place.
    const confirmationResult = await promptWithUnacknowledgedConfirmation(selectModalInteraction, locale, {
      embedTitleKey: "commands.scheduled-task.edit.confirm_title",
      embedDescriptionKey: "commands.scheduled-task.edit.confirm_description",
      embedDescriptionVars: formatReminderDetails(interaction, selectedReminder, timezoneOffset, locale),
      embedColor: ColorCode.INFO,
      useComponentsV2: true,
      continueLabelKey: "general.confirm",
      cancelLabelKey: "general.pagination.cancel",
      continueCustomId: `scheduled_task_edit_confirm_${selectModalInteraction.id}`,
      cancelCustomId: `scheduled_task_edit_cancel_${selectModalInteraction.id}`,
    });

    if (confirmationResult.outcome !== "continue" || !confirmationResult.interaction) {
      return;
    }

    const reminderForInvoker =
      selectedReminder.self_reminder !== true && selectedReminder.user_discord_id === userData.user_disc_id;
    const editModalResult = await promptWithRawModal(confirmationResult.interaction, locale, {
      modalCustomId: EDIT_MODAL_CUSTOM_ID,
      modalTitleKey: "commands.scheduled-task.edit.modal_title",
      components: [
        {
          customId: PURPOSE_INPUT_ID,
          labelKey: "commands.scheduled-task.edit.purpose_input_label",
          descriptionKey: "commands.scheduled-task.edit.purpose_input_description",
          placeholder: "commands.scheduled-task.edit.purpose_input_placeholder",
          style: TextInputStyle.Paragraph,
          required: true,
          maxLength: REMINDER_PURPOSE_MAX_LENGTH,
          value: selectedReminder.reminder_purpose.slice(0, REMINDER_PURPOSE_MAX_LENGTH),
        },
        {
          customId: TIME_INPUT_ID,
          labelKey: "commands.scheduled-task.edit.time_input_label",
          descriptionKey: "commands.scheduled-task.edit.time_input_description",
          placeholder: "commands.scheduled-task.edit.time_input_placeholder",
          style: TextInputStyle.Short,
          required: true,
          maxLength: 5,
          value: formatTimeInput(new Date(selectedReminder.reminder_time), timezoneOffset),
        },
        {
          customId: INTERVAL_INPUT_ID,
          labelKey: "commands.scheduled-task.edit.interval_input_label",
          descriptionKey: "commands.scheduled-task.edit.interval_input_description",
          placeholder: "commands.scheduled-task.edit.interval_input_placeholder",
          style: TextInputStyle.Short,
          required: true,
          maxLength: 6,
          value: (selectedReminder.repetition_interval_hours ?? 0).toString(),
        },
        {
          kind: "checkbox",
          customId: REMINDER_FOR_ME_ID,
          labelKey: "commands.scheduled-task.edit.reminder_checkbox_label",
          descriptionKey: "commands.scheduled-task.edit.reminder_checkbox_description",
          default: reminderForInvoker,
        },
      ],
    });

    if (editModalResult.outcome !== "submit") {
      log.info(`Reminder edit modal ${editModalResult.outcome} for user ${userData.user_id}`);
      return;
    }

    const editModalInteraction = editModalResult.interaction;
    if (!editModalInteraction) {
      log.error("Reminder edit modal unexpectedly missing interaction");
      return;
    }

    const editedPurpose = editModalResult.values?.[PURPOSE_INPUT_ID]?.trim() ?? "";
    const editedTimeInput = editModalResult.values?.[TIME_INPUT_ID]?.trim() ?? "";
    const editedIntervalInput = editModalResult.values?.[INTERVAL_INPUT_ID]?.trim() ?? "";
    const editedReminderForInvoker = editModalResult.values?.[REMINDER_FOR_ME_ID] === "true";

    if (!editedPurpose) {
      await replyInfoEmbed(editModalInteraction, locale, {
        titleKey: "commands.scheduled-task.edit.invalid_content_title",
        descriptionKey: "commands.scheduled-task.edit.invalid_content_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const editedReminderTime = buildEditedReminderTime(
      new Date(selectedReminder.reminder_time),
      editedTimeInput,
      timezoneOffset,
    );
    if (!editedReminderTime) {
      await replyInfoEmbed(editModalInteraction, locale, {
        titleKey: "commands.scheduled-task.edit.invalid_time_title",
        descriptionKey: "commands.scheduled-task.edit.invalid_time_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const editedIntervalHours = parseIntervalHours(editedIntervalInput);
    if (editedIntervalHours === null) {
      await replyInfoEmbed(editModalInteraction, locale, {
        titleKey: "commands.scheduled-task.edit.invalid_interval_title",
        descriptionKey: "commands.scheduled-task.edit.invalid_interval_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const currentIntervalHours = selectedReminder.repetition_interval_hours ?? 0;
    const noChanges =
      editedPurpose === selectedReminder.reminder_purpose.trim() &&
      editedReminderTime.getTime() === new Date(selectedReminder.reminder_time).getTime() &&
      editedIntervalHours === currentIntervalHours &&
      editedReminderForInvoker === reminderForInvoker;

    if (noChanges) {
      await replyInfoEmbed(editModalInteraction, locale, {
        titleKey: "commands.scheduled-task.edit.no_changes_title",
        descriptionKey: "commands.scheduled-task.edit.no_changes_description",
        color: ColorCode.WARN,
      });
      return;
    }

    const editSucceeded = await performReminderEdit(
      selectedReminder,
      editedPurpose,
      editedReminderTime,
      editedIntervalHours,
      editedReminderForInvoker,
      client,
      tomoriState,
      userData,
      hasManagePermission,
      editModalInteraction,
      locale,
      true,
    );
    if (!editSucceeded) {
      return;
    }

    const updatedDetails = {
      reminder_purpose: formatReminderPreview(editedPurpose, 240),
      reminder_time: `${formatTimeWithOffset(editedReminderTime, timezoneOffset, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })} (${formatUTCOffset(timezoneOffset)})`,
      repetition_interval_hours: editedIntervalHours.toString(),
      reminder_type: editedReminderForInvoker
        ? localizer(locale, "commands.scheduled-task.edit.type_reminder")
        : localizer(locale, "commands.scheduled-task.edit.type_task"),
      target_user: editedReminderForInvoker
        ? (userData.user_nickname ?? interaction.user.displayName)
        : localizer(locale, "commands.scheduled-task.edit.target_none"),
      target_channel: getChannelDisplay(interaction, selectedReminder.channel_disc_id),
    };

    // deferUpdate on the edit modal submit targets the button's message (the confirmation),
    // so replyComponentsV2Status will editReply into that same ephemeral message.
    await acknowledgeModalSubmitForRefresh(editModalInteraction);
    await replyComponentsV2Status(
      editModalInteraction,
      locale,
      "commands.scheduled-task.edit.success_title",
      "commands.scheduled-task.edit.success_description",
      ColorCode.SUCCESS,
      updatedDetails,
    );
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: tomoriState?.server_id,
      personaId: tomoriState?.persona_id,
      errorType: "CommandExecutionError",
      metadata: {
        command: "scheduled-task edit",
        guildId: interaction.guild?.id,
        executorDiscordId: interaction.user.id,
      },
    };
    await log.error(
      `Unexpected error in /scheduled-task edit for user ${userData.user_disc_id}`,
      error as Error,
      context,
    );

    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
  }
}
