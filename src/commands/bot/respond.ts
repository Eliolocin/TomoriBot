import type { SlashCommandSubcommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction, Client, Message } from "discord.js";
import { EmbedBuilder, MessageFlags, PermissionFlagsBits } from "discord.js";
import { promptWithPaginatedModal, replyInfoEmbed, safeSelectOptionText } from "../../utils/discord/interactionHelper";
import { sendCooldownDM } from "../../utils/discord/cooldownDM";
import { ColorCode, log } from "../../utils/misc/logger";
import { localizer } from "../../utils/text/localizer";
import type { UserRow } from "../../types/db/schema";
import type { ModalComponent, SelectOption } from "../../types/discord/modal";
import { tomoriChat } from "../../events/messageCreate/tomoriChat";
import { llmModelRepo, personaRepository } from "@/utils/db/repositories";
import { getCachedWhitelistStatus } from "../../utils/cache/channelWhitelistCache";
import { getCachedPersonalSpotlightStatus } from "@/utils/cache/personalSpotlightCache";
import { normalizeMessageFetchLimit } from "@/utils/discord/messageFetchLimit";
import { resolveFallbackPersona } from "@/utils/discord/personaTurnDetectionResolver";
import { filterPersonasForTrigger, isPersonaAllowedForTrigger } from "@/utils/persona/personaAccess";
import { CooldownType } from "../../types/db/schema";
import { cooldownRepository } from "@/utils/db/repositories/CooldownRepository";
import { isNoticeEmbedVisible } from "@/utils/discord/toolProgressNotice";

/**
 * Configure the respond subcommand
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("respond")
    .setDescription(localizer("en-US", "commands.bot.respond.description"))
    .addBooleanOption((option) =>
      option
        .setName("extra_options")
        .setDescription(localizer("en-US", "commands.bot.respond.extra_options_description"))
        .setRequired(false),
    );

/**
 * Execute the respond command - manually trigger Tomori to respond to the latest message
 */
