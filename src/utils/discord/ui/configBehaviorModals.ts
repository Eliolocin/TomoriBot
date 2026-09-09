import { ChannelType, TextInputStyle } from "discord.js";
import type { RandomTriggerRow, SystemPromptPresetRow, TomoriState } from "@/types/db/schema";
import type { ServerStmConfigRow, StmCategoryRow } from "@/types/db/schema";
import { TOOL_NOTICE_DEFINITIONS } from "@/constants/toolNotices";
import { WORKAROUND_DEFINITIONS, type WorkaroundDefinition } from "@/utils/discord/workaroundConfigMapping";
import { DELIBERATE_TOOL_TRIGGER_TARGETS } from "@/utils/tools/deliberateToolMode";
import type { CheckboxGroupOption } from "@/types/discord/modal";
import type { ToolNoticeKey } from "@/constants/toolNotices";
import type { RawDiscordComponent } from "@/types/discord/rawApiTypes";
import type { SelectOption } from "@/types/discord/modal";
import type { DeliberateToolTrigger, DeliberateToolTriggerMap } from "@/utils/tools/deliberateToolMode";
import {
  getCapabilitiesManagePermissionDefinitions,
  type CapabilitiesManageConfigState,
} from "@/utils/discord/manageConfigMapping";
import {
  buildConfigRouteId,
  CONFIG_RANDOM_TRIGGER_CHECKBOX_CAPACITY,
  CONFIG_RANDOM_TRIGGER_CHECKBOX_GROUP_SIZE,
} from "@/utils/discord/configPanelCatalog";
import {
  CONFIG_CONTEXT_NOTE_DEPTH_FIELD,
  CONFIG_CONTEXT_NOTE_TEXT_FIELD,
  CONFIG_PERSONA_PROMPT_PART_FIELDS,
  buildConfigModalFieldId,
} from "@/utils/discord/ui/configModals";
import type { RawModalPayload } from "@/utils/discord/ui/configModals";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import { localizer } from "@/utils/text/localizer";
import { splitPromptIntoModalParts } from "@/utils/text/modalPromptParts";
import { promptPartDescription, promptPartLabel } from "@/utils/discord/ui/modalPromptPartLabels";

export const BEHAVIOR_HUMANIZER_FIELD = "behavior_humanizer";
export const BEHAVIOR_FETCH_LIMIT_FIELD = "behavior_fetch_limit";
export const BEHAVIOR_TIMEZONE_FIELD = "behavior_timezone";
export const BEHAVIOR_CASCADE_LIMIT_FIELD = "behavior_cascade_limit";
export const BEHAVIOR_MATCH_LIMIT_FIELD = "behavior_match_limit";
export const BEHAVIOR_COOLDOWN_TYPE_FIELD = "behavior_cooldown_type";
export const BEHAVIOR_COOLDOWN_LENGTH_FIELD = "behavior_cooldown_length";
export const BEHAVIOR_PRESET_FIELD = "behavior_preset";
export const BEHAVIOR_RANDOM_CHANNEL_FIELD = "behavior_random_channel";
export const BEHAVIOR_RANDOM_PERSONA_FIELD = "behavior_random_persona";
export const BEHAVIOR_RANDOM_SETTINGS_FIELD = "behavior_random_settings";
export const BEHAVIOR_RANDOM_RESPOND_SELF_FIELD = "behavior_random_respond_self";
export const BEHAVIOR_RANDOM_PROMPT_FIELD = "behavior_random_prompt";
export const BEHAVIOR_TOOL_CONTEXT_FIELD = "behavior_tool_context";
export const BEHAVIOR_TOOL_TRIGGER_TARGET_FIELD = "behavior_tool_trigger_target";
export const BEHAVIOR_TOOL_TRIGGER_LITERAL_FIELD = "behavior_tool_trigger_literal";
export const BEHAVIOR_TOOL_TRIGGER_REGEX_FIELD = "behavior_tool_trigger_regex";
export const BEHAVIOR_TOOL_TRIGGER_REMOVE_GROUP_PREFIX = "behavior_tool_trigger_remove_group";
export const BEHAVIOR_SEND_LIMIT_FIELD = "behavior_send_limit";
export const BEHAVIOR_WORKAROUND_GROUP_PREFIX = "behavior_workaround_group";
export const BEHAVIOR_NOTICE_GROUP_PREFIX = "behavior_notice_group";
export const BEHAVIOR_MEMORY_TAGGING_FIELD = "behavior_memory_tagging";
export const BEHAVIOR_CHANNEL_MEMORY_FIELD = "behavior_channel_memory";
export const BEHAVIOR_STM_REFRESH_CADENCE_FIELD = "behavior_stm_refresh_cadence";
export const BEHAVIOR_STM_RENDER_MODE_FIELD = "behavior_stm_render_mode";
export const BEHAVIOR_STM_CRUDE_MESSAGES_FIELD = "behavior_stm_crude_messages";
export const BEHAVIOR_STM_NUDGE_DEPTH_FIELD = "behavior_stm_nudge_depth";
export const BEHAVIOR_STM_CONTENT_DEPTH_FIELD = "behavior_stm_content_depth";
export const BEHAVIOR_STM_CATEGORY_PREFIX = "behavior_stm_category_";
export const BEHAVIOR_STM_TOOL_DESCRIPTION_FIELD = "behavior_stm_tool_description";
export const BEHAVIOR_STM_UPDATE_NUDGE_FIELD = "behavior_stm_update_nudge";
export const CONFIG_PERMISSIONS_CHECKBOX_GROUP_PREFIX = "permissions_capabilities_group";
export const CONFIG_PERMISSIONS_CHECKBOX_GROUP_SIZE = 10;

