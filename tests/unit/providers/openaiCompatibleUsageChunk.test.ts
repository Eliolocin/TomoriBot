import { afterEach, describe, expect, it } from "bun:test";
import { OpenAICompatibleStreamAdapter } from "@/providers/openaiCompatible/openaiCompatibleStreamAdapter";
import type { OpenAICompatibleStreamConfig } from "@/providers/openaiCompatible/openaiCompatibleTypes";
import type { RawStreamChunk, StreamContext } from "@/types/stream/interfaces";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Minimal adapter options: the usage-extraction path under test touches none of
 * the request-building hooks, so stub resolveApiUrl and the naming fields only.
 */
function makeAdapter(): OpenAICompatibleStreamAdapter {
  return new OpenAICompatibleStreamAdapter({
    providerName: "test",
    adapterName: "TestAdapter",
    localeNamespace: "test",
    errorMessagePrefix: "Test",
    resolveApiUrl: () => "https://example.invalid/v1/chat/completions",
  });
}

function makeChunk(data: Record<string, unknown>): RawStreamChunk {
  return { data, provider: "test", metadata: { timestamp: Date.now() } };
}

function makeSseResponse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function makeStreamConfig(): OpenAICompatibleStreamConfig {
  return {
    model: "example/model",
    apiKey: "test-key",
    temperature: 0.8,
    topP: 0.9,
    minP: 0.1,
    logitBias: { "123": -100 },
    inactivityTimeoutMs: 5_000,
  } as OpenAICompatibleStreamConfig;
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
    provider: "test",
    locale: "en-US",
  } as unknown as StreamContext;
}

async function collectRawChunks(adapter: OpenAICompatibleStreamAdapter): Promise<RawStreamChunk[]> {
  const chunks: RawStreamChunk[] = [];
  for await (const chunk of adapter.startStream(makeStreamConfig(), makeStreamContext())) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("OpenAICompatibleStreamAdapter usage capture", () => {
  it("surfaces usage from a trailing chunk that has empty choices (include_usage)", () => {
    // With stream_options.include_usage, the final chunk carries usage but no
    // choices. This previously early-returned and dropped the usage entirely.
    const adapter = makeAdapter();
    const result = adapter.processChunk(
      makeChunk({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 88, total_tokens: 1288 } }),
    );

    expect(result.type).toBe("text");
    expect(result.content).toBe("");
    expect(result.metadata?.usage).toEqual({ prompt_tokens: 1200, completion_tokens: 88, total_tokens: 1288 });
  });

  it("still returns no metadata for an empty-choices chunk without usage", () => {
    const adapter = makeAdapter();
    const result = adapter.processChunk(makeChunk({ choices: [] }));

    expect(result.type).toBe("text");
    expect(result.content).toBe("");
    expect(result.metadata).toBeUndefined();
  });
});

/**
 * Mirrors the NVIDIA adapter's configuration: it injects thinking params via mutateRequestBody,
 * opts into opaque-5xx degradation, and declares the keys it injects.
 */
function makeNvidiaLikeAdapter(): OpenAICompatibleStreamAdapter {
  return new OpenAICompatibleStreamAdapter({
    providerName: "test",
    adapterName: "TestAdapter",
    localeNamespace: "test",
    errorMessagePrefix: "Test",
    degradeOnOpaque5xx: true,
    degradationPriorityKeys: ["reasoning_budget"],
    mandatoryBodyKeys: ["chat_template_kwargs"],
    resolveApiUrl: () => "https://example.invalid/v1/chat/completions",
    mutateRequestBody: ({ requestBody }) => {
      requestBody.reasoning_budget = 16384;
      requestBody.chat_template_kwargs = { enable_thinking: true };
    },
  });
}

