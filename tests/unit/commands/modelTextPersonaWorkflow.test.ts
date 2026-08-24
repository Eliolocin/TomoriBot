import { beforeEach, describe, expect, it, mock } from "bun:test";
import { ComponentType, MessageFlags } from "discord.js";
import type { ChatInputCommandInteraction, Client } from "discord.js";
import type { LlmRow, TomoriState, UserRow } from "@/types/db/schema";
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

type Payload = Record<string, unknown>;

interface ModalFixture {
  outcome: "submitted" | "timeout" | "cancelled" | "error" | "fatal";
  values?: Record<string, string>;
}

interface Scenario {
  providers: Array<{ provider: string }>;
  modelsByProvider: Record<string, LlmRow[]>;
  buttons: Array<string | "timeout">;
  modals: ModalFixture[];
  runnerIterations: number;
  overrideResult: boolean;
}

interface RecordedPayload {
  operation: string;
  messageId: string;
  payload: Payload;
}

const CANONICAL_MESSAGE_ID = "anchor-model-text";
const chronology: string[] = [];
const rootCalls: string[] = [];
const payloads: RecordedPayload[] = [];
const modalOptions: Payload[] = [];
const workflowDirectives: string[] = [];
const modelLoads: Array<{ provider: string; ownerId: number }> = [];
const overrideWrites: Array<{ personaId: number; llmId: number; serverDiscId: string }> = [];

let scenario: Scenario;
let selectedPersona: TomoriState;

function makeModel(index: number, provider = "provider-a"): LlmRow {
  return {
    llm_id: 1000 + index,
    llm_codename: `model-${index}`,
    llm_provider: provider,
    llm_description: `Model ${index}`,
    ja_description: `Model ${index}`,
    is_scoped_registration: false,
    is_free: false,
    has_tools: false,
    sees_images: false,
    sees_videos: false,
    supports_structoutput: false,
  } as unknown as LlmRow;
}

function makeModels(count: number, provider = "provider-a"): LlmRow[] {
  return Array.from({ length: count }, (_, index) => makeModel(index, provider));
}

const serverState = {
  server_id: 7,
  persona_id: 70,
  persona_nickname: "Server Tomori",
  llm: {
    llm_id: 1,
    llm_codename: "current-model",
    llm_provider: "current-provider",
  },
  config: {
    llm_id: 1,
    llm_temperature: 1,
    llm_top_p: 0.95,
    llm_top_k: 0,
    llm_frequency_penalty: 0,
    llm_presence_penalty: 0,
    llm_min_p: 0.05,
    llm_logit_biases: [],
  },
} as unknown as TomoriState;

function resetPersona(): TomoriState {
  return {
    ...serverState,
    persona_id: 77,
    persona_nickname: "Persona Tomori",
    persona_llm: {
      llm_id: 2,
      llm_codename: "persona-current",
      llm_provider: "persona-provider",
    },
  } as unknown as TomoriState;
}

function makeScenario(): Scenario {
  return {
    providers: [{ provider: "provider-a" }],
    modelsByProvider: { "provider-a": makeModels(25) },
    buttons: [],
    modals: [],
    runnerIterations: 1,
    overrideResult: true,
  };
}

function noticePayload(titleKey: string, descriptionKey: string, button?: Payload): Payload {
  const components: Payload[] = [
    { type: ComponentType.TextDisplay, content: titleKey },
    { type: ComponentType.TextDisplay, content: descriptionKey },
  ];
  if (button) components.push({ type: ComponentType.ActionRow, components: [button] });
  return {
    components: [{ type: ComponentType.Container, components }],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };
}

function recordPayload(operation: string, payload: unknown): void {
  payloads.push({ operation, messageId: CANONICAL_MESSAGE_ID, payload: payload as Payload });
}

function takeButton(): { id: string; customId: string; user: { id: string }; message: { id: string } } {
  const next = scenario.buttons.shift();
  if (!next || next === "timeout") throw new Error("component timeout");
  return {
    id: `button-${next}`,
    customId: next,
    user: { id: "user-1" },
    message: { id: CANONICAL_MESSAGE_ID },
  };
}

