import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { parseBuffer } from "music-metadata";
import { deleteVoiceSample, insertVoiceSample, updateVoiceSamplePath } from "@/utils/db/repositories/SpeechRepository";
import { log } from "@/utils/misc/logger";
import { safeDownload, type SafeDownloadResult } from "@/utils/security/safeDownload";
import { storeVoiceSample } from "@/utils/storage/voiceSampleStorage";

/** Default max upload size in MB (overridden by SPEECH_SAMPLE_MAX_MB env var). */
export const SPEECH_SAMPLE_MAX_MB = Math.max(1, Number.parseInt(process.env.SPEECH_SAMPLE_MAX_MB ?? "10", 10) || 10);

/** Maximum allowed clip duration in seconds. */
export const SPEECH_SAMPLE_MAX_DURATION_SECS = 30;

/** Accepted audio MIME types and file extensions for reference samples. */
const ACCEPTED_MIME_TYPES = new Set([
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/ogg",
  "audio/opus",
  "audio/flac",
  "audio/x-flac",
  "audio/m4a",
  "audio/mp4",
  "audio/aac",
]);
const ACCEPTED_EXTENSION_REGEX = /\.(wav|mp3|ogg|opus|flac|m4a|aac)$/i;

export interface VoiceSampleUpload {
  url: string;
  filename: string | null | undefined;
  contentType: string | null | undefined;
  size: number;
}

export type VoiceSampleUploadValidation = "ok" | "invalid-format" | "too-large";

export function isAcceptedAudioFile(mimeType: string | null | undefined, filename: string | null | undefined): boolean {
  const mime = mimeType?.toLowerCase().split(";")[0].trim() ?? "";
  if (ACCEPTED_MIME_TYPES.has(mime)) return true;
  return ACCEPTED_EXTENSION_REGEX.test(filename ?? "");
}

export function validateVoiceSampleUpload(upload: VoiceSampleUpload): VoiceSampleUploadValidation {
  if (!isAcceptedAudioFile(upload.contentType, upload.filename)) return "invalid-format";
  if (upload.size > SPEECH_SAMPLE_MAX_MB * 1024 * 1024) return "too-large";
  return "ok";
}

class FfmpegSpawnError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "FfmpegSpawnError";
  }
}

async function spawnFfmpeg(binary: string, tmpIn: string, tmpOut: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(binary, ["-y", "-i", tmpIn, "-ar", "22050", "-ac", "1", "-f", "wav", tmpOut]);
    proc.on("error", (err) => reject(new FfmpegSpawnError(err)));
    proc.on("close", (code: number | null) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

/**
 * Converts an audio buffer to mono WAV at 22050 Hz.
 * Tries the bundled ffmpeg-static binary first and retries system ffmpeg only when spawning fails.
 */
export async function normalizeVoiceSampleToWav(inputBuffer: Buffer): Promise<Buffer> {
  const suffix = Date.now();
  const tmpIn = path.join(os.tmpdir(), `tts-in-${suffix}`);
  const tmpOut = path.join(os.tmpdir(), `tts-out-${suffix}.wav`);

  await fs.writeFile(tmpIn, inputBuffer);

  try {
    const primaryBinary = ffmpegPath ?? "ffmpeg";
    try {
      await spawnFfmpeg(primaryBinary, tmpIn, tmpOut);
    } catch (err) {
      if (err instanceof FfmpegSpawnError && primaryBinary !== "ffmpeg") {
        log.warn("[VoiceAdd] ffmpeg-static failed to spawn, retrying with system ffmpeg", err);
        await spawnFfmpeg("ffmpeg", tmpIn, tmpOut);
      } else {
        throw err;
      }
    }

    return await fs.readFile(tmpOut);
  } finally {
    await Promise.all([
      fs.unlink(tmpIn).catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT")
          log.warn("[VoiceAdd] Failed to delete temp input file", err);
      }),
      fs.unlink(tmpOut).catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT")
          log.warn("[VoiceAdd] Failed to delete temp output file", err);
      }),
    ]);
  }
}

