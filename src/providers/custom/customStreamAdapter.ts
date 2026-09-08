import { OpenAICompatibleStreamAdapter } from "@/providers/openaiCompatible/openaiCompatibleStreamAdapter";
import type { OpenAICompatibleStreamConfig } from "@/providers/openaiCompatible/openaiCompatibleTypes";
import { GemmaToolCallParser } from "@/providers/custom/customGemmaToolParser";
import { GemmaThinkingParser, GEMMA_THINKING_PARSER_ENABLED } from "@/providers/custom/customGemmaThinkingParser";
import type { ProcessedChunk, RawStreamChunk, StreamConfig, StreamContext } from "@/types/stream/interfaces";
import type { ThoughtLogEntry } from "@/types/provider/interfaces";
import { log } from "@/utils/misc/logger";
import { buildCustomThinkingRequest } from "@/utils/provider/thinkingControl";
import { VerbatimToolCallParser, getVerbatimToolCallMaxBufferChars } from "@/utils/tools/verbatimToolCallParser";
import { resolveToolsEnabled } from "@/utils/tools/toolUseGate";

/**
 * When true, the stream adapter scans `delta.content` for Gemma 4's hallucinated
 * tool-call formats: both the special-token `<|tool_call>...<tool_call|>` form and
 * the Python-call `<tool_code>name(...)</tool_code>` form; and converts matches into
 * proper function_call chunks. Set CUSTOM_GEMMA_TOOL_PARSER_ENABLED=false to disable
 * if another local model produces similar token strings unexpectedly.
 */
const GEMMA_TOOL_PARSER_ENABLED = (process.env.CUSTOM_GEMMA_TOOL_PARSER_ENABLED ?? "true").toLowerCase() !== "false";

export interface CustomStreamConfig extends OpenAICompatibleStreamConfig {
  endpointUrl: string;
  /** Optional context window override sent as options.num_ctx (Ollama extension) */
  numCtx?: number | null;
}

export const CUSTOM_PROVIDER_PLACEHOLDER_API_KEY = "custom-endpoint-configured";

export class CustomStreamAdapter extends OpenAICompatibleStreamAdapter {
  private readonly gemmaThinkingParser = new GemmaThinkingParser();
  private readonly gemmaParser = new GemmaToolCallParser();
  private verbatimParser: VerbatimToolCallParser | null = null;

  constructor() {
    super({
      providerName: "custom",
      adapterName: "CustomStreamAdapter",
      localeNamespace: ["genai", "custom"].join("."),
      errorMessagePrefix: "Custom endpoint error",
      placeholderApiKey: CUSTOM_PROVIDER_PLACEHOLDER_API_KEY,
      // Some custom/Ollama-style endpoints validly emit "\n{persona}:" immediately
      // after a closed <think>...</think> block, so the request-level stop string
      // is too aggressive here. Keep the local fallback speaker guard instead.
      includePersonaSpeakerStop: false,
      resolveApiUrl: (config) => normalizeCustomApiUrl(config.endpointUrl),
      shouldRetryWithoutStop: (statusCode, errorText) => {
        if (statusCode !== 400 && statusCode !== 422) {
          return false;
        }

        const normalized = errorText.toLowerCase();
        const mentionsStop = normalized.includes("stop");
        const indicatesUnsupportedParam =
          normalized.includes("unsupported") ||
          normalized.includes("unknown") ||
          normalized.includes("invalid") ||
          normalized.includes("not allowed") ||
          normalized.includes("unrecognized");

        return mentionsStop && indicatesUnsupportedParam;
      },
      // Chatmock (used as a local proxy for Codex CLI) silently strips
      // system-role turns before forwarding to the underlying model.
      // Detect it by URL so the adapter falls back to an in-band user turn.
      supportsSystemRole: (apiUrl) => !isChatmockEndpoint(apiUrl),
      // Inject Ollama-style options.num_ctx when the user has configured a
      // context window override. This travels outside the messages array so it
      // is unaffected by the context window it controls.
      mutateRequestBody: ({ requestBody, config, context }) => {
        const customConfig = config as CustomStreamConfig;
        if (customConfig.numCtx != null) {
          // Ollama reads options.num_ctx; KoboldCPP reads top-level max_context_length.
          // Both are injected so each server picks up what it understands and ignores the other.
          requestBody.options = {
            ...((requestBody.options as Record<string, unknown>) ?? {}),
            num_ctx: customConfig.numCtx,
          };
          requestBody.max_context_length = customConfig.numCtx;
          log.info(
            `CustomStreamAdapter: Injecting num_ctx=${customConfig.numCtx} (options.num_ctx + max_context_length)`,
          );
        }

        const thinkingRequest = buildCustomThinkingRequest(
          customConfig.endpointUrl,
          context.tomoriState.config.thinking_level,
          customConfig.forceReason,
        );
        if (thinkingRequest.think !== undefined) {
          requestBody.think = thinkingRequest.think;
          log.info(`CustomStreamAdapter: Applying Ollama think=${thinkingRequest.think}`);
        }
        if (thinkingRequest.reasoning_effort) {
          requestBody.reasoning_effort = thinkingRequest.reasoning_effort;
          log.info(`CustomStreamAdapter: Applying reasoning_effort=${thinkingRequest.reasoning_effort}`);
        }
      },
    });
  }