const controller = {
  replace: async (payload: unknown) => {
    chronology.push("message.replace");
    recordPayload("replace", payload);
  },
  edit: async (payload: unknown) => {
    chronology.push("message.edit");
    recordPayload("edit", payload);
  },
  fetchMessage: async () => ({
    id: CANONICAL_MESSAGE_ID,
    awaitMessageComponent: async () => {
      chronology.push("message.await-component");
      return takeButton();
    },
  }),
  delete: async () => {
    chronology.push("message.delete");
  },
  disableControls: async () => {
    chronology.push("message.disable-controls");
  },
};

function modalPhase(values: Record<string, string>) {
  return {
    phaseId: "model-modal",
    message: controller,
    values,
    multiValues: {},
    attachments: {},
    optionOffset: 0,
    beginInPlaceWork: async () => {
      chronology.push("ack:modal.deferUpdate");
      return { phaseId: "model-modal-work", message: controller };
    },
  };
}

function useButton(button: { customId: string; message: { id: string } }) {
  return {
    replace: async (payload: unknown) => {
      chronology.push(`ack:button.update:${button.customId}`);
      recordPayload("button.replace", payload);
    },
    edit: async (payload: unknown) => {
      chronology.push(`ack:button.deferUpdate:${button.customId}`);
      recordPayload("button.edit", payload);
    },
    beginInPlaceWork: async () => {
      chronology.push(`ack:button.deferUpdate:${button.customId}`);
      return { phaseId: `work-${button.customId}`, message: controller };
    },
    openModal: async (options: unknown) => {
      chronology.push(`ack:button.showModal:${button.customId}`);
      modalOptions.push(options as Payload);
      const next = scenario.modals.shift() ?? { outcome: "timeout" as const };
      return next.outcome === "submitted"
        ? { outcome: "submitted" as const, phase: modalPhase(next.values ?? {}) }
        : { outcome: next.outcome };
    },
    delete: async () => {
      chronology.push(`ack:button.deleteReply:${button.customId}`);
    },
  };
}

function selectionPhase(iteration: number) {
  return {
    phaseId: `model-phase-${iteration}`,
    message: controller,
    persona: selectedPersona,
    absoluteIndex: 0,
    useButton,
    beginInPlaceWork: async () => {
      chronology.push(`ack:persona-button.deferUpdate:${iteration}`);
      return { phaseId: `persona-work-${iteration}`, message: controller };
    },
  };
}

const scopedMock = createScopedModuleMocker(mock, {
  "@/utils/discord/ui/personaWorkflow": realPersonaWorkflow,
  "@/utils/discord/ui/modals": realModals,
  "@/utils/discord/ui/embeds": realEmbeds,
  "@/utils/text/localizer": realLocalizer,
  "@/utils/cache/tomoriStateCache": realTomoriStateCache,
  "@/utils/provider/savedProviderConfig": realSavedProviderConfig,
  "@/utils/db/repositories": realRepositories,
  "@/utils/provider/logitBiasResolver": realLogitBiasResolver,
  "@/utils/discord/providerPicker": realProviderPicker,
  "@/utils/discord/openrouterModelMigrationNotice": realOpenrouterModelMigrationNotice,
  "@/utils/provider/providerInfoRegistry": realProviderInfoRegistry,
  "@/utils/discord/commandRegistry": realCommandRegistry,
});

scopedMock.module("@/utils/discord/ui/personaWorkflow", () => ({
  ...realPersonaWorkflow,
  // Overridden so an accidental entry fails loudly: the persona scope never enters
  // the anchor private workflow (that path is exercised by modelTextGlobalPersistence.test.ts).
  beginAnchorPrivateWorkflow: async () => {
    throw new Error("beginAnchorPrivateWorkflow is not used by the persona scope");
  },
  isCollectorTimeoutError: () => false,
  buildPersonaWorkflowNotice: (options: {
    titleKey: string;
    descriptionKey: string;
    button?: { customId: string; labelKey: string; style: number };
  }) =>
    noticePayload(
      options.titleKey,
      options.descriptionKey,
      options.button
        ? {
            type: ComponentType.Button,
            customId: options.button.customId,
            label: options.button.labelKey,
            style: options.button.style,
          }
        : undefined,
    ),
  completePersonaWorkflow: () => ({ action: "complete" }),
  retryPersonaWorkflow: () => ({ action: "retry" }),
  runPersonaPickerWorkflow: async (
    interaction: {
      deferred?: boolean;
      reply: (payload: unknown) => Promise<unknown>;
      editReply: (payload: unknown) => Promise<unknown>;
    },
    _locale: string,
    options: { onSelected: (selection: unknown) => Promise<{ action?: string } | undefined> },
  ) => {
    chronology.push(interaction.deferred ? "ack:root.editReply-picker" : "ack:root.reply-picker");
    const pickerPayload = noticePayload("persona-picker", "persona-picker-description");
    if (interaction.deferred) await interaction.editReply(pickerPayload);
    else await interaction.reply(pickerPayload);
    for (let iteration = 0; iteration < scenario.runnerIterations; iteration++) {
      const directive = await options.onSelected(selectionPhase(iteration));
      workflowDirectives.push(directive?.action ?? "none");
      if (directive?.action !== "retry") break;
    }
    return { outcome: "selected", persona: selectedPersona, absoluteIndex: 0 };
  },
}));

