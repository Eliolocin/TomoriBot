import { describe, expect, it } from "bun:test";
import { normalizeCustomEndpointUrlForStorage } from "@/utils/provider/customEndpointService";

describe("normalizeCustomEndpointUrlForStorage", () => {
  it("appends /v1 to a bare OpenAI-compatible origin", () => {
    expect(normalizeCustomEndpointUrlForStorage("openai-compatible", "http://localhost:1234")).toBe(
      "http://localhost:1234/v1",
    );
    expect(normalizeCustomEndpointUrlForStorage("openai-compatible", "https://api.openai.com")).toBe(
      "https://api.openai.com/v1",
    );
  });

  it("trims trailing slashes before normalizing", () => {
    expect(normalizeCustomEndpointUrlForStorage("openai-compatible", "http://localhost:1234/")).toBe(
      "http://localhost:1234/v1",
    );
    expect(normalizeCustomEndpointUrlForStorage("openai-compatible", "http://localhost:1234/v1/")).toBe(
      "http://localhost:1234/v1",
    );
  });

  it("places /v1 before query strings and fragments on bare origins", () => {
    expect(normalizeCustomEndpointUrlForStorage("openai-compatible", "http://localhost:1234?key=secret")).toBe(
      "http://localhost:1234/v1?key=secret",
    );
    expect(normalizeCustomEndpointUrlForStorage("openai-compatible", "http://localhost:1234/#ref")).toBe(
      "http://localhost:1234/v1#ref",
    );
    expect(normalizeCustomEndpointUrlForStorage("openai-compatible", "http://localhost:1234/?key=secret#ref")).toBe(
      "http://localhost:1234/v1?key=secret#ref",
    );
  });

  it("keeps URLs that already end in /v1", () => {
    expect(normalizeCustomEndpointUrlForStorage("openai-compatible", "http://localhost:1234/v1")).toBe(
      "http://localhost:1234/v1",
    );
    expect(normalizeCustomEndpointUrlForStorage("openai-compatible", "https://openrouter.ai/api/v1")).toBe(
      "https://openrouter.ai/api/v1",
    );
  });

  it("keeps explicit custom subpaths", () => {
    expect(normalizeCustomEndpointUrlForStorage("openai-compatible", "https://proxy.internal/v2")).toBe(
      "https://proxy.internal/v2",
    );
    expect(normalizeCustomEndpointUrlForStorage("openai-compatible", "https://gateway.com/custom/api")).toBe(
      "https://gateway.com/custom/api",
    );
  });

  it("normalizes bare origins for the OpenAI-compatible transcription style", () => {
    expect(normalizeCustomEndpointUrlForStorage("openai-compatible-transcription", "http://localhost:8000")).toBe(
      "http://localhost:8000/v1",
    );
    expect(normalizeCustomEndpointUrlForStorage("openai-compatible-transcription", "http://localhost:8000/v1")).toBe(
      "http://localhost:8000/v1",
    );
  });

  it("normalizes bare Ollama roots to its /v1 compatibility API", () => {
    expect(normalizeCustomEndpointUrlForStorage("ollama-native", "http://localhost:11434/")).toBe(
      "http://localhost:11434/v1",
    );
    expect(normalizeCustomEndpointUrlForStorage("ollama-native", "http://localhost:11434/v1")).toBe(
      "http://localhost:11434/v1",
    );
  });

  it("leaves non-OpenAI API styles untouched", () => {
    expect(normalizeCustomEndpointUrlForStorage("comfyui", "http://localhost:8188")).toBe("http://localhost:8188");
    expect(normalizeCustomEndpointUrlForStorage("tts-clone", "http://localhost:9880")).toBe("http://localhost:9880");
  });
});
