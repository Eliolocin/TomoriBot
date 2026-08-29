import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "bun:test";
import { PermissionsBitField } from "discord.js";
import { ROOT_COMMAND_EXECUTION_KEY, loadCommandData } from "@/utils/discord/commandLoader";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

type RegistrationPayload = {
  name: string;
  contexts?: number[];
  default_member_permissions?: string;
  options?: RegistrationOption[];
};

type RegistrationOption = {
  name?: string;
  type?: number;
  options?: RegistrationOption[];
};

function findRegistration(
  registrationData: Awaited<ReturnType<typeof loadCommandData>>["registrationData"],
  name: string,
): RegistrationPayload | undefined {
  return registrationData.find((command) => command.name === name) as unknown as RegistrationPayload | undefined;
}

function hasCommandPath(registration: RegistrationPayload | undefined, ...segments: string[]): boolean {
  let options = registration?.options;
  for (const segment of segments) {
    const option = options?.find((candidate) => candidate.name === segment);
    if (!option) return false;
    options = option.options;
  }
  return true;
}

describe("Wave 4 provider panel registration", () => {
  it("registers /providers as one DM-capable manager-only bare root", async () => {
    const { executionMap, registrationData } = await loadCommandData();
    const providers = findRegistration(registrationData, "providers");

    expect(providers).toBeDefined();
    if (!providers) return;

    expect([...(executionMap.get("providers")?.keys() ?? [])]).toEqual([ROOT_COMMAND_EXECUTION_KEY]);
    expect(providers.options ?? []).toEqual([]);
    expect(providers.contexts).toBeUndefined();
    expect(providers.default_member_permissions).toBe(String(PermissionsBitField.Flags.ManageGuild));

    const moduleUrl = pathToFileURL(`${process.cwd()}/src/commands/providers.ts`).href;
    const providersModule = (await import(moduleUrl)) as Record<string, unknown>;
    expect(providersModule.managerOnly).toBe(true);
  }, 30000);

  it("keeps the personal root free of a Manage Guild default", async () => {
    const { registrationData } = await loadCommandData();
    const personal = findRegistration(registrationData, "personal");

    expect(personal).toBeDefined();
    if (!personal) return;

    expect(personal.default_member_permissions).toBeUndefined();
    expect(personal.contexts).toBeUndefined();
    expect(personal.options?.some((option) => option.name === "providers" && option.type === 1)).toBe(true);
  }, 30000);

  it("dissolves the absorbed provider leaves and permission-weaker ElevenLabs path", async () => {
    const { registrationData } = await loadCommandData();
    expect(findRegistration(registrationData, "provider")).toBeUndefined();
    expect(findRegistration(registrationData, "openrouter")).toBeUndefined();
    expect(findRegistration(registrationData, "optional-key")).toBeUndefined();
    expect(hasCommandPath(findRegistration(registrationData, "speech"), "elevenlabs")).toBe(false);

    const personal = findRegistration(registrationData, "personal");
    for (const path of [
      ["provider", "add"],
      ["provider", "remove"],
      ["provider", "toggle-models"],
      ["custom-endpoint", "add"],
      ["custom-endpoint", "edit"],
      ["custom-endpoint", "remove"],
      ["openrouter-model", "add"],
      ["openrouter-model", "remove"],
      ["provider", "model-text"],
      ["provider", "model-vision"],
      ["provider", "model-image"],
      ["provider", "model-video"],
      ["provider", "model-embedding"],
    ]) {
      expect(hasCommandPath(personal, ...path)).toBe(false);
    }
  }, 30000);
});
