import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import { replyInfoEmbed } from "../../utils/discord/interactionHelper";
import type { UserRow, ErrorContext } from "../../types/db/schema";
import { invalidateUserCache } from "../../utils/cache/userCache";
import { userRepository } from "@/utils/db/repositories";

/** Valid personal DTM mode values */
const DTM_MODES = ["off", "follow", "on"] as const;
type DtmMode = (typeof DTM_MODES)[number];

/**
 * Configures the `/personal deliberate-trigger-mode` subcommand.
 * Lets users choose one of three DTM states that override (or follow) the server setting.
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("deliberate-trigger-mode")
    .setDescription(localizer("en-US", "commands.personal.deliberatetriggermode.description"))
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription(localizer("en-US", "commands.personal.deliberatetriggermode.mode_description"))
        .setRequired(true)
        .addChoices(
          {
            name: localizer("en-US", "commands.personal.deliberatetriggermode.off_option"),
            value: "off",
          },
          {
            name: localizer("en-US", "commands.personal.deliberatetriggermode.follow_option"),
            value: "follow",
          },
          {
            name: localizer("en-US", "commands.personal.deliberatetriggermode.on_option"),
            value: "on",
          },
        ),
    );

/**
 * Sets the personal deliberate trigger mode preference for the invoking user.
 * - `off`: DTM is always disabled for this user, even if the server has it enabled.
 * - `follow`: (default) DTM mirrors the server's setting.
 * - `on`: DTM is always enabled for this user, even if the server has it disabled.
 *              Only direct invocations work: `@{trigger}` prefix, Discord @mention, replies,
 *              or `/respond`.
 */
export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  // Defer the reply before async work to prevent timeout
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const selectedMode = interaction.options.getString("mode", true) as DtmMode;

  try {
    // biome-ignore lint/style/noNonNullAssertion: userData.user_id is always provided by command framework
    const ok = await userRepository.setDeliberateTriggerMode(userData.user_id!, selectedMode);

    if (!ok) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.update_failed_title",
        descriptionKey: "general.errors.update_failed_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    // Invalidate user cache after successful write
    invalidateUserCache(userData.user_disc_id);

    const colorByMode: Record<DtmMode, ColorCode> = {
      off: ColorCode.WARN,
      follow: ColorCode.INFO,
      on: ColorCode.SUCCESS,
    };

    await replyInfoEmbed(interaction, locale, {
      titleKey: `commands.personal.deliberatetriggermode.${selectedMode}_title`,
      descriptionKey: `commands.personal.deliberatetriggermode.${selectedMode}_description`,
      color: colorByMode[selectedMode],
    });
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      errorType: "CommandExecutionError",
      metadata: {
        command: "personal deliberatetriggermode",
        options: interaction.options?.data,
      },
    };
    await log.error(`Error in /personal deliberate-trigger-mode command`, error as Error, context);

    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
    });
  }
}
