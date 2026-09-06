import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type ActionRowData,
  type ButtonComponentData,
  type ChatInputCommandInteraction,
  type ComponentInContainerData,
  type ContainerComponentData,
} from "discord.js";
import type { SummaryEmbedOptions } from "@/types/discord/embed";
import type { TomoriState, UserRow } from "@/types/db/schema";
import { personaRepository, personalMemoryRepository } from "@/utils/db/repositories";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import {
  buildPersonaWorkflowNotice,
  completePersonaWorkflow,
  PERSONA_WORKFLOW_COMPONENT_TIMEOUT_MS as PERSONA_STATUS_TIMEOUT_MS,
  PersonaWorkflowUpdateError,
  runPersonaPickerWorkflow,
  type PersonaWorkflowComponentsV2Payload,
  type PersonaWorkflowSelectionPhase,
} from "@/utils/discord/ui/personaWorkflow";
import { ColorCode, log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";
import { validateAndFallbackPanelPayload } from "@/utils/discord/ui/interactionCore";
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

const PERSONA_STATUS_PREV_SUFFIX = "_persona_status_prev";
const PERSONA_STATUS_NEXT_SUFFIX = "_persona_status_next";
const MAX_TEXT_DISPLAY_LENGTH = 4000;

type SummaryField = SummaryEmbedOptions["fields"][number];

function formatStatusField(field: SummaryField, locale: string): string {
  const name = field.name ?? (field.nameKey ? localizer(locale, field.nameKey, field.nameVars) : "");
  const value = field.value ?? (field.valueKey ? localizer(locale, field.valueKey, field.valueVars) : "");
  return `**${name}**\n${value}`;
}

function truncateTextDisplayContent(content: string): string {
  if (content.length <= MAX_TEXT_DISPLAY_LENGTH) return content;

  const suffix = "\n...";
  const rawLimit = MAX_TEXT_DISPLAY_LENGTH - suffix.length;
  const boundary = content.lastIndexOf("\n", rawLimit);
  const cutAt = boundary >= Math.floor(rawLimit * 0.8) ? boundary : rawLimit;
  let truncated = content.slice(0, cutAt).trimEnd();
  const openCodeFence = (truncated.match(/```/g)?.length ?? 0) % 2 === 1;

  if (openCodeFence) {
    const closingFence = "\n```";
    const fencedLimit = MAX_TEXT_DISPLAY_LENGTH - suffix.length - closingFence.length;
    truncated = content
      .slice(0, Math.min(cutAt, fencedLimit))
      .trimEnd()
      .replace(/`{1,2}$/, "");
    return `${truncated}${closingFence}${suffix}`;
  }

  return `${truncated}${suffix}`;
}

function buildPersonaStatusPayload(
  page: SummaryEmbedOptions,
  locale: string,
  currentPage: number,
  totalPages: number,
  previousCustomId: string,
  nextCustomId: string,
  includeControls: boolean,
): PersonaWorkflowComponentsV2Payload {
  const description =
    page.description ?? (page.descriptionKey ? localizer(locale, page.descriptionKey, page.descriptionVars) : "");
  const heading = `## ${localizer(locale, page.titleKey, page.titleVars)}${description ? `\n${description}` : ""}`;
  const components: ComponentInContainerData[] = [{ type: ComponentType.TextDisplay, content: heading }];

  let inlineFields: string[] = [];
  const flushInlineFields = () => {
    if (inlineFields.length === 0) return;
    components.push({ type: ComponentType.TextDisplay, content: inlineFields.join("\n") });
    inlineFields = [];
  };

  for (const field of page.fields) {
    const fieldContent = truncateTextDisplayContent(formatStatusField(field, locale));
    if (field.inline) {
      const nextLength = inlineFields.join("\n").length + (inlineFields.length > 0 ? 1 : 0) + fieldContent.length;
      if (nextLength > MAX_TEXT_DISPLAY_LENGTH) flushInlineFields();
      inlineFields.push(fieldContent);
      continue;
    }
    flushInlineFields();
    components.push({ type: ComponentType.TextDisplay, content: fieldContent });
  }
  flushInlineFields();

  if (page.footerKey) {
    components.push({ type: ComponentType.Separator, divider: true, spacing: 1 });
    components.push({
      type: ComponentType.TextDisplay,
      content: `-# ${localizer(locale, page.footerKey, page.footerVars)}`,
    });
  }

  if (includeControls && totalPages > 1) {
    const navigationRow: ActionRowData<ButtonComponentData> = {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          customId: previousCustomId,
          label: `◀ ${localizer(locale, "general.pagination.previous")}`,
          style: ButtonStyle.Secondary,
          disabled: currentPage === 0,
        },
        {
          type: ComponentType.Button,
          customId: `${previousCustomId}_label`,
          label: localizer(locale, "general.pagination.page_info", {
            current: currentPage + 1,
            total: totalPages,
          }),
          style: ButtonStyle.Secondary,
          disabled: true,
        },
        {
          type: ComponentType.Button,
          customId: nextCustomId,
          label: `${localizer(locale, "general.pagination.next")} ▶`,
          style: ButtonStyle.Secondary,
          disabled: currentPage === totalPages - 1,
        },
      ],
    };
    components.push(navigationRow);
  }

  const container: ContainerComponentData<ComponentInContainerData> = {
    type: ComponentType.Container,
    accentColor: Number.parseInt(ColorCode.INFO.slice(1), 16),
    components,
  };

  return validateAndFallbackPanelPayload(
    {
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    },
    locale,
  );
}

async function paginatePersonaStatus(
  selection: PersonaWorkflowSelectionPhase<TomoriState>,
  interaction: ChatInputCommandInteraction,
  locale: string,
  pages: SummaryEmbedOptions[],
): Promise<void> {
  if (pages.length === 0) return;

  let currentPage = 0;
  const previousCustomId = `${selection.message.anchorMessageId}${PERSONA_STATUS_PREV_SUFFIX}`;
  const nextCustomId = `${selection.message.anchorMessageId}${PERSONA_STATUS_NEXT_SUFFIX}`;
  const buildPayload = (includeControls: boolean) =>
    buildPersonaStatusPayload(
      pages[currentPage],
      locale,
      currentPage,
      pages.length,
      previousCustomId,
      nextCustomId,
      includeControls,
    );

  await selection.message.replace(buildPayload(true));
  const anchorMessage = await selection.message.fetchMessage();

  try {
    while (true) {
      const button = await anchorMessage.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (candidate) =>
          candidate.user.id === interaction.user.id &&
          (candidate.customId === previousCustomId || candidate.customId === nextCustomId),
        time: PERSONA_STATUS_TIMEOUT_MS,
      });

      currentPage =
        button.customId === previousCustomId
          ? Math.max(0, currentPage - 1)
          : Math.min(pages.length - 1, currentPage + 1);
      await selection.useButton(button).replace(buildPayload(true));
    }
  } catch (error) {
    if (error instanceof PersonaWorkflowUpdateError) throw error;
    log.warn("Persona status pagination collector ended", {
      errorType: "PaginationCollectorEnded",
      metadata: { userId: interaction.user.id, error },
    });
    try {
      await selection.message.replace(buildPayload(false));
    } catch (replacementError) {
      log.warn("Failed to clear persona status controls after collector ended", {
        errorType: "InteractionEditFailed",
        metadata: { userId: interaction.user.id, error: replacementError },
      });
      throw replacementError;
    }
  }
}

