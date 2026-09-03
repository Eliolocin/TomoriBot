import { ChannelType, TextInputStyle } from "discord.js";
import type { RandomTriggerRow, SystemPromptPresetRow, TomoriState } from "@/types/db/schema";
import type { RawDiscordComponent } from "@/types/discord/rawApiTypes";
import type { SelectOption } from "@/types/discord/modal";
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

export function buildBehaviorPromptModal(
  locale: string,
  nonce: string,
  prompt: string | null | undefined,
): RawModalPayload {
  const parts = splitPromptIntoModalParts(prompt ?? "", CONFIG_PERSONA_PROMPT_PART_FIELDS.length, 4000);
  const labels = [
    "commands.config.prompt.change.part1_label",
    "commands.config.prompt.change.part2_label",
    "commands.config.prompt.change.part3_label",
    "commands.config.prompt.change.part4_label",
  ];
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
      label: label(locale, labels[index] as string),
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
        label: label(locale, "commands.config.random-trigger.add.channel_description"),
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
        "1,100,,,",
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
      component: {
        type: CHECKBOX_GROUP,
        custom_id: buildConfigModalFieldId(`behavior_random_trigger_${groupIndex}`, nonce),
        min_values: 0,
        max_values: CONFIG_RANDOM_TRIGGER_CHECKBOX_GROUP_SIZE,
        required: false,
        options: triggers.slice(start, start + CONFIG_RANDOM_TRIGGER_CHECKBOX_GROUP_SIZE).map((trigger) => ({
          value: String(trigger.trigger_id),
          label: safeSelectOptionText(`<#${trigger.channel_disc_id}>`, 100),
          description: safeSelectOptionText(`${trigger.timer_hours}h / ${trigger.chance_percent}%`, 100),
          default: true,
        })),
      },
    });
  }
  return {
    custom_id: buildConfigRouteId({ action: "behavior-random-remove-submit", locale, start, fp, nonce }),
    title: title(locale, "commands.config.random-trigger.remove.modal_title"),
    components,
  };
}
