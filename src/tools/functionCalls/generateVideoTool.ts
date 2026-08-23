/**
 * Video Generation Tool
 * Allows TomoriBot to generate videos using the active provider's native video API.
 * Supports text-to-video and image-to-video (via media_id reference).
 *
 * Key difference from image generation: all video APIs are async with polling,
 * so the execute() method blocks for 30s-5min while the video renders.
 */

import { AttachmentBuilder } from "discord.js";
import { log, ColorCode } from "../../utils/misc/logger";
import { localizer } from "../../utils/text/localizer";
import { sendWebhookMessageWithIdentity } from "@/utils/discord/webhook/personaDispatch";
import { buildGeneratedVideoComponentsV2Payload } from "@/utils/discord/generatedVideoMessage";
import {
  buildReferencedMessageUrl,
  buildVideoToolNoticeDescription,
  sendToolProgressNotice,
} from "@/utils/discord/toolProgressNotice";
import { BaseTool, type ToolContext, type ToolResult, type ToolParameterSchema } from "../../types/tool/interfaces";
import { checkVideoQuota, incrementVideoQuota, type VideoQuotaCheckResult } from "../../utils/quota/videoQuotaManager";
import { statRepository } from "@/utils/db/repositories";
import { resolveProviderFeatureImplementation } from "@/utils/provider/providerInfoRegistry";
import { generateCustomVideoViaEndpoint } from "@/providers/custom/customEndpointDispatcher";
import { formatCustomModelDisplay } from "@/utils/provider/customProviderUtils";
import type { ProviderNativeVideoResolution } from "@/types/provider/featureInterfaces";
import { getResolvedCapabilityModelId, resolveCapabilityCredentials } from "@/utils/provider/credentialResolver";
import { llmModelRepo } from "@/utils/db/repositories/LlmModelRepository";
import { MessageIdMap } from "@/utils/text/messageIdMap";
import { isOpenRouterVideoCapabilityError } from "@/providers/openrouter/openrouterVideoRequest";
import { resolveMessageImageUrls } from "@/utils/image/imageExtractor";

/** Discord file size limit for non-boosted servers (25 MB) */
const DISCORD_FILE_SIZE_LIMIT = 25 * 1024 * 1024;
const DEFAULT_VIDEO_DURATION_SECONDS = 5;
const MAX_VIDEO_DURATION_SECONDS = 20;
const DEFAULT_VIDEO_RESOLUTION: ProviderNativeVideoResolution = "720p";

/**
 * Tool for generating videos using the active provider's native video API.
 * Registered automatically by the tool initializer from src/tools/functionCalls/.
 */
export class GenerateVideoTool extends BaseTool {
  name = "generate_video";
  description =
    "Generate a short AI video using the active provider's native video model. Provide a detailed text prompt describing the video scene, action, and style. Optionally reference a Discord message containing an image to use as the starting frame (image-to-video). Video generation takes 1-3 minutes. The video will be sent directly to the Discord channel as an MP4 file.";
  category = "utility" as const;
  requiresFeatureFlag = "video_gen";

