import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import { getCachedTomoriState } from "@/utils/cache/tomoriStateCache";
import { getCachedGuildMcpConfigs } from "@/utils/cache/guildMcpConfigCache";
import { localizer } from "@/utils/text/localizer";
import { log, ColorCode } from "@/utils/misc/logger";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import type { UserRow, ErrorContext } from "@/types/db/schema";

/** Map server_type values to locale keys for display labels */
const SERVER_TYPE_LABEL_KEYS: Record<string, string> = {
  web_search: "commands.mcp.add.web_search_option",
  url_fetcher: "commands.mcp.add.url_fetcher_option",
};

/**
 * Configure the /mcp list subcommand.
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("list").setDescription(localizer("en-US", "commands.mcp.list.description"));

/**
 * Execute /mcp list.
 * Shows all registered guild MCP servers with status info.
 *
 */
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

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const serverId = interaction.guild?.id ?? interaction.user.id;
    const tomoriState = await getCachedTomoriState(serverId);
    if (!tomoriState) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    // Load all configs (enabled + disabled)
    const configs = await getCachedGuildMcpConfigs(tomoriState.server_id);

    if (configs.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.mcp.list.empty_title",
        descriptionKey: "commands.mcp.list.empty_description",
        color: ColorCode.INFO,
      });
      return;
    }

    const serverLines = configs.map((config) => {
      let maskedDomain: string;
      try {
        const parsed = new URL(config.url);
        maskedDomain = parsed.hostname;
      } catch {
        maskedDomain = "unknown";
      }

      const statusEmoji = config.is_enabled ? "✅" : "❌";
      const hasAuth = config.auth_token ? "🔑" : "";
      const typeLabel =
        config.server_type && SERVER_TYPE_LABEL_KEYS[config.server_type]
          ? ` 🏷️ ${localizer(locale, SERVER_TYPE_LABEL_KEYS[config.server_type])}`
          : "";
      return `${statusEmoji} **${config.name}** ・ \`${maskedDomain}\` ${hasAuth}${typeLabel}`;
    });

    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.mcp.list.title",
      descriptionKey: "commands.mcp.list.header_description",
      descriptionVars: {
        count: String(configs.length),
        servers: serverLines.join("\n"),
      },
      color: ColorCode.INFO,
    });
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: null,
      personaId: null,
      errorType: "CommandExecutionError",
      metadata: { command: "mcp list" },
    };
    await log.error("Error executing /mcp list", error as Error, context);

    await interaction.followUp({
      content: localizer(locale, "general.errors.unknown_error_description"),
      flags: MessageFlags.Ephemeral,
    });
  }
}
