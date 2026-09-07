/**
 * Route coverage for the `/config` Models surface.
 *
 * Drives the real registered route through the real policy, catalog, renderer, and canonical model
 * operations. Writes are proved by spying on the repository each operation actually calls rather
 * than by substituting an operations double, which would restate the expected answer instead of
 * exercising the code under test.
 */
import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { PermissionsBitField, type Client } from "discord.js";
import type { SavedProviderConfigRow, TomoriState } from "@/types/db/schema";
import type { PanelReadStatus } from "@/types/discord/panel";
import * as tomoriStateCache from "@/utils/cache/tomoriStateCache";
import { configRepository, llmModelRepo, llmOverrideRepo, llmProviderRepo } from "@/utils/db/repositories";
import * as ragAvailability from "@/utils/db/ragAvailability";
import { ragRepository, serverMemoryRepository } from "@/utils/db/repositories";
import * as credentialResolver from "@/utils/provider/credentialResolver";
import {
  buildConfigRouteId,
  CONFIG_MODEL_CLEAR_VALUE,
  CONFIG_MODEL_PAGE_SIZE,
  CONFIG_MODEL_CAPABILITY_ORDER,
  isConfigCatalogModelCapability,
  type ConfigCatalogModelCapability,
  type ConfigModelCapability,
} from "@/utils/discord/configPanelCatalog";
import {
  filterProvidersForCapability,
  isNaiPipelineProvider,
  configModelOperations,
  type ConfigModelOperations,
} from "@/utils/discord/interactions/configModelOperations";
import {
  decodeConfigProviderPageValue,
  decodeConfigProviderRangeValue,
  encodeConfigProviderPageValue,
  computeConfigEndpointFingerprint,
  encodeConfigEndpointSelection,
  loadConfigFallbacksView,
  loadConfigImageGenerationView,
  loadConfigParametersView,
  loadConfigSwitchModelsView,
} from "@/utils/discord/interactions/configModelLoaders";
import { createConfigInteractionRoute } from "@/utils/discord/interactions/configRoutes";
import type { ConfigRouteDependencies, ConfigScope } from "@/utils/discord/interactions/configRouteContext";
import { providerPanelOperations } from "@/utils/provider/providerPanelOperations";
import type { ConfigCapabilityEndpoint } from "@/utils/discord/interactions/configModelLoaders";
import type { ConfigEndpointSlotView } from "@/utils/discord/ui/configModelsPanel";
import { InteractionRouteRegistry } from "@/utils/discord/interactions/routeRegistry";
import { buildConfigModalFieldId } from "@/utils/discord/ui/configModals";
import { buildConfigFallbackSlotId } from "@/utils/discord/ui/configModelModals";
import { buildConfigPanelPayload } from "@/utils/discord/ui/configPanel";
import {
  validateComponentsV2MessageLimits,
  type ComponentsV2MessagePayload,
} from "@/utils/discord/ui/componentsV2Limits";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const CLIENT = {} as Client;
const CATALOG_MODEL_CAPABILITIES: readonly ConfigCatalogModelCapability[] =
  CONFIG_MODEL_CAPABILITY_ORDER.filter(isConfigCatalogModelCapability);

function makeState(overrides: Record<string, unknown> = {}): TomoriState {
  return {
    server_id: 9,
    persona_id: 55,
    persona_nickname: "Aphel",
    is_alter: false,
    trigger_words: [],
    naming_config: { prefixes: {}, suffixes: {}, addressTerms: {} },
    attribute_list: [],
    sample_dialogues_in: [],
    sample_dialogues_out: [],
    llm: { llm_id: 1, llm_codename: "gemini-2.5-flash", llm_provider: "google", sees_images: true, has_tools: true },
    vision_llm: null,
    fallback_chain: [],
    config: {
      llm_id: 1,
      vision_llm_id: null,
      embedding_model_id: null,
      diffusion_model_id: null,
      nai_diffusion_model_id: null,
      video_model_id: null,
      imagegen_enabled: true,
      videogen_enabled: false,
      llm_temperature: 1,
      llm_top_p: 0.95,
      llm_top_k: 0,
      llm_frequency_penalty: 0,
      llm_presence_penalty: 0,
      llm_min_p: 0.05,
      llm_max_output_tokens: null,
      thinking_level: "auto",
      llm_stop_strings: [],
      llm_stop_speaker_pattern_enabled: false,
      llm_logit_biases: [],
      fallback_model_refs: [],
      model_randomizer_enabled: false,
      image_default_positive_tags: ["masterpiece"],
      image_default_negative_tags: ["lowres"],
      nai_sampler: null,
      nai_steps: null,
      nai_scale: null,
      nai_noise_schedule: null,
      nai_cfg_rescale: null,
      ...((overrides.config as Record<string, unknown>) ?? {}),
    },
    ...overrides,
  } as unknown as TomoriState;
}

function makeSavedProvider(provider: string, overrides: Record<string, unknown> = {}): SavedProviderConfigRow {
  return {
    server_id: 9,
    provider,
    api_key: "key",
    key_version: 1,
    llm_id: 1,
    diffusion_model_id: null,
    embedding_model_id: null,
    nai_diffusion_model_id: null,
    video_model_id: null,
    vision_llm_id: null,
    nai_preset_name: null,
    llm_temperature: 1,
    llm_top_p: 0.95,
    llm_top_k: 0,
    llm_frequency_penalty: 0,
    llm_presence_penalty: 0,
    llm_min_p: 0.05,
    llm_max_output_tokens: null,
    llm_disabled_params: [],
    llm_logit_biases: [],
    thinking_level: "auto",
    fallback_model_refs: [],
    ...overrides,
  } as unknown as SavedProviderConfigRow;
}

function makeEndpointSlot(capability: "tts" | "stt", count: number, activeIndex = -1): ConfigEndpointSlotView {
  const serviceCapability = capability === "tts" ? "speech" : "transcription";
  const apiStyle = capability === "tts" ? "tts-clone" : "openai-compatible-transcription";
  const endpoints: ConfigCapabilityEndpoint[] = Array.from({ length: count }, (_unused, index) => ({
    id: index + 1,
    capability: serviceCapability,
    label: `${capability}-endpoint-${index + 1}`,
    modelLabel: `${capability}-model-${index + 1}`,
    apiStyle,
    isActive: index === activeIndex,
  }));
  return { capability, endpoints, pageStart: 0 };
}

interface HarnessOptions {
  isManager?: boolean;
  inGuild?: boolean;
  unavailable?: boolean;
  readStatus?: PanelReadStatus;
  state?: TomoriState;
  refreshedState?: TomoriState;
  switchProviders?: Record<string, string[]>;
  currentModels?: Partial<Record<ConfigModelCapability, string | null>>;
  currentProviders?: Partial<Record<ConfigModelCapability, string | null>>;
  models?: Array<{ id: number; name: string; description: string | null }>;
  parametersProviders?: string[];
  selectedConfig?: SavedProviderConfigRow | null;
  fallbackProviderEntries?: Array<{ value: string; label: string }>;
  endpointSlots?: ConfigEndpointSlotView[];
  modelOperationsOverrides?: Partial<ConfigModelOperations>;
}

interface Harness {
  dependencies: Partial<ConfigRouteDependencies>;
  telemetry: string[];
  edits: unknown[];
  replies: unknown[];
  modals: unknown[];
  checkboxValues: Record<string, string[] | undefined>;
  selectValues: Record<string, string | undefined>;
  deferredAtWrite: boolean[];
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const telemetry: string[] = [];
  const edits: unknown[] = [];
  const replies: unknown[] = [];
  const modals: unknown[] = [];
  const checkboxValues: Record<string, string[] | undefined> = {};
  const selectValues: Record<string, string | undefined> = {};
  const deferredAtWrite: boolean[] = [];

  const buildScope = (forceRefresh: boolean): ConfigScope | null => {
    if (options.unavailable) return null;
    return {
      serverDiscId: options.inGuild === false ? "user-1" : "guild-1",
      guildId: options.inGuild === false ? null : "guild-1",
      internalServerId: 9,
      userId: 1,
      actor:
        options.inGuild === false
          ? { workspaceKind: "dm", isManager: true }
          : { workspaceKind: "guild", isManager: options.isManager ?? true },
      personas: [(forceRefresh ? (options.refreshedState ?? options.state) : options.state) ?? makeState()],
      readStatus: options.readStatus ?? "fresh",
    };
  };