const LABEL = 18 as const;
const TEXT_INPUT = 4 as const;
const CHANNEL_SELECT = 8 as const;
const STRING_SELECT = 3 as const;
const RADIO_GROUP = 21 as const;
const CHECKBOX_GROUP = 22 as const;

function title(locale: string, key: string): string {
  return safeSelectOptionText(localizer(locale, key), 45);
}

function label(locale: string, key: string): string {
  return safeSelectOptionText(localizer(locale, key), 45);
}

function description(locale: string, key: string): string {
  return safeSelectOptionText(localizer(locale, key), 100);
}

function textField(
  locale: string,
  nonce: string,
  field: string,
  labelKey: string,
  descriptionKey: string,
  style: TextInputStyle,
  required: boolean,
  maxLength: number,
  value?: string,
  placeholderKey?: string,
): RawDiscordComponent {
  return {
    type: LABEL,
    label: label(locale, labelKey),
    description: description(locale, descriptionKey),
    component: {
      type: TEXT_INPUT,
      custom_id: buildConfigModalFieldId(field, nonce),
      style,
      required,
      max_length: maxLength,
      value,
      placeholder: placeholderKey ? safeSelectOptionText(localizer(locale, placeholderKey), 100) : undefined,
    },
  };
}

function selectField(
  locale: string,
  nonce: string,
  field: string,
  labelKey: string,
  descriptionKey: string,
  placeholderKey: string,
  options: SelectOption[],
): RawDiscordComponent {
  return {
    type: LABEL,
    label: label(locale, labelKey),
    description: description(locale, descriptionKey),
    component: {
      type: STRING_SELECT,
      custom_id: buildConfigModalFieldId(field, nonce),
      placeholder: safeSelectOptionText(localizer(locale, placeholderKey), 100),
      required: true,
      options: options.map((option) => ({
        label: safeSelectOptionText(option.label, 100),
        value: safeSelectOptionText(option.value, 100),
        description: option.description ? safeSelectOptionText(option.description, 100) : undefined,
      })),
    },
  };
}

function radioField(
  locale: string,
  nonce: string,
  field: string,
  labelKey: string,
  descriptionKey: string,
  options: Array<{ value: string; label: string; default?: boolean }>,
): RawDiscordComponent {
  return {
    type: LABEL,
    label: label(locale, labelKey),
    description: description(locale, descriptionKey),
    component: {
      type: RADIO_GROUP,
      custom_id: buildConfigModalFieldId(field, nonce),
      required: true,
      options: options.map((option) => ({
        value: option.value,
        label: safeSelectOptionText(option.label, 100),
        default: option.default,
      })),
    },
  };
}

