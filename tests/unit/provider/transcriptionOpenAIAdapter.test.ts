import { afterEach, describe, expect, it } from "bun:test";
import { transcribeViaOpenAIAdapter } from "@/providers/custom/styles/transcriptionOpenAIAdapter";
import type { CustomEndpointRow } from "@/types/db/schema";

const RUN_ENV_NAME = "RUN_ENV";
const originalRunEnv = process.env[RUN_ENV_NAME];

function buildTranscriptionEndpoint(endpointUrl: string): CustomEndpointRow {
  return {
    connection_id: 1,
    label: "whisper",
    capability: "transcription",
    api_style: "openai-compatible-transcription",
    endpoint_url: endpointUrl,
    requires_auth: false,
    extra_config: { model: "whisper-1" },
  };
}

describe("transcribeViaOpenAIAdapter", () => {
  afterEach(() => {
    if (originalRunEnv === undefined) {
      delete process.env[RUN_ENV_NAME];
    } else {
      process.env[RUN_ENV_NAME] = originalRunEnv;
    }
  });

  it("appends /audio/transcriptions without doubling /v1 when the stored URL ends in /v1", async () => {
    process.env[RUN_ENV_NAME] = "development";
    const requestedPaths: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        requestedPaths.push(new URL(request.url).pathname);
        return Response.json({ text: "hello world" });
      },
    });

    try {
      const result = await transcribeViaOpenAIAdapter({
        endpoint: buildTranscriptionEndpoint(`http://localhost:${server.port}/v1`),
        apiKey: "",
        audioBuffer: Buffer.from("fake-audio"),
        filename: "sample.wav",
      });

      expect(result).toEqual({ success: true, transcriptText: "hello world" });
      expect(requestedPaths).toEqual(["/v1/audio/transcriptions"]);
    } finally {
      server.stop(true);
    }
  });

  it("POSTs to /v1/audio/transcriptions when the stored URL omits /v1", async () => {
    process.env[RUN_ENV_NAME] = "development";
    const requestedPaths: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        requestedPaths.push(new URL(request.url).pathname);
        return Response.json({ text: "general kenobi" });
      },
    });

    try {
      const result = await transcribeViaOpenAIAdapter({
        endpoint: buildTranscriptionEndpoint(`http://localhost:${server.port}`),
        apiKey: "",
        audioBuffer: Buffer.from("fake-audio"),
        filename: "sample.wav",
      });

      expect(result).toEqual({ success: true, transcriptText: "general kenobi" });
      expect(requestedPaths).toEqual(["/v1/audio/transcriptions"]);
    } finally {
      server.stop(true);
    }
  });
});
