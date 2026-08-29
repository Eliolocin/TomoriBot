import {
  ComponentType,
  MessageFlags,
  type APIAttachment,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type InteractionEditReplyOptions,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { StPresetNodeRow, StPresetRow, TomoriState } from "@/types/db/schema";
import type { PanelReceipt } from "@/types/discord/panel";
import { getCachedTomoriState, getLastDbError } from "@/utils/cache/tomoriStateCache";
import type { GlobalInteractionRoute, GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import { beginPanelInteraction, performPanelAction } from "@/utils/discord/interactions/panelController";
import { createNonce } from "@/utils/discord/panelRouteTokens";
import {
  ST_PRESETS_ROUTE_NAMESPACE,
  ST_PRESETS_ROUTE_VERSION,
  parseStPresetsPanelRoute,
} from "@/utils/discord/stPresetsPanelCatalog";
import {
  buildAddStPresetModal,
  buildNodesToggleModal,
  buildStPresetsAddModalFieldId,
  buildStPresetsNodesModalFieldId,
  buildStPresetsPanelPayload,
  type StPresetsPanelPage,
} from "@/utils/discord/ui/stPresetsPanel";
import { showRoutedRawModal, takeRawModalCheckboxGroupValues, takeRawModalFileUpload } from "@/utils/discord/ui/modals";
import { buildPanelContainer } from "@/utils/discord/ui/panel";
import {
  loadStPresetToggleableNodes,
  stPresetOperations,
  type StPresetScopeData,
} from "@/utils/stPreset/stPresetOperations";
import { recordPanelActionStat, type RecordPanelActionInput } from "@/utils/stats/panelActionMetrics";
import { localizer } from "@/utils/text/localizer";

interface StPresetsScope {
  discordId: string;
  kind: "guild" | "dm";
  state: TomoriState;
  data: StPresetScopeData;
}

export interface StPresetsRouteDependencies {
  resolveScope(
    interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
    forceRefresh?: boolean,
  ): Promise<StPresetsScope | null>;
  operations: typeof stPresetOperations;
  recordAction(input: RecordPanelActionInput): void;
  loadToggleableNodes(presetId: number): Promise<StPresetNodeRow[]>;
  createNonce(): string;
  showAddModal(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
    locale: string,
    nonce: string,
  ): Promise<void>;
  showNodesModal(
    interaction: ButtonInteraction,
    locale: string,
    preset: StPresetRow,
    nodes: StPresetNodeRow[],
    pageOffset: number,
    nonce: string,
  ): Promise<void>;
  takeFileUpload(interactionId: string, nonce: string): APIAttachment | undefined;
  takeNodeCheckboxValues(interactionId: string, nonce: string, groupIndex: number): string[] | undefined;
  storeNodeSnapshot(nonce: string, snapshot: { presetId: number; identifiers: string[] }): void;
  takeNodeSnapshot(nonce: string): { presetId: number; identifiers: string[] } | undefined;
}

const nodeSnapshots = new Map<string, { presetId: number; identifiers: string[]; expiresAt: number }>();

function storeNodeSnapshot(nonce: string, snapshot: { presetId: number; identifiers: string[] }): void {
  const now = Date.now();
  for (const [key, item] of nodeSnapshots) {
    if (item.expiresAt < now) nodeSnapshots.delete(key);
  }
  nodeSnapshots.set(nonce, { ...snapshot, expiresAt: now + 15 * 60_000 });
}

function takeNodeSnapshot(nonce: string): { presetId: number; identifiers: string[] } | undefined {
  const snapshot = nodeSnapshots.get(nonce);
  nodeSnapshots.delete(nonce);
  return snapshot && snapshot.expiresAt >= Date.now()
    ? { presetId: snapshot.presetId, identifiers: snapshot.identifiers }
    : undefined;
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

async function defaultResolveScope(
  interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
  forceRefresh = false,
): Promise<StPresetsScope | null> {
  const discordId = interaction.guildId ?? interaction.user.id;
  const state = await getCachedTomoriState(discordId);
  if (!state) return null;

  const data = await stPresetOperations.loadStPresetScopeData(discordId, forceRefresh);
  if (!data) return null;

  return {
    discordId,
    kind: interaction.guildId ? "guild" : "dm",
    state,
    data,
  };
}

function changedStateReceipt(locale: string): PanelReceipt {
  return {
    tone: "info",
    heading: localizer(locale, "commands.st-presets.changed_receipt"),
    detail: localizer(locale, "commands.st-presets.changed_receipt_detail"),
  };
}

function resolveActiveOrNonePage(data: StPresetScopeData): StPresetsPanelPage {
  return data.activePresetId !== null ? { kind: "preset", presetId: data.activePresetId } : { kind: "none" };
}

function importFailureReceipt(locale: string, status: string, maxSizeMB?: number): PanelReceipt {
  const heading = localizer(locale, "commands.st-presets.failed_receipt");
  let detail: string;
  switch (status) {
    case "invalid_file":
      detail = localizer(locale, "commands.st-presets.add_invalid_file");
      break;
    case "file_too_large":
      detail = localizer(locale, "commands.st-presets.add_file_too_large", { maxSizeMB: maxSizeMB ?? 10 });
      break;
    case "download_failed":
      detail = localizer(locale, "commands.st-presets.add_download_failed");
      break;
    case "invalid_json":
      detail = localizer(locale, "commands.st-presets.add_invalid_json");
      break;
    case "not_a_preset":
      detail = localizer(locale, "commands.st-presets.add_not_a_preset");
      break;
    case "no_nodes":
      detail = localizer(locale, "commands.st-presets.add_no_nodes");
      break;
    default:
      detail = localizer(locale, "commands.st-presets.add_insert_failed");
      break;
  }
  return { tone: "error", heading, detail };
}

function isAuthorized(interaction: GlobalRoutableInteraction | ChatInputCommandInteraction): boolean {
  return !interaction.guildId || (interaction.memberPermissions?.has("ManageGuild") ?? false);
}

async function repaint(
  interaction: GlobalRoutableInteraction,
  locale: string,
  scope: StPresetsScope,
  page: StPresetsPanelPage,
  panelReceipt?: PanelReceipt,
  rangeIndex?: number,
): Promise<void> {
  await interaction.editReply(
    buildStPresetsPanelPayload({
      locale,
      scope: scope.kind,
      presets: scope.data.presets,
      activePresetId: scope.data.activePresetId,
      activeNodeCounts: scope.data.activeNodeCounts,
      readStatus: scope.data.readStatus,
      page,
      rangeIndex,
      receipt: panelReceipt,
    }),
  );
}

/**
 * The route-kind guards in `execute` already reject every non-button action, but that check is a
 * compound condition TypeScript cannot carry into the individual branches, so the narrower type has
 * to be re-asserted where the raw modal transport needs it. Do not replace this with a cast: a modal
 * submission reaching the transport would attempt a modal response on an acknowledged interaction.
 */
function requireButton(interaction: GlobalRoutableInteraction, action: string): ButtonInteraction {
  if (!interaction.isButton()) {
    throw new Error(`ST presets ${action} route requires a button interaction`);
  }
  return interaction;
}

export function createStPresetsInteractionRoute(
  overrides: Partial<StPresetsRouteDependencies> = {},
): GlobalInteractionRoute {
  const dependencies: StPresetsRouteDependencies = {
    resolveScope: defaultResolveScope,
    operations: stPresetOperations,
    recordAction: (input) => {
      void recordPanelActionStat(input);
    },
    loadToggleableNodes: (presetId) => loadStPresetToggleableNodes(presetId),
    createNonce,
    showAddModal: (interaction, locale, nonce) => showRoutedRawModal(interaction, buildAddStPresetModal(locale, nonce)),
    showNodesModal: (interaction, locale, preset, nodes, pageOffset, nonce) =>
      showRoutedRawModal(interaction, buildNodesToggleModal(locale, preset, nodes, pageOffset, nonce)),
    takeFileUpload: (interactionId, nonce) =>
      takeRawModalFileUpload(interactionId, buildStPresetsAddModalFieldId("file", nonce)),
    takeNodeCheckboxValues: (interactionId, nonce, groupIndex) =>
      takeRawModalCheckboxGroupValues(interactionId, buildStPresetsNodesModalFieldId(nonce, groupIndex)),
    storeNodeSnapshot,
    takeNodeSnapshot,
    ...overrides,
  };

  return {
    namespace: ST_PRESETS_ROUTE_NAMESPACE,
    version: ST_PRESETS_ROUTE_VERSION,
    async execute(_client, interaction, parsed): Promise<void> {
      const route = parseStPresetsPanelRoute(parsed);
      if (!route) {
        throw new Error(`Malformed ST presets panel route: ${interaction.customId}`);
      }

      const expectsSelect = route.action === "select";
      const expectsModal = route.action === "add-submit" || route.action === "nodes-submit";

      if (expectsSelect && !interaction.isStringSelectMenu()) {
        throw new Error(`ST presets ${route.action} route requires a String Select interaction`);
      }
      if (expectsModal && !interaction.isModalSubmit()) {
        throw new Error(`ST presets ${route.action} route requires a modal submission`);
      }
      if (!expectsSelect && !expectsModal && !interaction.isButton()) {
        throw new Error(`ST presets ${route.action} route requires a button interaction`);
      }

      if (route.action === "add-open") {
        if (!isAuthorized(interaction)) {
          await interaction.reply({
            content: localizer(route.locale, "general.errors.permission_denied_description"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const nonce = dependencies.createNonce();
        await dependencies.showAddModal(requireButton(interaction, route.action), route.locale, nonce);
        return;
      }

      if (route.action === "select") {
        const selectMenu = interaction as StringSelectMenuInteraction;
        const selectedValue = selectMenu.values[0];

        if (selectedValue === "add") {
          if (!isAuthorized(interaction)) {
            await interaction.reply({
              content: localizer(route.locale, "general.errors.permission_denied_description"),
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          const nonce = dependencies.createNonce();
          await dependencies.showAddModal(selectMenu, route.locale, nonce);
          return;
        }

        const initialScope = await beginPanelInteraction({
          acknowledge: () => interaction.deferUpdate(),
          authorize: () => isAuthorized(interaction),
          onDenied: () =>
            interaction.editReply(terminalPayload(route.locale, "general.errors.permission_denied_description")),
          load: () => dependencies.resolveScope(interaction, false),
          onMissing: () => interaction.editReply(terminalPayload(route.locale, "commands.st-presets.not_setup")),
        });
        if (!initialScope) return;
        let scope = initialScope;

        if (selectedValue === "none") {
          if (scope.data.readStatus !== "fresh") {
            await repaint(interaction, route.locale, scope, { kind: "none" });
            return;
          }

          if (scope.data.activePresetId === null) {
            await repaint(interaction, route.locale, scope, { kind: "none" });
            return;
          }

          const action = await performPanelAction(
            () => dependencies.operations.deactivateAllStPresets({ serverId: scope.state.server_id }),
            () => dependencies.resolveScope(interaction, true),
          );
          scope = action.state ?? { ...scope, data: { ...scope.data, readStatus: "unavailable" } };

          if (action.result) {
            dependencies.recordAction({
              action: "st-presets.workspace.preset.deactivate",
              serverId: scope.state.server_id,
              userDiscId: interaction.user?.id ?? "",
            });
          }

          await repaint(
            interaction,
            route.locale,
            scope,
            { kind: "none" },
            action.result
              ? {
                  tone: "success",
                  heading: localizer(route.locale, "commands.st-presets.disabled_receipt"),
                  detail: localizer(route.locale, "commands.st-presets.disabled_receipt_detail"),
                }
              : {
                  tone: "error",
                  heading: localizer(route.locale, "commands.st-presets.failed_receipt"),
                  detail: localizer(route.locale, "commands.st-presets.failed_receipt_detail"),
                },
          );
          return;
        }

        const targetPresetId = Number(selectedValue);
        if (!Number.isSafeInteger(targetPresetId) || targetPresetId <= 0) {
          throw new Error("Invalid preset ID in selection");
        }

        if (scope.data.readStatus !== "fresh") {
          await repaint(interaction, route.locale, scope, { kind: "preset", presetId: targetPresetId });
          return;
        }

        const targetPreset = scope.data.presets.find((p) => p.preset_id === targetPresetId);
        if (!targetPreset) {
          await repaint(
            interaction,
            route.locale,
            scope,
            resolveActiveOrNonePage(scope.data),
            changedStateReceipt(route.locale),
          );
          return;
        }

        if (targetPreset.is_active) {
          await repaint(interaction, route.locale, scope, { kind: "preset", presetId: targetPresetId });
          return;
        }

        const action = await performPanelAction(
          () =>
            dependencies.operations.activateStPreset({
              serverId: scope.state.server_id,
              presetId: targetPresetId,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        scope = action.state ?? { ...scope, data: { ...scope.data, readStatus: "unavailable" } };

        if (action.result) {
          dependencies.recordAction({
            action: "st-presets.workspace.preset.activate",
            serverId: scope.state.server_id,
            userDiscId: interaction.user?.id ?? "",
          });
          await repaint(
            interaction,
            route.locale,
            scope,
            { kind: "preset", presetId: targetPresetId },
            {
              tone: "success",
              heading: localizer(route.locale, "commands.st-presets.activated_receipt"),
              detail: localizer(route.locale, "commands.st-presets.activated_receipt_detail", {
                name: targetPreset.preset_name,
              }),
            },
          );
        } else {
          await repaint(
            interaction,
            route.locale,
            scope,
            { kind: "preset", presetId: targetPresetId },
            {
              tone: "error",
              heading: localizer(route.locale, "commands.st-presets.failed_receipt"),
              detail: localizer(route.locale, "commands.st-presets.failed_receipt_detail"),
            },
          );
        }
        return;
      }

      if (route.action === "nodes-open") {
        if (!isAuthorized(interaction)) {
          await interaction.reply({
            content: localizer(route.locale, "general.errors.permission_denied_description"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const scope = await dependencies.resolveScope(interaction, false);
        if (!scope) {
          await interaction.reply({
            content: localizer(route.locale, "commands.st-presets.not_setup"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (scope.data.readStatus !== "fresh") {
          await interaction.deferUpdate();
          await repaint(interaction, route.locale, scope, { kind: "preset", presetId: route.presetId });
          return;
        }

        const targetPreset = scope.data.presets.find((p) => p.preset_id === route.presetId);
        if (!targetPreset?.is_active || scope.data.activePresetId !== route.presetId) {
          await interaction.deferUpdate();
          await repaint(
            interaction,
            route.locale,
            scope,
            resolveActiveOrNonePage(scope.data),
            changedStateReceipt(route.locale),
          );
          return;
        }

        const nodes = await dependencies.loadToggleableNodes(route.presetId);
        if (nodes.length === 0) {
          await interaction.deferUpdate();
          await repaint(
            interaction,
            route.locale,
            scope,
            { kind: "preset", presetId: route.presetId },
            {
              tone: "info",
              heading: localizer(route.locale, "commands.st-presets.no_nodes"),
              detail: localizer(route.locale, "commands.st-presets.no_nodes"),
            },
          );
          return;
        }

        if (nodes.length <= 50) {
          const nonce = dependencies.createNonce();
          dependencies.storeNodeSnapshot(nonce, {
            presetId: route.presetId,
            identifiers: nodes.map((n) => n.identifier),
          });
          await dependencies.showNodesModal(
            requireButton(interaction, route.action),
            route.locale,
            targetPreset,
            nodes,
            0,
            nonce,
          );
          return;
        }

        await interaction.deferUpdate();
        await repaint(interaction, route.locale, scope, {
          kind: "nodes-chooser",
          presetId: route.presetId,
          totalCount: nodes.length,
          chooserPage: 0,
        });
        return;
      }

      if (route.action === "nodes-range") {
        if (!isAuthorized(interaction)) {
          await interaction.reply({
            content: localizer(route.locale, "general.errors.permission_denied_description"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const scope = await dependencies.resolveScope(interaction, false);
        if (!scope) {
          await interaction.reply({
            content: localizer(route.locale, "commands.st-presets.not_setup"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (scope.data.readStatus !== "fresh") {
          await interaction.deferUpdate();
          await repaint(interaction, route.locale, scope, { kind: "preset", presetId: route.presetId });
          return;
        }

        const targetPreset = scope.data.presets.find((p) => p.preset_id === route.presetId);
        if (!targetPreset?.is_active || scope.data.activePresetId !== route.presetId) {
          await interaction.deferUpdate();
          await repaint(
            interaction,
            route.locale,
            scope,
            resolveActiveOrNonePage(scope.data),
            changedStateReceipt(route.locale),
          );
          return;
        }

        const nodes = await dependencies.loadToggleableNodes(route.presetId);
        const pageOffset = route.rangeIndex * 50;
        const pageNodes = nodes.slice(pageOffset, pageOffset + 50);

        const nonce = dependencies.createNonce();
        dependencies.storeNodeSnapshot(nonce, {
          presetId: route.presetId,
          identifiers: pageNodes.map((n) => n.identifier),
        });

        await dependencies.showNodesModal(
          requireButton(interaction, route.action),
          route.locale,
          targetPreset,
          pageNodes,
          pageOffset,
          nonce,
        );
        return;
      }

      // Remaining button/modal actions that acknowledge via deferUpdate
      const initialScope = await beginPanelInteraction({
        acknowledge: () => interaction.deferUpdate(),
        authorize: () => isAuthorized(interaction),
        onDenied: () => {
          if (route.action === "add-submit") dependencies.takeFileUpload(interaction.id, route.nonce);
          if (route.action === "nodes-submit") dependencies.takeNodeSnapshot(route.nonce);
          return interaction.editReply(terminalPayload(route.locale, "general.errors.permission_denied_description"));
        },
        load: () => dependencies.resolveScope(interaction, route.action === "retry"),
        onMissing: () => {
          if (route.action === "add-submit") dependencies.takeFileUpload(interaction.id, route.nonce);
          if (route.action === "nodes-submit") dependencies.takeNodeSnapshot(route.nonce);
          return interaction.editReply(terminalPayload(route.locale, "commands.st-presets.not_setup"));
        },
      });
      if (!initialScope) return;
      let scope = initialScope;

      if (route.action === "range") {
        await repaint(
          interaction,
          route.locale,
          scope,
          resolveActiveOrNonePage(scope.data),
          undefined,
          route.rangeIndex,
        );
        return;
      }

      if (route.action === "retry" || route.action === "none") {
        const page: StPresetsPanelPage =
          route.action === "none" ? { kind: "none" } : resolveActiveOrNonePage(scope.data);
        await repaint(interaction, route.locale, scope, page);
        return;
      }

      if (route.action === "disable") {
        if (scope.data.readStatus !== "fresh") {
          await repaint(interaction, route.locale, scope, { kind: "none" });
          return;
        }

        const action = await performPanelAction(
          () => dependencies.operations.deactivateAllStPresets({ serverId: scope.state.server_id }),
          () => dependencies.resolveScope(interaction, true),
        );
        scope = action.state ?? { ...scope, data: { ...scope.data, readStatus: "unavailable" } };

        if (action.result) {
          dependencies.recordAction({
            action: "st-presets.workspace.preset.deactivate",
            serverId: scope.state.server_id,
            userDiscId: interaction.user?.id ?? "",
          });
        }

        await repaint(
          interaction,
          route.locale,
          scope,
          { kind: "none" },
          action.result
            ? {
                tone: "success",
                heading: localizer(route.locale, "commands.st-presets.disabled_receipt"),
                detail: localizer(route.locale, "commands.st-presets.disabled_receipt_detail"),
              }
            : {
                tone: "error",
                heading: localizer(route.locale, "commands.st-presets.failed_receipt"),
                detail: localizer(route.locale, "commands.st-presets.failed_receipt_detail"),
              },
        );
        return;
      }

      if (route.action === "add-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const attachment = dependencies.takeFileUpload(modal.id, route.nonce);

        if (scope.data.readStatus !== "fresh") {
          await repaint(
            interaction,
            route.locale,
            scope,
            { kind: "none" },
            {
              tone: "error",
              heading: localizer(route.locale, "commands.st-presets.failed_receipt"),
              detail: localizer(route.locale, "commands.st-presets.stale_warning"),
            },
          );
          return;
        }

        if (!attachment) {
          await repaint(
            interaction,
            route.locale,
            scope,
            { kind: "none" },
            {
              tone: "error",
              heading: localizer(route.locale, "commands.st-presets.failed_receipt"),
              detail: localizer(route.locale, "commands.st-presets.add_invalid_file"),
            },
          );
          return;
        }

        const customName = modal.fields.getTextInputValue(buildStPresetsAddModalFieldId("name", route.nonce))?.trim();
        const rawDescription = modal.fields
          .getTextInputValue(buildStPresetsAddModalFieldId("description", route.nonce))
          ?.trim();

        const action = await performPanelAction(
          () =>
            dependencies.operations.importStPreset({
              serverId: scope.state.server_id,
              attachmentUrl: attachment.url,
              attachmentName: attachment.filename,
              attachmentSize: attachment.size,
              attachmentContentType: attachment.content_type,
              customPresetName: customName || undefined,
              description: rawDescription || null,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        scope = action.state ?? { ...scope, data: { ...scope.data, readStatus: "unavailable" } };
        const result = action.result;

        if (result.status === "success") {
          dependencies.recordAction({
            action: "st-presets.workspace.preset.add",
            serverId: scope.state.server_id,
            userDiscId: interaction.user?.id ?? "",
          });
          await repaint(
            interaction,
            route.locale,
            scope,
            { kind: "preset", presetId: result.preset.preset_id },
            {
              tone: "success",
              heading: localizer(route.locale, "commands.st-presets.added_receipt"),
              detail: localizer(route.locale, "commands.st-presets.added_receipt_detail", {
                name: result.presetName,
                nodes: result.nodes.length,
                enabled: result.enabledCount,
              }),
            },
          );
        } else {
          const maxSizeMB = result.status === "file_too_large" ? result.maxSizeMB : undefined;
          await repaint(
            interaction,
            route.locale,
            scope,
            { kind: "none" },
            importFailureReceipt(route.locale, result.status, maxSizeMB),
          );
        }
        return;
      }

      if (route.action === "nodes-page") {
        const nodes = await dependencies.loadToggleableNodes(route.presetId);
        await repaint(interaction, route.locale, scope, {
          kind: "nodes-chooser",
          presetId: route.presetId,
          totalCount: nodes.length,
          chooserPage: route.chooserPage,
        });
        return;
      }

      if (route.action === "nodes-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const snapshot = dependencies.takeNodeSnapshot(route.nonce);

        if (scope.data.readStatus !== "fresh" || !snapshot) {
          await repaint(
            interaction,
            route.locale,
            scope,
            { kind: "preset", presetId: route.presetId },
            {
              tone: "error",
              heading: localizer(route.locale, "commands.st-presets.failed_receipt"),
              detail: localizer(
                route.locale,
                scope.data.readStatus !== "fresh"
                  ? "commands.st-presets.stale_warning"
                  : "commands.st-presets.failed_receipt_detail",
              ),
            },
          );
          return;
        }

        const checkedIds = new Set<string>();
        for (let groupIndex = 0; groupIndex < 5; groupIndex++) {
          const groupValues = dependencies.takeNodeCheckboxValues(modal.id, route.nonce, groupIndex);
          if (groupValues) {
            for (const val of groupValues) checkedIds.add(val);
          }
        }

        const enabledMap = new Map<string, boolean>();
        for (const id of snapshot.identifiers) {
          enabledMap.set(id, checkedIds.has(id));
        }

        const action = await performPanelAction(
          () =>
            dependencies.operations.updateStPresetNodes({
              serverId: scope.state.server_id,
              presetId: route.presetId,
              enabledMap,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        scope = action.state ?? { ...scope, data: { ...scope.data, readStatus: "unavailable" } };

        if (action.result) {
          dependencies.recordAction({
            action: "st-presets.workspace.nodes.save",
            serverId: scope.state.server_id,
            userDiscId: interaction.user?.id ?? "",
          });
        }

        const targetPreset = scope.data.presets.find((p) => p.preset_id === route.presetId);
        await repaint(
          interaction,
          route.locale,
          scope,
          { kind: "preset", presetId: route.presetId },
          action.result
            ? {
                tone: "success",
                heading: localizer(route.locale, "commands.st-presets.nodes_updated_receipt"),
                detail: localizer(route.locale, "commands.st-presets.nodes_updated_receipt_detail", {
                  name: targetPreset?.preset_name ?? "Preset",
                }),
              }
            : {
                tone: "error",
                heading: localizer(route.locale, "commands.st-presets.failed_receipt"),
                detail: localizer(route.locale, "commands.st-presets.failed_receipt_detail"),
              },
        );
        return;
      }

      if (route.action === "delete-prompt") {
        await repaint(interaction, route.locale, scope, { kind: "delete", presetId: route.presetId });
        return;
      }

      if (route.action === "delete-cancel") {
        await repaint(interaction, route.locale, scope, { kind: "preset", presetId: route.presetId });
        return;
      }

      if (route.action === "delete-confirm") {
        if (scope.data.readStatus !== "fresh") {
          await repaint(interaction, route.locale, scope, { kind: "preset", presetId: route.presetId });
          return;
        }

        const targetPreset = scope.data.presets.find((p) => p.preset_id === route.presetId);
        if (!targetPreset) {
          await repaint(
            interaction,
            route.locale,
            scope,
            resolveActiveOrNonePage(scope.data),
            changedStateReceipt(route.locale),
          );
          return;
        }

        const action = await performPanelAction(
          () =>
            dependencies.operations.removeStPresetsWithPromotion({
              serverId: scope.state.server_id,
              allPresets: scope.data.presets,
              presetIdsToRemove: [route.presetId],
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        scope = action.state ?? { ...scope, data: { ...scope.data, readStatus: "unavailable" } };
        const result = action.result;

        if (result && result.successCount > 0) {
          dependencies.recordAction({
            action: "st-presets.workspace.preset.remove",
            serverId: scope.state.server_id,
            userDiscId: interaction.user?.id ?? "",
          });
          if (result.promotedPreset && result.promotedPreset.preset_id !== undefined) {
            await repaint(
              interaction,
              route.locale,
              scope,
              { kind: "preset", presetId: result.promotedPreset.preset_id },
              {
                tone: "success",
                heading: localizer(route.locale, "commands.st-presets.deleted_receipt"),
                detail: localizer(route.locale, "commands.st-presets.deleted_and_promoted_receipt_detail", {
                  name: targetPreset.preset_name,
                  promoted: result.promotedPreset.preset_name,
                }),
              },
            );
          } else {
            await repaint(
              interaction,
              route.locale,
              scope,
              { kind: "none" },
              {
                tone: "success",
                heading: localizer(route.locale, "commands.st-presets.deleted_receipt"),
                detail: localizer(route.locale, "commands.st-presets.deleted_receipt_detail", {
                  name: targetPreset.preset_name,
                }),
              },
            );
          }
        } else {
          await repaint(
            interaction,
            route.locale,
            scope,
            { kind: "preset", presetId: route.presetId },
            {
              tone: "error",
              heading: localizer(route.locale, "commands.st-presets.failed_receipt"),
              detail: localizer(route.locale, "commands.st-presets.failed_receipt_detail"),
            },
          );
        }
        return;
      }
    },
  };
}

export const stPresetsInteractionRoute = createStPresetsInteractionRoute();

export async function buildInitialStPresetsPanel(
  interaction: ChatInputCommandInteraction,
  locale: string,
): Promise<StPresetsPanelPayloadOrTerminal> {
  if (!isAuthorized(interaction)) {
    return terminalPayload(locale, "general.errors.permission_denied_description") as StPresetsPanelPayloadOrTerminal;
  }

  const discordId = interaction.guildId ?? interaction.user.id;
  const state = await getCachedTomoriState(discordId);
  if (!state) {
    const lastError = getLastDbError(discordId);
    if (lastError) {
      return buildStPresetsPanelPayload({
        locale,
        scope: interaction.guildId ? "guild" : "dm",
        presets: [],
        activePresetId: null,
        readStatus: "unavailable",
        page: { kind: "none" },
      });
    }
    return terminalPayload(locale, "commands.st-presets.not_setup") as StPresetsPanelPayloadOrTerminal;
  }

  const data = await stPresetOperations.loadStPresetScopeData(discordId);
  if (!data) return terminalPayload(locale, "commands.st-presets.not_setup") as StPresetsPanelPayloadOrTerminal;

  return buildStPresetsPanelPayload({
    locale,
    scope: interaction.guildId ? "guild" : "dm",
    presets: data.presets,
    activePresetId: data.activePresetId,
    activeNodeCounts: data.activeNodeCounts,
    readStatus: data.readStatus,
    page: resolveActiveOrNonePage(data),
  });
}

type StPresetsPanelPayloadOrTerminal = ReturnType<typeof buildStPresetsPanelPayload> | InteractionEditReplyOptions;
