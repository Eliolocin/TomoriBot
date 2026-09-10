import type { ChatInputCommandInteraction } from "discord.js";
import { sanitizeAttachmentFilenamePart } from "@/utils/discord/attachmentFilename";

export type TransferExportScope = "workspace" | "personal";
export type TransferExportCategory = "config" | "memories";

/** The scope's word in the filename. The internal scope stays `workspace`, which may be a DM-backed workspace. */
const TRANSFER_EXPORT_SCOPE_NAMES: Record<TransferExportScope, string> = {
  workspace: "server",
  personal: "personal",
};

/**
 * The name a transfer file is told apart by: the workspace it belongs to, or the exporting account. Both scopes
 * fall back to the account handle, which is what a DM-backed workspace has instead of a guild name.
 */
export function resolveTransferExportSubject(
  scope: TransferExportScope,
  interaction: ChatInputCommandInteraction,
): string {
  return scope === "workspace" ? (interaction.guild?.name ?? interaction.user.username) : interaction.user.username;
}

/**
 * `tomori-<name>-<scope>-<category>-<timestamp>.json`, the shape `/persona export` uses. The subject is passed
 * through the same sanitizer `/persona export` uses: that is what keeps an arbitrary guild or account name from
 * carrying a path separator, a reserved character, or a control character into the attachment name. A name that
 * sanitizes away entirely still yields a name, because the sanitizer appends a short hash of the original.
 */
export function buildTransferExportFileName(input: {
  scope: TransferExportScope;
  category: TransferExportCategory;
  subject: string;
}): string {
  const scopeName = TRANSFER_EXPORT_SCOPE_NAMES[input.scope];
  const sanitizedSubject = sanitizeAttachmentFilenamePart(input.subject, {
    fallback: scopeName,
    maxLength: 50,
  });

  return `tomori-${sanitizedSubject}-${scopeName}-${input.category}-${Date.now()}.json`;
}
