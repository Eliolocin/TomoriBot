import { GatewayIntentBits, type Client, type Guild, type GuildMember, type User } from "discord.js";
import {
  PrivacyLevel,
  type AssembledServerConfig,
  type PersonalMemoryRow,
  type ReminderRow,
  type TomoriState,
  type UserRow,
} from "@/types/db/schema";
import type { RequestSnapshot } from "@/types/misc/context";
import { personalMemoryRepository, serverScheduleRepository, userRepository } from "@/utils/db/repositories";
import { resolvePreferredDiscordDisplayName } from "@/utils/discord/displayName";
import { log } from "@/utils/misc/logger";
import { formatMemoryWithId } from "@/utils/memory/memoryId";
import { getUserPresenceDetails } from "@/utils/text/context/history";
import type { MentionConverter } from "@/utils/text/context/templates";
import type { PublicPersonaProfile } from "@/utils/text/context/types";
import {
  buildBridgeUserAliases,
  buildDiscordUserAliases,
  buildPersonaAliases,
  type DiscordAliasIdentity,
} from "@/utils/text/participants/aliases";
import {
  createPersonaKey,
  serializeParticipantKey,
  type ParticipantAlias,
  type ParticipantKey,
  type ParticipantSeed,
} from "@/utils/text/participants/identity";
import { formatTimeWithOffset, formatUTCOffset, getCurrentTimeWithOffset } from "@/utils/text/timezoneHelper";
import {
  applyParticipantProfileEnrichers,
  type ParticipantProfileEnricherRegistry,
} from "@/utils/text/participants/profileEnrichers";
import type { ContributionExecutionDiagnostic } from "@/utils/contributions/registry";
import {
  userNamingRepository,
  userPersonaNamingPairKey,
  type UserPersonaNamingPair,
} from "@/utils/db/repositories/UserNamingRepository";
import type { UserPersonaNamingPreference } from "@/types/personaNaming";
import { resolveEffectiveUserNaming } from "@/utils/text/userNaming";
import { createParticipantAlias } from "@/utils/text/participants/aliases";

export interface ActivePersonaScope {
  personaId?: number;
  lineageId?: number;
  isMainPersona: boolean;
  isUserImpersonation: boolean;
  impersonatedUserId?: string;
}

export type ParticipantProfileFieldKind =
  | "status"
  | "physical_appearance"
  | "timezone"
  | "identity"
  | "presence"
  | "roles"
  | "personal_memories"
  | "human_reminders"
  | "persona_public_attributes"
  | `extension:${string}`;

export type ParticipantFieldVisibilityReason =
  | "visible"
  | "privacy"
  | "blacklist"
  | "personalization_disabled"
  | "impersonation"
  | "missing_data"
  | "optional_failure";

export interface ParticipantProfileField {
  owner: ParticipantKey;
  kind: ParticipantProfileFieldKind;
  order: number;
  visibility: {
    visible: boolean;
    reason: ParticipantFieldVisibilityReason;
  };
  lines: readonly string[];
}

export interface HydratedParticipantProfile {
  key: ParticipantKey;
  reasons: ParticipantSeed["reasons"];
  displayName: string;
  aliases: readonly ParticipantAlias[];
  primaryAlias: string | null;
  mentionable: boolean;
  isBot: boolean;
  resolvableTargetId?: string;
  fields: readonly ParticipantProfileField[];
}

export interface ParticipantExposurePolicy {
  canUseSavedNickname: boolean;
  exposeSavedNicknameAlias: boolean;
  exposePresence: boolean;
  exposeRoles: boolean;
  exposePhysicalAppearance: boolean;
  exposeTimezone: boolean;
  exposeIdentity: boolean;
  exposePersonalMemories: boolean;
}

export interface ParticipantHydrationResult {
  profiles: readonly HydratedParticipantProfile[];
  personaTaskLines: readonly string[];
  diagnostics: ParticipantHydrationDiagnostics;
}

interface ParticipantHydrationDiagnostics {
  durationMs: number;
  profileCount: number;
  externalCalls: {
    userRowLoads: number;
    registrations: number;
    blacklistReads: number;
    privacyReads: number;
    personalMemoryReads: number;
    reminderReads: number;
    memberReads: number;
    fallbackUserReads: number;
    presenceReads: number;
  };
  enricherContributions: readonly ContributionExecutionDiagnostic[];
}

