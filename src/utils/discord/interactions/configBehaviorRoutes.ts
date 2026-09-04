import { ChannelType, MessageFlags, type ModalSubmitInteraction } from "discord.js";
import type { PanelAction } from "@/constants/panelActions";
import { CooldownType, type RandomTriggerRow, type TomoriState } from "@/types/db/schema";
import type { ServerStmConfigRow } from "@/types/db/schema";
import { TOOL_NOTICE_DEFINITIONS, isToolNoticeKey, type ToolNoticeKey } from "@/constants/toolNotices";
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
import { getShortTermMemoriesForServer } from "@/utils/cache/shortTermMemoryCache";
import { shortTermMemoryRepository } from "@/utils/db/repositories/ShortTermMemoryRepository";
import { buildWorkaroundConfigWritePlan, WORKAROUND_DEFINITIONS } from "@/utils/discord/workaroundConfigMapping";
import {
  DELIBERATE_TOOL_TRIGGER_TARGETS,
  getToolNamesForDeliberateTriggerTarget,
  normalizeDeliberateToolRegexTrigger,
  normalizeDeliberateToolTrigger,
  resolveDeliberateToolContextTurns,
  type DeliberateToolTrigger,
  type DeliberateToolTriggerMap,
} from "@/utils/tools/deliberateToolMode";
import { slugifyLabel } from "@/utils/text/slugifyLabel";
import { MAX_MESSAGES_PER_CHANNEL } from "@/utils/cache/shortTermMemoryCache";
import { DEFAULT_STM_TOOL_DESCRIPTION } from "@/tools/functionCalls/updateShortTermMemoryTool";
import { SEED_CATEGORY_UPDATE_HINT, SEED_SUMMARY_UPDATE_HINT } from "@/utils/text/context/memories";
import {
  BEHAVIOR_CHANNEL_MEMORY_FIELD,
  BEHAVIOR_MEMORY_TAGGING_FIELD,
  BEHAVIOR_NOTICE_GROUP_PREFIX,
  BEHAVIOR_SEND_LIMIT_FIELD,
  BEHAVIOR_STM_CATEGORY_PREFIX,
  BEHAVIOR_STM_CONTENT_DEPTH_FIELD,
  BEHAVIOR_STM_CRUDE_MESSAGES_FIELD,
  BEHAVIOR_STM_NUDGE_DEPTH_FIELD,
  BEHAVIOR_STM_REFRESH_CADENCE_FIELD,
  BEHAVIOR_STM_RENDER_MODE_FIELD,
  BEHAVIOR_STM_TOOL_DESCRIPTION_FIELD,
  BEHAVIOR_STM_UPDATE_NUDGE_FIELD,
  BEHAVIOR_TOOL_CONTEXT_FIELD,
  BEHAVIOR_TOOL_TRIGGER_LITERAL_FIELD,
  BEHAVIOR_TOOL_TRIGGER_REMOVE_GROUP_PREFIX,
  BEHAVIOR_TOOL_TRIGGER_REGEX_FIELD,
  BEHAVIOR_TOOL_TRIGGER_TARGET_FIELD,
  BEHAVIOR_WORKAROUND_GROUP_PREFIX,
  buildBehaviorMemoryTaggingModal,
  buildBehaviorNoticeVisibilityModal,
  buildBehaviorSendLimitModal,
  buildBehaviorStmCategoriesModal,
  buildBehaviorStmParametersModal,
  buildBehaviorStmPromptModal,
  buildBehaviorToolContextModal,
  buildBehaviorToolTriggerAddModal,
  buildBehaviorToolTriggerRemoveModal,
  buildBehaviorWorkaroundsModal,
} from "@/utils/discord/ui/configBehaviorModals";

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

export const CONFIG_BEHAVIOR_D10_MODAL_OPEN_ACTIONS = new Set<ConfigPanelRoute["action"]>([
  "behavior-tool-context-open",
  "behavior-tool-trigger-add-open",
  "behavior-tool-trigger-remove-open",
  "behavior-send-limit-open",
  "behavior-workarounds-open",
  "behavior-notice-visibility-open",
  "behavior-memory-tagging-open",
  "behavior-stm-parameters-open",
  "behavior-stm-categories-open",
  "behavior-stm-prompt-open",
]);

