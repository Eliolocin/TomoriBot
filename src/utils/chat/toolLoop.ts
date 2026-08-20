import type { Sticker } from "discord.js";
import type { LLMProvider, ProviderConfig, StreamResult } from "@/types/provider/interfaces";
import type { ToolContext, ToolResult } from "@/types/tool/interfaces";
import { ToolRegistry } from "@/tools/toolRegistry";
import { statRepository } from "@/utils/db/repositories";
import { StreamOrchestrator } from "@/utils/discord/streamOrchestrator";
import { sendStandardEmbed } from "@/utils/discord/embedHelper";
import { routeHiddenToolNotice } from "@/utils/discord/toolProgressNotice";
import { isStickerSendable } from "@/utils/discord/stickerAvailability";
import { ColorCode, log } from "@/utils/misc/logger";
import { providerUsesApiFamily } from "@/utils/provider/providerInfoRegistry";
import {
  channelLocks,
  getChannelTurnAbortSignal,
  incrementChannelFollowUpCount,
  queueStopResponseAtFront,
  resetChannelFollowUpCount,
  setChannelStreamKill,
  setChannelToolCallChainActive,
} from "@/utils/chat/channelQueue";
import {
  annotateRecentMessageMetadataInContext,
  buildRevealedMessageMetadataTailDirective,
  buildTailDirectiveMessage,
} from "@/utils/chat/contextAnnotations";
import { takeEnhancedContextItem } from "@/utils/chat/pendingEnhancedContext";
import type { ChatTurnContext, GenerationTurnResult, ToolHistoryEntry } from "@/utils/chat/types";
import { redactToolParametersForStorage } from "@/utils/tools/toolParameterRedaction";

const MAX_FUNCTION_CALL_ITERATIONS = parseIntegerEnvFlag(process.env.BOT_MAX_FUNCTION_CALL_ITERATIONS, 100, 1);
const SOFT_WARN_ITERATION_THRESHOLD = 20;
const MAX_CONSECUTIVE_TOOL_ERRORS = parseIntegerEnvFlag(process.env.BOT_MAX_CONSECUTIVE_TOOL_ERRORS, 5, 1);
const NAI_TOOL_FAILURE_RETRY_THRESHOLD = parseIntegerEnvFlag(process.env.NAI_TOOL_FAILURE_RETRY_THRESHOLD, 3, 1);
const STREAM_SDK_CALL_TIMEOUT_MS = parseIntegerEnvFlag(process.env.STREAM_SDK_CALL_TIMEOUT_MS, 120000, 10000);
// After the SDK-call watchdog aborts a stalled stream, how long to wait for the abandoned
// `streamToDiscord` promise to actually settle before returning. `Promise.race` does not cancel the
// loser and `abort()` only tears down the HTTP request, so a Discord send it already dispatched can
// still be in flight; waiting for it guarantees that send is recorded in `deliveredMessageRefs`
// before the fallback path's superseded-message cleanup runs, so it cannot leak past cleanup.
const STREAM_ABANDONED_SETTLE_TIMEOUT_MS = parseIntegerEnvFlag(process.env.STREAM_ABANDONED_SETTLE_TIMEOUT_MS, 5000, 0);
const TOOL_EXECUTION_TIMEOUT_MS = parseIntegerEnvFlag(process.env.TOOL_EXECUTION_TIMEOUT_MS, 300000, 10000);
const TOOLS_SUPPRESS_FOLLOWUP_AFTER_PRETOOL_TEXT = new Set(["update_short_term_memory"]);
const TOOL_FAILURE_NOTICE_LIMIT = 1800;

export interface ToolLoopParams {
  context: ChatTurnContext;
  provider: LLMProvider;
  providerConfig: ProviderConfig;
  tomoriState: ChatTurnContext["tomoriState"];
}

export function providerIsApiFamily(
  providerName: string,
  apiFamily: Parameters<typeof providerUsesApiFamily>[1],
): boolean {
  return providerUsesApiFamily(providerName, apiFamily);
}

