import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ChatInputCommandInteraction, Client } from "discord.js";
import type { ErrorContext, TomoriState, UserRow } from "@/types/db/schema";
import type { ModalOptions, SelectOption } from "@/types/discord/modal";
// Real namespaces captured at link time, before any `mock.module` below runs.
// `mock.module` is process-global and never restored, so every factory spreads
// the real surface and overrides only what this file controls.
import * as realTomoriStateCache from "@/utils/cache/tomoriStateCache";
import * as realRepositories from "@/utils/db/repositories";
import * as realCommandRegistry from "@/utils/discord/commandRegistry";
import * as realEmbeds from "@/utils/discord/ui/embeds";
import * as realModals from "@/utils/discord/ui/modals";
import * as realPersonaWorkflow from "@/utils/discord/ui/personaWorkflow";
import * as realCustomProviderUtils from "@/utils/provider/customProviderUtils";
import * as realProviderInfoRegistry from "@/utils/provider/providerInfoRegistry";
import * as realSavedProviderConfig from "@/utils/provider/savedProviderConfig";
import * as realLocalizer from "@/utils/text/localizer";
import { createScopedModuleMocker, overrideMembers, stubLogMembers } from "../../helpers/mockSurface";

/**
 * Anchor-migration tests for `/model fallback`.
 *
 * This command could not ride the engine's own `>25` bridge: it renders five selects over
 * one shared option list (the bridge slices only the first) and reserves one entry per page
 * for the explicit "None" choice. It therefore picks a range on the anchor message via
 * `acquireModalOptionRange` and hands the modal an already-sliced list. These tests cover
 * that hand-off plus the per-slot merge rules, and assert every terminal lands on the one
 * anchor message rather than escaping to `replyInfoEmbed`.
 */

interface NoticeOptions {
  titleKey: string;
  descriptionKey?: string;
  descriptionVars?: Record<string, string>;
}

interface FallbackRef {
  type: "llm" | "custom_endpoint";
  id: number;
}

const chronology: string[] = [];
const infoReplies: NoticeOptions[] = [];
const replacements: NoticeOptions[] = [];
/** Option lists handed to each modal opened through the anchor engine. */
const modalOptionLists: SelectOption[][] = [];
const writtenRefs: FallbackRef[][] = [];

interface Scenario {
  /** How many models the selected provider exposes (drives the range step). */
  modelCount: number;
  /** Which rendered range button the fake collector "clicks" (0-based). */
  rangePick: number;
  /** Values the fake modal submits, keyed by slot id. */
  submitted: Record<string, string>;
  /** Refs already stored on the server config. */
  existingRefs: FallbackRef[];
  /** llm_id of the primary chat model, for the conflict guard. */
  primaryLlmId: number;
  customEndpointMode: boolean;
  writeSucceeds: boolean;
}

let scenario: Scenario;

function makeScenario(): Scenario {
  return {
    modelCount: 5,
    rangePick: 0,
    submitted: {},
    existingRefs: [],
    primaryLlmId: 1,
    customEndpointMode: false,
    writeSucceeds: true,
  };
}

function makeCustomEndpoint() {
  return {
    custom_endpoint_id: 5,
    connection_id: 12,
    server_id: 7,
    user_id: null,
    label: "local",
    capability: "text",
    api_style: "openai-compatible",
    endpoint_url: "https://example.invalid/v1",
    model_name: "primary-model",
    model_ref_id: scenario.primaryLlmId,
    requires_auth: true,
    extra_config: {},
    has_tools: false,
    sees_images: false,
    sees_videos: false,
    supports_structoutput: false,
    strict_role_alternation: false,
    supports_prefix_completion: false,
    is_default: true,
  };
}

/** Model `n` is codename `model-n` with llm_id `n` (1-based), so ids are readable in assertions. */
function makeModels(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    llm_id: index + 1,
    llm_codename: `model-${index + 1}`,
    llm_provider: "provider-a",
    llm_description: "desc",
    ja_description: "desc",
    is_free: false,
    has_tools: false,
    sees_images: false,
    sees_videos: false,
    supports_structoutput: false,
    is_scoped_registration: false,
  }));
}

