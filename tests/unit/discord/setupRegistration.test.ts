import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import { loadCommandData, ROOT_COMMAND_EXECUTION_KEY } from "@/utils/discord/commandLoader";
import { resolveCommandCooldown } from "@/events/interactionCreate/handleCommands";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";
import { PermissionsBitField, MessageFlags } from "discord.js";
import { execute } from "@/commands/setup";
import * as interactionHelper from "@/utils/discord/interactionHelper";
import { serverRepository } from "@/utils/db/repositories";

beforeAll(async () => initializeLocalizer());

type RegistrationPayload = {
  name: string;
  description?: string;
  contexts?: number[];
  default_member_permissions?: string;
  options?: unknown[];
};

describe("/setup registration", () => {
  it("registers as a manager-only DM-capable bare root", async () => {
    const { registrationData, executionMap } = await loadCommandData();

    const setupCommand = registrationData.find((cmd) => cmd.name === "setup") as unknown as
      | RegistrationPayload
      | undefined;

    expect(setupCommand).toBeDefined();
    if (!setupCommand) return;

    expect(setupCommand.contexts).toBeUndefined(); // DM-capable
    expect(setupCommand.default_member_permissions).toBe(String(PermissionsBitField.Flags.ManageGuild));
    expect(executionMap.get("setup")?.has(ROOT_COMMAND_EXECUTION_KEY)).toBe(true);
  });

  it("leaves /config setup as a bridge", async () => {
    const { registrationData, executionMap } = await loadCommandData();

    const configCommand = registrationData.find((cmd) => cmd.name === "config") as unknown as
      | RegistrationPayload
      | undefined;

    expect(configCommand).toBeDefined();
    if (!configCommand) return;

    const hasSetupOption = configCommand.options?.some((opt) => opt.name === "setup");
    expect(hasSetupOption).toBe(true);
    expect(executionMap.get("config")?.has("setup")).toBe(true);
    expect(configCommand.contexts).toBeUndefined();
    expect(configCommand.default_member_permissions).toBe("32");
  });

  it("resolves the description correctly in both locales, not as a nested path", () => {
    const en = localizer("en-US", "commands.setup.description");
    const ja = localizer("ja", "commands.setup.description");

    expect(en).not.toBe("commands.setup.description");
    expect(ja).not.toBe("commands.setup.description");
  });

  it("applies the correct cooldown to the setup root", () => {
    const configCooldown = Number.parseInt(process.env.COOLDOWN_CONFIG || "3000", 10);
    const defaultCooldown = Number.parseInt(process.env.DEFAULT_COMMAND_COOLDOWN || "1600", 10);

    expect(resolveCommandCooldown("setup")).toBe(configCooldown);
    expect(resolveCommandCooldown("config")).toBe(configCooldown);

    expect(resolveCommandCooldown("unknown-command")).toBe(defaultCooldown);
  });
});

describe("/setup execution authorization", () => {
  it("denies access to non-managers in guilds", async () => {
    const replyInfoEmbedSpy = spyOn(interactionHelper, "replyInfoEmbed").mockResolvedValue(undefined);
    const serverRepoSpy = spyOn(serverRepository, "loadServerIdByDiscId").mockResolvedValue(null);

    const mockInteraction = {
      guildId: "guild-1",
      memberPermissions: {
        has: () => false,
      },
      channel: {
        isDMBased: () => false,
      },
      guild: { id: "guild-1" },
    };

    await execute(
      {} as unknown as import("discord.js").Client,
      mockInteraction as unknown as import("discord.js").ChatInputCommandInteraction,
      {} as unknown as import("@/types/db/schema").UserRow,
      "en-US",
    );

    expect(replyInfoEmbedSpy).toHaveBeenCalled();
    // Pins the guard ahead of every read: a denial that still touched the database would pass
    // the assertions below while leaking that the workspace exists.
    expect(serverRepoSpy).not.toHaveBeenCalled();
    const args = replyInfoEmbedSpy.mock.calls[0];
    expect(args[2].titleKey).toBe("general.errors.permission_denied_title");
    expect(args[2].descriptionKey).toBe("general.errors.permission_denied_description");
    expect(args[2].flags).toBe(MessageFlags.Ephemeral);

    replyInfoEmbedSpy.mockRestore();
    serverRepoSpy.mockRestore();
  });

  it("allows access in DMs", async () => {
    const replyInfoEmbedSpy = spyOn(interactionHelper, "replyInfoEmbed").mockResolvedValue(undefined);

    const mockInteraction = {
      guildId: null, // DM
      memberPermissions: null,
      channel: {
        isDMBased: () => true,
      },
      user: { id: "user-1" },
      reply: async () => {},
    };

    const serverRepoSpy = spyOn(serverRepository, "loadServerIdByDiscId").mockResolvedValue(null);

    try {
      await execute(
        {} as unknown as import("discord.js").Client,
        mockInteraction as unknown as import("discord.js").ChatInputCommandInteraction,
        {} as unknown as import("@/types/db/schema").UserRow,
        "en-US",
      );
    } catch (_e) {
      // It might throw later on, we just care that it bypassed the auth guard.
    }

    expect(serverRepoSpy).toHaveBeenCalledWith("user-1");

    replyInfoEmbedSpy.mockRestore();
    serverRepoSpy.mockRestore();
  });
});
