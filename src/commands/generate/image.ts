/**
 * Image Generation Command
 * Allows users to generate AI images using the configured provider
 * Supports text-to-image and image-to-image generation with up to 3 reference images
 * (Discord modal limit: 5 components total)
 */

import {
  MessageFlags,
  TextInputStyle,
  EmbedBuilder,
  AttachmentBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type SlashCommandSubcommandBuilder,
  type APIAttachment,
} from "discord.js";
import { GoogleGenAI } from "@google/genai";
import { log, ColorCode } from "../../utils/misc/logger";
import { localizer } from "../../utils/text/localizer";
import { personaRepository, llmModelRepo, statRepository } from "@/utils/db/repositories";
import { replyInfoEmbed, promptWithRawModal } from "../../utils/discord/interactionHelper";
import type { UserRow } from "../../types/db/schema";
import { checkImageQuota, incrementImageQuota } from "../../utils/quota/imageQuotaManager";
import { resolveProviderFeatureImplementation } from "@/utils/provider/providerInfoRegistry";
import { resolveNativeImageGenerationCapability } from "@/utils/provider/providerCapabilityResolver";
import { ZAI_CODING_IMAGES_GENERATIONS_URL, ZAI_GENERAL_IMAGES_GENERATIONS_URL } from "@/providers/zai/zaiShared";
import { generateCustomImageViaEndpoint } from "@/providers/custom/customEndpointDispatcher";
import {
  CredentialUnavailableError,
  PersonalProviderRequiredError,
  getResolvedCapabilityModelId,
  resolveCapabilityCredentials,
} from "@/utils/provider/credentialResolver";
import { applyPersonalProviderSelectionsToTomoriState } from "@/utils/provider/personalProviderRuntime";
import { formatCustomEndpointModelDisplay } from "@/utils/provider/customProviderUtils";
import { generateOpenRouterImage } from "@/providers/openrouter/openrouterImageGeneration";
import { MEDIA_LIMITS } from "@/utils/security/rateLimiter";
import { safeDownload } from "@/utils/security/safeDownload";

const MODAL_CUSTOM_ID = "generate_image_modal";
const PROMPT_INPUT_ID = "prompt_input";
const ASPECT_RATIO_SELECT_ID = "aspect_ratio_select";
const REFERENCE_IMAGE_INPUT_IDS = ["image_upload_1", "image_upload_2", "image_upload_3"] as const;

/**
 * Configure the subcommand
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("image").setDescription(localizer("en-US", "commands.generate.image.description"));

/**
 * @param diffusionModelId - Database ID of the diffusion model
 */
async function getDiffusionModelCodename(diffusionModelId: number): Promise<string> {
  const model = await llmModelRepo.loadDiffusionModelById(diffusionModelId);

  if (!model) {
    throw new Error(`Diffusion model not found: ${diffusionModelId}`);
  }

  return model.codename;
}

/**
 * Convert a Discord attachment to base64 format for image generation API
 * @returns Object with mimeType and base64 data
 */
async function convertAttachmentToBase64(attachment: APIAttachment): Promise<{ mimeType: string; data: string }> {
  if (!attachment.content_type?.startsWith("image/")) {
    throw new Error(`Invalid image type: ${attachment.content_type}`);
  }

  const downloadResult = await safeDownload(attachment.url, {
    maxSizeMB: MEDIA_LIMITS.MAX_MEDIA_SIZE_MB,
    timeoutMs: 10_000,
    knownSize: attachment.size,
  });
  if (!downloadResult.success || !downloadResult.buffer) {
    throw new Error(`Failed to fetch image: ${downloadResult.details ?? downloadResult.error ?? "unknown error"}`);
  }

  const base64Data = downloadResult.buffer.toString("base64");

  log.info(`Converted attachment ${attachment.id} (${attachment.filename}) to base64`);

  return {
    mimeType: attachment.content_type,
    data: base64Data,
  };
}