export async function showPersonaStatus(
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  serverDiscId: string,
  locale: string,
): Promise<void> {
  const limits = getMemoryLimits();
  const allPersonas = await personaRepository.loadAllForServer(serverDiscId);

  if (allPersonas.length === 0) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.tomori_not_setup_title",
      descriptionKey: "general.errors.tomori_not_setup_description",
      color: ColorCode.ERROR,
    });
    return;
  }

  try {
    await runPersonaPickerWorkflow(interaction, locale, {
      personas: allPersonas,
      color: ColorCode.INFO,
      onSelected: async (selection) => {
        const { message } = await selection.beginInPlaceWork();
        const selectedPersona = selection.persona;

        if (!selectedPersona.persona_id) {
          await message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "general.errors.invalid_option_title",
              descriptionKey: "general.errors.invalid_option_description",
              color: ColorCode.ERROR,
            }),
          );
          return completePersonaWorkflow();
        }

        try {
          await message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "general.persona_workflow.loading_title",
              descriptionKey: "general.persona_workflow.loading_description",
              color: ColorCode.INFO,
            }),
          );

          const personaName = selectedPersona.persona_nickname;
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
            selectedPersona.persona_attributes.length > 0
              ? selectedPersona.persona_attributes.map((attribute) =>
                  attribute.is_public
                    ? `${attribute.attribute_text} ${localizer(locale, "commands.status.attribute_public_suffix")}`
                    : attribute.attribute_text,
                )
              : selectedPersona.attribute_list;
          const attributesCount = displayedAttributes.length;
          const attributesValue = formatBulletList(displayedAttributes, locale, ATTRIBUTE_TRUNCATE_LENGTH);

          const dialogueCount = Math.max(
            selectedPersona.sample_dialogues_in.length,
            selectedPersona.sample_dialogues_out.length,
          );
          const sampleDialoguesValue = formatSampleDialogues(
            selectedPersona.sample_dialogues_in,
            selectedPersona.sample_dialogues_out,
            locale,
            DIALOGUE_TRUNCATE_LENGTH,
          );

          const personaPersonalMemoriesCount = personaPersonalMemoryList.length;
          const personaPersonalMemoriesValue = formatNumberedList(
            personaPersonalMemoryList,
            locale,
            MEMORY_TRUNCATE_LENGTH,
          );
          const personaServerMemoriesCount = personaServerMemoryList.length;
          const personaServerMemoriesValue = formatNumberedList(
            personaServerMemoryList,
            locale,
            MEMORY_TRUNCATE_LENGTH,
          );

          const personaTriggersValue =
            selectedPersona.trigger_words.length > 0
              ? selectedPersona.trigger_words
                  .map((t) => `\`${normalizeTriggerWord(t, { lowercase: false })}\``)
                  .join(", ")
              : localizer(locale, "commands.choices.none");

          const physicalAppearanceTagsValue =
            selectedPersona.physical_appearance_tags.length > 0
              ? selectedPersona.physical_appearance_tags.join(", ")
              : localizer(locale, "commands.choices.none");

          const personaModelValue = selectedPersona.persona_llm
            ? formatLlmDisplayLabel(
                selectedPersona.persona_llm,
                selectedPersona.config.custom_model_name,
                selectedPersona.config.other_model_codename,
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
                value: formatBooleanLocalized(selectedPersona.is_alter, locale),
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

          await paginatePersonaStatus(selection, interaction, locale, [
            personaPage1,
            personaPage2,
            personaPage3,
            personaPage4,
            personaPage5,
          ]);
        } catch (error) {
          if (error instanceof PersonaWorkflowUpdateError) throw error;
          log.error("Failed to build persona status pages", error, {
            serverId: selectedPersona.server_id,
            personaId: selectedPersona.persona_id,
            errorType: "CommandExecutionError",
            metadata: {
              command: "status",
              scope: "persona",
              userId: interaction.user.id,
            },
          });
          await message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "general.errors.unknown_error_title",
              descriptionKey: "general.errors.unknown_error_description",
              color: ColorCode.ERROR,
            }),
          );
        }

        return completePersonaWorkflow();
      },
    });
  } catch (error) {
    log.error("Persona status workflow terminated unexpectedly", error, {
      errorType: "CommandExecutionError",
      metadata: {
        command: "status",
        scope: "persona",
        userId: interaction.user.id,
      },
    });
  }
}
