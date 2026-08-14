import type { TomoriState } from "@/types/db/schema";
import type { ContextPart, MediaDescriptor, StructuredContextItem } from "@/types/misc/context";
import { getOpenRouterCapabilities, isOpenRouterCapabilityCacheReady } from "@/utils/cache/openrouterCapabilityCache";
import { log } from "@/utils/misc/logger";
import { createToolPromptMacroResolver, resolvePromptCapabilityValues } from "@/utils/tools/toolPromptMacros";

interface MediaCapabilities {
  seesImages: boolean;
  seesVideos: boolean;
}

export async function resolveMediaForModel(
  contextItems: StructuredContextItem[],
  tomoriState: TomoriState,
): Promise<StructuredContextItem[]> {
  const toolPromptMacroResolver = createToolPromptMacroResolver({
    provider: tomoriState.llm.llm_provider,
    capabilities: resolvePromptCapabilityValues(tomoriState.config),
    stateForContext:
      tomoriState.server_id && tomoriState.llm
        ? {
            server_id: tomoriState.server_id.toString(),
            activePersonaHasElevenlabsVoice: false,
            llm: tomoriState.llm,
            diffusion_model_id: tomoriState.config.diffusion_model_id,
            nai_diffusion_model_id: tomoriState.config.nai_diffusion_model_id,
            video_model_id: tomoriState.config.video_model_id,
            config: {
              sticker_usage_enabled: tomoriState.config.sticker_usage_enabled,
              web_search_enabled: tomoriState.config.web_search_enabled,
              self_teaching_enabled: tomoriState.config.self_teaching_enabled,
              manage_message_enabled: tomoriState.config.manage_message_enabled,
              imagegen_enabled: tomoriState.config.imagegen_enabled,
              videogen_enabled: tomoriState.config.videogen_enabled,
              voice_message_enabled: tomoriState.config.voice_message_enabled,
              user_blocking_enabled: tomoriState.config.user_blocking_enabled,
              user_info_updates_enabled: tomoriState.config.user_info_updates_enabled,
              thread_creation_enabled: tomoriState.config.thread_creation_enabled,
            },
          }
        : undefined,
  });
  const capabilities = resolveEffectiveMediaCapabilities(tomoriState);
  const hasVisionTool = !!tomoriState.vision_llm && !capabilities.seesImages;
  const resolvedItems: StructuredContextItem[] = [];

  for (const item of contextItems) {
    const descriptors = item.mediaDescriptors?.filter((descriptor) => !descriptor.isEmoji) ?? [];
    const originalParts = cloneParts(item.parts);
    const baseItem = withoutMediaDescriptors(item, originalParts);

    if (descriptors.length === 0) {
      resolvedItems.push(baseItem);
      continue;
    }

    const { mediaParts, systemParts } = await resolveItemMedia({
      descriptors,
      tomoriState,
      capabilities,
      hasVisionTool,
      expandToolMacros: (text) => toolPromptMacroResolver.expand(text),
      messageId: item.messageId,
    });

    if (item.role === "model") {
      if (systemParts.length > 0) {
        resolvedItems.push({
          ...baseItem,
          role: "user",
          parts: systemParts,
        });
      }

      const modelParts = [...mediaParts, ...originalParts];
      if (modelParts.length > 0) {
        resolvedItems.push({
          ...baseItem,
          parts: modelParts,
        });
      }
      continue;
    }

    const resolvedParts = [...mediaParts, ...systemParts, ...originalParts];
    if (resolvedParts.length > 0) {
      resolvedItems.push({
        ...baseItem,
        parts: resolvedParts,
      });
    }
  }

  return resolvedItems;
}

