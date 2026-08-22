/**
 * Wave 3 moved manager-only moderation controls out of `/server` while `/st-preset`
 * remains available in guild and DM-backed workspaces. This gate lives outside the
 * implementation slice so command restrictions cannot be weakened with their assertion.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { PermissionsBitField } from "discord.js";
import { loadCommandData, ROOT_COMMAND_EXECUTION_KEY } from "@/utils/discord/commandLoader";
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

describe("Wave 3 moderation registration restrictions", () => {
  it("registers bare /moderation as guild-only and manager-only", async () => {
    const { executionMap, registrationData } = await loadCommandData();
    const moderation = findRegistration(registrationData, "moderation");

    expect(moderation).toBeDefined();
    if (!moderation) return;

    expect(moderation.contexts).toEqual([0]);
    expect(moderation.default_member_permissions).toBe(String(PermissionsBitField.Flags.ManageGuild));
    expect(executionMap.get("moderation")?.has(ROOT_COMMAND_EXECUTION_KEY)).toBe(true);
  });

  it("keeps surviving /server commands guild-only and manager-only", async () => {
    const { registrationData } = await loadCommandData();
    const server = findRegistration(registrationData, "server");

    expect(server).toBeDefined();
    if (!server) return;

    expect(server.contexts).toEqual([0]);
    expect(server.default_member_permissions).toBe(String(PermissionsBitField.Flags.ManageGuild));
  });

  it("deregisters the seven absorbed moderation execution keys", async () => {
    const { executionMap } = await loadCommandData();
    const server = executionMap.get("server");

    expect(server).toBeDefined();
    if (!server) return;

    const moderationKeys = [
      "member-permissions",
      "user-blacklist.add",
      "user-blacklist.remove",
      "whitelist.channel",
      "whitelist.persona",
      "whitelist.remove",
      "whitelist.role",
    ];
    expect(moderationKeys.filter((key) => server.has(key))).toEqual([]);
  });

  it("pins the current DM-capable /st-preset command tree", async () => {
    const { executionMap, registrationData } = await loadCommandData();
    const preset = findRegistration(registrationData, "st-preset");

    expect(preset).toBeDefined();
    if (!preset) return;

    expect(preset.contexts).toBeUndefined();
    expect(preset.default_member_permissions).toBeUndefined();
    expect(Array.from(executionMap.get("st-preset")?.keys() ?? []).sort()).toEqual([
      "import",
      "node.toggle",
      "remove",
      "switch",
    ]);
  });
});
