import { describe, expect, it } from "bun:test";
import {
  TRANSFER_SNAPSHOT_MAX_ENTRIES,
  TRANSFER_SNAPSHOT_TTL_MINUTES,
  createTransferSnapshotStore,
  type TransferSnapshotRecordInput,
} from "@/utils/discord/interactions/transferSnapshotStore";

function makeRecord(overrides: Partial<TransferSnapshotRecordInput> = {}): TransferSnapshotRecordInput {
  return {
    actorDiscId: "actor-1",
    kind: "workspace_config",
    ownership: "workspace",
    destinationKey: "guild-1",
    fingerprint: "fingerprint-1",
    exportResult: {
      success: true,
      sourceVersion: "2.0",
      sourceType: "workspace_config",
      detectedSections: ["chat"],
      payload: {},
      droppedFields: [],
    },
    ...overrides,
  };
}

describe("transfer snapshot store", () => {
  it("reads a stored record under matching bindings", () => {
    const store = createTransferSnapshotStore(() => 1000);
    const record = makeRecord();

    store.storeTransferSnapshot("nonce-1234", record);

    expect(store.readTransferSnapshot("nonce-1234", "actor-1", "workspace", "guild-1")).toEqual({
      status: "ok",
      snapshot: { ...record, expiresAt: 1000 + TRANSFER_SNAPSHOT_TTL_MINUTES * 60 * 1000 },
    });
  });

  it("refuses a different actor without consuming the snapshot", () => {
    const store = createTransferSnapshotStore(() => 1000);
    store.storeTransferSnapshot("nonce-1234", makeRecord());

    expect(store.readTransferSnapshot("nonce-1234", "actor-2", "workspace", "guild-1")).toEqual({
      status: "forbidden",
    });
    expect(store.readTransferSnapshot("nonce-1234", "actor-1", "workspace", "guild-1").status).toBe("ok");
  });

  it("refuses a different destination without consuming the snapshot", () => {
    const store = createTransferSnapshotStore(() => 1000);
    store.storeTransferSnapshot("nonce-1234", makeRecord());

    expect(store.readTransferSnapshot("nonce-1234", "actor-1", "workspace", "guild-2")).toEqual({
      status: "forbidden",
    });
    expect(store.readTransferSnapshot("nonce-1234", "actor-1", "workspace", "guild-1").status).toBe("ok");
  });

  it("refuses different ownership without consuming the snapshot", () => {
    const store = createTransferSnapshotStore(() => 1000);
    store.storeTransferSnapshot("nonce-1234", makeRecord());

    expect(store.readTransferSnapshot("nonce-1234", "actor-1", "personal", "actor-1")).toEqual({
      status: "forbidden",
    });
    expect(store.readTransferSnapshot("nonce-1234", "actor-1", "workspace", "guild-1").status).toBe("ok");
  });

  it("merges mapping state without replacing the strategy", () => {
    const store = createTransferSnapshotStore(() => 1000);
    store.storeTransferSnapshot("nonce-1234", makeRecord({ kind: "personal_memories" }));

    expect(
      store.updateTransferSnapshotState("nonce-1234", "actor-1", "workspace", "guild-1", { strategy: "merge" }),
    ).toMatchObject({ status: "ok", snapshot: { strategy: "merge" } });
    expect(
      store.updateTransferSnapshotState("nonce-1234", "actor-1", "workspace", "guild-1", {
        mapping: { "persona-1": 42, global: "skip" },
      }),
    ).toMatchObject({
      status: "ok",
      snapshot: { strategy: "merge", mapping: { "persona-1": 42, global: "skip" } },
    });
  });

  it("does not mutate state for a different actor", () => {
    const store = createTransferSnapshotStore(() => 1000);
    store.storeTransferSnapshot("nonce-1234", makeRecord({ strategy: "merge" }));

    expect(
      store.updateTransferSnapshotState("nonce-1234", "actor-2", "workspace", "guild-1", {
        strategy: "replace",
      }),
    ).toEqual({ status: "forbidden" });
    expect(store.readTransferSnapshot("nonce-1234", "actor-1", "workspace", "guild-1")).toMatchObject({
      status: "ok",
      snapshot: { strategy: "merge" },
    });
  });

  it("does not mutate state for a different destination", () => {
    const store = createTransferSnapshotStore(() => 1000);
    store.storeTransferSnapshot("nonce-1234", makeRecord({ strategy: "merge" }));

    expect(
      store.updateTransferSnapshotState("nonce-1234", "actor-1", "workspace", "guild-2", {
        strategy: "replace",
      }),
    ).toEqual({ status: "forbidden" });
    expect(store.readTransferSnapshot("nonce-1234", "actor-1", "workspace", "guild-1")).toMatchObject({
      status: "ok",
      snapshot: { strategy: "merge" },
    });
  });

  it("does not mutate state for different ownership", () => {
    const store = createTransferSnapshotStore(() => 1000);
    store.storeTransferSnapshot("nonce-1234", makeRecord({ strategy: "merge" }));

    expect(
      store.updateTransferSnapshotState("nonce-1234", "actor-1", "personal", "actor-1", {
        strategy: "replace",
      }),
    ).toEqual({ status: "forbidden" });
    expect(store.readTransferSnapshot("nonce-1234", "actor-1", "workspace", "guild-1")).toMatchObject({
      status: "ok",
      snapshot: { strategy: "merge" },
    });
  });

  it("returns missing after expiry", () => {
    let currentTime = 1000;
    const store = createTransferSnapshotStore(() => currentTime);
    store.storeTransferSnapshot("nonce-1234", makeRecord());
    currentTime += TRANSFER_SNAPSHOT_TTL_MINUTES * 60 * 1000 + 1;

    expect(store.readTransferSnapshot("nonce-1234", "actor-1", "workspace", "guild-1")).toEqual({
      status: "missing",
    });
  });

  it("does not extend expiry after a state mutation", () => {
    let currentTime = 1000;
    const store = createTransferSnapshotStore(() => currentTime);
    store.storeTransferSnapshot("nonce-1234", makeRecord());
    const deadline = 1000 + TRANSFER_SNAPSHOT_TTL_MINUTES * 60 * 1000;
    currentTime = deadline - 1;

    expect(
      store.updateTransferSnapshotState("nonce-1234", "actor-1", "workspace", "guild-1", {
        strategy: "replace",
      }),
    ).toMatchObject({ status: "ok", snapshot: { expiresAt: deadline } });
    currentTime = deadline + 1;
    expect(store.readTransferSnapshot("nonce-1234", "actor-1", "workspace", "guild-1")).toEqual({
      status: "missing",
    });
  });

  it("does not create state for an unknown or expired nonce", () => {
    let currentTime = 1000;
    const store = createTransferSnapshotStore(() => currentTime);

    expect(
      store.updateTransferSnapshotState("unknown", "actor-1", "workspace", "guild-1", { strategy: "merge" }),
    ).toEqual({ status: "missing" });
    expect(store.getTransferSnapshotCount()).toBe(0);

    store.storeTransferSnapshot("nonce-1234", makeRecord());
    currentTime += TRANSFER_SNAPSHOT_TTL_MINUTES * 60 * 1000 + 1;
    expect(
      store.updateTransferSnapshotState("nonce-1234", "actor-1", "workspace", "guild-1", { strategy: "merge" }),
    ).toEqual({ status: "missing" });
    expect(store.getTransferSnapshotCount()).toBe(0);
  });

  it("consumes a record once", () => {
    const store = createTransferSnapshotStore(() => 1000);
    store.storeTransferSnapshot("nonce-1234", makeRecord());

    expect(store.consumeTransferSnapshot("nonce-1234", "actor-1", "workspace", "guild-1").status).toBe("ok");
    expect(store.consumeTransferSnapshot("nonce-1234", "actor-1", "workspace", "guild-1")).toEqual({
      status: "missing",
    });
  });

  it("claims a record once and reports a second claim as in flight", () => {
    const store = createTransferSnapshotStore(() => 1000);
    store.storeTransferSnapshot("nonce-1234", makeRecord());

    expect(store.claimTransferSnapshot("nonce-1234", "actor-1", "workspace", "guild-1")).toMatchObject({
      status: "claimed",
      snapshot: { writeClaimed: true },
    });
    // The second claim is what stops a duplicate confirmation from importing the same bundle twice.
    expect(store.claimTransferSnapshot("nonce-1234", "actor-1", "workspace", "guild-1")).toEqual({
      status: "in-flight",
    });
    // Neither claim consumed the record, so the failure path can still unlock it by hand.
    expect(store.readTransferSnapshot("nonce-1234", "actor-1", "workspace", "guild-1").status).toBe("ok");
  });

  it("releases a claim so the same import can be written again", () => {
    const store = createTransferSnapshotStore(() => 1000);
    store.storeTransferSnapshot("nonce-1234", makeRecord());
    store.claimTransferSnapshot("nonce-1234", "actor-1", "workspace", "guild-1");

    expect(store.releaseTransferSnapshotClaim("nonce-1234", "actor-1", "workspace", "guild-1")).toMatchObject({
      status: "ok",
      snapshot: { writeClaimed: false },
    });
    expect(store.claimTransferSnapshot("nonce-1234", "actor-1", "workspace", "guild-1").status).toBe("claimed");
  });

  it("refuses a claim from a different actor, destination, or ownership without claiming it", () => {
    const store = createTransferSnapshotStore(() => 1000);
    store.storeTransferSnapshot("nonce-1234", makeRecord());

    expect(store.claimTransferSnapshot("nonce-1234", "actor-2", "workspace", "guild-1")).toEqual({
      status: "forbidden",
    });
    expect(store.claimTransferSnapshot("nonce-1234", "actor-1", "workspace", "guild-2")).toEqual({
      status: "forbidden",
    });
    expect(store.claimTransferSnapshot("nonce-1234", "actor-1", "personal", "actor-1")).toEqual({
      status: "forbidden",
    });
    expect(store.claimTransferSnapshot("nonce-1234", "actor-1", "workspace", "guild-1").status).toBe("claimed");
  });

  it("does not extend expiry when a claim is taken or released", () => {
    let currentTime = 1000;
    const store = createTransferSnapshotStore(() => currentTime);
    store.storeTransferSnapshot("nonce-1234", makeRecord());
    const deadline = 1000 + TRANSFER_SNAPSHOT_TTL_MINUTES * 60 * 1000;
    currentTime = deadline - 1;

    expect(store.claimTransferSnapshot("nonce-1234", "actor-1", "workspace", "guild-1")).toMatchObject({
      status: "claimed",
      snapshot: { expiresAt: deadline },
    });
    expect(store.releaseTransferSnapshotClaim("nonce-1234", "actor-1", "workspace", "guild-1")).toMatchObject({
      status: "ok",
      snapshot: { expiresAt: deadline },
    });
    currentTime = deadline + 1;
    expect(store.claimTransferSnapshot("nonce-1234", "actor-1", "workspace", "guild-1")).toEqual({
      status: "missing",
    });
  });

  it("reports an unknown nonce as missing rather than creating a claim", () => {
    const store = createTransferSnapshotStore(() => 1000);

    expect(store.claimTransferSnapshot("unknown", "actor-1", "workspace", "guild-1")).toEqual({ status: "missing" });
    expect(store.releaseTransferSnapshotClaim("unknown", "actor-1", "workspace", "guild-1")).toEqual({
      status: "missing",
    });
    expect(store.getTransferSnapshotCount()).toBe(0);
  });

  it("clears a recorded Replace confirmation whenever the plan moves on", () => {
    const store = createTransferSnapshotStore(() => 1000);
    store.storeTransferSnapshot("nonce-1234", makeRecord({ kind: "workspace_memories", strategy: "replace" }));
    store.updateTransferSnapshotState("nonce-1234", "actor-1", "workspace", "guild-1", { replaceConfirmed: true });

    // A different destination means the destructive preview described a plan the reader can no longer be shown to
    // have reviewed, so the confirmation cannot survive it.
    expect(
      store.updateTransferSnapshotState("nonce-1234", "actor-1", "workspace", "guild-1", {
        mapping: { "bucket-0": 42 },
      }),
    ).toMatchObject({ status: "ok", snapshot: { replaceConfirmed: false } });

    store.updateTransferSnapshotState("nonce-1234", "actor-1", "workspace", "guild-1", { replaceConfirmed: true });
    expect(
      store.updateTransferSnapshotState("nonce-1234", "actor-1", "workspace", "guild-1", { strategy: "merge" }),
    ).toMatchObject({ status: "ok", snapshot: { replaceConfirmed: false } });

    // A patch that carries no plan change leaves the confirmation alone, which is what a page-view action needs.
    store.updateTransferSnapshotState("nonce-1234", "actor-1", "workspace", "guild-1", { replaceConfirmed: true });
    expect(
      store.updateTransferSnapshotState("nonce-1234", "actor-1", "workspace", "guild-1", { selectedBucket: "main" }),
    ).toMatchObject({ status: "ok", snapshot: { replaceConfirmed: true } });
  });

  it("evicts the oldest entry at the configured bound", () => {
    const store = createTransferSnapshotStore(() => 1000);
    for (let index = 0; index < TRANSFER_SNAPSHOT_MAX_ENTRIES + 1; index++) {
      store.storeTransferSnapshot(`nonce-${index}`, makeRecord({ fingerprint: `fingerprint-${index}` }));
    }

    expect(store.getTransferSnapshotCount()).toBeLessThanOrEqual(TRANSFER_SNAPSHOT_MAX_ENTRIES);
    expect(store.readTransferSnapshot("nonce-0", "actor-1", "workspace", "guild-1").status).toBe("missing");
    expect(
      store.readTransferSnapshot(`nonce-${TRANSFER_SNAPSHOT_MAX_ENTRIES}`, "actor-1", "workspace", "guild-1").status,
    ).toBe("ok");
  });

  it("sweeps expired entries during a later write", () => {
    let currentTime = 1000;
    const store = createTransferSnapshotStore(() => currentTime);
    store.storeTransferSnapshot("nonce-1234", makeRecord());
    currentTime += TRANSFER_SNAPSHOT_TTL_MINUTES * 60 * 1000 + 1;
    store.storeTransferSnapshot("nonce-2345", makeRecord({ fingerprint: "fingerprint-2" }));

    expect(store.getTransferSnapshotCount()).toBe(1);
    expect(store.readTransferSnapshot("nonce-1234", "actor-1", "workspace", "guild-1").status).toBe("missing");
    expect(store.readTransferSnapshot("nonce-2345", "actor-1", "workspace", "guild-1").status).toBe("ok");
  });
});
