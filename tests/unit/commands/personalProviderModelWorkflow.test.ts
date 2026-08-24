import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ChatInputCommandInteraction, Client } from "discord.js";
import type { ErrorContext, UserRow } from "@/types/db/schema";
// Real namespaces captured at link time, before any `mock.module` below runs.
// `mock.module` is process-global and never restored, so every factory spreads
// the real surface and overrides only what this file controls.
import * as realRepositories from "@/utils/db/repositories";
import * as realCommandRegistry from "@/utils/discord/commandRegistry";
import * as realEmbeds from "@/utils/discord/ui/embeds";
import * as realModals from "@/utils/discord/ui/modals";
import * as realPersonaWorkflow from "@/utils/discord/ui/personaWorkflow";
import * as realPersonalProviderHelpers from "@/utils/provider/personalProviderHelpers";
import * as realProviderInfoRegistry from "@/utils/provider/providerInfoRegistry";
import * as realSavedProviderConfig from "@/utils/provider/savedProviderConfig";
import * as realLocalizer from "@/utils/text/localizer";
import { createScopedModuleMocker, overrideMembers, stubLogMembers } from "../../helpers/mockSurface";

/**
 * Anchor-migration tests for the personal provider-model family
 * (`/personal provider model-text|vision|video|image|embedding`).
 *
 * The engine is replaced with a fake anchor controller (same template as
 * `modelTextGlobalPersistence.test.ts`) so these tests assert the two things a migration
 * can silently get wrong: that the terminal notice lands on the ONE anchor message
 * rather than escaping to a fresh `replyInfoEmbed`, and that the capability write still
 * targets the right column with the right provider.
 */

interface NoticeOptions {
  titleKey: string;
  descriptionKey?: string;
  descriptionVars?: Record<string, string>;
}

/**
 * What lands on the anchor message. The cross-server activation confirmation renders a raw
 * Components V2 container rather than a notice, so `components` is what distinguishes it.
 */
type AnchorPayload = Partial<NoticeOptions> & { components?: unknown[] };

/** True for the activation confirmation step, false for every notice terminal. */
function isConfirmationPayload(payload: AnchorPayload): boolean {
  return Array.isArray(payload.components);
}

/** A capability row as `assignPersonalCapabilityToProvider` hands it to the updater. */
interface CapabilityRow {
  provider: string;
  enabled_capabilities: string[];
  llm_id: number | null;
  vision_llm_id: number | null;
  video_model_id: number | null;
  diffusion_model_id: number | null;
  nai_diffusion_model_id: number | null;
  embedding_model_id: number | null;
  fallback_model_refs: Array<{ type: string; id: number }>;
}

interface AssignCall {
  userId: number;
  provider: string;
  capability: string;
  /** The row the updater produced from a pristine baseline i.e. what would be written. */
  result: CapabilityRow;
}

const chronology: string[] = [];
const infoReplies: NoticeOptions[] = [];
const replacements: AnchorPayload[] = [];
const initialPayloads: NoticeOptions[] = [];
const assignCalls: AssignCall[] = [];
const errorLogs: Array<{ context: ErrorContext }> = [];

interface Scenario {
  /** Saved providers for the capability; length drives the picker vs. opener branch. */
  providers: string[];
  /** Value the fake modal submits for `model_select`. */
  submittedValue: string;
  /** What `assignPersonalCapabilityToProvider` reports back. */
  updateSucceeds: boolean;
  /** Image-generation style the fake provider registry reports (drives NAI column routing). */
  imageGenerationStyle: string;
  /** Saved fallback chain the updater sees on the row it is handed. */
  fallbackModelRefs: Array<{ type: string; id: number }>;
  customPrimaryEndpointMode: boolean;
  /**
   * Merged into the rows the picker step reads. Presetting a capability here makes the command
   * see it as already routing personally, which is what suppresses the activation confirmation.
   */
  activeCapabilityRow: Partial<CapabilityRow> | null;
  /** Custom id the fake collector hands back, used to decline the activation confirmation. */
  buttonCustomId: string;
}

let scenario: Scenario;

function makeScenario(): Scenario {
  return {
    providers: ["provider-a"],
    submittedValue: "",
    updateSucceeds: true,
    imageGenerationStyle: "standard",
    fallbackModelRefs: [],
    customPrimaryEndpointMode: false,
    activeCapabilityRow: null,
    buttonCustomId: "opener",
  };
}

