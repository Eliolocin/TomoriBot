import { beforeAll, describe, expect, it } from "bun:test";
import { ComponentType } from "discord.js";
import type { ProviderPanelEntry } from "@/types/discord/providerPanel";
import { PERSONAL_PROVIDERS_ROUTE_NAMESPACE } from "@/utils/discord/providersPanelCatalog";
import {
  buildAddEndpointModal,
  buildAddProviderModal,
  buildEditEndpointModal,
  buildEditProviderModal,
  buildProviderModelModal,
  buildProvidersPanelPayload,
} from "@/utils/discord/ui/providersPanel";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

function collectComponents(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const nested = Array.isArray(record.components) ? record.components.flatMap(collectComponents) : [];
  const component = record.component ? collectComponents(record.component) : [];
  return [record, ...nested, ...component];
}

function providerEntry(id: string, name = "Google"): ProviderPanelEntry {
  return {
    id,
    kind: "provider",
    provider: name.toLowerCase(),
    displayName: name,
    savedAt: null,
    rotationKeyCount: 2,
    capabilities: [
      {
        capability: "text",
        availability: "available",
        models: [
          {
            id: 1,
            codeName: "gemini/example-model",
            isWorkspaceActive: true,
            isWorkspaceFallback: false,
            isProviderFallback: true,
            isCustomRegistration: true,
            textSettings: {
              numCtx: 8192,
              hasTools: true,
              seesImages: true,
              supportsStructOutput: false,
              strictRoleAlternation: false,
              supportsPrefixCompletion: true,
            },
          },
        ],
      },
      { capability: "image", availability: "available", models: [] },
      { capability: "embedding", availability: "available", models: [] },
      { capability: "video", availability: "available", models: [] },
      { capability: "speech", availability: "unavailable", models: [] },
      { capability: "transcription", availability: "unavailable", models: [] },
    ],
  };
}

