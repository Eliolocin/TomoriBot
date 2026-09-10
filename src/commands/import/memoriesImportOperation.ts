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
import { readMemoryBundleBuckets } from "@/utils/discord/transferMemoryBundle";
import type { ComponentsV2MessagePayload } from "@/utils/discord/ui/componentsV2Limits";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { buildMemoryTransferPreviewPayload, type MemoryTransferKind } from "@/utils/discord/ui/transferPanel";
import { ColorCode, log } from "@/utils/misc/logger";
import { IMPORT_LIMITS } from "@/utils/security/rateLimiter";
import { safeDownload, type SafeDownloadResult } from "@/utils/security/safeDownload";

export type MemoryImportScope = "workspace" | "personal";

/** Keeps this helper out of slash-command registration; the loader scans every file in a command directory. */
export const isCommandEnabled = () => false;

/**
 * Which ownership each portable memory `sourceType` belongs to. One table rather than a per-leaf list, because the
 * same source type has to be recognised as either the leaf's own format or the other ownership's.
 */
const MEMORY_IMPORT_SOURCE_OWNERSHIP: Record<string, MemoryTransferKind> = {
  workspace_memories: "workspace_memories",
  server_memories: "workspace_memories",
  personal_memories: "personal_memories",
  global_personal_memories: "personal_memories",
};

export type MemoryImportSourceClassification = "same-ownership" | "cross-ownership" | "unsupported";

/**
 * Classifies a file against the leaf that is reading it.
 *
 * A memory file carries no destination of its own, so a file from the other ownership is importable here once the
 * reader has been told that its memories change ownership. A v1 combined `server` or `personal` export is not: it
 * carries configuration beside its memories, and a partial apply would be worse than a refusal, exactly as the
 * config leaves refuse the mirror case.
 */
export function classifyMemoryImportSource(
  kind: MemoryTransferKind,
  sourceType: string,
): MemoryImportSourceClassification {
  const ownership = MEMORY_IMPORT_SOURCE_OWNERSHIP[sourceType];
  if (!ownership) return "unsupported";
  return ownership === kind ? "same-ownership" : "cross-ownership";
}

export function isMemoryImportSourceTypeForKind(kind: MemoryTransferKind, sourceType: string): boolean {
  return classifyMemoryImportSource(kind, sourceType) !== "unsupported";
}

export interface MemoryImportDependencies {
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

const defaultDependencies: MemoryImportDependencies = {
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
 * The upload operation shared by `/import memories` and `/import personal memories`. It validates the file and
 * stores the parsed result behind an actor-bound nonce. The routed actions read that snapshot, and only
 * `memory-confirm` writes, so nothing here resolves a destination or a strategy.
 */
export async function startMemoryImport(
  interaction: ChatInputCommandInteraction,
  locale: string,
  kind: MemoryTransferKind,
  overrides: Partial<MemoryImportDependencies> = {},
): Promise<void> {
  const dependencies: MemoryImportDependencies = { ...defaultDependencies, ...overrides };
  const scope: MemoryImportScope = kind === "workspace_memories" ? "workspace" : "personal";
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

    const sourceClassification = classifyMemoryImportSource(kind, parseResult.sourceType);
    if (sourceClassification === "unsupported") {
      await dependencies.replyInfoEmbed(interaction, locale, {
        titleKey: "commands.transfer.memories_wrong_file_title",
        descriptionKey: "commands.transfer.memories_wrong_file_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const buckets = readMemoryBundleBuckets(parseResult.payload);
    if (!buckets || buckets.length === 0) {
      // No snapshot is stored, so no routed action can exist for a file that has nothing to import.
      await dependencies.replyInfoEmbed(interaction, locale, {
        titleKey: "commands.transfer.memories_no_importable_buckets_title",
        descriptionKey: "commands.transfer.memories_no_importable_buckets_description",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sourceClassification === "cross-ownership" && buckets.length > 1) {
      // A cross-ownership file is imported one group at a time, because every extra source group is another
      // destination choice whose ownership meaning the reader has not been shown.
      await dependencies.replyInfoEmbed(interaction, locale, {
        titleKey: "commands.transfer.memories_cross_ownership_multiple_buckets_title",
        descriptionKey: "commands.transfer.memories_cross_ownership_multiple_buckets_description",
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
      buildMemoryTransferPreviewPayload({
        locale,
        kind,
        buckets,
        nonce,
        crossOwnership: sourceClassification === "cross-ownership",
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
