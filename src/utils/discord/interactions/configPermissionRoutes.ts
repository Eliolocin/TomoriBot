import { MessageFlags, type ModalSubmitInteraction } from "discord.js";
import type { PanelAction } from "@/constants/panelActions";
import type { TomoriState } from "@/types/db/schema";
import {
  buildCapabilitiesManageConfigWritePlan,
  getCapabilitiesManagePermissionDefinitions,
} from "@/utils/discord/manageConfigMapping";
import type { ConfigPanelRoute } from "@/utils/discord/configPanelCatalog";
import { isConfigRouteAuthorized, type ConfigActor } from "@/utils/discord/interactions/configPermissionPolicy";
import {
  repaint,
  staleReceipt,
  type ConfigRepaintOptions,
  type ConfigRouteDependencies,
  type ConfigScope,
  type ConfigPermissionsView,
} from "@/utils/discord/interactions/configRouteContext";
import type { GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import {
  CONFIG_PERMISSIONS_CHECKBOX_GROUP_PREFIX,
  CONFIG_PERMISSIONS_CHECKBOX_GROUP_SIZE,
  buildConfigPermissionsManageModal,
} from "@/utils/discord/ui/configBehaviorModals";
import { buildConfigModalFieldId } from "@/utils/discord/ui/configModals";
import { configRepository } from "@/utils/db/repositories";
import { invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { ELEVENLABS_SERVICE_NAME } from "@/utils/audio/elevenLabsAccount";
import { hasOptApiKey } from "@/utils/security/crypto";
import { localizer } from "@/utils/text/localizer";

export const CONFIG_PERMISSION_MODAL_OPEN_ACTIONS = new Set<ConfigPanelRoute["action"]>(["permissions-manage-open"]);

export const CONFIG_PERMISSION_MODAL_SUBMIT_ACTIONS = new Set<ConfigPanelRoute["action"]>([
  "permissions-manage-submit",
]);

export const CONFIG_PERMISSION_DIRECT_ACTIONS = new Set<ConfigPanelRoute["action"]>([
  "permissions-tool-use-set",
  "permissions-privacy-bypass-set",
]);

function receipt(
  locale: string,
  tone: "success" | "info" | "warning" | "error",
  heading: string,
  detail: string,
): ConfigRepaintOptions["receipt"] {
  return {
    tone,
    heading: localizer(locale, `commands.config.panel.${heading}`),
    detail: localizer(locale, `commands.config.panel.${detail}`),
  };
}

function writeFailed(locale: string): ConfigRepaintOptions["receipt"] {
  return receipt(locale, "error", "write_failed_heading", "write_failed_detail");
}

function stateFromScope(scope: ConfigScope): TomoriState | null {
  return scope.personas[0] ?? null;
}

type ConfigPermissionManageRoute = Extract<
  ConfigPanelRoute,
  { action: "permissions-manage-open" | "permissions-manage-submit" }
>;

export async function loadConfigPermissionsView(state: TomoriState): Promise<ConfigPermissionsView> {
  const includeElevenLabs = await hasOptApiKey(state.server_id, ELEVENLABS_SERVICE_NAME);
  const definitions = getCapabilitiesManagePermissionDefinitions({ includeElevenLabs });
  const definitionStates = Object.fromEntries(
    definitions.map((definition) => [definition.value, definition.getState(state.config)]),
  );
  return {
    capabilities: {
      toolUseEnabled: state.config.tool_use_enabled ?? true,
      includeElevenLabs,
      definitionStates,
    },
    privacy: {
      stmPrivacyBypass: state.config.stm_privacy_bypass ?? false,
    },
  };
}

function modal(interaction: GlobalRoutableInteraction): ModalSubmitInteraction {
  return interaction as ModalSubmitInteraction;
}

type PermissionWriteOutcome = {
  receipt: ConfigRepaintOptions["receipt"];
  telemetry?: PanelAction;
};

async function runPermissionWrite(
  interaction: GlobalRoutableInteraction,
  route: ConfigPanelRoute,
  scope: ConfigScope,
  dependencies: ConfigRouteDependencies,
): Promise<PermissionWriteOutcome | null> {
  const state = stateFromScope(scope);
  if (!state) return null;

  if (route.action === "permissions-tool-use-set") {
    const current = state.config.tool_use_enabled ?? true;
    if (current === route.enabled) {
      return { receipt: receipt(route.locale, "info", "state_no_changes_heading", "state_no_changes_detail") };
    }
    const updated = await configRepository.updateCapabilitiesConfig(state.server_id, {
      tool_use_enabled: route.enabled,
    });
    if (!updated) return { receipt: writeFailed(route.locale) };
    invalidateTomoriStateCache(scope.serverDiscId);
    return {
      receipt: receipt(route.locale, "success", "state_updated_heading", "state_updated_detail"),
      telemetry: "server-config.workspace.tool-use.set",
    };
  }

  if (route.action === "permissions-privacy-bypass-set") {
    const current = state.config.stm_privacy_bypass ?? false;
    if (current === route.enabled) {
      return { receipt: receipt(route.locale, "info", "state_no_changes_heading", "state_no_changes_detail") };
    }
    const updated = await configRepository.updateChannelScopeConfig(state.server_id, {
      stm_privacy_bypass: route.enabled,
    });
    if (!updated) return { receipt: writeFailed(route.locale) };
    invalidateTomoriStateCache(scope.serverDiscId);
    return {
      receipt: receipt(route.locale, "success", "state_updated_heading", "state_updated_detail"),
      telemetry: "server-config.workspace.stm-privacy-bypass.set",
    };
  }

  if (route.action !== "permissions-manage-submit") return null;

  const submitted = modal(interaction);
  const authoritativeIncludeElevenLabs = await hasOptApiKey(state.server_id, ELEVENLABS_SERVICE_NAME);
  if (authoritativeIncludeElevenLabs !== route.includeElevenLabs) {
    return { receipt: staleReceipt(route.locale) };
  }

  const definitions = getCapabilitiesManagePermissionDefinitions({
    includeElevenLabs: route.includeElevenLabs,
    page: route.page,
  }).filter((definition) => definition.page === route.page);
  const selectedValues = new Set<string>();
  const groupCount = Math.ceil(definitions.length / CONFIG_PERMISSIONS_CHECKBOX_GROUP_SIZE);
  for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
    const values = dependencies.takeCheckboxValues(
      submitted.id,
      buildConfigModalFieldId(`${CONFIG_PERMISSIONS_CHECKBOX_GROUP_PREFIX}_${groupIndex}`, route.nonce),
    );
    if (values === undefined) return { receipt: staleReceipt(route.locale) };
    for (const value of values) selectedValues.add(value);
  }

  const writePlan = buildCapabilitiesManageConfigWritePlan(state.config, selectedValues, {
    includeElevenLabs: route.includeElevenLabs,
    page: route.page,
  });
  if (writePlan.changes.length === 0) {
    return { receipt: receipt(route.locale, "info", "state_no_changes_heading", "state_no_changes_detail") };
  }

  const updated = await configRepository[writePlan.method](state.server_id, writePlan.patch);
  if (!updated) return { receipt: writeFailed(route.locale) };
  invalidateTomoriStateCache(scope.serverDiscId);
  return {
    receipt: receipt(route.locale, "success", "state_updated_heading", "state_updated_detail"),
    telemetry: "server-config.workspace.capabilities.set",
  };
}

export async function handleConfigPermissionModalOpen(
  interaction: GlobalRoutableInteraction,
  route: ConfigPanelRoute,
  dependencies: ConfigRouteDependencies,
  actor: ConfigActor,
): Promise<boolean> {
  if (!CONFIG_PERMISSION_MODAL_OPEN_ACTIONS.has(route.action)) return false;
  if (!isConfigRouteAuthorized(route, actor)) {
    await interaction.reply({
      content: localizer(route.locale, "commands.config.panel.denied_detail"),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const scope = await dependencies.resolveScope(interaction, false);
  const state = scope ? stateFromScope(scope) : null;
  if (!scope || !state) {
    await interaction.reply({
      content: localizer(route.locale, "commands.config.panel.unavailable"),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const view = await dependencies.loadPermissionsView(state);
  const manageRoute = route as ConfigPermissionManageRoute;
  await dependencies.showModal(
    interaction,
    buildConfigPermissionsManageModal(
      route.locale,
      dependencies.createNonce(),
      manageRoute.page,
      view.capabilities.includeElevenLabs,
      state.config,
    ),
  );
  return true;
}

export interface ConfigPermissionRouteContext {
  interaction: GlobalRoutableInteraction;
  route: ConfigPanelRoute;
  scope: ConfigScope;
  dependencies: ConfigRouteDependencies;
}

export async function handleConfigPermissionRoutes(context: ConfigPermissionRouteContext): Promise<boolean> {
  const { interaction, route, scope, dependencies } = context;
  if (
    !CONFIG_PERMISSION_DIRECT_ACTIONS.has(route.action) &&
    !CONFIG_PERMISSION_MODAL_SUBMIT_ACTIONS.has(route.action)
  ) {
    return false;
  }

  const outcome = await runPermissionWrite(interaction, route, scope, dependencies);
  if (!outcome) return false;
  const refreshed = (await dependencies.resolveScope(interaction, true)) ?? scope;
  if (outcome.telemetry && refreshed.internalServerId) {
    dependencies.recordAction({
      action: outcome.telemetry,
      serverId: refreshed.internalServerId,
      userDiscId: interaction.user.id,
    });
  }
  const page =
    route.action === "permissions-privacy-bypass-set"
      ? "rules"
      : route.action === "permissions-manage-submit"
        ? route.page
        : "available-tools";
  await repaint(interaction, {
    locale: route.locale,
    scope: refreshed,
    category: route.action === "permissions-privacy-bypass-set" ? "channels" : "plugins",
    page,
    selectedPersonaId: null,
    receipt: outcome.receipt,
    dependencies,
  });
  return true;
}
