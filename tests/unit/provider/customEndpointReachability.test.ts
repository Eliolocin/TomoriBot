import { afterEach, describe, expect, it } from "bun:test";
import {
  normalizeCustomEndpointUrlForStorage,
  validateCustomEndpointReachability,
} from "@/utils/provider/customEndpointService";

const RUN_ENV_NAME = "RUN_ENV";
const originalRunEnv = process.env[RUN_ENV_NAME];

describe("custom endpoint reachability", () => {
  afterEach(() => {
    if (originalRunEnv === undefined) {
      delete process.env[RUN_ENV_NAME];
    } else {
      process.env[RUN_ENV_NAME] = originalRunEnv;
    }
  });

  it("uses Ollama's native model discovery route", async () => {
    process.env[RUN_ENV_NAME] = "development";
    const requestedPaths: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        requestedPaths.push(path);
        return path === "/api/tags" ? Response.json({ models: [] }) : new Response(null, { status: 404 });
      },
    });

    try {
      const result = await validateCustomEndpointReachability({
        apiStyle: "ollama-native",
        endpointUrl: `http://localhost:${server.port}`,
      });

      expect(result).toEqual({ ok: true });
      expect(requestedPaths).toEqual(["/api/tags"]);
    } finally {
      server.stop(true);
    }
  });

  it("stores an Ollama root against its OpenAI-compatible API base", () => {
    expect(normalizeCustomEndpointUrlForStorage("ollama-native", "http://localhost:11434/")).toBe(
      "http://localhost:11434/v1",
    );
    expect(normalizeCustomEndpointUrlForStorage("ollama-native", "http://localhost:11434/v1")).toBe(
      "http://localhost:11434/v1",
    );
  });

  it("probes /v1/models first when a transcription URL already ends in /v1", async () => {
    process.env[RUN_ENV_NAME] = "development";
    const requestedPaths: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        requestedPaths.push(path);
        return path === "/v1/models" ? Response.json({ data: [] }) : new Response(null, { status: 404 });
      },
    });

    try {
      const result = await validateCustomEndpointReachability({
        apiStyle: "openai-compatible-transcription",
        endpointUrl: `http://localhost:${server.port}/v1`,
      });

      expect(result).toEqual({ ok: true });
      expect(requestedPaths).toEqual(["/v1/models"]);
    } finally {
      server.stop(true);
    }
  });

  it("falls back to /models for a versioned transcription URL without probing /v1/v1/models", async () => {
    process.env[RUN_ENV_NAME] = "development";
    const requestedPaths: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        requestedPaths.push(path);
        return path === "/models" ? Response.json({ data: [] }) : new Response(null, { status: 404 });
      },
    });

    try {
      const result = await validateCustomEndpointReachability({
        apiStyle: "openai-compatible-transcription",
        endpointUrl: `http://localhost:${server.port}/v1`,
      });

      expect(result).toEqual({ ok: true });
      expect(requestedPaths).toEqual(["/v1/models", "/models"]);
    } finally {
      server.stop(true);
    }
  });
});
