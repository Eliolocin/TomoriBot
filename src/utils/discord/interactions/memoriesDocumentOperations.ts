import type { APIAttachment } from "discord.js";
import type { ServerMemoryRow } from "@/types/db/schema";
import { invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { isRagAvailable } from "@/utils/db/ragAvailability";
import { llmModelRepo, ragRepository, serverMemoryRepository } from "@/utils/db/repositories";
import { rebuildDocumentTextContent } from "@/utils/documents/documentService";
import { extractTextFromBuffer } from "@/utils/documents/textExtractor";
import { generateEmbeddingsBatched, providerSupportsEmbeddingTaskType } from "@/utils/embeddings/embeddingProvider";
import { getMemoryLimits, validateMemoryContent } from "@/utils/misc/memoryLimits";
import {
  CredentialUnavailableError,
  getResolvedCapabilityModelId,
  PersonalProviderRequiredError,
  resolveCapabilityCredentials,
} from "@/utils/provider/credentialResolver";
import { memoryGuard, reserveDocumentQuota } from "@/utils/security/rateLimiter";
import { safeDownload } from "@/utils/security/safeDownload";

export interface DocumentListRow {
  document_id: number;
  document_name: string;
  first_chunk: string | null;
  isHistory: boolean;
}

export interface DocumentChunkRow {
  document_chunk_id: number;
  chunk_index: number;
  content: string;
}

export type DocumentWriteResult =
  | { status: "blacklisted" | "teaching-disabled" | "rag-disabled" | "memory-critical" }
  | { status: "invalid-name" | "invalid-file" | "file-too-large" | "download-failed" }
  | { status: "empty-content" | "content-too-long" | "too-many-chunks" | "document-limit" | "chunk-limit" }
  | { status: "duplicate" | "quota-exceeded" | "credentials-missing" | "model-missing" | "not-found" }
  | { status: "write-failed" }
  | { status: "success"; documentId: number; documentName: string; chunkCount: number };

export interface AddDocumentInput {
  serverId: number;
  personaId: number | null;
  userId: number;
  userDiscId: string;
  workspaceId: string;
  configuredEmbeddingModelId: number | null;
  isBlacklisted: boolean;
  canManage: boolean;
  memteachingEnabled: boolean;
  documentName: string;
  attachment: APIAttachment | undefined;
  channelTags: string[];
}

export interface VectorizeMemoryInput {
  serverId: number;
  personaId: number;
  personaLineageId: number;
  memoryId: number;
  userId: number;
  userDiscId: string;
  workspaceId: string;
  configuredEmbeddingModelId: number | null;
  isBlacklisted: boolean;
  canManage: boolean;
  memteachingEnabled: boolean;
  content: string;
  documentName: string;
  channelTags: string[];
}

export type VectorizeMemoryResult =
  | DocumentWriteResult
  | { status: "partial-failure"; documentId: number; documentName: string; chunkCount: number };

export type DocumentRemoveResult =
  | { status: "teaching-disabled" | "not-found" | "write-failed" }
  | { status: "success"; documentName: string };

export type ChunkEditResult =
  | { status: "forbidden" | "not-found" | "empty-content" | "content-too-long" }
  | { status: "credentials-missing" | "model-missing" | "write-failed" | "unchanged" }
  | { status: "success" };

export type ChunkRemoveResult =
  | { status: "forbidden" | "not-found" | "write-failed" }
  | { status: "success"; removedDocument: boolean };

function validAttachment(attachment: APIAttachment): boolean {
  const filename = attachment.filename.toLowerCase();
  const extensionAllowed = [".txt", ".md", ".pdf"].some((extension) => filename.endsWith(extension));
  const contentTypeAllowed = ["text/plain", "text/markdown", "application/pdf"].includes(attachment.content_type ?? "");
  return extensionAllowed || contentTypeAllowed;
}

async function resolveEmbedding(serverId: number, userId: number, configuredModelId: number | null) {
  try {
    const credentials = await resolveCapabilityCredentials(serverId, "embedding", { userId });
    const modelId = getResolvedCapabilityModelId(credentials, "embedding") ?? configuredModelId;
    if (!modelId) return { status: "model-missing" as const };
    const model = await llmModelRepo.loadEmbeddingModelById(modelId);
    if (!model?.embedding_model_id) return { status: "model-missing" as const };
    return { status: "success" as const, credentials, model, embeddingModelId: model.embedding_model_id };
  } catch (error) {
    if (error instanceof PersonalProviderRequiredError || error instanceof CredentialUnavailableError) {
      return { status: "credentials-missing" as const };
    }
    throw error;
  }
}

async function embedChunks(
  chunks: string[],
  resolved: Extract<Awaited<ReturnType<typeof resolveEmbedding>>, { status: "success" }>,
): Promise<number[][]> {
  return generateEmbeddingsBatched({
    provider: resolved.model.provider,
    apiKey: resolved.credentials.apiKey,
    model: resolved.model.codename,
    modelId: resolved.model.embedding_model_id,
    inputs: chunks,
    taskType: (await providerSupportsEmbeddingTaskType(resolved.model.provider)) ? "RETRIEVAL_DOCUMENT" : undefined,
    batchSize: 16,
  });
}

export const serverDocumentsOperations = {
  async add(input: AddDocumentInput): Promise<DocumentWriteResult> {
    if (input.isBlacklisted && !input.canManage) return { status: "blacklisted" };
    if (!input.memteachingEnabled && !input.canManage) return { status: "teaching-disabled" };
    if (!isRagAvailable()) return { status: "rag-disabled" };
    if (memoryGuard.checkMemory().status === "critical") return { status: "memory-critical" };

    const documentName = input.documentName.trim();
    if (!documentName || documentName.length > 64) return { status: "invalid-name" };
    if (!input.attachment || !validAttachment(input.attachment)) return { status: "invalid-file" };

    const limits = getMemoryLimits();
    if (input.attachment.size > limits.maxDocumentSizeMB * 1024 * 1024) return { status: "file-too-large" };
    if (await serverMemoryRepository.documentExistsByName(input.serverId, input.personaId, documentName)) {
      return { status: "duplicate" };
    }
    if (
      (await serverMemoryRepository.countDocumentsScoped(input.serverId, input.personaId)) >=
      limits.maxDocumentsPerServer
    ) {
      return { status: "document-limit" };
    }

    const resolved = await resolveEmbedding(input.serverId, input.userId, input.configuredEmbeddingModelId);
    if (resolved.status !== "success") return resolved;

    const download = await safeDownload(input.attachment.url, {
      maxSizeMB: limits.maxDocumentSizeMB,
      timeoutMs: 20000,
      knownSize: input.attachment.size,
    });
    if (!download.success || !download.buffer) return { status: "download-failed" };

    const extracted = await extractTextFromBuffer(
      download.buffer,
      input.attachment.filename,
      input.attachment.content_type,
    );
    const normalized = ragRepository.normalizeText(extracted);
    if (!normalized) return { status: "empty-content" };
    if (normalized.length > limits.maxDocumentTextLength) return { status: "content-too-long" };

    const chunks = ragRepository.chunkText(normalized, limits.documentChunkSize, limits.documentChunkOverlap);
    if (chunks.length === 0) return { status: "empty-content" };
    if (chunks.length > limits.maxDocumentChunks) return { status: "too-many-chunks" };
    const existingChunks = await serverMemoryRepository.countChunksScoped(input.serverId, input.personaId);
    if (existingChunks + chunks.length > limits.maxDocumentChunksPerServer) return { status: "chunk-limit" };

    if (!reserveDocumentQuota(input.userDiscId).allowed) return { status: "quota-exceeded" };
    const embeddings = await embedChunks(chunks, resolved);
    const documentId = await ragRepository.insertWithChunks({
      serverId: input.serverId,
      personaId: input.personaId,
      uploaderUserId: input.userId,
      documentName,
      fileName: input.attachment.filename,
      mimeType: input.attachment.content_type ?? null,
      fileSizeBytes: input.attachment.size,
      textContent: normalized,
      chunks,
      embeddings,
      embeddingModelId: resolved.embeddingModelId,
      embeddingFamily: resolved.model.model_family,
      channelTags: input.channelTags,
    });
    invalidateTomoriStateCache(input.workspaceId);
    return { status: "success", documentId, documentName, chunkCount: chunks.length };
  },

  async remove(input: {
    serverId: number;
    personaId: number | null;
    documentId: number;
    workspaceId: string;
    canManage: boolean;
    memteachingEnabled: boolean;
    historyOnly: boolean;
  }): Promise<DocumentRemoveResult> {
    if (!input.memteachingEnabled && !input.canManage) return { status: "teaching-disabled" };
    const documents = input.historyOnly
      ? await serverMemoryRepository.loadHistoryDocuments(input.serverId, input.personaId)
      : await serverMemoryRepository.loadDocuments(input.serverId, input.personaId);
    if (!documents.some((document) => document.document_id === input.documentId)) return { status: "not-found" };
    const documentName = input.historyOnly
      ? await serverMemoryRepository.removeHistoryDocument(input.documentId, input.serverId, input.personaId)
      : await serverMemoryRepository.removeDocument(input.documentId, input.serverId, input.personaId);
    if (!documentName) return { status: "write-failed" };
    invalidateTomoriStateCache(input.workspaceId);
    return { status: "success", documentName };
  },

  async editChunk(input: {
    serverId: number;
    personaId: number | null;
    documentId: number;
    chunkIdx: number;
    workspaceId: string;
    userId: number;
    configuredEmbeddingModelId: number | null;
    canManage: boolean;
    content: string;
    channelTags: string[];
  }): Promise<ChunkEditResult> {
    if (!input.canManage) return { status: "forbidden" };
    const meta = await serverMemoryRepository.loadDocumentMeta(input.documentId, input.serverId, input.personaId);
    const chunks = await serverMemoryRepository.loadDocumentChunks(input.documentId, input.serverId, input.personaId);
    const target = chunks.find((chunk) => chunk.chunk_index === input.chunkIdx);
    if (!meta || !target) return { status: "not-found" };
    const content = input.content.trim();
    if (!content) return { status: "empty-content" };
    if (content.length > 4000) return { status: "content-too-long" };
    const contentChanged = content !== target.content;
    const normalizedCurrentTags = [...meta.channel_tags].sort();
    const normalizedNextTags = [...input.channelTags].sort();
    const tagsChanged = normalizedCurrentTags.join("\u0000") !== normalizedNextTags.join("\u0000");
    if (!contentChanged && !tagsChanged) return { status: "unchanged" };
    if (contentChanged) {
      const resolved = await resolveEmbedding(input.serverId, input.userId, input.configuredEmbeddingModelId);
      if (resolved.status !== "success") return resolved;
      const [embedding] = await embedChunks([content], resolved);
      if (!embedding) return { status: "write-failed" };
      const updated = await serverMemoryRepository.updateChunk({
        chunkId: target.document_chunk_id,
        serverId: input.serverId,
        personaId: input.personaId,
        content,
        embeddingVector: ragRepository.formatVector(embedding),
        embeddingModelId: resolved.embeddingModelId,
        embeddingFamily: resolved.model.model_family,
      });
      if (!updated) return { status: "write-failed" };
      invalidateTomoriStateCache(input.workspaceId);
      await rebuildDocumentTextContent(input.documentId);
      invalidateTomoriStateCache(input.workspaceId);
    }
    if (tagsChanged) {
      const updated = await serverMemoryRepository.updateDocumentChannelTags(
        input.documentId,
        input.serverId,
        input.channelTags,
        input.personaId,
      );
      if (!updated) return { status: "write-failed" };
      invalidateTomoriStateCache(input.workspaceId);
    }
    return { status: "success" };
  },

  async removeChunk(input: {
    serverId: number;
    personaId: number | null;
    documentId: number;
    chunkIdx: number;
    workspaceId: string;
    canManage: boolean;
  }): Promise<ChunkRemoveResult> {
    if (!input.canManage) return { status: "forbidden" };
    const meta = await serverMemoryRepository.loadDocumentMeta(input.documentId, input.serverId, input.personaId);
    const chunks = await serverMemoryRepository.loadDocumentChunks(input.documentId, input.serverId, input.personaId);
    const target = chunks.find((chunk) => chunk.chunk_index === input.chunkIdx);
    if (!meta || !target) return { status: "not-found" };
    if (!(await serverMemoryRepository.deleteChunk(target.document_chunk_id, input.serverId, input.personaId))) {
      return { status: "write-failed" };
    }
    invalidateTomoriStateCache(input.workspaceId);
    if (chunks.length === 1) {
      if (!(await serverMemoryRepository.removeDocument(input.documentId, input.serverId, input.personaId))) {
        return { status: "write-failed" };
      }
      invalidateTomoriStateCache(input.workspaceId);
      return { status: "success", removedDocument: true };
    }
    await rebuildDocumentTextContent(input.documentId);
    invalidateTomoriStateCache(input.workspaceId);
    return { status: "success", removedDocument: false };
  },

  async vectorize(input: VectorizeMemoryInput): Promise<VectorizeMemoryResult> {
    if (input.isBlacklisted && !input.canManage) return { status: "blacklisted" };
    if (!input.memteachingEnabled && !input.canManage) return { status: "teaching-disabled" };
    if (!isRagAvailable()) return { status: "rag-disabled" };
    if (memoryGuard.checkMemory().status === "critical") return { status: "memory-critical" };
    const ownerFilter = input.canManage ? undefined : input.userId;
    const memories = await serverMemoryRepository.loadServerMemoriesScoped(
      input.serverId,
      input.personaLineageId,
      ownerFilter,
    );
    const target = memories.find((memory) => memory.server_memory_id === input.memoryId);
    if (!target) return { status: "not-found" };
    return vectorizeLoadedMemory(input, target);
  },
};

async function vectorizeLoadedMemory(
  input: VectorizeMemoryInput,
  target: ServerMemoryRow,
): Promise<VectorizeMemoryResult> {
  const limits = getMemoryLimits();
  const content = input.content.trim();
  const documentName = input.documentName.trim();
  if (!validateMemoryContent(content).isValid) return { status: content ? "content-too-long" : "empty-content" };
  if (!documentName || documentName.length > 64) return { status: "invalid-name" };
  if (await serverMemoryRepository.documentExistsByName(input.serverId, input.personaId, documentName)) {
    return { status: "duplicate" };
  }
  if (
    (await serverMemoryRepository.countDocumentsScoped(input.serverId, input.personaId)) >= limits.maxDocumentsPerServer
  ) {
    return { status: "document-limit" };
  }
  const normalized = ragRepository.normalizeText(content);
  const chunks = ragRepository.chunkText(normalized, limits.documentChunkSize, limits.documentChunkOverlap);
  if (chunks.length === 0) return { status: "empty-content" };
  if (chunks.length > limits.maxDocumentChunks) return { status: "too-many-chunks" };
  const currentChunkCount = await serverMemoryRepository.countChunksScoped(input.serverId, input.personaId);
  if (currentChunkCount + chunks.length > limits.maxDocumentChunksPerServer) return { status: "chunk-limit" };
  const resolved = await resolveEmbedding(input.serverId, input.userId, input.configuredEmbeddingModelId);
  if (resolved.status !== "success") return resolved;
  if (!reserveDocumentQuota(input.userDiscId).allowed) return { status: "quota-exceeded" };
  const embeddings = await embedChunks(chunks, resolved);
  const documentId = await ragRepository.insertWithChunks({
    serverId: input.serverId,
    personaId: input.personaId,
    uploaderUserId: input.userId,
    documentName,
    fileName: null,
    mimeType: null,
    fileSizeBytes: null,
    textContent: normalized,
    chunks,
    embeddings,
    embeddingModelId: resolved.embeddingModelId,
    embeddingFamily: resolved.model.model_family,
    sourceType: "memory",
    channelTags: input.channelTags,
  });
  invalidateTomoriStateCache(input.workspaceId);
  if (!target.server_memory_id || !(await serverMemoryRepository.remove(target.server_memory_id))) {
    return { status: "partial-failure", documentId, documentName, chunkCount: chunks.length };
  }
  invalidateTomoriStateCache(input.workspaceId);
  return { status: "success", documentId, documentName, chunkCount: chunks.length };
}
