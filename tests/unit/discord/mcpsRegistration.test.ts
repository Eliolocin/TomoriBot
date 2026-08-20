import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "bun:test";
import { SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import * as mcps from "@/commands/mcps";
import { loadCommandData } from "@/utils/discord/commandLoader";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

describe("MCP command registration", () => {
  it("registers bare /mcps as manager-only and DM-capable", () => {
    const data = mcps.configureCommand(new SlashCommandBuilder()).toJSON();
    expect(data.name).toBe("mcps");
    expect(mcps.managerOnly).toBe(true);
    expect(data.contexts).toBeUndefined();
    expect(data.description).toContain("Add");
    expect(data.description).toContain("remove");
  });

  it("no longer registers any legacy /mcp leaf", async () => {
    const commandsPath = join(process.cwd(), "src", "commands");
    expect(existsSync(join(commandsPath, "mcp"))).toBe(false);
    expect(existsSync(join(commandsPath, "mcp.ts"))).toBe(false);

    const { registrationData } = await loadCommandData();
    const names = registrationData.map((command) => command.name);
    expect(names).toContain("mcps");
    expect(names).not.toContain("mcp");
  });

  it("defers the root reply before loading panel state", async () => {
    const calls: string[] = [];
    const interaction = {
      deferReply: async () => calls.push("deferReply"),
      editReply: async () => calls.push("editReply"),
    } as unknown as ChatInputCommandInteraction;
    await mcps.executeMcpsCommand(interaction, "en-US", async () => {
      calls.push("load");
      return { components: [], flags: 32768 };
    });
    expect(calls).toEqual(["deferReply", "load", "editReply"]);
  });
});
