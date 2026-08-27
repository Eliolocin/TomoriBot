/**
 * NovelAI REST API Service
 * Direct HTTP implementation for NovelAI text generation API
 * Supports streaming via Server-Sent Events (SSE)
 */

import { mergeStopStrings } from "@/providers/utils/stopStrings";
import { log } from "@/utils/misc/logger";

const NOVELAI_API_BASE_URL = "https://text.novelai.net";
/** Default timeout for NovelAI API requests in milliseconds */
const REQUEST_TIMEOUT = Number.parseInt(process.env.NOVELAI_REQUEST_TIMEOUT_MS || "60000", 10);

/** Per-read inactivity timeout for streaming: if no data arrives within this window, abort.
 *  Prevents indefinite hangs when NAI's server stops sending chunks mid-stream. */
const STREAM_READ_TIMEOUT_MS = Number.parseInt(process.env.NOVELAI_STREAM_READ_TIMEOUT_MS || "30000", 10);

/**
 * NovelAI generation parameters
 * Based on reference implementation and API documentation
 */
export interface NovelAIParameters {
  bad_words_ids?: number[][];
  bracket_ban?: boolean;
  cfg_scale?: number;
  cfg_uc?: string;
  force_emotion?: boolean;
  generate_until_sentence?: boolean;
  logit_bias_exp?: Array<{
    sequence: number[];
    bias: number;
    ensure_sequence_finish: boolean;
    generate_once: boolean;
  }>;
  max_length?: number;
  min_length?: number;
  min_p?: number;
  mirostat_lr?: number | null;
  mirostat_tau?: number | null;
  order?: number[];
  phrase_rep_pen?: "off" | "very_light" | "light" | "medium" | "aggressive" | "very_aggressive";
  prefix?: string;
  repetition_penalty?: number;
  repetition_penalty_frequency?: number;
  repetition_penalty_presence?: number;
  repetition_penalty_range?: number;
  repetition_penalty_slope?: number;
  repetition_penalty_whitelist?: number[];
  stop_sequences?: number[][];
  tail_free_sampling?: number;
  temperature?: number;
  top_a?: number;
  top_g?: number;
  top_k?: number;
  top_p?: number;
  typical_p?: number | null;
  use_string?: boolean;
}

/**
 * NovelAI generation request body
 */
export interface NovelAIGenerationRequest {
  input: string;
  model: string;
  parameters: NovelAIParameters;
  prefix?: string;
  /** Additional stop strings for OpenAI-compatible models (e.g., GLM-4.6). */
  openAIStopStrings?: string[];
}

/**
 * NovelAI SSE stream chunk
 */
export interface NovelAIStreamChunk {
  token?: string;
  final?: boolean;
  error?: string;
  /** Populated from OpenAI-compatible endpoint: "stop", "length", or null */
  finishReason?: string;
}

/**
 * OpenAI-compatible completion request (for glm-4-6 and other newer models)
 */
