import { TextInputStyle } from "discord.js";
import type { StmCategoryRow } from "@/types/db/schema";
import type { RawDiscordComponent } from "@/types/discord/rawApiTypes";
import type { ConditioningGroup } from "@/utils/db/repositories/ConditioningMemoryRepository";
import type { ShortTermMemoryEntry } from "@/utils/cache/shortTermMemoryCache";
import { PERSONA_NAMING_VALUE_MAX_LENGTH, type AddressingStyle } from "@/types/personaNaming";
import {
  CONFIG_CONDITIONING_CHECKBOX_CAPACITY,
  CONFIG_CONDITIONING_CHECKBOX_GROUP_SIZE,
  CONFIG_TRIGGER_CHECKBOX_CAPACITY,
  CONFIG_TRIGGER_CHECKBOX_GROUP_SIZE,
  buildConfigRouteId,
} from "@/utils/discord/configPanelCatalog";
import {
  PERSONA_NICKNAME_MAX_LENGTH,
  PERSONA_NICKNAME_MIN_LENGTH,
} from "@/utils/discord/interactions/configPersonaOperations";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import { getMemoryLimits } from "@/utils/misc/memoryLimits";
import { splitPromptIntoModalParts } from "@/utils/text/modalPromptParts";
import { localizer } from "@/utils/text/localizer";
import { normalizeTriggerWord } from "@/utils/text/triggerWords";
import { buildSlugMap } from "@/utils/text/slugifyLabel";

export interface RawModalPayload {
  custom_id: string;
  title: string;
  components: RawDiscordComponent[];
}

export function buildConfigModalFieldId(field: string, nonce: string): string {
  return `${field}_${nonce}`;
}

export const CONFIG_ATTRIBUTE_INPUT_FIELD = "attribute";
export const CONFIG_ATTRIBUTE_FILE_FIELD = "attribute_file";
export const CONFIG_ATTRIBUTE_PUBLIC_FIELD = "attribute_public";
export const CONFIG_DIALOGUE_USER_INPUT_FIELD = "user_input";
export const CONFIG_DIALOGUE_BOT_INPUT_FIELD = "bot_input";
export const CONFIG_DIALOGUE_FILE_FIELD = "sampledialogue_file";
export const CONFIG_STM_CATEGORY_INPUT_PREFIX = "stm_cat_";

const MODAL_TITLE_MAX_LENGTH = 45;
const MODAL_DESCRIPTION_MAX_LENGTH = 100;

function modalTitle(locale: string, key: string): string {
  return safeSelectOptionText(localizer(locale, key), MODAL_TITLE_MAX_LENGTH);
}

function modalLabel(locale: string, key: string): string {
  return safeSelectOptionText(localizer(locale, key), MODAL_TITLE_MAX_LENGTH);
}

function modalDescription(locale: string, key: string): string {
  return safeSelectOptionText(localizer(locale, key), MODAL_DESCRIPTION_MAX_LENGTH);
}

export function buildPersonaAvatarModal(locale: string, personaId: number, nonce: string): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "avatar-submit", locale, personaId, nonce }),
    title: modalTitle(locale, "commands.config.panel.avatar_modal_title"),
    components: [
      {
        type: 18,
        label: modalLabel(locale, "commands.config.panel.avatar_input_label"),
        description: modalDescription(locale, "commands.config.panel.avatar_input_description"),
        component: {
          // 19 is FileUpload. Component types are bare numbers on the wire, so TypeScript accepts
          // any of them here and only a literal assertion catches a wrong one.
          type: 19,
          custom_id: buildConfigModalFieldId("avatar", nonce),
          min_values: 0,
          max_values: 1,
          required: false,
        },
      },
    ],
  };
}

export function buildPersonaRenameModal(
  locale: string,
  personaId: number,
  nonce: string,
  currentNickname: string,
): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "rename-submit", locale, personaId, nonce }),
    title: modalTitle(locale, "commands.config.panel.rename_modal_title"),
    components: [
      {
        type: 18,
        label: modalLabel(locale, "commands.config.panel.rename_input_label"),
        description: modalDescription(locale, "commands.config.panel.rename_input_description"),
        component: {
          type: 4,
          custom_id: buildConfigModalFieldId("nickname", nonce),
          style: TextInputStyle.Short,
          min_length: PERSONA_NICKNAME_MIN_LENGTH,
          max_length: PERSONA_NICKNAME_MAX_LENGTH,
          required: true,
          value: currentNickname,
        },
      },
    ],
  };
}

