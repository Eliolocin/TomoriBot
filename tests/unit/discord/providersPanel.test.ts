import { beforeAll, describe, expect, it } from "bun:test";
import { ComponentType } from "discord.js";
import type { ProviderPanelEntry } from "@/types/discord/providerPanel";
import { parseProvidersPanelRoute, PERSONAL_PROVIDERS_ROUTE_NAMESPACE } from "@/utils/discord/providersPanelCatalog";
import { parseInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import {
  buildAddEndpointModal,
  buildAddProviderModal,
  buildEditEndpointModal,
  buildEditProviderModal,
  buildModelSelectionValue,
  buildProviderModelModal,
  offeredChatCompatFlags,
  parseModelSelectionValue,
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
    expect(JSON.stringify(panel)).toContain("`/personal config` > Models");
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
    expect(serialized).toContain("**Select** or **add** a provider or endpoint");
    expect(serialized).toContain("+ Add New Provider");
    expect(serialized).toContain("+ Add New Custom Endpoint");
    expect(serialized).toContain("`/config` > Models");
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

  it("renders only populated capability sections with workspace-derived markers", () => {
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

    expect(String(body?.content)).toContain("currently active");
    expect(String(body?.content)).toContain("provider fallback");
    expect(String(body?.content)).toContain("custom registration");
    expect(String(body?.content)).toContain("Use the dropdown below to add or edit a model capability:");
    expect(String(body?.content)).not.toContain("**Image**");
    expect(String(body?.content)).not.toContain("**Transcription**");
    expect(String(body?.content)).not.toContain("No models are registered");
    expect(String(body?.content)).not.toContain("unverified");
    expect(String(body?.content)).not.toContain("Workspace ID");
    expect(String(body?.content)).not.toContain("### Google");
    expect(actions.filter((action) => action.label !== "Retry").every((action) => action.disabled === true)).toBe(true);
    expect(actions.map((action) => action.label)).toContain("Remove Provider");
  });

  it("states absence once when an entry has no registered models at all", () => {
    const entry = providerEntry("provider:google");
    if (entry.kind !== "provider") throw new Error("Expected provider fixture");
    for (const section of entry.capabilities) section.models = [];
    const payload = buildProvidersPanelPayload({
      locale: "en-US",
      entries: [entry],
      initialEntryId: entry.id,
      readStatus: "fresh",
      page: { kind: "entry" },
    });
    const body = collectComponents(payload)
      .filter((component) => component.type === ComponentType.TextDisplay)
      .find((component) => String(component.content).includes("No models are registered here yet."));

    expect(body).toBeDefined();
    expect(String(body?.content)).not.toContain("**Text**");
    expect(String(body?.content).match(/No models are registered/g)).toHaveLength(1);
    expect(String(body?.content)).toContain("Use the dropdown below to add or edit a model capability:");
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
    expect(endpointPayload).toContain("Remove Endpoint");
    expect(bravePayload).toContain("API key configured");
    expect(bravePayload).toContain("Remove Key");
    expect(bravePayload).not.toContain("model-select");
    expect(bravePayload).not.toContain("Use the dropdown below to add or edit a model capability:");
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
    expect(JSON.stringify(firstPage)).toContain('"label":"← Previous"');
    expect(JSON.stringify(firstPage)).toContain('"label":"Page 1 of 2"');
    expect(JSON.stringify(firstPage)).toContain('"label":"Next →"');
    expect(JSON.stringify(firstPage)).not.toContain("providers:v1:range-open:en-US");
    expect(JSON.stringify(secondPage)).toContain("Provider 23");
  });

  it("renders one shared row directly below each provider select with stable entry bodies", () => {
    const entries = Array.from({ length: 46 }, (_, index) => {
      const entry = providerEntry(`provider:p${index}`, `Provider ${index}`);
      if (entry.kind === "provider") {
        const textCapability = entry.capabilities[0];
        const model = textCapability?.models[0];
        if (textCapability && model) textCapability.models[0] = { ...model, codeName: `custom/provider-${index}` };
      }
      return entry;
    });

    for (const routeNamespace of ["providers", PERSONAL_PROVIDERS_ROUTE_NAMESPACE] as const) {
      const firstPage = buildProvidersPanelPayload({
        locale: "en-US",
        entries,
        initialEntryId: entries[0]?.id ?? null,
        readStatus: "fresh",
        page: { kind: "entry", entryId: entries[0]?.id },
        rangeIndex: 0,
        routeNamespace,
      });
      const secondPage = buildProvidersPanelPayload({
        locale: "en-US",
        entries,
        initialEntryId: entries[0]?.id ?? null,
        readStatus: "fresh",
        page: { kind: "entry", entryId: entries[23]?.id },
        rangeIndex: 1,
        routeNamespace,
      });

      const getRows = (payload: ReturnType<typeof buildProvidersPanelPayload>) => {
        const container = payload.components.find((component) => component.type === ComponentType.Container) as {
          components: Array<{ type: number; components?: Array<Record<string, unknown>> }>;
        };
        return container.components.filter((component) => component.type === ComponentType.ActionRow);
      };
      const firstRows = getRows(firstPage);
      const secondRows = getRows(secondPage);
      const firstPagination = firstRows[1]?.components ?? [];
      const secondPagination = secondRows[1]?.components ?? [];

      expect(firstRows[1]?.components).toHaveLength(3);
      expect(firstPagination.map((button) => button.label)).toEqual(["← Previous", "Page 1 of 2", "Next →"]);
      expect(firstPagination.map((button) => button.disabled)).toEqual([true, true, false]);
      expect(secondPagination.map((button) => button.label)).toEqual(["← Previous", "Page 2 of 2", "Next →"]);
      expect(secondPagination.map((button) => button.disabled)).toEqual([false, true, true]);
      expect(firstRows[0]?.components?.[0]?.type).toBe(ComponentType.StringSelect);
      expect(firstRows[1]?.components?.[0]?.customId).toBe(`${routeNamespace}:v1:range:en-US:0`);
      expect(firstRows[1]?.components?.[2]?.customId).toBe(`${routeNamespace}:v1:range:en-US:1`);
      expect(JSON.stringify(firstPage)).toContain("custom/provider-0");
      expect(JSON.stringify(firstPage)).not.toContain("custom/provider-23");
      expect(JSON.stringify(secondPage)).toContain("custom/provider-23");
      expect(JSON.stringify(secondPage)).not.toContain("custom/provider-0");
      expect(JSON.stringify(secondPage)).not.toContain("range-open");

      const nextRoute = parseInteractionRoute(String(firstPagination[2]?.customId));
      expect(nextRoute && parseProvidersPanelRoute(nextRoute, routeNamespace)).toEqual({
        action: "range",
        locale: "en-US",
        rangeIndex: 1,
      });
    }
  });

  it("disables directional provider pagination controls on stale reads", () => {
    const entries = Array.from({ length: 24 }, (_, index) => providerEntry(`provider:p${index}`, `Provider ${index}`));
    const payload = buildProvidersPanelPayload({
      locale: "en-US",
      entries,
      initialEntryId: entries[0]?.id ?? null,
      readStatus: "stale",
      page: { kind: "entry" },
    });
    const container = payload.components.find((component) => component.type === ComponentType.Container) as {
      components: Array<{ type: number; components?: Array<{ disabled?: boolean }> }>;
    };
    const pagination = container.components.find(
      (component) => component.type === ComponentType.ActionRow && component.components?.length === 3,
    );
    expect(pagination?.components?.map((button) => button.disabled)).toEqual([true, true, true]);
  });

  it("renders one shared pagination row for large saved-entry catalogs", () => {
    const entries = Array.from({ length: 116 }, (_, index) => providerEntry(`provider:p${index}`, `Provider ${index}`));
    const payload = buildProvidersPanelPayload({
      locale: "en-US",
      entries,
      initialEntryId: entries[0]?.id ?? null,
      readStatus: "fresh",
      page: { kind: "entry" },
      rangeIndex: 0,
    });

    const container = payload.components.find((component) => component.type === ComponentType.Container) as {
      components: Array<{ type: number; components?: Array<{ label?: string; customId?: string }> }>;
    };
    const rows = container.components.filter((component) => component.type === ComponentType.ActionRow);
    const pagination = rows[1]?.components ?? [];
    expect(pagination.map((button) => button.label)).toEqual(["← Previous", "Page 1 of 6", "Next →"]);
    expect(pagination[0]?.customId).toBe("providers:v1:range:en-US:0");
    expect(pagination[2]?.customId).toBe("providers:v1:range:en-US:1");
    expect(JSON.stringify(payload)).not.toContain("providers:v1:range-open:en-US");
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

  it("lists exposed model-add actions first on the entry page and keeps the provider selected", () => {
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
      page: { kind: "entry", entryId: entry.id, modelRangeIndex: 0 },
    });
    const second = buildProvidersPanelPayload({
      locale: "en-US",
      entries: [entry],
      initialEntryId: entry.id,
      readStatus: "fresh",
      page: { kind: "entry", entryId: entry.id, modelRangeIndex: 1 },
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

    // The fixture marks speech and transcription unavailable, so neither may be offered as a modal
    // target: both would fail at the write with `unsupported-capability`.
    expect(firstOptions.slice(0, 4).map((option) => option.value)).toEqual([
      "add:text",
      "add:image",
      "add:embedding",
      "add:video",
    ]);
    expect(firstOptions.map((option) => option.value)).not.toContain("add:speech");
    expect(firstOptions.map((option) => option.value)).not.toContain("add:transcription");
    expect(firstOptions).toHaveLength(23);
    expect(firstOptions.length).toBeLessThanOrEqual(25);
    expect(firstOptions[4]?.value).toBe("edit:text:1");
    expect(firstOptions[4]?.description).toBe("Text · custom registration");
    expect(secondOptions).toHaveLength(5);
    expect(secondOptions[4]?.value).toBe("edit:text:20");

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
    expect(JSON.stringify(textModal)).not.toContain("compat_abcdefgh");
    expect(JSON.stringify(textModal)).not.toContain("num-ctx_abcdefgh");
    expect(JSON.stringify(endpointTextModal)).toContain("num-ctx_abcdefgh");
    expect(JSON.stringify(imageModal)).toContain("workflow_abcdefgh");
    expect(imageModal.custom_id).toBe("providers:v1:model-submit:en-US:endpoint:73:image:0:abcdefgh");
  });

  it("offers image capability checkboxes and gates inpainting on ComfyUI", () => {
    const comfyModal = buildProviderModelModal("en-US", "endpoint", "73", "image", null, "abcdefgh", {
      image: { supports: { txt2img: true, img2img: true, inpaint: true, negative_prompt: false }, allowInpaint: true },
    });
    const genericModal = buildProviderModelModal("en-US", "endpoint", "73", "image", null, "abcdefgh", {
      image: {
        supports: { txt2img: true, img2img: false, inpaint: false, negative_prompt: true },
        allowInpaint: false,
      },
    });
    const videoModal = buildProviderModelModal("en-US", "endpoint", "73", "video", null, "abcdefgh");
    const curatedModal = buildProviderModelModal("en-US", "provider", "google", "image", null, "abcdefgh", {
      image: { supports: { txt2img: true, img2img: true, inpaint: false, negative_prompt: false }, allowInpaint: true },
    });
    const undeclarableModal = buildProviderModelModal("en-US", "provider", "novelai", "image", null, "abcdefgh");

    const comfyField = comfyModal.components.find(
      (entry) => entry.component?.custom_id === "image-supports_abcdefgh",
    )?.component;
    const genericField = genericModal.components.find(
      (entry) => entry.component?.custom_id === "image-supports_abcdefgh",
    )?.component;

    expect(comfyField?.options?.map((option) => option.value)).toEqual([
      "txt2img",
      "img2img",
      "inpaint",
      "negative_prompt",
    ]);
    expect(comfyField?.options?.filter((option) => option.default).map((option) => option.value)).toEqual([
      "txt2img",
      "img2img",
      "inpaint",
    ]);
    expect(genericField?.options?.map((option) => option.value)).toEqual(["txt2img", "img2img", "negative_prompt"]);
    expect(genericField?.options?.filter((option) => option.default).map((option) => option.value)).toEqual([
      "txt2img",
      "negative_prompt",
    ]);
    expect(JSON.stringify(videoModal)).not.toContain("image-supports_abcdefgh");

    // A curated provider offers inpainting as a declaration, unticked by default.
    const curatedField = curatedModal.components.find(
      (entry) => entry.component?.custom_id === "image-supports_abcdefgh",
    )?.component;
    expect(curatedField?.options?.map((option) => option.value)).toEqual([
      "txt2img",
      "img2img",
      "inpaint",
      "negative_prompt",
    ]);
    expect(curatedField?.options?.filter((option) => option.default).map((option) => option.value)).toEqual([
      "txt2img",
      "img2img",
    ]);

    // Nothing stores a declaration for a provider whose image path ignores it, so no section renders.
    expect(JSON.stringify(undeclarableModal)).not.toContain("image-supports_abcdefgh");
  });

  it("separates chat-completion compatibility from what the model can actually do", () => {
    const endpointModal = buildProviderModelModal("en-US", "endpoint", "73", "text", null, "abcdefgh");
    const capabilities = endpointModal.components.find(
      (entry) => entry.component?.custom_id === "flags_abcdefgh",
    )?.component;
    const compat = endpointModal.components.find(
      (entry) => entry.component?.custom_id === "compat_abcdefgh",
    )?.component;

    expect(capabilities?.options?.map((option) => option.value)).toEqual(["tools", "images", "structured"]);
    expect(compat?.options?.map((option) => option.value)).toEqual(["strict-roles", "prefix"]);
    expect(JSON.stringify(endpointModal)).toContain("Chat Completion Compatibilities");
    // Every option says what it does and when to tick it.
    expect(compat?.options?.every((option) => (option.description?.length ?? 0) > 0)).toBe(true);
    expect(capabilities?.options?.every((option) => (option.description?.length ?? 0) > 0)).toBe(true);
    expect(JSON.stringify(endpointModal)).toContain("a proxy fronting Claude");
  });

  it("offers each compatibility only where the request path can honour it", () => {
    // Endpoints resolve through the `custom` provider's OpenAI-compatible adapter, which reads both.
    expect(offeredChatCompatFlags("endpoint", "73")).toEqual(["strict-roles", "prefix"]);
    expect(offeredChatCompatFlags("provider", "nvidia")).toEqual(["strict-roles", "prefix"]);
    // DeepSeek and Z.ai force prefix completion on regardless of the column, so the toggle is inert.
    expect(offeredChatCompatFlags("provider", "deepseek")).toEqual(["strict-roles"]);
    expect(offeredChatCompatFlags("provider", "zai")).toEqual(["strict-roles"]);
    // Anthropic forces alternation and never reads prefix; the rest never read either column.
    expect(offeredChatCompatFlags("provider", "anthropic")).toEqual([]);
    expect(offeredChatCompatFlags("provider", "openrouter")).toEqual([]);
    expect(offeredChatCompatFlags("provider", "google")).toEqual([]);
    expect(offeredChatCompatFlags("provider", "novelai")).toEqual([]);
  });

  it("renders no compatibility group for a provider that cannot honour either flag", () => {
    const json = JSON.stringify(buildProviderModelModal("en-US", "provider", "openrouter", "text", null, "abcdefgh"));
    expect(json).toContain("flags_abcdefgh");
    expect(json).not.toContain("compat_abcdefgh");
    expect(json).not.toContain("Chat Completion Compatibilities");
  });

  it("asks a clone server for its voice mode, markup, and instruct support", () => {
    const modal = buildProviderModelModal("en-US", "endpoint", "73", "speech", null, "abcdefgh", {
      speech: {
        settings: { voiceMode: "auto", scriptMarkup: "emoji", supportsInstruct: true },
        allowVoiceMode: true,
      },
    });
    const json = JSON.stringify(modal);
    const field = (id: string) => modal.components.find((entry) => entry.component?.custom_id === id)?.component;

    expect(modal.components).toHaveLength(4);
    expect(field("voice-mode_abcdefgh")?.options?.map((option) => option.value)).toEqual([
      "clone",
      "voice-design",
      "auto",
    ]);
    expect(field("voice-mode_abcdefgh")?.options?.find((option) => option.default)?.value).toBe("auto");
    expect(field("script-markup_abcdefgh")?.options?.find((option) => option.default)?.value).toBe("emoji");
    expect(field("supports-instruct_abcdefgh")?.options?.[0]?.default).toBe(true);

    // Every choice explains when to pick it, which is the whole point of splitting these out.
    expect(json).toContain("Pick this for --mode auto.");
    expect(json).toContain("Strip every cue.");
    expect(json).toContain("/config");
  });

  it("omits the clone-only controls for a preset endpoint that has no voice-mode split", () => {
    const modal = buildProviderModelModal("en-US", "endpoint", "51", "speech", null, "abcdefgh", {
      speech: {
        settings: { voiceMode: "clone", scriptMarkup: "bracket-tags", supportsInstruct: false },
        allowVoiceMode: false,
      },
    });
    const json = JSON.stringify(modal);

    expect(modal.components).toHaveLength(2);
    expect(json).not.toContain("voice-mode_abcdefgh");
    expect(json).not.toContain("supports-instruct_abcdefgh");
    expect(json).toContain("script-markup_abcdefgh");
  });

  it("renders no speech controls when nothing resolved stored settings", () => {
    const modal = buildProviderModelModal("en-US", "endpoint", "73", "speech", null, "abcdefgh");
    expect(modal.components).toHaveLength(1);
  });

  it("prefills an edit modal from the model the selector names", () => {
    const editModal = buildProviderModelModal("en-US", "endpoint", "73", "text", 91, "abcdefgh", {
      codeName: "lighthouse/model",
      text: {
        numCtx: 4096,
        hasTools: true,
        seesImages: false,
        supportsStructOutput: false,
        strictRoleAlternation: false,
        supportsPrefixCompletion: true,
      },
    });
    const codeInput = editModal.components[0]?.component;
    const flagsField = editModal.components.find((entry) => entry.component?.custom_id === "flags_abcdefgh")?.component;
    const compatField = editModal.components.find(
      (entry) => entry.component?.custom_id === "compat_abcdefgh",
    )?.component;

    expect(codeInput?.value).toBe("lighthouse/model");
    // The prefill has to reach the group each flag now lives in, not just the modal.
    expect(flagsField?.options?.filter((option) => option.default).map((option) => option.value)).toEqual(["tools"]);
    expect(compatField?.options?.filter((option) => option.default).map((option) => option.value)).toEqual(["prefix"]);
  });

  it("validates selector values without decoding anything beyond the model identity", () => {
    expect(buildModelSelectionValue("add", "image")).toBe("add:image");
    expect(
      buildModelSelectionValue("edit", "image", {
        id: 42,
        codeName: "flux",
        isWorkspaceActive: false,
        isWorkspaceFallback: false,
        isProviderFallback: false,
        isCustomRegistration: true,
      }),
    ).toBe("edit:image:42");

    expect(parseModelSelectionValue("edit:text:91")).toEqual({
      mode: "edit",
      capability: "text",
      editingModelId: 91,
    });
    expect(parseModelSelectionValue("add:image")).toEqual({
      mode: "add",
      capability: "image",
      editingModelId: null,
    });
    expect(parseModelSelectionValue("edit:image:0")).toBeNull();
    expect(parseModelSelectionValue("remove:image:1")).toBeNull();
    expect(parseModelSelectionValue("edit:nonsense:1")).toBeNull();
    expect(parseModelSelectionValue(undefined)).toBeNull();
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

// A provider with a catalog-sized model list made the whole panel fail with
// BASE_TYPE_BAD_LENGTH rather than render, because the per-capability model list is unbounded and
// Discord caps a TextDisplay at 4000 characters.
describe("Provider entry body stays inside the TextDisplay budget", () => {
  it("caps a catalog-sized model list and states how many lines it hid", () => {
    const many = providerEntry("provider:openrouter", "OpenRouter");
    many.capabilities[0].models = Array.from({ length: 300 }, (_, index) => ({
      id: index + 1,
      codeName: `openrouter/some-fairly-long-model-identifier-${index}`,
      isWorkspaceActive: false,
      isWorkspaceFallback: false,
      isProviderFallback: false,
      isCustomRegistration: false,
      textSettings: {
        numCtx: 8192,
        hasTools: true,
        seesImages: false,
        supportsStructOutput: false,
        strictRoleAlternation: false,
        supportsPrefixCompletion: false,
      },
    }));

    const panel = buildProvidersPanelPayload({
      locale: "en-US",
      entries: [many],
      initialEntryId: "provider:openrouter",
      readStatus: "fresh",
      page: { kind: "entry" },
      enabledActions: new Set(["add-provider", "add-endpoint", "model", "edit", "remove"]),
      routeNamespace: PERSONAL_PROVIDERS_ROUTE_NAMESPACE,
      footerCommand: { root: "personal", subcommandGroup: "provider", subcommand: "model-text" },
    });

    const container = panel.components[0] as { components: Array<{ type: number; content?: string }> };
    const texts = container.components.filter((component) => typeof component.content === "string");
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      // Discord's own bound. Exceeding it rejects the entire payload, not just this block.
      expect((text.content as string).length).toBeLessThanOrEqual(4000);
      expect((text.content as string).length).toBeGreaterThan(0);
    }
    expect(JSON.stringify(panel)).toContain("Showing the first 3,500 of");
  });
});
