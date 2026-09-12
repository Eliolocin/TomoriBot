/**
 * Single synthesis dispatcher shared by `generate_voice_message` and
 * `/generate voice-message`.
 *
 * The tool previously held three inline branches (voice-design, clone, ElevenLabs)
 * that each repeated their own backend key. Routing both callers through one
 * function keeps the branch priority, the error text, and the `audio_generated`
 * metric key in a single place.
 */

import type { CustomEndpointRow } from "@/types/db/schema";
import type { ElevenLabsTtsErrorKind } from "@/utils/audio/elevenLabsTts";
import { synthesizeSpeechViaElevenLabsAdapter } from "@/providers/custom/styles/elevenLabsAdapter";
import {
  synthesizeSpeechViaTtsClone,
  synthesizeSpeechViaTtsCloneBuffer,
  type TtsCloneErrorKind,
} from "@/providers/custom/styles/ttsCloningAdapter";
import { synthesizeSpeechViaTtsVoiceDesign } from "@/providers/custom/styles/ttsVoiceDesignAdapter";
import { resolveVoiceSourceCapabilities } from "@/utils/speech/voiceSourceCapabilities";

/** Metric key recorded against the `audio_generated` stat. */
export type VoiceBackendKey = "elevenlabs" | "tts-clone" | "tts-voice-design";

/** Union of the error kinds the three backends can report. */
export type VoiceSynthesisErrorKind = TtsCloneErrorKind | ElevenLabsTtsErrorKind;

/**
 * Which voice the caller wants this message synthesized from.
 *
 * A clone source carries either a stored sample id or raw audio: `/generate voice-message`
 * accepts an ad-hoc upload that has no `voice_samples` row, so a sample id alone cannot
 * express every clone request.
 */
export type ResolvedVoiceSource =
  | { kind: "design"; designPrompt: string }
  | { kind: "clone"; voiceSampleId: number }
  | { kind: "clone-buffer"; refAudio: Buffer; refText: string | null }
  | { kind: "elevenlabs"; voiceId: string };

export interface VoiceMessageSynthesisResult {
  success: boolean;
  audioBuffer?: Buffer;
  /** Bare MIME type (no parameters), e.g. "audio/wav". */
  contentType?: string;
  extension?: string;
  /** Script text with markup stripped, suitable for transcript display. */
  cleanedCaptionText?: string;
  errorKind?: VoiceSynthesisErrorKind;
  details?: string;
  /** The backend that produced the audio, already resolved for `audio_generated`. */
  backendKey: VoiceBackendKey;
}

export interface VoiceMessageSynthesisRequest {
  endpoint: CustomEndpointRow | null;
  /** Credential for the active speech endpoint; empty for unauthenticated local servers. */
  endpointApiKey: string;
  /** Credential for the ElevenLabs fallback, consulted only when that path is taken. */
  elevenLabsApiKey: string;
  source: ResolvedVoiceSource;
  script: string;
  /** Per-message delivery direction for design or instruct-capable clone endpoints. */
  voiceInstructions?: string;
  /** Chatterbox delivery overrides for this invocation, clone sources only. */
  chatterbox?: {
    turboEnabled: boolean;
    cfgWeight: number;
    exaggeration: number;
  };
  /** ElevenLabs voice settings for this invocation, `elevenlabs` sources only. */
  elevenLabsVoiceSettings?: Record<string, unknown>;
}

function failure(
  backendKey: VoiceBackendKey,
  details: string,
  errorKind: TtsCloneErrorKind = "invalid_request",
): VoiceMessageSynthesisResult {
  return { success: false, errorKind, details, backendKey };
}

/**
 * Synthesizes one voice message from the resolved source.
 *
 * Branch priority mirrors the tool's historic ladder: a design-shaped source wins when the
 * endpoint is configured for voice design, then clone sources, then the ElevenLabs voice id.
 * Returning `backendKey` here is deliberate: it is the `audio_generated` metric key, and
 * recomputing it at each call site is how the three branches drifted apart before.
 */