export function buildPersonaNamingHabitsModal(
  locale: string,
  personaId: number,
  style: AddressingStyle,
  nonce: string,
  current: { prefix: string; suffix: string; addressTerm: string },
): RawModalPayload {
  const field = (key: string, labelKey: string, descriptionKey: string, value: string): RawDiscordComponent => ({
    type: 18,
    label: modalLabel(locale, labelKey),
    description: modalDescription(locale, descriptionKey),
    component: {
      type: 4,
      custom_id: buildConfigModalFieldId(key, nonce),
      style: TextInputStyle.Short,
      max_length: PERSONA_NAMING_VALUE_MAX_LENGTH,
      required: false,
      value,
    },
  });

  return {
    custom_id: buildConfigRouteId({ action: "naming-submit", locale, personaId, style, nonce }),
    title: modalTitle(locale, "commands.config.panel.naming_modal_title"),
    components: [
      field(
        "prefix",
        "commands.config.panel.naming_prefix_input_label",
        "commands.config.panel.naming_prefix_input_description",
        current.prefix,
      ),
      field(
        "suffix",
        "commands.config.panel.naming_suffix_input_label",
        "commands.config.panel.naming_suffix_input_description",
        current.suffix,
      ),
      field(
        "term",
        "commands.config.panel.naming_term_input_label",
        "commands.config.panel.naming_term_input_description",
        current.addressTerm,
      ),
    ],
  };
}

export function buildTriggerAddModal(locale: string, personaId: number, nonce: string): RawModalPayload {
  const memoryLimits = getMemoryLimits();
  return {
    custom_id: buildConfigRouteId({ action: "trigger-add-submit", locale, personaId, nonce }),
    title: modalTitle(locale, "commands.config.panel.trigger_add_modal_title"),
    components: [
      {
        type: 18,
        label: modalLabel(locale, "commands.config.panel.trigger_add_input_label"),
        description: modalDescription(locale, "commands.config.panel.trigger_add_input_description"),
        component: {
          type: 4,
          custom_id: buildConfigModalFieldId("triggers", nonce),
          style: TextInputStyle.Paragraph,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.config.panel.trigger_add_input_placeholder"),
            MODAL_DESCRIPTION_MAX_LENGTH,
          ),
          max_length: Math.min(4000, Math.max(1, memoryLimits.maxTriggerWords * (memoryLimits.maxMemoryLength + 1))),
          required: true,
        },
      },
    ],
  };
}

export function buildTriggerRemoveCheckboxGroupId(groupIndex: number, nonce: string): string {
  return buildConfigModalFieldId(`triggers_${groupIndex}`, nonce);
}

function buildPublicCheckboxGroup(
  locale: string,
  nonce: string,
  field: string,
  labelKey: string,
  descriptionKey: string,
  isPublic: boolean,
): RawDiscordComponent {
  return {
    type: 18,
    label: modalLabel(locale, labelKey),
    description: modalDescription(locale, descriptionKey),
    component: {
      // 22 is CheckboxGroup. A single option preserves the distinction between an explicit clear
      // and a submit that carried no checkbox evidence at all.
      type: 22,
      custom_id: buildConfigModalFieldId(field, nonce),
      min_values: 0,
      max_values: 1,
      required: false,
      options: [
        {
          label: modalLabel(locale, "commands.config.panel.attribute_public_option"),
          value: "public",
          default: isPublic,
        },
      ],
    },
  };
}

