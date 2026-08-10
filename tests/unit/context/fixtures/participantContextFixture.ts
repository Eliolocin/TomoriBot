import { Collection, type Client, type GuildMember } from "discord.js";
import type {
  AssembledServerConfig,
  PersonalMemoryRow,
  PersonaUserBlockRow,
  ReminderRow,
  TomoriState,
  UserRow,
} from "@/types/db/schema";
import { PrivacyLevel } from "@/types/db/schema";
import type { StructuredContextItem } from "@/types/misc/context";
import {
  personalMemoryRepository,
  serverScheduleRepository,
  userNamingRepository,
  userRepository,
} from "@/utils/db/repositories";
import { buildParticipantContextItem } from "@/utils/text/context/participants";
import type { PublicPersonaProfile, SimplifiedMessageForContext } from "@/utils/text/context/types";
import { attachPersonaMentionMapToContextItems, buildPersonaMentionCatalog } from "@/utils/text/personaMentionHandles";
import {
  prepareParticipantContext,
  type ParticipantRequestScope,
  type PreparedParticipantContext,
} from "@/utils/text/participants/preparation";

export const PARTICIPANT_FIXTURE_IDS = {
  guild: "100000000000000001",
  channel: "200000000000000001",
  bot: "300000000000000001",
  human: "400000000000000001",
  referencedHuman: "400000000000000002",
  webhook: "500000000000000001",
  activePersona: 7,
  historicalPersona: 8,
  activeLineage: 70,
  matrix: "@bridge-user:example.test",
} as const;

interface ParticipantFixtureCounters {
  userRowLoads: number;
  candidateQueries: number;
  registrations: number;
  blacklistReads: number;
  privacyReads: number;
  personalMemoryReads: number;
  reminderReads: number;
  memberFetches: number;
  fullGuildMemberFetches: number;
}

class CountingMemberCache extends Collection<string, GuildMember> {
  hits = 0;

  override get(key: string): GuildMember | undefined {
    const member = super.get(key);
    if (member) this.hits += 1;
    return member;
  }
}

export interface ParticipantContextFixture {
  client: Client;
  config: AssembledServerConfig;
  activePersona: TomoriState;
  personas: TomoriState[];
  history: SimplifiedMessageForContext[];
  users: Map<string, UserRow>;
  eligibleReferenceCandidates: UserRow[];
  matrixUsers: Map<string, string>;
  syntheticUsers: Map<string, { displayName: string; type: "persona" | "webhook" }>;
  publicPersonaProfiles: PublicPersonaProfile[];
  personalMemories: PersonalMemoryRow[];
  reminders: ReminderRow[];
  personaUserBlocks: PersonaUserBlockRow[];
  blacklistedUserIds: Set<string>;
  counters: ParticipantFixtureCounters;
  hydrationObservations: {
    memoryLineages: number[];
    reminderScopes: Array<{
      discordId: string;
      personaId?: number;
      includeUnassignedForMainPersona?: boolean;
    }>;
  };
  memberCache: CountingMemberCache;
  restoreRepositories(): void;
}

function createUserRow(id: number, discordId: string, nickname: string): UserRow {
  return {
    user_id: id,
    user_disc_id: discordId,
    user_nickname: nickname,
    language_pref: "en-US",
    registration_locale: "en-US",
    privacy_level: PrivacyLevel.MINIMAL,
    personal_memories: [],
    physical_appearance_tags: [" auburn hair ", "green eyes"],
    nai_char_ref_url: null,
    impersonation_prompt: null,
    shortterm_cache_crossserver_opt_in: false,
    personal_dtm: "follow",
    personal_deliberate_tool_mode: "follow",
    timezone_offset: null,
  };
}

function createPersona(id: number, nickname: string, triggerWords: string[], lineageId: number): TomoriState {
  return {
    persona_id: id,
    persona_lineage_id: lineageId,
    persona_nickname: nickname,
    trigger_words: triggerWords,
    persona_attributes: [],
    attribute_list: [],
    physical_appearance_tags: [],
    is_alter: true,
  } as unknown as TomoriState;
}

function createMessage(
  id: string,
  authorId: string,
  authorName: string,
  authorType: "user" | "persona",
  content: string,
): SimplifiedMessageForContext {
  return {
    id,
    authorId,
    authorName,
    authorType,
    content,
    imageAttachments: [],
    videoAttachments: [],
  };
}

/**
 * Creates the deterministic Phase 0 fixture and replaces only the repository
 * methods reached by the legacy participant builder. Call `restoreRepositories`
 * in a `finally` block so the shared Bun test process cannot retain the fakes.
 */
