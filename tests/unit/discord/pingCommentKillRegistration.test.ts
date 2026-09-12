/**
 * Registration coverage for the direct moves of /tool ping to /ping, /tool comment
 * to /comment, and /bot kill to /kill. Neither `tool` nor `bot` sits in
 * GUILD_ONLY_CATEGORIES/MANAGER_ONLY_CATEGORIES (commandLoader.ts), so these three
 * commands carried no restriction before the move and must carry none after it;
 * a category-inherited restriction disappearing silently is the dominant failure
 * mode for a direct move, so it is asserted here rather than left implicit.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { SlashCommandBuilder } from "discord.js";
import * as commentCommand from "@/commands/comment";
import * as killCommand from "@/commands/kill";
import * as pingCommand from "@/commands/ping";
import { loadCommandData } from "@/utils/discord/commandLoader";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

describe("/ping, /comment, /kill registration", () => {
  it("each builds through its own configureCommand with the expected name", () => {
    expect(pingCommand.configureCommand(new SlashCommandBuilder()).toJSON().name).toBe("ping");
    expect(commentCommand.configureCommand(new SlashCommandBuilder()).toJSON().name).toBe("comment");
    expect(killCommand.configureCommand(new SlashCommandBuilder()).toJSON().name).toBe("kill");
  });

  it("carries no contexts or default_member_permissions, and exports neither guildOnly nor managerOnly", () => {
    for (const module of [pingCommand, commentCommand, killCommand] as const) {
      const data = module.configureCommand(new SlashCommandBuilder()).toJSON();
      expect(data.contexts).toBeUndefined();
      expect(data.default_member_permissions).toBeUndefined();
      expect((module as Record<string, unknown>).guildOnly).toBeUndefined();
      expect((module as Record<string, unknown>).managerOnly).toBeUndefined();
    }
  });

  it("registers ping, comment, and kill as bare roots through the real loader", async () => {
    const { registrationData } = await loadCommandData();
    const names = registrationData.map((command) => command.name);
    expect(names).toContain("ping");
    expect(names).toContain("comment");
    expect(names).toContain("kill");
  });

  it("removes the old /tool ping and /tool comment leaves while /tool keeps its other members", async () => {
    const { executionMap, registrationData } = await loadCommandData();
    const names = registrationData.map((command) => command.name);
    expect(names).toContain("tool");

    const toolSubcommands = executionMap.get("tool");
    expect(toolSubcommands).toBeDefined();
    expect(toolSubcommands?.has("ping")).toBe(false);
    expect(toolSubcommands?.has("comment")).toBe(false);
    expect((toolSubcommands?.size ?? 0) > 0).toBe(true);
  });

  it("ensures /bot no longer exists", async () => {
    const { executionMap, registrationData } = await loadCommandData();
    const names = registrationData.map((command) => command.name);
    expect(names).not.toContain("bot");
    const botSubcommands = executionMap.get("bot");
    expect(botSubcommands).toBeUndefined();
  });
});
