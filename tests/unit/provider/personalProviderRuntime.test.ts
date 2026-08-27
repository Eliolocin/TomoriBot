import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { CustomEndpointRow, LlmRow, TomoriState, UserSavedProviderConfigRow } from "@/types/db/schema";
import * as realRepositories from "@/utils/db/repositories";
import { createScopedModuleMocker, overrideMembers } from "../../helpers/mockSurface";

const primary = { llm_id: 11, llm_provider: "custom:u4:local", llm_codename: "primary" } as LlmRow;
const fallback = { llm_id: 12, llm_provider: "google", llm_codename: "fallback" } as LlmRow;
const serverFallback = { llm_id: 90, llm_provider: "google", llm_codename: "server-fallback" } as LlmRow;
const endpoint = {
  custom_endpoint_id: 5,
  connection_id: 1,
  server_id: null,
  user_id: 4,
  label: "local",
  capability: "text",
  model_ref_id: 13,
} as CustomEndpointRow;

let rows: UserSavedProviderConfigRow[] = [];

const scopedMock = createScopedModuleMocker(mock, {
  "@/utils/db/repositories": realRepositories,
});

scopedMock.module("@/utils/db/repositories", () => ({
  ...realRepositories,
  llmModelRepo: overrideMembers(realRepositories.llmModelRepo, {
    loadById: async (id: number) => (id === primary.llm_id ? primary : id === fallback.llm_id ? fallback : null),
    getLlmsByIds: async (ids: number[]) => (ids.includes(fallback.llm_id as number) ? [fallback] : []),
  }),
  llmProviderRepo: overrideMembers(realRepositories.llmProviderRepo, {
    loadUserSavedProviderConfigs: async () => rows,
    loadCustomEndpointsByIds: async (ids: number[]) =>
      ids.includes(endpoint.custom_endpoint_id as number) ? [endpoint] : [],
  }),
}));

function makeState(): TomoriState {
  return {
    llm: { llm_id: 1, llm_provider: "google", llm_codename: "server-primary" },
    fallback_llms: [serverFallback],
    fallback_chain: [{ kind: "llm", model: serverFallback }],
    config: { fallback_llm_ids: [90] },
  } as TomoriState;
}

function makePersonalRow(
  enabledCapabilities: UserSavedProviderConfigRow["enabled_capabilities"],
  modelRandomizerEnabled = false,
): UserSavedProviderConfigRow {
  return {
    user_id: 4,
    provider: "custom:u4:local",
    enabled_capabilities: enabledCapabilities,
    model_randomizer_enabled: modelRandomizerEnabled,
    llm_id: 11,
    fallback_model_refs: [
      { type: "custom_endpoint", id: 5 },
      { type: "llm", id: 12 },
    ],
  } as UserSavedProviderConfigRow;
}

describe("personal provider fallback overlay", () => {
  beforeEach(() => {
    rows = [];
  });

  it("materializes user custom endpoints and preserves the configured fallback order", async () => {
    rows = [makePersonalRow(["text"])];

    const { applyPersonalProviderSelectionsToTomoriState } = await import("@/utils/provider/personalProviderRuntime");
    const result = await applyPersonalProviderSelectionsToTomoriState(makeState(), 4);

    expect(result.tomoriState.config.fallback_llm_ids).toEqual([12]);
    expect(result.tomoriState.fallback_chain).toEqual([
      { kind: "custom_endpoint", endpoint },
      { kind: "llm", model: fallback },
    ]);
    expect(result.tomoriState.fallback_llms).toEqual([fallback]);
  });

  it("keeps the server fallback chain when no personal text provider is active", async () => {
    rows = [makePersonalRow(["embedding"])];
    const state = makeState();

    const { applyPersonalProviderSelectionsToTomoriState } = await import("@/utils/provider/personalProviderRuntime");
    const result = await applyPersonalProviderSelectionsToTomoriState(state, 4);

    expect(result.tomoriState.fallback_chain).toBe(state.fallback_chain);
    expect(result.tomoriState.fallback_llms).toBe(state.fallback_llms);
  });

  it("overlays personal model randomizer state when personal text is active", async () => {
    rows = [makePersonalRow(["text"], true)];
    const state = { ...makeState(), config: { ...makeState().config, model_randomizer_enabled: false } };

    const { applyPersonalProviderSelectionsToTomoriState } = await import("@/utils/provider/personalProviderRuntime");
    const result = await applyPersonalProviderSelectionsToTomoriState(state, 4);

    expect(result.tomoriState.config.model_randomizer_enabled).toBe(true);
  });
});
