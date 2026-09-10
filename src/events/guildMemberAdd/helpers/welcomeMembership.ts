import type { GuildMember } from "discord.js";

/**
 * Fetch the current guild membership from Discord and verify it is the same
 * membership instance that originally triggered the welcome flow.
 *
 * A user can leave and rejoin with the same Discord user ID while a delayed
 * welcome is still pending. Comparing joinedTimestamp prevents the old welcome
 * from being delivered to the new membership instance.
 *
 * @param originalMember - Membership instance that started the welcome flow
 * @returns Fresh member data when the original membership is still active
 */
export async function fetchCurrentWelcomeMember(originalMember: GuildMember): Promise<GuildMember | null> {
  const currentMember = await originalMember.guild.members
    .fetch({ user: originalMember.id, force: true })
    .catch(() => null);

  if (!currentMember || currentMember.joinedTimestamp !== originalMember.joinedTimestamp) {
    return null;
  }

  return currentMember;
}
