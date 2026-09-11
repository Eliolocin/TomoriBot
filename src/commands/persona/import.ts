/**
 * Preset Import Command
 * Imports TomoriBot's personality from a PNG or JSON file
 */

import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { MessageFlags, EmbedBuilder, AttachmentBuilder } from "discord.js";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import { replyInfoEmbed } from "../../utils/discord/interactionHelper";
import type { PersonaSpriteRow, UserRow } from "../../types/db/schema";
import { memoryGuard, IMPORT_LIMITS, reserveImportQuota } from "../../utils/security/rateLimiter";
import { invalidateTomoriStateCache } from "../../utils/cache/tomoriStateCache";
import { presetRepository } from "@/utils/db/repositories/PresetRepository";
import type { PresetExportData } from "../../types/preset/presetExport";
import { extractMetadataFromPNG, extractSillyTavernMetadataFromPNG } from "../../utils/image/pngMetadata";
import { validatePNGBuffer } from "../../utils/image/avatarHelper";
import { personaRepository } from "@/utils/db/repositories";
import { sanitizeAttachmentFilenamePart } from "@/utils/discord/attachmentFilename";
import { safeDownload } from "@/utils/security/safeDownload";
import { dedupeTriggerWords, parseTriggerWordListInput } from "@/utils/text/triggerWords";
import { uploadPersonaAvatarToStorage } from "../../utils/storage/avatarStorage";
import { isAvatarUpdateRateLimited } from "@/utils/discord/avatarRateLimit";
import { importAlterPreset } from "@/utils/persona/importAlterPreset";
import { readCharxCard, type CharxReadFailureReason } from "@/utils/persona/charxArchive";
import {
  cleanupMainPersonaSpritesAfterImport,
  snapshotMainPersonaSprites,
} from "@/utils/persona/mainImportSpriteCleanup";

/** Maximum file size for imports (uses centralized constant). */
const MAX_FILE_SIZE = IMPORT_LIMITS.MAX_PERSONA_IMPORT_SIZE_MB * 1024 * 1024;
/** Byte budget for the `card.json` payload the archive reader will decompress. */
const MAX_CHARX_CARD_BYTES = IMPORT_LIMITS.MAX_CHARX_CARD_SIZE_MB * 1024 * 1024;
const MAX_CHARX_ASSET_TOTAL_BYTES = IMPORT_LIMITS.MAX_CHARX_ASSET_TOTAL_MB * 1024 * 1024;
const MAX_SILLY_TAVERN_DEBUG_BYTES = 1_000_000;

type PersonaImportSource = "tomori-png" | "tomori-json" | "sillytavern-png" | "sillytavern-json" | "charx";

type ResolvedImportFile = {
  avatarImageBuffer: Buffer | null;
  presetData: PresetExportData;
  source: PersonaImportSource;
  /**
   * Embedded assets the archive carried but the import does not read. Reported
   * in the success embed so the omission is stated rather than discovered.
   */
  ignoredAssetCount?: number;
  /**
   * Card fields the conversion had no destination for. Carried to the single
   * convergence point below so every converter path reports its losses the same
   * way, rather than only the path that happened to be written last.
   */
  unmappedCardFields?: string | null;
};

function truncateBufferForAttachment(buffer: Buffer, maxBytes: number, noticeText: string): Buffer {
  if (buffer.length <= maxBytes) {
    return buffer;
  }

  const notice = Buffer.from(noticeText, "utf8");
  const safeMax = Math.max(maxBytes - notice.length, 0);
  return Buffer.concat([buffer.subarray(0, safeMax), notice]);
}

function buildSillyTavernDebugText(options: {
  conversionError?: string;
  decodedFromBase64?: boolean;
  decodedValueLength?: number;
  metadataKey?: string;
  parsedJson: unknown;
  rawValueLength?: number;
  sourceLabel: string;
}): string {
  const parsedPretty = JSON.stringify(options.parsedJson, null, 2) ?? String(options.parsedJson);
  const parsedRootKeys =
    options.parsedJson && typeof options.parsedJson === "object" && !Array.isArray(options.parsedJson)
      ? Object.keys(options.parsedJson as Record<string, unknown>)
      : [];

  return [
    "TomoriBot Persona Import - SillyTavern Debug Decode",
    `Source: ${options.sourceLabel}`,
    ...(options.metadataKey ? [`Detected metadata key: ${options.metadataKey}`] : []),
    ...(typeof options.decodedFromBase64 === "boolean"
      ? [`Decoded from base64: ${options.decodedFromBase64 ? "yes" : "no"}`]
      : []),
    ...(options.conversionError
      ? [`Conversion error: ${options.conversionError}`]
      : ["Conversion error: (none - decode only mode)"]),
    ...(typeof options.rawValueLength === "number" ? [`Raw metadata length: ${options.rawValueLength}`] : []),
    ...(typeof options.decodedValueLength === "number" ? [`Decoded text length: ${options.decodedValueLength}`] : []),
    `Parsed root keys: ${parsedRootKeys.length > 0 ? parsedRootKeys.join(", ") : "(none/object not detected)"}`,
    "",
    "=== Parsed JSON ===",
    parsedPretty,
  ].join("\n");
}