async function resolveItemMedia(params: {
  descriptors: MediaDescriptor[];
  tomoriState: TomoriState;
  capabilities: MediaCapabilities;
  hasVisionTool: boolean;
  expandToolMacros: (text: string) => Promise<string>;
  messageId?: string;
}): Promise<{ mediaParts: ContextPart[]; systemParts: ContextPart[] }> {
  const mediaParts: ContextPart[] = [];
  const systemParts: ContextPart[] = [];
  const outsideWindow = params.descriptors.filter((descriptor) => !descriptor.withinWindow);

  if (outsideWindow.length > 0) {
    systemParts.push(resolveOutsideWindowNotice(outsideWindow, params.capabilities));
    return { mediaParts, systemParts };
  }

  const imageDescriptors = params.descriptors.filter((descriptor) => descriptor.kind === "image");
  if (imageDescriptors.length > 0) {
    if (params.capabilities.seesImages) {
      mediaParts.push(...materializeImageParts(imageDescriptors, params.messageId));
    } else {
      systemParts.push({
        type: "text",
        text: params.hasVisionTool
          ? await params.expandToolMacros(
              `[System: This message (${buildMediaIdLabel(imageDescriptors)}) contains ${buildImageDescription(imageDescriptors)}. Do not guess the image contents. Use the {image_analysis_tool} tool with this media ID only if the user explicitly asks about the image or if unseen visual details are necessary to answer correctly. The media ID can also be used with tools that accept media references.]`,
            )
          : `[System: This message (${buildMediaIdLabel(imageDescriptors)}) contains ${buildImageDescription(imageDescriptors)}. Current model cannot see images, please do not describe or claim to see the image contents. If you need to see images, tell the user to setup \`/model vision\` or to use a different model with the "vision" capability. The media ID can still be used with tools that accept media references.]`,
      });
      log.info(
        `Images skipped for message ${params.messageId ?? imageDescriptors[0]?.mediaId ?? "unknown"} - model does not support images (visionTool=${params.hasVisionTool})`,
      );
    }
  }

  const videoDescriptors = params.descriptors.filter((descriptor) => descriptor.kind === "video");
  if (videoDescriptors.length > 0) {
    if (params.capabilities.seesVideos) {
      mediaParts.push(...materializeVideoParts(videoDescriptors, params.messageId));
    } else {
      systemParts.push({
        type: "text",
        text: `[System: This message (${buildMediaIdLabel(videoDescriptors)}) contains ${buildVideoDescription(videoDescriptors)}. Current model cannot see videos, please do not describe or claim to see the video contents. The media ID can still be used with tools that accept media references.]`,
      });
      log.info(
        `Videos skipped for message ${params.messageId ?? videoDescriptors[0]?.mediaId ?? "unknown"} - model does not support videos`,
      );
    }
  }

  return { mediaParts, systemParts };
}

function resolveOutsideWindowNotice(descriptors: MediaDescriptor[], capabilities: MediaCapabilities): ContextPart {
  const description = buildMediaDescriptionFromDescriptors(descriptors);
  const viewableOutsideWindow = descriptors.some((descriptor) =>
    descriptor.kind === "image" ? capabilities.seesImages : capabilities.seesVideos,
  );

  // Replying re-attaches a referenced message's media to the reply itself, which is always
  // inside the window, so it is the only way back to media this far up the history.
  if (viewableOutsideWindow) {
    return {
      type: "text",
      text: `[System: This message (${buildMediaIdLabel(descriptors)}) contained ${description}, but it is outside the current media context window. Ask the user to reply to that message if you need to see it. The media ID can still be used with tools that accept media references.]`,
    };
  }

  return {
    type: "text",
    text: `[System: This message (${buildMediaIdLabel(descriptors)}) contained ${description}, but it is outside the current media context window and cannot be viewed by the current model. The media ID can still be used with tools that accept media references.]`,
  };
}

function resolveEffectiveMediaCapabilities(tomoriState: TomoriState): MediaCapabilities {
  const baseCapabilities = {
    seesImages: tomoriState.llm.sees_images,
    seesVideos: tomoriState.llm.sees_videos,
  };

  if (
    tomoriState.llm.llm_provider !== "openrouter" ||
    tomoriState.llm.llm_codename === "other-model" ||
    !isOpenRouterCapabilityCacheReady()
  ) {
    return baseCapabilities;
  }

  const apiCapabilities = getOpenRouterCapabilities(tomoriState.llm.llm_codename);
  if (!apiCapabilities) {
    return baseCapabilities;
  }

  return {
    seesImages: apiCapabilities.seesImages,
    seesVideos: apiCapabilities.seesVideos,
  };
}

