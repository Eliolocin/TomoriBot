import type { ChatInputCommandInteraction, Client, Message, SlashCommandSubcommandBuilder } from "discord.js";
import { AttachmentBuilder, EmbedBuilder, MessageFlags } from "discord.js";
import { localizer } from "@/utils/text/localizer";
import { log, ColorCode } from "@/utils/misc/logger";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { promptWithPaginatedModal, safeSelectOptionText } from "@/utils/discord/ui/modals";
import { sliceMessagesAtResetMarker } from "@/utils/discord/embedDetection";
import {
  checkTargetEmbedTitle,
  processLinkEmbed,
  formatSystemProducedEmbedHint,
} from "@/utils/discord/embedClassifier";
import { extractNoticeTextFromComponents } from "@/utils/discord/componentNoticeReader";
import { getCachedTomoriState, getCachedAllPersonas } from "@/utils/cache/tomoriStateCache";
import { getCachedChannelLlm } from "@/utils/cache/channelLlmCache";
import { getCachedChannelPrompt } from "@/utils/cache/channelPromptCache";
import { getCachedChannelContextNote } from "@/utils/cache/channelContextNoteCache";
import { llmProviderRepo, userNamingRepository, userRepository } from "@/utils/db/repositories";
import { userPersonaNamingPairKey } from "@/utils/db/repositories/UserNamingRepository";
import { resolveEffectiveUserNaming } from "@/utils/text/userNaming";
import { buildContext } from "@/utils/text/contextBuilder";
import { getCachedActivePreset } from "@/utils/cache/stPresetCache";
import { getCachedPrivacyLevel, getCachedUserRow } from "@/utils/cache/userCache";
import { getStaticProviderInfo, normalizeProviderName } from "@/utils/provider/providerInfoRegistry";
import { resolveCapabilityCredentials } from "@/utils/provider/credentialResolver";
import { applyPersonalProviderSelectionsToTomoriState } from "@/utils/provider/personalProviderRuntime";
import { normalizeMessageFetchLimit } from "@/utils/discord/messageFetchLimit";
import { PrivacyLevel, type UserRow, type TomoriState } from "@/types/db/schema";
import { ContextItemTag, type StructuredContextItem } from "@/types/misc/context";
import { resolveMediaForModel } from "@/utils/text/context/mediaResolver";
import { GoogleStreamAdapter } from "@/providers/google/googleStreamAdapter";
import { OpenrouterStreamAdapter } from "@/providers/openrouter/openrouterStreamAdapter";
import { AnthropicStreamAdapter } from "@/providers/anthropic/anthropicStreamAdapter";
import { VertexStreamAdapter } from "@/providers/vertex/vertexStreamAdapter";
import { VertexexpressStreamAdapter } from "@/providers/vertexexpress/vertexexpressStreamAdapter";
import { type ToolStateForContext, getAvailableToolsWithMCP } from "@/tools/toolRegistry";
import { getGoogleToolAdapter } from "@/providers/google/googleToolAdapter";
import { getAnthropicToolAdapter } from "@/providers/anthropic/anthropicToolAdapter";
import { getOpenrouterToolAdapter } from "@/providers/openrouter/openrouterToolAdapter";
import { getCustomToolAdapter } from "@/providers/custom/customToolAdapter";
import { getDeepseekToolAdapter } from "@/providers/deepseek/deepseekToolAdapter";
import { getNvidiaToolAdapter } from "@/providers/nvidia/nvidiaToolAdapter";
import { getZaiToolAdapter } from "@/providers/zai/zaiToolAdapter";
import { getZaicodingToolAdapter } from "@/providers/zaicoding/zaicodingToolAdapter";
import { getVertexToolAdapter } from "@/providers/vertex/vertexToolAdapter";
import { getVertexexpressToolAdapter } from "@/providers/vertexexpress/vertexexpressToolAdapter";
import { getNovelaiToolAdapter } from "@/providers/novelai/novelaiToolAdapter";
import type { MCPCapableToolAdapter } from "@/types/tool/interfaces";
import { buildActiveSamplingParams, selectAnthropicSamplingParams } from "@/utils/provider/samplingControl";
import {
  buildAnthropicThinkingRequest,
  buildCustomThinkingRequest,
  buildDeepSeekThinkingRequest,
  buildGoogleThinkingConfig,
  buildOpenRouterReasoningRequest,
  buildZaiThinkingRequest,
  getNovelAiThinkingDirective,
  serializeGoogleThinkingConfig,
} from "@/utils/provider/thinkingControl";
import { buildProviderStopStrings } from "@/providers/utils/stopStrings";
import { getEmojiPenaltyDirective } from "@/utils/text/emojiPenalty";
import {
  filterDeliberateToolNames,
  getDeliberateToolIntentResult,
  getFollowUpToolIntentResult,
  resolveDeliberateToolMode,
} from "@/utils/tools/deliberateToolMode";
import {
  appendComponentMediaFromMessage,
  appendSupportedMediaFromMessage,
  getEffectiveAttachmentContentType,
  isSupportedImageAttachmentContentType,
  isSupportedVideoAttachmentContentType,
} from "@/utils/chat/contextMedia";
import { normalizeRenderModifierName, resolveRenderModifierSourcePersona } from "@/utils/discord/renderModifierParser";
import { resolveSpriteMessageDisplayName } from "@/utils/discord/spriteMessageLabel";
import { prepareParticipantContext } from "@/utils/text/participants/preparation";

const PERSONA_SELECT_ID = "prompt_snapshot_persona_select";

const YOUTUBE_URL_PATTERNS = [
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/i,
  /(?:https?:\/\/)?(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]{11})/i,
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/i,
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/i,
];

type SnapshotToolFilter = {
  disabledByDeliberateMode: boolean;
  allowedToolNames: string[];
};

