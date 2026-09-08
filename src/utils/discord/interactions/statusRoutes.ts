import type { Client, InteractionEditReplyOptions, StringSelectMenuInteraction } from "discord.js";
import type { TomoriState, UserRow } from "@/types/db/schema";
import { getCachedTomoriState } from "@/utils/cache/tomoriStateCache";
import { personaRepository, userRepository } from "@/utils/db/repositories";
import type { GlobalInteractionRoute, GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import {
  parseStatusDashboardRoute,
  parseStatusPageSelection,
  parseStatusPersonaRange,
  parseStatusPersonaSelection,
  STATUS_ROUTE_NAMESPACE,
  STATUS_ROUTE_VERSION,
} from "@/utils/discord/statusDashboardCatalog";
import {
  buildDashboardPagePayload,
  dashboardPayload,
  type StatusPageCategory,
} from "@/utils/metrics/status/statusPageRenderer";
import { buildPersonalStatusPages } from "@/utils/metrics/status/personalPages";
import { buildPersonaStatusPages } from "@/utils/metrics/status/personaPages";
import { buildServerChannelPages } from "@/utils/metrics/status/serverChannelPages";
import { buildServerConfigPages } from "@/utils/metrics/status/serverConfigPages";
import { buildServerModelPages } from "@/utils/metrics/status/serverModelPages";
import {
  resolveStatusDashboardCategories,
  type StatusDashboardBuildDependencies,
} from "@/utils/metrics/status/statusDashboard";
import { localizer } from "@/utils/text/localizer";

export interface StatusRouteDependencies extends StatusDashboardBuildDependencies {
  loadUserByDiscordId(userDiscId: string): Promise<UserRow | null>;
  getCachedTomoriState(serverDiscId: string): Promise<TomoriState | null>;
  resolveCategories(
    client: Client,
    interaction: GlobalRoutableInteraction,
    userData: UserRow,
    serverDiscId: string,
    tomoriState: TomoriState,
    locale: string,
  ): Promise<StatusPageCategory[]>;
  loadPersonasForServer(serverDiscId: string): Promise<TomoriState[]>;
  buildPersonaStatusPages(
    selectedPersona: TomoriState,
    userData: UserRow,
    locale: string,
  ): Promise<StatusPageCategory["pages"]>;
}

const defaultDependencies: Omit<StatusRouteDependencies, "resolveCategories"> = {
  loadUserByDiscordId: (userDiscId) => userRepository.loadByDiscordId(userDiscId),
  getCachedTomoriState,
  buildServerChannelPages,
  buildServerConfigPages,
  buildServerModelPages,
  buildPersonalStatusPages,
  loadPersonasForServer: (serverDiscId) => personaRepository.loadAllForServer(serverDiscId),
  buildPersonaStatusPages,
};

function invalidStatusPayload(locale: string): InteractionEditReplyOptions {
  return buildDashboardPagePayload({
    locale,
    page: {
      titleKey: "general.errors.invalid_option_title",
      description: localizer(locale, "general.errors.invalid_option_description"),
      fields: [],
    },
  });
}

function unavailableStatusPayload(locale: string): InteractionEditReplyOptions {
  return buildDashboardPagePayload({
    locale,
    page: {
      titleKey: "general.errors.tomori_not_setup_title",
      description: localizer(locale, "general.errors.tomori_not_setup_description"),
      fields: [],
    },
  });
}

export function createStatusInteractionRoute(overrides: Partial<StatusRouteDependencies> = {}): GlobalInteractionRoute {
  const dependencies: StatusRouteDependencies = { ...defaultDependencies, ...overrides } as StatusRouteDependencies;
  if (!overrides.resolveCategories) {
    dependencies.resolveCategories = (client, interaction, userData, serverDiscId, tomoriState, locale) =>
      resolveStatusDashboardCategories(client, interaction, userData, serverDiscId, tomoriState, locale, dependencies);
  }

  return {
    namespace: STATUS_ROUTE_NAMESPACE,
    version: STATUS_ROUTE_VERSION,
    async execute(client, interaction, parsed): Promise<void> {
      const route = parseStatusDashboardRoute(parsed);
      if (!route) throw new Error(`Malformed status dashboard route: ${interaction.customId}`);

      if ((route.action === "category" || route.action === "persona-page") && !interaction.isButton()) {
        throw new Error("Status category route requires a button interaction");
      }
      if ((route.action === "page" || route.action === "persona-select") && !interaction.isStringSelectMenu()) {
        throw new Error("Status page route requires a String Select interaction");
      }

      await interaction.deferUpdate();

      const isCategoryRoute = route.action === "category" || route.action === "page";

      const pageValues =
        route.action === "page" || route.action === "persona-select"
          ? (interaction as StringSelectMenuInteraction).values
          : [];
      if ((route.action === "page" || route.action === "persona-select") && pageValues.length !== 1) {
        await interaction.editReply(invalidStatusPayload(route.locale));
        return;
      }

      const selectedPage = route.action === "page" ? parseStatusPageSelection(pageValues[0]) : 0;
      if (route.action === "page" && selectedPage === null) {
        await interaction.editReply(invalidStatusPayload(route.locale));
        return;
      }

      const requestedPersonaId =
        route.action === "persona-select"
          ? parseStatusPersonaSelection(pageValues[0])
          : "personaId" in route
            ? route.personaId
            : undefined;
      if (route.action === "persona-select" && requestedPersonaId === null) {
        await interaction.editReply(invalidStatusPayload(route.locale));
        return;
      }

      const personaRangeStart =
        route.action === "persona-page" ? parseStatusPersonaRange(String(route.start)) : undefined;
      if (route.action === "persona-page" && personaRangeStart === null) {
        await interaction.editReply(invalidStatusPayload(route.locale));
        return;
      }

      const activeCategory = isCategoryRoute ? route.category : "persona";

      const userData = await dependencies.loadUserByDiscordId(interaction.user.id);
      if (!userData) {
        await interaction.editReply(unavailableStatusPayload(route.locale));
        return;
      }

      const serverDiscId = interaction.guildId ?? interaction.user.id;
      const tomoriState = await dependencies.getCachedTomoriState(serverDiscId);
      if (!tomoriState) {
        await interaction.editReply(unavailableStatusPayload(route.locale));
        return;
      }

      const needsPersonaRoster =
        route.action === "persona-select" ||
        route.action === "persona-page" ||
        (isCategoryRoute && (route.category === "persona" || route.personaId !== undefined));
      let personas: TomoriState[] = [];
      if (needsPersonaRoster) {
        personas = await dependencies.loadPersonasForServer(serverDiscId);
      }

      let selectedPersona: TomoriState | undefined;
      if (needsPersonaRoster) {
        const validPersonas = personas.filter(
          (persona): persona is TomoriState & { persona_id: number } =>
            typeof persona.persona_id === "number" &&
            Number.isSafeInteger(persona.persona_id) &&
            persona.persona_id > 0,
        );
        if (validPersonas.length === 0) {
          await interaction.editReply(unavailableStatusPayload(route.locale));
          return;
        }
        selectedPersona =
          validPersonas.find((persona) => persona.persona_id === requestedPersonaId) ?? validPersonas[0];
      }

      const categories = await dependencies.resolveCategories(
        client,
        interaction,
        userData,
        serverDiscId,
        tomoriState,
        route.locale,
      );

      if (selectedPersona && activeCategory === "persona") {
        const personaPages = await dependencies.buildPersonaStatusPages(selectedPersona, userData, route.locale);
        const personaCategory = categories.find((candidate) => candidate.id === "persona");
        if (personaCategory) personaCategory.pages = personaPages;
      }

      const category = categories.find((candidate) => candidate.id === activeCategory);
      const activePage = route.action === "persona-page" ? 0 : selectedPage;
      if (!category || category.pages.length === 0 || activePage === null || activePage >= category.pages.length) {
        await interaction.editReply(invalidStatusPayload(route.locale));
        return;
      }

      await interaction.editReply(
        dashboardPayload("status-dashboard", route.locale, categories, category.id, activePage, false, {
          selectedPersonaId: selectedPersona?.persona_id,
          personas: category.id === "persona" ? personas : undefined,
          personaSelectStart: personaRangeStart ?? undefined,
        }),
      );
    },
  };
}

export const statusInteractionRoute = createStatusInteractionRoute();
