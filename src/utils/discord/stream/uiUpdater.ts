import type { BaseGuildTextChannel, Message } from "discord.js";
import type { StreamContext } from "@/types/stream/interfaces";
import type { SpriteMessageRecordInfo, StreamState } from "@/types/stream/types";
import { recordPersonaSpriteMessage } from "@/utils/cache/personaSpriteMessageCache";
import { sendStandardEmbed } from "@/utils/discord/embedHelper";
import { getOrCreateWebhook } from "@/utils/discord/webhook/lifecycle";
import { invalidateWebhookCache } from "@/utils/discord/webhook/cache";
import { sendWebhookMessageWithIdentity } from "@/utils/discord/webhook/personaDispatch";
import type { ResolvedWebhookIdentity } from "@/utils/discord/webhook/identity";
import { sendWebhookReplyNotice } from "@/utils/discord/webhookReply";
import { classifySendFailure, clearSendFailure, noteSendFailure } from "@/utils/discord/stream/sendFailureCache";
import {
  recordChannelDeliveredBotMessage,
  recordChannelDeliveredWebhookIdentity,
} from "@/utils/discord/stream/channelDeliveryContinuity";
import { ColorCode, log } from "@/utils/misc/logger";
import { STREAMING_LIMITS } from "@/utils/security/rateLimiter";

export type StreamSendPayload = {
  content?: string;
  files?: import("discord.js").AttachmentBuilder[];
  /** Interactive rows attached to the sent message (e.g. the rendered table's "Show Markdown" button). */
  components?: import("discord.js").ActionRowBuilder<import("discord.js").ButtonBuilder>[];
  identityOverride?: ResolvedWebhookIdentity;
  accumulatedTextPrefix?: string;
  /** Sprite mapping persisted after a successful webhook send (clean-name sprite renders). */
  spriteRecord?: SpriteMessageRecordInfo;
  allowedMentions?: {
    parse?: Array<"users" | "roles" | "everyone">;
    repliedUser?: boolean;
  };
};

type StreamUiUpdaterDependencies = {
  hasStopRequest: (channelId: string) => boolean;
  requestStop: (channelId: string, requesterId?: string) => boolean;
  notifyStreamProgress: (context: StreamContext) => void;
};

function isInvalidWebhookError(error: unknown): boolean {
  const code = (error as { code?: number | string })?.code;
  return code === 10015 || code === "10015" || code === 50027 || code === "50027";
}

/**
 * Detects transient webhook send failures (network aborts/timeouts) where the
 * webhook itself is still valid, so the individual HTTP request just did not land.
 * Unlike {@link isInvalidWebhookError}, these are safe to retry with the same
 * persona identity so the persona avatar/username is preserved on the retry.
 *
 * @returns True when the failure is a transient abort worth a single retry
 */
function isTransientWebhookError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function resolveWebhookTargetChannel(channel: StreamContext["channel"]): BaseGuildTextChannel | null {
  const isThread = "isThread" in channel && typeof channel.isThread === "function" && channel.isThread();
  if (isThread) {
    return channel.parent && "fetchWebhooks" in channel.parent ? (channel.parent as BaseGuildTextChannel) : null;
  }
  return "fetchWebhooks" in channel && "createWebhook" in channel ? (channel as BaseGuildTextChannel) : null;
}

function resolveWebhookThreadId(channel: StreamContext["channel"]): string | undefined {
  return "isThread" in channel && typeof channel.isThread === "function" && channel.isThread() ? channel.id : undefined;
}

export function isUserImpersonationStreamContext(context: StreamContext): boolean {
  return Boolean(context.personaUsername && !context.tomoriState.is_alter);
}

export class StreamUiUpdater {
  public constructor(private readonly deps: StreamUiUpdaterDependencies) {}

