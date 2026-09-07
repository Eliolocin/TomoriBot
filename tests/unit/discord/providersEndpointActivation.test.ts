import { beforeAll, describe, expect, it } from "bun:test";
import { ComponentType } from "discord.js";
import type { Client } from "discord.js";
import type { CustomEndpointRow, TomoriState } from "@/types/db/schema";
import type { PanelReadStatus } from "@/types/discord/panel";
import type { ProviderPanelEntry } from "@/types/discord/providerPanel";
import { createProvidersInteractionRoute } from "@/utils/discord/interactions/providersRoutes";
import { parseInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import {
  buildProvidersRouteId,
  parseProvidersPanelRoute,
  PERSONAL_PROVIDERS_ROUTE_NAMESPACE,
  PROVIDERS_ROUTE_NAMESPACE,
} from "@/utils/discord/providersPanelCatalog";
import {
  buildEndpointActivationValue,
  buildProvidersPanelPayload,
  parseEndpointActivationValue,
} from "@/utils/discord/ui/providersPanel";
import {
  providerPanelOperations,
  type ActivateWorkspaceEndpointDependencies,
  type LoadedProviderPanelScope,
} from "@/utils/provider/providerPanelOperations";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

function parsed(customId: string) {
  const route = parseInteractionRoute(customId);
  if (!route) throw new Error("Expected a parsed route");
  return route;
}

function collectComponents(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const nested = Array.isArray(record.components) ? record.components.flatMap(collectComponents) : [];
  const component = record.component ? collectComponents(record.component) : [];
  return [record, ...nested, ...component];
}

function activationSelects(payload: unknown): Array<Record<string, unknown>> {
  return collectComponents(payload).filter((component) => {
    const customId = component.customId;
    return typeof customId === "string" && customId.includes(":endpoint-activate:");
  });
}

const voiceEntry: ProviderPanelEntry = {
  id: "endpoint:88",
  kind: "endpoint",
  displayName: "voicebox",
  savedAt: null,
  connectionIds: [88, 89],
  isPreset: false,
  connectionDetails: [
    { connectionId: 88, endpointUrl: "https://voice.example.invalid", apiStyle: "tts-clone" },
    { connectionId: 89, endpointUrl: "https://voice.example.invalid", apiStyle: "openai-compatible-transcription" },
  ],
  capabilities: [
    {
      capability: "speech",
      availability: "available",
      apiStyle: "tts-clone",
      models: [
        {
          id: 501,
          codeName: "voicebox-alpha",
          isWorkspaceActive: true,
          isWorkspaceFallback: false,
          isProviderFallback: false,
          isCustomRegistration: true,
        },
        {
          id: 502,
          codeName: "voicebox-beta",
          isWorkspaceActive: false,
          isWorkspaceFallback: false,
          isProviderFallback: false,
          isCustomRegistration: true,
        },
      ],
    },
    {
      capability: "transcription",
      availability: "available",
      apiStyle: "openai-compatible-transcription",
      models: [
        {
          id: 601,
          codeName: "voicebox-scribe",
          isWorkspaceActive: false,
          isWorkspaceFallback: false,
          isProviderFallback: false,
          isCustomRegistration: true,
        },
      ],
    },
  ],
};

const textOnlyEntry: ProviderPanelEntry = {
  id: "endpoint:73",
  kind: "endpoint",
  displayName: "ollama",
  savedAt: null,
  connectionIds: [73],
  isPreset: false,
  connectionDetails: [{ connectionId: 73, endpointUrl: "http://localhost:11434", apiStyle: "ollama-native" }],
  capabilities: [
    {
      capability: "text",
      availability: "available",
      apiStyle: "ollama-native",
      models: [
        {
          id: 300,
          codeName: "llama-example",
          isWorkspaceActive: true,
          isWorkspaceFallback: false,
          isProviderFallback: false,
          isCustomRegistration: true,
        },
      ],
    },
    { capability: "speech", availability: "unavailable", models: [] },
    { capability: "transcription", availability: "unavailable", models: [] },
  ],
};

function render(
  entry: ProviderPanelEntry,
  options: {
    routeNamespace?: typeof PROVIDERS_ROUTE_NAMESPACE | typeof PERSONAL_PROVIDERS_ROUTE_NAMESPACE;
    readStatus?: PanelReadStatus;
    enabledActions?: ReadonlySet<"add-provider" | "add-endpoint" | "model" | "edit" | "activate" | "remove">;
  } = {},
) {
  return buildProvidersPanelPayload({
    locale: "en-US",
    entries: [entry],
    initialEntryId: entry.id,
    readStatus: options.readStatus ?? "fresh",
    page: { kind: "entry", entryId: entry.id },
    enabledActions: options.enabledActions ?? new Set(["model", "edit", "activate", "remove"]),
    routeNamespace: options.routeNamespace ?? PROVIDERS_ROUTE_NAMESPACE,
  });
}

describe("providers endpoint activation selector", () => {
  it("offers one raw String Select over every speech and transcription row of the selected endpoint", () => {
    const selects = activationSelects(render(voiceEntry));
    expect(selects).toHaveLength(1);
    const select = selects[0] as unknown as {
      type: number;
      options: Array<Record<string, unknown>>;
      disabled: boolean;
    };

    // Asserted numerically as well as by name: a Discord component type is a bare number, so a wrong
    // one still renders and still satisfies every structural check.
    expect(select.type).toBe(ComponentType.StringSelect);
    expect(select.type).toBe(3);
    expect(select.disabled).toBe(false);
    expect(select.options.map((option) => option.value)).toEqual(["speech:501", "speech:502", "transcription:601"]);
    expect(select.options.map((option) => option.label)).toEqual([
      "voicebox-alpha",
      "voicebox-beta",
      "voicebox-scribe",
    ]);
  });

  it("marks only the stored active row as the selected default and says so in its description", () => {
    const select = activationSelects(render(voiceEntry))[0] as unknown as {
      options: Array<Record<string, unknown>>;
    };
    expect(select.options.map((option) => option.default === true)).toEqual([true, false, false]);
    expect(select.options[0]?.description).toBe("[active] speech endpoint (voicebox)");
    expect(select.options[1]?.description).toBe("speech endpoint (voicebox)");
    expect(select.options[2]?.description).toBe("transcription endpoint (voicebox)");
  });

  it("routes the select to this entry's representative connection id", () => {
    const select = activationSelects(render(voiceEntry))[0] as unknown as { customId: string };
    expect(parseProvidersPanelRoute(parsed(select.customId), PROVIDERS_ROUTE_NAMESPACE)).toEqual({
      action: "endpoint-activate",
      locale: "en-US",
      connectionId: 88,
    });
  });

  it("omits the selector on the personal panel, so activation never reaches a personal actor", () => {
    expect(activationSelects(render(voiceEntry, { routeNamespace: PERSONAL_PROVIDERS_ROUTE_NAMESPACE }))).toEqual([]);
  });

  it("omits the selector for an endpoint that hosts neither capability", () => {
    expect(activationSelects(render(textOnlyEntry))).toEqual([]);
  });

  it("disables the selector on a stale read and when activation is not an enabled action", () => {
    const stale = activationSelects(render(voiceEntry, { readStatus: "stale" }))[0] as unknown as {
      disabled: boolean;
    };
    expect(stale.disabled).toBe(true);
    const withoutAction = activationSelects(
      render(voiceEntry, { enabledActions: new Set(["model", "edit", "remove"]) }),
    )[0] as unknown as { disabled: boolean };
    expect(withoutAction.disabled).toBe(true);
  });

  it("round trips and rejects malformed activation values", () => {
    expect(parseEndpointActivationValue(buildEndpointActivationValue("speech", 501))).toEqual({
      capability: "speech",
      customEndpointId: 501,
    });
    expect(parseEndpointActivationValue("text:501")).toBeNull();
    expect(parseEndpointActivationValue("speech:0")).toBeNull();
    expect(parseEndpointActivationValue("speech:-1")).toBeNull();
    expect(parseEndpointActivationValue("speech:abc")).toBeNull();
    expect(parseEndpointActivationValue(undefined)).toBeNull();
  });
});

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

const workspaceScope: LoadedProviderPanelScope = {
  state,
  scopeKind: "server",
  data: { readStatus: "fresh", entries: [voiceEntry], initialEntryId: "endpoint:88" },
};

function activationInteraction(customId: string, value: string, calls: string[], painted?: unknown[]) {
  return {
    id: "interaction",
    customId,
    guildId: "123",
    user: { id: "456" },
    memberPermissions: { has: () => true },
    values: [value],
    isStringSelectMenu: () => true,
    isModalSubmit: () => false,
    isButton: () => false,
    deferUpdate: async () => {
      calls.push("deferUpdate");
    },
    editReply: async (payload: unknown) => {
      calls.push("editReply");
      painted?.push(payload);
    },
  };
}

/**
 * The receipt is the second container of the repainted payload, below the interactive panel, and it
 * carries the heading and detail a user actually reads back after the write.
 */
function paintedReceipt(payload: unknown): { accentColor: unknown; text: string } {
  const containers = (payload as { components: Array<Record<string, unknown>> }).components;
  const receipt = containers[1] as { accentColor: unknown; components: Array<{ content: string }> };
  return { accentColor: receipt.accentColor, text: receipt.components[0]?.content ?? "" };
}

describe("providers endpoint-activate route", () => {
  const customId = buildProvidersRouteId(PROVIDERS_ROUTE_NAMESPACE, {
    action: "endpoint-activate",
    locale: "en-US",
    connectionId: 88,
  });

  it("acknowledges the interaction before the write and repaints from a re-resolved scope", async () => {
    const calls: string[] = [];
    let acknowledged: boolean | null = null;
    const interaction = activationInteraction(customId, "speech:502", calls);
    const route = createProvidersInteractionRoute({
      resolveScope: async (_interaction, forceRefresh) => {
        calls.push(forceRefresh ? "reload" : "load");
        return workspaceScope;
      },
      operations: {
        activateWorkspaceEndpoint: async () => {
          // Sampled from inside the write: ordering is invisible in the call list alone, and an
          // unacknowledged interaction still lands the row while the user sees a failed command.
          acknowledged = calls.includes("deferUpdate");
          calls.push("write");
          return { status: "success", identity: "voicebox (speech)", sourceChanged: false };
        },
      } as never,
    });

    await route.execute({} as Client, interaction as never, parsed(customId));
    expect(acknowledged).toBe(true);
    expect(calls).toEqual(["deferUpdate", "reload", "write", "reload", "editReply"]);
  });

  it("records one workspace metric per capability and none for an already-active no-op", async () => {
    const recorded: string[] = [];
    const build = (status: "success" | "already-active") =>
      createProvidersInteractionRoute({
        resolveScope: async () => workspaceScope,
        recordAction: (input) => {
          recorded.push(input.action);
        },
        operations: {
          activateWorkspaceEndpoint: async () =>
            status === "success"
              ? { status: "success", identity: "voicebox (speech)", sourceChanged: false }
              : { status: "already-active", identity: "voicebox (speech)" },
        } as never,
      });

    await build("success").execute(
      {} as Client,
      activationInteraction(customId, "speech:502", []) as never,
      parsed(customId),
    );
    await build("success").execute(
      {} as Client,
      activationInteraction(customId, "transcription:601", []) as never,
      parsed(customId),
    );
    await build("already-active").execute(
      {} as Client,
      activationInteraction(customId, "speech:501", []) as never,
      parsed(customId),
    );

    expect(recorded).toEqual([
      "providers.workspace.speech-endpoint.activate",
      "providers.workspace.transcription-endpoint.activate",
    ]);
  });

  it("never reaches the write from the personal namespace, even with a replayed custom id", async () => {
    const calls: string[] = [];
    const personalCustomId = buildProvidersRouteId(PERSONAL_PROVIDERS_ROUTE_NAMESPACE, {
      action: "endpoint-activate",
      locale: "en-US",
      connectionId: 88,
    });
    const interaction = activationInteraction(personalCustomId, "speech:502", calls);
    const route = createProvidersInteractionRoute(
      {
        resolveScope: async () => ({
          ...workspaceScope,
          scopeKind: "personal",
          ownerId: 77,
          routeNamespace: PERSONAL_PROVIDERS_ROUTE_NAMESPACE,
        }),
        operations: {
          activateWorkspaceEndpoint: async () => {
            calls.push("write");
            return { status: "success", identity: "voicebox (speech)", sourceChanged: false };
          },
        } as never,
      },
      {
        namespace: PERSONAL_PROVIDERS_ROUTE_NAMESPACE,
        authorize: () => true,
        includeBrave: false,
        allowRotation: false,
        allowEndpointActivation: false,
      },
    );

    await route.execute({} as Client, interaction as never, parsed(personalCustomId));
    expect(calls).toEqual(["deferUpdate", "editReply"]);
  });

  it("denies a non-manager guild member without reaching the write", async () => {
    const calls: string[] = [];
    const interaction = {
      ...activationInteraction(customId, "speech:502", calls),
      memberPermissions: { has: () => false },
    };
    const route = createProvidersInteractionRoute({
      resolveScope: async () => workspaceScope,
      operations: {
        activateWorkspaceEndpoint: async () => {
          calls.push("write");
          return { status: "success", identity: "voicebox (speech)", sourceChanged: false };
        },
      } as never,
    });

    await route.execute({} as Client, interaction as never, parsed(customId));
    expect(calls).not.toContain("write");
  });

  async function paintFor(
    value: string,
    result: Awaited<ReturnType<typeof providerPanelOperations.activateWorkspaceEndpoint>>,
  ) {
    const painted: unknown[] = [];
    const route = createProvidersInteractionRoute({
      resolveScope: async () => workspaceScope,
      operations: { activateWorkspaceEndpoint: async () => result } as never,
    });
    await route.execute({} as Client, activationInteraction(customId, value, [], painted) as never, parsed(customId));
    return paintedReceipt(painted[0]);
  }

  it("tells a speech user to reassign voices only when the endpoint's source type changed", async () => {
    const changed = await paintFor("speech:503", {
      status: "success",
      identity: "elevenlabs (speech)",
      sourceChanged: true,
    });
    expect(changed.text).toBe(
      "### Endpoint activated\n> **elevenlabs (speech)** is now active. Because the voice source type changed, run `/speech voice-assign` if any persona needs a matching voice assignment.",
    );

    const unchanged = await paintFor("speech:502", {
      status: "success",
      identity: "voicebox (speech)",
      sourceChanged: false,
    });
    expect(unchanged.text).toBe(
      "### Endpoint activated\n> **voicebox (speech)** is now the active endpoint for this capability.",
    );
  });

  it("never offers voice reassignment for transcription, which has no voices to reassign", async () => {
    const painted = await paintFor("transcription:601", {
      status: "success",
      identity: "voicebox (transcription)",
      sourceChanged: true,
    });
    expect(painted.text).toBe(
      "### Endpoint activated\n> **voicebox (transcription)** is now the active endpoint for this capability.",
    );
    expect(painted.text).not.toContain("voice-assign");
  });

  it("reports the already-active no-op and both failure shapes back to the user", async () => {
    const success = await paintFor("speech:502", {
      status: "success",
      identity: "voicebox (speech)",
      sourceChanged: false,
    });
    const noop = await paintFor("speech:501", { status: "already-active", identity: "voicebox (speech)" });
    expect(noop.text).toBe(
      "### Endpoint already active\n> **voicebox (speech)** is already the active endpoint. Nothing changed.",
    );

    const missing = await paintFor("speech:9999", { status: "not-found" });
    expect(missing.text).toBe(
      "### Endpoint was not activated\n> That entry no longer exists. The panel now shows current state.",
    );

    const failed = await paintFor("speech:502", { status: "write-failed" });
    expect(failed.text.startsWith("### Endpoint was not activated\n> ")).toBe(true);

    // A silent no-op and a failed write must not read as a success, so their accents have to differ
    // from it and from each other.
    expect(noop.accentColor).not.toBe(success.accentColor);
    expect(failed.accentColor).not.toBe(success.accentColor);
    expect(failed.accentColor).not.toBe(noop.accentColor);
    expect(missing.accentColor).toBe(noop.accentColor);
  });

  it("keeps entity selection read-only navigation rather than an activation", async () => {
    const calls: string[] = [];
    const selectId = buildProvidersRouteId(PROVIDERS_ROUTE_NAMESPACE, { action: "select", locale: "en-US" });
    const interaction = activationInteraction(selectId, "endpoint:88", calls);
    const route = createProvidersInteractionRoute({
      resolveScope: async () => workspaceScope,
      operations: {
        activateWorkspaceEndpoint: async () => {
          calls.push("write");
          return { status: "success", identity: "voicebox (speech)", sourceChanged: false };
        },
      } as never,
    });

    await route.execute({} as Client, interaction as never, parsed(selectId));
    expect(calls).toEqual(["deferUpdate", "editReply"]);
  });
});
