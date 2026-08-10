import type { Guild, Message } from "discord.js";
import type { TomoriState, UserRow } from "@/types/db/schema";
import { CooldownType, PrivacyLevel } from "@/types/db/schema";
import { getCachedUserRow, getCachedBlacklistStatus, getCachedPrivacyLevel } from "@/utils/cache/userCache";
import { getCachedAllPersonas } from "@/utils/cache/tomoriStateCache";
import { configRepository, userRepository, whitelistRepository } from "@/utils/db/repositories";
import { isPersonaAllowedForTrigger } from "@/utils/persona/personaAccess";
import { resolvePreferredDiscordDisplayName } from "@/utils/discord/displayName";
import { sendStandardEmbed } from "@/utils/discord/embedHelper";
import { ColorCode, log } from "@/utils/misc/logger";
import {
  CredentialUnavailableError,
  PersonalProviderRequiredError,
  resolveCapabilityCredentials,
} from "@/utils/provider/credentialResolver";
import {
  checkTextQuotaForAdmission,
  enforceGlobalRateLimit,
  evaluateChatAccess,
  rejectOnMessageTriggerCooldown,
  setMessageTriggerCooldownForAdmission,
  validateDirectChatTrigger,
} from "@/utils/chat/admissionGuards";
import { channelLocks, queueScenePersonaJobsAtFront, setActiveChannelTurnState } from "@/utils/chat/channelQueue";
import { shouldSurfaceChatUserErrors } from "@/utils/chat/errorVisibility";
import { queueAdditionalPersonaTurns } from "@/utils/chat/personaQueue";
import { shouldBotReply } from "@/utils/chat/replyDecision";
import { buildSceneTextQuotaTriggerKey, buildSceneTurnDirective } from "@/utils/chat/sceneTurn";
import {
  determineMatchingPersonas,
  getAutochatAssignedPersonaId,
  getAutochatRange,
  isAutochatAlwaysReplyChannelActive,
  isAutochatConfiguredChannel,
  isAutochatCounterChannelActive,
  isAutochatCounterHit,
  isAutochatOverrideChannel,
  isAutochatQualifyingMessage,
  isMatrixRelayMessage,
  isSelfTriggerMessage,
} from "@/utils/chat/triggerProcessor";
import { getLastRespondedPersonaId, getSelfReplyChainState } from "@/utils/chat/selfReplyState";
import type { TextQuotaTriggerState } from "@/utils/chat/textQuotaState";
import type { ChatTurn, ChatTurnPlan, LockedChatTurn } from "@/utils/chat/types";
import { userNamingRepository, userPersonaNamingPairKey } from "@/utils/db/repositories/UserNamingRepository";
import { resolveEffectiveUserNaming } from "@/utils/text/userNaming";
const DEFAULT_CASCADE_LIMIT = 3;
const MAX_CASCADE_LIMIT = 10;
const DEFAULT_MATCH_LIMIT = 3;
const MIN_MATCH_LIMIT = 1;
const MAX_MATCH_LIMIT = 10;
type SendableChannel = Parameters<typeof sendStandardEmbed>[0];
export async function planChatTurns(lockedTurn: LockedChatTurn): Promise<ChatTurnPlan> {
  const admission = lockedTurn.admission;
  const incoming = admission.incoming;
  const { client, message } = incoming;
  const channel = message.channel;
  const guild = admission.guild ?? message.guild ?? null;
  const serverDiscId = admission.serverDiscId ?? guild?.id ?? message.author.id;
  const userDiscId = admission.userDiscId ?? incoming.manualTriggerInvoker?.userDiscId ?? message.author.id;
  const cooldownUserDiscId = admission.cooldownUserDiscId ?? userDiscId;
  const isDMChannel = admission.isDMChannel ?? !guild;
  const allPersonas = admission.allPersonas?.length ? admission.allPersonas : await getCachedAllPersonas(serverDiscId);
  const mainPersona = allPersonas.find((persona) => !persona.is_alter) ?? null;
  const fallbackPersona = mainPersona ?? allPersonas[0] ?? null;
  const tomoriState = admission.tomoriState ?? fallbackPersona;
  if (!tomoriState) {
    const shouldSurfaceNoStateError = shouldSurfaceChatUserErrors({
      incoming,
      client,
      message,
      isDMChannel,
      allPersonas,
    });
    incoming.shouldSurfaceUserErrors = shouldSurfaceNoStateError;
    if (shouldSurfaceNoStateError) {
      await validateDirectChatTrigger({
        client,
        message,
        guild,
        allPersonas,
        tomoriState: null,
        isDMChannel,
        isManuallyTriggered: incoming.isManuallyTriggered,
        userDiscId,
        serverDiscId,
        locale: admission.locale ?? "en-US",
      });
    }
    log.info(`No persona state available for message ${message.id} in server ${serverDiscId}.`);
    return { lockedTurn, turns: [] };
  }

  const userRow = await loadOrRegisterTriggerUser(message, guild, userDiscId, incoming.manualTriggerInvoker);
  const locale = userRow.language_pref ?? incoming.manualTriggerInvoker?.locale ?? admission.locale;
  admission.locale = locale;
  admission.userRow = userRow;
  admission.tomoriState = tomoriState;
  admission.allPersonas = allPersonas;

  const isSelfMessage = isSelfTriggerMessage(message, allPersonas);
  if (
    (message.author.bot || message.webhookId) &&
    !isSelfMessage &&
    !incoming.isManuallyTriggered &&
    !isMatrixRelayMessage(message)
  ) {
    return { lockedTurn, turns: [] };
  }

  const directTrigger = await validateDirectChatTrigger({
    client,
    message,
    guild,
    allPersonas,
    tomoriState,
    isDMChannel,
    isManuallyTriggered: incoming.isManuallyTriggered,
    userDiscId,
    serverDiscId,
    locale,
  });
  if (!directTrigger.shouldContinue) {
    return { lockedTurn, turns: [] };
  }
  if (directTrigger.isUserImpersonation) {
    incoming.isUserImpersonation = true;
    incoming.impersonatedUserId = directTrigger.impersonatedUserId;
  }
  const shouldSurfaceUserErrors = shouldSurfaceChatUserErrors({
    incoming,
    client,
    message,
    isDMChannel,
    allPersonas,
    isReplyToBotOrPersona: directTrigger.isReplyToBot || Boolean(directTrigger.replyPersona),
    isBotMentioned: directTrigger.isBotMentioned,
  });
  incoming.shouldSurfaceUserErrors = shouldSurfaceUserErrors;

  if (!isDMChannel && tomoriState.config.thought_log_channel_disc_id === channel.id) {
    log.info(`Skipping normal chat trigger in configured thought-log channel ${channel.id}.`);
    return { lockedTurn, turns: [] };
  }

  await updateAutochatCounter(message, tomoriState, serverDiscId);

  const channelIds = resolveChannelScope(message);
  const isAutochatOverride = isAutochatOverrideChannel(tomoriState.config, channelIds.effectiveChannelId);
  const accessState = await evaluateChatAccess({
    isStopResponse: !!incoming.isStopResponse,
    isDMChannel,
    isManuallyTriggered: incoming.isManuallyTriggered,
    isSelfMessage,
    isAutochatOverride,
    guildDiscId: serverDiscId,
    fallbackUserDiscId: userDiscId,
    message,
    memberRoleDiscIds: incoming.manualTriggerInvoker?.member
      ? incoming.manualTriggerInvoker.member.roles.cache.map((role) => role.id)
      : (message.member?.roles.cache.map((role) => role.id) ?? undefined),
    parentChannelId: channelIds.parentChannelId,
    effectiveChannelId: channelIds.effectiveChannelId,
    serverId: tomoriState.server_id,
    userId: userRow.user_id,
    allPersonas,
  });
  // Reminder turns are system-initiated because the role whitelist guards against unauthorized
  // users triggering Tomori, but reminders were authorized at creation time. The channel
  // whitelist (is this channel allowed at all?) still applies via whitelistStatus.isTriggerAllowed,
  // but role-based rejection that derives from the last message author is skipped.
  const isReminderTurn = !!(incoming.reminderRecipientID || incoming.reminderData?.self_reminder);
  if (accessState.rejectedByWhitelist && !isReminderTurn) {
    return { lockedTurn, turns: [] };
  }

  if (
    !incoming.isManuallyTriggered &&
    !shouldBotReply(message, tomoriState, allPersonas, {
      personalAutoTriggerPersonaId: accessState.personalSpotlightStatus?.autoTriggerPersonaId ?? null,
      allowedPersonaIds: accessState.allowedPersonaIds,
      personalDtm: (userRow.personal_dtm as "off" | "follow" | "on") ?? "follow",
    })
  ) {
    return { lockedTurn, turns: [] };
  }

  const credentialPolicy = await resolveTextCredentialPolicy({
    tomoriState,
    isSelfMessage,
    isPersonaJob: incoming.isPersonaJob,
    isManuallyTriggered: incoming.isManuallyTriggered,
    isUserImpersonation: incoming.isUserImpersonation,
    userRow,
    channel,
    locale,
    isDMChannel,
    shouldSurfaceUserErrors,
  });
  if (!credentialPolicy) {
    return { lockedTurn, turns: [] };
  }

  let personasToRespond = selectPersonasForTurn({
    lockedTurn,
    allPersonas,
    tomoriState,
    mainPersona,
    fallbackPersona,
    directTrigger,
    isSelfMessage,
    matchLimit: getMatchLimit(tomoriState),
    channelId: channel.id,
    effectiveChannelId: channelIds.effectiveChannelId,
    allowedPersonaIds: accessState.allowedPersonaIds,
    personalAutoTriggerPersonaId: accessState.personalSpotlightStatus?.autoTriggerPersonaId ?? null,
    whitelistStatus: accessState.whitelistStatus,
    personalSpotlightStatus: accessState.personalSpotlightStatus,
    userRow,
  });

  if (personasToRespond.length === 0) {
    log.info(`No personas matched trigger for message ${message.id} in server ${serverDiscId}`);
    return { lockedTurn, turns: [] };
  }

  if (
    !(await enforceTurnGuards(
      lockedTurn,
      tomoriState,
      userRow,
      personasToRespond,
      credentialPolicy.source,
      shouldSurfaceUserErrors,
    ))
  ) {
    return { lockedTurn, turns: [] };
  }

  const textQuota = await prepareTextQuota(
    lockedTurn,
    tomoriState,
    credentialPolicy.source,
    userRow,
    shouldSurfaceUserErrors,
  );
  if (!textQuota.allowed) {
    return { lockedTurn, turns: [] };
  }

  const triggeredPersonaIds =
    incoming.triggeredPersonaIds ??
    personasToRespond.map((persona) => persona.persona_id).filter((personaId): personaId is number => !!personaId);

  const lockEntry = channelLocks.get(lockedTurn.channelId);
  if (lockEntry) {
    setActiveChannelTurnState(lockEntry, {
      activePersonaId: personasToRespond[0]?.persona_id ?? undefined,
      triggeredPersonaIds,
      followUpEligible: personasToRespond[0]?.persona_id !== undefined,
      isUserImpersonation: incoming.isUserImpersonation,
      impersonatedUserId: incoming.impersonatedUserId,
    });
  }

  if (
    incoming.sceneTurn &&
    incoming.sceneTurn.turnIndex === 0 &&
    !incoming.skipLock &&
    incoming.retryCount === 0 &&
    lockEntry
  ) {
    const rootSceneTurn = incoming.sceneTurn;
    const remainingSceneJobs = rootSceneTurn.sequence.slice(1).map((speaker, offset) => {
      const sceneTurn = {
        ...rootSceneTurn,
        turnIndex: offset + 1,
      };

      return {
        personaName: speaker.personaName,
        selectedPersonaId: speaker.personaId,
        sceneTurn,
        manualSystemPrompt: buildSceneTurnDirective(sceneTurn),
        textQuotaTriggerKey: buildSceneTextQuotaTriggerKey(sceneTurn),
      };
    });

    if (remainingSceneJobs.length > 0) {
      queueScenePersonaJobsAtFront({
        lockEntry,
        message,
        sceneJobs: remainingSceneJobs,
        triggeredPersonaIds,
        forceReason: incoming.forceReason,
        reasoningQuery: incoming.reasoningQuery,
        llmOverrideCodename: incoming.llmOverrideCodename,
        textQuotaSource: incoming.textQuotaSource,
        textQuotaUserDiscId: incoming.textQuotaUserDiscId ?? cooldownUserDiscId,
        shouldSurfaceUserErrors,
        injectedContextItems: incoming.injectedContextItems,
        forcedMentions: incoming.forcedMentions,
        manualTriggerInvoker: incoming.manualTriggerInvoker,
        manualStreamingContextOverrides: incoming.manualStreamingContextOverrides,
      });
    }
  }

  if (
    !incoming.isManuallyTriggered &&
    !incoming.reminderRecipientID &&
    !incoming.reminderData?.self_reminder &&
    !incoming.isStopResponse &&
    personasToRespond.length > 1 &&
    lockEntry
  ) {
    personasToRespond = queueAdditionalPersonaTurns({
      lockEntry,
      message,
      personasToRespond,
      triggeredPersonaIds,
      forceReason: incoming.forceReason,
      reasoningQuery: incoming.reasoningQuery,
      llmOverrideCodename: incoming.llmOverrideCodename,
      textQuotaSource: incoming.textQuotaSource,
      textQuotaTriggerKey: textQuota.triggerKey,
      textQuotaUserDiscId: incoming.textQuotaUserDiscId ?? cooldownUserDiscId,
      shouldSurfaceUserErrors,
      injectedContextItems: incoming.injectedContextItems,
      forcedMentions: incoming.forcedMentions,
    });
  }

  const requestSnapshot = {
    tomoriState,
    triggererUserRow: userRow,
    isTriggererBlacklisted: await getCachedBlacklistStatus(serverDiscId, userDiscId),
    isTriggererOptedOut: (await getCachedPrivacyLevel(userDiscId)) === PrivacyLevel.FULL,
    triggererPrivacyLevel: await getCachedPrivacyLevel(userDiscId),
    preloadedMember: !isDMChannel && guild ? await guild.members.fetch(userDiscId).catch(() => null) : null,
  };
  const displayName =
    incoming.manualTriggerInvoker?.member?.displayName ??
    incoming.manualTriggerInvoker?.username ??
    message.author.username;
  let triggererName =
    requestSnapshot.isTriggererBlacklisted ||
    tomoriState.config.personal_memories_enabled === false ||
    !userRow.user_nickname
      ? displayName
      : userRow.user_nickname;
  const canUsePersonalizedNaming =
    !requestSnapshot.isTriggererBlacklisted && tomoriState.config.personal_memories_enabled !== false;
  const namingPreferences = userRow.user_id
    ? await userNamingRepository.loadPreferences(
        personasToRespond.map((persona) => ({
          userId: userRow.user_id as number,
          personaLineageId: persona.persona_lineage_id,
        })),
      )
    : new Map();

  // Scene turns are a scripted persona-to-persona chain: each speaker responds to the
  // PREVIOUS speaker, so {{user}} (which resolves to triggererName) should be that prior
  // persona rather than the command invoker: matching how a normal self-reply queue
  // resolves the triggerer to the last persona in the chain. Turn 0 has no prior speaker
  // and keeps the invoker as the entity being responded to.
  if (incoming.sceneTurn && incoming.sceneTurn.turnIndex > 0) {
    const previousSpeakerName = incoming.sceneTurn.sequence[incoming.sceneTurn.turnIndex - 1]?.personaName.trim();
    if (previousSpeakerName) {
      triggererName = previousSpeakerName;
    }
  }

  const turns: ChatTurn[] = personasToRespond.map((persona, personaIndex) => {
    const isPersonaSceneTarget = Boolean(incoming.sceneTurn && incoming.sceneTurn.turnIndex > 0);
    const preference = userRow.user_id
      ? namingPreferences.get(userPersonaNamingPairKey(userRow.user_id, persona.persona_lineage_id))
      : undefined;
    const effectiveNaming = resolveEffectiveUserNaming({
      global: {
        userNickname: canUsePersonalizedNaming ? userRow.user_nickname : null,
        prefixOverride: canUsePersonalizedNaming ? (userRow.prefix_override ?? null) : null,
        suffixOverride: canUsePersonalizedNaming ? (userRow.suffix_override ?? null) : null,
        addressingStyle: canUsePersonalizedNaming ? (userRow.addressing_style ?? null) : null,
      },
      liveDisplayName: displayName,
      persona: canUsePersonalizedNaming ? persona.naming_config : undefined,
      preference: canUsePersonalizedNaming ? preference : null,
    });
    const perPersonaTriggererName = isPersonaSceneTarget ? triggererName : effectiveNaming.nickname;
    const triggererFormattedName = isPersonaSceneTarget ? triggererName : effectiveNaming.formattedName;

    return {
      lockedTurn,
      persona,
      personaIndex,
      totalPersonas: personasToRespond.length,
      allPersonas,
      tomoriState: persona,
      mainPersona,
      userRow,
      requestSnapshot,
      serverDiscId,
      guild,
      isDMChannel,
      isSelfMessage,
      userDiscId,
      cooldownUserDiscId,
      triggererName: perPersonaTriggererName,
      triggererFormattedName,
      triggererAddressTerm: effectiveNaming.addressTerm,
      channelName: isDMChannel
        ? "Direct Message"
        : "name" in channel
          ? (channel.name ?? "Unknown Channel")
          : "Unknown Channel",
      channelDescription: isDMChannel ? null : "topic" in channel ? channel.topic : null,
      serverName: isDMChannel ? "Direct Message" : (guild?.name ?? "Unknown Server"),
      serverDescription: isDMChannel ? null : (guild?.description ?? null),
      textCredentialSource: credentialPolicy.source,
      personalRoutingUserId: credentialPolicy.personalRoutingUserId,
      personalTextProvider: credentialPolicy.personalTextProvider,
      shouldApplyTextQuota: textQuota.shouldApply,
      textQuotaTriggerKey: textQuota.triggerKey,
      textQuotaState: textQuota.state,
      shouldSurfaceUserErrors,
      forcedMentions: incoming.forcedMentions,
      isUserImpersonation: incoming.isUserImpersonation,
      impersonatedUserId: incoming.impersonatedUserId,
      triggeredPersonaIds,
    };
  });

  log.info(
    `${turns.length} persona(s) will respond to message ${message.id}: ${turns
      .map((turn) => turn.persona.persona_nickname)
      .join(", ")}`,
  );
  return { lockedTurn, turns };
}