export function createParticipantContextFixture(): ParticipantContextFixture {
  const counters: ParticipantFixtureCounters = {
    userRowLoads: 0,
    candidateQueries: 0,
    registrations: 0,
    blacklistReads: 0,
    privacyReads: 0,
    personalMemoryReads: 0,
    reminderReads: 0,
    memberFetches: 0,
    fullGuildMemberFetches: 0,
  };
  const hydrationObservations: ParticipantContextFixture["hydrationObservations"] = {
    memoryLineages: [],
    reminderScopes: [],
  };

  const human = createUserRow(41, PARTICIPANT_FIXTURE_IDS.human, "Alice Saved");
  const referencedHuman = createUserRow(42, PARTICIPANT_FIXTURE_IDS.referencedHuman, "Bob Saved");
  referencedHuman.physical_appearance_tags = [];
  const users = new Map([
    [human.user_disc_id, human],
    [referencedHuman.user_disc_id, referencedHuman],
  ]);
  const eligibleReferenceCandidates = [referencedHuman];

  const roles = new Collection<string, { id: string; name: string; position: number }>();
  roles.set(PARTICIPANT_FIXTURE_IDS.guild, {
    id: PARTICIPANT_FIXTURE_IDS.guild,
    name: "@everyone",
    position: 0,
  });
  roles.set("600000000000000001", { id: "600000000000000001", name: "Archivist", position: 2 });

  const makeMember = (discordId: string, displayName: string, nickname: string | null, username: string) =>
    ({
      id: discordId,
      displayName,
      nickname,
      roles: { cache: roles },
      user: {
        id: discordId,
        bot: false,
        globalName: `${displayName} Global`,
        username,
      },
      displayAvatarURL: () => `https://cdn.example.test/avatars/${discordId}.png`,
    }) as unknown as GuildMember;

  const memberCache = new CountingMemberCache();
  memberCache.set(human.user_disc_id, makeMember(human.user_disc_id, "Alice Display", "Alice Guild", "alice_username"));
  memberCache.set(
    referencedHuman.user_disc_id,
    makeMember(referencedHuman.user_disc_id, "Bob Display", "Bob Guild", "bob_username"),
  );

  const guild = {
    id: PARTICIPANT_FIXTURE_IDS.guild,
    preferredLocale: "en-US",
    members: {
      cache: memberCache,
      search: async () => new Collection<string, GuildMember>(),
      fetch: async (target?: string | { user: string }) => {
        counters.memberFetches += 1;
        if (!target) {
          counters.fullGuildMemberFetches += 1;
          return memberCache;
        }
        const discordId = typeof target === "string" ? target : target.user;
        return memberCache.get(discordId) ?? null;
      },
    },
  };
  const client = {
    user: { id: PARTICIPANT_FIXTURE_IDS.bot },
    users: { fetch: async () => null },
    guilds: { cache: new Map([[PARTICIPANT_FIXTURE_IDS.guild, guild]]) },
    options: { intents: { has: () => false } },
  } as unknown as Client;

  const config = {
    personal_memories_enabled: true,
    memory_tagging_enabled: true,
    channel_memory_enabled: true,
    timezone_offset: 8,
  } as AssembledServerConfig;
  const activePersona = createPersona(
    PARTICIPANT_FIXTURE_IDS.activePersona,
    "Tomori",
    ["tomori"],
    PARTICIPANT_FIXTURE_IDS.activeLineage,
  );
  activePersona.is_alter = false;
  activePersona.config = config;
  activePersona.physical_appearance_tags = ["black hair", "blue eyes"];
  const historicalPersona = createPersona(PARTICIPANT_FIXTURE_IDS.historicalPersona, "Ren", ["ren", "Ren Senpai"], 80);
  historicalPersona.persona_attributes = [
    { attribute_text: "Ren keeps a public notebook.", is_public: true },
    { attribute_text: "Ren has a private secret.", is_public: false },
  ] as TomoriState["persona_attributes"];
  historicalPersona.physical_appearance_tags = [" silver hair ", "violet eyes"];

  const personalMemories = [
    {
      personal_memory_id: 91,
      user_id: human.user_id,
      persona_lineage_id: PARTICIPANT_FIXTURE_IDS.activeLineage,
      content: "Alice likes archival maps.",
      tags: ["#general", "maps"],
    } as PersonalMemoryRow,
    {
      personal_memory_id: 94,
      user_id: human.user_id,
      persona_lineage_id: 80,
      content: "Alice remembers the alter's star chart.",
      tags: ["#general", "maps"],
    } as PersonalMemoryRow,
  ];
  const reminders = [
    {
      reminder_id: 92,
      reminder_purpose: "Bring the atlas",
      reminder_time: new Date("2026-08-02T01:00:00.000Z"),
      repetition_interval_hours: null,
      self_reminder: false,
      channel_disc_id: PARTICIPANT_FIXTURE_IDS.channel,
    } as ReminderRow,
    {
      reminder_id: 93,
      reminder_purpose: "Review the field notes",
      reminder_time: new Date("2026-08-02T02:00:00.000Z"),
      repetition_interval_hours: 24,
      self_reminder: true,
      channel_disc_id: PARTICIPANT_FIXTURE_IDS.channel,
    } as ReminderRow,
  ];
  const personaUserBlocks = [
    {
      persona_id: PARTICIPANT_FIXTURE_IDS.activePersona,
      user_disc_id: "499999999999999999",
      block_type: "block",
    } as PersonaUserBlockRow,
  ];
  const blacklistedUserIds = new Set<string>();

  const originals = {
    loadByDiscordId: userRepository.loadByDiscordId,
    loadContextReferenceCandidates: userRepository.loadContextReferenceCandidates,
    register: userRepository.register,
    isBlacklisted: userRepository.isBlacklisted,
    getPrivacyLevel: userRepository.getPrivacyLevel,
    loadNamingPreferences: userNamingRepository.loadPreferences,
    loadForUserLineage: personalMemoryRepository.loadForUserLineage,
    getPendingRemindersForUser: serverScheduleRepository.getPendingRemindersForUser,
  };

  userRepository.loadByDiscordId = async (discordId) => {
    counters.userRowLoads += 1;
    return users.get(discordId) ?? null;
  };
  userRepository.loadContextReferenceCandidates = async () => {
    counters.candidateQueries += 1;
    return eligibleReferenceCandidates.map((userRow) => ({
      userRow,
      evidence: { hasServerActivity: true, hasPersonalMemories: false, hasPendingTasks: false },
    }));
  };
  userRepository.register = async () => {
    counters.registrations += 1;
    return null;
  };
  userRepository.isBlacklisted = async (_guildId, discordId) => {
    counters.blacklistReads += 1;
    return blacklistedUserIds.has(discordId);
  };
  userRepository.getPrivacyLevel = async (discordId) => {
    counters.privacyReads += 1;
    return users.get(discordId)?.privacy_level ?? PrivacyLevel.MINIMAL;
  };
  userNamingRepository.loadPreferences = async () => new Map();
  personalMemoryRepository.loadForUserLineage = async (userId, lineageId) => {
    counters.personalMemoryReads += 1;
    hydrationObservations.memoryLineages.push(lineageId);
    return personalMemories.filter((memory) => memory.user_id === userId && memory.persona_lineage_id === lineageId);
  };
  serverScheduleRepository.getPendingRemindersForUser = async (
    discordId,
    _serverDiscId,
    personaId,
    includeUnassignedForMainPersona,
  ) => {
    counters.reminderReads += 1;
    hydrationObservations.reminderScopes.push({ discordId, personaId, includeUnassignedForMainPersona });
    if (discordId === PARTICIPANT_FIXTURE_IDS.human) return reminders.filter((reminder) => !reminder.self_reminder);
    if (discordId === PARTICIPANT_FIXTURE_IDS.bot) return reminders;
    return [];
  };

  let restored = false;
  return {
    client,
    config,
    activePersona,
    personas: [activePersona, historicalPersona],
    history: [
      createMessage(
        "history-human",
        human.user_disc_id,
        "Alice",
        "user",
        `Please ask <@${referencedHuman.user_disc_id}> and Ren Senpai about maps.`,
      ),
      createMessage("history-persona", String(historicalPersona.persona_id), "Ren", "persona", "I can help."),
      createMessage(
        "synthetic-user-block-hidden",
        "499999999999999999",
        "Blocked User",
        "user",
        "Blocked user Tomori is excluded.",
      ),
    ],
    users,
    eligibleReferenceCandidates,
    matrixUsers: new Map([[PARTICIPANT_FIXTURE_IDS.matrix, "Mika Matrix"]]),
    syntheticUsers: new Map([
      [`persona:${PARTICIPANT_FIXTURE_IDS.historicalPersona}`, { displayName: "Ren", type: "persona" }],
      [PARTICIPANT_FIXTURE_IDS.webhook, { displayName: "Webhook Guest", type: "webhook" }],
    ]),
    publicPersonaProfiles: [
      {
        personaId: PARTICIPANT_FIXTURE_IDS.historicalPersona,
        personaName: "Ren",
        attributes: ["Ren keeps a public notebook."],
        imageAppearanceTags: ["silver hair", "violet eyes"],
      },
    ],
    personalMemories,
    reminders,
    personaUserBlocks,
    blacklistedUserIds,
    counters,
    hydrationObservations,
    memberCache,
    restoreRepositories() {
      if (restored) return;
      restored = true;
      userRepository.loadByDiscordId = originals.loadByDiscordId;
      userRepository.loadContextReferenceCandidates = originals.loadContextReferenceCandidates;
      userRepository.register = originals.register;
      userRepository.isBlacklisted = originals.isBlacklisted;
      userRepository.getPrivacyLevel = originals.getPrivacyLevel;
      userNamingRepository.loadPreferences = originals.loadNamingPreferences;
      personalMemoryRepository.loadForUserLineage = originals.loadForUserLineage;
      serverScheduleRepository.getPendingRemindersForUser = originals.getPendingRemindersForUser;
    },
  };
}