export async function synthesizeVoiceMessage(
  request: VoiceMessageSynthesisRequest,
): Promise<VoiceMessageSynthesisResult> {
  const { endpoint, endpointApiKey, elevenLabsApiKey, source, script, chatterbox } = request;
  // Single source of truth for which request shapes the endpoint takes, shared with the modal's
  // source table so the two can never disagree about what an `auto` endpoint accepts.
  const capabilities = resolveVoiceSourceCapabilities(endpoint);

  if (source.kind === "design") {
    if (!endpoint) {
      return failure("tts-voice-design", "No active speech endpoint is configured for this server.");
    }

    // `auto` accepts design bodies too. Gating this on the dedicated-endpoint check instead is what
    // silently disables voice design on every mixed deployment, which is the one mode the modal's
    // voice-source radio exists to serve.
    if (!capabilities.acceptsDesignShape) {
      return failure(
        "tts-voice-design",
        "The active persona has a voice design prompt, but the active speech endpoint does not support instruct-based voice design. Select a VoiceDesign speech endpoint or assign a different voice.",
      );
    }

    const result = await synthesizeSpeechViaTtsVoiceDesign({
      endpoint,
      script,
      designPrompt: source.designPrompt,
      voiceInstructions: request.voiceInstructions,
      apiKey: endpointApiKey,
    });
    return {
      success: result.success,
      audioBuffer: result.audioBuffer,
      contentType: result.contentType,
      extension: result.extension,
      cleanedCaptionText: result.cleanedCaptionText,
      errorKind: result.errorKind,
      details: result.details || "Failed to generate voice message via local voice-design TTS server.",
      backendKey: "tts-voice-design",
    };
  }

  if (source.kind === "clone" || source.kind === "clone-buffer") {
    if (!endpoint) {
      return failure(
        "tts-clone",
        "No speech clone endpoint is configured for this server. A server manager can add one with /providers.",
      );
    }

    // Capability, not `api_style` alone: a voice-design-only endpoint rejects a clone body even
    // though it is still a `tts-clone` endpoint, so posting one would reach the server and fail
    // there instead of here.
    if (!capabilities.acceptsCloneShape) {
      return failure(
        "tts-clone",
        "No speech clone endpoint is configured for this server. A server manager can add one with /providers.",
      );
    }

    const result =
      source.kind === "clone"
        ? await synthesizeSpeechViaTtsClone({
            endpoint,
            voiceSampleId: source.voiceSampleId,
            script,
            instruct: request.voiceInstructions,
            apiKey: endpointApiKey,
            ...(chatterbox ? { chatterbox } : {}),
          })
        : await synthesizeSpeechViaTtsCloneBuffer({
            endpoint,
            refAudio: source.refAudio,
            refText: source.refText,
            script,
            instruct: request.voiceInstructions,
            apiKey: endpointApiKey,
            ...(chatterbox ? { chatterbox } : {}),
          });

    return {
      success: result.success,
      audioBuffer: result.audioBuffer,
      contentType: result.contentType,
      extension: result.extension,
      cleanedCaptionText: result.cleanedCaptionText,
      errorKind: result.errorKind,
      details: result.details || "Failed to generate voice message via local TTS server.",
      backendKey: "tts-clone",
    };
  }

  if (!elevenLabsApiKey) {
    return failure(
      "elevenlabs",
      "No speech API key is available for this server. A server manager can configure one with /providers.",
    );
  }

  const result = await synthesizeSpeechViaElevenLabsAdapter({
    apiKey: elevenLabsApiKey,
    voiceId: source.voiceId,
    script,
    ...(request.elevenLabsVoiceSettings ? { voiceSettings: request.elevenLabsVoiceSettings } : {}),
  });

  return {
    success: result.success,
    audioBuffer: result.audioBuffer,
    contentType: result.contentType,
    extension: result.extension,
    cleanedCaptionText: result.cleanedCaptionText,
    errorKind: result.errorKind,
    details: result.details || "Failed to generate the ElevenLabs voice message.",
    backendKey: "elevenlabs",
  };
}