scopedMock.module("@/utils/discord/ui/modals", () => ({
  ...realModals,
  safeSelectOptionText: (value: string) => value,
  promptWithPaginatedModal: async () => ({ outcome: "timeout" }),
}));

scopedMock.module("@/utils/discord/ui/embeds", () => ({
  ...realEmbeds,
  replyInfoEmbed: async (
    interaction: {
      replied?: boolean;
      deferred?: boolean;
      reply: (payload: unknown) => Promise<unknown>;
      editReply?: (payload: unknown) => Promise<unknown>;
    },
    _locale: string,
    options: { titleKey: string; descriptionKey: string },
  ) => {
    if ((interaction.replied || interaction.deferred) && interaction.editReply) {
      await interaction.editReply(options);
    } else {
      await interaction.reply(options);
    }
  },
}));

scopedMock.module("@/utils/text/localizer", () => ({
  ...realLocalizer,
  localizer: (_locale: string, key: string, variables?: Record<string, unknown>) =>
    variables ? `${key}:${JSON.stringify(variables)}` : key,
}));

stubLogMembers({
  error: async () => undefined,
  info: () => undefined,
  warn: () => undefined,
});

scopedMock.module("@/utils/cache/tomoriStateCache", () => ({
  ...realTomoriStateCache,
  getCachedTomoriState: async () => {
    chronology.push("cache.state");
    return serverState;
  },
  getCachedAllPersonas: async () => {
    chronology.push("cache.personas");
    return [selectedPersona];
  },
  getCachedMainPersona: async () => serverState,
  getLastDbError: () => null,
  invalidateTomoriStateCache: () => undefined,
}));

scopedMock.module("@/utils/provider/savedProviderConfig", () => ({
  ...realSavedProviderConfig,
  loadSavedProvidersForCapability: async () => scenario.providers,
}));

scopedMock.module("@/utils/db/repositories", () => ({
  ...realRepositories,
  llmModelRepo: overrideMembers(realRepositories.llmModelRepo, {
    loadAvailableModelsForProvider: async (provider: string, _refresh: boolean, owner: { ownerId: number }) => {
      chronology.push(`repo.models:${provider}`);
      modelLoads.push({ provider, ownerId: owner.ownerId });
      return scenario.modelsByProvider[provider] ?? [];
    },
  }),
  llmOverrideRepo: overrideMembers(realRepositories.llmOverrideRepo, {
    setPersonaLlmOverride: async (personaId: number, llmId: number, options: { serverDiscId: string }) => {
      chronology.push("repo.set-persona-override");
      overrideWrites.push({ personaId, llmId, serverDiscId: options.serverDiscId });
      return scenario.overrideResult;
    },
    getChannelLlmOverride: async () => null,
    setChannelLlmOverride: async () => true,
  }),
  configRepository: overrideMembers(realRepositories.configRepository, {
    updateModelConfig: async () => null,
    updateChatConfig: async () => null,
    loadNaiPresets: async () => [],
    applyNaiPreset: async () => undefined,
  }),
}));

scopedMock.module("@/utils/provider/logitBiasResolver", () => ({
  ...realLogitBiasResolver,
  resolveLogitBiasEntriesForLlm: () => ({ entries: [] }),
}));

