import type {
  ActionRowData,
  ButtonComponentData,
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  ComponentInContainerData,
  ContainerComponentData,
  SlashCommandSubcommandBuilder,
} from "discord.js";
import { ButtonStyle, ComponentType, MessageFlags, TextInputStyle } from "discord.js";
import { localizer } from "@/utils/text/localizer";
import { log, ColorCode } from "@/utils/misc/logger";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
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
import { getCachedTomoriState, invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { personaRepository, userRepository } from "@/utils/db/repositories";
import { getMemoryLimits, validateMemoryContent } from "@/utils/misc/memoryLimits";
import { serverMemoryRepository } from "@/utils/db/repositories";
import type { SelectOption } from "@/types/discord/modal";
import type { ErrorContext, TomoriState, UserRow } from "@/types/db/schema";

const SELECT_MODAL_CUSTOM_ID = "memory_server_edit_select_modal";
const EDIT_MODAL_CUSTOM_ID = "memory_server_edit_value_modal";
const MEMORY_SELECT_ID = "memory_select";
const MEMORY_INPUT_ID = "server_memory_input";
const MEMORY_TAGS_INPUT_ID = "server_memory_tags_input";

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
        customId: `memory_server_edit_confirm_${phaseId}`,
        label: localizer(locale, "general.confirm"),
      },
      {
        type: ComponentType.Button,
        style: ButtonStyle.Danger,
        customId: `memory_server_edit_cancel_${phaseId}`,
        label: localizer(locale, "general.pagination.cancel"),
      },
    ],
  };
  const components: ComponentInContainerData[] = [
    {
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "commands.memory.server.edit.confirm_title")}`,
    },
    {
      type: ComponentType.TextDisplay,
      content: localizer(locale, "commands.memory.server.edit.confirm_description", { memory }).slice(
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

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("edit").setDescription(localizer("en-US", "commands.memory.server.edit.description"));

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
  const serverDiscId = interaction.guild?.id ?? interaction.user.id;

  try {
    const hasManagePermission = interaction.memberPermissions?.has("ManageGuild") ?? false;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (interaction.guild) {
      const blacklisted = (await userRepository.isBlacklisted(interaction.guild.id, interaction.user.id)) ?? false;
      if (blacklisted && !hasManagePermission) {
        await replyInfoEmbed(interaction, locale, {
          titleKey: "general.errors.user_blacklisted_title",
          descriptionKey: "general.errors.user_blacklisted_description",
          color: ColorCode.ERROR,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    tomoriState = await getCachedTomoriState(serverDiscId);
    if (!tomoriState) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const activeTomoriState = tomoriState;
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

    // Class B, permission-dependent eligibility. Editing does not delete a
    // memory, so the eligible set stays static (no in-place refresh required).
    const memoryUserScope = hasManagePermission ? undefined : userData.user_id;
    const eligibleServerMemoryLineageIds = await serverMemoryRepository.lineageIdsWithServerMemories(
      activeTomoriState.server_id,
      memoryUserScope,
    );
    const isEligible = lineageIdIsEligible(eligibleServerMemoryLineageIds);
    const emptyMemoriesDescriptionKey = hasManagePermission
      ? "commands.forget.memory.server.no_memories"
      : "commands.forget.memory.server.no_owned_memories";
    const eligiblePersonas = allPersonas.filter(isEligible);
    if (eligiblePersonas.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.forget.memory.server.no_memories_title",
        descriptionKey: emptyMemoriesDescriptionKey,
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
        emptyTitleKey: "commands.forget.memory.server.no_memories_title",
        emptyDescriptionKey: emptyMemoriesDescriptionKey,
        itemsLabelKey: "general.persona_workflow.items.server_memories",
      },
      async onSelected(selection) {
        workflowState.message = selection.message;
        selectedPersona = selection.persona;
        workflowState.selectedPersona = selectedPersona;
        if (!selectedPersona.persona_id) {
          const work = await selection.beginInPlaceWork();
          await work.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "general.errors.invalid_option_title",
              descriptionKey: "general.errors.invalid_option_description",
              footerKey: "general.pagination.reloading_persona_picker",
              color: ColorCode.ERROR,
            }),
          );
          return retryPersonaWorkflow();
        }

        if (!activeTomoriState.config.server_memteaching_enabled && !hasManagePermission) {
          const work = await selection.beginInPlaceWork();
          await work.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "commands.teach.memory.server.teaching_disabled_title",
              descriptionKey: "commands.teach.memory.server.teaching_disabled_description",
              footerKey: "general.pagination.reloading_persona_picker",
              color: ColorCode.ERROR,
            }),
          );
          return retryPersonaWorkflow();
        }

        let memories: Awaited<ReturnType<typeof serverMemoryRepository.loadServerMemoriesScoped>> = [];
        let hasNoMemories = false;
        const selectModalResult = await selection.openModal(async () => {
          memories = await serverMemoryRepository.loadServerMemoriesScoped(
            activeTomoriState.server_id,
            selectedPersona?.persona_lineage_id ?? 0,
            hasManagePermission ? undefined : userData.user_id,
          );
          if (memories.length === 0) {
            hasNoMemories = true;
            throw new Error("The selected persona has no editable server memories.");
          }
          const memorySelectOptions: SelectOption[] = memories.map((memory, index) => ({
            label: safeSelectOptionText(memory.content, 20),
            value: index.toString(),
            description: safeSelectOptionText(memory.content),
          }));
          return {
            modalCustomId: SELECT_MODAL_CUSTOM_ID,
            modalTitleKey: "commands.memory.server.edit.select_modal_title",
            components: [
              {
                customId: MEMORY_SELECT_ID,
                labelKey: "commands.memory.server.edit.select_label",
                descriptionKey: "commands.memory.server.edit.select_description",
                placeholder: "commands.memory.server.edit.select_placeholder",
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
              titleKey: "commands.forget.memory.server.no_memories_title",
              descriptionKey: hasManagePermission
                ? "commands.forget.memory.server.no_memories"
                : "commands.forget.memory.server.no_owned_memories",
              footerKey: "general.pagination.reloading_persona_picker",
              color: ColorCode.WARN,
            }),
          );
          return retryPersonaWorkflow(await personaRepository.loadAllForServer(serverDiscId));
        }
        if (selectModalResult.outcome !== "submitted") {
          log.info(`Server memory edit selection modal ${selectModalResult.outcome} for user ${userData.user_id}`);
          return selectModalResult.outcome === "fatal" ? completePersonaWorkflow() : retryPersonaWorkflow();
        }

        const selectionWork = await selectModalResult.phase.beginInPlaceWork();
        const selectedIndex = Number.parseInt(selectModalResult.phase.values[MEMORY_SELECT_ID] ?? "", 10);
        const selectedMemory = memories[selectedIndex];
        if (!selectedMemory) {
          await selectionWork.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "general.errors.operation_failed_title",
              descriptionKey: "commands.forget.memory.server.memory_not_found",
              footerKey: "general.pagination.reloading_persona_picker",
              color: ColorCode.ERROR,
            }),
          );
          return retryPersonaWorkflow();
        }

        const confirmId = `memory_server_edit_confirm_${selection.phaseId}`;
        const cancelId = `memory_server_edit_cancel_${selection.phaseId}`;
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
          log.info(`Server memory edit confirmation timed out for user ${userData.user_id}`);
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
          modalTitleKey: "commands.memory.server.edit.modal_title",
          components: [
            {
              customId: MEMORY_INPUT_ID,
              labelKey: "commands.memory.server.edit.memory_input_label",
              descriptionKey: "commands.memory.server.edit.memory_input_description",
              placeholder: "commands.memory.server.edit.memory_input_placeholder",
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
          log.info(`Server memory edit modal ${editModalResult.outcome} for user ${userData.user_id}`);
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
              titleKey: "commands.teach.memory.server.content_too_long_title",
              descriptionKey: "commands.teach.memory.server.content_too_long_description",
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
              titleKey: "commands.memory.server.edit.no_changes_title",
              descriptionKey: "commands.memory.server.edit.no_changes_description",
              footerKey: "general.pagination.reloading_persona_picker",
              color: ColorCode.WARN,
            }),
          );
          return retryPersonaWorkflow();
        }

        const duplicateExists = memories.some(
          (memory) =>
            memory.server_memory_id !== selectedMemory.server_memory_id &&
            memory.content.trim().toLowerCase() === editedMemory.toLowerCase(),
        );
        if (duplicateExists) {
          await work.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "commands.memory.server.edit.duplicate_title",
              descriptionKey: "commands.memory.server.edit.duplicate_description",
              descriptionVars: { memory: formatMemoryPreview(editedMemory, 96) },
              footerKey: "general.pagination.reloading_persona_picker",
              color: ColorCode.WARN,
            }),
          );
          return retryPersonaWorkflow();
        }

        if (!hasManagePermission && selectedMemory.user_id !== userData.user_id) {
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
        if (!selectedMemory.server_memory_id) {
          log.error("Server memory edit row is missing server_memory_id");
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

        const ok = await serverMemoryRepository.edit(selectedMemory.server_memory_id, editedMemory, editedTags);
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

        invalidateTomoriStateCache(serverDiscId);
        log.success(
          `Updated server memory ${selectedMemory.server_memory_id} in server ${selectedPersona.server_id} by ${userData.user_disc_id}: "${formatMemoryPreview(editedMemory, 60)}"`,
        );
        await work.message.replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "commands.memory.server.edit.success_title",
            descriptionKey: "commands.memory.server.edit.success_description",
            descriptionVars: { memory: formatMemoryPreview(editedMemory, 96) },
            footerKey: "general.pagination.reloading_persona_picker",
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
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: tomoriState?.server_id,
      personaId: workflowState.selectedPersona?.persona_id ?? tomoriState?.persona_id,
      errorType: "CommandExecutionError",
      metadata: {
        command: "memory server edit",
        guildId: interaction.guild?.id,
        executorDiscordId: interaction.user.id,
      },
    };
    await log.error(
      `Unexpected error in /memory server edit for user ${userData.user_disc_id}`,
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
