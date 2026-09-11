import type { Client, Message } from "discord.js";
import type { ForcedMention } from "@/types/discord/mentions";
import type { TomoriState } from "@/types/db/schema";
import type { StructuredContextItem } from "@/types/misc/context";
import type { StreamingContext } from "@/types/tool/interfaces";
import { getCachedAllPersonas } from "@/utils/cache/tomoriStateCache";
import { StreamOrchestrator } from "@/utils/discord/streamOrchestrator";
import { log } from "@/utils/misc/logger";
import { isSelfTriggerMessage } from "@/utils/chat/triggerProcessor";
import type {
  ChatGenerationResultHandler,
  ChatReminderData,
  LockedChatTurn,
  ManualTriggerInvoker,
  QueuedMessageDiscardHandler,
  QueuedMessageDiscardReason,
  RunnableChatAdmission,
  SceneTurnMetadata,
  SystemTriggerIdentity,
  TextQuotaSource,
} from "@/utils/chat/types";
import { parseIntegerEnvFlag } from "@/utils/misc/envFlags";

export const CHANNEL_LOCK_TIMEOUT_MS = parseIntegerEnvFlag(process.env.CHANNEL_LOCK_TIMEOUT_MS, 180000, 10000);
const DISCORD_TYPING_KEEPALIVE_INTERVAL_MS = parseIntegerEnvFlag(
  process.env.DISCORD_TYPING_KEEPALIVE_INTERVAL_MS,
  8000,
  1000,
);
export const MAX_FOLLOW_UP_INTERRUPTS = Number.parseInt(process.env.MAX_FOLLOW_UP_INTERRUPTS || "3", 10);
const SELF_REPLY_SUPPRESSION_TTL_MS = 5000;

export type QueuedMessage = {
  message: Message;
  isManuallyTriggered?: boolean;
  forceReason?: boolean;
  reasoningQuery?: string;
  llmOverrideCodename?: string;
  isStopResponse?: boolean;
  isFollowUp?: boolean;
  selectedPersonaId?: number;
  triggeredPersonaIds?: number[];
  isPersonaJob?: boolean;
  isUserImpersonation?: boolean;
  impersonatedUserId?: string;
  textQuotaSource?: TextQuotaSource;
  textQuotaTriggerKey?: string;
  textQuotaUserDiscId?: string;
  manualSystemPrompt?: string;
  manualPrefill?: string;
  shouldSurfaceUserErrors?: boolean;
  injectedContextItems?: StructuredContextItem[];
  forcedMentions?: ForcedMention[];
  manualTriggerInvoker?: ManualTriggerInvoker;
  systemTriggerIdentity?: SystemTriggerIdentity;
  manualStreamingContextOverrides?: Pick<
    StreamingContext,
    "disableCrossChannelMessage" | "disableRecentMessageReplyTool" | "disableReminderTool"
  >;
  sceneTurn?: SceneTurnMetadata;
  reminderRecipientID?: string;
  reminderData?: ChatReminderData;
  onGenerationResult?: ChatGenerationResultHandler;
  onQueueDiscard?: QueuedMessageDiscardHandler;
};

export interface ChannelLockEntry {
  isLocked: boolean;
  lockedAt: number;
  currentMessageId?: string;
  serverDiscId: string;
  userDiscId?: string;
  currentIsPersonaJob?: boolean;
  activePersonaId?: number;
  activeTriggeredPersonaIds?: number[];
  activeIsUserImpersonation?: boolean;
  activeImpersonatedUserId?: string;
  followUpEligible?: boolean;
  isInToolCallChain?: boolean;
  isCommandTriggered?: boolean;
  typingKeepaliveTimer: NodeJS.Timeout | null;
  followUpCount: number;
  messageQueue: QueuedMessage[];
  /** Callback that aborts the active HTTP request and rejects the stream Promise.race. Set by toolLoop, cleared on release. */
  activeStreamKill?: ((reason: Error) => void) | null;
  /** AbortController for the entire turn (streaming + tools). Aborted by /kill; signal forwarded to tools via ToolContext. */
  activeTurnAbortController: AbortController | null;
}

