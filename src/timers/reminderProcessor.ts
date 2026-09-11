import type { Client, Message, TextBasedChannel, TextChannel } from "discord.js";
import { ChannelType } from "discord.js";
import { log, ColorCode } from "../utils/misc/logger";
import { serverScheduleRepository } from "@/utils/db/repositories";

import type { ReminderRow } from "../types/db/schema";
import { calculateLateness } from "@/utils/text/processors/timeUtils";
import { tomoriChat, suppressNextSelfReply } from "../events/messageCreate/tomoriChat";
import { createStandardEmbed, truncateForEmbedDescription } from "../utils/discord/embedHelper";
import { getCachedAllPersonas } from "../utils/cache/tomoriStateCache";
import { getCachedUserRow } from "../utils/cache/userCache";
import {
  getOrCreateWebhook,
  resolvePersonaWebhookIdentity,
  sendWebhookMessageWithIdentity,
} from "../utils/discord/webhookManager";
import { ensureDiscordUserMention } from "../utils/discord/mentionHelper";
import { isBridgeUserId } from "../utils/bridges";
import { sendMatrixReminderMention } from "../utils/bridges/matrix";
import type { GenerationTurnResult, QueuedMessageDiscardReason } from "@/utils/chat/types";
import { runWithErrorContext } from "@/utils/misc/errorContextStore";
import { parseIntegerEnvFlag } from "@/utils/misc/envFlags";
import { neutralizeFenceRuns } from "@/utils/text/discordTextLimits";
import { localizer } from "@/utils/text/localizer";

const REMINDER_DELIVERY_RETRY_DELAY_MS = parseIntegerEnvFlag(
  process.env.REMINDER_DELIVERY_RETRY_DELAY_MS,
  60_000,
  1_000,
);

/**
 * Cap on unacknowledged delivery retries before a reminder is surfaced via the plain
 * fallback embed. Without a cap, any failure that also writes to the channel
 * becomes an unbounded loop: the retry's own output changes the channel's last message,
 * which is the very input the next retry reads back.
 */
const REMINDER_DELIVERY_MAX_RETRIES = parseIntegerEnvFlag(process.env.REMINDER_DELIVERY_MAX_RETRIES, 5, 1);

function getNextRecurringReminderTime(
  reminderTime: Date,
  repetitionIntervalHours: number,
  referenceTimeMs = Date.now(),
): Date {
  const intervalMs = repetitionIntervalHours * 60 * 60 * 1000;
  const scheduledTimeMs = reminderTime.getTime();
  const intervalsElapsed = Math.max(1, Math.floor((referenceTimeMs - scheduledTimeMs) / intervalMs) + 1);
  return new Date(scheduledTimeMs + intervalsElapsed * intervalMs);
}

function isReminderDeliverySuccessful(result: GenerationTurnResult): boolean {
  return result.status === "completed";
}

function buildFallbackDescription(locale: string, reminder: ReminderRow): string {
  const header = localizer(locale, "reminders.triggered_description", {
    reminder_id: reminder.reminder_id ?? "?",
  });
  const fenceStart = "```text\n";
  const fenceEnd = "\n```";
  const sanitizedPurpose = neutralizeFenceRuns(reminder.reminder_purpose);
  const purpose = truncateForEmbedDescription(
    sanitizedPurpose,
    header.length + fenceStart.length + fenceEnd.length + 1,
  );
  return `${header}\n${fenceStart}${purpose}${fenceEnd}`;
}

export class ReminderProcessor {
  private readonly client: Client;
  private readonly activeReminderIds = new Set<number>();

  constructor(client: Client) {
    this.client = client;
  }

  public async processDueReminders(): Promise<void> {
    try {
      const dueReminders = await serverScheduleRepository.getDueReminders();

      if (!dueReminders || dueReminders.length === 0) {
        return;
      }

      log.info(`Processing ${dueReminders.length} due reminder(s)`);

      for (const reminder of dueReminders) {
        await this.executeReminder(reminder);
      }
    } catch (error) {
      log.error("Error checking for due reminders:", error);
    }
  }

