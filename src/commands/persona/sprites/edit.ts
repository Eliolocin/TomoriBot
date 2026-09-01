import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  PermissionsBitField,
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
import type { ErrorContext, PersonaSpriteRow, TomoriState, UserRow } from "@/types/db/schema";
import type { SelectOption } from "@/types/discord/modal";
import { invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { personaRepository, personaSpriteRepository } from "@/utils/db/repositories";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
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
import { personaIdIsEligible } from "@/utils/discord/ui/personaEligibility";
import { convertToPNG } from "@/utils/image/imageProcessor";
import { ColorCode, log } from "@/utils/misc/logger";
import {
  isPersonaSpriteInstructionsTooLong,
  normalizePersonaSpriteInstructions,
  PERSONA_SPRITE_LIMITS,
  validatePersonaSpriteName,
} from "@/utils/persona/sprites";
import {
  downloadPersonaSpriteImageAttachment,
  validatePersonaSpriteImageAttachment,
} from "@/utils/persona/spriteImages";
import { memoryGuard, PERSONA_LIMITS, reserveAvatarQuota } from "@/utils/security/rateLimiter";
import { deletePersonaSpriteFromStorage, uploadPersonaSpriteToStorage } from "@/utils/storage/avatarStorage";
import { localizer } from "@/utils/text/localizer";
import { forkPointerForAvatarChange } from "../avatar";

const SELECT_MODAL_CUSTOM_ID = "persona_sprites_edit_select_modal";
const EDIT_MODAL_CUSTOM_ID = "persona_sprites_edit_value_modal";
const SPRITE_SELECT_ID = "sprite_select";
const SPRITE_NAME_INPUT_ID = "sprite_name_input";
const SPRITE_IMAGE_UPLOAD_ID = "sprite_image_upload";
const SPRITE_INSTRUCTIONS_INPUT_ID = "sprite_usage_instructions";
const SPRITE_IDENTITY_CHECKBOX_ID = "sprite_save_as_identity";
type SpriteWithId = PersonaSpriteRow & { sprite_id: number };

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
        content: `### ${localizer(locale, "commands.persona.sprites.edit.confirm_title")}`,
      },
      { type: ComponentType.TextDisplay, content: description },
      actionRow,
    ],
  };
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("edit").setDescription(localizer("en-US", "commands.persona.sprites.edit.description"));

