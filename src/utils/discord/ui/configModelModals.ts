import { TextInputStyle } from "discord.js";
import { THINKING_LEVEL_VALUES } from "@/constants/thinkingLevels";
import type { LogitBiasEntry } from "@/types/provider/logitBias";
import type { SavedProviderConfigRow } from "@/types/db/schema";
import type { RawDiscordComponent } from "@/types/discord/rawApiTypes";
import {
  CONFIG_LOGIT_BIAS_CHECKBOX_GROUP_SIZE,
  CONFIG_FALLBACK_SLOT_COUNT,
  CONFIG_STOP_STRING_CHECKBOX_GROUP_SIZE,
  buildConfigRouteId,
} from "@/utils/discord/configPanelCatalog";
import { CONFIG_FALLBACK_CLEAR_VALUE } from "@/utils/discord/interactions/configModelOperations";
import { buildConfigModalFieldId, type RawModalPayload } from "@/utils/discord/ui/configModals";
import { formatStoredParameterValue } from "@/utils/discord/ui/personalConfigParameterControls";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import { TAGS_MODAL_MAX_LENGTH, formatImageTagsForModalValue } from "@/utils/image/tagHelpers";
import { formatStopStringForDisplay } from "@/utils/provider/stopStringConfig";
import { localizer } from "@/utils/text/localizer";

const MODAL_TITLE_MAX_LENGTH = 45;
const MODAL_DESCRIPTION_MAX_LENGTH = 100;
const PARAMETER_INPUT_MAX_LENGTH = 10;
const STOP_STRINGS_INPUT_MAX_LENGTH = 1000;
const LOGIT_TERMS_INPUT_MAX_LENGTH = 1000;
const LOGIT_BIAS_INPUT_MAX_LENGTH = 16;

export const CONFIG_STOP_SPEAKER_PATTERN_FIELD = "stop_speaker_pattern";
const CONFIG_STOP_STRINGS_GROUP_PREFIX = "stop_group";
export const CONFIG_LOGIT_TERMS_FIELD = "logit_terms";
export const CONFIG_LOGIT_VALUE_FIELD = "logit_value";
export const CONFIG_LOGIT_FILE_FIELD = "logit_file";
const CONFIG_LOGIT_GROUP_PREFIX = "logit_group";
export const CONFIG_IMAGE_TAGS_FIELD = "image_default_tags";
export const CONFIG_NAI_SAMPLER_FIELD = "nai_sampler";
export const CONFIG_NAI_STEPS_FIELD = "nai_steps";
export const CONFIG_NAI_SCALE_FIELD = "nai_scale";
export const CONFIG_NAI_NOISE_FIELD = "nai_noise_schedule";
export const CONFIG_NAI_RESCALE_FIELD = "nai_cfg_rescale";

export function buildConfigStopStringGroupId(groupIndex: number, nonce: string): string {
  return buildConfigModalFieldId(`${CONFIG_STOP_STRINGS_GROUP_PREFIX}${groupIndex}`, nonce);
}

export function buildConfigLogitBiasGroupId(groupIndex: number, nonce: string): string {
  return buildConfigModalFieldId(`${CONFIG_LOGIT_GROUP_PREFIX}${groupIndex}`, nonce);
}

export function buildConfigFallbackSlotId(slot: number, nonce: string): string {
  return buildConfigModalFieldId(`fallback_slot_${slot}`, nonce);
}

function modalTitle(locale: string, key: string): string {
  return safeSelectOptionText(localizer(locale, key), MODAL_TITLE_MAX_LENGTH);
}

function modalLabel(locale: string, key: string): string {
  return safeSelectOptionText(localizer(locale, key), MODAL_TITLE_MAX_LENGTH);
}

function modalDescription(locale: string, key: string): string {
  return safeSelectOptionText(localizer(locale, key), MODAL_DESCRIPTION_MAX_LENGTH);
}

function parameterValue(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : formatStoredParameterValue(value);
}

function parameterField(
  locale: string,
  nonce: string,
  field: string,
  labelKey: string,
  descriptionKey: string,
  value: string,
): RawDiscordComponent {
  return {
    type: 18,
    label: modalLabel(locale, labelKey),
    description: modalDescription(locale, descriptionKey),
    component: {
      type: 4,
      custom_id: buildConfigModalFieldId(field, nonce),
      style: TextInputStyle.Short,
      max_length: PARAMETER_INPUT_MAX_LENGTH,
      required: false,
      value,
    },
  };
}

