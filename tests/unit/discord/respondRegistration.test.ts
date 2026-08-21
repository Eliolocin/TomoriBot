/**
 * `/bot respond` became the bare root `/respond`. `bot` sits in neither restriction list, so the
 * move must add no restriction, and the old leaf must be gone rather than coexisting.
 *
 * All three relocated namespaces must resolve in both locales, asserting the returned string is not
 * its own key path.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { loadCommandData, ROOT_COMMAND_EXECUTION_KEY } from "@/utils/discord/commandLoader";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";

beforeAll(async () => {
  await initializeLocalizer();
}, 30000);

type RegistrationPayload = {
  name: string;
  description?: string;
  contexts?: number[];
  default_member_permissions?: string;
};

describe("/respond registration", () => {
  it("registers as an unrestricted bare root", async () => {
    const { registrationData, executionMap } = await loadCommandData();

    const respondCommand = registrationData.find((cmd) => cmd.name === "respond") as unknown as
      | RegistrationPayload
      | undefined;

    expect(respondCommand).toBeDefined();
    if (!respondCommand) return;

    expect(respondCommand.contexts).toBeUndefined();
    expect(respondCommand.default_member_permissions).toBeUndefined();
    expect(executionMap.get("respond")?.has(ROOT_COMMAND_EXECUTION_KEY)).toBe(true);
  }, 30000);

  it("removes the old /bot respond leaf while /bot keeps its other members", async () => {
    const { executionMap } = await loadCommandData();

    const botCommands = executionMap.get("bot");
    expect(botCommands).toBeDefined();
    if (!botCommands) return;

    expect(botCommands.has("respond")).toBe(false);
    expect(botCommands.size).toBeGreaterThan(0);
  }, 30000);

  it("resolves all three relocated namespaces in both locales", async () => {
    const testKeys = [
      "commands.respond.description",
      "general.errors.channel_missing_permissions_title",
      "commands.shared.persona_select.main_persona_description",
    ];

    for (const locale of ["en-US", "ja"]) {
      for (const key of testKeys) {
        const text = localizer(locale, key);
        expect(text).not.toBe(key);
        expect(text.length).toBeGreaterThan(0);
      }
    }
  }, 30000);
});
