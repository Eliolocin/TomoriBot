import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { MessageFlags } from "discord.js";
import type { ErrorContext, UserRow } from "@/types/db/schema";
import type { SelectOption } from "@/types/discord/modal";
import { getCachedTomoriState, invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { llmProviderRepo } from "@/utils/db/repositories";
import { promptWithPaginatedModal, safeSelectOptionText } from "@/utils/discord/ui/modals";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { log, ColorCode } from "@/utils/misc/logger";
import { setActiveCustomEndpoint } from "@/utils/provider/customEndpointService";
import { localizer } from "@/utils/text/localizer";

const MODAL_CUSTOM_ID = "config_model_speech_modal";
const ENDPOINT_SELECT_ID = "speech_endpoint_select";

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("speech").setDescription(localizer("en-US", "commands.model.speech.description"));

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

  const serverDiscId = interaction.guild?.id ?? interaction.user.id;
  const tomoriState = await getCachedTomoriState(serverDiscId);
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
    const endpoints = (await llmProviderRepo.loadCustomEndpointsForServer(tomoriState.server_id)).filter(
      (endpoint) => endpoint.capability === "speech" && endpoint.custom_endpoint_id !== undefined,
    );

    if (endpoints.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.model.speech.no_endpoints_title",
        descriptionKey: "commands.model.speech.no_endpoints_description",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const options: SelectOption[] = endpoints.map((endpoint) => ({
      label: safeSelectOptionText(`${endpoint.label} (${endpoint.capability})`),
      value: String(endpoint.custom_endpoint_id),
      description: safeSelectOptionText(
        localizer(locale, "commands.model.speech.endpoint_description", {
          label: endpoint.label,
          api_style: endpoint.api_style,
          active: endpoint.is_default ? localizer(locale, "commands.model.speech.active_marker") : "",
        }),
      ),
    }));

    const modalResult = await promptWithPaginatedModal(interaction, locale, {
      modalCustomId: MODAL_CUSTOM_ID,
      modalTitleKey: "commands.model.speech.modal_title",
      components: [
        {
          customId: ENDPOINT_SELECT_ID,
          labelKey: "commands.model.speech.select_label",
          descriptionKey: "commands.model.speech.select_description",
          placeholder: "commands.model.speech.select_placeholder",
          required: true,
          options,
        },
      ],
    });

    if (modalResult.outcome !== "submit" || !modalResult.interaction) {
      return;
    }

    const selectedEndpointId = Number(modalResult.values?.[ENDPOINT_SELECT_ID]);
    const selectedEndpoint = endpoints.find((endpoint) => endpoint.custom_endpoint_id === selectedEndpointId);
    if (!selectedEndpoint?.custom_endpoint_id) {
      await replyInfoEmbed(modalResult.interaction, locale, {
        titleKey: "general.errors.invalid_option_title",
        descriptionKey: "general.errors.invalid_option_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const selectedLabel = `${selectedEndpoint.label} (${selectedEndpoint.capability})`;
    const previousEndpoint = endpoints.find((endpoint) => endpoint.is_default) ?? null;
    if (previousEndpoint?.custom_endpoint_id === selectedEndpoint.custom_endpoint_id) {
      await replyInfoEmbed(modalResult.interaction, locale, {
        titleKey: "commands.model.speech.already_selected_title",
        descriptionKey: "commands.model.speech.already_selected_description",
        descriptionVars: { endpoint: selectedLabel },
        color: ColorCode.WARN,
      });
      return;
    }

    const updated = await setActiveCustomEndpoint({
      serverId: tomoriState.server_id,
      capability: "speech",
      customEndpointId: selectedEndpoint.custom_endpoint_id,
    });

    if (!updated) {
      await replyInfoEmbed(modalResult.interaction, locale, {
        titleKey: "general.errors.update_failed_title",
        descriptionKey: "general.errors.update_failed_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    invalidateTomoriStateCache(serverDiscId);
    await replyInfoEmbed(modalResult.interaction, locale, {
      titleKey: "commands.model.speech.success_title",
      descriptionKey:
        previousEndpoint && previousEndpoint.api_style !== selectedEndpoint.api_style
          ? "commands.model.speech.success_source_changed_description"
          : "commands.model.speech.success_description",
      descriptionVars: {
        endpoint: selectedLabel,
        voice_assign_command: "`/speech voice-assign`",
      },
      color: ColorCode.SUCCESS,
    });
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: tomoriState.server_id,
      personaId: tomoriState.persona_id,
      errorType: "CommandExecutionError",
      metadata: {
        command: "model speech",
        guildId: interaction.guild?.id ?? interaction.user.id,
      },
    };
    await log.error("Error executing /model speech", error as Error, context);
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
  }
}
