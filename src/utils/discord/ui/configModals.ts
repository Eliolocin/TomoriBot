import { TextInputStyle } from "discord.js";
import type { RawDiscordComponent } from "@/types/discord/rawApiTypes";
import { PERSONA_NAMING_VALUE_MAX_LENGTH, type AddressingStyle } from "@/types/personaNaming";
import {
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
import { localizer } from "@/utils/text/localizer";
import { normalizeTriggerWord } from "@/utils/text/triggerWords";

export interface RawModalPayload {
  custom_id: string;
  title: string;
  components: RawDiscordComponent[];
}

export function buildConfigModalFieldId(field: string, nonce: string): string {
  return `${field}_${nonce}`;
}

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
