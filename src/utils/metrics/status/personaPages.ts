import type { SummaryEmbedOptions } from "@/types/discord/embed";
import type { TomoriState, UserRow } from "@/types/db/schema";
import { personalMemoryRepository } from "@/utils/db/repositories";
import { ColorCode } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";
import { formatBooleanLocalized } from "@/utils/text/processors/formatters";
import { formatLlmDisplayLabel } from "@/utils/provider/modelDisplay";
import { getMemoryLimits } from "@/utils/misc/memoryLimits";
import { normalizeTriggerWord } from "@/utils/text/triggerWords";
import {
  ATTRIBUTE_TRUNCATE_LENGTH,
  DIALOGUE_TRUNCATE_LENGTH,
  formatBulletList,
  formatNumberedList,
  formatPromptPreview,
  formatSampleDialogues,
  MEMORY_TRUNCATE_LENGTH,
} from "@/utils/metrics/status/sharedFormatters";
export async function buildPersonaStatusPages(
  selectedPersona: TomoriState,
  userData: UserRow,
  locale: string,
): Promise<SummaryEmbedOptions[]> {
  const limits = getMemoryLimits();
  const personaName = selectedPersona.persona_nickname ?? "Tomori";
  const personaLineageId = selectedPersona.persona_lineage_id ?? 0;

  let personaPersonalMemoryList: string[] = [];
  if (userData.user_id) {
    const personaPersonalMemoryRows = await personalMemoryRepository.loadForUserLineage(
      userData.user_id,
      personaLineageId,
      false,
    );
    personaPersonalMemoryList = personaPersonalMemoryRows.map((row) => row.content);
  }

  const personaServerMemoryList = selectedPersona.server_memories ?? [];

  const displayedAttributes =
    (selectedPersona.persona_attributes?.length ?? 0) > 0
      ? selectedPersona.persona_attributes.map((attribute) =>
          attribute.is_public
            ? `${attribute.attribute_text} ${localizer(locale, "commands.status.attribute_public_suffix")}`
            : attribute.attribute_text,
        )
      : (selectedPersona.attribute_list ?? []);
  const attributesCount = displayedAttributes.length;
  const attributesValue = formatBulletList(displayedAttributes, locale, ATTRIBUTE_TRUNCATE_LENGTH, 3000);

  const dialogueCount = Math.max(
    selectedPersona.sample_dialogues_in?.length ?? 0,
    selectedPersona.sample_dialogues_out?.length ?? 0,
  );
  const sampleDialoguesValue = formatSampleDialogues(
    selectedPersona.sample_dialogues_in ?? [],
    selectedPersona.sample_dialogues_out ?? [],
    locale,
    DIALOGUE_TRUNCATE_LENGTH,
    3000,
  );

  const personaPersonalMemoriesCount = personaPersonalMemoryList.length;
  const personaPersonalMemoriesValue = formatNumberedList(
    personaPersonalMemoryList,
    locale,
    MEMORY_TRUNCATE_LENGTH,
    1500,
  );
  const personaServerMemoriesCount = personaServerMemoryList.length;
  const personaServerMemoriesValue = formatNumberedList(personaServerMemoryList, locale, MEMORY_TRUNCATE_LENGTH, 1500);

  const personaTriggersValue =
    (selectedPersona.trigger_words?.length ?? 0) > 0
      ? selectedPersona.trigger_words.map((t) => `\`${normalizeTriggerWord(t, { lowercase: false })}\``).join(", ")
      : localizer(locale, "commands.choices.none");

  const physicalAppearanceTagsValue =
    (selectedPersona.physical_appearance_tags?.length ?? 0) > 0
      ? selectedPersona.physical_appearance_tags.join(", ")
      : localizer(locale, "commands.choices.none");

  const personaModelValue = selectedPersona.persona_llm
    ? formatLlmDisplayLabel(
        selectedPersona.persona_llm,
        selectedPersona.config?.custom_model_name,
        selectedPersona.config?.other_model_codename,
      )
    : localizer(locale, "commands.status.persona_model_server_default");

  const noneLabel = localizer(locale, "commands.choices.none");
  const attgAuthor = selectedPersona.nai_attg_author ?? noneLabel;
  const attgTitle = selectedPersona.nai_attg_title ?? noneLabel;
  const attgTags = selectedPersona.nai_attg_tags ?? noneLabel;
  const attgGenre = selectedPersona.nai_attg_genre ?? noneLabel;
  const attgStars = selectedPersona.nai_attg_stars != null ? `${selectedPersona.nai_attg_stars}★` : noneLabel;
  const attgAllUnset =
    !selectedPersona.nai_attg_author &&
    !selectedPersona.nai_attg_title &&
    !selectedPersona.nai_attg_tags &&
    !selectedPersona.nai_attg_genre &&
    selectedPersona.nai_attg_stars == null;
  const attgValue = attgAllUnset
    ? localizer(locale, "commands.status.nai_attg_not_set")
    : `Author: ${attgAuthor}\nTitle: ${attgTitle}\nTags: ${attgTags}\nGenre: ${attgGenre}\nStars: ${attgStars}`;

  const rawPersonaPrompt = selectedPersona.persona_prompt ?? null;
  const personaPromptValue = rawPersonaPrompt
    ? formatPromptPreview(rawPersonaPrompt, locale)
    : localizer(locale, "commands.status.field_persona_prompt_not_set");

  const rawPersonaContextNote = selectedPersona.context_note ?? null;
  const personaContextNoteValue = rawPersonaContextNote
    ? formatPromptPreview(rawPersonaContextNote, locale)
    : localizer(locale, "commands.status.field_persona_context_note_not_set");

  const personaPage1: SummaryEmbedOptions = {
    titleKey: "commands.status.persona_page1_title",
    titleVars: { persona_name: personaName },
    descriptionKey: "commands.status.persona_page1_description",
    color: ColorCode.INFO,
    fields: [
      {
        nameKey: "commands.status.field_nickname",
        value: personaName,
        inline: true,
      },
      {
        nameKey: "commands.status.field_is_alter",
        value: formatBooleanLocalized(selectedPersona.is_alter ?? false, locale),
        inline: true,
      },
      {
        nameKey: "commands.status.field_persona_triggers",
        value: personaTriggersValue,
        inline: true,
      },
      {
        nameKey: "commands.status.field_persona_model",
        value: personaModelValue,
        inline: true,
      },
      {
        nameKey: "commands.status.field_avatar",
        value: selectedPersona.webhook_avatar_url
          ? localizer(locale, "general.yes")
          : localizer(locale, "commands.choices.none"),
        inline: true,
      },
      {
        nameKey: "commands.status.field_voice",
        value: selectedPersona.speech_voice_name ?? localizer(locale, "commands.choices.none"),
        inline: true,
      },
      {
        nameKey: "commands.status.field_persona_nai_ref",
        value: formatBooleanLocalized(!!selectedPersona.nai_char_ref_url, locale),
        inline: true,
      },
      {
        nameKey: "commands.status.field_reward_conditioning",
        value: formatBooleanLocalized(selectedPersona.reward_conditioning_enabled ?? true, locale),
        inline: true,
      },
      {
        nameKey: "commands.status.field_punish_conditioning",
        value: formatBooleanLocalized(selectedPersona.punish_conditioning_enabled ?? true, locale),
        inline: true,
      },
    ],
  };

  const personaPage2: SummaryEmbedOptions = {
    titleKey: "commands.status.persona_page2_title",
    titleVars: { persona_name: personaName },
    descriptionKey: "commands.status.persona_page2_description",
    color: ColorCode.INFO,
    footerKey: "commands.status.export_footer_persona_attributes_and_dialogues",
    fields: [
      {
        nameKey: "commands.status.field_attributes_with_count",
        nameVars: {
          current: attributesCount,
          max: limits.maxAttributes,
        },
        value: attributesValue,
        inline: false,
      },
    ],
  };

  const personaPage3: SummaryEmbedOptions = {
    titleKey: "commands.status.persona_page3_title",
    titleVars: { persona_name: personaName },
    descriptionKey: "commands.status.persona_page3_description",
    color: ColorCode.INFO,
    footerKey: "commands.status.export_footer_persona_attributes_and_dialogues",
    fields: [
      {
        nameKey: "commands.status.field_sample_dialogues_with_count",
        nameVars: {
          current: dialogueCount,
          max: limits.maxSampleDialogues,
        },
        value: sampleDialoguesValue,
        inline: false,
      },
    ],
  };

  const personaPage4: SummaryEmbedOptions = {
    titleKey: "commands.status.persona_page4_title",
    titleVars: { persona_name: personaName },
    descriptionKey: "commands.status.persona_page4_description",
    color: ColorCode.INFO,
    footerKey: "commands.status.export_footer_persona_memories",
    fields: [
      {
        nameKey: "commands.status.field_persona_personal_memories_with_count",
        nameVars: {
          current: personaPersonalMemoriesCount,
          max: limits.maxPersonalMemories,
        },
        value: personaPersonalMemoriesValue,
        inline: false,
      },
      {
        nameKey: "commands.status.field_persona_server_memories_with_count",
        nameVars: {
          current: personaServerMemoriesCount,
          max: limits.maxServerMemories,
        },
        value: personaServerMemoriesValue,
        inline: false,
      },
    ],
  };

  const personaPage5: SummaryEmbedOptions = {
    titleKey: "commands.status.persona_page5_title",
    titleVars: { persona_name: personaName },
    descriptionKey: "commands.status.persona_page5_description",
    color: ColorCode.INFO,
    fields: [
      {
        nameKey: "commands.status.field_persona_prompt",
        value: personaPromptValue,
        inline: false,
      },
      {
        nameKey: "commands.status.field_physical_appearance_tags",
        value: physicalAppearanceTagsValue,
        inline: false,
      },
      {
        nameKey: "commands.status.field_nai_attg",
        value: attgValue,
        inline: false,
      },
      {
        nameKey: "commands.status.field_persona_context_note",
        value: personaContextNoteValue,
        inline: false,
      },
      {
        nameKey: "commands.status.field_persona_context_note_depth",
        value: String(selectedPersona.context_note_depth ?? 0),
        inline: true,
      },
    ],
  };

  return [personaPage1, personaPage2, personaPage3, personaPage4, personaPage5];
}
