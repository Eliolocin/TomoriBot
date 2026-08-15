/**
 * Shared Discord avatar/nickname rate-limit detection.
 *
 * Discord throttles guild member avatar (and nickname) changes more aggressively
 * than its documented buckets: beyond a plain HTTP 429 it can return a 200-level
 * error envelope whose `errors.avatar`/`errors.nick` carry an `AVATAR_RATE_LIMIT`
 * code, or a message mentioning a rate limit. Every avatar PATCH site (`/persona avatar`,
 * `/persona import`, `/persona swap`, and the preset-avatar fan-out reconciler) must treat any
 * of these as "back off and retry later" rather than as a fault, so the detection lives here in
 * one place.
 */

type DiscordApiErrorPayload = {
  message?: string;
  code?: number | string;
  errors?: {
    avatar?: { _errors?: Array<{ code?: string; message?: string }> };
    nick?: { _errors?: Array<{ code?: string; message?: string }> };
  };
};

/**
 * Detects whether a guild member avatar/nickname PATCH was rate limited.
 *
 * @param status - HTTP status code from the PATCH response
 * @param errorText - Raw response body text (may be empty)
 * @returns true when the failure is (or looks like) a rate limit
 */
export function isAvatarUpdateRateLimited(status: number, errorText: string): boolean {
  if (status === 429) {
    return true;
  }

  if (!errorText) {
    return false;
  }

  try {
    const parsed = JSON.parse(errorText) as DiscordApiErrorPayload;
    const avatarErrors = parsed.errors?.avatar?._errors ?? [];
    const nickErrors = parsed.errors?.nick?._errors ?? [];
    const hasRateLimitCode = [...avatarErrors, ...nickErrors].some((error) =>
      (error.code ?? "").toString().toUpperCase().includes("RATE_LIMIT"),
    );

    if (hasRateLimitCode) {
      return true;
    }

    if (parsed.message?.toLowerCase().includes("rate limit")) {
      return true;
    }
  } catch {}

  return /AVATAR_RATE_LIMIT/i.test(errorText) || /RATE_LIMIT/i.test(errorText) || /too fast/i.test(errorText);
}