/**
 * Execute the image generation command
 */
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
  const baseTomoriState = await personaRepository.loadState(serverId);

  if (!baseTomoriState) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.tomori_not_setup_title",
      descriptionKey: "general.errors.tomori_not_setup_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { tomoriState } = await applyPersonalProviderSelectionsToTomoriState(baseTomoriState, userData.user_id ?? null);

  if (!tomoriState.config.imagegen_enabled) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.generate.image.disabled_title",
      descriptionKey: "commands.generate.image.disabled_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let imageCreds: Awaited<ReturnType<typeof resolveCapabilityCredentials>>;
  try {
    imageCreds = await resolveCapabilityCredentials(tomoriState.server_id, "image-standard", {
      userId: userData.user_id ?? null,
    });
  } catch (error) {
    if (error instanceof PersonalProviderRequiredError) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.personal_provider_required_title",
        descriptionKey: "general.errors.personal_provider_required_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (error instanceof CredentialUnavailableError) {
      if (error.source === "personal") {
        await replyInfoEmbed(interaction, locale, {
          titleKey: "general.errors.personal_provider_credentials_error_title",
          descriptionKey: "general.errors.personal_provider_credentials_error_description",
          color: ColorCode.ERROR,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (error.reason === "missing_model_id") {
        await replyInfoEmbed(interaction, locale, {
          titleKey: "commands.generate.image.no_diffusion_model_title",
          descriptionKey: "commands.generate.image.no_diffusion_model_description",
          color: ColorCode.ERROR,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.generate.image.no_api_key_title",
        descriptionKey: "commands.generate.image.no_api_key_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    throw error;
  }

  const diffusionModelId =
    getResolvedCapabilityModelId(imageCreds, "image-standard") ?? tomoriState.config.diffusion_model_id;
  if (!diffusionModelId) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.generate.image.no_diffusion_model_title",
      descriptionKey: "commands.generate.image.no_diffusion_model_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const apiKey = imageCreds.apiKey;
  const executionProvider = imageCreds.provider;

  // Check image generation quota BEFORE showing modal (personal-provider users bypass quota)
  if (imageCreds.source === "server") {
    const quotaCheck = await checkImageQuota(tomoriState.server_id, interaction.user.id);

    if (!quotaCheck.allowed) {
      const errorTitleKey = "commands.generate.image.quota_exceeded_title";
      let errorDescriptionKey = "commands.generate.image.quota_exceeded_description";
      const descriptionVars: Record<string, string> = {};

      if (quotaCheck.resetTime) {
        const now = new Date();
        const resetTime = quotaCheck.resetTime;
        const hoursUntilReset = Math.ceil((resetTime.getTime() - now.getTime()) / (1000 * 60 * 60));

        if (hoursUntilReset < 24) {
          descriptionVars.reset_info = localizer(locale, "commands.generate.image.quota_resets_in_hours", {
            hours: hoursUntilReset.toString(),
          });
        } else {
          const daysUntilReset = Math.ceil(hoursUntilReset / 24);
          descriptionVars.reset_info = localizer(locale, "commands.generate.image.quota_resets_in_days", {
            days: daysUntilReset.toString(),
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

  // Track modal submit interaction for error handling in catch block
  let modalSubmitInteraction: import("discord.js").ModalSubmitInteraction | undefined;

  try {
    const modalComponents = [
      {
        customId: PROMPT_INPUT_ID,
        labelKey: "commands.generate.image.modal.prompt_label",
        descriptionKey: "commands.generate.image.modal.prompt_description",
        placeholder: "commands.generate.image.modal.prompt_placeholder",
        required: true,
        style: TextInputStyle.Paragraph,
        maxLength: 2000,
      },
      {
        customId: REFERENCE_IMAGE_INPUT_IDS[0],
        labelKey: "commands.generate.image.modal.image_upload_label",
        descriptionKey: "commands.generate.image.modal.image_upload_description",
        minValues: 0,
        maxValues: 1,
        required: false,
      },
      {
        customId: REFERENCE_IMAGE_INPUT_IDS[1],
        labelKey: "commands.generate.image.modal.image_upload_2_label",
        descriptionKey: "commands.generate.image.modal.image_upload_description",
        minValues: 0,
        maxValues: 1,
        required: false,
      },
      {
        customId: REFERENCE_IMAGE_INPUT_IDS[2],
        labelKey: "commands.generate.image.modal.image_upload_3_label",
        descriptionKey: "commands.generate.image.modal.image_upload_description",
        minValues: 0,
        maxValues: 1,
        required: false,
      },
      {
        kind: "radioGroup" as const,
        customId: ASPECT_RATIO_SELECT_ID,
        labelKey: "commands.generate.image.modal.aspect_ratio_label",
        descriptionKey: "commands.generate.image.modal.aspect_ratio_description",
        required: true,
        options: [
          { label: "1:1 (Square)", value: "1:1" },
          { label: "2:3 (Portrait)", value: "2:3" },
          { label: "3:2 (Landscape)", value: "3:2" },
          { label: "3:4 (Portrait)", value: "3:4" },
          { label: "4:3 (Landscape)", value: "4:3" },
          { label: "4:5 (Portrait)", value: "4:5" },
          { label: "5:4 (Landscape)", value: "5:4" },
          { label: "9:16 (Mobile Portrait)", value: "9:16" },
          { label: "16:9 (Widescreen)", value: "16:9" },
          { label: "21:9 (Ultra-wide)", value: "21:9" },
        ],
      },
    ];

    const modalResult = await promptWithRawModal(
      interaction,
      locale,
      {
        modalCustomId: MODAL_CUSTOM_ID,
        modalTitleKey: "commands.generate.image.modal.title",
        components: modalComponents,
      },
      true, // Auto-defer with public reply
    );

    if (modalResult.outcome !== "submit") {
      log.info(`Generate image modal ${modalResult.outcome}`);
      return;
    }

    modalSubmitInteraction = modalResult.interaction;
    const prompt = modalResult.values?.[PROMPT_INPUT_ID];
    const aspectRatio = modalResult.values?.[ASPECT_RATIO_SELECT_ID];
    const imageAttachments = REFERENCE_IMAGE_INPUT_IDS.map((customId) => modalResult.attachments?.[customId]).filter(
      (attachment): attachment is APIAttachment => Boolean(attachment),
    );

    if (!modalSubmitInteraction || !prompt || !aspectRatio) {
      log.error("Modal result unexpectedly missing required values");
      return;
    }

    const referenceImages: Array<{ mimeType: string; data: string }> = [];
    let referenceImageUrl: string | undefined;

    for (const imageAttachment of imageAttachments) {
      try {
        log.info(`Processing uploaded reference image: ${imageAttachment.filename}`);
        const converted = await convertAttachmentToBase64(imageAttachment);
        referenceImages.push(converted);
        if (!referenceImageUrl) {
          referenceImageUrl = imageAttachment.url; // Use first reference for thumbnail
        }
      } catch (error) {
        log.warn(`Failed to process attachment ${imageAttachment.id}:`, error as Error);

        await modalSubmitInteraction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle(localizer(locale, "commands.generate.image.invalid_image_title"))
              .setDescription(localizer(locale, "commands.generate.image.invalid_image_description"))
              .setColor(ColorCode.ERROR),
          ],
        });
        return;
      }
    }

    if (referenceImages.length > 0) {
      log.info(`Successfully processed ${referenceImages.length} reference image(s)`);
    }

    const modelCodename = await getDiffusionModelCodename(diffusionModelId);
    const displayModelName = imageCreds.customEndpoint
      ? formatCustomEndpointModelDisplay(imageCreds.customEndpoint)
      : modelCodename;

    log.info(
      `Generating image with ${executionProvider} via ${displayModelName}: "${prompt.substring(0, 100)}${prompt.length > 100 ? "..." : ""}" (aspect ratio: ${aspectRatio}, references: ${referenceImages.length})`,
    );

    const startTime = performance.now();

    let generatedImageData: string | null = null;
    let generatedImageMimeType: string | null = null;
    const imageGenerationImplementation = resolveProviderFeatureImplementation(executionProvider, "imageGeneration");
    const nativeImageProvider =
      executionProvider === "vertex" || executionProvider === "vertexexpress"
        ? await resolveNativeImageGenerationCapability(executionProvider)
        : null;

    if (imageCreds.customEndpoint) {
      const result = await generateCustomImageViaEndpoint({
        endpoint: imageCreds.customEndpoint,
        apiKey,
        prompt,
        aspectRatio,
        referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
      });
      generatedImageData = result.imageData;
      generatedImageMimeType = result.mimeType;
    } else if (nativeImageProvider) {
      const result = await nativeImageProvider.generateNativeImage({
        apiKey,
        model: modelCodename,
        prompt,
        aspectRatio,
        ...(referenceImages.length > 0 ? { referenceImages } : {}),
      });
      generatedImageData = result.imageData;
      generatedImageMimeType = result.mimeType;
    } else if (imageGenerationImplementation === "openrouter") {
      const result = await generateOpenRouterImage({
        apiKey,
        modelCodename,
        prompt,
        aspectRatio,
        ...(referenceImages.length > 0 ? { referenceImages } : {}),
      });
      generatedImageData = result.imageData;
      generatedImageMimeType = result.mimeType;
    } else if (imageGenerationImplementation === "google") {
      const ai = new GoogleGenAI({ apiKey });
      const chat = ai.chats.create({
        model: modelCodename,
      });

      // Build parts: reference images (as inlineData) followed by the text prompt.
      // SendMessageParameters.message is PartListUnion: inline images must be
      // passed as inlineData parts, not via a non-existent "media" field.
      const messageParts: Array<{ inlineData: { mimeType: string; data: string } } | string> = [
        ...referenceImages.map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data } })),
        prompt,
      ];

      const response = await chat.sendMessage({
        message: messageParts,
        config: {
          responseModalities: ["IMAGE"],
          imageConfig: {
            aspectRatio: aspectRatio,
          },
        },
      });

      if (response?.candidates && response.candidates.length > 0 && response.candidates[0]?.content?.parts) {
        for (const part of response.candidates[0].content.parts) {
          if (part.inlineData) {
            generatedImageData = part.inlineData.data ?? null;
            generatedImageMimeType = part.inlineData.mimeType ?? null;
            break;
          }
        }
      }
    } else if (imageGenerationImplementation === "zai") {
      if (referenceImages.length > 0) {
        await interaction.followUp({
          content: localizer(locale, "commands.generate.image.zai_no_img2img_warning"),
        });
      }
      const { generateZaiNativeImage } = await import("@/providers/zai/zaiImageGeneration");
      const result = await generateZaiNativeImage({
        apiKey,
        model: modelCodename,
        prompt,
        aspectRatio,
        endpointUrl:
          executionProvider === "zaicoding" ? ZAI_CODING_IMAGES_GENERATIONS_URL : ZAI_GENERAL_IMAGES_GENERATIONS_URL,
      });
      generatedImageData = result.imageData;
      generatedImageMimeType = result.mimeType;
    } else if (imageGenerationImplementation === "nvidia") {
      if (referenceImages.length > 0) {
        await interaction.followUp({
          content: localizer(locale, "commands.generate.image.nvidia_no_img2img_warning"),
        });
      }
      const { generateNvidiaNativeImage } = await import("@/providers/nvidia/nvidiaImageGeneration");
      const result = await generateNvidiaNativeImage({
        apiKey,
        model: modelCodename,
        prompt,
        aspectRatio,
        referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
      });
      generatedImageData = result.imageData;
      generatedImageMimeType = result.mimeType;
    } else {
      throw new Error(`Image generation is not implemented for provider ${executionProvider}`);
    }

    const endTime = performance.now();
    const generationTimeSeconds = ((endTime - startTime) / 1000).toFixed(1);

    if (!generatedImageData) {
      await modalSubmitInteraction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "commands.generate.image.error_generation_failed_title"))
            .setDescription(
              localizer(locale, "commands.generate.image.error_generation_failed_description", {
                error: "No image data received from API",
              }),
            )
            .setColor(ColorCode.ERROR),
        ],
      });
      return;
    }

    const imageBuffer = Buffer.from(generatedImageData, "base64");

    const extension =
      generatedImageMimeType === "image/jpeg" ? "jpg" : generatedImageMimeType === "image/webp" ? "webp" : "png"; // Default to PNG

    const filename = `generated_${Date.now()}.${extension}`;
    const attachment = new AttachmentBuilder(imageBuffer, { name: filename });

    // Increment quota after successful generation (server providers only)
    if (imageCreds.source === "server") {
      await incrementImageQuota(tomoriState.server_id, interaction.user.id);
    }
    // Record canonical generation telemetry; quota tables enforce limits only.
    if (userData.user_id) {
      statRepository.recordStat({
        serverId: tomoriState.server_id,
        userId: userData.user_id,
        lineageId: tomoriState.persona_lineage_id ?? 0,
        metric: "image_generated",
        // Key by model codename so the read layer can break generations down by
        // model (the total stays SUM(count) over keys); this dimension can't be
        // reconstructed after the fact.
        metricKey: modelCodename,
      });
    }

    const successEmbed = new EmbedBuilder()
      .setTitle(localizer(locale, "commands.generate.image.success_title"))
      .setColor(ColorCode.SUCCESS)
      .setImage(`attachment://${filename}`)
      .addFields([
        {
          name: localizer(locale, "commands.generate.image.field_prompt"),
          value: prompt.substring(0, 1024), // Discord limit
          inline: false,
        },
        {
          name: localizer(locale, "commands.generate.image.field_model"),
          value: displayModelName,
          inline: true,
        },
        {
          name: localizer(locale, "commands.generate.image.field_generation_time"),
          value: `${generationTimeSeconds}s`,
          inline: true,
        },
        {
          name: localizer(locale, "commands.generate.image.field_aspect_ratio"),
          value: aspectRatio,
          inline: true,
        },
      ]);

    if (referenceImageUrl) {
      successEmbed.setThumbnail(referenceImageUrl);
    }

    await modalSubmitInteraction.editReply({
      embeds: [successEmbed],
      files: [attachment],
    });

    log.success(`Successfully generated and sent image (${generationTimeSeconds}s)`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    log.error("Image generation failed:", error as Error);

    // Use modalSubmitInteraction if available (error after modal), otherwise interaction (error during modal)
    const replyTarget = modalSubmitInteraction ?? interaction;

    if (
      errorMessage.includes("billing") ||
      errorMessage.includes("payment") ||
      errorMessage.includes("quota") ||
      errorMessage.includes("PERMISSION_DENIED")
    ) {
      await replyInfoEmbed(replyTarget, locale, {
        titleKey: "commands.generate.image.error_billing_title",
        descriptionKey: "commands.generate.image.error_billing_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (errorMessage.includes("safety") || errorMessage.includes("blocked") || errorMessage.includes("RECITATION")) {
      await replyInfoEmbed(replyTarget, locale, {
        titleKey: "commands.generate.image.error_safety_title",
        descriptionKey: "commands.generate.image.error_safety_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await replyInfoEmbed(replyTarget, locale, {
      titleKey: "commands.generate.image.error_generation_failed_title",
      descriptionKey: "commands.generate.image.error_generation_failed_description",
      descriptionVars: { error: errorMessage },
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
  }
}
