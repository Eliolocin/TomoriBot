/**
 * Route coverage for the `/config` Persona surface.
 *
 * Drives the real registered route through the real policy, catalog, and renderer. Where a test
 * proves that a denied actor writes nothing, it spies on the repository the canonical operation
 * actually calls rather than substituting an operations double, because a double would restate the
 * expected answer instead of exercising the guard.
 */
import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import { MessageFlags, PermissionsBitField, type APIAttachment, type Client } from "discord.js";
import type { StmCategoryRow, TomoriState } from "@/types/db/schema";
import type { ConditioningGroup } from "@/utils/db/repositories/ConditioningMemoryRepository";
import { conditioningMemoryRepository } from "@/utils/db/repositories/ConditioningMemoryRepository";
import * as shortTermMemoryCache from "@/utils/cache/shortTermMemoryCache";
import {
  personalMemoryRepository,
  personaRepository,
  serverMemoryRepository,
  userRepository,
} from "@/utils/db/repositories";
import { shortTermMemoryRepository } from "@/utils/db/repositories/ShortTermMemoryRepository";
import { execute as executeConditioningManage } from "@/commands/conditioning/manage";
import * as modalModule from "@/utils/discord/ui/modals";
import {
  CONFIG_ROUTE_CODECS,
  buildConfigRouteId,
  computeAttributeFingerprint,
  computeConditioningRemoveFingerprint,
  computeDialogueFingerprint,
  computeTriggerRemoveFingerprint,
  parseConfigPanelRoute,
  type ConfigPanelRoute,
} from "@/utils/discord/configPanelCatalog";
import { createConfigInteractionRoute, loadConfigPersonaMemoryView } from "@/utils/discord/interactions/configRoutes";
import {
  asEphemeralComponentsV2FollowUp,
  type ConfigPersonaMemoryView,
  type ConfigRouteDependencies,
  type ConfigScope,
} from "@/utils/discord/interactions/configRouteContext";
import { configPersonaOperations } from "@/utils/discord/interactions/configPersonaOperations";
import {
  InteractionRouteRegistry,
  parseInteractionRoute,
  type ParsedInteractionRoute,
} from "@/utils/discord/interactions/routeRegistry";
import {
  buildConditioningCheckboxGroupId,
  buildConfigModalFieldId,
  buildTriggerRemoveCheckboxGroupId,
} from "@/utils/discord/ui/configModals";
import { loadCommandData } from "@/utils/discord/commandLoader";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const CLIENT = {} as Client;

function requireRoute(customId: string): ParsedInteractionRoute {
  const parsed = parseInteractionRoute(customId);
  if (!parsed) throw new Error(`Failed to parse route for customId: ${customId}`);
  return parsed;
}

function makePersona(overrides: Partial<TomoriState> & { persona_id: number }): TomoriState {
  return {
    server_id: 9,
    persona_nickname: `Persona ${overrides.persona_id}`,
    is_alter: false,
    trigger_words: [],
    naming_config: { prefixes: {}, suffixes: {}, addressTerms: {} },
    persona_prompt: null,
    attribute_list: [],
    sample_dialogues_in: [],
    sample_dialogues_out: [],
    webhook_avatar_url: null,
    is_pointer: false,
    ...overrides,
  } as unknown as TomoriState;
}

const MAIN = makePersona({ persona_id: 55, persona_nickname: "Aphel", trigger_words: ["aphel", "hey aphel"] });
const ALTER = makePersona({ persona_id: 56, persona_nickname: "Wren", is_alter: true });

function makeTeachingPersona(
  overrides: Partial<TomoriState> & { persona_id: number },
  flags: { attribute?: boolean; dialogue?: boolean } = {},
): TomoriState {
  return makePersona({
    ...overrides,
    config: {
      attribute_memteaching_enabled: flags.attribute ?? true,
      sampledialogue_memteaching_enabled: flags.dialogue ?? true,
    } as TomoriState["config"],
  });
}

function makeTxtAttachment(text: string): APIAttachment {
  return {
    id: "attachment-1",
    filename: "memories.txt",
    size: Buffer.byteLength(text),
    url: `data:text/plain;base64,${Buffer.from(text, "utf8").toString("base64")}`,
    proxy_url: "https://cdn.example.invalid/memories.txt",
    content_type: "text/plain",
  };
}

const STM_SUMMARY_CATEGORY: StmCategoryRow = {
  server_id: 9,
  position: 0,
  label: "Summary",
  description: "Current summary",
};

const STM_CATEGORY_ROWS: StmCategoryRow[] = [
  STM_SUMMARY_CATEGORY,
  { server_id: 9, position: 1, label: "People", description: "People in the scene" },
];

const CONDITIONING_GROUP: ConditioningGroup = {
  conditioningType: "reward",
  actionKey: "headpat",
  reasonText: "The persona was helpful",
  reasonNormalized: "the persona was helpful",
  actionText: "A gentle headpat",
  totalCount: 2,
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  userDiscIds: ["user-1"],
  conditioningIds: [101],
};

function makeMemoryView(overrides: Partial<ConfigPersonaMemoryView> = {}): ConfigPersonaMemoryView {
  return {
    serverMemoryCount: 3,
    personalMemoryCount: 2,
    channelId: "channel-1",
    stmCategories: [STM_SUMMARY_CATEGORY],
    conditioningGroups: [CONDITIONING_GROUP],
    ...overrides,
  };
}

interface HarnessOptions {
  isManager?: boolean;
  inGuild?: boolean;
  personas?: TomoriState[];
  refreshedPersonas?: TomoriState[];
  personaMemoryView?: ConfigPersonaMemoryView;
  operations?: Partial<ConfigRouteDependencies["operations"]>;
}

interface Harness {
  dependencies: Partial<ConfigRouteDependencies>;
  telemetry: string[];
  edits: unknown[];
  replies: unknown[];
  modals: unknown[];
  scopeLoads: boolean[];
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const telemetry: string[] = [];
  const edits: unknown[] = [];
  const replies: unknown[] = [];
  const modals: unknown[] = [];
  const scopeLoads: boolean[] = [];

  const buildScope = (forceRefresh: boolean): ConfigScope => ({
    serverDiscId: options.inGuild === false ? "user-1" : "guild-1",
    guildId: options.inGuild === false ? null : "guild-1",
    internalServerId: 9,
    userId: 1,
    actor:
      options.inGuild === false
        ? { workspaceKind: "dm", isManager: true }
        : { workspaceKind: "guild", isManager: options.isManager ?? true },
    personas: (forceRefresh ? (options.refreshedPersonas ?? options.personas) : options.personas) ?? [MAIN, ALTER],
    readStatus: "fresh",
  });

