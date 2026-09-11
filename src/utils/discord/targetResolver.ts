import { ChannelType, type Guild, type GuildMember, type GuildTextBasedChannel } from "discord.js";
import { ContextItemTag, type ConversationUserReference, type StructuredContextItem } from "@/types/misc/context";
import type { AddressingStyle, PersonaNamingConfig } from "@/types/personaNaming";
import type { ToolContext } from "@/types/tool/interfaces";
import { userNamingRepository, userRepository } from "@/utils/db/repositories";
import { resolveEffectiveUserNaming } from "@/utils/text/userNaming";
import { isBridgeUserId } from "@/utils/bridges";
import { normalizeParticipantAlias } from "@/utils/text/participants/aliases";
import {
  collectParticipantTargetIndex,
  projectConversationUserReferences,
} from "@/utils/text/participants/targetIndex";

type ResolvedUserTarget = {
  status: "resolved";
  targetId: string;
  displayLabel: string;
  isBridgeUser: boolean;
  source:
    | "legacy_id"
    | "conversation"
    | "guild_display_name"
    | "persona_nickname"
    | "db_nickname"
    | "composed_name"
    | "global_name"
    | "username";
};

type AmbiguousUserTarget = {
  status: "ambiguous";
  input: string;
  candidates: Array<{
    label: string;
    targetId: string;
    isBridgeUser: boolean;
  }>;
};

type NotFoundUserTarget = {
  status: "not_found";
  input: string;
};

export type UserTargetResolution = ResolvedUserTarget | AmbiguousUserTarget | NotFoundUserTarget;

type ResolvedChannelTarget = {
  status: "resolved";
  channel: GuildTextBasedChannel;
  displayLabel: string;
  source:
    | "legacy_id"
    | "channel_name"
    | "thread_name"
    | "qualified_thread_name"
    | "forum_parent_name"
    | "normalized_name";
};

type AmbiguousChannelTarget = {
  status: "ambiguous";
  input: string;
  candidates: Array<{
    label: string;
    channelName: string;
    channelId: string;
  }>;
  /** Total matches found before capping candidates at 3 */
  totalCount: number;
};

type NotFoundChannelTarget = {
  status: "not_found";
  input: string;
};

export type ChannelTargetResolution = ResolvedChannelTarget | AmbiguousChannelTarget | NotFoundChannelTarget;

type GuildSearchStage = "guild_display_name" | "global_name" | "username";
const CHANNEL_ID_SUFFIX_PATTERN = /\s*\(ID:\s*(\d{17,20})\)\s*$/iu;

function normalizeChannelLookupValue(value: string): string {
  let normalized = value.trim();
  if (normalized.startsWith("#")) {
    normalized = normalized.slice(1).trim();
  }
  return normalized.replace(/\s+/g, " ").trim().toLowerCase();
}

export function normalizeUserTargetInput(value: string): string {
  return normalizeParticipantAlias(value);
}

function unwrapInlineCodeDelimiters(value: string): string {
  let normalized = value.trim();

  while (normalized.length >= 2 && normalized.startsWith("`") && normalized.endsWith("`")) {
    normalized = normalized.slice(1, -1).trim();
  }

  return normalized;
}

function stripEmoji(text: string): string {
  return text
    .replace(/[\p{Emoji}]/gu, "") // Unicode emoji
    .replace(/\uFE0E|\uFE0F|\u200D|\u200C/g, "") // Variation selectors and zero-width joiners
    .trim();
}

function normalizeChannelTargetInput(value: string): string {
  return normalizeChannelLookupValue(stripEmoji(unwrapInlineCodeDelimiters(value)));
}

function extractExplicitChannelId(value: string): {
  explicitId?: string;
  strippedInput: string;
} {
  const trimmedValue = unwrapInlineCodeDelimiters(value);
  const idSuffixMatch = trimmedValue.match(CHANNEL_ID_SUFFIX_PATTERN);

  if (!idSuffixMatch) {
    return {
      strippedInput: trimmedValue,
    };
  }

  return {
    explicitId: idSuffixMatch[1],
    strippedInput: trimmedValue.replace(CHANNEL_ID_SUFFIX_PATTERN, "").trim(),
  };
}