function checkboxGroupField(
  locale: string,
  nonce: string,
  field: string,
  labelKey: string,
  descriptionKey: string,
  options: CheckboxGroupOption[],
): RawDiscordComponent {
  return {
    type: LABEL,
    label: label(locale, labelKey),
    description: description(locale, descriptionKey),
    component: {
      type: CHECKBOX_GROUP,
      custom_id: buildConfigModalFieldId(field, nonce),
      min_values: 0,
      max_values: options.length,
      required: false,
      options: options.map((option) => ({
        value: safeSelectOptionText(option.value, 100),
        label: safeSelectOptionText(option.label, 100),
        description: option.description ? safeSelectOptionText(option.description, 100) : undefined,
        default: option.default,
      })),
    },
  };
}

export function buildConfigPermissionsManageModal(
  locale: string,
  nonce: string,
  includeElevenLabs: boolean,
  config: CapabilitiesManageConfigState,
): RawModalPayload {
  const definitions = getCapabilitiesManagePermissionDefinitions({ includeElevenLabs });
  const groups = Array.from(
    { length: Math.ceil(definitions.length / CONFIG_PERMISSIONS_CHECKBOX_GROUP_SIZE) },
    (_unused, groupIndex) => {
      const definitionsInGroup = definitions.slice(
        groupIndex * CONFIG_PERMISSIONS_CHECKBOX_GROUP_SIZE,
        (groupIndex + 1) * CONFIG_PERMISSIONS_CHECKBOX_GROUP_SIZE,
      );
      return checkboxGroupField(
        locale,
        nonce,
        `${CONFIG_PERMISSIONS_CHECKBOX_GROUP_PREFIX}_${groupIndex}`,
        groupIndex === 0
          ? "commands.config.panel.permissions_capabilities_group_label"
          : "commands.config.panel.permissions_capabilities_group_label_continued",
        "commands.config.panel.permissions_capabilities_group_description",
        definitionsInGroup.map((definition) => ({
          label: localizer(locale, definition.labelKey),
          value: definition.value,
          description: localizer(locale, definition.descKey),
          default: definition.getState(config),
        })),
      );
    },
  );

  return {
    custom_id: buildConfigRouteId({
      action: "permissions-manage-submit",
      locale,
      includeElevenLabs,
      nonce,
    }),
    title: title(locale, "commands.config.panel.permissions_manage_title"),
    components: groups,
  };
}

export function buildBehaviorToolContextModal(locale: string, nonce: string, current: number): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "behavior-tool-context-submit", locale, nonce }),
    title: title(locale, "commands.config.panel.edit_tool_context_button"),
    components: [
      textField(
        locale,
        nonce,
        BEHAVIOR_TOOL_CONTEXT_FIELD,
        "commands.config.panel.tool_context_label",
        "commands.config.panel.tool_context_description",
        TextInputStyle.Short,
        true,
        2,
        String(current),
      ),
    ],
  };
}

function formatTriggerForDisplay(trigger: DeliberateToolTrigger): string {
  return typeof trigger === "string" ? trigger : `/${trigger.value}/`;
}

export function buildBehaviorToolTriggerAddModal(locale: string, nonce: string): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "behavior-tool-trigger-add-submit", locale, nonce }),
    title: title(locale, "commands.config.panel.add_tool_trigger_button"),
    components: [
      selectField(
        locale,
        nonce,
        BEHAVIOR_TOOL_TRIGGER_TARGET_FIELD,
        "commands.config.panel.tool_trigger_target_label",
        "commands.config.panel.tool_trigger_target_description",
        "commands.config.panel.tool_trigger_target_placeholder",
        DELIBERATE_TOOL_TRIGGER_TARGETS.map((target) => ({
          label: localizer(locale, `commands.config.panel.tool_target_${target.value}`),
          value: target.value,
        })),
      ),
      textField(
        locale,
        nonce,
        BEHAVIOR_TOOL_TRIGGER_LITERAL_FIELD,
        "commands.config.panel.tool_trigger_literal_label",
        "commands.config.panel.tool_trigger_literal_description",
        TextInputStyle.Short,
        false,
        40,
      ),
      textField(
        locale,
        nonce,
        BEHAVIOR_TOOL_TRIGGER_REGEX_FIELD,
        "commands.config.panel.tool_trigger_regex_label",
        "commands.config.panel.tool_trigger_regex_description",
        TextInputStyle.Short,
        false,
        120,
      ),
    ],
  };
}