function materializeImageParts(descriptors: MediaDescriptor[], messageId: string | undefined): ContextPart[] {
  const parts: ContextPart[] = [];
  for (const descriptor of descriptors) {
    if (!descriptor.mimeType) {
      log.warn(
        `Skipping image attachment due to missing mimeType: ${descriptor.filename ?? "unknown"} from message ${messageId ?? descriptor.mediaId}`,
      );
      continue;
    }

    parts.push({
      type: "image",
      uri: descriptor.uri,
      mimeType: descriptor.mimeType,
      ...(descriptor.fallbackUri && { fallbackUri: descriptor.fallbackUri }),
    });
  }
  return parts;
}

function materializeVideoParts(descriptors: MediaDescriptor[], messageId: string | undefined): ContextPart[] {
  const parts: ContextPart[] = [];
  for (const descriptor of descriptors) {
    if (!descriptor.mimeType) {
      log.warn(
        `Skipping video attachment due to missing mimeType: ${descriptor.filename ?? "unknown"} from message ${messageId ?? descriptor.mediaId}`,
      );
      continue;
    }

    parts.push({
      type: "video",
      uri: descriptor.uri,
      mimeType: descriptor.mimeType,
      isYouTubeLink: descriptor.isYouTubeLink,
    });
  }
  return parts;
}

function buildImageDescription(descriptors: MediaDescriptor[]): string {
  const imageCount = descriptors.length;
  const hasGif = descriptors.some(isGifDescriptor);
  if (hasGif && imageCount === 1) return "a GIF";
  if (hasGif) return `${imageCount} images (including GIF)`;
  return imageCount === 1 ? "an image" : `${imageCount} images`;
}

function buildVideoDescription(descriptors: MediaDescriptor[]): string {
  return descriptors.length === 1 ? "a video" : `${descriptors.length} videos`;
}

function buildMediaIdLabel(descriptors: MediaDescriptor[]): string {
  const mediaIds = Array.from(new Set(descriptors.map((descriptor) => descriptor.mediaId).filter(Boolean)));
  if (mediaIds.length === 0) return "ID: unknown";
  return mediaIds.length === 1 ? `ID: ${mediaIds[0]}` : `IDs: ${mediaIds.join(", ")}`;
}

function buildMediaDescriptionFromDescriptors(descriptors: MediaDescriptor[]): string {
  const imageDescriptors = descriptors.filter((descriptor) => descriptor.kind === "image");
  const videoDescriptors = descriptors.filter((descriptor) => descriptor.kind === "video");
  const hasGif = imageDescriptors.some(isGifDescriptor);
  const mediaParts: string[] = [];

  if (imageDescriptors.length > 0) {
    if (hasGif && imageDescriptors.length === 1) {
      mediaParts.push("1 GIF");
    } else if (hasGif) {
      mediaParts.push(`${imageDescriptors.length} image${imageDescriptors.length > 1 ? "s" : ""} (including GIF)`);
    } else {
      mediaParts.push(`${imageDescriptors.length} image${imageDescriptors.length > 1 ? "s" : ""}`);
    }
  }

  if (videoDescriptors.length > 0) {
    mediaParts.push(`${videoDescriptors.length} video${videoDescriptors.length > 1 ? "s" : ""}`);
  }

  return mediaParts.join(" and ");
}

function isGifDescriptor(descriptor: MediaDescriptor): boolean {
  return descriptor.mimeType?.includes("gif") || descriptor.filename?.toLowerCase().endsWith(".gif") || false;
}

function cloneParts(parts: ContextPart[]): ContextPart[] {
  return parts.map((part) => ({ ...part }));
}

function withoutMediaDescriptors(item: StructuredContextItem, parts: ContextPart[]): StructuredContextItem {
  const { mediaDescriptors: _mediaDescriptors, ...rest } = item;
  return { ...rest, parts };
}
