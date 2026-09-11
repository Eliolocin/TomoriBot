import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { resolveUserTarget } from "@/utils/discord/targetResolver";
import { ContextItemTag, type ConversationUserReference, type StructuredContextItem } from "@/types/misc/context";
import { EMPTY_PERSONA_NAMING_CONFIG, type PersonaNamingConfig } from "@/types/personaNaming";
import type { ToolContext } from "@/types/tool/interfaces";
import { userNamingRepository, userRepository } from "@/utils/db/repositories";
import { createParticipantAlias } from "@/utils/text/participants/aliases";
import { createDiscordUserKey, serializeParticipantKey } from "@/utils/text/participants/identity";

/**
 * Builds a minimal ToolContext carrying only the conversation-user metadata that
 * `resolveUserTarget`'s first (conversation) stage reads. That stage short-circuits
 * before any guild/client access, so a partial cast is safe for these cases.
 */
function buildContext(conversationUsers: ConversationUserReference[]): ToolContext {
  const contextItem: StructuredContextItem = {
    role: "user",
    parts: [{ type: "text", text: "" }],
    metadataTag: ContextItemTag.KNOWLEDGE_USERS_IN_CONVERSATION,
    conversationUsers,
  };
  return { contextItems: [contextItem] } as unknown as ToolContext;
}

function buildIndexedContext(conversationUsers: ConversationUserReference[]): ToolContext {
  const targets = conversationUsers.map((reference) => {
    const key = createDiscordUserKey(reference.targetId);
    return {
      key,
      serializedKey: serializeParticipantKey(key),
      displayLabel: reference.displayLabel,
      primaryAlias: reference.displayLabel,
      targetId: reference.targetId,
      mentionable: reference.mentionable,
      inParticipantContext: true,
      aliases: reference.aliases.flatMap((value, index) => {
        const alias = createParticipantAlias({
          owner: key,
          value,
          source: index === 0 ? "saved_nickname" : "guild_nickname",
          purposes: ["tool_target"],
          exposure: "visible",
          priority: index,
        });
        return alias ? [alias] : [];
      }),
    };
  });
  return {
    contextItems: [
      {
        role: "user",
        parts: [{ type: "text", text: "" }],
        metadataTag: ContextItemTag.KNOWLEDGE_USERS_IN_CONVERSATION,
        conversationUsers: [],
        participantTargetIndex: { targets },
      },
    ],
  } as unknown as ToolContext;
}

describe("resolveUserTarget — conversation stage primary-name precedence", () => {
  // Reproduces the real collision: the asking user is rendered as their DB
  // nickname "Misuzu" but carries server nickname "Obonya" as a secondary
  // alias, while a different account's actual name is "Obonya".
  const misuzu: ConversationUserReference = {
    targetId: "111",
    displayLabel: "Misuzu",
    aliases: ["Misuzu", "Obonya"],
    mentionable: true,
  };
  const obonya: ConversationUserReference = {
    targetId: "222",
    displayLabel: "Obonya",
    aliases: ["Obonya"],
    mentionable: true,
  };

  it("prefers the primary-name match over a colliding secondary alias", async () => {
    const result = await resolveUserTarget("Obonya", buildIndexedContext([misuzu, obonya]));

    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.targetId).toBe("222");
      expect(result.displayLabel).toBe("Obonya");
      expect(result.source).toBe("conversation");
    }
  });

  it("still resolves the asking user by their primary (DB) name", async () => {
    const result = await resolveUserTarget("Misuzu", buildContext([misuzu, obonya]));

    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.targetId).toBe("111");
    }
  });

  it("is case- and whitespace-insensitive for the primary-name tie-break", async () => {
    const result = await resolveUserTarget("  oBoNyA  ", buildContext([misuzu, obonya]));

    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.targetId).toBe("222");
    }
  });

  it("stays ambiguous when two users share the same primary display name", async () => {
    const obonyaTwo: ConversationUserReference = {
      targetId: "333",
      displayLabel: "Obonya",
      aliases: ["Obonya"],
      mentionable: true,
    };
    const result = await resolveUserTarget("Obonya", buildContext([obonya, obonyaTwo]));

    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.candidates.map((candidate) => candidate.targetId).sort()).toEqual(["222", "333"]);
    }
  });

  it("stays ambiguous when the input only matches secondary aliases on multiple users", async () => {
    const ellen: ConversationUserReference = {
      targetId: "444",
      displayLabel: "Ellen",
      aliases: ["Ellen", "Obonya"],
      mentionable: true,
    };
    const result = await resolveUserTarget("Obonya", buildContext([misuzu, ellen]));

    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.candidates.map((candidate) => candidate.targetId).sort()).toEqual(["111", "444"]);
    }
  });

  it("resolves a unique secondary-alias match (no regression in the common case)", async () => {
    const result = await resolveUserTarget("Obonya", buildContext([misuzu]));

    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.targetId).toBe("111");
    }
  });
});

interface FakeGuildMember {
  id: string;
  displayName: string;
  globalName?: string;
  username: string;
}

/**
 * Builds a ToolContext whose guild answers the two calls the post-conversation
 * stages make: a prefix search (what Discord's member search actually does) and a
 * fetch by ID. Members absent from the map reject, matching a left server.
 */
