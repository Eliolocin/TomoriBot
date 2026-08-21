/**
 * `/server nuke` becomes the bare root `/nuke`. Since `server` restricts to guilds and requires
 * ManageGuild, `/nuke` must manually assert both restrictions.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { loadCommandData, ROOT_COMMAND_EXECUTION_KEY } from "@/utils/discord/commandLoader";
import { resolveCommandCooldown } from "@/events/interactionCreate/handleCommands";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";
import { PermissionsBitField } from "discord.js";

beforeAll(async () => initializeLocalizer());

type RegistrationPayload = {
  name: string;
  description?: string;
  contexts?: number[];
  default_member_permissions?: string;
};

describe("/nuke registration", () => {
  it("registers as a restricted bare root", async () => {
    const { registrationData, executionMap } = await loadCommandData();

    const nukeCommand = registrationData.find((cmd) => cmd.name === "nuke") as unknown as
      | RegistrationPayload
      | undefined;

    expect(nukeCommand).toBeDefined();
    if (!nukeCommand) return;

    expect(nukeCommand.contexts).toEqual([0]); // InteractionContextType.Guild only, never a DM context
    expect(nukeCommand.default_member_permissions).toBe(String(PermissionsBitField.Flags.ManageGuild));
    expect(executionMap.get("nuke")?.has(ROOT_COMMAND_EXECUTION_KEY)).toBe(true);
  });

  it("does not register /server nuke as a subcommand", async () => {
    const { executionMap } = await loadCommandData();

    const serverCommands = executionMap.get("server");
    expect(serverCommands).toBeDefined();
    if (!serverCommands) return;

    expect(serverCommands.has("nuke")).toBe(false);
  });

  it("does not disturb the parent /server root", async () => {
    const { registrationData } = await loadCommandData();

    const serverCommand = registrationData.find((cmd) => cmd.name === "server") as unknown as
      | RegistrationPayload
      | undefined;

    expect(serverCommand).toBeDefined();
    if (!serverCommand) return;

    expect(serverCommand.contexts).toEqual([0]);
    expect(serverCommand.default_member_permissions).toBe(String(PermissionsBitField.Flags.ManageGuild));
  });

  it("resolves the description correctly in both en-US and ja", () => {
    const en = localizer("en-US", "commands.nuke.description");
    const ja = localizer("ja", "commands.nuke.description");

    expect(en).not.toBe("commands.nuke.description");
    expect(ja).not.toBe("commands.nuke.description");
  });

  it("applies the correct cooldown to the new bare root", () => {
    const serverCooldown = Number.parseInt(process.env.COOLDOWN_SERVER || "3000", 10);
    const defaultCooldown = Number.parseInt(process.env.DEFAULT_COMMAND_COOLDOWN || "1600", 10);

    expect(resolveCommandCooldown("nuke")).toBe(serverCooldown);
    expect(resolveCommandCooldown("server")).toBe(serverCooldown);

    // Anchors the two assertions above: without it they still pass when both entries fall through.
    expect(resolveCommandCooldown("unknown-command")).toBe(defaultCooldown);
  });
});
