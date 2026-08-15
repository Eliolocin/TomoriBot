/**
 * Shared guild-sticker sendability gate.
 *
 * Discord keeps a guild sticker in the sticker cache after it stops being usable: dropping below
 * the boost tier that unlocked the slot flips `available` to false, and a deleted sticker can
 * linger until the next fetch. Sending either returns 50081 "Cannot use this sticker", which is
 * permanent for that ID rather than transient. Every site that offers stickers to the model and
 * the send path itself have to agree on which ones are sendable, so the predicate and the runtime
 * rejection set live here rather than being re-derived per call site.
 */

import type { Sticker } from "discord.js";

/** Discord's rejection code for a sticker the bot is not allowed to send. */
export const STICKER_UNUSABLE_ERROR_CODE = 50081;

// Rejections are process-local on purpose: a restart refetches every guild's stickers, which is
// also the moment a restored boost tier should get a clean slate. Capped because the bot runs
// long uptimes on a memory-constrained host and nothing else ever prunes this set.
const MAX_REJECTED_STICKERS = 512;
const rejectedStickerIds = new Set<string>();

/**
 * Whether a sticker can still be sent, combining Discord's own flag with rejections observed
 * at send time.
 */
export function isStickerSendable(sticker: Pick<Sticker, "id" | "available">): boolean {
  // `available` is null on a partial sticker, which means "unknown", not "locked": only an
  // explicit false is Discord reporting the slot as unusable, so narrowing this to `=== true`
  // would silently suppress every sticker the bot has not fully fetched.
  return sticker.available !== false && !rejectedStickerIds.has(sticker.id);
}

/**
 * Records a sticker Discord refused, so the enumeration sites stop offering it to the model.
 * Without this the unusable sticker stays in cache, stays in the candidate list, and gets picked
 * again on the next turn.
 */
export function markStickerRejected(stickerId: string): void {
  if (rejectedStickerIds.has(stickerId)) return;

  if (rejectedStickerIds.size >= MAX_REJECTED_STICKERS) {
    const oldest = rejectedStickerIds.values().next();
    if (!oldest.done) rejectedStickerIds.delete(oldest.value);
  }

  rejectedStickerIds.add(stickerId);
}

/** Identifies the 50081 rejection on a thrown DiscordAPIError. */
export function isStickerUnusableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === STICKER_UNUSABLE_ERROR_CODE
  );
}

/** Test seam: the rejection set is module state that would otherwise leak between cases. */
export function clearRejectedStickers(): void {
  rejectedStickerIds.clear();
}