export function buildBehaviorToolTriggerRemoveModal(
  locale: string,
  nonce: string,
  triggerMap: DeliberateToolTriggerMap,
): RawModalPayload {
  const entries = Object.entries(triggerMap).flatMap(([target, triggers]) =>
    triggers.map((trigger, index) => ({
      id: `${target}_${index}`,
      target,
      trigger,
    })),
  );
  const removalGroups = Array.from({ length: Math.ceil(entries.length / 10) }, (_unused, groupIndex) => {
    const group = entries.slice(groupIndex * 10, groupIndex * 10 + 10);
    return checkboxGroupField(
      locale,
      nonce,
      `${BEHAVIOR_TOOL_TRIGGER_REMOVE_GROUP_PREFIX}_${groupIndex}`,
      groupIndex === 0
        ? "commands.config.panel.tool_trigger_remove_label"
        : "commands.config.panel.tool_trigger_remove_label_continued",
      "commands.config.panel.tool_trigger_remove_description",
      group.map((entry) => ({
        label: formatTriggerForDisplay(entry.trigger),
        value: entry.id,
        description: localizer(locale, `commands.config.panel.tool_target_${entry.target}`),
        default: true,
      })),
    );
  });
  return {
    custom_id: buildConfigRouteId({ action: "behavior-tool-trigger-remove-submit", locale, nonce }),
    title: title(locale, "commands.config.panel.remove_tool_triggers_button"),
    components: removalGroups,
  };
}

export function buildBehaviorSendLimitModal(locale: string, nonce: string, current: number): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "behavior-send-limit-submit", locale, nonce }),
    title: title(locale, "commands.config.panel.edit_send_limit_button"),
    components: [
      textField(
        locale,
        nonce,
        BEHAVIOR_SEND_LIMIT_FIELD,
        "commands.config.panel.send_limit_label",
        "commands.config.panel.send_limit_description",
        TextInputStyle.Short,
        true,
        2,
        String(current),
      ),
    ],
  };
}

export function buildBehaviorWorkaroundsModal(
  locale: string,
  nonce: string,
  current: Record<string, boolean>,
  definitions: readonly WorkaroundDefinition[] = WORKAROUND_DEFINITIONS,
): RawModalPayload {
  const components: RawDiscordComponent[] = [];
  for (let i = 0; i < definitions.length; i += 10) {
    const group = definitions.slice(i, i + 10);
    const groupIndex = Math.floor(i / 10);
    components.push(
      checkboxGroupField(
        locale,
        nonce,
        `${BEHAVIOR_WORKAROUND_GROUP_PREFIX}_${groupIndex}`,
        groupIndex === 0
          ? "commands.config.workarounds.checkbox_label"
          : "commands.config.workarounds.checkbox_label_continued",
        "commands.config.workarounds.checkbox_description",
        group.map((definition) => ({
          label: localizer(locale, definition.labelKey),
          value: definition.value,
          description: localizer(locale, definition.descKey),
          default: current[definition.value] === true,
        })),
      ),
    );
  }
  return {
    custom_id: buildConfigRouteId({ action: "behavior-workarounds-submit", locale, nonce }),
    title: title(locale, "commands.config.panel.edit_workarounds_button"),
    components,
  };
}

export function buildBehaviorNoticeVisibilityModal(
  locale: string,
  nonce: string,
  hiddenKeys: readonly ToolNoticeKey[],
): RawModalPayload {
  const hiddenSet = new Set(hiddenKeys);
  const components: RawDiscordComponent[] = [];
  for (let i = 0; i < TOOL_NOTICE_DEFINITIONS.length; i += 10) {
    const group = TOOL_NOTICE_DEFINITIONS.slice(i, i + 10);
    const groupIndex = Math.floor(i / 10);
    components.push(
      checkboxGroupField(
        locale,
        nonce,
        `${BEHAVIOR_NOTICE_GROUP_PREFIX}_${groupIndex}`,
        groupIndex === 0
          ? "commands.config.notice-embeds.visibility.checkbox_label"
          : "commands.config.notice-embeds.visibility.checkbox_label_continued",
        "commands.config.notice-embeds.visibility.checkbox_description",
        group.map((definition) => ({
          label: localizer(locale, definition.labelKey),
          value: definition.key,
          description: localizer(locale, definition.descriptionKey),
          default: !hiddenSet.has(definition.key),
        })),
      ),
    );
  }
  return {
    custom_id: buildConfigRouteId({ action: "behavior-notice-visibility-submit", locale, nonce }),
    title: title(locale, "commands.config.panel.edit_notice_visibility_button"),
    components,
  };
}