  private async executeReminder(reminder: ReminderRow): Promise<void> {
    return runWithErrorContext(
      {
        source: "reminder",
        sourceDetail: reminder.reminder_id != null ? String(reminder.reminder_id) : undefined,
        serverId: reminder.server_id,
        personaId: reminder.persona_id,
        userDiscId: reminder.user_discord_id,
        channelDiscId: reminder.channel_disc_id,
      },
      () => this.executeReminderInContext(reminder),
    );
  }

  private async executeReminderInContext(reminder: ReminderRow): Promise<void> {
    try {
      if (reminder.reminder_id && this.activeReminderIds.has(reminder.reminder_id)) {
        log.info(`Reminder ${reminder.reminder_id} is already queued or executing; skipping duplicate delivery.`);
        return;
      }

      log.info(
        `Executing reminder ${reminder.reminder_id} for user ${reminder.user_nickname} (${reminder.user_discord_id})`,
      );

      const channel = await this.client.channels.fetch(reminder.channel_disc_id);

      if (!channel) {
        log.error(`Channel ${reminder.channel_disc_id} not found for reminder ${reminder.reminder_id}`);
        await this.handleReminderExecutionFailure(reminder, `Channel not found: ${reminder.channel_disc_id}`);
        return;
      }

      if (!channel.isTextBased()) {
        log.error(`Channel ${reminder.channel_disc_id} is not text-based for reminder ${reminder.reminder_id}`);
        await this.handleReminderExecutionFailure(reminder, "Channel is not text-based");
        return;
      }

      let lastMessage: Message | undefined;
      try {
        const messages = await channel.messages.fetch({ limit: 1 });
        lastMessage = messages.first();
      } catch (fetchError) {
        log.error(
          `Failed to fetch last message from channel ${reminder.channel_disc_id} for reminder ${reminder.reminder_id}:`,
          fetchError,
        );
      }

      if (!lastMessage && "send" in channel) {
        try {
          lastMessage = await channel.send({
            content: "\u2800",
          });
          log.info(
            `Seeded placeholder message in channel ${reminder.channel_disc_id} for reminder ${reminder.reminder_id}`,
          );
        } catch (sendError) {
          log.warn(
            `Failed to seed placeholder message in channel ${reminder.channel_disc_id} for reminder ${reminder.reminder_id}:`,
            sendError,
          );
        }
      }

      if (!lastMessage) {
        log.warn(
          `No messages found in channel ${reminder.channel_disc_id} for reminder ${reminder.reminder_id}, sending error embed instead`,
        );
        await this.handleReminderExecutionFailure(reminder, "No messages found in channel for context");
        return;
      }

      const currentTime = new Date();
      const lateness = calculateLateness(reminder.reminder_time, currentTime);

      log.info(`About to call tomoriChat for reminder ${reminder.reminder_id}:`);
      log.info(`- Last message author: ${lastMessage.author.username} (bot: ${lastMessage.author.bot})`);
      log.info(`- Last message ID: ${lastMessage.id}`);
      log.info(`- Reminder recipient ID: ${reminder.user_discord_id}`);
      log.info(`- Reminder purpose: "${reminder.reminder_purpose}"`);
      log.info(`- Lateness: ${lateness || "none"}`);

      const reminderStartTime = Date.now();
      const isSelfReminder = reminder.self_reminder === true;
      this.markReminderDeliveryActive(reminder);
      const deliveryTracker = this.createReminderDeliveryTracker({
        reminder,
        channel,
        afterMessageId: lastMessage.id,
        reminderStartTime,
        isSelfReminder,
      });

      suppressNextSelfReply(channel.id);

      const disposition = await tomoriChat({
        client: this.client,
        message: lastMessage,
        isFromQueue: false,
        isManuallyTriggered: true,
        forceReason: false,
        isStopResponse: false,
        reminderRecipientID: reminder.user_discord_id,
        reminderData: {
          reminder_purpose: reminder.reminder_purpose,
          reminder_lateness: lateness,
          self_reminder: isSelfReminder,
        },
        selectedPersonaId: reminder.persona_id ?? undefined,
        isPersonaJob: false,
        isUserImpersonation: false,
        textQuotaSource: "system",
        shouldSurfaceUserErrors: false,
        systemTriggerIdentity:
          reminder.server_is_dm_channel && reminder.server_disc_id
            ? {
                serverDiscId: reminder.server_disc_id,
                userDiscId: reminder.server_disc_id,
              }
            : undefined,
        // Tasks (self_reminder) may spawn follow-up tasks; user reminders block create_task to prevent loops
        manualStreamingContextOverrides: isSelfReminder ? undefined : { disableReminderTool: true },
        onGenerationResult: deliveryTracker.handleGenerationResult,
        onQueueDiscard: deliveryTracker.handleQueueDiscard,
      });

      log.info(`tomoriChat call completed for reminder ${reminder.reminder_id} (disposition: ${disposition})`);

      // If the chat call was rejected before it could run (ignored/blocked/error), do not delete
      // the DB row. Defer it so transient blocked/ignored states cannot consume the reminder.
      if (disposition !== "run" && disposition !== "queued") {
        log.warn(`Reminder ${reminder.reminder_id} not executed (disposition: ${disposition}); deferring for retry.`);
        await deliveryTracker.deferRetry(`admission_${disposition}`);
        return;
      }

      if (disposition === "run" && !deliveryTracker.isSettled()) {
        await deliveryTracker.deferRetry("no_generation_result");
      } else if (disposition === "queued") {
        log.info(`Reminder ${reminder.reminder_id} queued; DB row remains pending until queued delivery completes.`);
      }
    } catch (error) {
      log.error(`Error executing reminder ${reminder.reminder_id}:`, error);
      await this.handleReminderExecutionFailure(reminder, error instanceof Error ? error.message : "Unknown error");
      this.releaseReminderDelivery(reminder);
    }
  }

