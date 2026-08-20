import { describe, expect, it, spyOn } from "bun:test";
import type { Client, AutocompleteInteraction } from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import { cooldownRepository, personaRepository, statRepository, userRepository } from "@/utils/db/repositories";
import { clearTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import * as whitelistCache from "@/utils/cache/channelWhitelistCache";
import handler, { resolveCommandCooldown } from "@/events/interactionCreate/handleCommands";

describe("handleCommands", () => {
  it("keeps /punish and /reward on the configured conditioning cooldown after leaving that category", () => {
    const conditioningCooldown = Number.parseInt(
      process.env.COOLDOWN_CONDITIONING || process.env.COOLDOWN_SERVER || "3000",
      10,
    );
    const defaultCooldown = Number.parseInt(process.env.DEFAULT_COMMAND_COOLDOWN || "1600", 10);

    expect(resolveCommandCooldown("conditioning")).toBe(conditioningCooldown);
    expect(resolveCommandCooldown("punish")).toBe(conditioningCooldown);
    expect(resolveCommandCooldown("reward")).toBe(conditioningCooldown);

    expect(resolveCommandCooldown("unknown-command")).toBe(defaultCooldown);
  });

  it("should respond with empty array for autocomplete when no autocomplete map matches", async () => {
    type MockAutocompleteInteraction = {
      isAutocomplete: () => boolean;
      isChatInputCommand: () => boolean;
      commandName: string;
      options: {
        getSubcommandGroup: () => string | null;
        getSubcommand: () => string | null;
      };
      respond: (choices: unknown[]) => Promise<void>;
      user: { id: string };
    };

    const mockInteraction: MockAutocompleteInteraction = {
      isAutocomplete: () => true,
      isChatInputCommand: () => false,
      commandName: "unknown-command",
      options: {
        getSubcommandGroup: () => null,
        getSubcommand: () => null,
      },
      respond: async () => {},
      user: { id: "123" },
    };

    const respondSpy = spyOn(mockInteraction, "respond");
    await handler({} as Client, mockInteraction as unknown as AutocompleteInteraction);
    expect(respondSpy).toHaveBeenCalledWith([]);
  });

  it("should respond with an empty array when the autocomplete handler throws, and not double-respond", async () => {
    type MockAutocompleteInteraction = {
      isAutocomplete: () => boolean;
      isChatInputCommand: () => boolean;
      commandName: string;
      options: {
        getSubcommandGroup: () => string | null;
        getSubcommand: () => string | null;
      };
      respond: (choices: unknown[]) => Promise<void>;
      responded: boolean;
      user: { id: string };
    };

    const mockInteraction: MockAutocompleteInteraction = {
      isAutocomplete: () => true,
      isChatInputCommand: () => false,
      commandName: "conditioning",
      options: {
        getSubcommandGroup: () => null,
        getSubcommand: () => "punish",
      },
      respond: async () => {
        mockInteraction.responded = true;
      },
      responded: false,
      user: { id: "123" },
    };

    const respondSpy = spyOn(mockInteraction, "respond");
    const cooldownSpy = spyOn(cooldownRepository, "setCommandCategoryCooldown");
    const userSpy = spyOn(userRepository, "register");
    const statSpy = spyOn(statRepository, "recordStat");

    // Reading the channel is the first thing the persona helper does, so throwing here exercises
    // the dispatcher's catch without stubbing the helper itself.
    Object.defineProperty(mockInteraction, "channel", {
      get: () => {
        throw new Error("Mock error in handler");
      },
    });

    await handler({} as Client, mockInteraction as unknown as AutocompleteInteraction);

    expect(respondSpy).toHaveBeenCalledWith([]);
    expect(cooldownSpy).not.toHaveBeenCalled();
    expect(userSpy).not.toHaveBeenCalled();
    expect(statSpy).not.toHaveBeenCalled();

    cooldownSpy.mockRestore();
    userSpy.mockRestore();
    statSpy.mockRestore();
  });
});

/**
 * Routes a real registered command through the dispatcher rather than calling the handler
 * directly. This is the seam a direct-call test cannot see: the loader type accepts a handler
 * that declares fewer parameters, so a one-argument handler assigns cleanly and then receives
 * the client where it expects the interaction.
 */
describe("autocomplete dispatch reaches its handler with the interaction", () => {
  it("passes the interaction, not the client, to a registered autocomplete handler", async () => {
    const persona = {
      persona_id: 42,
      persona_nickname: "Nerine",
      is_alter: false,
      config: {},
      llm: {},
    } as unknown as TomoriState;

    const personaSpy = spyOn(personaRepository, "loadAllForServer").mockResolvedValue([persona]);
    const userSpy = spyOn(userRepository, "loadByDiscordId").mockResolvedValue(null);
    const whitelistSpy = spyOn(whitelistCache, "getCachedWhitelistStatus").mockResolvedValue({
      isTriggerAllowed: true,
    } as unknown as Awaited<ReturnType<typeof whitelistCache.getCachedWhitelistStatus>>);
    clearTomoriStateCache();

    let received: { name: string; value: string }[] | null = null;
    const channel = { id: "channel-1", isThread: () => false };
    const mockInteraction = {
      isAutocomplete: () => true,
      isChatInputCommand: () => false,
      commandName: "punish",
      guild: {
        id: "guild-1",
        members: { cache: { get: () => ({ roles: { cache: [] } }) } },
        channels: { cache: { get: () => channel } },
      },
      channel,
      user: { id: "user-1" },
      options: {
        getSubcommandGroup: () => null,
        getSubcommand: () => "bite",
        getFocused: () => "ner",
      },
      responded: false,
      respond: async (choices: { name: string; value: string }[]) => {
        received = choices;
      },
    };

    await handler({} as Client, mockInteraction as unknown as AutocompleteInteraction);

    expect(received).toEqual([{ name: "Nerine", value: "42" }]);

    personaSpy.mockRestore();
    userSpy.mockRestore();
    whitelistSpy.mockRestore();
  });
});
