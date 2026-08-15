import { beforeEach, describe, expect, it } from "bun:test";
import {
  clearRejectedStickers,
  isStickerSendable,
  isStickerUnusableError,
  markStickerRejected,
  STICKER_UNUSABLE_ERROR_CODE,
} from "@/utils/discord/stickerAvailability";

const sticker = (id: string, available: boolean | null) => ({ id, available });

describe("stickerAvailability", () => {
  beforeEach(() => {
    clearRejectedStickers();
  });

  it("treats a null availability as sendable", () => {
    // A partial sticker reports null, which means "not fetched yet" rather than "locked";
    // rejecting it would suppress stickers that work fine.
    expect(isStickerSendable(sticker("1", null))).toBe(true);
  });

  it("rejects a sticker Discord marked unavailable", () => {
    expect(isStickerSendable(sticker("2", false))).toBe(false);
  });

  it("keeps a rejected sticker suppressed after a send failure", () => {
    const locked = sticker("3", true);
    expect(isStickerSendable(locked)).toBe(true);

    markStickerRejected(locked.id);

    expect(isStickerSendable(locked)).toBe(false);
    expect(isStickerSendable(sticker("4", true))).toBe(true);
  });

  it("evicts the oldest entry instead of growing without bound", () => {
    for (let i = 0; i < 520; i++) {
      markStickerRejected(`bulk-${i}`);
    }

    expect(isStickerSendable(sticker("bulk-0", true))).toBe(true);
    expect(isStickerSendable(sticker("bulk-519", true))).toBe(false);
  });

  it("identifies only the 50081 rejection", () => {
    expect(isStickerUnusableError({ code: STICKER_UNUSABLE_ERROR_CODE })).toBe(true);
    expect(isStickerUnusableError({ code: 50013 })).toBe(false);
    expect(isStickerUnusableError(new Error("boom"))).toBe(false);
    expect(isStickerUnusableError(null)).toBe(false);
  });
});