export function buildBehaviorMemoryTaggingModal(
  locale: string,
  nonce: string,
  memoryTaggingEnabled: boolean,
  channelMemoryEnabled: boolean,
): RawModalPayload {
  const choices = (current: boolean) => [
    { value: "true", label: localizer(locale, "commands.config.panel.enabled_option"), default: current },
    { value: "false", label: localizer(locale, "commands.config.panel.disabled_option"), default: !current },
  ];
  return {
    custom_id: buildConfigRouteId({ action: "behavior-memory-tagging-submit", locale, nonce }),
    title: title(locale, "commands.config.panel.edit_memory_tagging_button"),
    components: [
      radioField(
        locale,
        nonce,
        BEHAVIOR_MEMORY_TAGGING_FIELD,
        "commands.config.panel.memory_tagging_label",
        "commands.config.panel.memory_tagging_description",
        choices(memoryTaggingEnabled),
      ),
      radioField(
        locale,
        nonce,
        BEHAVIOR_CHANNEL_MEMORY_FIELD,
        "commands.config.panel.channel_memory_label",
        "commands.config.panel.channel_memory_description",
        choices(channelMemoryEnabled),
      ),
    ],
  };
}

export function buildBehaviorStmParametersModal(
  locale: string,
  nonce: string,
  config: ServerStmConfigRow | null,
): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "behavior-stm-parameters-submit", locale, nonce }),
    title: title(locale, "commands.config.panel.edit_stm_parameters_button"),
    components: [
      textField(
        locale,
        nonce,
        BEHAVIOR_STM_REFRESH_CADENCE_FIELD,
        "commands.config.panel.stm_refresh_cadence_label",
        "commands.config.panel.stm_refresh_cadence_description",
        TextInputStyle.Short,
        true,
        3,
        String(config?.refresh_cadence ?? 5),
      ),
      radioField(
        locale,
        nonce,
        BEHAVIOR_STM_RENDER_MODE_FIELD,
        "commands.config.panel.stm_render_mode_label",
        "commands.config.panel.stm_render_mode_description",
        [
          {
            value: "supersede",
            label: localizer(locale, "commands.server.stm.parameters.supersede_option"),
            default: (config?.render_mode ?? "supersede") === "supersede",
          },
          {
            value: "crude_summary",
            label: localizer(locale, "commands.server.stm.parameters.crude_summary_option"),
            default: config?.render_mode === "crude_summary",
          },
        ],
      ),
      textField(
        locale,
        nonce,
        BEHAVIOR_STM_CRUDE_MESSAGES_FIELD,
        "commands.config.panel.stm_crude_messages_label",
        "commands.config.panel.stm_crude_messages_description",
        TextInputStyle.Short,
        true,
        3,
        String(config?.crude_message_count ?? 6),
      ),
      textField(
        locale,
        nonce,
        BEHAVIOR_STM_NUDGE_DEPTH_FIELD,
        "commands.config.panel.stm_nudge_depth_label",
        "commands.config.panel.stm_nudge_depth_description",
        TextInputStyle.Short,
        true,
        3,
        String(config?.nudge_injection_depth ?? 2),
      ),
      textField(
        locale,
        nonce,
        BEHAVIOR_STM_CONTENT_DEPTH_FIELD,
        "commands.config.panel.stm_content_depth_label",
        "commands.config.panel.stm_content_depth_description",
        TextInputStyle.Short,
        true,
        3,
        String(config?.content_injection_depth ?? -1),
      ),
    ],
  };
}

export function buildBehaviorStmCategoriesModal(
  locale: string,
  nonce: string,
  categories: readonly StmCategoryRow[],
  options: { disclosure?: string } = {},
): RawModalPayload {
  const byPosition = new Map(categories.map((category) => [category.position, category]));
  return {
    custom_id: buildConfigRouteId({ action: "behavior-stm-categories-submit", locale, nonce }),
    title: title(locale, "commands.config.panel.edit_stm_categories_button"),
    components: Array.from({ length: 5 }, (_unused, index) => {
      const category = byPosition.get(index);
      const field = textField(
        locale,
        nonce,
        `${BEHAVIOR_STM_CATEGORY_PREFIX}${index}`,
        `commands.server.stm.categories-edit.slot_${index + 1}_label`,
        "commands.server.stm.categories-edit.slot_instructions",
        TextInputStyle.Paragraph,
        false,
        1000,
        category ? `${category.label}: ${category.description}` : undefined,
      );
      if (index === 0 && options.disclosure) {
        field.description = safeSelectOptionText(
          `${options.disclosure} ${localizer(locale, "commands.server.stm.categories-edit.slot_instructions")}`,
          100,
        );
      }
      return field;
    }),
  };
}

