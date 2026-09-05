/**
 * Asserts that the four migrated roots (/expressions, /matrix, /punish, /reward)
 * carry the restrictions they inherited from their old categories, and that the
 * old paths are gone from /server and /conditioning.
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

describe("Wave 1 slice 2 command registration restrictions", () => {
  it("registers /expressions and /matrix as guild-only and manager-only", async () => {
    const { registrationData } = await loadCommandData();

    const expressionsCommand = registrationData.find((cmd) => cmd.name === "expressions") as unknown as
      | RegistrationPayload
      | undefined;
    const matrixCommand = registrationData.find((cmd) => cmd.name === "matrix") as unknown as
      | RegistrationPayload
      | undefined;

    expect(expressionsCommand).toBeDefined();
    expect(matrixCommand).toBeDefined();
    if (!expressionsCommand || !matrixCommand) return;

    // contexts: [0] means InteractionContextType.Guild
    expect(expressionsCommand.contexts).toEqual([0]);
    expect(matrixCommand.contexts).toEqual([0]);
    // default_member_permissions: "32" means PermissionsBitField.Flags.ManageGuild
    expect(expressionsCommand.default_member_permissions).toBe("32");
    expect(matrixCommand.default_member_permissions).toBe("32");
  });

  it("registers /punish and /reward as guild-only without manager default", async () => {
    const { registrationData } = await loadCommandData();
    const punishCommand = registrationData.find((cmd) => cmd.name === "punish") as unknown as
      | RegistrationPayload
      | undefined;
    const rewardCommand = registrationData.find((cmd) => cmd.name === "reward") as unknown as
      | RegistrationPayload
      | undefined;

    expect(punishCommand).toBeDefined();
    expect(rewardCommand).toBeDefined();
    if (!punishCommand || !rewardCommand) return;

    // contexts: [0] means InteractionContextType.Guild
    expect(punishCommand.contexts).toEqual([0]);
    expect(rewardCommand.contexts).toEqual([0]);
    // NO manager default on /punish and /reward
    expect(punishCommand.default_member_permissions).toBeUndefined();
    expect(rewardCommand.default_member_permissions).toBeUndefined();
  });

  it("registers /server with correct restrictions and without expressions or matrix paths", async () => {
    const { registrationData, executionMap } = await loadCommandData();
    const serverCommand = registrationData.find((cmd) => cmd.name === "server") as unknown as
      | RegistrationPayload
      | undefined;

    expect(serverCommand).toBeDefined();
    if (!serverCommand) return;

    expect(serverCommand.contexts).toEqual([0]);
    expect(serverCommand.default_member_permissions).toBe("32");

    const serverExec = executionMap.get("server");
    expect(serverExec).toBeDefined();
    if (!serverExec) return;

    const hasExpressions = Array.from(serverExec.keys()).some((k) => k.startsWith("expressions."));
    const hasMatrix = Array.from(serverExec.keys()).some((k) => k.startsWith("matrix."));
    expect(hasExpressions).toBe(false);
    expect(hasMatrix).toBe(false);
  });

  it("registers /conditioning with correct restrictions and without punish or reward paths", async () => {
    const { registrationData, executionMap } = await loadCommandData();
    const conditioningCommand = registrationData.find((cmd) => cmd.name === "conditioning") as unknown as
      | RegistrationPayload
      | undefined;

    expect(conditioningCommand).toBeDefined();
    if (!conditioningCommand) return;

    expect(conditioningCommand.contexts).toEqual([0]);
    expect(conditioningCommand.default_member_permissions).toBeUndefined();

    const conditioningExec = executionMap.get("conditioning");
    expect(conditioningExec).toBeDefined();
    if (!conditioningExec) return;

    const keys = Array.from(conditioningExec.keys());
    expect(keys).toContain("manage");
    expect(keys).toContain("remove");
    expect(typeof conditioningExec.get("manage")).toBe("function");
    expect(typeof conditioningExec.get("remove")).toBe("function");
    expect(keys.some((k) => k.startsWith("punish."))).toBe(false);
    expect(keys.some((k) => k.startsWith("reward."))).toBe(false);
  });
});
