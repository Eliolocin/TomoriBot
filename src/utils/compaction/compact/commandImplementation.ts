import type { ButtonInteraction, ChatInputCommandInteraction, Client, Message, TextBasedChannel } from "discord.js";
import {
  ActionRowBuilder,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { UserRow } from "@/types/db/schema";
import type { ModalInputField, ModalRadioGroupField, ModalSelectField } from "@/types/discord/modal";
import { invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { isRagAvailable } from "@/utils/db/ragAvailability";
import { llmModelRepo, personaRepository, ragRepository } from "@/utils/db/repositories";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { promptWithRawModal, safeSelectOptionText } from "@/utils/discord/ui/modals";
import { generateEmbeddingsBatched, providerSupportsEmbeddingTaskType } from "@/utils/embeddings/embeddingProvider";
import { ColorCode, log } from "@/utils/misc/logger";
import { getMemoryLimits } from "@/utils/misc/memoryLimits";
import { getResolvedCapabilityModelId, resolveCapabilityCredentials } from "@/utils/provider/credentialResolver";
import { getEffectiveLlmModelName } from "@/utils/provider/modelDisplay";
import { providerSupportsFeature } from "@/utils/provider/providerInfoRegistry";
import { decryptApiKey } from "@/utils/security/crypto";
import { localizer } from "@/utils/text/localizer";
import { buildConversationContext } from "./historyExtraction";
import { promptForCompactOptions, promptForManualOptions } from "./modal";
import {
  COMPACT_ADD_TO_DOCS_BUTTON_ID,
  COMPACT_EDIT_BUTTON_ID,
  buildAddToDocsButtonRow,
  buildConversationEmbed,
  buildEditSummaryButtonRow,
  buildManualEmbed,
  buildRoleplayEmbeds,
  isDiscordThreadChannel,
} from "./rendering";
import { generateCompactSummary } from "./summaryGeneration";
import { buildSupplementaryContext } from "./supplementaryContext";
import type { SendableChannel } from "./types";

const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,20}$/;

export async function executeCompactCommand(
  client: Client,
  interaction: ChatInputCommandInteraction,
  _userData: UserRow,
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

  const summaryType = interaction.options.getString("type", true) as import("@/types/misc/compact").CompactSummaryMode;
  const targetChannelOption = interaction.options.getChannel("channel");
  const targetThreadId = interaction.options.getString("thread")?.trim();
  if (!(await validateDestinationOptions(interaction, locale, targetChannelOption?.id, targetThreadId))) return;

  if (summaryType === "manual") {
    await executeManualCompact(client, interaction, locale, targetChannelOption, targetThreadId);
    return;
  }

  const modalSelection = await promptForCompactOptions(interaction, locale, summaryType);
  if (!modalSelection) return;

  const serverDiscId = interaction.guild?.id ?? interaction.user.id;
  const tomoriState = await personaRepository.loadState(serverDiscId);
  if (!tomoriState) {
    await editError(
      modalSelection.submitInteraction,
      locale,
      "general.errors.tomori_not_setup_title",
      "general.errors.tomori_not_setup_description",
    );
    return;
  }

  const providerName = tomoriState.llm.llm_provider.toLowerCase();
  const effectiveModelName = getEffectiveLlmModelName(tomoriState.llm, tomoriState.config.custom_model_name);
  const encryptedApiKey = tomoriState.config.api_key;
  if (
    !(await validateProviderReadiness({
      interaction: modalSelection.submitInteraction,
      locale,
      providerName,
      providerLabel: tomoriState.llm.llm_provider,
      modelName: effectiveModelName,
      supportsStructuredOutput: tomoriState.llm.supports_structoutput,
      seesImages: tomoriState.llm.sees_images,
      wantsRoleplay: modalSelection.summaryType === "roleplay",
      wantsImages: modalSelection.analyzeImages,
      encryptedApiKey,
    }))
  ) {
    return;
  }

  if (!encryptedApiKey) {
    await editError(
      modalSelection.submitInteraction,
      locale,
      "general.errors.api_key_missing_title",
      "general.errors.api_key_missing_description",
    );
    return;
  }

  const apiKey = await decryptApiKey(encryptedApiKey, tomoriState.config.key_version || 1);
  if (!apiKey) {
    await editError(
      modalSelection.submitInteraction,
      locale,
      "general.errors.api_key_error_title",
      "general.errors.api_key_error_description",
    );
    return;
  }

  await modalSelection.submitInteraction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(localizer(locale, "commands.compact.processing_title"))
        .setDescription(localizer(locale, "commands.compact.processing_description"))
        .setColor(ColorCode.INFO),
    ],
  });

  const channel = modalSelection.submitInteraction.channel ?? interaction.channel;
  if (!channel || !("send" in channel) || typeof channel.send !== "function" || !("messages" in channel)) {
    await editError(
      modalSelection.submitInteraction,
      locale,
      "general.errors.channel_only_title",
      "general.errors.channel_only_description",
    );
    return;
  }

  const outputChannel = await resolveOutputChannel(
    client,
    interaction.guildId,
    channel as SendableChannel,
    targetChannelOption?.id,
    targetThreadId,
  );
  if (!outputChannel) {
    const titleKey = targetThreadId ? "commands.compact.thread_invalid_title" : "general.errors.channel_only_title";
    const descriptionKey = targetThreadId
      ? "commands.compact.thread_invalid_description"
      : "general.errors.channel_only_description";
    await editError(modalSelection.submitInteraction, locale, titleKey, descriptionKey);
    return;
  }

  try {
    const context = await buildConversationContext(channel as TextBasedChannel, modalSelection.analyzeImages);
    const supplementaryContext = await buildSupplementaryContext({
      serverDiscId,
      userIds: context.userIds,
      includePersonas: true,
    });
    const result = await generateCompactSummary({
      summaryType: modalSelection.summaryType,
      providerName,
      apiKey,
      model: effectiveModelName,
      endpointUrl: tomoriState.config.custom_endpoint_url ?? undefined,
      context,
      supplementaryContext,
      systemPrompt: modalSelection.systemPrompt,
      analyzeImages: modalSelection.analyzeImages,
    });

    if (result.error || !result.summary) {
      await editFailure(modalSelection.submitInteraction, locale, result.error || "Unknown error");
      return;
    }

    const COLLECTOR_DURATION_MS = 10 * 60 * 1000;
    const deadlineDate = new Date(Date.now() + COLLECTOR_DURATION_MS);
    const editDeadline = formatDeadline(deadlineDate);

    const buildEmbed = (text: string, deadline?: string) =>
      modalSelection.summaryType === "conversation"
        ? buildConversationEmbed(locale, text, modalSelection.refresh, deadline)
        : buildRoleplayEmbeds(locale, text, modalSelection.refresh, deadline)[0];

    const summaryText = String(result.summary);
    const buttonRow = buildEditSummaryButtonRow(locale);
    const summaryMessage = await outputChannel.send({
      embeds: [buildEmbed(summaryText, editDeadline)],
      components: [buttonRow],
    });
    await editSuccess(modalSelection.submitInteraction, locale, targetChannelOption?.id ?? targetThreadId);

    const collector = summaryMessage.createMessageComponentCollector({
      componentType: ComponentType.Button,
      filter: (i) => i.customId === COMPACT_EDIT_BUTTON_ID,
      time: COLLECTOR_DURATION_MS,
    });

    collector.on("collect", async (buttonInteraction) => {
      const liveMessage = await buttonInteraction.message.fetch();
      const currentText = liveMessage.embeds[0]?.description ?? "";
      const editModal = new ModalBuilder()
        .setCustomId("compact_edit_modal")
        .setTitle(localizer(locale, "commands.compact.edit_modal_title"));
      const textInput = new TextInputBuilder()
        .setCustomId("compact_edit_text")
        .setLabel(localizer(locale, "commands.compact.edit_field_label"))
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(4000)
        .setRequired(true)
        .setValue(currentText.slice(0, 4000));
      editModal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(textInput));
      await buttonInteraction.showModal(editModal);

      try {
        const submitted = await buttonInteraction.awaitModalSubmit({
          time: 600000,
          filter: (i) => i.customId === "compact_edit_modal" && i.user.id === buttonInteraction.user.id,
        });
        const newText = submitted.fields.getTextInputValue("compact_edit_text");
        await submitted.deferUpdate();
        await summaryMessage.edit({ embeds: [buildEmbed(newText, editDeadline)], components: [buttonRow] });
      } catch {}
    });

    collector.on("end", async () => {
      const liveMessage = await summaryMessage.fetch().catch(() => null);
      if (!liveMessage) return;
      const currentText = liveMessage.embeds[0]?.description ?? "";
      const addToDocsFooter = localizer(locale, "commands.compact.add_to_docs_footer");
      const updatedEmbed = buildEmbed(currentText).setFooter({ text: addToDocsFooter });
      await summaryMessage
        .edit({ embeds: [updatedEmbed], components: [buildAddToDocsButtonRow(locale)] })
        .catch(() => {});
      const serverDiscId = interaction.guild?.id ?? interaction.user.id;
      setupAddToDocsCollector({ client, summaryMessage, buildEmbed: (text) => buildEmbed(text), locale, serverDiscId });
    });
  } catch (error) {
    log.error("Compact summary command failed", error);
    await editFailure(
      modalSelection.submitInteraction,
      locale,
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}

async function validateDestinationOptions(
  interaction: ChatInputCommandInteraction,
  locale: string,
  targetChannelId?: string,
  targetThreadId?: string,
): Promise<boolean> {
  if (targetChannelId && targetThreadId) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.compact.destination_conflict_title",
      descriptionKey: "commands.compact.destination_conflict_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  if (targetThreadId && !DISCORD_SNOWFLAKE_PATTERN.test(targetThreadId)) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.compact.thread_invalid_title",
      descriptionKey: "commands.compact.thread_invalid_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  return true;
}

async function validateProviderReadiness(params: {
  interaction: { editReply: (options: { embeds: EmbedBuilder[] }) => Promise<unknown> };
  locale: string;
  providerName: string;
  providerLabel: string;
  modelName: string;
  supportsStructuredOutput: boolean;
  seesImages: boolean;
  wantsRoleplay: boolean;
  wantsImages: boolean;
  encryptedApiKey: Buffer | null | undefined;
}): Promise<boolean> {
  if (!providerSupportsFeature(params.providerName, "conversationCompaction")) {
    await editError(
      params.interaction,
      params.locale,
      "commands.compact.provider_unsupported_title",
      "commands.compact.provider_unsupported_description",
      {
        provider: params.providerLabel,
      },
    );
    return false;
  }
  if (params.wantsRoleplay && !params.supportsStructuredOutput) {
    await editError(
      params.interaction,
      params.locale,
      "commands.compact.model_incompatible_title",
      "commands.compact.model_incompatible_description",
      {
        model_name: params.modelName,
      },
    );
    return false;
  }
  if (params.wantsImages && !params.seesImages) {
    await editError(
      params.interaction,
      params.locale,
      "commands.compact.image_vision_required_title",
      "commands.compact.image_vision_required_description",
      {
        model_name: params.modelName,
      },
    );
    return false;
  }
  if (!params.encryptedApiKey) {
    await editError(
      params.interaction,
      params.locale,
      "general.errors.api_key_missing_title",
      "general.errors.api_key_missing_description",
    );
    return false;
  }
  return true;
}

async function resolveOutputChannel(
  client: Client,
  guildId: string | null,
  currentChannel: SendableChannel,
  targetChannelId?: string,
  targetThreadId?: string,
): Promise<SendableChannel | null> {
  if (targetChannelId) {
    const fetchedTarget = await client.channels.fetch(targetChannelId).catch(() => null);
    return fetchedTarget && "send" in fetchedTarget ? (fetchedTarget as SendableChannel) : null;
  }
  if (targetThreadId) {
    const fetchedTarget = await client.channels.fetch(targetThreadId).catch(() => null);
    return fetchedTarget &&
      isDiscordThreadChannel(fetchedTarget) &&
      "guildId" in fetchedTarget &&
      fetchedTarget.guildId === guildId &&
      "send" in fetchedTarget &&
      typeof fetchedTarget.send === "function"
      ? (fetchedTarget as SendableChannel)
      : null;
  }
  return currentChannel;
}

async function editError(
  interaction: { editReply: (options: { embeds: EmbedBuilder[] }) => Promise<unknown> },
  locale: string,
  titleKey: string,
  descriptionKey: string,
  descriptionVars?: Record<string, string>,
): Promise<void> {
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(localizer(locale, titleKey))
        .setDescription(localizer(locale, descriptionKey, descriptionVars))
        .setColor(ColorCode.ERROR),
    ],
  });
}