interface OpenAICompletionRequest {
  model: string;
  prompt: string | string[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  min_p?: number;
  stop?: string | string[];
  stream?: boolean;
  seed?: number;
}

/**
 * OpenAI-compatible SSE chunk
 */
interface OpenAIStreamChunk {
  id: string;
  object: "text_completion";
  created: number;
  model: string;
  choices: Array<{
    text: string;
    index: number;
    logprobs: null;
    finish_reason: string | null;
  }>;
}

/**
 * API request configuration
 */
export interface ApiRequestConfig {
  apiKey: string;
  timeout?: number;
}

/**
 * Based on reference implementation with sensible defaults for roleplay
 */
// Use https://novelai.net/tokenizer to find stop sequences
function getKayraParameters(): NovelAIParameters {
  return {
    max_length: 150, // Increased from reference for longer responses
    min_length: 10,
    temperature: 1.35,
    top_k: 15,
    top_p: 0.85,
    top_a: 0.1,
    tail_free_sampling: 0.915,
    repetition_penalty: 2.8,
    repetition_penalty_frequency: 0.02,
    repetition_penalty_presence: 0,
    repetition_penalty_range: 2048,
    repetition_penalty_slope: 0.02,
    cfg_scale: 1,
    phrase_rep_pen: "aggressive",
    generate_until_sentence: true,
    use_string: true,
    bracket_ban: true,
    order: [2, 3, 0, 4, 1],
    stop_sequences: [],
  };
}

/**
 * Based on reference implementation optimized for latest model
 */
function getGlmParameters(): NovelAIParameters {
  return {
    max_length: 4096, // Request full token budget; API may cap lower but let's test the actual limit
    min_length: 1,
    temperature: 1.0, // GLM 4.6 default: balanced between natural output and tool call precision
    top_k: 40,
    top_p: 0.95,
    top_a: 1,
    tail_free_sampling: 1,
    typical_p: 1,
    repetition_penalty: 0, // GLM-4-6 doesn't need heavy rep penalty
    repetition_penalty_range: 0,
    repetition_penalty_slope: 0,
    repetition_penalty_frequency: 0,
    repetition_penalty_presence: 0.5, // Mild presence penalty to discourage repetitive phrasing
    cfg_scale: 1,
    phrase_rep_pen: "medium",
    use_string: true,
    stop_sequences: [],
  };
}

/**
 * Previously converted temperature from a Gemini-centric scale to NovelAI model scale.
 * Now a direct passthrough: temperature is used as-is across all providers.
 *
 */
function convertTemperatureToNovelAI(temperature: number, _model: string): number {
  return temperature;
}

/**
 * Get parameters for a specific model with optional sampling overrides
 * DB values with neutral defaults are omitted (topK=0, topP=1.0, minP=0.0)
 * so the model preset values are preserved when the user hasn't configured them.
 *
 * Merge priority (lowest → highest):
 * 1. Model hardcoded defaults (getKayraParameters / getGlmParameters)
 * 2. NAI-specific preset overrides (order, tail_free_sampling, phrase_rep_pen, etc.)
 * 3. DB schema values (temperature, topK, topP, minP): always win if non-neutral
 *
 * @param temperature - Optional temperature in Gemini scale (will be converted to NovelAI scale)
 * @param topK - Optional top-K sampling override (0 = use model preset)
 * @param topP - Optional top-P sampling override (1.0 = use model preset)
 * @param minP - Optional min-P sampling override (0.0 = use model preset)
 * @param presetOverrides - Optional NAI-specific preset fields to merge (non-schema params only)
 */
export function getParametersForModel(
  model: string,
  temperature?: number,
  topK?: number,
  topP?: number,
  minP?: number,
  presetOverrides?: Partial<NovelAIParameters>,
): NovelAIParameters {
  const params = model === "kayra-v1" || model === "llama-3-erato-v1" ? getKayraParameters() : getGlmParameters();

  // Merge NAI-specific preset fields (order, TFS, phrase_rep_pen, mirostat, etc.)
  //    These override the hardcoded defaults but are themselves overridden by DB schema values.
  if (presetOverrides && Object.keys(presetOverrides).length > 0) {
    Object.assign(params, presetOverrides);
  }

  // Apply DB schema overrides (highest priority: always win if non-neutral)
  // Override temperature if provided (convert from Gemini scale to NovelAI scale)
  if (temperature !== undefined) {
    params.temperature = convertTemperatureToNovelAI(temperature, model);
  }

  if (topK !== undefined && topK > 0) {
    params.top_k = topK;
  }
  if (topP !== undefined && topP < 1.0) {
    params.top_p = topP;
  }
  if (minP !== undefined && minP > 0) {
    params.min_p = minP;
  }

  return params;
}

/**
 * Check if a model requires the OpenAI-compatible API endpoint
 * @returns True if model uses OpenAI endpoint, false for native NovelAI endpoint
 */
export function usesOpenAIEndpoint(model: string): boolean {
  // glm-4-6 and newer models require OpenAI-compatible API
  // kayra-v1 uses the native NovelAI API
  return model === "glm-4-6";
}

/**
 * Convert NovelAI parameters to OpenAI-compatible format
 */
function convertToOpenAIParams(
  naiParams: NovelAIParameters,
  additionalStopStrings?: string[],
): Partial<OpenAICompletionRequest> {
  const mergedStops = mergeStopStrings(undefined, additionalStopStrings);

  return {
    max_tokens: naiParams.max_length,
    temperature: naiParams.temperature,
    top_p: naiParams.top_p,
    top_k: naiParams.top_k,
    min_p: naiParams.min_p,
    frequency_penalty: naiParams.repetition_penalty_frequency,
    presence_penalty: naiParams.repetition_penalty_presence,
    repetition_penalty: naiParams.repetition_penalty,
    // Specialized GLM stop strings are resolved centrally in providers/utils/stopStrings.ts.
    stop: mergedStops,
  };
}

/**
 * Start streaming generation using OpenAI-compatible API endpoint
 */
async function* novelaiGenerateStreamOpenAI(
  prompt: string,
  model: string,
  parameters: NovelAIParameters,
  config: ApiRequestConfig,
  additionalStopStrings?: string[],
): AsyncGenerator<NovelAIStreamChunk, void, unknown> {
  const { apiKey, timeout = REQUEST_TIMEOUT } = config;

  try {
    const url = `${NOVELAI_API_BASE_URL}/oa/v1/completions`;

    log.info("Starting NovelAI streaming generation (OpenAI-compatible API)");

    const openaiParams = convertToOpenAIParams(parameters, additionalStopStrings);

    const requestBody: OpenAICompletionRequest = {
      model,
      prompt,
      stream: true,
      ...openaiParams,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      log.error(`NovelAI OpenAI streaming request failed: ${response.status} ${errorText}`);

      yield {
        error: `NovelAI API request failed with status ${response.status}: ${errorText}`,
      };
      return;
    }

    if (!response.body) {
      log.error("NovelAI OpenAI streaming response has no body");
      yield {
        error: "Response has no body",
      };
      return;
    }

    // Read SSE stream with per-read inactivity timeout.
    // NAI's server sometimes stops sending chunks mid-stream without closing
    // the connection. Without this timeout, reader.read() blocks indefinitely.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let completed = false;

    try {
      while (true) {
        // Race the read against an inactivity timeout to prevent indefinite hangs.
        // The timer is cleared after each successful read to avoid leaking timers.
        let readTimer: ReturnType<typeof setTimeout> | undefined;
        const readResult = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            readTimer = setTimeout(
              () => reject(new Error(`NovelAI stream read timed out after ${STREAM_READ_TIMEOUT_MS}ms of inactivity`)),
              STREAM_READ_TIMEOUT_MS,
            );
          }),
        ]);
        if (readTimer) clearTimeout(readTimer);