  return {
    telemetry,
    edits,
    replies,
    modals,
    checkboxValues,
    selectValues,
    deferredAtWrite,
    dependencies: {
      resolveScope: async (_interaction, forceRefresh = false) => buildScope(forceRefresh),
      getPersonaAvatarData: async () => ({ url: null, files: [] }),
      recordAction: (input) => {
        telemetry.push(input.action);
      },
      createNonce: () => "nonce1234567",
      modelOperations: { ...configModelOperations, ...options.modelOperationsOverrides },
      showModal: async (_interaction, payload) => {
        modals.push(payload);
      },
      takeCheckboxValues: (_interactionId, fieldId) => checkboxValues[fieldId],
      takeSelectValue: (_interactionId, fieldId) => selectValues[fieldId],
      takeFileUpload: () => undefined,
      loadSwitchModelsView: async (state, providerPage, endpointPage) => ({
        slots: CATALOG_MODEL_CAPABILITIES.map((capability) => ({
          capability,
          currentModelName:
            options.currentModels?.[capability] !== undefined
              ? options.currentModels[capability]
              : capability === "text"
                ? "gemini-2.5-flash"
                : null,
          currentProvider:
            options.currentProviders?.[capability] !== undefined
              ? options.currentProviders[capability]
              : capability === "text"
                ? "google"
                : null,
          eligibleProviders: options.switchProviders?.[capability] ?? ["google"],
          providerPageStart: providerPage?.capability === capability ? providerPage.start : 0,
          expandedProvider: providerPage?.capability === capability ? (providerPage.provider ?? null) : null,
          expandedOptionCount:
            providerPage?.capability === capability && providerPage.provider ? (options.models?.length ?? 1) : 0,
        })),
        channelOverrideCount: 3,
        personaOverrideCount: 2,
        imageGenerationEnabled: state.config.imagegen_enabled,
        videoGenerationEnabled: state.config.videogen_enabled,
        endpointSlots: options.endpointSlots?.map((slot) => ({
          ...slot,
          pageStart: endpointPage?.capability === slot.capability ? endpointPage.start : slot.pageStart,
        })),
      }),
      loadCapabilityEndpoints: async (_state, capability) =>
        options.endpointSlots?.find((slot) => slot.capability === capability)?.endpoints ?? [],
      loadParametersView: async (_state, requestedProvider) => {
        const providers = options.parametersProviders ?? ["google"];
        const selected = providers.includes(requestedProvider ?? "") ? (requestedProvider as string) : providers[0];
        return {
          textProviders: providers,
          selectedProvider: selected ?? null,
          selectedConfig:
            options.selectedConfig !== undefined ? options.selectedConfig : makeSavedProvider(selected ?? "google"),
          stopStrings: options.state?.config.llm_stop_strings ?? [],
          speakerPatternEnabled: options.state?.config.llm_stop_speaker_pattern_enabled ?? false,
          logitBiasEntries: options.state?.config.llm_logit_biases ?? [],
          logitBiasPageStart: 0,
        };
      },
      loadFallbacksView: async () => ({
        slots: [{ label: null }, { label: null }, { label: null }, { label: null }, { label: null }],
        providerEntries: options.fallbackProviderEntries ?? [
          { value: encodeConfigProviderPageValue("google", 0), label: "Google" },
        ],
        expandedProvider: null,
        entryStart: 0,
        randomizerEnabled: options.state?.config.model_randomizer_enabled ?? false,
        hasFallbacks: (options.state?.config.fallback_model_refs ?? []).length > 0,
      }),
      loadImageGenerationView: () => ({
        positiveTags: ["masterpiece"],
        negativeTags: ["lowres"],
        sampler: "k_euler_ancestral",
        steps: "28",
        scale: "5",
        noiseSchedule: "karras",
        cfgRescale: "0",
      }),
      loadModelChoices: async () => options.models ?? [{ id: 7, name: "gemini-2.5-pro", description: "Pro" }],
      loadFallbackOptions: async () => [{ value: "gemini-2.5-pro", label: "gemini-2.5-pro" }],
      loadModelProviders: async (_state, capability) => options.switchProviders?.[capability] ?? ["google"],
    },
  };
}

interface FakeInteractionOptions {
  customId: string;
  kind?: "button" | "select" | "modal";
  values?: string[];
  fields?: Record<string, string>;
  isManager?: boolean;
  inGuild?: boolean;
  harness: Harness;
}

function makeInteraction(options: FakeInteractionOptions) {
  let deferred = false;
  const kind = options.kind ?? "button";

  const interaction = {
    id: "interaction-1",
    customId: options.customId,
    user: { id: "user-1", username: "Sparrow" },
    channelId: "channel-1",
    channel: { name: "lounge" },
    guildId: options.inGuild === false ? null : "guild-1",
    guild: options.inGuild === false ? null : { id: "guild-1" },
    client: { user: null },
    values: options.values ?? [],
    memberPermissions: {
      has: (flag: bigint) => (options.isManager ?? true) && flag === PermissionsBitField.Flags.ManageGuild,
    },
    isButton: () => kind === "button",
    isStringSelectMenu: () => kind === "select",
    isModalSubmit: () => kind === "modal",
    get deferred() {
      return deferred;
    },
    get replied() {
      return false;
    },
    deferUpdate: async () => {
      deferred = true;
    },
    editReply: async (payload: unknown) => {
      options.harness.edits.push(payload);
      return payload;
    },
    reply: async (payload: unknown) => {
      options.harness.replies.push(payload);
      return payload;
    },
    followUp: async (payload: unknown) => payload,
    fields: {
      fields: new Map(Object.entries(options.fields ?? {})),
      getTextInputValue: (fieldId: string) => options.fields?.[fieldId] ?? "",
    },
  };

  return interaction as unknown as Parameters<ReturnType<typeof createConfigInteractionRoute>["execute"]>[1];
}

async function dispatch(harness: Harness, interaction: ReturnType<typeof makeInteraction>): Promise<void> {
  const registry = new InteractionRouteRegistry([createConfigInteractionRoute(harness.dependencies)]);
  await registry.dispatch(CLIENT, interaction);
}

function renderedText(payload: unknown): string {
  return JSON.stringify(payload);
}

function textDisplayContents(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(textDisplayContents);
  if (typeof value !== "object" || value === null) return [];

  const record = value as Record<string, unknown>;
  const content = record.type === 10 && typeof record.content === "string" ? [record.content] : [];
  return [...content, ...Object.values(record).flatMap(textDisplayContents)];
}

/** Options of the model select inside a raw model-picker modal payload. */
function modelModalOptions(payload: unknown): Array<{ value: string }> {
  const parsed = payload as { components?: Array<{ component?: { options?: Array<{ value: string }> } }> } | undefined;
  return parsed?.components?.[0]?.component?.options ?? [];
}

function findComponentByCustomId(value: unknown, customId: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const match = findComponentByCustomId(entry, customId);
      if (match) return match;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.customId === customId) return record;
  for (const entry of Object.values(record)) {
    const match = findComponentByCustomId(entry, customId);
    if (match) return match;
  }
  return undefined;
}

function selectOptionValues(payload: unknown, customId: string): string[] {
  const select = findComponentByCustomId(payload, customId);
  if (!Array.isArray(select?.options)) return [];
  return select.options.flatMap((option) => {
    if (typeof option !== "object" || option === null) return [];
    const value = (option as { value?: unknown }).value;
    return typeof value === "string" ? [value] : [];
  });
}

function expectValidComponentsV2Payload(payload: unknown): void {
  expect(validateComponentsV2MessageLimits(payload as ComponentsV2MessagePayload).valid).toBe(true);
}

describe("config models provider eligibility", () => {
  it("routes a NovelAI-pipeline provider to the NovelAI slot and every other provider to Standard", () => {
    const rows = [makeSavedProvider("novelai"), makeSavedProvider("google"), makeSavedProvider("custom:12")];
    expect(filterProvidersForCapability("nai-image", rows).map((row) => row.provider)).toEqual(["novelai"]);
    expect(filterProvidersForCapability("image", rows).map((row) => row.provider)).toEqual(["google", "custom:12"]);
  });

  it("treats a custom label as a standard-column provider whatever its connection points at", () => {
    expect(isNaiPipelineProvider("custom:12")).toBe(false);
    expect(isNaiPipelineProvider("novelai")).toBe(true);
  });

  it("passes every non-image capability through unfiltered", () => {
    const rows = [makeSavedProvider("novelai"), makeSavedProvider("google")];
    for (const capability of CATALOG_MODEL_CAPABILITIES.filter(
      (candidate) => candidate !== "image" && candidate !== "nai-image",
    )) {
      expect(filterProvidersForCapability(capability, rows).map((row) => row.provider)).toEqual(["novelai", "google"]);
    }
  });
});

