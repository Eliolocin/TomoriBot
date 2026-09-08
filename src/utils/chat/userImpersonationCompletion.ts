import type { ChatIncoming, GenerationTurnResult, QueuedMessageDiscardReason } from "@/utils/chat/types";

export class UserImpersonationGenerationSkippedError extends Error {
  readonly reason = "skipped" as const;

  constructor() {
    super("User impersonation did not generate a message.");
    this.name = "UserImpersonationGenerationSkippedError";
  }
}

function normalizeError(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }

  if (typeof value === "object" && value !== null && "message" in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return new Error(message);
    }
  }

  return new Error(fallbackMessage);
}

export function getUserImpersonationGenerationError(result: GenerationTurnResult): Error | null {
  if (result.status === "skipped") {
    return new UserImpersonationGenerationSkippedError();
  }

  if (result.status !== "error" && result.status !== "timeout") {
    return null;
  }

  const fallbackMessage =
    result.status === "timeout" ? "User impersonation generation timed out." : "User impersonation generation failed.";

  for (let index = result.streamResults.length - 1; index >= 0; index--) {
    const streamResult = result.streamResults[index];
    if (streamResult && (streamResult.status === "error" || streamResult.status === "timeout")) {
      return normalizeError(streamResult.data, fallbackMessage);
    }
  }

  return new Error(fallbackMessage);
}

/**
 * Makes user-impersonation chat calls wait for the real generation outcome, including turns that
 * are queued behind an active channel lock. The slash-command caller can then use its existing
 * try/catch to edit the deferred interaction into an ephemeral error embed instead of reporting
 * success merely because tomoriChat() returned a non-throwing status.
 */
export function installUserImpersonationCompletion(incoming: ChatIncoming): Promise<void> | null {
  if (!incoming.isUserImpersonation) {
    return null;
  }

  const previousGenerationHandler = incoming.onGenerationResult;
  const previousDiscardHandler = incoming.onQueueDiscard;

  let settled = false;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const resolveOnce = () => {
    if (settled) return;
    settled = true;
    resolveCompletion();
  };
  const rejectOnce = (error: unknown, fallbackMessage: string) => {
    if (settled) return;
    settled = true;
    rejectCompletion(normalizeError(error, fallbackMessage));
  };

  incoming.onGenerationResult = async (result) => {
    try {
      await previousGenerationHandler?.(result);
    } catch (error) {
      rejectOnce(error, "User impersonation generation result handler failed.");
      return;
    }

    const generationError = getUserImpersonationGenerationError(result);
    if (generationError) {
      rejectOnce(generationError, generationError.message);
      return;
    }

    resolveOnce();
  };

  incoming.onQueueDiscard = async (reason: QueuedMessageDiscardReason) => {
    try {
      await previousDiscardHandler?.(reason);
    } catch (error) {
      rejectOnce(error, "User impersonation queue discard handler failed.");
      return;
    }

    rejectOnce(
      new Error(`User impersonation generation was discarded before completion (${reason}).`),
      "User impersonation generation was discarded before completion.",
    );
  };

  return completion;
}
