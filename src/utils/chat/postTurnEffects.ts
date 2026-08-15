import { PrivacyLevel } from "@/types/db/schema";
import { incrementStmTurnCounter, storeShortTermMemory } from "@/utils/cache/shortTermMemoryCache";
import { sendStandardEmbed } from "@/utils/discord/embedHelper";
import { hasThoughtLogContent, sendAttributionOnlyEmbed, sendThoughtLogEmbed } from "@/utils/discord/thoughtLog";
import { resolveManagedChannelWebhook, sendWebhookMessageWithIdentity } from "@/utils/discord/webhook/webhookCore";
import { getChannelDeliveredWebhookIdentity } from "@/utils/discord/stream/channelDeliveryContinuity";
import { isStickerUnusableError, markStickerRejected } from "@/utils/discord/stickerAvailability";
import { ColorCode, log } from "@/utils/misc/logger";
import { getProviderDisplayName } from "@/utils/provider/providerInfoRegistry";
import { incrementTextQuota } from "@/utils/quota/textQuotaManager";
import { localizer } from "@/utils/text/localizer";
import { normalizeCustomEmojisForLlm } from "@/utils/text/processors/mentionProcessor";
import { MAX_EMPTY_RESPONSE_RETRIES } from "@/utils/discord/stream/constants";
import { suppressNextSelfReply } from "@/utils/chat/channelQueue";
import {
  buildSpeakerGuardRetryDirective,
  mergeInjectedContextItems,
  stripInjectedContextAnnotations,
} from "@/utils/chat/contextAnnotations";
import { getSelfReplyChainState, setLastRespondedPersona } from "@/utils/chat/selfReplyState";
import { textQuotaTriggerStates } from "@/utils/chat/textQuotaState";
import { statRepository } from "@/utils/db/repositories";
import { charsToTokensText, estimateContextItemsTokens, sumTurnUsage } from "@/utils/text/tokenEstimate";
import type { ChatIncoming, ChatTurnContext, GenerationTurnResult } from "@/utils/chat/types";
import { recordReunionPresence } from "@/utils/chat/reunionPresence";

/**
 * Matches a fully-resolved Discord custom emoji tag (`<:name:id>` / `<a:name:id>`).
 * Only resolved tags survive into delivered text (cleanLLMOutput converts a successful
 * `:name:` shortcode into this form and drops the ones it cannot resolve), so counting
 * these is exactly the "successful server-emoji resolve" signal. Capture 1 = name.
 */
const RESOLVED_CUSTOM_EMOJI_RE = /<a?:([A-Za-z0-9_~]+):\d+>/g;

const EMPTY_RESPONSE_RETRY_DELAY_MS = 1000;

/**
 * Runs side effects that must happen after a generation attempt finishes.
 */
export async function runPostTurnEffects(context: ChatTurnContext, result: GenerationTurnResult): Promise<void> {
  // Empty-response retries rebuild context recursively, so release or commit the
  // claim before that retry tries to acquire it again.
  await recordReunionPresence(context.reunionPresence, result);
  await sendSelectedSticker(context, result);
  await maybeScheduleEmptyResponseRetry(context, result);
  await consumeTextQuota(context, result);
  updateSelfReplyBookkeeping(context, result);
  await writeShortTermMemory(context, result);
  await emitThoughtLog(context, result);
  scheduleBoomerangFollowUp(context);
  // Fire-and-forget so stat tracking never adds latency to the response path.
  void recordUsageStats(context, result);
}