async function editFailure(
  interaction: { editReply: (options: { embeds: EmbedBuilder[] }) => Promise<unknown> },
  locale: string,
  error: string,
): Promise<void> {
  await editError(interaction, locale, "commands.compact.failed_title", "commands.compact.failed_description", {
    error,
  });
}

async function executeManualCompact(
  client: Client,
  interaction: ChatInputCommandInteraction,
  locale: string,
  targetChannelOption: ReturnType<ChatInputCommandInteraction["options"]["getChannel"]>,
  targetThreadId: string | undefined,
): Promise<void> {
  const manualSelection = await promptForManualOptions(interaction, locale);
  if (!manualSelection) return;

  const channel = manualSelection.submitInteraction.channel ?? interaction.channel;
  if (!channel || !("send" in channel) || typeof channel.send !== "function" || !("messages" in channel)) {
    await editError(
      manualSelection.submitInteraction,
      locale,
      "general.errors.channel_only_title",
      "general.errors.channel_only_description",
    );
    return;
  }

  const outputChannel = await resolveOutputChannel(
    client,
    interaction.guildId,
    channel as SendableChannel,
    targetChannelOption?.id,
    targetThreadId,
  );
  if (!outputChannel) {
    const titleKey = targetThreadId ? "commands.compact.thread_invalid_title" : "general.errors.channel_only_title";
    const descriptionKey = targetThreadId
      ? "commands.compact.thread_invalid_description"
      : "general.errors.channel_only_description";
    await editError(manualSelection.submitInteraction, locale, titleKey, descriptionKey);
    return;
  }

  try {
    const COLLECTOR_DURATION_MS = 10 * 60 * 1000;
    const editDeadline = formatDeadline(new Date(Date.now() + COLLECTOR_DURATION_MS));
    const buildEmbed = (text: string, deadline?: string) =>
      buildManualEmbed(locale, text, manualSelection.refresh, deadline);

    const buttonRow = buildEditSummaryButtonRow(locale);
    const summaryMessage = await outputChannel.send({
      embeds: [buildEmbed(manualSelection.summaryContent, editDeadline)],
      components: [buttonRow],
    });
    await editSuccess(manualSelection.submitInteraction, locale, targetChannelOption?.id ?? targetThreadId);

    const collector = summaryMessage.createMessageComponentCollector({
      componentType: ComponentType.Button,
      filter: (i) => i.customId === COMPACT_EDIT_BUTTON_ID,
      time: COLLECTOR_DURATION_MS,
    });

    collector.on("collect", async (buttonInteraction) => {
      const liveMessage = await buttonInteraction.message.fetch();
      const currentText = liveMessage.embeds[0]?.description ?? "";
      const editModal = new ModalBuilder()
        .setCustomId("compact_edit_modal")
        .setTitle(localizer(locale, "commands.compact.edit_modal_title"));
      const textInput = new TextInputBuilder()
        .setCustomId("compact_edit_text")
        .setLabel(localizer(locale, "commands.compact.edit_field_label"))
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(4000)
        .setRequired(true)
        .setValue(currentText.slice(0, 4000));
      editModal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(textInput));
      await buttonInteraction.showModal(editModal);

      try {
        const submitted = await buttonInteraction.awaitModalSubmit({
          time: 600000,
          filter: (i) => i.customId === "compact_edit_modal" && i.user.id === buttonInteraction.user.id,
        });
        const newText = submitted.fields.getTextInputValue("compact_edit_text");
        await submitted.deferUpdate();
        await summaryMessage.edit({ embeds: [buildEmbed(newText, editDeadline)], components: [buttonRow] });
      } catch {}
    });

    collector.on("end", async () => {
      const liveMessage = await summaryMessage.fetch().catch(() => null);
      if (!liveMessage) return;
      const currentText = liveMessage.embeds[0]?.description ?? "";
      const addToDocsFooter = localizer(locale, "commands.compact.add_to_docs_footer");
      const updatedEmbed = buildEmbed(currentText).setFooter({ text: addToDocsFooter });
      await summaryMessage
        .edit({ embeds: [updatedEmbed], components: [buildAddToDocsButtonRow(locale)] })
        .catch(() => {});
      const serverDiscId = interaction.guild?.id ?? interaction.user.id;
      setupAddToDocsCollector({ client, summaryMessage, buildEmbed: (text) => buildEmbed(text), locale, serverDiscId });
    });
  } catch (error) {
    log.error("Manual compact command failed", error);
    await editFailure(
      manualSelection.submitInteraction,
      locale,
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}

function setupAddToDocsCollector(params: {
  client: Client;
  summaryMessage: Message;
  buildEmbed: (text: string) => EmbedBuilder;
  locale: string;
  serverDiscId: string;
}): void {
  const { client, summaryMessage, buildEmbed, locale, serverDiscId } = params;

  const NAME_FIELD_ID = "compact_doc_name";
  const SCOPE_FIELD_ID = "compact_doc_scope";
  const PERSONA_FIELD_ID = "compact_doc_persona";
  const CHANNELS_FIELD_ID = "compact_doc_channels";

  const docsCollector = summaryMessage.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i) => i.customId === COMPACT_ADD_TO_DOCS_BUTTON_ID,
    max: 1,
  });

  docsCollector.on("collect", async (buttonInteraction: ButtonInteraction) => {
    const allPersonas = await personaRepository.loadAllForServer(serverDiscId);

    const today = new Date().toISOString().slice(0, 10);
    const autoName = localizer(locale, "commands.compact.add_to_docs_doc_name", { date: today });

    const personaOptions = allPersonas
      .filter((p) => p.persona_id !== undefined)
      .map((p) => ({
        label: safeSelectOptionText(p.persona_nickname),
        value: p.persona_id?.toString() ?? "",
        description: p.is_alter
          ? localizer(locale, "commands.teach.document.alter_persona_description")
          : localizer(locale, "commands.teach.document.main_persona_description"),
      }))
      .filter((o) => o.value !== "");

    const modalResult = await promptWithRawModal(buttonInteraction, locale, {
      modalCustomId: "compact_save_as_doc_modal",
      modalTitleKey: "commands.compact.save_as_doc_modal_title",
      components: [
        {
          customId: NAME_FIELD_ID,
          labelKey: "commands.compact.save_as_doc_name_label",
          descriptionKey: "commands.compact.save_as_doc_name_description",
          value: autoName,
          maxLength: 64,
          required: true,
        } as ModalInputField,
        {
          kind: "radioGroup",
          customId: SCOPE_FIELD_ID,
          labelKey: "commands.compact.save_as_doc_scope_label",
          options: [
            {
              value: "serverwide",
              label: localizer(locale, "commands.compact.save_as_doc_scope_serverwide"),
              default: true,
            },
            {
              value: "persona",
              label: localizer(locale, "commands.compact.save_as_doc_scope_persona"),
            },
          ],
          required: true,
        } as ModalRadioGroupField,
        ...(personaOptions.length > 0
          ? [
              {
                customId: PERSONA_FIELD_ID,
                labelKey: "commands.compact.save_as_doc_persona_label",
                descriptionKey: "commands.compact.save_as_doc_persona_description",
                placeholder: "commands.compact.save_as_doc_persona_placeholder",
                options: personaOptions,
                required: false,
              } as ModalSelectField,
            ]
          : []),
        {
          customId: CHANNELS_FIELD_ID,
          labelKey: "commands.compact.save_as_doc_channels_label",
          descriptionKey: "commands.compact.save_as_doc_channels_description",
          required: false,
        } as ModalInputField,
      ],
    });

    if (modalResult.outcome !== "submit" || !modalResult.interaction) return;

    const submitInteraction = modalResult.interaction;
    await submitInteraction.deferReply({ flags: MessageFlags.Ephemeral });

    const docName = (modalResult.values?.[NAME_FIELD_ID] ?? autoName).trim().slice(0, 64) || autoName;
    const scope = modalResult.values?.[SCOPE_FIELD_ID] === "persona" ? "persona" : "serverwide";
    const selectedPersonaIdStr = modalResult.values?.[PERSONA_FIELD_ID];
    const channelsInput = modalResult.values?.[CHANNELS_FIELD_ID];

    const channelTags: string[] = channelsInput
      ? channelsInput
          .split(",")
          .map((raw) => {
            const s = raw.trim();
            const mention = s.match(/^<#(\d+)>$/);
            if (mention) {
              const resolved = client.channels.cache.get(mention[1]);
              return "name" in (resolved ?? {}) ? (resolved as { name: string }).name.toLowerCase() : "";
            }
            return s.toLowerCase().replace(/^#+/, "");
          })
          .filter((c) => c.length > 0 && /^[\w-]+$/.test(c))
          .map((c) => `#${c}`)
      : [];

    let targetPersonaId: number | null = null;
    if (scope === "persona") {
      const selectedPersona = allPersonas.find((p) => p.persona_id?.toString() === selectedPersonaIdStr);
      if (!selectedPersona?.persona_id) {
        await replyInfoEmbed(submitInteraction, locale, {
          titleKey: "commands.compact.add_to_docs_no_persona_title",
          descriptionKey: "commands.compact.add_to_docs_no_persona_description",
          color: ColorCode.ERROR,
        });
        return;
      }
      targetPersonaId = selectedPersona.persona_id;
    }

    if (!isRagAvailable()) {
      await replyInfoEmbed(submitInteraction, locale, {
        titleKey: "commands.compact.add_to_docs_rag_unavailable_title",
        descriptionKey: "commands.compact.add_to_docs_rag_unavailable_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const tomoriState = await personaRepository.loadState(serverDiscId);
    if (!tomoriState) {
      await replyInfoEmbed(submitInteraction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const hasManagePermission = buttonInteraction.memberPermissions?.has("ManageGuild") ?? false;
    if (!tomoriState.config.server_memteaching_enabled && !hasManagePermission) {
      await replyInfoEmbed(submitInteraction, locale, {
        titleKey: "commands.compact.add_to_docs_no_permission_title",
        descriptionKey: "commands.compact.add_to_docs_no_permission_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const embeddingCreds = await resolveCapabilityCredentials(tomoriState.server_id, "embedding", {
      userId: null,
    }).catch(() => null);
    if (!embeddingCreds) {
      await replyInfoEmbed(submitInteraction, locale, {
        titleKey: "commands.compact.add_to_docs_no_embedding_title",
        descriptionKey: "commands.compact.add_to_docs_no_embedding_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const embeddingModelId =
      getResolvedCapabilityModelId(embeddingCreds, "embedding") ?? tomoriState.config.embedding_model_id;
    const embeddingModel = embeddingModelId ? await llmModelRepo.loadEmbeddingModelById(embeddingModelId) : null;
    if (!embeddingModel?.embedding_model_id) {
      await replyInfoEmbed(submitInteraction, locale, {
        titleKey: "commands.compact.add_to_docs_no_embedding_title",
        descriptionKey: "commands.compact.add_to_docs_no_embedding_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const liveMessage = await summaryMessage.fetch().catch(() => null);
    const summaryText = liveMessage?.embeds[0]?.description ?? "";
    if (!summaryText) {
      await replyInfoEmbed(submitInteraction, locale, {
        titleKey: "commands.compact.add_to_docs_error_title",
        descriptionKey: "commands.compact.add_to_docs_error_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    try {
      const memLimits = getMemoryLimits();
      const normalized = ragRepository.normalizeText(summaryText);
      const chunks = ragRepository.chunkText(normalized, memLimits.documentChunkSize, memLimits.documentChunkOverlap);

      if (chunks.length === 0) {
        await replyInfoEmbed(submitInteraction, locale, {
          titleKey: "commands.compact.add_to_docs_error_title",
          descriptionKey: "commands.compact.add_to_docs_error_description",
          color: ColorCode.ERROR,
        });
        return;
      }

      const embeddings = await generateEmbeddingsBatched({
        provider: embeddingModel.provider,
        apiKey: embeddingCreds.apiKey,
        model: embeddingModel.codename,
        modelId: embeddingModel.embedding_model_id,
        inputs: chunks,
        taskType: (await providerSupportsEmbeddingTaskType(embeddingModel.provider)) ? "RETRIEVAL_DOCUMENT" : undefined,
        batchSize: 16,
      });

      await ragRepository.insertWithChunks({
        serverId: tomoriState.server_id,
        personaId: targetPersonaId,
        uploaderUserId: null,
        documentName: docName,
        fileName: null,
        mimeType: "text/plain",
        fileSizeBytes: normalized.length,
        textContent: normalized,
        chunks,
        embeddings,
        embeddingModelId: embeddingModel.embedding_model_id,
        embeddingFamily: embeddingModel.model_family,
        sourceType: "history",
        channelTags,
      });

      invalidateTomoriStateCache(serverDiscId);

      const storedFooter = localizer(locale, "commands.compact.add_to_docs_stored_footer");
      const finalEmbed = buildEmbed(summaryText).setFooter({ text: storedFooter });
      await summaryMessage.edit({ embeds: [finalEmbed], components: [] }).catch(() => {});

      await replyInfoEmbed(submitInteraction, locale, {
        titleKey: "commands.compact.add_to_docs_success_title",
        descriptionKey: "commands.compact.add_to_docs_success_description",
        descriptionVars: { name: docName },
        color: ColorCode.SUCCESS,
      });
    } catch (error) {
      log.error("Failed to save compact summary to document store", error);
      await replyInfoEmbed(submitInteraction, locale, {
        titleKey: "commands.compact.add_to_docs_error_title",
        descriptionKey: "commands.compact.add_to_docs_error_description",
        color: ColorCode.ERROR,
      });
    }
  });
}

function formatDeadline(date: Date): string {
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mo = String(date.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = String(date.getUTCFullYear());
  return `${hh}:${mm} ${dd}/${mo}/${yyyy}`;
}

async function editSuccess(
  interaction: { editReply: (options: { embeds: EmbedBuilder[] }) => Promise<unknown> },
  locale: string,
  targetDestinationId?: string,
): Promise<void> {
  const successDescription = targetDestinationId
    ? localizer(locale, "commands.compact.success_description_redirect", { channel: `<#${targetDestinationId}>` })
    : localizer(locale, "commands.compact.success_description");

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(localizer(locale, "commands.compact.success_title"))
        .setDescription(successDescription)
        .setColor(ColorCode.SUCCESS),
    ],
  });
}
