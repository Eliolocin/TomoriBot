import { AttachmentBuilder, Routes } from "discord.js";
import type { Webhook } from "discord.js";
import {
  BaseTool,
  type Tool,
  type ToolAssemblyContext,
  type ToolContext,
  type ToolParameterSchema,
  type ToolResult,
} from "@/types/tool/interfaces";
import { createToolVariant } from "@/tools/assembly";
import { synthesizeSpeechViaElevenLabsAdapter } from "@/providers/custom/styles/elevenLabsAdapter";
import { synthesizeSpeechViaTtsClone } from "@/providers/custom/styles/ttsCloningAdapter";
import {
  isVoiceDesignEndpoint,
  shouldUseVoiceDesignForPersona,
  synthesizeSpeechViaTtsVoiceDesign,
} from "@/providers/custom/styles/ttsVoiceDesignAdapter";
import { ELEVENLABS_SERVICE_NAME } from "@/utils/audio/elevenLabsAccount";
import { setCachedVoiceTranscript } from "@/utils/audio/voiceTranscriptCache";
import { generateVoiceMessageMetadata } from "@/utils/audio/voiceMessageMetadata";
import type { VoiceMessageMetadata } from "@/utils/audio/voiceMessageMetadata";
import { getOptApiKey } from "@/utils/security/crypto";
import { runWithWebhookIdentity, sendWebhookMessageWithIdentity } from "@/utils/discord/webhook/personaDispatch";
import { resolveActiveSpeechEndpoint } from "@/utils/provider/speechEndpointResolver";
import { statRepository } from "@/utils/db/repositories";
import { log } from "@/utils/misc/logger";

/** Discord IS_VOICE_MESSAGE flag value (1 << 13). */
const IS_VOICE_MESSAGE_FLAG = 8192;

/** Discord REST API base URL. */
const DISCORD_API_BASE = "https://discord.com/api/v10";

/**
 * Per-endpoint description variants for the voice message tool.
 * The registry proxies the tool with the matching variant based on the server's active
 * speech endpoint's script_markup setting. Defaults to bracket-tags (ElevenLabs / no endpoint).
 */
export const VOICE_TOOL_VARIANTS = {
  "bracket-tags": {
    toolDescription:
      "Generate a spoken Discord audio message using the active persona's configured voice. " +
      "Use this only when voice delivery materially improves the reply. " +
      "You may include bracketed expression tags anywhere in the script to shape delivery " +
      "(e.g. [happy], [sad], [whispers], [laughs]). " +
      "The tool sends the audio directly to the channel with no text caption.",
    scriptDescription:
      "The exact spoken script for the voice message. Keep it concise and natural for speech. " +
      "Bracketed expression tags (emotional states like [happy], [sad], [tired] or actions like " +
      "[whispers], [laughs]) can be placed inline to shape delivery.",
  },
  plain: {
    toolDescription:
      "Generate a spoken Discord audio message using the active persona's configured voice. " +
      "Use this only when voice delivery materially improves the reply. " +
      "Write the script as natural plain speech text only; do not include any bracketed tags or special markup. " +
      "The tool sends the audio directly to the channel with no text caption.",
    scriptDescription:
      "The exact spoken script for the voice message. Keep it concise and natural for speech. " +
      "Plain text only: do not write bracketed tags or any special markup.",
  },
  emoji: {
    toolDescription:
      "Generate a spoken Discord audio message using the active persona's configured voice. " +
      "Use this only when voice delivery materially improves the reply. " +
      "You may embed emoji characters inline in the script to convey emotion " +
      "(e.g. 😊 for happy, 😢 for sad, 😮 for surprised). Do not use bracketed tags. " +
      "The tool sends the audio directly to the channel with no text caption.",
    scriptDescription:
      "The exact spoken script for the voice message. Keep it concise and natural for speech. " +
      "Embed emoji characters inline to convey emotion (e.g. 😊, 😢, 😮). No bracketed tags.",
  },
  "voice-design": {
    toolDescription:
      "Generate a spoken Discord audio message using the active persona's configured voice design prompt. " +
      "Use this only when voice delivery materially improves the reply. " +
      "Write the script as natural plain speech text. You may optionally provide extra one-off delivery instructions " +
      'such as "sound mad", "near tears", or "sleepy and quiet"; those instructions shape this message only and are not spoken aloud. ' +
      "The tool sends the audio directly to the channel with no text caption.",
    scriptDescription:
      "The exact spoken script for the voice message. Keep it concise and natural for speech. " +
      "Plain text only: put delivery direction in voice_instructions instead of in the spoken script.",
    voiceInstructionsDescription:
      "Optional one-off delivery direction for this voice message only. Examples: sound mad, about to cry, whispery and tired. " +
      "Do not repeat the spoken script here.",
  },
} as const satisfies Record<
  string,
  { toolDescription: string; scriptDescription: string; voiceInstructionsDescription?: string }
