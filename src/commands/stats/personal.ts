import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import type { UserRow } from "@/types/db/schema";
import { getCachedTomoriState } from "@/utils/cache/tomoriStateCache";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { localizer } from "@/utils/text/localizer";
import { log, ColorCode } from "@/utils/misc/logger";
import {
  buildPersonalTabs,
  DEFAULT_TIMEFRAME,
  renderStatsDashboard,
  resolveWindowFrom,
  type StatsScope,
  type Timeframe,
  TIMEFRAME_VALUES,
} from "@/utils/stats/statsDashboard";

/**
 * Configures the /stats personal subcommand: the invoking user's own usage stats,
 * with a required timeframe and a scope toggle (this server vs. across all servers).
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("personal")
    .setDescription(localizer("en-US", "commands.stats.personal.description"))
    // Required option first: Discord rejects a required option placed after an optional one.
    .addStringOption((option) =>
      option
        .setName("scope")
        .setDescription(localizer("en-US", "commands.stats.personal.scope_description"))
        .setRequired(true)
        .addChoices(
          { name: localizer("en-US", "commands.choices.this_server"), value: "this_server" },
          { name: localizer("en-US", "commands.choices.global"), value: "global" },
        ),
    )
    .addStringOption((option) =>
      option
        .setName("timeframe")
        .setDescription(localizer("en-US", "commands.stats.personal.timeframe_description"))
        .setRequired(false)
        .addChoices(
          ...TIMEFRAME_VALUES.map((value) => ({ name: localizer("en-US", `commands.choices.${value}`), value })),
        ),
    );

/**
 * Renders the personal stats dashboard for the invoking user.
 */
export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  // Acknowledge publicly before DB reads (dashboard is a public message).
  await interaction.deferReply();

  const guild = interaction.guild;
  if (!guild) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.guild_only_title",
      descriptionKey: "general.errors.guild_only_description",
      color: ColorCode.ERROR,
    });
    return;
  }

  try {
    // Resolve the internal server id; stat reads key on it, not the snowflake.
    const tomoriState = await getCachedTomoriState(guild.id);
    const serverId = tomoriState?.server_id;
    const userId = userData.user_id;
    if (!serverId || !userId) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const timeframe = (interaction.options.getString("timeframe") ?? DEFAULT_TIMEFRAME) as Timeframe;
    const scope = interaction.options.getString("scope", true) as StatsScope;
    const from = resolveWindowFrom(timeframe);
    const scopeServerId = scope === "this_server" ? serverId : undefined;
    const timeframeLabel = localizer(locale, `commands.choices.${timeframe}`);
    const scopeLabel = localizer(
      locale,
      scope === "this_server" ? "commands.choices.this_server" : "commands.choices.global",
    );
    const subtitle = `${interaction.user.displayName} • **${timeframeLabel}** (${scopeLabel})`;

    const tabs = await buildPersonalTabs({
      locale,
      userId,
      userDiscId: userData.user_disc_id,
      serverId,
      guildId: guild.id,
      timeframe,
      from,
      scopeServerId,
      subtitle,
      timezoneOffset: userData.timezone_offset ?? null,
    });

    const iconUrl = interaction.user.displayAvatarURL({ extension: "png", size: 256 });
    await renderStatsDashboard(
      interaction,
      {
        view: "personal",
        locale,
        ownerId: interaction.user.id,
        serverId,
        guildId: guild.id,
        timeframe,
        scope,
        timezoneOffset: userData.timezone_offset ?? null,
      },
      tabs,
      iconUrl,
    );
  } catch (error) {
    await log.error(`Error executing /stats personal for user ${userData.user_disc_id}`, error as Error, {
      userId: userData.user_id,
      errorType: "CommandExecutionError",
      metadata: { command: "stats personal" },
    });
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
    });
  }
}