export interface ParticipantHydrationDependencies {
  loadUserRow(discordId: string): Promise<UserRow | null>;
  registerUser(discordId: string, displayName: string, language: "en-US" | "ja"): Promise<UserRow | null>;
  isBlacklisted(guildId: string, discordId: string): Promise<boolean>;
  getPrivacyLevel(discordId: string): Promise<PrivacyLevel>;
  loadPersonalMemories(userId: number, lineageId: number): Promise<PersonalMemoryRow[]>;
  loadReminders(
    discordId: string,
    guildId: string,
    personaId?: number,
    includeUnassignedForMainPersona?: boolean,
  ): Promise<ReminderRow[]>;
  loadMember(client: Client, guildId: string, discordId: string): Promise<GuildMember | null>;
  loadFallbackUser(client: Client, discordId: string): Promise<User | null>;
  loadPresence(client: Client, discordId: string, guildId: string, preloadedMember?: GuildMember): Promise<string>;
  loadNamingPreferences(pairs: UserPersonaNamingPair[]): Promise<Map<string, UserPersonaNamingPreference>>;
}

export interface ParticipantHydrationParams {
  client: Client;
  guildId: string;
  channelName: string;
  botName: string;
  participantSeeds: readonly ParticipantSeed[];
  activePersonaScope: ActivePersonaScope;
  tomoriState: TomoriState | null;
  tomoriConfig: AssembledServerConfig;
  isDMChannel: boolean;
  impersonatedIdentityName: string | null;
  matrixUsers?: ReadonlyMap<string, string>;
  syntheticUsers?: ReadonlyMap<string, { displayName: string; type: "persona" | "webhook" }>;
  publicPersonaProfiles?: readonly PublicPersonaProfile[];
  preloadedReferencedUserRows?: ReadonlyMap<string, UserRow>;
  referencedUserIds?: ReadonlySet<string>;
  toolPromptMacroResolver: { expand(text: string): Promise<string> };
  conversationCorpus: string | null;
  snapshot?: RequestSnapshot;
  convertMentions: MentionConverter;
  profileEnricherRegistry?: ParticipantProfileEnricherRegistry;
}

const DEFAULT_HYDRATION_DEPENDENCIES: ParticipantHydrationDependencies = {
  loadUserRow: (discordId) => userRepository.loadByDiscordId(discordId),
  registerUser: (discordId, displayName, language) => userRepository.register(discordId, displayName, language),
  isBlacklisted: (guildId, discordId) => userRepository.isBlacklisted(guildId, discordId),
  getPrivacyLevel: (discordId) => userRepository.getPrivacyLevel(discordId),
  loadPersonalMemories: (userId, lineageId) => personalMemoryRepository.loadForUserLineage(userId, lineageId, true),
  loadReminders: async (discordId, guildId, personaId, includeUnassignedForMainPersona) =>
    (await serverScheduleRepository.getPendingRemindersForUser(
      discordId,
      guildId,
      personaId,
      includeUnassignedForMainPersona,
    )) ?? [],
  loadMember: async (client, guildId, discordId) => {
    const guild = client.guilds.cache.get(guildId);
    return guild ? await guild.members.fetch(discordId).catch(() => null) : null;
  },
  loadFallbackUser: (client, discordId) => client.users.fetch(discordId).catch(() => null),
  loadPresence: (client, discordId, guildId, preloadedMember) =>
    getUserPresenceDetails(client, discordId, guildId, preloadedMember),
  loadNamingPreferences: (pairs) => userNamingRepository.loadPreferences(pairs),
};

export function createParticipantExposurePolicy(params: {
  privacyLevel: PrivacyLevel;
  blacklisted: boolean;
  personalizationEnabled: boolean;
  hasServerNickname: boolean;
  isUserImpersonation: boolean;
  isImpersonatedUser: boolean;
}): ParticipantExposurePolicy {
  const canUseSavedNickname = params.personalizationEnabled && !params.blacklisted;
  return {
    canUseSavedNickname,
    exposeSavedNicknameAlias:
      params.personalizationEnabled && !params.blacklisted && (!params.hasServerNickname || canUseSavedNickname),
    exposePresence: params.privacyLevel === PrivacyLevel.MINIMAL,
    exposeRoles: params.privacyLevel === PrivacyLevel.MINIMAL,
    exposePhysicalAppearance: !params.isUserImpersonation,
    exposeTimezone: !params.isUserImpersonation,
    exposeIdentity:
      params.personalizationEnabled && !params.blacklisted && params.privacyLevel === PrivacyLevel.MINIMAL,
    exposePersonalMemories:
      (!params.isUserImpersonation || params.isImpersonatedUser) &&
      params.personalizationEnabled &&
      !params.blacklisted &&
      params.privacyLevel === PrivacyLevel.MINIMAL,
  };
}

export function canMentionParticipant(seed: ParticipantSeed): boolean {
  if (seed.key.kind !== "discord_user") return false;
  return seed.capabilities?.has("mentionable") ?? true;
}

