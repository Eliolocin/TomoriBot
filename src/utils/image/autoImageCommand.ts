import {
  MessageFlags,
  PermissionFlagsBits,
  TextInputStyle,
  type BaseGuildTextChannel,
  type ChatInputCommandInteraction,
  type Client,
  type TextChannel,
} from "discord.js";
import { sendCooldownDM } from "@/utils/discord/cooldownDM";
import { promptWithRawModal } from "@/utils/discord/ui/modals";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { personaRepository } from "@/utils/db/repositories";
import { getOrCreateWebhook } from "@/utils/discord/webhook/lifecycle";
import { resolvePersonaWebhookIdentity } from "@/utils/discord/webhook/identity";
import { cooldownRepository } from "@/utils/db/repositories/CooldownRepository";
import { checkImageQuota } from "@/utils/quota/imageQuotaManager";
import { hasOptApiKey } from "@/utils/security/crypto";
import { CooldownType, type TomoriState, type UserRow } from "@/types/db/schema";
import { localizer } from "@/utils/text/localizer";
import { log, ColorCode } from "@/utils/misc/logger";
import { runHiddenImageTurn } from "@/utils/provider/hiddenImageTurn";
import { applyPersonalProviderSelectionsToTomoriState } from "@/utils/provider/personalProviderRuntime";
import { getCachedWhitelistStatus } from "@/utils/cache/channelWhitelistCache";
import { getCachedPersonalSpotlightStatus } from "@/utils/cache/personalSpotlightCache";
import { filterPersonasForTrigger, isPersonaAllowedForTrigger } from "@/utils/persona/personaAccess";

const MODAL_CUSTOM_ID = "generate_image_auto_modal";
const PROMPT_INPUT_ID = "generate_image_auto_prompt";
const SETTING_INPUT_ID = "generate_image_auto_setting";
const BACKEND_INPUT_ID = "generate_image_auto_backend";
const PERSONA_INPUT_ID = "generate_image_auto_persona";

type SceneSettingId = "storybeat" | "character" | "snapshot" | "vertical";
type SceneImageBackend = "current_provider" | "novelai";
type NaiOrientation = "portrait" | "landscape" | "square";

interface SceneSettingPreset {
  aspectRatio: string;
  /** Human-readable framing label shown in the modal and passed to the hidden agent. */
  plannerLabel: string;
  /** Framing instruction passed to the hidden agent as part of its directive. */
  plannerInstruction: string;
  novelAiOrientation: NaiOrientation;
}

const SCENE_SETTING_PRESETS: Record<SceneSettingId, SceneSettingPreset> = {
  storybeat: {
    aspectRatio: "16:9",
    plannerLabel: "Story Beat",
    plannerInstruction:
      "Use a wider cinematic composition that captures the immediate scene, action, and surroundings.",
    novelAiOrientation: "landscape",
  },
  character: {
    aspectRatio: "3:4",
    plannerLabel: "Character Focus",
    plannerInstruction:
      "Prioritize the main character or speaker, with closer framing and readable expression/body language.",
    novelAiOrientation: "portrait",
  },
  snapshot: {
    aspectRatio: "1:1",
    plannerLabel: "Square Snapshot",
    plannerInstruction: "Create a balanced square composition that still shows the current moment clearly.",
    novelAiOrientation: "square",
  },
  vertical: {
    aspectRatio: "9:16",
    plannerLabel: "Phone Wallpaper",
    plannerInstruction:
      "Use tall vertical framing with strong silhouette, depth, and room for a wallpaper-style composition.",
    novelAiOrientation: "portrait",
  },
};

interface SceneImageBackendAvailability {
  currentProvider: boolean;
  novelAi: boolean;
  showBackendSelector: boolean;
  defaultBackend: SceneImageBackend | null;
}

/**
 * Persona fields needed for the modal selector, webhook identity resolution,
 * and overriding the `buildContext()` persona identity in the hidden agent.
 */
