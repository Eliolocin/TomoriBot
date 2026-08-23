import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import type { SavedProviderConfigRow, UserRow, ErrorContext } from "@/types/db/schema";
import { llmProviderRepo } from "@/utils/db/repositories";

import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { log, ColorCode } from "@/utils/misc/logger";
import { getProviderDisplayName } from "@/utils/provider/providerInfoRegistry";
import { localizer } from "@/utils/text/localizer";
import { isCustomProvider } from "@/utils/provider/customProviderUtils";
import { cleanupCustomProviderArtifacts } from "@/utils/provider/customEndpointService";
import { promptForSavedProvider } from "@/utils/discord/providerPicker";
import { hasRegisteredCustomProvider } from "@/utils/provider/savedProviderConfig";
import { resolveActivePersonalProviderModelSelections } from "@/utils/provider/personalProviderHelpers";

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("remove").setDescription(localizer("en-US", "commands.personal.provider.remove.description"));

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.channel) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.channel_only_title",
      descriptionKey: "general.errors.channel_only_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!userData.user_id) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    const rawSavedProviders = await llmProviderRepo.loadUserSavedProviderConfigs(userData.user_id);
    const savedProviders = (
      await Promise.all(
        rawSavedProviders.map(async (config) => {
          if (
            !isCustomProvider(config.provider) ||
            (await hasRegisteredCustomProvider(config.provider, { userId: userData.user_id }))
          ) {
            return config;
          }

          return null;
        }),
      )
    ).flatMap((config) => (config ? [config] : []));
    if (savedProviders.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.personal.provider.remove.no_saved_title",
        descriptionKey: "commands.personal.provider.remove.no_saved_description",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const currentSelections = (
      await Promise.all(
        (["text", "embedding", "image", "video", "vision"] as const).map((capability) =>
          resolveActivePersonalProviderModelSelections(savedProviders, capability),
        ),
      )
    ).flat();

    const selection = await promptForSavedProvider(
      interaction,
      locale,
      savedProviders as unknown as SavedProviderConfigRow[],
      {
        alwaysShowPicker: true,
        titleKey: "commands.personal.provider.remove.picker_title",
        descriptionKey: "commands.personal.provider.remove.picker_description",
        currentSelections,
      },
    );
    if (!selection) {
      return;
    }

    const deleted = await llmProviderRepo.deleteUserSavedProviderConfig(userData.user_id, selection.provider);
    if (!deleted) {
      await replyInfoEmbed(selection.interaction, locale, {
        titleKey: "general.errors.update_failed_title",
        descriptionKey: "general.errors.update_failed_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    if (isCustomProvider(selection.provider)) {
      await cleanupCustomProviderArtifacts(selection.provider);
    }

    await replyInfoEmbed(selection.interaction, locale, {
      titleKey: "commands.personal.provider.remove.success_title",
      descriptionKey: "commands.personal.provider.remove.success_description",
      descriptionVars: {
        provider: getProviderDisplayName(selection.provider),
      },
      color: ColorCode.SUCCESS,
    });
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      errorType: "CommandExecutionError",
      metadata: {
        command: "personal provider remove",
        guildId: interaction.guild?.id,
        executorDiscordId: interaction.user.id,
      },
    };
    await log.error("Error executing /personal provider remove", error as Error, context);

    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
  }
}
