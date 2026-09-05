import {
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type ModalSubmitInteraction,
} from "discord.js";
import type { ErrorContext, LlmRow, TomoriState } from "@/types/db/schema";
import { getCachedAllPersonas, getCachedTomoriState } from "@/utils/cache/tomoriStateCache";
import { llmOverrideRepo } from "@/utils/db/repositories";
import type { GlobalInteractionRoute, GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import { createNonce } from "@/utils/discord/panelRouteTokens";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { showRoutedRawModal, takeRawModalCheckboxGroupValues } from "@/utils/discord/ui/modals";
import { ColorCode, log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";
import {
  MODEL_OVERRIDE_MODAL_CAPACITY,
  MODEL_OVERRIDE_ROUTE_NAMESPACE,
  MODEL_OVERRIDE_ROUTE_VERSION,
  computeModelOverrideBatchFingerprint,
  parseModelOverridePanelRoute,
  sortModelOverrideEntries,
  type ChannelOverrideEntry,
  type ModelOverrideEntry,
  type PersonaOverrideEntry,
} from "@/utils/discord/modelOverrideCatalog";
import {
  buildModelOverrideCheckboxGroupId,
  buildModelOverrideRemoveModal,
} from "@/utils/discord/ui/modelOverridePanel";
import {
  setTextModelOverride,
  type TextModelOverrideInput,
} from "@/utils/discord/interactions/textModelOverrideOperations";

interface ModelOverrideScope {
  guildId: string;
  serverId: number;
  channelOverrides: ChannelOverrideEntry[];
  personasWithOverride: PersonaOverrideEntry[];
  entries: ModelOverrideEntry[];
}

export interface ModelOverrideRouteDependencies {
  resolveScope(
    interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
  ): Promise<ModelOverrideScope | null>;
  setTextModelOverride(input: TextModelOverrideInput): Promise<boolean>;
  showRemoveModal(
    interaction: ButtonInteraction,
    locale: string,
    page: number,
    fp: string,
    nonce: string,
    entries: readonly ModelOverrideEntry[],
    guild?: Guild | null,
  ): Promise<void>;
  takeCheckboxValues(interactionId: string, fieldId: string): string[] | undefined;
  createNonce(): string;
}

function isAuthorized(interaction: GlobalRoutableInteraction | ChatInputCommandInteraction): boolean {
  return Boolean(interaction.guildId && (interaction.memberPermissions?.has("ManageGuild") ?? false));
}

export async function loadModelOverrideEntries(
  serverId: number,
  guildId: string,
): Promise<{
  channelOverrides: ChannelOverrideEntry[];
  personasWithOverride: PersonaOverrideEntry[];
  entries: ModelOverrideEntry[];
}> {
  const [channelOverrides, allPersonas] = await Promise.all([
    llmOverrideRepo.getAllChannelLlmOverridesForServer(serverId),
    getCachedAllPersonas(guildId),
  ]);

  const channelEntries: ChannelOverrideEntry[] = channelOverrides.map((entry) => ({
    scope: "channel",
    channelDiscId: entry.channelDiscId,
    llm: entry.llm,
  }));

  const personaEntries: PersonaOverrideEntry[] = allPersonas
    .filter(
      (persona): persona is TomoriState & { persona_llm: LlmRow; persona_id: number } =>
        persona.persona_llm != null && persona.persona_id != null,
    )
    .map((persona) => ({
      scope: "persona",
      persona_id: persona.persona_id,
      persona_nickname: persona.persona_nickname,
      persona_llm: persona.persona_llm,
    }));

  const entries = sortModelOverrideEntries(channelEntries, personaEntries);
  return { channelOverrides: channelEntries, personasWithOverride: personaEntries, entries };
}

async function defaultResolveScope(
  interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
): Promise<ModelOverrideScope | null> {
  const guildId = interaction.guildId;
  if (!guildId) return null;

  const tomoriState = await getCachedTomoriState(guildId);
  if (!tomoriState) return null;

  const loaded = await loadModelOverrideEntries(tomoriState.server_id, guildId);
  return {
    guildId,
    serverId: tomoriState.server_id,
    ...loaded,
  };
}

function formatRemovedNames(names: string[]): string {
  const maxVisibleNames = 10;
  const visibleNames = names.slice(0, maxVisibleNames);
  const suffix = names.length > maxVisibleNames ? ", ..." : "";
  return `${visibleNames.join(", ")}${suffix}`;
}

export function createModelOverrideInteractionRoute(
  overrides: Partial<ModelOverrideRouteDependencies> = {},
): GlobalInteractionRoute {
  const dependencies: ModelOverrideRouteDependencies = {
    resolveScope: defaultResolveScope,
    setTextModelOverride,
    showRemoveModal: (interaction, locale, page, fp, nonce, entries, guild) =>
      showRoutedRawModal(interaction, buildModelOverrideRemoveModal(locale, page, fp, nonce, entries, guild)),
    takeCheckboxValues: takeRawModalCheckboxGroupValues,
    createNonce,
    ...overrides,
  };

  return {
    namespace: MODEL_OVERRIDE_ROUTE_NAMESPACE,
    version: MODEL_OVERRIDE_ROUTE_VERSION,
    async execute(_client: Client, interaction: GlobalRoutableInteraction, parsed): Promise<void> {
      const route = parseModelOverridePanelRoute(parsed);
      if (!route) {
        throw new Error(`Malformed model override route: ${interaction.customId}`);
      }

      const expectsModal = route.action === "remove-submit";
      if (expectsModal && !interaction.isModalSubmit()) {
        throw new Error("Model override remove-submit route requires a modal submission");
      }
      if (!expectsModal && !interaction.isButton()) {
        throw new Error(`Model override ${route.action} route requires a button interaction`);
      }

      if (route.action === "page") {
        const button = interaction as ButtonInteraction;
        if (!isAuthorized(button)) {
          await replyInfoEmbed(button, route.locale, {
            titleKey: "general.errors.permission_denied_title",
            descriptionKey: "general.errors.permission_denied_description",
            color: ColorCode.ERROR,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const scope = await dependencies.resolveScope(button);
        if (!scope) {
          await replyInfoEmbed(button, route.locale, {
            titleKey: "general.errors.tomori_not_setup_title",
            descriptionKey: "general.errors.tomori_not_setup_description",
            color: ColorCode.ERROR,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const startIndex = route.page * MODEL_OVERRIDE_MODAL_CAPACITY;
        const pageEntries = scope.entries.slice(startIndex, startIndex + MODEL_OVERRIDE_MODAL_CAPACITY);
        if (pageEntries.length === 0) {
          await replyInfoEmbed(button, route.locale, {
            titleKey: "commands.model.override.remove.none_title",
            descriptionKey: "commands.model.override.remove.none_description",
            color: ColorCode.WARN,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const fp = computeModelOverrideBatchFingerprint(pageEntries, route.page);
        const nonce = dependencies.createNonce();
        await dependencies.showRemoveModal(button, route.locale, route.page, fp, nonce, pageEntries, button.guild);
        return;
      }

      if (route.action === "remove-submit") {
        const modal = interaction as ModalSubmitInteraction;

        if (!isAuthorized(interaction)) {
          dependencies.takeCheckboxValues(modal.id, buildModelOverrideCheckboxGroupId(0, route.nonce));
          await replyInfoEmbed(modal, route.locale, {
            titleKey: "general.errors.permission_denied_title",
            descriptionKey: "general.errors.permission_denied_description",
            color: ColorCode.ERROR,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await modal.deferReply({ flags: MessageFlags.Ephemeral });

        const scope = await dependencies.resolveScope(interaction);
        if (!scope) {
          dependencies.takeCheckboxValues(modal.id, buildModelOverrideCheckboxGroupId(0, route.nonce));
          await replyInfoEmbed(modal, route.locale, {
            titleKey: "general.errors.tomori_not_setup_title",
            descriptionKey: "general.errors.tomori_not_setup_description",
            color: ColorCode.ERROR,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const startIndex = route.page * MODEL_OVERRIDE_MODAL_CAPACITY;
        const pageEntries = scope.entries.slice(startIndex, startIndex + MODEL_OVERRIDE_MODAL_CAPACITY);
        const currentFp = computeModelOverrideBatchFingerprint(pageEntries, route.page);
        const groupCount = Math.max(1, Math.ceil(pageEntries.length / 10));

        if (currentFp !== route.fp) {
          for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
            dependencies.takeCheckboxValues(modal.id, buildModelOverrideCheckboxGroupId(groupIndex, route.nonce));
          }
          await replyInfoEmbed(modal, route.locale, {
            titleKey: "general.errors.operation_failed_title",
            descriptionKey: "general.errors.outdated_panel",
            descriptionVars: { command: "/model override remove" },
            color: ColorCode.WARN,
          });
          return;
        }

        const checked = new Set<number>();
        let hasCheckboxEvidence = false;

        for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
          const values = dependencies.takeCheckboxValues(
            modal.id,
            buildModelOverrideCheckboxGroupId(groupIndex, route.nonce),
          );
          if (values === undefined) continue;
          hasCheckboxEvidence = true;
          for (const value of values) {
            const parsed = Number.parseInt(value, 10);
            if (Number.isInteger(parsed)) checked.add(parsed);
          }
        }

        if (!hasCheckboxEvidence) {
          await replyInfoEmbed(modal, route.locale, {
            titleKey: "general.errors.operation_failed_title",
            descriptionKey: "general.errors.outdated_panel",
            descriptionVars: { command: "/model override remove" },
            color: ColorCode.WARN,
          });
          return;
        }

        const uncheckedEntries = pageEntries.filter((_, index) => !checked.has(index));
        if (uncheckedEntries.length === 0) {
          await replyInfoEmbed(modal, route.locale, {
            titleKey: "commands.model.override.remove.no_removals_title",
            descriptionKey: "commands.model.override.remove.no_removals_description",
            color: ColorCode.INFO,
          });
          return;
        }

        const channelOverridesToRemove = uncheckedEntries.filter(
          (entry): entry is ChannelOverrideEntry => entry.scope === "channel",
        );
        const personasToClear = uncheckedEntries.filter(
          (entry): entry is PersonaOverrideEntry => entry.scope === "persona",
        );

        const [channelDeletionResults, personaClearResults] = await Promise.all([
          Promise.all(
            channelOverridesToRemove.map(async (entry) => ({
              entry,
              deleted: await dependencies.setTextModelOverride({
                scope: "channel",
                serverId: scope.serverId,
                channelId: entry.channelDiscId,
                llmId: null,
                serverDiscId: scope.guildId,
              }),
            })),
          ),
          Promise.all(
            personasToClear.map(async (persona) => ({
              persona,
              cleared: await dependencies.setTextModelOverride({
                scope: "persona",
                personaId: persona.persona_id,
                llmId: null,
                serverDiscId: scope.guildId,
              }),
            })),
          ),
        ]);

        const removedChannelOverrides = channelDeletionResults
          .filter((result) => result.deleted)
          .map((result) => result.entry);
        const failedChannelOverrides = channelDeletionResults
          .filter((result) => !result.deleted)
          .map((result) => result.entry);
        const clearedPersonaOverrides = personaClearResults
          .filter((result) => result.cleared)
          .map((result) => result.persona);
        const failedPersonaOverrides = personaClearResults
          .filter((result) => !result.cleared)
          .map((result) => result.persona);

        if (failedChannelOverrides.length > 0 || failedPersonaOverrides.length > 0) {
          const context: ErrorContext = {
            serverId: scope.serverId,
            errorType: "DatabaseDeleteError",
            metadata: {
              command: "model override remove",
              failedChannelDiscIds: failedChannelOverrides.map((entry) => entry.channelDiscId),
              failedTomoriIds: failedPersonaOverrides.map((persona) => persona.persona_id),
            },
          };
          await log.error(
            "Failed to clear one or more model overrides",
            new Error("One or more model override deletes returned false"),
            context,
          );
          await replyInfoEmbed(modal, route.locale, {
            titleKey: "general.errors.update_failed_title",
            descriptionKey: "general.errors.update_failed_description",
            color: ColorCode.ERROR,
          });
          return;
        }

        const removedSections: string[] = [];
        if (removedChannelOverrides.length > 0) {
          const channelMentions = removedChannelOverrides.map(
            (entry) =>
              interaction.guild?.channels.cache.get(entry.channelDiscId)?.toString() ?? `<#${entry.channelDiscId}>`,
          );
          removedSections.push(
            `**${localizer(route.locale, "commands.model.override.remove.channel_checkbox_label")}**\n${formatRemovedNames(channelMentions)}`,
          );
        }
        if (clearedPersonaOverrides.length > 0) {
          removedSections.push(
            `**${localizer(route.locale, "commands.model.override.remove.persona_checkbox_label")}**\n${formatRemovedNames(clearedPersonaOverrides.map((persona) => `**${persona.persona_nickname}**`))}`,
          );
        }

        await replyInfoEmbed(modal, route.locale, {
          titleKey: "commands.model.override.remove.success_title",
          descriptionKey: "commands.model.override.remove.success_description",
          descriptionVars: {
            removed_overrides: removedSections.join("\n\n"),
          },
          color: ColorCode.SUCCESS,
        });

        log.success(
          `Removed ${removedChannelOverrides.length} channel and ${clearedPersonaOverrides.length} persona model override(s) from server ${interaction.guildId}`,
        );
      }
    },
  };
}

export const modelOverrideInteractionRoute = createModelOverrideInteractionRoute();