export const channelLocks = new Map<string, ChannelLockEntry>();
export const selfReplySuppressionUntil = new Map<string, number>();

export async function runWithChannelLock<T>(
  admission: RunnableChatAdmission,
  callback: (lockedTurn: LockedChatTurn, startTyping: () => Promise<void>) => Promise<T>,
  options: {
    handleStopResponse: (originalStopMessage: Message, client: Client) => Promise<void>;
    processQueuedMessage: (queuedMessage: QueuedMessage) => Promise<void>;
  },
): Promise<T> {
  const channelId = admission.message.channel.id;
  const skipLock = admission.incoming.skipLock;

  // Retry/internal re-entries (skipLock) reuse the outer turn's lock and typing keepalive : no new typing start
  if (skipLock) {
    const lockEntry = channelLocks.get(channelId);
    return await callback(
      {
        admission,
        channelId,
        lockedAt: lockEntry?.lockedAt ?? Date.now(),
        queueDepth: lockEntry?.messageQueue.length ?? 0,
        skipLock: true,
      },
      () => Promise.resolve(),
    );
  }

  const serverDiscId = admission.serverDiscId ?? channelId;
  const lockEntry = getOrCreateChannelLockEntry(channelId, serverDiscId);
  releaseStaleChannelLockIfExpired(channelId, lockEntry);

  const userDiscId = admission.userDiscId ?? admission.message.author.id;
  acquireChannelLockForTurn(lockEntry, {
    messageId: admission.message.id,
    userDiscId,
    isPersonaJob: admission.incoming.isPersonaJob,
    selectedPersonaId: admission.incoming.selectedPersonaId,
    triggeredPersonaIds: admission.incoming.triggeredPersonaIds,
    isCommandTriggered: admission.incoming.isManuallyTriggered ?? false,
  });

  try {
    return await callback(
      {
        admission,
        channelId,
        lockedAt: lockEntry.lockedAt,
        queueDepth: lockEntry.messageQueue.length,
        skipLock: false,
      },
      () => startDiscordTypingKeepalive(admission.message.channel, lockEntry, admission.message.id),
    );
  } finally {
    releaseChannelLockAndReplayQueue({
      channelId,
      lockEntry,
      completedMessageId: admission.message.id,
      handleStopResponse: options.handleStopResponse,
      processQueuedMessage: options.processQueuedMessage,
    });
  }
}

export function isActiveNaturalStopTurn(channelId: string, userDiscId: string): boolean {
  const lockEntry = channelLocks.get(channelId);
  return Boolean(
    lockEntry?.isLocked &&
      Date.now() - lockEntry.lockedAt <= CHANNEL_LOCK_TIMEOUT_MS &&
      lockEntry.userDiscId === userDiscId,
  );
}

export function getOrCreateChannelLockEntry(channelId: string, serverDiscId: string): ChannelLockEntry {
  const existing = channelLocks.get(channelId);
  if (existing) {
    return existing;
  }

  const fresh: ChannelLockEntry = {
    isLocked: false,
    lockedAt: 0,
    currentMessageId: undefined,
    serverDiscId,
    userDiscId: undefined,
    currentIsPersonaJob: false,
    typingKeepaliveTimer: null,
    followUpCount: 0,
    messageQueue: [],
    activeTurnAbortController: null,
  };
  channelLocks.set(channelId, fresh);
  return fresh;
}

