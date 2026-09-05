import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { MessageFlags, type AutocompleteInteraction, type ChatInputCommandInteraction, type Client } from "discord.js";
import type { TomoriState, UserRow } from "@/types/db/schema";
import { personaRepository } from "@/utils/db/repositories";
import { clearTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import * as statsDashboard from "@/utils/stats/statsDashboard";
import { initializeLocalizer } from "@/utils/text/localizer";
import { autocomplete, execute, parsePersonaOptionId, resolveSelectedPersona } from "@/commands/stats/persona";

beforeAll(async () => {
  await initializeLocalizer();
});

type AutocompleteChoice = { name: string; value: string };

type MockAutocompleteInteraction = {
  guild: { id: string } | null;
  options: { getFocused: () => string };
  respond: (choices: AutocompleteChoice[]) => Promise<void>;
  getRespondChoices: () => AutocompleteChoice[];
  getRespondCallCount: () => number;
};

function createMockAutocompleteInteraction(
  focusedValue = "",
  guildId: string | null = "123",
): MockAutocompleteInteraction {
  let respondChoices: AutocompleteChoice[] = [];
  let callCount = 0;
  return {
    guild: guildId ? { id: guildId } : null,
    options: { getFocused: () => focusedValue },
    respond: async (choices: AutocompleteChoice[]) => {
      callCount++;
      respondChoices = choices;
    },
    getRespondChoices: () => respondChoices,
    getRespondCallCount: () => callCount,
  };
}

function createPersona(personaId: number, nickname: string, isAlter = true): TomoriState {
  return {
    server_id: 10,
    persona_id: personaId,
    persona_nickname: nickname,
    persona_lineage_id: 0,
    is_alter: isAlter,
    config: { tool_use_enabled: true },
    llm: {},
  } as unknown as TomoriState;
}

const spies: { mockRestore: () => void }[] = [];

function trackSpy<T extends { mockRestore: () => void }>(spy: T): T {
  spies.push(spy);
  return spy;
}

const client = { user: { id: "bot" } } as unknown as Client;

beforeEach(() => {
  clearTomoriStateCache();
});

afterEach(() => {
  for (const spy of spies.splice(0)) {
    spy.mockRestore();
  }
  clearTomoriStateCache();
});

describe("parsePersonaOptionId", () => {
  it("strictly accepts positive safe decimal integers", () => {
    expect(parsePersonaOptionId("1")).toBe(1);
    expect(parsePersonaOptionId("42")).toBe(42);
    expect(parsePersonaOptionId("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects whitespace, signs, decimals, zero, and junk", () => {
    expect(parsePersonaOptionId(" 42")).toBeNull();
    expect(parsePersonaOptionId("42 ")).toBeNull();
    expect(parsePersonaOptionId(" 42 ")).toBeNull();
    expect(parsePersonaOptionId("+42")).toBeNull();
    expect(parsePersonaOptionId("-42")).toBeNull();
    expect(parsePersonaOptionId("42.0")).toBeNull();
    expect(parsePersonaOptionId("42.5")).toBeNull();
    expect(parsePersonaOptionId("0")).toBeNull();
    expect(parsePersonaOptionId("00")).toBeNull();
    expect(parsePersonaOptionId("042")).toBeNull();
    expect(parsePersonaOptionId("abc")).toBeNull();
    expect(parsePersonaOptionId("42a")).toBeNull();
    expect(parsePersonaOptionId("")).toBeNull();
    expect(parsePersonaOptionId("   ")).toBeNull();
  });

  it("rejects non-strings and unsafe integers", () => {
    expect(parsePersonaOptionId(null)).toBeNull();
    expect(parsePersonaOptionId(undefined)).toBeNull();
    expect(parsePersonaOptionId(42)).toBeNull();
    expect(parsePersonaOptionId("9007199254740992")).toBeNull();
  });
});

describe("resolveSelectedPersona", () => {
  const personas = [createPersona(1, "Alice", false), createPersona(2, "Bob", true)];

  it("returns the persona matching the parsed ID", () => {
    const result = resolveSelectedPersona(personas, "2");
    expect(result).not.toBeNull();
    expect(result?.persona_id).toBe(2);
    expect(result?.persona_nickname).toBe("Bob");
  });

  it("returns null for malformed or missing option values", () => {
    expect(resolveSelectedPersona(personas, null)).toBeNull();
    expect(resolveSelectedPersona(personas, "")).toBeNull();
    expect(resolveSelectedPersona(personas, "invalid")).toBeNull();
    expect(resolveSelectedPersona(personas, "0")).toBeNull();
    expect(resolveSelectedPersona(personas, "-2")).toBeNull();
  });

  it("returns null for stale or cross-server persona IDs", () => {
    expect(resolveSelectedPersona(personas, "999")).toBeNull();
  });
});

describe("/stats persona autocomplete handler", () => {
  it("responds with an empty array when not in a guild", async () => {
    const interaction = createMockAutocompleteInteraction("", null);
    await autocomplete(client, interaction as unknown as AutocompleteInteraction);

    expect(interaction.getRespondCallCount()).toBe(1);
    expect(interaction.getRespondChoices()).toEqual([]);
  });

  it("responds with an empty array when the server has no personas", async () => {
    trackSpy(spyOn(personaRepository, "loadAllForServer").mockResolvedValue([]));

    const interaction = createMockAutocompleteInteraction("", "guild_empty");
    await autocomplete(client, interaction as unknown as AutocompleteInteraction);

    expect(interaction.getRespondCallCount()).toBe(1);
    expect(interaction.getRespondChoices()).toEqual([]);
  });

  it("caps choices at 25 and carries stable persona IDs as decimal string values", async () => {
    const personas = Array.from({ length: 30 }, (_, i) => createPersona(i + 100, `Persona ${i + 1}`, i !== 0));
    trackSpy(spyOn(personaRepository, "loadAllForServer").mockResolvedValue(personas));

    const interaction = createMockAutocompleteInteraction("", "guild_cap");
    await autocomplete(client, interaction as unknown as AutocompleteInteraction);

    const choices = interaction.getRespondChoices();
    expect(choices.length).toBe(25);
    expect(choices[0]).toEqual({ name: "Persona 1", value: "100" });
    expect(choices[24]).toEqual({ name: "Persona 25", value: "124" });
  });

  it("ranks exact matches before prefix before substring with source-order ties", async () => {
    const personas = [
      createPersona(1, "Not Bob", false),
      createPersona(2, "Bob", true),
      createPersona(3, "Bobby", true),
      createPersona(4, "Big Bob", true),
    ];
    trackSpy(spyOn(personaRepository, "loadAllForServer").mockResolvedValue(personas));

    const interaction = createMockAutocompleteInteraction("bob", "guild_rank");
    await autocomplete(client, interaction as unknown as AutocompleteInteraction);

    const choices = interaction.getRespondChoices();
    expect(choices.map((c) => c.name)).toEqual(["Bob", "Bobby", "Not Bob", "Big Bob"]);
    expect(choices.map((c) => c.value)).toEqual(["2", "3", "1", "4"]);
  });

  it("returns all guild personas without trigger-scoped or spotlight filtering", async () => {
    const personas = [createPersona(10, "Main Persona", false), createPersona(20, "Alter Persona", true)];
    trackSpy(spyOn(personaRepository, "loadAllForServer").mockResolvedValue(personas));

    const interaction = createMockAutocompleteInteraction("", "guild_all");
    await autocomplete(client, interaction as unknown as AutocompleteInteraction);

    const choices = interaction.getRespondChoices();
    expect(choices.length).toBe(2);
    expect(choices.map((c) => c.name)).toEqual(["Main Persona", "Alter Persona"]);
  });

  it("responds exactly once with an empty array when cache or repository errors", async () => {
    trackSpy(spyOn(personaRepository, "loadAllForServer").mockRejectedValue(new Error("DB failure")));

    const interaction = createMockAutocompleteInteraction("", "guild_err");
    await autocomplete(client, interaction as unknown as AutocompleteInteraction);

    expect(interaction.getRespondCallCount()).toBe(1);
    expect(interaction.getRespondChoices()).toEqual([]);
  });
});

describe("/stats persona execute handler", () => {
  type MockChatInputInteraction = {
    guild: { id: string; members: { me: { displayAvatarURL: () => string } | null } } | null;
    user: { id: string };
    id: string;
    options: { getString: (name: string) => string | null };
    deferReply: (options?: { flags?: MessageFlags }) => Promise<void>;
    deleteReply: () => Promise<void>;
    followUp: (payload: unknown) => Promise<{ id: string }>;
    editReply: (payload: unknown) => Promise<void>;
  };

  function createMockExecuteInteraction(personaOption: string | null): {
    interaction: MockChatInputInteraction;
    deferCalls: { flags?: MessageFlags }[];
    getDeleteCalls: () => number;
    followUpCalls: unknown[];
  } {
    const deferCalls: { flags?: MessageFlags }[] = [];
    let deleteCalls = 0;
    const followUpCalls: unknown[] = [];

    const interaction: MockChatInputInteraction = {
      guild: {
        id: "guild_test",
        members: {
          me: {
            displayAvatarURL: () => "https://example.com/bot_avatar.png",
          },
        },
      },
      user: { id: "user_test" },
      id: "interaction_123",
      options: {
        getString: (name: string) => (name === "persona" ? personaOption : null),
      },
      deferred: false,
      deferReply: async (options) => {
        interaction.deferred = true;
        deferCalls.push(options ?? {});
      },
      deleteReply: async () => {
        deleteCalls++;
      },
      followUp: async (payload) => {
        followUpCalls.push(payload);
        return { id: "public_msg_1" };
      },
      reply: async () => {},
      editReply: async () => {},
    };

    return { interaction, deferCalls, getDeleteCalls: () => deleteCalls, followUpCalls };
  }

  const mockUserData: UserRow = {
    user_id: 1,
    user_disc_id: "user_test",
  } as UserRow;

  beforeEach(() => {
    trackSpy(
      spyOn(personaRepository, "loadAllForServer").mockResolvedValue([
        createPersona(1, "Alice", false),
        createPersona(2, "Bob", true),
      ]),
    );
  });

  it("never reaches stats query or delivery when persona option is missing", async () => {
    const buildTabsSpy = trackSpy(spyOn(statsDashboard, "buildPersonaTabs"));
    const renderSpy = trackSpy(spyOn(statsDashboard, "renderStatsDashboardWithReply"));

    const { interaction, deferCalls, getDeleteCalls, followUpCalls } = createMockExecuteInteraction(null);
    await execute(client, interaction as unknown as ChatInputCommandInteraction, mockUserData, "en-US");

    expect(deferCalls).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(buildTabsSpy).not.toHaveBeenCalled();
    expect(renderSpy).not.toHaveBeenCalled();
    expect(getDeleteCalls()).toBe(0);
    expect(followUpCalls.length).toBe(0);
  });

  it("never reaches stats query or delivery when persona option is malformed", async () => {
    const buildTabsSpy = trackSpy(spyOn(statsDashboard, "buildPersonaTabs"));
    const renderSpy = trackSpy(spyOn(statsDashboard, "renderStatsDashboardWithReply"));

    for (const invalidInput of ["invalid", " 2 ", "-2", "0", "2.5"]) {
      const { interaction, getDeleteCalls, followUpCalls } = createMockExecuteInteraction(invalidInput);

      await execute(client, interaction as unknown as ChatInputCommandInteraction, mockUserData, "en-US");
      expect(buildTabsSpy).not.toHaveBeenCalled();
      expect(renderSpy).not.toHaveBeenCalled();
      expect(getDeleteCalls()).toBe(0);
      expect(followUpCalls.length).toBe(0);
    }
  });

  it("never reaches stats query or delivery when persona option is stale or cross-server", async () => {
    const buildTabsSpy = trackSpy(spyOn(statsDashboard, "buildPersonaTabs"));
    const renderSpy = trackSpy(spyOn(statsDashboard, "renderStatsDashboardWithReply"));

    const { interaction, getDeleteCalls, followUpCalls } = createMockExecuteInteraction("999");
    await execute(client, interaction as unknown as ChatInputCommandInteraction, mockUserData, "en-US");

    expect(buildTabsSpy).not.toHaveBeenCalled();
    expect(renderSpy).not.toHaveBeenCalled();
    expect(getDeleteCalls()).toBe(0);
    expect(followUpCalls.length).toBe(0);
  });

  it("delivers public stats dashboard upon valid persona selection", async () => {
    const buildTabsSpy = trackSpy(
      spyOn(statsDashboard, "buildPersonaTabs").mockResolvedValue(
        [] as unknown as Awaited<ReturnType<typeof statsDashboard.buildPersonaTabs>>,
      ),
    );
    const renderSpy = trackSpy(
      spyOn(statsDashboard, "renderStatsDashboardWithReply").mockImplementation(async (replyFn) => {
        await replyFn({ content: "Dashboard payload" });
      }),
    );

    const { interaction, deferCalls, getDeleteCalls, followUpCalls } = createMockExecuteInteraction("2");
    await execute(client, interaction as unknown as ChatInputCommandInteraction, mockUserData, "en-US");

    expect(deferCalls).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(buildTabsSpy).toHaveBeenCalled();
    expect(renderSpy).toHaveBeenCalled();
    expect(getDeleteCalls()).toBe(1);
    expect(followUpCalls.length).toBe(1);
    expect(followUpCalls[0]).toEqual({ content: "Dashboard payload" });
  });
});
