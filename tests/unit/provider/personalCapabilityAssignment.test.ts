import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { PersonalProviderCapability, UserSavedProviderConfigRow } from "@/types/db/schema";
import { llmProviderRepo } from "@/utils/db/repositories";
import {
  assignPersonalCapabilityToProvider,
  getActivePersonalProviderForCapability,
  getAssignedPersonalProviderForCapability,
  getStoredPersonalProviderForCapability,
  setPersonalCapabilityEnabled,
  withCapabilityEnabled,
  withCapabilityUnassigned,
} from "@/utils/provider/personalProviderHelpers";

function makeRow(overrides: Partial<UserSavedProviderConfigRow> & { provider: string }): UserSavedProviderConfigRow {
  return {
    user_id: 1,
    provider: overrides.provider,
    enabled_capabilities: [],
    assigned_capabilities: [],
    llm_id: null,
    embedding_model_id: null,
    diffusion_model_id: null,
    nai_diffusion_model_id: null,
    video_model_id: null,
    vision_llm_id: null,
    fallback_model_refs: [],
    ...overrides,
  } as unknown as UserSavedProviderConfigRow;
}

/**
 * `anthropic` sorts before `deepseek`, so any resolution that falls back to provider
 * name ordering picks the wrong row. Every case below depends on that.
 */
function makeAccount(): UserSavedProviderConfigRow[] {
  return [
    makeRow({ provider: "anthropic", llm_id: 100 }),
    makeRow({ provider: "deepseek", llm_id: 200, enabled_capabilities: ["text"], assigned_capabilities: ["text"] }),
    makeRow({ provider: "google", llm_id: 300 }),
  ];
}

/**
 * Drives the real helpers against an in-memory row set so a toggle sequence can be
 * asserted end to end. Production resolves both repo members at call time, so
 * spying on the singleton avoids a module-level mock registration, which Bun
 * cannot unregister. Naming that registrar in full here would also make
 * scripts/checks/lib/testIsolation.ts read this file as a mock user and hand it a
 * private process, hiding whether it really is safe to batch.
 */
function stubRepo(rows: UserSavedProviderConfigRow[]): { rows: UserSavedProviderConfigRow[] } {
  const state = { rows };

  spyOn(llmProviderRepo, "loadUserSavedProviderConfigs").mockImplementation(async () =>
    state.rows.map((row) => ({ ...row })),
  );
  spyOn(llmProviderRepo, "upsertUserSavedProviderConfig").mockImplementation(async (_userId, config) => {
    state.rows = state.rows.map((row) =>
      row.provider === config.provider ? ({ ...row, ...config } as UserSavedProviderConfigRow) : row,
    );
    return true;
  });

  return state;
}

const providerOf = (rows: UserSavedProviderConfigRow[], capability: PersonalProviderCapability) => ({
  active: getActivePersonalProviderForCapability(rows, capability)?.provider ?? null,
  assigned: getAssignedPersonalProviderForCapability(rows, capability)?.provider ?? null,
});

afterEach(() => {
  spyOn(llmProviderRepo, "loadUserSavedProviderConfigs").mockRestore();
  spyOn(llmProviderRepo, "upsertUserSavedProviderConfig").mockRestore();
});

describe("withCapabilityEnabled", () => {
  it("keeps ownership when a capability is switched off", () => {
    const row = makeRow({
      provider: "deepseek",
      llm_id: 200,
      enabled_capabilities: ["text"],
      assigned_capabilities: ["text"],
    });

    const disabled = withCapabilityEnabled(row, "text", false);

    expect(disabled.enabled_capabilities).toEqual([]);
    expect(disabled.assigned_capabilities).toEqual(["text"]);
  });

  it("claims ownership when a capability is switched on", () => {
    const row = makeRow({ provider: "deepseek", llm_id: 200 });

    const enabled = withCapabilityEnabled(row, "text", true);

    expect(enabled.enabled_capabilities).toEqual(["text"]);
    expect(enabled.assigned_capabilities).toEqual(["text"]);
  });

  it("does not duplicate a capability that is already present", () => {
    const row = makeRow({
      provider: "deepseek",
      enabled_capabilities: ["text"],
      assigned_capabilities: ["text"],
    });

    const enabled = withCapabilityEnabled(row, "text", true);

    expect(enabled.enabled_capabilities).toEqual(["text"]);
    expect(enabled.assigned_capabilities).toEqual(["text"]);
  });
});

