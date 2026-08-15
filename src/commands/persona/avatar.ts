import type {
  ChatInputCommandInteraction,
  Client,
  SlashCommandSubcommandBuilder,
  Attachment,
  APIAttachment,
  ModalSubmitInteraction,
} from "discord.js";
import { MessageFlags, EmbedBuilder, PermissionsBitField } from "discord.js";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import { replyInfoEmbed, promptWithPaginatedModal, safeSelectOptionText } from "../../utils/discord/interactionHelper";
import type { UserRow, ErrorContext, TomoriState } from "../../types/db/schema";
import type { SelectOption } from "../../types/discord/modal";
import { safeDownload, type SafeDownloadResult } from "../../utils/security/safeDownload";
import { memoryGuard, PERSONA_LIMITS, reserveAvatarQuota } from "../../utils/security/rateLimiter";
import { personaRepository } from "@/utils/db/repositories";
import { convertToPNG } from "../../utils/image/imageProcessor";
import { deletePersonaAvatarFromStorage, uploadPersonaAvatarToStorage } from "../../utils/storage/avatarStorage";
import { invalidateTomoriStateCache } from "../../utils/cache/tomoriStateCache";
import { isAvatarUpdateRateLimited } from "../../utils/discord/avatarRateLimit";

const PERSONA_SELECT_MODAL_ID = "persona_avatar_persona_modal";
const PERSONA_SELECT_ID = "persona_select";
const FILE_UPLOAD_ID = "avatar_image";

type AvatarAttachment = Attachment | APIAttachment;

export async function forkPointerForAvatarChange(
  selectedPersona: Pick<TomoriState, "persona_id" | "is_pointer">,
): Promise<boolean> {
  if (!selectedPersona.persona_id) {
    return false;
  }

  if (selectedPersona.is_pointer !== true) {
    return true;
  }

  return await personaRepository.materializeIfPointer(selectedPersona.persona_id);
}

/**
 * Configure the avatar subcommand
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("avatar").setDescription(localizer("en-US", "commands.persona.avatar.description"));

/**
 * Validates if the provided attachment is a valid image
 * @param attachment - Discord attachment to validate
 * @returns Object with isValid boolean and error message if invalid
 */
function validateImage(attachment: AvatarAttachment): {
  isValid: boolean;
  error?: string;
} {
  const contentType = "contentType" in attachment ? attachment.contentType : attachment.content_type;
  const filename = "name" in attachment ? attachment.name : attachment.filename;

  const maxSize = PERSONA_LIMITS.MAX_AVATAR_SIZE_MB * 1024 * 1024;
  if (attachment.size > maxSize) {
    return {
      isValid: false,
      error: "FILE_TOO_LARGE",
    };
  }

  const allowedTypes = ["image/png", "image/jpeg", "image/jpg", "image/gif"];
  if (!contentType || !allowedTypes.includes(contentType)) {
    return {
      isValid: false,
      error: "INVALID_FORMAT",
    };
  }

  // Discord metadata is caller-controlled, so the filename extension provides a
  // second format check before the file reaches image decoding.
  const allowedExtensions = [".png", ".jpg", ".jpeg", ".gif"];
  const fileExtension = filename?.toLowerCase().split(".").pop();
  if (!fileExtension || !allowedExtensions.includes(`.${fileExtension}`)) {
    return {
      isValid: false,
      error: "INVALID_EXTENSION",
    };
  }

  return { isValid: true };
}

/**
 * Downloads an image attachment into a buffer with timeout protection
 * @param attachment - Discord attachment to download
 * @returns Promise resolving to SafeDownloadResult-like object with buffer or error
 */
