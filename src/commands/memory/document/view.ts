/**
 * /memory document view: Browse a stored document chunk-by-chunk with edit/delete.
 *
 * Scopes:
 * - persona:    Documents scoped to a specific persona (persona picker shown first)
 * - serverwide: Documents with persona_id IS NULL
 *
 * Flow: scope → [persona picker] → document select → chunk view, all on one anchor
 * ephemeral Components V2 message. Edit/Delete buttons appear only for users with Manage
 * Server. Editing channel tags from a per-chunk modal updates the parent document
 * (channel_tags is document-scoped, not chunk-scoped).
 */

import {
  ButtonStyle,
  ComponentType,
  escapeMarkdown,
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
import { isRagAvailable } from "@/utils/db/ragAvailability";
import { localizer } from "@/utils/text/localizer";
import { log, ColorCode } from "@/utils/misc/logger";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import {
  beginAnchorPrivateWorkflow,
  buildPersonaWorkflowNotice,
  completePersonaWorkflow,
  PERSONA_WORKFLOW_COMPONENT_TIMEOUT_MS,
  runPersonaPickerWorkflow,
  type AnchorPrivateWorkflowPhase,
  type PersonaWorkflowComponentsV2Payload,
  type PersonaWorkflowModalResult,
  type PersonaWorkflowSelectionPhase,
} from "@/utils/discord/ui/personaWorkflow";
import { personaIdIsEligible } from "@/utils/discord/ui/personaEligibility";
import { getCachedTomoriState, invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { llmModelRepo, personaRepository, serverMemoryRepository } from "@/utils/db/repositories";
import { formatVector, rebuildDocumentTextContent } from "@/utils/documents/documentService";
import { generateEmbeddingsBatched, providerSupportsEmbeddingTaskType } from "@/utils/embeddings/embeddingProvider";
import {
  CredentialUnavailableError,
  getResolvedCapabilityModelId,
  PersonalProviderRequiredError,
  resolveCapabilityCredentials,
} from "@/utils/provider/credentialResolver";
import { applyPersonalProviderSelectionsToTomoriState } from "@/utils/provider/personalProviderRuntime";
import type { SelectOption } from "@/types/discord/modal";
import type { ErrorContext, TomoriState, UserRow } from "@/types/db/schema";

const MODAL_CUSTOM_ID = "view_document_modal";
const DOCUMENT_SELECT_ID = "document_view_select";
const EDIT_MODAL_ID = "view_document_edit_modal";
const EDIT_CONTENT_FIELD_ID = "edit_chunk_content";
const EDIT_TAGS_FIELD_ID = "edit_chunk_channel_tags";
const BTN_PREV = "doc_view_prev";
const BTN_NEXT = "doc_view_next";
const BTN_CLOSE = "doc_view_close";
const BTN_EDIT = "doc_view_edit";
const BTN_DELETE = "doc_view_delete";
const BTN_CONFIRM_DELETE = "doc_view_confirm_delete";
const BTN_CANCEL_DELETE = "doc_view_cancel_delete";
const CHUNK_CONTENT_MAX = 4000;
const EDIT_CONTENT_INPUT_MAX = 4000;
const EDIT_TAGS_INPUT_MAX = 200;

type DocumentScope = "persona" | "serverwide";
type NavMode = "normal" | "confirm_delete";
type DocumentWorkflowPhase = Pick<AnchorPrivateWorkflowPhase, "phaseId" | "message" | "useButton">;

interface ChunkRow {
  document_chunk_id: number;
  chunk_index: number;
  content: string;
}

/**
 * Chunks longer than the Discord modal Paragraph input cap can't safely round-trip
 * through the edit flow, so the prefill would be truncated and an unchanged submit
 * would overwrite the chunk with the truncated prefix. Callers gate the Edit
 * button and footer hint on this.
 */
function isChunkTooLongToEdit(chunk: ChunkRow | undefined): boolean {
  return (chunk?.content.length ?? 0) > EDIT_CONTENT_INPUT_MAX;
}

interface InlineNotice {
  titleKey: string;
  descriptionKey: string;
  descriptionVars?: Record<string, string | number>;
}

function buildChunkViewPayload(
  chunks: ChunkRow[],
  index: number,
  documentName: string,
  locale: string,
  canEdit: boolean,
  options: { controls?: boolean; notice?: InlineNotice } = {},
): PersonaWorkflowComponentsV2Payload {
  const raw = chunks[index]?.content ?? "";
  const truncated = raw.length > CHUNK_CONTENT_MAX;
  const display = truncated ? `${raw.substring(0, CHUNK_CONTENT_MAX - 1)}…` : raw;
  const components: ComponentInContainerData[] = [
    {
      type: ComponentType.TextDisplay,
      content: `### ${escapeMarkdown(documentName).slice(0, 250)}`,
    },
    {
      type: ComponentType.TextDisplay,
      content: display || "​",
    },
  ];

  const footerParts: string[] = [];
  if (chunks.length > 1) {
    footerParts.push(
      localizer(locale, "commands.memory.document.view.chunk_footer", {
        current: String(index + 1),
        total: String(chunks.length),
      }),
    );
  }
  if (canEdit && isChunkTooLongToEdit(chunks[index])) {
    footerParts.push(localizer(locale, "commands.memory.document.view.chunk_too_long_to_edit"));
  }
  if (footerParts.length > 0) {
    components.push({
      type: ComponentType.TextDisplay,
      content: `-# ${footerParts.join(" · ")}`,
    });
  }

  if (options.notice) {
    components.push(
      { type: ComponentType.Separator, divider: true, spacing: 1 },
      {
        type: ComponentType.TextDisplay,
        content: `### ${localizer(locale, options.notice.titleKey)}`,
      },
      {
        type: ComponentType.TextDisplay,
        content: localizer(locale, options.notice.descriptionKey, options.notice.descriptionVars),
      },
    );
  }

  if (options.controls !== false) {
    const buttons: ButtonComponentData[] = [];
    if (chunks.length > 1) {
      buttons.push(
        {
          type: ComponentType.Button,
          customId: BTN_PREV,
          label: localizer(locale, "commands.memory.document.view.btn_prev"),
          style: ButtonStyle.Primary,
          disabled: index === 0,
        },
        {
          type: ComponentType.Button,
          customId: BTN_NEXT,
          label: localizer(locale, "commands.memory.document.view.btn_next"),
          style: ButtonStyle.Primary,
          disabled: index === chunks.length - 1,
        },
      );
    }
    if (canEdit) {
      buttons.push(
        {
          type: ComponentType.Button,
          customId: BTN_EDIT,
          label: localizer(locale, "commands.memory.document.view.btn_edit"),
          style: ButtonStyle.Secondary,
          disabled: isChunkTooLongToEdit(chunks[index]),
        },
        {
          type: ComponentType.Button,
          customId: BTN_DELETE,
          label: localizer(locale, "commands.memory.document.view.btn_delete"),
          style: ButtonStyle.Danger,
        },
      );
    }
    buttons.push({
      type: ComponentType.Button,
      customId: BTN_CLOSE,
      label: localizer(locale, "commands.memory.document.view.btn_close"),
      style: ButtonStyle.Secondary,
    });
    components.push({
      type: ComponentType.ActionRow,
      components: buttons,
    } satisfies ActionRowData<ButtonComponentData>);
  }

  const container: ContainerComponentData<ComponentInContainerData> = {
    type: ComponentType.Container,
    accentColor: Number.parseInt(ColorCode.INFO.replace("#", ""), 16),
    components,
  };
  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };
}

function buildDeleteConfirmPayload(
  chunks: ChunkRow[],
  index: number,
  documentName: string,
  locale: string,
): PersonaWorkflowComponentsV2Payload {
  const isLast = chunks.length === 1;
  const titleKey = isLast
    ? "commands.memory.document.view.delete_last_confirm_title"
    : "commands.memory.document.view.delete_confirm_title";
  const descriptionKey = isLast
    ? "commands.memory.document.view.delete_last_confirm_description"
    : "commands.memory.document.view.delete_confirm_description";
  const container: ContainerComponentData<ComponentInContainerData> = {
    type: ComponentType.Container,
    accentColor: Number.parseInt(ColorCode.WARN.replace("#", ""), 16),
    components: [
      { type: ComponentType.TextDisplay, content: `### ${localizer(locale, titleKey)}` },
      {
        type: ComponentType.TextDisplay,
        content: localizer(locale, descriptionKey, {
          current: String(index + 1),
          total: String(chunks.length),
          document_name: documentName,
        }),
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            customId: BTN_CONFIRM_DELETE,
            label: localizer(locale, "commands.memory.document.view.btn_confirm_delete"),
            style: ButtonStyle.Danger,
          },
          {
            type: ComponentType.Button,
            customId: BTN_CANCEL_DELETE,
            label: localizer(locale, "commands.memory.document.view.btn_cancel"),
            style: ButtonStyle.Secondary,
          },
        ],
      } satisfies ActionRowData<ButtonComponentData>,
    ],
  };
  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };
}