const tomoriState = {
  server_id: 7,
  persona_id: 70,
  llm: { llm_id: 1, llm_codename: "primary-model", llm_provider: "provider-a" },
  get config() {
    return {
      llm_id: scenario.primaryLlmId,
      fallback_model_refs: scenario.existingRefs,
    };
  },
  fallback_chain: [],
} as unknown as TomoriState;

const scopedMock = createScopedModuleMocker(mock, {
  "@/utils/cache/tomoriStateCache": realTomoriStateCache,
  "@/utils/provider/savedProviderConfig": realSavedProviderConfig,
  "@/utils/db/repositories": realRepositories,
  "@/utils/discord/ui/embeds": realEmbeds,
  "@/utils/discord/ui/modals": realModals,
  "@/utils/provider/providerInfoRegistry": realProviderInfoRegistry,
  "@/utils/provider/customProviderUtils": realCustomProviderUtils,
  "@/utils/discord/commandRegistry": realCommandRegistry,
  "@/utils/text/localizer": realLocalizer,
  "@/utils/discord/ui/personaWorkflow": realPersonaWorkflow,
});

scopedMock.module("@/utils/cache/tomoriStateCache", () => ({
  ...realTomoriStateCache,
  getCachedTomoriState: async () => tomoriState,
  getCachedAllPersonas: async () => [],
  getCachedMainPersona: async () => tomoriState,
  invalidateTomoriStateCache: () => undefined,
  getLastDbError: () => null,
}));

scopedMock.module("@/utils/provider/savedProviderConfig", () => ({
  ...realSavedProviderConfig,
  loadSavedProvidersForCapability: async () => [{ provider: scenario.customEndpointMode ? "custom:12" : "provider-a" }],
  loadUserSavedProvidersForCapability: async () => [{ provider: "provider-a" }],
}));

// Spreading the real barrel replaces the hand-maintained list of repository
// placeholders this mock used to carry: every repository stays real except the
// three whose methods this command drives, which delegate through their
// prototype so their remaining methods survive for later test files.
scopedMock.module("@/utils/db/repositories", () => ({
  ...realRepositories,
  llmModelRepo: overrideMembers(realRepositories.llmModelRepo, {
    loadAvailableModelsForProvider: async () => makeModels(scenario.modelCount),
    getLlmsByIds: async () => [],
  }),
  llmOverrideRepo: overrideMembers(realRepositories.llmOverrideRepo, {
    setFallbackModelRefs: async (_serverId: number, refs: FallbackRef[]) => {
      chronology.push("repo.write");
      writtenRefs.push(refs);
      return scenario.writeSucceeds;
    },
  }),
  llmProviderRepo: overrideMembers(realRepositories.llmProviderRepo, {
    loadCustomEndpointsForServer: async () => (scenario.customEndpointMode ? [makeCustomEndpoint()] : []),
    loadCustomEndpointsByIds: async () => (scenario.customEndpointMode ? [makeCustomEndpoint()] : []),
  }),
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
  getStaticProviderInfo: () => null,
}));

scopedMock.module("@/utils/provider/customProviderUtils", () => ({
  ...realCustomProviderUtils,
  isCustomProvider: () => scenario.customEndpointMode,
  parseCustomProvider: () => (scenario.customEndpointMode ? { raw: "custom:12", connectionId: 12 } : null),
}));

scopedMock.module("@/utils/discord/commandRegistry", () => ({
  ...realCommandRegistry,
  commandRegistry: overrideMembers(realCommandRegistry.commandRegistry, {
    getCommandMention: () => "/providers",
  }),
}));

stubLogMembers({
  error: async (_message: string, _error: Error, _context: ErrorContext) => {
    chronology.push("log.error");
  },
  info: () => undefined,
  warn: () => undefined,
});

scopedMock.module("@/utils/text/localizer", () => ({
  ...realLocalizer,
  localizer: (_locale: string, key: string) => key,
}));