async function loadOrRegisterTriggerUser(
  message: Message,
  guild: Guild | null,
  userDiscId: string,
  manualTriggerInvoker: LockedChatTurn["admission"]["incoming"]["manualTriggerInvoker"],
): Promise<UserRow> {
  const existing = await getCachedUserRow(userDiscId);
  if (existing) return existing;

  const locale = manualTriggerInvoker?.locale ?? (guild?.preferredLocale.startsWith("ja") ? "ja" : "en-US");
  const displayName = resolvePreferredDiscordDisplayName({
    memberDisplayName: manualTriggerInvoker?.member?.displayName ?? message.member?.displayName,
    user: manualTriggerInvoker ? { username: manualTriggerInvoker.username } : message.author,
    fallback: manualTriggerInvoker?.username ?? message.author.username,
  });
  const registered = await userRepository.register(userDiscId, displayName, locale);
  if (!registered) {
    throw new Error(`Failed to register trigger user ${userDiscId}.`);
  }
  return registered;
}

async function updateAutochatCounter(message: Message, tomoriState: TomoriState, serverDiscId: string): Promise<void> {
  const { minThreshold, maxThreshold } = getAutochatRange(tomoriState.config);
  const effectiveChannelId = message.channel.isThread()
    ? (message.channel.parentId ?? message.channel.id)
    : message.channel.id;
  if (!isAutochatCounterChannelActive(tomoriState.config, effectiveChannelId) || !isRealUserMessage(message)) {
    return;
  }
  if (!tomoriState.persona_id) {
    log.error(`Tomori ID missing for server ${serverDiscId} during counter increment.`);
    return;
  }

  try {
    const updatedTomoriRow = await configRepository.incrementTomoriCounter(
      tomoriState.persona_id,
      minThreshold,
      maxThreshold,
    );
    if (!updatedTomoriRow) {
      log.warn(`Failed to update auto-message counter for server ${serverDiscId}.`);
      return;
    }
    tomoriState.autoch_counter = updatedTomoriRow.autoch_counter;
    tomoriState.autoch_next_target = updatedTomoriRow.autoch_next_target;
  } catch (error) {
    log.error(`Error updating auto-message counter for server ${serverDiscId}`, error);
  }
}

