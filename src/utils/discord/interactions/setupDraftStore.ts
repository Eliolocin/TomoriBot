import type { SetupDraftContext, SetupDraftProviderAccess, SetupDraftRecord } from "@/types/discord/setupWizard";

const parsedSetupDraftMaxEntries = Number.parseInt(process.env.SETUP_DRAFT_MAX_ENTRIES || "200", 10);
export const SETUP_DRAFT_MAX_ENTRIES =
  Number.isFinite(parsedSetupDraftMaxEntries) && parsedSetupDraftMaxEntries > 0 ? parsedSetupDraftMaxEntries : 200;

export interface SetupDraftStoreEntry extends SetupDraftRecord {
  writeClaimed?: boolean;
}

export type SetupDraftRecordInput = SetupDraftRecord;

export type SetupDraftPatch = {
  providerAccess?: SetupDraftProviderAccess | null;
  startingSettings?: SetupDraftRecord["startingSettings"];
  policiesAccepted?: boolean;
};

export type SetupDraftReadResult =
  | { status: "missing" }
  | { status: "forbidden" }
  | { status: "in-flight" }
  | { status: "ok"; draft: SetupDraftStoreEntry };

export type SetupDraftClaimResult =
  | { status: "missing" }
  | { status: "forbidden" }
  | { status: "in-flight" }
  | { status: "claimed"; draft: SetupDraftStoreEntry };

export interface SetupDraftStore {
  storeSetupDraft(nonce: string, record: SetupDraftRecordInput): void;
  readSetupDraft(
    nonce: string,
    actorDiscId: string,
    workspaceKey: string,
    context: SetupDraftContext,
  ): SetupDraftReadResult;
  consumeSetupDraft(
    nonce: string,
    actorDiscId: string,
    workspaceKey: string,
    context: SetupDraftContext,
  ): SetupDraftReadResult;
  updateSetupDraft(
    nonce: string,
    actorDiscId: string,
    workspaceKey: string,
    context: SetupDraftContext,
    patch: SetupDraftPatch,
  ): SetupDraftReadResult;
  claimSetupDraft(
    nonce: string,
    actorDiscId: string,
    workspaceKey: string,
    context: SetupDraftContext,
  ): SetupDraftClaimResult;
  releaseSetupDraftClaim(
    nonce: string,
    actorDiscId: string,
    workspaceKey: string,
    context: SetupDraftContext,
  ): SetupDraftReadResult;
  resetSetupDrafts(): void;
  getSetupDraftCount(): number;
}

function collectProviderAccessSecrets(access: SetupDraftProviderAccess | null | undefined): Buffer[] {
  if (!access) return [];
  if (access.mode === "catalog") return [access.encryptedApiKey];
  if (access.mode === "custom-endpoint" && access.connection?.encryptedAuthToken) {
    return [access.connection.encryptedAuthToken];
  }
  return [];
}

function wipeProviderAccessSecrets(access: SetupDraftProviderAccess | null | undefined): void {
  for (const secret of collectProviderAccessSecrets(access)) {
    secret.fill(0);
  }
}

/**
 * Wipes only the secrets the replacement does not still reference.
 *
 * Identity is compared per Buffer rather than per access object because a caller that spreads a previous access
 * into its replacement (`{ ...previous, provider: "other" }`) carries the same Buffer across. Wiping the displaced
 * object wholesale would zero the credential that is still live in the draft, and the resulting all-zero key would
 * reach the setup commit with nothing raising an error.
 */
function wipeDisplacedProviderAccessSecrets(
  previous: SetupDraftProviderAccess | null | undefined,
  next: SetupDraftProviderAccess | null | undefined,
): void {
  const retained = new Set(collectProviderAccessSecrets(next));
  for (const secret of collectProviderAccessSecrets(previous)) {
    if (!retained.has(secret)) secret.fill(0);
  }
}

