/**
 * Video Generation Command (/generate video)
 * Allows users to generate AI videos using Google Veo, OpenRouter, or Z.ai.
 * Supports text-to-video and image-to-video via an optional reference image upload.
 * Video generation is async: takes 1-5 minutes with provider-side polling.
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
import { log, ColorCode } from "../../utils/misc/logger";
import { localizer } from "../../utils/text/localizer";
import { personaRepository, llmModelRepo, statRepository } from "@/utils/db/repositories";
import { replyInfoEmbed, promptWithRawModal } from "../../utils/discord/interactionHelper";
import { safeReply } from "@/utils/discord/safeReply";
import type { UserRow } from "../../types/db/schema";
import { checkVideoQuota, incrementVideoQuota } from "../../utils/quota/videoQuotaManager";
import { resolveProviderFeatureImplementation } from "@/utils/provider/providerInfoRegistry";
import { generateCustomVideoViaEndpoint } from "@/providers/custom/customEndpointDispatcher";
import {
  CredentialUnavailableError,
  PersonalProviderRequiredError,
  getResolvedCapabilityModelId,
  resolveCapabilityCredentials,
} from "@/utils/provider/credentialResolver";
import { applyPersonalProviderSelectionsToTomoriState } from "@/utils/provider/personalProviderRuntime";
import { formatCustomModelDisplay } from "@/utils/provider/customProviderUtils";
import { MEDIA_LIMITS } from "@/utils/security/rateLimiter";
import { safeDownload } from "@/utils/security/safeDownload";
import { isOpenRouterVideoCapabilityError } from "@/providers/openrouter/openrouterVideoRequest";

const MODAL_CUSTOM_ID = "generate_video_modal";
const PROMPT_INPUT_ID = "prompt_input";
const ASPECT_RATIO_SELECT_ID = "aspect_ratio_select";
const REFERENCE_IMAGE_INPUT_ID = "image_upload_1";
const DURATION_INPUT_ID = "duration_input";
const FPS_INPUT_ID = "fps_input";

/** Discord file size limit for non-boosted servers (25 MB) */
const DISCORD_FILE_SIZE_LIMIT = 25 * 1024 * 1024;

/**
 * Parse a positive integer from an environment variable, falling back to a default.
 * @param fallback - Value to use when unset or invalid
 * @returns A finite positive integer
 */
function parsePositiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Duration/FPS bounds for the modal inputs. Kept env-configurable so operators can tune
// limits without code changes; providers still normalize values to their own supported ranges.
const DEFAULT_VIDEO_DURATION_SECONDS = parsePositiveIntEnv("VIDEO_GEN_DEFAULT_DURATION_SECONDS", 5);
const MAX_VIDEO_DURATION_SECONDS = parsePositiveIntEnv("VIDEO_GEN_MAX_DURATION_SECONDS", 20);
const MAX_VIDEO_FPS = parsePositiveIntEnv("VIDEO_GEN_MAX_FPS", 60);

/**
 * Parse and validate an integer entered into a modal text field.
 * @param raw - Raw string value from the modal submission (may be undefined/empty)
 * @param min - Inclusive minimum allowed value
 * @param max - Inclusive maximum allowed value
 * @returns `{ value }` on success (value is `undefined` when the optional field is blank),
 *          or `{ error: true }` when the entry is non-numeric or out of range.
 */
function parseModalInteger(raw: string | undefined, min: number, max: number): { value?: number; error?: true } {
  const trimmed = raw?.trim();
  // Blank input is treated as "not provided", so callers decide if that's allowed.
  if (!trimmed) {
    return { value: undefined };
  }

  if (!/^\d+$/.test(trimmed)) {
    return { error: true };
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return { error: true };
  }

  return { value: parsed };
}

/**
 * Configure the subcommand
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("video").setDescription(localizer("en-US", "commands.generate.video.description"));

/**
 * @param videoModelId - Database ID of the video generation model
 * @returns The model codename string (e.g., "veo-3.1-generate-preview")
 */
async function getVideoModelCodename(videoModelId: number): Promise<string> {
  const model = await llmModelRepo.loadVideoGenerationModelById(videoModelId);

  if (!model) {
    throw new Error(`Video model not found: ${videoModelId}`);
  }

  return model.codename;
}

