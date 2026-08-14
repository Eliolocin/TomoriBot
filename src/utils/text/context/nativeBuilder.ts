import { personaRepository } from "@/utils/db/repositories";
import { log } from "@/utils/misc/logger";
import { hasExplicitLongTermMemoryIntent } from "@/utils/memory/explicitLongTermMemoryIntent";
import { buildUncensorInjectionText } from "@/utils/text/uncensor";
import { createToolPromptMacroResolver, resolvePromptCapabilityValues } from "@/utils/tools/toolPromptMacros";
import { ContextItemTag, type StructuredContextItem } from "@/types/misc/context";
import { appendDialogueHistoryContext } from "./dialogueHistory";
import { convertMentions as convertMentionsBase } from "./mentionNormalizer";
import { buildServerMemoryContextItem, buildShortTermMemoryContext } from "./memories";
import { buildParticipantContextItem } from "./participants";
import { buildPersonaUserBlocksContextItem } from "./personaUserBlocks";
import { buildPersonaSpriteContextItem } from "./personaSprites";
import { buildServerDocumentContextItem } from "./rag";
import { buildServerEmojiContextItem, buildServerStickerContextItem } from "./serverAssets";
import { buildServerInfoContextItem } from "./serverInfo";
import {
  buildConditioningContextItem,
  buildPromptContextItems,
  buildSampleDialogueContextItems,
  type MentionConverter,
} from "./templates";
import { buildVerbatimToolDefinitionsContextItem } from "./toolDefinitions";
import type { BuildContextParams } from "./types";
import { SPACER_TEMPLATE } from "./timeAwareness";

export type NativeBuildContextResult = {
  contextItems: StructuredContextItem[];
  tailDirectives: string[];
  lowerPriorityTailDirectives: string[];
  uncensorDirective?: string;
  /** Unified STM nudge, injected positionally by the pipeline at `nudgeInjectionDepth`. */
  nudgeItem?: StructuredContextItem;
  /** Dialogue depth at which to inject `nudgeItem` (0 = tail). */
  nudgeInjectionDepth?: number;
  /**
   * STM content block deferred for positional injection. Populated only when the
   * server set a content depth >= 0; when -1 (default) the block is pushed inline
   * into `contextItems` here and this stays undefined.
   */
  memoryInjectionItems?: StructuredContextItem[];
  /** Dialogue depth at which to inject `memoryInjectionItems` (0 = tail). */
  memoryInjectionDepth?: number;
};

/**
 * Native fixed-order context assembly used directly, or as the input to preset reassembly.
 */
