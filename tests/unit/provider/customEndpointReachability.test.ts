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
});