function isDiscordSnowflake(value: string): boolean {
  return /^\d{17,20}$/.test(value.trim());
}

function isGuildTextTarget(channel: unknown): channel is GuildTextBasedChannel {
  if (!channel || typeof channel !== "object") {
    return false;
  }

  if (!("isTextBased" in channel) || !("isDMBased" in channel)) {
    return false;
  }

  return (
    typeof (channel as { isTextBased?: unknown }).isTextBased === "function" &&
    (channel as { isTextBased: () => boolean }).isTextBased() &&
    !(channel as { isDMBased: () => boolean }).isDMBased()
  );
}

function isThreadLike(channel: { isThread?: () => boolean }): boolean {
  return typeof channel.isThread === "function" && channel.isThread();
}

function isForumOrMediaParent(channel: { type?: ChannelType } | null | undefined): boolean {
  return channel?.type === ChannelType.GuildForum || channel?.type === ChannelType.GuildMedia;
}

function formatDiscordUserLabel(member: GuildMember): string {
  const displayName = member.displayName?.trim() || member.user.globalName?.trim() || member.user.username.trim();
  const username = member.user.username.trim();
  return displayName.toLowerCase() === username.toLowerCase() ? displayName : `${displayName} (@${username})`;
}

function formatBridgeUserLabel(reference: ConversationUserReference): string {
  return reference.displayLabel.includes("(Matrix)") ? reference.displayLabel : `${reference.displayLabel} (Matrix)`;
}

function dedupeUserCandidates(
  candidates: Array<{
    label: string;
    targetId: string;
    isBridgeUser: boolean;
  }>,
): Array<{
  label: string;
  targetId: string;
  isBridgeUser: boolean;
}> {
  const seen = new Set<string>();
  const deduped: Array<{
    label: string;
    targetId: string;
    isBridgeUser: boolean;
  }> = [];

  for (const candidate of candidates) {
    if (seen.has(candidate.targetId)) {
      continue;
    }
    seen.add(candidate.targetId);
    deduped.push(candidate);
  }

  return deduped;
}

function dedupeChannelCandidates(
  candidates: Array<{
    label: string;
    channelName: string;
    channel: GuildTextBasedChannel;
  }>,
): Array<{
  label: string;
  channelName: string;
  channel: GuildTextBasedChannel;
}> {
  const seen = new Set<string>();
  const deduped: Array<{
    label: string;
    channelName: string;
    channel: GuildTextBasedChannel;
  }> = [];

  for (const candidate of candidates) {
    if (seen.has(candidate.channel.id)) {
      continue;
    }
    seen.add(candidate.channel.id);
    deduped.push(candidate);
  }

  return deduped;
}

/**
 * Scan conversation context items for inline-code channel references that include a Discord ID.
 * Matches patterns like: the channel named `name (ID: 12345)` or `name (ID: 12345)`
 * Returns all IDs whose normalized channel name matches the given input.
 */