scopedMock.module("@/utils/discord/providerPicker", () => ({
  ...realProviderPicker,
  promptForSavedProvider: async () => null,
  replaceProviderPickerWithInfo: async () => false,
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

function makeInteraction(): ChatInputCommandInteraction {
  const interaction = {
    replied: false,
    deferred: false,
    channel: { id: "channel-1", toString: () => "#channel" },
    channelId: "channel-1",
    guild: { id: "guild-1" },
    guildId: "guild-1",
    user: { id: "user-1" },
    options: { getString: (name: string) => (name === "scope" ? "persona" : null) },
    deferReply: async () => {
      rootCalls.push("deferReply");
      chronology.push("ack:root.deferReply");
      interaction.deferred = true;
    },
    reply: async (payload: unknown) => {
      rootCalls.push("reply");
      interaction.replied = true;
      recordPayload("root.reply", payload);
      return { resource: { message: { id: CANONICAL_MESSAGE_ID } } };
    },
    editReply: async (payload: unknown) => {
      rootCalls.push("editReply");
      recordPayload("root.editReply", payload);
    },
    followUp: async (payload: unknown) => {
      rootCalls.push("followUp");
      recordPayload("root.followUp", payload);
    },
  };
  return interaction as unknown as ChatInputCommandInteraction;
}

const userData = {
  user_id: 4,
  user_disc_id: "user-1",
  language_pref: "en-US",
} as unknown as UserRow;

function payloadText(payload: unknown): string {
  const texts: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      if (key === "content" && typeof nested === "string") texts.push(nested);
      else visit(nested);
    }
  };
  visit(payload);
  return texts.join("\n");
}

function expectAnchorV2Only(): void {
  expect(new Set(payloads.map((entry) => entry.messageId))).toEqual(new Set([CANONICAL_MESSAGE_ID]));
  for (const entry of payloads) {
    expect(entry.payload.flags).toBe(MessageFlags.IsComponentsV2);
    expect(entry.payload).not.toHaveProperty("content");
    expect(entry.payload).not.toHaveProperty("embeds");
  }
  expect(rootCalls).toEqual(["deferReply", "editReply"]);
  expect(rootCalls).not.toContain("followUp");
  expect(rootCalls).not.toContain("reply");
}

function expectBefore(first: string, second: string): void {
  const firstIndex = chronology.indexOf(first);
  const secondIndex = chronology.indexOf(second);
  expect(firstIndex).toBeGreaterThanOrEqual(0);
  expect(secondIndex).toBeGreaterThan(firstIndex);
}

async function runCommand(): Promise<void> {
  const { execute } = await import("@/commands/model/text");
  await execute({} as Client, makeInteraction(), userData, "en-US");
}

function queueSuccessfulModelSelection(modelIndex: number, iteration = 0): void {
  scenario.buttons.push(`persona_model_model-phase-${iteration}_open`);
  scenario.modals.push({ outcome: "submitted", values: { model_select: `model-${modelIndex}` } });
}

beforeEach(() => {
  scenario = makeScenario();
  selectedPersona = resetPersona();
  chronology.length = 0;
  rootCalls.length = 0;
  payloads.length = 0;
  modalOptions.length = 0;
  workflowDirectives.length = 0;
  modelLoads.length = 0;
  overrideWrites.length = 0;
});

describe("/model text persona workflow", () => {
  it("preserves first and last absolute model mappings at exactly 25 and 26 choices", async () => {
    for (const count of [25, 26] as const) {
      for (const selectedIndex of [0, count - 1]) {
        scenario.modelsByProvider["provider-a"] = makeModels(count);
        queueSuccessfulModelSelection(selectedIndex);

        await runCommand();

        const modelModal = modalOptions[0];
        const components = modelModal?.components as Array<{ options?: Array<{ value: string }> }>;
        const options = components[0]?.options ?? [];
        expect(options).toHaveLength(count);
        expect(options[0]?.value).toBe("model-0");
        expect(options.at(-1)?.value).toBe(`model-${count - 1}`);
        expect(overrideWrites).toEqual([{ personaId: 77, llmId: 1000 + selectedIndex, serverDiscId: "guild-1" }]);
        expect(selectedPersona.persona_llm?.llm_codename).toBe(`model-${selectedIndex}`);
        expectBefore("ack:root.deferReply", "cache.state");
        expectBefore("ack:root.deferReply", "cache.personas");
        expectBefore("ack:persona-button.deferUpdate:0", "repo.models:provider-a");
        expectBefore("ack:modal.deferUpdate", "repo.set-persona-override");
        expect(workflowDirectives).toEqual(["retry"]);
        expectAnchorV2Only();

        scenario = makeScenario();
        selectedPersona = resetPersona();
        chronology.length = 0;
        rootCalls.length = 0;
        payloads.length = 0;
        modalOptions.length = 0;
        workflowDirectives.length = 0;
        modelLoads.length = 0;
        overrideWrites.length = 0;
      }
    }
  });

  it("chains provider selection into that provider's model picker before persisting", async () => {
    scenario.providers = [{ provider: "provider-a" }, { provider: "provider-b" }];
    scenario.modelsByProvider = {
      "provider-a": makeModels(3, "provider-a"),
      "provider-b": makeModels(26, "provider-b"),
    };
    scenario.buttons.push("persona_model_model-phase-0_provider_1", "persona_model_model-phase-0_open");
    scenario.modals.push({ outcome: "submitted", values: { model_select: "model-25" } });

    await runCommand();

    expect(modelLoads).toEqual([{ provider: "provider-b", ownerId: 7 }]);
    expectBefore("ack:button.deferUpdate:persona_model_model-phase-0_provider_1", "repo.models:provider-b");
    expect(overrideWrites).toEqual([{ personaId: 77, llmId: 1025, serverDiscId: "guild-1" }]);
    const providerPickerText = payloads.map((entry) => payloadText(entry.payload)).join("\n");
    expect(providerPickerText).toContain("commands.model.providerPicker.title");
    expectAnchorV2Only();
  });

  it("re-enters the persona picker in place after provider cancellation", async () => {
    scenario.providers = [{ provider: "provider-a" }, { provider: "provider-b" }];
    scenario.modelsByProvider = { "provider-a": makeModels(25), "provider-b": makeModels(25, "provider-b") };
    scenario.runnerIterations = 2;
    scenario.buttons.push(
      "persona_model_model-phase-0_provider_cancel",
      "persona_model_model-phase-1_provider_0",
      "persona_model_model-phase-1_open",
    );
    scenario.modals.push({ outcome: "submitted", values: { model_select: "model-24" } });

    await runCommand();

    expect(workflowDirectives).toEqual(["retry", "retry"]);
    expect(chronology).toContain("ack:button.update:persona_model_model-phase-0_provider_cancel");
    expect(modelLoads).toEqual([{ provider: "provider-a", ownerId: 7 }]);
    expect(overrideWrites).toHaveLength(1);
    expectAnchorV2Only();
  });

  it("recovers on the same anchor message after model-launch timeout", async () => {
    scenario.runnerIterations = 2;
    scenario.buttons.push("timeout", "persona_model_model-phase-1_open");
    scenario.modals.push({ outcome: "submitted", values: { model_select: "model-0" } });

    await runCommand();

    expect(workflowDirectives).toEqual(["retry", "retry"]);
    expect(payloads.map((entry) => payloadText(entry.payload)).join("\n")).toContain(
      "general.interaction.timeout_title",
    );
    expect(modelLoads).toEqual([
      { provider: "provider-a", ownerId: 7 },
      { provider: "provider-a", ownerId: 7 },
    ]);
    expect(overrideWrites).toHaveLength(1);
    expectAnchorV2Only();
  });

  it("recovers on the same anchor message after model-modal timeout", async () => {
    scenario.runnerIterations = 2;
    scenario.buttons.push("persona_model_model-phase-0_open", "persona_model_model-phase-1_open");
    scenario.modals.push({ outcome: "timeout" }, { outcome: "submitted", values: { model_select: "model-24" } });

    await runCommand();

    expect(workflowDirectives).toEqual(["retry", "retry"]);
    expect(chronology.filter((entry) => entry.startsWith("ack:button.showModal:"))).toHaveLength(2);
    expect(overrideWrites).toEqual([{ personaId: 77, llmId: 1024, serverDiscId: "guild-1" }]);
    expectAnchorV2Only();
  });

  it("keeps the prior persona model and renders an in-place failure when persistence returns false", async () => {
    scenario.overrideResult = false;
    queueSuccessfulModelSelection(4);

    await runCommand();

    expect(overrideWrites).toEqual([{ personaId: 77, llmId: 1004, serverDiscId: "guild-1" }]);
    expect(selectedPersona.persona_llm?.llm_codename).toBe("persona-current");
    expect(payloads.map((entry) => payloadText(entry.payload)).join("\n")).toContain(
      "general.errors.update_failed_title",
    );
    expect(workflowDirectives).toEqual(["complete"]);
    expectAnchorV2Only();
  });
});
