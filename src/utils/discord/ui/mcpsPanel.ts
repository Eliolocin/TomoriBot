import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  TextInputStyle,
  type ActionRowData,
  type ButtonComponentData,
  type ComponentInContainerData,
  type TopLevelComponentData,
} from "discord.js";
import type { GuildMcpServerRow } from "@/types/db/schema";
import type { RawDiscordComponent } from "@/types/discord/rawApiTypes";
import type { PanelReadStatus, PanelReceipt } from "@/types/discord/panel";
import { escapeDiscordMarkdown } from "@/utils/text/discordMarkdown";
import { buildMcpsRouteId } from "@/utils/discord/mcpsPanelCatalog";
import { buildPanelContainer, buildPanelReceiptContainer, withLinePrefix } from "@/utils/discord/ui/panel";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import { MAX_MCP_SERVERS_PER_WORKSPACE, safeMcpEndpoint } from "@/utils/mcp/mcpConfigOperations";
import { formatMcpToolNamesForDiscord } from "@/utils/mcp/mcpToolSnapshot";
import { localizer } from "@/utils/text/localizer";

const MAX_DEFENSIVE_RENDERED_MCP_ROWS = 6;

export type McpsPanelPage =
  | { kind: "collection"; selectedId?: number; rangeIndex?: number; removedIndex?: number }
  | { kind: "remove"; entityId: number };

export interface McpsPanelPayload {
  components: TopLevelComponentData[];
  flags: MessageFlags.IsComponentsV2;
}

export interface McpsPanelRenderInput {
  locale: string;
  scope: "guild" | "dm";
  configs: GuildMcpServerRow[];
  readStatus: PanelReadStatus;
  page: McpsPanelPage;
  receipt?: PanelReceipt;
}

function rowId(row: GuildMcpServerRow): number {
  return row.guild_mcp_id ?? 0;
}

export function sortMcpConfigs(configs: readonly GuildMcpServerRow[]): GuildMcpServerRow[] {
  return [...configs].sort((left, right) => {
    const createdDifference = (left.created_at?.getTime() ?? 0) - (right.created_at?.getTime() ?? 0);
    return createdDifference || rowId(left) - rowId(right);
  });
}

function typeLabelKey(serverType: string | null | undefined): string {
  if (serverType === "web_search") return "commands.mcps.type_web_search";
  if (serverType === "url_fetcher") return "commands.mcps.type_url_fetcher";
  return "commands.mcps.type_general";
}

function buildRetryRow(locale: string, selectedId: number | "none"): ActionRowData<ButtonComponentData> {
  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildMcpsRouteId({ action: "retry", locale, selectedId }),
        label: localizer(locale, "commands.mcps.retry"),
      },
    ],
  };
}

function buildEmptyState(
  locale: string,
  scope: "guild" | "dm",
  configs: GuildMcpServerRow[],
  writesDisabled: boolean,
): ComponentInContainerData[] {
  const buttons: ButtonComponentData[] = [
    {
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      customId: buildMcpsRouteId({ action: "add-open", locale }),
      label: localizer(locale, "commands.mcps.add"),
      disabled: writesDisabled || configs.length >= MAX_MCP_SERVERS_PER_WORKSPACE,
    },
  ];
  if (writesDisabled) buttons.push(buildRetryRow(locale, "none").components[0]);
  return [
    {
      type: ComponentType.TextDisplay,
      content: localizer(locale, scope === "guild" ? "commands.mcps.empty_guild" : "commands.mcps.empty_dm"),
    },
    { type: ComponentType.Separator, divider: true, spacing: 1 },
    {
      type: ComponentType.ActionRow,
      components: buttons,
    },
    {
      type: ComponentType.TextDisplay,
      content: withLinePrefix("-# ", localizer(locale, "commands.mcps.trust_warning")),
    },
  ];
}

function buildPayload(components: ComponentInContainerData[], receipt?: PanelReceipt): McpsPanelPayload {
  return {
    components: [...(receipt ? [buildPanelReceiptContainer(receipt)] : []), buildPanelContainer(components)],
    flags: MessageFlags.IsComponentsV2,
  };
}

