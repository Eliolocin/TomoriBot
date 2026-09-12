import { beforeAll, describe, expect, it } from "bun:test";
import { ApplicationCommandOptionType } from "discord.js";
import enCommands from "@/locales/en-US/commands";
import jaCommands from "@/locales/ja/commands";
import { loadCommandData } from "@/utils/discord/commandLoader";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

type OptionPayload = {
  type: ApplicationCommandOptionType;
  name: string;
  description?: string;
  options?: OptionPayload[];
};

type RegistrationPayload = {
  name: string;
  contexts?: number[];
  default_member_permissions?: string;
  options?: OptionPayload[];
};

function collectKeyPaths(obj: Record<string, unknown>, prefix = ""): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      paths.push(...collectKeyPaths(value as Record<string, unknown>, fullPath));
    } else {
      paths.push(fullPath);
    }
  }
  return paths;
}

describe("/reset command registration", () => {
  it("registers /reset with no contexts and no default_member_permissions restrictions", async () => {
    const { registrationData, executionMap } = await loadCommandData();

    const resetCommand = registrationData.find((command) => command.name === "reset") as unknown as
      | RegistrationPayload
      | undefined;

    expect(resetCommand).toBeDefined();
    if (!resetCommand) return;

    expect(resetCommand.contexts).toBeUndefined();
    expect(resetCommand.default_member_permissions).toBeUndefined();

    const configSubcommand = resetCommand.options?.find((opt) => opt.name === "config");
    expect(configSubcommand).toBeDefined();
    expect(configSubcommand?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(configSubcommand?.options ?? []).toHaveLength(0);

    const personalGroup = resetCommand.options?.find((opt) => opt.name === "personal");
    expect(personalGroup).toBeDefined();
    expect(personalGroup?.type).toBe(ApplicationCommandOptionType.SubcommandGroup);

    const personalConfigSubcommand = personalGroup?.options?.find((opt) => opt.name === "config");
    expect(personalConfigSubcommand).toBeDefined();
    expect(personalConfigSubcommand?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(personalConfigSubcommand?.options ?? []).toHaveLength(0);

    const resetExecutions = executionMap.get("reset");
    expect(resetExecutions).toBeDefined();
    expect(resetExecutions?.has("config")).toBe(true);
    expect(resetExecutions?.has("personal.config")).toBe(true);
  });

  it("proves /server config remove is completely dissolved and absent from registration and locales", async () => {
    const { executionMap } = await loadCommandData();

    // /server is listed in configRegistration.test.ts's DISSOLVED_ROOTS, so `executionMap.get("server")`
    // is legitimately undefined; `?? false` keeps this assertion meaningful either way, rather than
    // requiring the root to still exist.
    const serverExecutions = executionMap.get("server");
    expect(serverExecutions?.has("config.remove") ?? false).toBe(false);

    const enPaths = collectKeyPaths(enCommands as Record<string, unknown>);
    const jaPaths = collectKeyPaths(jaCommands as Record<string, unknown>);

    const enOrphaned = enPaths.filter((path) => path.includes("server.config.remove"));
    const jaOrphaned = jaPaths.filter((path) => path.includes("server.config.remove"));

    expect(enOrphaned).toHaveLength(0);
    expect(jaOrphaned).toHaveLength(0);
  });
});