interface PersonaSummary {
  persona_id: number;
  persona_nickname: string;
  webhook_avatar_url: string | null;
  is_alter: boolean;
  /** From persona_configs: null when no persona-specific prompt is set. */
  persona_prompt: string | null;
  /** Appearance/personality attribute list used by buildContext(). */
  attribute_list: string[];
  /** Lineage ID used by buildContext() for persona-scoped memory/RAG. */
  persona_lineage_id: number | null;
}

type ImageQuotaCheckResult = Awaited<ReturnType<typeof checkImageQuota>>;

function getSettingOptions(locale: string) {
  return [
    {
      label: localizer(locale, "commands.tool.visualize.modal.setting_storybeat_label"),
      value: "storybeat",
      description: localizer(locale, "commands.tool.visualize.modal.setting_storybeat_description"),
    },
    {
      label: localizer(locale, "commands.tool.visualize.modal.setting_character_label"),
      value: "character",
      description: localizer(locale, "commands.tool.visualize.modal.setting_character_description"),
    },
    {
      label: localizer(locale, "commands.tool.visualize.modal.setting_snapshot_label"),
      value: "snapshot",
      description: localizer(locale, "commands.tool.visualize.modal.setting_snapshot_description"),
    },
    {
      label: localizer(locale, "commands.tool.visualize.modal.setting_vertical_label"),
      value: "vertical",
      description: localizer(locale, "commands.tool.visualize.modal.setting_vertical_description"),
    },
  ];
}

function getBackendOptions(locale: string, providerName: string) {
  return [
    {
      label: localizer(locale, "commands.tool.visualize.modal.backend_current_label"),
      value: "current_provider",
      description: localizer(locale, "commands.tool.visualize.modal.backend_current_description", {
        provider: providerName,
      }),
    },
    {
      label: localizer(locale, "commands.tool.visualize.modal.backend_novelai_label"),
      value: "novelai",
      description: localizer(locale, "commands.tool.visualize.modal.backend_novelai_description"),
    },
  ];
}

/**
 * Fetches persona summaries for the modal selector and context overrides.
 * Includes the fields needed to override buildContext() persona identity
 * (nickname, attributes, persona prompt, lineage ID) without loading a full TomoriState.
 * Returns main persona first (is_alter=false), then alters ordered by recency.
 * @param serverId - Numeric DB server ID from tomoriState
 */
async function loadServerPersonaSummaries(serverId: number): Promise<PersonaSummary[]> {
  return personaRepository.loadServerPersonaSummaries(serverId);
}

/**
 * Builds string-select options from persona summaries for the modal.
 * The active persona (matching activeTomoriId) is marked as default.
 * @param activeTomoriId - The currently active persona's persona_id
 */
function getPersonaSelectOptions(personas: PersonaSummary[], activeTomoriId: number) {
  return personas.map((p) => ({
    label: p.persona_nickname,
    value: p.persona_id.toString(),
    default: p.persona_id === activeTomoriId,
  }));
}

async function resolveSceneImageBackendAvailability(params: {
  provider: string;
  tomoriState: TomoriState;
  serverId: string;
}): Promise<SceneImageBackendAvailability> {
  const serverIdNumber = Number.parseInt(params.serverId, 10);
  const hasNovelAiOptKey = Number.isNaN(serverIdNumber) ? false : await hasOptApiKey(serverIdNumber, "novelai");
  const hasNaiImageSlot = Boolean(params.tomoriState.config.nai_diffusion_model_id);
  const novelAiAvailable =
    hasNaiImageSlot &&
    (hasNovelAiOptKey || (params.provider === "novelai" && Boolean(params.tomoriState.config.api_key)));
  const currentProviderAvailable =
    params.provider !== "novelai" && Boolean(params.tomoriState.config.diffusion_model_id);
  const defaultBackend = currentProviderAvailable ? "current_provider" : novelAiAvailable ? "novelai" : null;

  return {
    currentProvider: currentProviderAvailable,
    novelAi: novelAiAvailable,
    showBackendSelector: currentProviderAvailable && novelAiAvailable,
    defaultBackend,
  };
}