async function sendSelectedSticker(context: ChatTurnContext, result: GenerationTurnResult): Promise<void> {
  const sticker = result.selectedSticker;
  if (!sticker || result.status !== "completed") return;

  let stickerSent = false;
  // Post the sticker as whoever actually delivered the last message, so Discord groups the two
  // instead of splitting the sticker off under a different author. Crucially this reuses the
  // recorded username verbatim: which may be the decorated `Persona (sprite)` form picked by
  // the group-break alternation. Re-resolving the persona's default identity here would produce
  // a different name and force exactly the split we are avoiding.
  //
  // Not gated on `is_alter`: the main persona also delivers through a webhook whenever a sprite
  // renders. A null identity means the last delivery was an ordinary bot message, so the sticker
  // should be one too: which the bot path below handles.
  const deliveredIdentity = getChannelDeliveredWebhookIdentity(context.channel.id);

  if (deliveredIdentity) {
    const threadId = context.channel.isThread() ? context.channel.id : undefined;
    try {
      const webhook = context.responseTarget?.webhook ?? (await resolveManagedChannelWebhook(context.channel));
      if (webhook) {
        await sendWebhookMessageWithIdentity(
          webhook,
          {
            content: sticker.url,
            ...(threadId ? { threadId } : {}),
          },
          deliveredIdentity,
        );
        stickerSent = true;
        log.info(`Sent sticker URL for '${sticker.name}' via webhook as "${deliveredIdentity.username}".`);
      }
    } catch (error) {
      log.warn("Failed to send sticker URL via webhook, falling back to bot sticker send", error);
    }
  }

  if (stickerSent) {
    recordStickerDelivery(context, sticker.name);
    return;
  }

  try {
    if (context.isFromQueue) {
      await context.message.reply({ stickers: [sticker.id] });
    } else {
      if (!("send" in context.channel) || typeof context.channel.send !== "function") {
        throw new Error(`Channel ${context.channel.id} does not support sticker sends.`);
      }
      await context.channel.send({ stickers: [sticker.id] });
    }
    log.info(`Sent selected sticker '${sticker.name}' after stream.`);
    recordStickerDelivery(context, sticker.name);
  } catch (error) {
    // Discord refusing the sticker outright is permanent for that ID (lost boost tier, deleted
    // but still cached), so retiring it here is what stops the model reselecting it every turn.
    if (isStickerUnusableError(error)) {
      markStickerRejected(sticker.id);
      log.warn(`Discord rejected sticker '${sticker.name}' (${sticker.id}) as unusable; retiring it for this process.`);
      return;
    }

    log.error("Failed to send selected sticker after stream:", error, {
      serverId: context.tomoriState.server_id,
      errorType: "StickerSendError",
      metadata: { stickerId: sticker.id },
    });
  }
}

/**
 * Records `sticker_used` for a sticker Discord actually accepted, keyed by the canonical
 * resolved name (matching `server_stickers.sticker_name`, which getEmotionBreakdown joins on).
 *
 * Counting at tool-selection time instead would credit stickers the delivery path dropped:
 * a turn that never reached "completed", or a webhook send that failed and took the native
 * fallback down with it. DMs are skipped (stat_counters.server_id is a NOT NULL FK).
 */
function recordStickerDelivery(context: ChatTurnContext, stickerName: string): void {
  if (context.isDMChannel) return;
  const serverId = context.tomoriState.server_id;
  const userId = context.triggererUserId;
  if (!serverId || !userId) return;

  try {
    statRepository.recordStat({
      serverId,
      userId,
      lineageId: context.currentPersona.persona_lineage_id ?? context.tomoriState.persona_lineage_id ?? 0,
      metric: "sticker_used",
      metricKey: stickerName,
    });
  } catch (error) {
    log.warn(`Failed to record sticker_used stat for '${stickerName}'`, error);
  }
}

