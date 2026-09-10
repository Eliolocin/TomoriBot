import { synthesizeSpeechWithElevenLabs } from "@/utils/audio/elevenLabsTts";
import type { ElevenLabsTtsResult } from "@/utils/audio/elevenLabsTts";

export interface ElevenLabsAdapterRequest {
  apiKey: string;
  voiceId: string;
  script: string;
  /**
   * Per-invocation overrides merged into the request's `voice_settings`.
   * Omit entirely to keep the request body byte-identical to the provider defaults.
   */
  voiceSettings?: Record<string, unknown>;
}

/**
 * Thin adapter that wraps `synthesizeSpeechWithElevenLabs` for use via the
 * custom endpoint pathway. Reads `speech_voice_id`.
 */
export async function synthesizeSpeechViaElevenLabsAdapter(
  request: ElevenLabsAdapterRequest,
): Promise<ElevenLabsTtsResult> {
  return synthesizeSpeechWithElevenLabs({
    apiKey: request.apiKey,
    voiceId: request.voiceId,
    script: request.script,
    ...(request.voiceSettings ? { voiceSettings: request.voiceSettings } : {}),
  });
}
