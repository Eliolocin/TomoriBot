/**
 * Autocomplete is an optimization, never authorization: Discord submits whatever the user typed,
 * not only what was suggested. These tests pin the execute-side contract that an omitted option
 * resolves through the shared fallback chain, while a value that does not resolve to a persona the
 * actor may currently trigger is rejected before any repository write.
 */
import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import type { ChatInputCommandInteraction, Client } from "discord.js";
import type { TomoriState, UserRow } from "@/types/db/schema";
import { personaRepository } from "@/utils/db/repositories";
import { conditioningMemoryRepository } from "@/utils/db/repositories/ConditioningMemoryRepository";
import * as whitelistCache from "@/utils/cache/channelWhitelistCache";
import * as spotlightCache from "@/utils/cache/personalSpotlightCache";
import * as tomoriChatModule from "@/events/messageCreate/tomoriChat";
import { createConditioningInteractionCommand } from "@/utils/conditioning/conditioningInteractionCommand";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

function createPersona(personaId: number, lineageId: number, nickname: string, isAlter: boolean): TomoriState {
  return {
    persona_id: personaId,
    persona_lineage_id: lineageId,
    persona_nickname: nickname,
    is_alter: isAlter,
    server_id: 7,
    config: { autoch_disc_ids: [], autoch_persona_overrides: [], message_fetch_limit: 80 },
  } as unknown as TomoriState;
}

const MAIN = createPersona(1, 101, "Main", false);
const ALTER = createPersona(2, 102, "Alter", true);
const HIDDEN = createPersona(3, 103, "Hidden", true);

const spies: { mockRestore: () => void }[] = [];

function track<T extends { mockRestore: () => void }>(spy: T): T {
  spies.push(spy);
  return spy;
}

afterEach(() => {
  for (const spy of spies.splice(0)) {
    spy.mockRestore();
  }
});

/** Builds an interaction that clears every guard ahead of persona resolution. */
function createInteraction(personaOption: string | null) {
  const replies: unknown[] = [];
  const channel = {
    id: "channel-1",
    messages: { fetch: async () => new Map() },
    isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
  };

  return {
    replies,
    interaction: {
      channel,
      guild: {
        id: "guild-1",
        members: { me: { id: "bot" }, cache: { get: () => ({ roles: { cache: [] } }) } },
        channels: { cache: { get: () => channel } },
      },
      user: { id: "user-1" },
      options: {
        getString: (name: string) => (name === "persona" ? personaOption : null),
      },
      reply: async (payload: unknown) => {
        replies.push(payload);
      },
      deferReply: async () => undefined,
      followUp: async (payload: unknown) => {
        replies.push(payload);
      },
      replied: false,
      deferred: false,
    } as unknown as ChatInputCommandInteraction,
  };
}

/**
 * `restrictedPersonaIds` is the exclusion list: anything absent from it is allowed, and anything
 * present is allowed only when it also appears in `whitelistedPersonaIds`.
 */
function stubWorkspace(available: TomoriState[]): ReturnType<typeof spyOn> {
  const availableIds = new Set(available.map((persona) => persona.persona_id));
  const restricted = [MAIN, ALTER, HIDDEN]
    .map((persona) => persona.persona_id)
    .filter((personaId) => !availableIds.has(personaId));

  track(spyOn(personaRepository, "loadState").mockResolvedValue(MAIN));
  track(spyOn(personaRepository, "loadAllForServer").mockResolvedValue([MAIN, ALTER, HIDDEN]));
  track(
    spyOn(whitelistCache, "getCachedWhitelistStatus").mockResolvedValue({
      isTriggerAllowed: true,
      hasActivePersonaWhitelist: true,
      whitelistedPersonaIds: [],
      restrictedPersonaIds: restricted,
    } as unknown as Awaited<ReturnType<typeof whitelistCache.getCachedWhitelistStatus>>),
  );
  track(
    spyOn(spotlightCache, "getCachedPersonalSpotlightStatus").mockResolvedValue(
      null as unknown as Awaited<ReturnType<typeof spotlightCache.getCachedPersonalSpotlightStatus>>,
    ),
  );
  track(spyOn(tomoriChatModule, "tomoriChat").mockResolvedValue(undefined));
  return track(spyOn(conditioningMemoryRepository, "recordEvent").mockResolvedValue(null));
}

const userData = { user_id: 55 } as UserRow;
const client = { user: { id: "bot" } } as unknown as Client;

describe("conditioning persona resolution", () => {
  it("records against the named persona when the submitted id is eligible", async () => {
    const recordSpy = stubWorkspace([MAIN, ALTER]);
    const { execute } = createConditioningInteractionCommand("punish", "bite");
    const { interaction } = createInteraction("2");

    await execute(client, interaction, userData, "en-US");

    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy.mock.calls[0][0]).toMatchObject({ personaLineageId: 102, conditioningType: "punish" });
  });

  it("writes nothing when the submitted value is not a number", async () => {
    const recordSpy = stubWorkspace([MAIN, ALTER]);
    const { execute } = createConditioningInteractionCommand("punish", "bite");
    const { interaction } = createInteraction("not-an-id");

    await execute(client, interaction, userData, "en-US");

    expect(recordSpy).not.toHaveBeenCalled();
  });

  it("writes nothing when the submitted id does not exist", async () => {
    const recordSpy = stubWorkspace([MAIN, ALTER]);
    const { execute } = createConditioningInteractionCommand("punish", "bite");
    const { interaction } = createInteraction("9999");

    await execute(client, interaction, userData, "en-US");

    expect(recordSpy).not.toHaveBeenCalled();
  });

  it("writes nothing when the submitted id names a persona the actor may not trigger", async () => {
    // HIDDEN exists in the workspace but is outside this actor's whitelist, so a hand-typed id
    // for it must be refused rather than silently accepted or downgraded to the main persona.
    const recordSpy = stubWorkspace([MAIN, ALTER]);
    const { execute } = createConditioningInteractionCommand("punish", "bite");
    const { interaction } = createInteraction("3");

    await execute(client, interaction, userData, "en-US");

    expect(recordSpy).not.toHaveBeenCalled();
  });

  it("resolves through the fallback chain when the option is omitted", async () => {
    const recordSpy = stubWorkspace([MAIN, ALTER]);
    const { execute } = createConditioningInteractionCommand("reward", "headpat");
    const { interaction } = createInteraction(null);

    await execute(client, interaction, userData, "en-US");

    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy.mock.calls[0][0]).toMatchObject({ personaLineageId: 101, conditioningType: "reward" });
  });
});