function baselineRow(provider: string): CapabilityRow {
  return {
    provider,
    enabled_capabilities: [],
    llm_id: null,
    vision_llm_id: null,
    video_model_id: null,
    diffusion_model_id: null,
    nai_diffusion_model_id: null,
    embedding_model_id: null,
    fallback_model_refs: scenario.fallbackModelRefs,
  };
}

// Every model table exposes the same two models, keyed by whatever id column its
// command reads, so one fixture serves all five subcommands.
const llmModels = [
  {
    llm_id: 11,
    llm_codename: "text-model",
    llm_provider: "provider-a",
    llm_description: "text",
    ja_description: "text",
    is_scoped_registration: false,
    is_free: false,
    has_tools: true,
    sees_images: true,
    sees_videos: false,
    supports_structoutput: false,
  },
];
const videoModels = [
  {
    video_model_id: 22,
    codename: "video-model",
    provider: "provider-a",
    model_description: "video",
    ja_description: "video",
    is_scoped_registration: false,
    is_free: false,
  },
];
const diffusionModels = [
  {
    diffusion_model_id: 33,
    codename: "image-model",
    provider: "provider-a",
    model_description: "image",
    ja_description: "image",
    is_scoped_registration: false,
    is_free: false,
    is_default: false,
    is_uncensored: false,
  },
];
const embeddingModels = [
  {
    embedding_model_id: 44,
    codename: "embedding-model",
    provider: "provider-a",
    model_description: "embedding",
    ja_description: "embedding",
    is_scoped_registration: false,
    is_default: false,
  },
];

const scopedMock = createScopedModuleMocker(mock, {
  "@/utils/provider/savedProviderConfig": realSavedProviderConfig,
  "@/utils/db/repositories": realRepositories,
  "@/utils/provider/personalProviderHelpers": realPersonalProviderHelpers,
  "@/utils/discord/ui/embeds": realEmbeds,
  "@/utils/discord/ui/modals": realModals,
  "@/utils/provider/providerInfoRegistry": realProviderInfoRegistry,
  "@/utils/discord/commandRegistry": realCommandRegistry,
  "@/utils/text/localizer": realLocalizer,
  "@/utils/discord/ui/personaWorkflow": realPersonaWorkflow,
});

scopedMock.module("@/utils/provider/savedProviderConfig", () => ({
  ...realSavedProviderConfig,
  loadSavedProvidersForCapability: async () => [],
  loadUserSavedProvidersForCapability: async () =>
    scenario.providers.map((provider) => ({
      ...baselineRow(provider),
      ...(scenario.activeCapabilityRow ?? {}),
      api_key: "encrypted-key",
    })),
}));

// The commands under test only touch `llmModelRepo`. Spreading the real barrel
// replaces the hand-maintained placeholder list this mock used to carry, and
// `overrideMembers` delegates through the repository instance's prototype so its
// unstubbed methods survive for later test files.
scopedMock.module("@/utils/db/repositories", () => ({
  ...realRepositories,
  llmModelRepo: overrideMembers(realRepositories.llmModelRepo, {
    loadAvailableModelsForProvider: async () => llmModels,
    loadAvailableVideoGenerationModels: async () => videoModels,
    loadAvailableDiffusionModels: async () => diffusionModels,
    loadAvailableEmbeddingModels: async () => embeddingModels,
  }),
  llmProviderRepo: overrideMembers(realRepositories.llmProviderRepo, {
    loadCustomEndpointsForUser: async () =>
      scenario.customPrimaryEndpointMode
        ? [
            {
              custom_endpoint_id: 5,
              user_id: 4,
              server_id: null,
              model_ref_id: 11,
            },
          ]
        : [],
  }),
}));

scopedMock.module("@/utils/provider/personalProviderHelpers", () => ({
  ...realPersonalProviderHelpers,
  resolveActivePersonalProviderModelSelections: async () => [],
  assignPersonalCapabilityToProvider: async (
    userId: number,
    provider: string,
    capability: string,
    updater: (row: CapabilityRow) => CapabilityRow,
  ) => {
    chronology.push("repo.assign");
    assignCalls.push({ userId, provider, capability, result: updater(baselineRow(provider)) });
    return scenario.updateSucceeds;
  },
}));