export function formatPendingReminderForContext(
  reminder: Pick<ReminderRow, "reminder_id" | "reminder_purpose" | "reminder_time" | "repetition_interval_hours">,
  timezoneOffset: number,
): string {
  const formattedTime = `${formatTimeWithOffset(new Date(reminder.reminder_time), timezoneOffset, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })} (${formatUTCOffset(timezoneOffset)})`;
  const reminderIdPrefix = typeof reminder.reminder_id === "number" ? `ID:${reminder.reminder_id} ` : "";
  const repeatText =
    typeof reminder.repetition_interval_hours === "number" && reminder.repetition_interval_hours >= 1
      ? `, repeats every ${reminder.repetition_interval_hours} hour(s)`
      : "";

  return `${reminderIdPrefix}"${reminder.reminder_purpose}" (scheduled for ${formattedTime}${repeatText})`;
}

function field(
  owner: ParticipantKey,
  kind: ParticipantProfileFieldKind,
  order: number,
  lines: readonly string[],
  hiddenReason: ParticipantFieldVisibilityReason = "missing_data",
): ParticipantProfileField {
  return {
    owner,
    kind,
    order,
    visibility: lines.length > 0 ? { visible: true, reason: "visible" } : { visible: false, reason: hiddenReason },
    lines,
  };
}

function normalizeImageAppearanceTags(tags: string[] | null | undefined): string[] {
  return tags?.map((tag) => tag.trim()).filter((tag) => tag.length > 0) ?? [];
}

function findSyntheticDisplayName(
  seed: ParticipantSeed,
  syntheticUsers?: ReadonlyMap<string, { displayName: string; type: "persona" | "webhook" }>,
): string | null {
  if (seed.sourceDisplayName) return seed.sourceDisplayName;
  if (seed.key.kind === "persona") {
    return (
      syntheticUsers?.get(`persona:${seed.key.personaId}`)?.displayName ??
      syntheticUsers?.get(String(seed.key.personaId))?.displayName ??
      null
    );
  }
  if (seed.key.kind === "webhook") return syntheticUsers?.get(seed.key.webhookId)?.displayName ?? null;
  return null;
}

function hiddenReasonForPolicy(
  policy: ParticipantExposurePolicy,
  kind: ParticipantProfileFieldKind,
  params: { blacklisted: boolean; personalizationEnabled: boolean; isUserImpersonation: boolean },
): ParticipantFieldVisibilityReason {
  if ((kind === "physical_appearance" || kind === "timezone") && params.isUserImpersonation) return "impersonation";
  if (kind === "personal_memories") {
    if (params.isUserImpersonation && !policy.exposePersonalMemories) return "impersonation";
    if (params.blacklisted) return "blacklist";
    if (!params.personalizationEnabled) return "personalization_disabled";
    if (!policy.exposePersonalMemories) return "privacy";
    return "missing_data";
  }
  if (kind === "physical_appearance" && !policy.exposePhysicalAppearance) return "impersonation";
  if (kind === "timezone" && !policy.exposeTimezone) return "impersonation";
  return "missing_data";
}

interface HydratedDiscordUserBase {
  profile: Omit<HydratedParticipantProfile, "fields">;
  userRow: UserRow;
  member: GuildMember | null;
  policy: ParticipantExposurePolicy;
  blacklisted: boolean;
  personalizationEnabled: boolean;
  isTriggerer: boolean;
}

