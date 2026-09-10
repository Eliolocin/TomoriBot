import { describe, expect, it } from "bun:test";
import { Collection, type Client, type GuildMember, type User } from "discord.js";
import {
  PrivacyLevel,
  type AssembledServerConfig,
  type PersonalMemoryRow,
  type ReminderRow,
  type TomoriState,
  type UserRow,
} from "@/types/db/schema";
import type { RequestSnapshot } from "@/types/misc/context";
import {
  createParticipantExposurePolicy,
  hydrateParticipantProfiles,
  type ActivePersonaScope,
  type ParticipantHydrationDependencies,
  type ParticipantHydrationParams,
} from "@/utils/text/participants/hydration";
import { aliasesForPurpose } from "@/utils/text/participants/aliases";
import { createBotKey, createDiscordUserKey, type ParticipantSeed } from "@/utils/text/participants/identity";
import type { PersonaNamingConfig } from "@/types/personaNaming";

const GUILD_ID = "100000000000000001";
const CHANNEL_ID = "200000000000000001";
const BOT_ID = "300000000000000001";
const USER_ID = "400000000000000001";

interface ReminderRead {
  discordId: string;
  personaId?: number;
  includeUnassignedForMainPersona?: boolean;
}

interface HydrationFixture {
  params: ParticipantHydrationParams;
  dependencies: ParticipantHydrationDependencies;
  reminderReads: ReminderRead[];
  memoryLineages: number[];
  privacyReads: string[];
  blacklistReads: string[];
  presenceMembers: Array<GuildMember | undefined>;
}

function createUserRow(overrides: Partial<UserRow> = {}): UserRow {
  return {
    user_id: 41,
    user_disc_id: USER_ID,
    user_nickname: "Alice Saved",
    language_pref: "en-US",
    registration_locale: "en-US",
    privacy_level: PrivacyLevel.MINIMAL,
    personal_memories: [],
    physical_appearance_tags: ["auburn hair", "green eyes"],
    nai_char_ref_url: null,
    impersonation_prompt: null,
    shortterm_cache_crossserver_opt_in: false,
    personal_dtm: "follow",
    personal_deliberate_tool_mode: "follow",
    timezone_offset: 8,
    ...overrides,
  };
}

function createMember(): GuildMember {
  const roles = new Collection<string, { id: string; name: string; position: number }>();
  roles.set(GUILD_ID, { id: GUILD_ID, name: "@everyone", position: 0 });
  roles.set("600000000000000001", {
    id: "600000000000000001",
    name: "Archivist",
    position: 2,
  });
  return {
    id: USER_ID,
    displayName: "Alice Guild",
    nickname: "Alice Guild",
    roles: { cache: roles },
    user: {
      id: USER_ID,
      bot: false,
      globalName: "Alice Global",
      username: "alice_username",
    },
  } as unknown as GuildMember;
}

function createReminder(id: number, selfReminder: boolean): ReminderRow {
  return {
    reminder_id: id,
    server_id: 1,
    channel_disc_id: CHANNEL_ID,
    user_discord_id: selfReminder ? BOT_ID : USER_ID,
    user_nickname: selfReminder ? "Tomori" : "Alice",
    reminder_purpose: selfReminder ? "Review field notes" : "Bring the atlas",
    reminder_time: new Date("2026-08-02T01:00:00.000Z"),
    repetition_interval_hours: null,
    self_reminder: selfReminder,
    created_by_user_id: 41,
    persona_id: 7,
  };
}

function createHumanSeed(): ParticipantSeed {
  return {
    key: createDiscordUserKey(USER_ID),
    reasons: new Set(["visible_author"]),
    aliases: [],
    capabilities: new Set(["mentionable"]),
    firstSeenOrder: 0,
  };
}

function createBotSeed(): ParticipantSeed {
  return {
    key: createBotKey(BOT_ID),
    reasons: new Set(["active_identity"]),
    aliases: [],
    capabilities: new Set(),
    firstSeenOrder: 1,
  };
}

