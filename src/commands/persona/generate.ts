/**
 * Preset Generate Command
 * AI-powered personality generation using supported structured output providers
 */

import type {
  ChatInputCommandInteraction,
  Client,
  ComponentInContainerData,
  ContainerComponentData,
  InteractionEditReplyOptions,
  ModalSubmitInteraction,
  SlashCommandSubcommandBuilder,
  TopLevelComponentData,
} from "discord.js";
import { AttachmentBuilder, ComponentType, MessageFlags, EmbedBuilder } from "discord.js";
import { TextInputStyle } from "discord.js";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import { replyInfoEmbed, promptWithRawModal } from "../../utils/discord/interactionHelper";
import { buildPersonaResultContainer, type PersonaResultContainerOptions } from "@/utils/discord/ui/statusComponents";
import { attachImportNowCollector, importNowButton } from "@/utils/persona/importNowButton";
import { validateAndFallbackPanelPayload } from "@/utils/discord/ui/interactionCore";
import type { UserRow } from "../../types/db/schema";
import { personaRepository } from "@/utils/db/repositories";
import { decryptApiKey } from "../../utils/security/crypto";
import { memoryGuard, PERSONA_LIMITS, reservePersonaQuota } from "../../utils/security/rateLimiter";
import { safeDownload } from "../../utils/security/safeDownload";
import type { GeneratePresetParams } from "../../providers/google/presetGenerator";
import { getServerAvatar } from "../../utils/image/avatarHelper";
import { centerCropToSquare } from "../../utils/image/imageProcessor";
import {
  extractMetadataFromPNG,
  extractSillyTavernMetadataFromPNG,
  embedMetadataInPNG,
} from "../../utils/image/pngMetadata";
import { presetRepository } from "@/utils/db/repositories/PresetRepository";
import {
  buildGeneratedPresetAttributePublicFlags,
  presetExportDataSchema,
  PRESET_EXPORT_VERSION,
} from "../../types/preset/presetExport";
import { sanitizeAttachmentFilenamePart } from "@/utils/discord/attachmentFilename";
import { CONFIRMATION_PREVIEW_BUDGET } from "@/utils/text/textPreview";
import { dedupeTriggerWords } from "@/utils/text/triggerWords";
import type { PresetExport } from "../../types/preset/presetExport";
import type { ModalComponent } from "../../types/discord/modal";
import type { ToolContext } from "../../types/tool/interfaces";
import { generatePresetForProvider } from "@/providers/utils/providerFeatureExecutors";
import { providerSupportsFeature } from "@/utils/provider/providerInfoRegistry";
import { getEffectiveLlmModelName } from "@/utils/provider/modelDisplay";
import { applyPersonalProviderSelectionsToTomoriState } from "@/utils/provider/personalProviderRuntime";

const MODAL_CUSTOM_ID = "preset_generate_modal";
const CHARACTER_NAME_ID = "character_name";
const CHARACTER_INFO_ID = "character_info"; // Combined description and speech examples
const WEB_SEARCH_ID = "web_search";
const ADDITIONAL_INST_ID = "additional_inst";
const FILE_UPLOAD_ID = "avatar_image";
const GENERATION_INPUT_ATTACHMENT_NAME = "preset_generation_input.txt";

function parsePersonaNameInput(input: string): string[] {
  return dedupeTriggerWords(input.split(/[,\u3001]/), { lowercase: false });
}

/**
 * Configure the 'generate' subcommand
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("generate").setDescription(localizer("en-US", "commands.persona.generate.description"));

/**
 * Format sample dialogues for preview display
 * @param dialoguesIn - Array of user input dialogues
 * @param dialoguesOut - Array of bot response dialogues
 * @param maxExamples - Maximum number of examples to show (default: 3)
 * @param maxLength - Maximum length per dialogue snippet (default: 100)
 * @returns Formatted dialogue preview string
 */
function formatDialoguePreview(
  dialoguesIn: string[],
  dialoguesOut: string[],
  maxExamples = 3,
  maxLength = 100,
): string {
  const numDialogues = Math.min(dialoguesIn.length, dialoguesOut.length, maxExamples);

  const previews: string[] = [];
  for (let i = 0; i < numDialogues; i++) {
    const userInput = dialoguesIn[i].substring(0, maxLength);
    const botResponse = dialoguesOut[i].substring(0, maxLength);

    const userText = dialoguesIn[i].length > maxLength ? `${userInput}...` : userInput;
    const botText = dialoguesOut[i].length > maxLength ? `${botResponse}...` : botResponse;

    previews.push(`**User:** ${userText}\n**Bot:** ${botText}`);
  }

  return previews.join("\n\n");
}