describe("config models switch page", () => {
  it("keeps endpoint selectors bounded and reaches every endpoint window", async () => {
    for (const count of [0, 1, 24, 25, 26, 60]) {
      const endpointSlots = [makeEndpointSlot("tts", count), makeEndpointSlot("stt", 0)];
      const harness = makeHarness({ endpointSlots });
      const customId = buildConfigRouteId({ action: "endpoint-select", locale: "en-US", capability: "tts" });
      const visited = new Set<number>();
      let values: string[] = [];
      for (let step = 0; step <= count + 1; step += 1) {
        await dispatch(
          harness,
          makeInteraction({
            customId: buildConfigRouteId({ action: "page", locale: "en-US", category: "models", page: "switch" }),
            kind: "select",
            values: ["switch"],
            harness,
          }),
        );
        values = selectOptionValues(harness.edits.at(-1), customId);
        expect(values.length).toBeLessThanOrEqual(25);
        for (const value of values) {
          const match = /^ep\|(\d+)\|/.exec(value);
          if (match) visited.add(Number(match[1]));
        }
        const next = values.find((value) => value.startsWith("ep-page|"));
        if (!next) break;
        await dispatch(harness, makeInteraction({ customId, kind: "select", values: [next], harness }));
        values = selectOptionValues(harness.edits.at(-1), customId);
        for (const value of values) {
          const match = /^ep\|(\d+)\|/.exec(value);
          if (match) visited.add(Number(match[1]));
        }
        if (!values.some((value) => value.startsWith("ep-page|"))) break;
        // The next loop re-renders from the current page in the harness.
        endpointSlots[0].pageStart = Number(values.find((value) => value.startsWith("ep-page|"))?.split("|")[1] ?? 0);
      }
      expect(visited.size).toBe(count);
      if (count === 0) {
        expect(findComponentByCustomId(harness.edits.at(-1), customId)?.disabled).toBe(true);
      }
    }
  });

  describe("endpoint activation routes", () => {
    const activationSpies: Array<{ mockRestore: () => void }> = [];

    afterEach(() => {
      for (const activationSpy of activationSpies.splice(0)) activationSpy.mockRestore();
    });

    it("re-reads the endpoint list and delegates successful TTS and STT selections", async () => {
      const activationSpy = spyOn(providerPanelOperations, "activateWorkspaceEndpoint").mockImplementation(
        async (input) => ({
          status: "success",
          identity: `${input.customEndpointId} (${input.capability})`,
          sourceChanged: input.capability === "speech",
        }),
      );
      activationSpies.push(activationSpy);
      for (const capability of ["tts", "stt"] as const) {
        const endpointSlots = [
          makeEndpointSlot(capability, 1),
          makeEndpointSlot(capability === "tts" ? "stt" : "tts", 0),
        ];
        const endpoints = endpointSlots[0].endpoints;
        const harness = makeHarness({ endpointSlots });
        const fingerprint = computeConfigEndpointFingerprint(capability, endpoints);
        await dispatch(
          harness,
          makeInteraction({
            customId: buildConfigRouteId({ action: "endpoint-select", locale: "en-US", capability }),
            kind: "select",
            values: [encodeConfigEndpointSelection(0, fingerprint)],
            harness,
          }),
        );

        expect(activationSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            capability: capability === "tts" ? "speech" : "transcription",
            customEndpointId: 1,
            scopeKind: "server",
          }),
        );
        expect(harness.telemetry).toContain("server-config.workspace.model.endpoint-select");
        if (capability === "tts") expect(JSON.stringify(harness.edits.at(-1))).toContain("speech source changed");
      }
    });

    it("rejects malformed, out-of-range, and changed-fingerprint selections without a write", async () => {
      const endpointSlots = [makeEndpointSlot("tts", 1), makeEndpointSlot("stt", 0)];
      const harness = makeHarness({ endpointSlots });
      const activationSpy = spyOn(providerPanelOperations, "activateWorkspaceEndpoint");
      activationSpies.push(activationSpy);
      const fingerprint = computeConfigEndpointFingerprint("tts", endpointSlots[0].endpoints);
      for (const value of ["not-an-endpoint", `ep|1|${fingerprint}`, encodeConfigEndpointSelection(0, "deadbeef")]) {
        await dispatch(
          harness,
          makeInteraction({
            customId: buildConfigRouteId({ action: "endpoint-select", locale: "en-US", capability: "tts" }),
            kind: "select",
            values: [value],
            harness,
          }),
        );
      }
      expect(activationSpy).not.toHaveBeenCalled();
      expect(JSON.stringify(harness.edits.at(-1))).toContain("Panel Out Of Date");
    });

    it("stops a non-manager at the real route authorization gate", async () => {
      const endpointSlots = [makeEndpointSlot("tts", 1), makeEndpointSlot("stt", 0)];
      const harness = makeHarness({ endpointSlots, isManager: false });
      const repositoryWriteSpy = spyOn(llmProviderRepo, "setActiveCustomEndpoint");
      activationSpies.push(repositoryWriteSpy);
      const fingerprint = computeConfigEndpointFingerprint("tts", endpointSlots[0].endpoints);
      await dispatch(
        harness,
        makeInteraction({
          customId: buildConfigRouteId({ action: "endpoint-select", locale: "en-US", capability: "tts" }),
          kind: "select",
          isManager: false,
          values: [encodeConfigEndpointSelection(0, fingerprint)],
          harness,
        }),
      );
      expect(repositoryWriteSpy).not.toHaveBeenCalled();
      expect(harness.replies).toHaveLength(1);
    });

    it("keeps a DM-backed config workspace on server-scoped endpoint activation", async () => {
      const activationSpy = spyOn(providerPanelOperations, "activateWorkspaceEndpoint").mockImplementation(
        async (input) => ({
          status: "success",
          identity: `${input.customEndpointId} (${input.capability})`,
          sourceChanged: false,
        }),
      );
      activationSpies.push(activationSpy);
      const endpointSlots = [makeEndpointSlot("tts", 1), makeEndpointSlot("stt", 0)];
      const harness = makeHarness({ endpointSlots, inGuild: false });
      const fingerprint = computeConfigEndpointFingerprint("tts", endpointSlots[0].endpoints);

      await dispatch(
        harness,
        makeInteraction({
          customId: buildConfigRouteId({ action: "endpoint-select", locale: "en-US", capability: "tts" }),
          kind: "select",
          inGuild: false,
          values: [encodeConfigEndpointSelection(0, fingerprint)],
          harness,
        }),
      );

      expect(activationSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          serverDiscId: "user-1",
          scopeKind: "server",
          capability: "speech",
          customEndpointId: 1,
        }),
      );
    });
  });

  it("renders all six capability slots and the Text-override counts", async () => {
    const harness = makeHarness();
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "page", locale: "en-US", category: "models", page: "switch" }),
        kind: "select",
        values: ["switch"],
        harness,
      }),
    );

    const rendered = renderedText(harness.edits.at(-1));
    for (const capability of CATALOG_MODEL_CAPABILITIES) {
      expect(rendered).toContain(buildConfigRouteId({ action: "model-provider-select", locale: "en-US", capability }));
    }
    expect(rendered).toContain("Channel overrides");
    expect(rendered).toContain("Persona overrides");
  });

  it("renders an inert selector for a capability with no eligible provider", async () => {
    const harness = makeHarness({ switchProviders: { video: [] } });
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "page", locale: "en-US", category: "models", page: "switch" }),
        kind: "select",
        values: ["switch"],
        harness,
      }),
    );

    const payload = JSON.parse(renderedText(harness.edits.at(-1)));
    const rows = payload.components[0].components;
    const videoRow = rows.find(
      (row: { components?: Array<{ customId?: string }> }) =>
        row.components?.[0]?.customId ===
        buildConfigRouteId({ action: "model-provider-select", locale: "en-US", capability: "video" }),
    );
    expect(videoRow.components[0].disabled).toBe(true);
  });

  it("renders only actionable capability warnings", async () => {
    const missing = makeHarness({
      state: makeState({ config: { imagegen_enabled: true, videogen_enabled: true } }),
    });
    await dispatch(
      missing,
      makeInteraction({
        customId: buildConfigRouteId({ action: "page", locale: "en-US", category: "models", page: "switch" }),
        kind: "select",
        values: ["switch"],
        harness: missing,
      }),
    );

    const missingContents = textDisplayContents(missing.edits.at(-1));
    expect(
      missingContents.some((content) => content.includes("No usable model is configured for Image generation.")),
    ).toBe(true);
    expect(
      missingContents.some((content) => content.includes("No usable model is configured for Video generation.")),
    ).toBe(true);

    const disabled = makeHarness({
      state: makeState({ config: { imagegen_enabled: false, videogen_enabled: false } }),
    });
    await dispatch(
      disabled,
      makeInteraction({
        customId: buildConfigRouteId({ action: "page", locale: "en-US", category: "models", page: "switch" }),
        kind: "select",
        values: ["switch"],
        harness: disabled,
      }),
    );

    const disabledContents = textDisplayContents(disabled.edits.at(-1));
    expect(disabledContents.some((content) => content.includes("Image generation is disabled."))).toBe(true);
    expect(disabledContents.some((content) => content.includes("Video generation is disabled."))).toBe(true);
    expect(
      disabledContents.some((content) => content.includes("No usable model is configured for Image generation.")),
    ).toBe(false);
    expect(
      disabledContents.some((content) => content.includes("No usable model is configured for Video generation.")),
    ).toBe(false);

    const healthy = makeHarness({
      state: makeState({ config: { imagegen_enabled: true, videogen_enabled: true } }),
      currentModels: { image: "imagen", video: "veo" },
      currentProviders: { image: "google", video: "google" },
    });
    await dispatch(
      healthy,
      makeInteraction({
        customId: buildConfigRouteId({ action: "page", locale: "en-US", category: "models", page: "switch" }),
        kind: "select",
        values: ["switch"],
        harness: healthy,
      }),
    );

    const healthyContents = textDisplayContents(healthy.edits.at(-1));
    expect(healthyContents.some((content) => content.includes("No usable model is configured"))).toBe(false);

    const novelAiOnly = makeHarness({
      state: makeState({ config: { imagegen_enabled: true, videogen_enabled: false } }),
      switchProviders: { image: [], "nai-image": ["novelai"] },
      currentModels: { "nai-image": "nai-diffusion" },
      currentProviders: { "nai-image": "novelai" },
    });
    await dispatch(
      novelAiOnly,
      makeInteraction({
        customId: buildConfigRouteId({ action: "page", locale: "en-US", category: "models", page: "switch" }),
        kind: "select",
        values: ["switch"],
        harness: novelAiOnly,
      }),
    );

    const novelAiOnlyContents = textDisplayContents(novelAiOnly.edits.at(-1));
    expect(
      novelAiOnlyContents.some((content) => content.includes("No usable model is configured for Image generation.")),
    ).toBe(false);
  });

  it("treats a populated slot with an ineligible provider as unusable", async () => {
    const harness = makeHarness({
      state: makeState({ config: { imagegen_enabled: true, videogen_enabled: false } }),
      switchProviders: { image: [] },
      currentModels: { image: "stale-imagen" },
      currentProviders: { image: "google" },
    });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "page", locale: "en-US", category: "models", page: "switch" }),
        kind: "select",
        values: ["switch"],
        harness,
      }),
    );

    expect(
      textDisplayContents(harness.edits.at(-1)).some((content) =>
        content.includes("No usable model is configured for Image generation."),
      ),
    ).toBe(true);
  });

  it("does not query repositories while rendering capability status", async () => {
    const diffusionLookup = spyOn(llmModelRepo, "loadDiffusionModelById").mockResolvedValue(null);
    const videoLookup = spyOn(llmModelRepo, "loadVideoGenerationModelById").mockResolvedValue(null);
    const harness = makeHarness({
      state: makeState({ config: { imagegen_enabled: true, videogen_enabled: true } }),
    });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "page", locale: "en-US", category: "models", page: "switch" }),
        kind: "select",
        values: ["switch"],
        harness,
      }),
    );

    expect(diffusionLookup).not.toHaveBeenCalled();
    expect(videoLookup).not.toHaveBeenCalled();
    diffusionLookup.mockRestore();
    videoLookup.mockRestore();
  });

  it("offers the provider-independent clear entry only for populated image slots", async () => {
    const clearValues = (payload: unknown, capability: ConfigModelCapability): string[] => {
      const select = findComponentByCustomId(
        payload,
        buildConfigRouteId({ action: "model-provider-select", locale: "en-US", capability }),
      );
      const options = (select?.options ?? []) as Array<{ value: string }>;
      return options.filter((option) => option.value === CONFIG_MODEL_CLEAR_VALUE).map((option) => option.value);
    };

    const populated = makeHarness({
      currentModels: { vision: "vision-model", image: "standard-model", "nai-image": "nai-model" },
    });
    await dispatch(
      populated,
      makeInteraction({
        customId: buildConfigRouteId({ action: "page", locale: "en-US", category: "models", page: "switch" }),
        kind: "select",
        values: ["switch"],
        harness: populated,
      }),
    );

    expect(clearValues(populated.edits.at(-1), "image")).toHaveLength(1);
    expect(clearValues(populated.edits.at(-1), "nai-image")).toHaveLength(1);
    expect(clearValues(populated.edits.at(-1), "vision")).toHaveLength(1);
    // Text has no clear path at all, so its select must never grow one.
    expect(clearValues(populated.edits.at(-1), "text")).toHaveLength(0);
    expect(clearValues(populated.edits.at(-1), "embedding")).toHaveLength(0);
    expect(clearValues(populated.edits.at(-1), "video")).toHaveLength(0);

    const empty = makeHarness({ currentModels: { vision: null, image: null, "nai-image": null } });
    await dispatch(
      empty,
      makeInteraction({
        customId: buildConfigRouteId({ action: "page", locale: "en-US", category: "models", page: "switch" }),
        kind: "select",
        values: ["switch"],
        harness: empty,
      }),
    );

    expect(clearValues(empty.edits.at(-1), "vision")).toHaveLength(0);
    expect(clearValues(empty.edits.at(-1), "image")).toHaveLength(0);
    expect(clearValues(empty.edits.at(-1), "nai-image")).toHaveLength(0);

    const stale = makeHarness({ readStatus: "stale", currentModels: { image: "standard-model" } });
    await dispatch(
      stale,
      makeInteraction({
        customId: buildConfigRouteId({ action: "page", locale: "en-US", category: "models", page: "switch" }),
        kind: "select",
        values: ["switch"],
        harness: stale,
      }),
    );

    expect(
      findComponentByCustomId(
        stale.edits.at(-1),
        buildConfigRouteId({ action: "model-provider-select", locale: "en-US", capability: "image" }),
      )?.disabled,
    ).toBe(true);
  });

  it("clears each image column through the route when no provider is eligible", async () => {
    const standardState = makeState({ config: { diffusion_model_id: 41, nai_diffusion_model_id: 42 } });
    const standardRefreshed = makeState({ config: { diffusion_model_id: null, nai_diffusion_model_id: 42 } });
    const standardHarness = makeHarness({
      state: standardState,
      refreshedState: standardRefreshed,
      switchProviders: { image: [] },
      currentModels: { image: "stale-standard-model", "nai-image": "stale-nai-model" },
    });
    const modelUpdate = spyOn(configRepository, "updateModelConfig").mockResolvedValue(true);
    const naiUpdate = spyOn(configRepository, "updateNovelaiImagegenConfig").mockResolvedValue(true);
    const invalidate = spyOn(tomoriStateCache, "invalidateTomoriStateCache").mockImplementation(() => undefined);

    await dispatch(
      standardHarness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "page", locale: "en-US", category: "models", page: "switch" }),
        kind: "select",
        values: ["switch"],
        harness: standardHarness,
      }),
    );
    // The provider list is empty, so the clear entry is the only thing keeping this select live.
    expect(
      findComponentByCustomId(
        standardHarness.edits.at(-1),
        buildConfigRouteId({ action: "model-provider-select", locale: "en-US", capability: "image" }),
      )?.disabled,
    ).toBe(false);

    await dispatch(
      standardHarness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "model-provider-select", locale: "en-US", capability: "image" }),
        kind: "select",
        values: [CONFIG_MODEL_CLEAR_VALUE],
        harness: standardHarness,
      }),
    );

    expect(modelUpdate).toHaveBeenCalledWith(9, { diffusion_model_id: null });
    expect(naiUpdate).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith("guild-1");
    expect(standardHarness.telemetry).toContain("server-config.workspace.model.clear");

    modelUpdate.mockClear();
    naiUpdate.mockClear();
    invalidate.mockClear();
    const naiHarness = makeHarness({
      state: makeState({ config: { diffusion_model_id: 41, nai_diffusion_model_id: 42 } }),
      refreshedState: makeState({ config: { diffusion_model_id: 41, nai_diffusion_model_id: null } }),
      switchProviders: { "nai-image": [] },
      currentModels: { image: "stale-standard-model", "nai-image": "stale-nai-model" },
    });

    await dispatch(
      naiHarness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "model-provider-select", locale: "en-US", capability: "nai-image" }),
        kind: "select",
        values: [CONFIG_MODEL_CLEAR_VALUE],
        harness: naiHarness,
      }),
    );

    expect(modelUpdate).not.toHaveBeenCalled();
    expect(naiUpdate).toHaveBeenCalledWith(9, { nai_diffusion_model_id: null });
    expect(invalidate).toHaveBeenCalledWith("guild-1");

    modelUpdate.mockRestore();
    naiUpdate.mockRestore();
    invalidate.mockRestore();
  });

  it("clears the vision slot from its top-level select", async () => {
    const harness = makeHarness({
      state: makeState({ config: { vision_llm_id: 31 } }),
      refreshedState: makeState({ config: { vision_llm_id: null } }),
      currentModels: { vision: "vision-model" },
    });
    const modelUpdate = spyOn(configRepository, "updateModelConfig").mockResolvedValue(true);
    const invalidate = spyOn(tomoriStateCache, "invalidateTomoriStateCache").mockImplementation(() => undefined);

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "model-provider-select", locale: "en-US", capability: "vision" }),
        kind: "select",
        values: [CONFIG_MODEL_CLEAR_VALUE],
        harness,
      }),
    );

    expect(modelUpdate).toHaveBeenCalledWith(9, { vision_llm_id: null });
    expect(invalidate).toHaveBeenCalledWith("guild-1");
    expect(harness.telemetry).toContain("server-config.workspace.model.clear");

    modelUpdate.mockRestore();
    invalidate.mockRestore();
  });

  it("offers a None entry only for the slots whose absorbed command can clear", async () => {
    // The clear entry only appears on a slot that has something to clear, so each capability is
    // given an assignment first.
    for (const capability of ["vision", "image", "nai-image"] as ConfigModelCapability[]) {
      const harness = makeHarness({
        currentModels: { [capability]: "assigned-model" },
        currentProviders: { [capability]: "google" },
      });
      await dispatch(
        harness,
        makeInteraction({
          customId: buildConfigRouteId({ action: "page", locale: "en-US", category: "models", page: "switch" }),
          kind: "select",
          values: ["switch"],
          harness,
        }),
      );
      expect(
        selectOptionValues(
          harness.edits.at(-1),
          buildConfigRouteId({ action: "model-provider-select", locale: "en-US", capability }),
        ),
      ).toContain(CONFIG_MODEL_CLEAR_VALUE);
    }

    for (const capability of ["text", "embedding", "video"] as ConfigModelCapability[]) {
      const harness = makeHarness({ currentModels: { [capability]: null } });
      await dispatch(
        harness,
        makeInteraction({
          customId: buildConfigRouteId({ action: "page", locale: "en-US", category: "models", page: "switch" }),
          kind: "select",
          values: ["switch"],
          harness,
        }),
      );
      expect(
        selectOptionValues(
          harness.edits.at(-1),
          buildConfigRouteId({ action: "model-provider-select", locale: "en-US", capability }),
        ),
      ).not.toContain(CONFIG_MODEL_CLEAR_VALUE);
    }
  });

  it("refuses an empty catalog rather than opening an empty picker", async () => {
    for (const capability of ["vision", "text"] as ConfigModelCapability[]) {
      const harness = makeHarness({ models: [] });
      await dispatch(
        harness,
        makeInteraction({
          customId: buildConfigRouteId({ action: "model-provider-select", locale: "en-US", capability }),
          kind: "select",
          values: ["google"],
          harness,
        }),
      );
      expect(harness.modals).toHaveLength(0);
      expect(harness.replies.at(-1)).toBeDefined();
    }
  });

  it("opens the picker with one page of models rather than a second panel page", async () => {
    const harness = makeHarness({ models: [{ id: 7, name: "gemini-2.5-pro", description: "Pro" }] });
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "model-provider-select", locale: "en-US", capability: "vision" }),
        kind: "select",
        values: [encodeConfigProviderPageValue("google", 0)],
        harness,
      }),
    );

    expect(harness.edits).toHaveLength(0);
    const modal = harness.modals.at(-1) as { custom_id: string };
    expect(modal.custom_id).toContain(":model-modal:");
    expect(modelModalOptions(modal).map((option) => option.value)).toEqual(["7"]);
  });

  it("keeps every eligible provider reachable for zero through sixty providers", async () => {
    const capabilities = CATALOG_MODEL_CAPABILITIES;
    const counts = [0, 1, 25, 26, 60];

    for (const count of counts) {
      const providersByCapability = Object.fromEntries(
        capabilities.map((capability) => [
          capability,
          Array.from({ length: count }, (_unused, index) => `${capability}-provider-${index + 1}`),
        ]),
      ) as Record<ConfigModelCapability, string[]>;

      for (const capability of capabilities) {
        const harness = makeHarness({ switchProviders: providersByCapability });
        await dispatch(
          harness,
          makeInteraction({
            customId: buildConfigRouteId({ action: "page", locale: "en-US", category: "models", page: "switch" }),
            kind: "select",
            values: ["switch"],
            harness,
          }),
        );

        const eligible = providersByCapability[capability];
        const reachable = new Set<string>();
        const selectRoute = buildConfigRouteId({ action: "model-provider-select", locale: "en-US", capability });
        const seenWindows = new Set<string>();
        let advance: string | null = null;

        // Advancing wraps, so the walk stops when it returns to a window it has already read.
        do {
          const panel = harness.edits.at(-1);
          expectValidComponentsV2Payload(panel);
          const values = selectOptionValues(panel, selectRoute);
          const windowKey = values.join("|");
          if (seenWindows.has(windowKey)) break;
          seenWindows.add(windowKey);

          advance = null;
          for (const value of values) {
            const decodedRange = decodeConfigProviderRangeValue(value);
            if (decodedRange) {
              advance = value;
              continue;
            }
            if (value !== CONFIG_MODEL_CLEAR_VALUE && value !== "none") reachable.add(value);
          }

          if (advance) {
            await dispatch(
              harness,
              makeInteraction({ customId: selectRoute, kind: "select", values: [advance], harness }),
            );
          }
        } while (advance);

        expect([...reachable].sort()).toEqual([...eligible].sort());
      }
    }
  });

  it("keeps every model reachable across the expanded provider page entries", async () => {
    const capabilities = CATALOG_MODEL_CAPABILITIES;
    const models = Array.from({ length: 60 }, (_unused, index) => ({
      id: index + 1,
      name: `model-${index + 1}`,
      description: null,
    }));

    for (const capability of capabilities) {
      const harness = makeHarness({ models });
      // A provider whose catalog overflows one modal page expands in place rather than opening a
      // picker that could only ever present its first 25 models.
      await dispatch(
        harness,
        makeInteraction({
          customId: buildConfigRouteId({ action: "model-provider-select", locale: "en-US", capability }),
          kind: "select",
          values: ["google"],
          harness,
        }),
      );
      expect(harness.modals).toHaveLength(0);
      const expanded = harness.edits.at(-1);
      expectValidComponentsV2Payload(expanded);

      const pageValues = selectOptionValues(
        expanded,
        buildConfigRouteId({ action: "model-provider-select", locale: "en-US", capability }),
      ).filter((value) => decodeConfigProviderPageValue(value) !== null);
      expect(pageValues).toHaveLength(Math.ceil(models.length / CONFIG_MODEL_PAGE_SIZE));

      const reachable = new Set<string>();
      for (const value of pageValues) {
        const pageHarness = makeHarness({ models });
        await dispatch(
          pageHarness,
          makeInteraction({
            customId: buildConfigRouteId({ action: "model-provider-select", locale: "en-US", capability }),
            kind: "select",
            values: [value],
            harness: pageHarness,
          }),
        );
        for (const option of modelModalOptions(pageHarness.modals.at(-1))) reachable.add(option.value);
      }

      expect([...reachable].sort()).toEqual(models.map((model) => String(model.id)).sort());
    }
  });

  it("keeps receipt, retry, stale, and unavailable Models repaints within their intended paths", async () => {
    const initial = makeHarness();
    await dispatch(
      initial,
      makeInteraction({
        customId: buildConfigRouteId({ action: "page", locale: "en-US", category: "models", page: "switch" }),
        kind: "select",
        values: ["switch"],
        harness: initial,
      }),
    );
    expectValidComponentsV2Payload(initial.edits.at(-1));

    const stale = makeHarness();
    await dispatch(
      stale,
      makeInteraction({
        customId: buildConfigRouteId({ action: "model-provider-select", locale: "en-US", capability: "text" }),
        kind: "select",
        values: ["retired-provider"],
        harness: stale,
      }),
    );
    // A retired provider is refused before the panel is touched, so it answers ephemerally rather
    // than repainting a page whose selector never changed.
    expect(stale.edits).toHaveLength(0);
    expect(stale.replies.at(-1)).toBeDefined();

    const staleRead = makeHarness({ readStatus: "stale" });
    await dispatch(
      staleRead,
      makeInteraction({
        customId: buildConfigRouteId({ action: "page", locale: "en-US", category: "models", page: "switch" }),
        kind: "select",
        values: ["switch"],
        harness: staleRead,
      }),
    );
    expectValidComponentsV2Payload(staleRead.edits.at(-1));

    const retry = makeHarness();
    await dispatch(
      retry,
      makeInteraction({
        customId: buildConfigRouteId({ action: "retry", locale: "en-US", category: "models", page: "switch" }),
        harness: retry,
      }),
    );
    expectValidComponentsV2Payload(retry.edits.at(-1));

    const unavailable = makeHarness({ unavailable: true });
    await dispatch(
      unavailable,
      makeInteraction({
        customId: buildConfigRouteId({ action: "page", locale: "en-US", category: "models", page: "switch" }),
        kind: "select",
        values: ["switch"],
        harness: unavailable,
      }),
    );
    if (unavailable.edits.length > 0) {
      expectValidComponentsV2Payload(unavailable.edits.at(-1));
    } else {
      expect(unavailable.replies).toHaveLength(1);
    }

    const resultCases = [
      { status: "already-selected" as const },
      { status: "success" as const, modelName: "model-7", reembedded: false },
      { status: "openrouter-moved" as const },
      { status: "write-failed" as const },
    ];
    for (const result of resultCases) {
      const harness = makeHarness({
        modelOperationsOverrides: {
          setCapabilityModel: async () => result,
        },
      });
      harness.selectValues[buildConfigModalFieldId("model_choice", "nonce1234567")] = "7";
      await dispatch(
        harness,
        makeInteraction({
          customId: buildConfigRouteId({
            action: "model-modal-submit",
            locale: "en-US",
            capability: "vision",
            provider: "google",
            nonce: "nonce1234567",
          }),
          kind: "modal",
          harness,
        }),
      );
      expectValidComponentsV2Payload(harness.edits.at(-1));
    }
  });
});

