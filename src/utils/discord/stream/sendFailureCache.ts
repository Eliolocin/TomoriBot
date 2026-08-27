/**
 * Negative cache for channels whose last message send was rejected for a reason that cannot
 * resolve on its own.
 *
 * The chat pipeline already gates on `SendMessages` before generating, but that check reads the
 * permission bitfield and Discord rejects sends for reasons the bitfield does not express. A
 * moderator timeout is the clearest example: the member keeps every permission, so the gate
 * passes, and every send still returns 50013. One production guild produced 397 such failures
 * across two days, each one a completed LLM call discarded at the last step.
 *
 * This is the backstop for that whole class: whatever the cause, once a send has actually been
 * refused, stop paying for responses to that channel until the situation might have changed.
 *
 * Distinct from the webhook failure cache in `webhookCore`, which suppresses the webhook lookup
 * rather than the send, and covers a different set of codes.
 */

/** Discord rejects a send from a timed-out member with 50013, indistinguishable from a real
 * permission gap at the API level, so both share one reason. */
export type SendFailureReason = "missing_permissions" | "missing_access";

interface SendFailureEntry {
  reason: SendFailureReason;
  expiresAt: number;
  /** Suppresses repeat error-level logging without hiding the first occurrence of an episode. */
  reported: boolean;
}

const sendFailureCache = new Map<string, SendFailureEntry>();

const SEND_FAILURE_RETRY_MS =
  Math.max(Number.parseInt(process.env.SEND_FAILURE_RETRY_MINUTES || "", 10) || 15, 1) * 60_000;

/**
 * Maps a Discord API error to a reason worth caching, or null when the failure could plausibly
 * succeed on the next attempt.
 *
 * Deliberately narrow. Caching a transient failure would silence a channel that is merely having
 * a bad minute, which is worse than the wasted call this exists to prevent.
 */
export function classifySendFailure(error: unknown): SendFailureReason | null {
  const code = (error as { code?: number | string })?.code;

  if (code === 50013 || code === "50013") {
    return "missing_permissions";
  }

  if (code === 50001 || code === "50001") {
    return "missing_access";
  }

  return null;
}

/**
 * Records a refused send and reports whether this opens a new episode, so the caller can log the
 * first occurrence loudly and count the rest.
 */
export function noteSendFailure(channelId: string, reason: SendFailureReason): { isFirstOfEpisode: boolean } {
  const existing = sendFailureCache.get(channelId);
  const isFirstOfEpisode = !existing || existing.expiresAt <= Date.now() || !existing.reported;

  sendFailureCache.set(channelId, {
    reason,
    expiresAt: Date.now() + SEND_FAILURE_RETRY_MS,
    reported: true,
  });

  return { isFirstOfEpisode };
}

/** The cached reason when sends to this channel are still known to fail, otherwise null. */
export function getBlockedSendReason(channelId: string): SendFailureReason | null {
  const entry = sendFailureCache.get(channelId);
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    sendFailureCache.delete(channelId);
    return null;
  }

  return entry.reason;
}

/**
 * Clears the entry after a send lands.
 *
 * Without this, granting the permission or lifting the timeout would take up to a full TTL to
 * take effect, and the first thing a confused admin does is send another message.
 */
export function clearSendFailure(channelId: string): void {
  sendFailureCache.delete(channelId);
}

/** Test seam. */
export function resetSendFailureCacheForTesting(): void {
  sendFailureCache.clear();
}
