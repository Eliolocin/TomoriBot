import {
  ChannelType,
  type ChatInputCommandInteraction,
  type InteractionEditReplyOptions,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { PrivacyLevel, type PersonalProviderCapability, type TomoriState } from "@/types/db/schema";
import { getCachedAllPersonas, getCachedTomoriState } from "@/utils/cache/tomoriStateCache";
import { userRepository } from "@/utils/db/repositories";
import type { GlobalInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import { beginPanelInteraction, performPanelAction } from "@/utils/discord/interactions/panelController";
import {
  getMemoryCount,
  getStmCount,
  loadAvailableModelsForCapability,
  loadFallbackSelectionOptions,
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
  PERSONAL_PROVIDER_PAGE_SIZE,
  QUICK_TOGGLE_CAPABILITIES,
  ROUTING_CAPABILITY_LOCALE_KEYS,
  SPOTLIGHT_PERSONA_PAGE_SIZE,
  SPOTLIGHT_REMOVE_PAGE_SIZE,
  computeSpotlightRemoveFingerprint,
  computeSpotlightSetFingerprint,
  encodeSpotlightMask,
  decodeProviderParam,
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
import { MAX_TAG_LENGTH, MAX_TAGS } from "@/utils/image/tagHelpers";
import { log } from "@/utils/misc/logger";
import { recordPanelActionStat } from "@/utils/stats/panelActionMetrics";
import { formatUTCOffset } from "@/utils/text/timezoneHelper";
import { localizer } from "@/utils/text/localizer";
import {
  getActivePersonalProviderForCapability,
  getStoredPersonalProviderForCapability,
  hasConfiguredPersonalModel,
} from "@/utils/provider/personalProviderHelpers";
import type { ThinkingLevelValue } from "@/constants/thinkingLevels";
import type { ModelParameterOptions } from "@/utils/discord/modelParametersConfigMapping";
import { getProviderDisplayName } from "@/utils/provider/providerInfoRegistry";
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

      if (route.action === "language-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const fieldId = buildPersonalConfigModalFieldId("language", route.nonce);
        const language = takeRawModalSelectValue(modal.id, fieldId) || "en-US";

        const action = await performPanelAction(
          () =>
            dependencies.operations.setLanguage({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              language,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.language.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          const langLabel =
            language === "ja"
              ? localizer(route.locale, "commands.personal.config.language_ja")
              : localizer(route.locale, "commands.personal.config.language_en");
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "profile",
            page: "general",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.language_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.language_updated_detail", {
                language: langLabel,
              }),
            },
            dependencies,
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "profile",
          page: "general",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
        return;
      }

      if (route.action === "timezone-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const fieldId = buildPersonalConfigModalFieldId("timezone", route.nonce);
        const rawOffset = modal.fields.getTextInputValue(fieldId).trim();
        const parsedOffset = Number(rawOffset);

        if (Number.isNaN(parsedOffset) || parsedOffset < -12 || parsedOffset > 14) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "profile",
            page: "general",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.invalid_timezone_heading"),
              detail: localizer(route.locale, "commands.personal.config.invalid_timezone_detail"),
            },
            dependencies,
          });
          return;
        }

        const action = await performPanelAction(
          () =>
            dependencies.operations.setTimezone({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              offset: parsedOffset,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.timezone.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "profile",
            page: "general",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.timezone_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.timezone_updated_detail", {
                timezone: formatUTCOffset(parsedOffset),
              }),
            },
            dependencies,
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "profile",
          page: "general",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
        return;
      }

      if (route.action === "timezone-server") {
        const action = await performPanelAction(
          () =>
            dependencies.operations.setTimezone({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              offset: null,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.timezone.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "profile",
            page: "general",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.timezone_cleared_heading"),
              detail: localizer(route.locale, "commands.personal.config.timezone_cleared_detail"),
            },
            dependencies,
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "profile",
          page: "general",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
        return;
      }

      if (route.action === "naming-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const nicknameRaw = modal.fields
          .getTextInputValue(buildPersonalConfigModalFieldId("nickname", route.nonce))
          .trim();
        const prefixRaw = modal.fields.getTextInputValue(buildPersonalConfigModalFieldId("prefix", route.nonce)).trim();
        const suffixRaw = modal.fields.getTextInputValue(buildPersonalConfigModalFieldId("suffix", route.nonce)).trim();

        const nickname = nicknameRaw || null;
        const prefix = prefixRaw || null;
        const suffix = suffixRaw || null;

        const action = await performPanelAction(
          () =>
            dependencies.operations.setNaming({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              nickname,
              prefix,
              suffix,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.naming.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "profile",
            page: "general",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.naming_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.naming_updated_detail"),
            },
            dependencies,
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "profile",
          page: "general",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
        return;
      }

      if (route.action === "persona-naming-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const nicknameRaw = modal.fields
          .getTextInputValue(buildPersonalConfigModalFieldId("nickname", route.nonce))
          .trim();
        const prefixRaw = modal.fields.getTextInputValue(buildPersonalConfigModalFieldId("prefix", route.nonce)).trim();
        const suffixRaw = modal.fields.getTextInputValue(buildPersonalConfigModalFieldId("suffix", route.nonce)).trim();

        const nickname = nicknameRaw || null;
        const prefix = prefixRaw || null;
        const suffix = suffixRaw || null;

        const action = await performPanelAction(
          () =>
            dependencies.operations.setPersonaNaming({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              personaLineageId: route.lineageId,
              nickname,
              prefix,
              suffix,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.naming.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "profile",
            page: "persona",
            selectedLineageId: route.lineageId,
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.naming_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.naming_updated_detail"),
            },
            dependencies,
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "profile",
          page: "persona",
          selectedLineageId: route.lineageId,
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
        return;
      }

      if (route.action === "about-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const genderRaw = modal.fields
          .getTextInputValue(buildPersonalConfigModalFieldId("gender_identity", route.nonce))
          .trim();
        const pronounsRaw = modal.fields
          .getTextInputValue(buildPersonalConfigModalFieldId("pronouns", route.nonce))
          .trim();
        const rawStyle = takeRawModalSelectValue(
          modal.id,
          buildPersonalConfigModalFieldId("addressing_style", route.nonce),
        );

        const genderIdentity = genderRaw || null;
        const pronouns = pronounsRaw || null;

        const resolvedStyle =
          rawStyle === "neutral"
            ? scope.user.addressing_style === "neutral"
              ? "neutral"
              : null
            : rawStyle === "masculine" || rawStyle === "feminine"
              ? rawStyle
              : null;

        const action = await performPanelAction(
          () =>
            dependencies.operations.setAbout({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              genderIdentity,
              pronouns,
              addressingStyle: resolvedStyle,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.about.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "profile",
            page: "general",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.about_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.about_updated_detail"),
            },
            dependencies,
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "profile",
          page: "general",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
        return;
      }

      if (route.action === "appearance-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const tagsInput = modal.fields.getTextInputValue(buildPersonalConfigModalFieldId("tags", route.nonce));

        const action = await performPanelAction(
          () =>
            dependencies.operations.setAppearance({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              rawTags: tagsInput,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.appearance.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          const isCleared = result.tags.length === 0;
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "profile",
            page: "appearance",
            panelReceipt: {
              tone: "success",
              heading: localizer(
                route.locale,
                isCleared
                  ? "commands.personal.config.appearance_cleared_heading"
                  : "commands.personal.config.appearance_updated_heading",
              ),
              detail: localizer(
                route.locale,
                isCleared
                  ? "commands.personal.config.appearance_cleared_detail"
                  : "commands.personal.config.appearance_updated_detail",
              ),
            },
            dependencies,
          });
          return;
        }

        const tone: "error" = "error";
        let headingKey = "commands.personal.config.write_failed_heading";
        let detailKey = "commands.personal.config.write_failed_detail";
        let vars: Record<string, string | number> | undefined;

        if (result.status === "too-many-tags") {
          headingKey = "commands.personal.config.too_many_tags_heading";
          detailKey = "commands.personal.config.too_many_tags_detail";
          vars = { max: MAX_TAGS };
        } else if (result.status === "tag-too-long") {
          headingKey = "commands.personal.config.tag_too_long_heading";
          detailKey = "commands.personal.config.tag_too_long_detail";
          vars = { max: MAX_TAG_LENGTH };
        } else if (result.status === "invalid-tags") {
          headingKey = "commands.personal.config.invalid_tags_heading";
          detailKey = "commands.personal.config.invalid_tags_detail";
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "profile",
          page: "appearance",
          panelReceipt: {
            tone,
            heading: localizer(route.locale, headingKey),
            detail: localizer(route.locale, detailKey, vars),
          },
          dependencies,
        });
        return;
      }

      if (route.action === "privacy-level-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const fieldId = buildPersonalConfigModalFieldId("privacy_level", route.nonce);
        const selectedValue = takeRawModalSelectValue(modal.id, fieldId) ?? "";
        const requestedLevel = Number.parseInt(selectedValue, 10) as PrivacyLevel;

        const action = await performPanelAction(
          () =>
            dependencies.operations.setPrivacyLevel({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              level: requestedLevel,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.privacy.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          const levelName =
            requestedLevel === PrivacyLevel.FULL
              ? localizer(route.locale, "commands.personal.config.privacy_level_full")
              : requestedLevel === PrivacyLevel.PARTIAL
                ? localizer(route.locale, "commands.personal.config.privacy_level_partial")
                : localizer(route.locale, "commands.personal.config.privacy_level_minimal");

          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "privacy",
            page: "controls",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.privacy_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.privacy_updated_detail", {
                level: levelName,
              }),
            },
            dependencies,
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "privacy",
          page: "controls",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
        return;
      }

      if (route.action === "crossserver-toggle") {
        const action = await performPanelAction(
          () =>
            dependencies.operations.toggleCrossServerStm({
              userDiscId: scope.userDiscId,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.crossserver-stm.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          const isEnabled = result.enabled;
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "privacy",
            page: "controls",
            panelReceipt: {
              tone: "success",
              heading: localizer(
                route.locale,
                isEnabled
                  ? "commands.personal.config.crossserver_enabled_heading"
                  : "commands.personal.config.crossserver_disabled_heading",
              ),
              detail: localizer(
                route.locale,
                isEnabled
                  ? "commands.personal.config.crossserver_enabled_detail"
                  : "commands.personal.config.crossserver_disabled_detail",
              ),
            },
            dependencies,
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "privacy",
          page: "controls",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
        return;
      }

      if (route.action === "parameters-provider-select") {
        const selectMenu = interaction as StringSelectMenuInteraction;
        const chosenProvider = decodeProviderParam(selectMenu.values[0]);
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "models",
          page: "parameters",
          dependencies,
          selectedParametersProvider: chosenProvider,
        });
        return;
      }

      if (route.action === "quick-toggle-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const fieldId = buildPersonalConfigModalFieldId("capabilities", route.nonce);
        const selectedCaps = (takeRawModalCheckboxGroupValues(modal.id, fieldId) ?? []) as PersonalProviderCapability[];
        const selectedCapSet = new Set<PersonalProviderCapability>(selectedCaps);

        const rows = await dependencies.loadUserSavedProviders(scope.userId);
        for (const cap of selectedCapSet) {
          const target = getStoredPersonalProviderForCapability(rows, cap);
          if (!target || !hasConfiguredPersonalModel(target, cap)) {
            const capLabel = localizer(route.locale, ROUTING_CAPABILITY_LOCALE_KEYS[cap]);
            await repaint(interaction, {
              locale: route.locale,
              scope,
              category: "models",
              page: "switch",
              panelReceipt: {
                tone: "error",
                heading: localizer(route.locale, "commands.personal.config.missing_model_heading"),
                detail: localizer(route.locale, "commands.personal.config.missing_model_detail", {
                  capability: capLabel,
                }),
              },
              dependencies,
            });
            return;
          }
        }

        const hasChange = QUICK_TOGGLE_CAPABILITIES.some(
          (cap) => (getActivePersonalProviderForCapability(rows, cap) !== null) !== selectedCapSet.has(cap),
        );
        if (!hasChange) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "models",
            page: "switch",
            panelReceipt: {
              tone: "info",
              heading: localizer(route.locale, "commands.personal.config.no_changes_heading"),
              detail: localizer(route.locale, "commands.personal.config.no_changes_detail"),
            },
            dependencies,
          });
          return;
        }

        const action = await performPanelAction(
          () =>
            dependencies.operations.setQuickToggleRouting({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              selectedCapabilities: selectedCapSet,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "no-changes") {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "models",
            page: "switch",
            panelReceipt: noChangesReceipt(route.locale),
            dependencies,
          });
          return;
        }

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.model-routing.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "models",
            page: "switch",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.routing_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.routing_updated_detail"),
            },
            dependencies,
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "models",
          page: "switch",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
        return;
      }

      // Now only backs the model, provider, and fallback range choosers: the activation confirmation
      // it was named for is gone, so the receipt reports the state, not a cancelled activation.
      if (route.action === "model-act-cancel") {
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "models",
          page: "switch",
          panelReceipt: noChangesReceipt(route.locale),
          dependencies,
        });
        return;
      }

      if (route.action === "model-provider-select") {
        const action = await performPanelAction(
          () =>
            dependencies.operations.setCapabilityEnabled({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              capability: route.capability,
              enabled: false,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "no-changes") {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "models",
            page: "switch",
            panelReceipt: noChangesReceipt(route.locale),
            dependencies,
            selectedCapability: route.capability,
          });
          return;
        }

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.model.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          const capLabel = localizer(route.locale, ROUTING_CAPABILITY_LOCALE_KEYS[route.capability]);
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "models",
            page: "switch",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.model_default_heading"),
              detail: localizer(route.locale, "commands.personal.config.model_default_detail", {
                capability: capLabel,
              }),
            },
            dependencies,
            selectedCapability: route.capability,
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "models",
          page: "switch",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
          selectedCapability: route.capability,
        });
        return;
      }

      if (route.action === "model-modal-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const fieldId = buildPersonalConfigModalFieldId("model", route.nonce);
        const rawModelId = takeRawModalSelectValue(modal.id, fieldId);
        const modelId = Number(rawModelId);

        const availableModels = await dependencies.loadAvailableModelsForCapability(
          scope.userId,
          route.provider,
          route.capability,
        );
        const validModel = availableModels.find((m) => m.id === modelId);

        if (!validModel || modelId === 0) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "models",
            page: "switch",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
              detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
            },
            dependencies,
            selectedCapability: route.capability,
          });
          return;
        }

        const action = await performPanelAction(
          () =>
            dependencies.operations.setCapabilityModel({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              capability: route.capability,
              provider: route.provider,
              modelId,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "no-changes") {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "models",
            page: "switch",
            panelReceipt: noChangesReceipt(route.locale),
            dependencies,
            selectedCapability: route.capability,
          });
          return;
        }

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.model.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          const capLabel = localizer(route.locale, ROUTING_CAPABILITY_LOCALE_KEYS[route.capability]);
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "models",
            page: "switch",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.model_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.model_updated_detail", {
                capability: capLabel,
                provider: getProviderDisplayName(route.provider),
                model: validModel.name,
              }),
            },
            dependencies,
            selectedCapability: route.capability,
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "models",
          page: "switch",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
          selectedCapability: route.capability,
        });
        return;
      }

      if (route.action === "model-range-page") {
        const availableModels = await dependencies.loadAvailableModelsForCapability(
          scope.userId,
          route.provider,
          route.capability,
        );
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "models",
          page: "switch",
          dependencies,
          selectedCapability: route.capability,
          view: {
            kind: "model-range",
            capability: route.capability,
            provider: route.provider,
            rangePage: route.chooserPage,
            totalOptions: availableModels.length,
          },
        });
        return;
      }

      if (route.action === "model-provider-range-open" || route.action === "model-provider-range-page") {
        const rows = await dependencies.loadUserSavedProviders(scope.userId);
        const displayInfo = await dependencies.loadPersonalModelDisplayInfo(scope.userId, rows, route.capability);
        const providers = displayInfo.eligibleProvidersForCapability[route.capability];

        if (route.action === "model-provider-range-open") {
          if (route.start % PERSONAL_PROVIDER_PAGE_SIZE !== 0 || route.start >= providers.length) {
            await repaint(interaction, {
              locale: route.locale,
              scope,
              category: "models",
              page: "switch",
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
            category: "models",
            page: "switch",
            dependencies,
            selectedCapability: route.capability,
            view: { kind: "model-provider-page", capability: route.capability, start: route.start },
          });
          return;
        }

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "models",
          page: "switch",
          dependencies,
          selectedCapability: route.capability,
          view: {
            kind: "model-provider-range",
            capability: route.capability,
            rangePage: route.chooserPage,
            totalOptions: providers.length,
          },
        });
        return;
      }

      if (route.action === "fallbacks-range-page") {
        let availableOptions: Array<{ refKey: string; label: string }> = [];
        try {
          availableOptions = await loadFallbackSelectionOptions(scope.userId, route.provider);
        } catch (error) {
          log.warn("Failed to load available models for fallbacks modal", { provider: route.provider, error });
        }
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "models",
          page: "fallbacks",
          dependencies,
          selectedFallbacksProvider: route.provider,
          view: {
            kind: "fallbacks-range",
            provider: route.provider,
            rangePage: route.chooserPage,
            totalOptions: availableOptions.length,
          },
        });
        return;
      }

      if (route.action === "parameters-1-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const tempRaw = modal.fields
          .getTextInputValue(buildPersonalConfigModalFieldId("temperature", route.nonce))
          .trim();
        const minPRaw = modal.fields.getTextInputValue(buildPersonalConfigModalFieldId("min_p", route.nonce)).trim();
        const topPRaw = modal.fields.getTextInputValue(buildPersonalConfigModalFieldId("top_p", route.nonce)).trim();
        const topKRaw = modal.fields.getTextInputValue(buildPersonalConfigModalFieldId("top_k", route.nonce)).trim();
        const freqRaw = modal.fields
          .getTextInputValue(buildPersonalConfigModalFieldId("frequency_penalty", route.nonce))
          .trim();

        const patch: Partial<ModelParameterOptions> = {
          temperature: tempRaw ? Number(tempRaw) : null,
          min_p: minPRaw ? Number(minPRaw) : null,
          top_p: topPRaw ? Number(topPRaw) : null,
          top_k: topKRaw ? Number(topKRaw) : null,
          frequency_penalty: freqRaw ? Number(freqRaw) : null,
        };

        const action = await performPanelAction(
          () =>
            dependencies.operations.setParameters({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              provider: route.provider,
              patch,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.parameters.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "models",
            page: "parameters",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.parameters_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.parameters_updated_detail", {
                provider: getProviderDisplayName(route.provider),
              }),
            },
            dependencies,
            selectedParametersProvider: route.provider,
          });
          return;
        }

        const isInvalid = result.status === "invalid-value";
        const isNoChanges = result.status === "no-changes";

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "models",
          page: "parameters",
          panelReceipt: {
            tone: isNoChanges ? "info" : "error",
            heading: localizer(
              route.locale,
              isInvalid
                ? "commands.personal.config.invalid_parameters_heading"
                : isNoChanges
                  ? "commands.personal.config.no_changes_heading"
                  : "commands.personal.config.write_failed_heading",
            ),
            detail: localizer(
              route.locale,
              isInvalid
                ? "commands.personal.config.invalid_parameters_detail"
                : isNoChanges
                  ? "commands.personal.config.no_changes_detail"
                  : "commands.personal.config.write_failed_detail",
            ),
          },
          dependencies,
          selectedParametersProvider: route.provider,
        });
        return;
      }

      if (route.action === "parameters-2-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const presRaw = modal.fields
          .getTextInputValue(buildPersonalConfigModalFieldId("presence_penalty", route.nonce))
          .trim();
        const maxTokRaw = modal.fields
          .getTextInputValue(buildPersonalConfigModalFieldId("max_output_tokens", route.nonce))
          .trim();
        const thinkRaw = takeRawModalSelectValue(
          modal.id,
          buildPersonalConfigModalFieldId("thinking_level", route.nonce),
        );

        const patch: Partial<ModelParameterOptions> = {
          presence_penalty: presRaw ? Number(presRaw) : null,
          max_output_tokens: maxTokRaw ? Number(maxTokRaw) : null,
          thinking_level: (thinkRaw as ThinkingLevelValue) ?? null,
        };

        const action = await performPanelAction(
          () =>
            dependencies.operations.setParameters({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              provider: route.provider,
              patch,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.parameters.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "models",
            page: "parameters",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.parameters_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.parameters_updated_detail", {
                provider: getProviderDisplayName(route.provider),
              }),
            },
            dependencies,
            selectedParametersProvider: route.provider,
          });
          return;
        }

        const isInvalid = result.status === "invalid-value";
        const isNoChanges = result.status === "no-changes";

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "models",
          page: "parameters",
          panelReceipt: {
            tone: isNoChanges ? "info" : "error",
            heading: localizer(
              route.locale,
              isInvalid
                ? "commands.personal.config.invalid_parameters_heading"
                : isNoChanges
                  ? "commands.personal.config.no_changes_heading"
                  : "commands.personal.config.write_failed_heading",
            ),
            detail: localizer(
              route.locale,
              isInvalid
                ? "commands.personal.config.invalid_parameters_detail"
                : isNoChanges
                  ? "commands.personal.config.no_changes_detail"
                  : "commands.personal.config.write_failed_detail",
            ),
          },
          dependencies,
          selectedParametersProvider: route.provider,
        });
        return;
      }

      if (route.action === "fallbacks-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const slotValues = [
          takeRawModalSelectValue(modal.id, buildPersonalConfigModalFieldId("slot_1", route.nonce)) ?? "",
          takeRawModalSelectValue(modal.id, buildPersonalConfigModalFieldId("slot_2", route.nonce)) ?? "",
          takeRawModalSelectValue(modal.id, buildPersonalConfigModalFieldId("slot_3", route.nonce)) ?? "",
          takeRawModalSelectValue(modal.id, buildPersonalConfigModalFieldId("slot_4", route.nonce)) ?? "",
          takeRawModalSelectValue(modal.id, buildPersonalConfigModalFieldId("slot_5", route.nonce)) ?? "",
        ];

        const action = await performPanelAction(
          () =>
            dependencies.operations.setFallbacks({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              provider: route.provider,
              slotValues,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.fallbacks.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "models",
            page: "fallbacks",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.fallbacks_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.fallbacks_updated_detail", {
                provider: getProviderDisplayName(route.provider),
              }),
            },
            dependencies,
            selectedFallbacksProvider: route.provider,
          });
          return;
        }

        const isConflict = result.status === "primary-conflict";
        const isNoChanges = result.status === "no-changes";

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "models",
          page: "fallbacks",
          panelReceipt: {
            tone: isNoChanges ? "info" : "error",
            heading: localizer(
              route.locale,
              isConflict
                ? "commands.personal.config.fallback_primary_conflict_heading"
                : isNoChanges
                  ? "commands.personal.config.no_changes_heading"
                  : "commands.personal.config.write_failed_heading",
            ),
            detail: isConflict
              ? localizer(route.locale, "commands.personal.config.fallback_primary_conflict_detail", {
                  model:
                    result.primaryModelName ??
                    localizer(route.locale, "commands.personal.config.saved_assignment_none"),
                })
              : isNoChanges
                ? localizer(route.locale, "commands.personal.config.no_changes_detail")
                : localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
          selectedFallbacksProvider: route.provider,
        });
        return;
      }

      if (route.action === "randomizer-toggle") {
        const rows = await dependencies.loadUserSavedProviders(scope.userId);
        const config = rows.find((r) => r.provider.toLowerCase() === route.provider.toLowerCase());
        const currentEnabled = Boolean(config?.model_randomizer_enabled);

        const action = await performPanelAction(
          () =>
            dependencies.operations.setRandomizer({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              provider: route.provider,
              enabled: !currentEnabled,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;

        if (result.status === "no-changes") {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "models",
            page: "fallbacks",
            panelReceipt: noChangesReceipt(route.locale),
            dependencies,
            selectedFallbacksProvider: route.provider,
          });
          return;
        }

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.randomizer.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          const isEnabled = result.enabled;
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "models",
            page: "fallbacks",
            panelReceipt: {
              tone: "success",
              heading: localizer(
                route.locale,
                isEnabled
                  ? "commands.personal.config.randomizer_enabled_heading"
                  : "commands.personal.config.randomizer_disabled_heading",
              ),
              detail: localizer(
                route.locale,
                isEnabled
                  ? "commands.personal.config.randomizer_enabled_detail"
                  : "commands.personal.config.randomizer_disabled_detail",
                { provider: getProviderDisplayName(route.provider) },
              ),
            },
            dependencies,
            selectedFallbacksProvider: route.provider,
          });
          return;
        }

        const isRequiresFallback = result.status === "requires-fallbacks";

        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "models",
          page: "fallbacks",
          panelReceipt: {
            tone: "error",
            heading: localizer(
              route.locale,
              isRequiresFallback
                ? "commands.personal.config.randomizer_requires_fallback_heading"
                : "commands.personal.config.write_failed_heading",
            ),
            detail: isRequiresFallback
              ? localizer(route.locale, "commands.personal.config.randomizer_requires_fallback_detail")
              : localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
          selectedFallbacksProvider: route.provider,
        });
        return;
      }

      if (route.action === "trigger-mode-set") {
        if (scope.readStatus !== "fresh") {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "response-modes",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }
        const currentMode = scope.user.personal_dtm ?? "follow";
        if (currentMode === route.mode) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "response-modes",
            panelReceipt: noChangesReceipt(route.locale),
            dependencies,
          });
          return;
        }
        const action = await performPanelAction(
          () =>
            dependencies.operations.setTriggerMode({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              mode: route.mode,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;
        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.trigger-mode.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "response-modes",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.trigger_mode_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.trigger_mode_updated_detail", {
                mode: localizer(route.locale, `commands.personal.config.mode_${route.mode}`),
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
          page: "response-modes",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
        return;
      }

      if (route.action === "tool-mode-set") {
        if (scope.readStatus !== "fresh") {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "response-modes",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }
        const currentMode = scope.user.personal_deliberate_tool_mode ?? "follow";
        if (currentMode === route.mode) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "response-modes",
            panelReceipt: noChangesReceipt(route.locale),
            dependencies,
          });
          return;
        }
        const action = await performPanelAction(
          () =>
            dependencies.operations.setToolMode({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              mode: route.mode,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;
        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.tool-mode.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "response-modes",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.tool_mode_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.tool_mode_updated_detail", {
                mode: localizer(route.locale, `commands.personal.config.mode_${route.mode}`),
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
          page: "response-modes",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
        return;
      }

      if (route.action === "impersonation-submit") {
        if (!interaction.isModalSubmit()) throw new Error("impersonation-submit requires ModalSubmit interaction");
        const modal = interaction as ModalSubmitInteraction;
        if (scope.readStatus !== "fresh") {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "impersonation",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }
        const fieldId = buildPersonalConfigModalFieldId("prompt", route.nonce);
        const rawPrompt = modal.fields.getTextInputValue(fieldId).trim();
        if (!rawPrompt) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "impersonation",
            panelReceipt: {
              tone: "info",
              heading: localizer(route.locale, "commands.personal.config.impersonation_blank_refusal_heading"),
              detail: localizer(route.locale, "commands.personal.config.impersonation_blank_refusal_detail"),
            },
            dependencies,
          });
          return;
        }
        if (rawPrompt === scope.user.impersonation_prompt?.trim()) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "impersonation",
            panelReceipt: noChangesReceipt(route.locale),
            dependencies,
          });
          return;
        }
        const action = await performPanelAction(
          () =>
            dependencies.operations.setImpersonationPrompt({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              prompt: rawPrompt,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;
        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.impersonation.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "impersonation",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.impersonation_updated_heading"),
              detail: localizer(route.locale, "commands.personal.config.impersonation_updated_detail"),
            },
            dependencies,
          });
          return;
        }
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "impersonation",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
        return;
      }

      if (route.action === "impersonation-clear-view") {
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "impersonation",
          dependencies,
          view: {
            kind: "impersonation-clear-confirm",
            nonce: dependencies.createNonce(),
          },
        });
        return;
      }

      if (route.action === "impersonation-clear-cancel") {
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "impersonation",
          dependencies,
        });
        return;
      }

      if (route.action === "impersonation-clear-confirm") {
        if (scope.readStatus !== "fresh") {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "impersonation",
            panelReceipt: {
              tone: "error",
              heading: localizer(route.locale, "commands.personal.config.unavailable"),
              detail: localizer(route.locale, "commands.personal.config.stale_warning"),
            },
            dependencies,
          });
          return;
        }
        if (!scope.user.impersonation_prompt) {
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "impersonation",
            panelReceipt: noChangesReceipt(route.locale),
            dependencies,
          });
          return;
        }
        const action = await performPanelAction(
          () =>
            dependencies.operations.setImpersonationPrompt({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              prompt: null,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;
        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-config.personal.impersonation.set",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(interaction, {
            locale: route.locale,
            scope,
            category: "advanced",
            page: "impersonation",
            panelReceipt: {
              tone: "success",
              heading: localizer(route.locale, "commands.personal.config.impersonation_cleared_heading"),
              detail: localizer(route.locale, "commands.personal.config.impersonation_cleared_detail"),
            },
            dependencies,
          });
          return;
        }
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "advanced",
          page: "impersonation",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
            detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
          },
          dependencies,
        });
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
