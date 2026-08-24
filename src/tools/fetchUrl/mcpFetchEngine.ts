import TurndownService from "turndown";
import type { ToolContext, ToolResult } from "@/types/tool/interfaces";
import { FETCH_LIMITS } from "@/utils/security/rateLimiter";
import { fetchUserRemoteUrl } from "@/utils/security/userRemoteFetch";
import type { FetchEngine, FetchOpts } from "./types";
import { isPrivateNetworkFetchAllowed } from "./urlSafety";

const MAX_CONTENT_LENGTH = Math.max(
  1,
  Number.parseInt(process.env.FETCH_URL_MAX_CONTENT_LENGTH ?? "50000", 10) || 50000,
);
const REQUEST_TIMEOUT_MS = Math.max(1000, Number.parseInt(process.env.FETCH_URL_TIMEOUT_MS ?? "15000", 10) || 15000);

function sliceContent(content: string, opts: FetchOpts): { text: string; startIndex: number; nextIndex?: number } {
  const startIndex = opts.startIndex ?? 0;
  if (startIndex >= content.length) return { text: "", startIndex };

  const maxLength = Math.min(opts.maxLength ?? MAX_CONTENT_LENGTH, MAX_CONTENT_LENGTH);
  const endIndex = Math.min(startIndex + maxLength, content.length);
  return {
    text: content.slice(startIndex, endIndex),
    startIndex,
    nextIndex: endIndex < content.length ? endIndex : undefined,
  };
}

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let completed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error(`Fetched content exceeds the ${FETCH_LIMITS.MAX_FETCH_SIZE_MB} MB limit.`);
      }
      chunks.push(value);
    }
  } finally {
    // `releaseLock` only detaches the reader: the body stays open and keeps its buffers and
    // connection. The oversized-response throw above is exactly the case where that matters.
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export function convertFetchedContent(body: string, contentType: string, raw = false): string {
  if (raw || !contentType.toLowerCase().includes("text/html")) return body;

  const turndown = new TurndownService({
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    headingStyle: "atx",
  });
  turndown.remove(["script", "style", "noscript", "template"]);
  return turndown.turndown(body);
}

/**
 * In-process fallback for the built-in fetch_url tool.
 *
 * The historical name remains in this filename for import stability, but this
 * no longer delegates network access to mcp-server-fetch. Keeping the request
 * in process lets fetchUserRemoteUrl validate and DNS-pin every redirect hop.
 */
export class SafeHttpFetchEngine implements FetchEngine {
  readonly name = "safe_http" as const;

  async available(_context: ToolContext): Promise<boolean> {
    return true;
  }

  async fetch(url: string, opts: FetchOpts, context: ToolContext): Promise<ToolResult> {
    const startTime = Date.now();
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, timeoutSignal]) : timeoutSignal;
    const response = await fetchUserRemoteUrl(
      url,
      {
        headers: {
          Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
          "User-Agent": "TomoriBot/1.0 (+https://github.com/Bredrumb/TomoriBot)",
        },
        signal,
      },
      // Keep gate 2 aligned with gate 1: honor the same private-network policy
      // (dev auto-relax / production opt-in). The always-on cloud-metadata
      // denylist inside gate 2 is not affected by this.
      { allowPrivateNetwork: isPrivateNetworkFetchAllowed() },
    );

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}`,
        message: `URL fetch failed with HTTP ${response.status}.`,
      };
    }

    const body = await readBodyWithLimit(response, FETCH_LIMITS.MAX_FETCH_SIZE_MB * 1024 * 1024);
    const content = convertFetchedContent(body, response.headers.get("content-type") ?? "", opts.raw);
    const sliced = sliceContent(content, opts);

    if (!sliced.text.trim()) {
      const summary =
        sliced.startIndex > 0
          ? `[End of page content. No further content found at character offset ${sliced.startIndex}. All sections of this page have been read.]`
          : "[The page returned no readable content.]";
      return {
        success: true,
        message: summary,
        data: {
          summary,
          source: "http",
          functionName: "fetch_url",
          serverName: "safe-http",
          rawResult: null,
          executionTime: Date.now() - startTime,
          status: "completed",
          contentLength: 0,
          url: response.url,
          statusCode: response.status,
        },
      };
    }

    let message = `**URL:** ${response.url}\n\n${sliced.text}`;
    if (sliced.nextIndex !== undefined) {
      message += `\n\n[Content truncated. Continue reading from character offset ${sliced.nextIndex} with start_index=${sliced.nextIndex}.]`;
    }

    return {
      success: true,
      message,
      data: {
        // Provider adapters also prefer summary, preventing message/data duplication.
        summary: message,
        source: "http",
        functionName: "fetch_url",
        serverName: "safe-http",
        rawResult: null,
        executionTime: Date.now() - startTime,
        status: "completed",
        contentLength: content.length,
        returnedContentLength: sliced.text.length,
        startIndex: sliced.startIndex,
        nextIndex: sliced.nextIndex,
        url: response.url,
        statusCode: response.status,
      },
    };
  }
}