        const { done, value } = readResult;

        if (done) {
          log.info("NovelAI OpenAI stream complete");
          completed = true;
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim() || line.startsWith(":")) {
            continue; // Skip empty lines and comments
          }

          if (line.startsWith("data: ")) {
            const data = line.slice(6); // Remove 'data: ' prefix

            if (data === "[DONE]") {
              yield { final: true };
              return;
            }

            try {
              const chunk = JSON.parse(data) as OpenAIStreamChunk;
              const finishReason = chunk.choices?.[0]?.finish_reason ?? undefined;

              if (chunk.choices?.[0]?.text) {
                yield {
                  token: chunk.choices[0].text,
                  final: finishReason !== null && finishReason !== undefined,
                  finishReason,
                };
              }

              if (finishReason) {
                yield { final: true, finishReason };
                return;
              }
            } catch (parseError) {
              log.error("Failed to parse OpenAI SSE chunk:", parseError);
            }
          }
        }
      }
    } finally {
      // `releaseLock` only detaches the reader: the body stays open and keeps its buffers and
      // connection. The inactivity timeout above exits without `done`, which is exactly that case.
      if (!completed) {
        await reader.cancel().catch(() => undefined);
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        log.error(`NovelAI OpenAI streaming request timed out after ${timeout}ms`);
        yield {
          error: "Request timed out",
        };
      } else if (error.message.includes("stream read timed out")) {
        // Per-read inactivity timeout because NAI stopped sending data mid-stream.
        // Yield a final chunk so the stream adapter can flush any buffered text
        // (e.g., incomplete sentence trailing buffer) and terminate cleanly.
        log.warn(`NovelAI OpenAI: ${error.message}; yielding final chunk to flush buffers`);
        yield { final: true };
      } else {
        log.error("NovelAI OpenAI streaming error:", error);
        yield {
          error: error.message,
        };
      }
    } else {
      yield {
        error: "Unknown error occurred",
      };
    }
  }
}

