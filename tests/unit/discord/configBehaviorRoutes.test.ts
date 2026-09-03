/**
 * Route coverage for Behavior > General and Trigger.
 *
 * These cases dispatch through the real registry, policy, and route handler. Repository spies
 * only observe the canonical methods the handler should call, which keeps the authorization and
 * acknowledgement assertions on the actual wiring.
 */
import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import { PermissionsBitField, type Client } from "discord.js";
import type { RandomTriggerRow, TomoriState } from "@/types/db/schema";
import { configRepository, serverScheduleRepository } from "@/utils/db/repositories";
import {
  CONFIG_PERSONA_SELECT_PAGE_SIZE,
  CONFIG_RANDOM_TRIGGER_CHECKBOX_CAPACITY,
  CONFIG_ROUTE_CODECS,
  buildConfigRouteId,
  computeRandomTriggerRemoveFingerprint,
  parseConfigPanelRoute,
} from "@/utils/discord/configPanelCatalog";
import { createConfigInteractionRoute } from "@/utils/discord/interactions/configRoutes";
import type { ConfigRouteDependencies, ConfigScope } from "@/utils/discord/interactions/configRouteContext";
import { InteractionRouteRegistry, parseInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import { buildConfigModalFieldId, CONFIG_PERSONA_PROMPT_PART_FIELDS } from "@/utils/discord/ui/configModals";
import {
  BEHAVIOR_FETCH_LIMIT_FIELD,
  BEHAVIOR_HUMANIZER_FIELD,
  BEHAVIOR_RANDOM_CHANNEL_FIELD,
  BEHAVIOR_RANDOM_PERSONA_FIELD,
  BEHAVIOR_RANDOM_PROMPT_FIELD,
  BEHAVIOR_RANDOM_SETTINGS_FIELD,
  buildBehaviorHumanizerModal,
  buildBehaviorRandomAddModal,
  buildBehaviorRandomRemoveModal,
} from "@/utils/discord/ui/configBehaviorModals";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const CLIENT = {} as Client;

function makeState(): TomoriState {
  return {
    server_id: 9,
    persona_id: 55,
    persona_nickname: "Sparrow",
    is_alter: false,
    trigger_words: [],
    naming_config: { prefixes: {}, suffixes: {}, addressTerms: {} },
    attribute_list: [],
    sample_dialogues_in: [],
    sample_dialogues_out: [],
    config: {
      system_prompt: "Old prompt",
      context_note: null,
      context_note_depth: 0,
      humanizer_degree: 1,
      message_fetch_limit: 80,
      timezone_offset: 0,
      cascade_limit: 3,
      match_limit: 3,
      deliberate_trigger_mode: false,
      always_reply_enabled: false,
      cooldown_type: 0,
      cooldown_length: 5,
    },
  } as unknown as TomoriState;
}

function makeRandomTrigger(): RandomTriggerRow & { trigger_id: number } {
  return {
    trigger_id: 9,
    server_id: 9,
    channel_disc_id: "channel-1",
    persona_id: 55,
    timer_hours: 2,
    random_offset_range: 1,
    chance_percent: 40,
    silence_threshold_hours: null,
    respond_to_self: false,
    custom_prompt: null,
    failure_threshold: null,
    consecutive_failures: 0,
    next_trigger_at: new Date("2026-01-01T00:00:00Z"),
  };
}

interface Harness {
  dependencies: Partial<ConfigRouteDependencies>;
  scope: ConfigScope;
  edits: unknown[];
  replies: unknown[];
  modals: unknown[];
  deferredAtWrite: boolean[];
}

function makeHarness(inGuild = true): Harness {
  const state = makeState();
  const scope: ConfigScope = {
    serverDiscId: inGuild ? "guild-1" : "user-1",
    guildId: inGuild ? "guild-1" : null,
    internalServerId: 9,
    userId: 1,
    actor: { workspaceKind: inGuild ? "guild" : "dm", isManager: true },
    personas: [state],
    readStatus: "fresh",
  };
  const harness: Harness = {
    scope,
    edits: [],
    replies: [],
    modals: [],
    deferredAtWrite: [],
    dependencies: {
      resolveScope: async () => scope,
      getPersonaAvatarData: async () => ({ url: null, files: [] }),
      createNonce: () => "nonce1234567",
      showModal: async (_interaction, payload) => {
        harness.modals.push(payload);
      },
      takeFileUpload: () => undefined,
      takeAvatarUpload: () => undefined,
      takeCheckboxValues: () => [],
      takeSelectValue: () => undefined,
      recordAction: () => undefined,
      loadBehaviorView: async (current) => ({
        general: {
          systemPrompt: current.config.system_prompt ?? null,
          contextNote: current.config.context_note ?? null,
          contextNoteDepth: current.config.context_note_depth ?? 0,
          humanizerDegree: current.config.humanizer_degree ?? 1,
          messageFetchLimit: current.config.message_fetch_limit ?? 80,
          timezoneOffset: current.config.timezone_offset ?? 0,
        },
        trigger: {
          randomTriggers: [],
          cascadeLimit: current.config.cascade_limit ?? 3,
          matchLimit: current.config.match_limit ?? 3,
          deliberateTriggerMode: current.config.deliberate_trigger_mode ?? false,
          alwaysReplyEnabled: current.config.always_reply_enabled ?? false,
          cooldownType: current.config.cooldown_type ?? 0,
          cooldownLength: current.config.cooldown_length ?? 5,
        },
      }),
    },
  };
  return harness;
}

function makeInteraction(
  harness: Harness,
  customId: string,
  options: {
    kind?: "button" | "modal" | "select";
    fields?: Record<string, string>;
    values?: string[];
    isManager?: boolean;
    inGuild?: boolean;
  } = {},
) {
  let deferred = false;
  const kind = options.kind ?? "button";
  const inGuild = options.inGuild ?? true;
  return {
    id: "interaction-1",
    customId,
    user: { id: "user-1", username: "Sparrow" },
    channelId: "channel-1",
    channel: { name: "lounge" },
    guildId: inGuild ? "guild-1" : null,
    guild: inGuild ? { id: "guild-1", channels: { cache: new Map([["channel-1", { type: 0 }]]) } } : null,
    client: { user: null },
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
      harness.edits.push(payload);
      return payload;
    },
    reply: async (payload: unknown) => {
      harness.replies.push(payload);
      return payload;
    },
    followUp: async (payload: unknown) => payload,
    fields: {
      fields: new Map(Object.entries(options.fields ?? {})),
      getTextInputValue: (fieldId: string) => options.fields?.[fieldId] ?? "",
    },
    values: options.values ?? [],
  } as unknown as Parameters<ReturnType<typeof createConfigInteractionRoute>["execute"]>[1];
}

