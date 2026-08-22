/**
 * Hidden Image Agent Turn
 *
 * Runs a "hidden" LLM streaming turn that uses the full bot context pipeline
 * (persona prompt, users-in-conversation, short-term memory, RAG docs, etc.) to
 * generate an image of the current channel scene.
 *
 * Key properties vs. a normal bot turn:
 * - Text output is suppressed  (`suppressTextOutput: true`), so only the image appears.
 * - The target image tool (generate_image or generate_image_nai) signals `endTurn: true`
 *   on success via the `endTurnAfterTools` mechanism, stopping the loop immediately.
 * - STM writes are disabled (`disableShortTermMemoryUpdate: true`), because a hidden turn
 *   should not pollute the short-term memory log.
 * - No webhook / persona avatar: the image is posted directly by the tool.
 */

import type { Client, Guild, Webhook } from "discord.js";
import { log } from "@/utils/misc/logger";
import { buildContext } from "@/utils/text/contextBuilder";
import type { SimplifiedMessageForContext } from "@/utils/text/contextBuilder";
import { getCachedChannelPrompt } from "@/utils/cache/channelPromptCache";
import { getProviderForTomori } from "@/utils/provider/providerFactory";
import { ToolRegistry } from "@/tools/toolRegistry";
import { ContextItemTag, type StructuredContextItem } from "@/types/misc/context";
import type { TomoriState } from "@/types/db/schema";
import type { ToolContext } from "@/types/tool/interfaces";
import type { StreamingContext } from "@/types/tool/interfaces";
import type { FunctionCall } from "@/types/provider/interfaces";
import { decryptApiKey } from "@/utils/security/crypto";
import { stripBridgePrefix } from "@/utils/bridges";
import { resolveMediaForModel } from "@/utils/text/context/mediaResolver";
import { getCachedAllPersonas } from "@/utils/cache/tomoriStateCache";
import { prepareParticipantContext } from "@/utils/text/participants/preparation";

/** Number of recent messages to fetch from the channel for context. */
const BOT_GENERATE_IMAGE_HISTORY_LIMIT = parseEnvInt("BOT_GENERATE_IMAGE_HISTORY_LIMIT", 24, 5, 100);

/** Maximum streaming iterations in the hidden agent tool loop. */
const BOT_GENERATE_IMAGE_AGENT_MAX_ITERATIONS = parseEnvInt("BOT_GENERATE_IMAGE_AGENT_MAX_ITERATIONS", 5, 1, 10);

/** Discord message types that carry no conversational content and should be skipped. */
const SKIPPED_MESSAGE_TYPES = new Set<number>([
  1, // RecipientAdd
  2, // RecipientRemove
  3, // Call
  4, // ChannelNameChange
  5, // ChannelIconChange
  6, // ChannelPinnedMessage
  7, // UserJoin / GuildMemberJoin
  8, // GuildBoost
  9, // GuildBoostTier1
  10, // GuildBoostTier2
  11, // GuildBoostTier3
  14, // ThreadCreated
  19, // ThreadStarterMessage
  22, // GuildInviteReminder
  24, // AutoModerationAction
]);

function parseEnvInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/** Configuration for the hidden image agent. Caller (image.ts) owns preset/backend logic. */
export interface HiddenImageTurnParams {
  /** Discord text channel to read history from and post the image to. */
  channel: ToolContext["channel"];
  client: Client;
  guild: Guild | null;
  tomoriState: TomoriState;
  locale: string;
  /** Discord ID of the user who invoked the /tool visualize command. */
  interactingUserId: string;
  /** Internal database user ID of the invoking user, if known. */
  internalUserId?: number | null;
  /** "current_provider" → generate_image, "novelai" → generate_image_nai */
  backend: "current_provider" | "novelai";
  /** Human-readable label for the framing preset (e.g. "Character Focus"). */
  presetLabel: string;
  /** Instruction for the model describing how to frame the image. */
  presetInstruction: string;
  /** Aspect ratio string for current_provider backend (e.g. "3:4"). */
  aspectRatio: string;
  /** Orientation for NovelAI backend. */
  naiOrientation: "portrait" | "landscape" | "square";
  /** Optional extra direction from the user (free text from the modal). */
  extraDirection?: string;
  /** Webhook to use for posting the generated image (persona identity). */
  webhook?: Webhook;
  /** Display name for the persona posting the image. */
  personaUsername?: string;
  /** Avatar URL or data URI for the persona posting the image. */
  personaAvatarUrl?: string;
  /**
   * When the user picks a sender persona that differs from the active persona,
   * these fields override the buildContext() persona identity so the model is
   * prompted as that persona rather than the active one.
   */
  contextPersonaOverride?: {
    tomoriNickname: string;
    personaPrompt: string | null;
    tomoriAttributes: string[];
    personaLineageId: number | null;
  };
}