export function buildBehaviorStmPromptModal(
  locale: string,
  nonce: string,
  toolDescription: string,
  updateNudge: string,
): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "behavior-stm-prompt-submit", locale, nonce }),
    title: title(locale, "commands.config.panel.edit_stm_prompt_button"),
    components: [
      textField(
        locale,
        nonce,
        BEHAVIOR_STM_TOOL_DESCRIPTION_FIELD,
        "commands.server.stm.prompt-edit.tool_description_label",
        "commands.server.stm.prompt-edit.tool_description_description",
        TextInputStyle.Paragraph,
        false,
        4000,
        toolDescription,
      ),
      textField(
        locale,
        nonce,
        BEHAVIOR_STM_UPDATE_NUDGE_FIELD,
        "commands.server.stm.prompt-edit.update_nudge_label",
        "commands.server.stm.prompt-edit.update_nudge_description",
        TextInputStyle.Paragraph,
        false,
        4000,
        updateNudge,
      ),
    ],
  };
}

export function buildBehaviorPromptModal(
  locale: string,
  nonce: string,
  prompt: string | null | undefined,
): RawModalPayload {
  const parts = splitPromptIntoModalParts(prompt ?? "", CONFIG_PERSONA_PROMPT_PART_FIELDS.length, 4000);
  const placeholders = [
    "commands.config.prompt.change.part1_placeholder",
    "commands.config.prompt.change.part2_placeholder",
    "commands.config.prompt.change.part3_placeholder",
    "commands.config.prompt.change.part4_placeholder",
  ];
  return {
    custom_id: buildConfigRouteId({ action: "behavior-prompt-submit", locale, nonce }),
    title: title(locale, "commands.config.prompt.change.modal_title"),
    components: CONFIG_PERSONA_PROMPT_PART_FIELDS.map((field, index) => ({
      type: LABEL,
      label: promptPartLabel(
        locale,
        "commands.config.panel.prompt_part_name_system",
        index,
        CONFIG_PERSONA_PROMPT_PART_FIELDS.length,
      ),
      description: promptPartDescription(locale, index),
      component: {
        type: TEXT_INPUT,
        custom_id: buildConfigModalFieldId(field, nonce),
        style: TextInputStyle.Paragraph,
        placeholder: safeSelectOptionText(localizer(locale, placeholders[index] as string), 100),
        max_length: 4000,
        required: index === 0,
        value: parts[index] || undefined,
      },
    })),
  };
}

export function buildBehaviorPresetModal(
  locale: string,
  nonce: string,
  presets: readonly SystemPromptPresetRow[],
): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "behavior-preset-submit", locale, nonce }),
    title: title(locale, "commands.config.prompt.preset.modal_title"),
    components: [
      selectField(
        locale,
        nonce,
        BEHAVIOR_PRESET_FIELD,
        "commands.config.prompt.preset.selection_label",
        "commands.config.prompt.preset.selection_placeholder",
        "commands.config.prompt.preset.selection_placeholder",
        presets.map((preset) => ({
          label: preset.system_prompt_preset_name,
          value: preset.system_prompt_preset_name,
          description: preset.system_prompt_preset_desc,
        })),
      ),
    ],
  };
}

export function buildBehaviorContextNoteModal(
  locale: string,
  nonce: string,
  note: string | null | undefined,
  depth: number,
): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "behavior-context-submit", locale, nonce }),
    title: title(locale, "commands.config.context-note.set.modal_title"),
    components: [
      textField(
        locale,
        nonce,
        CONFIG_CONTEXT_NOTE_TEXT_FIELD,
        "commands.config.context-note.set.text_label",
        "commands.config.context-note.set.text_placeholder",
        TextInputStyle.Paragraph,
        false,
        2000,
        note ?? undefined,
      ),
      textField(
        locale,
        nonce,
        CONFIG_CONTEXT_NOTE_DEPTH_FIELD,
        "commands.config.context-note.set.depth_label",
        "commands.config.context-note.set.depth_placeholder",
        TextInputStyle.Short,
        true,
        3,
        String(depth),
      ),
    ],
  };
}

