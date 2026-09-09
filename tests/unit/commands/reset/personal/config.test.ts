import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { ButtonStyle, type ChatInputCommandInteraction, type Client } from "discord.js";
import { execute, type ResetPersonalConfigDependencies } from "@/commands/reset/personal/config";
import type { UserRow } from "@/types/db/schema";
import { commandRegistry } from "@/utils/discord/commandRegistry";
import { ColorCode } from "@/utils/misc/logger";

const USER_ID = 51;
const USER_DISC_ID = "510000000000000001";
const SERVER_ID_A = 101;
const SERVER_ID_B = 102;
const LOCALE = "en-US";

function createMockInteraction(): ChatInputCommandInteraction {
  return {
    id: "interaction_test_personal_123",
    user: { id: USER_DISC_ID, displayName: "TestPersonalUser" },
  } as unknown as ChatInputCommandInteraction;
}

const mockUserData: UserRow = {
  user_id: USER_ID,
  user_disc_id: USER_DISC_ID,
  language_pref: "en-US",
  created_at: new Date(),
  updated_at: new Date(),
  privacy_level: 0,
  registration_locale: null,
};

function createMockDeps(): {
  deps: ResetPersonalConfigDependencies;
  calls: {
    promptWithConfirmation: unknown[];
    executePersonalReset: unknown[];
    replyInfoEmbed: unknown[];
  };
} {
  const calls = {
    promptWithConfirmation: [] as unknown[],
    executePersonalReset: [] as unknown[],
    replyInfoEmbed: [] as unknown[],
  };

  const deps: ResetPersonalConfigDependencies = {
    promptWithConfirmation: mock(async (_interaction, _locale, opts) => {
      calls.promptWithConfirmation.push(opts);
      return { outcome: "continue" as const };
    }),
    executePersonalReset: mock(async (input) => {
      calls.executePersonalReset.push(input);
      return {
        userDiscId: USER_DISC_ID,
        affectedServerIds: [SERVER_ID_A, SERVER_ID_B],
      };
    }),
    replyInfoEmbed: mock(async (_interaction, _locale, opts) => {
      calls.replyInfoEmbed.push(opts);
    }),
  };

  return { deps, calls };
}

