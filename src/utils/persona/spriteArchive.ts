/**
 * Persona sprite archive (.zip) build/parse utilities.
 *
 * A sprite archive bundles a persona's sprite images together with a
 * `manifest.json` describing each sprite's metadata. This keeps `/persona
 * export` lightweight (it only carries the persona card) while still letting
 * users share a character's full sprite set as one portable file.
 *
 * This module is intentionally storage-agnostic: callers supply already-loaded
 * PNG buffers when building, and receive validated buffers when parsing. The
 * commands own all storage/download concerns; this module owns only the ZIP
 * container shape, the manifest schema, and the ZIP-bomb guards.
 */

import JSZip from "jszip";
import { z } from "zod";
import type { PersonaSpriteRow } from "@/types/db/schema";
import { sanitizeAttachmentFilenamePart } from "@/utils/discord/attachmentFilename";
import { log } from "@/utils/misc/logger";
import { getDeclaredUncompressedSize, resolveZipEntryFile } from "@/utils/zip/zipEntryGuards";

/** Current archive format version. Bump when the manifest shape changes. */
const SPRITE_ARCHIVE_VERSION = 1;
/** Discriminator stored in the manifest so unrelated zips are rejected early. */
const SPRITE_ARCHIVE_EXPORT_TYPE = "persona_sprites";
/** Canonical manifest filename inside the archive. */
const SPRITE_ARCHIVE_MANIFEST_NAME = "manifest.json";
/** Folder (inside the zip) that holds the sprite images. */
const SPRITE_ARCHIVE_IMAGE_DIR = "sprites";

/**
 * A single sprite entry as stored in `manifest.json`. Mirrors the importable
 * subset of `PersonaSpriteRow` (storage references and DB ids are intentionally
 * excluded because they are meaningless on another server).
 */
const spriteArchiveEntrySchema = z.object({
  sprite_name: z.string().min(1).max(64),
  sprite_key: z.string().min(1).max(64),
  usage_instructions: z.string().max(1000).default(""),
  is_identity: z.boolean().default(false),
  file: z.string().min(1).max(256),
});

type SpriteArchiveEntry = z.infer<typeof spriteArchiveEntrySchema>;

/** Full `manifest.json` schema. */
const spriteArchiveManifestSchema = z.object({
  export_type: z.literal(SPRITE_ARCHIVE_EXPORT_TYPE),
  version: z.number().int().positive(),
  exported_at: z.string().optional(),
  // Source persona is informational only (display + suggested filename); the
  // importer always picks an explicit target persona, so this is never trusted.
  source_persona: z
    .object({
      nickname: z.string().optional(),
      persona_id: z.number().int().optional(),
    })
    .optional(),
  sprites: z.array(spriteArchiveEntrySchema),
});

type SpriteArchiveManifest = z.infer<typeof spriteArchiveManifestSchema>;

/** A built archive's bytes plus the metadata callers need for the reply. */
export type BuiltSpriteArchive = {
  buffer: Buffer;
  spriteCount: number;
};

/** One sprite to bundle: its DB row plus its already-loaded PNG bytes. */
export type SpriteArchiveBuildEntry = {
  sprite: PersonaSpriteRow;
  pngBuffer: Buffer;
};

/** Limits enforced while parsing an untrusted archive (ZIP-bomb defense). */
export type SpriteArchiveReadLimits = {
  /** Reject archives whose manifest lists more than this many sprites. */
  maxEntries: number;
  /** Reject any single image larger than this (decompressed). */
  maxFileBytes: number;
  /** Reject when the running total of decompressed images exceeds this. */
  maxTotalBytes: number;
};

/** A validated, parsed archive ready for import. */
type SpriteArchiveReadEntry = {
  meta: SpriteArchiveEntry;
  pngBuffer: Buffer;
};

export type SpriteArchiveReadResult =
  | {
      ok: true;
      sourceNickname: string | null;
      entries: SpriteArchiveReadEntry[];
    }
  | {
      ok: false;
      reason:
        | "invalid_zip"
        | "missing_manifest"
        | "invalid_manifest"
        | "incompatible_version"
        | "empty"
        | "too_many_entries"
        | "missing_image"
        | "file_too_large"
        | "total_too_large";
    };

/**
 * Builds a sprite archive (.zip) buffer from a persona's sprites.
 *
 * Image filenames are generated deterministically (`sprites/NN-{key}.png`) so
 * the archive layout is stable and human-browsable; the manifest is the source
 * of truth for which image maps to which sprite.
 *
 * @param options.personaNickname - Source persona name (display + filename hint)
 * @param options.personaId - Source persona id (informational only)
 * @param options.entries - Sprites to bundle, each with its loaded PNG bytes
 * @returns The zip bytes and the count actually written
 */
