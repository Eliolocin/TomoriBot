import { MessageFlags } from "discord.js";
import type { ChatInputCommandInteraction, Client, SlashCommandBuilder } from "discord.js";
import type { UserRow } from "@/types/db/schema";
import { localizer } from "@/utils/text/localizer";
import { log } from "@/utils/misc/logger";
import { startSetupWizard } from "@/utils/discord/interactions/setupRoutes";

export const managerOnly = true;

export const configureCommand = (command: SlashCommandBuilder) =>
  command.setName("setup").setDescription(localizer("en-US", "commands.setup.description"));

/**
 * Starts the guided setup wizard.
 *
 * The command is only the entry point. Authorization, the workspace-health guard, the draft, and the
 * commit all live behind {@link startSetupWizard} and the routed setup namespace, because the same
 * guards have to run again on every button, select, and modal submission the wizard produces.
 */
export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  try {
    const isDMChannel = interaction.channel?.isDMBased() ?? false;
    const serverId = isDMChannel ? interaction.user.id : interaction.guild?.id;

    if (!serverId) {
      await interaction.reply({
        content: localizer(userData.language_pref, "general.errors.critical_error_description"),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Guild locale wins where it exists, so the wizard's copy, the stored analytics locale, and the
    // preset catalog all resolve against the language the guild actually reads.
    const serverLocale = interaction.guildLocale ?? locale;
    await startSetupWizard(interaction, { locale: serverLocale });
  } catch (error) {
    log.error("Error during setup process:", error);
    if (!interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({
          content: localizer(userData.language_pref, "general.errors.unknown_error_description"),
          flags: MessageFlags.Ephemeral,
        });
      } catch (replyError) {
        log.error("Failed to send setup error reply:", replyError);
      }
    }
  }
}