export async function buildContextNative(params: BuildContextParams): Promise<NativeBuildContextResult> {
  const {
    guildId,
    serverName,
    serverDescription,
    simplifiedMessageHistory,
    preparedParticipantContext,
    channelName,
    channelId,
    parentChannelId,
    client,
    triggererName,
    triggererFormattedName,
    historyUserLabels,
    historyPersonaMentionLabels,
    triggererAddressTerm,
    tomoriNickname,
    tomoriAttributes,
    tomoriConfig,
    channelPromptOverride,
    channelContextNote,
    reunionNote,
    personaPrompt,
    personaLineageId,
    triggererUserId,
    isDMChannel = false,
    snapshot,
    preloadedEmojis,
    preloadedStickers,
    isUserImpersonation = false,
    impersonatedUserId,
    impersonatedUserNickname,
    impersonatedUserPrompt,
    personaUserBlocks,
    includeTimestamps = false,
    explicitLongTermMemoryIntent: explicitLongTermMemoryIntentOverride,
    deliberateToolAllowedNames,
    suppressDefaultSystemPrompt = false,
    messageIdMap,
  } = params;

  const convertMentions: MentionConverter = (
    text,
    mentionClient,
    serverId,
    userName,
    botName,
    personalMemoriesEnabled,
    mentionSnapshot,
    identityMacroMode,
  ) =>
    convertMentionsBase(
      text,
      mentionClient,
      serverId,
      userName,
      botName,
      personalMemoriesEnabled,
      mentionSnapshot,
      identityMacroMode,
      {
        userFormatted: triggererFormattedName,
        userTerm: triggererAddressTerm,
      },
    );

  const contextItems: StructuredContextItem[] = [];
  const tailDirectives: string[] = [];
  const lowerPriorityTailDirectives: string[] = [];
  let nudgeItem: StructuredContextItem | undefined;
  let nudgeInjectionDepth = 2;
  let memoryInjectionItems: StructuredContextItem[] | undefined;
  let memoryInjectionDepth = -1;
  let uncensorDirective: string | undefined;
  const botName = tomoriNickname;
  const impersonatedMember =
    isUserImpersonation && impersonatedUserId
      ? client.guilds.cache.get(guildId)?.members.cache.get(impersonatedUserId)
      : null;
  const impersonatedIdentityName =
    impersonatedMember?.displayName || impersonatedMember?.user.displayName || impersonatedUserNickname || null;
  const uncensorInputOptions = {
    unicodeSpacesEnabled: tomoriConfig.uncensor_unicode_space_enabled,
    sanitizeEnabled: tomoriConfig.uncensor_sanitize_enabled,
  };
  const tomoriState = snapshot?.tomoriState ?? (await personaRepository.loadState(guildId));
  const toolPromptMacroResolver = createToolPromptMacroResolver({
    provider: tomoriState?.llm?.llm_provider,
    capabilities: resolvePromptCapabilityValues(tomoriConfig),
    deliberateToolAllowedNames,
    stateForContext:
      tomoriState?.server_id && tomoriState.llm
        ? {
            server_id: tomoriState.server_id.toString(),
            activePersonaHasElevenlabsVoice: false,
            llm: tomoriState.llm,
            diffusion_model_id: tomoriState.config.diffusion_model_id,
            nai_diffusion_model_id: tomoriState.config.nai_diffusion_model_id,
            video_model_id: tomoriState.config.video_model_id,
            config: {
              sticker_usage_enabled: tomoriConfig.sticker_usage_enabled,
              web_search_enabled: tomoriConfig.web_search_enabled,
              self_teaching_enabled: tomoriConfig.self_teaching_enabled,
              manage_message_enabled: tomoriConfig.manage_message_enabled,
              imagegen_enabled: tomoriConfig.imagegen_enabled,
              videogen_enabled: tomoriConfig.videogen_enabled,
              voice_message_enabled: tomoriConfig.voice_message_enabled,
              user_blocking_enabled: tomoriConfig.user_blocking_enabled,
              user_info_updates_enabled: tomoriConfig.user_info_updates_enabled,
              thread_creation_enabled: tomoriConfig.thread_creation_enabled,
            },
          }
        : undefined,
  });
  const dateSpacerTemplate =
    tomoriConfig.time_awareness_enabled !== false ? await toolPromptMacroResolver.expand(SPACER_TEMPLATE) : null;
  const explicitLongTermMemoryIntent =
    explicitLongTermMemoryIntentOverride ??
    hasExplicitLongTermMemoryIntent(
      simplifiedMessageHistory.filter((message) => message.authorType === "user").at(-1)?.content,
    );

  contextItems.push(
    ...(await buildPromptContextItems({
      client,
      guildId,
      botName,
      tomoriAttributes,
      tomoriConfig,
      channelPromptOverride,
      personaPrompt,
      isUserImpersonation,
      impersonatedIdentityName,
      impersonatedUserPrompt,
      suppressDefaultSystemPrompt,
      snapshot,
      toolPromptMacroResolver,
      convertMentions,
    })),
  );
  contextItems.push(
    await buildServerInfoContextItem({
      client,
      guildId,
      serverName,
      serverDescription,
      isDMChannel,
      isUserImpersonation,
      impersonatedIdentityName,
      botName,
      tomoriConfig,
      snapshot,
      convertMentions,
    }),
  );
  await appendOptionalItem(
    contextItems,
    buildPersonaUserBlocksContextItem({
      client,
      guildId,
      botName,
      tomoriConfig,
      personaUserBlocks,
    }),
  );

  const conversationCorpus = tomoriConfig.memory_tagging_enabled
    ? simplifiedMessageHistory
        .map((message) => message.content ?? "")
        .join(" ")
        .toLowerCase()
    : null;

  if (!isUserImpersonation) {
    const serverMemoryItem = await buildServerMemoryContextItem({
      tomoriState,
      guildId,
      serverName,
      isDMChannel,
      botName,
      personalMemoriesEnabled: tomoriConfig.personal_memories_enabled,
      conversationCorpus,
      channelName,
      channelMemoryEnabled: tomoriConfig.channel_memory_enabled,
      client,
      convertMentions,
    });
    if (serverMemoryItem) contextItems.push(serverMemoryItem);
  }

  await appendOptionalItem(
    contextItems,
    buildServerEmojiContextItem({
      client,
      guildId,
      serverName,
      botName,
      isDMChannel,
      isUserImpersonation,
      tomoriConfig,
      tomoriState,
      preloadedEmojis,
      snapshot,
      convertMentions,
    }),
  );
  await appendOptionalItem(
    contextItems,
    buildServerStickerContextItem({
      client,
      guildId,
      serverName,
      botName,
      isDMChannel,
      isUserImpersonation,
      tomoriConfig,
      tomoriState,
      preloadedStickers,
      toolPromptMacroResolver,
      convertMentions,
    }),
  );
  await appendOptionalItem(
    contextItems,
    buildPersonaSpriteContextItem({
      tomoriState,
      botName,
      isUserImpersonation,
    }),
  );
  await appendOptionalItem(
    contextItems,
    buildParticipantContextItem({
      client,
      guildId,
      channelName,
      channelId,
      participantSeeds: preparedParticipantContext.discoveryPlan.seeds,
      triggererName,
      botName,
      personaLineageId,
      tomoriState,
      tomoriConfig,
      isDMChannel,
      isUserImpersonation,
      impersonatedUserId,
      impersonatedIdentityName,
      matrixUsers: preparedParticipantContext.matrixUsers,
      syntheticUsers: preparedParticipantContext.syntheticUsers,
      publicPersonaProfiles: preparedParticipantContext.publicPersonaProfiles,
      preloadedReferencedUserRows: preparedParticipantContext.referencedUserRows,
      referencedUserIds: preparedParticipantContext.referencedUserIds,
      profileEnricherRegistry: preparedParticipantContext.profileEnricherRegistry,
      toolPromptMacroResolver,
      conversationCorpus,
      snapshot,
      convertMentions,
    }),
  );

  try {
    const actualTriggeringUserId = impersonatedUserId ?? snapshot?.triggererUserRow?.user_disc_id;
    // Per-server master switch (migration 054): when STM is disabled we no longer skip the
    // whole build. "Off" means the bot stops AUTO-managing STM (the write tool and the
    // cadence nudge are suppressed): but existing STM content STILL surfaces so admins can
    // curate it by hand via `/persona stm edit` and crude messages remain visible. The
    // nudge suppression now lives inside buildShortTermMemoryContext (gated on the same
    // switch), and the write tool gates itself in updateShortTermMemoryTool.
    if (actualTriggeringUserId) {
      const stmResult = await buildShortTermMemoryContext({
        triggeringUserId: actualTriggeringUserId,
        currentChannelId: channelId,
        currentServerId: guildId,
        tomoriState,
        triggererName,
        botName,
        personalMemoriesEnabled: tomoriConfig.personal_memories_enabled,
        client,
        isUserImpersonation,
        explicitLongTermMemoryIntent,
        toolPromptMacroResolver,
        currentParentChannelId: parentChannelId,
        convertMentions,
      });
      nudgeItem = stmResult.nudgeItem;
      nudgeInjectionDepth = stmResult.nudgeInjectionDepth;
      memoryInjectionDepth = stmResult.memoryInjectionDepth;
      if (memoryInjectionDepth >= 0) {
        // Depth >= 0: defer the block out-of-band so it can be spliced at a dialogue
        // depth downstream (after history is assembled), the same way the nudge is.
        // Keeping it OUT of contextItems also means preset reassembly won't anchor it
        // at the chatHistory flush point: the positional injection owns placement.
        memoryInjectionItems = stmResult.memoryItems;
      } else {
        // Default (-1): anchor the block near the top as ambient knowledge (legacy).
        contextItems.push(...stmResult.memoryItems);
      }
    }
  } catch (error) {
    log.warn("Failed to build short-term memory context", error);
  }

  // Verbatim tool-calling workaround: when enabled, embed the resolved tool
  // schemas as JSON in-band so endpoints that ignore the native `tools` field
  // still expose them to the model. Placed in the stable reference zone (right
  // before server documents) to stay inside the prompt-cache-friendly prefix.
  await appendOptionalItem(contextItems, buildVerbatimToolDefinitionsContextItem({ tomoriConfig, tomoriState }));
  await appendOptionalItem(
    contextItems,
    buildServerDocumentContextItem({ tomoriState, simplifiedMessageHistory, triggererUserId, channelName }),
  );
  await appendConditioningContext({
    contextItems,
    client,
    guildId,
    tomoriState,
    botName,
    personalMemoriesEnabled: tomoriConfig.personal_memories_enabled,
    isUserImpersonation,
    convertMentions,
  });
  contextItems.push(
    ...(await buildSampleDialogueContextItems({
      client,
      guildId,
      triggererName,
      botName,
      tomoriState,
      tomoriConfig,
      isUserImpersonation,
      uncensorInputOptions,
      convertMentions,
    })),
  );

  await appendDialogueHistoryContext({
    contextItems,
    client,
    guildId,
    simplifiedMessageHistory,
    botName,
    tomoriConfig,
    tomoriState,
    channelContextNote,
    reunionNote,
    dateSpacerTemplate,
    includeTimestamps,
    isUserImpersonation,
    impersonatedUserId,
    triggererDiscordId: snapshot?.triggererUserRow?.user_disc_id,
    triggererFormattedName,
    historyUserLabels,
    historyPersonaMentionLabels,
    messageIdMap,
    uncensorInputOptions,
    convertMentions,
  });

  if (isUserImpersonation && impersonatedUserId) {
    tailDirectives.push(
      `Imitate ${impersonatedIdentityName || "User"}, start your message with ${impersonatedIdentityName || "User"}:`,
    );
  }
  const uncensorInjectionText = buildUncensorInjectionText({
    injectionEnabled: tomoriConfig.uncensor_injection_enabled,
    unicodeSpacesEnabled: tomoriConfig.uncensor_unicode_space_enabled,
  });
  if (uncensorInjectionText) {
    const strippedText = uncensorInjectionText
      .replace(/^\[System:\s*/i, "")
      .replace(/\]\s*$/, "")
      .trim();
    if (strippedText) uncensorDirective = strippedText;
  }

  log.info(`Built ${contextItems.length} structured context items for guild ${guildId}.`);
  return {
    contextItems,
    tailDirectives,
    lowerPriorityTailDirectives,
    uncensorDirective,
    nudgeItem,
    nudgeInjectionDepth,
    memoryInjectionItems,
    memoryInjectionDepth,
  };
}