  override async *startStream(
    config: StreamConfig,
    context: StreamContext,
  ): AsyncGenerator<RawStreamChunk, void, unknown> {
    this.configureVerbatimToolCallParser(config, context);
    try {
      yield* super.startStream(config, context);
    } finally {
      this.verbatimParser = null;
    }
  }

  /**
   * Intercept text chunks to handle two Gemma 4 token formats that KoboldCPP
   * does not always convert to standard OpenAI fields:
   *
   * - `<|channel>thought\n[reasoning]\n<channel|>`: thinking block. KoboldCPP
   *    converts this to `reasoning_content` for pure-text responses, but when a
   *    tool call follows in the same chunk the entire blob arrives as raw content.
   *    GemmaThinkingParser runs first to extract thoughts before the tool parser sees it.
   *
   * - `<|tool_call>call:name{...}<tool_call|>` or `<tool_code>name(...)</tool_code>`
   *    : hallucinated tool call leaked as text. GemmaToolCallParser recognises both
   *    dialects and converts completed blocks into function_call chunks.
   *
   * Parsers are intentionally serial and each maintains its own scanHoldback,
   * so a chunk boundary mid-token is handled safely by whichever parser is active.
   */
  override processChunk(chunk: RawStreamChunk): ProcessedChunk {
    const base = super.processChunk(chunk);

    if (!GEMMA_TOOL_PARSER_ENABLED && !this.verbatimParser) {
      return base;
    }

    if (base.type === "done") {
      const thinkFlush =
        GEMMA_TOOL_PARSER_ENABLED && GEMMA_THINKING_PARSER_ENABLED
          ? this.gemmaThinkingParser.flush()
          : { visibleText: "", thoughts: [] };
      const { pendingText, functionCall } = GEMMA_TOOL_PARSER_ENABLED
        ? this.gemmaParser.flush()
        : { pendingText: "", functionCall: null };
      const allThoughts = mergeThoughts(base.thoughts, thinkFlush.thoughts);

      if (functionCall) {
        log.info("CustomStreamAdapter: Flushed truncated Gemma tool call at stream end");
        return { ...base, type: "function_call", functionCall, thoughts: allThoughts };
      }

      const flushedText = thinkFlush.visibleText + (pendingText ?? "");
      const verbatimResult = this.feedVerbatimParser(flushedText);
      const verbatimFlush = this.verbatimParser?.flush() ?? { pendingText: "", functionCall: null };
      const visibleFlushText = verbatimResult.visibleText + verbatimFlush.pendingText;

      if (verbatimResult.functionCall || verbatimFlush.functionCall) {
        return {
          ...base,
          type: "function_call",
          functionCall: verbatimResult.functionCall ?? verbatimFlush.functionCall ?? undefined,
          thoughts: allThoughts,
        };
      }

      if (visibleFlushText) {
        log.info(`CustomStreamAdapter: Flushing ${visibleFlushText.length} held-back chars at stream end`);
        return { ...base, type: "text", content: visibleFlushText, thoughts: allThoughts };
      }

      return { ...base, thoughts: allThoughts };
    }

    // Non-text chunks (errors, native delta.tool_calls) pass through untouched.
    if (base.type !== "text" || typeof base.content !== "string" || base.content.length === 0) {
      return base;
    }

    const thinkResult =
      GEMMA_TOOL_PARSER_ENABLED && GEMMA_THINKING_PARSER_ENABLED
        ? this.gemmaThinkingParser.feed(base.content)
        : { visibleText: base.content, thoughts: [] };
    const allThoughts = mergeThoughts(base.thoughts, thinkResult.thoughts);

    const toolResult = GEMMA_TOOL_PARSER_ENABLED
      ? this.gemmaParser.feed(thinkResult.visibleText)
      : { visibleText: thinkResult.visibleText, functionCall: null };

    if (toolResult.functionCall) {
      return { ...base, type: "function_call", functionCall: toolResult.functionCall, thoughts: allThoughts };
    }

    const verbatimResult = this.feedVerbatimParser(toolResult.visibleText);
    if (verbatimResult.functionCall) {
      return { ...base, type: "function_call", functionCall: verbatimResult.functionCall, thoughts: allThoughts };
    }

    return { ...base, content: verbatimResult.visibleText, thoughts: allThoughts };
  }