function isRealUserMessage(message: Message): boolean {
  return (!message.author.bot && !message.webhookId) || isMatrixRelayMessage(message);
}

function resolveChannelScope(message: Message): { effectiveChannelId: string; parentChannelId?: string } {
  const isThread =
    "isThread" in message.channel && typeof message.channel.isThread === "function" && message.channel.isThread();
  const parentChannelId = isThread && "parent" in message.channel ? message.channel.parent?.id : undefined;
  return {
    effectiveChannelId: parentChannelId ?? message.channelId,
    parentChannelId,
  };
}

function getMatchLimit(tomoriState: TomoriState): number {
  const rawMatchLimit = tomoriState.config.match_limit ?? DEFAULT_MATCH_LIMIT;
  return Math.min(Math.max(rawMatchLimit, MIN_MATCH_LIMIT), MAX_MATCH_LIMIT);
}

async function resolveTextCredentialPolicy(params: {
  tomoriState: TomoriState;
  isSelfMessage: boolean;
  isPersonaJob: boolean;
  isManuallyTriggered?: boolean;
  isUserImpersonation: boolean;
  userRow: UserRow;
  channel: Message["channel"];
  locale: string;
  isDMChannel: boolean;
  shouldSurfaceUserErrors: boolean;
}): Promise<{
  source: "server" | "personal";
  personalRoutingUserId: number | null;
  personalTextProvider: string | null;
} | null> {
  const personalRoutingUserId =
    params.isSelfMessage && !params.isPersonaJob && !params.isManuallyTriggered && !params.isUserImpersonation
      ? null
      : (params.userRow.user_id ?? null);

  try {
    const textCreds = await resolveCapabilityCredentials(params.tomoriState.server_id, "text", {
      userId: personalRoutingUserId,
    });
    return {
      source: textCreds.source,
      personalRoutingUserId,
      personalTextProvider: textCreds.source === "personal" ? textCreds.provider : null,
    };
  } catch (error) {
    if (error instanceof PersonalProviderRequiredError) {
      if (params.shouldSurfaceUserErrors) {
        await sendStandardEmbed(params.channel as SendableChannel, params.locale, {
          color: ColorCode.ERROR,
          titleKey: "general.errors.personal_provider_required_title",
          descriptionKey: "general.errors.personal_provider_required_description",
        });
      } else {
        log.warn("Suppressing personal-provider-required embed for non-deliberate chat turn.", error);
      }
      return null;
    }
    if (error instanceof CredentialUnavailableError) {
      if (
        error.reason === "missing_model_id" &&
        personalRoutingUserId === null &&
        params.tomoriState.config.user_byok_mode
      ) {
        log.info(`Skipping server-initiated turn in BYOK-only mode for server ${params.tomoriState.server_id}.`);
        return null;
      }
      const isPersonalError = error.source === "personal";
      const isMissingConfig = error.reason === "no_saved_config" || error.reason === "missing_model_id";
      if (params.shouldSurfaceUserErrors) {
        await sendStandardEmbed(params.channel as SendableChannel, params.locale, {
          color: ColorCode.ERROR,
          titleKey: isPersonalError
            ? "general.errors.personal_provider_credentials_error_title"
            : isMissingConfig
              ? "general.errors.api_key_missing_title"
              : "general.errors.api_key_error_title",
          descriptionKey: isPersonalError
            ? "general.errors.personal_provider_credentials_error_description"
            : isMissingConfig
              ? "general.errors.api_key_missing_description"
              : "general.errors.api_key_error_description",
          ...(params.isDMChannel && !isPersonalError ? { footerKey: "general.errors.tomori_not_setup_dm_footer" } : {}),
        });
      } else {
        log.warn("Suppressing credential error embed for non-deliberate chat turn.", error);
      }
      return null;
    }
    throw error;
  }
}