export async function execute(
  client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  // Ensure command is run in a guild text channel - let helper functions manage interaction state
  if (!interaction.channel || !("messages" in interaction.channel)) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.guild_only_title",
      descriptionKey: "general.errors.guild_only_description",
      color: ColorCode.ERROR,
    });
    return;
  }

  const botMember = interaction.guild?.members.me;
  if (!botMember || !interaction.guild) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
    });
    return;
  }

  // Get the guild channel (we know it exists from check above, but need type narrowing)
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
  if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions?.has(PermissionFlagsBits.ReadMessageHistory)) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.bot.respond.missing_permissions_title",
      descriptionKey: "commands.bot.respond.missing_permissions_description",
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

  const extraOptions = interaction.options.getBoolean("extra_options") ?? false;
  const invokingMember = interaction.member as import("discord.js").GuildMember | null;

  // Check cooldown (shares cooldown pool with message triggers)
  const cooldownType = tomoriState.config.cooldown_type ?? CooldownType.OFF;
  const cooldownLength = tomoriState.config.cooldown_length ?? 5;

  // Uses whitelist-aware version to respect per-channel cooldown overrides
  const cooldownResult = await cooldownRepository.checkMessageTriggerCooldownWithWhitelist(
    interaction.guild.id,
    interaction.user.id,
    interaction.channel.id,
    cooldownType,
    invokingMember,
  );

  if (cooldownResult.isOnCooldown) {
    if (cooldownResult.blockedByWhitelist) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.message_cooldown_title",
        descriptionKey: "commands.bot.respond.channel_not_whitelisted",
        color: ColorCode.WARN,
      });
      return;
    }

    const footerKey = cooldownRepository.getCooldownTypeFooterKey(cooldownResult.cooldownType);
    await sendCooldownDM(
      interaction.user,
      locale,
      "general.message_cooldown_title",
      "commands.bot.respond.cooldown_active",
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

  const allPersonas = await personaRepository.loadAllForServer(interaction.guild.id);
  const isThread = "isThread" in guildChannel && typeof guildChannel.isThread === "function" && guildChannel.isThread();
  const parentChannelId = isThread && "parent" in guildChannel ? guildChannel.parent?.id : undefined;
  const whitelistStatus = await getCachedWhitelistStatus(
    interaction.guild.id,
    interaction.channel.id,
    invokingMember?.roles.cache.map((role) => role.id),
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
      titleKey: "general.message_cooldown_title",
      descriptionKey: "commands.bot.respond.persona_access_blocked",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const fetchedMessages = await interaction.channel.messages.fetch({
    limit: normalizeMessageFetchLimit(tomoriState.config.message_fetch_limit),
  });
  const messages = [...fetchedMessages.values()].reverse();
  const latestMessage = fetchedMessages.first();

  if (!latestMessage) {
    log.warn(`No messages found in channel ${interaction.channel.id} for manual respond command.`);
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.bot.respond.no_messages_title",
      descriptionKey: "commands.bot.respond.no_messages_description",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const fallbackPersona = await resolveFallbackPersona({
    availablePersonas,
    allPersonas,
    tomoriState,
    effectiveChannelId: parentChannelId ?? interaction.channel.id,
    personalAutoTriggerPersonaId: personalSpotlightStatus?.autoTriggerPersonaId ?? null,
    clientUserId: client.user?.id,
    fetchRecentMessages: async () => messages,
  });

  if (!fallbackPersona) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const hideEmbed = !isNoticeEmbedVisible(tomoriState.config, "respond_embed");
  const deferFlags = hideEmbed
    ? MessageFlags.Ephemeral | MessageFlags.SuppressNotifications
    : MessageFlags.SuppressNotifications;

  let selectedPersona = fallbackPersona;
  let replyInteraction: ChatInputCommandInteraction | import("discord.js").ModalSubmitInteraction = interaction;
  let manualPrompt: string | undefined;
  let manualPrefill: string | undefined;
  let forceReason: boolean | undefined;
  let llmOverrideCodename: string | undefined;

  if (extraOptions) {
    const modalComponents: ModalComponent[] = [];

    if (availablePersonas.length > 1) {
      const personaOptions: SelectOption[] = availablePersonas.map((persona, index) => ({
        label: safeSelectOptionText(persona.persona_nickname),
        value: index.toString(),
        description: localizer(
          locale,
          persona.is_alter
            ? "commands.bot.respond.alter_persona_description"
            : "commands.bot.respond.main_persona_description",
        ),
      }));
      modalComponents.push({
        customId: "persona_choice",
        labelKey: "commands.bot.respond.select_persona_label",
        descriptionKey: "commands.bot.respond.select_persona_description",
        placeholder: "commands.bot.respond.select_persona_placeholder",
        required: true,
        options: personaOptions,
      });
    }

    // Reasoning checkbox: checked = "true", unchecked = "false"
    modalComponents.push({
      kind: "checkbox" as const,
      customId: "use_reasoning",
      labelKey: "commands.bot.respond.use_reasoning_label",
      descriptionKey: "commands.bot.respond.use_reasoning_description",
      default: false,
    });

    modalComponents.push({
      customId: "prompt",
      labelKey: "commands.bot.respond.prompt_label",
      descriptionKey: "commands.bot.respond.prompt_description",
      placeholder: localizer(locale, "commands.bot.respond.prompt_placeholder"),
      required: false,
      maxLength: 2000,
      style: 2, // TextInputStyle.Paragraph
    });

    modalComponents.push({
      customId: "prefill",
      labelKey: "commands.bot.respond.prefill_label",
      descriptionKey: "commands.bot.respond.prefill_description",
      placeholder: localizer(locale, "commands.bot.respond.prefill_placeholder"),
      required: false,
      maxLength: 2000,
      style: 2, // TextInputStyle.Paragraph
    });

    const modalResult = await promptWithPaginatedModal(interaction, locale, {
      modalCustomId: "respond_persona_select",
      modalTitleKey: "commands.bot.respond.extra_options_title",
      components: modalComponents,
    });

    if (modalResult.outcome !== "submit") {
      log.info(`Respond modal ${modalResult.outcome} for user ${interaction.user.id}`);
      return;
    }

    if (modalResult.interaction) {
      replyInteraction = modalResult.interaction;
    }

    // Defer the modal submission: opens a new 3-second window
    await replyInteraction.deferReply({ flags: deferFlags });

    const selectedIndex = Number.parseInt(modalResult.values?.persona_choice ?? "0", 10);
    if (availablePersonas.length > 1) {
      selectedPersona = availablePersonas[selectedIndex] ?? fallbackPersona;
      log.info(
        `User ${interaction.user.id} selected persona ${selectedPersona.persona_nickname} (ID: ${selectedPersona.persona_id}) for manual respond`,
      );
    }

    if (!isPersonaAllowedForTrigger(whitelistStatus, personalSpotlightStatus, selectedPersona?.persona_id)) {
      await replyInteraction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "general.message_cooldown_title"))
            .setDescription(localizer(locale, "commands.bot.respond.persona_access_blocked"))
            .setColor(ColorCode.WARN),
        ],
      });
      return;
    }

    const manualPromptRaw = modalResult.values?.prompt;
    manualPrompt = manualPromptRaw?.trim() || undefined;
    const manualPrefillRaw = modalResult.values?.prefill;
    manualPrefill = manualPrefillRaw?.trim() || undefined;

    const useReasoning = modalResult.values?.use_reasoning === "true";
    if (useReasoning) {
      const currentProvider = tomoriState.llm.llm_provider;
      const smartestModel = await llmModelRepo.loadSmartestModel(currentProvider);

      if (!smartestModel) {
        await replyInteraction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle(localizer(locale, "commands.bot.respond.no_smart_model_title"))
              .setDescription(localizer(locale, "commands.bot.respond.no_smart_model_description"))
              .setColor(ColorCode.ERROR),
          ],
        });
        return;
      }

      forceReason = true;
      llmOverrideCodename = smartestModel.llm_codename;
    }
  } else {
    await interaction.deferReply({ flags: deferFlags });

    if (!isPersonaAllowedForTrigger(whitelistStatus, personalSpotlightStatus, selectedPersona?.persona_id)) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "general.message_cooldown_title"))
            .setDescription(localizer(locale, "commands.bot.respond.persona_access_blocked"))
            .setColor(ColorCode.WARN),
        ],
      });
      return;
    }
  }

  try {
    const successEmbed = new EmbedBuilder()
      .setTitle(localizer(locale, "commands.bot.respond.success_title"))
      .setDescription(localizer(locale, "commands.bot.respond.success_description"))
      .setColor(ColorCode.SUCCESS);

    if (!hideEmbed) {
      successEmbed.setFooter({
        text: localizer(locale, "commands.bot.respond.embed_hide_notice"),
      });
    }

    // Send success response (interaction already deferred above)
    await replyInteraction.editReply({
      embeds: [successEmbed],
    });

    // We need to ensure this message will pass the trigger checks
    // NOTE: tomoriChat has built-in logic (lines 2004-2040) that injects a
    // "[Continue your last message]" prompt when isManuallyTriggered=true
    // and the last message in history is from the bot
    const passportMessage = latestMessage;

    log.info(
      `Manual respond command triggered by ${interaction.user.id} in channel ${interaction.channel.id} for message ${latestMessage.id}`,
    );

    await tomoriChat({
      client,
      message: passportMessage as Message,
      isFromQueue: false,
      isManuallyTriggered: true,
      forceReason,
      reasoningQuery: forceReason ? manualPrompt : undefined,
      llmOverrideCodename,
      selectedPersonaId: selectedPersona?.persona_id ?? undefined,
      textQuotaSource: "user",
      textQuotaTriggerKey: interaction.id,
      textQuotaUserDiscId: interaction.user.id,
      manualSystemPrompt: manualPrompt || undefined,
      manualPrefill,
      manualTriggerInvoker: {
        userDiscId: interaction.user.id,
        username: interaction.user.username,
        locale,
        member: interaction.member as import("discord.js").GuildMember | null,
      },
    });

    // Set cooldown after successful response (shares cooldown pool with message triggers)
    // Uses whitelist-aware version to respect per-channel cooldown overrides
    await cooldownRepository.setMessageTriggerCooldownWithWhitelist(
      interaction.guild.id,
      interaction.user.id,
      interaction.channel.id,
      cooldownType,
      cooldownLength,
      invokingMember,
    );
  } catch (error) {
    log.error("Error in bot respond command:", error, {
      errorType: "BotRespondCommandError",
      metadata: {
        userId: interaction.user.id,
        guildId: interaction.guild?.id ?? interaction.user.id,
        channelId: interaction.channel?.id,
      },
    });

    try {
      await replyInteraction.followUp({
        content: localizer(locale, "general.errors.unknown_error_description"),
        flags: MessageFlags.Ephemeral,
      });
    } catch (followUpError) {
      log.error("Failed to send error followup for bot respond command:", followUpError);
    }
  }
}