export function buildPersonaAttributeAddModal(locale: string, personaId: number, nonce: string): RawModalPayload {
  const memoryLimits = getMemoryLimits();
  return {
    custom_id: buildConfigRouteId({ action: "attribute-add-submit", locale, personaId, nonce }),
    title: modalTitle(locale, "commands.config.panel.attribute_add_modal_title"),
    components: [
      {
        type: 18,
        label: modalLabel(locale, "commands.config.panel.attribute_input_label"),
        description: modalDescription(locale, "commands.config.panel.attribute_input_description"),
        component: {
          type: 4,
          custom_id: buildConfigModalFieldId(CONFIG_ATTRIBUTE_INPUT_FIELD, nonce),
          style: TextInputStyle.Paragraph,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.config.panel.attribute_input_placeholder"),
            MODAL_DESCRIPTION_MAX_LENGTH,
          ),
          max_length: Math.min(4000, memoryLimits.maxAttributeLength),
          required: false,
        },
      },
      {
        type: 18,
        label: modalLabel(locale, "commands.config.panel.attribute_file_label"),
        description: modalDescription(locale, "commands.config.panel.attribute_file_description"),
        component: {
          type: 19,
          custom_id: buildConfigModalFieldId(CONFIG_ATTRIBUTE_FILE_FIELD, nonce),
          min_values: 0,
          max_values: 1,
          required: false,
        },
      },
      buildPublicCheckboxGroup(
        locale,
        nonce,
        CONFIG_ATTRIBUTE_PUBLIC_FIELD,
        "commands.config.panel.attribute_public_label",
        "commands.config.panel.attribute_public_description",
        false,
      ),
    ],
  };
}

export function buildPersonaAttributeEditModal(
  locale: string,
  personaId: number,
  index: number,
  fp: string,
  nonce: string,
  attribute: string,
  isPublic: boolean,
): RawModalPayload {
  const parts = splitPromptIntoModalParts(attribute, 2, 4000);
  const textField = (field: string, labelKey: string, placeholderKey: string, value: string | undefined) => ({
    type: 18 as const,
    label: modalLabel(locale, labelKey),
    component: {
      type: 4,
      custom_id: buildConfigModalFieldId(field, nonce),
      style: TextInputStyle.Paragraph,
      placeholder: safeSelectOptionText(localizer(locale, placeholderKey), MODAL_DESCRIPTION_MAX_LENGTH),
      max_length: 4000,
      required: field.endsWith("_part1"),
      value,
    },
  });

  return {
    custom_id: buildConfigRouteId({ action: "attribute-edit-submit", locale, personaId, index, fp, nonce }),
    title: modalTitle(locale, "commands.config.panel.attribute_edit_modal_title"),
    components: [
      textField(
        "attribute_part1",
        "commands.config.panel.attribute_input_label",
        "commands.config.panel.attribute_input_placeholder",
        parts[0] || undefined,
      ),
      textField(
        "attribute_part2",
        "commands.config.panel.attribute_input_part2_label",
        "commands.config.panel.attribute_input_placeholder",
        parts[1] || undefined,
      ),
      buildPublicCheckboxGroup(
        locale,
        nonce,
        CONFIG_ATTRIBUTE_PUBLIC_FIELD,
        "commands.config.panel.attribute_public_label",
        "commands.config.panel.attribute_public_description",
        isPublic,
      ),
    ],
  };
}

export function buildPersonaDialogueAddModal(locale: string, personaId: number, nonce: string): RawModalPayload {
  const memoryLimits = getMemoryLimits();
  const input = (field: string, labelKey: string, descriptionKey: string, placeholderKey: string) => ({
    type: 18 as const,
    label: modalLabel(locale, labelKey),
    description: modalDescription(locale, descriptionKey),
    component: {
      type: 4,
      custom_id: buildConfigModalFieldId(field, nonce),
      style: TextInputStyle.Paragraph,
      placeholder: safeSelectOptionText(localizer(locale, placeholderKey), MODAL_DESCRIPTION_MAX_LENGTH),
      max_length: Math.min(4000, memoryLimits.maxSampleDialogueLength),
      required: false,
    },
  });

  return {
    custom_id: buildConfigRouteId({ action: "dialogue-add-submit", locale, personaId, nonce }),
    title: modalTitle(locale, "commands.config.panel.dialogue_add_modal_title"),
    components: [
      input(
        CONFIG_DIALOGUE_USER_INPUT_FIELD,
        "commands.config.panel.dialogue_user_input_label",
        "commands.config.panel.dialogue_user_input_description",
        "commands.config.panel.dialogue_user_input_placeholder",
      ),
      input(
        CONFIG_DIALOGUE_BOT_INPUT_FIELD,
        "commands.config.panel.dialogue_bot_input_label",
        "commands.config.panel.dialogue_bot_input_description",
        "commands.config.panel.dialogue_bot_input_placeholder",
      ),
      {
        type: 18,
        label: modalLabel(locale, "commands.config.panel.dialogue_file_label"),
        description: modalDescription(locale, "commands.config.panel.dialogue_file_description"),
        component: {
          type: 19,
          custom_id: buildConfigModalFieldId(CONFIG_DIALOGUE_FILE_FIELD, nonce),
          min_values: 0,
          max_values: 1,
          required: false,
        },
      },
    ],
  };
}

