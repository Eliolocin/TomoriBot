/**
 * Locks in /bot's registration restrictions following the /impersonate dissolution.
 *
 * `bot` is a member of neither GUILD_ONLY_CATEGORIES nor MANAGER_ONLY_CATEGORIES
 * (commandLoader.ts), so every command under it is unrestricted at registration.
 * /bot now retains only generate.image and generate.scene, keeping contexts and
 * default_member_permissions undefined.
 *
 * Keep this file separate from the /impersonate registration test. A slice that changes
 * what /bot contains must not also own the assertions proving what it left alone, and
 * /bot's two remaining leaves are still owed a migration of their own.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { loadCommandData } from "@/utils/discord/commandLoader";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

describe("/bot root registration restrictions", () => {
  it("registers /bot with no contexts and no default_member_permissions", async () => {
    const { registrationData } = await loadCommandData();
    const bot = registrationData.find((command) => command.name === "bot");

    expect(bot).toBeDefined();
    expect(bot?.contexts).toBeUndefined();
    expect(bot?.default_member_permissions).toBeUndefined();
  }, 30000);

  it("no longer contains impersonate under /bot and retains generate.image and generate.scene", async () => {
    const { executionMap } = await loadCommandData();
    const botCommands = executionMap.get("bot");

    expect(botCommands).toBeDefined();
    expect(botCommands?.has("impersonate")).toBe(false);
    expect(botCommands?.has("generate.image")).toBe(true);
    expect(botCommands?.has("generate.scene")).toBe(true);
  }, 30000);
});
