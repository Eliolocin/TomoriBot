import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { MessageFlags } from "discord.js";
import type { CustomEndpointApiStyle, CustomEndpointCapability, ErrorContext, UserRow } from "@/types/db/schema";
import { getCachedTomoriState } from "@/utils/cache/tomoriStateCache";
import { llmProviderRepo } from "@/utils/db/repositories";
import { promptWithRawModal } from "@/utils/discord/ui/modals";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { log, ColorCode } from "@/utils/misc/logger";
import { validateRemoteUrl } from "@/utils/security/remoteUrlSecurity";
import {
  buildCapabilityAddModalComponents,
  buildImageVideoAddModalComponents,
  capabilityNeedsAddModal,
  ModalFieldId,
  parseCapabilityModalFields,
  WORKFLOW_UPLOAD_ID,
} from "@/utils/provider/customEndpointCapabilityModal";
import { registerCustomEndpoint, validateCustomEndpointReachability } from "@/utils/provider/customEndpointService";
import {
  IMAGE_ENDPOINT_SUPPORTS_ID,
  imageEndpointSupportsFromSubmittedValues,
} from "@/utils/provider/customImageEndpointSupport";
import { isValidCustomEndpointLabel, normalizeCustomEndpointLabel } from "@/utils/provider/customProviderUtils";
import { IMPORT_LIMITS } from "@/utils/security/rateLimiter";
import { safeDownload } from "@/utils/security/safeDownload";
import { localizer } from "@/utils/text/localizer";

/** Download and parse a workflow JSON from a URL returned by Discord's CDN. */
async function loadWorkflowJson(url: string | null): Promise<Record<string, unknown> | null> {
  if (!url) {
    return null;
  }

  const downloadResult = await safeDownload(url, {
    maxSizeMB: IMPORT_LIMITS.MAX_DATA_IMPORT_SIZE_MB,
    timeoutMs: 10_000,
  });
  if (!downloadResult.success || !downloadResult.buffer) {
    throw new Error(`Workflow download failed: ${downloadResult.details ?? downloadResult.error ?? "unknown error"}`);
  }

  return JSON.parse(downloadResult.buffer.toString("utf8")) as Record<string, unknown>;
}

