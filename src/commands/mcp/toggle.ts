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
import { promptWithRawModal, safeSelectOptionText } from "@/utils/discord/ui/modals";
import type { UserRow, ErrorContext } from "@/types/db/schema";
import type { SelectOption } from "@/types/discord/modal";
import { mcpConfigOperations } from "@/utils/mcp/mcpConfigOperations";

const MODAL_CUSTOM_ID = "config_mcp_toggle_modal";
const SERVER_SELECT_ID = "mcp_server_select";
const STATE_SELECT_ID = "mcp_enabled_select";

/**
 * Configure the /mcp toggle subcommand.
 * No options needed: server and state selection happen via modal string selects.
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("toggle").setDescription(localizer("en-US", "commands.mcp.toggle.description"));

/**
 * Execute /mcp toggle.
 * Shows a modal with a string select for the server name and an enable/disable select,
 * then updates the database and manages the connection pool accordingly.
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

  const serverId = interaction.guild?.id ?? interaction.user.id;
  const tomoriState = await getCachedTomoriState(serverId);
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
    const configs = await getCachedGuildMcpConfigs(tomoriState.server_id);
    if (configs.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.mcp.list.empty_title",
        descriptionKey: "commands.mcp.list.empty_description",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const serverOptions: SelectOption[] = configs.map((config) => ({
      label: safeSelectOptionText(config.name),
      value: config.name,
      description: safeSelectOptionText(
        `${config.is_enabled ? localizer(locale, "commands.mcp.toggle.currently_enabled") : localizer(locale, "commands.mcp.toggle.currently_disabled")} · ${new URL(config.url).hostname}`,
      ),
    }));

    // Show modal with server select + enable checkbox group (modal is the acknowledgment; no pre-defer)
    const modalResult = await promptWithRawModal(
      interaction,
      locale,
      {
        modalCustomId: MODAL_CUSTOM_ID,
        modalTitleKey: "commands.mcp.toggle.modal_title",
        components: [
          {
            customId: SERVER_SELECT_ID,
            labelKey: "commands.mcp.toggle.select_label",
            descriptionKey: "commands.mcp.toggle.select_description",
            placeholder: "commands.mcp.toggle.select_placeholder",
            required: true,
            options: serverOptions,
          },
          {
            // Checkbox Group 1 option: checked = enable, unchecked = disable.
            // min_values: 0 + required: false allows unchecked (disable) submission.
            // Result comes back in modalResult.multiValues[STATE_SELECT_ID] as string[].
            kind: "checkboxGroup" as const,
            customId: STATE_SELECT_ID,
            labelKey: "commands.mcp.toggle.state_label",
            descriptionKey: "commands.mcp.toggle.state_description",
            minValues: 0,
            required: false,
            options: [
              {
                label: localizer(locale, "commands.mcp.toggle.enable_option"),
                value: "enable",
                description: localizer(locale, "commands.mcp.toggle.enable_option_description"),
              },
            ],
          },
        ],
      },
      MessageFlags.Ephemeral,
    );

    if (modalResult.outcome !== "submit") {
      log.info(`[MCP Toggle] Modal ${modalResult.outcome} for user ${userData.user_id}`);
      return;
    }

    if (!modalResult.interaction) {
      log.error("[MCP Toggle] Modal submit interaction is undefined");
      return;
    }
    const replyInteraction = modalResult.interaction;

    const name = modalResult.values?.[SERVER_SELECT_ID]?.trim();
    if (!name) {
      await replyInfoEmbed(replyInteraction, locale, {
        titleKey: "commands.mcp.toggle.not_found_title",
        descriptionKey: "commands.mcp.toggle.not_found_description",
        descriptionVars: { name: "unknown" },
        color: ColorCode.WARN,
      });
      return;
    }

    // Checkbox Group: "enable" in multiValues = enabled, absent = disabled
    const enabled = (modalResult.multiValues?.[STATE_SELECT_ID] ?? []).includes("enable");

    const selected = configs.find((config) => config.name === name);
    const result =
      typeof selected?.guild_mcp_id === "number"
        ? await mcpConfigOperations.setEnabled({
            serverId: tomoriState.server_id,
            serverDiscId: serverId,
            guildMcpId: selected.guild_mcp_id,
            enabled,
          })
        : { status: "not-found" as const };
    if (result.status !== "success" && result.status !== "unchanged") {
      await replyInfoEmbed(replyInteraction, locale, {
        titleKey: "commands.mcp.toggle.not_found_title",
        descriptionKey: "commands.mcp.toggle.not_found_description",
        descriptionVars: { name },
        color: ColorCode.WARN,
      });
      return;
    }

    const titleKey = enabled
      ? "commands.mcp.toggle.enabled_success_title"
      : "commands.mcp.toggle.disabled_success_title";
    const descriptionKey = enabled
      ? "commands.mcp.toggle.enabled_success_description"
      : "commands.mcp.toggle.disabled_success_description";

    await replyInfoEmbed(replyInteraction, locale, {
      titleKey,
      descriptionKey,
      descriptionVars: { name },
      color: enabled ? ColorCode.SUCCESS : ColorCode.WARN,
    });

    log.success(`[MCP Toggle] Server "${name}" ${enabled ? "enabled" : "disabled"} for guild ${serverId}`);
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: null,
      personaId: null,
      errorType: "CommandExecutionError",
      metadata: { command: "mcp toggle" },
    };
    await log.error("Error executing /mcp toggle", error as Error, context);

    await interaction.followUp({
      content: localizer(locale, "general.errors.unknown_error_description"),
      flags: MessageFlags.Ephemeral,
    });
  }
}