function normalizeTailDirective(text: string): string {
  let trimmed = text.trim();
  if (!trimmed) return "";
  if (/^\[System:/i.test(trimmed)) {
    trimmed = trimmed.replace(/^\[System:\s*/i, "");
    if (trimmed.endsWith("]")) trimmed = trimmed.slice(0, -1).trim();
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) trimmed = trimmed.slice(1, -1).trim();
  return trimmed;
}

function buildCombinedTailDirectiveMessage(directives: string[]): StructuredContextItem | null {
  const normalized = directives.map(normalizeTailDirective).filter((d) => d.length > 0);
  if (normalized.length === 0) return null;
  return {
    role: "user",
    parts: [{ type: "text", text: `[System: ${normalized.join("\n\n")}]` }],
    metadataTag: ContextItemTag.DIALOGUE_HISTORY,
  };
}

function insertBeforeLatestDialoguePair(
  contextSegments: StructuredContextItem[],
  injectedItem: StructuredContextItem,
): void {
  const dialogueIndexes: number[] = [];
  for (let i = contextSegments.length - 1; i >= 0; i--) {
    const item = contextSegments[i];
    if (item.metadataTag === ContextItemTag.DIALOGUE_HISTORY && (item.role === "user" || item.role === "model")) {
      dialogueIndexes.push(i);
      if (dialogueIndexes.length === 2) break;
    }
  }
  if (dialogueIndexes.length === 0) {
    contextSegments.push(injectedItem);
    return;
  }
  const insertAt = dialogueIndexes.length >= 2 ? dialogueIndexes[1] : dialogueIndexes[0];
  contextSegments.splice(insertAt, 0, injectedItem);
}

// Local mirror of contextAnnotations.insertAtDialogueDepth so the snapshot reflects
// the live STM nudge positioning. depth=0 → tail; depth=N → before the Nth dialogue
// item from the bottom (clamps to earliest dialogue turn when fewer than N exist).
function insertAtDialogueDepth(
  contextSegments: StructuredContextItem[],
  nudge: StructuredContextItem,
  depth: number,
): void {
  if (depth <= 0) {
    contextSegments.push(nudge);
    return;
  }
  let found = 0;
  let lastFoundIndex = -1;
  for (let i = contextSegments.length - 1; i >= 0; i--) {
    if (contextSegments[i].metadataTag === ContextItemTag.DIALOGUE_HISTORY) {
      found++;
      lastFoundIndex = i;
      if (found === depth) {
        contextSegments.splice(i, 0, nudge);
        return;
      }
    }
  }
  if (lastFoundIndex !== -1) {
    contextSegments.splice(lastFoundIndex, 0, nudge);
  } else {
    contextSegments.push(nudge);
  }
}

function isSnapshotAudioAttachment(contentType: string | null | undefined): boolean {
  return Boolean(contentType?.startsWith("audio/"));
}

function getSnapshotRecentToolAffordanceNames(
  recentMessages: Message[],
  currentMessageId: string,
  clientUserId?: string | null,
): string[] {
  const toolNames: string[] = [];

  const lookbackMessages = recentMessages
    .filter((recentMessage) => recentMessage.id !== currentMessageId)
    .slice(-8)
    .reverse();

  for (const msg of lookbackMessages) {
    const isPersonaOutput = Boolean(msg.webhookId) || (Boolean(clientUserId) && msg.author.id === clientUserId);

    if (!isPersonaOutput) {
      const recentIntentResult = getDeliberateToolIntentResult(msg.content);
      toolNames.push(...recentIntentResult.allowedToolNames);
      if (toolNames.length > 0) break;
      continue;
    }

    const attachments = [...msg.attachments.values()];

    if (attachments.some((attachment) => isSnapshotAudioAttachment(attachment.contentType))) {
      toolNames.push("generate_voice_message");
    }

    if (
      attachments.some((attachment) =>
        isSupportedImageAttachmentContentType(getEffectiveAttachmentContentType(attachment)),
      )
    ) {
      toolNames.push("generate_image", "generate_image_nai");
    }

    if (
      attachments.some((attachment) =>
        isSupportedVideoAttachmentContentType(getEffectiveAttachmentContentType(attachment)),
      )
    ) {
      toolNames.push("generate_video");
    }

    if (toolNames.length === 0) {
      const componentImageAttachments: Parameters<typeof appendComponentMediaFromMessage>[1] = [];
      const componentVideoAttachments: Parameters<typeof appendComponentMediaFromMessage>[2] = [];
      const componentCounts = appendComponentMediaFromMessage(
        msg,
        componentImageAttachments,
        componentVideoAttachments,
      );
      if (componentCounts.imageCount > 0) {
        toolNames.push("generate_image", "generate_image_nai");
      }
      if (componentCounts.videoCount > 0) {
        toolNames.push("generate_video");
      }
    }

    if (toolNames.length > 0) break;
  }

  return Array.from(new Set(toolNames));
}

async function buildSnapshotToolFilter(params: {
  messagesArray: Message[];
  clientUserId?: string | null;
  persona: TomoriState;
  invokingUserData: UserRow;
}): Promise<SnapshotToolFilter | null> {
  const { messagesArray, clientUserId, persona, invokingUserData } = params;
  const latestUserMessage = [...messagesArray]
    .reverse()
    .find((message) => !message.webhookId && message.author.id !== clientUserId);

  const latestUserRow =
    latestUserMessage && latestUserMessage.author.id !== invokingUserData.user_disc_id
      ? await getCachedUserRow(latestUserMessage.author.id)
      : invokingUserData;
  const deliberateToolModeActive = resolveDeliberateToolMode(
    persona.config.deliberate_tool_mode,
    latestUserRow?.personal_deliberate_tool_mode ?? "follow",
  );

  if (!deliberateToolModeActive) return null;

  const intentText = latestUserMessage?.content ?? "";
  const directIntent = getDeliberateToolIntentResult(intentText, persona.config.deliberate_tool_triggers);
  const followUpIntent = getFollowUpToolIntentResult(
    intentText,
    latestUserMessage ? getSnapshotRecentToolAffordanceNames(messagesArray, latestUserMessage.id, clientUserId) : [],
  );
  const allowedToolNames = Array.from(new Set([...directIntent.allowedToolNames, ...followUpIntent.allowedToolNames]));

  return {
    disabledByDeliberateMode: allowedToolNames.length === 0,
    allowedToolNames,
  };
}

async function resolveSnapshotAnsweringState(params: {
  selectedPersona: TomoriState;
  effectivePersona: TomoriState;
  userId: number | null;
}): Promise<TomoriState> {
  try {
    const textCreds = await resolveCapabilityCredentials(params.selectedPersona.server_id, "text", {
      userId: params.userId,
    });

    if (textCreds.source !== "personal") {
      return params.effectivePersona;
    }

    const overlay = await applyPersonalProviderSelectionsToTomoriState(params.selectedPersona, params.userId);
    return {
      ...overlay.tomoriState,
      persona_llm: undefined,
    };
  } catch (error) {
    log.warn("prompt snapshot: text credential resolution failed; using server/persona model view.", error as Error);
    return params.effectivePersona;
  }
}

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("snapshot")
    .setDescription(localizer("en-US", "commands.tool.prompt.snapshot.description"))
    .addStringOption((option) =>
      option
        .setName("format")
        .setDescription(localizer("en-US", "commands.tool.prompt.snapshot.format_description"))
        .addChoices(
          { name: localizer("en-US", "commands.tool.prompt.snapshot.text_option"), value: "text" },
          { name: localizer("en-US", "commands.tool.prompt.snapshot.json_option"), value: "json" },
        ),
    )
    .addBooleanOption((option) =>
      option
        .setName("fetch_tools")
        .setDescription(localizer("en-US", "commands.tool.prompt.snapshot.fetch_tools_description")),
    );

/**
 * Dumps the compiled LLM prompt for a chosen persona + current channel to a file,
 * then sends it to the invoking user via DM (or as an ephemeral attachment if DMs are closed).
 *
 * @param interaction - Command interaction (must be in a guild channel)
 * @param userData - Invoker's user row, so passed to buildContext so STM loads correctly
 * @param locale - Resolved locale for the interaction
 */
export async function execute(
  client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  // Unique modal ID per invocation prevents stale awaitModalSubmit collisions
  const MODAL_CUSTOM_ID = `tool_promptsnapshot_modal_${interaction.id}`;

  if (!interaction.guild || !interaction.channel) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.tool.prompt.snapshot.guild_only_title",
      descriptionKey: "commands.tool.prompt.snapshot.guild_only_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    const tomoriState = await getCachedTomoriState(interaction.guild.id);
    if (!tomoriState) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const hasManageGuild = interaction.memberPermissions?.has("ManageGuild") ?? false;
    const snapshotEnabled = tomoriState.config.prompt_snapshot_enabled ?? false;
    if (!hasManageGuild && !snapshotEnabled) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.tool.prompt.snapshot.no_permission_title",
        descriptionKey: "commands.tool.prompt.snapshot.no_permission_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const format = interaction.options.getString("format") ?? "text";
    const fetchTools = interaction.options.getBoolean("fetch_tools") ?? false;

    const personas = await getCachedAllPersonas(interaction.guild.id);
    if (personas.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.tool.prompt.snapshot.no_personas_title",
        descriptionKey: "commands.tool.prompt.snapshot.no_personas_description",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Build persona select options, so index-based values avoid Discord's 100-char value limit
    const personaOptions = personas.map((persona, index) => ({
      label: safeSelectOptionText(persona.persona_nickname),
      value: index.toString(),
      description: persona.is_alter ? "Alter Persona" : "Main Persona",
    }));

    // Show persona select modal: this is the first interaction acknowledgment;
    //    do NOT deferReply before this call
    const modalResult = await promptWithPaginatedModal(interaction, locale, {
      modalCustomId: MODAL_CUSTOM_ID,
      modalTitleKey: "commands.tool.prompt.snapshot.modal_title",
      components: [
        {
          customId: PERSONA_SELECT_ID,
          labelKey: "commands.tool.prompt.snapshot.persona_select_label",
          descriptionKey: "commands.tool.prompt.snapshot.persona_select_description",
          placeholder: "commands.tool.prompt.snapshot.persona_select_placeholder",
          required: true,
          options: personaOptions,
        },
      ],
    });

    if (modalResult.outcome !== "submit" || !modalResult.interaction) return;
    const modalInteraction = modalResult.interaction;

    // Defer modal submission before async work to prevent interaction timeout
    if (!modalInteraction.deferred && !modalInteraction.replied) {
      await modalInteraction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    // Resolve the selected persona from the index value
    const selectedIndexStr = modalResult.values?.[PERSONA_SELECT_ID];
    const selectedIndex = selectedIndexStr !== undefined ? Number.parseInt(selectedIndexStr, 10) : 0;
    const selectedPersona: TomoriState | undefined = personas[selectedIndex];

    if (!selectedPersona) {
      await modalInteraction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "commands.tool.prompt.snapshot.build_failed_title"))
            .setDescription(localizer(locale, "commands.tool.prompt.snapshot.build_failed_description"))
            .setColor(ColorCode.ERROR),
        ],
      });
      return;
    }

    // Resolve effective LLM (persona override > channel override > global) and
    //     patch samplers from saved_provider_configs when the override crosses providers.
    //     Mirrors the same resolution block in tomoriChat.ts so snapshot reflects exactly
    //     what the live pipeline would use.
    const channelLlmOverride = await getCachedChannelLlm(selectedPersona.server_id, interaction.channelId);
    const effectiveLlm = selectedPersona.persona_llm ?? channelLlmOverride ?? selectedPersona.llm;

    // Resolve any per-channel system prompt override so the snapshot reflects what the
    // live pipeline would inject for this channel (append/replace). Mirrors contextPipeline.ts.
    const channelPromptOverride = await getCachedChannelPrompt(selectedPersona.server_id, interaction.channelId);

    const channelContextNote = await getCachedChannelContextNote(selectedPersona.server_id, interaction.channelId);

    let effectivePersona = selectedPersona;
    if (effectiveLlm !== selectedPersona.llm) {
      effectivePersona = { ...selectedPersona, llm: effectiveLlm };

      const overrideProvider = effectiveLlm.llm_provider.toLowerCase();
      if (overrideProvider !== selectedPersona.llm.llm_provider.toLowerCase()) {
        const overrideSavedConfig = await llmProviderRepo.loadSavedProviderConfig(
          selectedPersona.server_id,
          overrideProvider,
        );
        if (overrideSavedConfig) {
          effectivePersona = {
            ...effectivePersona,
            config: {
              ...selectedPersona.config,
              llm_temperature: overrideSavedConfig.llm_temperature ?? selectedPersona.config.llm_temperature,
              llm_top_p: overrideSavedConfig.llm_top_p ?? selectedPersona.config.llm_top_p,
              llm_top_k: overrideSavedConfig.llm_top_k ?? selectedPersona.config.llm_top_k,
              llm_frequency_penalty:
                overrideSavedConfig.llm_frequency_penalty ?? selectedPersona.config.llm_frequency_penalty,
              llm_presence_penalty:
                overrideSavedConfig.llm_presence_penalty ?? selectedPersona.config.llm_presence_penalty,
              llm_min_p: overrideSavedConfig.llm_min_p ?? selectedPersona.config.llm_min_p,
              thinking_level: overrideSavedConfig.thinking_level ?? selectedPersona.config.thinking_level,
              llm_disabled_params:
                overrideSavedConfig.llm_disabled_params ?? selectedPersona.config.llm_disabled_params,
              llm_logit_biases: overrideSavedConfig.llm_logit_biases ?? selectedPersona.config.llm_logit_biases,
            },
          };
        }
      }
    }

    const answeringState = await resolveSnapshotAnsweringState({
      selectedPersona,
      effectivePersona,
      userId: userData.user_id ?? null,
    });

    const textChannel = interaction.channel;
    if (!("messages" in textChannel)) {
      await modalInteraction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "commands.tool.prompt.snapshot.build_failed_title"))
            .setDescription(localizer(locale, "commands.tool.prompt.snapshot.build_failed_description"))
            .setColor(ColorCode.ERROR),
        ],
      });
      return;
    }

    const messageFetchLimit = normalizeMessageFetchLimit(selectedPersona.config.message_fetch_limit);
    const fetchedMessages = await textChannel.messages.fetch({ limit: messageFetchLimit });
    const allMessagesArray = Array.from(fetchedMessages.values()).reverse();

    // Respect /refresh and /compact_refresh boundaries: same slicing logic
    //      used by the live chat pipeline in tomoriChat.ts so snapshot reflects
    //      exactly what the LLM would actually see
    const { sliced: messagesArray } = sliceMessagesAtResetMarker(allMessagesArray);
    const snapshotToolFilter =
      fetchTools && format === "json"
        ? await buildSnapshotToolFilter({
            messagesArray,
            clientUserId: client.user?.id,
            persona: answeringState,
            invokingUserData: userData,
          })
        : null;

    const personaByNickname = new Map<string, TomoriState>();
    for (const p of personas) {
      if (!p.persona_nickname) continue;
      const key = normalizeRenderModifierName(p.persona_nickname);
      if (!personaByNickname.has(key)) personaByNickname.set(key, p);
    }
    const mainPersona = personas.find((p) => !p.is_alter) ?? tomoriState;

    type SimpleMsg = {
      id: string;
      authorId: string;
      authorName: string;
      authorType: "user" | "persona";
      personaName?: string | null;
      content: string | null;
      mediaSourceMessageIds?: string[];
      imageAttachments: Array<{
        url: string;
        proxyUrl: string;
        mimeType: string | null;
        filename: string;
        isEmoji?: boolean;
      }>;
      videoAttachments: Array<{
        url: string;
        proxyUrl: string;
        mimeType: string | null;
        filename: string;
        isYouTubeLink: boolean;
      }>;
    };

    const simplifiedMessages: SimpleMsg[] = [];
    const userListSet = new Set<string>();
    const syntheticUsers = new Map<string, { displayName: string; type: "persona" | "webhook" }>();

    for (const message of messagesArray) {
      // Skip fully-private users (same gate as real context building)
      if (!message.webhookId) {
        const privacyLevel = await getCachedPrivacyLevel(message.author.id);
        if (privacyLevel === PrivacyLevel.FULL) continue;
      }

      let effectiveAuthorId = message.author.id;
      let authorName = `<@${message.author.id}>`;
      let authorType: "user" | "persona" = "user";
      let personaName: string | null = null;

      if (message.author.id === client.user?.id) {
        authorName = mainPersona.persona_nickname ?? tomoriState.persona_nickname ?? message.author.username;
        authorType = "persona";
        personaName = authorName;
      } else if (message.webhookId) {
        const webhookName = message.author.username?.trim();
        const renderModifierSource = webhookName
          ? resolveRenderModifierSourcePersona(webhookName, personaByNickname)
          : null;
        const matchedPersona = webhookName
          ? (renderModifierSource?.persona ?? personaByNickname.get(normalizeRenderModifierName(webhookName)))
          : undefined;
        if (matchedPersona) {
          // Mirror the real pipeline: recover the decorated "Name (sprite)" label
          // for clean-named sprite messages from the persisted mapping.
          const spriteDisplayName = renderModifierSource
            ? null
            : await resolveSpriteMessageDisplayName(
                message.id,
                matchedPersona.persona_id,
                matchedPersona.persona_nickname,
              );
          authorName = renderModifierSource?.displayName ?? spriteDisplayName ?? matchedPersona.persona_nickname;
          authorType = "persona";
          personaName = matchedPersona.persona_nickname;
          effectiveAuthorId = String(matchedPersona.persona_id ?? matchedPersona.persona_nickname);
          syntheticUsers.set(effectiveAuthorId, { displayName: authorName, type: "persona" });
        } else if (webhookName) {
          authorName = webhookName;
        }
      }

      const imageAttachments: SimpleMsg["imageAttachments"] = [];
      const videoAttachments: SimpleMsg["videoAttachments"] = [];
      let hasLocalMedia = false;

      const directMediaCounts = appendSupportedMediaFromMessage(message, imageAttachments, videoAttachments);
      const componentMediaCounts = appendComponentMediaFromMessage(message, imageAttachments, videoAttachments);
      hasLocalMedia =
        directMediaCounts.imageCount > 0 ||
        directMediaCounts.videoCount > 0 ||
        componentMediaCounts.imageCount > 0 ||
        componentMediaCounts.videoCount > 0;

      for (const sticker of message.stickers.values()) {
        const stickerUrl = `https://cdn.discordapp.com/stickers/${sticker.id}.png`;
        imageAttachments.push({
          url: stickerUrl,
          proxyUrl: stickerUrl,
          mimeType: "image/png",
          filename: `${sticker.name}.png`,
        });
        hasLocalMedia = true;
      }

      if (message.content) {
        for (const pattern of YOUTUBE_URL_PATTERNS) {
          const match = message.content.match(pattern);
          if (!match) continue;
          videoAttachments.push({
            url: match[0],
            proxyUrl: match[0],
            mimeType: "video/youtube",
            filename: `youtube_video_${match[1]}.mp4`,
            isYouTubeLink: true,
          });
          hasLocalMedia = true;
          break;
        }
      }

      // Process embeds to match tomoriChat.ts conversion rules:
      //   a) System-produced embeds (memory_learning, reminder_set, system_injection,
      //      compact_summary/refresh, reward, punish) are wrapped as `[System: ...]`
      //      blocks and appended to message content, so this applies to ALL messages.
      //   b) Link-preview embeds (Twitter/YouTube/articles) are extracted as
      //      `[System: Link preview embed content: ...]` and their images are added
      //      to imageAttachments, so ONLY for non-Tomori-authored messages.
      const botNickname = mainPersona.persona_nickname ?? tomoriState.persona_nickname ?? null;
      const isTomoriAuthored = message.author.id === client.user?.id;
      const embedTextSegments: string[] = [];
      if (message.embeds.length > 0) {
        for (const embed of message.embeds) {
          const embedCheck = checkTargetEmbedTitle(embed.title);
          if (embedCheck.isTarget && embed.description) {
            const type = embedCheck.type;
            if (type === "system_injection" || type === "compact_summary" || type === "compact_refresh") {
              const titleLine =
                (type === "compact_summary" || type === "compact_refresh") && embed.title ? `## ${embed.title}\n` : "";
              embedTextSegments.push(`[System: ${titleLine}${embed.description}]`);
            } else {
              let cleanedDescription = embed.description;
              if (botNickname) {
                const escapedNickname = botNickname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                const botNamePattern = new RegExp(`^${escapedNickname}:\\s*`, "i");
                if (botNamePattern.test(cleanedDescription)) {
                  cleanedDescription = cleanedDescription.replace(botNamePattern, "").trim();
                }
              }
              const includeTitle = type === "memory_learning" || type === "reminder_set";
              const titleLine = includeTitle && embed.title ? `${embed.title}\n` : "";
              const embedBody = `${titleLine}${cleanedDescription}`;
              embedTextSegments.push(
                type === "memory_learning" || type === "reward" || type === "punish"
                  ? `[System: ${embedBody}]`
                  : formatSystemProducedEmbedHint(embedBody),
              );
            }
          } else if (!isTomoriAuthored) {
            const linkEmbedData = processLinkEmbed(embed);
            if (linkEmbedData.isLinkPreview) {
              if (linkEmbedData.textContent) embedTextSegments.push(linkEmbedData.textContent);
              if (linkEmbedData.imageInfo) {
                imageAttachments.push({
                  url: linkEmbedData.imageInfo.url,
                  proxyUrl: linkEmbedData.imageInfo.proxyUrl,
                  mimeType: linkEmbedData.imageInfo.mimeType,
                  filename: linkEmbedData.imageInfo.filename,
                });
                hasLocalMedia = true;
              }
              if (linkEmbedData.thumbnailInfo) {
                imageAttachments.push({
                  url: linkEmbedData.thumbnailInfo.url,
                  proxyUrl: linkEmbedData.thumbnailInfo.proxyUrl,
                  mimeType: linkEmbedData.thumbnailInfo.mimeType,
                  filename: linkEmbedData.thumbnailInfo.filename,
                });
                hasLocalMedia = true;
              }
            }
          }
        }
      }

      // Components V2 notices carry no embeds, so reconstruct their text from the
      // component tree to keep snapshots identical to live chat context.
      const cv2Notice = extractNoticeTextFromComponents(message.components);
      if (cv2Notice?.title && cv2Notice.description) {
        const noticeCheck = checkTargetEmbedTitle(cv2Notice.title);
        if (noticeCheck.isTarget) {
          const type = noticeCheck.type;
          if (type === "system_injection" || type === "compact_summary" || type === "compact_refresh") {
            const titleLine = type === "system_injection" ? "" : `## ${cv2Notice.title}\n`;
            embedTextSegments.push(`[System: ${titleLine}${cv2Notice.description}]`);
          } else {
            const includeTitle = type === "memory_learning" || type === "reminder_set";
            const titleLine = includeTitle ? `${cv2Notice.title}\n` : "";
            const embedBody = `${titleLine}${cv2Notice.description}`;
            embedTextSegments.push(
              type === "memory_learning" || type === "reward" || type === "punish"
                ? `[System: ${embedBody}]`
                : formatSystemProducedEmbedHint(embedBody),
            );
          }
        }
      }

      const baseContent = message.content?.trim() ? message.content : "";
      const combinedContent = [baseContent, ...embedTextSegments].filter((s) => s.length > 0).join("\n");
      const messageContent = combinedContent.length > 0 ? combinedContent : null;
      const mediaSourceMessageIds = hasLocalMedia ? [message.id] : undefined;

      // Merge consecutive same-author messages, mirroring the real context path
      // (buildSimplifiedHistory): collapse only when both sides are pure text if
      // either side carries media, keep separate turns so per-message media IDs stay
      // unambiguous.
      const prevMsg = simplifiedMessages[simplifiedMessages.length - 1];
      const currentHasMedia =
        imageAttachments.length > 0 || videoAttachments.length > 0 || (mediaSourceMessageIds?.length ?? 0) > 0;
      const prevHasMedia =
        !!prevMsg &&
        (prevMsg.imageAttachments.length > 0 ||
          prevMsg.videoAttachments.length > 0 ||
          (prevMsg.mediaSourceMessageIds?.length ?? 0) > 0);
      const shouldKeepSeparateMediaTurn = currentHasMedia || prevHasMedia;
      if (
        prevMsg &&
        prevMsg.authorId === effectiveAuthorId &&
        prevMsg.content &&
        messageContent &&
        !shouldKeepSeparateMediaTurn
      ) {
        prevMsg.content += `\n${messageContent}`;
      } else if (messageContent || imageAttachments.length > 0 || videoAttachments.length > 0) {
        simplifiedMessages.push({
          id: message.id,
          authorId: effectiveAuthorId,
          authorName,
          authorType,
          personaName,
          content: messageContent,
          mediaSourceMessageIds,
          imageAttachments,
          videoAttachments,
        });
      }

      userListSet.add(effectiveAuthorId);
    }

    if (client.user?.id) userListSet.add(client.user.id);

    const isDMChannel = !interaction.guildId;
    const channelName =
      "name" in textChannel && typeof textChannel.name === "string" ? textChannel.name : "unknown-channel";
    const channelDesc = "topic" in textChannel ? (textChannel.topic as string | null) : null;

    const matrixUsers = new Map<string, string>();
    const preparedParticipantContext = await prepareParticipantContext({
      client,
      guildId: interaction.guild.id,
      simplifiedMessageHistory: simplifiedMessages,
      personas,
      activePersona: effectivePersona,
      visibleUserIds: [...userListSet],
      syntheticUsers,
      matrixUsers,
    });

    // Mirrors the naming resolution in turnPlanner, since a snapshot that shows the raw
    // Discord name is not a preview of the prompt the model actually receives.
    const snapshotDisplayName =
      interaction.user.displayName || interaction.user.globalName || interaction.user.username;
    const isTriggererBlacklisted = await userRepository
      .isBlacklisted(interaction.guild.id, interaction.user.id)
      .catch(() => false);
    const canUsePersonalizedNaming =
      !isTriggererBlacklisted && effectivePersona.config.personal_memories_enabled !== false;
    const snapshotNamingPreference =
      canUsePersonalizedNaming && userData.user_id
        ? (
            await userNamingRepository
              .loadPreferences([{ userId: userData.user_id, personaLineageId: effectivePersona.persona_lineage_id }])
              .catch(() => null)
          )?.get(userPersonaNamingPairKey(userData.user_id, effectivePersona.persona_lineage_id))
        : undefined;
    const snapshotNaming = resolveEffectiveUserNaming({
      global: {
        userNickname: canUsePersonalizedNaming ? userData.user_nickname : null,
        prefixOverride: canUsePersonalizedNaming ? (userData.prefix_override ?? null) : null,
        suffixOverride: canUsePersonalizedNaming ? (userData.suffix_override ?? null) : null,
        addressingStyle: canUsePersonalizedNaming ? (userData.addressing_style ?? null) : null,
      },
      liveDisplayName: snapshotDisplayName,
      persona: canUsePersonalizedNaming ? effectivePersona.naming_config : undefined,
      preference: canUsePersonalizedNaming ? snapshotNamingPreference : null,
    });

    const contextBuild = await buildContext({
      guildId: interaction.guild.id,
      serverName: interaction.guild.name,
      serverDescription: interaction.guild.description || null,
      simplifiedMessageHistory: simplifiedMessages,
      preparedParticipantContext,
      channelDesc,
      channelName,
      channelId: interaction.channelId,
      // Thread → parent-channel privacy inheritance (mirrors tomoriChat.ts)
      parentChannelId: textChannel.isThread() ? textChannel.parentId : null,
      client,
      triggererName: snapshotNaming.nickname,
      triggererFormattedName: snapshotNaming.formattedName,
      triggererAddressTerm: snapshotNaming.addressTerm,
      // snapshot.triggererUserRow unlocks STM context (actualTriggeringUserId guard inside buildContext)
      snapshot: { triggererUserRow: userData, tomoriState: effectivePersona, isTriggererBlacklisted },
      tomoriNickname: selectedPersona.persona_nickname ?? process.env.DEFAULT_BOTNAME ?? "Tomori",
      tomoriAttributes: selectedPersona.attribute_list,
      tomoriConfig: effectivePersona.config,
      channelPromptOverride,
      channelContextNote,
      personaPrompt: selectedPersona.persona_prompt ?? null,
      personaLineageId: selectedPersona.persona_lineage_id,
      isDMChannel,
    });

    const contextItems = [...contextBuild.contextItems];

    // Apply tail directives in the same order as the live chat pipeline so the
    //      snapshot reflects the full prompt the LLM would actually see:
    //        Lower-priority tails (STM "create" prompt, emoji penalty) inserted
    //           before the latest dialogue pair so they don't displace recent turns.
    //        Normal tails (e.g. impersonation directive) appended to the end.
    //        Uncensor directive appended last (isolated, strongest recency signal).
    const lowerPriorityTailDirectives = [...contextBuild.lowerPriorityTailDirectives];
    const emojiPenaltyDirective = getEmojiPenaltyDirective(
      contextItems,
      selectedPersona.persona_nickname ?? process.env.DEFAULT_BOTNAME ?? "Tomori",
    );
    if (emojiPenaltyDirective) lowerPriorityTailDirectives.push(emojiPenaltyDirective);

    const lowerPriorityTailMessage = buildCombinedTailDirectiveMessage(lowerPriorityTailDirectives);
    if (lowerPriorityTailMessage) insertBeforeLatestDialoguePair(contextItems, lowerPriorityTailMessage);

    // Mirror the live pipeline: inject the deferred STM content block at its depth
    // (only when content depth >= 0), before the nudge so the snapshot ordering matches.
    if (
      contextBuild.memoryInjectionItems &&
      contextBuild.memoryInjectionItems.length > 0 &&
      (contextBuild.memoryInjectionDepth ?? -1) >= 0
    ) {
      for (const memoryItem of contextBuild.memoryInjectionItems) {
        insertAtDialogueDepth(contextItems, memoryItem, contextBuild.memoryInjectionDepth ?? 0);
      }
    }

    // Mirror the live pipeline: inject the unified STM nudge at its configured depth.
    if (contextBuild.nudgeItem) {
      insertAtDialogueDepth(contextItems, contextBuild.nudgeItem, contextBuild.nudgeInjectionDepth ?? 0);
    }

    const combinedTailMessage = buildCombinedTailDirectiveMessage([...contextBuild.tailDirectives]);
    if (combinedTailMessage) contextItems.push(combinedTailMessage);

    if (contextBuild.uncensorDirective) {
      const uncensorTailMessage = buildCombinedTailDirectiveMessage([contextBuild.uncensorDirective]);
      if (uncensorTailMessage) contextItems.push(uncensorTailMessage);
    }

    const resolvedContextItems = await resolveMediaForModel(contextItems, answeringState);

    const presetData = await getCachedActivePreset(selectedPersona.server_id);
    const presetName = presetData?.preset.preset_name ?? null;

    // Resolve effective model: mirrors the routed answering state used for media resolution.
    const providerName = normalizeProviderName(answeringState.llm.llm_provider);
    const modelName = answeringState.llm.llm_codename;
    const timestamp = new Date().toISOString();

    // Optionally fetch provider-formatted tool definitions (JSON output only).
    //     TXT format intentionally omits tools, so users are directed to use JSON for tools.
    let toolsData: Array<Record<string, unknown>> | null = null;
    if (fetchTools && format === "json") {
      try {
        toolsData = await fetchProviderTools(answeringState, providerName, snapshotToolFilter);
      } catch (toolError) {
        log.warn(
          `Failed to fetch tools for prompt snapshot (provider=${providerName}): ${(toolError as Error).message}`,
        );
      }
    }

    // Both output formats show the request config in the DM, while JSON also
    // stores it at the top level for machine-readable inspection.
    const requestConfig = buildRequestConfig(answeringState, providerName, modelName);

    let fileContent: string;
    let fileName: string;

    if (format === "json") {
      const snapshotData = await buildJsonSnapshot(
        resolvedContextItems,
        answeringState,
        providerName,
        modelName,
        toolsData,
        requestConfig,
      );
      fileContent = JSON.stringify(snapshotData, null, 2);
      fileName = `prompt-snapshot-${interaction.channelId}-${selectedPersona.persona_lineage_id}-${Date.now()}.json`;
    } else {
      fileContent = buildTextSnapshot(resolvedContextItems);
      fileName = `prompt-snapshot-${interaction.channelId}-${selectedPersona.persona_lineage_id}-${Date.now()}.txt`;
    }

    const attachment = new AttachmentBuilder(Buffer.from(fileContent, "utf-8"), { name: fileName });
    const formatLabel = format === "json" ? "JSON" : "Text";

    const descriptionParts: string[] = [];
    descriptionParts.push(
      localizer(locale, "commands.tool.prompt.snapshot.dm_description", {
        persona_name: selectedPersona.persona_nickname,
        format: formatLabel,
      }),
    );
    descriptionParts.push(
      [
        "```yaml",
        `server_id: ${interaction.guild.id}`,
        `channel: #${channelName}`,
        `persona: ${selectedPersona.persona_nickname}`,
        `provider: ${providerName}`,
        `model: ${modelName}`,
        `preset: ${presetName ?? "(native)"}`,
        `captured: ${timestamp}`,
        "```",
      ].join("\n"),
    );
    descriptionParts.push(
      [
        localizer(locale, "commands.tool.prompt.snapshot.dm_config_heading"),
        "```json",
        JSON.stringify(requestConfig, null, 2),
        "```",
      ].join("\n"),
    );
    if (format === "text") {
      descriptionParts.push(localizer(locale, "commands.tool.prompt.snapshot.dm_txt_headers_note"));
      descriptionParts.push(localizer(locale, "commands.tool.prompt.snapshot.dm_hint_try_json"));
      if (fetchTools) {
        descriptionParts.push(localizer(locale, "commands.tool.prompt.snapshot.dm_tools_txt_note"));
      }
    } else {
      descriptionParts.push(localizer(locale, "commands.tool.prompt.snapshot.dm_hint_try_text"));
      if (fetchTools) {
        descriptionParts.push(localizer(locale, "commands.tool.prompt.snapshot.dm_tools_filtering_note"));
      }
    }
    const dmDescription = descriptionParts.join("\n\n");

    try {
      await interaction.user.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "commands.tool.prompt.snapshot.dm_title"))
            .setDescription(dmDescription)
            .setColor(ColorCode.INFO),
        ],
        files: [attachment],
      });

      await modalInteraction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "commands.tool.prompt.snapshot.success_title"))
            .setDescription(localizer(locale, "commands.tool.prompt.snapshot.success_description"))
            .setColor(ColorCode.SUCCESS),
        ],
      });
    } catch (dmError) {
      log.warn(`Failed to DM prompt snapshot to user ${interaction.user.id}:`, dmError as Error);
      await modalInteraction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "commands.tool.prompt.snapshot.dm_failed_title"))
            .setDescription(
              `${localizer(locale, "commands.tool.prompt.snapshot.dm_failed_description")}\n\n${dmDescription}`,
            )
            .setColor(ColorCode.WARN),
        ],
        files: [attachment],
      });
    }
  } catch (error) {
    log.error("Error executing /tool prompt snapshot:", error as Error, {
      errorType: "CommandExecutionError",
      metadata: { commandName: "tool prompt snapshot", guildId: interaction.guild?.id },
    });

    if (!interaction.replied && !interaction.deferred) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.unknown_error_title",
        descriptionKey: "general.errors.unknown_error_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
    }
  }
}