  public async sendSinglePayload(
    payload: StreamSendPayload,
    textForState: string,
    context: StreamContext,
    state: StreamState,
  ): Promise<Message | null> {
    if (!payload.content?.trim() && (!payload.files || payload.files.length === 0)) {
      return null;
    }

    const { identityOverride, accumulatedTextPrefix, spriteRecord: _spriteRecord, ...discordPayload } = payload;
    const textForAccumulation = `${accumulatedTextPrefix ?? ""}${textForState}`;
    const strictUserImpersonation = isUserImpersonationStreamContext(context);
    let replyNoticeMessage: Message | null = null;
    const threadId = resolveWebhookThreadId(context.channel);
    const webhookAllowedMentions = payload.allowedMentions ?? {
      parse: ["users", "roles"] as Array<"users" | "roles">,
      repliedUser: false,
    };
    const regularAllowedMentions = payload.allowedMentions ?? {
      repliedUser: false,
    };

    if (this.deps.hasStopRequest(context.channel.id)) {
      log.info("Stream Send: Stop request detected before Discord API call, skipping message send");
      return null;
    }

    const sendMessageLimit = context.tomoriState.config.send_message_limit ?? 0;
    if (sendMessageLimit > 0 && state.messageSentCount >= sendMessageLimit) {
      log.info(
        `Send message limit reached: ${state.messageSentCount} messages sent (server limit: ${sendMessageLimit})`,
      );
      // Deliberate operator config, not a failure, and never reached before the first send
      // (messageSentCount only increments after one lands). User impersonation used to throw
      // here, which surfaced as `status: "error"` and made generationTurn retry across every
      // fallback key and model, each burning tokens on a limit that can never pass.
      this.deps.requestStop(context.channel.id, "send_message_limit");
      return null;
    }

    if (state.messageSentCount >= STREAMING_LIMITS.MAX_FLUSH_COUNT) {
      log.warn(
        `Flush limit exceeded: ${state.messageSentCount} messages sent (limit: ${STREAMING_LIMITS.MAX_FLUSH_COUNT})`,
      );

      // Deterministic like the send limit above, so throwing would only buy pointless retries
      // across every fallback key and model. The warn above is the operator-facing signal.
      // The embed stays off during impersonation for the same reason every other notice in this
      // subsystem does: a bot-authored embed under a user's identity breaks the disguise.
      if (!context.suppressUserErrors && !strictUserImpersonation) {
        await sendStandardEmbed(context.channel, context.locale, {
          titleKey: "genai.stream.flush_limit_title",
          descriptionKey: "genai.stream.flush_limit_description",
          color: ColorCode.WARN,
        }).catch((embedError) => {
          log.warn(
            "Failed to send flush limit warning embed",
            embedError instanceof Error ? embedError : new Error(String(embedError)),
          );
        });
      }

      this.deps.requestStop(context.channel.id, "flush_limit");
      return null;
    }

    try {
      if (strictUserImpersonation && !context.webhook) {
        throw new Error("User impersonation requires a temporary webhook, but none is available.");
      }

      let sentMessage: Message | null = null;
      // Captured so recordSuccessfulSend can remember exactly which identity Discord saw:
      // including the decorated group-break username: for later sends to reuse.
      let deliveredWebhookIdentity: ResolvedWebhookIdentity | undefined;
      const webhookForIdentity = identityOverride
        ? await this.resolveWebhookForIdentityOverride(context)
        : context.webhook;
      const shouldUseWebhook =
        Boolean(identityOverride && webhookForIdentity) || Boolean(context.webhook && context.personaUsername);

      if (shouldUseWebhook && webhookForIdentity) {
        const identity =
          identityOverride ??
          ({
            username: context.personaUsername,
            avatarUrl: context.personaAvatarUrl,
            avatarDataUri: context.personaAvatarUrl?.startsWith("data:image/") ? context.personaAvatarUrl : undefined,
          } satisfies ResolvedWebhookIdentity);
        log.info(
          `Stream Send: Using webhook for persona "${identity.username ?? context.personaUsername ?? "unknown"}"${
            identity.avatarUrl || identity.avatarDataUri ? " with custom avatar" : " (default avatar)"
          }`,
        );

        // Any webhook delivery forfeits Discord's native reply (webhooks cannot reply), so the
        // standalone notice embed is the only reply indicator available: for the main persona
        // rendering a sprite just as much as for an alter. Gating this on `is_alter` hid the
        // notice whenever the main persona switched to a webhook for a sprite, and gating on
        // `!identityOverride` hid it from sprite renders generally, alters included.
        //
        // Sprites are the persona speaking as itself, so a notice is correct; COPIED identities
        // (impersonating a user or another persona) must stay silent, since a notice posted
        // under the disguise would attribute the reply to the wrong speaker. `spriteRecord` is
        // exactly what distinguishes the two.
        const isSpriteIdentity = Boolean(payload.spriteRecord);
        if (
          (!identityOverride || isSpriteIdentity) &&
          !strictUserImpersonation &&
          context.replyToMessage &&
          context.replyNoticeState &&
          !context.replyNoticeState.attempted &&
          state.messageSentCount === 0
        ) {
          context.replyNoticeState.attempted = true;
          try {
            replyNoticeMessage = await sendWebhookReplyNotice(
              webhookForIdentity,
              context.replyToMessage,
              context.locale,
              identity,
              {
                threadId,
                botUserId: context.client.user?.id,
                botName: context.tomoriState.persona_nickname,
              },
            );
            context.replyNoticeState.sent = true;
          } catch (noticeError) {
            log.warn("Stream Send: Failed to send standalone alter reply notice", noticeError as Error);
          }
        }

        sentMessage = await sendWebhookMessageWithIdentity(
          webhookForIdentity,
          {
            ...(discordPayload.content !== undefined ? { content: discordPayload.content } : {}),
            ...(discordPayload.files?.length ? { files: discordPayload.files } : {}),
            ...(discordPayload.components?.length ? { components: discordPayload.components } : {}),
            allowedMentions: webhookAllowedMentions,
            ...(threadId ? { threadId } : {}),
          },
          identity,
        );

        deliveredWebhookIdentity = identity;
        state.hasRepliedToOriginalMessage = true;
      } else if (!state.hasRepliedToOriginalMessage && context.replyToMessage) {
        sentMessage = await context.replyToMessage.reply({
          ...(discordPayload.content !== undefined ? { content: discordPayload.content } : {}),
          ...(discordPayload.files?.length ? { files: discordPayload.files } : {}),
          ...(discordPayload.components?.length ? { components: discordPayload.components } : {}),
          allowedMentions: regularAllowedMentions,
          failIfNotExists: false,
        });
        state.hasRepliedToOriginalMessage = true;
      } else {
        sentMessage = await context.channel.send({
          ...(discordPayload.content !== undefined ? { content: discordPayload.content } : {}),
          ...(discordPayload.files?.length ? { files: discordPayload.files } : {}),
          ...(discordPayload.components?.length ? { components: discordPayload.components } : {}),
          allowedMentions: regularAllowedMentions,
        });
      }

      // Clears any cached refusal so a lifted timeout or a granted permission takes effect at
      // once, rather than after the remainder of the TTL.
      clearSendFailure(context.channel.id);
      this.recordSuccessfulSend(payload, textForAccumulation, context, state, sentMessage, deliveredWebhookIdentity);
      return sentMessage;
    } catch (discordError) {
      const recoveredMessage = await this.tryRecoverWebhookSend(
        discordError,
        payload,
        textForAccumulation,
        context,
        state,
        webhookAllowedMentions,
        identityOverride,
      );
      if (recoveredMessage) {
        return recoveredMessage;
      }

      if (
        !strictUserImpersonation &&
        ((context.webhook && context.personaUsername) || identityOverride) &&
        !state.hasRepliedToOriginalMessage
      ) {
        const fallbackMessage = await this.tryFallbackBotSend(
          discordError,
          replyNoticeMessage,
          threadId,
          payload,
          textForAccumulation,
          context,
          state,
          regularAllowedMentions,
          identityOverride,
        );
        if (fallbackMessage) {
          return fallbackMessage;
        }
      }

      if (strictUserImpersonation) {
        log.warn(
          "Stream Send: User impersonation webhook send failed; not falling back to a regular bot message",
          discordError as Error,
        );
      }

      // A refused send is cached so the admission gate can stop generating for this channel.
      // Only the first refusal of an episode is logged at error level: the rest are the same
      // fact repeated, and at error level they crowd out unrelated signal (one guild's timeout
      // once accounted for 63% of a day's error rows).
      const sendFailureReason = classifySendFailure(discordError);
      const isFirstOfEpisode = sendFailureReason
        ? noteSendFailure(context.channel.id, sendFailureReason).isFirstOfEpisode
        : true;

      const sendErrorMetadata = {
        serverId: context.tomoriState?.server_id,
        errorType: "StreamOrchestrator",
        metadata: {
          channelId: context.channel.id,
          contentLength: textForAccumulation.length,
          contentPreview: textForAccumulation.substring(0, 200),
          usingWebhook: !!context.webhook || !!identityOverride,
          ...(sendFailureReason ? { sendFailureReason } : {}),
        },
      };

      if (isFirstOfEpisode) {
        log.error("Stream Send: Discord API error when sending message", discordError, sendErrorMetadata);
      } else {
        log.warn(
          `Stream Send: suppressed repeat ${sendFailureReason} for channel ${context.channel.id}`,
          discordError as Error,
        );
      }

      throw new Error(
        `Discord send failed: ${discordError instanceof Error ? discordError.message : String(discordError)}`,
      );
    }
  }