export function releaseStaleChannelLockIfExpired(channelId: string, lockEntry: ChannelLockEntry): boolean {
  if (!lockEntry.isLocked || Date.now() - lockEntry.lockedAt <= CHANNEL_LOCK_TIMEOUT_MS) {
    return false;
  }

  log.warn(
    `Channel ${channelId} lock is stale (locked since ${new Date(lockEntry.lockedAt).toISOString()} for message ${lockEntry.currentMessageId}). Forcibly releasing. Previous queue length: ${lockEntry.messageQueue.length}`,
  );
  lockEntry.activeTurnAbortController?.abort();
  lockEntry.activeTurnAbortController = null;
  lockEntry.activeStreamKill?.(new Error("SDK_CALL_TIMEOUT: stale lock forcibly released"));
  lockEntry.activeStreamKill = null;
  stopDiscordTypingKeepalive(channelId, lockEntry, "stale_lock_release");
  lockEntry.isLocked = false;
  lockEntry.userDiscId = undefined;
  lockEntry.currentIsPersonaJob = false;
  lockEntry.activePersonaId = undefined;
  lockEntry.activeTriggeredPersonaIds = undefined;
  lockEntry.activeIsUserImpersonation = undefined;
  lockEntry.activeImpersonatedUserId = undefined;
  lockEntry.followUpEligible = false;
  lockEntry.isInToolCallChain = false;
  lockEntry.isCommandTriggered = false;
  discardQueuedMessages(lockEntry.messageQueue, "stale_lock_release");
  lockEntry.messageQueue = [];
  return true;
}

export function acquireChannelLockForTurn(
  lockEntry: ChannelLockEntry,
  args: {
    messageId: string;
    userDiscId: string;
    isPersonaJob: boolean;
    selectedPersonaId?: number;
    triggeredPersonaIds?: number[];
    isCommandTriggered: boolean;
  },
): void {
  lockEntry.isLocked = true;
  lockEntry.lockedAt = Date.now();
  lockEntry.currentMessageId = args.messageId;
  lockEntry.userDiscId = args.userDiscId;
  lockEntry.currentIsPersonaJob = args.isPersonaJob;
  lockEntry.activePersonaId = args.selectedPersonaId;
  lockEntry.activeTriggeredPersonaIds = args.triggeredPersonaIds;
  lockEntry.activeIsUserImpersonation = undefined;
  lockEntry.activeImpersonatedUserId = undefined;
  lockEntry.followUpEligible = false;
  lockEntry.isInToolCallChain = false;
  lockEntry.isCommandTriggered = args.isCommandTriggered;
  lockEntry.activeTurnAbortController?.abort();
  lockEntry.activeTurnAbortController = new AbortController();
}

export function setActiveChannelTurnState(
  lockEntry: ChannelLockEntry,
  args: {
    activePersonaId?: number;
    triggeredPersonaIds?: number[];
    followUpEligible: boolean;
    isUserImpersonation?: boolean;
    impersonatedUserId?: string;
  },
): void {
  lockEntry.activePersonaId = args.activePersonaId;
  lockEntry.activeTriggeredPersonaIds = args.triggeredPersonaIds;
  lockEntry.followUpEligible = args.followUpEligible;
  lockEntry.activeIsUserImpersonation = args.isUserImpersonation || undefined;
  lockEntry.activeImpersonatedUserId = args.impersonatedUserId;
}

export function resetChannelFollowUpCount(channelId: string): void {
  const lockEntry = channelLocks.get(channelId);
  if (lockEntry) {
    lockEntry.followUpCount = 0;
  }
}

export function incrementChannelFollowUpCount(channelId: string): void {
  const lockEntry = channelLocks.get(channelId);
  if (lockEntry) {
    lockEntry.followUpCount++;
  }
}

export function setChannelToolCallChainActive(lockEntry: ChannelLockEntry | undefined, isActive: boolean): void {
  if (lockEntry) {
    lockEntry.isInToolCallChain = isActive;
  }
}