describe("withCapabilityUnassigned", () => {
  it("drops both the on/off state and the ownership", () => {
    const row = makeRow({
      provider: "deepseek",
      enabled_capabilities: ["text", "vision"],
      assigned_capabilities: ["text", "vision"],
    });

    const stripped = withCapabilityUnassigned(row, "text");

    expect(stripped.enabled_capabilities).toEqual(["vision"]);
    expect(stripped.assigned_capabilities).toEqual(["vision"]);
  });
});

describe("getStoredPersonalProviderForCapability", () => {
  it("prefers the assigned owner over provider name ordering", () => {
    const rows = makeAccount().map((row) => withCapabilityEnabled(row, "text", false) as UserSavedProviderConfigRow);

    expect(getStoredPersonalProviderForCapability(rows, "text")?.provider).toBe("deepseek");
  });

  it("falls back to provider name ordering only when nothing is assigned", () => {
    // Reachable for rows configured before migration 060 backfilled ownership.
    const rows = [makeRow({ provider: "anthropic", llm_id: 100 }), makeRow({ provider: "deepseek", llm_id: 200 })];

    expect(getStoredPersonalProviderForCapability(rows, "text")?.provider).toBe("anthropic");
  });

  it("returns null when no row has a model for the capability", () => {
    expect(getStoredPersonalProviderForCapability([makeRow({ provider: "anthropic" })], "text")).toBeNull();
  });
});

describe("setPersonalCapabilityEnabled", () => {
  it("returns to the assigned provider across an off/on cycle", async () => {
    const state = stubRepo(makeAccount());
    expect(providerOf(state.rows, "text")).toEqual({ active: "deepseek", assigned: "deepseek" });

    await setPersonalCapabilityEnabled(1, "text", false);
    expect(providerOf(state.rows, "text")).toEqual({ active: null, assigned: "deepseek" });

    await setPersonalCapabilityEnabled(1, "text", true);
    expect(providerOf(state.rows, "text")).toEqual({ active: "deepseek", assigned: "deepseek" });
  });

  it("survives repeated cycles rather than drifting one provider at a time", async () => {
    const state = stubRepo(makeAccount());

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await setPersonalCapabilityEnabled(1, "text", false);
      await setPersonalCapabilityEnabled(1, "text", true);
    }

    expect(providerOf(state.rows, "text")).toEqual({ active: "deepseek", assigned: "deepseek" });
  });

  it("leaves other capabilities untouched", async () => {
    const rows = makeAccount();
    rows[2] = makeRow({
      provider: "google",
      llm_id: 300,
      vision_llm_id: 300,
      enabled_capabilities: ["vision"],
      assigned_capabilities: ["vision"],
    });
    const state = stubRepo(rows);

    await setPersonalCapabilityEnabled(1, "text", false);

    expect(providerOf(state.rows, "vision")).toEqual({ active: "google", assigned: "google" });
  });

  it("reports failure when no row could serve the capability", async () => {
    const state = stubRepo([makeRow({ provider: "anthropic" })]);

    expect(await setPersonalCapabilityEnabled(1, "text", true)).toBe(false);
    expect(providerOf(state.rows, "text")).toEqual({ active: null, assigned: null });
  });
});

describe("assignPersonalCapabilityToProvider", () => {
  it("moves ownership exclusively to the chosen provider", async () => {
    const state = stubRepo(makeAccount());

    await assignPersonalCapabilityToProvider(1, "google", "text", (row) => ({ ...row, llm_id: 999 }));

    expect(providerOf(state.rows, "text")).toEqual({ active: "google", assigned: "google" });
    const deepseek = state.rows.find((row) => row.provider === "deepseek");
    expect(deepseek?.enabled_capabilities).toEqual([]);
    expect(deepseek?.assigned_capabilities).toEqual([]);
  });

  it("turns the capability on even when the previous owner had it switched off", async () => {
    const rows = makeAccount().map((row) => withCapabilityEnabled(row, "text", false) as UserSavedProviderConfigRow);
    const state = stubRepo(rows);

    await assignPersonalCapabilityToProvider(1, "google", "text", (row) => ({ ...row, llm_id: 999 }));

    expect(providerOf(state.rows, "text")).toEqual({ active: "google", assigned: "google" });
  });
});