export function buildPersonaDialogueEditModal(
  locale: string,
  personaId: number,
  index: number,
  fp: string,
  nonce: string,
  input: string,
  output: string,
): RawModalPayload {
  const inputParts = splitPromptIntoModalParts(input, 2, 4000);
  const outputParts = splitPromptIntoModalParts(output, 2, 4000);
  const textField = (field: string, labelKey: string, value: string | undefined, required: boolean) => ({
    type: 18 as const,
    label: modalLabel(locale, labelKey),
    component: {
      type: 4,
      custom_id: buildConfigModalFieldId(field, nonce),
      style: TextInputStyle.Paragraph,
      max_length: 4000,
      required,
      value,
    },
  });

  return {
    custom_id: buildConfigRouteId({ action: "dialogue-edit-submit", locale, personaId, index, fp, nonce }),
    title: modalTitle(locale, "commands.config.panel.dialogue_edit_modal_title"),
    components: [
      textField(
        "user_input_part1",
        "commands.config.panel.dialogue_user_input_label",
        inputParts[0] || undefined,
        true,
      ),
      textField(
        "user_input_part2",
        "commands.config.panel.dialogue_user_input_part2_label",
        inputParts[1] || undefined,
        false,
      ),
      textField("bot_input_part1", "commands.config.panel.dialogue_bot_input_label", outputParts[0] || undefined, true),
      textField(
        "bot_input_part2",
        "commands.config.panel.dialogue_bot_input_part2_label",
        outputParts[1] || undefined,
        false,
      ),
    ],
  };
}

/**
 * Five checkbox groups of ten is the whole modal, so a persona whose configured limit exceeds that
 * presents only the first {@link CONFIG_TRIGGER_CHECKBOX_CAPACITY} words. Option values are absolute
 * indexes into the full list and the fingerprint covers the full list, so an unpresented word is
 * simply never in the derived removal set.
 */
export function buildTriggerRemoveModal(
  locale: string,
  personaId: number,
  fp: string,
  nonce: string,
  triggerWords: readonly string[],
): RawModalPayload {
  const presented = triggerWords.slice(0, CONFIG_TRIGGER_CHECKBOX_CAPACITY);
  const truncated = triggerWords.length > presented.length;
  const groups: RawDiscordComponent[] = [];

  for (let offset = 0; offset < presented.length; offset += CONFIG_TRIGGER_CHECKBOX_GROUP_SIZE) {
    const groupIndex = offset / CONFIG_TRIGGER_CHECKBOX_GROUP_SIZE;
    groups.push({
      type: 18,
      label: modalLabel(
        locale,
        groupIndex === 0
          ? "commands.config.panel.trigger_remove_checkbox_label"
          : "commands.config.panel.trigger_remove_checkbox_label_continued",
      ),
      description:
        groupIndex === 0
          ? modalDescription(
              locale,
              truncated
                ? "commands.config.panel.trigger_remove_checkbox_truncated"
                : "commands.config.panel.trigger_remove_checkbox_description",
            )
          : undefined,
      component: {
        // 22 is CheckboxGroup. A FileUpload (19) also renders and submits, but with no option
        // values, which would make unchecked-means-remove delete every presented word.
        type: 22,
        custom_id: buildTriggerRemoveCheckboxGroupId(groupIndex, nonce),
        min_values: 0,
        max_values: CONFIG_TRIGGER_CHECKBOX_GROUP_SIZE,
        required: false,
        options: presented
          .slice(offset, offset + CONFIG_TRIGGER_CHECKBOX_GROUP_SIZE)
          .map((triggerWord, indexInGroup) => ({
            label: safeSelectOptionText(normalizeTriggerWord(triggerWord, { lowercase: false }), 50),
            value: String(offset + indexInGroup),
            default: true,
          })),
      },
    });
  }

  return {
    custom_id: buildConfigRouteId({ action: "trigger-remove-submit", locale, personaId, fp, nonce }),
    title: modalTitle(locale, "commands.config.panel.trigger_remove_modal_title"),
    components: groups,
  };
}