  return {
    telemetry,
    edits,
    replies,
    modals,
    scopeLoads,
    dependencies: {
      resolveScope: async (_interaction, forceRefresh = false) => {
        scopeLoads.push(forceRefresh);
        return buildScope(forceRefresh);
      },
      getPersonaAvatarData: async () => ({ url: null, files: [] }),
      loadPersonaMemoryView: async () => options.personaMemoryView ?? makeMemoryView(),
      openServerMemoryPanel: async () => ({ components: [], flags: 32768 }),
      openPersonalMemoryPanel: async () => ({ components: [], flags: 32768 }),
      createGuildIdentity: () => ({
        setNickname: async () => true,
        setAvatar: async () => ({ ok: true, rateLimited: false }),
        currentAvatarReference: async () => null,
      }),
      recordAction: (input) => {
        telemetry.push(input.action);
      },
      createNonce: () => "nonce1234567",
      showModal: async (_interaction, payload) => {
        modals.push(payload);
      },
      takeAvatarUpload: () => undefined,
      takeCheckboxValues: () => [],
      operations: { ...configPersonaOperations, ...options.operations },
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
  let replied = false;
  const kind = options.kind ?? "button";

  const interaction = {
    id: "interaction-1",
    customId: options.customId,
    user: { id: "user-1", username: "Sparrow" },
    channelId: "channel-1",
    channel: { name: "lounge" },
    guildId: options.inGuild === false ? null : "guild-1",
    guild: options.inGuild === false ? null : { members: { me: null, fetch: async () => null } },
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
      return replied;
    },
    deferUpdate: async () => {
      deferred = true;
    },
    editReply: async (payload: unknown) => {
      options.harness.edits.push(payload);
      return payload;
    },
    reply: async (payload: unknown) => {
      replied = true;
      options.harness.replies.push(payload);
      return payload;
    },
    followUp: async (payload: unknown) => {
      options.harness.replies.push(payload);
      return payload;
    },
    fields: {
      getTextInputValue: (fieldId: string) => options.fields?.[fieldId] ?? "",
    },
  };

  return interaction as unknown as Parameters<ReturnType<typeof createConfigInteractionRoute>["execute"]>[1] & {
    deferred: boolean;
  };
}

async function dispatch(harness: Harness, interaction: ReturnType<typeof makeInteraction>): Promise<void> {
  const registry = new InteractionRouteRegistry([createConfigInteractionRoute(harness.dependencies)]);
  await registry.dispatch(CLIENT, interaction);
}

/**
 * Pins the `/config` v1 wire contract: each literal custom ID and the exact route it must decode to.
 * Encoding and decoding through one shared codec table cannot catch a field reordering, because
 * both sides move together and a round-trip still succeeds; only literal bytes can.
 */
const WIRE_CONTRACT_V1: ReadonlyArray<readonly [string, ConfigPanelRoute]> = [
  [
    "config:v1:category:en-US:persona:general",
    { action: "category", locale: "en-US", category: "persona", page: "general" },
  ],
  ["config:v1:page:en-US:models:switch", { action: "page", locale: "en-US", category: "models", page: "switch" }],
  ["config:v1:persona-select:en-US:55", { action: "persona-select", locale: "en-US", personaId: 55 }],
  ["config:v1:persona-page:en-US:55:25", { action: "persona-page", locale: "en-US", personaId: 55, start: 25 }],
  ["config:v1:server-memory:en-US:55", { action: "server-memory-open", locale: "en-US", personaId: 55 }],
  ["config:v1:personal-memory:en-US:55", { action: "personal-memory-open", locale: "en-US", personaId: 55 }],
  ["config:v1:stm-edit-open:en-US:55", { action: "stm-edit-open", locale: "en-US", personaId: 55 }],
  [
    "config:v1:stm-edit-submit:en-US:55:nonce1234567",
    { action: "stm-edit-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
  ],
  ["config:v1:conditioning-open:en-US:55", { action: "conditioning-open", locale: "en-US", personaId: 55 }],
  [
    "config:v1:conditioning-submit:en-US:55:abcd1234:nonce1234567",
    {
      action: "conditioning-submit",
      locale: "en-US",
      personaId: 55,
      fp: "abcd1234",
      nonce: "nonce1234567",
    },
  ],
  ["config:v1:avatar-open:en-US:55", { action: "avatar-open", locale: "en-US", personaId: 55 }],
  [
    "config:v1:avatar-submit:en-US:55:nonce1234567",
    { action: "avatar-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
  ],
  ["config:v1:rename-open:en-US:55", { action: "rename-open", locale: "en-US", personaId: 55 }],
  [
    "config:v1:rename-submit:en-US:55:nonce1234567",
    { action: "rename-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
  ],
  ["config:v1:naming-style:en-US:55", { action: "naming-style-select", locale: "en-US", personaId: 55 }],
  [
    "config:v1:naming-open:en-US:55:neutral",
    { action: "naming-open", locale: "en-US", personaId: 55, style: "neutral" },
  ],
  [
    "config:v1:naming-submit:en-US:55:feminine:nonce1234567",
    { action: "naming-submit", locale: "en-US", personaId: 55, style: "feminine", nonce: "nonce1234567" },
  ],
  ["config:v1:trig-add-open:en-US:55", { action: "trigger-add-open", locale: "en-US", personaId: 55 }],
  [
    "config:v1:trig-add-sub:en-US:55:nonce1234567",
    { action: "trigger-add-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
  ],
  ["config:v1:trig-rem-open:en-US:55", { action: "trigger-remove-open", locale: "en-US", personaId: 55 }],
  [
    "config:v1:trig-rem-sub:en-US:55:abcd1234:nonce1234567",
    { action: "trigger-remove-submit", locale: "en-US", personaId: 55, fp: "abcd1234", nonce: "nonce1234567" },
  ],
  ["config:v1:attr-select:en-US:55", { action: "attribute-select", locale: "en-US", personaId: 55 }],
  ["config:v1:attr-page:en-US:55:24", { action: "attribute-page", locale: "en-US", personaId: 55, start: 24 }],
  ["config:v1:attr-add-open:en-US:55", { action: "attribute-add-open", locale: "en-US", personaId: 55 }],
  [
    "config:v1:attr-add-sub:en-US:55:nonce1234567",
    { action: "attribute-add-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
  ],
  [
    "config:v1:attr-edit-open:en-US:55:0:abcd1234",
    { action: "attribute-edit-open", locale: "en-US", personaId: 55, index: 0, fp: "abcd1234" },
  ],
  [
    "config:v1:attr-edit-sub:en-US:55:0:abcd1234:nonce1234567",
    {
      action: "attribute-edit-submit",
      locale: "en-US",
      personaId: 55,
      index: 0,
      fp: "abcd1234",
      nonce: "nonce1234567",
    },
  ],
  [
    "config:v1:attr-remove:en-US:55:0:abcd1234",
    { action: "attribute-remove", locale: "en-US", personaId: 55, index: 0, fp: "abcd1234" },
  ],
  ["config:v1:dlg-select:en-US:55", { action: "dialogue-select", locale: "en-US", personaId: 55 }],
  ["config:v1:dlg-page:en-US:55:24", { action: "dialogue-page", locale: "en-US", personaId: 55, start: 24 }],
  ["config:v1:dlg-add-open:en-US:55", { action: "dialogue-add-open", locale: "en-US", personaId: 55 }],
  [
    "config:v1:dlg-add-sub:en-US:55:nonce1234567",
    { action: "dialogue-add-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
  ],
  [
    "config:v1:dlg-edit-open:en-US:55:0:abcd1234",
    { action: "dialogue-edit-open", locale: "en-US", personaId: 55, index: 0, fp: "abcd1234" },
  ],
  [
    "config:v1:dlg-edit-sub:en-US:55:0:abcd1234:nonce1234567",
    {
      action: "dialogue-edit-submit",
      locale: "en-US",
      personaId: 55,
      index: 0,
      fp: "abcd1234",
      nonce: "nonce1234567",
    },
  ],
  [
    "config:v1:dlg-remove:en-US:55:0:abcd1234",
    { action: "dialogue-remove", locale: "en-US", personaId: 55, index: 0, fp: "abcd1234" },
  ],
  ["config:v1:promote-view:en-US:56", { action: "promote-view", locale: "en-US", personaId: 56 }],
  [
    "config:v1:promote-confirm:en-US:56:nonce1234567",
    { action: "promote-confirm", locale: "en-US", personaId: 56, nonce: "nonce1234567" },
  ],
  ["config:v1:promote-cancel:en-US:56", { action: "promote-cancel", locale: "en-US", personaId: 56 }],
  [
    "config:v1:retry:en-US:persona:general:55",
    { action: "retry", locale: "en-US", category: "persona", page: "general", personaId: 55 },
  ],
  [
    "config:v1:refresh:en-US:persona:general",
    { action: "refresh", locale: "en-US", category: "persona", page: "general" },
  ],
];

describe("config route wire contract", () => {
  it("decodes every pinned v1 wire string to its exact route", () => {
    for (const [customId, expected] of WIRE_CONTRACT_V1) {
      expect(customId.length).toBeLessThanOrEqual(100);
      expect(parseConfigPanelRoute(requireRoute(customId))).toEqual(expected);
    }
  });

  it("re-encodes every pinned route to the exact wire string it came from", () => {
    for (const [customId, route] of WIRE_CONTRACT_V1) {
      expect(buildConfigRouteId(route)).toBe(customId);
    }
  });

  it("covers every declared action in the pinned wire contract", () => {
    const pinned = new Set(WIRE_CONTRACT_V1.map(([, route]) => route.action));
    expect([...pinned].sort()).toEqual(Object.keys(CONFIG_ROUTE_CODECS).sort());
  });

  it("rejects a malformed or out-of-range field rather than defaulting it", () => {
    expect(parseConfigPanelRoute(requireRoute("config:v1:persona-select:en-US:0"))).toBeNull();
    expect(parseConfigPanelRoute(requireRoute("config:v1:persona-select:en-US:abc"))).toBeNull();
    // `general` is a Behavior page too, so a page must decode against its own category.
    expect(parseConfigPanelRoute(requireRoute("config:v1:page:en-US:models:general"))).toBeNull();
    expect(parseConfigPanelRoute(requireRoute("config:v1:naming-open:en-US:55:androgynous"))).toBeNull();
    expect(parseConfigPanelRoute(requireRoute("config:v1:not-a-token:en-US:55"))).toBeNull();
  });
});

describe("config route authorization", () => {
  it("writes nothing when a guild member replays a manager-owned rename", async () => {
    const renameSpy = spyOn(personaRepository, "renamePersona");
    const harness = makeHarness({ isManager: false });
    const customId = buildConfigRouteId({
      action: "rename-submit",
      locale: "en-US",
      personaId: 55,
      nonce: "nonce1234567",
    });

    await dispatch(
      harness,
      makeInteraction({
        customId,
        kind: "modal",
        isManager: false,
        harness,
        fields: { [buildConfigModalFieldId("nickname", "nonce1234567")]: "Renamed" },
      }),
    );

    expect(renameSpy).not.toHaveBeenCalled();
    expect(harness.telemetry).toEqual([]);
    renameSpy.mockRestore();
  });

  it("reaches the same repository write when the identical route carries a manager", async () => {
    // Pairs with the denial above so that test cannot pass vacuously: the only difference between
    // the two dispatches is the actor resolved from the interaction.
    const renameSpy = spyOn(personaRepository, "renamePersona").mockResolvedValue(true);
    const conflictSpy = spyOn(personaRepository, "hasNicknameConflict").mockResolvedValue(false);
    const triggerSpy = spyOn(personaRepository, "addTrigger").mockResolvedValue(true);
    const harness = makeHarness({ isManager: true });
    const customId = buildConfigRouteId({
      action: "rename-submit",
      locale: "en-US",
      personaId: 55,
      nonce: "nonce1234567",
    });

    await dispatch(
      harness,
      makeInteraction({
        customId,
        kind: "modal",
        isManager: true,
        harness,
        fields: { [buildConfigModalFieldId("nickname", "nonce1234567")]: "Renamed" },
      }),
    );

    expect(renameSpy).toHaveBeenCalledWith(55, "Renamed");
    expect(harness.telemetry).toEqual(["server-config.workspace.persona.rename"]);
    renameSpy.mockRestore();
    conflictSpy.mockRestore();
    triggerSpy.mockRestore();
  });

  it("writes nothing when a DM actor replays a guild-only trigger add", async () => {
    const addSpy = spyOn(personaRepository, "addTrigger");
    const harness = makeHarness({ inGuild: false });
    const customId = buildConfigRouteId({
      action: "trigger-add-submit",
      locale: "en-US",
      personaId: 55,
      nonce: "nonce1234567",
    });

    await dispatch(
      harness,
      makeInteraction({
        customId,
        kind: "modal",
        inGuild: false,
        harness,
        fields: { [buildConfigModalFieldId("triggers", "nonce1234567")]: "wren" },
      }),
    );

    expect(addSpy).not.toHaveBeenCalled();
    expect(harness.telemetry).toEqual([]);
    addSpy.mockRestore();
  });

  it("refuses a forged modal open without opening the modal", async () => {
    const harness = makeHarness({ isManager: false });
    const customId = buildConfigRouteId({ action: "avatar-open", locale: "en-US", personaId: 55 });

    await dispatch(harness, makeInteraction({ customId, isManager: false, harness }));

    expect(harness.modals).toEqual([]);
    expect(harness.replies).toHaveLength(1);
  });
});

describe("config route write behavior", () => {
  it("reports a nickname conflict when a concurrent rename wins the write race", async () => {
    const conflictSpy = spyOn(personaRepository, "hasNicknameConflict")
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const renameSpy = spyOn(personaRepository, "renamePersona").mockResolvedValue(false);

    const result = await configPersonaOperations.rename({
      persona: MAIN,
      serverDiscId: "guild-1",
      newNickname: "Renamed",
      guildIdentity: null,
    });

    expect(result).toEqual({ status: "name-conflict", nickname: "Renamed" });
    expect(renameSpy).toHaveBeenCalledWith(55, "Renamed");
    expect(conflictSpy).toHaveBeenNthCalledWith(1, 9, 55, "Renamed");
    expect(conflictSpy).toHaveBeenNthCalledWith(2, 9, 55, "Renamed");
    conflictSpy.mockRestore();
    renameSpy.mockRestore();
  });

  it("rejects a rename route carried by a button before reaching the repository", async () => {
    const renameSpy = spyOn(personaRepository, "renamePersona");
    const harness = makeHarness();
    const customId = buildConfigRouteId({
      action: "rename-submit",
      locale: "en-US",
      personaId: 55,
      nonce: "nonce1234567",
    });

    await expect(dispatch(harness, makeInteraction({ customId, kind: "button", harness }))).rejects.toThrow(
      "Config rename-submit route requires a modal submission",
    );

    expect(renameSpy).not.toHaveBeenCalled();
    renameSpy.mockRestore();
  });

  it("acknowledges the interaction before the write and repaints from a refreshed read", async () => {
    let acknowledgedDuringWrite = false;
    const renamed = makePersona({ persona_id: 55, persona_nickname: "Renamed", trigger_words: ["aphel", "renamed"] });
    const harness = makeHarness({
      personas: [MAIN, ALTER],
      refreshedPersonas: [renamed, ALTER],
      operations: {
        rename: async () => {
          acknowledgedDuringWrite = interaction.deferred;
          return {
            status: "success",
            oldNickname: "Aphel",
            newNickname: "Renamed",
            triggerAdded: true,
            guildNicknameSynced: true,
          };
        },
      },
    });
    const interaction = makeInteraction({
      customId: buildConfigRouteId({ action: "rename-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" }),
      kind: "modal",
      harness,
      fields: { [buildConfigModalFieldId("nickname", "nonce1234567")]: "Renamed" },
    });

    await dispatch(harness, interaction);

    expect(acknowledgedDuringWrite).toBe(true);
    expect(harness.telemetry).toEqual(["server-config.workspace.persona.rename"]);
    // A forced reload followed the write, so the repaint cannot show a pre-write value.
    expect(harness.scopeLoads).toContain(true);
    expect(JSON.stringify(harness.edits.at(-1))).toContain("Renamed");
  });

  it("writes nothing when the routed persona no longer exists in the workspace", async () => {
    // Falling back to the main persona is right for navigation and catastrophic for a write, so a
    // write whose target vanished must repaint instead of retargeting.
    let renameCalls = 0;
    const harness = makeHarness({
      personas: [MAIN],
      operations: {
        rename: async () => {
          renameCalls += 1;
          return { status: "write-failed" };
        },
      },
    });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "rename-submit",
          locale: "en-US",
          personaId: 999,
          nonce: "nonce1234567",
        }),
        kind: "modal",
        harness,
        fields: { [buildConfigModalFieldId("nickname", "nonce1234567")]: "Renamed" },
      }),
    );

    expect(renameCalls).toBe(0);
    expect(harness.telemetry).toEqual([]);
    expect(harness.edits).toHaveLength(1);
  });

  it("falls back to the main persona for navigation when the routed persona is gone", async () => {
    const harness = makeHarness({ personas: [MAIN] });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "persona-select", locale: "en-US", personaId: 999 }),
        kind: "select",
        values: [],
        harness,
      }),
    );