  private createReminderDeliveryTracker(args: {
    reminder: ReminderRow;
    channel: TextBasedChannel;
    afterMessageId: string;
    reminderStartTime: number;
    isSelfReminder: boolean;
  }): {
    isSettled: () => boolean;
    handleGenerationResult: (result: GenerationTurnResult) => Promise<void>;
    handleQueueDiscard: (reason: QueuedMessageDiscardReason) => Promise<void>;
    deferRetry: (reason: string) => Promise<void>;
  } {
    let settled = false;

    const settle = async (operation: () => Promise<void>): Promise<void> => {
      if (settled) {
        return;
      }
      settled = true;

      try {
        await operation();
      } finally {
        this.releaseReminderDelivery(args.reminder);
      }
    };

    const deferRetry = async (reason: string): Promise<void> => {
      await settle(async () => {
        await this.deferReminderRetry(args.reminder, reason);
      });
    };

    return {
      isSettled: () => settled,
      handleGenerationResult: async (result) => {
        if (isReminderDeliverySuccessful(result)) {
          await settle(async () => {
            await this.completeReminderDelivery(args);
          });
          return;
        }

        await deferRetry(`generation_${result.status}`);
      },
      handleQueueDiscard: async (reason) => {
        await deferRetry(`queue_${reason}`);
      },
      deferRetry,
    };
  }

  private async completeReminderDelivery(args: {
    reminder: ReminderRow;
    channel: TextBasedChannel;
    afterMessageId: string;
    reminderStartTime: number;
    isSelfReminder: boolean;
  }): Promise<void> {
    const { reminder, channel, afterMessageId, reminderStartTime, isSelfReminder } = args;

    if (!isSelfReminder && isBridgeUserId(reminder.user_discord_id)) {
      await sendMatrixReminderMention(channel, reminder, afterMessageId, reminderStartTime, this.client.user?.id ?? "");
    } else if (!isSelfReminder) {
      await this.ensureReminderRecipientMention(channel, reminder, afterMessageId, reminderStartTime);
    }

    const repetitionIntervalHours =
      typeof reminder.repetition_interval_hours === "number" ? reminder.repetition_interval_hours : null;
    const isRecurring = repetitionIntervalHours !== null && repetitionIntervalHours >= 1;

    if (isRecurring && reminder.reminder_id) {
      const nextTriggerTime = getNextRecurringReminderTime(reminder.reminder_time, repetitionIntervalHours);
      const rescheduled = await serverScheduleRepository.rescheduleReminder(reminder.reminder_id, nextTriggerTime);

      if (rescheduled) {
        reminder.delivery_retry_count = 0;
        reminder.next_attempt_at = null;
        log.success(`Reminder ${reminder.reminder_id} executed and rescheduled for ${nextTriggerTime.toISOString()}`);
      } else {
        log.error(`Failed to reschedule recurring reminder ${reminder.reminder_id}; deleting to prevent duplicates`);
        await serverScheduleRepository.deleteReminderById(reminder.reminder_id);
      }
    } else if (reminder.reminder_id) {
      await serverScheduleRepository.deleteReminderById(reminder.reminder_id);
      log.success(`Reminder ${reminder.reminder_id} executed and deleted successfully`);
    } else {
      log.error("Cannot delete reminder: reminder_id is undefined");
    }
  }

