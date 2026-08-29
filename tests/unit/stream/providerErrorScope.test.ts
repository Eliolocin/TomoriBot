import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { Client, TextChannel } from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import type { ProviderError, StreamContext, StreamProvider } from "@/types/stream/interfaces";
import { StreamErrorUi } from "@/utils/discord/stream/errorUi";
import { initializeLocalizer } from "@/utils/text/localizer";

type SendMock = ReturnType<typeof mock>;

function makeContext(
  send: SendMock,
  textCredentialSource: StreamContext["textCredentialSource"],
  fallbackChain: unknown[] = [],
): StreamContext {
  return {
    channel: { id: "channel_1", send } as unknown as TextChannel,
    client: {} as Client,
    tomoriState: {
      server_id: 1,
      persona_nickname: "Tomori",
      trigger_words: [],
      config: {},
      fallback_chain: fallbackChain,
      fallback_llms: [],
    } as unknown as TomoriState,
    contextItems: [],
    currentTurnModelParts: [],
    provider: "openrouter",
    locale: "en-US",
    textCredentialSource,
  };
}

function makeProvider(name = "openrouter"): StreamProvider {
  return {
    async *startStream() {},
    processChunk() {
      return { type: "text", content: "" };
    },
    handleProviderError(error) {
      return {
        type: "api_error",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      };
    },
    createErrorDescription() {
      return "The provider rejected this request.";
    },
    getProviderInfo() {
      return { name, version: "test", supportsStreaming: true, supportsFunctionCalling: true };
    },
  } as unknown as StreamProvider;
}

/** Reads the tip embed (the second embed) that `handleProviderError` sends to the channel. */
function tipText(send: SendMock): string {
  const payload = send.mock.calls[0]?.[0] as {
    embeds?: Array<{ data?: { description?: string } }>;
  };
  return payload.embeds?.[1]?.data?.description ?? "";
}

async function renderTips(
  error: ProviderError,
  textCredentialSource: StreamContext["textCredentialSource"],
  options: { providerName?: string; fallbackChain?: unknown[] } = {},
): Promise<string> {
  const send = mock(async () => undefined);
  await new StreamErrorUi().handleProviderError(
    error,
    makeProvider(options.providerName),
    makeContext(send, textCredentialSource, options.fallbackChain ?? []),
  );
  return tipText(send);
}

const MODEL_ERROR: ProviderError = {
  type: "model_error",
  message: "HTTP 400: Unsupported model `nope`.",
  code: "400_model",
  retryable: false,
};

const RATE_LIMIT_ERROR: ProviderError = {
  type: "rate_limit",
  message: "HTTP 429: rate limit exceeded",
  code: "429",
  retryable: true,
};

const API_ERROR: ProviderError = {
  type: "api_error",
  message: "HTTP 401: invalid credentials",
  code: "401",
  retryable: false,
};

describe("provider error tips resolve against the credential source", () => {
  beforeAll(async () => {
    await initializeLocalizer();
  });

  it("keeps recommending server commands when the server's credentials failed", async () => {
    const tips = await renderTips(MODEL_ERROR, "server");

    expect(tips).toContain("/model text");
    expect(tips).not.toContain("/personal");
  });

  it("recommends personal commands when the user's own credentials failed", async () => {
    const tips = await renderTips(MODEL_ERROR, "personal");

    expect(tips).toContain("/personal config");
    expect(tips).not.toContain("/model text");
  });

  it("offers the personal provider panel recovery path on personal failures", async () => {
    const tips = await renderTips(API_ERROR, "personal");

    expect(tips).toContain("/personal providers");
  });

  it("never shows personal recovery guidance for a server-scoped failure", async () => {
    const tips = await renderTips(API_ERROR, "server");

    expect(tips).not.toContain("toggle-models");
    expect(tips).toContain("Double-check this server's API key");
  });

  it("suppresses the manager-only key-rotation tip on personal failures", async () => {
    const serverTips = await renderTips(RATE_LIMIT_ERROR, "server");
    const personalTips = await renderTips(RATE_LIMIT_ERROR, "personal");

    expect(serverTips).toContain("/providers");
    expect(personalTips).not.toContain("api-key rotation");
  });

  it("still offers a personal fallback chain when only the server has one configured", async () => {
    // A personal text override reads the user's own chain, so a configured server chain must not
    // suppress the nudge for a personal failure.
    const serverTips = await renderTips(RATE_LIMIT_ERROR, "server", { fallbackChain: [{ type: "llm", id: 1 }] });
    const personalTips = await renderTips(RATE_LIMIT_ERROR, "personal", { fallbackChain: [{ type: "llm", id: 1 }] });

    expect(serverTips).not.toContain("fallback");
    expect(personalTips).toContain("/personal config");
  });

  it("falls back to server-scoped tips when no credential source was recorded", async () => {
    const tips = await renderTips(MODEL_ERROR, undefined);

    expect(tips).toContain("/model text");
    expect(tips).not.toContain("/personal");
  });
});