/**
 * Human-readable label (and optional command hint) for each `ContextItemTag`.
 * Rendered by `buildTextSnapshot` as `=== Title (command/system-managed) ===` blocks.
 *
 * `subsections` lets a single context item (especially composites like
 * `KNOWLEDGE_USERS_IN_CONVERSATION`: expose multiple `== SubTitle ==` markers
 * so users can see which separate data pools feed into that block.
 */
type TagLabel = {
  title: string;
  hint: string; // Slash-command reference like `/config system-prompt`, or the literal "system-managed"
  subsections?: Array<{ title: string; hint: string }>;
};

const TAG_LABELS: Record<string, TagLabel> = {
  [ContextItemTag.SYSTEM_INSTRUCTION_BLOCK]: { title: "System Instruction Block", hint: "system-managed" },
  [ContextItemTag.SYSTEM_PERSONALITY]: { title: "Persona Attributes", hint: "/persona attribute" },
  [ContextItemTag.SYSTEM_HUMANIZER_RULES]: { title: "System Prompt", hint: "/config system-prompt" },
  [ContextItemTag.SYSTEM_CHANNEL_PROMPT]: { title: "Channel Prompt", hint: "/server channel-prompt" },
  [ContextItemTag.SYSTEM_PERSONA_PROMPT]: { title: "Persona Prompt", hint: "/persona prompt" },
  [ContextItemTag.SYSTEM_FUNCTION_GUIDE]: { title: "Function Guide", hint: "system-managed" },
  [ContextItemTag.KNOWLEDGE_SERVER_INFO]: { title: "Discord Server Info", hint: "system-managed" },
  [ContextItemTag.KNOWLEDGE_SERVER_EMOJIS]: { title: "Server Emojis", hint: "system-managed" },
  [ContextItemTag.KNOWLEDGE_SERVER_STICKERS]: { title: "Server Stickers", hint: "system-managed" },
  [ContextItemTag.KNOWLEDGE_PERSONA_SPRITES]: { title: "Persona Sprites", hint: "/persona sprites" },
  [ContextItemTag.KNOWLEDGE_SERVER_MEMORIES]: { title: "Server Memories", hint: "/memories" },
  [ContextItemTag.KNOWLEDGE_SERVER_DOCUMENTS]: { title: "Server Documents", hint: "/memories" },
  [ContextItemTag.KNOWLEDGE_SERVER_CONDITIONING]: { title: "Conditioning Log", hint: "/conditioning" },
  [ContextItemTag.KNOWLEDGE_USER_MEMORIES]: { title: "Personal Memories", hint: "/personal memories" },
  [ContextItemTag.KNOWLEDGE_USER_STATUS]: { title: "Discord Presence", hint: "system-managed" },
  [ContextItemTag.KNOWLEDGE_CURRENT_CONTEXT]: { title: "Current Context", hint: "system-managed" },
  [ContextItemTag.KNOWLEDGE_USERS_IN_CONVERSATION]: {
    title: "Info on Users in Context",
    hint: "composite",
    subsections: [
      { title: "Personal/Server Memories", hint: "/memories, /personal memories" },
      { title: "Discord Presence/Role/Channel", hint: "system-managed" },
      { title: "Other Personas' Public Attributes", hint: "/persona attribute" },
    ],
  },
  [ContextItemTag.KNOWLEDGE_SHORT_TERM_MEMORY]: { title: "Short-Term Memory", hint: "/memories" },
  [ContextItemTag.DIALOGUE_SAMPLE]: { title: "Sample Dialogue", hint: "/persona sample-dialogue" },
  [ContextItemTag.DIALOGUE_HISTORY]: { title: "Conversation History", hint: "system-managed" },
  [ContextItemTag.CONTEXT_NOTE_INJECTION]: { title: "Context Note", hint: "/config context-note" },
};