export function queuePersonaJobsAtFront(args: {
  lockEntry: ChannelLockEntry;
  message: Message;
  personaJobs: Array<{ personaName: string; selectedPersonaId: number }>;
  triggeredPersonaIds: number[];
  forceReason?: boolean;
  reasoningQuery?: string;
  llmOverrideCodename?: string;
  textQuotaSource: TextQuotaSource;
  textQuotaTriggerKey: string;
  textQuotaUserDiscId: string;
  shouldSurfaceUserErrors?: boolean;
  injectedContextItems?: StructuredContextItem[];
  forcedMentions?: ForcedMention[];
}): void {
  for (let i = args.personaJobs.length - 1; i >= 0; i--) {
    const queuedPersona = args.personaJobs[i];
    args.lockEntry.messageQueue.unshift({
      message: args.message,
      isManuallyTriggered: true,
      forceReason: args.forceReason,
      reasoningQuery: args.reasoningQuery,
      llmOverrideCodename: args.llmOverrideCodename,
      selectedPersonaId: queuedPersona.selectedPersonaId,
      triggeredPersonaIds: args.triggeredPersonaIds,
      isPersonaJob: true,
      textQuotaSource: args.textQuotaSource,
      textQuotaTriggerKey: args.textQuotaTriggerKey,
      textQuotaUserDiscId: args.textQuotaUserDiscId,
      shouldSurfaceUserErrors: args.shouldSurfaceUserErrors,
      injectedContextItems: args.injectedContextItems,
      forcedMentions: args.forcedMentions,
    });
  }

  log.info(
    `Queued ${args.personaJobs.length} persona job(s) for message ${args.message.id}: ${args.personaJobs
      .map((personaJob) => personaJob.personaName)
      .join(", ")}`,
  );
}

export function queueScenePersonaJobsAtFront(args: {
  lockEntry: ChannelLockEntry;
  message: Message;
  sceneJobs: Array<{
    personaName: string;
    selectedPersonaId: number;
    sceneTurn: SceneTurnMetadata;
    manualSystemPrompt: string;
    textQuotaTriggerKey: string;
  }>;
  triggeredPersonaIds: number[];
  forceReason?: boolean;
  reasoningQuery?: string;
  llmOverrideCodename?: string;
  textQuotaSource: TextQuotaSource;
  textQuotaUserDiscId: string;
  shouldSurfaceUserErrors?: boolean;
  injectedContextItems?: StructuredContextItem[];
  forcedMentions?: ForcedMention[];
  manualTriggerInvoker?: ManualTriggerInvoker;
  manualStreamingContextOverrides?: QueuedMessage["manualStreamingContextOverrides"];
}): void {
  for (let i = args.sceneJobs.length - 1; i >= 0; i--) {
    const queuedSceneJob = args.sceneJobs[i];
    args.lockEntry.messageQueue.unshift({
      message: args.message,
      isManuallyTriggered: true,
      forceReason: args.forceReason,
      reasoningQuery: args.reasoningQuery,
      llmOverrideCodename: args.llmOverrideCodename,
      selectedPersonaId: queuedSceneJob.selectedPersonaId,
      triggeredPersonaIds: args.triggeredPersonaIds,
      isPersonaJob: true,
      textQuotaSource: args.textQuotaSource,
      textQuotaTriggerKey: queuedSceneJob.textQuotaTriggerKey,
      textQuotaUserDiscId: args.textQuotaUserDiscId,
      manualSystemPrompt: queuedSceneJob.manualSystemPrompt,
      shouldSurfaceUserErrors: args.shouldSurfaceUserErrors,
      injectedContextItems: args.injectedContextItems,
      forcedMentions: args.forcedMentions,
      manualTriggerInvoker: args.manualTriggerInvoker,
      manualStreamingContextOverrides: args.manualStreamingContextOverrides,
      sceneTurn: queuedSceneJob.sceneTurn,
    });
  }

  log.info(
    `Queued ${args.sceneJobs.length} scene persona job(s) for message ${args.message.id}: ${args.sceneJobs
      .map((sceneJob) => sceneJob.personaName)
      .join(", ")}`,
  );
}

export function queueStopResponseAtFront(args: {
  channelId: string;
  message: Message;
  llmOverrideCodename?: string;
  selectedPersonaId?: number;
  textQuotaTriggerKey: string;
  shouldSurfaceUserErrors?: boolean;
}): void {
  const lockEntry = channelLocks.get(args.channelId);
  if (!lockEntry) {
    return;
  }

  lockEntry.messageQueue.unshift({
    message: args.message,
    isManuallyTriggered: true,
    forceReason: false,
    llmOverrideCodename: args.llmOverrideCodename,
    isStopResponse: true,
    selectedPersonaId: args.selectedPersonaId,
    textQuotaSource: "system",
    textQuotaTriggerKey: args.textQuotaTriggerKey,
    shouldSurfaceUserErrors: args.shouldSurfaceUserErrors,
  });

  log.info(
    `Stop response queued after stream completion for channel ${args.channelId}. Queue size: ${lockEntry.messageQueue.length}`,
  );
}

