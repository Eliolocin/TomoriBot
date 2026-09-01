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
import { hasSampleDialogues } from "@/utils/discord/ui/personaEligibility";
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
import { getMemoryLimits, validateSampleDialogue } from "@/utils/misc/memoryLimits";
import { combineModalPromptParts, splitPromptIntoModalParts } from "@/utils/text/modalPromptParts";
import { localizer } from "@/utils/text/localizer";

const SELECT_MODAL_CUSTOM_ID = "persona_sampledialogue_edit_select_modal";
const EDIT_MODAL_CUSTOM_ID = "persona_sampledialogue_edit_value_modal";
const DIALOGUE_SELECT_ID = "dialogue_select";
const USER_INPUT_PART1_ID = "user_input_part1";
const USER_INPUT_PART2_ID = "user_input_part2";
const BOT_INPUT_PART1_ID = "bot_input_part1";
const BOT_INPUT_PART2_ID = "bot_input_part2";
const DIALOGUE_PART_MAX_LENGTH = 4000;
const memoryLimits = getMemoryLimits();

function formatDialoguePreview(text: string, maxLength = 96): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function makeDialogueKey(userInput: string, botInput: string): string {
  return `${userInput.trim().toLowerCase()}|||${botInput.trim().toLowerCase()}`;
}

async function repairMismatchedDialogues(
  personaId: number,
  inLength: number,
  outLength: number,
  serverDiscId: string,
): Promise<{ repairedIn: string[]; repairedOut: string[] } | null> {
  const safeLength = Math.min(inLength, outLength);
  log.warn(
    `Self-healing: truncating sample dialogues for tomori ${personaId} from (in: ${inLength}, out: ${outLength}) to ${safeLength} pairs`,
  );
  const repaired = await personaRepository.repairSampleDialogues(personaId, safeLength);
  if (!repaired) {
    log.error(`Self-healing failed: no rows returned for tomori ${personaId}`);
    return null;
  }
  invalidateTomoriStateCache(serverDiscId);
  log.success(`Self-healing complete: sample dialogues for tomori ${personaId} repaired to ${safeLength} pairs`);
  return repaired;
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
        content: `### ${localizer(locale, "commands.persona.sample-dialogue.edit.confirm_title")}`,
      },
      { type: ComponentType.TextDisplay, content: description },
      actionRow,
    ],
  };
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("edit").setDescription(localizer("en-US", "commands.persona.sample-dialogue.edit.description"));