    const rendered = JSON.stringify(harness.edits.at(-1));
    expect(rendered).toContain(buildConfigRouteId({ action: "rename-open", locale: "en-US", personaId: 55 }));
  });

  it("reads the newly selected persona from the submitted value, not the route", async () => {
    const harness = makeHarness();

    await dispatch(
      harness,
      makeInteraction({
        // The custom ID names the persona that was selected when the menu rendered.
        customId: buildConfigRouteId({ action: "persona-select", locale: "en-US", personaId: 55 }),
        kind: "select",
        values: ["56"],
        harness,
      }),
    );

    const rendered = JSON.stringify(harness.edits.at(-1));
    expect(rendered).toContain(buildConfigRouteId({ action: "promote-view", locale: "en-US", personaId: 56 }));
  });

  it("reads the newly selected page from the submitted value and refuses one the actor cannot open", async () => {
    const allowed = makeHarness();
    await dispatch(
      allowed,
      makeInteraction({
        customId: buildConfigRouteId({ action: "page", locale: "en-US", category: "persona", page: "general" }),
        kind: "select",
        values: ["sprites"],
        harness: allowed,
      }),
    );
    expect(JSON.stringify(allowed.edits.at(-1))).toContain("Sprites");

    const denied = makeHarness({ isManager: false });
    await dispatch(
      denied,
      makeInteraction({
        customId: buildConfigRouteId({ action: "page", locale: "en-US", category: "persona", page: "general" }),
        kind: "select",
        values: ["advanced"],
        isManager: false,
        harness: denied,
      }),
    );
    // Advanced is omitted for a member, so the submitted value is discarded rather than honoured.
    expect(JSON.stringify(denied.edits.at(-1))).not.toContain("page_persona_advanced");
    expect(JSON.stringify(denied.edits.at(-1))).toContain(
      buildConfigRouteId({ action: "rename-open", locale: "en-US", personaId: 55 }),
    );
  });

  it("keeps the naming editor on the style the select submitted", async () => {
    const persona = makePersona({
      persona_id: 55,
      persona_nickname: "Aphel",
      naming_config: { prefixes: { masculine: "Sir" }, suffixes: {}, addressTerms: {} },
    } as Partial<TomoriState> & { persona_id: number });
    const harness = makeHarness({ personas: [persona], refreshedPersonas: [persona] });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "naming-style-select", locale: "en-US", personaId: 55 }),
        kind: "select",
        values: ["masculine"],
        harness,
      }),
    );

    const rendered = JSON.stringify(harness.edits.at(-1));
    expect(rendered).toContain(
      buildConfigRouteId({ action: "naming-open", locale: "en-US", personaId: 55, style: "masculine" }),
    );
    expect(rendered).toContain("Sir");
  });
});

describe("config trigger removal", () => {
  it("removes exactly the unchecked words and leaves the checked ones", async () => {
    const persona = makePersona({ persona_id: 55, trigger_words: ["one", "two", "three"] });
    const removeSpy = spyOn(personaRepository, "removeTrigger").mockResolvedValue(true);
    const harness = makeHarness({ personas: [persona], refreshedPersonas: [persona] });
    harness.dependencies.takeCheckboxValues = (_interactionId, fieldId) =>
      fieldId === buildTriggerRemoveCheckboxGroupId(0, "nonce1234567") ? ["0", "2"] : [];

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "trigger-remove-submit",
          locale: "en-US",
          personaId: 55,
          fp: computeTriggerRemoveFingerprint(55, persona.trigger_words),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        harness,
      }),
    );

    // Unchecked means remove, so index 1 ("two") goes and the remaining list is what is written.
    expect(removeSpy).toHaveBeenCalledWith(55, ["one", "three"]);
    expect(harness.telemetry).toEqual(["server-config.workspace.persona-trigger.remove"]);
    removeSpy.mockRestore();
  });

  it("writes nothing when the trigger list changed under the open modal", async () => {
    const persona = makePersona({ persona_id: 55, trigger_words: ["one", "two", "three"] });
    const removeSpy = spyOn(personaRepository, "removeTrigger").mockResolvedValue(true);
    const harness = makeHarness({ personas: [persona] });
    harness.dependencies.takeCheckboxValues = () => ["0"];

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "trigger-remove-submit",
          locale: "en-US",
          personaId: 55,
          // Fingerprint of the list as it was before a concurrent add.
          fp: computeTriggerRemoveFingerprint(55, ["one", "two"]),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        harness,
      }),
    );

    expect(removeSpy).not.toHaveBeenCalled();
    expect(harness.telemetry).toEqual([]);
    removeSpy.mockRestore();
  });

  it("treats missing checkbox data as stale without writing", async () => {
    const persona = makePersona({ persona_id: 55, trigger_words: ["one", "two"] });
    const removeSpy = spyOn(personaRepository, "removeTrigger");
    const harness = makeHarness({ personas: [persona] });
    harness.dependencies.takeCheckboxValues = () => undefined;

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "trigger-remove-submit",
          locale: "en-US",
          personaId: 55,
          fp: computeTriggerRemoveFingerprint(55, persona.trigger_words),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        harness,
      }),
    );

    expect(removeSpy).not.toHaveBeenCalled();
    expect(harness.telemetry).toEqual([]);
    removeSpy.mockRestore();
  });

  it("removes a group when its checkbox data is an explicit empty array", async () => {
    const triggerWords = Array.from({ length: 11 }, (_, index) => `word-${index}`);
    const persona = makePersona({ persona_id: 55, trigger_words: triggerWords });
    const removeSpy = spyOn(personaRepository, "removeTrigger").mockResolvedValue(true);
    const harness = makeHarness({ personas: [persona], refreshedPersonas: [persona] });
    harness.dependencies.takeCheckboxValues = (_interactionId, fieldId) => {
      if (fieldId === buildTriggerRemoveCheckboxGroupId(0, "nonce1234567")) return [];
      if (fieldId === buildTriggerRemoveCheckboxGroupId(1, "nonce1234567")) return ["10"];
      return undefined;
    };

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "trigger-remove-submit",
          locale: "en-US",
          personaId: 55,
          fp: computeTriggerRemoveFingerprint(55, triggerWords),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        harness,
      }),
    );

    expect(removeSpy).toHaveBeenCalledWith(55, ["word-10"]);
    expect(harness.telemetry).toEqual(["server-config.workspace.persona-trigger.remove"]);
    removeSpy.mockRestore();
  });

  it("binds the fingerprint to the persona as well as the list", () => {
    expect(computeTriggerRemoveFingerprint(55, ["one", "two"])).not.toBe(
      computeTriggerRemoveFingerprint(56, ["one", "two"]),
    );
    expect(computeTriggerRemoveFingerprint(55, ["one", "two"])).not.toBe(
      computeTriggerRemoveFingerprint(55, ["two", "one"]),
    );
  });
});

