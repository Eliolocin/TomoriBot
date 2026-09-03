import { beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import { ChannelType, ComponentType, PermissionsBitField, type Client } from "discord.js";
import type { LlmRow, TomoriState } from "@/types/db/schema";
import { configRepository } from "@/utils/db/repositories";
import * as tomoriStateCache from "@/utils/cache/tomoriStateCache";
import {
  computeAutoTriggerFingerprint,
  computeChannelOverridesFingerprint,
  computeChannelRulesFingerprint,
  CONFIG_ROUTE_CODECS,
  buildConfigRouteId,
  type ConfigPanelRoute,
} from "@/utils/discord/configPanelCatalog";
import {
  loadCachedGuildBlocklistChannels,
  type ChannelOverrideChannelTarget,
  loadCachedGuildTextChecklistChannels,
} from "@/utils/discord/channelChecklistManager";
import type {
  ConfigChannelsOverridesView,
  ConfigChannelsView,
  ConfigRouteDependencies,
  ConfigScope,
} from "@/utils/discord/interactions/configRouteContext";
import { channelContextNoteRepo, channelPromptRepo } from "@/utils/db/repositories";
import { configPersonaOperations } from "@/utils/discord/interactions/configPersonaOperations";
import type { RawModalPayload } from "@/utils/discord/ui/configModals";
import { createConfigInteractionRoute } from "@/utils/discord/interactions/configRoutes";
import { InteractionRouteRegistry } from "@/utils/discord/interactions/routeRegistry";
import {
  buildConfigWelcomeModal,
  buildConfigAutoTriggerChannelsModal,
  buildConfigAutoTriggerConfigureModal,
  buildConfigBlocklistChannelsModal,
  buildConfigPrivateChannelsModal,
  buildConfigRoleplayChannelsModal,
  CONFIG_CHANNEL_AUTO_TRIGGER_CHECKBOX_PREFIX,
  CONFIG_CHANNEL_AUTO_TRIGGER_CHANNEL_FIELD,
  CONFIG_CHANNEL_AUTO_TRIGGER_ENABLED_FIELD,
  CONFIG_CHANNEL_AUTO_TRIGGER_PERSONA_FIELD,
  CONFIG_CHANNEL_AUTO_TRIGGER_THRESHOLD_FIELD,
  CONFIG_CHANNEL_AUTO_TRIGGER_MAX_THRESHOLD_FIELD,
  CONFIG_CHANNEL_BLOCKLIST_CHECKBOX_PREFIX,
  CONFIG_CHANNEL_PRIVATE_CHECKBOX_PREFIX,
  CONFIG_CHANNEL_RP_CHECKBOX_PREFIX,
  CONFIG_CHANNEL_LOG_FIELD,
  CONFIG_CHANNEL_WELCOME_FIELD,
  CONFIG_CHANNEL_WELCOME_PERSONA_FIELD,
  CONFIG_CHANNEL_WELCOME_PROMPT_FIELD,
  CONFIG_CHANNEL_OVERRIDE_CONTEXT_NOTE_DEPTH_FIELD,
  CONFIG_CHANNEL_OVERRIDE_CONTEXT_NOTE_TEXT_FIELD,
  CONFIG_CHANNEL_OVERRIDE_MODE_FIELD,
  CONFIG_CHANNEL_OVERRIDE_PROMPT_PART_FIELDS,
} from "@/utils/discord/ui/configChannelModals";
import { buildConfigModalFieldId } from "@/utils/discord/ui/configModals";
import { buildConfigPanelPayload } from "@/utils/discord/ui/configPanel";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const CLIENT = {} as Client;
const CHANNEL_ONE = "123456789012345678";
const CHANNEL_TWO = "223456789012345678";

function makePersona(overrides: Partial<TomoriState> = {}): TomoriState {
  return {
    server_id: 9,
    persona_id: 55,
    persona_nickname: "Sparrow",
    is_alter: false,
    trigger_words: [],
    naming_config: { prefixes: {}, suffixes: {}, addressTerms: {} },
    config: {},
    ...overrides,
  } as unknown as TomoriState;
}

function makeScope(
  state: TomoriState,
  inGuild = true,
  isManager = true,
  personas: TomoriState[] = [state],
): ConfigScope {
  return {
    serverDiscId: inGuild ? "guild-1" : "user-1",
    guildId: inGuild ? "guild-1" : null,
    internalServerId: 9,
    userId: 1,
    actor: { workspaceKind: inGuild ? "guild" : "dm", isManager },
    personas,
    readStatus: "fresh",
  };
}

function makeChannelsView(
  state: TomoriState,
  availableTextChannels = [
    { id: CHANNEL_ONE, name: "lounge", rawPosition: 0, parentRawPosition: -1 },
    { id: CHANNEL_TWO, name: "welcome", rawPosition: 1, parentRawPosition: -1 },
  ],
  availableBlocklistChannels = availableTextChannels.map((channel) => ({
    ...channel,
    type: ChannelType.GuildText,
    parentName: null,
  })),
  availableOverrideChannels = availableTextChannels.map((channel) => ({
    ...channel,
    type: ChannelType.GuildText,
  })) as ChannelOverrideChannelTarget[],
  overrides: Partial<ConfigChannelsOverridesView> = {},
): ConfigChannelsView {
  const channelOverrides: ConfigChannelsOverridesView = {
    selectedChannelId: null,
    prompt: null,
    contextNote: null,
    textModelOverride: null,
    ...overrides,
  };
  return {
    destinations: {
      thoughtLogChannelId: state.config.thought_log_channel_disc_id ?? null,
      welcomeChannelId: state.config.welcome_channel_disc_id ?? null,
      welcomePrompt: state.config.welcome_prompt ?? null,
      welcomePersonaId: state.config.welcome_persona_id ?? null,
    },
    autoTrigger: {
      enabledChannels: availableTextChannels.filter((channel) => state.config.autoch_disc_ids?.includes(channel.id)),
      personaOverrides: state.config.autoch_persona_overrides ?? [],
      threshold: state.config.autoch_threshold ?? 0,
      maxThreshold: state.config.autoch_threshold_max ?? state.config.autoch_threshold ?? 0,
    },
    rules: {
      privateChannels: availableTextChannels.filter((channel) =>
        state.config.private_channel_ids?.includes(channel.id),
      ),
      roleplayChannels: availableTextChannels.filter((channel) => state.config.rp_channel_ids?.includes(channel.id)),
      crossChannelBlocklist: availableBlocklistChannels.filter((channel) =>
        state.config.crosschannel_blocklist_ids?.includes(channel.id),
      ),
    },
    availableTextChannels,
    availableBlocklistChannels,
    availableOverrideChannels,
    overrides: channelOverrides,
  };
}

interface FakeInteractionOptions {
  route: ConfigPanelRoute;
  kind?: "button" | "modal" | "channel-select" | "string-select";
  isManager?: boolean;
  inGuild?: boolean;
  fields?: Record<string, string>;
  selectedValue?: string;
  fetch?: () => Promise<unknown>;
}

function makeInteraction(options: FakeInteractionOptions) {
  let deferred = false;
  let replied = false;
  const kind = options.kind ?? "button";
  const fields = new Map(Object.keys(options.fields ?? {}).map((fieldId) => [fieldId, true]));
  const editedReplies: unknown[] = [];

  const interaction = {
    id: "interaction-1",
    customId: buildConfigRouteId(options.route),
    user: { id: "user-1", username: "Sparrow" },
    channelId: CHANNEL_ONE,
    channel: { name: "lounge" },
    guildId: options.inGuild === false ? null : "guild-1",
    guild:
      options.inGuild === false
        ? null
        : { channels: { fetch: options.fetch ?? (async () => undefined), cache: new Map() } },
    client: { user: null },
    memberPermissions: {
      has: (flag: bigint) => (options.isManager ?? true) && flag === PermissionsBitField.Flags.ManageGuild,
    },
    isButton: () => kind === "button",
    isStringSelectMenu: () => kind === "string-select",
    isChannelSelectMenu: () => kind === "channel-select",
    isModalSubmit: () => kind === "modal",
    values: options.selectedValue ? [options.selectedValue] : [CHANNEL_ONE],
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
      editedReplies.push(payload);
      return payload;
    },
    reply: async () => {
      replied = true;
    },
    followUp: async (payload: unknown) => payload,
    fields: {
      fields,
      getTextInputValue: (fieldId: string) => options.fields?.[fieldId] ?? "",
    },
    editedReplies,
  };

  return interaction as unknown as Parameters<ReturnType<typeof createConfigInteractionRoute>["execute"]>[1] & {
    deferred: boolean;
    replied: boolean;
    editedReplies: unknown[];
  };
}

interface HarnessOptions {
  state: TomoriState;
  isManager?: boolean;
  inGuild?: boolean;
  channelValues?: Record<string, string | undefined>;
  selectValues?: Record<string, string | undefined>;
  checkboxValues?: Record<string, string[] | undefined>;
  personas?: TomoriState[];
  loadChannelsView?: ConfigRouteDependencies["loadChannelsView"];
  loadSavedTextProviders?: ConfigRouteDependencies["loadSavedTextProviders"];
  loadPersonaTextModels?: ConfigRouteDependencies["loadPersonaTextModels"];
  recordAction?: ConfigRouteDependencies["recordAction"];
  showModal?: ConfigRouteDependencies["showModal"];
  operations?: ConfigRouteDependencies["operations"];
}

function makeHarness(options: HarnessOptions) {
  const state = options.state;
  const scope = makeScope(state, options.inGuild !== false, options.isManager ?? true, options.personas ?? [state]);
  const dependencies: Partial<ConfigRouteDependencies> = {
    resolveScope: async () => scope,
    getPersonaAvatarData: async () => ({ url: null, files: [] }),
    loadChannelsView: options.loadChannelsView ?? (async () => makeChannelsView(state)),
    loadSavedTextProviders: options.loadSavedTextProviders ?? (async () => []),
    loadPersonaTextModels: options.loadPersonaTextModels ?? (async () => []),
    recordAction: options.recordAction ?? (() => undefined),
    operations: options.operations ?? configPersonaOperations,
    showModal: async (interaction, payload) => options.showModal?.(interaction, payload),
    takeChannelSelectValue: (_interactionId, fieldId) => options.channelValues?.[fieldId],
    takeSelectValue: (_interactionId, fieldId) => options.selectValues?.[fieldId],
    takeCheckboxValues: (_interactionId, fieldId) => options.checkboxValues?.[fieldId],
  };
  return {
    dependencies,
    dispatch: async (interaction: ReturnType<typeof makeInteraction>) => {
      const registry = new InteractionRouteRegistry([createConfigInteractionRoute(dependencies)]);
      await registry.dispatch(CLIENT, interaction);
    },
  };
}

function welcomeFields(nonce: string, personaValue: string, prompt: string) {
  return {
    [buildConfigModalFieldId(CONFIG_CHANNEL_WELCOME_PROMPT_FIELD, nonce)]: prompt,
    [buildConfigModalFieldId(CONFIG_CHANNEL_WELCOME_PERSONA_FIELD, nonce)]: personaValue,
    [buildConfigModalFieldId(CONFIG_CHANNEL_WELCOME_FIELD, nonce)]: CHANNEL_TWO,
  };
}

function makeChecklistChannels(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: String(100000000000000000n + BigInt(index)),
    name: `channel-${index}`,
    rawPosition: index,
    parentRawPosition: -1,
  }));
}

function autoTriggerFingerprint(state: TomoriState, channels: readonly { id: string }[]): string {
  return computeAutoTriggerFingerprint(
    state.server_id,
    channels.map((channel) => channel.id),
    state.config.autoch_disc_ids ?? [],
    state.config.autoch_persona_overrides ?? [],
  );
}