export async function runToolLoop(params: ToolLoopParams): Promise<GenerationTurnResult> {
  const streamResults: StreamResult[] = [];
  const functionHistory: ToolHistoryEntry[] = [];
  const accumulatedModelParts: Array<Record<string, unknown>> = [];
  let finalText = "";
  let detailsText = "";
  let consecutiveToolErrors = 0;
  let naiConsecutiveToolFailures = 0;
  let selectedStickerToSend: Sticker | null = null;
  let thoughtLog: GenerationTurnResult["thoughtLog"];

  for (let iteration = 0; iteration < MAX_FUNCTION_CALL_ITERATIONS; iteration++) {
    if (iteration === SOFT_WARN_ITERATION_THRESHOLD && params.context.shouldSurfaceUserErrors) {
      await sendStandardEmbed(
        params.context.channel as Parameters<typeof sendStandardEmbed>[0],
        params.context.locale,
        {
          color: ColorCode.WARN,
          titleKey: "genai.still_working_title",
          descriptionKey: "genai.still_working_description",
        },
      );
    }

    const streamResult = await streamOnce(params, accumulatedModelParts, functionHistory);
    streamResults.push(streamResult);
    thoughtLog = streamResult.thoughtLog ?? thoughtLog;

    switch (streamResult.status) {
      case "completed":
        resetChannelFollowUpCount(params.context.channel.id);
        finalText = streamResult.accumulatedText ?? finalText;
        detailsText = mergeDetails(detailsText, streamResult.detailsContent);
        return buildResult(
          "completed",
          params.context,
          streamResults,
          finalText,
          detailsText,
          thoughtLog,
          selectedStickerToSend ?? undefined,
        );
      case "error":
      case "timeout":
        resetChannelFollowUpCount(params.context.channel.id);
        return buildResult(streamResult.status, params.context, streamResults, finalText, detailsText, thoughtLog);
      case "empty_response":
        return buildResult("empty_response", params.context, streamResults, finalText, detailsText, thoughtLog);
      case "stopped_by_user":
        queueStopResponseIfPresent(params.context);
        resetChannelFollowUpCount(params.context.channel.id);
        // Text already delivered before the stop still has to reach short-term memory, or Tomori
        // forgets what it just said in the channel whenever a turn is cut short.
        finalText = streamResult.accumulatedText ?? finalText;
        detailsText = mergeDetails(detailsText, streamResult.detailsContent);
        return buildResult("stopped_by_user", params.context, streamResults, finalText, detailsText, thoughtLog);
      case "follow_up_interrupt":
        incrementChannelFollowUpCount(params.context.channel.id);
        return buildResult("follow_up_interrupt", params.context, streamResults, finalText, detailsText, thoughtLog);
      case "function_call": {
        detailsText = mergeDetails(detailsText, streamResult.detailsContent);
        setChannelToolCallChainActive(channelLocks.get(params.context.turn.lockedTurn.channelId), true);
        const toolOutcome = await executeToolCall(params, streamResult, iteration);
        if (toolOutcome.kind === "restart") {
          consecutiveToolErrors = 0;
          naiConsecutiveToolFailures = 0;
          continue;
        }
        if (toolOutcome.kind === "abort") {
          return buildResult(toolOutcome.status, params.context, streamResults, finalText, detailsText, thoughtLog);
        }

        functionHistory.push(toolOutcome.historyEntry);
        // Visible text emitted before the tool call now lives on that history
        // entry's assistant tool-call turn. Remove the same buffered parts from
        // the trailing prefill so providers do not receive it a second time.
        accumulatedModelParts.length = 0;
        if (toolOutcome.stickerSelection !== undefined) {
          selectedStickerToSend = toolOutcome.stickerSelection;
        }
        if (toolOutcome.success) {
          consecutiveToolErrors = 0;
          naiConsecutiveToolFailures = 0;
        } else {
          consecutiveToolErrors += 1;
          if (consecutiveToolErrors >= MAX_CONSECUTIVE_TOOL_ERRORS) {
            await emitToolErrorLoop(params.context);
            return buildResult("error", params.context, streamResults, finalText, detailsText, thoughtLog);
          }
        }

        if (toolOutcome.endTurn) {
          return buildResult(
            "completed",
            params.context,
            streamResults,
            streamResult.accumulatedText ?? finalText,
            detailsText,
            thoughtLog,
            selectedStickerToSend ?? undefined,
          );
        }

        const hasPreToolText = (streamResult.accumulatedText ?? "").trim().length > 0;
        const providerName = params.provider.getInfo().name;
        if (!toolOutcome.success && hasPreToolText && providerIsApiFamily(providerName, "novelai")) {
          naiConsecutiveToolFailures += 1;
          if (naiConsecutiveToolFailures >= NAI_TOOL_FAILURE_RETRY_THRESHOLD) {
            log.warn(
              `NovelAI GLM: Tool "${toolOutcome.functionName}" failed ${naiConsecutiveToolFailures} consecutive times after text was sent — showing error embed and ending turn`,
            );
            await emitNaiToolRetryExhausted(params.context);
            return buildResult(
              "completed",
              params.context,
              streamResults,
              streamResult.accumulatedText ?? finalText,
              detailsText,
              thoughtLog,
              selectedStickerToSend ?? undefined,
            );
          }

          params.context.streamingContext.suppressTextOutput = true;
          log.info(
            `NovelAI GLM: Tool "${toolOutcome.functionName}" failed (attempt ${naiConsecutiveToolFailures}/${NAI_TOOL_FAILURE_RETRY_THRESHOLD}) — suppressing text output for retry`,
          );
          continue;
        }

        if (
          toolOutcome.success &&
          (await shouldEndAfterPreToolText(
            params.provider,
            streamResult,
            toolOutcome.functionName,
            params.tomoriState.server_id,
          ))
        ) {
          return buildResult(
            "completed",
            params.context,
            streamResults,
            streamResult.accumulatedText ?? finalText,
            detailsText,
            thoughtLog,
            selectedStickerToSend ?? undefined,
          );
        }

        if (toolOutcome.success && hasPreToolText && providerIsApiFamily(providerName, "novelai")) {
          params.context.streamingContext.suppressTextOutput = false;
        }
        break;
      }
      default: {
        const exhaustive: never = streamResult.status;
        throw new Error(`Unhandled stream status: ${String(exhaustive)}`);
      }
    }
  }

  if (params.context.shouldSurfaceUserErrors) {
    await sendStandardEmbed(params.context.channel as Parameters<typeof sendStandardEmbed>[0], params.context.locale, {
      color: ColorCode.WARN,
      titleKey: "genai.max_iterations_title",
      descriptionKey: "genai.max_iterations_streaming_description",
      tipKeys: ["genai.tips.refresh_context"],
    });
  }
  selectedStickerToSend = null;
  return buildResult("timeout", params.context, streamResults, finalText, detailsText, thoughtLog);
}

