import { createHash } from "node:crypto";
import { MessageFlags, type Attachment, type ChatInputCommandInteraction } from "discord.js";
import { parseExportFile } from "@/types/db/dataExport";
import type { StandardEmbedOptions } from "@/types/discord/embed";
import { createNonce } from "@/utils/discord/panelRouteTokens";
import { deliverGuardedPanel } from "@/utils/discord/interactions/panelController";
import {
  isWorkspaceTransferAuthorized,
  resolveWorkspaceTransferKey,
} from "@/utils/discord/interactions/transferAuthorization";
import {
  storeTransferSnapshot,
  type TransferSnapshotRecordInput,
} from "@/utils/discord/interactions/transferSnapshotStore";
import type { ComponentsV2MessagePayload } from "@/utils/discord/ui/componentsV2Limits";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import {
  buildConfigTransferPreviewPayload,
  getPresentedConfigSections,
  type ConfigTransferKind,
} from "@/utils/discord/ui/transferPanel";
import { ColorCode, log } from "@/utils/misc/logger";
import { IMPORT_LIMITS } from "@/utils/security/rateLimiter";
import { safeDownload, type SafeDownloadResult } from "@/utils/security/safeDownload";

export type ConfigImportScope = "workspace" | "personal";

/** Keeps this helper out of slash-command registration; the loader scans every file in a command directory. */
export const isCommandEnabled = () => false;

/**
 * The portable `sourceType` values each command accepts: the v2 format it emits, plus the v1 export W7a's adapter
 * still reads. A `server` or `personal` v1 file carries memories beside its config, so it is not a config file for
 * this entry point and is refused rather than partially applied.
 */
const CONFIG_IMPORT_SOURCE_TYPES: Record<ConfigTransferKind, readonly string[]> = {
  workspace_config: ["workspace_config", "server_config"],
  personal_config: ["personal_config", "personal_settings"],
};

export function isConfigImportSourceTypeForKind(kind: ConfigTransferKind, sourceType: string): boolean {
  return CONFIG_IMPORT_SOURCE_TYPES[kind].includes(sourceType);
}

export interface ConfigImportDependencies {
  downloadAttachment(attachment: Attachment): Promise<SafeDownloadResult>;
  createSnapshotNonce(): string;
  storeSnapshot(nonce: string, record: TransferSnapshotRecordInput): void;
  deliverPreview(
    interaction: ChatInputCommandInteraction,
    locale: string,
    payload: ComponentsV2MessagePayload,
  ): Promise<unknown>;
  replyInfoEmbed(
    interaction: ChatInputCommandInteraction,
    locale: string,
    options: StandardEmbedOptions,
    flags?: MessageFlags,
  ): Promise<void>;
}

const defaultDependencies: ConfigImportDependencies = {
  downloadAttachment: (attachment) =>
    safeDownload(attachment.url, {
      maxSizeMB: IMPORT_LIMITS.MAX_DATA_IMPORT_SIZE_MB,
      timeoutMs: 10_000,
      knownSize: attachment.size,
    }),
  createSnapshotNonce: createNonce,
  storeSnapshot: storeTransferSnapshot,
  deliverPreview: (interaction, locale, payload) => deliverGuardedPanel(interaction, payload, { locale }),
  replyInfoEmbed,
};

function fingerprintExportFile(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function parseJsonObject(buffer: Buffer): unknown | null {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * The upload operation shared by `/import config` and `/import personal config`. It validates the file and stores
 * the parsed result behind an actor-bound nonce; the routed `config-continue` and `config-apply` actions read that
 * snapshot, and only `config-apply` writes.
 */
export async function startConfigImport(
  interaction: ChatInputCommandInteraction,
  locale: string,
  kind: ConfigTransferKind,
  overrides: Partial<ConfigImportDependencies> = {},
): Promise<void> {
  const dependencies: ConfigImportDependencies = { ...defaultDependencies, ...overrides };
  const scope: ConfigImportScope = kind === "workspace_config" ? "workspace" : "personal";
  const destinationKey = scope === "workspace" ? resolveWorkspaceTransferKey(interaction) : interaction.user.id;
  const refuseInvalidFile = () =>
    dependencies.replyInfoEmbed(interaction, locale, {
      titleKey: "commands.data.import.invalid_file_title",
      descriptionKey: "commands.data.import.invalid_file_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });

  try {
    if (scope === "workspace" && !isWorkspaceTransferAuthorized(interaction)) {
      await dependencies.replyInfoEmbed(interaction, locale, {
        titleKey: "commands.data.import.no_permission_title",
        descriptionKey: "commands.data.import.no_permission_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Acknowledge before the download and the parse, both of which outlive Discord's three-second window.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const attachment = interaction.options.getAttachment("file", true);
    const download = await dependencies.downloadAttachment(attachment);
    if (!download.success || !download.buffer) {
      await refuseInvalidFile();
      return;
    }

    const jsonData = parseJsonObject(download.buffer);
    if (jsonData === null) {
      await refuseInvalidFile();
      return;
    }

    const parseResult = parseExportFile(jsonData);
    if (!parseResult.success) {
      await refuseInvalidFile();
      return;
    }

    if (!isConfigImportSourceTypeForKind(kind, parseResult.sourceType)) {
      await dependencies.replyInfoEmbed(interaction, locale, {
        titleKey: "commands.transfer.config_wrong_file_title",
        descriptionKey: "commands.transfer.config_wrong_file_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const presentedSections = getPresentedConfigSections(kind, parseResult.detectedSections);
    if (presentedSections.length === 0) {
      // No snapshot is stored, so no routed action can exist for a file that has nothing to apply.
      await dependencies.replyInfoEmbed(interaction, locale, {
        titleKey: "commands.transfer.config_no_importable_sections_title",
        descriptionKey: "commands.transfer.config_no_importable_sections_description",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const nonce = dependencies.createSnapshotNonce();
    dependencies.storeSnapshot(nonce, {
      actorDiscId: interaction.user.id,
      kind,
      ownership: scope,
      destinationKey,
      fingerprint: fingerprintExportFile(download.buffer),
      exportResult: parseResult,
    });

    await dependencies.deliverPreview(
      interaction,
      locale,
      buildConfigTransferPreviewPayload({
        locale,
        kind,
        detectedSections: parseResult.detectedSections,
        droppedFields: parseResult.droppedFields,
        nonce,
      }),
    );
  } catch (error) {
    log.error(`Error starting the ${kind} import:`, error, {
      errorType: "CommandExecutionError",
      metadata: { commandName: `import ${kind}` },
    });

    await dependencies.replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
  }
}