async function hydrateDiscordUserBase(
  seed: ParticipantSeed,
  params: ParticipantHydrationParams,
  dependencies: ParticipantHydrationDependencies,
): Promise<HydratedDiscordUserBase | null> {
  if (seed.key.kind !== "discord_user") return null;
  const discordId = seed.key.discordId;
  let userRow =
    params.preloadedReferencedUserRows?.get(discordId) ?? (await dependencies.loadUserRow(discordId).catch(() => null));
  const member = await dependencies.loadMember(params.client, params.guildId, discordId).catch(() => null);
  if (!userRow && !params.referencedUserIds?.has(discordId) && member) {
    const guild = params.client.guilds.cache.get(params.guildId);
    const language = guild?.preferredLocale.startsWith("ja") ? "ja" : "en-US";
    const registrationDisplayName = resolvePreferredDiscordDisplayName({
      memberDisplayName: member.displayName,
      user: member.user,
    });
    userRow = await dependencies.registerUser(discordId, registrationDisplayName, language).catch(() => null);
  }
  if (!userRow) {
    log.warn(`Skipping user ${discordId} - could not load user data`);
    return null;
  }

  const fallbackUser = member ? null : await dependencies.loadFallbackUser(params.client, discordId).catch(() => null);
  const personalizationEnabled = params.tomoriConfig.personal_memories_enabled ?? true;
  const isTriggerer = params.snapshot?.triggererUserRow?.user_disc_id === discordId;
  const blacklisted = isTriggerer
    ? (params.snapshot?.isTriggererBlacklisted ?? false)
    : await dependencies.isBlacklisted(params.guildId, discordId);
  const privacyLevel = isTriggerer
    ? (params.snapshot?.triggererPrivacyLevel ?? PrivacyLevel.MINIMAL)
    : await dependencies.getPrivacyLevel(discordId);
  const serverNickname = member?.nickname ?? null;
  const globalName = member?.user.globalName ?? fallbackUser?.globalName ?? null;
  const username = member?.user.username ?? fallbackUser?.username ?? null;
  const isImpersonatedUser =
    params.activePersonaScope.isUserImpersonation && discordId === params.activePersonaScope.impersonatedUserId;
  const policy = createParticipantExposurePolicy({
    privacyLevel,
    blacklisted,
    personalizationEnabled,
    hasServerNickname: Boolean(serverNickname),
    isUserImpersonation: params.activePersonaScope.isUserImpersonation,
    isImpersonatedUser,
  });
  const customNickname = userRow.user_nickname?.trim() || null;
  const plainNickname = customNickname ?? member?.displayName ?? globalName ?? username ?? discordId;
  let displayName = policy.canUseSavedNickname ? plainNickname : serverNickname ? serverNickname : `<@${discordId}>`;
  if (isImpersonatedUser && params.impersonatedIdentityName) displayName = params.impersonatedIdentityName;

  const identity: DiscordAliasIdentity = {
    displayName: member?.displayName,
    nickname: serverNickname,
    globalName,
    username,
  };
  const aliases = [
    ...seed.aliases,
    ...buildDiscordUserAliases({
      owner: seed.key,
      userRow,
      identity,
      exposeSavedNickname: policy.exposeSavedNicknameAlias,
      impersonatedIdentityName: isImpersonatedUser ? params.impersonatedIdentityName : null,
    }),
  ];
  const primaryAlias = serverNickname ?? globalName ?? username ?? discordId;
  return {
    profile: {
      key: seed.key,
      reasons: seed.reasons,
      displayName,
      aliases,
      primaryAlias,
      mentionable: canMentionParticipant(seed),
      isBot: false,
      resolvableTargetId: discordId,
    },
    userRow,
    member,
    policy,
    blacklisted,
    personalizationEnabled,
    isTriggerer,
  };
}

function applyPersonaRelativeNaming(
  base: HydratedDiscordUserBase,
  params: ParticipantHydrationParams,
  preference: UserPersonaNamingPreference | undefined,
): HydratedDiscordUserBase {
  if (params.activePersonaScope.isUserImpersonation && base.profile.key.kind === "discord_user") return base;
  const canUsePersonalizedNaming = base.personalizationEnabled && !base.blacklisted;
  const liveDisplayName =
    base.member?.displayName ?? base.member?.user.globalName ?? base.member?.user.username ?? base.userRow.user_disc_id;
  const naming = resolveEffectiveUserNaming({
    global: {
      userNickname: canUsePersonalizedNaming ? base.userRow.user_nickname : null,
      prefixOverride: canUsePersonalizedNaming ? (base.userRow.prefix_override ?? null) : null,
      suffixOverride: canUsePersonalizedNaming ? (base.userRow.suffix_override ?? null) : null,
      addressingStyle: canUsePersonalizedNaming ? (base.userRow.addressing_style ?? null) : null,
    },
    liveDisplayName,
    persona: canUsePersonalizedNaming ? params.tomoriState?.naming_config : undefined,
    preference: canUsePersonalizedNaming ? preference : null,
  });
  const aliasPurposes = ["input_reference", "output_mention", "tool_target", "copied_identity"] as const;
  const effectiveNicknameAlias = createParticipantAlias({
    owner: base.profile.key,
    value: naming.nickname,
    source: "effective_nickname",
    purposes: aliasPurposes,
    exposure: "visible",
    priority: 8,
  });
  const formattedNameAlias = createParticipantAlias({
    owner: base.profile.key,
    value: naming.formattedName,
    source: "formatted_name",
    purposes: aliasPurposes,
    exposure: "visible",
    priority: 9,
  });

  return {
    ...base,
    profile: {
      ...base.profile,
      displayName: naming.formattedName,
      aliases: [
        ...base.profile.aliases,
        ...(effectiveNicknameAlias ? [effectiveNicknameAlias] : []),
        ...(formattedNameAlias ? [formattedNameAlias] : []),
      ],
    },
  };
}