export async function requestNaturalStopForLockedTurn(args: {
  channelId: string;
  serverDiscId: string;
  lockEntry: ChannelLockEntry;
  message: Message;
  client: Client;
}): Promise<void> {
  let clearedPersonaJobCount = 0;
  let clearedSelfTriggerCount = 0;

  try {
    const allPersonas = await getCachedAllPersonas(args.serverDiscId);
    ({ clearedPersonaJobCount, clearedSelfTriggerCount } = clearQueuedSelfReplyWork(args.channelId, allPersonas));
  } catch (error) {
    log.warn(`Failed to clear queued self-reply work for natural stop in channel ${args.channelId}`, error);
  }

  log.info(
    `Stop message detected in channel ${args.channelId} while processing message ${args.lockEntry.currentMessageId}. ` +
      `Signaling graceful stop after clearing queued self-reply work ` +
      `(personaJobs=${clearedPersonaJobCount}, selfTriggers=${clearedSelfTriggerCount}).`,
  );

  StreamOrchestrator.requestStop(args.channelId, args.message.author.id, {
    originalStopMessage: args.message,
    client: args.client,
  });

  log.info(`Stop signal sent for channel ${args.channelId}. Stop response will be generated after stream completes.`);
}

export function queueFollowUpForLockedTurn(args: {
  lockEntry: ChannelLockEntry;
  channelId: string;
  userDiscId: string;
  message: Message;
  textQuotaSource: TextQuotaSource;
  textQuotaTriggerKey: string;
  textQuotaUserDiscId: string;
  manualStreamingContextOverrides: QueuedMessage["manualStreamingContextOverrides"];
  isNaturalStopMessage: boolean;
  shouldSurfaceUserErrors?: boolean;
  isUserImpersonation?: boolean;
  impersonatedUserId?: string;
  onGenerationResult?: ChatGenerationResultHandler;
  onQueueDiscard?: QueuedMessageDiscardHandler;
}): boolean {
  if (
    !args.lockEntry.isLocked ||
    args.message.author.bot ||
    args.message.webhookId ||
    args.lockEntry.followUpEligible !== true ||
    args.lockEntry.isCommandTriggered ||
    args.lockEntry.userDiscId !== args.userDiscId ||
    args.isNaturalStopMessage ||
    args.lockEntry.followUpCount >= MAX_FOLLOW_UP_INTERRUPTS
  ) {
    return false;
  }

  if (args.lockEntry.isInToolCallChain) {
    const removedSupersededFollowUps = enqueueLatestFollowUp(args.lockEntry, args.userDiscId, {
      message: args.message,
      isManuallyTriggered: true,
      forceReason: false,
      isFollowUp: true,
      selectedPersonaId: args.lockEntry.activePersonaId,
      triggeredPersonaIds: args.lockEntry.activeTriggeredPersonaIds,
      isUserImpersonation: args.isUserImpersonation,
      impersonatedUserId: args.impersonatedUserId,
      textQuotaSource: args.textQuotaSource,
      textQuotaTriggerKey: args.textQuotaTriggerKey,
      textQuotaUserDiscId: args.textQuotaUserDiscId,
      shouldSurfaceUserErrors: args.shouldSurfaceUserErrors,
      manualStreamingContextOverrides: args.manualStreamingContextOverrides,
      onGenerationResult: args.onGenerationResult,
      onQueueDiscard: args.onQueueDiscard,
    });

    log.info(
      `Follow-up message during tool-call chain in channel ${args.channelId} from user ${args.userDiscId}. ` +
        `Queued latest without interrupt to preserve tool progress. ` +
        `Superseded follow-ups: ${removedSupersededFollowUps}. Queue size: ${args.lockEntry.messageQueue.length}`,
    );
    return true;
  }

  StreamOrchestrator.requestFollowUp(args.channelId, args.userDiscId);
  const removedSupersededFollowUps = enqueueLatestFollowUp(args.lockEntry, args.userDiscId, {
    message: args.message,
    isManuallyTriggered: true,
    forceReason: false,
    isFollowUp: true,
    selectedPersonaId: args.lockEntry.activePersonaId,
    triggeredPersonaIds: args.lockEntry.activeTriggeredPersonaIds,
    isUserImpersonation: args.isUserImpersonation,
    impersonatedUserId: args.impersonatedUserId,
    textQuotaSource: args.textQuotaSource,
    textQuotaTriggerKey: args.textQuotaTriggerKey,
    textQuotaUserDiscId: args.textQuotaUserDiscId,
    shouldSurfaceUserErrors: args.shouldSurfaceUserErrors,
    manualStreamingContextOverrides: args.manualStreamingContextOverrides,
    onGenerationResult: args.onGenerationResult,
    onQueueDiscard: args.onQueueDiscard,
  });

  log.info(
    `Follow-up message detected in channel ${args.channelId} from user ${args.userDiscId}. ` +
      `Interrupt requested. Follow-up count: ${args.lockEntry.followUpCount + 1}/${MAX_FOLLOW_UP_INTERRUPTS}. ` +
      `Superseded follow-ups: ${removedSupersededFollowUps}. Queue size: ${args.lockEntry.messageQueue.length}`,
  );
  return true;
}