async function replyQuotaExceeded(
  replyTarget: ChatInputCommandInteraction | import("discord.js").ModalSubmitInteraction,
  locale: string,
  quotaCheck: ImageQuotaCheckResult,
): Promise<void> {
  const errorTitleKey = "commands.generate.image.quota_exceeded_title";
  let errorDescriptionKey = "commands.generate.image.quota_exceeded_description";
  const descriptionVars: Record<string, string> = {};

  if (quotaCheck.resetTime) {
    const now = new Date();
    const hoursUntilReset = Math.ceil((quotaCheck.resetTime.getTime() - now.getTime()) / (1000 * 60 * 60));

    if (hoursUntilReset < 24) {
      descriptionVars.reset_info = localizer(locale, "commands.generate.image.quota_resets_in_hours", {
        hours: hoursUntilReset.toString(),
      });
    } else {
      descriptionVars.reset_info = localizer(locale, "commands.generate.image.quota_resets_in_days", {
        days: Math.ceil(hoursUntilReset / 24).toString(),
      });
    }
  }

  if (quotaCheck.reason === "user_quota_exceeded") {
    errorDescriptionKey = "commands.generate.image.user_quota_exceeded_description";
  } else if (quotaCheck.reason === "serverwide_quota_exceeded") {
    errorDescriptionKey = "commands.generate.image.serverwide_quota_exceeded_description";
  }

  await replyInfoEmbed(replyTarget, locale, {
    titleKey: errorTitleKey,
    descriptionKey: errorDescriptionKey,
    descriptionVars,
    footerKey: "commands.generate.image.quota_exceeded_footer",
    color: ColorCode.ERROR,
    flags: MessageFlags.Ephemeral,
  });
}

