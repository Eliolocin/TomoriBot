/**
 * Coordinates the one-shot reunion note and its successful presence commit.
 * Eligibility is global to a persona lineage and user, while the claim prevents
 * separate channel contexts in this process from injecting the same reunion.
 */
import type { TomoriState } from "@/types/db/schema";
import type { ChatTurn, GenerationTurnResult } from "@/utils/chat/types";
import { statRepository } from "@/utils/db/repositories/StatRepository";
import { buildReunionNote } from "@/utils/text/context/timeAwareness";

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const REUNION_CLAIM_TTL_MS = readPositiveIntEnv("TIME_AWARENESS_REUNION_CLAIM_TTL_MS", 240000);

export interface ReunionClaimHandle {
  key: string;
  token: symbol;
}

interface ReunionClaimEntry {
  token: symbol;
  expiryTimer: ReturnType<typeof setTimeout>;
}

/**
 * Process-wide exclusion for reunion context injection. Expiry prevents a turn
 * interrupted outside the normal post-turn path from suppressing future notes.
 */
export class ReunionClaimRegistry {
  private readonly claims = new Map<string, ReunionClaimEntry>();

  constructor(private readonly ttlMs = REUNION_CLAIM_TTL_MS) {}

  tryClaim(lineageId: number, userId: number): ReunionClaimHandle | null {
    const key = `${lineageId}:${userId}`;
    if (this.claims.has(key)) return null;

    const token = Symbol(key);
    const expiryTimer = setTimeout(() => {
      const current = this.claims.get(key);
      if (current?.token === token) this.claims.delete(key);
    }, this.ttlMs);
    expiryTimer.unref?.();
    this.claims.set(key, { token, expiryTimer });
    return { key, token };
  }

  owns(handle: ReunionClaimHandle): boolean {
    return this.claims.get(handle.key)?.token === handle.token;
  }

  release(handle: ReunionClaimHandle): void {
    const current = this.claims.get(handle.key);
    if (current?.token !== handle.token) return;
    clearTimeout(current.expiryTimer);
    this.claims.delete(handle.key);
  }
}

type ReunionPresenceBase = {
  serverId: number;
  lineageId: number;
  userId: number;
};

export type ReunionPresenceScope =
  | (ReunionPresenceBase & { mode: "record" })
  | (ReunionPresenceBase & { mode: "claimed"; claim: ReunionClaimHandle })
  | (ReunionPresenceBase & { mode: "deferred" });

const reunionClaims = new ReunionClaimRegistry();

export interface ReunionPresenceStore {
  readonly isTrackingEnabled: boolean;
  getUserPersonaReunionInfo: typeof statRepository.getUserPersonaReunionInfo;
  recordPresenceSeen: typeof statRepository.recordPresenceSeen;
}

/**
 * Resolves a one-shot reunion for the direct triggerer and reserves it before
 * another channel can build an equivalent context.
 */
export async function resolveReunionNote(
  args: {
    turn: ChatTurn;
    effectivePersona: TomoriState;
    isUserImpersonation: boolean;
  },
  presenceStore: ReunionPresenceStore = statRepository,
): Promise<{
  note: string | null;
  presence: ReunionPresenceScope | null;
}> {
  const { turn, effectivePersona } = args;
  const lineageId = effectivePersona.persona_lineage_id;
  const serverId = effectivePersona.server_id;
  const userId = turn.userRow.user_id;

  if (
    effectivePersona.config.time_awareness_enabled === false ||
    args.isUserImpersonation ||
    !presenceStore.isTrackingEnabled ||
    typeof lineageId !== "number" ||
    !Number.isInteger(lineageId) ||
    lineageId < 0 ||
    typeof serverId !== "number" ||
    !Number.isInteger(serverId) ||
    typeof userId !== "number" ||
    !Number.isInteger(userId)
  ) {
    return { note: null, presence: null };
  }

  const basePresence: ReunionPresenceBase = { serverId, lineageId, userId };
  const claim = reunionClaims.tryClaim(lineageId, userId);
  if (!claim) {
    // Claim before reading so a query that started before another channel's
    // commit cannot resume afterward and reopen the stale reunion state.
    return { note: null, presence: { ...basePresence, mode: "deferred" } };
  }

  const reunionInfo = await presenceStore.getUserPersonaReunionInfo(userId, lineageId);
  if (!reunionInfo) {
    reunionClaims.release(claim);
    return { note: null, presence: null };
  }

  const note = buildReunionNote({
    ...reunionInfo,
    personalOffset: turn.userRow.timezone_offset ?? null,
    serverOffset: effectivePersona.config.timezone_offset,
    displayName: turn.triggererName,
  });
  if (!note) {
    reunionClaims.release(claim);
    return { note: null, presence: { ...basePresence, mode: "record" } };
  }

  if (!reunionClaims.owns(claim)) {
    return { note: null, presence: { ...basePresence, mode: "deferred" } };
  }

  return { note, presence: { ...basePresence, mode: "claimed", claim } };
}

/**
 * Commits direct-triggerer presence only after a response lands. Claimed turns
 * release on every terminal result, while concurrent deferred turns never
 * consume the reunion they did not receive.
 */
export async function recordReunionPresence(
  presence: ReunionPresenceScope | null,
  result: GenerationTurnResult,
  presenceStore: ReunionPresenceStore = statRepository,
): Promise<void> {
  if (!presence) return;

  if (result.personaResponses.length === 0 && result.toolResponseDelivered !== true) {
    if (presence.mode === "claimed") reunionClaims.release(presence.claim);
    return;
  }
  if (presence.mode === "deferred") return;
  if (presence.mode === "claimed" && !reunionClaims.owns(presence.claim)) return;

  await presenceStore.recordPresenceSeen({
    serverId: presence.serverId,
    userId: presence.userId,
    lineageId: presence.lineageId,
  });

  if (presence.mode === "claimed") reunionClaims.release(presence.claim);
}