function channelRulesFingerprint(
  state: TomoriState,
  collection: "private" | "roleplay" | "blocklist",
  channels: readonly { id: string }[],
): string {
  const selectedIds =
    collection === "private"
      ? (state.config.private_channel_ids ?? [])
      : collection === "roleplay"
        ? (state.config.rp_channel_ids ?? [])
        : (state.config.crosschannel_blocklist_ids ?? []);
  return computeChannelRulesFingerprint(
    state.server_id,
    collection,
    channels.map((channel) => channel.id),
    selectedIds,
  );
}

function checkboxValues(nonce: string, groups: string[][]): Record<string, string[]> {
  return Object.fromEntries(
    groups.map((values, groupIndex) => [
      buildConfigModalFieldId(`${CONFIG_CHANNEL_AUTO_TRIGGER_CHECKBOX_PREFIX}_${groupIndex}`, nonce),
      values,
    ]),
  );
}

function rulesCheckboxValues(nonce: string, prefix: string, groups: string[][]): Record<string, string[]> {
  return Object.fromEntries(
    groups.map((values, groupIndex) => [buildConfigModalFieldId(`${prefix}_${groupIndex}`, nonce), values]),
  );
}

function thresholdFields(nonce: string, threshold: number, maxThreshold?: number): Record<string, string> {
  return {
    [buildConfigModalFieldId(CONFIG_CHANNEL_AUTO_TRIGGER_THRESHOLD_FIELD, nonce)]: String(threshold),
    ...(maxThreshold === undefined
      ? {}
      : { [buildConfigModalFieldId(CONFIG_CHANNEL_AUTO_TRIGGER_MAX_THRESHOLD_FIELD, nonce)]: String(maxThreshold) }),
  };
}

function makeOverrideChannels(): ChannelOverrideChannelTarget[] {
  return [
    { id: CHANNEL_ONE, name: "lounge", type: ChannelType.GuildText, rawPosition: 0, parentRawPosition: -1 },
    {
      id: CHANNEL_TWO,
      name: "announcements",
      type: ChannelType.GuildAnnouncement,
      rawPosition: 1,
      parentRawPosition: -1,
    },
    {
      id: "323456789012345678",
      name: "public-thread",
      type: ChannelType.PublicThread,
      rawPosition: 2,
      parentRawPosition: 0,
    },
    {
      id: "423456789012345678",
      name: "private-thread",
      type: ChannelType.PrivateThread,
      rawPosition: 3,
      parentRawPosition: 0,
    },
    {
      id: "523456789012345678",
      name: "announcement-thread",
      type: ChannelType.AnnouncementThread,
      rawPosition: 4,
      parentRawPosition: 1,
    },
  ];
}

function makeLlm(llmId: number, provider: string, codename: string): LlmRow {
  return {
    llm_id: llmId,
    llm_provider: provider,
    llm_codename: codename,
  } as LlmRow;
}

function promptOverrideFields(
  nonce: string,
  parts: readonly string[],
  mode: "append" | "replace" = "append",
): Record<string, string> {
  return {
    [buildConfigModalFieldId(CONFIG_CHANNEL_OVERRIDE_MODE_FIELD, nonce)]: mode,
    ...Object.fromEntries(
      CONFIG_CHANNEL_OVERRIDE_PROMPT_PART_FIELDS.map((field, index) => [
        buildConfigModalFieldId(field, nonce),
        parts[index] ?? "",
      ]),
    ),
  };
}

function contextNoteFields(nonce: string, note: string, depth: number | string): Record<string, string> {
  return {
    [buildConfigModalFieldId(CONFIG_CHANNEL_OVERRIDE_CONTEXT_NOTE_TEXT_FIELD, nonce)]: note,
    [buildConfigModalFieldId(CONFIG_CHANNEL_OVERRIDE_CONTEXT_NOTE_DEPTH_FIELD, nonce)]: String(depth),
  };
}

function overrideFingerprint(
  state: TomoriState,
  channelId: string,
  values: Partial<ConfigChannelsOverridesView> = {},
): string {
  return computeChannelOverridesFingerprint(
    state.server_id,
    channelId,
    values.prompt ?? null,
    values.contextNote ?? null,
    values.textModelOverride?.llm_id ?? null,
    state.llm?.llm_id ?? null,
  );
}

function makeOverrideLoader(
  state: TomoriState,
  channels: ChannelOverrideChannelTarget[],
  values: Partial<ConfigChannelsOverridesView> = {},
): ConfigRouteDependencies["loadChannelsView"] {
  return async (_interaction, selectedChannelId) =>
    makeChannelsView(state, undefined, undefined, channels, {
      ...values,
      selectedChannelId: selectedChannelId ?? values.selectedChannelId ?? null,
    });
}

describe("Channels Destinations routes", () => {
  it("uses the native Channel Select component type 8 in the welcome modal", () => {
    const modal = buildConfigWelcomeModal("en-US", "nonce1234567", [makePersona()], null, null);
    expect(modal.components[0]?.component?.type).toBe(8);
  });

  it("opens a modal without pre-deferring the button interaction", async () => {
    let acknowledgedBeforeModal = true;
    const harness = makeHarness({
      state: makePersona(),
      showModal: async (interaction) => {
        const target = interaction as { deferred: boolean; replied: boolean };
        acknowledgedBeforeModal = target.deferred || target.replied;
      },
    });
    const interaction = makeInteraction({ route: { action: "channels-log-open", locale: "en-US" } });

    await harness.dispatch(interaction);

    expect(acknowledgedBeforeModal).toBe(false);
  });

  it("opens both destination modals without loading the channel view and preserves Welcome defaults", async () => {
    const state = makePersona({
      config: {
        welcome_channel_disc_id: CHANNEL_TWO,
        welcome_prompt: "Welcome aboard.",
        welcome_persona_id: 55,
      } as TomoriState["config"],
    });
    const loadChannelsView = mock(async () => makeChannelsView(state));
    const shownModals: RawModalPayload[] = [];
    const harness = makeHarness({
      state,
      loadChannelsView,
      showModal: async (_interaction, payload) => {
        expect(loadChannelsView).not.toHaveBeenCalled();
        shownModals.push(payload);
      },
    });

    await harness.dispatch(makeInteraction({ route: { action: "channels-log-open", locale: "en-US" } }));
    await harness.dispatch(makeInteraction({ route: { action: "channels-welcome-open", locale: "en-US" } }));

    expect(loadChannelsView).not.toHaveBeenCalled();
    expect(shownModals).toHaveLength(2);
    const welcomeModal = shownModals[1];
    expect(welcomeModal?.components[1]?.component?.options).toContainEqual(
      expect.objectContaining({ value: "55", default: true }),
    );
    expect(welcomeModal?.components[2]?.component?.value).toBe("Welcome aboard.");
  });

  it("does not clear Logs when Set receives the already configured channel", async () => {
    const nonce = "nonce1234567";
    const state = makePersona({ config: { thought_log_channel_disc_id: CHANNEL_ONE } as TomoriState["config"] });
    const recordAction = mock(() => undefined);
    const harness = makeHarness({
      state,
      recordAction,
      channelValues: { [buildConfigModalFieldId("channels_log_channel", nonce)]: CHANNEL_ONE },
    });
    const update = spyOn(configRepository, "updateChannelScopeConfig");
    const interaction = makeInteraction({
      route: { action: "channels-log-submit", locale: "en-US", nonce },
      kind: "modal",
    });

    await harness.dispatch(interaction);

    expect(update).not.toHaveBeenCalled();
    expect(recordAction).not.toHaveBeenCalled();
    expect(JSON.stringify(interaction.editedReplies)).toContain("Already Set");
    update.mockRestore();
  });

  it("records telemetry after setting Logs", async () => {
    const nonce = "nonce1234567";
    const state = makePersona({ config: { autoch_disc_ids: [CHANNEL_ONE] } as TomoriState["config"] });
    const recordAction = mock(() => undefined);
    const harness = makeHarness({
      state,
      recordAction,
      channelValues: { [buildConfigModalFieldId(CONFIG_CHANNEL_LOG_FIELD, nonce)]: CHANNEL_ONE },
    });
    const update = spyOn(configRepository, "updateChannelScopeConfig").mockImplementation(async () => true);
    const invalidate = spyOn(tomoriStateCache, "invalidateTomoriStateCache").mockImplementation(() => undefined);
    const interaction = makeInteraction({
      route: { action: "channels-log-submit", locale: "en-US", nonce },
      kind: "modal",
    });

    await harness.dispatch(interaction);

    expect(recordAction).toHaveBeenCalledTimes(1);
    expect(recordAction).toHaveBeenCalledWith({
      action: "server-config.workspace.thought-logs-channel.set",
      serverId: 9,
      userDiscId: "user-1",
    });
    update.mockRestore();
    invalidate.mockRestore();
  });

  it("clears Logs through the repository after acknowledging the interaction", async () => {
    const state = makePersona({ config: { thought_log_channel_disc_id: CHANNEL_ONE } as TomoriState["config"] });
    const recordAction = mock(() => undefined);
    const harness = makeHarness({ state, recordAction });
    const events: string[] = [];
    const update = spyOn(configRepository, "updateChannelScopeConfig").mockImplementation(async () => {
      events.push("write");
      expect(interaction.deferred || interaction.replied).toBe(true);
      return true;
    });
    const invalidate = spyOn(tomoriStateCache, "invalidateTomoriStateCache").mockImplementation(() => {
      events.push("invalidate");
    });
    const interaction = makeInteraction({
      route: { action: "channels-log-clear", locale: "en-US", channelId: CHANNEL_ONE },
    });

    await harness.dispatch(interaction);

    expect(update).toHaveBeenCalledWith(9, { thought_log_channel_disc_id: null });
    expect(events).toEqual(["write", "invalidate"]);
    expect(recordAction).toHaveBeenCalledTimes(1);
    expect(recordAction).toHaveBeenCalledWith({
      action: "server-config.workspace.thought-logs-channel.clear",
      serverId: 9,
      userDiscId: "user-1",
    });
    update.mockRestore();
    invalidate.mockRestore();
  });

  it("writes the welcome channel, prompt, and Random persona together", async () => {
    const nonce = "nonce1234567";
    const state = makePersona({ config: {} as TomoriState["config"] });
    const recordAction = mock(() => undefined);
    const harness = makeHarness({
      state,
      recordAction,
      channelValues: { [buildConfigModalFieldId(CONFIG_CHANNEL_WELCOME_FIELD, nonce)]: CHANNEL_TWO },
      selectValues: { [buildConfigModalFieldId(CONFIG_CHANNEL_WELCOME_PERSONA_FIELD, nonce)]: "random" },
    });
    const update = spyOn(configRepository, "updateWelcomeConfig").mockImplementation(async (_serverId, patch) => {
      expect(interaction.deferred || interaction.replied).toBe(true);
      expect(patch).toEqual({
        welcome_channel_disc_id: CHANNEL_TWO,
        welcome_prompt: "Welcome aboard.",
        welcome_persona_id: null,
      });
      return true;
    });
    const invalidate = spyOn(tomoriStateCache, "invalidateTomoriStateCache").mockImplementation(() => undefined);
    const interaction = makeInteraction({
      route: { action: "channels-welcome-submit", locale: "en-US", nonce },
      kind: "modal",
      fields: welcomeFields(nonce, "random", "  Welcome aboard.  "),
    });

    await harness.dispatch(interaction);

    expect(update).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith("guild-1");
    expect(recordAction).toHaveBeenCalledTimes(1);
    expect(recordAction).toHaveBeenCalledWith({
      action: "server-config.workspace.welcome-channel.set",
      serverId: 9,
      userDiscId: "user-1",
    });
    update.mockRestore();
    invalidate.mockRestore();
  });

  it("refuses an empty prompt and an unknown persona before writing", async () => {
    const nonce = "nonce1234567";
    const state = makePersona({ config: {} as TomoriState["config"] });
    const recordAction = mock(() => undefined);
    const update = spyOn(configRepository, "updateWelcomeConfig");
    const emptyPromptHarness = makeHarness({
      state,
      recordAction,
      channelValues: { [buildConfigModalFieldId(CONFIG_CHANNEL_WELCOME_FIELD, nonce)]: CHANNEL_TWO },
      selectValues: { [buildConfigModalFieldId(CONFIG_CHANNEL_WELCOME_PERSONA_FIELD, nonce)]: "random" },
    });
    await emptyPromptHarness.dispatch(
      makeInteraction({
        route: { action: "channels-welcome-submit", locale: "en-US", nonce },
        kind: "modal",
        fields: welcomeFields(nonce, "random", "   "),
      }),
    );
    expect(update).not.toHaveBeenCalled();

    const unknownPersonaHarness = makeHarness({
      state,
      recordAction,
      channelValues: { [buildConfigModalFieldId(CONFIG_CHANNEL_WELCOME_FIELD, nonce)]: CHANNEL_TWO },
      selectValues: { [buildConfigModalFieldId(CONFIG_CHANNEL_WELCOME_PERSONA_FIELD, nonce)]: "999" },
    });
    await unknownPersonaHarness.dispatch(
      makeInteraction({
        route: { action: "channels-welcome-submit", locale: "en-US", nonce },
        kind: "modal",
        fields: welcomeFields(nonce, "999", "Welcome aboard."),
      }),
    );
    expect(update).not.toHaveBeenCalled();
    expect(recordAction).not.toHaveBeenCalled();
    update.mockRestore();
  });

  it("records telemetry after clearing Welcome", async () => {
    const state = makePersona({
      config: {
        welcome_channel_disc_id: CHANNEL_TWO,
        welcome_prompt: "Welcome aboard.",
        welcome_persona_id: 55,
      } as TomoriState["config"],
    });
    const recordAction = mock(() => undefined);
    const harness = makeHarness({ state, recordAction });
    const update = spyOn(configRepository, "updateWelcomeConfig").mockImplementation(async () => true);
    const invalidate = spyOn(tomoriStateCache, "invalidateTomoriStateCache").mockImplementation(() => undefined);
    const interaction = makeInteraction({
      route: { action: "channels-welcome-clear", locale: "en-US", channelId: CHANNEL_TWO },
    });

    await harness.dispatch(interaction);

    expect(recordAction).toHaveBeenCalledTimes(1);
    expect(recordAction).toHaveBeenCalledWith({
      action: "server-config.workspace.welcome-channel.clear",
      serverId: 9,
      userDiscId: "user-1",
    });
    update.mockRestore();
    invalidate.mockRestore();
  });

  it("does not write when Clear Welcome is already unconfigured", async () => {
    const state = makePersona({ config: {} as TomoriState["config"] });
    const recordAction = mock(() => undefined);
    const harness = makeHarness({ state, recordAction });
    const update = spyOn(configRepository, "updateWelcomeConfig");
    const interaction = makeInteraction({ route: { action: "channels-welcome-clear", locale: "en-US" } });

    await harness.dispatch(interaction);

    expect(update).not.toHaveBeenCalled();
    expect(recordAction).not.toHaveBeenCalled();
    expect(JSON.stringify(interaction.editedReplies)).toContain("Not Configured");
    update.mockRestore();
  });

  it("does not record telemetry for a stale Logs clear", async () => {
    const state = makePersona({ config: { thought_log_channel_disc_id: CHANNEL_ONE } as TomoriState["config"] });
    const recordAction = mock(() => undefined);
    const harness = makeHarness({ state, recordAction });
    const update = spyOn(configRepository, "updateChannelScopeConfig");
    const interaction = makeInteraction({
      route: { action: "channels-log-clear", locale: "en-US", channelId: CHANNEL_TWO },
    });

    await harness.dispatch(interaction);

    expect(update).not.toHaveBeenCalled();
    expect(recordAction).not.toHaveBeenCalled();
    update.mockRestore();
  });

  it("denies every Destinations write route to a non-manager and to a DM", async () => {
    const nonce = "nonce1234567";
    const state = makePersona({ config: { thought_log_channel_disc_id: CHANNEL_ONE } as TomoriState["config"] });
    const updateLog = spyOn(configRepository, "updateChannelScopeConfig");
    const updateWelcome = spyOn(configRepository, "updateWelcomeConfig");
    const routes: Array<{ route: ConfigPanelRoute; kind: "button" | "modal"; fields?: Record<string, string> }> = [
      {
        route: { action: "channels-log-submit", locale: "en-US", nonce },
        kind: "modal",
        fields: welcomeFields(nonce, "random", "Welcome aboard."),
      },
      { route: { action: "channels-log-clear", locale: "en-US", channelId: CHANNEL_ONE }, kind: "button" },
      {
        route: { action: "channels-welcome-submit", locale: "en-US", nonce },
        kind: "modal",
        fields: welcomeFields(nonce, "random", "Welcome aboard."),
      },
      { route: { action: "channels-welcome-clear", locale: "en-US", channelId: CHANNEL_ONE }, kind: "button" },
    ];

    for (const entry of routes) {
      const harness = makeHarness({ state, isManager: false });
      await harness.dispatch(makeInteraction({ ...entry, isManager: false }));
      const dmHarness = makeHarness({ state, inGuild: false });
      await dmHarness.dispatch(makeInteraction({ ...entry, inGuild: false }));
    }

    expect(updateLog).not.toHaveBeenCalled();
    expect(updateWelcome).not.toHaveBeenCalled();
    updateLog.mockRestore();
    updateWelcome.mockRestore();
  });

  it("keeps every declared route in the bounded custom-ID format", () => {
    const longest = buildConfigRouteId({
      action: "channels-welcome-clear",
      locale: "en-US",
      channelId: "12345678901234567890",
    });
    expect(longest.length).toBeLessThan(100);
    expect(Object.keys(CONFIG_ROUTE_CODECS)).toContain("channels-welcome-clear");
  });
});