describe("config models capability writes", () => {
  it("rejects endpoint capabilities without model repository or cache writes", async () => {
    const providers = spyOn(llmProviderRepo, "loadSavedProviderConfigs").mockResolvedValue([]);
    const modelUpdate = spyOn(configRepository, "updateModelConfig").mockResolvedValue(true);
    const naiUpdate = spyOn(configRepository, "updateNovelaiImagegenConfig").mockResolvedValue(true);
    const invalidate = spyOn(tomoriStateCache, "invalidateTomoriStateCache").mockImplementation(() => undefined);

    for (const capability of ["tts", "stt"] as const) {
      const setResult = await configModelOperations.setCapabilityModel({
        tomoriState: makeState(),
        serverDiscId: "guild-1",
        capability,
        provider: "custom:12",
        modelId: 7,
      });
      const clearResult = await configModelOperations.clearCapabilityModel({
        tomoriState: makeState(),
        serverDiscId: "guild-1",
        capability,
      });

      expect(setResult.status).toBe("not-found");
      expect(clearResult.status).toBe("not-clearable");
    }

    expect(providers).not.toHaveBeenCalled();
    expect(modelUpdate).not.toHaveBeenCalled();
    expect(naiUpdate).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();

    providers.mockRestore();
    modelUpdate.mockRestore();
    naiUpdate.mockRestore();
    invalidate.mockRestore();
  });

  it("writes the vision column and invalidates the workspace cache after success", async () => {
    const providers = spyOn(llmProviderRepo, "loadSavedProviderConfigs").mockResolvedValue([
      makeSavedProvider("google"),
    ]);
    const models = spyOn(llmModelRepo, "loadAvailableModelsForProvider").mockResolvedValue([
      { llm_id: 7, llm_codename: "gemini-vision", llm_provider: "google", sees_images: true },
    ] as never);
    const update = spyOn(configRepository, "updateModelConfig").mockResolvedValue(true);

    const state = makeState();
    const result = await configModelOperations.setCapabilityModel({
      tomoriState: state,
      serverDiscId: "guild-1",
      capability: "vision",
      provider: "google",
      modelId: 7,
    });

    expect(result.status).toBe("success");
    expect(update).toHaveBeenCalledWith(9, { vision_llm_id: 7 });
    providers.mockRestore();
    models.mockRestore();
    update.mockRestore();
  });

  it("sends a NovelAI image pick to the NovelAI column and a standard pick to the standard column", async () => {
    const providers = spyOn(llmProviderRepo, "loadSavedProviderConfigs").mockResolvedValue([
      makeSavedProvider("novelai", { diffusion_model_id: 4 }),
      makeSavedProvider("google", { diffusion_model_id: 5 }),
    ]);
    const diffusion = spyOn(llmModelRepo, "loadAvailableDiffusionModels").mockImplementation(
      async (provider: string) =>
        provider === "novelai"
          ? ([{ diffusion_model_id: 4, codename: "nai-diffusion-4", provider: "novelai" }] as never)
          : ([{ diffusion_model_id: 5, codename: "imagen", provider: "google" }] as never),
    );
    const modelUpdate = spyOn(configRepository, "updateModelConfig").mockResolvedValue(true);
    const naiUpdate = spyOn(configRepository, "updateNovelaiImagegenConfig").mockResolvedValue(true);

    const state = makeState();
    await configModelOperations.setCapabilityModel({
      tomoriState: state,
      serverDiscId: "guild-1",
      capability: "nai-image",
      provider: "novelai",
      modelId: 4,
    });
    expect(naiUpdate).toHaveBeenCalledWith(9, { nai_diffusion_model_id: 4 });

    await configModelOperations.setCapabilityModel({
      tomoriState: state,
      serverDiscId: "guild-1",
      capability: "image",
      provider: "google",
      modelId: 5,
    });
    expect(modelUpdate).toHaveBeenCalledWith(9, { diffusion_model_id: 5 });

    providers.mockRestore();
    diffusion.mockRestore();
    modelUpdate.mockRestore();
    naiUpdate.mockRestore();
  });

  it("refuses a NovelAI provider offered under the Standard Image slot", async () => {
    const providers = spyOn(llmProviderRepo, "loadSavedProviderConfigs").mockResolvedValue([
      makeSavedProvider("novelai", { diffusion_model_id: 4 }),
    ]);
    const update = spyOn(configRepository, "updateModelConfig").mockResolvedValue(true);

    const result = await configModelOperations.setCapabilityModel({
      tomoriState: makeState(),
      serverDiscId: "guild-1",
      capability: "image",
      provider: "novelai",
      modelId: 4,
    });

    expect(result.status).toBe("not-found");
    expect(update).not.toHaveBeenCalled();
    providers.mockRestore();
    update.mockRestore();
  });

  it("re-embeds stored documents when the embedding family changes", async () => {
    const providers = spyOn(llmProviderRepo, "loadSavedProviderConfigs").mockResolvedValue([
      makeSavedProvider("google", { embedding_model_id: 3 }),
    ]);
    const embeddings = spyOn(llmModelRepo, "loadAvailableEmbeddingModels").mockResolvedValue([
      { embedding_model_id: 3, codename: "text-embedding-004", provider: "google", model_family: "gemini" },
    ] as never);
    const byId = spyOn(llmModelRepo, "loadEmbeddingModelById").mockImplementation(async (id: number) =>
      id === 3
        ? ({ embedding_model_id: 3, codename: "text-embedding-004", model_family: "gemini" } as never)
        : ({ embedding_model_id: 2, codename: "old-model", model_family: "openai" } as never),
    );
    const update = spyOn(configRepository, "updateModelConfig").mockResolvedValue(true);
    const ragAvailable = spyOn(ragAvailability, "isRagAvailable").mockReturnValue(true);
    const countDocuments = spyOn(serverMemoryRepository, "countDocuments").mockResolvedValue(4);
    const credentials = spyOn(credentialResolver, "resolveCapabilityCredentials").mockResolvedValue({
      apiKey: "key",
    } as never);
    const reembed = spyOn(ragRepository, "reembedServerDocuments").mockResolvedValue(undefined as never);

    const result = await configModelOperations.setCapabilityModel({
      tomoriState: makeState({ config: { embedding_model_id: 2 } }),
      serverDiscId: "guild-1",
      capability: "embedding",
      provider: "google",
      modelId: 3,
    });

    expect(result).toMatchObject({ status: "success", reembedded: true });
    expect(reembed).toHaveBeenCalledTimes(1);

    for (const spy of [providers, embeddings, byId, update, ragAvailable, countDocuments, credentials, reembed]) {
      spy.mockRestore();
    }
  });

  it("refuses to clear a slot whose absorbed command has no clear path", async () => {
    const update = spyOn(configRepository, "updateModelConfig").mockResolvedValue(true);
    for (const capability of CATALOG_MODEL_CAPABILITIES.filter(
      (candidate) => candidate === "text" || candidate === "embedding" || candidate === "video",
    )) {
      const result = await configModelOperations.clearCapabilityModel({
        tomoriState: makeState(),
        serverDiscId: "guild-1",
        capability,
      });
      expect(result.status).toBe("not-clearable");
    }
    expect(update).not.toHaveBeenCalled();
    update.mockRestore();
  });

  it("reports an unchanged slot as no change rather than writing it again", async () => {
    const update = spyOn(configRepository, "updateModelConfig").mockResolvedValue(true);
    const result = await configModelOperations.clearCapabilityModel({
      tomoriState: makeState(),
      serverDiscId: "guild-1",
      capability: "vision",
    });
    expect(result.status).toBe("already-clear");
    expect(update).not.toHaveBeenCalled();
    update.mockRestore();
  });

  it("acknowledges the interaction before the model write reaches the repository", async () => {
    const providers = spyOn(llmProviderRepo, "loadSavedProviderConfigs").mockResolvedValue([
      makeSavedProvider("google"),
    ]);
    const models = spyOn(llmModelRepo, "loadAvailableModelsForProvider").mockResolvedValue([
      { llm_id: 7, llm_codename: "gemini-vision", llm_provider: "google", sees_images: true },
    ] as never);

    let acknowledgedAtWrite: boolean | null = null;
    const harness = makeHarness();
    harness.selectValues[buildConfigModalFieldId("model_choice", "nonce1234567")] = "7";
    const interaction = makeInteraction({
      customId: buildConfigRouteId({
        action: "model-modal-submit",
        locale: "en-US",
        capability: "vision",
        provider: "google",
        nonce: "nonce1234567",
      }),
      kind: "modal",
      harness,
    });
    const update = spyOn(configRepository, "updateModelConfig").mockImplementation(async () => {
      acknowledgedAtWrite = (interaction as unknown as { deferred: boolean }).deferred;
      return true;
    });

    await dispatch(harness, interaction);

    expect(acknowledgedAtWrite).toBe(true);
    expect(harness.telemetry).toContain("server-config.workspace.model.set");
    providers.mockRestore();
    models.mockRestore();
    update.mockRestore();
  });
});

