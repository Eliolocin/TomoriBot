import {
  ComponentType,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type InteractionEditReplyOptions,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import type { PanelReceipt } from "@/types/discord/panel";
import { getGuildMcpConfigReadResult, type GuildMcpConfigReadResult } from "@/utils/cache/guildMcpConfigCache";
import { getCachedTomoriState } from "@/utils/cache/tomoriStateCache";
import type { GlobalInteractionRoute, GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import { beginPanelInteraction, performPanelAction } from "@/utils/discord/interactions/panelController";
import { MCPS_ROUTE_NAMESPACE, MCPS_ROUTE_VERSION, parseMcpsPanelRoute } from "@/utils/discord/mcpsPanelCatalog";
import { buildAddMcpModal, buildMcpsAddModalFieldId, buildMcpsPanelPayload } from "@/utils/discord/ui/mcpsPanel";
import { showRoutedRawModal, takeRawModalSelectValue } from "@/utils/discord/ui/modals";
import { buildPanelContainer } from "@/utils/discord/ui/panel";
import { mcpConfigOperations, type McpConfigOperations, parseMcpServerType } from "@/utils/mcp/mcpConfigOperations";
import { formatMcpToolNamesForDiscord } from "@/utils/mcp/mcpToolSnapshot";
import { recordPanelActionStat, type RecordPanelActionInput } from "@/utils/stats/panelActionMetrics";
import { localizer } from "@/utils/text/localizer";

export interface McpsScope {
  discordId: string;
  kind: "guild" | "dm";
  state: TomoriState;
  read: GuildMcpConfigReadResult;
}

export interface McpsRouteDependencies {
  resolveScope(
    interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
    forceRefresh?: boolean,
  ): Promise<McpsScope | null>;
  operations: Pick<McpConfigOperations, "add" | "setEnabled" | "remove">;
  recordAction(input: RecordPanelActionInput): void;
  createNonce(): string;
  showAddModal(interaction: ButtonInteraction, locale: string, nonce: string): Promise<void>;
  takeServerType(interactionId: string, nonce: string): string | undefined;
}

function isAuthorized(interaction: GlobalRoutableInteraction): boolean {
  return !interaction.guildId || (interaction.memberPermissions?.has("ManageGuild") ?? false);
}

function terminalPayload(locale: string, key: string): InteractionEditReplyOptions {
  return {
    components: [
      buildPanelContainer([
        {
          type: ComponentType.TextDisplay,
          content: localizer(locale, key),
        },
      ]),
    ],
    flags: MessageFlags.IsComponentsV2,
  };
}

async function resolveScope(
  interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
  forceRefresh = false,
): Promise<McpsScope | null> {
  const discordId = interaction.guildId ?? interaction.user.id;
  const state = await getCachedTomoriState(discordId);
  if (!state) return null;
  return {
    discordId,
    kind: interaction.guildId ? "guild" : "dm",
    state,
    read: await getGuildMcpConfigReadResult(state.server_id, { forceRefresh }),
  };
}

function receipt(locale: string, key: string, variables?: Record<string, string | number>): PanelReceipt {
  return {
    tone: key.includes("failed") || key.includes("unavailable") ? "error" : "success",
    heading: localizer(locale, key),
    detail: variables?.detail ? String(variables.detail) : localizer(locale, `${key}_detail`, variables),
  };
}

async function repaint(
  interaction: GlobalRoutableInteraction,
  locale: string,
  scope: McpsScope,
  page: Parameters<typeof buildMcpsPanelPayload>[0]["page"],
  panelReceipt?: PanelReceipt,
): Promise<void> {
  await interaction.editReply(
    buildMcpsPanelPayload({
      locale,
      scope: scope.kind,
      configs: scope.read.configs,
      readStatus: scope.read.status,
      page,
      receipt: panelReceipt,
    }),
  );
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

function unavailableScope(scope: McpsScope): McpsScope {
  return { ...scope, read: { status: "unavailable", configs: [] } };
}

function entityPresence(scope: McpsScope, entityId: number): "present" | "absent" | "unknown" {
  if (scope.read.status !== "fresh") return "unknown";
  return scope.read.configs.some((row) => row.guild_mcp_id === entityId) ? "present" : "absent";
}

export function createMcpsInteractionRoute(overrides: Partial<McpsRouteDependencies> = {}): GlobalInteractionRoute {
  const dependencies: McpsRouteDependencies = {
    resolveScope,
    operations: mcpConfigOperations,
    recordAction: (input) => {
      void recordPanelActionStat(input);
    },
    createNonce: () => crypto.randomUUID().replaceAll("-", "").slice(0, 12),
    showAddModal: (interaction, locale, nonce) => showRoutedRawModal(interaction, buildAddMcpModal(locale, nonce)),
    takeServerType: (interactionId, nonce) =>
      takeRawModalSelectValue(interactionId, buildMcpsAddModalFieldId("server-type", nonce)),
    ...overrides,
  };
  return {
    namespace: MCPS_ROUTE_NAMESPACE,
    version: MCPS_ROUTE_VERSION,
    async execute(_client, interaction, parsed): Promise<void> {
      const route = parseMcpsPanelRoute(parsed);
      if (!route) throw new Error(`Malformed MCP panel route: ${interaction.customId}`);

      const expectsSelect = route.action === "select" || route.action === "add-type";
      const expectsModal = route.action === "add-submit";
      if (expectsSelect && !interaction.isStringSelectMenu()) {
        throw new Error(`MCP ${route.action} route requires a String Select interaction`);
      }
      if (expectsModal && !interaction.isModalSubmit()) {
        throw new Error("MCP Add submit route requires a modal submission");
      }
      if (!expectsSelect && !expectsModal && !interaction.isButton()) {
        throw new Error(`MCP ${route.action} route requires a button interaction`);
      }

      if (route.action === "add-open" || route.action === "add-page") {
        if (!isAuthorized(interaction)) {
          await interaction.reply({
            content: localizer(route.locale, "commands.mcps.permission_denied"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const nonce = dependencies.createNonce();
        await dependencies.showAddModal(interaction as ButtonInteraction, route.locale, nonce);
        return;
      }

      const initialScope = await beginPanelInteraction({
        acknowledge: () => interaction.deferUpdate(),
        authorize: () => isAuthorized(interaction),
        onDenied: () => {
          if (route.action === "add-submit") dependencies.takeServerType(interaction.id, route.nonce);
          return interaction.editReply(terminalPayload(route.locale, "commands.mcps.permission_denied"));
        },
        load: () => dependencies.resolveScope(interaction, route.action === "retry" || route.action === "refresh"),
        onMissing: () => {
          if (route.action === "add-submit") dependencies.takeServerType(interaction.id, route.nonce);
          return interaction.editReply(terminalPayload(route.locale, "commands.mcps.not_setup"));
        },
      });
      if (!initialScope) return;
      let scope = initialScope;

      if (route.action === "select") {
        const selectedId = Number((interaction as StringSelectMenuInteraction).values[0]);
        if (!Number.isSafeInteger(selectedId) || selectedId <= 0) throw new Error("Invalid selected MCP ID");
        await repaint(interaction, route.locale, scope, {
          kind: "collection",
          selectedId,
          rangeIndex: route.rangeIndex,
        });
        return;
      }
      if (route.action === "range") {
        await repaint(interaction, route.locale, scope, { kind: "collection", rangeIndex: route.rangeIndex });
        return;
      }
      if (route.action === "retry" || route.action === "refresh") {
        await repaint(interaction, route.locale, scope, {
          kind: "collection",
          selectedId: route.selectedId === "none" ? undefined : route.selectedId,
        });
        return;
      }
      if (route.action === "add-type") {
        if (!parseMcpServerType((interaction as StringSelectMenuInteraction).values[0])) {
          throw new Error("Invalid MCP server type selection");
        }
        await repaint(interaction, route.locale, scope, { kind: "collection" });
        return;
      }
      if (route.action === "add-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const legacyModal = route.legacyServerType !== undefined;
        const fieldId = (field: "name" | "url" | "auth-token") =>
          legacyModal ? field : buildMcpsAddModalFieldId(field, route.nonce);
        const serverType =
          route.legacyServerType ?? dependencies.takeServerType(modal.id, route.nonce) ?? "missing-required-type";
        const action = await performPanelAction(
          () =>
            dependencies.operations.add({
              serverId: scope.state.server_id,
              serverDiscId: scope.discordId,
              name: modal.fields.getTextInputValue(fieldId("name")),
              url: modal.fields.getTextInputValue(fieldId("url")),
              authToken: modal.fields.getTextInputValue(fieldId("auth-token")),
              serverType,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? unavailableScope(scope);
        if (result.status === "success") {
          dependencies.recordAction({
            action: "mcps.workspace.server.add",
            serverId: scope.state.server_id,
            userDiscId: interaction.user?.id ?? "",
          });
          const toolNames = formatMcpToolNamesForDiscord(result.test.functionNames);
          await repaint(
            interaction,
            route.locale,
            scope,
            { kind: "collection", selectedId: result.row.guild_mcp_id },
            receipt(route.locale, "commands.mcps.added", {
              detail: localizer(
                route.locale,
                toolNames ? "commands.mcps.added_detail_with_tools" : "commands.mcps.added_detail",
                {
                  name: result.row.name,
                  count: result.test.toolCount,
                  tools: toolNames ?? "",
                },
              ),
            }),
          );
          return;
        }
        const detail = result.status === "connection-failed" ? result.error : undefined;
        await repaint(
          interaction,
          route.locale,
          scope,
          { kind: "collection" },
          addFailureReceipt(route.locale, result.status, detail),
        );
        return;
      }
      if (route.action === "set-enabled") {
        const action = await performPanelAction(
          () =>
            dependencies.operations.setEnabled({
              serverId: scope.state.server_id,
              serverDiscId: scope.discordId,
              guildMcpId: route.entityId,
              enabled: route.enabled,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? unavailableScope(scope);
        if (result.status === "success") {
          dependencies.recordAction({
            action: route.enabled ? "mcps.workspace.server.enable" : "mcps.workspace.server.disable",
            serverId: scope.state.server_id,
            userDiscId: interaction.user?.id ?? "",
          });
        }
        const success = result.status === "success" || result.status === "unchanged";
        await repaint(
          interaction,
          route.locale,
          scope,
          { kind: "collection", selectedId: route.entityId },
          success
            ? receipt(
                route.locale,
                result.status === "unchanged"
                  ? "commands.mcps.unchanged_receipt"
                  : route.enabled
                    ? "commands.mcps.enabled_receipt"
                    : "commands.mcps.disabled_receipt",
                {
                  detail: localizer(
                    route.locale,
                    result.status === "unchanged"
                      ? "commands.mcps.unchanged_receipt_detail"
                      : route.enabled
                        ? "commands.mcps.enabled_receipt_detail"
                        : "commands.mcps.disabled_receipt_detail",
                    { name: result.row.name },
                  ),
                },
              )
            : result.status === "not-found"
              ? changedStateReceipt(route.locale)
              : mutationFailureReceipt(route.locale, result.status),
        );
        return;
      }
      if (route.action === "remove-prompt") {
        const presence = entityPresence(scope, route.entityId);
        await repaint(
          interaction,
          route.locale,
          scope,
          presence === "present" ? { kind: "remove", entityId: route.entityId } : { kind: "collection" },
          presence === "absent" ? changedStateReceipt(route.locale) : undefined,
        );
        return;
      }
      if (route.action === "remove-cancel") {
        const presence = entityPresence(scope, route.entityId);
        await repaint(
          interaction,
          route.locale,
          scope,
          { kind: "collection", selectedId: presence === "present" ? route.entityId : undefined },
          presence === "absent" ? changedStateReceipt(route.locale) : undefined,
        );
        return;
      }
      if (route.action === "remove-confirm") {
        const action = await performPanelAction(
          () =>
            dependencies.operations.remove({
              serverId: scope.state.server_id,
              serverDiscId: scope.discordId,
              guildMcpId: route.entityId,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? unavailableScope(scope);
        if (result.status === "success") {
          dependencies.recordAction({
            action: "mcps.workspace.server.remove",
            serverId: scope.state.server_id,
            userDiscId: interaction.user?.id ?? "",
          });
        }
        await repaint(
          interaction,
          route.locale,
          scope,
          { kind: "collection" },
          result.status === "success"
            ? receipt(route.locale, "commands.mcps.removed_receipt", {
                detail: localizer(route.locale, "commands.mcps.removed_receipt_detail", { name: result.row.name }),
              })
            : result.status === "not-found"
              ? changedStateReceipt(route.locale)
              : mutationFailureReceipt(route.locale, result.status),
        );
        return;
      }
    },
  };
}

export const mcpsInteractionRoute = createMcpsInteractionRoute();

export async function buildInitialMcpsPanel(
  interaction: ChatInputCommandInteraction,
  locale: string,
): Promise<McpsPanelPayloadOrTerminal> {
  const scope = await resolveScope(interaction);
  if (!scope) return terminalPayload(locale, "commands.mcps.not_setup") as McpsPanelPayloadOrTerminal;
  return buildMcpsPanelPayload({
    locale,
    scope: scope.kind,
    configs: scope.read.configs,
    readStatus: scope.read.status,
    page: { kind: "collection" },
  });
}

type McpsPanelPayloadOrTerminal = ReturnType<typeof buildMcpsPanelPayload> | InteractionEditReplyOptions;