function parseJsonAttachment(buffer: Buffer): unknown {
  const rawText = buffer
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trim();
  return JSON.parse(rawText);
}

function parseCommaSeparatedTriggers(input: string): string[] {
  return parseTriggerWordListInput(input, { lowercase: false });
}

/**
 * Replies when a card was decoded but could not be converted.
 *
 * Shared by all three card formats so the reply, the attachment name, and the
 * prose stay identical across them. `sourceLabel` naming where the payload came
 * from is what distinguishes the three, and it is the operator-facing half of
 * the reply, so the visible text is localized like every other reply.
 */
async function replyCardConversionFailure(options: {
  interaction: ChatInputCommandInteraction;
  locale: string;
  parsedJson: unknown;
  conversionError: string;
  sourceLabel: string;
  attachmentName: string;
  debugContext?: {
    metadataKey: string;
    rawValueLength: number;
    decodedValueLength: number;
    decodedFromBase64: boolean;
  };
}): Promise<void> {
  const debugText = buildSillyTavernDebugText({
    conversionError: options.conversionError,
    parsedJson: options.parsedJson,
    sourceLabel: options.sourceLabel,
    ...options.debugContext,
  });
  const debugBuffer = truncateBufferForAttachment(
    Buffer.from(debugText, "utf8"),
    MAX_SILLY_TAVERN_DEBUG_BYTES,
    "\n\n[Truncated: decoded payload exceeded attachment size budget.]",
  );
  const debugFilename = `${options.attachmentName}-${Date.now()}.txt`;

  await options.interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(localizer(options.locale, "commands.persona.import.card_conversion_failed_title"))
        .setDescription(
          localizer(options.locale, "commands.persona.import.card_conversion_failed_description", {
            source: options.sourceLabel,
          }),
        )
        .setColor(ColorCode.WARN),
    ],
    files: [new AttachmentBuilder(debugBuffer, { name: debugFilename })],
  });
}

/**
 * Maps a `.charx` container failure to its reply text.
 *
 * The two unreadable-container reasons share one message: from the reader's
 * side they are the same problem, and the distinction is a detail of the zip.
 */
function localizeCharxFailure(locale: string, reason: CharxReadFailureReason): string {
  switch (reason) {
    case "invalid_zip":
    case "missing_card":
    case "invalid_card":
      return localizer(locale, "commands.persona.import.invalid_charx_description");
    case "not_character_card":
      return localizer(locale, "commands.persona.import.charx_not_card_description");
    case "card_too_large":
      return localizer(locale, "commands.persona.import.charx_too_large_description", {
        max_size: IMPORT_LIMITS.MAX_CHARX_CARD_SIZE_MB,
      });
    case "assets_too_large":
      return localizer(locale, "commands.persona.import.charx_assets_too_large_description");
  }
}

/** Replies with the `.charx` container failure that stopped the import. */
async function replyInvalidCharx(
  interaction: ChatInputCommandInteraction,
  locale: string,
  reason: CharxReadFailureReason,
): Promise<void> {
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(localizer(locale, "commands.persona.import.invalid_charx_title"))
        .setDescription(localizeCharxFailure(locale, reason))
        .setColor(ColorCode.ERROR),
    ],
  });
}

/** Narrows an unknown value to a plain object, or null. */
function asPlainObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** True when the field holds non-blank text. */
function hasText(container: Record<string, unknown>, key: string): boolean {
  const value = container[key];
  return typeof value === "string" && value.trim().length > 0;
}

/** True when the field holds at least one array element. */
function hasItems(container: Record<string, unknown>, key: string): boolean {
  const value = container[key];
  return Array.isArray(value) && value.length > 0;
}

/**
 * Names the card fields an import cannot carry anywhere.
 *
 * A conversion that succeeds is not the same as a conversion that lost nothing,
 * and the fields below change how a card reads rather than merely annotating it:
 * `nickname` is the name the card's own text addresses, and `group_only_greetings`
 * is content that must not be dropped when the card has no other first message.
 * Reporting them is what keeps a successful import from reading as a faithful one.
 *
 * An unset field is not a lost field, so a `depth_prompt` carrying settings but
 * no text is left alone: SillyTavern writes exactly that shape into its default
 * export, and reporting it would put noise at the front of every log line.
 */
export function describeUnmappedCardFields(card: unknown): string | null {
  const root = asPlainObject(card);
  if (!root) {
    return null;
  }

  // V3 nests the card under `data`; a root-level V2 card does not. Either may
  // carry the fields, so both scopes are checked.
  const scopes = [root];
  const cardData = asPlainObject(root.data);
  if (cardData) {
    scopes.push(cardData);
  }

  const dropped: string[] = [];
  if (scopes.some((scope) => hasText(scope, "nickname"))) {
    dropped.push("nickname");
  }
  if (scopes.some((scope) => hasItems(scope, "group_only_greetings"))) {
    dropped.push("group_only_greetings");
  }

  const characterBook = scopes.map((scope) => asPlainObject(scope.character_book)).find(Boolean);
  const entries = characterBook?.entries;
  if (Array.isArray(entries)) {
    const disabledCount = entries.filter((entry) => asPlainObject(entry)?.enabled === false).length;
    if (disabledCount > 0) {
      dropped.push(`${disabledCount} disabled character_book entr(ies)`);
    }
  }

  return dropped.length > 0 ? dropped.join(", ") : null;
}

