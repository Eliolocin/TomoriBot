import { ChannelType, MessageFlags, type ModalSubmitInteraction } from "discord.js";
import type { PanelAction } from "@/constants/panelActions";
import {
  computeAutoTriggerFingerprint,
  computeChannelRulesFingerprint,
  computeChannelOverridesFingerprint,
  CONFIG_MODEL_PAGE_SIZE,
  type ConfigChannelRulesCollection,
  type ConfigPanelRoute,
} from "@/utils/discord/configPanelCatalog";
import { invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { channelContextNoteRepo, channelPromptRepo, configRepository } from "@/utils/db/repositories";
import { isConfigRouteAuthorized, type ConfigActor } from "@/utils/discord/interactions/configPermissionPolicy";
import {
  CHECKLIST_CHANNELS_PER_PAGE,
  type ChannelOverrideChannelTarget,
} from "@/utils/discord/channelChecklistManager";
import {
  repaint,
  staleReceipt,
  type ConfigRepaintOptions,
  type ConfigChannelsView,
  type ConfigRouteDependencies,
  type ConfigScope,
} from "@/utils/discord/interactions/configRouteContext";
import type { GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import {
  buildConfigLogChannelModal,
  buildConfigWelcomeModal,
  CONFIG_CHANNEL_LOG_FIELD,
  CONFIG_CHANNEL_WELCOME_FIELD,
  CONFIG_CHANNEL_WELCOME_PERSONA_FIELD,
  CONFIG_CHANNEL_WELCOME_PROMPT_FIELD,
  CONFIG_CHANNEL_AUTO_TRIGGER_CHECKBOX_PREFIX,
  CONFIG_CHANNEL_AUTO_TRIGGER_CHANNEL_FIELD,
  CONFIG_CHANNEL_AUTO_TRIGGER_ENABLED_FIELD,
  CONFIG_CHANNEL_AUTO_TRIGGER_MAX_THRESHOLD_FIELD,
  CONFIG_CHANNEL_AUTO_TRIGGER_PERSONA_FIELD,
  CONFIG_CHANNEL_AUTO_TRIGGER_THRESHOLD_FIELD,
  buildConfigAutoTriggerChannelsModal,
  buildConfigAutoTriggerConfigureModal,
  buildConfigAutoTriggerThresholdModal,
  CONFIG_CHANNEL_BLOCKLIST_CHECKBOX_PREFIX,
  CONFIG_CHANNEL_PRIVATE_CHECKBOX_PREFIX,
  CONFIG_CHANNEL_RP_CHECKBOX_PREFIX,
  CONFIG_CHANNEL_RULES_CHECKBOX_GROUP_SIZE,
  buildConfigBlocklistChannelsModal,
  buildConfigPrivateChannelsModal,
  buildConfigRoleplayChannelsModal,
  buildConfigChannelContextNoteModal,
  buildConfigChannelTextModelModal,
  buildConfigChannelPromptModal,
  CONFIG_CHANNEL_OVERRIDE_CONTEXT_NOTE_DEPTH_FIELD,
  CONFIG_CHANNEL_OVERRIDE_CONTEXT_NOTE_TEXT_FIELD,
  CONFIG_CHANNEL_OVERRIDE_MODE_FIELD,
  CONFIG_CHANNEL_OVERRIDE_PROMPT_PART_FIELDS,
  CONFIG_CHANNEL_OVERRIDE_TEXT_MODEL_FIELD,
} from "@/utils/discord/ui/configChannelModals";
import { buildConfigModalFieldId } from "@/utils/discord/ui/configModals";
import { localizer } from "@/utils/text/localizer";
import { rollAutochatTarget, validateThresholdInput } from "@/utils/discord/autoTriggerThreshold";
import type { AutochatPersonaOverride, ChannelPromptMode, TomoriState } from "@/types/db/schema";
import { combineModalPromptParts } from "@/utils/text/modalPromptParts";
import type { ConfigPanelView } from "@/utils/discord/ui/configPanel";
import { CONTEXT_NOTE_DEPTH_MAX, CONTEXT_NOTE_MAX_LENGTH } from "@/utils/discord/contextNoteOptions";

export const CONFIG_CHANNEL_MODAL_OPEN_ACTIONS = new Set<ConfigPanelRoute["action"]>([
  "channels-log-open",
  "channels-welcome-open",
  "channels-welcome-range-select",
  "channels-autoch-manage-open",
  "channels-autoch-configure-open",
  "channels-autoch-range-select",
  "channels-autoch-threshold-open",
  "channels-private-manage-open",
  "channels-rp-manage-open",
  "channels-blocklist-manage-open",
  "channels-overrides-prompt-open",
  "channels-overrides-context-note-open",
  "channels-overrides-text-provider-select",
  "channels-overrides-text-model-range-select",
]);

/**
 * Range entries that open a modal on a chosen page. They are selects rather than buttons because
 * the page index rides the option value, which is what keeps one route id under Discord's limit
 * no matter how large the roster grows.
 */
export const CONFIG_CHANNEL_SELECT_ACTIONS = new Set<ConfigPanelRoute["action"]>([
  "channels-welcome-range-select",
  "channels-autoch-range-select",
  "channels-overrides-text-model-range-select",
]);

export const CONFIG_CHANNEL_MODAL_SUBMIT_ACTIONS = new Set<ConfigPanelRoute["action"]>([
  "channels-log-submit",
  "channels-welcome-submit",
  "channels-autoch-submit",
  "channels-autoch-configure-submit",
  "channels-autoch-threshold-submit",
  "channels-private-submit",
  "channels-rp-submit",
  "channels-blocklist-submit",
  "channels-overrides-prompt-submit",
  "channels-overrides-context-note-submit",
  "channels-overrides-text-model-submit",
]);

export const CONFIG_CHANNEL_DIRECT_ACTIONS = new Set<ConfigPanelRoute["action"]>([
  "channels-log-clear",
  "channels-welcome-clear",
  "channels-overrides-prompt-clear",
  "channels-overrides-text-clear",
]);

const CONFIG_CHANNEL_NAVIGATION_ACTIONS = new Set<ConfigPanelRoute["action"]>([
  "channels-autoch-page",
  "channels-private-page",
  "channels-rp-page",
  "channels-blocklist-page",
]);

const CONFIG_CHANNEL_OVERRIDE_NAVIGATION_ACTIONS = new Set<ConfigPanelRoute["action"]>([
  "channels-overrides-select",
  "channels-overrides-text-open",
]);

const CONFIG_CHANNEL_OVERRIDE_TEXT_WRITE_ACTIONS = new Set<ConfigPanelRoute["action"]>([
  "channels-overrides-text-model-submit",
  "channels-overrides-text-clear",
]);

const CHANNEL_OVERRIDE_TYPES = new Set<ChannelOverrideChannelTarget["type"]>([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
]);

const CONTEXT_NOTE_CHANNEL_TYPES = new Set<ChannelOverrideChannelTarget["type"]>([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
]);

/**
 * Reads the persona page a range select was opened on.
 *
 * The range entry carries its own start rather than the route id, mirroring how the Fallbacks
 * provider select carries `start|provider`: the button that opens page one and the select that
 * opens the rest then share one handler and one modal builder.
 */
function personaRangeStart(interaction: GlobalRoutableInteraction): number {
  if (!interaction.isStringSelectMenu()) return 0;
  const start = Number.parseInt(interaction.values[0] ?? "", 10);
  return Number.isInteger(start) && start >= 0 ? start : 0;
}

function modal(interaction: GlobalRoutableInteraction): ModalSubmitInteraction {
  return interaction as ModalSubmitInteraction;
}

function receipt(
  locale: string,
  tone: "success" | "info" | "warning" | "error",
  headingKey: string,
  detailKey: string,
): ConfigRepaintOptions["receipt"] {
  return {
    tone,
    heading: localizer(locale, `commands.config.panel.${headingKey}`),
    detail: localizer(locale, `commands.config.panel.${detailKey}`),
  };
}

function invalid(locale: string, detailKey: string): ConfigRepaintOptions["receipt"] {
  return receipt(locale, "error", "channels_invalid_input_heading", detailKey);
}

function externalReceipt(
  locale: string,
  tone: "success" | "info" | "warning" | "error",
  headingKey: string,
  detailKey: string,
): ConfigRepaintOptions["receipt"] {
  return {
    tone,
    heading: localizer(locale, headingKey),
    detail: localizer(locale, detailKey),
  };
}

function stateFromScope(scope: ConfigScope) {
  return scope.personas[0] ?? null;
}

function buildAutochatPersonaOverrideMap(
  overrides: readonly AutochatPersonaOverride[] | null | undefined,
): Map<string, number> {
  return new Map(
    (overrides ?? [])
      .filter((override) => Boolean(override.channel_disc_id) && Number.isInteger(override.persona_id))
      .map((override) => [override.channel_disc_id, override.persona_id]),
  );
}

function serializeAutochatPersonaOverrides(overrides: ReadonlyMap<string, number>): AutochatPersonaOverride[] {
  return [...overrides.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([channel_disc_id, persona_id]) => ({ channel_disc_id, persona_id }));
}

function areStringSetsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  return [...left].every((value) => right.has(value));
}

function areAutochatPersonaOverridesEqual(
  left: ReadonlyMap<string, number>,
  right: ReadonlyMap<string, number>,
): boolean {
  if (left.size !== right.size) return false;
  return [...left].every(([channelId, personaId]) => right.get(channelId) === personaId);
}

function cloneAutochatPersonaOverrideMap(source: ReadonlyMap<string, number>): Map<string, number> {
  return new Map(source);
}

function pruneAutochatPersonaOverrides(
  overrides: ReadonlyMap<string, number>,
  selectedIds: ReadonlySet<string>,
): Map<string, number> {
  return new Map([...overrides].filter(([channelId]) => selectedIds.has(channelId)));
}

function visibleAutochatChannelIds(state: TomoriState, availableChannels: readonly { id: string }[]): Set<string> {
  const availableIds = new Set(availableChannels.map((channel) => channel.id));
  return new Set((state.config.autoch_disc_ids ?? []).filter((channelId) => availableIds.has(channelId)));
}

function autoTriggerFingerprint(state: TomoriState, availableChannels: readonly { id: string }[]): string {
  return computeAutoTriggerFingerprint(
    state.server_id,
    availableChannels.map((channel) => channel.id),
    state.config.autoch_disc_ids ?? [],
    state.config.autoch_persona_overrides ?? [],
  );
}

function rangeCount(channelCount: number): number {
  return Math.max(1, Math.ceil(channelCount / CHECKLIST_CHANNELS_PER_PAGE));
}

function rangeChannels<T>(channels: readonly T[], rangeIndex: number): T[] {
  const start = rangeIndex * CHECKLIST_CHANNELS_PER_PAGE;
  return channels.slice(start, start + CHECKLIST_CHANNELS_PER_PAGE);
}

function parseThresholdText(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function repaintDestinations(
  interaction: GlobalRoutableInteraction,
  route: ConfigPanelRoute,
  scope: ConfigScope,
  dependencies: ConfigRouteDependencies,
  receiptValue?: ConfigRepaintOptions["receipt"],
): Promise<void> {
  await repaint(interaction, {
    locale: route.locale,
    scope,
    category: "channels",
    page: "destinations",
    selectedPersonaId: null,
    receipt: receiptValue,
    dependencies,
  });
}

async function repaintAutoTrigger(
  interaction: GlobalRoutableInteraction,
  route: ConfigPanelRoute,
  scope: ConfigScope,
  dependencies: ConfigRouteDependencies,
  rangeIndex: number,
  receiptValue?: ConfigRepaintOptions["receipt"],
): Promise<void> {
  await repaint(interaction, {
    locale: route.locale,
    scope,
    category: "channels",
    page: "auto-trigger",
    selectedPersonaId: null,
    channelsAutoTriggerRangeIndex: rangeIndex,
    receipt: receiptValue,
    dependencies,
  });
}

function repaintChannelRules(
  interaction: GlobalRoutableInteraction,
  route: ConfigPanelRoute,
  scope: ConfigScope,
  dependencies: ConfigRouteDependencies,
  collection: ConfigChannelRulesCollection,
  rangeIndex: number,
  receiptValue?: ConfigRepaintOptions["receipt"],
): Promise<void> {
  const rangeOptions =
    collection === "private"
      ? { channelsPrivateRangeIndex: rangeIndex }
      : collection === "roleplay"
        ? { channelsRoleplayRangeIndex: rangeIndex }
        : { channelsBlocklistRangeIndex: rangeIndex };
  return repaint(interaction, {
    locale: route.locale,
    scope,
    category: "channels",
    page: "rules",
    selectedPersonaId: null,
    ...rangeOptions,
    receipt: receiptValue,
    dependencies,
  });
}

async function channelIsAvailable(
  interaction: GlobalRoutableInteraction,
  channelId: string,
  dependencies: ConfigRouteDependencies,
): Promise<boolean> {
  const view = await dependencies.loadChannelsView(interaction);
  return view.availableTextChannels.some((channel) => channel.id === channelId);
}

function channelOverrideTarget(
  view: ConfigChannelsView,
  channelId: string,
  allowedTypes: ReadonlySet<ChannelOverrideChannelTarget["type"]>,
): ChannelOverrideChannelTarget | null {
  const target = view.availableOverrideChannels.find((channel) => channel.id === channelId);
  return target && allowedTypes.has(target.type) ? target : null;
}

function channelOverridesFingerprint(state: TomoriState, channelId: string, view: ConfigChannelsView): string {
  return computeChannelOverridesFingerprint(
    state.server_id,
    channelId,
    view.overrides.prompt,
    view.overrides.contextNote,
    view.overrides.textModelOverride?.llm_id ?? null,
    state.llm?.llm_id ?? null,
  );
}

function modalTextValue(submitted: ModalSubmitInteraction, fieldId: string): string {
  return submitted.fields.fields.has(fieldId) ? submitted.fields.getTextInputValue(fieldId) : "";
}

function overridesInvalidReply(locale: string, detailKey: string) {
  const value = invalid(locale, detailKey);
  return `${value?.heading ?? ""}\n${value?.detail ?? ""}`;
}

type ChannelWriteOutcome = {
  receipt: ConfigRepaintOptions["receipt"];
  telemetry?: PanelAction;
};

type AutoTriggerWriteRoute = Extract<
  ConfigPanelRoute,
  {
    action: "channels-autoch-submit" | "channels-autoch-configure-submit" | "channels-autoch-threshold-submit";
  }
>;

type ChannelRulesOpenRoute = Extract<
  ConfigPanelRoute,
  {
    action: "channels-private-manage-open" | "channels-rp-manage-open" | "channels-blocklist-manage-open";
  }
>;

type ChannelRulesWriteRoute = Extract<
  ConfigPanelRoute,
  {
    action: "channels-private-submit" | "channels-rp-submit" | "channels-blocklist-submit";
  }
>;

type ChannelRulesPageRoute = Extract<
  ConfigPanelRoute,
  { action: "channels-private-page" | "channels-rp-page" | "channels-blocklist-page" }
>;

function channelRulesCollection(
  action: ChannelRulesOpenRoute["action"] | ChannelRulesWriteRoute["action"],
): ConfigChannelRulesCollection {
  if (action.startsWith("channels-private")) return "private";
  if (action.startsWith("channels-rp")) return "roleplay";
  return "blocklist";
}

function channelRulesCollectionFromPage(action: ChannelRulesPageRoute["action"]): ConfigChannelRulesCollection {
  if (action === "channels-private-page") return "private";
  if (action === "channels-rp-page") return "roleplay";
  return "blocklist";
}

function channelRulesAvailable(
  view: Awaited<ReturnType<ConfigRouteDependencies["loadChannelsView"]>>,
  collection: ConfigChannelRulesCollection,
) {
  return collection === "blocklist" ? view.availableBlocklistChannels : view.availableTextChannels;
}

function channelRulesSelectedIds(state: TomoriState, collection: ConfigChannelRulesCollection): readonly string[] {
  if (collection === "private") return state.config.private_channel_ids ?? [];
  if (collection === "roleplay") return state.config.rp_channel_ids ?? [];
  return state.config.crosschannel_blocklist_ids ?? [];
}

function visibleChannelRulesIds(
  state: TomoriState,
  collection: ConfigChannelRulesCollection,
  availableChannels: readonly { id: string }[],
): Set<string> {
  const availableIds = new Set(availableChannels.map((channel) => channel.id));
  return new Set(channelRulesSelectedIds(state, collection).filter((channelId) => availableIds.has(channelId)));
}

function channelRulesFingerprint(
  state: TomoriState,
  collection: ConfigChannelRulesCollection,
  availableChannels: readonly { id: string }[],
): string {
  return computeChannelRulesFingerprint(
    state.server_id,
    collection,
    availableChannels.map((channel) => channel.id),
    channelRulesSelectedIds(state, collection),
  );
}

function channelRulesCheckboxPrefix(collection: ConfigChannelRulesCollection): string {
  if (collection === "private") return CONFIG_CHANNEL_PRIVATE_CHECKBOX_PREFIX;
  if (collection === "roleplay") return CONFIG_CHANNEL_RP_CHECKBOX_PREFIX;
  return CONFIG_CHANNEL_BLOCKLIST_CHECKBOX_PREFIX;
}

function channelRulesUpdatedReceipt(
  locale: string,
  collection: ConfigChannelRulesCollection,
  addedCount: number,
  removedCount: number,
): ConfigRepaintOptions["receipt"] {
  const variables = { added_count: addedCount, removed_count: removedCount };
  if (collection === "private") {
    return {
      tone: "success",
      heading: localizer(locale, "commands.config.panel.channels_rules_private_updated_heading"),
      detail: localizer(locale, "commands.config.panel.channels_rules_private_updated_detail", variables),
    };
  }
  if (collection === "roleplay") {
    return {
      tone: "success",
      heading: localizer(locale, "commands.config.panel.channels_rules_roleplay_updated_heading"),
      detail: localizer(locale, "commands.config.panel.channels_rules_roleplay_updated_detail", variables),
    };
  }
  return {
    tone: "success",
    heading: localizer(locale, "commands.config.panel.channels_rules_blocklist_updated_heading"),
    detail: localizer(locale, "commands.config.panel.channels_rules_blocklist_updated_detail", variables),
  };
}

async function openChannelRulesModal(
  interaction: GlobalRoutableInteraction,
  route: ChannelRulesOpenRoute,
  state: TomoriState,
  dependencies: ConfigRouteDependencies,
): Promise<void> {
  const view = await dependencies.loadChannelsView(interaction);
  const collection = channelRulesCollection(route.action);
  const availableChannels = channelRulesAvailable(view, collection);
  if (availableChannels.length === 0) {
    const content =
      collection === "private"
        ? localizer(route.locale, "commands.config.panel.channels_rules_private_no_channels")
        : collection === "roleplay"
          ? localizer(route.locale, "commands.config.panel.channels_rules_roleplay_no_channels")
          : localizer(route.locale, "commands.config.panel.channels_rules_blocklist_no_channels");
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    return;
  }

  const selectedRange = Math.min(Math.max(route.start ?? 0, 0), rangeCount(availableChannels.length) - 1);
  const presentedChannels = rangeChannels(availableChannels, selectedRange);
  const selectedIds = visibleChannelRulesIds(state, collection, availableChannels);
  const fp = channelRulesFingerprint(state, collection, availableChannels);

  if (collection === "private") {
    await dependencies.showModal(
      interaction,
      buildConfigPrivateChannelsModal(
        route.locale,
        dependencies.createNonce(),
        selectedRange,
        fp,
        presentedChannels,
        selectedIds,
      ),
    );
  } else if (collection === "roleplay") {
    await dependencies.showModal(
      interaction,
      buildConfigRoleplayChannelsModal(
        route.locale,
        dependencies.createNonce(),
        selectedRange,
        fp,
        presentedChannels,
        selectedIds,
      ),
    );
  } else {
    await dependencies.showModal(
      interaction,
      buildConfigBlocklistChannelsModal(
        route.locale,
        dependencies.createNonce(),
        selectedRange,
        fp,
        rangeChannels(view.availableBlocklistChannels, selectedRange),
        selectedIds,
      ),
    );
  }
}

async function runChannelRulesWrite(
  interaction: GlobalRoutableInteraction,
  route: ChannelRulesWriteRoute,
  scope: ConfigScope,
  dependencies: ConfigRouteDependencies,
): Promise<ChannelWriteOutcome> {
  const state = stateFromScope(scope);
  if (!state) return { receipt: receipt(route.locale, "error", "write_failed_heading", "write_failed_detail") };

  const collection = channelRulesCollection(route.action);
  const view = await dependencies.loadChannelsView(interaction);
  const availableChannels = channelRulesAvailable(view, collection);
  if (channelRulesFingerprint(state, collection, availableChannels) !== route.fp) {
    return { receipt: staleReceipt(route.locale) };
  }

  const pageCount = rangeCount(availableChannels.length);
  if (route.start < 0 || route.start >= pageCount) return { receipt: staleReceipt(route.locale) };

  const presentedChannels = rangeChannels(availableChannels, route.start);
  const presentedIds = new Set(presentedChannels.map((channel) => channel.id));
  const checkedIds = new Set<string>();
  const submitted = modal(interaction);
  const groupCount = Math.ceil(presentedChannels.length / CONFIG_CHANNEL_RULES_CHECKBOX_GROUP_SIZE);
  for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
    const values = dependencies.takeCheckboxValues(
      submitted.id,
      buildConfigModalFieldId(`${channelRulesCheckboxPrefix(collection)}_${groupIndex}`, route.nonce),
    );
    if (values === undefined) return { receipt: staleReceipt(route.locale) };
    for (const channelId of values) {
      if (!presentedIds.has(channelId)) {
        return { receipt: invalid(route.locale, "channels_rules_invalid_channel_detail") };
      }
      checkedIds.add(channelId);
    }
  }

  const previousSelectedIds = visibleChannelRulesIds(state, collection, availableChannels);
  const nextSelectedIds = new Set(previousSelectedIds);
  for (const channelId of presentedIds) nextSelectedIds.delete(channelId);
  for (const channelId of checkedIds) nextSelectedIds.add(channelId);

  const addedIds = [...nextSelectedIds].filter((channelId) => !previousSelectedIds.has(channelId));
  const removedIds = [...previousSelectedIds].filter((channelId) => !nextSelectedIds.has(channelId));
  if (addedIds.length === 0 && removedIds.length === 0) {
    return {
      receipt: receipt(route.locale, "info", "state_no_changes_heading", "state_no_changes_detail"),
    };
  }

  const updated =
    collection === "private"
      ? await configRepository.updateChannelScopeConfig(state.server_id, {
          private_channel_ids: [...nextSelectedIds],
        })
      : collection === "roleplay"
        ? await configRepository.updateChannelScopeConfig(state.server_id, {
            rp_channel_ids: [...nextSelectedIds],
          })
        : await configRepository.updateChannelScopeConfig(state.server_id, {
            crosschannel_blocklist_ids: [...nextSelectedIds],
          });
  if (!updated) return { receipt: receipt(route.locale, "error", "write_failed_heading", "write_failed_detail") };

  invalidateTomoriStateCache(scope.serverDiscId);
  return {
    receipt: channelRulesUpdatedReceipt(route.locale, collection, addedIds.length, removedIds.length),
    telemetry:
      collection === "private"
        ? "server-config.workspace.private-channels.set"
        : collection === "roleplay"
          ? "server-config.workspace.rp-channels.set"
          : "server-config.workspace.crosschannel-blocklist.set",
  };
}

async function runAutoTriggerWrite(
  interaction: GlobalRoutableInteraction,
  route: AutoTriggerWriteRoute,
  scope: ConfigScope,
  dependencies: ConfigRouteDependencies,
): Promise<ChannelWriteOutcome | null> {
  const state = stateFromScope(scope);
  if (!state) return null;
  const submitted = modal(interaction);
  const view = await dependencies.loadChannelsView(interaction);
  const availableChannels = view.availableTextChannels;
  if (autoTriggerFingerprint(state, availableChannels) !== route.fp) {
    return { receipt: staleReceipt(route.locale) };
  }

  if (route.action === "channels-autoch-submit") {
    const pages = rangeCount(availableChannels.length);
    if (route.start < 0 || route.start >= pages) return { receipt: staleReceipt(route.locale) };
    const presented = rangeChannels(availableChannels, route.start);
    const presentedIds = new Set(presented.map((channel) => channel.id));
    const checkedIds = new Set<string>();
    const groupCount = Math.ceil(presented.length / 10);
    for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
      const values = dependencies.takeCheckboxValues(
        submitted.id,
        buildConfigModalFieldId(`${CONFIG_CHANNEL_AUTO_TRIGGER_CHECKBOX_PREFIX}_${groupIndex}`, route.nonce),
      );
      if (values === undefined) return { receipt: staleReceipt(route.locale) };
      for (const channelId of values) {
        if (!presentedIds.has(channelId)) return { receipt: invalid(route.locale, "channels_invalid_channel_detail") };
        checkedIds.add(channelId);
      }
    }

    const previousSelectedIds = visibleAutochatChannelIds(state, availableChannels);
    const nextSelectedIds = new Set(previousSelectedIds);
    for (const channelId of presentedIds) nextSelectedIds.delete(channelId);
    for (const channelId of checkedIds) nextSelectedIds.add(channelId);

    const previousOverrides = buildAutochatPersonaOverrideMap(state.config.autoch_persona_overrides);
    const nextOverrides = pruneAutochatPersonaOverrides(previousOverrides, nextSelectedIds);
    const enabledIds = [...nextSelectedIds].filter((channelId) => !previousSelectedIds.has(channelId));
    const disabledIds = [...previousSelectedIds].filter((channelId) => !nextSelectedIds.has(channelId));
    if (
      enabledIds.length === 0 &&
      disabledIds.length === 0 &&
      areAutochatPersonaOverridesEqual(previousOverrides, nextOverrides)
    ) {
      return {
        receipt: receipt(route.locale, "info", "state_no_changes_heading", "state_no_changes_detail"),
      };
    }

    const updated = await configRepository.updateAutoTriggerConfig(state.server_id, {
      autoch_disc_ids: [...nextSelectedIds],
      autoch_persona_overrides: serializeAutochatPersonaOverrides(nextOverrides),
    });
    if (!updated) return { receipt: receipt(route.locale, "error", "write_failed_heading", "write_failed_detail") };
    invalidateTomoriStateCache(scope.serverDiscId);
    return {
      receipt: receipt(
        route.locale,
        "success",
        "channels_auto_trigger_updated_heading",
        "channels_auto_trigger_updated_detail",
      ),
      telemetry: "server-config.workspace.auto-trigger-channels.set",
    };
  }

  if (route.action === "channels-autoch-configure-submit") {
    const channelId = dependencies.takeChannelSelectValue(
      submitted.id,
      buildConfigModalFieldId(CONFIG_CHANNEL_AUTO_TRIGGER_CHANNEL_FIELD, route.nonce),
    );
    const enabledValue = dependencies.takeSelectValue(
      submitted.id,
      buildConfigModalFieldId(CONFIG_CHANNEL_AUTO_TRIGGER_ENABLED_FIELD, route.nonce),
    );
    const personaValue = dependencies.takeSelectValue(
      submitted.id,
      buildConfigModalFieldId(CONFIG_CHANNEL_AUTO_TRIGGER_PERSONA_FIELD, route.nonce),
    );
    if (!channelId || !availableChannels.some((channel) => channel.id === channelId)) {
      return { receipt: invalid(route.locale, "channels_invalid_channel_detail") };
    }
    if (enabledValue !== "true" && enabledValue !== "false") {
      return { receipt: invalid(route.locale, "channels_auto_trigger_enabled_required_detail") };
    }
    const personaId = personaValue && /^\d+$/.test(personaValue) ? Number(personaValue) : Number.NaN;
    const desiredPersona = Number.isSafeInteger(personaId)
      ? scope.personas.find((persona) => persona.persona_id === personaId)
      : undefined;
    if (!desiredPersona || desiredPersona.persona_id === undefined) {
      return { receipt: invalid(route.locale, "channels_auto_trigger_persona_invalid_detail") };
    }

    const previousSelectedIds = new Set(state.config.autoch_disc_ids ?? []);
    const nextSelectedIds = new Set(previousSelectedIds);
    const previousOverrides = buildAutochatPersonaOverrideMap(state.config.autoch_persona_overrides);
    const nextOverrides = cloneAutochatPersonaOverrideMap(previousOverrides);
    const mainPersona = scope.personas.find((persona) => !persona.is_alter) ?? scope.personas[0];
    if (enabledValue === "true") {
      nextSelectedIds.add(channelId);
      if (desiredPersona.persona_id === mainPersona?.persona_id) nextOverrides.delete(channelId);
      else nextOverrides.set(channelId, desiredPersona.persona_id);
    } else {
      nextSelectedIds.delete(channelId);
      nextOverrides.delete(channelId);
    }

    if (
      areStringSetsEqual(previousSelectedIds, nextSelectedIds) &&
      areAutochatPersonaOverridesEqual(previousOverrides, nextOverrides)
    ) {
      return {
        receipt: receipt(route.locale, "info", "state_no_changes_heading", "state_no_changes_detail"),
      };
    }

    const updated = await configRepository.updateAutoTriggerConfig(state.server_id, {
      autoch_disc_ids: [...nextSelectedIds],
      autoch_persona_overrides: serializeAutochatPersonaOverrides(nextOverrides),
    });
    if (!updated) return { receipt: receipt(route.locale, "error", "write_failed_heading", "write_failed_detail") };
    invalidateTomoriStateCache(scope.serverDiscId);
    return {
      receipt: receipt(
        route.locale,
        "success",
        "channels_auto_trigger_configured_heading",
        "channels_auto_trigger_configured_detail",
      ),
      telemetry: "server-config.workspace.auto-trigger-channels.configure",
    };
  }

  if (route.action === "channels-autoch-threshold-submit") {
    const threshold = parseThresholdText(
      submitted.fields.fields.has(buildConfigModalFieldId(CONFIG_CHANNEL_AUTO_TRIGGER_THRESHOLD_FIELD, route.nonce))
        ? submitted.fields.getTextInputValue(
            buildConfigModalFieldId(CONFIG_CHANNEL_AUTO_TRIGGER_THRESHOLD_FIELD, route.nonce),
          )
        : "",
    );
    const rawMax = submitted.fields.fields.has(
      buildConfigModalFieldId(CONFIG_CHANNEL_AUTO_TRIGGER_MAX_THRESHOLD_FIELD, route.nonce),
    )
      ? submitted.fields.getTextInputValue(
          buildConfigModalFieldId(CONFIG_CHANNEL_AUTO_TRIGGER_MAX_THRESHOLD_FIELD, route.nonce),
        )
      : "";
    const maxThreshold = rawMax.trim() ? parseThresholdText(rawMax) : threshold;
    if (threshold === null || maxThreshold === null) {
      return {
        receipt: invalid(route.locale, "channels_auto_trigger_threshold_invalid_detail"),
      };
    }
    const validation = validateThresholdInput(threshold, maxThreshold);
    if (!validation.isValid) {
      return {
        receipt: invalid(route.locale, "channels_auto_trigger_threshold_invalid_detail"),
      };
    }
    const currentThreshold = state.config.autoch_threshold ?? 0;
    const currentMaxThreshold = state.config.autoch_threshold_max ?? currentThreshold;
    if (threshold === currentThreshold && maxThreshold === currentMaxThreshold) {
      return {
        receipt: receipt(route.locale, "info", "state_no_changes_heading", "state_no_changes_detail"),
      };
    }
    if (state.persona_id === undefined) {
      return { receipt: receipt(route.locale, "error", "write_failed_heading", "write_failed_detail") };
    }
    const nextTarget = validation.isAlwaysReplyMode ? 0 : rollAutochatTarget(threshold, maxThreshold);
    const updated = await configRepository.setAutoChatThreshold(
      state.server_id,
      state.persona_id,
      threshold,
      maxThreshold,
      nextTarget,
    );
    if (!updated) return { receipt: receipt(route.locale, "error", "write_failed_heading", "write_failed_detail") };
    invalidateTomoriStateCache(scope.serverDiscId);
    return {
      receipt: receipt(
        route.locale,
        "success",
        "channels_auto_trigger_threshold_updated_heading",
        "channels_auto_trigger_threshold_updated_detail",
      ),
      telemetry: "server-config.workspace.auto-trigger-threshold.set",
    };
  }

  return null;
}

