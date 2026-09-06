import { beforeAll, describe, expect, it } from "bun:test";
import { ApplicationCommandOptionType, SlashCommandBuilder } from "discord.js";
import * as statusCommand from "@/commands/status";
import { loadCommandData } from "@/utils/discord/commandLoader";
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
  ["scope_choice_persona", "persona"],
  ["scope_choice_behavior", "behavior"],
  ["scope_choice_models", "models"],
  ["scope_choice_access", "access"],
  ["scope_choice_personal", "personal"],
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
});
