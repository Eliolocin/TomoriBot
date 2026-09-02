import type { APIAttachment } from "discord.js";
import type { PersonaSpriteRow, TomoriState } from "@/types/db/schema";
import { invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { personaSpriteRepository } from "@/utils/db/repositories";
import { sanitizeAttachmentFilenamePart } from "@/utils/discord/attachmentFilename";
import { convertToPNG } from "@/utils/image/imageProcessor";
import { log } from "@/utils/misc/logger";
import { forkPointerForAvatarChange } from "@/utils/persona/pointerFork";
import { buildSpriteArchive, readSpriteArchive, type SpriteArchiveBuildEntry } from "@/utils/persona/spriteArchive";
import {
  downloadPersonaSpriteImageAttachment,
  validatePersonaSpriteImageAttachment,
} from "@/utils/persona/spriteImages";
import {
  isPersonaSpriteInstructionsTooLong,
  normalizePersonaSpriteInstructions,
  PERSONA_SPRITE_LIMITS,
  validatePersonaSpriteName,
} from "@/utils/persona/sprites";
import {
  IMPORT_LIMITS,
  PERSONA_LIMITS,
  memoryGuard,
  reserveAvatarQuota,
  reserveImportQuota,
} from "@/utils/security/rateLimiter";
import { safeDownload } from "@/utils/security/safeDownload";
import {
  deletePersonaSpriteFromStorage,
  loadStoredPersonaAvatarBuffer,
  uploadPersonaSpriteToStorage,
} from "@/utils/storage/avatarStorage";

const ARCHIVE_DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_ARCHIVE_BYTES = IMPORT_LIMITS.MAX_PERSONA_IMPORT_SIZE_MB * 1024 * 1024;
const MAX_IMAGE_BYTES = PERSONA_LIMITS.MAX_AVATAR_SIZE_MB * 1024 * 1024;

type SpriteNameFailure = { status: "invalid-name"; reason: "empty" | "too_long" | "invalid_chars" };
type SpriteImageFailure = { status: "invalid-image"; reason: "file_too_large" | "invalid_format" };
type SpriteTransferFailure =
  | { status: "memory-critical" }
  | { status: "quota-exceeded"; resetAt: number | null }
  | { status: "download-failed"; reason: "timeout" | "download_failed" }
  | { status: "conversion-failed" }
  | { status: "upload-failed" }
  | { status: "write-failed" };

export type ConfigSpriteAddResult =
  | { status: "success"; spriteName: string; replaced: boolean }
  | SpriteNameFailure
  | SpriteImageFailure
  | SpriteTransferFailure
  | { status: "instructions-too-long" }
  | { status: "limit-reached" };

export type ConfigSpriteEditResult =
  | { status: "success"; spriteName: string }
  | SpriteNameFailure
  | SpriteImageFailure
  | SpriteTransferFailure
  | { status: "instructions-too-long" }
  | { status: "duplicate-name"; spriteName: string }
  | { status: "no-changes" }
  | { status: "not-found" };

export type ConfigSpriteRemoveResult =
  | { status: "success"; spriteName: string }
  | { status: "not-found" }
  | { status: "write-failed" };

export type ConfigSpriteImportResult =
  | { status: "success"; created: number; replaced: number; failed: number }
  | { status: "invalid-file" }
  | { status: "file-too-large" }
  | { status: "invalid-archive"; reason: string }
  | { status: "invalid-entry-name"; spriteName: string }
  | { status: "invalid-entry-image"; spriteName: string }
  | { status: "limit-reached"; currentCount: number; incomingCount: number }
  | { status: "memory-critical" }
  | { status: "quota-exceeded"; resetAt: number | null }
  | { status: "download-failed" }
  | { status: "write-failed" };

export type ConfigSpriteExportResult =
  | { status: "success"; buffer: Buffer; filename: string; spriteCount: number; skippedCount: number }
  | { status: "no-sprites" }
  | { status: "all-images-failed" }
  | { status: "memory-critical" };

export interface ConfigSpriteOperations {
  addSprite(input: {
    persona: TomoriState;
    serverDiscId: string;
    rawName: string;
    rawInstructions: string;
    isIdentity: boolean;
    attachment: APIAttachment | null;
  }): Promise<ConfigSpriteAddResult>;
  editSprite(input: {
    persona: TomoriState;
    serverDiscId: string;
    currentSpriteKey: string;
    rawName: string;
    rawInstructions: string;
    isIdentity: boolean;
    attachment: APIAttachment | null;
  }): Promise<ConfigSpriteEditResult>;
  removeSprite(input: {
    persona: TomoriState;
    serverDiscId: string;
    spriteKey: string;
  }): Promise<ConfigSpriteRemoveResult>;
  importSprites(input: {
    persona: TomoriState;
    serverDiscId: string;
    quotaKey: string;
    attachment: APIAttachment | null;
  }): Promise<ConfigSpriteImportResult>;
  exportSprites(input: { persona: TomoriState }): Promise<ConfigSpriteExportResult>;
}

/**
 * Materializes a preset-pointer persona so a sprite write lands on rows it owns.
 *
 * A pointer persona resolves the shared preset sprite set and owns no `persona_sprites` rows, so a
 * write issued before the fork would match nothing. The extra TomoriState invalidation runs only
 * when a fork actually happened, because that changes the persona row itself rather than its
 * sprites, which `personaSpriteRepository` already invalidates on every mutation.
 */
async function materializeForSpriteWrite(persona: TomoriState, serverDiscId: string): Promise<boolean> {
  const wasPointer = persona.is_pointer === true;
  if (!(await forkPointerForAvatarChange(persona))) return false;
  if (wasPointer) invalidateTomoriStateCache(serverDiscId);
  return true;
}

async function downloadAndConvert(
  attachment: APIAttachment,
): Promise<{ ok: true; buffer: Buffer } | { ok: false; failure: SpriteTransferFailure }> {
  const downloaded = await downloadPersonaSpriteImageAttachment(attachment);
  if (!downloaded.ok) return { ok: false, failure: { status: "download-failed", reason: downloaded.reason } };

  try {
    return { ok: true, buffer: await convertToPNG(downloaded.buffer) };
  } catch (error) {
    log.warn("Failed to convert persona sprite image to PNG", error);
    return { ok: false, failure: { status: "conversion-failed" } };
  }
}

export const configSpriteOperations: ConfigSpriteOperations = {
  async addSprite({ persona, serverDiscId, rawName, rawInstructions, isIdentity, attachment }) {
    const personaId = persona.persona_id;
    if (!personaId) return { status: "write-failed" };

    const nameValidation = validatePersonaSpriteName(rawName);
    if (!nameValidation.ok) return { status: "invalid-name", reason: nameValidation.reason };

    const usageInstructions = normalizePersonaSpriteInstructions(rawInstructions);
    if (isPersonaSpriteInstructionsTooLong(usageInstructions)) return { status: "instructions-too-long" };

    if (!attachment) return { status: "invalid-image", reason: "invalid_format" };
    const imageValidation = validatePersonaSpriteImageAttachment(attachment);
    if (!imageValidation.ok) return { status: "invalid-image", reason: imageValidation.reason };

    if (memoryGuard.checkMemory().status === "critical") return { status: "memory-critical" };

    // The per-persona cap is checked before the quota reservation: avatar quota is a shared,
    // server-wide daily budget, so an add rejected for being over the cap must not spend a slot.
    const existingSprites = await personaSpriteRepository.listForPersona(personaId);
    const replacingExisting = existingSprites.some((sprite) => sprite.sprite_key === nameValidation.spriteKey);
    if (!replacingExisting && existingSprites.length >= PERSONA_SPRITE_LIMITS.MAX_PER_PERSONA) {
      return { status: "limit-reached" };
    }

    const quotaReserve = reserveAvatarQuota(serverDiscId);
    if (!quotaReserve.allowed) return { status: "quota-exceeded", resetAt: quotaReserve.resetAt ?? null };

    if (!(await materializeForSpriteWrite(persona, serverDiscId))) return { status: "write-failed" };

    const converted = await downloadAndConvert(attachment);
    if (!converted.ok) return converted.failure;

    const uploadedReference = await uploadPersonaSpriteToStorage({
      personaId,
      serverDiscId,
      label: nameValidation.displayName,
      buffer: converted.buffer,
    });
    if (!uploadedReference) return { status: "upload-failed" };

    const upsertResult = await personaSpriteRepository.upsertSprite({
      personaId,
      spriteName: nameValidation.displayName,
      spriteKey: nameValidation.spriteKey,
      avatarUrl: uploadedReference,
      usageInstructions,
      isIdentity,
    });
    if (!upsertResult) {
      await deletePersonaSpriteFromStorage(uploadedReference);
      return { status: "write-failed" };
    }

    if (upsertResult.previousAvatarUrl && upsertResult.previousAvatarUrl !== uploadedReference) {
      await deletePersonaSpriteFromStorage(upsertResult.previousAvatarUrl);
    }
    invalidateTomoriStateCache(serverDiscId);
    return { status: "success", spriteName: upsertResult.sprite.sprite_name, replaced: upsertResult.replaced };
  },

  async editSprite({ persona, serverDiscId, currentSpriteKey, rawName, rawInstructions, isIdentity, attachment }) {
    const personaId = persona.persona_id;
    if (!personaId) return { status: "write-failed" };

    const nameValidation = validatePersonaSpriteName(rawName);
    if (!nameValidation.ok) return { status: "invalid-name", reason: nameValidation.reason };

    const usageInstructions = normalizePersonaSpriteInstructions(rawInstructions);
    if (isPersonaSpriteInstructionsTooLong(usageInstructions)) return { status: "instructions-too-long" };

    if (attachment) {
      const imageValidation = validatePersonaSpriteImageAttachment(attachment);
      if (!imageValidation.ok) return { status: "invalid-image", reason: imageValidation.reason };
    }

    const sprites = await personaSpriteRepository.listForPersona(personaId);
    const selectedSprite = sprites.find((sprite) => sprite.sprite_key === currentSpriteKey);
    if (!selectedSprite) return { status: "not-found" };

    const duplicateKey = sprites.some(
      (sprite) => sprite.sprite_key !== currentSpriteKey && sprite.sprite_key === nameValidation.spriteKey,
    );
    if (duplicateKey) return { status: "duplicate-name", spriteName: nameValidation.displayName };

    const noChanges =
      nameValidation.displayName === selectedSprite.sprite_name &&
      usageInstructions === selectedSprite.usage_instructions.trim() &&
      isIdentity === selectedSprite.is_identity &&
      !attachment;
    if (noChanges) return { status: "no-changes" };

    if (attachment) {
      if (memoryGuard.checkMemory().status === "critical") return { status: "memory-critical" };
      const quotaReserve = reserveAvatarQuota(serverDiscId);
      if (!quotaReserve.allowed) return { status: "quota-exceeded", resetAt: quotaReserve.resetAt ?? null };
    }

    if (!(await materializeForSpriteWrite(persona, serverDiscId))) return { status: "write-failed" };

    let uploadedReference: string | null = null;
    if (attachment) {
      const converted = await downloadAndConvert(attachment);
      if (!converted.ok) return converted.failure;

      uploadedReference = await uploadPersonaSpriteToStorage({
        personaId,
        serverDiscId,
        label: nameValidation.displayName,
        buffer: converted.buffer,
      });
      if (!uploadedReference) return { status: "upload-failed" };
    }

    const updateResult = await personaSpriteRepository.updateSpriteMetadata({
      currentSpriteKey,
      personaId,
      spriteName: nameValidation.displayName,
      spriteKey: nameValidation.spriteKey,
      avatarUrl: uploadedReference ?? undefined,
      usageInstructions,
      isIdentity,
    });
    if (!updateResult) {
      if (uploadedReference) await deletePersonaSpriteFromStorage(uploadedReference);
      return { status: "write-failed" };
    }

    if (uploadedReference && updateResult.previousAvatarUrl && updateResult.previousAvatarUrl !== uploadedReference) {
      await deletePersonaSpriteFromStorage(updateResult.previousAvatarUrl);
    }
    invalidateTomoriStateCache(serverDiscId);
    return { status: "success", spriteName: updateResult.sprite.sprite_name };
  },

  async removeSprite({ persona, serverDiscId, spriteKey }) {
    const personaId = persona.persona_id;
    if (!personaId) return { status: "write-failed" };

    if (!(await materializeForSpriteWrite(persona, serverDiscId))) return { status: "write-failed" };

    const removedSprites = await personaSpriteRepository.deleteSpritesByKeys(personaId, [spriteKey]);
    // Nothing deleted is the concurrent-removal path: the sprite is already gone, so this reports a
    // stale selection rather than a success that removed nothing.
    if (removedSprites.length === 0) return { status: "not-found" };

    invalidateTomoriStateCache(serverDiscId);
    // The DELETE returns each row once, so one removal can never hand the same stored image to
    // storage twice.
    await Promise.all(removedSprites.map((sprite) => deletePersonaSpriteFromStorage(sprite.avatar_url)));
    return { status: "success", spriteName: removedSprites[0]?.sprite_name ?? spriteKey };
  },

  async importSprites({ persona, serverDiscId, quotaKey, attachment }) {
    const personaId = persona.persona_id;
    if (!personaId) return { status: "write-failed" };

    if (!attachment?.filename.toLowerCase().endsWith(".zip")) return { status: "invalid-file" };
    if (attachment.size > MAX_ARCHIVE_BYTES) return { status: "file-too-large" };

    // One import-operation slot covers the whole batch rather than one avatar-quota slot per sprite
    // inside it, because a batch import is a single operation.
    const quotaReserve = reserveImportQuota(quotaKey);
    if (!quotaReserve.allowed) return { status: "quota-exceeded", resetAt: quotaReserve.resetAt ?? null };

    if (memoryGuard.checkMemory().status === "critical") return { status: "memory-critical" };

    const download = await safeDownload(attachment.url, {
      maxSizeMB: IMPORT_LIMITS.MAX_PERSONA_IMPORT_SIZE_MB,
      timeoutMs: ARCHIVE_DOWNLOAD_TIMEOUT_MS,
      knownSize: attachment.size,
    });
    if (!download.success || !download.buffer) return { status: "download-failed" };

    const archive = await readSpriteArchive(download.buffer, {
      maxEntries: PERSONA_SPRITE_LIMITS.MAX_PER_PERSONA,
      maxFileBytes: MAX_IMAGE_BYTES,
      maxTotalBytes: PERSONA_SPRITE_LIMITS.MAX_PER_PERSONA * MAX_IMAGE_BYTES,
    });
    if (!archive.ok) return { status: "invalid-archive", reason: archive.reason };

    // Every name and image is validated before any storage or database write, so a bad entry aborts
    // the whole import cleanly. Two entries can normalize to one key, and the map keeps the last.
    const preparedByKey = new Map<
      string,
      { displayName: string; spriteKey: string; usageInstructions: string; isIdentity: boolean; pngBuffer: Buffer }
    >();
    for (const entry of archive.entries) {
      const nameValidation = validatePersonaSpriteName(entry.meta.sprite_name);
      if (!nameValidation.ok) return { status: "invalid-entry-name", spriteName: entry.meta.sprite_name };

      let pngBuffer: Buffer;
      try {
        pngBuffer = await convertToPNG(entry.pngBuffer);
      } catch (error) {
        log.warn(`Sprite import: image conversion failed for "${entry.meta.sprite_name}"`, error);
        return { status: "invalid-entry-image", spriteName: nameValidation.displayName };
      }

      preparedByKey.set(nameValidation.spriteKey, {
        displayName: nameValidation.displayName,
        spriteKey: nameValidation.spriteKey,
        usageInstructions: normalizePersonaSpriteInstructions(entry.meta.usage_instructions),
        isIdentity: entry.meta.is_identity,
        pngBuffer,
      });
    }
    const prepared = [...preparedByKey.values()];

    // All-or-nothing against the cap, counting only new keys: an existing key is an overwrite and
    // does not grow the set.
    const existingSprites = await personaSpriteRepository.listForPersona(personaId);
    const existingKeys = new Set(existingSprites.map((sprite) => sprite.sprite_key));
    const newKeyCount = prepared.filter((sprite) => !existingKeys.has(sprite.spriteKey)).length;
    if (existingKeys.size + newKeyCount > PERSONA_SPRITE_LIMITS.MAX_PER_PERSONA) {
      return { status: "limit-reached", currentCount: existingKeys.size, incomingCount: prepared.length };
    }

    if (!(await materializeForSpriteWrite(persona, serverDiscId))) return { status: "write-failed" };

    let created = 0;
    let replaced = 0;
    let failed = 0;
    for (const sprite of prepared) {
      const uploadedReference = await uploadPersonaSpriteToStorage({
        personaId,
        serverDiscId,
        label: sprite.displayName,
        buffer: sprite.pngBuffer,
      });
      if (!uploadedReference) {
        failed += 1;
        continue;
      }

      const upsertResult = await personaSpriteRepository.upsertSprite({
        personaId,
        spriteName: sprite.displayName,
        spriteKey: sprite.spriteKey,
        avatarUrl: uploadedReference,
        usageInstructions: sprite.usageInstructions,
        isIdentity: sprite.isIdentity,
      });
      if (!upsertResult) {
        // The cap already cleared, so this is a transient storage or database failure: roll this
        // entry's orphaned upload back and continue rather than losing the rest of a large batch.
        await deletePersonaSpriteFromStorage(uploadedReference);
        failed += 1;
        continue;
      }

      if (upsertResult.previousAvatarUrl && upsertResult.previousAvatarUrl !== uploadedReference) {
        await deletePersonaSpriteFromStorage(upsertResult.previousAvatarUrl);
      }
      if (upsertResult.replaced) replaced += 1;
      else created += 1;
    }

    invalidateTomoriStateCache(serverDiscId);
    return { status: "success", created, replaced, failed };
  },

  async exportSprites({ persona }) {
    const personaId = persona.persona_id;
    if (!personaId) return { status: "no-sprites" };

    const sprites = await personaSpriteRepository.listForPersona(personaId);
    if (sprites.length === 0) return { status: "no-sprites" };

    // Loading many stored images at once is the memory-heavy step of an export.
    if (memoryGuard.checkMemory().status === "critical") return { status: "memory-critical" };

    const buildEntries: SpriteArchiveBuildEntry[] = [];
    let skippedCount = 0;
    for (const sprite of sprites) {
      const buffer = await loadStoredPersonaAvatarBuffer(sprite.avatar_url);
      if (!buffer) {
        // One unreadable image is reported and skipped rather than failing the whole export.
        skippedCount += 1;
        log.warn(`Skipping sprite ${sprite.sprite_key} (persona ${personaId}); image could not be loaded for export`);
        continue;
      }
      try {
        buildEntries.push({ sprite, pngBuffer: await convertToPNG(buffer) });
      } catch (error) {
        skippedCount += 1;
        log.warn(`Skipping sprite ${sprite.sprite_key} (persona ${personaId}); PNG conversion failed`, error);
      }
    }
    if (buildEntries.length === 0) return { status: "all-images-failed" };

    const archive = await buildSpriteArchive({
      personaNickname: persona.persona_nickname,
      personaId,
      entries: buildEntries,
    });
    const sanitizedNickname = sanitizeAttachmentFilenamePart(persona.persona_nickname, {
      fallback: "persona",
      maxLength: 50,
    });
    return {
      status: "success",
      buffer: archive.buffer,
      filename: `${sanitizedNickname}-sprites-${Date.now()}.zip`,
      spriteCount: archive.spriteCount,
      skippedCount,
    };
  },
};

/**
 * The sprite list the panel renders and every sprite route resolves its position against.
 *
 * `listForPersona` orders by `sprite_key` and resolves a preset pointer to the shared set, so this
 * ordering is what makes a route's list position mean the same sprite on the next interaction.
 */
export async function loadPersonaSpriteList(personaId: number): Promise<PersonaSpriteRow[]> {
  return await personaSpriteRepository.listForPersona(personaId);
}
