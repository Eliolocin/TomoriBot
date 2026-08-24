/**
 * Anthropic-specific streaming adapter
 *
 * Implements the StreamProvider interface for Anthropic's Messages API.
 * Uses raw fetch + SSE parsing (no SDK) for consistency with other providers.
 *
 * Key Anthropic API differences from OpenAI:
 * - System prompt is a top-level `system` parameter, not a message
 * - Messages use content blocks: [{type: "text", ...}, {type: "image", ...}]
 * - Tool results are wrapped in user messages as tool_result content blocks
 * - Strict user/assistant alternation is enforced
 * - SSE uses named events: content_block_start, content_block_delta, etc.
 */

import type { FunctionCall, FunctionResponseImageMetadata, ThoughtLogEntry } from "../../types/provider/interfaces";
import { ContextItemTag, type StructuredContextItem } from "../../types/misc/context";
import { log } from "../../utils/misc/logger";
import { localizer } from "../../utils/text/localizer";
import { fetchAndOptimizeImage } from "../../utils/image/imageProcessor";
import { isParamDisabled, selectAnthropicSamplingParams } from "@/utils/provider/samplingControl";
import { buildAnthropicThinkingRequest } from "@/utils/provider/thinkingControl";
import {
  assistantMediaRelocationNotice,
  CONVERSATION_START_USER_TEXT,
  ensureLeadingUserTurn,
  mergeConsecutiveSameRole,
  type NormalizableMessage,
  providerRequiresAlternation,
  relocateAssistantMediaContextItems,
} from "../utils/strictChatCompat";
import { buildProviderStopStrings } from "../utils/stopStrings";
import { BaseStreamAdapter } from "../../types/stream/interfaces";
import type {
  ProcessedChunk,
  ProviderError,
  RawStreamChunk,
  StreamConfig,
  StreamContext,
} from "../../types/stream/interfaces";

/**
 * Anthropic-specific stream configuration extending the base StreamConfig
 */
export interface AnthropicStreamConfig extends StreamConfig {
  seesImages?: boolean;
  topP?: number;
  topK?: number;
}

/**
 * Anthropic content block types used in messages and streaming
 */
interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
}

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock;

/**
 * Anthropic message format
 */
interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

/**
 * Accumulated tool call data across streaming chunks
 */
interface AccumulatedToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

/**
 * SSE event types from Anthropic's streaming API
 */
type AnthropicSseEventType =
  | "message_start"
  | "content_block_start"
  | "content_block_delta"
  | "content_block_stop"
  | "message_delta"
  | "message_stop"
  | "ping"
  | "error";

/**
 * Parsed SSE event with both event type and data payload
 */
interface ParsedSseEvent {
  eventType: AnthropicSseEventType;
  data: unknown;
}

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
// Tags that should be extracted to the top-level system parameter
const SYSTEM_INSTRUCTION_TAGS: ContextItemTag[] = [
  ContextItemTag.SYSTEM_HUMANIZER_RULES,
  ContextItemTag.SYSTEM_PERSONA_PROMPT,
  ContextItemTag.SYSTEM_PERSONALITY,
  ContextItemTag.KNOWLEDGE_SERVER_INFO,
  ContextItemTag.KNOWLEDGE_SERVER_EMOJIS,
  ContextItemTag.KNOWLEDGE_SERVER_STICKERS,
  ContextItemTag.KNOWLEDGE_SERVER_MEMORIES,
];

export class AnthropicStreamAdapter extends BaseStreamAdapter {
  private toolCallAccumulator: Map<number, AccumulatedToolCall> = new Map();
  private thinkingAccumulator = "";
  private currentContentBlockIndex = -1;
  private stopReason: string | null = null;
  private inputTokens = 0;
  private outputTokens = 0;

  constructor() {
    super({
      name: "anthropic",
      version: "1.0.0",
      supportsFunctionCalling: true,
    });
  }

