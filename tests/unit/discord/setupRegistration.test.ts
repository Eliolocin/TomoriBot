import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import { PermissionsBitField, type ChatInputCommandInteraction } from "discord.js";
import { loadCommandData, ROOT_COMMAND_EXECUTION_KEY } from "@/utils/discord/commandLoader";
import { resolveCommandCooldown } from "@/events/interactionCreate/handleCommands";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";
import { execute } from "@/commands/setup";
import type { UserRow } from "@/types/db/schema";
import { serverRepository } from "@/utils/db/repositories";

beforeAll(async () => initializeLocalizer());

type RegistrationPayload = {
  name: string;
  description?: string;
  contexts?: number[];
  default_member_permissions?: string;
  options?: Array<{ name: string }>;
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

  it("does not register /config setup as a subcommand", async () => {
    const { registrationData, executionMap } = await loadCommandData();

    const configCommand = registrationData.find((cmd) => cmd.name === "config") as unknown as
      | RegistrationPayload
      | undefined;

    expect(configCommand).toBeDefined();
    if (!configCommand) return;

    // The bare root carries no options at all after the cutover, so the extraction holds a fortiori.
    expect(configCommand.options?.some((opt) => opt.name === "setup") ?? false).toBe(false);
    expect(executionMap.get("config")?.has("setup")).toBe(false);
    expect(configCommand.contexts).toBeUndefined();
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
  /**
   * The command is now only an entry point: it resolves the workspace key and delegates to
   * `startSetupWizard`, which owns the permission check and the workspace-health guard. These
   * assertions therefore read the wizard's own surface, which is the deferred ephemeral reply.
   */
  function makeCommandInteraction(options: { guildId: string | null; canManageGuild: boolean }): {
    interaction: ChatInputCommandInteraction;
    replies: Array<{ content?: string }>;
    state: { deferred: boolean };
  } {
    const replies: Array<{ content?: string }> = [];
    const state = { deferred: false };
    const interaction = {
      locale: "en-US",
      guildLocale: "en-US",
      guildId: options.guildId,
      user: { id: "user-1" },
      channel: { isDMBased: () => options.guildId === null },
      guild: options.guildId ? { id: options.guildId } : null,
      memberPermissions: {
        has: (perm: unknown) =>
          (perm === "ManageGuild" || perm === PermissionsBitField.Flags.ManageGuild) && options.canManageGuild,
      },
      replied: false,
      deferred: false,
      deferReply: async () => {
        state.deferred = true;
      },
      reply: async (payload: { content?: string }) => {
        replies.push(payload);
      },
      editReply: async (payload: { content?: string }) => {
        replies.push(payload);
      },
    } as unknown as ChatInputCommandInteraction;

    return { interaction, replies, state };
  }

  it("denies access to non-managers in guilds before any database read", async () => {
    const repoSpy = spyOn(serverRepository, "loadServerIdByDiscId").mockResolvedValue(null);
    const { interaction, replies, state } = makeCommandInteraction({ guildId: "guild-1", canManageGuild: false });

    await execute({} as unknown as import("discord.js").Client, interaction, {} as unknown as UserRow, "en-US");

    // Pins the guard ahead of every read: a denial that still touched the database would pass the
    // content assertion below while leaking that the workspace exists.
    expect(repoSpy).not.toHaveBeenCalled();
    expect(state.deferred).toBe(true);
    expect(replies[0]?.content).toBe(localizer("en-US", "commands.setup.wizard.permission_denied"));

    repoSpy.mockRestore();
  });

  it("allows access in DMs and reaches the workspace-health read", async () => {
    const repoSpy = spyOn(serverRepository, "loadServerIdByDiscId").mockResolvedValue(null);
    const { interaction, state } = makeCommandInteraction({ guildId: null, canManageGuild: false });

    try {
      await execute({} as unknown as import("discord.js").Client, interaction, {} as unknown as UserRow, "en-US");
    } catch (_e) {
      // Later reads may fail without a live database; the guard bypass is what this pins.
    }

    expect(state.deferred).toBe(true);
    expect(repoSpy).toHaveBeenCalledWith("user-1");

    repoSpy.mockRestore();
  });
});