export function buildPersonaStmEditModal(
  locale: string,
  personaId: number,
  nonce: string,
  categoryRows: readonly StmCategoryRow[],
  entry: ShortTermMemoryEntry | undefined,
): RawModalPayload {
  const slugMap = buildSlugMap(categoryRows);
  const inputs = Array.from(slugMap, ([slug, label]) => ({ slug, label })).slice(0, 5);
  const isCategoryMode = !(categoryRows.length === 1 && categoryRows[0]?.label.toLowerCase() === "summary");

  return {
    custom_id: buildConfigRouteId({ action: "stm-edit-submit", locale, personaId, nonce }),
    title: modalTitle(locale, "commands.config.panel.stm_edit_modal_title"),
    components: inputs.map(({ slug, label }) => ({
      type: 18,
      label: modalLabel(locale, label),
      description: modalDescription(locale, "commands.config.panel.stm_category_input_description"),
      component: {
        type: 4,
        custom_id: buildConfigModalFieldId(`${CONFIG_STM_CATEGORY_INPUT_PREFIX}${slug}`, nonce),
        style: TextInputStyle.Paragraph,
        placeholder: safeSelectOptionText(
          localizer(locale, "commands.config.panel.stm_category_input_placeholder"),
          MODAL_DESCRIPTION_MAX_LENGTH,
        ),
        max_length: 1500,
        required: false,
        value: isCategoryMode ? (entry?.categories?.[slug] ?? "") : (entry?.summary ?? ""),
      },
    })),
  };
}

export function buildConditioningCheckboxGroupId(groupIndex: number, nonce: string): string {
  return buildConfigModalFieldId(`conditioning_${groupIndex}`, nonce);
}

export function buildPersonaConditioningRemoveModal(
  locale: string,
  personaId: number,
  fp: string,
  nonce: string,
  personaName: string,
  groups: readonly ConditioningGroup[],
): RawModalPayload {
  const presented = groups.slice(0, CONFIG_CONDITIONING_CHECKBOX_CAPACITY);
  const truncated = groups.length > presented.length;
  const components: RawDiscordComponent[] = [];

  for (let offset = 0; offset < presented.length; offset += CONFIG_CONDITIONING_CHECKBOX_GROUP_SIZE) {
    const groupIndex = offset / CONFIG_CONDITIONING_CHECKBOX_GROUP_SIZE;
    components.push({
      type: 18,
      label: modalLabel(
        locale,
        groupIndex === 0
          ? "commands.config.panel.conditioning_checkbox_label"
          : "commands.config.panel.conditioning_checkbox_label_continued",
      ),
      description:
        groupIndex === 0
          ? modalDescription(
              locale,
              truncated
                ? "commands.config.panel.conditioning_checkbox_truncated"
                : "commands.config.panel.conditioning_checkbox_description",
            )
          : undefined,
      component: {
        type: 22,
        custom_id: buildConditioningCheckboxGroupId(groupIndex, nonce),
        min_values: 0,
        max_values: CONFIG_CONDITIONING_CHECKBOX_GROUP_SIZE,
        required: false,
        options: presented
          .slice(offset, offset + CONFIG_CONDITIONING_CHECKBOX_GROUP_SIZE)
          .map((group, indexInGroup) => {
            const action = localizer(locale, `commands.${group.conditioningType}.${group.actionKey}.history_label`);
            const descriptionKey =
              group.totalCount > 1
                ? "commands.conditioning.manage.option_reason_description"
                : "commands.conditioning.manage.option_reason_description_single";
            let description = localizer(locale, descriptionKey, {
              count: String(group.totalCount),
              reason: group.reasonText,
            });
            if (group.actionText) description = `${description} • ${group.actionText}`;
            return {
              label: safeSelectOptionText(
                localizer(locale, "commands.conditioning.manage.option_label", {
                  persona_name: personaName,
                  type_marker: localizer(locale, `commands.conditioning.manage.marker_${group.conditioningType}`),
                  action,
                }),
                100,
              ),
              value: String(offset + indexInGroup),
              description: safeSelectOptionText(description, 100),
              default: true,
            };
          }),
      },
    });
  }

  return {
    custom_id: buildConfigRouteId({ action: "conditioning-submit", locale, personaId, fp, nonce }),
    title: modalTitle(locale, "commands.config.panel.conditioning_modal_title"),
    components,
  };
}
