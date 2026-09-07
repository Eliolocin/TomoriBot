import { TextInputStyle } from "discord.js";
import type { LlmRow, PersonaSpriteRow, StmCategoryRow, TomoriState } from "@/types/db/schema";
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
import { formatImageTagsForModalValue, TAGS_MODAL_MAX_LENGTH } from "@/utils/image/tagHelpers";
import { CONTEXT_NOTE_MAX_LENGTH } from "@/utils/discord/contextNoteOptions";
import { PERSONA_SPRITE_LIMITS } from "@/utils/persona/sprites";
import { splitPromptIntoModalParts } from "@/utils/text/modalPromptParts";
import { promptPartDescription, promptPartLabel } from "@/utils/discord/ui/modalPromptPartLabels";
import { resolvePrefillPrompt } from "@/utils/text/personaPrompt";
import { localizer } from "@/utils/text/localizer";
import { normalizeTriggerWord } from "@/utils/text/triggerWords";
import { buildSlugMap } from "@/utils/text/slugifyLabel";
import { createHumanizerOptions, HUMANIZER_INHERIT_VALUE } from "@/utils/discord/humanizerOptions";

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
export const CONFIG_CONTEXT_NOTE_DEPTH_FIELD = "context_note_depth";
export const CONFIG_CONTEXT_NOTE_TEXT_FIELD = "context_note_text";
export const CONFIG_PERSONA_PROMPT_PART_FIELDS = [
  "persona_prompt_part1",
  "persona_prompt_part2",
  "persona_prompt_part3",
  "persona_prompt_part4",
] as const;
export const CONFIG_CHARACTER_REFERENCE_FILE_FIELD = "character_reference";
export const CONFIG_NAI_ATTG_AUTHOR_FIELD = "nai_attg_author";
export const CONFIG_NAI_ATTG_TITLE_FIELD = "nai_attg_title";
export const CONFIG_NAI_ATTG_TAGS_FIELD = "nai_attg_tags";
export const CONFIG_NAI_ATTG_GENRE_FIELD = "nai_attg_genre";
export const CONFIG_NAI_ATTG_STARS_FIELD = "nai_attg_stars";
export const CONFIG_HUMANIZER_FIELD = "humanizer";
export const CONFIG_TEXT_OVERRIDE_MODEL_FIELD = "text_override_model";
export const CONFIG_SPRITE_NAME_FIELD = "sprite_name";
export const CONFIG_SPRITE_IMAGE_FIELD = "sprite_image";
export const CONFIG_SPRITE_INSTRUCTIONS_FIELD = "sprite_instructions";
export const CONFIG_SPRITE_IDENTITY_FIELD = "sprite_identity";
export const CONFIG_SPRITE_ARCHIVE_FIELD = "sprite_archive";
export const CONFIG_SPRITE_IDENTITY_OPTION_VALUE = "identity";
export const CONFIG_VOICE_SAMPLE_FILE_FIELD = "voice_sample_file";
export const CONFIG_VOICE_SAMPLE_NAME_FIELD = "voice_sample_name";
export const CONFIG_VOICE_SAMPLE_REF_TEXT_FIELD = "voice_sample_ref_text";
export const CONFIG_TTS_CFG_WEIGHT_FIELD = "tts_cfg_weight";
export const CONFIG_TTS_EXAGGERATION_FIELD = "tts_exaggeration";
export const CONFIG_TTS_TURBO_FIELD = "tts_turbo";

const MODAL_TITLE_MAX_LENGTH = 45;
const MODAL_DESCRIPTION_MAX_LENGTH = 100;

const NAMING_MODAL_TITLE_KEYS: Record<AddressingStyle, string> = {
  masculine: "commands.config.panel.naming_modal_title_masculine",
  feminine: "commands.config.panel.naming_modal_title_feminine",
  neutral: "commands.config.panel.naming_modal_title_neutral",
};

function modalTitle(locale: string, key: string): string {
  return safeSelectOptionText(localizer(locale, key), MODAL_TITLE_MAX_LENGTH);
}

function modalLabel(locale: string, key: string): string {
  return safeSelectOptionText(localizer(locale, key), MODAL_TITLE_MAX_LENGTH);
}