function extractContextChannelIds(normalizedInput: string, contextItems: StructuredContextItem[]): string[] {
  const pattern = /`([^`]+?)\s*\(ID:\s*(\d{17,20})\)`/g;
  const ids = new Set<string>();

  for (const item of contextItems) {
    for (const part of item.parts) {
      if (part.type !== "text") continue;
      pattern.lastIndex = 0;
      for (let match = pattern.exec(part.text); match !== null; match = pattern.exec(part.text)) {
        if (normalizeChannelTargetInput(match[1]) === normalizedInput) {
          ids.add(match[2]);
        }
      }
    }
  }

  return [...ids];
}

function getConversationUserReferences(contextItems?: StructuredContextItem[]): ConversationUserReference[] {
  if (!contextItems) {
    return [];
  }

  const targetIndex = collectParticipantTargetIndex(contextItems);
  if (targetIndex.targets.length > 0) return projectConversationUserReferences(targetIndex);

  const collected: ConversationUserReference[] = [];
  for (const item of contextItems) {
    if (item.metadataTag !== ContextItemTag.KNOWLEDGE_USERS_IN_CONVERSATION || !item.conversationUsers?.length) {
      continue;
    }
    collected.push(...item.conversationUsers);
  }

  return collected;
}

async function getContextGuild(context: ToolContext): Promise<Guild | null> {
  if (!context.guildId) {
    return null;
  }

  return (
    context.client.guilds.cache.get(context.guildId) ??
    (await context.client.guilds.fetch(context.guildId).catch(() => null))
  );
}

async function searchGuildMembers(guild: Guild, query: string): Promise<GuildMember[]> {
  if (!query.trim()) {
    return [];
  }

  const results = await guild.members
    .search({
      query,
      limit: 100,
    })
    .catch(() => null);

  return results ? Array.from(results.values()).filter((member) => !member.user.bot) : [];
}

function filterExactGuildMatches(
  members: GuildMember[],
  normalizedInput: string,
  stage: GuildSearchStage,
): GuildMember[] {
  return members.filter((member) => {
    const candidateValue =
      stage === "guild_display_name"
        ? member.displayName
        : stage === "global_name"
          ? member.user.globalName
          : member.user.username;

    return candidateValue ? normalizeUserTargetInput(candidateValue) === normalizedInput : false;
  });
}

function resolveConversationUserMatch(
  references: ConversationUserReference[],
  normalizedInput: string,
): UserTargetResolution | null {
  const matches = references.filter((reference) =>
    reference.aliases.some((alias) => normalizeUserTargetInput(alias) === normalizedInput),
  );

  if (matches.length === 0) {
    return null;
  }

  // Identify targets the input matched on their PRIMARY/display name (e.g. the
  //    rendered "Misuzu"/"Obonya" label) rather than only on a secondary alias
  //    (server nickname, global name, username). The conversation stage flattens
  //    all alias types into one set, so without this distinction a user's
  //    secondary alias can collide with another user's actual name and force a
  //    needless clarify round-trip.
  const primaryNameTargetIds = new Set(
    matches
      .filter((match) => normalizeUserTargetInput(match.displayLabel) === normalizedInput)
      .map((match) => match.targetId),
  );

  const dedupedMatches = dedupeUserCandidates(
    matches.map((match) => ({
      label: isBridgeUserId(match.targetId) ? formatBridgeUserLabel(match) : match.displayLabel,
      targetId: match.targetId,
      isBridgeUser: isBridgeUserId(match.targetId),
    })),
  );

  // Precedence tie-break: when exactly one candidate matched on its primary
  //    name, prefer it over candidates that only matched a secondary alias.
  //    Otherwise (zero or several primary matches) fall back to the full set so a
  //    genuine same-name collision still surfaces as ambiguous.
  const primaryNameMatches = dedupedMatches.filter((candidate) => primaryNameTargetIds.has(candidate.targetId));
  const effectiveMatches = primaryNameMatches.length === 1 ? primaryNameMatches : dedupedMatches;

  if (effectiveMatches.length === 1) {
    const match = effectiveMatches[0];
    return {
      status: "resolved",
      targetId: match.targetId,
      displayLabel: match.label,
      isBridgeUser: match.isBridgeUser,
      source: "conversation",
    };
  }

  return {
    status: "ambiguous",
    input: normalizedInput,
    candidates: effectiveMatches.slice(0, 3),
  };
}

function resolveGuildMemberStage(
  normalizedInput: string,
  matches: GuildMember[],
  stage: GuildSearchStage,
): UserTargetResolution | null {
  const exactMatches = filterExactGuildMatches(matches, normalizedInput, stage);
  if (exactMatches.length === 0) {
    return null;
  }

  const dedupedMatches = dedupeUserCandidates(
    exactMatches.map((member) => ({
      label: formatDiscordUserLabel(member),
      targetId: member.id,
      isBridgeUser: false,
    })),
  );

  if (dedupedMatches.length === 1) {
    const match = dedupedMatches[0];
    return {
      status: "resolved",
      targetId: match.targetId,
      displayLabel: match.label,
      isBridgeUser: false,
      source: stage,
    };
  }

  return {
    status: "ambiguous",
    input: normalizedInput,
    candidates: dedupedMatches.slice(0, 3),
  };
}

async function resolveMembersById(
  guild: Guild,
  discordIds: readonly string[],
  rawInput: string,
  source: "persona_nickname" | "db_nickname" | "composed_name",
): Promise<UserTargetResolution | null> {
  if (discordIds.length === 0) {
    return null;
  }

  const members = (
    await Promise.all(discordIds.map(async (discordId) => guild.members.fetch(discordId).catch(() => null)))
  ).filter((member): member is GuildMember => member !== null && !member.user.bot);

  const dedupedMatches = dedupeUserCandidates(
    members.map((member) => ({
      label: formatDiscordUserLabel(member),
      targetId: member.id,
      isBridgeUser: false,
    })),
  );

  if (dedupedMatches.length === 0) {
    return null;
  }

  if (dedupedMatches.length === 1) {
    const match = dedupedMatches[0];
    return {
      status: "resolved",
      targetId: match.targetId,
      displayLabel: match.label,
      isBridgeUser: false,
      source,
    };
  }

  return {
    status: "ambiguous",
    input: rawInput,
    candidates: dedupedMatches.slice(0, 3),
  };
}

function affixVariants(values: Partial<Record<AddressingStyle, string>>): string[] {
  const unique = new Set<string>();
  for (const value of Object.values(values)) {
    const trimmed = value?.trim();
    if (trimmed) unique.add(trimmed);
  }
  // Longest first, so a two-word affix is not half-consumed by a shorter variant
  // that shares its opening word.
  return [...unique].sort((left, right) => right.length - left.length);
}

/**
 * Peels one persona-configured prefix and suffix off a requested name. Every
 * addressing variant is tried because the target's own style is known only once the
 * account resolves, which is what this strip exists to make possible.
 */
function stripNamingAffixes(rawInput: string, namingConfig: PersonaNamingConfig | undefined): string | null {
  if (!namingConfig) {
    return null;
  }

  const trimmedInput = rawInput.trim();
  let stripped = trimmedInput;

  for (const prefix of affixVariants(namingConfig.prefixes)) {
    if (stripped.length > prefix.length && stripped.toLowerCase().startsWith(prefix.toLowerCase())) {
      stripped = stripped.slice(prefix.length).trim();
      break;
    }
  }

  for (const suffix of affixVariants(namingConfig.suffixes)) {
    if (stripped.length > suffix.length && stripped.toLowerCase().endsWith(suffix.toLowerCase())) {
      stripped = stripped.slice(0, stripped.length - suffix.length).trim();
      break;
    }
  }

  return stripped && stripped !== trimmedInput ? stripped : null;
}

async function resolveComposedNameStage(
  guild: Guild,
  rawInput: string,
  normalizedInput: string,
  personaLineageId: number,
  namingConfig: PersonaNamingConfig | undefined,
): Promise<UserTargetResolution | null> {
  const candidates = await userNamingRepository.findComposedNameCandidates(normalizedInput, personaLineageId);
  const matchedDiscordIds = candidates
    .filter((candidate) => {
      const naming = resolveEffectiveUserNaming({
        global: {
          userNickname: candidate.globalNickname,
          prefixOverride: candidate.globalPrefixOverride,
          suffixOverride: candidate.globalSuffixOverride,
          addressingStyle: candidate.addressingStyle,
        },
        // The repository returns only rows carrying a stored nickname, so the live
        // display name is never the layer that wins here.
        liveDisplayName: "",
        persona: namingConfig,
        preference: {
          nickname_override: candidate.personaNicknameOverride,
          prefix_override: candidate.personaPrefixOverride,
          suffix_override: candidate.personaSuffixOverride,
        },
      });
      return normalizeUserTargetInput(naming.formattedName) === normalizedInput;
    })
    .map((candidate) => candidate.userDiscId);

  return resolveMembersById(guild, matchedDiscordIds, rawInput, "composed_name");
}

async function resolveByNameLadder(
  guild: Guild,
  rawInput: string,
  normalizedInput: string,
  personaLineageId: number | undefined,
): Promise<UserTargetResolution | null> {
  const guildSearchMatches = await searchGuildMembers(guild, rawInput);

  const guildDisplayMatch = resolveGuildMemberStage(normalizedInput, guildSearchMatches, "guild_display_name");
  if (guildDisplayMatch) {
    return guildDisplayMatch;
  }

  // Persona names outrank the global nickname: both are user-authored, but only the
  // persona one was rendered to the model in this conversation.
  if (personaLineageId !== undefined) {
    const personaRows = await userNamingRepository.findByPersonaNickname(normalizedInput, personaLineageId);
    const personaMatch = await resolveMembersById(
      guild,
      personaRows.map((row) => row.userDiscId),
      rawInput,
      "persona_nickname",
    );
    if (personaMatch) {
      return personaMatch;
    }
  }

  const dbNicknameRows = await userRepository.findByNormalizedNickname(normalizedInput);
  const dbNicknameMatch = await resolveMembersById(
    guild,
    dbNicknameRows.map((row) => row.user_disc_id),
    rawInput,
    "db_nickname",
  );
  if (dbNicknameMatch) {
    return dbNicknameMatch;
  }

  const globalNameMatch = resolveGuildMemberStage(normalizedInput, guildSearchMatches, "global_name");
  if (globalNameMatch) {
    return globalNameMatch;
  }

  return resolveGuildMemberStage(normalizedInput, guildSearchMatches, "username");
}

export async function resolveUserTarget(input: string, context: ToolContext): Promise<UserTargetResolution> {
  const rawInput = input.trim();
  const normalizedInput = normalizeUserTargetInput(input);
  if (!normalizedInput) {
    return {
      status: "not_found",
      input: rawInput,
    };
  }

  const conversationReferences = getConversationUserReferences(context.contextItems);

  if (isBridgeUserId(rawInput)) {
    const bridgeReference = conversationReferences.find((reference) => reference.targetId === rawInput);
    if (bridgeReference) {
      return {
        status: "resolved",
        targetId: bridgeReference.targetId,
        displayLabel: formatBridgeUserLabel(bridgeReference),
        isBridgeUser: true,
        source: "legacy_id",
      };
    }
  }

  if (isDiscordSnowflake(rawInput)) {
    const guild = await getContextGuild(context);
    if (guild) {
      const member = await guild.members.fetch(rawInput).catch(() => null);
      if (member && !member.user.bot) {
        return {
          status: "resolved",
          targetId: member.id,
          displayLabel: formatDiscordUserLabel(member),
          isBridgeUser: false,
          source: "legacy_id",
        };
      }
    }

    const selfConversationMatch = conversationReferences.find((reference) => reference.targetId === rawInput);
    if (selfConversationMatch) {
      return {
        status: "resolved",
        targetId: selfConversationMatch.targetId,
        displayLabel: selfConversationMatch.displayLabel,
        isBridgeUser: isBridgeUserId(selfConversationMatch.targetId),
        source: "legacy_id",
      };
    }

    return {
      status: "not_found",
      input: rawInput,
    };
  }

  const conversationMatch = resolveConversationUserMatch(conversationReferences, normalizedInput);
  if (conversationMatch) {
    return conversationMatch;
  }

  const guild = await getContextGuild(context);
  if (!guild) {
    return {
      status: "not_found",
      input: rawInput,
    };
  }

  const personaLineageId = context.tomoriState?.persona_lineage_id;
  const namingConfig = context.tomoriState?.naming_config;

  const ladderMatch = await resolveByNameLadder(guild, rawInput, normalizedInput, personaLineageId);
  if (ladderMatch) {
    return ladderMatch;
  }

  // A composed label only exists as an alias while its owner sits in the participant
  // context. Outside it every stage above compares against bare names, so the affix
  // has to come off before the ladder can match anything.
  const strippedInput = stripNamingAffixes(rawInput, namingConfig);
  if (strippedInput) {
    const strippedMatch = await resolveByNameLadder(
      guild,
      strippedInput,
      normalizeUserTargetInput(strippedInput),
      personaLineageId,
    );
    if (strippedMatch) {
      return strippedMatch;
    }
  }

  // Affixes a user set for themselves are invisible to the strip above, which only
  // knows the persona's own. Rebuilding each candidate's composed name covers those.
  if (personaLineageId !== undefined) {
    const composedMatch = await resolveComposedNameStage(
      guild,
      rawInput,
      normalizedInput,
      personaLineageId,
      namingConfig,
    );
    if (composedMatch) {
      return composedMatch;
    }
  }

  return {
    status: "not_found",
    input: rawInput,
  };
}

function formatChannelCandidateLabel(channel: GuildTextBasedChannel): string {
  if (isThreadLike(channel)) {
    // Parent name is intentionally omitted: threads are referenced by name only.
    // The resolver still accepts qualified "name in #parent" input; we just don't surface
    // parent info in labels to avoid confusing the LLM with decorated channel slugs.
    return channel.name;
  }

  return `#${channel.name}`;
}

