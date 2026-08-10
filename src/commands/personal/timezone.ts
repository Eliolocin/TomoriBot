import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import { userRepository } from "@/utils/db/repositories";
import { localizer } from "@/utils/text/localizer";
import { log, ColorCode } from "@/utils/misc/logger";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import type { UserRow, ErrorContext } from "@/types/db/schema";
import { formatUTCOffset } from "@/utils/text/timezoneHelper";

const TIMEZONE_MIN = -12;
const TIMEZONE_MAX = 14;

/**
 * Configures the /personal timezone subcommand.
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("timezone")
    .setDescription(localizer("en-US", "commands.personal.timezone.description"))
    .addNumberOption((option) =>
      option
        .setName("value")
        .setDescription(localizer("en-US", "commands.personal.timezone.value_description"))
        .setMinValue(TIMEZONE_MIN)
        .setMaxValue(TIMEZONE_MAX)
        .setRequired(false),
    );

/**
 * Sets or clears the personal timezone offset for the invoking user.
 * Omitting the value option clears the timezone (reverts to server timezone).
 */
export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  // Defer ephemerally before async work to prevent timeout
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const userId = userData.user_id;
  if (userId === undefined) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.update_failed_title",
      descriptionKey: "general.errors.update_failed_description",
      color: ColorCode.ERROR,
    });
    return;
  }

  try {
    // Read the optional value; null means "clear"
    const newOffset = interaction.options.getNumber("value", false);
    const currentOffset = userData.timezone_offset ?? null;

    if (newOffset === null) {
      if (currentOffset === null) {
        await replyInfoEmbed(interaction, locale, {
          titleKey: "commands.personal.timezone.already_cleared_title",
          descriptionKey: "commands.personal.timezone.already_cleared_description",
          color: ColorCode.WARN,
        });
        return;
      }

      const cleared = await userRepository.setTimezoneOffset(userId, null);
      if (!cleared) {
        await replyInfoEmbed(interaction, locale, {
          titleKey: "general.errors.update_failed_title",
          descriptionKey: "general.errors.update_failed_description",
          color: ColorCode.ERROR,
        });
        return;
      }

      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.personal.timezone.cleared_title",
        descriptionKey: "commands.personal.timezone.cleared_description",
        color: ColorCode.SUCCESS,
      });
      return;
    }

    // Guard against out-of-range values (Discord enforces this, but double-check)
    if (newOffset < TIMEZONE_MIN || newOffset > TIMEZONE_MAX) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.invalid_option_title",
        descriptionKey: "general.errors.invalid_option_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    if (currentOffset === newOffset) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.personal.timezone.already_set_title",
        descriptionKey: "commands.personal.timezone.already_set_description",
        descriptionVars: {
          timezone: formatUTCOffset(newOffset),
        },
        color: ColorCode.WARN,
      });
      return;
    }

    // Write to database (UserRepository.update invalidates cache internally)
    const updated = await userRepository.setTimezoneOffset(userId, newOffset);
    if (!updated) {
      const context: ErrorContext = {
        userId,
        errorType: "DatabaseUpdateError",
        metadata: {
          command: "personal timezone",
          userDiscId: userData.user_disc_id,
          offsetAttempted: newOffset,
        },
      };
      await log.error(
        "Failed to update user_personalization_configs.timezone_offset",
        new Error("Database update failed"),
        context,
      );

      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.update_failed_title",
        descriptionKey: "general.errors.update_failed_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    if (currentOffset === null) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.personal.timezone.success_new_title",
        descriptionKey: "commands.personal.timezone.success_new_description",
        descriptionVars: {
          timezone: formatUTCOffset(newOffset),
        },
        color: ColorCode.SUCCESS,
      });
    } else {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.personal.timezone.success_title",
        descriptionKey: "commands.personal.timezone.success_description",
        descriptionVars: {
          timezone: formatUTCOffset(newOffset),
          previous_timezone: formatUTCOffset(currentOffset),
        },
        color: ColorCode.SUCCESS,
      });
    }
  } catch (error) {
    const context: ErrorContext = {
      userId,
      errorType: "CommandExecutionError",
      metadata: {
        command: "personal timezone",
        userDiscId: userData.user_disc_id,
        valueAttempted: interaction.options.getNumber("value", false),
      },
    };
    await log.error(`Error executing /personal timezone for user ${userData.user_disc_id}`, error as Error, context);

    if (interaction.deferred && !interaction.replied) {
      await interaction.followUp({
        content: localizer(locale, "general.errors.unknown_error_description"),
        flags: MessageFlags.Ephemeral,
      });
    }
  }
}
