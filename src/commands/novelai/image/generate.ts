import {
  AttachmentBuilder,
  EmbedBuilder,
  MessageFlags,
  TextInputStyle,
  type APIAttachment,
  type ChatInputCommandInteraction,
  type Client,
  type ModalSubmitInteraction,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import { getCachedTomoriState } from "@/utils/cache/tomoriStateCache";
import { applyPersonalProviderSelectionsToTomoriState } from "@/utils/provider/personalProviderRuntime";
import { decryptApiKey, getOptApiKey } from "@/utils/security/crypto";
import { ColorCode, log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";
import { promptWithRawModal } from "@/utils/discord/ui/modals";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import type { TomoriState, UserRow } from "@/types/db/schema";
import { checkImageQuota, incrementImageQuota } from "@/utils/quota/imageQuotaManager";
import { statRepository } from "@/utils/db/repositories";
import { resolveNaiImageParams } from "@/utils/image/naiImageParams";
import { resolveNaiDiffusionModel } from "@/utils/image/naiDiffusionModels";
import { normalizeNaiReferenceImage } from "@/utils/image/imageProcessor";
import { MEDIA_LIMITS } from "@/utils/security/rateLimiter";
import { safeDownload } from "@/utils/security/safeDownload";
import {
  NAI_CHAR_REF_INFO_EXTRACTED,
  NAI_CHAR_REF_STRENGTH,
  NAI_DEFAULT_NEGATIVE_PROMPT,
  classifyNaiImageError,
  generateNovelAiImage,
  usesNaiStructuredPromptFormat,
  type NaiGenerationCharacterPayload,
} from "@/utils/image/naiImageGeneration";

const MODAL_CUSTOM_ID = "novelai_image_generate_modal";
const PROMPT_INPUT_ID = "nai_image_prompt";
const NEGATIVE_TAGS_INPUT_ID = "nai_image_negative_tags";
const CHARACTER_REFERENCE_INPUT_ID = "nai_image_character_reference";
const ORIENTATION_SELECT_ID = "nai_image_orientation";

function splitTags(rawTags: string): string[] {
  return rawTags
    .split(/[,\u3001]/)
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

async function resolveNovelAiApiKey(tomoriState: TomoriState): Promise<string | null> {
  const optKey = await getOptApiKey(tomoriState.server_id, "novelai");
  if (optKey) {
    return optKey;
  }

  const encryptedApiKey = tomoriState.config.api_key;
  const keyVersion = tomoriState.config.key_version || 1;
  if (!encryptedApiKey) {
    return null;
  }

  return await decryptApiKey(encryptedApiKey, keyVersion);
}

async function prepareCharacterReferencePayload(attachment: APIAttachment): Promise<NaiGenerationCharacterPayload> {
  if (!attachment.content_type?.startsWith("image/")) {
    throw new Error("Invalid character reference image type");
  }

  const downloadResult = await safeDownload(attachment.url, {
    maxSizeMB: MEDIA_LIMITS.MAX_MEDIA_SIZE_MB,
    timeoutMs: 10_000,
    knownSize: attachment.size,
  });
  if (!downloadResult.success || !downloadResult.buffer) {
    throw new Error(
      `Failed to fetch character reference image: ${downloadResult.details ?? downloadResult.error ?? "unknown error"}`,
    );
  }

  const normalizedBuffer = await normalizeNaiReferenceImage(downloadResult.buffer);

  return {
    useCoords: false,
    referenceImages: [normalizedBuffer.toString("base64")],
    referenceStrengths: [NAI_CHAR_REF_STRENGTH],
    referenceInfoExtracted: [NAI_CHAR_REF_INFO_EXTRACTED],
  };
}

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("generate").setDescription(localizer("en-US", "commands.novelai.image.generate.description"));

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

  const serverId = interaction.guild?.id ?? interaction.user.id;
  let modalSubmitInteraction: ModalSubmitInteraction | undefined;
  let tomoriState: TomoriState | null = null;
  let resolvedModel: Awaited<ReturnType<typeof resolveNaiDiffusionModel>> | null = null;

  try {
    tomoriState = await getCachedTomoriState(serverId);
    if (!tomoriState) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Overlay the invoking user's personal (BYOK) provider selections so their
    // personal NovelAI model/key is used when configured, mirroring /generate image.
    const overlay = await applyPersonalProviderSelectionsToTomoriState(tomoriState, userData.user_id ?? null);
    tomoriState = overlay.tomoriState;
    const { activeConfigs } = overlay;

    if (!tomoriState.config.imagegen_enabled) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.generate.image.disabled_title",
        descriptionKey: "commands.generate.image.disabled_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    resolvedModel = await resolveNaiDiffusionModel(tomoriState.config);
    if (!resolvedModel) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.novelai.image.generate.no_model_title",
        descriptionKey: "commands.novelai.image.generate.no_model_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const apiKey = await resolveNovelAiApiKey(tomoriState);
    if (!apiKey) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.novelai.image.generate.no_api_key_title",
        descriptionKey: "commands.novelai.image.generate.no_api_key_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const effectiveImageParams = resolveNaiImageParams(tomoriState.config);

    // Personal-provider users (activeConfigs.image set) bypass quota enforcement
    if (!activeConfigs.image) {
      const quotaCheck = await checkImageQuota(tomoriState.server_id, interaction.user.id);
      if (!quotaCheck.allowed) {
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

        await replyInfoEmbed(interaction, locale, {
          titleKey: errorTitleKey,
          descriptionKey: errorDescriptionKey,
          descriptionVars,
          footerKey: "commands.generate.image.quota_exceeded_footer",
          color: ColorCode.ERROR,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    const modalResult = await promptWithRawModal(
      interaction,
      locale,
      {
        modalCustomId: MODAL_CUSTOM_ID,
        modalTitleKey: "commands.novelai.image.generate.modal_title",
        components: [
          {
            customId: PROMPT_INPUT_ID,
            labelKey: "commands.novelai.image.generate.prompt_label",
            descriptionKey: "commands.novelai.image.generate.prompt_modal_description",
            placeholder: "commands.novelai.image.generate.prompt_placeholder",
            required: true,
            style: TextInputStyle.Paragraph,
            maxLength: 2000,
          },
          {
            customId: NEGATIVE_TAGS_INPUT_ID,
            labelKey: "commands.novelai.image.generate.negative_tags_label",
            descriptionKey: "commands.novelai.image.generate.negative_tags_modal_description",
            placeholder: "commands.novelai.image.generate.negative_tags_placeholder",
            required: false,
            style: TextInputStyle.Paragraph,
            maxLength: 1000,
          },
          {
            customId: CHARACTER_REFERENCE_INPUT_ID,
            labelKey: "commands.novelai.image.generate.character_reference_label",
            descriptionKey: "commands.novelai.image.generate.character_reference_modal_description",
            minValues: 0,
            maxValues: 1,
            required: false,
          },
          {
            kind: "radioGroup" as const,
            customId: ORIENTATION_SELECT_ID,
            labelKey: "commands.novelai.image.generate.orientation_label",
            descriptionKey: "commands.novelai.image.generate.orientation_modal_description",
            required: true,
            options: [
              {
                label: localizer(locale, "commands.novelai.image.generate.orientation_choice_portrait"),
                value: "portrait",
              },
              {
                label: localizer(locale, "commands.novelai.image.generate.orientation_choice_landscape"),
                value: "landscape",
              },
              {
                label: localizer(locale, "commands.novelai.image.generate.orientation_choice_square"),
                value: "square",
              },
            ],
          },
        ],
      },
      true,
    );

    if (modalResult.outcome !== "submit") {
      return;
    }

    modalSubmitInteraction = modalResult.interaction;
    const prompt = modalResult.values?.[PROMPT_INPUT_ID]?.trim();
    const negativeTagsInput = modalResult.values?.[NEGATIVE_TAGS_INPUT_ID]?.trim() ?? "";
    const orientation = modalResult.values?.[ORIENTATION_SELECT_ID];
    const characterReference = modalResult.attachments?.[CHARACTER_REFERENCE_INPUT_ID];

    if (!modalSubmitInteraction || !prompt || !orientation) {
      log.error("NovelAI image generate modal missing required values");
      return;
    }

    if (characterReference && !usesNaiStructuredPromptFormat(resolvedModel.codename)) {
      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "commands.novelai.image.generate.character_reference_requires_v4_title",
        descriptionKey: "commands.novelai.image.generate.character_reference_requires_v4_description",
        descriptionVars: {
          model: resolvedModel.codename,
        },
        color: ColorCode.ERROR,
      });
      return;
    }

    const negativePromptParts =
      (tomoriState.config.image_default_negative_tags?.length ?? 0) > 0
        ? [...(tomoriState.config.image_default_negative_tags ?? [])]
        : [NAI_DEFAULT_NEGATIVE_PROMPT];
    const userNegativeTags = splitTags(negativeTagsInput);
    negativePromptParts.push(...userNegativeTags);
    const effectiveNegativePrompt = negativePromptParts.join(", ");
    const positivePromptParts = [...(tomoriState.config.image_default_positive_tags ?? []), ...splitTags(prompt)];
    const effectivePrompt = positivePromptParts.join(", ");

    let characterPayload: NaiGenerationCharacterPayload | undefined;
    if (characterReference) {
      try {
        characterPayload = await prepareCharacterReferencePayload(characterReference);
      } catch (error) {
        await replyInfoEmbed(modalSubmitInteraction, locale, {
          titleKey: "commands.novelai.image.generate.invalid_reference_title",
          descriptionKey: "commands.novelai.image.generate.invalid_reference_description",
          color: ColorCode.ERROR,
        });
        log.warn("[NAI] Invalid character reference attachment for slash command", error as Error);
        return;
      }
    }

    const startTime = performance.now();

    log.info(
      `[NAI] Slash command generation with model "${resolvedModel.codename}" (orientation: ${orientation}, hasRef: ${characterPayload?.referenceImages?.length ?? 0})`,
    );

    const imageBuffer = await generateNovelAiImage({
      apiKey,
      model: resolvedModel.codename,
      prompt: effectivePrompt,
      negativePrompt: effectiveNegativePrompt,
      orientation,
      imageParams: effectiveImageParams,
      characterPayload,
    });

    const generationTimeSeconds = ((performance.now() - startTime) / 1000).toFixed(1);
    if (!activeConfigs.image) {
      await incrementImageQuota(tomoriState.server_id, interaction.user.id);
    }
    // Record canonical generation telemetry; quota tables enforce limits only.
    if (userData.user_id) {
      statRepository.recordStat({
        serverId: tomoriState.server_id,
        userId: userData.user_id,
        lineageId: tomoriState.persona_lineage_id ?? 0,
        metric: "image_generated",
        metricKey: resolvedModel.codename,
      });
    }

    const filename = `nai_generated_${Date.now()}.png`;
    const attachment = new AttachmentBuilder(imageBuffer, {
      name: filename,
    });

    const successEmbed = new EmbedBuilder()
      .setTitle(localizer(locale, "commands.novelai.image.generate.success_title"))
      .setColor(ColorCode.SUCCESS)
      .setImage(`attachment://${filename}`)
      .addFields([
        {
          name: localizer(locale, "commands.novelai.image.generate.field_prompt"),
          value: prompt.substring(0, 1024),
          inline: false,
        },
        {
          name: localizer(locale, "commands.novelai.image.generate.field_model"),
          value: resolvedModel.codename,
          inline: true,
        },
        {
          name: localizer(locale, "commands.novelai.image.generate.field_generation_time"),
          value: `${generationTimeSeconds}s`,
          inline: true,
        },
        {
          name: localizer(locale, "commands.novelai.image.generate.field_orientation"),
          value: orientation,
          inline: true,
        },
      ]);

    if (negativeTagsInput) {
      successEmbed.addFields([
        {
          name: localizer(locale, "commands.novelai.image.generate.field_negative_tags"),
          value: negativeTagsInput.substring(0, 1024),
          inline: false,
        },
      ]);
    }

    if (characterReference?.url) {
      successEmbed.setThumbnail(characterReference.url);
    }

    await modalSubmitInteraction.editReply({
      embeds: [successEmbed],
      files: [attachment],
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorKind = classifyNaiImageError(error);
    await log.error("Error in /novelai image generate command", error, {
      errorType: "CommandExecutionError",
      metadata: {
        command: "novelai image generate",
        guildId: interaction.guild?.id ?? null,
        userDiscId: interaction.user.id,
        model: resolvedModel?.codename ?? null,
      },
    });

    const replyTarget = modalSubmitInteraction ?? interaction;

    if (errorKind === "quota") {
      await replyInfoEmbed(replyTarget, locale, {
        titleKey: "commands.novelai.image.generate.quota_error_title",
        descriptionKey: "commands.novelai.image.generate.quota_error_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    if (errorKind === "auth") {
      await replyInfoEmbed(replyTarget, locale, {
        titleKey: "commands.novelai.image.generate.auth_error_title",
        descriptionKey: "commands.novelai.image.generate.auth_error_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    if (errorKind === "rate_limit") {
      await replyInfoEmbed(replyTarget, locale, {
        titleKey: "commands.novelai.image.generate.rate_limit_error_title",
        descriptionKey: "commands.novelai.image.generate.rate_limit_error_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    await replyInfoEmbed(replyTarget, locale, {
      titleKey: "commands.novelai.image.generate.error_title",
      descriptionKey: "commands.novelai.image.generate.error_description",
      descriptionVars: {
        error: errorMessage,
      },
      color: ColorCode.ERROR,
    });
  }
}
