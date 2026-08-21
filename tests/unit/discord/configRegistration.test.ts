/**
 * `/config` is manager-only but DM-capable, which keeps workspace setup reachable
 * outside guilds. The bare `/setup` extraction in slice 5b depends on this fact.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { loadCommandData } from "@/utils/discord/commandLoader";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

type RegistrationPayload = {
  name: string;
  contexts?: number[];
  default_member_permissions?: string;
};

describe("Config command registration restrictions", () => {
  it("registers /config as manager-only (ManageGuild)", async () => {
    const { registrationData } = await loadCommandData();

    const configCommand = registrationData.find((cmd) => cmd.name === "config") as unknown as
      | RegistrationPayload
      | undefined;

    expect(configCommand).toBeDefined();
    if (!configCommand) return;

    // default_member_permissions: "32" means PermissionsBitField.Flags.ManageGuild
    expect(configCommand.default_member_permissions).toBe("32");
    // Undefined contexts means the command is allowed in DMs, not just guilds.
    expect(configCommand.contexts).toBeUndefined();
  });
});
