import { describe, expect, it } from "bun:test";
import type { ChatIncoming, GenerationTurnResult } from "@/utils/chat/types";
import {
  getUserImpersonationGenerationError,
  installUserImpersonationCompletion,
} from "@/utils/chat/userImpersonationCompletion";

function makeIncoming(overrides: Partial<ChatIncoming> = {}): ChatIncoming {
  return {
    isUserImpersonation: true,
    ...overrides,
  } as ChatIncoming;
}

function makeResult(
  status: GenerationTurnResult["status"],
  streamResults: GenerationTurnResult["streamResults"] = [],
): GenerationTurnResult {
  return {
    status,
    streamResults,
    personaResponses: [],
  };
}

describe("user impersonation generation completion", () => {
  it("does not install completion tracking for normal chat turns", () => {
    const incoming = makeIncoming({ isUserImpersonation: false });
    expect(installUserImpersonationCompletion(incoming)).toBeNull();
  });

  it("resolves only after a completed generation result", async () => {
    const incoming = makeIncoming();
    const completion = installUserImpersonationCompletion(incoming);
    expect(completion).not.toBeNull();

    await incoming.onGenerationResult?.(makeResult("completed"));
    await expect(completion!).resolves.toBeUndefined();
  });

  it("turns normalized provider errors into rejected completion errors", async () => {
    const result = makeResult("error", [
      {
        status: "error",
        data: {
          type: "api_error",
          message: "provider exploded",
          retryable: false,
        },
      },
    ]);
    expect(getUserImpersonationGenerationError(result)?.message).toBe("provider exploded");

    const incoming = makeIncoming();
    const completion = installUserImpersonationCompletion(incoming)!;
    const caught = completion.catch((error: unknown) => error);
    await incoming.onGenerationResult?.(result);

    expect(await caught).toBeInstanceOf(Error);
    expect((await caught as Error).message).toBe("provider exploded");
  });

  it("rejects timeout results so the slash command can show its timeout embed", async () => {
    const incoming = makeIncoming();
    const completion = installUserImpersonationCompletion(incoming)!;
    const caught = completion.catch((error: unknown) => error);
    await incoming.onGenerationResult?.(
      makeResult("timeout", [{ status: "timeout", data: new Error("Stream timed out due to inactivity.") }]),
    );

    expect((await caught as Error).message).toBe("Stream timed out due to inactivity.");
  });

  it("rejects when a queued impersonation is discarded before generation", async () => {
    const incoming = makeIncoming();
    const completion = installUserImpersonationCompletion(incoming)!;
    const caught = completion.catch((error: unknown) => error);
    await incoming.onQueueDiscard?.("stale_lock_release");

    expect((await caught as Error).message).toContain("stale_lock_release");
  });

  it("preserves pre-existing generation and discard callbacks", async () => {
    const seen: string[] = [];
    const incoming = makeIncoming({
      onGenerationResult: async () => {
        seen.push("generation");
      },
      onQueueDiscard: async () => {
        seen.push("discard");
      },
    });

    const completion = installUserImpersonationCompletion(incoming)!;
    await incoming.onGenerationResult?.(makeResult("completed"));
    await completion;
    expect(seen).toEqual(["generation"]);

    const discardedIncoming = makeIncoming({
      onQueueDiscard: async () => {
        seen.push("discard");
      },
    });
    const discardedCompletion = installUserImpersonationCompletion(discardedIncoming)!;
    const caught = discardedCompletion.catch((error: unknown) => error);
    await discardedIncoming.onQueueDiscard?.("channel_queue_cleared");
    await caught;

    expect(seen).toEqual(["generation", "discard"]);
  });
});