function selectPersonasForTurn(args: {
  lockedTurn: LockedChatTurn;
  allPersonas: TomoriState[];
  tomoriState: TomoriState;
  mainPersona: TomoriState | null;
  fallbackPersona: TomoriState | null;
  directTrigger: Awaited<ReturnType<typeof validateDirectChatTrigger>>;
  isSelfMessage: boolean;
  matchLimit: number;
  channelId: string;
  effectiveChannelId: string;
  allowedPersonaIds: Set<number> | null;
  personalAutoTriggerPersonaId: number | null;
  whitelistStatus: Awaited<ReturnType<typeof evaluateChatAccess>>["whitelistStatus"];
  personalSpotlightStatus: Awaited<ReturnType<typeof evaluateChatAccess>>["personalSpotlightStatus"];
  userRow: UserRow;
}): TomoriState[] {
  const incoming = args.lockedTurn.admission.incoming;
  const selectedPersona = incoming.selectedPersonaId
    ? (args.allPersonas.find((persona) => persona.persona_id === incoming.selectedPersonaId) ?? args.fallbackPersona)
    : args.fallbackPersona;
  const isAllowedByAccessState = (persona: TomoriState | null | undefined): persona is TomoriState =>
    Boolean(
      persona &&
        (!args.allowedPersonaIds ||
          (typeof persona.persona_id === "number" && args.allowedPersonaIds.has(persona.persona_id))),
    );

  // Reminder turns are system-initiated: bypass personal spotlight (a user preference
  // that governs which persona responds *to them*, not system-triggered events). Only
  // the persona-channel whitelist is still enforced so channel admins can restrict personas.
  if (incoming.reminderRecipientID || incoming.reminderData?.self_reminder) {
    return selectedPersona &&
      whitelistRepository.isPersonaAllowedByWhitelistStatus(args.whitelistStatus, selectedPersona.persona_id)
      ? [selectedPersona]
      : [];
  }
  if (incoming.isManuallyTriggered) {
    return selectedPersona &&
      isPersonaAllowedForTrigger(args.whitelistStatus, args.personalSpotlightStatus, selectedPersona.persona_id) &&
      isAllowedByAccessState(selectedPersona)
      ? [selectedPersona]
      : [];
  }
  if (incoming.isStopResponse) {
    const mainTurn = args.mainPersona ? [args.mainPersona] : [];
    return mainTurn;
  }

  const config = args.tomoriState.config;
  const personalAutoTriggerPersonaId = isPersonaAllowedForTrigger(
    args.whitelistStatus,
    args.personalSpotlightStatus,
    args.personalAutoTriggerPersonaId,
  )
    ? (args.personalAutoTriggerPersonaId ?? null)
    : null;
  const isPersonalAutoTriggerActive =
    personalAutoTriggerPersonaId !== null &&
    isAutochatQualifyingMessage(args.lockedTurn.admission.message, args.isSelfMessage);
  const isAutoMsgHit =
    !isPersonalAutoTriggerActive &&
    isAutochatQualifyingMessage(args.lockedTurn.admission.message, args.isSelfMessage) &&
    isAutochatCounterHit(args.tomoriState, args.effectiveChannelId);
  const serverAutoTriggerPersonaId = getAutochatAssignedPersonaId(config, args.effectiveChannelId);
  const isScopedAlwaysReplyActive =
    isAutochatAlwaysReplyChannelActive(config, args.effectiveChannelId) &&
    isAutochatQualifyingMessage(args.lockedTurn.admission.message, args.isSelfMessage);
  const serverDtmEnabled = !!config.deliberate_trigger_mode;
  const personalDtmMode = args.userRow.personal_dtm ?? "follow";
  const isDtmActive =
    (personalDtmMode === "on" || (personalDtmMode === "follow" && serverDtmEnabled)) &&
    !!args.lockedTurn.admission.message.guild &&
    !isMatrixRelayMessage(args.lockedTurn.admission.message);
  const isAlwaysReplyActive =
    (!!config.always_reply_enabled &&
      isAutochatQualifyingMessage(args.lockedTurn.admission.message, args.isSelfMessage)) ||
    isScopedAlwaysReplyActive ||
    isPersonalAutoTriggerActive;

  let personasToRespond = determineMatchingPersonas(
    args.lockedTurn.admission.message,
    args.allPersonas,
    args.lockedTurn.admission.client,
    args.directTrigger.isReplyToBot,
    args.directTrigger.replyPersona,
    args.directTrigger.isBotMentioned,
    isAutoMsgHit,
    isAlwaysReplyActive,
    personalAutoTriggerPersonaId ?? serverAutoTriggerPersonaId,
    isPersonalAutoTriggerActive
      ? personalAutoTriggerPersonaId
      : isScopedAlwaysReplyActive
        ? serverAutoTriggerPersonaId
        : null,
    isDtmActive,
    isAutochatConfiguredChannel(config, args.effectiveChannelId) || isPersonalAutoTriggerActive,
    args.allowedPersonaIds,
  );

  if (args.isSelfMessage) {
    const lastRespondedId = getLastRespondedPersonaId(args.channelId);
    if (lastRespondedId !== null) {
      personasToRespond = personasToRespond.filter((persona) => persona.persona_id !== lastRespondedId);
    }
  }

  return personasToRespond.slice(0, args.matchLimit);
}