function renderTagHeader(tag: string | undefined): string {
  if (!tag) return "=== Untagged (system-managed) ===";
  const label = TAG_LABELS[tag];
  if (!label) return `=== ${tag} (system-managed) ===`;

  const lines: string[] = [];
  if (label.hint === "composite") {
    lines.push(`=== ${label.title} ===`);
  } else if (label.hint === "system-managed") {
    lines.push(`=== ${label.title} (system-managed) ===`);
  } else {
    lines.push(`=== ${label.title} (\`${label.hint}\`) ===`);
  }
  if (label.subsections) {
    for (const sub of label.subsections) {
      if (sub.hint === "system-managed") {
        lines.push(`== ${sub.title} (system-managed) ==`);
      } else {
        lines.push(`== ${sub.title} (\`${sub.hint}\`) ==`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * Serializes `contextItems` (already rearranged by preset routing, if applicable) into
 * a human-readable flat-text format that mirrors the order produced by `buildContext`.
 *
 * Each context item gets a `=== Title (/command) ===` header derived from its
 * `metadataTag`. These headers are annotations: they are NOT part of the prompt
 * actually sent to the LLM. The DM body that ships with the file explains this.
 */
function buildTextSnapshot(contextItems: StructuredContextItem[]): string {
  const lines: string[] = [];

  for (const item of contextItems) {
    lines.push(renderTagHeader(item.metadataTag));

    for (const part of item.parts) {
      if (part.type === "text") {
        lines.push(part.text);
      } else if (part.type === "image") {
        // Estimate byte size from data URI length (base64 overhead ~1.33×)
        const byteEstimate = part.uri.startsWith("data:")
          ? Math.round(((part.uri.length - part.uri.indexOf(",") - 1) * 3) / 4)
          : 0;
        const sizeLabel = byteEstimate > 0 ? `~${byteEstimate} bytes` : "URL";
        lines.push(`[IMAGE: ${part.mimeType}, ${sizeLabel}, hidden]`);
      } else if (part.type === "video") {
        const ytSuffix = part.isYouTubeLink ? ", YouTube" : "";
        lines.push(`[VIDEO: ${part.mimeType}${ytSuffix}, hidden]`);
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Produces a provider-specific JSON snapshot that matches the format emitted by
 * each adapter's `logSanitizedRequest` to terminal. Base64 image data is redacted
 * to keep file sizes manageable, matching the terminal log sanitization.
 *
 * Supported providers with full native fidelity:
 *   - google            → GoogleStreamAdapter.buildTokenCountPayload
 *   - vertex            → VertexStreamAdapter.buildTokenCountPayload
 *   - vertexexpress     → VertexexpressStreamAdapter.buildTokenCountPayload
 *   - openrouter-family → OpenrouterStreamAdapter.buildProbeMessages
 *   - anthropic         → AnthropicStreamAdapter.buildProbeMessages
 *
 * All other providers (novelai, custom, etc.) fall back to a flat OpenAI-style
 * `{model, messages: [{role, content}]}` shape. Messages with media use the
 * OpenAI-vision array-content form; text-only messages use plain strings.
 *
 * Metadata (server/channel/persona/provider/preset) is NOT embedded in the file:
 * it is rendered in the DM body instead, to keep the file focused on payload.
 *
 * When `toolsData` is provided, a top-level `tools` key is appended in the same
 * shape the adapter would send to the provider.
 */
async function buildJsonSnapshot(
  contextItems: StructuredContextItem[],
  persona: TomoriState,
  providerName: string,
  modelName: string,
  toolsData: Array<Record<string, unknown>> | null,
  requestConfig: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const activeLlm = persona.persona_llm ?? persona.llm;
  const seesImages = activeLlm.sees_images;
  const seesVideos = activeLlm.sees_videos;

  let requestData: Record<string, unknown>;
  const providerInfo = getStaticProviderInfo(providerName);
  const providerKey = providerInfo?.name ?? normalizeProviderName(providerName);
  const providerFamily = providerInfo?.apiFamily ?? "openai-compatible";
  const googleSnapshotAdapterFactories: Record<
    string,
    () => GoogleStreamAdapter | VertexStreamAdapter | VertexexpressStreamAdapter
  > = {
    google: () => new GoogleStreamAdapter(),
    vertex: () => new VertexStreamAdapter(),
    vertexexpress: () => new VertexexpressStreamAdapter(),
  };
  const googleSnapshotAdapterFactory = googleSnapshotAdapterFactories[providerKey];

  if (googleSnapshotAdapterFactory) {
    const adapter = googleSnapshotAdapterFactory();
    const payload = await adapter.buildTokenCountPayload(contextItems, modelName);

    // Sanitize: replace inlineData.data (base64) with placeholder (mirrors logSanitizedRequest)
    const sanitizedContents = payload.contents.map((content) => ({
      ...content,
      // biome-ignore lint/suspicious/noExplicitAny: Google Part type lacks index signature; cast needed for sanitization
      parts: ((content.parts ?? []) as Array<any>).map((part: Record<string, unknown>) => {
        if ("inlineData" in part && part.inlineData) {
          const inlineData = part.inlineData as Record<string, unknown>;
          return { inlineData: { mimeType: inlineData.mimeType, data: "[BASE64_HIDDEN]" } };
        }
        return part;
      }),
    }));

    requestData = {
      model: modelName,
      systemInstruction: payload.systemInstruction,
      contents: sanitizedContents,
    };
  } else if (providerFamily === "openrouter" || providerFamily === "openai-compatible") {
    const adapter = new OpenrouterStreamAdapter();
    const messages = await adapter.buildProbeMessages(contextItems, seesImages, seesVideos);

    // Sanitize: replace data-URI image_url values (mirrors logSanitizedRequest)
    const sanitized = messages.map((msg: Record<string, unknown>) => {
      if (!Array.isArray(msg.content)) return msg;
      return {
        ...msg,
        content: (msg.content as Array<Record<string, unknown>>).map((part) => {
          if (part.type === "image_url") {
            const imageUrl = (part as { image_url?: { url?: string } }).image_url;
            if (imageUrl?.url?.startsWith("data:")) {
              return { type: "image_url", image_url: { ...imageUrl, url: "[BASE64_HIDDEN]" } };
            }
          }
          return part;
        }),
      };
    });

    requestData = { model: modelName, messages: sanitized };
  } else if (providerFamily === "anthropic") {
    const adapter = new AnthropicStreamAdapter();
    const { system, messages } = await adapter.buildProbeMessages(contextItems, seesImages);

    // Sanitize: replace base64 image source.data (mirrors logSanitizedRequest)
    const sanitizedMessages = messages.map((msg: Record<string, unknown>) => {
      const content = msg.content;
      if (typeof content === "string") return msg;
      const sanitizedContent = (content as Array<Record<string, unknown>>).map((block) => {
        if (
          block.type === "image" &&
          block.source &&
          typeof (block.source as Record<string, unknown>).data === "string"
        ) {
          return { ...block, source: { ...(block.source as Record<string, unknown>), data: "[BASE64_HIDDEN]" } };
        }
        return block;
      });
      return { ...msg, content: sanitizedContent };
    });

    requestData = { model: modelName, system, messages: sanitizedMessages };
  } else {
    // Fallback for providers without a public probe builder (novelai, custom, etc.):
    // flatten `contextItems` into a plain `{model, messages: [{role, content}]}` shape.
    // Role remap: `model` → `assistant` to match OpenAI conventions.

    // Consolidate all system items into a single leading entry
    //    OpenAI-compatible APIs only accept one `role: "system"` message,
    //    so we flatten multiple system blocks (personality, rules, knowledge, etc.)
    //    by joining their text parts with "\n\n" into one entry.
    const systemTextChunks: string[] = [];
    const nonSystemItems: StructuredContextItem[] = [];
    for (const item of contextItems) {
      if (item.role === "system") {
        const text = item.parts
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("\n");
        if (text.trim()) systemTextChunks.push(text);
      } else {
        nonSystemItems.push(item);
      }
    }

    const messagesList: Array<Record<string, unknown>> = [];
    if (systemTextChunks.length > 0) {
      messagesList.push({ role: "system", content: systemTextChunks.join("\n\n") });
    }

    for (const item of nonSystemItems) {
      const role = item.role === "model" ? "assistant" : item.role;
      const hasMedia = item.parts.some((p) => p.type !== "text");

      if (!hasMedia) {
        const text = item.parts
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("\n");
        messagesList.push({ role, content: text });
        continue;
      }

      const content = item.parts.map((part) => {
        if (part.type === "text") return { type: "text", text: part.text };
        if (part.type === "image") {
          return { type: "image_url", image_url: { url: "[MEDIA_HIDDEN]" }, mime_type: part.mimeType };
        }
        return {
          type: "video_url",
          video_url: { url: "[MEDIA_HIDDEN]" },
          mime_type: part.mimeType,
          ...(part.isYouTubeLink ? { youtube: true } : {}),
        };
      });
      messagesList.push({ role, content });
    }

    requestData = { model: modelName, messages: messagesList };
  }

  // Merge per-provider sampling/request config into the top level.
  //    For Google/Vertex we nest under existing keys (`generation_config`, `safety_settings`, etc.)
  //    so the shape continues to match what the adapter would send. For Anthropic and
  //    OpenAI-compat we just spread onto the root object.
  for (const [key, value] of Object.entries(requestConfig)) {
    if (!(key in requestData)) requestData[key] = value;
  }

  // Append provider-formatted tools when requested, including an empty list
  //    when per-turn filtering deliberately suppresses every tool.
  if (toolsData) {
    requestData.tools = toolsData;
  }

  return requestData;
}

/**
 * Resolves the tool adapter matching the given provider. Non-OpenAI providers
 * (google/vertex/vertexexpress/anthropic) have dedicated adapters; OpenAI-compatible providers
 * share the openrouter-style adapter via subclasses. NovelAI keeps its own.
 * Unknown providers fall back to the OpenRouter adapter for OpenAI-compat shape.
 */
function selectToolAdapter(providerName: string): MCPCapableToolAdapter {
  const adapterFactories: Record<string, () => MCPCapableToolAdapter> = {
    google: getGoogleToolAdapter,
    vertex: getVertexToolAdapter,
    vertexexpress: getVertexexpressToolAdapter,
    anthropic: getAnthropicToolAdapter,
    openrouter: getOpenrouterToolAdapter,
    deepseek: getDeepseekToolAdapter,
    zai: getZaiToolAdapter,
    zaicoding: getZaicodingToolAdapter,
    nvidia: getNvidiaToolAdapter,
    novelai: getNovelaiToolAdapter,
    custom: getCustomToolAdapter,
  };
  const providerKey = getStaticProviderInfo(providerName)?.name ?? normalizeProviderName(providerName);
  return (adapterFactories[providerKey] ?? getOpenrouterToolAdapter)();
}

/**
 * Mirrors the tool-list assembly that `<Provider>Provider.getTools` does at
 * runtime, including the deliberate-mode per-turn allowlist when it can be
 * reconstructed from the latest visible user message. Returns the provider's
 * native tool JSON (OpenAI function spec for OpenAI-compat, Gemini schema for
 * Google, etc.).
 */
async function fetchProviderTools(
  persona: TomoriState,
  providerName: string,
  toolFilter?: SnapshotToolFilter | null,
): Promise<Array<Record<string, unknown>>> {
  const activeLlm = persona.persona_llm ?? persona.llm;

  if (!activeLlm.has_tools || toolFilter?.disabledByDeliberateMode) {
    return [];
  }

  const toolStateForContext: ToolStateForContext = {
    server_id: persona.server_id.toString(),
    activePersonaHasElevenlabsVoice: Boolean(
      persona.speech_voice_sample_id || persona.speech_voice_design_prompt?.trim() || persona.speech_voice_id?.trim(),
    ),
    activePersonaVoiceDesignPrompt: persona.speech_voice_design_prompt?.trim() || null,
    activePersonaVoiceName: persona.speech_voice_name,
    llm: {
      llm_codename: activeLlm.llm_codename,
      has_tools: activeLlm.has_tools,
      sees_images: activeLlm.sees_images,
      sees_videos: activeLlm.sees_videos,
      sees_youtube: activeLlm.sees_youtube,
      supports_structoutput: activeLlm.supports_structoutput,
    },
    diffusion_model_id: persona.config.diffusion_model_id,
    nai_diffusion_model_id: persona.config.nai_diffusion_model_id,
    video_model_id: persona.config.video_model_id,
    config: {
      sticker_usage_enabled: persona.config.sticker_usage_enabled,
      web_search_enabled: persona.config.web_search_enabled,
      self_teaching_enabled: persona.config.self_teaching_enabled,
      manage_message_enabled: persona.config.manage_message_enabled,
      imagegen_enabled: persona.config.imagegen_enabled,
      videogen_enabled: persona.config.videogen_enabled,
      voice_message_enabled: persona.config.voice_message_enabled,
      user_blocking_enabled: persona.config.user_blocking_enabled,
      user_info_updates_enabled: persona.config.user_info_updates_enabled,
      thread_creation_enabled: persona.config.thread_creation_enabled,
    },
  };

  let { builtInTools, mcpFunctionNames } = await getAvailableToolsWithMCP(providerName, toolStateForContext);

  if (toolFilter?.allowedToolNames.length) {
    const allowedSet = new Set(toolFilter.allowedToolNames);
    builtInTools = builtInTools.filter((tool) => allowedSet.has(tool.name));
    mcpFunctionNames = filterDeliberateToolNames(mcpFunctionNames, toolFilter.allowedToolNames);
  }

  const adapter = selectToolAdapter(providerName);
  return adapter.getAllToolsInProviderFormat(builtInTools, persona.server_id, mcpFunctionNames);
}

/**
 * Produces a provider-specific sampling/request-config block matching what each
 * adapter would actually send at runtime. UNFILTERED: does not probe OpenRouter
 * for `supportedParameters`, so params the model may reject are still shown.
 *
 * Provider shapes:
 *   - google           : `{temperature, top_k, top_p, frequency_penalty, presence_penalty, max_output_tokens, stop_sequences, safety_settings, thinking_config?}`
 *   - vertex / vertexexpress: `{temperature, top_k, top_p, max_output_tokens, stop_sequences, safety_settings, thinking_config?}`
 *   - anthropic        : `{temperature?, top_p?, top_k?, max_tokens, stop_sequences}` (Anthropic rejects sending both temp+top_p, uses `selectAnthropicSamplingParams`)
 *   - openai-compat    : `{temperature?, top_p?, top_k?, frequency_penalty?, presence_penalty?, min_p?, max_tokens, stop}`
 *
 * Used in two places:
 *   - Baked into the JSON snapshot file at the top level (alongside `messages`/`contents`)
 *   - Rendered as a second ```json code block in the DM body (shown for BOTH text and JSON formats)
 */
function buildRequestConfig(persona: TomoriState, providerName: string, modelName: string): Record<string, unknown> {
  const activeLlm = persona.persona_llm ?? persona.llm;
  const config = persona.config;
  const disabledParams = config.llm_disabled_params ?? [];
  const providerInfo = getStaticProviderInfo(providerName);
  const providerKey = providerInfo?.name ?? normalizeProviderName(providerName);
  const providerFamily = providerInfo?.apiFamily ?? "openai-compatible";
  const supportsParam = (param: string) =>
    providerInfo?.supportedParams.some((supportedParam) => supportedParam === param) ?? true;

  if (providerFamily === "google-genai") {
    // Google/Vertex family: show raw configured values (unfiltered, mirrors provider config)
    const maxOutputTokens =
      config.llm_max_output_tokens ?? Number.parseInt(process.env.GOOGLE_MAX_OUTPUT_TOKENS || "8192", 10);
    const out: Record<string, unknown> = {
      generation_config: {
        temperature: config.llm_temperature,
        top_k: config.llm_top_k,
        top_p: config.llm_top_p,
        max_output_tokens: maxOutputTokens,
        stop_sequences: [],
      },
      safety_settings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
      ],
    };
    const generationConfig = out.generation_config as Record<string, unknown>;
    if (supportsParam("frequencyPenalty")) generationConfig.frequency_penalty = config.llm_frequency_penalty;
    if (supportsParam("presencePenalty")) generationConfig.presence_penalty = config.llm_presence_penalty;
    const thinkingConfig = serializeGoogleThinkingConfig(buildGoogleThinkingConfig(modelName, config.thinking_level));
    if (thinkingConfig) out.thinking_config = thinkingConfig;
    if (disabledParams.length > 0) out.disabled_params = disabledParams;
    return out;
  }

  if (providerFamily === "anthropic") {
    const selection = selectAnthropicSamplingParams({
      temperature: config.llm_temperature,
      topP: config.llm_top_p,
      disabledParams,
    });
    const maxTokens = Number.parseInt(process.env.ANTHROPIC_MAX_OUTPUT_TOKENS || "8192", 10);
    const stopSequences = buildProviderStopStrings({
      providerName: "anthropic",
      model: modelName,
      personaName: persona.persona_nickname,
    });

    const thinkingRequest = buildAnthropicThinkingRequest(modelName, config.thinking_level);
    const out: Record<string, unknown> = { max_tokens: maxTokens };
    if (!thinkingRequest.omitSampling) {
      if (selection.temperature !== undefined) out.temperature = selection.temperature;
      if (selection.topP !== undefined) out.top_p = selection.topP;
      if (config.llm_top_k > 0 && !disabledParams.includes("topK")) out.top_k = config.llm_top_k;
    }
    if (thinkingRequest.thinking) out.thinking = thinkingRequest.thinking;
    if (thinkingRequest.output_config) out.output_config = thinkingRequest.output_config;
    if (stopSequences) out.stop_sequences = stopSequences;
    if (disabledParams.length > 0) out.disabled_params = disabledParams;
    return out;
  }

  // OpenAI-compatible (openrouter, deepseek, zai, zaicoding, nvidia, custom, novelai):
  //    translate active sampling params to snake_case and include stop + max_tokens.
  const active = buildActiveSamplingParams(config);
  const maxTokensRaw = process.env.OPENROUTER_MAX_OUTPUT_TOKENS || "8192";
  const maxTokens = Number.parseInt(maxTokensRaw, 10);
  const stopStrings = buildProviderStopStrings({
    providerName,
    model: modelName,
    personaName: persona.persona_nickname,
  });

  const out: Record<string, unknown> = { max_tokens: maxTokens };
  if (active.temperature !== undefined) out.temperature = active.temperature;
  if (active.topP !== undefined) out.top_p = active.topP;
  if (active.topK !== undefined) out.top_k = active.topK;
  if (active.frequencyPenalty !== undefined) out.frequency_penalty = active.frequencyPenalty;
  if (active.presencePenalty !== undefined) out.presence_penalty = active.presencePenalty;
  if (active.minP !== undefined) out.min_p = active.minP;
  if (stopStrings) out.stop = stopStrings;
  if (disabledParams.length > 0) out.disabled_params = disabledParams;

  const requestConfigMutators: Record<string, () => void> = {
    openrouter: () => {
      const reasoningRequest = buildOpenRouterReasoningRequest(config.thinking_level);
      if (reasoningRequest.reasoning) out.reasoning = reasoningRequest.reasoning;
    },
    deepseek: () => {
      const thinkingRequest = buildDeepSeekThinkingRequest(modelName, config.thinking_level);
      if (thinkingRequest.thinking) out.thinking = thinkingRequest.thinking;
      if (thinkingRequest.omitSampling) {
        delete out.temperature;
        delete out.top_p;
        delete out.frequency_penalty;
        delete out.presence_penalty;
      }
    },
    zai: () => {
      const thinkingRequest = buildZaiThinkingRequest(config.thinking_level);
      if (thinkingRequest.thinking) out.thinking = thinkingRequest.thinking;
      if (thinkingRequest.omitSampling) {
        delete out.temperature;
        delete out.top_p;
        delete out.frequency_penalty;
        delete out.presence_penalty;
      }
    },
    zaicoding: () => {
      const thinkingRequest = buildZaiThinkingRequest(config.thinking_level);
      if (thinkingRequest.thinking) out.thinking = thinkingRequest.thinking;
      if (thinkingRequest.omitSampling) {
        delete out.temperature;
        delete out.top_p;
        delete out.frequency_penalty;
        delete out.presence_penalty;
      }
    },
    custom: () => {
      const customThinking = buildCustomThinkingRequest(config.custom_endpoint_url, config.thinking_level);
      if (customThinking.reasoning_effort) {
        out.reasoning_effort = customThinking.reasoning_effort;
      }
    },
    novelai: () => {
      out.thinking_directive = getNovelAiThinkingDirective(config.thinking_level);
    },
  };
  requestConfigMutators[providerKey]?.();

  // Acknowledge has_tools flag is mirrored from adapter runtime: informational
  if (!activeLlm.has_tools) out.tools_disabled = true;

  return out;
}
