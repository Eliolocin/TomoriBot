import { describe, expect, it, mock } from "bun:test";
import type { GuildMember } from "discord.js";
import { checkWelcomeMembership } from "@/events/guildMemberAdd/helpers/welcomeMembership";

function makeMember(params?: {
  joinedTimestamp?: number | null;
  fetchedMember?: GuildMember | null;
  fetchRejectsWith?: unknown;
}) {
  const fetch = mock(async () => {
    if (params && "fetchRejectsWith" in params) throw params.fetchRejectsWith;
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

function unknownMemberError(code: number | string): Error & { code: number | string } {
  return Object.assign(new Error("Unknown Member"), { code });
}

describe("checkWelcomeMembership", () => {
  it("force-fetches the member from Discord instead of trusting cache state", async () => {
    const currentMember = { id: "123456789012345678", joinedTimestamp: 1_000 } as GuildMember;
    const { member, fetch } = makeMember({ fetchedMember: currentMember });

    expect(await checkWelcomeMembership(member)).toEqual({ status: "active" });
    expect(fetch).toHaveBeenCalledWith({ user: member.id, force: true });
  });

  it("reports a departure when Discord rejects with Unknown Member", async () => {
    const { member } = makeMember({ fetchRejectsWith: unknownMemberError(10007) });

    expect(await checkWelcomeMembership(member)).toEqual({ status: "ended" });
  });

  it("reports a departure when Unknown Member arrives as a string code", async () => {
    const { member } = makeMember({ fetchRejectsWith: unknownMemberError("10007") });

    expect(await checkWelcomeMembership(member)).toEqual({ status: "ended" });
  });

  it("reports a departure when the user left and rejoined before the old welcome completed", async () => {
    const rejoinedMember = { id: "123456789012345678", joinedTimestamp: 2_000 } as GuildMember;
    const { member } = makeMember({ joinedTimestamp: 1_000, fetchedMember: rejoinedMember });

    expect(await checkWelcomeMembership(member)).toEqual({ status: "ended" });
  });

  it("does not report a departure when the membership could not be read", async () => {
    const rateLimited = unknownMemberError(0);
    const { member } = makeMember({ fetchRejectsWith: rateLimited });

    const result = await checkWelcomeMembership(member);

    expect(result.status).toBe("unverified");
    expect(result).toEqual({ status: "unverified", error: rateLimited });
  });

  it("does not report a departure when the fetch fails without a Discord error code", async () => {
    const networkFailure = new Error("socket hang up");
    const { member } = makeMember({ fetchRejectsWith: networkFailure });

    expect(await checkWelcomeMembership(member)).toEqual({ status: "unverified", error: networkFailure });
  });
});
