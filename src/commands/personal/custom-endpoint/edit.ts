import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { MessageFlags } from "discord.js";
import type { ErrorContext, UserRow } from "@/types/db/schema";
import { getCachedTomoriState } from "@/utils/cache/tomoriStateCache";
import { llmProviderRepo } from "@/utils/db/repositories";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { log, ColorCode } from "@/utils/misc/logger";
import { executeCustomEndpointEditCommand } from "@/utils/provider/customEndpointEditCommand";
import { localizer } from "@/utils/text/localizer";

/**
 * Phase 4.5: no slash parameters.
 * All fields are collected via the two-step modal chain in executeCustomEndpointEditCommand.
 * Personal endpoints use strict remote URL validation.
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("edit").setDescription(localizer("en-US", "commands.personal.custom_models.edit.description"));

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.channel || !userData.user_id) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.channel_only_title",
      descriptionKey: "general.errors.channel_only_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const tomoriState = await getCachedTomoriState(interaction.guild?.id ?? interaction.user.id);
  if (!tomoriState) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.tomori_not_setup_title",
      descriptionKey: "general.errors.tomori_not_setup_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    await executeCustomEndpointEditCommand({
      interaction,
      locale,
      scope: {
        kind: "personal",
        ownerId: userData.user_id,
        baseConfig: tomoriState.config,
      },
      keys: {
        noneTitle: "commands.personal.custom_models.edit.none_title",
        noneDescription: "commands.personal.custom_models.edit.none_description",
        selectModalTitle: "commands.personal.custom_models.edit.select_modal_title",
        selectLabel: "commands.personal.custom_models.edit.select_label",
        selectDescription: "commands.personal.custom_models.edit.select_description",
        selectPlaceholder: "commands.personal.custom_models.edit.select_placeholder",
        successTitle: "commands.personal.custom_models.edit.success_title",
        successDescription: "commands.personal.custom_models.edit.success_description",
        validationUnreachable: "commands.config.custom_models.validation.unreachable",
        capabilityText: "commands.personal.custom_models.remove.capability_text",
        capabilityEmbedding: "commands.personal.custom_models.remove.capability_embedding",
        capabilityImage: "commands.personal.custom_models.remove.capability_image",
        capabilityVideo: "commands.personal.custom_models.remove.capability_video",
        capabilitySpeech: "commands.personal.custom_models.remove.capability_speech",
        capabilityTranscription: "commands.personal.custom_models.remove.capability_transcription",
      },
      strictRemoteValidation:
        process.env.RUN_ENV === "production" || process.env.ALLOW_PERSONAL_LOCAL_ENDPOINTS !== "true",
      loadEndpoints: (ownerId) => llmProviderRepo.loadCustomEndpointsForUser(ownerId),
    });
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: tomoriState.server_id,
      personaId: tomoriState.persona_id,
      errorType: "CommandExecutionError",
      metadata: {
        command: "personal custom-endpoint edit",
        guildId: interaction.guild?.id,
        executorDiscordId: interaction.user.id,
      },
    };
    await log.error("Error executing /personal custom-endpoint edit", error as Error, context);
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
  }
}
