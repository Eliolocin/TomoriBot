import type { CustomEndpointRow } from "@/types/db/schema";
import { stripElevenLabsExpressionTags } from "@/utils/audio/elevenLabsShared";
import { fetchUserRemoteUrl } from "@/utils/security/userRemoteFetch";
import { stripTtsUnsupportedEmojiAttempts } from "@/utils/text/emojiHelper";
import { log } from "@/utils/misc/logger";
import type { TtsCloneErrorKind, TtsCloneResult } from "@/providers/custom/styles/ttsCloningAdapter";
import { resolveTtsSynthesizeTimeoutMs } from "@/providers/custom/styles/ttsSynthesizeTimeout";

function isEnabledEnv(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

/** Timeout for local /synthesize requests, configurable via env. */
const TTS_SYNTHESIZE_TIMEOUT_MS = resolveTtsSynthesizeTimeoutMs();
const TTS_VOICE_DESIGN_LOG_PAYLOADS = isEnabledEnv(process.env.TTS_VOICE_DESIGN_LOG_PAYLOADS);
const TTS_VOICE_DESIGN_LOG_PREVIEW_CHARS = 240;

/** Regex matching any bracket-tag in the form [content]. */
const ANY_BRACKET_TAG_REGEX = /\[([^\]\r\n]{1,40})\]/g;

export interface TtsVoiceDesignRequest {
  endpoint: CustomEndpointRow;
  script: string;
  /** Natural-language prompt describing the desired speaker voice. */
  designPrompt: string;
  /** Optional per-message delivery direction, e.g. "sound angry" or "near tears". */
  voiceInstructions?: string;
  /** Empty string for local endpoints that don't require auth. */
  apiKey: string;
}

type TtsVoiceMode = "clone" | "voice-design" | "auto";

function getTtsVoiceMode(endpoint: CustomEndpointRow | null | undefined): TtsVoiceMode {
  const rawMode = endpoint?.extra_config.voice_mode;
  return rawMode === "voice-design" || rawMode === "auto" ? rawMode : "clone";
}

export function isVoiceDesignEndpoint(endpoint: CustomEndpointRow | null | undefined): boolean {
  return endpoint?.api_style === "tts-clone" && getTtsVoiceMode(endpoint) === "voice-design";
}

export function shouldUseVoiceDesignForPersona(
  endpoint: CustomEndpointRow | null | undefined,
  voiceDesignPrompt: string | null | undefined,
  activeVoiceName?: string | null,
): boolean {
  if (endpoint?.api_style !== "tts-clone") return false;

  const mode = getTtsVoiceMode(endpoint);
  if (mode === "voice-design") return true;
  if (mode !== "auto") return false;

  return Boolean(voiceDesignPrompt?.trim()) && activeVoiceName === "VoiceDesign";
}

function resolveExtensionFromContentType(contentType: string): string {
  const bare = contentType.split(";")[0].trim().toLowerCase();
  if (bare === "audio/wav" || bare === "audio/wave" || bare === "audio/x-wav") return "wav";
  if (bare === "audio/ogg" || bare === "audio/opus") return "ogg";
  return "mp3";
}

function normalizeTtsWhitespace(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[^\S\n]+/g, " ")
    .trim();
}