function modalDescription(locale: string, key: string): string {
  return safeSelectOptionText(localizer(locale, key), MODAL_DESCRIPTION_MAX_LENGTH);
}

export function buildConfigVoiceSampleAddModal(locale: string, nonce: string): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "voice-sample-add-submit", locale, nonce }),
    title: modalTitle(locale, "commands.config.panel.voices.add.modal_title"),
    components: [
      {
        type: 18,
        label: modalLabel(locale, "commands.config.panel.voices.add.file_label"),
        description: modalDescription(locale, "commands.config.panel.voices.add.file_description"),
        component: {
          // FileUpload is represented by literal type 19 inside a Label on Discord's modal API.
          type: 19,
          custom_id: buildConfigModalFieldId(CONFIG_VOICE_SAMPLE_FILE_FIELD, nonce),
          min_values: 1,
          max_values: 1,
          required: true,
        },
      },
      {
        type: 18,
        label: modalLabel(locale, "commands.config.panel.voices.add.name_label"),
        description: modalDescription(locale, "commands.config.panel.voices.add.name_input_description"),
        component: {
          type: 4,
          custom_id: buildConfigModalFieldId(CONFIG_VOICE_SAMPLE_NAME_FIELD, nonce),
          style: TextInputStyle.Short,
          max_length: 80,
          required: true,
        },
      },
      {
        type: 18,
        label: modalLabel(locale, "commands.config.panel.voices.add.ref_text_label"),
        description: modalDescription(locale, "commands.config.panel.voices.add.ref_text_input_description"),
        component: {
          type: 4,
          custom_id: buildConfigModalFieldId(CONFIG_VOICE_SAMPLE_REF_TEXT_FIELD, nonce),
          style: TextInputStyle.Paragraph,
          max_length: 500,
          required: false,
        },
      },
    ],
  };
}

export function buildConfigTtsParametersModal(
  locale: string,
  nonce: string,
  cfgWeight: number,
  exaggeration: number,
  turboEnabled: boolean,
): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "tts-parameters-submit", locale, nonce }),
    title: modalTitle(locale, "commands.config.panel.voices.parameters.modal_title"),
    components: [
      {
        type: 18,
        label: modalLabel(locale, "commands.config.panel.voices.parameters.cfg_weight_label"),
        description: modalDescription(locale, "commands.config.panel.voices.parameters.cfg_weight_input_description"),
        component: {
          type: 4,
          custom_id: buildConfigModalFieldId(CONFIG_TTS_CFG_WEIGHT_FIELD, nonce),
          style: TextInputStyle.Short,
          value: String(cfgWeight),
          required: true,
        },
      },
      {
        type: 18,
        label: modalLabel(locale, "commands.config.panel.voices.parameters.exaggeration_label"),
        description: modalDescription(locale, "commands.config.panel.voices.parameters.exaggeration_input_description"),
        component: {
          type: 4,
          custom_id: buildConfigModalFieldId(CONFIG_TTS_EXAGGERATION_FIELD, nonce),
          style: TextInputStyle.Short,
          value: String(exaggeration),
          required: true,
        },
      },
      {
        type: 18,
        label: modalLabel(locale, "commands.config.panel.voices.parameters.turbo_label"),
        description: modalDescription(locale, "commands.config.panel.voices.parameters.turbo_input_description"),
        component: {
          // RadioGroup is represented by literal type 21 inside a Label on Discord's modal API.
          type: 21,
          custom_id: buildConfigModalFieldId(CONFIG_TTS_TURBO_FIELD, nonce),
          required: true,
          options: [
            {
              label: modalLabel(locale, "commands.config.panel.off_button"),
              value: "off",
              default: !turboEnabled,
            },
            {
              label: modalLabel(locale, "commands.config.panel.on_button"),
              value: "on",
              default: turboEnabled,
            },
          ],
        },
      },
    ],
  };
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