/**
 * Sampling group of the server provider-parameter editor.
 *
 * The four sampler fields and the four generation fields are split across two modals because
 * Discord caps a modal at five components, and the split is semantic rather than positional so the
 * label never has to name a field number.
 */
export function buildConfigSamplingModal(
  locale: string,
  provider: string,
  nonce: string,
  config: SavedProviderConfigRow | null,
): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "sampling-submit", locale, provider, nonce }),
    title: modalTitle(locale, "commands.config.panel.sampling_modal_title"),
    components: [
      parameterField(
        locale,
        nonce,
        "temperature",
        "commands.config.panel.param_temperature_label",
        "commands.config.panel.param_temperature_description",
        parameterValue(config?.llm_temperature),
      ),
      parameterField(
        locale,
        nonce,
        "min_p",
        "commands.config.panel.param_min_p_label",
        "commands.config.panel.param_min_p_description",
        parameterValue(config?.llm_min_p),
      ),
      parameterField(
        locale,
        nonce,
        "top_p",
        "commands.config.panel.param_top_p_label",
        "commands.config.panel.param_top_p_description",
        parameterValue(config?.llm_top_p),
      ),
      parameterField(
        locale,
        nonce,
        "top_k",
        "commands.config.panel.param_top_k_label",
        "commands.config.panel.param_top_k_description",
        parameterValue(config?.llm_top_k),
      ),
    ],
  };
}

export function buildConfigGenerationModal(
  locale: string,
  provider: string,
  nonce: string,
  config: SavedProviderConfigRow | null,
): RawModalPayload {
  const currentThinking = config?.thinking_level ?? "auto";
  return {
    custom_id: buildConfigRouteId({ action: "generation-submit", locale, provider, nonce }),
    title: modalTitle(locale, "commands.config.panel.generation_modal_title"),
    components: [
      parameterField(
        locale,
        nonce,
        "frequency_penalty",
        "commands.config.panel.param_frequency_label",
        "commands.config.panel.param_frequency_description",
        parameterValue(config?.llm_frequency_penalty),
      ),
      parameterField(
        locale,
        nonce,
        "presence_penalty",
        "commands.config.panel.param_presence_label",
        "commands.config.panel.param_presence_description",
        parameterValue(config?.llm_presence_penalty),
      ),
      parameterField(
        locale,
        nonce,
        "max_output_tokens",
        "commands.config.panel.param_max_output_label",
        "commands.config.panel.param_max_output_description",
        config?.llm_max_output_tokens === null || config?.llm_max_output_tokens === undefined
          ? ""
          : String(config.llm_max_output_tokens),
      ),
      {
        type: 18,
        label: modalLabel(locale, "commands.config.panel.param_thinking_label"),
        description: modalDescription(locale, "commands.config.panel.param_thinking_description"),
        component: {
          type: 3,
          custom_id: buildConfigModalFieldId("thinking_level", nonce),
          required: false,
          min_values: 0,
          max_values: 1,
          options: THINKING_LEVEL_VALUES.map((value) => ({
            label: safeSelectOptionText(localizer(locale, `commands.config.thinking-level.choice_${value}`), 100),
            value,
            default: value === currentThinking,
          })),
        },
      },
    ],
  };
}

export function buildConfigStopStringAddModal(locale: string, nonce: string): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "stop-add-submit", locale, nonce }),
    title: modalTitle(locale, "commands.config.panel.stop_add_modal_title"),
    components: [
      {
        type: 18,
        label: modalLabel(locale, "commands.config.panel.stop_add_input_label"),
        description: modalDescription(locale, "commands.config.panel.stop_add_input_description"),
        component: {
          type: 4,
          custom_id: buildConfigModalFieldId("stop_strings", nonce),
          style: TextInputStyle.Paragraph,
          placeholder: modalDescription(locale, "commands.config.panel.stop_add_input_placeholder"),
          max_length: STOP_STRINGS_INPUT_MAX_LENGTH,
          required: true,
        },
      },
    ],
  };
}