async function runChannelWrite(
  interaction: GlobalRoutableInteraction,
  route: ConfigPanelRoute,
  scope: ConfigScope,
  dependencies: ConfigRouteDependencies,
): Promise<ChannelWriteOutcome> {
  const state = stateFromScope(scope);
  if (!state) return { receipt: receipt(route.locale, "error", "write_failed_heading", "write_failed_detail") };

  if (
    route.action === "channels-private-submit" ||
    route.action === "channels-rp-submit" ||
    route.action === "channels-blocklist-submit"
  ) {
    return runChannelRulesWrite(interaction, route, scope, dependencies);
  }

  if (
    route.action === "channels-autoch-submit" ||
    route.action === "channels-autoch-configure-submit" ||
    route.action === "channels-autoch-threshold-submit"
  ) {
    return (
      (await runAutoTriggerWrite(interaction, route, scope, dependencies)) ?? {
        receipt: receipt(route.locale, "error", "write_failed_heading", "write_failed_detail"),
      }
    );
  }

  if (route.action === "channels-log-clear") {
    const currentChannelId = state.config.thought_log_channel_disc_id ?? null;
    if ((route.channelId ?? null) !== currentChannelId) return { receipt: staleReceipt(route.locale) };
    if (!currentChannelId) {
      return { receipt: receipt(route.locale, "info", "state_no_changes_heading", "state_no_changes_detail") };
    }

    const updated = await configRepository.updateChannelScopeConfig(state.server_id, {
      thought_log_channel_disc_id: null,
    });
    if (!updated) return { receipt: receipt(route.locale, "error", "write_failed_heading", "write_failed_detail") };
    invalidateTomoriStateCache(scope.serverDiscId);
    return {
      receipt: receipt(route.locale, "success", "channels_log_cleared_heading", "channels_log_cleared_detail"),
      telemetry: "server-config.workspace.thought-logs-channel.clear",
    };
  }

  if (route.action === "channels-welcome-clear") {
    const currentChannelId = state.config.welcome_channel_disc_id ?? null;
    if ((route.channelId ?? null) !== currentChannelId) return { receipt: staleReceipt(route.locale) };
    if (!currentChannelId && !state.config.welcome_prompt) {
      return {
        receipt: receipt(
          route.locale,
          "info",
          "channels_welcome_not_configured_heading",
          "channels_welcome_not_configured_detail",
        ),
      };
    }

    const updated = await configRepository.updateWelcomeConfig(state.server_id, {
      welcome_channel_disc_id: null,
      welcome_prompt: null,
      welcome_persona_id: null,
    });
    if (!updated) return { receipt: receipt(route.locale, "error", "write_failed_heading", "write_failed_detail") };
    invalidateTomoriStateCache(scope.serverDiscId);
    return {
      receipt: receipt(route.locale, "success", "channels_welcome_cleared_heading", "channels_welcome_cleared_detail"),
      telemetry: "server-config.workspace.welcome-channel.clear",
    };
  }

  const submitted = modal(interaction);
  if (route.action === "channels-log-submit") {
    const channelId = dependencies.takeChannelSelectValue(
      submitted.id,
      buildConfigModalFieldId(CONFIG_CHANNEL_LOG_FIELD, route.nonce),
    );
    if (!channelId || !(await channelIsAvailable(interaction, channelId, dependencies))) {
      return { receipt: invalid(route.locale, "channels_invalid_channel_detail") };
    }

    const currentChannelId = state.config.thought_log_channel_disc_id ?? null;
    if (currentChannelId === channelId) {
      return { receipt: receipt(route.locale, "info", "state_no_changes_heading", "state_no_changes_detail") };
    }

    const updated = await configRepository.updateChannelScopeConfig(state.server_id, {
      thought_log_channel_disc_id: channelId,
    });
    if (!updated) return { receipt: receipt(route.locale, "error", "write_failed_heading", "write_failed_detail") };
    invalidateTomoriStateCache(scope.serverDiscId);
    return {
      receipt: receipt(route.locale, "success", "channels_log_updated_heading", "channels_log_updated_detail"),
      telemetry: "server-config.workspace.thought-logs-channel.set",
    };
  }

  if (route.action !== "channels-welcome-submit") {
    return { receipt: receipt(route.locale, "error", "write_failed_heading", "write_failed_detail") };
  }

  const channelId = dependencies.takeChannelSelectValue(
    submitted.id,
    buildConfigModalFieldId(CONFIG_CHANNEL_WELCOME_FIELD, route.nonce),
  );
  const personaValue = dependencies.takeSelectValue(
    submitted.id,
    buildConfigModalFieldId(CONFIG_CHANNEL_WELCOME_PERSONA_FIELD, route.nonce),
  );
  const promptFieldId = buildConfigModalFieldId(CONFIG_CHANNEL_WELCOME_PROMPT_FIELD, route.nonce);
  const prompt = submitted.fields.fields.has(promptFieldId)
    ? submitted.fields.getTextInputValue(promptFieldId).trim()
    : "";

  if (!prompt) return { receipt: invalid(route.locale, "channels_welcome_prompt_required_detail") };
  if (!channelId || !(await channelIsAvailable(interaction, channelId, dependencies))) {
    return { receipt: invalid(route.locale, "channels_invalid_channel_detail") };
  }
  if (!personaValue) return { receipt: invalid(route.locale, "channels_welcome_persona_required_detail") };

  let welcomePersonaId: number | null = null;
  if (personaValue !== "random") {
    const parsedPersonaId = /^[1-9]\d*$/.test(personaValue) ? Number(personaValue) : Number.NaN;
    const selectedPersona = Number.isSafeInteger(parsedPersonaId)
      ? scope.personas.find((persona) => persona.persona_id === parsedPersonaId)
      : undefined;
    if (!selectedPersona) {
      return {
        receipt: receipt(
          route.locale,
          "error",
          "channels_invalid_input_heading",
          "channels_welcome_persona_invalid_detail",
        ),
      };
    }
    welcomePersonaId = parsedPersonaId;
  }

  const currentChannelId = state.config.welcome_channel_disc_id ?? null;
  const currentPrompt = state.config.welcome_prompt ?? null;
  const currentPersonaId = state.config.welcome_persona_id ?? null;
  if (currentChannelId === channelId && currentPrompt === prompt && currentPersonaId === welcomePersonaId) {
    return { receipt: receipt(route.locale, "info", "state_no_changes_heading", "state_no_changes_detail") };
  }

  const updated = await configRepository.updateWelcomeConfig(state.server_id, {
    welcome_channel_disc_id: channelId,
    welcome_prompt: prompt,
    welcome_persona_id: welcomePersonaId,
  });
  if (!updated) return { receipt: receipt(route.locale, "error", "write_failed_heading", "write_failed_detail") };
  invalidateTomoriStateCache(scope.serverDiscId);
  return {
    receipt: receipt(route.locale, "success", "channels_welcome_updated_heading", "channels_welcome_updated_detail"),
    telemetry: "server-config.workspace.welcome-channel.set",
  };
}

