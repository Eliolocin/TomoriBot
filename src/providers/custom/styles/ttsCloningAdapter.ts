import { log } from "@/utils/misc/logger";
import type { CustomEndpointRow } from "@/types/db/schema";
import { stripElevenLabsExpressionTags } from "@/utils/audio/elevenLabsShared";
import { loadStoredVoiceSampleBuffer } from "@/utils/storage/voiceSampleStorage";
import { fetchUserRemoteUrl } from "@/utils/security/userRemoteFetch";
import { stripTtsUnsupportedEmojiAttempts } from "@/utils/text/emojiHelper";
import { loadVoiceSampleById } from "@/utils/db/repositories/SpeechRepository";
import { resolveTtsSynthesizeTimeoutMs } from "@/providers/custom/styles/ttsSynthesizeTimeout";

/** Timeout for local /synthesize requests, configurable via env. */
const TTS_SYNTHESIZE_TIMEOUT_MS = resolveTtsSynthesizeTimeoutMs();

/** Regex matching any bracket-tag in the form [content]. */
const ANY_BRACKET_TAG_REGEX = /\[([^\]\r\n]{1,40})\]/g;
const CHATTERBOX_TURBO_TAGS = new Set([
  "clear throat",
  "sigh",
  "shush",
  "cough",
  "groan",
  "sniff",
  "gasp",
  "chuckle",
  "laugh",
]);

export type TtsCloneErrorKind =
  | "invalid_request"
  | "missing_sample"
  | "sample_read_failed"
  | "request_failed"
  | "timeout"
  | "invalid_response";

export interface TtsCloneResult {
  success: boolean;
  audioBuffer?: Buffer;
  /** Bare MIME type (no parameters), e.g. "audio/wav". */
  contentType?: string;
  extension?: string;
  /** Script text with markup stripped, suitable for transcript display. */
  cleanedCaptionText?: string;
  errorKind?: TtsCloneErrorKind;
  details?: string;
}

export interface TtsCloneRequest {
  endpoint: CustomEndpointRow;
  voiceSampleId: number;
  script: string;
  /** Optional one-off delivery instruction for endpoints that advertise instruct support. */
  instruct?: string;
  /** Empty string for local endpoints that don't require auth. */
  apiKey: string;
  chatterbox?: {
    turboEnabled: boolean;
    cfgWeight: number;
    exaggeration: number;
  };
}

function resolveExtensionFromContentType(contentType: string): string {
  const bare = contentType.split(";")[0].trim().toLowerCase();
  if (bare === "audio/wav" || bare === "audio/wave" || bare === "audio/x-wav") return "wav";
  if (bare === "audio/ogg" || bare === "audio/opus") return "ogg";
  return "mp3";
}

/**
 * Strips all bracket tags for "plain" endpoints that only support clean speech text.
 * Normalises whitespace produced by the removals.
 */
