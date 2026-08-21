import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { MessageFlags } from "discord.js";
import { localizer } from "@/utils/text/localizer";
import type { UserRow } from "@/types/db/schema";
import { executePersonaImpersonation } from "@/utils/impersonate/impersonateOperations";
import { handlePersonaAutocomplete } from "@/utils/discord/autocomplete/personaAutocomplete";

export const autocomplete = handlePersonaAutocomplete;

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("persona")
    .setDescription(localizer("en-US", "commands.impersonate.persona.description"))
    .addStringOption((option) =>
      option
        .setName("persona")
        .setDescription(localizer("en-US", "commands.impersonate.persona_description"))
        .setAutocomplete(true)
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("message")
        .setDescription(localizer("en-US", "commands.impersonate.message_description"))
        .setMaxLength(2000)
        .setRequired(true),
    );

export async function execute(
  client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  const personaIdStr = interaction.options.getString("persona", true);
  const personaId = parseInt(personaIdStr, 10);
  const message = interaction.options.getString("message", true);

  if (Number.isNaN(personaId)) {
    // Failsafe if user bypasses autocomplete and types junk
    return;
  }

  await executePersonaImpersonation(client, interaction, userData, locale, personaId, message);
}
