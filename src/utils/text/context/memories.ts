import type { Client } from "discord.js";
import { getCachedUserRow } from "@/utils/cache/userCache";
import {
  getRelativeTimestamp,
  getShortTermMemoriesForServer,
  getShortTermMemoriesForUser,
  getShortTermMemoryForServerChannel,
  getShortTermMemoryForUserChannel,
  preWarmServerStmEntries,
  preWarmStmEntry,
  preWarmUserStmEntries,
} from "@/utils/cache/shortTermMemoryCache";
import { log } from "@/utils/misc/logger";
import { ContextItemTag, type StructuredContextItem } from "@/types/misc/context";
import type { TomoriState } from "@/types/db/schema";
import type { ToolPromptMacroResolver } from "@/utils/tools/toolPromptMacros";
import type { MentionConverter } from "./templates";
import { serverMemoryRepository } from "@/utils/db/repositories";
import { formatMemoryWithId } from "@/utils/memory/memoryId";
import { shortTermMemoryRepository } from "@/utils/db/repositories/ShortTermMemoryRepository";
import { sanitizeUnknownTemplatePlaceholders } from "@/utils/text/processors/mentionProcessor";
import { buildSlugMap } from "@/utils/text/slugifyLabel";

// Default render depth for crude messages (Mode B additive blocks + no-summary
// fallback listing). Also the fallback when a server has no crude_message_count set.
const DEFAULT_CRUDE_MESSAGE_COUNT = Number.parseInt(
  process.env.SHORT_TERM_MEMORY_DEFAULT_CRUDE_MESSAGE_COUNT || "6",
  10,
);
const MAX_OTHER_CHANNEL_MEMORIES = Number.parseInt(process.env.SHORT_TERM_MEMORY_MAX_OTHER_CHANNELS || "3", 10);

// Position in context reads as recency to the model: a summary sitting at the tail
// implies "this is happening now". While the conversation is still live that is
// accurate and the block belongs next to the dialogue, but once the channel has gone
// quiet the same placement would present stale content as current. `lastUpdated` is
// refreshed by the per-turn crude write (not the cadence-gated summary write), so it
// tracks the last turn Tomori took part in.
const STM_FRESH_WINDOW_MS = Number.parseInt(process.env.STM_FRESH_WINDOW_MINUTES || "60", 10) * 60 * 1000;
const STM_FRESH_INJECTION_DEPTH = Number.parseInt(process.env.STM_FRESH_INJECTION_DEPTH || "2", 10);

/**
 * Resolves the depth a fresh STM content block should use.
 *
 * The override may only pull the block closer to the dialogue, never push it away, so
 * a server already placing STM below the fresh depth keeps its own placement. A
 * negative configured value is the anchored-top sentinel rather than a real depth, so
 * it is replaced outright instead of being treated as "closer".
 */
function resolveFreshInjectionDepth(configuredDepth: number): number {
  if (configuredDepth < 0) return STM_FRESH_INJECTION_DEPTH;
  return Math.min(STM_FRESH_INJECTION_DEPTH, configuredDepth);
}

// The single unified nudge (migration 052) covers BOTH cases: "no STM yet, please
// create one" and "STM exists, please refresh it": with one cadence-gated prompt.
// Category-mode seeds reference {category_labels}, substituted before sanitization.
// `_FALLBACK` variants are byte-stable literals used when no macro resolver is wired.

export const SEED_SUMMARY_UPDATE_HINT =
  "[System: Use the {short_term_memory_tool} tool AFTER you respond to create or update your short-term memory for this conversation. Do NOT use {short_term_memory_tool} when a user explicitly asks you to remember/save/store something for future conversations; use {memory_tool} or {memory_update_tool} instead.]";

const SEED_SUMMARY_UPDATE_HINT_FALLBACK =
  "[System: Use the update_short_term_memory tool AFTER you respond to create or update your short-term memory for this conversation. Do NOT use update_short_term_memory when a user explicitly asks you to remember/save/store something for future conversations; use create_long_term_memory or update_long_term_memory instead.]";

export const SEED_CATEGORY_UPDATE_HINT =
  "[System: Use the {short_term_memory_tool} tool AFTER you respond to create or update your short-term memory fields: {category_labels}. Do NOT use {short_term_memory_tool} when a user explicitly asks you to remember/save/store something for future conversations; use {memory_tool} or {memory_update_tool} instead.]";