async function enforceTurnGuards(
  lockedTurn: LockedChatTurn,
  tomoriState: TomoriState,
  userRow: UserRow,
  personasToRespond: TomoriState[],
  textCredentialSource: "server" | "personal",
  shouldSurfaceUserErrors: boolean,
): Promise<boolean> {
  const admission = lockedTurn.admission;
  const incoming = admission.incoming;
  const message = admission.message;
  const channel = admission.channel;
  const serverDiscId = admission.serverDiscId ?? message.guild?.id ?? message.author.id;
  const userDiscId = admission.userDiscId ?? userRow.user_disc_id;
  const isSelfMessage = isSelfTriggerMessage(message, admission.allPersonas ?? personasToRespond);

  if (!incoming.skipLock && !incoming.isStopResponse && !incoming.isPersonaJob) {
    const rateLimitAllowed = await enforceGlobalRateLimit({
      userDiscId,
      serverDiscId,
      channel: channel as SendableChannel,
      guild: admission.guild ?? message.guild ?? null,
      client: admission.client,
      messageId: message.id,
      userActiveCountAdjustment: -1,
      serverActiveCountAdjustment: -1,
      notifyUser: shouldSurfaceUserErrors,
    });
    if (!rateLimitAllowed) return false;
  }

  if (!incoming.isStopResponse && !incoming.isPersonaJob && !isSelfMessage && textCredentialSource !== "personal") {
    const rejectedByCooldown = await rejectOnMessageTriggerCooldown({
      serverDiscId,
      userDiscId: admission.cooldownUserDiscId ?? userDiscId,
      channelId: message.channelId,
      cooldownType: tomoriState.config.cooldown_type ?? CooldownType.OFF,
      member: message.member,
      isAutochatOverride: isAutochatOverrideChannel(
        tomoriState.config,
        resolveChannelScope(message).effectiveChannelId,
      ),
      author: message.author,
      locale: admission.locale,
      botName: tomoriState.persona_nickname,
      notifyUser: shouldSurfaceUserErrors,
    });
    if (rejectedByCooldown) return false;

    await setMessageTriggerCooldownForAdmission({
      serverDiscId,
      userDiscId: admission.cooldownUserDiscId ?? userDiscId,
      channelId: message.channelId,
      cooldownType: tomoriState.config.cooldown_type ?? CooldownType.OFF,
      cooldownLength: tomoriState.config.cooldown_length ?? 5,
      member: message.member,
    });
  }

  const cascadeLimit = Math.min(
    Math.max(tomoriState.config.cascade_limit ?? DEFAULT_CASCADE_LIMIT, 0),
    MAX_CASCADE_LIMIT,
  );
  const triggerState = getSelfReplyChainState(channel.id);
  if (
    (isSelfMessage || (incoming.isPersonaJob && !incoming.sceneTurn)) &&
    !incoming.reminderRecipientID &&
    !incoming.reminderData?.self_reminder &&
    !incoming.isStopResponse
  ) {
    if (triggerState.triggerCount >= cascadeLimit + 1) {
      log.info(`Cascade trigger limit reached for message ${message.id} in channel ${channel.id}.`);
      return false;
    }
  }

  return true;
}

