import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
  ButtonStyle,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type PermissionsBitField,
} from "discord.js";
import { execute, type ResetConfigDependencies } from "@/commands/reset/config";
import type { UserRow } from "@/types/db/schema";
import { commandRegistry } from "@/utils/discord/commandRegistry";
import { ColorCode } from "@/utils/misc/logger";

const SERVER_ID = 42;
const GUILD_DISC_ID = "123456789012345678";
const USER_DISC_ID = "987654321098765432";
const LOCALE = "en-US";

function createMockInteraction(options: {
  isGuild: boolean;
  hasManageGuild?: boolean;
  uncachedGuild?: boolean;
}): ChatInputCommandInteraction {
  const memberPermissions = {
    has: mock((perm: string) => perm === "ManageGuild" && (options.hasManageGuild ?? false)),
  } as unknown as PermissionsBitField;

  return {
    id: "interaction_test_123",
    guildId: options.isGuild ? GUILD_DISC_ID : null,
    guild: options.isGuild && !options.uncachedGuild ? ({ id: GUILD_DISC_ID } as Guild) : null,
    user: { id: USER_DISC_ID, displayName: "TestUser" },
    memberPermissions: options.isGuild ? memberPermissions : null,
  } as unknown as ChatInputCommandInteraction;
}

function createMockDeps(): {
  deps: ResetConfigDependencies;
  calls: {
    loadServerIdByDiscId: string[];
    promptWithConfirmation: unknown[];
    resetServerConfiguration: unknown[];
    replyInfoEmbed: unknown[];
    order: string[];
  };
} {
  const calls = {
    loadServerIdByDiscId: [] as string[],
    promptWithConfirmation: [] as unknown[],
    resetServerConfiguration: [] as unknown[],
    replyInfoEmbed: [] as unknown[],
    order: [] as string[],
  };

  const deps: ResetConfigDependencies = {
    loadServerIdByDiscId: mock(async (serverDiscId: string) => {
      calls.order.push("loadServerIdByDiscId");
      calls.loadServerIdByDiscId.push(serverDiscId);
      return SERVER_ID;
    }),
    promptWithConfirmation: mock(async (_interaction, _locale, opts) => {
      calls.order.push("promptWithConfirmation");
      calls.promptWithConfirmation.push(opts);
      return { outcome: "continue" as const };
    }),
    resetServerConfiguration: mock(async (input) => {
      calls.order.push("resetServerConfiguration");
      calls.resetServerConfiguration.push(input);
    }),
    replyInfoEmbed: mock(async (_interaction, _locale, opts) => {
      calls.order.push("replyInfoEmbed");
      calls.replyInfoEmbed.push(opts);
    }),
  };

  return { deps, calls };
}