export function buildBehaviorHumanizerModal(locale: string, nonce: string, current: number): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "behavior-humanizer-submit", locale, nonce }),
    title: title(locale, "commands.config.humanizer.modal_title"),
    components: [
      radioField(
        locale,
        nonce,
        BEHAVIOR_HUMANIZER_FIELD,
        "commands.config.humanizer.select_label",
        "commands.config.humanizer.select_description",
        [0, 1, 2, 3].map((value) => ({
          value: String(value),
          label: localizer(locale, `commands.config.humanizer.choice_${["none", "light", "medium", "heavy"][value]}`),
          default: value === current,
        })),
      ),
    ],
  };
}

export function buildBehaviorFetchModal(locale: string, nonce: string, current: number): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "behavior-fetch-submit", locale, nonce }),
    title: title(locale, "commands.config.panel.edit_fetch_limit_button"),
    components: [
      textField(
        locale,
        nonce,
        BEHAVIOR_FETCH_LIMIT_FIELD,
        "commands.config.panel.message_fetch_limit_label",
        "commands.config.message-fetch-limit.limit_description",
        TextInputStyle.Short,
        true,
        3,
        String(current),
      ),
    ],
  };
}

export function buildBehaviorTimezoneModal(locale: string, nonce: string, current: number): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "behavior-timezone-submit", locale, nonce }),
    title: title(locale, "commands.config.panel.change_timezone_button"),
    components: [
      textField(
        locale,
        nonce,
        BEHAVIOR_TIMEZONE_FIELD,
        "commands.config.panel.utc_offset_label",
        "commands.server.timezone.value_description",
        TextInputStyle.Short,
        true,
        6,
        String(current),
      ),
    ],
  };
}

export function buildBehaviorLimitsModal(
  locale: string,
  nonce: string,
  cascade: number,
  match: number,
): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "behavior-limits-submit", locale, nonce }),
    title: title(locale, "commands.config.panel.edit_matching_limits_button"),
    components: [
      textField(
        locale,
        nonce,
        BEHAVIOR_CASCADE_LIMIT_FIELD,
        "commands.config.panel.cascade_limit_label",
        "commands.config.trigger-cascade-limit.limit_description",
        TextInputStyle.Short,
        true,
        2,
        String(cascade),
      ),
      textField(
        locale,
        nonce,
        BEHAVIOR_MATCH_LIMIT_FIELD,
        "commands.config.panel.match_limit_label",
        "commands.config.trigger-match-limit.limit_description",
        TextInputStyle.Short,
        true,
        2,
        String(match),
      ),
    ],
  };
}

export function buildBehaviorCooldownModal(
  locale: string,
  nonce: string,
  typeValue: number,
  length: number,
): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "behavior-cooldown-submit", locale, nonce }),
    title: title(locale, "commands.config.panel.edit_cooldown_button"),
    components: [
      radioField(
        locale,
        nonce,
        BEHAVIOR_COOLDOWN_TYPE_FIELD,
        "commands.server.cooldown.triggers.cooldown_type_description",
        "commands.server.cooldown.triggers.cooldown_type_description",
        [
          [0, "commands.config.panel.cooldown_off"],
          [1, "commands.config.panel.cooldown_per_user"],
          [2, "commands.config.panel.cooldown_per_channel"],
          [3, "commands.config.panel.cooldown_server_wide"],
        ].map(([value, key]) => ({
          value: String(value),
          label: localizer(locale, key as string),
          default: value === typeValue,
        })),
      ),
      textField(
        locale,
        nonce,
        BEHAVIOR_COOLDOWN_LENGTH_FIELD,
        "commands.config.panel.cooldown_length_label",
        "commands.server.cooldown.triggers.cooldown_length_description",
        TextInputStyle.Short,
        true,
        5,
        String(length),
      ),
    ],
  };
}