export function buildPersonaImageTagsModal(
  locale: string,
  personaId: number,
  nonce: string,
  currentTags: string[] | null | undefined,
): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "image-tags-submit", locale, personaId, nonce }),
    title: modalTitle(locale, "commands.persona.image-tags.modal_title"),
    components: [
      {
        type: 18,
        label: modalLabel(locale, "commands.persona.image-tags.tags_input_label"),
        description: modalDescription(locale, "commands.persona.image-tags.tags_input_description"),
        component: {
          type: 4,
          custom_id: buildConfigModalFieldId("image_tags", nonce),
          style: TextInputStyle.Paragraph,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.persona.image-tags.tags_input_placeholder"),
            MODAL_DESCRIPTION_MAX_LENGTH,
          ),
          max_length: TAGS_MODAL_MAX_LENGTH,
          required: false,
          value: formatImageTagsForModalValue(currentTags),
        },
      },
    ],
  };
}

export function buildPersonaAttgModal(
  locale: string,
  personaId: number,
  nonce: string,
  current: Pick<
    TomoriState,
    "nai_attg_author" | "nai_attg_title" | "nai_attg_tags" | "nai_attg_genre" | "nai_attg_stars"
  >,
): RawModalPayload {
  const fields = [
    {
      field: CONFIG_NAI_ATTG_AUTHOR_FIELD,
      labelKey: "commands.novelai.attg.author_label",
      placeholderKey: "commands.novelai.attg.author_placeholder",
      value: current.nai_attg_author,
      maxLength: 256,
    },
    {
      field: CONFIG_NAI_ATTG_TITLE_FIELD,
      labelKey: "commands.novelai.attg.title_label",
      placeholderKey: "commands.novelai.attg.title_placeholder",
      value: current.nai_attg_title,
      maxLength: 256,
    },
    {
      field: CONFIG_NAI_ATTG_TAGS_FIELD,
      labelKey: "commands.novelai.attg.tags_label",
      placeholderKey: "commands.novelai.attg.tags_placeholder",
      value: current.nai_attg_tags,
      maxLength: 256,
    },
    {
      field: CONFIG_NAI_ATTG_GENRE_FIELD,
      labelKey: "commands.novelai.attg.genre_label",
      placeholderKey: "commands.novelai.attg.genre_placeholder",
      value: current.nai_attg_genre,
      maxLength: 256,
    },
    {
      field: CONFIG_NAI_ATTG_STARS_FIELD,
      labelKey: "commands.novelai.attg.stars_label",
      placeholderKey: "commands.novelai.attg.stars_placeholder",
      value:
        current.nai_attg_stars === null || current.nai_attg_stars === undefined ? null : String(current.nai_attg_stars),
      maxLength: 1,
    },
  ] as const;

  return {
    custom_id: buildConfigRouteId({ action: "attg-submit", locale, personaId, nonce }),
    title: modalTitle(locale, "commands.novelai.attg.modal_title"),
    components: fields.map(({ field, labelKey, placeholderKey, value, maxLength }) => ({
      type: 18,
      label: modalLabel(locale, labelKey),
      component: {
        type: 4,
        custom_id: buildConfigModalFieldId(field, nonce),
        style: TextInputStyle.Short,
        placeholder: modalDescription(locale, placeholderKey),
        max_length: maxLength,
        required: false,
        ...(value ? { value } : {}),
      },
    })),
  };
}

export function buildPersonaCharacterReferenceModal(locale: string, personaId: number, nonce: string): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "character-reference-submit", locale, personaId, nonce }),
    title: modalTitle(locale, "commands.config.panel.character_reference_modal_title"),
    components: [
      {
        type: 18,
        label: modalLabel(locale, "commands.config.panel.character_reference_image_label"),
        description: modalDescription(locale, "commands.config.panel.character_reference_upload_description"),
        component: {
          type: 19,
          custom_id: buildConfigModalFieldId(CONFIG_CHARACTER_REFERENCE_FILE_FIELD, nonce),
          min_values: 1,
          max_values: 1,
          required: true,
        },
      },
    ],
  };
}

