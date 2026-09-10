import { describe, expect, it, mock } from "bun:test";
import type { GuildMember } from "discord.js";
import { fetchCurrentWelcomeMember } from "@/events/guildMemberAdd/helpers/welcomeMembership";

function makeMember(params?: {
  joinedTimestamp?: number | null;
  fetchedMember?: GuildMember | null;
  fetchRejects?: boolean;
}) {
  const fetch = mock(async () => {
    if (params?.fetchRejects) throw new Error("Unknown Member");
    return params?.fetchedMember ?? null;
  });

  const member = {
    id: "123456789012345678",
    joinedTimestamp: params?.joinedTimestamp ?? 1_000,
    guild: {
      members: { fetch },
    },
  } as unknown as GuildMember;

  return { member, fetch };
}

describe("fetchCurrentWelcomeMember", () => {
  it("force-fetches the member from Discord instead of trusting cache state", async () => {
    const currentMember = {
      id: "123456789012345678",
      joinedTimestamp: 1_000,
    } as GuildMember;
    const { member, fetch } = makeMember({ fetchedMember: currentMember });

    expect(await fetchCurrentWelcomeMember(member)).toBe(currentMember);
    expect(fetch).toHaveBeenCalledWith({ user: member.id, force: true });
  });

  it("returns null when the member has left the guild", async () => {
    const { member } = makeMember({ fetchRejects: true });

    expect(await fetchCurrentWelcomeMember(member)).toBeNull();
  });

  it("returns null when the user left and rejoined before the old welcome completed", async () => {
    const rejoinedMember = {
      id: "123456789012345678",
      joinedTimestamp: 2_000,
    } as GuildMember;
    const { member } = makeMember({ joinedTimestamp: 1_000, fetchedMember: rejoinedMember });

    expect(await fetchCurrentWelcomeMember(member)).toBeNull();
  });
});