  private configureVerbatimToolCallParser(config: StreamConfig, context: StreamContext): void {
    this.verbatimParser = null;

    const tools = Array.isArray(config.tools) ? config.tools : [];
    const enabled = Boolean(
      context.tomoriState.config.verbatim_tool_calling_enabled &&
        resolveToolsEnabled(context.tomoriState, context.tomoriState.llm.has_tools) &&
        tools.length > 0,
    );
    if (!enabled) {
      return;
    }

    const parser = new VerbatimToolCallParser({
      tools,
      maxBufferChars: getVerbatimToolCallMaxBufferChars(),
    });
    if (!parser.hasTools) {
      log.warn("CustomStreamAdapter: Verbatim tool-calling enabled, but no parseable OpenAI-compatible tools found");
      return;
    }

    this.verbatimParser = parser;
    log.info(`CustomStreamAdapter: Verbatim tool-calling parser enabled for ${tools.length} tool(s)`);
  }

  private feedVerbatimParser(text: string): {
    visibleText: string;
    functionCall: ProcessedChunk["functionCall"] | null;
  } {
    if (!this.verbatimParser || !text) {
      return { visibleText: text, functionCall: null };
    }

    return this.verbatimParser.feed(text);
  }
}

/** Merges two thought arrays, omitting undefined/empty sources. */
function mergeThoughts(a: ThoughtLogEntry[] | undefined, b: ThoughtLogEntry[]): ThoughtLogEntry[] | undefined {
  if ((!a || a.length === 0) && b.length === 0) return undefined;
  return [...(a ?? []), ...b];
}

/**
 * Port that ChatMock listens on by default.
 * Override with the `CHATMOCK_PORT` environment variable if you run ChatMock
 * on a non-standard port (e.g. `CHATMOCK_PORT=9000`).
 */
const CHATMOCK_PORT = process.env.CHATMOCK_PORT ?? "8000";

/**
 * Returns `true` when the resolved API URL looks like a ChatMock endpoint.
 *
 * ChatMock (github.com/RayBytes/ChatMock) is a local OpenAI-compatible proxy
 * used to bridge Codex CLI.  It silently strips system-role messages, so the
 * system prompt must be injected as an in-band user turn instead.
 *
 * Detection heuristic: ChatMock's documented default is `http://127.0.0.1:8000`
 * (or `localhost:8000`), so we match any loopback address on the configured
 * port.  The port defaults to `8000` but is overridable via `CHATMOCK_PORT`.
 * This is intentionally narrow because other common local tools use different ports
 * (Ollama: 11434, KoboldCPP: 5001, LM Studio: 1234).
 */
function isChatmockEndpoint(apiUrl: string): boolean {
  try {
    const { hostname, port } = new URL(apiUrl);
    const isLoopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
    return isLoopback && port === CHATMOCK_PORT;
  } catch {
    // Malformed URL, so don't assume ChatMock
    return false;
  }
}

export function normalizeCustomApiUrl(endpointUrl?: string): string {
  if (!endpointUrl) {
    throw new Error("Custom endpoint URL is required");
  }

  let apiUrl = endpointUrl;
  if (!apiUrl.endsWith("/chat/completions")) {
    apiUrl = apiUrl.replace(/\/$/, "");
    apiUrl = `${apiUrl}/chat/completions`;
  }

  return apiUrl;
}
