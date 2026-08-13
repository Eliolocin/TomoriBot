import type { Client, ChatInputCommandInteraction, UserSelectMenuInteraction } from "discord.js";
import {
  MessageFlags,
  type SlashCommandSubcommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  UserSelectMenuBuilder,
  ComponentType,
} from "discord.js";
import { localizer } from "@/utils/text/localizer";
import { ColorCode, log } from "@/utils/misc/logger";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { promptWithPaginatedModal, safeSelectOptionText } from "@/utils/discord/ui/modals";
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
import type { SelectOption } from "@/types/discord/modal";
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

/**
 * Configures the /bot impersonate subcommand
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) => {
  return subcommand
    .setName("impersonate")
    .setDescription(localizer("en-US", "commands.bot.impersonate.description"))
    .addStringOption((option) =>
      option
        .setName("target")
        .setDescription(localizer("en-US", "commands.bot.impersonate.target_description"))
        .setRequired(true)
        .addChoices(
          {
            name: localizer("en-US", "commands.bot.impersonate.target_persona"),
            value: "persona",
          },
          {
            name: localizer("en-US", "commands.bot.impersonate.target_user"),
            value: "user",
          },
          {
            name: localizer("en-US", "commands.bot.impersonate.target_system"),
            value: "system",
          },
        ),
    );
};

/**
 * Handles user-target impersonation - prompt for a user, then run user impersonation flow
 */
async function handleTargetUserImpersonation(
  client: Client,
  interaction: ChatInputCommandInteraction,
  locale: string,
): Promise<void> {
  const userSelect = new UserSelectMenuBuilder()
    .setCustomId("impersonate_target_user_select")
    .setPlaceholder(localizer(locale, "commands.bot.impersonate.user_select_placeholder"))
    .setMinValues(1)
    .setMaxValues(1);

  const selectEmbed = new EmbedBuilder()
    .setTitle(localizer(locale, "commands.bot.impersonate.user_select_title"))
    .setDescription(localizer(locale, "commands.bot.impersonate.user_select_description"))
    .setColor(ColorCode.INFO);

  await interaction.reply({
    embeds: [selectEmbed],
    components: [new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(userSelect)],
    flags: MessageFlags.Ephemeral,
  });

  const promptMessage = await interaction.fetchReply();
  let userSelectInteraction: UserSelectMenuInteraction;

  try {
    userSelectInteraction = await promptMessage.awaitMessageComponent({
      componentType: ComponentType.UserSelect,
      filter: (i: UserSelectMenuInteraction) => i.user.id === interaction.user.id,
      time: 60_000,
    });
  } catch (_error) {
    log.warn(`[/bot impersonate user] User select prompt timed out for user ${interaction.user.id}`);
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.interaction.timeout_title",
      descriptionKey: "general.interaction.timeout_description",
      color: ColorCode.WARN,
    });
    return;
  }

  await userSelectInteraction.deferUpdate();
  await interaction.editReply({ components: [] });

  const selectedUserId = userSelectInteraction.values[0];
  const selectedUser = userSelectInteraction.users.get(selectedUserId);
  const selectedMember = interaction.guild?.members.cache.get(selectedUserId);
  const selectedDisplayName =
    selectedMember?.displayName || selectedUser?.displayName || selectedUser?.username || "User";

  await handleUserImpersonation(client, interaction, locale, selectedUserId, selectedDisplayName, "user");
}

/**
 * Handles persona impersonation - user sends messages as bot personas
 */
