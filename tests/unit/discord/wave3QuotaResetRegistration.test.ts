/**
 * `/quota reset` replaced the legacy `/server quota reset` scope option with two direct leaves. This gate lives
 * outside the implementation slices so a command that clears other members' usage counters cannot lose its
 * guild and manager restrictions, and so quota work cannot drift back under `/server`.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { PermissionsBitField } from "discord.js";
import { loadCommandData } from "@/utils/discord/commandLoader";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

type RegistrationPayload = {
  name: string;
  contexts?: number[];
  default_member_permissions?: string;
};

function findRegistration(
  registrationData: Awaited<ReturnType<typeof loadCommandData>>["registrationData"],
  name: string,
): RegistrationPayload | undefined {
  return registrationData.find((command) => command.name === name) as unknown as RegistrationPayload | undefined;
}

describe("/quota registration restrictions", () => {
  it("registers /quota as guild-only and manager-only with both reset leaves", async () => {
    const { executionMap, registrationData } = await loadCommandData();
    const quota = findRegistration(registrationData, "quota");

    expect(quota).toBeDefined();
    if (!quota) return;

    expect(quota.contexts).toEqual([0]);
    expect(quota.default_member_permissions).toBe(String(PermissionsBitField.Flags.ManageGuild));
    expect([...(executionMap.get("quota")?.keys() ?? [])].sort()).toEqual(["reset.global", "reset.user"]);
  });

  it("leaves no quota command under /server", async () => {
    const { executionMap } = await loadCommandData();
    const server = executionMap.get("server");

    expect(server).toBeDefined();
    if (!server) return;

    expect([...server.keys()].filter((key) => key.startsWith("quota"))).toEqual([]);
  });
});