function buildGenerationInputAttachment(params: {
  characterName: string;
  characterInfo: string;
  webSearch: string;
  additionalInstructions?: string;
  imageFilename?: string;
  imageMimeType?: string;
}): AttachmentBuilder {
  const lines = [
    "Preset Generation Inputs",
    "",
    `Character Name: ${params.characterName}`,
    `Web Search: ${params.webSearch}`,
    "",
    "Character Info:",
    params.characterInfo,
    "",
    "Additional Instructions:",
    params.additionalInstructions?.trim() || "(none)",
  ];

  if (params.imageFilename || params.imageMimeType) {
    lines.push("", "Image Attachment:", params.imageFilename || "(unnamed)");
    if (params.imageMimeType) {
      lines.push(`Image MIME Type: ${params.imageMimeType}`);
    }
  }

  return new AttachmentBuilder(Buffer.from(lines.join("\n"), "utf8"), {
    name: GENERATION_INPUT_ATTACHMENT_NAME,
  });
}

function resolveComponentsV2AccentColor(color: string | number): number {
  if (typeof color === "number") {
    return color;
  }

  const normalized = color.trim().replace("#", "");
  return /^[0-9a-fA-F]{6}$/.test(normalized)
    ? Number.parseInt(normalized, 16)
    : Number.parseInt(ColorCode.INFO.replace("#", ""), 16);
}

function buildGenerateStatusComponents(options: {
  locale: string;
  titleKey: string;
  descriptionKey: string;
  color: string | number;
  descriptionVars?: Record<string, string | number | boolean>;
  details?: string;
  showInputAttachment?: boolean;
}): TopLevelComponentData[] {
  const components: ComponentInContainerData[] = [
    {
      type: ComponentType.TextDisplay,
      content: `## ${localizer(options.locale, options.titleKey)}`,
    },
    {
      type: ComponentType.TextDisplay,
      content: localizer(options.locale, options.descriptionKey, options.descriptionVars),
    },
  ];

  if (options.details) {
    components.push({
      type: ComponentType.TextDisplay,
      content: options.details,
    });
  }

  if (options.showInputAttachment) {
    components.push(
      { type: ComponentType.Separator, divider: true, spacing: 1 },
      {
        type: ComponentType.File,
        file: { url: `attachment://${GENERATION_INPUT_ATTACHMENT_NAME}` },
      },
    );
  }

  const container: ContainerComponentData<ComponentInContainerData> = {
    type: ComponentType.Container,
    accentColor: resolveComponentsV2AccentColor(options.color),
    components,
  };

  return [container];
}

