/**
 * Locks in /tool's and /generate's registration restrictions across the command modernization.
 *
 * Both roots are members of neither GUILD_ONLY_CATEGORIES nor MANAGER_ONLY_CATEGORIES
 * (commandLoader.ts), so both are DM-capable and unrestricted today. `/generate` now owns both
 * direct prompt image generation and the contextual Auto image flow alongside `/generate scene`;
 * those capabilities are meant to remain available in DMs. A move that silently added a context
 * or permission default to either root would take DM support away from the members already there,
 * and nothing in check, lint, or check-locales would notice.
 *
 * Keep this file separate from the per-command registration tests the dissolution edits, so
 * command-surface changes cannot also own the assertions proving they left the roots' restrictions
 * alone.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { loadCommandData } from "@/utils/discord/commandLoader";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

describe("/tool and /generate root registration restrictions", () => {
  it("registers /tool with no contexts and no default_member_permissions", async () => {
    const { registrationData } = await loadCommandData();
    const tool = registrationData.find((command) => command.name === "tool");

    expect(tool).toBeDefined();
    expect(tool?.contexts).toBeUndefined();
    expect(tool?.default_member_permissions).toBeUndefined();
  }, 30000);

  it("registers /generate with no contexts and no default_member_permissions", async () => {
    const { registrationData } = await loadCommandData();
    const generate = registrationData.find((command) => command.name === "generate");

    expect(generate).toBeDefined();
    expect(generate?.contexts).toBeUndefined();
    expect(generate?.default_member_permissions).toBeUndefined();
  }, 30000);

  it("keeps the members that predate the dissolution reachable under both roots", async () => {
    const { executionMap } = await loadCommandData();

    const toolCommands = executionMap.get("tool");
    expect(toolCommands).toBeDefined();
    expect(toolCommands?.has("delete.turn")).toBe(true);
    expect(toolCommands?.has("estimate.cost")).toBe(true);
    expect(toolCommands?.has("prompt.snapshot")).toBe(true);

    const generateCommands = executionMap.get("generate");
    expect(generateCommands).toBeDefined();
    expect(generateCommands?.has("image")).toBe(true);
    expect(generateCommands?.has("video")).toBe(true);
  }, 30000);
});
