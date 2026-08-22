/**
 * /memory history import - Extract atomic facts from channel message history using an LLM
 * and store them as document chunks for RAG retrieval.
 *
 * Inspired by SimpleMem's "Semantic Structured Compression" approach:
 * instead of summarizing chat into a blob, extract self-contained atomic facts
 * with resolved pronouns.
 *
 * Supports three scopes:
 * - persona: Store facts for a specific persona (user selects via paginated buttons)
 * - automatic: Detect personas from webhook authors, create per-persona documents
 * - global: Store facts serverwide (persona_id = NULL)
 */

import type {
  ChatInputCommandInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
  Client,
  Message,
  SlashCommandSubcommandBuilder,
  TextBasedChannel,
} from "discord.js";
import { MessageFlags, EmbedBuilder, TextInputStyle } from "discord.js";
import { isRagAvailable } from "@/utils/db/ragAvailability";
import { localizer } from "@/utils/text/localizer";
import { log, ColorCode } from "@/utils/misc/logger";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { promptWithRawModal } from "@/utils/discord/ui/modals";
import {
  buildPersonaWorkflowNotice,
  completePersonaWorkflow,
  runPersonaPickerWorkflow,
  type PersonaWorkflowMessageController,
} from "@/utils/discord/ui/personaWorkflow";
import { getCachedTomoriState, invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { llmModelRepo, personaRepository, serverMemoryRepository } from "@/utils/db/repositories";
import { getMemoryLimits } from "@/utils/misc/memoryLimits";
import { memoryGuard, reserveDocumentQuota } from "@/utils/security/rateLimiter";
import { generateEmbeddingsBatched, providerSupportsEmbeddingTaskType } from "@/utils/embeddings/embeddingProvider";
import { fetchHistoryAfter } from "@/utils/discord/historyFetcher";
import { formatMessagesForExtraction } from "@/utils/discord/historyFormatter";
import { createDocumentRecord, appendDocumentChunks, finalizeDocumentContent } from "@/utils/documents/documentService";
import {
  buildExtractionUserPrompt,
  composeInCharacterSystemPrompt,
  EXTRACTION_CONVERSATION_SYSTEM_PROMPT,
  EXTRACTION_IN_CHARACTER_SYSTEM_PROMPT,
  EXTRACTION_ROLEPLAY_SYSTEM_PROMPT,
  substituteInCharacterFraming,
  type ExtractionPromptMode,
} from "@/utils/documents/historyExtractionPrompt";
import { ragRepository } from "@/utils/db/repositories";
import type { RetrievedDocumentChunk } from "@/utils/documents/documentService";
import type { EmbeddingModelRow, ErrorContext, TomoriState, UserRow } from "@/types/db/schema";
import {
  extractHistoryWindowForProvider,
  type HistoryExtractionOutcome,
} from "@/providers/utils/providerFeatureExecutors";
import { truncateForEmbedDescription } from "@/utils/discord/embedHelper";
import { providerSupportsFeature } from "@/utils/provider/providerInfoRegistry";
import { getEffectiveLlmModelName } from "@/utils/provider/modelDisplay";
import {
  CredentialUnavailableError,
  getResolvedCapabilityModelId,
  PersonalProviderRequiredError,
  type ResolvedCredentials,
  resolveCapabilityCredentials,
} from "@/utils/provider/credentialResolver";
import { applyPersonalProviderSelectionsToTomoriState } from "@/utils/provider/personalProviderRuntime";

/** Maximum document name length */
const MAX_DOCUMENT_NAME_LENGTH = 64;

/** Number of messages per LLM extraction window */
const HISTORY_EXTRACTION_WINDOW_SIZE = Number.parseInt(process.env.HISTORY_EXTRACTION_WINDOW_SIZE || "40", 10);

/** Number of previous restatements to pass as dedup context between windows */
const DEDUP_CONTEXT_COUNT = 3;

/** Max retrieved document chunks injected into the in-character system prompt per window */
const HISTORY_INCHARACTER_RAG_MAX_RESULTS = (() => {
  const parsed = Number.parseInt(process.env.HISTORY_INCHARACTER_RAG_MAX_RESULTS || "16", 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : 16;
})();

/** Minimum similarity score for chunks pulled into in-character context (loose; we're seeding awareness) */
const HISTORY_INCHARACTER_RAG_MIN_SIMILARITY = 0.3;

type HistoryScope = "persona" | "automatic" | "global";

/** Target document for incremental per-window chunk writes */
interface WriteTarget {
  documentId: number;
  dbServerId: number;
  personaId: number | null;
}

type HistoryImportReplyInteraction = ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction;
type HistoryImportStatusTarget = HistoryImportReplyInteraction | PersonaWorkflowMessageController;

interface HistoryImportStatusOptions {
  titleKey?: string;
  descriptionKey?: string;
  description?: string;
  descriptionVars?: Record<string, string | number | boolean>;
  color: ColorCode;
}

async function replaceHistoryImportStatus(
  target: HistoryImportStatusTarget,
  locale: string,
  options: HistoryImportStatusOptions,
): Promise<void> {
  if ("anchorMessageId" in target) {
    await target.replace(
      buildPersonaWorkflowNotice({
        locale,
        titleKey: options.titleKey ?? "general.persona_workflow.loading_title",
        descriptionKey: options.descriptionKey,
        description: options.description,
        descriptionVars: options.descriptionVars,
        color: options.color,
      }),
    );
    return;
  }

  const embed = new EmbedBuilder().setColor(options.color);
  if (options.titleKey) embed.setTitle(localizer(locale, options.titleKey));
  const description =
    options.description ??
    (options.descriptionKey ? localizer(locale, options.descriptionKey, options.descriptionVars) : undefined);
  if (description) embed.setDescription(description);
  await target.editReply({ embeds: [embed] });
}

/**
 * Builds the localized footer appended to every terminal embed: range timestamps,
 * last-processed message ID, jump link, and channel-end status.
 */
function buildFooter(params: {
  firstMessage: Message;
  lastMessage: Message;
  reachedEnd: boolean;
  guildId: string | null;
  channelId: string;
  locale: string;
}): string {
  const { firstMessage, lastMessage, reachedEnd, guildId, channelId, locale } = params;
  const jumpLink = `https://discord.com/channels/${guildId ?? "@me"}/${channelId}/${lastMessage.id}`;
  const endStatusKey = reachedEnd
    ? "commands.learn.history.end_status_reached_end"
    : "commands.learn.history.end_status_more_available";
  return localizer(locale, "commands.learn.history.success_footer", {
    first_unix: Math.floor(firstMessage.createdTimestamp / 1000).toString(),
    last_unix: Math.floor(lastMessage.createdTimestamp / 1000).toString(),
    last_message_id: lastMessage.id,
    jump_link: jumpLink,
    end_status: localizer(locale, endStatusKey),
  });
}

/**
 * Loads existing server memories for a persona, filtered by channel tags.
 * Untagged memories (no `#tag` entries) are always included; tagged memories must
 * match at least one of the provided filter tags. Tag quotes are stripped before
 * comparison (server_memories tags are stored with surrounding quotes).
 *
 * @param serverId Internal server id
 * @param filterChannelTags Channel tag names without `#` prefix (e.g. ["general", "dev"])
 */
async function loadInCharacterMemoryLines(
  serverId: number,
  personaLineageId: number | null,
  filterChannelTags: string[],
): Promise<string[]> {
  if (personaLineageId == null) return [];

  const rows = await serverMemoryRepository.loadServerMemoryContentTags(serverId, personaLineageId);

  const lowerFilter = filterChannelTags.map((t) => t.toLowerCase());

  return rows
    .filter((row) => {
      const normalized = (row.tags ?? []).map((t) => t.replace(/^["']+|["']+$/g, ""));
      const channelTags = normalized.filter((t) => t.startsWith("#"));
      if (channelTags.length === 0) return true;
      if (lowerFilter.length === 0) return true;
      return channelTags.some((t) => lowerFilter.includes(t.slice(1).toLowerCase()));
    })
    .map((row) => row.content.trim())
    .filter((content) => content.length > 0);
}

/**
 * Retrieves document chunks relevant to a query, looping over multiple channel
 * filter tags and merging results. Each tag-filtered call returns chunks from
 * documents tagged with that channel (plus untagged documents). Results are
 * deduped by (document_id, chunk_index) and the highest-similarity copy is kept.
 *
 * NB: this makes one embedding round-trip per tag. With 16-results × 3 tags,
 * that's 3 embedding calls per extraction window. The user opted into "luxury".
 */
async function retrieveInCharacterChunks(params: {
  serverId: number;
  personaId: number | null;
  query: string;
  embeddingModel: EmbeddingModelRow;
  embeddingApiKey: string;
  filterChannelTags: string[];
  maxResults: number;
}): Promise<RetrievedDocumentChunk[]> {
  const { serverId, personaId, query, embeddingModel, embeddingApiKey, filterChannelTags, maxResults } = params;

  if (!query.trim()) return [];

  const tagsToQuery = filterChannelTags.length > 0 ? filterChannelTags : [null];
  const merged = new Map<string, RetrievedDocumentChunk>();

  for (const tag of tagsToQuery) {
    const chunks = await ragRepository.retrieveRelevantChunks({
      serverId,
      personaId,
      query,
      embeddingModel,
      apiKey: embeddingApiKey,
      maxResults,
      minSimilarity: HISTORY_INCHARACTER_RAG_MIN_SIMILARITY,
      channelName: tag,
    });

    for (const chunk of chunks) {
      const key = `${chunk.document_id}:${chunk.chunk_index}`;
      const existing = merged.get(key);
      if (!existing || chunk.similarity > existing.similarity) {
        merged.set(key, chunk);
      }
    }
  }

  return Array.from(merged.values())
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, maxResults);
}

/** Shows the "no facts extracted from this batch" embed with the pagination footer. */
async function showNoFactsExtractedEmbed(
  statusTarget: HistoryImportStatusTarget,
  locale: string,
  footer: string,
): Promise<void> {
  await replaceHistoryImportStatus(statusTarget, locale, {
    titleKey: "commands.learn.history.no_facts_extracted_title",
    description: `${localizer(locale, "commands.learn.history.no_facts_extracted_description")}\n\n${footer}`,
    color: ColorCode.WARN,
  });
}

/**
 * Shows the "extraction failed" embed, quoting the provider's own error text.
 *
 * Kept distinct from {@link showNoFactsExtractedEmbed} so a model that cannot emit
 * structured output reports the real cause instead of a misleading empty-result notice.
 */
async function showExtractionFailedEmbed(
  statusTarget: HistoryImportStatusTarget,
  locale: string,
  footer: string,
  failure: { error: string; failedWindows: number; totalWindows: number },
): Promise<void> {
  const headline = localizer(locale, "commands.learn.history.extraction_failed_description", {
    failed_windows: failure.failedWindows.toString(),
    total_windows: failure.totalWindows.toString(),
  });
  const suffix = `\n\n${footer}`;
  // Provider errors can be long (schema-validation dumps in particular), so reserve room
  //    for the headline, the code fence, and the pagination footer before truncating.
  const fenceOverhead = "\n\n```\n\n```".length;
  const detail = truncateForEmbedDescription(failure.error, headline.length + suffix.length + fenceOverhead);
  await replaceHistoryImportStatus(statusTarget, locale, {
    titleKey: "commands.learn.history.extraction_failed_title",
    description: `${headline}\n\n\`\`\`\n${detail}\n\`\`\`${suffix}`,
    color: ColorCode.ERROR,
  });
}

/**
 * Renders the correct terminal embed for a failed extraction run, so every import flow
 * reports a provider error as an error and an empty result as an empty result.
 */
async function showExtractionFailureTerminal(
  statusTarget: HistoryImportStatusTarget,
  locale: string,
  footer: string,
  failure: Extract<IncrementalExtractionResult, { ok: false }>,
): Promise<void> {
  if (failure.reason === "extraction-failed") {
    await showExtractionFailedEmbed(statusTarget, locale, footer, failure);
    return;
  }
  await showNoFactsExtractedEmbed(statusTarget, locale, footer);
}

/**
 * Configures the /memory history import subcommand options.
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("history")
    .setDescription(localizer("en-US", "commands.learn.history.description"))
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription(localizer("en-US", "commands.learn.history.name_description"))
        .setRequired(true)
        .setMaxLength(MAX_DOCUMENT_NAME_LENGTH),
    )
    .addStringOption((option) =>
      option
        .setName("scope")
        .setDescription(localizer("en-US", "commands.learn.history.scope_description"))
        .addChoices(
          {
            name: localizer("en-US", "commands.learn.history.scope_choice_persona"),
            value: "persona",
          },
          {
            name: localizer("en-US", "commands.learn.history.scope_choice_automatic"),
            value: "automatic",
          },
          {
            name: localizer("en-US", "commands.learn.history.scope_choice_global"),
            value: "global",
          },
        )
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("start_message_id")
        .setDescription(localizer("en-US", "commands.learn.history.start_message_id_description"))
        .setRequired(true)
        .setMinLength(15)
        .setMaxLength(25),
    )
    .addStringOption((option) =>
      option
        .setName("end_message_id")
        .setDescription(localizer("en-US", "commands.learn.history.end_message_id_description"))
        .setRequired(false)
        .setMinLength(15)
        .setMaxLength(25),
    )
    .addStringOption((option) =>
      option
        .setName("channels")
        .setDescription(localizer("en-US", "commands.learn.history.channels_description"))
        .setRequired(false)
        .setMaxLength(200),
    )
    .addStringOption((option) =>
      option
        .setName("prompt")
        .setDescription(localizer("en-US", "commands.learn.history.prompt_description"))
        .setRequired(false)
        .addChoices(
          {
            name: localizer("en-US", "commands.learn.history.prompt_choice_conversation"),
            value: "conversation",
          },
          {
            name: localizer("en-US", "commands.learn.history.prompt_choice_roleplay"),
            value: "roleplay",
          },
          {
            name: localizer("en-US", "commands.learn.history.prompt_choice_in_character"),
            value: "in_character",
          },
        ),
    )
    .addIntegerOption((option) =>
      option
        .setName("limit")
        .setDescription(localizer("en-US", "commands.learn.history.limit_description"))
        .setRequired(false)
        .setMinValue(50)
        .setMaxValue(100),
    );

const EXTRACTION_PROMPT_MODAL_ID = "memory_history_import_prompt_modal";
const EXTRACTION_PROMPT_FIELD_ID = "system_prompt";

/**
 * Shows a modal pre-filled with the chosen system prompt template, lets the user edit it,
 * and returns the submit interaction and final system prompt string. For in_character
 * mode the framing template is shown with {persona_nickname} already substituted; the
 * runtime context blocks (attributes, memories, retrieved chunks) are NOT shown in the
 * modal and are appended later by composeInCharacterSystemPrompt.
 */
async function promptForExtractionSystem(
  host: ChatInputCommandInteraction | ButtonInteraction,
  locale: string,
  mode: ExtractionPromptMode,
  personaForInCharacter?: TomoriState | null,
): Promise<{ submitInteraction: ModalSubmitInteraction; systemPrompt: string } | null> {
  let defaultPrompt: string;
  if (mode === "in_character") {
    defaultPrompt = substituteInCharacterFraming(
      EXTRACTION_IN_CHARACTER_SYSTEM_PROMPT,
      personaForInCharacter?.persona_nickname ?? "",
    );
  } else if (mode === "roleplay") {
    defaultPrompt = EXTRACTION_ROLEPLAY_SYSTEM_PROMPT;
  } else {
    defaultPrompt = EXTRACTION_CONVERSATION_SYSTEM_PROMPT;
  }

  const modalResult = await promptWithRawModal(host, locale, {
    modalCustomId: EXTRACTION_PROMPT_MODAL_ID,
    modalTitleKey: "commands.learn.history.prompt_modal_title",
    components: [
      {
        customId: EXTRACTION_PROMPT_FIELD_ID,
        style: TextInputStyle.Paragraph,
        labelKey: "commands.learn.history.prompt_modal_label",
        placeholder: "commands.learn.history.prompt_modal_placeholder",
        required: false,
        maxLength: 4000,
        value: defaultPrompt,
      },
    ],
  });

  if (modalResult.outcome !== "submit" || !modalResult.interaction) return null;
  const systemPrompt = modalResult.values?.[EXTRACTION_PROMPT_FIELD_ID]?.trim() || defaultPrompt;
  return { submitInteraction: modalResult.interaction, systemPrompt };
}

/**
 * Splits an array of formatted message lines into windows of the configured size.
 */
function splitIntoWindows(lines: string[], windowSize: number): string[] {
  const windows: string[] = [];
  for (let i = 0; i < lines.length; i += windowSize) {
    windows.push(lines.slice(i, i + windowSize).join("\n"));
  }
  return windows;
}

/**
 * Runs the LLM extraction for a single text window.
 *
 * Returns the provider outcome verbatim so a failed window stays distinguishable from
 * an empty one; {@link runIncrementalExtraction} decides how to aggregate the two.
 */
async function extractWindow(
  windowText: string,
  previousRestatements: string[],
  provider: string,
  model: string,
  apiKey: string,
  systemPrompt: string,
  endpointUrl?: string,
): Promise<HistoryExtractionOutcome> {
  const userPrompt = buildExtractionUserPrompt(windowText, previousRestatements);
  return await extractHistoryWindowForProvider({
    providerName: provider,
    apiKey,
    model,
    endpointUrl,
    systemPrompt,
    userPrompt,
    temperature: 0.3,
    maxOutputTokens: 8192,
  });
}

/**
 * Fetches messages after a starting anchor and formats them for extraction.
 * Returns null only when the raw fetch yields zero messages (channel-end reached);
 * otherwise returns the formatted result alongside batch boundary metadata so the
 * caller can build the pagination footer and handle empty-after-filtering cases.
 */
async function fetchAndFormatMessages(params: {
  channel: TextBasedChannel;
  startMessageId: string;
  endMessageId: string | null;
  limit: number;
  allPersonas: TomoriState[];
  replyInteraction: HistoryImportStatusTarget;
  locale: string;
}): Promise<{
  formattedResult: ReturnType<typeof formatMessagesForExtraction>;
  firstMessage: Message;
  lastMessage: Message;
  reachedEnd: boolean;
} | null> {
  const { channel, startMessageId, endMessageId, limit, allPersonas, replyInteraction, locale } = params;

  await replaceHistoryImportStatus(replyInteraction, locale, {
    descriptionKey: "commands.learn.history.progress_fetching",
    color: ColorCode.INFO,
  });

  // When endMessageId is set we override the user limit and reach the full 100 so we can
  // find the anchor anywhere in the window; the trim below shrinks back to the real span.
  const effectiveLimit = endMessageId ? 100 : limit;
  const fetchResult = await fetchHistoryAfter(channel, startMessageId, effectiveLimit);
  if (fetchResult.messages.length === 0) {
    await replaceHistoryImportStatus(replyInteraction, locale, {
      titleKey: "commands.learn.history.no_messages_title",
      descriptionKey: "commands.learn.history.no_messages_description",
      color: ColorCode.WARN,
    });
    return null;
  }

  let messages = fetchResult.messages;
  let reachedEnd = fetchResult.reachedEnd;

  if (endMessageId) {
    const endIdx = messages.findIndex((m) => m.id === endMessageId);
    if (endIdx === -1) {
      await replaceHistoryImportStatus(replyInteraction, locale, {
        titleKey: "commands.learn.history.end_too_far_title",
        descriptionKey: "commands.learn.history.end_too_far_description",
        descriptionVars: { end_message_id: endMessageId },
        color: ColorCode.ERROR,
      });
      return null;
    }
    messages = messages.slice(0, endIdx + 1);
    // User-defined endpoint; channel may have more after it, so don't claim channel-end.
    reachedEnd = false;
  }

  const formattedResult = formatMessagesForExtraction(messages, allPersonas, channel.client.user?.id);

  return {
    formattedResult,
    firstMessage: messages[0],
    lastMessage: messages[messages.length - 1],
    reachedEnd,
  };
}

/**
 * Reserves a document quota slot at the point of commitment. Called right before
 * each scope branch's document creation so that preflight validation (creds,
 * embedding model, scope checks) doesn't burn the user's daily slot.
 * Returns false and posts a rate-limit message if denied.
 */
async function reserveDocumentQuotaForImport(
  userId: string,
  replyInteraction: HistoryImportStatusTarget,
  locale: string,
): Promise<boolean> {
  const quotaReserve = reserveDocumentQuota(userId);
  if (quotaReserve.allowed) return true;

  const resetTime = quotaReserve.resetAt ? new Date(quotaReserve.resetAt).toLocaleString(locale) : "unknown";
  await replaceHistoryImportStatus(replyInteraction, locale, {
    titleKey: "rate_limit.error_quota_exceeded_title",
    descriptionKey: "rate_limit.error_quota_exceeded_description",
    descriptionVars: { reset_time: resetTime },
    color: ColorCode.ERROR,
  });
  return false;
}

/**
 * Checks document count limit and duplicate name, then creates the document record.
 * Returns the new document_id or null (error already replied).
 */
async function createDocumentForImport(params: {
  documentName: string;
  serverId: number;
  personaId: number | null;
  uploaderUserId: number | null;
  channelTags: string[];
  scopeLabel: string;
  replyInteraction: HistoryImportStatusTarget;
  locale: string;
}): Promise<number | null> {
  const { documentName, serverId, personaId, uploaderUserId, channelTags, scopeLabel, replyInteraction, locale } =
    params;

  const memoryLimits = getMemoryLimits();

  if (await serverMemoryRepository.documentExistsByName(serverId, personaId, documentName)) {
    await replaceHistoryImportStatus(replyInteraction, locale, {
      titleKey: "commands.learn.history.duplicate_title",
      descriptionKey: "commands.learn.history.duplicate_description",
      descriptionVars: { name: documentName },
      color: ColorCode.ERROR,
    });
    return null;
  }

  const docCount = await serverMemoryRepository.countDocumentsScoped(serverId, personaId);
  if (docCount >= memoryLimits.maxDocumentsPerServer) {
    await replaceHistoryImportStatus(replyInteraction, locale, {
      titleKey: "commands.learn.history.limit_exceeded_title",
      descriptionKey: "commands.learn.history.limit_exceeded_description",
      descriptionVars: {
        current_count: docCount.toString(),
        max_allowed: memoryLimits.maxDocumentsPerServer.toString(),
        scope: scopeLabel,
      },
      color: ColorCode.ERROR,
    });
    return null;
  }

  const currentChunkCount = await serverMemoryRepository.countChunksScoped(serverId, personaId);
  if (currentChunkCount >= memoryLimits.maxDocumentChunksPerServer) {
    await replaceHistoryImportStatus(replyInteraction, locale, {
      titleKey: "commands.learn.history.server_chunk_limit_title",
      descriptionKey: "commands.learn.history.server_chunk_limit_description",
      descriptionVars: {
        scope: scopeLabel,
        max_chunks: memoryLimits.maxDocumentChunksPerServer.toString(),
      },
      color: ColorCode.ERROR,
    });
    return null;
  }

  return await createDocumentRecord({
    serverId,
    personaId,
    uploaderUserId,
    documentName,
    sourceType: "history",
    channelTags,
  });
}

/**
 * Aggregate outcome of an incremental extraction run.
 *
 * `no-facts` means every window succeeded but yielded nothing worth keeping;
 * `extraction-failed` means at least one window errored and none produced facts, and
 * carries the provider's own error text so the terminal embed can show the real cause.
 */
type IncrementalExtractionResult =
  | { ok: true; totalFactCount: number; allChunkText: string }
  | { ok: false; reason: "no-facts" }
  | { ok: false; reason: "extraction-failed"; error: string; failedWindows: number; totalWindows: number };

/**
 * Runs incremental LLM extraction over message windows, embedding and persisting each
 * window's facts immediately after extraction to avoid interaction token timeouts.
 *
 * @returns Fact count and joined chunk text on success, otherwise a typed failure the
 *          caller renders (and cleans up its documents for).
 */
async function runIncrementalExtraction(params: {
  formattedResult: ReturnType<typeof formatMessagesForExtraction>;
  provider: string;
  model: string;
  apiKey: string;
  endpointUrl?: string;
  /** Composes the system prompt for a given window. For static prompts (conversation/roleplay) this returns a constant; for in_character it does per-window RAG. */
  composeSystemPrompt: (windowText: string, windowIndex: number) => Promise<string>;
  replyInteraction: HistoryImportStatusTarget;
  locale: string;
  writeTargets: WriteTarget[];
  embeddingModelId: number;
  embeddingFamily: string;
  embeddingProvider: string;
  embeddingCodename: string;
  embeddingApiKey: string;
}): Promise<IncrementalExtractionResult> {
  const {
    formattedResult,
    provider,
    model,
    apiKey,
    endpointUrl,
    composeSystemPrompt,
    replyInteraction,
    locale,
    writeTargets,
    embeddingModelId,
    embeddingFamily,
    embeddingProvider,
    embeddingCodename,
    embeddingApiKey,
  } = params;

  const memoryLimits = getMemoryLimits();
  const messageLines = formattedResult.text.split("\n");
  const windows = splitIntoWindows(messageLines, HISTORY_EXTRACTION_WINDOW_SIZE);
  const allChunks: string[] = [];
  let previousRestatements: string[] = [];
  // Failure bookkeeping: the first provider error is the one shown to the user, since
  //    a model that cannot emit structured output fails identically on every window.
  //    `discardedEntries` counts facts the model returned in an unusable shape, which is a
  //    softer failure than a window erroring outright but must not vanish silently.
  let failedWindows = 0;
  let firstExtractionError: string | null = null;
  let discardedEntries = 0;
  const chunkStartIndex = new Map<number, number>();
  for (const t of writeTargets) chunkStartIndex.set(t.documentId, 0);

  const baselineChunkCounts = new Map<number, number>();
  for (const t of writeTargets) {
    baselineChunkCounts.set(t.documentId, await serverMemoryRepository.countChunksScoped(t.dbServerId, t.personaId));
  }

  for (let i = 0; i < windows.length; i++) {
    await replaceHistoryImportStatus(replyInteraction, locale, {
      descriptionKey: "commands.learn.history.progress_extracting",
      descriptionVars: {
        message_count: formattedResult.messageCount.toString(),
        current: (i + 1).toString(),
        total: windows.length.toString(),
      },
      color: ColorCode.INFO,
    });

    const composedSystemPrompt = await composeSystemPrompt(windows[i], i);
    const windowOutcome = await extractWindow(
      windows[i],
      previousRestatements,
      provider,
      model,
      apiKey,
      composedSystemPrompt,
      endpointUrl,
    );

    // A failed window is recorded and skipped rather than treated as "found nothing",
    //    so the run can still report the real cause if no window ever succeeds.
    if (!windowOutcome.ok) {
      failedWindows++;
      firstExtractionError ??= windowOutcome.error;
      continue;
    }

    discardedEntries += windowOutcome.discarded;

    const windowEntries = windowOutcome.entries;
    if (windowEntries.length > 0) {
      const windowChunks = windowEntries.map((e) => e.lossless_restatement);

      const wouldExceedLimit = writeTargets.some((t) => {
        const baseline = baselineChunkCounts.get(t.documentId) ?? 0;
        return baseline + allChunks.length + windowChunks.length > memoryLimits.maxDocumentChunksPerServer;
      });
      if (wouldExceedLimit) {
        log.warn(`Chunk limit reached during history import; stopping after ${allChunks.length} chunks`);
        break;
      }

      allChunks.push(...windowChunks);

      const embeddings = await generateEmbeddingsBatched({
        provider: embeddingProvider,
        apiKey: embeddingApiKey,
        model: embeddingCodename,
        modelId: embeddingModelId,
        inputs: windowChunks,
        taskType: (await providerSupportsEmbeddingTaskType(embeddingProvider)) ? "RETRIEVAL_DOCUMENT" : undefined,
        batchSize: 16,
      });

      for (const target of writeTargets) {
        const startIdx = chunkStartIndex.get(target.documentId) ?? 0;
        await appendDocumentChunks({
          documentId: target.documentId,
          serverId: target.dbServerId,
          embeddingModelId,
          embeddingFamily,
          startIndex: startIdx,
          chunks: windowChunks,
          embeddings,
        });
        chunkStartIndex.set(target.documentId, startIdx + windowChunks.length);
      }

      previousRestatements = windowEntries.slice(-DEDUP_CONTEXT_COUNT).map((e) => e.lossless_restatement);
    }
  }

  // Nothing persisted: report the provider failure when one occurred, and fall back to
  //    the genuine "nothing worth extracting" terminal only when every window succeeded.
  if (allChunks.length === 0) {
    if (firstExtractionError !== null) {
      return {
        ok: false,
        reason: "extraction-failed",
        error: firstExtractionError,
        failedWindows,
        totalWindows: windows.length,
      };
    }
    // Every window "succeeded" yet nothing survived validation: that is a malformed-output
    // problem, not an empty conversation, so it must not read as "no facts found".
    if (discardedEntries > 0) {
      return {
        ok: false,
        reason: "extraction-failed",
        error: `The model returned ${discardedEntries} fact(s), none of which were in a usable format.`,
        failedWindows: windows.length,
        totalWindows: windows.length,
      };
    }
    return { ok: false, reason: "no-facts" };
  }

  if (discardedEntries > 0) {
    log.warn(
      `History import kept ${allChunks.length} facts but discarded ${discardedEntries} malformed ` +
        `entries across ${windows.length} window(s).`,
    );
  }

  return { ok: true, totalFactCount: allChunks.length, allChunkText: allChunks.join("\n\n") };
}

interface HistoryImportNotice {
  titleKey: string;
  descriptionKey: string;
  descriptionVars?: Record<string, string>;
}

interface HistoryImportRuntime {
  textCreds: ResolvedCredentials;
  embeddingCreds: ResolvedCredentials;
  embeddingModel: NonNullable<Awaited<ReturnType<typeof llmModelRepo.loadEmbeddingModelById>>>;
  embeddingParams: {
    embeddingModelId: number;
    embeddingFamily: string;
    embeddingProvider: string;
    embeddingCodename: string;
    embeddingApiKey: string;
  };
  provider: string;
  model: string;
  endpointUrl: string | undefined;
}

type HistoryImportRuntimeResult =
  | { ok: true; runtime: HistoryImportRuntime }
  | { ok: false; notice: HistoryImportNotice };

async function resolveHistoryImportRuntime(
  tomoriState: TomoriState,
  userId: number | null,
): Promise<HistoryImportRuntimeResult> {
  let textCreds: ResolvedCredentials;
  let embeddingCreds: ResolvedCredentials;
  try {
    [textCreds, embeddingCreds] = await Promise.all([
      resolveCapabilityCredentials(tomoriState.server_id, "text", { userId }),
      resolveCapabilityCredentials(tomoriState.server_id, "embedding", { userId }),
    ]);
  } catch (error) {
    if (error instanceof PersonalProviderRequiredError) {
      return {
        ok: false,
        notice: {
          titleKey: "general.errors.personal_provider_required_title",
          descriptionKey: "general.errors.personal_provider_required_description",
        },
      };
    }
    if (error instanceof CredentialUnavailableError && error.source === "personal") {
      return {
        ok: false,
        notice: {
          titleKey: "general.errors.api_key_error_title",
          descriptionKey: "general.errors.personal_provider_credentials_error_description",
        },
      };
    }
    throw error;
  }

  const embeddingModelId =
    getResolvedCapabilityModelId(embeddingCreds, "embedding") ?? tomoriState.config.embedding_model_id;
  if (!embeddingModelId) {
    return {
      ok: false,
      notice: {
        titleKey: "commands.learn.history.no_embedding_model_title",
        descriptionKey: "commands.learn.history.no_embedding_model_description",
      },
    };
  }
  const embeddingModel = await llmModelRepo.loadEmbeddingModelById(embeddingModelId);
  if (!embeddingModel) {
    return {
      ok: false,
      notice: {
        titleKey: "commands.learn.history.no_embedding_model_title",
        descriptionKey: "commands.learn.history.no_embedding_model_description",
      },
    };
  }

  return {
    ok: true,
    runtime: {
      textCreds,
      embeddingCreds,
      embeddingModel,
      embeddingParams: {
        embeddingModelId,
        embeddingFamily: embeddingModel.model_family,
        embeddingProvider: embeddingModel.provider as string,
        embeddingCodename: embeddingModel.codename,
        embeddingApiKey: embeddingCreds.apiKey,
      },
      provider: tomoriState.llm.llm_provider.toLowerCase(),
      model: getEffectiveLlmModelName(tomoriState.llm, tomoriState.config.custom_model_name),
      endpointUrl: tomoriState.config.custom_endpoint_url ?? undefined,
    },
  };
}

async function validateHistoryMessageRange(
  channel: NonNullable<ChatInputCommandInteraction["channel"]>,
  startMessageId: string,
  endMessageId: string | null,
): Promise<HistoryImportNotice | null> {
  try {
    await channel.messages.fetch(startMessageId);
  } catch {
    return {
      titleKey: "commands.learn.history.invalid_start_id_title",
      descriptionKey: "commands.learn.history.invalid_start_id_description",
      descriptionVars: { start_message_id: startMessageId },
    };
  }

  if (!endMessageId) return null;
  try {
    await channel.messages.fetch(endMessageId);
  } catch {
    return {
      titleKey: "commands.learn.history.invalid_end_id_title",
      descriptionKey: "commands.learn.history.invalid_end_id_description",
      descriptionVars: { end_message_id: endMessageId },
    };
  }

  try {
    if (BigInt(endMessageId) <= BigInt(startMessageId)) {
      return {
        titleKey: "commands.learn.history.end_not_after_start_title",
        descriptionKey: "commands.learn.history.end_not_after_start_description",
      };
    }
  } catch {
    return {
      titleKey: "commands.learn.history.invalid_end_id_title",
      descriptionKey: "commands.learn.history.invalid_end_id_description",
      descriptionVars: { end_message_id: endMessageId },
    };
  }
  return null;
}

/**
 * Executes the /memory history import command.
 * Extracts atomic facts from channel history using an LLM and stores them for RAG retrieval.
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
  const sourceChannel = interaction.channel;
  const scopeInput = interaction.options.getString("scope");
  const scope: HistoryScope = scopeInput === "automatic" ? "automatic" : scopeInput === "global" ? "global" : "persona";

  let tomoriState: TomoriState | null = null;
  let modalSubmitInteraction: ModalSubmitInteraction | undefined;
  let selectedPersonaId: number | undefined;
  const workflowState: { message: PersonaWorkflowMessageController | null } = { message: null };

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

    const memCheck = memoryGuard.checkMemory();
    if (memCheck.status === "critical") {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "rate_limit.error_memory_critical_title"))
            .setDescription(localizer(locale, "rate_limit.error_memory_critical_description"))
            .setColor(ColorCode.ERROR),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const isDMChannel = !interaction.guildId;
    const hasManagePermission = isDMChannel || (interaction.memberPermissions?.has("ManageGuild") ?? false);
    if (!hasManagePermission) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.learn.history.no_permission_title",
        descriptionKey: "commands.learn.history.no_permission_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (scope === "persona") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    const guildId = interaction.guild?.id ?? interaction.user.id;
    tomoriState = await getCachedTomoriState(guildId);
    if (!tomoriState) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const overlayResult = await applyPersonalProviderSelectionsToTomoriState(tomoriState, userData.user_id ?? null);
    tomoriState = overlayResult.tomoriState;

    if (!tomoriState.llm.supports_structoutput) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.learn.history.model_incompatible_title",
        descriptionKey: "commands.learn.history.model_incompatible_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!providerSupportsFeature(tomoriState.llm.llm_provider, "historyExtraction")) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.provider_not_supported_title",
        descriptionKey: "general.errors.provider_not_supported_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const nameInput = interaction.options.getString("name", true).trim();
    const startMessageId = interaction.options.getString("start_message_id", true).trim();
    const endMessageId = interaction.options.getString("end_message_id")?.trim() || null;
    const channelsInput = interaction.options.getString("channels");
    const promptModeInput = interaction.options.getString("prompt");
    const promptMode: ExtractionPromptMode =
      promptModeInput === "roleplay"
        ? "roleplay"
        : promptModeInput === "in_character"
          ? "in_character"
          : "conversation";
    const messageFetchLimit = interaction.options.getInteger("limit") ?? 100;

    // In-character extraction requires a single persona's identity to do its job:
    // reject global/automatic combinations rather than silently degrading.
    if (promptMode === "in_character" && scope !== "persona") {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.learn.history.in_character_scope_invalid_title",
        descriptionKey: "commands.learn.history.in_character_scope_invalid_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const channelTags: string[] = channelsInput
      ? channelsInput
          .split(",")
          .map((raw) => {
            const s = raw.trim();
            const mention = s.match(/^<#(\d+)>$/);
            if (mention) {
              const resolved = _client.channels.cache.get(mention[1]);
              return "name" in (resolved ?? {}) ? (resolved as { name: string }).name.toLowerCase() : "";
            }
            return s.toLowerCase().replace(/^#+/, "");
          })
          .filter((c) => c.length > 0 && /^[\w-]+$/.test(c))
          .map((c) => `#${c}`)
      : [];

    const allPersonas = await personaRepository.loadAllForServer(guildId);

    // SCOPE: PERSONA
    if (scope === "persona") {
      if (allPersonas.length === 0) {
        await replyInfoEmbed(interaction, locale, {
          titleKey: "general.errors.tomori_not_setup_title",
          descriptionKey: "general.errors.tomori_not_setup_description",
          color: ColorCode.ERROR,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const activeTomoriState = tomoriState;
      const workflowResult = await runPersonaPickerWorkflow(interaction, locale, {
        personas: allPersonas,
        color: ColorCode.INFO,
        async onSelected(selection) {
          workflowState.message = selection.message;
          const selectedPersona = selection.persona;
          const targetPersonaId = selectedPersona.persona_id;
          selectedPersonaId = targetPersonaId;
          if (!targetPersonaId) {
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

          const defaultPrompt =
            promptMode === "in_character"
              ? substituteInCharacterFraming(EXTRACTION_IN_CHARACTER_SYSTEM_PROMPT, selectedPersona.persona_nickname)
              : promptMode === "roleplay"
                ? EXTRACTION_ROLEPLAY_SYSTEM_PROMPT
                : EXTRACTION_CONVERSATION_SYSTEM_PROMPT;
          const promptModalResult = await selection.openModal({
            modalCustomId: EXTRACTION_PROMPT_MODAL_ID,
            modalTitleKey: "commands.learn.history.prompt_modal_title",
            components: [
              {
                customId: EXTRACTION_PROMPT_FIELD_ID,
                style: TextInputStyle.Paragraph,
                labelKey: "commands.learn.history.prompt_modal_label",
                placeholder: "commands.learn.history.prompt_modal_placeholder",
                required: false,
                maxLength: 4000,
                value: defaultPrompt,
              },
            ],
          });
          if (promptModalResult.outcome !== "submitted") {
            log.info(`History import prompt modal ${promptModalResult.outcome} for user ${interaction.user.id}`);
            return completePersonaWorkflow();
          }

          const work = await promptModalResult.phase.beginInPlaceWork();
          await replaceHistoryImportStatus(work.message, locale, {
            titleKey: "general.persona_workflow.loading_title",
            descriptionKey: "general.persona_workflow.loading_description",
            color: ColorCode.INFO,
          });

          const runtimeResult = await resolveHistoryImportRuntime(activeTomoriState, userData.user_id ?? null);
          if (!runtimeResult.ok) {
            await replaceHistoryImportStatus(work.message, locale, {
              ...runtimeResult.notice,
              color: ColorCode.ERROR,
            });
            return completePersonaWorkflow();
          }

          const rangeError = await validateHistoryMessageRange(sourceChannel, startMessageId, endMessageId);
          if (rangeError) {
            await replaceHistoryImportStatus(work.message, locale, {
              ...rangeError,
              color: ColorCode.ERROR,
            });
            return completePersonaWorkflow();
          }

          const { textCreds, embeddingCreds, embeddingModel, embeddingParams, provider, model, endpointUrl } =
            runtimeResult.runtime;
          const personaSystemPrompt =
            promptModalResult.phase.values[EXTRACTION_PROMPT_FIELD_ID]?.trim() || defaultPrompt;
          const scopeLabel = localizer(locale, "commands.learn.history.scope_label_persona", {
            persona_name: selectedPersona.persona_nickname,
          });
          const fetchResult = await fetchAndFormatMessages({
            channel: sourceChannel,
            startMessageId,
            endMessageId,
            limit: messageFetchLimit,
            allPersonas,
            replyInteraction: work.message,
            locale,
          });
          if (!fetchResult) return completePersonaWorkflow();

          const inCharacterFilterTags =
            channelTags.length > 0
              ? channelTags.map((tag) => tag.replace(/^#/, ""))
              : "name" in sourceChannel && sourceChannel.name
                ? [sourceChannel.name.toLowerCase()]
                : [];
          const personaServerId = activeTomoriState.server_id;
          const inCharacterExistingMemories =
            promptMode === "in_character"
              ? await loadInCharacterMemoryLines(
                  personaServerId,
                  selectedPersona.persona_lineage_id ?? null,
                  inCharacterFilterTags,
                )
              : [];
          const composeSystemPrompt =
            promptMode === "in_character"
              ? async (windowText: string): Promise<string> => {
                  const retrievedChunks = await retrieveInCharacterChunks({
                    serverId: personaServerId,
                    personaId: targetPersonaId,
                    query: windowText,
                    embeddingModel,
                    embeddingApiKey: embeddingCreds.apiKey,
                    filterChannelTags: inCharacterFilterTags,
                    maxResults: HISTORY_INCHARACTER_RAG_MAX_RESULTS,
                  });
                  return composeInCharacterSystemPrompt({
                    framingTemplate: personaSystemPrompt,
                    personaNickname: selectedPersona.persona_nickname,
                    personaPrompt: selectedPersona.persona_prompt ?? null,
                    attributes: selectedPersona.attribute_list ?? [],
                    existingMemoryLines: inCharacterExistingMemories,
                    retrievedChunks,
                  });
                }
              : async (): Promise<string> => personaSystemPrompt;
          const footer = buildFooter({
            firstMessage: fetchResult.firstMessage,
            lastMessage: fetchResult.lastMessage,
            reachedEnd: fetchResult.reachedEnd,
            guildId: interaction.guild?.id ?? null,
            channelId: sourceChannel.id,
            locale,
          });

          if (fetchResult.formattedResult.messageCount === 0) {
            await replaceHistoryImportStatus(work.message, locale, {
              titleKey: "commands.learn.history.no_extractable_content_title",
              description: `${localizer(locale, "commands.learn.history.no_extractable_content_description")}\n\n${footer}`,
              color: ColorCode.WARN,
            });
            return completePersonaWorkflow();
          }
          if (!(await reserveDocumentQuotaForImport(interaction.user.id, work.message, locale))) {
            return completePersonaWorkflow();
          }

          const documentId = await createDocumentForImport({
            documentName: nameInput,
            serverId: activeTomoriState.server_id,
            personaId: targetPersonaId,
            uploaderUserId: userData.user_id ?? null,
            channelTags,
            scopeLabel,
            replyInteraction: work.message,
            locale,
          });
          if (documentId === null) return completePersonaWorkflow();

          const extractResult = await runIncrementalExtraction({
            formattedResult: fetchResult.formattedResult,
            provider,
            model,
            apiKey: textCreds.apiKey,
            endpointUrl,
            composeSystemPrompt,
            replyInteraction: work.message,
            locale,
            writeTargets: [{ documentId, dbServerId: activeTomoriState.server_id, personaId: targetPersonaId }],
            ...embeddingParams,
          });
          if (!extractResult.ok) {
            await serverMemoryRepository.removeDocument(documentId, activeTomoriState.server_id, targetPersonaId);
            await showExtractionFailureTerminal(work.message, locale, footer, extractResult);
            return completePersonaWorkflow();
          }

          await finalizeDocumentContent(documentId, extractResult.allChunkText);
          invalidateTomoriStateCache(guildId);
          await replaceHistoryImportStatus(work.message, locale, {
            titleKey: "commands.learn.history.success_title",
            description: `${localizer(locale, "commands.learn.history.success_description", {
              fact_count: extractResult.totalFactCount.toString(),
              message_count: fetchResult.formattedResult.messageCount.toString(),
              name: nameInput,
              chunk_count: extractResult.totalFactCount.toString(),
              scope: scopeLabel,
            })}\n\n${footer}`,
            color: ColorCode.SUCCESS,
          });
          return completePersonaWorkflow();
        },
      });

      if (workflowResult.outcome === "error" && workflowState.message) {
        await workflowState.message.replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "general.errors.unknown_error_title",
            descriptionKey: "general.errors.unknown_error_description",
            color: ColorCode.ERROR,
          }),
        );
      }
      return;
    }

    if (scope === "global") {
      const scopeLabel = localizer(locale, "commands.learn.history.scope_label_global");

      const promptModalResult = await promptForExtractionSystem(interaction, locale, promptMode);
      if (!promptModalResult) return;
      modalSubmitInteraction = promptModalResult.submitInteraction;
      const globalSystemPrompt = promptModalResult.systemPrompt;

      await modalSubmitInteraction.deferReply({ flags: MessageFlags.Ephemeral });

      const runtimeResult = await resolveHistoryImportRuntime(tomoriState, userData.user_id ?? null);
      if (!runtimeResult.ok) {
        await replaceHistoryImportStatus(modalSubmitInteraction, locale, {
          ...runtimeResult.notice,
          color: ColorCode.ERROR,
        });
        return;
      }

      const rangeError = await validateHistoryMessageRange(sourceChannel, startMessageId, endMessageId);
      if (rangeError) {
        await replaceHistoryImportStatus(modalSubmitInteraction, locale, {
          ...rangeError,
          color: ColorCode.ERROR,
        });
        return;
      }

      const { textCreds, embeddingParams, provider, model, endpointUrl } = runtimeResult.runtime;

      const fetchResult = await fetchAndFormatMessages({
        channel: interaction.channel,
        startMessageId,
        endMessageId,
        limit: messageFetchLimit,
        allPersonas,
        replyInteraction: modalSubmitInteraction,
        locale,
      });
      if (!fetchResult) return;

      const footer = buildFooter({
        firstMessage: fetchResult.firstMessage,
        lastMessage: fetchResult.lastMessage,
        reachedEnd: fetchResult.reachedEnd,
        guildId: interaction.guild?.id ?? null,
        channelId: interaction.channel.id,
        locale,
      });

      if (fetchResult.formattedResult.messageCount === 0) {
        await modalSubmitInteraction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle(localizer(locale, "commands.learn.history.no_extractable_content_title"))
              .setDescription(
                `${localizer(locale, "commands.learn.history.no_extractable_content_description")}\n\n${footer}`,
              )
              .setColor(ColorCode.WARN),
          ],
        });
        return;
      }

      if (!(await reserveDocumentQuotaForImport(interaction.user.id, modalSubmitInteraction, locale))) return;

      const documentId = await createDocumentForImport({
        documentName: nameInput,
        serverId: tomoriState.server_id,
        personaId: null,
        uploaderUserId: userData.user_id ?? null,
        channelTags,
        scopeLabel,
        replyInteraction: modalSubmitInteraction,
        locale,
      });
      if (documentId === null) return;

      const extractResult = await runIncrementalExtraction({
        formattedResult: fetchResult.formattedResult,
        provider,
        model,
        apiKey: textCreds.apiKey,
        endpointUrl,
        composeSystemPrompt: async () => globalSystemPrompt,
        replyInteraction: modalSubmitInteraction,
        locale,
        writeTargets: [{ documentId, dbServerId: tomoriState.server_id, personaId: null }],
        ...embeddingParams,
      });

      if (!extractResult.ok) {
        await serverMemoryRepository.removeDocument(documentId, tomoriState.server_id, null);
        await showExtractionFailureTerminal(modalSubmitInteraction, locale, footer, extractResult);
        return;
      }

      await finalizeDocumentContent(documentId, extractResult.allChunkText);
      invalidateTomoriStateCache(guildId);

      await modalSubmitInteraction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "commands.learn.history.success_title"))
            .setDescription(
              `${localizer(locale, "commands.learn.history.success_description", {
                fact_count: extractResult.totalFactCount.toString(),
                message_count: fetchResult.formattedResult.messageCount.toString(),
                name: nameInput,
                chunk_count: extractResult.totalFactCount.toString(),
                scope: scopeLabel,
              })}\n\n${footer}`,
            )
            .setColor(ColorCode.SUCCESS),
        ],
      });
      return;
    }

    // Automatic scope creates per-persona documents before extraction so each
    // webhook author's chunks can be written incrementally.
    const autoPromptModalResult = await promptForExtractionSystem(interaction, locale, promptMode);
    if (!autoPromptModalResult) return;
    modalSubmitInteraction = autoPromptModalResult.submitInteraction;
    const autoSystemPrompt = autoPromptModalResult.systemPrompt;

    await modalSubmitInteraction.deferReply({ flags: MessageFlags.Ephemeral });

    const runtimeResult = await resolveHistoryImportRuntime(tomoriState, userData.user_id ?? null);
    if (!runtimeResult.ok) {
      await replaceHistoryImportStatus(modalSubmitInteraction, locale, {
        ...runtimeResult.notice,
        color: ColorCode.ERROR,
      });
      return;
    }

    const rangeError = await validateHistoryMessageRange(sourceChannel, startMessageId, endMessageId);
    if (rangeError) {
      await replaceHistoryImportStatus(modalSubmitInteraction, locale, {
        ...rangeError,
        color: ColorCode.ERROR,
      });
      return;
    }

    const { textCreds, embeddingParams, provider, model, endpointUrl } = runtimeResult.runtime;

    const fetchResult = await fetchAndFormatMessages({
      channel: interaction.channel,
      startMessageId,
      endMessageId,
      limit: messageFetchLimit,
      allPersonas,
      replyInteraction: modalSubmitInteraction,
      locale,
    });
    if (!fetchResult) return;

    const { formattedResult } = fetchResult;
    const detectedTomoriIds = formattedResult.detectedPersonaTomoriIds;

    const footer = buildFooter({
      firstMessage: fetchResult.firstMessage,
      lastMessage: fetchResult.lastMessage,
      reachedEnd: fetchResult.reachedEnd,
      guildId: interaction.guild?.id ?? null,
      channelId: interaction.channel.id,
      locale,
    });

    if (formattedResult.messageCount === 0) {
      await modalSubmitInteraction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "commands.learn.history.no_extractable_content_title"))
            .setDescription(
              `${localizer(locale, "commands.learn.history.no_extractable_content_description")}\n\n${footer}`,
            )
            .setColor(ColorCode.WARN),
        ],
      });
      return;
    }

    if (detectedTomoriIds.length === 0) {
      const scopeLabel = localizer(locale, "commands.learn.history.scope_label_global");

      if (!(await reserveDocumentQuotaForImport(interaction.user.id, modalSubmitInteraction, locale))) return;

      const documentId = await createDocumentForImport({
        documentName: nameInput,
        serverId: tomoriState.server_id,
        personaId: null,
        uploaderUserId: userData.user_id ?? null,
        channelTags,
        scopeLabel,
        replyInteraction: modalSubmitInteraction,
        locale,
      });
      if (documentId === null) return;

      const extractResult = await runIncrementalExtraction({
        formattedResult,
        provider,
        model,
        apiKey: textCreds.apiKey,
        endpointUrl,
        composeSystemPrompt: async () => autoSystemPrompt,
        replyInteraction: modalSubmitInteraction,
        locale,
        writeTargets: [{ documentId, dbServerId: tomoriState.server_id, personaId: null }],
        ...embeddingParams,
      });

      if (!extractResult.ok) {
        await serverMemoryRepository.removeDocument(documentId, tomoriState.server_id, null);
        await showExtractionFailureTerminal(modalSubmitInteraction, locale, footer, extractResult);
        return;
      }

      await finalizeDocumentContent(documentId, extractResult.allChunkText);
      invalidateTomoriStateCache(guildId);

      await modalSubmitInteraction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "commands.learn.history.success_title"))
            .setDescription(
              `${localizer(locale, "commands.learn.history.success_automatic_global_fallback", {
                name: nameInput,
              })}\n\n${footer}`,
            )
            .setColor(ColorCode.SUCCESS),
        ],
      });
      return;
    }

    if (!(await reserveDocumentQuotaForImport(interaction.user.id, modalSubmitInteraction, locale))) return;

    // Create per-persona document records before extraction starts
    const memoryLimits = getMemoryLimits();
    const personaTargets: Array<{ target: WriteTarget; personaNickname: string; docName: string }> = [];

    for (const personaId of detectedTomoriIds) {
      const persona = allPersonas.find((p) => p.persona_id === personaId);
      if (!persona) continue;

      const docName = `${nameInput} (${persona.persona_nickname})`;

      if (await serverMemoryRepository.documentExistsByName(tomoriState.server_id, personaId, docName)) {
        log.warn(`Skipping duplicate document "${docName}" for persona ${personaId} during automatic scope`);
        continue;
      }

      const docCount = await serverMemoryRepository.countDocumentsScoped(tomoriState.server_id, personaId);
      if (docCount >= memoryLimits.maxDocumentsPerServer) {
        log.warn(`Document limit exceeded for persona ${personaId}, skipping`);
        continue;
      }

      const chunkCount = await serverMemoryRepository.countChunksScoped(tomoriState.server_id, personaId);
      if (chunkCount >= memoryLimits.maxDocumentChunksPerServer) {
        log.warn(`Chunk limit exceeded for persona ${personaId}, skipping`);
        continue;
      }

      const documentId = await createDocumentRecord({
        serverId: tomoriState.server_id,
        personaId,
        uploaderUserId: userData.user_id ?? null,
        documentName: docName,
        sourceType: "history",
        channelTags,
      });

      personaTargets.push({
        target: { documentId, dbServerId: tomoriState.server_id, personaId },
        personaNickname: persona.persona_nickname,
        docName,
      });
    }

    if (personaTargets.length === 0) {
      await modalSubmitInteraction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "commands.learn.history.duplicate_title"))
            .setDescription(localizer(locale, "commands.learn.history.duplicate_description", { name: nameInput }))
            .setColor(ColorCode.ERROR),
        ],
      });
      return;
    }

    const extractResult = await runIncrementalExtraction({
      formattedResult,
      provider,
      model,
      apiKey: textCreds.apiKey,
      endpointUrl,
      composeSystemPrompt: async () => autoSystemPrompt,
      replyInteraction: modalSubmitInteraction,
      locale,
      writeTargets: personaTargets.map((pt) => pt.target),
      ...embeddingParams,
    });

    for (const { target } of personaTargets) {
      if (!extractResult.ok) {
        await serverMemoryRepository.removeDocument(target.documentId, tomoriState.server_id, target.personaId);
      } else {
        await finalizeDocumentContent(target.documentId, extractResult.allChunkText);
      }
    }

    if (!extractResult.ok) {
      await showExtractionFailureTerminal(modalSubmitInteraction, locale, footer, extractResult);
      return;
    }

    invalidateTomoriStateCache(guildId);

    const personaResultLines = personaTargets.map(({ personaNickname, docName }) =>
      localizer(locale, "commands.learn.history.success_automatic_persona_line", {
        persona_name: personaNickname,
        doc_name: docName,
        chunk_count: extractResult.totalFactCount.toString(),
      }),
    );

    await modalSubmitInteraction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(localizer(locale, "commands.learn.history.success_title"))
          .setDescription(
            `${localizer(locale, "commands.learn.history.success_automatic_description", {
              fact_count: extractResult.totalFactCount.toString(),
              message_count: formattedResult.messageCount.toString(),
              persona_list: personaResultLines.join("\n"),
            })}\n\n${footer}`,
          )
          .setColor(ColorCode.SUCCESS),
      ],
    });
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: tomoriState?.server_id,
      personaId: selectedPersonaId ?? tomoriState?.persona_id,
      errorType: "CommandExecutionError",
      metadata: {
        command: "memory history import",
        guildId: interaction.guild?.id,
        executorDiscordId: interaction.user.id,
      },
    };
    await log.error("Error in /memory history import command", error, context);

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

    const errorReplyTarget =
      modalSubmitInteraction && (modalSubmitInteraction.deferred || modalSubmitInteraction.replied)
        ? modalSubmitInteraction
        : interaction.deferred || interaction.replied
          ? interaction
          : null;

    if (errorReplyTarget) {
      await replyInfoEmbed(errorReplyTarget, locale, {
        titleKey: "general.errors.unknown_error_title",
        descriptionKey: "general.errors.unknown_error_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
    }
  }
}