  parameters: ToolParameterSchema = {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "A detailed text description of the video you want to generate. Describe the scene, camera movement, action, style, and any dialogue or sound effects. For image-to-video, describe the desired motion and changes from the reference image.",
      },
      media_id: {
        type: "string",
        description:
          "Optional: The media reference ID (e.g., media_1) from the system hint for the message containing an image to use as the starting frame for image-to-video generation. The first image from this message will be used as the initial frame. If not provided, generates a video from scratch (text-to-video).",
      },
      aspect_ratio: {
        type: "string",
        description:
          "Optional: The aspect ratio for the generated video. Default is '16:9'. Note: '1:1' is not supported by all providers (e.g. Google Veo) and will fall back to '16:9'.",
        enum: ["16:9", "9:16", "1:1"],
      },
      duration: {
        type: "number",
        description:
          "Optional: Target video duration in seconds. Defaults to 5. Maximum is 20 seconds. Providers may fall back to the nearest supported duration.",
      },
      resolution: {
        type: "string",
        description:
          "Optional: Target video resolution. Defaults to '720p'. Supported values are '480p' (SD), '720p' (HD), and '1080p' (FHD). Providers may fall back to the nearest supported resolution.",
        enum: ["480p", "720p", "1080p"],
      },
      generate_audio: {
        type: "boolean",
        description:
          "Optional: Whether to generate audio alongside the video. Defaults to false. Enable when the user asks for sound, music, speech, ambience, or sound effects.",
      },
      audio_prompt: {
        type: "string",
        description:
          "Optional: A separate description of the desired audio, foley, ambience, music, or speech. Use this when generate_audio is true. If omitted, the video prompt is reused for audio generation.",
      },
      loop: {
        type: "boolean",
        description:
          "Optional: For image-to-video, whether to make the video loop by using the reference image as both the first and last frame. Defaults to false. Set true only when the user explicitly wants a looping video.",
      },
    },
    required: ["prompt"],
  };

  private normalizeDuration(rawDuration: unknown): number {
    if (typeof rawDuration !== "number" || !Number.isFinite(rawDuration)) {
      return DEFAULT_VIDEO_DURATION_SECONDS;
    }

    const normalized = Math.trunc(rawDuration);
    if (normalized < 1) {
      return 1;
    }

    return Math.min(normalized, MAX_VIDEO_DURATION_SECONDS);
  }

  private normalizeResolution(rawResolution: unknown): ProviderNativeVideoResolution {
    if (rawResolution === "480p" || rawResolution === "720p" || rawResolution === "1080p") {
      return rawResolution;
    }

    return DEFAULT_VIDEO_RESOLUTION;
  }

  private resolveMediaId(rawMediaId: string | undefined, context: ToolContext): string | undefined {
    if (!rawMediaId) {
      return undefined;
    }

    return MessageIdMap.isOpaqueKey(rawMediaId)
      ? (context.messageIdMap ?? context.streamContext?.messageIdMap)?.resolve(rawMediaId)
      : rawMediaId;
  }

  /**
   * Standard video generation is available for any tool-capable chat model.
   * The actual execution provider is resolved from the configured video slot.
   * @returns Always true, so actual availability is gated by config + credential resolution
   */
  isAvailableFor(_provider: string): boolean {
    return true;
  }

  /**
   * Hide the tool unless a video slot is configured for the active state.
   */
  isAvailableForContext(_provider: string, context?: ToolContext): boolean {
    return (context?.tomoriState.config.video_model_id ?? null) !== null;
  }

  /**
   * Check if video generation is enabled in Tomori config.
   * @returns True if video generation is enabled
   */
  protected isEnabled(context: ToolContext): boolean {
    return context.tomoriState.config.videogen_enabled;
  }

  /**
   * Get the video model codename from the database via repository.
   * @returns The model codename string (e.g., "veo-3.1-generate-preview")
   */
  private async getVideoModelCodename(videoModelId: number): Promise<string> {
    const model = await llmModelRepo.loadVideoGenerationModelById(videoModelId);

    if (!model) {
      throw new Error(`Video model not found in database: ${videoModelId}`);
    }

    return model.codename;
  }

  /**
   * Send a generated video to the Discord channel via webhook or bot message.
   *
   * The video is sent inside a Components V2 Media Gallery so a "Generated in Xs"
   * footer can sit BELOW the inline player (a plain `content` caption would render
   * above the attachment). Each path falls back to a plain attachment-only message
   * if Components V2 is rejected, so that fallback preserves Discord's native inline
   * video player, just without the timing footer.
   * @param videoData - Raw video bytes
   * @param elapsedMs - Wall-clock generation time in milliseconds, used for the "Generated in Xs" footer
   */
  private async sendGeneratedVideo(
    context: ToolContext,
    videoData: Buffer,
    filename: string,
    elapsedMs: number,
  ): Promise<import("discord.js").Message> {
    const threadId =
      "isThread" in context.channel && typeof context.channel.isThread === "function" && context.channel.isThread()
        ? context.channel.id
        : undefined;
    const componentsPayload = buildGeneratedVideoComponentsV2Payload(filename, elapsedMs, context.locale);

    // Try persona webhook first (Components V2, then plain attachment fallback)
    if (context.webhook && context.personaUsername) {
      try {
        const webhookAttachment = new AttachmentBuilder(videoData, {
          name: filename,
        });
        return await sendWebhookMessageWithIdentity(
          context.webhook,
          {
            files: [webhookAttachment],
            ...componentsPayload,
            withComponents: true,
            ...(threadId ? { threadId } : {}),
          },
          {
            username: context.personaUsername,
            avatarUrl: context.personaAvatarUrl,
            avatarDataUri: context.personaAvatarUrl?.startsWith("data:image/") ? context.personaAvatarUrl : undefined,
          },
        );
      } catch (error) {
        log.warn(
          "Failed to send generated video via webhook with Components V2, retrying without components",
          error as Error,
        );
        try {
          const webhookAttachment = new AttachmentBuilder(videoData, {
            name: filename,
          });
          return await sendWebhookMessageWithIdentity(
            context.webhook,
            {
              files: [webhookAttachment],
              ...(threadId ? { threadId } : {}),
            },
            {
              username: context.personaUsername,
              avatarUrl: context.personaAvatarUrl,
              avatarDataUri: context.personaAvatarUrl?.startsWith("data:image/") ? context.personaAvatarUrl : undefined,
            },
          );
        } catch (fallbackError) {
          const discordError = fallbackError as Error & {
            code?: string | number;
            status?: number;
            method?: string;
            url?: string;
            rawError?: unknown;
          };
          log.warn(
            `Failed to send generated video via webhook; falling back to bot message ${JSON.stringify({
              filename,
              bytes: videoData.length,
              error: discordError.message,
              code: discordError.code ?? null,
              status: discordError.status ?? null,
              method: discordError.method ?? null,
              url: discordError.url ?? null,
              rawError: discordError.rawError ?? null,
            })}`,
          );
        }
      }
    }

    // Bot message path (Components V2, then plain attachment fallback)
    try {
      const channelAttachment = new AttachmentBuilder(videoData, {
        name: filename,
      });
      return await context.channel.send({
        files: [channelAttachment],
        ...componentsPayload,
      });
    } catch (error) {
      log.warn(
        "Failed to send generated video with Components V2, falling back to attachment-only message",
        error as Error,
      );
      try {
        const channelAttachment = new AttachmentBuilder(videoData, {
          name: filename,
        });
        return await context.channel.send({ files: [channelAttachment] });
      } catch (fallbackError) {
        const discordError = fallbackError as Error & {
          code?: string | number;
          status?: number;
          method?: string;
          url?: string;
          rawError?: unknown;
        };
        log.error(
          `Failed to send generated video via bot message ${JSON.stringify({
            filename,
            bytes: videoData.length,
            error: discordError.message,
            code: discordError.code ?? null,
            status: discordError.status ?? null,
            method: discordError.method ?? null,
            url: discordError.url ?? null,
            rawError: discordError.rawError ?? null,
          })}`,
        );
        throw fallbackError;
      }
    }
  }

  /**
   * Extract the first image from a Discord message for image-to-video generation.
   * Returns the source URL directly, so providers that need base64 can fetch it themselves.
   * @returns Reference image with url and mimeType, or null if no image found
   */
  private async extractReferenceImageFromMessage(
    messageId: string,
    context: ToolContext,
  ): Promise<{ mimeType: string; data: string; url: string; fallbackUrl?: string } | null> {
    try {
      const { imageUrls, sourceMessageId } = await resolveMessageImageUrls(messageId, context);
      const image = imageUrls[0];
      if (!image) return null;
      if (sourceMessageId !== messageId) {
        log.info(`Using image from replied-to message ${sourceMessageId} for image-to-video reference ${messageId}`);
      }

      // Return the URL directly, so embedding large images as base64 in the request body
      // can exceed provider body size limits. Providers fetch the URL themselves.
      return {
        url: image.proxyUrl || image.url,
        ...(image.proxyUrl && image.proxyUrl !== image.url ? { fallbackUrl: image.url } : {}),
        mimeType: image.mimeType,
        data: "", // Empty: providers that need base64 must fetch the url themselves
      };
    } catch (error) {
      log.error(`Failed to extract reference image from message ${messageId}`, error as Error);
      return null;
    }
  }

  /**
   * Execute video generation.
   *
   * Flow:
   *   1. Validate params and check permissions/quota
   *   2. Look up video model and decrypt API key
   *   3. Send progress notice (video gen takes 1-3 min)
   *   4. Optionally extract reference image from message
   *   5. Route to appropriate provider implementation
   *   6. Check Discord file size limit
   *   7. Send video attachment to Discord
   *   8. Increment quota and return success
   */
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    // Capture generation start time for the "Generated in Xs" caption (mirrors image tool)
    const startedAtMs = Date.now();

    const validation = this.validateParameters(args);
    if (!validation.isValid) {
      return {
        success: false,
        error: `Invalid parameters: ${validation.errors?.join(", ") || `Missing required parameters: ${validation.missingParams?.join(", ")}`}`,
      };
    }

    if (!this.isEnabled(context)) {
      return {
        success: false,
        error: "Video generation is disabled for this server",
        message: localizer(context.locale, "tools.generate_video.disabled"),
      };
    }

    const userDiscId = context.userId || context.message?.author.id || "";
    if (!userDiscId) {
      return {
        success: false,
        error: "Unable to identify user for quota checking",
      };
    }

    const prompt = args.prompt as string;
    const rawMediaId = args.media_id as string | undefined;
    const messageId = this.resolveMediaId(rawMediaId, context);
    const aspectRatio = (args.aspect_ratio as string) || "16:9";
    const durationSeconds = this.normalizeDuration(args.duration);
    const resolution = this.normalizeResolution(args.resolution);
    const generateAudio = args.generate_audio === true;
    const audioPrompt =
      typeof args.audio_prompt === "string" && args.audio_prompt.trim() ? args.audio_prompt.trim() : undefined;
    const loop = args.loop === true;
    const usesReference = !!messageId;

    if (rawMediaId && !messageId) {
      return {
        success: false,
        error: `Unknown media_id: "${rawMediaId}".`,
      };
    }

    if (
      typeof args.duration === "number" &&
      (!Number.isFinite(args.duration) || args.duration < 1 || args.duration > 20)
    ) {
      return {
        success: false,
        error: "Duration must be an integer between 1 and 20 seconds.",
      };
    }

    // Default to allowed; overwritten below for server-credential users
    let quotaCheck: VideoQuotaCheckResult = { allowed: true };

    try {
      // Resolve credentials first so we can skip server quota for personal BYOK users
      const creds = await resolveCapabilityCredentials(context.tomoriState.server_id, "video", {
        userId: context.internalUserId ?? null,
      });

      // Personal BYOK users bring their own API quota, so bypass server quota entirely
      if (creds.source === "server") {
        quotaCheck = await checkVideoQuota(context.tomoriState.server_id, userDiscId);
      }

      if (!quotaCheck.allowed) {
        let errorMessage = "";
        let resetInfo = "";

        if (quotaCheck.resetTime) {
          const now = new Date();
          const hoursUntilReset = Math.ceil((quotaCheck.resetTime.getTime() - now.getTime()) / (1000 * 60 * 60));

          if (hoursUntilReset < 24) {
            resetInfo = localizer(context.locale, "tools.generate_video.quota_resets_in_hours", {
              hours: hoursUntilReset.toString(),
            });
          } else {
            const daysUntilReset = Math.ceil(hoursUntilReset / 24);
            resetInfo = localizer(context.locale, "tools.generate_video.quota_resets_in_days", {
              days: daysUntilReset.toString(),
            });
          }
        }

        if (quotaCheck.reason === "user_quota_exceeded") {
          errorMessage = localizer(context.locale, "tools.generate_video.user_quota_exceeded", {
            reset_info: resetInfo,
          });
        } else if (quotaCheck.reason === "serverwide_quota_exceeded") {
          errorMessage = localizer(context.locale, "tools.generate_video.serverwide_quota_exceeded", {
            reset_info: resetInfo,
          });
        } else {
          errorMessage = localizer(context.locale, "tools.generate_video.quota_exceeded_generic");
        }

        return {
          success: false,
          error: "Video generation quota exceeded",
          message: errorMessage,
        };
      }

      const videoModelId = getResolvedCapabilityModelId(creds, "video") ?? context.tomoriState.config.video_model_id;

      if (!videoModelId) {
        return {
          success: false,
          error:
            "No video model configured for this server. The active provider may not support video generation, or setup has not been completed.",
        };
      }

      const modelCodename = await this.getVideoModelCodename(videoModelId);
      const displayModelName = creds.customEndpoint ? formatCustomModelDisplay(creds.customEndpoint) : modelCodename;
      log.info(`Using video model: ${modelCodename} for video generation`);

      const apiKey = creds.apiKey;
      const executionProvider = creds.provider;

      // Send progress notice, so video generation takes 1-3 minutes
      if (!context.suppressProgressNotices) {
        const baseNoticeDescription = localizer(
          context.locale,
          usesReference ? "tools.video.generating_with_references_description" : "tools.video.generating_description",
        );
        const referencedMessageUrl = messageId ? buildReferencedMessageUrl(context, messageId) : null;
        const extraNoticeLines = usesReference
          ? [
              referencedMessageUrl
                ? localizer(context.locale, "tools.video.notice_reference_line", {
                    message_url: referencedMessageUrl,
                  })
                : localizer(context.locale, "tools.video.notice_reference_count_line", {
                    count: "1",
                  }),
            ]
          : [];
        await sendToolProgressNotice(
          context,
          "video_generation",
          {
            titleKey: "tools.video.generating_title",
            description: buildVideoToolNoticeDescription(
              context.locale,
              baseNoticeDescription,
              displayModelName,
              prompt,
              localizer(context.locale, "tools.video.generating_footer"),
              extraNoticeLines,
            ),
            color: ColorCode.INFO,
          },
          "GenerateVideoTool",
        );
      }

      let referenceImages: Array<{ mimeType: string; data: string; url?: string; fallbackUrl?: string }> | undefined;

      if (messageId) {
        log.info(`Extracting reference image from message ${messageId} for image-to-video`);
        const refImage = await this.extractReferenceImageFromMessage(messageId, context);
        if (refImage) {
          referenceImages = [refImage];
          log.info(`Using reference image from message ${messageId} for image-to-video generation`);
        } else {
          log.warn(`No image found in message ${messageId}, proceeding with text-to-video`);
        }
      }

      log.info(
        `Generating video with ${executionProvider} via ${displayModelName}: "${prompt.substring(0, 100)}${prompt.length > 100 ? "..." : ""}" (aspect ratio: ${aspectRatio}, duration: ${durationSeconds}s, resolution: ${resolution})`,
      );

      let videoData: Buffer | null = null;
      let videoFilename = `generated_${Date.now()}.mp4`;
      const videoImplementation = resolveProviderFeatureImplementation(executionProvider, "videoGeneration");

      if (creds.customEndpoint) {
        const result = await generateCustomVideoViaEndpoint({
          endpoint: creds.customEndpoint,
          apiKey,
          prompt,
          aspectRatio,
          durationSeconds,
          resolution,
          referenceImages,
          generateAudio,
          audioPrompt,
          loop,
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
          resolution,
          referenceImages,
          generateAudio,
          audioPrompt,
          loop,
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
          resolution,
          referenceImages,
          generateAudio,
          audioPrompt,
          loop,
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
          resolution,
          referenceImages,
          generateAudio,
          audioPrompt,
          loop,
        });
        videoData = result.videoData;
        videoFilename = result.filename ?? videoFilename;
      } else {
        return {
          success: false,
          error: `Video generation is not implemented for provider ${executionProvider}`,
        };
      }

      if (!videoData) {
        return {
          success: false,
          error: "No video data received from API. The generation may have been blocked or failed.",
        };
      }

      if (videoData.length > DISCORD_FILE_SIZE_LIMIT) {
        const sizeMB = (videoData.length / (1024 * 1024)).toFixed(1);
        log.warn(`Generated video exceeds Discord file size limit: ${sizeMB}MB > 25MB`);
        return {
          success: false,
          error: localizer(context.locale, "tools.generate_video.file_too_large", { size_mb: sizeMB }),
          message: localizer(context.locale, "tools.generate_video.file_too_large", { size_mb: sizeMB }),
        };
      }

      log.info(
        `Sending generated video to Discord ${JSON.stringify({
          filename: videoFilename,
          bytes: videoData.length,
        })}`,
      );

      const elapsedMs = Date.now() - startedAtMs;
      const sentMessage = await this.sendGeneratedVideo(context, videoData, videoFilename, elapsedMs);

      log.success("Successfully generated and sent video to Discord");

      // Increment quota after successful generation (server providers only)
      if (creds.source === "server") {
        await incrementVideoQuota(context.tomoriState.server_id, userDiscId);
      }
      // Record canonical generation telemetry for all providers; quotas enforce limits only.
      if (context.internalUserId) {
        statRepository.recordStat({
          serverId: context.tomoriState.server_id,
          userId: context.internalUserId,
          lineageId: context.tomoriState.persona_lineage_id ?? 0,
          metric: "video_generated",
          metricKey: modelCodename,
        });
      }

      let successMessage = `Successfully generated and sent video to Discord (message ID: ${sentMessage.id}). The video has been created based on your prompt${
        referenceImages ? " and the reference image" : ""
      } at ${resolution} for approximately ${durationSeconds} second(s).`;

      if (quotaCheck.userRemaining !== undefined) {
        const remainingText = localizer(context.locale, "tools.generate_video.quota_remaining", {
          remaining: quotaCheck.userRemaining.toString(),
        });
        successMessage += ` ${remainingText}`;
      }

      return {
        success: true,
        message: successMessage,
        endTurn: context.streamContext?.endTurnAfterTools?.includes(this.name) ?? false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error("Video generation failed:", error as Error);

      if (isOpenRouterVideoCapabilityError(error)) {
        const localizedMessage = localizer(
          context.locale,
          error.code === "last_frame_unsupported"
            ? "tools.generate_video.loop_unsupported"
            : "tools.generate_video.reference_unsupported",
          { model: error.model },
        );
        return {
          success: false,
          error: localizedMessage,
          message: localizedMessage,
        };
      }

      if (errorMessage.includes("timed out")) {
        return {
          success: false,
          error: "Video generation timed out. The provider may be experiencing high load. Please try again later.",
        };
      }

      if (errorMessage.includes("content") || errorMessage.includes("safety") || errorMessage.includes("blocked")) {
        return {
          success: false,
          error: "Video generation was blocked by the provider's content safety filter. Please try a different prompt.",
        };
      }

      return {
        success: false,
        error: `Video generation failed: ${errorMessage}`,
      };
    }
  }
}