async function handlePersonaImpersonation(
  client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.guild || !interaction.channel) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.bot.impersonate.missing_permissions_title",
      descriptionKey: "commands.bot.impersonate.missing_permissions_description",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!isGuildMessageCommandChannel(interaction.channel)) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.bot.impersonate.missing_permissions_title",
      descriptionKey: "commands.bot.impersonate.missing_permissions_description",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const serverId = interaction.guild.id;
  const channel = interaction.channel;
  const invokingMember = interaction.member as import("discord.js").GuildMember | null;

  // Load all personas (main + alters) - keep this under 3 seconds
  const allPersonas = await personaRepository.loadAllForServer(serverId);
  if (!allPersonas || allPersonas.length === 0) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.bot.impersonate.no_personas_title",
      descriptionKey: "commands.bot.impersonate.no_personas_description",
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
      descriptionKey: "commands.bot.impersonate.channel_not_whitelisted",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const availablePersonas = filterPersonasForTrigger(allPersonas, whitelistStatus, personalSpotlightStatus);
  if (availablePersonas.length === 0) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.message_cooldown_title",
      descriptionKey: "commands.bot.impersonate.persona_access_blocked",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const personaSelectOptions: SelectOption[] = availablePersonas.map((persona, index) => ({
    label: safeSelectOptionText(persona.persona_nickname),
    value: index.toString(), // Use index to avoid ID truncation issues
    description: persona.is_alter ? "Alter Persona" : "Main Persona",
  }));

  // Show modal with persona select + message text area
  // DO NOT defer before modal - Pattern 3
  const modalResult = await promptWithPaginatedModal(interaction, locale, {
    modalCustomId: "impersonate_persona_modal",
    modalTitleKey: "commands.bot.impersonate.persona_modal_title",
    components: [
      {
        customId: "persona_select",
        labelKey: "commands.bot.impersonate.persona_select_label",
        placeholder: localizer(locale, "commands.bot.impersonate.persona_select_placeholder"),
        required: true,
        options: personaSelectOptions,
      },
      {
        customId: "message_content",
        labelKey: "commands.bot.impersonate.persona_message_label",
        placeholder: localizer(locale, "commands.bot.impersonate.persona_message_placeholder"),
        required: true,
        minLength: 1,
        maxLength: 2000,
        style: 2, // TextInputStyle.Paragraph
      },
    ],
  });

  if (modalResult.outcome !== "submit" || !modalResult.values || !modalResult.interaction) {
    return;
  }

  if (!modalResult.interaction.deferred && !modalResult.interaction.replied) {
    await modalResult.interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  const selectedIndex = Number.parseInt(modalResult.values.persona_select || "0", 10);
  const messageContent = modalResult.values.message_content || "";

  const selectedPersona = availablePersonas[selectedIndex];
  if (
    !selectedPersona?.persona_id ||
    !isPersonaAllowedForTrigger(whitelistStatus, personalSpotlightStatus, selectedPersona.persona_id)
  ) {
    log.info(
      `[/bot impersonate persona] Rejected persona selection at index ${selectedIndex} in channel ${channel.id} due to persona access rules or stale modal state`,
    );
    await replyInfoEmbed(modalResult.interaction, locale, {
      titleKey: "general.message_cooldown_title",
      descriptionKey: "commands.bot.impersonate.persona_access_blocked",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    // Sprite modifiers are opt-in on an actual match: "(shocked): WTF" or
    // "Tomori (shocked): WTF" only take effect when the modifier resolves to a
    // real persona_sprites row. Otherwise the text is sent exactly as typed,
    // parentheses and all, so ordinary prose is never mangled.
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
        .setDescription(localizer(locale, "commands.bot.impersonate.persona_impersonation_notice_description"))
        .setFooter({
          text: localizer(locale, "commands.bot.impersonate.persona_impersonation_notice_footer", {
            user: interaction.user.username,
          }),
          iconURL: invokerAvatarUrl,
        })
        .setColor(ColorCode.INFO);
      embeds.push(noticeEmbed);
    }

    let sentMessage: import("discord.js").Message | null = null;
    // A sprite match forces the webhook path even for the main (non-alter) persona,
    // since only a webhook send can carry a per-message avatar/username override.
    if (!selectedPersona.is_alter && !spriteRenderTarget) {
      sentMessage = await channel.send({
        content: effectiveMessageContent,
        embeds,
      });
    } else {
      const webhookTargetChannel = resolveGuildWebhookTargetChannel(channel);
      const webhookThreadId = resolveGuildWebhookThreadId(channel);
      if (!webhookTargetChannel) {
        await replyInfoEmbed(modalResult.interaction, locale, {
          titleKey: "commands.bot.impersonate.missing_permissions_title",
          descriptionKey: "commands.bot.impersonate.missing_permissions_description",
          color: ColorCode.ERROR,
        });
        return;
      }

      const { webhook, errorReason } = await getOrCreateWebhook(webhookTargetChannel);
      if (!webhook) {
        await replyInfoEmbed(modalResult.interaction, locale, {
          titleKey: "commands.bot.impersonate.webhook_error_title",
          descriptionKey: "commands.bot.impersonate.webhook_error_description",
          descriptionVars: { error: errorReason || "Failed to create webhook" },
          color: ColorCode.ERROR,
        });
        return;
      }

      const identity =
        spriteRenderTarget?.identity ?? (await resolvePersonaWebhookIdentity(selectedPersona, interaction.guild));
      sentMessage = await sendWebhookMessageWithIdentity(
        webhook,
        {
          content: effectiveMessageContent,
          embeds,
          ...(webhookThreadId ? { threadId: webhookThreadId } : {}),
        },
        identity,
      );

      // Persist the message -> sprite mapping fire-and-forget, mirroring the stream
      // delivery path, so context rebuilding can recover the decorated "Name (sprite):"
      // label for the model later. A lost row just degrades to the plain persona name.
      if (spriteRenderTarget && sentMessage?.webhookId) {
        void recordPersonaSpriteMessage({
          messageDiscId: sentMessage.id,
          personaId: spriteRenderTarget.record.personaId,
          spriteName: spriteRenderTarget.record.spriteName,
          channelDiscId: sentMessage.channelId,
        }).catch((recordError) => {
          log.warn("Failed to record sprite message mapping for /bot impersonate persona", recordError as Error);
        });
      }
    }

    // If the sent message contains a trigger word, let the normal cascade fire.
    // tomoriChat runs with isManuallyTriggered=false so trigger rules apply as usual.
    // The self-message detection skips the sending persona; other personas may respond.
    if (sentMessage) {
      void tomoriChat({ client, message: sentMessage, isFromQueue: false });
    }

    await replyInfoEmbed(modalResult.interaction, locale, {
      titleKey: "commands.bot.impersonate.persona_success_title",
      descriptionKey: "commands.bot.impersonate.persona_success_description",
      descriptionVars: { persona: selectedPersona.persona_nickname },
      color: ColorCode.SUCCESS,
    });
  } catch (error) {
    log.error("Failed to send impersonated message", {
      error,
      personaId: selectedPersona.persona_id,
      serverId,
    });
    await replyInfoEmbed(modalResult.interaction, locale, {
      titleKey: "commands.bot.impersonate.webhook_error_title",
      descriptionKey: "commands.bot.impersonate.webhook_error_description",
      descriptionVars: {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      color: ColorCode.ERROR,
    });
  }
}

/**
 * Handles user impersonation - bot mimics the user through webhook
 */
async function handleUserImpersonation(
  client: Client,
  interaction: ChatInputCommandInteraction,
  locale: string,
  impersonatedUserId: string = interaction.user.id,
  impersonatedDisplayName?: string,
  invokedTarget: "me" | "user" = "me",
): Promise<void> {
  if (!interaction.guild || !interaction.channel) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.bot.impersonate.missing_permissions_title",
      descriptionKey: "commands.bot.impersonate.missing_permissions_description",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!isGuildMessageCommandChannel(interaction.channel)) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.bot.impersonate.missing_permissions_title",
      descriptionKey: "commands.bot.impersonate.missing_permissions_description",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = interaction.channel;
  const invokingMember = interaction.member as import("discord.js").GuildMember | null;
  const commandTarget = invokedTarget;
  const cooldownActiveKey =
    invokedTarget === "me"
      ? "commands.bot.impersonate.cooldown_active"
      : "commands.bot.impersonate.cooldown_active_user";
  const channelWhitelistKey =
    invokedTarget === "me"
      ? "commands.bot.impersonate.channel_not_whitelisted"
      : "commands.bot.impersonate.channel_not_whitelisted_user";

  log.info(
    `[/bot impersonate ${commandTarget}] Command invoked by user ${interaction.user.id} (${interaction.user.username}) in channel ${interaction.channel.id} targeting ${impersonatedUserId}`,
  );

  // Defer the interaction immediately (Pattern 2 - async work ahead)
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  try {
    const tomoriState = await personaRepository.loadState(interaction.guild.id);
    if (!tomoriState) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.unknown_error_title",
        descriptionKey: "general.errors.unknown_error_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    // Check cooldown (shares cooldown pool with message triggers and /bot respond)
    // Uses whitelist-aware version to respect per-channel cooldown overrides
    const cooldownType = tomoriState.config.cooldown_type ?? CooldownType.OFF;
    const cooldownLength = tomoriState.config.cooldown_length ?? 5;

    log.info(
      `[/bot impersonate ${commandTarget}] Checking cooldown - globalType: ${cooldownType}, globalLength: ${cooldownLength}s, guild: ${interaction.guild.id}, user: ${interaction.user.id}, channel: ${interaction.channel.id}`,
    );

    const cooldownResult = await cooldownRepository.checkMessageTriggerCooldownWithWhitelist(
      interaction.guild.id,
      interaction.user.id,
      interaction.channel.id,
      cooldownType,
      invokingMember,
    );

    log.info(
      `[/bot impersonate ${commandTarget}] Cooldown check result: ${cooldownResult.isOnCooldown ? "ON COOLDOWN" : "NOT ON COOLDOWN"}, remaining: ${cooldownResult.remainingSeconds}s`,
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
      interaction.guild.id,
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
        descriptionKey: "commands.bot.impersonate.main_persona_access_blocked",
        color: ColorCode.WARN,
      });
      return;
    }

    // Same pattern as /bot respond - no placeholder message needed
    const messages = await channel.messages.fetch({ limit: 1 });
    const latestMessage = messages.first();

    if (!latestMessage) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.bot.impersonate.no_messages_title",
        descriptionKey: "commands.bot.impersonate.no_messages_description",
        color: ColorCode.WARN,
      });
      return;
    }

    const member = interaction.guild.members.cache.get(impersonatedUserId);
    const displayName = impersonatedDisplayName || member?.displayName || member?.user.displayName || "User";

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
          .setDescription(localizer(locale, "commands.bot.impersonate.user_impersonation_notice_description"))
          .setFooter({
            text: localizer(locale, "commands.bot.impersonate.user_impersonation_notice_footer", {
              user: interaction.user.username,
              target: displayName,
            }),
            iconURL: invokerAvatarUrl,
          })
          .setColor(ColorCode.INFO);

        // Send the notice as a normal bot message so it stays clearly separate
        // from the actual impersonated webhook output and cannot contaminate
        // webhook identity tracking.
        await channel.send({
          embeds: [noticeEmbed],
        });
      } catch (noticeError) {
        log.warn("Failed to send user impersonation notice embed", {
          noticeError,
          channelId: interaction.channel.id,
          guildId: interaction.guild.id,
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

    // Set cooldown after successful response (shares cooldown pool with message triggers and /bot respond)
    // Uses whitelist-aware version to respect per-channel cooldown overrides
    log.info(
      `[/bot impersonate ${commandTarget}] Setting cooldown - globalType: ${cooldownType}, globalLength: ${cooldownLength}s`,
    );
    await cooldownRepository.setMessageTriggerCooldownWithWhitelist(
      interaction.guild.id,
      interaction.user.id,
      interaction.channel.id,
      cooldownType,
      cooldownLength,
      invokingMember,
    );
    log.info(`[/bot impersonate ${commandTarget}] Cooldown set successfully`);

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(localizer(locale, "commands.bot.impersonate.me_success_title"))
          .setDescription(localizer(locale, "commands.bot.impersonate.me_success_description", { user: displayName }))
          .setColor(ColorCode.SUCCESS),
      ],
    });
  } catch (error) {
    log.error("Failed to handle user impersonation", {
      error,
      userId: interaction.user.id,
      impersonatedUserId,
      guildId: interaction.guild?.id,
    });

    if (interaction.deferred || interaction.replied) {
      const isTimeoutError = error instanceof Error && /timed?\s*out|timeout/i.test(error.message);
      const description = isTimeoutError
        ? localizer(locale, "genai.error_stream_timeout_description")
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

/**
 * Handles system impersonation - user injects system prompts as embeds
 */
async function handleSystemImpersonation(interaction: ChatInputCommandInteraction, locale: string): Promise<void> {
  if (!interaction.guild || !interaction.channel) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.bot.impersonate.missing_permissions_title",
      descriptionKey: "commands.bot.impersonate.missing_permissions_description",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!isGuildMessageCommandChannel(interaction.channel)) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.bot.impersonate.missing_permissions_title",
      descriptionKey: "commands.bot.impersonate.missing_permissions_description",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = interaction.channel;

  // Show modal for system prompt content
  // DO NOT defer before modal - Pattern 3
  const modalResult = await promptWithPaginatedModal(interaction, locale, {
    modalCustomId: "impersonate_system_modal",
    modalTitleKey: "commands.bot.impersonate.system_modal_title",
    components: [
      {
        customId: "system_content",
        labelKey: "commands.bot.impersonate.system_content_label",
        placeholder: localizer(locale, "commands.bot.impersonate.system_content_placeholder"),
        required: true,
        minLength: 1,
        maxLength: 4000,
        style: 2, // TextInputStyle.Paragraph
      },
    ],
  });

  if (modalResult.outcome !== "submit" || !modalResult.values || !modalResult.interaction) {
    return;
  }

  if (!modalResult.interaction.deferred && !modalResult.interaction.replied) {
    await modalResult.interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  const systemContent = modalResult.values.system_content || "";

  // Create embed with "System Message" title (triggers detection in tomoriChat)
  const embed = new EmbedBuilder()
    .setTitle(localizer(locale, "commands.bot.impersonate.system_title"))
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
    text: localizer(locale, "commands.bot.impersonate.system_injected_footer", {
      user: interaction.user.username,
    }),
    iconURL: invokerAvatarUrl,
  });

  // Send as public message in the channel (not ephemeral - this is the injection)
  await channel.send({
    embeds: [embed],
  });

  await replyInfoEmbed(modalResult.interaction, locale, {
    titleKey: "commands.bot.impersonate.system_success_title",
    descriptionKey: "commands.bot.impersonate.system_success_description",
    color: ColorCode.SUCCESS,
  });
}

/**
 * Executes the /bot impersonate command
 */
export async function execute(
  client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.guild) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.guild_only_title",
      descriptionKey: "general.errors.guild_only_description",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const target = interaction.options.getString("target", true);

  switch (target) {
    case "persona":
      await handlePersonaImpersonation(client, interaction, userData, locale);
      break;
    case "user":
      await handleTargetUserImpersonation(client, interaction, locale);
      break;
    case "system":
      await handleSystemImpersonation(interaction, locale);
      break;
    default:
      log.error(`Invalid target option: ${target}`);
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.unknown_error_title",
        descriptionKey: "general.errors.unknown_error_description",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
  }
}
