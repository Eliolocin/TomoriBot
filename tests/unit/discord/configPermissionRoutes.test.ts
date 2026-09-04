import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import { PermissionsBitField, type Client } from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import * as tomoriStateCache from "@/utils/cache/tomoriStateCache";
import * as crypto from "@/utils/security/crypto";
import { configRepository } from "@/utils/db/repositories";
import {
  buildCapabilitiesManageConfigWritePlan,
  getCapabilitiesManagePermissionDefinitions,
} from "@/utils/discord/manageConfigMapping";
import { buildConfigRouteId } from "@/utils/discord/configPanelCatalog";
import { createConfigInteractionRoute } from "@/utils/discord/interactions/configRoutes";
import type {
  ConfigPermissionsView,
  ConfigRouteDependencies,
  ConfigScope,
} from "@/utils/discord/interactions/configRouteContext";
import { InteractionRouteRegistry } from "@/utils/discord/interactions/routeRegistry";
import {
  CONFIG_PERMISSIONS_CHECKBOX_GROUP_PREFIX,
  CONFIG_PERMISSIONS_CHECKBOX_GROUP_SIZE,
  buildConfigPermissionsManageModal,
} from "@/utils/discord/ui/configBehaviorModals";
import { buildConfigModalFieldId } from "@/utils/discord/ui/configModals";
import { buildConfigPanelPayload } from "@/utils/discord/ui/configPanel";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const CLIENT = {} as Client;

function makeState(overrides: Record<string, unknown> = {}): TomoriState {
  return {
    server_id: 9,
    persona_id: 55,
    persona_nickname: "Sparrow",
    is_alter: false,
    trigger_words: [],
    naming_config: { prefixes: {}, suffixes: {}, addressTerms: {} },
    config: {
      tool_use_enabled: false,
      self_teaching_enabled: true,
      personal_memories_enabled: true,
      user_info_updates_enabled: true,
      emoji_usage_enabled: true,
      sticker_usage_enabled: true,
      web_search_enabled: true,
      manage_message_enabled: true,
      thread_creation_enabled: true,
      imagegen_enabled: true,
      videogen_enabled: true,
      voice_message_enabled: true,
      user_blocking_enabled: true,
      short_term_memory_enabled: true,
      time_awareness_enabled: true,
      stm_privacy_bypass: false,
      ...overrides,
    },
  } as unknown as TomoriState;
}

function buildPermissionsView(state: TomoriState, includeElevenLabs: boolean): ConfigPermissionsView {
  const definitions = getCapabilitiesManagePermissionDefinitions({ includeElevenLabs });
  return {
    capabilities: {
      toolUseEnabled: state.config.tool_use_enabled ?? true,
      includeElevenLabs,
      definitionStates: Object.fromEntries(
        definitions.map((definition) => [definition.value, definition.getState(state.config)]),
      ),
    },
    privacy: { stmPrivacyBypass: state.config.stm_privacy_bypass ?? false },
  };
}

interface HarnessOptions {
  state?: TomoriState;
  includeElevenLabs?: boolean;
  inGuild?: boolean;
  isManager?: boolean;
  checkboxValues?: Map<string, string[] | undefined>;
}

interface Harness {
  state: TomoriState;
  includeElevenLabs: boolean;
  dependencies: Partial<ConfigRouteDependencies>;
  edits: unknown[];
  modals: unknown[];
  telemetry: string[];
  checkboxReads: string[];
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const state = options.state ?? makeState();
  const includeElevenLabs = options.includeElevenLabs ?? true;
  const inGuild = options.inGuild ?? true;
  const scope: ConfigScope = {
    serverDiscId: inGuild ? "guild-1" : "user-1",
    guildId: inGuild ? "guild-1" : null,
    internalServerId: 9,
    userId: 1,
    actor: { workspaceKind: inGuild ? "guild" : "dm", isManager: inGuild ? (options.isManager ?? true) : true },
    personas: [state],
    readStatus: "fresh",
  };
  const edits: unknown[] = [];
  const modals: unknown[] = [];
  const telemetry: string[] = [];
  const checkboxReads: string[] = [];
  const checkboxValues = options.checkboxValues ?? new Map<string, string[] | undefined>();