function createFixture(
  options: {
    scope?: Partial<ActivePersonaScope>;
    userRow?: UserRow | null;
    member?: GuildMember | null;
    fallbackUser?: User | null;
    participantSeeds?: ParticipantSeed[];
    snapshot?: RequestSnapshot;
    namingConfig?: PersonaNamingConfig;
  } = {},
): HydrationFixture {
  const userRow = options.userRow === undefined ? createUserRow() : options.userRow;
  const member = options.member === undefined ? createMember() : options.member;
  const reminderReads: ReminderRead[] = [];
  const memoryLineages: number[] = [];
  const privacyReads: string[] = [];
  const blacklistReads: string[] = [];
  const presenceMembers: Array<GuildMember | undefined> = [];
  const guild = {
    id: GUILD_ID,
    preferredLocale: "en-US",
    members: { cache: new Collection<string, GuildMember>() },
  };
  const client = {
    user: { id: BOT_ID },
    guilds: { cache: new Map([[GUILD_ID, guild]]) },
    users: { fetch: async () => options.fallbackUser ?? null },
    options: { intents: { has: () => true } },
  } as unknown as Client;
  const activePersonaScope: ActivePersonaScope = {
    personaId: 7,
    lineageId: 70,
    isMainPersona: true,
    isUserImpersonation: false,
    ...options.scope,
  };
  const config = {
    personal_memories_enabled: true,
    channel_memory_enabled: true,
    timezone_offset: 8,
  } as AssembledServerConfig;
  const params: ParticipantHydrationParams = {
    client,
    guildId: GUILD_ID,
    channelName: "general",
    botName: "Tomori",
    participantSeeds: options.participantSeeds ?? [createHumanSeed(), createBotSeed()],
    activePersonaScope,
    tomoriState: {
      persona_id: activePersonaScope.personaId,
      persona_lineage_id: activePersonaScope.lineageId,
      is_alter: !activePersonaScope.isMainPersona,
      physical_appearance_tags: ["black hair"],
      naming_config: options.namingConfig,
    } as unknown as TomoriState,
    tomoriConfig: config,
    isDMChannel: false,
    impersonatedIdentityName: null,
    toolPromptMacroResolver: { expand: async (text) => text },
    conversationCorpus: "maps",
    snapshot: options.snapshot,
    convertMentions: async (text) => text,
  };
  const dependencies: ParticipantHydrationDependencies = {
    loadUserRow: async () => userRow,
    registerUser: async () => null,
    isBlacklisted: async (_guildId, discordId) => {
      blacklistReads.push(discordId);
      return false;
    },
    getPrivacyLevel: async (discordId) => {
      privacyReads.push(discordId);
      return userRow?.privacy_level ?? PrivacyLevel.MINIMAL;
    },
    loadPersonalMemories: async (userId, lineageId) => {
      memoryLineages.push(lineageId);
      return [
        {
          personal_memory_id: lineageId,
          user_id: userId,
          persona_lineage_id: lineageId,
          content: `Lineage ${lineageId} remembers maps.`,
          tags: ["#general", "maps"],
        } satisfies PersonalMemoryRow,
      ];
    },
    loadReminders: async (discordId, _guildId, personaId, includeUnassignedForMainPersona) => {
      reminderReads.push({ discordId, personaId, includeUnassignedForMainPersona });
      return discordId === BOT_ID ? [createReminder(93, true)] : [createReminder(92, false)];
    },
    loadMember: async () => member,
    loadFallbackUser: async () => options.fallbackUser ?? null,
    loadPresence: async (_client, _discordId, _guildId, preloadedMember) => {
      presenceMembers.push(preloadedMember);
      return "Online";
    },
    loadNamingPreferences: async () => new Map(),
  };
  return {
    params,
    dependencies,
    reminderReads,
    memoryLineages,
    privacyReads,
    blacklistReads,
    presenceMembers,
  };
}