export const CONFIG_BEHAVIOR_D10_MODAL_SUBMIT_ACTIONS = new Set<ConfigPanelRoute["action"]>([
  "behavior-tool-context-submit",
  "behavior-tool-trigger-add-submit",
  "behavior-tool-trigger-remove-submit",
  "behavior-send-limit-submit",
  "behavior-workarounds-submit",
  "behavior-notice-visibility-submit",
  "behavior-memory-tagging-submit",
  "behavior-stm-parameters-submit",
  "behavior-stm-categories-submit",
  "behavior-stm-prompt-submit",
]);

export const CONFIG_BEHAVIOR_D10_DIRECT_ACTIONS = new Set<ConfigPanelRoute["action"]>([
  "behavior-tool-mode-set",
  "behavior-self-debug-set",
  "behavior-speech-transcripts-set",
]);

const MAX_TOOL_TRIGGER_ENTRIES = 50;
const MAX_NOTICE_ENTRIES = 50;
export const MAX_WORKAROUND_ENTRIES = 50;

function fallbackD10View(state: TomoriState) {
  return {
    experimental: {
      deliberateToolMode: state.config.deliberate_tool_mode ?? false,
      deliberateToolContextTurns: resolveDeliberateToolContextTurns(state.config.deliberate_tool_context_turns),
      deliberateToolTriggers: state.config.deliberate_tool_triggers ?? {},
      sendLimit: state.config.send_message_limit ?? 0,
      selfDebugEnabled: state.config.self_debug_enabled ?? false,
      workarounds: { verbatim_tool_calling_enabled: state.config.verbatim_tool_calling_enabled ?? false },
    },
    notices: {
      hiddenNoticeKeys: (state.config.tool_notice_hidden_keys ?? []).filter(isToolNoticeKey),
      speechTranscriptsEnabled: state.config.voice_transcript_chat_mode ?? true,
    },
    memory: {
      memoryTaggingEnabled: state.config.memory_tagging_enabled ?? false,
      channelMemoryEnabled: state.config.channel_memory_enabled ?? false,
      stmConfig: null,
      stmCategories: [],
    },
  };
}

async function d10View(state: TomoriState, dependencies: ConfigRouteDependencies) {
  const loaded = dependencies.loadBehaviorView ? await dependencies.loadBehaviorView(state) : undefined;
  const fallback = fallbackD10View(state);
  return {
    experimental: loaded?.experimental ?? fallback.experimental,
    notices: loaded?.notices ?? fallback.notices,
    memory: loaded?.memory ?? fallback.memory,
  };
}

