import { beforeAll, describe, expect, it } from "bun:test";
import { SlashCommandBuilder, SlashCommandSubcommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import * as mcps from "@/commands/mcps";
import * as add from "@/commands/mcp/add";
import * as list from "@/commands/mcp/list";
import * as remove from "@/commands/mcp/remove";
import * as toggle from "@/commands/mcp/toggle";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

describe("MCP command coexistence", () => {
  it("registers bare /mcps as manager-only and DM-capable", () => {
    const data = mcps.configureCommand(new SlashCommandBuilder()).toJSON();
    expect(data.name).toBe("mcps");
    expect(mcps.managerOnly).toBe(true);
    expect(data.contexts).toBeUndefined();
    expect(data.description).toContain("Add");
    expect(data.description).toContain("remove");
  });

  it("keeps all four legacy /mcp leaves during coexistence", () => {
    const names = [add, list, remove, toggle].map(
      (module) => module.configureSubcommand(new SlashCommandSubcommandBuilder()).toJSON().name,
    );
    expect(names.sort()).toEqual(["add", "list", "remove", "toggle"]);
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
