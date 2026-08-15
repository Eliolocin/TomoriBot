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
import { personaRepository, serverMemoryRepository, userRepository } from "@/utils/db/repositories";
import { getCachedTomoriState, invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import type { ModalResult, SelectOption } from "@/types/discord/modal";
import { validateMemoryContent, getMemoryLimits } from "@/utils/misc/memoryLimits";

import { dedupeCaseInsensitive, getNonEmptyNumberedLines, readTxtUpload } from "@/utils/teach/batchUploadUtils";

const MODAL_CUSTOM_ID = "teach_servermemory_add_modal";
const MEMORY_INPUT_ID = "memory_input";
const MEMORY_FILE_UPLOAD_ID = "server_memory_file_upload";
const MEMORY_TAGS_INPUT_ID = "memory_tags_input";

const MAX_TAGS = 5;
const MAX_TAG_LENGTH = 32;

const memoryLimits = getMemoryLimits();

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("add").setDescription(localizer("en-US", "commands.memory.server.add.description"));

/**
 * JSDoc comment for exported function
 * Adds a server memory to Tomori's knowledge for the server by inserting into the server_memories table.
 */
export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  // Ensure command is run in a valid channel context
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
  let modalResult: ModalResult | null = null;
  let modalSubmitInteraction: ModalSubmitInteraction | null = null;

  try {
    const hasManagePermission = interaction.memberPermissions?.has("ManageGuild") ?? false;

    // Check blacklisting only for guild contexts
    // Users with Manage Server permission can bypass blacklist (they can unblacklist themselves anyway)
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

    tomoriState = await getCachedTomoriState(interaction.guild?.id ?? interaction.user.id);

    if (!tomoriState) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const allPersonas = await personaRepository.loadAllForServer(interaction.guild?.id ?? interaction.user.id);
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
          ? localizer(locale, "commands.teach.memory.server.alter_persona_description")
          : localizer(locale, "commands.teach.memory.server.main_persona_description"),
      }))
      .filter((option) => option.value !== "");

    if (!tomoriState.config.server_memteaching_enabled && !hasManagePermission) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.teach.memory.server.teaching_disabled_title",
        descriptionKey: "commands.teach.memory.server.teaching_disabled_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    modalResult = await promptWithPaginatedModal(interaction, locale, {
      modalCustomId: MODAL_CUSTOM_ID,
      modalTitleKey: "commands.teach.memory.server.modal_title",
      components: [
        {
          customId: "persona_select",
          labelKey: "commands.teach.memory.server.persona_select_label",
          descriptionKey: "commands.teach.memory.server.persona_select_description",
          placeholder: "commands.teach.memory.server.persona_select_placeholder",
          required: true,
          options: personaSelectOptions,
        },
        {
          customId: MEMORY_INPUT_ID,
          labelKey: "commands.teach.memory.server.memory_input_label",
          descriptionKey: "commands.teach.memory.server.memory_input_description",
          placeholder: "commands.teach.memory.server.memory_input_placeholder",
          style: TextInputStyle.Paragraph,
          required: false,
          maxLength: memoryLimits.maxMemoryLength,
        },
        {
          customId: MEMORY_FILE_UPLOAD_ID,
          labelKey: "commands.teach.memory.server.batch_file_label",
          descriptionKey: "commands.teach.memory.server.batch_file_description",
          minValues: 0,
          maxValues: 1,
          required: false,
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
        },
      ],
    });

    if (modalResult.outcome !== "submit") {
      log.info(`Server memory add modal ${modalResult.outcome} for user ${userData.user_id}`);
      return;
    }

    // Capture the modal submission interaction - let helper functions manage interaction state
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
    const selectedPersonaId = modalResult.values?.persona_select;
    selectedPersona = allPersonas.find((persona) => persona.persona_id?.toString() === selectedPersonaId) ?? null;
    if (!selectedPersona?.persona_id) {
      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "general.errors.invalid_option_title",
        descriptionKey: "general.errors.invalid_option_description",
        color: ColorCode.ERROR,
      });
      return;
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
    const targetPersonaId = selectedPersona.persona_id;
    const targetPersonaLineageId = selectedPersona.persona_lineage_id ?? 0;
    const targetServerId = tomoriState.server_id;

    const pendingMemories: string[] = [];
    if (typedMemory) {
      pendingMemories.push(typedMemory);
    }

    if (uploadedTextFile) {
      const uploadResult = await readTxtUpload(uploadedTextFile);
      if (!uploadResult.isValid || !uploadResult.text) {
        const errorKey =
          uploadResult.error === "invalid_format"
            ? "commands.teach.memory.server.invalid_file_description"
            : uploadResult.error === "file_too_large"
              ? "commands.teach.memory.server.file_too_large_description"
              : "commands.teach.memory.server.download_failed_description";

        await replyInfoEmbed(modalSubmitInteraction, locale, {
          titleKey: "commands.teach.memory.server.invalid_file_title",
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
        titleKey: "commands.teach.memory.server.no_input_title",
        descriptionKey: "commands.teach.memory.server.no_input_description",
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
          titleKey: "commands.teach.memory.server.content_too_long_title",
          descriptionKey: "commands.teach.memory.server.content_too_long_description",
          descriptionVars: { max_length: memoryLimits.maxMemoryLength },
          color: ColorCode.ERROR,
        });
        return;
      }
    }

    const existingContents = await serverMemoryRepository.loadServerMemoryContents(
      targetServerId,
      targetPersonaLineageId,
    );
    const existingMemories = new Set(existingContents.map((c) => c.trim().toLowerCase()).filter((c) => c.length > 0));
    const memoriesToAdd = dedupedMemories.filter((memory) => !existingMemories.has(memory.toLowerCase()));

    if (memoriesToAdd.length === 0) {
      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "commands.teach.memory.server.duplicate_title",
        descriptionKey: "commands.teach.memory.server.duplicate_description",
        descriptionVars: {
          memory: dedupedMemories[0] ?? typedMemory,
        },
        color: ColorCode.WARN,
      });
      return;
    }

    const serverLimitCheck = await serverMemoryRepository.checkServerMemoryLimit(
      targetServerId,
      targetPersonaLineageId,
    );
    const currentCount = serverLimitCheck.currentCount ?? existingContents.length;
    const maxAllowed = serverLimitCheck.maxAllowed ?? memoryLimits.maxServerMemories;
    const availableSlots = Math.max(0, maxAllowed - currentCount);
    if (memoriesToAdd.length > availableSlots) {
      const removeCount = memoriesToAdd.length - availableSlots;
      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: uploadedTextFile
          ? "commands.teach.memory.server.batch_limit_exceeded_title"
          : "commands.teach.memory.server.limit_exceeded_title",
        descriptionKey: uploadedTextFile
          ? "commands.teach.memory.server.batch_limit_exceeded_description"
          : "commands.teach.memory.server.limit_exceeded_description",
        descriptionVars: uploadedTextFile
          ? {
              current_count: currentCount.toString(),
              max_allowed: maxAllowed.toString(),
              import_count: memoriesToAdd.length.toString(),
              remove_count: removeCount.toString(),
            }
          : {
              current_count: currentCount.toString(),
              max_allowed: maxAllowed.toString(),
            },
        color: ColorCode.ERROR,
      });
      return;
    }

    let insertSuccess = true;
    if (memoriesToAdd.length === 1) {
      const insertedMemory = await serverMemoryRepository.add(
        targetServerId,
        targetPersonaId,
        targetPersonaLineageId,
        targetUserId,
        memoriesToAdd[0] ?? "",
        parsedTags,
      );
      insertSuccess = insertedMemory !== null;
    } else {
      // Batch path: delegate to repository which wraps the transaction internally
      insertSuccess = await serverMemoryRepository.addBatch(
        targetServerId,
        targetPersonaId,
        targetPersonaLineageId,
        targetUserId,
        memoriesToAdd,
        parsedTags,
      );
      if (!insertSuccess) {
        await log.error("Batch insert failed for server memories", new Error("addBatch returned false"), {
          userId: userData.user_id,
          serverId: targetServerId,
          personaId: targetPersonaId,
          errorType: "DatabaseValidationError",
          metadata: {
            command: "teach servermemory",
            insertCount: memoriesToAdd.length,
            targetPersonaId: targetPersonaId,
          },
        });
      }
    }

    if (!insertSuccess) {
      const context: ErrorContext = {
        userId: userData.user_id,
        serverId: targetServerId,
        personaId: targetPersonaId,
        errorType: "DatabaseValidationError",
        metadata: {
          command: "teach servermemory",
          table: "server_memories",
          operation: "INSERT",
          userDiscordId: interaction.user.id,
          newMemoryContent: memoriesToAdd.join("\n"),
          targetPersonaId: targetPersonaId,
        },
      };
      await log.error("Failed to insert server memory data", new Error("Insert returned null"), context);

      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "general.errors.update_failed_title", // Re-use generic failure message
        descriptionKey: "general.errors.update_failed_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    // Invalidate cache so next message gets fresh config
    invalidateTomoriStateCache(interaction.guild?.id ?? interaction.user.id);

    const firstMemory = memoriesToAdd[0] ?? "";
    const memoryPreview = firstMemory.length > 96 ? `${firstMemory.slice(0, 96)}...` : firstMemory;

    await replyInfoEmbed(modalSubmitInteraction, locale, {
      titleKey:
        memoriesToAdd.length > 1 || uploadedTextFile
          ? "commands.teach.memory.server.batch_success_title"
          : "commands.teach.memory.server.success_title",
      descriptionKey:
        memoriesToAdd.length > 1 || uploadedTextFile
          ? "commands.teach.memory.server.batch_success_description"
          : "commands.teach.memory.server.success_description",
      descriptionVars:
        memoriesToAdd.length > 1 || uploadedTextFile
          ? {
              added_count: memoriesToAdd.length.toString(),
            }
          : {
              memory: memoryPreview,
            },
      color: ColorCode.SUCCESS,
    });
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: tomoriState?.server_id,
      personaId: tomoriState?.persona_id,
      errorType: "CommandExecutionError",
      metadata: {
        command: "teach servermemory",
        userDiscordId: interaction.user.id,
        guildId: interaction.guild?.id,
      },
    };
    await log.error("Error in /teach servermemory command", error, context);

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
        log.error("Failed to send error reply in servermemory catch block", replyError, {
          ...context,
          errorType: "ErrorReplyFailed",
        });
      }
    } else {
      log.warn(
        "Interaction was not replied or deferred in servermemory catch block, cannot send error message to user.",
        context,
      );
    }
  }
}