export function createSetupDraftStore(_now: () => number = Date.now): SetupDraftStore {
  const drafts = new Map<string, SetupDraftStoreEntry>();

  const matchesBinding = (
    draft: SetupDraftStoreEntry,
    actorDiscId: string,
    workspaceKey: string,
    context: SetupDraftContext,
  ): boolean => draft.actorDiscId === actorDiscId && draft.workspaceKey === workspaceKey && draft.context === context;

  /**
   * Reads a draft, refusing one that a commit has claimed.
   *
   * The claim is enforced at the store rather than at each route arm because the commit's snapshot is
   * a shallow copy: any other mutation landing in its window reaches
   * `wipeDisplacedProviderAccessSecrets` (or `consume`'s wipe) and zero-fills the credential buffer
   * the running transaction is about to write, so the setup would succeed with a dead key. Refusing
   * every action, including Cancel, is the only shape that closes every one of those windows.
   *
   * The claim's own transitions are the exception, and they say so with `allowClaimed`: the commit
   * has to be able to release its own claim and then consume the record it owns.
   */
  const read = (
    nonce: string,
    actorDiscId: string,
    workspaceKey: string,
    context: SetupDraftContext,
    options: { allowClaimed?: boolean } = {},
  ): SetupDraftReadResult => {
    const draft = drafts.get(nonce);
    if (!draft) return { status: "missing" };

    if (!matchesBinding(draft, actorDiscId, workspaceKey, context)) return { status: "forbidden" };
    if (draft.writeClaimed && !options.allowClaimed) return { status: "in-flight" };
    return { status: "ok", draft };
  };

  const consume = (
    nonce: string,
    actorDiscId: string,
    workspaceKey: string,
    context: SetupDraftContext,
  ): SetupDraftReadResult => {
    // A refusal never removes a record, so a wrong actor cannot destroy the legitimate actor's pending
    // draft, and neither can a Cancel pressed while a commit holds the claim.
    const result = read(nonce, actorDiscId, workspaceKey, context);
    if (result.status === "ok") {
      wipeProviderAccessSecrets(result.draft.providerAccess);
      drafts.delete(nonce);
    }
    return result;
  };

  const update = (
    nonce: string,
    actorDiscId: string,
    workspaceKey: string,
    context: SetupDraftContext,
    patch: SetupDraftPatch,
  ): SetupDraftReadResult => {
    const result = read(nonce, actorDiscId, workspaceKey, context);
    if (result.status !== "ok") return result;

    if (patch.providerAccess !== undefined) {
      wipeDisplacedProviderAccessSecrets(result.draft.providerAccess, patch.providerAccess);
    }

    const updatedDraft: SetupDraftStoreEntry = { ...result.draft, ...patch };
    drafts.set(nonce, updatedDraft);
    return { status: "ok", draft: updatedDraft };
  };

  /**
   * Claims the draft for the interaction that is about to commit it.
   *
   * The read and the write happen in one synchronous step, so no second interaction can pass the check in between:
   * that is the whole point of the claim, because the commit transaction itself is awaited and a duplicate
   * confirmation arriving during it would otherwise validate against the same unclaimed draft and commit twice.
   */
  const claim = (
    nonce: string,
    actorDiscId: string,
    workspaceKey: string,
    context: SetupDraftContext,
  ): SetupDraftClaimResult => {
    // A claimed draft reads as in-flight, which is exactly the answer this returns for it, so the
    // claim does not need to look past its own freeze.
    const result = read(nonce, actorDiscId, workspaceKey, context);
    if (result.status !== "ok") return result;

    const claimedDraft: SetupDraftStoreEntry = { ...result.draft, writeClaimed: true };
    drafts.set(nonce, claimedDraft);
    return { status: "claimed", draft: claimedDraft };
  };

  /** Releases a claim whose commit did not complete, so the pending draft stays retryable. */
  const releaseClaim = (
    nonce: string,
    actorDiscId: string,
    workspaceKey: string,
    context: SetupDraftContext,
  ): SetupDraftReadResult => {
    // The one transition that has to see through the freeze it is undoing.
    const result = read(nonce, actorDiscId, workspaceKey, context, { allowClaimed: true });
    if (result.status !== "ok") return result;

    const releasedDraft: SetupDraftStoreEntry = { ...result.draft, writeClaimed: false };
    drafts.set(nonce, releasedDraft);
    return { status: "ok", draft: releasedDraft };
  };

  return {
    storeSetupDraft: (nonce, record) => {
      const existing = drafts.get(nonce);
      if (existing) {
        wipeDisplacedProviderAccessSecrets(existing.providerAccess, record.providerAccess);
        drafts.delete(nonce);
      }
      while (drafts.size >= SETUP_DRAFT_MAX_ENTRIES) {
        const oldestNonce = drafts.keys().next().value;
        if (oldestNonce === undefined) break;
        const oldest = drafts.get(oldestNonce);
        if (oldest) wipeProviderAccessSecrets(oldest.providerAccess);
        drafts.delete(oldestNonce);
      }
      drafts.set(nonce, record);
    },
    readSetupDraft: read,
    consumeSetupDraft: consume,
    updateSetupDraft: update,
    claimSetupDraft: claim,
    releaseSetupDraftClaim: releaseClaim,
    resetSetupDrafts: () => {
      for (const draft of drafts.values()) {
        wipeProviderAccessSecrets(draft.providerAccess);
      }
      drafts.clear();
    },
    getSetupDraftCount: () => drafts.size,
  };
}

const defaultSetupDraftStore = createSetupDraftStore();

export const storeSetupDraft = defaultSetupDraftStore.storeSetupDraft;
export const readSetupDraft = defaultSetupDraftStore.readSetupDraft;
export const consumeSetupDraft = defaultSetupDraftStore.consumeSetupDraft;
export const updateSetupDraft = defaultSetupDraftStore.updateSetupDraft;
export const claimSetupDraft = defaultSetupDraftStore.claimSetupDraft;
export const releaseSetupDraftClaim = defaultSetupDraftStore.releaseSetupDraftClaim;
export const resetSetupDrafts = defaultSetupDraftStore.resetSetupDrafts;
export const getSetupDraftCount = defaultSetupDraftStore.getSetupDraftCount;
