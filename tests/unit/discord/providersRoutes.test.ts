import { beforeAll, describe, expect, it } from "bun:test";
import type { ChatInputCommandInteraction, Client } from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import type { LoadedProviderPanelScope } from "@/utils/provider/providerPanelOperations";
import { executeProvidersCommand } from "@/commands/providers";
import { createProvidersInteractionRoute } from "@/utils/discord/interactions/providersRoutes";
import { parseInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import {
  buildProvidersCustomId,
  buildProvidersCustomIdForNamespace,
  parseProvidersPanelRoute,
  PERSONAL_PROVIDERS_ROUTE_NAMESPACE,
} from "@/utils/discord/providersPanelCatalog";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const scope: LoadedProviderPanelScope = {
  state: {} as TomoriState,
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
  it("keeps personal interactions unrestricted and marked as personal writes", async () => {
    const calls: string[] = [];
    const customId = buildProvidersCustomIdForNamespace(
      PERSONAL_PROVIDERS_ROUTE_NAMESPACE,
      "edit-provider-submit",
      "en-US",
      "google",
      "abcdefgh",
    );
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

  it("parses only supported locale, action, and range shapes", () => {
    expect(parseProvidersPanelRoute(parsed(buildProvidersCustomId("select", "en-US")))).toEqual({
      action: "select",
      locale: "en-US",
    });
    expect(parseProvidersPanelRoute(parsed(buildProvidersCustomId("range", "en-US", 2)))).toEqual({
      action: "range",
      locale: "en-US",
      rangeIndex: 2,
    });
    expect(parseProvidersPanelRoute(parsed(buildProvidersCustomId("range-open", "en-US")))).toEqual({
      action: "range-open",
      locale: "en-US",
    });
    expect(parseProvidersPanelRoute(parsed(buildProvidersCustomId("range-page", "en-US", 2)))).toEqual({
      action: "range-page",
      locale: "en-US",
      rangeIndex: 2,
    });
    expect(parseProvidersPanelRoute(parsed(buildProvidersCustomId("range-cancel", "en-US")))).toEqual({
      action: "range-cancel",
      locale: "en-US",
    });
    expect(parseProvidersPanelRoute(parsed("providers:v1:range:en-US:-1"))).toBeNull();
    expect(parseProvidersPanelRoute(parsed("providers:v1:select:xx"))).toBeNull();
    expect(parseProvidersPanelRoute(parsed("providers:v1:unknown:en-US"))).toBeNull();
    expect(parseProvidersPanelRoute(parsed(buildProvidersCustomId("add-submit", "en-US", "abcdefgh")))).toEqual({
      action: "add-submit",
      locale: "en-US",
      nonce: "abcdefgh",
    });
    expect(parseProvidersPanelRoute(parsed(buildProvidersCustomId("endpoint-submit", "en-US", "abcdefgh")))).toEqual({
      action: "endpoint-submit",
      locale: "en-US",
      nonce: "abcdefgh",
    });
    expect(
      parseProvidersPanelRoute(parsed(buildProvidersCustomId("model-open", "en-US", "provider", "google"))),
    ).toEqual({ action: "model-open", locale: "en-US", entryKind: "provider", entryKey: "google" });
    expect(
      parseProvidersPanelRoute(
        parsed(buildProvidersCustomId("model-submit", "en-US", "endpoint", 73, "image", 9, "abcdefgh")),
      ),
    ).toEqual({
      action: "model-submit",
      locale: "en-US",
      entryKind: "endpoint",
      entryKey: "73",
      capability: "image",
      editingModelId: 9,
      nonce: "abcdefgh",
    });
    expect(
      parseProvidersPanelRoute(parsed(buildProvidersCustomId("edit-provider-open", "en-US", "google", 2))),
    ).toEqual({ action: "edit-provider-open", locale: "en-US", provider: "google", rotationKeyCount: 2 });
    expect(
      parseProvidersPanelRoute(parsed(buildProvidersCustomId("edit-provider-submit", "en-US", "google", "abcdefgh"))),
    ).toEqual({ action: "edit-provider-submit", locale: "en-US", provider: "google", nonce: "abcdefgh" });
    expect(parseProvidersPanelRoute(parsed(buildProvidersCustomId("edit-endpoint-open", "en-US", 73)))).toEqual({
      action: "edit-endpoint-open",
      locale: "en-US",
      connectionId: 73,
    });
    expect(
      parseProvidersPanelRoute(parsed(buildProvidersCustomId("edit-endpoint-submit", "en-US", 73, "abcdefgh"))),
    ).toEqual({ action: "edit-endpoint-submit", locale: "en-US", connectionId: 73, nonce: "abcdefgh" });
    expect(
      parseProvidersPanelRoute(parsed(buildProvidersCustomId("remove-confirm", "en-US", "provider", "google"))),
    ).toEqual({ action: "remove-confirm", locale: "en-US", entryKind: "provider", entryKey: "google" });
    expect(
      parseProvidersPanelRoute(parsed(buildProvidersCustomId("remove-prompt", "en-US", "brave", "brave"))),
    ).toEqual({ action: "remove-prompt", locale: "en-US", entryKind: "brave", entryKey: "brave" });
  });

  it("opens Edit Provider directly with the provider-scoped rotation count", async () => {
    const calls: string[] = [];
    const customId = buildProvidersCustomId("edit-provider-open", "en-US", "google", 2);
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
    const customId = buildProvidersCustomId("edit-endpoint-open", "en-US", 73);
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
    const customId = buildProvidersCustomId("edit-provider-submit", "en-US", "google", "abcdefgh");
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
    const customId = buildProvidersCustomId("remove-confirm", "en-US", "provider", "google");
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
      customId: buildProvidersCustomId("select", "en-US"),
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
    const customId = buildProvidersCustomId("add-submit", "en-US", "abcdefgh");
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
    const customId = buildProvidersCustomId("select", "en-US");
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
    const customId = buildProvidersCustomId("model-select", "en-US", "provider", "google");
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

    // The cached read precedes the modal, but the modal is still the acknowledgement: no deferral.
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
    const customId = buildProvidersCustomId("model-submit", "en-US", "provider", "google", "text", 0, "abcdefgh");
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
    const customId = buildProvidersCustomId("model-select", "en-US", "endpoint", "73");
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
    const customId = buildProvidersCustomId("model-submit", "en-US", "endpoint", 73, "image", 0, "abcdefgh");
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
    const interaction = {
      customId: buildProvidersCustomId("select", "en-US"),
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
    const customId = buildProvidersCustomId("model-submit", "en-US", "provider", "openrouter", "text", 91, "abcdefgh");
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
      // OpenRouter never renders the compatibility group, so nothing is submitted for it.
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
    const customId = buildProvidersCustomId("model-submit", "en-US", "endpoint", 73, "text", 0, "abcdefgh");
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
    const customId = buildProvidersCustomId("model-select", "en-US", "endpoint", "73");
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
    const customId = buildProvidersCustomId("model-submit", "en-US", "endpoint", 73, "speech", 0, "abcdefgh");
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
    const customId = buildProvidersCustomId("model-select", "en-US", "endpoint", "73");
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
    const customId = buildProvidersCustomId("model-range", "en-US", "provider", "google", 1);
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
    // The models live on the entry page now, so its own actions render alongside them.
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
    const openId = buildProvidersCustomId("range-open", "en-US");
    const selectId = buildProvidersCustomId("range", "en-US", 1);

    await route.execute({} as Client, interaction(openId) as never, parsed(openId));
    await route.execute({} as Client, interaction(selectId) as never, parsed(selectId));

    expect(JSON.stringify(payloads[0])).toContain('"label":"24-24"');
    expect(JSON.stringify(payloads[1])).toContain(
      '"value":"provider:p23","description":"Saved provider","default":true',
    );
  });

  it("rechecks guild permission before loading current scope", async () => {
    const calls: string[] = [];
    const interaction = {
      customId: buildProvidersCustomId("retry", "en-US"),
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
});
