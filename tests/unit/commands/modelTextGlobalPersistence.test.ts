import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ChatInputCommandInteraction, Client } from "discord.js";
import type { ErrorContext, FallbackModelRef, LlmRow, NaiPresetRow, TomoriState, UserRow } from "@/types/db/schema";
// Real namespaces captured at link time, before any `mock.module` below runs.
// `mock.module` is process-global and never restored, so every factory spreads
// the real surface and overrides only what this file controls.
import * as realTomoriStateCache from "@/utils/cache/tomoriStateCache";
import * as realRepositories from "@/utils/db/repositories";
import * as realCommandRegistry from "@/utils/discord/commandRegistry";
import * as realOpenrouterModelMigrationNotice from "@/utils/discord/openrouterModelMigrationNotice";
import * as realProviderPicker from "@/utils/discord/providerPicker";
import * as realEmbeds from "@/utils/discord/ui/embeds";
import * as realModals from "@/utils/discord/ui/modals";
import * as realPersonaWorkflow from "@/utils/discord/ui/personaWorkflow";
import * as realLogitBiasResolver from "@/utils/provider/logitBiasResolver";
import * as realProviderInfoRegistry from "@/utils/provider/providerInfoRegistry";
import * as realSavedProviderConfig from "@/utils/provider/savedProviderConfig";
import * as realLocalizer from "@/utils/text/localizer";
import { createScopedModuleMocker, overrideMembers, stubLogMembers } from "../../helpers/mockSurface";

interface Scenario {
  branch: "custom" | "regular";
  modelUpdated: boolean;
  chatUpdated: boolean;
  presetApplied: boolean;
  replaceResult: boolean;
  selectedModel: LlmRow;
  naiPresets: NaiPresetRow[];
  liveFallbackRefs: FallbackModelRef[];
  savedFallbackRefs: FallbackModelRef[];
}

interface InfoOptions {
  titleKey: string;
  descriptionKey: string;
}

interface ErrorLog {
  message: string;
  error: Error;
  context: ErrorContext;
}

const chronology: string[] = [];
const invalidations: string[] = [];
const infoReplies: InfoOptions[] = [];
const replacements: InfoOptions[] = [];
const errorLogs: ErrorLog[] = [];
const presetCalls: Array<{ serverId: number; preset: NaiPresetRow; model: string; serverDiscId: string }> = [];
const modelConfigPatches: Array<Record<string, unknown>> = [];
const chatConfigPatches: Array<Record<string, unknown>> = [];

let scenario: Scenario;

function makeModel(codename: string, provider = "provider-a"): LlmRow {
  return {
    llm_id: 42,
    llm_codename: codename,
    llm_provider: provider,
    llm_description: codename,
    ja_description: codename,
    is_scoped_registration: false,
    is_free: false,
    has_tools: false,
    sees_images: false,
    sees_videos: false,
    supports_structoutput: false,
  } as unknown as LlmRow;
}

const defaultPreset = {
  preset_name: "Carefree-Kayra",
  model_target: "kayra",
  is_default: true,
  preset_desc: "Default Kayra preset",
  ja_preset_desc: "Default Kayra preset",
  parameters: { temperature: 1.2, top_p: 0.9, top_k: 20, min_p: 0.05 },
} satisfies NaiPresetRow;

const tomoriState = {
  server_id: 7,
  persona_id: 70,
  persona_nickname: "Tomori",
  llm: {
    llm_id: 1,
    llm_codename: "current-model",
    llm_provider: "current-provider",
  },
  get config() {
    return {
      llm_id: 1,
      llm_temperature: 1,
      llm_top_p: 0.95,
      llm_top_k: 0,
      llm_frequency_penalty: 0,
      llm_presence_penalty: 0,
      llm_min_p: 0.05,
      llm_logit_biases: [],
      fallback_model_refs: scenario.liveFallbackRefs,
    };
  },
} as unknown as TomoriState;

function makeScenario(): Scenario {
  return {
    branch: "regular",
    modelUpdated: true,
    chatUpdated: true,
    presetApplied: true,
    replaceResult: false,
    selectedModel: makeModel("next-model"),
    naiPresets: [],
    liveFallbackRefs: [],
    savedFallbackRefs: [],
  };
}

