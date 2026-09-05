/**
 * Ordering contract for removeVoiceSample, the shared voice-sample retirement operation.
 *
 * Collaborators are injected rather than module-mocked: Bun cannot unregister `mock.module`, so a
 * mocked sql client or cache store would leak into every other test sharing the lane process.
 */
import { describe, expect, it } from "bun:test";
import { removeVoiceSample, type VoiceSampleRemovalDeps } from "@/utils/db/repositories/SpeechRepository";

const INPUT = {
  serverId: 7,
  serverDiscId: "_rt_server_voice_removal",
  sampleId: 42,
  filePath: "/voices/_rt_sample_42.wav",
} as const;

interface Recording {
  calls: string[];
  deps: VoiceSampleRemovalDeps;
}

function recordingDeps(overrides: Partial<VoiceSampleRemovalDeps> = {}): Recording {
  const calls: string[] = [];
  const deps: VoiceSampleRemovalDeps = {
    clearRefs: async () => {
      calls.push("clearRefs");
    },
    deleteRow: async () => {
      calls.push("deleteRow");
    },
    invalidateCache: () => {
      calls.push("invalidateCache");
    },
    deleteStoredFile: async () => {
      calls.push("deleteStoredFile");
    },
    ...overrides,
  };
  return { calls, deps };
}

describe("removeVoiceSample ordering", () => {
  it("clears references, deletes the row, then invalidates before stored-file cleanup", async () => {
    const { calls, deps } = recordingDeps();

    const result = await removeVoiceSample(INPUT, deps);

    expect(calls).toEqual(["clearRefs", "deleteRow", "invalidateCache", "deleteStoredFile"]);
    expect(result.storedFileRemoved).toBe(true);
  });

  it("passes the workspace Discord id to the cache invalidation", async () => {
    const seen: string[] = [];
    const { deps } = recordingDeps({
      invalidateCache: (serverDiscId: string) => {
        seen.push(serverDiscId);
      },
    });

    await removeVoiceSample(INPUT, deps);

    expect(seen).toEqual([INPUT.serverDiscId]);
  });

  it("does not invalidate when the row delete fails", async () => {
    const { calls, deps } = recordingDeps({
      deleteRow: async () => {
        calls.push("deleteRow");
        throw new Error("row delete failed");
      },
    });

    await expect(removeVoiceSample(INPUT, deps)).rejects.toThrow("row delete failed");
    expect(calls).toEqual(["clearRefs", "deleteRow"]);
  });

  it("does not invalidate or delete when clearing references fails", async () => {
    const { calls, deps } = recordingDeps({
      clearRefs: async () => {
        calls.push("clearRefs");
        throw new Error("clear failed");
      },
    });

    await expect(removeVoiceSample(INPUT, deps)).rejects.toThrow("clear failed");
    expect(calls).toEqual(["clearRefs"]);
  });

  it("keeps the invalidation and reports failure when stored-file cleanup throws", async () => {
    const { calls, deps } = recordingDeps({
      deleteStoredFile: async () => {
        calls.push("deleteStoredFile");
        throw new Error("ENOENT");
      },
    });

    const result = await removeVoiceSample(INPUT, deps);

    expect(calls).toEqual(["clearRefs", "deleteRow", "invalidateCache", "deleteStoredFile"]);
    expect(result.storedFileRemoved).toBe(false);
  });
});
