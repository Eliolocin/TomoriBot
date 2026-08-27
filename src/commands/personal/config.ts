import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import type { UserRow } from "@/types/db/schema";
import { buildInitialPersonalConfigPanel } from "@/utils/discord/interactions/personalConfigRoutes";
import { localizer } from "@/utils/text/localizer";

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("config").setDescription(localizer("en-US", "commands.personal.config.description"));

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  _userData: UserRow,
  locale: string,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply(await buildInitialPersonalConfigPanel(interaction, locale));
}