scopedMock.module("@/utils/discord/ui/embeds", () => ({
  ...realEmbeds,
  replyInfoEmbed: async (_interaction: unknown, _locale: string, options: NoticeOptions) => {
    chronology.push("reply.info");
    infoReplies.push(options);
  },
}));

scopedMock.module("@/utils/discord/ui/modals", () => ({
  ...realModals,
  safeSelectOptionText: (value: string) => value,
}));

scopedMock.module("@/utils/provider/providerInfoRegistry", () => ({
  ...realProviderInfoRegistry,
  getProviderDisplayName: (provider: string) => provider,
  getStaticProviderInfo: () => ({ featureSupport: { imageGeneration: scenario.imageGenerationStyle } }),
}));

scopedMock.module("@/utils/discord/commandRegistry", () => ({
  ...realCommandRegistry,
  commandRegistry: overrideMembers(realCommandRegistry.commandRegistry, {
    getCommandMention: () => "/personal providers",
  }),
}));

stubLogMembers({
  error: async (_message: string, _error: Error, context: ErrorContext) => {
    chronology.push("log.error");
    errorLogs.push({ context });
  },
  info: () => undefined,
  warn: () => undefined,
});

scopedMock.module("@/utils/text/localizer", () => ({
  ...realLocalizer,
  localizer: (_locale: string, key: string) => key,
}));

// Fake anchor one-message engine. The provider step always resolves to the single
// "open selector" button, the modal opens and submits the scenario's value, and every
// terminal `replace` is recorded so assertions can inspect what landed on the message.
function makeAnchorController() {
  const replace = async (payload: AnchorPayload) => {
    chronology.push("message.replace");
    replacements.push(payload);
    return {};
  };
  return {
    anchorMessageId: "anchor-msg",
    fetchMessage: async () => ({
      id: "anchor-msg",
      // Stands in for the collector: hands back the opener click immediately. The single
      // -provider path resolves its provider from the saved list rather than the button's
      // id, so this fake stays agnostic of each subcommand's ID_ROOT.
      awaitMessageComponent: async () => ({
        id: "opener-button",
        customId: scenario.buttonCustomId,
        user: { id: "user-1" },
      }),
    }),
    replace,
  };
}