describe("participant exposure policy", () => {
  const impersonationStates = ["none", "target", "other"] as const;

  for (const privacyLevel of [PrivacyLevel.MINIMAL, PrivacyLevel.PARTIAL, PrivacyLevel.FULL]) {
    for (const personalizationEnabled of [false, true]) {
      for (const blacklisted of [false, true]) {
        for (const hasServerNickname of [false, true]) {
          for (const impersonationState of impersonationStates) {
            it(`covers privacy=${privacyLevel}, personalization=${personalizationEnabled}, blacklist=${blacklisted}, nickname=${hasServerNickname}, impersonation=${impersonationState}`, () => {
              const isUserImpersonation = impersonationState !== "none";
              const isImpersonatedUser = impersonationState === "target";
              const policy = createParticipantExposurePolicy({
                privacyLevel,
                blacklisted,
                personalizationEnabled,
                hasServerNickname,
                isUserImpersonation,
                isImpersonatedUser,
              });
              const personalized = personalizationEnabled && !blacklisted;
              const canUseSavedNickname = personalized;

              expect(policy).toEqual({
                canUseSavedNickname,
                exposeSavedNicknameAlias: personalized && (!hasServerNickname || canUseSavedNickname),
                exposePresence: privacyLevel === PrivacyLevel.MINIMAL,
                exposeRoles: privacyLevel === PrivacyLevel.MINIMAL,
                exposePhysicalAppearance: !isUserImpersonation,
                exposeTimezone: !isUserImpersonation,
                exposeIdentity: personalized && privacyLevel === PrivacyLevel.MINIMAL,
                exposePersonalMemories:
                  (!isUserImpersonation || isImpersonatedUser) && personalized && privacyLevel === PrivacyLevel.MINIMAL,
              });
            });
          }
        }
      }
    }
  }
});