/**
 * Parses comma-separated channel input into normalized #channel tags, mirroring
 * the logic in /memory document add and /memory history import so tags stay
 * consistent across commands.
 */
function parseChannelTagsInput(input: string, client: Client): string[] {
  if (!input.trim()) return [];
  return input
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
    .map((c) => `#${c}`);
}

function tagArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}

/** Outcomes from the embedding regeneration helper, surfaced as locale keys to the caller. */
type RegenError = { ok: false; errorKey: "no_embedding_model" | "embedding_creds_missing" | "embedding_error" };
type RegenSuccess = {
  ok: true;
  embeddingVector: string;
  embeddingModelId: number;
  embeddingFamily: string;
};
type RegenResult = RegenSuccess | RegenError;

/**
 * Resolves credentials + embedding model and generates a single embedding for the
 * edited chunk content. Uses the user's current embedding capability rather than
 * the chunk's original model; switching models mid-document is the user's call.
 */
async function regenChunkEmbedding(params: {
  content: string;
  serverId: number;
  configuredEmbeddingModelId: number | null;
  userId: number | null;
}): Promise<RegenResult> {
  const { content, serverId, configuredEmbeddingModelId, userId } = params;

  let creds: Awaited<ReturnType<typeof resolveCapabilityCredentials>>;
  try {
    creds = await resolveCapabilityCredentials(serverId, "embedding", { userId });
  } catch (error) {
    if (error instanceof PersonalProviderRequiredError || error instanceof CredentialUnavailableError) {
      return { ok: false, errorKey: "embedding_creds_missing" };
    }
    throw error;
  }

  const modelId = getResolvedCapabilityModelId(creds, "embedding") ?? configuredEmbeddingModelId;
  if (!modelId) {
    return { ok: false, errorKey: "no_embedding_model" };
  }

  const model = await llmModelRepo.loadEmbeddingModelById(modelId);
  if (!model?.embedding_model_id) {
    return { ok: false, errorKey: "no_embedding_model" };
  }

  try {
    const embeddings = await generateEmbeddingsBatched({
      provider: model.provider,
      apiKey: creds.apiKey,
      model: model.codename,
      modelId: model.embedding_model_id,
      inputs: [content],
      taskType: (await providerSupportsEmbeddingTaskType(model.provider)) ? "RETRIEVAL_DOCUMENT" : undefined,
      batchSize: 1,
    });
    if (embeddings.length === 0) {
      return { ok: false, errorKey: "embedding_error" };
    }
    return {
      ok: true,
      embeddingVector: formatVector(embeddings[0]),
      embeddingModelId: model.embedding_model_id,
      embeddingFamily: model.model_family,
    };
  } catch (error) {
    log.warn(`Failed to regenerate embedding during chunk edit: ${error}`);
    return { ok: false, errorKey: "embedding_error" };
  }
}

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("view")
    .setDescription(localizer("en-US", "commands.memory.document.view.description"))
    .addStringOption((option) =>
      option
        .setName("scope")
        .setDescription(localizer("en-US", "commands.memory.document.view.scope_description"))
        .setRequired(false)
        .addChoices(
          {
            name: localizer("en-US", "commands.memory.document.view.scope_choice_persona"),
            value: "persona",
          },
          {
            name: localizer("en-US", "commands.memory.document.view.scope_choice_serverwide"),
            value: "serverwide",
          },
        ),
    );

