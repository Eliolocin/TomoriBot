import type { BaseGuildTextChannel, TextChannel } from "discord.js";
import {
  BaseTool,
  type Tool,
  type ToolAssemblyContext,
  type ToolContext,
  type ToolParameterSchema,
  type ToolResult,
} from "@/types/tool/interfaces";
import { createToolVariant } from "@/tools/assembly";
import { ELEVENLABS_SERVICE_NAME } from "@/utils/audio/elevenLabsAccount";
import { setCachedVoiceTranscript } from "@/utils/audio/voiceTranscriptCache";
import { generateVoiceMessageMetadata } from "@/utils/audio/voiceMessageMetadata";
import { getOptApiKey } from "@/utils/security/crypto";
import {
  deliverVoiceMessage,
  postVoiceTranscriptCaption,
  type VoiceDeliveryTarget,
} from "@/utils/discord/webhook/voiceMessageDelivery";
import { resolveActiveSpeechEndpoint } from "@/utils/provider/speechEndpointResolver";
import { shouldUseVoiceDesignForPersona } from "@/providers/custom/styles/ttsVoiceDesignAdapter";
import { resolveVoiceSourceCapabilities, type VoiceSourceCapabilities } from "@/utils/speech/voiceSourceCapabilities";
import { synthesizeVoiceMessage, type ResolvedVoiceSource } from "@/utils/speech/voiceMessageSynthesis";
import type { CustomEndpointRow } from "@/types/db/schema";
import { statRepository } from "@/utils/db/repositories";
import { log } from "@/utils/misc/logger";

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