async function streamOnce(
  params: ToolLoopParams,
  accumulatedModelParts: Array<Record<string, unknown>>,
  functionHistory: ToolHistoryEntry[],
): Promise<StreamResult> {
  const channelId = params.context.channel.id;
  const abortController = new AbortController();
  params.context.streamingContext.abortSignal = abortController.signal;
  let timeoutId: NodeJS.Timeout | null = null;

  // Unified kill: aborts the HTTP request AND rejects the Promise.race.
  // Stored on the lock entry so /kill and stale-lock release can trigger it externally.
  let killStream: ((reason: Error) => void) | null = null;

  const refreshTimeout = () => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      killStream?.(new Error("SDK_CALL_TIMEOUT: provider streamToDiscord call timed out."));
    }, STREAM_SDK_CALL_TIMEOUT_MS);
  };
  params.context.streamingContext.onStreamProgress = refreshTimeout;
  refreshTimeout();

  // Scene turns are queued (isFromQueue=true) but all share the same trigger
  // message. Replying to it would make every queued persona render "replying to"
  // the very same message, so suppress the reply reference for scene turns and let
  // them read as a free-standing back-and-forth dialogue instead.
  const isSceneTurn = Boolean(params.context.turn.lockedTurn.admission.incoming.sceneTurn);
  const replyToMessage = params.context.isFromQueue && !isSceneTurn ? params.context.message : undefined;

  // Keep a handle to the provider call so the timeout branch can await it settling. Under
  // Promise.race the loser is otherwise abandoned (never awaited); its rejection is still observed
  // by race's internal handlers, so holding this reference does not create an unhandled rejection.
  const streamPromise = params.provider.streamToDiscord(
    params.context.channel as Parameters<LLMProvider["streamToDiscord"]>[0],
    params.context.client,
    params.tomoriState,
    params.providerConfig,
    params.context.contextItems,
    accumulatedModelParts,
    params.context.emojiStrings,
    functionHistory.length > 0 ? functionHistory : undefined,
    undefined,
    replyToMessage,
    params.context.streamingContext,
    params.context.locale,
    params.context.responseTarget?.webhook,
    params.context.responseTarget?.personaAvatarUrl,
    params.context.responseTarget?.personaUsername,
    params.context.responseTarget?.prefixStrippingName,
  );

  try {
    return await Promise.race([
      streamPromise,
      new Promise<never>((_, reject) => {
        killStream = (reason: Error) => {
          abortController.abort();
          reject(reason);
        };
        setChannelStreamKill(channelId, killStream);
      }),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("SDK_CALL_TIMEOUT:")) {
      // A pending stop request (e.g. /kill) makes this a terminal stop; no fallback runs, so
      // no superseded-message cleanup will consume in-flight sends. Return immediately; settling
      // here would just make the kill wait out the abandoned stream for no benefit.
      if (StreamOrchestrator.hasStopRequest(channelId)) {
        return { status: "stopped_by_user" };
      }

      // Genuine timeout → the fallback path may run. The stream was aborted, not cancelled: wait
      // (bounded) for it to actually settle so any Discord send it had already dispatched is recorded
      // in `deliveredMessageRefs` BEFORE the fallback path's superseded-message cleanup runs. Without
      // this, a late straggler would land after cleanup and be misattributed to the surviving
      // fallback attempt; leaving the exact orphaned partial message this feature exists to remove.
      await settleAbandonedStream(streamPromise);

      if (!params.context.streamingContext.suppressUserErrors) {
        await sendStandardEmbed(
          params.context.channel as Parameters<typeof sendStandardEmbed>[0],
          params.context.locale,
          {
            titleKey: "genai.stream.inactivity_timeout_title",
            descriptionKey: "genai.stream.inactivity_timeout_description",
            color: ColorCode.WARN,
          },
        ).catch((embedError) => {
          log.warn(
            "Failed to send SDK call timeout embed",
            embedError instanceof Error ? embedError : new Error(String(embedError)),
          );
        });
      }
      return { status: "timeout", data: error };
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    params.context.streamingContext.onStreamProgress = undefined;
    setChannelStreamKill(channelId, null);
  }
}

/**
 * Waits for an aborted-but-abandoned `streamToDiscord` promise to settle, bounded by
 * {@link STREAM_ABANDONED_SETTLE_TIMEOUT_MS} so a genuinely hung send cannot block the fallback path
 * indefinitely. After `abortController.abort()` the provider generator throws promptly, so in the
 * common (stalled-provider) case this resolves almost immediately; the wait only matters when a
 * Discord send was mid-flight when the watchdog fired, and it exists solely so that send is recorded
 * before the caller proceeds. The promise's outcome is intentionally ignored.
 * @param streamPromise - The abandoned provider call to let settle.
 */
async function settleAbandonedStream(streamPromise: Promise<unknown>): Promise<void> {
  if (STREAM_ABANDONED_SETTLE_TIMEOUT_MS <= 0) {
    return;
  }
  let guardTimer: ReturnType<typeof setTimeout> | null = null;
  const settleGuard = new Promise<void>((resolve) => {
    guardTimer = setTimeout(resolve, STREAM_ABANDONED_SETTLE_TIMEOUT_MS);
  });
  try {
    await Promise.race([
      streamPromise.then(
        () => undefined,
        () => undefined,
      ),
      settleGuard,
    ]);
  } finally {
    if (guardTimer) clearTimeout(guardTimer);
  }
}

async function executeToolCall(
  params: ToolLoopParams,
  streamResult: StreamResult,
  iteration: number,
): Promise<
  | { kind: "restart" }
  | { kind: "abort"; status: GenerationTurnResult["status"] }
  | {
      kind: "history";
      functionName: string;
      success: boolean;
      endTurn: boolean;
      stickerSelection?: Sticker | null;
      historyEntry: ToolHistoryEntry;
    }
> {
  if (!streamResult.data || typeof streamResult.data !== "object" || !("name" in streamResult.data)) {
    log.error("Function call status received without function-call data", streamResult);
    return { kind: "abort", status: "error" };
  }

  const functionCall = streamResult.data as ToolHistoryEntry["functionCall"];
  const functionName = functionCall.name?.trim() ?? "";
  if (!functionName) {
    return { kind: "abort", status: "error" };
  }

  if (shouldAbortToolCallForStopRequest(params.context.channel.id)) {
    return { kind: "abort", status: "stopped_by_user" };
  }

  const turnAbortSignal = getChannelTurnAbortSignal(params.context.channel.id);
  const toolContext: ToolContext = {
    channel: params.context.channel as ToolContext["channel"],
    client: params.context.client,
    message: params.context.message,
    userId: params.context.userDiscId,
    internalUserId: params.context.personalRoutingUserId ?? undefined,
    guildId: params.context.guild?.id,
    tomoriState: params.tomoriState,
    locale: params.context.locale,
    provider: params.provider.getInfo().name,
    streamContext: params.context.streamingContext,
    webhook: params.context.responseTarget?.webhook,
    personaUsername: params.context.responseTarget?.personaUsername,
    personaAvatarUrl: params.context.responseTarget?.personaAvatarUrl,
    activePersonaId: params.context.currentPersona.persona_id ?? undefined,
    isUserImpersonation: params.context.isUserImpersonation,
    impersonatedUserId: params.context.impersonatedUserId,
    suppressProgressNotices: !params.context.shouldSurfaceUserErrors || undefined,
    contextItems: params.context.contextItems,
    messageIdMap: params.context.messageIdMap,
    showKillHint: iteration >= SOFT_WARN_ITERATION_THRESHOLD,
    abortSignal: turnAbortSignal,
  };

  // Deliberate-tool-mode allowlist enforcement. When mode is active and
  // the model attempts a tool that wasn't exposed for this turn, short-circuit
  // with a synthetic failure response (visible to the model) so it can adapt.
  const allowedNames = params.context.streamingContext.deliberateToolAllowedNames;
  const deliberateAllowedSet = allowedNames?.length ? new Set(allowedNames) : null;
  const isBlockedByDeliberateAllowlist =
    params.context.deliberateToolModeActive && deliberateAllowedSet !== null && !deliberateAllowedSet.has(functionName);

  const startedAt = Date.now();

  const killPromise: Promise<ToolResult> | null = turnAbortSignal
    ? new Promise<ToolResult>((resolve) => {
        if (turnAbortSignal.aborted) {
          resolve({ success: false, error: `Tool "${functionName}" was killed.` });
          return;
        }
        turnAbortSignal.addEventListener(
          "abort",
          () => resolve({ success: false, error: `Tool "${functionName}" was killed.` }),
          { once: true },
        );
      })
    : null;

  const toolResult = isBlockedByDeliberateAllowlist
    ? {
        success: false,
        error: `Tool "${functionName}" was not exposed for this deliberate tool mode turn.`,
        data: {
          status: "blocked_by_deliberate_tool_mode",
          functionName,
          allowedToolNames: deliberateAllowedSet ? [...deliberateAllowedSet] : [],
        },
      }
    : await Promise.race([
        ToolRegistry.executeTool(functionName, functionCall.args ?? {}, toolContext),
        new Promise<ToolResult>((resolve) =>
          setTimeout(
            () =>
              resolve({
                success: false,
                error: `Tool "${functionName}" timed out after ${TOOL_EXECUTION_TIMEOUT_MS / 1000}s.`,
              }),
            TOOL_EXECUTION_TIMEOUT_MS,
          ),
        ),
        ...(killPromise ? [killPromise] : []),
      ]);

  // If /kill fired, exit the turn immediately; don't feed the failed result back to the model.
  if (shouldAbortToolCallForStopRequest(params.context.channel.id)) {
    return { kind: "abort", status: "stopped_by_user" };
  }

  if (isBlockedByDeliberateAllowlist) {
    log.warn(
      `Deliberate tool mode blocked unexposed tool call "${functionName}" in channel ${params.context.channel.id}. Allowed: ${
        deliberateAllowedSet ? [...deliberateAllowedSet].join(", ") : ""
      }`,
    );
  }
  log.info(`Function call completed: ${functionName} (${Date.now() - startedAt}ms)`);

  // Record tool usage at the single tool-dispatch chokepoint (covers every
  // built-in / REST / MCP tool). metric_key is the tool name, so per-tool
  // breakdowns (web search, sticker, memory, reminder, …) fall out for free.
  // Only successful, non-blocked calls count. Fire-and-forget so stat tracking
  // never adds latency; DMs are skipped (server_id is a NOT NULL FK).
  if (toolResult.success && !isBlockedByDeliberateAllowlist && !params.context.isDMChannel) {
    const serverId = params.tomoriState.server_id;
    const userId = params.context.triggererUserId;
    if (serverId && userId) {
      const lineageId = params.context.currentPersona.persona_lineage_id ?? params.tomoriState.persona_lineage_id ?? 0;
      // userId is carried on the context (resolved once at turn planning), so no
      // per-tool-call DB lookup: recordStat just buffers in memory.
      // The per-sticker `sticker_used` breakdown is deliberately NOT recorded here:
      // selection only queues a sticker, and the send happens post-turn. It is recorded
      // on confirmed delivery in postTurnEffects.recordStickerDelivery instead.
      try {
        statRepository.recordStat({
          serverId,
          userId,
          lineageId,
          metric: "tool_used",
          metricKey: functionName,
        });
      } catch (statError) {
        log.warn(`Failed to record tool_used stat for ${functionName}: ${statError}`);
      }
    }
  }

  // When a tool call fails, surface a hidden thought-log notice explaining why.
  if (!toolResult.success) {
    await emitFailedToolCallThoughtLog(
      toolContext,
      functionName,
      redactToolParametersForStorage(functionName, functionCall.args ?? {}),
      toolResult,
    );
  }

  // When deliberate-tool-mode admitted the tool via a specific trigger,
  // post a hidden notice (thought-log only) explaining why it fired.
  const deliberateToolTriggerMatch = params.context.deliberateToolTriggerMatchByToolName.get(functionName);
  if (params.context.deliberateToolModeActive && deliberateToolTriggerMatch && !isBlockedByDeliberateAllowlist) {
    const safeTrigger = deliberateToolTriggerMatch.trigger.replace(/`/g, "'");
    await routeHiddenToolNotice(
      toolContext,
      {
        color: ColorCode.INFO,
        titleKey: "genai.thought_log.title",
        description:
          `Tool \`${functionName}\` was used after deliberate tool mode exposed it.\n` +
          `Trigger: \`${safeTrigger}\`\n` +
          `Source: ${deliberateToolTriggerMatch.source}`,
      },
      "Deliberate tool trigger log",
    );
  }

  if (toolResult.success && handleEnhancedContextRestart(params, toolResult.data)) {
    return { kind: "restart" };
  }

  if (functionName === "update_short_term_memory" && toolResult.success) {
    params.context.streamingContext.disableShortTermMemoryUpdate = true;
    log.info("Short-term memory updated — disabling further STM calls for this turn");
  }

  let stickerSelection: Sticker | null | undefined;
  if (functionName === "select_sticker_for_response") {
    const stickerData = toolResult.data as { status?: string; sticker_id?: string; sticker_name?: string } | undefined;
    if (stickerData?.status === "sticker_selected_successfully") {
      const resolved = params.context.guild?.stickers.cache.get(stickerData.sticker_id ?? "") ?? null;
      stickerSelection = resolved && isStickerSendable(resolved) ? resolved : null;
      if (stickerSelection) {
        log.success(`Sticker '${stickerData.sticker_name}' selected for sending`);
      } else {
        log.warn(`Sticker '${stickerData.sticker_name}' is no longer sendable, dropping selection`);
      }
    } else {
      stickerSelection = null;
    }
  }

  const functionResponse = toolResult.success
    ? ((toolResult.data as Record<string, unknown>) ?? { status: "completed" })
    : {
        status: "tool_execution_failed",
        reason: toolResult.message || toolResult.error || "Tool execution failed without specific error",
        tool_name: functionName,
      };

  // Preserve any visible text streamed before this tool call so the follow-up
  // provider call knows it was already sent to Discord and doesn't repeat it.
  const preToolCallTextParts = buildPreToolCallTextParts(streamResult);
  if (preToolCallTextParts) {
    log.info(
      `Preserving ${preToolCallTextParts.length} pre-tool-call text part(s) in function history to prevent repetition`,
    );
  }

  return {
    kind: "history",
    functionName,
    success: toolResult.success,
    endTurn: toolResult.endTurn === true,
    stickerSelection,
    historyEntry: {
      functionCall,
      functionResponse: {
        functionResponse: {
          name: functionName,
          response: { result: functionResponse },
        },
      },
      imageMetadata: toolResult.imageMetadata,
      preToolCallTextParts,
    },
  };
}

