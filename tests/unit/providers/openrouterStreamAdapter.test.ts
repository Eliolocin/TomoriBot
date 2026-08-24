import { afterEach, describe, expect, it } from "bun:test";
import { OpenrouterStreamAdapter, type OpenrouterStreamConfig } from "@/providers/openrouter/openrouterStreamAdapter";
import type { RawStreamChunk, StreamContext } from "@/types/stream/interfaces";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeSseResponse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function makeStreamConfig(): OpenrouterStreamConfig {
  return {
    model: "example/model",
    apiKey: "test-key",
    temperature: 0.8,
    topP: 0.9,
    minP: 0.1,
    logitBias: { "123": -100 },
    inactivityTimeoutMs: 5_000,
  } as OpenrouterStreamConfig;
}

function makeStreamContext(): StreamContext {
  return {
    channel: {},
    client: {},
    tomoriState: {
      persona_nickname: "Tomori",
      trigger_words: [],
      config: {
        llm_stop_speaker_pattern_enabled: false,
        llm_stop_strings: null,
        thinking_level: "none",
      },
    },
    contextItems: [],
    currentTurnModelParts: [],
    provider: "openrouter",
    locale: "en-US",
  } as unknown as StreamContext;
}

async function collectRawChunks(adapter: OpenrouterStreamAdapter): Promise<RawStreamChunk[]> {
  const chunks: RawStreamChunk[] = [];
  for await (const chunk of adapter.startStream(makeStreamConfig(), makeStreamContext())) {
    chunks.push(chunk);
  }
  return chunks;
}

/**
 * Builds a RawStreamChunk wrapping an OpenRouter-shaped data object.
 * chunk.data is typed as unknown so no type assertion is needed in the fixture.
 */
function makeOpenrouterChunk(data: Record<string, unknown>): RawStreamChunk {
  return { data, provider: "openrouter", metadata: { timestamp: Date.now() } };
}