describe("config Persona Memories routes", () => {
  it("allows a member to read but not edit STM or remove conditioning", async () => {
    const summarySpy = spyOn(shortTermMemoryRepository, "updateSummary");
    const conditioningSpy = spyOn(conditioningMemoryRepository, "deleteGroupsForPersona");
    const harness = makeHarness({ isManager: false });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "stm-edit-submit",
          locale: "en-US",
          personaId: 55,
          nonce: "nonce1234567",
        }),
        kind: "modal",
        isManager: false,
        harness,
        fields: { [buildConfigModalFieldId("stm_cat_summary", "nonce1234567")]: "new summary" },
      }),
    );
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "conditioning-submit",
          locale: "en-US",
          personaId: 55,
          fp: computeConditioningRemoveFingerprint(55, [CONDITIONING_GROUP]),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        isManager: false,
        harness,
      }),
    );

    expect(summarySpy).not.toHaveBeenCalled();
    expect(conditioningSpy).not.toHaveBeenCalled();
    summarySpy.mockRestore();
    conditioningSpy.mockRestore();
  });

  it("allows a DM owner to edit summary STM and acknowledges before the repository write", async () => {
    let acknowledged = false;
    const harness = makeHarness({ inGuild: false });
    const interaction = makeInteraction({
      customId: buildConfigRouteId({
        action: "stm-edit-submit",
        locale: "en-US",
        personaId: 55,
        nonce: "nonce1234567",
      }),
      kind: "modal",
      inGuild: false,
      harness,
      fields: { [buildConfigModalFieldId("stm_cat_summary", "nonce1234567")]: "DM summary" },
    });
    const summarySpy = spyOn(shortTermMemoryRepository, "updateSummary").mockImplementation(async () => {
      acknowledged = interaction.deferred;
    });

    await dispatch(harness, interaction);

    expect(summarySpy).toHaveBeenCalledWith(
      "user-1",
      "channel-1",
      "DM summary",
      "DM",
      undefined,
      "lounge",
      55,
      0,
      undefined,
    );
    expect(acknowledged).toBe(true);
    summarySpy.mockRestore();
  });

  it("writes category STM values and clears an empty summary through the matching repository methods", async () => {
    let categoryAcknowledged = false;
    const categoryHarness = makeHarness({ personaMemoryView: makeMemoryView({ stmCategories: STM_CATEGORY_ROWS }) });
    const categoryInteraction = makeInteraction({
      customId: buildConfigRouteId({
        action: "stm-edit-submit",
        locale: "en-US",
        personaId: 55,
        nonce: "nonce1234567",
      }),
      kind: "modal",
      harness: categoryHarness,
      fields: {
        [buildConfigModalFieldId("stm_cat_summary", "nonce1234567")]: "category summary",
        [buildConfigModalFieldId("stm_cat_people", "nonce1234567")]: "",
      },
    });
    const categoriesSpy = spyOn(shortTermMemoryRepository, "updateCategories").mockImplementation(async (...args) => {
      categoryAcknowledged = categoryInteraction.deferred;
      expect(args[2]).toEqual({ summary: "category summary" });
    });

    await dispatch(categoryHarness, categoryInteraction);

    expect(categoriesSpy).toHaveBeenCalled();
    expect(categoryAcknowledged).toBe(true);
    categoriesSpy.mockRestore();

    let clearAcknowledged = false;
    const summaryHarness = makeHarness();
    const summaryInteraction = makeInteraction({
      customId: buildConfigRouteId({
        action: "stm-edit-submit",
        locale: "en-US",
        personaId: 55,
        nonce: "nonce1234567",
      }),
      kind: "modal",
      harness: summaryHarness,
      fields: { [buildConfigModalFieldId("stm_cat_summary", "nonce1234567")]: "" },
    });
    const clearSpy = spyOn(shortTermMemoryRepository, "clearSummary").mockImplementation(async () => {
      clearAcknowledged = summaryInteraction.deferred;
    });
    const updateSpy = spyOn(shortTermMemoryRepository, "updateSummary");

    await dispatch(summaryHarness, summaryInteraction);

    expect(clearSpy).toHaveBeenCalledWith("user-1", "channel-1", 55, "guild-1");
    expect(updateSpy).not.toHaveBeenCalled();
    expect(clearAcknowledged).toBe(true);
    clearSpy.mockRestore();
    updateSpy.mockRestore();
  });

  it("treats missing conditioning checkbox evidence as stale and never deletes", async () => {
    const deleteSpy = spyOn(conditioningMemoryRepository, "deleteGroupsForPersona").mockResolvedValue(1);
    const harness = makeHarness({ isManager: true });
    harness.dependencies.takeCheckboxValues = () => undefined;

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "conditioning-submit",
          locale: "en-US",
          personaId: 55,
          fp: computeConditioningRemoveFingerprint(55, [CONDITIONING_GROUP]),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        harness,
      }),
    );

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.edits.at(-1))).toContain("Panel Out Of Date");
    deleteSpy.mockRestore();
  });

  it("rejects a conditioning continuation whose presented group list is stale", async () => {
    const deleteSpy = spyOn(conditioningMemoryRepository, "deleteGroupsForPersona").mockResolvedValue(1);
    const harness = makeHarness({ isManager: true });
    harness.dependencies.takeCheckboxValues = () => [];

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "conditioning-submit",
          locale: "en-US",
          personaId: 55,
          fp: computeConditioningRemoveFingerprint(55, [
            { ...CONDITIONING_GROUP, reasonNormalized: "a different reason" },
          ]),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        harness,
      }),
    );

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.edits.at(-1))).toContain("Panel Out Of Date");
    deleteSpy.mockRestore();
  });

  it("uses the raw CheckboxGroup component and preserves the conditioning removal identity triple", async () => {
    const harness = makeHarness({ isManager: true });
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "conditioning-open", locale: "en-US", personaId: 55 }),
        harness,
      }),
    );

    const modal = JSON.stringify(harness.modals.at(-1));
    expect(modal).toContain('"type":22');
    expect(modal).toContain('"custom_id":"conditioning_0_nonce1234567"');
  });

  it("routes a real memory button through the registry to the canonical panel seam", async () => {
    let selectedLineage: number | undefined;
    const main = makePersona({ persona_id: 55, persona_lineage_id: 101 });
    const alter = makePersona({ persona_id: 56, is_alter: true, persona_lineage_id: 202 });
    const harness = makeHarness({ personas: [main, alter] });
    harness.dependencies.openServerMemoryPanel = async (_interaction, _locale, lineageId) => {
      selectedLineage = lineageId;
      return { components: [], flags: 32768 };
    };

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "server-memory-open", locale: "en-US", personaId: 56 }),
        harness,
      }),
    );

    expect(selectedLineage).toBe(202);
    expect(harness.replies).toHaveLength(1);
    expect(harness.edits).toHaveLength(0);
  });

  it("marks memory follow-ups as ephemeral Components V2 payloads", () => {
    const payload = asEphemeralComponentsV2FollowUp({ components: [] });

    expect(payload.flags).toBe(MessageFlags.Ephemeral | MessageFlags.IsComponentsV2);
  });

  it("does not retarget a deleted STM persona to the current main persona", async () => {
    const updateSpy = spyOn(shortTermMemoryRepository, "updateSummary");
    const harness = makeHarness({ personas: [MAIN] });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "stm-edit-submit",
          locale: "en-US",
          personaId: 999,
          nonce: "nonce1234567",
        }),
        kind: "modal",
        harness,
        fields: { [buildConfigModalFieldId("stm_cat_summary", "nonce1234567")]: "must not write" },
      }),
    );

    expect(updateSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.edits.at(-1))).toContain(
      buildConfigRouteId({ action: "stm-edit-open", locale: "en-US", personaId: 55 }),
    );
    updateSpy.mockRestore();
  });

  it("deletes conditioning by lineage and identity after an explicit checkbox clear", async () => {
    let acknowledged = false;
    const persona = makePersona({ persona_id: 55, persona_lineage_id: 707 });
    const harness = makeHarness({ isManager: true, personas: [persona] });
    const interaction = makeInteraction({
      customId: buildConfigRouteId({
        action: "conditioning-submit",
        locale: "en-US",
        personaId: 55,
        fp: computeConditioningRemoveFingerprint(55, [CONDITIONING_GROUP]),
        nonce: "nonce1234567",
      }),
      kind: "modal",
      harness,
    });
    harness.dependencies.takeCheckboxValues = (_interactionId, fieldId) =>
      fieldId === buildConditioningCheckboxGroupId(0, "nonce1234567") ? [] : undefined;
    const deleteSpy = spyOn(conditioningMemoryRepository, "deleteGroupsForPersona").mockImplementation(
      async (serverId, lineageId, groups) => {
        acknowledged = interaction.deferred;
        expect(serverId).toBe(9);
        expect(lineageId).toBe(707);
        expect(groups).toEqual([
          {
            conditioningType: CONDITIONING_GROUP.conditioningType,
            actionKey: CONDITIONING_GROUP.actionKey,
            reasonNormalized: CONDITIONING_GROUP.reasonNormalized,
          },
        ]);
        return 1;
      },
    );

    await dispatch(harness, interaction);

    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(acknowledged).toBe(true);
    deleteSpy.mockRestore();
  });

  it("prewarms the selected STM scope before reading its entry", async () => {
    let prewarmed = false;
    const prewarmSpy = spyOn(shortTermMemoryCache, "preWarmStmEntry").mockImplementation(async () => {
      await Promise.resolve();
      prewarmed = true;
    });
    const readSpy = spyOn(shortTermMemoryCache, "getShortTermMemoryForServerChannel").mockImplementation(() => {
      expect(prewarmed).toBe(true);
      return undefined;
    });
    const serverCountSpy = spyOn(serverMemoryRepository, "memoryCountsByLineage").mockResolvedValue(new Map([[0, 3]]));
    const personalCountSpy = spyOn(personalMemoryRepository, "memoryCountsByLineage").mockResolvedValue(new Map());
    const categoriesSpy = spyOn(shortTermMemoryRepository, "getStmCategories").mockResolvedValue([
      STM_SUMMARY_CATEGORY,
    ]);
    const conditioningSpy = spyOn(conditioningMemoryRepository, "loadGroupsForPersona").mockResolvedValue([]);
    const harness = makeHarness();

    await loadConfigPersonaMemoryView(
      makeInteraction({ customId: "unused", harness }),
      {
        serverDiscId: "guild-1",
        guildId: "guild-1",
        internalServerId: 9,
        userId: 1,
        actor: { workspaceKind: "guild", isManager: true },
        personas: [MAIN],
        readStatus: "fresh",
      },
      MAIN,
    );

    expect(prewarmSpy).toHaveBeenCalledWith("server", "guild-1", "channel-1", 55);
    expect(readSpy).toHaveBeenCalledWith("guild-1", "channel-1", 55);
    prewarmSpy.mockRestore();
    readSpy.mockRestore();
    serverCountSpy.mockRestore();
    personalCountSpy.mockRestore();
    categoriesSpy.mockRestore();
    conditioningSpy.mockRestore();
  });

  it("uses the user-scoped STM cache key in a DM", async () => {
    let prewarmed = false;
    const prewarmSpy = spyOn(shortTermMemoryCache, "preWarmStmEntry").mockImplementation(async () => {
      await Promise.resolve();
      prewarmed = true;
    });
    const readSpy = spyOn(shortTermMemoryCache, "getShortTermMemoryForUserChannel").mockImplementation(() => {
      expect(prewarmed).toBe(true);
      return undefined;
    });
    const serverCountSpy = spyOn(serverMemoryRepository, "memoryCountsByLineage").mockResolvedValue(new Map());
    const personalCountSpy = spyOn(personalMemoryRepository, "memoryCountsByLineage").mockResolvedValue(new Map());
    const categoriesSpy = spyOn(shortTermMemoryRepository, "getStmCategories").mockResolvedValue([
      STM_SUMMARY_CATEGORY,
    ]);
    const harness = makeHarness({ inGuild: false });

    await loadConfigPersonaMemoryView(
      makeInteraction({ customId: "unused", inGuild: false, harness }),
      {
        serverDiscId: "user-1",
        guildId: null,
        internalServerId: 9,
        userId: 1,
        actor: { workspaceKind: "dm", isManager: true },
        personas: [MAIN],
        readStatus: "fresh",
      },
      MAIN,
    );

    expect(prewarmSpy).toHaveBeenCalledWith("user", "user-1", "channel-1", 55);
    expect(readSpy).toHaveBeenCalledWith("user-1", "channel-1", 55);
    prewarmSpy.mockRestore();
    readSpy.mockRestore();
    serverCountSpy.mockRestore();
    personalCountSpy.mockRestore();
    categoriesSpy.mockRestore();
  });

  it("keeps conditioning manage as an all persona aggregate view", async () => {
    const main = makePersona({ persona_id: 55, persona_lineage_id: 101 });
    const alter = makePersona({ persona_id: 56, persona_lineage_id: 202, is_alter: true });
    const mainGroup = { ...CONDITIONING_GROUP, reasonNormalized: "main reason" };
    const alterGroup = { ...CONDITIONING_GROUP, reasonNormalized: "alter reason" };
    const loadPersonasSpy = spyOn(personaRepository, "loadAllForServer").mockResolvedValue([main, alter]);
    const loadGroupsSpy = spyOn(conditioningMemoryRepository, "loadGroupsForPersona").mockImplementation(
      async (_serverId, lineageId) => (lineageId === 101 ? [mainGroup] : [alterGroup]),
    );
    let modalOptions: { components: Array<{ options: Array<{ value: string; label: string }> }> } | undefined;
    const modalSpy = spyOn(modalModule, "promptWithRawModal").mockImplementation(
      async (_interaction, _locale, options) => {
        modalOptions = options as { components: Array<{ options: Array<{ value: string; label: string }> }> };
        return { outcome: "cancel" };
      },
    );
    const interaction = {
      guildId: "guild-1",
      memberPermissions: { has: () => true },
      user: { id: "user-1" },
    } as unknown as Parameters<typeof executeConditioningManage>[1];

    await executeConditioningManage(
      CLIENT,
      interaction,
      {} as Parameters<typeof executeConditioningManage>[2],
      "en-US",
    );

    expect(loadPersonasSpy).toHaveBeenCalledWith("guild-1");
    expect(loadGroupsSpy).toHaveBeenCalledTimes(2);
    expect(loadGroupsSpy).toHaveBeenNthCalledWith(1, 9, 101);
    expect(loadGroupsSpy).toHaveBeenNthCalledWith(2, 9, 202);
    expect(modalOptions?.components[0]?.options.map((option) => option.value)).toEqual(["0", "1"]);
    expect(modalOptions?.components[0]?.options.map((option) => option.label)).toEqual([
      expect.stringContaining("Persona 55"),
      expect.stringContaining("Persona 56"),
    ]);
    modalSpy.mockRestore();
    loadGroupsSpy.mockRestore();
    loadPersonasSpy.mockRestore();
  });
});

