/**
 * The `/st-preset` subcommand tree collapses into the bare plural root `/st-presets` in one atomic
 * registration change, because Discord cannot register a bare root beside its own subcommands. This gate lives
 * outside the implementation slice so the cutover cannot be reported as done while the old tree survives, and
 * so the new root cannot silently lose either half of its access rule. `/st-presets` is manager-gated in
 * guilds by product decision, but `default_member_permissions` does not apply in direct messages, so the root
 * must stay free of a `contexts` restriction or DM-backed preset workspaces become unreachable.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { PermissionsBitField } from "discord.js";
import { ROOT_COMMAND_EXECUTION_KEY, loadCommandData } from "@/utils/discord/commandLoader";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

type RegistrationPayload = {
  name: string;
  contexts?: number[];
  default_member_permissions?: string;
  options?: unknown[];
};

function findRegistration(
  registrationData: Awaited<ReturnType<typeof loadCommandData>>["registrationData"],
  name: string,
): RegistrationPayload | undefined {
  return registrationData.find((command) => command.name === name) as unknown as RegistrationPayload | undefined;
}

describe("/st-presets registration cutover", () => {
  it("registers /st-presets as a bare root with no subcommands", async () => {
    const { executionMap, registrationData } = await loadCommandData();
    const presets = findRegistration(registrationData, "st-presets");

    expect(presets).toBeDefined();
    if (!presets) return;

    expect([...(executionMap.get("st-presets")?.keys() ?? [])]).toEqual([ROOT_COMMAND_EXECUTION_KEY]);
    expect(presets.options ?? []).toEqual([]);
  });

  it("gates /st-presets on Manage Guild while staying DM-capable", async () => {
    const { registrationData } = await loadCommandData();
    const presets = findRegistration(registrationData, "st-presets");

    expect(presets).toBeDefined();
    if (!presets) return;

    // Discord ignores default_member_permissions in direct messages, so the manager gate gives guild-side
    // hiding while a `contexts` array would be the thing that actually kills DM-backed preset workspaces.
    expect(presets.default_member_permissions).toBe(String(PermissionsBitField.Flags.ManageGuild));
    expect(presets.contexts).toBeUndefined();
  });

  it("leaves no singular /st-preset command registered", async () => {
    const { executionMap, registrationData } = await loadCommandData();

    expect(findRegistration(registrationData, "st-preset")).toBeUndefined();
    expect(executionMap.has("st-preset")).toBe(false);
  });

  it("leaves none of the four former preset leaves reachable under any root", async () => {
    const { executionMap } = await loadCommandData();

    // `/st-preset` owned import, node.toggle, remove, and switch before the cutover. An earlier revision of
    // this test pinned whole-tree root and executable counts instead, which fails on every unrelated wave and
    // pressures the next slice into editing a gate it does not own. The topological fact is what this gate
    // exists to protect.
    const formerLeaves = ["import", "node.toggle", "remove", "switch"];
    for (const [root, leaves] of executionMap) {
      if (!root.startsWith("st-preset")) continue;
      for (const leaf of formerLeaves) {
        expect(leaves.has(leaf)).toBe(false);
      }
    }
  });
});