function buildGuildContext(
  members: FakeGuildMember[],
  options?: { namingConfig?: PersonaNamingConfig; personaLineageId?: number },
): ToolContext {
  const memberObjects = new Map(
    members.map((member) => [
      member.id,
      {
        id: member.id,
        displayName: member.displayName,
        user: { globalName: member.globalName ?? null, username: member.username, bot: false },
      },
    ]),
  );

  const guild = {
    id: "guild-1",
    members: {
      search: async ({ query }: { query: string }) => {
        const normalizedQuery = query.trim().toLowerCase();
        return new Map(
          [...memberObjects].filter(([, member]) =>
            [member.displayName, member.user.globalName, member.user.username].some((value) =>
              value ? value.toLowerCase().startsWith(normalizedQuery) : false,
            ),
          ),
        );
      },
      fetch: async (discordId: string) => {
        const member = memberObjects.get(discordId);
        if (!member) throw new Error(`Unknown member ${discordId}`);
        return member;
      },
    },
  };

  return {
    guildId: "guild-1",
    client: { guilds: { cache: new Map([["guild-1", guild]]) } },
    contextItems: [],
    tomoriState: {
      persona_lineage_id: options?.personaLineageId ?? 7,
      naming_config: options?.namingConfig ?? EMPTY_PERSONA_NAMING_CONFIG,
    },
  } as unknown as ToolContext;
}

function stubNamingLookups(overrides?: {
  personaNicknames?: Array<{ userId: number; userDiscId: string }>;
  composedCandidates?: Parameters<typeof buildComposedCandidate>[0][];
  dbNicknames?: Array<{ user_disc_id: string }>;
}): void {
  spyOn(userNamingRepository, "findByPersonaNickname").mockResolvedValue(overrides?.personaNicknames ?? []);
  spyOn(userNamingRepository, "findComposedNameCandidates").mockResolvedValue(
    (overrides?.composedCandidates ?? []).map(buildComposedCandidate),
  );
  spyOn(userRepository, "findByNormalizedNickname").mockResolvedValue(
    (overrides?.dbNicknames ?? []) as unknown as Awaited<ReturnType<typeof userRepository.findByNormalizedNickname>>,
  );
}

function buildComposedCandidate(overrides: {
  userDiscId: string;
  globalNickname?: string | null;
  globalPrefixOverride?: string | null;
  globalSuffixOverride?: string | null;
  personaNicknameOverride?: string | null;
  personaPrefixOverride?: string | null;
}) {
  return {
    userId: 1,
    userDiscId: overrides.userDiscId,
    globalNickname: overrides.globalNickname ?? null,
    globalPrefixOverride: overrides.globalPrefixOverride ?? null,
    globalSuffixOverride: overrides.globalSuffixOverride ?? null,
    addressingStyle: null,
    personaNicknameOverride: overrides.personaNicknameOverride ?? null,
    personaPrefixOverride: overrides.personaPrefixOverride ?? null,
    personaSuffixOverride: null,
  };
}

describe("resolveUserTarget - persona-scoped and affixed names", () => {
  afterEach(() => {
    mock.restore();
  });

  const obonya: FakeGuildMember = { id: "222", displayName: "Obonya", username: "obonya" };

  it("resolves a persona-scoped nickname that no Discord name matches", async () => {
    stubNamingLookups({ personaNicknames: [{ userId: 1, userDiscId: "222" }] });

    const result = await resolveUserTarget("Papa", buildGuildContext([obonya]));

    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.targetId).toBe("222");
      expect(result.source).toBe("persona_nickname");
    }
  });

  it("reports ambiguity when two accounts share a persona-scoped nickname", async () => {
    stubNamingLookups({
      personaNicknames: [
        { userId: 1, userDiscId: "222" },
        { userId: 2, userDiscId: "333" },
      ],
    });

    const result = await resolveUserTarget(
      "Papa",
      buildGuildContext([obonya, { id: "333", displayName: "Sparrow", username: "sparrow" }]),
    );

    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.candidates.map((candidate) => candidate.targetId)).toEqual(["222", "333"]);
    }
  });

  it("strips a persona prefix so the bare name reaches the guild ladder", async () => {
    stubNamingLookups();

    const result = await resolveUserTarget(
      "Master Obonya",
      buildGuildContext([obonya], {
        namingConfig: { prefixes: { neutral: "Master" }, suffixes: {}, addressTerms: {} },
      }),
    );

    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.targetId).toBe("222");
      expect(result.source).toBe("guild_display_name");
    }
  });

  it("strips a persona suffix joined without a space", async () => {
    stubNamingLookups();

    const result = await resolveUserTarget(
      "Obonya-chan",
      buildGuildContext([obonya], {
        namingConfig: { prefixes: {}, suffixes: { neutral: "-chan" }, addressTerms: {} },
      }),
    );

    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.targetId).toBe("222");
    }
  });

  it("rebuilds a name composed from a user's own prefix override", async () => {
    stubNamingLookups({
      composedCandidates: [{ userDiscId: "222", globalNickname: "Obo", globalPrefixOverride: "Master" }],
    });

    const result = await resolveUserTarget("Master Obo", buildGuildContext([obonya]));

    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.targetId).toBe("222");
      expect(result.source).toBe("composed_name");
    }
  });

  it("rejects a containment hit whose composed name does not rebuild", async () => {
    stubNamingLookups({
      composedCandidates: [{ userDiscId: "222", globalNickname: "Obo" }],
    });

    const result = await resolveUserTarget("Master Obo", buildGuildContext([obonya]));

    expect(result.status).toBe("not_found");
  });

  it("does not invent a match when stripping leaves an unrelated name", async () => {
    stubNamingLookups();

    const result = await resolveUserTarget(
      "Master Sparrow",
      buildGuildContext([obonya], {
        namingConfig: { prefixes: { neutral: "Master" }, suffixes: {}, addressTerms: {} },
      }),
    );

    expect(result.status).toBe("not_found");
  });
});
