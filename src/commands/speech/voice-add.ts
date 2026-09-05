import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { MessageFlags } from "discord.js";
import ffmpegPath from "ffmpeg-static";
import { parseBuffer } from "music-metadata";
import { log, ColorCode } from "@/utils/misc/logger";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { ensureSpeechCommandAccess } from "@/utils/discord/speechPermission";
import { safeDownload } from "@/utils/security/safeDownload";
import { storeVoiceSample } from "@/utils/storage/voiceSampleStorage";
import { insertVoiceSample, updateVoiceSamplePath, deleteVoiceSample } from "@/utils/db/repositories/SpeechRepository";
import { serverRepository } from "@/utils/db/repositories/ServerRepository";
import type { ErrorContext, UserRow } from "@/types/db/schema";
import { localizer } from "@/utils/text/localizer";

/** Default max upload size in MB (overridden by SPEECH_SAMPLE_MAX_MB env var). */
const SPEECH_SAMPLE_MAX_MB = Math.max(1, Number.parseInt(process.env.SPEECH_SAMPLE_MAX_MB ?? "10", 10) || 10);

/** Maximum allowed clip duration in seconds. */
const SPEECH_SAMPLE_MAX_DURATION_SECS = 30;

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

/** Thrown when an ffmpeg binary cannot be spawned (missing, wrong architecture, no execute permission). */
class FfmpegSpawnError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "FfmpegSpawnError";
  }
}

async function spawnFfmpeg(binary: string, tmpIn: string, tmpOut: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(binary, ["-y", "-i", tmpIn, "-ar", "22050", "-ac", "1", "-f", "wav", tmpOut]);
    // Wrap OS-level spawn failures separately so the caller can retry with a different binary.
    proc.on("error", (err) => reject(new FfmpegSpawnError(err)));
    proc.on("close", (code: number | null) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

/**
 * Converts an audio buffer to mono WAV at 22050 Hz.
 * Tries the bundled ffmpeg-static binary first; if it cannot be spawned
 * (e.g. glibc/musl mismatch on Alpine), retries with the system `ffmpeg` command.
 * Conversion errors (bad input audio) are NOT retried.
 */
async function normalizeToWav(inputBuffer: Buffer): Promise<Buffer> {
  const suffix = Date.now();
  const tmpIn = path.join(os.tmpdir(), `tts-in-${suffix}`);
  const tmpOut = path.join(os.tmpdir(), `tts-out-${suffix}.wav`);

  await fs.writeFile(tmpIn, inputBuffer);

  try {
    const primaryBinary = ffmpegPath ?? "ffmpeg";
    try {
      await spawnFfmpeg(primaryBinary, tmpIn, tmpOut);
    } catch (err) {
      // Only retry on spawn failure (binary can't run), not on bad-input errors.
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
        // tmpOut may not exist if transcoding failed before producing output
        if ((err as NodeJS.ErrnoException).code !== "ENOENT")
          log.warn("[VoiceAdd] Failed to delete temp output file", err);
      }),
    ]);
  }
}

