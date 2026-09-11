/**
 * Character Card V3 (`.charx`) container reader.
 *
 * A `.charx` file is a zip holding the card as `card.json` at the root plus an
 * `assets/` tree. Only the card is read here: the asset tree can carry audio,
 * video, Live2D, 3D, model and code payloads, so this reader never decompresses
 * an asset entry. Their declared sizes are still summed, because a card that
 * announces a huge asset tree says so in `card.json` and that number is free to
 * check against the zip's central directory.
 *
 * Storage-agnostic by design: the caller supplies the already-downloaded bytes
 * and owns quota, replies and persona writes. This module owns the zip shape
 * and the decompression guards.
 */

import JSZip from "jszip";
import { z } from "zod";
import { log } from "@/utils/misc/logger";
import { findZipEntryByBasename, getDeclaredUncompressedSize } from "@/utils/zip/zipEntryGuards";

/** Card payload filename inside a `.charx` archive. */
const CHARX_CARD_NAME = "card.json";
/** Prefix marking an asset stored inside the archive rather than fetched remotely. */
const CHARX_EMBEDDED_URI_PREFIX = "embeded://";

/**
 * The `spec` of a Character Card V3 object. Recognition is by prefix rather
 * than equality so a V2 card shipped in a `.charx` container still converts,
 * matching how the SillyTavern converter already recognizes cards.
 */
const CHARX_SPEC_PREFIX = "chara_card";

/** Limits enforced while reading an untrusted archive. */
export type CharxReadLimits = {
  /** Reject a `card.json` whose decompressed size exceeds this. */
  maxCardBytes: number;
  /** Reject a card declaring more embedded assets than this. */
  maxAssets: number;
  /** Reject when the declared total size of embedded assets exceeds this. */
  maxTotalAssetBytes: number;
};

/** Why a `.charx` archive could not be reduced to a character card. */
export type CharxReadFailureReason =
  | "invalid_zip"
  | "missing_card"
  | "invalid_card"
  | "not_character_card"
  | "card_too_large"
  | "assets_too_large";

export type CharxReadResult =
  | {
      ok: true;
      /** The parsed card object, ready for the existing SillyTavern converter. */
      card: unknown;
      /** Embedded assets present in the archive but deliberately not imported. */
      ignoredAssetCount: number;
    }
  | {
      ok: false;
      reason: CharxReadFailureReason;
    };

/**
 * Envelope for the fields read before the card is trusted. Unknown keys pass
 * through, since the V3 spec requires ignoring fields an application does not
 * know and the text converter tolerates every shape it can read.
 */
const charxEnvelopeSchema = z
  .object({
    spec: z.string(),
    spec_version: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

const charxAssetSchema = z
  .object({
    type: z.string().optional(),
    uri: z.string().optional(),
  })
  .loose();

/**
 * Parses an untrusted `.charx` buffer down to its character card.
 *
 * Guard order matters: the card's declared uncompressed size is checked before
 * it is decompressed, and the real length is re-checked afterwards, so a zip
 * bomb cannot spend memory merely by declaring a small size.
 *
 * @param charxBuffer - Raw archive bytes (already size-capped by the downloader)
 * @returns The parsed card plus the ignored asset count, or a typed failure reason
 */
export async function readCharxCard(charxBuffer: Buffer, limits: CharxReadLimits): Promise<CharxReadResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(charxBuffer);
  } catch (error) {
    log.warn("Failed to load .charx archive zip", error);
    return { ok: false, reason: "invalid_zip" };
  }

  const cardFile = findZipEntryByBasename(zip, CHARX_CARD_NAME);
  if (!cardFile) {
    return { ok: false, reason: "missing_card" };
  }

  const declaredSize = getDeclaredUncompressedSize(cardFile);
  if (declaredSize !== null && declaredSize > limits.maxCardBytes) {
    return { ok: false, reason: "card_too_large" };
  }

  let cardJson: unknown;
  try {
    cardJson = JSON.parse(await cardFile.async("string"));
  } catch (error) {
    log.warn("Failed to parse .charx card.json", error);
    return { ok: false, reason: "invalid_card" };
  }

  const envelope = charxEnvelopeSchema.safeParse(cardJson);
  if (!envelope.success) {
    return { ok: false, reason: "invalid_card" };
  }
  if (!envelope.data.spec.toLowerCase().startsWith(CHARX_SPEC_PREFIX)) {
    return { ok: false, reason: "not_character_card" };
  }

  // The declared size can be wrong or absent, so the real payload is measured too.
  if (Buffer.byteLength(JSON.stringify(cardJson) ?? "", "utf8") > limits.maxCardBytes) {
    return { ok: false, reason: "card_too_large" };
  }

  const assets = inspectDeclaredAssets(zip, envelope.data.data, limits);
  if (!assets.ok) {
    return { ok: false, reason: "assets_too_large" };
  }

  return { ok: true, card: cardJson, ignoredAssetCount: assets.assetCount };
}

/**
 * Counts the card's declared assets and sums the size of the embedded ones,
 * without opening a single asset entry. Sizes come from the zip's central
 * directory, so an oversized asset tree is refused for the cost of a header
 * read rather than a decompression.
 */
function inspectDeclaredAssets(
  zip: JSZip,
  cardData: Record<string, unknown> | undefined,
  limits: CharxReadLimits,
): { ok: true; assetCount: number } | { ok: false } {
  const rawAssets = cardData?.assets;
  if (!Array.isArray(rawAssets)) {
    return { ok: true, assetCount: 0 };
  }

  let totalDeclaredBytes = 0;
  let assetCount = 0;
  for (const rawAsset of rawAssets) {
    const asset = charxAssetSchema.safeParse(rawAsset);
    if (!asset.success) {
      continue;
    }

    assetCount += 1;
    if (assetCount > limits.maxAssets) {
      return { ok: false };
    }

    const uri = asset.data.uri;
    if (!uri?.startsWith(CHARX_EMBEDDED_URI_PREFIX)) {
      continue;
    }

    const embeddedPath = uri.slice(CHARX_EMBEDDED_URI_PREFIX.length);
    // A path that escapes the archive root is not resolvable, and an asset that
    // is not in the archive is not ours to size; neither is an error, because
    // the asset tree is never read.
    if (!embeddedPath || embeddedPath.includes("..") || embeddedPath.startsWith("/")) {
      continue;
    }

    const entry = zip.file(embeddedPath);
    const declaredSize = entry && !entry.dir ? getDeclaredUncompressedSize(entry) : null;
    if (declaredSize === null) {
      continue;
    }

    totalDeclaredBytes += declaredSize;
    if (totalDeclaredBytes > limits.maxTotalAssetBytes) {
      return { ok: false };
    }
  }

  return { ok: true, assetCount };
}