async function enrichPresenceField(
  base: HydratedDiscordUserBase,
  params: ParticipantHydrationParams,
  dependencies: ParticipantHydrationDependencies,
): Promise<ParticipantProfileField> {
  let lines: string[] = [];
  let failed = false;
  if (base.policy.exposePresence) {
    if (params.isDMChannel) {
      lines = ["- Status: Online (Direct Message)"];
    } else if (params.client.options.intents?.has(GatewayIntentBits.GuildPresences)) {
      try {
        const presence = await dependencies.loadPresence(
          params.client,
          base.userRow.user_disc_id,
          params.guildId,
          base.isTriggerer ? (params.snapshot?.preloadedMember ?? undefined) : undefined,
        );
        lines = [`- Status: ${presence}`];
      } catch {
        failed = true;
      }
    }
  }
  const hiddenReason = failed ? "optional_failure" : base.policy.exposePresence ? "missing_data" : "privacy";
  return field(base.profile.key, "presence", 30, lines, hiddenReason);
}

function enrichPhysicalAppearanceField(
  base: HydratedDiscordUserBase,
  params: ParticipantHydrationParams,
): ParticipantProfileField {
  const tags = base.policy.exposePhysicalAppearance
    ? normalizeImageAppearanceTags(base.userRow.physical_appearance_tags)
    : [];
  return field(
    base.profile.key,
    "physical_appearance",
    10,
    tags.length > 0 ? [`- ${base.profile.displayName}'s Physical Appearance: ${tags.join(", ")}`] : [],
    hiddenReasonForPolicy(base.policy, "physical_appearance", {
      blacklisted: base.blacklisted,
      personalizationEnabled: base.personalizationEnabled,
      isUserImpersonation: params.activePersonaScope.isUserImpersonation,
    }),
  );
}

function enrichTimezoneField(
  base: HydratedDiscordUserBase,
  params: ParticipantHydrationParams,
): ParticipantProfileField {
  const offset = base.userRow.timezone_offset;
  const lines =
    base.policy.exposeTimezone && offset != null
      ? [
          `- ${base.profile.displayName}'s timezone: ${formatUTCOffset(offset)} (their local time: ${getCurrentTimeWithOffset(offset)})`,
        ]
      : [];
  return field(
    base.profile.key,
    "timezone",
    20,
    lines,
    hiddenReasonForPolicy(base.policy, "timezone", {
      blacklisted: base.blacklisted,
      personalizationEnabled: base.personalizationEnabled,
      isUserImpersonation: params.activePersonaScope.isUserImpersonation,
    }),
  );
}

function enrichIdentityField(base: HydratedDiscordUserBase): ParticipantProfileField {
  const lines: string[] = [];
  if (base.policy.exposeIdentity) {
    const genderIdentity = base.userRow.gender_identity?.trim();
    const pronouns = base.userRow.pronouns?.trim();
    const orientation = base.userRow.orientation?.trim();
    if (genderIdentity) lines.push(`- Gender Identity: ${genderIdentity}`);
    if (pronouns) lines.push(`- Pronouns: ${pronouns}`);
    if (orientation) lines.push(`- Orientation: ${orientation}`);
  }
  return field(base.profile.key, "identity", 15, lines, base.policy.exposeIdentity ? "missing_data" : "privacy");
}

function enrichRolesField(base: HydratedDiscordUserBase, params: ParticipantHydrationParams): ParticipantProfileField {
  const guild = params.client.guilds.cache.get(params.guildId);
  const lines = base.policy.exposeRoles && base.member ? buildRoleLines(base.member, guild) : [];
  return field(base.profile.key, "roles", 40, lines, base.policy.exposeRoles ? "missing_data" : "privacy");
}

async function enrichPersonalMemoriesField(
  base: HydratedDiscordUserBase,
  params: ParticipantHydrationParams,
  dependencies: ParticipantHydrationDependencies,
): Promise<ParticipantProfileField> {
  const lines = base.policy.exposePersonalMemories
    ? await hydratePersonalMemoryLines(base.userRow, base.profile.displayName, params, dependencies)
    : [];
  return field(
    base.profile.key,
    "personal_memories",
    50,
    lines,
    hiddenReasonForPolicy(base.policy, "personal_memories", {
      blacklisted: base.blacklisted,
      personalizationEnabled: base.personalizationEnabled,
      isUserImpersonation: params.activePersonaScope.isUserImpersonation,
    }),
  );
}