function stringifyErrorDetail(detail: unknown): string | null {
  if (!detail) return null;
  if (typeof detail === "string") return detail;

  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

function previewForLog(text: string): string {
  const escaped = text.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  if (TTS_VOICE_DESIGN_LOG_PAYLOADS || escaped.length <= TTS_VOICE_DESIGN_LOG_PREVIEW_CHARS) return escaped;
  return `${escaped.slice(0, TTS_VOICE_DESIGN_LOG_PREVIEW_CHARS)}...`;
}

/**
 * Prepares text for instruct/voice-design TTS endpoints.
 *
 * The model-facing voice design prompt is sent separately as `instruct`, so
 * the spoken script should stay clean. Today Qwen3-TTS VoiceDesign expects
 * plain speech text, but this keeps the adapter aligned with the endpoint's
 * `script_markup` metadata in case another design model later supports emoji
 * markers.
 */
function prepareVoiceDesignText(
  script: string,
  scriptMarkup: string,
): { processedScript: string; captionText: string } {
  const preserveUnicodeEmojis = scriptMarkup === "emoji";
  const withoutBracketTags =
    scriptMarkup === "bracket-tags" ? script : normalizeTtsWhitespace(script.replace(ANY_BRACKET_TAG_REGEX, ""));

  const processedScript = stripTtsUnsupportedEmojiAttempts(withoutBracketTags, { preserveUnicodeEmojis });
  const captionText = stripTtsUnsupportedEmojiAttempts(stripElevenLabsExpressionTags(withoutBracketTags), {
    preserveUnicodeEmojis,
  });

  return { processedScript, captionText };
}

/**
 * Calls a local voice-design TTS server that implements TomoriBot's
 * `/synthesize` contract.
 *
 * This is intentionally separate from `ttsCloningAdapter.ts`. Clone models
 * synthesize from a stored speaker sample; voice-design models synthesize from
 * a persona-level natural-language prompt. Sending the prompt as `instruct`
 * makes the JSON body honest and keeps `/speech voice-add` focused on actual
 * reference samples.
 */
export async function synthesizeSpeechViaTtsVoiceDesign(request: TtsVoiceDesignRequest): Promise<TtsCloneResult> {
  const { endpoint, script, designPrompt, voiceInstructions, apiKey } = request;
  const scriptMarkup = (endpoint.extra_config.script_markup as string | undefined) ?? "plain";
  const { processedScript, captionText } = prepareVoiceDesignText(script, scriptMarkup);
  const cleanedDesignPrompt = designPrompt.trim();
  const cleanedVoiceInstructions = voiceInstructions?.trim() ?? "";

  if (!processedScript) {
    return {
      success: false,
      errorKind: "invalid_request",
      details: "Voice script was empty after removing unsupported markup.",
    };
  }

  if (!cleanedDesignPrompt) {
    return {
      success: false,
      errorKind: "invalid_request",
      details: "Voice design prompt is empty.",
    };
  }

  const instruct = cleanedVoiceInstructions
    ? `${cleanedDesignPrompt}\n\nFor this message only: ${cleanedVoiceInstructions}`
    : cleanedDesignPrompt;
  const body: Record<string, unknown> = {
    text: processedScript,
    // VoiceDesign requests deliberately omit ref_audio/ref_text. Some FastAPI
    // wrappers type those fields as optional strings but still reject explicit
    // JSON null, and omitting unused clone fields makes the request shape the
    // server's auto mode can reliably distinguish from voice cloning.
    instruct,
  };

  const endpointUrl = endpoint.endpoint_url.replace(/\/+$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  let response: Response;
  const requestStartedAt = Date.now();
  log.info(
    `[TtsVoiceDesign] Sending /synthesize | endpoint="${endpoint.model_name || endpoint.label}" label="${endpoint.label}" url="${endpointUrl}" mode=${getTtsVoiceMode(endpoint)} scriptChars=${processedScript.length} instructChars=${instruct.length} oneOffInstructionChars=${cleanedVoiceInstructions.length} timeoutMs=${TTS_SYNTHESIZE_TIMEOUT_MS} payloadLog=${TTS_VOICE_DESIGN_LOG_PAYLOADS ? "full" : "preview"}`,
  );
  log.info(
    `[TtsVoiceDesign] Script ${TTS_VOICE_DESIGN_LOG_PAYLOADS ? "full" : "preview"}: ${previewForLog(processedScript)}`,
  );
  log.info(
    `[TtsVoiceDesign] Instruct ${TTS_VOICE_DESIGN_LOG_PAYLOADS ? "full" : "preview"}: ${previewForLog(instruct)}`,
  );

  try {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), TTS_SYNTHESIZE_TIMEOUT_MS);
    try {
      response = await fetchUserRemoteUrl(`${endpointUrl}/synthesize`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: abortController.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === "AbortError";
    const elapsedMs = Date.now() - requestStartedAt;
    log.warn(
      `[TtsVoiceDesign] Request to ${endpointUrl}/synthesize ${isTimeout ? "timed out" : "failed"} after ${elapsedMs}ms`,
      error,
    );
    return {
      success: false,
      errorKind: (isTimeout ? "timeout" : "request_failed") satisfies TtsCloneErrorKind,
      details: error instanceof Error ? error.message : String(error),
    };
  }

  if (!response.ok) {
    let errorDetails = `HTTP ${response.status}`;
    try {
      const errorBody = (await response.json()) as { error?: unknown; detail?: unknown };
      const structuredDetail = stringifyErrorDetail(errorBody.error ?? errorBody.detail);
      if (structuredDetail) errorDetails += `: ${structuredDetail}`;
    } catch {}
    log.warn(`[TtsVoiceDesign] ${endpointUrl}/synthesize returned error: ${errorDetails}`);
    return { success: false, errorKind: "request_failed", details: errorDetails };
  }
  log.info(
    `[TtsVoiceDesign] /synthesize responded status=${response.status} contentType="${response.headers.get("content-type") ?? "unknown"}" elapsedMs=${Date.now() - requestStartedAt}`,
  );

  const rawContentType = response.headers.get("content-type") ?? "audio/wav";
  const contentType = rawContentType.split(";")[0].trim();

  if (!contentType.startsWith("audio/")) {
    log.warn(`[TtsVoiceDesign] Unexpected content-type from /synthesize: ${rawContentType}`);
    return {
      success: false,
      errorKind: "invalid_response",
      details: `Expected audio/* content-type, got: ${rawContentType}`,
    };
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  if (audioBuffer.length === 0) {
    return { success: false, errorKind: "invalid_response", details: "Empty audio response from TTS server." };
  }

  return {
    success: true,
    audioBuffer,
    contentType,
    extension: resolveExtensionFromContentType(contentType),
    cleanedCaptionText: captionText,
  };
}