/**
 * Records per-turn usage stats at the single post-turn chokepoint:
 * message_sent, active_hour, model_used, tokens_in/tokens_out (estimated),
 * user_impersonation_triggered, emoji_used, sprite_shown, and sprite_emotion
 * (non-identity sprites only). Only counts turns that actually produced a persona
 * response. DMs are skipped (stat_counters.server_id is a NOT NULL FK).
 *
 * Expression metrics (emoji_used, sprite_shown, sprite_emotion) are delivery-gated:
 * they count only what Discord accepted, never what the model merely produced. Text
 * the output cleaner stripped, `<details>` scene metadata, and an abandoned attempt's
 * purged messages therefore score nothing. `sticker_used` follows the same rule from
 * its own delivery site (see recordStickerDelivery).
 *
 * Tokens prefer REAL provider usage when available: the orchestrator normalizes
 * each provider's reported usage onto `StreamResult.usage`, and these are summed
 * across the turn's stream segments (one per tool-loop request, each billed
 * separately). When no segment reports usage (e.g. NovelAI, or a provider that
 * omits it), tokens fall back to the CHARACTER-ESTIMATE ("Track A", shared with
 * `/tool estimate cost`): input from the built context, output from the response
 * text. The estimate over-counts dense languages (e.g. Japanese) and is rough;
 * real usage is billing-accurate. Either way the metric shape is identical
 * (`tokens_in`/`tokens_out` keyed by model id), so getEstimatedCost is unchanged.
 *
 * @param context - The completed turn's context (model + persona + server scope).
 * @param result  - The turn result; personaResponses carry the responding lineages.
 */
