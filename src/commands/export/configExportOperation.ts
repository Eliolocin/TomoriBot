import { AttachmentBuilder, EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import type { ExportResult } from "@/types/db/dataExport";
import type { StandardEmbedOptions } from "@/types/discord/embed";
import { exportRepository } from "@/utils/db/repositories";
import {
  isWorkspaceTransferAuthorized,
  resolveWorkspaceTransferKey,
} from "@/utils/discord/interactions/transferAuthorization";
import {
  buildTransferExportFileName,
  resolveTransferExportSubject,
  type TransferExportScope,
} from "@/utils/discord/transferExportFileName";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { ColorCode, log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";

export type ConfigExportScope = TransferExportScope;

/** Keeps this helper out of slash-command registration; the loader scans every file in a command directory. */
export const isCommandEnabled = () => false;

export interface ConfigExportDependencies {
  exportWorkspaceConfig(serverDiscId: string): Promise<ExportResult>;
  exportPersonalConfig(userDiscId: string): Promise<ExportResult>;
  deliverDirectMessage(
    interaction: ChatInputCommandInteraction,
    payload: { embeds: EmbedBuilder[]; files: AttachmentBuilder[] },
  ): Promise<unknown>;
  replyInfoEmbed(
    interaction: ChatInputCommandInteraction,
    locale: string,
    options: StandardEmbedOptions,
    flags?: MessageFlags,
  ): Promise<void>;
}

const defaultDependencies: ConfigExportDependencies = {
  exportWorkspaceConfig: (serverDiscId) => exportRepository.exportWorkspaceConfig(serverDiscId),
  exportPersonalConfig: (userDiscId) => exportRepository.exportPersonalConfig(userDiscId),
  deliverDirectMessage: (interaction, payload) => interaction.user.send(payload),
  replyInfoEmbed,
};

/** The receipt and DM name the exported scope by this word, so it reads as the thing the reader asked for. */
const EXPORT_TYPE_LABEL_KEYS: Record<ConfigExportScope, string> = {
  workspace: "commands.data.export.type_choice_server_config",
  personal: "commands.data.export.type_choice_personal_settings",
};

/**
 * The export operation shared by `/export config` and `/export personal config`, which differ only in their
 * authorization requirement and their destination key.
 */
export async function runConfigExport(
  interaction: ChatInputCommandInteraction,
  locale: string,
  scope: ConfigExportScope,
  overrides: Partial<ConfigExportDependencies> = {},
): Promise<void> {
  const dependencies: ConfigExportDependencies = { ...defaultDependencies, ...overrides };
  const typeLabel = localizer(locale, EXPORT_TYPE_LABEL_KEYS[scope]);
  const destinationKey = scope === "workspace" ? resolveWorkspaceTransferKey(interaction) : interaction.user.id;

  try {
    if (scope === "workspace" && !isWorkspaceTransferAuthorized(interaction)) {
      await dependencies.replyInfoEmbed(interaction, locale, {
        titleKey: "commands.data.export.no_permission_title",
        descriptionKey: "commands.data.export.no_permission_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Acknowledge before the configuration read and the DM, both of which outlive Discord's three-second window.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const exportResult =
      scope === "workspace"
        ? await dependencies.exportWorkspaceConfig(destinationKey)
        : await dependencies.exportPersonalConfig(destinationKey);

    if (!exportResult.success || !exportResult.data) {
      await dependencies.replyInfoEmbed(interaction, locale, {
        titleKey: "commands.data.export.failed_title",
        descriptionKey: exportResult.error ?? "commands.data.export.failed_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const attachment = new AttachmentBuilder(Buffer.from(JSON.stringify(exportResult.data, null, 2), "utf-8"), {
      name: buildTransferExportFileName({
        scope,
        category: "config",
        subject: resolveTransferExportSubject(scope, interaction),
      }),
    });

    try {
      await dependencies.deliverDirectMessage(interaction, {
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "commands.data.export.dm_title"))
            .setDescription(localizer(locale, "commands.data.export.dm_description", { type: typeLabel }))
            .setColor(ColorCode.INFO),
        ],
        files: [attachment],
      });

      await dependencies.replyInfoEmbed(interaction, locale, {
        titleKey: "commands.data.export.success_title",
        descriptionKey: "commands.data.export.success_description",
        descriptionVars: { type: typeLabel },
        color: ColorCode.SUCCESS,
        flags: MessageFlags.Ephemeral,
      });
    } catch (dmError) {
      // The export read is non-destructive, so a closed DM needs only its own receipt and no compensating write.
      log.warn(`Failed to send config export DM to user ${interaction.user.id}:`, dmError as Error);
      await dependencies.replyInfoEmbed(interaction, locale, {
        titleKey: "commands.data.export.dm_failed_title",
        descriptionKey: "commands.data.export.dm_failed_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (error) {
    log.error(`Error executing the ${scope} config export:`, error, {
      errorType: "CommandExecutionError",
      metadata: { commandName: `${scope} config export` },
    });

    await dependencies.replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
  }
}