function formatChannelCandidateLabelWithId(channel: GuildTextBasedChannel): string {
  return `${formatChannelCandidateLabel(channel)} (ID: ${channel.id})`;
}

function formatCopyableChannelCandidateLabel(channel: GuildTextBasedChannel): string {
  return `\`${formatChannelCandidateLabelWithId(channel)}\``;
}

function getQualifiedThreadLookupValues(channel: GuildTextBasedChannel): string[] {
  if (!isThreadLike(channel) || !("parent" in channel) || !channel.parent?.name) {
    return [];
  }

  const parentName = channel.parent.name;
  return [
    normalizeChannelTargetInput(`${channel.name} in #${parentName}`),
    normalizeChannelTargetInput(`${channel.name} in ${parentName}`),
    normalizeChannelTargetInput(`${parentName}/${channel.name}`),
    normalizeChannelTargetInput(`#${parentName}/${channel.name}`),
  ];
}

export async function formatChannelReferenceLabel(channel: GuildTextBasedChannel): Promise<string> {
  const baseLabel = formatChannelCandidateLabel(channel);
  if (!("guild" in channel)) {
    return baseLabel;
  }

  const activeThreads = await getActiveThreadTargets(channel.guild);
  const textChannels = channel.guild.channels.cache
    .filter((candidate) => isGuildTextTarget(candidate) && !isThreadLike(candidate))
    .map((candidate) => candidate as GuildTextBasedChannel);

  if (isThreadLike(channel)) {
    // Count other threads that share the same normalized name (including self → threshold > 1)
    const duplicateCount = activeThreads.filter(
      (thread) => normalizeChannelTargetInput(thread.name) === normalizeChannelTargetInput(channel.name),
    ).length;
    // Also flag collision when a text channel has the same name as this thread
    const hasTextChannelCollision = textChannels.some(
      (tc) => normalizeChannelTargetInput(tc.name) === normalizeChannelTargetInput(channel.name),
    );
    // "the channel named `name`" tells the LLM this is a navigable channel target;
    // include ID in the name portion when there is any collision so it can be copied exactly.
    return duplicateCount > 1 || hasTextChannelCollision
      ? `the channel named \`${formatChannelCandidateLabelWithId(channel)}\``
      : `the channel named \`${baseLabel}\``;
  }

  const normalizedName = normalizeChannelTargetInput(channel.name);
  const hasTextChannelCollision = textChannels.some(
    (candidate) => candidate.id !== channel.id && normalizeChannelTargetInput(candidate.name) === normalizedName,
  );
  const hasActiveThreadCollision = activeThreads.some(
    (thread) => normalizeChannelTargetInput(thread.name) === normalizedName,
  );
  const hasForumParentCollision = activeThreads.some(
    (thread) =>
      "parent" in thread &&
      !!thread.parent?.name &&
      isForumOrMediaParent(thread.parent) &&
      normalizeChannelTargetInput(thread.parent.name) === normalizedName,
  );

  return hasTextChannelCollision || hasActiveThreadCollision || hasForumParentCollision
    ? `the channel named \`${formatChannelCandidateLabelWithId(channel)}\``
    : `the channel named \`${channel.name}\``;
}

