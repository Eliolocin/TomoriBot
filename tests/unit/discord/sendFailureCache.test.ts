import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  classifySendFailure,
  clearSendFailure,
  getBlockedSendReason,
  noteSendFailure,
  resetSendFailureCacheForTesting,
} from "@/utils/discord/stream/sendFailureCache";

const CHANNEL = "1538909126912905218";

beforeEach(() => {
  resetSendFailureCacheForTesting();
});

afterAll(() => {
  resetSendFailureCacheForTesting();
});

function discordError(code: number | string): Error & { code: number | string } {
  return Object.assign(new Error("Missing Permissions"), { code });
}

describe("send failure classification", () => {
  // A timed-out member and a genuinely missing permission are the same 50013 on the wire, so the
  // classifier cannot separate them and deliberately does not try.
  it.each([50013, "50013"])("treats %s as a permission refusal", (code) => {
    expect(classifySendFailure(discordError(code))).toBe("missing_permissions");
  });

  it.each([50001, "50001"])("treats %s as an access refusal", (code) => {
    expect(classifySendFailure(discordError(code))).toBe("missing_access");
  });

  // Caching a transient failure would silence a channel that is merely having a bad minute,
  // which is a worse outcome than the wasted call the cache exists to prevent.
  it.each([
    ["a rate limit", 429],
    ["an unknown channel", 10003],
    ["a server fault", 50035],
    ["no code at all", undefined],
  ])("does not cache %s", (_label, code) => {
    expect(classifySendFailure(code === undefined ? new Error("boom") : discordError(code))).toBeNull();
  });
});

describe("send failure cache", () => {
  it("reports no block for a channel that has not failed", () => {
    expect(getBlockedSendReason(CHANNEL)).toBeNull();
  });

  it("blocks the channel once a send has been refused", () => {
    noteSendFailure(CHANNEL, "missing_permissions");
    expect(getBlockedSendReason(CHANNEL)).toBe("missing_permissions");
  });

  it("marks only the first refusal of an episode, so repeats stay out of the error log", () => {
    expect(noteSendFailure(CHANNEL, "missing_permissions").isFirstOfEpisode).toBe(true);
    expect(noteSendFailure(CHANNEL, "missing_permissions").isFirstOfEpisode).toBe(false);
    expect(noteSendFailure(CHANNEL, "missing_permissions").isFirstOfEpisode).toBe(false);
  });

  // The first thing a confused admin does after lifting a timeout is send another message, so
  // recovery must not wait out the remaining TTL.
  it("clears on a successful send", () => {
    noteSendFailure(CHANNEL, "missing_permissions");
    clearSendFailure(CHANNEL);
    expect(getBlockedSendReason(CHANNEL)).toBeNull();
  });

  it("keeps channels independent", () => {
    noteSendFailure(CHANNEL, "missing_permissions");
    expect(getBlockedSendReason("999999999999999999")).toBeNull();
  });

  it("expires the entry so a fixed channel recovers without a send", () => {
    noteSendFailure(CHANNEL, "missing_permissions");

    // The TTL is read once at module load, matching the webhook failure cache, so this advances
    // the clock past the 15 minute default rather than trying to shorten it from here.
    const pastDefaultTtl = Date.now() + 16 * 60_000;
    const realNow = Date.now;
    Date.now = () => pastDefaultTtl;
    try {
      expect(getBlockedSendReason(CHANNEL)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});
