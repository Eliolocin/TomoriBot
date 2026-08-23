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

  it("collapses four leaves into one root without disturbing the rest of the tree", async () => {
    const { executionMap, registrationData } = await loadCommandData();
    const executableCount = [...executionMap.values()].reduce((total, leaves) => total + leaves.size, 0);

    // 42 roots and 214 executable commands before the cutover, with `/st-preset` owning import, node.toggle,
    // remove, and switch. Replacing those four leaves with one bare root keeps the root count and drops the
    // executable count by three.
    expect(registrationData.length).toBe(42);
    expect(executableCount).toBe(211);
  });
});