export interface VoiceSampleAddDependencies {
  safeDownload: (url: string, options: Parameters<typeof safeDownload>[1]) => Promise<SafeDownloadResult>;
  parseDuration: (buffer: Buffer, mimeType: string | null | undefined) => Promise<number>;
  normalizeToWav: (buffer: Buffer) => Promise<Buffer>;
  insertVoiceSample: typeof insertVoiceSample;
  storeVoiceSample: typeof storeVoiceSample;
  updateVoiceSamplePath: typeof updateVoiceSamplePath;
  deleteVoiceSample: typeof deleteVoiceSample;
}

const defaultDependencies: VoiceSampleAddDependencies = {
  safeDownload,
  parseDuration: async (buffer, mimeType) => {
    const metadata = await parseBuffer(buffer, { mimeType: mimeType ?? undefined });
    return metadata.format.duration ?? 0;
  },
  normalizeToWav: normalizeVoiceSampleToWav,
  insertVoiceSample,
  storeVoiceSample,
  updateVoiceSamplePath,
  deleteVoiceSample,
};

export type VoiceSampleAddResult =
  | { status: "invalid-format" }
  | { status: "too-large" }
  | { status: "download-failed" }
  | { status: "too-long"; limitSecs: number }
  | { status: "normalization-failed" }
  | { status: "write-failed" }
  | {
      status: "success";
      sampleId: number;
      durationSecs: number;
      durationMs: number;
      refText: string | null;
    };

export interface VoiceSampleAddInput {
  serverId: number;
  upload: VoiceSampleUpload;
  sampleName: string;
  refText: string | null;
}

export async function addVoiceSample(
  input: VoiceSampleAddInput,
  deps: VoiceSampleAddDependencies = defaultDependencies,
): Promise<VoiceSampleAddResult> {
  const validation = validateVoiceSampleUpload(input.upload);
  if (validation !== "ok") return { status: validation };

  const downloadResult = await deps.safeDownload(input.upload.url, {
    maxSizeMB: SPEECH_SAMPLE_MAX_MB,
    timeoutMs: 30_000,
    knownSize: input.upload.size,
  });
  if (!downloadResult.success || !downloadResult.buffer) return { status: "download-failed" };

  const rawBuffer = downloadResult.buffer;
  let durationSecs = 0;
  try {
    durationSecs = await deps.parseDuration(rawBuffer, input.upload.contentType);
  } catch {
    log.warn("[VoiceAdd] music-metadata failed to parse duration; accepting without validation");
  }

  if (durationSecs > 0 && durationSecs > SPEECH_SAMPLE_MAX_DURATION_SECS) {
    return { status: "too-long", limitSecs: SPEECH_SAMPLE_MAX_DURATION_SECS };
  }

  let wavBuffer: Buffer;
  try {
    wavBuffer = await deps.normalizeToWav(rawBuffer);
  } catch (error) {
    log.warn("[VoiceAdd] WAV normalization failed", error);
    return { status: "normalization-failed" };
  }

  if (wavBuffer.length < 4 || wavBuffer.subarray(0, 4).toString("ascii") !== "RIFF") {
    log.warn("[VoiceAdd] Post-normalization buffer is not a valid WAV file (missing RIFF header)");
    return { status: "normalization-failed" };
  }

  const durationMs = Math.round(durationSecs * 1000);
  const sampleId = await deps.insertVoiceSample(input.serverId, input.sampleName, input.refText, durationMs);
  if (!sampleId) return { status: "write-failed" };

  const storedReference = await deps.storeVoiceSample({
    serverId: input.serverId,
    sampleId,
    buffer: wavBuffer,
  });
  if (!storedReference) {
    await deps
      .deleteVoiceSample(sampleId)
      .catch((err: unknown) => log.warn("[VoiceAdd] Failed to delete voice sample record after storage failure", err));
    return { status: "write-failed" };
  }

  await deps.updateVoiceSamplePath(sampleId, storedReference);
  return { status: "success", sampleId, durationSecs, durationMs, refText: input.refText };
}