describe("Channels Destinations panel", () => {
  it("renders both destination sections and disables every write on a stale read", () => {
    const state = makePersona({
      config: {
        thought_log_channel_disc_id: CHANNEL_ONE,
        welcome_channel_disc_id: CHANNEL_TWO,
        welcome_prompt: "Welcome aboard.",
        welcome_persona_id: 55,
      } as TomoriState["config"],
    });
    const view = makeChannelsView(state);
    const payload = buildConfigPanelPayload({
      locale: "en-US",
      actor: { workspaceKind: "guild", isManager: true },
      category: "channels",
      page: "destinations",
      personas: [state],
      selectedPersonaId: null,
      readStatus: "stale",
      channelsView: view,
    });
    const serialized = JSON.stringify(payload);

    expect(serialized).toContain("Channel Destinations");
    expect(serialized).toContain("Logs");
    expect(serialized).toContain("Welcome Messages");
    expect(serialized).toContain("Reasoning, tool activity, attribution, and diagnostics are");
    expect(serialized).toContain("Welcome aboard.");
    expect(serialized).toContain('"disabled":true');
  });

  it("renders only the Destinations heading when its view is absent", () => {
    const payload = buildConfigPanelPayload({
      locale: "en-US",
      actor: { workspaceKind: "guild", isManager: true },
      category: "channels",
      page: "destinations",
      personas: [makePersona()],
      selectedPersonaId: null,
      readStatus: "fresh",
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("### Channel Destinations");
    expect(serialized).not.toContain("Welcome Messages");
  });
});

describe("Channels Auto-Trigger routes", () => {
  it("reads only cached text channels with the shared checklist ordering", () => {
    let fetchCalled = false;
    const guild = {
      channels: {
        cache: new Map([
          ["2", { id: "2", name: "same-position-z", type: ChannelType.GuildText, rawPosition: 2, parent: null }],
          [
            "1",
            {
              id: "1",
              name: "same-position-a",
              type: ChannelType.GuildText,
              rawPosition: 2,
              parent: { rawPosition: -1 },
            },
          ],
          ["3", { id: "3", name: "voice", type: ChannelType.GuildVoice, rawPosition: 0, parent: null }],
        ]),
        fetch: async () => {
          fetchCalled = true;
          throw new Error("panel channel reads must not fetch");
        },
      },
    };

    const channels = loadCachedGuildTextChecklistChannels(guild as never);

    expect(fetchCalled).toBe(false);
    expect(channels.map((channel) => channel.id)).toEqual(["1", "2"]);
  });

  it("renders Auto-Trigger controls, five-group checkbox type 22, and bounded routes", () => {
    const state = makePersona();
    const channels = makeChecklistChannels(51);
    const view = makeChannelsView(state, channels);
    const payload = buildConfigPanelPayload({
      locale: "en-US",
      actor: { workspaceKind: "guild", isManager: true },
      category: "channels",
      page: "auto-trigger",
      personas: [state],
      selectedPersonaId: null,
      readStatus: "fresh",
      channelsView: view,
      channelsAutoTriggerRangeIndex: 1,
    });
    const modal = buildConfigAutoTriggerChannelsModal(
      "en-US",
      "nonce1234567",
      1,
      autoTriggerFingerprint(state, channels),
      channels.slice(50),
      new Set(),
    );
    const configureModal = buildConfigAutoTriggerConfigureModal(
      "en-US",
      "nonce1234567",
      autoTriggerFingerprint(state, channels),
      [state],
    );

    expect(JSON.stringify(payload)).toContain("Auto-Trigger Channels");
    expect(JSON.stringify(payload)).toContain("Manage Channels");
    expect(JSON.stringify(payload)).not.toContain("Add Channels");
    expect(JSON.stringify(payload)).toContain("Configure Channel");
    expect(JSON.stringify(payload)).toContain("Edit Threshold");
    expect(modal.components[0]?.component?.type).toBe(22);
    expect(configureModal.components[0]?.component?.type).toBe(8);
    expect(
      buildConfigRouteId({
        action: "channels-autoch-submit",
        locale: "en-US",
        start: 1,
        fp: "abcd1234",
        nonce: "nonce1234567",
      }).length,
    ).toBeLessThan(100);
  });

  it("keeps channels outside the submitted range in both directions", async () => {
    const channels = makeChecklistChannels(51);
    const rangeOneChannel = channels[0];
    const rangeTwoChannel = channels[50];
    if (!rangeOneChannel || !rangeTwoChannel) throw new Error("test channels missing");

    const firstState = makePersona({
      config: { autoch_disc_ids: [rangeOneChannel.id, rangeTwoChannel.id] } as TomoriState["config"],
    });
    const firstNonce = "nonce1234567";
    const firstUpdate = spyOn(configRepository, "updateAutoTriggerConfig").mockImplementation(async () => true);
    const firstRecordAction = mock(() => undefined);
    const firstHarness = makeHarness({
      state: firstState,
      recordAction: firstRecordAction,
      loadChannelsView: async () => {
        return makeChannelsView(firstState, channels);
      },
      checkboxValues: checkboxValues(firstNonce, [[], [], [], [], []]),
    });
    await firstHarness.dispatch(
      makeInteraction({
        route: {
          action: "channels-autoch-submit",
          locale: "en-US",
          start: 0,
          fp: autoTriggerFingerprint(firstState, channels),
          nonce: firstNonce,
        },
        kind: "modal",
      }),
    );
    expect(firstUpdate).toHaveBeenCalledWith(9, {
      autoch_disc_ids: [rangeTwoChannel.id],
      autoch_persona_overrides: [],
    });
    expect(firstRecordAction).toHaveBeenCalledWith({
      action: "server-config.workspace.auto-trigger-channels.set",
      serverId: 9,
      userDiscId: "user-1",
    });
    firstUpdate.mockRestore();

    const secondState = makePersona({
      config: { autoch_disc_ids: [rangeOneChannel.id] } as TomoriState["config"],
    });
    const secondNonce = "nonce2234567";
    const secondUpdate = spyOn(configRepository, "updateAutoTriggerConfig").mockImplementation(async () => true);
    const secondHarness = makeHarness({
      state: secondState,
      loadChannelsView: async () => makeChannelsView(secondState, channels),
      checkboxValues: checkboxValues(secondNonce, [[rangeTwoChannel.id]]),
    });
    await secondHarness.dispatch(
      makeInteraction({
        route: {
          action: "channels-autoch-submit",
          locale: "en-US",
          start: 1,
          fp: autoTriggerFingerprint(secondState, channels),
          nonce: secondNonce,
        },
        kind: "modal",
      }),
    );
    expect(secondUpdate).toHaveBeenCalledWith(9, {
      autoch_disc_ids: [rangeOneChannel.id, rangeTwoChannel.id],
      autoch_persona_overrides: [],
    });
    secondUpdate.mockRestore();
  });

  it("preserves retained persona overrides and prunes removed ones", async () => {
    const alterPersona = makePersona({ persona_id: 56, persona_nickname: "Lighthouse", is_alter: true });
    const state = makePersona({
      config: {
        autoch_disc_ids: [CHANNEL_ONE, CHANNEL_TWO],
        autoch_persona_overrides: [
          { channel_disc_id: CHANNEL_TWO, persona_id: 56 },
          { channel_disc_id: CHANNEL_ONE, persona_id: 56 },
        ],
      } as TomoriState["config"],
    });
    const nonce = "nonce3234567";
    const update = spyOn(configRepository, "updateAutoTriggerConfig").mockImplementation(async () => true);
    const harness = makeHarness({
      state,
      personas: [state, alterPersona],
      checkboxValues: checkboxValues(nonce, [[CHANNEL_ONE]]),
    });

    await harness.dispatch(
      makeInteraction({
        route: {
          action: "channels-autoch-submit",
          locale: "en-US",
          start: 0,
          fp: autoTriggerFingerprint(state, [{ id: CHANNEL_ONE }, { id: CHANNEL_TWO }]),
          nonce,
        },
        kind: "modal",
      }),
    );

    expect(update).toHaveBeenCalledWith(9, {
      autoch_disc_ids: [CHANNEL_ONE],
      autoch_persona_overrides: [{ channel_disc_id: CHANNEL_ONE, persona_id: 56 }],
    });
    update.mockRestore();
  });

  it("deletes a single-channel override when returning to main or disabling", async () => {
    const alterPersona = makePersona({ persona_id: 56, persona_nickname: "Lighthouse", is_alter: true });
    const state = makePersona({
      config: {
        autoch_disc_ids: [CHANNEL_ONE],
        autoch_persona_overrides: [{ channel_disc_id: CHANNEL_ONE, persona_id: 56 }],
      } as TomoriState["config"],
    });
    const nonce = "nonce4234567";
    const channelField = buildConfigModalFieldId(CONFIG_CHANNEL_AUTO_TRIGGER_CHANNEL_FIELD, nonce);
    const enabledField = buildConfigModalFieldId(CONFIG_CHANNEL_AUTO_TRIGGER_ENABLED_FIELD, nonce);
    const personaField = buildConfigModalFieldId(CONFIG_CHANNEL_AUTO_TRIGGER_PERSONA_FIELD, nonce);
    const update = spyOn(configRepository, "updateAutoTriggerConfig").mockImplementation(async () => true);
    const recordAction = mock(() => undefined);
    const firstHarness = makeHarness({
      state,
      personas: [state, alterPersona],
      recordAction,
      channelValues: { [channelField]: CHANNEL_ONE },
      selectValues: { [enabledField]: "true", [personaField]: "55" },
    });
    await firstHarness.dispatch(
      makeInteraction({
        route: {
          action: "channels-autoch-configure-submit",
          locale: "en-US",
          fp: autoTriggerFingerprint(state, [{ id: CHANNEL_ONE }, { id: CHANNEL_TWO }]),
          nonce,
        },
        kind: "modal",
      }),
    );
    expect(update).toHaveBeenCalledWith(9, {
      autoch_disc_ids: [CHANNEL_ONE],
      autoch_persona_overrides: [],
    });
    expect(recordAction).toHaveBeenCalledTimes(1);
    expect(recordAction).toHaveBeenCalledWith({
      action: "server-config.workspace.auto-trigger-channels.configure",
      serverId: 9,
      userDiscId: "user-1",
    });

    update.mockClear();
    const secondHarness = makeHarness({
      state,
      personas: [state, alterPersona],
      channelValues: { [channelField]: CHANNEL_ONE },
      selectValues: { [enabledField]: "false", [personaField]: "56" },
    });
    await secondHarness.dispatch(
      makeInteraction({
        route: {
          action: "channels-autoch-configure-submit",
          locale: "en-US",
          fp: autoTriggerFingerprint(state, [{ id: CHANNEL_ONE }, { id: CHANNEL_TWO }]),
          nonce,
        },
        kind: "modal",
      }),
    );
    expect(update).toHaveBeenCalledWith(9, {
      autoch_disc_ids: [],
      autoch_persona_overrides: [],
    });
    update.mockRestore();
  });

  it("accepts every threshold mode and passes the rolled target with the range", async () => {
    const random = spyOn(Math, "random").mockReturnValue(0.5);
    const calls: Array<[number, number, number, number, number]> = [];
    const setThreshold = spyOn(configRepository, "setAutoChatThreshold").mockImplementation(
      async (serverId, personaId, threshold, maxThreshold, nextTarget) => {
        calls.push([serverId, personaId, threshold, maxThreshold, nextTarget]);
        return { persona_id: personaId, autoch_counter: 0, autoch_next_target: nextTarget };
      },
    );
    const modes = [
      { current: [1, 1] as const, next: [0, 0] as const },
      { current: [0, 0] as const, next: [5, 5] as const },
      { current: [5, 5] as const, next: [2, 8] as const },
    ];

    for (const [index, mode] of modes.entries()) {
      const state = makePersona({
        config: {
          autoch_threshold: mode.current[0],
          autoch_threshold_max: mode.current[1],
        } as TomoriState["config"],
      });
      const nonce = `nonce${index + 5}234567`;
      const recordAction = mock(() => undefined);
      const harness = makeHarness({
        state,
        recordAction,
      });
      const interaction = makeInteraction({
        route: {
          action: "channels-autoch-threshold-submit",
          locale: "en-US",
          fp: autoTriggerFingerprint(state, [{ id: CHANNEL_ONE }, { id: CHANNEL_TWO }]),
          nonce,
        },
        kind: "modal",
        fields: thresholdFields(nonce, mode.next[0], mode.next[1]),
      });
      let acknowledged = false;
      setThreshold.mockImplementationOnce(async (serverId, personaId, threshold, maxThreshold, nextTarget) => {
        acknowledged = interaction.deferred || interaction.replied;
        calls.push([serverId, personaId, threshold, maxThreshold, nextTarget]);
        return { persona_id: personaId, autoch_counter: 0, autoch_next_target: nextTarget };
      });

      await harness.dispatch(interaction);

      expect(acknowledged).toBe(true);
      expect(recordAction).toHaveBeenCalledTimes(1);
      expect(recordAction).toHaveBeenCalledWith({
        action: "server-config.workspace.auto-trigger-threshold.set",
        serverId: 9,
        userDiscId: "user-1",
      });
    }

    expect(calls).toEqual([
      [9, 55, 0, 0, 0],
      [9, 55, 5, 5, 5],
      [9, 55, 2, 8, 5],
    ]);
    setThreshold.mockRestore();
    random.mockRestore();
  });

  it("rejects invalid threshold pairs without writing", async () => {
    const setThreshold = spyOn(configRepository, "setAutoChatThreshold");
    const state = makePersona({
      config: { autoch_threshold: 5, autoch_threshold_max: 5 } as TomoriState["config"],
    });
    const pairs = [
      [0, 1],
      [5, 3],
      [101, 101],
    ] as const;
    for (const [threshold, maxThreshold] of pairs) {
      const nonce = `nonce${threshold}234567`;
      const harness = makeHarness({ state });
      await harness.dispatch(
        makeInteraction({
          route: {
            action: "channels-autoch-threshold-submit",
            locale: "en-US",
            fp: autoTriggerFingerprint(state, [{ id: CHANNEL_ONE }, { id: CHANNEL_TWO }]),
            nonce,
          },
          kind: "modal",
          fields: thresholdFields(nonce, threshold, maxThreshold),
        }),
      );
    }
    expect(setThreshold).not.toHaveBeenCalled();
    setThreshold.mockRestore();
  });

  it("returns a no-op receipt without writing or telemetry for bulk and threshold submissions", async () => {
    const state = makePersona({
      config: {
        autoch_disc_ids: [CHANNEL_ONE],
        autoch_threshold: 5,
        autoch_threshold_max: 5,
      } as TomoriState["config"],
    });
    const nonce = "nonce6234567";
    const update = spyOn(configRepository, "updateAutoTriggerConfig");
    const setThreshold = spyOn(configRepository, "setAutoChatThreshold");
    const recordAction = mock(() => undefined);
    const harness = makeHarness({
      state,
      recordAction,
      checkboxValues: checkboxValues(nonce, [[CHANNEL_ONE]]),
    });
    const bulkInteraction = makeInteraction({
      route: {
        action: "channels-autoch-submit",
        locale: "en-US",
        start: 0,
        fp: autoTriggerFingerprint(state, [{ id: CHANNEL_ONE }, { id: CHANNEL_TWO }]),
        nonce,
      },
      kind: "modal",
    });
    await harness.dispatch(bulkInteraction);
    const thresholdInteraction = makeInteraction({
      route: {
        action: "channels-autoch-threshold-submit",
        locale: "en-US",
        fp: autoTriggerFingerprint(state, [{ id: CHANNEL_ONE }, { id: CHANNEL_TWO }]),
        nonce,
      },
      kind: "modal",
      fields: thresholdFields(nonce, 5, 5),
    });
    await harness.dispatch(thresholdInteraction);

    expect(update).not.toHaveBeenCalled();
    expect(setThreshold).not.toHaveBeenCalled();
    expect(recordAction).not.toHaveBeenCalled();
    expect(JSON.stringify(bulkInteraction.editedReplies)).toContain("Already Set");
    expect(JSON.stringify(thresholdInteraction.editedReplies)).toContain("Already Set");
    update.mockRestore();
    setThreshold.mockRestore();
  });

  it("rejects a stale auto-trigger submit without writing or telemetry", async () => {
    const state = makePersona({ config: { autoch_disc_ids: [CHANNEL_ONE] } as TomoriState["config"] });
    const nonce = "nonce6534567";
    const update = spyOn(configRepository, "updateAutoTriggerConfig");
    const recordAction = mock(() => undefined);
    const harness = makeHarness({
      state,
      recordAction,
      checkboxValues: checkboxValues(nonce, [[]]),
    });

    await harness.dispatch(
      makeInteraction({
        route: {
          action: "channels-autoch-submit",
          locale: "en-US",
          start: 0,
          fp: "stale123",
          nonce,
        },
        kind: "modal",
      }),
    );

    expect(update).not.toHaveBeenCalled();
    expect(recordAction).not.toHaveBeenCalled();
    update.mockRestore();
  });

  it("acknowledges each auto-trigger write and invalidates only after success", async () => {
    const state = makePersona({ config: { autoch_disc_ids: [CHANNEL_ONE] } as TomoriState["config"] });
    const invalidationEvents: string[] = [];
    const invalidate = spyOn(tomoriStateCache, "invalidateTomoriStateCache").mockImplementation(() => {
      invalidationEvents.push("invalidate");
    });
    const update = spyOn(configRepository, "updateAutoTriggerConfig").mockImplementation(async () => {
      invalidationEvents.push("write");
      expect(interaction.deferred || interaction.replied).toBe(true);
      return true;
    });
    const nonce = "nonce7234567";
    const interaction = makeInteraction({
      route: {
        action: "channels-autoch-submit",
        locale: "en-US",
        start: 0,
        fp: autoTriggerFingerprint(state, [{ id: CHANNEL_ONE }, { id: CHANNEL_TWO }]),
        nonce,
      },
      kind: "modal",
    });
    const harness = makeHarness({
      state,
      checkboxValues: checkboxValues(nonce, [[]]),
    });
    await harness.dispatch(interaction);
    expect(invalidationEvents).toEqual(["write", "invalidate"]);
    update.mockRestore();

    const configureUpdate = spyOn(configRepository, "updateAutoTriggerConfig").mockImplementation(async () => {
      expect(configureInteraction.deferred || configureInteraction.replied).toBe(true);
      return true;
    });
    const configureNonce = "nonce8234567";
    const configureInteraction = makeInteraction({
      route: {
        action: "channels-autoch-configure-submit",
        locale: "en-US",
        fp: autoTriggerFingerprint(state, [{ id: CHANNEL_ONE }, { id: CHANNEL_TWO }]),
        nonce: configureNonce,
      },
      kind: "modal",
    });
    const configureHarness = makeHarness({
      state,
      channelValues: {
        [buildConfigModalFieldId(CONFIG_CHANNEL_AUTO_TRIGGER_CHANNEL_FIELD, configureNonce)]: CHANNEL_ONE,
      },
      selectValues: {
        [buildConfigModalFieldId(CONFIG_CHANNEL_AUTO_TRIGGER_ENABLED_FIELD, configureNonce)]: "false",
        [buildConfigModalFieldId(CONFIG_CHANNEL_AUTO_TRIGGER_PERSONA_FIELD, configureNonce)]: "55",
      },
    });
    await configureHarness.dispatch(configureInteraction);
    configureUpdate.mockRestore();

    const thresholdUpdate = spyOn(configRepository, "setAutoChatThreshold").mockImplementation(async () => {
      expect(thresholdInteraction.deferred || thresholdInteraction.replied).toBe(true);
      return { persona_id: 55, autoch_counter: 0, autoch_next_target: 5 };
    });
    const thresholdNonce = "nonce9234567";
    const thresholdInteraction = makeInteraction({
      route: {
        action: "channels-autoch-threshold-submit",
        locale: "en-US",
        fp: autoTriggerFingerprint(state, [{ id: CHANNEL_ONE }, { id: CHANNEL_TWO }]),
        nonce: thresholdNonce,
      },
      kind: "modal",
      fields: thresholdFields(thresholdNonce, 5, 5),
    });
    const thresholdHarness = makeHarness({ state });
    await thresholdHarness.dispatch(thresholdInteraction);
    thresholdUpdate.mockRestore();
    invalidate.mockRestore();
  });

  it("rejects every forged auto-trigger write route for members and DMs", async () => {
    const state = makePersona();
    const update = spyOn(configRepository, "updateAutoTriggerConfig");
    const setThreshold = spyOn(configRepository, "setAutoChatThreshold");
    const routes: ConfigPanelRoute[] = [
      {
        action: "channels-autoch-submit",
        locale: "en-US",
        start: 0,
        fp: "abcd1234",
        nonce: "nonce1234567",
      },
      {
        action: "channels-autoch-configure-submit",
        locale: "en-US",
        fp: "abcd1234",
        nonce: "nonce1234567",
      },
      {
        action: "channels-autoch-threshold-submit",
        locale: "en-US",
        fp: "abcd1234",
        nonce: "nonce1234567",
      },
    ];
    for (const route of routes) {
      await makeHarness({ state, isManager: false }).dispatch(
        makeInteraction({ route, kind: "modal", isManager: false }),
      );
      await makeHarness({ state, inGuild: false }).dispatch(makeInteraction({ route, kind: "modal", inGuild: false }));
    }
    expect(update).not.toHaveBeenCalled();
    expect(setThreshold).not.toHaveBeenCalled();
    update.mockRestore();
    setThreshold.mockRestore();
  });

  it("opens Auto-Trigger modals without pre-deferring and uses the cache-only view", async () => {
    const state = makePersona();
    let acknowledgedBeforeModal = true;
    const loadChannelsView = mock(async () => makeChannelsView(state));
    const harness = makeHarness({
      state,
      loadChannelsView,
      showModal: async (interaction) => {
        acknowledgedBeforeModal = interaction.deferred || interaction.replied;
      },
    });

    await harness.dispatch(makeInteraction({ route: { action: "channels-autoch-manage-open", locale: "en-US" } }));
    await harness.dispatch(makeInteraction({ route: { action: "channels-autoch-configure-open", locale: "en-US" } }));
    await harness.dispatch(makeInteraction({ route: { action: "channels-autoch-threshold-open", locale: "en-US" } }));

    expect(acknowledgedBeforeModal).toBe(false);
    expect(loadChannelsView).toHaveBeenCalledTimes(3);
  });
});

describe("Channels Rules", () => {
  it("keeps Private and Roleplay text-only while Blocklist includes all four supported channel types", () => {
    let fetchCalled = false;
    const guild = {
      channels: {
        cache: new Map([
          ["1", { id: "1", name: "chat", type: ChannelType.GuildText, rawPosition: 1, parent: null }],
          [
            "2",
            {
              id: "2",
              name: "announcements",
              type: ChannelType.GuildAnnouncement,
              rawPosition: 2,
              parent: { name: "Public", rawPosition: 0 },
            },
          ],
          [
            "3",
            {
              id: "3",
              name: "forum",
              type: ChannelType.GuildForum,
              rawPosition: 3,
              parent: { name: "Public", rawPosition: 0 },
            },
          ],
          [
            "4",
            {
              id: "4",
              name: "media",
              type: ChannelType.GuildMedia,
              rawPosition: 4,
              parent: { name: "Public", rawPosition: 0 },
            },
          ],
          ["5", { id: "5", name: "voice", type: ChannelType.GuildVoice, rawPosition: 5, parent: null }],
        ]),
        fetch: async () => {
          fetchCalled = true;
          throw new Error("panel channel reads must not fetch");
        },
      },
    };

    const textChannels = loadCachedGuildTextChecklistChannels(guild as never);
    const blocklistChannels = loadCachedGuildBlocklistChannels(guild as never);
    const blocklistModal = buildConfigBlocklistChannelsModal(
      "en-US",
      "nonce1234567",
      0,
      "abcd1234",
      blocklistChannels,
      new Set(),
    );
    const blocklistOptions = blocklistModal.components.flatMap((component) => component.component?.options ?? []);

    expect(fetchCalled).toBe(false);
    expect(textChannels.map((channel) => channel.id)).toEqual(["1"]);
    expect(blocklistChannels.map((channel) => channel.id)).toEqual(["1", "2", "3", "4"]);
    expect(blocklistOptions.map((option) => option.label)).toEqual([
      "#chat",
      "#announcements",
      "forum [Forum]",
      "media [Media]",
    ]);
    expect(blocklistOptions.map((option) => option.description)).toContain("Category: Public");
    expect(blocklistModal.components[0]?.component?.type).toBe(22);
  });

  it("renders all three collections with None states, one Manage control, and bounded routes", () => {
    const state = makePersona();
    const view = makeChannelsView(state);
    const payload = buildConfigPanelPayload({
      locale: "en-US",
      actor: { workspaceKind: "guild", isManager: true },
      category: "channels",
      page: "rules",
      personas: [state],
      selectedPersonaId: null,
      readStatus: "fresh",
      channelsView: view,
    });
    const serialized = JSON.stringify(payload);

    expect(serialized).toContain("Channel Rules");
    expect(serialized).toContain("Private Channels");
    expect(serialized).toContain("Roleplay Channels");
    expect(serialized).toContain("Cross-Channel Blocklist");
    expect(serialized).toContain("Manage Private Channels");
    expect(serialized).toContain("Manage Roleplay Channels");
    expect(serialized).toContain("Manage Blocked Channels");
    expect(serialized).not.toContain("Add Private Channels");
    expect(serialized).toContain(
      "https://docs.tomoribot.app/features/chatting-personality/chatting-and-triggers/#roleplay-channels",
    );

    const routes: ConfigPanelRoute[] = [
      {
        action: "channels-private-submit",
        locale: "en-US",
        start: 0,
        fp: "abcd1234",
        nonce: "nonce1234567",
      },
      {
        action: "channels-rp-submit",
        locale: "en-US",
        start: 0,
        fp: "abcd1234",
        nonce: "nonce1234567",
      },
      {
        action: "channels-blocklist-submit",
        locale: "en-US",
        start: 0,
        fp: "abcd1234",
        nonce: "nonce1234567",
      },
    ];
    for (const route of routes) {
      expect(buildConfigRouteId(route).length).toBeLessThan(100);
    }
    expect(
      buildConfigPrivateChannelsModal("en-US", "nonce1234567", 0, "abcd1234", view.availableTextChannels, new Set())
        .components[0]?.component?.type,
    ).toBe(22);
    expect(
      buildConfigRoleplayChannelsModal("en-US", "nonce1234567", 0, "abcd1234", view.availableTextChannels, new Set())
        .components[0]?.component?.type,
    ).toBe(22);
  });

  it("keeps members outside the submitted range in both directions", async () => {
    const channels = makeChecklistChannels(51);
    const firstRangeChannel = channels[0];
    const secondRangeChannel = channels[50];
    if (!firstRangeChannel || !secondRangeChannel) throw new Error("test channels missing");

    const firstState = makePersona({
      config: { private_channel_ids: [firstRangeChannel.id, secondRangeChannel.id] } as TomoriState["config"],
    });
    const update = spyOn(configRepository, "updateChannelScopeConfig").mockImplementation(async () => true);
    const firstNonce = "nonce1234567";
    await makeHarness({
      state: firstState,
      loadChannelsView: async () => makeChannelsView(firstState, channels),
      checkboxValues: rulesCheckboxValues(firstNonce, CONFIG_CHANNEL_PRIVATE_CHECKBOX_PREFIX, [[], [], [], [], []]),
    }).dispatch(
      makeInteraction({
        route: {
          action: "channels-private-submit",
          locale: "en-US",
          start: 0,
          fp: channelRulesFingerprint(firstState, "private", channels),
          nonce: firstNonce,
        },
        kind: "modal",
      }),
    );
    expect(update).toHaveBeenLastCalledWith(9, { private_channel_ids: [secondRangeChannel.id] });

    const secondState = makePersona({
      config: { private_channel_ids: [firstRangeChannel.id] } as TomoriState["config"],
    });
    const secondNonce = "nonce2234567";
    await makeHarness({
      state: secondState,
      loadChannelsView: async () => makeChannelsView(secondState, channels),
      checkboxValues: rulesCheckboxValues(secondNonce, CONFIG_CHANNEL_PRIVATE_CHECKBOX_PREFIX, [
        [secondRangeChannel.id],
      ]),
    }).dispatch(
      makeInteraction({
        route: {
          action: "channels-private-submit",
          locale: "en-US",
          start: 1,
          fp: channelRulesFingerprint(secondState, "private", channels),
          nonce: secondNonce,
        },
        kind: "modal",
      }),
    );
    expect(update).toHaveBeenLastCalledWith(9, {
      private_channel_ids: [firstRangeChannel.id, secondRangeChannel.id],
    });
    update.mockRestore();
  });

  it("writes only the selected collection, acknowledges first, invalidates after success, and records telemetry", async () => {
    const updatePatches: unknown[] = [];
    const events: string[] = [];
    let currentInteraction: ReturnType<typeof makeInteraction> | undefined;
    const update = spyOn(configRepository, "updateChannelScopeConfig").mockImplementation(async (_serverId, patch) => {
      events.push("write");
      updatePatches.push(patch);
      expect(currentInteraction?.deferred || currentInteraction?.replied).toBe(true);
      return true;
    });
    const invalidate = spyOn(tomoriStateCache, "invalidateTomoriStateCache").mockImplementation(() => {
      events.push("invalidate");
    });
    const actions = [
      [
        "private",
        "private_channel_ids",
        CONFIG_CHANNEL_PRIVATE_CHECKBOX_PREFIX,
        "server-config.workspace.private-channels.set",
      ],
      ["roleplay", "rp_channel_ids", CONFIG_CHANNEL_RP_CHECKBOX_PREFIX, "server-config.workspace.rp-channels.set"],
      [
        "blocklist",
        "crosschannel_blocklist_ids",
        CONFIG_CHANNEL_BLOCKLIST_CHECKBOX_PREFIX,
        "server-config.workspace.crosschannel-blocklist.set",
      ],
    ] as const;
    const recordAction = mock(() => undefined);

    for (const [collection, column, prefix, action] of actions) {
      const state = makePersona({ config: {} as TomoriState["config"] });
      const available =
        collection === "blocklist"
          ? makeChannelsView(state).availableBlocklistChannels
          : makeChannelsView(state).availableTextChannels;
      const nonce = `nonce${collection === "private" ? "3" : collection === "roleplay" ? "4" : "5"}234567`;
      currentInteraction = makeInteraction({
        route: {
          action:
            collection === "private"
              ? "channels-private-submit"
              : collection === "roleplay"
                ? "channels-rp-submit"
                : "channels-blocklist-submit",
          locale: "en-US",
          start: 0,
          fp: channelRulesFingerprint(state, collection, available),
          nonce,
        },
        kind: "modal",
      });
      const harness = makeHarness({
        state,
        recordAction,
        checkboxValues: rulesCheckboxValues(nonce, prefix, [[CHANNEL_ONE]]),
      });
      await harness.dispatch(currentInteraction);
      expect(updatePatches.at(-1)).toEqual({ [column]: [CHANNEL_ONE] });
      expect(recordAction).toHaveBeenLastCalledWith({ action, serverId: 9, userDiscId: "user-1" });
    }

    expect(events).toEqual(["write", "invalidate", "write", "invalidate", "write", "invalidate"]);
    update.mockRestore();
    invalidate.mockRestore();
  });

  it("returns a no-op receipt with no write or telemetry for each collection", async () => {
    const update = spyOn(configRepository, "updateChannelScopeConfig");
    const recordAction = mock(() => undefined);
    const collections = [
      ["private", "private_channel_ids", CONFIG_CHANNEL_PRIVATE_CHECKBOX_PREFIX, "channels-private-submit"],
      ["roleplay", "rp_channel_ids", CONFIG_CHANNEL_RP_CHECKBOX_PREFIX, "channels-rp-submit"],
      [
        "blocklist",
        "crosschannel_blocklist_ids",
        CONFIG_CHANNEL_BLOCKLIST_CHECKBOX_PREFIX,
        "channels-blocklist-submit",
      ],
    ] as const;

    for (const [collection, column, prefix, action] of collections) {
      const state = makePersona({ config: { [column]: [CHANNEL_ONE] } as TomoriState["config"] });
      const available =
        collection === "blocklist"
          ? makeChannelsView(state).availableBlocklistChannels
          : makeChannelsView(state).availableTextChannels;
      const nonce = `nonce${collection === "private" ? "6" : collection === "roleplay" ? "7" : "8"}234567`;
      const interaction = makeInteraction({
        route: {
          action,
          locale: "en-US",
          start: 0,
          fp: channelRulesFingerprint(state, collection, available),
          nonce,
        },
        kind: "modal",
      });
      await makeHarness({
        state,
        recordAction,
        checkboxValues: rulesCheckboxValues(nonce, prefix, [[CHANNEL_ONE]]),
      }).dispatch(interaction);
      expect(JSON.stringify(interaction.editedReplies)).toContain("Already Set");
    }

    expect(update).not.toHaveBeenCalled();
    expect(recordAction).not.toHaveBeenCalled();
    update.mockRestore();
  });

  it("refuses stale fingerprints and forged member or DM write routes", async () => {
    const update = spyOn(configRepository, "updateChannelScopeConfig");
    const recordAction = mock(() => undefined);
    const state = makePersona({ config: { private_channel_ids: [CHANNEL_ONE] } as TomoriState["config"] });
    const staleRoute: ConfigPanelRoute = {
      action: "channels-private-submit",
      locale: "en-US",
      start: 0,
      fp: "stale123",
      nonce: "nonce1234567",
    };
    await makeHarness({ state, recordAction }).dispatch(makeInteraction({ route: staleRoute, kind: "modal" }));

    const routes: ConfigPanelRoute[] = [
      { action: "channels-private-submit", locale: "en-US", start: 0, fp: "abcd1234", nonce: "nonce1234567" },
      { action: "channels-rp-submit", locale: "en-US", start: 0, fp: "abcd1234", nonce: "nonce1234567" },
      { action: "channels-blocklist-submit", locale: "en-US", start: 0, fp: "abcd1234", nonce: "nonce1234567" },
    ];
    for (const route of routes) {
      await makeHarness({ state, isManager: false, recordAction }).dispatch(
        makeInteraction({ route, kind: "modal", isManager: false }),
      );
      await makeHarness({ state, inGuild: false, recordAction }).dispatch(
        makeInteraction({ route, kind: "modal", inGuild: false }),
      );
    }

    expect(update).not.toHaveBeenCalled();
    expect(recordAction).not.toHaveBeenCalled();
    update.mockRestore();
  });

  it("opens all Rules modals without pre-deferring and loads the cache-only view", async () => {
    const state = makePersona();
    const loadChannelsView = mock(async () => makeChannelsView(state));
    const acknowledgements: boolean[] = [];
    const harness = makeHarness({
      state,
      loadChannelsView,
      showModal: async (interaction) => {
        acknowledgements.push(interaction.deferred || interaction.replied);
      },
    });

    await harness.dispatch(makeInteraction({ route: { action: "channels-private-manage-open", locale: "en-US" } }));
    await harness.dispatch(makeInteraction({ route: { action: "channels-rp-manage-open", locale: "en-US" } }));
    await harness.dispatch(makeInteraction({ route: { action: "channels-blocklist-manage-open", locale: "en-US" } }));

    expect(acknowledgements).toEqual([false, false, false]);
    expect(loadChannelsView).toHaveBeenCalledTimes(3);
  });
});

describe("Channels Overrides", () => {
  it("renders a native selector for the five-channel union and headings without a selection", () => {
    const state = makePersona({ llm: makeLlm(10, "openrouter", "server-default") });
    const channels = makeOverrideChannels();
    const payload = buildConfigPanelPayload({
      locale: "en-US",
      actor: { workspaceKind: "guild", isManager: true },
      category: "channels",
      page: "overrides",
      personas: [state],
      selectedPersonaId: null,
      readStatus: "fresh",
      channelsView: makeChannelsView(state, undefined, undefined, channels),
    });
    const container = payload.components.find((component) => component.type === ComponentType.Container);
    if (!container || container.type !== ComponentType.Container) throw new Error("config container missing");
    const selectorRow = container.components.find(
      (component) =>
        component.type === ComponentType.ActionRow && component.components[0]?.type === ComponentType.ChannelSelect,
    );
    if (!selectorRow || selectorRow.type !== ComponentType.ActionRow) throw new Error("channel selector missing");
    const selector = selectorRow.components[0];
    if (!selector || selector.type !== ComponentType.ChannelSelect) throw new Error("channel selector has wrong type");

    expect(selector.type).toBe(ComponentType.ChannelSelect);
    expect(selector.channelTypes).toEqual([
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement,
      ChannelType.PublicThread,
      ChannelType.PrivateThread,
      ChannelType.AnnouncementThread,
    ]);
    expect(JSON.stringify(payload)).toContain("Channel Prompt");
    expect(JSON.stringify(payload)).toContain("Context Note");
    expect(JSON.stringify(payload)).toContain("Text Model");
    expect(JSON.stringify(payload)).not.toContain("Change Override");
  });

  it("carries a selected channel through the native selector without fetching the guild", async () => {
    const state = makePersona();
    let requestedChannelId: string | undefined;
    const loadChannelsView: ConfigRouteDependencies["loadChannelsView"] = async (_interaction, selectedChannelId) => {
      requestedChannelId = selectedChannelId;
      return makeChannelsView(state);
    };
    let fetchCalled = false;
    const interaction = makeInteraction({
      route: { action: "channels-overrides-select", locale: "en-US" },
      kind: "channel-select",
      selectedValue: CHANNEL_TWO,
      fetch: async () => {
        fetchCalled = true;
      },
    });

    await makeHarness({ state, loadChannelsView }).dispatch(interaction);

    expect(requestedChannelId).toBe(CHANNEL_TWO);
    expect(fetchCalled).toBe(false);
    expect(interaction.deferred).toBe(true);
  });

  it("accepts an announcement-thread prompt but rejects that channel for a context note", async () => {
    const state = makePersona();
    const channels = makeOverrideChannels();
    const selectedChannelId = "523456789012345678";
    const values: Partial<ConfigChannelsOverridesView> = { selectedChannelId };
    const promptSet = spyOn(channelPromptRepo, "setChannelPromptOverride").mockResolvedValue(true);
    const contextSet = spyOn(channelContextNoteRepo, "setChannelContextNote").mockResolvedValue(true);
    const nonce = "nonce1234567";
    const fp = overrideFingerprint(state, selectedChannelId, values);
    const loadChannelsView = makeOverrideLoader(state, channels, values);
    const promptInteraction = makeInteraction({
      route: { action: "channels-overrides-prompt-submit", locale: "en-US", channelId: selectedChannelId, fp, nonce },
      kind: "modal",
      fields: promptOverrideFields(nonce, ["thread prompt"]),
    });
    const promptHarness = makeHarness({
      state,
      loadChannelsView,
      selectValues: { [buildConfigModalFieldId(CONFIG_CHANNEL_OVERRIDE_MODE_FIELD, nonce)]: "append" },
    });
    await promptHarness.dispatch(promptInteraction);

    const contextInteraction = makeInteraction({
      route: {
        action: "channels-overrides-context-note-submit",
        locale: "en-US",
        channelId: selectedChannelId,
        fp,
        nonce,
      },
      kind: "modal",
      fields: contextNoteFields(nonce, "not accepted on announcement threads", 2),
    });
    await makeHarness({ state, loadChannelsView }).dispatch(contextInteraction);

    expect(promptSet).toHaveBeenCalledWith(9, selectedChannelId, "thread prompt", "append");
    expect(contextSet).not.toHaveBeenCalled();
    promptSet.mockRestore();
    contextSet.mockRestore();
  });

  it("keeps prompt and context-note writes isolated on the selected channel", async () => {
    const state = makePersona();
    const selectedChannelId = CHANNEL_ONE;
    const current = {
      selectedChannelId,
      prompt: { prompt: "old prompt", mode: "append" as const },
      contextNote: { note: "old note", depth: 3 },
    };
    const promptSet = spyOn(channelPromptRepo, "setChannelPromptOverride").mockResolvedValue(true);
    const contextSet = spyOn(channelContextNoteRepo, "setChannelContextNote").mockResolvedValue(true);
    const nonce = "nonce2234567";
    const loadChannelsView = makeOverrideLoader(state, makeOverrideChannels(), current);
    await makeHarness({
      state,
      loadChannelsView,
      selectValues: { [buildConfigModalFieldId(CONFIG_CHANNEL_OVERRIDE_MODE_FIELD, nonce)]: "replace" },
    }).dispatch(
      makeInteraction({
        route: {
          action: "channels-overrides-prompt-submit",
          locale: "en-US",
          channelId: selectedChannelId,
          fp: overrideFingerprint(state, selectedChannelId, current),
          nonce,
        },
        kind: "modal",
        fields: promptOverrideFields(nonce, ["new prompt"], "replace"),
      }),
    );
    expect(promptSet).toHaveBeenCalledTimes(1);
    expect(contextSet).not.toHaveBeenCalled();

    promptSet.mockClear();
    const contextNonce = "nonce3234567";
    await makeHarness({ state, loadChannelsView }).dispatch(
      makeInteraction({
        route: {
          action: "channels-overrides-context-note-submit",
          locale: "en-US",
          channelId: selectedChannelId,
          fp: overrideFingerprint(state, selectedChannelId, current),
          nonce: contextNonce,
        },
        kind: "modal",
        fields: contextNoteFields(contextNonce, "new note", 4),
      }),
    );
    expect(contextSet).toHaveBeenCalledTimes(1);
    expect(promptSet).not.toHaveBeenCalled();
    promptSet.mockRestore();
    contextSet.mockRestore();
  });

  it("removes an all-empty prompt submission instead of storing an empty string", async () => {
    const state = makePersona();
    const selectedChannelId = CHANNEL_ONE;
    const values: Partial<ConfigChannelsOverridesView> = {
      selectedChannelId,
      prompt: { prompt: "stored", mode: "replace" },
    };
    const remove = spyOn(channelPromptRepo, "deleteChannelPromptOverride").mockResolvedValue(true);
    const set = spyOn(channelPromptRepo, "setChannelPromptOverride").mockResolvedValue(true);
    const nonce = "nonce4234567";
    await makeHarness({
      state,
      loadChannelsView: makeOverrideLoader(state, makeOverrideChannels(), values),
      selectValues: { [buildConfigModalFieldId(CONFIG_CHANNEL_OVERRIDE_MODE_FIELD, nonce)]: "replace" },
    }).dispatch(
      makeInteraction({
        route: {
          action: "channels-overrides-prompt-submit",
          locale: "en-US",
          channelId: selectedChannelId,
          fp: overrideFingerprint(state, selectedChannelId, values),
          nonce,
        },
        kind: "modal",
        fields: promptOverrideFields(nonce, ["", "", "", ""], "replace"),
      }),
    );

    expect(remove).toHaveBeenCalledWith(9, selectedChannelId);
    expect(set).not.toHaveBeenCalled();
    remove.mockRestore();
    set.mockRestore();
  });

  it("rejects oversized context notes and depths without writing", async () => {
    const state = makePersona();
    const selectedChannelId = CHANNEL_ONE;
    const values: Partial<ConfigChannelsOverridesView> = { selectedChannelId };
    const set = spyOn(channelContextNoteRepo, "setChannelContextNote").mockResolvedValue(true);
    const remove = spyOn(channelContextNoteRepo, "deleteChannelContextNote").mockResolvedValue(true);
    const cases = [
      { nonce: "nonce5234567", note: "x".repeat(2001), depth: 1 },
      { nonce: "nonce6234567", note: "valid note", depth: 101 },
    ];
    for (const entry of cases) {
      await makeHarness({
        state,
        loadChannelsView: makeOverrideLoader(state, makeOverrideChannels(), values),
      }).dispatch(
        makeInteraction({
          route: {
            action: "channels-overrides-context-note-submit",
            locale: "en-US",
            channelId: selectedChannelId,
            fp: overrideFingerprint(state, selectedChannelId, values),
            nonce: entry.nonce,
          },
          kind: "modal",
          fields: contextNoteFields(entry.nonce, entry.note, entry.depth),
        }),
      );
    }
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    set.mockRestore();
    remove.mockRestore();
  });

  it("clears the Text override through llmId null and renders no other capability override", async () => {
    const state = makePersona({ llm: makeLlm(10, "openrouter", "server-default") });
    const selectedChannelId = CHANNEL_ONE;
    const channelModel = makeLlm(20, "openrouter", "channel-model");
    const values: Partial<ConfigChannelsOverridesView> = {
      selectedChannelId,
      textModelOverride: channelModel,
    };
    const setTextModelOverride = mock(async () => ({ status: "success" as const }));
    const operations = { ...configPersonaOperations, setTextModelOverride };
    const payload = buildConfigPanelPayload({
      locale: "en-US",
      actor: { workspaceKind: "guild", isManager: true },
      category: "channels",
      page: "overrides",
      personas: [state],
      selectedPersonaId: null,
      readStatus: "fresh",
      channelsView: makeChannelsView(state, undefined, undefined, makeOverrideChannels(), values),
      channelsSelectedChannelId: selectedChannelId,
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("Change Override");
    expect(serialized).not.toContain("Vision");
    expect(serialized).not.toContain("Embedding");
    expect(serialized).not.toContain("Image");
    expect(serialized).not.toContain("Video");

    const fp = overrideFingerprint(state, selectedChannelId, values);
    await makeHarness({
      state,
      loadChannelsView: makeOverrideLoader(state, makeOverrideChannels(), values),
      operations,
    }).dispatch(
      makeInteraction({
        route: { action: "channels-overrides-text-clear", locale: "en-US", channelId: selectedChannelId, fp },
      }),
    );

    expect(setTextModelOverride).toHaveBeenCalledWith({
      scope: "channel",
      serverId: 9,
      channelId: selectedChannelId,
      llmId: null,
      serverDiscId: "guild-1",
    });
  });

  it("refuses deleted or inaccessible channels and stale fingerprints before any write", async () => {
    const state = makePersona();
    const promptDelete = spyOn(channelPromptRepo, "deleteChannelPromptOverride").mockResolvedValue(true);
    const contextSet = spyOn(channelContextNoteRepo, "setChannelContextNote").mockResolvedValue(true);
    const values: Partial<ConfigChannelsOverridesView> = {
      selectedChannelId: CHANNEL_ONE,
      prompt: { prompt: "stored", mode: "append" },
    };
    const inaccessibleLoader = makeOverrideLoader(state, [], values);
    await makeHarness({ state, loadChannelsView: inaccessibleLoader }).dispatch(
      makeInteraction({
        route: {
          action: "channels-overrides-prompt-clear",
          locale: "en-US",
          channelId: CHANNEL_ONE,
          fp: overrideFingerprint(state, CHANNEL_ONE, values),
        },
      }),
    );
    const staleLoader = makeOverrideLoader(state, makeOverrideChannels(), values);
    const nonce = "nonce7234567";
    await makeHarness({ state, loadChannelsView: staleLoader }).dispatch(
      makeInteraction({
        route: {
          action: "channels-overrides-context-note-submit",
          locale: "en-US",
          channelId: CHANNEL_ONE,
          fp: "stale123",
          nonce,
        },
        kind: "modal",
        fields: contextNoteFields(nonce, "new note", 2),
      }),
    );

    expect(promptDelete).not.toHaveBeenCalled();
    expect(contextSet).not.toHaveBeenCalled();
    promptDelete.mockRestore();
    contextSet.mockRestore();
  });

  it("denies every override write route to forged guild members and DMs", async () => {
    const state = makePersona();
    const promptSet = spyOn(channelPromptRepo, "setChannelPromptOverride").mockResolvedValue(true);
    const promptDelete = spyOn(channelPromptRepo, "deleteChannelPromptOverride").mockResolvedValue(true);
    const contextSet = spyOn(channelContextNoteRepo, "setChannelContextNote").mockResolvedValue(true);
    const textWrite = mock(async () => ({ status: "success" as const }));
    const operations = { ...configPersonaOperations, setTextModelOverride: textWrite };
    const nonce = "nonce8234567";
    const values = { selectedChannelId: CHANNEL_ONE } satisfies Partial<ConfigChannelsOverridesView>;
    const fp = overrideFingerprint(state, CHANNEL_ONE, values);
    const routes: Array<{
      route: ConfigPanelRoute;
      kind: "button" | "modal" | "string-select";
      fields?: Record<string, string>;
    }> = [
      {
        route: { action: "channels-overrides-prompt-submit", locale: "en-US", channelId: CHANNEL_ONE, fp, nonce },
        kind: "modal",
        fields: promptOverrideFields(nonce, ["new prompt"]),
      },
      {
        route: { action: "channels-overrides-prompt-clear", locale: "en-US", channelId: CHANNEL_ONE, fp },
        kind: "button",
      },
      {
        route: { action: "channels-overrides-context-note-submit", locale: "en-US", channelId: CHANNEL_ONE, fp, nonce },
        kind: "modal",
        fields: contextNoteFields(nonce, "new note", 2),
      },
      {
        route: {
          action: "channels-overrides-text-model-select",
          locale: "en-US",
          channelId: CHANNEL_ONE,
          provider: "openrouter",
          fp,
        },
        kind: "string-select",
        selectedValue: "new-model",
      },
      {
        route: { action: "channels-overrides-text-clear", locale: "en-US", channelId: CHANNEL_ONE, fp },
        kind: "button",
      },
    ];
    for (const entry of routes) {
      await makeHarness({ state, isManager: false, operations }).dispatch(
        makeInteraction({ ...entry, isManager: false }),
      );
      await makeHarness({ state, inGuild: false, operations }).dispatch(makeInteraction({ ...entry, inGuild: false }));
    }

    expect(promptSet).not.toHaveBeenCalled();
    expect(promptDelete).not.toHaveBeenCalled();
    expect(contextSet).not.toHaveBeenCalled();
    expect(textWrite).not.toHaveBeenCalled();
    promptSet.mockRestore();
    promptDelete.mockRestore();
    contextSet.mockRestore();
  });

  it("acknowledges every override database write before entering its mock", async () => {
    const state = makePersona({ llm: makeLlm(10, "openrouter", "server-default") });
    const selectedChannelId = CHANNEL_ONE;
    const promptValues = { selectedChannelId } satisfies Partial<ConfigChannelsOverridesView>;
    const promptNonce = "nonce9234567";
    const promptInteraction = makeInteraction({
      route: {
        action: "channels-overrides-prompt-submit",
        locale: "en-US",
        channelId: selectedChannelId,
        fp: overrideFingerprint(state, selectedChannelId, promptValues),
        nonce: promptNonce,
      },
      kind: "modal",
      fields: promptOverrideFields(promptNonce, ["prompt"]),
    });
    let promptAcknowledged = false;
    const promptSet = spyOn(channelPromptRepo, "setChannelPromptOverride").mockImplementation(async () => {
      promptAcknowledged = promptInteraction.deferred || promptInteraction.replied;
      return true;
    });
    await makeHarness({
      state,
      loadChannelsView: makeOverrideLoader(state, makeOverrideChannels(), promptValues),
      selectValues: { [buildConfigModalFieldId(CONFIG_CHANNEL_OVERRIDE_MODE_FIELD, promptNonce)]: "append" },
    }).dispatch(promptInteraction);

    const contextValues = { selectedChannelId } satisfies Partial<ConfigChannelsOverridesView>;
    const contextNonce = "nonce0334567";
    const contextInteraction = makeInteraction({
      route: {
        action: "channels-overrides-context-note-submit",
        locale: "en-US",
        channelId: selectedChannelId,
        fp: overrideFingerprint(state, selectedChannelId, contextValues),
        nonce: contextNonce,
      },
      kind: "modal",
      fields: contextNoteFields(contextNonce, "note", 1),
    });
    let contextAcknowledged = false;
    const contextSet = spyOn(channelContextNoteRepo, "setChannelContextNote").mockImplementation(async () => {
      contextAcknowledged = contextInteraction.deferred || contextInteraction.replied;
      return true;
    });
    await makeHarness({
      state,
      loadChannelsView: makeOverrideLoader(state, makeOverrideChannels(), contextValues),
    }).dispatch(contextInteraction);

    const textValues = { selectedChannelId } satisfies Partial<ConfigChannelsOverridesView>;
    const textModel = makeLlm(20, "openrouter", "new-model");
    const textInteraction = makeInteraction({
      route: {
        action: "channels-overrides-text-model-select",
        locale: "en-US",
        channelId: selectedChannelId,
        provider: "openrouter",
        fp: overrideFingerprint(state, selectedChannelId, textValues),
      },
      kind: "string-select",
      selectedValue: textModel.llm_codename,
    });
    let textAcknowledged = false;
    const textWrite = mock(async () => {
      textAcknowledged = textInteraction.deferred || textInteraction.replied;
      return { status: "success" as const };
    });
    await makeHarness({
      state,
      loadChannelsView: makeOverrideLoader(state, makeOverrideChannels(), textValues),
      loadSavedTextProviders: async () => [{ provider: "openrouter" }],
      loadPersonaTextModels: async () => [textModel],
      operations: { ...configPersonaOperations, setTextModelOverride: textWrite },
    }).dispatch(textInteraction);

    expect(promptAcknowledged).toBe(true);
    expect(contextAcknowledged).toBe(true);
    expect(textAcknowledged).toBe(true);
    promptSet.mockRestore();
    contextSet.mockRestore();
  });

  it("opens override modals without pre-deferring", async () => {
    const state = makePersona();
    const values = { selectedChannelId: CHANNEL_ONE } satisfies Partial<ConfigChannelsOverridesView>;
    const acknowledgements: boolean[] = [];
    const harness = makeHarness({
      state,
      loadChannelsView: makeOverrideLoader(state, makeOverrideChannels(), values),
      showModal: async (interaction) => {
        acknowledgements.push(interaction.deferred || interaction.replied);
      },
    });
    await harness.dispatch(
      makeInteraction({ route: { action: "channels-overrides-prompt-open", locale: "en-US", channelId: CHANNEL_ONE } }),
    );
    await harness.dispatch(
      makeInteraction({
        route: { action: "channels-overrides-context-note-open", locale: "en-US", channelId: CHANNEL_ONE },
      }),
    );
    expect(acknowledgements).toEqual([false, false]);
  });

  it("returns no-op receipts without writes or telemetry for every override write", async () => {
    const state = makePersona({ llm: makeLlm(10, "openrouter", "server-default") });
    const channelModel = makeLlm(20, "openrouter", "channel-model");
    const recordAction = mock(() => undefined);
    const setPrompt = spyOn(channelPromptRepo, "setChannelPromptOverride");
    const deletePrompt = spyOn(channelPromptRepo, "deleteChannelPromptOverride");
    const setContext = spyOn(channelContextNoteRepo, "setChannelContextNote");
    const deleteContext = spyOn(channelContextNoteRepo, "deleteChannelContextNote");
    const textWrite = mock(async () => ({ status: "success" as const }));
    const values: Partial<ConfigChannelsOverridesView> = {
      selectedChannelId: CHANNEL_ONE,
      prompt: { prompt: "stored", mode: "append" },
      contextNote: { note: "stored note", depth: 2 },
      textModelOverride: channelModel,
    };
    const loader = makeOverrideLoader(state, makeOverrideChannels(), values);
    const promptNonce = "nonce1334567";
    await makeHarness({
      state,
      recordAction,
      loadChannelsView: loader,
      selectValues: { [buildConfigModalFieldId(CONFIG_CHANNEL_OVERRIDE_MODE_FIELD, promptNonce)]: "append" },
    }).dispatch(
      makeInteraction({
        route: {
          action: "channels-overrides-prompt-submit",
          locale: "en-US",
          channelId: CHANNEL_ONE,
          fp: overrideFingerprint(state, CHANNEL_ONE, values),
          nonce: promptNonce,
        },
        kind: "modal",
        fields: promptOverrideFields(promptNonce, ["stored"]),
      }),
    );
    await makeHarness({
      state,
      recordAction,
      loadChannelsView: makeOverrideLoader(state, makeOverrideChannels(), {}),
    }).dispatch(
      makeInteraction({
        route: {
          action: "channels-overrides-prompt-clear",
          locale: "en-US",
          channelId: CHANNEL_ONE,
          fp: overrideFingerprint(state, CHANNEL_ONE, {}),
        },
      }),
    );
    const contextNonce = "nonce1434567";
    await makeHarness({
      state,
      recordAction,
      loadChannelsView: loader,
    }).dispatch(
      makeInteraction({
        route: {
          action: "channels-overrides-context-note-submit",
          locale: "en-US",
          channelId: CHANNEL_ONE,
          fp: overrideFingerprint(state, CHANNEL_ONE, values),
          nonce: contextNonce,
        },
        kind: "modal",
        fields: contextNoteFields(contextNonce, "stored note", 2),
      }),
    );
    await makeHarness({
      state,
      recordAction,
      loadChannelsView: makeOverrideLoader(state, makeOverrideChannels(), {}),
    }).dispatch(
      makeInteraction({
        route: {
          action: "channels-overrides-context-note-submit",
          locale: "en-US",
          channelId: CHANNEL_ONE,
          fp: overrideFingerprint(state, CHANNEL_ONE, {}),
          nonce: contextNonce,
        },
        kind: "modal",
        fields: contextNoteFields(contextNonce, "", 0),
      }),
    );
    const textModel = makeLlm(20, "openrouter", "channel-model");
    await makeHarness({
      state,
      recordAction,
      loadChannelsView: loader,
      loadSavedTextProviders: async () => [{ provider: "openrouter" }],
      loadPersonaTextModels: async () => [textModel],
      operations: { ...configPersonaOperations, setTextModelOverride: textWrite },
    }).dispatch(
      makeInteraction({
        route: {
          action: "channels-overrides-text-model-select",
          locale: "en-US",
          channelId: CHANNEL_ONE,
          provider: "openrouter",
          fp: overrideFingerprint(state, CHANNEL_ONE, values),
        },
        kind: "string-select",
        selectedValue: "channel-model",
      }),
    );
    await makeHarness({
      state,
      recordAction,
      loadChannelsView: makeOverrideLoader(state, makeOverrideChannels(), {}),
      operations: { ...configPersonaOperations, setTextModelOverride: textWrite },
    }).dispatch(
      makeInteraction({
        route: {
          action: "channels-overrides-text-clear",
          locale: "en-US",
          channelId: CHANNEL_ONE,
          fp: overrideFingerprint(state, CHANNEL_ONE, {}),
        },
      }),
    );

    expect(setPrompt).not.toHaveBeenCalled();
    expect(deletePrompt).not.toHaveBeenCalled();
    expect(setContext).not.toHaveBeenCalled();
    expect(deleteContext).not.toHaveBeenCalled();
    expect(textWrite).not.toHaveBeenCalled();
    expect(recordAction).not.toHaveBeenCalled();
    setPrompt.mockRestore();
    deletePrompt.mockRestore();
    setContext.mockRestore();
    deleteContext.mockRestore();
  });

  it("records each successful override write once", async () => {
    const state = makePersona({ llm: makeLlm(10, "openrouter", "server-default") });
    const channelModel = makeLlm(20, "openrouter", "channel-model");
    const recordAction = mock(() => undefined);
    const values: Partial<ConfigChannelsOverridesView> = {
      selectedChannelId: CHANNEL_ONE,
      prompt: { prompt: "stored", mode: "append" },
      contextNote: { note: "stored note", depth: 2 },
      textModelOverride: channelModel,
    };
    const promptSet = spyOn(channelPromptRepo, "setChannelPromptOverride").mockResolvedValue(true);
    const promptDelete = spyOn(channelPromptRepo, "deleteChannelPromptOverride").mockResolvedValue(true);
    const contextSet = spyOn(channelContextNoteRepo, "setChannelContextNote").mockResolvedValue(true);
    const contextDelete = spyOn(channelContextNoteRepo, "deleteChannelContextNote").mockResolvedValue(true);
    const textWrite = mock(async () => ({ status: "success" as const }));
    const loader = makeOverrideLoader(state, makeOverrideChannels(), values);
    const promptNonce = "nonce1534567";
    await makeHarness({
      state,
      recordAction,
      loadChannelsView: loader,
      selectValues: { [buildConfigModalFieldId(CONFIG_CHANNEL_OVERRIDE_MODE_FIELD, promptNonce)]: "replace" },
    }).dispatch(
      makeInteraction({
        route: {
          action: "channels-overrides-prompt-submit",
          locale: "en-US",
          channelId: CHANNEL_ONE,
          fp: overrideFingerprint(state, CHANNEL_ONE, values),
          nonce: promptNonce,
        },
        kind: "modal",
        fields: promptOverrideFields(promptNonce, ["new prompt"], "replace"),
      }),
    );
    await makeHarness({ state, recordAction, loadChannelsView: loader }).dispatch(
      makeInteraction({
        route: {
          action: "channels-overrides-prompt-clear",
          locale: "en-US",
          channelId: CHANNEL_ONE,
          fp: overrideFingerprint(state, CHANNEL_ONE, values),
        },
      }),
    );
    const contextNonce = "nonce1634567";
    await makeHarness({ state, recordAction, loadChannelsView: loader }).dispatch(
      makeInteraction({
        route: {
          action: "channels-overrides-context-note-submit",
          locale: "en-US",
          channelId: CHANNEL_ONE,
          fp: overrideFingerprint(state, CHANNEL_ONE, values),
          nonce: contextNonce,
        },
        kind: "modal",
        fields: contextNoteFields(contextNonce, "new note", 4),
      }),
    );
    await makeHarness({ state, recordAction, loadChannelsView: loader }).dispatch(
      makeInteraction({
        route: {
          action: "channels-overrides-context-note-submit",
          locale: "en-US",
          channelId: CHANNEL_ONE,
          fp: overrideFingerprint(state, CHANNEL_ONE, values),
          nonce: contextNonce,
        },
        kind: "modal",
        fields: contextNoteFields(contextNonce, "", 0),
      }),
    );
    await makeHarness({
      state,
      recordAction,
      loadChannelsView: loader,
      loadSavedTextProviders: async () => [{ provider: "openrouter" }],
      loadPersonaTextModels: async () => [makeLlm(30, "openrouter", "new-channel-model")],
      operations: { ...configPersonaOperations, setTextModelOverride: textWrite },
    }).dispatch(
      makeInteraction({
        route: {
          action: "channels-overrides-text-model-select",
          locale: "en-US",
          channelId: CHANNEL_ONE,
          provider: "openrouter",
          fp: overrideFingerprint(state, CHANNEL_ONE, values),
        },
        kind: "string-select",
        selectedValue: "new-channel-model",
      }),
    );
    await makeHarness({
      state,
      recordAction,
      loadChannelsView: loader,
      operations: { ...configPersonaOperations, setTextModelOverride: textWrite },
    }).dispatch(
      makeInteraction({
        route: {
          action: "channels-overrides-text-clear",
          locale: "en-US",
          channelId: CHANNEL_ONE,
          fp: overrideFingerprint(state, CHANNEL_ONE, values),
        },
      }),
    );

    expect(recordAction.mock.calls.map(([entry]) => entry.action)).toEqual([
      "server-config.workspace.channel-prompt.set",
      "server-config.workspace.channel-prompt.clear",
      "server-config.workspace.channel-context-note.set",
      "server-config.workspace.channel-context-note.clear",
      "server-config.workspace.channel-text-model.set",
      "server-config.workspace.channel-text-model.clear",
    ]);
    expect(promptSet).toHaveBeenCalledTimes(1);
    expect(promptDelete).toHaveBeenCalledTimes(1);
    expect(contextSet).toHaveBeenCalledTimes(1);
    expect(contextDelete).toHaveBeenCalledTimes(1);
    expect(textWrite).toHaveBeenCalledTimes(2);
    promptSet.mockRestore();
    promptDelete.mockRestore();
    contextSet.mockRestore();
    contextDelete.mockRestore();
  });
});