  private recordSuccessfulSend(
    payload: StreamSendPayload,
    textForState: string,
    context: StreamContext,
    state: StreamState,
    sentMessage: Message | null,
    deliveredWebhookIdentity?: ResolvedWebhookIdentity,
  ): void {
    if (!state.firstReplyUrl && sentMessage?.url) {
      state.firstReplyUrl = sentMessage.url;
    }

    // Remember what Discord will group against, so post-turn artifacts (stickers, the
    // "Fallback Used" notice) can reuse the same author instead of splitting off under a
    // different name. A bot-message send clears it: reverting to the bot means artifacts must
    // follow, or they would group with nothing.
    if (sentMessage) {
      if (deliveredWebhookIdentity && sentMessage.webhookId) {
        recordChannelDeliveredWebhookIdentity(context.channel.id, deliveredWebhookIdentity, sentMessage.id);
      } else {
        recordChannelDeliveredBotMessage(context.channel.id);
      }
    }
    // Persist the message → sprite mapping fire-and-forget; webhook sends only
    // (bot-fallback messages can't carry persona identity in context anyway).
    // A lost row degrades the future context label to the plain persona name.
    if (payload.spriteRecord && sentMessage?.webhookId) {
      void recordPersonaSpriteMessage({
        messageDiscId: sentMessage.id,
        personaId: payload.spriteRecord.personaId,
        spriteName: payload.spriteRecord.spriteName,
        channelDiscId: sentMessage.channelId,
      }).catch((recordError) => {
        log.warn("Stream Send: Failed to record sprite message mapping", recordError as Error);
      });
      // Track the delivered sprite label so the post-turn stat recorder can count
      // `sprite_shown` / `sprite_emotion` (the stream layer has no internal user id;
      // post-turn does). isIdentity rides along so identity sprites are kept out of
      // the emotion count while still counting toward sprite_shown.
      state.spritesShown.push({
        name: payload.spriteRecord.spriteName,
        isIdentity: payload.spriteRecord.isIdentity,
      });
    }
    state.messageSentCount++;
    if (textForState) {
      state.accumulatedText += textForState;
    }
    // Record the committed message so a later fallback attempt can delete this attempt's partial
    // output if it turns out to be superseded (see runGenerationTurn). The array is a shared
    // reference off StreamingContext, so appends survive an abandoned (timed-out) stream promise.
    if (context.deliveredMessageRefs && sentMessage) {
      context.deliveredMessageRefs.push({
        messageId: sentMessage.id,
        channelId: sentMessage.channelId,
        isWebhook: Boolean(sentMessage.webhookId),
      });
    }
    this.deps.notifyStreamProgress(context);
    const logPreview = textForState
      ? textForState.length > 100
        ? `${textForState.substring(0, 100)}...`
        : textForState
      : `[attachment payload: ${payload.files?.length ?? 0} file(s)]`;
    log.info(`Stream Send: Sent message (${state.messageSentCount}): "${logPreview}"`);
  }