/**
 * Builds the pre-tool-call text parts for a function-call history entry.
 *
 * `streamResult.accumulatedText` is this stream iteration's visible text at the
 * function-call boundary (each iteration gets a fresh stream state, so earlier
 * iterations' text is carried by their own history entries). Provider adapters
 * merge these parts into the synthetic assistant tool-call turn on the next call.
 */
function buildPreToolCallTextParts(streamResult: StreamResult): Array<Record<string, unknown>> | undefined {
  const text = streamResult.accumulatedText;
  return text?.trim() ? [{ type: "text", text }] : undefined;
}

async function emitFailedToolCallThoughtLog(
  context: ToolContext,
  functionName: string,
  args: Record<string, unknown>,
  toolResult: ToolResult,
): Promise<void> {
  const noticeContext: ToolContext = {
    ...context,
    suppressProgressNotices: false,
  };

  await routeHiddenToolNotice(
    noticeContext,
    {
      color: ColorCode.ERROR,
      titleKey: "genai.thought_log.title",
      description: buildFailedToolCallDescription(functionName, args, toolResult),
    },
    "Failed tool call thought-log notice",
  );
}

function buildFailedToolCallDescription(
  functionName: string,
  args: Record<string, unknown>,
  toolResult: ToolResult,
): string {
  const reason = toolResult.message || toolResult.error || "Tool execution failed without specific error.";
  const details = safeStringifyToolFailureDetails({
    args,
    data: toolResult.data,
  });
  const lines = [`Tool \`${functionName}\` failed.`, `Reason: ${reason}`];
  if (details) {
    lines.push("", "Details:", codeBlock(truncateToolFailureNotice(details)));
  }

  return lines.join("\n");
}

