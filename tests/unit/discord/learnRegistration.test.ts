import { beforeAll, describe, expect, it } from "bun:test";
import { ApplicationCommandOptionType } from "discord.js";
import { loadCommandData } from "@/utils/discord/commandLoader";
import { initializeLocalizer } from "@/utils/text/localizer";

type RegistrationPayload = {
  name: string;
  type?: number;
  description?: string;
  contexts?: number[];
  default_member_permissions?: string;
  options?: RegistrationPayload[];
};

beforeAll(async () => {
  await initializeLocalizer();
}, 30000);

describe("/learn and /memory registration", () => {
  it("registers /learn as an unrestricted root with exactly one history subcommand", async () => {
    const { registrationData, executionMap } = await loadCommandData();

    const learnCommand = registrationData.find((cmd) => cmd.name === "learn") as unknown as RegistrationPayload;
    expect(learnCommand).toBeDefined();

    expect(learnCommand.contexts).toBeUndefined();
    expect(learnCommand.default_member_permissions).toBeUndefined();

    expect(learnCommand.options?.length).toBe(1);
    const historySubcommand = learnCommand.options[0];
    expect(historySubcommand.name).toBe("history");
    expect(historySubcommand.type).toBe(ApplicationCommandOptionType.Subcommand);

    // The seven options are the command's whole input surface, so a relocation that dropped
    // one would still register and still pass every other check here.
    const options = historySubcommand.options;
    expect(options?.length).toBe(7);
    const optionNames = options.map((opt: RegistrationPayload) => opt.name);
    expect(optionNames).toContain("name");
    expect(optionNames).toContain("scope");
    expect(optionNames).toContain("start_message_id");
    expect(optionNames).toContain("end_message_id");
    expect(optionNames).toContain("channels");
    expect(optionNames).toContain("prompt");
    expect(optionNames).toContain("limit");

    expect(executionMap.get("learn")?.has("history")).toBe(true);
  }, 30000);

  it("/memory history still contains remove and not import", async () => {
    const { registrationData, executionMap } = await loadCommandData();

    const memoryCommand = registrationData.find((cmd) => cmd.name === "memory") as unknown as RegistrationPayload;
    expect(memoryCommand).toBeDefined();

    const historyGroup = memoryCommand.options?.find((opt: RegistrationPayload) => opt.name === "history");
    expect(historyGroup).toBeDefined();

    const subcommands = historyGroup.options?.map((opt: RegistrationPayload) => opt.name);
    expect(subcommands).toContain("remove");
    expect(subcommands).not.toContain("import");

    expect(executionMap.get("memory")?.has("history.remove")).toBe(true);
    expect(executionMap.get("memory")?.has("history.import")).toBe(false);
  }, 30000);
});
