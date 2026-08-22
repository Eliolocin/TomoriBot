import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { MessageFlags } from "discord.js";
import { serverRepository } from "@/utils/db/repositories/ServerRepository";
import { quotaResetOperations, type CanonicalQuotaType } from "@/utils/quota/quotaResetOperations";
import type { UserRow } from "@/types/db/schema";
import { localizer } from "@/utils/text/localizer";
import { log, ColorCode } from "@/utils/misc/logger";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";

/**
 * Configure /quota reset user subcommand.
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("user")
    .setDescription(localizer("en-US", "commands.quota.reset.user.description"))
    .addUserOption((option) =>
      option
        .setName("member")
        .setDescription(localizer("en-US", "commands.quota.reset.user.member_description"))
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("quota_type")
        .setDescription(localizer("en-US", "commands.quota.reset.user.quota_type_description"))
        .setRequired(true)
        .addChoices(
          {
            name: localizer("en-US", "commands.quota.reset.user.image_option"),
            value: "image",
          },
          {
            name: localizer("en-US", "commands.quota.reset.user.text_option"),
            value: "text",
          },
          {
            name: localizer("en-US", "commands.quota.reset.user.video_option"),
            value: "video",
          },
        ),
    );

/**
 * Execute /quota reset user.
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

  const targetUser = interaction.options.getUser("member", true);
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

    await quotaResetOperations.resetUserQuota({
      serverId,
      targetUserId: targetUser.id,
      quotaType,
    });

    await replyInfoEmbed(interaction, userData.language_pref, {
      titleKey: "commands.quota.reset.user.success_title",
      descriptionKey:
        quotaType === "image"
          ? "commands.quota.reset.user.success_image_description"
          : quotaType === "text"
            ? "commands.quota.reset.user.success_text_description"
            : "commands.quota.reset.user.success_video_description",
      descriptionVars: {
        user: `<@${targetUser.id}>`,
      },
      color: ColorCode.SUCCESS,
    });

    log.info(
      `Reset user daily quota (serverId=${serverId}, scope=user, quotaType=${quotaType}, targetUserId=${targetUser.id}, resetBy=${interaction.user.id})`,
    );
  } catch (error) {
    log.error("Error executing /quota reset user", error);
    await replyInfoEmbed(interaction, userData.language_pref, {
      titleKey: "general.errors.generic_error_title",
      descriptionKey: "general.errors.generic_error_description",
      color: ColorCode.ERROR,
    });
  }
}