export function normalizeParticipantContextItem(item: StructuredContextItem | null): unknown {
  if (!item) return null;

  return {
    role: item.role,
    metadataTag: item.metadataTag,
    parts: item.parts.map((part) =>
      part.type === "text"
        ? {
            ...part,
            text: part.text.replace(/^Current time:.*$/mu, "Current time: <NOW>."),
          }
        : part,
    ),
    conversationUsers: item.conversationUsers?.map((user) => ({ ...user, aliases: [...user.aliases] })),
    personaMentionMap: item.personaMentionMap
      ? [...item.personaMentionMap.entries()].sort(([left], [right]) => left.localeCompare(right))
      : undefined,
  };
}

export async function buildPreparedParticipantContext(
  fixture: ParticipantContextFixture,
  options: {
    activePersona?: TomoriState;
    requestScope?: ParticipantRequestScope;
    responderPersonaIds?: ReadonlySet<number>;
    onPrepared?: (prepared: PreparedParticipantContext) => void;
  } = {},
): Promise<StructuredContextItem> {
  const activePersona = options.activePersona ?? fixture.activePersona;
  const historicalPersonaKey = `persona:${PARTICIPANT_FIXTURE_IDS.historicalPersona}`;
  const baselineParticipantIds = [
    PARTICIPANT_FIXTURE_IDS.human,
    PARTICIPANT_FIXTURE_IDS.bot,
    historicalPersonaKey,
    PARTICIPANT_FIXTURE_IDS.webhook,
  ];
  const prepared = await prepareParticipantContext({
    client: fixture.client,
    guildId: PARTICIPANT_FIXTURE_IDS.guild,
    simplifiedMessageHistory: fixture.history,
    personas: fixture.personas,
    activePersona,
    visibleUserIds: baselineParticipantIds,
    syntheticUsers: fixture.syntheticUsers,
    matrixUsers: fixture.matrixUsers,
    responderPersonaIds: options.responderPersonaIds,
    requestScope: options.requestScope,
  });
  options.onPrepared?.(prepared);

  const item = await buildParticipantContextItem({
    client: fixture.client,
    guildId: PARTICIPANT_FIXTURE_IDS.guild,
    channelName: "general",
    channelId: PARTICIPANT_FIXTURE_IDS.channel,
    participantSeeds: prepared.discoveryPlan.seeds,
    triggererName: "Alice",
    botName: activePersona.persona_nickname ?? "Tomori",
    personaLineageId: activePersona.persona_lineage_id ?? undefined,
    tomoriState: activePersona,
    tomoriConfig: fixture.config,
    isDMChannel: false,
    isUserImpersonation: false,
    impersonatedIdentityName: null,
    matrixUsers: prepared.matrixUsers,
    syntheticUsers: prepared.syntheticUsers,
    publicPersonaProfiles: prepared.publicPersonaProfiles,
    preloadedReferencedUserRows: prepared.referencedUserRows,
    referencedUserIds: prepared.referencedUserIds,
    toolPromptMacroResolver: { expand: async (text) => text },
    conversationCorpus: fixture.history
      .map((message) => message.content ?? "")
      .join(" ")
      .toLowerCase(),
    convertMentions: async (text) => text,
  });
  if (!item) throw new Error("Participant baseline fixture unexpectedly rendered no context item");

  const [itemWithPersonaAliases] = attachPersonaMentionMapToContextItems(
    [item],
    buildPersonaMentionCatalog(fixture.personas),
  );
  if (!itemWithPersonaAliases) throw new Error("Participant baseline fixture lost its context item");
  return itemWithPersonaAliases;
}
