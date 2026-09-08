import { describe, expect, it, mock } from "bun:test";
import type { TomoriState } from "@/types/db/schema";
import type { ChatTurn, GenerationTurnResult } from "@/utils/chat/types";
import {
  recordReunionPresence,
  ReunionClaimRegistry,
  type ReunionPresenceStore,
  resolveReunionNote,
} from "@/utils/chat/reunionPresence";

const completedResult: GenerationTurnResult = {
  status: "completed",
  streamResults: [],
  personaResponses: [{ text: "Welcome back!", personaName: "Tomori" }],
};

const emptyResult: GenerationTurnResult = {
  status: "empty_response",
  streamResults: [],
  personaResponses: [],
};

const toolDeliveredResult: GenerationTurnResult = {
  status: "completed",
  streamResults: [],
  personaResponses: [],
  toolResponseDelivered: true,
};

function makeResolveArgs(userId: number) {
  return {
    turn: {
      userRow: { user_id: userId, timezone_offset: 0 },
      triggererName: "Alice",
    } as ChatTurn,
    effectivePersona: {
      server_id: 5,
      persona_lineage_id: 10,
      config: { time_awareness_enabled: true, timezone_offset: 0 },
    } as TomoriState,
    isUserImpersonation: false,
  };
}

function makePresenceStore(overrides: Partial<ReunionPresenceStore>): ReunionPresenceStore {
  return {
    isTrackingEnabled: true,
    getUserPersonaReunionInfo: async () => null,
    recordPresenceSeen: async () => true,
    ...overrides,
  };
}

describe("ReunionClaimRegistry", () => {
  it("allows only one active claim for a persona lineage and user", () => {
    const registry = new ReunionClaimRegistry();
    const first = registry.tryClaim(10, 20);
    const otherUser = registry.tryClaim(10, 21);
    const otherLineage = registry.tryClaim(11, 20);

    expect(first).not.toBeNull();
    expect(registry.tryClaim(10, 20)).toBeNull();
    expect(otherUser).not.toBeNull();
    expect(otherLineage).not.toBeNull();

    if (first) registry.release(first);
    if (otherUser) registry.release(otherUser);
    if (otherLineage) registry.release(otherLineage);
  });

  it("makes the reunion claimable again after release", () => {
    const registry = new ReunionClaimRegistry();
    const first = registry.tryClaim(10, 20);
    if (!first) throw new Error("Expected the first reunion claim to succeed");

    expect(registry.owns(first)).toBe(true);
    registry.release(first);
    expect(registry.owns(first)).toBe(false);
    const next = registry.tryClaim(10, 20);
    expect(next).not.toBeNull();
    if (next) registry.release(next);
  });

  it("suppresses a concurrent channel until one successful delivery consumes the reunion", async () => {
    let seenToday = false;
    const read = mock(async () => ({
      lastPreviousDayAt: new Date("2026-07-01T00:00:00Z"),
      seenToday,
    }));
    const write = mock(async () => {
      seenToday = true;
      return true;
    });
    const presenceStore = makePresenceStore({ getUserPersonaReunionInfo: read, recordPresenceSeen: write });

    const first = await resolveReunionNote(makeResolveArgs(30), presenceStore);
    const concurrent = await resolveReunionNote(makeResolveArgs(30), presenceStore);

    expect(first.note).toContain("Alice hasn't interacted with you specifically since");
    expect(first.presence?.mode).toBe("claimed");
    expect(concurrent.note).toBeNull();
    expect(concurrent.presence?.mode).toBe("deferred");

    await recordReunionPresence(concurrent.presence, completedResult, presenceStore);
    expect(write).not.toHaveBeenCalled();

    await recordReunionPresence(first.presence, completedResult, presenceStore);
    expect(write).toHaveBeenCalledTimes(1);

    const afterDelivery = await resolveReunionNote(makeResolveArgs(30), presenceStore);
    expect(afterDelivery.note).toBeNull();
    expect(afterDelivery.presence?.mode).toBe("record");
  });

  it("claims before the database read so a concurrent context cannot use a stale snapshot", async () => {
    let finishRead: ((value: { lastPreviousDayAt: Date; seenToday: boolean }) => void) | undefined;
    const read = mock(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    const presenceStore = makePresenceStore({ getUserPersonaReunionInfo: read });

    const firstPromise = resolveReunionNote(makeResolveArgs(32), presenceStore);
    const concurrent = await resolveReunionNote(makeResolveArgs(32), presenceStore);

    expect(concurrent.note).toBeNull();
    expect(concurrent.presence?.mode).toBe("deferred");
    expect(read).toHaveBeenCalledTimes(1);

    finishRead?.({ lastPreviousDayAt: new Date("2026-07-01T00:00:00Z"), seenToday: false });
    const first = await firstPromise;
    expect(first.presence?.mode).toBe("claimed");
    await recordReunionPresence(first.presence, emptyResult, presenceStore);
  });

  it("consumes the reunion after a tool directly delivers the persona response", async () => {
    const write = mock(async () => true);
    const presenceStore = makePresenceStore({
      getUserPersonaReunionInfo: async () => ({ lastPreviousDayAt: null, seenToday: false }),
      recordPresenceSeen: write,
    });
    const first = await resolveReunionNote(makeResolveArgs(33), presenceStore);

    expect(first.note).toContain("very first time");
    await recordReunionPresence(first.presence, toolDeliveredResult, presenceStore);

    expect(write).toHaveBeenCalledTimes(1);
  });

  it("releases a failed claim without letting a suppressed turn consume it", async () => {
    const read = mock(async () => ({
      lastPreviousDayAt: new Date("2026-07-01T00:00:00Z"),
      seenToday: false,
    }));
    const write = mock(async () => true);
    const presenceStore = makePresenceStore({ getUserPersonaReunionInfo: read, recordPresenceSeen: write });

    const first = await resolveReunionNote(makeResolveArgs(31), presenceStore);
    const concurrent = await resolveReunionNote(makeResolveArgs(31), presenceStore);

    await recordReunionPresence(concurrent.presence, completedResult, presenceStore);
    await recordReunionPresence(first.presence, emptyResult, presenceStore);
    expect(write).not.toHaveBeenCalled();

    const retry = await resolveReunionNote(makeResolveArgs(31), presenceStore);
    expect(retry.note).toContain("Alice hasn't interacted with you specifically since");
    expect(retry.presence?.mode).toBe("claimed");
    await recordReunionPresence(retry.presence, emptyResult, presenceStore);
  });
});
