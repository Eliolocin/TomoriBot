/**
 * The persona autocomplete list is not "every persona": it is filtered by whitelist and personal
 * spotlight exactly as a trigger would be. That filter is a privacy boundary, because a suggestion
 * reveals that a persona exists in a channel where the actor cannot use it. These tests pin the
 * filter, the ranking, and the 25-result ceiling Discord enforces.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { AutocompleteInteraction, Client } from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import type { PersonalSpotlightStatus } from "@/utils/db/repositories/UserRepository";
import { personaRepository, userRepository } from "@/utils/db/repositories";
import { clearTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import * as whitelistCache from "@/utils/cache/channelWhitelistCache";
import * as spotlightCache from "@/utils/cache/personalSpotlightCache";
import { handlePersonaAutocomplete } from "@/utils/discord/autocomplete/personaAutocomplete";

type AutocompleteChoice = { name: string; value: string };

type MockInteraction = {
  guild: unknown;
  channel: unknown;
  user: { id: string };
  options: { getFocused: () => string };
  respond: (choices: AutocompleteChoice[]) => Promise<void>;
  getRespondChoices: () => AutocompleteChoice[];
};

function createMockInteraction(focusedValue = "", guildId = "123"): MockInteraction {
  let respondChoices: AutocompleteChoice[] = [];
  return {
    guild: {
      id: guildId,
      members: { cache: { get: () => ({ roles: { cache: [] } }) } },
      channels: { cache: { get: () => ({ parent: null }) } },
    },
    channel: { id: "456", isThread: () => false },
    user: { id: "789" },
    options: { getFocused: () => focusedValue },
    respond: async (choices: AutocompleteChoice[]) => {
      respondChoices = choices;
    },
    getRespondChoices: () => respondChoices,
  };
}

function createPersona(personaId: number, nickname: string, isAlter = true): TomoriState {
  return {
    persona_id: personaId,
    persona_nickname: nickname,
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

function stubPersonaLoad(personas: TomoriState[]): void {
  trackSpy(spyOn(personaRepository, "loadAllForServer").mockResolvedValue(personas));
}

function stubUser(userId: number | null): void {
  const row =
    userId === null ? null : ({ user_id: userId } as Awaited<ReturnType<typeof userRepository.loadByDiscordId>>);
  trackSpy(spyOn(userRepository, "loadByDiscordId").mockResolvedValue(row));
}

function stubWhitelist(status: Record<string, unknown>): void {
  trackSpy(
    spyOn(whitelistCache, "getCachedWhitelistStatus").mockResolvedValue(
      status as unknown as Awaited<ReturnType<typeof whitelistCache.getCachedWhitelistStatus>>,
    ),
  );
}

function stubSpotlight(status: Partial<PersonalSpotlightStatus>): void {
  trackSpy(
    spyOn(spotlightCache, "getCachedPersonalSpotlightStatus").mockResolvedValue(
      status as unknown as PersonalSpotlightStatus,
    ),
  );
}

const client = { user: { id: "bot" } } as unknown as Client;

async function runAutocomplete(interaction: MockInteraction): Promise<AutocompleteChoice[]> {
  await handlePersonaAutocomplete(client, interaction as unknown as AutocompleteInteraction);
  return interaction.getRespondChoices();
}

beforeEach(() => {
  clearTomoriStateCache();
});

// mockClear leaves the stub installed, which leaks into every later file in the same lane.
afterEach(() => {
  for (const spy of spies.splice(0)) {
    spy.mockRestore();
  }
});

describe("handlePersonaAutocomplete", () => {
  it("caps the response at Discord's 25-choice limit", async () => {
    stubPersonaLoad(Array.from({ length: 30 }, (_, i) => createPersona(i + 1, `Persona ${i + 1}`, i !== 0)));
    stubUser(null);
    stubWhitelist({ isTriggerAllowed: true });

    const choices = await runAutocomplete(createMockInteraction("", "guild_25"));

    expect(choices.length).toBe(25);
  });

  it("returns an empty array rather than a selectable sentinel when nothing matches", async () => {
    stubPersonaLoad([createPersona(1, "Alice", false), createPersona(2, "Bob")]);
    stubUser(null);
    stubWhitelist({ isTriggerAllowed: true });

    const choices = await runAutocomplete(createMockInteraction("Charlie", "guild_empty"));

    expect(choices).toEqual([]);
  });

  it("ranks exact before prefix before substring", async () => {
    stubPersonaLoad([createPersona(1, "Not Bob", false), createPersona(2, "Bob"), createPersona(3, "Bobby")]);
    stubUser(null);
    stubWhitelist({ isTriggerAllowed: true });

    const choices = await runAutocomplete(createMockInteraction("bob", "guild_rank"));

    expect(choices.map((choice) => choice.name)).toEqual(["Bob", "Bobby", "Not Bob"]);
  });

  it("carries the stable persona id as the choice value, never a list position", async () => {
    stubPersonaLoad([createPersona(41, "Alice", false), createPersona(42, "Bob")]);
    stubUser(null);
    stubWhitelist({ isTriggerAllowed: true });

    const choices = await runAutocomplete(createMockInteraction("bob", "guild_value"));

    expect(choices).toEqual([{ name: "Bob", value: "42" }]);
  });

  it("excludes personas the whitelist excludes and personas the personal spotlight excludes", async () => {
    stubPersonaLoad([
      createPersona(1, "Allowed", false),
      createPersona(2, "Blocked by whitelist"),
      createPersona(3, "Blocked by spotlight"),
    ]);
    stubUser(999);
    stubWhitelist({
      isTriggerAllowed: true,
      hasActivePersonaWhitelist: true,
      restrictedPersonaIds: [2],
      whitelistedPersonaIds: [],
    });
    stubSpotlight({ personaIds: [1, 2] });

    const choices = await runAutocomplete(createMockInteraction("", "guild_filter"));

    expect(choices.map((choice) => choice.name)).toEqual(["Allowed"]);
  });
});