describe("providers panel rendering", () => {
  it("builds one provider modal for curated providers, ElevenLabs, and Brave", () => {
    const modal = buildAddProviderModal("en-US", "abcdefgh");
    const serialized = JSON.stringify(modal);

    expect(modal.custom_id).toBe("providers:v1:add-submit:en-US:abcdefgh");
    expect(serialized).toContain("Google Gemini");
    expect(serialized).toContain("ElevenLabs");
    expect(serialized).toContain("Brave Search");
    expect(serialized).not.toContain('"value":"custom"');
    expect(modal.components).toHaveLength(2);
  });

  it("uses personal routes without exposing Brave or rotation controls", () => {
    const addModal = buildAddProviderModal("en-US", "abcdefgh", PERSONAL_PROVIDERS_ROUTE_NAMESPACE, false);
    const editModal = buildEditProviderModal(
      "en-US",
      "google",
      0,
      "abcdefgh",
      PERSONAL_PROVIDERS_ROUTE_NAMESPACE,
      false,
    );
    const panel = buildProvidersPanelPayload({
      locale: "en-US",
      entries: [providerEntry("provider:google")],
      initialEntryId: "provider:google",
      readStatus: "fresh",
      page: { kind: "entry" },
      enabledActions: new Set(["add-provider", "add-endpoint", "model", "edit", "remove"]),
      routeNamespace: PERSONAL_PROVIDERS_ROUTE_NAMESPACE,
      footerCommand: { root: "personal", subcommandGroup: "provider", subcommand: "model-text" },
    });

    expect(addModal.custom_id).toStartWith("personal-providers:v1:");
    expect(JSON.stringify(addModal)).not.toContain("Brave Search");
    expect(editModal.components).toHaveLength(1);
    expect(JSON.stringify(editModal)).not.toContain("rotation-key");
    expect(JSON.stringify(panel)).toContain("personal-providers:v1:");
    expect(JSON.stringify(panel)).not.toContain('"customId":"providers:v1:');
    expect(JSON.stringify(panel)).toContain("## Personal Providers");
    expect(JSON.stringify(panel)).not.toContain("## Server Providers");
  });

  it("offers every API compatibility in one valid modal", () => {
    const modal = buildAddEndpointModal("en-US", "abcdefgh");
    const serialized = JSON.stringify(modal);
    const select = collectComponents(JSON.parse(serialized) as unknown).find((component) =>
      Array.isArray(component.options),
    );

    expect(modal.custom_id).toBe("providers:v1:endpoint-submit:en-US:abcdefgh");
    expect(serialized).toContain("Endpoint Label");
    expect(serialized).toContain("It is not sent to the service.");
    expect(serialized).toContain("API Compatibility");
    expect(serialized).toContain("e.g. ollama, koboldcpp, vllm, comfyui");
    expect(serialized).toContain("request paths are appended automatically");
    expect(serialized).toContain("Use the bare Ollama root");
    expect(serialized).toContain("openai-compatible");
    expect(serialized).toContain("ollama-native");
    expect(serialized).toContain("comfyui");
    expect(serialized).toContain("tts-clone");
    expect(serialized).toContain("openai-compatible-transcription");
    expect((select?.options as unknown[])?.length).toBe(5);
  });

  it("renders an empty selector with both add destinations and a routing hint", () => {
    const payload = buildProvidersPanelPayload({
      locale: "en-US",
      entries: [],
      initialEntryId: null,
      readStatus: "fresh",
      page: { kind: "entry" },
    });
    const serialized = JSON.stringify(payload);
    const select = collectComponents(payload).find((component) => component.type === ComponentType.StringSelect);

    expect(serialized).toContain("## Server Providers");
    expect(serialized).not.toContain("## Personal Providers");
    expect(serialized).toContain("No Saved Providers");
    expect(serialized).toContain("**Select** or **add** a provider or endpoint using the dropdown below.");
    expect(serialized).toContain("+ Add New Provider");
    expect(serialized).toContain("+ Add New Custom Endpoint");
    expect(serialized).toContain("`/model text`");
    expect((select?.options as unknown[])?.length).toBe(2);
  });

  it("localizes server and personal ownership in the panel title", () => {
    const serverPanel = buildProvidersPanelPayload({
      locale: "ja",
      entries: [],
      initialEntryId: null,
      readStatus: "fresh",
      page: { kind: "entry" },
    });
    const personalPanel = buildProvidersPanelPayload({
      locale: "ja",
      entries: [],
      initialEntryId: null,
      readStatus: "fresh",
      page: { kind: "entry" },
      routeNamespace: PERSONAL_PROVIDERS_ROUTE_NAMESPACE,
    });

    expect(JSON.stringify(serverPanel)).toContain("## サーバープロバイダー");
    expect(JSON.stringify(personalPanel)).toContain("## 個人プロバイダー");
  });

  it("renders all provider capabilities in one body display with workspace-derived markers", () => {
    const entry = providerEntry("provider:google");
    const payload = buildProvidersPanelPayload({
      locale: "en-US",
      entries: [entry],
      initialEntryId: entry.id,
      readStatus: "fresh",
      page: { kind: "entry" },
    });
    const textDisplays = collectComponents(payload).filter((component) => component.type === ComponentType.TextDisplay);
    const body = textDisplays.find((component) => String(component.content).includes("**Text**"));
    const actions = collectComponents(payload).filter((component) => component.type === ComponentType.Button);

    expect(String(body?.content)).toContain("**Transcription**");
    expect(String(body?.content)).toContain("workspace active");
    expect(String(body?.content)).toContain("provider fallback");
    expect(String(body?.content)).toContain("custom registration");
    expect(String(body?.content)).not.toContain("unverified");
    expect(String(body?.content)).not.toContain("Workspace ID");
    expect(String(body?.content)).not.toContain("### Google");
    expect(actions.filter((action) => action.label !== "Retry").every((action) => action.disabled === true)).toBe(true);
  });

  it("renders endpoint and Brave pages without exposing endpoint internals", () => {
    const endpoint: ProviderPanelEntry = {
      id: "endpoint:41",
      kind: "endpoint",
      displayName: "lighthouse",
      savedAt: null,
      connectionIds: [41],
      isPreset: false,
      connectionDetails: [
        {
          connectionId: 41,
          endpointUrl: "https://models.example.com/v1",
          apiStyle: "openai-compatible",
        },
      ],
      capabilities: [
        {
          capability: "text",
          availability: "available",
          models: [
            {
              id: 9,
              codeName: "llama3.1:8b-instruct-q4_K_M",
              isWorkspaceActive: false,
              isWorkspaceFallback: false,
              isProviderFallback: false,
              isCustomRegistration: true,
            },
          ],
        },
      ],
    };
    const brave: ProviderPanelEntry = {
      id: "brave",
      kind: "brave",
      displayName: "Brave Search",
      savedAt: null,
    };
    const endpointPayload = JSON.stringify(
      buildProvidersPanelPayload({
        locale: "en-US",
        entries: [endpoint, brave],
        initialEntryId: endpoint.id,
        readStatus: "fresh",
        page: { kind: "entry", entryId: endpoint.id },
      }),
    );
    const bravePayload = JSON.stringify(
      buildProvidersPanelPayload({
        locale: "en-US",
        entries: [endpoint, brave],
        initialEntryId: endpoint.id,
        readStatus: "fresh",
        page: { kind: "entry", entryId: brave.id },
      }),
    );

    expect(endpointPayload).toContain("llama3.1:8b-instruct-q4_K_M");
    expect(endpointPayload).not.toContain("connectionIds");
    expect(endpointPayload).not.toContain("custom:41");
    expect(endpointPayload).not.toContain("### lighthouse");
    expect(bravePayload).toContain("API key configured");
    expect(bravePayload).not.toContain("Add or Edit a Model");
    expect(bravePayload).not.toContain("### Brave Search");
  });

  it("disables navigation and exposes Retry when reads are stale", () => {
    const entry = providerEntry("provider:google");
    const payload = buildProvidersPanelPayload({
      locale: "en-US",
      entries: [entry],
      initialEntryId: entry.id,
      readStatus: "stale",
      page: { kind: "entry" },
    });
    const select = collectComponents(payload).find((component) => component.type === ComponentType.StringSelect);
    const serialized = JSON.stringify(payload);

    expect(select?.disabled).toBe(true);
    expect(serialized).toContain("Retry");
    expect(serialized).toContain("Saved data may be out of date");
  });

  it("pages saved entries at 23 so the two add actions always fit", () => {
    const entries = Array.from({ length: 24 }, (_, index) => providerEntry(`provider:p${index}`, `Provider ${index}`));
    const firstPage = buildProvidersPanelPayload({
      locale: "en-US",
      entries,
      initialEntryId: entries[0]?.id ?? null,
      readStatus: "fresh",
      page: { kind: "entry" },
      rangeIndex: 0,
    });
    const secondPage = buildProvidersPanelPayload({
      locale: "en-US",
      entries,
      initialEntryId: entries[23]?.id ?? null,
      readStatus: "fresh",
      page: { kind: "entry", entryId: entries[23]?.id },
      rangeIndex: 1,
    });
    const firstSelect = collectComponents(firstPage).find((component) => component.type === ComponentType.StringSelect);
    const secondSelect = collectComponents(secondPage).find(
      (component) => component.type === ComponentType.StringSelect,
    );

    expect((firstSelect?.options as unknown[])?.length).toBe(25);
    expect((secondSelect?.options as unknown[])?.length).toBe(3);
    expect(JSON.stringify(firstPage)).toContain("providers:v1:range-open:en-US");
    expect(JSON.stringify(secondPage)).toContain("Provider 23");

    const chooser = buildProvidersPanelPayload({
      locale: "en-US",
      entries,
      initialEntryId: entries[0]?.id ?? null,
      readStatus: "fresh",
      page: { kind: "entry-chooser" },
    });
    const chooserJson = JSON.stringify(chooser);
    expect(chooserJson).toContain("Select Page");
    expect(chooserJson).toContain('"label":"1-23"');
    expect(chooserJson).toContain('"label":"24-24"');
    expect(chooserJson).toContain("providers:v1:range-cancel:en-US");
  });

  it("opens the selector range containing the initial active entry", () => {
    const entries = Array.from({ length: 24 }, (_, index) => providerEntry(`provider:p${index}`, `Provider ${index}`));
    const activeEntry = entries[23];
    if (!activeEntry) throw new Error("Expected active provider fixture");
    const payload = buildProvidersPanelPayload({
      locale: "en-US",
      entries,
      initialEntryId: activeEntry.id,
      readStatus: "fresh",
      page: { kind: "entry" },
    });
    const select = collectComponents(payload).find((component) => component.type === ComponentType.StringSelect);
    const options = select?.options as Array<{ label: string; value: string; default?: boolean }>;

    expect(options).toHaveLength(3);
    expect(options[2]).toMatchObject({ value: activeEntry.id, default: true });
  });

  it("lists model-add actions first and keeps the parent provider selected", () => {
    const entry = providerEntry("provider:google");
    if (entry.kind !== "provider") throw new Error("Expected provider fixture");
    const text = entry.capabilities[0];
    if (!text) throw new Error("Expected text capability fixture");
    text.models = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      codeName: `custom/model-${index + 1}`,
      isWorkspaceActive: false,
      isWorkspaceFallback: false,
      isProviderFallback: false,
      isCustomRegistration: true,
    }));
    const first = buildProvidersPanelPayload({
      locale: "en-US",
      entries: [entry],
      initialEntryId: entry.id,
      readStatus: "fresh",
      page: { kind: "models", entryId: entry.id, rangeIndex: 0 },
    });
    const second = buildProvidersPanelPayload({
      locale: "en-US",
      entries: [entry],
      initialEntryId: entry.id,
      readStatus: "fresh",
      page: { kind: "models", entryId: entry.id, rangeIndex: 1 },
    });
    const firstSelect = collectComponents(first).find(
      (component) =>
        component.type === ComponentType.StringSelect && String(component.customId).includes("model-select"),
    );
    const secondSelect = collectComponents(second).find(
      (component) =>
        component.type === ComponentType.StringSelect && String(component.customId).includes("model-select"),
    );
    const firstOptions = firstSelect?.options as Array<{ description?: string; label: string; value: string }>;
    const secondOptions = secondSelect?.options as Array<{ label: string; value: string }>;

    expect(firstOptions).toHaveLength(25);
    expect(firstOptions.slice(0, 6).map((option) => option.value)).toEqual([
      "add:text",
      "add:image",
      "add:embedding",
      "add:video",
      "add:speech",
      "add:transcription",
    ]);
    expect(firstOptions[6]?.value).toBe("edit:text:1");
    expect(firstOptions[6]?.description).toBe("Text · custom registration");
    expect(secondOptions).toHaveLength(7);
    expect(secondOptions[6]?.value).toBe("edit:text:20");

    const panelSelect = collectComponents(first).find(
      (component) =>
        component.type === ComponentType.StringSelect && !String(component.customId).includes("model-select"),
    );
    const panelOptions = panelSelect?.options as Array<{ value: string; default?: boolean }>;
    expect(panelOptions.find((option) => option.default)?.value).toBe(entry.id);
  });

  it("uses placeholders for create codenames and capability-specific modal fields", () => {
    const textModal = buildProviderModelModal("en-US", "provider", "google", "text", null, "abcdefgh");
    const endpointTextModal = buildProviderModelModal("en-US", "endpoint", "73", "text", null, "abcdefgh");
    const imageModal = buildProviderModelModal("en-US", "endpoint", "73", "image", null, "abcdefgh");
    const codeInput = textModal.components[0]?.component;

    expect(codeInput?.placeholder).toBe("anthropic/claude-4-sonnet");
    expect(codeInput?.value).toBeUndefined();
    expect(JSON.stringify(textModal)).toContain("flags_abcdefgh");
    expect(JSON.stringify(textModal)).not.toContain("num-ctx_abcdefgh");
    expect(JSON.stringify(endpointTextModal)).toContain("num-ctx_abcdefgh");
    expect(JSON.stringify(imageModal)).toContain("workflow_abcdefgh");
    expect(imageModal.custom_id).toBe("providers:v1:model-submit:en-US:endpoint:73:image:0:abcdefgh");
  });

  it("renders provider editing with per-provider rotation controls while Brave stays key-only", () => {
    const providerModal = buildEditProviderModal("en-US", "google", 3, "abcdefgh");
    const braveModal = buildEditProviderModal("en-US", "brave", 0, "abcdefgh");
    const providerJson = JSON.stringify(providerModal);

    expect(providerModal.components).toHaveLength(3);
    expect(providerJson).toContain("3 additional rotation key(s)");
    expect(providerJson).toContain('"value":"keep"');
    expect(providerJson).toContain('"value":"delete"');
    expect(braveModal.components).toHaveLength(1);
    expect(JSON.stringify(braveModal)).not.toContain("rotation-key");
  });

  it("prefills editable endpoint metadata without exposing credentials", () => {
    const modal = buildEditEndpointModal(
      "en-US",
      {
        connectionId: 41,
        label: "lighthouse",
        endpointUrl: "https://models.example.com/v1",
        apiStyles: ["openai-compatible"],
        isPreset: false,
      },
      "abcdefgh",
    );
    const json = JSON.stringify(modal);

    expect(json).toContain('"value":"lighthouse"');
    expect(json).toContain('"value":"https://models.example.com/v1"');
    expect(json).toContain("Endpoint Label");
    expect(json).toContain("It is not sent to the service.");
    expect(modal.components[1]?.component?.required).toBe(true);
    expect(json).toContain("edit-auth-token_abcdefgh");
    expect(json).not.toContain("stored-secret");
  });

  it("renders preset endpoint connection metadata as read-only", () => {
    const modal = buildEditEndpointModal(
      "en-US",
      {
        connectionId: 51,
        label: "elevenlabs",
        endpointUrl: "https://api.elevenlabs.io",
        apiStyles: ["elevenlabs", "elevenlabs-transcription"],
        isPreset: true,
      },
      "abcdefgh",
    );
    const json = JSON.stringify(modal);

    expect(modal.components).toHaveLength(2);
    expect(modal.components[0]?.type).toBe(ComponentType.TextDisplay);
    expect(json).toContain("https://api.elevenlabs.io");
    expect(json).toContain("elevenlabs-transcription");
    expect(json).not.toContain("edit-label_abcdefgh");
    expect(json).not.toContain("edit-url_abcdefgh");
    expect(json).toContain("edit-auth-token_abcdefgh");
  });

  it("names the durable target and impact before enabling provider removal", () => {
    const entry = providerEntry("provider:google");
    const payload = buildProvidersPanelPayload({
      locale: "en-US",
      entries: [entry],
      initialEntryId: entry.id,
      readStatus: "fresh",
      page: { kind: "remove", entryId: entry.id },
      enabledActions: new Set(["remove"]),
    });
    const json = JSON.stringify(payload);

    expect(json).toContain("Remove saved entry?");
    expect(json).toContain("Google");
    expect(json).toContain("encrypted credential");
    expect(json).toContain("Continue and Remove");
    expect(json).toContain("remove-confirm:en-US:provider:google");
    expect(json).toContain("remove-cancel:en-US:provider:google");
  });
});