type DocumentRow = Awaited<ReturnType<typeof serverMemoryRepository.loadDocuments>>[number];

function buildDocumentSelectModal(documents: readonly DocumentRow[]): {
  modalCustomId: string;
  modalTitleKey: string;
  components: Array<{
    customId: string;
    labelKey: string;
    descriptionKey: string;
    placeholder: string;
    required: true;
    options: SelectOption[];
  }>;
} {
  return {
    modalCustomId: MODAL_CUSTOM_ID,
    modalTitleKey: "commands.memory.document.view.modal_title",
    components: [
      {
        customId: DOCUMENT_SELECT_ID,
        labelKey: "commands.memory.document.view.select_label",
        descriptionKey: "commands.memory.document.view.select_description",
        placeholder: "commands.memory.document.view.select_placeholder",
        required: true,
        options: documents.map((document) => ({
          label: safeSelectOptionText(document.document_name),
          value: document.document_id.toString(),
          description: document.first_chunk ? safeSelectOptionText(document.first_chunk) : undefined,
        })),
      },
    ],
  };
}

async function promptForDocument(
  phase: DocumentWorkflowPhase,
  documents: readonly DocumentRow[],
  interaction: ChatInputCommandInteraction,
  locale: string,
): Promise<PersonaWorkflowModalResult | null> {
  const openButtonId = `document_view_${phase.phaseId}_open`;
  await phase.message.replace(
    buildPersonaWorkflowNotice({
      locale,
      titleKey: "general.persona_workflow.modal_ready_title",
      descriptionKey: "general.persona_workflow.modal_ready_description",
      color: ColorCode.INFO,
      button: {
        customId: openButtonId,
        labelKey: "general.persona_workflow.open_modal_button",
        style: ButtonStyle.Primary,
      },
    }),
  );

  let openButton: ButtonInteraction;
  try {
    const message = await phase.message.fetchMessage();
    openButton = await message.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (candidate) => candidate.user.id === interaction.user.id && candidate.customId === openButtonId,
      time: PERSONA_WORKFLOW_COMPONENT_TIMEOUT_MS,
    });
  } catch {
    await phase.message.replace(
      buildPersonaWorkflowNotice({
        locale,
        titleKey: "general.interaction.timeout_title",
        descriptionKey: "general.pagination.timeout",
        color: ColorCode.WARN,
      }),
    );
    return null;
  }

  const result = await phase.useButton(openButton).openModal(buildDocumentSelectModal(documents));
  if (result.outcome !== "submitted") {
    if (result.outcome === "timeout") {
      await phase.message.replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "general.interaction.timeout_title",
          descriptionKey: "general.pagination.timeout",
          color: ColorCode.WARN,
        }),
      );
    }
    return null;
  }
  return result;
}

