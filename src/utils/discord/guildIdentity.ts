import type { ErrorContext } from "@/types/db/schema";
import { isAvatarUpdateRateLimited } from "@/utils/discord/avatarRateLimit";
import { log } from "@/utils/misc/logger";

const GUILD_IDENTITY_TIMEOUT_MS = 15000;

export interface GuildIdentityWriteResult {
  success: boolean;
  error?: "timeout" | "rate_limited" | "api_error";
  details?: string;
}

function guildMemberSelfEndpoint(guildId: string): string {
  return `https://discord.com/api/v10/guilds/${guildId}/members/@me`;
}

async function patchGuildMemberSelf(
  guildId: string,
  payload: Record<string, unknown>,
  operation: string,
): Promise<GuildIdentityWriteResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GUILD_IDENTITY_TIMEOUT_MS);

  try {
    const response = await fetch(guildMemberSelfEndpoint(guildId), {
      method: "PATCH",
      headers: {
        Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();

      // Discord throttles guild identity changes far below its documented buckets, so this is an
      // expected outcome rather than a fault: keep it off the error sink and tell the user to wait
      // instead of showing them raw API JSON.
      if (isAvatarUpdateRateLimited(response.status, errorText)) {
        log.warn(`Guild ${operation} rate limited for guild ${guildId}: ${response.status}`);
        return { success: false, error: "rate_limited" };
      }

      const context: ErrorContext = {
        errorType: "DiscordApiError",
        metadata: { guildId, operation, httpStatus: response.status, body: errorText },
      };
      await log.error(
        `Failed to update guild ${operation}: ${response.status} ${response.statusText}`,
        undefined,
        context,
      );
      return {
        success: false,
        error: "api_error",
        details: `${response.status} ${response.statusText}: ${errorText}`,
      };
    }

    return { success: true };
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === "AbortError") {
      log.warn(`Discord API call for guild ${operation} timed out`, { metadata: { guildId } });
      return {
        success: false,
        error: "timeout",
        details: `Discord API call timed out after ${GUILD_IDENTITY_TIMEOUT_MS}ms`,
      };
    }

    await log.error(`Error updating guild ${operation} via Discord API`, error, {
      errorType: "DiscordApiError",
      metadata: { guildId, operation },
    });
    return {
      success: false,
      error: "api_error",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Sets or clears the bot's per-guild avatar. A null data URI removes it. */
export function setGuildBotAvatar(guildId: string, avatarDataUri: string | null): Promise<GuildIdentityWriteResult> {
  return patchGuildMemberSelf(guildId, { avatar: avatarDataUri }, "avatar");
}

export function setGuildBotNickname(guildId: string, nickname: string): Promise<GuildIdentityWriteResult> {
  return patchGuildMemberSelf(guildId, { nick: nickname }, "nickname");
}