describe("OpenrouterStreamAdapter.processChunk", () => {
  it("preserves visible text from delta.content exactly", () => {
    const adapter = new OpenrouterStreamAdapter();
    const result = adapter.processChunk(
      makeOpenrouterChunk({
        choices: [{ index: 0, delta: { content: "Hello, world!" } }],
      }),
    );

    expect(result.type).toBe("text");
    expect(result.content).toBe("Hello, world!");
    expect(result.thoughts).toBeUndefined();
  });

  it("captures delta.reasoning in thoughts and emits empty visible content", () => {
    const adapter = new OpenrouterStreamAdapter();
    const result = adapter.processChunk(
      makeOpenrouterChunk({
        choices: [{ index: 0, delta: { reasoning: "internal chain-of-thought" } }],
      }),
    );

    expect(result.type).toBe("text");
    // Reasoning must not surface as visible Discord text
    expect(result.content).toBe("");
    expect(result.thoughts).toBeDefined();
    expect(result.thoughts?.[0]).toMatchObject({ kind: "raw", content: "internal chain-of-thought" });
  });

  it("keeps reasoning in thoughts and visible text in content when both are present", () => {
    const adapter = new OpenrouterStreamAdapter();
    const result = adapter.processChunk(
      makeOpenrouterChunk({
        choices: [{ index: 0, delta: { content: "Visible reply.", reasoning: "hidden thought" } }],
      }),
    );

    expect(result.type).toBe("text");
    expect(result.content).toBe("Visible reply.");
    // Reasoning must not be mixed into visible content
    expect(result.content).not.toContain("hidden thought");
    expect(result.thoughts?.[0]).toMatchObject({ kind: "raw", content: "hidden thought" });
  });

  it("maps SSE-injected 429 error to rate_limit, retryable true", () => {
    const adapter = new OpenrouterStreamAdapter();
    const result = adapter.processChunk(makeOpenrouterChunk({ error: { code: 429, message: "Rate limit exceeded" } }));

    expect(result.type).toBe("error");
    expect(result.error?.type).toBe("rate_limit");
    expect(result.error?.retryable).toBe(true);
  });

  it("maps SSE-injected 503 error to provider_overloaded, retryable true", () => {
    const adapter = new OpenrouterStreamAdapter();
    const result = adapter.processChunk(makeOpenrouterChunk({ error: { code: 503, message: "Service overloaded" } }));

    expect(result.type).toBe("error");
    expect(result.error?.type).toBe("provider_overloaded");
    expect(result.error?.retryable).toBe(true);
  });

  it("maps SSE-injected 401 error to api_error, not retryable", () => {
    const adapter = new OpenrouterStreamAdapter();
    const result = adapter.processChunk(makeOpenrouterChunk({ error: { code: 401, message: "Invalid API key" } }));

    expect(result.type).toBe("error");
    expect(result.error?.type).toBe("api_error");
    expect(result.error?.retryable).toBe(false);
  });

  it("passes through a pre-formed ProviderError from error field unchanged", () => {
    const adapter = new OpenrouterStreamAdapter();
    const preFormed = {
      type: "rate_limit",
      message: "quota exceeded",
      retryable: true,
      code: "429",
    };
    const result = adapter.processChunk(makeOpenrouterChunk({ error: preFormed }));

    expect(result.type).toBe("error");
    expect(result.error?.type).toBe("rate_limit");
    expect(result.error?.retryable).toBe(true);
  });

  it("returns empty text for a keepalive chunk with no choices", () => {
    const adapter = new OpenrouterStreamAdapter();
    const result = adapter.processChunk(makeOpenrouterChunk({}));

    expect(result.type).toBe("text");
    expect(result.content).toBe("");
  });

  it("returns done for finishReason stop with no delta content", () => {
    const adapter = new OpenrouterStreamAdapter();
    const result = adapter.processChunk(
      makeOpenrouterChunk({
        choices: [{ index: 0, finishReason: "stop", delta: {} }],
      }),
    );

    expect(result.type).toBe("done");
  });

  it("returns text containing last fragment for finishReason stop with delta content", () => {
    const adapter = new OpenrouterStreamAdapter();
    const result = adapter.processChunk(
      makeOpenrouterChunk({
        choices: [{ index: 0, finishReason: "stop", delta: { content: "final fragment" } }],
      }),
    );

    expect(result.type).toBe("text");
    expect(result.content).toBe("final fragment");
  });

  it("assembles a function_call with correct name and args on finishReason tool_calls", () => {
    const adapter = new OpenrouterStreamAdapter();

    const result = adapter.processChunk(
      makeOpenrouterChunk({
        choices: [
          {
            index: 0,
            finishReason: "tool_calls",
            delta: {
              toolCalls: [
                {
                  index: 0,
                  id: "call_abc",
                  type: "function",
                  function: { name: "search_web", arguments: '{"query":"TomoriBot changelog"}' },
                },
              ],
            },
          },
        ],
      }),
    );

    expect(result.type).toBe("function_call");
    expect(result.functionCall?.name).toBe("search_web");
    expect(result.functionCall?.args).toEqual({ query: "TomoriBot changelog" });
    expect(result.content).toBeUndefined();
  });

  it("accumulates split tool-call chunks and resolves on the finish chunk", () => {
    const adapter = new OpenrouterStreamAdapter();

    adapter.processChunk(
      makeOpenrouterChunk({
        choices: [
          {
            index: 0,
            delta: {
              toolCalls: [
                { index: 0, id: "call_xyz", type: "function", function: { name: "get_time", arguments: "" } },
              ],
            },
          },
        ],
      }),
    );

    adapter.processChunk(
      makeOpenrouterChunk({
        choices: [
          {
            index: 0,
            delta: { toolCalls: [{ index: 0, function: { arguments: '{"tz":"UTC"}' } }] },
          },
        ],
      }),
    );

    const result = adapter.processChunk(
      makeOpenrouterChunk({
        choices: [{ index: 0, finishReason: "tool_calls", delta: {} }],
      }),
    );

    expect(result.type).toBe("function_call");
    expect(result.functionCall?.name).toBe("get_time");
    expect(result.functionCall?.args).toEqual({ tz: "UTC" });
  });

  it("returns done for finishReason error (mid-stream unified error format)", () => {
    const adapter = new OpenrouterStreamAdapter();
    const result = adapter.processChunk(
      makeOpenrouterChunk({
        choices: [{ index: 0, finishReason: "error", delta: {} }],
      }),
    );

    expect(result.type).toBe("error");
    expect(result.error?.retryable).toBe(false);
  });
});