  return {
    state,
    includeElevenLabs,
    edits,
    modals,
    telemetry,
    checkboxReads,
    dependencies: {
      resolveScope: async () => scope,
      getPersonaAvatarData: async () => ({ url: null, files: [] }),
      loadPermissionsView: async (current) => buildPermissionsView(current, includeElevenLabs),
      showModal: async (_interaction, payload) => {
        modals.push(payload);
      },
      takeFileUpload: () => undefined,
      takeAvatarUpload: () => undefined,
      takeCheckboxValues: (_interactionId, fieldId) => {
        checkboxReads.push(fieldId);
        return checkboxValues.get(fieldId);
      },
      takeSelectValue: () => undefined,
      recordAction: ({ action }) => {
        telemetry.push(action);
      },
    },
  };
}

function makeInteraction(
  customId: string,
  harness: Harness,
  options: {
    kind?: "button" | "modal";
    inGuild?: boolean;
    isManager?: boolean;
  } = {},
) {
  let deferred = false;
  let replied = false;
  const kind = options.kind ?? "button";
  const inGuild = options.inGuild ?? true;
  return {
    id: "interaction-1",
    customId,
    user: { id: "user-1", username: "Sparrow" },
    channelId: "channel-1",
    channel: { name: "lounge" },
    guildId: inGuild ? "guild-1" : null,
    guild: inGuild ? { id: "guild-1" } : null,
    client: { user: null },
    memberPermissions: {
      has: (flag: bigint) => (options.isManager ?? true) && flag === PermissionsBitField.Flags.ManageGuild,
    },
    values: [],
    isButton: () => kind === "button",
    isStringSelectMenu: () => false,
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
      harness.edits.push(payload);
      return payload;
    },
    reply: async (payload: unknown) => {
      replied = true;
      harness.edits.push(payload);
      return payload;
    },
    followUp: async (payload: unknown) => payload,
    fields: {
      fields: new Map(),
      getTextInputValue: () => "",
    },
  } as unknown as Parameters<ReturnType<typeof createConfigInteractionRoute>["execute"]>[1] & {
    deferred: boolean;
  };
}

async function dispatch(harness: Harness, interaction: ReturnType<typeof makeInteraction>): Promise<void> {
  const registry = new InteractionRouteRegistry([createConfigInteractionRoute(harness.dependencies)]);
  await registry.dispatch(CLIENT, interaction);
}

function allDefinitionValues(includeElevenLabs = true): string[] {
  return getCapabilitiesManagePermissionDefinitions({ includeElevenLabs }).map((definition) => definition.value);
}

