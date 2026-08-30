import {
  ChannelType,
  type ChatInputCommandInteraction,
  type InteractionEditReplyOptions,
  type ModalSubmitInteraction,
} from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import { getCachedAllPersonas, getCachedTomoriState } from "@/utils/cache/tomoriStateCache";
import { userRepository } from "@/utils/db/repositories";
import type { GlobalInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import { beginPanelInteraction, performPanelAction } from "@/utils/discord/interactions/panelController";
import {
  getMemoryCount,
  getStmCount,
  loadAvailableModelsForCapability,
  loadPersonalModelDisplayInfo,
  loadPersonaNamingPreference,
  loadUserSavedProviders,
  resolveScope,
} from "@/utils/discord/interactions/personalConfigLoaders";
import { personalConfigOperations } from "@/utils/discord/interactions/personalConfigOperations";
import { createNonce } from "@/utils/discord/panelRouteTokens";
import {
  PERSONAL_CONFIG_ROUTE_NAMESPACE,
  PERSONAL_CONFIG_ROUTE_VERSION,
  SPOTLIGHT_PERSONA_PAGE_SIZE,
  SPOTLIGHT_REMOVE_PAGE_SIZE,
  computeSpotlightRemoveFingerprint,
  computeSpotlightSetFingerprint,
  encodeSpotlightMask,
  parsePersonalConfigPanelRoute,
} from "@/utils/discord/personalConfigPanelCatalog";
import {
  buildAboutModal,
  buildAppearanceModal,
  buildFallbacksModal,
  buildImpersonationModal,
  buildLanguageModal,
  buildModelSelectModal,
  buildNamingModal,
  buildParameters1Modal,
  buildParameters2Modal,
  buildPersonaNamingModal,
  buildPersonalConfigModalFieldId,
  buildPrivacyLevelModal,
  buildQuickToggleModal,
  buildSpotlightAutoTriggerModal,
  buildSpotlightRemoveModal,
  buildSpotlightSetModal,
  buildSpotlightStep1Modal,
  buildTimezoneModal,
} from "@/utils/discord/ui/personalConfigModals";
import { buildPersonalConfigPanelPayload } from "@/utils/discord/ui/personalConfigPanel";
import {
  showRoutedRawModal,
  takeRawModalCheckboxGroupValues,
  takeRawModalSelectValue,
} from "@/utils/discord/ui/modals";
import { recordPanelActionStat } from "@/utils/stats/panelActionMetrics";
import { localizer } from "@/utils/text/localizer";
import {
  noChangesReceipt,
  repaint,
  resolveSpotlightBlockSelection,
  terminalPayload,
  type PersonalConfigPostDeferContext,
  type PersonalConfigRouteDependencies,
} from "@/utils/discord/interactions/personalConfigRouteContext";
import { handlePersonalConfigModalOpen } from "@/utils/discord/interactions/personalConfigModalOpenRoutes";
import { handlePersonalConfigNavigation } from "@/utils/discord/interactions/personalConfigNavigationRoutes";
import { handlePersonalConfigProfileWrites } from "@/utils/discord/interactions/personalConfigProfileRoutes";
import { handlePersonalConfigModelRoutes } from "@/utils/discord/interactions/personalConfigModelRoutes";
import { handlePersonalConfigResponseRoutes } from "@/utils/discord/interactions/personalConfigResponseRoutes";

const defaultDependencies: PersonalConfigRouteDependencies = {
  resolveScope,
  loadPersonaNamingPreference,
  getMemoryCount,
  getStmCount,
  loadUserSavedProviders,
  loadPersonalModelDisplayInfo,
  loadAvailableModelsForCapability,
  loadActiveSpotlights: (serverId, userId) => userRepository.getActivePersonalSpotlightsForUser(serverId, userId),
  loadGuildPersonas: async (guildId) => {
    const allPersonas: TomoriState[] = await getCachedAllPersonas(guildId);
    return (
      allPersonas
        .filter((p): p is TomoriState & { persona_id: number } => typeof p.persona_id === "number")
        // Spotlight selection travels as a positional bitmask over this list, so the order must not
        // depend on cache population order between the modal and its confirmation.
        .sort((left, right) => left.persona_id - right.persona_id)
        .map((p) => ({
          id: p.persona_id,
          name: p.persona_nickname,
          isAlter: Boolean(p.is_alter),
        }))
    );
  },
  loadTomoriState: async (guildId) => getCachedTomoriState(guildId),
  loadServerTriggerBehavior: async (guildId) => {
    try {
      const tomoriState = await getCachedTomoriState(guildId);
      if (!tomoriState?.config) return null;
      return {
        deliberate_trigger_mode: Boolean(tomoriState.config.deliberate_trigger_mode),
        deliberate_tool_mode: Boolean(tomoriState.config.deliberate_tool_mode),
      };
    } catch {
      return null;
    }
  },
  operations: personalConfigOperations,
  recordAction: (input) => {
    void recordPanelActionStat(input);
  },
  createNonce,
  showLanguageModal: (interaction, locale, nonce, currentLanguage) =>
    showRoutedRawModal(interaction, buildLanguageModal(locale, nonce, currentLanguage)),
  showTimezoneModal: (interaction, locale, nonce, currentOffset) =>
    showRoutedRawModal(interaction, buildTimezoneModal(locale, nonce, currentOffset)),
  showNamingModal: (interaction, locale, nonce, current) =>
    showRoutedRawModal(interaction, buildNamingModal(locale, nonce, current)),
  showPersonaNamingModal: (interaction, locale, lineageId, nonce, current) =>
    showRoutedRawModal(interaction, buildPersonaNamingModal(locale, lineageId, nonce, current)),
  showAboutModal: (interaction, locale, nonce, current) =>
    showRoutedRawModal(interaction, buildAboutModal(locale, nonce, current)),
  showAppearanceModal: (interaction, locale, nonce, currentTags) =>
    showRoutedRawModal(interaction, buildAppearanceModal(locale, nonce, currentTags)),
  showPrivacyLevelModal: (interaction, locale, nonce, currentLevel) =>
    showRoutedRawModal(interaction, buildPrivacyLevelModal(locale, nonce, currentLevel)),
  showQuickToggleModal: (interaction, locale, nonce, savedProviders) =>
    showRoutedRawModal(interaction, buildQuickToggleModal(locale, nonce, savedProviders)),
  showModelSelectModal: (interaction, locale, nonce, capability, provider, availableModels, currentModelId) =>
    showRoutedRawModal(
      interaction,
      buildModelSelectModal(locale, nonce, capability, provider, availableModels, currentModelId),
    ),
  showParameters1Modal: (interaction, locale, nonce, provider, currentConfig) =>
    showRoutedRawModal(interaction, buildParameters1Modal(locale, nonce, provider, currentConfig)),
  showParameters2Modal: (interaction, locale, nonce, provider, currentConfig) =>
    showRoutedRawModal(interaction, buildParameters2Modal(locale, nonce, provider, currentConfig)),
  showFallbacksModal: (interaction, locale, nonce, provider, availableOptions, currentRefs) =>
    showRoutedRawModal(interaction, buildFallbacksModal(locale, nonce, provider, availableOptions, currentRefs)),
  showImpersonationModal: (interaction, locale, nonce, currentPrompt) =>
    showRoutedRawModal(interaction, buildImpersonationModal(locale, nonce, currentPrompt)),
  showSpotlightStep1Modal: (interaction, locale, nonce) =>
    showRoutedRawModal(interaction, buildSpotlightStep1Modal(locale, nonce)),
  showSpotlightSetModal: (interaction, locale, nonce, channelId, hours, blockIdx, fp, personas) =>
    showRoutedRawModal(interaction, buildSpotlightSetModal(locale, nonce, channelId, hours, blockIdx, fp, personas)),
  showSpotlightAutoTriggerModal: (interaction, locale, nonce, channelId, hours, blockIdx, mask, fp, selectedPersonas) =>
    showRoutedRawModal(
      interaction,
      buildSpotlightAutoTriggerModal(locale, nonce, channelId, hours, blockIdx, mask, fp, selectedPersonas),
    ),
  showSpotlightRemoveModal: (interaction, locale, nonce, start, fp, activeSpotlights, personas, guildChannels) =>
    showRoutedRawModal(
      interaction,
      buildSpotlightRemoveModal(locale, nonce, start, fp, activeSpotlights, personas, guildChannels),
    ),
};

export function createPersonalConfigInteractionRoute(
  overrides: Partial<PersonalConfigRouteDependencies> = {},
): GlobalInteractionRoute {
  const dependencies: PersonalConfigRouteDependencies = {
    ...defaultDependencies,
    ...overrides,
  };

  return {
    namespace: PERSONAL_CONFIG_ROUTE_NAMESPACE,
    version: PERSONAL_CONFIG_ROUTE_VERSION,
    async execute(_client, interaction, parsed): Promise<void> {
      const route = parsePersonalConfigPanelRoute(parsed);
      if (!route) throw new Error(`Malformed personal config panel route: ${interaction.customId}`);

      const handled = await handlePersonalConfigModalOpen({
        interaction,
        route,
        dependencies,
      });
      if (handled === "handled") return;

      const initialScope = await beginPanelInteraction({
        acknowledge: () => interaction.deferUpdate(),
        authorize: () => true,
        onDenied: () => Promise.resolve(),
        load: () => dependencies.resolveScope(interaction, route.action === "retry" || route.action === "refresh"),
        onMissing: () => interaction.editReply(terminalPayload(route.locale, "commands.personal.config.unavailable")),
      });
      if (!initialScope) return;
      let scope = initialScope;

      const postDeferContext: PersonalConfigPostDeferContext = {
        interaction,
        route,
        dependencies,
        get scope() {
          return scope;
        },
        set scope(next) {
          scope = next;
        },
      };

      if (await handlePersonalConfigNavigation(postDeferContext)) {
        return;
      }

      if (await handlePersonalConfigProfileWrites(postDeferContext)) {
        return;
      }

      if (await handlePersonalConfigModelRoutes(postDeferContext)) {
        return;
      }

      if (await handlePersonalConfigResponseRoutes(postDeferContext)) {
        return;
      }

      if (route.action === "spotlight-set-step1" || route.action === "spotlight-set-block-page") {
        if (!scope.guildId || !scope.internalServerId) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.spotlight_guild_only_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
            },
            dependencies,
          });
          return;
        }

        const personas = await dependencies.loadGuildPersonas(scope.guildId);
        const fp = computeSpotlightSetFingerprint(scope.guildId, scope.userDiscId, personas);

        let channelId: string;
        let hours: number;
        let chooserPage = 0;

        if (route.action === "spotlight-set-block-page") {
          if (fp !== route.fp) {
            await repaint(interaction, {
              locale: route.locale,
              scope,
              category: "advanced",
              page: "spotlight",
              panelReceipt: {
                tone: "error",
                heading: localizer(route.locale, "commands.personal.config.unavailable"),
                detail: localizer(route.locale, "commands.personal.config.stale_warning"),
              },
              dependencies,
            });
            return;
          }
          channelId = route.channelId;
          hours = route.hours;
          chooserPage = route.chooserPage;
        } else {
          const modal = interaction as ModalSubmitInteraction;
          const rawChannelId = takeRawModalSelectValue(
            modal.id,
            buildPersonalConfigModalFieldId("channel", route.nonce),
          );
          if (!rawChannelId || !/^\d{17,20}$/.test(rawChannelId)) {
            await repaint(interaction, {
              locale: route.locale,
              scope,
              category: "advanced",
              page: "spotlight",
              panelReceipt: {
                tone: "error",
                heading: localizer(route.locale, "commands.personal.config.spotlight_invalid_channel_heading"),
                detail: localizer(route.locale, "commands.personal.config.spotlight_invalid_channel_detail"),
              },
              dependencies,
            });
            return;
          }
          const rawHours = modal.fields.getTextInputValue(buildPersonalConfigModalFieldId("hours", route.nonce)).trim();
          const parsedHours = Number.parseInt(rawHours, 10);
          if (Number.isNaN(parsedHours) || parsedHours < 0 || !/^\d+$/.test(rawHours)) {
            await repaint(interaction, {
              locale: route.locale,
              scope,
              category: "advanced",
              page: "spotlight",
              panelReceipt: {
                tone: "error",
                heading: localizer(route.locale, "commands.personal.config.spotlight_invalid_hours_heading"),
                detail: localizer(route.locale, "commands.personal.config.spotlight_invalid_hours_detail"),
              },
              dependencies,
            });
            return;
          }
          channelId = rawChannelId;
          hours = parsedHours;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "spotlight",
          dependencies,
          view: {
            kind: "spotlight-persona-select",
            channelId,
            hours,
            fp,
            totalPersonas: personas.length,
            chooserPage,
          },
        });
        return;
      }

      if (route.action === "spotlight-set-submit") {
        if (!interaction.isModalSubmit()) throw new Error("spotlight-set-submit requires ModalSubmit interaction");
        const modal = interaction as ModalSubmitInteraction;
        if (!scope.guildId || !scope.internalServerId) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.spotlight_guild_only_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
            },
            dependencies,
          });
          return;
        }
        if (scope.readStatus !== "fresh") {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }

        const personas = await dependencies.loadGuildPersonas(scope.guildId);
        const expectedFp = computeSpotlightSetFingerprint(scope.guildId, scope.userDiscId, personas);
        const blockStart = route.blockIdx * SPOTLIGHT_PERSONA_PAGE_SIZE;
        const block = personas.slice(blockStart, blockStart + SPOTLIGHT_PERSONA_PAGE_SIZE);
        if (expectedFp !== route.fp || block.length === 0) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }

        let bitmask = 0n;
        const selectedPersonaIds: number[] = [];
        for (let g = 0; g < SPOTLIGHT_PERSONA_PAGE_SIZE / 10; g++) {
          const groupValues = takeRawModalCheckboxGroupValues(
            modal.id,
            buildPersonalConfigModalFieldId(`personas_${g}`, route.nonce),
          );
          if (!groupValues) continue;
          for (const val of groupValues) {
            const pid = Number.parseInt(val, 10);
            const indexInBlock = block.findIndex((p) => p.id === pid);
            if (indexInBlock >= 0) {
              bitmask |= 1n << BigInt(indexInBlock);
              selectedPersonaIds.push(pid);
            }
          }
        }

        if (selectedPersonaIds.length === 0) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.spotlight_no_selection_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_no_selection_detail"),
            },
            dependencies,
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "spotlight",
          dependencies,
          view: {
            kind: "spotlight-set-review",
            channelId: route.channelId,
            hours: route.hours,
            blockIdx: route.blockIdx,
            selectedPersonaIds,
            autoTriggerPersonaId: null,
            autoIdx: 0,
            mask: encodeSpotlightMask(bitmask),
            fp: route.fp,
            nonce: dependencies.createNonce(),
          },
        });
        return;
      }

      if (route.action === "spot-set-auto-sub") {
        if (!interaction.isModalSubmit()) throw new Error("spot-set-auto-sub requires ModalSubmit interaction");
        const modal = interaction as ModalSubmitInteraction;
        if (!scope.guildId || !scope.internalServerId) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.spotlight_guild_only_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
            },
            dependencies,
          });
          return;
        }
        const personas = await dependencies.loadGuildPersonas(scope.guildId);
        const expectedFp = computeSpotlightSetFingerprint(scope.guildId, scope.userDiscId, personas);
        if (expectedFp !== route.fp) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }
        const resolvedSub = resolveSpotlightBlockSelection(personas, route.blockIdx, route.mask);
        if (!resolvedSub) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }
        const selectedPersonaIds = resolvedSub.selected.map((p) => p.id);

        const autoFieldId = buildPersonalConfigModalFieldId("auto_trigger", route.nonce);
        const rawAutoId = takeRawModalSelectValue(modal.id, autoFieldId) ?? "0";
        const autoTriggerId = Number.parseInt(rawAutoId, 10);
        const validAutoId =
          !Number.isNaN(autoTriggerId) && autoTriggerId > 0 && selectedPersonaIds.includes(autoTriggerId)
            ? autoTriggerId
            : null;
        const validAutoIdx = validAutoId === null ? 0 : resolvedSub.block.findIndex((p) => p.id === validAutoId) + 1;

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "spotlight",
          dependencies,
          view: {
            kind: "spotlight-set-review",
            channelId: route.channelId,
            hours: route.hours,
            blockIdx: route.blockIdx,
            selectedPersonaIds,
            autoTriggerPersonaId: validAutoId,
            autoIdx: validAutoIdx,
            mask: route.mask,
            fp: route.fp,
            nonce: dependencies.createNonce(),
          },
        });
        return;
      }

      if (route.action === "spot-set-cf") {
        const serverId = scope.internalServerId;
        if (!scope.guildId || serverId === null) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.spotlight_guild_only_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
            },
            dependencies,
          });
          return;
        }
        if (scope.readStatus !== "fresh") {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }
        // The channel arrives from the custom ID, so the select menu that produced it is not a guard.
        // A spotlight belongs to one guild text channel, and the write is keyed on the raw snowflake.
        const confirmChannel = interaction.guild?.channels.cache.get(route.channelId);
        if (!confirmChannel || confirmChannel.type !== ChannelType.GuildText) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.spotlight_invalid_channel_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_invalid_channel_detail"),
            },
            dependencies,
          });
          return;
        }

        const personas = await dependencies.loadGuildPersonas(scope.guildId);
        const expectedFp = computeSpotlightSetFingerprint(scope.guildId, scope.userDiscId, personas);
        if (expectedFp !== route.fp) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }
        const resolvedConfirm = resolveSpotlightBlockSelection(personas, route.blockIdx, route.mask);
        if (!resolvedConfirm) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }
        const selectedPersonaIds = resolvedConfirm.selected.map((p) => p.id);
        if (selectedPersonaIds.length === 0) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.spotlight_no_selection_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_no_selection_detail"),
            },
            dependencies,
          });
          return;
        }

        // The auto-trigger travels as a position inside the presented block rather than a persona ID,
        // because 50 explicit IDs do not fit beside a snowflake and a fingerprint in 100 characters.
        const autoPersona = route.autoIdx > 0 ? (resolvedConfirm.block[route.autoIdx - 1] ?? null) : null;

        // Silently writing null here would contradict the review page the user just confirmed, so a
        // chosen auto-trigger that no longer resolves is surfaced instead of dropped.
        if (route.autoIdx > 0 && (autoPersona === null || !selectedPersonaIds.includes(autoPersona.id))) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.spotlight_auto_stale_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_auto_stale_detail"),
            },
            dependencies,
          });
          return;
        }
        const autoTriggerPersonaId = autoPersona?.id ?? null;
        const expiresAt = route.hours === 0 ? null : new Date(Date.now() + route.hours * 60 * 60 * 1000);

        const action = await performPanelAction(
          () =>
            dependencies.operations.setSpotlight({
              serverId,
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              channelId: route.channelId,
              personaIds: selectedPersonaIds,
              autoTriggerPersonaId,
              expiresAt,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "no-changes") {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "info",
              heading: localizer(route.locale, "commands.personal.config.no_changes_heading"),
              detail: localizer(route.locale, "commands.personal.config.no_changes_detail"),
            },
            dependencies,
          });
          return;
        }

        if (result.status === "success") {
          dependencies.recordAction({
            action: "personal-config.personal.spotlight.set",
            serverId,
            userDiscId: interaction.user.id,
          });
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.spotlight_saved_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_saved_detail", {
                channel: route.channelId,
              }),
            },
            dependencies,
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "spotlight",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
        return;
      }

      if (route.action === "spotlight-set-cancel") {
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "spotlight",
          dependencies,
        });
        return;
      }

      if (route.action === "spotlight-remove-open") {
        if (!scope.guildId || !scope.internalServerId) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.spotlight_guild_only_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
            },
            dependencies,
          });
          return;
        }
        const activeSpotlights = await dependencies.loadActiveSpotlights(scope.internalServerId, scope.userId);
        if (activeSpotlights.length > SPOTLIGHT_REMOVE_PAGE_SIZE) {
          const fp = computeSpotlightRemoveFingerprint(scope.guildId, scope.userDiscId, activeSpotlights);
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            dependencies,
            view: {
              kind: "spotlight-remove-range",
              rangePage: 0,
              totalOptions: activeSpotlights.length,
              fp,
            },
          });
          return;
        }
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "spotlight",
          dependencies,
        });
        return;
      }

      if (route.action === "spotlight-remove-page") {
        const serverId = scope.internalServerId;
        if (!scope.guildId || serverId === null) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.spotlight_guild_only_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
            },
            dependencies,
          });
          return;
        }
        const activeSpotlights = await dependencies.loadActiveSpotlights(serverId, scope.userId);
        const expectedFp = computeSpotlightRemoveFingerprint(scope.guildId, scope.userDiscId, activeSpotlights);
        if (expectedFp !== route.fp) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "spotlight",
          dependencies,
          view: {
            kind: "spotlight-remove-range",
            rangePage: route.chooserPage,
            totalOptions: activeSpotlights.length,
            fp: route.fp,
          },
        });
        return;
      }

      if (route.action === "spotlight-remove-cancel") {
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "spotlight",
          dependencies,
        });
        return;
      }

      if (route.action === "spot-set-auto-page") {
        const serverId = scope.internalServerId;
        if (!scope.guildId || serverId === null) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.spotlight_guild_only_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
            },
            dependencies,
          });
          return;
        }
        const personas = await dependencies.loadGuildPersonas(scope.guildId);
        const expectedFp = computeSpotlightSetFingerprint(scope.guildId, scope.userDiscId, personas);
        if (expectedFp !== route.fp) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }
        const bitmask = BigInt(`0x${route.mask}`);
        const selectedPersonas = personas.filter((_, i) => (bitmask & (1n << BigInt(i))) !== 0n);
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "spotlight",
          dependencies,
          view: {
            kind: "spotlight-auto-range",
            channelId: route.channelId,
            hours: route.hours,
            blockIdx: route.blockIdx,
            mask: route.mask,
            fp: route.fp,
            rangePage: route.chooserPage,
            totalOptions: selectedPersonas.length,
          },
        });
        return;
      }

      if (route.action === "spot-set-auto-cancel") {
        const serverId = scope.internalServerId;
        if (!scope.guildId || serverId === null) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.spotlight_guild_only_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
            },
            dependencies,
          });
          return;
        }
        const personas = await dependencies.loadGuildPersonas(scope.guildId);
        const expectedFp = computeSpotlightSetFingerprint(scope.guildId, scope.userDiscId, personas);
        if (expectedFp !== route.fp) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }
        const resolvedCancel = resolveSpotlightBlockSelection(personas, route.blockIdx, route.mask);
        if (!resolvedCancel) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }
        const selectedPersonaIds = resolvedCancel.selected.map((p) => p.id);
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "spotlight",
          dependencies,
          view: {
            kind: "spotlight-set-review",
            channelId: route.channelId,
            hours: route.hours,
            blockIdx: route.blockIdx,
            selectedPersonaIds,
            autoTriggerPersonaId: null,
            autoIdx: 0,
            mask: route.mask,
            fp: route.fp,
            nonce: dependencies.createNonce(),
          },
        });
        return;
      }

      if (route.action === "spotlight-remove-submit") {
        if (!interaction.isModalSubmit()) throw new Error("spotlight-remove-submit requires ModalSubmit interaction");
        const modal = interaction as ModalSubmitInteraction;
        const serverId = scope.internalServerId;
        if (!scope.guildId || serverId === null) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.spotlight_guild_only_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
            },
            dependencies,
          });
          return;
        }
        if (scope.readStatus !== "fresh") {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }

        const activeSpotlights = await dependencies.loadActiveSpotlights(serverId, scope.userId);
        const expectedFp = computeSpotlightRemoveFingerprint(scope.guildId, scope.userDiscId, activeSpotlights);
        if (expectedFp !== route.fp) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }
        const presentedSlice = activeSpotlights.slice(route.start, route.start + SPOTLIGHT_REMOVE_PAGE_SIZE);
        const keptChannelIds = new Set<string>();
        const presentedChannelIds: string[] = [];

        for (let g = 0; g < 5 && g * 10 < presentedSlice.length; g++) {
          const chunk = presentedSlice.slice(g * 10, (g + 1) * 10);
          for (const entry of chunk) {
            presentedChannelIds.push(entry.channelDiscId);
          }
          const groupValues = takeRawModalCheckboxGroupValues(
            modal.id,
            buildPersonalConfigModalFieldId(`spotlights_${g}`, route.nonce),
          );
          if (groupValues) {
            for (const val of groupValues) {
              keptChannelIds.add(val);
            }
          }
        }

        const removedChannelIds = presentedChannelIds.filter((chId) => !keptChannelIds.has(chId));
        if (removedChannelIds.length === 0) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: noChangesReceipt(route.locale),
            dependencies,
          });
          return;
        }

        const action = await performPanelAction(
          () =>
            dependencies.operations.removeSpotlights({
              serverId,
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              channelIds: removedChannelIds,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "success") {
          dependencies.recordAction({
            action: "personal-config.personal.spotlight.remove",
            serverId,
            userDiscId: interaction.user.id,
          });
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.spotlight_removed_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_removed_detail", {
                removed_count: result.removedCount,
              }),
            },
            dependencies,
          });
          return;
        }

        if (result.status === "partial-failure") {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "spotlight",
            panelReceipt: {
              tone: "warning",
              heading: localizer(route.locale, "commands.personal.config.spotlight_partial_removal_heading"),
              detail: localizer(route.locale, "commands.personal.config.spotlight_partial_removal_detail", {
                removed_count: result.removedCount,
                failed_count: result.failedCount,
              }),
            },
            dependencies,
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "spotlight",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
        return;
      }
    },
  };
}

