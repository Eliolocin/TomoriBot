/**
 * Shared delivery path for native Discord voice messages.
 *
 * Extracted from `GenerateVoiceMessageTool` so the tool and `/generate voice-message`
 * converge on one sender. Everything below is a Discord-quirk surface, not a
 * generic "send a file" helper: the raw multipart bodies, `passThroughBody`, and
 * `wait=true` each work around a failure mode that degrades silently instead of
 * erroring, so none of it may be simplified away.
 */

import { AttachmentBuilder, Routes, type TextChannel, type BaseGuildTextChannel, type Webhook } from "discord.js";
import type { VoiceMessageMetadata } from "@/utils/audio/voiceMessageMetadata";
import { log } from "@/utils/misc/logger";
import { runWithWebhookIdentity, sendWebhookMessageWithIdentity } from "@/utils/discord/webhook/personaDispatch";

/** Discord IS_VOICE_MESSAGE flag value (1 << 13). */
const IS_VOICE_MESSAGE_FLAG = 8192;

/** Discord REST API base URL. */
const DISCORD_API_BASE = "https://discord.com/api/v10";

/**
 * Where a voice message should be delivered.
 *
 * `webhook` is optional so bot-identity callers (main persona in a normal chat
 * turn) can omit it, but persona-identity callers should resolve one first: the
 * internal fallback only covers the webhook-token-null case, it does not paper
 * over a webhook that was never resolved.
 */
export interface VoiceDeliveryTarget {
  /**
   * Any channel the delivery paths can send to. Kept broad because the tool's own context types
   * its channel more loosely than Discord's guild-text-channel union.
   */
  channel: TextChannel | BaseGuildTextChannel;
  webhook?: Webhook | null;
  threadId?: string;
  personaUsername?: string;
  personaAvatarUrl?: string | null;
}

interface NativeVoiceSendOptions {
  audioBuffer: Buffer;
  mimeType: string;
  filename: string;
  voiceMeta: VoiceMessageMetadata;
}

/**
 * Sends a native Discord voice message via raw REST, bypassing discord.js's
 * MessagePayload serialization which drops unknown attachment fields like
 * `waveform` and `duration_secs`.
 *
 * @returns The sent message ID, or undefined if the request failed
 */
async function sendNativeVoiceMessageViaRest(
  target: VoiceDeliveryTarget,
  options: NativeVoiceSendOptions,
): Promise<string | undefined> {
  try {
    const { webhook } = target;
    const { audioBuffer, mimeType, filename, voiceMeta } = options;
    const username = target.personaUsername;
    const avatarUrl = target.personaAvatarUrl;

    if (!webhook?.token) return undefined;

    const isLocalAvatar = avatarUrl?.startsWith("data:image/") === true;
    return await runWithWebhookIdentity(
      webhook,
      {
        username,
        avatarUrl: isLocalAvatar ? undefined : (avatarUrl ?? undefined),
        avatarDataUri: isLocalAvatar ? (avatarUrl ?? undefined) : undefined,
      },
      async () => {
        const form = new FormData();
        const payloadJson: Record<string, unknown> = {
          flags: IS_VOICE_MESSAGE_FLAG,
          attachments: [
            {
              id: 0,
              filename,
              waveform: voiceMeta.waveform,
              duration_secs: voiceMeta.durationSecs,
            },
          ],
          allowed_mentions: { parse: [] },
        };

        if (username) payloadJson.username = username;
        if (!isLocalAvatar && avatarUrl) payloadJson.avatar_url = avatarUrl;

        form.append("payload_json", JSON.stringify(payloadJson));
        form.append("files[0]", new Blob([new Uint8Array(audioBuffer)], { type: mimeType }), filename);

        // `wait=true` is required to receive the delivered message ID instead of a 204.
        const threadParam = target.threadId ? `&thread_id=${encodeURIComponent(target.threadId)}` : "";
        const url = `${DISCORD_API_BASE}/webhooks/${webhook.id}/${webhook.token}?wait=true${threadParam}`;
        const response = await fetch(url, { method: "POST", body: form });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "unknown");
          log.warn(`[VoiceWaveform] Discord API rejected native voice message: HTTP ${response.status} — ${errorText}`);
          return undefined;
        }

        const data = (await response.json()) as { id?: string };
        return data.id;
      },
    );
  } catch (error) {
    log.warn("[VoiceWaveform] Exception during native voice message send", error);
    return undefined;
  }
}

/**
 * Sends a native Discord voice message via the bot's REST client, bypassing
 * webhook delivery. Used when no persona webhook is in scope (e.g. main
 * persona or non-alter context). Does not support username/avatar overrides.
 *
 * @returns The sent message ID, or undefined if the request failed
 */
