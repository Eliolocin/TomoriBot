import { afterEach, describe, expect, it } from "bun:test";
import { parseFetchUrlEngineOrder } from "@/tools/fetchUrl/dispatcher";
import { convertFetchedContent, SafeHttpFetchEngine } from "@/tools/fetchUrl/mcpFetchEngine";
import type { ToolContext } from "@/types/tool/interfaces";
import {
  createPinnedFetchRequest,
  fetchUserRemoteUrl,
  resolveValidatedUserRedirect,
} from "@/utils/security/userRemoteFetch";

const PRIVATE_NETWORK_ENV = "FETCH_URL_ALLOW_PRIVATE_NETWORK";
const RUN_ENV_NAME = "RUN_ENV";
const originalRunEnv = process.env[RUN_ENV_NAME];

describe("safe HTTP fetch engine", () => {
  afterEach(() => {
    delete process.env[PRIVATE_NETWORK_ENV];
    if (originalRunEnv === undefined) {
      delete process.env[RUN_ENV_NAME];
    } else {
      process.env[RUN_ENV_NAME] = originalRunEnv;
    }
  });

  it("uses only the guarded in-process engine by default", () => {
    process.env[RUN_ENV_NAME] = "production";
    expect(parseFetchUrlEngineOrder(undefined)).toEqual(["safe_http"]);
    expect(parseFetchUrlEngineOrder("mcp_fetch")).toEqual(["safe_http"]);
  });

  it("does not enable the external browser fetcher in production without an explicit opt-in", () => {
    process.env[RUN_ENV_NAME] = "production";
    expect(parseFetchUrlEngineOrder("crawl4ai,safe_http")).toEqual(["safe_http"]);

    process.env[PRIVATE_NETWORK_ENV] = "true";
    expect(parseFetchUrlEngineOrder("crawl4ai,safe_http")).toEqual(["crawl4ai", "safe_http"]);
  });

  it("admits the external browser fetcher outside production without an opt-in", () => {
    delete process.env[RUN_ENV_NAME];
    delete process.env[PRIVATE_NETWORK_ENV];
    expect(parseFetchUrlEngineOrder("crawl4ai,safe_http")).toEqual(["crawl4ai", "safe_http"]);
  });

  it("removes executable HTML content while converting readable content", () => {
    const markdown = convertFetchedContent(
      "<main><h1>Safe title</h1><script>metadata_secret()</script><p>Hello</p></main>",
      "text/html; charset=utf-8",
    );

    expect(markdown).toContain("# Safe title");
    expect(markdown).toContain("Hello");
    expect(markdown).not.toContain("metadata_secret");
  });

  it("pins the transport URL while preserving the origin Host and TLS name", () => {
    const request = createPinnedFetchRequest(
      new URL("https://example.com:8443/path?q=1"),
      { headers: { Accept: "text/plain" } },
      "203.0.113.10",
    );

    expect(request.url.toString()).toBe("https://203.0.113.10:8443/path?q=1");
    expect(new Headers(request.init.headers).get("host")).toBe("example.com:8443");
    expect(new Headers(request.init.headers).get("accept")).toBe("text/plain");
    expect(request.init.tls?.serverName).toBe("example.com");
  });

  it("returns a streaming response before its body finishes", async () => {
    process.env[RUN_ENV_NAME] = "development";
    let finishBody: (() => void) | undefined;
    const finishResponseBody = (): void => {
      const finish = finishBody;
      finishBody = undefined;
      finish?.();
    };
    const server = Bun.serve({
      hostname: "::",
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first"));
              finishBody = () => {
                controller.enqueue(new TextEncoder().encode("-second"));
                controller.close();
              };
            },
          }),
        ),
    });
    const responsePromise = fetchUserRemoteUrl(`http://localhost:${server.port}/stream`);
    const timeoutMarker = Symbol("response timeout");

    try {
      const response = await Promise.race([
        responsePromise,
        new Promise<typeof timeoutMarker>((resolve) => setTimeout(() => resolve(timeoutMarker), 1_000)),
      ]);

      expect(response).not.toBe(timeoutMarker);
      finishResponseBody();
      if (response !== timeoutMarker) {
        expect(await response.text()).toBe("first-second");
      }
    } finally {
      // Release the old blocking implementation too, so a failing regression
      // test does not leave an active request behind.
      finishResponseBody();
      await responsePromise.catch(() => undefined);
      server.stop(true);
    }
  });

  it("retries a refused POST on the next validated address without duplicating the body", async () => {
    process.env[RUN_ENV_NAME] = "development";
    let requestCount = 0;
    const receivedBodies: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        requestCount += 1;
        receivedBodies.push(await request.text());
        return Response.json({ ok: true });
      },
    });

    try {
      const response = await fetchUserRemoteUrl(`http://localhost:${server.port}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      });

      expect(response.ok).toBe(true);
      expect(requestCount).toBe(1);
      expect(receivedBodies).toEqual(['{"message":"hello"}']);
    } finally {
      server.stop(true);
    }
  });

  it("includes fetched page content in provider-visible result data", async () => {
    process.env[RUN_ENV_NAME] = "development";
    const server = Bun.serve({
      hostname: "::",
      port: 0,
      fetch: () =>
        new Response("<main><h1>Fetched title</h1><p>Readable body.</p></main>", {
          headers: { "Content-Type": "text/html" },
        }),
    });

    try {
      const result = await new SafeHttpFetchEngine().fetch(`http://localhost:${server.port}/page`, {}, {
        abortSignal: AbortSignal.timeout(5_000),
      } as ToolContext);
      const data = result.data as { summary?: string };

      expect(result.success).toBe(true);
      expect(data.summary).toBe(result.message);
      expect(data.summary).toContain("# Fetched title");
      expect(data.summary).toContain("Readable body.");
    } finally {
      server.stop(true);
    }
  });

  it("preserves start_index pagination in provider-visible summaries", async () => {
    process.env[RUN_ENV_NAME] = "development";
    const server = Bun.serve({
      hostname: "::",
      port: 0,
      fetch: () => new Response("abcdefghijklmnopqrstuvwxyz", { headers: { "Content-Type": "text/plain" } }),
    });
    const engine = new SafeHttpFetchEngine();
    const context = { abortSignal: AbortSignal.timeout(5_000) } as ToolContext;
    const url = `http://localhost:${server.port}/page`;

    try {
      const first = await engine.fetch(url, { maxLength: 10 }, context);
      const firstData = first.data as { summary: string; nextIndex?: number; startIndex: number };
      expect(firstData.summary).toContain("abcdefghij");
      expect(firstData.summary).toContain("start_index=10");
      expect(firstData.nextIndex).toBe(10);

      const second = await engine.fetch(url, { maxLength: 10, startIndex: firstData.nextIndex }, context);
      const secondData = second.data as { summary: string; nextIndex?: number; startIndex: number };
      expect(secondData.summary).toContain("klmnopqrst");
      expect(secondData.startIndex).toBe(10);
      expect(secondData.nextIndex).toBe(20);
    } finally {
      server.stop(true);
    }
  });

  it("rejects a redirect from a public URL to Azure IMDS before the next request", async () => {
    await expect(
      resolveValidatedUserRedirect(
        new URL("https://example.com/start"),
        "https://169.254.169.254/metadata/identity/oauth2/token",
        true,
      ),
    ).rejects.toThrow(/link-local|publicly routable/i);
  });
});