type ChannelOverrideWriteRoute = Extract<
  ConfigPanelRoute,
  {
    action:
      | "channels-overrides-prompt-submit"
      | "channels-overrides-prompt-clear"
      | "channels-overrides-context-note-submit"
      | "channels-overrides-text-model-submit"
      | "channels-overrides-text-clear";
  }
>;

type ChannelOverrideTextNavigationRoute = Extract<
  ConfigPanelRoute,
  {
    action: "channels-overrides-text-open";
  }
>;

async function repaintChannelOverrides(
  interaction: GlobalRoutableInteraction,
  locale: string,
  scope: ConfigScope,
  dependencies: ConfigRouteDependencies,
  channelId: string | null,
  receiptValue?: ConfigRepaintOptions["receipt"],
  view?: ConfigPanelView,
): Promise<void> {
  await repaint(interaction, {
    locale,
    scope,
    category: "channels",
    page: "overrides",
    selectedPersonaId: null,
    channelsSelectedChannelId: channelId,
    receipt: receiptValue,
    view,
    dependencies,
  });
}

async function runChannelOverrideWrite(
  interaction: GlobalRoutableInteraction,
  route: ChannelOverrideWriteRoute,
  scope: ConfigScope,
  dependencies: ConfigRouteDependencies,
): Promise<ChannelWriteOutcome> {
  const state = stateFromScope(scope);
  if (!state) return { receipt: receipt(route.locale, "error", "write_failed_heading", "write_failed_detail") };

  const view = await dependencies.loadChannelsView(interaction, route.channelId);
  const target = channelOverrideTarget(view, route.channelId, CHANNEL_OVERRIDE_TYPES);
  if (!target) return { receipt: invalid(route.locale, "channels_overrides_invalid_channel_detail") };
  if (channelOverridesFingerprint(state, route.channelId, view) !== route.fp) {
    return { receipt: staleReceipt(route.locale) };
  }

  if (route.action === "channels-overrides-prompt-clear") {
    if (!view.overrides.prompt) {
      return { receipt: receipt(route.locale, "info", "state_no_changes_heading", "state_no_changes_detail") };
    }
    const ok = await channelPromptRepo.deleteChannelPromptOverride(state.server_id, route.channelId);
    if (!ok) return { receipt: receipt(route.locale, "error", "write_failed_heading", "write_failed_detail") };
    return {
      receipt: receipt(
        route.locale,
        "success",
        "channels_overrides_prompt_cleared_heading",
        "channels_overrides_prompt_cleared_detail",
      ),
      telemetry: "server-config.workspace.channel-prompt.clear",
    };
  }

  if (route.action === "channels-overrides-prompt-submit") {
    const submitted = modal(interaction);
    const prompt = combineModalPromptParts(
      CONFIG_CHANNEL_OVERRIDE_PROMPT_PART_FIELDS.map((field) =>
        modalTextValue(submitted, buildConfigModalFieldId(field, route.nonce)),
      ),
      4000,
    );
    const modeValue = dependencies.takeSelectValue(
      submitted.id,
      buildConfigModalFieldId(CONFIG_CHANNEL_OVERRIDE_MODE_FIELD, route.nonce),
    );
    const mode: ChannelPromptMode | null = modeValue === "append" || modeValue === "replace" ? modeValue : null;
    if (!mode) return { receipt: invalid(route.locale, "channels_overrides_prompt_mode_invalid_detail") };

    if (!prompt) {
      if (!view.overrides.prompt) {
        return { receipt: receipt(route.locale, "info", "state_no_changes_heading", "state_no_changes_detail") };
      }
      const ok = await channelPromptRepo.deleteChannelPromptOverride(state.server_id, route.channelId);
      if (!ok) return { receipt: receipt(route.locale, "error", "write_failed_heading", "write_failed_detail") };
      return {
        receipt: receipt(
          route.locale,
          "success",
          "channels_overrides_prompt_cleared_heading",
          "channels_overrides_prompt_cleared_detail",
        ),
        telemetry: "server-config.workspace.channel-prompt.clear",
      };
    }

    if (view.overrides.prompt?.prompt === prompt && view.overrides.prompt.mode === mode) {
      return { receipt: receipt(route.locale, "info", "state_no_changes_heading", "state_no_changes_detail") };
    }
    const ok = await channelPromptRepo.setChannelPromptOverride(state.server_id, route.channelId, prompt, mode);
    if (!ok) return { receipt: receipt(route.locale, "error", "write_failed_heading", "write_failed_detail") };
    return {
      receipt: receipt(
        route.locale,
        "success",
        "channels_overrides_prompt_updated_heading",
        "channels_overrides_prompt_updated_detail",
      ),
      telemetry: "server-config.workspace.channel-prompt.set",
    };
  }

  if (route.action === "channels-overrides-context-note-submit") {
    if (!CONTEXT_NOTE_CHANNEL_TYPES.has(target.type)) {
      return { receipt: invalid(route.locale, "channels_overrides_invalid_channel_detail") };
    }
    const submitted = modal(interaction);
    const note = modalTextValue(
      submitted,
      buildConfigModalFieldId(CONFIG_CHANNEL_OVERRIDE_CONTEXT_NOTE_TEXT_FIELD, route.nonce),
    ).trim();
    const rawDepth = modalTextValue(
      submitted,
      buildConfigModalFieldId(CONFIG_CHANNEL_OVERRIDE_CONTEXT_NOTE_DEPTH_FIELD, route.nonce),
    ).trim();
    const depth = /^\d+$/.test(rawDepth) ? Number(rawDepth) : Number.NaN;
    if (note.length > CONTEXT_NOTE_MAX_LENGTH || !Number.isSafeInteger(depth) || depth > CONTEXT_NOTE_DEPTH_MAX) {
      return { receipt: invalid(route.locale, "channels_overrides_context_note_invalid_detail") };
    }

    if (!note) {
      if (!view.overrides.contextNote) {
        return { receipt: receipt(route.locale, "info", "state_no_changes_heading", "state_no_changes_detail") };
      }
      const ok = await channelContextNoteRepo.deleteChannelContextNote(state.server_id, route.channelId);
      if (!ok) return { receipt: receipt(route.locale, "error", "write_failed_heading", "write_failed_detail") };
      return {
        receipt: receipt(
          route.locale,
          "success",
          "channels_overrides_context_note_cleared_heading",
          "channels_overrides_context_note_cleared_detail",
        ),
        telemetry: "server-config.workspace.channel-context-note.clear",
      };
    }

    if (view.overrides.contextNote?.note === note && view.overrides.contextNote.depth === depth) {
      return { receipt: receipt(route.locale, "info", "state_no_changes_heading", "state_no_changes_detail") };
    }
    const ok = await channelContextNoteRepo.setChannelContextNote(state.server_id, route.channelId, note, depth);
    if (!ok) return { receipt: receipt(route.locale, "error", "write_failed_heading", "write_failed_detail") };
    return {
      receipt: receipt(
        route.locale,
        "success",
        "channels_overrides_context_note_updated_heading",
        "channels_overrides_context_note_updated_detail",
      ),
      telemetry: "server-config.workspace.channel-context-note.set",
    };
  }

  const textRoute = route;
  if (textRoute.action === "channels-overrides-text-clear") {
    if (!view.overrides.textModelOverride) {
      return { receipt: receipt(route.locale, "info", "state_no_changes_heading", "state_no_changes_detail") };
    }
    const result = await dependencies.operations.setTextModelOverride({
      scope: "channel",
      serverId: state.server_id,
      channelId: route.channelId,
      llmId: null,
      serverDiscId: scope.serverDiscId,
    });
    return result.status === "success"
      ? {
          receipt: receipt(
            route.locale,
            "success",
            "channels_overrides_text_model_cleared_heading",
            "channels_overrides_text_model_cleared_detail",
          ),
          telemetry: "server-config.workspace.channel-text-model.clear",
        }
      : { receipt: receipt(route.locale, "error", "write_failed_heading", "write_failed_detail") };
  }

  const selectedCodename =
    textRoute.action === "channels-overrides-text-model-submit"
      ? (dependencies.takeSelectValue(
          interaction.id,
          buildConfigModalFieldId(CONFIG_CHANNEL_OVERRIDE_TEXT_MODEL_FIELD, textRoute.nonce),
        ) ?? "")
      : "";
  const savedProviders = await dependencies.loadSavedTextProviders(state.server_id);
  const provider = savedProviders.find((saved) => saved.provider.toLowerCase() === textRoute.provider.toLowerCase());
  if (!provider) return { receipt: staleReceipt(route.locale) };
  const models = await dependencies.loadPersonaTextModels(provider.provider, state.server_id);
  const selectedModel = models.find((model) => model.llm_codename === selectedCodename);
  if (selectedModel?.llm_id === undefined || selectedModel.llm_id === null) {
    return {
      receipt: receipt(
        route.locale,
        "error",
        "channels_overrides_text_model_invalid_heading",
        "channels_overrides_text_model_invalid_detail",
      ),
    };
  }
  if (view.overrides.textModelOverride?.llm_id === selectedModel.llm_id) {
    return { receipt: receipt(route.locale, "info", "state_no_changes_heading", "state_no_changes_detail") };
  }
  const result = await dependencies.operations.setTextModelOverride({
    scope: "channel",
    serverId: state.server_id,
    channelId: route.channelId,
    llmId: selectedModel.llm_id,
    serverDiscId: scope.serverDiscId,
  });
  return result.status === "success"
    ? {
        receipt: receipt(
          route.locale,
          "success",
          "channels_overrides_text_model_updated_heading",
          "channels_overrides_text_model_updated_detail",
        ),
        telemetry: "server-config.workspace.channel-text-model.set",
      }
    : { receipt: receipt(route.locale, "error", "write_failed_heading", "write_failed_detail") };
}

