import type {
  ActionRowData,
  ButtonComponentData,
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  ComponentInContainerData,
  ContainerComponentData,
  ModalSubmitInteraction,
  SlashCommandSubcommandBuilder,
} from "discord.js";
import { ButtonStyle, ComponentType, MessageFlags, TextInputStyle } from "discord.js";
import { localizer } from "@/utils/text/localizer";
import { log, ColorCode } from "@/utils/misc/logger";
import {
  acknowledgeModalSubmitForRefresh,
  promptWithPaginatedModal,
  promptWithRawModal,
  safeSelectOptionText,
} from "@/utils/discord/ui/modals";
import { promptWithUnacknowledgedConfirmation } from "@/utils/discord/ui/confirmation";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import {
  buildPersonaWorkflowNotice,
  completePersonaWorkflow,
  PERSONA_WORKFLOW_COMPONENT_TIMEOUT_MS as WORKFLOW_COMPONENT_TIMEOUT_MS,
  retryPersonaWorkflow,
  runPersonaPickerWorkflow,
  type PersonaWorkflowComponentsV2Payload,
  type PersonaWorkflowMessageController,
} from "@/utils/discord/ui/personaWorkflow";
import { lineageIdIsEligible } from "@/utils/discord/ui/personaEligibility";
import { createStandardEmbed } from "@/utils/discord/embedHelper";
import { personaRepository, personalMemoryRepository, userRepository } from "@/utils/db/repositories";
import { invalidateUserCache } from "@/utils/cache/userCache";
import { getMemoryLimits, validateMemoryContent } from "@/utils/misc/memoryLimits";
import type { SelectOption } from "@/types/discord/modal";
import {
  PrivacyLevel,
  type ErrorContext,
  type PersonalMemoryRow,
  type TomoriState,
  type UserRow,
} from "@/types/db/schema";

const SELECT_MODAL_CUSTOM_ID = "memory_personal_edit_select_modal";
const EDIT_MODAL_CUSTOM_ID = "memory_personal_edit_value_modal";
const MEMORY_SELECT_ID = "memory_select";
const MEMORY_INPUT_ID = "personal_memory_input";
const MEMORY_TAGS_INPUT_ID = "personal_memory_tags_input";
const PERSONAL_SCOPE_VALUE = "persona";
const GLOBAL_SCOPE_VALUE = "global";
const GLOBAL_PERSONAL_MEMORY_LINEAGE_ID = 0;

const MAX_TAGS = 5;
const MAX_TAG_LENGTH = 32;
const CONFIRMATION_DESCRIPTION_LIMIT = 3800;
const memoryLimits = getMemoryLimits();

function formatMemoryPreview(memory: string, maxLength = 120): string {
  return memory.length > maxLength ? `${memory.slice(0, maxLength)}...` : memory;
}