/**
 * Convert a Discord attachment to base64 format for image-to-video API.
 * @param attachment - Discord API attachment object
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

  return {
    mimeType: attachment.content_type,
    data: base64Data,
  };
}

/**
 * Execute the /generate video command.
 *
 * Flow:
 *   1. Pre-validation (channel, state, permissions, provider, API key, model, quota)
 *   2. Show modal for prompt + aspect ratio + optional reference image
 *   3. Auto-defer reply (video gen takes 1-5 minutes)
 *   4. Route to appropriate provider implementation
 *   5. Check file size and send result
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

  if (!tomoriState.config.videogen_enabled) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.generate.video.disabled_title",
      descriptionKey: "commands.generate.video.disabled_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let videoCreds: Awaited<ReturnType<typeof resolveCapabilityCredentials>>;
  try {
    videoCreds = await resolveCapabilityCredentials(tomoriState.server_id, "video", {
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
          titleKey: "commands.generate.video.no_video_model_title",
          descriptionKey: "commands.generate.video.no_video_model_description",
          color: ColorCode.ERROR,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.generate.video.no_api_key_title",
        descriptionKey: "commands.generate.video.no_api_key_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    throw error;
  }

  const videoModelId = getResolvedCapabilityModelId(videoCreds, "video") ?? tomoriState.config.video_model_id;
  if (!videoModelId) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.generate.video.no_video_model_title",
      descriptionKey: "commands.generate.video.no_video_model_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const apiKey = videoCreds.apiKey;
  const executionProvider = videoCreds.provider;

  // Check video quota before showing modal (personal-provider users bypass quota)
  if (videoCreds.source === "server") {
    const quotaCheck = await checkVideoQuota(tomoriState.server_id, interaction.user.id);
    if (!quotaCheck.allowed) {
      const descriptionVars: Record<string, string> = {};

      if (quotaCheck.resetTime) {
        const now = new Date();
        const hoursUntilReset = Math.ceil((quotaCheck.resetTime.getTime() - now.getTime()) / (1000 * 60 * 60));

        if (hoursUntilReset < 24) {
          descriptionVars.reset_info = localizer(locale, "commands.generate.video.quota_resets_in_hours", {
            hours: hoursUntilReset.toString(),
          });
        } else {
          const daysUntilReset = Math.ceil(hoursUntilReset / 24);
          descriptionVars.reset_info = localizer(locale, "commands.generate.video.quota_resets_in_days", {
            days: daysUntilReset.toString(),
          });
        }
      }

      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.generate.video.quota_exceeded_title",
        descriptionKey:
          quotaCheck.reason === "user_quota_exceeded"
            ? "commands.generate.video.user_quota_exceeded_description"
            : quotaCheck.reason === "serverwide_quota_exceeded"
              ? "commands.generate.video.serverwide_quota_exceeded_description"
              : "commands.generate.video.quota_exceeded_description",
        descriptionVars,
        footerKey: "commands.generate.video.quota_exceeded_footer",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  let modalSubmitInteraction: import("discord.js").ModalSubmitInteraction | undefined;

  try {
    const modalComponents = [
      {
        customId: PROMPT_INPUT_ID,
        labelKey: "commands.generate.video.modal.prompt_label",
        descriptionKey: "commands.generate.video.modal.prompt_description",
        placeholder: "commands.generate.video.modal.prompt_placeholder",
        required: true,
        style: TextInputStyle.Paragraph,
        maxLength: 2000,
      },
      {
        customId: REFERENCE_IMAGE_INPUT_ID,
        labelKey: "commands.generate.video.modal.image_upload_label",
        descriptionKey: "commands.generate.video.modal.image_upload_description",
        minValues: 0,
        maxValues: 1,
        required: false,
      },
      {
        kind: "radioGroup" as const,
        customId: ASPECT_RATIO_SELECT_ID,
        labelKey: "commands.generate.video.modal.aspect_ratio_label",
        descriptionKey: "commands.generate.video.modal.aspect_ratio_description",
        required: true,
        options: [
          { label: "16:9 (Landscape)", value: "16:9" },
          { label: "9:16 (Portrait)", value: "9:16" },
          { label: "1:1 (Square)", value: "1:1" },
        ],
      },
      {
        customId: DURATION_INPUT_ID,
        labelKey: "commands.generate.video.modal.duration_label",
        descriptionKey: "commands.generate.video.modal.duration_description",
        placeholder: "commands.generate.video.modal.duration_placeholder",
        required: true,
        style: TextInputStyle.Short,
        // Prefill the default so the required field is one keystroke away from valid.
        value: String(DEFAULT_VIDEO_DURATION_SECONDS),
        maxLength: 3,
      },
      {
        customId: FPS_INPUT_ID,
        labelKey: "commands.generate.video.modal.fps_label",
        descriptionKey: "commands.generate.video.modal.fps_description",
        placeholder: "commands.generate.video.modal.fps_placeholder",
        required: false,
        style: TextInputStyle.Short,
        maxLength: 3,
      },
    ];

    // Show modal and wait for submission (auto-defer with public reply)
    const modalResult = await promptWithRawModal(
      interaction,
      locale,
      {
        modalCustomId: MODAL_CUSTOM_ID,
        modalTitleKey: "commands.generate.video.modal.title",
        components: modalComponents,
      },
      true,
    );

    if (modalResult.outcome !== "submit") {
      log.info(`Generate video modal ${modalResult.outcome}`);
      return;
    }

    modalSubmitInteraction = modalResult.interaction;
    const prompt = modalResult.values?.[PROMPT_INPUT_ID];
    const aspectRatio = modalResult.values?.[ASPECT_RATIO_SELECT_ID] ?? "16:9";
    const imageAttachment = modalResult.attachments?.[REFERENCE_IMAGE_INPUT_ID];

    if (!modalSubmitInteraction || !prompt) {
      log.error("Modal result unexpectedly missing required values");
      return;
    }

    // Parse and validate duration (required) and FPS (optional).
    //     Providers normalize these to their own supported ranges, so we only guard
    //     against clearly invalid entries here (non-numeric or out of configured bounds).
    const durationResult = parseModalInteger(modalResult.values?.[DURATION_INPUT_ID], 1, MAX_VIDEO_DURATION_SECONDS);
    if (durationResult.error || durationResult.value === undefined) {
      await modalSubmitInteraction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "commands.generate.video.invalid_duration_title"))
            .setDescription(
              localizer(locale, "commands.generate.video.invalid_duration_description", {
                max: MAX_VIDEO_DURATION_SECONDS.toString(),
              }),
            )
            .setColor(ColorCode.ERROR),
        ],
      });
      return;
    }
    const durationSeconds = durationResult.value;

    const fpsResult = parseModalInteger(modalResult.values?.[FPS_INPUT_ID], 1, MAX_VIDEO_FPS);
    if (fpsResult.error) {
      await modalSubmitInteraction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "commands.generate.video.invalid_fps_title"))
            .setDescription(
              localizer(locale, "commands.generate.video.invalid_fps_description", {
                max: MAX_VIDEO_FPS.toString(),
              }),
            )
            .setColor(ColorCode.ERROR),
        ],
      });
      return;
    }
    const fps = fpsResult.value;

    let referenceImages: Array<{ mimeType: string; data: string }> | undefined;

    if (imageAttachment) {
      try {
        log.info(`Processing reference image for image-to-video: ${imageAttachment.filename}`);
        const converted = await convertAttachmentToBase64(imageAttachment);
        referenceImages = [converted];
      } catch (error) {
        log.warn(`Failed to process video reference image:`, error as Error);
        await modalSubmitInteraction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle(localizer(locale, "commands.generate.video.invalid_image_title"))
              .setDescription(localizer(locale, "commands.generate.video.invalid_image_description"))
              .setColor(ColorCode.ERROR),
          ],
        });
        return;
      }
    }

    const modelCodename = await getVideoModelCodename(videoModelId);
    const displayModelName = videoCreds.customEndpoint
      ? formatCustomModelDisplay(videoCreds.customEndpoint)
      : modelCodename;

    log.info(
      `Generating video with ${executionProvider} via ${displayModelName}: "${prompt.substring(0, 100)}${prompt.length > 100 ? "..." : ""}" (aspect ratio: ${aspectRatio}, duration: ${durationSeconds}s, fps: ${fps ?? "default"}, reference: ${referenceImages ? "yes" : "no"})`,
    );

    await modalSubmitInteraction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(localizer(locale, "commands.generate.video.generating_title"))
          .setDescription(localizer(locale, "commands.generate.video.generating_description"))
          .setColor(ColorCode.INFO),
      ],
    });

    const startTime = performance.now();

    let videoData: Buffer | null = null;
    let videoFilename = `generated_${Date.now()}.mp4`;
    const videoImplementation = resolveProviderFeatureImplementation(executionProvider, "videoGeneration");

    if (videoCreds.customEndpoint) {
      const result = await generateCustomVideoViaEndpoint({
        endpoint: videoCreds.customEndpoint,
        apiKey,
        prompt,
        aspectRatio,
        durationSeconds,
        fps,
        referenceImages,
      });
      videoData = result.videoData;
      videoFilename = result.filename ?? videoFilename;
    } else if (videoImplementation === "google") {
      const { generateGoogleNativeVideo } = await import("@/providers/google/googleVideoGeneration");
      const result = await generateGoogleNativeVideo({
        apiKey,
        model: modelCodename,
        prompt,
        aspectRatio,
        durationSeconds,
        fps,
        referenceImages,
      });
      videoData = result.videoData;
      videoFilename = result.filename ?? videoFilename;
    } else if (videoImplementation === "openrouter") {
      const { generateOpenRouterNativeVideo } = await import("@/providers/openrouter/openrouterVideoGeneration");
      const result = await generateOpenRouterNativeVideo({
        apiKey,
        model: modelCodename,
        prompt,
        aspectRatio,
        durationSeconds,
        fps,
        referenceImages,
      });
      videoData = result.videoData;
      videoFilename = result.filename ?? videoFilename;
    } else if (videoImplementation === "zai") {
      const { generateZaiNativeVideo } = await import("@/providers/zai/zaiVideoGeneration");
      const result = await generateZaiNativeVideo({
        apiKey,
        model: modelCodename,
        prompt,
        aspectRatio,
        durationSeconds,
        fps,
        referenceImages,
      });
      videoData = result.videoData;
      videoFilename = result.filename ?? videoFilename;
    } else {
      await modalSubmitInteraction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "commands.generate.video.error_title"))
            .setDescription(
              localizer(locale, "commands.generate.video.unsupported_provider_description", {
                provider: executionProvider,
              }),
            )
            .setColor(ColorCode.ERROR),
        ],
      });
      return;
    }

    if (!videoData) {
      await modalSubmitInteraction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "commands.generate.video.error_title"))
            .setDescription(localizer(locale, "commands.generate.video.no_data_description"))
            .setColor(ColorCode.ERROR),
        ],
      });
      return;
    }

    if (videoData.length > DISCORD_FILE_SIZE_LIMIT) {
      const sizeMB = (videoData.length / (1024 * 1024)).toFixed(1);
      await modalSubmitInteraction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "commands.generate.video.file_too_large_title"))
            .setDescription(
              localizer(locale, "commands.generate.video.file_too_large_description", { size_mb: sizeMB }),
            )
            .setColor(ColorCode.ERROR),
        ],
      });
      return;
    }

    const elapsedMs = performance.now() - startTime;
    const elapsedSec = (elapsedMs / 1000).toFixed(1);

    log.info(
      `Sending generated video to Discord ${JSON.stringify({
        filename: videoFilename,
        bytes: videoData.length,
      })}`,
    );

    const attachment = new AttachmentBuilder(videoData, {
      name: videoFilename,
    });

    await modalSubmitInteraction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(localizer(locale, "commands.generate.video.success_title"))
          .setDescription(
            localizer(locale, "commands.generate.video.success_description", {
              model: displayModelName,
              elapsed: elapsedSec,
              prompt: prompt.length > 200 ? `${prompt.substring(0, 200)}...` : prompt,
            }),
          )
          .setColor(ColorCode.SUCCESS),
      ],
      files: [attachment],
    });

    // Increment quota (server providers only)
    if (videoCreds.source === "server") {
      await incrementVideoQuota(tomoriState.server_id, interaction.user.id);
    }
    // Record canonical generation telemetry; quota tables enforce limits only.
    if (userData.user_id) {
      statRepository.recordStat({
        serverId: tomoriState.server_id,
        userId: userData.user_id,
        lineageId: tomoriState.persona_lineage_id ?? 0,
        metric: "video_generated",
        // Key by model codename for a per-model generation breakdown at read time.
        metricKey: modelCodename,
      });
    }
    log.success(`Video generated in ${elapsedSec}s via ${displayModelName}`);
  } catch (error) {
    log.error("Video generation command failed:", error as Error);

    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorEmbed = new EmbedBuilder()
      .setTitle(localizer(locale, "commands.generate.video.error_title"))
      .setDescription(
        isOpenRouterVideoCapabilityError(error)
          ? localizer(
              locale,
              error.code === "last_frame_unsupported"
                ? "commands.generate.video.loop_unsupported_description"
                : "commands.generate.video.reference_unsupported_description",
              { model: error.model },
            )
          : errorMessage.includes("timed out")
            ? localizer(locale, "commands.generate.video.timeout_description")
            : errorMessage.includes("content") || errorMessage.includes("safety") || errorMessage.includes("blocked")
              ? localizer(locale, "commands.generate.video.blocked_description")
              : localizer(locale, "commands.generate.video.generic_error_description"),
      )
      .setColor(ColorCode.ERROR);

    if (modalSubmitInteraction) {
      await safeReply(modalSubmitInteraction.editReply({ embeds: [errorEmbed] }), "video error embed");
    } else {
      await safeReply(
        replyInfoEmbed(interaction, locale, {
          titleKey: "commands.generate.video.error_title",
          descriptionKey: "commands.generate.video.generic_error_description",
          color: ColorCode.ERROR,
          flags: MessageFlags.Ephemeral,
        }),
        "video fallback error embed",
      );
    }
  }
}