describe("config models authorization", () => {
  it("writes nothing when a guild member replays a manager-owned model select", async () => {
    const update = spyOn(configRepository, "updateModelConfig").mockResolvedValue(true);
    const naiUpdate = spyOn(configRepository, "updateNovelaiImagegenConfig").mockResolvedValue(true);
    const harness = makeHarness({ isManager: false });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "model-modal-submit",
          locale: "en-US",
          capability: "vision",
          provider: "google",
          nonce: "nonce1234567",
        }),
        kind: "modal",
        isManager: false,
        harness,
      }),
    );

    expect(update).not.toHaveBeenCalled();
    expect(naiUpdate).not.toHaveBeenCalled();
    expect(renderedText(harness.edits.at(-1))).toContain("Permission Required");
    update.mockRestore();
    naiUpdate.mockRestore();
  });

  it("writes nothing when a guild member replays provider-independent image clear", async () => {
    const modelUpdate = spyOn(configRepository, "updateModelConfig").mockResolvedValue(true);
    const naiUpdate = spyOn(configRepository, "updateNovelaiImagegenConfig").mockResolvedValue(true);
    const harness = makeHarness({
      isManager: false,
      state: makeState({ config: { diffusion_model_id: 41, nai_diffusion_model_id: 42 } }),
    });

    for (const capability of ["image", "nai-image"] as const) {
      await dispatch(
        harness,
        makeInteraction({
          customId: buildConfigRouteId({ action: "model-provider-select", locale: "en-US", capability }),
          kind: "select",
          values: [CONFIG_MODEL_CLEAR_VALUE],
          isManager: false,
          harness,
        }),
      );
    }

    expect(modelUpdate).not.toHaveBeenCalled();
    expect(naiUpdate).not.toHaveBeenCalled();
    expect(renderedText(harness.edits.at(-1))).toContain("Permission Required");
    modelUpdate.mockRestore();
    naiUpdate.mockRestore();
  });

  it("writes nothing when a guild member replays a manager-owned randomizer toggle", async () => {
    const update = spyOn(configRepository, "updateChatConfig").mockResolvedValue(true);
    // The chain is non-empty so the operation's own precondition would let the write through: the
    // route gate has to be the only thing stopping it, or this test would pass without one.
    const harness = makeHarness({
      isManager: false,
      state: makeState({ config: { fallback_model_refs: [{ type: "llm", id: 7 }] } }),
    });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "randomizer-set", locale: "en-US", enabled: true }),
        isManager: false,
        harness,
      }),
    );

    expect(update).not.toHaveBeenCalled();
    expect(renderedText(harness.edits.at(-1))).toContain("Permission Required");
    update.mockRestore();
  });

  it("denies Image Generation to a DM workspace owner while allowing the other three pages", async () => {
    const update = spyOn(configRepository, "updateNovelaiImagegenConfig").mockResolvedValue(true);
    const harness = makeHarness({ inGuild: false });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "nai-parameters-open", locale: "en-US" }),
        inGuild: false,
        harness,
      }),
    );

    expect(harness.modals).toHaveLength(0);
    expect(update).not.toHaveBeenCalled();
    update.mockRestore();
  });
});