function checkboxValuesFor(
  nonce: string,
  includeElevenLabs: boolean,
  selectedValues: readonly string[],
): Map<string, string[]> {
  const definitions = getCapabilitiesManagePermissionDefinitions({ includeElevenLabs });
  const selected = new Set(selectedValues);
  const values = new Map<string, string[]>();
  for (
    let groupIndex = 0;
    groupIndex < Math.ceil(definitions.length / CONFIG_PERMISSIONS_CHECKBOX_GROUP_SIZE);
    groupIndex += 1
  ) {
    const group = definitions.slice(
      groupIndex * CONFIG_PERMISSIONS_CHECKBOX_GROUP_SIZE,
      (groupIndex + 1) * CONFIG_PERMISSIONS_CHECKBOX_GROUP_SIZE,
    );
    values.set(
      buildConfigModalFieldId(`${CONFIG_PERMISSIONS_CHECKBOX_GROUP_PREFIX}_${groupIndex}`, nonce),
      group.filter((definition) => selected.has(definition.value)).map((definition) => definition.value),
    );
  }
  return values;
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

describe("permissions mapping and modal", () => {
  it("uses every presented definition and preserves the two-table partition", () => {
    const definitions = getCapabilitiesManagePermissionDefinitions();
    expect(definitions).toHaveLength(14);
    expect(definitions.map((definition) => [definition.value, definition.table, definition.dbColumn])).toEqual([
      ["selfteaching", "memberPermissions", "self_teaching_enabled"],
      ["personalization", "memberPermissions", "personal_memories_enabled"],
      ["userinfo", "capabilities", "user_info_updates_enabled"],
      ["emojiusage", "capabilities", "emoji_usage_enabled"],
      ["stickerusage", "capabilities", "sticker_usage_enabled"],
      ["websearch", "capabilities", "web_search_enabled"],
      ["managemessage", "capabilities", "manage_message_enabled"],
      ["threadcreation", "capabilities", "thread_creation_enabled"],
      ["imagegen", "capabilities", "imagegen_enabled"],
      ["videogen", "capabilities", "videogen_enabled"],
      ["voicemessage", "capabilities", "voice_message_enabled"],
      ["userblocking", "capabilities", "user_blocking_enabled"],
      ["shorttermmemory", "capabilities", "short_term_memory_enabled"],
      ["timeawareness", "capabilities", "time_awareness_enabled"],
    ]);

    const state = makeState();
    const selected = new Set(allDefinitionValues());
    selected.delete("selfteaching");
    selected.delete("userinfo");
    const plan = buildCapabilitiesManageConfigWritePlan(state.config, selected);
    expect(plan.changes).toHaveLength(2);
    expect(plan.patch.memberPermissions).toEqual({ self_teaching_enabled: false });
    expect(plan.patch.capabilities).toEqual({ user_info_updates_enabled: false });

    const noOp = buildCapabilitiesManageConfigWritePlan(state.config, allDefinitionValues());
    expect(noOp.changes).toEqual([]);
    expect(noOp.patch).toEqual({ capabilities: {}, memberPermissions: {} });

    const withoutElevenLabs = getCapabilitiesManagePermissionDefinitions({ includeElevenLabs: false });
    expect(withoutElevenLabs).toHaveLength(13);
    expect(withoutElevenLabs.some((definition) => definition.value === "voicemessage")).toBe(false);
  });

  it("builds two literal CheckboxGroup components and pins the presented key state", () => {
    const modal = buildConfigPermissionsManageModal("en-US", "nonce1234567", true, makeState().config);
    expect(modal.components).toHaveLength(2);
    expect((modal.components[0] as { component: { type: number } }).component.type).toBe(22);
    expect((modal.components[1] as { component: { type: number } }).component.type).toBe(22);
    expect(modal.custom_id).toBe(
      buildConfigRouteId({
        action: "permissions-manage-submit",
        locale: "en-US",
        includeElevenLabs: true,
        nonce: "nonce1234567",
      }),
    );
  });
});

describe("permissions routes", () => {
  it("opens the manage modal without pre-deferring and filters Voice Message", async () => {
    const key = spyOn(crypto, "hasOptApiKey").mockResolvedValue(false);
    try {
      const harness = makeHarness({ includeElevenLabs: false });
      const interaction = makeInteraction(
        buildConfigRouteId({ action: "permissions-manage-open", locale: "en-US" }),
        harness,
      );
      await dispatch(harness, interaction);

      expect(interaction.deferred).toBe(false);
      expect(harness.modals).toHaveLength(1);
      const modal = harness.modals[0] as { components: Array<{ component: { type: number; options: unknown[] } }> };
      expect(modal.components.map((component) => component.component.type)).toEqual([22, 22]);
      expect(modal.components.reduce((count, component) => count + component.component.options.length, 0)).toBe(13);
    } finally {
      key.mockRestore();
    }
  });

  it("acknowledges before Tool Use writes and invalidates only after success", async () => {
    const events: string[] = [];
    const update = spyOn(configRepository, "updateCapabilitiesConfig").mockImplementation(async (_serverId, patch) => {
      events.push(`write:${String(patch.tool_use_enabled)}`);
      return true;
    });
    const invalidate = spyOn(tomoriStateCache, "invalidateTomoriStateCache").mockImplementation((serverDiscId) => {
      events.push(`invalidate:${serverDiscId}`);
    });
    try {
      const harness = makeHarness({ state: makeState({ tool_use_enabled: false }) });
      const interaction = makeInteraction(
        buildConfigRouteId({ action: "permissions-tool-use-set", locale: "en-US", enabled: true }),
        harness,
      );
      let acknowledged = false;
      update.mockImplementation(async (_serverId, patch) => {
        acknowledged = interaction.deferred || interaction.replied;
        events.push(`write:${String(patch.tool_use_enabled)}`);
        return true;
      });

      await dispatch(harness, interaction);

      expect(acknowledged).toBe(true);
      expect(events).toEqual(["write:true", "invalidate:guild-1"]);
      expect(harness.telemetry).toEqual(["server-config.workspace.tool-use.set"]);
    } finally {
      update.mockRestore();
      invalidate.mockRestore();
    }
  });

  it("does not write or invalidate a no-op state press", async () => {
    const update = spyOn(configRepository, "updateCapabilitiesConfig").mockResolvedValue(true);
    const invalidate = spyOn(tomoriStateCache, "invalidateTomoriStateCache").mockImplementation(() => undefined);
    try {
      const harness = makeHarness({ state: makeState({ tool_use_enabled: true }) });
      const interaction = makeInteraction(
        buildConfigRouteId({ action: "permissions-tool-use-set", locale: "en-US", enabled: true }),
        harness,
      );
      await dispatch(harness, interaction);

      expect(update).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
      expect(harness.telemetry).toEqual([]);
      expect(harness.edits).toHaveLength(1);
    } finally {
      update.mockRestore();
      invalidate.mockRestore();
    }
  });

  it("keeps the manage write acknowledged, partitioned, and invalidated", async () => {
    const events: string[] = [];
    const update = spyOn(configRepository, "updateCapabilitiesAndMemberPermissionsConfig").mockResolvedValue(true);
    const invalidate = spyOn(tomoriStateCache, "invalidateTomoriStateCache").mockImplementation(() => {
      events.push("invalidate");
    });
    const key = spyOn(crypto, "hasOptApiKey").mockResolvedValue(true);
    try {
      const state = makeState();
      const selectedValues = allDefinitionValues().filter((value) => value !== "selfteaching" && value !== "userinfo");
      const harness = makeHarness({
        state,
        includeElevenLabs: true,
        checkboxValues: checkboxValuesFor("nonce1234567", true, selectedValues),
      });
      const interaction = makeInteraction(
        buildConfigRouteId({
          action: "permissions-manage-submit",
          locale: "en-US",
          includeElevenLabs: true,
          nonce: "nonce1234567",
        }),
        harness,
        { kind: "modal" },
      );
      let acknowledged = false;
      update.mockImplementation(async (_serverId, patch) => {
        acknowledged = interaction.deferred || interaction.replied;
        events.push("write");
        expect(patch).toEqual({
          memberPermissions: { self_teaching_enabled: false },
          capabilities: { user_info_updates_enabled: false },
        });
        return true;
      });

      await dispatch(harness, interaction);

      expect(acknowledged).toBe(true);
      expect(events).toEqual(["write", "invalidate"]);
      expect(update).toHaveBeenCalledTimes(1);
      expect(invalidate).toHaveBeenCalledTimes(1);
      expect(harness.telemetry).toEqual(["server-config.workspace.capabilities.set"]);
    } finally {
      update.mockRestore();
      invalidate.mockRestore();
      key.mockRestore();
    }
  });

  it("does not write or invalidate when the manage selection preserves every state", async () => {
    const update = spyOn(configRepository, "updateCapabilitiesAndMemberPermissionsConfig").mockResolvedValue(true);
    const invalidate = spyOn(tomoriStateCache, "invalidateTomoriStateCache").mockImplementation(() => undefined);
    const key = spyOn(crypto, "hasOptApiKey").mockResolvedValue(true);
    try {
      const harness = makeHarness({
        state: makeState(),
        includeElevenLabs: true,
        checkboxValues: checkboxValuesFor("nonce1234567", true, allDefinitionValues()),
      });
      const interaction = makeInteraction(
        buildConfigRouteId({
          action: "permissions-manage-submit",
          locale: "en-US",
          includeElevenLabs: true,
          nonce: "nonce1234567",
        }),
        harness,
        { kind: "modal" },
      );

      await dispatch(harness, interaction);

      expect(update).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
      expect(harness.telemetry).toEqual([]);
      expect(harness.edits).toHaveLength(1);
    } finally {
      update.mockRestore();
      invalidate.mockRestore();
      key.mockRestore();
    }
  });

  it("treats an empty selection as valid while a missing group is stale", async () => {
    const update = spyOn(configRepository, "updateCapabilitiesAndMemberPermissionsConfig").mockResolvedValue(true);
    const key = spyOn(crypto, "hasOptApiKey").mockResolvedValue(true);
    try {
      const emptyHarness = makeHarness({
        checkboxValues: checkboxValuesFor("nonce1234567", true, []),
      });
      const emptyInteraction = makeInteraction(
        buildConfigRouteId({
          action: "permissions-manage-submit",
          locale: "en-US",
          includeElevenLabs: true,
          nonce: "nonce1234567",
        }),
        emptyHarness,
        { kind: "modal" },
      );
      await dispatch(emptyHarness, emptyInteraction);
      expect(update).toHaveBeenCalledTimes(1);

      update.mockClear();
      const staleHarness = makeHarness({
        checkboxValues: new Map([
          [buildConfigModalFieldId(`${CONFIG_PERMISSIONS_CHECKBOX_GROUP_PREFIX}_0`, "nonce1234567"), []],
        ]),
      });
      const staleInteraction = makeInteraction(
        buildConfigRouteId({
          action: "permissions-manage-submit",
          locale: "en-US",
          includeElevenLabs: true,
          nonce: "nonce1234567",
        }),
        staleHarness,
        { kind: "modal" },
      );
      await dispatch(staleHarness, staleInteraction);
      expect(update).not.toHaveBeenCalled();
      expect(staleHarness.edits).toHaveLength(1);
    } finally {
      update.mockRestore();
      key.mockRestore();
    }
  });

  it("rejects presented-set drift before writing", async () => {
    const update = spyOn(configRepository, "updateCapabilitiesAndMemberPermissionsConfig").mockResolvedValue(true);
    const key = spyOn(crypto, "hasOptApiKey").mockResolvedValue(false);
    try {
      const harness = makeHarness({
        includeElevenLabs: true,
        checkboxValues: checkboxValuesFor("nonce1234567", true, allDefinitionValues()),
      });
      const interaction = makeInteraction(
        buildConfigRouteId({
          action: "permissions-manage-submit",
          locale: "en-US",
          includeElevenLabs: true,
          nonce: "nonce1234567",
        }),
        harness,
        { kind: "modal" },
      );
      await dispatch(harness, interaction);

      expect(update).not.toHaveBeenCalled();
      expect(harness.telemetry).toEqual([]);
      expect(harness.edits).toHaveLength(1);
    } finally {
      update.mockRestore();
      key.mockRestore();
    }
  });

  it("writes Privacy only for a manager and denies all three writes to a member", async () => {
    const events: string[] = [];
    let privacyInteraction: ReturnType<typeof makeInteraction> | undefined;
    let privacyAcknowledged = false;
    const updatePrivacy = spyOn(configRepository, "updateChannelScopeConfig").mockImplementation(async () => {
      privacyAcknowledged = privacyInteraction?.deferred || privacyInteraction?.replied || false;
      events.push("write");
      return true;
    });
    const updateTool = spyOn(configRepository, "updateCapabilitiesConfig").mockResolvedValue(true);
    const updateManage = spyOn(configRepository, "updateCapabilitiesAndMemberPermissionsConfig").mockResolvedValue(
      true,
    );
    const invalidate = spyOn(tomoriStateCache, "invalidateTomoriStateCache").mockImplementation(() => {
      events.push("invalidate");
    });
    const key = spyOn(crypto, "hasOptApiKey").mockResolvedValue(true);
    try {
      const manager = makeHarness({ state: makeState({ stm_privacy_bypass: false }) });
      privacyInteraction = makeInteraction(
        buildConfigRouteId({ action: "permissions-privacy-bypass-set", locale: "en-US", enabled: true }),
        manager,
      );
      await dispatch(manager, privacyInteraction);
      expect(privacyAcknowledged).toBe(true);
      expect(events).toEqual(["write", "invalidate"]);
      expect(updatePrivacy).toHaveBeenCalledWith(9, { stm_privacy_bypass: true });

      for (const route of [
        { action: "permissions-tool-use-set", locale: "en-US", enabled: true },
        { action: "permissions-privacy-bypass-set", locale: "en-US", enabled: true },
        {
          action: "permissions-manage-submit",
          locale: "en-US",
          includeElevenLabs: true,
          nonce: "nonce1234567",
        },
      ] as const) {
        const member = makeHarness({ isManager: false, checkboxValues: checkboxValuesFor("nonce1234567", true, []) });
        const memberInteraction = makeInteraction(buildConfigRouteId(route), member, {
          kind: route.action === "permissions-manage-submit" ? "modal" : "button",
          isManager: false,
        });
        await dispatch(member, memberInteraction);
      }

      expect(updateTool).not.toHaveBeenCalled();
      expect(updateManage).not.toHaveBeenCalled();
      expect(invalidate).toHaveBeenCalledTimes(1);
    } finally {
      updatePrivacy.mockRestore();
      updateTool.mockRestore();
      updateManage.mockRestore();
      invalidate.mockRestore();
      key.mockRestore();
    }
  });

  it("keeps Capabilities available in DMs while denying Privacy", async () => {
    const updateTool = spyOn(configRepository, "updateCapabilitiesConfig").mockResolvedValue(true);
    const updatePrivacy = spyOn(configRepository, "updateChannelScopeConfig").mockResolvedValue(true);
    try {
      const dm = makeHarness({ inGuild: false, state: makeState({ tool_use_enabled: false }) });
      const capabilities = makeInteraction(
        buildConfigRouteId({ action: "permissions-tool-use-set", locale: "en-US", enabled: true }),
        dm,
        { inGuild: false },
      );
      await dispatch(dm, capabilities);
      expect(updateTool).toHaveBeenCalledTimes(1);

      const privacy = makeInteraction(
        buildConfigRouteId({ action: "permissions-privacy-bypass-set", locale: "en-US", enabled: true }),
        dm,
        { inGuild: false },
      );
      await dispatch(dm, privacy);
      expect(updatePrivacy).not.toHaveBeenCalled();
    } finally {
      updateTool.mockRestore();
      updatePrivacy.mockRestore();
    }
  });
});

describe("permissions panel", () => {
  it("renders every presented capability, state controls, and privacy disclosure", () => {
    const state = makeState({ tool_use_enabled: true, stm_privacy_bypass: true });
    const view = buildPermissionsView(state, true);
    const payload = buildConfigPanelPayload({
      locale: "en-US",
      actor: { workspaceKind: "guild", isManager: true },
      category: "permissions",
      page: "capabilities",
      personas: [state],
      selectedPersonaId: null,
      readStatus: "fresh",
      permissionsView: view,
    });
    const serialized = JSON.stringify(payload);
    const capabilityDots = (serialized.match(/🟢/gu)?.length ?? 0) + (serialized.match(/🔴/gu)?.length ?? 0);
    expect(capabilityDots).toBe(14);
    expect(serialized).toContain("perm-tool-use-set");
    expect(serialized.indexOf("Controls whether I may call tools at all.")).toBeLessThan(
      serialized.indexOf("perm-tool-use-set"),
    );
    expect(serialized.indexOf("perm-tool-use-set")).toBeLessThan(
      serialized.indexOf("I may use tools when the conversation calls for them."),
    );
    const privacySerialized = JSON.stringify(
      buildConfigPanelPayload({
        locale: "en-US",
        actor: { workspaceKind: "guild", isManager: true },
        category: "permissions",
        page: "privacy",
        personas: [state],
        selectedPersonaId: null,
        readStatus: "fresh",
        permissionsView: view,
      }),
    );
    expect(privacySerialized).toContain("Private-channel Bypass");
    expect(privacySerialized).toContain("/memories");

    const stalePayload = buildConfigPanelPayload({
      locale: "en-US",
      actor: { workspaceKind: "guild", isManager: true },
      category: "permissions",
      page: "capabilities",
      personas: [state],
      selectedPersonaId: null,
      readStatus: "stale",
      permissionsView: view,
    });
    for (const action of [
      { action: "permissions-tool-use-set", locale: "en-US", enabled: false },
      { action: "permissions-tool-use-set", locale: "en-US", enabled: true },
      { action: "permissions-manage-open", locale: "en-US" },
      { action: "permissions-privacy-bypass-set", locale: "en-US", enabled: false },
      { action: "permissions-privacy-bypass-set", locale: "en-US", enabled: true },
    ] as const) {
      const targetPayload = action.action.startsWith("permissions-privacy")
        ? buildConfigPanelPayload({
            locale: "en-US",
            actor: { workspaceKind: "guild", isManager: true },
            category: "permissions",
            page: "privacy",
            personas: [state],
            selectedPersonaId: null,
            readStatus: "stale",
            permissionsView: view,
          })
        : stalePayload;
      const component = findComponentByCustomId(targetPayload, buildConfigRouteId(action));
      expect(component?.disabled).toBe(true);
    }
  });
});