/**
 * Start streaming generation from NovelAI using native SSE endpoint
 */
async function* novelaiGenerateStreamNative(
  request: NovelAIGenerationRequest,
  config: ApiRequestConfig,
): AsyncGenerator<NovelAIStreamChunk, void, unknown> {
  const { apiKey, timeout = REQUEST_TIMEOUT } = config;

  try {
    const url = `${NOVELAI_API_BASE_URL}/ai/generate-stream`;

    log.info("Starting NovelAI streaming generation");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      log.error(`NovelAI streaming request failed: ${response.status} ${errorText}`);

      yield {
        error: `NovelAI API request failed with status ${response.status}: ${errorText}`,
      };
      return;
    }

    if (!response.body) {
      log.error("NovelAI streaming response has no body");
      yield {
        error: "Response body is empty",
      };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let completed = false;

    try {
      while (true) {
        let readTimer: ReturnType<typeof setTimeout> | undefined;
        const readResult = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            readTimer = setTimeout(
              () => reject(new Error(`NovelAI stream read timed out after ${STREAM_READ_TIMEOUT_MS}ms of inactivity`)),
              STREAM_READ_TIMEOUT_MS,
            );
          }),
        ]);
        if (readTimer) clearTimeout(readTimer);

        const { done, value } = readResult;

        if (done) {
          log.info("NovelAI stream completed");
          completed = true;
          yield { final: true };
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim() || line.startsWith(":")) {
            continue;
          }

          if (line.startsWith("data: ")) {
            const data = line.slice(6); // Remove "data: " prefix

            try {
              const parsed = JSON.parse(data);

              // NovelAI sends tokens as strings in the response
              if (typeof parsed === "string") {
                yield { token: parsed };
              } else if (parsed.token) {
                yield { token: parsed.token };
              } else if (parsed.error) {
                yield { error: parsed.error };
                return;
              }
            } catch (_parseError) {
              log.warn(`Failed to parse NovelAI SSE data: ${data}`);
              yield { token: data };
            }
          }
        }
      }
    } finally {
      // `releaseLock` only detaches the reader: the body stays open and keeps its buffers and
      // connection. The inactivity timeout above exits without `done`, which is exactly that case.
      if (!completed) {
        await reader.cancel().catch(() => undefined);
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        log.error("NovelAI streaming timed out");
        yield { error: "Request timed out" };
      } else if (error.message.includes("stream read timed out")) {
        // Per-read inactivity timeout because NAI stopped sending data mid-stream
        log.warn(`NovelAI Native: ${error.message}; yielding final chunk to flush buffers`);
        yield { final: true };
      } else {
        log.error("NovelAI streaming failed:", error);
        yield { error: error.message };
      }
    } else {
      yield { error: "Unknown error occurred" };
    }
  }
}

/**
 * Start streaming generation from NovelAI
 * Routes to the appropriate endpoint based on the model
 */
export async function* novelaiGenerateStream(
  request: NovelAIGenerationRequest,
  config: ApiRequestConfig,
): AsyncGenerator<NovelAIStreamChunk, void, unknown> {
  if (usesOpenAIEndpoint(request.model)) {
    yield* novelaiGenerateStreamOpenAI(
      request.input,
      request.model,
      request.parameters,
      config,
      request.openAIStopStrings,
    );
  } else {
    yield* novelaiGenerateStreamNative(request, config);
  }
}

/**
 * Validate NovelAI API key by fetching user information
 * Uses GET /user/information which works for all account types
 * (subscribed, trial, Anlas-only) without triggering a generation.
 * @returns True if valid, throws error with details if invalid
 * @throws Error with statusCode and message on validation failure
 */
