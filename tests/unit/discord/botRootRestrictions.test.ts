/**
 * Locks in /bot's registration restrictions ahead of the /impersonate redesign.
 *
 * `bot` is a member of neither GUILD_ONLY_CATEGORIES nor MANAGER_ONLY_CATEGORIES
 * (commandLoader.ts), so every command under it is unrestricted at registration today.
 * The redesign registers /impersonate as a guild-only root while keeping /bot impersonate
 * as a bridge, so /bot itself must stay unrestricted throughout: a bridge that silently
 * inherited or dropped a restriction is invisible to check, lint, and check-locales.
 *
 * This file is deliberately separate from the /impersonate registration test so that the
 * slice adding the new root cannot edit the assertions that prove it left /bot alone.
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

  it("keeps impersonate reachable under /bot until the bridge is dissolved", async () => {
    const { executionMap } = await loadCommandData();
    const botCommands = executionMap.get("bot");

    expect(botCommands).toBeDefined();
    expect(botCommands?.has("impersonate")).toBe(true);
  }, 30000);
});
