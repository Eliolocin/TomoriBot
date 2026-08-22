import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { MessageFlags } from "discord.js";
import { localizer } from "@/utils/text/localizer";
import { ColorCode, log } from "@/utils/misc/logger";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import type { UserRow } from "@/types/db/schema";
import { invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { configRepository, serverRepository } from "@/utils/db/repositories";

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("remove")
    .setDescription(localizer("en-US", "commands.server.config.remove.description"))
    .addStringOption((option) =>
      option
        .setName("confirmation")
        .setDescription(localizer("en-US", "commands.server.config.remove.confirmation_description"))
        .setRequired(true)
        .addChoices(
          { name: localizer("en-US", "commands.server.config.remove.confirmation_choice_yes"), value: "yes" },
          { name: localizer("en-US", "commands.server.config.remove.confirmation_choice_no"), value: "no" },
        ),
    );

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  _userData: UserRow,
  locale: string,
): Promise<void> {
  try {
    if (interaction.guild) {
      const hasPermission = interaction.memberPermissions?.has("ManageGuild") ?? false;
      if (!hasPermission) {
        await replyInfoEmbed(interaction, locale, {
          titleKey: "commands.data.delete.no_permission_title",
          descriptionKey: "commands.data.delete.no_permission_description",
          color: ColorCode.ERROR,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

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

    const serverDiscId = interaction.guild?.id ?? interaction.user.id;
    const serverId = await serverRepository.loadServerIdByDiscId(serverDiscId);
    if (!serverId) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.data.delete.no_server_data_title",
        descriptionKey: "commands.data.delete.no_server_data_description",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Reset defaults across all split config tables in parallel via typed repository methods.
    //    Each method returns a boolean indicating whether any row was updated.
    const results = await Promise.all([
      configRepository.updateModelConfig(serverId, {
        llm_temperature: 1.2,
        thinking_level: "auto",
        llm_disabled_params: [],
      }),
      configRepository.updateChatConfig(serverId, {
        llm_top_p: 0.95,
        llm_min_p: 0.05,
        llm_stop_strings: [],
        llm_stop_speaker_pattern_enabled: false,
        humanizer_degree: 1,
        timezone_offset: 0,
        message_fetch_limit: 80,
        self_debug_enabled: false,
        model_randomizer_enabled: false,
      }),
      configRepository.updateMemberPermissionsConfig(serverId, {
        server_memteaching_enabled: false,
        attribute_memteaching_enabled: false,
        sampledialogue_memteaching_enabled: false,
        self_teaching_enabled: true,
        personal_memories_enabled: true,
      }),
      configRepository.updateCapabilitiesConfig(serverId, {
        emoji_usage_enabled: true,
        sticker_usage_enabled: true,
        web_search_enabled: true,
        imagegen_enabled: true,
      }),
      configRepository.updateNoticeEmbedsConfig(serverId, {
        tool_notice_hidden_keys: [],
      }),
    ]);

    const anyUpdated = results.some(Boolean);

    if (!anyUpdated) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.data.delete.no_server_data_title",
        descriptionKey: "commands.data.delete.no_server_data_description",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    invalidateTomoriStateCache(serverDiscId);

    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.data.delete.success_server_config_title",
      descriptionKey: "commands.data.delete.success_server_config_description",
      color: ColorCode.SUCCESS,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    log.error("Error executing /server config remove:", error, {
      errorType: "CommandExecutionError",
      metadata: { commandName: "server config remove" },
    });

    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
  }
}
