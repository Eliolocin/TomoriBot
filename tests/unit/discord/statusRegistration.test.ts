import { beforeAll, describe, expect, it } from "bun:test";
import { ApplicationCommandOptionType, SlashCommandBuilder } from "discord.js";
import * as statusCommand from "@/commands/status";
import { loadCommandData, ROOT_COMMAND_EXECUTION_KEY } from "@/utils/discord/commandLoader";
import { localizer, initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

type ChoicePayload = {
  name: string;
  value: string;
  name_localizations?: Record<string, string>;
};

type OptionPayload = {
  type: ApplicationCommandOptionType;
  name: string;
  description?: string;
  required?: boolean;
  description_localizations?: Record<string, string>;
  choices?: ChoicePayload[];
  options?: OptionPayload[];
};

type RegistrationPayload = {
  name: string;
  description_localizations?: Record<string, string>;
  contexts?: number[];
  default_member_permissions?: string;
  options?: OptionPayload[];
};

const scopeChoices = [
  ["scope_choice_server_model", "server_model"],
  ["scope_choice_server_config", "server_config"],
  ["scope_choice_server_channels", "server_channels"],
  ["scope_choice_personal", "personal"],
  ["scope_choice_persona", "persona"],
] as const;

function getScopeOption(command: RegistrationPayload): OptionPayload {
  expect(command.options).toHaveLength(1);
  const option = command.options?.[0];
  expect(option).toBeDefined();
  if (!option) throw new Error("Status command scope option is missing");
  return option;
}

function expectScopeRegistration(command: RegistrationPayload): void {
  const scopeOption = getScopeOption(command);
  expect(scopeOption.type).toBe(ApplicationCommandOptionType.String);
  expect(scopeOption.name).toBe("scope");
  expect(scopeOption.required).toBe(true);
  expect(scopeOption.description_localizations?.ja).toBe(localizer("ja", "commands.status.scope_description"));

  expect(scopeOption.choices).toHaveLength(scopeChoices.length);
  expect(scopeOption.choices?.map((choice) => choice.value)).toEqual(scopeChoices.map(([, value]) => value));
  for (let index = 0; index < scopeChoices.length; index++) {
    const [key, value] = scopeChoices[index];
    const choice = scopeOption.choices?.[index];
    expect(choice).toBeDefined();
    if (!choice) throw new Error(`Status choice ${value} is missing`);
    expect(choice.value).toBe(value);
    expect(choice.name_localizations?.ja).toBe(localizer("ja", `commands.status.${key}`));
  }
}

describe("/status registration", () => {
  it("registers a bare root with the exact scope option and choices", async () => {
    const { registrationData } = await loadCommandData();
    const status = registrationData.find((command) => command.name === "status") as unknown as
      | RegistrationPayload
      | undefined;

    expect(status).toBeDefined();
    if (!status) return;

    expect(status.contexts).toBeUndefined();
    expect(status.default_member_permissions).toBeUndefined();
    expect(status.description_localizations?.ja).toBe(localizer("ja", "commands.status.description"));
    expect(statusCommand.configureCommand(new SlashCommandBuilder()).toJSON().name).toBe("status");
    expect((statusCommand as Record<string, unknown>).guildOnly).toBeUndefined();
    expect((statusCommand as Record<string, unknown>).managerOnly).toBeUndefined();
    expectScopeRegistration(status);
  });

  it("retains /tool status and resolves its Japanese localizations through the compatibility alias", async () => {
    const { registrationData } = await loadCommandData();
    const tool = registrationData.find((command) => command.name === "tool") as unknown as
      | RegistrationPayload
      | undefined;

    expect(tool).toBeDefined();
    if (!tool) return;

    const status = tool.options?.find((option) => option.name === "status");
    expect(status).toBeDefined();
    if (!status) return;

    expect(status.description_localizations?.ja).toBe(localizer("ja", "commands.status.description"));
    expectScopeRegistration(status);
  });

  it("wires both command paths to the same coordinator function", async () => {
    const { executionMap } = await loadCommandData();
    const statusExecution = executionMap.get("status");
    const toolStatusExecution = executionMap.get("tool")?.get("status");

    expect(statusExecution).toBeDefined();
    if (!statusExecution) return;

    expect(Array.from(statusExecution.keys())).toEqual([ROOT_COMMAND_EXECUTION_KEY]);
    expect(toolStatusExecution).toBe(statusExecution.get(ROOT_COMMAND_EXECUTION_KEY));
  });
});
