import { MessageFlags, type ChatInputCommandInteraction, type Client, type SlashCommandBuilder } from "discord.js";
import type { UserRow } from "@/types/db/schema";
import { deliverGuardedPanel } from "@/utils/discord/interactions/panelController";
import { buildHelpDashboardPayload } from "@/utils/discord/ui/helpDashboard";
import { localizer } from "@/utils/text/localizer";

export const configureCommand = (command: SlashCommandBuilder) =>
  command.setName("help").setDescription(localizer("en-US", "commands.help.description"));

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  _userData: UserRow,
  locale: string,
): Promise<void> {
  const payload = buildHelpDashboardPayload(locale);
  await deliverGuardedPanel(interaction, payload, {
    method: "reply",
    locale,
    flags: payload.flags | MessageFlags.Ephemeral,
  });
}