function safeStringifyToolFailureDetails(value: unknown): string | undefined {
  try {
    const json = JSON.stringify(value, null, 2);
    return json === undefined || json === "{}" ? undefined : json;
  } catch {
    return String(value);
  }
}

function truncateToolFailureNotice(value: string): string {
  if (value.length <= TOOL_FAILURE_NOTICE_LIMIT) {
    return value;
  }
  return `${value.slice(0, TOOL_FAILURE_NOTICE_LIMIT - 3)}...`;
}

function codeBlock(value: string): string {
  return `\`\`\`json\n${value.replace(/```/g, "`\u200b``")}\n\`\`\``;
}

function handleEnhancedContextRestart(params: ToolLoopParams, data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const record = data as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (!type.startsWith("context_restart_")) return false;

  if (type.includes("message_metadata")) {
    const { annotatedCount, patchedReplyReferenceCount } = annotateRecentMessageMetadataInContext({
      simplifiedMessages: params.context.simplifiedMessages,
      contextSegments: params.context.contextItems,
      messageIdMap: params.context.messageIdMap,
    });
    const metadataActionHint = buildTailDirectiveMessage(buildRevealedMessageMetadataTailDirective());
    if (metadataActionHint) {
      params.context.contextItems.push(metadataActionHint);
    }
    log.info(
      `Recent message metadata reveal annotated ${annotatedCount} message(s) and patched ${patchedReplyReferenceCount} reply reference(s).`,
    );
  }

  const enhancedContextItem = resolveEnhancedContextItem(record, type);
  if (enhancedContextItem && typeof enhancedContextItem === "object") {
    params.context.contextItems.push(enhancedContextItem as ChatTurnContext["contextItems"][number]);
  }
  if (type.includes("youtube")) params.context.streamingContext.disableYouTubeProcessing = true;
  if (type.includes("image")) params.context.streamingContext.disableProfilePictureProcessing = true;
  if (type.includes("gif")) params.context.streamingContext.disableGifProcessing = true;
  if (type.includes("message_metadata")) params.context.streamingContext.disableMessageMetadataContext = true;
  log.info(`Tool requested enhanced-context restart: ${type}`);
  return true;
}

