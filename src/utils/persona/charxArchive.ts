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
import { getDeclaredUncompressedSize, resolveZipEntryFile } from "@/utils/zip/zipEntryGuards";

/** Card payload filename inside a `.charx` archive. */
const CHARX_CARD_NAME = "card.json";
/** Prefix marking an asset stored inside the archive rather than fetched remotely. */
const CHARX_EMBEDDED_URI_PREFIX = "embeded://";

/**
 * The card's `spec` value. Recognition is by prefix rather than equality so a V2
 * card shipped in a `.charx` container still converts, matching how the
 * SillyTavern converter already recognizes cards.
 */
const CHARX_SPEC_PREFIX = "chara_card";

/** Limits enforced while reading an untrusted archive. */
export type CharxReadLimits = {
  /** Reject a `card.json` whose decompressed size exceeds this. */
  maxCardBytes: number;
  /** Reject a card declaring more assets than this. */
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
      /**
       * Assets the archive actually carries but the import does not read.
       *
       * Only entries present in the archive count: a remote URL or the spec's
       * `ccdefault:` default is a reference, not bundled media, and reporting it
       * as dropped would describe a card that shipped nothing but its own text.
       */
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
 *
 * `spec` is optional because the converter, not this reader, owns card
 * recognition: it accepts a root-level V2 card with no `spec` at all, and a
 * container that refused one would be stricter than the format it carries.
 * The `spec` check below therefore only rejects a card that names a different
 * format, and never rejects on absence.
 */
const charxEnvelopeSchema = z
  .object({
    spec: z.string().optional(),
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
 * The declared-size check below is the load-bearing zip-bomb guard, not a
 * best-effort optimization: an archive that honestly declares a huge card is
 * refused before anything is decompressed. The post-read check that follows
 * only covers an entry declaring a size smaller than it delivers, and that case
 * jszip already refuses on its own consistency check.
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

  // Resolved by exact path first, so a `card.json` buried in the asset tree
  // cannot shadow the spec-mandated root file.
  const cardFile = resolveZipEntryFile(zip, CHARX_CARD_NAME);
  if (!cardFile) {
    return { ok: false, reason: "missing_card" };
  }

  // Measured before decompression: this is what refuses an honest zip bomb.
  const declaredSize = getDeclaredUncompressedSize(cardFile);
  if (declaredSize !== null && declaredSize > limits.maxCardBytes) {
    return { ok: false, reason: "card_too_large" };
  }

  let cardText: string;
  let cardJson: unknown;
  try {
    cardText = await cardFile.async("string");
    cardJson = JSON.parse(cardText);
  } catch (error) {
    log.warn("Failed to parse .charx card.json", error);
    return { ok: false, reason: "invalid_card" };
  }

  // Only a card that names a different format is refused here. An absent `spec`
  // is left to the converter, which recognizes root-level V2 cards without one;
  // refusing here would make the container stricter than the format it carries.
  const envelope = charxEnvelopeSchema.safeParse(cardJson);
  if (!envelope.success) {
    return { ok: false, reason: "invalid_card" };
  }
  const declaredSpec = envelope.data.spec;
  if (declaredSpec !== undefined && !declaredSpec.toLowerCase().startsWith(CHARX_SPEC_PREFIX)) {
    return { ok: false, reason: "not_character_card" };
  }

  // Backstop measuring the decompressed bytes, not a re-serialization of them:
  // whitespace and duplicate keys survive the former and vanish from the latter.
  // jszip already refuses an entry that delivers more than it declared, so this
  // covers a declared size that was simply absent.
  if (Buffer.byteLength(cardText, "utf8") > limits.maxCardBytes) {
    return { ok: false, reason: "card_too_large" };
  }

  const assets = inspectDeclaredAssets(zip, cardJson, limits);
  if (!assets.ok) {
    return { ok: false, reason: "assets_too_large" };
  }

  return { ok: true, card: cardJson, ignoredAssetCount: assets.ignoredAssetCount };
}

/**
 * Bounds the card's declared asset list and reports how much of it the archive
 * actually carries.
 *
 * Two separate counts, because they answer different questions. The budget must
 * count every declared entry, malformed ones included, or an attacker fills the
 * list with junk that fails validation and the cap never trips. The reported
 * count only includes assets present in the archive, because a remote URL or the
 * spec's `ccdefault:` default is a reference rather than bundled media.
 *
 * Nothing here decompresses an asset: sizes come from the zip central directory.
 */
function inspectDeclaredAssets(
  zip: JSZip,
  cardJson: unknown,
  limits: CharxReadLimits,
): { ok: true; ignoredAssetCount: number } | { ok: false } {
  const cardData = (cardJson as { data?: unknown } | null)?.data;
  const rawAssets = (cardData as { assets?: unknown } | undefined)?.assets;
  if (!Array.isArray(rawAssets)) {
    return { ok: true, ignoredAssetCount: 0 };
  }

  // Checked against the raw list length, before any per-entry work: counting only
  // successfully parsed entries would let 400k junk values block the event loop
  // under a cap of 500, since each one would `continue` past the counter.
  if (rawAssets.length > limits.maxAssets) {
    return { ok: false };
  }

  let totalDeclaredBytes = 0;
  let ignoredAssetCount = 0;
  for (const rawAsset of rawAssets) {
    const asset = charxAssetSchema.safeParse(rawAsset);
    if (!asset.success) {
      continue;
    }

    const uri = asset.data.uri;
    if (!uri?.startsWith(CHARX_EMBEDDED_URI_PREFIX)) {
      continue;
    }

    const embeddedEntry = resolveEmbeddedAssetEntry(zip, uri.slice(CHARX_EMBEDDED_URI_PREFIX.length));
    if (!embeddedEntry) {
      continue;
    }

    ignoredAssetCount += 1;

    const declaredSize = getDeclaredUncompressedSize(embeddedEntry);
    if (declaredSize === null) {
      continue;
    }

    totalDeclaredBytes += declaredSize;
    if (totalDeclaredBytes > limits.maxTotalAssetBytes) {
      return { ok: false };
    }
  }

  return { ok: true, ignoredAssetCount };
}

/**
 * Resolves an `embeded://` URI to its archive entry.
 *
 * A path that escapes the archive root is not resolvable, and a URI naming an
 * entry the archive does not contain is a dangling reference: neither is an
 * error, because the asset tree is never read either way.
 */
function resolveEmbeddedAssetEntry(zip: JSZip, embeddedPath: string): JSZip.JSZipObject | null {
  if (!embeddedPath || embeddedPath.includes("..") || embeddedPath.startsWith("/") || embeddedPath.includes("\\")) {
    return null;
  }

  const entry = zip.file(embeddedPath);
  return entry && !entry.dir ? entry : null;
}
