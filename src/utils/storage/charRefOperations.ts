import type { APIAttachment } from "discord.js";
import { convertToPNG } from "@/utils/image/imageProcessor";
import { log } from "@/utils/misc/logger";
import { MEDIA_LIMITS } from "@/utils/security/rateLimiter";
import { safeDownload } from "@/utils/security/safeDownload";
import { deleteCharRef, uploadCharRef, type CharRefEntityType } from "@/utils/storage/charrefStorage";

/**
 * The attachment fields this path actually reads. Both a discord.js `Attachment` and a raw
 * `APIAttachment` satisfy it structurally, so neither caller needs a cast to reach the shared
 * preparation logic.
 */
export interface CharRefAttachmentSource {
  contentType: string | null;
  size: number;
  url: string;
}

export type UploadPreparationResult =
  | { success: true; buffer: Buffer }
  | {
      success: false;
      titleKey: string;
      descriptionKey: string;
    };

export async function prepareAttachmentForStorage(
  attachment: CharRefAttachmentSource,
): Promise<UploadPreparationResult> {
  if (!attachment.contentType?.startsWith("image/")) {
    return {
      success: false,
      titleKey: "commands.novelai.character-reference.invalid_image_title",
      descriptionKey: "commands.novelai.character-reference.invalid_image_description",
    };
  }

  let sourceBuffer: Buffer;
  try {
    const response = await safeDownload(attachment.url, {
      maxSizeMB: MEDIA_LIMITS.MAX_MEDIA_SIZE_MB,
      timeoutMs: 10_000,
      knownSize: attachment.size,
    });
    if (!response.success || !response.buffer) {
      return {
        success: false,
        titleKey: "commands.novelai.character-reference.download_failed_title",
        descriptionKey: "commands.novelai.character-reference.download_failed_description",
      };
    }

    sourceBuffer = response.buffer;
  } catch (error) {
    log.warn("Failed to download NovelAI character reference attachment", error);
    return {
      success: false,
      titleKey: "commands.novelai.character-reference.download_failed_title",
      descriptionKey: "commands.novelai.character-reference.download_failed_description",
    };
  }

  try {
    return {
      success: true,
      buffer: await convertToPNG(sourceBuffer),
    };
  } catch (error) {
    log.warn("Failed to convert NovelAI character reference attachment to PNG", error);
    return {
      success: false,
      titleKey: "commands.novelai.character-reference.conversion_failed_title",
      descriptionKey: "commands.novelai.character-reference.conversion_failed_description",
    };
  }
}

export async function prepareApiAttachmentForStorage(attachment: APIAttachment): Promise<UploadPreparationResult> {
  return prepareAttachmentForStorage({
    contentType: attachment.content_type ?? null,
    size: attachment.size,
    url: attachment.url,
  });
}

export async function replaceStoredCharReference(options: {
  entityType: CharRefEntityType;
  entityId: string | number;
  previousRef: string | null;
  nextBuffer: Buffer | null;
  persistNextRef: (nextRef: string | null) => Promise<boolean>;
  onPersistSuccess: () => void;
}): Promise<boolean> {
  let nextRef: string | null = null;

  if (options.nextBuffer) {
    nextRef = await uploadCharRef({
      entityType: options.entityType,
      entityId: options.entityId,
      buffer: options.nextBuffer,
    });

    if (!nextRef) {
      return false;
    }
  }

  const persisted = await options.persistNextRef(nextRef);
  if (!persisted) {
    if (nextRef) {
      await deleteCharRef(nextRef);
    }
    return false;
  }

  options.onPersistSuccess();

  if (options.previousRef && options.previousRef !== nextRef) {
    await deleteCharRef(options.previousRef);
  }

  return true;
}