const scopedMock = createScopedModuleMocker(mock, {
  "@/utils/cache/tomoriStateCache": realTomoriStateCache,
  "@/utils/provider/savedProviderConfig": realSavedProviderConfig,
  "@/utils/db/repositories": realRepositories,
  "@/utils/discord/ui/modals": realModals,
  "@/utils/discord/ui/embeds": realEmbeds,
  "@/utils/discord/providerPicker": realProviderPicker,
  "@/utils/provider/logitBiasResolver": realLogitBiasResolver,
  "@/utils/text/localizer": realLocalizer,
  "@/utils/discord/openrouterModelMigrationNotice": realOpenrouterModelMigrationNotice,
  "@/utils/provider/providerInfoRegistry": realProviderInfoRegistry,
  "@/utils/discord/commandRegistry": realCommandRegistry,
  "@/utils/discord/ui/personaWorkflow": realPersonaWorkflow,
});

scopedMock.module("@/utils/cache/tomoriStateCache", () => ({
  ...realTomoriStateCache,
  getCachedTomoriState: async () => tomoriState,
  getCachedAllPersonas: async () => [],
  getCachedMainPersona: async () => tomoriState,
  getLastDbError: () => null,
  invalidateTomoriStateCache: (serverDiscId: string) => {
    chronology.push("cache.invalidate");
    invalidations.push(serverDiscId);
  },
}));

scopedMock.module("@/utils/provider/savedProviderConfig", () => ({
  ...realSavedProviderConfig,
  loadSavedProvidersForCapability: async () => [
    {
      provider: scenario.selectedModel.llm_provider,
      api_key: "encrypted-key",
      llm_logit_biases: [],
      fallback_model_refs: scenario.savedFallbackRefs,
      llm_disabled_params: [],
    },
  ],
}));

scopedMock.module("@/utils/db/repositories", () => ({
  ...realRepositories,
  llmModelRepo: overrideMembers(realRepositories.llmModelRepo, {
    loadAvailableModelsForProvider: async () => [scenario.selectedModel],
  }),
  llmOverrideRepo: overrideMembers(realRepositories.llmOverrideRepo, {
    getChannelLlmOverride: async () => null,
    setChannelLlmOverride: async () => true,
    setPersonaLlmOverride: async () => true,
  }),
  configRepository: overrideMembers(realRepositories.configRepository, {
    updateModelConfig: async (_serverId: number, patch: Record<string, unknown>) => {
      chronology.push("repo.update-model");
      modelConfigPatches.push(patch);
      return scenario.modelUpdated;
    },
    updateChatConfig: async (_serverId: number, patch: Record<string, unknown>) => {
      chronology.push("repo.update-chat");
      chatConfigPatches.push(patch);
      return scenario.chatUpdated;
    },
    loadNaiPresets: async () => scenario.naiPresets,
    applyNaiPreset: async (serverId: number, preset: NaiPresetRow, model: string, serverDiscId: string) => {
      chronology.push("repo.apply-preset");
      presetCalls.push({ serverId, preset, model, serverDiscId });
      return scenario.presetApplied;
    },
  }),
}));

scopedMock.module("@/utils/discord/ui/modals", () => ({
  ...realModals,
  safeSelectOptionText: (value: string) => value,
  promptWithPaginatedModal: async (interaction: unknown) => ({
    outcome: "submit",
    interaction,
    values: { model_select: scenario.selectedModel.llm_codename },
  }),
}));

scopedMock.module("@/utils/discord/ui/embeds", () => ({
  ...realEmbeds,
  replyInfoEmbed: async (_interaction: unknown, _locale: string, options: InfoOptions) => {
    chronology.push("reply.info");
    infoReplies.push(options);
  },
}));

scopedMock.module("@/utils/discord/providerPicker", () => ({
  ...realProviderPicker,
  promptForSavedProvider: async (interaction: unknown) => ({
    provider: scenario.selectedModel.llm_provider.toLowerCase(),
    interaction,
  }),
  replaceProviderPickerWithInfo: async (
    _selection: unknown,
    _interaction: unknown,
    _locale: string,
    options: InfoOptions,
  ) => {
    chronology.push("provider.replace");
    replacements.push(options);
    return scenario.replaceResult;
  },
}));

