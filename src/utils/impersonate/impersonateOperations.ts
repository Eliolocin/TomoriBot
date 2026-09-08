import type { ChatInputCommandInteraction, Client } from "discord.js";
import { MessageFlags, EmbedBuilder } from "discord.js";
import { localizer } from "@/utils/text/localizer";
import { ColorCode, log } from "@/utils/misc/logger";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { personaRepository } from "@/utils/db/repositories";
import { getOrCreateWebhook } from "@/utils/discord/webhook/lifecycle";
import { resolvePersonaWebhookIdentity } from "@/utils/discord/webhook/identity";
import type { ResolvedWebhookIdentity } from "@/utils/discord/webhook/identity";
import { sendWebhookMessageWithIdentity } from "@/utils/discord/webhook/personaDispatch";
import {
  formatRenderModifierWebhookName,
  parseLeadingImpersonationSpriteModifier,
} from "@/utils/discord/renderModifierParser";
import { resolveSpriteIdentity } from "@/utils/discord/renderModifierResolver";
import { getCachedPersonaSprites } from "@/utils/cache/personaSpriteCache";
import { recordPersonaSpriteMessage } from "@/utils/cache/personaSpriteMessageCache";
import { normalizePersonaSpriteKey } from "@/utils/persona/sprites";
import type { SpriteMessageRecordInfo } from "@/types/stream/types";
import {
  isGuildMessageCommandChannel,
  resolveGuildWebhookTargetChannel,
  resolveGuildWebhookThreadId,
} from "@/utils/discord/guildMessageChannel";
import type { UserRow } from "@/types/db/schema";
import { tomoriChat } from "@/events/messageCreate/tomoriChat";
import { CooldownType } from "@/types/db/schema";
import { cooldownRepository } from "@/utils/db/repositories/CooldownRepository";
import { sendCooldownDM } from "@/utils/discord/cooldownDM";
import { isNoticeEmbedVisible } from "@/utils/discord/toolProgressNotice";
import { getCachedWhitelistStatus } from "@/utils/cache/channelWhitelistCache";
import { getCachedUserRow } from "@/utils/cache/userCache";
import { getCachedPersonalSpotlightStatus } from "@/utils/cache/personalSpotlightCache";
import { filterPersonasForTrigger, isPersonaAllowedForTrigger } from "@/utils/persona/personaAccess";
import { UserImpersonationGenerationSkippedError } from "@/utils/chat/userImpersonationCompletion";

type ImpersonationInteraction = ChatInputCommandInteraction;

