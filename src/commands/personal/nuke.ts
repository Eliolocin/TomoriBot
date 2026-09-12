import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import type { ErrorContext, UserRow } from "@/types/db/schema";
import { invalidatePersonalSpotlightCache } from "@/utils/cache/personalSpotlightCache";
import { invalidateUserCache } from "@/utils/cache/userCache";
import { userRepository } from "@/utils/db/repositories";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { ColorCode, log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";

/**
 * Configures `/personal nuke`, the erasure route the Privacy Policy points users at.
 *
 * Deliberately not `guildOnly`: erasure is account-wide, so a user who no longer shares a server
 * with TomoriBot must still be able to run it from a DM.
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("nuke")
    .setDescription(localizer("en-US", "commands.personal.nuke.description"))
    .addStringOption((option) =>
      option
        .setName("confirmation")
        .setDescription(localizer("en-US", "commands.personal.nuke.confirmation_description"))
        .setRequired(true)
        .addChoices(
          { name: localizer("en-US", "commands.personal.nuke.confirmation_choice_yes"), value: "yes" },
          { name: localizer("en-US", "commands.personal.nuke.confirmation_choice_no"), value: "no" },
        ),
    );

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  try {
    if (interaction.options.getString("confirmation", true) !== "yes") {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.personal.nuke.cancelled_title",
        descriptionKey: "commands.personal.nuke.cancelled_description",
        color: ColorCode.INFO,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // userSchema leaves user_id optional for pre-insert shapes; a registered caller always has one.
    const erased = userData.user_id ? await userRepository.nukeUser(userData.user_id) : null;
    if (!erased) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.personal.nuke.no_data_title",
        descriptionKey: "commands.personal.nuke.no_data_description",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    invalidateUserCache(erased.userDiscId);
    for (const serverId of erased.affectedServerIds) {
      invalidatePersonalSpotlightCache(serverId, userData.user_id);
    }

    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.personal.nuke.success_title",
      descriptionKey: "commands.personal.nuke.success_description",
      descriptionVars: { reminders_deleted: erased.remindersDeleted },
      color: ColorCode.SUCCESS,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      errorType: "CommandExecutionError",
      metadata: { command: "personal nuke" },
    };
    await log.error("Failed to erase personal data", error as Error, context);
  }
}