export function enqueueBusyChannelMessage(args: {
  lockEntry: ChannelLockEntry;
  channelId: string;
  queuedMessage: QueuedMessage;
  simulatedAutochatCounterReset: boolean;
}): void {
  args.lockEntry.messageQueue.push(args.queuedMessage);
  log.info(
    `Channel ${args.channelId} is busy (msg ${args.lockEntry.currentMessageId}). ` +
      `Enqueued message ${args.queuedMessage.message.id}. Queue: ${args.lockEntry.messageQueue.length}. ` +
      `Tomori would reply${args.simulatedAutochatCounterReset ? " (autoch_counter simulated as 0 for this check)" : ""}.`,
  );
}

export function releaseChannelLockAndReplayQueue(args: {
  channelId: string;
  lockEntry: ChannelLockEntry;
  completedMessageId: string;
  handleStopResponse: (originalStopMessage: Message, client: Client) => Promise<void>;
  processQueuedMessage: (queuedMessage: QueuedMessage) => Promise<void>;
}): void {
  args.lockEntry.isLocked = false;
  args.lockEntry.lockedAt = 0;
  args.lockEntry.currentMessageId = undefined;
  args.lockEntry.userDiscId = undefined;
  args.lockEntry.currentIsPersonaJob = false;
  args.lockEntry.activePersonaId = undefined;
  args.lockEntry.activeIsUserImpersonation = undefined;
  args.lockEntry.activeImpersonatedUserId = undefined;
  args.lockEntry.followUpEligible = false;
  args.lockEntry.isInToolCallChain = false;
  args.lockEntry.isCommandTriggered = false;
  args.lockEntry.activeStreamKill = null;
  args.lockEntry.activeTurnAbortController?.abort();
  args.lockEntry.activeTurnAbortController = null;
  stopDiscordTypingKeepalive(args.channelId, args.lockEntry, "lock_released");
  log.info(`Channel ${args.channelId} lock released for message ${args.completedMessageId}.`);

  const stopContext = StreamOrchestrator.getAndClearStopContext(args.channelId);
  if (stopContext) {
    log.info(`Found stop context for channel ${args.channelId}. Triggering stop response after lock release.`);

    setImmediate(async () => {
      try {
        await args.handleStopResponse(stopContext.originalStopMessage, stopContext.client);
      } catch (error) {
        log.error("Failed to generate stop response after lock release:", error);
      }
    });
  }

  const nextMessageData = args.lockEntry.messageQueue.shift();
  if (!nextMessageData) {
    return;
  }

  log.info(
    `Processing next message ${nextMessageData.message.id} from queue for channel ${args.channelId}. ` +
      `Queue size: ${args.lockEntry.messageQueue.length}`,
  );

  setImmediate(() => {
    args.processQueuedMessage(nextMessageData).catch((error) => {
      log.error(`Error processing queued message ${nextMessageData.message.id}:`, error);
      discardQueuedMessages([nextMessageData], "queued_processing_failed");
    });
  });
}