async function sendNativeVoiceMessageViaBotRest(
  target: VoiceDeliveryTarget,
  options: NativeVoiceSendOptions,
): Promise<string | undefined> {
  try {
    const { audioBuffer, mimeType, filename, voiceMeta } = options;
    const channel = target.channel;

    // Build multipart form: same payload_json structure as the webhook path
    const form = new FormData();

    const payloadJson: Record<string, unknown> = {
      flags: IS_VOICE_MESSAGE_FLAG,
      attachments: [
        {
          id: 0,
          filename,
          waveform: voiceMeta.waveform,
          duration_secs: voiceMeta.durationSecs,
        },
      ],
      allowed_mentions: { parse: [] },
    };

    form.append("payload_json", JSON.stringify(payloadJson));
    form.append("files[0]", new Blob([new Uint8Array(audioBuffer)], { type: mimeType }), filename);

    // Post directly to the channel via bot identity.
    // passThroughBody: true prevents the REST manager from JSON-serializing
    // the FormData body, which would corrupt the multipart boundary.
    // channel.id is correct for both regular channels and threads.
    const data = (await channel.client.rest.post(Routes.channelMessages(channel.id), {
      body: form,
      passThroughBody: true,
    })) as { id?: string };

    return data.id;
  } catch (error) {
    log.warn("[VoiceWaveform] Exception during bot REST voice message send", error);
    return undefined;
  }
}

/**
 * Delivers a synthesized voice message through the best available path:
 * 1. Native REST with waveform metadata (webhook identity)
 * 2. Native REST with waveform metadata (bot identity)
 * 3. Plain attachment fallback (discord.js)
 *
 * @returns The delivered message ID, or undefined when every path failed
 */
export async function deliverVoiceMessage(input: {
  target: VoiceDeliveryTarget;
  audioBuffer: Buffer;
  mimeType: string;
  filename: string;
  voiceMeta: VoiceMessageMetadata | null;
}): Promise<string | undefined> {
  const { target, audioBuffer, mimeType, filename, voiceMeta } = input;
  const { webhook, threadId } = target;
  let sentMessageId: string | undefined;

  if (voiceMeta) {
    if (webhook?.token) {
      sentMessageId = await sendNativeVoiceMessageViaRest(target, { audioBuffer, mimeType, filename, voiceMeta });
      if (!sentMessageId) {
        log.warn("[VoiceWaveform] Webhook REST send failed — trying bot REST path");
      }
    } else if (webhook && !webhook.token) {
      log.warn(`[VoiceWaveform] Webhook token is null (id=${webhook.id}) — trying bot REST path`);
    }

    if (!sentMessageId) {
      sentMessageId = await sendNativeVoiceMessageViaBotRest(target, { audioBuffer, mimeType, filename, voiceMeta });
      if (!sentMessageId) {
        log.warn("[VoiceWaveform] Bot REST send failed — falling back to plain attachment");
      }
    }
  }

  if (!sentMessageId) {
    const attachment = new AttachmentBuilder(audioBuffer, { name: filename });
    if (webhook && target.personaUsername) {
      const sent = await sendWebhookMessageWithIdentity(
        webhook,
        {
          files: [attachment],
          allowedMentions: { parse: [], repliedUser: false },
          ...(threadId ? { threadId } : {}),
        },
        {
          username: target.personaUsername,
          avatarUrl: target.personaAvatarUrl ?? undefined,
          avatarDataUri: target.personaAvatarUrl?.startsWith("data:image/") ? target.personaAvatarUrl : undefined,
        },
      );
      sentMessageId = sent.id;
    } else {
      const sent = await target.channel.send({ files: [attachment] });
      sentMessageId = sent.id;
    }
  }

  return sentMessageId;
}

/**
 * Posts the TTS caption text as a visible blockquote in the channel.
 * Respects webhook persona identity when available.
 */
export async function postVoiceTranscriptCaption(target: VoiceDeliveryTarget, captionText: string): Promise<void> {
  const { webhook, threadId } = target;
  const quotedCaption = `> ${captionText.replace(/\n/g, "\n> ")}`;
  try {
    if (webhook && target.personaUsername) {
      await sendWebhookMessageWithIdentity(
        webhook,
        {
          content: quotedCaption,
          allowedMentions: { parse: [] },
          ...(threadId ? { threadId } : {}),
        },
        {
          username: target.personaUsername,
          avatarUrl: target.personaAvatarUrl ?? undefined,
          avatarDataUri: target.personaAvatarUrl?.startsWith("data:image/") ? target.personaAvatarUrl : undefined,
        },
      );
    } else {
      await target.channel.send({ content: quotedCaption, allowedMentions: { parse: [] } });
    }
    log.info(`[VoiceChat] Posted TTS transcript | persona="${target.personaUsername ?? "bot"}"`);
  } catch (error) {
    log.warn("[VoiceChat] Failed to post TTS transcript", error);
  }
}