async function appendOptionalItem(
  contextItems: StructuredContextItem[],
  itemPromise: Promise<StructuredContextItem | null>,
): Promise<void> {
  const item = await itemPromise;
  if (item) contextItems.push(item);
}

async function appendConditioningContext(params: {
  contextItems: StructuredContextItem[];
  client: BuildContextParams["client"];
  guildId: string;
  tomoriState: NonNullable<BuildContextParams["snapshot"]>["tomoriState"] | null | undefined;
  botName: string;
  personalMemoriesEnabled: boolean;
  isUserImpersonation: boolean;
  convertMentions: MentionConverter;
}): Promise<void> {
  if (
    params.isUserImpersonation ||
    !params.tomoriState ||
    !params.tomoriState.server_id ||
    params.tomoriState.persona_lineage_id < 0 ||
    (!params.tomoriState.reward_conditioning_enabled && !params.tomoriState.punish_conditioning_enabled)
  ) {
    return;
  }

  try {
    const conditioningItem = await buildConditioningContextItem({
      client: params.client,
      guildId: params.guildId,
      serverId: params.tomoriState.server_id,
      personaLineageId: params.tomoriState.persona_lineage_id,
      botName: params.botName,
      personalMemoriesEnabled: params.personalMemoriesEnabled,
      rewardEnabled: params.tomoriState.reward_conditioning_enabled,
      punishEnabled: params.tomoriState.punish_conditioning_enabled,
      convertMentions: params.convertMentions,
    });

    if (conditioningItem) {
      params.contextItems.push({
        ...conditioningItem,
        metadataTag: conditioningItem.metadataTag ?? ContextItemTag.KNOWLEDGE_SERVER_CONDITIONING,
      });
    }
  } catch (error) {
    log.warn("Failed to add conditioning context", error);
  }
}
