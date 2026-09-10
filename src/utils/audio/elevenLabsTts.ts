import {
  ELEVENLABS_API_BASE_URL,
  getElevenLabsTtsConfig,
  sanitizeElevenLabsTaggedScript,
} from "@/utils/audio/elevenLabsShared";

export type ElevenLabsTtsErrorKind =
  | "missing_api_key"
  | "invalid_request"
  | "timeout"
  | "request_failed"
  | "invalid_response";

export interface ElevenLabsTtsRequest {
  apiKey: string;
  voiceId: string;
  script: string;
  modelId?: string;
  voiceSettings?: Record<string, unknown>;
}

export interface ElevenLabsTtsResult {
  success: boolean;
  audioBuffer?: Buffer;
  contentType?: string;
  extension?: string;
  cleanedCaptionText?: string;
  modelUsed?: string;
  voiceId?: string;
  errorKind?: ElevenLabsTtsErrorKind;
  statusCode?: number;
  details?: string;
}

function inferAudioOutputMetadata(outputFormat: string): {
  contentType: string;
  extension: string;
} {
  const normalized = outputFormat.trim().toLowerCase();
  if (normalized.startsWith("pcm")) {
    return {
      contentType: "audio/wav",
      extension: "wav",
    };
  }

  if (normalized.startsWith("ogg") || normalized.startsWith("opus")) {
    return {
      contentType: "audio/ogg",
      extension: "ogg",
    };
  }

  return {
    contentType: "audio/mpeg",
    extension: "mp3",
  };
}

export async function synthesizeSpeechWithElevenLabs(request: ElevenLabsTtsRequest): Promise<ElevenLabsTtsResult> {
  if (!request.apiKey.trim()) {
    return {
      success: false,
      errorKind: "missing_api_key",
      details: "Missing ElevenLabs API key.",
    };
  }

  if (!request.voiceId.trim()) {
    return {
      success: false,
      errorKind: "invalid_request",
      details: "Missing ElevenLabs voice ID.",
    };
  }

  const config = getElevenLabsTtsConfig();
  const { rawScript, captionText } = sanitizeElevenLabsTaggedScript(
    request.script,
    config.maxChars,
    config.stripUnsupportedTags,
  );
  if (!rawScript || !captionText) {
    return {
      success: false,
      errorKind: "invalid_request",
      details: "Voice script was empty after normalization.",
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
  const outputMetadata = inferAudioOutputMetadata(config.outputFormat);

  try {
    const response = await fetch(
      `${ELEVENLABS_API_BASE_URL}/v1/text-to-speech/${encodeURIComponent(request.voiceId)}?output_format=${encodeURIComponent(config.outputFormat)}`,
      {
        method: "POST",
        headers: {
          Accept: outputMetadata.contentType,
          "Content-Type": "application/json",
          "xi-api-key": request.apiKey,
        },
        body: JSON.stringify({
          text: rawScript,
          model_id: request.modelId ?? config.modelId,
          ...(request.voiceSettings ? { voice_settings: request.voiceSettings } : {}),
        }),
        signal: controller.signal,
      },
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      let details = `HTTP ${response.status}`;
      try {
        const responseJson = (await response.json()) as Record<string, unknown>;
        if (typeof responseJson.detail === "string") {
          details = responseJson.detail;
        }
      } catch {}

      return {
        success: false,
        errorKind: "request_failed",
        statusCode: response.status,
        details,
      };
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    if (audioBuffer.length === 0) {
      return {
        success: false,
        errorKind: "invalid_response",
        statusCode: response.status,
        details: "ElevenLabs returned an empty audio payload.",
      };
    }

    return {
      success: true,
      audioBuffer,
      contentType: response.headers.get("content-type") ?? outputMetadata.contentType,
      extension: outputMetadata.extension,
      cleanedCaptionText: captionText,
      modelUsed: request.modelId ?? config.modelId,
      voiceId: request.voiceId,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      return {
        success: false,
        errorKind: "timeout",
        details: `ElevenLabs TTS request timed out after ${config.timeoutMs}ms.`,
      };
    }

    return {
      success: false,
      errorKind: "request_failed",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}