scopedMock.module("@/utils/provider/logitBiasResolver", () => ({
  ...realLogitBiasResolver,
  resolveLogitBiasEntriesForLlm: () => ({ entries: [] }),
}));

stubLogMembers({
  error: async (message: string, error: Error, context: ErrorContext) => {
    chronology.push("log.error");
    errorLogs.push({ message, error, context });
  },
  info: () => undefined,
  warn: () => undefined,
});

scopedMock.module("@/utils/text/localizer", () => ({
  ...realLocalizer,
  localizer: (_locale: string, key: string) => key,
}));

scopedMock.module("@/utils/discord/openrouterModelMigrationNotice", () => ({
  ...realOpenrouterModelMigrationNotice,
  replyLegacyOpenRouterOtherModelMoved: async () => undefined,
}));

scopedMock.module("@/utils/provider/providerInfoRegistry", () => ({
  ...realProviderInfoRegistry,
  getProviderDisplayName: (provider: string) => provider,
}));

scopedMock.module("@/utils/discord/commandRegistry", () => ({
  ...realCommandRegistry,
  commandRegistry: overrideMembers(realCommandRegistry.commandRegistry, {
    getCommandMention: () => "/providers",
  }),
}));

// Fake anchor one-message engine. It drives text.ts's global scope: the provider
// step resolves to a single "open selector" button, the modal opens and submits the
// scenario's model, and every terminal `replace` is recorded so the persistence and
// terminal-rendering assertions can inspect what landed on the one anchor message.
function makeAnchorController() {
  const replace = async (payload: InfoOptions) => {
    chronology.push("message.replace");
    replacements.push(payload);
    return {};
  };
  return {
    anchorMessageId: "anchor-msg",
    fetchMessage: async () => ({
      id: "anchor-msg",
      awaitMessageComponent: async () => ({
        id: "opener-button",
        customId: "model_text_global_open",
        user: { id: "user-1" },
      }),
    }),
    replace,
  };
}

scopedMock.module("@/utils/discord/ui/personaWorkflow", () => ({
  ...realPersonaWorkflow,
  isCollectorTimeoutError: () => false,
  buildPersonaWorkflowNotice: (options: unknown) => options,
  completePersonaWorkflow: () => ({ action: "complete" }),
  retryPersonaWorkflow: () => ({ action: "retry" }),
  runPersonaPickerWorkflow: async () => undefined,
  beginAnchorPrivateWorkflow: async () => {
    const controller = makeAnchorController();
    const modalPhase = {
      values: { model_select: scenario.selectedModel.llm_codename },
      message: controller,
      beginInPlaceWork: async () => ({ message: controller }),
      replace: controller.replace,
    };
    const nestedButton = {
      message: controller,
      replace: controller.replace,
      beginInPlaceWork: async () => ({ message: controller }),
      openModal: async () => ({ outcome: "submitted", phase: modalPhase }),
      delete: async () => undefined,
    };
    return {
      phaseId: "phase-1",
      message: controller,
      useButton: () => nestedButton,
    };
  },
}));

function makeInteraction(): ChatInputCommandInteraction {
  return {
    channel: { id: "channel-1", toString: () => "#channel" },
    channelId: "channel-1",
    guild: { id: "guild-1" },
    guildId: "guild-1",
    user: { id: "user-1" },
    options: { getString: (name: string) => (name === "scope" ? "global" : null) },
  } as unknown as ChatInputCommandInteraction;
}

const userData = {
  user_id: 4,
  user_disc_id: "user-1",
  language_pref: "en-US",
} as unknown as UserRow;

async function runCommand(): Promise<void> {
  const { execute } = await import("@/commands/model/text");
  await execute({} as Client, makeInteraction(), userData, "en-US");
}

function expectUpdateFailure(): void {
  // Terminal notices now render through the anchor controller, so the payload also
  // carries `locale`/`color`; match on the title key rather than the whole object.
  const rendered = [...infoReplies, ...replacements];
  expect(rendered.some((options) => options.titleKey === "general.errors.update_failed_title")).toBe(true);
  expect(rendered.some((options) => options.titleKey === "commands.model.text.success_title")).toBe(false);
}

