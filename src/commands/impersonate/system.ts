import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { MessageFlags } from "discord.js";
import { localizer } from "@/utils/text/localizer";
import type { UserRow } from "@/types/db/schema";
import { executeSystemImpersonation } from "@/utils/impersonate/impersonateOperations";

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("system")
    .setDescription(localizer("en-US", "commands.impersonate.system.description"))
    .addStringOption((option) =>
      option
        .setName("prompt")
        .setDescription(localizer("en-US", "commands.impersonate.prompt_description"))
        .setMaxLength(2000)
        .setRequired(true),
    );

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  _userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  const prompt = interaction.options.getString("prompt", true);

  await executeSystemImpersonation(interaction, locale, prompt);
}