function stripAllBracketTags(text: string): string {
  return text
    .replace(ANY_BRACKET_TAG_REGEX, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[^\S\n]+/g, " ")
    .trim();
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

function stripUnsupportedChatterboxTurboTags(text: string): string {
  return normalizeTtsWhitespace(
    text.replace(ANY_BRACKET_TAG_REGEX, (match, rawTag: string) => {
      const normalizedTag = rawTag.trim().toLowerCase();
      return CHATTERBOX_TURBO_TAGS.has(normalizedTag) ? match : "";
    }),
  );
}

function isIrodoriTtsEndpoint(endpoint: CustomEndpointRow): boolean {
  return [endpoint.label, endpoint.model_name, endpoint.endpoint_url].some((value) =>
    value?.toLowerCase().includes("irodori"),
  );
}

/**
 * Label sniff for Chatterbox deployments, mirroring `isIrodoriTtsEndpoint`.
 *
 * The endpoint schema carries no engine identifier, so the only available signal is what the
 * server manager typed into `/config`. Callers that expose a Chatterbox-only control gate on
 * this: a control that silently changes nothing is worse than an absent one, and the absence
 * is recoverable by renaming the endpoint.
 */
export function isChatterboxEndpoint(endpoint: CustomEndpointRow | null | undefined): boolean {
  if (!endpoint) return false;
  return [endpoint.label, endpoint.model_name, endpoint.endpoint_url].some((value) =>
    value?.toLowerCase().includes("chatterbox"),
  );
}

export interface TtsCloneBufferRequest {
  endpoint: CustomEndpointRow;
  /** Reference audio bytes, already normalized by the caller. */
  refAudio: Buffer;
  refText: string | null;
  script: string;
  /** Optional one-off delivery instruction for endpoints that advertise instruct support. */
  instruct?: string;
  /** Empty string for local endpoints that don't require auth. */
  apiKey: string;
  chatterbox?: {
    turboEnabled: boolean;
    cfgWeight: number;
    exaggeration: number;
  };
}

/** Builds the provider-neutral body sent to a local clone sidecar. */
export function buildTtsCloneRequestBody(input: {
  processedScript: string;
  refAudio: Buffer;
  refText: string | null;
  instruct?: string;
  supportsInstruct: boolean;
  chatterbox?: TtsCloneBufferRequest["chatterbox"];
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    text: input.processedScript,
    ref_audio: input.refAudio.toString("base64"),
    ref_text: input.refText,
    language: null,
  };

  if (input.chatterbox) {
    body.chatterbox_turbo = input.chatterbox.turboEnabled;
    body.cfg_weight = input.chatterbox.cfgWeight;
    body.exaggeration = input.chatterbox.exaggeration;
  }

  if (input.supportsInstruct) {
    body.instruct = input.instruct?.trim() || null;
  }

  return body;
}

/**
 * Calls a local TTS clone server with reference audio supplied directly.
 *
 * This is the core path: `/generate voice-message` synthesizes from an ad-hoc upload that has
 * no `voice_samples` row, so it cannot go through the sample-loading wrapper below.
 *
 * 1. Strips markup from script according to the endpoint's `script_markup`.
 * 2. POSTs to {endpoint_url}/synthesize with the base64 reference audio.
 * 3. Returns the raw audio buffer and content-type.
 */
export async function synthesizeSpeechViaTtsCloneBuffer(request: TtsCloneBufferRequest): Promise<TtsCloneResult> {
  const { endpoint, refAudio, refText, script, instruct, apiKey, chatterbox } = request;

  const scriptMarkup = (endpoint.extra_config.script_markup as string | undefined) ?? "plain";
  const supportsInstruct = Boolean(endpoint.extra_config.supports_instruct);
  const preserveUnicodeEmojis = scriptMarkup === "emoji" || isIrodoriTtsEndpoint(endpoint);

  // Prepare script: strip all bracket tags for "plain" endpoints and
  //    standard Chatterbox, because only Turbo handles bracket descriptors.
  //    Turbo gets a conservative whitelist so unsupported bracket text is not spoken aloud.
  //    For other bracket-tags/emoji endpoints, strip only for the caption text.
  let processedScript: string;
  let captionText: string;
  const shouldStripBracketTagsForTts = scriptMarkup === "plain" || chatterbox?.turboEnabled === false;
  if (shouldStripBracketTagsForTts) {
    processedScript = stripAllBracketTags(script);
    captionText = processedScript;
  } else if (chatterbox?.turboEnabled === true) {
    processedScript = stripUnsupportedChatterboxTurboTags(script);
    captionText = stripElevenLabsExpressionTags(processedScript);
  } else {
    processedScript = script;
    captionText = stripElevenLabsExpressionTags(script);
  }

  processedScript = stripTtsUnsupportedEmojiAttempts(processedScript, { preserveUnicodeEmojis });
  captionText = stripTtsUnsupportedEmojiAttempts(captionText, { preserveUnicodeEmojis });

  if (!processedScript) {
    return {
      success: false,
      errorKind: "invalid_request",
      details: "Voice script was empty after removing unsupported emoji markup.",
    };
  }

  const body = buildTtsCloneRequestBody({
    processedScript,
    refAudio,
    refText,
    instruct,
    supportsInstruct,
    chatterbox,
  });

  const endpointUrl = endpoint.endpoint_url.replace(/\/+$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  let response: Response;
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
    log.warn(`[TtsClone] Request to ${endpointUrl}/synthesize ${isTimeout ? "timed out" : "failed"}`, error);
    return {
      success: false,
      errorKind: isTimeout ? "timeout" : "request_failed",
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
    log.warn(`[TtsClone] ${endpointUrl}/synthesize returned error: ${errorDetails}`);
    return { success: false, errorKind: "request_failed", details: errorDetails };
  }

  const rawContentType = response.headers.get("content-type") ?? "audio/wav";
  // Bare MIME type only: Discord rejects waveform metadata for non-bare types.
  const contentType = rawContentType.split(";")[0].trim();

  if (!contentType.startsWith("audio/")) {
    log.warn(`[TtsClone] Unexpected content-type from /synthesize: ${rawContentType}`);
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

/**
 * Calls a local TTS clone server that implements the /synthesize spec.
 *
 * 1. Loads voice sample metadata from DB.
 * 2. Reads the WAV file from disk and base64-encodes it.
 * 3. Strips markup from script if script_markup = "plain".
 * 4. POSTs to {endpoint_url}/synthesize.
 * 5. Returns the raw audio buffer and content-type.
 */
export async function synthesizeSpeechViaTtsClone(request: TtsCloneRequest): Promise<TtsCloneResult> {
  const { endpoint, voiceSampleId, script, instruct, apiKey, chatterbox } = request;

  const voiceSample = await loadVoiceSampleById(voiceSampleId);

  if (!voiceSample) {
    log.warn(`[TtsClone] Voice sample ${voiceSampleId} not found in DB`);
    return {
      success: false,
      errorKind: "missing_sample",
      details: `Voice sample ${voiceSampleId} not found in database.`,
    };
  }

  const sample = voiceSample;

  const refAudioBuffer = await loadStoredVoiceSampleBuffer(sample.file_path);
  if (!refAudioBuffer) {
    log.warn(`[TtsClone] Failed to read voice sample ${voiceSampleId} from ${sample.file_path}`);
    return {
      success: false,
      errorKind: "sample_read_failed",
      details: `Could not read voice sample ${voiceSampleId} from storage.`,
    };
  }

  return synthesizeSpeechViaTtsCloneBuffer({
    endpoint,
    refAudio: refAudioBuffer,
    refText: sample.ref_text ?? null,
    script,
    instruct,
    apiKey,
    ...(chatterbox ? { chatterbox } : {}),
  });
}