export const personalConfigInteractionRoute = createPersonalConfigInteractionRoute();

export type PersonalConfigPanelPayloadOrTerminal =
  | ReturnType<typeof buildPersonalConfigPanelPayload>
  | InteractionEditReplyOptions;

export async function buildInitialPersonalConfigPanel(
  interaction: ChatInputCommandInteraction,
  locale: string,
  dependenciesOverride?: Partial<PersonalConfigRouteDependencies>,
): Promise<PersonalConfigPanelPayloadOrTerminal> {
  const dependencies: PersonalConfigRouteDependencies = {
    ...defaultDependencies,
    ...dependenciesOverride,
  };
  const scope = await dependencies.resolveScope(interaction);
  if (!scope) {
    return terminalPayload(locale, "commands.personal.config.unavailable") as PersonalConfigPanelPayloadOrTerminal;
  }
  return buildPersonalConfigPanelPayload({
    locale,
    category: "profile",
    page: "general",
    user: scope.user,
    resolvedNickname: scope.resolvedNickname,
    personas: scope.personas,
    guildId: scope.guildId,
    // Only the privacy page renders these, and the panel always opens on profile, so the counts are
    // never read here. Changing the opening category means fetching them, as `repaint` does.
    memoryCount: 0,
    stmCount: 0,
    readStatus: scope.readStatus,
  });
}
