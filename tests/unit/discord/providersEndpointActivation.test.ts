import { beforeAll, describe, expect, it } from "bun:test";
import type { CustomEndpointRow, TomoriState } from "@/types/db/schema";
import {
  providerPanelOperations,
  type ActivateWorkspaceEndpointDependencies,
} from "@/utils/provider/providerPanelOperations";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

function endpointRow(overrides: Partial<CustomEndpointRow>): CustomEndpointRow {
  return {
    connection_id: 88,
    label: "voicebox",
    capability: "speech",
    api_style: "tts-clone",
    endpoint_url: "https://voice.example.invalid",
    requires_auth: true,
    custom_endpoint_id: 501,
    model_name: "voicebox-alpha",
    extra_config: {},
    has_tools: false,
    sees_images: false,
    sees_videos: false,
    supports_structoutput: false,
    strict_role_alternation: false,
    supports_prefix_completion: false,
    is_default: false,
    ...overrides,
  } as CustomEndpointRow;
}

const state = { server_id: 42 } as TomoriState;

function activationDependencies(
  rows: CustomEndpointRow[],
  calls: string[],
  updated = true,
): ActivateWorkspaceEndpointDependencies {
  return {
    loadEndpoints: async (serverId) => {
      calls.push(`load:${serverId}`);
      return rows;
    },
    setActive: async (params) => {
      calls.push(`write:${params.capability}:${params.customEndpointId}`);
      return updated;
    },
    refresh: (discordId) => {
      calls.push(`refresh:${discordId}`);
    },
  };
}

describe("activateWorkspaceEndpoint", () => {
  const rows = [
    endpointRow({ custom_endpoint_id: 501, is_default: true, api_style: "tts-clone" }),
    endpointRow({ custom_endpoint_id: 502, is_default: false, api_style: "tts-clone" }),
    endpointRow({
      connection_id: 90,
      label: "elevenlabs",
      custom_endpoint_id: 503,
      is_default: false,
      api_style: "elevenlabs",
    }),
    endpointRow({
      connection_id: 89,
      capability: "transcription",
      custom_endpoint_id: 601,
      is_default: false,
      api_style: "openai-compatible-transcription",
    }),
  ];

  it("switches between several endpoints of the same capability and reports the stable identity", async () => {
    const calls: string[] = [];
    const result = await providerPanelOperations.activateWorkspaceEndpoint(
      { serverDiscId: "guild-1", scopeKind: "server", state, capability: "speech", customEndpointId: 502 },
      activationDependencies(rows, calls),
    );
    expect(result).toEqual({ status: "success", identity: "voicebox (speech)", sourceChanged: false });
    expect(calls).toEqual(["load:42", "write:speech:502", "refresh:guild-1"]);
  });

  it("reports a changed source when the previous active endpoint used a different api style", async () => {
    const calls: string[] = [];
    const result = await providerPanelOperations.activateWorkspaceEndpoint(
      { serverDiscId: "guild-1", scopeKind: "server", state, capability: "speech", customEndpointId: 503 },
      activationDependencies(rows, calls),
    );
    expect(result).toEqual({ status: "success", identity: "elevenlabs (speech)", sourceChanged: true });
  });

  it("treats the already-active endpoint as a no-op that never reaches the write", async () => {
    const calls: string[] = [];
    const result = await providerPanelOperations.activateWorkspaceEndpoint(
      { serverDiscId: "guild-1", scopeKind: "server", state, capability: "speech", customEndpointId: 501 },
      activationDependencies(rows, calls),
    );
    expect(result).toEqual({ status: "already-active", identity: "voicebox (speech)" });
    expect(calls).toEqual(["load:42"]);
  });

  it("refuses a forged id whose capability does not match the submitted one", async () => {
    const calls: string[] = [];
    const result = await providerPanelOperations.activateWorkspaceEndpoint(
      { serverDiscId: "guild-1", scopeKind: "server", state, capability: "speech", customEndpointId: 601 },
      activationDependencies(rows, calls),
    );
    expect(result).toEqual({ status: "not-found" });
    expect(calls).toEqual(["load:42"]);
  });

  it("refuses an id that belongs to another workspace, because the read is server scoped", async () => {
    const calls: string[] = [];
    const result = await providerPanelOperations.activateWorkspaceEndpoint(
      { serverDiscId: "guild-1", scopeKind: "server", state, capability: "speech", customEndpointId: 9999 },
      activationDependencies(rows, calls),
    );
    expect(result).toEqual({ status: "not-found" });
    expect(calls).toEqual(["load:42"]);
  });

  it("refuses a personal-scoped caller outright", async () => {
    const calls: string[] = [];
    const result = await providerPanelOperations.activateWorkspaceEndpoint(
      {
        serverDiscId: "user-1",
        ownerId: 77,
        scopeKind: "personal",
        state,
        capability: "speech",
        customEndpointId: 502,
      },
      activationDependencies(rows, calls),
    );
    expect(result).toEqual({ status: "not-found" });
    expect(calls).toEqual([]);
  });

  it("leaves the cache alone when the write fails", async () => {
    const calls: string[] = [];
    const result = await providerPanelOperations.activateWorkspaceEndpoint(
      { serverDiscId: "guild-1", scopeKind: "server", state, capability: "speech", customEndpointId: 502 },
      activationDependencies(rows, calls, false),
    );
    expect(result).toEqual({ status: "write-failed" });
    expect(calls).toEqual(["load:42", "write:speech:502"]);
  });

  it("invalidates the DM workspace key, which is the user id rather than a guild id", async () => {
    const calls: string[] = [];
    await providerPanelOperations.activateWorkspaceEndpoint(
      { serverDiscId: "user-456", scopeKind: "server", state, capability: "transcription", customEndpointId: 601 },
      activationDependencies(rows, calls),
    );
    expect(calls).toEqual(["load:42", "write:transcription:601", "refresh:user-456"]);
  });
});
