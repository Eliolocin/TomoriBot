import { MessageFlags, type ChatInputCommandInteraction, type Client, type SlashCommandBuilder } from "discord.js";
import type { UserRow } from "@/types/db/schema";
import { buildInitialStPresetsPanel } from "@/utils/discord/interactions/stPresetsRoutes";
import { localizer } from "@/utils/text/localizer";

export const managerOnly = true;

export const configureCommand = (command: SlashCommandBuilder) =>
  command.setName("st-presets").setDescription(localizer("en-US", "commands.st-presets.description"));

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  _userData: UserRow,
  locale: string,
): Promise<void> {
  await executeStPresetsCommand(interaction, locale);
}

export async function executeStPresetsCommand(
  interaction: ChatInputCommandInteraction,
  locale: string,
  buildPanel: typeof buildInitialStPresetsPanel = buildInitialStPresetsPanel,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply(await buildPanel(interaction, locale));
}
