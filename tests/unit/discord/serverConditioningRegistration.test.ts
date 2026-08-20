/**
 * Registration coverage for /server and /conditioning prior to Wave 1 slice 2.
 * When /server matrix, /server expressions, /conditioning punish, and /conditioning reward
 * move to their new bare roots (/matrix, /expressions, /punish, /reward), their paths in
 * this test will change but their RESTRICTIONS MUST NOT WEAKEN. Dropping a restriction
 * during a path move is the exact failure this test exists to catch.
 *
 * Note: setContexts establishes a hard platform boundary (where Discord shows the command),
 * while setDefaultMemberPermissions is an admin-overridable authorization default.
 * These assertions test what is REGISTERED, not what is strictly enforced.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { loadCommandData } from "@/utils/discord/commandLoader";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

type RegistrationPayload = {
  name: string;
  contexts?: number[];
  default_member_permissions?: string;
};

describe("/server and /conditioning registration restrictions", () => {
  it("registers /server as guild-only and manager-only, containing expressions and matrix groups", async () => {
    const { registrationData, executionMap } = await loadCommandData();
    const serverCommand = registrationData.find((cmd) => cmd.name === "server") as unknown as
      | RegistrationPayload
      | undefined;

    expect(serverCommand).toBeDefined();
    if (!serverCommand) return;

    // contexts: [0] means InteractionContextType.Guild
    expect(serverCommand.contexts).toEqual([0]);
    // default_member_permissions: "32" means PermissionsBitField.Flags.ManageGuild
    expect(serverCommand.default_member_permissions).toBe("32");

    const serverExec = executionMap.get("server");
    expect(serverExec).toBeDefined();
    if (!serverExec) return;

    const hasExpressions = Array.from(serverExec.keys()).some((k) => k.startsWith("expressions."));
    const hasMatrix = Array.from(serverExec.keys()).some((k) => k.startsWith("matrix."));

    expect(hasExpressions).toBe(true);
    expect(hasMatrix).toBe(true);
  });

  it("registers /conditioning as guild-only without manager default", async () => {
    const { registrationData } = await loadCommandData();
    const conditioningCommand = registrationData.find((cmd) => cmd.name === "conditioning") as unknown as
      | RegistrationPayload
      | undefined;

    expect(conditioningCommand).toBeDefined();
    if (!conditioningCommand) return;

    // contexts: [0] means InteractionContextType.Guild
    expect(conditioningCommand.contexts).toEqual([0]);
    // NO manager default on /conditioning today
    expect(conditioningCommand.default_member_permissions).toBeUndefined();
  });
});
