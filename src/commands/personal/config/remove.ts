import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { MessageFlags } from "discord.js";
import { localizer } from "@/utils/text/localizer";
import { ColorCode, log } from "@/utils/misc/logger";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import type { UserRow } from "@/types/db/schema";
import { userRepository } from "@/utils/db/repositories";

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("remove")
    .setDescription(localizer("en-US", "commands.personal.config.remove.description"))
    .addStringOption((option) =>
      option
        .setName("confirmation")
        .setDescription(localizer("en-US", "commands.personal.config.remove.confirmation_description"))
        .setRequired(true)
        .addChoices(
          { name: localizer("en-US", "commands.personal.config.remove.confirmation_choice_yes"), value: "yes" },
          { name: localizer("en-US", "commands.personal.config.remove.confirmation_choice_no"), value: "no" },
        ),
    );

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  try {
    const confirmation = interaction.options.getString("confirmation", true);
    if (confirmation !== "yes") {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.data.delete.confirmation_required_title",
        descriptionKey: "commands.data.delete.confirmation_required_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const userId = userData.user_id;
    const updatedUser = userId === undefined ? false : await userRepository.clearPortablePersonalSettings(userId);

    if (!updatedUser) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.data.delete.no_data_title",
        descriptionKey: "commands.data.delete.no_data_description",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.data.delete.success_personal_settings_title",
      descriptionKey: "commands.data.delete.success_personal_settings_description",
      color: ColorCode.SUCCESS,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    log.error("Error executing /personal config remove:", error, {
      errorType: "CommandExecutionError",
      metadata: { commandName: "personal config remove" },
    });

    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
  }
}