/**
 * Runs a hidden bot turn that generates an image of the current channel scene.
 *
 * The turn uses the full `buildContext()` pipeline so the model sees the same
 * persona prompt, users-in-conversation block, short-term memory, and RAG
 * documents a normal bot turn would see.  Text output is suppressed and the turn
 * exits immediately after the target image tool returns successfully.
 *
 * @returns `{ success: true }` if an image was generated, or
 *          `{ success: false, error: "…" }` with a human-readable reason.
 */
export async function runHiddenImageTurn(params: HiddenImageTurnParams): Promise<{ success: boolean; error?: string }> {
  const serverDiscId = params.guild?.id ?? params.interactingUserId;
  const {
    channel,
    client,
    guild,
    tomoriState,
    locale,
    interactingUserId,
    backend,
    presetLabel,
    presetInstruction,
    aspectRatio,
    naiOrientation,
    extraDirection,
    webhook,
    personaUsername,
    personaAvatarUrl,
    contextPersonaOverride,
    internalUserId,
  } = params;

  // Verify the active model supports function calling: required for tool-based generation.
  if (!tomoriState.llm.has_tools) {
    return {
      success: false,
      error:
        "The active model does not support function calling (has_tools=false). A tool-capable model is required for the hidden image agent.",
    };
  }

  // Decrypt the API key.
  const decryptedApiKey = await decryptApiKey(
    // biome-ignore lint/style/noNonNullAssertion: api_key presence was validated by the command before invoking this helper
    tomoriState.config.api_key!,
    tomoriState.config.key_version || 1,
  );
  if (!decryptedApiKey) {
    return { success: false, error: "Failed to decrypt API key." };
  }

  const rawMessages = await channel.messages.fetch({
    limit: BOT_GENERATE_IMAGE_HISTORY_LIMIT,
  });
  const messagesChron = [...rawMessages.values()].reverse();

  const botDiscordId = client.user?.id;
  const simplifiedMessages: SimplifiedMessageForContext[] = [];
  const userListSet = new Set<string>();

  for (const msg of messagesChron) {
    if (SKIPPED_MESSAGE_TYPES.has(msg.type as number)) continue;

    // Determine whether this message is from the bot/persona or a human user.
    // Webhook messages from the bot account (alter personas) share the bot's author ID.
    const isBotMessage = msg.author.bot && msg.author.id === botDiscordId;

    const authorId = msg.author.id;
    const authorName = stripBridgePrefix(msg.member?.displayName ?? msg.author.id);

    // Skip image attachments because the hidden agent only needs text context to plan the
    // image prompt. Including images would cause the provider to base64-encode and
    // upload them all inline, producing a multi-MB payload that overwhelms the model.

    simplifiedMessages.push({
      id: msg.id,
      authorId,
      authorName,
      authorType: isBotMessage ? "persona" : "user",
      personaName: isBotMessage ? tomoriState.persona_nickname : null,
      content: msg.cleanContent || msg.content || null,
      createdAt: msg.createdTimestamp,
      imageAttachments: [], // Skip (see comment above)
      videoAttachments: [], // Skip video processing for the hidden agent
    });

    if (!msg.author.bot && !msg.webhookId) {
      userListSet.add(authorId);
    }
  }

  // Always include the bot's own Discord ID in the user list.
  if (botDiscordId) {
    userListSet.add(botDiscordId);
  }

  const userList = Array.from(userListSet);

  const channelName = "name" in channel ? channel.name : "Unknown Channel";
  const channelDesc = "topic" in channel ? (channel as unknown as { topic: string | null }).topic : null;

  const interactingMember = guild?.members.cache.get(interactingUserId);
  const triggererName = stripBridgePrefix(interactingMember?.displayName ?? interactingUserId);

  let contextItems: StructuredContextItem[];
  let messageIdMap: ToolContext["messageIdMap"];
  try {
    const persona = contextPersonaOverride ?? {
      tomoriNickname: tomoriState.persona_nickname,
      personaPrompt: tomoriState.persona_prompt ?? null,
      tomoriAttributes: tomoriState.attribute_list,
      personaLineageId: tomoriState.persona_lineage_id,
    };

    const channelPromptOverride = tomoriState.server_id
      ? await getCachedChannelPrompt(tomoriState.server_id, channel.id)
      : null;
    const personas = await getCachedAllPersonas(serverDiscId).catch(() => [tomoriState]);
    const preparedParticipantContext = await prepareParticipantContext({
      client,
      guildId: serverDiscId,
      simplifiedMessageHistory: simplifiedMessages,
      personas,
      activePersona: tomoriState,
      visibleUserIds: userList,
      syntheticUsers: new Map(),
      matrixUsers: new Map(),
    });

    const contextBuild = await buildContext({
      guildId: serverDiscId,
      serverName: guild?.name ?? "Direct Message",
      serverDescription: guild?.description ?? null,
      simplifiedMessageHistory: simplifiedMessages,
      preparedParticipantContext,
      channelDesc,
      channelName,
      channelId: channel.id,
      client,
      triggererName,
      triggererFormattedName: triggererName,
      triggererAddressTerm: "",
      tomoriNickname: persona.tomoriNickname,
      tomoriAttributes: persona.tomoriAttributes,
      tomoriConfig: tomoriState.config,
      channelPromptOverride,
      personaPrompt: persona.personaPrompt,
      personaLineageId: persona.personaLineageId ?? undefined,
      isDMChannel: false,
      triggererUserId: internalUserId ?? undefined,
    });
    contextItems = contextBuild.contextItems;
    messageIdMap = contextBuild.messageIdMap;
  } catch (error) {
    log.error("Hidden image agent: buildContext failed", error as Error, {
      errorType: "HiddenImageAgentContextError",
      metadata: { guildId: serverDiscId, channelId: channel.id },
    });
    return {
      success: false,
      error: "Failed to build conversation context for image generation.",
    };
  }

  const toolInstruction =
    backend === "current_provider"
      ? `You MUST call the generate_image tool immediately. Use the conversation context above, including any Physical Appearance lines for users/personas, to construct a detailed prompt describing the scene.`
      : `You MUST call the generate_image_nai tool immediately. Use the conversation context above, including any Physical Appearance lines for users/personas, to construct danbooru-style tags describing the scene.`;

  const dirLines: string[] = [
    toolInstruction,
    `Framing: ${presetLabel} — ${presetInstruction}`,
    backend === "current_provider" ? `Aspect ratio: ${aspectRatio}` : `Orientation: ${naiOrientation}`,
  ];
  if (extraDirection?.trim()) {
    dirLines.push(`Extra direction from user: ${extraDirection.trim()}`);
  }
  dirLines.push(
    "IMPORTANT: You MUST call the image tool (generate_image or generate_image_nai) immediately. Do not ask for clarification or ask if the user wants you to proceed. Just call the tool now with the scene information from above.",
  );

  const agentDirective: StructuredContextItem = {
    role: "user",
    parts: [{ type: "text", text: `[System: ${dirLines.join(" ")}]` }],
    metadataTag: ContextItemTag.DIALOGUE_HISTORY,
  };
  contextItems = [...contextItems, agentDirective];
  // This internal planner is intentionally allowed to inspect image context even when the text model's
  // public OpenRouter capability metadata would normally say otherwise.
  const mediaResolutionLlm = {
    ...tomoriState.llm,
    sees_images: true,
    ...(tomoriState.llm.llm_provider === "openrouter" ? { llm_codename: "other-model" } : {}),
  };
  contextItems = await resolveMediaForModel(contextItems, {
    ...tomoriState,
    llm: mediaResolutionLlm,
  });

  const targetToolName = backend === "current_provider" ? "generate_image" : "generate_image_nai";

  const streamingContext: StreamingContext = {
    disableYouTubeProcessing: true,
    disableProfilePictureProcessing: true,
    disableGifProcessing: true,
    disableShortTermMemoryUpdate: true, // Do not pollute STM from a hidden agent turn
    suppressTextOutput: true, // No visible text: only the image
    isManuallyTriggered: true,
    // End the turn as soon as either image tool succeeds, so both are listed so the
    // loop terminates cleanly even if the model calls the non-preferred backend.
    endTurnAfterTools: ["generate_image", "generate_image_nai"],
    messageIdMap,
  };

  let provider: Awaited<ReturnType<typeof getProviderForTomori>>;
  try {
    provider = await getProviderForTomori(tomoriState);
  } catch (error) {
    log.error("Hidden image agent: failed to get provider", error as Error, {
      errorType: "HiddenImageAgentProviderError",
      metadata: { provider: tomoriState.llm.llm_provider },
    });
    return {
      success: false,
      error: `Failed to initialize provider "${tomoriState.llm.llm_provider}".`,
    };
  }

  let providerConfig: Awaited<ReturnType<typeof provider.createConfig>>;
  try {
    providerConfig = await provider.createConfig(tomoriState, decryptedApiKey);
  } catch (error) {
    log.error("Hidden image agent: failed to create provider config", error as Error, {
      errorType: "HiddenImageAgentConfigError",
    });
    return {
      success: false,
      error: "Failed to create provider configuration.",
    };
  }

  // Run the simplified tool loop.
  //    We mimic the structure of tomoriChat's streaming loop but stripped down to
  //    only what a hidden image agent needs: stream → execute tool → check endTurn.
  const functionInteractionHistory: Array<{
    functionCall: FunctionCall;
    functionResponse: Record<string, unknown>;
    preToolCallTextParts?: Array<Record<string, unknown>>;
  }> = [];

  const toolContext: ToolContext = {
    channel,
    client,
    userId: interactingUserId,
    internalUserId: internalUserId ?? undefined,
    guildId: serverDiscId,
    tomoriState,
    locale,
    provider: provider.getInfo().name,
    streamContext: streamingContext,
    suppressProgressNotices: true, // Keep the hidden turn quiet
    // Persona identity for webhook-based image posting (set by /tool visualize).
    // When absent, the image tool falls back to a direct bot message.
    webhook,
    personaUsername,
    personaAvatarUrl,
    contextItems,
    messageIdMap,
  };

  log.info(
    `[Hidden Image Agent] Starting hidden turn for channel ${channel.id} — backend=${backend}, tool=${targetToolName}, maxIterations=${BOT_GENERATE_IMAGE_AGENT_MAX_ITERATIONS}`,
  );

  for (let i = 0; i < BOT_GENERATE_IMAGE_AGENT_MAX_ITERATIONS; i++) {
    log.info(`[Hidden Image Agent] Iteration ${i + 1}/${BOT_GENERATE_IMAGE_AGENT_MAX_ITERATIONS}`);

    // Stream one LLM turn.
    // No per-stream timeout because normal chat (tomoriChat.ts) also has none.
    // Protection against infinite loops comes from BOT_GENERATE_IMAGE_AGENT_MAX_ITERATIONS.
    let streamResult: Awaited<ReturnType<typeof provider.streamToDiscord>>;
    try {
      streamResult = await provider.streamToDiscord(
        channel,
        client,
        tomoriState,
        providerConfig,
        contextItems,
        [], // currentTurnModelParts: empty for first iteration, accumulate on retries
        undefined, // emojiStrings
        functionInteractionHistory.length > 0 ? functionInteractionHistory : undefined,
        undefined, // initialInteraction
        undefined, // replyToMessage
        streamingContext,
        locale,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`[Hidden Image Agent] Stream error on iteration ${i + 1}: ${msg}`, error as Error, {
        errorType: "HiddenImageAgentStreamError",
        metadata: { channelId: channel.id, iteration: i + 1 },
      });
      return { success: false, error: `Streaming error: ${msg}` };
    }

    if (streamResult.status === "function_call") {
      if (!streamResult.data) {
        log.error("[Hidden Image Agent] function_call status received without data.");
        return { success: false, error: "Malformed function call from model." };
      }

      const funcCall = streamResult.data as FunctionCall;
      const funcName = funcCall.name?.trim() ?? "";
      log.info(`[Hidden Image Agent] Model called tool: ${funcName}`);

      const toolResult = await ToolRegistry.executeTool(funcName, funcCall.args || {}, toolContext);
      log.info(
        `[Hidden Image Agent] Tool "${funcName}" ${toolResult.success ? "succeeded" : "failed"}: ${toolResult.message ?? toolResult.error ?? ""}`,
      );

      const functionExecutionResult: Record<string, unknown> = toolResult.success
        ? ((toolResult.data as Record<string, unknown>) ?? {
            status: "completed",
          })
        : {
            status: "tool_execution_failed",
            reason: toolResult.message || toolResult.error || "Tool execution failed",
            tool_name: funcName,
          };

      const preToolCallText = (streamResult.accumulatedText ?? "").trim();
      functionInteractionHistory.push({
        functionCall: funcCall,
        functionResponse: {
          functionResponse: {
            name: funcName,
            response: { result: functionExecutionResult },
          },
        },
        preToolCallTextParts: preToolCallText ? [{ type: "text", text: preToolCallText }] : undefined,
      });

      if (toolResult.endTurn) {
        if (toolResult.success) {
          log.info(`[Hidden Image Agent] Image tool "${funcName}" completed successfully — ending hidden turn.`);
          return { success: true };
        }
        log.warn(`[Hidden Image Agent] Image tool "${funcName}" requested endTurn but reported failure.`);
        return {
          success: false,
          error: toolResult.error ?? "Image generation tool failed.",
        };
      }

      continue;
    }

    if (streamResult.status === "error") {
      const errData = streamResult.data;
      const errMsg =
        errData instanceof Error
          ? errData.message
          : typeof errData === "object" && errData !== null && "message" in errData
            ? String((errData as { message: unknown }).message)
            : "Unknown streaming error";
      log.error(`[Hidden Image Agent] Stream returned error status: ${errMsg}`);
      return { success: false, error: errMsg };
    }

    log.warn(`[Hidden Image Agent] Stream completed without calling ${targetToolName} on iteration ${i + 1}.`);
    break;
  }

  return {
    success: false,
    error: `The model did not call ${targetToolName} within ${BOT_GENERATE_IMAGE_AGENT_MAX_ITERATIONS} iteration(s).`,
  };
}