  private async deferReminderRetry(reminder: ReminderRow, reason: string): Promise<void> {
    if (!reminder.reminder_id) {
      log.error(`Cannot defer reminder retry for missing reminder_id (reason: ${reason})`);
      return;
    }

    const attempts = (reminder.delivery_retry_count ?? 0) + 1;
    if (attempts > REMINDER_DELIVERY_MAX_RETRIES) {
      log.error(
        `Reminder ${reminder.reminder_id} exhausted ${REMINDER_DELIVERY_MAX_RETRIES} delivery retries (last reason: ${reason}); falling back to a plain reminder embed.`,
      );
      await this.handleReminderExecutionFailure(reminder, `retry_limit_exhausted:${reason}`, true);
      return;
    }

    const retryTime = new Date(Date.now() + REMINDER_DELIVERY_RETRY_DELAY_MS);
    const rescheduled = await serverScheduleRepository.scheduleReminderRetry(reminder.reminder_id, retryTime, attempts);
    if (rescheduled) {
      reminder.delivery_retry_count = rescheduled.delivery_retry_count;
      reminder.next_attempt_at = rescheduled.next_attempt_at;
      log.warn(
        `Reminder ${reminder.reminder_id} delivery was not acknowledged (${reason}); retry ${attempts}/${REMINDER_DELIVERY_MAX_RETRIES} at ${retryTime.toISOString()}.`,
      );
    } else {
      log.error(`Failed to defer reminder ${reminder.reminder_id} after unacknowledged delivery (${reason}).`);
    }
  }

  private markReminderDeliveryActive(reminder: ReminderRow): void {
    if (reminder.reminder_id) {
      this.activeReminderIds.add(reminder.reminder_id);
    }
  }

  private releaseReminderDelivery(reminder: ReminderRow): void {
    if (reminder.reminder_id) {
      this.activeReminderIds.delete(reminder.reminder_id);
    }
  }

  private async ensureReminderRecipientMention(
    channel: TextBasedChannel,
    reminder: ReminderRow,
    afterMessageId: string,
    reminderStartTime: number,
  ): Promise<void> {
    if (isBridgeUserId(reminder.user_discord_id)) return;

    await ensureDiscordUserMention({
      client: this.client,
      channel,
      targetUserId: reminder.user_discord_id,
      afterMessageId,
      triggerStartTime: reminderStartTime,
      contextLabel: `reminder ${reminder.reminder_id}`,
      fallbackSender: (content) => this.trySendPersonaFallbackMention(channel, reminder, content),
    });
  }

  private async trySendPersonaFallbackMention(
    channel: TextBasedChannel,
    reminder: ReminderRow,
    content: string,
  ): Promise<boolean> {
    if (!reminder.persona_id) return false;
    if (!("guild" in channel) || !channel.guild) return false;

    const supportsWebhooks =
      channel.type === ChannelType.GuildText ||
      channel.type === ChannelType.PublicThread ||
      channel.type === ChannelType.PrivateThread ||
      channel.type === ChannelType.AnnouncementThread;
    if (!supportsWebhooks) return false;

    try {
      const personas = await getCachedAllPersonas(channel.guild.id);
      const persona = personas.find((p) => p.persona_id === reminder.persona_id);
      if (!persona?.is_alter) return false;

      const isThread = "isThread" in channel && typeof channel.isThread === "function" && channel.isThread();
      if (isThread && !channel.parent) {
        return false;
      }
      const webhookChannel = isThread && channel.parent ? channel.parent : channel;

      const webhookResult = await getOrCreateWebhook(webhookChannel as TextChannel);
      const webhook = webhookResult.webhook;
      if (!webhook) return false;

      const identity = await resolvePersonaWebhookIdentity(persona, channel.guild);
      await sendWebhookMessageWithIdentity(
        webhook,
        {
          content,
          allowedMentions: {
            users: [reminder.user_discord_id],
            roles: [],
            parse: [],
          },
          ...(isThread ? { threadId: channel.id } : {}),
        },
        identity,
      );
      return true;
    } catch (error) {
      log.warn(`Failed to send persona fallback mention for reminder ${reminder.reminder_id}:`, error);
      return false;
    }
  }

