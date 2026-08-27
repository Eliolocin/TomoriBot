import {
  buildOpenAICompatibleMessages,
  logSanitizedOpenAICompatibleRequest,
} from "@/providers/openaiCompatible/openaiCompatibleMessageBuilder";
import {
  classifyOpenAICompatibleStatus,
  createOpenAICompatibleErrorDescription,
  createOpenAICompatibleHttpError,
  normalizeOpenAICompatibleProviderError,
} from "@/providers/openaiCompatible/openaiCompatibleErrorFormatter";
import { streamOpenAICompatibleSseChunks } from "@/providers/openaiCompatible/openaiCompatibleSse";
import { logRawProviderError } from "@/utils/provider/providerErrorLogging";
import type {
  OpenAICompatibleAccumulatedToolCall,
  OpenAICompatibleStreamAdapterOptions,
  OpenAICompatibleStreamChunk,
  OpenAICompatibleStreamConfig,
  OpenAICompatibleToolCallDelta,
} from "@/providers/openaiCompatible/openaiCompatibleTypes";
import {
  buildDegradationAttempts,
  buildImageStripAttempt,
  buildTargetedAttempt,
  classifyDegradableError,
  describeDegradationTrigger,
  extractRejectedParams,
  isMultimodalRejectionError,
  MAX_TARGETED_DEGRADATION_ATTEMPTS,
  stripImageBlocksWithNotice,
  type DegradableErrorInput,
} from "@/providers/utils/paramDegradation";
import { ReasoningContentSpillGuard } from "@/providers/utils/reasoningContentSpillGuard";
import { buildProviderStopStrings } from "@/providers/utils/stopStrings";
import {
  applyAssistantPrefixCompletion,
  CONVERSATION_START_USER_TEXT,
  ensureLeadingUserTurn,
  mergeConsecutiveSameRole,
  type NormalizableMessage,
  providerRequiresAlternation,
  providerRequiresPrefixCompletion,
} from "@/providers/utils/strictChatCompat";
import { ThinkBlockContentStripper } from "@/providers/utils/thinkBlockContentStripper";
import type { FunctionCall, ThoughtLogEntry } from "@/types/provider/interfaces";
import type {
  ProcessedChunk,
  ProviderError,
  RawStreamChunk,
  StreamConfig,
  StreamContext,
} from "@/types/stream/interfaces";
import { BaseStreamAdapter } from "@/types/stream/interfaces";
import { log } from "@/utils/misc/logger";
import { isParamDisabled } from "@/utils/provider/samplingControl";
import { isProviderModelErrorMessage } from "@/utils/provider/providerErrorClassification";
import { fetchUserRemoteUrl } from "@/utils/security/userRemoteFetch";
import { localizer } from "@/utils/text/localizer";
import { truncateBeforeGenericSpeakerLine } from "@/utils/text/processors/llmOutputProcessor";
import { escapeRegExp } from "@/utils/text/processors/regexUtils";
import {
  collectRenderModifierSourceNames,
  isAllowedRenderModifierSpeakerLabel,
} from "@/utils/discord/renderModifierParser";
import { collectPersonaNameAliases } from "@/utils/discord/stream/textConfig";

/** A pre-commitment SSE error event, in the shape the shared degradation classifier accepts. */
interface OpenAICompatibleMidStreamError extends DegradableErrorInput {
  /** Provider-declared error type (e.g. `internal_server_error`), when the event carried one. */
  type?: string;
}

export class OpenAICompatibleStreamAdapter extends BaseStreamAdapter {
  private static readonly SPEAKER_GUARD_HOLDBACK_CHARS = 32;
  private static readonly STREAM_TEXT_TAIL_CHARS = 4096;
  private static readonly STREAM_TEXT_MIN_DEDUP_CHARS = 8;

  private readonly toolCallAccumulator = new Map<number, OpenAICompatibleAccumulatedToolCall>();
  private readonly thinkBlockStripper: ThinkBlockContentStripper;
  private readonly reasoningContentSpillGuard: ReasoningContentSpillGuard;
  private speakerGuardPendingTail = "";
  private streamedTextTail = "";
  private accumulatedReasoningContent = "";
  private pendingThinkBlockThoughtText = "";
  private speakerGuardEnabled = false;
  private speakerGuardAllowedSourceNames: string[] = [];

  constructor(private readonly options: OpenAICompatibleStreamAdapterOptions) {
    super({
      name: options.providerName,
      version: options.version ?? "1.0.0",
      supportsFunctionCalling: true,
    });
    this.thinkBlockStripper = new ThinkBlockContentStripper({
      loggerName: options.adapterName,
      captureThoughts: options.captureThinkBlocksAsThoughts,
    });
    this.reasoningContentSpillGuard = new ReasoningContentSpillGuard(options.adapterName);
  }