/**
 * Recursively collects every `customId` in a rendered payload. The range selector is built
 * by the REAL `buildRangeSelectorPayload`, so the fake collector can hand back a button that
 * genuinely exists in what was just rendered instead of inventing an id.
 */
function collectCustomIds(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) collectCustomIds(child, found);
    return found;
  }
  if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (typeof record.customId === "string") found.push(record.customId);
    for (const value of Object.values(record)) {
      if (value && typeof value === "object") collectCustomIds(value, found);
    }
  }
  return found;
}

let lastRendered: unknown = null;

function makeAnchorController() {
  const replace = async (payload: NoticeOptions) => {
    chronology.push("message.replace");
    lastRendered = payload;
    replacements.push(payload);
    return {};
  };
  return {
    anchorMessageId: "anchor-msg",
    fetchMessage: async () => ({
      id: "anchor-msg",
      awaitMessageComponent: async () => {
        // Prefer a real range button from the payload on screen; otherwise this is the
        // provider/opener step, which resolves from the saved-provider list.
        const rangeIds = collectCustomIds(lastRendered).filter((id) => id.includes("_range_"));
        const customId = rangeIds[scenario.rangePick] ?? rangeIds[0] ?? "opener";
        return { id: "btn", customId, user: { id: "user-1" } };
      },
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
    const controller = makeAnchorController();
    lastRendered = initialPayload;
    const modalPhase = {
      get values() {
        return scenario.submitted;
      },
      message: controller,
      beginInPlaceWork: async () => ({ message: controller }),
      replace: controller.replace,
    };
    const nestedButton = {
      message: controller,
      replace: controller.replace,
      beginInPlaceWork: async () => ({ message: controller }),
      openModal: async (options: ModalOptions) => {
        const select = options.components.find((component) => "options" in component);
        if (select && "options" in select) modalOptionLists.push(select.options as SelectOption[]);
        return { outcome: "submitted", phase: modalPhase };
      },
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
    id: "interaction-1",
    channel: { id: "channel-1" },
    channelId: "channel-1",
    guild: { id: "guild-1" },
    guildId: "guild-1",
    user: { id: "user-1" },
    options: { getString: () => null },
  } as unknown as ChatInputCommandInteraction;
}

const userData = { user_id: 4, user_disc_id: "user-1", language_pref: "en-US" } as unknown as UserRow;

async function runCommand(): Promise<void> {
  const { execute } = await import("@/commands/model/fallback");
  await execute({} as Client, makeInteraction(), userData, "en-US");
}

beforeEach(() => {
  scenario = makeScenario();
  chronology.length = 0;
  infoReplies.length = 0;
  replacements.length = 0;
  modalOptionLists.length = 0;
  writtenRefs.length = 0;
  lastRendered = null;
});

describe("/model fallback anchor workflow", () => {
  it("prepends the clear option and skips the range step at or below 24 models", async () => {
    scenario.modelCount = 5;
    scenario.submitted = { fallback_slot_1: "model-2" };

    await runCommand();

    expect(modalOptionLists).toHaveLength(1);
    const options = modalOptionLists[0];
    expect(options).toHaveLength(6);
    expect(options[0]?.value).toBe("__none__");
    expect(options[1]?.value).toBe("model-1");
    expect(replacements.some((payload) => payload.titleKey === "general.pagination.select_page_title")).toBe(false);
    expect(writtenRefs).toEqual([[{ type: "llm", id: 2 }]]);
  });

  it("slices to the chosen range and still offers the clear option on a later page", async () => {
    scenario.modelCount = 60;
    scenario.rangePick = 1; // second range button => models 25-48
    scenario.submitted = { fallback_slot_1: "model-30" };

    await runCommand();

    const options = modalOptionLists[0];
    // The clear entry is re-prepended to the page, so a user deep in the list can still
    // empty a slot: the behaviour the flat 25-wide bridge would have lost.
    expect(options[0]?.value).toBe("__none__");
    expect(options).toHaveLength(25);
    expect(options[1]?.value).toBe("model-25");
    expect(options.at(-1)?.value).toBe("model-48");
    expect(writtenRefs).toEqual([[{ type: "llm", id: 30 }]]);
  });

  it("keeps untouched slots, clears explicit __none__ slots, and de-duplicates", async () => {
    scenario.modelCount = 5;
    scenario.existingRefs = [
      { type: "llm", id: 2 },
      { type: "llm", id: 3 },
      { type: "llm", id: 4 },
    ];
    scenario.submitted = {
      fallback_slot_1: "", // untouched -> keeps id 2
      fallback_slot_2: "__none__", // explicit clear -> drops id 3
      fallback_slot_3: "model-2", // duplicate of slot 1 -> de-duplicated away
      fallback_slot_4: "model-5",
    };

    await runCommand();

    expect(writtenRefs).toEqual([
      [
        { type: "llm", id: 2 },
        { type: "llm", id: 5 },
      ],
    ]);
    expect(infoReplies).toHaveLength(0);
  });

  it("refuses a chain containing the primary model and never writes", async () => {
    scenario.modelCount = 5;
    scenario.primaryLlmId = 3;
    scenario.submitted = { fallback_slot_1: "model-3" };

    await runCommand();

    expect(writtenRefs).toHaveLength(0);
    expect(infoReplies).toHaveLength(0);
    expect(replacements).toContainEqual(
      expect.objectContaining({ titleKey: "commands.model.fallback.primary_conflict_title" }),
    );
  });

  it("drops an inherited primary duplicate instead of refusing the whole submission", async () => {
    scenario.modelCount = 5;
    scenario.primaryLlmId = 3;
    scenario.existingRefs = [
      { type: "llm", id: 3 },
      { type: "llm", id: 4 },
    ];
    scenario.submitted = { fallback_slot_3: "model-5" };

    await runCommand();

    // Slot 1 was never touched, so the stale ref is the command's own leftover from a later
    // primary promotion. Erroring on it would lock the user out of every future edit.
    expect(writtenRefs).toEqual([
      [
        { type: "llm", id: 4 },
        { type: "llm", id: 5 },
      ],
    ]);
    expect(replacements).not.toContainEqual(
      expect.objectContaining({ titleKey: "commands.model.fallback.primary_conflict_title" }),
    );
  });

  it("rejects a custom endpoint backed by the primary synthetic LLM", async () => {
    scenario.customEndpointMode = true;
    scenario.primaryLlmId = 42;
    scenario.submitted = { fallback_slot_1: "ce:5" };

    await runCommand();

    expect(writtenRefs).toHaveLength(0);
    expect(replacements).toContainEqual(
      expect.objectContaining({ titleKey: "commands.model.fallback.primary_conflict_title" }),
    );
  });

  it("silently prunes an inherited custom endpoint backed by the primary", async () => {
    scenario.customEndpointMode = true;
    scenario.primaryLlmId = 42;
    scenario.existingRefs = [{ type: "custom_endpoint", id: 5 }];
    scenario.submitted = { fallback_slot_2: "__none__" };

    await runCommand();

    expect(writtenRefs).toEqual([[]]);
  });

  it("renders the cleared terminal in place when every slot is emptied", async () => {
    scenario.modelCount = 5;
    scenario.existingRefs = [{ type: "llm", id: 2 }];
    scenario.submitted = { fallback_slot_1: "__none__" };

    await runCommand();

    expect(writtenRefs).toEqual([[]]);
    expect(infoReplies).toHaveLength(0);
    expect(replacements).toContainEqual(expect.objectContaining({ titleKey: "commands.model.fallback.cleared_title" }));
  });

  it("renders the write failure in place without a success notice", async () => {
    scenario.modelCount = 5;
    scenario.submitted = { fallback_slot_1: "model-2" };
    scenario.writeSucceeds = false;

    await runCommand();

    expect(infoReplies).toHaveLength(0);
    expect(replacements.some((payload) => payload.titleKey === "general.errors.update_failed_title")).toBe(true);
    expect(replacements.some((payload) => payload.titleKey === "commands.model.fallback.success_title")).toBe(false);
  });
});
