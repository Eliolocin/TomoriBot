import type { GuildMember } from "discord.js";

/** Discord's authoritative "this user is not in the guild" rejection. */
const UNKNOWN_MEMBER_ERROR_CODE = 10007;

/**
 * Outcome of re-checking a pending welcome's membership.
 *
 * `unverified` is deliberately distinct from `ended`: a rate limit or outage means the membership
 * could not be read, not that the member left, and the caller must not report it as a departure.
 */
export type WelcomeMembershipCheck =
  | { status: "active" }
  | { status: "ended" }
  | { status: "unverified"; error: unknown };

/**
 * Re-reads a pending welcome's membership straight from Discord.
 *
 * A user can leave and rejoin with the same Discord user ID while a delayed welcome is still
 * pending, so a matching user ID is not enough: joinedTimestamp is what distinguishes the original
 * membership from a new one. The fetch is forced because the cache goes stale around
 * guildMemberRemove and Tomori also sweeps guild members from it.
 *
 * The fetched member is not returned. Both call sites run after the work that reads member state,
 * so nothing downstream can act on the fresher copy.
 *
 * @param originalMember - Membership instance that started the welcome flow
 */
export async function checkWelcomeMembership(originalMember: GuildMember): Promise<WelcomeMembershipCheck> {
  let currentMember: GuildMember;

  try {
    currentMember = await originalMember.guild.members.fetch({ user: originalMember.id, force: true });
  } catch (error) {
    const code = (error as { code?: number | string })?.code;
    if (code === UNKNOWN_MEMBER_ERROR_CODE || code === String(UNKNOWN_MEMBER_ERROR_CODE)) {
      return { status: "ended" };
    }
    return { status: "unverified", error };
  }

  if (currentMember.joinedTimestamp !== originalMember.joinedTimestamp) {
    return { status: "ended" };
  }

  return { status: "active" };
}