/** Edits one sprite belonging to a selected persona. */
export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.guild || !interaction.channel) {
    await replyInfoEmbed(interaction, userData.language_pref, {
      titleKey: "general.errors.guild_only_title",
      descriptionKey: "general.errors.guild_only_description",
      color: ColorCode.ERROR,
    });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.persona.sprites.add.no_permission_title",
      descriptionKey: "commands.persona.sprites.add.no_permission_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guildId = interaction.guild.id;
  const workflowState: {
    selectedPersona: TomoriState | null;
    message: PersonaWorkflowMessageController | null;
  } = { selectedPersona: null, message: null };

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const allPersonas = await personaRepository.loadAllForServer(guildId);
    if (allPersonas.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Class B eligibility, pointer-aware (same batched resolver as sprite remove).
    // Editing never deletes a sprite, so the eligible set stays static (no refresh).
    const eligibleSpritePersonaIds = await personaSpriteRepository.personaIdsWithSprites(
      allPersonas.map((persona) => persona.persona_id).filter((id): id is number => typeof id === "number"),
    );
    const isEligible = personaIdIsEligible(eligibleSpritePersonaIds);
    const eligiblePersonas = allPersonas.filter(isEligible);
    if (eligiblePersonas.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.persona.sprites.edit.no_sprites_title",
        descriptionKey: "commands.persona.sprites.edit.no_eligible_sprites_description",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await runPersonaPickerWorkflow(interaction, locale, {
      personas: allPersonas,
      color: ColorCode.INFO,
      titleKey: "commands.persona.sprites.edit.persona_select_title",
      eligibility: {
        isEligible,
        emptyTitleKey: "commands.persona.sprites.edit.no_sprites_title",
        emptyDescriptionKey: "commands.persona.sprites.edit.no_eligible_sprites_description",
        itemsLabelKey: "general.persona_workflow.items.sprites",
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

        const selectionWork = await selection.beginInPlaceWork();
        await selectionWork.message.replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "general.persona_workflow.loading_title",
            descriptionKey: "general.persona_workflow.loading_description",
            color: ColorCode.INFO,
          }),
        );
        const sprites = (await personaSpriteRepository.listForPersona(personaId)).filter(
          (sprite): sprite is SpriteWithId => typeof sprite.sprite_id === "number",
        );
        if (sprites.length === 0) {
          await selectionWork.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "commands.persona.sprites.edit.no_sprites_title",
              descriptionKey: "commands.persona.sprites.edit.no_sprites_description",
              descriptionVars: { persona_name: selection.persona.persona_nickname },
              footerKey: "general.pagination.reloading_persona_picker",
              color: ColorCode.WARN,
            }),
          );
          return retryPersonaWorkflow();
        }

        const openSelectId = `persona_sprites_edit_open_${selection.phaseId}`;
        await selectionWork.message.replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "general.persona_workflow.modal_ready_title",
            descriptionKey: "general.persona_workflow.modal_ready_description",
            color: ColorCode.INFO,
            button: {
              customId: openSelectId,
              labelKey: "general.persona_workflow.open_modal_button",
              style: ButtonStyle.Secondary,
            },
          }),
        );

        let openSelectButton: ButtonInteraction;
        try {
          const message = await selectionWork.message.fetchMessage();
          openSelectButton = await message.awaitMessageComponent({
            componentType: ComponentType.Button,
            filter: (candidate) => candidate.user.id === interaction.user.id && candidate.customId === openSelectId,
            time: WORKFLOW_COMPONENT_TIMEOUT_MS,
          });
        } catch {
          await selectionWork.message.replace(
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

        const spriteOptions: SelectOption[] = sprites.map((sprite) => ({
          label: safeSelectOptionText(sprite.sprite_name, 100),
          value: sprite.sprite_key,
          description: safeSelectOptionText(formatSpriteOptionDescription(sprite, locale), 100),
        }));
        const selectModalResult = await selection.useButton(openSelectButton).openModal({
          modalCustomId: SELECT_MODAL_CUSTOM_ID,
          modalTitleKey: "commands.persona.sprites.edit.select_modal_title",
          components: [
            {
              customId: SPRITE_SELECT_ID,
              labelKey: "commands.persona.sprites.edit.select_label",
              descriptionKey: "commands.persona.sprites.edit.select_description",
              placeholder: "commands.persona.sprites.edit.select_placeholder",
              required: true,
              options: spriteOptions,
            },
          ],
        });
        if (selectModalResult.outcome !== "submitted") {
          log.info(`Sprite edit selection modal ${selectModalResult.outcome} for user ${userData.user_id}`);
          return selectModalResult.outcome === "fatal" ? completePersonaWorkflow() : retryPersonaWorkflow();
        }

        const selectWork = await selectModalResult.phase.beginInPlaceWork();
        const selectedSpriteKey = selectModalResult.phase.values[SPRITE_SELECT_ID];
        const selectedSprite = sprites.find((sprite) => sprite.sprite_key === selectedSpriteKey);
        if (!selectedSprite) {
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

        const continueCustomId = `persona_sprites_edit_confirm_${selection.phaseId}`;
        const cancelCustomId = `persona_sprites_edit_cancel_${selection.phaseId}`;
        const confirmationDescription = localizer(locale, "commands.persona.sprites.edit.confirm_description", {
          sprite_name: selectedSprite.sprite_name,
          identity_status: formatIdentityStatus(selectedSprite.is_identity, locale),
          instructions:
            selectedSprite.usage_instructions.trim() ||
            localizer(locale, "commands.persona.sprites.remove.default_usage_description"),
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

        const editModalResult = await confirmationPhase.openModal({
          modalCustomId: EDIT_MODAL_CUSTOM_ID,
          modalTitleKey: "commands.persona.sprites.edit.modal_title",
          components: [
            {
              customId: SPRITE_NAME_INPUT_ID,
              labelKey: "commands.persona.sprites.add.sprite_name_label",
              descriptionKey: "commands.persona.sprites.add.sprite_name_description",
              placeholder: "commands.persona.sprites.add.sprite_name_placeholder",
              style: TextInputStyle.Short,
              required: true,
              minLength: 1,
              maxLength: PERSONA_SPRITE_LIMITS.MAX_NAME_LENGTH,
              value: selectedSprite.sprite_name,
            },
            {
              customId: SPRITE_IMAGE_UPLOAD_ID,
              labelKey: "commands.persona.sprites.edit.image_label",
              descriptionKey: "commands.persona.sprites.edit.image_description",
              minValues: 0,
              maxValues: 1,
              required: false,
            },
            {
              customId: SPRITE_INSTRUCTIONS_INPUT_ID,
              labelKey: "commands.persona.sprites.add.instructions_label",
              descriptionKey: "commands.persona.sprites.add.instructions_description",
              placeholder: "commands.persona.sprites.add.instructions_placeholder",
              style: TextInputStyle.Paragraph,
              required: false,
              maxLength: PERSONA_SPRITE_LIMITS.MAX_INSTRUCTIONS_LENGTH,
              value: selectedSprite.usage_instructions.trim() || undefined,
            },
            {
              kind: "checkbox",
              customId: SPRITE_IDENTITY_CHECKBOX_ID,
              labelKey: "commands.persona.sprites.add.identity_label",
              descriptionKey: "commands.persona.sprites.add.identity_description",
              default: selectedSprite.is_identity,
            },
          ],
        });
        if (editModalResult.outcome !== "submitted") {
          log.info(`Sprite edit modal ${editModalResult.outcome} for user ${userData.user_id}`);
          return editModalResult.outcome === "fatal" ? completePersonaWorkflow() : retryPersonaWorkflow();
        }

        // This is the edit modal's only acknowledgement, including image replacement.
        const editWork = await editModalResult.phase.beginInPlaceWork();
        const nameValidation = validatePersonaSpriteName(editModalResult.phase.values[SPRITE_NAME_INPUT_ID] ?? "");
        if (!nameValidation.ok) {
          await editWork.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "commands.persona.sprites.add.invalid_name_title",
              descriptionKey: `commands.persona.sprites.add.invalid_name_${nameValidation.reason}`,
              descriptionVars: { max_length: PERSONA_SPRITE_LIMITS.MAX_NAME_LENGTH.toString() },
              footerKey: "general.pagination.reloading_persona_picker",
              color: ColorCode.ERROR,
            }),
          );
          return retryPersonaWorkflow();
        }

        const usageInstructions = normalizePersonaSpriteInstructions(
          editModalResult.phase.values[SPRITE_INSTRUCTIONS_INPUT_ID],
        );
        if (isPersonaSpriteInstructionsTooLong(usageInstructions)) {
          await editWork.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "commands.persona.sprites.add.instructions_too_long_title",
              descriptionKey: "commands.persona.sprites.add.instructions_too_long_description",
              descriptionVars: { max_length: PERSONA_SPRITE_LIMITS.MAX_INSTRUCTIONS_LENGTH.toString() },
              footerKey: "general.pagination.reloading_persona_picker",
              color: ColorCode.ERROR,
            }),
          );
          return retryPersonaWorkflow();
        }

        const saveAsIdentity = editModalResult.phase.values[SPRITE_IDENTITY_CHECKBOX_ID] === "true";
        const imageAttachment = editModalResult.phase.attachments[SPRITE_IMAGE_UPLOAD_ID];
        if (imageAttachment) {
          const imageValidation = validatePersonaSpriteImageAttachment(imageAttachment);
          if (!imageValidation.ok) {
            await editWork.message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "commands.persona.sprites.add.invalid_image_title",
                descriptionKey:
                  imageValidation.reason === "file_too_large"
                    ? "commands.persona.sprites.add.file_too_large_description"
                    : "commands.persona.sprites.add.invalid_format_description",
                descriptionVars: { max_size: PERSONA_LIMITS.MAX_AVATAR_SIZE_MB.toString() },
                footerKey: "general.pagination.reloading_persona_picker",
                color: ColorCode.ERROR,
              }),
            );
            return retryPersonaWorkflow();
          }
        }

        const duplicateKey = sprites.some(
          (sprite) => sprite.sprite_key !== selectedSprite.sprite_key && sprite.sprite_key === nameValidation.spriteKey,
        );
        if (duplicateKey) {
          await editWork.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "commands.persona.sprites.edit.duplicate_title",
              descriptionKey: "commands.persona.sprites.edit.duplicate_description",
              descriptionVars: { sprite_name: nameValidation.displayName },
              footerKey: "general.pagination.reloading_persona_picker",
              color: ColorCode.WARN,
            }),
          );
          return retryPersonaWorkflow();
        }

        const noChanges =
          nameValidation.displayName === selectedSprite.sprite_name &&
          usageInstructions === selectedSprite.usage_instructions.trim() &&
          saveAsIdentity === selectedSprite.is_identity &&
          !imageAttachment;
        if (noChanges) {
          await editWork.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "commands.persona.sprites.edit.no_changes_title",
              descriptionKey: "commands.persona.sprites.edit.no_changes_description",
              footerKey: "general.pagination.reloading_persona_picker",
              color: ColorCode.WARN,
            }),
          );
          return retryPersonaWorkflow();
        }

        if (imageAttachment) {
          const memoryCheck = memoryGuard.checkMemory();
          if (memoryCheck.status === "critical") {
            await editWork.message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "rate_limit.error_memory_critical_title",
                descriptionKey: "rate_limit.error_memory_critical_description",
                footerKey: "general.pagination.reloading_persona_picker",
                color: ColorCode.ERROR,
              }),
            );
            return retryPersonaWorkflow();
          }

          const quotaReserve = reserveAvatarQuota(guildId);
          if (!quotaReserve.allowed) {
            const resetTime = quotaReserve.resetAt
              ? new Date(quotaReserve.resetAt).toLocaleString(locale)
              : localizer(locale, "general.unknown");
            await editWork.message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "rate_limit.error_quota_exceeded_title",
                descriptionKey: "rate_limit.error_quota_exceeded_description",
                descriptionVars: { reset_time: resetTime },
                footerKey: "general.pagination.reloading_persona_picker",
                color: ColorCode.ERROR,
              }),
            );
            return retryPersonaWorkflow();
          }
        }

        const wasPointer = selection.persona.is_pointer === true;
        const pointerForked = await forkPointerForAvatarChange(selection.persona);
        if (!pointerForked) {
          await editWork.message.replace(
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
        if (wasPointer) invalidateTomoriStateCache(guildId);

        let uploadedReference: string | null = null;
        if (imageAttachment) {
          const downloadedBuffer = await downloadPersonaSpriteImageAttachment(imageAttachment);
          if (!downloadedBuffer.ok) {
            await editWork.message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "commands.persona.sprites.add.invalid_image_title",
                descriptionKey:
                  downloadedBuffer.reason === "timeout"
                    ? "commands.persona.sprites.add.error_download_timeout"
                    : "commands.persona.sprites.add.error_download_failed",
                footerKey: "general.pagination.reloading_persona_picker",
                color: ColorCode.ERROR,
              }),
            );
            return retryPersonaWorkflow();
          }

          let pngBuffer: Buffer;
          try {
            pngBuffer = await convertToPNG(downloadedBuffer.buffer);
          } catch (error) {
            log.warn("Failed to convert persona sprite replacement image to PNG", error);
            await editWork.message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "commands.persona.sprites.add.conversion_error_title",
                descriptionKey: "commands.persona.sprites.add.conversion_error_description",
                footerKey: "general.pagination.reloading_persona_picker",
                color: ColorCode.ERROR,
              }),
            );
            return retryPersonaWorkflow();
          }

          uploadedReference = await uploadPersonaSpriteToStorage({
            personaId,
            serverDiscId: guildId,
            label: nameValidation.displayName,
            buffer: pngBuffer,
          });
          if (!uploadedReference) {
            await editWork.message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "commands.persona.sprites.add.api_error_title",
                descriptionKey: "commands.persona.sprites.add.api_error_description",
                footerKey: "general.pagination.reloading_persona_picker",
                color: ColorCode.ERROR,
              }),
            );
            return retryPersonaWorkflow();
          }
        }

        const updateResult = await personaSpriteRepository.updateSpriteMetadata({
          currentSpriteKey: selectedSprite.sprite_key,
          personaId,
          spriteName: nameValidation.displayName,
          spriteKey: nameValidation.spriteKey,
          avatarUrl: uploadedReference ?? undefined,
          usageInstructions,
          isIdentity: saveAsIdentity,
        });
        if (!updateResult) {
          if (uploadedReference) await deletePersonaSpriteFromStorage(uploadedReference);
          await editWork.message.replace(
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

        if (
          uploadedReference &&
          updateResult.previousAvatarUrl &&
          updateResult.previousAvatarUrl !== uploadedReference
        ) {
          await deletePersonaSpriteFromStorage(updateResult.previousAvatarUrl);
        }
        const updatedSprite = updateResult.sprite;
        log.success(
          `Edited sprite "${selectedSprite.sprite_key}" for persona ${personaId} by ${userData.user_disc_id}: "${updatedSprite.sprite_name}" (identity=${updatedSprite.is_identity})`,
        );
        await editWork.message.replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "commands.persona.sprites.edit.success_title",
            descriptionKey: "commands.persona.sprites.edit.success_description",
            descriptionVars: {
              persona_name: selection.persona.persona_nickname,
              sprite_name: updatedSprite.sprite_name,
            },
            footerKey: "general.pagination.reloading_persona_picker",
            color: ColorCode.SUCCESS,
          }),
        );
        const refreshedPersonas = await personaRepository.loadAllForServer(guildId);
        return retryPersonaWorkflow(refreshedPersonas);
      },
    });
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      personaId: workflowState.selectedPersona?.persona_id,
      errorType: "CommandExecutionError",
      metadata: {
        command: "persona sprites edit",
        guildId,
        executorDiscordId: interaction.user.id,
      },
    };
    await log.error("Error in /persona sprites edit command", error as Error, context);
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

function formatSpriteOptionDescription(sprite: PersonaSpriteRow, locale: string): string {
  const status = formatIdentityStatus(sprite.is_identity, locale);
  const instructions =
    sprite.usage_instructions.trim() || localizer(locale, "commands.persona.sprites.remove.default_usage_description");
  return `${status} · ${instructions}`;
}

function formatIdentityStatus(isIdentity: boolean, locale: string): string {
  return localizer(
    locale,
    isIdentity
      ? "commands.persona.sprites.edit.identity_status_on"
      : "commands.persona.sprites.edit.identity_status_off",
  );
}