/**
 * Resolves the enrichment payload from either transport: inline `enhanced_context_item`,
 * or `pending_context_key` for tools whose payload is too heavy to sit in `ToolResult.data`.
 */
function resolveEnhancedContextItem(record: Record<string, unknown>, type: string): unknown {
  const pendingContextKey = typeof record.pending_context_key === "string" ? record.pending_context_key : undefined;
  if (!pendingContextKey) return record.enhanced_context_item;

  const stashedItem = takeEnhancedContextItem(pendingContextKey);
  if (!stashedItem) {
    log.warn(
      `Enhanced-context restart '${type}' referenced pending key ${pendingContextKey}, but no payload was stashed. The enriched media will be missing from this turn.`,
    );
  }
  return stashedItem ?? record.enhanced_context_item;
}

async function shouldEndAfterPreToolText(
  provider: LLMProvider,
  streamResult: StreamResult,
  functionName: string,
  serverId: number | undefined,
): Promise<boolean> {
  const hasPreToolText = (streamResult.accumulatedText ?? "").trim().length > 0;
  if (!hasPreToolText) return false;
  const providerName = provider.getInfo().name;
  const applies =
    providerIsApiFamily(providerName, "novelai") || TOOLS_SUPPRESS_FOLLOWUP_AFTER_PRETOOL_TEXT.has(functionName);
  if (!applies) return false;
  if (functionName === "update_short_term_memory") return true;
  return !(await ToolRegistry.requiresFollowUp(functionName, providerName, serverId));
}

