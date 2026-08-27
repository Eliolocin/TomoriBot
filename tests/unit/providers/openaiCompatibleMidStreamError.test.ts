import { describe, expect, it } from "bun:test";
import { classifyOpenAICompatibleStatus } from "@/providers/openaiCompatible/openaiCompatibleErrorFormatter";
import { OpenAICompatibleStreamAdapter } from "@/providers/openaiCompatible/openaiCompatibleStreamAdapter";
import type { RawStreamChunk } from "@/types/stream/interfaces";

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

describe("classifyOpenAICompatibleStatus", () => {
  it.each([
    [500, "provider_overloaded", true],
    [502, "provider_overloaded", true],
    [503, "provider_overloaded", true],
    [408, "timeout", true],
    [429, "rate_limit", true],
    [400, "api_error", false],
    [401, "api_error", false],
  ] as const)("maps %i", (statusCode, type, retryable) => {
    const classification = classifyOpenAICompatibleStatus(statusCode, "Internal server error");
    expect(classification.type).toBe(type);
    expect(classification.retryable).toBe(retryable);
  });

  it("returns an unknown classification when no status is available", () => {
    expect(classifyOpenAICompatibleStatus(null, "something went wrong")).toEqual({
      type: "unknown",
      code: "unknown",
      retryable: false,
    });
  });

  it("re-codes a 429 that is really a billing denial", () => {
    expect(classifyOpenAICompatibleStatus(429, "Insufficient balance").code).toBe("429_balance");
  });
});

describe("processChunk on an SSE error event", () => {
  it("classifies a mid-stream 500 as a retryable provider overload", () => {
    // The SSE path used to hardcode a non-retryable api_error, which reported a transient
    // mid-stream failure to users as a permanent request error while the HTTP path for the very
    // same status said provider_overloaded.
    const processed = makeAdapter().processChunk(
      makeChunk({ error: { code: 500, message: "Internal server error", type: "internal_server_error" } }),
    );

    expect(processed.type).toBe("error");
    expect(processed.error?.type).toBe("provider_overloaded");
    expect(processed.error?.retryable).toBe(true);
    expect(processed.error?.code).toBe("500");
  });

  it("surfaces the provider error type alongside an opaque message", () => {
    const processed = makeAdapter().processChunk(
      makeChunk({ error: { code: 500, message: "Internal server error", type: "internal_server_error" } }),
    );

    expect(processed.error?.message).toContain("internal_server_error");
  });

  it("does not repeat a type the message already carries", () => {
    const processed = makeAdapter().processChunk(
      makeChunk({
        error: { code: 500, message: "internal_server_error while generating", type: "internal_server_error" },
      }),
    );

    expect(processed.error?.message).toBe("internal_server_error while generating");
  });

  it("keeps a non-numeric error code when no status can be derived", () => {
    const processed = makeAdapter().processChunk(
      makeChunk({ error: { code: "context_length_exceeded", message: "too long" } }),
    );

    expect(processed.error?.code).toBe("context_length_exceeded");
    expect(processed.error?.retryable).toBe(false);
  });
});