  private async resolveWebhookForIdentityOverride(
    context: StreamContext,
  ): Promise<import("discord.js").Webhook | null> {
    if (context.webhook) {
      return context.webhook;
    }

    const webhookTargetChannel = resolveWebhookTargetChannel(context.channel);
    if (!webhookTargetChannel) {
      return null;
    }

    const webhookResult = await getOrCreateWebhook(webhookTargetChannel);
    if (!webhookResult.webhook) {
      return null;
    }

    context.webhook = webhookResult.webhook;
    return webhookResult.webhook;
  }

  private async tryRecoverWebhookSend(
    discordError: unknown,
    payload: StreamSendPayload,
    textForState: string,
    context: StreamContext,
    state: StreamState,
    webhookAllowedMentions: NonNullable<StreamSendPayload["allowedMentions"]>,
    identityOverride?: ResolvedWebhookIdentity,
  ): Promise<Message | null> {
    // Recover whenever a webhook-backed persona identity was in play: mirror
    //    the send/fallback gate (context.webhook && personaUsername) rather than
    //    limiting to alters, since non-alter sprite personas send via webhook too.
    // Retry on invalid-webhook errors (stale webhook -> recreate) AND transient
    //    aborts (webhook still valid -> recreate + resend preserves persona avatar).
    const shouldRecoverWebhook =
      context.webhook &&
      (context.personaUsername || identityOverride) &&
      (isInvalidWebhookError(discordError) || isTransientWebhookError(discordError));

    if (!shouldRecoverWebhook) {
      return null;
    }

    const webhookTargetChannel = resolveWebhookTargetChannel(context.channel);
    if (!webhookTargetChannel) {
      return null;
    }

    try {
      invalidateWebhookCache(webhookTargetChannel.id);
      const recreatedWebhookResult = await getOrCreateWebhook(webhookTargetChannel);
      const recreatedWebhook = recreatedWebhookResult.webhook;
      if (!recreatedWebhook) {
        return null;
      }

      const recoveredThreadId = resolveWebhookThreadId(context.channel);
      const recoveredIdentity =
        identityOverride ??
        ({
          username: context.personaUsername,
          avatarUrl: context.personaAvatarUrl,
          avatarDataUri: context.personaAvatarUrl?.startsWith("data:image/") ? context.personaAvatarUrl : undefined,
        } satisfies ResolvedWebhookIdentity);

      const recoveredReplyMessage = await sendWebhookMessageWithIdentity(
        recreatedWebhook,
        {
          ...(payload.content !== undefined ? { content: payload.content } : {}),
          ...(payload.files?.length ? { files: payload.files } : {}),
          ...(payload.components?.length ? { components: payload.components } : {}),
          allowedMentions: webhookAllowedMentions,
          ...(recoveredThreadId ? { threadId: recoveredThreadId } : {}),
        },
        recoveredIdentity,
      );

      context.webhook = recreatedWebhook;
      state.hasRepliedToOriginalMessage = true;
      this.recordSuccessfulSend(payload, textForState, context, state, recoveredReplyMessage);
      log.info("Stream Send: Recreated webhook after invalid webhook error and resumed persona sending");
      return recoveredReplyMessage;
    } catch (recoveryError) {
      log.warn(
        "Stream Send: Webhook recovery attempt failed, falling back to regular bot message",
        recoveryError as Error,
      );
      return null;
    }
  }

