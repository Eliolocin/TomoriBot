import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  TextInputStyle,
  type ActionRowData,
  type ButtonComponentData,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type ComponentInContainerData,
  type ContainerComponentData,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import type { ErrorContext, TomoriState, UserRow } from "@/types/db/schema";
import type { SelectOption } from "@/types/discord/modal";
import { getCachedTomoriState, invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { personaRepository, userRepository } from "@/utils/db/repositories";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { hasAttributes } from "@/utils/discord/ui/personaEligibility";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import {
  buildPersonaWorkflowNotice,
  completePersonaWorkflow,
  PERSONA_WORKFLOW_COMPONENT_TIMEOUT_MS as WORKFLOW_COMPONENT_TIMEOUT_MS,
  retryPersonaWorkflow,
  runPersonaPickerWorkflow,
  type PersonaWorkflowComponentsV2Payload,
  type PersonaWorkflowMessageController,
} from "@/utils/discord/ui/personaWorkflow";
import { ColorCode, log } from "@/utils/misc/logger";
import { getMemoryLimits, validateAttribute } from "@/utils/misc/memoryLimits";
import { combineModalPromptParts, splitPromptIntoModalParts } from "@/utils/text/modalPromptParts";
import { localizer } from "@/utils/text/localizer";

const SELECT_MODAL_CUSTOM_ID = "persona_attribute_edit_select_modal";
const EDIT_MODAL_CUSTOM_ID = "persona_attribute_edit_value_modal";
const ATTRIBUTE_SELECT_ID = "attribute_select";
const ATTRIBUTE_PART1_ID = "attribute_part1";
const ATTRIBUTE_PART2_ID = "attribute_part2";
const ATTRIBUTE_PUBLIC_ID = "attribute_public";
const ATTRIBUTE_PART_MAX_LENGTH = 4000;
const memoryLimits = getMemoryLimits();

function formatAttributePreview(attribute: string, maxLength = 120): string {
  return attribute.length > maxLength ? `${attribute.slice(0, maxLength)}...` : attribute;
}

function buildConfirmationPayload(
  locale: string,
  description: string,
  continueCustomId: string,
  cancelCustomId: string,
): PersonaWorkflowComponentsV2Payload {
  const actionRow: ActionRowData<ButtonComponentData> = {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: continueCustomId,
        label: localizer(locale, "general.confirm"),
      },
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: cancelCustomId,
        label: localizer(locale, "general.pagination.cancel"),
      },
    ],
  };
  const container: ContainerComponentData<ComponentInContainerData> = {
    type: ComponentType.Container,
    accentColor: Number.parseInt(ColorCode.INFO.replace("#", ""), 16),
    components: [
      {
        type: ComponentType.TextDisplay,
        content: `### ${localizer(locale, "commands.persona.attribute.edit.confirm_title")}`,
      },
      { type: ComponentType.TextDisplay, content: description },
      actionRow,
    ],
  };
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("edit").setDescription(localizer("en-US", "commands.persona.attribute.edit.description"));

