/**
 * Preset Create Command
 * Manual personality creation with simple form fields
 */

import type {
  ChatInputCommandInteraction,
  Client,
  InteractionEditReplyOptions,
  ModalSubmitInteraction,
  SlashCommandSubcommandBuilder,
} from "discord.js";
import { AttachmentBuilder, MessageFlags, EmbedBuilder } from "discord.js";
import { TextInputStyle } from "discord.js";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import { replyInfoEmbed, promptWithRawModal } from "../../utils/discord/interactionHelper";
import {
  buildPersonaResultContainer,
  replyComponentsV2Status,
  type PersonaResultContainerOptions,
} from "@/utils/discord/ui/statusComponents";
import { attachImportNowCollector, importNowButton } from "@/utils/persona/importNowButton";
import { validateAndFallbackPanelPayload } from "@/utils/discord/ui/interactionCore";
import type { UserRow } from "../../types/db/schema";
import { memoryGuard, PERSONA_LIMITS, reservePersonaQuota } from "../../utils/security/rateLimiter";
import { getMemoryLimits, validateAttribute, validateSampleDialogue } from "@/utils/misc/memoryLimits";
import { safeDownload } from "../../utils/security/safeDownload";
import { getServerAvatar } from "../../utils/image/avatarHelper";
import { centerCropToSquare } from "../../utils/image/imageProcessor";
import { embedMetadataInPNG } from "../../utils/image/pngMetadata";
import {
  buildPrivateAttributePublicFlags,
  presetExportDataSchema,
  PRESET_EXPORT_VERSION,
} from "../../types/preset/presetExport";
import { sanitizeAttachmentFilenamePart } from "@/utils/discord/attachmentFilename";
import { dedupeTriggerWords } from "@/utils/text/triggerWords";
import type { PresetExport, PresetExportData } from "../../types/preset/presetExport";
import type { ModalComponent } from "../../types/discord/modal";

const memoryLimits = getMemoryLimits();

const MODAL_CUSTOM_ID = "preset_create_modal";
const CHARACTER_NAME_ID = "character_name";
const CHARACTER_DESC_ID = "character_desc";
const EXAMPLE_USER_ID = "example_user";
const EXAMPLE_BOT_ID = "example_bot";
const FILE_UPLOAD_ID = "avatar_image";

function parsePersonaNameInput(input: string): string[] {
  return dedupeTriggerWords(input.split(/[,\u3001]/), { lowercase: false });
}

function buildCreateResultPayload(
  options: PersonaResultContainerOptions,
  attachment: AttachmentBuilder,
): InteractionEditReplyOptions {
  return validateAndFallbackPanelPayload(
    {
      components: buildPersonaResultContainer(options),
      files: [attachment],
      flags: MessageFlags.IsComponentsV2,
    },
    options.locale,
  );
}

/**
 * Configure the 'create' subcommand
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("create").setDescription(localizer("en-US", "commands.persona.create.description"));

/**
 * Executes the 'create' command
 * Manual personality creation with simple form input
 *
 */