scopedMock.module("@/utils/discord/ui/personaWorkflow", () => ({
  ...realPersonaWorkflow,
  isCollectorTimeoutError: () => false,
  buildPersonaWorkflowNotice: (options: NoticeOptions) => options,
  completePersonaWorkflow: () => ({ action: "complete" }),
  retryPersonaWorkflow: () => ({ action: "retry" }),
  runPersonaPickerWorkflow: async () => undefined,
  beginAnchorPrivateWorkflow: async (_interaction: unknown, _locale: string, initialPayload: NoticeOptions) => {
    initialPayloads.push(initialPayload);
    const controller = makeAnchorController();
    const modalPhase = {
      values: { model_select: scenario.submittedValue },
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
    channel: { id: "channel-1" },
    channelId: "channel-1",
    guild: { id: "guild-1" },
    guildId: "guild-1",
    user: { id: "user-1" },
    options: { getString: () => null },
  } as unknown as ChatInputCommandInteraction;
}

const userData = {
  user_id: 4,
  user_disc_id: "user-1",
  language_pref: "en-US",
} as unknown as UserRow;

/** One row per migrated subcommand: how to run it and what a successful write looks like. */
const subcommands = [
  {
    name: "model-text",
    module: "@/commands/personal/provider/model-text",
    capability: "text",
    /** Row shape that makes this capability read as an override that is already switched on. */
    activeCapabilityRow: { enabled_capabilities: ["text"], llm_id: 11 },
    /** Decline button id for this command's activation confirmation (`${ID_ROOT}_activate_no`). */
    declineCustomId: "personal_model_text_activate_no",
    submittedValue: "text-model",
    successDescriptionKey: "commands.personal.provider.model_text.success_description",
    expectedModelName: "text-model",
    expectedWrite: { llm_id: 11 },
  },
  {
    name: "model-vision",
    module: "@/commands/personal/provider/model-vision",
    capability: "vision",
    /** Row shape that makes this capability read as an override that is already switched on. */
    activeCapabilityRow: { enabled_capabilities: ["vision"], vision_llm_id: 11 },
    /** Decline button id for this command's activation confirmation (`${ID_ROOT}_activate_no`). */
    declineCustomId: "personal_model_vision_activate_no",
    submittedValue: "text-model",
    successDescriptionKey: "commands.personal.provider.model_vision.success_description",
    expectedModelName: "text-model",
    expectedWrite: { vision_llm_id: 11 },
  },
  {
    name: "model-video",
    module: "@/commands/personal/provider/model-video",
    capability: "video",
    /** Row shape that makes this capability read as an override that is already switched on. */
    activeCapabilityRow: { enabled_capabilities: ["video"], video_model_id: 22 },
    /** Decline button id for this command's activation confirmation (`${ID_ROOT}_activate_no`). */
    declineCustomId: "personal_model_video_activate_no",
    submittedValue: "22",
    successDescriptionKey: "commands.personal.provider.model_video.success_description",
    expectedModelName: "video-model",
    expectedWrite: { video_model_id: 22 },
  },
  {
    name: "model-image",
    module: "@/commands/personal/provider/model-image",
    capability: "image",
    /** Row shape that makes this capability read as an override that is already switched on. */
    activeCapabilityRow: { enabled_capabilities: ["image"], diffusion_model_id: 33 },
    /** Decline button id for this command's activation confirmation (`${ID_ROOT}_activate_no`). */
    declineCustomId: "personal_model_image_activate_no",
    submittedValue: "33",
    successDescriptionKey: "commands.personal.provider.model_image.success_description",
    expectedModelName: "image-model",
    expectedWrite: { diffusion_model_id: 33, nai_diffusion_model_id: null },
  },
  {
    name: "model-embedding",
    module: "@/commands/personal/provider/model-embedding",
    capability: "embedding",
    /** Row shape that makes this capability read as an override that is already switched on. */
    activeCapabilityRow: { enabled_capabilities: ["embedding"], embedding_model_id: 44 },
    /** Decline button id for this command's activation confirmation (`${ID_ROOT}_activate_no`). */
    declineCustomId: "personal_model_embedding_activate_no",
    submittedValue: "44",
    successDescriptionKey: "commands.personal.provider.model_embedding.success_description",
    expectedModelName: "embedding-model",
    expectedWrite: { embedding_model_id: 44 },
  },
] as const;

async function runSubcommand(modulePath: string): Promise<void> {
  const { execute } = await import(modulePath);
  await execute({} as Client, makeInteraction(), userData, "en-US");
}

beforeEach(() => {
  scenario = makeScenario();
  chronology.length = 0;
  infoReplies.length = 0;
  replacements.length = 0;
  initialPayloads.length = 0;
  assignCalls.length = 0;
  errorLogs.length = 0;
});

describe("personal provider model-* anchor workflow", () => {
  for (const subcommand of subcommands) {
    it(`${subcommand.name} writes its own column and renders success on the anchor message`, async () => {
      scenario.submittedValue = subcommand.submittedValue;

      await runSubcommand(subcommand.module);

      // The write targets the selected provider, this capability, and only its column.
      expect(assignCalls).toHaveLength(1);
      expect(assignCalls[0]).toMatchObject({
        userId: 4,
        provider: "provider-a",
        capability: subcommand.capability,
      });
      expect(assignCalls[0]?.result).toMatchObject(subcommand.expectedWrite);

      // The terminal lands on the one anchor message, never as a fresh reply.
      expect(infoReplies).toHaveLength(0);
      expect(replacements).toContainEqual(
        expect.objectContaining({
          titleKey: "commands.personal.provider.model_success_title",
          descriptionKey: subcommand.successDescriptionKey,
          descriptionVars: {
            provider: "provider-a",
            model: subcommand.expectedModelName,
            scope_notice: "commands.personal.provider.scope_notice",
          },
        }),
      );
      // The success notice is rendered only after the write returns.
      expect(chronology.indexOf("repo.assign")).toBeLessThan(chronology.lastIndexOf("message.replace"));
    });

    it(`${subcommand.name} renders the write failure in place without a success notice`, async () => {
      scenario.submittedValue = subcommand.submittedValue;
      scenario.updateSucceeds = false;

      await runSubcommand(subcommand.module);

      expect(infoReplies).toHaveLength(0);
      expect(replacements.some((options) => options.titleKey === "general.errors.update_failed_title")).toBe(true);
      expect(
        replacements.some((options) => options.titleKey === "commands.personal.provider.model_success_title"),
      ).toBe(false);
    });

    it(`${subcommand.name} confirms before newly enabling a cross-server personal override`, async () => {
      scenario.submittedValue = subcommand.submittedValue;

      await runSubcommand(subcommand.module);

      // The confirmation must land before the write, never after it.
      const confirmIndex = replacements.findIndex(isConfirmationPayload);
      expect(confirmIndex).toBeGreaterThanOrEqual(0);
      expect(chronology.indexOf("message.replace")).toBeLessThan(chronology.indexOf("repo.assign"));
      expect(assignCalls).toHaveLength(1);
    });

    it(`${subcommand.name} skips the confirmation when the capability is already personal`, async () => {
      scenario.submittedValue = subcommand.submittedValue;
      scenario.activeCapabilityRow = subcommand.activeCapabilityRow;

      await runSubcommand(subcommand.module);

      // Switching models inside an active override changes no scope, so re-prompting is noise.
      expect(replacements.some(isConfirmationPayload)).toBe(false);
      expect(assignCalls).toHaveLength(1);
    });

    it(`${subcommand.name} writes nothing when the activation confirmation is declined`, async () => {
      scenario.submittedValue = subcommand.submittedValue;
      scenario.buttonCustomId = subcommand.declineCustomId;

      await runSubcommand(subcommand.module);

      expect(assignCalls).toHaveLength(0);
      expect(replacements).toContainEqual(
        expect.objectContaining({ titleKey: "commands.personal.provider.activation_cancelled_title" }),
      );
    });

    it(`${subcommand.name} opens the anchor message with the no-providers notice and stops`, async () => {
      scenario.providers = [];

      await runSubcommand(subcommand.module);

      // The notice is the workflow's INITIAL payload, so the user never sees a picker
      // flash before the terminal and nothing downstream runs.
      expect(initialPayloads).toEqual([
        expect.objectContaining({ titleKey: "commands.personal.provider.no_saved_title" }),
      ]);
      expect(assignCalls).toHaveLength(0);
      expect(replacements).toHaveLength(0);
      expect(infoReplies).toHaveLength(0);
    });
  }

  it("model-image routes a NovelAI pipeline provider into the NAI column instead", async () => {
    scenario.submittedValue = "33";
    scenario.imageGenerationStyle = "nai-pipeline";

    await runSubcommand("@/commands/personal/provider/model-image");

    expect(assignCalls[0]?.result).toMatchObject({
      diffusion_model_id: null,
      nai_diffusion_model_id: 33,
    });
  });

  it("model-text drops the promoted model from the saved fallback chain", async () => {
    scenario.submittedValue = "text-model";
    scenario.fallbackModelRefs = [
      { type: "llm", id: 11 },
      { type: "llm", id: 12 },
      { type: "custom_endpoint", id: 11 },
    ];

    await runSubcommand("@/commands/personal/provider/model-text");

    // Leaving the promoted model in the chain would make /personal model fallback reject
    // every later edit, since untouched slots resubmit the stale ref. The same numeric id
    // under a different ref type is a different model and must survive.
    expect(assignCalls[0]?.result).toMatchObject({
      llm_id: 11,
      fallback_model_refs: [
        { type: "llm", id: 12 },
        { type: "custom_endpoint", id: 11 },
      ],
    });
  });

  it("model-text also drops the custom endpoint backing the promoted synthetic model", async () => {
    scenario.providers = ["custom:u4:local"];
    scenario.customPrimaryEndpointMode = true;
    scenario.submittedValue = "text-model";
    scenario.fallbackModelRefs = [
      { type: "custom_endpoint", id: 5 },
      { type: "llm", id: 12 },
    ];

    await runSubcommand("@/commands/personal/provider/model-text");

    expect(assignCalls[0]?.result).toMatchObject({
      llm_id: 11,
      fallback_model_refs: [{ type: "llm", id: 12 }],
    });
  });

  it("renders the moved-model notice in place for the legacy OpenRouter sentinel", async () => {
    scenario.submittedValue = "other-model";
    llmModels.push({ ...llmModels[0], llm_id: 99, llm_codename: "other-model" });

    try {
      await runSubcommand("@/commands/personal/provider/model-text");

      expect(assignCalls).toHaveLength(0);
      expect(infoReplies).toHaveLength(0);
      expect(replacements).toContainEqual(
        expect.objectContaining({ titleKey: "general.openrouter_model_moved_title" }),
      );
    } finally {
      llmModels.pop();
    }
  });
});
