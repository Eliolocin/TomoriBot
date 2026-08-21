import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import { configRepository } from "@/utils/db/repositories";
import { getCachedTomoriState, invalidateTomoriStateCache } from "../../utils/cache/tomoriStateCache";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import { replyInfoEmbed } from "../../utils/discord/interactionHelper";
import type { UserRow, ErrorContext } from "../../types/db/schema";

/**
 * Configures the `/server deliberate-trigger-mode` subcommand.
 * Toggles whether the bot requires explicit invocations (@trigger, reply, mention, /respond)
 * instead of firing on plain trigger words.
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("deliberate-trigger-mode")
    .setDescription(localizer("en-US", "commands.server.deliberatetriggermode.description"));

/**
 * Toggles deliberate trigger mode for the server.
 * When enabled, plain trigger words no longer fire the bot, so only direct invocations work:
 * `@{trigger}` prefix, Discord @mention, replies to the persona, or `/respond`.
 */
export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  // Guild is guaranteed by command loader's server category gate
  const guildId = interaction.guild?.id ?? "";

  // Defer the reply before async work to prevent timeout
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const tomoriState = await getCachedTomoriState(guildId);
    if (!tomoriState) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const newValue = !tomoriState.config.deliberate_trigger_mode;

    const updated = await configRepository.updateTriggerBehaviorConfig(tomoriState.server_id, {
      deliberate_trigger_mode: newValue,
    });

    if (!updated) {
      const context: ErrorContext = {
        personaId: tomoriState.persona_id,
        serverId: tomoriState.server_id,
        userId: userData.user_id,
        errorType: "DatabaseUpdateError",
        metadata: {
          command: "server deliberatetriggermode",
          newValue,
          targetTable: "server_trigger_behavior_configs",
        },
      };
      await log.error(
        "Failed to update deliberate_trigger_mode config",
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

    // Invalidate cache after successful write
    invalidateTomoriStateCache(guildId);

    await replyInfoEmbed(interaction, locale, {
      titleKey: newValue
        ? "commands.server.deliberatetriggermode.enabled_title"
        : "commands.server.deliberatetriggermode.disabled_title",
      descriptionKey: newValue
        ? "commands.server.deliberatetriggermode.enabled_description"
        : "commands.server.deliberatetriggermode.disabled_description",
      descriptionVars: {
        persona_name: tomoriState.persona_nickname,
      },
      color: newValue ? ColorCode.SUCCESS : ColorCode.WARN,
    });
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: (await getCachedTomoriState(guildId))?.server_id,
      errorType: "CommandExecutionError",
      metadata: {
        command: "server deliberatetriggermode",
        options: interaction.options?.data,
      },
    };
    await log.error(`Error in /server deliberate-trigger-mode command`, error as Error, context);

    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
    });
  }
}