  private async tryFallbackBotSend(
    discordError: unknown,
    replyNoticeMessage: Message | null,
    threadId: string | undefined,
    payload: StreamSendPayload,
    textForState: string,
    context: StreamContext,
    state: StreamState,
    regularAllowedMentions: NonNullable<StreamSendPayload["allowedMentions"]>,
    identityOverride?: ResolvedWebhookIdentity,
  ): Promise<Message | null> {
    log.warn("Stream Send: Webhook send failed, falling back to regular bot message", discordError);

    try {
      if (!identityOverride && replyNoticeMessage && context.webhook) {
        await context.webhook.deleteMessage(replyNoticeMessage.id, threadId).catch((deleteError) => {
          log.warn("Stream Send: Failed to delete standalone alter reply notice after webhook fallback", deleteError);
        });
      }

      const fallbackMessage = context.replyToMessage
        ? await context.replyToMessage.reply({
            ...(payload.content !== undefined ? { content: payload.content } : {}),
            ...(payload.files?.length ? { files: payload.files } : {}),
            ...(payload.components?.length ? { components: payload.components } : {}),
            allowedMentions: regularAllowedMentions,
            failIfNotExists: false,
          })
        : await context.channel.send({
            ...(payload.content !== undefined ? { content: payload.content } : {}),
            ...(payload.files?.length ? { files: payload.files } : {}),
            ...(payload.components?.length ? { components: payload.components } : {}),
            allowedMentions: regularAllowedMentions,
          });

      state.hasRepliedToOriginalMessage = true;
      this.recordSuccessfulSend(payload, textForState, context, state, fallbackMessage);
      log.info("Stream Send: Successfully sent message via fallback after webhook failure");
      return fallbackMessage;
    } catch (fallbackError) {
      log.error("Stream Send: Both webhook and fallback failed", fallbackError, {
        serverId: context.tomoriState?.server_id,
        errorType: "StreamOrchestrator",
        metadata: {
          channelId: context.channel.id,
          webhookError: String(discordError),
          fallbackError: String(fallbackError),
        },
      });
      return null;
    }
  }
}