  /**
   * Initialize and start the streaming process with Anthropic's Messages API
   */
  async *startStream(config: StreamConfig, context: StreamContext): AsyncGenerator<RawStreamChunk, void, unknown> {
    this.toolCallAccumulator.clear();
    this.thinkingAccumulator = "";
    this.currentContentBlockIndex = -1;
    this.stopReason = null;
    this.inputTokens = 0;
    this.outputTokens = 0;

    const anthropicConfig = config as AnthropicStreamConfig;

    // Assemble context into Anthropic message format.
    //    Strict role alternation is resolved from the active llms column (D4 column-is-truth);
    //    providerRequiresAlternation("anthropic") is the request-time safety net that keeps it
    //    ON even if a row were mis-seeded.
    const enforceAlternation =
      providerRequiresAlternation("anthropic") || (context.tomoriState.llm?.strict_role_alternation ?? false);
    const { systemPrompt, messages } = await this.assembleAnthropicContext(
      context.contextItems,
      context.currentTurnModelParts,
      context.functionInteractionHistory,
      anthropicConfig.seesImages ?? true,
      enforceAlternation,
    );

    log.info(
      `AnthropicStreamAdapter: Assembled ${messages.length} messages, system prompt: ${systemPrompt?.length ?? 0} chars`,
    );

    const requestBody: Record<string, unknown> = {
      model: config.model,
      max_tokens: config.maxOutputTokens || DEFAULT_MAX_OUTPUT_TOKENS,
      stream: true,
      messages,
    };

    // Add system prompt as top-level parameter (not in messages)
    if (systemPrompt) {
      requestBody.system = systemPrompt;
    }

    if (config.tools && Array.isArray(config.tools) && config.tools.length > 0) {
      requestBody.tools = config.tools;
    }

    const thinkingRequest = buildAnthropicThinkingRequest(
      config.model,
      context.tomoriState.config.thinking_level,
      config.forceReason,
    );
    if (thinkingRequest.thinking) {
      requestBody.thinking = thinkingRequest.thinking;
    }
    if (thinkingRequest.output_config) {
      requestBody.output_config = thinkingRequest.output_config;
    }

    // Add sampling parameters when thinking mode does not suppress them
    if (!thinkingRequest.omitSampling) {
      const samplingSelection = selectAnthropicSamplingParams({
        temperature: config.temperature,
        topP: anthropicConfig.topP,
        disabledParams: config.disabledParams ?? [],
      });
      if (samplingSelection.logMessage) {
        const logger = samplingSelection.logLevel === "warn" ? log.warn : log.info;
        logger(samplingSelection.logMessage);
      }
      if (samplingSelection.temperature !== undefined) {
        requestBody.temperature = samplingSelection.temperature;
      }
      if (samplingSelection.topP !== undefined) {
        requestBody.top_p = samplingSelection.topP;
      }

      if (
        anthropicConfig.topK !== undefined &&
        anthropicConfig.topK > 0 &&
        !isParamDisabled(config.disabledParams ?? [], "topK")
      ) {
        requestBody.top_k = anthropicConfig.topK;
      }
    }

    const stopSequences = buildProviderStopStrings({
      providerName: "anthropic",
      model: config.model,
      personaName: context.prefixStrippingName ?? context.personaUsername,
      configuredStops: context.tomoriState.config.llm_stop_strings,
      includePersonaSpeakerStop: context.tomoriState.config.llm_stop_speaker_pattern_enabled ?? false,
    });
    if (stopSequences) {
      requestBody.stop_sequences = stopSequences;
      log.info(`AnthropicStreamAdapter: Added stop sequences`);
    }

    if (context.outputPrefill?.trim()) {
      // Anthropic supports assistant prefill natively by adding an assistant message
      const prefill = context.outputPrefill.trim();
      messages.push({
        role: "assistant",
        content: prefill,
      });
      log.info(`AnthropicStreamAdapter: Added prefill assistant message (${prefill.length} chars)`);
    }

    log.info(`AnthropicStreamAdapter: Starting stream for model ${config.model}, max_tokens ${requestBody.max_tokens}`);

    this.logSanitizedRequest(requestBody);

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
    };