export async function executePersonaImpersonation(
  client: Client,
  interaction: ImpersonationInteraction,
  userData: UserRow,
  locale: string,
  personaId: number,
  messageContent: string,
): Promise<void> {
  if (!interaction.guildId || !interaction.channel) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.impersonate.missing_permissions_title",
      descriptionKey: "commands.impersonate.missing_permissions_description",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!isGuildMessageCommandChannel(interaction.channel)) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.impersonate.missing_permissions_title",
      descriptionKey: "commands.impersonate.missing_permissions_description",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const serverId = interaction.guildId;
  const channel = interaction.channel;
  const invokingMember = interaction.member as import("discord.js").GuildMember | null;

  const allPersonas = await personaRepository.loadAllForServer(serverId);
  if (!allPersonas || allPersonas.length === 0) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.impersonate.no_personas_title",
      descriptionKey: "commands.impersonate.no_personas_description",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const isThread = "isThread" in channel && typeof channel.isThread === "function" && channel.isThread();
  const parentChannelId = isThread && "parent" in channel ? channel.parent?.id : undefined;
  const whitelistStatus = await getCachedWhitelistStatus(
    serverId,
    channel.id,
    invokingMember?.roles.cache.map((role) => role.id),
    parentChannelId,
  );
  const tomoriState = allPersonas.find((persona) => !persona.is_alter) ?? allPersonas[0];
  const personalSpotlightStatus = userData.user_id
    ? await getCachedPersonalSpotlightStatus(
        tomoriState?.server_id ?? 0,
        userData.user_id,
        parentChannelId ?? channel.id,
      )
    : null;

  if (!whitelistStatus.isTriggerAllowed) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.message_cooldown_title",
      descriptionKey: "commands.impersonate.channel_not_whitelisted",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const availablePersonas = filterPersonasForTrigger(allPersonas, whitelistStatus, personalSpotlightStatus);
  const selectedPersona = availablePersonas.find((p) => p.persona_id === personaId);

  if (
    !selectedPersona?.persona_id ||
    !isPersonaAllowedForTrigger(whitelistStatus, personalSpotlightStatus, selectedPersona.persona_id)
  ) {
    log.info(
      `[/impersonate persona] Rejected persona selection for ID ${personaId} in channel ${channel.id} due to persona access rules or invalid ID`,
    );
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.message_cooldown_title",
      descriptionKey: "commands.impersonate.persona_access_blocked",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    const spriteModifierMatch = parseLeadingImpersonationSpriteModifier(
      messageContent,
      selectedPersona.persona_nickname,
    );
    let spriteRenderTarget: {
      identity: ResolvedWebhookIdentity;
      body: string;
      record: SpriteMessageRecordInfo;
    } | null = null;

    if (spriteModifierMatch?.body.trim()) {
      const sprites = await getCachedPersonaSprites(selectedPersona.persona_id);
      const spriteKey = normalizePersonaSpriteKey(spriteModifierMatch.modifier);
      const sprite = sprites.find((candidate) => candidate.sprite_key === spriteKey);
      if (sprite) {
        const webhookUsername = sprite.is_identity
          ? formatRenderModifierWebhookName(sprite.sprite_name, selectedPersona.persona_nickname)
          : selectedPersona.persona_nickname;
        const identity = await resolveSpriteIdentity(sprite, webhookUsername);
        if (identity) {
          spriteRenderTarget = {
            identity,
            body: spriteModifierMatch.body,
            record: {
              personaId: selectedPersona.persona_id,
              spriteName: sprite.sprite_name,
              isIdentity: sprite.is_identity,
            },
          };
        }
      }
    }

    const effectiveMessageContent = spriteRenderTarget?.body ?? messageContent;

    const shouldShowNotice = tomoriState?.config
      ? isNoticeEmbedVisible(tomoriState.config, "impersonation_notice")
      : true;

    const embeds: EmbedBuilder[] = [];
    if (shouldShowNotice) {
      const invokerAvatarUrl = interaction.member
        ? (interaction.member as import("discord.js").GuildMember).displayAvatarURL({
            size: 64,
            extension: "png",
            forceStatic: true,
          })
        : interaction.user.displayAvatarURL({
            size: 64,
            extension: "png",
            forceStatic: true,
          });

      const noticeEmbed = new EmbedBuilder()
        .setDescription(localizer(locale, "commands.impersonate.persona_impersonation_notice_description"))
        .setFooter({
          text: localizer(locale, "commands.impersonate.persona_impersonation_notice_footer", {
            user: interaction.user.username,
          }),
          iconURL: invokerAvatarUrl,
        })
        .setColor(ColorCode.INFO);
      embeds.push(noticeEmbed);
    }

    let sentMessage: import("discord.js").Message | null = null;
    if (!selectedPersona.is_alter && !spriteRenderTarget) {
      sentMessage = await channel.send({
        content: effectiveMessageContent,
        embeds,
      });
    } else {
      const webhookTargetChannel = resolveGuildWebhookTargetChannel(channel);
      const webhookThreadId = resolveGuildWebhookThreadId(channel);
      if (!webhookTargetChannel) {
        await replyInfoEmbed(interaction, locale, {
          titleKey: "commands.impersonate.missing_permissions_title",
          descriptionKey: "commands.impersonate.missing_permissions_description",
          color: ColorCode.ERROR,
        });
        return;
      }

      const { webhook, errorReason } = await getOrCreateWebhook(webhookTargetChannel);
      if (!webhook) {
        await replyInfoEmbed(interaction, locale, {
          titleKey: "commands.impersonate.webhook_error_title",
          descriptionKey: "commands.impersonate.webhook_error_description",
          descriptionVars: { error: errorReason || "Failed to create webhook" },
          color: ColorCode.ERROR,
        });
        return;
      }

      const identity =
        spriteRenderTarget?.identity ??
        (await resolvePersonaWebhookIdentity(selectedPersona, interaction.guild as import("discord.js").Guild));
      sentMessage = await sendWebhookMessageWithIdentity(
        webhook,
        {
          content: effectiveMessageContent,
          embeds,
          ...(webhookThreadId ? { threadId: webhookThreadId } : {}),
        },
        identity,
      );

      if (spriteRenderTarget && sentMessage?.webhookId) {
        void recordPersonaSpriteMessage({
          messageDiscId: sentMessage.id,
          personaId: spriteRenderTarget.record.personaId,
          spriteName: spriteRenderTarget.record.spriteName,
          channelDiscId: sentMessage.channelId,
        }).catch((recordError) => {
          log.warn("Failed to record sprite message mapping for /impersonate persona", recordError as Error);
        });
      }
    }

    if (sentMessage) {
      void tomoriChat({ client, message: sentMessage, isFromQueue: false });
    }

    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.impersonate.persona_success_title",
      descriptionKey: "commands.impersonate.persona_success_description",
      descriptionVars: { persona: selectedPersona.persona_nickname },
      color: ColorCode.SUCCESS,
    });
  } catch (error) {
    log.error("Failed to send impersonated message", {
      error,
      personaId: selectedPersona.persona_id,
      serverId,
    });
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.impersonate.webhook_error_title",
      descriptionKey: "commands.impersonate.webhook_error_description",
      descriptionVars: {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      color: ColorCode.ERROR,
    });
  }
}