function buildConfirmationPayload(locale: string, memory: string, phaseId: string): PersonaWorkflowComponentsV2Payload {
  const actionRow: ActionRowData<ButtonComponentData> = {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Success,
        customId: `memory_personal_edit_confirm_${phaseId}`,
        label: localizer(locale, "general.confirm"),
      },
      {
        type: ComponentType.Button,
        style: ButtonStyle.Danger,
        customId: `memory_personal_edit_cancel_${phaseId}`,
        label: localizer(locale, "general.pagination.cancel"),
      },
    ],
  };
  const components: ComponentInContainerData[] = [
    {
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "commands.memory.personal.edit.confirm_title")}`,
    },
    {
      type: ComponentType.TextDisplay,
      content: localizer(locale, "commands.memory.personal.edit.confirm_description", { memory }).slice(
        0,
        CONFIRMATION_DESCRIPTION_LIMIT,
      ),
    },
    actionRow,
  ];
  const container: ContainerComponentData<ComponentInContainerData> = {
    type: ComponentType.Container,
    accentColor: Number.parseInt(ColorCode.INFO.replace("#", ""), 16),
    components,
  };
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

async function performPersonalMemoryEdit(
  memoryToEdit: PersonalMemoryRow,
  newContent: string,
  newTags: string[],
  userData: UserRow,
  replyInteraction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction,
  locale: string,
  suppressSuccessReply = false,
): Promise<boolean> {
  if (!memoryToEdit.personal_memory_id) {
    log.error(
      `performPersonalMemoryEdit called with memory row missing personal_memory_id for user ${userData.user_disc_id}`,
    );
    return false;
  }
  const ok = await personalMemoryRepository.edit(memoryToEdit.personal_memory_id, newContent, newTags ?? []);
  if (!ok) {
    await replyInfoEmbed(replyInteraction, locale, {
      titleKey: "general.errors.update_failed_title",
      descriptionKey: "general.errors.update_failed_description",
      color: ColorCode.ERROR,
    });
    return false;
  }

  invalidateUserCache(userData.user_disc_id);

  log.success(
    `Updated personal memory ${memoryToEdit.personal_memory_id} for user ${userData.user_disc_id}: "${formatMemoryPreview(newContent, 60)}"`,
  );

  if (!suppressSuccessReply) {
    await replyInfoEmbed(replyInteraction, locale, {
      titleKey: "commands.memory.personal.edit.success_title",
      descriptionKey: "commands.memory.personal.edit.success_description",
      descriptionVars: {
        memory: formatMemoryPreview(newContent, 96),
      },
      color: ColorCode.SUCCESS,
    });
  }

  return true;
}

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("edit")
    .setDescription(localizer("en-US", "commands.memory.personal.edit.description"))
    .addStringOption((option) =>
      option
        .setName("scope")
        .setDescription(localizer("en-US", "commands.memory.personal.edit.scope_description"))
        .setRequired(false)
        .addChoices(
          {
            name: localizer("en-US", "commands.memory.personal.edit.scope_choice_persona"),
            value: PERSONAL_SCOPE_VALUE,
          },
          {
            name: localizer("en-US", "commands.memory.personal.edit.scope_choice_global"),
            value: GLOBAL_SCOPE_VALUE,
          },
        ),
    );

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.channel) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.channel_only_title",
      descriptionKey: "general.errors.channel_only_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let tomoriState: TomoriState | null = null;
  let selectedPersona: TomoriState | null = null;
  const workflowState: {
    message: PersonaWorkflowMessageController | null;
    selectedPersona: TomoriState | null;
  } = { message: null, selectedPersona: null };
  let personalizationDisabledWarning = false;
  const memoryScope =
    (interaction.options.getString("scope") as typeof PERSONAL_SCOPE_VALUE | typeof GLOBAL_SCOPE_VALUE | null) ??
    PERSONAL_SCOPE_VALUE;

  try {
    if (memoryScope === PERSONAL_SCOPE_VALUE) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    const serverDiscId = interaction.guild?.id ?? interaction.user.id;
    tomoriState = await personaRepository.loadState(serverDiscId);

    if (!tomoriState) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!tomoriState.config.personal_memories_enabled) {
      personalizationDisabledWarning = true;
    }

    const userPrivacyLevel = await userRepository.getPrivacyLevel(interaction.user.id);
    if (userPrivacyLevel === PrivacyLevel.FULL) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.teach.memory.personal.opted_out_error_title",
        descriptionKey: "commands.teach.memory.personal.opted_out_error_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (memoryScope === PERSONAL_SCOPE_VALUE) {
      const allPersonas = await personaRepository.loadAllForServer(serverDiscId);
      if (allPersonas.length === 0) {
        await replyInfoEmbed(interaction, locale, {
          titleKey: "general.errors.tomori_not_setup_title",
          descriptionKey: "general.errors.tomori_not_setup_description",
          color: ColorCode.ERROR,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // Class B eligibility keyed on lineages for which this user has personal
      // memories (lineage 0 excluded, matching the branch's global rejection).
      // Editing does not delete memories, so the set stays static (no refresh).
      const eligibleLineageIds = userData.user_id
        ? await personalMemoryRepository.lineageIdsWithMemories(userData.user_id)
        : new Set<number>();
      const isEligible = lineageIdIsEligible(eligibleLineageIds);
      const eligiblePersonas = allPersonas.filter(isEligible);
      if (eligiblePersonas.length === 0) {
        await replyInfoEmbed(interaction, locale, {
          titleKey: "commands.forget.memory.personal.no_memories_title",
          descriptionKey: "commands.forget.memory.personal.no_memories",
          color: ColorCode.WARN,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const workflowResult = await runPersonaPickerWorkflow(interaction, locale, {
        personas: allPersonas,
        color: ColorCode.INFO,
        eligibility: {
          isEligible,
          emptyTitleKey: "commands.forget.memory.personal.no_memories_title",
          emptyDescriptionKey: "commands.forget.memory.personal.no_memories",
          itemsLabelKey: "general.persona_workflow.items.personal_memories",
        },
        async onSelected(selection) {
          workflowState.message = selection.message;
          selectedPersona = selection.persona;
          workflowState.selectedPersona = selectedPersona;
          const targetLineageId = selectedPersona.persona_lineage_id ?? GLOBAL_PERSONAL_MEMORY_LINEAGE_ID;
          if (targetLineageId === GLOBAL_PERSONAL_MEMORY_LINEAGE_ID) {
            const work = await selection.beginInPlaceWork();
            await work.message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "general.errors.operation_failed_title",
                descriptionKey: "general.errors.operation_failed_description",
                footerKey: "general.pagination.reloading_persona_picker",
                color: ColorCode.ERROR,
              }),
            );
            return retryPersonaWorkflow();
          }

          let currentMemories: Awaited<ReturnType<typeof personalMemoryRepository.loadForUserLineage>> = [];
          let hasNoMemories = false;
          const selectModalResult = await selection.openModal(async () => {
            // `loadForUserLineage(..., false)` already scopes to this exact lineage
            // in SQL, so the previous in-memory re-filter was redundant. The shared
            // `lineageIdIsEligible` predicate is the single source of the same rule.
            currentMemories = userData.user_id
              ? await personalMemoryRepository.loadForUserLineage(userData.user_id, targetLineageId, false)
              : [];
            if (currentMemories.length === 0) {
              hasNoMemories = true;
              throw new Error("The selected persona has no editable personal memories.");
            }
            const memorySelectOptions: SelectOption[] = currentMemories.map((memory, index) => ({
              label: safeSelectOptionText(memory.content, 20),
              value: index.toString(),
              description: safeSelectOptionText(memory.content),
            }));
            return {
              modalCustomId: SELECT_MODAL_CUSTOM_ID,
              modalTitleKey: "commands.memory.personal.edit.select_modal_title",
              components: [
                {
                  customId: MEMORY_SELECT_ID,
                  labelKey: "commands.memory.personal.edit.select_label",
                  descriptionKey: "commands.memory.personal.edit.select_description",
                  placeholder: "commands.memory.personal.edit.select_placeholder",
                  required: true,
                  options: memorySelectOptions,
                },
              ],
            };
          });

          if (hasNoMemories) {
            await selection.message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "commands.forget.memory.personal.no_memories_title",
                descriptionKey: "commands.forget.memory.personal.no_memories",
                footerKey: "general.pagination.reloading_persona_picker",
                color: ColorCode.WARN,
              }),
            );
            return retryPersonaWorkflow(await personaRepository.loadAllForServer(serverDiscId));
          }
          if (selectModalResult.outcome !== "submitted") {
            log.info(`Personal memory edit selection modal ${selectModalResult.outcome} for user ${userData.user_id}`);
            return selectModalResult.outcome === "fatal" ? completePersonaWorkflow() : retryPersonaWorkflow();
          }

          const selectionWork = await selectModalResult.phase.beginInPlaceWork();
          const selectedIndex = Number.parseInt(selectModalResult.phase.values[MEMORY_SELECT_ID] ?? "", 10);
          const selectedMemory = currentMemories[selectedIndex];
          if (!selectedMemory) {
            await selectionWork.message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "general.errors.operation_failed_title",
                descriptionKey: "commands.forget.memory.personal.no_memories",
                footerKey: "general.pagination.reloading_persona_picker",
                color: ColorCode.ERROR,
              }),
            );
            return retryPersonaWorkflow();
          }

          const confirmId = `memory_personal_edit_confirm_${selection.phaseId}`;
          const cancelId = `memory_personal_edit_cancel_${selection.phaseId}`;
          await selectionWork.message.replace(
            buildConfirmationPayload(locale, selectedMemory.content, selection.phaseId),
          );
          const confirmationMessage = await selectionWork.message.fetchMessage();
          let confirmationButton: ButtonInteraction;
          try {
            confirmationButton = await confirmationMessage.awaitMessageComponent({
              componentType: ComponentType.Button,
              filter: (candidate) =>
                candidate.user.id === interaction.user.id &&
                (candidate.customId === confirmId || candidate.customId === cancelId),
              time: WORKFLOW_COMPONENT_TIMEOUT_MS,
            });
          } catch (_error) {
            log.info(`Personal memory edit confirmation timed out for user ${userData.user_id}`);
            await selectionWork.message.disableControls();
            return completePersonaWorkflow();
          }

          const confirmationPhase = selection.useButton(confirmationButton);
          if (confirmationButton.customId === cancelId) {
            await confirmationPhase.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "general.interaction.cancel_title",
                descriptionKey: "general.pagination.cancelled",
                footerKey: "general.pagination.reloading_persona_picker",
                color: ColorCode.WARN,
              }),
            );
            return retryPersonaWorkflow();
          }

          const editModalResult = await confirmationPhase.openModal({
            modalCustomId: EDIT_MODAL_CUSTOM_ID,
            modalTitleKey: "commands.memory.personal.edit.modal_title",
            components: [
              {
                customId: MEMORY_INPUT_ID,
                labelKey: "commands.memory.personal.edit.memory_input_label",
                descriptionKey: "commands.memory.personal.edit.memory_input_description",
                placeholder: "commands.memory.personal.edit.memory_input_placeholder",
                style: TextInputStyle.Paragraph,
                required: true,
                maxLength: memoryLimits.maxMemoryLength,
                value: selectedMemory.content,
              },
              {
                customId: MEMORY_TAGS_INPUT_ID,
                labelKey: "Memory Tags",
                descriptionKey:
                  "Up to 5 comma-separated case-sensitive keyword or #channel tags; see Memory Tagging in /help",
                placeholder: "mango,drinks,snacks",
                style: TextInputStyle.Short,
                required: false,
                maxLength: MAX_TAGS * (MAX_TAG_LENGTH + 2),
                value: (selectedMemory.tags ?? []).join(", "),
              },
            ],
          });

          if (editModalResult.outcome !== "submitted") {
            log.info(`Personal memory edit modal ${editModalResult.outcome} for user ${userData.user_id}`);
            return editModalResult.outcome === "fatal" ? completePersonaWorkflow() : retryPersonaWorkflow();
          }

          const work = await editModalResult.phase.beginInPlaceWork();
          const editedMemory = editModalResult.phase.values[MEMORY_INPUT_ID]?.trim() ?? "";
          const rawTagsInput = editModalResult.phase.values[MEMORY_TAGS_INPUT_ID]?.trim() ?? "";
          const editedTags = rawTagsInput
            ? [
                ...new Set(
                  rawTagsInput
                    .split(",")
                    .map((t) => t.trim().replace(/^["']+|["']+$/g, ""))
                    .filter((t) => t.length > 0 && t.length <= MAX_TAG_LENGTH),
                ),
              ].slice(0, MAX_TAGS)
            : [];
          const contentValidation = validateMemoryContent(editedMemory);
          if (!contentValidation.isValid) {
            await work.message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "commands.teach.memory.personal.content_too_long_title",
                descriptionKey: "commands.teach.memory.personal.content_too_long_description",
                descriptionVars: {
                  max_length: (contentValidation.maxAllowed || memoryLimits.maxMemoryLength).toString(),
                },
                footerKey: "general.pagination.reloading_persona_picker",
                color: ColorCode.ERROR,
              }),
            );
            return retryPersonaWorkflow();
          }

          const existingTags = selectedMemory.tags ?? [];
          const tagsUnchanged =
            editedTags.length === existingTags.length && editedTags.every((t, i) => t === existingTags[i]);
          if (editedMemory === selectedMemory.content.trim() && tagsUnchanged) {
            await work.message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "commands.memory.personal.edit.no_changes_title",
                descriptionKey: "commands.memory.personal.edit.no_changes_description",
                footerKey: "general.pagination.reloading_persona_picker",
                color: ColorCode.WARN,
              }),
            );
            return retryPersonaWorkflow();
          }

          const duplicateExists = currentMemories.some(
            (memory) =>
              memory.personal_memory_id !== selectedMemory.personal_memory_id &&
              memory.content.trim().toLowerCase() === editedMemory.toLowerCase(),
          );
          if (duplicateExists) {
            await work.message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "commands.memory.personal.edit.duplicate_title",
                descriptionKey: "commands.memory.personal.edit.duplicate_description",
                descriptionVars: { memory: formatMemoryPreview(editedMemory, 96) },
                footerKey: "general.pagination.reloading_persona_picker",
                color: ColorCode.WARN,
              }),
            );
            return retryPersonaWorkflow();
          }

          if (!selectedMemory.personal_memory_id) {
            log.error(`Personal memory edit row is missing personal_memory_id for user ${userData.user_disc_id}`);
            await work.message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "general.errors.update_failed_title",
                descriptionKey: "general.errors.update_failed_description",
                footerKey: "general.pagination.reloading_persona_picker",
                color: ColorCode.ERROR,
              }),
            );
            return retryPersonaWorkflow();
          }
          const ok = await personalMemoryRepository.edit(selectedMemory.personal_memory_id, editedMemory, editedTags);
          if (!ok) {
            await work.message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "general.errors.update_failed_title",
                descriptionKey: "general.errors.update_failed_description",
                footerKey: "general.pagination.reloading_persona_picker",
                color: ColorCode.ERROR,
              }),
            );
            return retryPersonaWorkflow();
          }

          invalidateUserCache(userData.user_disc_id);
          log.success(
            `Updated personal memory ${selectedMemory.personal_memory_id} for user ${userData.user_disc_id}: "${formatMemoryPreview(editedMemory, 60)}"`,
          );
          await work.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "commands.memory.personal.edit.success_title",
              descriptionKey: "commands.memory.personal.edit.success_description",
              descriptionVars: { memory: formatMemoryPreview(editedMemory, 96) },
              footerKey: personalizationDisabledWarning
                ? "commands.forget.memory.personal.warning_disabled_description"
                : "general.pagination.reloading_persona_picker",
              color: ColorCode.SUCCESS,
            }),
          );
          return retryPersonaWorkflow(await personaRepository.loadAllForServer(serverDiscId));
        },
      });
      if (workflowResult.outcome === "error" && workflowState.message) {
        await workflowState.message.replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "general.errors.unknown_error_title",
            descriptionKey: "general.errors.unknown_error_description",
            color: ColorCode.ERROR,
          }),
        );
      }
      return;
    }

    const userIsBlacklisted = interaction.guild
      ? ((await userRepository.isBlacklisted(interaction.guild.id, interaction.user.id)) ?? false)
      : false;

    const globalMemories = userData.user_id
      ? await personalMemoryRepository.loadForUserLineage(userData.user_id, GLOBAL_PERSONAL_MEMORY_LINEAGE_ID, false)
      : [];

    if (globalMemories.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.forget.memory.personal.no_memories_title",
        descriptionKey: "commands.forget.memory.personal.no_memories",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const memorySelectOptions: SelectOption[] = globalMemories.map((memory, index) => ({
      label: safeSelectOptionText(memory.content, 20),
      value: index.toString(),
      description: safeSelectOptionText(memory.content),
    }));

    const selectModalResult = await promptWithPaginatedModal(interaction, locale, {
      modalCustomId: SELECT_MODAL_CUSTOM_ID,
      modalTitleKey: "commands.memory.personal.edit.select_modal_title",
      components: [
        {
          customId: MEMORY_SELECT_ID,
          labelKey: "commands.memory.personal.edit.select_label",
          descriptionKey: "commands.memory.personal.edit.select_description",
          placeholder: "commands.memory.personal.edit.select_placeholder",
          required: true,
          options: memorySelectOptions,
        },
      ],
    });

    if (selectModalResult.outcome !== "submit") {
      log.info(`Global personal memory edit selection modal ${selectModalResult.outcome} for user ${userData.user_id}`);
      return;
    }

    const selectModalInteraction = selectModalResult.interaction;
    const selectedIndex = selectModalResult.values?.[MEMORY_SELECT_ID];
    if (!selectModalInteraction || !selectedIndex) {
      log.error("Global personal memory edit selection unexpectedly missing interaction or values");
      return;
    }

    const selectedMemory = globalMemories[Number.parseInt(selectedIndex, 10)];
    if (!selectedMemory) {
      await replyInfoEmbed(selectModalInteraction, locale, {
        titleKey: "general.errors.operation_failed_title",
        descriptionKey: "commands.forget.memory.personal.no_memories",
        color: ColorCode.ERROR,
      });
      return;
    }

    const confirmationResult = await promptWithUnacknowledgedConfirmation(selectModalInteraction, locale, {
      embedTitleKey: "commands.memory.personal.edit.confirm_title",
      embedDescriptionKey: "commands.memory.personal.edit.confirm_description",
      embedDescriptionVars: {
        memory: selectedMemory.content,
      },
      embedColor: ColorCode.INFO,
      continueLabelKey: "general.confirm",
      cancelLabelKey: "general.pagination.cancel",
      continueCustomId: `memory_personal_edit_confirm_${selectModalInteraction.id}`,
      cancelCustomId: `memory_personal_edit_cancel_${selectModalInteraction.id}`,
    });

    if (confirmationResult.outcome !== "continue" || !confirmationResult.interaction) {
      return;
    }

    const editModalResult = await promptWithRawModal(confirmationResult.interaction, locale, {
      modalCustomId: EDIT_MODAL_CUSTOM_ID,
      modalTitleKey: "commands.memory.personal.edit.modal_title",
      components: [
        {
          customId: MEMORY_INPUT_ID,
          labelKey: "commands.memory.personal.edit.memory_input_label",
          descriptionKey: "commands.memory.personal.edit.memory_input_description",
          placeholder: "commands.memory.personal.edit.memory_input_placeholder",
          style: TextInputStyle.Paragraph,
          required: true,
          maxLength: memoryLimits.maxMemoryLength,
          value: selectedMemory.content,
        },
        {
          customId: MEMORY_TAGS_INPUT_ID,
          labelKey: "Memory Tags",
          descriptionKey:
            "Up to 5 comma-separated case-sensitive keyword or #channel tags; see Memory Tagging in /help",
          placeholder: "mango,drinks,snacks",
          style: TextInputStyle.Short,
          required: false,
          maxLength: MAX_TAGS * (MAX_TAG_LENGTH + 2),
          value: (selectedMemory.tags ?? []).join(", "),
        },
      ],
    });

    if (editModalResult.outcome !== "submit") {
      log.info(`Global personal memory edit modal ${editModalResult.outcome} for user ${userData.user_id}`);
      return;
    }

    const editModalInteraction = editModalResult.interaction;
    const editedMemory = editModalResult.values?.[MEMORY_INPUT_ID]?.trim() ?? "";
    const rawTagsInput = editModalResult.values?.[MEMORY_TAGS_INPUT_ID]?.trim() ?? "";
    const editedTags = rawTagsInput
      ? [
          ...new Set(
            rawTagsInput
              .split(",")
              .map((t) => t.trim())
              .filter((t) => t.length > 0 && t.length <= MAX_TAG_LENGTH),
          ),
        ].slice(0, MAX_TAGS)
      : [];
    if (!editModalInteraction) {
      log.error("Global personal memory edit modal unexpectedly missing interaction");
      return;
    }

    const contentValidation = validateMemoryContent(editedMemory);
    if (!contentValidation.isValid) {
      await replyInfoEmbed(editModalInteraction, locale, {
        titleKey: "commands.teach.memory.personal.content_too_long_title",
        descriptionKey: "commands.teach.memory.personal.content_too_long_description",
        descriptionVars: {
          max_length: (contentValidation.maxAllowed || memoryLimits.maxMemoryLength).toString(),
        },
        color: ColorCode.ERROR,
      });
      return;
    }

    const globalExistingTags = selectedMemory.tags ?? [];
    const globalTagsUnchanged =
      editedTags.length === globalExistingTags.length && editedTags.every((t, i) => t === globalExistingTags[i]);
    if (editedMemory === selectedMemory.content.trim() && globalTagsUnchanged) {
      await replyInfoEmbed(editModalInteraction, locale, {
        titleKey: "commands.memory.personal.edit.no_changes_title",
        descriptionKey: "commands.memory.personal.edit.no_changes_description",
        color: ColorCode.WARN,
      });
      return;
    }

    const duplicateExists = globalMemories.some(
      (memory) =>
        memory.personal_memory_id !== selectedMemory.personal_memory_id &&
        memory.content.trim().toLowerCase() === editedMemory.toLowerCase(),
    );
    if (duplicateExists) {
      await replyInfoEmbed(editModalInteraction, locale, {
        titleKey: "commands.memory.personal.edit.duplicate_title",
        descriptionKey: "commands.memory.personal.edit.duplicate_description",
        descriptionVars: {
          memory: formatMemoryPreview(editedMemory, 96),
        },
        color: ColorCode.WARN,
      });
      return;
    }

    const editSucceeded = await performPersonalMemoryEdit(
      selectedMemory,
      editedMemory,
      editedTags,
      userData,
      editModalInteraction,
      locale,
      true,
    );
    if (!editSucceeded) {
      return;
    }

    // deferUpdate on the edit modal submit targets the button's message (the confirmation),
    // so editReply in replyInfoEmbed will update that same ephemeral message in-place.
    await acknowledgeModalSubmitForRefresh(editModalInteraction);
    await replyInfoEmbed(editModalInteraction, locale, {
      titleKey: "commands.memory.personal.edit.success_title",
      descriptionKey: "commands.memory.personal.edit.success_description",
      descriptionVars: {
        memory: formatMemoryPreview(editedMemory, 96),
      },
      color: ColorCode.SUCCESS,
    });

    if (personalizationDisabledWarning) {
      await editModalInteraction.followUp({
        embeds: [
          createStandardEmbed(locale, {
            titleKey: "commands.forget.memory.personal.warning_disabled_title",
            descriptionKey: "commands.forget.memory.personal.warning_disabled_description",
            color: ColorCode.WARN,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (userIsBlacklisted) {
      log.info(
        `User ${interaction.user.id} edited a global personal memory while blacklisted in server ${interaction.guild?.id ?? "dm"}`,
      );
    }
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: tomoriState?.server_id,
      personaId: workflowState.selectedPersona?.persona_id ?? tomoriState?.persona_id,
      errorType: "CommandExecutionError",
      metadata: {
        command: "memory personal edit",
        guildId: interaction.guild?.id,
        executorDiscordId: interaction.user.id,
      },
    };
    await log.error(
      `Unexpected error in /memory personal edit for user ${userData.user_disc_id}`,
      error as Error,
      context,
    );

    if (workflowState.message) {
      await workflowState.message.replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "general.errors.unknown_error_title",
          descriptionKey: "general.errors.unknown_error_description",
          color: ColorCode.ERROR,
        }),
      );
      return;
    }
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
  }
}
