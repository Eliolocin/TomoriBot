import { describe, expect, it } from "bun:test";
import { SETUP_DRAFT_SCHEMA_VERSION } from "@/types/discord/setupWizard";
import {
  SETUP_DRAFT_MAX_ENTRIES,
  createSetupDraftStore,
  type SetupDraftRecordInput,
} from "@/utils/discord/interactions/setupDraftStore";

function makeDraft(overrides: Partial<SetupDraftRecordInput> = {}): SetupDraftRecordInput {
  return {
    schemaVersion: SETUP_DRAFT_SCHEMA_VERSION,
    actorDiscId: "actor-1",
    workspaceKey: "workspace-1",
    context: "guild",
    providerAccess: {
      mode: "catalog",
      provider: "openai",
      encryptedApiKey: Buffer.from("secret-api-key"),
      keyVersion: 1,
    },
    startingSettings: {
      presetId: 1,
      humanizer: 1,
      timezoneOffset: 9,
      systemPrompt: { kind: "built-in" },
    },
    policiesAccepted: true,
    requiresPolicies: false,
    ...overrides,
  };
}

describe("setup draft store", () => {
  it("refuses to mutate a claimed draft, so the credential a commit holds stays live", () => {
    const store = createSetupDraftStore(() => 1000);
    const liveBuffer = Buffer.from("secret-api-key");
    store.storeSetupDraft(
      "nonce-claimed",
      makeDraft({
        providerAccess: { mode: "catalog", provider: "openai", encryptedApiKey: liveBuffer, keyVersion: 1 },
      }),
    );
    store.claimSetupDraft("nonce-claimed", "actor-1", "workspace-1", "guild");

    // A save landing inside the commit window would otherwise reach
    // wipeDisplacedProviderAccessSecrets and zero the buffer the running commit is about to write.
    const result = store.updateSetupDraft("nonce-claimed", "actor-1", "workspace-1", "guild", {
      providerAccess: { mode: "user-byok" },
    });

    expect(result.status).toBe("in-flight");
    expect(liveBuffer.equals(Buffer.from("secret-api-key"))).toBe(true);
    // The freeze covers reads too, which is what makes the route dispatcher's refusal reachable:
    // any action other than the commit's own would otherwise find a normal-looking draft.
    expect(store.readSetupDraft("nonce-claimed", "actor-1", "workspace-1", "guild").status).toBe("in-flight");
  });

  it("refuses to consume a claimed draft, so Cancel cannot zero the credential mid-commit", () => {
    const store = createSetupDraftStore(() => 1000);
    const liveBuffer = Buffer.from("secret-api-key");
    store.storeSetupDraft(
      "nonce-claimed",
      makeDraft({
        providerAccess: { mode: "catalog", provider: "openai", encryptedApiKey: liveBuffer, keyVersion: 1 },
      }),
    );
    store.claimSetupDraft("nonce-claimed", "actor-1", "workspace-1", "guild");

    // Cancel is a consume, and a consume landing in the commit window zero-fills the same buffer.
    expect(store.consumeSetupDraft("nonce-claimed", "actor-1", "workspace-1", "guild").status).toBe("in-flight");
    expect(liveBuffer.equals(Buffer.from("secret-api-key"))).toBe(true);
    expect(store.readSetupDraft("nonce-claimed", "actor-1", "workspace-1", "guild").status).toBe("in-flight");

    // The commit's own exit drains it: release the claim, then consume.
    store.releaseSetupDraftClaim("nonce-claimed", "actor-1", "workspace-1", "guild");
    expect(store.consumeSetupDraft("nonce-claimed", "actor-1", "workspace-1", "guild").status).toBe("ok");
    expect(store.readSetupDraft("nonce-claimed", "actor-1", "workspace-1", "guild").status).toBe("missing");
  });

  it("accepts the mutation again once the claim is released", () => {
    const store = createSetupDraftStore(() => 1000);
    store.storeSetupDraft("nonce-claimed", makeDraft());
    store.claimSetupDraft("nonce-claimed", "actor-1", "workspace-1", "guild");
    store.releaseSetupDraftClaim("nonce-claimed", "actor-1", "workspace-1", "guild");

    // The freeze is scoped to the claim: a released claim has to leave the draft editable, which is
    // what the drift path depends on to clear one step and re-pend it.
    const result = store.updateSetupDraft("nonce-claimed", "actor-1", "workspace-1", "guild", {
      startingSettings: null,
    });

    expect(result.status).toBe("ok");
  });

  it("reads a stored record under matching bindings", () => {
    const store = createSetupDraftStore(() => 1000);
    const draft = makeDraft();

    store.storeSetupDraft("nonce-1234", draft);

    expect(store.readSetupDraft("nonce-1234", "actor-1", "workspace-1", "guild")).toEqual({ status: "ok", draft });
  });

  it("refuses a different actor without consuming the draft", () => {
    const store = createSetupDraftStore(() => 1000);
    store.storeSetupDraft("nonce-1234", makeDraft());

    expect(store.readSetupDraft("nonce-1234", "actor-2", "workspace-1", "guild")).toEqual({
      status: "forbidden",
    });
    expect(store.readSetupDraft("nonce-1234", "actor-1", "workspace-1", "guild").status).toBe("ok");
  });

  it("refuses a different workspace key without consuming the draft", () => {
    const store = createSetupDraftStore(() => 1000);
    store.storeSetupDraft("nonce-1234", makeDraft());

    expect(store.readSetupDraft("nonce-1234", "actor-1", "workspace-2", "guild")).toEqual({
      status: "forbidden",
    });
    expect(store.readSetupDraft("nonce-1234", "actor-1", "workspace-1", "guild").status).toBe("ok");
  });

  it("refuses a different context without consuming the draft", () => {
    const store = createSetupDraftStore(() => 1000);
    store.storeSetupDraft("nonce-1234", makeDraft());

    expect(store.readSetupDraft("nonce-1234", "actor-1", "workspace-1", "dm")).toEqual({
      status: "forbidden",
    });
    expect(store.readSetupDraft("nonce-1234", "actor-1", "workspace-1", "guild").status).toBe("ok");
  });

  it("keeps a draft available without a timeout", () => {
    let currentTime = 1000;
    const store = createSetupDraftStore(() => currentTime);
    store.storeSetupDraft("nonce-1234", makeDraft());
    currentTime += 365 * 24 * 60 * 60 * 1000;

    expect(store.readSetupDraft("nonce-1234", "actor-1", "workspace-1", "guild")).toMatchObject({ status: "ok" });
  });

  it("keeps a draft available after a state mutation", () => {
    let currentTime = 1000;
    const store = createSetupDraftStore(() => currentTime);
    store.storeSetupDraft("nonce-1234", makeDraft());
    currentTime += 365 * 24 * 60 * 60 * 1000;

    expect(
      store.updateSetupDraft("nonce-1234", "actor-1", "workspace-1", "guild", {
        policiesAccepted: true,
      }),
    ).toMatchObject({ status: "ok", draft: { policiesAccepted: true } });
    expect(store.readSetupDraft("nonce-1234", "actor-1", "workspace-1", "guild")).toMatchObject({ status: "ok" });
  });

  it("does not create state for an unknown nonce", () => {
    const store = createSetupDraftStore();

    expect(store.updateSetupDraft("unknown", "actor-1", "workspace-1", "guild", { policiesAccepted: true })).toEqual({
      status: "missing",
    });
    expect(store.getSetupDraftCount()).toBe(0);
  });

  it("consumes a record once and deletes it", () => {
    const store = createSetupDraftStore(() => 1000);
    store.storeSetupDraft("nonce-1234", makeDraft());

    expect(store.consumeSetupDraft("nonce-1234", "actor-1", "workspace-1", "guild").status).toBe("ok");
    expect(store.consumeSetupDraft("nonce-1234", "actor-1", "workspace-1", "guild")).toEqual({
      status: "missing",
    });
  });

  it("claims a record once and reports a second claim as in flight", () => {
    const store = createSetupDraftStore(() => 1000);
    store.storeSetupDraft("nonce-1234", makeDraft());

    expect(store.claimSetupDraft("nonce-1234", "actor-1", "workspace-1", "guild")).toMatchObject({
      status: "claimed",
      draft: { writeClaimed: true },
    });
    expect(store.claimSetupDraft("nonce-1234", "actor-1", "workspace-1", "guild")).toEqual({
      status: "in-flight",
    });
    // The freeze extends to reads, so nothing but the claim's own release can see this record.
    expect(store.readSetupDraft("nonce-1234", "actor-1", "workspace-1", "guild").status).toBe("in-flight");
  });

  it("releases a claim so the same draft can be claimed again", () => {
    const store = createSetupDraftStore(() => 1000);
    store.storeSetupDraft("nonce-1234", makeDraft());
    store.claimSetupDraft("nonce-1234", "actor-1", "workspace-1", "guild");

    expect(store.releaseSetupDraftClaim("nonce-1234", "actor-1", "workspace-1", "guild")).toMatchObject({
      status: "ok",
      draft: { writeClaimed: false },
    });
    expect(store.claimSetupDraft("nonce-1234", "actor-1", "workspace-1", "guild").status).toBe("claimed");
  });

  it("refuses a claim from a different actor, workspace key, or context without claiming it", () => {
    const store = createSetupDraftStore(() => 1000);
    store.storeSetupDraft("nonce-1234", makeDraft());

    expect(store.claimSetupDraft("nonce-1234", "actor-2", "workspace-1", "guild")).toEqual({
      status: "forbidden",
    });
    expect(store.claimSetupDraft("nonce-1234", "actor-1", "workspace-2", "guild")).toEqual({
      status: "forbidden",
    });
    expect(store.claimSetupDraft("nonce-1234", "actor-1", "workspace-1", "dm")).toEqual({
      status: "forbidden",
    });
    expect(store.claimSetupDraft("nonce-1234", "actor-1", "workspace-1", "guild").status).toBe("claimed");
  });

  it("keeps a claim available without a timeout", () => {
    let currentTime = 1000;
    const store = createSetupDraftStore(() => currentTime);
    store.storeSetupDraft("nonce-1234", makeDraft());
    currentTime += 365 * 24 * 60 * 60 * 1000;

    expect(store.claimSetupDraft("nonce-1234", "actor-1", "workspace-1", "guild")).toMatchObject({
      status: "claimed",
      draft: { writeClaimed: true },
    });
    expect(store.releaseSetupDraftClaim("nonce-1234", "actor-1", "workspace-1", "guild")).toMatchObject({
      status: "ok",
      draft: { writeClaimed: false },
    });
    expect(store.claimSetupDraft("nonce-1234", "actor-1", "workspace-1", "guild")).toMatchObject({ status: "claimed" });
  });

  it("reports an unknown nonce as missing rather than creating a claim", () => {
    const store = createSetupDraftStore(() => 1000);

    expect(store.claimSetupDraft("unknown", "actor-1", "workspace-1", "guild")).toEqual({ status: "missing" });
    expect(store.releaseSetupDraftClaim("unknown", "actor-1", "workspace-1", "guild")).toEqual({
      status: "missing",
    });
    expect(store.getSetupDraftCount()).toBe(0);
  });

  it("evicts the oldest entry at the configured bound", () => {
    const store = createSetupDraftStore(() => 1000);
    for (let index = 0; index < SETUP_DRAFT_MAX_ENTRIES + 1; index++) {
      store.storeSetupDraft(`nonce-${index}`, makeDraft({ workspaceKey: `workspace-${index}` }));
    }

    expect(store.getSetupDraftCount()).toBeLessThanOrEqual(SETUP_DRAFT_MAX_ENTRIES);
    expect(store.readSetupDraft("nonce-0", "actor-1", "workspace-0", "guild").status).toBe("missing");
    expect(
      store.readSetupDraft(
        `nonce-${SETUP_DRAFT_MAX_ENTRIES}`,
        "actor-1",
        `workspace-${SETUP_DRAFT_MAX_ENTRIES}`,
        "guild",
      ).status,
    ).toBe("ok");
  });

  it("keeps existing drafts when another draft is stored", () => {
    let currentTime = 1000;
    const store = createSetupDraftStore(() => currentTime);
    store.storeSetupDraft("nonce-1234", makeDraft());
    currentTime += 365 * 24 * 60 * 60 * 1000;
    store.storeSetupDraft("nonce-2345", makeDraft({ workspaceKey: "workspace-2" }));

    expect(store.getSetupDraftCount()).toBe(2);
    expect(store.readSetupDraft("nonce-1234", "actor-1", "workspace-1", "guild").status).toBe("ok");
    expect(store.readSetupDraft("nonce-2345", "actor-1", "workspace-2", "guild").status).toBe("ok");
  });

  describe("observable secret buffer wiping", () => {
    it("zero-fills buffer on consume", () => {
      const store = createSetupDraftStore(() => 1000);
      const secretKeyBuffer = Buffer.from("super-sensitive-api-key");
      store.storeSetupDraft(
        "nonce-1234",
        makeDraft({
          providerAccess: {
            mode: "catalog",
            provider: "openai",
            encryptedApiKey: secretKeyBuffer,
            keyVersion: 1,
          },
        }),
      );

      // Verify buffer holds original non-zero bytes before consume.
      expect(secretKeyBuffer.some((byte) => byte !== 0)).toBe(true);

      const result = store.consumeSetupDraft("nonce-1234", "actor-1", "workspace-1", "guild");
      expect(result.status).toBe("ok");

      // Verify every byte in the referenced buffer is observably zeroed after consume.
      expect(secretKeyBuffer.every((byte) => byte === 0)).toBe(true);
    });

    it("zero-fills custom endpoint auth token buffer on consume", () => {
      const store = createSetupDraftStore(() => 1000);
      const authTokenBuffer = Buffer.from("custom-endpoint-secret-token");
      store.storeSetupDraft(
        "nonce-1234",
        makeDraft({
          providerAccess: {
            mode: "custom-endpoint",
            connection: {
              label: "Custom",
              apiStyle: "openai-compatible",
              endpointUrl: "https://custom.api",
              encryptedAuthToken: authTokenBuffer,
              keyVersion: 1,
            },
            textModel: null,
          },
        }),
      );

      expect(authTokenBuffer.some((byte) => byte !== 0)).toBe(true);
      store.consumeSetupDraft("nonce-1234", "actor-1", "workspace-1", "guild");
      expect(authTokenBuffer.every((byte) => byte === 0)).toBe(true);
    });

    it("keeps a buffer intact while its draft remains active", () => {
      let currentTime = 1000;
      const store = createSetupDraftStore(() => currentTime);
      const secretKeyBuffer = Buffer.from("api-key-that-will-expire");
      store.storeSetupDraft(
        "nonce-1234",
        makeDraft({
          providerAccess: {
            mode: "catalog",
            provider: "openai",
            encryptedApiKey: secretKeyBuffer,
            keyVersion: 1,
          },
        }),
      );

      currentTime += 365 * 24 * 60 * 60 * 1000;
      const result = store.readSetupDraft("nonce-1234", "actor-1", "workspace-1", "guild");
      expect(result.status).toBe("ok");
      expect(secretKeyBuffer.some((byte) => byte !== 0)).toBe(true);
    });

    it("keeps a buffer intact when another draft is stored", () => {
      let currentTime = 1000;
      const store = createSetupDraftStore(() => currentTime);
      const secretKeyBuffer = Buffer.from("swept-api-key");
      store.storeSetupDraft(
        "nonce-1234",
        makeDraft({
          providerAccess: {
            mode: "catalog",
            provider: "openai",
            encryptedApiKey: secretKeyBuffer,
            keyVersion: 1,
          },
        }),
      );

      currentTime += 365 * 24 * 60 * 60 * 1000;
      store.storeSetupDraft("nonce-2345", makeDraft({ workspaceKey: "workspace-2" }));
      expect(secretKeyBuffer.some((byte) => byte !== 0)).toBe(true);
    });

    it("zero-fills displaced provider access buffer when updated with new access", () => {
      const store = createSetupDraftStore(() => 1000);
      const oldSecretBuffer = Buffer.from("displaced-api-key");
      const newSecretBuffer = Buffer.from("fresh-new-api-key");

      store.storeSetupDraft(
        "nonce-1234",
        makeDraft({
          providerAccess: {
            mode: "catalog",
            provider: "openai",
            encryptedApiKey: oldSecretBuffer,
            keyVersion: 1,
          },
        }),
      );

      const updateResult = store.updateSetupDraft("nonce-1234", "actor-1", "workspace-1", "guild", {
        providerAccess: {
          mode: "catalog",
          provider: "anthropic",
          encryptedApiKey: newSecretBuffer,
          keyVersion: 1,
        },
      });
      expect(updateResult.status).toBe("ok");

      // Displaced previous buffer must be wiped.
      expect(oldSecretBuffer.every((byte) => byte === 0)).toBe(true);
      // Fresh new buffer must remain untouched.
      expect(newSecretBuffer.some((byte) => byte !== 0)).toBe(true);
    });

    it("keeps a buffer the replacement access still references", () => {
      const store = createSetupDraftStore(() => 1000);
      const carriedBuffer = Buffer.from("carried-api-key");
      const previousAccess = {
        mode: "catalog",
        provider: "openai",
        encryptedApiKey: carriedBuffer,
        keyVersion: 1,
      } as const;

      store.storeSetupDraft("nonce-1234", makeDraft({ providerAccess: previousAccess }));

      // Spreading the previous access carries the same Buffer into a new object, which is how an editor that
      // changes one field is expected to build its replacement.
      const updateResult = store.updateSetupDraft("nonce-1234", "actor-1", "workspace-1", "guild", {
        providerAccess: { ...previousAccess, provider: "anthropic" },
      });

      expect(updateResult.status).toBe("ok");
      expect(carriedBuffer.some((byte) => byte !== 0)).toBe(true);
    });

    it("keeps a carried buffer when the same nonce is stored again", () => {
      const store = createSetupDraftStore(() => 1000);
      const carriedBuffer = Buffer.from("carried-api-key");
      const access = {
        mode: "catalog",
        provider: "openai",
        encryptedApiKey: carriedBuffer,
        keyVersion: 1,
      } as const;

      store.storeSetupDraft("nonce-1234", makeDraft({ providerAccess: access }));
      store.storeSetupDraft("nonce-1234", makeDraft({ providerAccess: { ...access } }));

      expect(carriedBuffer.some((byte) => byte !== 0)).toBe(true);
    });

    it("zero-fills a custom endpoint token displaced by a new connection", () => {
      const store = createSetupDraftStore(() => 1000);
      const oldTokenBuffer = Buffer.from("old-endpoint-token");
      const newTokenBuffer = Buffer.from("new-endpoint-token");
      const connection = {
        label: "my-endpoint",
        apiStyle: "openai-compatible",
        endpointUrl: "https://example.invalid/v1",
        encryptedAuthToken: oldTokenBuffer,
        keyVersion: 1,
      };

      store.storeSetupDraft(
        "nonce-1234",
        makeDraft({ providerAccess: { mode: "custom-endpoint", connection, textModel: null } }),
      );

      store.updateSetupDraft("nonce-1234", "actor-1", "workspace-1", "guild", {
        providerAccess: {
          mode: "custom-endpoint",
          connection: { ...connection, encryptedAuthToken: newTokenBuffer },
          textModel: null,
        },
      });

      expect(oldTokenBuffer.every((byte) => byte === 0)).toBe(true);
      expect(newTokenBuffer.some((byte) => byte !== 0)).toBe(true);
    });

    it("zero-fills buffers on resetSetupDrafts", () => {
      const store = createSetupDraftStore(() => 1000);
      const secretKeyBuffer = Buffer.from("reset-target-key");
      store.storeSetupDraft(
        "nonce-1234",
        makeDraft({
          providerAccess: {
            mode: "catalog",
            provider: "openai",
            encryptedApiKey: secretKeyBuffer,
            keyVersion: 1,
          },
        }),
      );

      store.resetSetupDrafts();
      expect(secretKeyBuffer.every((byte) => byte === 0)).toBe(true);
      expect(store.getSetupDraftCount()).toBe(0);
    });

    it("does not wipe buffer when request is forbidden", () => {
      const store = createSetupDraftStore(() => 1000);
      const secretKeyBuffer = Buffer.from("protected-from-wrong-actor");
      store.storeSetupDraft(
        "nonce-1234",
        makeDraft({
          providerAccess: {
            mode: "catalog",
            provider: "openai",
            encryptedApiKey: secretKeyBuffer,
            keyVersion: 1,
          },
        }),
      );

      // Wrong actor read
      const readResult = store.readSetupDraft("nonce-1234", "actor-2", "workspace-1", "guild");
      expect(readResult.status).toBe("forbidden");
      expect(secretKeyBuffer.some((byte) => byte !== 0)).toBe(true);

      // Wrong actor consume
      const consumeResult = store.consumeSetupDraft("nonce-1234", "actor-2", "workspace-1", "guild");
      expect(consumeResult.status).toBe("forbidden");
      expect(secretKeyBuffer.some((byte) => byte !== 0)).toBe(true);

      // Wrong actor update
      const updateResult = store.updateSetupDraft("nonce-1234", "actor-2", "workspace-1", "guild", {
        policiesAccepted: true,
      });
      expect(updateResult.status).toBe("forbidden");
      expect(secretKeyBuffer.some((byte) => byte !== 0)).toBe(true);
    });
  });
});
