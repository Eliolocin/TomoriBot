import type { ChatInputCommandInteraction, Client, SlashCommandBuilder } from "discord.js";
import type { UserRow } from "@/types/db/schema";
import { executeModerationCommand } from "@/utils/discord/interactions/moderationRoutes";
import { localizer } from "@/utils/text/localizer";

export const guildOnly = true;
export const managerOnly = true;

export const configureCommand = (command: SlashCommandBuilder) =>
  command.setName("moderation").setDescription(localizer("en-US", "commands.moderation.description"));

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  _userData: UserRow,
  locale: string,
): Promise<void> {
  await executeModerationCommand(interaction, locale);
}