describe("/reset personal config handler", () => {
  const activeSpies: Array<{ mockRestore(): void }> = [];

  afterEach(() => {
    for (const activeSpy of activeSpies.splice(0)) {
      activeSpy.mockRestore();
    }
  });

  it("prompts with Danger confirmation and correct locale keys without calling reset prematurely", async () => {
    const interaction = createMockInteraction();
    const { deps, calls } = createMockDeps();

    await execute({} as Client, interaction, mockUserData, LOCALE, deps);

    expect(calls.promptWithConfirmation).toHaveLength(1);
    expect(calls.promptWithConfirmation[0]).toMatchObject({
      embedTitleKey: "commands.reset.personal.config.confirm_title",
      embedDescriptionKey: "commands.reset.personal.config.confirm_description",
      embedColor: ColorCode.ERROR,
      continueStyle: ButtonStyle.Danger,
      continueLabelKey: "commands.reset.personal.config.confirm_button",
      cancelLabelKey: "general.pagination.cancel",
      useComponentsV2: true,
    });
  });

  it("passes exactly the three personal preserved-data rows and clickable command mentions", async () => {
    const mentionSpy = spyOn(commandRegistry, "getCommandMention").mockImplementation(
      (commandName, subcommandOrGroup, subcommand, clickable) =>
        `mention:${commandName}:${subcommandOrGroup ?? ""}:${subcommand ?? ""}:${clickable}`,
    );
    activeSpies.push(mentionSpy);
    const interaction = createMockInteraction();
    const { deps, calls } = createMockDeps();

    await execute({} as Client, interaction, mockUserData, LOCALE, deps);

    const confirmationOptions = calls.promptWithConfirmation[0] as {
      embedDescriptionVars: Record<string, string>;
    };
    expect(confirmationOptions.embedDescriptionVars).toEqual({
      personal_providers: "mention:personal:providers::true",
      personal_memories: "mention:personal:memories::true",
      scheduled_task_remove: "mention:scheduled-task:remove::true",
    });
    expect(mentionSpy.mock.calls).toEqual([
      ["personal", "providers", undefined, true],
      ["personal", "memories", undefined, true],
      ["scheduled-task", "remove", undefined, true],
    ]);
  });

  it("does not make any repository or reset calls when user cancels confirmation", async () => {
    const interaction = createMockInteraction();
    const { deps, calls } = createMockDeps();
    deps.promptWithConfirmation = mock(async () => ({ outcome: "cancel" as const }));

    await execute({} as Client, interaction, mockUserData, LOCALE, deps);

    expect(calls.executePersonalReset).toHaveLength(0);
    expect(calls.replyInfoEmbed).toHaveLength(0);
  });

  it("does not make any repository or reset calls when confirmation times out", async () => {
    const interaction = createMockInteraction();
    const { deps, calls } = createMockDeps();
    deps.promptWithConfirmation = mock(async () => ({ outcome: "timeout" as const }));

    await execute({} as Client, interaction, mockUserData, LOCALE, deps);

    expect(calls.executePersonalReset).toHaveLength(0);
    expect(calls.replyInfoEmbed).toHaveLength(0);
  });

  it("executes personal reset and replies with success when confirmed", async () => {
    const interaction = createMockInteraction();
    const { deps, calls } = createMockDeps();

    await execute({} as Client, interaction, mockUserData, LOCALE, deps);

    expect(calls.promptWithConfirmation).toHaveLength(1);
    expect(calls.executePersonalReset).toEqual([{ userId: USER_ID }]);
    expect(calls.replyInfoEmbed).toHaveLength(1);
    expect(calls.replyInfoEmbed[0]).toMatchObject({
      titleKey: "commands.reset.personal.config.success_title",
      descriptionKey: "commands.reset.personal.config.success_description",
      color: ColorCode.SUCCESS,
    });
  });

  it("handles missing user record gracefully when confirmed without throwing", async () => {
    const interaction = createMockInteraction();
    const { deps, calls } = createMockDeps();
    deps.executePersonalReset = mock(async (input) => {
      calls.executePersonalReset.push(input);
      return null;
    });

    await execute({} as Client, interaction, mockUserData, LOCALE, deps);

    expect(calls.promptWithConfirmation).toHaveLength(1);
    expect(calls.executePersonalReset).toHaveLength(1);
    expect(calls.replyInfoEmbed).toHaveLength(1);
    expect(calls.replyInfoEmbed[0]).toMatchObject({
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
    });
  });

  it("replies with error if personal reset operation throws an error", async () => {
    const interaction = createMockInteraction();
    const { deps, calls } = createMockDeps();
    deps.executePersonalReset = mock(async (input) => {
      calls.executePersonalReset.push(input);
      throw new Error("injected personal reset failure");
    });

    await execute({} as Client, interaction, mockUserData, LOCALE, deps);

    expect(calls.promptWithConfirmation).toHaveLength(1);
    expect(calls.executePersonalReset).toHaveLength(1);
    expect(calls.replyInfoEmbed).toHaveLength(1);
    expect(calls.replyInfoEmbed[0]).toMatchObject({
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
    });
  });

  it("delegates personal reset exclusively to executePersonalReset with the target userId", async () => {
    const interaction = createMockInteraction();
    const { deps, calls } = createMockDeps();

    await execute({} as Client, interaction, mockUserData, LOCALE, deps);

    expect(calls.promptWithConfirmation).toHaveLength(1);
    expect(calls.executePersonalReset).toEqual([{ userId: USER_ID }]);
    expect(calls.replyInfoEmbed).toHaveLength(1);
    expect(calls.replyInfoEmbed[0]).toMatchObject({
      titleKey: "commands.reset.personal.config.success_title",
      descriptionKey: "commands.reset.personal.config.success_description",
      color: ColorCode.SUCCESS,
    });
  });
});
