import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import type { UserRow } from "@/types/db/schema";
import { buildInitialPersonalProvidersPanel } from "@/utils/discord/interactions/providersRoutes";
import { localizer } from "@/utils/text/localizer";

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("providers").setDescription(localizer("en-US", "commands.personal.providers.description"));

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  _userData: UserRow,
  locale: string,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply(await buildInitialPersonalProvidersPanel(interaction, locale));
}