  /**
   * Resolves the locale for a reminder's own embeds. The recipient's saved preference wins over the
   * guild default, mirroring the slash-command chain, because a reminder addresses one person rather
   * than the room. Bridge users have no local user row, so they fall through to the guild.
   */
  private async resolveReminderLocale(reminder: ReminderRow, channel: TextBasedChannel): Promise<string> {
    if (!isBridgeUserId(reminder.user_discord_id)) {
      const userRow = await getCachedUserRow(reminder.user_discord_id).catch(() => null);
      if (userRow?.language_pref) {
        return userRow.language_pref;
      }
    }

    return "guild" in channel ? channel.guild.preferredLocale : "en-US";
  }

  private async handleReminderExecutionFailure(
    reminder: ReminderRow,
    errorReason: string,
    preserveRecurringSchedule = false,
  ): Promise<void> {
    try {
      const repetitionIntervalHours =
        typeof reminder.repetition_interval_hours === "number" ? reminder.repetition_interval_hours : null;
      const isRecurring = repetitionIntervalHours !== null && repetitionIntervalHours >= 1;
      let recurringScheduleRetained = false;

      if (reminder.reminder_id) {
        if (preserveRecurringSchedule && isRecurring) {
          const nextTriggerTime = getNextRecurringReminderTime(reminder.reminder_time, repetitionIntervalHours);
          recurringScheduleRetained = Boolean(
            await serverScheduleRepository.rescheduleReminder(reminder.reminder_id, nextTriggerTime),
          );
          if (recurringScheduleRetained) {
            reminder.delivery_retry_count = 0;
            reminder.next_attempt_at = null;
            log.success(
              `Reminder ${reminder.reminder_id} retry budget exhausted and recurring cadence retained at ${nextTriggerTime.toISOString()}`,
            );
          } else {
            log.error(`Failed to retain recurring reminder ${reminder.reminder_id}; deleting to prevent retry loops`);
            await serverScheduleRepository.deleteReminderById(reminder.reminder_id);
          }
        } else {
          await serverScheduleRepository.deleteReminderById(reminder.reminder_id);
        }
      }

      try {
        const channel = await this.client.channels.fetch(reminder.channel_disc_id);
        if (channel?.isTextBased() && "send" in channel) {
          const isSelfReminder = reminder.self_reminder === true;
          const locale = await this.resolveReminderLocale(reminder, channel);
          const footerKey = recurringScheduleRetained
            ? "reminders.triggered_footer_recurring_retained"
            : isRecurring
              ? "reminders.triggered_footer_recurring_removed"
              : "reminders.triggered_footer_one_time";
          const embed = createStandardEmbed(locale, {
            color: ColorCode.WARN,
            titleKey: isSelfReminder ? "reminders.task_triggered_title" : "reminders.reminder_triggered_title",
            description: buildFallbackDescription(locale, reminder),
            footerKey,
          });

          const mentionContent =
            !isSelfReminder && !isBridgeUserId(reminder.user_discord_id) ? `<@${reminder.user_discord_id}>` : undefined;

          await (channel as TextChannel).send({
            ...(mentionContent ? { content: mentionContent } : {}),
            embeds: [embed],
            ...(mentionContent
              ? {
                  allowedMentions: {
                    users: [reminder.user_discord_id],
                    roles: [],
                    parse: [],
                  },
                }
              : {}),
          });
        }
      } catch (fallbackError) {
        log.error(`Failed to send fallback reminder info embed for reminder ${reminder.reminder_id}:`, fallbackError);
      }

      log.warn(
        recurringScheduleRetained
          ? `Reminder ${reminder.reminder_id} occurrence failed but its recurring schedule was retained: ${errorReason}`
          : `Reminder ${reminder.reminder_id} deleted due to execution failure: ${errorReason}`,
      );
    } catch (error) {
      log.error(`Error handling reminder execution failure for reminder ${reminder.reminder_id}:`, error);
    }
  }
}