/** Execute the contextual scene-image path exposed by `/generate image` Auto mode. */
export async function executeAutoImageCommand(
  client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.channel || !("messages" in interaction.channel)) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const isDMChannel = !interaction.guildId;
  const serverDiscId = interaction.guildId ?? interaction.user.id;

  if (!isDMChannel) {
    const botMember = interaction.guild?.members.me;
    if (!botMember) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.unknown_error_title",
        descriptionKey: "general.errors.unknown_error_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const guildChannel = interaction.guild?.channels.cache.get(interaction.channel.id) ?? interaction.channel;
    if (!("permissionsFor" in guildChannel)) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.unknown_error_title",
        descriptionKey: "general.errors.unknown_error_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const permissions = guildChannel.permissionsFor(botMember);
    const requiresThreadSendPermission =
      "isThread" in guildChannel && typeof guildChannel.isThread === "function" && guildChannel.isThread();
    const canSendMessages = requiresThreadSendPermission
      ? permissions?.has(PermissionFlagsBits.SendMessagesInThreads)
      : permissions?.has(PermissionFlagsBits.SendMessages);

    if (
      !permissions?.has(PermissionFlagsBits.ViewChannel) ||
      !permissions?.has(PermissionFlagsBits.ReadMessageHistory) ||
      !permissions?.has(PermissionFlagsBits.AttachFiles) ||
      !canSendMessages
    ) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.tool.visualize.missing_permissions_title",
        descriptionKey: "commands.tool.visualize.missing_permissions_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  const baseTomoriState = await personaRepository.loadState(serverDiscId);
  if (!baseTomoriState) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const { tomoriState } = await applyPersonalProviderSelectionsToTomoriState(baseTomoriState, userData.user_id ?? null);

  const personaSummaries = await loadServerPersonaSummaries(tomoriState.server_id);
  const invokingMember = interaction.member as import("discord.js").GuildMember | null;

  const cooldownType = tomoriState.config.cooldown_type ?? CooldownType.OFF;
  const cooldownLength = tomoriState.config.cooldown_length ?? 5;
  const cooldownResult = await cooldownRepository.checkMessageTriggerCooldownWithWhitelist(
    serverDiscId,
    interaction.user.id,
    interaction.channel.id,
    cooldownType,
    invokingMember,
  );

  if (cooldownResult.isOnCooldown) {
    if (cooldownResult.blockedByWhitelist) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.message_cooldown_title",
        descriptionKey: "commands.tool.visualize.channel_not_whitelisted",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const footerKey = cooldownRepository.getCooldownTypeFooterKey(cooldownResult.cooldownType);
    await sendCooldownDM(
      interaction.user,
      locale,
      "general.message_cooldown_title",
      "commands.tool.visualize.cooldown_active",
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

  const parentChannelId =
    !isDMChannel &&
    "isThread" in interaction.channel &&
    typeof (interaction.channel as unknown as { isThread: () => boolean; parent?: { id: string } }).isThread ===
      "function" &&
    (interaction.channel as unknown as { isThread: () => boolean; parent?: { id: string } }).isThread()
      ? (interaction.channel as unknown as { isThread: () => boolean; parent?: { id: string } }).parent?.id
      : undefined;
  const whitelistStatus = await getCachedWhitelistStatus(
    serverDiscId,
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
  const availablePersonaSummaries = filterPersonasForTrigger(
    personaSummaries,
    whitelistStatus,
    personalSpotlightStatus,
  );

  if (availablePersonaSummaries.length === 0) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.message_cooldown_title",
      descriptionKey: "commands.tool.visualize.persona_access_blocked",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const fallbackPersonaSummary = availablePersonaSummaries[0];

  if (!tomoriState.config.imagegen_enabled) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.generate.image.disabled_title",
      descriptionKey: "commands.generate.image.disabled_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // The hidden image agent requires function-calling support on the active model.
  //    Without tool support the model cannot call generate_image / generate_image_nai.
  if (!tomoriState.llm.has_tools) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.tool.visualize.planner_unavailable_title",
      descriptionKey: "commands.tool.visualize.planner_unavailable_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!tomoriState.config.api_key) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.generate.image.no_api_key_title",
      descriptionKey: "commands.generate.image.no_api_key_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const provider = tomoriState.llm.llm_provider.toLowerCase();
  const backendAvailability = await resolveSceneImageBackendAvailability({
    provider,
    tomoriState,
    serverId: serverDiscId,
  });
  if (!backendAvailability.defaultBackend) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.tool.visualize.no_backend_title",
      descriptionKey: "commands.tool.visualize.no_backend_description",
      descriptionVars: {
        current_provider: tomoriState.llm.llm_provider,
      },
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Quota check before showing the modal (avoids wasting user interaction).
  const quotaCheck = await checkImageQuota(tomoriState.server_id, interaction.user.id);
  if (!quotaCheck.allowed) {
    await replyQuotaExceeded(interaction, locale, quotaCheck);
    return;
  }

  // Show the modal (fire-and-forget UX; no public bot response until image posts).
  const defaultPersonaId = availablePersonaSummaries.some((persona) => persona.persona_id === tomoriState.persona_id)
    ? (tomoriState.persona_id ?? fallbackPersonaSummary?.persona_id ?? -1)
    : (fallbackPersonaSummary?.persona_id ?? -1);
  const modalResult = await promptWithRawModal(
    interaction,
    locale,
    {
      modalCustomId: MODAL_CUSTOM_ID,
      modalTitleKey: "commands.tool.visualize.modal.title",
      components: [
        {
          customId: PERSONA_INPUT_ID,
          labelKey: "commands.tool.visualize.modal.persona_label",
          descriptionKey: "commands.tool.visualize.modal.persona_description",
          required: true,
          options: getPersonaSelectOptions(availablePersonaSummaries, defaultPersonaId),
        },
        {
          customId: PROMPT_INPUT_ID,
          labelKey: "commands.tool.visualize.modal.prompt_label",
          descriptionKey: "commands.tool.visualize.modal.prompt_description",
          placeholder: localizer(locale, "commands.tool.visualize.modal.prompt_placeholder"),
          required: false,
          style: TextInputStyle.Paragraph,
          maxLength: 1000,
        },
        {
          kind: "radioGroup" as const,
          customId: SETTING_INPUT_ID,
          labelKey: "commands.tool.visualize.modal.setting_label",
          descriptionKey: "commands.tool.visualize.modal.setting_description",
          required: true,
          options: getSettingOptions(locale),
        },
        ...(backendAvailability.showBackendSelector
          ? [
              {
                kind: "radioGroup" as const,
                customId: BACKEND_INPUT_ID,
                labelKey: "commands.tool.visualize.modal.backend_label",
                descriptionKey: "commands.tool.visualize.modal.backend_description",
                required: true,
                options: getBackendOptions(locale, tomoriState.llm.llm_provider),
              },
            ]
          : []),
      ],
    },
    MessageFlags.Ephemeral,
  );

  if (modalResult.outcome !== "submit" || !modalResult.interaction) {
    return;
  }

  const modalSubmitInteraction = modalResult.interaction;

  try {
    const selectedSetting = (modalResult.values?.[SETTING_INPUT_ID] as SceneSettingId | undefined) ?? "storybeat";
    const settingPreset = SCENE_SETTING_PRESETS[selectedSetting] ?? SCENE_SETTING_PRESETS.storybeat;

    const selectedBackendValue = modalResult.values?.[BACKEND_INPUT_ID] as SceneImageBackend | undefined;
    const selectedBackend: SceneImageBackend | null =
      backendAvailability.showBackendSelector &&
      selectedBackendValue &&
      ((selectedBackendValue === "current_provider" && backendAvailability.currentProvider) ||
        (selectedBackendValue === "novelai" && backendAvailability.novelAi))
        ? selectedBackendValue
        : backendAvailability.defaultBackend;

    if (!selectedBackend) {
      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "commands.tool.visualize.no_backend_title",
        descriptionKey: "commands.tool.visualize.no_backend_description",
        descriptionVars: {
          current_provider: tomoriState.llm.llm_provider,
        },
        color: ColorCode.ERROR,
      });
      return;
    }

    const extraDirection = modalResult.values?.[PROMPT_INPUT_ID]?.trim();

    const selectedPersonaIdStr = modalResult.values?.[PERSONA_INPUT_ID];
    const selectedPersonaId = selectedPersonaIdStr ? Number.parseInt(selectedPersonaIdStr, 10) : tomoriState.persona_id;
    const selectedPersona =
      availablePersonaSummaries.find((p) => p.persona_id === selectedPersonaId) ?? fallbackPersonaSummary;

    if (
      !selectedPersona ||
      !isPersonaAllowedForTrigger(whitelistStatus, personalSpotlightStatus, selectedPersona.persona_id)
    ) {
      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "general.message_cooldown_title",
        descriptionKey: "commands.tool.visualize.persona_access_blocked",
        color: ColorCode.WARN,
      });
      return;
    }

    let senderWebhook: import("discord.js").Webhook | undefined;
    let senderPersonaUsername: string | undefined;
    let senderPersonaAvatarUrl: string | undefined;

    if (selectedPersona) {
      senderPersonaUsername = selectedPersona.persona_nickname;

      // Attempt to get or create the channel webhook for persona-identity posting.
      // Threads and channels without ManageWebhooks permission fall back to a direct bot message.
      const webhookChannel = interaction.guild?.channels.cache.get(interaction.channel.id) ?? interaction.channel;

      if ("fetchWebhooks" in webhookChannel) {
        try {
          const webhookResult = await getOrCreateWebhook(webhookChannel as TextChannel | BaseGuildTextChannel);
          if (webhookResult.webhook) {
            senderWebhook = webhookResult.webhook;
            const identity = await resolvePersonaWebhookIdentity(
              selectedPersona as unknown as TomoriState,
              interaction.guild ?? null,
            );
            senderPersonaAvatarUrl = identity.avatarUrl ?? identity.avatarDataUri;
          }
        } catch (webhookError) {
          log.warn("[/generate image:auto] Failed to resolve persona webhook; image will post as bot", webhookError as Error);
        }
      }
    }

    log.info(
      `[/generate image:auto] Starting hidden image agent for channel ${interaction.channel.id} — backend=${selectedBackend}, preset=${settingPreset.plannerLabel}, sender=${selectedPersona?.persona_nickname ?? "active"}`,
    );

    // Invoke the hidden image agent turn.
    //     This replaces the old structured-output planner: the model now sees the
    //     full conversation context (persona prompt, users, memories, RAG docs, etc.)
    //     and is directed via a tail directive to call the appropriate image tool.
    // Pass a context override only when the selected persona differs from the active one,
    // so buildContext() prompts the model as the chosen sender persona.
    const contextPersonaOverride =
      selectedPersona && selectedPersona.persona_id !== tomoriState.persona_id
        ? {
            tomoriNickname: selectedPersona.persona_nickname,
            personaPrompt: selectedPersona.persona_prompt,
            tomoriAttributes: selectedPersona.attribute_list,
            personaLineageId: selectedPersona.persona_lineage_id,
          }
        : undefined;

    const agentResult = await runHiddenImageTurn({
      channel: interaction.channel as Parameters<typeof runHiddenImageTurn>[0]["channel"],
      client,
      guild: interaction.guild ?? null,
      tomoriState,
      locale,
      interactingUserId: interaction.user.id,
      internalUserId: userData.user_id ?? null,
      backend: selectedBackend,
      presetLabel: settingPreset.plannerLabel,
      presetInstruction: settingPreset.plannerInstruction,
      aspectRatio: settingPreset.aspectRatio,
      naiOrientation: settingPreset.novelAiOrientation,
      extraDirection,
      webhook: senderWebhook,
      personaUsername: senderPersonaUsername,
      personaAvatarUrl: senderPersonaAvatarUrl,
      contextPersonaOverride,
    });

    if (!agentResult.success) {
      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "commands.tool.visualize.planner_failed_title",
        descriptionKey: "commands.tool.visualize.planner_failed_description",
        descriptionVars: {
          error: agentResult.error ?? "Unknown image generation error",
        },
        color: ColorCode.ERROR,
      });
      return;
    }

    log.success(
      `[/generate image:auto] Hidden image agent completed for channel ${interaction.channel.id} — backend=${selectedBackend}`,
    );

    // Acknowledge the modal submit interaction with an ephemeral success notice.
    await replyInfoEmbed(modalSubmitInteraction, locale, {
      titleKey: "commands.tool.visualize.success_title",
      descriptionKey: "commands.tool.visualize.success_description",
      color: ColorCode.SUCCESS,
    });

    // Record the cooldown entry after confirmed success.
    await cooldownRepository.setMessageTriggerCooldownWithWhitelist(
      serverDiscId,
      interaction.user.id,
      interaction.channel.id,
      cooldownType,
      cooldownLength,
      invokingMember,
    );
  } catch (error) {
    log.error("Error in /generate image:auto", error as Error, {
      errorType: "GenerateImageAutoCommandError",
      metadata: {
        userId: interaction.user.id,
        guildId: interaction.guild?.id ?? "DM",
        channelId: interaction.channel.id,
      },
    });

    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    await replyInfoEmbed(modalSubmitInteraction, locale, {
      titleKey: "commands.generate.image.error_generation_failed_title",
      descriptionKey: "commands.generate.image.error_generation_failed_description",
      descriptionVars: { error: errorMessage },
      color: ColorCode.ERROR,
    });
  }
}
