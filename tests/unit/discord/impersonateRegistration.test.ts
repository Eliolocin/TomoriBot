import { beforeAll, describe, expect, it } from "bun:test";
import { loadCommandData } from "@/utils/discord/commandLoader";
import { initializeLocalizer } from "@/utils/text/localizer";
import { ApplicationCommandOptionType } from "discord.js";

beforeAll(async () => initializeLocalizer());

describe("/impersonate root registration", () => {
  it("registers /impersonate as a guild-only bare root", async () => {
    const { registrationData } = await loadCommandData();
    const impersonate = registrationData.find((c) => c.name === "impersonate");

    expect(impersonate).toBeDefined();
    expect(impersonate?.contexts).toEqual([0]);
    expect(impersonate?.default_member_permissions).toBeUndefined();
  }, 30000);

  it("makes the autocomplete handler reachable under the lookup key", async () => {
    const { autocompleteMap } = await loadCommandData();
    const impersonateAutocomplete = autocompleteMap.get("impersonate")?.get("persona");

    expect(impersonateAutocomplete).toBeDefined();
    expect(typeof impersonateAutocomplete).toBe("function");
  }, 30000);

  it("configures the subcommands and option types", async () => {
    const { registrationData } = await loadCommandData();
    const impersonate = registrationData.find((c) => c.name === "impersonate");

    const persona = impersonate?.options?.find(
      (o: import("discord.js").APIApplicationCommandOption) => o.name === "persona",
    ) as import("discord.js").APIApplicationCommandOption;
    const user = impersonate?.options?.find(
      (o: import("discord.js").APIApplicationCommandOption) => o.name === "user",
    ) as import("discord.js").APIApplicationCommandOption;
    const system = impersonate?.options?.find(
      (o: import("discord.js").APIApplicationCommandOption) => o.name === "system",
    ) as import("discord.js").APIApplicationCommandOption;

    expect(persona).toBeDefined();
    expect(user).toBeDefined();
    expect(system).toBeDefined();

    const personaOption = persona?.options?.find(
      (o: import("discord.js").APIApplicationCommandOption) => o.name === "persona",
    );
    expect(personaOption).toBeDefined();
    expect(personaOption?.autocomplete).toBe(true);

    const userOption = user?.options?.find((o: import("discord.js").APIApplicationCommandOption) => o.name === "user");
    expect(userOption).toBeDefined();
    expect(userOption?.type).toBe(ApplicationCommandOptionType.User);

    // /impersonate user takes ONLY the target. The bot generates the message itself via
    // tomoriChat(isUserImpersonation), so a `message` option here would be a field the user
    // must fill and the command then discards.
    expect(user?.options?.length).toBe(1);
    expect(user?.options?.some((option) => option.name === "message")).toBe(false);

    const systemPromptOption = system?.options?.find(
      (o: import("discord.js").APIApplicationCommandOption) => o.name === "prompt",
    );
    expect(systemPromptOption).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: API types use max_length but Discord.js typings use maxLength which is lost in toJSON
    expect((systemPromptOption as any)?.max_length).toBe(2000);
  }, 30000);

  it("ensures /bot no longer exists", async () => {
    const { registrationData } = await loadCommandData();
    const bot = registrationData.find((c) => c.name === "bot");
    expect(bot).toBeUndefined();
  }, 30000);
});