async function recordUsageStats(context: ChatTurnContext, result: GenerationTurnResult): Promise<void> {
  // Only count turns that produced a real persona response, and not DMs.
  if (result.personaResponses.length === 0 || context.isDMChannel) return;
  const serverId = context.tomoriState.server_id;
  if (!serverId) return;

  try {
    // Triggerer's internal users FK: resolved once at turn planning and
    //    carried on the context, so stat recording needs no per-turn DB lookup.
    const userId = context.triggererUserId;
    if (!userId) return;

    const hour = String(new Date().getUTCHours());
    const modelCodename = context.tomoriState.llm.llm_codename;
    const primaryLineage = context.currentPersona.persona_lineage_id ?? context.tomoriState.persona_lineage_id ?? 0;

    // Once per turn: the model used and the active hour-of-day, keyed to the
    //    answering persona. (active_hour is summed across lineages at read time,
    //    so recording it once per turn keeps the hour histogram un-inflated.)
    statRepository.recordStat({
      serverId,
      userId,
      lineageId: primaryLineage,
      metric: "model_used",
      metricKey: modelCodename,
    });
    statRepository.recordStat({ serverId, userId, lineageId: primaryLineage, metric: "active_hour", metricKey: hour });

    // Per responding persona: one message exchanged (drives favorite-persona
    //    affinity), plus that persona's output-token volume: both persona-scoped,
    //    so keyed to the response's own lineage.
    const lineages = new Set<number>();
    let estimatedOutputTokens = 0;
    for (const response of result.personaResponses) {
      lineages.add(response.personaLineageId ?? primaryLineage);

      // Output token volume (character-estimated) for this response: used
      //     only as the fallback when the provider reported no real usage (5).
      if (response.text) estimatedOutputTokens += charsToTokensText(response.text.length);
    }
    for (const lineageId of lineages) {
      statRepository.recordStat({ serverId, userId, lineageId, metric: "message_sent" });
    }

    // Custom-emoji uses that actually reached Discord, one increment per occurrence,
    //    pre-aggregated per name so repeats collapse to one UPSERT. Counted off each
    //    stream segment's accumulatedText (appended only after Discord accepts a send)
    //    rather than personaResponses[].text, which is the short-term-memory payload:
    //    that string carries the `[Scene Metadata]` block drained out of `<details>`,
    //    so emoji the model wrote there would score despite never surfacing in chat.
    //    Reading the segments also recovers text delivered before a tool call, since
    //    stream state is fresh per streamOnce and only the last segment reaches the
    //    response.
    const emojiCounts = new Map<string, number>();
    for (const stream of result.streamResults) {
      for (const match of (stream.accumulatedText ?? "").matchAll(RESOLVED_CUSTOM_EMOJI_RE)) {
        const name = match[1];
        emojiCounts.set(name, (emojiCounts.get(name) ?? 0) + 1);
      }
    }
    for (const [name, count] of emojiCounts) {
      statRepository.recordStat({
        serverId,
        userId,
        lineageId: primaryLineage,
        metric: "emoji_used",
        metricKey: name,
        delta: count,
      });
    }
    // One text_generated increment per completed turn (persona-scoped to the answering persona).
    statRepository.recordStat({ serverId, userId, lineageId: primaryLineage, metric: "text_generated" });

    // Preserve the target identity for successful user-impersonation turns.
    // user_id remains the triggering actor; metric_key is the stable Discord id of
    // the impersonated user. Keeping the answering lineage makes this queryable by
    // actor, target, server, persona, and daily bucket without changing card reads.
    if (context.isUserImpersonation && context.impersonatedUserId) {
      statRepository.recordStat({
        serverId,
        userId,
        lineageId: primaryLineage,
        metric: "user_impersonation_triggered",
        metricKey: context.impersonatedUserId,
      });
    }

    // Token volume keyed by model id, attributed to the answering persona.
    //    Prefer REAL provider usage summed across the turn's stream segments
    //    (billing-accurate); fall back to the character estimate (input from the
    //    built context, output from response text) when no segment reported usage.
    //    Cost is derived at read time from catalog pricing (getEstimatedCost), so
    //    input vs output rate applies exactly per direction either way.
    const realUsage = sumTurnUsage(result.streamResults);
    const inputTokens = realUsage ? realUsage.inputTokens : estimateContextItemsTokens(context.contextItems);
    const outputTokens = realUsage ? realUsage.outputTokens : estimatedOutputTokens;
    if (realUsage) {
      log.info(`Stats: recording real provider usage (in=${inputTokens}, out=${outputTokens}) for ${modelCodename}`);
    }
    if (inputTokens > 0) {
      statRepository.recordStat({
        serverId,
        userId,
        lineageId: primaryLineage,
        metric: "tokens_in",
        metricKey: modelCodename,
        delta: inputTokens,
      });
    }
    if (outputTokens > 0) {
      statRepository.recordStat({
        serverId,
        userId,
        lineageId: primaryLineage,
        metric: "tokens_out",
        metricKey: modelCodename,
        delta: outputTokens,
      });
    }

    // Sprite deliveries surfaced from the stream (one entry per delivered sprite
    //    message). Sprites are the answering persona's own, so key on primaryLineage.
    //    Two counts are pre-aggregated per sprite name:
    //      - sprite_shown:   every delivered sprite (identity or not): the leaderboard.
    //      - sprite_emotion: non-identity sprites only: the sprite's user-given tag is
    //        treated as an emotion (getEmotionBreakdown unions this metric directly, no
    //        classification join), so identity (DID-alter) sprites are excluded here.
    const spriteCounts = new Map<string, number>();
    const spriteEmotionCounts = new Map<string, number>();
    for (const stream of result.streamResults) {
      for (const entry of stream.spritesShown ?? []) {
        spriteCounts.set(entry.name, (spriteCounts.get(entry.name) ?? 0) + 1);
        if (!entry.isIdentity) {
          spriteEmotionCounts.set(entry.name, (spriteEmotionCounts.get(entry.name) ?? 0) + 1);
        }
      }
    }
    for (const [spriteName, count] of spriteCounts) {
      statRepository.recordStat({
        serverId,
        userId,
        lineageId: primaryLineage,
        metric: "sprite_shown",
        metricKey: spriteName,
        delta: count,
      });
    }
    for (const [spriteName, count] of spriteEmotionCounts) {
      statRepository.recordStat({
        serverId,
        userId,
        lineageId: primaryLineage,
        metric: "sprite_emotion",
        metricKey: spriteName,
        delta: count,
      });
    }
  } catch (error) {
    log.warn("Failed to record usage stats for turn", error);
  }
}

