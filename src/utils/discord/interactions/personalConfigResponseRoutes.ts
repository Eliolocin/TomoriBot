import type { ModalSubmitInteraction } from "discord.js";
import { performPanelAction } from "@/utils/discord/interactions/panelController";
import { buildPersonalConfigModalFieldId } from "@/utils/discord/ui/personalConfigModals";
import { getProviderDisplayName } from "@/utils/provider/providerInfoRegistry";
import { localizer } from "@/utils/text/localizer";
import {
  noChangesReceipt,
  repaint,
  type PersonalConfigPostDeferContext,
} from "@/utils/discord/interactions/personalConfigRouteContext";

export async function handlePersonalConfigResponseRoutes(context: PersonalConfigPostDeferContext): Promise<boolean> {
  const { interaction, route, dependencies } = context;

  if (route.action === "randomizer-toggle") {
    const rows = await dependencies.loadUserSavedProviders(context.scope.userId);
    const config = rows.find((r) => r.provider.toLowerCase() === route.provider.toLowerCase());
    const currentEnabled = Boolean(config?.model_randomizer_enabled);

    const action = await performPanelAction(
      () =>
        dependencies.operations.setRandomizer({
          userId: context.scope.userId,
          userDiscId: context.scope.userDiscId,
          provider: route.provider,
          enabled: !currentEnabled,
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
        page: "fallbacks",
        panelReceipt: noChangesReceipt(route.locale),
        dependencies,
        selectedFallbacksProvider: route.provider,
      });
      return true;
    }

    if (result.status === "success") {
      if (context.scope.internalServerId) {
        dependencies.recordAction({
          action: "personal-config.personal.randomizer.set",
          serverId: context.scope.internalServerId,
          userDiscId: interaction.user.id,
        });
      }
      const isEnabled = result.enabled;
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
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
      return true;
    }

    const isRequiresFallback = result.status === "requires-fallbacks";

    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
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
    return true;
  }

  if (route.action === "trigger-mode-set") {
    if (context.scope.readStatus !== "fresh") {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "response-modes",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.unavailable"),
          detail: localizer(route.locale, "commands.personal.config.stale_warning"),
        },
        dependencies,
      });
      return true;
    }
    const currentMode = context.scope.user.personal_dtm ?? "follow";
    if (currentMode === route.mode) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "response-modes",
        panelReceipt: noChangesReceipt(route.locale),
        dependencies,
      });
      return true;
    }
    const action = await performPanelAction(
      () =>
        dependencies.operations.setTriggerMode({
          userId: context.scope.userId,
          userDiscId: context.scope.userDiscId,
          mode: route.mode,
        }),
      () => dependencies.resolveScope(interaction, true),
    );
    const result = action.result;
    context.scope = action.state ?? context.scope;
    if (result.status === "success") {
      if (context.scope.internalServerId) {
        dependencies.recordAction({
          action: "personal-config.personal.trigger-mode.set",
          serverId: context.scope.internalServerId,
          userDiscId: interaction.user.id,
        });
      }
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
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
      return true;
    }
    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "advanced",
      page: "response-modes",
      panelReceipt: {
        tone: "error",
        heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
        detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
      },
      dependencies,
    });
    return true;
  }

  if (route.action === "tool-mode-set") {
    if (context.scope.readStatus !== "fresh") {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "response-modes",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.unavailable"),
          detail: localizer(route.locale, "commands.personal.config.stale_warning"),
        },
        dependencies,
      });
      return true;
    }
    const currentMode = context.scope.user.personal_deliberate_tool_mode ?? "follow";
    if (currentMode === route.mode) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "response-modes",
        panelReceipt: noChangesReceipt(route.locale),
        dependencies,
      });
      return true;
    }
    const action = await performPanelAction(
      () =>
        dependencies.operations.setToolMode({
          userId: context.scope.userId,
          userDiscId: context.scope.userDiscId,
          mode: route.mode,
        }),
      () => dependencies.resolveScope(interaction, true),
    );
    const result = action.result;
    context.scope = action.state ?? context.scope;
    if (result.status === "success") {
      if (context.scope.internalServerId) {
        dependencies.recordAction({
          action: "personal-config.personal.tool-mode.set",
          serverId: context.scope.internalServerId,
          userDiscId: interaction.user.id,
        });
      }
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
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
      return true;
    }
    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "advanced",
      page: "response-modes",
      panelReceipt: {
        tone: "error",
        heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
        detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
      },
      dependencies,
    });
    return true;
  }

  if (route.action === "impersonation-submit") {
    if (!interaction.isModalSubmit()) throw new Error("impersonation-submit requires ModalSubmit interaction");
    const modal = interaction as ModalSubmitInteraction;
    if (context.scope.readStatus !== "fresh") {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "impersonation",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.unavailable"),
          detail: localizer(route.locale, "commands.personal.config.stale_warning"),
        },
        dependencies,
      });
      return true;
    }
    const fieldId = buildPersonalConfigModalFieldId("prompt", route.nonce);
    const rawPrompt = modal.fields.getTextInputValue(fieldId).trim();
    if (!rawPrompt) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "impersonation",
        panelReceipt: {
          tone: "info",
          heading: localizer(route.locale, "commands.personal.config.impersonation_blank_refusal_heading"),
          detail: localizer(route.locale, "commands.personal.config.impersonation_blank_refusal_detail"),
        },
        dependencies,
      });
      return true;
    }
    if (rawPrompt === context.scope.user.impersonation_prompt?.trim()) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "impersonation",
        panelReceipt: noChangesReceipt(route.locale),
        dependencies,
      });
      return true;
    }
    const action = await performPanelAction(
      () =>
        dependencies.operations.setImpersonationPrompt({
          userId: context.scope.userId,
          userDiscId: context.scope.userDiscId,
          prompt: rawPrompt,
        }),
      () => dependencies.resolveScope(interaction, true),
    );
    const result = action.result;
    context.scope = action.state ?? context.scope;
    if (result.status === "success") {
      if (context.scope.internalServerId) {
        dependencies.recordAction({
          action: "personal-config.personal.impersonation.set",
          serverId: context.scope.internalServerId,
          userDiscId: interaction.user.id,
        });
      }
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "impersonation",
        panelReceipt: {
          tone: "success",
          heading: localizer(route.locale, "commands.personal.config.impersonation_updated_heading"),
          detail: localizer(route.locale, "commands.personal.config.impersonation_updated_detail"),
        },
        dependencies,
      });
      return true;
    }
    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "advanced",
      page: "impersonation",
      panelReceipt: {
        tone: "error",
        heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
        detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
      },
      dependencies,
    });
    return true;
  }

  if (route.action === "impersonation-clear-view") {
    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "advanced",
      page: "impersonation",
      dependencies,
      view: {
        kind: "impersonation-clear-confirm",
        nonce: dependencies.createNonce(),
      },
    });
    return true;
  }

  if (route.action === "impersonation-clear-cancel") {
    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "advanced",
      page: "impersonation",
      dependencies,
    });
    return true;
  }

  if (route.action === "impersonation-clear-confirm") {
    if (context.scope.readStatus !== "fresh") {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "impersonation",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.unavailable"),
          detail: localizer(route.locale, "commands.personal.config.stale_warning"),
        },
        dependencies,
      });
      return true;
    }
    if (!context.scope.user.impersonation_prompt) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "impersonation",
        panelReceipt: noChangesReceipt(route.locale),
        dependencies,
      });
      return true;
    }
    const action = await performPanelAction(
      () =>
        dependencies.operations.setImpersonationPrompt({
          userId: context.scope.userId,
          userDiscId: context.scope.userDiscId,
          prompt: null,
        }),
      () => dependencies.resolveScope(interaction, true),
    );
    const result = action.result;
    context.scope = action.state ?? context.scope;
    if (result.status === "success") {
      if (context.scope.internalServerId) {
        dependencies.recordAction({
          action: "personal-config.personal.impersonation.set",
          serverId: context.scope.internalServerId,
          userDiscId: interaction.user.id,
        });
      }
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "impersonation",
        panelReceipt: {
          tone: "success",
          heading: localizer(route.locale, "commands.personal.config.impersonation_cleared_heading"),
          detail: localizer(route.locale, "commands.personal.config.impersonation_cleared_detail"),
        },
        dependencies,
      });
      return true;
    }
    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "advanced",
      page: "impersonation",
      panelReceipt: {
        tone: "error",
        heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
        detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
      },
      dependencies,
    });
    return true;
  }

  return false;
}
