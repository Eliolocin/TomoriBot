/**
 * Wave 3 moved manager-only moderation controls out of `/server`. This gate lives outside the
 * implementation slice so command restrictions cannot be weakened with their assertion. The preset
 * tree's own restrictions moved to `wave3StPresetsRegistration.test.ts` when the bare-root cutover
 * replaced them.
 *
 * The former "/server still survives" and "seven absorbed keys are gone from /server" checks here
 * are gone: /server itself dissolved once its own last leaves moved to /export and /import, and that
 * dissolution is asserted once, for every fully dissolved root, by configRegistration.test.ts's
 * DISSOLVED_ROOTS list.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { PermissionsBitField } from "discord.js";
import { loadCommandData, ROOT_COMMAND_EXECUTION_KEY } from "@/utils/discord/commandLoader";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

type RegistrationPayload = {
  name: string;
  contexts?: number[];
  default_member_permissions?: string;
};

function findRegistration(
  registrationData: Awaited<ReturnType<typeof loadCommandData>>["registrationData"],
  name: string,
): RegistrationPayload | undefined {
  return registrationData.find((command) => command.name === name) as unknown as RegistrationPayload | undefined;
}

describe("/moderation registration restrictions", () => {
  it("registers bare /moderation as guild-only and manager-only", async () => {
    const { executionMap, registrationData } = await loadCommandData();
    const moderation = findRegistration(registrationData, "moderation");

    expect(moderation).toBeDefined();
    if (!moderation) return;

    expect(moderation.contexts).toEqual([0]);
    expect(moderation.default_member_permissions).toBe(String(PermissionsBitField.Flags.ManageGuild));
    // Quotas moved into this panel as a page, not as a subcommand, so the root stays bare.
    expect([...(executionMap.get("moderation")?.keys() ?? [])]).toEqual([ROOT_COMMAND_EXECUTION_KEY]);
  });

  it("dissolves the member server-model policy leaf into the panel", async () => {
    const { executionMap, registrationData } = await loadCommandData();

    // The destination stays a bare root: the policy is a panel action, never a subcommand.
    expect([...(executionMap.get("moderation")?.keys() ?? [])]).toEqual([ROOT_COMMAND_EXECUTION_KEY]);
    expect(findRegistration(registrationData, "moderation")?.default_member_permissions).toBe(
      String(PermissionsBitField.Flags.ManageGuild),
    );
  });
});