function buildAddArea(
  locale: string,
  configs: GuildMcpServerRow[],
  writesDisabled: boolean,
  overflow: boolean,
): ComponentInContainerData[] {
  const buttons: ButtonComponentData[] = [
    {
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      customId: buildMcpsRouteId({ action: "add-open", locale }),
      label: localizer(locale, "commands.mcps.add"),
      disabled: writesDisabled || overflow || configs.length >= MAX_MCP_SERVERS_PER_WORKSPACE,
    },
  ];
  if (writesDisabled) buttons.push(buildRetryRow(locale, configs[0]?.guild_mcp_id ?? "none").components[0]);
  return [
    { type: ComponentType.Separator, divider: true, spacing: 1 },
    { type: ComponentType.ActionRow, components: buttons },
    {
      type: ComponentType.TextDisplay,
      content: withLinePrefix("-# ", localizer(locale, "commands.mcps.trust_warning")),
    },
  ];
}

export function buildMcpsPanelPayload(input: McpsPanelRenderInput): McpsPanelPayload {
  const configs = sortMcpConfigs(input.configs);
  const writesDisabled = input.readStatus !== "fresh";
  const components: ComponentInContainerData[] = [
    {
      type: ComponentType.TextDisplay,
      content: `## ${localizer(input.locale, "commands.mcps.title")}`,
    },
  ];

  if (input.readStatus === "unavailable") {
    components.push(
      {
        type: ComponentType.TextDisplay,
        content: localizer(input.locale, "commands.mcps.unavailable"),
      },
      buildRetryRow(input.locale, "none"),
    );
    return buildPayload(components, input.receipt);
  }
  if (input.readStatus === "stale") {
    components.push({
      type: ComponentType.TextDisplay,
      content: localizer(input.locale, "commands.mcps.stale_warning"),
    });
  }

  components.push({
    type: ComponentType.TextDisplay,
    content: `### ${localizer(input.locale, "commands.mcps.count", {
      count: configs.length,
      max: MAX_MCP_SERVERS_PER_WORKSPACE,
    })}`,
  });

  if (configs.length === 0) {
    components.push(...buildEmptyState(input.locale, input.scope, configs, writesDisabled));
    return buildPayload(components, input.receipt);
  }

  const removeTargetId = input.page.kind === "remove" ? input.page.entityId : null;
  const removeTarget = removeTargetId === null ? null : configs.find((row) => row.guild_mcp_id === removeTargetId);

  if (removeTarget?.guild_mcp_id) {
    components.push(
      {
        type: ComponentType.TextDisplay,
        content: `### ${localizer(input.locale, "commands.mcps.remove_title")}\n${localizer(
          input.locale,
          "commands.mcps.remove_description",
          { name: escapeDiscordMarkdown(removeTarget.name) },
        )}`,
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Danger,
            customId: buildMcpsRouteId({
              action: "remove-confirm",
              locale: input.locale,
              entityId: removeTarget.guild_mcp_id,
            }),
            label: localizer(input.locale, "commands.mcps.remove_confirm"),
            disabled: writesDisabled,
          },
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildMcpsRouteId({
              action: "remove-cancel",
              locale: input.locale,
              entityId: removeTarget.guild_mcp_id,
            }),
            label: localizer(input.locale, "commands.mcps.cancel"),
          },
        ],
      },
    );
    return buildPayload(components, input.receipt);
  }

  const visibleConfigs = configs.slice(0, MAX_DEFENSIVE_RENDERED_MCP_ROWS);
  for (const row of visibleConfigs) {
    const endpoint = safeMcpEndpoint(row.url) ?? localizer(input.locale, "commands.mcps.endpoint_unavailable");
    const formattedToolNames = row.last_discovered_tool_names
      ? formatMcpToolNamesForDiscord(row.last_discovered_tool_names)
      : null;
    const toolSnapshot =
      row.last_discovered_tool_names == null
        ? localizer(input.locale, "commands.mcps.tools_unknown")
        : formattedToolNames
          ? localizer(input.locale, "commands.mcps.tools_known", { tools: formattedToolNames })
          : localizer(input.locale, "commands.mcps.tools_empty");
    components.push(
      {
        type: ComponentType.TextDisplay,
        content: `- ${escapeDiscordMarkdown(row.name)} (\`${endpoint}\`)\n> ${localizer(
          input.locale,
          "commands.mcps.row_status",
          {
            status: localizer(input.locale, row.is_enabled ? "commands.mcps.enabled" : "commands.mcps.disabled"),
            type: localizer(input.locale, typeLabelKey(row.server_type)),
          },
        )}\n> ${toolSnapshot}`,
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildMcpsRouteId({
              action: "set-enabled",
              locale: input.locale,
              entityId: rowId(row),
              enabled: !row.is_enabled,
            }),
            label: localizer(input.locale, row.is_enabled ? "commands.mcps.disable" : "commands.mcps.enable"),
            disabled: writesDisabled,
          },
          {
            type: ComponentType.Button,
            style: ButtonStyle.Danger,
            customId: buildMcpsRouteId({
              action: "remove-prompt",
              locale: input.locale,
              entityId: rowId(row),
            }),
            label: localizer(input.locale, "commands.mcps.remove"),
            disabled: writesDisabled,
          },
        ],
      },
    );
  }
  const overflow = visibleConfigs.length < configs.length;
  if (overflow) {
    components.push({
      type: ComponentType.TextDisplay,
      content: localizer(input.locale, "commands.mcps.overflow_warning", {
        count: configs.length,
        shown: visibleConfigs.length,
      }),
    });
  }
  components.push(...buildAddArea(input.locale, configs, writesDisabled, overflow));

  return buildPayload(components, input.receipt);
}