describe("config models parameters page", () => {
  it("builds the sampling modal with four Text Inputs and the generation modal with a String Select", async () => {
    const harness = makeHarness();
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "sampling-open", locale: "en-US", provider: "google" }),
        harness,
      }),
    );
    const sampling = harness.modals.at(-1) as { components: Array<{ component: { type: number } }> };
    expect(sampling.components).toHaveLength(4);
    expect(sampling.components.map((field) => field.component.type)).toEqual([4, 4, 4, 4]);

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "generation-open", locale: "en-US", provider: "google" }),
        harness,
      }),
    );
    const generation = harness.modals.at(-1) as { components: Array<{ component: { type: number } }> };
    expect(generation.components.map((field) => field.component.type)).toEqual([4, 4, 4, 3]);
  });

  it("refuses to prefill a sampling modal for a provider the workspace no longer has", async () => {
    const harness = makeHarness({ parametersProviders: ["google"] });
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "sampling-open", locale: "en-US", provider: "openrouter" }),
        harness,
      }),
    );
    expect(harness.modals).toHaveLength(0);
    expect(harness.replies).toHaveLength(1);
  });

  it("rejects an out-of-range sampler value instead of storing it", async () => {
    const providers = spyOn(llmProviderRepo, "loadSavedProviderConfigs").mockResolvedValue([
      makeSavedProvider("google"),
    ]);
    const upsert = spyOn(llmProviderRepo, "upsertSavedProviderConfig").mockResolvedValue(true);

    const result = await configModelOperations.setProviderParameters({
      tomoriState: makeState(),
      serverDiscId: "guild-1",
      provider: "google",
      patch: { temperature: 5 },
    });

    expect(result.status).toBe("invalid-value");
    expect(upsert).not.toHaveBeenCalled();
    providers.mockRestore();
    upsert.mockRestore();
  });

  it("mirrors a saved parameter change into the split config tables for the active provider only", async () => {
    const providers = spyOn(llmProviderRepo, "loadSavedProviderConfigs").mockResolvedValue([
      makeSavedProvider("google"),
      makeSavedProvider("openrouter"),
    ]);
    const upsert = spyOn(llmProviderRepo, "upsertSavedProviderConfig").mockResolvedValue(true);
    const modelUpdate = spyOn(configRepository, "updateModelConfig").mockResolvedValue(true);
    const chatUpdate = spyOn(configRepository, "updateChatConfig").mockResolvedValue(true);

    await configModelOperations.setProviderParameters({
      tomoriState: makeState(),
      serverDiscId: "guild-1",
      provider: "google",
      patch: { temperature: 0.6 },
    });
    expect(modelUpdate).toHaveBeenCalledTimes(1);
    expect(chatUpdate).toHaveBeenCalledTimes(1);

    modelUpdate.mockClear();
    chatUpdate.mockClear();
    await configModelOperations.setProviderParameters({
      tomoriState: makeState(),
      serverDiscId: "guild-1",
      provider: "openrouter",
      patch: { temperature: 0.6 },
    });
    expect(modelUpdate).not.toHaveBeenCalled();
    expect(chatUpdate).not.toHaveBeenCalled();

    providers.mockRestore();
    upsert.mockRestore();
    modelUpdate.mockRestore();
    chatUpdate.mockRestore();
  });
});