function buildGenerateResultPayload(
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

async function editGenerateStatusReply(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
  options: {
    locale: string;
    titleKey: string;
    descriptionKey: string;
    color: string | number;
    descriptionVars?: Record<string, string | number | boolean>;
    details?: string;
    inputAttachment?: AttachmentBuilder;
  },
): Promise<void> {
  await interaction.editReply(
    validateAndFallbackPanelPayload(
      {
        components: buildGenerateStatusComponents({
          locale: options.locale,
          titleKey: options.titleKey,
          descriptionKey: options.descriptionKey,
          color: options.color,
          descriptionVars: options.descriptionVars,
          details: options.details,
          showInputAttachment: Boolean(options.inputAttachment),
        }),
        ...(options.inputAttachment ? { files: [options.inputAttachment] } : {}),
        flags: MessageFlags.IsComponentsV2,
      },
      options.locale,
    ),
  );
}

type ToolContextChannel = ToolContext["channel"];

function isToolContextChannel(channel: unknown): channel is ToolContextChannel {
  if (!channel || typeof channel !== "object") return false;
  const maybeChannel = channel as { partial?: boolean; send?: unknown };
  if (maybeChannel.partial) return false;
  return typeof maybeChannel.send === "function";
}

/**
 * Executes the 'generate' command
 * AI-powered personality generation using structured output providers
 *
 */
export async function execute(
  client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  let replyInteraction: ChatInputCommandInteraction | ModalSubmitInteraction = interaction;
  let replyUsesComponentsV2 = false;

  try {
    // Load Tomori state to check provider (works for both guilds and DMs)
    const serverDiscId = interaction.guild?.id ?? interaction.user.id;
    const baseTomoriState = await personaRepository.loadState(serverDiscId);
    if (!baseTomoriState) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Overlay the invoking user's personal (BYOK) provider selections onto the
    //    server state. This mirrors every other AI-generation command (e.g.
    //    /generate image, /memories) and ensures generation uses the
    //    user's personal text provider when configured, instead of always falling
    //    back to the server's configured model.
    const { tomoriState } = await applyPersonalProviderSelectionsToTomoriState(
      baseTomoriState,
      userData.user_id ?? null,
    );

    const providerName = tomoriState.llm.llm_provider.toLowerCase();
    const effectiveModelName = getEffectiveLlmModelName(tomoriState.llm, tomoriState.config.custom_model_name);

    if (!providerSupportsFeature(providerName, "presetGeneration")) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.persona.generate.wrong_provider_title",
        descriptionKey: "commands.persona.generate.wrong_provider_description",
        descriptionVars: {
          current_provider: tomoriState.llm.llm_provider,
        },
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Only check for structured output before modal (always required)
    // Image vision and tools will be validated after modal based on user selections
    if (!tomoriState.llm.supports_structoutput) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.persona.generate.model_incompatible_title",
        descriptionKey: "commands.persona.generate.model_incompatible_description",
        descriptionVars: {
          model_name: effectiveModelName,
        },
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!tomoriState.config.api_key) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.persona.generate.no_api_key_title",
        descriptionKey: "commands.persona.generate.no_api_key_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const keyVersion = tomoriState.config.key_version || 1; // Default to V1 for backward compatibility
    const decryptedApiKey = await decryptApiKey(tomoriState.config.api_key, keyVersion);
    if (!decryptedApiKey) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.persona.generate.api_key_decrypt_failed_title",
        descriptionKey: "commands.persona.generate.api_key_decrypt_failed_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const modalComponents: ModalComponent[] = [
      {
        customId: CHARACTER_NAME_ID,
        labelKey: "commands.persona.generate.modal.character_name_label",
        descriptionKey: "commands.persona.generate.modal.character_name_description",
        placeholder: "commands.persona.generate.modal.character_name_placeholder",
        required: true,
        style: TextInputStyle.Short,
        maxLength: 100,
      },
      {
        customId: CHARACTER_INFO_ID,
        labelKey: "commands.persona.generate.modal.character_info_label",
        descriptionKey: "commands.persona.generate.modal.character_info_description",
        placeholder: "commands.persona.generate.modal.character_info_placeholder",
        required: true,
        style: TextInputStyle.Paragraph,
        maxLength: 2000, // Increased to accommodate both description and speech examples
      },
      {
        customId: WEB_SEARCH_ID,
        labelKey: "commands.persona.generate.modal.web_search_label",
        descriptionKey: "commands.persona.generate.modal.web_search_description",
        placeholder: "commands.persona.generate.modal.web_search_placeholder",
        required: true,
        options: [
          {
            label: localizer(locale, "commands.persona.generate.modal.web_search_yes"),
            value: "yes",
          },
          {
            label: localizer(locale, "commands.persona.generate.modal.web_search_no"),
            value: "no",
          },
        ],
      },
      {
        customId: ADDITIONAL_INST_ID,
        labelKey: "commands.persona.generate.modal.additional_inst_label",
        placeholder: "commands.persona.generate.modal.additional_inst_placeholder",
        required: false,
        style: TextInputStyle.Paragraph,
        maxLength: 500,
      },
      {
        customId: FILE_UPLOAD_ID,
        labelKey: "commands.persona.generate.modal.file_upload_label",
        descriptionKey: "commands.persona.generate.modal.file_upload_description",
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
        modalTitleKey: "commands.persona.generate.modal.title",
        components: modalComponents,
      },
      true, // Auto-defer with public reply
    );

    if (modalResult.outcome !== "submit") {
      log.info(`Generate modal ${modalResult.outcome}`);
      return;
    }

    const modalSubmitInteraction = modalResult.interaction;
    replyInteraction = modalSubmitInteraction ?? interaction;
    const characterNameInput = modalResult.values?.[CHARACTER_NAME_ID];
    const characterInfo = modalResult.values?.[CHARACTER_INFO_ID];
    const webSearch = modalResult.values?.[WEB_SEARCH_ID];
    const additionalInst = modalResult.values?.[ADDITIONAL_INST_ID];

    if (!modalSubmitInteraction || !characterNameInput || !characterInfo || !webSearch) {
      log.error("Modal result unexpectedly missing values");
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

    const imageAttachment = modalResult.attachments?.[FILE_UPLOAD_ID];
    let imageBase64: string | undefined;
    let imageMimeType: string | undefined;
    let imageBuffer: Buffer | undefined;
    let extractedPresetContext: string | undefined;

    const getInputAttachment = () =>
      buildGenerationInputAttachment({
        characterName: characterNameInput,
        characterInfo,
        webSearch,
        additionalInstructions: additionalInst,
        imageFilename: imageAttachment?.filename,
        imageMimeType: imageMimeType ?? imageAttachment?.content_type,
      });

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
        files: [getInputAttachment()],
      });
      return;
    }

    // Split combined character info into description and speech examples
    // Users are expected to use natural formatting (newlines or clear sections)
    // We'll pass the full info as description and let the AI parse it intelligently
    const characterDesc = characterInfo;
    const speechExamples = characterInfo; // AI will extract speech patterns from context

    // Effective generation context: may be overridden to use vision_llm when the primary
    // model lacks vision support but a dedicated vision model is configured
    let generationTomoriState = tomoriState;
    let generationProviderName = providerName;

    if (imageAttachment) {
      const memCheck = memoryGuard.checkMemory();
      if (memCheck.status === "critical") {
        // Preserve modal inputs for user convenience
        const embed = new EmbedBuilder()
          .setTitle(localizer(locale, "rate_limit.error_memory_critical_title"))
          .setDescription(localizer(locale, "rate_limit.error_memory_critical_description"))
          .setColor(ColorCode.ERROR);

        embed.addFields(
          {
            name: localizer(locale, "commands.persona.generate.field_character_name"),
            value: characterNameInput.substring(0, 1024) || "N/A",
            inline: false,
          },
          {
            name: localizer(locale, "commands.persona.generate.field_character_info"),
            value: characterInfo.substring(0, 1024) || "N/A",
            inline: false,
          },
          {
            name: localizer(locale, "commands.persona.generate.field_web_search"),
            value: webSearch.substring(0, 1024) || "N/A",
            inline: false,
          },
          {
            name: localizer(locale, "commands.persona.generate.field_additional_inst"),
            value: additionalInst?.substring(0, 1024) || "N/A",
            inline: false,
          },
        );

        await modalSubmitInteraction.editReply({
          embeds: [embed],
          files: [getInputAttachment()],
        });
        return;
      }

      if (!imageAttachment.content_type?.startsWith("image/")) {
        await modalSubmitInteraction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle(localizer(locale, "commands.persona.generate.invalid_image_title"))
              .setDescription(localizer(locale, "commands.persona.generate.invalid_image_description"))
              .setColor(ColorCode.ERROR),
          ],
          files: [getInputAttachment()],
        });
        return;
      }

      // Download once with safeDownload
      const downloadResult = await safeDownload(imageAttachment.url, {
        maxSizeMB: PERSONA_LIMITS.MAX_AVATAR_SIZE_MB,
        timeoutMs: 10000,
        knownSize: imageAttachment.size,
      });

      if (!downloadResult.success) {
        let errorKey: string;
        if (downloadResult.error === "size_exceeded") {
          errorKey = "commands.persona.generate.error_file_too_large";
        } else if (downloadResult.error === "timeout") {
          errorKey = "commands.persona.generate.error_download_timeout";
        } else {
          errorKey = "commands.persona.generate.error_download_failed";
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
          files: [getInputAttachment()],
        });
        return;
      }

      // Store buffer for later reuse (image processing) and convert to base64 (AI generation)
      // Buffer is guaranteed to exist when success is true
      if (!downloadResult.buffer) {
        await modalSubmitInteraction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle(localizer(locale, "commands.persona.generate.error_download_failed"))
              .setColor(ColorCode.ERROR),
          ],
          files: [getInputAttachment()],
        });
        return;
      }

      imageBuffer = downloadResult.buffer;
      imageBase64 = imageBuffer.toString("base64");
      imageMimeType = imageAttachment.content_type || "image/png";
      log.info("Image attachment downloaded and converted to base64");

      // Attempt to extract existing card/preset data from the uploaded image
      // This enables "transform/tweak" workflows where users upload a card
      // and ask the AI to modify it (e.g., "make it more conversational")

      const tomoriPreset = extractMetadataFromPNG(imageBuffer);
      if (tomoriPreset?.data) {
        extractedPresetContext = JSON.stringify(tomoriPreset.data);
        log.info("Extracted Tomori preset data from uploaded image");
      }

      if (!extractedPresetContext) {
        const stMetadata = extractSillyTavernMetadataFromPNG(imageBuffer);
        if (stMetadata) {
          const conversionResult = presetRepository.convertSillyTavernMetadataToPresetData(stMetadata);
          if (conversionResult.success) {
            extractedPresetContext = JSON.stringify(conversionResult.data);
            log.info("Extracted SillyTavern card data from uploaded image");
          }
        }
      }

      // If card/preset data was extracted, vision is optional because the data serves as text context
      if (!tomoriState.llm.sees_images) {
        const visionLlm = tomoriState.vision_llm;

        if (!visionLlm?.sees_images) {
          // Neither the primary model nor the vision model supports vision
          if (extractedPresetContext) {
            // Card data was found, so proceed without vision, using extracted data instead
            log.info(
              "No vision support available, but card/preset data was extracted from image. Proceeding with text-only context.",
            );
            imageBase64 = undefined;
            imageMimeType = undefined;
          } else {
            // No card data and no vision, so cannot process the image at all
            await modalSubmitInteraction.editReply({
              embeds: [
                new EmbedBuilder()
                  .setTitle(localizer(locale, "commands.persona.generate.image_vision_required_title"))
                  .setDescription(
                    localizer(locale, "commands.persona.generate.image_vision_required_description", {
                      model_name: effectiveModelName,
                    }),
                  )
                  .setColor(ColorCode.ERROR),
              ],
              files: [getInputAttachment()],
            });
            return;
          }
        } else {
          const visionProviderName = visionLlm.llm_provider.toLowerCase();
          if (!providerSupportsFeature(visionProviderName, "presetGeneration")) {
            // Vision model is set but its provider cannot perform preset generation
            if (extractedPresetContext) {
              // Fall back to text-only with extracted card data
              log.info(
                "Vision model provider unsupported for preset generation, but card/preset data was extracted. Proceeding with text-only context.",
              );
              imageBase64 = undefined;
              imageMimeType = undefined;
            } else {
              await modalSubmitInteraction.editReply({
                embeds: [
                  new EmbedBuilder()
                    .setTitle(localizer(locale, "commands.persona.generate.vision_model_provider_unsupported_title"))
                    .setDescription(
                      localizer(locale, "commands.persona.generate.vision_model_provider_unsupported_description", {
                        vision_model_name: visionLlm.llm_codename,
                        vision_provider: visionLlm.llm_provider,
                      }),
                    )
                    .setColor(ColorCode.ERROR),
                ],
                files: [getInputAttachment()],
              });
              return;
            }
          } else {
            // Delegate preset generation to the vision model so the image can be analyzed
            log.info(
              `Primary model lacks vision; delegating preset generation to vision model ${visionLlm.llm_codename} (${visionLlm.llm_provider})`,
            );
            generationTomoriState = { ...tomoriState, llm: visionLlm };
            generationProviderName = visionProviderName;
          }
        }
      }
    }

    const webSearchRequested = webSearch.trim().toLowerCase() === "yes";
    const useWebSearch = webSearchRequested && tomoriState.config.web_search_enabled;

    if (webSearchRequested && !tomoriState.config.web_search_enabled) {
      log.info("Web search requested but disabled by server configuration; proceeding without search.");
    }
    if (webSearchRequested && tomoriState.config.web_search_enabled && !tomoriState.llm.has_tools) {
      await modalSubmitInteraction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "commands.persona.generate.web_search_tools_required_title"))
            .setDescription(
              localizer(locale, "commands.persona.generate.web_search_tools_required_description", {
                model_name: effectiveModelName,
              }),
            )
            .setColor(ColorCode.ERROR),
        ],
        files: [getInputAttachment()],
      });
      return;
    }

    await editGenerateStatusReply(modalSubmitInteraction, {
      locale,
      titleKey: "commands.persona.generate.processing_title",
      descriptionKey: "commands.persona.generate.processing_description",
      color: ColorCode.INFO,
    });
    replyUsesComponentsV2 = true;

    const genParams: GeneratePresetParams = {
      characterName,
      characterDescription: characterDesc,
      speechExamples,
      additionalInstructions: additionalInst,
      imageBase64,
      imageMimeType,
      useWebSearch,
      existingPresetContext: extractedPresetContext,
    };

    let presetToolContext: ToolContext | undefined;
    const toolChannel = modalSubmitInteraction.channel ?? interaction.channel;
    if (useWebSearch && isToolContextChannel(toolChannel)) {
      presetToolContext = {
        channel: toolChannel,
        client,
        tomoriState: generationTomoriState,
        locale,
        provider: generationProviderName,
        userId: interaction.user.id,
        guildId: interaction.guild?.id,
        suppressProgressNotices: true, // Search runs in background during generation; don't leak tool embeds into chat
      };
    } else if (useWebSearch) {
      log.warn("Preset generation web search skipped: no channel context available.");
    }

    log.info(`Generating preset data with ${generationTomoriState.llm.llm_provider}...`);

    const genResult = await generatePresetForProvider({
      providerName: generationProviderName,
      apiKey: decryptedApiKey,
      tomoriState: generationTomoriState,
      params: genParams,
      locale,
      toolContext: presetToolContext,
    });

    if (genResult.error || !genResult.preset) {
      await editGenerateStatusReply(modalSubmitInteraction, {
        locale,
        titleKey: "commands.persona.generate.generation_failed_title",
        descriptionKey: "commands.persona.generate.generation_failed_description",
        descriptionVars: {
          error: genResult.error || "Unknown error",
        },
        color: ColorCode.ERROR,
        inputAttachment: getInputAttachment(),
      });
      return;
    }

    genResult.preset.tomori_nickname = characterName;
    genResult.preset.trigger_words = parsedNames;
    if (Array.isArray(genResult.preset.attribute_list)) {
      genResult.preset.attribute_public_flags = buildGeneratedPresetAttributePublicFlags(
        genResult.preset.attribute_list,
      );
    }

    const validationResult = presetExportDataSchema.safeParse(genResult.preset);
    if (!validationResult.success) {
      log.error("Generated preset failed validation:");
      log.error("Validation errors:", JSON.stringify(validationResult.error.format(), null, 2));
      log.error("Generated preset data:", JSON.stringify(genResult.preset, null, 2));

      const errorDetails = validationResult.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("\n");

      await editGenerateStatusReply(modalSubmitInteraction, {
        locale,
        titleKey: "commands.persona.generate.validation_failed_title",
        descriptionKey: "commands.persona.generate.validation_failed_description",
        details: `**Details:**\n\`\`\`\n${errorDetails.substring(0, 500)}\n\`\`\``,
        color: ColorCode.ERROR,
        inputAttachment: getInputAttachment(),
      });
      return;
    }

    log.success("Generated preset passed validation");

    // Get image for export (uploaded image or server avatar)
    let pngBuffer: Buffer;

    if (imageBuffer) {
      // Use uploaded image (already downloaded earlier, reuse buffer)
      try {
        pngBuffer = await centerCropToSquare(imageBuffer);
        log.info("Uploaded image cropped to 1:1 square (reused buffer)");
      } catch (error) {
        log.error("Failed to process uploaded image:", error);
        await editGenerateStatusReply(modalSubmitInteraction, {
          locale,
          titleKey: "commands.persona.generate.image_processing_failed_title",
          descriptionKey: "commands.persona.generate.image_processing_failed_description",
          color: ColorCode.ERROR,
          inputAttachment: getInputAttachment(),
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
        await editGenerateStatusReply(modalSubmitInteraction, {
          locale,
          titleKey: "commands.persona.generate.avatar_fetch_failed_title",
          descriptionKey: "commands.persona.generate.avatar_fetch_failed_description",
          color: ColorCode.ERROR,
          inputAttachment: getInputAttachment(),
        });
        return;
      }
    }

    const presetExport: PresetExport = {
      version: PRESET_EXPORT_VERSION,
      type: "preset",
      exported_at: new Date().toISOString(),
      data: genResult.preset,
    };

    let finalPngBuffer: Buffer;
    try {
      finalPngBuffer = await embedMetadataInPNG(pngBuffer, presetExport);
      log.success("Metadata embedded in PNG");
    } catch (error) {
      log.error("Failed to embed metadata in PNG:", error);
      await editGenerateStatusReply(modalSubmitInteraction, {
        locale,
        titleKey: "commands.persona.generate.metadata_embed_failed_title",
        descriptionKey: "commands.persona.generate.metadata_embed_failed_description",
        color: ColorCode.ERROR,
        inputAttachment: getInputAttachment(),
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

    const isDM = !interaction.guild;

    // Format attribute preview (first attribute). The ellipsis is conditional:
    // it previously appended unconditionally, claiming truncation that had not
    // happened for any attribute under the preview width.
    const firstAttribute = genResult.preset.attribute_list[0];
    const attributePreview = firstAttribute
      ? firstAttribute.length > CONFIRMATION_PREVIEW_BUDGET
        ? `${firstAttribute.substring(0, CONFIRMATION_PREVIEW_BUDGET)}...`
        : firstAttribute
      : "No attributes generated";

    // Format dialogue preview (up to 3 examples, 100 chars each)
    const dialoguePreview = formatDialoguePreview(
      genResult.preset.sample_dialogues_in,
      genResult.preset.sample_dialogues_out,
      3,
      100,
    );

    // Build the Components V2 result container (title, hero image, description,
    // next-steps block, plus a DM footer when avatar updates are skipped). The
    // accent color encodes the same SUCCESS/WARN signal the old embed used.
    const successContainerOptions: Omit<PersonaResultContainerOptions, "button"> = {
      locale,
      color: isDM ? ColorCode.WARN : ColorCode.SUCCESS,
      titleKey: "commands.persona.generate.success_title",
      titleVars: { character_name: characterName },
      descriptionKey: "commands.persona.generate.success_description",
      descriptionVars: {
        character_name: characterName,
        attribute_preview: attributePreview,
        dialogue_preview: dialoguePreview,
      },
      imageAttachmentName: filename,
      // Guilds get the picker-style thumbnail+button; DMs (no button) keep the hero image.
      layout: isDM ? "image-top" : "thumbnail-section",
      // Next Steps is the last section, so in guilds the avatar thumbnail attaches
      // here and the Import Now button sits tightly beneath it.
      sections: [
        {
          titleKey: "commands.persona.generate.success_next_steps_title",
          // Guild copy matches /persona create (right-aligned PNG + Import button);
          // DMs have no button/thumbnail, so use the DM-safe variant.
          bodyKey: isDM
            ? "commands.persona.generate.success_next_steps_description_dm"
            : "commands.persona.generate.success_next_steps_description",
        },
      ],
      buttonAlignment: "right",
      trailingNoteKey: "commands.persona.generate.success_next_steps_footer",
      ...(isDM ? { footerKey: "commands.persona.generate.avatar_update_skipped_dm" } : {}),
    };

    // Send the result. In guilds, attach an "Import Now" button (manager-only)
    //     so the persona can be imported as an alter without re-uploading the PNG.
    //     Alter import is guild-only, so DMs get the container without the button.
    if (isDM || !interaction.guild) {
      await modalSubmitInteraction.editReply(buildGenerateResultPayload(successContainerOptions, attachment));
    } else {
      await modalSubmitInteraction.editReply(
        buildGenerateResultPayload(
          {
            ...successContainerOptions,
            button: importNowButton("active"),
          },
          attachment,
        ),
      );

      const sentMessage = await modalSubmitInteraction.fetchReply();
      attachImportNowCollector({
        message: sentMessage,
        client,
        guild: interaction.guild,
        serverDiscId,
        locale,
        presetData: validationResult.data,
        avatarImageBuffer: finalPngBuffer,
        containerOptions: successContainerOptions,
        sourceInteraction: modalSubmitInteraction,
      });
    }

    // Quota already reserved at step 8 - no increment needed
    log.success(`Preset generated successfully for: ${characterName}`);
  } catch (error) {
    log.error("Error in preset generate command:", error);
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
        await editGenerateStatusReply(replyInteraction, {
          locale,
          titleKey: "general.errors.unexpected_title",
          descriptionKey: "general.errors.unexpected_description",
          descriptionVars: {
            error: errorMessage,
          },
          color: ColorCode.ERROR,
        });
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