/**
 * Stop-string management: one speaker-pattern checkbox plus unchecked-means-remove groups.
 *
 * The speaker-pattern toggle is a one-option CheckboxGroup rather than a bare component so both
 * halves of the modal read back through the same accessor.
 */
export function buildConfigStopStringManageModal(
  locale: string,
  nonce: string,
  fp: string,
  stopStrings: readonly string[],
  speakerPatternEnabled: boolean,
): RawModalPayload {
  const components: RawDiscordComponent[] = [
    {
      type: 18,
      label: modalLabel(locale, "commands.config.panel.stop_speaker_label"),
      description: modalDescription(locale, "commands.config.panel.stop_speaker_description"),
      component: {
        // 22 is CheckboxGroup. A FileUpload (19) also renders and submits, but carries no option
        // values, which would read back as the pattern being switched off.
        type: 22,
        custom_id: buildConfigModalFieldId(CONFIG_STOP_SPEAKER_PATTERN_FIELD, nonce),
        min_values: 0,
        max_values: 1,
        required: false,
        options: [
          {
            label: safeSelectOptionText(localizer(locale, "commands.config.panel.stop_speaker_option"), 50),
            value: "enabled",
            default: speakerPatternEnabled,
          },
        ],
      },
    },
  ];

  for (let offset = 0; offset < stopStrings.length; offset += CONFIG_STOP_STRING_CHECKBOX_GROUP_SIZE) {
    const groupIndex = offset / CONFIG_STOP_STRING_CHECKBOX_GROUP_SIZE;
    components.push({
      type: 18,
      label: modalLabel(
        locale,
        groupIndex === 0
          ? "commands.config.panel.stop_manage_checkbox_label"
          : "commands.config.panel.stop_manage_checkbox_label_continued",
      ),
      description:
        groupIndex === 0
          ? modalDescription(locale, "commands.config.panel.stop_manage_checkbox_description")
          : undefined,
      component: {
        type: 22,
        custom_id: buildConfigStopStringGroupId(groupIndex, nonce),
        min_values: 0,
        max_values: CONFIG_STOP_STRING_CHECKBOX_GROUP_SIZE,
        required: false,
        options: stopStrings
          .slice(offset, offset + CONFIG_STOP_STRING_CHECKBOX_GROUP_SIZE)
          .map((stopString, indexInGroup) => ({
            label: safeSelectOptionText(
              formatStopStringForDisplay(stopString) || localizer(locale, "general.unknown"),
              50,
            ),
            value: String(offset + indexInGroup),
            default: true,
          })),
      },
    });
  }

  return {
    custom_id: buildConfigRouteId({ action: "stop-manage-submit", locale, fp, nonce }),
    title: modalTitle(locale, "commands.config.panel.stop_manage_modal_title"),
    components,
  };
}

export function buildConfigLogitBiasAddModal(locale: string, nonce: string): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "logit-add-submit", locale, nonce }),
    title: modalTitle(locale, "commands.config.panel.logit_add_modal_title"),
    components: [
      {
        type: 18,
        label: modalLabel(locale, "commands.config.panel.logit_terms_label"),
        description: modalDescription(locale, "commands.config.panel.logit_terms_description"),
        component: {
          type: 4,
          custom_id: buildConfigModalFieldId(CONFIG_LOGIT_TERMS_FIELD, nonce),
          style: TextInputStyle.Paragraph,
          placeholder: modalDescription(locale, "commands.config.panel.logit_terms_placeholder"),
          max_length: LOGIT_TERMS_INPUT_MAX_LENGTH,
          required: true,
        },
      },
      {
        type: 18,
        label: modalLabel(locale, "commands.config.panel.logit_value_label"),
        description: modalDescription(locale, "commands.config.panel.logit_value_description"),
        component: {
          type: 4,
          custom_id: buildConfigModalFieldId(CONFIG_LOGIT_VALUE_FIELD, nonce),
          style: TextInputStyle.Short,
          placeholder: modalDescription(locale, "commands.config.panel.logit_value_placeholder"),
          max_length: LOGIT_BIAS_INPUT_MAX_LENGTH,
          required: true,
        },
      },
    ],
  };
}

