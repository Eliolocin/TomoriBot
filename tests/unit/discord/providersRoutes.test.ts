import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { ChatInputCommandInteraction, Client } from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import type { LoadedProviderPanelScope } from "@/utils/provider/providerPanelOperations";
import { executeProvidersCommand } from "@/commands/providers";
import { createProvidersInteractionRoute } from "@/utils/discord/interactions/providersRoutes";
import { parseInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import {
  buildProvidersRouteId,
  buildProvidersRouteSegments,
  listProvidersPanelActions,
  parseProvidersPanelRoute,
  PERSONAL_PROVIDERS_ROUTE_NAMESPACE,
  PROVIDERS_ROUTE_CODECS,
  PROVIDERS_ROUTE_NAMESPACE,
  type ProvidersPanelRoute,
} from "@/utils/discord/providersPanelCatalog";
import {
  buildAddEndpointModal,
  buildAddProviderModal,
  buildEditEndpointModal,
  buildEditProviderModal,
  buildProviderModelModal,
  buildProvidersPanelPayload,
  type ProvidersPanelRenderInput,
} from "@/utils/discord/ui/providersPanel";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const WIRE_CONTRACT_V1: ReadonlyArray<readonly [string, ProvidersPanelRoute]> = [
  ["providers:v1:select:en-US", { action: "select", locale: "en-US" }],
  ["providers:v1:retry:en-US", { action: "retry", locale: "en-US" }],
  ["providers:v1:range-open:en-US", { action: "range-open", locale: "en-US" }],
  ["providers:v1:range-cancel:en-US", { action: "range-cancel", locale: "en-US" }],
  ["providers:v1:range:en-US:2", { action: "range", locale: "en-US", rangeIndex: 2 }],
  ["providers:v1:range-page:en-US:2", { action: "range-page", locale: "en-US", rangeIndex: 2 }],
  [
    "providers:v1:model-open:en-US:provider:google",
    { action: "model-open", locale: "en-US", entryKind: "provider", entryKey: "google" },
  ],
  [
    "providers:v1:model-select:en-US:endpoint:73",
    { action: "model-select", locale: "en-US", entryKind: "endpoint", entryKey: "73" },
  ],
  [
    "providers:v1:model-close:en-US:provider:google",
    { action: "model-close", locale: "en-US", entryKind: "provider", entryKey: "google" },
  ],
  [
    "providers:v1:model-range:en-US:provider:google:1",
    { action: "model-range", locale: "en-US", entryKind: "provider", entryKey: "google", rangeIndex: 1 },
  ],
  [
    "providers:v1:model-submit:en-US:endpoint:73:image:9:abcdefgh",
    {
      action: "model-submit",
      locale: "en-US",
      entryKind: "endpoint",
      entryKey: "73",
      capability: "image",
      editingModelId: 9,
      nonce: "abcdefgh",
    },
  ],
  [
    "providers:v1:model-submit:en-US:provider:google:text:0:abcdefgh",
    {
      action: "model-submit",
      locale: "en-US",
      entryKind: "provider",
      entryKey: "google",
      capability: "text",
      editingModelId: null,
      nonce: "abcdefgh",
    },
  ],
  [
    "providers:v1:edit-provider-open:en-US:google:2",
    { action: "edit-provider-open", locale: "en-US", provider: "google", rotationKeyCount: 2 },
  ],
  [
    "providers:v1:edit-provider-submit:en-US:google:abcdefgh",
    { action: "edit-provider-submit", locale: "en-US", provider: "google", nonce: "abcdefgh" },
  ],
  ["providers:v1:edit-endpoint-open:en-US:73", { action: "edit-endpoint-open", locale: "en-US", connectionId: 73 }],
  [
    "providers:v1:edit-endpoint-submit:en-US:73:abcdefgh",
    { action: "edit-endpoint-submit", locale: "en-US", connectionId: 73, nonce: "abcdefgh" },
  ],
  [
    "providers:v1:remove-prompt:en-US:brave:brave",
    { action: "remove-prompt", locale: "en-US", entryKind: "brave", entryKey: "brave" },
  ],
  [
    "providers:v1:remove-cancel:en-US:endpoint:73",
    { action: "remove-cancel", locale: "en-US", entryKind: "endpoint", entryKey: "73" },
  ],
  [
    "providers:v1:remove-confirm:en-US:provider:google",
    { action: "remove-confirm", locale: "en-US", entryKind: "provider", entryKey: "google" },
  ],
  ["providers:v1:add-submit:en-US:abcdefgh", { action: "add-submit", locale: "en-US", nonce: "abcdefgh" }],
  ["providers:v1:endpoint-submit:en-US:abcdefgh", { action: "endpoint-submit", locale: "en-US", nonce: "abcdefgh" }],
];

const scope: LoadedProviderPanelScope = {
  state: { server_id: 42 } as TomoriState,
  data: {
    readStatus: "fresh",
    entries: [
      {
        id: "provider:google",
        kind: "provider",
        provider: "google",
        displayName: "Google",
        savedAt: null,
        rotationKeyCount: 2,
        capabilities: [
          {
            capability: "text",
            availability: "available",
            models: [
              {
                id: 91,
                codeName: "google/gemini-example",
                isWorkspaceActive: true,
                isWorkspaceFallback: false,
                isProviderFallback: false,
                isCustomRegistration: true,
                textSettings: {
                  numCtx: 4096,
                  hasTools: true,
                  seesImages: false,
                  supportsStructOutput: false,
                  strictRoleAlternation: false,
                  supportsPrefixCompletion: false,
                },
              },
            ],
          },
        ],
      },
    ],
    initialEntryId: "provider:google",
  },
};

function parsed(customId: string) {
  const route = parseInteractionRoute(customId);
  if (!route) throw new Error("Expected a parsed route");
  return route;
}

describe("providers routes", () => {
  it("decodes every literal v1 wire string to its exact route", () => {
    for (const [customId, expected] of WIRE_CONTRACT_V1) {
      expect(parseProvidersPanelRoute(parsed(customId), PROVIDERS_ROUTE_NAMESPACE)).toEqual(expected);
    }
  });

  it("encodes every canonical typed route to exact literal wire bytes", () => {
    for (const [customId, expected] of WIRE_CONTRACT_V1) {
      expect(buildProvidersRouteId(PROVIDERS_ROUTE_NAMESPACE, expected)).toBe(customId);
      const expectedSegments = customId.split(":").slice(2);
      expect(buildProvidersRouteSegments(expected)).toEqual(expectedSegments);
    }
  });

  it("round trips parse and build for all canonical actions across both namespaces", () => {
    for (const [, expected] of WIRE_CONTRACT_V1) {
      const guildId = buildProvidersRouteId(PROVIDERS_ROUTE_NAMESPACE, expected);
      const guildParsed = parseProvidersPanelRoute(parsed(guildId), PROVIDERS_ROUTE_NAMESPACE);
      expect(guildParsed).toEqual(expected);

      const personalId = buildProvidersRouteId(PERSONAL_PROVIDERS_ROUTE_NAMESPACE, expected);
      const personalParsed = parseProvidersPanelRoute(parsed(personalId), PERSONAL_PROVIDERS_ROUTE_NAMESPACE);
      expect(personalParsed).toEqual(expected);
    }
  });

  it("guarantees 20-action exhaustiveness across catalog, accepted actions, wire contract, and route handler comparisons", () => {
    const ACCEPTED_20_ACTIONS = [
      "add-submit",
      "edit-endpoint-open",
      "edit-endpoint-submit",
      "edit-provider-open",
      "edit-provider-submit",
      "endpoint-submit",
      "model-close",
      "model-open",
      "model-range",
      "model-select",
      "model-submit",
      "range",
      "range-cancel",
      "range-open",
      "range-page",
      "remove-cancel",
      "remove-confirm",
      "remove-prompt",
      "retry",
      "select",
    ].sort();

    const catalogActions = listProvidersPanelActions().sort();
    const wireActions = [...new Set(WIRE_CONTRACT_V1.map(([, route]) => route.action))].sort();
    const codecTableActions = Object.keys(PROVIDERS_ROUTE_CODECS).sort();

    const routesSource = readFileSync(
      new URL("../../../src/utils/discord/interactions/providersRoutes.ts", import.meta.url),
      "utf8",
    );
    const handlerActions = new Set([...routesSource.matchAll(/route\.action === "([a-z0-9-]+)"/g)].map((m) => m[1]));

    expect(catalogActions).toEqual(ACCEPTED_20_ACTIONS);
    expect(wireActions).toEqual(ACCEPTED_20_ACTIONS);
    expect(codecTableActions).toEqual(ACCEPTED_20_ACTIONS);

    expect(handlerActions.size).toBe(20);
    expect([...handlerActions].sort()).toEqual(ACCEPTED_20_ACTIONS);
    expect(ACCEPTED_20_ACTIONS.filter((a) => !handlerActions.has(a))).toEqual([]);
    expect([...handlerActions].filter((a) => !ACCEPTED_20_ACTIONS.includes(a))).toEqual([]);
    expect(codecTableActions.filter((a) => !handlerActions.has(a))).toEqual([]);
    expect([...handlerActions].filter((a) => !codecTableActions.includes(a))).toEqual([]);
  });

  it("guarantees producer coverage against production UI and modal surfaces with explicit allowlist for producerless actions", () => {
    const PRODUCERLESS_ACTIONS = ["model-open", "model-close"] as const;
    const ACCEPTED_20_ACTIONS = [
      "add-submit",
      "edit-endpoint-open",
      "edit-endpoint-submit",
      "edit-provider-open",
      "edit-provider-submit",
      "endpoint-submit",
      "model-close",
      "model-open",
      "model-range",
      "model-select",
      "model-submit",
      "range",
      "range-cancel",
      "range-open",
      "range-page",
      "remove-cancel",
      "remove-confirm",
      "remove-prompt",
      "retry",
      "select",
    ].sort();

    const customIds: string[] = [];

    customIds.push(buildAddProviderModal("en-US", "nonce1234567").custom_id);
    customIds.push(buildAddEndpointModal("en-US", "nonce1234567").custom_id);
    customIds.push(buildEditProviderModal("en-US", "google", 2, "nonce1234567").custom_id);
    customIds.push(
      buildEditEndpointModal(
        "en-US",
        {
          connectionId: 73,
          label: "ep",
          endpointUrl: "https://example.com",
          apiStyles: ["openai-compatible"],
          isPreset: false,
        },
        "nonce1234567",
      ).custom_id,
    );
    customIds.push(buildProviderModelModal("en-US", "provider", "google", "text", null, "nonce1234567").custom_id);

    const panelInputs: ProvidersPanelRenderInput[] = [
      {
        locale: "en-US",
        entries: scope.data.entries,
        initialEntryId: "provider:google",
        readStatus: "fresh",
        page: { kind: "entry", entryId: "provider:google" },
        enabledActions: new Set(["add-provider", "add-endpoint", "model", "edit", "remove"]),
      },
      {
        locale: "en-US",
        entries: [],
        initialEntryId: null,
        readStatus: "unavailable",
        page: { kind: "entry" },
      },
      {
        locale: "en-US",
        entries: Array.from({ length: 600 }, (_, i) => ({
          id: `provider:p${i}`,
          kind: "provider",
          provider: `p${i}`,
          displayName: `P${i}`,
          savedAt: null,
          rotationKeyCount: 0,
          capabilities: [],
        })),
        initialEntryId: "provider:p0",
        readStatus: "fresh",
        page: { kind: "entry-chooser", chooserPage: 0 },
      },
      {
        locale: "en-US",
        entries: scope.data.entries,
        initialEntryId: "provider:google",
        readStatus: "fresh",
        page: { kind: "remove", entryId: "provider:google" },
      },
      {
        locale: "en-US",
        entries: [
          {
            id: "endpoint:73",
            kind: "endpoint",
            displayName: "EP",
            savedAt: null,
            connectionIds: [73],
            capabilities: [
              {
                capability: "text",
                availability: "available",
                models: Array.from({ length: 30 }, (_, i) => ({
                  id: 100 + i,
                  codeName: `model-${i}`,
                  isWorkspaceActive: false,
                  isWorkspaceFallback: false,
                  isProviderFallback: false,
                  isCustomRegistration: true,
                })),
              },
            ],
          },
        ],
        initialEntryId: "endpoint:73",
        readStatus: "fresh",
        page: { kind: "entry", entryId: "endpoint:73", modelRangeIndex: 1 },
        enabledActions: new Set(["model", "edit", "remove"]),
      },
    ];

    for (const input of panelInputs) {
      const payload = buildProvidersPanelPayload(input);
      const extractCustomIds = (obj: unknown): void => {
        if (!obj || typeof obj !== "object") return;
        if (Array.isArray(obj)) {
          for (const item of obj) extractCustomIds(item);
        } else {
          const record = obj as Record<string, unknown>;
          if (typeof record.customId === "string") customIds.push(record.customId);
          if (typeof record.custom_id === "string") customIds.push(record.custom_id);
          for (const val of Object.values(record)) extractCustomIds(val);
        }
      };
      extractCustomIds(payload);
    }

    const producedActions = new Set<string>();
    for (const id of customIds) {
      const parsedRoute = parseProvidersPanelRoute(
        parsed(id),
        id.startsWith("personal-providers") ? PERSONAL_PROVIDERS_ROUTE_NAMESPACE : PROVIDERS_ROUTE_NAMESPACE,
      );
      expect(parsedRoute).not.toBeNull();
      if (parsedRoute) producedActions.add(parsedRoute.action);
    }

    for (const producerless of PRODUCERLESS_ACTIONS) {
      expect(producedActions.has(producerless)).toBe(false);
    }

    const unionedActions = [...new Set([...producedActions, ...PRODUCERLESS_ACTIONS])].sort();
    expect(unionedActions).toEqual(ACCEPTED_20_ACTIONS);
  });

  it("enforces exact 100-character bound for the maximum personal route and covers guild namespace", () => {
    const maxPersonalRoute: ProvidersPanelRoute = {
      action: "model-submit",
      locale: "zh-Hans",
      entryKind: "endpoint",
      entryKey: "2147483647",
      capability: "transcription",
      editingModelId: 2147483647,
      nonce: "nonce1234567",
    };

    const personalCustomId = buildProvidersRouteId(PERSONAL_PROVIDERS_ROUTE_NAMESPACE, maxPersonalRoute);
    expect(personalCustomId).toBe(
      "personal-providers:v1:model-submit:zh-Hans:endpoint:2147483647:transcription:2147483647:nonce1234567",
    );
    expect(personalCustomId.length).toBe(100);

    const guildCustomId = buildProvidersRouteId(PROVIDERS_ROUTE_NAMESPACE, maxPersonalRoute);
    expect(guildCustomId).toBe(
      "providers:v1:model-submit:zh-Hans:endpoint:2147483647:transcription:2147483647:nonce1234567",
    );
    expect(guildCustomId.length).toBe(91);

    const maxEnUsRoute: ProvidersPanelRoute = {
      ...maxPersonalRoute,
      locale: "en-US",
    };
    const enUsPersonalCustomId = buildProvidersRouteId(PERSONAL_PROVIDERS_ROUTE_NAMESPACE, maxEnUsRoute);
    const parsedPersonal = parseProvidersPanelRoute(parsed(enUsPersonalCustomId), PERSONAL_PROVIDERS_ROUTE_NAMESPACE);
    expect(parsedPersonal).toEqual(maxEnUsRoute);

    const enUsGuildCustomId = buildProvidersRouteId(PROVIDERS_ROUTE_NAMESPACE, maxEnUsRoute);
    const parsedGuild = parseProvidersPanelRoute(parsed(enUsGuildCustomId), PROVIDERS_ROUTE_NAMESPACE);
    expect(parsedGuild).toEqual(maxEnUsRoute);
  });

  it("rejects malformed, empty, negative, or invalid-enum route segments", () => {
    expect(parseProvidersPanelRoute({ namespace: "wrong", version: "v1", segments: ["select", "en-US"] })).toBeNull();
    expect(
      parseProvidersPanelRoute({ namespace: "providers", version: "v2", segments: ["select", "en-US"] }),
    ).toBeNull();

    expect(parseProvidersPanelRoute(parsed("providers:v1:select:invalid-locale"))).toBeNull();
    expect(parseProvidersPanelRoute(parsed("providers:v1:unknown-action:en-US"))).toBeNull();

    expect(parseProvidersPanelRoute(parsed("providers:v1:range:en-US"))).toBeNull();
    expect(parseProvidersPanelRoute(parsed("providers:v1:edit-provider-open:en-US:google"))).toBeNull();
    expect(parseProvidersPanelRoute(parsed("providers:v1:model-submit:en-US:provider:google:text:0"))).toBeNull();

    expect(parseProvidersPanelRoute(parsed("providers:v1:select:en-US:extra"))).toBeNull();
    expect(parseProvidersPanelRoute(parsed("providers:v1:range:en-US:1:extra"))).toBeNull();

    expect(parseProvidersPanelRoute(parsed("providers:v1:range:en-US:-1"))).toBeNull();
    expect(parseProvidersPanelRoute(parsed("providers:v1:edit-endpoint-open:en-US:-5"))).toBeNull();
    expect(parseProvidersPanelRoute(parsed("providers:v1:edit-endpoint-open:en-US:0"))).toBeNull();

    expect(parseProvidersPanelRoute(parsed("providers:v1:model-open:en-US:invalidkind:google"))).toBeNull();
    expect(parseProvidersPanelRoute(parsed("providers:v1:model-open:en-US:brave:brave"))).toBeNull();

    expect(
      parseProvidersPanelRoute(parsed("providers:v1:model-submit:en-US:provider:google:invalidcap:0:abcdefgh")),
    ).toBeNull();

    expect(parseProvidersPanelRoute(parsed("providers:v1:add-submit:en-US:short"))).toBeNull();
    expect(parseProvidersPanelRoute(parsed("providers:v1:add-submit:en-US:invalid!nonce#"))).toBeNull();
  });

  it("keeps personal interactions unrestricted and marked as personal writes", async () => {
    const calls: string[] = [];
    const customId = buildProvidersRouteId(PERSONAL_PROVIDERS_ROUTE_NAMESPACE, {
      action: "edit-provider-submit",
      locale: "en-US",
      provider: "google",
      nonce: "abcdefgh",
    });
    const personalScope: LoadedProviderPanelScope = {
      ...scope,
      scopeKind: "personal",
      ownerId: 77,
      routeNamespace: PERSONAL_PROVIDERS_ROUTE_NAMESPACE,
    };
    const interaction = {
      id: "interaction",
      customId,
      guildId: "123",
      user: { id: "456" },
      memberPermissions: { has: () => false },
      fields: {
        getTextInputValue: (id: string) => {
          if (id.startsWith("rotation-key")) throw new Error("Personal modal requested a rotation field");
          return "new-primary-key";
        },
      },
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      isButton: () => false,
      deferUpdate: async () => calls.push("deferUpdate"),
      editReply: async () => calls.push("editReply"),
    };
    const route = createProvidersInteractionRoute(
      {
        resolveScope: async () => personalScope,
        operations: {
          editServerProvider: async (input) => {
            calls.push(`write:${input.scopeKind}:${input.ownerId}:${input.rotationKey}`);
            return { status: "success", entryId: "provider:google", changed: ["api-key"] };
          },
        } as never,
      },
      {
        namespace: PERSONAL_PROVIDERS_ROUTE_NAMESPACE,
        authorize: () => true,
        includeBrave: false,
        allowRotation: false,
      },
    );

    await route.execute({} as Client, interaction as never, parsed(customId));
    expect(calls).toEqual(["deferUpdate", "write:personal:77:", "editReply"]);
  });

  it("opens Edit Provider directly with the provider-scoped rotation count", async () => {
    const calls: string[] = [];
    const customId = buildProvidersRouteId(PROVIDERS_ROUTE_NAMESPACE, {
      action: "edit-provider-open",
      locale: "en-US",
      provider: "google",
      rotationKeyCount: 2,
    });
    const interaction = {
      customId,
      guildId: "123",
      user: { id: "456" },
      memberPermissions: { has: () => true },
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      isButton: () => true,
      deferUpdate: async () => calls.push("deferUpdate"),
    };
    const route = createProvidersInteractionRoute({
      createNonce: () => "abcdefgh",
      showProviderEditModal: async (_interaction, _locale, provider, count) => calls.push(`show:${provider}:${count}`),
    });

    await route.execute({} as Client, interaction as never, parsed(customId));
    expect(calls).toEqual(["show:google:2"]);
  });

  it("resolves a fresh endpoint before opening Edit Endpoint without deferring", async () => {
    const calls: string[] = [];
    const endpointScope: LoadedProviderPanelScope = {
      ...scope,
      data: {
        ...scope.data,
        entries: [
          {
            id: "endpoint:73",
            kind: "endpoint",
            displayName: "lighthouse",
            savedAt: null,
            connectionIds: [73],
            connectionDetails: [
              {
                connectionId: 73,
                endpointUrl: "https://models.example.com/v1",
                apiStyle: "openai-compatible",
              },
            ],
            isPreset: false,
            capabilities: [],
          },
        ],
      },
    };
    const customId = buildProvidersRouteId(PROVIDERS_ROUTE_NAMESPACE, {
      action: "edit-endpoint-open",
      locale: "en-US",
      connectionId: 73,
    });
    const interaction = {
      customId,
      guildId: "123",
      user: { id: "456" },
      memberPermissions: { has: () => true },
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      isButton: () => true,
      deferUpdate: async () => calls.push("deferUpdate"),
    };
    const route = createProvidersInteractionRoute({
      createNonce: () => "abcdefgh",
      resolveScope: async () => {
        calls.push("load");
        return endpointScope;
      },
      showEndpointEditModal: async (_interaction, _locale, context) =>
        calls.push(`show:${context.label}:${context.endpointUrl}`),
    });

    await route.execute({} as Client, interaction as never, parsed(customId));
    expect(calls).toEqual(["load", "show:lighthouse:https://models.example.com/v1"]);
  });

  it("reauthorizes, writes, and reloads after Edit Provider submit", async () => {
    const calls: string[] = [];
    const customId = buildProvidersRouteId(PROVIDERS_ROUTE_NAMESPACE, {
      action: "edit-provider-submit",
      locale: "en-US",
      provider: "google",
      nonce: "abcdefgh",
    });
    const interaction = {
      id: "interaction",
      customId,
      guildId: "123",
      user: { id: "456" },
      memberPermissions: { has: () => true },
      fields: {
        getTextInputValue: (id: string) => (id.startsWith("rotation-key") ? "new-rotation-key" : "new-primary-key"),
      },
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      isButton: () => false,
      deferUpdate: async () => calls.push("deferUpdate"),
      editReply: async () => calls.push("editReply"),
    };
    const route = createProvidersInteractionRoute({
      takeDeleteRotation: () => "keep",
      resolveScope: async (_interaction, forceRefresh) => {
        calls.push(forceRefresh ? "reload" : "load");
        return scope;
      },
      operations: {
        editServerProvider: async (input) => {
          calls.push(`write:${input.provider}:${input.deleteRotationKeys}`);
          return { status: "success", entryId: "provider:google", changed: ["api-key", "rotation-key"] };
        },
      } as never,
    });

    await route.execute({} as Client, interaction as never, parsed(customId));
    expect(calls).toEqual(["deferUpdate", "reload", "write:google:false", "reload", "editReply"]);
  });

  it("reauthorizes and re-resolves the target after destructive confirmation", async () => {
    const calls: string[] = [];
    const customId = buildProvidersRouteId(PROVIDERS_ROUTE_NAMESPACE, {
      action: "remove-confirm",
      locale: "en-US",
      entryKind: "provider",
      entryKey: "google",
    });
    const interaction = {
      customId,
      guildId: "123",
      user: { id: "456" },
      memberPermissions: { has: () => true },
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      isButton: () => true,
      deferUpdate: async () => calls.push("deferUpdate"),
      editReply: async () => calls.push("editReply"),
    };
    const route = createProvidersInteractionRoute({
      resolveScope: async (_interaction, forceRefresh) => {
        calls.push(forceRefresh ? "reload" : "load");
        return scope;
      },
      operations: {
        removeServerProviderEntry: async (input) => {
          calls.push(`write:${input.entry.id}`);
          return { status: "success", entryId: input.entry.id, displayName: input.entry.displayName };
        },
      } as never,
    });

    await route.execute({} as Client, interaction as never, parsed(customId));
    expect(calls).toEqual(["deferUpdate", "reload", "write:provider:google", "reload", "editReply"]);
  });

  it("opens Add New Provider as the select acknowledgement without deferring", async () => {
    const calls: string[] = [];
    const interaction = {
      customId: buildProvidersRouteId(PROVIDERS_ROUTE_NAMESPACE, { action: "select", locale: "en-US" }),
      guildId: "123",
      user: { id: "456" },
      memberPermissions: { has: () => true },
      values: ["action:add-provider"],
      isStringSelectMenu: () => true,
      isModalSubmit: () => false,
      isButton: () => false,
      deferUpdate: async () => calls.push("deferUpdate"),
      editReply: async () => calls.push("editReply"),
    };
    const route = createProvidersInteractionRoute({
      createNonce: () => "abcdefgh",
      showAddProviderModal: async () => calls.push("showModal"),
      resolveScope: async () => {
        calls.push("load");
        return scope;
      },
    });

    await route.execute({} as Client, interaction as never, parsed(interaction.customId));
    expect(calls).toEqual(["showModal"]);
  });

  it("reauthorizes and auto-repaints after an Add Provider modal write", async () => {
    const calls: string[] = [];
    const customId = buildProvidersRouteId(PROVIDERS_ROUTE_NAMESPACE, {
      action: "add-submit",
      locale: "en-US",
      nonce: "abcdefgh",
    });
    const interaction = {
      id: "interaction",
      customId,
      guildId: "123",
      user: { id: "456" },
      memberPermissions: { has: () => true },
      fields: { getTextInputValue: () => "valid-api-key" },
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      isButton: () => false,
      deferUpdate: async () => calls.push("deferUpdate"),
      editReply: async () => calls.push("editReply"),
    };
    const route = createProvidersInteractionRoute({
      takeProvider: () => "google",
      resolveScope: async (_interaction, forceRefresh) => {
        calls.push(forceRefresh ? "reload" : "load");
        return scope;
      },
      operations: {
        addServerProvider: async () => {
          calls.push("write");
          return {
            status: "success",
            entryId: "provider:google",
            displayName: "Google Gemini",
            modelName: "model-one",
            updated: false,
          };
        },
        addCustomEndpointConnection: async () => ({
          status: "write-failed",
        }),
      },
    });

    await route.execute({} as Client, interaction as never, parsed(customId));
    expect(calls).toEqual(["deferUpdate", "load", "write", "reload", "editReply"]);
  });

  it("opens Add New Custom Endpoint directly without deferring", async () => {
    const calls: string[] = [];
    const customId = buildProvidersRouteId(PROVIDERS_ROUTE_NAMESPACE, { action: "select", locale: "en-US" });
    const interaction = {
      customId,
      guildId: "123",
      user: { id: "456" },
      memberPermissions: { has: () => true },
      values: ["action:add-endpoint"],
      isStringSelectMenu: () => true,
      isModalSubmit: () => false,
      isButton: () => false,
      deferUpdate: async () => calls.push("deferUpdate"),
      editReply: async () => calls.push("editReply"),
    };
    const route = createProvidersInteractionRoute({
      createNonce: () => "abcdefgh",
      showAddEndpointModal: async (_interaction, _locale, nonce) => calls.push(`show:${nonce}`),
    });

    await route.execute({} as Client, interaction as never, parsed(customId));
    expect(calls).toEqual(["show:abcdefgh"]);
  });

  it("opens a selected model modal as the interaction acknowledgement", async () => {
    const calls: string[] = [];
    const customId = buildProvidersRouteId(PROVIDERS_ROUTE_NAMESPACE, {
      action: "model-select",
      locale: "en-US",
      entryKind: "provider",
      entryKey: "google",
    });
    const interaction = {
      customId,
      guildId: "123",
      user: { id: "456" },
      memberPermissions: { has: () => true },
      values: ["edit:text:91"],
      isStringSelectMenu: () => true,
      isModalSubmit: () => false,
      isButton: () => false,
      deferUpdate: async () => calls.push("deferUpdate"),
    };
    let openedWith: unknown;
    const route = createProvidersInteractionRoute({
      createNonce: () => "abcdefgh",
      showModelModal: async (_interaction, _locale, _kind, _key, capability, modelId, _nonce, defaults) => {
        openedWith = defaults;
        calls.push(`show:${capability}:${modelId}`);
      },
      resolveScope: async () => {
        calls.push("load");
        return scope;
      },
    });

    await route.execute({} as Client, interaction as never, parsed(customId));

    expect(calls).toEqual(["load", "show:text:91"]);
    expect(openedWith).toEqual({
      codeName: "google/gemini-example",
      text: {
        numCtx: 4096,
        hasTools: true,
        seesImages: false,
        supportsStructOutput: false,
        strictRoleAlternation: false,
        supportsPrefixCompletion: false,
      },
    });
  });

  it("reloads scope before and after a model submit", async () => {
    const calls: string[] = [];
    const customId = buildProvidersRouteId(PROVIDERS_ROUTE_NAMESPACE, {
      action: "model-submit",
      locale: "en-US",
      entryKind: "provider",
      entryKey: "google",
      capability: "text",
      editingModelId: null,
      nonce: "abcdefgh",
    });
    const interaction = {
      id: "interaction",
      customId,
      guildId: "123",
      user: { id: "456" },
      memberPermissions: { has: () => true },
      fields: {
        getTextInputValue: (id: string) => (id.startsWith("code-name") ? "google/new-model" : "8192"),
      },
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      isButton: () => false,
      deferUpdate: async () => calls.push("deferUpdate"),
      editReply: async () => calls.push("editReply"),
    };
    const route = createProvidersInteractionRoute({
      takeModelFlags: () => ["tools", "structured"],
      takeWorkflow: () => undefined,
      resolveScope: async (_interaction, forceRefresh) => {
        calls.push(forceRefresh ? "reload" : "load");
        return scope;
      },
      operations: {
        addServerProvider: async () => ({ status: "write-failed" }),
        addCustomEndpointConnection: async () => ({ status: "write-failed" }),
        saveProviderModel: async (input) => {
          calls.push(`write:${input.codeName}:${input.hasTools}:${input.supportsStructOutput}`);
          return {
            status: "success",
            entryId: "provider:google",
            codeName: input.codeName,
          };
        },
      },
    });

    await route.execute({} as Client, interaction as never, parsed(customId));
    expect(calls).toEqual(["deferUpdate", "reload", "write:google/new-model:true:true", "reload", "editReply"]);
  });

  it("carries stored image capabilities into the edit modal it opens as the acknowledgement", async () => {
    const calls: string[] = [];
    const customId = buildProvidersRouteId(PROVIDERS_ROUTE_NAMESPACE, {
      action: "model-select",
      locale: "en-US",
      entryKind: "endpoint",
      entryKey: "73",
    });
    const interaction = {
      customId,
      guildId: "123",
      user: { id: "456" },
      memberPermissions: { has: () => true },
      values: ["edit:image:42"],
      isStringSelectMenu: () => true,
      isModalSubmit: () => false,
      isButton: () => false,
      deferUpdate: async () => calls.push("deferUpdate"),
    };
    let openedWith: unknown;
    const route = createProvidersInteractionRoute({
      createNonce: () => "abcdefgh",
      showModelModal: async (_interaction, _locale, _kind, _key, capability, modelId, _nonce, defaults) => {
        openedWith = defaults;
        calls.push(`show:${capability}:${modelId}`);
      },
      resolveScope: async () => ({
        ...scope,
        data: {
          ...scope.data,
          entries: [
            {
              id: "endpoint:73",
              kind: "endpoint" as const,
              displayName: "lighthouse",
              savedAt: null,
              connectionIds: [73],
              connectionDetails: [
                { connectionId: 73, endpointUrl: "https://comfy.example.com", apiStyle: "comfyui" as const },
              ],
              isPreset: false,
              capabilities: [
                {
                  capability: "image" as const,
                  availability: "available" as const,
                  apiStyle: "comfyui" as const,
                  models: [
                    {
                      id: 42,
                      codeName: "anima-v1",
                      isWorkspaceActive: true,
                      isWorkspaceFallback: false,
                      isProviderFallback: false,
                      isCustomRegistration: true,
                      imageSettings: { txt2img: true, img2img: false, inpaint: true, negative_prompt: false },
                    },
                  ],
                },
              ],
            },
          ],
        },
      }),
    });

    await route.execute({} as Client, interaction as never, parsed(customId));

    expect(calls).toEqual(["show:image:42"]);
    expect(openedWith).toEqual({
      codeName: "anima-v1",
      text: undefined,
      image: {
        supports: { txt2img: true, img2img: false, inpaint: true, negative_prompt: false },
        allowInpaint: true,
      },
    });
  });

  it("passes submitted image capability values through to the model write", async () => {
    const calls: string[] = [];
    const customId = buildProvidersRouteId(PROVIDERS_ROUTE_NAMESPACE, {
      action: "model-submit",
      locale: "en-US",
      entryKind: "endpoint",
      entryKey: "73",
      capability: "image",
      editingModelId: null,
      nonce: "abcdefgh",
    });
    const interaction = {
      id: "interaction",
      customId,
      guildId: "123",
      user: { id: "456" },
      memberPermissions: { has: () => true },
      fields: { getTextInputValue: () => "flux" },
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      isButton: () => false,
      deferUpdate: async () => calls.push("deferUpdate"),
      editReply: async () => calls.push("editReply"),
    };
    const route = createProvidersInteractionRoute({
      takeModelFlags: () => [],
      takeImageSupports: () => ["txt2img", "inpaint"],
      takeWorkflow: () => undefined,
      resolveScope: async () => ({
        ...scope,
        data: {
          ...scope.data,
          entries: [
            {
              id: "endpoint:73",
              kind: "endpoint" as const,
              displayName: "lighthouse",
              savedAt: null,
              connectionIds: [73],
              connectionDetails: [
                { connectionId: 73, endpointUrl: "https://comfy.example.com", apiStyle: "comfyui" as const },
              ],
              isPreset: false,
              capabilities: [],
            },
          ],
        },
      }),
      operations: {
        addServerProvider: async () => ({ status: "write-failed" }),
        addCustomEndpointConnection: async () => ({ status: "write-failed" }),
        saveProviderModel: async (input) => {
          calls.push(`write:${input.imageSupportValues?.join("+")}`);
          return { status: "success", entryId: "endpoint:73", codeName: input.codeName };
        },
      },
    });

    await route.execute({} as Client, interaction as never, parsed(customId));

    expect(calls).toContain("write:txt2img+inpaint");
  });

  it("acknowledges selection before loading and performs no write", async () => {
    const calls: string[] = [];
    const customId = buildProvidersRouteId(PROVIDERS_ROUTE_NAMESPACE, { action: "select", locale: "en-US" });
    const interaction = {
      customId,
      guildId: "123",
      user: { id: "456" },
      memberPermissions: { has: () => true },
      values: ["provider:google"],
      isStringSelectMenu: () => true,
      isButton: () => false,
      deferUpdate: async () => calls.push("deferUpdate"),
      editReply: async () => calls.push("editReply"),
    };
    const route = createProvidersInteractionRoute({
      resolveScope: async () => {
        calls.push("load");
        return scope;
      },
    });

    await route.execute({} as Client, interaction as never, parsed(interaction.customId));
    expect(calls).toEqual(["deferUpdate", "load", "editReply"]);
  });

  it("keeps a stored compatibility flag the provider never offered instead of clearing it", async () => {
    const written: Array<Record<string, unknown>> = [];
    const editedScope: LoadedProviderPanelScope = {
      ...scope,
      data: {
        ...scope.data,
        entries: [
          {
            id: "provider:openrouter",
            kind: "provider" as const,
            provider: "openrouter",
            displayName: "OpenRouter",
            savedAt: null,
            rotationKeyCount: 0,
            capabilities: [
              {
                capability: "text" as const,
                availability: "available" as const,
                models: [
                  {
                    id: 91,
                    codeName: "anthropic/claude-example",
                    isWorkspaceActive: true,
                    isWorkspaceFallback: false,
                    isProviderFallback: false,
                    isCustomRegistration: true,
                    textSettings: {
                      numCtx: null,
                      hasTools: true,
                      seesImages: false,
                      supportsStructOutput: false,
                      strictRoleAlternation: true,
                      supportsPrefixCompletion: true,
                    },
                  },
                ],
              },
            ],
          },
        ],
        initialEntryId: "provider:openrouter",
      },
    };
    const customId = buildProvidersRouteId(PROVIDERS_ROUTE_NAMESPACE, {
      action: "model-submit",
      locale: "en-US",
      entryKind: "provider",
      entryKey: "openrouter",
      capability: "text",
      editingModelId: 91,
      nonce: "abcdefgh",
    });
    const interaction = {
      id: "interaction",
      customId,
      guildId: "123",
      user: { id: "456" },
      memberPermissions: { has: () => true },
      fields: { getTextInputValue: () => "anthropic/claude-example" },
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      isButton: () => false,
      deferUpdate: async () => undefined,
      editReply: async () => undefined,
    };
    const route = createProvidersInteractionRoute({
      takeModelFlags: () => ["tools"],
      takeCompatFlags: () => undefined,
      takeWorkflow: () => undefined,
      resolveScope: async () => editedScope,
      operations: {
        saveProviderModel: async (input) => {
          written.push(input as unknown as Record<string, unknown>);
          return { status: "success", entryId: "provider:openrouter", codeName: input.codeName };
        },
      } as never,
    });

    await route.execute({} as Client, interaction as never, parsed(customId));

    expect(written[0]?.hasTools).toBe(true);
    expect(written[0]?.strictRoleAlternation).toBe(true);
    expect(written[0]?.supportsPrefixCompletion).toBe(true);
  });

  it("writes an offered compatibility flag exactly as the group was submitted", async () => {
    const written: Array<Record<string, unknown>> = [];
    const customId = buildProvidersRouteId(PROVIDERS_ROUTE_NAMESPACE, {
      action: "model-submit",
      locale: "en-US",
      entryKind: "endpoint",
      entryKey: "73",
      capability: "text",
      editingModelId: null,
      nonce: "abcdefgh",
    });
    const interaction = {
      id: "interaction",
      customId,
      guildId: "123",
      user: { id: "456" },
      memberPermissions: { has: () => true },
      fields: { getTextInputValue: (id: string) => (id.startsWith("code-name") ? "llama-3" : "") },
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      isButton: () => false,
      deferUpdate: async () => undefined,
      editReply: async () => undefined,
    };
    const route = createProvidersInteractionRoute({
      takeModelFlags: () => [],
      takeCompatFlags: () => ["strict-roles"],
      takeWorkflow: () => undefined,
      resolveScope: async () => ({
        ...scope,
        data: {
          ...scope.data,
          entries: [
            {
              id: "endpoint:73",
              kind: "endpoint" as const,
              displayName: "lighthouse",
              savedAt: null,
              connectionIds: [73],
              connectionDetails: [
                {
                  connectionId: 73,
                  endpointUrl: "https://models.example.com/v1",
                  apiStyle: "openai-compatible" as const,
                },
              ],
              isPreset: false,
              capabilities: [{ capability: "text" as const, availability: "available" as const, models: [] }],
            },
          ],
          initialEntryId: "endpoint:73",
        },
      }),
      operations: {
        saveProviderModel: async (input) => {
          written.push(input as unknown as Record<string, unknown>);
          return { status: "success", entryId: "endpoint:73", codeName: input.codeName };
        },
      } as never,
    });

    await route.execute({} as Client, interaction as never, parsed(customId));

    expect(written[0]?.strictRoleAlternation).toBe(true);
    expect(written[0]?.supportsPrefixCompletion).toBe(false);
  });

  it("prefills the speech modal from the stored endpoint settings it opens with", async () => {
    const calls: string[] = [];
    let openedWith: unknown;
    const customId = buildProvidersRouteId(PROVIDERS_ROUTE_NAMESPACE, {
      action: "model-select",
      locale: "en-US",
      entryKind: "endpoint",
      entryKey: "73",
    });
    const interaction = {
      customId,
      guildId: "123",
      user: { id: "456" },
      memberPermissions: { has: () => true },
      values: ["edit:speech:12"],
      isStringSelectMenu: () => true,
      isModalSubmit: () => false,
      isButton: () => false,
      deferUpdate: async () => calls.push("deferUpdate"),
    };
    const route = createProvidersInteractionRoute({
      createNonce: () => "abcdefgh",
      showModelModal: async (_interaction, _locale, _kind, _key, capability, modelId, _nonce, defaults) => {
        openedWith = defaults;
        calls.push(`show:${capability}:${modelId}`);
      },
      resolveScope: async () => ({
        ...scope,
        data: {
          ...scope.data,
          entries: [
            {
              id: "endpoint:73",
              kind: "endpoint" as const,
              displayName: "chatterbox",
              savedAt: null,
              connectionIds: [73],
              connectionDetails: [
                { connectionId: 73, endpointUrl: "https://tts.example.com", apiStyle: "tts-clone" as const },
              ],
              isPreset: false,
              capabilities: [
                {
                  capability: "speech" as const,
                  availability: "available" as const,
                  apiStyle: "tts-clone" as const,
                  models: [
                    {
                      id: 12,
                      codeName: "chatterbox-v1",
                      isWorkspaceActive: true,
                      isWorkspaceFallback: false,
                      isProviderFallback: false,
                      isCustomRegistration: true,
                      speechSettings: {
                        voiceMode: "auto" as const,
                        scriptMarkup: "emoji" as const,
                        supportsInstruct: true,
                      },
                    },
                  ],
                },
              ],
            },
          ],
          initialEntryId: "endpoint:73",
        },
      }),
    });

    await route.execute({} as Client, interaction as never, parsed(customId));

    expect(calls).toEqual(["show:speech:12"]);
    expect(openedWith).toMatchObject({
      codeName: "chatterbox-v1",
      speech: {
        settings: { voiceMode: "auto", scriptMarkup: "emoji", supportsInstruct: true },
        allowVoiceMode: true,
      },
    });
  });

  it("carries the speech modal's stored behavior fields into the model write", async () => {
    const calls: string[] = [];
    let written: Record<string, unknown> | undefined;
    const customId = buildProvidersRouteId(PROVIDERS_ROUTE_NAMESPACE, {
      action: "model-submit",
      locale: "en-US",
      entryKind: "endpoint",
      entryKey: "73",
      capability: "speech",
      editingModelId: null,
      nonce: "abcdefgh",
    });
    const interaction = {
      id: "interaction",
      customId,
      guildId: "123",
      user: { id: "456" },
      memberPermissions: { has: () => true },
      fields: { getTextInputValue: () => "chatterbox-v1" },
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      isButton: () => false,
      deferUpdate: async () => calls.push("deferUpdate"),
      editReply: async () => calls.push("editReply"),
    };
    const route = createProvidersInteractionRoute({
      takeModelFlags: () => [],
      takeWorkflow: () => undefined,
      takeVoiceMode: () => "voice-design",
      takeScriptMarkup: () => "emoji",
      takeSupportsInstruct: () => [],
      resolveScope: async () => ({
        ...scope,
        data: {
          ...scope.data,
          entries: [
            {
              id: "endpoint:73",
              kind: "endpoint" as const,
              displayName: "chatterbox",
              savedAt: null,
              connectionIds: [73],
              connectionDetails: [
                { connectionId: 73, endpointUrl: "https://tts.example.com", apiStyle: "tts-clone" as const },
              ],
              isPreset: false,
              capabilities: [
                {
                  capability: "speech" as const,
                  availability: "available" as const,
                  apiStyle: "tts-clone" as const,
                  models: [],
                },
              ],
            },
          ],
          initialEntryId: "endpoint:73",
        },
      }),
      operations: {
        saveProviderModel: async (input) => {
          written = input as unknown as Record<string, unknown>;
          calls.push("write");
          return { status: "success", entryId: "endpoint:73", codeName: input.codeName };
        },
      } as never,
    });

    await route.execute({} as Client, interaction as never, parsed(customId));

    expect(calls).toEqual(["deferUpdate", "write", "editReply"]);
    expect(written?.speechVoiceMode).toBe("voice-design");
    expect(written?.speechScriptMarkup).toBe("emoji");
    expect(written?.speechInstructValues).toEqual([]);
  });

  it("refuses a stale add option for a capability the entry no longer exposes", async () => {
    const calls: string[] = [];
    const customId = buildProvidersRouteId(PROVIDERS_ROUTE_NAMESPACE, {
      action: "model-select",
      locale: "en-US",
      entryKind: "endpoint",
      entryKey: "73",
    });
    const replies: unknown[] = [];
    const interaction = {
      customId,
      guildId: "123",
      user: { id: "456" },
      memberPermissions: { has: () => true },
      values: ["add:speech"],
      isStringSelectMenu: () => true,
      isModalSubmit: () => false,
      isButton: () => false,
      deferUpdate: async () => calls.push("deferUpdate"),
      reply: async (payload: unknown) => {
        calls.push("reply");
        replies.push(payload);
      },
    };
    const route = createProvidersInteractionRoute({
      createNonce: () => "abcdefgh",
      showModelModal: async () => calls.push("show"),
      resolveScope: async () => ({
        ...scope,
        data: {
          ...scope.data,
          entries: [
            {
              id: "endpoint:73",
              kind: "endpoint" as const,
              displayName: "lighthouse",
              savedAt: null,
              connectionIds: [73],
              connectionDetails: [
                {
                  connectionId: 73,
                  endpointUrl: "https://models.example.com/v1",
                  apiStyle: "openai-compatible" as const,
                },
              ],
              isPreset: false,
              capabilities: [
                { capability: "text" as const, availability: "available" as const, models: [] },
                { capability: "speech" as const, availability: "unavailable" as const, models: [] },
              ],
            },
          ],
          initialEntryId: "endpoint:73",
        },
      }),
    });

    await route.execute({} as Client, interaction as never, parsed(customId));

    expect(calls).toEqual(["reply"]);
    expect(JSON.stringify(replies[0])).toContain("Provider data could not be loaded");
  });

  it("pages model ranges on the entry page itself without writing or changing provider", async () => {
    const calls: string[] = [];
    const pagedScope: LoadedProviderPanelScope = {
      state: {} as TomoriState,
      data: {
        readStatus: "fresh",
        entries: [
          {
            id: "provider:google",
            kind: "provider" as const,
            provider: "google",
            displayName: "Google",
            savedAt: null,
            rotationKeyCount: 0,
            capabilities: [
              {
                capability: "text" as const,
                availability: "available" as const,
                models: Array.from({ length: 20 }, (_, index) => ({
                  id: index + 1,
                  codeName: `custom/model-${index + 1}`,
                  isWorkspaceActive: false,
                  isWorkspaceFallback: false,
                  isProviderFallback: false,
                  isCustomRegistration: true,
                })),
              },
            ],
          },
        ],
        initialEntryId: "provider:google",
      },
    };
    const payloads: unknown[] = [];
    const customId = buildProvidersRouteId(PROVIDERS_ROUTE_NAMESPACE, {
      action: "model-range",
      locale: "en-US",
      entryKind: "provider",
      entryKey: "google",
      rangeIndex: 1,
    });
    const interaction = {
      customId,
      guildId: "123",
      user: { id: "456" },
      memberPermissions: { has: () => true },
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      isButton: () => true,
      deferUpdate: async () => calls.push("deferUpdate"),
      editReply: async (payload: unknown) => {
        calls.push("editReply");
        payloads.push(payload);
      },
    };
    const route = createProvidersInteractionRoute({
      resolveScope: async () => {
        calls.push("load");
        return pagedScope;
      },
      operations: new Proxy({} as never, {
        get: (_target, property) => () => {
          throw new Error(`Model range navigation called ${String(property)}`);
        },
      }),
    });

    await route.execute({} as Client, interaction as never, parsed(customId));
    const rendered = JSON.stringify(payloads[0]);

    expect(calls).toEqual(["deferUpdate", "load", "editReply"]);
    expect(rendered).toContain('"value":"provider:google"');
    expect(rendered).toContain('"default":true');
    expect(rendered).toContain("edit:text:20");
    expect(rendered).not.toContain('edit:text:1"');
    expect(rendered).toContain("Remove Provider");
  });

  it("routes oversized collections through the shared range chooser", async () => {
    const entries = Array.from({ length: 24 }, (_, index) => ({
      id: `provider:p${index}`,
      kind: "provider" as const,
      provider: `p${index}`,
      displayName: `Provider ${index}`,
      savedAt: null,
      rotationKeyCount: 0,
      capabilities: [],
    }));
    const oversizedScope: LoadedProviderPanelScope = {
      state: {} as TomoriState,
      data: { readStatus: "fresh", entries, initialEntryId: entries[0]?.id ?? null },
    };
    const payloads: unknown[] = [];
    const interaction = (customId: string) => ({
      customId,
      guildId: "123",
      user: { id: "456" },
      memberPermissions: { has: () => true },
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      isButton: () => true,
      deferUpdate: async () => undefined,
      editReply: async (payload: unknown) => payloads.push(payload),
    });
    const route = createProvidersInteractionRoute({ resolveScope: async () => oversizedScope });
    const openId = buildProvidersRouteId(PROVIDERS_ROUTE_NAMESPACE, { action: "range-open", locale: "en-US" });
    const selectId = buildProvidersRouteId(PROVIDERS_ROUTE_NAMESPACE, {
      action: "range",
      locale: "en-US",
      rangeIndex: 1,
    });

    await route.execute({} as Client, interaction(openId) as never, parsed(openId));
    await route.execute({} as Client, interaction(selectId) as never, parsed(selectId));

    expect(JSON.stringify(payloads[0])).toContain('"label":"24-24"');
    expect(JSON.stringify(payloads[1])).toContain(
      '"value":"provider:p23","description":"Saved provider","default":true',
    );
  });

  it("rechecks guild permission before loading current scope", async () => {
    const calls: string[] = [];
    const customId = buildProvidersRouteId(PROVIDERS_ROUTE_NAMESPACE, { action: "retry", locale: "en-US" });
    const interaction = {
      customId,
      guildId: "123",
      user: { id: "456" },
      memberPermissions: { has: () => false },
      isStringSelectMenu: () => false,
      isButton: () => true,
      deferUpdate: async () => calls.push("deferUpdate"),
      editReply: async () => calls.push("editReply"),
    };
    const route = createProvidersInteractionRoute({
      resolveScope: async () => {
        calls.push("load");
        return scope;
      },
    });

    await route.execute({} as Client, interaction as never, parsed(interaction.customId));
    expect(calls).toEqual(["deferUpdate", "editReply"]);
  });

  it("defers the slash command before panel data loads", async () => {
    const calls: string[] = [];
    const interaction = {
      deferReply: async () => calls.push("deferReply"),
      editReply: async () => calls.push("editReply"),
    } as unknown as ChatInputCommandInteraction;

    await executeProvidersCommand(interaction, "en-US", async () => {
      calls.push("load");
      return { components: [], flags: 32768 };
    });
    expect(calls).toEqual(["deferReply", "load", "editReply"]);
  });

  it("records panel_action telemetry on provider operations across scopes", async () => {
    const recorded: string[] = [];
    const recordAction = (input: { action: string; serverId: number; userDiscId: string }) => {
      recorded.push(`${input.action}:${input.serverId}:${input.userDiscId}`);
    };

    // Add provider (server scope)
    const addCustomId = buildProvidersRouteId(PROVIDERS_ROUTE_NAMESPACE, {
      action: "add-submit",
      locale: "en-US",
      nonce: "nonce-12345678",
    });
    const addInteraction = {
      id: "interaction-add",
      customId: addCustomId,
      guildId: "123",
      user: { id: "user-456" },
      memberPermissions: { has: () => true },
      fields: { getTextInputValue: () => "api-key" },
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      isButton: () => false,
      deferUpdate: async () => {},
      editReply: async () => {},
    };
    const addRoute = createProvidersInteractionRoute({
      resolveScope: async () => scope,
      takeServerType: () => "google",
      operations: {
        addServerProvider: async () => ({ status: "success", entryId: "provider:google" }),
      } as never,
      recordAction,
    });
    await addRoute.execute({} as Client, addInteraction as never, parsed(addCustomId));
    expect(recorded).toContain("providers.workspace.provider.add:42:user-456");

    // Remove provider (personal scope)
    const personalScope: LoadedProviderPanelScope = {
      ...scope,
      scopeKind: "personal",
      ownerId: 77,
      routeNamespace: PERSONAL_PROVIDERS_ROUTE_NAMESPACE,
    };
    const removeCustomId = buildProvidersRouteId(PERSONAL_PROVIDERS_ROUTE_NAMESPACE, {
      action: "remove-confirm",
      locale: "en-US",
      entryKind: "provider",
      entryKey: "google",
    });
    const removeInteraction = {
      customId: removeCustomId,
      guildId: "123",
      user: { id: "user-456" },
      memberPermissions: { has: () => true },
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      isButton: () => true,
      deferUpdate: async () => {},
      editReply: async () => {},
    };
    const removeRoute = createProvidersInteractionRoute(
      {
        resolveScope: async () => personalScope,
        operations: {
          removeServerProviderEntry: async () => ({ status: "success", deletedEntryId: "provider:google" }),
        } as never,
        recordAction,
      },
      {
        namespace: PERSONAL_PROVIDERS_ROUTE_NAMESPACE,
        authorize: () => true,
        includeBrave: false,
        allowRotation: false,
      },
    );
    await removeRoute.execute({} as Client, removeInteraction as never, parsed(removeCustomId));
    expect(recorded).toContain("providers.personal.entry.remove:42:user-456");

    // Endpoint add (server scope)
    const endpointAddCustomId = buildProvidersRouteId(PROVIDERS_ROUTE_NAMESPACE, {
      action: "endpoint-submit",
      locale: "en-US",
      nonce: "nonce-12345678",
    });
    const endpointAddInteraction = {
      id: "interaction-endpoint-add",
      customId: endpointAddCustomId,
      guildId: "123",
      user: { id: "user-456" },
      memberPermissions: { has: () => true },
      fields: {
        getTextInputValue: (fieldId: string) => (fieldId.startsWith("endpoint-url") ? "https://api.example.com" : ""),
      },
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      isButton: () => false,
      deferUpdate: async () => {},
      editReply: async () => {},
    };
    const endpointAddRoute = createProvidersInteractionRoute({
      resolveScope: async () => scope,
      takeServerType: () => "custom-1",
      operations: {
        addCustomEndpointConnection: async () => ({ status: "success", entryId: "endpoint:custom-1:1" }),
      } as never,
      recordAction,
    });
    await endpointAddRoute.execute({} as Client, endpointAddInteraction as never, parsed(endpointAddCustomId));
    expect(recorded).toContain("providers.workspace.endpoint.add:42:user-456");

    // Model save (personal scope)
    const modelSaveCustomId = buildProvidersRouteId(PERSONAL_PROVIDERS_ROUTE_NAMESPACE, {
      action: "model-submit",
      locale: "en-US",
      entryKind: "provider",
      entryKey: "google",
      capability: "text",
      editingModelId: null,
      nonce: "nonce-12345678",
    });
    const modelSaveInteraction = {
      id: "interaction-model-save",
      customId: modelSaveCustomId,
      guildId: "123",
      user: { id: "user-456" },
      memberPermissions: { has: () => true },
      fields: {
        getTextInputValue: (fieldId: string) => (fieldId.startsWith("code-name") ? "gemini-pro" : ""),
      },
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      isButton: () => false,
      deferUpdate: async () => {},
      editReply: async () => {},
    };
    const modelSaveRoute = createProvidersInteractionRoute(
      {
        resolveScope: async () => personalScope,
        operations: {
          saveProviderModel: async () => ({ status: "success", entryId: "provider:google" }),
        } as never,
        recordAction,
      },
      {
        namespace: PERSONAL_PROVIDERS_ROUTE_NAMESPACE,
        authorize: () => true,
        includeBrave: false,
        allowRotation: false,
      },
    );
    await modelSaveRoute.execute({} as Client, modelSaveInteraction as never, parsed(modelSaveCustomId));
    expect(recorded).toContain("providers.personal.model.save:42:user-456");
  });
});