export function buildPersonaHumanizerModal(
  locale: string,
  personaId: number,
  nonce: string,
  currentValue: number | null | undefined,
): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "humanizer-submit", locale, personaId, nonce }),
    title: modalTitle(locale, "commands.config.panel.edit_humanizer_button"),
    components: [
      {
        type: 18,
        label: modalLabel(locale, "commands.config.panel.response_style_title"),
        description: modalDescription(locale, "commands.config.panel.response_style_description"),
        component: {
          type: 3,
          custom_id: buildConfigModalFieldId(CONFIG_HUMANIZER_FIELD, nonce),
          min_values: 1,
          max_values: 1,
          required: true,
          options: createHumanizerOptions(
            locale,
            currentValue === null || currentValue === undefined ? HUMANIZER_INHERIT_VALUE : String(currentValue),
            true,
          ).map((option) => ({
            label: safeSelectOptionText(option.label, 100),
            value: option.value,
            description: option.description ? safeSelectOptionText(option.description, 100) : undefined,
            default: option.default,
          })),
        },
      },
    ],
  };
}

export function buildPersonaTextOverrideModelModal(
  locale: string,
  personaId: number,
  provider: string,
  nonce: string,
  models: readonly LlmRow[],
  currentModelId: number | null | undefined,
): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "text-override-model-submit", locale, personaId, provider, nonce }),
    title: modalTitle(locale, "commands.config.panel.change_override_button"),
    components: [
      {
        type: 18,
        label: modalLabel(locale, "commands.config.panel.text_override_model_placeholder"),
        component: {
          type: 3,
          custom_id: buildConfigModalFieldId(CONFIG_TEXT_OVERRIDE_MODEL_FIELD, nonce),
          min_values: 1,
          max_values: 1,
          required: true,
          options: models.map((model) => ({
            label: safeSelectOptionText(model.llm_codename, 100),
            value: model.llm_codename,
            description: model.llm_description ? safeSelectOptionText(model.llm_description, 100) : undefined,
            default: model.llm_id === currentModelId,
          })),
        },
      },
    ],
  };
}

/**
 * The "Save as Identity" toggle, shaped like the attribute visibility group so an unchecked box and
 * a submit that carried no checkbox evidence stay distinguishable.
 */
function buildSpriteIdentityCheckboxGroup(locale: string, nonce: string, isIdentity: boolean): RawDiscordComponent {
  return {
    type: 18,
    label: modalLabel(locale, "commands.persona.sprites.add.identity_label"),
    description: modalDescription(locale, "commands.persona.sprites.add.identity_description"),
    component: {
      // 22 is CheckboxGroup.
      type: 22,
      custom_id: buildConfigModalFieldId(CONFIG_SPRITE_IDENTITY_FIELD, nonce),
      min_values: 0,
      max_values: 1,
      required: false,
      options: [
        {
          label: modalLabel(locale, "commands.config.panel.sprite_identity_option"),
          value: CONFIG_SPRITE_IDENTITY_OPTION_VALUE,
          default: isIdentity,
        },
      ],
    },
  };
}

function buildSpriteNameField(locale: string, nonce: string, value?: string): RawDiscordComponent {
  return {
    type: 18,
    label: modalLabel(locale, "commands.persona.sprites.add.sprite_name_label"),
    description: modalDescription(locale, "commands.persona.sprites.add.sprite_name_description"),
    component: {
      type: 4,
      custom_id: buildConfigModalFieldId(CONFIG_SPRITE_NAME_FIELD, nonce),
      style: TextInputStyle.Short,
      placeholder: safeSelectOptionText(
        localizer(locale, "commands.persona.sprites.add.sprite_name_placeholder"),
        MODAL_DESCRIPTION_MAX_LENGTH,
      ),
      min_length: 1,
      max_length: PERSONA_SPRITE_LIMITS.MAX_NAME_LENGTH,
      required: true,
      value,
    },
  };
}

function buildSpriteInstructionsField(locale: string, nonce: string, value?: string): RawDiscordComponent {
  return {
    type: 18,
    label: modalLabel(locale, "commands.persona.sprites.add.instructions_label"),
    description: modalDescription(locale, "commands.persona.sprites.add.instructions_description"),
    component: {
      type: 4,
      custom_id: buildConfigModalFieldId(CONFIG_SPRITE_INSTRUCTIONS_FIELD, nonce),
      style: TextInputStyle.Paragraph,
      placeholder: safeSelectOptionText(
        localizer(locale, "commands.persona.sprites.add.instructions_placeholder"),
        MODAL_DESCRIPTION_MAX_LENGTH,
      ),
      max_length: PERSONA_SPRITE_LIMITS.MAX_INSTRUCTIONS_LENGTH,
      required: false,
      value,
    },
  };
}

