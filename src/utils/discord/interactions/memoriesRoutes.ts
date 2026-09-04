import {
  type APIAttachment,
  type ButtonInteraction,
  ComponentType,
  MessageFlags,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type InteractionEditReplyOptions,
} from "discord.js";
import type { ServerMemoryRow, TomoriState } from "@/types/db/schema";
import type { PanelReadStatus, PanelReceipt } from "@/types/discord/panel";
import type { PanelAction } from "@/constants/panelActions";
import {
  clearShortTermMemoryForServerChannel,
  getShortTermMemoriesForServer,
  preWarmServerStmEntries,
} from "@/utils/cache/shortTermMemoryCache";
import { getCachedTomoriState, invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { getCachedUserRow } from "@/utils/cache/userCache";
import { personaRepository, serverMemoryRepository, serverRepository, userRepository } from "@/utils/db/repositories";
import type { GlobalInteractionRoute, GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import { beginPanelInteraction, performPanelAction } from "@/utils/discord/interactions/panelController";
import {
  MEMORIES_ROUTE_NAMESPACE,
  MEMORIES_ROUTE_VERSION,
  computeServerStmFingerprint,
  parseMemoriesPanelRoute,
  type MemoriesCategory,
} from "@/utils/discord/memoriesPanelCatalog";
import {
  buildAddDocumentModal,
  buildAddServerMemoryModal,
  buildEditDocumentChunkModal,
  buildEditServerMemoryModal,
  buildMemoriesPanelPayload,
  buildServerStmModal,
  buildServerMemoryModalFieldId,
  buildDocumentModalFieldId,
  buildStmCheckboxFieldId,
  buildVectorizeMemoryModal,
  MAX_STM_MANAGEABLE_ENTRIES,
  MAX_STM_OPTIONS_PER_GROUP,
  MAX_DOCUMENT_PAGE_SIZE,
  MAX_SERVER_MEMORY_PAGE_SIZE,
  parseServerMemoryTags,
  type MemoriesPanelPayload,
  type StmPanelEntry,
} from "@/utils/discord/ui/memoriesPanel";
import { personaRepresentativeForLineage } from "@/utils/persona/lineage";
import {
  type PersonaPanelAvatarData,
  resolvePersonaPanelAvatar,
  withPersonaPanelAvatar,
} from "@/utils/discord/personaPanelAvatar";
import { buildPanelContainer } from "@/utils/discord/ui/panel";
import { showRoutedRawModal, takeRawModalCheckboxGroupValues, takeRawModalFileUpload } from "@/utils/discord/ui/modals";
import { createNonce } from "@/utils/discord/panelRouteTokens";
import {
  dedupeCaseInsensitive,
  getNonEmptyNumberedLines,
  readTxtUpload,
  type TxtUploadReadResult,
} from "@/utils/teach/batchUploadUtils";
import { getMemoryLimits, validateMemoryContent } from "@/utils/misc/memoryLimits";
import { recordPanelActionStat } from "@/utils/stats/panelActionMetrics";
import { log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";
import {
  serverDocumentsOperations,
  type DocumentChunkRow,
  type DocumentListRow,
} from "@/utils/discord/interactions/memoriesDocumentOperations";
import { parseInteractionRoute } from "@/utils/discord/interactions/routeRegistry";

function rangeIndexAfterRemoval<T>(
  records: readonly T[],
  removedId: number,
  getId: (record: T) => number,
  remainingCount: number,
  pageSize: number,
): number | undefined {
  const removedIndex = records.findIndex((record) => getId(record) === removedId);
  if (removedIndex < 0) return undefined;
  return Math.min(Math.floor(removedIndex / pageSize), Math.max(0, Math.ceil(remainingCount / pageSize) - 1));
}

interface MemoriesScope {
  serverId: number;
  workspaceId: string;
  guildId: string | null;
  userDiscId: string;
  userId: number;
  canManage: boolean;
  isBlacklisted: boolean;
  memteachingEnabled: boolean;
  configuredEmbeddingModelId: number | null;
  personas: TomoriState[];
  readStatus: PanelReadStatus;
}

interface ServerMemoryAddInput {
  serverId: number;
  personaId: number;
  personaLineageId: number;
  taughtByUserId: number;
  workspaceId: string;
  isBlacklisted: boolean;
  canManage: boolean;
  memteachingEnabled: boolean;
  content: string;
  tags: string[];
}

interface ServerMemoryAddBatchInput {
  serverId: number;
  personaId: number;
  personaLineageId: number;
  taughtByUserId: number;
  workspaceId: string;
  isBlacklisted: boolean;
  canManage: boolean;
  memteachingEnabled: boolean;
  contents: string[];
  tags: string[];
}

interface ServerMemoryEditInput {
  serverId: number;
  personaLineageId: number;
  taughtByUserId: number;
  memoryId: number;
  workspaceId: string;
  isBlacklisted: boolean;
  canManage: boolean;
  memteachingEnabled: boolean;
  content: string;
  tags: string[];
}

interface ServerMemoryRemoveInput {
  serverId: number;
  personaLineageId: number;
  taughtByUserId: number;
  memoryId: number;
  workspaceId: string;
  isBlacklisted: boolean;
  canManage: boolean;
  memteachingEnabled: boolean;
}

type ServerMemoryAddResult =
  | { status: "blacklisted" }
  | { status: "teaching-disabled" }
  | { status: "empty-content" }
  | { status: "content-too-long" }
  | { status: "limit-reached" }
  | { status: "write-failed" }
  | { status: "success"; row: ServerMemoryRow };

type ServerMemoryAddBatchResult =
  | { status: "blacklisted" }
  | { status: "teaching-disabled" }
  | { status: "empty-content" }
  | { status: "content-too-long" }
  | { status: "all-duplicates" }
  | { status: "batch-limit-reached"; available: number; requested: number }
  | { status: "write-failed" }
  | { status: "success"; added: number; skipped: number };

type ServerMemoryEditResult =
  | { status: "blacklisted" }
  | { status: "teaching-disabled" }
  | { status: "empty-content" }
  | { status: "content-too-long" }
  | { status: "not-found" }
  | { status: "unchanged"; row: ServerMemoryRow }
  | { status: "write-failed" }
  | { status: "success"; row: ServerMemoryRow };

type ServerMemoryRemoveResult =
  | { status: "teaching-disabled" }
  | { status: "not-found" }
  | { status: "write-failed" }
  | { status: "success"; row: ServerMemoryRow };

export interface ServerMemoriesOperations {
  add(input: ServerMemoryAddInput): Promise<ServerMemoryAddResult>;
  addBatch(input: ServerMemoryAddBatchInput): Promise<ServerMemoryAddBatchResult>;
  edit(input: ServerMemoryEditInput): Promise<ServerMemoryEditResult>;
  remove(input: ServerMemoryRemoveInput): Promise<ServerMemoryRemoveResult>;
}

export const serverMemoriesOperations: ServerMemoriesOperations = {
  async add({
    serverId,
    personaId,
    personaLineageId,
    taughtByUserId,
    workspaceId,
    isBlacklisted,
    canManage,
    memteachingEnabled,
    content,
    tags,
  }) {
    if (isBlacklisted && !canManage) {
      return { status: "blacklisted" };
    }
    if (!memteachingEnabled && !canManage) {
      return { status: "teaching-disabled" };
    }
    const trimmed = content.trim();
    if (!trimmed) {
      return { status: "empty-content" };
    }
    const validation = validateMemoryContent(trimmed);
    if (!validation.isValid) {
      return { status: "content-too-long" };
    }
    const limitCheck = await serverMemoryRepository.checkServerMemoryLimit(serverId, personaLineageId);
    if (!limitCheck.isValid) {
      return { status: "limit-reached" };
    }
    const inserted = await serverMemoryRepository.add(
      serverId,
      personaId,
      personaLineageId,
      taughtByUserId,
      trimmed,
      tags,
      workspaceId,
    );
    if (!inserted) {
      return { status: "write-failed" };
    }
    return { status: "success", row: inserted };
  },

  async addBatch({
    serverId,
    personaId,
    personaLineageId,
    taughtByUserId,
    workspaceId,
    isBlacklisted,
    canManage,
    memteachingEnabled,
    contents,
    tags,
  }) {
    if (isBlacklisted && !canManage) {
      return { status: "blacklisted" };
    }
    if (!memteachingEnabled && !canManage) {
      return { status: "teaching-disabled" };
    }

    const trimmed = dedupeCaseInsensitive(contents.map((entry) => entry.trim()).filter((entry) => entry.length > 0));
    if (trimmed.length === 0) {
      return { status: "empty-content" };
    }
    if (trimmed.some((entry) => !validateMemoryContent(entry).isValid)) {
      return { status: "content-too-long" };
    }

    const existing = await serverMemoryRepository.loadServerMemoryContents(serverId, personaLineageId);
    const existingContents = new Set(existing.map((c) => c.trim().toLowerCase()));
    const toInsert = trimmed.filter((entry) => !existingContents.has(entry.toLowerCase()));
    if (toInsert.length === 0) {
      return { status: "all-duplicates" };
    }

    const limitCheck = await serverMemoryRepository.checkServerMemoryLimit(serverId, personaLineageId);
    const currentCount = limitCheck.currentCount ?? existing.length;
    const maxAllowed = limitCheck.maxAllowed ?? getMemoryLimits().maxServerMemories;
    const available = Math.max(0, maxAllowed - currentCount);
    if (toInsert.length > available) {
      return { status: "batch-limit-reached", available, requested: toInsert.length };
    }

    const ok = await serverMemoryRepository.addBatch(
      serverId,
      personaId,
      personaLineageId,
      taughtByUserId,
      toInsert,
      tags,
    );
    if (!ok) {
      return { status: "write-failed" };
    }
    invalidateTomoriStateCache(workspaceId);
    return { status: "success", added: toInsert.length, skipped: trimmed.length - toInsert.length };
  },

  async edit({
    serverId,
    personaLineageId,
    taughtByUserId,
    memoryId,
    workspaceId,
    isBlacklisted,
    canManage,
    memteachingEnabled,
    content,
    tags,
  }) {
    if (isBlacklisted && !canManage) {
      return { status: "blacklisted" };
    }
    if (!memteachingEnabled && !canManage) {
      return { status: "teaching-disabled" };
    }
    const trimmed = content.trim();
    if (!trimmed) {
      return { status: "empty-content" };
    }
    const validation = validateMemoryContent(trimmed);
    if (!validation.isValid) {
      return { status: "content-too-long" };
    }
    const ownerFilter = canManage ? undefined : taughtByUserId;
    const freshlyLoaded = await serverMemoryRepository.loadServerMemoriesScoped(
      serverId,
      personaLineageId,
      ownerFilter,
    );
    const target = freshlyLoaded.find((m) => m.server_memory_id === memoryId);
    if (!target) {
      return { status: "not-found" };
    }
    const existingTags = target.tags ?? [];
    const tagsUnchanged = tags.length === existingTags.length && tags.every((t, i) => t === existingTags[i]);
    if (trimmed === target.content.trim() && tagsUnchanged) {
      return { status: "unchanged", row: target };
    }
    const ok = await serverMemoryRepository.edit(memoryId, trimmed, tags);
    if (!ok) {
      return { status: "write-failed" };
    }
    invalidateTomoriStateCache(workspaceId);
    return { status: "success", row: { ...target, content: trimmed, tags } };
  },

  async remove({ serverId, personaLineageId, taughtByUserId, memoryId, workspaceId, canManage, memteachingEnabled }) {
    if (!memteachingEnabled && !canManage) {
      return { status: "teaching-disabled" };
    }
    const ownerFilter = canManage ? undefined : taughtByUserId;
    const freshlyLoaded = await serverMemoryRepository.loadServerMemoriesScoped(
      serverId,
      personaLineageId,
      ownerFilter,
    );
    const target = freshlyLoaded.find((m) => m.server_memory_id === memoryId);
    if (!target) {
      return { status: "not-found" };
    }
    const ok = await serverMemoryRepository.remove(memoryId);
    if (!ok) {
      return { status: "write-failed" };
    }
    invalidateTomoriStateCache(workspaceId);
    return { status: "success", row: target };
  },
};

export interface MemoriesRouteDependencies {
  resolveScope(
    interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
    forceRefresh?: boolean,
  ): Promise<MemoriesScope | null>;
  loadMemories(serverId: number, lineageId: number, userId?: number): Promise<ServerMemoryRow[]>;
  getMemoryCountsByLineage(serverId: number, userId?: number): Promise<Map<number, number>>;
  getPersonaAvatarData(
    interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
    persona: TomoriState,
  ): Promise<PersonaPanelAvatarData>;
  loadDocuments(serverId: number, personaId: number | null): Promise<DocumentListRow[]>;
  loadDocumentMeta(
    serverId: number,
    personaId: number | null,
    documentId: number,
  ): Promise<{ document_name: string; channel_tags: string[] } | null>;
  loadDocumentChunks(serverId: number, personaId: number | null, documentId: number): Promise<DocumentChunkRow[]>;
  getDocumentCounts(serverId: number, personaId: number | null): Promise<{ documents: number; chunks: number }>;
  getDocumentCountsByPersona(serverId: number): Promise<{ byPersona: Map<number, number>; serverwide: number }>;
  getEligibleHistoryPersonaIds(serverId: number): Promise<Set<number>>;
  getStmEntries(workspaceId: string, personas: TomoriState[], locale: string): Promise<StmPanelEntry[]>;
  preWarmServerStm(workspaceId: string): Promise<void>;
  operations: ServerMemoriesOperations;
  documentOperations: typeof serverDocumentsOperations;
  recordAction(input: { action: PanelAction; serverId: number; userDiscId: string }): void;
  createNonce(): string;
  showAddModal(
    interaction: StringSelectMenuInteraction | ButtonInteraction,
    locale: string,
    lineageId: number,
    nonce: string,
  ): Promise<void>;
  takeFileUpload(interactionId: string, nonce: string): APIAttachment | undefined;
  takeDocumentFileUpload(interactionId: string, nonce: string): APIAttachment | undefined;
  readUploadedText(attachment: APIAttachment): Promise<TxtUploadReadResult>;
  showEditModal(
    interaction: ButtonInteraction,
    locale: string,
    lineageId: number,
    memory: ServerMemoryRow,
    nonce: string,
  ): Promise<void>;
  showAddDocumentModal(
    interaction: StringSelectMenuInteraction | ButtonInteraction,
    locale: string,
    personaId: number,
    nonce: string,
  ): Promise<void>;
  showEditChunkModal(
    interaction: ButtonInteraction,
    locale: string,
    personaId: number,
    documentId: number,
    chunk: DocumentChunkRow,
    channelTags: string[],
    nonce: string,
  ): Promise<void>;
  showVectorizeModal(
    interaction: ButtonInteraction,
    locale: string,
    lineageId: number,
    personaId: number,
    memory: ServerMemoryRow,
    nonce: string,
  ): Promise<void>;
  showStmModal(
    interaction: ButtonInteraction,
    locale: string,
    entries: StmPanelEntry[],
    fingerprint: string,
  ): Promise<void>;
  takeCheckboxValues(interactionId: string, fieldId: string): string[] | undefined;
  clearStm(workspaceId: string, channelId: string, personaId: number | null): void;
}

export const MEMORIES_RECEIPT_KEYS = [
  "added",
  "edited",
  "removed",
  "no_changes",
  "changed_state",
  "write_failed",
  "content_too_long",
  "limit_reached",
  "empty_content",
  "batch_added",
  "batch_file_invalid",
  "batch_file_too_large",
  "batch_all_duplicates",
  "batch_limit_reached",
  "blacklisted_error",
  "teaching_disabled_error",
  "manager_only",
  "document_added",
  "document_removed",
  "document_chunk_edited",
  "document_chunk_removed",
  "document_removed_with_last_chunk",
  "vectorized",
  "vectorize_partial_failure",
  "document_rag_disabled",
  "document_memory_critical",
  "document_invalid_name",
  "document_invalid_file",
  "document_file_too_large",
  "document_download_failed",
  "document_empty_content",
  "document_content_too_long",
  "document_too_many_chunks",
  "document_limit",
  "document_chunk_limit",
  "document_duplicate",
  "document_quota",
  "embedding_credentials_missing",
  "embedding_model_missing",
  "stm_changed_state",
  "stm_cleared",
] as const;

const ERROR_RECEIPT_KEYS = new Set<string>([
  "blacklisted_error",
  "teaching_disabled_error",
  "empty_content",
  "content_too_long",
  "limit_reached",
  "write_failed",
  "batch_file_invalid",
  "batch_file_too_large",
  "batch_all_duplicates",
  "batch_limit_reached",
  "manager_only",
  "document_invalid_name",
  "document_rag_disabled",
  "document_memory_critical",
  "document_invalid_file",
  "document_file_too_large",
  "document_download_failed",
  "document_empty_content",
  "document_content_too_long",
  "document_too_many_chunks",
  "document_limit",
  "document_chunk_limit",
  "document_duplicate",
  "document_quota",
  "embedding_credentials_missing",
  "embedding_model_missing",
  "vectorize_partial_failure",
  "stm_changed_state",
]);

function receipt(locale: string, key: string, variables?: Record<string, string | number>): PanelReceipt {
  return {
    tone: ERROR_RECEIPT_KEYS.has(key) ? "error" : "success",
    heading: localizer(locale, `commands.memories.${key}_heading`),
    detail: localizer(locale, `commands.memories.${key}_detail`, variables),
  };
}

/**
 * Yellow interim receipt painted before an embedding call.
 *
 * Document upload and vectorize both wait on the embedding provider, and the panel is already
 * deferred by then, so without this the message sits unchanged for several seconds with nothing to
 * say the work started. This paint is overwritten by the real receipt when the operation returns.
 */
function workingReceipt(locale: string, key: string): PanelReceipt {
  return {
    tone: "warning",
    heading: localizer(locale, `commands.memories.${key}_heading`),
    detail: localizer(locale, `commands.memories.${key}_detail`),
  };
}

function changedStateReceipt(locale: string): PanelReceipt {
  return {
    tone: "info",
    heading: localizer(locale, "commands.memories.changed_state_heading"),
    detail: localizer(locale, "commands.memories.changed_state_detail"),
  };
}

function noChangesReceipt(locale: string): PanelReceipt {
  return {
    tone: "info",
    heading: localizer(locale, "commands.memories.no_changes_heading"),
    detail: localizer(locale, "commands.memories.no_changes_detail"),
  };
}

function terminalPayload(locale: string, key: string): InteractionEditReplyOptions {
  return {
    components: [
      buildPanelContainer([
        {
          type: ComponentType.TextDisplay,
          content: localizer(locale, key),
        },
      ]),
    ],
    attachments: [],
    flags: MessageFlags.IsComponentsV2,
  };
}

function parseDocumentChannelTags(raw: string, interaction: GlobalRoutableInteraction): string[] {
  if (!raw.trim()) return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((part) => {
          const value = part.trim();
          const mention = value.match(/^<#(\d+)>$/);
          if (mention) {
            const channel = interaction.client.channels.cache.get(mention[1]);
            return channel && "name" in channel && channel.name ? channel.name.toLowerCase() : "";
          }
          return value.toLowerCase().replace(/^#+/, "");
        })
        .filter((value) => value.length > 0 && /^[\w-]+$/.test(value))
        .map((value) => `#${value}`),
    ),
  ];
}

/**
 * Receipt key for each non-success document operation status.
 *
 * Exported so a test can prove every value here is also in `MEMORIES_RECEIPT_KEYS`: a status
 * mapped to a key nobody registered renders the raw key to the user, and `check-locales` cannot
 * see it because the heading and detail suffixes are composed at call time.
 */
export const DOCUMENT_RESULT_RECEIPT_KEYS: Record<string, string> = {
  blacklisted: "blacklisted_error",
  "teaching-disabled": "teaching_disabled_error",
  "rag-disabled": "document_rag_disabled",
  "memory-critical": "document_memory_critical",
  "invalid-name": "document_invalid_name",
  "invalid-file": "document_invalid_file",
  "file-too-large": "document_file_too_large",
  "download-failed": "document_download_failed",
  "empty-content": "document_empty_content",
  "content-too-long": "document_content_too_long",
  "too-many-chunks": "document_too_many_chunks",
  "document-limit": "document_limit",
  "chunk-limit": "document_chunk_limit",
  duplicate: "document_duplicate",
  "quota-exceeded": "document_quota",
  "credentials-missing": "embedding_credentials_missing",
  "model-missing": "embedding_model_missing",
  "write-failed": "write_failed",
  forbidden: "manager_only",
};

function documentResultReceipt(locale: string, status: string, variables?: Record<string, string | number>) {
  if (status === "not-found") return changedStateReceipt(locale);
  if (status === "unchanged") return noChangesReceipt(locale);
  return receipt(locale, DOCUMENT_RESULT_RECEIPT_KEYS[status] ?? "write_failed", variables);
}

async function resolveScope(
  interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
  _forceRefresh = false,
): Promise<MemoriesScope | null> {
  const userDiscId = interaction.user.id;
  const workspaceId = interaction.guildId ?? interaction.user.id;
  try {
    const userRow = await getCachedUserRow(userDiscId);
    const registeredUser = userRow ?? (await userRepository.register(userDiscId, interaction.user.username));
    if (!registeredUser?.user_id) return null;

    const canManage = !interaction.guildId || (interaction.memberPermissions?.has("ManageGuild") ?? false);
    const isBlacklisted = interaction.guildId
      ? ((await userRepository.isBlacklisted(interaction.guildId, userDiscId)) ?? false)
      : false;

    // The state is required rather than optional. Reading the teaching flag as
    // `tomoriState?.config.server_memteaching_enabled ?? false` turns a cache miss into a
    // confident "teaching is disabled" on a server where it is enabled, and every legacy leaf
    // instead dereferences a non-null state, so a missing one means unavailable, not restricted.
    const tomoriState = await getCachedTomoriState(workspaceId);
    const internalServerId = tomoriState?.server_id ?? (await serverRepository.loadServerIdByDiscId(workspaceId));
    if (!internalServerId || !tomoriState) return null;

    const memteachingEnabled = tomoriState.config.server_memteaching_enabled;

    let personas: TomoriState[] = [];
    try {
      const allPersonas = await personaRepository.loadAllForServer(workspaceId);
      personas = allPersonas.filter(
        (p) => p.persona_lineage_id !== undefined && p.persona_lineage_id !== null && p.persona_lineage_id !== 0,
      );
    } catch (error) {
      log.warn("Failed to load personas for memories scope", { workspaceId, error });
    }

    return {
      serverId: internalServerId,
      workspaceId,
      guildId: interaction.guildId ?? null,
      userDiscId,
      userId: registeredUser.user_id,
      canManage,
      isBlacklisted,
      memteachingEnabled,
      configuredEmbeddingModelId: tomoriState.config.embedding_model_id ?? null,
      personas,
      readStatus: "fresh",
    };
  } catch (error) {
    log.error("Failed to resolve scope for memories", error);
    return null;
  }
}

async function loadMemories(serverId: number, lineageId: number, userId?: number): Promise<ServerMemoryRow[]> {
  return serverMemoryRepository.loadServerMemoriesScoped(serverId, lineageId, userId);
}

async function getMemoryCountsByLineage(serverId: number, userId?: number): Promise<Map<number, number>> {
  return serverMemoryRepository.memoryCountsByLineage(serverId, userId);
}

async function loadDocuments(serverId: number, personaId: number | null): Promise<DocumentListRow[]> {
  const [documents, history] = await Promise.all([
    serverMemoryRepository.loadDocuments(serverId, personaId),
    serverMemoryRepository.loadHistoryDocuments(serverId, personaId),
  ]);
  const historyIds = new Set(history.map((document) => document.document_id));
  return documents.map((document) => ({ ...document, isHistory: historyIds.has(document.document_id) }));
}

async function loadDocumentChunks(
  serverId: number,
  personaId: number | null,
  documentId: number,
): Promise<DocumentChunkRow[]> {
  return serverMemoryRepository.loadDocumentChunks(documentId, serverId, personaId);
}

async function loadDocumentMeta(serverId: number, personaId: number | null, documentId: number) {
  return serverMemoryRepository.loadDocumentMeta(documentId, serverId, personaId);
}

async function getDocumentCounts(
  serverId: number,
  personaId: number | null,
): Promise<{ documents: number; chunks: number }> {
  const [documents, chunks] = await Promise.all([
    serverMemoryRepository.countDocumentsScoped(serverId, personaId),
    serverMemoryRepository.countChunksScoped(serverId, personaId),
  ]);
  return { documents, chunks };
}

async function getStmEntries(workspaceId: string, personas: TomoriState[], locale: string): Promise<StmPanelEntry[]> {
  await preWarmServerStmEntries(workspaceId);
  const names = new Map<number, string>();
  for (const persona of personas) {
    if (persona.persona_id) names.set(persona.persona_id, persona.persona_nickname);
  }
  return getShortTermMemoriesForServer(workspaceId)
    .map((entry) => ({
      channelId: entry.channelId,
      channelName: entry.channelName,
      personaId: entry.personaId,
      personaName:
        entry.personaId == null
          ? localizer(locale, "commands.memories.stm_unscoped")
          : (names.get(entry.personaId) ?? localizer(locale, "commands.memories.persona_default_name")),
      summary: entry.summary,
      lastUpdated: entry.lastUpdated,
    }))
    .sort((left, right) => right.lastUpdated - left.lastUpdated);
}

async function preWarmServerStm(workspaceId: string): Promise<void> {
  await preWarmServerStmEntries(workspaceId);
}

/**
 * Refuse a modal-opening branch by repainting the panel with an error receipt.
 *
 * These branches sit above `beginPanelInteraction` because a modal is its own acknowledgement, so
 * they arrive unacknowledged. A refusal is not going to open a modal, which frees it to
 * `deferUpdate` and edit the panel in place; replying ephemerally instead posts a second, stray
 * message that reads as an unrelated error rather than as this panel's answer.
 */
async function refuseInPlace(
  interaction: GlobalRoutableInteraction,
  locale: string,
  scope: MemoriesScope | null,
  category: MemoriesCategory,
  selectedId: number,
  receiptKey: string,
  dependencies: MemoriesRouteDependencies,
): Promise<void> {
  await interaction.deferUpdate();
  if (!scope) {
    await interaction.editReply(terminalPayload(locale, "commands.memories.unavailable"));
    return;
  }
  const memories =
    category === "memories" && selectedId
      ? await dependencies.loadMemories(scope.serverId, selectedId, scope.canManage ? undefined : scope.userId)
      : [];
  await repaint(
    interaction,
    locale,
    scope,
    category,
    selectedId,
    memories,
    category === "documents" ? { kind: "documents" } : { kind: "main" },
    receiptKey === "changed_state" ? changedStateReceipt(locale) : receipt(locale, receiptKey),
    dependencies,
  );
}

async function repaint(
  interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
  locale: string,
  scope: MemoriesScope,
  category: MemoriesCategory,
  selectedLineageId: number,
  memories: ServerMemoryRow[],
  page: Parameters<typeof buildMemoriesPanelPayload>[0]["page"],
  panelReceipt?: PanelReceipt,
  dependencies: MemoriesRouteDependencies = defaultDependencies,
): Promise<void> {
  const ownerFilter = scope.canManage ? undefined : scope.userId;
  let stmEntries: StmPanelEntry[] | undefined;
  if (category === "stm") {
    if (scope.canManage) {
      await dependencies.preWarmServerStm(scope.workspaceId);
      stmEntries = await dependencies.getStmEntries(scope.workspaceId, scope.personas, locale);
    }
  }

  let documents: DocumentListRow[] | undefined;
  let documentCount: number | undefined;
  let documentChunkCount: number | undefined;
  let documentChunks: DocumentChunkRow[] | undefined;
  let documentCountsByPersona: Map<number, number> | undefined;
  let eligibleHistoryPersonaIds: Set<number> | undefined;
  if (category === "documents" && (scope.canManage || scope.memteachingEnabled)) {
    const personaId = selectedLineageId === 0 ? null : selectedLineageId;
    let scopedCounts: { byPersona: Map<number, number>; serverwide: number };
    [documents, scopedCounts, eligibleHistoryPersonaIds] = await Promise.all([
      dependencies.loadDocuments(scope.serverId, personaId),
      dependencies.getDocumentCountsByPersona(scope.serverId),
      dependencies.getEligibleHistoryPersonaIds(scope.serverId),
    ]);
    documentCountsByPersona = scopedCounts.byPersona;
    const counts = await dependencies.getDocumentCounts(scope.serverId, personaId);
    documentCount = counts.documents;
    documentChunkCount = counts.chunks;
    const documentId =
      page.kind === "documents"
        ? page.selectedDocumentId
        : page.kind === "document-remove" || page.kind === "document-chunk-remove"
          ? page.documentId
          : undefined;
    const selectedDocumentId = documentId ?? documents[0]?.document_id;
    if (selectedDocumentId) {
      documentChunks = await dependencies.loadDocumentChunks(scope.serverId, personaId, selectedDocumentId);
    }
  }

  const memoryCountsByLineage =
    category === "memories" ? await dependencies.getMemoryCountsByLineage(scope.serverId, ownerFilter) : undefined;

  // Documents key on persona_id, so the face beside that heading is looked up directly rather
  // than through the lineage representative the Memories page uses. Serverwide (0) has none.
  const representative =
    category === "memories"
      ? personaRepresentativeForLineage(scope.personas, selectedLineageId)
      : category === "documents" && selectedLineageId !== 0
        ? (scope.personas.find((persona) => persona.persona_id === selectedLineageId) ?? null)
        : null;
  const selectedPersonaAvatar = representative
    ? await dependencies.getPersonaAvatarData(interaction, representative)
    : undefined;

  await interaction.editReply(
    withPersonaPanelAvatar(
      buildMemoriesPanelPayload({
        locale,
        category,
        selectedLineageId,
        personas: scope.personas,
        memoryCountsByLineage,
        selectedPersonaAvatarUrl: selectedPersonaAvatar?.url,
        memories,
        selectedDocumentPersonaId: category === "documents" ? selectedLineageId : undefined,
        documents,
        documentCount,
        documentChunkCount,
        documentChunks,
        documentCountsByPersona,
        eligibleHistoryPersonaIds,
        stmEntries,
        stmCount: stmEntries?.length,
        memteachingEnabled: scope.memteachingEnabled,
        canManage: scope.canManage,
        readStatus: scope.readStatus,
        page,
        receipt: panelReceipt,
      }),
      selectedPersonaAvatar,
    ),
  );
}

const defaultDependencies: MemoriesRouteDependencies = {
  resolveScope,
  loadMemories,
  getMemoryCountsByLineage,
  getPersonaAvatarData: resolvePersonaPanelAvatar,
  loadDocuments,
  loadDocumentMeta,
  loadDocumentChunks,
  getDocumentCounts,
  getDocumentCountsByPersona: (serverId) => serverMemoryRepository.documentCountsByPersona(serverId),
  getEligibleHistoryPersonaIds: (serverId) => serverMemoryRepository.personaIdsWithHistoryDocuments(serverId),
  getStmEntries,
  preWarmServerStm,
  operations: serverMemoriesOperations,
  documentOperations: serverDocumentsOperations,
  recordAction: (input) => {
    void recordPanelActionStat(input);
  },
  createNonce,
  showAddModal: (interaction, locale, lineageId, nonce) =>
    showRoutedRawModal(interaction, buildAddServerMemoryModal(locale, lineageId, nonce)),
  takeFileUpload: (interactionId, nonce) =>
    takeRawModalFileUpload(interactionId, buildServerMemoryModalFieldId("file", nonce)),
  takeDocumentFileUpload: (interactionId, nonce) =>
    takeRawModalFileUpload(interactionId, buildDocumentModalFieldId("file", nonce)),
  readUploadedText: readTxtUpload,
  showEditModal: (interaction, locale, lineageId, memory, nonce) =>
    showRoutedRawModal(
      interaction,
      buildEditServerMemoryModal(
        locale,
        lineageId,
        memory.server_memory_id ?? 0,
        memory.content,
        memory.tags ?? [],
        nonce,
      ),
    ),
  showAddDocumentModal: (interaction, locale, personaId, nonce) =>
    showRoutedRawModal(interaction, buildAddDocumentModal(locale, personaId, nonce)),
  showEditChunkModal: (interaction, locale, personaId, documentId, chunk, channelTags, nonce) =>
    showRoutedRawModal(
      interaction,
      buildEditDocumentChunkModal(locale, personaId, documentId, chunk.chunk_index, chunk.content, channelTags, nonce),
    ),
  showVectorizeModal: (interaction, locale, lineageId, personaId, memory, nonce) =>
    showRoutedRawModal(
      interaction,
      buildVectorizeMemoryModal(
        locale,
        lineageId,
        personaId,
        memory.server_memory_id ?? 0,
        memory.content,
        memory.tags ?? [],
        nonce,
      ),
    ),
  showStmModal: (interaction, locale, entries, fingerprint) =>
    showRoutedRawModal(interaction, buildServerStmModal(locale, entries, fingerprint)),
  takeCheckboxValues: takeRawModalCheckboxGroupValues,
  clearStm: clearShortTermMemoryForServerChannel,
};

export async function buildInitialMemoriesPanel(
  interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
  locale: string,
  dependencies: MemoriesRouteDependencies = defaultDependencies,
  requestedLineageId?: number,
): Promise<MemoriesPanelPayload> {
  const scope = await dependencies.resolveScope(interaction);
  if (!scope) {
    return buildMemoriesPanelPayload({
      locale,
      category: "memories",
      selectedLineageId: 0,
      personas: [],
      memories: [],
      canManage: !interaction.guildId || (interaction.memberPermissions?.has("ManageGuild") ?? false),
      readStatus: "unavailable",
      page: { kind: "main" },
    });
  }

  const requestedPersona =
    requestedLineageId === undefined
      ? undefined
      : scope.personas.find((persona) => persona.persona_lineage_id === requestedLineageId);
  const selectedLineageId = requestedPersona?.persona_lineage_id ?? scope.personas[0]?.persona_lineage_id ?? 0;
  const ownerFilter = scope.canManage ? undefined : scope.userId;
  const memories = selectedLineageId
    ? await dependencies.loadMemories(scope.serverId, selectedLineageId, ownerFilter)
    : [];
  const memoryCountsByLineage = await dependencies.getMemoryCountsByLineage(scope.serverId, ownerFilter);
  const representative = personaRepresentativeForLineage(scope.personas, selectedLineageId);
  const selectedPersonaAvatar = representative
    ? await dependencies.getPersonaAvatarData(interaction, representative)
    : undefined;

  return withPersonaPanelAvatar(
    buildMemoriesPanelPayload({
      locale,
      category: "memories",
      selectedLineageId,
      personas: scope.personas,
      memoryCountsByLineage,
      selectedPersonaAvatarUrl: selectedPersonaAvatar?.url,
      memories,
      canManage: scope.canManage,
      readStatus: scope.readStatus,
      page: { kind: "main" },
    }),
    selectedPersonaAvatar,
  );
}

export function createMemoriesInteractionRoute(
  overrides: Partial<MemoriesRouteDependencies> = {},
): GlobalInteractionRoute {
  const dependencies: MemoriesRouteDependencies = {
    ...defaultDependencies,
    ...overrides,
  };

  return {
    namespace: MEMORIES_ROUTE_NAMESPACE,
    version: MEMORIES_ROUTE_VERSION,
    async execute(_client, interaction, parsed): Promise<void> {
      const route = parseMemoriesPanelRoute(parsed);
      if (!route) throw new Error(`Malformed memories panel route: ${interaction.customId}`);

      // Modals and modal-opening select choices handle their own acknowledgement
      if (route.action === "select") {
        if (!interaction.isStringSelectMenu()) {
          throw new Error("Memories select route requires StringSelectMenu interaction");
        }
        const selectedValue = interaction.values[0];
        if (selectedValue === "action:add") {
          const cachedScope = await dependencies.resolveScope(interaction, false);
          if (!cachedScope) {
            await refuseInPlace(
              interaction,
              route.locale,
              null,
              "memories",
              route.lineageId,
              "write_failed",
              dependencies,
            );
            return;
          }
          if (cachedScope.isBlacklisted && !cachedScope.canManage) {
            await refuseInPlace(
              interaction,
              route.locale,
              cachedScope,
              "memories",
              route.lineageId,
              "blacklisted_error",
              dependencies,
            );
            return;
          }
          if (!cachedScope.memteachingEnabled && !cachedScope.canManage) {
            await refuseInPlace(
              interaction,
              route.locale,
              cachedScope,
              "memories",
              route.lineageId,
              "teaching_disabled_error",
              dependencies,
            );
            return;
          }
          const nonce = dependencies.createNonce();
          await dependencies.showAddModal(interaction, route.locale, route.lineageId, nonce);
          return;
        }
      }

      if (route.action === "edit-open") {
        if (!interaction.isButton()) {
          throw new Error("Memories edit-open route requires Button interaction");
        }
        const cachedScope = await dependencies.resolveScope(interaction, false);
        if (!cachedScope) {
          await refuseInPlace(
            interaction,
            route.locale,
            null,
            "memories",
            route.lineageId,
            "write_failed",
            dependencies,
          );
          return;
        }
        if (cachedScope.isBlacklisted && !cachedScope.canManage) {
          await refuseInPlace(
            interaction,
            route.locale,
            cachedScope,
            "memories",
            route.lineageId,
            "blacklisted_error",
            dependencies,
          );
          return;
        }
        const ownerFilter = cachedScope.canManage ? undefined : cachedScope.userId;
        const memories = await dependencies.loadMemories(cachedScope.serverId, route.lineageId, ownerFilter);
        const memory = memories.find((m) => m.server_memory_id === route.memoryId);
        if (!memory) {
          await interaction.deferUpdate();
          await repaint(
            interaction,
            route.locale,
            cachedScope,
            "memories",
            route.lineageId,
            memories,
            { kind: "main" },
            changedStateReceipt(route.locale),
            dependencies,
          );
          return;
        }
        const nonce = dependencies.createNonce();
        await dependencies.showEditModal(interaction, route.locale, route.lineageId, memory, nonce);
        return;
      }

      if (route.action === "document-select" && interaction.isStringSelectMenu()) {
        const selectedValue = interaction.values[0];
        if (selectedValue === "action:add-document") {
          const cachedScope = await dependencies.resolveScope(interaction, false);
          if (!cachedScope) {
            await refuseInPlace(
              interaction,
              route.locale,
              null,
              "documents",
              route.personaId,
              "write_failed",
              dependencies,
            );
            return;
          }
          if (!cachedScope.canManage && !cachedScope.memteachingEnabled) {
            await refuseInPlace(
              interaction,
              route.locale,
              cachedScope,
              "documents",
              route.personaId,
              "teaching_disabled_error",
              dependencies,
            );
            return;
          }
          if (cachedScope.isBlacklisted && !cachedScope.canManage) {
            await refuseInPlace(
              interaction,
              route.locale,
              cachedScope,
              "documents",
              route.personaId,
              "blacklisted_error",
              dependencies,
            );
            return;
          }
          if (
            route.personaId !== 0 &&
            !cachedScope.personas.some((persona) => persona.persona_id === route.personaId)
          ) {
            await refuseInPlace(
              interaction,
              route.locale,
              cachedScope,
              "documents",
              route.personaId,
              "changed_state",
              dependencies,
            );
            return;
          }
          await dependencies.showAddDocumentModal(
            interaction,
            route.locale,
            route.personaId,
            dependencies.createNonce(),
          );
          return;
        }
      }

      if (route.action === "document-chunk-edit-open") {
        if (!interaction.isButton()) throw new Error("Document chunk edit route requires Button interaction");
        const cachedScope = await dependencies.resolveScope(interaction, false);
        if (!cachedScope?.canManage) {
          await refuseInPlace(
            interaction,
            route.locale,
            cachedScope,
            "documents",
            route.personaId,
            "manager_only",
            dependencies,
          );
          return;
        }
        const personaId = route.personaId === 0 ? null : route.personaId;
        const [meta, chunks] = await Promise.all([
          dependencies.loadDocumentMeta(cachedScope.serverId, personaId, route.documentId),
          dependencies.loadDocumentChunks(cachedScope.serverId, personaId, route.documentId),
        ]);
        const chunk = chunks.find((candidate) => candidate.chunk_index === route.chunkIdx);
        if (!meta || !chunk || chunk.content.length > 4000) {
          await refuseInPlace(
            interaction,
            route.locale,
            cachedScope,
            "documents",
            route.personaId,
            "changed_state",
            dependencies,
          );
          return;
        }
        await dependencies.showEditChunkModal(
          interaction,
          route.locale,
          route.personaId,
          route.documentId,
          chunk,
          meta.channel_tags,
          dependencies.createNonce(),
        );
        return;
      }

      if (route.action === "vectorize-confirm") {
        if (!interaction.isButton()) throw new Error("Vectorize confirm route requires Button interaction");
        const cachedScope = await dependencies.resolveScope(interaction, false);
        if (!cachedScope) {
          await refuseInPlace(
            interaction,
            route.locale,
            null,
            "memories",
            route.lineageId,
            "write_failed",
            dependencies,
          );
          return;
        }
        if (cachedScope.isBlacklisted && !cachedScope.canManage) {
          await refuseInPlace(
            interaction,
            route.locale,
            cachedScope,
            "memories",
            route.lineageId,
            "blacklisted_error",
            dependencies,
          );
          return;
        }
        if (!cachedScope.memteachingEnabled && !cachedScope.canManage) {
          await refuseInPlace(
            interaction,
            route.locale,
            cachedScope,
            "memories",
            route.lineageId,
            "teaching_disabled_error",
            dependencies,
          );
          return;
        }
        const representativeMatches = cachedScope.personas.some(
          (persona) => persona.persona_id === route.personaId && persona.persona_lineage_id === route.lineageId,
        );
        const owner = cachedScope.canManage ? undefined : cachedScope.userId;
        const memories = representativeMatches
          ? await dependencies.loadMemories(cachedScope.serverId, route.lineageId, owner)
          : [];
        const memory = memories.find((candidate) => candidate.server_memory_id === route.memoryId);
        if (!memory) {
          await refuseInPlace(
            interaction,
            route.locale,
            cachedScope,
            "memories",
            route.lineageId,
            "changed_state",
            dependencies,
          );
          return;
        }
        await dependencies.showVectorizeModal(
          interaction,
          route.locale,
          route.lineageId,
          route.personaId,
          memory,
          dependencies.createNonce(),
        );
        return;
      }

      if (route.action === "stm-open") {
        if (!interaction.isButton()) throw new Error("STM manage route requires Button interaction");
        const cachedScope = await dependencies.resolveScope(interaction, false);
        if (!cachedScope?.canManage) {
          await refuseInPlace(interaction, route.locale, cachedScope, "stm", 0, "manager_only", dependencies);
          return;
        }
        await dependencies.preWarmServerStm(cachedScope.workspaceId);
        const entries = await dependencies.getStmEntries(cachedScope.workspaceId, cachedScope.personas, route.locale);
        // Repaint rather than reply: the Short-Term page already states the active count and the
        // ceiling, so the refreshed page is a better answer than a second, stray message.
        if (entries.length === 0 || entries.length > MAX_STM_MANAGEABLE_ENTRIES) {
          await interaction.deferUpdate();
          await repaint(
            interaction,
            route.locale,
            cachedScope,
            "stm",
            0,
            [],
            { kind: "main" },
            undefined,
            dependencies,
          );
          return;
        }
        const fingerprint = computeServerStmFingerprint(cachedScope.workspaceId, cachedScope.userDiscId, entries);
        await dependencies.showStmModal(interaction, route.locale, entries, fingerprint);
        return;
      }

      const initialScope = await beginPanelInteraction(interaction, {
        authorize: () => true,
        onDenied: () => Promise.resolve(),
        load: () => dependencies.resolveScope(interaction, route.action === "retry" || route.action === "refresh"),
        onMissing: () => interaction.editReply(terminalPayload(route.locale, "commands.memories.unavailable")),
      });
      if (!initialScope) return;
      let scope = initialScope;
      const ownerFilter = scope.canManage ? undefined : scope.userId;

      if (route.action === "category") {
        // Documents open on the serverwide scope, which is the sentinel 0 rather than a persona.
        const lineageId = route.category === "memories" ? (scope.personas[0]?.persona_lineage_id ?? 0) : 0;
        const memories =
          route.category === "memories" && lineageId
            ? await dependencies.loadMemories(scope.serverId, lineageId, ownerFilter)
            : [];
        await repaint(
          interaction,
          route.locale,
          scope,
          route.category,
          lineageId,
          memories,
          { kind: "main" },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "persona-select") {
        if (!interaction.isStringSelectMenu()) {
          throw new Error("Memories persona-select route requires StringSelectMenu interaction");
        }
        const selectedLineage = Number(interaction.values[0]);
        const validLineage = scope.personas.some((p) => p.persona_lineage_id === selectedLineage)
          ? selectedLineage
          : (scope.personas[0]?.persona_lineage_id ?? 0);
        const memories = validLineage ? await dependencies.loadMemories(scope.serverId, validLineage, ownerFilter) : [];
        await repaint(
          interaction,
          route.locale,
          scope,
          "memories",
          validLineage,
          memories,
          { kind: "main" },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "persona-page") {
        const validLineage = scope.personas.some((persona) => persona.persona_lineage_id === route.lineageId)
          ? route.lineageId
          : (scope.personas[0]?.persona_lineage_id ?? 0);
        const memories = validLineage ? await dependencies.loadMemories(scope.serverId, validLineage, ownerFilter) : [];
        await repaint(
          interaction,
          route.locale,
          scope,
          "memories",
          validLineage,
          memories,
          { kind: "main", personaRangeIndex: route.rangeIndex },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "select") {
        const memoryId = Number((interaction as StringSelectMenuInteraction).values[0]);
        const memories = await dependencies.loadMemories(scope.serverId, route.lineageId, ownerFilter);
        await repaint(
          interaction,
          route.locale,
          scope,
          "memories",
          route.lineageId,
          memories,
          { kind: "main", selectedMemoryId: memoryId, rangeIndex: route.rangeIndex },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "range-open") {
        const memories = await dependencies.loadMemories(scope.serverId, route.lineageId, ownerFilter);
        await repaint(
          interaction,
          route.locale,
          scope,
          "memories",
          route.lineageId,
          memories,
          { kind: "main", rangeIndex: 0 },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "range-page") {
        const memories = await dependencies.loadMemories(scope.serverId, route.lineageId, ownerFilter);
        await repaint(
          interaction,
          route.locale,
          scope,
          "memories",
          route.lineageId,
          memories,
          { kind: "main", rangeIndex: route.chooserPage },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "range-cancel") {
        const memories = await dependencies.loadMemories(scope.serverId, route.lineageId, ownerFilter);
        await repaint(
          interaction,
          route.locale,
          scope,
          "memories",
          route.lineageId,
          memories,
          { kind: "main" },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "range") {
        const memories = await dependencies.loadMemories(scope.serverId, route.lineageId, ownerFilter);
        await repaint(
          interaction,
          route.locale,
          scope,
          "memories",
          route.lineageId,
          memories,
          { kind: "main", rangeIndex: route.rangeIndex },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "document-scope" || route.action === "document-persona-select") {
        if (route.action === "document-persona-select" && !interaction.isStringSelectMenu()) {
          throw new Error("Document persona route requires StringSelectMenu interaction");
        }
        const submittedPersonaId =
          route.action === "document-persona-select"
            ? Number((interaction as StringSelectMenuInteraction).values[0])
            : route.personaId;
        const personaId =
          submittedPersonaId === 0 || scope.personas.some((persona) => persona.persona_id === submittedPersonaId)
            ? submittedPersonaId
            : 0;
        await repaint(
          interaction,
          route.locale,
          scope,
          "documents",
          personaId,
          [],
          { kind: "documents" },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "document-select") {
        if (!interaction.isStringSelectMenu()) {
          throw new Error("Document select route requires StringSelectMenu interaction");
        }
        const documentId = Number(interaction.values[0]);
        await repaint(
          interaction,
          route.locale,
          scope,
          "documents",
          route.personaId,
          [],
          { kind: "documents", selectedDocumentId: documentId, rangeIndex: route.rangeIndex },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "document-persona-page") {
        const personaId = scope.personas.some((persona) => persona.persona_id === route.personaId)
          ? route.personaId
          : (scope.personas.find((persona) => persona.persona_id)?.persona_id ?? 0);
        await repaint(
          interaction,
          route.locale,
          scope,
          "documents",
          personaId,
          [],
          { kind: "documents", personaRangeIndex: route.rangeIndex },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "document-range-open") {
        await repaint(
          interaction,
          route.locale,
          scope,
          "documents",
          route.personaId,
          [],
          { kind: "documents", rangeIndex: 0 },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "document-range-page") {
        await repaint(
          interaction,
          route.locale,
          scope,
          "documents",
          route.personaId,
          [],
          { kind: "documents", rangeIndex: route.chooserPage },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "document-range-cancel") {
        await repaint(
          interaction,
          route.locale,
          scope,
          "documents",
          route.personaId,
          [],
          { kind: "documents" },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "document-range") {
        await repaint(
          interaction,
          route.locale,
          scope,
          "documents",
          route.personaId,
          [],
          { kind: "documents", rangeIndex: route.rangeIndex },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "document-chunk-prev" || route.action === "document-chunk-next") {
        await repaint(
          interaction,
          route.locale,
          scope,
          "documents",
          route.personaId,
          [],
          { kind: "documents", selectedDocumentId: route.documentId, chunkIdx: route.chunkIdx },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "document-remove-prompt" || route.action === "history-remove-prompt") {
        await repaint(
          interaction,
          route.locale,
          scope,
          "documents",
          route.personaId,
          [],
          {
            kind: "document-remove",
            documentId: route.documentId,
            historyOnly: route.action === "history-remove-prompt",
          },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "document-remove-cancel" || route.action === "history-remove-cancel") {
        await repaint(
          interaction,
          route.locale,
          scope,
          "documents",
          route.personaId,
          [],
          { kind: "documents", selectedDocumentId: route.documentId },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "document-chunk-remove-prompt") {
        if (!scope.canManage) {
          await repaint(
            interaction,
            route.locale,
            scope,
            "documents",
            route.personaId,
            [],
            { kind: "documents", selectedDocumentId: route.documentId, chunkIdx: route.chunkIdx },
            receipt(route.locale, "manager_only"),
            dependencies,
          );
          return;
        }
        await repaint(
          interaction,
          route.locale,
          scope,
          "documents",
          route.personaId,
          [],
          { kind: "document-chunk-remove", documentId: route.documentId, chunkIdx: route.chunkIdx },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "document-chunk-remove-cancel") {
        await repaint(
          interaction,
          route.locale,
          scope,
          "documents",
          route.personaId,
          [],
          { kind: "documents", selectedDocumentId: route.documentId, chunkIdx: route.chunkIdx },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "vectorize-prompt") {
        const representativeMatches = scope.personas.some(
          (persona) => persona.persona_id === route.personaId && persona.persona_lineage_id === route.lineageId,
        );
        const memories = representativeMatches
          ? await dependencies.loadMemories(scope.serverId, route.lineageId, ownerFilter)
          : [];
        const target = memories.find((memory) => memory.server_memory_id === route.memoryId);
        await repaint(
          interaction,
          route.locale,
          scope,
          "memories",
          route.lineageId,
          memories,
          target ? { kind: "vectorize", memoryId: route.memoryId, personaId: route.personaId } : { kind: "main" },
          target ? undefined : changedStateReceipt(route.locale),
          dependencies,
        );
        return;
      }

      if (route.action === "vectorize-cancel") {
        const memories = await dependencies.loadMemories(scope.serverId, route.lineageId, ownerFilter);
        await repaint(
          interaction,
          route.locale,
          scope,
          "memories",
          route.lineageId,
          memories,
          { kind: "main", selectedMemoryId: route.memoryId },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "document-add-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const documentName = modal.fields.getTextInputValue(buildDocumentModalFieldId("name", route.nonce));
        let channels = "";
        try {
          channels = modal.fields.getTextInputValue(buildDocumentModalFieldId("channels", route.nonce));
        } catch {
          // Optional field
        }
        const personaId = route.personaId === 0 ? null : route.personaId;
        const personaMatches = personaId === null || scope.personas.some((persona) => persona.persona_id === personaId);
        if (!personaMatches) {
          await repaint(
            interaction,
            route.locale,
            scope,
            "documents",
            route.personaId,
            [],
            { kind: "documents" },
            changedStateReceipt(route.locale),
            dependencies,
          );
          return;
        }
        await repaint(
          interaction,
          route.locale,
          scope,
          "documents",
          route.personaId,
          [],
          { kind: "documents" },
          workingReceipt(route.locale, "document_working"),
          dependencies,
        );
        const action = await performPanelAction(
          () =>
            dependencies.documentOperations.add({
              serverId: scope.serverId,
              personaId,
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              workspaceId: scope.workspaceId,
              configuredEmbeddingModelId: scope.configuredEmbeddingModelId,
              isBlacklisted: scope.isBlacklisted,
              canManage: scope.canManage,
              memteachingEnabled: scope.memteachingEnabled,
              documentName,
              attachment: dependencies.takeDocumentFileUpload(interaction.id, route.nonce),
              channelTags: parseDocumentChannelTags(channels, interaction),
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        scope = action.state ?? scope;
        const result = action.result;
        if (result.status === "success") {
          dependencies.recordAction({
            action: "memories.workspace.document.add",
            serverId: scope.serverId,
            userDiscId: scope.userDiscId,
          });
        }
        await repaint(
          interaction,
          route.locale,
          scope,
          "documents",
          route.personaId,
          [],
          {
            kind: "documents",
            selectedDocumentId: result.status === "success" ? result.documentId : undefined,
          },
          result.status === "success"
            ? receipt(route.locale, "document_added", {
                name: result.documentName,
                chunks: result.chunkCount,
              })
            : documentResultReceipt(route.locale, result.status, {
                maxSize: getMemoryLimits().maxDocumentSizeMB,
                maxText: getMemoryLimits().maxDocumentTextLength,
                maxChunks: getMemoryLimits().maxDocumentChunks,
                maxDocuments: getMemoryLimits().maxDocumentsPerServer,
                maxTotalChunks: getMemoryLimits().maxDocumentChunksPerServer,
              }),
          dependencies,
        );
        return;
      }

      if (route.action === "document-remove-confirm" || route.action === "history-remove-confirm") {
        const personaId = route.personaId === 0 ? null : route.personaId;
        const documentsBeforeRemoval = [...(await dependencies.loadDocuments(scope.serverId, personaId))];
        const action = await performPanelAction(
          () =>
            dependencies.documentOperations.remove({
              serverId: scope.serverId,
              personaId,
              documentId: route.documentId,
              workspaceId: scope.workspaceId,
              canManage: scope.canManage,
              memteachingEnabled: scope.memteachingEnabled,
              historyOnly: route.action === "history-remove-confirm",
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        scope = action.state ?? scope;
        const result = action.result;
        if (result.status === "success") {
          dependencies.recordAction({
            action:
              route.action === "history-remove-confirm"
                ? "memories.workspace.history-document.remove"
                : "memories.workspace.document.remove",
            serverId: scope.serverId,
            userDiscId: scope.userDiscId,
          });
        }
        const rangeIndex =
          result.status === "success"
            ? rangeIndexAfterRemoval(
                documentsBeforeRemoval,
                route.documentId,
                (document) => document.document_id,
                Math.max(0, documentsBeforeRemoval.length - 1),
                MAX_DOCUMENT_PAGE_SIZE,
              )
            : undefined;
        await repaint(
          interaction,
          route.locale,
          scope,
          "documents",
          route.personaId,
          [],
          rangeIndex === undefined ? { kind: "documents" } : { kind: "documents", rangeIndex },
          result.status === "success"
            ? receipt(route.locale, "document_removed", { name: result.documentName })
            : documentResultReceipt(route.locale, result.status),
          dependencies,
        );
        return;
      }

      if (route.action === "document-chunk-edit-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const content = modal.fields.getTextInputValue(buildDocumentModalFieldId("content", route.nonce));
        let channels = "";
        try {
          channels = modal.fields.getTextInputValue(buildDocumentModalFieldId("channels", route.nonce));
        } catch {
          // Optional field
        }
        const action = await performPanelAction(
          () =>
            dependencies.documentOperations.editChunk({
              serverId: scope.serverId,
              personaId: route.personaId === 0 ? null : route.personaId,
              documentId: route.documentId,
              chunkIdx: route.chunkIdx,
              workspaceId: scope.workspaceId,
              userId: scope.userId,
              configuredEmbeddingModelId: scope.configuredEmbeddingModelId,
              canManage: scope.canManage,
              content,
              channelTags: parseDocumentChannelTags(channels, interaction),
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        scope = action.state ?? scope;
        const result = action.result;
        if (result.status === "success") {
          dependencies.recordAction({
            action: "memories.workspace.document-chunk.edit",
            serverId: scope.serverId,
            userDiscId: scope.userDiscId,
          });
        }
        await repaint(
          interaction,
          route.locale,
          scope,
          "documents",
          route.personaId,
          [],
          { kind: "documents", selectedDocumentId: route.documentId, chunkIdx: route.chunkIdx },
          result.status === "success"
            ? receipt(route.locale, "document_chunk_edited")
            : documentResultReceipt(route.locale, result.status),
          dependencies,
        );
        return;
      }

      if (route.action === "document-chunk-remove-confirm") {
        const personaId = route.personaId === 0 ? null : route.personaId;
        const documentsBeforeRemoval = [...(await dependencies.loadDocuments(scope.serverId, personaId))];
        const action = await performPanelAction(
          () =>
            dependencies.documentOperations.removeChunk({
              serverId: scope.serverId,
              personaId,
              documentId: route.documentId,
              chunkIdx: route.chunkIdx,
              workspaceId: scope.workspaceId,
              canManage: scope.canManage,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        scope = action.state ?? scope;
        const result = action.result;
        if (result.status === "success") {
          dependencies.recordAction({
            action: "memories.workspace.document-chunk.remove",
            serverId: scope.serverId,
            userDiscId: scope.userDiscId,
          });
        }
        const rangeIndex =
          result.status === "success"
            ? rangeIndexAfterRemoval(
                documentsBeforeRemoval,
                route.documentId,
                (document) => document.document_id,
                result.removedDocument ? Math.max(0, documentsBeforeRemoval.length - 1) : documentsBeforeRemoval.length,
                MAX_DOCUMENT_PAGE_SIZE,
              )
            : undefined;
        await repaint(
          interaction,
          route.locale,
          scope,
          "documents",
          route.personaId,
          [],
          result.status === "success" && !result.removedDocument
            ? rangeIndex === undefined
              ? { kind: "documents", selectedDocumentId: route.documentId }
              : { kind: "documents", selectedDocumentId: route.documentId, rangeIndex }
            : rangeIndex === undefined
              ? { kind: "documents" }
              : { kind: "documents", rangeIndex },
          result.status === "success"
            ? receipt(
                route.locale,
                result.removedDocument ? "document_removed_with_last_chunk" : "document_chunk_removed",
              )
            : documentResultReceipt(route.locale, result.status),
          dependencies,
        );
        return;
      }

      if (route.action === "vectorize-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const content = modal.fields.getTextInputValue(buildDocumentModalFieldId("content", route.nonce));
        const documentName = modal.fields.getTextInputValue(buildDocumentModalFieldId("name", route.nonce));
        let channels = "";
        try {
          channels = modal.fields.getTextInputValue(buildDocumentModalFieldId("channels", route.nonce));
        } catch {
          // Optional field
        }
        const personaMatches = scope.personas.some(
          (persona) => persona.persona_id === route.personaId && persona.persona_lineage_id === route.lineageId,
        );
        if (!personaMatches) {
          const memories = await dependencies.loadMemories(scope.serverId, route.lineageId, ownerFilter);
          await repaint(
            interaction,
            route.locale,
            scope,
            "memories",
            route.lineageId,
            memories,
            { kind: "main" },
            changedStateReceipt(route.locale),
            dependencies,
          );
          return;
        }
        await repaint(
          interaction,
          route.locale,
          scope,
          "memories",
          route.lineageId,
          await dependencies.loadMemories(scope.serverId, route.lineageId, ownerFilter),
          { kind: "main" },
          workingReceipt(route.locale, "vectorize_working"),
          dependencies,
        );
        const action = await performPanelAction(
          () =>
            dependencies.documentOperations.vectorize({
              serverId: scope.serverId,
              personaId: route.personaId,
              personaLineageId: route.lineageId,
              memoryId: route.memoryId,
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              workspaceId: scope.workspaceId,
              configuredEmbeddingModelId: scope.configuredEmbeddingModelId,
              isBlacklisted: scope.isBlacklisted,
              canManage: scope.canManage,
              memteachingEnabled: scope.memteachingEnabled,
              content,
              documentName,
              channelTags: parseDocumentChannelTags(channels, interaction),
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        scope = action.state ?? scope;
        const result = action.result;
        const currentOwner = scope.canManage ? undefined : scope.userId;
        const memories = await dependencies.loadMemories(scope.serverId, route.lineageId, currentOwner);
        if (result.status === "success") {
          dependencies.recordAction({
            action: "memories.workspace.memory.vectorize",
            serverId: scope.serverId,
            userDiscId: scope.userDiscId,
          });
        }
        await repaint(
          interaction,
          route.locale,
          scope,
          "memories",
          route.lineageId,
          memories,
          { kind: "main" },
          result.status === "success"
            ? receipt(route.locale, "vectorized", {
                name: result.documentName,
                chunks: result.chunkCount,
              })
            : result.status === "partial-failure"
              ? receipt(route.locale, "vectorize_partial_failure", { name: result.documentName })
              : documentResultReceipt(route.locale, result.status),
          dependencies,
        );
        return;
      }

      if (route.action === "stm-submit") {
        if (!scope.canManage) {
          await repaint(
            interaction,
            route.locale,
            scope,
            "stm",
            0,
            [],
            { kind: "main" },
            receipt(route.locale, "manager_only"),
            dependencies,
          );
          return;
        }
        await dependencies.preWarmServerStm(scope.workspaceId);
        const entries = await dependencies.getStmEntries(scope.workspaceId, scope.personas, route.locale);
        const fingerprint = computeServerStmFingerprint(scope.workspaceId, scope.userDiscId, entries);
        if (fingerprint !== route.nonce || entries.length > MAX_STM_MANAGEABLE_ENTRIES) {
          await repaint(
            interaction,
            route.locale,
            scope,
            "stm",
            0,
            [],
            { kind: "main" },
            receipt(route.locale, "stm_changed_state"),
            dependencies,
          );
          return;
        }
        const checked = new Set<string>();
        const groupCount = Math.ceil(entries.length / MAX_STM_OPTIONS_PER_GROUP);
        for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
          for (const value of dependencies.takeCheckboxValues(
            interaction.id,
            buildStmCheckboxFieldId(groupIndex, route.nonce),
          ) ?? []) {
            const parsedValue = parseInteractionRoute(value);
            const entryRoute = parsedValue ? parseMemoriesPanelRoute(parsedValue) : null;
            if (entryRoute?.action === "stm-entry") {
              checked.add(`${entryRoute.channelId}:${entryRoute.personaId}`);
            }
          }
        }
        const toClear = entries.filter((entry) => !checked.has(`${entry.channelId}:${entry.personaId ?? 0}`));
        for (const entry of toClear) {
          dependencies.clearStm(scope.workspaceId, entry.channelId, entry.personaId ?? null);
        }
        if (toClear.length > 0) {
          dependencies.recordAction({
            action: "memories.workspace.stm.clear",
            serverId: scope.serverId,
            userDiscId: scope.userDiscId,
          });
        }
        await repaint(
          interaction,
          route.locale,
          scope,
          "stm",
          0,
          [],
          { kind: "main" },
          toClear.length > 0
            ? receipt(route.locale, "stm_cleared", { count: toClear.length })
            : noChangesReceipt(route.locale),
          dependencies,
        );
        return;
      }

      if (route.action === "add-submit") {
        const modal = interaction as ModalSubmitInteraction;
        let content = "";
        try {
          content = modal.fields.getTextInputValue(buildServerMemoryModalFieldId("content", route.nonce));
        } catch {
          // Optional when file is uploaded
        }
        let tagsRaw = "";
        try {
          tagsRaw = modal.fields.getTextInputValue(buildServerMemoryModalFieldId("tags", route.nonce));
        } catch {
          // Field optional
        }
        const tags = parseServerMemoryTags(tagsRaw);
        const uploadedFile = dependencies.takeFileUpload(interaction.id, route.nonce);

        const representative = personaRepresentativeForLineage(scope.personas, route.lineageId);
        const personaId = representative?.persona_id;

        if (!personaId) {
          const memories = await dependencies.loadMemories(scope.serverId, route.lineageId, ownerFilter);
          await repaint(
            interaction,
            route.locale,
            scope,
            "memories",
            route.lineageId,
            memories,
            { kind: "main" },
            receipt(route.locale, "write_failed"),
            dependencies,
          );
          return;
        }

        if (uploadedFile) {
          const upload = await dependencies.readUploadedText(uploadedFile);
          if (!upload.isValid || !upload.text) {
            const memories = await dependencies.loadMemories(scope.serverId, route.lineageId, ownerFilter);
            await repaint(
              interaction,
              route.locale,
              scope,
              "memories",
              route.lineageId,
              memories,
              { kind: "main" },
              receipt(route.locale, upload.error === "file_too_large" ? "batch_file_too_large" : "batch_file_invalid"),
              dependencies,
            );
            return;
          }

          const uploaded = getNonEmptyNumberedLines(upload.text).map((line) => line.content);
          const typed = content.trim();
          const batchAction = await performPanelAction(
            () =>
              dependencies.operations.addBatch({
                serverId: scope.serverId,
                personaId,
                personaLineageId: route.lineageId,
                taughtByUserId: scope.userId,
                workspaceId: scope.workspaceId,
                isBlacklisted: scope.isBlacklisted,
                canManage: scope.canManage,
                memteachingEnabled: scope.memteachingEnabled,
                contents: typed ? [typed, ...uploaded] : uploaded,
                tags,
              }),
            () => dependencies.resolveScope(interaction, true),
          );
          const batchResult = batchAction.result;
          scope = batchAction.state ?? scope;
          const currentOwnerFilter = scope.canManage ? undefined : scope.userId;
          const memories = await dependencies.loadMemories(scope.serverId, route.lineageId, currentOwnerFilter);

          if (batchResult.status === "success") {
            dependencies.recordAction({
              action: "memories.workspace.memory.add",
              serverId: scope.serverId,
              userDiscId: interaction.user.id,
            });
            await repaint(
              interaction,
              route.locale,
              scope,
              "memories",
              route.lineageId,
              memories,
              { kind: "main" },
              receipt(route.locale, "batch_added", {
                added: batchResult.added,
                skipped: batchResult.skipped,
              }),
              dependencies,
            );
            return;
          }

          const batchReceiptByStatus: Record<string, string> = {
            blacklisted: "blacklisted_error",
            "teaching-disabled": "teaching_disabled_error",
            "empty-content": "empty_content",
            "content-too-long": "content_too_long",
            "all-duplicates": "batch_all_duplicates",
            "batch-limit-reached": "batch_limit_reached",
            "write-failed": "write_failed",
          };
          await repaint(
            interaction,
            route.locale,
            scope,
            "memories",
            route.lineageId,
            memories,
            { kind: "main" },
            receipt(route.locale, batchReceiptByStatus[batchResult.status] ?? "write_failed", {
              max: getMemoryLimits().maxServerMemories,
              available: batchResult.status === "batch-limit-reached" ? batchResult.available : 0,
              requested: batchResult.status === "batch-limit-reached" ? batchResult.requested : 0,
            }),
            dependencies,
          );
          return;
        }

        const action = await performPanelAction(
          () =>
            dependencies.operations.add({
              serverId: scope.serverId,
              personaId,
              personaLineageId: route.lineageId,
              taughtByUserId: scope.userId,
              workspaceId: scope.workspaceId,
              isBlacklisted: scope.isBlacklisted,
              canManage: scope.canManage,
              memteachingEnabled: scope.memteachingEnabled,
              content,
              tags,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;
        const currentOwnerFilter = scope.canManage ? undefined : scope.userId;
        const memories = await dependencies.loadMemories(scope.serverId, route.lineageId, currentOwnerFilter);

        if (result.status === "success") {
          dependencies.recordAction({
            action: "memories.workspace.memory.add",
            serverId: scope.serverId,
            userDiscId: interaction.user.id,
          });
          await repaint(
            interaction,
            route.locale,
            scope,
            "memories",
            route.lineageId,
            memories,
            { kind: "main", selectedMemoryId: result.row.server_memory_id },
            receipt(route.locale, "added", { memory: result.row.content }),
            dependencies,
          );
          return;
        }

        const receiptByStatus: Record<string, string> = {
          blacklisted: "blacklisted_error",
          "teaching-disabled": "teaching_disabled_error",
          "empty-content": "empty_content",
          "content-too-long": "content_too_long",
          "limit-reached": "limit_reached",
          "write-failed": "write_failed",
        };
        await repaint(
          interaction,
          route.locale,
          scope,
          "memories",
          route.lineageId,
          memories,
          { kind: "main" },
          receipt(route.locale, receiptByStatus[result.status] ?? "write_failed", {
            max: getMemoryLimits().maxServerMemories,
          }),
          dependencies,
        );
        return;
      }

      if (route.action === "edit-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const content = modal.fields.getTextInputValue(buildServerMemoryModalFieldId("content", route.nonce));
        let tagsRaw = "";
        try {
          tagsRaw = modal.fields.getTextInputValue(buildServerMemoryModalFieldId("tags", route.nonce));
        } catch {
          // Field optional
        }
        const tags = parseServerMemoryTags(tagsRaw);

        const action = await performPanelAction(
          () =>
            dependencies.operations.edit({
              serverId: scope.serverId,
              personaLineageId: route.lineageId,
              taughtByUserId: scope.userId,
              memoryId: route.memoryId,
              workspaceId: scope.workspaceId,
              isBlacklisted: scope.isBlacklisted,
              canManage: scope.canManage,
              memteachingEnabled: scope.memteachingEnabled,
              content,
              tags,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;
        const currentOwnerFilter = scope.canManage ? undefined : scope.userId;
        const memories = await dependencies.loadMemories(scope.serverId, route.lineageId, currentOwnerFilter);

        if (result.status === "success") {
          dependencies.recordAction({
            action: "memories.workspace.memory.edit",
            serverId: scope.serverId,
            userDiscId: interaction.user.id,
          });
          await repaint(
            interaction,
            route.locale,
            scope,
            "memories",
            route.lineageId,
            memories,
            { kind: "main", selectedMemoryId: result.row.server_memory_id },
            receipt(route.locale, "edited", { memory: result.row.content }),
            dependencies,
          );
          return;
        }

        if (result.status === "unchanged") {
          await repaint(
            interaction,
            route.locale,
            scope,
            "memories",
            route.lineageId,
            memories,
            { kind: "main", selectedMemoryId: route.memoryId },
            noChangesReceipt(route.locale),
            dependencies,
          );
          return;
        }

        if (result.status === "not-found") {
          await repaint(
            interaction,
            route.locale,
            scope,
            "memories",
            route.lineageId,
            memories,
            { kind: "main" },
            changedStateReceipt(route.locale),
            dependencies,
          );
          return;
        }

        const receiptByStatus: Record<string, string> = {
          blacklisted: "blacklisted_error",
          "teaching-disabled": "teaching_disabled_error",
          "empty-content": "empty_content",
          "content-too-long": "content_too_long",
          "write-failed": "write_failed",
        };
        await repaint(
          interaction,
          route.locale,
          scope,
          "memories",
          route.lineageId,
          memories,
          { kind: "main", selectedMemoryId: route.memoryId },
          receipt(route.locale, receiptByStatus[result.status] ?? "write_failed", {
            max: getMemoryLimits().maxServerMemories,
          }),
          dependencies,
        );
        return;
      }

      if (route.action === "remove-prompt") {
        const memories = await dependencies.loadMemories(scope.serverId, route.lineageId, ownerFilter);
        const target = memories.find((m) => m.server_memory_id === route.memoryId);
        await repaint(
          interaction,
          route.locale,
          scope,
          "memories",
          route.lineageId,
          memories,
          target ? { kind: "remove", memoryId: route.memoryId } : { kind: "main" },
          target ? undefined : changedStateReceipt(route.locale),
          dependencies,
        );
        return;
      }

      if (route.action === "remove-cancel") {
        const memories = await dependencies.loadMemories(scope.serverId, route.lineageId, ownerFilter);
        await repaint(
          interaction,
          route.locale,
          scope,
          "memories",
          route.lineageId,
          memories,
          { kind: "main", selectedMemoryId: route.memoryId },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "remove-confirm") {
        const memoriesBeforeRemoval = [
          ...(await dependencies.loadMemories(scope.serverId, route.lineageId, ownerFilter)),
        ];
        const action = await performPanelAction(
          () =>
            dependencies.operations.remove({
              serverId: scope.serverId,
              personaLineageId: route.lineageId,
              taughtByUserId: scope.userId,
              memoryId: route.memoryId,
              workspaceId: scope.workspaceId,
              isBlacklisted: scope.isBlacklisted,
              canManage: scope.canManage,
              memteachingEnabled: scope.memteachingEnabled,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;
        const currentOwnerFilter = scope.canManage ? undefined : scope.userId;
        const memories = await dependencies.loadMemories(scope.serverId, route.lineageId, currentOwnerFilter);

        if (result.status === "success") {
          dependencies.recordAction({
            action: "memories.workspace.memory.remove",
            serverId: scope.serverId,
            userDiscId: interaction.user.id,
          });
          const rangeIndex =
            rangeIndexAfterRemoval(
              memoriesBeforeRemoval,
              route.memoryId,
              (memory) => memory.server_memory_id ?? 0,
              memories.length,
              MAX_SERVER_MEMORY_PAGE_SIZE,
            ) ?? 0;
          await repaint(
            interaction,
            route.locale,
            scope,
            "memories",
            route.lineageId,
            memories,
            { kind: "main", rangeIndex },
            receipt(route.locale, "removed", { memory: result.row.content }),
            dependencies,
          );
          return;
        }

        await repaint(
          interaction,
          route.locale,
          scope,
          "memories",
          route.lineageId,
          memories,
          { kind: "main" },
          result.status === "not-found"
            ? changedStateReceipt(route.locale)
            : receipt(route.locale, result.status === "teaching-disabled" ? "teaching_disabled_error" : "write_failed"),
          dependencies,
        );
        return;
      }

      if (route.action === "retry" || route.action === "refresh") {
        const lineageId =
          route.category === "documents" ? 0 : (route.lineageId ?? scope.personas[0]?.persona_lineage_id ?? 0);
        const memories =
          route.category === "memories" && lineageId
            ? await dependencies.loadMemories(scope.serverId, lineageId, ownerFilter)
            : [];
        await repaint(
          interaction,
          route.locale,
          scope,
          route.category,
          lineageId,
          memories,
          route.category === "documents" ? { kind: "documents" } : { kind: "main" },
          undefined,
          dependencies,
        );
        return;
      }
    },
  };
}

export const memoriesInteractionRoute = createMemoriesInteractionRoute();
