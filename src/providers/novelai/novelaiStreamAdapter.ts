/**
 * NovelAI-specific streaming adapter
 *
 * This adapter implements the StreamProvider interface for NovelAI's API,
 * handling the unique requirements of NovelAI's text-based prompt format.
 *
 * Key responsibilities:
 * - Convert structured context to NovelAI's flat text prompt format
 * - Handle SSE streaming from NovelAI API
 * - Convert NovelAI chunks to normalized ProcessedChunk format
 * - Map NovelAI errors to normalized ProviderError type
 *
 * NovelAI Specifics:
 * - Prompt-based tool calling for GLM-4.6 (manual parsing of <tool_call> blocks)
 * - Uses flat text prompts with "{username}: {message}\n" format
 * - Uses `prefix` parameter to force bot name at start of generation
 * - Uses `stop_sequences` to prevent multi-speaker generation
 */

import type { FunctionCall, ThoughtLogEntry } from "@/types/provider/interfaces";
import { ContextItemTag, type StructuredContextItem } from "@/types/misc/context";
import { log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";
import { escapeRegExp } from "@/utils/text/processors/regexUtils";
import { findMarkdownCodeRanges } from "@/utils/text/processors/llmOutputProcessor";
import { BaseStreamAdapter } from "@/types/stream/interfaces";
import type {
  ProcessedChunk,
  ProviderError,
  RawStreamChunk,
  StreamConfig,
  StreamContext,
} from "@/types/stream/interfaces";
import {
  novelaiGenerateStream,
  getParametersForModel,
  isNovelAIApiKeyError,
  isNovelAICreditsError,
  isNovelAIRateLimitError,
  usesOpenAIEndpoint,
  type NovelAIGenerationRequest,
  type NovelAIStreamChunk,
  type NovelAIParameters,
} from "./novelaiService";
import { buildProviderStopStrings } from "@/providers/utils/stopStrings";
import { isParamDisabled } from "@/utils/provider/samplingControl";
import { getNovelAiThinkingDirective } from "@/utils/provider/thinkingControl";

/**
 * Whether to include the bot's persona name as a "{char}:" prefix in GLM 4.6 assistant turns.
 *
 * When ON (default): bot name is preserved in sample dialogue and conversation history turns,
 * mirroring how other providers (Google, OpenRouter) format their context. The generation prompt
 * also appends "{botName}:" after <think></think> as a true prefill, steering the model to respond
 * in the persona's voice from the very first token.
 *
 * When OFF: bot name is stripped from assistant turns: <|assistant|> is sufficient as the
 * structural signal. The original motivation for stripping was garbled name artifacts
 * (e.g., "Tomo", "Tomorleasing"), but keeping the prefix has shown better persona consistency.
 *
 * Only affects GLM 4.6; Kayra already appends the bot name as a prefill at prompt assembly.
 */
const NAI_GLM_CHAR_PREFIX_ENABLED = (process.env.NAI_GLM_CHAR_PREFIX_ENABLED ?? "true").toLowerCase() === "true";

/**
 * Characters-per-token ratio used to estimate GLM 4.6 input token count from prompt length.
 *
 * GLM 4.6 actual tokenization runs ~2.2-2.5 chars/token, far below the 4 chars/token
 * assumed by contextTruncator. This value is used by the dynamic max_length cap to
 * re-estimate token usage from the final assembled prompt (which includes formatting
 * overhead not present in the raw context items seen by the truncator).
 *
 * Configured via NAI_GLM_CHARS_PER_TOKEN env var (default: "2.5").
 * Lower values = more conservative, more clamping; higher values = less clamping.
 */
const NAI_GLM_CHARS_PER_TOKEN = Number.parseFloat(process.env.NAI_GLM_CHARS_PER_TOKEN ?? "2.5");

/**
 * Hard context window ceiling (input + output tokens combined) for GLM 4.6.
 *
 * Matches the real NovelAI API limit. The dynamic max_length cap uses this to compute
 * how many output tokens remain after accounting for estimated input token usage.
 *
 * Configured via NAI_GLM_CONTEXT_LIMIT env var (default: "12288").
 */
/**
 * Characters-per-token ratio for Kayra/Erato context estimation.
 *
 * Kayra tokenizes at ~3.0-3.5 chars/token, denser than the 4 chars/token assumed by
 * contextTruncator. This drives the secondary dynamic max_length cap below.
 *
 * Configured via NAI_KAYRA_CHARS_PER_TOKEN env var (default: "3.5").
 */
const NAI_KAYRA_CHARS_PER_TOKEN = Number.parseFloat(process.env.NAI_KAYRA_CHARS_PER_TOKEN ?? "3.5");

/**
 * Hard context window ceiling (input + output tokens combined) for Kayra/Erato.
 *
 * Matches the user's NovelAI subscription tier limit:
 *   Tablet: 4096, Scroll: 8192, Opus: varies
 *
 * Configured via NAI_KAYRA_CONTEXT_LIMIT env var (default: "8192" for Scroll tier).
 * Tablet users must set this to 4096. Used by the dynamic max_length cap below.
 */
const NAI_KAYRA_CONTEXT_LIMIT = Number.parseInt(process.env.NAI_KAYRA_CONTEXT_LIMIT ?? "8192", 10);

const NAI_GLM_CONTEXT_LIMIT = Number.parseInt(process.env.NAI_GLM_CONTEXT_LIMIT ?? "12288", 10);

/**
 * Extracts non-schema preset parameters from a raw preset parameters record.
 * Removes the four fields that are handled via split server config columns
 * (temperature, top_k, top_p, min_p) so they don't double-apply.
 * The remaining fields (order, tail_free_sampling, phrase_rep_pen, mirostat_*,
 * typical_p, top_a, repetition_penalty_*, etc.) are passed as preset overrides
 * to getParametersForModel() for NAI-specific sampling behaviour.
 *
 * @param params - Raw parameters record from NaiPresetRow.parameters
 * @returns Partial NovelAIParameters containing only non-schema fields
 */
function extractNonSchemaPresetParams(params: Record<string, unknown>): Partial<NovelAIParameters> {
  // These four keys are written to split server config tables and applied via the existing
  // override logic in getParametersForModel, so exclude them here to avoid conflicts.
  const schemaKeys = new Set(["temperature", "top_k", "top_p", "min_p"]);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!schemaKeys.has(key)) {
      result[key] = value;
    }
  }
  return result as Partial<NovelAIParameters>;
}

type ToolParamType = "string" | "number" | "boolean" | "array" | "object";

interface ToolParameterSchema {
  type?: "object";
  properties?: Record<
    string,
    {
      type?: ToolParamType;
      description?: string;
      enum?: string[];
      items?: { type?: ToolParamType };
    }
  >;
  required?: string[];
}

interface NormalizedToolDefinition {
  name: string;
  description?: string;
  parameters?: ToolParameterSchema;
}

/**
 * NovelAI-specific stream configuration
 */
export interface NovelaiStreamConfig extends StreamConfig {
  /**
   * Kayra context limit in tokens derived from the guild's subscription tier.
   * When present, overrides the NAI_KAYRA_CONTEXT_LIMIT env var in the secondary
   * dynamic max_length safety cap so Tablet users (4096) are protected correctly.
   */
  kayraContextLimit?: number;
}

/**
 * NovelAI streaming adapter implementation
 *
 * NovelAI requires a flat text prompt with speaker labels:
 * [System instructions]
 *
 * Username1: message1
 * BotName: response1
 * Username2: message2
 * BotName:
 */
export class NovelaiStreamAdapter extends BaseStreamAdapter {
  /**
   * Tags that should be prepended as system instructions
   * Tool-related tags are conditionally included when prompt-based tool calling is enabled.
   */
  private static readonly SYSTEM_INSTRUCTION_TAGS_BASE: ContextItemTag[] = [
    ContextItemTag.SYSTEM_INSTRUCTION_BLOCK,
    ContextItemTag.SYSTEM_PERSONALITY,
    ContextItemTag.SYSTEM_HUMANIZER_RULES,
    ContextItemTag.SYSTEM_PERSONA_PROMPT,
    ContextItemTag.KNOWLEDGE_SERVER_INFO,
    ContextItemTag.KNOWLEDGE_SERVER_MEMORIES,
    ContextItemTag.KNOWLEDGE_PERSONA_SPRITES,
  ];

  private static readonly SYSTEM_INSTRUCTION_TAGS_TOOLING: ContextItemTag[] = [
    ContextItemTag.SYSTEM_FUNCTION_GUIDE,
    // REMOVED: KNOWLEDGE_SERVER_EMOJIS, KNOWLEDGE_SERVER_STICKERS: GLM 4.6 is text-only
    // and cannot use emojis/stickers. Omitting saves significant tokens toward the ~2800
    // token quality threshold.
  ];

  private toolsEnabled = false;
  private toolDefinitions: NormalizedToolDefinition[] = [];
  private toolCallMode: "disabled" | "undecided" | "text" | "tool_call" = "disabled";
  private toolPreludeBuffer = "";
  private toolCallBuffer = "";
  private insideThinkBlock = false;
  private pendingThinkBlockThoughtText = "";
  private textScanBuffer = "";

  /**
   * Speaker names extracted from DIALOGUE_HISTORY for no-colon turn detection.
   * Populated in startStream() and used by processVisibleText().
   * Contains only user/other-character names: never the bot's own name.
   */
  private knownSpeakers: Set<string> = new Set();
  private speakerStopPatternEnabled = false;
  private static readonly TOOL_CALL_TAG = "<tool_call>";
  private static readonly TOOL_CALL_TAG_LENGTH = NovelaiStreamAdapter.TOOL_CALL_TAG.length;

  /**
   * Whether the current stream is using GLM 4.6 (enables sentence-boundary buffering).
   * Set in startStream() based on model type.
   */
  private isGlmModel = false;

  /**
   * Tracks whether any visible text has been emitted to the user during this stream.
   * Used to suppress stray tool calls that appear after text output: these are model
   * hallucinations (e.g., empty select_sticker_for_response) that fail on execution.
   */
  private hasEmittedVisibleText = false;

  /**
   * Sentence-boundary trailing buffer for GLM 4.6.
   *
   * NAI's ~150-token hard cap often cuts text mid-sentence. Instead of trying
   * to continue (which causes garbled artifacts), we hold back text after the
   * last sentence boundary and silently drop it when the stream ends.
   *
   * Only active for GLM 4.6; Kayra uses generate_until_sentence at the API level.
   */
  private sentenceTrailingBuffer = "";

  /**
   * Incomplete trailing sentence saved when the stream ends mid-sentence.
   *
   * Set in processChunk() when a trailing fragment is dropped (no sentence boundary).
   * Retrieved by NovelaiProvider after streamToDiscord() returns so it can attach the
   * fragment to the StreamResult and forward it as a prompt continuation on the next retry.
   *
   * Reset at the start of each startStream() call so stale values never leak across turns.
   */
  private pendingContinuationPrefill: string | undefined = undefined;

  constructor() {
    super({
      name: "novelai",
      version: "1.0",
      supportsFunctionCalling: true,
    });
  }

  /**
   * Returns the incomplete trailing sentence from the most recent stream, if any.
   *
   * NovelaiProvider calls this after the orchestrator finishes to surface the fragment
   * through StreamResult.naiContinuationPrefill for use as a prompt continuation.
   *
   * @returns The dropped trailing text, or undefined if the stream ended cleanly
   */
  getPendingContinuationPrefill(): string | undefined {
    return this.pendingContinuationPrefill;
  }