    const response = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: context.abortSignal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorData: unknown;
      try {
        errorData = JSON.parse(errorText);
      } catch {
        errorData = { message: errorText };
      }

      log.error(`AnthropicStreamAdapter: HTTP ${response.status} error: ${errorText}`);

      const anthropicError = new Error(JSON.stringify({ error: errorData }));
      Object.assign(anthropicError, { statusCode: response.status });
      yield this.createProviderErrorChunk(anthropicError, context);
      return;
    }

    if (!response.body) {
      throw new Error("Anthropic response body is null");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let pendingEventType: string | null = null;
    let completed = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          completed = true;
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmedLine = line.trim();

          // Skip empty lines and comments
          if (!trimmedLine || trimmedLine.startsWith(":")) {
            continue;
          }

          if (trimmedLine.startsWith("event:")) {
            pendingEventType = trimmedLine.slice(6).trim();
            continue;
          }

          // Process data line (requires preceding event type)
          if (trimmedLine.startsWith("data:")) {
            const dataStr = trimmedLine.slice(5).trim();
            if (!dataStr) {
              continue;
            }

            try {
              const parsed = JSON.parse(dataStr);
              const sseEvent: ParsedSseEvent = {
                eventType: (pendingEventType || parsed.type) as AnthropicSseEventType,
                data: parsed,
              };
              pendingEventType = null;

              yield {
                data: sseEvent,
                provider: "anthropic",
              };
            } catch (_parseErr) {
              log.warn(`AnthropicStreamAdapter: Failed to parse SSE data: ${dataStr.substring(0, 100)}`);
            }
          }
        }
      }

      if (buffer.trim()) {
        const remaining = buffer.trim();
        if (remaining.startsWith("data:")) {
          const dataStr = remaining.slice(5).trim();
          try {
            const parsed = JSON.parse(dataStr);
            yield {
              data: {
                eventType: (pendingEventType || parsed.type) as AnthropicSseEventType,
                data: parsed,
              } satisfies ParsedSseEvent,
              provider: "anthropic",
            };
          } catch {}
        }
      }
    } finally {
      // `releaseLock` only detaches the reader: the body stays open and keeps its buffers and
      // connection. A consumer that stops iterating this generator early would otherwise leak them.
      if (!completed) {
        await reader.cancel().catch(() => undefined);
      }
    }
  }

  /**
   * Convert a raw Anthropic SSE event into a normalized ProcessedChunk
   */
  processChunk(chunk: RawStreamChunk): ProcessedChunk {
    if (
      typeof chunk.data === "object" &&
      chunk.data !== null &&
      "error" in chunk.data &&
      (chunk.data as { error?: unknown }).error
    ) {
      return {
        type: "error",
        error: (chunk.data as { error: ProviderError }).error,
      };
    }

    const sseEvent = chunk.data as ParsedSseEvent;
    const { eventType, data } = sseEvent;
    const thoughts: ThoughtLogEntry[] = [];
    const metadata: Record<string, unknown> = {};

    switch (eventType) {
      case "message_start": {
        const msgData = data as { message?: { usage?: { input_tokens?: number; output_tokens?: number } } };
        if (msgData.message?.usage) {
          this.inputTokens = msgData.message.usage.input_tokens ?? 0;
          this.outputTokens = msgData.message.usage.output_tokens ?? 0;
          metadata.inputTokens = this.inputTokens;
          // Surface normalized usage so the orchestrator can record real tokens.
          // message_delta later overrides this with the final output_tokens.
          metadata.usage = { inputTokens: this.inputTokens, outputTokens: this.outputTokens };
        }
        return { type: "text", content: "", thoughts: [], metadata };
      }

      case "content_block_start": {
        const blockData = data as {
          index?: number;
          content_block?: { type?: string; id?: string; name?: string; text?: string; thinking?: string };
        };
        this.currentContentBlockIndex = blockData.index ?? -1;

        if (blockData.content_block?.type === "tool_use") {
          this.toolCallAccumulator.set(this.currentContentBlockIndex, {
            id: blockData.content_block.id || `tool_${this.currentContentBlockIndex}`,
            name: blockData.content_block.name || "",
            argumentsJson: "",
          });
          log.info(
            `AnthropicStreamAdapter: Tool use block started: ${blockData.content_block.name} (index ${this.currentContentBlockIndex})`,
          );
        } else if (blockData.content_block?.type === "thinking") {
          this.thinkingAccumulator = blockData.content_block.thinking || "";
        }

        return { type: "text", content: "", thoughts: [], metadata };
      }

      case "content_block_delta": {
        const deltaData = data as {
          index?: number;
          delta?: {
            type?: string;
            text?: string;
            partial_json?: string;
            thinking?: string;
            stop_reason?: string;
          };
        };

        if (!deltaData.delta) {
          return { type: "text", content: "", thoughts: [], metadata };
        }

        const delta = deltaData.delta;

        if (delta.type === "text_delta" && delta.text) {
          return { type: "text", content: delta.text, thoughts: [], metadata };
        }

        if (delta.type === "input_json_delta" && delta.partial_json) {
          const blockIdx = deltaData.index ?? this.currentContentBlockIndex;
          const accumulated = this.toolCallAccumulator.get(blockIdx);
          if (accumulated) {
            accumulated.argumentsJson += delta.partial_json;
          }
          return { type: "text", content: "", thoughts: [], metadata };
        }

        if (delta.type === "thinking_delta" && delta.thinking) {
          this.thinkingAccumulator += delta.thinking;
          thoughts.push({ kind: "raw", content: delta.thinking });
          // Emit thinking as metadata, not visible text
          return { type: "text", content: "", thoughts, metadata };
        }

        return { type: "text", content: "", thoughts: [], metadata };
      }

      case "content_block_stop": {
        const blockStopData = data as { index?: number };
        const blockIdx = blockStopData.index ?? this.currentContentBlockIndex;
        const accumulated = this.toolCallAccumulator.get(blockIdx);

        if (accumulated?.name) {
          let parsedArgs: Record<string, unknown> = {};
          try {
            if (accumulated.argumentsJson) {
              parsedArgs = JSON.parse(accumulated.argumentsJson);
            }
          } catch (parseErr) {
            log.warn(`AnthropicStreamAdapter: Failed to parse tool arguments for ${accumulated.name}: ${parseErr}`);
          }

          const functionCall: FunctionCall = {
            name: accumulated.name,
            args: parsedArgs,
          };

          log.info(
            `AnthropicStreamAdapter: Tool call finalized: ${accumulated.name} (id: ${accumulated.id}) args: ${JSON.stringify(parsedArgs)}`,
          );

          return {
            type: "function_call",
            functionCall,
            thoughts: [],
            metadata: { toolCallId: accumulated.id },
          };
        }

        return { type: "text", content: "", thoughts: [], metadata };
      }

      case "message_delta": {
        const msgDelta = data as {
          delta?: { stop_reason?: string; stop_sequence?: string };
          usage?: { output_tokens?: number };
        };

        if (msgDelta.delta?.stop_reason) {
          this.stopReason = msgDelta.delta.stop_reason;
          metadata.stopReason = this.stopReason;
        }

        if (msgDelta.usage?.output_tokens) {
          this.outputTokens = msgDelta.usage.output_tokens;
          metadata.outputTokens = this.outputTokens;
          // Final usage for the turn: input from message_start + final output here.
          // Emitted on this `done`-bearing event so it survives the message_stop
          // event (which otherwise clobbers terminal metadata).
          metadata.usage = { inputTokens: this.inputTokens, outputTokens: this.outputTokens };
        }

        if (this.stopReason === "tool_use") {
          // The function call should have been emitted by content_block_stop
          // Just signal completion here
          return { type: "done", thoughts: [], metadata };
        }

        if (this.stopReason === "end_turn" || this.stopReason === "stop_sequence") {
          return { type: "done", thoughts: [], metadata };
        }

        if (this.stopReason === "max_tokens") {
          log.warn("AnthropicStreamAdapter: Response hit max_tokens limit");
          return { type: "done", thoughts: [], metadata };
        }

        return { type: "text", content: "", thoughts: [], metadata };
      }

      case "message_stop": {
        return { type: "done", thoughts: [], metadata: { streamComplete: true } };
      }

      case "ping": {
        // Keepalive, skip
        return { type: "text", content: "", thoughts: [], metadata };
      }

      case "error": {
        const errorData = data as { error?: { type?: string; message?: string } };
        const error = errorData.error;

        log.error(`AnthropicStreamAdapter: Stream error: ${error?.type} - ${error?.message}`);

        return {
          type: "error",
          error: {
            type: "api_error",
            message: error?.message || "Unknown Anthropic stream error",
            code: error?.type,
            retryable: error?.type === "overloaded_error",
            userMessage: error?.message,
          },
          thoughts: [],
          metadata,
        };
      }

      default: {
        log.warn(`AnthropicStreamAdapter: Unknown SSE event type: ${eventType}`);
        return { type: "text", content: "", thoughts: [], metadata };
      }
    }
  }

  /**
   * Convert provider-specific errors into normalized ProviderError format
   */
  handleProviderError(error: unknown): ProviderError {
    const errorMessage = error instanceof Error ? error.message : String(error);

    let anthropicError: { type?: string; message?: string } | null = null;
    let statusCode: number | undefined;

    if (errorMessage.includes("{")) {
      try {
        const jsonMatch = errorMessage.match(/\{.*\}/s);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          // Anthropic wraps errors: {type: "error", error: {type: "...", message: "..."}}
          if (parsed.error?.type && parsed.error?.message) {
            anthropicError = parsed.error;
          } else if (parsed.type && parsed.message) {
            anthropicError = parsed;
          }
        }
      } catch {}
    }

    const httpError = error as { statusCode?: number; status?: number };
    statusCode = httpError.statusCode ?? httpError.status;

    const errorType = anthropicError?.type;
    let providerErrorType: ProviderError["type"] = "api_error";
    let retryable = false;

    switch (errorType) {
      case "authentication_error":
        providerErrorType = "api_error";
        retryable = false;
        break;
      case "permission_error":
        providerErrorType = "api_error";
        retryable = false;
        break;
      case "invalid_request_error":
        providerErrorType = "api_error";
        retryable = false;
        break;
      case "not_found_error":
        providerErrorType = "api_error";
        retryable = false;
        break;
      case "rate_limit_error":
        providerErrorType = "rate_limit";
        retryable = true;
        break;
      case "api_error":
        providerErrorType = "api_error";
        retryable = true;
        break;
      case "overloaded_error":
        providerErrorType = "provider_overloaded";
        retryable = true;
        break;
      default:
        if (statusCode === 401 || statusCode === 403) {
          providerErrorType = "api_error";
          retryable = false;
        } else if (statusCode === 429) {
          providerErrorType = "rate_limit";
          retryable = true;
        } else if (statusCode === 503) {
          providerErrorType = "provider_overloaded";
          retryable = true;
        } else if (statusCode === 504 || statusCode === 408) {
          providerErrorType = "timeout";
          retryable = true;
        }
        break;
    }

    return {
      type: providerErrorType,
      message: errorMessage,
      code: errorType ?? statusCode?.toString(),
      retryable,
      originalError: error,
      userMessage: anthropicError?.message,
    };
  }

  /**
   * Create provider-specific error description for display in embeds
   */
  createErrorDescription(error: ProviderError, locale: string): string | null {
    const errorCode = error.code;
    let message = error.userMessage;
    const isTemperatureTopPConflict =
      errorCode === "invalid_request_error" &&
      typeof error.userMessage === "string" &&
      error.userMessage.includes("`temperature` and `top_p` cannot both be specified");

    if (isTemperatureTopPConflict) {
      message = localizer(locale, "genai.anthropic.temperature_top_p_conflict_message");
    }

    if (!message) {
      const messageKey = errorCode ? `genai.anthropic.${errorCode}_default_message` : null;

      if (messageKey) {
        message = localizer(locale, messageKey);
      }

      if (!message || message === messageKey) {
        message = localizer(locale, "genai.anthropic.unknown_default_message");
      }
    }

    if (errorCode) {
      return `Error Code ${errorCode}: ${message}`;
    }

    return message || null;
  }

  /**
   * Assemble context items into Anthropic message format.
   * Returns the system prompt (top-level) and messages array separately.
   */
  private async assembleAnthropicContext(
    contextItems: StructuredContextItem[],
    currentTurnModelParts: Array<Record<string, unknown>>,
    functionInteractionHistory?: Array<{
      functionCall: FunctionCall;
      functionResponse: Record<string, unknown>;
      imageMetadata?: FunctionResponseImageMetadata;
      preToolCallTextParts?: Array<Record<string, unknown>>;
    }>,
    seesImages: boolean = true,
    enforceAlternation: boolean = true,
  ): Promise<{ systemPrompt: string | null; messages: AnthropicMessage[] }> {
    const messages: AnthropicMessage[] = [];
    const relocatedContextItems = relocateAssistantMediaContextItems(contextItems);
    const systemParts: string[] = [];

    for (const item of relocatedContextItems) {
      let itemTextContent = "";
      if (item.parts.some((p) => p.type === "text")) {
        itemTextContent = item.parts
          .filter((p) => p.type === "text")
          .map((p) => (p as { type: "text"; text: string }).text)
          .join("\n");
      }

      // Check if this should go to system prompt (top-level parameter)
      if (
        item.role === "system" ||
        (item.role === "user" && item.metadataTag && SYSTEM_INSTRUCTION_TAGS.includes(item.metadataTag))
      ) {
        if (itemTextContent) {
          systemParts.push(itemTextContent);
        }
      } else if (item.role === "user" || item.role === "model") {
        const role = item.role === "user" ? ("user" as const) : ("assistant" as const);
        const contentBlocks: AnthropicContentBlock[] = [];
        const pendingBotImageBlocks: AnthropicImageBlock[] = [];

        for (const part of item.parts) {
          if (part.type === "text") {
            contentBlocks.push({
              type: "text",
              text: part.text,
            });
          } else if (part.type === "image") {
            // Anthropic only allows image blocks on user messages
            const imageTargetBlocks = role === "assistant" ? pendingBotImageBlocks : contentBlocks;

            if (!seesImages) {
              log.info(`AnthropicStreamAdapter: Skipping image (model doesn't support images)`);
              continue;
            }

            if ("inlineData" in part && part.inlineData) {
              const inlineData = part.inlineData as { mimeType: string; data: string };
              if (inlineData.mimeType && inlineData.data) {
                imageTargetBlocks.push({
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: inlineData.mimeType,
                    data: inlineData.data,
                  },
                });
              }
              continue;
            }

            if (part.uri && part.mimeType) {
              try {
                let base64Data: string;
                let finalMimeType = part.mimeType;

                if (part.uri.startsWith("data:")) {
                  const dataUriMatch = part.uri.match(/^data:([^;]+);base64,(.+)$/);
                  if (dataUriMatch) {
                    finalMimeType = dataUriMatch[1];
                    base64Data = dataUriMatch[2];
                  } else {
                    continue;
                  }
                } else {
                  const optimized = await fetchAndOptimizeImage(part.uri, part.mimeType);
                  base64Data = optimized.data;
                  finalMimeType = optimized.mimeType;
                }

                imageTargetBlocks.push({
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: finalMimeType,
                    data: base64Data,
                  },
                });

                log.info(`AnthropicStreamAdapter: Added image to ${role} message`);
              } catch (imgErr) {
                log.warn(`AnthropicStreamAdapter: Failed to process image: ${part.uri}`, {
                  error: imgErr instanceof Error ? imgErr.message : String(imgErr),
                });
              }
            }
          }
          // Note: video not supported by Anthropic, skip silently
        }

        if (contentBlocks.length > 0 || pendingBotImageBlocks.length > 0) {
          if (role === "assistant") {
            // Anthropic doesn't allow images in assistant messages.
            // Emit text as string, then inject a synthetic user turn for images.
            const textContent = contentBlocks
              .filter((b) => b.type === "text")
              .map((b) => (b as AnthropicTextBlock).text)
              .join("\n");

            if (textContent) {
              messages.push({ role: "assistant", content: textContent });
            }

            if (pendingBotImageBlocks.length > 0) {
              // Anthropic forbids media on assistant turns; relocate it into a synthetic user turn
              // using the shared canonical wording (consolidated across all providers).
              messages.push({
                role: "user",
                content: [
                  {
                    type: "text",
                    text: assistantMediaRelocationNotice(pendingBotImageBlocks.length, item.sender?.name),
                  },
                  ...pendingBotImageBlocks,
                ],
              });
            }
          } else {
            // User message - can include both text and images
            // Flatten to string if text-only for cleaner API calls
            const allTextOnly = contentBlocks.every((b) => b.type === "text");
            if (allTextOnly && pendingBotImageBlocks.length === 0) {
              const textContent = contentBlocks.map((b) => (b as AnthropicTextBlock).text).join("\n");
              messages.push({ role: "user", content: textContent });
            } else {
              messages.push({
                role: "user",
                content: [...contentBlocks, ...pendingBotImageBlocks],
              });
            }
          }
        }
      }
    }

    if (functionInteractionHistory && functionInteractionHistory.length > 0) {
      for (const interaction of functionInteractionHistory) {
        const toolUseId = `toolu_${Date.now()}_${Math.random().toString(36).substring(7)}`;

        const assistantContentBlocks: AnthropicContentBlock[] = [];

        if (interaction.preToolCallTextParts && interaction.preToolCallTextParts.length > 0) {
          const preText = interaction.preToolCallTextParts
            .map((part) => (part as { text?: string }).text)
            .filter((text): text is string => typeof text === "string" && text.length > 0)
            .join("");

          if (preText) {
            assistantContentBlocks.push({ type: "text", text: preText });
          }
        }

        assistantContentBlocks.push({
          type: "tool_use",
          id: toolUseId,
          name: interaction.functionCall.name,
          input: (interaction.functionCall.args || {}) as Record<string, unknown>,
        });

        messages.push({
          role: "assistant",
          content: assistantContentBlocks,
        });

        const userContentBlocks: AnthropicContentBlock[] = [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: JSON.stringify(interaction.functionResponse),
          },
        ];

        if (interaction.imageMetadata?.imageUrls && interaction.imageMetadata.imageUrls.length > 0 && seesImages) {
          for (const img of interaction.imageMetadata.imageUrls) {
            try {
              const sourceUrl = img.originalUrl || img.url;
              const optimized = await fetchAndOptimizeImage(sourceUrl, img.mimeType || "image/png");

              userContentBlocks.push({
                type: "image",
                source: {
                  type: "base64",
                  media_type: optimized.mimeType,
                  data: optimized.data,
                },
              });
            } catch (imgErr) {
              log.warn("AnthropicStreamAdapter: Failed to add tool result image", {
                error: imgErr instanceof Error ? imgErr.message : String(imgErr),
              });
            }
          }
        }

        messages.push({
          role: "user",
          content: userContentBlocks,
        });
      }
    }

    // Append current turn model parts as assistant prefill
    if (currentTurnModelParts.length > 0) {
      const prefillText = currentTurnModelParts
        .map((part) => (part as { text?: string }).text)
        .filter((text): text is string => typeof text === "string" && text.length > 0)
        .join("");

      if (prefillText) {
        messages.push({ role: "assistant", content: prefillText });
        log.info(`AnthropicStreamAdapter: Appended prefill assistant message (${prefillText.length} chars)`);
      }
    }

    // Enforce strict user/assistant alternation by merging consecutive same-role messages and
    //    prepending a leading user turn when needed. Delegated to the shared strict-chat helpers
    //    so behavior is identical to the previous private implementation. Gated by the resolved
    //    flag (always ON for anthropic via the safety net, so this is byte-identical).
    const mergedMessages = enforceAlternation ? this.enforceStrictAlternation(messages) : messages;

    log.info(`AnthropicStreamAdapter: Assembled ${mergedMessages.length} messages (after alternation merge)`);

    return {
      systemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : null,
      messages: mergedMessages,
    };
  }

  /**
   * Anthropic requires strict user/assistant alternation. Merges consecutive same-role messages
   * into single messages with combined content blocks and guarantees a leading user turn, via the
   * shared {@link mergeConsecutiveSameRole} / {@link ensureLeadingUserTurn} helpers.
   */
  private enforceStrictAlternation(messages: AnthropicMessage[]): AnthropicMessage[] {
    const merged = mergeConsecutiveSameRole(messages as unknown as NormalizableMessage[]);

    // Prepend a synthetic user turn when the conversation would otherwise start with assistant.
    const withLeading = ensureLeadingUserTurn(merged, () => ({
      role: "user",
      content: CONVERSATION_START_USER_TEXT,
    }));
    if (withLeading.length > merged.length) {
      log.info("AnthropicStreamAdapter: Prepended user message to satisfy alternation requirement");
    }

    return withLeading as unknown as AnthropicMessage[];
  }

  /**
   * Log a sanitized version of the outbound Anthropic request for debugging.
   * Mirrors the Google/OpenRouter pattern: logs the full structured request body
   * as a single JSON object so the payload is copy-pasteable and spec-comparable.
   * Base64 image data is redacted to keep logs readable.
   *
   * @param requestBody - The assembled request body (without API key)
   */
  private logSanitizedRequest(requestBody: Record<string, unknown>): void {
    log.section("AnthropicStreamAdapter: Request Details");

    // Sanitize messages: redact base64 image data in content blocks
    const sanitizedMessages = (requestBody.messages as Array<Record<string, unknown>> | undefined)?.map((msg) => {
      const content = msg.content;
      if (typeof content === "string") return msg;

      const sanitizedContent = (content as Array<Record<string, unknown>>).map((block) => {
        if (
          block.type === "image" &&
          block.source &&
          typeof (block.source as Record<string, unknown>).data === "string"
        ) {
          return {
            ...block,
            source: { ...(block.source as Record<string, unknown>), data: "[BASE64_HIDDEN]" },
          };
        }
        return block;
      });

      return { ...msg, content: sanitizedContent };
    });

    // Log the full request body with explicit field ordering: config → tools → system → messages
    const { tools, system, messages: _messages, ...configParams } = requestBody;
    const sanitizedBody = {
      ...configParams,
      ...(tools !== undefined && { tools }),
      ...(system !== undefined && { system }),
      messages: sanitizedMessages,
    };
    log.info(`Request Body: ${JSON.stringify(sanitizedBody, null, 2)}`);
  }

  /**
   * Assemble context into Anthropic message format for non-streaming use cases
   * (e.g. token counting probe in /tool estimate cost).
   *
   * @param seesImages - Whether the model accepts image inputs
   * @returns Assembled system prompt and messages array ready for the Anthropic API
   */
  async buildProbeMessages(
    contextItems: StructuredContextItem[],
    seesImages: boolean,
  ): Promise<{ system: string; messages: Array<Record<string, unknown>> }> {
    const { systemPrompt, messages } = await this.assembleAnthropicContext(
      contextItems,
      [],
      undefined,
      seesImages,
      providerRequiresAlternation("anthropic"),
    );
    return {
      system: systemPrompt ?? "",
      messages: messages as unknown as Array<Record<string, unknown>>,
    };
  }
}