/**
 * Helper function to localize error messages from utility functions
 * Handles both simple locale keys and keys with pipe-separated variables
 * @param errorString - Error string (locale key or key|var1|var2...)
 * @returns Localized error message
 */
function localizeError(locale: string, errorString: string): string {
  const parts = errorString.split("|");
  const key = parts[0];

  if (parts.length === 1) {
    return localizer(locale, key);
  }

  if (key === "commands.persona.import.error_invalid_attribute") {
    return localizer(locale, key, { details: parts[1] });
  }
  if (key === "commands.persona.import.error_invalid_dialogue_in") {
    return localizer(locale, key, { details: parts[1] });
  }
  if (key === "commands.persona.import.error_invalid_dialogue_out") {
    return localizer(locale, key, { details: parts[1] });
  }
  if (key === "commands.persona.import.error_invalid_trigger_word") {
    return localizer(locale, key, { details: parts[1] });
  }
  if (key === "commands.persona.import.error_incompatible_version") {
    return localizer(locale, key, { expected: parts[1], actual: parts[2] });
  }
  if (key === "commands.persona.import.error_invalid_type") {
    return localizer(locale, key, { type: parts[1] });
  }
  if (key === "commands.persona.import.error_name_conflict") {
    return localizer(locale, key, { name: parts[1] });
  }

  // Fallback: just localize the key
  return localizer(locale, key);
}

async function persistImportedMainAvatar(serverDiscId: string, avatarImageBuffer: Buffer): Promise<void> {
  const mainPersona = (await personaRepository.loadAllForServer(serverDiscId)).find((persona) => !persona.is_alter);

  if (!mainPersona?.persona_id) {
    log.warn(`Failed to locate main persona while persisting imported avatar for server ${serverDiscId}`);
    return;
  }

  const storedAvatarUrl = await uploadPersonaAvatarToStorage({
    personaId: mainPersona.persona_id,
    serverDiscId,
    label: "main import",
    buffer: avatarImageBuffer,
  });

  if (!storedAvatarUrl) {
    log.warn(`Failed to store imported main avatar for persona ${mainPersona.persona_id}`);
    return;
  }

  const avatarUpdated = await personaRepository.setAvatar(mainPersona.persona_id, storedAvatarUrl);
  if (!avatarUpdated) {
    log.warn(`Failed to persist imported main avatar for persona ${mainPersona.persona_id}`);
    return;
  }

  invalidateTomoriStateCache(serverDiscId);
}

/**
 * Configure the 'import' subcommand
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("import")
    .setDescription(localizer("en-US", "commands.persona.import.description"))
    .addAttachmentOption((option) =>
      option
        .setName("file")
        .setDescription(localizer("en-US", "commands.persona.import.file_description"))
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("type")
        .setDescription(localizer("en-US", "commands.persona.import.type_description"))
        .setRequired(true)
        .addChoices(
          {
            name: localizer("en-US", "commands.persona.import.type_choice_main"),
            value: "main",
          },
          {
            name: localizer("en-US", "commands.persona.import.type_choice_alter"),
            value: "alter",
          },
        ),
    )
    .addStringOption((option) =>
      option
        .setName("triggers")
        .setDescription(localizer("en-US", "commands.persona.import.triggers_description"))
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName("memories")
        .setDescription(localizer("en-US", "commands.persona.import.memories_description"))
        .setRequired(false)
        .addChoices(
          {
            name: localizer("en-US", "commands.persona.import.memories_choice_preserve"),
            value: "preserve",
          },
          {
            name: localizer("en-US", "commands.persona.import.memories_choice_fork"),
            value: "fork",
          },
        ),
    );

/**
 * Executes the 'import' command
 * Imports TomoriBot's personality from an uploaded PNG or JSON file
 */