describe("OpenrouterStreamAdapter.handleProviderError", () => {
  it("maps statusCode 429 to rate_limit, retryable true", () => {
    const adapter = new OpenrouterStreamAdapter();
    const error = { statusCode: 429, message: "Too Many Requests" };
    const result = adapter.handleProviderError(error);

    expect(result.type).toBe("rate_limit");
    expect(result.retryable).toBe(true);
  });

  it("maps statusCode 503 to provider_overloaded, retryable true", () => {
    const adapter = new OpenrouterStreamAdapter();
    const error = { statusCode: 503, message: "Service Temporarily Unavailable" };
    const result = adapter.handleProviderError(error);

    expect(result.type).toBe("provider_overloaded");
    expect(result.retryable).toBe(true);
  });

  it("maps statusCode 401 to api_error, not retryable", () => {
    const adapter = new OpenrouterStreamAdapter();
    const error = { statusCode: 401, message: "Unauthorized — invalid API key" };
    const result = adapter.handleProviderError(error);

    expect(result.type).toBe("api_error");
    expect(result.retryable).toBe(false);
  });

  it("maps statusCode 404 to api_error, not retryable", () => {
    const adapter = new OpenrouterStreamAdapter();
    const error = { statusCode: 404, message: "Model not found" };
    const result = adapter.handleProviderError(error);

    expect(result.type).toBe("api_error");
    expect(result.retryable).toBe(false);
  });

  it("extracts error code from body JSON when statusCode is absent", () => {
    const adapter = new OpenrouterStreamAdapter();
    const error = {
      body: JSON.stringify({ error: { code: 429, message: "Rate limit hit" } }),
      message: "Request failed",
    };
    const result = adapter.handleProviderError(error);

    expect(result.type).toBe("rate_limit");
    expect(result.retryable).toBe(true);
  });

  it("extracts error code from nested error.code field", () => {
    const adapter = new OpenrouterStreamAdapter();
    const error = { error: { code: 503, message: "Server overloaded" }, message: "OpenRouter error" };
    const result = adapter.handleProviderError(error);

    expect(result.type).toBe("provider_overloaded");
    expect(result.retryable).toBe(true);
  });

  it("returns a fully-formed ProviderError with required fields", () => {
    const adapter = new OpenrouterStreamAdapter();
    const error = new Error("Unexpected network failure");
    const result = adapter.handleProviderError(error);

    expect(typeof result.type).toBe("string");
    expect(typeof result.message).toBe("string");
    expect(typeof result.retryable).toBe("boolean");
    expect(result.originalError).toBe(error);
  });
});

describe("OpenrouterStreamAdapter tool history", () => {
  it("does not duplicate a text-only tool response as a user message", async () => {
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return makeSseResponse(["[DONE]"]);
    }) as typeof fetch;

    const context = makeStreamContext();
    context.functionInteractionHistory = [
      {
        functionCall: { name: "fetch_url", args: { url: "https://example.com" } },
        functionResponse: {
          functionResponse: {
            name: "fetch_url",
            response: { result: { summary: "Fetched page content" } },
          },
        },
      },
    ];

    for await (const _chunk of new OpenrouterStreamAdapter().startStream(makeStreamConfig(), context)) {
      // Drain the stream so the request body is fully assembled and processed.
    }

    const messages = requestBody?.messages as Array<Record<string, unknown>>;
    expect(messages.map((message) => message.role)).toEqual(["assistant", "tool"]);
    expect(String(messages[1]?.content)).toContain("Fetched page content");
  });
});