function buildSpriteImageField(locale: string, nonce: string, required: boolean): RawDiscordComponent {
  return {
    type: 18,
    label: modalLabel(locale, "commands.persona.sprites.add.image_label"),
    description: modalDescription(
      locale,
      required ? "commands.persona.sprites.add.image_description" : "commands.persona.sprites.edit.image_description",
    ),
    component: {
      // 19 is FileUpload.
      type: 19,
      custom_id: buildConfigModalFieldId(CONFIG_SPRITE_IMAGE_FIELD, nonce),
      min_values: required ? 1 : 0,
      max_values: 1,
      required,
    },
  };
}

export function buildPersonaSpriteAddModal(locale: string, personaId: number, nonce: string): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "sprite-add-submit", locale, personaId, nonce }),
    title: modalTitle(locale, "commands.config.panel.sprite_add_modal_title"),
    components: [
      buildSpriteNameField(locale, nonce),
      buildSpriteImageField(locale, nonce, true),
      buildSpriteInstructionsField(locale, nonce),
      buildSpriteIdentityCheckboxGroup(locale, nonce, false),
    ],
  };
}

export function buildPersonaSpriteEditModal(
  locale: string,
  personaId: number,
  index: number,
  fp: string,
  nonce: string,
  sprite: PersonaSpriteRow,
): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "sprite-edit-submit", locale, personaId, index, fp, nonce }),
    title: modalTitle(locale, "commands.config.panel.sprite_edit_modal_title"),
    components: [
      buildSpriteNameField(locale, nonce, sprite.sprite_name),
      buildSpriteImageField(locale, nonce, false),
      buildSpriteInstructionsField(locale, nonce, sprite.usage_instructions.trim() || undefined),
      buildSpriteIdentityCheckboxGroup(locale, nonce, sprite.is_identity),
    ],
  };
}

export function buildPersonaSpriteImportModal(locale: string, personaId: number, nonce: string): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "sprite-import-submit", locale, personaId, nonce }),
    title: modalTitle(locale, "commands.config.panel.sprite_import_modal_title"),
    components: [
      {
        type: 18,
        label: modalLabel(locale, "commands.persona.sprites.import.archive_label"),
        description: modalDescription(locale, "commands.persona.sprites.import.archive_description"),
        component: {
          // 19 is FileUpload.
          type: 19,
          custom_id: buildConfigModalFieldId(CONFIG_SPRITE_ARCHIVE_FIELD, nonce),
          min_values: 1,
          max_values: 1,
          required: true,
        },
      },
    ],
  };
}

export function buildPersonaPromptModal(locale: string, personaId: number, nonce: string, persona: TomoriState) {
  const parts = splitPromptIntoModalParts(
    resolvePrefillPrompt(persona),
    CONFIG_PERSONA_PROMPT_PART_FIELDS.length,
    4000,
  );
  const placeholders = [
    "commands.teach.personaprompt.part1_placeholder",
    "commands.teach.personaprompt.part2_placeholder",
    "commands.teach.personaprompt.part3_placeholder",
    "commands.teach.personaprompt.part4_placeholder",
  ];

  return {
    custom_id: buildConfigRouteId({ action: "prompt-submit", locale, personaId, nonce }),
    title: modalTitle(locale, "commands.teach.personaprompt.modal_title"),
    components: CONFIG_PERSONA_PROMPT_PART_FIELDS.map((field, index) => ({
      type: 18 as const,
      label: promptPartLabel(
        locale,
        "commands.config.panel.prompt_part_name_persona",
        index,
        CONFIG_PERSONA_PROMPT_PART_FIELDS.length,
      ),
      description: promptPartDescription(locale, index),
      component: {
        type: 4,
        custom_id: buildConfigModalFieldId(field, nonce),
        style: TextInputStyle.Paragraph,
        placeholder: safeSelectOptionText(
          localizer(locale, placeholders[index] as string),
          MODAL_DESCRIPTION_MAX_LENGTH,
        ),
        max_length: 4000,
        required: false,
        value: parts[index] || undefined,
      },
    })),
  } satisfies RawModalPayload;
}

