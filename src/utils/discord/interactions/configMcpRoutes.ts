import {
  MessageFlags,
  type InteractionEditReplyOptions,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { PanelReceipt } from "@/types/discord/panel";
import type { ConfigPanelRoute } from "@/utils/discord/configPanelCatalog";
import { CONFIG_MCP_PANEL_ROUTE_ADAPTER } from "@/utils/discord/configPanelCatalog";
import { performPanelAction, validateAndFallbackPanelPayload } from "@/utils/discord/interactions/panelController";
import {
  isConfigRouteAuthorized,
  resolveConfigActor,
  type ConfigActor,
} from "@/utils/discord/interactions/configPermissionPolicy";
import {
  deniedReceipt,
  repaint,
  type ConfigRouteDependencies,
  type ConfigScope,
} from "@/utils/discord/interactions/configRouteContext";
import type { GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import { buildAddMcpModal, buildMcpsAddModalFieldId, type McpsPanelPage } from "@/utils/discord/ui/mcpsPanel";
import { buildPanelContainer } from "@/utils/discord/ui/panel";
import { buildConfigPanelPayload } from "@/utils/discord/ui/configPanel";
import { formatMcpToolNamesForDiscord } from "@/utils/mcp/mcpToolSnapshot";
import { localizer } from "@/utils/text/localizer";

const MCP_ACTIONS = new Set<ConfigPanelRoute["action"]>([
  "mcp-select",
  "mcp-range",
  "mcp-retry",
  "mcp-refresh",
  "mcp-add-open",
  "mcp-add-type",
  "mcp-add-submit",
  "mcp-set-enabled",
  "mcp-remove-prompt",
  "mcp-remove-cancel",
  "mcp-remove-confirm",
]);

const MCP_MODAL_OPEN_ACTIONS = new Set<ConfigPanelRoute["action"]>(["mcp-add-open", "mcp-add-type"]);

function terminalPayload(locale: string, key: string): InteractionEditReplyOptions {
  return validateAndFallbackPanelPayload(
    {
      components: [
        buildPanelContainer([
          {
            type: 10,
            content: localizer(locale, key),
          },
        ]),
      ],
      flags: MessageFlags.IsComponentsV2,
    },
    locale,
  );
}

function receipt(locale: string, key: string, variables?: Record<string, string | number>): PanelReceipt {
  return {
    tone: key.includes("failed") || key.includes("unavailable") ? "error" : "success",
    heading: localizer(locale, key),
    detail: variables?.detail ? String(variables.detail) : localizer(locale, `${key}_detail`, variables),
  };
}

function addFailureReceipt(locale: string, status: string, detail?: string): PanelReceipt {
  const keyByStatus: Record<string, string> = {
    "invalid-input": "commands.mcps.invalid_input",
    "invalid-name": "commands.mcps.invalid_name",
    "invalid-type": "commands.mcps.invalid_type",
    "invalid-url": "commands.mcps.invalid_url",
    unavailable: "commands.mcps.read_unavailable",
    "limit-reached": "commands.mcps.limit_reached",
    "connection-failed": "commands.mcps.connection_failed",
    "duplicate-or-write-failed": "commands.mcps.write_failed",
  };
  return {
    tone: "error",
    heading: localizer(locale, "commands.mcps.add_failed"),
    detail: detail ?? localizer(locale, keyByStatus[status] ?? "commands.mcps.write_failed"),
  };
}

function changedStateReceipt(locale: string): PanelReceipt {
  return {
    tone: "info",
    heading: localizer(locale, "commands.mcps.changed_receipt"),
    detail: localizer(locale, "commands.mcps.changed_receipt_detail"),
  };
}

function mutationFailureReceipt(locale: string, status: string): PanelReceipt {
  return {
    tone: "error",
    heading: localizer(locale, "commands.mcps.change_failed"),
    detail: localizer(
      locale,
      status === "unavailable" ? "commands.mcps.read_unavailable" : "commands.mcps.write_failed",
    ),
  };
}

function entityPresence(scope: ConfigScope, entityId: number): "present" | "absent" | "unknown" {
  const read = scope.mcpRead;
  if (!read || read.status !== "fresh") return "unknown";
  return read.configs.some((row) => row.guild_mcp_id === entityId) ? "present" : "absent";
}

async function loadMcpRead(
  scope: ConfigScope,
  dependencies: ConfigRouteDependencies,
  forceRefresh = false,
): Promise<NonNullable<ConfigScope["mcpRead"]>> {
  return dependencies.loadMcpRead(scope.personas[0]?.server_id ?? 0, forceRefresh);
}

async function repaintMcp(
  interaction: GlobalRoutableInteraction,
  route: Extract<ConfigPanelRoute, { action: ConfigPanelRoute["action"] }> & { locale: string },
  scope: ConfigScope,
  dependencies: ConfigRouteDependencies,
  page: McpsPanelPage = { kind: "collection" },
  panelReceipt?: PanelReceipt,
  mcpRead = scope.mcpRead,
): Promise<void> {
  const read = mcpRead ?? (await loadMcpRead(scope, dependencies));
  await repaint(interaction, {
    locale: route.locale,
    scope,
    category: "plugins",
    page: "mcp-servers",
    selectedPersonaId: null,
    receipt: panelReceipt,
    mcpRead: read,
    mcpPage: page,
    dependencies,
  });
}

export async function handleConfigMcpModalOpen(
  interaction: GlobalRoutableInteraction,
  route: ConfigPanelRoute,
  dependencies: ConfigRouteDependencies,
  actor: ConfigActor,
): Promise<boolean> {
  if (!MCP_MODAL_OPEN_ACTIONS.has(route.action)) return false;
  if (!isConfigRouteAuthorized(route, actor)) {
    const scope = await dependencies.resolveScope(interaction, false);
    if (!scope) {
      await interaction.reply({
        content: localizer(route.locale, "commands.config.panel.unavailable"),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    const mcpRead = await dependencies.loadMcpRead(scope.personas[0]?.server_id ?? 0);
    const panel = buildConfigPanelPayload({
      locale: route.locale,
      actor,
      category: "plugins",
      page: "mcp-servers",
      personas: scope.personas,
      selectedPersonaId: null,
      readStatus: scope.readStatus,
      mcpRead,
      receipt: deniedReceipt(route.locale),
    });
    await interaction.reply({
      ...panel,
      flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    });
    return true;
  }
  await dependencies.showModal(
    interaction,
    buildAddMcpModal(route.locale, dependencies.createNonce(), CONFIG_MCP_PANEL_ROUTE_ADAPTER),
  );
  return true;
}

export async function handleConfigMcpRoutes(
  interaction: GlobalRoutableInteraction,
  route: ConfigPanelRoute,
  scope: ConfigScope,
  dependencies: ConfigRouteDependencies,
  actor = resolveConfigActor(interaction),
): Promise<boolean> {
  if (!MCP_ACTIONS.has(route.action) || !isConfigRouteAuthorized(route, actor)) return false;

  if (route.action === "mcp-select") {
    const selectedId = Number((interaction as StringSelectMenuInteraction).values[0]);
    const read = await loadMcpRead(scope, dependencies);
    await repaintMcp(
      interaction,
      route,
      scope,
      dependencies,
      { kind: "collection", selectedId, rangeIndex: route.rangeIndex },
      undefined,
      read,
    );
    return true;
  }
  if (route.action === "mcp-range") {
    await repaintMcp(interaction, route, scope, dependencies, { kind: "collection", rangeIndex: route.rangeIndex });
    return true;
  }
  if (route.action === "mcp-retry" || route.action === "mcp-refresh") {
    const read = await loadMcpRead(scope, dependencies, true);
    await repaintMcp(
      interaction,
      route,
      scope,
      dependencies,
      { kind: "collection", selectedId: route.selectedId === "none" ? undefined : route.selectedId },
      undefined,
      read,
    );
    return true;
  }
  if (route.action === "mcp-add-submit") {
    const modal = interaction as ModalSubmitInteraction;
    const fieldId = (field: "name" | "url" | "auth-token") => buildMcpsAddModalFieldId(field, route.nonce);
    const serverType = dependencies.takeSelectValue(modal.id, buildMcpsAddModalFieldId("server-type", route.nonce));
    const state = scope.personas[0];
    if (!state) {
      await interaction.editReply(terminalPayload(route.locale, "commands.config.panel.unavailable"));
      return true;
    }
    const action = await performPanelAction(
      () =>
        dependencies.mcpOperations.add({
          serverId: state.server_id,
          serverDiscId: scope.serverDiscId,
          name: modal.fields.getTextInputValue(fieldId("name")),
          url: modal.fields.getTextInputValue(fieldId("url")),
          authToken: modal.fields.getTextInputValue(fieldId("auth-token")),
          serverType,
        }),
      () => dependencies.resolveScope(interaction, true),
    );
    const refreshed = action.state ?? scope;
    const read = await loadMcpRead(refreshed, dependencies, true);
    if (action.result.status === "success") {
      dependencies.recordAction({
        action: "mcps.workspace.server.add",
        serverId: refreshed.personas[0]?.server_id ?? 0,
        userDiscId: interaction.user?.id ?? "",
      });
      const toolNames = formatMcpToolNamesForDiscord(action.result.test.functionNames);
      await repaintMcp(
        interaction,
        route,
        refreshed,
        dependencies,
        { kind: "collection", selectedId: action.result.row.guild_mcp_id },
        receipt(route.locale, "commands.mcps.added", {
          detail: localizer(
            route.locale,
            toolNames ? "commands.mcps.added_detail_with_tools" : "commands.mcps.added_detail",
            { name: action.result.row.name, count: action.result.test.toolCount, tools: toolNames ?? "" },
          ),
        }),
        read,
      );
      return true;
    }
    const detail = action.result.status === "connection-failed" ? action.result.error : undefined;
    await repaintMcp(
      interaction,
      route,
      refreshed,
      dependencies,
      { kind: "collection" },
      addFailureReceipt(route.locale, action.result.status, detail),
      read,
    );
    return true;
  }

  if (route.action === "mcp-set-enabled") {
    const action = await performPanelAction(
      () =>
        dependencies.mcpOperations.setEnabled({
          serverId: scope.personas[0]?.server_id ?? 0,
          serverDiscId: scope.serverDiscId,
          guildMcpId: route.entityId,
          enabled: route.enabled,
        }),
      () => dependencies.resolveScope(interaction, true),
    );
    const refreshed = action.state ?? scope;
    const read = await loadMcpRead(refreshed, dependencies, true);
    if (action.result.status === "success" || action.result.status === "unchanged") {
      if (action.result.status === "success") {
        dependencies.recordAction({
          action: route.enabled ? "mcps.workspace.server.enable" : "mcps.workspace.server.disable",
          serverId: refreshed.personas[0]?.server_id ?? 0,
          userDiscId: interaction.user?.id ?? "",
        });
      }
      await repaintMcp(
        interaction,
        route,
        refreshed,
        dependencies,
        { kind: "collection", selectedId: route.entityId },
        receipt(
          route.locale,
          action.result.status === "unchanged"
            ? "commands.mcps.unchanged_receipt"
            : route.enabled
              ? "commands.mcps.enabled_receipt"
              : "commands.mcps.disabled_receipt",
          {
            detail: localizer(
              route.locale,
              action.result.status === "unchanged"
                ? "commands.mcps.unchanged_receipt_detail"
                : route.enabled
                  ? "commands.mcps.enabled_receipt_detail"
                  : "commands.mcps.disabled_receipt_detail",
              { name: action.result.row.name },
            ),
          },
        ),
        read,
      );
      return true;
    }
    await repaintMcp(
      interaction,
      route,
      refreshed,
      dependencies,
      { kind: "collection", selectedId: route.entityId },
      action.result.status === "not-found"
        ? changedStateReceipt(route.locale)
        : mutationFailureReceipt(route.locale, action.result.status),
      read,
    );
    return true;
  }

  const read = await loadMcpRead(scope, dependencies);
  const withRead = { ...scope, mcpRead: read };
  if (route.action === "mcp-remove-prompt") {
    const presence = entityPresence(withRead, route.entityId);
    await repaintMcp(
      interaction,
      route,
      withRead,
      dependencies,
      presence === "present" ? { kind: "remove", entityId: route.entityId } : { kind: "collection" },
      presence === "absent" ? changedStateReceipt(route.locale) : undefined,
      read,
    );
    return true;
  }
  if (route.action === "mcp-remove-cancel") {
    const presence = entityPresence(withRead, route.entityId);
    await repaintMcp(
      interaction,
      route,
      withRead,
      dependencies,
      { kind: "collection", selectedId: presence === "present" ? route.entityId : undefined },
      presence === "absent" ? changedStateReceipt(route.locale) : undefined,
      read,
    );
    return true;
  }
  if (route.action === "mcp-remove-confirm") {
    const action = await performPanelAction(
      () =>
        dependencies.mcpOperations.remove({
          serverId: scope.personas[0]?.server_id ?? 0,
          serverDiscId: scope.serverDiscId,
          guildMcpId: route.entityId,
        }),
      () => dependencies.resolveScope(interaction, true),
    );
    const refreshed = action.state ?? scope;
    const refreshedRead = await loadMcpRead(refreshed, dependencies, true);
    if (action.result.status === "success") {
      dependencies.recordAction({
        action: "mcps.workspace.server.remove",
        serverId: refreshed.personas[0]?.server_id ?? 0,
        userDiscId: interaction.user?.id ?? "",
      });
    }
    await repaintMcp(
      interaction,
      route,
      refreshed,
      dependencies,
      { kind: "collection" },
      action.result.status === "success"
        ? receipt(route.locale, "commands.mcps.removed_receipt", {
            detail: localizer(route.locale, "commands.mcps.removed_receipt_detail", { name: action.result.row.name }),
          })
        : action.result.status === "not-found"
          ? changedStateReceipt(route.locale)
          : mutationFailureReceipt(route.locale, action.result.status),
      refreshedRead,
    );
    return true;
  }
  return true;
}
