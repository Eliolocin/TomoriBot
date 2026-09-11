import { describe, expect, it } from "bun:test";
import type { TomoriState } from "@/types/db/schema";
import {
  loadServerProviderPanelScope,
  type ProviderPanelOperationsDependencies,
} from "@/utils/provider/providerPanelOperations";

function state(provider = "custom:7"): TomoriState {
  return {
    server_id: 12,
    llm: { llm_provider: provider },
    config: { fallback_model_refs: [] },
  } as unknown as TomoriState;
}

function dependencies(
  overrides: Partial<ProviderPanelOperationsDependencies> = {},
): ProviderPanelOperationsDependencies {
  return {
    getState: async () => state(),
    getRecordedDbError: () => null,
    refresh: () => undefined,
    loadSavedConfigs: async () => ({ status: "fresh", configs: [] }),
    loadEndpointConnections: async () => ({
      status: "fresh",
      connections: [
        {
          connection_id: 7,
          server_id: 12,
          user_id: null,
          label: "juno",
          capability: "text",
          api_style: "openai-compatible",
          endpoint_url: "https://example.invalid/v1",
          requires_auth: true,
        },
      ],
      endpoints: [],
    }),
    loadBraveStatus: async () => ({ status: "fresh", configured: false }),
    ...overrides,
  };
}

describe("provider panel read operations", () => {
  it("selects the currently active custom connection and keeps a zero-model endpoint visible", async () => {
    const result = await loadServerProviderPanelScope("123", false, dependencies());

    expect(result?.data.readStatus).toBe("fresh");
    expect(result?.data.initialEntryId).toBe("endpoint:7");
    expect(result?.data.entries).toHaveLength(1);
    expect(result?.data.entries[0]).toMatchObject({
      kind: "endpoint",
      displayName: "juno",
      connectionIds: [7],
    });
  });

  it("marks cached workspace state stale without fabricating an empty read", async () => {
    const result = await loadServerProviderPanelScope(
      "123",
      false,
      dependencies({ getRecordedDbError: () => ({ message: "read failed", timestamp: 1 }) }),
    );

    expect(result?.data.readStatus).toBe("stale");
    expect(result?.data.entries).toHaveLength(1);
  });

  it("returns an unavailable state when any required collection read fails", async () => {
    const result = await loadServerProviderPanelScope(
      "123",
      false,
      dependencies({
        loadSavedConfigs: async () => ({ status: "unavailable", configs: [] }),
      }),
    );

    expect(result?.data).toEqual({ readStatus: "unavailable", entries: [], initialEntryId: null });
  });

  it("forces Tomori state refresh only for Retry", async () => {
    let refreshes = 0;
    const deps = dependencies({
      refresh: () => {
        refreshes += 1;
      },
    });

    await loadServerProviderPanelScope("123", false, deps);
    await loadServerProviderPanelScope("123", true, deps);
    expect(refreshes).toBe(1);
  });
});
