import type { ModalSubmitInteraction, StringSelectMenuInteraction } from "discord.js";
import type { PersonalProviderCapability } from "@/types/db/schema";
import type { ThinkingLevelValue } from "@/constants/thinkingLevels";
import { performPanelAction } from "@/utils/discord/interactions/panelController";
import { loadFallbackSelectionOptions } from "@/utils/discord/interactions/personalConfigLoaders";
import {
  decodeProviderParam,
  encodeProviderPageValue,
  encodeProviderParam,
  PERSONAL_FALLBACK_PAGE_SIZE,
  PERSONAL_MODEL_PAGE_SIZE,
  PERSONAL_PROVIDER_DIRECT_LIMIT,
  PERSONAL_PROVIDER_PAGE_SIZE,
  QUICK_TOGGLE_CAPABILITIES,
  ROUTING_CAPABILITY_LOCALE_KEYS,
} from "@/utils/discord/personalConfigPanelCatalog";
import { buildPersonalConfigModalFieldId } from "@/utils/discord/ui/personalConfigModals";
import { buildProviderPageEntries } from "@/utils/discord/ui/modelRoutingControls";
import { takeRawModalCheckboxGroupValues, takeRawModalSelectValue } from "@/utils/discord/ui/modals";
import { log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";
import {
  getActivePersonalProviderForCapability,
  getStoredPersonalProviderForCapability,
  hasConfiguredPersonalModel,
} from "@/utils/provider/personalProviderHelpers";
import type { ModelParameterOptions } from "@/utils/discord/modelParametersConfigMapping";
import { getProviderDisplayName } from "@/utils/provider/providerInfoRegistry";
import {
  noChangesReceipt,
  repaint,
  type PersonalConfigPostDeferContext,
} from "@/utils/discord/interactions/personalConfigRouteContext";

function readOptionalParameterNumber(modal: ModalSubmitInteraction, fieldId: string): number | null | undefined {
  if (!modal.fields.fields.has(fieldId)) return undefined;
  const raw = modal.fields.getTextInputValue(fieldId).trim();
  return raw ? Number(raw) : null;
}

export async function handlePersonalConfigModelRoutes(context: PersonalConfigPostDeferContext): Promise<boolean> {
  const { interaction, route, dependencies } = context;

  if (route.action === "parameters-provider-select") {
    const selectMenu = interaction as StringSelectMenuInteraction;
    const chosenProvider = decodeProviderParam(selectMenu.values[0]);
    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "models",
      page: "parameters",
      dependencies,
      selectedParametersProvider: chosenProvider,
    });
    return true;
  }

  if (route.action === "quick-toggle-submit") {
    const modal = interaction as ModalSubmitInteraction;
    const fieldId = buildPersonalConfigModalFieldId("capabilities", route.nonce);
    const selectedCaps = (takeRawModalCheckboxGroupValues(modal.id, fieldId) ?? []) as PersonalProviderCapability[];
    const selectedCapSet = new Set<PersonalProviderCapability>(selectedCaps);

    const rows = await dependencies.loadUserSavedProviders(context.scope.userId);
    for (const cap of selectedCapSet) {
      const target = getStoredPersonalProviderForCapability(rows, cap);
      if (!target || !hasConfiguredPersonalModel(target, cap)) {
        const capLabel = localizer(route.locale, ROUTING_CAPABILITY_LOCALE_KEYS[cap]);
        await repaint(interaction, {
          locale: route.locale,
          scope: context.scope,
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
        return true;
      }
    }

    const hasChange = QUICK_TOGGLE_CAPABILITIES.some(
      (cap) => (getActivePersonalProviderForCapability(rows, cap) !== null) !== selectedCapSet.has(cap),
    );
    if (!hasChange) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "models",
        page: "switch",
        panelReceipt: {
          tone: "info",
          heading: localizer(route.locale, "commands.personal.config.no_changes_heading"),
          detail: localizer(route.locale, "commands.personal.config.no_changes_detail"),
        },
        dependencies,
      });
      return true;
    }

    const action = await performPanelAction(
      () =>
        dependencies.operations.setQuickToggleRouting({
          userId: context.scope.userId,
          userDiscId: context.scope.userDiscId,
          selectedCapabilities: selectedCapSet,
        }),
      () => dependencies.resolveScope(interaction, true),
    );
    const result = action.result;
    context.scope = action.state ?? context.scope;

    if (result.status === "no-changes") {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "models",
        page: "switch",
        panelReceipt: noChangesReceipt(route.locale),
        dependencies,
      });
      return true;
    }

    if (result.status === "success") {
      if (context.scope.internalServerId) {
        dependencies.recordAction({
          action: "personal-config.personal.model-routing.set",
          serverId: context.scope.internalServerId,
          userDiscId: interaction.user.id,
        });
      }
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "models",
        page: "switch",
        panelReceipt: {
          tone: "success",
          heading: localizer(route.locale, "commands.personal.config.routing_updated_heading"),
          detail: localizer(route.locale, "commands.personal.config.routing_updated_detail"),
        },
        dependencies,
      });
      return true;
    }

    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "models",
      page: "switch",
      panelReceipt: {
        tone: "error",
        heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
        detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
      },
      dependencies,
    });
    return true;
  }

  // Now only backs the model, provider, and fallback range choosers: the activation confirmation
  // it was named for is gone, so the receipt reports the state, not a cancelled activation.
  if (route.action === "model-act-cancel") {
    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "models",
      page: "switch",
      panelReceipt: noChangesReceipt(route.locale),
      dependencies,
    });
    return true;
  }

  if (route.action === "model-provider-select") {
    const action = await performPanelAction(
      () =>
        dependencies.operations.setCapabilityEnabled({
          userId: context.scope.userId,
          userDiscId: context.scope.userDiscId,
          capability: route.capability,
          enabled: false,
        }),
      () => dependencies.resolveScope(interaction, true),
    );
    const result = action.result;
    context.scope = action.state ?? context.scope;

    if (result.status === "no-changes") {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "models",
        page: "switch",
        panelReceipt: noChangesReceipt(route.locale),
        dependencies,
        selectedCapability: route.capability,
      });
      return true;
    }

    if (result.status === "success") {
      if (context.scope.internalServerId) {
        dependencies.recordAction({
          action: "personal-config.personal.model.set",
          serverId: context.scope.internalServerId,
          userDiscId: interaction.user.id,
        });
      }
      const capLabel = localizer(route.locale, ROUTING_CAPABILITY_LOCALE_KEYS[route.capability]);
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
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
      return true;
    }

    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
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
    return true;
  }

  if (route.action === "model-modal-submit") {
    const modal = interaction as ModalSubmitInteraction;
    const fieldId = buildPersonalConfigModalFieldId("model", route.nonce);
    const rawModelId = takeRawModalSelectValue(modal.id, fieldId);
    const modelId = Number(rawModelId);

    const availableModels = await dependencies.loadAvailableModelsForCapability(
      context.scope.userId,
      route.provider,
      route.capability,
    );
    const validModel = availableModels.find((m) => m.id === modelId);

    if (!validModel || modelId === 0) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
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
      return true;
    }

    const action = await performPanelAction(
      () =>
        dependencies.operations.setCapabilityModel({
          userId: context.scope.userId,
          userDiscId: context.scope.userDiscId,
          capability: route.capability,
          provider: route.provider,
          modelId,
        }),
      () => dependencies.resolveScope(interaction, true),
    );
    const result = action.result;
    context.scope = action.state ?? context.scope;

    if (result.status === "no-changes") {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "models",
        page: "switch",
        panelReceipt: noChangesReceipt(route.locale),
        dependencies,
        selectedCapability: route.capability,
      });
      return true;
    }

    if (result.status === "success") {
      if (context.scope.internalServerId) {
        dependencies.recordAction({
          action: "personal-config.personal.model.set",
          serverId: context.scope.internalServerId,
          userDiscId: interaction.user.id,
        });
      }
      const capLabel = localizer(route.locale, ROUTING_CAPABILITY_LOCALE_KEYS[route.capability]);
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
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
      return true;
    }

    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
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
    return true;
  }

  if (route.action === "model-range-page") {
    const availableModels = await dependencies.loadAvailableModelsForCapability(
      context.scope.userId,
      route.provider,
      route.capability,
    );

    const start = route.chooserPage * PERSONAL_MODEL_PAGE_SIZE;

    if (start % PERSONAL_MODEL_PAGE_SIZE !== 0 || (start >= availableModels.length && availableModels.length > 0)) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "models",
        page: "switch",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.unavailable"),
          detail: localizer(route.locale, "commands.personal.config.stale_warning"),
        },
        dependencies,
      });
      return true;
    }

    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "models",
      page: "switch",
      dependencies,
      selectedCapability: route.capability,
      selectedModelProvider: route.provider,
      modelTotalCount: availableModels.length,
    });
    return true;
  }

  if (route.action === "model-provider-page") {
    const rows = await dependencies.loadUserSavedProviders(context.scope.userId);
    const displayInfo = await dependencies.loadPersonalModelDisplayInfo(context.scope.userId, rows, route.capability);
    const providers = displayInfo.eligibleProvidersForCapability[route.capability];
    const availableModels = await dependencies.loadAvailableModelsForCapability(
      context.scope.userId,
      route.provider,
      route.capability,
    );
    // Counting through the renderer's own builder keeps the bound check on the list the reader is
    // actually paging: an expanded provider contributes a page per slice, not a single entry.
    const { entries } = buildProviderPageEntries({
      providers,
      expandedProvider: route.provider,
      expandedOptionCount: availableModels.length,
      pageSize: PERSONAL_MODEL_PAGE_SIZE,
      locale: route.locale,
      pageLabelKey: "commands.personal.config.provider_page_label",
      encodeProviderValue: encodeProviderParam,
      encodePageValue: encodeProviderPageValue,
    });

    if (route.start % PERSONAL_PROVIDER_DIRECT_LIMIT !== 0 || (route.start >= entries.length && entries.length > 0)) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "models",
        page: "switch",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.unavailable"),
          detail: localizer(route.locale, "commands.personal.config.stale_warning"),
        },
        dependencies,
      });
      return true;
    }

    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "models",
      page: "switch",
      dependencies,
      selectedCapability: route.capability,
      selectedModelProvider: route.provider,
      modelTotalCount: availableModels.length,
      providerStart: route.start,
    });
    return true;
  }

  if (route.action === "model-provider-range-open" || route.action === "model-provider-range-page") {
    const rows = await dependencies.loadUserSavedProviders(context.scope.userId);
    const displayInfo = await dependencies.loadPersonalModelDisplayInfo(context.scope.userId, rows, route.capability);
    const providers = displayInfo.eligibleProvidersForCapability[route.capability];

    const start =
      route.action === "model-provider-range-open" ? route.start : route.chooserPage * PERSONAL_PROVIDER_PAGE_SIZE;

    const isValidStart = start % PERSONAL_PROVIDER_DIRECT_LIMIT === 0 || start % PERSONAL_PROVIDER_PAGE_SIZE === 0;

    if (!isValidStart || (start >= providers.length && providers.length > 0)) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "models",
        page: "switch",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.unavailable"),
          detail: localizer(route.locale, "commands.personal.config.stale_warning"),
        },
        dependencies,
      });
      return true;
    }

    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "models",
      page: "switch",
      dependencies,
      selectedCapability: route.capability,
      providerStart: start,
    });
    return true;
  }

  if (route.action === "fallbacks-page") {
    let availableOptions: Array<{ refKey: string; label: string }> = [];
    try {
      availableOptions = await loadFallbackSelectionOptions(context.scope.userId, route.provider);
    } catch (error) {
      log.warn("Failed to load available models for fallbacks modal", { provider: route.provider, error });
    }

    const rows = await dependencies.loadUserSavedProviders(context.scope.userId);
    const displayInfo = await dependencies.loadPersonalModelDisplayInfo(context.scope.userId, rows, "text");
    const { entries } = buildProviderPageEntries({
      providers: displayInfo.fallbacksProviders,
      expandedProvider: route.provider,
      expandedOptionCount: availableOptions.length,
      pageSize: PERSONAL_FALLBACK_PAGE_SIZE,
      locale: route.locale,
      pageLabelKey: "commands.personal.config.provider_page_label",
      encodeProviderValue: encodeProviderParam,
      encodePageValue: encodeProviderPageValue,
    });

    if (route.start % PERSONAL_PROVIDER_DIRECT_LIMIT !== 0 || (route.start >= entries.length && entries.length > 0)) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "models",
        page: "fallbacks",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.unavailable"),
          detail: localizer(route.locale, "commands.personal.config.stale_warning"),
        },
        dependencies,
      });
      return true;
    }

    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "models",
      page: "fallbacks",
      dependencies,
      selectedFallbacksProvider: route.provider,
      fallbackOptionCount: availableOptions.length,
      fallbackEntryStart: route.start,
    });
    return true;
  }

  if (route.action === "fallbacks-range-page") {
    let availableOptions: Array<{ refKey: string; label: string }> = [];
    try {
      availableOptions = await loadFallbackSelectionOptions(context.scope.userId, route.provider);
    } catch (error) {
      log.warn("Failed to load available models for fallbacks modal", { provider: route.provider, error });
    }

    const start = route.chooserPage * PERSONAL_FALLBACK_PAGE_SIZE;

    const isValidStart = start % PERSONAL_FALLBACK_PAGE_SIZE === 0 || start % PERSONAL_PROVIDER_PAGE_SIZE === 0;

    if (!isValidStart || (start >= availableOptions.length && availableOptions.length > 0)) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "models",
        page: "fallbacks",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.unavailable"),
          detail: localizer(route.locale, "commands.personal.config.stale_warning"),
        },
        dependencies,
      });
      return true;
    }

    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "models",
      page: "fallbacks",
      dependencies,
      selectedFallbacksProvider: route.provider,
      fallbackOptionCount: availableOptions.length,
    });
    return true;
  }

  if (route.action === "parameters-1-submit") {
    const modal = interaction as ModalSubmitInteraction;
    const patch: Partial<ModelParameterOptions> = {};
    const temperature = readOptionalParameterNumber(modal, buildPersonalConfigModalFieldId("temperature", route.nonce));
    const minP = readOptionalParameterNumber(modal, buildPersonalConfigModalFieldId("min_p", route.nonce));
    const topP = readOptionalParameterNumber(modal, buildPersonalConfigModalFieldId("top_p", route.nonce));
    const topK = readOptionalParameterNumber(modal, buildPersonalConfigModalFieldId("top_k", route.nonce));
    const frequency = readOptionalParameterNumber(
      modal,
      buildPersonalConfigModalFieldId("frequency_penalty", route.nonce),
    );
    if (temperature !== undefined) patch.temperature = temperature;
    if (minP !== undefined) patch.min_p = minP;
    if (topP !== undefined) patch.top_p = topP;
    if (topK !== undefined) patch.top_k = topK;
    if (frequency !== undefined) patch.frequency_penalty = frequency;

    const action = await performPanelAction(
      () =>
        dependencies.operations.setParameters({
          userId: context.scope.userId,
          userDiscId: context.scope.userDiscId,
          provider: route.provider,
          patch,
        }),
      () => dependencies.resolveScope(interaction, true),
    );
    const result = action.result;
    context.scope = action.state ?? context.scope;

    if (result.status === "success") {
      if (context.scope.internalServerId) {
        dependencies.recordAction({
          action: "personal-config.personal.parameters.set",
          serverId: context.scope.internalServerId,
          userDiscId: interaction.user.id,
        });
      }
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
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
      return true;
    }

    const isInvalid = result.status === "invalid-value";
    const isNoChanges = result.status === "no-changes";

    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
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
    return true;
  }

  if (route.action === "parameters-2-submit") {
    const modal = interaction as ModalSubmitInteraction;
    const frequency = readOptionalParameterNumber(
      modal,
      buildPersonalConfigModalFieldId("frequency_penalty", route.nonce),
    );
    const presence = readOptionalParameterNumber(
      modal,
      buildPersonalConfigModalFieldId("presence_penalty", route.nonce),
    );
    const maxOutput = readOptionalParameterNumber(
      modal,
      buildPersonalConfigModalFieldId("max_output_tokens", route.nonce),
    );
    const thinkRaw = takeRawModalSelectValue(modal.id, buildPersonalConfigModalFieldId("thinking_level", route.nonce));

    const patch: Partial<ModelParameterOptions> = {
      thinking_level: (thinkRaw as ThinkingLevelValue) ?? null,
    };
    if (frequency !== undefined) patch.frequency_penalty = frequency;
    if (presence !== undefined) patch.presence_penalty = presence;
    if (maxOutput !== undefined) patch.max_output_tokens = maxOutput;

    const action = await performPanelAction(
      () =>
        dependencies.operations.setParameters({
          userId: context.scope.userId,
          userDiscId: context.scope.userDiscId,
          provider: route.provider,
          patch,
        }),
      () => dependencies.resolveScope(interaction, true),
    );
    const result = action.result;
    context.scope = action.state ?? context.scope;

    if (result.status === "success") {
      if (context.scope.internalServerId) {
        dependencies.recordAction({
          action: "personal-config.personal.parameters.set",
          serverId: context.scope.internalServerId,
          userDiscId: interaction.user.id,
        });
      }
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
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
      return true;
    }

    const isInvalid = result.status === "invalid-value";
    const isNoChanges = result.status === "no-changes";

    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
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
    return true;
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
          userId: context.scope.userId,
          userDiscId: context.scope.userDiscId,
          provider: route.provider,
          slotValues,
        }),
      () => dependencies.resolveScope(interaction, true),
    );
    const result = action.result;
    context.scope = action.state ?? context.scope;

    if (result.status === "success") {
      if (context.scope.internalServerId) {
        dependencies.recordAction({
          action: "personal-config.personal.fallbacks.set",
          serverId: context.scope.internalServerId,
          userDiscId: interaction.user.id,
        });
      }
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
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
      return true;
    }

    const isConflict = result.status === "primary-conflict";
    const isNoChanges = result.status === "no-changes";

    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
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
                result.primaryModelName ?? localizer(route.locale, "commands.personal.config.saved_assignment_none"),
            })
          : isNoChanges
            ? localizer(route.locale, "commands.personal.config.no_changes_detail")
            : localizer(route.locale, "commands.personal.config.write_failed_detail"),
      },
      dependencies,
      selectedFallbacksProvider: route.provider,
    });
    return true;
  }

  return false;
}