export async function executeUserImpersonation(
  client: Client,
  interaction: ChatInputCommandInteraction,
  locale: string,
  impersonatedUserId: string,
  impersonatedDisplayName: string,
): Promise<void> {
  if (!interaction.guildId || !interaction.channel) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.impersonate.missing_permissions_title",
      descriptionKey: "commands.impersonate.missing_permissions_description",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!isGuildMessageCommandChannel(interaction.channel)) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.impersonate.missing_permissions_title",
      descriptionKey: "commands.impersonate.missing_permissions_description",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = interaction.channel;
  const invokingMember = interaction.member as import("discord.js").GuildMember | null;
  const cooldownActiveKey = "commands.impersonate.cooldown_active_user";
  const channelWhitelistKey = "commands.impersonate.channel_not_whitelisted_user";

  log.info(
    `[/impersonate user] Command invoked by user ${interaction.user.id} (${interaction.user.username}) in channel ${interaction.channel.id} targeting ${impersonatedUserId}`,
  );

  try {
    const tomoriState = await personaRepository.loadState(interaction.guildId);
    if (!tomoriState) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.unknown_error_title",
        descriptionKey: "general.errors.unknown_error_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const cooldownType = tomoriState.config.cooldown_type ?? CooldownType.OFF;
    const cooldownLength = tomoriState.config.cooldown_length ?? 5;

    log.info(
      `[/impersonate user] Checking cooldown - globalType: ${cooldownType}, globalLength: ${cooldownLength}s, guild: ${interaction.guildId}, user: ${interaction.user.id}, channel: ${interaction.channel.id}`,
    );

    const cooldownResult = await cooldownRepository.checkMessageTriggerCooldownWithWhitelist(
      interaction.guildId,
      interaction.user.id,
      interaction.channel.id,
      cooldownType,
      invokingMember,
    );

    log.info(
      `[/impersonate user] Cooldown check result: ${cooldownResult.isOnCooldown ? "ON COOLDOWN" : "NOT ON COOLDOWN"}, remaining: ${cooldownResult.remainingSeconds}s`,
    );

    if (cooldownResult.isOnCooldown) {
      if (cooldownResult.blockedByWhitelist) {
        await replyInfoEmbed(interaction, locale, {
          titleKey: "general.message_cooldown_title",
          descriptionKey: channelWhitelistKey,
          color: ColorCode.WARN,
        });
        return;
      }

      const footerKey = cooldownRepository.getCooldownTypeFooterKey(cooldownResult.cooldownType);
      await sendCooldownDM(
        interaction.user,
        locale,
        "general.message_cooldown_title",
        cooldownActiveKey,
        {
          seconds: cooldownResult.remainingSeconds.toString(),
          botName: tomoriState.persona_nickname,
        },
        footerKey,
        interaction,
        MessageFlags.Ephemeral,
      );
      return;
    }

    const isThread = "isThread" in channel && typeof channel.isThread === "function" && channel.isThread();
    const parentChannelId = isThread && "parent" in channel ? channel.parent?.id : undefined;
    const whitelistStatus = await getCachedWhitelistStatus(
      interaction.guildId,
      channel.id,
      invokingMember?.roles.cache.map((role) => role.id),
      parentChannelId,
    );
    const invokingUserRow = await getCachedUserRow(interaction.user.id);
    const personalSpotlightStatus = invokingUserRow?.user_id
      ? await getCachedPersonalSpotlightStatus(
          tomoriState.server_id,
          invokingUserRow.user_id,
          parentChannelId ?? channel.id,
        )
      : null;

    if (!isPersonaAllowedForTrigger(whitelistStatus, personalSpotlightStatus, tomoriState.persona_id)) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.message_cooldown_title",
        descriptionKey: "commands.impersonate.main_persona_access_blocked",
        color: ColorCode.WARN,
      });
      return;
    }

    const messages = await channel.messages.fetch({ limit: 1 });
    const latestMessage = messages.first();

    if (!latestMessage) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.impersonate.no_messages_title",
        descriptionKey: "commands.impersonate.no_messages_description",
        color: ColorCode.WARN,
      });
      return;
    }

    if (isNoticeEmbedVisible(tomoriState.config, "impersonation_notice")) {
      try {
        const invokerAvatarUrl = interaction.member
          ? (interaction.member as import("discord.js").GuildMember).displayAvatarURL({
              size: 64,
              extension: "png",
              forceStatic: true,
            })
          : interaction.user.displayAvatarURL({
              size: 64,
              extension: "png",
              forceStatic: true,
            });

        const noticeEmbed = new EmbedBuilder()
          .setDescription(localizer(locale, "commands.impersonate.user_impersonation_notice_description"))
          .setFooter({
            text: localizer(locale, "commands.impersonate.user_impersonation_notice_footer", {
              user: interaction.user.username,
              target: impersonatedDisplayName,
            }),
            iconURL: invokerAvatarUrl,
          })
          .setColor(ColorCode.INFO);

        await channel.send({
          embeds: [noticeEmbed],
        });
      } catch (noticeError) {
        log.warn("Failed to send user impersonation notice embed", {
          noticeError,
          channelId: interaction.channel.id,
          guildId: interaction.guildId,
        });
      }
    }

    await tomoriChat({
      client,
      message: latestMessage,
      isFromQueue: false,
      isManuallyTriggered: true,
      isStopResponse: false,
      isPersonaJob: false,
      isUserImpersonation: true,
      impersonatedUserId,
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

    log.info(`[/impersonate user] Setting cooldown - globalType: ${cooldownType}, globalLength: ${cooldownLength}s`);
    await cooldownRepository.setMessageTriggerCooldownWithWhitelist(
      interaction.guildId,
      interaction.user.id,
      interaction.channel.id,
      cooldownType,
      cooldownLength,
      invokingMember,
    );
    log.info(`[/impersonate user] Cooldown set successfully`);

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(localizer(locale, "commands.impersonate.me_success_title"))
          .setDescription(
            localizer(locale, "commands.impersonate.me_success_description", { user: impersonatedDisplayName }),
          )
          .setColor(ColorCode.SUCCESS),
      ],
    });
  } catch (error) {
    log.error("Failed to handle user impersonation", {
      error,
      userId: interaction.user.id,
      impersonatedUserId,
      guildId: interaction.guildId,
    });

    if (interaction.deferred || interaction.replied) {
      const isTimeoutError = error instanceof Error && /timed?\s*out|timeout/i.test(error.message);
      const isSkippedError = error instanceof UserImpersonationGenerationSkippedError;
      const description = isTimeoutError
        ? localizer(locale, "genai.error_stream_timeout_description")
        : isSkippedError
          ? localizer(locale, "commands.impersonate.user_generation_skipped_description")
          : localizer(locale, "genai.generic_error_description", {
              error_message: error instanceof Error ? error.message : "Unknown error",
            });
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(
              localizer(locale, isTimeoutError ? "genai.error_stream_timeout_title" : "genai.generic_error_title"),
            )
            .setDescription(description)
            .setColor(ColorCode.ERROR),
        ],
      });
    }
  }
}