function isAcceptedAudioFile(mimeType: string | null | undefined, filename: string | null | undefined): boolean {
  const mime = mimeType?.toLowerCase().split(";")[0].trim() ?? "";
  if (ACCEPTED_MIME_TYPES.has(mime)) return true;
  return ACCEPTED_EXTENSION_REGEX.test(filename ?? "");
}

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("voice-add")
    .setDescription(localizer("en-US", "commands.config.panel.voices.add.description"))
    .addAttachmentOption((option) =>
      option
        .setName("audio_file")
        .setDescription(localizer("en-US", "commands.config.panel.voices.add.audio_file_description"))
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription(localizer("en-US", "commands.config.panel.voices.add.name_description"))
        .setRequired(true)
        .setMaxLength(80),
    )
    .addStringOption((option) =>
      option
        .setName("ref_text")
        .setDescription(localizer("en-US", "commands.config.panel.voices.add.ref_text_description"))
        .setRequired(false)
        .setMaxLength(500),
    );

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!(await ensureSpeechCommandAccess(interaction, locale))) {
    return;
  }

  if (!interaction.channel) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.channel_only_title",
      descriptionKey: "general.errors.channel_only_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const attachment = interaction.options.getAttachment("audio_file", true);
  const sampleName = interaction.options.getString("name", true).trim();
  const refText = interaction.options.getString("ref_text")?.trim() || null;

  // Pre-flight format check (before deferring, within the 3 s window).
  if (!isAcceptedAudioFile(attachment.contentType, attachment.name)) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.config.panel.voices.add.format_error_title",
      descriptionKey: "commands.config.panel.voices.add.format_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (attachment.size > SPEECH_SAMPLE_MAX_MB * 1024 * 1024) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.config.panel.voices.add.size_error_title",
      descriptionKey: "commands.config.panel.voices.add.size_error_description",
      descriptionVars: { limit_mb: String(SPEECH_SAMPLE_MAX_MB) },
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const serverId = await serverRepository.loadServerIdByDiscId(interaction.guild?.id ?? interaction.user.id);
  if (!serverId) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.tomori_not_setup_title",
      descriptionKey: "general.errors.tomori_not_setup_description",
      color: ColorCode.ERROR,
    });
    return;
  }

  try {
    const downloadResult = await safeDownload(attachment.url, {
      maxSizeMB: SPEECH_SAMPLE_MAX_MB,
      timeoutMs: 30_000,
      knownSize: attachment.size,
    });
    if (!downloadResult.success || !downloadResult.buffer) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.update_failed_title",
        descriptionKey: "general.errors.update_failed_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const rawBuffer = downloadResult.buffer;

    let durationSecs = 0;
    try {
      const metadata = await parseBuffer(rawBuffer, {
        mimeType: attachment.contentType ?? undefined,
      });
      durationSecs = metadata.format.duration ?? 0;
    } catch {
      log.warn("[VoiceAdd] music-metadata failed to parse duration; accepting without validation");
    }

    if (durationSecs > 0 && durationSecs > SPEECH_SAMPLE_MAX_DURATION_SECS) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.config.panel.voices.add.duration_error_title",
        descriptionKey: "commands.config.panel.voices.add.duration_error_description",
        descriptionVars: { limit_secs: String(SPEECH_SAMPLE_MAX_DURATION_SECS) },
        color: ColorCode.ERROR,
      });
      return;
    }

    // Normalize to WAV for consistent base64 encoding in the TTS adapter.
    let wavBuffer: Buffer;
    try {
      wavBuffer = await normalizeToWav(rawBuffer);
    } catch (error) {
      log.warn("[VoiceAdd] WAV normalization failed", error);
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.config.panel.voices.add.normalization_error_title",
        descriptionKey: "commands.config.panel.voices.add.normalization_error_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    // Guard: verify the output is actually a WAV file (starts with "RIFF" magic bytes).
    // If ffmpeg silently produced garbage, reject early rather than sending broken audio to the TTS server.
    if (wavBuffer.length < 4 || wavBuffer.subarray(0, 4).toString("ascii") !== "RIFF") {
      log.warn("[VoiceAdd] Post-normalization buffer is not a valid WAV file (missing RIFF header)");
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.config.panel.voices.add.normalization_error_title",
        descriptionKey: "commands.config.panel.voices.add.normalization_error_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const durationMs = Math.round(durationSecs * 1000);

    // Insert a placeholder row to reserve a sample_id, then update with the real storage reference.
    const sampleId = await insertVoiceSample(serverId, sampleName, refText, durationMs);
    if (!sampleId) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.update_failed_title",
        descriptionKey: "general.errors.update_failed_description",
        color: ColorCode.ERROR,
      });
      return;
    }
    const storedReference = await storeVoiceSample({
      serverId,
      sampleId,
      buffer: wavBuffer,
    });
    if (!storedReference) {
      await deleteVoiceSample(sampleId).catch((err: unknown) =>
        log.warn("[VoiceAdd] Failed to delete voice sample record after storage failure", err),
      );
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.update_failed_title",
        descriptionKey: "general.errors.update_failed_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    await updateVoiceSamplePath(sampleId, storedReference);

    const durationDisplay = durationSecs > 0 ? `${Math.floor(durationSecs)}s` : localizer(locale, "general.unknown");

    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.config.panel.voices.add.success_title",
      descriptionKey: "commands.config.panel.voices.add.success_description",
      descriptionVars: {
        name: sampleName,
        duration: durationDisplay,
        ref_text_hint: refText
          ? localizer(locale, "commands.config.panel.voices.add.ref_text_provided")
          : localizer(locale, "commands.config.panel.voices.add.ref_text_missing"),
      },
      color: ColorCode.SUCCESS,
    });

    log.info(
      `[VoiceAdd] Uploaded sample "${sampleName}" (id=${sampleId}) for server ${serverId} | ${durationMs}ms | ref_text=${refText ? "yes" : "no"}`,
    );
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId,
      errorType: "CommandExecutionError",
      metadata: {
        command: "speech voice-add",
        guildId: interaction.guild?.id,
        executorDiscordId: interaction.user.id,
      },
    };
    await log.error("Error executing /speech voice-add", error as Error, context);
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
    });
  }
}