export async function buildSpriteArchive(options: {
  personaNickname: string;
  personaId: number;
  entries: SpriteArchiveBuildEntry[];
}): Promise<BuiltSpriteArchive> {
  const zip = new JSZip();
  const imageFolder = zip.folder(SPRITE_ARCHIVE_IMAGE_DIR);
  if (!imageFolder) {
    // JSZip.folder only returns null on an invalid name; our constant is valid,
    // so this is effectively unreachable but typed defensively.
    throw new Error("Failed to create sprite image folder in archive");
  }

  const manifestEntries: SpriteArchiveEntry[] = [];
  const usedFilenames = new Set<string>();
  options.entries.forEach((entry, index) => {
    const filename = buildUniqueImageFilename(entry.sprite, index, usedFilenames);
    imageFolder.file(filename, entry.pngBuffer);
    manifestEntries.push({
      sprite_name: entry.sprite.sprite_name,
      sprite_key: entry.sprite.sprite_key,
      usage_instructions: entry.sprite.usage_instructions ?? "",
      is_identity: entry.sprite.is_identity ?? false,
      file: `${SPRITE_ARCHIVE_IMAGE_DIR}/${filename}`,
    });
  });

  const manifest: SpriteArchiveManifest = {
    export_type: SPRITE_ARCHIVE_EXPORT_TYPE,
    version: SPRITE_ARCHIVE_VERSION,
    exported_at: new Date().toISOString(),
    source_persona: {
      nickname: options.personaNickname,
      persona_id: options.personaId,
    },
    sprites: manifestEntries,
  };
  zip.file(SPRITE_ARCHIVE_MANIFEST_NAME, `${JSON.stringify(manifest, null, 2)}\n`);

  // Generate the bytes. DEFLATE is cheap here (PNGs are already compressed,
  //    but the manifest and any incidental redundancy still benefit).
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });

  return {
    buffer: buffer as Buffer,
    spriteCount: manifestEntries.length,
  };
}

/**
 * Parses and validates an untrusted sprite archive buffer.
 *
 * Performs layered validation: zip integrity -> manifest presence/shape ->
 * version compatibility -> per-entry image presence and size guards. No image
 * bytes are returned until every guard has passed for that entry, and the
 * running decompressed total is checked so a malicious archive cannot exhaust
 * memory even within the (already capped) compressed download size.
 *
 * @param zipBuffer - Raw archive bytes (already size-capped by the downloader)
 * @returns A discriminated result: validated entries, or a typed failure reason
 */
export async function readSpriteArchive(
  zipBuffer: Buffer,
  limits: SpriteArchiveReadLimits,
): Promise<SpriteArchiveReadResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipBuffer);
  } catch (error) {
    log.warn("Failed to load sprite archive zip", error);
    return { ok: false, reason: "invalid_zip" };
  }

  // Locate the manifest (case-insensitive, ignoring any folder prefix some
  //    archivers add) and parse it as JSON.
  const manifestFile = findManifestFile(zip);
  if (!manifestFile) {
    return { ok: false, reason: "missing_manifest" };
  }

  let manifestJson: unknown;
  try {
    const manifestText = await manifestFile.async("string");
    manifestJson = JSON.parse(manifestText);
  } catch (error) {
    log.warn("Failed to parse sprite archive manifest JSON", error);
    return { ok: false, reason: "invalid_manifest" };
  }

  const parsedManifest = spriteArchiveManifestSchema.safeParse(manifestJson);
  if (!parsedManifest.success) {
    log.warn(`Invalid sprite archive manifest: ${parsedManifest.error.message}`);
    return { ok: false, reason: "invalid_manifest" };
  }
  const manifest = parsedManifest.data;

  // Reject archives produced by a newer, incompatible format version.
  if (manifest.version > SPRITE_ARCHIVE_VERSION) {
    return { ok: false, reason: "incompatible_version" };
  }

  if (manifest.sprites.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (manifest.sprites.length > limits.maxEntries) {
    return { ok: false, reason: "too_many_entries" };
  }

  const entries: SpriteArchiveReadEntry[] = [];
  let totalBytes = 0;
  for (const meta of manifest.sprites) {
    const imageFile = resolveZipEntryFile(zip, meta.file);
    if (!imageFile) {
      return { ok: false, reason: "missing_image" };
    }

    // Best-effort pre-read size check using JSZip's declared uncompressed
    //     size, so an oversized entry is rejected before it is decompressed.
    const declaredSize = getDeclaredUncompressedSize(imageFile);
    if (declaredSize !== null && declaredSize > limits.maxFileBytes) {
      return { ok: false, reason: "file_too_large" };
    }

    const pngBuffer = (await imageFile.async("nodebuffer")) as Buffer;

    if (pngBuffer.length > limits.maxFileBytes) {
      return { ok: false, reason: "file_too_large" };
    }
    totalBytes += pngBuffer.length;
    if (totalBytes > limits.maxTotalBytes) {
      return { ok: false, reason: "total_too_large" };
    }

    entries.push({ meta, pngBuffer });
  }

  return {
    ok: true,
    sourceNickname: manifest.source_persona?.nickname ?? null,
    entries,
  };
}

/**
 * Builds a stable, collision-free image filename for a sprite.
 * Pattern: `NN-{sanitized-key}.png` (1-based, zero-padded index).
 */
function buildUniqueImageFilename(sprite: PersonaSpriteRow, index: number, used: Set<string>): string {
  const prefix = String(index + 1).padStart(2, "0");
  const safeKey = sanitizeAttachmentFilenamePart(sprite.sprite_key, {
    fallback: "sprite",
    maxLength: 40,
  });
  let filename = `${prefix}-${safeKey}.png`;
  // Guard against the (rare) case where sanitization collapses two keys to the
  // same string; the index prefix already makes this near-impossible, but stay
  // defensive so no image silently overwrites another.
  let suffix = 1;
  while (used.has(filename)) {
    filename = `${prefix}-${safeKey}-${suffix}.png`;
    suffix += 1;
  }
  used.add(filename);
  return filename;
}

/** Finds the manifest file regardless of casing or a wrapping folder. */
function findManifestFile(zip: JSZip): JSZip.JSZipObject | null {
  return resolveZipEntryFile(zip, SPRITE_ARCHIVE_MANIFEST_NAME);
}