function expectBefore(first: string, second: string): void {
  expect(chronology.indexOf(first)).toBeGreaterThanOrEqual(0);
  expect(chronology.indexOf(second)).toBeGreaterThan(chronology.indexOf(first));
}

beforeEach(() => {
  scenario = makeScenario();
  chronology.length = 0;
  invalidations.length = 0;
  infoReplies.length = 0;
  replacements.length = 0;
  errorLogs.length = 0;
  presetCalls.length = 0;
  modelConfigPatches.length = 0;
  chatConfigPatches.length = 0;
});

describe("/model text global persistence", () => {
  it("preserves the live cross-provider chain and mirrors its pruned LLM refs", async () => {
    scenario.liveFallbackRefs = [
      { type: "llm", id: 7 },
      { type: "custom_endpoint", id: 9 },
      { type: "llm", id: 42 },
    ];
    scenario.savedFallbackRefs = [{ type: "llm", id: 99 }];

    await runCommand();

    expect(modelConfigPatches[0]).toMatchObject({ fallback_llm_ids: [7] });
    expect(chatConfigPatches[0]).toMatchObject({
      fallback_model_refs: [
        { type: "llm", id: 7 },
        { type: "custom_endpoint", id: 9 },
      ],
    });
  });

  it("invalidates and fails when the regular-model chat-config write fails after the model write succeeds", async () => {
    scenario.chatUpdated = false;

    await runCommand();

    expect(invalidations).toEqual(["guild-1"]);
    expectUpdateFailure();
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]?.context.errorType).toBe("DatabaseUpdateError");
    expect(errorLogs[0]?.context.metadata).toMatchObject({
      modelConfigUpdated: true,
      chatConfigUpdated: false,
      selectedModelCodename: "next-model",
    });
    expect(presetCalls).toHaveLength(0);
  });

  it("invalidates and fails when the custom-model chat-config write fails after the model write succeeds", async () => {
    scenario.branch = "custom";
    scenario.selectedModel = makeModel("custom-next", "custom-provider");
    scenario.chatUpdated = false;

    await runCommand();

    expect(invalidations).toEqual(["guild-1"]);
    expectUpdateFailure();
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]?.context.metadata).toMatchObject({
      modelConfigUpdated: true,
      chatConfigUpdated: false,
      selectedModelCodename: "custom-next",
    });
    expect(presetCalls).toHaveLength(0);
  });

  it("passes the cache key and renders the preset failure in place after a final invalidation", async () => {
    scenario.selectedModel = makeModel("kayra-v1", "novelai");
    scenario.naiPresets = [defaultPreset];
    scenario.presetApplied = false;
    scenario.replaceResult = true;

    await runCommand();

    expect(presetCalls).toEqual([{ serverId: 7, preset: defaultPreset, model: "kayra-v1", serverDiscId: "guild-1" }]);
    expect(invalidations).toEqual(["guild-1", "guild-1"]);
    expect(infoReplies).toHaveLength(0);
    expectUpdateFailure();
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]?.context.metadata).toMatchObject({
      naiPresetName: "Carefree-Kayra",
      selectedModelCodename: "kayra-v1",
    });
    expectBefore("cache.invalidate", "repo.apply-preset");
    expect(chronology.lastIndexOf("cache.invalidate")).toBeGreaterThan(chronology.indexOf("repo.apply-preset"));
    expectBefore("repo.apply-preset", "message.replace");
  });

  it("renders success only after the primary writes and default preset all succeed", async () => {
    scenario.selectedModel = makeModel("kayra-v1", "novelai");
    scenario.naiPresets = [defaultPreset];
    scenario.replaceResult = true;

    await runCommand();

    expect(presetCalls[0]).toMatchObject({ model: "kayra-v1", serverDiscId: "guild-1" });
    expect(errorLogs).toHaveLength(0);
    expect(replacements).toContainEqual(
      expect.objectContaining({
        titleKey: "commands.model.text.success_title",
        descriptionKey: "commands.model.text.success_description",
      }),
    );
    expectBefore("cache.invalidate", "repo.apply-preset");
    expectBefore("repo.apply-preset", "message.replace");
  });
});