async function maybeScheduleEmptyResponseRetry(context: ChatTurnContext, result: GenerationTurnResult): Promise<void> {
  const incoming = context.turn.lockedTurn.admission.incoming;
  if (result.status !== "empty_response") {
    return;
  }

  const lastStreamResult = result.streamResults.at(-1);
  const streamResultData =
    lastStreamResult?.data && typeof lastStreamResult.data === "object"
      ? (lastStreamResult.data as Record<string, unknown>)
      : undefined;
  const terminalFinishReason =
    typeof streamResultData?.finishReason === "string" ? streamResultData.finishReason : undefined;

  if (!shouldRetryEmptyResponse(incoming, result)) {
    log.warn(`Empty response after ${MAX_EMPTY_RESPONSE_RETRIES} retries.`);

    if (context.isUserImpersonation) {
      throw new Error("User impersonation returned an empty response.");
    }

    if (!context.shouldSurfaceUserErrors) {
      log.warn(`Suppressing empty response embed for non-deliberate chat turn ${context.message.id}`);
      return;
    }

    await sendStandardEmbed(
      context.channel as Parameters<typeof sendStandardEmbed>[0],
      context.locale,
      {
        titleKey: "genai.empty_response_title",
        descriptionKey: "genai.empty_response_description",
        color: ColorCode.WARN,
        footerKey: "genai.generic_error_footer",
      },
      {
        webhook: context.responseTarget?.webhook,
        personaUsername: context.responseTarget?.personaUsername,
        personaAvatarUrl: context.responseTarget?.personaAvatarUrl,
      },
    ).catch((error) => log.warn("Failed to send empty response embed to channel", error));
    return;
  }

  log.info(
    `Empty response detected (attempt ${incoming.retryCount + 1}/${MAX_EMPTY_RESPONSE_RETRIES + 1}). ` +
      `finishReason=${terminalFinishReason ?? "unknown"}. Retrying with fresh context in ${EMPTY_RESPONSE_RETRY_DELAY_MS}ms...`,
  );
  await new Promise((resolve) => setTimeout(resolve, EMPTY_RESPONSE_RETRY_DELAY_MS));
  const emptyResponseReason =
    typeof streamResultData?.emptyResponseReason === "string" ? streamResultData.emptyResponseReason : undefined;
  const speakerGuardRetryDirective =
    emptyResponseReason === "speaker_guard"
      ? buildSpeakerGuardRetryDirective(context.currentPersona.persona_nickname ?? context.tomoriState.persona_nickname)
      : null;
  const retryInjectedContextItems = mergeInjectedContextItems(
    incoming.injectedContextItems,
    speakerGuardRetryDirective,
  );
  if (emptyResponseReason === "speaker_guard") {
    log.info(
      `Empty response retry will inject active-speaker guidance for persona "${context.currentPersona.persona_nickname ?? context.tomoriState.persona_nickname ?? "Tomori"}".`,
    );
  }

  const { tomoriChat } = await import("@/events/messageCreate/tomoriChat");
  await tomoriChat({
    client: context.client,
    message: context.message,
    isFromQueue: context.isFromQueue,
    isManuallyTriggered: true,
    forceReason: incoming.forceReason,
    reasoningQuery: incoming.reasoningQuery,
    llmOverrideCodename: incoming.llmOverrideCodename,
    isStopResponse: incoming.isStopResponse,
    retryCount: incoming.retryCount + 1,
    skipLock: true,
    reminderRecipientID: incoming.reminderRecipientID,
    reminderData: incoming.reminderData,
    selectedPersonaId: context.currentPersona.persona_id ?? incoming.selectedPersonaId,
    triggeredPersonaIds: context.turn.triggeredPersonaIds,
    isPersonaJob: context.isPersonaJob,
    isUserImpersonation: context.isUserImpersonation,
    impersonatedUserId: context.impersonatedUserId,
    textQuotaSource: incoming.textQuotaSource,
    textQuotaTriggerKey: context.textQuotaTriggerKey,
    textQuotaUserDiscId: incoming.textQuotaUserDiscId,
    manualSystemPrompt: incoming.manualSystemPrompt,
    manualPrefill: incoming.manualPrefill,
    naiContinuationPrefill: lastStreamResult?.naiContinuationPrefill,
    emptyResponseFinishReason: streamResultData?.finishReason === "length" ? "length" : undefined,
    shouldSurfaceUserErrors: context.shouldSurfaceUserErrors,
    injectedContextItems: retryInjectedContextItems,
    forcedMentions: incoming.forcedMentions,
    manualTriggerInvoker: incoming.manualTriggerInvoker,
    manualStreamingContextOverrides: incoming.manualStreamingContextOverrides,
    sceneTurn: incoming.sceneTurn,
    onGenerationResult: incoming.onGenerationResult,
    onQueueDiscard: incoming.onQueueDiscard,
  });
}

