import type {
  ChatInputCommandInteraction,
  Client,
  SlashCommandSubcommandBuilder,
  ModalSubmitInteraction,
} from "discord.js";
import { MessageFlags, TextInputStyle } from "discord.js";
import type { UserRow, ErrorContext, TomoriState } from "@/types/db/schema";
import { localizer } from "@/utils/text/localizer";
import { log, ColorCode } from "@/utils/misc/logger";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { promptWithPaginatedModal, safeSelectOptionText } from "@/utils/discord/ui/modals";
import { personaRepository, personalMemoryRepository, userRepository } from "@/utils/db/repositories";
import { invalidateUserCache } from "@/utils/cache/userCache";
import type { ModalResult, SelectOption } from "@/types/discord/modal";
import { validateMemoryContent, getMemoryLimits } from "@/utils/misc/memoryLimits";

import type { ModalComponent } from "@/types/discord/modal";
import { dedupeCaseInsensitive, getNonEmptyNumberedLines, readTxtUpload } from "@/utils/teach/batchUploadUtils";

const MODAL_CUSTOM_ID = "teach_personalmemory_add_modal";
const MEMORY_INPUT_ID = "personal_memory_input";
const MEMORY_FILE_UPLOAD_ID = "personal_memory_file_upload";
const MEMORY_TAGS_INPUT_ID = "personal_memory_tags_input";
const PERSONAL_SCOPE_VALUE = "persona";
const GLOBAL_SCOPE_VALUE = "global";
const GLOBAL_PERSONAL_MEMORY_LINEAGE_ID = 0;

const MAX_TAGS = 5;
const MAX_TAG_LENGTH = 32;

const memoryLimits = getMemoryLimits();

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("add")
    .setDescription(localizer("en-US", "commands.memory.personal.add.description"))
    .addStringOption((option) =>
      option
        .setName("scope")
        .setDescription(localizer("en-US", "commands.memory.personal.add.scope_description"))
        .setRequired(false)
        .addChoices(
          {
            name: localizer("en-US", "commands.memory.personal.add.scope_choice_persona"),
            value: PERSONAL_SCOPE_VALUE,
          },
          {
            name: localizer("en-US", "commands.memory.personal.add.scope_choice_global"),
            value: GLOBAL_SCOPE_VALUE,
          },
        ),
    );