async function enrichHumanRemindersField(
  base: HydratedDiscordUserBase,
  params: ParticipantHydrationParams,
  dependencies: ParticipantHydrationDependencies,
): Promise<ParticipantProfileField> {
  const reminders = await dependencies.loadReminders(
    base.userRow.user_disc_id,
    params.guildId,
    params.activePersonaScope.personaId,
    params.activePersonaScope.isMainPersona,
  );
  const lines =
    reminders.length > 0
      ? [
          "- Reminders:",
          ...reminders.map(
            (reminder) => `  - ${formatPendingReminderForContext(reminder, params.tomoriConfig.timezone_offset ?? 0)}`,
          ),
        ]
      : [];
  return field(base.profile.key, "human_reminders", 60, lines);
}

async function hydrateDiscordUser(
  base: HydratedDiscordUserBase,
  params: ParticipantHydrationParams,
  dependencies: ParticipantHydrationDependencies,
): Promise<HydratedParticipantProfile> {
  const fields: ParticipantProfileField[] = [
    enrichPhysicalAppearanceField(base, params),
    enrichIdentityField(base),
    enrichTimezoneField(base, params),
    await enrichPresenceField(base, params, dependencies),
    enrichRolesField(base, params),
    await enrichPersonalMemoriesField(base, params, dependencies),
    await enrichHumanRemindersField(base, params, dependencies),
  ];
  return { ...base.profile, fields };
}

function buildRoleLines(member: GuildMember, guild: Guild | undefined): string[] {
  const roles = member.roles.cache
    .filter((role) => role.id !== guild?.id && role.name !== "@everyone")
    .sort((left, right) => right.position - left.position)
    .map((role) => role.name);
  return roles.length > 0 ? [`- Server Roles: ${roles.join(", ")}`] : [];
}

async function hydratePersonalMemoryLines(
  userRow: UserRow,
  displayName: string,
  params: ParticipantHydrationParams,
  dependencies: ParticipantHydrationDependencies,
): Promise<string[]> {
  if (!userRow.user_id) return [];
  const memories = await dependencies.loadPersonalMemories(
    userRow.user_id,
    params.activePersonaScope.lineageId ?? params.snapshot?.tomoriState?.persona_lineage_id ?? 0,
  );
  const filteredMemories = memories.filter((memory) => memoryMatchesContext(memory, params));
  if (filteredMemories.length === 0) return [];
  const processedMemories = await Promise.all(
    filteredMemories.map(async (memory, index) => {
      const processed = await params.convertMentions(
        memory.content,
        params.client,
        params.guildId,
        displayName,
        params.botName,
        params.tomoriConfig.personal_memories_enabled,
      );
      return formatMemoryWithId(memory.personal_memory_id ?? index + 1, processed, memory.tags ?? []);
    }),
  );
  return [`- Memories: ${processedMemories.join("; ")}`];
}