function buildAmbiguousChannelCandidates(
  candidates: Array<{
    label: string;
    channelName: string;
    channel: GuildTextBasedChannel;
  }>,
): Pick<AmbiguousChannelTarget, "candidates" | "totalCount"> {
  return {
    candidates: candidates.slice(0, 3).map((candidate) => ({
      label: formatCopyableChannelCandidateLabel(candidate.channel),
      channelName: candidate.channelName,
      channelId: candidate.channel.id,
    })),
    totalCount: candidates.length,
  };
}

async function getActiveThreadTargets(guild: Guild): Promise<GuildTextBasedChannel[]> {
  const activeThreads = await guild.channels.fetchActiveThreads().catch(() => null);
  if (!activeThreads) {
    return [];
  }

  return activeThreads.threads
    .filter((thread) => isGuildTextTarget(thread))
    .map((thread) => thread as GuildTextBasedChannel);
}

export async function resolveChannelTarget(input: string, context: ToolContext): Promise<ChannelTargetResolution> {
  const rawInput = input.trim();
  const parsableInput = unwrapInlineCodeDelimiters(rawInput);
  const { explicitId, strippedInput } = extractExplicitChannelId(parsableInput);
  const normalizedInput = normalizeChannelTargetInput(strippedInput);
  if (!normalizedInput) {
    if (!explicitId) {
      return {
        status: "not_found",
        input: rawInput,
      };
    }
  }

  const guild = await getContextGuild(context);
  if (!guild) {
    return {
      status: "not_found",
      input: rawInput,
    };
  }

  /** Resolve a raw channel ID. Tries client cache, guild fetch, then active threads:
   *  because guild.channels.fetch() does not return threads. */
  const resolveById = async (id: string): Promise<GuildTextBasedChannel | null> => {
    const fromClient = await context.client.channels.fetch(id).catch(() => null);
    const fromGuild = fromClient ?? (await guild.channels.fetch(id).catch(() => null));
    if (fromGuild && isGuildTextTarget(fromGuild) && "guildId" in fromGuild && fromGuild.guildId === guild.id) {
      return fromGuild as GuildTextBasedChannel;
    }
    // guild.channels.fetch does not return threads, so fall back to active thread list
    const activeThreads = await getActiveThreadTargets(guild);
    return activeThreads.find((t) => t.id === id) ?? null;
  };

  if (explicitId) {
    const channel = await resolveById(explicitId);
    if (channel) {
      return {
        status: "resolved",
        channel,
        displayLabel: formatChannelCandidateLabel(channel),
        source: "legacy_id",
      };
    }
  }

  if (isDiscordSnowflake(parsableInput)) {
    const channel = await resolveById(parsableInput);
    if (channel) {
      return {
        status: "resolved",
        channel,
        displayLabel: formatChannelCandidateLabel(channel),
        source: "legacy_id",
      };
    }
  }

  // Before running ambiguous name search, check if the conversation already showed this channel
  // with an ID (e.g. "the channel named `name (ID: 12345)`"). A unique context match bypasses
  // the ambiguity round-trip entirely.
  if (normalizedInput) {
    const contextIds = extractContextChannelIds(normalizedInput, context.contextItems ?? []);
    if (contextIds.length === 1) {
      const channel = await resolveById(contextIds[0]);
      if (channel) {
        return {
          status: "resolved",
          channel,
          displayLabel: formatChannelCandidateLabel(channel),
          source: "legacy_id",
        };
      }
    }
  }

  const searchChannels = async (fetchFallback: boolean): Promise<ChannelTargetResolution | null> => {
    const textChannels = guild.channels.cache
      .filter((channel) => isGuildTextTarget(channel) && !isThreadLike(channel))
      .map((channel) => channel as GuildTextBasedChannel);

    const activeThreads = await getActiveThreadTargets(guild);

    const qualifiedThreadMatches = dedupeChannelCandidates(
      activeThreads
        .filter((thread) => getQualifiedThreadLookupValues(thread).includes(normalizedInput))
        .map((thread) => ({
          label: formatChannelCandidateLabel(thread),
          channelName: thread.name,
          channel: thread,
        })),
    );

    if (qualifiedThreadMatches.length === 1) {
      return {
        status: "resolved",
        channel: qualifiedThreadMatches[0].channel,
        displayLabel: qualifiedThreadMatches[0].label,
        source: "qualified_thread_name",
      };
    }

    if (qualifiedThreadMatches.length > 1) {
      return {
        status: "ambiguous",
        input: rawInput,
        ...buildAmbiguousChannelCandidates(qualifiedThreadMatches),
      };
    }

    const exactChannelMatches = dedupeChannelCandidates(
      textChannels
        .filter((channel) => normalizeChannelTargetInput(channel.name) === normalizedInput)
        .map((channel) => ({
          label: formatChannelCandidateLabel(channel),
          channelName: channel.name,
          channel,
        })),
    );

    const forumParentThreadMatches = dedupeChannelCandidates(
      activeThreads
        .filter(
          (thread) =>
            "parent" in thread &&
            !!thread.parent?.name &&
            isForumOrMediaParent(thread.parent) &&
            normalizeChannelTargetInput(thread.parent.name) === normalizedInput,
        )
        .map((thread) => ({
          label: formatChannelCandidateLabel(thread),
          channelName: thread.name,
          channel: thread,
        })),
    );

    if (forumParentThreadMatches.length === 1 && exactChannelMatches.length === 0) {
      return {
        status: "resolved",
        channel: forumParentThreadMatches[0].channel,
        displayLabel: forumParentThreadMatches[0].label,
        source: "forum_parent_name",
      };
    }

    if (forumParentThreadMatches.length > 0) {
      const combinedForumCandidates = dedupeChannelCandidates([...exactChannelMatches, ...forumParentThreadMatches]);
      return {
        status: "ambiguous",
        input: rawInput,
        ...buildAmbiguousChannelCandidates(combinedForumCandidates),
      };
    }

    const exactThreadMatches = dedupeChannelCandidates(
      activeThreads
        .filter((thread) => normalizeChannelTargetInput(thread.name) === normalizedInput)
        .map((thread) => ({
          label: formatChannelCandidateLabel(thread),
          channelName: thread.name,
          channel: thread,
        })),
    );

    const combinedExactMatches = dedupeChannelCandidates([...exactChannelMatches, ...exactThreadMatches]);

    if (combinedExactMatches.length === 1) {
      const match = combinedExactMatches[0];
      return {
        status: "resolved",
        channel: match.channel,
        displayLabel: match.label,
        source: isThreadLike(match.channel) ? "thread_name" : "channel_name",
      };
    }

    if (combinedExactMatches.length > 1) {
      return {
        status: "ambiguous",
        input: rawInput,
        ...buildAmbiguousChannelCandidates(combinedExactMatches),
      };
    }

    const normalizedMatches = dedupeChannelCandidates(
      activeThreads
        .concat(textChannels)
        .filter((channel) => normalizeChannelTargetInput(channel.name) === normalizedInput)
        .map((thread) => ({
          label: formatChannelCandidateLabel(thread),
          channelName: thread.name,
          channel: thread,
        })),
    );

    if (normalizedMatches.length === 1) {
      return {
        status: "resolved",
        channel: normalizedMatches[0].channel,
        displayLabel: normalizedMatches[0].label,
        source: "normalized_name",
      };
    }

    if (normalizedMatches.length > 1) {
      return {
        status: "ambiguous",
        input: rawInput,
        ...buildAmbiguousChannelCandidates(normalizedMatches),
      };
    }

    // Nothing found in cache, so fetch all guild channels once and retry
    if (fetchFallback) {
      await guild.channels.fetch().catch(() => null);
      return searchChannels(false);
    }

    return null;
  };

  const searchResult = await searchChannels(true);
  if (searchResult) {
    return searchResult;
  }

  return {
    status: "not_found",
    input: rawInput,
  };
}