export function buildConfigLogitBiasUploadModal(locale: string, nonce: string): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "logit-upload-submit", locale, nonce }),
    title: modalTitle(locale, "commands.config.panel.logit_upload_modal_title"),
    components: [
      {
        type: 18,
        label: modalLabel(locale, "commands.config.panel.logit_upload_label"),
        description: modalDescription(locale, "commands.config.panel.logit_upload_description"),
        component: {
          // 19 is FileUpload, which is what this field genuinely is: it submits attachment ids.
          type: 19,
          custom_id: buildConfigModalFieldId(CONFIG_LOGIT_FILE_FIELD, nonce),
          min_values: 1,
          max_values: 1,
          required: true,
        },
      },
    ],
  };
}

export function buildConfigLogitBiasManageModal(
  locale: string,
  nonce: string,
  start: number,
  fp: string,
  entries: readonly LogitBiasEntry[],
): RawModalPayload {
  const components: RawDiscordComponent[] = [];

  for (let offset = 0; offset < entries.length; offset += CONFIG_LOGIT_BIAS_CHECKBOX_GROUP_SIZE) {
    const groupIndex = offset / CONFIG_LOGIT_BIAS_CHECKBOX_GROUP_SIZE;
    components.push({
      type: 18,
      label: modalLabel(
        locale,
        groupIndex === 0
          ? "commands.config.panel.logit_manage_checkbox_label"
          : "commands.config.panel.logit_manage_checkbox_label_continued",
      ),
      description:
        groupIndex === 0
          ? modalDescription(locale, "commands.config.panel.logit_manage_checkbox_description")
          : undefined,
      component: {
        type: 22,
        custom_id: buildConfigLogitBiasGroupId(groupIndex, nonce),
        min_values: 0,
        max_values: CONFIG_LOGIT_BIAS_CHECKBOX_GROUP_SIZE,
        required: false,
        options: entries.slice(offset, offset + CONFIG_LOGIT_BIAS_CHECKBOX_GROUP_SIZE).map((entry) => ({
          label: safeSelectOptionText(entry.text, 50),
          value: entry.id,
          description: safeSelectOptionText(String(entry.value), 100),
          default: true,
        })),
      },
    });
  }

  return {
    custom_id: buildConfigRouteId({ action: "logit-manage-submit", locale, start, fp, nonce }),
    title: modalTitle(locale, "commands.config.panel.logit_manage_modal_title"),
    components,
  };
}

export interface ConfigFallbackOption {
  value: string;
  label: string;
  description?: string;
}

/**
 * Five slot selects over one shared option list.
 *
 * A blank slot keeps whatever it held, so the modal is an edit of one position rather than a
 * replacement of the chain. That is also why the options are sliced before the modal opens: the
 * five selects share one list, so the modal's own overflow bridge would page only the first.
 */
export function buildConfigFallbackModal(
  locale: string,
  provider: string,
  start: number,
  nonce: string,
  options: readonly ConfigFallbackOption[],
  slotPlaceholders: readonly string[],
): RawModalPayload {
  const clearOption: ConfigFallbackOption = {
    value: CONFIG_FALLBACK_CLEAR_VALUE,
    label: localizer(locale, "commands.config.panel.fallback_clear_option"),
    description: localizer(locale, "commands.config.panel.fallback_clear_option_description"),
  };
  const slotOptions = [clearOption, ...options].map((option) => ({
    label: safeSelectOptionText(option.label, 100),
    value: option.value,
    description: option.description ? safeSelectOptionText(option.description, 100) : undefined,
  }));

  const components: RawDiscordComponent[] = [];
  for (let slot = 0; slot < CONFIG_FALLBACK_SLOT_COUNT; slot += 1) {
    components.push({
      type: 18,
      label: safeSelectOptionText(
        localizer(locale, "commands.config.panel.fallback_slot_label", { slot: slot + 1 }),
        MODAL_TITLE_MAX_LENGTH,
      ),
      description: safeSelectOptionText(slotPlaceholders[slot] ?? "", MODAL_DESCRIPTION_MAX_LENGTH),
      component: {
        type: 3,
        custom_id: buildConfigFallbackSlotId(slot, nonce),
        required: false,
        min_values: 0,
        max_values: 1,
        options: slotOptions,
      },
    });
  }

  return {
    custom_id: buildConfigRouteId({ action: "fallback-submit", locale, provider, start, nonce }),
    title: modalTitle(locale, "commands.config.panel.fallback_modal_title"),
    components,
  };
}