describe("config persona collections", () => {
  it("adds attributes from a .txt upload through the routed operation", async () => {
    let acknowledgedDuringWrite = false;
    let interaction: ReturnType<typeof makeInteraction>;
    const persona = makeTeachingPersona({ persona_id: 55, attribute_list: ["Existing"] });
    const refreshed = makeTeachingPersona({ persona_id: 55, attribute_list: ["Existing", "Likes tea", "Reads"] });
    const addSpy = spyOn(personaRepository, "addAttributes").mockImplementation(async () => {
      acknowledgedDuringWrite = interaction.deferred;
      return true;
    });
    const limitSpy = spyOn(personaRepository, "checkAttributeLimit").mockResolvedValue({
      isValid: true,
      currentCount: 1,
      maxAllowed: 100,
    });
    const blacklistSpy = spyOn(userRepository, "isBlacklisted").mockResolvedValue(false);
    const harness = makeHarness({ personas: [persona], refreshedPersonas: [refreshed], isManager: false });
    harness.dependencies.takeFileUpload = () => makeTxtAttachment("Likes tea\nReads");
    interaction = makeInteraction({
      customId: buildConfigRouteId({
        action: "attribute-add-submit",
        locale: "en-US",
        personaId: 55,
        nonce: "nonce1234567",
      }),
      kind: "modal",
      isManager: false,
      harness,
    });

    await dispatch(harness, interaction);

    expect(acknowledgedDuringWrite).toBe(true);
    expect(limitSpy).toHaveBeenCalledWith(55);
    expect(addSpy).toHaveBeenCalledWith(55, ["Likes tea", "Reads"], false);
    expect(harness.telemetry).toEqual(["server-config.workspace.persona-attribute.add"]);
    expect(JSON.stringify(harness.edits.at(-1))).toContain("Reads");
    expect(blacklistSpy).toHaveBeenCalledWith("guild-1", "user-1");
    addSpy.mockRestore();
    limitSpy.mockRestore();
    blacklistSpy.mockRestore();
  });

  it("edits attributes with checkbox evidence while preserving absent evidence", async () => {
    let acknowledgedDuringWrite = false;
    let interaction: ReturnType<typeof makeInteraction>;
    const persona = makeTeachingPersona({
      persona_id: 55,
      attribute_list: ["Old"],
      persona_attributes: [{ persona_id: 55, attribute_order: 1, attribute_text: "Old", is_public: true }],
    });
    const editSpy = spyOn(personaRepository, "editAttributeAt").mockImplementation(async () => {
      acknowledgedDuringWrite = interaction.deferred;
      return true;
    });
    const blacklistSpy = spyOn(userRepository, "isBlacklisted").mockResolvedValue(false);

    const firstHarness = makeHarness({ personas: [persona], isManager: false });
    firstHarness.dependencies.takeCheckboxValues = () => undefined;
    interaction = makeInteraction({
      customId: buildConfigRouteId({
        action: "attribute-edit-submit",
        locale: "en-US",
        personaId: 55,
        index: 0,
        fp: computeAttributeFingerprint(55, 0, "Old", true),
        nonce: "nonce1234567",
      }),
      kind: "modal",
      isManager: false,
      harness: firstHarness,
      fields: { [buildConfigModalFieldId("attribute_part1", "nonce1234567")]: "New" },
    });
    await dispatch(firstHarness, interaction);
    expect(acknowledgedDuringWrite).toBe(true);
    expect(editSpy).toHaveBeenNthCalledWith(1, 55, 1, "New", undefined);

    const secondHarness = makeHarness({ personas: [persona], isManager: false });
    secondHarness.dependencies.takeCheckboxValues = () => [];
    interaction = makeInteraction({
      customId: buildConfigRouteId({
        action: "attribute-edit-submit",
        locale: "en-US",
        personaId: 55,
        index: 0,
        fp: computeAttributeFingerprint(55, 0, "Old", true),
        nonce: "nonce1234567",
      }),
      kind: "modal",
      isManager: false,
      harness: secondHarness,
      fields: { [buildConfigModalFieldId("attribute_part1", "nonce1234567")]: "Private" },
    });
    await dispatch(secondHarness, interaction);
    expect(editSpy).toHaveBeenNthCalledWith(2, 55, 1, "Private", false);
    expect(blacklistSpy).toHaveBeenCalledTimes(2);
    editSpy.mockRestore();
    blacklistSpy.mockRestore();
  });

  it("returns a stale receipt without writing when an attribute fingerprint changed", async () => {
    const editSpy = spyOn(personaRepository, "editAttributeAt");
    const removeSpy = spyOn(personaRepository, "removeAttributeAt");
    const blacklistSpy = spyOn(userRepository, "isBlacklisted").mockResolvedValue(false);
    const persona = makeTeachingPersona({ persona_id: 55, attribute_list: ["Current"] });
    const harness = makeHarness({ personas: [persona], isManager: false });
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "attribute-edit-submit",
          locale: "en-US",
          personaId: 55,
          index: 0,
          fp: computeAttributeFingerprint(55, 0, "Old", false),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        isManager: false,
        harness,
        fields: { [buildConfigModalFieldId("attribute_part1", "nonce1234567")]: "New" },
      }),
    );
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "attribute-remove",
          locale: "en-US",
          personaId: 55,
          index: 0,
          fp: computeAttributeFingerprint(55, 0, "Old", false),
        }),
        isManager: false,
        harness,
      }),
    );

    expect(editSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(harness.edits.filter((entry) => JSON.stringify(entry).includes("Panel Out Of Date"))).toHaveLength(2);
    expect(blacklistSpy).toHaveBeenCalledTimes(1);
    editSpy.mockRestore();
    removeSpy.mockRestore();
    blacklistSpy.mockRestore();
  });

  it("removes an attribute even when the actor is blacklisted and clamps the page", async () => {
    let acknowledgedDuringWrite = false;
    let interaction: ReturnType<typeof makeInteraction>;
    const persona = makeTeachingPersona({
      persona_id: 55,
      attribute_list: ["Only"],
    });
    const refreshed = makeTeachingPersona({ persona_id: 55, attribute_list: [] });
    const removeSpy = spyOn(personaRepository, "removeAttributeAt").mockImplementation(async () => {
      acknowledgedDuringWrite = interaction.deferred;
      return true;
    });
    const blacklistSpy = spyOn(userRepository, "isBlacklisted").mockResolvedValue(true);
    const harness = makeHarness({ personas: [persona], refreshedPersonas: [refreshed], isManager: false });
    interaction = makeInteraction({
      customId: buildConfigRouteId({
        action: "attribute-remove",
        locale: "en-US",
        personaId: 55,
        index: 0,
        fp: computeAttributeFingerprint(55, 0, "Only", false),
      }),
      isManager: false,
      harness,
    });
    await dispatch(harness, interaction);

    expect(acknowledgedDuringWrite).toBe(true);
    expect(removeSpy).toHaveBeenCalledWith(55, 1);
    expect(blacklistSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.edits.at(-1))).not.toContain(":attr-edit-open:");
    removeSpy.mockRestore();
    blacklistSpy.mockRestore();
  });

  it("adds sample dialogues from a .txt upload and routes the last pair into view", async () => {
    let acknowledgedDuringWrite = false;
    let interaction: ReturnType<typeof makeInteraction>;
    const persona = makeTeachingPersona({ persona_id: 55 });
    const refreshed = makeTeachingPersona({
      persona_id: 55,
      sample_dialogues_in: ["Hello"],
      sample_dialogues_out: ["Hi"],
    });
    const addSpy = spyOn(personaRepository, "addSampleDialoguePair").mockImplementation(async () => {
      acknowledgedDuringWrite = interaction.deferred;
      return true;
    });
    const limitSpy = spyOn(personaRepository, "checkSampleDialogueLimit").mockResolvedValue({
      isValid: true,
      currentCount: 0,
      maxAllowed: 100,
    });
    const blacklistSpy = spyOn(userRepository, "isBlacklisted").mockResolvedValue(false);
    const harness = makeHarness({ personas: [persona], refreshedPersonas: [refreshed], isManager: false });
    harness.dependencies.takeFileUpload = () => makeTxtAttachment("{user}: Hello\n{bot}: Hi");
    interaction = makeInteraction({
      customId: buildConfigRouteId({
        action: "dialogue-add-submit",
        locale: "en-US",
        personaId: 55,
        nonce: "nonce1234567",
      }),
      kind: "modal",
      isManager: false,
      harness,
    });
    await dispatch(harness, interaction);

    expect(acknowledgedDuringWrite).toBe(true);
    expect(addSpy).toHaveBeenCalledWith(55, ["Hello"], ["Hi"]);
    expect(harness.telemetry).toEqual(["server-config.workspace.persona-dialogue.add"]);
    expect(blacklistSpy).toHaveBeenCalledWith("guild-1", "user-1");
    addSpy.mockRestore();
    limitSpy.mockRestore();
    blacklistSpy.mockRestore();
  });

  it("edits and removes sample dialogues through fingerprinted routes", async () => {
    let acknowledgedDuringWrite = false;
    let interaction: ReturnType<typeof makeInteraction>;
    const persona = makeTeachingPersona({
      persona_id: 55,
      sample_dialogues_in: ["Old"],
      sample_dialogues_out: ["Reply"],
    });
    const editSpy = spyOn(personaRepository, "editSampleDialoguePairAt").mockImplementation(async () => {
      acknowledgedDuringWrite = interaction.deferred;
      return true;
    });
    const removeSpy = spyOn(personaRepository, "removeSampleDialoguePairAt").mockImplementation(async () => {
      acknowledgedDuringWrite = interaction.deferred;
      return true;
    });
    const blacklistSpy = spyOn(userRepository, "isBlacklisted").mockResolvedValue(false);
    const editHarness = makeHarness({ personas: [persona], isManager: false });
    interaction = makeInteraction({
      customId: buildConfigRouteId({
        action: "dialogue-edit-submit",
        locale: "en-US",
        personaId: 55,
        index: 0,
        fp: computeDialogueFingerprint(55, 0, "Old", "Reply"),
        nonce: "nonce1234567",
      }),
      kind: "modal",
      isManager: false,
      harness: editHarness,
      fields: {
        [buildConfigModalFieldId("user_input_part1", "nonce1234567")]: "New",
        [buildConfigModalFieldId("bot_input_part1", "nonce1234567")]: "Response",
      },
    });
    await dispatch(editHarness, interaction);

    expect(acknowledgedDuringWrite).toBe(true);
    expect(editSpy).toHaveBeenCalledWith(55, 1, "New", "Response");
    expect(blacklistSpy).toHaveBeenCalledTimes(1);

    const removeHarness = makeHarness({ personas: [persona], isManager: false });
    interaction = makeInteraction({
      customId: buildConfigRouteId({
        action: "dialogue-remove",
        locale: "en-US",
        personaId: 55,
        index: 0,
        fp: computeDialogueFingerprint(55, 0, "Old", "Reply"),
      }),
      isManager: false,
      harness: removeHarness,
    });
    await dispatch(removeHarness, interaction);

    expect(removeSpy).toHaveBeenCalledWith(55, 1);
    expect(blacklistSpy).toHaveBeenCalledTimes(1);
    expect(editHarness.telemetry).toEqual(["server-config.workspace.persona-dialogue.edit"]);
    expect(removeHarness.telemetry).toEqual(["server-config.workspace.persona-dialogue.remove"]);
    editSpy.mockRestore();
    removeSpy.mockRestore();
    blacklistSpy.mockRestore();
  });

  it("repairs mismatched dialogue pairs before an edit", async () => {
    let interaction: ReturnType<typeof makeInteraction>;
    let acknowledgedDuringRepair = false;
    let acknowledgedDuringEdit = false;
    const persona = makeTeachingPersona({
      persona_id: 55,
      sample_dialogues_in: ["First", "Orphaned input"],
      sample_dialogues_out: ["Reply"],
    });
    const repairedIn = ["First"];
    const repairedOut = ["Reply"];
    const repairSpy = spyOn(personaRepository, "repairSampleDialogues").mockImplementation(async () => {
      acknowledgedDuringRepair = interaction.deferred;
      return { repairedIn, repairedOut };
    });
    const editSpy = spyOn(personaRepository, "editSampleDialoguePairAt").mockImplementation(async () => {
      acknowledgedDuringEdit = interaction.deferred;
      return true;
    });
    const blacklistSpy = spyOn(userRepository, "isBlacklisted").mockResolvedValue(false);
    const harness = makeHarness({ personas: [persona], isManager: false });
    interaction = makeInteraction({
      customId: buildConfigRouteId({
        action: "dialogue-edit-submit",
        locale: "en-US",
        personaId: 55,
        index: 0,
        fp: computeDialogueFingerprint(55, 0, "First", "Reply"),
        nonce: "nonce1234567",
      }),
      kind: "modal",
      isManager: false,
      harness,
      fields: {
        [buildConfigModalFieldId("user_input_part1", "nonce1234567")]: "Updated",
        [buildConfigModalFieldId("bot_input_part1", "nonce1234567")]: "Response",
      },
    });

    await dispatch(harness, interaction);

    expect(acknowledgedDuringRepair).toBe(true);
    expect(acknowledgedDuringEdit).toBe(true);
    expect(repairSpy).toHaveBeenCalledWith(55, 1);
    expect(editSpy).toHaveBeenCalledWith(55, 1, "Updated", "Response");
    expect(persona.sample_dialogues_in).toEqual(repairedIn);
    expect(persona.sample_dialogues_out).toEqual(repairedOut);
    expect(blacklistSpy).toHaveBeenCalledTimes(1);
    repairSpy.mockRestore();
    editSpy.mockRestore();
    blacklistSpy.mockRestore();
  });

  it("rejects stale dialogue edits and removals without writing", async () => {
    const editSpy = spyOn(personaRepository, "editSampleDialoguePairAt");
    const removeSpy = spyOn(personaRepository, "removeSampleDialoguePairAt");
    const blacklistSpy = spyOn(userRepository, "isBlacklisted").mockResolvedValue(false);
    const persona = makeTeachingPersona({
      persona_id: 55,
      sample_dialogues_in: ["Current"],
      sample_dialogues_out: ["Reply"],
    });
    const harness = makeHarness({ personas: [persona], isManager: false });
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "dialogue-edit-submit",
          locale: "en-US",
          personaId: 55,
          index: 0,
          fp: computeDialogueFingerprint(55, 0, "Old", "Reply"),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        isManager: false,
        harness,
        fields: {
          [buildConfigModalFieldId("user_input_part1", "nonce1234567")]: "New",
          [buildConfigModalFieldId("bot_input_part1", "nonce1234567")]: "Response",
        },
      }),
    );
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "dialogue-remove",
          locale: "en-US",
          personaId: 55,
          index: 0,
          fp: computeDialogueFingerprint(55, 0, "Old", "Reply"),
        }),
        isManager: false,
        harness,
      }),
    );

    expect(editSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(harness.edits.filter((entry) => JSON.stringify(entry).includes("Panel Out Of Date"))).toHaveLength(2);
    expect(blacklistSpy).toHaveBeenCalledTimes(1);
    editSpy.mockRestore();
    removeSpy.mockRestore();
    blacklistSpy.mockRestore();
  });

  it("applies dialogue blacklist and teaching gates to the real routes", async () => {
    let interaction: ReturnType<typeof makeInteraction>;
    let acknowledgedDuringRemove = false;
    const addSpy = spyOn(personaRepository, "addSampleDialoguePair").mockResolvedValue(true);
    const editSpy = spyOn(personaRepository, "editSampleDialoguePairAt");
    const removeSpy = spyOn(personaRepository, "removeSampleDialoguePairAt").mockImplementation(async () => {
      acknowledgedDuringRemove = interaction.deferred;
      return true;
    });
    const limitSpy = spyOn(personaRepository, "checkSampleDialogueLimit").mockResolvedValue({
      isValid: true,
      currentCount: 0,
      maxAllowed: 100,
    });
    const blacklistSpy = spyOn(userRepository, "isBlacklisted").mockResolvedValue(true);
    const memberPersona = makeTeachingPersona({
      persona_id: 55,
      sample_dialogues_in: ["Old"],
      sample_dialogues_out: ["Reply"],
    });
    const blacklistedHarness = makeHarness({ personas: [memberPersona], isManager: false });

    await dispatch(
      blacklistedHarness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "dialogue-add-submit",
          locale: "en-US",
          personaId: 55,
          nonce: "nonce1234567",
        }),
        kind: "modal",
        isManager: false,
        harness: blacklistedHarness,
        fields: {
          [buildConfigModalFieldId("user_input", "nonce1234567")]: "New",
          [buildConfigModalFieldId("bot_input", "nonce1234567")]: "Response",
        },
      }),
    );
    await dispatch(
      blacklistedHarness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "dialogue-edit-submit",
          locale: "en-US",
          personaId: 55,
          index: 0,
          fp: computeDialogueFingerprint(55, 0, "Old", "Reply"),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        isManager: false,
        harness: blacklistedHarness,
        fields: {
          [buildConfigModalFieldId("user_input_part1", "nonce1234567")]: "New",
          [buildConfigModalFieldId("bot_input_part1", "nonce1234567")]: "Response",
        },
      }),
    );
    expect(addSpy).not.toHaveBeenCalled();
    expect(editSpy).not.toHaveBeenCalled();

    interaction = makeInteraction({
      customId: buildConfigRouteId({
        action: "dialogue-remove",
        locale: "en-US",
        personaId: 55,
        index: 0,
        fp: computeDialogueFingerprint(55, 0, "Old", "Reply"),
      }),
      isManager: false,
      harness: blacklistedHarness,
    });
    await dispatch(blacklistedHarness, interaction);
    expect(acknowledgedDuringRemove).toBe(true);
    expect(removeSpy).toHaveBeenCalledWith(55, 1);

    const disabledPersona = makeTeachingPersona(
      {
        persona_id: 55,
        sample_dialogues_in: ["Old"],
        sample_dialogues_out: ["Reply"],
      },
      { dialogue: false },
    );
    const disabledHarness = makeHarness({ personas: [disabledPersona], isManager: false });
    await dispatch(
      disabledHarness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "dialogue-add-submit",
          locale: "en-US",
          personaId: 55,
          nonce: "nonce1234567",
        }),
        kind: "modal",
        isManager: false,
        harness: disabledHarness,
        fields: {
          [buildConfigModalFieldId("user_input", "nonce1234567")]: "New",
          [buildConfigModalFieldId("bot_input", "nonce1234567")]: "Response",
        },
      }),
    );
    await dispatch(
      disabledHarness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "dialogue-edit-submit",
          locale: "en-US",
          personaId: 55,
          index: 0,
          fp: computeDialogueFingerprint(55, 0, "Old", "Reply"),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        isManager: false,
        harness: disabledHarness,
        fields: {
          [buildConfigModalFieldId("user_input_part1", "nonce1234567")]: "New",
          [buildConfigModalFieldId("bot_input_part1", "nonce1234567")]: "Response",
        },
      }),
    );
    await dispatch(
      disabledHarness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "dialogue-remove",
          locale: "en-US",
          personaId: 55,
          index: 0,
          fp: computeDialogueFingerprint(55, 0, "Old", "Reply"),
        }),
        isManager: false,
        harness: disabledHarness,
      }),
    );
    expect(addSpy).not.toHaveBeenCalled();
    expect(editSpy).not.toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalledTimes(1);

    const managerPersona = makeTeachingPersona({ persona_id: 55 }, { dialogue: false });
    const managerHarness = makeHarness({ personas: [managerPersona], isManager: true });
    await dispatch(
      managerHarness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "dialogue-add-submit",
          locale: "en-US",
          personaId: 55,
          nonce: "nonce1234567",
        }),
        kind: "modal",
        isManager: true,
        harness: managerHarness,
        fields: {
          [buildConfigModalFieldId("user_input", "nonce1234567")]: "New",
          [buildConfigModalFieldId("bot_input", "nonce1234567")]: "Response",
        },
      }),
    );
    expect(addSpy).toHaveBeenCalledWith(55, ["New"], ["Response"]);
    expect(limitSpy).toHaveBeenCalledWith(55);
    expect(blacklistSpy).toHaveBeenCalledTimes(2);
    removeSpy.mockRestore();
    editSpy.mockRestore();
    addSpy.mockRestore();
    limitSpy.mockRestore();
    blacklistSpy.mockRestore();
  });

  it("opens add modals from the first selector option without deferring the select", async () => {
    const harness = makeHarness();
    const attributeInteraction = makeInteraction({
      customId: buildConfigRouteId({ action: "attribute-select", locale: "en-US", personaId: 55 }),
      kind: "select",
      values: ["add"],
      harness,
    });
    await dispatch(harness, attributeInteraction);
    expect(attributeInteraction.deferred).toBe(false);
    expect(harness.modals[0]).toMatchObject({
      custom_id: buildConfigRouteId({
        action: "attribute-add-submit",
        locale: "en-US",
        personaId: 55,
        nonce: "nonce1234567",
      }),
    });
    const attributeModal = harness.modals[0] as { components: Array<{ type: number; component?: { type: number } }> };
    expect(attributeModal.components.map((component) => component.component?.type)).toContain(19);
    expect(attributeModal.components.map((component) => component.component?.type)).toContain(22);

    const dialogueHarness = makeHarness();
    const dialogueInteraction = makeInteraction({
      customId: buildConfigRouteId({ action: "dialogue-select", locale: "en-US", personaId: 55 }),
      kind: "select",
      values: ["add"],
      harness: dialogueHarness,
    });
    await dispatch(dialogueHarness, dialogueInteraction);
    expect(dialogueHarness.modals[0]).toMatchObject({
      custom_id: buildConfigRouteId({
        action: "dialogue-add-submit",
        locale: "en-US",
        personaId: 55,
        nonce: "nonce1234567",
      }),
    });
    const dialogueModal = dialogueHarness.modals[0] as {
      components: Array<{ type: number; component?: { type: number } }>;
    };
    expect(dialogueModal.components.map((component) => component.component?.type)).toContain(19);
  });

  it("gates teaching-disabled members, lets managers bypass, and keeps DM blacklist reads absent", async () => {
    const addSpy = spyOn(personaRepository, "addAttributes").mockResolvedValue(true);
    const limitSpy = spyOn(personaRepository, "checkAttributeLimit").mockResolvedValue({
      isValid: true,
      currentCount: 0,
      maxAllowed: 100,
    });
    const blacklistSpy = spyOn(userRepository, "isBlacklisted").mockResolvedValue(true);
    const memberPersona = makeTeachingPersona({ persona_id: 55, attribute_list: ["Old"] });

    const blacklistedAddHarness = makeHarness({ personas: [memberPersona], isManager: false });
    await dispatch(
      blacklistedAddHarness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "attribute-add-submit",
          locale: "en-US",
          personaId: 55,
          nonce: "nonce1234567",
        }),
        kind: "modal",
        isManager: false,
        harness: blacklistedAddHarness,
        fields: { [buildConfigModalFieldId("attribute", "nonce1234567")]: "New" },
      }),
    );
    expect(addSpy).not.toHaveBeenCalled();

    const blacklistedEditSpy = spyOn(personaRepository, "editAttributeAt");
    await dispatch(
      blacklistedAddHarness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "attribute-edit-submit",
          locale: "en-US",
          personaId: 55,
          index: 0,
          fp: computeAttributeFingerprint(55, 0, "Old", false),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        isManager: false,
        harness: blacklistedAddHarness,
        fields: { [buildConfigModalFieldId("attribute_part1", "nonce1234567")]: "New" },
      }),
    );
    expect(blacklistedEditSpy).not.toHaveBeenCalled();

    const disabledPersona = makeTeachingPersona({ persona_id: 55, attribute_list: ["Old"] }, { attribute: false });
    const disabledHarness = makeHarness({ personas: [disabledPersona], isManager: false });
    await dispatch(
      disabledHarness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "attribute-add-submit",
          locale: "en-US",
          personaId: 55,
          nonce: "nonce1234567",
        }),
        kind: "modal",
        isManager: false,
        harness: disabledHarness,
        fields: { [buildConfigModalFieldId("attribute", "nonce1234567")]: "New" },
      }),
    );
    expect(addSpy).not.toHaveBeenCalled();

    const disabledEditSpy = spyOn(personaRepository, "editAttributeAt");
    await dispatch(
      disabledHarness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "attribute-edit-submit",
          locale: "en-US",
          personaId: 55,
          index: 0,
          fp: computeAttributeFingerprint(55, 0, "Old", false),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        isManager: false,
        harness: disabledHarness,
        fields: { [buildConfigModalFieldId("attribute_part1", "nonce1234567")]: "New" },
      }),
    );
    expect(disabledEditSpy).not.toHaveBeenCalled();

    const disabledRemoveSpy = spyOn(personaRepository, "removeAttributeAt");
    await dispatch(
      disabledHarness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "attribute-remove",
          locale: "en-US",
          personaId: 55,
          index: 0,
          fp: computeAttributeFingerprint(55, 0, "Old", false),
        }),
        isManager: false,
        harness: disabledHarness,
      }),
    );
    expect(disabledRemoveSpy).not.toHaveBeenCalled();

    const managerPersona = makeTeachingPersona({ persona_id: 55 }, { attribute: false });
    const managerHarness = makeHarness({ personas: [managerPersona], isManager: true });
    const managerInteraction = makeInteraction({
      customId: buildConfigRouteId({
        action: "attribute-add-submit",
        locale: "en-US",
        personaId: 55,
        nonce: "nonce1234567",
      }),
      kind: "modal",
      isManager: true,
      harness: managerHarness,
      fields: { [buildConfigModalFieldId("attribute", "nonce1234567")]: "New" },
    });
    await dispatch(managerHarness, managerInteraction);
    expect(addSpy).toHaveBeenCalledWith(55, ["New"], false);
    expect(blacklistSpy).toHaveBeenCalledTimes(2);

    const dmPersona = makeTeachingPersona({ persona_id: 55, attribute_list: ["Old"] }, { attribute: false });
    const dmHarness = makeHarness({ personas: [dmPersona], inGuild: false });
    const dmRemoveSpy = spyOn(personaRepository, "removeAttributeAt");
    await dispatch(
      dmHarness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "attribute-remove",
          locale: "en-US",
          personaId: 55,
          index: 0,
          fp: computeAttributeFingerprint(55, 0, "Old", false),
        }),
        inGuild: false,
        harness: dmHarness,
      }),
    );
    expect(dmRemoveSpy).not.toHaveBeenCalled();
    expect(blacklistSpy).toHaveBeenCalledTimes(2);
    disabledRemoveSpy.mockRestore();
    disabledEditSpy.mockRestore();
    blacklistedEditSpy.mockRestore();
    dmRemoveSpy.mockRestore();
    addSpy.mockRestore();
    limitSpy.mockRestore();
    blacklistSpy.mockRestore();
  });
});

