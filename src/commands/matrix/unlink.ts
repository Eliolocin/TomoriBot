/**
 * /matrix unlink
 * Removes the Matrix bridge link from a Discord channel.
 *
 * Interaction pattern: Pattern 2 (defer before async work)
 * Permission required: ManageGuild
 */

import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Client,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import { serverRepository } from "@/utils/db/repositories";
import { getCachedTomoriState } from "@/utils/cache/tomoriStateCache";
import { invalidateMatrixLinkCache } from "@/utils/bridges/matrix";
import { localizer } from "@/utils/text/localizer";
import { log, ColorCode } from "@/utils/misc/logger";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import type { UserRow, ErrorContext } from "@/types/db/schema";

/**
 * Configure the /matrix unlink subcommand builder.
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("unlink")
    .setDescription(localizer("en-US", "commands.matrix.unlink.description"))
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription(localizer("en-US", "commands.matrix.unlink.channel_description"))
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    );

/**
 * Execute the /matrix unlink command.
 * Removes the Matrix bridge link for the given channel.
 *
 */
export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  user: UserRow,
  locale: string,
): Promise<void> {
  const errorContext: ErrorContext = {
    userId: user.user_id,
    serverId: null,
    personaId: null,
  };

  try {
    if (!interaction.guild || !interaction.guildId) {
      await replyInfoEmbed(interaction, locale, {
        color: ColorCode.ERROR,
        titleKey: "general.errors.guild_only_title",
        descriptionKey: "general.errors.guild_only_description",
      });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await replyInfoEmbed(interaction, locale, {
        color: ColorCode.ERROR,
        titleKey: "general.errors.permission_denied_title",
        descriptionKey: "general.errors.permission_denied_description",
      });
      return;
    }

    // Defer before async work (Pattern 2)
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const tomoriState = await getCachedTomoriState(interaction.guildId);
    if (!tomoriState) {
      await replyInfoEmbed(interaction, locale, {
        color: ColorCode.ERROR,
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
      });
      return;
    }

    errorContext.serverId = tomoriState.server_id;
    errorContext.personaId = tomoriState.persona_id;

    const channel = interaction.options.getChannel("channel", true);

    // Query existing link so we can invalidate the room-side cache too
    const existingRoomId = await serverRepository.getExistingMatrixLink(channel.id);

    if (!existingRoomId) {
      await replyInfoEmbed(interaction, locale, {
        color: ColorCode.WARN,
        titleKey: "commands.matrix.unlink.not_linked_title",
        descriptionKey: "commands.matrix.unlink.not_linked_description",
        descriptionVars: { channel_id: channel.id },
      });
      return;
    }

    const roomId = existingRoomId;

    await serverRepository.unlinkMatrix(channel.id);

    // Invalidate both cache directions
    invalidateMatrixLinkCache(channel.id, roomId);

    await replyInfoEmbed(interaction, locale, {
      color: ColorCode.SUCCESS,
      titleKey: "commands.matrix.unlink.success_title",
      descriptionKey: "commands.matrix.unlink.success_description",
      descriptionVars: { channel_id: channel.id },
    });

    log.info(
      `Matrix bridge: unlinked channel ${channel.id} (${channel.name}) from room ${roomId} in guild ${interaction.guildId}`,
    );
  } catch (error) {
    log.error("Error executing /matrix unlink", error, errorContext);
    await replyInfoEmbed(interaction, locale, {
      color: ColorCode.ERROR,
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
    });
  }
}