/** Edits an existing attribute on a selected persona. */
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

  const serverDiscId = interaction.guild?.id ?? interaction.user.id;
  const workflowState: {
    selectedPersona: TomoriState | null;
    message: PersonaWorkflowMessageController | null;
  } = { selectedPersona: null, message: null };
  let tomoriState: TomoriState | null = null;

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

    // Pre-picker eligibility guard shared with the workflow filter and the
    // post-selection backstop below (all via `hasAttributes`).
    const eligiblePersonas = allPersonas.filter(hasAttributes);
    if (eligiblePersonas.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.forget.attribute.no_attributes_title",
        descriptionKey: "commands.forget.attribute.no_attributes",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await runPersonaPickerWorkflow(interaction, locale, {
      personas: allPersonas,
      color: ColorCode.INFO,
      eligibility: {
        isEligible: hasAttributes,
        emptyTitleKey: "commands.forget.attribute.no_attributes_title",
        emptyDescriptionKey: "commands.forget.attribute.no_attributes",
        itemsLabelKey: "general.persona_workflow.items.attributes",
      },
      onSelected: async (selection) => {
        workflowState.selectedPersona = selection.persona;
        workflowState.message = selection.message;
        const personaId = selection.persona.persona_id;
        if (!personaId) {
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

        if (!tomoriState?.config.attribute_memteaching_enabled && !hasManagePermission) {
          const work = await selection.beginInPlaceWork();
          await work.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "commands.teach.attribute.teaching_disabled_title",
              descriptionKey: "commands.teach.attribute.teaching_disabled_description",
              color: ColorCode.ERROR,
            }),
          );
          return completePersonaWorkflow();
        }

        // Concurrency backstop reusing the shared predicate (never diverges from
        // the picker filter).
        const currentAttributes = selection.persona.attribute_list ?? [];
        if (!hasAttributes(selection.persona)) {
          const work = await selection.beginInPlaceWork();
          await work.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "commands.forget.attribute.no_attributes_title",
              descriptionKey: "commands.forget.attribute.no_attributes",
              footerKey: "general.pagination.reloading_persona_picker",
              color: ColorCode.WARN,
            }),
          );
          return retryPersonaWorkflow();
        }

        const selectOptions: SelectOption[] = currentAttributes.map((attribute, index) => ({
          label: safeSelectOptionText(attribute),
          value: index.toString(),
        }));
        const selectModalResult = await selection.openModal({
          modalCustomId: SELECT_MODAL_CUSTOM_ID,
          modalTitleKey: "commands.persona.attribute.edit.select_modal_title",
          components: [
            {
              customId: ATTRIBUTE_SELECT_ID,
              labelKey: "commands.persona.attribute.edit.select_label",
              descriptionKey: "commands.persona.attribute.edit.select_description",
              placeholder: "commands.persona.attribute.edit.select_placeholder",
              required: true,
              options: selectOptions,
            },
          ],
        });
        if (selectModalResult.outcome !== "submitted") {
          log.info(`Attribute edit selection modal ${selectModalResult.outcome} for user ${userData.user_id}`);
          return selectModalResult.outcome === "fatal" ? completePersonaWorkflow() : retryPersonaWorkflow();
        }

        const selectWork = await selectModalResult.phase.beginInPlaceWork();
        const selectedIndex = Number.parseInt(selectModalResult.phase.values[ATTRIBUTE_SELECT_ID] ?? "", 10);
        const selectedAttribute = currentAttributes[selectedIndex];
        if (!Number.isInteger(selectedIndex) || selectedAttribute === undefined) {
          await selectWork.message.replace(
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
        const selectedAttributeIsPublic =
          selection.persona.persona_attributes?.find((attribute) => attribute.attribute_order === selectedIndex + 1)
            ?.is_public ?? false;

        const continueCustomId = `persona_attribute_edit_confirm_${selection.phaseId}`;
        const cancelCustomId = `persona_attribute_edit_cancel_${selection.phaseId}`;
        const confirmationDescription = localizer(locale, "commands.persona.attribute.edit.confirm_description", {
          attribute: formatAttributePreview(selectedAttribute, 3000)
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n"),
        });
        await selectWork.message.replace(
          buildConfirmationPayload(locale, confirmationDescription, continueCustomId, cancelCustomId),
        );

        let confirmationButton: ButtonInteraction;
        try {
          const message = await selectWork.message.fetchMessage();
          confirmationButton = await message.awaitMessageComponent({
            componentType: ComponentType.Button,
            filter: (candidate) =>
              candidate.user.id === interaction.user.id &&
              (candidate.customId === continueCustomId || candidate.customId === cancelCustomId),
            time: WORKFLOW_COMPONENT_TIMEOUT_MS,
          });
        } catch {
          await selectWork.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "general.interaction.timeout_title",
              descriptionKey: "general.pagination.timeout",
              footerKey: "general.pagination.reloading_persona_picker",
              color: ColorCode.WARN,
            }),
          );
          return retryPersonaWorkflow();
        }

        const confirmationPhase = selection.useButton(confirmationButton);
        if (confirmationButton.customId === cancelCustomId) {
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

        const attributeParts = splitPromptIntoModalParts(selectedAttribute, 2, ATTRIBUTE_PART_MAX_LENGTH);
        const editModalResult = await confirmationPhase.openModal({
          modalCustomId: EDIT_MODAL_CUSTOM_ID,
          modalTitleKey: "commands.persona.attribute.edit.modal_title",
          components: [
            {
              customId: ATTRIBUTE_PART1_ID,
              labelKey: "commands.persona.attribute.edit.attribute_input_label",
              descriptionKey: "commands.persona.attribute.edit.attribute_input_description",
              placeholder: "commands.persona.attribute.edit.attribute_input_placeholder",
              style: TextInputStyle.Paragraph,
              required: true,
              maxLength: ATTRIBUTE_PART_MAX_LENGTH,
              value: attributeParts[0] || undefined,
            },
            {
              customId: ATTRIBUTE_PART2_ID,
              labelKey: "commands.persona.attribute.edit.attribute_input_part2_label",
              style: TextInputStyle.Paragraph,
              required: false,
              maxLength: ATTRIBUTE_PART_MAX_LENGTH,
              value: attributeParts[1] || undefined,
            },
            {
              kind: "checkbox",
              customId: ATTRIBUTE_PUBLIC_ID,
              labelKey: "commands.persona.attribute.edit.public_checkbox_label",
              descriptionKey: "commands.persona.attribute.edit.public_checkbox_description",
              default: selectedAttributeIsPublic,
            },
          ],
        });
        if (editModalResult.outcome !== "submitted") {
          log.info(`Attribute edit modal ${editModalResult.outcome} for user ${userData.user_id}`);
          return editModalResult.outcome === "fatal" ? completePersonaWorkflow() : retryPersonaWorkflow();
        }

        const editWork = await editModalResult.phase.beginInPlaceWork();
        const editedAttribute = combineModalPromptParts(
          [
            editModalResult.phase.values[ATTRIBUTE_PART1_ID]?.trim() ?? "",
            editModalResult.phase.values[ATTRIBUTE_PART2_ID]?.trim() ?? "",
          ],
          ATTRIBUTE_PART_MAX_LENGTH,
        );
        const editedIsPublic = editModalResult.phase.values[ATTRIBUTE_PUBLIC_ID] === "true";
        const validation = validateAttribute(editedAttribute);
        if (!validation.isValid) {
          await editWork.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "commands.teach.attribute.content_too_long_title",
              descriptionKey: "commands.teach.attribute.content_too_long_description",
              descriptionVars: {
                current_length: editedAttribute.length.toString(),
                max_allowed: (validation.maxAllowed || memoryLimits.maxAttributeLength).toString(),
              },
              footerKey: "general.pagination.reloading_persona_picker",
              color: ColorCode.ERROR,
            }),
          );
          return retryPersonaWorkflow();
        }

        if (editedAttribute === selectedAttribute.trim() && editedIsPublic === selectedAttributeIsPublic) {
          await editWork.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "commands.persona.attribute.edit.no_changes_title",
              descriptionKey: "commands.persona.attribute.edit.no_changes_description",
              footerKey: "general.pagination.reloading_persona_picker",
              color: ColorCode.WARN,
            }),
          );
          return retryPersonaWorkflow();
        }

        const duplicateExists = currentAttributes.some(
          (attribute, index) =>
            index !== selectedIndex && attribute.trim().toLowerCase() === editedAttribute.toLowerCase(),
        );
        if (duplicateExists) {
          await editWork.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "commands.persona.attribute.edit.duplicate_title",
              descriptionKey: "commands.persona.attribute.edit.duplicate_description",
              descriptionVars: { attribute: formatAttributePreview(editedAttribute, 96) },
              footerKey: "general.pagination.reloading_persona_picker",
              color: ColorCode.WARN,
            }),
          );
          return retryPersonaWorkflow();
        }

        const updated = await personaRepository.editAttributeAt(
          personaId,
          selectedIndex + 1,
          editedAttribute,
          editedIsPublic,
        );
        if (!updated) {
          const context: ErrorContext = {
            userId: userData.user_id,
            serverId: selection.persona.server_id,
            personaId,
            errorType: "DatabaseUpdateError",
            metadata: { command: "persona attribute edit", selectedIndex },
          };
          await log.error(
            "Failed to update persona attribute list",
            new Error("Database update returned no rows"),
            context,
          );
          await editWork.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "general.errors.update_failed_title",
              descriptionKey: "general.errors.update_failed_description",
              color: ColorCode.ERROR,
            }),
          );
          return completePersonaWorkflow();
        }

        invalidateTomoriStateCache(serverDiscId);
        log.success(
          `Updated attribute ${selectedIndex} for tomori ${personaId} by ${userData.user_disc_id}: "${formatAttributePreview(editedAttribute, 60)}"`,
        );
        await editWork.message.replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "commands.persona.attribute.edit.success_title",
            descriptionKey: "commands.persona.attribute.edit.success_description",
            descriptionVars: {
              attribute: formatAttributePreview(editedAttribute, 96),
              visibility: localizer(
                locale,
                editedIsPublic
                  ? "commands.teach.attribute.visibility_public"
                  : "commands.teach.attribute.visibility_private",
              ),
            },
            footerKey: "general.pagination.reloading_persona_picker",
            color: ColorCode.SUCCESS,
          }),
        );
        const refreshedPersonas = await personaRepository.loadAllForServer(serverDiscId);
        return retryPersonaWorkflow(refreshedPersonas);
      },
    });
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: tomoriState?.server_id,
      personaId: workflowState.selectedPersona?.persona_id ?? tomoriState?.persona_id,
      errorType: "CommandExecutionError",
      metadata: {
        command: "persona attribute edit",
        guildId: interaction.guild?.id,
        executorDiscordId: interaction.user.id,
      },
    };
    await log.error(
      `Unexpected error in /persona attribute edit for user ${userData.user_disc_id}`,
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
