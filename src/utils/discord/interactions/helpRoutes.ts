import type { GlobalInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import { isHelpProviderId } from "@/utils/discord/helpProviderGuides";
import {
  HELP_ROUTE_NAMESPACE,
  HELP_ROUTE_VERSION,
  buildHelpDashboardPayload,
  buildProviderGuideModal,
  resolveHelpSelection,
} from "@/utils/discord/ui/helpDashboard";
import { getSupportedLocales } from "@/utils/text/localizer";
import { deliverGuardedPanel } from "@/utils/discord/interactions/panelController";

function resolveLocale(locale?: string | null, guildLocale?: string | null): string {
  return locale ?? guildLocale ?? "en-US";
}

export const helpInteractionRoute: GlobalInteractionRoute = {
  namespace: HELP_ROUTE_NAMESPACE,
  version: HELP_ROUTE_VERSION,
  async execute(_client, interaction, route): Promise<void> {
    const [action, routeLocale, firstValue, secondValue, thirdValue] = route.segments;
    const locale =
      routeLocale && getSupportedLocales().includes(routeLocale)
        ? routeLocale
        : resolveLocale(interaction.locale, interaction.guildLocale);

    if (action === "category" && firstValue && interaction.isButton()) {
      const selection = resolveHelpSelection(firstValue);
      if (selection.category.id !== firstValue) {
        throw new Error(`Invalid help category: ${firstValue}`);
      }
      await deliverGuardedPanel(
        interaction,
        buildHelpDashboardPayload(locale, selection.category.id, selection.page.id),
        { method: "update", locale },
      );
      return;
    }

    if (action === "navigate" && firstValue && secondValue && interaction.isButton()) {
      const selection = resolveHelpSelection(firstValue, secondValue, thirdValue);
      if (
        selection.category.id !== firstValue ||
        selection.page.id !== secondValue ||
        (thirdValue && !selection.variant)
      ) {
        const routeTarget = thirdValue ? `${firstValue}:${secondValue}:${thirdValue}` : `${firstValue}:${secondValue}`;
        throw new Error(`Invalid help navigation target: ${routeTarget}`);
      }
      await deliverGuardedPanel(
        interaction,
        buildHelpDashboardPayload(locale, selection.category.id, selection.page.id, selection.variant?.id),
        { method: "update", locale },
      );
      return;
    }

    if (action === "page" && firstValue && interaction.isStringSelectMenu()) {
      const selection = resolveHelpSelection(firstValue, interaction.values[0]);
      if (selection.category.id !== firstValue || selection.page.id !== interaction.values[0]) {
        throw new Error(`Invalid help page selection: ${firstValue}:${interaction.values[0] ?? "missing"}`);
      }
      await deliverGuardedPanel(
        interaction,
        buildHelpDashboardPayload(locale, selection.category.id, selection.page.id),
        { method: "update", locale },
      );
      return;
    }

    if (action === "variant" && firstValue && secondValue && interaction.isStringSelectMenu()) {
      const selection = resolveHelpSelection(firstValue, secondValue, interaction.values[0]);
      if (!selection.variant) {
        throw new Error(`Invalid help guide selection: ${interaction.values[0] ?? "missing"}`);
      }
      await deliverGuardedPanel(
        interaction,
        buildHelpDashboardPayload(locale, selection.category.id, selection.page.id, selection.variant.id),
        { method: "update", locale },
      );
      return;
    }

    if (action === "provider" && interaction.isStringSelectMenu()) {
      const providerId = interaction.values[0];
      if (!providerId || !isHelpProviderId(providerId)) {
        throw new Error(`Invalid help provider selection: ${providerId ?? "missing"}`);
      }
      await interaction.showModal(buildProviderGuideModal(locale, providerId));
      return;
    }

    if (action === "provider-modal" && firstValue && interaction.isModalSubmit()) {
      if (!isHelpProviderId(firstValue)) {
        throw new Error(`Invalid help provider modal: ${firstValue}`);
      }
      await interaction.deferUpdate();
      return;
    }

    throw new Error(`Unsupported help interaction route: ${route.segments.join(":")}`);
  },
};