async function downloadAttachmentBuffer(attachment: AvatarAttachment): Promise<{
  success: boolean;
  buffer?: Buffer;
  error?: SafeDownloadResult["error"];
  details?: string;
}> {
  const downloadResult = await safeDownload(attachment.url, {
    maxSizeMB: PERSONA_LIMITS.MAX_AVATAR_SIZE_MB,
    timeoutMs: 15000, // 15 seconds
    knownSize: attachment.size,
  });

  if (!downloadResult.success) {
    return {
      success: false,
      error: downloadResult.error,
      details: downloadResult.details,
    };
  }

  return {
    success: true,
    buffer: downloadResult.buffer,
  };
}

/**
 * Updates the bot's guild avatar using Discord's raw API with timeout protection
 * @param guildId - Guild ID where to update the avatar
 * @param avatarDataUri - Base64 data URI of the avatar image, or null to remove
 * @returns Promise resolving to object with success status and optional error type
 */
async function updateGuildAvatar(
  guildId: string,
  avatarDataUri: string | null,
): Promise<{
  success: boolean;
  error?: "timeout" | "rate_limited" | "api_error";
  details?: string;
}> {
  // Setup timeout controller (15s)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const endpoint = `https://discord.com/api/v10/guilds/${guildId}/members/@me`;

    const payload = {
      avatar: avatarDataUri,
    };

    const response = await fetch(endpoint, {
      method: "PATCH",
      headers: {
        Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();

      // Discord throttles guild avatar changes far below its documented buckets, so this is an
      // expected outcome rather than a fault: keep it off the error sink the way every other
      // avatar PATCH site does, and tell the user to wait instead of showing them raw API JSON.
      if (isAvatarUpdateRateLimited(response.status, errorText)) {
        log.warn(`Guild avatar update rate limited for guild ${guildId}: ${response.status}`);
        return { success: false, error: "rate_limited" };
      }

      const context: ErrorContext = {
        errorType: "DiscordApiError",
        metadata: { guildId, httpStatus: response.status, body: errorText },
      };
      await log.error(`Failed to update guild avatar: ${response.status} ${response.statusText}`, undefined, context);
      return {
        success: false,
        error: "api_error",
        details: `${response.status} ${response.statusText}: ${errorText}`,
      };
    }

    return { success: true };
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === "AbortError") {
      log.warn("Discord API call timed out after 15s", {
        metadata: { guildId },
      });
      return {
        success: false,
        error: "timeout",
        details: "Discord API call timed out after 15s",
      };
    }

    await log.error("Error updating guild avatar via Discord API", error, {
      errorType: "DiscordApiError",
      metadata: { guildId },
    });
    return {
      success: false,
      error: "api_error",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Sets or removes TomoriBot's custom avatar for the current guild
 */
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

  // Require Manage Server permission (persona category is not manager-only at the loader level)
  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.persona.avatar.no_permission_title",
      descriptionKey: "commands.persona.avatar.no_permission_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let responseInteraction: ChatInputCommandInteraction | ModalSubmitInteraction = interaction;
  let selectedPersona: TomoriState | null = null;

  try {
    const allPersonas = await personaRepository.loadAllForServer(interaction.guild.id);
    const personaSelectOptions: SelectOption[] = allPersonas
      .filter((persona) => persona.persona_id !== undefined)
      .map((persona) => ({
        label: safeSelectOptionText(persona.persona_nickname),
        value: persona.persona_id?.toString() ?? "",
        description: persona.is_alter
          ? localizer(locale, "commands.persona.avatar.alter_persona_description")
          : localizer(locale, "commands.persona.avatar.main_persona_description"),
      }))
      .filter((option) => option.value !== "");
    if (personaSelectOptions.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.invalid_option_title",
        descriptionKey: "general.errors.invalid_option_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const modalResult = await promptWithPaginatedModal(interaction, locale, {
      modalCustomId: PERSONA_SELECT_MODAL_ID,
      modalTitleKey: "commands.persona.avatar.persona_modal_title",
      components: [
        {
          customId: PERSONA_SELECT_ID,
          labelKey: "commands.persona.avatar.persona_select_label",
          descriptionKey: "commands.persona.avatar.persona_select_description",
          placeholder: "commands.persona.avatar.persona_select_placeholder",
          required: true,
          options: personaSelectOptions,
        },
        {
          customId: FILE_UPLOAD_ID,
          labelKey: "commands.persona.avatar.image_label",
          descriptionKey: "commands.persona.avatar.image_description",
          minValues: 0,
          maxValues: 1,
          required: false,
        },
      ],
    });

    if (modalResult.outcome !== "submit") {
      log.info(`Persona avatar select modal ${modalResult.outcome} for user ${interaction.user.id}`);
      return;
    }

    const modalSubmitInteraction = modalResult.interaction;
    if (!modalSubmitInteraction) {
      return;
    }
    responseInteraction = modalSubmitInteraction;

    const selectedPersonaId = modalResult.values?.[PERSONA_SELECT_ID];
    selectedPersona = allPersonas.find((persona) => persona.persona_id?.toString() === selectedPersonaId) ?? null;
    if (!selectedPersona?.persona_id) {
      await replyInfoEmbed(responseInteraction, locale, {
        titleKey: "general.errors.invalid_option_title",
        descriptionKey: "general.errors.invalid_option_description",
        color: ColorCode.ERROR,
      });
      return;
    }
    const selectedPersonaDbId = selectedPersona.persona_id;

    // Defer the reply to prevent timeout during image processing
    await responseInteraction.deferReply({ flags: MessageFlags.Ephemeral });

    const memCheck = memoryGuard.checkMemory();
    if (memCheck.status === "critical") {
      await responseInteraction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "rate_limit.error_memory_critical_title"))
            .setDescription(localizer(locale, "rate_limit.error_memory_critical_description"))
            .setColor(ColorCode.ERROR),
        ],
      });
      return;
    }

    const pointerForked = await forkPointerForAvatarChange(selectedPersona);
    if (!pointerForked) {
      await replyInfoEmbed(responseInteraction, locale, {
        titleKey: "general.errors.update_failed_title",
        descriptionKey: "general.errors.update_failed_description",
        color: ColorCode.ERROR,
      });
      return;
    }
    if (selectedPersona.is_pointer === true) {
      selectedPersona = { ...selectedPersona, is_pointer: false };
    }

    // Reserve avatar quota (atomic check+increment for per-server DDoS protection)
    const quotaReserve = reserveAvatarQuota(interaction.guild.id);
    if (!quotaReserve.allowed) {
      const resetTime = quotaReserve.resetAt ? new Date(quotaReserve.resetAt).toLocaleString(locale) : "unknown";

      await responseInteraction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "rate_limit.error_quota_exceeded_title"))
            .setDescription(
              localizer(locale, "rate_limit.error_quota_exceeded_description", {
                reset_time: resetTime,
              }),
            )
            .setColor(ColorCode.ERROR),
        ],
      });
      return;
    }

    const imageAttachment = modalResult.attachments?.[FILE_UPLOAD_ID];
    const isMainPersona = !selectedPersona.is_alter;

    if (!imageAttachment) {
      if (isMainPersona) {
        const result = await updateGuildAvatar(interaction.guild.id, null);

        if (result.success) {
          // Quota already reserved at step 6 - no increment needed
          await replyInfoEmbed(responseInteraction, locale, {
            titleKey: "commands.persona.avatar.removed_title",
            descriptionKey: "commands.persona.avatar.removed_description",
            color: ColorCode.SUCCESS,
          });
        } else if (result.error === "timeout") {
          await replyInfoEmbed(responseInteraction, locale, {
            titleKey: "commands.persona.avatar.error_api_timeout",
            descriptionKey: "commands.persona.avatar.error_api_timeout",
            color: ColorCode.ERROR,
          });
        } else if (result.error === "rate_limited") {
          await replyInfoEmbed(responseInteraction, locale, {
            titleKey: "commands.persona.avatar.rate_limited_title",
            descriptionKey: "commands.persona.avatar.rate_limited_description",
            color: ColorCode.WARN,
          });
        } else {
          const baseMsg = localizer(locale, "commands.persona.avatar.api_error_description");
          await replyInfoEmbed(responseInteraction, locale, {
            titleKey: "commands.persona.avatar.api_error_title",
            description: result.details ? `${baseMsg}\n-# ${result.details}` : baseMsg,
            color: ColorCode.ERROR,
            descriptionVars: { details: result.details ?? "" },
          });
        }
      } else {
        if (selectedPersona.webhook_avatar_url) {
          await deletePersonaAvatarFromStorage(selectedPersona.webhook_avatar_url);
        }

        await personaRepository.setAvatar(selectedPersonaDbId, null);

        invalidateTomoriStateCache(interaction.guild.id);

        await replyInfoEmbed(responseInteraction, locale, {
          titleKey: "commands.persona.avatar.removed_title",
          descriptionKey: "commands.persona.avatar.removed_alter_description",
          descriptionVars: { persona_name: selectedPersona.persona_nickname },
          color: ColorCode.SUCCESS,
        });
      }
      return;
    }

    const validation = validateImage(imageAttachment);
    if (!validation.isValid) {
      let errorKey = "invalid_image_description";
      switch (validation.error) {
        case "FILE_TOO_LARGE":
          errorKey = "file_too_large_description";
          break;
        case "INVALID_FORMAT":
        case "INVALID_EXTENSION":
          errorKey = "invalid_format_description";
          break;
      }

      await replyInfoEmbed(responseInteraction, locale, {
        titleKey: "commands.persona.avatar.invalid_image_title",
        descriptionKey: `commands.persona.avatar.${errorKey}`,
        descriptionVars: { max_size: PERSONA_LIMITS.MAX_AVATAR_SIZE_MB.toString() },
        color: ColorCode.ERROR,
      });
      return;
    }

    // Download the image into a buffer with timeout protection
    const downloadResult = await downloadAttachmentBuffer(imageAttachment);
    if (!downloadResult.success) {
      let errorKey: string;
      if (downloadResult.error === "size_exceeded") {
        errorKey = "commands.persona.avatar.file_too_large_description";
      } else if (downloadResult.error === "timeout") {
        errorKey = "commands.persona.avatar.error_download_timeout";
      } else {
        errorKey = "commands.persona.avatar.conversion_error_description";
      }

      await replyInfoEmbed(responseInteraction, locale, {
        titleKey: "commands.persona.avatar.invalid_image_title",
        descriptionKey: errorKey,
        descriptionVars: { max_size: PERSONA_LIMITS.MAX_AVATAR_SIZE_MB.toString() },
        color: ColorCode.ERROR,
      });
      return;
    }

    if (isMainPersona) {
      // biome-ignore lint/style/noNonNullAssertion: Download result is checked in success condition
      const downloadedBuffer = downloadResult.buffer!;

      // Re-encode to PNG before uploading. Discord returns 200 OK for
      // structurally corrupt files (e.g. exported preset PNGs with a bad tEXt
      // chunk length) but stores an unservable asset, so the CDN 415s and clients
      // silently keep the old avatar. Re-encoding guarantees a clean PNG, same
      // as the alter path below.
      let pngBuffer: Buffer;
      try {
        pngBuffer = await convertToPNG(downloadedBuffer);
      } catch (error) {
        log.warn("Failed to convert selected main avatar image to PNG", error);
        await replyInfoEmbed(responseInteraction, locale, {
          titleKey: "commands.persona.avatar.conversion_error_title",
          descriptionKey: "commands.persona.avatar.conversion_error_description",
          color: ColorCode.ERROR,
        });
        return;
      }
      const avatarDataUri = `data:image/png;base64,${pngBuffer.toString("base64")}`;

      const updateResult = await updateGuildAvatar(interaction.guild.id, avatarDataUri);

      if (updateResult.success) {
        // Quota already reserved at step 6 - no increment needed
        await replyInfoEmbed(responseInteraction, locale, {
          titleKey: "commands.persona.avatar.success_title",
          descriptionKey: "commands.persona.avatar.success_description",
          color: ColorCode.SUCCESS,
        });
      } else if (updateResult.error === "timeout") {
        await replyInfoEmbed(responseInteraction, locale, {
          titleKey: "commands.persona.avatar.error_api_timeout",
          descriptionKey: "commands.persona.avatar.error_api_timeout",
          color: ColorCode.ERROR,
        });
      } else if (updateResult.error === "rate_limited") {
        await replyInfoEmbed(responseInteraction, locale, {
          titleKey: "commands.persona.avatar.rate_limited_title",
          descriptionKey: "commands.persona.avatar.rate_limited_description",
          color: ColorCode.WARN,
        });
      } else {
        const baseMsg = localizer(locale, "commands.persona.avatar.api_error_description");
        await replyInfoEmbed(responseInteraction, locale, {
          titleKey: "commands.persona.avatar.api_error_title",
          description: updateResult.details ? `${baseMsg}\n-# ${updateResult.details}` : baseMsg,
          color: ColorCode.ERROR,
          descriptionVars: { details: updateResult.details ?? "" },
        });
      }
    } else {
      // Alter persona path:
      // - production: upload avatar to S3 and store URL
      // - non-production: update/create persona webhooks and store permanent webhook avatar URL
      let persistedAvatarUrl: string | null = null;
      // biome-ignore lint/style/noNonNullAssertion: Download result is checked in success condition
      const downloadedBuffer = downloadResult.buffer!;
      let pngBuffer: Buffer;
      try {
        pngBuffer = await convertToPNG(downloadedBuffer);
      } catch (error) {
        log.warn("Failed to convert selected alter avatar image to PNG", error);
        await replyInfoEmbed(responseInteraction, locale, {
          titleKey: "commands.persona.avatar.conversion_error_title",
          descriptionKey: "commands.persona.avatar.conversion_error_description",
          color: ColorCode.ERROR,
        });
        return;
      }

      persistedAvatarUrl = await uploadPersonaAvatarToStorage({
        personaId: selectedPersonaDbId,
        serverDiscId: interaction.guild.id,
        label: "server avatar",
        buffer: pngBuffer,
      });

      if (!persistedAvatarUrl) {
        await replyInfoEmbed(responseInteraction, locale, {
          titleKey: "commands.persona.avatar.api_error_title",
          descriptionKey: "commands.persona.avatar.api_error_description",
          color: ColorCode.ERROR,
        });
        return;
      }

      if (persistedAvatarUrl) {
        if (selectedPersona.webhook_avatar_url && selectedPersona.webhook_avatar_url !== persistedAvatarUrl) {
          await deletePersonaAvatarFromStorage(selectedPersona.webhook_avatar_url);
        }

        await personaRepository.setAvatar(selectedPersonaDbId, persistedAvatarUrl);
      }

      invalidateTomoriStateCache(interaction.guild.id);

      await replyInfoEmbed(responseInteraction, locale, {
        titleKey: "commands.persona.avatar.success_title",
        descriptionKey: "commands.persona.avatar.success_alter_description",
        descriptionVars: { persona_name: selectedPersona.persona_nickname },
        color: ColorCode.SUCCESS,
      });
    }
  } catch (error) {
    const context: ErrorContext = {
      errorType: "CommandExecutionError",
      metadata: {
        command: "persona avatar",
        guildId: interaction.guild.id,
        personaId: selectedPersona?.persona_id ?? null,
      },
    };
    await log.error("Error in /persona avatar command", error, context);

    const errorReplyInteraction =
      responseInteraction.replied || responseInteraction.deferred
        ? responseInteraction
        : interaction.replied || interaction.deferred
          ? interaction
          : null;
    if (errorReplyInteraction) {
      await replyInfoEmbed(errorReplyInteraction, locale, {
        titleKey: "general.errors.unknown_error_title",
        descriptionKey: "general.errors.unknown_error_description",
        color: ColorCode.ERROR,
      });
    }
  }
}