>;

export type VoiceScriptMarkup = keyof typeof VOICE_TOOL_VARIANTS;

export function buildVoiceMessageToolVariant(tool: Tool, scriptMarkup: VoiceScriptMarkup): Tool {
  const variant = VOICE_TOOL_VARIANTS[scriptMarkup] ?? VOICE_TOOL_VARIANTS["bracket-tags"];
  const parameters: ToolParameterSchema = {
    ...tool.parameters,
    properties: {
      ...tool.parameters.properties,
      script: {
        ...tool.parameters.properties.script,
        description: variant.scriptDescription,
      },
      ...(scriptMarkup === "voice-design"
        ? {
            voice_instructions: {
              type: "string" as const,
              description: VOICE_TOOL_VARIANTS["voice-design"].voiceInstructionsDescription,
            },
          }
        : {}),
    },
  };

  return createToolVariant(tool, {
    description: variant.toolDescription,
    parameters,
  });
}

export class GenerateVoiceMessageTool extends BaseTool {
  name = "generate_voice_message";
  description = VOICE_TOOL_VARIANTS["bracket-tags"].toolDescription;
  category = "discord" as const;

  parameters: ToolParameterSchema = {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          'A short descriptive title for the voice message (e.g. "greeting", "farewell", "apology"). Used as the audio filename. Keep it lowercase with no spaces.',
      },
      script: {
        type: "string",
        description: VOICE_TOOL_VARIANTS["bracket-tags"].scriptDescription,
      },
    },
    required: ["title", "script"],
  };

  async assembleForContext(context: ToolAssemblyContext): Promise<Tool | null> {
    const serverId = Number.parseInt(context.state.server_id, 10);
    const activeSpeechEndpoint = Number.isInteger(serverId) ? await resolveActiveSpeechEndpoint(serverId) : null;
    const scriptMarkup =
      (activeSpeechEndpoint?.endpoint.extra_config?.script_markup as string | undefined) ?? "bracket-tags";
    const voiceDesign = shouldUseVoiceDesignForPersona(
      activeSpeechEndpoint?.endpoint,
      context.state.activePersonaVoiceDesignPrompt,
      context.state.activePersonaVoiceName,
    );
    const variant = voiceDesign
      ? "voice-design"
      : scriptMarkup in VOICE_TOOL_VARIANTS
        ? (scriptMarkup as VoiceScriptMarkup)
        : "bracket-tags";

    return buildVoiceMessageToolVariant(this, variant);
  }

  private resolveThreadId(context: ToolContext): string | undefined {
    return "isThread" in context.channel && typeof context.channel.isThread === "function" && context.channel.isThread()
      ? context.channel.id
      : undefined;
  }

  private buildAttachmentName(title: string, extension: string): string {
    const baseName = title
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);

    const safeBaseName = baseName.length > 0 ? baseName : "voice";
    return `${safeBaseName}.${extension}`;
  }

  /**
   * Sends a native Discord voice message via raw REST, bypassing discord.js's
   * MessagePayload serialization which drops unknown attachment fields like
   * `waveform` and `duration_secs`.
   *
   * @returns The sent message ID, or undefined if the request failed
   */
  private async sendNativeVoiceMessageViaRest(options: {
    webhook: Webhook;
    audioBuffer: Buffer;
    mimeType: string;
    filename: string;
    voiceMeta: VoiceMessageMetadata;
    username?: string;
    avatarUrl?: string | null;
    threadId?: string;
  }): Promise<string | undefined> {
    try {
      const { webhook, audioBuffer, mimeType, filename, voiceMeta, username, avatarUrl, threadId } = options;

      if (!webhook.token) return undefined;

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
          const threadParam = threadId ? `&thread_id=${encodeURIComponent(threadId)}` : "";
          const url = `${DISCORD_API_BASE}/webhooks/${webhook.id}/${webhook.token}?wait=true${threadParam}`;
          const response = await fetch(url, { method: "POST", body: form });

          if (!response.ok) {
            const errorText = await response.text().catch(() => "unknown");
            log.warn(
              `[VoiceWaveform] Discord API rejected native voice message: HTTP ${response.status} — ${errorText}`,
            );
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
  private async sendNativeVoiceMessageViaBotRest(options: {
    channel: ToolContext["channel"];
    audioBuffer: Buffer;
    mimeType: string;
    filename: string;
    voiceMeta: VoiceMessageMetadata;
  }): Promise<string | undefined> {
    try {
      const { channel, audioBuffer, mimeType, filename, voiceMeta } = options;

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
   * Sends a voice message through the best available path:
   * 1. Native REST with waveform metadata (webhook identity)
   * 2. Native REST with waveform metadata (bot identity)
   * 3. Plain attachment fallback (discord.js)
   *
   * @returns Sent message ID, or undefined on total failure
   */
  private async sendVoiceOrFallback(options: {
    context: ToolContext;
    audioBuffer: Buffer;
    mimeType: string;
    filename: string;
    voiceMeta: VoiceMessageMetadata | null;
    threadId?: string;
  }): Promise<string | undefined> {
    const { context, audioBuffer, mimeType, filename, voiceMeta, threadId } = options;
    let sentMessageId: string | undefined;

    if (voiceMeta) {
      if (context.webhook?.token) {
        sentMessageId = await this.sendNativeVoiceMessageViaRest({
          webhook: context.webhook,
          audioBuffer,
          mimeType,
          filename,
          voiceMeta,
          username: context.personaUsername,
          avatarUrl: context.personaAvatarUrl,
          threadId,
        });
        if (!sentMessageId) {
          log.warn("[VoiceWaveform] Webhook REST send failed — trying bot REST path");
        }
      } else if (context.webhook && !context.webhook.token) {
        log.warn(`[VoiceWaveform] Webhook token is null (id=${context.webhook.id}) — trying bot REST path`);
      }

      if (!sentMessageId) {
        sentMessageId = await this.sendNativeVoiceMessageViaBotRest({
          channel: context.channel,
          audioBuffer,
          mimeType,
          filename,
          voiceMeta,
        });
        if (!sentMessageId) {
          log.warn("[VoiceWaveform] Bot REST send failed — falling back to plain attachment");
        }
      }
    }

    if (!sentMessageId) {
      const attachment = new AttachmentBuilder(audioBuffer, { name: filename });
      if (context.webhook && context.personaUsername) {
        const sent = await sendWebhookMessageWithIdentity(
          context.webhook,
          {
            files: [attachment],
            allowedMentions: { parse: [], repliedUser: false },
            ...(threadId ? { threadId } : {}),
          },
          {
            username: context.personaUsername,
            avatarUrl: context.personaAvatarUrl,
            avatarDataUri: context.personaAvatarUrl?.startsWith("data:image/") ? context.personaAvatarUrl : undefined,
          },
        );
        sentMessageId = sent.id;
      } else {
        const sent = await context.channel.send({ files: [attachment] });
        sentMessageId = sent.id;
      }
    }

    return sentMessageId;
  }

  /**
   * Posts the TTS caption text as a visible blockquote in the channel.
   * Respects webhook persona identity when available.
   */
  private async postTranscriptCaption(context: ToolContext, captionText: string, threadId?: string): Promise<void> {
    const quotedCaption = `> ${captionText.replace(/\n/g, "\n> ")}`;
    try {
      if (context.webhook && context.personaUsername) {
        await sendWebhookMessageWithIdentity(
          context.webhook,
          {
            content: quotedCaption,
            allowedMentions: { parse: [] },
            ...(threadId ? { threadId } : {}),
          },
          {
            username: context.personaUsername,
            avatarUrl: context.personaAvatarUrl,
            avatarDataUri: context.personaAvatarUrl?.startsWith("data:image/") ? context.personaAvatarUrl : undefined,
          },
        );
      } else {
        await context.channel.send({ content: quotedCaption, allowedMentions: { parse: [] } });
      }
      log.info(`[VoiceChat] Posted TTS transcript | persona="${context.personaUsername ?? "bot"}"`);
    } catch (error) {
      log.warn("[VoiceChat] Failed to post TTS transcript", error);
    }
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const validation = this.validateParameters(args);
    if (!validation.isValid) {
      return {
        success: false,
        error: `Invalid parameters: ${validation.errors?.join(", ") || validation.missingParams?.join(", ") || "unknown validation error"}`,
      };
    }

    const title = typeof args.title === "string" ? args.title.trim() : "voice";
    const script = typeof args.script === "string" ? args.script.trim() : "";
    const voiceInstructions = typeof args.voice_instructions === "string" ? args.voice_instructions.trim() : "";
    if (!script) {
      return {
        success: false,
        error: "The voice script was empty.",
      };
    }

    // Determine which synthesis path to use based on what the active persona has configured.
    // Priority: speech_voice_design_prompt (instruct-capable local TTS) >
    // speech_voice_sample_id (local clone TTS) > speech_voice_id (ElevenLabs or other provider).
    const voiceDesignPrompt = context.tomoriState.speech_voice_design_prompt?.trim() ?? "";
    const voiceSampleId = context.tomoriState.speech_voice_sample_id ?? null;
    const voiceId = context.tomoriState.speech_voice_id?.trim() ?? "";

    // Try the new custom-endpoint credential path (Phase 4.1+).
    // Fall back to the legacy opt_api_keys entry for backward compatibility
    //    during the transition window before seed backfill migration has run.
    const speechEndpoint = await resolveActiveSpeechEndpoint(context.tomoriState.server_id);
    const activeEndpointIsVoiceDesign = isVoiceDesignEndpoint(speechEndpoint?.endpoint);
    const shouldUseVoiceDesign = shouldUseVoiceDesignForPersona(
      speechEndpoint?.endpoint,
      voiceDesignPrompt,
      context.tomoriState.speech_voice_name,
    );

    if (activeEndpointIsVoiceDesign && !voiceDesignPrompt) {
      return {
        success: false,
        error:
          "The active speech endpoint is configured for VoiceDesign, but the active persona does not have a voice design prompt yet. A server manager can add one in /config under Persona > Voice.",
      };
    }

    if (!voiceDesignPrompt && !voiceSampleId && !voiceId) {
      return {
        success: false,
        error:
          "No voice is configured for the active persona. A server manager can set one in /config under Persona > Voice.",
      };
    }

    // --- TTS voice-design path ---
    //
    // Voice-design endpoints use the same custom speech endpoint slot as clone
    // endpoints, but they should receive the persona's voice description as a
    // first-class `instruct` field in the JSON body. The endpoint metadata's
    // supports_instruct flag is our guardrail: it prevents accidentally sending
    // design prompts to older clone-only wrappers that ignore or reject instruct.
    // Auto endpoints are for mixed deployments: clone personas keep using their
    // stored samples, while VoiceDesign personas send `instruct` to the same URL.
    if (voiceDesignPrompt && speechEndpoint?.endpoint.api_style === "tts-clone" && shouldUseVoiceDesign) {
      const designResult = await synthesizeSpeechViaTtsVoiceDesign({
        endpoint: speechEndpoint.endpoint,
        script,
        designPrompt: voiceDesignPrompt,
        voiceInstructions,
        apiKey: speechEndpoint.apiKey,
      });
      if (!designResult.success || !designResult.audioBuffer) {
        return {
          success: false,
          error: designResult.details || "Failed to generate voice message via local voice-design TTS server.",
        };
      }

      const attachmentName = this.buildAttachmentName(title, designResult.extension ?? "wav");
      const threadId = this.resolveThreadId(context);
      const captionText = designResult.cleanedCaptionText ?? "";
      const mimeType = (designResult.contentType ?? "audio/wav").split(";")[0].trim();
      const voiceMeta = await generateVoiceMessageMetadata(designResult.audioBuffer, mimeType);

      if (!voiceMeta) {
        log.warn(
          "[VoiceWaveform] TTS voice-design waveform generation returned null — falling back to plain attachment",
        );
      }

      const sentMessageId = await this.sendVoiceOrFallback({
        context,
        audioBuffer: designResult.audioBuffer,
        mimeType,
        filename: attachmentName,
        voiceMeta,
        threadId,
      });

      if (sentMessageId && captionText) {
        setCachedVoiceTranscript(sentMessageId, captionText, "tts");
        log.info(
          `[VoiceCache] SET tts (voice-design) | msg=${sentMessageId} | chars=${captionText.length} | preview="${captionText.slice(0, 60)}${captionText.length > 60 ? "…" : ""}"`,
        );
      }

      if (sentMessageId && captionText && context.tomoriState.config.voice_transcript_chat_mode) {
        await this.postTranscriptCaption(context, captionText, threadId);
      }

      // Canonical audio-generation telemetry, keyed by TTS backend so the read
      // layer can break voice usage down by engine (the total stays SUM over keys).
      // tool_used already counts the call; this adds the un-backfillable backend dimension.
      if (context.internalUserId) {
        statRepository.recordStat({
          serverId: context.tomoriState.server_id,
          userId: context.internalUserId,
          lineageId: context.tomoriState.persona_lineage_id ?? 0,
          metric: "audio_generated",
          metricKey: "tts-voice-design",
        });
      }

      return {
        success: true,
        message: "Voice message generated and sent to Discord.",
        responseDelivered: true,
        endTurn: true,
      };
    }

    if (voiceDesignPrompt && !voiceSampleId && !voiceId) {
      return {
        success: false,
        error:
          "The active persona has a voice design prompt, but the active speech endpoint does not support instruct-based voice design. Select a VoiceDesign speech endpoint or assign a different voice.",
      };
    }

    if (voiceSampleId && speechEndpoint?.endpoint.api_style === "tts-clone") {
      const cloneResult = await synthesizeSpeechViaTtsClone({
        endpoint: speechEndpoint.endpoint,
        voiceSampleId,
        script,
        apiKey: speechEndpoint.apiKey,
        chatterbox: {
          turboEnabled: context.tomoriState.config.chatterbox_turbo_enabled ?? true,
          cfgWeight: context.tomoriState.config.chatterbox_cfg_weight ?? 0.5,
          exaggeration: context.tomoriState.config.chatterbox_exaggeration ?? 0.5,
        },
      });
      if (!cloneResult.success || !cloneResult.audioBuffer) {
        return {
          success: false,
          error: cloneResult.details || "Failed to generate voice message via local TTS server.",
        };
      }

      const attachmentName = this.buildAttachmentName(title, cloneResult.extension ?? "wav");
      const threadId = this.resolveThreadId(context);
      const captionText = cloneResult.cleanedCaptionText ?? "";
      const mimeType = (cloneResult.contentType ?? "audio/wav").split(";")[0].trim();
      const voiceMeta = await generateVoiceMessageMetadata(cloneResult.audioBuffer, mimeType);

      if (!voiceMeta) {
        log.warn("[VoiceWaveform] TTS clone waveform generation returned null — falling back to plain attachment");
      }

      const sentMessageId = await this.sendVoiceOrFallback({
        context,
        audioBuffer: cloneResult.audioBuffer,
        mimeType,
        filename: attachmentName,
        voiceMeta,
        threadId,
      });

      if (sentMessageId && captionText) {
        setCachedVoiceTranscript(sentMessageId, captionText, "tts");
        log.info(
          `[VoiceCache] SET tts (clone) | msg=${sentMessageId} | chars=${captionText.length} | preview="${captionText.slice(0, 60)}${captionText.length > 60 ? "…" : ""}"`,
        );
      }

      if (sentMessageId && captionText && context.tomoriState.config.voice_transcript_chat_mode) {
        await this.postTranscriptCaption(context, captionText, threadId);
      }

      // Canonical audio-generation telemetry, keyed by TTS backend (see voice-design branch).
      if (context.internalUserId) {
        statRepository.recordStat({
          serverId: context.tomoriState.server_id,
          userId: context.internalUserId,
          lineageId: context.tomoriState.persona_lineage_id ?? 0,
          metric: "audio_generated",
          metricKey: "tts-clone",
        });
      }

      return {
        success: true,
        message: "Voice message generated and sent to Discord.",
        responseDelivered: true,
        endTurn: true,
      };
    }

    if (!voiceId) {
      return {
        success: false,
        error:
          "No voice ID is configured for the active persona. A server manager can set one in /config under Persona > Voice.",
      };
    }

    const apiKey =
      speechEndpoint?.apiKey || (await getOptApiKey(context.tomoriState.server_id, ELEVENLABS_SERVICE_NAME));

    if (!apiKey) {
      return {
        success: false,
        error: "No speech API key is available for this server. A server manager can configure one with /providers.",
      };
    }

    const synthesisResult = await synthesizeSpeechViaElevenLabsAdapter({
      apiKey,
      voiceId,
      script,
    });
    if (!synthesisResult.success || !synthesisResult.audioBuffer) {
      return {
        success: false,
        error: synthesisResult.details || "Failed to generate the ElevenLabs voice message.",
      };
    }

    const attachmentName = this.buildAttachmentName(title, synthesisResult.extension ?? "mp3");
    const threadId = this.resolveThreadId(context);
    const captionText = synthesisResult.cleanedCaptionText ?? "";
    // Strip MIME parameters, so Discord rejects waveform/duration_secs for non-bare types.
    const mimeType = (synthesisResult.contentType ?? "audio/mpeg").split(";")[0].trim();
    const voiceMeta = await generateVoiceMessageMetadata(synthesisResult.audioBuffer, mimeType);

    if (!voiceMeta) {
      log.warn("[VoiceWaveform] Waveform generation returned null — falling back to plain attachment");
    }

    const sentMessageId = await this.sendVoiceOrFallback({
      context,
      audioBuffer: synthesisResult.audioBuffer,
      mimeType,
      filename: attachmentName,
      voiceMeta,
      threadId,
    });

    if (sentMessageId && captionText) {
      setCachedVoiceTranscript(sentMessageId, captionText, "tts");
      log.info(
        `[VoiceCache] SET tts | msg=${sentMessageId} | chars=${captionText.length} | preview="${captionText.slice(0, 60)}${captionText.length > 60 ? "…" : ""}"`,
      );
    }

    if (sentMessageId && captionText && context.tomoriState.config.voice_transcript_chat_mode) {
      await this.postTranscriptCaption(context, captionText, threadId);
    }

    // Canonical audio-generation telemetry, keyed by TTS backend (see voice-design branch).
    if (context.internalUserId) {
      statRepository.recordStat({
        serverId: context.tomoriState.server_id,
        userId: context.internalUserId,
        lineageId: context.tomoriState.persona_lineage_id ?? 0,
        metric: "audio_generated",
        metricKey: "elevenlabs",
      });
    }

    return {
      success: true,
      message: "Voice message generated and sent to Discord.",
      responseDelivered: true,
      endTurn: true,
    };
  }
}