export function buildPersonaContextNoteModal(
  locale: string,
  personaId: number,
  nonce: string,
  currentNote: string | null | undefined,
  currentDepth: number | null | undefined,
): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "context-note-submit", locale, personaId, nonce }),
    title: modalTitle(locale, "commands.config.context-note.set.modal_title"),
    components: [
      {
        type: 18,
        label: modalLabel(locale, "commands.config.context-note.set.text_label"),
        description: modalDescription(locale, "commands.config.context-note.set.text_placeholder"),
        component: {
          type: 4,
          custom_id: buildConfigModalFieldId(CONFIG_CONTEXT_NOTE_TEXT_FIELD, nonce),
          style: TextInputStyle.Paragraph,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.config.context-note.set.text_placeholder"),
            MODAL_DESCRIPTION_MAX_LENGTH,
          ),
          max_length: CONTEXT_NOTE_MAX_LENGTH,
          required: false,
          value: currentNote ?? undefined,
        },
      },
      {
        type: 18,
        label: modalLabel(locale, "commands.config.context-note.set.depth_label"),
        description: modalDescription(locale, "commands.config.context-note.set.depth_placeholder"),
        component: {
          type: 4,
          custom_id: buildConfigModalFieldId(CONFIG_CONTEXT_NOTE_DEPTH_FIELD, nonce),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.config.context-note.set.depth_placeholder"),
            MODAL_DESCRIPTION_MAX_LENGTH,
          ),
          max_length: 3,
          required: true,
          value: String(currentDepth ?? 0),
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
    title: modalTitle(locale, NAMING_MODAL_TITLE_KEYS[style]),
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
      component: (() => {
        const groupOptions = presented.slice(offset, offset + CONFIG_TRIGGER_CHECKBOX_GROUP_SIZE);
        return {
          // 22 is CheckboxGroup. A FileUpload (19) also renders and submits, but with no option
          // values, which would make unchecked-means-remove delete every presented word.
          type: 22,
          custom_id: buildTriggerRemoveCheckboxGroupId(groupIndex, nonce),
          min_values: 0,
          // Discord requires options.length >= max_values, so a partial trailing group (fewer
          // than CONFIG_TRIGGER_CHECKBOX_GROUP_SIZE words) must cap max_values to its own size.
          max_values: groupOptions.length,
          required: false,
          options: groupOptions.map((triggerWord, indexInGroup) => ({
            label: safeSelectOptionText(normalizeTriggerWord(triggerWord, { lowercase: false }), 50),
            value: String(offset + indexInGroup),
            default: true,
          })),
        };
      })(),
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
      component: (() => {
        const groupOptions = presented.slice(offset, offset + CONFIG_CONDITIONING_CHECKBOX_GROUP_SIZE);
        return {
          type: 22,
          custom_id: buildConditioningCheckboxGroupId(groupIndex, nonce),
          min_values: 0,
          // Discord requires options.length >= max_values, so a partial trailing group must cap
          // max_values to its own size instead of the full group capacity.
          max_values: groupOptions.length,
          required: false,
          options: groupOptions.map((group, indexInGroup) => {
            const action = localizer(locale, `commands.${group.conditioningType}.${group.actionKey}.history_label`);
            const descriptionKey =
              group.totalCount > 1
                ? "commands.conditioning.shared.option_reason_description"
                : "commands.conditioning.shared.option_reason_description_single";
            let description = localizer(locale, descriptionKey, {
              count: String(group.totalCount),
              reason: group.reasonText,
            });
            if (group.actionText) description = `${description} • ${group.actionText}`;
            return {
              label: safeSelectOptionText(
                localizer(locale, "commands.conditioning.shared.option_label", {
                  persona_name: personaName,
                  type_marker: localizer(locale, `commands.conditioning.shared.marker_${group.conditioningType}`),
                  action,
                }),
                100,
              ),
              value: String(offset + indexInGroup),
              description: safeSelectOptionText(description, 100),
              default: true,
            };
          }),
        };
      })(),
    });
  }

  return {
    custom_id: buildConfigRouteId({ action: "conditioning-submit", locale, personaId, fp, nonce }),
    title: modalTitle(locale, "commands.config.panel.conditioning_modal_title"),
    components,
  };
}
