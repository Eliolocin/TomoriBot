import { MessageFlags, type ChatInputCommandInteraction, type Client, type SlashCommandBuilder } from "discord.js";
import type { UserRow } from "@/types/db/schema";
import { buildInitialMemoriesPanel } from "@/utils/discord/interactions/memoriesRoutes";
import { deliverGuardedPanel } from "@/utils/discord/interactions/panelController";
import { localizer } from "@/utils/text/localizer";

export const configureCommand = (command: SlashCommandBuilder) =>
  command.setName("memories").setDescription(localizer("en-US", "commands.memories.description"));

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  _userData: UserRow,
  locale: string,
): Promise<void> {
  await executeMemoriesCommand(interaction, locale);
}

export async function executeMemoriesCommand(
  interaction: ChatInputCommandInteraction,
  locale: string,
  buildPanel: typeof buildInitialMemoriesPanel = buildInitialMemoriesPanel,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await deliverGuardedPanel(interaction, await buildPanel(interaction, locale), {
    method: "editReply",
    locale,
  });
}
