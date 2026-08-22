import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { MessageFlags } from "discord.js";
import { serverRepository } from "@/utils/db/repositories/ServerRepository";
import { quotaResetOperations, type CanonicalQuotaType } from "@/utils/quota/quotaResetOperations";
import type { UserRow } from "@/types/db/schema";
import { localizer } from "@/utils/text/localizer";
import { log, ColorCode } from "@/utils/misc/logger";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";

/**
 * Configure /quota reset global subcommand.
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("global")
    .setDescription(localizer("en-US", "commands.quota.reset.global.description"))
    .addStringOption((option) =>
      option
        .setName("quota_type")
        .setDescription(localizer("en-US", "commands.quota.reset.global.quota_type_description"))
        .setRequired(true)
        .addChoices(
          {
            name: localizer("en-US", "commands.quota.reset.global.image_option"),
            value: "image",
          },
          {
            name: localizer("en-US", "commands.quota.reset.global.text_option"),
            value: "text",
          },
          {
            name: localizer("en-US", "commands.quota.reset.global.video_option"),
            value: "video",
          },
        ),
    );

/**
 * Execute /quota reset global.
 */
export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  _locale: string,
): Promise<void> {
  if (!interaction.guild || !interaction.channel) {
    await replyInfoEmbed(interaction, userData.language_pref, {
      titleKey: "general.errors.guild_only_title",
      descriptionKey: "general.errors.guild_only_description",
      color: ColorCode.ERROR,
    });
    return;
  }

  if (!interaction.memberPermissions?.has("ManageGuild")) {
    await replyInfoEmbed(interaction, userData.language_pref, {
      titleKey: "general.errors.permission_denied_title",
      descriptionKey: "general.errors.permission_denied_description",
      color: ColorCode.ERROR,
    });
    return;
  }

  const rawQuotaType = interaction.options.getString("quota_type", true);

  if (rawQuotaType !== "image" && rawQuotaType !== "text" && rawQuotaType !== "video") {
    await replyInfoEmbed(interaction, userData.language_pref, {
      titleKey: "general.errors.generic_error_title",
      descriptionKey: "general.errors.generic_error_description",
      color: ColorCode.ERROR,
    });
    return;
  }

  const quotaType = rawQuotaType as CanonicalQuotaType;

  const serverId = await serverRepository.loadServerIdByDiscId(interaction.guild.id);

  if (!serverId) {
    await replyInfoEmbed(interaction, userData.language_pref, {
      titleKey: "general.errors.server_not_found_title",
      descriptionKey: "general.errors.server_not_found_description",
      color: ColorCode.ERROR,
    });
    return;
  }

  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    await quotaResetOperations.resetGlobalQuota({
      serverId,
      quotaType,
    });

    await replyInfoEmbed(interaction, userData.language_pref, {
      titleKey: "commands.quota.reset.global.success_title",
      descriptionKey:
        quotaType === "image"
          ? "commands.quota.reset.global.success_image_description"
          : quotaType === "text"
            ? "commands.quota.reset.global.success_text_description"
            : "commands.quota.reset.global.success_video_description",
      color: ColorCode.SUCCESS,
    });

    log.info(
      `Reset serverwide quota (serverId=${serverId}, scope=global, quotaType=${quotaType}, resetBy=${interaction.user.id})`,
    );
  } catch (error) {
    log.error("Error executing /quota reset global", error);
    await replyInfoEmbed(interaction, userData.language_pref, {
      titleKey: "general.errors.generic_error_title",
      descriptionKey: "general.errors.generic_error_description",
      color: ColorCode.ERROR,
    });
  }
}
