import type { StringSelectMenuInteraction } from "discord.js";
import type { PersonalConfigPage } from "@/utils/discord/personalConfigPanelCatalog";
import { repaint, type PersonalConfigPostDeferContext } from "@/utils/discord/interactions/personalConfigRouteContext";

export async function handlePersonalConfigNavigation(context: PersonalConfigPostDeferContext): Promise<boolean> {
  const { interaction, route, dependencies } = context;
  const scope = context.scope;

  if (route.action === "category") {
    await repaint(interaction, {
      locale: route.locale,
      scope,
      category: route.category,
      page: route.page,
      selectedLineageId:
        route.category === "profile" && route.page === "persona" ? scope.personas[0]?.persona_lineage_id : undefined,
      dependencies,
    });
    return true;
  }

  if (route.action === "page") {
    const selectMenu = interaction as StringSelectMenuInteraction;
    const selectedPage = (selectMenu.values[0] as PersonalConfigPage) ?? route.page;
    await repaint(interaction, {
      locale: route.locale,
      scope,
      category: route.category,
      page: selectedPage,
      selectedLineageId:
        route.category === "profile" && selectedPage === "persona" ? scope.personas[0]?.persona_lineage_id : undefined,
      dependencies,
    });
    return true;
  }

  if (route.action === "persona-select") {
    const selectMenu = interaction as StringSelectMenuInteraction;
    const selectedLineage = Number(selectMenu.values[0]);
    const validLineage = scope.personas.some((p) => p.persona_lineage_id === selectedLineage)
      ? selectedLineage
      : (scope.personas[0]?.persona_lineage_id ?? 0);
    await repaint(interaction, {
      locale: route.locale,
      scope,
      category: "profile",
      page: "persona",
      selectedLineageId: validLineage,
      dependencies,
    });
    return true;
  }

  if (route.action === "retry" || route.action === "refresh") {
    await repaint(interaction, {
      locale: route.locale,
      scope,
      category: route.category,
      page: route.page,
      selectedLineageId: route.lineageId,
      dependencies,
    });
    return true;
  }

  return false;
}