  /** Regex matching characters that indicate a natural sentence/thought boundary.
   * NOTE: Single quote (') is intentionally excluded because contractions like "How's",
   * "don't", "it's" are far more common than closing single quotes, causing
   * false positives that cut mid-word (e.g., "How'" instead of "How's it going?").
   */
  private static readonly SENTENCE_BOUNDARY_PATTERN = /[.!?*~)\]"\u300D\u2026\u2014]\s*$/;

  private getSystemInstructionTags(includeTools: boolean): ContextItemTag[] {
    if (!includeTools) {
      return NovelaiStreamAdapter.SYSTEM_INSTRUCTION_TAGS_BASE;
    }

    return [
      ...NovelaiStreamAdapter.SYSTEM_INSTRUCTION_TAGS_BASE,
      ...NovelaiStreamAdapter.SYSTEM_INSTRUCTION_TAGS_TOOLING,
    ];
  }

  /**
   *
   * For GLM 4.6 (OpenAI endpoint):
   * - Uses the official GLM chat template with <|system|>, <|user|>, <|assistant|> tags
   * - Single-pass generation; no continuation loop (NAI's ~150-token cap is accepted)
   * - Incomplete trailing sentences are silently dropped via sentence-boundary buffering
   * - Uses regex speaker detection for turn boundaries (GLM doesn't emit <|user|> tokens)
   *
   * For Kayra (native endpoint):
   * - Uses flat text prompt with "Username: message" format
   * - Uses generate_until_sentence for clean endings
   * - Uses regex speaker detection for turn boundaries
   */
  async *startStream(config: StreamConfig, context: StreamContext): AsyncGenerator<RawStreamChunk, void, unknown> {
    log.info("NovelAIStreamAdapter: Initializing NovelAI streaming");

    this.generationBuffer = "";
    this.sentenceTrailingBuffer = "";
    this.hasEmittedVisibleText = false;
    this.pendingContinuationPrefill = undefined;
    this.kayraHoldBuffer = "";
    this.kayraSpeakerBoundaryStopPending = false;
    this.pendingThinkBlockThoughtText = "";
    this.toolDefinitions = this.normalizeToolDefinitions(config.tools ?? []);
    this.toolsEnabled = this.toolDefinitions.length > 0;
    this.resetToolParsingState();
    if (this.toolsEnabled) {
      log.info(`NovelAIStreamAdapter: Tool calling enabled with ${this.toolDefinitions.length} tools`);
    }

    if (!config.model) {
      throw new Error("Model must be specified in config. Use NovelAIProvider.getDefaultModel() if needed.");
    }

    const isGlm = usesOpenAIEndpoint(config.model);
    this.isGlmModel = isGlm;

    let prompt: string;
    if (isGlm) {
      // GLM 4.6: Official chat template with role tags and forced thinking
      prompt = this.assembleGlmChatPrompt(context.contextItems, context.tomoriState.persona_nickname, {
        toolDefinitions: this.toolDefinitions,
        functionInteractionHistory: context.functionInteractionHistory,
        messageIdMap: context.messageIdMap,
        thinkingLevel: context.tomoriState.config.thinking_level,
        forceReason: config.forceReason,
      });
    } else {
      // Kayra: Flat text prompt with NAI prompt-convention formatting
      // Build ATTG block from persona metadata (null if not configured)
      const attgBlock = this.buildAttgBlock(context.tomoriState, config.model);
      const basePrompt = this.assembleNovelAIPrompt(context.contextItems, context.tomoriState.persona_nickname, {
        toolDefinitions: this.toolDefinitions,
        functionInteractionHistory: context.functionInteractionHistory,
        attgBlock,
        messageIdMap: context.messageIdMap,
      });
      // Append bot name to signal it should generate the bot's response, unless
      // /bot respond already injected a final assistant prefill turn as the tail.
      // In that case, adding another "{botName}:" creates an extra empty turn and
      // breaks true continuation for Kayra/Erato.
      const outputPrefillTail = context.outputPrefill?.trim() ?? "";
      const hasTailPrefill = outputPrefillTail.length > 0 && basePrompt.trimEnd().endsWith(outputPrefillTail);
      prompt = hasTailPrefill ? basePrompt : `${basePrompt}\n${context.tomoriState.persona_nickname}: `;
      if (hasTailPrefill) {
        log.info("NovelAI Kayra: Detected assistant prefill at prompt tail; skipping trailing bot-name cue");
      }
    }

    // For GLM 4.6: if a previous stream was cut off mid-sentence, append the trailing
    // fragment to the prompt so the model continues from that exact point rather than
    // generating a brand-new response. The prompt currently ends with "BotName:" (when
    // NAI_GLM_CHAR_PREFIX_ENABLED is true) or "/nothink", so we append with a single
    // space separator to stay on the same line.
    if (isGlm && context.naiContinuationPrefill?.trim()) {
      const prefill = context.naiContinuationPrefill.trimStart();
      if (NAI_GLM_CHAR_PREFIX_ENABLED) {
        prompt = `${prompt} ${prefill}`;
      } else {
        prompt = `${prompt}\n${prefill}`;
      }
      log.info(
        `NovelAI GLM: Appended continuation prefill to prompt ` +
          `(${prefill.length} chars): "${prefill.substring(0, 80)}"`,
      );
    }

    log.info(`Assembled NovelAI prompt (${isGlm ? "GLM" : "Kayra"}). Length: ${prompt.length} characters`);

    log.section("NovelAI Full Prompt");
    log.info(prompt);

    // Neutral values (topK=0, topP=1.0, minP=0.0) preserve the model preset defaults.
    // Non-schema NAI preset fields (order, TFS, phrase_rep_pen, etc.) are extracted
    // from the active preset and merged before DB schema overrides are applied.
    const { llm_top_k, llm_top_p, llm_min_p, llm_disabled_params } = context.tomoriState.config;
    const disabledParams = config.disabledParams ?? llm_disabled_params ?? [];
    const temperature = isParamDisabled(disabledParams, "temperature") ? undefined : config.temperature;
    const topK = isParamDisabled(disabledParams, "topK") ? undefined : llm_top_k;
    const topP = isParamDisabled(disabledParams, "topP") ? undefined : llm_top_p;
    const minP = isParamDisabled(disabledParams, "minP") ? undefined : llm_min_p;
    const naiPresetOverrides = extractNonSchemaPresetParams(context.tomoriState.nai_preset?.parameters ?? {});
    const parameters = getParametersForModel(config.model, temperature, topK, topP, minP, naiPresetOverrides);

    // Dynamic max_length safety cap for GLM 4.6.
    //
    // contextTruncator runs earlier on raw context items using a 4 chars/token estimate.
    // GLM 4.6 actually tokenizes at ~2.2-2.5 chars/token, so the assembled prompt (which
    // also includes GLM role tags, the tool guide, and /nothink directives not present
    // in raw context items) can still exceed the API's 12 288-token ceiling.
    //
    // Here we re-estimate input tokens from the final prompt length and shrink
    // max_length if needed so that input + output ≤ NAI_GLM_CONTEXT_LIMIT × 0.95.
    // A floor of 50 ensures we always request at least a minimal response.
    if (isGlm) {
      const estimatedInputTokens = Math.ceil(prompt.length / NAI_GLM_CHARS_PER_TOKEN);
      const maxAllowedOutput = Math.floor((NAI_GLM_CONTEXT_LIMIT - estimatedInputTokens) * 0.95);
      const clampedMaxLength = Math.max(50, maxAllowedOutput);

      const currentMaxLength = parameters.max_length ?? 0;
      if (clampedMaxLength < currentMaxLength) {
        log.warn(
          `NovelAI GLM: Clamping max_length ${currentMaxLength} → ${clampedMaxLength} ` +
            `(prompt ${prompt.length} chars ≈ ${estimatedInputTokens} tokens, ` +
            `context limit: ${NAI_GLM_CONTEXT_LIMIT})`,
        );
        parameters.max_length = clampedMaxLength;
      }
    } else {
      // Dynamic max_length safety cap for Kayra/Erato.
      //
      // contextTruncator runs earlier using 4 chars/token. Kayra tokenizes at
      // ~3.0-3.5 chars/token, so the assembled prompt may still overshoot the
      // tier's token ceiling. We re-estimate here and:
      //   - Clamp max_length when input fits but input+output would exceed the limit.
      //   - Log a warning when the input alone already exceeds the limit (can't fix
      //     with output clamping; the subscription cache should prevent this via
      //     accurate contextTruncator budgeting, but this is a last-resort guard).
      //
      // Prefer the subscription-derived limit threaded in from tomoriChat.ts; fall back
      // to the NAI_KAYRA_CONTEXT_LIMIT env var so the guard fires even when no cached
      // value is present (e.g. key set but bot restarted before first message).
      const effectiveKayraLimit = (config as NovelaiStreamConfig).kayraContextLimit ?? NAI_KAYRA_CONTEXT_LIMIT;
      const estimatedInputTokens = Math.ceil(prompt.length / NAI_KAYRA_CHARS_PER_TOKEN);
      const maxAllowedOutput = effectiveKayraLimit - estimatedInputTokens;
      const currentMaxLength = parameters.max_length ?? 0;
      if (maxAllowedOutput <= 0) {
        log.warn(
          `NovelAI Kayra: Prompt likely exceeds context limit — ` +
            `prompt ${prompt.length} chars ≈ ${estimatedInputTokens} tokens, ` +
            `limit: ${effectiveKayraLimit}. ` +
            `Check your subscription tier or set NAI_KAYRA_CONTEXT_LIMIT explicitly.`,
        );
      } else if (maxAllowedOutput < currentMaxLength) {
        const clampedMaxLength = Math.max(1, maxAllowedOutput);
        log.warn(
          `NovelAI Kayra: Clamping max_length ${currentMaxLength} → ${clampedMaxLength} ` +
            `(prompt ${prompt.length} chars ≈ ${estimatedInputTokens} tokens, ` +
            `context limit: ${effectiveKayraLimit})`,
        );
        parameters.max_length = clampedMaxLength;
      }
    }

    // Collect unique user speaker names from DIALOGUE_HISTORY items.
    // These are stored in this.knownSpeakers so processVisibleText() can use them
    // to detect turn boundaries even when the model omits the colon (story format).
    // DIALOGUE_HISTORY is the only tag guaranteeing the "AuthorName: message" prefix.
    // NOTE: logit_bias_exp is intentionally NOT used here despite use_string=true,
    // logit_bias_exp[].sequence is interpreted as Kayra token IDs, not UTF-8 bytes.
    // Passing byte values as token IDs produces garbage special tokens at generation
    // start (e.g. <|reserved5|>, <|maskend|>). Turn stopping is handled entirely by
    // the speaker-detection regex in processVisibleText() instead.
    this.speakerStopPatternEnabled = context.tomoriState.config.llm_stop_speaker_pattern_enabled ?? false;
    if (!isGlm && this.speakerStopPatternEnabled) {
      const speakerSet = new Set<string>();
      for (const item of context.contextItems) {
        if (item.metadataTag !== ContextItemTag.DIALOGUE_HISTORY) continue;
        if (item.role !== "user") continue;
        const text = item.parts
          .filter((p) => p.type === "text")
          .map((p) => (p as { type: "text"; text: string }).text)
          .join("\n");
        const speakerLinePattern = /^(?!\[System:)([^:\n]+):\s+/gm;
        for (const match of text.matchAll(speakerLinePattern)) {
          const speaker = match[1].trim();
          if (speaker) speakerSet.add(speaker);
        }
      }
      // Exclude the bot's own name because it may legitimately appear on new lines
      // as it continues its own turn across multiple sentences.
      speakerSet.delete(context.tomoriState.persona_nickname);
      this.knownSpeakers = speakerSet;
    } else {
      this.knownSpeakers = new Set();
    }

    const openAIStopStrings = buildProviderStopStrings({
      providerName: "novelai",
      model: config.model,
      personaName: context.tomoriState.persona_nickname,
      configuredStops: context.tomoriState.config.llm_stop_strings,
      includePersonaSpeakerStop: this.speakerStopPatternEnabled,
    });
    const request: NovelAIGenerationRequest = {
      input: prompt,
      model: config.model,
      parameters,
      openAIStopStrings,
    };

    this.logSanitizedRequest(request, prompt.length);

    try {
      // Single-pass streaming for both models:
      // - Kayra: generate_until_sentence handles clean endings
      // - GLM 4.6: sentence-boundary buffering drops incomplete trailing fragments
      yield* this.streamSinglePass(request, config);
    } catch (error) {
      yield this.createProviderErrorChunk(error, context);
    }
  }

  /**
   * Single-pass streaming for Kayra; no continuation loop
   */
  private async *streamSinglePass(
    request: NovelAIGenerationRequest,
    config: StreamConfig,
  ): AsyncGenerator<RawStreamChunk, void, unknown> {
    const stream = novelaiGenerateStream(request, {
      apiKey: config.apiKey,
      timeout: config.inactivityTimeoutMs,
    });

    for await (const chunk of stream) {
      yield {
        data: chunk,
        provider: "novelai",
        metadata: {
          timestamp: Date.now(),
          model: config.model,
        },
      };
    }
  }

  /**
   * Accumulated buffer for detecting speaker transitions
   * NovelAI sometimes continues generating and starts a new speaker's turn
   * We need to detect and strip this out
   */
  private generationBuffer = "";
  /** Buffer holding back text from the last "\n" onward, pending speaker-prefix resolution for Kayra. */
  private kayraHoldBuffer = "";
  /** When true, Kayra has already hit a held speaker boundary and should return done on next token. */
  private kayraSpeakerBoundaryStopPending = false;

  /**
   * Process a raw NovelAI chunk into normalized format
   */
  processChunk(chunk: RawStreamChunk): ProcessedChunk {
    const novelaiChunk = chunk.data as NovelAIStreamChunk & {
      error?: ProviderError;
    };
    const withThoughts = (result: ProcessedChunk): ProcessedChunk => this.attachPendingThoughts(result);

    if (novelaiChunk.error) {
      if (typeof novelaiChunk.error === "object" && "type" in novelaiChunk.error) {
        return withThoughts({
          type: "error",
          error: novelaiChunk.error as ProviderError,
        });
      }

      return withThoughts({
        type: "error",
        error: {
          type: "api_error",
          message: novelaiChunk.error as unknown as string,
          retryable: false,
        },
      });
    }

    if (novelaiChunk.final) {
      // GLM 4.6: If the stream ends while accumulating a tool call (model hit token cap
      // before generating </tool_call>), try to parse what we have. NAI's token limit
      // often cuts off the closing tag, so we synthesize it from the accumulated buffer.
      // Text preamble before the tool call is fine, so it's already been emitted.
      if (this.toolCallMode === "tool_call" && this.toolCallBuffer.trim()) {
        log.info("NovelAI GLM: Stream ended during tool call accumulation — attempting to parse without closing tag");
        const patched = `${this.toolCallBuffer.trimEnd()}\n</tool_call>`;
        const toolCallBlock = this.extractToolCallBlock(patched);
        if (toolCallBlock) {
          const parsedCall = this.parseToolCallBlock(toolCallBlock);
          if (parsedCall) {
            log.info(`NovelAI GLM: Successfully parsed truncated tool call: ${parsedCall.name}`);
            this.generationBuffer = "";
            this.sentenceTrailingBuffer = "";
            this.resetToolParsingState();
            return withThoughts({
              type: "function_call",
              functionCall: parsedCall,
            });
          }
        }
        log.warn("NovelAI GLM: Failed to parse truncated tool call — treating as empty response");
      }

      // GLM 4.6: If still in undecided mode with a prelude buffer that looks like
      // an incomplete tool call (e.g., just the function name, waiting for <arg_key>),
      // try to parse it as a tool call before discarding.
      if (this.toolCallMode === "undecided" && this.toolPreludeBuffer.trim()) {
        const trimmedPrelude = this.toolPreludeBuffer.trim();
        const firstLine = trimmedPrelude.split("\n")[0].trim();
        const normalizedName = firstLine ? this.normalizeToolName(firstLine) : "";
        const matchedTool = normalizedName ? this.toolDefinitions.find((t) => t.name === normalizedName) : undefined;

        if (matchedTool && trimmedPrelude.includes("<arg_key>")) {
          log.info(
            `NovelAI GLM: Stream ended with unwrapped tool call in prelude — attempting parse for "${matchedTool.name}"`,
          );
          const patched = `<tool_call>${trimmedPrelude}\n</tool_call>`;
          const toolCallBlock = this.extractToolCallBlock(patched);
          if (toolCallBlock) {
            const parsedCall = this.parseToolCallBlock(toolCallBlock);
            if (parsedCall) {
              log.info(`NovelAI GLM: Successfully parsed truncated prelude tool call: ${parsedCall.name}`);
              this.generationBuffer = "";
              this.sentenceTrailingBuffer = "";
              this.resetToolParsingState();
              return withThoughts({
                type: "function_call",
                functionCall: parsedCall,
              });
            }
          }
        }
      }

      // For GLM 4.6: check if the sentence trailing buffer has a complete thought.
      // If it ends at a sentence boundary, flush it before signaling done.
      // If not (NAI cut off mid-sentence), silently drop it for a clean ending.
      let finalFlush = "";
      if (this.isGlmModel && this.sentenceTrailingBuffer.trim()) {
        if (NovelaiStreamAdapter.SENTENCE_BOUNDARY_PATTERN.test(this.sentenceTrailingBuffer)) {
          finalFlush = this.sentenceTrailingBuffer;
        } else {
          // Incomplete sentence, so save it as a continuation prefill for the retry.
          // NovelaiProvider reads this via getPendingContinuationPrefill() after the
          // stream ends and attaches it to StreamResult.naiContinuationPrefill so
          // tomoriChat can append it to the next prompt instead of starting over.
          this.pendingContinuationPrefill = this.sentenceTrailingBuffer;
          log.info(
            `NovelAI GLM: Trailing fragment saved for continuation ` +
              `(${this.sentenceTrailingBuffer.length} chars): ` +
              `"${this.sentenceTrailingBuffer.substring(0, 80)}..."`,
          );
        }
      }

      // For Kayra: flush held-back speaker-prefix buffer if stream ended without a match.
      // A pending fragment that never triggered a speaker stop is safe to emit.
      let kayraFinalFlush = "";
      if (!this.isGlmModel && this.kayraHoldBuffer.trim()) {
        kayraFinalFlush = this.kayraHoldBuffer;
      }

      this.generationBuffer = "";
      this.sentenceTrailingBuffer = "";
      this.hasEmittedVisibleText = false;
      this.resetToolParsingState();
      this.kayraHoldBuffer = "";
      this.kayraSpeakerBoundaryStopPending = false;

      // If we have a final flush (Kayra hold-buffer or GLM trailing buffer), emit as text.
      // The stream's own termination signals "done" to the orchestrator.
      const flushContent = kayraFinalFlush || finalFlush;
      if (flushContent) {
        return withThoughts({
          type: "text",
          content: flushContent,
        });
      }

      return withThoughts({
        type: "done",
      });
    }

    if (novelaiChunk.token) {
      if (this.toolsEnabled) {
        return withThoughts(this.processTokenWithToolParsing(novelaiChunk.token));
      }

      // GLM 4.6: Strip any <think>...</think> blocks before visible text processing.
      // With /nothink removed, the model may emit thinking blocks in its response.
      if (this.isGlmModel) {
        const stripped = this.stripThinkBlocks(novelaiChunk.token);
        if (!stripped) {
          return withThoughts({ type: "text", content: "" });
        }
        return withThoughts(this.processVisibleText(stripped));
      }

      return withThoughts(this.processVisibleText(novelaiChunk.token));
    }

    return withThoughts({
      type: "text",
      content: "",
    });
  }

  /**
   * Process visible text with speaker detection and sentence-boundary buffering.
   *
   * For GLM 4.6: Text is routed through a sentence-boundary-aware trailing buffer.
   * Only text up to the last confirmed sentence boundary is emitted to the orchestrator.
   * The trailing fragment (potentially incomplete sentence) is held back and silently
   * dropped if the stream ends mid-sentence (NAI's ~150-token cap).
   *
   * For Kayra: Text is passed through directly (generate_until_sentence handles endings).
   *
   * Both models use regex-based speaker transition detection to stop generation
   * when the model starts another character's turn.
   */
  private processVisibleText(text: string): ProcessedChunk {
    if (!text) {
      return {
        type: "text",
        content: "",
      };
    }

    // Kayra: once we detect a held speaker boundary, stop on subsequent tokens.
    if (!this.isGlmModel && this.kayraSpeakerBoundaryStopPending) {
      this.generationBuffer = "";
      this.sentenceTrailingBuffer = "";
      this.kayraHoldBuffer = "";
      return { type: "done" };
    }

    // GLM 4.6: Detect stray </think> tags in visible text.
    // After the initial <think></think> block is consumed by stripThinkBlocks(),
    // any subsequent </think> in the visible text phase indicates model debris:
    // the model hallucinates garbage after the tag (e.g., "oggers:</think>\nI'll kill you").
    // Stop the stream immediately and only emit clean text before the tag.
    if (this.isGlmModel) {
      const thinkCloseIdx = text.indexOf("</think>");
      if (thinkCloseIdx !== -1) {
        const cleanBefore = text.slice(0, thinkCloseIdx).trim();
        log.warn(
          `NovelAI GLM: Stray </think> detected in visible text — stopping stream. ` +
            `Clean text before tag: "${cleanBefore.substring(0, 80)}"`,
        );
        // Clear buffers, so stream will end naturally after this return
        this.generationBuffer = "";
        this.sentenceTrailingBuffer = "";
        this.hasEmittedVisibleText = false;
        if (cleanBefore) {
          // Emit clean text directly (skip speaker detection since we're stopping).
          this.hasEmittedVisibleText = true;
          return { type: "text", content: cleanBefore };
        }
        return { type: "done" };
      }
    }

    this.generationBuffer += text;

    if (!this.speakerStopPatternEnabled) {
      if (!this.isGlmModel) {
        this.generationBuffer = "";
        if (text.trim()) this.hasEmittedVisibleText = true;
        return { type: "text", content: text };
      }
      this.generationBuffer = "";
    } else {
      // Detect speaker transitions: the model is generating another character's turn.
      // Both Kayra and GLM 4.6 need this: Kayra has no API stop sequences, and GLM
      // doesn't emit <|user|> tokens in completions mode (it just starts "Username: ...")
      //
      // Three stop conditions checked in order:
      // Dinkus (\n***): Kayra uses *** as a scene break between narrative zones.
      //    When the model generates \n*** it considers its turn complete. Only triggered
      //    after \n so ****-style censored words at response start are not clipped.
      // Generic colon-form (\nName:): any speaker label with a colon.
      // Known-name no-colon (\nName<space>): story-format turns where the model
      //    writes "Name text" instead of "Name: text". Only fires for known speakers
      //    from this.knownSpeakers to avoid false positives on mid-sentence proper nouns.
      const markdownCodeRanges = findMarkdownCodeRanges(this.generationBuffer);
      let speakerMatch =
        this.findFirstMarkdownSafeMatch(
          this.generationBuffer,
          /\n\*\*\*/g,
          markdownCodeRanges,
          (match) => match.index + 1,
        ) ??
        this.findFirstMarkdownSafeMatch(this.generationBuffer, /\n+([^\n:]+):\s*/g, markdownCodeRanges, (match) => {
          const rawLabel = match[1] ?? "";
          return match.index + match[0].indexOf(rawLabel);
        });

      if (!speakerMatch && this.knownSpeakers.size > 0) {
        const escaped = [...this.knownSpeakers].map(escapeRegExp).join("|");
        speakerMatch = this.findFirstMarkdownSafeMatch(
          this.generationBuffer,
          new RegExp(`\\n+(${escaped})\\s`, "g"),
          markdownCodeRanges,
          (match) => {
            const rawLabel = match[1] ?? "";
            return match.index + match[0].indexOf(rawLabel);
          },
        );
      }

      if (speakerMatch) {
        this.generationBuffer = "";
        this.sentenceTrailingBuffer = "";
        this.kayraHoldBuffer = "";
        // Stream orchestrator continues reading until provider final;
        // latch stop so subsequent Kayra/Erato tokens are ignored.
        this.kayraSpeakerBoundaryStopPending = !this.isGlmModel;
        return {
          type: "done",
        };
      }

      // Kayra/Erato: also treat sentence-colon boundaries as turn transitions.
      // Example: "... It is not healthy.: Please, don't say that..."
      // We stop on either:
      // - A complete boundary with following speaker text in-buffer.
      // - A trailing boundary ending in ":" (next token would start the other turn).
      if (!this.isGlmModel) {
        const sentenceColonBoundary = /[.!?…]["')\]]?\s*:\s+(?=[A-Z*"])/;
        const trailingSentenceColonBoundary = /[.!?…]["')\]]?\s*:\s*$/;
        if (
          sentenceColonBoundary.test(this.generationBuffer) ||
          trailingSentenceColonBoundary.test(this.generationBuffer)
        ) {
          this.generationBuffer = "";
          this.sentenceTrailingBuffer = "";
          this.kayraHoldBuffer = "";
          this.kayraSpeakerBoundaryStopPending = true;
          return { type: "done" };
        }
      }
    }

    // For Kayra: hold-back buffering to prevent partial speaker-prefix leakage.
    // Kayra streams one token at a time; Name" arrives before the space that
    // would complete a knownSpeakers match. Without buffering, Name" is emitted
    // before the regex fires on the following token.
    // Strategy: always hold back from the last in the combined text, releasing
    // it once the next token confirms it is NOT a speaker prefix (or stops if it is).
    if (!this.isGlmModel) {
      const combined = this.kayraHoldBuffer + text;
      this.kayraHoldBuffer = "";
      const lastNewlineIdx = combined.lastIndexOf("\n");
      if (lastNewlineIdx !== -1) {
        const safeToEmit = combined.slice(0, lastNewlineIdx);
        const trailingLine = combined.slice(lastNewlineIdx + 1);
        const trailingLineStartIndex = this.generationBuffer.length - trailingLine.length;
        const markdownCodeRanges = findMarkdownCodeRanges(this.generationBuffer);

        // Line-aware speaker boundary stop:
        // keep one trailing line held; if it starts with another speaker,
        // emit everything before the newline and stop before flushing that line.
        if (this.shouldStopAtKayraHeldLine(this.generationBuffer, trailingLineStartIndex, markdownCodeRanges)) {
          this.generationBuffer = "";
          this.sentenceTrailingBuffer = "";
          this.kayraHoldBuffer = "";
          if (safeToEmit.length > 0) {
            this.kayraSpeakerBoundaryStopPending = true;
            if (safeToEmit.trim()) this.hasEmittedVisibleText = true;
            return { type: "text", content: safeToEmit };
          }
          this.kayraSpeakerBoundaryStopPending = true;
          return { type: "done" };
        }

        this.kayraHoldBuffer = combined.slice(lastNewlineIdx);
        if (safeToEmit.trim()) this.hasEmittedVisibleText = true;
        return { type: "text", content: safeToEmit };
      }
      if (combined.trim()) this.hasEmittedVisibleText = true;
      return { type: "text", content: combined };
    }

    // GLM 4.6: Sentence-boundary buffering
    // Accumulate text in the trailing buffer, then emit everything up to the
    // last sentence boundary. The remainder stays buffered in case NAI cuts
    // the output mid-sentence, so it gets silently dropped in processChunk on "final".
    this.sentenceTrailingBuffer += text;

    const lastBoundaryIndex = this.findLastSentenceBoundary(this.sentenceTrailingBuffer);

    if (lastBoundaryIndex === -1) {
      return {
        type: "text",
        content: "",
      };
    }

    const emitText = this.sentenceTrailingBuffer.slice(0, lastBoundaryIndex + 1);
    this.sentenceTrailingBuffer = this.sentenceTrailingBuffer.slice(lastBoundaryIndex + 1);

    if (emitText.trim()) this.hasEmittedVisibleText = true;
    return {
      type: "text",
      content: emitText,
    };
  }

  private findFirstMarkdownSafeMatch(
    text: string,
    pattern: RegExp,
    markdownCodeRanges: ReturnType<typeof findMarkdownCodeRanges>,
    getProtectedIndex: (match: RegExpExecArray) => number,
  ): RegExpExecArray | null {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null = null;

    while (true) {
      match = pattern.exec(text);
      if (match === null) {
        return null;
      }

      if (!this.isIndexInsideMarkdownCodeRanges(getProtectedIndex(match), markdownCodeRanges)) {
        return match;
      }

      if (match[0].length === 0) {
        pattern.lastIndex++;
      }
    }
  }

  private isIndexInsideMarkdownCodeRanges(
    index: number,
    markdownCodeRanges: ReturnType<typeof findMarkdownCodeRanges>,
  ): boolean {
    return markdownCodeRanges.some((range) => index >= range.start && index < range.end);
  }

  private shouldStopAtKayraHeldLine(
    text: string,
    lineStartIndex: number,
    markdownCodeRanges: ReturnType<typeof findMarkdownCodeRanges>,
  ): boolean {
    const line = text.slice(lineStartIndex);
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith("[System:")) {
      return false;
    }

    const trimmedStartIndex = lineStartIndex + (line.length - trimmed.length);
    if (this.isIndexInsideMarkdownCodeRanges(trimmedStartIndex, markdownCodeRanges)) {
      return false;
    }

    if (/^[^\n:]{1,80}:\s*/.test(trimmed)) {
      return true;
    }

    if (trimmed.startsWith("***")) {
      return true;
    }

    // Known no-colon speaker line (e.g., "Misuzu Sorry...").
    if (this.knownSpeakers.size > 0) {
      const escaped = [...this.knownSpeakers].map(escapeRegExp).join("|");
      return new RegExp(`^(?:${escaped})(?:\\s|[.!?,:;\\-]|$)`).test(trimmed);
    }

    return false;
  }

  /**
   * Find the index of the last sentence boundary character in the given text.
   *
   * Sentence boundaries are characters that typically end a complete thought:
   * punctuation (. ! ? …), closing quotes/brackets (" ) ] 」), markdown
   * formatting (* ~), em dash (—), and newlines.
   * NOTE: Single quote (') excluded because contractions (How's, don't) cause false cuts.
   *
   */
  private findLastSentenceBoundary(text: string): number {
    for (let i = text.length - 1; i >= 0; i--) {
      const char = text[i];
      if (
        char === "." ||
        char === "!" ||
        char === "?" ||
        char === "*" ||
        char === "~" ||
        char === ")" ||
        char === "]" ||
        char === '"' ||
        char === "\u300D" || // 」
        char === "\u2026" || // …
        char === "\u2014" || // —
        char === "\n"
      ) {
        return i;
      }
    }

    return -1;
  }

  private processTokenWithToolParsing(token: string): ProcessedChunk {
    if (this.toolCallMode === "disabled") {
      return this.processVisibleText(token);
    }

    // Normalize Unicode bracket variants in tokens entering the tool parsing pipeline.
    // GLM 4.6 in Japanese conversations sometimes outputs full-width ＜ ＞ instead of ASCII < >,
    // which breaks all downstream tag detection (indexOf, includes, startsWith, regex).
    // This is safe for visible text since full-width angle brackets are extremely rare in
    // conversational text because the model only produces them when attempting XML tool call tags.
    const normalizedToken = this.normalizeXmlBrackets(token);

    if (this.toolCallMode === "undecided") {
      this.toolPreludeBuffer += normalizedToken;
      const decision = this.decideToolCallMode(this.toolPreludeBuffer);

      if (decision.mode === "wait") {
        return { type: "text", content: "" };
      }

      if (decision.mode === "tool_call") {
        // Accept tool calls regardless of whether text was already emitted.
        // Text + tool call is a valid pattern (model announces intent then acts).
        // Invalid tool calls (wrong name, no args) are handled at the executor level.
        if (this.hasEmittedVisibleText) {
          log.info("NovelAI GLM: Tool call detected after visible text — accepting (text preamble pattern)");
        }
        this.toolCallMode = "tool_call";
        this.toolCallBuffer = decision.toolCallText ?? "";
        this.toolPreludeBuffer = "";
        return { type: "text", content: "" };
      }

      this.toolCallMode = "text";
      const visibleText = this.stripThinkBlocks(decision.visibleText ?? "");
      this.toolPreludeBuffer = "";
      if (!visibleText) {
        return { type: "text", content: "" };
      }
      return this.processTextWithToolScan(visibleText);
    }

    if (this.toolCallMode === "tool_call") {
      this.toolCallBuffer += normalizedToken;
      const toolCallBlock = this.extractToolCallBlock(this.toolCallBuffer);
      if (!toolCallBlock) {
        return { type: "text", content: "" };
      }

      const parsedCall = this.parseToolCallBlock(toolCallBlock);
      if (!parsedCall) {
        log.error("NovelAIStreamAdapter: Failed to parse tool call block", {
          toolCallBlock,
        });
        return {
          type: "error",
          error: {
            type: "api_error",
            message: "Failed to parse tool call from model output.",
            code: "tool_call_parse_error",
            retryable: false,
          },
        };
      }

      this.generationBuffer = "";
      this.resetToolParsingState();
      return {
        type: "function_call",
        functionCall: parsedCall,
      };
    }

    return this.processTextWithToolScan(normalizedToken);
  }

  private processTextWithToolScan(token: string): ProcessedChunk {
    if (!token) {
      return { type: "text", content: "" };
    }

    this.textScanBuffer += token;

    const tagIndex = this.textScanBuffer.indexOf(NovelaiStreamAdapter.TOOL_CALL_TAG);

    if (tagIndex !== -1) {
      const visiblePart = this.textScanBuffer.slice(0, tagIndex);
      const toolPart = this.textScanBuffer.slice(tagIndex);
      this.textScanBuffer = "";

      // Accept tool calls found after text: text + tool call is a valid pattern
      // (model announces "Let me search for that" then calls the tool).
      // Emit any remaining visible text before the tag as preamble.
      this.toolCallMode = "tool_call";
      this.toolCallBuffer = toolPart;

      if (this.hasEmittedVisibleText || visiblePart.trim().length > 0) {
        log.info("NovelAI GLM: <tool_call> found after visible text — accepting as text+tool pattern");
      }

      if (visiblePart.trim().length > 0) {
        const cleaned = this.stripThinkBlocks(visiblePart);
        if (cleaned) {
          return this.processVisibleText(cleaned);
        }
      }

      const toolCallBlock = this.extractToolCallBlock(this.toolCallBuffer);
      if (toolCallBlock) {
        const parsedCall = this.parseToolCallBlock(toolCallBlock);
        if (parsedCall) {
          this.generationBuffer = "";
          this.resetToolParsingState();
          return { type: "function_call", functionCall: parsedCall };
        }

        log.error("NovelAIStreamAdapter: Failed to parse tool call block", {
          toolCallBlock,
        });
        return {
          type: "error",
          error: {
            type: "api_error",
            message: "Failed to parse tool call from model output.",
            code: "tool_call_parse_error",
            retryable: false,
          },
        };
      }

      return { type: "text", content: "" };
    }

    // Check for unwrapped tool call: bare function name on a new line followed by <arg_key>.
    //    GLM sometimes outputs text then switches to a tool call without <tool_call> wrapper.
    //    Scan for "\n{tool_name}\n<arg_key>" pattern in the buffer.
    if (this.isGlmModel && this.textScanBuffer.includes("<arg_key>")) {
      const unwrappedMatch = this.detectUnwrappedToolCallInText(this.textScanBuffer);
      if (unwrappedMatch) {
        const visiblePart = this.textScanBuffer.slice(0, unwrappedMatch.startIndex);
        const toolPart = this.textScanBuffer.slice(unwrappedMatch.startIndex);
        this.textScanBuffer = "";

        if (this.hasEmittedVisibleText || visiblePart.trim().length > 0) {
          log.info(
            `NovelAI GLM: Unwrapped tool call "${unwrappedMatch.toolName}" found after visible text — accepting as text+tool pattern`,
          );
        }

        if (visiblePart.trim().length > 0) {
          const cleaned = this.stripThinkBlocks(visiblePart);
          if (cleaned) {
            // Emit text first; tool call will be picked up on subsequent tokens
            this.toolCallMode = "tool_call";
            this.toolCallBuffer = `<tool_call>${toolPart.trim()}`;
            return this.processVisibleText(cleaned);
          }
        }

        log.info(
          `NovelAI GLM: Detected unwrapped tool call "${unwrappedMatch.toolName}" mid-text — wrapping in <tool_call> tags`,
        );
        this.toolCallMode = "tool_call";
        this.toolCallBuffer = `<tool_call>${toolPart.trim()}`;
        return { type: "text", content: "" };
      }
    }

    // No tool tag found yet, so flush everything except a small tail to avoid leaking partial tags
    const holdLength = NovelaiStreamAdapter.TOOL_CALL_TAG_LENGTH - 1;
    if (this.textScanBuffer.length <= holdLength) {
      return { type: "text", content: "" };
    }

    const flushText = this.textScanBuffer.slice(0, this.textScanBuffer.length - holdLength);
    this.textScanBuffer = this.textScanBuffer.slice(this.textScanBuffer.length - holdLength);

    const cleaned = this.stripThinkBlocks(flushText);
    if (!cleaned) {
      return { type: "text", content: "" };
    }
    return this.processVisibleText(cleaned);
  }

  /**
   * Detect an unwrapped tool call in mid-text: a bare function name on its own line
   * followed by `<arg_key>`. Returns the match position and tool name, or null.
   *
   * Scans for pattern: `\n{known_tool_name}\n<arg_key>` (newline-delimited tool name
   * that matches a registered tool, with at least one argument following).
   *
   * @returns Object with startIndex and toolName, or null if no match
   */
  private detectUnwrappedToolCallInText(buffer: string): { startIndex: number; toolName: string } | null {
    // Split into lines and check if any line matches a tool name with <arg_key> after it.
    // Track position through buffer using cumulative line lengths (no indexOf needed).
    const lines = buffer.split("\n");
    let currentIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line) {
        const normalizedName = this.normalizeToolName(line);
        const matchedTool = this.toolDefinitions.find((t) => t.name === normalizedName);

        if (matchedTool) {
          const remainingText = lines.slice(i + 1).join("\n");
          if (remainingText.includes("<arg_key>")) {
            // currentIndex points to the start of lines[i].
            // Walk back one char to include the preceding newline separator.
            const startIndex = currentIndex > 0 ? currentIndex - 1 : currentIndex;
            return { startIndex, toolName: matchedTool.name };
          }
        }
      }
      currentIndex += lines[i].length;
      if (i < lines.length - 1) {
        currentIndex += 1;
      }
    }

    return null;
  }

  private decideToolCallMode(prelude: string): {
    mode: "wait" | "tool_call" | "text";
    toolCallText?: string;
    visibleText?: string;
  } {
    let buffer = prelude;

    while (true) {
      const trimmedStart = buffer.trimStart();

      if (!trimmedStart) {
        return { mode: "wait" };
      }

      if (trimmedStart.startsWith("</think>")) {
        buffer = trimmedStart.slice("</think>".length);
        continue;
      }

      if (trimmedStart.startsWith("<think>")) {
        const thinkEndIndex = trimmedStart.indexOf("</think>");
        if (thinkEndIndex === -1) {
          return { mode: "wait" };
        }

        buffer = trimmedStart.slice(thinkEndIndex + "</think>".length);
        continue;
      }

      if (trimmedStart.startsWith("<tool_call>")) {
        return { mode: "tool_call", toolCallText: trimmedStart };
      }

      // Partial <tool_call> tag: buffer is a prefix of the full tag.
      //     NAI chunks can split the tag at any point (e.g., "<to", "<tool_cal").
      //     Wait for more tokens until the full tag arrives or we can rule it out.
      if (
        trimmedStart.startsWith("<tool_call") ||
        (trimmedStart.startsWith("<") && "<tool_call>".startsWith(trimmedStart))
      ) {
        return { mode: "wait" };
      }

      // Unwrapped tool call: model outputs function name directly without <tool_call> tag.
      //    GLM 4.6 sometimes omits the wrapper tag and generates:
      //      web_search\n<arg_key>query</arg_key>\n<arg_value>...</arg_value>
      //    Detect this by checking if the first line matches a known tool name.
      //    Uses normalizeToolName() to handle underscore/hyphen variations
      //    (model may output "web-search" but tool is registered as "web_search").
      const firstLine = trimmedStart.split("\n")[0].trim();
      if (firstLine) {
        const normalizedName = this.normalizeToolName(firstLine);
        const matchedTool = this.toolDefinitions.find((t) => t.name === normalizedName);

        if (matchedTool) {
          if (trimmedStart.includes("<arg_key>")) {
            // Confirmed unwrapped tool call: wrap in <tool_call> for parsing.
            // Use the ORIGINAL name from the model (not normalized) so parseToolCallBlock
            // can normalize it during parsing.
            log.info(
              `NovelAI GLM: Detected unwrapped tool call for "${matchedTool.name}" — wrapping in <tool_call> tags`,
            );
            return {
              mode: "tool_call",
              toolCallText: `<tool_call>${trimmedStart}`,
            };
          }
          log.info(
            `NovelAI GLM: decideToolCallMode — tool name "${matchedTool.name}" matched, waiting for <arg_key>. Prelude length: ${prelude.length}`,
          );
          return { mode: "wait" };
        }
        // No tool match: log for debugging unwrapped tool call detection failures
        log.info(
          `NovelAI GLM: decideToolCallMode — firstLine "${firstLine}" did not match any tool (normalized: "${normalizedName}"). Falling through to text mode.`,
        );
      }

      return { mode: "text", visibleText: buffer };
    }
  }

  private extractToolCallBlock(buffer: string): string | null {
    const match = buffer.match(/<tool_call>[\s\S]*?<\/tool_call>/);
    return match ? match[0] : null;
  }

  private parseToolCallBlock(toolCallBlock: string): FunctionCall | null {
    const inner = toolCallBlock
      .replace(/^<tool_call>/, "")
      .replace(/<\/tool_call>$/, "")
      .trim();

    const nameMatch = inner.match(/^([^\n<]+)/);
    if (!nameMatch?.[1]) {
      return null;
    }

    const rawName = nameMatch[1].trim();
    const functionName = this.normalizeToolName(rawName);
    const args: Record<string, unknown> = {};

    // GLM 4.6 in non-English (especially Japanese) conversations sometimes outputs
    // full-width Unicode angle brackets (＜ ＞) instead of ASCII < >.
    // Normalize to ASCII before parsing to ensure the regex matches.
    let normalizedInner = this.normalizeXmlBrackets(inner);

    // Fix truncated closing tags because the stream frequently cuts off right before
    // the final ">" of the last </arg_value> or </arg_key> tag.
    // e.g., "</arg_value" (missing ">") → "</arg_value>"
    // The >? makes this idempotent: already-complete tags are left unchanged.
    normalizedInner = normalizedInner
      .replace(/<\/arg_value>?\s*$/, "</arg_value>")
      .replace(/<\/arg_key>?\s*$/, "</arg_key>");

    // Primary format: XML <arg_key>/<arg_value> pairs (standard GLM tool format)
    const argMatches = normalizedInner.matchAll(/<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g);

    for (const match of argMatches) {
      const rawArgKey = match[1]?.trim();
      const rawValue = match[2]?.trim();
      if (!rawArgKey) continue;

      // Normalize garbled param names because GLM drops tokens at high temperature.
      // e.g., "ave_wuery" → "query", "ount" → "count"
      const argKey = this.normalizeParamName(functionName, rawArgKey);
      const expectedType = this.getToolParamType(functionName, argKey);
      args[argKey] = this.coerceArgValue(rawValue ?? "", expectedType);
    }

    // Fallback: when GLM outputs args in non-XML formats (common in Japanese conversations).
    //    GLM 4.6 sometimes drops the XML arg tags entirely when responding in Japanese, outputting:
    //    - JSON object: {"query": "search term"}
    //    - Key-value lines: query: "search term" or query="search term"
    //    Only attempt fallback if the primary XML parser found zero arguments.
    if (Object.keys(args).length === 0) {
      const bodyAfterName = normalizedInner.slice(nameMatch[0].length).trim();
      if (bodyAfterName) {
        this.parseToolCallArgsFallback(functionName, bodyAfterName, args);
      }
    }

    // Diagnostic: log hex dump of characters around "arg_key" to identify invisible/non-ASCII issues
    if (Object.keys(args).length === 0 && inner.includes("\n")) {
      const argKeyIdx = inner.indexOf("arg_key");
      let hexContext = "";
      if (argKeyIdx >= 0) {
        // Show 5 chars before "arg_key" as hex codes to catch non-ASCII brackets
        const start = Math.max(0, argKeyIdx - 5);
        const snippet = inner.slice(start, argKeyIdx + 12);
        hexContext = ` | Hex near arg_key: ${[...snippet].map((c) => `U+${c.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`).join(" ")}`;
      }
      log.warn(
        `NovelAI GLM: Tool call "${functionName}" parsed with empty args.${hexContext} | Raw body: ${inner.slice(0, 300)}`,
      );
    }

    return {
      name: functionName,
      args,
    };
  }

  /**
   * Normalize Unicode angle bracket variants to ASCII for reliable XML tag parsing.
   *
   * GLM 4.6 in non-English conversations (especially Japanese) sometimes outputs
   * full-width angle brackets (＜ ＞), other Unicode bracket variants, or
   * adds zero-width characters adjacent to brackets. This method normalizes all
   * known variants to standard ASCII < > so the arg parsing regex can match.
   *
   * @param text - Raw text that may contain non-ASCII angle brackets
   */
  private normalizeXmlBrackets(text: string): string {
    return (
      text
        // Full-width angle brackets: ＜ (ï¼) → <, ＞ (ï¼) → >
        .replace(/\uff1c/g, "<")
        .replace(/\uff1e/g, ">")
        // Angle brackets: 〈 〉 (deprecated but still used)
        .replace(/\u2329/g, "<")
        .replace(/\u232a/g, ">")
        // Mathematical angle brackets: ⟨ ⟩
        .replace(/\u27e8/g, "<")
        .replace(/\u27e9/g, ">")
        .replace(/\u2039/g, "<")
        .replace(/\u203a/g, ">")
        .replace(/\u200b/g, "")
        .replace(/\u200c/g, "")
        .replace(/\u200d/g, "")
        .replace(/\ufeff/g, "")
    );
  }

  /**
   * Fallback argument parser for non-XML tool call formats.
   *
   * GLM 4.6 in non-English conversations sometimes drops the <arg_key>/<arg_value> XML
   * tags and outputs arguments in alternative formats:
   * - JSON object: {"query": "search term", "count": 3}
   * - YAML-style key-value: query: "search term"\ncount: 3
   * - Assignment-style: query="search term"
   *
   * This method attempts each format in order, populating the args object in-place.
   * Parsed keys are normalized through normalizeParamName() and values through coerceArgValue().
   *
   * @param body - Raw text after the function name line, without XML wrapper tags
   * @param args - Args object to populate (mutated in-place)
   */
  private parseToolCallArgsFallback(functionName: string, body: string, args: Record<string, unknown>): void {
    const jsonMatch = body.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [rawKey, rawVal] of Object.entries(parsed)) {
            const argKey = this.normalizeParamName(functionName, rawKey.trim());
            const expectedType = this.getToolParamType(functionName, argKey);
            args[argKey] = this.coerceArgValue(
              typeof rawVal === "string" ? rawVal : JSON.stringify(rawVal),
              expectedType,
            );
          }
          if (Object.keys(args).length > 0) {
            log.info(
              `NovelAI GLM: Fallback parsed ${Object.keys(args).length} arg(s) for "${functionName}" via JSON format`,
            );
            return;
          }
        }
      } catch {}
    }

    // Strategy B: Key-value lines: e.g. "query: LCK LoL schedule\ncount: 5"
    //    Matches patterns: "key: value", "key:value", 'key: "value"', "key: 'value'"
    //    Also handles assignment style: "key=value", 'key="value"'
    const kvLines = body.split("\n");
    for (const line of kvLines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;

      const kvMatch = trimmedLine.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*[:=]\s*(.+)$/);
      if (kvMatch) {
        const rawKey = kvMatch[1].trim();
        let rawValue = kvMatch[2].trim();

        if (
          (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
          (rawValue.startsWith("'") && rawValue.endsWith("'"))
        ) {
          rawValue = rawValue.slice(1, -1);
        }

        const argKey = this.normalizeParamName(functionName, rawKey);
        const expectedType = this.getToolParamType(functionName, argKey);
        args[argKey] = this.coerceArgValue(rawValue, expectedType);
      }
    }

    if (Object.keys(args).length > 0) {
      log.info(
        `NovelAI GLM: Fallback parsed ${Object.keys(args).length} arg(s) for "${functionName}" via key-value format`,
      );
    }
  }

  /**
   * Normalize a tool name from model output to match a registered tool definition.
   *
   * GLM 4.6 frequently outputs tool names that don't exactly match the registration:
   * - Underscore/hyphen swaps: "web_search" vs "web-search"
   * - Truncated prefixes: "eb_search" instead of "web_search" (high-temp sampling drops tokens)
   *
   * Matching strategy (in priority order):
   * 1. Exact match
   * 2. Underscore → hyphen conversion
   * 3. Hyphen → underscore conversion
   * 4. Suffix match: if the raw name is a suffix of exactly one registered tool (handles dropped prefix tokens)
   *
   */
  private normalizeToolName(rawName: string): string {
    if (this.toolDefinitions.some((tool) => tool.name === rawName)) {
      return rawName;
    }

    const hyphenName = rawName.replace(/_/g, "-");
    if (this.toolDefinitions.some((tool) => tool.name === hyphenName)) {
      return hyphenName;
    }

    const underscoreName = rawName.replace(/-/g, "_");
    if (this.toolDefinitions.some((tool) => tool.name === underscoreName)) {
      return underscoreName;
    }

    // Suffix match: handles dropped prefix tokens from high-temperature sampling.
    //    e.g., model outputs "eb_search" (missing "w"), match "web_search".
    //    Also try with underscore/hyphen normalization on both sides.
    const candidates = [rawName, hyphenName, underscoreName];
    const suffixMatches = this.toolDefinitions.filter((tool) =>
      candidates.some((candidate) => tool.name.endsWith(candidate) && candidate.length >= 4),
    );
    if (suffixMatches.length === 1) {
      log.info(`NovelAI GLM: Fuzzy-matched tool name "${rawName}" → "${suffixMatches[0].name}" (suffix match)`);
      return suffixMatches[0].name;
    }

    // Levenshtein distance: catch garbled names that aren't simple suffix truncations.
    //    Use stricter threshold (40%) than param matching since tool namespace is larger.
    let bestLevMatch: NormalizedToolDefinition | undefined;
    let bestLevDist = Number.POSITIVE_INFINITY;
    let secondBestDist = Number.POSITIVE_INFINITY;
    for (const tool of this.toolDefinitions) {
      const minDist = Math.min(...candidates.map((c) => this.levenshteinDistance(c, tool.name)));
      const maxLen = Math.max(rawName.length, tool.name.length);
      if (minDist < bestLevDist && minDist <= Math.ceil(maxLen * 0.4)) {
        secondBestDist = bestLevDist;
        bestLevDist = minDist;
        bestLevMatch = tool;
      } else if (minDist < secondBestDist) {
        secondBestDist = minDist;
      }
    }
    if (bestLevMatch && (secondBestDist - bestLevDist >= 2 || this.toolDefinitions.length <= 2)) {
      log.info(
        `NovelAI GLM: Fuzzy-matched tool name "${rawName}" → "${bestLevMatch.name}" (edit distance: ${bestLevDist})`,
      );
      return bestLevMatch.name;
    }

    return rawName;
  }

  /**
   * Normalize a garbled parameter name from model output to match a registered parameter.
   *
   * GLM 4.6 at higher temperatures drops or garbles tokens in argument names,
   * e.g., "ave_wuery" instead of "query", "ount" instead of "count".
   *
   * Matching strategy:
   * 1. Exact match: parameter exists in the tool definition
   * 2. Suffix match: raw name is a suffix of a known parameter (handles dropped prefix tokens)
   * 3. Best substring match: find the parameter whose name contains the most of the raw name
   *
   */
  private normalizeParamName(functionName: string, rawParamName: string): string {
    const tool = this.toolDefinitions.find((t) => t.name === functionName);
    if (!tool?.parameters?.properties) return rawParamName;

    const knownParams = Object.keys(tool.parameters.properties);

    if (knownParams.includes(rawParamName)) {
      return rawParamName;
    }

    // Suffix match: "uery" matches "query", "ount" matches "count"
    const suffixMatches = knownParams.filter((p) => p.endsWith(rawParamName) && rawParamName.length >= 3);
    if (suffixMatches.length === 1) {
      log.info(`NovelAI GLM: Fuzzy-matched param name "${rawParamName}" → "${suffixMatches[0]}" (suffix match)`);
      return suffixMatches[0];
    }

    // Containment match: raw name contains a known param or vice versa
    //    Handles cases like "ave_wuery" where the model garbles across the name.
    //    Find the known param with the longest common subsequence in the raw name.
    const containmentMatches = knownParams.filter((p) => rawParamName.includes(p) || p.includes(rawParamName));
    if (containmentMatches.length === 1) {
      log.info(
        `NovelAI GLM: Fuzzy-matched param name "${rawParamName}" → "${containmentMatches[0]}" (containment match)`,
      );
      return containmentMatches[0];
    }

    // Best suffix overlap: find the param that shares the longest suffix with rawParamName
    //    e.g., "ave_wuery" shares no direct suffix with "query", but we can check
    //    if the raw name ends with a significant portion of any known param.
    let bestMatch = "";
    let bestOverlap = 0;
    for (const param of knownParams) {
      let overlap = 0;
      const minLen = Math.min(rawParamName.length, param.length);
      for (let i = 1; i <= minLen; i++) {
        if (rawParamName[rawParamName.length - i] === param[param.length - i]) {
          overlap++;
        } else {
          break;
        }
      }
      // Require at least 3 chars overlap and >50% of the shorter name
      if (overlap > bestOverlap && overlap >= 3 && overlap > minLen * 0.5) {
        bestOverlap = overlap;
        bestMatch = param;
      }
    }
    if (bestMatch) {
      log.info(
        `NovelAI GLM: Fuzzy-matched param name "${rawParamName}" → "${bestMatch}" (suffix overlap: ${bestOverlap} chars)`,
      );
      return bestMatch;
    }

    // Levenshtein distance: catch severely garbled names like "ave_wuery" → "query".
    //    Accept if edit distance is ≤60% of the longer name's length. High tolerance is safe
    //    because the param namespace is small (typically 3-8 params per tool), so false
    //    positives are unlikely. Also requires the best match to be clearly better than runner-up.
    let bestLevMatch = "";
    let bestLevDistance = Number.POSITIVE_INFINITY;
    let secondBestDistance = Number.POSITIVE_INFINITY;
    for (const param of knownParams) {
      const distance = this.levenshteinDistance(rawParamName, param);
      const maxLen = Math.max(rawParamName.length, param.length);
      if (distance < bestLevDistance && distance <= Math.ceil(maxLen * 0.6)) {
        secondBestDistance = bestLevDistance;
        bestLevDistance = distance;
        bestLevMatch = param;
      } else if (distance < secondBestDistance) {
        secondBestDistance = distance;
      }
    }
    // Only accept if there's a clear winner (best is at least 2 edits better than runner-up)
    if (bestLevMatch && (secondBestDistance - bestLevDistance >= 2 || knownParams.length <= 2)) {
      log.info(
        `NovelAI GLM: Fuzzy-matched param name "${rawParamName}" → "${bestLevMatch}" (edit distance: ${bestLevDistance})`,
      );
      return bestLevMatch;
    }

    log.warn(
      `NovelAI GLM: Could not match param name "${rawParamName}" to any known parameter of "${functionName}". Known params: [${knownParams.join(", ")}]`,
    );
    return rawParamName;
  }

  /**
   * Compute the Levenshtein (edit) distance between two strings.
   * Used for fuzzy matching garbled parameter names from GLM output.
   *
   */
  private levenshteinDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;

    const prev = new Array<number>(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;

    for (let i = 1; i <= m; i++) {
      let prevDiag = prev[0];
      prev[0] = i;
      for (let j = 1; j <= n; j++) {
        const temp = prev[j];
        if (a[i - 1] === b[j - 1]) {
          prev[j] = prevDiag;
        } else {
          prev[j] = 1 + Math.min(prevDiag, prev[j - 1], prev[j]);
        }
        prevDiag = temp;
      }
    }

    return prev[n];
  }

  private getToolParamType(functionName: string, argKey: string): ToolParamType | undefined {
    const tool = this.toolDefinitions.find((definition) => definition.name === functionName);
    return tool?.parameters?.properties?.[argKey]?.type;
  }

  private coerceArgValue(rawValue: string, expectedType?: ToolParamType): unknown {
    const trimmed = rawValue.trim();
    const parsed = this.tryParseJson(trimmed);
    if (parsed.success) {
      // If tool schema expects a string but JSON parsed as number/boolean,
      // coerce to string. GLM often outputs bare numbers for ID fields
      // (e.g., discord_id: 684462114022490100 instead of "684462114022490100").
      if (expectedType === "string" && typeof parsed.value !== "string") {
        return String(parsed.value);
      }
      return parsed.value;
    }

    if (expectedType === "number") {
      const numValue = Number.parseFloat(trimmed);
      if (!Number.isNaN(numValue)) {
        return numValue;
      }
    }

    if (expectedType === "boolean") {
      if (trimmed === "true") return true;
      if (trimmed === "false") return false;
    }

    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      return trimmed.slice(1, -1);
    }

    return trimmed;
  }

  private tryParseJson(value: string): { success: boolean; value?: unknown } {
    try {
      return { success: true, value: JSON.parse(value) };
    } catch {
      return { success: false };
    }
  }

  private stripThinkBlocks(text: string): string {
    if (!text) return "";

    let output = "";
    let cursor = 0;

    while (cursor < text.length) {
      if (!this.insideThinkBlock) {
        const startIdx = text.indexOf("<think>", cursor);
        const endIdx = text.indexOf("</think>", cursor);

        if (startIdx === -1 && endIdx === -1) {
          output += text.slice(cursor);
          break;
        }

        if (endIdx !== -1 && (startIdx === -1 || endIdx < startIdx)) {
          output += text.slice(cursor, endIdx);
          cursor = endIdx + "</think>".length;
          continue;
        }

        if (startIdx !== -1) {
          output += text.slice(cursor, startIdx);
          this.insideThinkBlock = true;
          cursor = startIdx + "<think>".length;
        }
      } else {
        const endIdx = text.indexOf("</think>", cursor);
        if (endIdx === -1) {
          this.captureThinkBlockThoughtText(text.slice(cursor));
          cursor = text.length;
          break;
        }

        this.captureThinkBlockThoughtText(text.slice(cursor, endIdx));
        this.insideThinkBlock = false;
        cursor = endIdx + "</think>".length;
      }
    }

    return output;
  }

  private resetToolParsingState(): void {
    this.toolCallMode = this.toolsEnabled ? "undecided" : "disabled";
    this.toolPreludeBuffer = "";
    this.toolCallBuffer = "";
    this.textScanBuffer = "";
    this.insideThinkBlock = false;
  }

  private captureThinkBlockThoughtText(text: string): void {
    if (!text) {
      return;
    }

    this.pendingThinkBlockThoughtText += text;
  }

  private consumePendingThinkBlockThoughts(): ThoughtLogEntry[] {
    if (!this.pendingThinkBlockThoughtText) {
      return [];
    }

    const content = this.pendingThinkBlockThoughtText;
    this.pendingThinkBlockThoughtText = "";
    return [
      {
        kind: "raw",
        content,
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

  private normalizeToolDefinitions(tools: Array<Record<string, unknown>>): NormalizedToolDefinition[] {
    const normalized: NormalizedToolDefinition[] = [];

    for (const tool of tools) {
      if (!tool || typeof tool !== "object") continue;
      const toolObj = tool as Record<string, unknown>;

      if ("function" in toolObj && toolObj.function) {
        const fn = toolObj.function as {
          name?: string;
          description?: string;
          parameters?: ToolParameterSchema;
        };
        if (fn.name) {
          normalized.push({
            name: fn.name,
            description: fn.description,
            parameters: fn.parameters,
          });
        }
        continue;
      }

      if (typeof toolObj.name === "string") {
        normalized.push({
          name: toolObj.name,
          description: typeof toolObj.description === "string" ? toolObj.description : undefined,
          parameters: typeof toolObj.parameters === "object" ? (toolObj.parameters as ToolParameterSchema) : undefined,
        });
      }
    }

    return normalized;
  }

  /**
   * Build tool calling guide using GLM 4.6's official <tools> XML format.
   * Matches the Jinja chat template structure from the reference implementation.
   *
   * @returns Formatted tool guide string, or null if no tools
   */
  private buildToolCallingGuide(toolDefinitions: NormalizedToolDefinition[]): string | null {
    if (!toolDefinitions.length) return null;

    const lines: string[] = [
      "# Tools",
      "",
      "You may call one or more functions to assist with the user query.",
      "",
      "You are provided with function signatures within <tools></tools> XML tags:",
      "<tools>",
    ];

    // Emit each tool as a JSON object (matching the Jinja template's `tool | tojson`)
    for (const tool of toolDefinitions) {
      const toolJson: Record<string, unknown> = {
        name: tool.name,
      };
      if (tool.description) {
        toolJson.description = tool.description;
      }
      if (tool.parameters) {
        toolJson.parameters = tool.parameters;
      }
      lines.push(JSON.stringify(toolJson));
    }

    lines.push("</tools>");
    lines.push("");
    lines.push("For each function call, output the function name and arguments within the following XML format:");
    lines.push("<tool_call>{function-name}");
    lines.push("<arg_key>{arg-key-1}</arg_key>");
    lines.push("<arg_value>{arg-value-1}</arg_value>");
    lines.push("<arg_key>{arg-key-2}</arg_key>");
    lines.push("<arg_value>{arg-value-2}</arg_value>");
    lines.push("...");
    lines.push("</tool_call>");

    return lines.join("\n");
  }

  /**
   * Recursively strip fetch capability reminder fields from tool response objects.
   * GLM 4.6 has a strict prompt token budget, and these fields waste tokens on
   * a capability (fetch MCP) that is disabled for NovelAI.
   * @returns A deep copy with agentInstructions and fetchCapabilityReminder removed
   */
  private stripFetchReminderFields(obj: Record<string, unknown>): Record<string, unknown> {
    const keysToStrip = new Set(["agentInstructions", "fetchCapabilityReminder"]);

    const strip = (value: unknown): unknown => {
      if (Array.isArray(value)) {
        return value.map(strip);
      }
      if (value !== null && typeof value === "object") {
        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (!keysToStrip.has(k)) {
            result[k] = strip(v);
          }
        }
        return result;
      }
      return value;
    };

    return strip(obj) as Record<string, unknown>;
  }

  /**
   * Build tool interaction history in flat text format (Kayra).
   * Uses simple [Tool Result] labels without GLM role tags.
   */
  private buildToolHistoryFlat(
    history: StreamContext["functionInteractionHistory"] = [],
    messageIdMap?: StreamContext["messageIdMap"],
  ): string | null {
    if (!history.length) return null;

    const lines: string[] = ["[System: Tool Call History]"];

    for (const item of history) {
      lines.push(this.formatToolCallForPrompt(item.functionCall));

      // Strip fetch capability reminder fields recursively to save tokens
      const sanitizedResponse = this.stripFetchReminderFields(item.functionResponse);
      lines.push(`[System: Tool result] ${JSON.stringify(sanitizedResponse)}`);

      if (item.imageMetadata?.messageIds?.length) {
        lines.push(
          `[System: Images sent to Discord message ID(s): ${item.imageMetadata.messageIds.map((id) => messageIdMap?.register(id, "media") ?? id).join(", ")}]`,
        );
      }
    }

    return lines.join("\n");
  }

  /**
   * Build tool interaction history using GLM 4.6 role tags.
   * Each tool call/response pair uses proper <|assistant|> + <|observation|> structure.
   *
   */
  private buildToolHistoryGlm(
    history: StreamContext["functionInteractionHistory"] = [],
    messageIdMap?: StreamContext["messageIdMap"],
  ): Array<{ role: "assistant" | "observation"; content: string }> {
    if (!history.length) return [];

    const turns: Array<{
      role: "assistant" | "observation";
      content: string;
    }> = [];

    for (const item of history) {
      // Assistant turn: include any text the model already streamed before the tool call,
      // so it doesn't repeat itself on the continuation pass.
      const assistantParts: string[] = [];

      if (item.preToolCallTextParts?.length) {
        for (const part of item.preToolCallTextParts) {
          const text = (part as { text?: string }).text;
          if (text?.trim()) {
            assistantParts.push(text.trim());
          }
        }
      }

      const toolCallLines: string[] = [];
      toolCallLines.push(`<tool_call>${item.functionCall.name}`);
      const args = item.functionCall.args ?? {};
      for (const [key, value] of Object.entries(args)) {
        toolCallLines.push(`<arg_key>${key}</arg_key>`);
        toolCallLines.push(`<arg_value>${JSON.stringify(value)}</arg_value>`);
      }
      toolCallLines.push("</tool_call>");
      assistantParts.push(toolCallLines.join("\n"));

      turns.push({
        role: "assistant",
        content: assistantParts.join("\n"),
      });

      // Observation turn with tool response
      // Strip fetch capability reminder fields recursively to save tokens because
      // GLM 4.6 has a strict prompt budget, and fetch MCP is disabled for NovelAI.
      const sanitizedResponse = this.stripFetchReminderFields(item.functionResponse);
      const responseLines: string[] = ["<tool_response>"];
      responseLines.push(JSON.stringify(sanitizedResponse));
      responseLines.push("</tool_response>");

      if (item.imageMetadata?.messageIds?.length) {
        responseLines.push(
          `[System: Images sent to Discord message ID(s): ${item.imageMetadata.messageIds.map((id) => messageIdMap?.register(id, "media") ?? id).join(", ")}]`,
        );
      }

      turns.push({
        role: "observation",
        content: responseLines.join("\n"),
      });
    }

    return turns;
  }

  private formatToolCallForPrompt(functionCall: FunctionCall): string {
    const lines: string[] = [`<tool_call>${functionCall.name}`];
    const args = functionCall.args ?? {};

    for (const [key, value] of Object.entries(args)) {
      lines.push(`<arg_key>${key}</arg_key><arg_value>${JSON.stringify(value)}</arg_value>`);
    }

    lines.push("</tool_call>");
    return lines.join("\n");
  }

  /**
   * Handle NovelAI-specific errors
   */
  handleProviderError(error: unknown): ProviderError {
    const errorMessage = error instanceof Error ? error.message : String(error);

    let statusCode: number | undefined;

    // First, check if error has statusCode property (from validateNovelAIApiKey)
    if (error && typeof error === "object" && "statusCode" in error) {
      statusCode = error.statusCode as number;
    }

    // Fallback: try to extract from error message
    if (!statusCode) {
      const statusMatch = errorMessage.match(/\((\d{3})\)/);
      if (statusMatch) {
        statusCode = Number.parseInt(statusMatch[1], 10);
      }
    }

    let errorType: ProviderError["type"];
    let retryable: boolean;

    if (statusCode === 400) {
      errorType = "api_error";
      retryable = false;
    } else if (statusCode === 401 || isNovelAIApiKeyError(errorMessage, statusCode)) {
      errorType = "api_error";
      retryable = false;
    } else if (statusCode === 402 || isNovelAICreditsError(errorMessage, statusCode)) {
      errorType = "api_error";
      retryable = false;
    } else if (statusCode === 429 || isNovelAIRateLimitError(errorMessage, statusCode)) {
      errorType = "rate_limit";
      retryable = true;
    } else if (statusCode === 500 || statusCode === 502) {
      errorType = "api_error";
      retryable = true;
    } else if (statusCode === 503) {
      errorType = "provider_overloaded";
      retryable = true;
    } else if (statusCode === 504 || errorMessage.toLowerCase().includes("timeout")) {
      errorType = "timeout";
      retryable = true;
    } else {
      errorType = "api_error";
      retryable = false;
    }

    return {
      type: errorType,
      message: `NovelAI API error${statusCode ? ` (${statusCode})` : ""}: ${errorMessage}`,
      code: statusCode?.toString() || "unknown",
      retryable,
      originalError: error,
    };
  }

  createErrorDescription(error: ProviderError, locale: string): string | null {
    const errorCode = error.code;
    let messageKey: string;

    const errorMessage = error.message.toLowerCase();
    if (errorCode === "400" && (errorMessage.includes("recaptcha") || errorMessage.includes("trial generation"))) {
      messageKey = "400_trial_message";
    } else {
      switch (error.type) {
        case "rate_limit":
          messageKey = "429_default_message";
          break;
        case "timeout":
          messageKey = "504_default_message";
          break;
        case "provider_overloaded":
          messageKey = "503_default_message";
          break;
        case "api_error":
          if (errorCode === "400") {
            messageKey = "400_default_message";
          } else if (errorCode === "401") {
            messageKey = "401_default_message";
          } else if (errorCode === "402") {
            messageKey = "402_default_message";
          } else {
            messageKey = "unknown_default_message";
          }
          break;
        default:
          messageKey = "unknown_default_message";
          break;
      }
    }

    try {
      const novelaiMessage = localizer(locale, `genai.novelai.${messageKey}`);

      // If this is an unknown error, append the actual API response for debugging
      if (messageKey === "unknown_default_message") {
        // Truncate error message to avoid Discord embed limits (max description is 4096, leave room for other text)
        const maxErrorLength = 1000;
        const apiErrorSnippet =
          error.message.length > maxErrorLength ? `${error.message.substring(0, maxErrorLength)}...` : error.message;
        return `Error Code ${errorCode}: ${novelaiMessage}\n\n**API Response:**\n${apiErrorSnippet}`;
      }

      return `Error Code ${errorCode}: ${novelaiMessage}`;
    } catch {
      // Fallback if locale key doesn't exist
      return `Error Code ${errorCode}: ${error.message}`;
    }
  }

  /**
   * Assemble context items into NovelAI's expected flat text format
   *
   * Format:
   * [System instructions]
   *
   * Username1: message1
   * BotName: response1
   * Username2: message2
   * BotName:
   */
  /**
   * Builds the ATTG metadata block for Kayra/Erato prompts.
   *
   * Kayra was trained on stories prefixed with [ Author: X; Title: Y; Tags: Z; Genre: W ] blocks.
   * Erato additionally supports a [ S: N ] quality-star block.
   * Returns null when no ATTG metadata is configured on the persona.
   *
   * @param tomoriState - Current persona state with optional ATTG fields
   * @param model - NAI model codename (e.g. 'llama-3-erato-v1')
   * @returns Formatted ATTG string or null
   */
  private buildAttgBlock(tomoriState: import("@/types/db/schema").TomoriState, model: string): string | null {
    const parts: string[] = [];
    if (tomoriState.nai_attg_author?.trim()) parts.push(`Author: ${tomoriState.nai_attg_author.trim()}`);
    if (tomoriState.nai_attg_title?.trim()) parts.push(`Title: ${tomoriState.nai_attg_title.trim()}`);
    if (tomoriState.nai_attg_tags?.trim()) parts.push(`Tags: ${tomoriState.nai_attg_tags.trim()}`);
    if (tomoriState.nai_attg_genre?.trim()) parts.push(`Genre: ${tomoriState.nai_attg_genre.trim()}`);

    // Build the main block only if at least one field is populated
    const mainBlock = parts.length > 0 ? `[ ${parts.join("; ")} ]` : "";

    const isErato = model === "llama-3-erato-v1";
    const stars = tomoriState.nai_attg_stars;
    const starsBlock = isErato && stars != null && stars >= 1 && stars <= 5 ? `[ S: ${stars} ]` : "";

    const full = `${mainBlock}${starsBlock}`;
    return full || null;
  }

  /**
   * Assemble a Kayra/Erato prompt using NovelAI story-format conventions.
   *
   * These models were trained on story data that uses specific formatting tokens.
   * Matching that format improves coherence and persona consistency.
   *
   * Output structure:
   * ```
   * [ Tags: X; Genre: Y ][ S: N ]   ← ATTG block (if configured)
   *
   * Characters:
   * {botName}
   * {SYSTEM_PERSONALITY text}
   *
   * {SYSTEM_INSTRUCTION_BLOCK / SYSTEM_HUMANIZER_RULES / KNOWLEDGE_SERVER_INFO text}
   *
   * Server Notes:
   * {KNOWLEDGE_SERVER_MEMORIES text}   ← only if non-empty
   * ***
   * {CONTEXT_INJECTION text}           ← e.g. [System: users in conversation]  (only if non-empty)
   * ***
   * [ Style: chat ]
   * {sample dialogue turns}            ← reference examples  (only if non-empty)
   * ***
   * [ Style: chat ]
   * {live history turns}
   * ```
   *
   * @param options - Tool definitions, function interaction history, and optional ATTG block
   */
  private assembleNovelAIPrompt(
    contextItems: StructuredContextItem[],
    botName: string,
    options?: {
      toolDefinitions?: NormalizedToolDefinition[];
      functionInteractionHistory?: StreamContext["functionInteractionHistory"];
      attgBlock?: string | null;
      messageIdMap?: StreamContext["messageIdMap"];
    },
  ): string {
    // Separate sample dialogue (reference) from live history so a *** dinkus
    // can be inserted between them in the assembled prompt.
    const sampleDialogueParts: string[] = [];
    const contextParts: string[] = []; // pre-chat injections (e.g. [System: users info])
    const historyParts: string[] = [];
    const includeTools = (options?.toolDefinitions?.length ?? 0) > 0;
    const systemTags = this.getSystemInstructionTags(includeTools);

    let personalityText = "";
    let memoriesText = "";
    const instructionParts: string[] = [];

    // Pre-scan: extract the primary user speaker label from DIALOGUE_HISTORY items
    // so DIALOGUE_SAMPLE user turns can be labeled consistently (e.g. "Ellen: message").
    let defaultSpeakerLabel = "User";
    for (const scanItem of contextItems) {
      if (scanItem.metadataTag === ContextItemTag.DIALOGUE_HISTORY && scanItem.role === "user") {
        const scanText = scanItem.parts
          .filter((p) => p.type === "text")
          .map((p) => (p as { type: "text"; text: string }).text)
          .join("\n");
        const labelMatch = scanText.match(/^([^\n:]+):\s/);
        if (labelMatch) {
          defaultSpeakerLabel = labelMatch[1];
          break;
        }
      }
    }

    for (const item of contextItems) {
      // Extract text content from parts (images/video unsupported in NAI)
      const textContent = item.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { type: "text"; text: string }).text)
        .join("\n");

      if (!textContent) continue;

      if (item.metadataTag && systemTags.includes(item.metadataTag)) {
        switch (item.metadataTag) {
          case ContextItemTag.SYSTEM_PERSONALITY:
            personalityText = textContent;
            break;
          case ContextItemTag.KNOWLEDGE_SERVER_MEMORIES:
            memoriesText = textContent;
            break;
          default:
            instructionParts.push(textContent);
        }
      } else if (!item.metadataTag && item.role === "system") {
        instructionParts.push(textContent);
      }

      // Dialogue turns (user/model) that are not system-tagged go to dialogue.
      //    DIALOGUE_SAMPLE  → sampleDialogueParts (reference material)
      //    DIALOGUE_HISTORY → historyParts (live conversation turns)
      //    Untagged items   → contextParts (e.g. [System: users in conversation];
      //                       placed before samples so context precedes reference)
      if (
        (item.role === "user" || item.role === "model") &&
        !(item.metadataTag && systemTags.includes(item.metadataTag))
      ) {
        if (item.metadataTag === ContextItemTag.DIALOGUE_SAMPLE) {
          // Prepend speaker label to user turns that lack one, matching DIALOGUE_HISTORY format
          if (item.role === "user" && !/^[^\n:]+:\s/.test(textContent)) {
            sampleDialogueParts.push(`${defaultSpeakerLabel}: ${textContent}`);
          } else {
            sampleDialogueParts.push(textContent);
          }
        } else if (item.metadataTag === ContextItemTag.DIALOGUE_HISTORY) {
          historyParts.push(textContent);
        } else {
          contextParts.push(textContent);
        }
      }
    }

    if (includeTools) {
      const toolGuide = this.buildToolCallingGuide(options?.toolDefinitions ?? []);
      if (toolGuide) instructionParts.push(toolGuide);

      const toolHistory = this.buildToolHistoryFlat(options?.functionInteractionHistory ?? [], options?.messageIdMap);
      if (toolHistory) instructionParts.push(toolHistory);
    }

    // Assemble formatted blocks using NAI story-format conventions.
    //    Each section is preceded by a '----' info divider.
    const systemBlocks: string[] = [];

    if (personalityText) {
      systemBlocks.push(`Characters:\n${botName}\n${personalityText}`);
    }

    const instructionText = instructionParts.join("\n\n");
    if (instructionText) {
      systemBlocks.push(`${instructionText}`);
    }

    if (memoriesText) {
      systemBlocks.push(`Server Notes:\n${memoriesText}`);
    }

    const attgPrefix = options?.attgBlock ? `${options.attgBlock}\n` : "";
    const systemHeader = systemBlocks.length > 0 ? `${attgPrefix}${systemBlocks.join("\n")}` : attgPrefix.trimEnd();

    // Combine: system header + context + [ Style: chat ] + samples + *** + [ Style: chat ] + history.
    //    Context injections (e.g. [System: users in conversation]) sit with the system header
    //    so the model sees who's present before reading any dialogue.
    //    [ Style: chat ] precedes BOTH the sample dialogues and the live history so Kayra/Erato
    //    recognises each dialogue block independently as chat-format content.
    const contextText = contextParts.join("\n");
    const sampleText = sampleDialogueParts.join("\n");
    const historyText = historyParts.join("\n");

    const systemSection = [systemHeader, contextText].filter((p) => p?.trim()).join("\n***\n");

    // Each dialogue block gets its own [ Style: chat ] tag so the model treats both
    //     reference samples and live history as chat-format exchanges.
    const styledSampleText = sampleText.trim() ? `[ Style: chat ]\n${sampleText}` : "";
    const styledHistoryText = historyText.trim() ? `[ Style: chat ]\n${historyText}` : "";

    const parts = [systemSection, styledSampleText, styledHistoryText].filter((p) => p?.trim());
    return parts.join("\n***\n");
  }

  /**
   * Assemble a GLM 4.6 chat prompt using the official chat template.
   *
   * Structure:
   * ```
   * [gMASK]<sop>
   * <|system|>
   * {consolidated system instructions + tool definitions}
   *
   * <|user|>
   * Alice: Hello there!
   * <|assistant|>
   * <think></think>
   * Hi Alice!
   * ...
   * <|assistant|>
   * <think></think>
   * ```
   *
   * Key decisions:
   * - User turns keep speaker labels (multi-user Discord needs disambiguation)
   * - Assistant turns have bot name STRIPPED by default: <|assistant|> is sufficient, and
   *   including "Tomori:" causes garbled name artifacts (e.g., "Tomo", "Tomorleasing").
   *   Set NAI_GLM_CHAR_PREFIX_ENABLED=false to strip the name (legacy behaviour).
   * - Thinking mode is controlled by NAI_GLM_THINKING_ENABLED env var (default: true).
   *   When enabled, <think></think> seeds each assistant turn; when disabled, /nothink
   *   is appended instead to suppress internal reasoning.
   * - If the model decides to think, any <think>...</think> blocks are stripped by
   *   stripThinkBlocks() in the streaming pipeline
   * - Tool definitions use <tools> XML format in the system block
   * - Tool history uses <|assistant|> + <tool_call> + <|observation|> structure
   *
   */
  private assembleGlmChatPrompt(
    contextItems: StructuredContextItem[],
    botName: string,
    options?: {
      toolDefinitions?: NormalizedToolDefinition[];
      functionInteractionHistory?: StreamContext["functionInteractionHistory"];
      messageIdMap?: StreamContext["messageIdMap"];
      thinkingLevel?: string | null;
      forceReason?: boolean;
    },
  ): string {
    const systemInstructionParts: string[] = [];
    const dialogueTurns: Array<{
      role: "user" | "model";
      content: string;
    }> = [];
    const includeTools = (options?.toolDefinitions?.length ?? 0) > 0;
    const systemTags = this.getSystemInstructionTags(includeTools);

    for (const item of contextItems) {
      const textContent = item.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { type: "text"; text: string }).text)
        .join("\n");

      if (!textContent) {
        // Skip items with no text (images/videos: NovelAI doesn't support these)
        continue;
      }

      if (item.metadataTag) {
        if (systemTags.includes(item.metadataTag)) {
          systemInstructionParts.push(textContent);
        }
      } else if (item.role === "system") {
        systemInstructionParts.push(textContent);
      }

      if ((item.role === "user" || item.role === "model") && textContent) {
        const isInSystemTags = item.metadataTag && systemTags.includes(item.metadataTag);

        if (!isInSystemTags) {
          dialogueTurns.push({
            role: item.role,
            content: textContent,
          });
        }
      }
    }

    if (includeTools) {
      const toolGuide = this.buildToolCallingGuide(options?.toolDefinitions ?? []);
      if (toolGuide) {
        systemInstructionParts.push(toolGuide);
      }
    }

    // Thinking directive: <think></think> seeds the expected format when thinking is enabled;
    // /nothink explicitly disables internal reasoning when thinking is turned off.
    const thinkDirective = getNovelAiThinkingDirective(options?.thinkingLevel, options?.forceReason);
    const promptParts: string[] = [];

    promptParts.push("[gMASK]<sop>");

    if (systemInstructionParts.length > 0) {
      promptParts.push("<|system|>");
      promptParts.push(systemInstructionParts.join("\n\n"));
    }

    // Dialogue turns with proper role tags
    // By default, strip the bot's speaker label from assistant turns:
    // the <|assistant|> tag already identifies who's speaking, and including
    // "Tomori:" in the content causes the model to try re-generating partial/garbled
    // name prefixes (e.g., "Tomo", "Tomorleasing").
    // When NAI_GLM_CHAR_PREFIX_ENABLED is enabled, the prefix is kept to mirror how other
    // providers format context (sample dialogues + history both include "{char}: message"),
    // which may help the model adopt the persona voice more consistently.
    const botNamePrefixPattern = new RegExp(`^${escapeRegExp(botName)}:\\s*`, "i");

    for (const turn of dialogueTurns) {
      if (turn.role === "user") {
        promptParts.push("<|user|>");
        promptParts.push(turn.content);
      } else if (turn.role === "model") {
        promptParts.push("<|assistant|>");
        promptParts.push(thinkDirective);
        if (NAI_GLM_CHAR_PREFIX_ENABLED) {
          // Debug: keep "BotName:" prefix to test persona-voice consistency
          promptParts.push(turn.content);
        } else {
          // Default: strip prefix: <|assistant|> tag is the structural signal
          promptParts.push(turn.content.replace(botNamePrefixPattern, ""));
        }
      }
    }

    // Tool interaction history (after dialogue, before generation prompt).
    //    Include even when tools are disabled for the current iteration:
    //    the model needs to see prior tool calls (and failures) plus any text
    //    it already streamed, so it doesn't repeat itself.
    if (options?.functionInteractionHistory?.length) {
      const toolTurns = this.buildToolHistoryGlm(options.functionInteractionHistory, options.messageIdMap);
      for (const toolTurn of toolTurns) {
        if (toolTurn.role === "assistant") {
          promptParts.push("<|assistant|>");
          promptParts.push(thinkDirective);
          promptParts.push(toolTurn.content);
        } else if (toolTurn.role === "observation") {
          promptParts.push("<|observation|>");
          promptParts.push(toolTurn.content);
        }
      }
    }

    // Generation prompt: signal the model to generate the assistant's response.
    // thinkDirective is either <think></think> (seeds thinking format) or /nothink (disables reasoning).
    promptParts.push("<|assistant|>");
    promptParts.push(thinkDirective);

    // Debug: append "{botName}:" as a true prefill after the think directive, mirroring how
    // Kayra (flat prompt) appends the bot name at the end. This steers the model to respond
    // in the persona's voice from the very first token.
    if (NAI_GLM_CHAR_PREFIX_ENABLED) {
      promptParts.push(`${botName}:`);
    }

    return promptParts.join("\n");
  }

  private logSanitizedRequest(request: NovelAIGenerationRequest, promptLength: number): void {
    log.section("NovelAIStreamAdapter: Request Details");

    log.info(`Model: ${request.model}`);
    log.info(`Prompt Length: ${promptLength} characters`);
    log.info(`Parameters: temperature=${request.parameters.temperature}, max_length=${request.parameters.max_length}`);
    if (this.toolsEnabled) {
      log.info(`Tool calling enabled (tools=${this.toolDefinitions.length})`);
    }
  }
}