export async function executeSystemImpersonation(
  interaction: ImpersonationInteraction,
  locale: string,
  systemContent: string,
): Promise<void> {
  if (!interaction.guildId || !interaction.channel) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.impersonate.missing_permissions_title",
      descriptionKey: "commands.impersonate.missing_permissions_description",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!isGuildMessageCommandChannel(interaction.channel)) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.impersonate.missing_permissions_title",
      descriptionKey: "commands.impersonate.missing_permissions_description",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = interaction.channel;

  const embed = new EmbedBuilder()
    .setTitle(localizer(locale, "commands.impersonate.system_title"))
    .setDescription(systemContent)
    .setColor(ColorCode.SECTION);

  const invokerAvatarUrl = interaction.member
    ? (interaction.member as import("discord.js").GuildMember).displayAvatarURL({
        size: 64,
        extension: "png",
        forceStatic: true,
      })
    : interaction.user.displayAvatarURL({
        size: 64,
        extension: "png",
        forceStatic: true,
      });

  embed.setFooter({
    text: localizer(locale, "commands.impersonate.system_injected_footer", {
      user: interaction.user.username,
    }),
    iconURL: invokerAvatarUrl,
  });

  await channel.send({
    embeds: [embed],
  });

  await replyInfoEmbed(interaction, locale, {
    titleKey: "commands.impersonate.system_success_title",
    descriptionKey: "commands.impersonate.system_success_description",
    color: ColorCode.SUCCESS,
  });
}
