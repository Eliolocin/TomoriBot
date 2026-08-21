import type { ChatInputCommandInteraction, Client, Message, SlashCommandSubcommandBuilder } from "discord.js";
import { EmbedBuilder, MessageFlags, PermissionFlagsBits } from "discord.js";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { ColorCode, log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";
import type { ConditioningType, TomoriState, UserRow } from "@/types/db/schema";
import { personaRepository } from "@/utils/db/repositories";
import { getCachedWhitelistStatus } from "@/utils/cache/channelWhitelistCache";
import { getCachedPersonalSpotlightStatus } from "@/utils/cache/personalSpotlightCache";
import { tomoriChat } from "@/events/messageCreate/tomoriChat";
import {
  CONDITIONING_REASON_MAX_LENGTH,
  normalizeConditioningReason,
  type ConditioningActionKey,
} from "@/utils/conditioning/conditioning";
import { conditioningMemoryRepository } from "@/utils/db/repositories/ConditioningMemoryRepository";
import { filterPersonasForTrigger, isPersonaAllowedForTrigger } from "@/utils/persona/personaAccess";
import { handlePersonaAutocomplete } from "@/utils/discord/autocomplete/personaAutocomplete";
import { resolveFallbackPersona } from "@/utils/discord/personaTurnDetectionResolver";
import { normalizeMessageFetchLimit } from "@/utils/discord/messageFetchLimit";

const EMBED_COLOR_BY_TYPE: Record<ConditioningType, ColorCode> = {
  reward: ColorCode.AFFECTION,
  punish: ColorCode.ERROR,
};

interface ConditioningCommandOptions {
  /** Returns extra interpolation context for the embed description localizer. */
  getExtraContext?: (interaction: ChatInputCommandInteraction) => Record<string, string>;
}

export function createConditioningInteractionCommand(
  type: ConditioningType,
  actionKey: ConditioningActionKey,
  cmdOptions?: ConditioningCommandOptions,
) {
  const commandKey = `commands.${type}.${actionKey}`;

  const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
    subcommand
      .setName(actionKey)
      .setDescription(localizer("en-US", `${commandKey}.description`))
      .addStringOption((option) =>
        option
          .setName("persona")
          .setDescription(localizer("en-US", `${commandKey}.persona_description`))
          .setAutocomplete(true)
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName("reason")
          .setDescription(localizer("en-US", `${commandKey}.reason_description`))
          .setMaxLength(CONDITIONING_REASON_MAX_LENGTH)
          .setRequired(false),
      );

  async function execute(
    client: Client,
    interaction: ChatInputCommandInteraction,
    userData: UserRow,
    locale: string,
  ): Promise<void> {
    if (!interaction.channel || !("messages" in interaction.channel) || !interaction.guild) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.guild_only_title",
        descriptionKey: "general.errors.guild_only_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const botMember = interaction.guild.members.me;
    if (!botMember) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.unknown_error_title",
        descriptionKey: "general.errors.unknown_error_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const commandChannel = interaction.channel;
    const guildChannel = interaction.guild.channels.cache.get(interaction.channel.id) ?? interaction.channel;
    if (!("permissionsFor" in guildChannel)) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.unknown_error_title",
        descriptionKey: "general.errors.unknown_error_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const permissions = guildChannel.permissionsFor(botMember);
    if (
      !permissions?.has(PermissionFlagsBits.ViewChannel) ||
      !permissions?.has(PermissionFlagsBits.ReadMessageHistory)
    ) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.channel_missing_permissions_title",
        descriptionKey: "general.errors.channel_missing_permissions_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const tomoriState = await personaRepository.loadState(interaction.guild.id);
    if (!tomoriState) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.unknown_error_title",
        descriptionKey: "general.errors.unknown_error_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const allPersonas = await personaRepository.loadAllForServer(interaction.guild.id);
    if (allPersonas.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const invokingMember = interaction.guild.members.cache.get(interaction.user.id);
    const memberRoleDiscIds = invokingMember?.roles.cache.map((role) => role.id);
    const isThread =
      "isThread" in guildChannel && typeof guildChannel.isThread === "function" && guildChannel.isThread();
    const parentChannelId = isThread && "parent" in guildChannel ? guildChannel.parent?.id : undefined;
    const whitelistStatus = await getCachedWhitelistStatus(
      interaction.guild.id,
      interaction.channel.id,
      memberRoleDiscIds,
      parentChannelId,
    );
    const personalSpotlightStatus = userData.user_id
      ? await getCachedPersonalSpotlightStatus(
          tomoriState.server_id,
          userData.user_id,
          parentChannelId ?? interaction.channel.id,
        )
      : null;
    const availablePersonas = filterPersonasForTrigger(allPersonas, whitelistStatus, personalSpotlightStatus);

    if (availablePersonas.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.conditioning.shared.persona_access_blocked_title",
        descriptionKey: "commands.conditioning.shared.persona_access_blocked_description",
        color: ColorCode.WARN,
      });
      return;
    }

    let selectedPersona: TomoriState;

    const personaOptionValue = interaction.options.getString("persona");
    if (personaOptionValue !== null) {
      const personaId = Number.parseInt(personaOptionValue, 10);
      if (Number.isNaN(personaId)) {
        await replyInfoEmbed(interaction, locale, {
          titleKey: "general.errors.invalid_option_title",
          descriptionKey: "general.errors.invalid_option_description",
          color: ColorCode.ERROR,
        });
        return;
      }

      const foundPersona = availablePersonas.find((p) => p.persona_id === personaId);
      if (!foundPersona) {
        await replyInfoEmbed(interaction, locale, {
          titleKey: "general.errors.invalid_option_title",
          descriptionKey: "general.errors.invalid_option_description",
          color: ColorCode.ERROR,
        });
        return;
      }
      selectedPersona = foundPersona;
    } else {
      const fallbackPersona = await resolveFallbackPersona({
        availablePersonas,
        allPersonas,
        tomoriState,
        effectiveChannelId: parentChannelId ?? interaction.channel.id,
        personalAutoTriggerPersonaId: personalSpotlightStatus?.autoTriggerPersonaId ?? null,
        clientUserId: client.user?.id,
        fetchRecentMessages: async () => {
          const fetched = await commandChannel.messages.fetch({
            limit: normalizeMessageFetchLimit(tomoriState.config.message_fetch_limit),
          });
          return [...fetched.values()].reverse();
        },
      });

      if (!fallbackPersona) {
        await replyInfoEmbed(interaction, locale, {
          titleKey: "commands.conditioning.shared.persona_access_blocked_title",
          descriptionKey: "commands.conditioning.shared.persona_access_blocked_description",
          color: ColorCode.WARN,
        });
        return;
      }
      selectedPersona = fallbackPersona;
    }

    if (!userData.user_id) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.operation_failed_title",
        descriptionKey: "general.errors.operation_failed_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    try {
      const botName =
        selectedPersona.persona_nickname ?? tomoriState.persona_nickname ?? process.env.DEFAULT_BOTNAME ?? "Tomori";
      const reasonText = normalizeConditioningReason(interaction.options.getString("reason"));
      const extraContext = cmdOptions?.getExtraContext?.(interaction) ?? {};
      const actionTextValue = extraContext.action_text?.trim() ?? null;
      const conditioningEvent = await conditioningMemoryRepository.recordEvent({
        serverId: tomoriState.server_id,
        personaLineageId: selectedPersona.persona_lineage_id ?? 0,
        conditioningType: type,
        actionKey,
        userId: userData.user_id,
        reason: reasonText,
        actionText: actionTextValue,
      });

      let embedDescription = localizer(locale, `${commandKey}.embed_description`, {
        user: `<@${interaction.user.id}>`,
        bot: botName,
        ...extraContext,
      });

      const interactionEmbed = new EmbedBuilder()
        .setTitle(localizer(locale, `${commandKey}.embed_title`))
        .setColor(EMBED_COLOR_BY_TYPE[type]);

      if (reasonText.length > 0) {
        embedDescription = `${embedDescription}\n${localizer(locale, "commands.conditioning.shared.reason_line", {
          reason: reasonText,
        })}`;
        if (conditioningEvent) {
          interactionEmbed.setFooter({
            text: localizer(locale, `commands.conditioning.shared.${type}_footer`, {
              bot: botName,
            }),
          });
        }
      }

      interactionEmbed.setDescription(embedDescription);

      await interaction.reply({
        embeds: [interactionEmbed],
        flags: MessageFlags.SuppressNotifications,
      });

      if (!whitelistStatus.isTriggerAllowed) {
        log.info(
          `${type} ${actionKey} interaction completed without chat response because channel ${interaction.channel.id} is blocked by whitelist policy (${whitelistStatus.blockReason ?? "unknown"})`,
        );
        return;
      }

      if (!isPersonaAllowedForTrigger(whitelistStatus, personalSpotlightStatus, selectedPersona.persona_id)) {
        log.info(
          `${type} ${actionKey} interaction completed without chat response because persona ${selectedPersona.persona_id} is blocked by persona access rules in ${interaction.channel.id}`,
        );
        return;
      }

      const messages = await interaction.channel.messages.fetch({ limit: 1 });
      const latestMessage = messages.first();

      if (!latestMessage) {
        log.warn(`No messages found in channel ${interaction.channel.id} for ${type} ${actionKey} command.`);
        return;
      }

      log.info(
        `${type} ${actionKey} triggered by ${interaction.user.id} in channel ${interaction.channel.id} for message ${latestMessage.id}`,
      );

      await tomoriChat({
        client,
        message: latestMessage as Message,
        isFromQueue: false,
        isManuallyTriggered: true,
        selectedPersonaId: selectedPersona.persona_id,
        textQuotaSource: "user",
        textQuotaTriggerKey: interaction.id,
        textQuotaUserDiscId: interaction.user.id,
        manualTriggerInvoker: {
          userDiscId: interaction.user.id,
          username: interaction.user.username,
          locale,
          member: interaction.member as import("discord.js").GuildMember | null,
        },
      });
    } catch (error) {
      await log.error(`Error in ${type} ${actionKey} command`, error, {
        errorType: `${type}_${actionKey}_command_error`,
        metadata: {
          userId: interaction.user.id,
          guildId: interaction.guild.id,
          channelId: interaction.channel?.id,
        },
      });

      try {
        await interaction.followUp({
          content: localizer(locale, "general.errors.unknown_error_description"),
          flags: MessageFlags.Ephemeral,
        });
      } catch (followUpError) {
        await log.error(`Failed to send error follow-up for ${type} ${actionKey} command`, followUpError, {
          errorType: `${type}_${actionKey}_command_error_followup`,
          metadata: {
            userId: interaction.user.id,
            guildId: interaction.guild.id,
          },
        });
      }
    }
  }

  return { configureSubcommand, execute, autocomplete: handlePersonaAutocomplete };
}