export function buildConfigImageTagsModal(
  locale: string,
  negative: boolean,
  nonce: string,
  currentTags: string[] | null | undefined,
): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "image-tags-default-submit", locale, negative, nonce }),
    title: modalTitle(
      locale,
      negative
        ? "commands.config.panel.image_negative_modal_title"
        : "commands.config.panel.image_positive_modal_title",
    ),
    components: [
      {
        type: 18,
        label: modalLabel(
          locale,
          negative ? "commands.config.panel.image_negative_label" : "commands.config.panel.image_positive_label",
        ),
        description: modalDescription(locale, "commands.config.panel.image_tags_input_description"),
        component: {
          type: 4,
          custom_id: buildConfigModalFieldId(CONFIG_IMAGE_TAGS_FIELD, nonce),
          style: TextInputStyle.Paragraph,
          max_length: TAGS_MODAL_MAX_LENGTH,
          required: false,
          value: formatImageTagsForModalValue(currentTags),
        },
      },
    ],
  };
}

export interface ConfigNaiParameterDefaults {
  sampler: string | null | undefined;
  steps: number | null | undefined;
  scale: number | null | undefined;
  noiseSchedule: string | null | undefined;
  cfgRescale: number | null | undefined;
}

export function buildConfigNaiParametersModal(
  locale: string,
  nonce: string,
  samplers: readonly string[],
  noiseSchedules: readonly string[],
  current: ConfigNaiParameterDefaults,
): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "nai-parameters-submit", locale, nonce }),
    title: modalTitle(locale, "commands.config.panel.nai_modal_title"),
    components: [
      {
        type: 18,
        label: modalLabel(locale, "commands.config.panel.nai_sampler_label"),
        description: modalDescription(locale, "commands.config.panel.nai_sampler_description"),
        component: {
          type: 3,
          custom_id: buildConfigModalFieldId(CONFIG_NAI_SAMPLER_FIELD, nonce),
          required: false,
          min_values: 0,
          max_values: 1,
          options: samplers.map((sampler) => ({
            label: safeSelectOptionText(sampler, 100),
            value: sampler,
            default: sampler === current.sampler,
          })),
        },
      },
      {
        type: 18,
        label: modalLabel(locale, "commands.config.panel.nai_steps_label"),
        description: modalDescription(locale, "commands.config.panel.nai_steps_description"),
        component: {
          type: 4,
          custom_id: buildConfigModalFieldId(CONFIG_NAI_STEPS_FIELD, nonce),
          style: TextInputStyle.Short,
          max_length: 2,
          required: false,
          value: current.steps === null || current.steps === undefined ? "" : String(current.steps),
        },
      },
      {
        type: 18,
        label: modalLabel(locale, "commands.config.panel.nai_scale_label"),
        description: modalDescription(locale, "commands.config.panel.nai_scale_description"),
        component: {
          type: 4,
          custom_id: buildConfigModalFieldId(CONFIG_NAI_SCALE_FIELD, nonce),
          style: TextInputStyle.Short,
          max_length: 8,
          required: false,
          value: current.scale === null || current.scale === undefined ? "" : String(current.scale),
        },
      },
      {
        type: 18,
        label: modalLabel(locale, "commands.config.panel.nai_noise_label"),
        description: modalDescription(locale, "commands.config.panel.nai_noise_description"),
        component: {
          type: 3,
          custom_id: buildConfigModalFieldId(CONFIG_NAI_NOISE_FIELD, nonce),
          required: false,
          min_values: 0,
          max_values: 1,
          options: noiseSchedules.map((schedule) => ({
            label: safeSelectOptionText(schedule, 100),
            value: schedule,
            default: schedule === current.noiseSchedule,
          })),
        },
      },
      {
        type: 18,
        label: modalLabel(locale, "commands.config.panel.nai_rescale_label"),
        description: modalDescription(locale, "commands.config.panel.nai_rescale_description"),
        component: {
          type: 4,
          custom_id: buildConfigModalFieldId(CONFIG_NAI_RESCALE_FIELD, nonce),
          style: TextInputStyle.Short,
          max_length: 8,
          required: false,
          value: current.cfgRescale === null || current.cfgRescale === undefined ? "" : String(current.cfgRescale),
        },
      },
    ],
  };
}
