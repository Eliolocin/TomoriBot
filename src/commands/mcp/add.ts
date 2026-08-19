import {
  MessageFlags,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type Client,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import { getCachedTomoriState } from "@/utils/cache/tomoriStateCache";
import { localizer } from "@/utils/text/localizer";
import { log, ColorCode } from "@/utils/misc/logger";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { promptWithRawModal } from "@/utils/discord/ui/modals";
import type { UserRow, ErrorContext } from "@/types/db/schema";
import type { RadioGroupOption } from "@/types/discord/modal";
import { mcpConfigOperations } from "@/utils/mcp/mcpConfigOperations";
import type { RemoteUrlValidationResult } from "@/utils/security/remoteUrlSecurity";

const MODAL_CUSTOM_ID = "config_mcp_add_modal";
const NAME_INPUT_ID = "mcp_server_name";
const URL_INPUT_ID = "mcp_server_url";
const AUTH_TOKEN_INPUT_ID = "mcp_auth_token";
const SERVER_TYPE_SELECT_ID = "mcp_server_type";

/**
 * Configure the /mcp add subcommand.
 * Shows a modal for name, URL, optional auth token, and optional server type.
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("add").setDescription(localizer("en-US", "commands.mcp.add.description"));

/**
 * Execute /mcp add.
 * Opens a modal, validates inputs, tests the MCP connection, then persists.
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
    const serverTypeOptions: RadioGroupOption[] = [
      {
        label: localizer(locale, "commands.mcp.add.none_option"),
        value: "none",
        description: localizer(locale, "commands.mcp.add.none_option_description"),
      },
      {
        label: localizer(locale, "commands.mcp.add.web_search_option"),
        value: "web_search",
        description: localizer(locale, "commands.mcp.add.web_search_option_description"),
      },
      {
        label: localizer(locale, "commands.mcp.add.url_fetcher_option"),
        value: "url_fetcher",
        description: localizer(locale, "commands.mcp.add.url_fetcher_option_description"),
      },
    ];

    // Show modal (modal is the acknowledgment; no pre-defer)
    const modalResult = await promptWithRawModal(
      interaction,
      locale,
      {
        modalCustomId: MODAL_CUSTOM_ID,
        modalTitleKey: "commands.mcp.add.modal_title",
        components: [
          {
            customId: NAME_INPUT_ID,
            labelKey: "commands.mcp.add.name_label",
            placeholder: "commands.mcp.add.name_placeholder",
            required: true,
            style: TextInputStyle.Short,
            maxLength: 32,
          },
          {
            customId: URL_INPUT_ID,
            labelKey: "commands.mcp.add.url_label",
            placeholder: "commands.mcp.add.url_placeholder",
            required: true,
            style: TextInputStyle.Short,
            maxLength: 500,
          },
          {
            customId: AUTH_TOKEN_INPUT_ID,
            labelKey: "commands.mcp.add.auth_token_label",
            placeholder: "commands.mcp.add.auth_token_placeholder",
            required: false,
            style: TextInputStyle.Paragraph,
            maxLength: 500,
          },
          {
            kind: "radioGroup" as const,
            customId: SERVER_TYPE_SELECT_ID,
            labelKey: "commands.mcp.add.server_type_label",
            descriptionKey: "commands.mcp.add.server_type_description",
            required: false,
            options: serverTypeOptions,
          },
        ],
      },
      MessageFlags.Ephemeral,
    );

    if (modalResult.outcome !== "submit") {
      log.info(`[MCP Add] Modal ${modalResult.outcome} for user ${userData.user_id}`);
      return;
    }

    const name = modalResult.values?.[NAME_INPUT_ID] ?? "";
    const url = modalResult.values?.[URL_INPUT_ID] ?? "";
    const authToken = modalResult.values?.[AUTH_TOKEN_INPUT_ID]?.trim() || undefined;
    const serverTypeRaw = modalResult.values?.[SERVER_TYPE_SELECT_ID]?.trim();

    if (!modalResult.interaction) {
      log.error("[MCP Add] Modal submit interaction is undefined");
      return;
    }
    const replyInteraction = modalResult.interaction;

    const result = await mcpConfigOperations.add({
      serverId: tomoriState.server_id,
      serverDiscId: serverId,
      name,
      url,
      authToken,
      serverType: serverTypeRaw,
    });

    if (result.status === "invalid-input") {
      await replyInfoEmbed(replyInteraction, locale, {
        titleKey: "commands.mcp.add.invalid_input_title",
        descriptionKey: "commands.mcp.add.invalid_input_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    if (result.status === "invalid-name" || result.status === "invalid-type") {
      await replyInfoEmbed(replyInteraction, locale, {
        titleKey: "commands.mcp.add.invalid_name_title",
        descriptionKey: "commands.mcp.add.invalid_name_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    if (result.status === "invalid-url") {
      const validationMessage = getUrlValidationMessage(locale, result.validation);
      await replyInfoEmbed(replyInteraction, locale, {
        titleKey: "commands.mcp.add.invalid_url_title",
        descriptionKey: validationMessage.descriptionKey,
        descriptionVars: validationMessage.descriptionVars,
        color: ColorCode.ERROR,
      });
      return;
    }

    if (result.status === "limit-reached") {
      await replyInfoEmbed(replyInteraction, locale, {
        titleKey: "commands.mcp.add.limit_reached_title",
        descriptionKey: "commands.mcp.add.limit_reached_description",
        descriptionVars: { max: String(result.max) },
        color: ColorCode.ERROR,
      });
      return;
    }

    if (result.status === "connection-failed") {
      await replyInfoEmbed(replyInteraction, locale, {
        titleKey: "commands.mcp.add.connection_failed_title",
        descriptionKey: "commands.mcp.add.connection_failed_description",
        descriptionVars: { error: result.error },
        color: ColorCode.ERROR,
      });
      return;
    }

    if (result.status === "duplicate-or-write-failed") {
      await replyInfoEmbed(replyInteraction, locale, {
        titleKey: "commands.mcp.add.duplicate_name_title",
        descriptionKey: "commands.mcp.add.duplicate_name_description",
        descriptionVars: { name: result.name },
        color: ColorCode.ERROR,
      });
      return;
    }

    if (result.status === "unavailable") {
      await replyInfoEmbed(replyInteraction, locale, {
        titleKey: "general.errors.update_failed_title",
        descriptionKey: "general.errors.update_failed_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const insertedName = result.row.name;
    let maskedUrl: string;
    try {
      const parsed = new URL(result.row.url);
      maskedUrl = `${parsed.protocol}//${parsed.hostname}`;
    } catch {
      maskedUrl = "unknown";
    }

    await replyInfoEmbed(replyInteraction, locale, {
      titleKey: "commands.mcp.add.success_title",
      descriptionKey: "commands.mcp.add.success_description",
      descriptionVars: {
        name: insertedName,
        url: maskedUrl,
        tool_count: String(result.test.toolCount),
        tool_names: result.test.functionNames.join(", ") || "none",
      },
      color: ColorCode.SUCCESS,
    });

    log.success(
      `[MCP Add] Server "${insertedName}" registered for workspace ${serverId} ` +
        `(${result.test.toolCount} tools: ${result.test.functionNames.join(", ")})`,
    );
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: tomoriState?.server_id ?? null,
      personaId: tomoriState?.persona_id ?? null,
      errorType: "CommandExecutionError",
      metadata: { command: "mcp add" },
    };
    await log.error("Error executing /mcp add", error as Error, context);

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: localizer(locale, "general.errors.unknown_error_description"),
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await interaction.followUp({
        content: localizer(locale, "general.errors.unknown_error_description"),
        flags: MessageFlags.Ephemeral,
      });
    }
  }
}

function getUrlValidationMessage(
  _locale: string,
  validation: RemoteUrlValidationResult,
): {
  descriptionKey: string;
  descriptionVars?: Record<string, string>;
} {
  switch (validation.failureCode) {
    case "INVALID_FORMAT":
      return {
        descriptionKey: "commands.mcp.add.invalid_url_invalid_format_description",
      };
    case "INVALID_PROTOCOL":
      return {
        descriptionKey: "commands.mcp.add.invalid_url_protocol_description",
      };
    case "REMOTE_HTTP_FORBIDDEN":
      return {
        descriptionKey: "commands.mcp.add.invalid_url_http_localhost_only_description",
      };
    case "PRODUCTION_HTTPS_REQUIRED":
      return {
        descriptionKey: "commands.mcp.add.invalid_url_https_required_description",
      };
    case "PRODUCTION_LOCALHOST_FORBIDDEN":
      return {
        descriptionKey: "commands.mcp.add.invalid_url_localhost_blocked_description",
      };
    case "DNS_RESOLUTION_FAILED":
      return {
        descriptionKey: "commands.mcp.add.invalid_url_dns_failed_description",
        descriptionVars: {
          hostname: validation.hostname ?? "unknown",
        },
      };
    case "PRODUCTION_BLOCKED_ADDRESS":
      return {
        descriptionKey: "commands.mcp.add.invalid_url_private_address_description",
        descriptionVars: {
          address: validation.blockedAddress ?? "unknown",
        },
      };
    default:
      return {
        descriptionKey: "commands.mcp.add.invalid_url_invalid_format_description",
      };
  }
}