  async *startStream(config: StreamConfig, context: StreamContext): AsyncGenerator<RawStreamChunk, void, unknown> {
    const openAICompatibleConfig = config as OpenAICompatibleStreamConfig;
    log.info(`${this.options.adapterName}: Initializing OpenAI-compatible streaming`);

    this.toolCallAccumulator.clear();
    this.streamedTextTail = "";
    this.accumulatedReasoningContent = "";
    this.pendingThinkBlockThoughtText = "";
    this.reasoningContentSpillGuard.reset();
    // Build a persona-label matcher used as a fallback `</think>` closer.
    //    Matches the persona name at start-of-string or after a newline, followed by ":" or "："
    //    (half/full-width colon). Required at a line boundary to keep false positives low because
    //    mid-sentence mentions like "as Nerine would" won't trigger.
    const personaName = context.tomoriState.persona_nickname?.trim();
    const personaSpeakerLabelRegex = personaName
      ? new RegExp(`(?:^|\\n)\\s*${escapeRegExp(personaName)}\\s*[:：]`, "i")
      : null;
    this.thinkBlockStripper.reset(personaSpeakerLabelRegex);

    const apiUrl = this.options.resolveApiUrl(openAICompatibleConfig);
    if (!apiUrl) {
      throw new Error("OpenAI-compatible endpoint URL is required");
    }

    log.info(`${this.options.adapterName}: Using API URL: ${apiUrl}`);

    this.speakerGuardPendingTail = "";
    const botName = context.prefixStrippingName ?? context.personaUsername ?? context.tomoriState.persona_nickname;
    this.speakerGuardAllowedSourceNames = collectRenderModifierSourceNames(
      botName,
      collectPersonaNameAliases(context.tomoriState, botName),
    );

    // Determine whether the resolved endpoint accepts system-role messages.
    // The supportsSystemRole callback receives the final API URL and model so
    // that adapters (e.g. Custom/Chatmock) can opt out of the system role on
    // a per-request basis.  Defaults to true when not provided.
    const supportsSystemRole = this.options.supportsSystemRole?.(apiUrl, config.model ?? "") ?? true;

    let messages = await buildOpenAICompatibleMessages({
      adapterName: this.options.adapterName,
      contextItems: context.contextItems,
      currentTurnModelParts: context.currentTurnModelParts,
      functionInteractionHistory: context.functionInteractionHistory,
      seesImages: openAICompatibleConfig.seesImages ?? false,
      requiresReasoningContentReplay: this.options.requiresReasoningContentReplay,
      supportsSystemRole,
    });

    // Strict role alternation (gated): merge consecutive same-role turns and guarantee a leading
    // user turn so backends like Claude-behind-a-proxy accept the history. The column on the
    // active llms row is the source of truth (D4); providerRequiresAlternation is the request-time
    // safety net so a mis-seeded row can never emit an invalid body. Default OFF → byte-identical
    // for endpoints that do not need it.
    const enforceAlternation =
      providerRequiresAlternation(this.options.providerName) ||
      (context.tomoriState.llm?.strict_role_alternation ?? false);
    if (enforceAlternation) {
      const normalized = ensureLeadingUserTurn(
        mergeConsecutiveSameRole(messages as unknown as NormalizableMessage[]),
        () => ({ role: "user", content: CONVERSATION_START_USER_TEXT }),
      );
      messages = normalized as unknown as Array<Record<string, unknown>>;
      log.info(`${this.options.adapterName}: Applied strict role alternation (${messages.length} messages)`);
    }

    if (!config.model) {
      throw new Error("Model must be specified in config");
    }

    log.info(`${this.options.adapterName}: Using model ${config.model}`);
    if (config.tools && Array.isArray(config.tools) && config.tools.length > 0) {
      log.info(`${this.options.adapterName}: Tools:\n${JSON.stringify(config.tools, null, 2)}`);
    }

    logSanitizedOpenAICompatibleRequest(this.options.adapterName, messages);

    try {
      const disabledParams = config.disabledParams ?? [];
      const requestBody: Record<string, unknown> = {
        model: config.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      };
      if (!isParamDisabled(disabledParams, "temperature")) {
        requestBody.temperature = config.temperature;
      }

      const speakerStopPatternEnabled = context.tomoriState.config.llm_stop_speaker_pattern_enabled ?? false;
      const includePersonaSpeakerStop = speakerStopPatternEnabled && this.options.includePersonaSpeakerStop !== false;
      this.speakerGuardEnabled = speakerStopPatternEnabled && this.options.enableSpeakerGuard !== false;
      if (this.speakerGuardEnabled) {
        log.info(`${this.options.adapterName}: Speaker-boundary fallback guard enabled`);
      }
      const stopStrings = buildProviderStopStrings({
        providerName: this.options.providerName,
        model: config.model,
        personaName: context.tomoriState.persona_nickname,
        configuredStops: context.tomoriState.config.llm_stop_strings,
        includePersonaSpeakerStop,
      });
      if (stopStrings) {
        requestBody.stop = stopStrings;
      }

      if (config.maxOutputTokens !== undefined) {
        requestBody.max_tokens = config.maxOutputTokens;
      }
      if (config.tools && config.tools.length > 0) {
        requestBody.tools = config.tools;
      }
      if (openAICompatibleConfig.topP !== undefined && !isParamDisabled(disabledParams, "topP")) {
        requestBody.top_p = openAICompatibleConfig.topP;
      }
      if (openAICompatibleConfig.topK !== undefined && !isParamDisabled(disabledParams, "topK")) {
        requestBody.top_k = openAICompatibleConfig.topK;
      }
      if (
        openAICompatibleConfig.frequencyPenalty !== undefined &&
        !isParamDisabled(disabledParams, "frequencyPenalty")
      ) {
        requestBody.frequency_penalty = openAICompatibleConfig.frequencyPenalty;
      }
      if (openAICompatibleConfig.presencePenalty !== undefined && !isParamDisabled(disabledParams, "presencePenalty")) {
        requestBody.presence_penalty = openAICompatibleConfig.presencePenalty;
      }
      if (openAICompatibleConfig.repetitionPenalty !== undefined) {
        requestBody.repetition_penalty = openAICompatibleConfig.repetitionPenalty;
      }
      if (openAICompatibleConfig.minP !== undefined && !isParamDisabled(disabledParams, "minP")) {
        requestBody.min_p = openAICompatibleConfig.minP;
      }
      if (openAICompatibleConfig.logitBias !== undefined) {
        requestBody.logit_bias = openAICompatibleConfig.logitBias;
      }

      await this.options.mutateRequestBody?.({
        requestBody,
        config: openAICompatibleConfig,
        context,
      });

      // Assistant prefix-completion (gated): flag the trailing assistant prefill turn with
      // `prefix: true` so DeepSeek/Z.ai-style "continue this turn" backends extend it. Resolved
      // from the active llms column (D4) with providerRequiresPrefixCompletion as the safety net
      // that keeps built-in deepseek/zai/zaicoding ON. Runs last so it targets the final message.
      const enablePrefixCompletion =
        providerRequiresPrefixCompletion(this.options.providerName) ||
        (context.tomoriState.llm?.supports_prefix_completion ?? false);
      if (enablePrefixCompletion) {
        applyAssistantPrefixCompletion(
          requestBody,
          context.outputPrefill?.trim(),
          this.options.requiresReasoningContentReplay,
        );
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      };
      if (config.apiKey && config.apiKey.trim() !== "" && config.apiKey !== this.options.placeholderApiKey) {
        headers.Authorization = `Bearer ${config.apiKey}`;
      }

      await this.options.mutateHeaders?.({
        headers,
        config: openAICompatibleConfig,
        context,
      });

      const effectiveTemperatureLabel = "temperature" in requestBody ? String(requestBody.temperature) : "omitted";
      const effectiveTopPLabel = "top_p" in requestBody ? String(requestBody.top_p) : "omitted";
      const effectiveTopKLabel = "top_k" in requestBody ? String(requestBody.top_k) : "omitted";
      const effectiveFrequencyPenaltyLabel =
        "frequency_penalty" in requestBody ? String(requestBody.frequency_penalty) : "omitted";
      const effectivePresencePenaltyLabel =
        "presence_penalty" in requestBody ? String(requestBody.presence_penalty) : "omitted";
      const effectiveMinPLabel = "min_p" in requestBody ? String(requestBody.min_p) : "omitted";
      log.info(
        `${this.options.adapterName}: Sampling params - temp: ${effectiveTemperatureLabel}, top_p: ${effectiveTopPLabel}, top_k: ${effectiveTopKLabel}, freq_penalty: ${effectiveFrequencyPenaltyLabel}, pres_penalty: ${effectivePresencePenaltyLabel}, rep_penalty: ${openAICompatibleConfig.repetitionPenalty ?? "default"}, min_p: ${effectiveMinPLabel}, logit_bias: ${Object.keys(openAICompatibleConfig.logitBias ?? {}).length}`,
      );

      const fetchImpl = this.options.providerName === "custom" ? fetchUserRemoteUrl : fetch;
      const attempts = buildDegradationAttempts(requestBody, {
        mandatoryKeys: new Set(["model", "messages", "stream", ...(this.options.mandatoryBodyKeys ?? [])]),
        stripImages: (attemptMessages) =>
          Array.isArray(attemptMessages)
            ? stripImageBlocksWithNotice(attemptMessages as Array<Record<string, unknown>>)
            : attemptMessages,
        priorityKeys: this.options.degradationPriorityKeys,
      });
      const attemptedSerializedBodies = new Set<string>();
      let targetedAttemptCount = 0;
      const queueTargetedAttempt = (
        currentIndex: number,
        currentBody: Record<string, unknown>,
        errorMessage: string,
      ): boolean => {
        if (targetedAttemptCount >= MAX_TARGETED_DEGRADATION_ATTEMPTS) {
          return false;
        }

        const rejectedParams = extractRejectedParams(errorMessage, currentBody);
        if (rejectedParams.length === 0) return false;

        const targetedAttempt = buildTargetedAttempt(currentBody, rejectedParams);
        const serialized = JSON.stringify(targetedAttempt.body);
        if (attemptedSerializedBodies.has(serialized)) return false;

        const duplicateIndex = attempts.findIndex(
          (queuedAttempt, index) => index > currentIndex && JSON.stringify(queuedAttempt.body) === serialized,
        );
        if (duplicateIndex !== -1) {
          attempts.splice(duplicateIndex, 1);
        }
        attempts.splice(currentIndex + 1, 0, targetedAttempt);
        targetedAttemptCount += 1;
        return true;
      };
      // A multimodal rejection (e.g. vLLM without --enable-multimodal returns a
      // 500) means every payload that still carries image blocks will fail the
      // same way, so jump straight to the image-strip attempt instead of walking
      // the sampler-probe rungs first. The strip injects a text notice per
      // message so the model stays aware images were attached.
      let imageStripAttemptQueued = false;
      const queueImageStripAttempt = (
        currentIndex: number,
        currentBody: Record<string, unknown>,
        errorMessage: string,
      ): boolean => {
        if (imageStripAttemptQueued || !isMultimodalRejectionError(errorMessage)) {
          return false;
        }

        const imageStripAttempt = buildImageStripAttempt(currentBody);
        if (!imageStripAttempt) return false;

        const serialized = JSON.stringify(imageStripAttempt.body);
        if (attemptedSerializedBodies.has(serialized)) return false;

        const duplicateIndex = attempts.findIndex(
          (queuedAttempt, index) => index > currentIndex && JSON.stringify(queuedAttempt.body) === serialized,
        );
        if (duplicateIndex !== -1) {
          attempts.splice(duplicateIndex, 1);
        }
        attempts.splice(currentIndex + 1, 0, imageStripAttempt);
        imageStripAttemptQueued = true;
        return true;
      };
      let completedAttempt = false;
      attemptLoop: for (let i = 0; i < attempts.length; i++) {
        const attempt = attempts[i];
        const isRetry = i > 0;
        attemptedSerializedBodies.add(JSON.stringify(attempt.body));

        if (isRetry) {
          log.warn(
            `${this.options.adapterName}: Request retry with degraded payload: ${attempt.label} (${config.model})`,
          );
        }

        const extraClassifiers = [
          ({ statusCode, message }: DegradableErrorInput) =>
            "stream_options" in attempt.body &&
            (statusCode === 400 || statusCode === 422) &&
            message.toLowerCase().includes("stream_options"),
          ...(this.options.shouldRetryWithoutStop && "stop" in attempt.body
            ? [
                ({ statusCode, message }: DegradableErrorInput) =>
                  statusCode !== null && this.options.shouldRetryWithoutStop?.(statusCode, message) === true,
              ]
            : []),
        ];
        const currentController = new AbortController();
        const externalAbortListener = () => currentController.abort();
        if (context.abortSignal?.aborted) {
          currentController.abort();
        } else {
          context.abortSignal?.addEventListener("abort", externalAbortListener, { once: true });
        }

        try {
          const response = await fetchImpl(apiUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(attempt.body),
            signal: currentController.signal,
          });

          if (!response.ok) {
            const responseErrorText = await response.text();
            // A message that names a droppable request param is sufficient evidence on
            // its own, so retry even when the generic status/wording classifier misses.
            // `degradeOn502` stays off: a direct provider's 502 is an outage, not a
            // parameter incompatibility, and should fail fast into key/model fallback.
            const queuedTargeted = queueTargetedAttempt(i, attempt.body, responseErrorText);
            const queuedImageStrip = queueImageStripAttempt(i, attempt.body, responseErrorText);
            const degradationKind = classifyDegradableError({
              statusCode: response.status,
              message: responseErrorText,
              extraClassifiers,
              degradeOnOpaque5xx: this.options.degradeOnOpaque5xx,
            });
            if ((degradationKind || queuedTargeted || queuedImageStrip) && i < attempts.length - 1) {
              log.warn(
                `${this.options.adapterName}: Endpoint returned ${describeDegradationTrigger(degradationKind, queuedImageStrip)} on attempt '${attempt.label}', trying fallback payload`,
                { model: config.model, errorMessage: responseErrorText },
              );
              continue;
            }

            // createOpenAICompatibleHttpError collapses the payload to `message`, dropping any
            // sibling fields the endpoint used to name the real cause. Log the raw body here so a
            // terminal failure leaves the same evidence a retried one does.
            log.warn(
              `${this.options.adapterName}: Endpoint returned HTTP ${response.status} on attempt '${attempt.label}' with no remaining fallback payload`,
              { model: config.model, statusText: response.statusText, responseErrorText },
            );
            throw createOpenAICompatibleHttpError(response.status, response.statusText, responseErrorText);
          }

          let committedToAttempt = false;
          let recoveryLogged = false;
          const logRecovery = () => {
            if (!isRetry || recoveryLogged) return;
            recoveryLogged = true;
            log.warn(`${this.options.adapterName}: Request recovered after retry: ${attempt.label} (${config.model})`);
          };

          for await (const chunk of streamOpenAICompatibleSseChunks(response)) {
            const midStreamError = this.getMidStreamError(chunk);
            if (midStreamError && !committedToAttempt) {
              // An opaque mid-SSE error is the only evidence the endpoint gives, and everything
              // downstream narrows it: the classifier keeps status + message, the ProviderError
              // keeps message + type. Log the raw event so a future bisect starts from the wire.
              log.warn(`${this.options.adapterName}: Raw SSE error event before stream commitment`, {
                model: config.model,
                attemptLabel: attempt.label,
                statusCode: midStreamError.statusCode,
                errorType: midStreamError.type,
                errorMessage: midStreamError.message,
                rawError: chunk.error,
              });
              // Same rule as the fetch path: a message naming droppable params
              // justifies a retry even without a generic classifier match.
              const queuedTargeted = queueTargetedAttempt(i, attempt.body, midStreamError.message);
              const queuedImageStrip = queueImageStripAttempt(i, attempt.body, midStreamError.message);
              const degradationKind = classifyDegradableError({
                statusCode: midStreamError.statusCode,
                message: midStreamError.message,
                extraClassifiers,
                degradeOnOpaque5xx: this.options.degradeOnOpaque5xx,
              });
              if ((degradationKind || queuedTargeted || queuedImageStrip) && i < attempts.length - 1) {
                log.warn(
                  `${this.options.adapterName}: Received ${describeDegradationTrigger(degradationKind, queuedImageStrip)} before stream commitment on attempt '${attempt.label}', trying fallback payload`,
                  { model: config.model, errorMessage: midStreamError.message },
                );
                currentController.abort();
                this.resetPerAttemptState(personaSpeakerLabelRegex);
                continue attemptLoop;
              }
            }

            const sanitizedChunk = this.stripThinkBlocksFromChunkContent(chunk);
            const spillGuardedChunk = this.applyReasoningContentSpillGuard(sanitizedChunk);
            const chunksToEmit = this.splitChunkWithTextAndToolSignals(spillGuardedChunk);

            for (const chunkToEmit of chunksToEmit) {
              const deduplicatedChunk = this.deduplicateChunkTextAgainstRecentStream(chunkToEmit);
              const guardResult = this.applySpeakerBoundaryFallbackGuard(deduplicatedChunk);
              if (this.isMeaningfulCommitmentChunk(guardResult.chunk) && !committedToAttempt) {
                committedToAttempt = true;
                logRecovery();
              }

              if (this.shouldFlushSpeakerGuardTailBeforeNonTextChunk(guardResult.chunk)) {
                yield this.wrapChunk(
                  {
                    choices: [
                      {
                        index: 0,
                        delta: {
                          content: this.speakerGuardPendingTail,
                        },
                      },
                    ],
                  },
                  config.model,
                );
                this.speakerGuardPendingTail = "";
              }

              const hasMeaningfulData = Boolean(
                guardResult.chunk.error ||
                  guardResult.chunk.usage ||
                  (guardResult.chunk.choices && guardResult.chunk.choices.length > 0),
              );
              if (!hasMeaningfulData) {
                if (guardResult.stopTriggered) {
                  log.warn(
                    `${this.options.adapterName}: Speaker guard stopped generation at "${guardResult.matchedSpeaker ?? "unknown"}"`,
                  );
                  return;
                }
                continue;
              }

              yield this.wrapChunk(guardResult.chunk, config.model);

              if (guardResult.stopTriggered) {
                log.warn(
                  `${this.options.adapterName}: Speaker guard stopped generation at "${guardResult.matchedSpeaker ?? "unknown"}"`,
                );
                return;
              }
            }
          }

          logRecovery();
          completedAttempt = true;
          break;
        } finally {
          context.abortSignal?.removeEventListener("abort", externalAbortListener);
        }
      }

      if (!completedAttempt) {
        throw new Error(`${this.options.adapterName}: Request failed before completing a response stream`);
      }

      const flushedSpillChunk = this.flushReasoningContentSpillGuardToChunk(config.model);
      if (flushedSpillChunk) {
        yield flushedSpillChunk;
      }

      const flushedThinkChunk = this.flushThinkStripperToChunk(config.model);
      if (flushedThinkChunk) {
        yield flushedThinkChunk;
      }

      if (this.speakerGuardEnabled && this.speakerGuardPendingTail.length > 0) {
        yield this.wrapChunk(
          {
            choices: [
              {
                index: 0,
                delta: {
                  content: this.speakerGuardPendingTail,
                },
              },
            ],
          },
          config.model,
        );
        this.speakerGuardPendingTail = "";
      }
    } catch (error) {
      const flushedSpillChunk = this.flushReasoningContentSpillGuardToChunk(config.model);
      if (flushedSpillChunk) {
        yield flushedSpillChunk;
      }

      if (this.speakerGuardEnabled && this.speakerGuardPendingTail.length > 0) {
        yield this.wrapChunk(
          {
            choices: [
              {
                index: 0,
                delta: {
                  content: this.speakerGuardPendingTail,
                },
              },
            ],
          },
          config.model,
        );
        this.speakerGuardPendingTail = "";
      }

      const flushedThinkChunk = this.flushThinkStripperToChunk(config.model);
      if (flushedThinkChunk) {
        yield flushedThinkChunk;
      }

      yield this.createProviderErrorChunk(error, context);
    }
  }

  processChunk(chunk: RawStreamChunk): ProcessedChunk {
    const openAIChunk = chunk.data as OpenAICompatibleStreamChunk;

    if ("error" in openAIChunk && openAIChunk.error) {
      const rawMessage = openAIChunk.error.message || `${this.options.errorMessagePrefix}: provider API error`;
      const rawCode = openAIChunk.error.code;
      const rawType = openAIChunk.error.type;
      const isModelError = isProviderModelErrorMessage(rawMessage);

      // An SSE error event carries the same status semantics as a failed fetch, so route it
      // through the shared classifier. Hardcoding a non-retryable api_error here is what made a
      // transient mid-stream 500 read to the user as a permanent request error.
      const numericCode = typeof rawCode === "number" ? rawCode : Number(rawCode);
      const classification = classifyOpenAICompatibleStatus(
        Number.isFinite(numericCode) ? numericCode : null,
        rawMessage,
      );

      // An opaque message is the common case for this path, so surface the provider's own error
      // type alongside it: the details block otherwise shows nothing actionable at all.
      const message =
        rawType && !rawMessage.toLowerCase().includes(rawType.toLowerCase())
          ? `${rawMessage} (${rawType})`
          : rawMessage;
      const resolvedCode =
        classification.code !== "unknown" ? classification.code : rawCode !== undefined ? String(rawCode) : "unknown";

      return this.attachPendingThoughts({
        type: "error",
        error: {
          type: isModelError ? "model_error" : classification.type,
          message,
          code: isModelError ? (rawCode !== undefined ? `${String(rawCode)}_model` : "model_error") : resolvedCode,
          retryable: isModelError ? false : classification.retryable,
          originalError: openAIChunk.error,
        },
      });
    }

    const choice = openAIChunk.choices?.[0];
    if (!choice) {
      // With `stream_options.include_usage`, the API emits a final chunk that has
      // empty `choices` but carries `usage`. Surface that usage (the orchestrator
      // captures it from any chunk's metadata) instead of dropping it here.
      const trailingMetadata: Record<string, unknown> = {};
      if (openAIChunk.usage) {
        trailingMetadata.usage = openAIChunk.usage;
        log.info(`${this.options.adapterName}: Usage ${openAIChunk.usage.total_tokens ?? "unknown"} total tokens`);
      }
      return this.attachPendingThoughts({
        type: "text",
        content: "",
        metadata: Object.keys(trailingMetadata).length > 0 ? trailingMetadata : undefined,
      });
    }

    const metadata: Record<string, unknown> = {};
    const thoughts: ThoughtLogEntry[] = [];
    if (openAIChunk.usage) {
      metadata.usage = openAIChunk.usage;
      log.info(`${this.options.adapterName}: Usage ${openAIChunk.usage.total_tokens ?? "unknown"} total tokens`);
    }

    const reasoningContent = choice.delta?.reasoning_content;
    if (typeof reasoningContent === "string" && reasoningContent.length > 0) {
      thoughts.push({
        kind: "raw",
        content: reasoningContent,
      });
      if (this.options.preserveReasoningContent) {
        this.accumulatedReasoningContent += reasoningContent;
      }
    }
    thoughts.push(...this.consumePendingThinkBlockThoughts());

    if (choice.finish_reason === "tool_calls") {
      if (choice.delta?.tool_calls && choice.delta.tool_calls.length > 0) {
        this.accumulateToolCalls(choice.delta.tool_calls);
      }

      const accumulated = this.toolCallAccumulator.get(0);
      if (!accumulated?.functionName) {
        log.warn(`${this.options.adapterName}: finish_reason was 'tool_calls' but no tool call was accumulated`);
        return this.attachPendingThoughts({
          type: "done",
          thoughts,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        });
      }

      let parsedArgs: Record<string, unknown> = {};
      if (accumulated.functionArguments) {
        try {
          parsedArgs = JSON.parse(accumulated.functionArguments);
        } catch (parseError) {
          log.error(
            `${this.options.adapterName}: Failed to parse tool arguments "${accumulated.functionArguments}"`,
            parseError as Error,
          );
        }
      }

      const functionCall: FunctionCall = {
        name: accumulated.functionName,
        args: parsedArgs,
      };
      if (this.options.preserveReasoningContent && this.accumulatedReasoningContent.length > 0) {
        functionCall.deepseekReasoningContent = this.accumulatedReasoningContent;
        log.info(
          `${this.options.adapterName}: Preserving ${this.accumulatedReasoningContent.length} chars of reasoning_content for tool continuation`,
        );
      }

      this.toolCallAccumulator.clear();
      this.accumulatedReasoningContent = "";
      return this.attachPendingThoughts({
        type: "function_call",
        functionCall,
        thoughts,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      });
    }

    if (choice.finish_reason === "stop") {
      if (choice.delta?.content) {
        return this.attachPendingThoughts({
          type: "text",
          content: choice.delta.content,
          thoughts,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        });
      }
      return this.attachPendingThoughts({
        type: "done",
        thoughts,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      });
    }

    if (choice.finish_reason === "length") {
      log.warn(`${this.options.adapterName}: Response truncated due to max_tokens`);
      return this.attachPendingThoughts({
        type: "done",
        thoughts,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      });
    }

    if (choice.delta?.tool_calls && choice.delta.tool_calls.length > 0) {
      this.accumulateToolCalls(choice.delta.tool_calls);
      return this.attachPendingThoughts({
        type: "text",
        content: "",
        thoughts,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      });
    }

    if (choice.delta?.content) {
      return this.attachPendingThoughts({
        type: "text",
        content: choice.delta.content,
        thoughts,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      });
    }

    return this.attachPendingThoughts({
      type: "text",
      content: "",
      thoughts,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }

  handleProviderError(error: unknown): ProviderError {
    logRawProviderError(this.options.adapterName, error);
    return normalizeOpenAICompatibleProviderError(error, {
      errorMessagePrefix: this.options.errorMessagePrefix,
    });
  }

  createErrorDescription(error: ProviderError, locale: string): string | null {
    return createOpenAICompatibleErrorDescription(error, locale, {
      localeNamespace: this.options.localeNamespace,
      fallbackMessage: localizer(locale, `${this.options.localeNamespace}.unknown_default_message`),
      connectionRefusedMessage: localizer(locale, `${this.options.localeNamespace}.connection_refused`),
      appendDetailsForCodes: this.options.appendErrorDetailsForCodes,
    });
  }

  private wrapChunk(chunk: OpenAICompatibleStreamChunk, model: string): RawStreamChunk {
    return this.createRawChunk(chunk, { model });
  }

  /** Reset every mutable field that can be touched before an SSE attempt commits. */
  private resetPerAttemptState(personaSpeakerLabelRegex: RegExp | null): void {
    this.toolCallAccumulator.clear();
    this.speakerGuardPendingTail = "";
    this.streamedTextTail = "";
    this.accumulatedReasoningContent = "";
    this.pendingThinkBlockThoughtText = "";
    this.reasoningContentSpillGuard.reset();
    this.thinkBlockStripper.reset(personaSpeakerLabelRegex);
  }

  private getMidStreamError(chunk: OpenAICompatibleStreamChunk): OpenAICompatibleMidStreamError | null {
    if (!chunk.error) return null;
    const numericCode = typeof chunk.error.code === "number" ? chunk.error.code : Number(chunk.error.code);
    return {
      statusCode: Number.isFinite(numericCode) ? numericCode : null,
      message: chunk.error.message || `${this.options.errorMessagePrefix}: provider API error`,
      type: chunk.error.type,
    };
  }

  /** Text, reasoning, tool-call deltas, and usage are the stream commitment point. */
  private isMeaningfulCommitmentChunk(chunk: OpenAICompatibleStreamChunk): boolean {
    if (chunk.usage || this.pendingThinkBlockThoughtText.length > 0) return true;
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return false;
    return Boolean(
      (typeof delta.content === "string" && delta.content.length > 0) ||
        (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) ||
        (delta.tool_calls && delta.tool_calls.length > 0),
    );
  }

  private stripThinkBlocksFromChunkContent(chunk: OpenAICompatibleStreamChunk): OpenAICompatibleStreamChunk {
    if (this.options.stripThinkBlocksFromContent === false) {
      return chunk;
    }

    const firstChoice = chunk.choices?.[0];
    const content = firstChoice?.delta?.content;
    if (!firstChoice?.delta || typeof content !== "string" || content.length === 0) {
      return chunk;
    }

    const stripped = this.thinkBlockStripper.strip(content);
    if (stripped.thoughtText.length > 0) {
      this.pendingThinkBlockThoughtText += stripped.thoughtText;
    }

    if (!stripped.changed) {
      return chunk;
    }

    return {
      ...chunk,
      choices: [
        {
          ...firstChoice,
          delta: {
            ...firstChoice.delta,
            content: stripped.visibleText,
          },
        },
        ...(chunk.choices?.slice(1) ?? []),
      ],
    };
  }

  private consumePendingThinkBlockThoughts(): ThoughtLogEntry[] {
    if (!this.pendingThinkBlockThoughtText) {
      return [];
    }

    const thoughtText = this.pendingThinkBlockThoughtText;
    this.pendingThinkBlockThoughtText = "";
    return [
      {
        kind: "raw",
        content: thoughtText,
      },
    ];
  }

  private attachPendingThoughts(chunk: ProcessedChunk): ProcessedChunk {
    const pendingThoughts = this.consumePendingThinkBlockThoughts();
    const chunkThoughts = chunk.thoughts ?? [];
    const thoughts =
      chunkThoughts.length > 0 || pendingThoughts.length > 0 ? [...chunkThoughts, ...pendingThoughts] : undefined;

    if (!thoughts) {
      return chunk;
    }

    return {
      ...chunk,
      thoughts,
    };
  }

  private applyReasoningContentSpillGuard(chunk: OpenAICompatibleStreamChunk): OpenAICompatibleStreamChunk {
    const firstChoice = chunk.choices?.[0];
    if (!firstChoice?.delta) {
      return chunk;
    }

    this.reasoningContentSpillGuard.observeReasoning(firstChoice.delta.reasoning_content);

    const content = firstChoice.delta.content;
    if (typeof content !== "string" || content.length === 0) {
      return chunk;
    }

    const guardResult = this.reasoningContentSpillGuard.filterContent(content);
    if (!guardResult.changed) {
      return chunk;
    }

    const existingReasoning =
      typeof firstChoice.delta.reasoning_content === "string" ? firstChoice.delta.reasoning_content : "";
    const mergedReasoning = guardResult.spilledThought
      ? existingReasoning
        ? `${existingReasoning}${guardResult.spilledThought}`
        : guardResult.spilledThought
      : (firstChoice.delta.reasoning_content ?? undefined);

    return {
      ...chunk,
      choices: [
        {
          ...firstChoice,
          delta: {
            ...firstChoice.delta,
            content: guardResult.content,
            reasoning_content: mergedReasoning,
          },
        },
        ...(chunk.choices?.slice(1) ?? []),
      ],
    };
  }

  private flushReasoningContentSpillGuardToChunk(model: string): RawStreamChunk | null {
    const guardResult = this.reasoningContentSpillGuard.flush();
    if (!guardResult.changed || !guardResult.content) {
      return null;
    }

    return this.wrapChunk(
      {
        choices: [
          {
            index: 0,
            delta: {
              content: guardResult.content,
            },
          },
        ],
      },
      model,
    );
  }

  private flushThinkStripperToChunk(model: string): RawStreamChunk | null {
    const stripped = this.thinkBlockStripper.flush();
    if (!stripped.changed) {
      return null;
    }

    if (stripped.thoughtText.length > 0) {
      this.pendingThinkBlockThoughtText += stripped.thoughtText;
    }

    if (!stripped.visibleText && !stripped.thoughtText) {
      return null;
    }

    return this.wrapChunk(
      {
        choices: [
          {
            index: 0,
            delta: {
              content: stripped.visibleText,
            },
          },
        ],
      },
      model,
    );
  }

  private deduplicateChunkTextAgainstRecentStream(chunk: OpenAICompatibleStreamChunk): OpenAICompatibleStreamChunk {
    const firstChoice = chunk.choices?.[0];
    const content = firstChoice?.delta?.content;
    if (!firstChoice?.delta || typeof content !== "string" || content.length === 0) {
      return chunk;
    }

    const deduplicatedText = this.getTextDelta(content);
    if (deduplicatedText !== content) {
      log.info(
        `${this.options.adapterName}: Trimmed overlapping streamed text (${content.length} -> ${deduplicatedText.length})`,
      );
    }

    if (deduplicatedText.length > 0) {
      this.appendToStreamedTextTail(deduplicatedText);
    }

    if (deduplicatedText === content) {
      return chunk;
    }

    return {
      ...chunk,
      choices: [
        {
          ...firstChoice,
          delta: {
            ...firstChoice.delta,
            content: deduplicatedText,
          },
        },
        ...(chunk.choices?.slice(1) ?? []),
      ],
    };
  }

  private getTextDelta(chunkText: string): string {
    if (
      !chunkText ||
      chunkText.length < OpenAICompatibleStreamAdapter.STREAM_TEXT_MIN_DEDUP_CHARS ||
      !this.streamedTextTail
    ) {
      return chunkText;
    }

    const seenTail = this.streamedTextTail;
    if (seenTail.endsWith(chunkText)) {
      return "";
    }

    const maxOverlap = Math.min(seenTail.length, chunkText.length);
    for (let overlap = maxOverlap; overlap >= OpenAICompatibleStreamAdapter.STREAM_TEXT_MIN_DEDUP_CHARS; overlap--) {
      if (seenTail.slice(seenTail.length - overlap) === chunkText.slice(0, overlap)) {
        return chunkText.slice(overlap);
      }
    }

    return chunkText;
  }

  private appendToStreamedTextTail(text: string): void {
    if (!text) {
      return;
    }

    this.streamedTextTail += text;
    if (this.streamedTextTail.length > OpenAICompatibleStreamAdapter.STREAM_TEXT_TAIL_CHARS) {
      this.streamedTextTail = this.streamedTextTail.slice(-OpenAICompatibleStreamAdapter.STREAM_TEXT_TAIL_CHARS);
    }
  }

  private applySpeakerBoundaryFallbackGuard(chunk: OpenAICompatibleStreamChunk): {
    chunk: OpenAICompatibleStreamChunk;
    stopTriggered: boolean;
    matchedSpeaker?: string;
  } {
    if (!this.speakerGuardEnabled) {
      return { chunk, stopTriggered: false };
    }

    const firstChoice = chunk.choices?.[0];
    const content = firstChoice?.delta?.content;
    if (!firstChoice?.delta || !content) {
      return { chunk, stopTriggered: false };
    }

    const combined = `${this.speakerGuardPendingTail}${String(content)}`;
    const speakerGuardResult = truncateBeforeGenericSpeakerLine(combined, {
      isAllowedSpeakerLabel: (label) => isAllowedRenderModifierSpeakerLabel(label, this.speakerGuardAllowedSourceNames),
    });
    const transitionIndex = speakerGuardResult.stopTriggered ? speakerGuardResult.text.length : -1;

    if (transitionIndex === -1) {
      const holdback = OpenAICompatibleStreamAdapter.SPEAKER_GUARD_HOLDBACK_CHARS;
      if (combined.length <= holdback) {
        this.speakerGuardPendingTail = combined;
        firstChoice.delta.content = "";
        return { chunk, stopTriggered: false };
      }

      const emitEnd = combined.length - holdback;
      firstChoice.delta.content = combined.slice(0, emitEnd);
      this.speakerGuardPendingTail = combined.slice(emitEnd);
      return { chunk, stopTriggered: false };
    }

    firstChoice.delta.content = combined.slice(0, transitionIndex);
    this.speakerGuardPendingTail = "";
    return {
      chunk,
      stopTriggered: true,
      matchedSpeaker: speakerGuardResult.matchedSpeaker,
    };
  }

  private splitChunkWithTextAndToolSignals(chunk: OpenAICompatibleStreamChunk): OpenAICompatibleStreamChunk[] {
    const firstChoice = chunk.choices?.[0];
    if (!firstChoice?.delta) {
      return [chunk];
    }

    const content = firstChoice.delta.content;
    const hasTextContent = typeof content === "string" && content.length > 0;
    if (!hasTextContent) {
      return [chunk];
    }

    const hasToolSignal =
      Boolean(firstChoice.delta.tool_calls && firstChoice.delta.tool_calls.length > 0) ||
      firstChoice.finish_reason === "tool_calls";
    if (!hasToolSignal) {
      return [chunk];
    }

    return [
      {
        ...chunk,
        usage: undefined,
        choices: [
          {
            ...firstChoice,
            delta: {
              role: firstChoice.delta.role,
              content,
            },
            finish_reason: null,
          },
        ],
      },
      {
        ...chunk,
        choices: [
          {
            ...firstChoice,
            delta: {
              ...firstChoice.delta,
              content: undefined,
            },
          },
        ],
      },
    ];
  }

  private shouldFlushSpeakerGuardTailBeforeNonTextChunk(chunk: OpenAICompatibleStreamChunk): boolean {
    if (!this.speakerGuardEnabled || this.speakerGuardPendingTail.length === 0) {
      return false;
    }

    const firstChoice = chunk.choices?.[0];
    const content = firstChoice?.delta?.content;
    if (typeof content === "string" && content.length > 0) {
      return false;
    }

    if (chunk.error || chunk.usage) {
      return true;
    }

    if (firstChoice?.delta?.tool_calls && firstChoice.delta.tool_calls.length > 0) {
      return true;
    }

    return Boolean(firstChoice?.finish_reason);
  }

  private accumulateToolCalls(toolCalls: OpenAICompatibleToolCallDelta[] | undefined): void {
    for (const deltaToolCall of toolCalls ?? []) {
      const index = deltaToolCall.index ?? 0;
      let accumulated = this.toolCallAccumulator.get(index);
      if (!accumulated) {
        accumulated = {
          functionName: "",
          functionArguments: "",
        };
        this.toolCallAccumulator.set(index, accumulated);
      }

      if (deltaToolCall.id) {
        accumulated.id = deltaToolCall.id;
      }
      if (deltaToolCall.type) {
        accumulated.type = deltaToolCall.type;
      }
      if (deltaToolCall.function?.name) {
        accumulated.functionName += deltaToolCall.function.name;
      }
      if (deltaToolCall.function?.arguments) {
        accumulated.functionArguments += deltaToolCall.function.arguments;
      }
    }
  }
}