describe("config models stop strings", () => {
  it("removes only the unchecked strings and keeps the speaker pattern the modal reported", async () => {
    const update = spyOn(configRepository, "updateChatConfig").mockResolvedValue(true);
    const result = await configModelOperations.manageStopStrings({
      tomoriState: makeState({ config: { llm_stop_strings: ["User:", "Assistant:", "System:"] } }),
      serverDiscId: "guild-1",
      presentedStopStrings: ["User:", "Assistant:", "System:"],
      keptIndices: [0, 2],
      speakerPatternEnabled: true,
    });

    expect(result).toMatchObject({ status: "success", removedCount: 1 });
    expect(update).toHaveBeenCalledWith(9, {
      llm_stop_strings: ["User:", "System:"],
      llm_stop_speaker_pattern_enabled: true,
    });
    update.mockRestore();
  });

  it("refuses a submission whose presented list no longer matches the stored list", async () => {
    const update = spyOn(configRepository, "updateChatConfig").mockResolvedValue(true);
    const result = await configModelOperations.manageStopStrings({
      tomoriState: makeState({ config: { llm_stop_strings: ["User:", "Narrator:"] } }),
      serverDiscId: "guild-1",
      presentedStopStrings: ["User:", "Assistant:"],
      keptIndices: [0],
      speakerPatternEnabled: false,
    });

    expect(result.status).toBe("stale");
    expect(update).not.toHaveBeenCalled();
    update.mockRestore();
  });

  it("treats a submit that carried no checkbox payload as stale rather than as removing everything", async () => {
    const state = makeState({ config: { llm_stop_strings: ["User:", "Assistant:"] } });
    const harness = makeHarness({ state });
    const update = spyOn(configRepository, "updateChatConfig").mockResolvedValue(true);
    const { computeStopStringFingerprint } = await import("@/utils/discord/configPanelCatalog");

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "stop-manage-submit",
          locale: "en-US",
          fp: computeStopStringFingerprint(9, ["User:", "Assistant:"]),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        harness,
      }),
    );

    expect(update).not.toHaveBeenCalled();
    expect(renderedText(harness.edits.at(-1))).toContain("Panel Out Of Date");
    update.mockRestore();
  });
});

describe("config models logit bias", () => {
  it("keeps the entries a checkbox group reported and removes the rest of that page", async () => {
    const entries = [
      { id: "a", text: "delve", value: -3, kind: "text", tokenizations: [] },
      { id: "b", text: "moreover", value: -3, kind: "text", tokenizations: [] },
    ];
    const update = spyOn(configRepository, "updateChatConfig").mockResolvedValue(true);
    const result = await configModelOperations.removeLogitBias({
      tomoriState: makeState({ config: { llm_logit_biases: entries } }),
      serverDiscId: "guild-1",
      presentedIds: ["a", "b"],
      keptIds: ["a"],
    });

    expect(result).toMatchObject({ status: "success", removedCount: 1 });
    expect(update).toHaveBeenCalledWith(9, { llm_logit_biases: [entries[0]] });
    update.mockRestore();
  });

  it("refuses a removal naming an entry the workspace no longer holds", async () => {
    const update = spyOn(configRepository, "updateChatConfig").mockResolvedValue(true);
    const result = await configModelOperations.removeLogitBias({
      tomoriState: makeState({ config: { llm_logit_biases: [] } }),
      serverDiscId: "guild-1",
      presentedIds: ["a"],
      keptIds: [],
    });
    expect(result.status).toBe("stale");
    expect(update).not.toHaveBeenCalled();
    update.mockRestore();
  });

  it("rejects an uploaded list whose entries are not text and value pairs", async () => {
    const update = spyOn(configRepository, "updateChatConfig").mockResolvedValue(true);
    const result = await configModelOperations.uploadLogitBias({
      tomoriState: makeState(),
      serverDiscId: "guild-1",
      payload: [{ nope: 1 }],
    });
    expect(result.status).toBe("invalid-file");
    expect(update).not.toHaveBeenCalled();
    update.mockRestore();
  });
});

describe("config models fallbacks and randomizer", () => {
  it("keeps an untouched slot and clears only the slot that asked to be cleared", async () => {
    const providers = spyOn(llmProviderRepo, "loadSavedProviderConfigs").mockResolvedValue([
      makeSavedProvider("google"),
    ]);
    const endpoints = spyOn(llmProviderRepo, "loadCustomEndpointsForServer").mockResolvedValue([]);
    const models = spyOn(llmModelRepo, "loadAvailableModelsForProvider").mockResolvedValue([
      { llm_id: 7, llm_codename: "gemini-2.5-pro", llm_provider: "google" },
    ] as never);
    const write = spyOn(llmOverrideRepo, "setFallbackModelRefs").mockResolvedValue(true);

    const result = await configModelOperations.setFallbackChain({
      tomoriState: makeState({
        config: {
          llm_id: 1,
          fallback_model_refs: [
            { type: "llm", id: 7 },
            { type: "llm", id: 8 },
          ],
        },
      }),
      serverDiscId: "guild-1",
      provider: "google",
      slotValues: ["", "__none__", "", "", ""],
    });

    expect(result).toMatchObject({ status: "success" });
    expect(write).toHaveBeenCalledWith(9, [{ type: "llm", id: 7 }], { serverDiscId: "guild-1" });

    providers.mockRestore();
    endpoints.mockRestore();
    models.mockRestore();
    write.mockRestore();
  });

  it("drops only the slot whose pick no longer resolves and still writes the rest of the chain", async () => {
    const providers = spyOn(llmProviderRepo, "loadSavedProviderConfigs").mockResolvedValue([
      makeSavedProvider("google"),
    ]);
    const endpoints = spyOn(llmProviderRepo, "loadCustomEndpointsForServer").mockResolvedValue([]);
    const models = spyOn(llmModelRepo, "loadAvailableModelsForProvider").mockResolvedValue([
      { llm_id: 7, llm_codename: "gemini-2.5-pro", llm_provider: "google" },
    ] as never);
    const write = spyOn(llmOverrideRepo, "setFallbackModelRefs").mockResolvedValue(true);

    const result = await configModelOperations.setFallbackChain({
      tomoriState: makeState({ config: { llm_id: 1, fallback_model_refs: [{ type: "llm", id: 9 }] } }),
      serverDiscId: "guild-1",
      provider: "google",
      // Slot two names a model the catalog no longer offers, which is what the legacy command
      // silently skips rather than treating as a failure of the whole submission.
      slotValues: ["gemini-2.5-pro", "retired-model", "", "", ""],
    });

    expect(result).toMatchObject({ status: "success" });
    expect(write).toHaveBeenCalledWith(9, [{ type: "llm", id: 7 }], { serverDiscId: "guild-1" });

    providers.mockRestore();
    endpoints.mockRestore();
    models.mockRestore();
    write.mockRestore();
  });

  it("drops a custom-endpoint pick the selected provider does not own instead of writing it", async () => {
    const providers = spyOn(llmProviderRepo, "loadSavedProviderConfigs").mockResolvedValue([
      makeSavedProvider("google"),
    ]);
    const endpoints = spyOn(llmProviderRepo, "loadCustomEndpointsForServer").mockResolvedValue([
      { custom_endpoint_id: 5, connection_id: 99, capability: "text", label: "other" },
    ] as never);
    const models = spyOn(llmModelRepo, "loadAvailableModelsForProvider").mockResolvedValue([] as never);
    const write = spyOn(llmOverrideRepo, "setFallbackModelRefs").mockResolvedValue(true);

    const result = await configModelOperations.setFallbackChain({
      tomoriState: makeState(),
      serverDiscId: "guild-1",
      provider: "google",
      slotValues: ["ce:5", "", "", "", ""],
    });

    expect(result.status).toBe("no-changes");
    expect(write).not.toHaveBeenCalled();

    providers.mockRestore();
    endpoints.mockRestore();
    models.mockRestore();
    write.mockRestore();
  });

  it("refuses a fallback pick that is already the primary model", async () => {
    const providers = spyOn(llmProviderRepo, "loadSavedProviderConfigs").mockResolvedValue([
      makeSavedProvider("google"),
    ]);
    const endpoints = spyOn(llmProviderRepo, "loadCustomEndpointsForServer").mockResolvedValue([]);
    const models = spyOn(llmModelRepo, "loadAvailableModelsForProvider").mockResolvedValue([
      { llm_id: 1, llm_codename: "gemini-2.5-flash", llm_provider: "google" },
    ] as never);
    const write = spyOn(llmOverrideRepo, "setFallbackModelRefs").mockResolvedValue(true);

    const result = await configModelOperations.setFallbackChain({
      tomoriState: makeState(),
      serverDiscId: "guild-1",
      provider: "google",
      slotValues: ["gemini-2.5-flash", "", "", "", ""],
    });

    expect(result.status).toBe("primary-conflict");
    expect(write).not.toHaveBeenCalled();

    providers.mockRestore();
    endpoints.mockRestore();
    models.mockRestore();
    write.mockRestore();
  });

  it("refuses to enable the randomizer while the fallback chain is empty", async () => {
    const update = spyOn(configRepository, "updateChatConfig").mockResolvedValue(true);
    const result = await configModelOperations.setModelRandomizer({
      tomoriState: makeState(),
      serverDiscId: "guild-1",
      enabled: true,
    });
    expect(result.status).toBe("requires-fallbacks");
    expect(update).not.toHaveBeenCalled();
    update.mockRestore();
  });

  it("disables the randomizer On button while the precondition is unmet", async () => {
    const harness = makeHarness();
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "page", locale: "en-US", category: "models", page: "fallbacks" }),
        kind: "select",
        values: ["fallbacks"],
        harness,
      }),
    );

    const payload = JSON.parse(renderedText(harness.edits.at(-1)));
    const buttons = payload.components[0].components
      .flatMap((row: { components?: Array<{ customId?: string; disabled?: boolean }> }) => row.components ?? [])
      .filter((component: { customId?: string }) => component.customId?.includes("randomizer-set"));
    const enableButton = buttons.find((button: { customId: string }) => button.customId.endsWith(":1"));
    expect(enableButton.disabled).toBe(true);
  });

  it("opens the fallback modal on the option page the provider entry named", async () => {
    const harness = makeHarness();
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "fallback-provider-select", locale: "en-US" }),
        kind: "select",
        values: [encodeConfigProviderPageValue("google", 0)],
        harness,
      }),
    );

    const modal = harness.modals.at(-1) as { custom_id: string; components: unknown[] };
    expect(modal.components).toHaveLength(5);
    expect(modal.custom_id).toBe(
      buildConfigRouteId({
        action: "fallback-submit",
        locale: "en-US",
        provider: "google",
        start: 0,
        nonce: "nonce1234567",
      }),
    );
  });

  it("round-trips a fallback provider page value including a custom label", () => {
    expect(decodeConfigProviderPageValue(encodeConfigProviderPageValue("custom:12", 48))).toEqual({
      provider: "custom:12",
      start: 48,
    });
    expect(decodeConfigProviderPageValue("google")).toBeNull();
  });

  it("reads every fallback slot the modal submitted through its own field id", async () => {
    const state = makeState();
    const harness = makeHarness({ state });
    for (let slot = 0; slot < 5; slot += 1) {
      harness.selectValues[buildConfigFallbackSlotId(slot, "nonce1234567")] = slot === 0 ? "gemini-2.5-pro" : undefined;
    }
    const providers = spyOn(llmProviderRepo, "loadSavedProviderConfigs").mockResolvedValue([
      makeSavedProvider("google"),
    ]);
    const endpoints = spyOn(llmProviderRepo, "loadCustomEndpointsForServer").mockResolvedValue([]);
    const models = spyOn(llmModelRepo, "loadAvailableModelsForProvider").mockResolvedValue([
      { llm_id: 7, llm_codename: "gemini-2.5-pro", llm_provider: "google" },
    ] as never);
    const write = spyOn(llmOverrideRepo, "setFallbackModelRefs").mockResolvedValue(true);

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "fallback-submit",
          locale: "en-US",
          provider: "google",
          start: 0,
          nonce: "nonce1234567",
        }),
        kind: "modal",
        harness,
      }),
    );

    expect(write).toHaveBeenCalledWith(9, [{ type: "llm", id: 7 }], { serverDiscId: "guild-1" });
    expect(harness.telemetry).toContain("server-config.workspace.fallbacks.set");

    providers.mockRestore();
    endpoints.mockRestore();
    models.mockRestore();
    write.mockRestore();
  });
});

