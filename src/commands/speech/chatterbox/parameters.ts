import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { MessageFlags } from "discord.js";
import type { ErrorContext, UserRow } from "@/types/db/schema";
import { getCachedTomoriState, invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { configRepository } from "@/utils/db/repositories";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { ensureSpeechCommandAccess } from "@/utils/discord/speechPermission";
import { ColorCode, log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";

const CHATTERBOX_PARAM_MIN = 0;
const CHATTERBOX_DEFAULT_CFG_WEIGHT = 0.5;
const CHATTERBOX_DEFAULT_EXAGGERATION = 0.5;
const CHATTERBOX_DEFAULT_TURBO_ENABLED = true;

function formatNumber(value: number): string {
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function formatBoolean(locale: string, value: boolean): string {
  return value
    ? localizer(locale, "commands.config.panel.voices.parameters.enabled_label")
    : localizer(locale, "commands.config.panel.voices.parameters.disabled_label");
}

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("parameters")
    .setDescription(localizer("en-US", "commands.config.panel.voices.parameters.description"))
    .addNumberOption((option) =>
      option
        .setName("cfg_weight")
        .setDescription(localizer("en-US", "commands.config.panel.voices.parameters.cfg_weight_description"))
        .setRequired(false)
        .setMinValue(CHATTERBOX_PARAM_MIN),
    )
    .addNumberOption((option) =>
      option
        .setName("exaggeration")
        .setDescription(localizer("en-US", "commands.config.panel.voices.parameters.exaggeration_description"))
        .setRequired(false)
        .setMinValue(CHATTERBOX_PARAM_MIN),
    )
    .addBooleanOption((option) =>
      option
        .setName("turbo")
        .setDescription(localizer("en-US", "commands.config.panel.voices.parameters.turbo_description"))
        .setRequired(false),
    );

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!(await ensureSpeechCommandAccess(interaction, locale))) {
    return;
  }

  if (!interaction.channel) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.channel_only_title",
      descriptionKey: "general.errors.channel_only_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const serverDiscId = interaction.guild?.id ?? interaction.user.id;

  try {
    const tomoriState = await getCachedTomoriState(serverDiscId);
    if (!tomoriState) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const currentConfig = tomoriState.config;
    const cfgWeight =
      interaction.options.getNumber("cfg_weight") ??
      currentConfig.chatterbox_cfg_weight ??
      CHATTERBOX_DEFAULT_CFG_WEIGHT;
    const exaggeration =
      interaction.options.getNumber("exaggeration") ??
      currentConfig.chatterbox_exaggeration ??
      CHATTERBOX_DEFAULT_EXAGGERATION;
    const turboEnabled =
      interaction.options.getBoolean("turbo") ??
      currentConfig.chatterbox_turbo_enabled ??
      CHATTERBOX_DEFAULT_TURBO_ENABLED;

    const updated = await configRepository.updateSpeechConfig(tomoriState.server_id, {
      chatterbox_cfg_weight: cfgWeight,
      chatterbox_exaggeration: exaggeration,
      chatterbox_turbo_enabled: turboEnabled,
    });

    if (!updated) {
      const context: ErrorContext = {
        personaId: tomoriState.persona_id,
        serverId: tomoriState.server_id,
        userId: userData.user_id,
        errorType: "DatabaseUpdateError",
        metadata: {
          command: "speech chatterbox parameters",
          targetTable: "server_speech_configs",
        },
      };
      await log.error(
        "Failed to update Chatterbox speech parameters",
        new Error("Database update returned no rows"),
        context,
      );
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.update_failed_title",
        descriptionKey: "general.errors.update_failed_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    invalidateTomoriStateCache(serverDiscId);

    const descriptions = [
      localizer(locale, "commands.config.panel.voices.parameters.success_description", {
        turbo: formatBoolean(locale, turboEnabled),
        cfg_weight: formatNumber(cfgWeight),
        exaggeration: formatNumber(exaggeration),
      }),
    ];

    if (turboEnabled) {
      descriptions.push(localizer(locale, "commands.config.panel.voices.parameters.turbo_notice"));
    } else {
      descriptions.push(localizer(locale, "commands.config.panel.voices.parameters.standard_notice"));
    }

    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.config.panel.voices.parameters.success_title",
      description: descriptions.join("\n\n"),
      color: ColorCode.SUCCESS,
    });
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: (await getCachedTomoriState(serverDiscId))?.server_id,
      errorType: "CommandExecutionError",
      metadata: {
        command: "speech chatterbox parameters",
        options: interaction.options?.data,
      },
    };
    await log.error("Error in /speech chatterbox parameters command", error as Error, context);

    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
    });
  }
}