export function suppressNextSelfReply(channelId: string, ttlMs = SELF_REPLY_SUPPRESSION_TTL_MS): void {
  selfReplySuppressionUntil.set(channelId, Date.now() + ttlMs);
}

export async function refreshDiscordTypingIndicator(channel: Message["channel"], reason: string): Promise<void> {
  if (!("sendTyping" in channel) || typeof channel.sendTyping !== "function") {
    return;
  }

  await channel.sendTyping().catch((error: unknown) => {
    log.warn(`Discord typing refresh failed for channel ${channel.id} (${reason})`, error);
  });
}

export function stopDiscordTypingKeepalive(channelId: string, lockEntry: ChannelLockEntry, reason: string): void {
  if (!lockEntry.typingKeepaliveTimer) {
    return;
  }

  clearInterval(lockEntry.typingKeepaliveTimer);
  lockEntry.typingKeepaliveTimer = null;
  log.info(`Discord typing keepalive stopped for channel ${channelId} (${reason}).`);
}

export async function startDiscordTypingKeepalive(
  channel: Message["channel"],
  lockEntry: ChannelLockEntry,
  messageId: string,
): Promise<void> {
  stopDiscordTypingKeepalive(channel.id, lockEntry, "restart");
  await refreshDiscordTypingIndicator(channel, "lock_scope_start");
  lockEntry.typingKeepaliveTimer = setInterval(() => {
    if (
      !lockEntry.isLocked ||
      lockEntry.currentMessageId !== messageId ||
      StreamOrchestrator.hasStopRequest(channel.id)
    ) {
      stopDiscordTypingKeepalive(channel.id, lockEntry, "lock_scope_end");
      return;
    }

    void refreshDiscordTypingIndicator(channel, "lock_scope_keepalive");
  }, DISCORD_TYPING_KEEPALIVE_INTERVAL_MS);

  log.info(
    `Discord typing keepalive started for channel ${channel.id} (message ${messageId}, interval ${DISCORD_TYPING_KEEPALIVE_INTERVAL_MS}ms).`,
  );
}

export function isChannelProcessingLocked(channelId: string): boolean {
  const lockEntry = channelLocks.get(channelId);
  if (!lockEntry?.isLocked) return false;
  if (Date.now() - lockEntry.lockedAt > CHANNEL_LOCK_TIMEOUT_MS) {
    return false;
  }
  return true;
}

/**
 * Registers (or clears) the active stream kill callback for a channel.
 * Called by toolLoop when a new SDK call starts or finishes.
 * @param channelId - Target channel
 * @param fn - Callback that aborts the HTTP request and rejects the Promise.race, or null to clear
 */
export function setChannelStreamKill(channelId: string, fn: ((reason: Error) => void) | null): void {
  const lockEntry = channelLocks.get(channelId);
  if (lockEntry) {
    lockEntry.activeStreamKill = fn;
  }
}

/**
 * Returns the turn-level AbortSignal for a channel, used to cancel tool execution.
 * @param channelId - Target channel
 */
export function getChannelTurnAbortSignal(channelId: string): AbortSignal | undefined {
  return channelLocks.get(channelId)?.activeTurnAbortController?.signal;
}

/**
 * Force-kills the active turn for a channel (used by /kill).
 * Aborts the turn-level controller (cancels tool execution) and the stream kill (cancels HTTP + unblocks Promise.race).
 * @param channelId - Target channel
 * @returns true if anything was killed
 */