export function shouldRetryEmptyResponse(incoming: ChatIncoming, result: GenerationTurnResult): boolean {
  return result.status === "empty_response" && incoming.retryCount < MAX_EMPTY_RESPONSE_RETRIES;
}

async function consumeTextQuota(context: ChatTurnContext, result: GenerationTurnResult): Promise<void> {
  if (
    !context.shouldApplyTextQuota ||
    !context.textQuotaState ||
    context.textQuotaState.consumed ||
    result.personaResponses.length === 0
  ) {
    return;
  }

  await incrementTextQuota(context.textQuotaState.serverId, context.textQuotaState.userDiscId);
  context.textQuotaState.consumed = true;
  textQuotaTriggerStates.set(context.textQuotaTriggerKey, context.textQuotaState);
}

function updateSelfReplyBookkeeping(context: ChatTurnContext, result: GenerationTurnResult): void {
  if (result.personaResponses.length > 0 && context.currentPersona.persona_id) {
    setLastRespondedPersona(context.channel.id, context.currentPersona.persona_id);
  }

  const incoming = context.turn.lockedTurn.admission.incoming;
  if (
    result.personaResponses.length > 0 &&
    (!incoming.isManuallyTriggered || incoming.isPersonaJob) &&
    !incoming.sceneTurn &&
    !incoming.reminderRecipientID &&
    !incoming.reminderData?.self_reminder &&
    !incoming.isStopResponse
  ) {
    const triggerState = getSelfReplyChainState(context.channel.id);
    triggerState.triggerCount += 1;
    triggerState.updatedAt = Date.now();
    if (context.isSelfMessage) {
      triggerState.lastWasSelf = true;
    }
  }
}

async function writeShortTermMemory(context: ChatTurnContext, result: GenerationTurnResult): Promise<void> {
  if (
    context.isStopResponse ||
    context.simplifiedMessages.length === 0 ||
    context.turn.requestSnapshot.triggererPrivacyLevel === PrivacyLevel.FULL ||
    result.personaResponses.length === 0
  ) {
    return;
  }

  try {
    const messagesToStore = context.simplifiedMessages
      .filter((message) => message.authorType === "user" || message.authorType === "persona")
      .map((message) => ({
        role: message.authorType === "user" ? ("user" as const) : ("model" as const),
        // Strip turn-ephemeral [System: …] annotations (reply refs, metadata, reactions,
        // media notices) so durable STM holds clean conversational text only.
        content: stripInjectedContextAnnotations(normalizeCustomEmojisForLlm(message.content || "")),
        timestamp: Date.now(),
        speakerName: message.authorType === "persona" ? message.personaName || message.authorName : message.authorName,
      }))
      .filter((message) => message.content.length > 0);

    for (const response of result.personaResponses) {
      messagesToStore.push({
        role: "model",
        content: stripInjectedContextAnnotations(normalizeCustomEmojisForLlm(response.text)),
        timestamp: Date.now(),
        speakerName: response.personaName,
      });
    }

    const personaIds = [
      ...new Set(
        result.personaResponses.map((response) => response.personaId).filter((id): id is number => id !== undefined),
      ),
    ];
    for (const personaId of personaIds.length > 0 ? personaIds : [null]) {
      const response = result.personaResponses.find((entry) => entry.personaId === personaId);
      storeShortTermMemory(
        context.userDiscId,
        context.channel.id,
        messagesToStore,
        context.isDMChannel ? "DM" : context.serverDiscId,
        context.serverName,
        context.channelName,
        personaId,
        response?.personaLineageId ?? null,
        context.channel.isThread() ? context.channel.parentId : null,
      );
      // Advance the cadence counter on the live scope row (server-shared in guild, user in DM).
      // This fires once per bot-participation cycle: not per raw inbound message.
      void incrementStmTurnCounter(
        context.channel.id,
        context.isDMChannel ? null : context.serverDiscId,
        context.isDMChannel ? context.userDiscId : null,
        personaId,
      );
    }
  } catch (error) {
    log.warn("Failed to store short-term memory, but conversation completed successfully", error);
  }
}