export async function handleConfigBehaviorD10ModalOpen(
  interaction: GlobalRoutableInteraction,
  route: ConfigPanelRoute,
  dependencies: ConfigRouteDependencies,
  actor: ConfigActor,
): Promise<boolean> {
  if (!CONFIG_BEHAVIOR_D10_MODAL_OPEN_ACTIONS.has(route.action)) return false;
  if (!isConfigRouteAuthorized(route, actor)) {
    await interaction.reply({
      content: localizer(route.locale, "commands.config.panel.denied_detail"),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }
  const scope = await dependencies.resolveScope(interaction, false);
  const state = scope?.personas[0];
  if (!scope || !state) {
    await interaction.reply({
      content: localizer(route.locale, "commands.config.panel.unavailable"),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }
  const view = await d10View(state, dependencies);
  const nonce = dependencies.createNonce();
  switch (route.action) {
    case "behavior-tool-context-open":
      await dependencies.showModal(
        interaction,
        buildBehaviorToolContextModal(route.locale, nonce, view.experimental.deliberateToolContextTurns),
      );
      break;
    case "behavior-tool-trigger-add-open":
      await dependencies.showModal(interaction, buildBehaviorToolTriggerAddModal(route.locale, nonce));
      break;
    case "behavior-tool-trigger-remove-open": {
      const entryCount = triggerEntries(view.experimental.deliberateToolTriggers).length;
      if (entryCount === 0) {
        await interaction.reply({
          content: localizer(route.locale, "commands.config.panel.tool_trigger_none_detail"),
          flags: MessageFlags.Ephemeral,
        });
        break;
      }
      if (entryCount > MAX_TOOL_TRIGGER_ENTRIES) {
        await interaction.reply({
          content: localizer(route.locale, "commands.config.panel.tool_trigger_over_capacity_detail", {
            count: entryCount,
            max: MAX_TOOL_TRIGGER_ENTRIES,
          }),
          flags: MessageFlags.Ephemeral,
        });
        break;
      }
      await dependencies.showModal(
        interaction,
        buildBehaviorToolTriggerRemoveModal(route.locale, nonce, view.experimental.deliberateToolTriggers),
      );
      break;
    }
    case "behavior-send-limit-open":
      await dependencies.showModal(
        interaction,
        buildBehaviorSendLimitModal(route.locale, nonce, view.experimental.sendLimit),
      );
      break;
    case "behavior-workarounds-open":
      if (WORKAROUND_DEFINITIONS.length > MAX_WORKAROUND_ENTRIES) {
        await interaction.reply({
          content: `${localizer(route.locale, "commands.config.workarounds.too_many_title")}\n${localizer(
            route.locale,
            "commands.config.workarounds.too_many_description",
            {
              count: WORKAROUND_DEFINITIONS.length,
              max_entries: MAX_WORKAROUND_ENTRIES,
              max_groups: MAX_WORKAROUND_ENTRIES / 10,
            },
          )}`,
          flags: MessageFlags.Ephemeral,
        });
        break;
      }
      await dependencies.showModal(
        interaction,
        buildBehaviorWorkaroundsModal(route.locale, nonce, {
          verbatim_tool_calling: view.experimental.workarounds.verbatim_tool_calling_enabled,
        }),
      );
      break;
    case "behavior-notice-visibility-open":
      if (TOOL_NOTICE_DEFINITIONS.length > MAX_NOTICE_ENTRIES) {
        await interaction.reply({
          content: `${localizer(route.locale, "commands.config.notice-embeds.visibility.too_many_title")}\n${localizer(
            route.locale,
            "commands.config.notice-embeds.visibility.too_many_description",
            {
              count: TOOL_NOTICE_DEFINITIONS.length,
              max_entries: MAX_NOTICE_ENTRIES,
              max_groups: MAX_NOTICE_ENTRIES / 10,
            },
          )}`,
          flags: MessageFlags.Ephemeral,
        });
        break;
      }
      await dependencies.showModal(
        interaction,
        buildBehaviorNoticeVisibilityModal(route.locale, nonce, view.notices.hiddenNoticeKeys),
      );
      break;
    case "behavior-memory-tagging-open":
      await dependencies.showModal(
        interaction,
        buildBehaviorMemoryTaggingModal(
          route.locale,
          nonce,
          view.memory.memoryTaggingEnabled,
          view.memory.channelMemoryEnabled,
        ),
      );
      break;
    case "behavior-stm-parameters-open": {
      const stmConfig = await shortTermMemoryRepository.getStmConfig(state.server_id);
      await dependencies.showModal(interaction, buildBehaviorStmParametersModal(route.locale, nonce, stmConfig));
      break;
    }
    case "behavior-stm-categories-open": {
      const categories = await shortTermMemoryRepository.getStmCategories(state.server_id);
      const activeScopes = stmActiveScopes(scope.serverDiscId);
      const affected = activeScopes.length
        ? activeScopes.map((entry) => `<#${entry.channelId}>`).join(", ")
        : localizer(route.locale, "commands.choices.none");
      await dependencies.showModal(
        interaction,
        buildBehaviorStmCategoriesModal(route.locale, nonce, categories, {
          disclosure: localizer(route.locale, "commands.config.panel.stm_categories_disclosure_modal", {
            scope: affected,
          }),
        }),
      );
      break;
    }
    case "behavior-stm-prompt-open": {
      const [stmConfig, categories] = await Promise.all([
        shortTermMemoryRepository.getStmConfig(state.server_id),
        shortTermMemoryRepository.getStmCategories(state.server_id),
      ]);
      const categoryMode =
        categories.length > 1 || (categories.length === 1 && categories[0]?.label.toLowerCase() !== "summary");
      await dependencies.showModal(
        interaction,
        buildBehaviorStmPromptModal(
          route.locale,
          nonce,
          stmConfig?.tool_description_override ?? DEFAULT_STM_TOOL_DESCRIPTION,
          stmConfig?.update_nudge_override ?? (categoryMode ? SEED_CATEGORY_UPDATE_HINT : SEED_SUMMARY_UPDATE_HINT),
        ),
      );
      break;
    }
  }
  return true;
}

function triggerStoredKey(trigger: DeliberateToolTrigger): string {
  return typeof trigger === "string" ? `literal:${trigger}` : `${trigger.type}:${trigger.value}`;
}

function triggerMapFingerprint(triggerMap: DeliberateToolTriggerMap): string {
  return Object.entries(triggerMap)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([target, triggers]) => `${target}:${triggers.map(triggerStoredKey).sort().join(",")}`)
    .join("|");
}

function parseToolTriggerInput(
  interaction: ModalSubmitInteraction,
  route: Extract<ConfigPanelRoute, { action: "behavior-tool-trigger-add-submit" }>,
  target: string | undefined,
): { target: string; trigger: DeliberateToolTrigger } | null {
  const literal = normalizeDeliberateToolTrigger(
    interaction.fields.getTextInputValue(buildConfigModalFieldId(BEHAVIOR_TOOL_TRIGGER_LITERAL_FIELD, route.nonce)),
  );
  const regex = normalizeDeliberateToolRegexTrigger(
    interaction.fields.getTextInputValue(buildConfigModalFieldId(BEHAVIOR_TOOL_TRIGGER_REGEX_FIELD, route.nonce)),
  );
  if (!target || !DELIBERATE_TOOL_TRIGGER_TARGETS.some((candidate) => candidate.value === target)) return null;
  if ((literal && regex) || (!literal && !regex)) return null;
  if (regex) {
    try {
      new RegExp(regex, "iu");
    } catch {
      return null;
    }
    return { target, trigger: { type: "regex", value: regex } };
  }
  return { target, trigger: literal };
}

function triggerEntries(triggerMap: DeliberateToolTriggerMap): Array<{
  id: string;
  target: string;
  trigger: DeliberateToolTrigger;
}> {
  return Object.entries(triggerMap).flatMap(([target, triggers]) =>
    triggers.map((trigger, index) => ({ id: `${target}_${index}`, target, trigger })),
  );
}

function stmActiveScopes(serverDiscId: string): Array<{ channelId: string; personaId: number | null }> {
  return Array.from(
    new Map(
      getShortTermMemoriesForServer(serverDiscId).map((entry) => [
        `${entry.channelId}\0${entry.personaId ?? ""}`,
        { channelId: entry.channelId, personaId: entry.personaId ?? null },
      ]),
    ).values(),
  );
}

function parseStmCategoryInputs(interaction: ModalSubmitInteraction, nonce: string) {
  const categories: Array<{ position: number; label: string; description: string }> = [];
  const slugs = new Set<string>();
  for (let index = 0; index < 5; index += 1) {
    const raw = interaction.fields
      .getTextInputValue(buildConfigModalFieldId(`${BEHAVIOR_STM_CATEGORY_PREFIX}${index}`, nonce))
      .trim();
    if (!raw) continue;
    const colonIndex = raw.indexOf(":");
    if (colonIndex < 0) return null;
    const label = raw.slice(0, colonIndex).trim();
    const description = raw.slice(colonIndex + 1).trim();
    const slug = slugifyLabel(label);
    if (!label || !description || !slug || slugs.has(slug)) return null;
    slugs.add(slug);
    categories.push({ position: categories.length, label, description });
  }
  if (categories.length === 0) {
    categories.push({
      position: 0,
      label: "summary",
      description: "A running summary of recent events, topics, and context from this conversation.",
    });
  }
  return categories;
}

function stmCategoryFingerprint(
  categories: readonly { position: number; label: string; description: string }[],
): string {
  return categories.map((category) => `${category.position}:${category.label}:${category.description}`).join("|");
}

async function runD10Write(
  interaction: GlobalRoutableInteraction,
  route: ConfigPanelRoute,
  scope: ConfigScope,
  dependencies: ConfigRouteDependencies,
): Promise<BehaviorWriteOutcome | null> {
  const state = stateFromScope(scope);
  if (!state) return null;
  const repositories = await import("@/utils/db/repositories");
  const locale = route.locale;
  if (
    route.action === "behavior-tool-mode-set" ||
    route.action === "behavior-self-debug-set" ||
    route.action === "behavior-speech-transcripts-set"
  ) {
    const current =
      route.action === "behavior-tool-mode-set"
        ? (state.config.deliberate_tool_mode ?? false)
        : route.action === "behavior-self-debug-set"
          ? (state.config.self_debug_enabled ?? false)
          : (state.config.voice_transcript_chat_mode ?? true);
    if (current === route.enabled)
      return { receipt: receipt(locale, "info", "state_no_changes_heading", "state_no_changes_detail") };
    const updated =
      route.action === "behavior-tool-mode-set"
        ? await repositories.configRepository.updateTriggerBehaviorConfig(state.server_id, {
            deliberate_tool_mode: route.enabled,
          })
        : route.action === "behavior-self-debug-set"
          ? await repositories.configRepository.updateChatConfig(state.server_id, { self_debug_enabled: route.enabled })
          : await repositories.configRepository.updateSpeechConfig(state.server_id, {
              voice_transcript_chat_mode: route.enabled,
            });
    if (!updated) return { receipt: writeFailed(locale) };
    invalidateTomoriStateCache(scope.serverDiscId);
    return {
      receipt: receipt(locale, "success", "state_updated_heading", "state_updated_detail"),
      telemetry:
        route.action === "behavior-tool-mode-set"
          ? "server-config.workspace.deliberate-tool-mode.set"
          : route.action === "behavior-self-debug-set"
            ? "server-config.workspace.self-debug.set"
            : "server-config.workspace.speech-transcripts.set",
    };
  }
  if (!CONFIG_BEHAVIOR_D10_MODAL_SUBMIT_ACTIONS.has(route.action)) return null;
  const submitted = modal(interaction);
  if (route.action === "behavior-tool-context-submit") {
    const value = parseInteger(getText(submitted, BEHAVIOR_TOOL_CONTEXT_FIELD, route.nonce), 0, 10);
    if (value === null) return { receipt: invalid(locale, "tool_context_invalid_detail", { min: 0, max: 10 }) };
    const current = resolveDeliberateToolContextTurns(state.config.deliberate_tool_context_turns);
    if (value === current && state.config.deliberate_tool_context_turns !== null)
      return { receipt: receipt(locale, "info", "state_no_changes_heading", "state_no_changes_detail") };
    const updated = await repositories.configRepository.updateTriggerBehaviorConfig(state.server_id, {
      deliberate_tool_context_turns: value,
    });
    if (!updated) return { receipt: writeFailed(locale) };
    invalidateTomoriStateCache(scope.serverDiscId);
    return {
      receipt: receipt(locale, "success", "state_updated_heading", "state_updated_detail"),
      telemetry: "server-config.workspace.deliberate-tool-context.set",
    };
  }
  if (route.action === "behavior-send-limit-submit") {
    const value = parseInteger(getText(submitted, BEHAVIOR_SEND_LIMIT_FIELD, route.nonce), 0, 40);
    if (value === null) return { receipt: invalid(locale, "send_limit_invalid_detail", { min: 0, max: 40 }) };
    const current = state.config.send_message_limit ?? 0;
    if (value === current)
      return { receipt: receipt(locale, "info", "state_no_changes_heading", "state_no_changes_detail") };
    const updated = await repositories.configRepository.updateChatConfig(state.server_id, {
      send_message_limit: value,
    });
    if (!updated) return { receipt: writeFailed(locale) };
    invalidateTomoriStateCache(scope.serverDiscId);
    return {
      receipt: receipt(locale, "success", "state_updated_heading", "state_updated_detail"),
      telemetry: "server-config.workspace.send-limit.set",
    };
  }
  if (route.action === "behavior-workarounds-submit") {
    const groupCount = Math.ceil(WORKAROUND_DEFINITIONS.length / 10);
    const selected = new Set<string>();
    for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
      const values = dependencies.takeCheckboxValues(
        submitted.id,
        buildConfigModalFieldId(`${BEHAVIOR_WORKAROUND_GROUP_PREFIX}_${groupIndex}`, route.nonce),
      );
      if (values === undefined) return { receipt: staleReceipt(locale) };
      for (const value of values) selected.add(value);
    }
    const plan = buildWorkaroundConfigWritePlan(state.config, selected);
    if (plan.changes.length === 0)
      return { receipt: receipt(locale, "info", "state_no_changes_heading", "state_no_changes_detail") };
    const updated = await repositories.configRepository[plan.method](state.server_id, plan.patch);
    if (!updated) return { receipt: writeFailed(locale) };
    invalidateTomoriStateCache(scope.serverDiscId);
    return {
      receipt: receipt(locale, "success", "state_updated_heading", "state_updated_detail"),
      telemetry: "server-config.workspace.workarounds.set",
    };
  }
  if (route.action === "behavior-notice-visibility-submit") {
    const groupCount = Math.ceil(TOOL_NOTICE_DEFINITIONS.length / 10);
    const checked = new Set<ToolNoticeKey>();
    for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
      const values = dependencies.takeCheckboxValues(
        submitted.id,
        buildConfigModalFieldId(`${BEHAVIOR_NOTICE_GROUP_PREFIX}_${groupIndex}`, route.nonce),
      );
      if (values === undefined) return { receipt: staleReceipt(locale) };
      for (const value of values) {
        if (isToolNoticeKey(value)) checked.add(value);
      }
    }
    const hidden = TOOL_NOTICE_DEFINITIONS.filter((definition) => !checked.has(definition.key)).map(
      (definition) => definition.key,
    );
    const current = (state.config.tool_notice_hidden_keys ?? []).filter(isToolNoticeKey);
    const currentSet = new Set(current);
    if (hidden.length === currentSet.size && hidden.every((key) => currentSet.has(key)))
      return { receipt: receipt(locale, "info", "state_no_changes_heading", "state_no_changes_detail") };
    const updated = await repositories.configRepository.updateNoticeEmbedsConfig(state.server_id, {
      tool_notice_hidden_keys: hidden,
    });
    if (!updated) return { receipt: writeFailed(locale) };
    invalidateTomoriStateCache(scope.serverDiscId);
    return {
      receipt: receipt(locale, "success", "state_updated_heading", "state_updated_detail"),
      telemetry: "server-config.workspace.notice-visibility.set",
    };
  }
  if (route.action === "behavior-memory-tagging-submit") {
    // The legacy command's blacklist branch only rejected non-managers. The D10 manager-only
    // policy rejects those actors before this operation, while retaining the manager bypass.
    const memoryValue = dependencies.takeSelectValue(
      submitted.id,
      buildConfigModalFieldId(BEHAVIOR_MEMORY_TAGGING_FIELD, route.nonce),
    );
    const channelValue = dependencies.takeSelectValue(
      submitted.id,
      buildConfigModalFieldId(BEHAVIOR_CHANNEL_MEMORY_FIELD, route.nonce),
    );
    if ((memoryValue !== "true" && memoryValue !== "false") || (channelValue !== "true" && channelValue !== "false"))
      return { receipt: invalid(locale, "memory_tagging_invalid_detail") };
    const memoryTaggingEnabled = memoryValue === "true";
    const channelMemoryEnabled = channelValue === "true";
    if (
      memoryTaggingEnabled === (state.config.memory_tagging_enabled ?? false) &&
      channelMemoryEnabled === (state.config.channel_memory_enabled ?? false)
    )
      return { receipt: receipt(locale, "info", "state_no_changes_heading", "state_no_changes_detail") };
    const updated = await repositories.configRepository.updateMemoryConfig(state.server_id, {
      memory_tagging_enabled: memoryTaggingEnabled,
      channel_memory_enabled: channelMemoryEnabled,
    });
    if (!updated) return { receipt: writeFailed(locale) };
    invalidateTomoriStateCache(scope.serverDiscId);
    return {
      receipt: receipt(locale, "success", "state_updated_heading", "state_updated_detail"),
      telemetry: "server-config.workspace.memory-tagging.set",
    };
  }
  if (route.action === "behavior-tool-trigger-add-submit") {
    const triggerMap: DeliberateToolTriggerMap = Object.fromEntries(
      Object.entries(state.config.deliberate_tool_triggers ?? {}).map(([key, values]) => [key, [...values]]),
    );
    if (Object.keys(triggerMap).some((target) => getToolNamesForDeliberateTriggerTarget(target).length === 0))
      return { receipt: invalid(locale, "tool_trigger_invalid_detail") };
    const parsed = parseToolTriggerInput(
      submitted,
      route,
      dependencies.takeSelectValue(
        submitted.id,
        buildConfigModalFieldId(BEHAVIOR_TOOL_TRIGGER_TARGET_FIELD, route.nonce),
      ),
    );
    if (!parsed) {
      return { receipt: invalid(locale, "tool_trigger_invalid_detail") };
    }
    if (getToolNamesForDeliberateTriggerTarget(parsed.target).length === 0)
      return { receipt: invalid(locale, "tool_trigger_invalid_detail") };
    const current = triggerMap[parsed.target] ?? [];
    if (current.some((candidate) => triggerStoredKey(candidate) === triggerStoredKey(parsed.trigger)))
      return { receipt: invalid(locale, "tool_trigger_duplicate_detail") };
    if (current.length >= 16) return { receipt: invalid(locale, "tool_trigger_limit_detail", { max: 16 }) };
    triggerMap[parsed.target] = [...current, parsed.trigger].sort((left, right) =>
      triggerStoredKey(left).localeCompare(triggerStoredKey(right)),
    );
    if (triggerMapFingerprint(triggerMap) === triggerMapFingerprint(state.config.deliberate_tool_triggers ?? {}))
      return { receipt: receipt(locale, "info", "state_no_changes_heading", "state_no_changes_detail") };
    const updated = await repositories.configRepository.updateTriggerBehaviorConfig(state.server_id, {
      deliberate_tool_triggers: triggerMap,
    });
    if (!updated) return { receipt: writeFailed(locale) };
    invalidateTomoriStateCache(scope.serverDiscId);
    return {
      receipt: receipt(locale, "success", "state_updated_heading", "state_updated_detail"),
      telemetry: "server-config.workspace.deliberate-tool-trigger.set",
    };
  }
  if (route.action === "behavior-tool-trigger-remove-submit") {
    const triggerMap: DeliberateToolTriggerMap = Object.fromEntries(
      Object.entries(state.config.deliberate_tool_triggers ?? {}).map(([key, values]) => [key, [...values]]),
    );
    const existingEntries = triggerEntries(triggerMap);
    if (existingEntries.length === 0)
      return { receipt: receipt(locale, "info", "state_no_changes_heading", "state_no_changes_detail") };
    if (existingEntries.length > MAX_TOOL_TRIGGER_ENTRIES)
      return {
        receipt: invalid(locale, "tool_trigger_over_capacity_detail", {
          count: existingEntries.length,
          max: MAX_TOOL_TRIGGER_ENTRIES,
        }),
      };
    if (Object.keys(triggerMap).some((target) => getToolNamesForDeliberateTriggerTarget(target).length === 0))
      return { receipt: invalid(locale, "tool_trigger_invalid_detail") };
    const checked = new Set<string>();
    for (let groupIndex = 0; groupIndex < Math.ceil(existingEntries.length / 10); groupIndex += 1) {
      const values = dependencies.takeCheckboxValues(
        submitted.id,
        buildConfigModalFieldId(`${BEHAVIOR_TOOL_TRIGGER_REMOVE_GROUP_PREFIX}_${groupIndex}`, route.nonce),
      );
      if (values === undefined) return { receipt: staleReceipt(locale) };
      for (const value of values) checked.add(value);
    }
    const entriesToRemove = existingEntries.filter((entry) => !checked.has(entry.id));
    if (entriesToRemove.length === 0)
      return { receipt: receipt(locale, "info", "state_no_changes_heading", "state_no_changes_detail") };
    for (const entry of entriesToRemove) {
      const next = (triggerMap[entry.target] ?? []).filter(
        (candidate) => triggerStoredKey(candidate) !== triggerStoredKey(entry.trigger),
      );
      if (next.length > 0) triggerMap[entry.target] = next;
      else delete triggerMap[entry.target];
    }
    const updated = await repositories.configRepository.updateTriggerBehaviorConfig(state.server_id, {
      deliberate_tool_triggers: triggerMap,
    });
    if (!updated) return { receipt: writeFailed(locale) };
    invalidateTomoriStateCache(scope.serverDiscId);
    return {
      receipt: receipt(locale, "success", "state_updated_heading", "state_updated_detail"),
      telemetry: "server-config.workspace.deliberate-tool-trigger.set",
    };
  }
  if (route.action === "behavior-stm-parameters-submit") {
    const cadence = parseInteger(getText(submitted, BEHAVIOR_STM_REFRESH_CADENCE_FIELD, route.nonce), 1, 100);
    const crude = parseInteger(
      getText(submitted, BEHAVIOR_STM_CRUDE_MESSAGES_FIELD, route.nonce),
      1,
      MAX_MESSAGES_PER_CHANNEL,
    );
    const nudge = parseInteger(getText(submitted, BEHAVIOR_STM_NUDGE_DEPTH_FIELD, route.nonce), 0, 20);
    const content = parseInteger(getText(submitted, BEHAVIOR_STM_CONTENT_DEPTH_FIELD, route.nonce), -1, 20);
    const mode = dependencies.takeSelectValue(
      submitted.id,
      buildConfigModalFieldId(BEHAVIOR_STM_RENDER_MODE_FIELD, route.nonce),
    );
    if (
      cadence === null ||
      crude === null ||
      nudge === null ||
      content === null ||
      (mode !== "supersede" && mode !== "crude_summary")
    )
      return { receipt: invalid(locale, "stm_parameters_invalid_detail") };
    const updated = await shortTermMemoryRepository.upsertStmConfig(state.server_id, {
      refresh_cadence: cadence,
      render_mode: mode as ServerStmConfigRow["render_mode"],
      crude_message_count: crude,
      nudge_injection_depth: nudge,
      content_injection_depth: content,
    });
    if (!updated) return { receipt: writeFailed(locale) };
    return {
      receipt: receipt(locale, "success", "state_updated_heading", "state_updated_detail"),
      telemetry: "server-config.workspace.stm-parameters.set",
    };
  }
  if (route.action === "behavior-stm-prompt-submit") {
    const toolDescription = getText(submitted, BEHAVIOR_STM_TOOL_DESCRIPTION_FIELD, route.nonce).trim() || null;
    const updateNudge = getText(submitted, BEHAVIOR_STM_UPDATE_NUDGE_FIELD, route.nonce).trim() || null;
    const updated = await shortTermMemoryRepository.upsertStmConfig(state.server_id, {
      tool_description_override: toolDescription,
      update_nudge_override: updateNudge,
    });
    if (!updated) return { receipt: writeFailed(locale) };
    return {
      receipt: receipt(locale, "success", "state_updated_heading", "state_updated_detail"),
      telemetry: "server-config.workspace.stm-prompt.set",
    };
  }
  if (route.action === "behavior-stm-categories-submit") {
    const categories = parseStmCategoryInputs(submitted, route.nonce);
    if (!categories) return { receipt: invalid(locale, "stm_categories_invalid_detail") };
    const currentCategories = await shortTermMemoryRepository.getStmCategories(state.server_id);
    if (stmCategoryFingerprint(categories) === stmCategoryFingerprint(currentCategories))
      return { receipt: receipt(locale, "info", "state_no_changes_heading", "state_no_changes_detail") };
    const activeScopes = stmActiveScopes(scope.serverDiscId);
    const updated = await shortTermMemoryRepository.upsertStmCategories(state.server_id, categories);
    if (!updated) return { receipt: writeFailed(locale) };
    for (const entry of activeScopes) {
      shortTermMemoryRepository.clearForServerChannel(scope.serverDiscId, entry.channelId, entry.personaId);
    }
    return {
      receipt: receipt(locale, "success", "state_updated_heading", "state_updated_detail"),
      telemetry: "server-config.workspace.stm-categories.set",
    };
  }
  return null;
}

export async function handleConfigBehaviorD10Routes(context: ConfigBehaviorRouteContext): Promise<boolean> {
  const { interaction, route, scope, dependencies } = context;
  if (
    !CONFIG_BEHAVIOR_D10_DIRECT_ACTIONS.has(route.action) &&
    !CONFIG_BEHAVIOR_D10_MODAL_SUBMIT_ACTIONS.has(route.action)
  )
    return false;
  const outcome = await runD10Write(interaction, route, scope, dependencies);
  if (!outcome) return false;
  const refreshed = (await dependencies.resolveScope(interaction, true)) ?? scope;
  if (outcome.telemetry && refreshed.internalServerId) {
    dependencies.recordAction({
      action: outcome.telemetry,
      serverId: refreshed.internalServerId,
      userDiscId: interaction.user.id,
    });
  }
  const page =
    route.action.startsWith("behavior-stm-") ||
    route.action === "behavior-memory-tagging-open" ||
    route.action === "behavior-memory-tagging-submit"
      ? "memory"
      : route.action.startsWith("behavior-notice") || route.action.startsWith("behavior-speech")
        ? "notices"
        : "experimental";
  await repaint(interaction, {
    locale: route.locale,
    scope: refreshed,
    category: "behavior",
    page,
    selectedPersonaId: null,
    receipt: outcome.receipt,
    dependencies,
  });
  return true;
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