const SEED_CATEGORY_UPDATE_HINT_FALLBACK =
  "[System: Use the update_short_term_memory tool AFTER you respond to create or update your short-term memory fields: {category_labels}. Do NOT use update_short_term_memory when a user explicitly asks you to remember/save/store something for future conversations; use create_long_term_memory or update_long_term_memory instead.]";

function formatDiscordChannelReference(channelId: string | undefined, fallbackText: string): string {
  return channelId ? `<#${channelId}>` : fallbackText;
}

/**
 * Derives a human-readable display label from a slug for other-channel memories
 * where the originating server's category definitions are not loaded.
 * e.g. "my_goals" → "My Goals"
 */
function slugToDisplayLabel(slug: string): string {
  return slug.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Formats a categories map as labeled lines for context injection.
 * When labelMap is provided (same-channel with full category row data), uses the
 * original labels in position order. Without labelMap (other-channel), uses
 * humanized slug names.
 *
 * @param categories - slug → value map from the cache entry
 * @param labelMap - Optional slug → display-label map (position-ordered)
 */
function formatCategoryLines(categories: Record<string, string>, labelMap?: Map<string, string>): string {
  const lines: string[] = [];

  if (labelMap) {
    // Use ordered labels from the server's category definitions
    for (const [slug, label] of labelMap) {
      const value = categories[slug];
      if (value?.trim()) {
        lines.push(`${label}: ${value.trim()}`);
      }
    }
  } else {
    // Humanize slugs for cross-server / other-channel rendering
    for (const [slug, value] of Object.entries(categories)) {
      if (value?.trim()) {
        lines.push(`${slugToDisplayLabel(slug)}: ${value.trim()}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Builds persona-scoped server or DM long-term memory context.
 */
export async function buildServerMemoryContextItem(params: {
  tomoriState: TomoriState | null;
  guildId: string;
  serverName: string;
  isDMChannel: boolean;
  botName: string;
  personalMemoriesEnabled: boolean;
  conversationCorpus: string | null;
  channelName: string;
  channelMemoryEnabled: boolean;
  client: Client;
  convertMentions: MentionConverter;
}): Promise<StructuredContextItem | null> {
  if (
    !params.tomoriState?.server_memories ||
    !Array.isArray(params.tomoriState.server_memories) ||
    params.tomoriState.server_memories.length === 0
  ) {
    return null;
  }

  const memoryLabel = params.isDMChannel
    ? `\n## ${params.botName}'s Memories about this conversation with User\n`
    : `\n## ${params.botName}'s Memories about ${params.serverName}\n`;

  let serverMemoryLines: string[] = [];
  try {
    // Without a resolved server id + persona lineage there is nothing to scope
    // to treat it as "no memories" (the previous raw query interpolated NULL,
    // matching none).
    const serverId = params.tomoriState.server_id;
    const personaLineageId = params.tomoriState.persona_lineage_id;
    const serverMemoryRows =
      serverId === undefined || personaLineageId === undefined
        ? []
        : await serverMemoryRepository.loadServerMemoriesScoped(serverId, personaLineageId);

    const filteredServerRows = serverMemoryRows.filter((row) => {
      const normalized = (row.tags ?? []).map((t) => t.replace(/^["']+|["']+$/g, ""));
      const channelTags = normalized.filter((t) => t.startsWith("#"));
      const contentTags = normalized.filter((t) => !t.startsWith("#"));

      // Channel tags gate: if present and channel_memory_enabled, channel must match.
      // Channel and content filters are independent; channel match does not exempt a memory
      // from the content/corpus check below (per baetican's intended design).
      if (params.channelMemoryEnabled && channelTags.length > 0) {
        const channelAllowed = channelTags.some((t) => t.slice(1).toLowerCase() === params.channelName.toLowerCase());
        if (!channelAllowed) return false;
      }

      // Content tags: if corpus filtering is active and the memory has content tags,
      // at least one must appear in the corpus. Memories with no content tags are
      // unfiltered by keyword (per the Memory Tagging help page: "memories without keyword
      // tags will always be active").
      if (params.conversationCorpus != null && contentTags.length > 0) {
        return contentTags.some((tag) => params.conversationCorpus?.includes(tag.toLowerCase()));
      }

      return true;
    });

    serverMemoryLines = filteredServerRows.map((row) =>
      // biome-ignore lint/style/noNonNullAssertion: a loaded server-memory row always carries its PK.
      formatMemoryWithId(row.server_memory_id!, row.content, row.tags ?? []),
    );
  } catch (error) {
    log.warn("Failed to load server memories with IDs for context", error);
    serverMemoryLines = params.tomoriState.server_memories;
  }

  if (serverMemoryLines.length === 0) {
    return null;
  }

  return {
    role: "system",
    parts: [
      {
        type: "text",
        text: await params.convertMentions(
          `${memoryLabel}${serverMemoryLines.join("\n")}\n`,
          params.client,
          params.guildId,
          "User",
          params.botName,
          params.personalMemoriesEnabled,
        ),
      },
    ],
    metadataTag: ContextItemTag.KNOWLEDGE_SERVER_MEMORIES,
  };
}

export async function buildShortTermMemoryContext(params: {
  triggeringUserId: string;
  currentChannelId: string;
  currentServerId: string;
  tomoriState: TomoriState | null;
  triggererName: string;
  botName: string;
  personalMemoriesEnabled: boolean;
  client: Client;
  isUserImpersonation: boolean;
  explicitLongTermMemoryIntent?: boolean;
  toolPromptMacroResolver?: ToolPromptMacroResolver;
  currentParentChannelId?: string | null;
  convertMentions: MentionConverter;
}): Promise<{
  memoryItems: StructuredContextItem[];
  nudgeItem?: StructuredContextItem;
  nudgeInjectionDepth: number;
  /**
   * Where the caller should place `memoryItems`. -1 = keep them anchored near the
   * top as ambient knowledge (legacy default); >= 0 = defer to positional injection
   * at this dialogue depth (counted in turns from the bottom, like the nudge).
   */
  memoryInjectionDepth: number;
}> {
  const memoryItems: StructuredContextItem[] = [];
  let nudgeItem: StructuredContextItem | undefined;

  const expandPromptToolText = (macroText: string, fallbackText: string) =>
    params.toolPromptMacroResolver ? params.toolPromptMacroResolver.expand(macroText) : Promise.resolve(fallbackText);

  try {
    const numericServerId = params.tomoriState?.server_id ?? null;
    const [stmConfig, stmCategoryRows] = numericServerId
      ? await Promise.all([
          shortTermMemoryRepository.getStmConfig(numericServerId),
          shortTermMemoryRepository.getStmCategories(numericServerId),
        ])
      : [null, []];

    // Resolved config values (fall back to sensible defaults)
    const refreshCadence = stmConfig?.refresh_cadence ?? 5;
    // Most servers have no server_stm_configs row at all (it is not seeded at setup),
    // so this fallback, not the column default, decides the render mode for them.
    const renderMode = stmConfig?.render_mode ?? "crude_summary";
    const crudeMessageCount = stmConfig?.crude_message_count ?? DEFAULT_CRUDE_MESSAGE_COUNT;
    const updateNudgeOverride = stmConfig?.update_nudge_override ?? null;
    // 0 = inject the nudge at the dialogue tail; N = before the Nth dialogue turn from the bottom.
    const nudgeInjectionDepth = stmConfig?.nudge_injection_depth ?? 2;
    // -1 = keep the STM content block anchored near the top (legacy default); >= 0 =
    // defer it to positional injection at this dialogue depth (same walk as the nudge).
    // The freshness override below can replace this for the current turn.
    const configuredMemoryInjectionDepth = stmConfig?.content_injection_depth ?? -1;
    let isStmFresh = false;

    // Category mode: any configuration other than the single default "summary" category.
    // An empty list (no rows resolved, e.g. no server) is NOT category mode: it must
    // collapse to the backward-compatible summary path, not render empty labeled sections.
    const isCategoryMode =
      stmCategoryRows.length > 0 &&
      !(stmCategoryRows.length === 1 && stmCategoryRows[0].label.toLowerCase() === "summary");
    const slugMap = isCategoryMode ? buildSlugMap(stmCategoryRows) : null;
    const categoryLabelList = isCategoryMode ? stmCategoryRows.map((r) => r.label).join(", ") : "";
    const userRow = await getCachedUserRow(params.triggeringUserId);
    const crossServerOptIn = userRow?.shortterm_cache_crossserver_opt_in ?? false;

    // Bulk-warm cross-channel STM from the DB BEFORE the synchronous reads below, so
    // other-channel recall is available on the FIRST turn after a restart (cold cache)
    // rather than the second. The same-channel pre-warm (section 3) only covers the
    // current channel; cross-channel recall needs every channel's persisted row. Awaited
    // and one-shot per scope per process, so it costs a single query once after a restart.
    if (params.currentServerId === "DM") {
      await preWarmUserStmEntries(params.triggeringUserId);
    } else {
      await preWarmServerStmEntries(params.currentServerId);
      if (crossServerOptIn) {
        await preWarmUserStmEntries(params.triggeringUserId);
      }
    }

    const personaLineageId = params.tomoriState?.persona_lineage_id;
    let otherChannelMemories =
      params.currentServerId === "DM"
        ? getShortTermMemoriesForUser(params.triggeringUserId, params.currentChannelId, personaLineageId).filter(
            (memory) => crossServerOptIn || memory.serverId === params.currentServerId,
          )
        : getShortTermMemoriesForServer(params.currentServerId, params.currentChannelId, personaLineageId);

    if (params.currentServerId !== "DM" && crossServerOptIn) {
      const crossServerUserMemories = getShortTermMemoriesForUser(
        params.triggeringUserId,
        params.currentChannelId,
        personaLineageId,
      ).filter((memory) => memory.serverId !== params.currentServerId);

      otherChannelMemories = [...otherChannelMemories, ...crossServerUserMemories];
    }

    const privateChannelIds = params.tomoriState?.config.private_channel_ids ?? [];
    const stmPrivacyBypass = params.tomoriState?.config.stm_privacy_bypass ?? false;
    const isCurrentChannelPrivate =
      privateChannelIds.includes(params.currentChannelId) ||
      (params.currentParentChannelId != null && privateChannelIds.includes(params.currentParentChannelId));
    if (!stmPrivacyBypass && !isCurrentChannelPrivate && privateChannelIds.length > 0) {
      otherChannelMemories = otherChannelMemories.filter(
        (memory) =>
          !privateChannelIds.includes(memory.channelId) &&
          !(memory.parentChannelId != null && privateChannelIds.includes(memory.parentChannelId)),
      );
    }

    otherChannelMemories.sort((a, b) => b.lastUpdated - a.lastUpdated);

    const limitedMemories = otherChannelMemories.slice(0, MAX_OTHER_CHANNEL_MEMORIES);
    if (limitedMemories.length > 0) {
      let otherChannelText = "";

      for (const memory of limitedMemories) {
        const relativeTime = getRelativeTimestamp(memory.lastUpdated);
        const isSameServerSharedMemory = params.currentServerId !== "DM" && memory.serverId === params.currentServerId;

        const channelReference =
          memory.serverId === params.currentServerId
            ? formatDiscordChannelReference(
                memory.channelId,
                memory.channelName ? `#${memory.channelName}` : "another channel in this server",
              )
            : "a channel in another server";

        // Determine what content to render for this memory entry
        const hasCategories = memory.categories && Object.keys(memory.categories).length > 0;
        const categoryContent = hasCategories ? formatCategoryLines(memory.categories as Record<string, string>) : null;

        const memoryPrefix = isSameServerSharedMemory
          ? params.isUserImpersonation
            ? `[System: Recent conversation in ${channelReference} (${relativeTime}):\n`
            : `[System: ${params.botName} remembers a recent conversation in ${channelReference} (${relativeTime}):\n`
          : params.isUserImpersonation
            ? `[System: Recent conversation with ${params.triggererName} in ${channelReference} (${relativeTime}):\n`
            : `[System: ${params.botName} remembers a recent conversation with ${params.triggererName} in ${channelReference} (${relativeTime}):\n`;

        if (categoryContent) {
          // Category content available: use it as the primary memory representation
          otherChannelText += `${memoryPrefix}${categoryContent}]\n\n`;

          // Mode B (crude_summary): also show recent crude messages additively for other-channel
          if (renderMode === "crude_summary" && memory.messages.length > 0) {
            const crudePrefix = isSameServerSharedMemory
              ? params.isUserImpersonation
                ? `[System: Recent raw messages from ${channelReference}:\n`
                : `[System: ${params.botName}'s recent raw messages from ${channelReference}:\n`
              : params.isUserImpersonation
                ? `[System: Recent raw messages with ${params.triggererName} in ${channelReference}:\n`
                : `[System: ${params.botName}'s recent raw messages with ${params.triggererName} in ${channelReference}:\n`;
            let crudeText = crudePrefix;
            // Cap the rendered crude turns to the configured depth (most recent N).
            for (const msg of memory.messages.slice(-crudeMessageCount)) {
              const speaker =
                msg.speakerName ||
                (msg.role === "user" ? (isSameServerSharedMemory ? "Someone" : params.triggererName) : params.botName);
              crudeText += `${speaker}: "${msg.content}"\n`;
            }
            otherChannelText += `${crudeText}]\n\n`;
          }
        } else if (memory.summary) {
          // Single-blob summary (fallback / pre-category entries)
          otherChannelText += `${memoryPrefix}${memory.summary}]\n\n`;

          if (renderMode === "crude_summary" && memory.messages.length > 0) {
            const crudePrefix = isSameServerSharedMemory
              ? params.isUserImpersonation
                ? `[System: Recent raw messages from ${channelReference}:\n`
                : `[System: ${params.botName}'s recent raw messages from ${channelReference}:\n`
              : params.isUserImpersonation
                ? `[System: Recent raw messages with ${params.triggererName} in ${channelReference}:\n`
                : `[System: ${params.botName}'s recent raw messages with ${params.triggererName} in ${channelReference}:\n`;
            let crudeText = crudePrefix;
            // Cap the rendered crude turns to the configured depth (most recent N).
            for (const msg of memory.messages.slice(-crudeMessageCount)) {
              const speaker =
                msg.speakerName ||
                (msg.role === "user" ? (isSameServerSharedMemory ? "Someone" : params.triggererName) : params.botName);
              crudeText += `${speaker}: "${msg.content}"\n`;
            }
            otherChannelText += `${crudeText}]\n\n`;
          }
        } else {
          // No summary or categories: fall back to crude turn listing (capped to depth).
          otherChannelText += memoryPrefix;
          for (const msg of memory.messages.slice(-crudeMessageCount)) {
            const speaker =
              msg.speakerName ||
              (msg.role === "user" ? (isSameServerSharedMemory ? "Someone" : params.triggererName) : params.botName);
            otherChannelText += `${speaker}: "${msg.content}"\n`;
          }
          otherChannelText += "]\n\n";
        }
      }

      if (otherChannelText) {
        memoryItems.push({
          role: "user",
          parts: [
            {
              type: "text",
              text: await params.convertMentions(
                otherChannelText.trim(),
                params.client,
                params.currentServerId,
                params.triggererName,
                params.botName,
                params.personalMemoriesEnabled,
              ),
            },
          ],
          metadataTag: ContextItemTag.KNOWLEDGE_SHORT_TERM_MEMORY,
        });
      }
    }
    if (params.tomoriState?.llm?.has_tools) {
      // The cadence nudge prompts the bot to CALL the STM write tool, so it must track
      // the same conditions that decide whether the tool is offered (see
      // updateShortTermMemoryTool.isAvailableForContext). When the per-server master
      // switch (migration 054) is off, the tool is suppressed: so we suppress the nudge
      // too. Crucially this only gates the nudge: the memory content blocks above and
      // below still render, so manually-curated STM (`/persona stm edit`) and crude
      // messages keep surfacing even with STM "off".
      const isStmToolAvailable =
        params.tomoriState.llm.llm_provider !== "novelai" &&
        !params.explicitLongTermMemoryIntent &&
        params.tomoriState.config?.short_term_memory_enabled !== false;

      // Ensure the cache is warm before the synchronous read below.
      // On the first turn after a bot restart the in-memory cache is cold; without
      // this await the sync getter would return undefined and miss the persisted
      // summary/categories for the entire turn.
      await (params.currentServerId === "DM"
        ? preWarmStmEntry("user", params.triggeringUserId, params.currentChannelId, params.tomoriState?.persona_id)
        : preWarmStmEntry("server", params.currentServerId, params.currentChannelId, params.tomoriState?.persona_id));

      const sameChannelMemory =
        params.currentServerId === "DM"
          ? getShortTermMemoryForUserChannel(
              params.triggeringUserId,
              params.currentChannelId,
              params.tomoriState?.persona_id,
            )
          : getShortTermMemoryForServerChannel(
              params.currentServerId,
              params.currentChannelId,
              params.tomoriState?.persona_id,
            );

      // Unified cadence counter (migration 052). A channel with no prior STM starts
      // at 0 and increments once per bot-participation turn, so the nudge first fires
      // after exactly `refreshCadence` turns: for BOTH the create case (no STM yet)
      // and each subsequent update case (existing STM refresh).
      const turnsSinceRefresh = sameChannelMemory?.turnsSinceRefresh ?? 0;
      const isNudgeDue = turnsSinceRefresh >= refreshCadence;

      // Freshness is measured from the most recent active memory being injected (either
      // same-channel memory or any included other-channel memory).
      const timestamps = [sameChannelMemory?.lastUpdated, ...limitedMemories.map((m) => m.lastUpdated)].filter(
        (ts): ts is number => ts != null,
      );

      const newestTimestamp = timestamps.length > 0 ? Math.max(...timestamps) : null;
      const stmAgeMs = newestTimestamp != null ? Date.now() - newestTimestamp : Number.POSITIVE_INFINITY;
      isStmFresh = stmAgeMs <= STM_FRESH_WINDOW_MS;

      // Determine what content is in the same-channel memory
      const sameChannelCategories =
        sameChannelMemory?.categories && Object.keys(sameChannelMemory.categories).length > 0
          ? (sameChannelMemory.categories as Record<string, string>)
          : null;
      const hasMemoryContent = sameChannelCategories !== null || Boolean(sameChannelMemory?.summary);

      if (hasMemoryContent) {
        let memoryBodyText: string;
        if (sameChannelCategories && slugMap) {
          // Category mode: render labeled sections using the server's ordered category rows
          memoryBodyText = formatCategoryLines(sameChannelCategories, slugMap);
        } else if (sameChannelCategories) {
          // Categories present but no slug map (shouldn't happen in normal flow)
          memoryBodyText = formatCategoryLines(sameChannelCategories);
        } else {
          // Single-blob summary (fallback / pre-category)
          memoryBodyText = sameChannelMemory?.summary ?? "";
        }

        const summaryText = params.isUserImpersonation
          ? `[System: Short term memory for this ongoing conversation:\n${memoryBodyText}]`
          : `[System: ${params.botName}'s short term memory for this ongoing conversation:\n${memoryBodyText}]`;

        memoryItems.push({
          role: "user",
          parts: [
            {
              type: "text",
              text: await params.convertMentions(
                summaryText,
                params.client,
                params.currentServerId,
                params.triggererName,
                params.botName,
                params.personalMemoriesEnabled,
              ),
            },
          ],
          metadataTag: ContextItemTag.KNOWLEDGE_SHORT_TERM_MEMORY,
        });
      }

      // Unified nudge (cadence-gated): covers BOTH the create case (no STM yet)
      //     and the update case (refresh existing STM). It is NOT pushed into
      //     memoryItems; it is returned separately so the caller can inject it at the
      //     configured dialogue depth (highest-signal tail position by default).
      if (isStmToolAvailable && isNudgeDue) {
        let rawHintText: string;
        let rawHintFallback: string;

        if (isCategoryMode) {
          rawHintText = (updateNudgeOverride ?? SEED_CATEGORY_UPDATE_HINT).replace(
            "{category_labels}",
            categoryLabelList,
          );
          rawHintFallback = (updateNudgeOverride ?? SEED_CATEGORY_UPDATE_HINT_FALLBACK).replace(
            "{category_labels}",
            categoryLabelList,
          );
        } else {
          rawHintText = updateNudgeOverride ?? SEED_SUMMARY_UPDATE_HINT;
          rawHintFallback = updateNudgeOverride ?? SEED_SUMMARY_UPDATE_HINT_FALLBACK;
        }

        const hintText = sanitizeUnknownTemplatePlaceholders(await expandPromptToolText(rawHintText, rawHintFallback));

        nudgeItem = {
          role: "user",
          parts: [
            {
              type: "text",
              text: await params.convertMentions(
                hintText,
                params.client,
                params.currentServerId,
                params.triggererName,
                params.botName,
                params.personalMemoriesEnabled,
              ),
            },
          ],
          metadataTag: ContextItemTag.KNOWLEDGE_SHORT_TERM_MEMORY,
        };
      }
    }

    // While the conversation is still live the block is pulled down next to the dialogue,
    // including from the anchored-top default. Once the channel goes quiet it snaps back
    // so a stale summary never occupies a "current" slot.
    const memoryInjectionDepth = isStmFresh
      ? resolveFreshInjectionDepth(configuredMemoryInjectionDepth)
      : configuredMemoryInjectionDepth;

    return { memoryItems, nudgeItem, nudgeInjectionDepth, memoryInjectionDepth };
  } catch (error) {
    await log.error(
      `[buildShortTermMemoryContext] Failed to build short-term memory context - triggeringUserId=${params.triggeringUserId}, currentChannelId=${params.currentChannelId}`,
      error,
      {
        errorType: "SHORT_TERM_MEMORY_CONTEXT_ERROR",
        metadata: { userDiscId: params.triggeringUserId, currentChannelId: params.currentChannelId },
      },
    );
    return { memoryItems: [], nudgeInjectionDepth: 0, memoryInjectionDepth: -1 };
  }
}