export type McpsAddModalField = "name" | "url" | "auth-token" | "server-type";

export function buildMcpsAddModalFieldId(field: McpsAddModalField, nonce: string): string {
  return `${field}_${nonce}`;
}

function textInput(
  locale: string,
  nonce: string,
  field: Exclude<McpsAddModalField, "server-type">,
  options: { label: string; placeholder: string; style: TextInputStyle; maxLength: number; required: boolean },
): RawDiscordComponent {
  return {
    type: 18,
    label: safeSelectOptionText(localizer(locale, options.label), 45),
    component: {
      type: 4,
      custom_id: buildMcpsAddModalFieldId(field, nonce),
      style: options.style,
      placeholder: safeSelectOptionText(localizer(locale, options.placeholder), 100),
      max_length: options.maxLength,
      required: options.required,
    },
  };
}

export function buildAddMcpModal(
  locale: string,
  nonce: string,
): {
  custom_id: string;
  title: string;
  components: RawDiscordComponent[];
} {
  return {
    custom_id: buildMcpsRouteId({ action: "add-submit", locale, nonce }),
    title: safeSelectOptionText(localizer(locale, "commands.mcps.add_modal_title"), 45),
    components: [
      textInput(locale, nonce, "name", {
        label: "commands.mcps.name_label",
        placeholder: "commands.mcps.name_placeholder",
        style: TextInputStyle.Short,
        maxLength: 32,
        required: true,
      }),
      textInput(locale, nonce, "url", {
        label: "commands.mcps.url_label",
        placeholder: "commands.mcps.url_placeholder",
        style: TextInputStyle.Short,
        maxLength: 500,
        required: true,
      }),
      textInput(locale, nonce, "auth-token", {
        label: "commands.mcps.auth_token_label",
        placeholder: "commands.mcps.auth_token_placeholder",
        style: TextInputStyle.Paragraph,
        maxLength: 500,
        required: false,
      }),
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.mcps.server_type_label"), 45),
        description: safeSelectOptionText(localizer(locale, "commands.mcps.server_type_description"), 99),
        component: {
          type: 21,
          custom_id: buildMcpsAddModalFieldId("server-type", nonce),
          required: true,
          options: [
            {
              value: "none",
              label: localizer(locale, "commands.mcps.type_general"),
              description: localizer(locale, "commands.mcps.type_general_description"),
              default: true,
            },
            {
              value: "web_search",
              label: localizer(locale, "commands.mcps.type_web_search"),
              description: localizer(locale, "commands.mcps.type_web_search_description"),
            },
            {
              value: "url_fetcher",
              label: localizer(locale, "commands.mcps.type_url_fetcher"),
              description: localizer(locale, "commands.mcps.type_url_fetcher_description"),
            },
          ],
        },
      },
    ],
  };
}
