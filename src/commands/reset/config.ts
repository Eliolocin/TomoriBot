import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { ButtonStyle, MessageFlags } from "discord.js";
import { resetServerConfiguration, type ServerResetOperationInput } from "@/commands/reset/serverResetOperation";
import type { ConfirmationOptions, ConfirmationResult, StandardEmbedOptions } from "@/types/discord/embed";
import type { UserRow } from "@/types/db/schema";
import { commandRegistry } from "@/utils/discord/commandRegistry";
import { serverRepository } from "@/utils/db/repositories/ServerRepository";
import { promptWithConfirmation } from "@/utils/discord/ui/confirmation";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { ColorCode, log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";

const RESET_CONFIRMATION_TIMEOUT_MS = Number.parseInt(process.env.RESET_CONFIRMATION_TIMEOUT_MS || "60000", 10);

export interface ResetConfigDependencies {
  loadServerIdByDiscId(serverDiscId: string): Promise<number | null>;
  promptWithConfirmation(
    interaction: ChatInputCommandInteraction,
    locale: string,
    options: ConfirmationOptions,
  ): Promise<ConfirmationResult>;
  resetServerConfiguration(input: ServerResetOperationInput): Promise<void>;
  replyInfoEmbed(
    interaction: ChatInputCommandInteraction,
    locale: string,
    options: StandardEmbedOptions,
    flags?: MessageFlags,
  ): Promise<void>;
}

const defaultDependencies: ResetConfigDependencies = {
  loadServerIdByDiscId: (serverDiscId) => serverRepository.loadServerIdByDiscId(serverDiscId),
  promptWithConfirmation,
  resetServerConfiguration,
  replyInfoEmbed,
};

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("config").setDescription(localizer("en-US", "commands.reset.config.description"));

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  _userData: UserRow,
  locale: string,
  deps: ResetConfigDependencies = defaultDependencies,
): Promise<void> {
  try {
    if (interaction.guildId) {
      const hasPermission = interaction.memberPermissions?.has("ManageGuild") ?? false;
      if (!hasPermission) {
        await deps.replyInfoEmbed(interaction, locale, {
          titleKey: "commands.reset.config.no_permission_title",
          descriptionKey: "commands.reset.config.no_permission_description",
          color: ColorCode.ERROR,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    const serverDiscId = interaction.guildId ?? interaction.user.id;

    const serverId = await deps.loadServerIdByDiscId(serverDiscId);
    if (!serverId) {
      await deps.replyInfoEmbed(interaction, locale, {
        titleKey: "commands.reset.config.no_server_data_title",
        descriptionKey: "commands.reset.config.no_server_data_description",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const confirmation = await deps.promptWithConfirmation(interaction, locale, {
      embedTitleKey: "commands.reset.config.confirm_title",
      embedDescriptionKey: "commands.reset.config.confirm_description",
      embedDescriptionVars: {
        persona_remove: commandRegistry.getCommandMention("persona", "remove", undefined, true),
        memories: commandRegistry.getCommandMention("memories", undefined, undefined, true),
        personal_memories: commandRegistry.getCommandMention("personal", "memories", undefined, true),
        providers: commandRegistry.getCommandMention("providers", undefined, undefined, true),
        personal_providers: commandRegistry.getCommandMention("personal", "providers", undefined, true),
        scheduled_task_remove: commandRegistry.getCommandMention("scheduled-task", "remove", undefined, true),
        nuke: commandRegistry.getCommandMention("nuke", undefined, undefined, true),
      },
      embedColor: ColorCode.ERROR,
      continueStyle: ButtonStyle.Danger,
      cancelStyle: ButtonStyle.Secondary,
      continueLabelKey: "commands.reset.config.confirm_button",
      cancelLabelKey: "general.pagination.cancel",
      continueCustomId: `reset_config_confirm_${interaction.id}`,
      cancelCustomId: `reset_config_cancel_${interaction.id}`,
      timeout: RESET_CONFIRMATION_TIMEOUT_MS,
      useComponentsV2: true,
    });

    if (confirmation.outcome !== "continue") {
      return;
    }

    await deps.resetServerConfiguration({ serverId, serverDiscId });

    await deps.replyInfoEmbed(interaction, locale, {
      titleKey: "commands.reset.config.success_title",
      descriptionKey: "commands.reset.config.success_description",
      color: ColorCode.SUCCESS,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    log.error("Error executing /reset config:", error, {
      errorType: "CommandExecutionError",
      metadata: { commandName: "reset config" },
    });

    await deps.replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
  }
}