async function emitNaiToolRetryExhausted(context: ChatTurnContext): Promise<void> {
  await sendStandardEmbed(
    context.channel as Parameters<typeof sendStandardEmbed>[0],
    context.locale,
    {
      color: ColorCode.ERROR,
      titleKey: "genai.nai_tool_retry_exhausted_title",
      descriptionKey: "genai.nai_tool_retry_exhausted_description",
    },
    {
      webhook: context.responseTarget?.webhook,
      personaUsername: context.responseTarget?.personaUsername,
      personaAvatarUrl: context.responseTarget?.personaAvatarUrl,
    },
  );
}

function shouldAbortToolCallForStopRequest(channelId: string): boolean {
  if (!StreamOrchestrator.hasStopRequest(channelId)) return false;
  if (!StreamOrchestrator.isFollowUpRequest(channelId)) return true;

  log.info(
    `Follow-up request found during tool execution for channel ${channelId}. Clearing interrupt to preserve tool chain progress — follow-up is queued.`,
  );
  StreamOrchestrator.clearStopRequest(channelId);
  return false;
}

async function emitToolErrorLoop(context: ChatTurnContext): Promise<void> {
  if (context.isUserImpersonation) {
    throw new Error("User impersonation aborted: model failed too many tool calls in a row.");
  }
  if (!context.shouldSurfaceUserErrors) {
    log.warn(`Suppressing tool error loop embed for non-deliberate chat turn ${context.message.id}`);
    return;
  }
  await sendStandardEmbed(
    context.channel as Parameters<typeof sendStandardEmbed>[0],
    context.locale,
    {
      color: ColorCode.ERROR,
      titleKey: "genai.tool_error_loop_title",
      descriptionKey: "genai.tool_error_loop_description",
      tipKeys: ["genai.tips.refresh_context"],
    },
    {
      webhook: context.responseTarget?.webhook,
      personaUsername: context.responseTarget?.personaUsername,
      personaAvatarUrl: context.responseTarget?.personaAvatarUrl,
    },
  );
}

