/**
 * Covers the shared fallback-persona chain used by /respond and the conditioning commands:
 * most recent speaker, then the channel's auto-trigger persona, then the main persona.
 *
 * The resolver takes a fetch callback rather than a Discord channel, so these tests drive every
 * tier without constructing Discord objects, and can assert that the callback is not invoked at
 * all when a single eligible persona makes the answer independent of history.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { Message } from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import * as personaTurnDetection from "@/utils/discord/personaTurnDetection";
import { resolveFallbackPersona } from "@/utils/discord/personaTurnDetectionResolver";

type PersonaOverrides = {
  autochDiscIds?: string[];
  autochPersonaOverrides?: { channel_disc_id: string; persona_id: number }[];
};

function makePersona(personaId: number, nickname: string, isAlter: boolean): TomoriState {
  return {
    persona_id: personaId,
    persona_nickname: nickname,
    is_alter: isAlter,
  } as unknown as TomoriState;
}

function makeTomoriState(overrides: PersonaOverrides = {}): TomoriState {
  return {
    config: {
      autoch_disc_ids: overrides.autochDiscIds ?? [],
      autoch_persona_overrides: overrides.autochPersonaOverrides ?? [],
      message_fetch_limit: 80,
    },
  } as unknown as TomoriState;
}

const MAIN = makePersona(1, "Main", false);
const ALTER_A = makePersona(2, "AlterA", true);
const ALTER_B = makePersona(3, "AlterB", true);

const noMessages = async (): Promise<Message[]> => [];

let lastActiveSpy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  lastActiveSpy?.mockRestore();
  lastActiveSpy = null;
});

describe("resolveFallbackPersona", () => {
  it("returns null when no persona is eligible", async () => {
    const result = await resolveFallbackPersona({
      availablePersonas: [],
      allPersonas: [MAIN],
      tomoriState: makeTomoriState(),
      effectiveChannelId: "channel-1",
      fetchRecentMessages: noMessages,
    });

    expect(result).toBeNull();
  });

  it("skips the history fetch entirely when only one persona is eligible", async () => {
    let fetchCalls = 0;
    const result = await resolveFallbackPersona({
      availablePersonas: [ALTER_A],
      allPersonas: [MAIN, ALTER_A],
      tomoriState: makeTomoriState(),
      effectiveChannelId: "channel-1",
      fetchRecentMessages: async () => {
        fetchCalls += 1;
        return [];
      },
    });

    expect(result).toBe(ALTER_A);
    expect(fetchCalls).toBe(0);
  });

  it("fetches history and prefers the persona that spoke most recently", async () => {
    lastActiveSpy = spyOn(personaTurnDetection, "findLastActivePersona").mockReturnValue(ALTER_B);

    let fetchCalls = 0;
    const result = await resolveFallbackPersona({
      availablePersonas: [MAIN, ALTER_A, ALTER_B],
      allPersonas: [MAIN, ALTER_A, ALTER_B],
      tomoriState: makeTomoriState(),
      effectiveChannelId: "channel-1",
      fetchRecentMessages: async () => {
        fetchCalls += 1;
        return [];
      },
    });

    expect(result).toBe(ALTER_B);
    expect(fetchCalls).toBe(1);
  });

  it("falls through when the last speaker is no longer eligible for this actor", async () => {
    // ALTER_B spoke last but is excluded by whitelist or spotlight, so it must not be revived here.
    lastActiveSpy = spyOn(personaTurnDetection, "findLastActivePersona").mockReturnValue(ALTER_B);

    const result = await resolveFallbackPersona({
      availablePersonas: [MAIN, ALTER_A],
      allPersonas: [MAIN, ALTER_A, ALTER_B],
      tomoriState: makeTomoriState(),
      effectiveChannelId: "channel-1",
      fetchRecentMessages: noMessages,
    });

    expect(result).toBe(MAIN);
  });

  it("uses the channel auto-trigger persona when nobody spoke recently", async () => {
    lastActiveSpy = spyOn(personaTurnDetection, "findLastActivePersona").mockReturnValue(null);

    const result = await resolveFallbackPersona({
      availablePersonas: [MAIN, ALTER_A, ALTER_B],
      allPersonas: [MAIN, ALTER_A, ALTER_B],
      tomoriState: makeTomoriState({
        autochDiscIds: ["channel-1"],
        autochPersonaOverrides: [{ channel_disc_id: "channel-1", persona_id: 3 }],
      }),
      effectiveChannelId: "channel-1",
      fetchRecentMessages: noMessages,
    });

    expect(result).toBe(ALTER_B);
  });

  it("prefers the actor's personal auto-trigger persona over the channel default", async () => {
    lastActiveSpy = spyOn(personaTurnDetection, "findLastActivePersona").mockReturnValue(null);

    const result = await resolveFallbackPersona({
      availablePersonas: [MAIN, ALTER_A, ALTER_B],
      allPersonas: [MAIN, ALTER_A, ALTER_B],
      tomoriState: makeTomoriState({
        autochDiscIds: ["channel-1"],
        autochPersonaOverrides: [{ channel_disc_id: "channel-1", persona_id: 3 }],
      }),
      effectiveChannelId: "channel-1",
      personalAutoTriggerPersonaId: 2,
      fetchRecentMessages: noMessages,
    });

    expect(result).toBe(ALTER_A);
  });

  it("falls back to the main persona when no other tier applies", async () => {
    lastActiveSpy = spyOn(personaTurnDetection, "findLastActivePersona").mockReturnValue(null);

    const result = await resolveFallbackPersona({
      availablePersonas: [ALTER_A, MAIN, ALTER_B],
      allPersonas: [MAIN, ALTER_A, ALTER_B],
      tomoriState: makeTomoriState(),
      effectiveChannelId: "channel-1",
      fetchRecentMessages: noMessages,
    });

    expect(result).toBe(MAIN);
  });
});