describe("OpenAICompatibleStreamAdapter parameter degradation", () => {
  it("recovers from an opaque mid-SSE 500 caused by an injected parameter", async () => {
    // The NVIDIA outage, end to end: NIM on the vLLM V2 runner answers `reasoning_budget` with a
    // 200 followed by a content-free mid-SSE 500, naming nothing. Recovery needs the opaque-5xx
    // classifier (to queue any retry at all) and the priority-key declaration (so the injected key
    // is probed instead of sorting into the unknown tail) working together.
    const requestBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requestBodies.push(body);
      if ("reasoning_budget" in body) {
        return makeSseResponse([
          { error: { code: 500, message: "Internal server error", type: "internal_server_error" } },
        ]);
      }
      return makeSseResponse([{ choices: [{ index: 0, delta: { content: "Recovered" } }] }, "[DONE]"]);
    }) as typeof fetch;

    const chunks = await collectRawChunks(makeNvidiaLikeAdapter());

    // default, no_stream_options, then the injected key. Asserted because the count is the whole
    // user-visible cost of this path: every rung is a full chat completion the user waits through,
    // and the ladder is deliberately not cached, so it is paid again on the next message.
    expect(requestBodies).toHaveLength(3);

    const successfulBody = requestBodies[requestBodies.length - 1];
    expect(successfulBody).not.toHaveProperty("reasoning_budget");
    expect(successfulBody).toHaveProperty("chat_template_kwargs");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.data).toMatchObject({ choices: [{ delta: { content: "Recovered" } }] });
  });

  it("fails fast on a descriptive 5xx instead of walking the ladder", async () => {
    // A real outage says so, and every rung would fail identically. Burning the ladder here only
    // delays the key-rotation and model-fallback paths that can actually recover the turn.
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return makeSseResponse([
        { error: { code: 503, message: "Service temporarily overloaded, please try again later" } },
      ]);
    }) as typeof fetch;

    const chunks = await collectRawChunks(makeNvidiaLikeAdapter());

    expect(fetchCalls).toBe(1);
    expect(chunks.at(-1)?.data).toMatchObject({ error: { code: 503 } });
  });

  it("restarts an uncommitted SSE error with all named parameters removed", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requestBodies.length === 1) {
        return makeSseResponse([
          {
            error: {
              code: 502,
              message: "The min_p and logit_bias sampling parameters are not yet supported with speculative decoding.",
            },
          },
        ]);
      }
      return makeSseResponse([{ choices: [{ index: 0, delta: { content: "Recovered" } }] }, "[DONE]"]);
    }) as typeof fetch;

    const chunks = await collectRawChunks(makeAdapter());

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

    const chunks = await collectRawChunks(makeAdapter());

    expect(fetchCalls).toBe(1);
    expect(chunks).toHaveLength(2);
    expect(chunks[1]?.data).toMatchObject({ error: { code: 502, message: "Unsupported parameter: min_p" } });
  });

  it("fails fast on a bare 502 outage instead of walking the ladder", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("Bad gateway", { status: 502, statusText: "Bad Gateway" });
    }) as typeof fetch;

    const chunks = await collectRawChunks(makeAdapter());

    expect(fetchCalls).toBe(1);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.data).toMatchObject({ error: {} });
  });

  it("retries when the error names a parameter even if no classifier heuristic matches", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requestBodies.length === 1) {
        // Wording that matches none of the classifier substrings, so only the
        // targeted param extraction can justify this retry.
        return new Response("min_p cannot be used with this model", { status: 400, statusText: "Bad Request" });
      }
      return makeSseResponse([{ choices: [{ index: 0, delta: { content: "Recovered" } }] }]);
    }) as typeof fetch;

    const chunks = await collectRawChunks(makeAdapter());

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[1]).not.toHaveProperty("min_p");
    expect(requestBodies[1]).toHaveProperty("logit_bias");
    expect(chunks[0]?.data).toMatchObject({ choices: [{ delta: { content: "Recovered" } }] });
  });

  it("uses the shared ladder for fetch-time parameter rejection", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requestBodies.length === 1) {
        return new Response(JSON.stringify({ error: { message: "Unsupported parameter: min_p" } }), {
          status: 400,
          statusText: "Bad Request",
        });
      }
      return makeSseResponse([{ choices: [{ index: 0, delta: { content: "Recovered" } }] }]);
    }) as typeof fetch;

    const chunks = await collectRawChunks(makeAdapter());

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[1]).not.toHaveProperty("min_p");
    expect(requestBodies[1]).toHaveProperty("stream_options");
    expect(chunks[0]?.data).toMatchObject({ choices: [{ delta: { content: "Recovered" } }] });
  });

  it("folds the provider-specific stop rejection hook into shared classification", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    let classifierCalls = 0;
    const adapter = new OpenAICompatibleStreamAdapter({
      providerName: "test",
      adapterName: "TestAdapter",
      localeNamespace: "test",
      errorMessagePrefix: "Test",
      resolveApiUrl: () => "https://example.invalid/v1/chat/completions",
      shouldRetryWithoutStop: (statusCode, errorText) => {
        classifierCalls += 1;
        return statusCode === 422 && errorText.includes("stop");
      },
    });
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requestBodies.length === 1) {
        return new Response("stop is not allowed", { status: 422, statusText: "Unprocessable Content" });
      }
      return makeSseResponse([{ choices: [{ index: 0, delta: { content: "Recovered" } }] }]);
    }) as typeof fetch;

    await collectRawChunks(adapter);

    expect(classifierCalls).toBe(1);
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).toHaveProperty("stop");
    expect(requestBodies[1]).not.toHaveProperty("stop");
  });

  it("preserves the stream_options fallback for 422 responses", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requestBodies.length === 1) {
        return new Response("stream_options is unsupported", {
          status: 422,
          statusText: "Unprocessable Content",
        });
      }
      return makeSseResponse([{ choices: [{ index: 0, delta: { content: "Recovered" } }] }]);
    }) as typeof fetch;

    await collectRawChunks(makeAdapter());

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).toHaveProperty("stream_options");
    expect(requestBodies[1]).not.toHaveProperty("stream_options");
  });
});