export async function execute(
  client: Client,
  interaction: ChatInputCommandInteraction,
  _userData: UserRow,
  locale: string,
): Promise<void> {
  let replyInteraction: ChatInputCommandInteraction | ModalSubmitInteraction = interaction;
  let replyUsesComponentsV2 = false;

  try {
    // Check if command is run in a guild (server-only command)
    if (!interaction.guild) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.guild_only_title",
        descriptionKey: "general.errors.guild_only_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const modalComponents: ModalComponent[] = [
      {
        customId: CHARACTER_NAME_ID,
        labelKey: "commands.persona.create.modal.character_name_label",
        descriptionKey: "commands.persona.create.modal.character_name_description",
        placeholder: "commands.persona.create.modal.character_name_placeholder",
        required: true,
        style: TextInputStyle.Short,
        maxLength: 100,
      },
      {
        customId: CHARACTER_DESC_ID,
        labelKey: "commands.persona.create.modal.character_desc_label",
        placeholder: "commands.persona.create.modal.character_desc_placeholder",
        required: true,
        style: TextInputStyle.Paragraph,
        maxLength: memoryLimits.maxAttributeLength, // Use runtime config limit (default: 2000)
      },
      {
        customId: EXAMPLE_USER_ID,
        labelKey: "commands.persona.create.modal.example_user_label",
        descriptionKey: "commands.persona.create.modal.example_user_description",
        placeholder: "commands.persona.create.modal.example_user_placeholder",
        required: false,
        style: TextInputStyle.Paragraph,
        maxLength: memoryLimits.maxSampleDialogueLength, // Use runtime config limit (default: 2000)
      },
      {
        customId: EXAMPLE_BOT_ID,
        labelKey: "commands.persona.create.modal.example_bot_label",
        placeholder: "commands.persona.create.modal.example_bot_placeholder",
        required: false,
        style: TextInputStyle.Paragraph,
        maxLength: memoryLimits.maxSampleDialogueLength, // Use runtime config limit (default: 2000)
      },
      {
        customId: FILE_UPLOAD_ID,
        labelKey: "commands.persona.create.modal.file_upload_label",
        descriptionKey: "commands.persona.create.modal.file_upload_description",
        minValues: 0,
        maxValues: 1,
        required: false,
      },
    ];

    const modalResult = await promptWithRawModal(
      interaction,
      locale,
      {
        modalCustomId: MODAL_CUSTOM_ID,
        modalTitleKey: "commands.persona.create.modal.title",
        components: modalComponents,
      },
      true, // Auto-defer with public reply
    );

    if (modalResult.outcome !== "submit") {
      log.info(`Create modal ${modalResult.outcome}`);
      return;
    }

    const modalSubmitInteraction = modalResult.interaction;
    replyInteraction = modalSubmitInteraction ?? interaction;
    const characterNameInput = modalResult.values?.[CHARACTER_NAME_ID];
    const characterDesc = modalResult.values?.[CHARACTER_DESC_ID];
    const exampleUser = modalResult.values?.[EXAMPLE_USER_ID];
    const exampleBot = modalResult.values?.[EXAMPLE_BOT_ID];

    if (!modalSubmitInteraction || !characterNameInput || !characterDesc) {
      log.error("Modal result unexpectedly missing required values");
      return;
    }

    const parsedNames = parsePersonaNameInput(characterNameInput);
    if (parsedNames.length === 0) {
      log.error("Character name input did not contain any valid name values");
      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "general.errors.unknown_error_title",
        descriptionKey: "general.errors.unknown_error_description",
        color: ColorCode.ERROR,
      });
      return;
    }
    const characterName = parsedNames[0];

    // Validate content lengths (server-side validation, modal maxLength can be bypassed)
    const descValidation = validateAttribute(characterDesc);
    if (!descValidation.isValid) {
      await modalSubmitInteraction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "commands.persona.create.desc_too_long_title"))
            .setDescription(
              localizer(locale, "commands.persona.create.desc_too_long_description", {
                current_length: characterDesc.length.toString(),
                max_allowed: (descValidation.maxAllowed || memoryLimits.maxAttributeLength).toString(),
              }),
            )
            .setColor(ColorCode.ERROR),
        ],
      });
      return;
    }

    if (exampleUser) {
      const userDialogueValidation = validateSampleDialogue(exampleUser);
      if (!userDialogueValidation.isValid) {
        await modalSubmitInteraction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle(localizer(locale, "commands.persona.create.example_user_too_long_title"))
              .setDescription(
                localizer(locale, "commands.persona.create.example_user_too_long_description", {
                  current_length: exampleUser.length.toString(),
                  max_allowed: (userDialogueValidation.maxAllowed || memoryLimits.maxSampleDialogueLength).toString(),
                }),
              )
              .setColor(ColorCode.ERROR),
          ],
        });
        return;
      }
    }

    if (exampleBot) {
      const botDialogueValidation = validateSampleDialogue(exampleBot);
      if (!botDialogueValidation.isValid) {
        await modalSubmitInteraction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle(localizer(locale, "commands.persona.create.example_bot_too_long_title"))
              .setDescription(
                localizer(locale, "commands.persona.create.example_bot_too_long_description", {
                  current_length: exampleBot.length.toString(),
                  max_allowed: (botDialogueValidation.maxAllowed || memoryLimits.maxSampleDialogueLength).toString(),
                }),
              )
              .setColor(ColorCode.ERROR),
          ],
        });
        return;
      }
    }

    // Reserve persona operation quota (atomic check+increment for DDoS protection)
    const quotaReserve = reservePersonaQuota(interaction.user.id);
    if (!quotaReserve.allowed) {
      const resetTime = quotaReserve.resetAt ? new Date(quotaReserve.resetAt).toLocaleString(locale) : "unknown";

      await modalSubmitInteraction.editReply({
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
    let imageBuffer: Buffer | undefined;

    if (imageAttachment) {
      const memCheck = memoryGuard.checkMemory();
      if (memCheck.status === "critical") {
        // Preserve modal inputs for user convenience
        const embed = new EmbedBuilder()
          .setTitle(localizer(locale, "rate_limit.error_memory_critical_title"))
          .setDescription(localizer(locale, "rate_limit.error_memory_critical_description"))
          .setColor(ColorCode.ERROR);

        const memoryErrorFields = [
          {
            name: localizer(locale, "commands.persona.create.field_character_name"),
            value: characterNameInput.substring(0, 1024) || "N/A",
            inline: false,
          },
          {
            name: localizer(locale, "commands.persona.create.field_character_desc"),
            value: characterDesc.substring(0, 1024) || "N/A",
            inline: false,
          },
        ];

        if (exampleUser) {
          memoryErrorFields.push({
            name: localizer(locale, "commands.persona.create.field_example_user"),
            value: exampleUser.substring(0, 1024) || "N/A",
            inline: false,
          });
        }
        if (exampleBot) {
          memoryErrorFields.push({
            name: localizer(locale, "commands.persona.create.field_example_bot"),
            value: exampleBot.substring(0, 1024) || "N/A",
            inline: false,
          });
        }

        embed.addFields(memoryErrorFields);

        await modalSubmitInteraction.editReply({
          embeds: [embed],
        });
        return;
      }

      if (!imageAttachment.content_type?.startsWith("image/")) {
        await modalSubmitInteraction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle(localizer(locale, "commands.persona.create.invalid_image_title"))
              .setDescription(localizer(locale, "commands.persona.create.invalid_image_description"))
              .setColor(ColorCode.ERROR),
          ],
        });
        return;
      }

      const downloadResult = await safeDownload(imageAttachment.url, {
        maxSizeMB: PERSONA_LIMITS.MAX_AVATAR_SIZE_MB,
        timeoutMs: 10000,
        knownSize: imageAttachment.size,
      });

      if (!downloadResult.success) {
        let errorKey: string;
        if (downloadResult.error === "size_exceeded") {
          errorKey = "commands.persona.create.error_file_too_large";
        } else if (downloadResult.error === "timeout") {
          errorKey = "commands.persona.create.error_download_timeout";
        } else {
          errorKey = "commands.persona.create.error_download_failed";
        }

        await modalSubmitInteraction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle(
                localizer(locale, errorKey, {
                  max_size: PERSONA_LIMITS.MAX_AVATAR_SIZE_MB.toString(),
                }),
              )
              .setColor(ColorCode.ERROR),
          ],
        });
        return;
      }

      imageBuffer = downloadResult.buffer;
      log.info("Image attachment downloaded successfully");
    }

    const hasSampleDialogue = exampleUser?.trim() && exampleBot?.trim();

    const presetData: PresetExportData = {
      tomori_nickname: characterName,
      attribute_list: [characterDesc],
      attribute_public_flags: buildPrivateAttributePublicFlags([characterDesc]),
      // biome-ignore lint/style/noNonNullAssertion: Both or neither has to exist
      sample_dialogues_in: hasSampleDialogue ? [exampleUser!] : [],
      // biome-ignore lint/style/noNonNullAssertion: Both or neither has to exist
      sample_dialogues_out: hasSampleDialogue ? [exampleBot!] : [],
      trigger_words: parsedNames,
    };

    const validationResult = presetExportDataSchema.safeParse(presetData);
    if (!validationResult.success) {
      log.error("Created preset failed validation:");
      log.error("Validation errors:", JSON.stringify(validationResult.error.format(), null, 2));
      log.error("Preset data:", JSON.stringify(presetData, null, 2));

      const errorDetails = validationResult.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("\n");

      await modalSubmitInteraction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "commands.persona.create.validation_failed_title"))
            .setDescription(
              `${localizer(
                locale,
                "commands.persona.create.validation_failed_description",
              )}\n\n**Details:**\n\`\`\`\n${errorDetails.substring(0, 500)}\n\`\`\``,
            )
            .setColor(ColorCode.ERROR),
        ],
      });
      return;
    }

    log.success("Created preset passed validation");

    // Get image for export (uploaded image or server avatar)
    let pngBuffer: Buffer;

    if (imageBuffer) {
      try {
        pngBuffer = await centerCropToSquare(imageBuffer);
        log.info("Uploaded image cropped to 1:1 square");
      } catch (error) {
        log.error("Failed to process uploaded image:", error);
        await modalSubmitInteraction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle(localizer(locale, "commands.persona.create.image_processing_failed_title"))
              .setDescription(localizer(locale, "commands.persona.create.image_processing_failed_description"))
              .setColor(ColorCode.ERROR),
          ],
        });
        return;
      }
    } else {
      // Use server avatar
      try {
        const avatarBuffer = await getServerAvatar(interaction.guild, client);
        pngBuffer = await centerCropToSquare(avatarBuffer);
        log.info("Server avatar cropped to 1:1 square");
      } catch (error) {
        log.error("Failed to get server avatar:", error);
        await modalSubmitInteraction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle(localizer(locale, "commands.persona.create.avatar_fetch_failed_title"))
              .setDescription(localizer(locale, "commands.persona.create.avatar_fetch_failed_description"))
              .setColor(ColorCode.ERROR),
          ],
        });
        return;
      }
    }

    const presetExport: PresetExport = {
      version: PRESET_EXPORT_VERSION,
      type: "preset",
      exported_at: new Date().toISOString(),
      data: presetData,
    };

    let finalPngBuffer: Buffer;
    try {
      finalPngBuffer = await embedMetadataInPNG(pngBuffer, presetExport);
      log.success("Metadata embedded in PNG");
    } catch (error) {
      log.error("Failed to embed metadata in PNG:", error);
      await modalSubmitInteraction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "commands.persona.create.metadata_embed_failed_title"))
            .setDescription(localizer(locale, "commands.persona.create.metadata_embed_failed_description"))
            .setColor(ColorCode.ERROR),
        ],
      });
      return;
    }

    const sanitizedNickname = sanitizeAttachmentFilenamePart(characterName, {
      fallback: "persona",
      maxLength: 50,
    });
    const timestamp = Date.now();
    const filename = `tomori-preset-${sanitizedNickname}-${timestamp}.png`;
    const attachment = new AttachmentBuilder(finalPngBuffer, {
      name: filename,
    });

    // Detect DM context (create is guild-only, so this stays false) and
    //     assemble the Components V2 result container.
    const isDM = !interaction.guild;

    const descriptionPreview = characterDesc.length > 200 ? `${characterDesc.substring(0, 200)}...` : characterDesc;

    const sections: NonNullable<PersonaResultContainerOptions["sections"]> = [];
    if (hasSampleDialogue && exampleUser && exampleBot) {
      const userPreview = exampleUser.length > 100 ? `${exampleUser.substring(0, 100)}...` : exampleUser;
      const botPreview = exampleBot.length > 100 ? `${exampleBot.substring(0, 100)}...` : exampleBot;
      sections.push({
        titleKey: "commands.persona.create.success_dialogue_title",
        body: `**User:** ${userPreview}\n**Bot:** ${botPreview}`,
      });
    }
    // Create is guild-only, so the Import Now button is always present: the
    // next-steps copy references both the right-aligned PNG and the button.
    // Next Steps is the last section, so the avatar thumbnail attaches here and
    // the Import Now button lands tightly beneath it.
    sections.push({
      titleKey: "commands.persona.create.success_next_steps_title",
      bodyKey: "commands.persona.create.success_next_steps_description",
    });

    const successContainerOptions: Omit<PersonaResultContainerOptions, "button"> = {
      locale,
      color: isDM ? ColorCode.WARN : ColorCode.SUCCESS,
      titleKey: "commands.persona.create.success_title",
      titleVars: { character_name: characterName },
      descriptionKey: "commands.persona.create.success_description",
      descriptionVars: {
        character_name: characterName,
        character_description: descriptionPreview,
      },
      imageAttachmentName: filename,
      layout: "thumbnail-section",
      sections,
      buttonAlignment: "right",
      trailingNoteKey: "commands.persona.create.success_next_steps_footer",
      ...(isDM ? { footerKey: "commands.persona.create.avatar_update_skipped_dm" } : {}),
    };

    // Send the result. Create is guild-only, so attach the manager-only
    //     "Import Now" button to import the new persona as an alter in place.
    if (!interaction.guild) {
      await modalSubmitInteraction.editReply(buildCreateResultPayload(successContainerOptions, attachment));
      replyUsesComponentsV2 = true;
    } else {
      await modalSubmitInteraction.editReply(
        buildCreateResultPayload(
          {
            ...successContainerOptions,
            button: importNowButton("active"),
          },
          attachment,
        ),
      );
      replyUsesComponentsV2 = true;

      const sentMessage = await modalSubmitInteraction.fetchReply();
      attachImportNowCollector({
        message: sentMessage,
        client,
        guild: interaction.guild,
        serverDiscId: interaction.guild.id,
        locale,
        presetData,
        avatarImageBuffer: finalPngBuffer,
        containerOptions: successContainerOptions,
        sourceInteraction: modalSubmitInteraction,
      });
    }

    // Quota already reserved at step 5 - no increment needed
    log.success(`Preset created successfully for: ${characterName}`);
  } catch (error) {
    log.error("Error in preset create command:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    try {
      const errorEmbed = new EmbedBuilder()
        .setTitle(localizer(locale, "general.errors.unexpected_title"))
        .setDescription(
          localizer(locale, "general.errors.unexpected_description", {
            error: errorMessage,
          }),
        )
        .setColor(ColorCode.ERROR);

      if (replyUsesComponentsV2 && (replyInteraction.deferred || replyInteraction.replied)) {
        await replyComponentsV2Status(
          replyInteraction,
          locale,
          "general.errors.unexpected_title",
          "general.errors.unexpected_description",
          ColorCode.ERROR,
          { error: errorMessage },
        );
      } else if (replyInteraction.deferred || replyInteraction.replied) {
        await replyInteraction.editReply({ embeds: [errorEmbed] });
      } else {
        await replyInteraction.reply({
          embeds: [errorEmbed],
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch {
      log.error("Failed to send error embed");
    }
  }
}
