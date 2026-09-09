import type { ChatInputCommandInteraction, Client } from "discord.js";
import type { GlobalRoutableInteraction, ParsedInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import {
  CONFIG_ROUTE_NAMESPACE,
  CONFIG_ROUTE_VERSION,
  CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
  parseConfigPanelRoute,
} from "@/utils/discord/configPanelCatalog";
import { isConfigRouteAuthorized, resolveConfigActor } from "@/utils/discord/interactions/configPermissionPolicy";
import {
  repaint,
  deniedReceipt,
  terminalPayload,
  type ConfigRouteDependencies,
  type ConfigScope,
} from "@/utils/discord/interactions/configRouteContext";
import { createStPresetsInteractionRoute, type StPresetsScope } from "@/utils/discord/interactions/stPresetsRoutes";
import type { StPresetsPanelRoute } from "@/utils/discord/stPresetsPanelCatalog";
import type { StPresetsPanelPage } from "@/utils/discord/ui/stPresetsPanel";
import { stPresetOperations } from "@/utils/stPreset/stPresetOperations";
import type { PanelReceipt } from "@/types/discord/panel";
import {
  buildAddStPresetModal,
  buildNodesToggleModal,
  buildStPresetsAddModalFieldId,
  buildStPresetsNodesModalFieldId,
} from "@/utils/discord/ui/stPresetsPanel";

function configRouteForStRoute(route: StPresetsPanelRoute): ReturnType<typeof parseConfigPanelRoute> {
  const segments = CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.buildRouteSegments(route);
  return parseConfigPanelRoute({
    namespace: CONFIG_ROUTE_NAMESPACE,
    version: CONFIG_ROUTE_VERSION,
    segments,
  });
}

function isConfigStRouteAuthorized(
  interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
  route: StPresetsPanelRoute,
): boolean {
  const configRoute = configRouteForStRoute(route);
  return configRoute ? isConfigRouteAuthorized(configRoute, resolveConfigActor(interaction)) : false;
}

async function resolveStScope(
  interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
  dependencies: ConfigRouteDependencies,
  forceRefresh = false,
): Promise<StPresetsScope | null> {
  const configScope = await dependencies.resolveScope(interaction, forceRefresh);
  const state = configScope?.personas[0];
  if (!configScope || !state) return null;

  const data = await stPresetOperations.loadStPresetScopeData(configScope.serverDiscId, forceRefresh);
  if (!data) return null;
  return {
    discordId: configScope.serverDiscId,
    kind: configScope.guildId ? "guild" : "dm",
    state,
    data,
  };
}

async function resolveConfigScope(
  interaction: GlobalRoutableInteraction,
  dependencies: ConfigRouteDependencies,
): Promise<ConfigScope | null> {
  return dependencies.resolveScope(interaction, false);
}

async function resolveFallbackStScope(
  interaction: GlobalRoutableInteraction,
  dependencies: ConfigRouteDependencies,
  readStatus: "stale" | "unavailable",
): Promise<StPresetsScope | null> {
  const configScope = await resolveConfigScope(interaction, dependencies);
  const state = configScope?.personas[0];
  if (!configScope || !state) return null;
  const data = await stPresetOperations.loadStPresetScopeData(configScope.serverDiscId);
  return {
    discordId: configScope.serverDiscId,
    kind: configScope.guildId ? "guild" : "dm",
    state,
    data: data
      ? { ...data, readStatus }
      : {
          scopeDiscId: configScope.serverDiscId,
          serverId: state.server_id,
          readStatus,
          presets: [],
          activePresetId: null,
        },
  };
}

async function repaintConfigStPresets(
  interaction: GlobalRoutableInteraction,
  locale: string,
  scope: StPresetsScope,
  page: StPresetsPanelPage,
  panelReceipt: PanelReceipt | undefined,
  rangeIndex: number | undefined,
  dependencies: ConfigRouteDependencies,
): Promise<void> {
  const configScope = await resolveConfigScope(interaction, dependencies);
  if (!configScope) {
    await interaction.editReply(terminalPayload(locale, "commands.config.panel.unavailable"));
    return;
  }

  await repaint(interaction, {
    locale,
    scope: configScope,
    category: "plugins",
    page: "sillytavern-presets",
    selectedPersonaId: null,
    receipt: panelReceipt,
    dependencies,
    stPresetsView: {
      scope: scope.kind,
      presets: scope.data.presets,
      activePresetId: scope.data.activePresetId,
      activeNodeCounts: scope.data.activeNodeCounts,
      readStatus: scope.data.readStatus,
      page,
      rangeIndex,
    },
  });
}

/**
 * Routes the config-hosted panel through the standalone handler so operations, snapshots, modal
 * timing, and receipts remain one implementation. Every write re-resolves the config scope and
 * policy immediately before calling the canonical ST operation.
 */
export async function handleConfigStPresetsRoute(
  client: Client,
  interaction: GlobalRoutableInteraction,
  parsed: ParsedInteractionRoute,
  dependencies: ConfigRouteDependencies,
): Promise<boolean> {
  const route = CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER.parseRoute(parsed);
  if (!route) return false;

  const authorizeMutation = async (target: StPresetsPanelRoute): Promise<boolean> => {
    const scope = await resolveConfigScope(interaction, dependencies);
    return scope !== null && isConfigStRouteAuthorized(interaction, target);
  };

  const guardedOperations: typeof stPresetOperations = {
    ...stPresetOperations,
    activateStPreset: async (input) =>
      (await authorizeMutation({ action: "select", locale: route.locale }))
        ? stPresetOperations.activateStPreset(input)
        : false,
    deactivateAllStPresets: async (input) =>
      (await authorizeMutation({ action: "disable", locale: route.locale }))
        ? stPresetOperations.deactivateAllStPresets(input)
        : false,
    importStPreset: async (input) =>
      (await authorizeMutation({ action: "add-submit", locale: route.locale, nonce: "guarded00" }))
        ? stPresetOperations.importStPreset(input)
        : { status: "insert_failed" },
    updateStPresetNodes: async (input) =>
      (await authorizeMutation({
        action: "nodes-submit",
        locale: route.locale,
        presetId: input.presetId,
        nonce: "guarded00",
      }))
        ? stPresetOperations.updateStPresetNodes(input)
        : false,
    removeStPresetsWithPromotion: async (input) =>
      (await authorizeMutation({
        action: "delete-confirm",
        locale: route.locale,
        presetId: input.presetIdsToRemove[0] ?? 1,
      }))
        ? stPresetOperations.removeStPresetsWithPromotion(input)
        : { successCount: 0, failedNames: [], removedNames: [], promotedPreset: null },
  };

  const routeHandler = createStPresetsInteractionRoute({
    routeAdapter: CONFIG_ST_PRESETS_PANEL_ROUTE_ADAPTER,
    isAuthorized: (target, targetRoute) => isConfigStRouteAuthorized(target, targetRoute),
    resolveScope: (target, forceRefresh) => resolveStScope(target, dependencies, forceRefresh),
    operations: guardedOperations,
    recordAction: dependencies.recordAction,
    loadToggleableNodes: (presetId) => stPresetOperations.loadToggleableNodes(presetId),
    createNonce: dependencies.createNonce,
    takeFileUpload: (interactionId, nonce) =>
      dependencies.takeFileUpload(interactionId, buildStPresetsAddModalFieldId("file", nonce)),
    takeNodeCheckboxValues: (interactionId, nonce, groupIndex) =>
      dependencies.takeCheckboxValues(interactionId, buildStPresetsNodesModalFieldId(nonce, groupIndex)),
    showAddModal: (target, locale, nonce, routes) =>
      dependencies.showModal(target, buildAddStPresetModal(locale, nonce, routes)),
    showNodesModal: (target, locale, preset, nodes, pageOffset, nonce, routes) =>
      dependencies.showModal(target, buildNodesToggleModal(locale, preset, nodes, pageOffset, nonce, routes)),
    repaint: (target, locale, scope, page, receipt, rangeIndex) =>
      repaintConfigStPresets(target, locale, scope, page, receipt, rangeIndex, dependencies),
    onDenied: async (target, localeRoute) => {
      const scope = await resolveFallbackStScope(target, dependencies, "stale");
      if (!scope) {
        await target.editReply(terminalPayload(localeRoute.locale, "commands.config.panel.unavailable"));
        return;
      }
      await repaintConfigStPresets(
        target,
        localeRoute.locale,
        scope,
        scope.data.activePresetId !== null ? { kind: "preset", presetId: scope.data.activePresetId } : { kind: "none" },
        deniedReceipt(localeRoute.locale),
        undefined,
        dependencies,
      );
    },
    onMissing: async (target, localeRoute) => {
      const scope = await resolveFallbackStScope(target, dependencies, "unavailable");
      if (!scope) {
        await target.editReply(terminalPayload(localeRoute.locale, "commands.config.panel.unavailable"));
        return;
      }
      await repaintConfigStPresets(
        target,
        localeRoute.locale,
        scope,
        { kind: "none" },
        undefined,
        undefined,
        dependencies,
      );
    },
  });

  await routeHandler.execute(client, interaction, parsed);
  return true;
}
