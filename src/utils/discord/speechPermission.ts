import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { ColorCode } from "@/utils/misc/logger";

/**
 * Enforces authorization for `/speech` command leaves.
 * DM interactions are owned by the invoker; guild interactions require ManageGuild.
 */
export async function ensureSpeechCommandAccess(
  interaction: ChatInputCommandInteraction,
  locale: string,
): Promise<boolean> {
  if (!interaction.guildId || (interaction.memberPermissions?.has("ManageGuild") ?? false)) {
    return true;
  }

  await replyInfoEmbed(interaction, locale, {
    titleKey: "general.errors.permission_denied_title",
    descriptionKey: "general.errors.permission_denied_description",
    color: ColorCode.ERROR,
    flags: MessageFlags.Ephemeral,
  });
  return false;
}