async function dispatch(harness: Harness, interaction: ReturnType<typeof makeInteraction>): Promise<void> {
  const registry = new InteractionRouteRegistry([createConfigInteractionRoute(harness.dependencies)]);
  await registry.dispatch(CLIENT, interaction);
}

function collectRawComponentTypes(value: unknown): number[] {
  if (Array.isArray(value)) return value.flatMap(collectRawComponentTypes);
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  return [
    ...(typeof record.type === "number" ? [record.type] : []),
    ...Object.values(record).flatMap(collectRawComponentTypes),
  ];
}

const D9_WIRE_CONTRACT: ReadonlyArray<readonly [string, Parameters<typeof buildConfigRouteId>[0]]> = [
  ["config:v1:beh-prompt-open:en-US", { action: "behavior-prompt-open", locale: "en-US" }],
  [
    "config:v1:beh-prompt-sub:en-US:nonce1234567",
    { action: "behavior-prompt-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v1:beh-preset-open:en-US", { action: "behavior-preset-open", locale: "en-US" }],
  [
    "config:v1:beh-preset-sub:en-US:nonce1234567",
    { action: "behavior-preset-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v1:beh-prompt-remove:en-US", { action: "behavior-prompt-remove", locale: "en-US" }],
  ["config:v1:beh-context-open:en-US", { action: "behavior-context-open", locale: "en-US" }],
  [
    "config:v1:beh-context-sub:en-US:nonce1234567",
    { action: "behavior-context-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v1:beh-humanizer-open:en-US", { action: "behavior-humanizer-open", locale: "en-US" }],
  [
    "config:v1:beh-humanizer-sub:en-US:nonce1234567",
    { action: "behavior-humanizer-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v1:beh-fetch-open:en-US", { action: "behavior-fetch-open", locale: "en-US" }],
  [
    "config:v1:beh-fetch-sub:en-US:nonce1234567",
    { action: "behavior-fetch-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v1:beh-timezone-open:en-US", { action: "behavior-timezone-open", locale: "en-US" }],
  [
    "config:v1:beh-timezone-sub:en-US:nonce1234567",
    { action: "behavior-timezone-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v1:beh-random-add-open:en-US", { action: "behavior-random-add-open", locale: "en-US" }],
  [
    "config:v1:beh-random-add-sub:en-US:nonce1234567",
    { action: "behavior-random-add-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v1:beh-random-rem-open:en-US", { action: "behavior-random-remove-open", locale: "en-US" }],
  ["config:v1:beh-random-rem-open:en-US:1250", { action: "behavior-random-remove-open", locale: "en-US", start: 1250 }],
  ["config:v1:beh-random-rem-select:en-US", { action: "behavior-random-remove-select", locale: "en-US" }],
  ["config:v1:beh-random-rem-page:en-US:1250", { action: "behavior-random-remove-page", locale: "en-US", start: 1250 }],
  [
    "config:v1:beh-random-rem-sub:en-US:1250:abcd1234:nonce1234567",
    { action: "behavior-random-remove-submit", locale: "en-US", start: 1250, fp: "abcd1234", nonce: "nonce1234567" },
  ],
  ["config:v1:beh-limits-open:en-US", { action: "behavior-limits-open", locale: "en-US" }],
  [
    "config:v1:beh-limits-sub:en-US:nonce1234567",
    { action: "behavior-limits-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v1:beh-dtm-set:en-US:1", { action: "behavior-dtm-set", locale: "en-US", enabled: true }],
  ["config:v1:beh-always-set:en-US:0", { action: "behavior-always-set", locale: "en-US", enabled: false }],
  ["config:v1:beh-cooldown-open:en-US", { action: "behavior-cooldown-open", locale: "en-US" }],
  [
    "config:v1:beh-cooldown-sub:en-US:nonce1234567",
    { action: "behavior-cooldown-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
];

describe("config Behavior routes", () => {
  it("round-trips the literal D9 custom-ID wire contract", () => {
    for (const [customId, expected] of D9_WIRE_CONTRACT) {
      const parsed = parseInteractionRoute(customId);
      expect(parsed).not.toBeNull();
      if (!parsed) throw new Error(`D9 route did not parse: ${customId}`);
      expect(parseConfigPanelRoute(parsed)).toEqual(expected);
      expect(buildConfigRouteId(expected)).toBe(customId);
    }
  });

  it("pins every D9 action to its literal wire token and field order", () => {
    const expected: Record<string, { wireToken: string; fields: string[] }> = {
      "behavior-prompt-open": { wireToken: "beh-prompt-open", fields: [] },
      "behavior-prompt-submit": { wireToken: "beh-prompt-sub", fields: ["nonce"] },
      "behavior-preset-open": { wireToken: "beh-preset-open", fields: [] },
      "behavior-preset-submit": { wireToken: "beh-preset-sub", fields: ["nonce"] },
      "behavior-prompt-remove": { wireToken: "beh-prompt-remove", fields: [] },
      "behavior-context-open": { wireToken: "beh-context-open", fields: [] },
      "behavior-context-submit": { wireToken: "beh-context-sub", fields: ["nonce"] },
      "behavior-humanizer-open": { wireToken: "beh-humanizer-open", fields: [] },
      "behavior-humanizer-submit": { wireToken: "beh-humanizer-sub", fields: ["nonce"] },
      "behavior-fetch-open": { wireToken: "beh-fetch-open", fields: [] },
      "behavior-fetch-submit": { wireToken: "beh-fetch-sub", fields: ["nonce"] },
      "behavior-timezone-open": { wireToken: "beh-timezone-open", fields: [] },
      "behavior-timezone-submit": { wireToken: "beh-timezone-sub", fields: ["nonce"] },
      "behavior-random-add-open": { wireToken: "beh-random-add-open", fields: [] },
      "behavior-random-add-submit": { wireToken: "beh-random-add-sub", fields: ["nonce"] },
      "behavior-random-remove-open": { wireToken: "beh-random-rem-open", fields: ["start"] },
      "behavior-random-remove-select": { wireToken: "beh-random-rem-select", fields: [] },
      "behavior-random-remove-page": { wireToken: "beh-random-rem-page", fields: ["start"] },
      "behavior-random-remove-submit": { wireToken: "beh-random-rem-sub", fields: ["start", "fp", "nonce"] },
      "behavior-limits-open": { wireToken: "beh-limits-open", fields: [] },
      "behavior-limits-submit": { wireToken: "beh-limits-sub", fields: ["nonce"] },
      "behavior-dtm-set": { wireToken: "beh-dtm-set", fields: ["enabled"] },
      "behavior-always-set": { wireToken: "beh-always-set", fields: ["enabled"] },
      "behavior-cooldown-open": { wireToken: "beh-cooldown-open", fields: [] },
      "behavior-cooldown-submit": { wireToken: "beh-cooldown-sub", fields: ["nonce"] },
    };

    expect(Object.keys(expected).sort()).toEqual(
      Object.keys(CONFIG_ROUTE_CODECS)
        .filter((action) => action.startsWith("behavior-"))
        .sort(),
    );
    for (const [action, contract] of Object.entries(expected)) {
      const codec = CONFIG_ROUTE_CODECS[action as keyof typeof CONFIG_ROUTE_CODECS];
      expect(codec.wireToken).toBe(contract.wireToken);
      expect(codec.fields.map((field) => field.key)).toEqual(contract.fields);
    }
  });

  it("emits literal raw modal component types for D9 inputs", () => {
    const addModal = buildBehaviorRandomAddModal("en-US", "nonce1234567", [makeState()]);
    const humanizerModal = buildBehaviorHumanizerModal("en-US", "nonce1234567", 1);
    const removeModal = buildBehaviorRandomRemoveModal("en-US", "nonce1234567", "abcd1234", 0, [makeRandomTrigger()]);
    const addTypes = collectRawComponentTypes(addModal);
    const humanizerTypes = collectRawComponentTypes(humanizerModal);
    const removeTypes = collectRawComponentTypes(removeModal);

    expect(addTypes).toContain(18); // Label
    expect(addTypes).toContain(8); // Channel Select
    expect(addTypes).toContain(22); // Checkbox Group
    expect(addTypes).toContain(4); // Text Input
    expect(humanizerTypes).toContain(18); // Label
    expect(humanizerTypes).toContain(21); // Radio Group
    expect(removeTypes).toContain(18); // Label
    expect(removeTypes).toContain(22); // Checkbox Group
  });

  it("acknowledges before a permitted DM General write", async () => {
    const harness = makeHarness(false);
    const nonce = "nonce1234567";
    const fields = Object.fromEntries(
      CONFIG_PERSONA_PROMPT_PART_FIELDS.map((field, index) => [
        buildConfigModalFieldId(field, nonce),
        index === 0 ? "New prompt" : "",
      ]),
    );
    const interaction = makeInteraction(
      harness,
      buildConfigRouteId({ action: "behavior-prompt-submit", locale: "en-US", nonce }),
      { kind: "modal", fields, inGuild: false },
    );
    const update = spyOn(configRepository, "updateChatConfig").mockImplementation(async () => {
      harness.deferredAtWrite.push(interaction.deferred || interaction.replied);
      return true;
    });
    await dispatch(harness, interaction);
    expect(harness.deferredAtWrite).toEqual([true]);
    expect(update).toHaveBeenCalledTimes(1);
    update.mockRestore();
  });

  it("denies a forged guild-member General write without touching the repository", async () => {
    const harness = makeHarness(true);
    const update = spyOn(configRepository, "updateChatConfig").mockResolvedValue(true);
    const updateTrigger = spyOn(configRepository, "updateTriggerBehaviorConfig").mockResolvedValue(true);
    await dispatch(
      harness,
      makeInteraction(
        harness,
        buildConfigRouteId({ action: "behavior-fetch-submit", locale: "en-US", nonce: "nonce1234567" }),
        {
          kind: "modal",
          isManager: false,
          fields: { [buildConfigModalFieldId(BEHAVIOR_FETCH_LIMIT_FIELD, "nonce1234567")]: "60" },
        },
      ),
    );
    await dispatch(
      harness,
      makeInteraction(harness, buildConfigRouteId({ action: "behavior-dtm-set", locale: "en-US", enabled: false }), {
        isManager: false,
      }),
    );
    expect(update).not.toHaveBeenCalled();
    expect(updateTrigger).not.toHaveBeenCalled();
    update.mockRestore();
    updateTrigger.mockRestore();
  });

  it("denies Timezone and all Trigger routes in a DM", async () => {
    const harness = makeHarness(false);
    const updateChat = spyOn(configRepository, "updateChatConfig").mockResolvedValue(true);
    const updateTrigger = spyOn(configRepository, "updateTriggerBehaviorConfig").mockResolvedValue(true);
    await dispatch(
      harness,
      makeInteraction(
        harness,
        buildConfigRouteId({ action: "behavior-timezone-submit", locale: "en-US", nonce: "nonce1234567" }),
        {
          kind: "modal",
          inGuild: false,
          fields: { [buildConfigModalFieldId("behavior_timezone", "nonce1234567")]: "8" },
        },
      ),
    );
    await dispatch(
      harness,
      makeInteraction(harness, buildConfigRouteId({ action: "behavior-dtm-set", locale: "en-US", enabled: true }), {
        inGuild: false,
      }),
    );
    expect(updateChat).not.toHaveBeenCalled();
    expect(updateTrigger).not.toHaveBeenCalled();
    updateChat.mockRestore();
    updateTrigger.mockRestore();
  });

  it("uses the raw global humanizer value and returns a no-op without writing", async () => {
    const harness = makeHarness(false);
    const update = spyOn(configRepository, "updateChatConfig").mockResolvedValue(true);
    const field = buildConfigModalFieldId(BEHAVIOR_HUMANIZER_FIELD, "nonce1234567");
    await dispatch(
      harness,
      makeInteraction(
        harness,
        buildConfigRouteId({ action: "behavior-humanizer-submit", locale: "en-US", nonce: "nonce1234567" }),
        { kind: "modal", inGuild: false, fields: { [field]: "1" } },
      ),
    );
    expect(update).not.toHaveBeenCalled();
    expect(harness.edits.length).toBeGreaterThan(0);
    update.mockRestore();
  });

  it("treats an already selected direct trigger state as a no-op", async () => {
    const harness = makeHarness(true);
    const update = spyOn(configRepository, "updateTriggerBehaviorConfig").mockResolvedValue(true);
    await dispatch(
      harness,
      makeInteraction(harness, buildConfigRouteId({ action: "behavior-dtm-set", locale: "en-US", enabled: false })),
    );
    expect(update).not.toHaveBeenCalled();
    update.mockRestore();
  });

  it("preserves random-trigger fields while updating the existing persona/channel identity", async () => {
    const harness = makeHarness(true);
    const nonce = "nonce1234567";
    const fields = {
      [buildConfigModalFieldId(BEHAVIOR_RANDOM_SETTINGS_FIELD, nonce)]: "6,35,2,4,3",
      [buildConfigModalFieldId(BEHAVIOR_RANDOM_PROMPT_FIELD, nonce)]: "Start a topic.",
    };
    harness.dependencies.takeSelectValue = (_interactionId, fieldId) =>
      fieldId === buildConfigModalFieldId(BEHAVIOR_RANDOM_CHANNEL_FIELD, nonce)
        ? "channel-1"
        : fieldId === buildConfigModalFieldId(BEHAVIOR_RANDOM_PERSONA_FIELD, nonce)
          ? "55"
          : undefined;
    harness.dependencies.takeCheckboxValues = () => ["yes"];
    const existing = makeRandomTrigger();
    const count = spyOn(serverScheduleRepository, "getServerTriggerCount").mockResolvedValue(1);
    const lookup = spyOn(serverScheduleRepository, "getTriggerByPersonaAndChannel").mockResolvedValue(existing);
    const upsert = spyOn(serverScheduleRepository, "upsertTrigger").mockResolvedValue(existing);
    await dispatch(
      harness,
      makeInteraction(harness, buildConfigRouteId({ action: "behavior-random-add-submit", locale: "en-US", nonce }), {
        kind: "modal",
        fields,
      }),
    );
    expect(lookup).toHaveBeenCalledWith(9, "channel-1", 55);
    expect(upsert).toHaveBeenCalledWith(9, {
      serverId: 9,
      channelDiscId: "channel-1",
      personaId: 55,
      timerHours: 6,
      chancePercent: 35,
      randomOffsetRange: 2,
      silenceThresholdHours: 4,
      failureThreshold: 3,
      respondToSelf: true,
      customPrompt: "Start a topic.",
    });
    count.mockRestore();
    lookup.mockRestore();
    upsert.mockRestore();
  });

  it("re-reads random triggers and removes checked-list omissions, including an explicit empty selection", async () => {
    const harness = makeHarness(true);
    const trigger = makeRandomTrigger();
    const getTriggers = spyOn(serverScheduleRepository, "getServerTriggers").mockResolvedValue([trigger]);
    const deleteTrigger = spyOn(serverScheduleRepository, "deleteTrigger").mockResolvedValue(true);
    harness.dependencies.loadBehaviorView = async (current) => ({
      general: {
        systemPrompt: current.config.system_prompt ?? null,
        contextNote: current.config.context_note ?? null,
        contextNoteDepth: current.config.context_note_depth ?? 0,
        humanizerDegree: current.config.humanizer_degree ?? 1,
        messageFetchLimit: current.config.message_fetch_limit ?? 80,
        timezoneOffset: current.config.timezone_offset ?? 0,
      },
      trigger: {
        randomTriggers: [trigger],
        cascadeLimit: current.config.cascade_limit ?? 3,
        matchLimit: current.config.match_limit ?? 3,
        deliberateTriggerMode: current.config.deliberate_trigger_mode ?? false,
        alwaysReplyEnabled: current.config.always_reply_enabled ?? false,
        cooldownType: current.config.cooldown_type ?? 0,
        cooldownLength: current.config.cooldown_length ?? 5,
      },
    });
    harness.dependencies.takeCheckboxValues = () => [];
    const fp = computeRandomTriggerRemoveFingerprint(9, [trigger]);
    await dispatch(
      harness,
      makeInteraction(
        harness,
        buildConfigRouteId({
          action: "behavior-random-remove-submit",
          locale: "en-US",
          start: 0,
          fp,
          nonce: "nonce1234567",
        }),
        { kind: "modal" },
      ),
    );
    expect(getTriggers).toHaveBeenCalledWith(9);
    expect(deleteTrigger).toHaveBeenCalledWith(9);
    getTriggers.mockRestore();
    deleteTrigger.mockRestore();
  });

  it("rejects random-trigger removal when checkbox evidence is missing", async () => {
    const harness = makeHarness(true);
    const trigger = makeRandomTrigger();
    const getTriggers = spyOn(serverScheduleRepository, "getServerTriggers").mockResolvedValue([trigger]);
    const deleteTrigger = spyOn(serverScheduleRepository, "deleteTrigger").mockResolvedValue(true);
    harness.dependencies.takeCheckboxValues = () => undefined;
    const fp = computeRandomTriggerRemoveFingerprint(9, [trigger]);
    await dispatch(
      harness,
      makeInteraction(
        harness,
        buildConfigRouteId({
          action: "behavior-random-remove-submit",
          locale: "en-US",
          start: 0,
          fp,
          nonce: "nonce1234567",
        }),
        { kind: "modal" },
      ),
    );
    expect(deleteTrigger).not.toHaveBeenCalled();
    getTriggers.mockRestore();
    deleteTrigger.mockRestore();
  });

  it("stops random-trigger removal when the live schedule fingerprint changed", async () => {
    const harness = makeHarness(true);
    const original = makeRandomTrigger();
    const changed = { ...original, chance_percent: original.chance_percent + 1 };
    const getTriggers = spyOn(serverScheduleRepository, "getServerTriggers").mockResolvedValue([changed]);
    const deleteTrigger = spyOn(serverScheduleRepository, "deleteTrigger").mockResolvedValue(true);
    harness.dependencies.takeCheckboxValues = () => [];
    const fp = computeRandomTriggerRemoveFingerprint(9, [original]);
    await dispatch(
      harness,
      makeInteraction(
        harness,
        buildConfigRouteId({
          action: "behavior-random-remove-submit",
          locale: "en-US",
          start: 0,
          fp,
          nonce: "nonce1234567",
        }),
        { kind: "modal" },
      ),
    );
    expect(getTriggers).toHaveBeenCalledWith(9);
    expect(deleteTrigger).not.toHaveBeenCalled();
    getTriggers.mockRestore();
    deleteTrigger.mockRestore();
  });

  it("opens the selected overflow page through the real select route", async () => {
    const harness = makeHarness(true);
    const first = makeRandomTrigger();
    const triggers = Array.from({ length: 51 }, (_entry, index) => ({ ...first, trigger_id: index + 1 }));
    harness.dependencies.loadBehaviorView = async (current) => ({
      general: {
        systemPrompt: current.config.system_prompt ?? null,
        contextNote: current.config.context_note ?? null,
        contextNoteDepth: current.config.context_note_depth ?? 0,
        humanizerDegree: current.config.humanizer_degree ?? 1,
        messageFetchLimit: current.config.message_fetch_limit ?? 80,
        timezoneOffset: current.config.timezone_offset ?? 0,
      },
      trigger: {
        randomTriggers: triggers,
        cascadeLimit: current.config.cascade_limit ?? 3,
        matchLimit: current.config.match_limit ?? 3,
        deliberateTriggerMode: current.config.deliberate_trigger_mode ?? false,
        alwaysReplyEnabled: current.config.always_reply_enabled ?? false,
        cooldownType: current.config.cooldown_type ?? 0,
        cooldownLength: current.config.cooldown_length ?? 5,
      },
    });
    await dispatch(
      harness,
      makeInteraction(harness, buildConfigRouteId({ action: "behavior-random-remove-select", locale: "en-US" }), {
        kind: "select",
        values: ["50"],
      }),
    );
    expect(harness.modals).toHaveLength(1);
    expect((harness.modals[0] as { custom_id: string }).custom_id).toContain("beh-random-rem-sub");
    expect((harness.modals[0] as { components: unknown[] }).components).toHaveLength(1);
  });

  it("pages the removal selector beyond 25 page ranges through the real route registry", async () => {
    const harness = makeHarness(true);
    const first = makeRandomTrigger();
    const triggers = Array.from({ length: 1300 }, (_entry, index) => ({ ...first, trigger_id: index + 1 }));
    harness.dependencies.loadBehaviorView = async (current) => ({
      general: {
        systemPrompt: current.config.system_prompt ?? null,
        contextNote: current.config.context_note ?? null,
        contextNoteDepth: current.config.context_note_depth ?? 0,
        humanizerDegree: current.config.humanizer_degree ?? 1,
        messageFetchLimit: current.config.message_fetch_limit ?? 80,
        timezoneOffset: current.config.timezone_offset ?? 0,
      },
      trigger: {
        randomTriggers: triggers,
        cascadeLimit: current.config.cascade_limit ?? 3,
        matchLimit: current.config.match_limit ?? 3,
        deliberateTriggerMode: current.config.deliberate_trigger_mode ?? false,
        alwaysReplyEnabled: current.config.always_reply_enabled ?? false,
        cooldownType: current.config.cooldown_type ?? 0,
        cooldownLength: current.config.cooldown_length ?? 5,
      },
    });

    await dispatch(
      harness,
      makeInteraction(
        harness,
        buildConfigRouteId({
          action: "behavior-random-remove-page",
          locale: "en-US",
          start: CONFIG_PERSONA_SELECT_PAGE_SIZE * CONFIG_RANDOM_TRIGGER_CHECKBOX_CAPACITY,
        }),
      ),
    );

    expect(harness.edits).toHaveLength(1);
    expect(JSON.stringify(harness.edits[0])).toContain(
      buildConfigRouteId({ action: "behavior-random-remove-select", locale: "en-US" }),
    );
    expect(JSON.stringify(harness.edits[0])).toContain(
      String(CONFIG_PERSONA_SELECT_PAGE_SIZE * CONFIG_RANDOM_TRIGGER_CHECKBOX_CAPACITY),
    );
  });
});
