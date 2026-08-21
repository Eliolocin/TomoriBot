import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { MessageFlags } from "discord.js";
import { localizer } from "@/utils/text/localizer";
import type { UserRow } from "@/types/db/schema";
import { executeUserImpersonation } from "@/utils/impersonate/impersonateOperations";

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("user")
    .setDescription(localizer("en-US", "commands.impersonate.user.description"))
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription(localizer("en-US", "commands.impersonate.user_description"))
        .setRequired(true),
    );

export async function execute(
  client: Client,
  interaction: ChatInputCommandInteraction,
  _userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  const user = interaction.options.getUser("user", true);
  const member = interaction.options.getMember("user");
  const displayName = member && "displayName" in member ? member.displayName : user.username;

  await executeUserImpersonation(client, interaction, locale, user.id, displayName);
}
