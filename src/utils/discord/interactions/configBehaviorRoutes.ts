import { ChannelType, MessageFlags, type ModalSubmitInteraction } from "discord.js";
import type { PanelAction } from "@/constants/panelActions";
import { CooldownType, type RandomTriggerRow, type TomoriState } from "@/types/db/schema";
import {
  computeRandomTriggerRemoveFingerprint,
  CONFIG_RANDOM_TRIGGER_CHECKBOX_CAPACITY,
  CONFIG_RANDOM_TRIGGER_CHECKBOX_GROUP_SIZE,
  type ConfigPanelRoute,
} from "@/utils/discord/configPanelCatalog";
import { invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { isConfigRouteAuthorized, type ConfigActor } from "@/utils/discord/interactions/configPermissionPolicy";
import {
  repaint,
  staleReceipt,
  type ConfigBehaviorGeneralView,
  type ConfigBehaviorTriggerView,
  type ConfigRepaintOptions,
  type ConfigRouteDependencies,
  type ConfigScope,
} from "@/utils/discord/interactions/configRouteContext";
import type { GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import { buildConfigModalFieldId, CONFIG_PERSONA_PROMPT_PART_FIELDS } from "@/utils/discord/ui/configModals";
import {
  BEHAVIOR_CASCADE_LIMIT_FIELD,
  BEHAVIOR_COOLDOWN_LENGTH_FIELD,
  BEHAVIOR_COOLDOWN_TYPE_FIELD,
  BEHAVIOR_FETCH_LIMIT_FIELD,
  BEHAVIOR_HUMANIZER_FIELD,
  BEHAVIOR_MATCH_LIMIT_FIELD,
  BEHAVIOR_PRESET_FIELD,
  BEHAVIOR_RANDOM_CHANNEL_FIELD,
  BEHAVIOR_RANDOM_PERSONA_FIELD,
  BEHAVIOR_RANDOM_PROMPT_FIELD,
  BEHAVIOR_RANDOM_RESPOND_SELF_FIELD,
  BEHAVIOR_RANDOM_SETTINGS_FIELD,
  BEHAVIOR_TIMEZONE_FIELD,
  buildBehaviorContextNoteModal,
  buildBehaviorCooldownModal,
  buildBehaviorFetchModal,
  buildBehaviorHumanizerModal,
  buildBehaviorLimitsModal,
  buildBehaviorPresetModal,
  buildBehaviorPromptModal,
  buildBehaviorRandomAddModal,
  buildBehaviorRandomRemoveModal,
  buildBehaviorTimezoneModal,
} from "@/utils/discord/ui/configBehaviorModals";
import { CONTEXT_NOTE_DEPTH_MAX } from "@/utils/discord/contextNoteOptions";
import {
  DEFAULT_MESSAGE_FETCH_LIMIT,
  MAX_MESSAGE_FETCH_LIMIT,
  MIN_MESSAGE_FETCH_LIMIT,
} from "@/utils/discord/messageFetchLimit";
import { HUMANIZER_DEFAULT, HUMANIZER_MAX, HUMANIZER_MIN, getHumanizerLabel } from "@/utils/discord/humanizerOptions";
import { DEFAULT_SYSTEM_PROMPT } from "@/utils/text/contextBuilder";
import { combineModalPromptParts } from "@/utils/text/modalPromptParts";
import { formatUTCOffset, UTC_OFFSET_MAX, UTC_OFFSET_MIN } from "@/utils/text/timezoneHelper";
import { localizer } from "@/utils/text/localizer";

export const CONFIG_BEHAVIOR_MODAL_OPEN_ACTIONS = new Set<ConfigPanelRoute["action"]>([
  "behavior-prompt-open",
  "behavior-preset-open",
  "behavior-context-open",
  "behavior-humanizer-open",
  "behavior-fetch-open",
  "behavior-timezone-open",
  "behavior-random-add-open",
  "behavior-random-remove-open",
  "behavior-random-remove-select",
  "behavior-limits-open",
  "behavior-cooldown-open",
]);

export const CONFIG_BEHAVIOR_SELECT_ACTIONS = new Set<ConfigPanelRoute["action"]>(["behavior-random-remove-select"]);

export const CONFIG_BEHAVIOR_MODAL_SUBMIT_ACTIONS = new Set<ConfigPanelRoute["action"]>([
  "behavior-prompt-submit",
  "behavior-preset-submit",
  "behavior-context-submit",
  "behavior-humanizer-submit",
  "behavior-fetch-submit",
  "behavior-timezone-submit",
  "behavior-random-add-submit",
  "behavior-random-remove-submit",
  "behavior-limits-submit",
  "behavior-cooldown-submit",
]);

const RANDOM_TRIGGER_MAX_PER_SERVER = Number.parseInt(process.env.RANDOM_TRIGGER_MAX_PER_SERVER ?? "10", 10);
const RANDOM_PERSONA_VALUE = "random";
const RANDOM_TRIGGER_PAGE_SIZE = CONFIG_RANDOM_TRIGGER_CHECKBOX_CAPACITY;

function receipt(
  locale: string,
  tone: "success" | "info" | "warning" | "error",
  heading: string,
  detail: string,
  vars: Record<string, string | number> = {},
) {
  return {
    tone,
    heading: localizer(locale, `commands.config.panel.${heading}`),
    detail: localizer(locale, `commands.config.panel.${detail}`, vars),
  } as const;
}

function writeFailed(locale: string) {
  return receipt(locale, "error", "write_failed_heading", "write_failed_detail");
}

function invalid(locale: string, detail: string, vars: Record<string, string | number> = {}) {
  return receipt(locale, "error", "invalid_input_heading", detail, vars);
}

function modal(interaction: GlobalRoutableInteraction): ModalSubmitInteraction {
  return interaction as ModalSubmitInteraction;
}

function stateFromScope(scope: ConfigScope): TomoriState | null {
  return scope.personas[0] ?? null;
}

function fallbackBehaviorView(state: TomoriState): {
  general: ConfigBehaviorGeneralView;
  trigger: ConfigBehaviorTriggerView;
} {
  return {
    general: {
      systemPrompt: state.config.system_prompt ?? null,
      contextNote: state.config.context_note ?? null,
      contextNoteDepth: state.config.context_note_depth ?? 0,
      humanizerDegree: HUMANIZER_DEFAULT,
      messageFetchLimit: state.config.message_fetch_limit ?? DEFAULT_MESSAGE_FETCH_LIMIT,
      timezoneOffset: state.config.timezone_offset ?? 0,
    },
    trigger: {
      randomTriggers: [],
      cascadeLimit: state.config.cascade_limit ?? 3,
      matchLimit: state.config.match_limit ?? 3,
      deliberateTriggerMode: state.config.deliberate_trigger_mode ?? false,
      alwaysReplyEnabled: state.config.always_reply_enabled ?? false,
      cooldownType: state.config.cooldown_type ?? CooldownType.OFF,
      cooldownLength: state.config.cooldown_length ?? 5,
    },
  };
}

async function behaviorView(
  scope: ConfigScope,
  dependencies: ConfigRouteDependencies,
): Promise<{ general: ConfigBehaviorGeneralView; trigger: ConfigBehaviorTriggerView } | null> {
  const state = stateFromScope(scope);
  if (!state) return null;
  return dependencies.loadBehaviorView ? dependencies.loadBehaviorView(state) : fallbackBehaviorView(state);
}

async function repaintBehavior(
  interaction: GlobalRoutableInteraction,
  scope: ConfigScope,
  route: ConfigPanelRoute,
  dependencies: ConfigRouteDependencies,
  receiptValue?: ConfigRepaintOptions["receipt"],
): Promise<void> {
  const refreshed = (await dependencies.resolveScope(interaction, true)) ?? scope;
  await repaint(interaction, {
    locale: route.locale,
    scope: refreshed,
    category: "behavior",
    page:
      route.action.startsWith("behavior-") && route.action.includes("random")
        ? "trigger"
        : route.action.includes("dtm") ||
            route.action.includes("always") ||
            route.action.includes("cooldown") ||
            route.action.includes("limits")
          ? "trigger"
          : "general",
    selectedPersonaId: null,
    receipt: receiptValue,
    randomTriggerPageStart: "start" in route ? route.start : undefined,
    dependencies,
  });
}

function getText(modalInteraction: ModalSubmitInteraction, field: string, nonce: string): string {
  const id = buildConfigModalFieldId(field, nonce);
  return modalInteraction.fields.fields.has(id) ? modalInteraction.fields.getTextInputValue(id) : "";
}

function parseInteger(value: string, min: number, max: number): number | null {
  if (!/^-?\d+$/.test(value.trim())) return null;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function parseRandomSettings(raw: string): {
  timerHours: number;
  chancePercent: number;
  randomOffsetRange: number | null;
  silenceThresholdHours: number | null;
  failureThreshold: number | null;
} | null {
  const [timerRaw, chanceRaw, offsetRaw = "", silenceRaw = "", failureRaw = ""] = raw
    .split(",")
    .map((value) => value.trim());
  const timerHours = parseInteger(timerRaw, 1, Number.MAX_SAFE_INTEGER);
  const chancePercent = parseInteger(chanceRaw, 1, 100);
  if (timerHours === null || chancePercent === null) return null;
  const optional = (value: string, minimum: number): number | null | undefined => {
    if (!value) return null;
    return parseInteger(value, minimum, Number.MAX_SAFE_INTEGER) ?? undefined;
  };
  const randomOffsetRange = optional(offsetRaw, 0);
  const silenceThresholdHours = optional(silenceRaw, 1);
  const failureThreshold = optional(failureRaw, 1);
  if (randomOffsetRange === undefined || silenceThresholdHours === undefined || failureThreshold === undefined)
    return null;
  return { timerHours, chancePercent, randomOffsetRange, silenceThresholdHours, failureThreshold };
}

function triggerRows(triggers: readonly RandomTriggerRow[]): Array<RandomTriggerRow & { trigger_id: number }> {
  return triggers.filter(
    (trigger): trigger is RandomTriggerRow & { trigger_id: number } => trigger.trigger_id !== undefined,
  );
}

/**
 * Modal-open routes use the modal response as their acknowledgement. The state read supplies
 * defaults and the submit route re-resolves everything before it writes.
 */
export async function handleConfigBehaviorModalOpen(
  interaction: GlobalRoutableInteraction,
  route: ConfigPanelRoute,
  dependencies: ConfigRouteDependencies,
  actor: ConfigActor,
): Promise<boolean> {
  if (!CONFIG_BEHAVIOR_MODAL_OPEN_ACTIONS.has(route.action)) return false;
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
  const view = await behaviorView(scope, dependencies);
  const nonce = dependencies.createNonce();
  if (route.action === "behavior-prompt-open") {
    await dependencies.showModal(
      interaction,
      buildBehaviorPromptModal(route.locale, nonce, view?.general.systemPrompt),
    );
  } else if (route.action === "behavior-preset-open") {
    const presets = await (await import("@/utils/db/repositories")).configRepository.loadSystemPromptPresets();
    if (!presets?.length) {
      await interaction.reply({
        content: localizer(route.locale, "commands.config.prompt.preset.no_presets_description"),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    await dependencies.showModal(interaction, buildBehaviorPresetModal(route.locale, nonce, presets));
  } else if (route.action === "behavior-context-open") {
    await dependencies.showModal(
      interaction,
      buildBehaviorContextNoteModal(
        route.locale,
        nonce,
        view?.general.contextNote,
        view?.general.contextNoteDepth ?? 0,
      ),
    );
  } else if (route.action === "behavior-humanizer-open") {
    await dependencies.showModal(
      interaction,
      buildBehaviorHumanizerModal(route.locale, nonce, view?.general.humanizerDegree ?? HUMANIZER_DEFAULT),
    );
  } else if (route.action === "behavior-fetch-open") {
    await dependencies.showModal(
      interaction,
      buildBehaviorFetchModal(route.locale, nonce, view?.general.messageFetchLimit ?? DEFAULT_MESSAGE_FETCH_LIMIT),
    );
  } else if (route.action === "behavior-timezone-open") {
    await dependencies.showModal(
      interaction,
      buildBehaviorTimezoneModal(route.locale, nonce, view?.general.timezoneOffset ?? 0),
    );
  } else if (route.action === "behavior-limits-open") {
    await dependencies.showModal(
      interaction,
      buildBehaviorLimitsModal(route.locale, nonce, view?.trigger.cascadeLimit ?? 3, view?.trigger.matchLimit ?? 3),
    );
  } else if (route.action === "behavior-cooldown-open") {
    await dependencies.showModal(
      interaction,
      buildBehaviorCooldownModal(
        route.locale,
        nonce,
        view?.trigger.cooldownType ?? 0,
        view?.trigger.cooldownLength ?? 5,
      ),
    );
  } else if (route.action === "behavior-random-add-open") {
    const count = view?.trigger.randomTriggers.length ?? 0;
    if (count >= RANDOM_TRIGGER_MAX_PER_SERVER) {
      await interaction.reply({
        content: localizer(route.locale, "commands.config.random-trigger.add.cap_reached_description", {
          max: RANDOM_TRIGGER_MAX_PER_SERVER,
        }),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    await dependencies.showModal(interaction, buildBehaviorRandomAddModal(route.locale, nonce, scope.personas));
  } else if (route.action === "behavior-random-remove-open" || route.action === "behavior-random-remove-select") {
    const rows = triggerRows(view?.trigger.randomTriggers ?? []);
    if (rows.length === 0) {
      await interaction.reply({
        content: localizer(route.locale, "commands.config.random-trigger.remove.none_description"),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    if (
      route.action === "behavior-random-remove-open" &&
      rows.length > RANDOM_TRIGGER_PAGE_SIZE &&
      route.start === undefined
    ) {
      await interaction.reply({
        content: localizer(route.locale, "commands.config.panel.random_trigger_page_required_detail"),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    const requestedStart =
      route.action === "behavior-random-remove-select"
        ? Number.parseInt(interaction.isStringSelectMenu() ? (interaction.values[0] ?? "") : "", 10)
        : (route.start ?? 0);
    if (!Number.isInteger(requestedStart) || requestedStart < 0 || requestedStart % RANDOM_TRIGGER_PAGE_SIZE !== 0) {
      await interaction.reply({
        content: localizer(route.locale, "commands.config.panel.stale_detail"),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    const presented = rows.slice(requestedStart, requestedStart + RANDOM_TRIGGER_PAGE_SIZE);
    if (presented.length === 0) {
      await interaction.reply({
        content: localizer(route.locale, "commands.config.panel.stale_detail"),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    await dependencies.showModal(
      interaction,
      buildBehaviorRandomRemoveModal(
        route.locale,
        nonce,
        computeRandomTriggerRemoveFingerprint(state.server_id, rows),
        requestedStart,
        presented,
      ),
    );
  }
  return true;
}

type BehaviorWriteOutcome = { receipt: ConfigRepaintOptions["receipt"]; telemetry?: PanelAction };

async function runGeneralWrite(
  interaction: GlobalRoutableInteraction,
  route: ConfigPanelRoute,
  scope: ConfigScope,
  dependencies: ConfigRouteDependencies,
): Promise<BehaviorWriteOutcome | null> {
  const state = stateFromScope(scope);
  if (!state) return null;
  const modalInteraction = route.action.endsWith("submit") ? modal(interaction) : null;
  const locale = route.locale;
  if (route.action === "behavior-prompt-submit" && modalInteraction) {
    const prompt = combineModalPromptParts(
      CONFIG_PERSONA_PROMPT_PART_FIELDS.map((field) => getText(modalInteraction, field, route.nonce)),
      4000,
    );
    if (!prompt.trim()) return { receipt: invalid(locale, "system_prompt_empty_detail") };
    const updated = await (await import("@/utils/db/repositories")).configRepository.updateChatConfig(state.server_id, {
      system_prompt: prompt,
    });
    if (!updated) return { receipt: writeFailed(locale) };
    invalidateTomoriStateCache(scope.serverDiscId);
    return {
      receipt: receipt(locale, "success", "system_prompt_updated_heading", "system_prompt_updated_detail"),
      telemetry: "server-config.workspace.system-prompt.set",
    };
  }
  if (route.action === "behavior-preset-submit" && modalInteraction) {
    const selectedName = dependencies.takeSelectValue(
      modalInteraction.id,
      buildConfigModalFieldId(BEHAVIOR_PRESET_FIELD, route.nonce),
    );
    const presets = await (await import("@/utils/db/repositories")).configRepository.loadSystemPromptPresets();
    const selected = presets?.find((preset) => preset.system_prompt_preset_name === selectedName);
    if (!selected) return { receipt: staleReceipt(locale) };
    const updated = await (await import("@/utils/db/repositories")).configRepository.updateChatConfig(state.server_id, {
      system_prompt: selected.preset_prompt_text,
    });
    if (!updated) return { receipt: writeFailed(locale) };
    invalidateTomoriStateCache(scope.serverDiscId);
    return {
      receipt: receipt(locale, "success", "system_prompt_updated_heading", "system_prompt_preset_updated_detail", {
        preset: selected.system_prompt_preset_name,
      }),
      telemetry: "server-config.workspace.system-prompt.preset",
    };
  }
  if (route.action === "behavior-prompt-remove") {
    if (!state.config.system_prompt)
      return { receipt: receipt(locale, "info", "system_prompt_no_custom_heading", "system_prompt_no_custom_detail") };
    const updated = await (await import("@/utils/db/repositories")).configRepository.updateChatConfig(state.server_id, {
      system_prompt: null,
    });
    if (!updated) return { receipt: writeFailed(locale) };
    invalidateTomoriStateCache(scope.serverDiscId);
    return {
      receipt: receipt(locale, "success", "system_prompt_cleared_heading", "system_prompt_cleared_detail", {
        default: DEFAULT_SYSTEM_PROMPT.trim(),
      }),
      telemetry: "server-config.workspace.system-prompt.remove",
    };
  }
  if (route.action === "behavior-context-submit" && modalInteraction) {
    const note = getText(modalInteraction, "context_note_text", route.nonce).trim();
    const rawDepth = getText(modalInteraction, "context_note_depth", route.nonce).trim();
    const depth = parseInteger(rawDepth, 0, CONTEXT_NOTE_DEPTH_MAX);
    if (depth === null)
      return { receipt: invalid(locale, "context_note_invalid_depth_detail", { min: 0, max: CONTEXT_NOTE_DEPTH_MAX }) };
    const updated = await (await import("@/utils/db/repositories")).configRepository.updateChatConfig(state.server_id, {
      context_note: note || null,
      context_note_depth: note ? depth : 0,
    });
    if (!updated) return { receipt: writeFailed(locale) };
    invalidateTomoriStateCache(scope.serverDiscId);
    return {
      receipt: receipt(
        locale,
        "success",
        note ? "context_note_updated_heading" : "context_note_cleared_heading",
        note ? "context_note_updated_detail" : "context_note_cleared_detail",
        { depth },
      ),
      telemetry: "server-config.workspace.context-note.set",
    };
  }
  if (route.action === "behavior-humanizer-submit" && modalInteraction) {
    const value = parseInteger(
      getText(modalInteraction, BEHAVIOR_HUMANIZER_FIELD, route.nonce),
      HUMANIZER_MIN,
      HUMANIZER_MAX,
    );
    if (value === null)
      return { receipt: invalid(locale, "humanizer_invalid_detail", { min: HUMANIZER_MIN, max: HUMANIZER_MAX }) };
    const current = (await behaviorView(scope, dependencies))?.general.humanizerDegree ?? HUMANIZER_DEFAULT;
    if (value === current)
      return {
        receipt: receipt(locale, "info", "humanizer_no_changes_heading", "humanizer_no_changes_detail", {
          value: getHumanizerLabel(locale, value),
        }),
      };
    const updated = await (await import("@/utils/db/repositories")).configRepository.updateChatConfig(state.server_id, {
      humanizer_degree: value,
    });
    if (!updated) return { receipt: writeFailed(locale) };
    invalidateTomoriStateCache(scope.serverDiscId);
    return {
      receipt: receipt(locale, "success", "humanizer_updated_heading", "humanizer_updated_detail", {
        value: getHumanizerLabel(locale, value),
      }),
      telemetry: "server-config.workspace.humanizer.set",
    };
  }
  if (route.action === "behavior-fetch-submit" && modalInteraction) {
    const value = parseInteger(
      getText(modalInteraction, BEHAVIOR_FETCH_LIMIT_FIELD, route.nonce),
      MIN_MESSAGE_FETCH_LIMIT,
      MAX_MESSAGE_FETCH_LIMIT,
    );
    if (value === null)
      return {
        receipt: invalid(locale, "fetch_limit_invalid_detail", {
          min: MIN_MESSAGE_FETCH_LIMIT,
          max: MAX_MESSAGE_FETCH_LIMIT,
        }),
      };
    const current = (await behaviorView(scope, dependencies))?.general.messageFetchLimit ?? DEFAULT_MESSAGE_FETCH_LIMIT;
    if (value === current)
      return {
        receipt: receipt(locale, "info", "fetch_limit_no_changes_heading", "fetch_limit_no_changes_detail", { value }),
      };
    const updated = await (await import("@/utils/db/repositories")).configRepository.updateChatConfig(state.server_id, {
      message_fetch_limit: value,
    });
    if (!updated) return { receipt: writeFailed(locale) };
    invalidateTomoriStateCache(scope.serverDiscId);
    return {
      receipt: receipt(locale, "success", "fetch_limit_updated_heading", "fetch_limit_updated_detail", { value }),
      telemetry: "server-config.workspace.message-fetch-limit.set",
    };
  }
  if (route.action === "behavior-timezone-submit" && modalInteraction) {
    const value = Number(getText(modalInteraction, BEHAVIOR_TIMEZONE_FIELD, route.nonce).trim());
    if (!Number.isFinite(value) || value < UTC_OFFSET_MIN || value > UTC_OFFSET_MAX)
      return { receipt: invalid(locale, "timezone_invalid_detail", { min: UTC_OFFSET_MIN, max: UTC_OFFSET_MAX }) };
    const current = (await behaviorView(scope, dependencies))?.general.timezoneOffset ?? 0;
    if (value === current)
      return {
        receipt: receipt(locale, "info", "timezone_no_changes_heading", "timezone_no_changes_detail", {
          value: formatUTCOffset(value),
        }),
      };
    const updated = await (await import("@/utils/db/repositories")).configRepository.updateChatConfig(state.server_id, {
      timezone_offset: value,
    });
    if (!updated) return { receipt: writeFailed(locale) };
    invalidateTomoriStateCache(scope.serverDiscId);
    return {
      receipt: receipt(locale, "success", "timezone_updated_heading", "timezone_updated_detail", {
        value: formatUTCOffset(value),
      }),
      telemetry: "server-config.workspace.timezone.set",
    };
  }
  return null;
}

async function runTriggerWrite(
  interaction: GlobalRoutableInteraction,
  route: ConfigPanelRoute,
  scope: ConfigScope,
  dependencies: ConfigRouteDependencies,
): Promise<BehaviorWriteOutcome | null> {
  const state = stateFromScope(scope);
  if (!state) return null;
  const locale = route.locale;
  const repositories = await import("@/utils/db/repositories");
  if (route.action === "behavior-dtm-set" || route.action === "behavior-always-set") {
    const current =
      route.action === "behavior-dtm-set"
        ? (state.config.deliberate_trigger_mode ?? false)
        : (state.config.always_reply_enabled ?? false);
    if (current === route.enabled)
      return { receipt: receipt(locale, "info", "state_no_changes_heading", "state_no_changes_detail") };
    const patch =
      route.action === "behavior-dtm-set"
        ? { deliberate_trigger_mode: route.enabled }
        : { always_reply_enabled: route.enabled };
    const updated = await repositories.configRepository.updateTriggerBehaviorConfig(state.server_id, patch);
    if (!updated) return { receipt: writeFailed(locale) };
    invalidateTomoriStateCache(scope.serverDiscId);
    return {
      receipt: receipt(locale, "success", "state_updated_heading", "state_updated_detail"),
      telemetry:
        route.action === "behavior-dtm-set"
          ? "server-config.workspace.deliberate-trigger-mode.set"
          : "server-config.workspace.always-reply.set",
    };
  }
  if (route.action === "behavior-limits-submit") {
    const submitted = modal(interaction);
    const cascade = parseInteger(getText(submitted, BEHAVIOR_CASCADE_LIMIT_FIELD, route.nonce), 0, 10);
    const match = parseInteger(getText(submitted, BEHAVIOR_MATCH_LIMIT_FIELD, route.nonce), 1, 10);
    if (cascade === null || match === null) return { receipt: invalid(locale, "matching_limits_invalid_detail") };
    const currentCascade = state.config.cascade_limit ?? 3;
    const currentMatch = state.config.match_limit ?? 3;
    if (cascade === currentCascade && match === currentMatch)
      return {
        receipt: receipt(locale, "info", "matching_limits_no_changes_heading", "matching_limits_no_changes_detail"),
      };
    const updated = await repositories.configRepository.updateChatConfig(state.server_id, {
      cascade_limit: cascade,
      match_limit: match,
    });
    if (!updated) return { receipt: writeFailed(locale) };
    invalidateTomoriStateCache(scope.serverDiscId);
    return {
      receipt: receipt(locale, "success", "matching_limits_updated_heading", "matching_limits_updated_detail", {
        cascade,
        match,
      }),
      telemetry: "server-config.workspace.trigger-limits.set",
    };
  }
  if (route.action === "behavior-cooldown-submit") {
    const submitted = modal(interaction);
    const cooldownType = parseInteger(getText(submitted, BEHAVIOR_COOLDOWN_TYPE_FIELD, route.nonce), 0, 3);
    const cooldownLength = parseInteger(getText(submitted, BEHAVIOR_COOLDOWN_LENGTH_FIELD, route.nonce), 1, 86400);
    if (cooldownType === null || cooldownLength === null)
      return { receipt: invalid(locale, "cooldown_invalid_detail", { min: 1, max: 86400 }) };
    const currentType = state.config.cooldown_type ?? CooldownType.OFF;
    const currentLength = state.config.cooldown_length ?? 5;
    if (cooldownType === currentType && cooldownLength === currentLength)
      return { receipt: receipt(locale, "info", "cooldown_no_changes_heading", "cooldown_no_changes_detail") };
    const updated = await repositories.configRepository.updateTriggerBehaviorConfig(state.server_id, {
      cooldown_type: cooldownType,
      cooldown_length: cooldownLength,
    });
    if (!updated) return { receipt: writeFailed(locale) };
    invalidateTomoriStateCache(scope.serverDiscId);
    return {
      receipt: receipt(locale, "success", "cooldown_updated_heading", "cooldown_updated_detail", {
        length: cooldownLength,
      }),
      telemetry: "server-config.workspace.cooldown.set",
    };
  }
  if (route.action === "behavior-random-add-submit") {
    const submitted = modal(interaction);
    const channelId = dependencies.takeSelectValue(
      submitted.id,
      buildConfigModalFieldId(BEHAVIOR_RANDOM_CHANNEL_FIELD, route.nonce),
    );
    const personaValue = dependencies.takeSelectValue(
      submitted.id,
      buildConfigModalFieldId(BEHAVIOR_RANDOM_PERSONA_FIELD, route.nonce),
    );
    const targetChannel = channelId && interaction.guild?.channels.cache.get(channelId);
    if (!targetChannel || targetChannel.type !== ChannelType.GuildText) return { receipt: staleReceipt(locale) };
    const settings = parseRandomSettings(getText(submitted, BEHAVIOR_RANDOM_SETTINGS_FIELD, route.nonce));
    if (!settings) return { receipt: invalid(locale, "random_trigger_settings_invalid_detail") };
    const personaId =
      !personaValue || personaValue === RANDOM_PERSONA_VALUE
        ? null
        : parseInteger(personaValue, 1, Number.MAX_SAFE_INTEGER);
    if (personaValue !== RANDOM_PERSONA_VALUE && personaId === null) return { receipt: staleReceipt(locale) };
    if (personaId !== null && !scope.personas.some((persona) => persona.persona_id === personaId))
      return { receipt: staleReceipt(locale) };
    const respondValues = dependencies.takeCheckboxValues(
      submitted.id,
      buildConfigModalFieldId(BEHAVIOR_RANDOM_RESPOND_SELF_FIELD, route.nonce),
    );
    const data = {
      serverId: state.server_id,
      channelDiscId: channelId,
      personaId,
      ...settings,
      respondToSelf: respondValues?.includes("yes") === true,
      customPrompt: getText(submitted, BEHAVIOR_RANDOM_PROMPT_FIELD, route.nonce).trim() || null,
    };
    const count = await repositories.serverScheduleRepository.getServerTriggerCount(state.server_id);
    if (count >= RANDOM_TRIGGER_MAX_PER_SERVER)
      return { receipt: invalid(locale, "random_trigger_cap_detail", { max: RANDOM_TRIGGER_MAX_PER_SERVER }) };
    if (personaId !== null) {
      const existing = await repositories.serverScheduleRepository.getTriggerByPersonaAndChannel(
        state.server_id,
        channelId,
        personaId,
      );
      if (existing?.trigger_id !== undefined) {
        const updated = await repositories.serverScheduleRepository.upsertTrigger(existing.trigger_id, data);
        if (!updated) return { receipt: writeFailed(locale) };
        return {
          receipt: receipt(locale, "success", "random_trigger_updated_heading", "random_trigger_updated_detail"),
          telemetry: "server-config.workspace.random-trigger.update",
        };
      }
    }
    const inserted = await repositories.serverScheduleRepository.insertTrigger(data);
    if (!inserted) return { receipt: writeFailed(locale) };
    return {
      receipt: receipt(locale, "success", "random_trigger_added_heading", "random_trigger_added_detail"),
      telemetry: "server-config.workspace.random-trigger.add",
    };
  }
  if (route.action === "behavior-random-remove-submit") {
    const submitted = modal(interaction);
    const live = triggerRows(await repositories.serverScheduleRepository.getServerTriggers(state.server_id));
    if (computeRandomTriggerRemoveFingerprint(state.server_id, live) !== route.fp)
      return { receipt: staleReceipt(locale) };
    if (route.start < 0 || route.start % CONFIG_RANDOM_TRIGGER_CHECKBOX_CAPACITY !== 0 || route.start >= live.length)
      return { receipt: staleReceipt(locale) };
    const presented = live.slice(route.start, route.start + CONFIG_RANDOM_TRIGGER_CHECKBOX_CAPACITY);
    const checked = new Set<number>();
    const groupCount = Math.ceil(presented.length / CONFIG_RANDOM_TRIGGER_CHECKBOX_GROUP_SIZE);
    for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
      const values = dependencies.takeCheckboxValues(
        submitted.id,
        buildConfigModalFieldId(`behavior_random_trigger_${groupIndex}`, route.nonce),
      );
      if (values === undefined) return { receipt: staleReceipt(locale) };
      for (const value of values) {
        const id = Number.parseInt(value, 10);
        if (Number.isSafeInteger(id)) checked.add(id);
      }
    }
    const toRemove = presented.filter((trigger) => !checked.has(trigger.trigger_id));
    if (!toRemove.length)
      return {
        receipt: receipt(locale, "info", "random_trigger_no_changes_heading", "random_trigger_no_changes_detail"),
      };
    const results = await Promise.all(
      toRemove.map((trigger) => repositories.serverScheduleRepository.deleteTrigger(trigger.trigger_id)),
    );
    if (results.some((result) => !result)) return { receipt: writeFailed(locale) };
    return {
      receipt: receipt(locale, "success", "random_trigger_removed_heading", "random_trigger_removed_detail", {
        count: toRemove.length,
      }),
      telemetry: "server-config.workspace.random-trigger.remove",
    };
  }
  return null;
}

export interface ConfigBehaviorRouteContext {
  interaction: GlobalRoutableInteraction;
  route: ConfigPanelRoute;
  scope: ConfigScope;
  dependencies: ConfigRouteDependencies;
}

export async function handleConfigBehaviorRoutes(context: ConfigBehaviorRouteContext): Promise<boolean> {
  const route = context.route;
  if (route.action === "behavior-random-remove-page") {
    await repaintBehavior(context.interaction, context.scope, route, context.dependencies);
    return true;
  }
  const isGeneral =
    route.action.startsWith("behavior-prompt") ||
    route.action.startsWith("behavior-preset") ||
    route.action.startsWith("behavior-context") ||
    route.action.startsWith("behavior-humanizer") ||
    route.action.startsWith("behavior-fetch") ||
    route.action.startsWith("behavior-timezone");
  const outcome = isGeneral
    ? await runGeneralWrite(context.interaction, route, context.scope, context.dependencies)
    : await runTriggerWrite(context.interaction, route, context.scope, context.dependencies);
  if (!outcome) return false;
  const refreshed = (await context.dependencies.resolveScope(context.interaction, true)) ?? context.scope;
  if (outcome.telemetry && refreshed.internalServerId) {
    context.dependencies.recordAction({
      action: outcome.telemetry,
      serverId: refreshed.internalServerId,
      userDiscId: context.interaction.user.id,
    });
  }
  await repaintBehavior(context.interaction, refreshed, route, context.dependencies, outcome.receipt);
  return true;
}
