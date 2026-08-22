/**
 * Registration coverage for the Wave 1 slice 6 direct move: /tool compact -> /compact.
 * Tool sits in neither GUILD_ONLY_CATEGORIES nor MANAGER_ONLY_CATEGORIES (commandLoader.ts),
 * so /compact carries no restriction before the move and must carry none after it.
 * This test asserts through the real loadCommandData() that /compact is registered as an
 * unrestricted bare root, the old /tool compact leaf is removed, and /tool retains its
 * surviving members.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { SlashCommandBuilder } from "discord.js";
import * as compactCommand from "@/commands/compact";
import { loadCommandData } from "@/utils/discord/commandLoader";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

describe("/compact registration", () => {
  it("builds through configureCommand with name compact", () => {
    const data = compactCommand.configureCommand(new SlashCommandBuilder()).toJSON();
    expect(data.name).toBe("compact");
  });

  it("carries no contexts or default_member_permissions, and exports neither guildOnly nor managerOnly", () => {
    const data = compactCommand.configureCommand(new SlashCommandBuilder()).toJSON();
    expect(data.contexts).toBeUndefined();
    expect(data.default_member_permissions).toBeUndefined();
    expect((compactCommand as Record<string, unknown>).guildOnly).toBeUndefined();
    expect((compactCommand as Record<string, unknown>).managerOnly).toBeUndefined();
  });

  it("registers compact as a bare root through the real loader", async () => {
    const { registrationData } = await loadCommandData();
    const names = registrationData.map((command) => command.name);
    expect(names).toContain("compact");
  });

  it("removes the old /tool compact leaf while /tool keeps its other members", async () => {
    const { executionMap, registrationData } = await loadCommandData();
    const names = registrationData.map((command) => command.name);
    expect(names).toContain("tool");

    const toolSubcommands = executionMap.get("tool");
    expect(toolSubcommands).toBeDefined();
    expect(toolSubcommands?.has("compact")).toBe(false);
    expect(toolSubcommands?.has("status")).toBe(true);
    expect(toolSubcommands?.has("delete.turn")).toBe(true);
    expect(toolSubcommands?.has("estimate.cost")).toBe(true);
    expect(toolSubcommands?.has("prompt.snapshot")).toBe(true);
    expect(toolSubcommands?.has("visualize")).toBe(true);
    expect(toolSubcommands?.size).toBe(5);
  });

  it("resolves the description key in both locales without returning the key path", () => {
    const enDesc = localizer("en-US", "commands.compact.description");
    const jaDesc = localizer("ja", "commands.compact.description");

    expect(enDesc).toBeDefined();
    expect(enDesc).not.toBe("commands.compact.description");
    expect(enDesc.length).toBeGreaterThan(0);

    expect(jaDesc).toBeDefined();
    expect(jaDesc).not.toBe("commands.compact.description");
    expect(jaDesc.length).toBeGreaterThan(0);
  });
});