describe("participant hydration", () => {
  it("loads personal memories from the required active-persona lineage", async () => {
    const main = createFixture({ scope: { lineageId: 70 } });
    const alter = createFixture({ scope: { personaId: 8, lineageId: 80, isMainPersona: false } });

    const mainResult = await hydrateParticipantProfiles(main.params, main.dependencies);
    const alterResult = await hydrateParticipantProfiles(alter.params, alter.dependencies);
    const mainMemory = mainResult.profiles[0]?.fields.find((candidate) => candidate.kind === "personal_memories");
    const alterMemory = alterResult.profiles[0]?.fields.find((candidate) => candidate.kind === "personal_memories");

    expect(main.memoryLineages).toEqual([70]);
    expect(alter.memoryLineages).toEqual([80]);
    expect(mainMemory?.lines.join("\n")).toContain("Lineage 70 remembers maps.");
    expect(alterMemory?.lines.join("\n")).toContain("Lineage 80 remembers maps.");
  });

  it("keeps main and alter human reminder filters exact", async () => {
    const main = createFixture();
    const alter = createFixture({ scope: { personaId: 8, lineageId: 80, isMainPersona: false } });

    await hydrateParticipantProfiles(main.params, main.dependencies);
    await hydrateParticipantProfiles(alter.params, alter.dependencies);

    expect(main.reminderReads[0]).toEqual({
      discordId: USER_ID,
      personaId: 7,
      includeUnassignedForMainPersona: true,
    });
    expect(alter.reminderReads[0]).toEqual({
      discordId: USER_ID,
      personaId: 8,
      includeUnassignedForMainPersona: false,
    });
  });

  it("loads persona self-tasks without human participants and suppresses them for impersonation", async () => {
    const normal = createFixture({ participantSeeds: [createBotSeed()] });
    const impersonated = createFixture({
      participantSeeds: [createBotSeed()],
      scope: { isUserImpersonation: true, impersonatedUserId: USER_ID },
    });

    const normalResult = await hydrateParticipantProfiles(normal.params, normal.dependencies);
    const impersonatedResult = await hydrateParticipantProfiles(impersonated.params, impersonated.dependencies);

    expect(normalResult.personaTaskLines.join("\n")).toContain("Review field notes");
    expect(normal.reminderReads).toEqual([{ discordId: BOT_ID, personaId: 7 }]);
    expect(impersonatedResult.personaTaskLines).toEqual([]);
    expect(impersonated.reminderReads).toEqual([]);
  });

  it("retains the participant when optional presence hydration fails", async () => {
    const fixture = createFixture();
    fixture.dependencies.loadPresence = async () => {
      throw new Error("presence unavailable");
    };

    const result = await hydrateParticipantProfiles(fixture.params, fixture.dependencies);
    const presence = result.profiles[0]?.fields.find((candidate) => candidate.kind === "presence");

    expect(result.profiles[0]?.displayName).toBe("Alice Saved");
    expect(presence).toMatchObject({
      visibility: { visible: false, reason: "optional_failure" },
      lines: [],
    });
  });

  it("skips a participant after critical identity lookup and registration fail", async () => {
    const fixture = createFixture({ userRow: null, member: createMember(), participantSeeds: [createHumanSeed()] });
    let registrations = 0;
    fixture.dependencies.registerUser = async () => {
      registrations += 1;
      return null;
    };

    const result = await hydrateParticipantProfiles(fixture.params, fixture.dependencies);

    expect(registrations).toBe(1);
    expect(result.profiles).toEqual([]);
  });

  it("never registers an identity discovered only by reference", async () => {
    const fixture = createFixture({ userRow: null, member: createMember(), participantSeeds: [createHumanSeed()] });
    fixture.params.referencedUserIds = new Set([USER_ID]);
    let registrations = 0;
    fixture.dependencies.registerUser = async () => {
      registrations += 1;
      return createUserRow();
    };

    const result = await hydrateParticipantProfiles(fixture.params, fixture.dependencies);

    expect(registrations).toBe(0);
    expect(result.profiles).toEqual([]);
  });

  it("uses fallback user identity when optional member data is unavailable", async () => {
    const fallbackUser = {
      id: USER_ID,
      globalName: "Alice Global",
      username: "alice_username",
    } as User;
    const fixture = createFixture({ member: null, fallbackUser });

    const result = await hydrateParticipantProfiles(fixture.params, fixture.dependencies);

    expect(result.profiles[0]).toMatchObject({
      displayName: "Alice Saved",
      primaryAlias: "Alice Global",
      resolvableTargetId: USER_ID,
    });
  });

  it("follows the live Discord display name while the saved nickname is unset", async () => {
    const fixture = createFixture({ userRow: createUserRow({ user_nickname: null }) });

    const result = await hydrateParticipantProfiles(fixture.params, fixture.dependencies);

    expect(result.profiles[0]).toMatchObject({
      displayName: "Alice Guild",
      primaryAlias: "Alice Guild",
      resolvableTargetId: USER_ID,
    });
  });

  it("uses triggerer snapshot policy and member fast paths", async () => {
    const preloadedMember = createMember();
    const fixture = createFixture({
      snapshot: {
        triggererUserRow: createUserRow(),
        triggererPrivacyLevel: PrivacyLevel.MINIMAL,
        isTriggererBlacklisted: false,
        preloadedMember,
      },
    });
    fixture.dependencies.getPrivacyLevel = async () => {
      throw new Error("snapshot privacy fast path was missed");
    };
    fixture.dependencies.isBlacklisted = async () => {
      throw new Error("snapshot blacklist fast path was missed");
    };

    await hydrateParticipantProfiles(fixture.params, fixture.dependencies);

    expect(fixture.privacyReads).toEqual([]);
    expect(fixture.blacklistReads).toEqual([]);
    expect(fixture.presenceMembers).toEqual([preloadedMember]);
  });

  it("returns stable owned fields with explicit visibility decisions", async () => {
    const fixture = createFixture();

    const result = await hydrateParticipantProfiles(fixture.params, fixture.dependencies);
    const human = result.profiles[0];

    expect(human?.fields.map((candidate) => candidate.kind)).toEqual([
      "physical_appearance",
      "naming",
      "identity",
      "timezone",
      "presence",
      "roles",
      "personal_memories",
      "human_reminders",
    ]);
    expect(human?.fields.map((candidate) => candidate.order)).toEqual([10, 12, 15, 20, 30, 40, 50, 60]);
    expect(human?.fields.every((candidate) => candidate.owner === human.key)).toBe(true);
    expect(human?.fields.every((candidate) => typeof candidate.visibility.visible === "boolean")).toBe(true);
  });

  it("names each affix separately from the nickname when an affix resolves", async () => {
    const fixture = createFixture({
      userRow: createUserRow({ suffix_override: "-san" }),
      namingConfig: { prefixes: { neutral: "Master" }, suffixes: {}, addressTerms: {} },
    });

    const result = await hydrateParticipantProfiles(fixture.params, fixture.dependencies);
    const naming = result.profiles[0]?.fields.find((candidate) => candidate.kind === "naming");

    expect(naming?.visibility).toMatchObject({ visible: true });
    expect(naming?.lines[0]).toBe(
      '- Tomori calls Alice Saved "Master Alice Saved-san" (prefix "Master", suffix "-san")',
    );
  });

  it("exposes the composed name and the effective nickname as tool targets", async () => {
    const fixture = createFixture({
      userRow: createUserRow({ suffix_override: "-san" }),
      namingConfig: { prefixes: { neutral: "Master" }, suffixes: {}, addressTerms: {} },
    });

    const result = await hydrateParticipantProfiles(fixture.params, fixture.dependencies);
    const toolTargets = aliasesForPurpose(result.profiles[0]?.aliases ?? [], "tool_target").map((alias) => alias.value);

    expect(toolTargets).toContain("Master Alice Saved-san");
    expect(toolTargets).toContain("Alice Saved");
  });

  it("omits the naming line entirely when no affix resolves", async () => {
    const fixture = createFixture();

    const result = await hydrateParticipantProfiles(fixture.params, fixture.dependencies);
    const naming = result.profiles[0]?.fields.find((candidate) => candidate.kind === "naming");

    expect(naming?.visibility.visible).toBe(false);
    expect(naming?.lines).toEqual([]);
  });

  it("emits only configured identity fields at minimal privacy", async () => {
    const fixture = createFixture({
      userRow: createUserRow({
        gender_identity: "nonbinary",
        pronouns: "they/them",
      }),
    });

    const result = await hydrateParticipantProfiles(fixture.params, fixture.dependencies);
    const identity = result.profiles[0]?.fields.find((candidate) => candidate.kind === "identity");

    expect(identity).toMatchObject({ visibility: { visible: true, reason: "visible" } });
    expect(identity?.lines).toEqual(["- Gender Identity: nonbinary", "- Pronouns: they/them"]);
    expect(identity?.lines.join("\n")).not.toMatch(/unknown|unspecified|orientation/iu);
  });

  it("omits raw identity fields when privacy is restrictive", async () => {
    const fixture = createFixture({
      userRow: createUserRow({
        privacy_level: PrivacyLevel.PARTIAL,
        gender_identity: "nonbinary",
        pronouns: "they/them",
      }),
    });

    const result = await hydrateParticipantProfiles(fixture.params, fixture.dependencies);
    const identity = result.profiles[0]?.fields.find((candidate) => candidate.kind === "identity");

    expect(identity).toMatchObject({ visibility: { visible: false, reason: "privacy" }, lines: [] });
  });

  it("attaches public persona fields to their stable persona owner", async () => {
    const personaSeed: ParticipantSeed = {
      key: { kind: "persona", personaId: 8 },
      reasons: new Set(["historical_persona"]),
      aliases: [],
      capabilities: new Set(),
      firstSeenOrder: 0,
      sourceDisplayName: "Ren",
    };
    const fixture = createFixture({ participantSeeds: [personaSeed] });
    fixture.params.publicPersonaProfiles = [
      {
        personaId: 8,
        personaName: "Ren",
        attributes: ["Ren keeps a public notebook."],
        imageAppearanceTags: ["silver hair"],
      },
    ];

    const result = await hydrateParticipantProfiles(fixture.params, fixture.dependencies);
    const profile = result.profiles[0];

    expect(profile?.key).toEqual({ kind: "persona", personaId: 8 });
    expect(profile?.fields.map((candidate) => [candidate.kind, candidate.order])).toEqual([
      ["physical_appearance", 10],
      ["persona_public_attributes", 70],
    ]);
    expect(profile?.fields.every((candidate) => candidate.owner === profile.key)).toBe(true);
  });

  it("preserves channel and content tag filtering", async () => {
    const fixture = createFixture();
    fixture.dependencies.loadPersonalMemories = async (userId, lineageId) => [
      {
        personal_memory_id: 1,
        user_id: userId,
        persona_lineage_id: lineageId,
        content: "Matching memory",
        tags: ["#general", "maps"],
      },
      {
        personal_memory_id: 2,
        user_id: userId,
        persona_lineage_id: lineageId,
        content: "Wrong channel",
        tags: ["#off-topic", "maps"],
      },
      {
        personal_memory_id: 3,
        user_id: userId,
        persona_lineage_id: lineageId,
        content: "Wrong content tag",
        tags: ["#general", "recipes"],
      },
    ];

    const result = await hydrateParticipantProfiles(fixture.params, fixture.dependencies);
    const memoryLines = result.profiles[0]?.fields
      .find((candidate) => candidate.kind === "personal_memories")
      ?.lines.join("\n");

    expect(memoryLines).toContain("Matching memory");
    expect(memoryLines).not.toContain("Wrong channel");
    expect(memoryLines).not.toContain("Wrong content tag");
  });
});
