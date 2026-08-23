import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "bun:test";
import { SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import * as stPresets from "@/commands/st-presets";
import { loadCommandData } from "@/utils/discord/commandLoader";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

describe("ST presets command registration", () => {
  it("registers bare /st-presets as manager-gated while staying DM-capable", () => {
    const data = stPresets.configureCommand(new SlashCommandBuilder()).toJSON();
    expect(data.name).toBe("st-presets");
    expect(stPresets.managerOnly).toBe(true);
    expect((stPresets as { guildOnly?: boolean }).guildOnly).toBeUndefined();
    expect(data.contexts).toBeUndefined();
    expect(data.description).toContain("SillyTavern");
  });

  it("no longer registers any legacy /st-preset leaf", async () => {
    const commandsPath = join(process.cwd(), "src", "commands");
    expect(existsSync(join(commandsPath, "st-preset"))).toBe(false);
    expect(existsSync(join(commandsPath, "st-preset.ts"))).toBe(false);

    const { registrationData } = await loadCommandData();
    const names = registrationData.map((command) => command.name);
    expect(names).toContain("st-presets");
    expect(names).not.toContain("st-preset");
  });

  it("defers the root reply before loading panel state", async () => {
    const calls: string[] = [];
    const interaction = {
      deferReply: async () => calls.push("deferReply"),
      editReply: async () => calls.push("editReply"),
    } as unknown as ChatInputCommandInteraction;
    await stPresets.executeStPresetsCommand(interaction, "en-US", async () => {
      calls.push("load");
      return { components: [], flags: 32768 };
    });
    expect(calls).toEqual(["deferReply", "load", "editReply"]);
  });
});
