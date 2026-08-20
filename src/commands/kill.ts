import { MessageFlags, type SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction, Client } from "discord.js";
import {
  clearChannelProcessingQueue,
  forceKillChannelStream,
  isChannelProcessingLocked,
} from "@/utils/chat/channelQueue";
import type { UserRow } from "@/types/db/schema";
import { replyInfoEmbed } from "@/utils/discord/interactionHelper";
import { StreamOrchestrator } from "@/utils/discord/streamOrchestrator";
import { ColorCode, log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";

/**
 * Configure the /kill command
 */
export const configureCommand = (command: SlashCommandBuilder) =>
  command.setName("kill").setDescription(localizer("en-US", "commands.kill.description"));

/**
 * Execute the kill command for this channel.
 * Stops the active stream if one exists and clears any queued responses.
 */
export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  _userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.channel) {
    await replyInfoEmbed(
      interaction,
      locale,
      {
        titleKey: "general.errors.channel_only_title",
        descriptionKey: "general.errors.channel_only_description",
        color: ColorCode.ERROR,
      },
      MessageFlags.Ephemeral,
    );
    return;
  }

  const channelId = interaction.channel.id;
  const hasActiveStream = isChannelProcessingLocked(channelId);
  const clearedQueueCount = clearChannelProcessingQueue(channelId);

  if (!hasActiveStream && clearedQueueCount === 0) {
    await replyInfoEmbed(
      interaction,
      locale,
      {
        titleKey: "commands.kill.nothing_to_stop_title",
        descriptionKey: "commands.kill.nothing_to_stop_description",
        color: ColorCode.WARN,
      },
      MessageFlags.SuppressNotifications,
    );
    return;
  }

  if (hasActiveStream) {
    StreamOrchestrator.requestStop(channelId, interaction.user.id);
    // Abort the underlying HTTP request and unblock Promise.race so the lock releases immediately.
    forceKillChannelStream(channelId);
  }

  log.info(
    `Stop/clear requested via /kill by user ${interaction.user.id} in channel ${channelId}. Active stream: ${hasActiveStream}. Cleared ${clearedQueueCount} queued message(s).`,
  );

  await replyInfoEmbed(
    interaction,
    locale,
    {
      titleKey: "commands.kill.success_title",
      descriptionKey: "commands.kill.success_description",
      color: ColorCode.SUCCESS,
    },
    MessageFlags.SuppressNotifications,
  );
}