async function emitThoughtLog(context: ChatTurnContext, result: GenerationTurnResult): Promise<void> {
  const thoughtLog = result.thoughtLog;
  const thoughtLogChannelId = context.tomoriState.config.thought_log_channel_disc_id;
  if (!thoughtLogChannelId || context.isDMChannel || isThoughtLogPrivate(context)) {
    return;
  }

  const attributionLine =
    context.textCredentialSource === "personal" && context.personalTextProvider
      ? localizer(context.locale, "genai.thought_log.personal_attribution", {
          user_mention: `<@${context.userDiscId}>`,
          provider: getProviderDisplayName(context.personalTextProvider),
        })
      : undefined;

  if (thoughtLog && hasThoughtLogContent(thoughtLog)) {
    thoughtLog.generationDurationMs = Date.now() - context.message.createdTimestamp;
    await sendThoughtLogEmbed({
      client: context.client,
      locale: context.locale,
      tomoriState: context.tomoriState,
      sourceChannel: context.channel as Parameters<typeof sendThoughtLogEmbed>[0]["sourceChannel"],
      thoughtLogChannelId,
      thoughtLog,
      owner: result.thoughtLogOwner,
      attributionLine,
    });
    return;
  }

  if (attributionLine) {
    await sendAttributionOnlyEmbed({
      client: context.client,
      locale: context.locale,
      tomoriState: context.tomoriState,
      sourceChannel: context.channel as Parameters<typeof sendAttributionOnlyEmbed>[0]["sourceChannel"],
      thoughtLogChannelId,
      attributionLine,
    });
  }
}

function isThoughtLogPrivate(context: ChatTurnContext): boolean {
  const privateIds = context.tomoriState.config.private_channel_ids ?? [];
  const parentId = context.channel.isThread() ? context.channel.parentId : null;
  return privateIds.includes(context.channel.id) || (parentId !== null && privateIds.includes(parentId));
}

function scheduleBoomerangFollowUp(context: ChatTurnContext): void {
  setImmediate(async () => {
    try {
      const { consumePendingBoomerang, buildBoomerangContext } = await import(
        "@/tools/functionCalls/crossChannelMessageTool"
      );
      const boomerang = consumePendingBoomerang(context.channel.id);
      if (!boomerang) return;

      const sourceChannel = await context.client.channels.fetch(boomerang.sourceChannelId).catch(() => null);
      if (!sourceChannel?.isTextBased()) {
        log.warn(`Boomerang: Source channel ${boomerang.sourceChannelId} not found or not text-based`);
        return;
      }

      const sourceMessages = await sourceChannel.messages.fetch({ limit: 1 }).catch(() => null);
      const sourceLastMessage = sourceMessages?.first();
      if (!sourceLastMessage) {
        log.warn(`Boomerang: No messages in source channel ${boomerang.sourceChannelId}`);
        return;
      }

      const { tomoriChat } = await import("@/events/messageCreate/tomoriChat");
      suppressNextSelfReply(sourceChannel.id);
      await tomoriChat({
        client: context.client,
        message: sourceLastMessage,
        isFromQueue: false,
        isManuallyTriggered: true,
        forceReason: false,
        isStopResponse: false,
        selectedPersonaId: boomerang.personaId,
        isPersonaJob: false,
        isUserImpersonation: boomerang.isUserImpersonation === true,
        impersonatedUserId: boomerang.impersonatedUserId,
        textQuotaSource: "system",
        shouldSurfaceUserErrors: context.shouldSurfaceUserErrors,
        injectedContextItems: buildBoomerangContext(boomerang),
        manualStreamingContextOverrides: { disableCrossChannelMessage: true },
      });
    } catch (error) {
      log.warn("Failed to check/execute boomerang, but conversation completed successfully", error);
    }
  });
}