/** Edits an existing sample-dialogue pair on a selected persona. */
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
    // post-selection backstop below (all via `hasSampleDialogues`).
    const eligiblePersonas = allPersonas.filter(hasSampleDialogues);
    if (eligiblePersonas.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.forget.sampledialogue.no_dialogues_title",
        descriptionKey: "commands.forget.sampledialogue.no_dialogues",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await runPersonaPickerWorkflow(interaction, locale, {
      personas: allPersonas,
      color: ColorCode.INFO,
      eligibility: {
        isEligible: hasSampleDialogues,
        emptyTitleKey: "commands.forget.sampledialogue.no_dialogues_title",
        emptyDescriptionKey: "commands.forget.sampledialogue.no_dialogues",
        itemsLabelKey: "general.persona_workflow.items.sample_dialogues",
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

        if (!tomoriState?.config.sampledialogue_memteaching_enabled && !hasManagePermission) {
          const work = await selection.beginInPlaceWork();
          await work.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "commands.teach.sampledialogue.teaching_disabled_title",
              descriptionKey: "commands.teach.sampledialogue.teaching_disabled_description",
              color: ColorCode.ERROR,
            }),
          );
          return completePersonaWorkflow();
        }

        // Concurrency backstop reusing the shared predicate.
        let currentIn = [...(selection.persona.sample_dialogues_in ?? [])];
        let currentOut = [...(selection.persona.sample_dialogues_out ?? [])];
        if (!hasSampleDialogues(selection.persona)) {
          const work = await selection.beginInPlaceWork();
          await work.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "commands.forget.sampledialogue.no_dialogues_title",
              descriptionKey: "commands.forget.sampledialogue.no_dialogues",
              footerKey: "general.pagination.reloading_persona_picker",
              color: ColorCode.WARN,
            }),
          );
          return retryPersonaWorkflow();
        }

        const selectModalResult = await selection.openModal(async () => {
          if (currentIn.length !== currentOut.length) {
            const repaired = await repairMismatchedDialogues(
              personaId,
              currentIn.length,
              currentOut.length,
              serverDiscId,
            );
            if (!repaired) throw new Error("Failed to repair mismatched sample dialogues");
            currentIn = repaired.repairedIn;
            currentOut = repaired.repairedOut;
            selection.persona.sample_dialogues_in = repaired.repairedIn;
            selection.persona.sample_dialogues_out = repaired.repairedOut;
          }
          const options: SelectOption[] = currentIn.map((input, index) => ({
            label: safeSelectOptionText(input, 50),
            value: index.toString(),
            description: safeSelectOptionText(currentOut[index] ?? "", 50),
          }));
          return {
            modalCustomId: SELECT_MODAL_CUSTOM_ID,
            modalTitleKey: "commands.persona.sample-dialogue.edit.select_modal_title",
            components: [
              {
                customId: DIALOGUE_SELECT_ID,
                labelKey: "commands.persona.sample-dialogue.edit.select_label",
                descriptionKey: "commands.persona.sample-dialogue.edit.select_description",
                placeholder: "commands.persona.sample-dialogue.edit.select_placeholder",
                required: true,
                options,
              },
            ],
          };
        });
        if (selectModalResult.outcome !== "submitted") {
          log.info(`Sample dialogue edit selection modal ${selectModalResult.outcome} for user ${userData.user_id}`);
          return selectModalResult.outcome === "fatal" ? completePersonaWorkflow() : retryPersonaWorkflow();
        }

        const selectWork = await selectModalResult.phase.beginInPlaceWork();
        const selectedIndex = Number.parseInt(selectModalResult.phase.values[DIALOGUE_SELECT_ID] ?? "", 10);
        const selectedUserInput = currentIn[selectedIndex];
        const selectedBotInput = currentOut[selectedIndex];
        if (!Number.isInteger(selectedIndex) || selectedUserInput === undefined || selectedBotInput === undefined) {
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

        const continueCustomId = `persona_sampledialogue_edit_confirm_${selection.phaseId}`;
        const cancelCustomId = `persona_sampledialogue_edit_cancel_${selection.phaseId}`;
        const confirmationDescription = localizer(locale, "commands.persona.sample-dialogue.edit.confirm_description", {
          input: formatDialoguePreview(selectedUserInput, 1500)
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n"),
          output: formatDialoguePreview(selectedBotInput, 1500)
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

        const userInputParts = splitPromptIntoModalParts(selectedUserInput, 2, DIALOGUE_PART_MAX_LENGTH);
        const botInputParts = splitPromptIntoModalParts(selectedBotInput, 2, DIALOGUE_PART_MAX_LENGTH);
        const editModalResult = await confirmationPhase.openModal({
          modalCustomId: EDIT_MODAL_CUSTOM_ID,
          modalTitleKey: "commands.persona.sample-dialogue.edit.modal_title",
          components: [
            {
              customId: USER_INPUT_PART1_ID,
              labelKey: "commands.persona.sample-dialogue.edit.user_input_label",
              descriptionKey: "commands.persona.sample-dialogue.edit.user_input_description",
              placeholder: "commands.persona.sample-dialogue.edit.user_input_placeholder",
              style: TextInputStyle.Paragraph,
              required: true,
              maxLength: DIALOGUE_PART_MAX_LENGTH,
              value: userInputParts[0] || undefined,
            },
            {
              customId: USER_INPUT_PART2_ID,
              labelKey: "commands.persona.sample-dialogue.edit.user_input_part2_label",
              style: TextInputStyle.Paragraph,
              required: false,
              maxLength: DIALOGUE_PART_MAX_LENGTH,
              value: userInputParts[1] || undefined,
            },
            {
              customId: BOT_INPUT_PART1_ID,
              labelKey: "commands.persona.sample-dialogue.edit.bot_input_label",
              descriptionKey: "commands.persona.sample-dialogue.edit.bot_input_description",
              placeholder: "commands.persona.sample-dialogue.edit.bot_input_placeholder",
              style: TextInputStyle.Paragraph,
              required: true,
              maxLength: DIALOGUE_PART_MAX_LENGTH,
              value: botInputParts[0] || undefined,
            },
            {
              customId: BOT_INPUT_PART2_ID,
              labelKey: "commands.persona.sample-dialogue.edit.bot_input_part2_label",
              style: TextInputStyle.Paragraph,
              required: false,
              maxLength: DIALOGUE_PART_MAX_LENGTH,
              value: botInputParts[1] || undefined,
            },
          ],
        });
        if (editModalResult.outcome !== "submitted") {
          log.info(`Sample dialogue edit modal ${editModalResult.outcome} for user ${userData.user_id}`);
          return editModalResult.outcome === "fatal" ? completePersonaWorkflow() : retryPersonaWorkflow();
        }

        const editWork = await editModalResult.phase.beginInPlaceWork();
        const editedUserInput = combineModalPromptParts(
          [
            editModalResult.phase.values[USER_INPUT_PART1_ID]?.trim() ?? "",
            editModalResult.phase.values[USER_INPUT_PART2_ID]?.trim() ?? "",
          ],
          DIALOGUE_PART_MAX_LENGTH,
        );
        const editedBotInput = combineModalPromptParts(
          [
            editModalResult.phase.values[BOT_INPUT_PART1_ID]?.trim() ?? "",
            editModalResult.phase.values[BOT_INPUT_PART2_ID]?.trim() ?? "",
          ],
          DIALOGUE_PART_MAX_LENGTH,
        );

        const userValidation = validateSampleDialogue(editedUserInput);
        if (!userValidation.isValid) {
          await editWork.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "commands.teach.sampledialogue.user_input_too_long_title",
              descriptionKey: "commands.teach.sampledialogue.user_input_too_long_description",
              descriptionVars: {
                current_length: editedUserInput.length.toString(),
                max_allowed: (userValidation.maxAllowed || memoryLimits.maxSampleDialogueLength).toString(),
              },
              footerKey: "general.pagination.reloading_persona_picker",
              color: ColorCode.ERROR,
            }),
          );
          return retryPersonaWorkflow();
        }
        const botValidation = validateSampleDialogue(editedBotInput);
        if (!botValidation.isValid) {
          await editWork.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "commands.teach.sampledialogue.bot_input_too_long_title",
              descriptionKey: "commands.teach.sampledialogue.bot_input_too_long_description",
              descriptionVars: {
                current_length: editedBotInput.length.toString(),
                max_allowed: (botValidation.maxAllowed || memoryLimits.maxSampleDialogueLength).toString(),
              },
              footerKey: "general.pagination.reloading_persona_picker",
              color: ColorCode.ERROR,
            }),
          );
          return retryPersonaWorkflow();
        }

        if (editedUserInput === selectedUserInput.trim() && editedBotInput === selectedBotInput.trim()) {
          await editWork.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "commands.persona.sample-dialogue.edit.no_changes_title",
              descriptionKey: "commands.persona.sample-dialogue.edit.no_changes_description",
              footerKey: "general.pagination.reloading_persona_picker",
              color: ColorCode.WARN,
            }),
          );
          return retryPersonaWorkflow();
        }

        const editedKey = makeDialogueKey(editedUserInput, editedBotInput);
        const duplicateExists = currentIn.some(
          (input, index) => index !== selectedIndex && makeDialogueKey(input, currentOut[index] ?? "") === editedKey,
        );
        if (duplicateExists) {
          await editWork.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "commands.persona.sample-dialogue.edit.duplicate_title",
              descriptionKey: "commands.persona.sample-dialogue.edit.duplicate_description",
              footerKey: "general.pagination.reloading_persona_picker",
              color: ColorCode.WARN,
            }),
          );
          return retryPersonaWorkflow();
        }

        const updated = await personaRepository.editSampleDialoguePairAt(
          personaId,
          selectedIndex + 1,
          editedUserInput,
          editedBotInput,
        );
        if (!updated) {
          const context: ErrorContext = {
            userId: userData.user_id,
            serverId: selection.persona.server_id,
            personaId,
            errorType: "DatabaseUpdateError",
            metadata: { command: "persona sample-dialogue edit", selectedIndex },
          };
          await log.error(
            "Failed to update sample dialogue arrays",
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
        log.success(`Updated sample dialogue ${selectedIndex} for tomori ${personaId} by ${userData.user_disc_id}`);
        await editWork.message.replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "commands.persona.sample-dialogue.edit.success_title",
            descriptionKey: "commands.persona.sample-dialogue.edit.success_description",
            descriptionVars: {
              input: formatDialoguePreview(editedUserInput),
              output: formatDialoguePreview(editedBotInput),
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
        command: "persona sample-dialogue edit",
        guildId: interaction.guild?.id,
        executorDiscordId: interaction.user.id,
      },
    };
    await log.error(
      `Unexpected error in /persona sample-dialogue edit for user ${userData.user_disc_id}`,
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