function queueStopResponseIfPresent(context: ChatTurnContext): void {
  const stopContext = StreamOrchestrator.getAndClearStopContext(context.channel.id);
  if (!stopContext) {
    StreamOrchestrator.clearStopRequest(context.channel.id);
    return;
  }

  queueStopResponseAtFront({
    channelId: context.channel.id,
    message: stopContext.originalStopMessage,
    llmOverrideCodename: context.turn.lockedTurn.admission.incoming.llmOverrideCodename,
    selectedPersonaId: context.currentPersona.persona_id ?? undefined,
    textQuotaTriggerKey: context.textQuotaTriggerKey,
    shouldSurfaceUserErrors: true,
  });
}

function buildResult(
  status: GenerationTurnResult["status"],
  context: ChatTurnContext,
  streamResults: StreamResult[],
  responseText: string,
  detailsText: string,
  thoughtLog: GenerationTurnResult["thoughtLog"],
  selectedSticker?: Sticker,
): GenerationTurnResult {
  const text = detailsText.trim()
    ? `${responseText.trim()}\n\n[Scene Metadata]\n${detailsText.trim()}`
    : responseText.trim();
  return {
    status,
    streamResults,
    personaResponses:
      text.length > 0
        ? [
            {
              personaName: context.currentPersona.persona_nickname,
              text,
              personaId: context.currentPersona.persona_id,
              personaLineageId: context.currentPersona.persona_lineage_id,
            },
          ]
        : [],
    thoughtLog,
    thoughtLogOwner: thoughtLog ? resolveThoughtLogOwner(context) : undefined,
    selectedSticker,
  };
}

function resolveThoughtLogOwner(context: ChatTurnContext): GenerationTurnResult["thoughtLogOwner"] {
  if (context.isUserImpersonation) {
    return {
      type: "user_impersonation",
      username: context.responseTarget?.personaUsername ?? "User",
      avatarUrl: context.responseTarget?.personaAvatarUrl,
    };
  }
  return context.currentPersona.is_alter ? { type: "persona", persona: context.currentPersona } : { type: "default" };
}

function mergeDetails(existing: string, incoming: string | undefined): string {
  if (!incoming?.trim()) return existing;
  return existing ? `${existing}\n\n${incoming}` : incoming;
}

function parseIntegerEnvFlag(value: string | undefined, defaultValue: number, minimum: number): number {
  if (typeof value !== "string") return defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return defaultValue;
  return Math.max(minimum, parsed);
}