async function handleChannelTextNavigation(
  interaction: GlobalRoutableInteraction,
  route: ChannelOverrideTextNavigationRoute,
  scope: ConfigScope,
  dependencies: ConfigRouteDependencies,
): Promise<void> {
  const state = stateFromScope(scope);
  if (!state) return;
  const view = await dependencies.loadChannelsView(interaction, route.channelId);
  if (!channelOverrideTarget(view, route.channelId, CHANNEL_OVERRIDE_TYPES)) {
    await repaintChannelOverrides(
      interaction,
      route.locale,
      scope,
      dependencies,
      null,
      invalid(route.locale, "channels_overrides_invalid_channel_detail"),
    );
    return;
  }

  const savedProviders = await dependencies.loadSavedTextProviders(state.server_id);
  if (savedProviders.length === 0) {
    await repaintChannelOverrides(
      interaction,
      route.locale,
      scope,
      dependencies,
      route.channelId,
      externalReceipt(
        route.locale,
        "error",
        "commands.model.providerPicker.no_providers_title",
        "commands.model.providerPicker.no_providers_description",
      ),
    );
    return;
  }

  const fp = channelOverridesFingerprint(state, route.channelId, view);
  const panelView: ConfigPanelView = {
    kind: "channel-text-override-provider",
    channelId: route.channelId,
    fp,
    providers: savedProviders.map((saved) => saved.provider),
  };
  await repaintChannelOverrides(interaction, route.locale, scope, dependencies, route.channelId, undefined, panelView);
}