describe("/reset config handler", () => {
  const activeSpies: Array<{ mockRestore(): void }> = [];

  afterEach(() => {
    for (const activeSpy of activeSpies.splice(0)) {
      activeSpy.mockRestore();
    }
  });

  it("blocks non-managers in a guild and makes zero repository or reset calls", async () => {
    const interaction = createMockInteraction({ isGuild: true, hasManageGuild: false });
    const { deps, calls } = createMockDeps();

    await execute({} as Client, interaction, {} as UserRow, LOCALE, deps);

    expect(calls.order).toEqual(["replyInfoEmbed"]);
    expect(calls.loadServerIdByDiscId).toHaveLength(0);
    expect(calls.promptWithConfirmation).toHaveLength(0);
    expect(calls.resetServerConfiguration).toHaveLength(0);
    expect(calls.replyInfoEmbed).toHaveLength(1);
    expect(calls.replyInfoEmbed[0]).toMatchObject({
      titleKey: "commands.reset.config.no_permission_title",
      color: ColorCode.ERROR,
    });
  });

  it("blocks non-managers even when guild object is uncached in interaction", async () => {
    const interaction = createMockInteraction({
      isGuild: true,
      hasManageGuild: false,
      uncachedGuild: true,
    });
    const { deps, calls } = createMockDeps();

    await execute({} as Client, interaction, {} as UserRow, LOCALE, deps);

    expect(calls.order).toEqual(["replyInfoEmbed"]);
    expect(calls.loadServerIdByDiscId).toHaveLength(0);
    expect(calls.promptWithConfirmation).toHaveLength(0);
    expect(calls.resetServerConfiguration).toHaveLength(0);
    expect(calls.replyInfoEmbed).toHaveLength(1);
    expect(calls.replyInfoEmbed[0]).toMatchObject({
      titleKey: "commands.reset.config.no_permission_title",
      color: ColorCode.ERROR,
    });
  });

  it("permits invocation in a DM without ManageGuild and resolves server from user snowflake", async () => {
    const interaction = createMockInteraction({ isGuild: false });
    const { deps, calls } = createMockDeps();

    await execute({} as Client, interaction, {} as UserRow, LOCALE, deps);

    expect(calls.order).toEqual([
      "loadServerIdByDiscId",
      "promptWithConfirmation",
      "resetServerConfiguration",
      "replyInfoEmbed",
    ]);
    expect(calls.loadServerIdByDiscId).toEqual([USER_DISC_ID]);
    expect(calls.promptWithConfirmation).toHaveLength(1);
    expect(calls.resetServerConfiguration).toHaveLength(1);
    expect(calls.resetServerConfiguration[0]).toEqual({
      serverId: SERVER_ID,
      serverDiscId: USER_DISC_ID,
    });
  });

  it("validates server record before confirmation and makes zero reset writes when cancelled", async () => {
    const interaction = createMockInteraction({ isGuild: true, hasManageGuild: true });
    const { deps, calls } = createMockDeps();
    deps.promptWithConfirmation = mock(async (_interaction, _locale, opts) => {
      calls.order.push("promptWithConfirmation");
      calls.promptWithConfirmation.push(opts);
      return { outcome: "cancel" as const };
    });

    await execute({} as Client, interaction, {} as UserRow, LOCALE, deps);

    expect(calls.order).toEqual(["loadServerIdByDiscId", "promptWithConfirmation"]);
    expect(calls.loadServerIdByDiscId).toEqual([GUILD_DISC_ID]);
    expect(calls.resetServerConfiguration).toHaveLength(0);
    expect(calls.replyInfoEmbed).toHaveLength(0);
  });

  it("validates server record before confirmation and makes zero reset writes on timeout", async () => {
    const interaction = createMockInteraction({ isGuild: true, hasManageGuild: true });
    const { deps, calls } = createMockDeps();
    deps.promptWithConfirmation = mock(async (_interaction, _locale, opts) => {
      calls.order.push("promptWithConfirmation");
      calls.promptWithConfirmation.push(opts);
      return { outcome: "timeout" as const };
    });

    await execute({} as Client, interaction, {} as UserRow, LOCALE, deps);

    expect(calls.order).toEqual(["loadServerIdByDiscId", "promptWithConfirmation"]);
    expect(calls.loadServerIdByDiscId).toEqual([GUILD_DISC_ID]);
    expect(calls.resetServerConfiguration).toHaveLength(0);
    expect(calls.replyInfoEmbed).toHaveLength(0);
  });

  it("handles missing server record gracefully before confirmation without prompting or resetting", async () => {
    const interaction = createMockInteraction({ isGuild: true, hasManageGuild: true });
    const { deps, calls } = createMockDeps();
    deps.loadServerIdByDiscId = mock(async (serverDiscId: string) => {
      calls.order.push("loadServerIdByDiscId");
      calls.loadServerIdByDiscId.push(serverDiscId);
      return null;
    });

    await execute({} as Client, interaction, {} as UserRow, LOCALE, deps);

    expect(calls.order).toEqual(["loadServerIdByDiscId", "replyInfoEmbed"]);
    expect(calls.loadServerIdByDiscId).toEqual([GUILD_DISC_ID]);
    expect(calls.promptWithConfirmation).toHaveLength(0);
    expect(calls.resetServerConfiguration).toHaveLength(0);
    expect(calls.replyInfoEmbed).toHaveLength(1);
    expect(calls.replyInfoEmbed[0]).toMatchObject({
      titleKey: "commands.reset.config.no_server_data_title",
      color: ColorCode.WARN,
    });
  });

  it("executes reset and replies with success when confirmed", async () => {
    const interaction = createMockInteraction({ isGuild: true, hasManageGuild: true });
    const { deps, calls } = createMockDeps();

    await execute({} as Client, interaction, {} as UserRow, LOCALE, deps);

    expect(calls.order).toEqual([
      "loadServerIdByDiscId",
      "promptWithConfirmation",
      "resetServerConfiguration",
      "replyInfoEmbed",
    ]);
    expect(calls.promptWithConfirmation).toHaveLength(1);
    expect(calls.promptWithConfirmation[0]).toMatchObject({
      embedTitleKey: "commands.reset.config.confirm_title",
      embedDescriptionKey: "commands.reset.config.confirm_description",
      embedColor: ColorCode.ERROR,
      continueStyle: ButtonStyle.Danger,
      continueLabelKey: "commands.reset.config.confirm_button",
      cancelLabelKey: "general.pagination.cancel",
      useComponentsV2: true,
    });
    expect(calls.loadServerIdByDiscId).toEqual([GUILD_DISC_ID]);
    expect(calls.resetServerConfiguration).toEqual([{ serverId: SERVER_ID, serverDiscId: GUILD_DISC_ID }]);
    expect(calls.replyInfoEmbed).toHaveLength(1);
    expect(calls.replyInfoEmbed[0]).toMatchObject({
      titleKey: "commands.reset.config.success_title",
      descriptionKey: "commands.reset.config.success_description",
      color: ColorCode.SUCCESS,
    });
  });

  it("passes exactly the five preserved-data rows and clickable command mentions", async () => {
    const mentionSpy = spyOn(commandRegistry, "getCommandMention").mockImplementation(
      (commandName, subcommandOrGroup, subcommand, clickable) =>
        `mention:${commandName}:${subcommandOrGroup ?? ""}:${subcommand ?? ""}:${clickable}`,
    );
    activeSpies.push(mentionSpy);
    const interaction = createMockInteraction({ isGuild: true, hasManageGuild: true });
    const { deps, calls } = createMockDeps();

    await execute({} as Client, interaction, {} as UserRow, LOCALE, deps);

    const confirmationOptions = calls.promptWithConfirmation[0] as {
      embedDescriptionVars: Record<string, string>;
    };
    expect(confirmationOptions.embedDescriptionVars).toEqual({
      persona_remove: "mention:persona:remove::true",
      memories: "mention:memories:::true",
      personal_memories: "mention:personal:memories::true",
      providers: "mention:providers:::true",
      personal_providers: "mention:personal:providers::true",
      scheduled_task_remove: "mention:scheduled-task:remove::true",
      nuke: "mention:nuke:::true",
    });
    expect(mentionSpy.mock.calls).toEqual([
      ["persona", "remove", undefined, true],
      ["memories", undefined, undefined, true],
      ["personal", "memories", undefined, true],
      ["providers", undefined, undefined, true],
      ["personal", "providers", undefined, true],
      ["scheduled-task", "remove", undefined, true],
      ["nuke", undefined, undefined, true],
    ]);
  });

  it("replies with error if reset operation fails", async () => {
    const interaction = createMockInteraction({ isGuild: true, hasManageGuild: true });
    const { deps, calls } = createMockDeps();
    deps.resetServerConfiguration = mock(async () => {
      calls.order.push("resetServerConfiguration");
      throw new Error("injected operation failure");
    });

    await execute({} as Client, interaction, {} as UserRow, LOCALE, deps);

    expect(calls.order).toEqual([
      "loadServerIdByDiscId",
      "promptWithConfirmation",
      "resetServerConfiguration",
      "replyInfoEmbed",
    ]);
    expect(calls.replyInfoEmbed).toHaveLength(1);
    expect(calls.replyInfoEmbed[0]).toMatchObject({
      titleKey: "general.errors.unknown_error_title",
      color: ColorCode.ERROR,
    });
  });
});