export function forceKillChannelStream(channelId: string): boolean {
  const lockEntry = channelLocks.get(channelId);
  if (!lockEntry) return false;
  let killed = false;
  if (lockEntry.activeTurnAbortController) {
    lockEntry.activeTurnAbortController.abort();
    killed = true;
  }
  if (lockEntry.activeStreamKill) {
    lockEntry.activeStreamKill(new Error("SDK_CALL_TIMEOUT: killed by /kill"));
    killed = true;
  }
  return killed;
}

export function clearChannelProcessingQueue(channelId: string): number {
  const lockEntry = channelLocks.get(channelId);
  if (!lockEntry || lockEntry.messageQueue.length === 0) {
    return 0;
  }

  const clearedCount = lockEntry.messageQueue.length;
  discardQueuedMessages(lockEntry.messageQueue, "channel_queue_cleared");
  lockEntry.messageQueue = [];

  log.info(`Cleared ${clearedCount} queued message(s) for channel ${channelId}.`);

  return clearedCount;
}

export function enqueueLatestFollowUp(
  lockEntry: ChannelLockEntry,
  userDiscId: string,
  followUp: QueuedMessage,
): number {
  const previousLength = lockEntry.messageQueue.length;
  const removedMessages: QueuedMessage[] = [];
  lockEntry.messageQueue = lockEntry.messageQueue.filter((queuedMessage) => {
    const shouldRemove =
      queuedMessage.isFollowUp &&
      !queuedMessage.isPersonaJob &&
      !queuedMessage.isStopResponse &&
      queuedMessage.message.author.id === userDiscId;
    if (shouldRemove) {
      removedMessages.push(queuedMessage);
      return false;
    }
    return true;
  });
  const removedCount = previousLength - lockEntry.messageQueue.length;
  discardQueuedMessages(removedMessages, "superseded_follow_up");
  lockEntry.messageQueue.unshift(followUp);
  return removedCount;
}

export function clearQueuedSelfReplyWork(
  channelId: string,
  allPersonas: TomoriState[],
): { clearedPersonaJobCount: number; clearedSelfTriggerCount: number } {
  const lockEntry = channelLocks.get(channelId);
  if (!lockEntry || lockEntry.messageQueue.length === 0) {
    return {
      clearedPersonaJobCount: 0,
      clearedSelfTriggerCount: 0,
    };
  }

  let clearedPersonaJobCount = 0;
  let clearedSelfTriggerCount = 0;
  const removedMessages: QueuedMessage[] = [];

  lockEntry.messageQueue = lockEntry.messageQueue.filter((queuedMsg) => {
    if (queuedMsg.isPersonaJob) {
      clearedPersonaJobCount++;
      removedMessages.push(queuedMsg);
      return false;
    }

    if (!queuedMsg.isManuallyTriggered && isSelfTriggerMessage(queuedMsg.message, allPersonas)) {
      clearedSelfTriggerCount++;
      removedMessages.push(queuedMsg);
      return false;
    }

    return true;
  });

  const clearedTotal = clearedPersonaJobCount + clearedSelfTriggerCount;
  if (clearedTotal > 0) {
    log.info(
      `Cleared ${clearedTotal} queued self-reply item(s) for channel ${channelId} ` +
        `(personaJobs=${clearedPersonaJobCount}, selfTriggers=${clearedSelfTriggerCount}).`,
    );
    discardQueuedMessages(removedMessages, "self_reply_work_cleared");
  }

  return {
    clearedPersonaJobCount,
    clearedSelfTriggerCount,
  };
}

function discardQueuedMessages(messages: QueuedMessage[], reason: QueuedMessageDiscardReason): void {
  for (const queuedMessage of messages) {
    if (!queuedMessage.onQueueDiscard) {
      continue;
    }

    Promise.resolve(queuedMessage.onQueueDiscard(reason)).catch((error) => {
      log.warn(`Queued message discard callback failed for message ${queuedMessage.message.id} (${reason})`, error);
    });
  }
}