describe("config models image generation", () => {
  it("restores the built-in defaults when the tag modal is submitted empty", async () => {
    const update = spyOn(configRepository, "updateNovelaiImagegenConfig").mockResolvedValue(true);
    const result = await configModelOperations.setImageDefaultTags({
      tomoriState: makeState(),
      serverDiscId: "guild-1",
      negative: false,
      rawInput: "   ",
    });

    expect(result).toMatchObject({ status: "success", reset: true });
    expect(update).toHaveBeenCalledTimes(1);
    update.mockRestore();
  });

  it("writes the negative list only when the route says the field was the negative one", async () => {
    const update = spyOn(configRepository, "updateNovelaiImagegenConfig").mockResolvedValue(true);
    await configModelOperations.setImageDefaultTags({
      tomoriState: makeState(),
      serverDiscId: "guild-1",
      negative: true,
      rawInput: "lowres, blurry",
    });
    expect(update).toHaveBeenCalledWith(9, { image_default_negative_tags: ["lowres", "blurry"] });
    update.mockRestore();
  });

  it("rejects a NovelAI step count outside the command's own bounds", async () => {
    const update = spyOn(configRepository, "updateNovelaiImagegenConfig").mockResolvedValue(true);
    const result = await configModelOperations.setNaiImageParameters({
      tomoriState: makeState(),
      serverDiscId: "guild-1",
      values: { sampler: null, steps: "99", scale: "", noiseSchedule: null, cfgRescale: "" },
    });
    expect(result.status).toBe("invalid-steps");
    expect(update).not.toHaveBeenCalled();
    update.mockRestore();
  });

  it("stores an empty NovelAI field as null so the built-in default resolves at read time", async () => {
    const update = spyOn(configRepository, "updateNovelaiImagegenConfig").mockResolvedValue(true);
    await configModelOperations.setNaiImageParameters({
      tomoriState: makeState(),
      serverDiscId: "guild-1",
      values: { sampler: "k_euler", steps: "", scale: "", noiseSchedule: "", cfgRescale: "" },
    });
    expect(update).toHaveBeenCalledWith(9, {
      nai_sampler: "k_euler",
      nai_steps: null,
      nai_scale: null,
      nai_noise_schedule: null,
      nai_cfg_rescale: null,
    });
    update.mockRestore();
  });
});

describe("config models view loaders", () => {
  it("reports the eligible provider list and the two override counts for the Switch page", async () => {
    const providers = spyOn(llmProviderRepo, "loadSavedProviderConfigs").mockResolvedValue([
      makeSavedProvider("google"),
    ]);
    const channelOverrides = spyOn(llmOverrideRepo, "getAllChannelLlmOverridesForServer").mockResolvedValue([
      { channelDiscId: "c1", llm: {} },
    ] as never);
    const personaOverrides = spyOn(llmOverrideRepo, "loadPersonaLlmOverridesForServer").mockResolvedValue([
      { persona_id: 55, llm_id: 7 },
      { persona_id: 56, llm_id: 8 },
    ]);

    const view = await loadConfigSwitchModelsView(makeState(), undefined);
    expect(view.slots).toHaveLength(6);
    expect(view.slots.map((slot) => slot.capability)).toEqual(CATALOG_MODEL_CAPABILITIES);
    expect(providers).toHaveBeenCalledTimes(6);
    expect(view.channelOverrideCount).toBe(1);
    expect(view.personaOverrideCount).toBe(2);
    expect(view.imageGenerationEnabled).toBe(true);
    expect(view.videoGenerationEnabled).toBe(false);
    expect(view.speechCapabilityEnabled).toBe(true);

    const payload = buildConfigPanelPayload({
      locale: "en-US",
      actor: { workspaceKind: "guild", isManager: true },
      category: "models",
      page: "switch",
      personas: [makeState()],
      selectedPersonaId: 55,
      readStatus: "fresh",
      switchModelsView: view,
    });
    const contents = textDisplayContents(payload);
    expect(contents.some((content) => content.includes("Image generation is enabled."))).toBe(false);
    expect(contents.some((content) => content.includes("Video generation is disabled."))).toBe(true);

    providers.mockRestore();
    channelOverrides.mockRestore();
    personaOverrides.mockRestore();
  });

  it("falls back to the active Text provider when the requested one is gone", async () => {
    const providers = spyOn(llmProviderRepo, "loadSavedProviderConfigs").mockResolvedValue([
      makeSavedProvider("google"),
    ]);
    const view = await loadConfigParametersView(makeState(), "openrouter", 0);
    expect(view.selectedProvider).toBe("google");
    providers.mockRestore();
  });

  it("renders effective NovelAI values rather than the stored nulls", () => {
    const view = loadConfigImageGenerationView(makeState(), "en-US");
    expect(view.sampler.length).toBeGreaterThan(0);
    expect(Number(view.steps)).toBeGreaterThan(0);
  });

  it("expands one provider into one entry per option page for the fallback selector", async () => {
    const providers = spyOn(llmProviderRepo, "loadSavedProviderConfigs").mockResolvedValue([
      makeSavedProvider("google"),
    ]);
    const models = spyOn(llmModelRepo, "loadAvailableModelsForProvider").mockResolvedValue(
      Array.from({ length: 50 }, (_entry, index) => ({
        llm_id: index + 1,
        llm_codename: `model-${index + 1}`,
        llm_provider: "google",
      })) as never,
    );

    const view = await loadConfigFallbacksView(makeState(), "en-US", "google");
    expect(view.providerEntries.length).toBeGreaterThan(1);
    expect(decodeConfigProviderPageValue(view.providerEntries[1].value)?.start).toBe(24);

    providers.mockRestore();
    models.mockRestore();
  });

  it("marks the current assignment as the picker default", async () => {
    const harness = makeHarness({ models: [{ id: 1, name: "gemini-2.5-flash", description: null }] });
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "model-provider-select", locale: "en-US", capability: "text" }),
        kind: "select",
        values: ["google"],
        harness,
      }),
    );

    const options = modelModalOptions(harness.modals.at(-1)) as Array<{ value: string; default?: boolean }>;
    expect(options).toHaveLength(1);
    expect(options[0]?.default).toBe(true);
  });
});

describe("config models modal field identity", () => {
  it("names every sampling field with the nonce the route carries", () => {
    for (const field of ["temperature", "min_p", "top_p", "top_k"]) {
      expect(buildConfigModalFieldId(field, "nonce1234567")).toBe(`${field}_nonce1234567`);
    }
  });
});