async function runDocumentViewStateMachine(params: {
  client: Client;
  interaction: ChatInputCommandInteraction;
  userData: UserRow;
  locale: string;
  tomoriState: TomoriState;
  phase: DocumentWorkflowPhase;
  documents: readonly DocumentRow[];
  targetPersonaId: number | null;
  canEdit: boolean;
  guildCacheKey: string;
}): Promise<void> {
  const {
    client,
    interaction,
    userData,
    locale,
    tomoriState,
    phase,
    documents,
    targetPersonaId,
    canEdit,
    guildCacheKey,
  } = params;
  const modalResult = await promptForDocument(phase, documents, interaction, locale);
  if (!modalResult || modalResult.outcome !== "submitted") return;

  const modalWork = await modalResult.phase.beginInPlaceWork();
  const selectedId = Number.parseInt(modalResult.phase.values[DOCUMENT_SELECT_ID] ?? "", 10);
  if (!Number.isInteger(selectedId) || !documents.some((document) => document.document_id === selectedId)) {
    await modalWork.message.replace(
      buildPersonaWorkflowNotice({
        locale,
        titleKey: "general.errors.invalid_option_title",
        descriptionKey: "general.errors.invalid_option_description",
        color: ColorCode.ERROR,
      }),
    );
    return;
  }

  await modalWork.message.replace(
    buildPersonaWorkflowNotice({
      locale,
      titleKey: "general.persona_workflow.loading_title",
      descriptionKey: "general.persona_workflow.loading_description",
      color: ColorCode.INFO,
    }),
  );
  const documentMeta = await serverMemoryRepository.loadDocumentMeta(
    selectedId,
    tomoriState.server_id,
    targetPersonaId,
  );
  if (!documentMeta) {
    await modalWork.message.replace(
      buildPersonaWorkflowNotice({
        locale,
        titleKey: "general.errors.invalid_option_title",
        descriptionKey: "general.errors.invalid_option_description",
        color: ColorCode.ERROR,
      }),
    );
    return;
  }

  const documentName = documentMeta.document_name;
  let currentChannelTags = documentMeta.channel_tags;
  let chunks: ChunkRow[] = await serverMemoryRepository.loadDocumentChunks(
    selectedId,
    tomoriState.server_id,
    targetPersonaId,
  );
  if (chunks.length === 0) {
    await modalWork.message.replace(
      buildPersonaWorkflowNotice({
        locale,
        titleKey: "commands.memory.document.view.no_chunks_title",
        descriptionKey: "commands.memory.document.view.no_chunks_description",
        color: ColorCode.WARN,
      }),
    );
    return;
  }

  let currentIndex = 0;
  let mode: NavMode = "normal";
  await modalWork.message.replace(buildChunkViewPayload(chunks, currentIndex, documentName, locale, canEdit));

  while (true) {
    let button: ButtonInteraction;
    try {
      const viewMessage = await phase.message.fetchMessage();
      button = await viewMessage.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (candidate) => candidate.user.id === interaction.user.id,
        time: PERSONA_WORKFLOW_COMPONENT_TIMEOUT_MS,
      });
    } catch {
      await phase.message.replace(
        buildChunkViewPayload(chunks, currentIndex, documentName, locale, canEdit, {
          controls: false,
          notice: {
            titleKey: "general.interaction.timeout_title",
            descriptionKey: "general.pagination.timeout",
          },
        }),
      );
      return;
    }

    const action = phase.useButton(button);
    if (button.customId === BTN_CLOSE) {
      try {
        await action.delete();
      } catch (error) {
        log.warn("Failed to delete /memory document view on close; disabling controls instead", error);
        await phase.message.replace(
          buildChunkViewPayload(chunks, currentIndex, documentName, locale, canEdit, { controls: false }),
        );
      }
      return;
    }

    if (button.customId === BTN_PREV || button.customId === BTN_NEXT) {
      currentIndex =
        button.customId === BTN_PREV ? Math.max(0, currentIndex - 1) : Math.min(chunks.length - 1, currentIndex + 1);
      mode = "normal";
      await action.replace(buildChunkViewPayload(chunks, currentIndex, documentName, locale, canEdit));
      continue;
    }

    if (!canEdit && (button.customId === BTN_EDIT || button.customId === BTN_DELETE)) {
      await action.replace(
        buildChunkViewPayload(chunks, currentIndex, documentName, locale, canEdit, {
          notice: {
            titleKey: "commands.memory.document.view.no_permission_title",
            descriptionKey: "commands.memory.document.view.no_permission_description",
          },
        }),
      );
      continue;
    }

    if (button.customId === BTN_EDIT) {
      const currentChunk = chunks[currentIndex];
      if (!currentChunk) {
        await action.replace(buildChunkViewPayload(chunks, currentIndex, documentName, locale, canEdit));
        continue;
      }

      const editResult = await action.openModal({
        modalTitleKey: "commands.memory.document.view.edit_modal_title",
        modalCustomId: EDIT_MODAL_ID,
        components: [
          {
            customId: EDIT_CONTENT_FIELD_ID,
            labelKey: "commands.memory.document.view.edit_content_label",
            placeholder: "commands.memory.document.view.edit_content_placeholder",
            style: TextInputStyle.Paragraph,
            required: true,
            maxLength: EDIT_CONTENT_INPUT_MAX,
            value: currentChunk.content.substring(0, EDIT_CONTENT_INPUT_MAX),
          },
          {
            customId: EDIT_TAGS_FIELD_ID,
            labelKey: "commands.memory.document.view.edit_channel_tags_label",
            placeholder: "commands.memory.document.view.edit_channel_tags_placeholder",
            style: TextInputStyle.Short,
            required: false,
            maxLength: EDIT_TAGS_INPUT_MAX,
            value: currentChannelTags.join(","),
          },
        ],
      });
      if (editResult.outcome !== "submitted") {
        await phase.message.replace(
          buildChunkViewPayload(chunks, currentIndex, documentName, locale, canEdit, {
            notice: {
              titleKey: "general.interaction.timeout_title",
              descriptionKey: "general.pagination.timeout",
            },
          }),
        );
        continue;
      }

      const editWork = await editResult.phase.beginInPlaceWork();
      const newContent = (editResult.phase.values[EDIT_CONTENT_FIELD_ID] ?? "").trim();
      const newTags = parseChannelTagsInput(editResult.phase.values[EDIT_TAGS_FIELD_ID] ?? "", client);
      if (!newContent) {
        await editWork.message.replace(
          buildChunkViewPayload(chunks, currentIndex, documentName, locale, canEdit, {
            notice: {
              titleKey: "commands.memory.document.view.edit_empty_content_title",
              descriptionKey: "commands.memory.document.view.edit_empty_content_description",
            },
          }),
        );
        continue;
      }

      const contentChanged = newContent !== currentChunk.content;
      const tagsChanged = !tagArraysEqual(newTags, currentChannelTags);
      if (!contentChanged && !tagsChanged) {
        await editWork.message.replace(
          buildChunkViewPayload(chunks, currentIndex, documentName, locale, canEdit, {
            notice: {
              titleKey: "commands.memory.document.view.edit_no_changes_title",
              descriptionKey: "commands.memory.document.view.edit_no_changes_description",
            },
          }),
        );
        continue;
      }

      await editWork.message.replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "general.persona_workflow.loading_title",
          descriptionKey: "general.persona_workflow.loading_description",
          color: ColorCode.INFO,
        }),
      );

      if (contentChanged) {
        const regen = await regenChunkEmbedding({
          content: newContent,
          serverId: tomoriState.server_id,
          configuredEmbeddingModelId: tomoriState.config.embedding_model_id ?? null,
          userId: userData.user_id ?? null,
        });
        if (!regen.ok) {
          await editWork.message.replace(
            buildChunkViewPayload(chunks, currentIndex, documentName, locale, canEdit, {
              notice: {
                titleKey: `commands.memory.document.view.${regen.errorKey}_title`,
                descriptionKey: `commands.memory.document.view.${regen.errorKey}_description`,
              },
            }),
          );
          continue;
        }

        const updated = await serverMemoryRepository.updateChunk({
          chunkId: currentChunk.document_chunk_id,
          serverId: tomoriState.server_id,
          personaId: targetPersonaId,
          content: newContent,
          embeddingVector: regen.embeddingVector,
          embeddingModelId: regen.embeddingModelId,
          embeddingFamily: regen.embeddingFamily,
        });
        if (!updated) {
          await editWork.message.replace(
            buildChunkViewPayload(chunks, currentIndex, documentName, locale, canEdit, {
              notice: {
                titleKey: "commands.memory.document.view.embedding_error_title",
                descriptionKey: "commands.memory.document.view.embedding_error_description",
              },
            }),
          );
          continue;
        }
        // Invalidate the committed chunk update even if the derived document-text rebuild fails.
        invalidateTomoriStateCache(guildCacheKey);
        await rebuildDocumentTextContent(selectedId);
        // Close the repopulation window around the rebuild's second DB write.
        invalidateTomoriStateCache(guildCacheKey);
        chunks[currentIndex] = { ...currentChunk, content: newContent };
      }

      if (tagsChanged) {
        const tagsUpdated = await serverMemoryRepository.updateDocumentChannelTags(
          selectedId,
          tomoriState.server_id,
          newTags,
          targetPersonaId,
        );
        if (!tagsUpdated) {
          await editWork.message.replace(
            buildChunkViewPayload(chunks, currentIndex, documentName, locale, canEdit, {
              notice: {
                titleKey: "general.errors.update_failed_title",
                descriptionKey: "general.errors.update_failed_description",
              },
            }),
          );
          continue;
        }
        currentChannelTags = newTags;
        invalidateTomoriStateCache(guildCacheKey);
      }

      const successKey =
        contentChanged && tagsChanged
          ? "edit_success_both"
          : contentChanged
            ? "edit_success_content_only"
            : "edit_success_tags_only";
      await editWork.message.replace(
        buildChunkViewPayload(chunks, currentIndex, documentName, locale, canEdit, {
          notice: {
            titleKey: "commands.memory.document.view.edit_success_title",
            descriptionKey: `commands.memory.document.view.${successKey}`,
          },
        }),
      );
      continue;
    }

    if (button.customId === BTN_DELETE) {
      mode = "confirm_delete";
      await action.replace(buildDeleteConfirmPayload(chunks, currentIndex, documentName, locale));
      continue;
    }

    if (button.customId === BTN_CANCEL_DELETE) {
      mode = "normal";
      await action.replace(buildChunkViewPayload(chunks, currentIndex, documentName, locale, canEdit));
      continue;
    }

    if (button.customId === BTN_CONFIRM_DELETE && mode === "confirm_delete") {
      const currentChunk = chunks[currentIndex];
      if (!currentChunk) {
        mode = "normal";
        await action.replace(buildChunkViewPayload(chunks, currentIndex, documentName, locale, canEdit));
        continue;
      }

      const deleteWork = await action.beginInPlaceWork();
      await deleteWork.message.replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "general.persona_workflow.loading_title",
          descriptionKey: "general.persona_workflow.loading_description",
          color: ColorCode.INFO,
        }),
      );
      const wasLast = chunks.length === 1;
      const deleted = await serverMemoryRepository.deleteChunk(
        currentChunk.document_chunk_id,
        tomoriState.server_id,
        targetPersonaId,
      );
      if (!deleted) {
        mode = "normal";
        await deleteWork.message.replace(
          buildChunkViewPayload(chunks, currentIndex, documentName, locale, canEdit, {
            notice: {
              titleKey: "commands.memory.document.view.delete_failed_title",
              descriptionKey: "commands.memory.document.view.delete_failed_description",
            },
          }),
        );
        continue;
      }
      // Invalidate the committed chunk deletion even if the derived document-text rebuild fails.
      invalidateTomoriStateCache(guildCacheKey);

      if (wasLast) {
        const removedDocument = await serverMemoryRepository.removeDocument(
          selectedId,
          tomoriState.server_id,
          targetPersonaId,
        );
        if (!removedDocument) {
          await deleteWork.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "commands.memory.document.view.delete_failed_title",
              descriptionKey: "commands.memory.document.view.delete_failed_description",
              color: ColorCode.ERROR,
            }),
          );
          return;
        }
        invalidateTomoriStateCache(guildCacheKey);
        await deleteWork.message.replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "commands.memory.document.view.delete_document_title",
            descriptionKey: "commands.memory.document.view.delete_document_description",
            descriptionVars: { document_name: documentName },
            color: ColorCode.SUCCESS,
          }),
        );
        return;
      }

      await rebuildDocumentTextContent(selectedId);
      // Close the repopulation window around the rebuild's second DB write.
      invalidateTomoriStateCache(guildCacheKey);
      chunks = chunks.filter((chunk) => chunk.document_chunk_id !== currentChunk.document_chunk_id);
      currentIndex = Math.min(currentIndex, chunks.length - 1);
      mode = "normal";
      await deleteWork.message.replace(
        buildChunkViewPayload(chunks, currentIndex, documentName, locale, canEdit, {
          notice: {
            titleKey: "commands.memory.document.view.delete_success_title",
            descriptionKey: "commands.memory.document.view.delete_success_description",
            descriptionVars: { total: String(chunks.length) },
          },
        }),
      );
      continue;
    }

    await action.replace(buildChunkViewPayload(chunks, currentIndex, documentName, locale, canEdit));
  }
}