/**
 * Phase 4.5 (updated): slim routing fields only.
 * Capability-specific advanced fields are collected via a follow-up modal.
 * workflow_json is collected in the image/video capability modal (file upload component).
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("add")
    .setDescription(localizer("en-US", "commands.config.custom_models.add.description"))
    .addStringOption((option) =>
      option
        .setName("endpoint_label")
        .setDescription(localizer("en-US", "commands.config.custom_models.add.label_description"))
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("capability")
        .setDescription(localizer("en-US", "commands.config.custom_models.add.capability_description"))
        .setRequired(true)
        .addChoices(
          { name: "Text", value: "text" },
          { name: "Embedding", value: "embedding" },
          { name: "Image", value: "image" },
          { name: "Video", value: "video" },
          { name: "Speech (TTS)", value: "speech" },
          { name: "Transcription (STT)", value: "transcription" },
        ),
    )
    .addStringOption((option) =>
      option
        .setName("api_style")
        .setDescription(localizer("en-US", "commands.config.custom_models.add.api_style_description"))
        // Optional: when adding another model to an existing label+capability, the sibling's api_style
        // is inherited. Required only for a brand-new label+capability.
        .setRequired(false)
        .addChoices(
          { name: localizer("en-US", "general.api_styles.openai_compatible"), value: "openai-compatible" },
          { name: localizer("en-US", "general.api_styles.comfyui"), value: "comfyui" },
          { name: localizer("en-US", "general.api_styles.ollama_native"), value: "ollama-native" },
          { name: localizer("en-US", "general.api_styles.tts_clone"), value: "tts-clone" },
          {
            name: localizer("en-US", "general.api_styles.openai_compatible_transcription"),
            value: "openai-compatible-transcription",
          },
        ),
    )
    .addStringOption((option) =>
      option
        .setName("endpoint_url")
        .setDescription(localizer("en-US", "commands.config.custom_models.add.endpoint_url_description"))
        // Optional: inherited from an existing sibling under the same label+capability when omitted.
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName("auth_token")
        .setDescription(localizer("en-US", "commands.config.custom_models.add.auth_token_description"))
        .setRequired(false),
    );

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.channel) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.channel_only_title",
      descriptionKey: "general.errors.channel_only_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Cache-backed; completes well within Discord's 3s window before showModal.
  const tomoriState = await getCachedTomoriState(interaction.guild?.id ?? interaction.user.id);
  if (!tomoriState) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.tomori_not_setup_title",
      descriptionKey: "general.errors.tomori_not_setup_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Parse routing fields from the slim slash command. api_style and endpoint_url are optional: when
  // adding another model to an existing label+capability they are inherited from the sibling row.
  const rawLabel = interaction.options.getString("endpoint_label", true);
  const label = normalizeCustomEndpointLabel(rawLabel);
  const capability = interaction.options.getString("capability", true) as CustomEndpointCapability;
  const apiStyleOption = interaction.options.getString("api_style") as CustomEndpointApiStyle | null;
  const endpointUrlOption = interaction.options.getString("endpoint_url")?.trim() || null;
  const authToken = interaction.options.getString("auth_token");

  // Sync validations before the interaction response (no async budget consumed).
  if (!isValidCustomEndpointLabel(label)) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.invalid_option_title",
      descriptionKey: "commands.config.custom_models.validation.invalid_label",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Inherit connection details from an existing model under this label+capability ("one connection
  // per label"). A sibling also makes model_name mandatory so the new model is distinguishable.
  const siblingEndpoint = await llmProviderRepo.loadCustomEndpoint({
    serverId: tomoriState.server_id,
    label,
    capability,
  });
  const hasSibling = siblingEndpoint != null;
  const apiStyle = apiStyleOption ?? (siblingEndpoint?.api_style as CustomEndpointApiStyle | undefined) ?? null;
  const endpointUrl = endpointUrlOption ?? siblingEndpoint?.endpoint_url ?? null;

  if (!apiStyle) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.invalid_option_title",
      descriptionKey: "commands.config.custom_models.validation.api_style_required",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!endpointUrl) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.invalid_option_title",
      descriptionKey: "commands.config.custom_models.validation.endpoint_url_required",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const urlValidation = await validateRemoteUrl(endpointUrl);
  if (!urlValidation.valid) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.custom_endpoint_unreachable_title",
      descriptionKey: "commands.config.custom_models.validation.unreachable",
      descriptionVars: { reason: urlValidation.failureCode ?? "invalid_url" },
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Unique modal ID per invocation prevents stale awaitModalSubmit collisions.
  const modalCustomId = `custom_endpoint_add_modal_${interaction.id}`;

  if (capabilityNeedsAddModal(capability)) {
    const modalResult = await promptWithRawModal(interaction, locale, {
      modalCustomId,
      modalTitleKey: `commands.config.custom_models.capability_modal.${capability}_title`,
      components: buildCapabilityAddModalComponents(capability, locale),
    });

    if (modalResult.outcome !== "submit") return;

    // biome-ignore lint/style/noNonNullAssertion: submit outcome guarantees interaction exists
    const modalSubmit = modalResult.interaction!;
    await modalSubmit.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const parsed = parseCapabilityModalFields(modalResult.values ?? {}, modalResult.multiValues ?? {}, capability);

      if ((capability === "text" || capability === "embedding") && !parsed.modelName) {
        await replyInfoEmbed(modalSubmit, locale, {
          titleKey: "general.errors.invalid_option_title",
          descriptionKey: "commands.config.custom_models.validation.model_name_required",
          color: ColorCode.ERROR,
        });
        return;
      }

      if (capability === "transcription" && !parsed.transcriptionModel) {
        await replyInfoEmbed(modalSubmit, locale, {
          titleKey: "general.errors.invalid_option_title",
          descriptionKey: "commands.config.custom_models.validation.transcription_model_required",
          color: ColorCode.ERROR,
        });
        return;
      }

      const reachability = await validateCustomEndpointReachability({ apiStyle, endpointUrl, apiKey: authToken });
      if (!reachability.ok) {
        await replyInfoEmbed(modalSubmit, locale, {
          titleKey: "general.errors.custom_endpoint_unreachable_title",
          descriptionKey: "commands.config.custom_models.validation.unreachable",
          descriptionVars: { reason: reachability.reason },
          color: ColorCode.ERROR,
        });
        return;
      }

      const displayName = parsed.modelName || label;

      let extraConfig: Record<string, unknown> = {};
      if (capability === "speech") {
        extraConfig = {
          voice_mode: parsed.voiceMode,
          script_markup: parsed.scriptMarkup,
          supports_instruct: parsed.supportsInstruct,
        };
      } else if (capability === "transcription") {
        extraConfig = { model: parsed.transcriptionModel ?? "whisper-1", language: parsed.transcriptionLanguage };
      }

      const registered = await registerCustomEndpoint({
        scope: {
          kind: "server",
          ownerId: tomoriState.server_id,
          baseConfig: tomoriState.config,
          serverDiscId: interaction.guild?.id ?? interaction.user.id,
        },
        label,
        capability,
        apiStyle,
        endpointUrl,
        modelName: parsed.modelName,
        authToken,
        numCtx: parsed.numCtx,
        hasTools: parsed.hasTools,
        seesImages: parsed.seesImages,
        supportsStructOutput: parsed.supportsStructOutput,
        strictRoleAlternation: parsed.strictRoleAlternation,
        supportsPrefixCompletion: parsed.supportsPrefixCompletion,
        extraConfig,
      });

      if (!registered) {
        await replyInfoEmbed(modalSubmit, locale, {
          titleKey: "general.errors.update_failed_title",
          descriptionKey: "general.errors.update_failed_description",
          color: ColorCode.ERROR,
        });
        return;
      }

      const isTtsCloneSpeech = capability === "speech" && apiStyle === "tts-clone";
      const isVoiceDesignSpeech = isTtsCloneSpeech && parsed.voiceMode === "voice-design";
      const isAutoSpeech = isTtsCloneSpeech && parsed.voiceMode === "auto";
      await replyInfoEmbed(modalSubmit, locale, {
        titleKey: "commands.config.custom_models.add.success_title",
        descriptionKey: isAutoSpeech
          ? "commands.config.custom_models.add.speech_auto_next_steps_description"
          : isVoiceDesignSpeech
            ? "commands.config.custom_models.add.speech_voice_design_next_steps_description"
            : isTtsCloneSpeech
              ? "commands.config.custom_models.add.speech_next_steps_description"
              : "commands.config.custom_models.add.success_description",
        descriptionVars: { display_name: displayName, label, capability },
        color: ColorCode.SUCCESS,
      });
    } catch (error) {
      const context: ErrorContext = {
        userId: userData.user_id,
        serverId: tomoriState.server_id,
        personaId: tomoriState.persona_id,
        errorType: "CommandExecutionError",
        metadata: {
          command: "provider custom-endpoint add",
          guildId: interaction.guild?.id,
          executorDiscordId: interaction.user.id,
        },
      };
      await log.error("Error executing /provider custom-endpoint add (modal path)", error as Error, context);
      await replyInfoEmbed(modalSubmit, locale, {
        titleKey: "general.errors.unknown_error_title",
        descriptionKey: "general.errors.unknown_error_description",
        color: ColorCode.ERROR,
      });
    }
    return;
  }

  const imageVideoModalCustomId = `custom_endpoint_add_image_modal_${interaction.id}`;
  const modalResult = await promptWithRawModal(interaction, locale, {
    modalCustomId: imageVideoModalCustomId,
    modalTitleKey: `commands.config.custom_models.capability_modal.${capability}_title`,
    components: buildImageVideoAddModalComponents(capability as "image" | "video", locale, apiStyle),
  });

  if (modalResult.outcome !== "submit") {
    return;
  }

  // biome-ignore lint/style/noNonNullAssertion: submit outcome guarantees interaction exists
  const modalSubmit = modalResult.interaction!;

  try {
    await modalSubmit.deferReply({ flags: MessageFlags.Ephemeral });

    const modelName = modalResult.values?.[ModalFieldId.model_name]?.trim() || null;
    if (!modelName) {
      await replyInfoEmbed(modalSubmit, locale, {
        titleKey: "general.errors.invalid_option_title",
        descriptionKey: "commands.config.custom_models.validation.model_name_required",
        color: ColorCode.ERROR,
      });
      return;
    }

    const displayName = modelName || label;
    const workflowAttachment = modalResult.attachments?.[WORKFLOW_UPLOAD_ID];
    const workflowSupportValues = modalResult.multiValues?.[IMAGE_ENDPOINT_SUPPORTS_ID];

    // A second model under an existing label+capability needs a distinct model name to identify it.
    if (hasSibling && !modelName) {
      await replyInfoEmbed(modalSubmit, locale, {
        titleKey: "general.errors.invalid_option_title",
        descriptionKey: "commands.config.custom_models.validation.model_name_required_sibling",
        color: ColorCode.ERROR,
      });
      return;
    }

    if ((capability === "image" || capability === "video") && apiStyle === "comfyui" && !workflowAttachment) {
      await replyInfoEmbed(modalSubmit, locale, {
        titleKey: "general.errors.invalid_option_title",
        descriptionKey: "commands.config.custom_models.validation.workflow_required",
        color: ColorCode.ERROR,
      });
      return;
    }

    const reachability = await validateCustomEndpointReachability({ apiStyle, endpointUrl, apiKey: authToken });
    if (!reachability.ok) {
      await replyInfoEmbed(modalSubmit, locale, {
        titleKey: "general.errors.custom_endpoint_unreachable_title",
        descriptionKey: "commands.config.custom_models.validation.unreachable",
        descriptionVars: { reason: reachability.reason },
        color: ColorCode.ERROR,
      });
      return;
    }

    const workflow = workflowAttachment ? await loadWorkflowJson(workflowAttachment.url) : null;
    const workflowSupports =
      capability === "image" ? imageEndpointSupportsFromSubmittedValues(workflowSupportValues, apiStyle) : undefined;

    const registered = await registerCustomEndpoint({
      scope: {
        kind: "server",
        ownerId: tomoriState.server_id,
        baseConfig: tomoriState.config,
        serverDiscId: interaction.guild?.id ?? interaction.user.id,
      },
      label,
      capability,
      apiStyle,
      endpointUrl,
      modelName,
      authToken,
      extraConfig: {
        ...(workflow ? { workflow } : {}),
        ...(workflowSupports ? { workflow_supports: workflowSupports } : {}),
      },
    });

    if (!registered) {
      await replyInfoEmbed(modalSubmit, locale, {
        titleKey: "general.errors.update_failed_title",
        descriptionKey: "general.errors.update_failed_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    await replyInfoEmbed(modalSubmit, locale, {
      titleKey: "commands.config.custom_models.add.success_title",
      descriptionKey: "commands.config.custom_models.add.success_description",
      descriptionVars: { display_name: displayName, label, capability },
      color: ColorCode.SUCCESS,
    });
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: tomoriState.server_id,
      personaId: tomoriState.persona_id,
      errorType: "CommandExecutionError",
      metadata: {
        command: "provider custom-endpoint add",
        guildId: interaction.guild?.id,
        executorDiscordId: interaction.user.id,
      },
    };
    await log.error("Error executing /provider custom-endpoint add (image/video path)", error as Error, context);
    await replyInfoEmbed(modalSubmit, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
    });
  }
}