export async function validateNovelAIApiKey(apiKey: string): Promise<boolean> {
  log.info("Validating NovelAI API key");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(`${NOVELAI_ACCOUNT_API_BASE_URL}/user/information`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      log.success("NovelAI API key is valid");
      return true;
    }

    // Non-OK response: key is invalid or something else went wrong.
    // Carry the response body into the error message: NovelaiStreamAdapter
    // classifies some failures by matching the body text (e.g. trial-account
    // recaptcha 400s), and it is what makes host/endpoint migrations
    // self-diagnosing rather than surfacing as a bare "Bad Request".
    const errorText = await response.text().catch(() => "Unknown error");
    const error: Error & { statusCode?: number } = new Error(
      `API request failed: ${response.statusText}${errorText ? ` - ${errorText}` : ""}`,
    );
    error.statusCode = response.status;

    log.warn(`NovelAI API key validation failed with status ${response.status}: ${errorText}`);
    throw error;
  } catch (err) {
    clearTimeout(timeoutId);

    if (err instanceof Error && "statusCode" in err) {
      throw err;
    }

    const error: Error & { statusCode?: number } = new Error(
      err instanceof Error ? err.message : "Validation request failed",
    );
    error.statusCode = 408;
    throw error;
  }
}

/**
 * Check if an error is related to API key issues
 */
export function isNovelAIApiKeyError(error: string, statusCode?: number): boolean {
  const keywordErrors = ["unauthorized", "invalid api key", "authentication", "bearer"];

  return statusCode === 401 || keywordErrors.some((keyword) => error.toLowerCase().includes(keyword));
}

/**
 * Check if an error is related to insufficient credits
 */
export function isNovelAICreditsError(error: string, statusCode?: number): boolean {
  const creditsKeywords = ["insufficient", "credits", "quota", "billing"];

  return statusCode === 402 || creditsKeywords.some((keyword) => error.toLowerCase().includes(keyword));
}

/**
 * Check if an error is related to rate limiting
 */
export function isNovelAIRateLimitError(error: string, statusCode?: number): boolean {
  const rateLimitKeywords = ["rate limit", "too many requests"];

  return statusCode === 429 || rateLimitKeywords.some((keyword) => error.toLowerCase().includes(keyword));
}

/**
 * Base URL for NovelAI account-management endpoints (/user/*).
 *
 * NovelAI retired third-party access to the legacy api.novelai.net host: every
 * /user/* route there now answers a valid persistent token with
 * HTTP 400 "Please refresh NovelAI.net. If using a third-party tool, update to
 * the image URL." The route paths themselves are unchanged and are served by
 * both text.novelai.net and image.novelai.net; the text host is used here so
 * account calls share an origin with text generation.
 */
const NOVELAI_ACCOUNT_API_BASE_URL = "https://text.novelai.net";

/**
 * Shape of the perks object returned by GET /user/subscription.
 * Only contextTokens is used here; other perks are preserved for completeness.
 */
interface NovelAISubscriptionPerks {
  maxPriorityActions: number;
  startPriority: number;
  /** Maximum context size in tokens for this subscription tier */
  contextTokens: number;
  unlimitedMaxPriority: boolean;
  moduleTrainingSteps: number;
}

/**
 * Shape of the response returned by GET /user/subscription.
 */
export interface NovelAISubscription {
  tier: number;
  active: boolean;
  expiresAt: number;
  perks: NovelAISubscriptionPerks;
  isGracePeriod: boolean;
}

/**
 * Fetches the current NovelAI subscription for a given API key.
 *
 * Uses the account management routes (/user/*), which are served by the same
 * host as text generation. See NOVELAI_ACCOUNT_API_BASE_URL for why the legacy
 * api.novelai.net host can no longer be used.
 *
 * @returns Subscription data including perks.contextTokens, or null on failure
 */
export async function fetchNovelAISubscription(apiKey: string): Promise<NovelAISubscription | null> {
  const url = `${NOVELAI_ACCOUNT_API_BASE_URL}/user/subscription`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      log.warn(
        `NovelAI subscription fetch failed with status ${response.status}, so falling back to env var context limit`,
      );
      return null;
    }

    const data = (await response.json()) as NovelAISubscription;
    log.info(
      `NovelAI subscription: tier=${data.tier}, active=${data.active}, perks.contextTokens=${data.perks?.contextTokens ?? "unknown"} (note: contextTokens is NOT the context window; tier number determines that)`,
    );
    return data;
  } catch (error) {
    clearTimeout(timeoutId);
    log.warn("NovelAI subscription fetch threw an error, so falling back to env var context limit", error);
    return null;
  }
}
