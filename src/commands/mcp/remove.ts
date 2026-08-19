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
import { promptWithRawModal } from "@/utils/discord/ui/modals";
import type { UserRow, ErrorContext } from "@/types/db/schema";
import type { CheckboxGroupOption, ModalCheckboxGroupField } from "@/types/discord/modal";
import { mcpConfigOperations } from "@/utils/mcp/mcpConfigOperations";

const MODAL_CUSTOM_ID = "config_mcp_remove_modal";
const SERVER_CHECKBOX_ID_PREFIX = "mcp_server_checkbox_group";
const MAX_OPTIONS_PER_GROUP = 10;
const MAX_GROUPS_PER_MODAL = 5;
const MAX_ENTRIES_PER_MODAL = MAX_OPTIONS_PER_GROUP * MAX_GROUPS_PER_MODAL;

/**
 * Configure the /mcp remove subcommand.
 * No options needed: server selection happens via modal string select.
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("remove").setDescription(localizer("en-US", "commands.mcp.remove.description"));

/**
 * Execute /mcp remove.
 * Shows checkbox groups of registered guild MCP servers. Checked entries stay;
 * unchecked entries are removed, disconnected, and purged from cache.
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

    // Discord checkbox groups allow at most 10 options each and 5 groups per modal
    const serverGroupCount = Math.ceil(configs.length / MAX_OPTIONS_PER_GROUP);
    if (serverGroupCount > MAX_GROUPS_PER_MODAL) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.mcp.remove.too_many_title",
        descriptionKey: "commands.mcp.remove.too_many_description",
        descriptionVars: {
          count: configs.length.toString(),
          max_entries: MAX_ENTRIES_PER_MODAL.toString(),
          max_groups: MAX_GROUPS_PER_MODAL.toString(),
        },
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const checkboxGroups = buildServerCheckboxGroups(configs);

    // Show modal with checkbox groups (modal is the acknowledgment; no pre-defer)
    const modalResult = await promptWithRawModal(
      interaction,
      locale,
      {
        modalCustomId: MODAL_CUSTOM_ID,
        modalTitleKey: "commands.mcp.remove.modal_title",
        components: checkboxGroups,
      },
      MessageFlags.Ephemeral,
    );

    if (modalResult.outcome !== "submit") {
      log.info(`[MCP Remove] Modal ${modalResult.outcome} for user ${userData.user_id}`);
      return;
    }

    if (!modalResult.interaction) {
      log.error("[MCP Remove] Modal submit interaction is undefined");
      return;
    }
    const replyInteraction = modalResult.interaction;

    const checkedServerNames = new Set<string>();
    for (let groupIndex = 0; groupIndex < serverGroupCount; groupIndex++) {
      const groupValues = modalResult.multiValues?.[`${SERVER_CHECKBOX_ID_PREFIX}_${groupIndex}`] ?? [];
      for (const serverName of groupValues) {
        checkedServerNames.add(serverName);
      }
    }

    // Resolve unchecked entries as removals
    const configsToRemove = configs.filter((config) => !checkedServerNames.has(config.name));
    if (configsToRemove.length === 0) {
      await replyInfoEmbed(replyInteraction, locale, {
        titleKey: "commands.mcp.remove.no_removals_title",
        descriptionKey: "commands.mcp.remove.no_removals_description",
        color: ColorCode.INFO,
      });
      return;
    }

    const deletionResults = await Promise.all(
      configsToRemove.map(async (config) => ({
        config,
        result:
          typeof config.guild_mcp_id === "number"
            ? await mcpConfigOperations.remove({
                serverId: tomoriState.server_id,
                serverDiscId: serverId,
                guildMcpId: config.guild_mcp_id,
              })
            : { status: "not-found" as const },
      })),
    );
    const removedConfigs = deletionResults
      .filter(({ result }) => result.status === "success")
      .map(({ config }) => config);
    const failedConfigs = deletionResults
      .filter(({ result }) => result.status !== "success")
      .map(({ config }) => config);

    if (failedConfigs.length > 0) {
      const context: ErrorContext = {
        userId: userData.user_id,
        serverId: tomoriState.server_id,
        personaId: null,
        errorType: "DatabaseDeleteError",
        metadata: {
          command: "mcp remove",
          failedNames: failedConfigs.map((config) => config.name),
        },
      };
      await log.error(
        "Failed to delete one or more MCP servers",
        new Error("deleteGuildMcpServer returned false for one or more entries"),
        context,
      );
      await replyInfoEmbed(replyInteraction, locale, {
        titleKey: "general.errors.update_failed_title",
        descriptionKey: "general.errors.update_failed_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    await replyInfoEmbed(replyInteraction, locale, {
      titleKey: "commands.mcp.remove.success_title",
      descriptionKey: "commands.mcp.remove.success_description",
      descriptionVars: {
        servers_removed: formatRemovedNames(removedConfigs.map((config) => `\`${config.name}\``)),
      },
      color: ColorCode.SUCCESS,
    });

    log.success(
      `[MCP Remove] Removed ${removedConfigs.length} server(s) for guild ${serverId}: ${removedConfigs.map((config) => config.name).join(", ")}`,
    );
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: null,
      personaId: null,
      errorType: "CommandExecutionError",
      metadata: { command: "mcp remove" },
    };
    await log.error("Error executing /mcp remove", error as Error, context);

    await interaction.followUp({
      content: localizer(locale, "general.errors.unknown_error_description"),
      flags: MessageFlags.Ephemeral,
    });
  }
}

function buildServerCheckboxGroups(configs: { name: string; url: string }[]): ModalCheckboxGroupField[] {
  const checkboxGroups: ModalCheckboxGroupField[] = [];

  for (let i = 0; i < configs.length; i += MAX_OPTIONS_PER_GROUP) {
    const chunk = configs.slice(i, i + MAX_OPTIONS_PER_GROUP);
    const groupIndex = Math.floor(i / MAX_OPTIONS_PER_GROUP);
    const options: CheckboxGroupOption[] = chunk.map((config) => ({
      label: config.name,
      value: config.name,
      description: getServerHostLabel(config.url),
      default: true,
    }));

    checkboxGroups.push({
      kind: "checkboxGroup",
      customId: `${SERVER_CHECKBOX_ID_PREFIX}_${groupIndex}`,
      labelKey:
        groupIndex === 0 ? "commands.mcp.remove.checkbox_label" : "commands.mcp.remove.checkbox_label_continued",
      descriptionKey: groupIndex === 0 ? "commands.mcp.remove.checkbox_description" : undefined,
      minValues: 0,
      required: false,
      options,
    });
  }

  return checkboxGroups;
}

function getServerHostLabel(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function formatRemovedNames(names: string[]): string {
  const maxVisibleNames = 10;
  const visibleNames = names.slice(0, maxVisibleNames);
  const suffix = names.length > maxVisibleNames ? ", ..." : "";
  return `${visibleNames.join(", ")}${suffix}`;
}