function memoryMatchesContext(memory: PersonalMemoryRow, params: ParticipantHydrationParams): boolean {
  const normalizedTags = (memory.tags ?? []).map((tag) => tag.replace(/^["']+|["']+$/g, ""));
  const channelTags = normalizedTags.filter((tag) => tag.startsWith("#"));
  const contentTags = normalizedTags.filter((tag) => !tag.startsWith("#"));
  if (params.tomoriConfig.channel_memory_enabled && channelTags.length > 0) {
    const channelAllowed = channelTags.some((tag) => tag.slice(1).toLowerCase() === params.channelName.toLowerCase());
    if (!channelAllowed) return false;
  }
  if (params.conversationCorpus != null && contentTags.length > 0) {
    return contentTags.some((tag) => params.conversationCorpus?.includes(tag.toLowerCase()));
  }
  return true;
}

function hydrateBot(seed: ParticipantSeed, params: ParticipantHydrationParams): HydratedParticipantProfile {
  const appearanceTags = params.activePersonaScope.isUserImpersonation
    ? []
    : normalizeImageAppearanceTags(params.tomoriState?.physical_appearance_tags);
  return {
    key: seed.key,
    reasons: seed.reasons,
    displayName: params.botName,
    aliases: [],
    primaryAlias: null,
    mentionable: false,
    isBot: true,
    fields: [
      field(
        seed.key,
        "physical_appearance",
        10,
        appearanceTags.length > 0 ? [`- ${params.botName}'s Physical Appearance: ${appearanceTags.join(", ")}`] : [],
      ),
      field(seed.key, "status", 30, ["- Status: Online - Currently active and responding to messages"]),
    ],
  };
}

function hydrateSyntheticBase(
  seed: ParticipantSeed,
  params: ParticipantHydrationParams,
): HydratedParticipantProfile | null {
  if (seed.key.kind === "matrix_user") {
    const displayName = params.matrixUsers?.get(seed.key.matrixId) ?? seed.sourceDisplayName;
    if (!displayName) return null;
    return {
      key: seed.key,
      reasons: seed.reasons,
      displayName,
      aliases: seed.aliases.length > 0 ? seed.aliases : buildBridgeUserAliases({ owner: seed.key, displayName }),
      primaryAlias: displayName,
      mentionable: false,
      isBot: false,
      resolvableTargetId: seed.key.matrixId,
      fields: [field(seed.key, "status", 30, ["- Status: Online or status unknown"])],
    };
  }
  if (seed.key.kind !== "persona" && seed.key.kind !== "webhook") return null;
  if (seed.key.kind === "persona" && !seed.reasons.has("historical_persona")) return null;
  const displayName = findSyntheticDisplayName(seed, params.syntheticUsers);
  if (!displayName) return null;
  return {
    key: seed.key,
    reasons: seed.reasons,
    displayName,
    aliases: seed.aliases,
    primaryAlias: null,
    mentionable: false,
    isBot: false,
    fields: [],
  };
}

async function applyPublicPersonaProfiles(
  profiles: HydratedParticipantProfile[],
  params: ParticipantHydrationParams,
): Promise<void> {
  for (const publicPersona of params.publicPersonaProfiles ?? []) {
    const key = createPersonaKey(publicPersona.personaId);
    const convertedAttributes: string[] = [];
    for (const attribute of publicPersona.attributes) {
      const trimmed = attribute.trim();
      if (!trimmed) continue;
      convertedAttributes.push(
        await params.convertMentions(
          await params.toolPromptMacroResolver.expand(trimmed),
          params.client,
          params.guildId,
          "User",
          publicPersona.personaName,
          params.tomoriConfig.personal_memories_enabled,
          params.snapshot,
        ),
      );
    }
    const appearanceTags = params.activePersonaScope.isUserImpersonation
      ? []
      : normalizeImageAppearanceTags(publicPersona.imageAppearanceTags);
    if (convertedAttributes.length === 0 && appearanceTags.length === 0) continue;

    const target = profiles.find((profile) => serializeParticipantKey(profile.key) === serializeParticipantKey(key));
    const attributeLines =
      convertedAttributes.length > 0
        ? [
            `- Known Information about ${publicPersona.personaName}:`,
            ...convertedAttributes.map((attribute) => `  - ${attribute}`),
          ]
        : [];
    const appearanceLines =
      appearanceTags.length > 0
        ? [`- ${target?.displayName ?? publicPersona.personaName}'s Physical Appearance: ${appearanceTags.join(", ")}`]
        : [];
    if (target) {
      const fields = target.fields.filter(
        (candidate) => candidate.kind !== "physical_appearance" && candidate.kind !== "persona_public_attributes",
      );
      target.fields = [
        ...fields,
        field(target.key, "physical_appearance", 10, appearanceLines),
        field(target.key, "persona_public_attributes", 70, attributeLines),
      ];
      continue;
    }

    profiles.push({
      key,
      reasons: new Set(["persona_trigger_reference"]),
      displayName: publicPersona.personaName,
      aliases: buildPersonaAliases({ owner: key, nickname: publicPersona.personaName }).aliases,
      primaryAlias: publicPersona.personaName,
      mentionable: false,
      isBot: false,
      resolvableTargetId: `persona:${publicPersona.personaId}`,
      fields: [
        field(key, "physical_appearance", 10, appearanceLines),
        field(key, "status", 30, ["- Status: Online or status unknown"]),
        field(key, "persona_public_attributes", 70, attributeLines),
      ],
    });
  }
}

async function hydratePersonaTaskLines(
  params: ParticipantHydrationParams,
  dependencies: ParticipantHydrationDependencies,
): Promise<string[]> {
  const botUserId = params.client.user?.id;
  if (
    params.activePersonaScope.isUserImpersonation ||
    !botUserId ||
    typeof params.activePersonaScope.personaId !== "number"
  ) {
    return [];
  }
  const tasks = await dependencies.loadReminders(botUserId, params.guildId, params.activePersonaScope.personaId);
  const personaTasks = tasks.filter((reminder) => reminder.self_reminder === true);
  if (personaTasks.length === 0) return [];
  const timezoneOffset = params.tomoriConfig.timezone_offset ?? 0;
  return [
    "Pending Tasks Assigned to You:",
    ...personaTasks.map((task) => {
      const destination = task.channel_disc_id ? ` (destination: <#${task.channel_disc_id}>)` : "";
      return `- ${formatPendingReminderForContext(task, timezoneOffset)}${destination}`;
    }),
  ];
}

export async function hydrateParticipantProfiles(
  params: ParticipantHydrationParams,
  dependencyOverrides: Partial<ParticipantHydrationDependencies> = {},
): Promise<ParticipantHydrationResult> {
  const startedAt = performance.now();
  const baseDependencies = { ...DEFAULT_HYDRATION_DEPENDENCIES, ...dependencyOverrides };
  const externalCalls: ParticipantHydrationDiagnostics["externalCalls"] = {
    userRowLoads: 0,
    registrations: 0,
    blacklistReads: 0,
    privacyReads: 0,
    personalMemoryReads: 0,
    reminderReads: 0,
    memberReads: 0,
    fallbackUserReads: 0,
    presenceReads: 0,
  };
  const dependencies: ParticipantHydrationDependencies = {
    loadUserRow: async (discordId) => {
      externalCalls.userRowLoads += 1;
      return baseDependencies.loadUserRow(discordId);
    },
    registerUser: async (discordId, displayName, language) => {
      externalCalls.registrations += 1;
      return baseDependencies.registerUser(discordId, displayName, language);
    },
    isBlacklisted: async (guildId, discordId) => {
      externalCalls.blacklistReads += 1;
      return baseDependencies.isBlacklisted(guildId, discordId);
    },
    getPrivacyLevel: async (discordId) => {
      externalCalls.privacyReads += 1;
      return baseDependencies.getPrivacyLevel(discordId);
    },
    loadPersonalMemories: async (userId, lineageId) => {
      externalCalls.personalMemoryReads += 1;
      return baseDependencies.loadPersonalMemories(userId, lineageId);
    },
    loadReminders: async (discordId, guildId, personaId, includeUnassignedForMainPersona) => {
      externalCalls.reminderReads += 1;
      return baseDependencies.loadReminders(discordId, guildId, personaId, includeUnassignedForMainPersona);
    },
    loadMember: async (client, guildId, discordId) => {
      externalCalls.memberReads += 1;
      return baseDependencies.loadMember(client, guildId, discordId);
    },
    loadFallbackUser: async (client, discordId) => {
      externalCalls.fallbackUserReads += 1;
      return baseDependencies.loadFallbackUser(client, discordId);
    },
    loadPresence: async (client, discordId, guildId, preloadedMember) => {
      externalCalls.presenceReads += 1;
      return baseDependencies.loadPresence(client, discordId, guildId, preloadedMember);
    },
    loadNamingPreferences: (pairs) => baseDependencies.loadNamingPreferences(pairs),
  };
  const discordBases = new Map<string, HydratedDiscordUserBase>();
  for (const seed of params.participantSeeds) {
    if (seed.key.kind !== "discord_user") continue;
    const base = await hydrateDiscordUserBase(seed, params, dependencies);
    if (base) discordBases.set(serializeParticipantKey(seed.key), base);
  }
  const personaLineageId = params.activePersonaScope.lineageId ?? params.snapshot?.tomoriState?.persona_lineage_id ?? 0;
  const namingPreferences = await dependencies.loadNamingPreferences(
    [...discordBases.values()].flatMap((base) =>
      base.userRow.user_id ? [{ userId: base.userRow.user_id, personaLineageId }] : [],
    ),
  );
  const profiles: HydratedParticipantProfile[] = [];
  let botAdded = false;
  for (const seed of params.participantSeeds) {
    if (seed.key.kind === "bot" || (seed.key.kind === "persona" && seed.reasons.has("active_identity"))) {
      if (!botAdded) {
        profiles.push(hydrateBot(seed, params));
        botAdded = true;
      }
      continue;
    }
    if (seed.key.kind === "discord_user") {
      const base = discordBases.get(serializeParticipantKey(seed.key));
      if (!base) continue;
      const preference = base.userRow.user_id
        ? namingPreferences.get(userPersonaNamingPairKey(base.userRow.user_id, personaLineageId))
        : undefined;
      profiles.push(
        await hydrateDiscordUser(applyPersonaRelativeNaming(base, params, preference), params, dependencies),
      );
      continue;
    }
    const syntheticProfile = hydrateSyntheticBase(seed, params);
    if (syntheticProfile) profiles.push(syntheticProfile);
  }
  await applyPublicPersonaProfiles(profiles, params);
  const enriched = await applyParticipantProfileEnrichers({
    profiles,
    activePersonaScope: params.activePersonaScope,
    registry: params.profileEnricherRegistry,
  });
  return {
    profiles: enriched.profiles,
    personaTaskLines: await hydratePersonaTaskLines(params, dependencies),
    diagnostics: {
      durationMs: performance.now() - startedAt,
      profileCount: enriched.profiles.length,
      externalCalls,
      enricherContributions: enriched.diagnostics,
    },
  };
}
