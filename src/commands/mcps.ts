import { MessageFlags, type ChatInputCommandInteraction, type Client, type SlashCommandBuilder } from "discord.js";
import type { UserRow } from "@/types/db/schema";
import { buildInitialMcpsPanel } from "@/utils/discord/interactions/mcpsRoutes";
import { localizer } from "@/utils/text/localizer";

export const managerOnly = true;

export const configureCommand = (command: SlashCommandBuilder) =>
  command.setName("mcps").setDescription(localizer("en-US", "commands.mcps.description"));

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  _userData: UserRow,
  locale: string,
): Promise<void> {
  await executeMcpsCommand(interaction, locale);
}

export async function executeMcpsCommand(
  interaction: ChatInputCommandInteraction,
  locale: string,
  buildPanel: typeof buildInitialMcpsPanel = buildInitialMcpsPanel,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply(await buildPanel(interaction, locale));
}
