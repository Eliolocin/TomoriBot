import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { MessageFlags } from "discord.js";
import { configRepository } from "@/utils/db/repositories";
import { getCachedTomoriState, invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { type ErrorContext, type UserRow, CooldownType } from "@/types/db/schema";
import { localizer } from "@/utils/text/localizer";
import { log, ColorCode } from "@/utils/misc/logger";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";

const MIN_LENGTH = 1;
const MAX_LENGTH = 86400;
const DEFAULT_LENGTH = 5;

const COOLDOWN_TYPE_MIN = 0;
const COOLDOWN_TYPE_MAX = 3; // Disabled type 4 (STRICT_SERVER_WIDE) - users found it redundant
const COOLDOWN_TYPE_DEFAULT = CooldownType.OFF;

/**
 * Configure the subcommand for /server cooldown triggers.
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("triggers")
    .setDescription(localizer("en-US", "commands.server.cooldown.triggers.description"))
    .addIntegerOption((option) =>
      option
        .setName("cooldown_type")
        .setDescription(localizer("en-US", "commands.server.cooldown.triggers.cooldown_type_description"))
        .setRequired(true)
        .addChoices(
          {
            name: localizer("en-US", "commands.server.cooldown.triggers.type.choice_off"),
            value: CooldownType.OFF,
          },
          {
            name: localizer("en-US", "commands.server.cooldown.triggers.type.choice_per_user"),
            value: CooldownType.PER_USER,
          },
          {
            name: localizer("en-US", "commands.server.cooldown.triggers.type.choice_per_channel"),
            value: CooldownType.PER_CHANNEL,
          },
          {
            name: localizer("en-US", "commands.server.cooldown.triggers.type.choice_server_wide"),
            value: CooldownType.SERVER_WIDE,
          },
          // Disabled: Users found STRICT_SERVER_WIDE redundant (no manager exemption)
          // Servers already using type 4 will continue to work - just can't be newly selected
        ),
    )
    .addIntegerOption((option) =>
      option
        .setName("cooldown_length")
        .setDescription(localizer("en-US", "commands.server.cooldown.triggers.cooldown_length_description"))
        .setMinValue(MIN_LENGTH)
        .setMaxValue(MAX_LENGTH)
        .setRequired(true),
    );

/**
 * Configure cooldown type and length for message triggers and manual commands.
 */
export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.guild || !interaction.channel) {
    await replyInfoEmbed(interaction, userData.language_pref, {
      titleKey: "general.errors.guild_only_title",
      descriptionKey: "general.errors.guild_only_description",
      color: ColorCode.ERROR,
    });
    return;
  }

  // Defer the interaction before async work to prevent timeout
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const cooldownTypeValue = interaction.options.getInteger("cooldown_type", true);
    const cooldownLength = interaction.options.getInteger("cooldown_length", true);

    if (cooldownTypeValue < COOLDOWN_TYPE_MIN || cooldownTypeValue > COOLDOWN_TYPE_MAX) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.server.cooldown.triggers.invalid_type_title",
        descriptionKey: "commands.server.cooldown.triggers.invalid_type_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    if (cooldownLength < MIN_LENGTH || cooldownLength > MAX_LENGTH) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.server.cooldown.triggers.invalid_length_title",
        descriptionKey: "commands.server.cooldown.triggers.invalid_length_description",
        descriptionVars: {
          min: MIN_LENGTH.toString(),
          max: MAX_LENGTH.toString(),
        },
        color: ColorCode.ERROR,
      });
      return;
    }

    const tomoriState = await getCachedTomoriState(interaction.guild.id);
    if (!tomoriState) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const currentCooldownType = tomoriState.config.cooldown_type ?? COOLDOWN_TYPE_DEFAULT;
    const currentCooldownLength = tomoriState.config.cooldown_length ?? DEFAULT_LENGTH;
    if (cooldownTypeValue === currentCooldownType && cooldownLength === currentCooldownLength) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.server.cooldown.triggers.already_set_title",
        descriptionKey: "commands.server.cooldown.triggers.already_set_description",
        descriptionVars: {
          type: getCooldownTypeLabel(locale, cooldownTypeValue),
          length: cooldownLength.toString(),
        },
        color: ColorCode.WARN,
      });
      return;
    }

    const updated = await configRepository.updateTriggerBehaviorConfig(tomoriState.server_id, {
      cooldown_type: cooldownTypeValue,
      cooldown_length: cooldownLength,
    });

    if (!updated) {
      const context: ErrorContext = {
        personaId: tomoriState.persona_id,
        serverId: tomoriState.server_id,
        userId: userData.user_id,
        errorType: "DatabaseUpdateError",
        metadata: {
          command: "server cooldown triggers",
          cooldownTypeValue,
          cooldownLength,
          targetTable: "server_trigger_behavior_configs",
        },
      };
      await log.error("Failed to update cooldown config", new Error("Database update returned no rows"), context);

      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.update_failed_title",
        descriptionKey: "general.errors.update_failed_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    // Invalidate cache so next message gets fresh config
    invalidateTomoriStateCache(interaction.guild?.id ?? interaction.user.id);

    const isEnabled = cooldownTypeValue !== CooldownType.OFF;
    await replyInfoEmbed(interaction, locale, {
      titleKey: isEnabled
        ? "commands.server.cooldown.triggers.success_title"
        : "commands.server.cooldown.triggers.success_disabled_title",
      descriptionKey: isEnabled
        ? "commands.server.cooldown.triggers.success_description"
        : "commands.server.cooldown.triggers.success_disabled_description",
      descriptionVars: {
        type: getCooldownTypeLabel(locale, cooldownTypeValue),
        length: cooldownLength.toString(),
        previous_type: getCooldownTypeLabel(locale, currentCooldownType),
        previous_length: currentCooldownLength.toString(),
      },
      color: isEnabled ? ColorCode.SUCCESS : ColorCode.WARN,
    });
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: (await getCachedTomoriState(interaction.guild.id))?.server_id,
      errorType: "CommandExecutionError",
      metadata: {
        command: "server cooldown triggers",
        options: interaction.options?.data,
      },
    };
    await log.error("Error in /server cooldown triggers command", error as Error, context);

    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
    });
  }
}

/**
 * Helper function to get a user-friendly label for cooldown type values.
 */
function getCooldownTypeLabel(locale: string, value: number): string {
  switch (value) {
    case CooldownType.OFF:
      return localizer(locale, "commands.server.cooldown.triggers.type.choice_off");
    case CooldownType.PER_USER:
      return localizer(locale, "commands.server.cooldown.triggers.type.choice_per_user");
    case CooldownType.PER_CHANNEL:
      return localizer(locale, "commands.server.cooldown.triggers.type.choice_per_channel");
    case CooldownType.SERVER_WIDE:
      return localizer(locale, "commands.server.cooldown.triggers.type.choice_server_wide");
    case CooldownType.STRICT_SERVER_WIDE:
      return localizer(locale, "commands.server.cooldown.triggers.type.choice_strict_server_wide");
    default:
      log.warn(`Unexpected cooldown type value encountered in getCooldownTypeLabel: ${value}`);
      return localizer(locale, "commands.server.cooldown.triggers.type.choice_off");
  }
}