async function prepareTextQuota(
  lockedTurn: LockedChatTurn,
  tomoriState: TomoriState,
  textCredentialSource: "server" | "personal",
  userRow: UserRow,
  shouldSurfaceUserErrors: boolean,
): Promise<{ allowed: boolean; shouldApply: boolean; triggerKey: string; state: TextQuotaTriggerState | null }> {
  const incoming = lockedTurn.admission.incoming;
  const triggerKey = incoming.textQuotaTriggerKey ?? lockedTurn.admission.message.id;
  const shouldTreatAsQuotaSharedPersonaJob = incoming.isPersonaJob && !incoming.sceneTurn;
  const shouldApply =
    incoming.textQuotaSource === "user" &&
    !lockedTurn.admission.isDMChannel &&
    !incoming.isStopResponse &&
    !incoming.reminderRecipientID &&
    !incoming.reminderData?.self_reminder &&
    textCredentialSource !== "personal";

  const quota = await checkTextQuotaForAdmission({
    shouldApplyTextQuota: shouldApply,
    isPersonaJob: shouldTreatAsQuotaSharedPersonaJob,
    triggerKey,
    serverId: tomoriState.server_id,
    userDiscId: incoming.textQuotaUserDiscId ?? lockedTurn.admission.cooldownUserDiscId ?? userRow.user_disc_id,
    channel: lockedTurn.admission.channel as SendableChannel,
    locale: lockedTurn.admission.locale,
    notifyUser: shouldSurfaceUserErrors,
  });

  return {
    allowed: quota.allowed,
    shouldApply,
    triggerKey,
    state: quota.allowed ? quota.state : null,
  };
}