export async function execute(
  client: Client,
  interaction: ChatInputCommandInteraction,
  _userData: UserRow,
  locale: string,
): Promise<void> {
  try {
    const importType = interaction.options.getString("type", true);
    const additionalTriggersInput = interaction.options.getString("triggers");
    const identityMode =
      ((interaction.options.getString("memories") ?? interaction.options.getString("identity_mode")) as
        | "preserve"
        | "fork"
        | null) ?? "preserve";

    // Alter personas can only be imported in guilds (not DMs)
    if (importType === "alter" && !interaction.guild) {
      await replyInfoEmbed(
        interaction,
        locale,
        {
          titleKey: "commands.persona.import.alter_dm_not_allowed_title",
          descriptionKey: "commands.persona.import.alter_dm_not_allowed_description",
          color: ColorCode.ERROR,
        },
        MessageFlags.Ephemeral,
      );
      return;
    }

    // Check permissions (ManageGuild required for import in guilds only)
    if (interaction.guild) {
      const hasPermission = interaction.memberPermissions?.has("ManageGuild") ?? false;

      if (!hasPermission) {
        await replyInfoEmbed(
          interaction,
          locale,
          {
            titleKey: "commands.persona.import.no_permission_title",
            descriptionKey: "commands.persona.import.no_permission_description",
            color: ColorCode.ERROR,
          },
          MessageFlags.Ephemeral,
        );
        return;
      }
    }

    const attachment = interaction.options.getAttachment("file", true);

    const normalizedAttachmentName = attachment.name.toLowerCase();
    const isPngImport = normalizedAttachmentName.endsWith(".png");
    const isJsonImport = normalizedAttachmentName.endsWith(".json");
    const isCharxImport = normalizedAttachmentName.endsWith(".charx");

    if (!isPngImport && !isJsonImport && !isCharxImport) {
      await replyInfoEmbed(
        interaction,
        locale,
        {
          titleKey: "commands.persona.import.invalid_file_type_title",
          descriptionKey: "commands.persona.import.invalid_file_type_description",
          color: ColorCode.ERROR,
        },
        MessageFlags.Ephemeral,
      );
      return;
    }

    const maxFileSizeMB = isCharxImport
      ? IMPORT_LIMITS.MAX_CHARX_IMPORT_SIZE_MB
      : IMPORT_LIMITS.MAX_PERSONA_IMPORT_SIZE_MB;
    const maxFileSize = maxFileSizeMB * 1024 * 1024;

    if (attachment.size > maxFileSize) {
      await replyInfoEmbed(
        interaction,
        locale,
        {
          titleKey: "commands.persona.import.file_too_large_title",
          descriptionKey: "commands.persona.import.file_too_large_description",
          descriptionVars: { max_size: maxFileSizeMB },
          color: ColorCode.ERROR,
        },
        MessageFlags.Ephemeral,
      );
      return;
    }

    // Defer reply while we process (ephemeral so all errors are private)
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Reserve import operation quota (atomic check+increment for DDoS protection)
    const quotaReserve = reserveImportQuota(interaction.user.id);
    if (!quotaReserve.allowed) {
      const resetTime = quotaReserve.resetAt ? new Date(quotaReserve.resetAt).toLocaleString(locale) : "unknown";

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "rate_limit.error_quota_exceeded_title"))
            .setDescription(
              localizer(locale, "rate_limit.error_quota_exceeded_description", {
                reset_time: resetTime,
              }),
            )
            .setColor(ColorCode.ERROR),
        ],
      });
      return;
    }

    const memCheck = memoryGuard.checkMemory();
    if (memCheck.status === "critical") {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "rate_limit.error_memory_critical_title"))
            .setDescription(localizer(locale, "rate_limit.error_memory_critical_description"))
            .setColor(ColorCode.ERROR),
        ],
      });
      return;
    }

    let importFileBuffer: Buffer;

    try {
      const response = await safeDownload(attachment.url, {
        maxSizeMB: maxFileSizeMB,
        timeoutMs: 15_000,
        knownSize: attachment.size,
      });

      if (!response.success || !response.buffer) {
        throw new Error(`Failed to download file: ${response.details ?? response.error ?? "unknown error"}`);
      }

      importFileBuffer = response.buffer;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        log.warn("Persona import download timed out");
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle(localizer(locale, "commands.persona.import.error_download_timeout"))
              .setColor(ColorCode.ERROR),
          ],
        });
        return;
      }

      log.error("Failed to download attachment:", error as Error);
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "commands.persona.import.download_failed_title"))
            .setDescription(localizer(locale, "commands.persona.import.download_failed_description"))
            .setColor(ColorCode.ERROR),
        ],
      });
      return;
    }

    let resolvedImport: ResolvedImportFile | null = null;

    if (isCharxImport) {
      // A `.charx` is a zip around a card that is already V2-shaped in every
      // field this converter reads, so unwrapping the container is the whole
      // job and the existing converter stays untouched.
      const archive = await readCharxCard(importFileBuffer, {
        maxCardBytes: MAX_CHARX_CARD_BYTES,
        maxAssets: IMPORT_LIMITS.MAX_CHARX_ASSETS,
        maxTotalAssetBytes: MAX_CHARX_ASSET_TOTAL_BYTES,
      });

      if (!archive.ok) {
        log.warn(`Persona import rejected a .charx archive: ${archive.reason}`);
        await replyInvalidCharx(interaction, locale, archive.reason);
        return;
      }

      const conversion = presetRepository.convertSillyTavernJsonToPresetData(archive.card);
      if (!conversion.success) {
        await replyCardConversionFailure({
          interaction,
          locale,
          parsedJson: archive.card,
          conversionError: conversion.error,
          sourceLabel: "CHARX card.json",
          attachmentName: "sillytavern-charx-decode",
        });
        return;
      }

      resolvedImport = {
        avatarImageBuffer: null,
        presetData: conversion.data,
        source: "charx",
        ignoredAssetCount: archive.ignoredAssetCount,
        unmappedCardFields: describeUnmappedCardFields(archive.card),
      };
      log.info(
        `[Persona Import] Converted Character Card V3 archive to preset format for "${conversion.data.tomori_nickname}" (ignored ${archive.ignoredAssetCount} embedded asset(s))`,
      );
    } else if (isPngImport) {
      const pngValidation = validatePNGBuffer(importFileBuffer, MAX_FILE_SIZE);
      if (!pngValidation.isValid) {
        log.warn(`Invalid PNG buffer during preset import: ${pngValidation.error}`);
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle(localizer(locale, "commands.persona.import.invalid_png_title"))
              .setDescription(localizer(locale, "commands.persona.import.invalid_png_description"))
              .setColor(ColorCode.ERROR),
          ],
        });
        return;
      }

      const metadata = extractMetadataFromPNG(importFileBuffer);
      if (metadata) {
        const validation = presetRepository.validatePresetFile(metadata);

        if (!validation.valid || !validation.data) {
          await interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setTitle(localizer(locale, "commands.persona.import.invalid_file_title"))
                .setDescription(
                  validation.error
                    ? localizeError(locale, validation.error)
                    : localizer(locale, "commands.persona.import.invalid_file_description"),
                )
                .setColor(ColorCode.ERROR),
            ],
          });
          return;
        }

        resolvedImport = {
          avatarImageBuffer: importFileBuffer,
          presetData: validation.data,
          source: "tomori-png",
        };
      } else {
        const sillyTavernData = extractSillyTavernMetadataFromPNG(importFileBuffer);
        if (!sillyTavernData) {
          await interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setTitle(localizer(locale, "commands.persona.import.no_metadata_title"))
                .setDescription(localizer(locale, "commands.persona.import.no_metadata_description"))
                .setColor(ColorCode.ERROR),
            ],
          });
          return;
        }

        const conversion = presetRepository.convertSillyTavernMetadataToPresetData(sillyTavernData);
        if (!conversion.success) {
          await replyCardConversionFailure({
            interaction,
            locale,
            parsedJson: sillyTavernData.parsedJson,
            conversionError: conversion.error,
            sourceLabel: "PNG metadata",
            attachmentName: "sillytavern-decode",
            debugContext: {
              metadataKey: sillyTavernData.metadataKey,
              rawValueLength: sillyTavernData.rawValue.length,
              decodedValueLength: sillyTavernData.decodedValue.length,
              decodedFromBase64: sillyTavernData.decodedFromBase64,
            },
          });
          return;
        }

        resolvedImport = {
          avatarImageBuffer: importFileBuffer,
          presetData: conversion.data,
          source: "sillytavern-png",
          unmappedCardFields: describeUnmappedCardFields(sillyTavernData.parsedJson),
        };
        log.info(
          `[Persona Import] Converted SillyTavern PNG card to preset format for "${conversion.data.tomori_nickname}"`,
        );
      }
    } else {
      let parsedJson: unknown;
      try {
        parsedJson = parseJsonAttachment(importFileBuffer);
      } catch (error) {
        log.warn("Persona import JSON parse failed", error);
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle(localizer(locale, "commands.persona.import.invalid_file_title"))
              .setDescription(localizeError(locale, "commands.persona.import.error_not_json"))
              .setColor(ColorCode.ERROR),
          ],
        });
        return;
      }

      const validation = presetRepository.validatePresetFile(parsedJson);
      if (validation.valid && validation.data) {
        resolvedImport = {
          avatarImageBuffer: null,
          presetData: validation.data,
          source: "tomori-json",
        };
      } else if (presetRepository.looksLikeSillyTavernCardJson(parsedJson)) {
        const conversion = presetRepository.convertSillyTavernJsonToPresetData(parsedJson);
        if (!conversion.success) {
          await replyCardConversionFailure({
            interaction,
            locale,
            parsedJson,
            conversionError: conversion.error,
            sourceLabel: "JSON attachment",
            attachmentName: "sillytavern-json-decode",
          });
          return;
        }

        resolvedImport = {
          avatarImageBuffer: null,
          presetData: conversion.data,
          source: "sillytavern-json",
          unmappedCardFields: describeUnmappedCardFields(parsedJson),
        };
        log.info(
          `[Persona Import] Converted SillyTavern JSON card to preset format for "${conversion.data.tomori_nickname}"`,
        );
      } else {
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle(localizer(locale, "commands.persona.import.invalid_file_title"))
              .setDescription(
                validation.error
                  ? localizeError(locale, validation.error)
                  : localizer(locale, "commands.persona.import.invalid_file_description"),
              )
              .setColor(ColorCode.ERROR),
          ],
        });
        return;
      }
    }

    const presetDataFromFile = resolvedImport?.presetData ?? null;
    const avatarImageBuffer = resolvedImport?.avatarImageBuffer ?? null;

    if (!presetDataFromFile || !resolvedImport) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "general.errors.unknown_error_title"))
            .setDescription(localizer(locale, "general.errors.unknown_error_description"))
            .setColor(ColorCode.ERROR),
        ],
      });
      return;
    }

    // Reported once here rather than inside each converter branch: every card
    // format loses the same fields, so a per-branch call would silently cover
    // only whichever format was written most recently.
    if (resolvedImport.unmappedCardFields) {
      log.info(
        `[Persona Import] Fields with no destination in this ${resolvedImport.source} card: ${resolvedImport.unmappedCardFields}`,
      );
    }

    const additionalTriggers = additionalTriggersInput ? parseCommaSeparatedTriggers(additionalTriggersInput) : [];
    const mergedPresetData: PresetExportData = {
      ...presetDataFromFile,
      trigger_words: dedupeTriggerWords([...presetDataFromFile.trigger_words, ...additionalTriggers], {
        lowercase: false,
      }),
    };
    const mergedPresetValidation = presetRepository.validatePresetData(mergedPresetData);
    if (!mergedPresetValidation.valid || !mergedPresetValidation.data) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "commands.persona.import.invalid_file_title"))
            .setDescription(
              mergedPresetValidation.error
                ? localizeError(locale, mergedPresetValidation.error)
                : localizer(locale, "commands.persona.import.invalid_file_description"),
            )
            .setColor(ColorCode.ERROR),
        ],
      });
      return;
    }
    const presetData = mergedPresetValidation.data;

    const serverDiscId = interaction.guild?.id ?? interaction.user.id;
    const isDM = !interaction.guild;

    if (importType === "main") {
      const currentMainPersona = (await personaRepository.loadAllForServer(serverDiscId)).find(
        (persona) => !persona.is_alter,
      );
      const mainPersonaId = currentMainPersona?.persona_id ?? null;
      let spritesBeforeImport: PersonaSpriteRow[] = [];
      if (mainPersonaId) {
        try {
          spritesBeforeImport = await snapshotMainPersonaSprites(mainPersonaId);
        } catch (error) {
          await log.error(`Failed to snapshot sprites before importing main persona ${mainPersonaId}:`, error, {
            errorType: "PersonaImportSpriteSnapshotError",
            metadata: { personaId: mainPersonaId, serverDiscId },
          });
          await interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setTitle(localizer(locale, "commands.persona.import.failed_title"))
                .setDescription(localizer(locale, "commands.persona.import.sprite_snapshot_failed_description"))
                .setColor(ColorCode.ERROR),
            ],
          });
          return;
        }
      }

      const importResult = await presetRepository.importPresetData(serverDiscId, presetData, identityMode);

      if (!importResult.success) {
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle(localizer(locale, "commands.persona.import.failed_title"))
              .setDescription(
                importResult.error
                  ? localizeError(locale, importResult.error)
                  : localizer(locale, "commands.persona.import.failed_description"),
              )
              .setColor(ColorCode.ERROR),
          ],
        });
        return;
      }

      // Invalidate cache so next message gets fresh persona/config
      invalidateTomoriStateCache(serverDiscId);

      let failedSpriteStorageDeletes = 0;
      if (mainPersonaId) {
        try {
          failedSpriteStorageDeletes = await cleanupMainPersonaSpritesAfterImport({
            personaId: mainPersonaId,
            serverDiscId,
            importedAsPointer: importResult.mainPersonaIsPointer,
            spritesBeforeImport,
          });
        } catch (error) {
          await log.error(`Failed to clear sprites after importing main persona ${mainPersonaId}:`, error, {
            errorType: "PersonaImportSpriteCleanupError",
            metadata: { personaId: mainPersonaId, serverDiscId },
          });
          await interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setTitle(localizer(locale, "commands.persona.import.failed_title"))
                .setDescription(localizer(locale, "commands.persona.import.sprite_cleanup_failed_description"))
                .setColor(ColorCode.ERROR),
            ],
          });
          return;
        }
      }

      // Try to set TomoriBot's server-specific avatar and nickname (guild-only, non-fatal if fails)
      let avatarUpdateSucceeded = false;
      let avatarUpdateRateLimited = false;
      let avatarUpdateFailed = false;
      let avatarUpdateSkippedNoImage = false;
      let nicknameUpdateSucceeded = false;
      let nicknameUpdateRateLimited = false;
      let nicknameUpdateFailed = false;
      if (!isDM) {
        const endpoint = `https://discord.com/api/v10/guilds/${interaction.guild.id}/members/@me`;

        const importedNickname = importResult.itemsImported?.nickname;

        if (importedNickname) {
          try {
            const nicknameResponse = await fetch(endpoint, {
              method: "PATCH",
              headers: {
                Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                nick: importedNickname,
              }),
            });

            if (nicknameResponse.ok) {
              nicknameUpdateSucceeded = true;
            } else {
              const errorText = await nicknameResponse.text();
              if (isAvatarUpdateRateLimited(nicknameResponse.status, errorText)) {
                nicknameUpdateRateLimited = true;
              }
              nicknameUpdateFailed = true;
              log.warn(
                `Failed to update bot's server nickname (non-fatal): ${nicknameResponse.status} ${nicknameResponse.statusText} - ${errorText}`,
              );
            }
          } catch (nicknameError) {
            nicknameUpdateFailed = true;
            log.warn(
              `Failed to update bot's server nickname (non-fatal): ${nicknameError instanceof Error ? nicknameError.message : "Unknown error"}`,
            );
          }
        }

        if (!avatarImageBuffer) {
          avatarUpdateSkippedNoImage = true;
        } else {
          try {
            const base64 = avatarImageBuffer.toString("base64");
            const avatarDataUri = `data:image/png;base64,${base64}`;

            const avatarResponse = await fetch(endpoint, {
              method: "PATCH",
              headers: {
                Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                avatar: avatarDataUri,
              }),
            });

            if (avatarResponse.ok) {
              avatarUpdateSucceeded = true;
              log.success(`Successfully updated TomoriBot's server avatar for ${serverDiscId} during preset import`);
            } else {
              const errorText = await avatarResponse.text();
              if (isAvatarUpdateRateLimited(avatarResponse.status, errorText)) {
                avatarUpdateRateLimited = true;
              }
              avatarUpdateFailed = true;
              log.warn(
                `Failed to update bot's server avatar (non-fatal): ${avatarResponse.status} ${avatarResponse.statusText} - ${errorText}`,
              );
            }
          } catch (avatarError) {
            avatarUpdateFailed = true;
            log.warn(
              `Failed to update bot's server avatar during preset import (non-fatal): ${avatarError instanceof Error ? avatarError.message : "Unknown error"}`,
            );
          }
        }
      }

      const itemsImported = importResult.itemsImported;

      if (!itemsImported) {
        log.error("Import result missing itemsImported data");
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle(localizer(locale, "general.errors.unknown_error_title"))
              .setDescription(localizer(locale, "general.errors.unknown_error_description"))
              .setColor(ColorCode.ERROR),
          ],
        });
        return;
      }

      const descriptionLines = [
        localizer(locale, "commands.persona.import.success_description", {
          nickname: itemsImported.nickname,
          attribute_count: itemsImported.attributeCount,
          dialogue_count: itemsImported.dialogueCount,
          trigger_word_count: itemsImported.triggerWordCount,
        }),
      ];

      if (failedSpriteStorageDeletes > 0) {
        descriptionLines.push(
          localizer(locale, "commands.persona.import.sprite_storage_cleanup_partial_description", {
            failed_count: failedSpriteStorageDeletes,
          }),
        );
      }

      if ((resolvedImport.ignoredAssetCount ?? 0) > 0) {
        descriptionLines.push(localizer(locale, "commands.persona.import.charx_assets_ignored_description"));
      }

      if (nicknameUpdateRateLimited || nicknameUpdateFailed) {
        descriptionLines.push(localizer(locale, "commands.persona.import.nickname_update_failed"));
      } else if (nicknameUpdateSucceeded) {
        descriptionLines.push(localizer(locale, "commands.persona.import.nickname_update_success"));
      }

      if (avatarUpdateSkippedNoImage) {
        descriptionLines.push(localizer(locale, "commands.persona.import.avatar_update_skipped_no_image"));
      } else if (avatarUpdateRateLimited) {
        descriptionLines.push(localizer(locale, "commands.persona.import.avatar_update_rate_limited"));
      } else if (avatarUpdateSucceeded) {
        descriptionLines.push(localizer(locale, "commands.persona.import.avatar_update_success"));
      } else if (avatarUpdateFailed) {
        descriptionLines.push(localizer(locale, "commands.persona.import.avatar_update_failed"));
      }

      const successEmbed = new EmbedBuilder()
        .setTitle(localizer(locale, "commands.persona.import.success_title"))
        .setDescription(descriptionLines.join("\n\n"))
        .setColor(
          isDM ||
            avatarUpdateSkippedNoImage ||
            avatarUpdateRateLimited ||
            avatarUpdateFailed ||
            nicknameUpdateRateLimited ||
            nicknameUpdateFailed ||
            failedSpriteStorageDeletes > 0
            ? ColorCode.WARN
            : ColorCode.SUCCESS,
        );

      const footerParts: string[] = [];
      if (isDM) {
        footerParts.push(localizer(locale, "commands.persona.import.avatar_update_skipped_dm"));
      }
      footerParts.push(localizer(locale, "commands.persona.import.refresh_reminder"));
      successEmbed.setFooter({ text: footerParts.join(" • ") });

      if (!interaction.channel || !("send" in interaction.channel)) {
        log.error("No channel available for persona import success message");
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle(localizer(locale, "general.errors.unknown_error_title"))
              .setDescription(localizer(locale, "general.errors.unknown_error_description"))
              .setColor(ColorCode.ERROR),
          ],
        });
        return;
      }

      if (avatarImageBuffer) {
        const sanitizedNickname = sanitizeAttachmentFilenamePart(itemsImported.nickname, {
          fallback: "persona",
          maxLength: 50,
        });
        const timestamp = Date.now();
        const avatarFilename = `tomori-preset-${sanitizedNickname}-${timestamp}.png`;
        const avatarAttachment = new AttachmentBuilder(avatarImageBuffer, {
          name: avatarFilename,
        });
        successEmbed.setImage(`attachment://${avatarFilename}`);
        await interaction.channel.send({
          embeds: [successEmbed],
          files: [avatarAttachment],
        });
        await persistImportedMainAvatar(serverDiscId, avatarImageBuffer);
      } else {
        await interaction.channel.send({
          embeds: [successEmbed],
        });
      }

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "commands.persona.import.success_title"))
            .setDescription(
              localizer(locale, "commands.persona.import.success_confirmation", {
                nickname: itemsImported.nickname,
              }),
            )
            .setColor(
              avatarUpdateSkippedNoImage ||
                avatarUpdateRateLimited ||
                avatarUpdateFailed ||
                nicknameUpdateRateLimited ||
                nicknameUpdateFailed
                ? ColorCode.WARN
                : ColorCode.SUCCESS,
            ),
        ],
      });

      // Quota already reserved at step 6.25 - no increment needed
      log.success(
        `Successfully imported main persona for ${isDM ? "DM" : "guild"} ${serverDiscId}: ${itemsImported.nickname}`,
      );
    } else {
      // Alter persona import: delegate DB/storage/cache work to the shared core
      // so the slash command and the "Import Now" button stay in lockstep.
      const alterResult = await importAlterPreset({
        client,
        guild: interaction.guild ?? null,
        serverDiscId,
        presetData,
        identityMode,
        avatarImageBuffer,
      });

      if (!alterResult.ok) {
        const errorEmbed = new EmbedBuilder().setColor(ColorCode.ERROR);
        switch (alterResult.reason) {
          case "limit_reached":
            errorEmbed.setTitle(localizer(locale, "commands.persona.import.alter_limit_title")).setDescription(
              localizer(locale, "commands.persona.import.alter_limit_description", {
                current: alterResult.current,
                max: alterResult.max,
              }),
            );
            break;
          case "name_conflict":
            errorEmbed.setTitle(localizer(locale, "commands.persona.import.alter_name_conflict_title")).setDescription(
              localizer(locale, "commands.persona.import.alter_name_conflict_description", {
                name: alterResult.name,
              }),
            );
            break;
          case "no_main_persona":
            errorEmbed
              .setTitle(localizer(locale, "general.errors.tomori_not_setup_title"))
              .setDescription(localizer(locale, "general.errors.tomori_not_setup_description"));
            break;
          case "config_failed":
            errorEmbed
              .setTitle(localizer(locale, "general.errors.update_failed_title"))
              .setDescription(localizer(locale, "general.errors.update_failed_description"));
            break;
          default:
            errorEmbed
              .setTitle(localizer(locale, "general.errors.unknown_error_title"))
              .setDescription(localizer(locale, "general.errors.unknown_error_description"));
            break;
        }
        await interaction.editReply({ embeds: [errorEmbed] });
        return;
      }

      const alterEmbedColor =
        alterResult.hasNoTriggers || alterResult.usedMainAvatarFallback ? ColorCode.WARN : ColorCode.SUCCESS;
      const alterDescriptionParts = [
        localizer(locale, "commands.persona.import.alter_success_description", {
          nickname: alterResult.nickname,
          trigger_count: alterResult.displayedTriggers.length,
          triggers: alterResult.displayedTriggers.length > 0 ? alterResult.displayedTriggers.join(", ") : "N/A",
        }),
      ];
      if (alterResult.usedMainAvatarFallback) {
        alterDescriptionParts.push(
          `\n\n${localizer(locale, "commands.persona.import.alter_avatar_fallback_main", {
            nickname: alterResult.mainPersonaNickname,
          })}`,
        );
      }
      if (alterResult.hasNoTriggers) {
        alterDescriptionParts.push(`\n\n${localizer(locale, "commands.persona.import.alter_no_triggers_warning")}`);
      }
      if ((resolvedImport.ignoredAssetCount ?? 0) > 0) {
        alterDescriptionParts.push(
          `\n\n${localizer(locale, "commands.persona.import.charx_assets_ignored_description")}`,
        );
      }

      const alterSuccessEmbed = new EmbedBuilder()
        .setTitle(localizer(locale, "commands.persona.import.alter_success_title"))
        .setDescription(alterDescriptionParts.join(""))
        .setColor(alterEmbedColor);
      if (alterResult.usedMainAvatarFallback && alterResult.fallbackAvatarDisplayUrl) {
        alterSuccessEmbed.setThumbnail(alterResult.fallbackAvatarDisplayUrl);
      }

      // Post the public confirmation in-channel, attaching the avatar image
      //      when one was supplied. The persona already exists, so a missing
      //      channel only skips the public notice (the invoker still gets one).
      if (interaction.channel && "send" in interaction.channel) {
        if (avatarImageBuffer) {
          const sanitizedNickname = sanitizeAttachmentFilenamePart(alterResult.nickname, {
            fallback: "persona",
            maxLength: 50,
          });
          const timestamp = Date.now();
          const avatarFilename = `tomori-preset-${sanitizedNickname}-${timestamp}.png`;
          alterSuccessEmbed.setImage(`attachment://${avatarFilename}`);
          alterSuccessEmbed.setFooter({
            text: localizer(locale, "commands.persona.import.alter_avatar_warning"),
          });
          await interaction.channel.send({
            embeds: [alterSuccessEmbed],
            files: [new AttachmentBuilder(avatarImageBuffer, { name: avatarFilename })],
          });
        } else {
          await interaction.channel.send({ embeds: [alterSuccessEmbed] });
        }
      }

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "commands.persona.import.alter_success_title"))
            .setDescription(
              localizer(locale, "commands.persona.import.alter_success_confirmation", {
                nickname: alterResult.nickname,
                trigger_count: alterResult.uniqueTriggerCount,
              }),
            )
            .setColor(alterEmbedColor),
        ],
      });
    }
  } catch (error) {
    log.error("Error executing preset import command:", error, {
      errorType: "CommandExecutionError",
      metadata: { commandName: "preset import" },
    });

    if (!interaction.replied && !interaction.deferred) {
      await replyInfoEmbed(
        interaction,
        locale,
        {
          titleKey: "general.errors.unknown_error_title",
          descriptionKey: "general.errors.unknown_error_description",
          color: ColorCode.ERROR,
        },
        MessageFlags.Ephemeral,
      );
    } else {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "general.errors.unknown_error_title"))
            .setDescription(localizer(locale, "general.errors.unknown_error_description"))
            .setColor(ColorCode.ERROR),
        ],
      });
    }
  }
}
