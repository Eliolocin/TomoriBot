import {
  ComponentType,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type InteractionEditReplyOptions,
  type ModalSubmitInteraction,
} from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import type { PanelReceipt } from "@/types/discord/panel";
import {
  conditioningMemoryRepository,
  type ConditioningGroup,
} from "@/utils/db/repositories/ConditioningMemoryRepository";
import { personaRepository } from "@/utils/db/repositories";
import type { GlobalInteractionRoute, GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import {
  beginPanelInteraction,
  deliverGuardedPanel,
  resolveRangeSelection,
  validateAndFallbackPanelPayload,
} from "@/utils/discord/interactions/panelController";
import { createNonce } from "@/utils/discord/panelRouteTokens";
import {
  CONDITIONING_ROUTE_NAMESPACE,
  CONDITIONING_ROUTE_VERSION,
  computeConditioningAggregateFingerprint,
  parseConditioningPanelRoute,
  type ConditioningAggregateEntry,
} from "@/utils/discord/conditioningPanelCatalog";
import {
  buildConditioningCheckboxGroupId,
  buildConditioningPanelPayload,
  buildConditioningRemoveModal,
  CONDITIONING_PANEL_PAGE_SIZE,
} from "@/utils/discord/ui/conditioningPanel";
import { showRoutedRawModal, takeRawModalCheckboxGroupValues } from "@/utils/discord/ui/modals";
import { buildPanelContainer } from "@/utils/discord/ui/panel";
import { localizer } from "@/utils/text/localizer";

export const CONFIG_CONDITIONING_CHECKBOX_GROUP_SIZE = 10;

export interface ConditioningScope {
  guildId: string;
  entries: ConditioningAggregateEntry[];
}

export interface ConditioningRouteDependencies {
  resolveScope(interaction: GlobalRoutableInteraction | ChatInputCommandInteraction): Promise<ConditioningScope | null>;
  deleteGroups(
    serverId: number,
    personaLineageId: number,
    groups: Array<Pick<ConditioningGroup, "conditioningType" | "actionKey" | "reasonNormalized">>,
  ): Promise<number>;
  showRemoveModal(
    interaction: ButtonInteraction,
    locale: string,
    range: number,
    fp: string,
    nonce: string,
    entries: readonly ConditioningAggregateEntry[],
  ): Promise<void>;
  takeCheckboxValues(interactionId: string, fieldId: string): string[] | undefined;
  createNonce(): string;
}

function isAuthorized(interaction: GlobalRoutableInteraction): boolean {
  return Boolean(interaction.guildId && (interaction.memberPermissions?.has("ManageGuild") ?? false));
}

function terminalPayload(locale: string, key: string): InteractionEditReplyOptions {
  return validateAndFallbackPanelPayload(
    {
      components: [
        buildPanelContainer([
          {
            type: ComponentType.TextDisplay,
            content: localizer(locale, key),
          },
        ]),
      ],
      flags: MessageFlags.IsComponentsV2,
    },
    locale,
  );
}

export async function loadConditioningManageEntriesWithPersonas(
  personas: TomoriState[],
): Promise<ConditioningAggregateEntry[]> {
  const personaEntries = await Promise.all(
    personas.map(async (persona) => {
      const groups = await conditioningMemoryRepository.loadGroupsForPersona(
        persona.server_id,
        persona.persona_lineage_id ?? 0,
      );
      return groups.map(
        (group): ConditioningAggregateEntry => ({
          ...group,
          serverId: persona.server_id,
          personaName: persona.persona_nickname,
          personaLineageId: persona.persona_lineage_id ?? 0,
        }),
      );
    }),
  );

  return personaEntries
    .flat()
    .filter((entry) => entry.reasonText.trim().length > 0)
    .sort((a, b) => {
      const timeDiff = b.updatedAt.getTime() - a.updatedAt.getTime();
      if (timeDiff !== 0) return timeDiff;
      return a.personaName.localeCompare(b.personaName);
    });
}

async function defaultResolveScope(
  interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
): Promise<ConditioningScope | null> {
  const guildId = interaction.guildId;
  if (!guildId) return null;

  const personas = await personaRepository.loadAllForServer(guildId);
  if (personas.length === 0) return null;

  const entries = await loadConditioningManageEntriesWithPersonas(personas);
  return { guildId, entries };
}

function staleReceipt(locale: string): PanelReceipt {
  return {
    tone: "info",
    heading: localizer(locale, "commands.conditioning.panel.stale_heading"),
    detail: localizer(locale, "commands.conditioning.panel.stale_detail"),
  };
}

function noChangesReceipt(locale: string): PanelReceipt {
  return {
    tone: "info",
    heading: localizer(locale, "commands.conditioning.panel.no_changes_heading"),
    detail: localizer(locale, "commands.conditioning.panel.no_changes_detail"),
  };
}

function successReceipt(locale: string, count: number): PanelReceipt {
  return {
    tone: "success",
    heading: localizer(locale, "commands.conditioning.panel.success_heading"),
    detail: localizer(locale, "commands.conditioning.panel.success_detail", { count: String(count) }),
  };
}

function writeFailedReceipt(locale: string): PanelReceipt {
  return {
    tone: "error",
    heading: localizer(locale, "commands.conditioning.panel.write_failed_heading"),
    detail: localizer(locale, "commands.conditioning.panel.write_failed_detail"),
  };
}

export function createConditioningInteractionRoute(
  overrides: Partial<ConditioningRouteDependencies> = {},
): GlobalInteractionRoute {
  const dependencies: ConditioningRouteDependencies = {
    resolveScope: defaultResolveScope,
    deleteGroups: (serverId, personaLineageId, groups) =>
      conditioningMemoryRepository.deleteGroupsForPersona(serverId, personaLineageId, groups),
    showRemoveModal: (interaction, locale, range, fp, nonce, entries) =>
      showRoutedRawModal(interaction, buildConditioningRemoveModal(locale, range, fp, nonce, entries)),
    takeCheckboxValues: takeRawModalCheckboxGroupValues,
    createNonce,
    ...overrides,
  };

  return {
    namespace: CONDITIONING_ROUTE_NAMESPACE,
    version: CONDITIONING_ROUTE_VERSION,
    async execute(_client, interaction, parsed): Promise<void> {
      const route = parseConditioningPanelRoute(parsed);
      if (!route) throw new Error(`Malformed conditioning panel route: ${interaction.customId}`);

      const expectsModal = route.action === "remove-submit";
      if (expectsModal && !interaction.isModalSubmit()) {
        throw new Error("Conditioning remove-submit route requires a modal submission");
      }
      if (!expectsModal && !interaction.isButton()) {
        throw new Error(`Conditioning ${route.action} route requires a button interaction`);
      }

      if (route.action === "remove-open") {
        if (!isAuthorized(interaction)) {
          await interaction.reply({
            content: localizer(route.locale, "general.errors.permission_denied_description"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const scope = await dependencies.resolveScope(interaction);
        if (!scope) {
          await interaction.reply({
            content: localizer(route.locale, "general.errors.tomori_not_setup_description"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const selection = resolveRangeSelection(scope.entries, route.range, CONDITIONING_PANEL_PAGE_SIZE);
        const currentFp = computeConditioningAggregateFingerprint(selection.visibleItems, selection.rangeIndex);

        if (currentFp !== route.fp) {
          await interaction.deferUpdate();
          await deliverGuardedPanel(
            interaction,
            buildConditioningPanelPayload({
              locale: route.locale,
              entries: scope.entries,
              rangeIndex: selection.rangeIndex,
              receipt: staleReceipt(route.locale),
            }),
            { locale: route.locale },
          );
          return;
        }

        const nonce = dependencies.createNonce();
        await dependencies.showRemoveModal(
          interaction as ButtonInteraction,
          route.locale,
          selection.rangeIndex,
          route.fp,
          nonce,
          selection.visibleItems,
        );
        return;
      }

      if (route.action === "range") {
        const scope = await beginPanelInteraction(interaction, {
          authorize: () => isAuthorized(interaction),
          onDenied: () =>
            interaction.editReply(terminalPayload(route.locale, "general.errors.permission_denied_description")),
          load: () => dependencies.resolveScope(interaction),
          onMissing: () =>
            interaction.editReply(terminalPayload(route.locale, "general.errors.tomori_not_setup_description")),
        });
        if (!scope) return;

        await deliverGuardedPanel(
          interaction,
          buildConditioningPanelPayload({
            locale: route.locale,
            entries: scope.entries,
            rangeIndex: route.range,
          }),
          { locale: route.locale },
        );
        return;
      }

      if (route.action === "remove-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const initialScope = await beginPanelInteraction(interaction, {
          authorize: () => isAuthorized(interaction),
          onDenied: () => {
            dependencies.takeCheckboxValues(modal.id, buildConditioningCheckboxGroupId(0, route.nonce));
            return interaction.editReply(terminalPayload(route.locale, "general.errors.permission_denied_description"));
          },
          load: () => dependencies.resolveScope(interaction),
          onMissing: () => {
            dependencies.takeCheckboxValues(modal.id, buildConditioningCheckboxGroupId(0, route.nonce));
            return interaction.editReply(terminalPayload(route.locale, "general.errors.tomori_not_setup_description"));
          },
        });
        if (!initialScope) return;

        const scope = initialScope;
        const selection = resolveRangeSelection(scope.entries, route.range, CONDITIONING_PANEL_PAGE_SIZE);
        const currentFp = computeConditioningAggregateFingerprint(selection.visibleItems, selection.rangeIndex);

        const groupCount = Math.max(
          1,
          Math.ceil(selection.visibleItems.length / CONFIG_CONDITIONING_CHECKBOX_GROUP_SIZE),
        );

        if (currentFp !== route.fp) {
          for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
            dependencies.takeCheckboxValues(modal.id, buildConditioningCheckboxGroupId(groupIndex, route.nonce));
          }
          await deliverGuardedPanel(
            interaction,
            buildConditioningPanelPayload({
              locale: route.locale,
              entries: scope.entries,
              rangeIndex: selection.rangeIndex,
              receipt: staleReceipt(route.locale),
            }),
            { locale: route.locale },
          );
          return;
        }

        const checked = new Set<number>();
        let hasCheckboxEvidence = false;

        for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
          const values = dependencies.takeCheckboxValues(
            modal.id,
            buildConditioningCheckboxGroupId(groupIndex, route.nonce),
          );
          if (values === undefined) continue;
          hasCheckboxEvidence = true;
          for (const value of values) {
            const parsed = Number.parseInt(value, 10);
            if (Number.isInteger(parsed)) checked.add(parsed);
          }
        }

        if (!hasCheckboxEvidence) {
          await deliverGuardedPanel(
            interaction,
            buildConditioningPanelPayload({
              locale: route.locale,
              entries: scope.entries,
              rangeIndex: selection.rangeIndex,
              receipt: staleReceipt(route.locale),
            }),
            { locale: route.locale },
          );
          return;
        }

        const uncheckedEntries = selection.visibleItems.filter((_, index) => !checked.has(index));
        if (uncheckedEntries.length === 0) {
          await deliverGuardedPanel(
            interaction,
            buildConditioningPanelPayload({
              locale: route.locale,
              entries: scope.entries,
              rangeIndex: selection.rangeIndex,
              receipt: noChangesReceipt(route.locale),
            }),
            { locale: route.locale },
          );
          return;
        }

        const byLineage = new Map<
          string,
          {
            serverId: number;
            personaLineageId: number;
            groups: Array<Pick<ConditioningGroup, "conditioningType" | "actionKey" | "reasonNormalized">>;
          }
        >();

        for (const entry of uncheckedEntries) {
          const key = `${entry.serverId}:${entry.personaLineageId}`;
          let item = byLineage.get(key);
          if (!item) {
            item = {
              serverId: entry.serverId,
              personaLineageId: entry.personaLineageId,
              groups: [],
            };
            byLineage.set(key, item);
          }
          item.groups.push({
            conditioningType: entry.conditioningType,
            actionKey: entry.actionKey,
            reasonNormalized: entry.reasonNormalized,
          });
        }

        let totalDeleted = 0;
        for (const item of byLineage.values()) {
          const count = await dependencies.deleteGroups(item.serverId, item.personaLineageId, item.groups);
          totalDeleted += count;
        }

        const receipt =
          totalDeleted === 0 ? writeFailedReceipt(route.locale) : successReceipt(route.locale, uncheckedEntries.length);

        const refreshedScope = await dependencies.resolveScope(interaction);
        await deliverGuardedPanel(
          interaction,
          buildConditioningPanelPayload({
            locale: route.locale,
            entries: refreshedScope?.entries ?? [],
            rangeIndex: selection.rangeIndex,
            receipt,
          }),
          { locale: route.locale },
        );
        return;
      }
    },
  };
}

export const conditioningInteractionRoute = createConditioningInteractionRoute();
