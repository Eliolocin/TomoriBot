import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { ButtonStyle, MessageFlags } from "discord.js";
import { executePersonalReset, type PersonalResetOperationInput } from "@/commands/reset/personalResetOperation";
import type { ConfirmationOptions, ConfirmationResult, StandardEmbedOptions } from "@/types/discord/embed";
import type { UserRow } from "@/types/db/schema";
import type { PersonalResetResult } from "@/utils/db/repositories/ResetRepository";
import { commandRegistry } from "@/utils/discord/commandRegistry";
import { promptWithConfirmation } from "@/utils/discord/ui/confirmation";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { ColorCode, log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";

const RESET_CONFIRMATION_TIMEOUT_MS = Number.parseInt(process.env.RESET_CONFIRMATION_TIMEOUT_MS || "60000", 10);

export interface ResetPersonalConfigDependencies {
  promptWithConfirmation(
    interaction: ChatInputCommandInteraction,
    locale: string,
    options: ConfirmationOptions,
  ): Promise<ConfirmationResult>;
  executePersonalReset(input: PersonalResetOperationInput): Promise<PersonalResetResult | null>;
  replyInfoEmbed(
    interaction: ChatInputCommandInteraction,
    locale: string,
    options: StandardEmbedOptions,
    flags?: MessageFlags,
  ): Promise<void>;
}

const defaultDependencies: ResetPersonalConfigDependencies = {
  promptWithConfirmation,
  executePersonalReset,
  replyInfoEmbed,
};

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("config").setDescription(localizer("en-US", "commands.reset.personal.config.description"));

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
  deps: ResetPersonalConfigDependencies = defaultDependencies,
): Promise<void> {
  try {
    const confirmation = await deps.promptWithConfirmation(interaction, locale, {
      embedTitleKey: "commands.reset.personal.config.confirm_title",
      embedDescriptionKey: "commands.reset.personal.config.confirm_description",
      embedDescriptionVars: {
        personal_providers: commandRegistry.getCommandMention("personal", "providers", undefined, true),
        personal_memories: commandRegistry.getCommandMention("personal", "memories", undefined, true),
        scheduled_task_remove: commandRegistry.getCommandMention("scheduled-task", "remove", undefined, true),
      },
      embedColor: ColorCode.ERROR,
      continueStyle: ButtonStyle.Danger,
      cancelStyle: ButtonStyle.Secondary,
      continueLabelKey: "commands.reset.personal.config.confirm_button",
      cancelLabelKey: "general.pagination.cancel",
      continueCustomId: `reset_personal_config_confirm_${interaction.id}`,
      cancelCustomId: `reset_personal_config_cancel_${interaction.id}`,
      timeout: RESET_CONFIRMATION_TIMEOUT_MS,
      useComponentsV2: true,
    });

    if (confirmation.outcome !== "continue") {
      return;
    }

    if (!userData.user_id) {
      await deps.replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.unknown_error_title",
        descriptionKey: "general.errors.unknown_error_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const result = await deps.executePersonalReset({ userId: userData.user_id });
    if (!result) {
      await deps.replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.unknown_error_title",
        descriptionKey: "general.errors.unknown_error_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await deps.replyInfoEmbed(interaction, locale, {
      titleKey: "commands.reset.personal.config.success_title",
      descriptionKey: "commands.reset.personal.config.success_description",
      color: ColorCode.SUCCESS,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    log.error("Error executing /reset personal config:", error, {
      errorType: "CommandExecutionError",
      metadata: { commandName: "reset personal config" },
    });

    await deps.replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
  }
}