export function buildVoiceMessageToolVariant(
  tool: Tool,
  scriptMarkup: VoiceScriptMarkup,
  supportsInstruct = false,
): Tool {
  const variant = VOICE_TOOL_VARIANTS[scriptMarkup] ?? VOICE_TOOL_VARIANTS["bracket-tags"];
  const exposesVoiceInstructions = scriptMarkup === "voice-design" || supportsInstruct;
  const parameters: ToolParameterSchema = {
    ...tool.parameters,
    properties: {
      ...tool.parameters.properties,
      script: {
        ...tool.parameters.properties.script,
        description: variant.scriptDescription,
      },
      ...(exposesVoiceInstructions
        ? {
            voice_instructions: {
              type: "string" as const,
              description: VOICE_TOOL_VARIANTS["voice-design"].voiceInstructionsDescription,
            },
          }
        : {}),
    },
  };

  const description =
    supportsInstruct && scriptMarkup !== "voice-design"
      ? `${variant.toolDescription} You may optionally provide natural-language delivery direction in voice_instructions; it shapes this message only and is not spoken aloud.`
      : variant.toolDescription;

  return createToolVariant(tool, {
    description,
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
    const endpoint = activeSpeechEndpoint?.endpoint ?? null;
    const scriptMarkup = (endpoint?.extra_config?.script_markup as string | undefined) ?? "bracket-tags";
    const voiceDesign = shouldUseVoiceDesignForPersona(
      endpoint,
      context.state.activePersonaVoiceDesignPrompt,
      context.state.activePersonaVoiceName,
    );
    const variant = voiceDesign
      ? "voice-design"
      : scriptMarkup in VOICE_TOOL_VARIANTS
        ? (scriptMarkup as VoiceScriptMarkup)
        : "bracket-tags";
    const capabilities = resolveVoiceSourceCapabilities(endpoint);
    const supportsCloneInstructions =
      !voiceDesign && capabilities.acceptsCloneShape && Boolean(endpoint?.extra_config.supports_instruct);

    return buildVoiceMessageToolVariant(this, variant, supportsCloneInstructions);
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
   * The persona's design prompt, when the endpoint is configured to receive one.
   *
   * `shouldUseVoiceDesignForPersona` is the ladder's entry condition for this branch, not an
   * optimization: it carries the `VoiceDesign` sentinel rule, so on an `auto` endpoint a persona
   * that also holds a sample keeps using that sample unless its voice name is the sentinel. It also
   * subsumes the shape check, which is why the caller does not pre-gate on `acceptsDesignShape`.
   */
  private resolveDesignSource(context: ToolContext, endpoint: CustomEndpointRow | null): ResolvedVoiceSource | null {
    const voiceDesignPrompt = context.tomoriState.speech_voice_design_prompt?.trim() ?? "";
    if (!voiceDesignPrompt) return null;

    return shouldUseVoiceDesignForPersona(endpoint, voiceDesignPrompt, context.tomoriState.speech_voice_name)
      ? { kind: "design", designPrompt: voiceDesignPrompt }
      : null;
  }

  /**
   * The clone or ElevenLabs voices to fall back on, most preferred first.
   *
   * Returned as an ordered list rather than one committed choice because the two sources are gated
   * by different capabilities: a sample is only usable on a clone-capable endpoint, while an
   * ElevenLabs voice id is the only option on an ElevenLabs endpoint and on servers with no speech
   * endpoint at all. Committing to the sample first would strand every persona that holds both.
   */
  private resolveFallbackCandidates(context: ToolContext): ResolvedVoiceSource[] {
    const candidates: ResolvedVoiceSource[] = [];

    const voiceSampleId = context.tomoriState.speech_voice_sample_id ?? null;
    if (voiceSampleId) candidates.push({ kind: "clone", voiceSampleId });

    const voiceId = context.tomoriState.speech_voice_id?.trim() ?? "";
    if (voiceId) candidates.push({ kind: "elevenlabs", voiceId });

    return candidates;
  }

  /**
   * Filters the fallback list down to the shapes the active endpoint can actually receive.
   *
   * The guards are per member, not per list: a clone candidate asks the capability table, while an
   * ElevenLabs candidate only asks whether a voice id is present. Asking the clone question of the
   * list would make it false for exactly the servers where ElevenLabs is the only option.
   */
  private filterUsableFallbacks(
    candidates: readonly ResolvedVoiceSource[],
    capabilities: VoiceSourceCapabilities,
  ): ResolvedVoiceSource[] {
    return candidates.filter((candidate) =>
      candidate.kind === "clone" ? capabilities.acceptsCloneShape : candidate.kind === "elevenlabs",
    );
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

    const speechEndpoint = await resolveActiveSpeechEndpoint(context.tomoriState.server_id);
    const activeEndpoint = speechEndpoint?.endpoint ?? null;
    const capabilities = resolveVoiceSourceCapabilities(activeEndpoint);

    // Design first, then the ladder's clone-then-ElevenLabs order, with the fallbacks filtered to
    // the shapes this endpoint can actually receive. Filtering per candidate rather than per list
    // is what keeps an ElevenLabs voice reachable on a server whose endpoint is ElevenLabs or
    // absent, where no candidate is clone-shaped.
    const designSource = this.resolveDesignSource(context, activeEndpoint);
    const usableFallbacks = this.filterUsableFallbacks(this.resolveFallbackCandidates(context), capabilities);
    const voiceDesignPrompt = context.tomoriState.speech_voice_design_prompt?.trim() ?? "";

    // A design prompt on an endpoint that cannot receive `instruct` is a configuration mismatch
    // rather than a missing voice, so it keeps the message that names the fix. A persona that also
    // holds a usable sample or ElevenLabs voice id is not stuck, so this only fires when design is
    // genuinely the persona's only configuration.
    if (voiceDesignPrompt && !designSource && usableFallbacks.length === 0 && !capabilities.acceptsDesignShape) {
      return {
        success: false,
        error:
          "The active persona has a voice design prompt, but the active speech endpoint does not support instruct-based voice design. Select a VoiceDesign speech endpoint or assign a different voice.",
      };
    }

    const source = designSource ?? usableFallbacks[0] ?? null;
    if (!source) {
      // Reachable only on `auto`, where the sentinel is the entry condition: a dedicated
      // voice-design endpoint always selects the design branch once a prompt exists. The other two
      // messages would both send the manager to change a setting that is already correct, so this
      // one names the voice name, which is the only thing standing between here and synthesis.
      if (voiceDesignPrompt && capabilities.acceptsDesignShape) {
        return {
          success: false,
          error:
            "The active persona has a voice design prompt and the active speech endpoint accepts one, but the endpoint is in auto mode, where a persona uses voice design only when its voice name is VoiceDesign. A server manager can set that name in /config under Persona > Voice, or assign a voice sample to use the clone path instead.",
        };
      }

      // The persona does have a voice; it is the endpoint that cannot take its shape. Saying "no
      // voice is configured" here would send the manager to the wrong settings page.
      const hasMisroutedVoice = this.resolveFallbackCandidates(context).length > 0 || Boolean(voiceDesignPrompt);
      return {
        success: false,
        error: hasMisroutedVoice
          ? "The active persona's voice cannot be used with the active speech endpoint. A server manager can point /providers at an endpoint matching that voice type, or assign a different voice in /config under Persona > Voice."
          : "No voice is configured for the active persona. A server manager can set one in /config under Persona > Voice.",
      };
    }

    // Credentials resolve per backend: the ElevenLabs path historically preferred the
    // endpoint key over the legacy opt_api_keys entry, while both local paths use the
    // endpoint key alone.
    const elevenLabsApiKey =
      source.kind === "elevenlabs"
        ? speechEndpoint?.apiKey || (await getOptApiKey(context.tomoriState.server_id, ELEVENLABS_SERVICE_NAME)) || ""
        : "";
    const endpointApiKey = speechEndpoint?.apiKey ?? "";

    const synthesisResult = await synthesizeVoiceMessage({
      endpoint: activeEndpoint,
      endpointApiKey,
      elevenLabsApiKey,
      source,
      script,
      voiceInstructions,
      chatterbox: {
        turboEnabled: context.tomoriState.config.chatterbox_turbo_enabled ?? true,
        cfgWeight: context.tomoriState.config.chatterbox_cfg_weight ?? 0.5,
        exaggeration: context.tomoriState.config.chatterbox_exaggeration ?? 0.5,
      },
    });

    if (!synthesisResult.success || !synthesisResult.audioBuffer) {
      return {
        success: false,
        error: synthesisResult.details || "Failed to generate the voice message.",
      };
    }

    const isElevenLabs = synthesisResult.backendKey === "elevenlabs";
    const attachmentName = this.buildAttachmentName(title, synthesisResult.extension ?? (isElevenLabs ? "mp3" : "wav"));
    const threadId = this.resolveThreadId(context);
    const captionText = synthesisResult.cleanedCaptionText ?? "";
    // Strip MIME parameters, so Discord rejects waveform/duration_secs for non-bare types.
    const mimeType = (synthesisResult.contentType ?? (isElevenLabs ? "audio/mpeg" : "audio/wav")).split(";")[0].trim();
    const voiceMeta = await generateVoiceMessageMetadata(synthesisResult.audioBuffer, mimeType);

    if (!voiceMeta) {
      log.warn("[VoiceWaveform] Waveform generation returned null — falling back to plain attachment");
    }

    const target: VoiceDeliveryTarget = {
      // The tool types its channel more broadly than the delivery module, which only
      // ever reaches Discord's guild message endpoints.
      channel: context.channel as TextChannel | BaseGuildTextChannel,
      webhook: context.webhook ?? null,
      threadId,
      personaUsername: context.personaUsername,
      personaAvatarUrl: context.personaAvatarUrl,
    };

    const sentMessageId = await deliverVoiceMessage({
      target,
      audioBuffer: synthesisResult.audioBuffer,
      mimeType,
      filename: attachmentName,
      voiceMeta,
    });

    if (sentMessageId && captionText) {
      setCachedVoiceTranscript(sentMessageId, captionText, "tts");
      log.info(
        `[VoiceCache] SET tts (${synthesisResult.backendKey}) | msg=${sentMessageId} | chars=${captionText.length} | preview="${captionText.slice(0, 60)}${captionText.length > 60 ? "…" : ""}"`,
      );
    }

    if (sentMessageId && captionText && context.tomoriState.config.voice_transcript_chat_mode) {
      await postVoiceTranscriptCaption(target, captionText);
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
        metricKey: synthesisResult.backendKey,
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
