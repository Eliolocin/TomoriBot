import { MessageFlags, type ChatInputCommandInteraction, type Client, type SlashCommandBuilder } from "discord.js";
import type { UserRow } from "@/types/db/schema";
import { buildInitialProvidersPanel } from "@/utils/discord/interactions/providersRoutes";
import { deliverGuardedPanel } from "@/utils/discord/interactions/panelController";
import { localizer } from "@/utils/text/localizer";

export const managerOnly = true;

export const configureCommand = (command: SlashCommandBuilder) =>
  command.setName("providers").setDescription(localizer("en-US", "commands.providers.description"));

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  _userData: UserRow,
  locale: string,
): Promise<void> {
  await executeProvidersCommand(interaction, locale);
}

export async function executeProvidersCommand(
  interaction: ChatInputCommandInteraction,
  locale: string,
  buildPanel: typeof buildInitialProvidersPanel = buildInitialProvidersPanel,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await deliverGuardedPanel(interaction, await buildPanel(interaction, locale), {
    method: "editReply",
    locale,
  });
}