describe("OpenrouterStreamAdapter parameter degradation", () => {
  it("restarts an uncommitted SSE error with all named parameters removed", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requestBodies.length === 1) {
        return makeSseResponse([
          {
            error: {
              code: 502,
              message: "Provider returned error",
              metadata: {
                raw: "The min_p and logit_bias sampling parameters are not yet supported with speculative decoding.",
              },
            },
          },
        ]);
      }
      return makeSseResponse([{ choices: [{ index: 0, delta: { content: "Recovered" } }] }, "[DONE]"]);
    }) as typeof fetch;

    const chunks = await collectRawChunks(new OpenrouterStreamAdapter());

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[1]).not.toHaveProperty("min_p");
    expect(requestBodies[1]).not.toHaveProperty("logit_bias");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.data).toMatchObject({ choices: [{ delta: { content: "Recovered" } }] });
  });

  it("does not restart an SSE error after visible content commits the stream", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return makeSseResponse([
        { choices: [{ index: 0, delta: { content: "Partial output" } }] },
        { error: { code: 502, message: "Unsupported parameter: min_p" } },
      ]);
    }) as typeof fetch;

    const chunks = await collectRawChunks(new OpenrouterStreamAdapter());

    expect(fetchCalls).toBe(1);
    expect(chunks).toHaveLength(2);
    expect(chunks[1]?.data).toMatchObject({ error: { code: 502, message: "Unsupported parameter: min_p" } });
  });

  it("caps message-targeted retries at three before returning to the static ladder", async () => {
    const namedParams = ["min_p", "logit_bias", "temperature", "top_p"];
    const requestBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const namedParam = namedParams[requestBodies.length - 1];
      return makeSseResponse([
        {
          error: {
            code: 502,
            message: namedParam ? `Unsupported parameter: ${namedParam}` : "Bad gateway",
          },
        },
      ]);
    }) as typeof fetch;

    const chunks = await collectRawChunks(new OpenrouterStreamAdapter());

    expect(requestBodies[1]).not.toHaveProperty("min_p");
    expect(requestBodies[2]).not.toHaveProperty("min_p");
    expect(requestBodies[2]).not.toHaveProperty("logit_bias");
    expect(requestBodies[3]).not.toHaveProperty("temperature");
    expect(requestBodies[3]).toHaveProperty("top_p");
    expect(requestBodies[4]).toHaveProperty("min_p");
    expect(requestBodies[4]).toHaveProperty("top_p");
    expect(chunks.at(-1)?.data).toMatchObject({ error: { code: 502 } });
  });
});

/**
 * Unlike `makeSseResponse`, this reports whether the body was cancelled and never closes the
 * stream, which is the state an abandoned response is really in: the server has not ended it.
 */
function makeCancelObservableSseResponse(events: unknown[]): {
  response: Response;
  wasCancelled: () => boolean;
} {
  let cancelled = false;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  return {
    response: new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
    wasCancelled: () => cancelled,
  };
}

/**
 * A retained response body holds its buffers and its connection. Production heap snapshots showed
 * these accumulating one per abandoned request, so the teardown is load-bearing rather than tidiness.
 */
describe("OpenrouterStreamAdapter response body teardown", () => {
  it("cancels the body when the consumer stops iterating early", async () => {
    const { response, wasCancelled } = makeCancelObservableSseResponse([
      { choices: [{ index: 0, delta: { content: "Hello" } }] },
    ]);
    globalThis.fetch = (async () => response) as typeof fetch;

    for await (const _chunk of new OpenrouterStreamAdapter().startStream(makeStreamConfig(), makeStreamContext())) {
      break;
    }

    expect(wasCancelled()).toBe(true);
  });

  it("leaves a body that ended on its own alone", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = (async () =>
      new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })) as typeof fetch;

    for await (const _chunk of new OpenrouterStreamAdapter().startStream(makeStreamConfig(), makeStreamContext())) {
      // Drain fully so the stream reaches its natural end.
    }

    expect(cancelled).toBe(false);
  });
});