export async function execute(
  client: Client,
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

  const state: {
    tomoriState: TomoriState | null;
    targetPersonaId: number | null;
    phase: DocumentWorkflowPhase | null;
  } = { tomoriState: null, targetPersonaId: null, phase: null };
  const scope: DocumentScope = interaction.options.getString("scope") === "serverwide" ? "serverwide" : "persona";
  let serverwidePhase: AnchorPrivateWorkflowPhase | null = null;

  try {
    if (!isRagAvailable()) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.shared.rag.disabled_title",
        descriptionKey: "commands.shared.rag.disabled_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (scope === "persona") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } else {
      serverwidePhase = await beginAnchorPrivateWorkflow(
        interaction,
        locale,
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "general.persona_workflow.loading_title",
          descriptionKey: "general.persona_workflow.loading_description",
          color: ColorCode.INFO,
        }),
      );
      state.phase = serverwidePhase;
    }

    const guildCacheKey = interaction.guild?.id ?? interaction.user.id;
    const cachedState = await getCachedTomoriState(guildCacheKey);
    if (!cachedState) {
      if (serverwidePhase) {
        await serverwidePhase.message.replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "general.errors.tomori_not_setup_title",
            descriptionKey: "general.errors.tomori_not_setup_description",
            color: ColorCode.ERROR,
          }),
        );
      } else {
        await replyInfoEmbed(interaction, locale, {
          titleKey: "general.errors.tomori_not_setup_title",
          descriptionKey: "general.errors.tomori_not_setup_description",
          color: ColorCode.ERROR,
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }
    const overlayResult = await applyPersonalProviderSelectionsToTomoriState(cachedState, userData.user_id ?? null);
    const tomoriState = overlayResult.tomoriState;
    state.tomoriState = tomoriState;

    const hasManagePermission = interaction.memberPermissions?.has("ManageGuild") ?? false;
    if (!tomoriState.config.server_memteaching_enabled && !hasManagePermission) {
      if (serverwidePhase) {
        await serverwidePhase.message.replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "commands.teach.document.teaching_disabled_title",
            descriptionKey: "commands.teach.document.teaching_disabled_description",
            color: ColorCode.ERROR,
          }),
        );
      } else {
        await replyInfoEmbed(interaction, locale, {
          titleKey: "commands.teach.document.teaching_disabled_title",
          descriptionKey: "commands.teach.document.teaching_disabled_description",
          color: ColorCode.ERROR,
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    if (scope === "serverwide") {
      const phase = serverwidePhase;
      if (!phase) {
        throw new Error("Serverwide document view is missing its anchor workflow phase.");
      }
      const documents = await serverMemoryRepository.loadDocuments(tomoriState.server_id, null);
      if (!documents.length) {
        await phase.message.replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "commands.memory.document.view.none_title",
            descriptionKey: "commands.memory.document.view.none_description",
            color: ColorCode.WARN,
          }),
        );
        return;
      }
      await runDocumentViewStateMachine({
        client,
        interaction,
        userData,
        locale,
        tomoriState,
        phase,
        documents,
        targetPersonaId: null,
        canEdit: hasManagePermission,
        guildCacheKey,
      });
      return;
    }

    const allPersonas = await personaRepository.loadAllForServer(guildCacheKey);
    if (!allPersonas.length) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Class B eligibility: filter to personas that own at least one document.
    // No retry loop here (view completes after one selection), so the set stays
    // static. The `!documents.length` load below remains the concurrency backstop.
    const eligibleDocumentPersonaIds = await serverMemoryRepository.personaIdsWithDocuments(tomoriState.server_id);
    const isEligible = personaIdIsEligible(eligibleDocumentPersonaIds);
    const eligiblePersonas = allPersonas.filter(isEligible);
    if (eligiblePersonas.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.memory.document.view.none_title",
        descriptionKey: "commands.memory.document.view.none_description",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await runPersonaPickerWorkflow(interaction, locale, {
      personas: allPersonas,
      color: ColorCode.INFO,
      eligibility: {
        isEligible,
        emptyTitleKey: "commands.memory.document.view.none_title",
        emptyDescriptionKey: "commands.memory.document.view.none_description",
        itemsLabelKey: "general.persona_workflow.items.documents",
      },
      async onSelected(selection: PersonaWorkflowSelectionPhase<TomoriState>) {
        state.phase = selection;
        state.targetPersonaId = selection.persona.persona_id ?? null;
        if (state.targetPersonaId == null) {
          const work = await selection.beginInPlaceWork();
          await work.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "general.errors.invalid_option_title",
              descriptionKey: "general.errors.invalid_option_description",
              color: ColorCode.ERROR,
            }),
          );
          return completePersonaWorkflow();
        }

        try {
          const work = await selection.beginInPlaceWork();
          await work.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "general.persona_workflow.loading_title",
              descriptionKey: "general.persona_workflow.loading_description",
              color: ColorCode.INFO,
            }),
          );
          const documents = await serverMemoryRepository.loadDocuments(tomoriState.server_id, state.targetPersonaId);
          if (!documents.length) {
            await work.message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "commands.memory.document.view.none_title",
                descriptionKey: "commands.memory.document.view.none_description",
                color: ColorCode.WARN,
              }),
            );
            return completePersonaWorkflow();
          }
          await runDocumentViewStateMachine({
            client,
            interaction,
            userData,
            locale,
            tomoriState,
            phase: selection,
            documents,
            targetPersonaId: state.targetPersonaId,
            canEdit: hasManagePermission,
            guildCacheKey,
          });
          return completePersonaWorkflow();
        } catch (error) {
          await selection.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "general.errors.unknown_error_title",
              descriptionKey: "general.errors.unknown_error_description",
              color: ColorCode.ERROR,
            }),
          );
          throw error;
        }
      },
    });
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: state.tomoriState?.server_id,
      personaId: state.targetPersonaId ?? state.tomoriState?.persona_id,
      errorType: "CommandExecutionError",
      metadata: {
        command: "memory document view",
        guildId: interaction.guild?.id,
        executorDiscordId: interaction.user.id,
      },
    };
    await log.error(`Unexpected error in /memory document view for user ${userData.user_disc_id}`, error, context);

    try {
      if (state.phase) {
        await state.phase.message.replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "general.errors.unknown_error_title",
            descriptionKey: "general.errors.unknown_error_description",
            color: ColorCode.ERROR,
          }),
        );
      } else {
        await replyInfoEmbed(interaction, locale, {
          titleKey: "general.errors.unknown_error_title",
          descriptionKey: "general.errors.unknown_error_description",
          color: ColorCode.ERROR,
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (replyError) {
      await log.error("Failed to report /memory document view error to user", replyError, context);
    }
  }
}