export async function handleConfigChannelModalOpen(
  interaction: GlobalRoutableInteraction,
  route: ConfigPanelRoute,
  dependencies: ConfigRouteDependencies,
  actor: ConfigActor,
): Promise<boolean> {
  if (!CONFIG_CHANNEL_MODAL_OPEN_ACTIONS.has(route.action)) return false;
  if (!isConfigRouteAuthorized(route, actor)) {
    await interaction.reply({
      content: localizer(route.locale, "commands.config.panel.denied_detail"),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const scope = await dependencies.resolveScope(interaction, false);
  const state = scope ? stateFromScope(scope) : null;
  if (!scope || !state) {
    await interaction.reply({
      content: localizer(route.locale, "commands.config.panel.unavailable"),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const nonce = dependencies.createNonce();
  if (
    route.action === "channels-overrides-text-provider-select" ||
    route.action === "channels-overrides-text-model-range-select"
  ) {
    const view = await dependencies.loadChannelsView(interaction, route.channelId);
    const target = channelOverrideTarget(view, route.channelId, CHANNEL_OVERRIDE_TYPES);
    if (!target) {
      await interaction.reply({
        content: overridesInvalidReply(route.locale, "channels_overrides_invalid_channel_detail"),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    const fp = channelOverridesFingerprint(state, target.id, view);
    if (route.fp !== fp) {
      await interaction.reply({
        content: localizer(route.locale, "commands.config.panel.stale_detail"),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const savedProviders = await dependencies.loadSavedTextProviders(state.server_id);
    const submittedProvider =
      route.action === "channels-overrides-text-provider-select"
        ? interaction.isStringSelectMenu()
          ? (interaction.values[0] ?? "")
          : ""
        : route.provider;
    const provider = savedProviders.find(
      (saved) => saved.provider.toLowerCase() === submittedProvider.toLowerCase(),
    )?.provider;
    if (!provider) {
      await interaction.reply({
        content: localizer(route.locale, "commands.config.panel.stale_detail"),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const models = await dependencies.loadPersonaTextModels(provider, state.server_id);
    if (models.length === 0) {
      await interaction.reply({
        content: localizer(route.locale, "commands.model.text.no_models_description"),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const requestedStart =
      route.action === "channels-overrides-text-model-range-select"
        ? Number.parseInt(interaction.isStringSelectMenu() ? (interaction.values[0] ?? "") : "", 10)
        : 0;
    if (route.action === "channels-overrides-text-provider-select" && models.length > CONFIG_MODEL_PAGE_SIZE) {
      await interaction.deferUpdate();
      await repaintChannelOverrides(interaction, route.locale, scope, dependencies, route.channelId, undefined, {
        kind: "channel-text-override-model-range",
        channelId: route.channelId,
        fp,
        provider,
        modelCount: models.length,
        rangePageIndex: 0,
      });
      return true;
    }
    const selectedRangeValue = interaction.isStringSelectMenu() ? (interaction.values[0] ?? "") : "";
    if (route.action === "channels-overrides-text-model-range-select" && selectedRangeValue.startsWith("__range__")) {
      const pageCount = Math.ceil(models.length / CONFIG_MODEL_PAGE_SIZE);
      const rangePageIndex = Number.parseInt(selectedRangeValue.slice("__range__".length), 10);
      if (!Number.isInteger(rangePageIndex) || rangePageIndex < 0 || rangePageIndex >= pageCount) {
        await interaction.reply({
          content: localizer(route.locale, "commands.config.panel.stale_detail"),
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
      await interaction.deferUpdate();
      await repaintChannelOverrides(interaction, route.locale, scope, dependencies, route.channelId, undefined, {
        kind: "channel-text-override-model-range",
        channelId: route.channelId,
        fp,
        provider,
        modelCount: models.length,
        rangePageIndex,
      });
      return true;
    }
    if (
      !Number.isInteger(requestedStart) ||
      requestedStart < 0 ||
      requestedStart % CONFIG_MODEL_PAGE_SIZE !== 0 ||
      requestedStart >= models.length
    ) {
      await interaction.reply({
        content: localizer(route.locale, "commands.config.panel.stale_detail"),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    await dependencies.showModal(
      interaction,
      buildConfigChannelTextModelModal(
        route.locale,
        route.channelId,
        provider,
        fp,
        nonce,
        models.slice(requestedStart, requestedStart + CONFIG_MODEL_PAGE_SIZE),
        view.overrides.textModelOverride?.llm_id,
      ),
    );
  } else if (
    route.action === "channels-overrides-prompt-open" ||
    route.action === "channels-overrides-context-note-open"
  ) {
    const view = await dependencies.loadChannelsView(interaction, route.channelId);
    const allowedTypes =
      route.action === "channels-overrides-prompt-open" ? CHANNEL_OVERRIDE_TYPES : CONTEXT_NOTE_CHANNEL_TYPES;
    const target = channelOverrideTarget(view, route.channelId, allowedTypes);
    if (!target) {
      await interaction.reply({
        content: overridesInvalidReply(route.locale, "channels_overrides_invalid_channel_detail"),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    const fp = channelOverridesFingerprint(state, target.id, view);
    if (route.action === "channels-overrides-prompt-open") {
      await dependencies.showModal(
        interaction,
        buildConfigChannelPromptModal(
          route.locale,
          target.id,
          fp,
          nonce,
          view.overrides.prompt?.prompt ?? null,
          view.overrides.prompt?.mode ?? null,
        ),
      );
    } else {
      await dependencies.showModal(
        interaction,
        buildConfigChannelContextNoteModal(
          route.locale,
          target.id,
          fp,
          nonce,
          view.overrides.contextNote?.note ?? null,
          view.overrides.contextNote?.depth ?? null,
        ),
      );
    }
  } else if (route.action === "channels-log-open") {
    await dependencies.showModal(interaction, buildConfigLogChannelModal(route.locale, nonce));
  } else if (route.action === "channels-welcome-open" || route.action === "channels-welcome-range-select") {
    await dependencies.showModal(
      interaction,
      buildConfigWelcomeModal(
        route.locale,
        nonce,
        scope.personas,
        state.config.welcome_prompt ?? null,
        state.config.welcome_persona_id ?? null,
        personaRangeStart(interaction),
      ),
    );
  } else if (route.action === "channels-autoch-manage-open") {
    const channelsView = await dependencies.loadChannelsView(interaction);
    const availableChannels = channelsView.availableTextChannels;
    if (availableChannels.length === 0) {
      await interaction.reply({
        content: localizer(route.locale, "commands.config.panel.channels_auto_trigger_no_channels"),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    const requestedRange = route.start ?? 0;
    const selectedRange =
      Number.isInteger(requestedRange) && requestedRange >= 0
        ? Math.min(requestedRange, rangeCount(availableChannels.length) - 1)
        : 0;
    const selectedIds = visibleAutochatChannelIds(state, availableChannels);
    await dependencies.showModal(
      interaction,
      buildConfigAutoTriggerChannelsModal(
        route.locale,
        nonce,
        selectedRange,
        autoTriggerFingerprint(state, availableChannels),
        rangeChannels(availableChannels, selectedRange),
        selectedIds,
      ),
    );
  } else if (route.action === "channels-autoch-configure-open" || route.action === "channels-autoch-range-select") {
    const channelsView = await dependencies.loadChannelsView(interaction);
    if (channelsView.availableTextChannels.length === 0) {
      await interaction.reply({
        content: localizer(route.locale, "commands.config.panel.channels_auto_trigger_no_channels"),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    // Its persona select carries no Random entry, so an empty roster would build a zero-option
    // select and Discord would reject the whole modal rather than the one control.
    if (scope.personas.length === 0) {
      await interaction.reply({
        content: localizer(route.locale, "commands.config.panel.no_personas"),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    await dependencies.showModal(
      interaction,
      buildConfigAutoTriggerConfigureModal(
        route.locale,
        nonce,
        autoTriggerFingerprint(state, channelsView.availableTextChannels),
        scope.personas,
        null,
        false,
        null,
        personaRangeStart(interaction),
      ),
    );
  } else if (route.action === "channels-autoch-threshold-open") {
    const channelsView = await dependencies.loadChannelsView(interaction);
    await dependencies.showModal(
      interaction,
      buildConfigAutoTriggerThresholdModal(
        route.locale,
        nonce,
        state.config.autoch_threshold ?? 0,
        state.config.autoch_threshold_max ?? state.config.autoch_threshold ?? 0,
        autoTriggerFingerprint(state, channelsView.availableTextChannels),
      ),
    );
  } else if (
    route.action === "channels-private-manage-open" ||
    route.action === "channels-rp-manage-open" ||
    route.action === "channels-blocklist-manage-open"
  ) {
    await openChannelRulesModal(interaction, route, state, dependencies);
  }
  return true;
}

export interface ConfigChannelRouteContext {
  interaction: GlobalRoutableInteraction;
  route: ConfigPanelRoute;
  scope: ConfigScope;
  dependencies: ConfigRouteDependencies;
}

export async function handleConfigChannelRoutes(context: ConfigChannelRouteContext): Promise<boolean> {
  const { interaction, route, scope, dependencies } = context;
  if (
    !CONFIG_CHANNEL_DIRECT_ACTIONS.has(route.action) &&
    !CONFIG_CHANNEL_MODAL_SUBMIT_ACTIONS.has(route.action) &&
    !CONFIG_CHANNEL_NAVIGATION_ACTIONS.has(route.action) &&
    !CONFIG_CHANNEL_OVERRIDE_NAVIGATION_ACTIONS.has(route.action) &&
    !CONFIG_CHANNEL_OVERRIDE_TEXT_WRITE_ACTIONS.has(route.action)
  ) {
    return false;
  }

  const selectedValue =
    interaction.isStringSelectMenu() || interaction.isChannelSelectMenu() ? (interaction.values[0] ?? null) : null;
  if (route.action === "channels-overrides-select") {
    const refreshed = (await dependencies.resolveScope(interaction, true)) ?? scope;
    await repaintChannelOverrides(interaction, route.locale, refreshed, dependencies, selectedValue);
    return true;
  }

  if (route.action === "channels-overrides-text-open") {
    await handleChannelTextNavigation(interaction, route, scope, dependencies);
    return true;
  }

  if (route.action === "channels-autoch-page") {
    const refreshed = (await dependencies.resolveScope(interaction, true)) ?? scope;
    await repaintAutoTrigger(interaction, route, refreshed, dependencies, route.start);
    return true;
  }

  if (
    route.action === "channels-private-page" ||
    route.action === "channels-rp-page" ||
    route.action === "channels-blocklist-page"
  ) {
    const refreshed = (await dependencies.resolveScope(interaction, true)) ?? scope;
    await repaintChannelRules(
      interaction,
      route,
      refreshed,
      dependencies,
      channelRulesCollectionFromPage(route.action),
      route.start,
    );
    return true;
  }

  const writeScope =
    route.action === "channels-overrides-text-model-submit"
      ? ((await dependencies.resolveScope(interaction, true)) ?? scope)
      : scope;
  const outcome =
    route.action === "channels-overrides-prompt-submit" ||
    route.action === "channels-overrides-prompt-clear" ||
    route.action === "channels-overrides-context-note-submit" ||
    route.action === "channels-overrides-text-model-submit" ||
    route.action === "channels-overrides-text-clear"
      ? await runChannelOverrideWrite(interaction, route, writeScope, dependencies)
      : await runChannelWrite(interaction, route, writeScope, dependencies);
  const refreshed = (await dependencies.resolveScope(interaction, true)) ?? scope;
  if (outcome.telemetry && refreshed.internalServerId) {
    dependencies.recordAction({
      action: outcome.telemetry,
      serverId: refreshed.internalServerId,
      userDiscId: interaction.user.id,
    });
  }
  if (
    route.action === "channels-autoch-submit" ||
    route.action === "channels-autoch-configure-submit" ||
    route.action === "channels-autoch-threshold-submit"
  ) {
    await repaintAutoTrigger(
      interaction,
      route,
      refreshed,
      dependencies,
      route.action === "channels-autoch-submit" ? route.start : 0,
      outcome.receipt,
    );
  } else if (
    route.action === "channels-private-submit" ||
    route.action === "channels-rp-submit" ||
    route.action === "channels-blocklist-submit"
  ) {
    await repaintChannelRules(
      interaction,
      route,
      refreshed,
      dependencies,
      channelRulesCollection(route.action),
      route.start,
      outcome.receipt,
    );
  } else if (
    route.action === "channels-overrides-prompt-submit" ||
    route.action === "channels-overrides-prompt-clear" ||
    route.action === "channels-overrides-context-note-submit" ||
    route.action === "channels-overrides-text-model-submit" ||
    route.action === "channels-overrides-text-clear"
  ) {
    await repaintChannelOverrides(interaction, route.locale, refreshed, dependencies, route.channelId, outcome.receipt);
  } else {
    await repaintDestinations(interaction, route, refreshed, dependencies, outcome.receipt);
  }
  return true;
}
