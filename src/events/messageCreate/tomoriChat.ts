import { MessageType, type Client, type Message } from "discord.js";
import { evaluateChatAdmission, handleChatDisposition, normalizeChatInvocation } from "@/utils/chat/admission";
import {
  clearChannelProcessingQueue,
  isChannelProcessingLocked,
  type QueuedMessage,
  runWithChannelLock,
  suppressNextSelfReply,
} from "@/utils/chat/channelQueue";
import { buildChatTurnContext } from "@/utils/chat/contextPipelineIntent";
import { runGenerationTurn } from "@/utils/chat/generationTurn";
import type { ChatAdmissionDisposition, ChatIncoming, TomoriChatInput } from "@/utils/chat/types";
import { installUserImpersonationCompletion } from "@/utils/chat/userImpersonationCompletion";
import { enrichErrorContext, runWithErrorContext } from "@/utils/misc/errorContextStore";
import { runPostTurnEffects, shouldRetryEmptyResponse } from "@/utils/chat/postTurnEffects";
import { createChatResponseSink, handleStopResponse } from "@/utils/chat/responseEmitter";
import { shouldBotReply } from "@/utils/chat/replyDecision";
import { planChatTurns } from "@/utils/chat/turnPlanner";

export {
  clearChannelProcessingQueue,
  handleStopResponse,
  isChannelProcessingLocked,
  shouldBotReply,
  suppressNextSelfReply,
};

/**
 * Readable messageCreate chat coordinator.
 *
 * Keep Discord event registration here. Put implementation modules under
 * `src/utils/chat/` so helper files are not auto-registered as messageCreate
 * handlers by the shallow event dispatcher.
 */
export async function tomoriChat(input: TomoriChatInput): Promise<ChatAdmissionDisposition> {
  const incoming = normalizeChatInvocation(input);
  const userImpersonationCompletion = installUserImpersonationCompletion(incoming);

  const disposition = await runWithErrorContext(
    {
      source: "chat",
      userDiscId: incoming.message.author.id,
      serverDiscId: incoming.message.guildId,
      channelDiscId: incoming.message.channelId,
    },
    () => runAdmittedChatTurn(incoming),
  );

  // User impersonation owns its user-facing error UI at the slash interaction. Waiting here keeps
  // returned error/timeout statuses and queued turns attached to that interaction instead of letting
  // a non-throwing tomoriChat() result be mistaken for successful generation.
  if (userImpersonationCompletion) {
    await userImpersonationCompletion;
  }

  return disposition;
}

async function runAdmittedChatTurn(incoming: ChatIncoming): Promise<ChatAdmissionDisposition> {
  const admission = await evaluateChatAdmission(incoming);

  if (admission.disposition !== "run") {
    await handleChatDisposition(admission);
    // A queued turn is still live work: its callbacks are copied into QueuedMessage and fire when
    // that turn eventually runs (or is genuinely discarded). Treating "queued" as a discard here
    // detaches command callers from the real generation outcome.
    if (admission.disposition !== "queued") {
      await incoming.onQueueDiscard?.("admission_rejected");
    }
    return admission.disposition;
  }

  // Admission is where the Discord snowflakes become database rows, so upgrade the ambient
  // identity here: everything downstream (providers, tools, humanizer) logs with real IDs.
  enrichErrorContext({
    serverId: admission.tomoriState?.server_id,
    personaId: admission.tomoriState?.persona_id,
    userId: admission.userRow?.user_id,
    userDiscId: admission.userDiscId,
  });

  await runWithChannelLock(
    admission,
    async (lockedTurn, startTyping) => {
      const turnPlan = await planChatTurns(lockedTurn);
      let generationResultCount = 0;

      if (turnPlan.turns.length > 0) {
        await startTyping();

        for (const turn of turnPlan.turns) {
          const context = await buildChatTurnContext(turn);
          const responseSink = createChatResponseSink(context);
          const result = await runGenerationTurn(context, responseSink);
          const willRetryEmptyResponse = shouldRetryEmptyResponse(context.turn.lockedTurn.admission.incoming, result);

          await runPostTurnEffects(context, result);
          generationResultCount++;

          if (!willRetryEmptyResponse) {
            await incoming.onGenerationResult?.(result);
          }
        }
      }

      if (generationResultCount === 0) {
        await incoming.onGenerationResult?.({
          status: "skipped",
          streamResults: [],
          personaResponses: [],
        });
      }
    },
    {
      handleStopResponse,
      processQueuedMessage: (queued: QueuedMessage) =>
        tomoriChat({
          client: incoming.client,
          message: queued.message,
          isFromQueue: true,
          isManuallyTriggered: queued.isManuallyTriggered,
          forceReason: queued.forceReason,
          reasoningQuery: queued.reasoningQuery,
          llmOverrideCodename: queued.llmOverrideCodename,
          isStopResponse: queued.isStopResponse,
          reminderRecipientID: queued.reminderRecipientID,
          reminderData: queued.reminderData,
          selectedPersonaId: queued.selectedPersonaId,
          triggeredPersonaIds: queued.triggeredPersonaIds,
          isPersonaJob: queued.isPersonaJob,
          isUserImpersonation: queued.isUserImpersonation,
          impersonatedUserId: queued.impersonatedUserId,
          textQuotaSource: queued.textQuotaSource,
          textQuotaTriggerKey: queued.textQuotaTriggerKey,
          textQuotaUserDiscId: queued.textQuotaUserDiscId,
          manualSystemPrompt: queued.manualSystemPrompt,
          manualPrefill: queued.manualPrefill,
          shouldSurfaceUserErrors: queued.shouldSurfaceUserErrors,
          injectedContextItems: queued.injectedContextItems,
          forcedMentions: queued.forcedMentions,
          manualTriggerInvoker: queued.manualTriggerInvoker,
          systemTriggerIdentity: queued.systemTriggerIdentity,
          manualStreamingContextOverrides: queued.manualStreamingContextOverrides,
          sceneTurn: queued.sceneTurn,
          onGenerationResult: queued.onGenerationResult,
          onQueueDiscard: queued.onQueueDiscard,
        }).then(() => {}),
    },
  );

  return "run";
}

/** Thin event-dispatch adapter: satisfies EventFunction(client, ...args) called by the event loader. */
export default async function messageCreateHandler(client: Client, message: Message): Promise<void> {
  // Discord emits pin notifications as ChannelPinnedMessage system messages with
  // a message reference to the pinned message. That reference is context metadata,
  // not an intentional conversational reply, so it must never enter the trigger path.
  if (message.type === MessageType.ChannelPinnedMessage) {
    return;
  }

  await tomoriChat({ client, message, isFromQueue: false });
}