describe("config promotion", () => {
  it("opens a confirmation before promoting rather than swapping on the first press", async () => {
    const swapSpy = spyOn(personaRepository, "swapPersona");
    const harness = makeHarness();

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "promote-view", locale: "en-US", personaId: 56 }),
        harness,
      }),
    );

    expect(swapSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.edits.at(-1))).toContain(
      buildConfigRouteId({ action: "promote-confirm", locale: "en-US", personaId: 56, nonce: "nonce1234567" }),
    );
    swapSpy.mockRestore();
  });

  it("refuses to promote a persona that is already the main one", async () => {
    let promoteCalls = 0;
    const harness = makeHarness({
      operations: {
        promoteToMain: async () => {
          promoteCalls += 1;
          return { status: "not-alter" };
        },
      },
    });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "promote-view", locale: "en-US", personaId: 55 }),
        harness,
      }),
    );

    expect(promoteCalls).toBe(0);
    expect(JSON.stringify(harness.edits.at(-1))).not.toContain("promote-confirm");
  });
});

describe("config modal opening", () => {
  it("opens a modal as the acknowledgement rather than deferring first", async () => {
    const harness = makeHarness();
    const interaction = makeInteraction({
      customId: buildConfigRouteId({ action: "rename-open", locale: "en-US", personaId: 55 }),
      harness,
    });

    await dispatch(harness, interaction);

    expect(interaction.deferred).toBe(false);
    expect(harness.edits).toEqual([]);
    expect(harness.modals).toHaveLength(1);
    expect(harness.modals[0]).toMatchObject({
      custom_id: buildConfigRouteId({
        action: "rename-submit",
        locale: "en-US",
        personaId: 55,
        nonce: "nonce1234567",
      }),
    });
  });

  it("prefills the rename modal with the persona's current name", async () => {
    const harness = makeHarness();
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "rename-open", locale: "en-US", personaId: 55 }),
        harness,
      }),
    );

    expect(JSON.stringify(harness.modals[0])).toContain('"value":"Aphel"');
  });

  it("does not open a modal for a persona absent from the workspace", async () => {
    const harness = makeHarness({ personas: [MAIN] });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "rename-open", locale: "en-US", personaId: 999 }),
        harness,
      }),
    );

    expect(harness.modals).toEqual([]);
    expect(harness.replies).toHaveLength(1);
  });

  it("declines to open the removal modal for a persona with no trigger words", async () => {
    const harness = makeHarness();
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "trigger-remove-open", locale: "en-US", personaId: 56 }),
        harness,
      }),
    );

    expect(harness.modals).toEqual([]);
    expect(harness.replies).toHaveLength(1);
  });

  it("builds the removal modal from CheckboxGroup components, never FileUpload", async () => {
    const harness = makeHarness();
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "trigger-remove-open", locale: "en-US", personaId: 55 }),
        harness,
      }),
    );

    const modal = harness.modals[0] as { components: Array<{ type: number; component: { type: number } }> };
    // 22 is CheckboxGroup. A FileUpload (19) also renders and submits, but carries no option values,
    // which would make unchecked-means-remove delete every presented word.
    expect(modal.components.every((label) => label.type === 18)).toBe(true);
    expect(modal.components.map((label) => label.component.type)).toEqual([22]);
  });
});

describe("config registration is unchanged by this slice", () => {
  it("leaves /config as the manager-defaulted subcommand tree until the cutover slice", async () => {
    const { registrationData } = await loadCommandData();
    const configCommands = registrationData.filter((command) => command.name === "config") as unknown as Array<{
      default_member_permissions?: string;
      contexts?: number[];
      options?: Array<{ type: number; name: string }>;
    }>;

    expect(configCommands).toHaveLength(1);
    const configCommand = configCommands[0];

    // "32" is ManageGuild, applied by MANAGER_ONLY_CATEGORIES rather than a module export. The
    // cutover slice removes both this default and the subcommand tree; the panel must not.
    expect(configCommand.default_member_permissions).toBe("32");
    // Undefined contexts keeps the command DM-capable.
    expect(configCommand.contexts).toBeUndefined();
    // Subcommand (1) and subcommand-group (2) options prove it is still directory-backed, so no bare
    // executable root has appeared. A topological assertion rather than a whole-tree command count,
    // which would fail on every unrelated wave.
    expect((configCommand.options ?? []).length).toBeGreaterThan(0);
    expect((configCommand.options ?? []).every((option) => option.type === 1 || option.type === 2)).toBe(true);
  });
});
