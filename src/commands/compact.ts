import type { ChatInputCommandInteraction, Client, SlashCommandBuilder } from "discord.js";
import { ChannelType } from "discord.js";
import type { UserRow } from "@/types/db/schema";
import { executeCompactCommand } from "@/utils/compaction/compactOrchestrator";
import { localizer } from "@/utils/text/localizer";

export const configureCommand = (command: SlashCommandBuilder) =>
  command
    .setName("compact")
    .setDescription(localizer("en-US", "commands.compact.description"))
    .addStringOption((option) =>
      option
        .setName("type")
        .setDescription(localizer("en-US", "commands.compact.type_description"))
        .addChoices(
          { name: localizer("en-US", "commands.compact.modal.type_choice_conversation"), value: "conversation" },
          { name: localizer("en-US", "commands.compact.modal.type_choice_roleplay"), value: "roleplay" },
          { name: localizer("en-US", "commands.compact.modal.type_choice_manual"), value: "manual" },
        )
        .setRequired(true),
    )
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription(localizer("en-US", "commands.compact.channel_description"))
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName("thread")
        .setDescription(localizer("en-US", "commands.compact.thread_description"))
        .setRequired(false),
    );

export async function execute(
  client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  await executeCompactCommand(client, interaction, userData, locale);
}
