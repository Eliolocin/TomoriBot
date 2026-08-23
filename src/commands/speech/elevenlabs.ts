import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import { getCachedTomoriState, invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { ColorCode, log } from "@/utils/misc/logger";
import { ELEVENLABS_SERVICE_NAME, validateElevenLabsApiKey } from "@/utils/audio/elevenLabsAccount";
import type { ErrorContext, TomoriState, UserRow } from "@/types/db/schema";
import { registerCustomEndpoint, setActiveCustomEndpoint } from "@/utils/provider/customEndpointService";
import { localizer } from "@/utils/text/localizer";

const MIN_KEY_LENGTH = 10;

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("elevenlabs")
    .setDescription(localizer("en-US", "commands.speech.elevenlabs.description"))
    .addStringOption((option) =>
      option
        .setName("key")
        .setDescription(localizer("en-US", "commands.speech.elevenlabs.key_description"))
        .setRequired(true),
    );

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
  const tomoriState: TomoriState | null = await getCachedTomoriState(serverDiscId);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    if (!tomoriState) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const apiKey = interaction.options.getString("key", true).trim();
    if (apiKey.length < MIN_KEY_LENGTH) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.speech.elevenlabs.invalid_key_title",
        descriptionKey: "commands.speech.elevenlabs.invalid_key_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const validationResult = await validateElevenLabsApiKey(apiKey);
    if (!validationResult.success) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.speech.elevenlabs.key_validation_failed_title",
        descriptionKey: "commands.speech.elevenlabs.key_validation_failed_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const speechRegistration = await registerCustomEndpoint({
      scope: {
        kind: "server",
        ownerId: tomoriState.server_id,
        baseConfig: tomoriState.config,
        serverDiscId,
      },
      label: ELEVENLABS_SERVICE_NAME,
      capability: "speech",
      apiStyle: "elevenlabs",
      endpointUrl: "https://api.elevenlabs.io",
      modelName: null,
      authToken: apiKey,
      extraConfig: { script_markup: "bracket-tags", supports_instruct: false },
    });
    const transcriptionRegistration = await registerCustomEndpoint({
      scope: {
        kind: "server",
        ownerId: tomoriState.server_id,
        baseConfig: tomoriState.config,
        serverDiscId,
      },
      label: ELEVENLABS_SERVICE_NAME,
      capability: "transcription",
      apiStyle: "elevenlabs-transcription",
      endpointUrl: "https://api.elevenlabs.io",
      modelName: null,
      authToken: apiKey,
      extraConfig: {},
    });

    if (
      !speechRegistration?.customEndpoint.custom_endpoint_id ||
      !transcriptionRegistration?.customEndpoint.custom_endpoint_id
    ) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.update_failed_title",
        descriptionKey: "general.errors.update_failed_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    await setActiveCustomEndpoint({
      serverId: tomoriState.server_id,
      capability: "speech",
      customEndpointId: speechRegistration.customEndpoint.custom_endpoint_id,
    });
    await setActiveCustomEndpoint({
      serverId: tomoriState.server_id,
      capability: "transcription",
      customEndpointId: transcriptionRegistration.customEndpoint.custom_endpoint_id,
    });
    invalidateTomoriStateCache(serverDiscId);

    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.speech.elevenlabs.success_title",
      descriptionKey: "commands.speech.elevenlabs.success_description",
      color: ColorCode.SUCCESS,
    });
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: tomoriState?.server_id ?? null,
      personaId: tomoriState?.persona_id ?? null,
      errorType: "CommandExecutionError",
      metadata: {
        command: "speech elevenlabs",
        guildId: interaction.guild?.id ?? interaction.user.id,
        executorDiscordId: interaction.user.id,
      },
    };
    await log.error("Error executing /speech elevenlabs", error as Error, context);
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
  }
}