/**
 * JSDoc comment for exported function
 * Adds a personal memory to the user's record in the users table.
 */
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

  // Define state and modal result outside try for catch block
  let tomoriState: TomoriState | null = null;
  let selectedPersona: TomoriState | null = null;
  let modalResult: ModalResult | null = null;
  let modalSubmitInteraction: ModalSubmitInteraction | null = null;

  try {
    // We need this even though we're updating the users table
    // Use user ID for DM context, guild ID for server context
    const serverId = interaction.guild?.id ?? interaction.user.id;
    const memoryScope =
      (interaction.options.getString("scope") as typeof PERSONAL_SCOPE_VALUE | typeof GLOBAL_SCOPE_VALUE | null) ??
      PERSONAL_SCOPE_VALUE;
    tomoriState = await personaRepository.loadState(serverId);

    if (!tomoriState) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let targetLineageId = GLOBAL_PERSONAL_MEMORY_LINEAGE_ID;
    let allPersonas: TomoriState[] = [];
    const modalComponents: ModalComponent[] = [];

    if (memoryScope === PERSONAL_SCOPE_VALUE) {
      allPersonas = await personaRepository.loadAllForServer(serverId);
      if (allPersonas.length === 0) {
        await replyInfoEmbed(interaction, locale, {
          titleKey: "general.errors.tomori_not_setup_title",
          descriptionKey: "general.errors.tomori_not_setup_description",
          color: ColorCode.ERROR,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const personaSelectOptions: SelectOption[] = allPersonas
        .filter((persona) => persona.persona_id !== undefined)
        .map((persona) => ({
          label: safeSelectOptionText(persona.persona_nickname),
          value: persona.persona_id?.toString() ?? "",
          description: persona.is_alter
            ? localizer(locale, "commands.teach.memory.personal.alter_persona_description")
            : localizer(locale, "commands.teach.memory.personal.main_persona_description"),
        }))
        .filter((option) => option.value !== "");

      modalComponents.push({
        customId: "persona_select",
        labelKey: "commands.teach.memory.personal.persona_select_label",
        descriptionKey: "commands.teach.memory.personal.persona_select_description",
        placeholder: "commands.teach.memory.personal.persona_select_placeholder",
        required: true,
        options: personaSelectOptions,
      });
    }

    modalComponents.push({
      customId: MEMORY_INPUT_ID,
      labelKey: "commands.teach.memory.personal.memory_input_label",
      descriptionKey: "commands.teach.memory.personal.memory_input_description",
      placeholder: "commands.teach.memory.personal.memory_input_placeholder",
      style: TextInputStyle.Paragraph,
      required: false,
      maxLength: memoryLimits.maxMemoryLength,
    });
    modalComponents.push({
      customId: MEMORY_FILE_UPLOAD_ID,
      labelKey: "commands.teach.memory.personal.batch_file_label",
      descriptionKey: "commands.teach.memory.personal.batch_file_description",
      minValues: 0,
      maxValues: 1,
      required: false,
    });
    modalComponents.push({
      customId: MEMORY_TAGS_INPUT_ID,
      labelKey: "Memory Tags",
      descriptionKey: "Up to 5 comma-separated case-sensitive keyword or #channel tags; see Memory Tagging in /help",
      placeholder: "mango,drinks,snacks",
      style: TextInputStyle.Short,
      required: false,
      maxLength: MAX_TAGS * (MAX_TAG_LENGTH + 2),
    });

    // Prompt user with a modal with Component Type 18 support
    modalResult = await promptWithPaginatedModal(interaction, locale, {
      modalCustomId: MODAL_CUSTOM_ID,
      modalTitleKey: "commands.teach.memory.personal.modal_title",
      components: modalComponents,
    });

    if (modalResult.outcome !== "submit") {
      log.info(`Personal memory add modal ${modalResult.outcome} for user ${userData.user_id}`);
      return;
    }

    // Capture and immediately defer the modal submission interaction
    // biome-ignore lint/style/noNonNullAssertion: Outcome 'submit' guarantees interaction
    modalSubmitInteraction = modalResult.interaction!;

    const typedMemory = modalResult.values?.[MEMORY_INPUT_ID]?.trim() ?? "";
    const uploadedTextFile = modalResult.attachments?.[MEMORY_FILE_UPLOAD_ID];
    const rawTagsInput = modalResult.values?.[MEMORY_TAGS_INPUT_ID]?.trim() ?? "";
    const parsedTags = rawTagsInput
      ? [
          ...new Set(
            rawTagsInput
              .split(",")
              .map((t) => t.trim().replace(/^["']+|["']+$/g, ""))
              .filter((t) => t.length > 0 && t.length <= MAX_TAG_LENGTH),
          ),
        ].slice(0, MAX_TAGS)
      : [];
    if (memoryScope === PERSONAL_SCOPE_VALUE) {
      const selectedPersonaId = modalResult.values?.persona_select;
      selectedPersona = allPersonas.find((persona) => persona.persona_id?.toString() === selectedPersonaId) ?? null;
      if (!selectedPersona) {
        await replyInfoEmbed(modalSubmitInteraction, locale, {
          titleKey: "general.errors.invalid_option_title",
          descriptionKey: "general.errors.invalid_option_description",
          color: ColorCode.ERROR,
        });
        return;
      }
      targetLineageId = selectedPersona.persona_lineage_id ?? 0;
      if (targetLineageId === GLOBAL_PERSONAL_MEMORY_LINEAGE_ID) {
        await replyInfoEmbed(modalSubmitInteraction, locale, {
          titleKey: "general.errors.operation_failed_title",
          descriptionKey: "general.errors.operation_failed_description",
          color: ColorCode.ERROR,
        });
        return;
      }
    }
    const targetUserId = userData.user_id;
    if (!targetUserId) {
      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "general.errors.operation_failed_title",
        descriptionKey: "general.errors.operation_failed_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const pendingMemories: string[] = [];
    if (typedMemory) {
      pendingMemories.push(typedMemory);
    }

    if (uploadedTextFile) {
      const uploadResult = await readTxtUpload(uploadedTextFile);
      if (!uploadResult.isValid || !uploadResult.text) {
        const errorKey =
          uploadResult.error === "invalid_format"
            ? "commands.teach.memory.personal.invalid_file_description"
            : uploadResult.error === "file_too_large"
              ? "commands.teach.memory.personal.file_too_large_description"
              : "commands.teach.memory.personal.download_failed_description";

        await replyInfoEmbed(modalSubmitInteraction, locale, {
          titleKey: "commands.teach.memory.personal.invalid_file_title",
          descriptionKey: errorKey,
          descriptionVars: {
            max_size: "1",
          },
          color: ColorCode.ERROR,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const importedMemories = getNonEmptyNumberedLines(uploadResult.text).map((line) => line.content);
      pendingMemories.push(...importedMemories);
    }

    if (pendingMemories.length === 0) {
      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "commands.teach.memory.personal.no_input_title",
        descriptionKey: "commands.teach.memory.personal.no_input_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const dedupedMemories = dedupeCaseInsensitive(pendingMemories);

    for (const memory of dedupedMemories) {
      const contentValidation = validateMemoryContent(memory);
      if (!contentValidation.isValid) {
        await replyInfoEmbed(modalSubmitInteraction, locale, {
          titleKey: "commands.teach.memory.personal.content_too_long_title",
          descriptionKey: "commands.teach.memory.personal.content_too_long_description",
          descriptionVars: { max_length: memoryLimits.maxMemoryLength },
          color: ColorCode.ERROR,
        });
        return;
      }
    }

    // Check if user has opted out of personalization (privacy setting)
    const { PrivacyLevel } = await import("../../../types/db/schema");
    const userPrivacyLevel = await userRepository.getPrivacyLevel(interaction.user.id);

    // Only block FULL privacy level (MINIMAL and PARTIAL can manually teach)
    if (userPrivacyLevel === PrivacyLevel.FULL) {
      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "commands.teach.memory.personal.opted_out_error_title",
        descriptionKey: "commands.teach.memory.personal.opted_out_error_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      log.info(
        `User ${interaction.user.id} (${userData.user_nickname}) attempted to use /teach personalmemory with privacy level ${userPrivacyLevel}`,
      );
      return;
    }

    const currentMemories = userData.user_id
      ? await personalMemoryRepository.loadForUserLineage(
          userData.user_id,
          targetLineageId,
          memoryScope === GLOBAL_SCOPE_VALUE,
        )
      : [];

    const existingMemories = new Set(currentMemories.map((row) => row.content.trim().toLowerCase()));
    const memoriesToAdd = dedupedMemories.filter((memory) => !existingMemories.has(memory.toLowerCase()));

    if (memoriesToAdd.length === 0) {
      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "commands.teach.memory.personal.duplicate_title",
        descriptionKey: "commands.teach.memory.personal.duplicate_description",
        descriptionVars: { memory: dedupedMemories[0] ?? typedMemory },
        color: ColorCode.WARN,
      });
      return;
    }

    const personalLimitCheck = await personalMemoryRepository.checkPersonalMemoryLimit(
      targetUserId,
      targetLineageId,
      memoryScope === GLOBAL_SCOPE_VALUE,
    );
    const currentCount = personalLimitCheck.currentCount ?? currentMemories.length;
    const maxAllowed = personalLimitCheck.maxAllowed ?? memoryLimits.maxPersonalMemories;
    const availableSlots = Math.max(0, maxAllowed - currentCount);
    if (memoriesToAdd.length > availableSlots) {
      const removeCount = memoriesToAdd.length - availableSlots;
      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: uploadedTextFile
          ? "commands.teach.memory.personal.batch_limit_exceeded_title"
          : "commands.teach.memory.personal.limit_exceeded_title",
        descriptionKey: uploadedTextFile
          ? "commands.teach.memory.personal.batch_limit_exceeded_description"
          : "commands.teach.memory.personal.limit_exceeded_description",
        descriptionVars: uploadedTextFile
          ? {
              max_allowed: maxAllowed.toString(),
              current_count: currentCount.toString(),
              import_count: memoriesToAdd.length.toString(),
              remove_count: removeCount.toString(),
            }
          : {
              max_allowed: maxAllowed.toString(),
              current_count: currentCount.toString(),
            },
        color: ColorCode.ERROR,
      });
      return;
    }

    let insertSuccess = true;
    if (memoriesToAdd.length === 1) {
      const insertedMemory = await personalMemoryRepository.add(
        targetUserId,
        targetLineageId,
        memoriesToAdd[0] ?? "",
        parsedTags,
      );
      insertSuccess = insertedMemory !== null;
    } else {
      // Batch path: delegate to repository which wraps the transaction internally
      insertSuccess = await personalMemoryRepository.addBatch(targetUserId, targetLineageId, memoriesToAdd, parsedTags);
      if (!insertSuccess) {
        await log.error("Batch insert failed for personal memories", new Error("addBatch returned false"), {
          userId: userData.user_id,
          serverId: tomoriState.server_id,
          personaId: selectedPersona?.persona_id ?? tomoriState.persona_id,
          errorType: "DatabaseValidationError",
          metadata: {
            command: "teach personalmemory",
            memoryScope,
            targetLineageId,
            insertCount: memoriesToAdd.length,
          },
        });
      }
    }

    if (!insertSuccess) {
      const context: ErrorContext = {
        userId: userData.user_id,
        serverId: tomoriState.server_id, // Include server context
        personaId: selectedPersona?.persona_id ?? tomoriState.persona_id,
        errorType: "DatabaseValidationError",
        metadata: {
          command: "teach personalmemory",
          table: "personal_memories",
          column: "content",
          operation: "INSERT",
          userDiscordId: interaction.user.id,
          memoryScope,
          targetLineageId,
          newMemoryContent: memoriesToAdd.join("\n"),
        },
      };
      await log.error("Failed to insert personal memory", new Error("Insert returned null"), context);

      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "general.errors.update_failed_title",
        descriptionKey: "general.errors.update_failed_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const isBatchAdd = memoriesToAdd.length > 1 || Boolean(uploadedTextFile);
    let descriptionKey = isBatchAdd
      ? "commands.teach.memory.personal.batch_success_description"
      : "commands.teach.memory.personal.success_description";
    let embedColor = ColorCode.SUCCESS;

    // Check both personalization settings and user blacklisting (similar to memoryTool.ts:437-454)
    const personalizationEnabled = tomoriState?.config.personal_memories_enabled ?? true;
    // Only check blacklisting for guild contexts (DM users can't be blacklisted)
    const userIsBlacklisted = interaction.guild
      ? ((await userRepository.isBlacklisted(interaction.guild.id, interaction.user.id)) ?? false)
      : false;

    if (!personalizationEnabled) {
      descriptionKey = isBatchAdd
        ? "commands.teach.memory.personal.batch_success_but_disabled_description"
        : "commands.teach.memory.personal.success_but_disabled_description";
      embedColor = ColorCode.WARN;
    } else if (userIsBlacklisted) {
      descriptionKey = isBatchAdd
        ? "commands.teach.memory.personal.batch_success_but_blacklisted_description"
        : "commands.teach.memory.personal.success_but_blacklisted_description";
      embedColor = ColorCode.WARN;
    }

    // Invalidate user cache so next message gets fresh data
    invalidateUserCache(interaction.user.id);

    const firstMemory = memoriesToAdd[0] ?? "";
    const memoryPreview = firstMemory.length > 96 ? `${firstMemory.slice(0, 96)}...` : firstMemory;

    await replyInfoEmbed(modalSubmitInteraction, locale, {
      titleKey: isBatchAdd
        ? "commands.teach.memory.personal.batch_success_title"
        : "commands.teach.memory.personal.success_title",
      descriptionKey: descriptionKey, // Use the determined description key
      descriptionVars: isBatchAdd
        ? {
            added_count: memoriesToAdd.length.toString(),
          }
        : {
            memory: memoryPreview,
          },
      color: embedColor, // Use the determined color
    });
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: tomoriState?.server_id,
      personaId: tomoriState?.persona_id,
      errorType: "CommandExecutionError",
      metadata: {
        command: "teach personalmemory",
        userDiscordId: interaction.user.id,
        guildId: interaction.guild?.id,
      },
    };
    await log.error("Error in /teach personalmemory command", error, context);

    const errorReplyInteraction =
      modalSubmitInteraction && (modalSubmitInteraction.replied || modalSubmitInteraction.deferred)
        ? modalSubmitInteraction
        : interaction.replied || interaction.deferred
          ? interaction
          : null;

    if (errorReplyInteraction) {
      try {
        await replyInfoEmbed(errorReplyInteraction, locale, {
          titleKey: "general.errors.unknown_error_title",
          descriptionKey: "general.errors.unknown_error_description",
          color: ColorCode.ERROR,
          flags: MessageFlags.Ephemeral,
        });
      } catch (replyError) {
        log.error("Failed to send error reply in personalmemory catch block", replyError, {
          ...context,
          errorType: "ErrorReplyFailed",
        });
      }
    } else {
      log.warn(
        "Interaction was not replied or deferred in personalmemory catch block, cannot send error message to user.",
        context,
      );
    }
  }
}