export function buildBehaviorRandomAddModal(
  locale: string,
  nonce: string,
  personas: readonly TomoriState[],
): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "behavior-random-add-submit", locale, nonce }),
    title: title(locale, "commands.config.random-trigger.add.modal_title"),
    components: [
      {
        type: LABEL,
        label: label(locale, "commands.config.random-trigger.add.channel_label"),
        description: description(locale, "commands.config.random-trigger.add.channel_description"),
        component: {
          type: CHANNEL_SELECT,
          custom_id: buildConfigModalFieldId(BEHAVIOR_RANDOM_CHANNEL_FIELD, nonce),
          channel_types: [ChannelType.GuildText],
          min_values: 1,
          max_values: 1,
          required: true,
        },
      },
      selectField(
        locale,
        nonce,
        BEHAVIOR_RANDOM_PERSONA_FIELD,
        "commands.config.random-trigger.add.persona_select_label",
        "commands.config.random-trigger.add.persona_select_placeholder",
        "commands.config.random-trigger.add.persona_select_placeholder",
        [
          { label: localizer(locale, "commands.config.random-trigger.add.persona_random_label"), value: "random" },
          ...personas.flatMap((persona) =>
            persona.persona_id === undefined
              ? []
              : [{ label: persona.persona_nickname, value: String(persona.persona_id) }],
          ),
        ],
      ),
      textField(
        locale,
        nonce,
        BEHAVIOR_RANDOM_SETTINGS_FIELD,
        "commands.config.panel.random_trigger_settings_label",
        "commands.config.panel.random_trigger_settings_description",
        TextInputStyle.Short,
        true,
        100,
        undefined,
        "commands.config.panel.random_trigger_settings_placeholder",
      ),
      {
        type: LABEL,
        label: label(locale, "commands.config.random-trigger.add.respond_to_self_label"),
        description: description(locale, "commands.config.random-trigger.add.respond_to_self_description"),
        component: {
          type: CHECKBOX_GROUP,
          custom_id: buildConfigModalFieldId(BEHAVIOR_RANDOM_RESPOND_SELF_FIELD, nonce),
          min_values: 0,
          max_values: 1,
          required: false,
          options: [
            {
              value: "yes",
              label: safeSelectOptionText(
                localizer(locale, "commands.config.random-trigger.add.respond_to_self_yes"),
                100,
              ),
            },
          ],
        },
      },
      textField(
        locale,
        nonce,
        BEHAVIOR_RANDOM_PROMPT_FIELD,
        "commands.config.random-trigger.add.prompt_label",
        "commands.config.random-trigger.add.prompt_description",
        TextInputStyle.Paragraph,
        false,
        1000,
      ),
    ],
  };
}

export function buildBehaviorRandomRemoveModal(
  locale: string,
  nonce: string,
  fp: string,
  start: number,
  triggers: readonly (RandomTriggerRow & { trigger_id: number })[],
): RawModalPayload {
  const components: RawDiscordComponent[] = [];
  for (
    let start = 0;
    start < triggers.length && start < CONFIG_RANDOM_TRIGGER_CHECKBOX_CAPACITY;
    start += CONFIG_RANDOM_TRIGGER_CHECKBOX_GROUP_SIZE
  ) {
    const groupIndex = Math.floor(start / CONFIG_RANDOM_TRIGGER_CHECKBOX_GROUP_SIZE);
    components.push({
      type: LABEL,
      label: label(
        locale,
        groupIndex === 0
          ? "commands.config.random-trigger.remove.checkbox_label"
          : "commands.config.random-trigger.remove.checkbox_label_continued",
      ),
      description:
        groupIndex === 0
          ? description(locale, "commands.config.random-trigger.remove.checkbox_description")
          : undefined,
      component: (() => {
        const groupOptions = triggers.slice(start, start + CONFIG_RANDOM_TRIGGER_CHECKBOX_GROUP_SIZE);
        return {
          type: CHECKBOX_GROUP,
          custom_id: buildConfigModalFieldId(`behavior_random_trigger_${groupIndex}`, nonce),
          min_values: 0,
          // Discord requires options.length >= max_values, so a partial trailing group must cap
          // max_values to its own size instead of the full group capacity.
          max_values: groupOptions.length,
          required: false,
          options: groupOptions.map((trigger) => ({
            value: String(trigger.trigger_id),
            label: safeSelectOptionText(`<#${trigger.channel_disc_id}>`, 100),
            description: safeSelectOptionText(`${trigger.timer_hours}h / ${trigger.chance_percent}%`, 100),
            default: true,
          })),
        };
      })(),
    });
  }
  return {
    custom_id: buildConfigRouteId({ action: "behavior-random-remove-submit", locale, start, fp, nonce }),
    title: title(locale, "commands.config.random-trigger.remove.modal_title"),
    components,
  };
}
